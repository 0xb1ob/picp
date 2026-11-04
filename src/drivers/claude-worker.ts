/**
 * The native Claude research worker process (N3b; follow-ups N3c). It speaks the pi RPC lines dispatch reads
 * (`get_state`, `prompt`, `follow_up`, then events), runs each turn through `runClaudeSpike` with every N3a gate on,
 * and exits on stdin end or SIGTERM. A turn that ends without an accepted report exits non-zero, so the job fails.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnTokenUsage } from "@t3tools/contracts";
import { type Delivery, paths, type Usage } from "../contracts.ts";
import { REPORT_TOOL, runClaudeSpike } from "./claude-spike.ts";
import {
	assertNativeResume,
	dropFollowUps,
	enqueueFollowUp,
	NATIVE_SCRATCH_PREFIX,
	NATIVE_SESSION_FILE,
	type NativeSession,
	nativeDoorRefusal,
	queuedFollowUps,
	readNativeSession,
	removeNativeScratch,
	writeNativeSession,
} from "./claude-followup.ts";

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const toolNames = new Map<string, string>();
const abort = new AbortController();
const env = process.env;
const sessionFile = join(env.CP_RUN_DIR ?? "", NATIVE_SESSION_FILE);
let run: Promise<number> | undefined;
let busy = false;
// A revived worker (CP_NATIVE_RESUME=1) resumes from its first prompt; a dispatched one after its first turn.
let resuming = env.CP_NATIVE_RESUME === "1";
let costTotal: number | undefined;
let session: NativeSession | undefined;
/** pi's usage shape (run-artifacts `readUsage`); undefined (unavailable) unless tokens are complete and non-zero and
 * the cost is a finite number, since a real model call never costs zero tokens: a zero means nothing was reported. */
export function piUsage(usage: TurnTokenUsage, cost: number | undefined): Record<string, unknown> | undefined {
	if (usage.usageStatus !== "complete" || cost === undefined || !Number.isFinite(cost)) return undefined;
	const cacheRead = usage.cachedInputTokens ?? 0;
	const cacheWrite = usage.cacheCreationTokens ?? 0;
	const input = usage.inputTokens - cacheRead - cacheWrite + (usage.otherUsage?.inputTokens ?? 0);
	const output = usage.outputTokens + (usage.otherUsage?.outputTokens ?? 0);
	const totalTokens = input + output + cacheRead + cacheWrite;
	return totalTokens > 0 ? { input, output, cacheRead, cacheWrite, totalTokens, cost: { total: cost } } : undefined;
}

