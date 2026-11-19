/**
 * The Codex CLI research worker process (C1b; follow-ups, revive and steer C2). It speaks the pi RPC lines dispatch
 * reads (`get_state`, `prompt`, `follow_up`, `steer`, then events). Each turn is one `runCodexSpike` with every C1a gate
 * on: the first starts the thread, every later one resumes it. A clean or reported turn settles idle; a stop exits 1.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { configureLayout, type Delivery, paths, type Usage } from "../contracts.ts";
import {
	assertNativeResume, claimFollowUps, enqueueFollowUp, NATIVE_CODEX_SCRATCH_PREFIX, NATIVE_CODEX_SESSION_FILE, type NativeSession, nativeSessionMoved,
	readNativeSession, removeNativeScratch, returnClaim, settleClaim, writeNativeSession,
} from "./claude-followup.ts";
import { startIdlePrompt } from "./claude-lifecycle.ts";
import { nativeTranscriptFile } from "./claude-transcript.ts";
import { nativeDenials } from "./claude-usage.ts";
import { codexDoorRefusal, codexPersistRefusal } from "./codex.ts";
import type { ItemNotification, TokenUsageUpdatedNotification } from "./codex-protocol.ts";
import { type CodexRunControl, type CodexRunUsage, type CodexSpikeResult, type CodexTokenTotals, type CodexToolEvent, runCodexSpike, ZERO_TOTALS } from "./codex-spike.ts";
import { type CodexTranscript, codexTranscript } from "./codex-transcript.ts";

const RUN_TIMEOUT_MS = 24 * 60 * 60_000;
const env = process.env;
if (env.CP_HOME) configureLayout("multi", env.CP_HOME);
const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const say = (line: string): void => void process.stderr.write(`[codex cli] ${line}\n`);
const jobId = env.CP_JOB_ID ?? "this job";
const runDir = env.CP_RUN_DIR ?? "";
const sessionFile = join(runDir, NATIVE_CODEX_SESSION_FILE);
let abort = new AbortController();
let run: Promise<number> | undefined;
let busy = false;
// Set by the first stop: no queued follow-up starts a new turn after it.
let stopping = false;
// A revived worker (CP_NATIVE_RESUME=1) resumes from its first prompt; a dispatched one after its first turn.
let resuming = env.CP_NATIVE_RESUME === "1";
// A report was accepted in this busy period: a refused steer is then never queued behind the filed report.
let reportedNow = false;
const control: CodexRunControl = {};
let transcript: CodexTranscript | undefined;

/** Condition 2 (C2): the record's `totals` is a new-shape value, written only while codex_research is on. */
const persistTotals = (): boolean => codexPersistRefusal(env.CP_HOME ?? "", "the Codex session record") === undefined;

/** A new record and scratch dir; a previous record's picp-made scratch dir is removed first, never orphaned. */
function freshSession(cwd: string): NativeSession {
	if (existsSync(sessionFile)) removeNativeScratch(sessionFile);
	const session: NativeSession = {
		driver: "codex", scratch_dir: mkdtempSync(join(tmpdir(), NATIVE_CODEX_SCRATCH_PREFIX)), cwd,
		...(env.CP_CODEX_HOME ? { codex_home: env.CP_CODEX_HOME } : {}), ...(persistTotals() ? { totals: { ...ZERO_TOTALS } } : {}),
	};
	writeNativeSession(sessionFile, session);
	return session;
}

/** The recorded thread to resume; a record with no thread or from another worktree is refused by name (Q3). */
function resumedSession(worktree: string): NativeSession & { thread_id: string } {
	const session = readNativeSession(sessionFile);
	if (session.thread_id === undefined) throw new Error(`${sessionFile} holds no thread id; there is nothing to resume`);
	if (nativeSessionMoved(session, worktree)) {
		throw new Error(`the Codex thread started in ${session.cwd} and the worktree is now ${worktree}; its resume is refused: cp_teardown and dispatch again`);
	}
	return session as NativeSession & { thread_id: string };
}

/** The role contract the dispatch wrote; a missing or empty file stops the run, never a run without it. */
function readSystemPrompt(): string {
	const file = env.CP_CODEX_SYSTEM_PROMPT_FILE;
	if (!file || !existsSync(file)) throw new Error(`Codex CLI worker cannot read its system prompt (${file ?? "CP_CODEX_SYSTEM_PROMPT_FILE unset"})`);
	const body = readFileSync(file, "utf8");
	if (body.trim() === "") throw new Error(`Codex CLI worker's system prompt ${file} is empty`);
	return body;
}

