/**
 * The native Claude research worker process (N3b; follow-ups N3c). It speaks the pi RPC lines dispatch reads
 * (`get_state`, `prompt`, `follow_up`, then events), runs each turn through `runClaudeSpike` with every N3a gate on,
 * and exits on stdin end or SIGTERM. A turn that ends without an accepted report exits non-zero, so the job fails.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Delivery, paths, type Usage } from "../contracts.ts";
import { NATIVE_RESULT_GRACE_MS, nativeDenials, nativeRunUsage } from "./claude-usage.ts";
import { REPORT_TOOL, resolveClaude, runClaudeSpike } from "./claude-spike.ts";
import { type NativeTranscript, nativeTranscript, nativeTranscriptFile } from "./claude-transcript.ts";
import { modelFamily, type NativeObservation, OBSERVATION_EVENT, turnObserver } from "./claude-observation.ts";
import {
	assertNativeResume,
	claimFollowUps,
	enqueueFollowUp,
	NATIVE_SCRATCH_PREFIX,
	NATIVE_SESSION_FILE,
	type NativeSession,
	nativeDoorRefusal,
	readNativeSession,
	removeNativeScratch,
	returnClaim,
	settleClaim,
	writeNativeSession,
} from "./claude-followup.ts";

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const toolNames = new Map<string, string>();
const abort = new AbortController();
const env = process.env;
/** The SDK turn cap per claude process; `CP_NATIVE_MAX_TURNS` overrides it with a positive integer only. */
const NATIVE_MAX_TURNS = 500;
const turnOverride = Number(env.CP_NATIVE_MAX_TURNS);
const maxTurns = Number.isInteger(turnOverride) && turnOverride > 0 ? turnOverride : NATIVE_MAX_TURNS;
const sessionFile = join(env.CP_RUN_DIR ?? "", NATIVE_SESSION_FILE);
let run: Promise<number> | undefined;
let busy = false;
// A revived worker (CP_NATIVE_RESUME=1) resumes from its first prompt; a dispatched one after its first turn.
let resuming = env.CP_NATIVE_RESUME === "1";
let finalResult: SDKResultMessage | undefined;
// Set by the first stop: no queued follow-up starts a new turn after it.
let stopping = false;
let session: NativeSession | undefined;
let transcript: NativeTranscript | undefined;

let observe = turnObserver();
let cliVersion: string | undefined;
/** Relays one sanitized availability observation (S2) for the parent's snapshot; never SDK auth or error text. */
function observed(seen: NativeObservation | undefined): void {
	if (!seen) return;
	try {
		cliVersion ??= resolveClaude(env).version;
	} catch {
		// No version: the entry is never invalidated by a CLI change, only by the other two rules.
	}
	write({ type: OBSERVATION_EVENT, ...seen, observed_at: Date.now(), ...(cliVersion ? { claude_version: cliVersion } : {}) });
}

/** SDK messages as the pi events the recorder, intake and bounds already watch; the report tool keeps pi's name. */
function relay(message: SDKMessage): void {
	observed(observe(message));
	transcript?.relay(message);
	if (message.type === "result") finalResult = message;
	if (message.type === "system" && message.subtype === "init" && session && session.session_id !== message.session_id) {
		session.session_id = message.session_id;
		writeNativeSession(sessionFile, session);
	}
	if ((message.type !== "assistant" && message.type !== "user") || message.parent_tool_use_id !== null) return;
	const content = message.message.content;
	// SAFETY: SDK content blocks are plain JSON objects; every field read below is checked or stringified.
	for (const block of Array.isArray(content) ? (content as unknown as Array<Record<string, unknown>>) : []) {
		if (block.type === "tool_use") {
			const name = block.name === REPORT_TOOL ? "report_result" : String(block.name);
			toolNames.set(String(block.id), name);
			write({ type: "tool_execution_start", toolCallId: block.id, toolName: name, args: block.input });
		} else if (block.type === "tool_result") {
			write({ type: "tool_execution_end", toolCallId: block.tool_use_id, toolName: toolNames.get(String(block.tool_use_id)) ?? "unknown", isError: block.is_error === true });
		}
	}
	if (message.type === "assistant") write({ type: "turn_end" });
}

/** A new session record and scratch dir; a previous record's scratch dir is removed first, never orphaned. */
function freshSession(): NativeSession {
	if (existsSync(sessionFile)) removeNativeScratch(sessionFile);
	const fresh: NativeSession = { driver: "claude", scratch_dir: mkdtempSync(join(tmpdir(), NATIVE_SCRATCH_PREFIX)), baseline: { ledger: {}, cost_usd: 0 } };
	writeNativeSession(sessionFile, fresh);
	return fresh;
}

