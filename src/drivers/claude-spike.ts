/**
 * Native worker run core (N2 spike, production since N3b): one isolated Claude research-role run through the official
 * Agent SDK `query()` on the user's installed `claude`. src/drivers/claude-worker.ts wraps it for dispatch.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createSdkMcpServer,
	type HookCallback,
	type HookJSONOutput,
	type Options,
	type Query,
	query,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
	type SpawnOptions,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { TurnTokenUsage } from "@t3tools/contracts";
import { z } from "zod";
import {
	type ClaudeModelLedger,
	claudeLedgerDelta,
	claudeModelLedger,
	normalizeClaudeTurnTokenUsage,
} from "../../vendor/t3code/ClaudeTurnTokenUsage.ts";
import { ENVELOPE_FILE, formatRejection, type JobContext, localChecks } from "../../extensions/worker-reporter/index.ts";
import { ciStatusQuery, ciStatusRepeatRefusal, ciWaitRefusal, detectCiWait, shellPatchCommand, shellPatchRefusal } from "../ci-wait.ts";
import {
	type Delivery,
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	type Envelope,
	type EnvelopeRecord,
	type GateReview,
	EnvelopeSchema,
	isoTimestamp,
	type JobKind,
	type Role,
	SCHEMA_VERSION,
	validateEnvelope,
	WORKER_FORBIDDEN_TOOLS,
} from "../contracts.ts";
import { ClaudeSpikeError, resolveClaude } from "./claude-cli.ts";
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
import { readOnlyBashRefusal, secretPathIn, secretPaths } from "./claude-bash-policy.ts";
import { forgeTools } from "./claude-forge-tools.ts";
import { FORGE_TOOL_NAMES, nativeRole, RESEARCH_TOOLS, reviewerReadGuard, roleMcpTools, roleTools, writeScopeGuard } from "./claude-roles.ts";
import { VERDICT_TOOL, type VerdictState, verdictServer } from "./claude-verdict.ts";
import { shipBashRefusal } from "./claude-ship-policy.ts";
import { type HooksListing, type Lockdown, lockdownVerdict } from "./claude-lockdown.ts";
import { assertNativeEffort } from "./claude.ts";

export { CLAUDE_VERSION_FLOOR, ClaudeSpikeError, claudeVersionRefusal, parseClaudeVersion, resolveClaude } from "./claude-cli.ts";

export const SPIKE_TOOLS: readonly string[] = RESEARCH_TOOLS;
export const REPORT_TOOL = "mcp__picp__report_result";
const HOST_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
const EXIT_GRACE_MS = 10_000;
/**
 * Policy settings for every child. disableAllHooks binds as managed-only hooks; an empty strictKnownMarketplaces stops
 * the headless reconcile installing the passed settings' enabledPlugins into the kept scratch for the next process.
 */
export const CHILD_MANAGED_SETTINGS = { disableAllHooks: true, strictKnownMarketplaces: [] } satisfies Options["managedSettings"];

/** A routed thinking level as SDK options: off disables thinking, low…max is `effort`, absent is the CLI default. */
export function nativeEffortOptions(level: string | undefined): Pick<Options, "thinking" | "effort"> {
	assertNativeEffort(level);
	if (level === undefined || level === "") return {};
	return level === "off" ? { thinking: { type: "disabled" } } : { effort: level };
}

export interface SpikeJob {
	job_id: string;
	kind: JobKind;
	role: Role;
	delivery: Delivery;
	runDir: string;
	worktree: string;
	/** Research: the predeclared artifact, whose directory is its only Write scope. Implementer: its own
	 * `state/artifacts/<job id>/report.md`, whose directory is the one Write scope beside its worktree. */
	artifactPath?: string;
	/** Implementer only: grant and home `exclude_paths` no Edit/Write may touch, read by the worker process. */
	excludePaths?: readonly string[];
}

/** A Claude tool call in picp's worker-guard vocabulary (`bash` {command}, `read`/`write` {path}, …). */
export interface NormalizedCall {
	name: string;
	input: Record<string, unknown>;
}

export type SpikeGuard = (call: NormalizedCall) => string | undefined;

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
		CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
		CLAUDE_AGENT_SDK_CLIENT_APP: "picp-native-spike",
		...providerEnv,
	};
}

