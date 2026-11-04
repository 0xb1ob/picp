/**
 * Native worker spike (N2 step 1): one isolated Claude research-role run through the official Agent SDK `query()`,
 * on the user's installed `claude`. Not wired into dispatch, send, revive, routing or the fleet; pi stays the runtime.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createSdkMcpServer,
	type HookCallback,
	type HookJSONOutput,
	type Options,
	query,
	type SDKResultMessage,
	type SpawnOptions,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { TurnTokenUsage } from "@t3tools/contracts";
import { z } from "zod";
import { claudeLedgerDelta, claudeModelLedger, normalizeClaudeTurnTokenUsage } from "../../vendor/t3code/ClaudeTurnTokenUsage.ts";
import { ENVELOPE_FILE, formatRejection, type JobContext, localChecks } from "../../extensions/worker-reporter/index.ts";
import { ciStatusQuery, ciStatusRepeatRefusal, ciWaitRefusal, detectCiWait, shellPatchCommand, shellPatchRefusal } from "../ci-wait.ts";
import {
	type Delivery,
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	type Envelope,
	type EnvelopeRecord,
	EnvelopeSchema,
	isoTimestamp,
	SCHEMA_VERSION,
	validateEnvelope,
	WORKER_FORBIDDEN_TOOLS,
} from "../contracts.ts";
import { whichAll } from "../doctor.ts";
import {
	credentialSearchRefusal,
	detectCredentialSearch,
	detectGhAuthStatus,
	detectHomeBulkCopy,
	detectHostAuthCopy,
	ghAuthStatusRefusal,
	homeBulkCopyRefusal,
	hostAuthCopyRefusal,
} from "../worker-credential-guard.ts";
import { detectWorkerHistoryRewrite, workerHistoryRefusal } from "../worker-history-guard.ts";
import { workerHostGuard } from "../worker-host-guard.ts";
import { assertBriefIsSafe } from "../worker-manager.ts";
import { detectWorkerMerge, workerMergeRefusal } from "../worker-merge-guard.ts";

/** The lowest `claude --version` this spike measured working (docs/native-drivers.md "Spike result"). */
export const CLAUDE_VERSION_FLOOR = "2.1.318";
export const SPIKE_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash", "Write"];
export const REPORT_TOOL = "mcp__picp__report_result";
const HOST_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
const EXIT_GRACE_MS = 10_000;

export class ClaudeSpikeError extends Error {}

export interface SpikeJob {
	job_id: string;
	delivery: Delivery;
	runDir: string;
	worktree: string;
	/** Predeclared research artifact; its directory is the only place Write may touch. */
	artifactPath: string;
}

/** A Claude tool call in picp's worker-guard vocabulary (`bash` {command}, `read`/`write` {path}, …). */
export interface NormalizedCall {
	name: string;
	input: Record<string, unknown>;
}

export type SpikeGuard = (call: NormalizedCall) => string | undefined;

export function parseClaudeVersion(output: string): string | undefined {
	return /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Undefined when `version` meets `floor`; otherwise the refusal naming the remedy. No auto-update. */
export function claudeVersionRefusal(version: string | undefined, floor = CLAUDE_VERSION_FLOOR): string | undefined {
	if (version === undefined) return "claude --version printed no version: reinstall Claude Code, then run `claude update`";
	const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
	const cmp = (a ?? []).map((n, i) => n - ((b ?? [])[i] ?? 0)).find((d) => d !== 0) ?? 0;
	return cmp < 0 ? `claude ${version} is below the native driver floor ${floor}: run \`claude update\`` : undefined;
}

/** The first `claude` on PATH and its version; throws with a named remedy when missing or too old. */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): { path: string; version: string } {
	const path = whichAll("claude", env)[0];
	if (path === undefined) throw new ClaudeSpikeError("claude is not on PATH: install Claude Code, then run `claude update`");
	let raw = "";
	try {
		raw = execFileSync(path, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "" }, stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		throw new ClaudeSpikeError(`${path} --version failed (${(error as Error).message}): run \`claude update\``);
	}
	const version = parseClaudeVersion(raw);
	const refusal = claudeVersionRefusal(version);
	if (refusal !== undefined || version === undefined) throw new ClaudeSpikeError(refusal);
	return { path, version };
}

