/** Operator-owned RPC parent: durable sends, observed-death recovery and read-only diagnostics. */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	type BridgeReceiptLevel,
	BRIDGE_RECEIPT_LEVELS,
	configureLayout,
	ENV_HEADLESS,
	ENV_MODE,
	type Escalation,
	isoTimestamp,
	LAYOUT,
	type Mode,
	PARENT_BRIDGE_FLAGS,
	type RunEvent,
	type ThinkingLevel,
	WORKER_FORBIDDEN_FLAGS,
} from "./contracts.ts";
import { autoParentContext, liveParentStatus, missionEndOf, parentBridgeStatus, parentCompactInstructions, parentContextFile, parentContextStatus } from "./parent-context.ts";
import { type ModelCallError, readModelCallError } from "./failures.ts";
import { parentDiagnostic, type ParentDiagnostic } from "./parent-diagnostics.ts";
import { DRAIN_DEFAULT_TIMEOUT_S } from "./drain.ts";
import { durableIdsFromMessage } from "./wakeup-outbox.ts";
import { type LandedMark, ParentDelivery } from "./parent-delivery.ts";
import { type ParentSendDelegation, messageText as textOf, parentSendFile, ParentSendOutbox, receiptOf, sendIdOfMessage } from "./parent-outbox.ts";
import { PACKAGE_ROOT } from "./home.ts";
import { parentGatewayKey } from "./gateway-key.ts";
import { SINGLE_MODE_REMOVED } from "./mode.ts";
import { atomicWriteJson } from "./json-store.ts";
import { isPidAlive } from "./fleet.ts";
import { asEscalation, openMissionEnds } from "./escalation-relay.ts";
import { deliverableRelay, scheduleJobIdOf } from "./relay-scope.ts";
import { readParentLock } from "./parent-lock.ts";
import { escalationProjects, homeMandateProjects, homeProjectResolver, withProjectTag } from "./project-report.ts";
import type { ModelProbe } from "./routing.ts";
import { STALE_WAKEUP_HEADLINE, type WakeupCarrier, wakeupStampOf } from "./wakeups.ts";
import { NONINTERACTIVE_WORKER_ENV, STRIPPED_ENV_KEYS } from "./worker-manager.ts";
import {
	WorkerProcess,
	type WorkerEvent,
	type WorkerExit,
} from "./worker-process.ts";

export const DEFAULT_BRIDGE_SETTLE_MS = 120_000;
/** Immediate deaths before the child is ready. Then stop, don't spin. */
export const RELAUNCH_FAIL_CAP = 3;

export class CpBridgeError extends Error {}

export interface BridgeReceipt {
	/** Highest level reached. Null if the message never entered the channel. */
	level: BridgeReceiptLevel | null;
	reached: BridgeReceiptLevel[];
	reply?: string;
	error?: string;
	/** The outbox id of this send. */
	send_id?: string;
	/** Set while the outcome is still to come: it arrives as a `send` relay with this id. */
	pending?: string;
}

export interface BridgeRelay {
	kind: "wake" | "escalation" | "relaunch" | "error" | "send";
	jobId?: string;
	/** Every job a `wake` turn was stamped with; all scheduled = not relayed (relay-scope.ts). */
	jobIds?: string[];
	sendId?: string;
	escalationId?: string;
	stale: boolean;
	text: string;
	receipt: BridgeReceipt;
	/** Paths the main session may read. Never file bodies. */
	paths: string[];
}

export interface ParentStartOptions {
	home: string;
	mode: Mode;
	model: string;
	thinking?: ThinkingLevel;
	piBin?: string;
	sessionFile?: string;
	commandPostExtension?: string;
	cwd?: string;
	settleTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Test seam. Production probes the process table. */
	isPidAlive?: (pid: number) => boolean;
	/**
	 * H1 (Pier 2.6): test seam for the outer retry ladder's delays. Production
	 * sleeps for real (`setTimeout`); a fake-timer test injects an immediate
	 * resolve so `OUTER_RETRY_DELAYS_MS` is asserted, not waited out.
	 */
	outerRetrySleep?: (ms: number) => Promise<void>;
}

export interface ParentStatus {
	alive: boolean;
	pid?: number;
	sessionFile?: string;
	lastReplyAt?: string;
	model?: string;
	contextTokens?: number | null;
	compactAtTokens?: number;
	standingOrders?: { path: string; modifiedAt: string };
	lastCompactAt?: string;
	lastRotateAt?: string;
	lastTurnCostUsd?: number;
	totalCostUsd?: number;
	openEscalations: Array<Pick<Escalation, "id" | "job_ids" | "kind" | "question" | "evidence_paths" | "status">>;
	paths: string[];
	escalationsError?: string;
	/** Every send without an observed outcome, plus the last 10 observed. */
	sends: ReturnType<ParentSendOutbox["statusRows"]>["sends"];
	sendsError?: string;
}