/** pi's usage shape at cost 0: the USD side is unknown (D3), so token caps are the bound. */
const piUsage = (u: { input: number; cache_read: number; cache_write: number; output: number; total: number }) =>
	({ input: u.input, output: u.output, cacheRead: u.cache_read, cacheWrite: u.cache_write, totalTokens: u.total, cost: { total: 0 } });

/** Live usage is this run's growth over its baseline, so a resumed thread's earlier turns are never counted twice. */
function liveUsage(total: CodexTokenTotals | undefined, base: CodexTokenTotals | undefined): void {
	if (total === undefined || base === undefined || total.totalTokens <= base.totalTokens) return;
	const d = (key: keyof CodexTokenTotals) => (total[key] ?? 0) - (base[key] ?? 0);
	if ((Object.keys(ZERO_TOTALS) as Array<keyof CodexTokenTotals>).some((key) => d(key) < 0)) return;
	write({ type: "message_update", usage: piUsage({ input: d("inputTokens") - d("cachedInputTokens"), cache_read: d("cachedInputTokens"), cache_write: d("cacheWriteInputTokens"), output: d("outputTokens"), total: d("totalTokens") }) });
}

function onMessage(session: NativeSession, base: CodexTokenTotals | undefined, method: string, params: unknown): void {
	if (method === "turn/started" && session.thread_id === undefined) {
		const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
		if (typeof threadId === "string" && threadId !== "") writeNativeSession(sessionFile, Object.assign(session, { thread_id: threadId }));
	} else if (method === "item/completed") {
		const item = (params as ItemNotification | undefined)?.item;
		if (item?.type === "agentMessage") {
			transcript?.agent(item.text);
			write({ type: "turn_end" });
		} else if (item?.type === "reasoning" && item.summary?.length) transcript?.reasoning(item.summary.join("\n"));
	} else if (method === "thread/tokenUsage/updated") {
		// Unlogged in-flight usage for status.json; the turn's message_end replaces it.
		const t = (params as TokenUsageUpdatedNotification | undefined)?.tokenUsage?.total;
		liveUsage(t === undefined ? undefined : { ...t, cacheWriteInputTokens: t.cacheWriteInputTokens ?? 0 }, base);
	}
}

function onTool(event: CodexToolEvent): void {
	transcript?.tool(event);
	if (event.phase === "start") write({ type: "tool_execution_start", toolCallId: event.id, toolName: event.name, args: event.args ?? {} });
	else {
		if (event.name === "report_result" && event.isError !== true) reportedNow = true;
		write({ type: "tool_execution_end", toolCallId: event.id, toolName: event.name, isError: event.isError === true });
	}
}

/** `lockdown` for every picp refusal or kill; `auth` for a sign-in refusal; none for a clean run. */
function stopOf(result: CodexSpikeResult | undefined, cli: string | undefined): "lockdown" | "auth" | undefined {
	if (cli === "auth") return "auth";
	if (cli !== undefined) return "lockdown";
	if (result === undefined) return undefined;
	return result.lockdown?.verdict !== "ok" || result.hookFailed || result.bypass !== undefined ? "lockdown" : undefined;
}

interface Turn { reported: boolean; settles: boolean; stopped: boolean; code: number; runId: string; pending?: Usage }