/** The installed SDK's version, or "unknown" when its package.json cannot be read. */
export function sdkVersion(): string {
	try {
		const pkg = new URL("package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
		return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
	} catch {
		return "unknown";
	}
}

/** The child env, built from an allow-list: no host ANTHROPIC_*, CLAUDE_* or settings variable passes. */
export function buildChildEnv(
	dirs: { home: string; configDir: string; tmp: string },
	hostEnv: NodeJS.ProcessEnv,
	providerEnv: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of HOST_ENV_ALLOW) {
		const value = hostEnv[key];
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		HOME: dirs.home,
		CLAUDE_CONFIG_DIR: dirs.configDir,
		TMPDIR: dirs.tmp,
		DISABLE_AUTOUPDATER: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_AGENT_SDK_CLIENT_APP: "picp-native-spike",
		...providerEnv,
	};
}

export function normalizeToolCall(toolName: string, input: unknown): NormalizedCall | undefined {
	const args = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (toolName === "Bash") return { name: "bash", input: { command: args.command } };
	if (toolName === "Read") return { name: "read", input: { path: args.file_path } };
	if (toolName === "Write") return { name: "write", input: { path: args.file_path } };
	if (toolName === "Grep") return { name: "grep", input: { pattern: args.pattern, path: args.path } };
	if (toolName === "Glob") return { name: "find", input: { pattern: args.pattern, path: args.path } };
	if (toolName === REPORT_TOOL) return { name: "report_result", input: args };
	return undefined;
}

/** picp's worker-reporter `tool_call` refusals, in the same order, plus the research write scope. */
export function spikeGuards(job: SpikeJob): SpikeGuard[] {
	let ciStatusQueries = 0;
	const writeRoot = dirname(resolve(job.artifactPath));
	const bash: SpikeGuard = (call) => {
		if (call.name !== "bash") return undefined;
		const command = call.input.command;
		if (typeof command !== "string") return "Refused: bash needs a string command.";
		const ci = detectCiWait(command);
		if (ci) return ciWaitRefusal(ci);
		const merge = detectWorkerMerge(command);
		if (merge) return workerMergeRefusal(merge);
		const rewrite = detectWorkerHistoryRewrite(command);
		if (rewrite) return workerHistoryRefusal(rewrite);
		const authCopy = detectHostAuthCopy(command);
		if (authCopy) return hostAuthCopyRefusal(authCopy);
		const homeCopy = detectHomeBulkCopy(command);
		if (homeCopy) return homeBulkCopyRefusal(homeCopy);
		const ghAuth = detectGhAuthStatus(command);
		if (ghAuth) return ghAuthStatusRefusal(ghAuth);
		const keySearch = detectCredentialSearch(command);
		if (keySearch) return credentialSearchRefusal(keySearch);
		if (shellPatchCommand(command)) return shellPatchRefusal();
		if (ciStatusQuery(command) && ciStatusQueries++ >= 1) return ciStatusRepeatRefusal();
		return undefined;
	};
	const writeScope: SpikeGuard = (call) => {
		if (call.name !== "write") return undefined;
		const path = call.input.path;
		const rel = typeof path === "string" ? relative(writeRoot, resolve(job.worktree, path)) : "..";
		const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
		return inside ? undefined : `Refused: a research worker writes only its artifact directory ${writeRoot} (got ${String(path)}).`;
	};
	return [
		(call) => (WORKER_FORBIDDEN_TOOLS.includes(call.name) ? `${call.name} is a parent-only tool.` : undefined),
		bash,
		writeScope,
		(call) => workerHostGuard(call.name, call.input, job.runDir),
	];
}