export type RelayListener = (relay: BridgeRelay) => void;

interface TurnBuf {
	texts: string[];
	stale: boolean;
	jobId?: string;
	jobIds: string[];
	assistantCount: number;
	/** Set/cleared by each assistant message_end; only the LAST one survives. */
	error?: ModelCallError;
	/** Sends whose marker landed in this run. */
	landed: LandedMark[];
	/** Refused cp_escalate calls, relayed at settle unless a later call in this run succeeds. */
	refused: BridgeRelay[];
}

const freshTurn = (): TurnBuf => ({ texts: [], stale: false, jobIds: [], assistantCount: 0, landed: [], refused: [] });

const emptyReceipt = (): BridgeReceipt => ({ level: null, reached: [] });

function climb(receipt: BridgeReceipt, level: BridgeReceiptLevel): BridgeReceipt {
	const reached = receipt.reached.includes(level) ? receipt.reached : [...receipt.reached, level];
	return { ...receipt, level, reached };
}

/** `webExtensions`: the resolved pi-web-access entry points, the only non-bridge extension the operator loads. */
export function operatorPiArgs(packageRoot: string, extra: readonly string[] = [], webExtensions: readonly string[] = []): string[] {
	return ["--no-extensions", "-e", join(packageRoot, "extensions/cp-bridge/index.ts"), ...webExtensions.flatMap((path) => ["-e", path]), ...extra];
}

/**
 * The parent's only skill: `<home>/skills/cp-memory`. A managed home
 * (`~/.pi/command-post`) holds state, not the package, so it falls back to the
 * copy shipped in the package root.
 */
export function parentSkillPaths(home: string, packageRoot: string = PACKAGE_ROOT): string[] {
	const fromHome = join(home, "skills/cp-memory");
	return [existsSync(join(fromHome, "SKILL.md")) ? fromHome : join(packageRoot, "skills/cp-memory")];
}

export function buildParentArgv(options: {
	sessionFile: string;
	model: string;
	extension: string;
	thinking?: ThinkingLevel;
	/** `--skill` paths; additive under `--no-skills`. */
	skills?: readonly string[];
	extraArgs?: readonly string[];
}): string[] {
	for (const flag of options.extraArgs ?? []) {
		if ((WORKER_FORBIDDEN_FLAGS as readonly string[]).includes(flag)) {
			throw new CpBridgeError(`forbidden parent flag ${flag}`);
		}
	}
	const args = ["--mode", "rpc", ...PARENT_BRIDGE_FLAGS, "--session", options.sessionFile, "--model", options.model];
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push("-e", options.extension);
	for (const skill of options.skills ?? []) args.push("--skill", skill);
	args.push(...(options.extraArgs ?? []));
	for (const flag of PARENT_BRIDGE_FLAGS) {
		if (!args.includes(flag)) throw new CpBridgeError(`parent argv missing ${flag}`);
	}
	return args;
}

/** Paths only. The main session is the tier allowed to read the bodies. */
/**
 * cp-0wq7/cur.5.4: never invent a parent model. `CP_PARENT_MODEL`, then the
 * operator session's own model (explicit `sessionModel`, which the caller
 * builds from `ctx.model` or `PI_PROVIDER`+`PI_MODEL`), then refuse naming
 * both options.
 */
export function resolveParentModel(
	env: { CP_PARENT_MODEL?: string; PI_PROVIDER?: string; PI_MODEL?: string },
	sessionModel?: string,
): string {
	const fromEnv = env.CP_PARENT_MODEL?.trim();
	if (fromEnv) return fromEnv;
	if (sessionModel?.trim()) return sessionModel.trim();
	const provider = env.PI_PROVIDER?.trim();
	const modelId = env.PI_MODEL?.trim();
	if (provider && modelId) return `${provider}/${modelId}`;
	throw new CpBridgeError(
		"cp_parent start needs a model: set CP_PARENT_MODEL, or run the operator with a model selected " +
			"(PI_PROVIDER/PI_MODEL or --model) so its own model is reused",
	);
}

/** Refuse an unknown/unauthenticated model before spawn, naming what pi does know. */
export function requireAvailableParentModel(model: string, probe: ModelProbe): void {
	if (probe.isAvailable(model)) return;
	const available = probe.available?.() ?? [];
	throw new CpBridgeError(
		`cp_parent start refuses ${model}: not available (unknown to pi, or its provider has no configured auth). ` +
			`Known: ${available.join(", ") || "(none)"}.`,
	);
}