/** The role contract the dispatch wrote; a missing or unreadable file stops the turn, never a run without it. */
function readSystemPrompt(): string {
	const file = env.CP_NATIVE_SYSTEM_PROMPT_FILE;
	if (!file) throw new Error("native claude worker started without its system prompt file (CP_NATIVE_SYSTEM_PROMPT_FILE)");
	try {
		const body = readFileSync(file, "utf8");
		if (body.trim() !== "") return body;
	} catch (error) {
		throw new Error(`native claude worker cannot read its system prompt ${file}: ${(error as Error).message}`);
	}
	throw new Error(`native claude worker's system prompt ${file} is empty`);
}

interface Turn {
	reported: boolean;
	code: number;
	runId: string;
	/** This turn's measured usage, for the turn-end budget check before the run log has recorded it. */
	pending?: Usage;
}

/** One claude process: fresh on a dispatch, else a resume of the recorded session over its recorded baseline. */
async function turn(prompt: string): Promise<Turn> {
	if (env.CP_KIND !== "research" || env.CP_ROLE !== "planner") throw new Error(`native claude runs research jobs only, not ${env.CP_KIND}/${env.CP_ROLE}`);
	const [jobId, runDir, worktree, artifactPath] = [env.CP_JOB_ID, env.CP_RUN_DIR, env.CP_WORKTREE, env.CP_ARTIFACT_PATH];
	if (!jobId || !runDir || !worktree || !artifactPath) throw new Error("native claude worker started without its job identity");
	const systemPrompt = readSystemPrompt();
	const current = resuming ? readNativeSession(sessionFile) : freshSession();
	session = current;
	if (resuming && current.session_id === undefined) throw new Error(`${sessionFile} holds no session id; there is nothing to resume`);
	const baseline = current.baseline;
	const ledger = baseline ? new Map(Object.entries(baseline.ledger)) : undefined;
	finalResult = undefined;
	observe = turnObserver();
	const resumed = resuming;
	if (!transcript) {
		transcript = nativeTranscript(nativeTranscriptFile(runDir, jobId), { jobId, cwd: worktree }, (name) => (name === REPORT_TOOL ? "report_result" : name));
		write({ type: "native_transcript", transcript_file: transcript.file });
	}
	transcript.prompt(prompt, resumed);
	const result = await runClaudeSpike({
		job: { job_id: jobId, kind: env.CP_KIND, role: env.CP_ROLE, delivery: env.CP_DELIVERY as Delivery, runDir, worktree, artifactPath },
		systemPrompt,
		prompt,
		signal: abort.signal,
		onMessage: relay,
		maxTurns,
		timeoutMs: 24 * 60 * 60_000,
		scratchDir: current.scratch_dir,
		...(resumed ? { resume: { sessionId: current.session_id as string, ...(ledger ? { ledger } : {}) } } : {}),
		...(env.CP_NATIVE_MODEL ? { model: env.CP_NATIVE_MODEL } : {}),
		...(env.CP_NATIVE_THINKING ? { thinking: env.CP_NATIVE_THINKING } : {}),
	});
	resuming = current.session_id !== undefined;
	// The resumed process restores the session's cumulative modelUsage and cost: count only the growth over the baseline.
	const measured = nativeRunUsage(finalResult, baseline);
	if (result.resultSubtype !== undefined) {
		// A result without a readable ledger and cost leaves no baseline, so the next resume is unmeasured, never recounted.
		if (measured.baseline) current.baseline = measured.baseline;
		else delete current.baseline;
		writeNativeSession(sessionFile, current);
	}
	const usage = measured.usage;
	write(usage ? { type: "message_end", message: { role: "assistant", model: result.initModel ?? "claude", usage } } : { type: "usage_unavailable", status: measured.status });
	const lockdown = result.lockdown?.verdict ?? "unchecked";
	if (lockdown === "refused") observed({ kind: "lockdown", code: "lockdown" });
	else if (result.resultSubtype === "success" && result.error === undefined && lockdown === "ok") {
		const family = modelFamily(env.CP_NATIVE_MODEL ?? "");
		observed({ kind: "turn_ok", ...(family ? { family } : {}) });
	}
	const counts = { seen: result.lockdown?.seen, extra: result.lockdown?.extra };
	const runId = randomUUID();
	const turnLimit = result.resultSubtype === "error_max_turns";
	write({ type: "native_run", run: runId, resumed, claude_version: result.claudeVersion, lockdown, ...counts, exit_code: result.exit?.code ?? null, report: Boolean(result.report), result_subtype: result.resultSubtype ?? null, usage: usage ? "measured" : "unavailable", usage_status: measured.status, denials: result.denials.length, denied: nativeDenials(result.denials), report_refusals: result.reportRefusals.length, max_turns: maxTurns, ...(turnLimit ? { stop: "max_turns" } : {}) });
	if (turnLimit) process.stderr.write(`[native claude] stopped at the turn limit (${maxTurns} turns)\n`);
	process.stderr.write(`[native claude] exit ${result.exit?.code ?? result.exit?.signal ?? "none"}; lockdown ${lockdown}; report ${result.report ? "accepted" : "none"}${result.error ? `; ${result.error}` : ""}\n`);
	return {
		reported: Boolean(result.report),
		code: result.exit?.code || 1,
		runId,
		...(usage ? { pending: { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, total_tokens: usage.totalTokens, cost_usd: usage.cost.total } } : {}),
	};
}