const deny = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** The PreToolUse hook: deny-by-default tool set, then every guard; a guard that throws is a deny. */
export function preToolUseHook(guards: readonly SpikeGuard[], onDeny: (tool: string, reason: string) => void = () => {}): HookCallback {
	return async (input) => {
		if (input.hook_event_name !== "PreToolUse") return {};
		let reason: string | undefined;
		try {
			const call = normalizeToolCall(input.tool_name, input.tool_input);
			reason = call === undefined ? `Refused: ${input.tool_name} is not in the spike's tool set.` : undefined;
			for (const guard of call === undefined ? [] : guards) {
				reason = guard(call as NormalizedCall);
				if (reason !== undefined) break;
			}
		} catch (error) {
			reason = `Refused: a guard failed (${(error as Error).message}); a guard that cannot decide denies.`;
		}
		if (reason === undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
		onDeny(input.tool_name, reason);
		return deny(reason);
	};
}

interface ReportState {
	accepted?: Envelope;
	refusals: string[];
	attempts: number;
}

/** picp's `report_result` as an in-process SDK MCP tool: validated, written once, wrong-job refused. */
function reportServer(job: SpikeJob, state: ReportState) {
	const context: JobContext = {
		job_id: job.job_id,
		kind: "research",
		delivery: job.delivery,
		role: "planner",
		runDir: job.runDir,
		worktree: job.worktree,
		artifactPath: job.artifactPath,
		mayAskOperator: false,
	};
	const recordFile = join(job.runDir, ENVELOPE_FILE);
	const shape = Object.fromEntries(Object.keys(EnvelopeSchema.properties).map((key) => [key, z.any().optional()]));
	const text = (value: string, isError: boolean) => ({ content: [{ type: "text" as const, text: value }], isError });
	const refuse = (value: string) => {
		state.refusals.push(value);
		return text(value, true);
	};
	const report = tool(
		"report_result",
		"Finish this job by reporting the envelope (job_id, kind, status, summary, artifact_path, plan_summary). Call it once.",
		shape,
		async (args) => {
			state.attempts += 1;
			const left = Math.max(0, ENVELOPE_REPAIR_MAX_ATTEMPTS - state.attempts);
			const checked = validateEnvelope(args, context);
			const errors = checked.ok ? localChecks(checked.value, context) : checked.errors;
			if (!checked.ok || errors.length > 0) return refuse(formatRejection(errors, state.attempts, left, "report_result"));
			if (existsSync(recordFile)) {
				let filed: unknown;
				try {
					filed = (JSON.parse(readFileSync(recordFile, "utf8")) as EnvelopeRecord).envelope;
				} catch (err) {
					return refuse(`report_result: ${recordFile} exists but is unreadable (${(err as Error).message}); refused.`);
				}
				if (JSON.stringify(filed) === JSON.stringify(checked.value)) return text(`Already recorded (no-op): ${recordFile}`, false);
				return refuse(`report_result: your report was already filed at ${recordFile}; a different report is refused.`);
			}
			const record: EnvelopeRecord = {
				schema_version: SCHEMA_VERSION,
				job_id: job.job_id,
				received_at: isoTimestamp(),
				attempt: state.attempts,
				envelope: checked.value,
			};
			mkdirSync(job.runDir, { recursive: true });
			writeFileSync(`${recordFile}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
			renameSync(`${recordFile}.tmp`, recordFile);
			state.accepted = checked.value;
			return text(`Reported ${job.job_id}. Stop now.`, false);
		},
	);
	return createSdkMcpServer({ name: "picp", version: "0.0.0", tools: [report] });
}

export interface SpikeRunOptions {
	job: SpikeJob;
	prompt: string;
	/** Explicit provider variables for the child (a fake model's base URL and synthetic token). */
	providerEnv?: Record<string, string>;
	/** Live smoke only: a settings file path claude itself reads (the operator's login); never read here. */
	userSettings?: string;
	model?: string;
	maxTurns?: number;
	tools?: readonly string[];
	extraGuards?: readonly SpikeGuard[];
	hostEnv?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface SpikeExit {
	code: number | null;
	signal: string | null;
	/** The driver sent SIGKILL after the grace; the code/signal are still the observed ones. */
	killedByDriver: boolean;
	error?: string;
}

export interface SpikeResult {
	claudePath: string;
	claudeVersion: string;
	sdkVersion: string;
	/** What the SDK actually spawned; must be `claudePath`, never a bundled binary. */
	spawnedCommand?: string;
	/** Undefined only when no child was spawned. */
	exit?: SpikeExit;
	report?: Envelope;
	reportRefusals: string[];
	denials: Array<{ tool: string; reason: string }>;
	resultSubtype?: string;
	initModel?: string;
	usage: TurnTokenUsage;
	coldStartMs?: number;
	durationMs: number;
	error?: string;
}

/** One query's usage through T3's normalizer: unknown stays `unavailable`, never 0; the ledger adds subagent work. */
export function spikeUsage(result: SDKResultMessage | undefined, rootModels: ReadonlySet<string>): TurnTokenUsage {
	const ledger = claudeLedgerDelta(new Map(), claudeModelLedger(result?.modelUsage));
	const terminal = result?.subtype === "success" ? "completed" : "failed";
	return normalizeClaudeTurnTokenUsage(result, false, terminal, [], { rootModels, ledger });
}

/** One isolated research run; the scratch dir (config, sessions, HOME, TMPDIR) is removed before returning. */
export async function runClaudeSpike(options: SpikeRunOptions): Promise<SpikeResult> {
	const hostEnv = options.hostEnv ?? process.env;
	const claude = resolveClaude(hostEnv);
	assertBriefIsSafe(options.prompt, "spike prompt");
	const scratch = mkdtempSync(join(tmpdir(), "cp-claude-spike-"));
	if (!relative(resolve(options.job.worktree), scratch).startsWith("..")) {
		rmSync(scratch, { recursive: true, force: true });
		throw new ClaudeSpikeError("scratch dir is inside the worktree");
	}
	const dirs = { home: join(scratch, "home"), configDir: join(scratch, "config"), tmp: join(scratch, "tmp") };
	for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
	const state: ReportState = { refusals: [], attempts: 0 };
	const denials: SpikeResult["denials"] = [];
	const models = new Set<string>();
	let child: ChildProcess | undefined;
	let spawnedCommand: string | undefined;
	let exited: Promise<Omit<SpikeExit, "killedByDriver">> | undefined;
	let result: SDKResultMessage | undefined;
	let initModel: string | undefined;
	let coldStartMs: number | undefined;
	let error: string | undefined;
	const started = Date.now();
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 180_000);
	const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions) => {
		spawnedCommand = spawnOptions.command;
		const proc = spawn(spawnOptions.command, spawnOptions.args, {
			cwd: spawnOptions.cwd,
			env: spawnOptions.env,
			signal: spawnOptions.signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = proc;
		exited = new Promise((done) => {
			proc.once("exit", (code, signal) => done({ code, signal }));
			proc.once("error", (err) => done({ code: proc.exitCode, signal: proc.signalCode, error: err.message }));
		});
		proc.stderr.resume();
		return proc;
	};
	const sdkOptions: Options = {
		cwd: options.job.worktree,
		pathToClaudeCodeExecutable: claude.path,
		spawnClaudeCodeProcess,
		env: buildChildEnv(dirs, hostEnv, options.providerEnv),
		settingSources: [],
		...(options.userSettings === undefined ? {} : { settings: options.userSettings }),
		strictMcpConfig: true,
		mcpServers: { picp: reportServer(options.job, state) },
		tools: [...(options.tools ?? SPIKE_TOOLS)],
		allowedTools: [...(options.tools ?? SPIKE_TOOLS), REPORT_TOOL],
		disallowedTools: ["Agent", "Task", "WebFetch", "WebSearch"],
		agents: {},
		plugins: [],
		skills: [],
		permissionMode: "dontAsk",
		hooks: {
			PreToolUse: [
				{ hooks: [preToolUseHook([...spikeGuards(options.job), ...(options.extraGuards ?? [])], (tool, reason) => denials.push({ tool, reason }))], onFailure: "block" },
			],
		},
		maxTurns: options.maxTurns ?? 12,
		abortController: abort,
		...(options.model === undefined ? {} : { model: options.model }),
	};
	try {
		for await (const message of query({ prompt: options.prompt, options: sdkOptions })) {
			if (message.type === "system" && message.subtype === "init") {
				initModel = message.model;
				coldStartMs = Date.now() - started;
			}
			if (message.type === "assistant" && message.parent_tool_use_id === null) models.add(message.message.model);
			if (message.type === "result") result = message;
		}
	} catch (err) {
		error = (err as Error).message;
	} finally {
		clearTimeout(timer);
	}
	try {
		const exit = await observeExit(child, exited);
		return {
			claudePath: claude.path,
			claudeVersion: claude.version,
			sdkVersion: sdkVersion(),
			...(spawnedCommand === undefined ? {} : { spawnedCommand }),
			...(exit === undefined ? {} : { exit }),
			...(state.accepted === undefined ? {} : { report: state.accepted }),
			reportRefusals: state.refusals,
			denials,
			...(result === undefined ? {} : { resultSubtype: result.subtype }),
			...(initModel === undefined ? {} : { initModel }),
			usage: spikeUsage(result, models),
			...(coldStartMs === undefined ? {} : { coldStartMs }),
			durationMs: Date.now() - started,
			...(error === undefined ? {} : { error }),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Waits for the child's own exit; after the grace it kills and still reports the observed exit, never a guess. */
async function observeExit(child: ChildProcess | undefined, exited: Promise<Omit<SpikeExit, "killedByDriver">> | undefined): Promise<SpikeExit | undefined> {
	if (child === undefined || exited === undefined) return undefined;
	const first = await Promise.race([exited, sleep(EXIT_GRACE_MS, undefined, { ref: false })]);
	if (first !== undefined) return { ...first, killedByDriver: false };
	child.kill("SIGKILL");
	return { ...(await exited), killedByDriver: true };
}