export function bridgePaths(
	home: string,
	jobIds: readonly string[],
	evidence: readonly string[] = [],
): string[] {
	const out: string[] = [];
	for (const id of jobIds) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) continue;
		out.push(join(home, LAYOUT.runs, id, "artifact.md"));
		out.push(join(home, LAYOUT.runs, id));
		out.push(join(home, LAYOUT.artifacts, id, "report.md"));
	}
	for (const path of evidence) {
		if (path.length > 0) out.push(path);
	}
	return [...new Set(out)];
}

export function formatBridgeRelay(relay: BridgeRelay): string {
	const tags = [
		"cp-bridge",
		relay.kind,
		relay.sendId ? `send=${relay.sendId}` : "",
		relay.jobId ? `job=${relay.jobId}` : "",
		relay.escalationId ? `id=${relay.escalationId}` : "",
		relay.stale ? "stale" : "",
		`receipt=${relay.receipt.level ?? "none"}`,
	].filter(Boolean);
	const paths = relay.paths.length > 0 ? `\npaths:\n${relay.paths.map((path) => `- ${path}`).join("\n")}` : "";
	return `[${tags.join(" ")}]\n${relay.text}${paths}`;
}

/** The structured job field: a wake-up's own stamp (`details.cp_wakeup.job_id`), never its prose. */
function jobIdOfMessage(message: unknown): string | undefined {
	const stamp = message && typeof message === "object" ? wakeupStampOf(message as WakeupCarrier) : undefined;
	return typeof stamp?.job_id === "string" && JOB_ID.test(stamp.job_id) ? stamp.job_id : undefined;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Tools whose result may carry an H6 `risk_warning` (a pipeline advance carries it on `details.dispatch`). */
const RISK_WARNING_TOOLS: readonly string[] = ["cp_dispatch", "cp_send", "cp_pipeline"];
export function parentEnv(home: string, mode: Mode, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (key.startsWith("CP_") || (STRIPPED_ENV_KEYS as readonly string[]).includes(key)) continue;
		env[key] = value;
	}
	Object.assign(env, NONINTERACTIVE_WORKER_ENV);
	env.CP_HOME = home;
	const key = base.CP_GATEWAY_ADMIN_KEY || parentGatewayKey(home, mode, base); // env wins; else gateway.env (src/gateway-key.ts)
	if (key) env.CP_GATEWAY_ADMIN_KEY = key;
	env[ENV_MODE] = mode;
	env[ENV_HEADLESS] = "1";
	return env;
}

export class CpBridge {
	readonly #listeners = new Set<RelayListener>();
	#proc: WorkerProcess | undefined;
	#options: ParentStartOptions | undefined;
	#sessionFile: string | undefined;
	#stopping = false;
	#generation = 0;
	#ready = false;
	#booting = false;
	#deathsBeforeReady = 0;
	#lastReplyAt: string | undefined;
	#turn: TurnBuf = freshTurn();
	/** Between the first `agent_start` and its `agent_settled`: a follow-up can run inside one run. */
	#runOpen = false;
	#delivery: ParentDelivery | undefined;
	/** Three in a row (RELAUNCH_FAIL_CAP): stop, don't leave a dead-model parent "alive" (cur.5.4). */
	#consecutiveTurnFailed = 0;
	/** Escalation id to the text last relayed for it. */
	#seenEscalations = new Map<string, string>();
	#home: string | undefined;
	#mode: Mode | undefined;
	#controlBusy = false;
	#model: string | undefined;
	#missionEnd: string | undefined;
	#autoControl: Promise<void> | undefined;