export function normalizeToolCall(toolName: string, input: unknown): NormalizedCall | undefined {
	const args = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (toolName === "Bash") return { name: "bash", input: { command: args.command } };
	if (toolName === "Read") return { name: "read", input: { path: args.file_path } };
	if (toolName === "Write") return { name: "write", input: { path: args.file_path } };
	if (toolName === "Edit") return { name: "edit", input: { path: args.file_path } };
	if (toolName === "Grep") return { name: "grep", input: { pattern: args.pattern, path: args.path } };
	if (toolName === "Glob") return { name: "find", input: { pattern: args.pattern, path: args.path } };
	if (toolName === REPORT_TOOL) return { name: "report_result", input: args };
	if (toolName === VERDICT_TOOL) return { name: "report_verdict", input: args };
	const forge = FORGE_TOOL_NAMES.find((name) => toolName === `mcp__picp__${name}`);
	if (forge !== undefined) return { name: forge, input: args };
	return undefined;
}

/**
 * picp's worker-reporter `tool_call` refusals, in the same order, plus the role's Bash and write scope and secret
 * paths.
 */
export function spikeGuards(
	job: SpikeJob,
	secrets: readonly string[] = secretPaths(null, [homedir(), userInfo().homedir]),
	role: Role = job.role,
): SpikeGuard[] {
	const native = nativeRole(role);
	const writeScope = writeScopeGuard(job, secrets, native);
	let ciStatusQueries = 0;
	const bash: SpikeGuard = (call) => {
		if (call.name !== "bash") return undefined;
		if (native === "reviewer") return "Refused: a reviewer has no Bash; it reads its scratch dir with Read, Grep and Glob.";
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
		if (native === "implementer") return shipBashRefusal(command, job.worktree, secrets, job.job_id, job.excludePaths);
		return readOnlyBashRefusal(command, job.worktree, secrets);
	};
	return [
		(call) => (WORKER_FORBIDDEN_TOOLS.includes(call.name) ? `${call.name} is a parent-only tool.` : undefined),
		bash,
		writeScope,
		...(native === "reviewer" ? [reviewerReadGuard(job)] : []),
		(call) => {
			const paths = call.name === "find" ? [call.input.path, call.input.pattern] : call.name === "read" || call.name === "grep" ? [call.input.path] : [];
			const secret = paths.find((path) => typeof path === "string" && secretPathIn(path, job.worktree, secrets));
			const who = { research: "a research worker", implementer: "an implementer", reviewer: "a reviewer" }[native];
			return secret === undefined ? undefined : `Refused: ${who} never reads the Claude settings, its config, /proc or /dev/fd (${String(secret)}).`;
		},
		(call) => workerHostGuard(call.name, call.input, job.runDir),
	];
}

