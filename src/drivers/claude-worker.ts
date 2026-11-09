/**
 * The Claude CLI research worker process (N3b; follow-ups N3c; lifecycle N4e). It speaks the pi RPC lines dispatch
 * reads (`get_state`, `prompt`, `follow_up`, then events), runs each turn through `runClaudeSpike` with every N3a gate
 * on, and exits on stdin end or SIGTERM. A clean unreported turn settles idle; a named stop exits non-zero.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { configureLayout, type Delivery, paths, type Usage } from "../contracts.ts";
import { estimatedRunUsage, liveUsageUpdate, NATIVE_REPORTED_GRACE_MS, NATIVE_RESULT_GRACE_MS, nativeDenials, nativeRunUsage, noteStreamedUsage, type StreamedUsage } from "./claude-usage.ts";
import { commitIdentityEnv } from "./claude-forge-tools.ts";
import { implementerArtifactPath, implementerExclusions, nativeRole } from "./claude-roles.ts";
import { REPORT_TOOL, resolveClaude, runClaudeSpike } from "./claude-spike.ts";
import { VERDICT_TOOL } from "./claude-verdict.ts";
import { type NativeTranscript, nativeTranscript, nativeTranscriptFile } from "./claude-transcript.ts";
import { modelFamily, type NativeObservation, OBSERVATION_EVENT, turnObserver } from "./claude-observation.ts";
import { classifyTurn, nativeRunStop, startIdlePrompt, type TurnEnd } from "./claude-lifecycle.ts";
import {
	assertNativeResume,
	claimFollowUps,
	enqueueFollowUp,
	NATIVE_SCRATCH_PREFIX,
	NATIVE_SESSION_FILE,
	type NativeSession,
	nativeDoorRefusal,
	nativeSessionMoved,
	readNativeSession,
	removeNativeScratch,
	returnClaim,
	settleClaim,
	writeNativeSession,
} from "./claude-followup.ts";

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const toolNames = new Map<string, string>();
let abort = new AbortController();
const env = process.env;
// A flat home (`~/.pi-command-post`) keeps state/ at its root: unconfigured, every home read missed (N4l).
if (env.CP_HOME) configureLayout("multi", env.CP_HOME);
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
let streamed: StreamedUsage = new Map();
// Set once a report or verdict tool result is accepted: a stop then waits the longer grace for the result.
let accepted = false;
// Set by the first stop: no queued follow-up starts a new turn after it.
let stopping = false;
// Set by a `checkpoint` (a freeze drain): the turn is aborted, its WIP committed, and the worker settles idle.
let freezing = false;
const checkpointReplies: Array<(body: Record<string, unknown>) => void> = [];
// Set while an idle prompt's resume admission is pending: busy, but no turn exists to checkpoint.
let admitting = false;
let session: NativeSession | undefined;
let transcript: NativeTranscript | undefined;

let observe = turnObserver();
let turnSeen: NativeObservation[] = [];
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

/** picp's MCP report tools keep pi's names (`report_result`, `report_verdict`), so intake and awaitVerdict see them. */
const toolName = (name: string): string => (name === REPORT_TOOL ? "report_result" : name === VERDICT_TOOL ? "report_verdict" : name);

/** SDK messages as the pi events the recorder, intake and bounds already watch. */
function relay(message: SDKMessage): void {
	const seen = observe(message);
	if (seen) turnSeen.push(seen);
	observed(seen);
	transcript?.relay(message);
	if (message.type === "result") finalResult = message;
	noteStreamedUsage(streamed, message);
	// Live in-flight usage for status.json (unlogged; the turn's message_end replaces it), so a run never reads 0.
	if (message.type === "assistant") write(liveUsageUpdate(streamed));
	if (message.type === "system" && message.subtype === "init" && session && session.session_id !== message.session_id) {
		session.session_id = message.session_id;
		writeNativeSession(sessionFile, session);
	}
	if ((message.type !== "assistant" && message.type !== "user") || message.parent_tool_use_id !== null) return;
	const content = message.message.content;
	// SAFETY: SDK content blocks are plain JSON objects; every field read below is checked or stringified.
	for (const block of Array.isArray(content) ? (content as unknown as Array<Record<string, unknown>>) : []) {
		if (block.type === "tool_use") {
			const name = toolName(String(block.name));
			toolNames.set(String(block.id), name);
			write({ type: "tool_execution_start", toolCallId: block.id, toolName: name, args: block.input });
		} else if (block.type === "tool_result") {
			const name = toolNames.get(String(block.tool_use_id)) ?? "unknown";
			if ((name === "report_result" || name === "report_verdict") && block.is_error !== true) accepted = true;
			write({ type: "tool_execution_end", toolCallId: block.tool_use_id, toolName: name, isError: block.is_error === true });
		}
	}
	if (message.type === "assistant") write({ type: "turn_end" });
}

