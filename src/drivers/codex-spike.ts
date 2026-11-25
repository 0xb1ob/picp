/**
 * Codex run core: one planner run on `codex app-server`, unwired. Gates: picp's hook, its ticket, `untrusted` approvals
 * and the kernel profile; a lockdown; a tripwire that kills on any unasked tool; usage from totals; a full stop.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Envelope, GateReview } from "../contracts.ts";
import { isPidAlive } from "../fleet.ts";
import { assertBriefIsSafe } from "../worker-manager.ts";
import type { CodexMcpServers } from "../worker-mcp.ts";
import { secretPaths } from "./claude-bash-policy.ts";
import { CodexSpikeError, codexLoginRefusal, defaultCodexHome, resolveCodex } from "./codex-cli.ts";
import { type CodexContainment, resolveCodexContainment } from "./codex-containment.ts";
import {
	buildCodexChildEnv,
	codexHookCommand,
	codexPermissionProfile,
	type CodexProfile,
	CODEX_REVIEWER_OFF_FEATURES,
	codexRunRoots,
	codexSpawnArgs,
	REVIEWER_SURFACE_FLAGS,
} from "./codex-launch.ts";
import { type CodexLockdown, codexLockdownVerdict } from "./codex-lockdown.ts";
import { type CodexRateLimits, codexRunUsage, type CodexRunUsage, type CodexTokenTotals, codexTotals as totals, mergeCodexRateLimits, ZERO_TOTALS } from "./codex-observation.ts";
import {
	type AccountRateLimitsUpdatedNotification,
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
	type ListMcpServerStatusParams,
	type ListMcpServerStatusResponse,
	type McpElicitationParams,
	type McpElicitationResponse,
	type SkillsListResponse,
	type TerminalsListResponse,
	type ThreadStartedNotification,
	type ThreadStartResponse,
	type TokenUsageUpdatedNotification,
	type Turn,
	type TurnCompletedNotification,
	type TurnStartResponse,
	type TurnSteerParams,
	type TurnSteerResponse,
} from "./codex-protocol.ts";
import { type CodexRpc, CodexRpcError, type CodexRpcExit, spawnCodexRpc } from "./codex-rpc.ts";
import {
	type CodexDynamicTool, codexGitGuard, codexMcpApproval, codexMcpRoute, codexPatchRefusal, codexRoleTools, type CodexReportState, codexSecretGuard, codexToolCall,
} from "./codex-tools.ts";
import { type NormalizedCall, type SpikeGuard, type SpikeJob, spikeGuards } from "./native-guards.ts";

export { CODEX_BUILTIN_SKILLS, type CodexLockdown, codexLockdownVerdict } from "./codex-lockdown.ts";
export { codexRunUsage, type CodexRunUsage, type CodexTokenTotals, ZERO_TOTALS } from "./codex-observation.ts";
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

export { codexSecretGuard, codexToolCall, REPORT_TOOL } from "./codex-tools.ts";
const EXIT_GRACE_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const PID_WAIT_MS = 2_000;
/** Item types of tools that never ask picp (E5); any of them, or another thread, kills the run. */
const UNGATED_ITEMS: readonly string[] = ["imageView", "subAgentActivity", "collabAgentToolCall", "webSearch", "imageGeneration", "sleep"];

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