/** One app-server run: fresh on a dispatch, else a resume of the recorded thread over its recorded totals. */
async function turn(prompt: string): Promise<Turn> {
	const [worktree, artifactPath] = [env.CP_WORKTREE, env.CP_ARTIFACT_PATH];
	if (env.CP_KIND !== "research" || env.CP_ROLE !== "planner") throw new Error(`the Codex CLI runs research/planner jobs only, not ${env.CP_KIND}/${env.CP_ROLE}`);
	if (!env.CP_JOB_ID || !runDir || !worktree || !artifactPath) throw new Error("Codex CLI worker started without its job identity");
	const model = env.CP_CODEX_MODEL ?? "codex";
	const systemPrompt = readSystemPrompt();
	const resumed = resuming;
	const session = resumed ? resumedSession(worktree) : freshSession(worktree);
	const base = resumed ? session.totals : ZERO_TOTALS;
	if (!transcript) {
		transcript = codexTranscript(nativeTranscriptFile(runDir, jobId), { id: jobId, cwd: worktree }, model);
		write({ type: "native_transcript", transcript_file: transcript.file });
	}
	transcript.prompt(prompt, resumed);
	// Per turn, so a finished turn's abort never reaches the next; a stop under way keeps its aborted controller.
	if (!stopping) abort = new AbortController();
	let result: CodexSpikeResult | undefined;
	let cli: string | undefined;
	let error: string | undefined;
	try {
		result = await runCodexSpike({
			job: { job_id: jobId, kind: "research", role: "planner", delivery: env.CP_DELIVERY as Delivery, runDir, worktree, artifactPath },
			prompt, ...(env.CP_CODEX_MODEL ? { model: env.CP_CODEX_MODEL } : {}), systemPrompt, hostEnv: env, timeoutMs: RUN_TIMEOUT_MS, signal: abort.signal,
			scratchDir: session.scratch_dir, control,
			...(resumed ? { resume: { threadId: session.thread_id as string, ...(session.totals ? { baseline: session.totals } : {}) } } : {}),
			...(env.CP_CODEX_HOME ? { codexHome: env.CP_CODEX_HOME } : {}), ...(env.CP_NATIVE_THINKING ? { effort: env.CP_NATIVE_THINKING } : {}),
			onMessage: (method, params) => onMessage(session, base, method, params),
			onTool,
		});
		error = result.error;
	} catch (err) {
		cli = (err as { cli?: string }).cli ?? "other";
		error = (err as Error).message;
	}
	resuming = session.thread_id !== undefined;
	const usage: CodexRunUsage = result?.usage ?? { status: "unavailable", reason: "the run did not start", cost_unknown: true };
	if (usage.status === "complete") {
		// Totals first, then message_end: a crash between the two recounts nothing, it only leaves this run uncounted.
		if (result?.totals !== undefined && persistTotals()) writeNativeSession(sessionFile, Object.assign(session, { totals: result.totals }));
		write({ type: "message_end", message: { role: "assistant", model, usage: piUsage(usage) }, usage_status: "complete", cost_unknown: true });
	} else {
		write({ type: "message_update", usage: piUsage({ input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 }) });
		write({ type: "usage_unavailable", status: usage.status });
	}
	const stop = stopOf(result, cli === "other" ? undefined : cli);
	const reported = result?.report !== undefined;
	const runId = randomUUID();
	write({
		type: "native_run", run: runId, driver: "codex", resumed, codex_version: result?.codexVersion ?? null, lockdown: result?.lockdown?.verdict ?? "unchecked",
		seen: result?.lockdown?.seen, extra: result?.lockdown?.extra, exit_code: result?.exit?.code ?? null, outcome: result?.outcome ?? "refused", report: reported,
		usage: usage.status === "complete" ? "measured" : "unavailable", usage_status: usage.status, cost_unknown: true,
		denials: result?.denials.length ?? 0, denied: nativeDenials(result?.denials ?? []), report_refusals: result?.reportRefusals.length ?? 0,
		hook_failed: result?.hookFailed ?? false, ...(result?.bypass ? { bypass: result.bypass } : {}), ...(stop ? { stop } : {}),
	});
	say(`outcome ${result?.outcome ?? "refused"}; lockdown ${result?.lockdown?.verdict ?? "unchecked"}; report ${reported ? "accepted" : "none"}${error ? `; ${error}` : ""}`);
	return {
		reported, stopped: stop !== undefined, code: 1, runId,
		settles: reported || (stop === undefined && cli === undefined && result?.outcome === "completed" && error === undefined),
		...(usage.status === "complete" ? { pending: { input: usage.input, output: usage.output, cache_read: usage.cache_read, cache_write: usage.cache_write, total_tokens: usage.total, cost_usd: 0 } } : {}),
	};
}

/** Queued busy sends that passed the same admission a cp_send resume passes, still claimed; none when refused. */
async function dueFollowUps(ran: Turn): Promise<string[]> {
	// Claimed before the admission await: a send queued during it waits for the next turn end, never lost.
	const queued = claimFollowUps(runDir);
	if (queued.length === 0) return [];
	if (abort.signal.aborted || stopping) return (returnClaim(runDir), []);
	const events = join(env.CP_HOME ?? "", paths.eventsFile(jobId));
	const recorded = existsSync(events) && readFileSync(events, "utf8").includes(ran.runId);
	try {
		await assertNativeResume({ home: env.CP_HOME ?? "", jobId, what: "queued follow-up", ...(ran.pending && !recorded ? { pending: ran.pending } : {}) });
	} catch (error) {
		returnClaim(runDir);
		write({ type: "native_followup_refused", count: queued.length, reason: (error as Error).message });
		return [];
	}
	return queued;
}

