/**
 * The Codex CLI research worker process (C1b). It speaks the pi RPC lines dispatch reads (`get_state`, one `prompt`,
 * then events), runs one `runCodexSpike` turn with every C1a gate on, and refuses every other door until C2. A reported
 * turn settles and waits for stdin end; an unreported or stopped one exits 1 and fails on its observed exit.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { configureLayout, type Delivery } from "../contracts.ts";
import { nativeTranscriptFile } from "./claude-transcript.ts";
import { nativeDenials } from "./claude-usage.ts";
import { codexDoorRefusal } from "./codex.ts";
import type { ItemNotification, TokenUsageUpdatedNotification } from "./codex-protocol.ts";
import { type CodexRunUsage, type CodexSpikeResult, type CodexToolEvent, runCodexSpike } from "./codex-spike.ts";
import { type CodexTranscript, codexTranscript } from "./codex-transcript.ts";

const SESSION_FILE = "native-codex";
const SCRATCH_PREFIX = "cp-codex-native-";
const RUN_TIMEOUT_MS = 24 * 60 * 60_000;
const env = process.env;
if (env.CP_HOME) configureLayout("multi", env.CP_HOME);
const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);
const say = (line: string): void => void process.stderr.write(`[codex cli] ${line}\n`);
const jobId = env.CP_JOB_ID ?? "this job";
const sessionFile = join(env.CP_RUN_DIR ?? "", SESSION_FILE);
const abort = new AbortController();
let run: Promise<number> | undefined;

interface Session { driver: "codex"; scratch_dir: string; cwd: string; codex_home?: string; thread_id?: string }

function save(session: Session): void {
	writeFileSync(`${sessionFile}.tmp`, `${JSON.stringify(session)}\n`, { mode: 0o600 });
	renameSync(`${sessionFile}.tmp`, sessionFile);
}

/** A new record and scratch dir; a previous record's picp-made scratch dir is removed first, never orphaned. */
function freshSession(cwd: string): Session {
	try {
		const dir = (JSON.parse(readFileSync(sessionFile, "utf8")) as { scratch_dir?: unknown }).scratch_dir;
		if (typeof dir === "string" && isAbsolute(dir) && new RegExp(`^${SCRATCH_PREFIX}[A-Za-z0-9]{6}$`).test(basename(dir))) rmSync(dir, { recursive: true, force: true });
	} catch {
		// No previous record, or one teardown already removed.
	}
	const session: Session = { driver: "codex", scratch_dir: mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)), cwd, ...(env.CP_CODEX_HOME ? { codex_home: env.CP_CODEX_HOME } : {}) };
	save(session);
	return session;
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

function onMessage(session: Session, transcript: CodexTranscript, method: string, params: unknown): void {
	if (method === "turn/started" && session.thread_id === undefined) {
		const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
		if (typeof threadId === "string" && threadId !== "") save(Object.assign(session, { thread_id: threadId }));
	} else if (method === "item/completed") {
		const item = (params as ItemNotification | undefined)?.item;
		if (item?.type === "agentMessage") {
			transcript.agent(item.text);
			write({ type: "turn_end" });
		} else if (item?.type === "reasoning" && item.summary?.length) transcript.reasoning(item.summary.join("\n"));
	} else if (method === "thread/tokenUsage/updated") {
		// Live in-flight usage for status.json (unlogged); the turn's message_end replaces it.
		const t = (params as TokenUsageUpdatedNotification | undefined)?.tokenUsage?.total;
		if (t !== undefined) {
			write({ type: "message_update", usage: piUsage({ input: t.inputTokens - t.cachedInputTokens, cache_read: t.cachedInputTokens, cache_write: t.cacheWriteInputTokens ?? 0, output: t.outputTokens, total: t.totalTokens }) });
		}
	}
}

function onTool(transcript: CodexTranscript, event: CodexToolEvent): void {
	transcript.tool(event);
	if (event.phase === "start") write({ type: "tool_execution_start", toolCallId: event.id, toolName: event.name, args: event.args ?? {} });
	else write({ type: "tool_execution_end", toolCallId: event.id, toolName: event.name, isError: event.isError === true });
}

/** `lockdown` for every picp refusal or kill; `auth` for a sign-in refusal; none for a clean run. */
function stopOf(result: CodexSpikeResult | undefined, cli: string | undefined): "lockdown" | "auth" | undefined {
	if (cli === "auth") return "auth";
	if (cli !== undefined) return "lockdown";
	if (result === undefined) return undefined;
	return result.lockdown?.verdict !== "ok" || result.hookFailed || result.bypass !== undefined ? "lockdown" : undefined;
}