/** A new session record and scratch dir; a previous record's scratch dir is removed first, never orphaned. */
function freshSession(cwd: string): NativeSession {
	if (existsSync(sessionFile)) removeNativeScratch(sessionFile);
	const base = env.CP_BASE_BRANCH?.trim();
	const fresh: NativeSession = { driver: "claude", scratch_dir: mkdtempSync(join(tmpdir(), NATIVE_SCRATCH_PREFIX)), cwd, ...(base ? { base } : {}), baseline: { ledger: {}, cost_usd: 0 } };
	writeNativeSession(sessionFile, fresh);
	return fresh;
}

/** A fresh session after a moved worktree has no transcript: the job's brief leads its first prompt. */
function briefFor(jobId: string): string {
	const file = join(env.CP_HOME ?? "", paths.briefFile(jobId));
	return existsSync(file) ? `${readFileSync(file, "utf8").trimEnd()}\n\n` : "";
}

/** The role contract the dispatch wrote; a missing or unreadable file stops the turn, never a run without it. */
function readSystemPrompt(): string {
	const file = env.CP_NATIVE_SYSTEM_PROMPT_FILE;
	if (!file) throw new Error("Claude CLI worker started without its system prompt file (CP_NATIVE_SYSTEM_PROMPT_FILE)");
	try {
		const body = readFileSync(file, "utf8");
		if (body.trim() !== "") return body;
	} catch (error) {
		throw new Error(`Claude CLI worker cannot read its system prompt ${file}: ${(error as Error).message}`);
	}
	throw new Error(`Claude CLI worker's system prompt ${file} is empty`);
}

interface Turn {
	reported: boolean;
	code: number;
	runId: string;
	end: TurnEnd;
	/** This turn's measured usage, for the turn-end budget check before the run log has recorded it. */
	pending?: Usage;
}