	onRelay(listener: RelayListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async start(options: ParentStartOptions): Promise<{ already: boolean; pid?: number; sessionFile: string }> {
		if ((options.mode as string) !== "multi") throw new CpBridgeError((options.mode as string) === "single" ? SINGLE_MODE_REMOVED : `mode must be multi, got ${String(options.mode)}`);
		if (!options.home.trim()) throw new CpBridgeError("home is required");
		if (!options.model.trim()) throw new CpBridgeError("model is required");
		if (this.#proc?.alive) {
			return { already: true, pid: this.#proc.pid, sessionFile: this.#sessionFile ?? "" };
		}
		this.#stopping = false;
		configureLayout(options.mode, options.home);
		const home = options.home;
		const alive = options.isPidAlive ?? isPidAlive;
		const lock = readParentLock(home);
		if (lock.state === "unreadable") throw new CpBridgeError(`parent lock unreadable: ${lock.reason}`);
		if (lock.state === "held" && alive(lock.record.pid) && lock.record.pid !== this.#proc?.pid) {
			throw new CpBridgeError(
				`a parent already holds ${lock.path} (pid ${lock.record.pid}); refusing to start a second one`,
			);
		}
		const controlFile = join(home, LAYOUT.sessions, "cp-parent-control.json");
		let saved: { sessionFile?: string; model?: string } = {};
		try { if (existsSync(controlFile)) saved = JSON.parse(readFileSync(controlFile, "utf8")); }
		catch (error) { throw new CpBridgeError(`parent control unreadable: ${controlFile}: ${(error as Error).message}`); }
		const sessionFile = options.sessionFile ?? saved.sessionFile ?? join(home, LAYOUT.sessions, "cp-parent.jsonl");
		const model = saved.model ?? options.model;
		mkdirSync(join(sessionFile, ".."), { recursive: true });
		this.#options = { ...options, model };
		this.#model = model;
		this.#sessionFile = sessionFile;
		this.#home = home;
		this.#mode = options.mode;
		const outbox = new ParentSendOutbox({ file: parentSendFile(join(home, LAYOUT.sessions, "cp-parent.jsonl")) });
		outbox.read(); // a corrupt outbox refuses the start, naming the file
		this.#delivery = new ParentDelivery(outbox, {
			liveProc: () => (this.#proc?.alive && this.#ready && !this.#stopping ? this.#proc : undefined),
			emit: (relay) => this.#emit(relay),
			sleep: options.outerRetrySleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
			journal: (event, payload) => this.#journalOuterRetry(event, payload),
			countTurn: (failed, error) => this.#countTurn(failed, error),
			...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
		});
		await this.#spawn(sessionFile);
		this.#delivery.relaysDue();
		return { already: false, pid: this.#proc?.pid, sessionFile };
	}

	/**
	 * One durable send (`ParentDelivery.send`). An outcome inside `timeoutMs` is
	 * the tool result; otherwise the receipt is `pending` and the outcome relays
	 * by id. H1 (Pier 2.6)'s outer ladder runs inside the delivery under the same
	 * send id, in the background: a transient failure is resumed with
	 * `RESUME_NUDGE` (never `text` again), so the caller never blocks on its delays.
	 */
	async send(text: string, timeoutMs = this.#options?.settleTimeoutMs ?? DEFAULT_BRIDGE_SETTLE_MS, delegation: ParentSendDelegation = {}): Promise<BridgeReceipt> {
		if (this.#autoControl) await this.#autoControl;
		if (!this.#delivery || this.#stopping) throw new CpBridgeError("parent is not running; call cp_parent start");
		if (this.#controlBusy) throw new CpBridgeError("parent control is in progress; send later");
		return this.#delivery.send(text, timeoutMs, delegation);
	}

	/**
	 * The one place `#consecutiveTurnFailed`/the relaunch cap is accounted: once
	 * per send, from its FINAL outcome (the delivery calls it after the ladder) \u2014
	 * a ladder that retried five times over one transient failure is one send,
	 * so it never spends more than one toward `RELAUNCH_FAIL_CAP` (H1 review, finding 3).
	 */
	#countTurn(failed: boolean, error: string): void {
		this.#consecutiveTurnFailed = failed ? this.#consecutiveTurnFailed + 1 : 0;
		if (this.#consecutiveTurnFailed >= RELAUNCH_FAIL_CAP) {
			const failedCount = this.#consecutiveTurnFailed;
			this.#consecutiveTurnFailed = 0;
			this.#emit({
				kind: "relaunch",
				stale: false,
				text: `parent model failed ${failedCount} turns in a row (most recent: ${error || "unknown error"}); stopping instead of leaving a dead-model parent alive. Fix the model, then \`cp_parent start\` again.`,
				receipt: climb(emptyReceipt(), "owner_observed"),
				paths: [],
			});
			void this.stop();
		}
	}

	/**
	 * H1 review (finding 2): the bridge keeps no per-turn run log the way a job
	 * does. This is the smallest durable record it does keep now \u2014 one
	 * append-only JSONL file beside `parent.lock`, in the same `state/` this
	 * home already owns \u2014 so an outer-ladder attempt, success or exhaustion for
	 * the parent survives a restart instead of living only in the relay stream
	 * (which nothing durable consumes today). Never throws: a journal that can't
	 * write must not take the ladder down with it.
	 */
	#journalOuterRetry(
		event: "outer_retry_attempt" | "outer_retry_succeeded" | "outer_retry_exhausted" | "relay_failed",
		payload: Record<string, unknown>,
	): void {
		const home = this.#home;
		if (!home) return;
		try {
			const dir = join(home, LAYOUT.state);
			mkdirSync(dir, { recursive: true });
			const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`;
			appendFileSync(join(dir, "bridge-retry.jsonl"), line);
		} catch {
			// Best-effort durability: a journal write failing must never stall or crash the ladder.
		}
	}

	sendReceipt(id: string): BridgeReceipt | undefined {
		const entry = this.#delivery?.outbox.get(id);
		return entry ? receiptOf(entry) : undefined;
	}

	/** The main session saw the relay for `id` (`message_start` / `context`). */
	confirmObserved(id: string): boolean {
		return this.#delivery?.outbox.markObserved(id) ?? false;
	}

	/** Main-session messages: each `cp-bridge` relay carrying `details.send_id` is observed. Never throws. */
	observe(messages: unknown): void {
		if (!Array.isArray(messages)) return;
		for (const message of messages) {
			try {
				const id = sendIdOfMessage(message);
				if (id) this.confirmObserved(id);
			} catch {
				// Arrival bookkeeping must never throw into the session.
			}
		}
	}
	async statusWithContext(): Promise<ParentStatus> {
		return liveParentStatus(this.#proc, this.#ready, this.#options?.requestTimeoutMs, () => this.status(), (update) => this.#recordControl(update));
	}
	#settledProc(): WorkerProcess {
		const proc = this.#proc;
		if (!proc?.alive || !this.#ready || this.#stopping) throw new CpBridgeError("parent is not running; call cp_parent start");
		if (this.#controlBusy || proc.busy || this.#runOpen || this.#delivery?.outbox.list().some((entry) =>
			["queued", "injected", "landed"].includes(entry.state))) throw new CpBridgeError("parent must be settled with no pending send");
		return proc;
	}
	async diagnostic(action: "doctor" | "version"): Promise<ParentDiagnostic> {
		const proc = this.#settledProc();
		this.#controlBusy = true;
		try {
			return await parentDiagnostic(proc, action, this.#options?.requestTimeoutMs);
		} finally { this.#controlBusy = false; }
	}
	/** `/cp-drain` in the live parent: it writes the flag and answers at once; extension commands run beside a busy turn. */
	async drain(timeoutS: number | "cancel" = DRAIN_DEFAULT_TIMEOUT_S): Promise<ParentDiagnostic> {
		const proc = this.#proc;
		if (!proc?.alive || !this.#ready || this.#stopping) throw new CpBridgeError("parent is not running; call cp_parent start");
		return parentDiagnostic(proc, "drain", this.#options?.requestTimeoutMs, String(timeoutS));
	}
	/** `/cp-drain cancel` (cp-update's drain timeout): withdraws a draining or timed-out drain, never a drained one. */
	drainCancel(): Promise<ParentDiagnostic> {
		return this.drain("cancel");
	}
	async compact(instructions?: string): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number }> {
		const proc = this.#settledProc();
		this.#controlBusy = true;
		try {
			const customInstructions = [parentCompactInstructions(this.#home!), instructions?.trim()].filter(Boolean).join("\n\n");
			const response = await proc.request("compact", { customInstructions }, this.#options?.requestTimeoutMs ?? 120_000);
			if (response.success === false) throw new CpBridgeError(`compact rejected: ${response.error ?? "unknown error"}`);
			this.#recordControl({ lastCompactAt: new Date().toISOString(), contextTokens: (response.data as { estimatedTokensAfter?: number } | undefined)?.estimatedTokensAfter ?? null });
			return (response.data ?? {}) as { tokensBefore?: number; estimatedTokensAfter?: number };
		} finally { this.#controlBusy = false; }
	}
	async rotate(): Promise<{ sessionFile: string; archivedFile: string }> {
		const proc = this.#settledProc();
		const old = this.#sessionFile;
		if (!old || !this.#home) throw new CpBridgeError("parent session is missing");
		this.#controlBusy = true;
		try {
			const response = await proc.request("new_session", { parentSession: old }, this.#options?.requestTimeoutMs);
			if (response.success === false || (response.data as { cancelled?: boolean } | undefined)?.cancelled) throw new CpBridgeError(`new_session rejected: ${response.error ?? "cancelled"}`);
			const current = (await proc.getState(this.#options?.requestTimeoutMs)).sessionFile;
			if (!current || current === old) throw new CpBridgeError("new_session did not return a new session file");
			// Record the active file before archiving; a crash must never reopen the old one.
			atomicWriteJson(join(this.#home, LAYOUT.sessions, "cp-parent-control.json"), { sessionFile: current, model: this.#model });
			this.#sessionFile = current;
			const archivedFile = join(dirname(old), `cp-parent-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);
			if (!existsSync(old)) throw new CpBridgeError(`session file missing; cannot archive ${old}`);
			renameSync(old, archivedFile);
			this.#recordControl({ lastRotateAt: new Date().toISOString(), contextTokens: null, totalCostUsd: 0, ...(this.#missionEnd ? { lastMissionEnd: this.#missionEnd } : {}) });
			return { sessionFile: current, archivedFile };
		} finally { this.#controlBusy = false; }
	}
	async model(model: string): Promise<{ model: string }> {
		const proc = this.#settledProc();
		const slash = model.indexOf("/");
		if (slash < 1 || slash === model.length - 1 || !this.#home) throw new CpBridgeError("model needs provider/model-id");
		this.#controlBusy = true;
		try {
			const response = await proc.request("set_model", { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }, this.#options?.requestTimeoutMs);
			if (response.success === false) throw new CpBridgeError(`set_model rejected: ${response.error ?? "unknown error"}`);
			this.#model = model;
			if (this.#options) this.#options.model = model;
			atomicWriteJson(join(this.#home, LAYOUT.sessions, "cp-parent-control.json"), { sessionFile: this.#sessionFile, model });
			return { model };
		} finally { this.#controlBusy = false; }
	}
	#recordControl(update: Record<string, unknown>): void {
		if (!this.#home) return;
		atomicWriteJson(parentContextFile(this.#home), { ...parentContextStatus(this.#home), ...update });
	}

	status(): ParentStatus {
		return parentBridgeStatus(this.#home, {
			alive: this.#proc?.alive === true,
			...(this.#proc?.pid !== undefined ? { pid: this.#proc.pid } : {}),
			...(this.#sessionFile ? { sessionFile: this.#sessionFile } : {}),
			...(this.#lastReplyAt ? { lastReplyAt: this.#lastReplyAt } : {}),
			...(this.#model ? { model: this.#model } : {}),
			...(this.#delivery?.outbox.statusRows() ?? { sends: [] }),
		}, bridgePaths);
	}

	/**
	 * `discardPending` (the operator's `cp_parent stop`): sends that never landed
	 * end `undeliverable`, relayed once. Without it (session shutdown) they stay
	 * queued for the next start.
	 */
	async stop(options: { discardPending?: boolean } = {}): Promise<WorkerExit | undefined> {
		this.#stopping = true;
		const proc = this.#proc;
		if (!proc) return undefined;
		const exit = await proc.shutdown();
		this.#delivery?.failWaiters();
		if (options.discardPending) this.#delivery?.discardUnlanded("parent stopped by the operator");
		return exit;
	}

	async #spawn(sessionFile: string): Promise<void> {
		const options = this.#options;
		if (!options || !this.#home || !this.#mode) throw new CpBridgeError("start options missing");
		const extension = options.commandPostExtension ?? join(PACKAGE_ROOT, "extensions/command-post/index.ts");
		const argv = buildParentArgv({
			sessionFile,
			model: options.model,
			extension,
			skills: parentSkillPaths(this.#home),
			...(options.thinking ? { thinking: options.thinking } : {}),
		});
		const proc = WorkerProcess.spawn({
			cwd: options.cwd ?? this.#home,
			model: options.model,
			piBin: options.piBin,
			argv,
			env: parentEnv(this.#home, this.#mode),
			replaceEnv: true,
			requestTimeoutMs: options.requestTimeoutMs,
			autoCancelDialogs: true,
			onEvent: (event) => this.#onEvent(event),
		});
		this.#attach(proc);
		this.#booting = true;
		try {
			const state = await proc.getState(options.requestTimeoutMs);
			if (typeof state.sessionFile === "string" && state.sessionFile.length > 0) {
				this.#sessionFile = state.sessionFile;
			}
			this.#ready = true;
			this.#deathsBeforeReady = 0;
			this.#booting = false;
			void this.#delivery?.afterReady(proc);
		} catch (error) {
			this.#stopping = true;
			await proc.shutdown().catch(() => undefined);
			this.#stopping = false;
			this.#booting = false;
			throw error;
		}
	}

	#attach(proc: WorkerProcess): void {
		this.#proc = proc;
		this.#ready = false;
		this.#turn = freshTurn();
		this.#runOpen = false;
		const generation = ++this.#generation;
		proc.closed.then((exit) => {
			if (generation !== this.#generation) return;
			if (this.#stopping || this.#booting) return;
			this.#onDeath(exit);
		});
	}

	#onDeath(exit: WorkerExit): void {
		for (const refused of this.#turn.refused.splice(0)) this.#emit(refused);
		const sessionFile = this.#sessionFile;
		if (!this.#ready) this.#deathsBeforeReady += 1;
		this.#delivery?.failWaiters();
		if (!sessionFile) return;
		const undelivered = this.#delivery?.outbox.countUnlanded() ?? 0;
		if (this.#deathsBeforeReady >= RELAUNCH_FAIL_CAP) {
			const kept = undelivered > 0 ? ` ${undelivered} send(s) remain queued in ${this.#delivery?.outbox.file}; they deliver on the next cp_parent start.` : "";
			this.#emit({
				kind: "relaunch",
				stale: false,
				text: `parent exited (code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}) ${this.#deathsBeforeReady} times before ready; not relaunching.${kept}`,
				receipt: climb(emptyReceipt(), "owner_observed"),
				paths: [],
			});
			return;
		}
		this.#emit({
			kind: "relaunch",
			stale: false,
			text: `parent exited (code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}); relaunching same session ${sessionFile} so fleet reconcile runs at session_start. Sends that already reached the parent are not replayed; ${undelivered} undelivered send(s) are delivered once by id after ready.`,
			receipt: climb(emptyReceipt(), "owner_observed"),
			paths: [],
		});
		void this.#spawn(sessionFile).catch((error: Error) => {
			this.#emit({
				kind: "relaunch",
				stale: false,
				text: `relaunch failed: ${error.message}`,
				receipt: climb(emptyReceipt(), "owner_observed"),
				paths: [],
			});
		});
	}

	#onEvent(event: WorkerEvent): void {
		if (event.type === "agent_start") {
			if (!this.#runOpen) this.#turn = freshTurn();
			this.#runOpen = true;
			return;
		}
		if (event.type === "message_end") {
			// Only assistant messages count as replies; custom fleet notices relay directly.
			const message = event.message as { role?: unknown; customType?: unknown } | undefined;
			// Idle-bead notices and the one drain outcome wake (durable id `drain:<started>:<outcome>`) reach the operator directly.
			const drainWake = durableIdsFromMessage(message).some((id) => id.startsWith("drain:"));
			if (message?.role === "custom" && (message.customType === "cp-idle-beads" || drainWake)) this.#emit({ kind: "wake", stale: false, text: textOf(message), receipt: climb(emptyReceipt(), "owner_observed"), paths: [] });
			const stamped = jobIdOfMessage(message) ?? scheduleJobIdOf(message);
			if (stamped) { this.#turn.jobId = stamped; if (!this.#turn.jobIds.includes(stamped)) this.#turn.jobIds.push(stamped); }
			if (message?.role === "user") this.#delivery?.landed(textOf(message), this.#turn);
			if (!message || message.role !== "assistant") return;
			this.#turn.assistantCount += 1;
			const text = textOf(event.message);
			if (text.length > 0) this.#turn.texts.push(text);
			if (text.includes(STALE_WAKEUP_HEADLINE)) this.#turn.stale = true;
			// Last assistant message wins: an earlier error cleared by a later
			// successful one is not a failed turn.
			this.#turn.error = readModelCallError({
				ts: isoTimestamp(),
				job_id: "cp-bridge",
				source: "pi",
				type: "message_end",
				payload: { message: event.message },
			} as RunEvent);
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName === "cp_escalate") {
			if (event.isError === true) this.#turn.refused.push({ kind: "error", stale: false, text: textOf(event.result) || "cp_escalate was refused", receipt: climb(emptyReceipt(), "turn_settled"), paths: [] });
			else {
				// The parent fixed its call: the earlier refusals are noise to the operator.
				this.#turn.refused = [];
				this.#onEscalation(event);
			}
			return;
		}
		if (event.type === "tool_execution_end" && RISK_WARNING_TOOLS.includes(String(event.toolName))) {
			this.#onRiskWarning(event);
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName === "cp_next" && event.isError !== true) {
			this.#missionEnd = missionEndOf(event.result) ?? this.#missionEnd;
			if (this.#home) for (const item of openMissionEnds(this.#home, event.result)) this.#onEscalation({ ...event, result: { details: item } });
		}
		if (event.type === "agent_settled") {
			this.#runOpen = false;
			const turn = this.#turn;
			for (const refused of turn.refused.splice(0)) this.#emit(refused);
			const first = turn.landed[0];
			// Text before the first landed send is the parent's own turn: a wake, as ever.
			const text = (first ? turn.texts.slice(0, first.index) : turn.texts).join("\n");
			const modelError = first ? undefined : turn.error;
			if (first) {
				// H1 review (finding 3): `#consecutiveTurnFailed`/the relaunch cap are
				// not accounted here \u2014 `send`'s `#finishSend` does that exactly once
				// per `send()` call, from the FINAL receipt.
				this.#delivery?.settle(turn);
				this.#lastReplyAt = new Date().toISOString();
			}
			if (modelError) {
				this.#lastReplyAt = new Date().toISOString();
				const home = this.#home;
				this.#emit({
					kind: "error",
					...(this.#turn.jobId ? { jobId: this.#turn.jobId } : {}),
					stale: this.#turn.stale,
					text: modelError.message,
					receipt: climb(emptyReceipt(), "turn_settled"),
					paths: home && this.#turn.jobId ? bridgePaths(home, [this.#turn.jobId]) : [],
				});
			} else if (text.trim().length > 0) {
				this.#lastReplyAt = new Date().toISOString();
				const home = this.#home;
				this.#emit({
					kind: "wake",
					...(this.#turn.jobId ? { jobId: this.#turn.jobId, jobIds: [...this.#turn.jobIds] } : {}),
					stale: this.#turn.stale,
					text,
					receipt: climb(climb(emptyReceipt(), "turn_settled"), "owner_observed"),
					paths: home && this.#turn.jobId ? bridgePaths(home, [this.#turn.jobId]) : [],
				});
			}
			this.#delivery?.afterSettle();
			if (this.#home && !this.#autoControl) {
				try {
					this.#settledProc();
					this.#autoControl = autoParentContext(this.#home, this.#missionEnd, {
						settled: () => { this.#settledProc(); }, status: () => this.statusWithContext(),
						rotate: () => this.rotate(), compact: () => this.compact(),
					}).catch((error: Error) => {
						this.#emit({ kind: "error", stale: false, text: `parent automatic context control failed: ${error.message}`, receipt: emptyReceipt(), paths: [] });
					}).finally(() => { this.#autoControl = undefined; });
				} catch { /* a queued send or open turn owns the parent */ }
			}
		}
	}

	#onEscalation(event: WorkerEvent): void {
		const result = event.result as { details?: unknown; content?: unknown } | undefined;
		const parsed = asEscalation(result?.details);
		const id = parsed.id;
		if (!id || !/^es-[a-z0-9]{4,16}$/.test(id)) return;
		const content = textOf(result);
		// One relay per escalation id, unless a re-raise refreshed its numbers: then the fresh text relays.
		const shown = parsed.question ?? content;
		if (!id || this.#seenEscalations.get(id) === shown) return;
		this.#seenEscalations.set(id, shown);
		const stale = this.#turn.stale || parsed.stale || content.includes(STALE_WAKEUP_HEADLINE);
		const jobId = parsed.jobIds[0] ?? this.#turn.jobId;
		const home = this.#home;
		this.#lastReplyAt = new Date().toISOString();
		this.#emit({
			kind: "escalation",
			...(jobId ? { jobId } : {}),
			escalationId: id,
			stale,
			text: parsed.question ?? (content || `escalation ${id}`),
			receipt: climb(climb(emptyReceipt(), "turn_settled"), "owner_observed"),
			paths: home ? bridgePaths(home, parsed.jobIds, parsed.evidence) : [...parsed.evidence],
		}, {
			job_ids: parsed.jobIds.length > 0 ? parsed.jobIds : jobId ? [jobId] : [],
			...(parsed.mandateId ? { mandate_id: parsed.mandateId } : {}),
		});
	}

	/** H6: a dispatch/promotion that ran under ask_on risk:high on an inferred-only high wakes the main session with its one-line warning. */
	#onRiskWarning(event: WorkerEvent): void {
		const details = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
		const dispatch = details?.dispatch as Record<string, unknown> | undefined;
		const warning = details?.risk_warning ?? dispatch?.risk_warning;
		if (typeof warning !== "string") return;
		const id = dispatch?.job_id ?? details?.job_id;
		const jobId = typeof id === "string" && JOB_ID.test(id) ? id : undefined;
		const home = this.#home;
		this.#emit({
			kind: "wake",
			...(jobId ? { jobId } : {}),
			stale: false,
			text: warning,
			receipt: climb(emptyReceipt(), "owner_observed"),
			paths: home && jobId ? bridgePaths(home, [jobId]) : [],
		});
	}

	#emit(
		relay: BridgeRelay,
		about: { job_ids: readonly string[]; mandate_id?: string } = { job_ids: relay.jobId ? [relay.jobId] : [] },
	): void {
		// cp-project-grouped-reporting: a relay about a job (or, failing that, a
		// mandate) opens with its project.
		const home = this.#home;
		// Text the parent already opened with a bracketed project is left as written.
		if (home && (about.job_ids.length > 0 || about.mandate_id) && !/^\[[^\]\n]+\] /.test(relay.text)) {
			const projects = escalationProjects(about, homeProjectResolver(home), homeMandateProjects(home));
			relay = { ...relay, text: withProjectTag(projects, relay.text) };
		}
		const current = home ? deliverableRelay(home, relay) : relay;
		if (current) for (const listener of this.#listeners) listener(current);
	}
}

export { BRIDGE_RECEIPT_LEVELS };