/** One turn; 0 once a report was accepted (then the worker waits for stdin end), 1 otherwise. */
async function serve(prompt: string): Promise<number> {
	write({ type: "agent_start" });
	const [runDir, worktree, artifactPath] = [env.CP_RUN_DIR, env.CP_WORKTREE, env.CP_ARTIFACT_PATH];
	if (env.CP_KIND !== "research" || env.CP_ROLE !== "planner") throw new Error(`the Codex CLI runs research/planner jobs only in C1b, not ${env.CP_KIND}/${env.CP_ROLE}`);
	if (!env.CP_JOB_ID || !runDir || !worktree || !artifactPath) throw new Error("Codex CLI worker started without its job identity");
	const model = env.CP_CODEX_MODEL ?? "codex";
	const routed = env.CP_CODEX_MODEL ? { model: env.CP_CODEX_MODEL } : {};
	const systemPrompt = readSystemPrompt();
	const session = freshSession(worktree);
	const transcript = codexTranscript(nativeTranscriptFile(runDir, jobId), { id: jobId, cwd: worktree }, model);
	write({ type: "native_transcript", transcript_file: transcript.file });
	transcript.prompt(prompt);
	let result: CodexSpikeResult | undefined;
	let cli: string | undefined;
	let error: string | undefined;
	try {
		result = await runCodexSpike({
			job: { job_id: jobId, kind: "research", role: "planner", delivery: env.CP_DELIVERY as Delivery, runDir, worktree, artifactPath },
			prompt, ...routed, systemPrompt, hostEnv: env, timeoutMs: RUN_TIMEOUT_MS, signal: abort.signal, scratchDir: session.scratch_dir,
			...(env.CP_CODEX_HOME ? { codexHome: env.CP_CODEX_HOME } : {}), ...(env.CP_NATIVE_THINKING ? { effort: env.CP_NATIVE_THINKING } : {}),
			onMessage: (method, params) => onMessage(session, transcript, method, params),
			onTool: (event) => onTool(transcript, event),
		});
		error = result.error;
	} catch (err) {
		cli = (err as { cli?: string }).cli ?? "other";
		error = (err as Error).message;
	}
	const usage: CodexRunUsage = result?.usage ?? { status: "unavailable", reason: "the run did not start", cost_unknown: true };
	if (usage.status === "complete") {
		write({ type: "message_end", message: { role: "assistant", model, usage: piUsage(usage) }, usage_status: "complete", cost_unknown: true });
	} else {
		write({ type: "message_update", usage: piUsage({ input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 }) });
		write({ type: "usage_unavailable", status: usage.status });
	}
	const stop = stopOf(result, cli === "other" ? undefined : cli);
	const reported = result?.report !== undefined;
	write({
		type: "native_run", run: randomUUID(), driver: "codex", resumed: false, codex_version: result?.codexVersion ?? null, lockdown: result?.lockdown?.verdict ?? "unchecked",
		seen: result?.lockdown?.seen, extra: result?.lockdown?.extra, exit_code: result?.exit?.code ?? null, outcome: result?.outcome ?? "refused", report: reported,
		usage: usage.status === "complete" ? "measured" : "unavailable", usage_status: usage.status, cost_unknown: true,
		denials: result?.denials.length ?? 0, denied: nativeDenials(result?.denials ?? []), report_refusals: result?.reportRefusals.length ?? 0,
		hook_failed: result?.hookFailed ?? false, ...(result?.bypass ? { bypass: result.bypass } : {}), ...(stop ? { stop } : {}),
	});
	say(`outcome ${result?.outcome ?? "refused"}; lockdown ${result?.lockdown?.verdict ?? "unchecked"}; report ${reported ? "accepted" : "none"}${error ? `; ${error}` : ""}`);
	if (!reported) return 1;
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
	if (request.type === "get_state") return reply({ success: true, data: { sessionId: jobId, sessionFile } });
	if (request.type === "prompt" && typeof request.message === "string" && run === undefined) {
		reply({ success: true, data: { disposition: "started" } });
		run = serve(request.message).catch((error: unknown) => {
			say(`refused: ${(error as Error).message}`);
			return 1;
		});
		void run.then((code) => (code === 0 ? undefined : process.exit(code)));
		return;
	}
	const door = request.type === "prompt" ? "a second prompt" : String(request.type);
	reply({ success: false, error: codexDoorRefusal(jobId, door) });
}

/** Stdin end or SIGTERM aborts a live run; the exit waits for the run's own stop sequence (scope kill included). */
async function stop(): Promise<void> {
	abort.abort();
	process.exit(run === undefined ? 0 : await run);
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => void stop());
process.on("SIGTERM", () => void stop());