/** Queued busy sends that passed the same admission a cp_send resume passes, still claimed; none when refused. */
async function dueFollowUps(ran: Turn): Promise<string[]> {
	const runDir = env.CP_RUN_DIR ?? "";
	// Claimed before the admission await: a send queued during it waits for the next turn end, never lost.
	const queued = claimFollowUps(runDir);
	if (queued.length === 0) return [];
	if (abort.signal.aborted || stopping) return (returnClaim(runDir), []);
	const events = join(env.CP_HOME ?? "", paths.eventsFile(env.CP_JOB_ID ?? ""));
	const recorded = existsSync(events) && readFileSync(events, "utf8").includes(ran.runId);
	try {
		await assertNativeResume({ home: env.CP_HOME ?? "", jobId: env.CP_JOB_ID ?? "", what: "queued follow-up", ...(ran.pending && !recorded ? { pending: ran.pending } : {}) });
	} catch (error) {
		returnClaim(runDir);
		write({ type: "native_followup_refused", count: queued.length, reason: (error as Error).message });
		return [];
	}
	return queued;
}

/** Turns until no admitted follow-up is queued; settles when any turn reported, else returns the failing exit code. */
async function serve(first: string): Promise<number> {
	busy = true;
	write({ type: "agent_start" });
	let reported = false;
	let code = 1;
	try {
		const runDir = env.CP_RUN_DIR ?? "";
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
			code = ran.code;
			claimed = await dueFollowUps(ran);
			prompt = claimed.length > 0 ? claimed.join("\n\n") : undefined;
		}
	} finally {
		busy = false;
	}
	if (!reported) return code;
	write({ type: "agent_settled" });
	return 0;
}

function command(line: string): void {
	let request: { id?: unknown; type?: unknown; message?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		return;
	}
	const reply = (body: Record<string, unknown>) => write({ type: "response", id: request.id, command: request.type, ...body });
	const jobId = env.CP_JOB_ID ?? "this job";
	if (request.type === "get_state") return reply({ success: true, data: { sessionId: jobId, sessionFile } });
	const message = typeof request.message === "string" ? request.message : undefined;
	if (message !== undefined && busy && (request.type === "prompt" || request.type === "follow_up")) {
		try {
			enqueueFollowUp(env.CP_RUN_DIR ?? "", message);
		} catch (error) {
			return reply({ success: false, error: `${jobId}: the follow-up was not queued (${(error as Error).message})` });
		}
		return reply({ success: true, data: { disposition: "queued" } });
	}
	if (message !== undefined && request.type === "prompt") {
		// "resuming" is admitted and starting, not yet run: a resume that throws is journaled as native_resume_failed.
		reply({ success: true, data: { disposition: resuming ? "resuming" : "started" } });
		run = serve(message).catch((error: unknown) => {
			if (resuming) write({ type: "native_resume_failed", reason: (error as Error).message });
			process.stderr.write(`[native claude] refused: ${(error as Error).message}\n`);
			return 1;
		});
		void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		return;
	}
	const why = request.type === "steer" ? nativeDoorRefusal(jobId, "steer") : `${jobId}: the native worker takes no ${String(request.type)} while idle; send a prompt`;
	reply({ success: false, error: why });
}

/**
 * Stdin end or SIGTERM aborts a live run; the exit waits for claude's observed exit inside the run. A turn still in
 * flight first gets `NATIVE_RESULT_GRACE_MS` for its `result`, so its usage is measured; a second stop aborts at once.
 */
async function stop(): Promise<void> {
	const deadline = Date.now() + NATIVE_RESULT_GRACE_MS;
	if (!stopping) {
		stopping = true;
		while (busy && finalResult === undefined && Date.now() < deadline) await sleep(50);
	}
	abort.abort();
	process.exit((await run) ?? 0);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
