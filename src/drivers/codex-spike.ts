/**
 * Codex run core: one planner run on `codex app-server`, unwired. Gates: picp's hook, its ticket, `untrusted` approvals
 * and the kernel profile; a lockdown; a tripwire that kills on any unasked tool; usage from totals; a full stop.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ENVELOPE_FILE, formatRejection, type JobContext, localChecks } from "../../extensions/worker-reporter/index.ts";
import {
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	type Envelope,
	type EnvelopeRecord,
	EnvelopeSchema,
	isoTimestamp,
	SCHEMA_VERSION,
	validateEnvelope,
} from "../contracts.ts";
import { isPidAlive } from "../fleet.ts";
import { assertBriefIsSafe } from "../worker-manager.ts";
import { secretPaths } from "./claude-bash-policy.ts";
import { CodexSpikeError, codexLoginRefusal, defaultCodexHome, resolveCodex } from "./codex-cli.ts";
import { type CodexContainment, resolveCodexContainment } from "./codex-containment.ts";
import {
	buildCodexChildEnv,
	CODEX_PROFILE,
	codexGitDir,
	codexHookCommand,
	codexPermissionProfile,
	type CodexProfile,
	codexReleaseDir,
	codexSpawnArgs,
} from "./codex-launch.ts";
import { type CodexLockdown, codexLockdownVerdict } from "./codex-lockdown.ts";
import {
	CODEX_METHODS as M,
	type CommandApprovalParams,
	type ConfigReadResponse,
	type DynamicToolCallParams,
	type DynamicToolCallResponse,
	type ExperimentalFeature,
	type ExperimentalFeatureListResponse,
	type GetAccountResponse,
	type HookCompletedNotification,
	type HooksListResponse,
	type InitializeResponse,
	type ItemNotification,
	type ListMcpServerStatusResponse,
	type SkillsListResponse,
	type TerminalsListResponse,
	type ThreadStartedNotification,
	type ThreadStartResponse,
	type TokenUsageBreakdown,
	type TokenUsageUpdatedNotification,
	type Turn,
	type TurnCompletedNotification,
	type TurnStartResponse,
} from "./codex-protocol.ts";
import { type CodexRpc, type CodexRpcExit, spawnCodexRpc } from "./codex-rpc.ts";
import { type NormalizedCall, type SpikeGuard, type SpikeJob, spikeGuards } from "./native-guards.ts";

export { CODEX_BUILTIN_SKILLS, type CodexLockdown, codexLockdownVerdict } from "./codex-lockdown.ts";
export {
	buildCodexChildEnv,
	codexBareArgs,
	CODEX_HOOK_CLIENT,
	codexHookCommand,
	codexPermissionProfile,
	codexSpawnArgs,
	HOOK_TIMEOUT_SEC,
	SURFACE_FLAGS,
} from "./codex-launch.ts";

export const REPORT_TOOL = "report_result";
const EXIT_GRACE_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const PID_WAIT_MS = 2_000;
/** Item types of tools that never ask picp (E5); any of them, or another thread, kills the run. */
const UNGATED_ITEMS: readonly string[] = ["imageView", "subAgentActivity", "collabAgentToolCall", "mcpToolCall", "webSearch", "imageGeneration", "sleep"];

const CLIENT_INFO = { clientInfo: { name: "picp", version: "0.0.0" }, capabilities: { experimentalApi: true } };

async function initialize(rpc: CodexRpc): Promise<InitializeResponse> {
	const init = await rpc.request<InitializeResponse>(M.initialize, CLIENT_INFO);
	rpc.notify(M.initialized);
	return init;
}

/** Every page of `experimentalFeature/list`; a cursor that repeats ends the walk. */
async function listFeatures(rpc: CodexRpc): Promise<ExperimentalFeature[]> {
	const features: ExperimentalFeature[] = [];
	const cursors = new Set<string>();
	for (let cursor: string | undefined; ; ) {
		const page = await rpc.request<ExperimentalFeatureListResponse>(M.experimentalFeatureList, cursor === undefined ? {} : { cursor });
		features.push(...page.data);
		if (page.nextCursor == null || cursors.has(page.nextCursor)) return features;
		cursor = page.nextCursor;
		cursors.add(cursor);
	}
}

/** Ends an app-server: stdin close, then a grace, then SIGKILL of the own child; the observed exit either way. */
async function closeRpc(rpc: CodexRpc): Promise<CodexRpcExit & { killedByDriver: boolean }> {
	rpc.closeInput();
	const first = await Promise.race([rpc.exited, sleep(EXIT_GRACE_MS, undefined, { ref: false })]);
	if (first !== undefined) return { ...first, killedByDriver: false };
	rpc.kill("SIGKILL");
	return { ...(await rpc.exited), killedByDriver: true };
}