const deny = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** The PreToolUse hook: nothing runs before `ready` settles clean (the lockdown); then the tool set and every guard. */
export function preToolUseHook(
	guards: readonly SpikeGuard[],
	onDeny: (tool: string, reason: string) => void = () => {},
	ready: Promise<string | undefined> = Promise.resolve(undefined),
): HookCallback {
	return async (input) => {
		if (input.hook_event_name !== "PreToolUse") return {};
		let reason: string | undefined = await ready;
		if (reason !== undefined) {
			onDeny(input.tool_name, reason);
			return deny(reason);
		}
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

export const STOP_REPORT_REASON =
	"You are ending the turn without an accepted report_result, and no background task of yours is running. Call " +
	'report_result now: status "done" if the work is complete, or "blocked" with concrete blockers if it is not.';

/** The Stop hook: an unreported stop with no live background task is blocked once per run, never in a loop. */
export function stopHook(reported: () => boolean, liveTasks: () => number): HookCallback {
	let blocked = false;
	return async (input) => {
		if (input.hook_event_name !== "Stop" || blocked || reported()) return {};
		if ((input.background_tasks?.length ?? 0) > 0 || liveTasks() > 0) return {};
		blocked = true;
		return { decision: "block", reason: STOP_REPORT_REASON };
	};
}

interface ReportState extends VerdictState {
	accepted?: Envelope;
	attempts: number;
}

/** picp's `report_result` as an in-process SDK MCP tool: validated, written once, wrong-job refused. */
function reportServer(job: SpikeJob, state: ReportState, extra: ReturnType<typeof forgeTools> = []) {
	const context: JobContext = {
		job_id: job.job_id,
		kind: job.kind,
		delivery: job.delivery,
		role: job.role,
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
	// The one artifact an implementer's Write guard admits outside its worktree: details go there, never in the summary.
	const artifact = job.kind === "ship" && job.artifactPath
		? ` Details go in your own artifact ${job.artifactPath}, written with Write (no other path outside your worktree is writable); name it as artifact_path.`
		: "";
	const report = tool(
		"report_result",
		`Finish this job by reporting the envelope (job_id, kind, status, summary, artifact_path, plan_summary). Call it once.${artifact}`,
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
	return createSdkMcpServer({ name: "picp", version: "0.0.0", tools: [report, ...extra] });
}

export interface SpikeRunOptions {
	job: SpikeJob;
	prompt: string;
	/** Explicit provider variables for the child (a fake model's base URL and synthetic token). */
	providerEnv?: Record<string, string>;
	/** The operator's Claude settings path, which claude itself reads and picp never opens; null passes none. */
	userSettings?: string | null;
	model?: string;
	/** The role contract as the SDK system prompt (a string replaces the CLI default); absent runs without one. */
	systemPrompt?: string;
	/** The routed thinking level (`nativeEffortOptions`); absent leaves the CLI's default effort. */
	thinking?: string;
	maxTurns?: number;
	tools?: readonly string[];
	extraGuards?: readonly SpikeGuard[];
	hostEnv?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Aborting it interrupts the run: the child is stopped and its observed exit reported. */
	signal?: AbortSignal;
	/** Sees every SDK message as it arrives (the native worker's event stream); a throw here is swallowed. */
	onMessage?: (message: SDKMessage) => void;
	/** Caller-owned scratch outside the worktree, kept so a later run can resume; the caller removes it. */
	scratchDir?: string;
	/** Resume this session; `ledger` is the previous run's, so the resumed process's restored totals are not recounted. */
	resume?: { sessionId: string; ledger?: ClaudeModelLedger };
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
	/** The env keys (never values) the child was spawned with, sorted. */
	spawnedEnvKeys?: string[];
	/** Undefined only when no child was spawned. */
	exit?: SpikeExit;
	report?: Envelope;
	/** A native reviewer's accepted `report_verdict` (N4h), already filed in the run dir. */
	verdict?: GateReview;
	reportRefusals: string[];
	denials: Array<{ tool: string; reason: string }>;
	resultSubtype?: string;
	initModel?: string;
	sessionId?: string;
	/** This process's per-model totals; pass it as `resume.ledger` to the run that resumes this session. */
	ledger?: ClaudeModelLedger;
	lockdown?: Lockdown;
	usage: TurnTokenUsage;
	coldStartMs?: number;
	durationMs: number;
	error?: string;
}

/**
 * One query's usage through T3's normalizer: unknown stays `unavailable`, never 0; the ledger adds subagent work.
 * `previous` is the ledger this process started from: empty for a fresh run, the prior run's on a resume, else unknown.
 */
export function spikeUsage(result: SDKResultMessage | undefined, rootModels: ReadonlySet<string>, previous: ClaudeModelLedger | undefined): TurnTokenUsage {
	const ledger = claudeLedgerDelta(previous, claudeModelLedger(result?.modelUsage));
	const terminal = result?.subtype === "success" ? "completed" : "failed";
	return normalizeClaudeTurnTokenUsage(result, false, terminal, [], { rootModels, ledger });
}

/** One isolated research run; its own scratch dir (config, sessions, HOME, TMPDIR) is removed before returning. */
export async function runClaudeSpike(options: SpikeRunOptions): Promise<SpikeResult> {
	const hostEnv = options.hostEnv ?? process.env;
	const claude = resolveClaude(hostEnv);
	assertBriefIsSafe(options.prompt, "spike prompt");
	const scratch = options.scratchDir ?? mkdtempSync(join(tmpdir(), "cp-claude-spike-"));
	try {
		return await runInScratch(options, claude, hostEnv, scratch);
	} finally {
		if (options.scratchDir === undefined) rmSync(scratch, { recursive: true, force: true });
	}
}

/** Runs the lockdown on one init with the CLI's commands, agents and hook listing, read over the control channel. */
async function checkSurface(q: Query, init: Parameters<typeof lockdownVerdict>[0], expectedTools: readonly string[]): Promise<Lockdown> {
	const started = Date.now();
	try {
		// SAFETY: getHooksListing exists only on newer SDKs; it is optional here and its absence is handled below.
		const listing = (q as unknown as { getHooksListing?: () => Promise<HooksListing> }).getHooksListing;
		const [initialized, hooks] = await Promise.all([q.initializationResult(), listing === undefined ? undefined : listing.call(q)]);
		return { ...lockdownVerdict(init, expectedTools, initialized.commands, initialized.agents ?? [], hooks), checkMs: Date.now() - started };
	} catch (err) {
		return { verdict: "refused", refusal: `Refused: the Claude CLI lockdown check failed (${(err as Error).message}).`, checkMs: Date.now() - started };
	}
}

async function runInScratch(
	options: SpikeRunOptions,
	claude: { path: string; version: string },
	hostEnv: NodeJS.ProcessEnv,
	scratch: string,
): Promise<SpikeResult> {
	if (!relative(resolve(options.job.worktree), scratch).startsWith("..")) throw new ClaudeSpikeError("scratch dir is inside the worktree");
	const dirs = { home: join(scratch, "home"), configDir: join(scratch, "config"), tmp: join(scratch, "tmp") };
	const settingsPath = options.userSettings === undefined ? join(homedir(), ".claude", "settings.json") : options.userSettings;
	const secrets = secretPaths(settingsPath, [homedir(), userInfo().homedir]);
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const state: ReportState = { refusals: [], attempts: 0 };
	const tools = options.tools ?? roleTools(options.job.role);
	const native = nativeRole(options.job.role);
	// The lockdown expects the role's MCP surface: a reviewer's server holds report_verdict alone.
	const mcpTools = native === "reviewer" ? [VERDICT_TOOL] : [REPORT_TOOL, ...roleMcpTools(options.job.role)];
	const forge = native === "implementer" ? forgeTools(options.job, hostEnv) : [];
	const denials: SpikeResult["denials"] = [];
	const models = new Set<string>();
	let child: ChildProcess | undefined;
	let spawnedCommand: string | undefined;
	let spawnedEnvKeys: string[] | undefined;
	let exited: Promise<Omit<SpikeExit, "killedByDriver">> | undefined;
	let result: SDKResultMessage | undefined;
	let initModel: string | undefined;
	let sessionId: string | undefined;
	let coldStartMs: number | undefined;
	let error: string | undefined;
	let checking: Promise<Lockdown> | undefined;
	let release: (refusal: string | undefined) => void = () => {};
	const ready = new Promise<string | undefined>((done) => (release = done));
	const started = Date.now();
	const abort = new AbortController();
	// AbortSignal.timeout is unref'd, so nothing is left to clear or leak whichever way the run ends.
	for (const signal of [AbortSignal.timeout(options.timeoutMs ?? 180_000), options.signal]) {
		if (signal?.aborted) abort.abort();
		signal?.addEventListener("abort", () => abort.abort(), { once: true });
	}
	// Input stays open until a result lands with no background task live: a closed stdin leaves the CLI's woken turn
	// with no hook or permission channel, and every tool call then gets Claude Code's "wait for the user" denial.
	let liveTasks = new Set<string>();
	let settle: () => void = () => {};
	const settled = new Promise<void>((done) => (settle = done));
	abort.signal.addEventListener("abort", () => settle(), { once: true });
	async function* input(): AsyncGenerator<SDKUserMessage> {
		yield { type: "user", message: { role: "user", content: options.prompt }, parent_tool_use_id: null };
		await settled;
	}
	const finish = native === "reviewer" ? "report_verdict" : "report_result";
	const canUseTool: Options["canUseTool"] = async (toolName, _input, context) => {
		const why = [context.blockedPath, context.decisionReason].filter(Boolean).join("; ");
		const reason = `Refused: Claude Code's permission check holds ${toolName}${why ? ` (${why})` : ""}. Continue the task another way, or call ${finish} if you are blocked.`;
		denials.push({ tool: toolName, reason });
		return { behavior: "deny", message: reason };
	};
	const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions) => {
		spawnedCommand = spawnOptions.command;
		spawnedEnvKeys = Object.keys(spawnOptions.env).filter((key) => spawnOptions.env[key] !== undefined).sort();
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
		...(settingsPath === null ? {} : { settings: settingsPath }),
		// Binds as allowManagedHooksOnly: settings-file and project hooks never run; picp's SDK callback still does.
		managedSettings: CHILD_MANAGED_SETTINGS,
		strictMcpConfig: true,
		mcpServers: { picp: native === "reviewer" ? verdictServer(options.job, state) : reportServer(options.job, state, forge) },
		tools: [...tools],
		// No bare allow rules: they shadow canUseTool, and the PreToolUse hook already allows every guarded call.
		disallowedTools: ["Agent", "Task", "WebFetch", "WebSearch"],
		agents: {},
		plugins: [],
		skills: [],
		permissionMode: "default",
		canUseTool,
		hooks: {
			PreToolUse: [
				{ hooks: [preToolUseHook([...spikeGuards(options.job, secrets), ...(options.extraGuards ?? [])], (tool, reason) => denials.push({ tool, reason }), ready)], onFailure: "block" },
			],
			// A report already on file (an earlier run's) is one this run cannot replace: nothing to ask for.
			...(native === "reviewer" ? {} : { Stop: [{ hooks: [stopHook(() => state.accepted !== undefined || existsSync(join(options.job.runDir, ENVELOPE_FILE)), () => liveTasks.size)] }] }),
		},
		maxTurns: options.maxTurns ?? 12,
		abortController: abort,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
		...nativeEffortOptions(options.thinking),
		...(options.resume === undefined ? {} : { resume: options.resume.sessionId }),
	};
	const expectedTools = [...tools, ...mcpTools];
	try {
		const q = query({ prompt: input(), options: sdkOptions });
		for await (const message of q) {
			try {
				options.onMessage?.(message);
			} catch {
				// An observer must never end the run.
			}
			if (message.type === "system" && message.subtype === "init" && checking === undefined) {
				initModel = message.model;
				sessionId = message.session_id;
				coldStartMs = Date.now() - started;
				checking = checkSurface(q, message, expectedTools).then((lockdown) => {
					if (lockdown.verdict === "refused") abort.abort();
					release(lockdown.refusal);
					return lockdown;
				});
			}
			if (message.type === "assistant" && message.parent_tool_use_id === null) models.add(message.message.model);
			if (message.type === "system" && message.subtype === "background_tasks_changed") liveTasks = new Set(message.tasks.map((task) => task.task_id));
			if (message.type === "result") {
				result = message;
				if (liveTasks.size === 0) settle();
			}
		}
	} catch (err) {
		error = (err as Error).message;
	} finally {
		settle();
	}
	release("Refused: the run ended before the lockdown check.");
	const lockdown = await checking;
	if (lockdown?.verdict === "refused") error = lockdown.refusal;
	const exit = await observeExit(child, exited);
	const ledger = claudeModelLedger(result?.modelUsage);
	return {
		claudePath: claude.path,
		claudeVersion: claude.version,
		sdkVersion: sdkVersion(),
		...(spawnedCommand === undefined ? {} : { spawnedCommand }),
		...(spawnedEnvKeys === undefined ? {} : { spawnedEnvKeys }),
		...(exit === undefined ? {} : { exit }),
		...(state.accepted === undefined ? {} : { report: state.accepted }),
		...(state.verdict === undefined ? {} : { verdict: state.verdict }),
		reportRefusals: state.refusals,
		denials,
		...(result === undefined ? {} : { resultSubtype: result.subtype }),
		...(initModel === undefined ? {} : { initModel }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(ledger === undefined ? {} : { ledger }),
		...(lockdown === undefined ? {} : { lockdown }),
		usage: spikeUsage(result, models, options.resume === undefined ? new Map() : options.resume.ledger),
		...(coldStartMs === undefined ? {} : { coldStartMs }),
		durationMs: Date.now() - started,
		...(error === undefined ? {} : { error }),
	};
}

/** Waits for the child's own exit; after the grace it kills and still reports the observed exit, never a guess. */
async function observeExit(child: ChildProcess | undefined, exited: Promise<Omit<SpikeExit, "killedByDriver">> | undefined): Promise<SpikeExit | undefined> {
	if (child === undefined || exited === undefined) return undefined;
	const first = await Promise.race([exited, sleep(EXIT_GRACE_MS, undefined, { ref: false })]);
	if (first !== undefined) return { ...first, killedByDriver: false };
	child.kill("SIGKILL");
	return { ...(await exited), killedByDriver: true };
}