/** Turns until no admitted follow-up is queued; settles when any turn reported or the last ended clean, else fails. */
async function serve(first: string): Promise<number> {
	busy = true;
	write({ type: "agent_start" });
	let reported = false;
	let last: Turn | undefined;
	try {
		let claimed = claimFollowUps(runDir);
		let prompt: string | undefined = [first, ...claimed].join("\n\n");
		while (prompt !== undefined) {
			// A claim settles only once its turn ran: a throw puts the sends back ahead of newer ones, never delivered.
			const ran = await turn(prompt).catch((error: unknown) => {
				returnClaim(runDir);
				throw error;
			});
			settleClaim(runDir);
			if (claimed.length > 0) write({ type: "native_followup_delivered", count: claimed.length });
			reported ||= ran.reported;
			last = ran;
			// A named stop takes no queued follow-up: another turn would be the nudge the stop forbids.
			claimed = ran.stopped ? [] : await dueFollowUps(ran);
			prompt = claimed.length > 0 ? claimed.join("\n\n") : undefined;
		}
	} finally {
		busy = false;
	}
	if (!reported && !last?.settles) return last?.code ?? 1;
	write({ type: "agent_settled" });
	return 0;
}

/** Queues a steer the CLI refused, unless this busy period already reported: then it fails with nothing queued. */
function queueSteer(message: string, reply: (body: Record<string, unknown>) => void): void {
	if (reportedNow) {
		return reply({ success: false, error: `${jobId}: the turn ended after its report; the steer was not delivered or queued. Send it again to start a new turn.` });
	}
	try {
		enqueueFollowUp(runDir, message);
	} catch (error) {
		return reply({ success: false, error: `${jobId}: the steer was not queued (${(error as Error).message})` });
	}
	reply({ success: true, data: { disposition: "queued" } });
}

/** C2b: `steered` only on the CLI's ack; `-32600` or no live turn queues; any other error fails, nothing queued. */
function steer(message: string, reply: (body: Record<string, unknown>) => void): void {
	const live = control.steer;
	if (live === undefined) return queueSteer(message, reply);
	live(message).then((answer) => {
		if (!answer.steered) return queueSteer(message, reply);
		transcript?.steer(message);
		write({ type: "native_steered", turn_id: answer.turnId });
		reply({ success: true, data: { disposition: "steered" } });
	}, (error: unknown) => reply({ success: false, error: `${jobId}: the steer was not delivered (${(error as Error).message}); nothing was queued` }));
}

function command(line: string): void {
	let request: { id?: unknown; type?: unknown; message?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		return;
	}
	const reply = (body: Record<string, unknown>) => write({ type: "response", id: request.id, command: request.type, ...body });
	if (request.type === "get_state") return reply({ success: true, data: { sessionId: jobId, sessionFile } });
	if (request.type === "checkpoint") return reply({ success: false, error: codexDoorRefusal(jobId, "checkpoint") });
	const message = typeof request.message === "string" ? request.message : undefined;
	if (message !== undefined && busy && request.type === "steer") return steer(message, reply);
	if (message !== undefined && busy && (request.type === "prompt" || request.type === "follow_up")) {
		try {
			enqueueFollowUp(runDir, message);
		} catch (error) {
			return reply({ success: false, error: `${jobId}: the follow-up was not queued (${(error as Error).message})` });
		}
		return reply({ success: true, data: { disposition: "queued" } });
	}
	if (message !== undefined && request.type === "prompt") {
		// Admission holds the door: a prompt arriving meanwhile queues; a refusal is the reply and no turn starts.
		busy = true;
		reportedNow = false;
		const start = () => {
			reply({ success: true, data: { disposition: resuming ? "resuming" : "started" } });
			run = serve(message).catch((error: unknown) => {
				if (resuming) write({ type: "native_resume_failed", reason: (error as Error).message });
				say(`refused: ${(error as Error).message}`);
				return 1;
			});
			void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		};
		void startIdlePrompt({ home: env.CP_HOME ?? "", jobId, resumed: resuming }, start).then((refused) => {
			if (refused === undefined) return;
			busy = false;
			say(refused);
			reply({ success: false, error: refused });
		});
		return;
	}
	reply({ success: false, error: `${jobId}: the Codex worker takes no ${String(request.type)} while idle; send a prompt` });
}

/** Stdin end or SIGTERM aborts a live run; the exit waits for the run's own stop sequence (scope kill included). */
async function stop(): Promise<void> {
	stopping = true;
	abort.abort();
	process.exit(run === undefined ? 0 : await run);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