/** Phase 1 of the trust handshake: the key and hash the CLI lists for picp's one session-flags hook. */
export async function codexHookTrust(
	codex: string, args: readonly string[], cwd: string, env: Record<string, string>, containment: CodexContainment,
): Promise<{ key: string; currentHash: string }> {
	const rpc = spawnCodexRpc({ command: codex, args, cwd, env, containment });
	try {
		await initialize(rpc);
		const listed = await rpc.request<HooksListResponse>(M.hooksList, { cwds: [cwd] });
		const flagged = listed.data.flatMap((entry) => entry.hooks).filter((hook) => hook.source === "sessionFlags");
		if (flagged.length !== 1 || flagged[0] === undefined) throw new CodexSpikeError(`Refused: the CLI listed ${flagged.length} session-flag hooks; picp passed exactly one.`);
		return { key: flagged[0].key, currentHash: flagged[0].currentHash };
	} finally {
		await closeRpc(rpc);
	}
}

/** Closes the lexical gap for Codex: `$CODEX_HOME`, an `OPENAI_*`/`CODEX_*` variable, the home path or a `.codex` path. */
export function codexSecretGuard(codexHome: string): SpikeGuard {
	return (call) => {
		if (call.name !== "bash" || typeof call.input.command !== "string") return undefined;
		const command = call.input.command;
		const hit = /\$\{?(?:OPENAI|CODEX)_\w*/.exec(command)?.[0] ?? (command.includes(codexHome) ? codexHome : undefined) ?? /(?<![\w.-])\.codex(?![\w-])/.exec(command)?.[0];
		return hit === undefined ? undefined : `Refused: a native planner's Bash never touches the Codex home, its login or an OPENAI_/CODEX_ variable (${hit}).`;
	};
}

/** A Codex hook's tool in picp's guard vocabulary; any other name (apply_patch included) is refused by the caller. */
export function codexToolCall(toolName: string, toolInput: unknown): NormalizedCall | undefined {
	const args = (toolInput !== null && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
	if (toolName === "Bash") return { name: "bash", input: { command: args.command } };
	if (toolName === REPORT_TOOL) return { name: "report_result", input: args };
	return undefined;
}

export type CodexTokenTotals = Required<TokenUsageBreakdown>;
export type CodexRunUsage =
	| { status: "complete"; input: number; cache_read: number; cache_write: number; output: number; reasoning: number; total: number; cost_unknown: true }
	| { status: "unavailable"; reason: string; cost_unknown: true };

export const ZERO_TOTALS: CodexTokenTotals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const totals = (b: TokenUsageBreakdown): CodexTokenTotals => ({ ...b, cacheWriteInputTokens: b.cacheWriteInputTokens ?? 0 });

/** One run's usage: the latest cumulative total minus its baseline. Unknown is `unavailable`, never 0 (D3: no USD). */
export function codexRunUsage(baseline: CodexTokenTotals | undefined, latest: CodexTokenTotals | undefined): CodexRunUsage {
	if (baseline === undefined) return { status: "unavailable", reason: "no baseline for the resumed thread", cost_unknown: true };
	if (latest === undefined) return { status: "unavailable", reason: "the CLI sent no token usage", cost_unknown: true };
	const d = Object.fromEntries(Object.keys(ZERO_TOTALS).map((k) => [k, latest[k as keyof CodexTokenTotals] - baseline[k as keyof CodexTokenTotals]])) as CodexTokenTotals;
	if (Object.values(d).some((n) => n < 0)) return { status: "unavailable", reason: "the totals went backwards", cost_unknown: true };
	return {
		status: "complete", input: d.inputTokens - d.cachedInputTokens, cache_read: d.cachedInputTokens, cache_write: d.cacheWriteInputTokens,
		output: d.outputTokens, reasoning: d.reasoningOutputTokens, total: d.totalTokens, cost_unknown: true,
	};
}

export interface CodexSpikeOptions {
	/** Planner only in C0; another role throws. */
	job: SpikeJob;
	prompt: string;
	model?: string;
	effort?: string;
	systemPrompt?: string;
	/** Passed to the CLI as `CODEX_HOME`; picp never opens it. Default `<passwd home>/.codex`. */
	codexHome?: string;
	hostEnv?: NodeJS.ProcessEnv;
	childEnv?: Record<string, string | undefined>;
	extraGuards?: readonly SpikeGuard[];
	timeoutMs?: number;
	/** Aborting it runs the stop sequence: interrupt, terminate every reported process, close. */
	signal?: AbortSignal;
	onMessage?: (method: string, params: unknown) => void;
	/** Caller-owned scratch outside the worktree, kept for the caller to remove. */
	scratchDir?: string;
	surfaceFlags?: readonly string[];
	hookTimeoutSec?: number;
	hookClientTimeoutMs?: number;
	/** `baseline` is the previous run's `totals`; without it the CLI's replayed total is the baseline. */
	resume?: { threadId: string; baseline?: CodexTokenTotals };
	deleteThread?: boolean;
	/** The run's app-server pid, once its scope is up and it answered `initialize`. */
	onAppServer?: (pid: number) => void;
	/** Once per phase per shell or dynamic tool call the CLI reports; `end` carries `isError`. */
	onTool?: (event: CodexToolEvent) => void;
}

export interface CodexToolEvent { phase: "start" | "end"; id: string; name: string; args?: unknown; isError?: boolean }

export type CodexDenial = { tool: string; reason: string; layer: "hook" | "approval" | "tool_call" };
export interface CodexLeftover { processId: string; osPid?: number; terminated: boolean; gone: boolean }

export interface CodexSpikeResult {
	codexPath: string;
	codexVersion: string;
	spawnedCommand?: string;
	/** The env keys (never values) of the app-server child, sorted. */
	spawnedEnvKeys?: string[];
	exit?: CodexRpcExit & { killedByDriver: boolean };
	/** The protocol state, never the exit code: an exit without `turn/completed` is `stopped`. */
	outcome: "completed" | "interrupted" | "failed" | "stopped" | "refused";
	turnStatus?: Turn["status"];
	codexErrorInfo?: unknown;
	report?: Envelope;
	reportRefusals: string[];
	denials: CodexDenial[];
	ticketMatch: { id: number; payload: number; none: number };
	lockdown?: CodexLockdown;
	threadId?: string;
	/** This thread's latest cumulative totals; pass as `resume.baseline` to the run that resumes it. */
	totals?: CodexTokenTotals;
	usage: CodexRunUsage;
	leftovers: CodexLeftover[];
	hookFailed: boolean;
	/** The item type of a tool the CLI ran without asking picp; the run was killed on it. */
	bypass?: string;
	coldStartMs?: number;
	durationMs: number;
	error?: string;
}

/** One isolated planner run; its own scratch dir (HOME, TMPDIR, hook socket) is removed before returning. */
export async function runCodexSpike(options: CodexSpikeOptions): Promise<CodexSpikeResult> {
	if (options.job.role !== "planner") throw new CodexSpikeError(`the Codex spike runs the planner role only, not ${options.job.role}`);
	const hostEnv = options.hostEnv ?? process.env;
	const codex = resolveCodex(hostEnv);
	const containment = resolveCodexContainment(hostEnv);
	assertBriefIsSafe(options.prompt, "spike prompt");
	const scratch = options.scratchDir ?? mkdtempSync(join(tmpdir(), "cp-codex-spike-"));
	try {
		if (!relative(resolve(options.job.worktree), resolve(scratch)).startsWith("..")) throw new CodexSpikeError("scratch dir is inside the worktree");
		const dirs = { home: join(scratch, "home"), tmp: join(scratch, "tmp") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		const codexHome = options.codexHome ?? defaultCodexHome();
		const login = await codexLoginRefusal(codex.path, { codexHome, home: dirs.home, pathEnv: hostEnv.PATH ?? "" });
		if (login !== undefined) throw Object.assign(new CodexSpikeError(login), { cli: "auth" as const });
		const roots = {
			worktree: options.job.worktree, gitDir: codexGitDir(options.job.worktree), codexDir: codexReleaseDir(codex.path),
			artifactDir: options.job.artifactPath === undefined ? undefined : dirname(options.job.artifactPath), tmp: dirs.tmp,
		};
		return await new CodexRun(options, codex, hostEnv, codexHome, dirs, join(scratch, "hook.sock"), containment, codexPermissionProfile(roots)).run();
	} finally {
		if (options.scratchDir === undefined) rmSync(scratch, { recursive: true, force: true });
	}
}

interface Ticket { id: string; key: string }
const ticketKey = (tool: string, payload: unknown): string => `${tool}\0${typeof payload === "string" ? payload : JSON.stringify(payload ?? null)}`;
const text = (value: string, success: boolean): DynamicToolCallResponse => ({ contentItems: [{ type: "inputText", text: value }], success });

class CodexRun {
	private readonly started = Date.now();
	private readonly guards: SpikeGuard[];
	private readonly denials: CodexDenial[] = [];
	private readonly refusals: string[] = [];
	private readonly tickets: Ticket[] = [];
	private readonly ticketMatch = { id: 0, payload: 0, none: 0 };
	private readonly usages: Array<{ turnId: string; total: CodexTokenTotals }> = [];
	private readonly known = new Map<string, number | undefined>();
	private readonly acceptedItems = new Set<string>();
	private readonly hookDenied = new Set<string>();
	private readonly toolPhase = new Map<string, "start" | "end">();
	private ready = false;
	private hookFailed = false;
	private bypass?: string;
	private accepted?: Envelope;
	private attempts = 0;
	private rpc?: CodexRpc;
	private threadId?: string;
	private turnId?: string;
	private turn?: Turn;
	private turnDone: () => void = () => {};

	private readonly options: CodexSpikeOptions;
	private readonly codex: { path: string; version: string };
	private readonly hostEnv: NodeJS.ProcessEnv;
	private readonly codexHome: string;
	private readonly dirs: { home: string; tmp: string };
	private readonly socket: string;
	private readonly containment: CodexContainment;
	private readonly profile: CodexProfile;

	constructor(
		options: CodexSpikeOptions, codex: { path: string; version: string }, hostEnv: NodeJS.ProcessEnv, codexHome: string,
		dirs: { home: string; tmp: string }, socket: string, containment: CodexContainment, profile: CodexProfile,
	) {
		[this.options, this.codex, this.hostEnv, this.codexHome, this.dirs, this.socket] = [options, codex, hostEnv, codexHome, dirs, socket];
		[this.containment, this.profile] = [containment, profile];
		const job = { ...options.job, tmp: dirs.tmp };
		const secrets = [...secretPaths(null, [userInfo().homedir]), resolve(codexHome)];
		this.guards = [...spikeGuards(job, secrets, "planner", false), codexSecretGuard(resolve(codexHome)), ...(options.extraGuards ?? [])];
	}

	private guard(call: NormalizedCall): string | undefined {
		try {
			for (const each of this.guards) {
				const reason = each(call);
				if (reason !== undefined) return reason;
			}
			return undefined;
		} catch (error) {
			return `Refused: a guard failed (${(error as Error).message}); a guard that cannot decide denies.`;
		}
	}

	private deny(tool: string, reason: string, layer: CodexDenial["layer"]): string {
		this.denials.push({ tool, reason, layer });
		return reason;
	}

	/** Consumes the hook's allow for this call, by id first, then by tool and payload. */
	private take(id: string, key: string): boolean {
		let at = this.tickets.findIndex((ticket) => ticket.id !== "" && ticket.id === id);
		const by = at >= 0 ? "id" : "payload";
		if (at < 0) at = this.tickets.findIndex((ticket) => ticket.key === key);
		if (at < 0) {
			this.ticketMatch.none++;
			return false;
		}
		this.tickets.splice(at, 1);
		this.ticketMatch[by]++;
		return true;
	}

	private closed(): string | undefined {
		if (!this.ready) return "Refused: picp's lockdown has not passed; no tool runs before it does.";
		if (this.hookFailed) return "Refused: picp's hook failed in this run, so there is no hook verdict; nothing more runs.";
		return undefined;
	}

	/** The hook socket's verdict: deny unless the lockdown passed, no hook failed, and every guard allows. */
	private hookVerdict(hook: Record<string, unknown>): { decision: "allow" } | { decision: "deny"; reason: string } {
		const tool = String(hook.tool_name ?? "");
		const call = codexToolCall(tool, hook.tool_input);
		const reason = this.closed() ?? this.cwdRefusal(hook.cwd) ?? (call === undefined ? `Refused: ${tool} is not in the Codex spike's tool set.` : this.guard(call));
		if (reason !== undefined) {
			this.hookDenied.add(String(hook.tool_use_id ?? ""));
			return { decision: "deny", reason: this.deny(tool, reason, "hook") };
		}
		const payload = call?.name === "bash" ? call.input.command : call?.input;
		this.tickets.push({ id: String(hook.tool_use_id ?? ""), key: ticketKey(tool, payload) });
		return { decision: "allow" };
	}

	/** E10: a model `workdir` moves the call's cwd; only the worktree itself is allowed. */
	private cwdRefusal(cwd: unknown): string | undefined {
		const real = (path: string) => {
			try {
				return realpathSync(path);
			} catch {
				return resolve(path);
			}
		};
		if (typeof cwd === "string" && cwd !== "" && real(cwd) === real(this.options.job.worktree)) return undefined;
		return `Refused: a native planner's command runs in its worktree only, not in ${String(cwd)}.`;
	}

	private hookServer(): Promise<Server> {
		const server = createServer((conn) => {
			let buffer = "";
			conn.setEncoding("utf8");
			conn.on("error", () => {});
			conn.on("data", (chunk: string) => {
				buffer += chunk;
				const cut = buffer.indexOf("\n");
				if (cut < 0) return;
				let verdict: ReturnType<CodexRun["hookVerdict"]>;
				try {
					const message = JSON.parse(buffer.slice(0, cut)) as { v?: number; hook?: Record<string, unknown> };
					verdict = message.v === 1 && message.hook !== undefined ? this.hookVerdict(message.hook) : { decision: "deny", reason: "Refused: a malformed hook message." };
				} catch {
					verdict = { decision: "deny", reason: "Refused: a hook message that is not JSON." };
				}
				conn.end(`${JSON.stringify(verdict)}\n`);
			});
		});
		return new Promise((done, fail) => {
			server.once("error", fail);
			server.listen(this.socket, () => done(server));
		});
	}

	private approveCommand(params: CommandApprovalParams): { decision: "accept" | "decline" } {
		const command = params.command ?? "";
		const why = this.closed()
			?? this.cwdRefusal(params.cwd)
			?? (params.additionalPermissions != null || params.networkApprovalContext != null ? "Refused: the command asked for extra permissions or network; picp never grants them." : undefined)
			?? this.guard({ name: "bash", input: { command } })
			?? (this.take(params.itemId, ticketKey("Bash", command)) ? undefined : "Refused: no hook verdict for this command; a call picp's hook did not allow does not run.");
		if (why === undefined) {
			this.acceptedItems.add(params.itemId);
			return { decision: "accept" };
		}
		this.deny("Bash", why, "approval");
		return { decision: "decline" };
	}

	private toolCall(params: DynamicToolCallParams): DynamicToolCallResponse {
		const why = this.closed()
			?? (params.tool !== REPORT_TOOL ? `Refused: ${params.tool} is not a picp tool.` : undefined)
			?? this.guard({ name: "report_result", input: (params.arguments ?? {}) as Record<string, unknown> })
			?? (this.take(params.callId, ticketKey(params.tool, params.arguments)) ? undefined : "Refused: no hook verdict for this call; a call picp's hook did not allow does not run.");
		if (why !== undefined) return text(this.deny(params.tool, why, "tool_call"), false);
		return this.report(params.arguments);
	}

	/** picp's `report_result`, as the Claude driver's: validated, written once, wrong-job and conflicting refused. */
	private report(args: unknown): DynamicToolCallResponse {
		const job = this.options.job;
		const context: JobContext = {
			job_id: job.job_id, kind: job.kind, delivery: job.delivery, role: job.role, runDir: job.runDir, worktree: job.worktree,
			artifactPath: job.artifactPath, mayAskOperator: false,
		};
		const refuse = (value: string) => {
			this.refusals.push(value);
			return text(value, false);
		};
		this.attempts += 1;
		const left = Math.max(0, ENVELOPE_REPAIR_MAX_ATTEMPTS - this.attempts);
		const checked = validateEnvelope(args, context);
		const errors = checked.ok ? localChecks(checked.value, context) : checked.errors;
		if (!checked.ok || errors.length > 0) return refuse(formatRejection(errors, this.attempts, left, REPORT_TOOL));
		const recordFile = join(job.runDir, ENVELOPE_FILE);
		if (existsSync(recordFile)) {
			let filed: unknown;
			try {
				filed = (JSON.parse(readFileSync(recordFile, "utf8")) as EnvelopeRecord).envelope;
			} catch (err) {
				return refuse(`report_result: ${recordFile} exists but is unreadable (${(err as Error).message}); refused.`);
			}
			if (JSON.stringify(filed) === JSON.stringify(checked.value)) return text(`Already recorded (no-op): ${recordFile}`, true);
			return refuse(`report_result: your report was already filed at ${recordFile}; a different report is refused.`);
		}
		const record: EnvelopeRecord = { schema_version: SCHEMA_VERSION, job_id: job.job_id, received_at: isoTimestamp(), attempt: this.attempts, envelope: checked.value };
		mkdirSync(job.runDir, { recursive: true });
		writeFileSync(`${recordFile}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(`${recordFile}.tmp`, recordFile);
		this.accepted = checked.value;
		return text(`Reported ${job.job_id}. Stop now.`, true);
	}

	private async listTerminals(): Promise<TerminalsListResponse["data"]> {
		if (this.rpc === undefined || this.threadId === undefined) return [];
		const listed = await this.rpc.request<TerminalsListResponse>(M.terminalsList, { threadId: this.threadId });
		for (const each of listed.data) this.known.set(each.processId, each.osPid ?? this.known.get(each.processId) ?? undefined);
		return listed.data;
	}

	private async interrupt(): Promise<void> {
		if (this.rpc === undefined || this.threadId === undefined || this.turnId === undefined || this.turn !== undefined) return;
		await this.rpc.request(M.turnInterrupt, { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
	}

	private onNotification(method: string, params: unknown): void {
		try {
			this.options.onMessage?.(method, params);
		} catch {
			// An observer must never end the run.
		}
		if (method === M.turnCompleted) {
			const done = params as TurnCompletedNotification;
			if (done.threadId === this.threadId && (this.turnId === undefined || done.turn.id === this.turnId)) {
				this.turn = done.turn;
				this.turnDone();
			}
		} else if (method === M.itemStarted || method === M.itemCompleted) {
			const item = (params as ItemNotification).item;
			this.tripwire(item);
			this.toolEvent(method === M.itemStarted ? "start" : "end", item);
			if (method === M.itemStarted && item?.type === "commandExecution") void this.listTerminals().catch(() => undefined);
		} else if (method === M.threadStarted) {
			const id = (params as ThreadStartedNotification).thread?.id;
			if (this.threadId !== undefined && id !== this.threadId) this.kill("thread/started");
		} else if (method === M.hookCompleted) {
			const status = (params as HookCompletedNotification).run?.status;
			if (status !== "completed" && status !== "blocked" && status !== "running") {
				this.hookFailed = true;
				this.rpc?.kill();
			}
		} else if (method === M.tokenUsageUpdated) {
			const usage = params as TokenUsageUpdatedNotification;
			if (usage.threadId === this.threadId || this.threadId === undefined) this.usages.push({ turnId: usage.turnId, total: totals(usage.tokenUsage.total) });
		}
	}

	/** Kills the scope on a tool the CLI ran without asking picp: an unaccepted command, an applied patch, an ungated tool. */
	private tripwire(item: ItemNotification["item"] | undefined): void {
		if (item === undefined) return;
		const status = "status" in item ? item.status : undefined;
		// 0.170.0 announces a command `inProgress` with no process before it asks; a process or an end means it ran.
		const ran = item.type === "commandExecution" && (status !== "inProgress" || item.processId != null);
		const unasked = item.type === "commandExecution"
			? ran && status !== "declined" && !this.acceptedItems.has(item.id) && !this.hookDenied.has(item.id)
			: item.type === "fileChange" ? status !== "declined" : UNGATED_ITEMS.includes(item.type);
		if (unasked) this.kill(item.type);
	}

	private kill(type: string): void {
		this.bypass ??= type;
		this.rpc?.kill();
	}

	private toolEvent(phase: "start" | "end", item: ItemNotification["item"] | undefined): void {
		if (this.options.onTool === undefined || (item?.type !== "commandExecution" && item?.type !== "dynamicToolCall")) return;
		const seen = this.toolPhase.get(item.id);
		if (seen === "end" || seen === phase) return;
		const [name, args] = item.type === "commandExecution" ? ["bash", { command: item.command }] : [item.tool, item.arguments];
		const fire = (event: CodexToolEvent) => {
			try {
				this.options.onTool?.(event);
			} catch {
				// An observer must never end the run.
			}
		};
		if (seen === undefined) fire({ phase: "start", id: item.id, name, args });
		if (phase === "end") fire({ phase: "end", id: item.id, name, isError: item.status !== "completed" });
		this.toolPhase.set(item.id, phase);
	}

	/** Terminates every process the app-server lists, then SIGKILLs any reported pid still alive. */
	private async endProcesses(alive: boolean): Promise<CodexLeftover[]> {
		const listed = alive ? await this.listTerminals().catch(() => []) : [];
		const terminated = new Set<string>();
		for (const each of listed) {
			const answer = await this.rpc?.request<{ terminated?: boolean }>(M.terminalsTerminate, { threadId: this.threadId, processId: each.processId }).catch(() => undefined);
			if (answer?.terminated === true) terminated.add(each.processId);
		}
		const pids = [...this.known.values()].filter((pid): pid is number => pid !== undefined && pid !== null);
		const deadline = Date.now() + PID_WAIT_MS;
		while (pids.some(isPidAlive) && Date.now() < deadline) await sleep(50);
		for (const pid of pids.filter(isPidAlive)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone between the check and the kill.
			}
		}
		const after = Date.now() + PID_WAIT_MS;
		while (pids.some(isPidAlive) && Date.now() < after) await sleep(50);
		return [...this.known].map(([processId, osPid]) => ({
			processId, ...(osPid == null ? {} : { osPid }), terminated: terminated.has(processId), gone: osPid == null ? false : !isPidAlive(osPid),
		}));
	}

	private usage(): { totals?: CodexTokenTotals; usage: CodexRunUsage } {
		const own = this.usages.filter((each) => each.turnId === this.turnId);
		const latest = own.reduce<CodexTokenTotals | undefined>((max, each) => (max === undefined || each.total.totalTokens > max.totalTokens ? each.total : max), undefined);
		const resume = this.options.resume;
		const baseline = resume === undefined ? ZERO_TOTALS : resume.baseline ?? this.usages.find((each) => each.turnId !== this.turnId)?.total;
		const all = this.usages.reduce<CodexTokenTotals | undefined>((max, each) => (max === undefined || each.total.totalTokens > max.totalTokens ? each.total : max), undefined);
		return { ...(all === undefined ? {} : { totals: all }), usage: codexRunUsage(baseline, latest) };
	}

	async run(): Promise<CodexSpikeResult> {
		const { job } = this.options;
		const env = buildCodexChildEnv(this.dirs, this.hostEnv, this.codexHome, this.options.childEnv);
		const hookCommand = codexHookCommand(this.socket, this.options.hookClientTimeoutMs);
		const spawn = { hookCommand, profile: this.profile, hookTimeoutSec: this.options.hookTimeoutSec, surfaceFlags: this.options.surfaceFlags };
		const server = await this.hookServer();
		let lockdown: CodexLockdown | undefined;
		let error: string | undefined;
		let coldStartMs: number | undefined;
		let exit: CodexSpikeResult["exit"];
		let leftovers: CodexLeftover[] = [];
		let exitedEarly = false;
		const abort = new AbortController();
		for (const signal of [AbortSignal.timeout(this.options.timeoutMs ?? 180_000), this.options.signal]) {
			if (signal?.aborted) abort.abort();
			signal?.addEventListener("abort", () => abort.abort(), { once: true });
		}
		try {
			const trust = await codexHookTrust(this.codex.path, codexSpawnArgs(spawn), job.worktree, env, this.containment);
			const rpc = spawnCodexRpc({ command: this.codex.path, args: codexSpawnArgs({ ...spawn, trust }), cwd: job.worktree, env, containment: this.containment });
			this.rpc = rpc;
			rpc.onNotification(({ method, params }) => this.onNotification(method, params));
			rpc.onRequest(M.commandApproval, (params) => this.approveCommand(params as CommandApprovalParams));
			rpc.onRequest(M.fileChangeApproval, () => {
				this.deny("apply_patch", "Refused: a C0 planner changes no files.", "approval");
				return { decision: "decline" };
			});
			rpc.onRequest(M.toolCall, (params) => this.toolCall(params as DynamicToolCallParams));
			try {
				const init = await initialize(rpc);
				coldStartMs = Date.now() - this.started;
				const pid = rpc.appServerPid();
				if (pid !== undefined) this.options.onAppServer?.(pid);
				const [account, hooks, mcp, skills, features, config] = await Promise.all([
					rpc.request<GetAccountResponse>(M.accountRead, {}),
					rpc.request<HooksListResponse>(M.hooksList, { cwds: [job.worktree] }),
					rpc.request<ListMcpServerStatusResponse>(M.mcpServerStatusList, {}),
					rpc.request<SkillsListResponse>(M.skillsList, { cwds: [job.worktree] }),
					listFeatures(rpc),
					rpc.request<ConfigReadResponse>(M.configRead, { cwd: job.worktree }),
				]);
				const surface = {
					codexHome: { passed: this.codexHome, reported: init.codexHome }, account: account.account != null, hookCommand, hooks, mcpServers: mcp, skills,
					features, config, profile: { id: CODEX_PROFILE, writableRoots: this.profile.writableRoots },
				};
				lockdown = codexLockdownVerdict(surface);
				if (lockdown.verdict === "ok") {
					const thread = await this.openThread(rpc);
					lockdown = codexLockdownVerdict({ ...surface, thread: { response: thread, cwd: job.worktree } });
				}
				lockdown = { ...lockdown, checkMs: Date.now() - this.started - coldStartMs };
				if (lockdown.verdict === "ok" && this.threadId !== undefined) exitedEarly = await this.runTurn(rpc, abort.signal);
			} catch (err) {
				error = (err as Error).message;
			}
			leftovers = await this.endProcesses(!exitedEarly && rpc.pid !== undefined);
			if (this.options.deleteThread === true && this.threadId !== undefined && !exitedEarly) {
				await rpc.request(M.threadDelete, { threadId: this.threadId }).catch((err: Error) => (error ??= `thread/delete failed: ${err.message}`));
			}
			exit = await closeRpc(rpc);
		} catch (err) {
			error ??= (err as Error).message;
		} finally {
			server.close();
		}
		if (lockdown?.verdict === "refused") error = lockdown.refusal;
		else if (this.bypass !== undefined) error = `Refused: the Codex CLI ran ${this.bypass} without asking picp; the run was killed.`;
		else if (this.hookFailed) error = "Refused: picp's hook failed (killed, timed out or unreachable); the run was killed so nothing that failed open reaches the model.";
		else if (this.turn === undefined && lockdown?.verdict === "ok" && error === undefined) {
			error = exitedEarly ? "the app-server exited before turn/completed; its exit code is not an outcome" : "the turn did not complete before the stop";
		}
		const turn = this.turn;
		const killed = this.bypass !== undefined || this.hookFailed;
		const outcome: CodexSpikeResult["outcome"] = lockdown?.verdict !== "ok" ? "refused" : killed || turn === undefined || turn.status === "inProgress" ? "stopped" : turn.status;
		const { totals: latest, usage } = this.usage();
		return {
			codexPath: this.codex.path, codexVersion: this.codex.version, spawnedCommand: this.codex.path, spawnedEnvKeys: Object.keys(env).sort(),
			...(exit === undefined ? {} : { exit }), outcome, ...(turn === undefined ? {} : { turnStatus: turn.status }),
			...(turn?.error?.codexErrorInfo === undefined ? {} : { codexErrorInfo: turn.error.codexErrorInfo }),
			...(this.accepted === undefined ? {} : { report: this.accepted }), reportRefusals: this.refusals, denials: this.denials, ticketMatch: this.ticketMatch,
			...(lockdown === undefined ? {} : { lockdown }), ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
			...(latest === undefined ? {} : { totals: latest }), usage, leftovers, hookFailed: this.hookFailed, ...(this.bypass === undefined ? {} : { bypass: this.bypass }),
			...(coldStartMs === undefined ? {} : { coldStartMs }), durationMs: Date.now() - this.started, ...(error === undefined ? {} : { error }),
		};
	}

	private async openThread(rpc: CodexRpc): Promise<ThreadStartResponse> {
		const { job, model, systemPrompt, resume } = this.options;
		const common = {
			cwd: job.worktree, approvalPolicy: "untrusted",
			...(model === undefined ? {} : { model }), ...(systemPrompt === undefined ? {} : { developerInstructions: systemPrompt }),
		};
		const reportSpec = {
			type: "function", name: REPORT_TOOL, inputSchema: JSON.parse(JSON.stringify(EnvelopeSchema)) as unknown,
			description: "Finish this job by reporting the envelope (job_id, kind, status, summary, artifact_path, plan_summary). Call it once.",
		};
		const thread = resume === undefined
			? await rpc.request<ThreadStartResponse>(M.threadStart, { ...common, dynamicTools: [reportSpec] })
			: await rpc.request<ThreadStartResponse>(M.threadResume, { ...common, threadId: resume.threadId });
		this.threadId = thread.thread.id;
		return thread;
	}

	/** Runs the one turn; true when the app-server exited before `turn/completed`. */
	private async runTurn(rpc: CodexRpc, signal: AbortSignal): Promise<boolean> {
		const done = new Promise<"done">((ok) => (this.turnDone = () => ok("done")));
		const aborted = new Promise<"aborted">((ok) => (signal.aborted ? ok("aborted") : signal.addEventListener("abort", () => ok("aborted"), { once: true })));
		const exited = rpc.exited.then(() => "exited" as const);
		this.ready = true;
		const effort = this.options.effort === undefined ? {} : { effort: this.options.effort };
		const started = await rpc.request<TurnStartResponse>(M.turnStart, { threadId: this.threadId, input: [{ type: "text", text: this.options.prompt }], ...effort });
		this.turnId = started.turn.id;
		const first = await Promise.race([done, aborted, exited]);
		if (first === "aborted") {
			await this.interrupt();
			await Promise.race([done, exited, sleep(STOP_WAIT_MS, undefined, { ref: false })]);
		}
		this.ready = false;
		return this.turn === undefined && (await Promise.race([exited, sleep(0, undefined, { ref: false })])) === "exited";
	}
}