/** Every page of the thread's `mcpServerStatus/list`; a cursor that repeats ends the walk. */
async function listMcp(rpc: CodexRpc, threadId: string): Promise<ListMcpServerStatusResponse> {
	const data: ListMcpServerStatusResponse["data"] = [];
	const cursors = new Set<string>();
	for (let cursor: string | undefined; ; ) {
		const params: ListMcpServerStatusParams = { threadId, detail: "toolsAndAuthOnly", ...(cursor === undefined ? {} : { cursor }) };
		const page = await rpc.request<ListMcpServerStatusResponse>(M.mcpServerStatusList, params);
		data.push(...page.data);
		if (page.nextCursor == null || cursors.has(page.nextCursor)) return { data };
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

export interface CodexSpikeOptions {
	/** Planner, (C6) gate-reviewer or (C7a) implementer; another role throws. */
	job: SpikeJob;
	prompt: string;
	model?: string;
	effort?: string;
	systemPrompt?: string;
	/** Passed to the CLI as `CODEX_HOME`; picp never opens it. Default `<passwd home>/.codex`. */
	codexHome?: string;
	hostEnv?: NodeJS.ProcessEnv;
	childEnv?: Record<string, string | undefined>;
	/** Paths the guard chain refuses beside the homes' secrets, best effort (the git signing key). */
	secretFiles?: readonly string[];
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
	/** Caller-owned: `steer` is set while the turn is live and deleted when it ends (C2b). */
	control?: CodexRunControl;
	/** The operator's MCP servers (C5), sent as thread config on start and every resume. */
	mcp?: CodexMcpServers;
	/** Per-job skill dirs the brief names (C5), each a sandbox read root. */
	skillDirs?: readonly string[];
	/** Operator read roots (C7a, `CP_CODEX_READ_ROOTS`), vetted as skill dirs are. */
	readRoots?: readonly string[];
}

/** `steered` only on the CLI's ack; `-32600` (no or another active turn) or no live turn is `steered: false`. */
export type CodexSteer = { steered: true; turnId: string } | { steered: false; why: string };
export interface CodexRunControl { steer?: (text: string) => Promise<CodexSteer> }

/** `output` on an end: a command's output, a dynamic tool's reply, or picp's refusal of a blocked or declined call. */
export interface CodexToolEvent { phase: "start" | "end"; id: string; name: string; args?: unknown; isError?: boolean; output?: string; exitCode?: number | null }

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
	/** A reviewer's accepted `report_verdict` (C6), already filed in the run dir. */
	verdict?: GateReview;
	reportRefusals: string[];
	denials: CodexDenial[];
	ticketMatch: { id: number; payload: number; none: number };
	lockdown?: CodexLockdown;
	threadId?: string;
	/** This thread's latest cumulative totals; pass as `resume.baseline` to the run that resumes it. */
	totals?: CodexTokenTotals;
	usage: CodexRunUsage;
	/** The main allowance as this run's `account/rateLimits/updated` notifications left it (C3). */
	rateLimits?: CodexRateLimits;
	leftovers: CodexLeftover[];
	hookFailed: boolean;
	/** The item type of a tool the CLI ran without asking picp; the run was killed on it. */
	bypass?: string;
	coldStartMs?: number;
	durationMs: number;
	error?: string;
}

/** One isolated run; its own scratch dir (HOME, TMPDIR, hook socket) is removed before returning. */
export async function runCodexSpike(options: CodexSpikeOptions): Promise<CodexSpikeResult> {
	if (!["planner", "gate-reviewer", "implementer"].includes(options.job.role)) {
		throw new CodexSpikeError(`the Codex run core runs the planner, gate-reviewer and implementer roles only, not ${options.job.role}`);
	}
	// C7a (R3): a write-capable job gets no MCP server, so a dead hook's resource read cannot reach one.
	if (options.job.role === "implementer" && (options.mcp?.names.length ?? 0) > 0) throw new CodexSpikeError("Refused: a Codex implementer runs with no MCP server (R3).");
	const hostEnv = options.hostEnv ?? process.env;
	const codex = resolveCodex(hostEnv);
	const containment = resolveCodexContainment(hostEnv);
	assertBriefIsSafe(options.prompt, "spike prompt");
	const scratch = options.scratchDir ?? mkdtempSync(join(tmpdir(), "cp-codex-spike-"));
	try {
		if (!relative(resolve(options.job.worktree), resolve(scratch)).startsWith("..")) throw new CodexSpikeError("scratch dir is inside the worktree");
		const dirs = { home: join(scratch, "home"), tmp: join(scratch, "tmp") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		// A killed run leaves its socket in a kept scratch dir; the run that resumes it would not listen (EADDRINUSE).
		rmSync(join(scratch, "hook.sock"), { force: true });
		const codexHome = options.codexHome ?? defaultCodexHome();
		const login = await codexLoginRefusal(codex.path, { codexHome, home: dirs.home, pathEnv: hostEnv.PATH ?? "" });
		if (login !== undefined) throw Object.assign(new CodexSpikeError(login), { cli: "auth" as const });
		const roots = codexRunRoots({ job: options.job, codexPath: codex.path, codexHome, hostEnv, tmp: dirs.tmp, skillDirs: options.skillDirs, readRoots: options.readRoots });
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
	/** The MCP item ids picp's hook allowed, by route kind: a tool call (asks picp) or a resource read (asks nothing). */
	private readonly allowedMcp = new Map<string, "mcp" | "resource">();
	private readonly reported: CodexReportState = { attempts: 0, refusals: [] };
	private readonly tools: CodexDynamicTool[];
	private readonly toolPhase = new Map<string, "start" | "end">();
	/** picp's own answer per item: an approval refusal or a dynamic tool's reply, for the end event's `output`. */
	private readonly answers = new Map<string, string>();
	private ready = false;
	private hookFailed = false;
	private bypass?: string;
	private rpc?: CodexRpc;
	private threadId?: string;
	private turnId?: string;
	private turn?: Turn;
	private limits?: CodexRateLimits;
	private turnDone: () => void = () => {};

	private readonly options: CodexSpikeOptions;
	private readonly codex: { path: string; version: string };
	private readonly hostEnv: NodeJS.ProcessEnv;
	private readonly codexHome: string;
	private readonly dirs: { home: string; tmp: string };
	private readonly socket: string;
	private readonly containment: CodexContainment;
	private readonly profile: CodexProfile;
	private readonly reviewer: boolean;

	constructor(
		options: CodexSpikeOptions, codex: { path: string; version: string }, hostEnv: NodeJS.ProcessEnv, codexHome: string,
		dirs: { home: string; tmp: string }, socket: string, containment: CodexContainment, profile: CodexProfile,
	) {
		[this.options, this.codex, this.hostEnv, this.codexHome, this.dirs, this.socket] = [options, codex, hostEnv, codexHome, dirs, socket];
		[this.containment, this.profile] = [containment, profile];
		const job = { ...options.job, tmp: dirs.tmp };
		const secrets = [...secretPaths(null, [userInfo().homedir]), resolve(codexHome), ...(options.secretFiles ?? [])];
		this.reviewer = options.job.role === "gate-reviewer";
		const role = options.job.role;
		// The git guard only refuses; first, so an implementer's git refusal names the picp tool, not pi's git.
		this.guards = [codexGitGuard(role), ...spikeGuards(job, secrets, role, false), codexSecretGuard(resolve(codexHome), role), ...(options.extraGuards ?? [])];
		this.tools = codexRoleTools(options.job, hostEnv, this.reported);
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

	/** Consumes the hook's allow for this call, by id first, then by tool and payload; the ticket's id, or undefined. */
	private take(id: string, key: string): string | undefined {
		let at = this.tickets.findIndex((ticket) => ticket.id !== "" && ticket.id === id);
		const by = at >= 0 ? "id" : "payload";
		if (at < 0) at = this.tickets.findIndex((ticket) => ticket.key === key);
		if (at < 0) {
			this.ticketMatch.none++;
			return undefined;
		}
		const [ticket] = this.tickets.splice(at, 1);
		this.ticketMatch[by]++;
		return ticket?.id ?? "";
	}

	private closed(): string | undefined {
		if (!this.ready) return "Refused: picp's lockdown has not passed; no tool runs before it does.";
		if (this.hookFailed) return "Refused: picp's hook failed in this run, so there is no hook verdict; nothing more runs.";
		if (this.bypass !== undefined) return "Refused: picp killed this run on a tool the CLI ran without asking; nothing more runs.";
		return undefined;
	}

	/** The hook socket's verdict: deny unless the lockdown passed, no hook failed, and every guard allows. */
	private hookVerdict(hook: Record<string, unknown>): { decision: "allow" } | { decision: "deny"; reason: string } {
		const tool = String(hook.tool_name ?? "");
		const route = codexMcpRoute(this.options.mcp, tool);
		const mapped = codexToolCall(tool, hook.tool_input);
		// A forge name the thread did not declare is not in the tool set.
		const call = mapped !== undefined && mapped.name !== "bash" && !this.tools.some((each) => each.spec.name === tool) ? undefined : mapped;
		const id = String(hook.tool_use_id ?? "");
		const reason = this.closed() ?? this.cwdRefusal(hook.cwd)
			?? (route !== undefined ? route.refusal : call !== undefined ? this.guard(call)
				: tool === "apply_patch" && this.options.job.role === "implementer" ? codexPatchRefusal("implementer") : `Refused: ${tool} is not in the Codex spike's tool set.`);
		if (reason !== undefined) {
			this.hookDenied.add(id);
			// A blocked call gets no item from the CLI (F2): its pair is fired here, so bounds and the Log count it.
			if (!this.toolPhase.has(id)) {
				this.fire({ phase: "start", id, name: call?.name ?? tool, args: call?.input ?? hook.tool_input });
				this.fire({ phase: "end", id, name: call?.name ?? tool, isError: true, output: reason });
				this.toolPhase.set(id, "end");
			}
			return { decision: "deny", reason: this.deny(tool, reason, "hook") };
		}
		if (route !== undefined) this.allowedMcp.set(id, route.kind);
		if (route?.kind === "resource") return { decision: "allow" };
		const payload = route !== undefined ? hook.tool_input : call?.name === "bash" ? call.input.command : call?.input;
		this.tickets.push({ id, key: ticketKey(tool, payload) });
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
		return `Refused: a native ${this.options.job.role === "implementer" ? "implementer" : "planner"}'s command runs in its worktree only, not in ${String(cwd)}.`;
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
			?? (this.take(params.itemId, ticketKey("Bash", command)) !== undefined ? undefined : "Refused: no hook verdict for this command; a call picp's hook did not allow does not run.");
		if (why === undefined) {
			this.acceptedItems.add(params.itemId);
			return { decision: "accept" };
		}
		this.answers.set(params.itemId, why);
		this.deny("Bash", why, "approval");
		return { decision: "decline" };
	}

	/** C5: accepts only an MCP tool-call approval of a passed server's visible tool whose hook ticket is still open. */
	private approveMcp(params: McpElicitationParams): McpElicitationResponse {
		const mapped = codexMcpApproval(this.options.mcp, params);
		const tool = typeof mapped === "string" ? `mcp__${params.serverName}__${String(params._meta?.tool_name ?? "")}` : mapped.tool;
		const why = this.closed() ?? (typeof mapped === "string" ? mapped : undefined);
		const id = why === undefined && typeof mapped !== "string" ? this.take("", ticketKey(mapped.tool, mapped.payload)) : undefined;
		if (why === undefined && id !== undefined) {
			this.acceptedItems.add(id);
			return { action: "accept" };
		}
		this.deny(tool, why ?? "Refused: no hook verdict for this MCP tool call; a call picp's hook did not allow does not run.", "approval");
		return { action: "decline" };
	}

	private async toolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
		const tool = this.tools.find((each) => each.spec.name === params.tool);
		const why = this.closed()
			?? (tool === undefined ? `Refused: ${params.tool} is not a picp tool.` : undefined)
			?? this.guard({ name: params.tool, input: (params.arguments ?? {}) as Record<string, unknown> })
			?? (this.take(params.callId, ticketKey(params.tool, params.arguments)) !== undefined ? undefined : "Refused: no hook verdict for this call; a call picp's hook did not allow does not run.");
		const reply = why === undefined && tool !== undefined ? await tool.run(params.arguments) : { text: this.deny(params.tool, why ?? "", "tool_call"), success: false };
		this.answers.set(params.callId, reply.text);
		return text(reply.text, reply.success);
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
		} else if (method === M.rateLimitsUpdated) {
			this.limits = mergeCodexRateLimits(this.limits, (params as AccountRateLimitsUpdatedNotification | undefined)?.rateLimits);
		}
	}

	/** Kills the scope on a tool the CLI ran without asking picp: an unaccepted command or patch, an ungated tool. */
	private tripwire(item: ItemNotification["item"] | undefined): void {
		if (item === undefined) return;
		const status = "status" in item ? item.status : undefined;
		// 0.170.0 announces a command `inProgress` with no process before it asks; a process or an end means it ran.
		const ran = item.type === "commandExecution" && (status !== "inProgress" || item.processId != null);
		// F1: a patch is `inProgress` before it asks and picp accepts none, so any end but `declined` is unasked.
		// C5 (P1): so is an MCP item the hook never allowed, or a tool call `completed` with no accepted approval.
		const mcp = item.type === "mcpToolCall" ? this.allowedMcp.get(item.id) : undefined;
		const unasked = item.type === "commandExecution"
			? ran && status !== "declined" && !this.acceptedItems.has(item.id) && !this.hookDenied.has(item.id)
			: item.type === "fileChange" ? status !== "inProgress" && status !== "declined"
			: item.type === "mcpToolCall" ? (mcp === undefined && !this.hookDenied.has(item.id)) || (mcp === "mcp" && status === "completed" && !this.acceptedItems.has(item.id))
			: UNGATED_ITEMS.includes(item.type);
		if (unasked) this.kill(item.type);
	}

	private kill(type: string): void {
		this.bypass ??= type;
		this.rpc?.kill();
	}

	private fire(event: CodexToolEvent): void {
		try {
			this.options.onTool?.(event);
		} catch {
			// An observer must never end the run.
		}
	}

	private toolEvent(phase: "start" | "end", item: ItemNotification["item"] | undefined): void {
		if (this.options.onTool === undefined || (item?.type !== "commandExecution" && item?.type !== "dynamicToolCall" && item?.type !== "fileChange" && item?.type !== "mcpToolCall")) return;
		const seen = this.toolPhase.get(item.id);
		if (seen === "end" || seen === phase) return;
		const [name, args] = item.type === "commandExecution" ? ["bash", { command: item.command }]
			: item.type === "fileChange" ? ["apply_patch", { changes: item.changes }]
			: item.type === "mcpToolCall" ? [this.allowedMcp.get(item.id) === "resource" ? item.tool : `mcp__${item.server}__${item.tool}`, item.arguments]
			: [item.tool, item.arguments];
		if (seen === undefined) this.fire({ phase: "start", id: item.id, name, args });
		if (phase === "end") {
			const own = this.answers.get(item.id);
			const mcpOut = item.type === "mcpToolCall" ? item.error?.message ?? item.result?.content?.map((part) => part.text ?? "").join("\n") : undefined;
			const output = item.type === "commandExecution" ? (item.status === "declined" ? own : item.aggregatedOutput ?? undefined) : item.type === "mcpToolCall" ? mcpOut : own;
			const isError = item.status !== "completed" || (item.type === "dynamicToolCall" && item.success === false);
			this.fire({
				phase: "end", id: item.id, name, isError, ...(output == null ? {} : { output }),
				...(item.type === "commandExecution" && item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
			});
		}
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
		const spawn = { hookCommand, profile: this.profile, hookTimeoutSec: this.options.hookTimeoutSec,
			surfaceFlags: this.options.surfaceFlags ?? (this.reviewer ? REVIEWER_SURFACE_FLAGS : undefined) };
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
			rpc.onRequest(M.fileChangeApproval, (params) => {
				const why = codexPatchRefusal(this.options.job.role);
				this.answers.set(String((params as { itemId?: unknown } | undefined)?.itemId ?? ""), why);
				this.deny("apply_patch", why, "approval");
				return { decision: "decline" };
			});
			rpc.onRequest(M.toolCall, (params) => this.toolCall(params as DynamicToolCallParams));
			rpc.onRequest(M.mcpElicitation, (params) => this.approveMcp(params as McpElicitationParams));
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
					features, config, mcpServersPassed: this.options.mcp?.names ?? [],
					...(this.reviewer ? { offFeatures: CODEX_REVIEWER_OFF_FEATURES } : {}),
					profile: { id: this.profile.id, writableRoots: this.profile.writableRoots, ...(job.role === "implementer" ? { filesystem: this.profile.filesystem } : {}) },
				};
				lockdown = codexLockdownVerdict(surface);
				if (lockdown.verdict === "ok") {
					const thread = await this.openThread(rpc);
					// Q2: one thread-scoped list per run, so a server picp did not pass is refused before any turn.
					const mcpListed = this.options.mcp?.names.length ? await listMcp(rpc, thread.thread.id) : undefined;
					lockdown = codexLockdownVerdict({ ...surface, thread: { response: thread, cwd: job.worktree, ...(mcpListed ? { mcpListed } : {}) } });
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
			...(this.reported.accepted === undefined ? {} : { report: this.reported.accepted }), ...(this.reported.verdict === undefined ? {} : { verdict: this.reported.verdict }), reportRefusals: this.reported.refusals, denials: this.denials, ticketMatch: this.ticketMatch,
			...(lockdown === undefined ? {} : { lockdown }), ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
			...(latest === undefined ? {} : { totals: latest }), usage, ...(this.limits === undefined ? {} : { rateLimits: this.limits }), leftovers, hookFailed: this.hookFailed, ...(this.bypass === undefined ? {} : { bypass: this.bypass }),
			...(coldStartMs === undefined ? {} : { coldStartMs }), durationMs: Date.now() - this.started, ...(error === undefined ? {} : { error }),
		};
	}

	private async openThread(rpc: CodexRpc): Promise<ThreadStartResponse> {
		const { job, model, systemPrompt, resume } = this.options;
		const common = {
			cwd: job.worktree, approvalPolicy: "untrusted",
			...(model === undefined ? {} : { model }), ...(systemPrompt === undefined ? {} : { developerInstructions: systemPrompt }),
		};
		// P2: a resume without the config has no server (M13), so it goes on every thread/resume too.
		const config = this.options.mcp?.names.length ? { config: this.options.mcp.config } : {};
		const thread = resume === undefined
			? await rpc.request<ThreadStartResponse>(M.threadStart, { ...common, ...config, dynamicTools: this.tools.map((tool) => tool.spec) })
			: await rpc.request<ThreadStartResponse>(M.threadResume, { ...common, ...config, threadId: resume.threadId });
		this.threadId = thread.thread.id;
		return thread;
	}

	/** `turn/steer` into the live turn; a credential-shaped text throws before any request. */
	private async steer(rpc: CodexRpc, text: string): Promise<CodexSteer> {
		assertBriefIsSafe(text, "steer");
		if (this.turn !== undefined || this.turnId === undefined || this.closed() !== undefined) return { steered: false, why: "no live turn" };
		try {
			const params: TurnSteerParams = { threadId: this.threadId as string, expectedTurnId: this.turnId, input: [{ type: "text", text }] };
			const acked = await rpc.request<TurnSteerResponse>(M.turnSteer, params);
			return { steered: true, turnId: acked.turnId };
		} catch (error) {
			if (error instanceof CodexRpcError && error.code === -32600) return { steered: false, why: error.message };
			throw error;
		}
	}

	/** Runs the one turn; true when the app-server exited before `turn/completed`. */
	private async runTurn(rpc: CodexRpc, signal: AbortSignal): Promise<boolean> {
		const done = new Promise<"done">((ok) => (this.turnDone = () => ok("done")));
		const aborted = new Promise<"aborted">((ok) => (signal.aborted ? ok("aborted") : signal.addEventListener("abort", () => ok("aborted"), { once: true })));
		const exited = rpc.exited.then(() => "exited" as const);
		this.ready = true;
		const control = this.options.control;
		try {
			const effort = this.options.effort === undefined ? {} : { effort: this.options.effort };
			const started = await rpc.request<TurnStartResponse>(M.turnStart, { threadId: this.threadId, input: [{ type: "text", text: this.options.prompt }], ...effort });
			this.turnId = started.turn.id;
			if (control !== undefined) control.steer = (text) => this.steer(rpc, text);
			const first = await Promise.race([done, aborted, exited]);
			if (first === "aborted") {
				await this.interrupt();
				await Promise.race([done, exited, sleep(STOP_WAIT_MS, undefined, { ref: false })]);
			}
		} finally {
			this.ready = false;
			if (control !== undefined) delete control.steer;
		}
		return this.turn === undefined && (await Promise.race([exited, sleep(0, undefined, { ref: false })])) === "exited";
	}
}