/** SDK messages as the pi events the recorder, intake and bounds already watch; the report tool keeps pi's name. */
function relay(message: SDKMessage): void {
	if (message.type === "result") costTotal = Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : undefined;
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
	const current = resuming ? readNativeSession(sessionFile) : freshSession();
	session = current;
	if (resuming && current.session_id === undefined) throw new Error(`${sessionFile} holds no session id; there is nothing to resume`);
	const baseline = current.baseline;
	const ledger = baseline ? new Map(Object.entries(baseline.ledger)) : undefined;
	costTotal = undefined;
	const resumed = resuming;
	const result = await runClaudeSpike({
		job: { job_id: jobId, delivery: env.CP_DELIVERY as Delivery, runDir, worktree, artifactPath },
		prompt,
		signal: abort.signal,
		onMessage: relay,
		maxTurns: Number(env.CP_NATIVE_MAX_TURNS) || 40,
		timeoutMs: 24 * 60 * 60_000,
		scratchDir: current.scratch_dir,
		...(resumed ? { resume: { sessionId: current.session_id as string, ...(ledger ? { ledger } : {}) } } : {}),
		...(env.CP_NATIVE_MODEL ? { model: env.CP_NATIVE_MODEL } : {}),
	});
	resuming = current.session_id !== undefined;
	// The resumed process restores the session's cumulative modelUsage and cost: count only the growth over the baseline.
	const cost = baseline && costTotal !== undefined && costTotal >= baseline.cost_usd ? costTotal - baseline.cost_usd : undefined;
	if (result.resultSubtype !== undefined) {
		// A result without a full ledger and cost leaves no baseline, so the next resume is unmeasured, never recounted.
		if (result.ledger && costTotal !== undefined) current.baseline = { ledger: Object.fromEntries(result.ledger), cost_usd: costTotal };
		else delete current.baseline;
		writeNativeSession(sessionFile, current);
	}
	const usage = piUsage(result.usage, cost);
	write(usage ? { type: "message_end", message: { role: "assistant", model: result.initModel ?? "claude", usage } } : { type: "usage_unavailable", status: result.usage.usageStatus });
	const lockdown = result.lockdown?.verdict ?? "unchecked";
	const counts = { seen: result.lockdown?.seen, extra: result.lockdown?.extra };
	const runId = randomUUID();
	write({ type: "native_run", run: runId, resumed, claude_version: result.claudeVersion, lockdown, ...counts, exit_code: result.exit?.code ?? null, report: Boolean(result.report), usage: usage ? "measured" : "unavailable", denials: result.denials.length, report_refusals: result.reportRefusals.length });
	process.stderr.write(`[native claude] exit ${result.exit?.code ?? result.exit?.signal ?? "none"}; lockdown ${lockdown}; report ${result.report ? "accepted" : "none"}${result.error ? `; ${result.error}` : ""}\n`);
	const pending = usage as { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } | undefined;
	return {
		reported: Boolean(result.report),
		code: result.exit?.code || 1,
		runId,
		...(pending ? { pending: { input: pending.input, output: pending.output, cache_read: pending.cacheRead, cache_write: pending.cacheWrite, total_tokens: pending.totalTokens, cost_usd: pending.cost.total } } : {}),
	};
}

/** Queued busy sends, delivered by a resume at turn end only after the same admission a cp_send resume passes. */
async function dueFollowUps(ran: Turn): Promise<string | undefined> {
	const runDir = env.CP_RUN_DIR ?? "";
	const queued = queuedFollowUps(runDir);
	if (queued.length === 0 || abort.signal.aborted) return undefined;
	const events = join(env.CP_HOME ?? "", paths.eventsFile(env.CP_JOB_ID ?? ""));
	const recorded = existsSync(events) && readFileSync(events, "utf8").includes(ran.runId);
	try {
		await assertNativeResume({ home: env.CP_HOME ?? "", jobId: env.CP_JOB_ID ?? "", what: "queued follow-up", ...(ran.pending && !recorded ? { pending: ran.pending } : {}) });
	} catch (error) {
		write({ type: "native_followup_refused", count: queued.length, reason: (error as Error).message });
		return undefined;
	}
	dropFollowUps(runDir, queued.length);
	write({ type: "native_followup_delivered", count: queued.length });
	return queued.join("\n\n");
}

/** Turns until no admitted follow-up is queued; settles when any turn reported, else returns the failing exit code. */
async function serve(first: string): Promise<number> {
	busy = true;
	write({ type: "agent_start" });
	let reported = false;
	let code = 1;
	try {
		const runDir = env.CP_RUN_DIR ?? "";
		const left = queuedFollowUps(runDir);
		if (left.length > 0) {
			dropFollowUps(runDir, left.length);
			write({ type: "native_followup_delivered", count: left.length });
		}
		let prompt: string | undefined = [first, ...left].join("\n\n");
		while (prompt !== undefined) {
			const ran = await turn(prompt);
			reported ||= ran.reported;
			code = ran.code;
			prompt = await dueFollowUps(ran);
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
		reply({ success: true, data: { disposition: resuming ? "resumed" : "started" } });
		run = serve(message).catch((error: unknown) => {
			process.stderr.write(`[native claude] refused: ${(error as Error).message}\n`);
			return 1;
		});
		void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		return;
	}
	const why = request.type === "steer" ? nativeDoorRefusal(jobId, "steer") : `${jobId}: the native worker takes no ${String(request.type)} while idle; send a prompt`;
	reply({ success: false, error: why });
}

/** Stdin end or SIGTERM aborts a live run; the exit waits for claude's observed exit inside the run. */
async function stop(): Promise<void> {
	abort.abort();
	process.exit((await run) ?? 0);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