/** One claude process: fresh on a dispatch, else a resume of the recorded session over its recorded baseline. */
async function turn(prompt: string): Promise<Turn> {
	const [kind, role] = [env.CP_KIND, env.CP_ROLE] as ["research" | "ship", "planner" | "gate-reviewer" | "implementer"];
	if (!["research/planner", "research/gate-reviewer", "ship/implementer"].includes(`${kind}/${role}`)) {
		throw new Error(`the Claude CLI runs research/planner, research/gate-reviewer and ship/implementer jobs only, not ${kind}/${role}`);
	}
	const [jobId, runDir, worktree] = [env.CP_JOB_ID, env.CP_RUN_DIR, env.CP_WORKTREE];
	let artifactPath = env.CP_ARTIFACT_PATH;
	if (!jobId || !runDir || !worktree || (role === "planner" && !artifactPath)) throw new Error("Claude CLI worker started without its job identity");
	const systemPrompt = readSystemPrompt();
	let current = resuming ? readNativeSession(sessionFile) : freshSession(worktree);
	const moved = resuming ? nativeSessionMoved(current, worktree) : undefined;
	if (moved) {
		write({ type: "native_session_moved", from: current.cwd, to: worktree, reason: moved });
		process.stderr.write(`[claude cli] ${moved}\n`);
		resuming = false;
		current = freshSession(worktree);
		prompt = `${briefFor(jobId)}${prompt}`;
	}
	session = current;
	if (resuming && current.session_id === undefined) throw new Error(`${sessionFile} holds no session id; there is nothing to resume`);
	const baseline = current.baseline;
	const ledger = baseline ? new Map(Object.entries(baseline.ledger)) : undefined;
	finalResult = undefined;
	streamed = new Map();
	observe = turnObserver();
	turnSeen = [];
	const resumed = resuming;
	if (!transcript) {
		transcript = nativeTranscript(nativeTranscriptFile(runDir, jobId), { id: jobId, cwd: worktree }, toolName);
		write({ type: "native_transcript", transcript_file: transcript.file });
	}
	transcript.prompt(prompt, resumed);
	const implementer = nativeRole(role) === "implementer";
	// Dispatch predeclares no ship artifact; the implementer's own is named here from the home and job id alone.
	if (implementer) artifactPath = implementerArtifactPath(env.CP_HOME ?? "", jobId);
	// Per turn, so a checkpoint aborts only this run; a stop or freeze already under way keeps its aborted controller.
	if (!stopping && !freezing) abort = new AbortController();
	const result = await runClaudeSpike({
		job: {
			job_id: jobId, kind, role, delivery: env.CP_DELIVERY as Delivery, runDir, worktree, ...(artifactPath ? { artifactPath } : {}),
			...(implementer ? { excludePaths: implementerExclusions(env.CP_HOME ?? "") } : {}),
		},
		...(implementer ? { providerEnv: commitIdentityEnv(worktree) } : {}),
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
	const measured = finalResult === undefined ? estimatedRunUsage(streamed, baseline) : nativeRunUsage(finalResult, baseline);
	if (result.resultSubtype !== undefined || measured.status === "estimated") {
		// A result without a readable ledger and cost leaves no baseline, so the next resume is unmeasured, never recounted.
		if (measured.baseline) current.baseline = measured.baseline;
		else delete current.baseline;
		writeNativeSession(sessionFile, current);
	}
	const usage = measured.usage;
	const costUnknown = measured.cost_unknown ? { cost_unknown: true } : {};
	// An unmeasured turn clears the live estimate, so status.json matches the log a rebuild replays.
	if (!usage) write(liveUsageUpdate(new Map()));
	write(usage ? { type: "message_end", message: { role: "assistant", model: result.initModel ?? "claude", usage }, usage_status: measured.status, ...costUnknown } : { type: "usage_unavailable", status: measured.status });
	const lockdown = result.lockdown?.verdict ?? "unchecked";
	if (lockdown === "refused") observed({ kind: "lockdown", code: "lockdown" });
	else if (result.resultSubtype === "success" && result.error === undefined && lockdown === "ok") {
		const family = modelFamily(env.CP_NATIVE_MODEL ?? "");
		observed({ kind: "turn_ok", ...(family ? { family } : {}) });
	}
	const counts = { seen: result.lockdown?.seen, extra: result.lockdown?.extra };
	const runId = randomUUID();
	// SAFETY: relay() sets finalResult during the run; the control-flow narrowing to undefined above is stale.
	const isError = (finalResult as SDKResultMessage | undefined)?.is_error;
	const reported = Boolean(result.report ?? result.verdict);
	const end = classifyTurn({ reported, resultSubtype: result.resultSubtype, isError, error: result.error, lockdown, observations: turnSeen, frozen: freezing });
	const stop = nativeRunStop(end, maxTurns);
	write({ type: "native_run", run: runId, resumed, claude_version: result.claudeVersion, lockdown, ...counts, exit_code: result.exit?.code ?? null, report: reported, result_subtype: result.resultSubtype ?? null, usage: measured.status === "estimated" ? "estimated" : usage ? "measured" : "unavailable", usage_status: measured.status, ...costUnknown, denials: result.denials.length, denied: nativeDenials(result.denials), report_refusals: result.reportRefusals.length, max_turns: maxTurns, ...stop.fields });
	if (stop.line) process.stderr.write(`[claude cli] ${stop.line}\n`);
	process.stderr.write(`[claude cli] exit ${result.exit?.code ?? result.exit?.signal ?? "none"}; lockdown ${lockdown}; report ${reported ? "accepted" : "none"}${result.error ? `; ${result.error}` : ""}\n`);
	return {
		reported,
		code: result.exit?.code || 1,
		runId,
		end,
		...(usage ? { pending: { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, total_tokens: usage.totalTokens, cost_usd: usage.cost.total } } : {}),
	};
}

/** Queued busy sends that passed the same admission a cp_send resume passes, still claimed; none when refused. */
async function dueFollowUps(ran: Turn): Promise<string[]> {
	const runDir = env.CP_RUN_DIR ?? "";
	// Claimed before the admission await: a send queued during it waits for the next turn end, never lost.
	const queued = claimFollowUps(runDir);
	if (queued.length === 0) return [];
	if (abort.signal.aborted || stopping || freezing) return (returnClaim(runDir), []);
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

type Checkpoint = { head: string; pushed: boolean; error?: string } | { error: string };

/**
 * Commits the worktree's WIP after a freeze aborted the turn (`git add -A` honours .gitignore), then pushes it to
 * origin/<job> best effort, never forced: a failed push is `pushed: false` with its error, still a checkpoint.
 */
function checkpointCommit(worktree: string, branch: string): Checkpoint {
	const bounded = (error: unknown) => (error as Error).message.slice(0, 500);
	let head: string;
	let git: (args: string[]) => string;
	try {
		const options: ExecFileSyncOptionsWithStringEncoding = { cwd: worktree, env: { ...env, ...commitIdentityEnv(worktree) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
		git = (args) => execFileSync("git", args, options).trim();
		git(["add", "-A"]);
		if (git(["status", "--porcelain"]) !== "") git(["commit", "-q", "-m", "WIP: freeze checkpoint"]);
		head = git(["rev-parse", "HEAD"]);
	} catch (error) {
		return { error: bounded(error) };
	}
	if (!branch || ["main", env.CP_BASE_BRANCH?.trim()].includes(branch)) return { head, pushed: false, error: `no job branch to push (${branch || "unset"})` };
	try {
		git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
		return { head, pushed: true };
	} catch (error) {
		return { head, pushed: false, error: bounded(error) };
	}
}

/** Turns until no admitted follow-up is queued; settles when any turn reported or the last ended clean, else fails. */
async function serve(first: string): Promise<number> {
	busy = true;
	write({ type: "agent_start" });
	let reported = false;
	let code = 1;
	let end: TurnEnd | undefined;
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
			end = ran.end;
			// A named stop takes no queued follow-up: another turn would be the nudge the stop forbids.
			claimed = (end.kind === "stop" && end.stop !== "other") || end.kind === "frozen" ? [] : await dueFollowUps(ran);
			// A checkpoint during the admission await: the claim goes back and the freeze ends the loop.
			if (freezing && claimed.length > 0) claimed = (returnClaim(runDir), []);
			prompt = claimed.length > 0 ? claimed.join("\n\n") : undefined;
		}
	} finally {
		busy = false;
	}
	if (freezing) {
		freezing = false;
		// A named stop (auth, lockdown, window) wins over the freeze: no checkpoint, and its non-zero exit is kept.
		const named = end?.kind === "stop" && end.stop !== "other" ? end.stop : undefined;
		const outcome = named ? { error: `the turn ended on a named stop (${named}); nothing was checkpointed` } : checkpointCommit(env.CP_WORKTREE ?? "", env.CP_JOB_ID ?? "");
		if (!named) write({ type: "native_checkpoint", ...outcome });
		for (const answer of checkpointReplies.splice(0)) answer("head" in outcome ? { success: true, data: outcome } : { success: false, ...outcome });
		if (named) return code;
		write({ type: "agent_settled" });
		return 0;
	}
	if (!reported && end?.kind !== "settle") return code;
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
	if (request.type === "checkpoint") {
		if (!busy) return reply({ success: false, error: `${jobId}: the native worker is idle; there is no turn to checkpoint` });
		// No turn runs yet: a freeze set now would outlive a refused admission and abort the next turn.
		if (admitting) return reply({ success: false, error: `${jobId}: a resume admission is pending; no turn to checkpoint yet` });
		// serve() awaits the observed claude exit, commits the WIP, answers with the head and settles idle.
		freezing = true;
		checkpointReplies.push(reply);
		abort.abort();
		return;
	}
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
		// Admission holds the door: a prompt arriving meanwhile queues; a refusal is the reply and no turn starts.
		busy = true;
		admitting = true;
		const start = () => {
			admitting = false;
			// "resuming" is admitted and starting, not yet run: a resume that throws is journaled as native_resume_failed.
			reply({ success: true, data: { disposition: resuming ? "resuming" : "started" } });
			run = serve(message).catch((error: unknown) => {
				if (resuming) write({ type: "native_resume_failed", reason: (error as Error).message });
				freezing = false;
				for (const answer of checkpointReplies.splice(0)) answer({ success: false, error: `the turn failed before a checkpoint: ${(error as Error).message}` });
				process.stderr.write(`[claude cli] refused: ${(error as Error).message}\n`);
				return 1;
			});
			void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		};
		void startIdlePrompt({ home: env.CP_HOME ?? "", jobId, resumed: resuming }, start).then((refused) => {
			if (refused === undefined) return;
			admitting = false;
			busy = false;
			process.stderr.write(`[claude cli] ${refused}\n`);
			reply({ success: false, error: refused });
		});
		return;
	}
	const why = request.type === "steer" ? nativeDoorRefusal(jobId, "steer") : `${jobId}: the native worker takes no ${String(request.type)} while idle; send a prompt`;
	reply({ success: false, error: why });
}

/**
 * Stdin end or SIGTERM aborts a live run; the exit waits for claude's observed exit inside the run. A turn in flight
 * first waits for its `result` (`NATIVE_REPORTED_GRACE_MS` once a report was accepted, else `NATIVE_RESULT_GRACE_MS`),
 * so its usage is measured; a second stop aborts at once.
 */
async function stop(): Promise<void> {
	const deadline = Date.now() + (accepted ? NATIVE_REPORTED_GRACE_MS : NATIVE_RESULT_GRACE_MS);
	if (!stopping) {
		stopping = true;
		while (busy && finalResult === undefined && Date.now() < deadline) await sleep(50);
	}
	abort.abort();
	process.exit((await run) ?? 0);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
