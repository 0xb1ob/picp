/**
 * WorkerProcess — the only way pi-command-post talks to a worker.
 *
 * A worker is a `pi --mode rpc` child process. Delivery is an id-correlated
 * RPC request/response pair, so a receipt is a fact, not a heuristic. Busy and
 * idle come from `agent_start` / `agent_settled` events. Death is an OBSERVED
 * child close, never inferred from age or silence.
 *
 * Framing is strict LF JSONL (docs/rpc.md): split on `\n` only, tolerate a
 * trailing `\r`, never `node:readline` (it also splits on U+2028/U+2029, which
 * are legal inside JSON strings).
 *
 * ## In-flight dialogs are owned here (cp-xbxz)
 *
 * A worker's `ctx.ui.*` dialog is a request this transport must answer, so an
 * *unanswered* one is state — and until cp-xbxz it was the one piece of state
 * observed death did not touch. A planner that died with its `ask_operator`
 * dialog open left the operator's TUI dialog up until pi's own 10-minute
 * timeout, dropped their answer into a destroyed stdin without a word, and let
 * `questions.jsonl` record `answered` for a worker that never received
 * anything. The journal lied.
 *
 * So every dialog this transport accepts is tracked by id (`pendingDialogs()`),
 * carries an `AbortSignal` that fires the moment the child's close is OBSERVED,
 * and is answered through a public `answerDialog()` that returns **false**
 * rather than pretending: a gone child, an unknown id, an already-answered
 * dialog. The relay's own path resolves with `worker_exited`
 * (`QuestionOutcome`), never `answered`.
 *
 * ## Reading a worker's transcript belongs here too
 *
 * `getEntries()` is transport: this module is the only thing that speaks to a
 * worker. Dialogs are answered by the parent relay, not by a console.
 *
 * ## Events are a fan-out, and `message_update` is a delta
 *
 * `onEvent` listeners see every event line, in arrival order. Since pi 0.84.0
 * `message_update` carries **only** `assistantMessageEvent` — a delta — and no
 * cumulative `message` snapshot (docs/rpc.md §message_update). A console that
 * streams a planner's turn therefore assembles text from `text_start` /
 * `text_delta` / `text_end` by `contentIndex` and treats `message_end.message`
 * as authoritative; it can never read a whole message off one
 * `message_update`. `src/run-artifacts.ts` does not persist these deltas at
 * all, which is why the run log stays a history rather than a stream.
 *
 * Scope boundary: this module owns the transport. Run artifacts (T4), profiles
 * (T6), spawn safety policy beyond the contract flags (T7) and dispatch (T14)
 * live elsewhere and consume this.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	type SendReceipt,
	type ThinkingLevel,
	WORKER_FORBIDDEN_FLAGS,
	WORKER_REQUIRED_FLAGS,
} from "./contracts.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** Keep the stderr ring small: it exists to explain failures, not to log. */
export const STDERR_TAIL_MAX_CHARS = 8_000;

/** One `get_entries` row. Loose on purpose: a reader that hard-fails on an unseen shape is worse than one that skips it. */
export interface SessionEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string | number;
	message?: { role?: string; content?: unknown; [key: string]: unknown };
	[key: string]: unknown;
}

/** Tail window for `getEntries`. The session file stays complete. */
export const TRANSCRIPT_MAX_ENTRIES = 400;

export interface WorkerSpawnOptions {
	/** Leased worktree. The worker never changes directory. */
	cwd: string;
	/** `provider/model-id` (already resolved by routing). */
	model: string;
	/** Extension files loaded with `-e` (worker-reporter, and nothing else in prod). */
	extensions?: readonly string[];
	/**
	 * Skill directories loaded with `--skill` (additive even with `--no-skills`).
	 * Empty in prod unless this home has an optional worker package installed
	 * (src/worker-packages.ts).
	 */
	skills?: readonly string[];
	/** Tool allowlist from the profile. Empty array means "no tools". */
	tools?: readonly string[];
	thinking?: ThinkingLevel;
	/** Session persistence: a directory for a new session, or a file to revive. */
	sessionDir?: string;
	sessionFile?: string;
	sessionName?: string;
	appendSystemPrompt?: string;
	env?: NodeJS.ProcessEnv;
	/** Binary to exec. Tests override; production uses `pi` from PATH. */
	piBin?: string;
	/** Appended verbatim after the policy flags. */
	extraArgs?: readonly string[];
	/**
	 * Full argv. Skips worker trust flags. The parent bridge uses this so the
	 * child is a headless CP parent, not a worker.
	 */
	argv?: readonly string[];
	/**
	 * When true, `env` replaces the inherited environment instead of overlaying
	 * it. Callers that already built a hygienic env (no stray `CP_*`) need this:
	 * an overlay cannot delete keys the parent process holds.
	 */
	replaceEnv?: boolean;
	requestTimeoutMs?: number;
	shutdownGraceMs?: number;
	/**
	 * Answer worker-side dialog requests with "cancelled" instead of hanging.
	 * Default true: a worker has no operator to ask — it must report `blocked`.
	 */
	autoCancelDialogs?: boolean;
	/**
	 * Relay a worker's dialog to a real operator (T31). When set, this decides
	 * the answer instead of the blanket cancel; it must resolve, and anything it
	 * throws is treated as "no answer". `autoCancelDialogs: false` still means
	 * "leave the dialog alone", which only a test should want.
	 */
	onDialog?: (request: WorkerDialogRequest) => Promise<WorkerDialogAnswer>;
	onEvent?: WorkerEventListener;
	onProtocolError?: (line: string, error: Error) => void;
}

export interface WorkerEvent {
	type: string;
	[key: string]: unknown;
}

export type WorkerEventListener = (event: WorkerEvent) => void;

/** A worker-side `ctx.ui.*` dialog, as it arrives on stdout (docs/rpc.md). */
export interface WorkerDialogRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	options?: unknown;
	timeout?: number;
	/**
	 * Aborted the moment this worker's close is OBSERVED (cp-xbxz).
	 *
	 * Pass it straight to the parent's `ctx.ui.select`/`ctx.ui.input`
	 * (`{ signal }`) so an operator's dialog for a dead planner closes itself
	 * instead of sitting there until pi's own timeout, and race it in any relay
	 * that decides an outcome — an asker that ignores the signal must still not
	 * be able to make the transport hang or the journal say `answered`.
	 */
	signal?: AbortSignal;
}

/** The three shapes `extension_ui_response` accepts. */
export type WorkerDialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface WorkerResponse {
	type: "response";
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	[key: string]: unknown;
}

export interface WorkerExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	at: number;
}

export interface WorkerState {
	model?: { id?: string; provider?: string } | null;
	isStreaming?: boolean;
	sessionFile?: string;
	sessionId?: string;
	messageCount?: number;
	pendingMessageCount?: number;
	[key: string]: unknown;
}

/** What `getEntries()` hands back: a bounded window, and the cursor to resume from. */
export interface WorkerTranscript {
	/** At most `TRANSCRIPT_MAX_ENTRIES`, oldest first — the tail is kept. */
	entries: SessionEntry[];
	/** Current leaf entry id, or null for an empty session. A durable cursor. */
	leafId: string | null;
	/** How many older entries the cap dropped. The session file stays complete. */
	dropped: number;
}

export class WorkerError extends Error {}

/** Build the argv for a worker. Trust policy comes from src/contracts.ts. */
export function buildWorkerArgs(options: WorkerSpawnOptions): string[] {
	for (const arg of options.extraArgs ?? []) {
		if (WORKER_FORBIDDEN_FLAGS.includes(arg)) {
			throw new WorkerError(`forbidden worker flag ${arg} (see WORKER_FORBIDDEN_FLAGS)`);
		}
	}
	const args: string[] = [...WORKER_REQUIRED_FLAGS];
	if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	} else if (options.sessionDir) {
		args.push("--session-dir", options.sessionDir);
	}
	if (options.sessionName) args.push("--name", options.sessionName);
	args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.tools) args.push("--tools", options.tools.join(","));
	if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
	for (const extension of options.extensions ?? []) {
		args.push("-e", extension);
	}
	for (const skill of options.skills ?? []) {
		args.push("--skill", skill);
	}
	args.push(...(options.extraArgs ?? []));
	return args;
}

/**
 * Strict LF framing: split on `\n` only, strip one trailing `\r`, keep the
 * remainder for the next chunk. U+2028/U+2029 are ordinary characters here,
 * which is exactly why `node:readline` cannot be used for this protocol.
 */
export function consumeJsonLines(buffer: string): { lines: string[]; rest: string } {
	const lines: string[] = [];
	let rest = buffer;
	let index = rest.indexOf("\n");
	while (index !== -1) {
		const raw = rest.slice(0, index);
		rest = rest.slice(index + 1);
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.length > 0) lines.push(line);
		index = rest.indexOf("\n");
	}
	return { lines, rest };
}

interface Pending {
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	command: string;
}

/** A dialog this transport has accepted and not yet answered. */
interface InFlightDialog {
	request: WorkerDialogRequest;
	controller: AbortController;
	answered: boolean;
}

interface Waiter {
	predicate: (event: WorkerEvent) => boolean;
	resolve: (event: WorkerEvent) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

export class WorkerProcess {
	readonly #child: ChildProcess;
	readonly #options: WorkerSpawnOptions;
	readonly #pending = new Map<string, Pending>();
	readonly #listeners = new Set<WorkerEventListener>();
	readonly #waiters = new Set<Waiter>();
	readonly #dialogs = new Map<string, InFlightDialog>();
	readonly #closed: Promise<WorkerExit>;
	#stdout = "";
	#stderr = "";
	#seq = 0;
	#exit: WorkerExit | undefined;
	#busy = false;
	#settledCount = 0;
	#spawnError: Error | undefined;

	private constructor(child: ChildProcess, options: WorkerSpawnOptions) {
		this.#child = child;
		this.#options = options;
		if (options.onEvent) this.#listeners.add(options.onEvent);

		this.#closed = new Promise<WorkerExit>((resolve) => {
			child.on("close", (code, signal) => {
				const exit: WorkerExit = { code, signal, at: Date.now() };
				this.#exit = exit;
				this.#failAllPending(
					new WorkerError(
						`worker exited (code=${code ?? "null"} signal=${signal ?? "null"}) before responding${this.#stderrSuffix()}`,
					),
				);
				resolve(exit);
			});
		});

		child.on("error", (error) => {
			this.#spawnError = error;
			this.#failAllPending(new WorkerError(`worker process error: ${error.message}`));
		});

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.#consume(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
		});
	}

	/**
	 * Spawn the child. Returns immediately: readiness is proven by the first
	 * successful request (usually `get_state` or the dispatch `prompt`), never
	 * by a sleep.
	 */
	static spawn(options: WorkerSpawnOptions): WorkerProcess {
		const args = options.argv ? [...options.argv] : buildWorkerArgs(options);
		const child = spawn(options.piBin ?? "pi", args, {
			cwd: options.cwd,
			env: options.replaceEnv ? options.env : { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new WorkerProcess(child, options);
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	/** Resolves when the child close was OBSERVED. This is the death contract. */
	get closed(): Promise<WorkerExit> {
		return this.#closed;
	}

	get exit(): WorkerExit | undefined {
		return this.#exit;
	}

	get alive(): boolean {
		return this.#exit === undefined;
	}

	/** True between `agent_start` and the matching `agent_settled`. */
	get busy(): boolean {
		return this.#busy;
	}

	/** Number of `agent_settled` events observed so far. */
	get settledCount(): number {
		return this.#settledCount;
	}

	stderrTail(): string {
		return this.#stderr;
	}

	onEvent(listener: WorkerEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Raw id-correlated request. Rejects on timeout, `success:false`, or death. */
	async request(type: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<WorkerResponse> {
		if (this.#exit) {
			throw new WorkerError(`worker is not alive (exit code=${this.#exit.code ?? "null"}); cannot send ${type}`);
		}
		if (this.#spawnError) {
			throw new WorkerError(`worker failed to spawn: ${this.#spawnError.message}`);
		}
		this.#seq += 1;
		const id = `cp-${this.#seq}`;
		const limit = timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const line = `${JSON.stringify({ ...params, id, type })}\n`;

		return new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new WorkerError(`timeout after ${limit}ms waiting for response to ${type}${this.#stderrSuffix()}`));
			}, limit);
			this.#pending.set(id, { resolve, reject, timer, command: type });
			const stdin = this.#child.stdin;
			if (!stdin || stdin.destroyed) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(new WorkerError(`worker stdin is closed; cannot send ${type}`));
				return;
			}
			stdin.write(line, (error) => {
				if (error) {
					clearTimeout(timer);
					this.#pending.delete(id);
					reject(new WorkerError(`failed to write ${type} to worker: ${error.message}`));
				}
			});
		});
	}

	/**
	 * `streamingBehavior` queues the message during an active run and otherwise
	 * starts one; pi reports which in `data.disposition` (pi >= 0.99.1).
	 */
	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<WorkerResponse> {
		const params: Record<string, unknown> = { message };
		if (streamingBehavior) params.streamingBehavior = streamingBehavior;
		return this.#expectOk("prompt", params);
	}

	async steer(message: string): Promise<WorkerResponse> {
		return this.#expectOk("steer", { message });
	}

	async followUp(message: string): Promise<WorkerResponse> {
		return this.#expectOk("follow_up", { message });
	}

	/**
	 * Delivery with a receipt instead of an exception. The receipt is pi's
	 * per-input `data.disposition`: `queued` → queued; `started`/`handled` →
	 * delivered. Without one (pi < 0.99.1) a bare prompt is delivered — pi
	 * rejects a bare prompt during a run, so an accepted one never queued — and
	 * steer/follow_up or a prompt with `streamingBehavior` is queued. `failed`:
	 * rejected, timed out, or the worker is gone.
	 */
	async send(
		message: string,
		mode: "prompt" | "steer" | "follow_up" = "prompt",
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ receipt: SendReceipt; disposition?: string; error?: string }> {
		try {
			const response =
				mode === "steer"
					? await this.steer(message)
					: mode === "follow_up"
						? await this.followUp(message)
						: await this.prompt(message, streamingBehavior);
			const disposition = (response.data as { disposition?: unknown } | undefined)?.disposition;
			const receipt: SendReceipt =
				disposition === "queued"
					? "queued"
					: disposition === "started" || disposition === "handled"
						? "delivered"
						: mode === "prompt" && !streamingBehavior
							? "delivered"
							: "queued";
			return { receipt, ...(typeof disposition === "string" ? { disposition } : {}) };
		} catch (error) {
			return { receipt: "failed", error: (error as Error).message };
		}
	}

	async getState(timeoutMs?: number): Promise<WorkerState> {
		const response = await this.#expectOk("get_state", {}, timeoutMs);
		return (response.data as WorkerState | undefined) ?? {};
	}

	async abort(): Promise<WorkerResponse> {
		return this.#expectOk("abort");
	}

	/**
	 * Session entries in append order, bounded (pi ≥ 0.80.3 `get_entries`).
	 *
	 * `since` is an entry id and a durable cursor: pass the last id you rendered
	 * and only what came after it arrives, across restarts and across compaction
	 * (unlike `get_messages`, this includes pre-compaction history). An unknown
	 * `since` is rejected by pi, which surfaces here as a `WorkerError` — a
	 * console that has lost its place re-reads from the start rather than
	 * guessing.
	 *
	 * The window is capped at `TRANSCRIPT_MAX_ENTRIES` and keeps the tail.
	 * `dropped` says how much the cap cut; nothing is lost on disk.
	 */
	async getEntries(since?: string, timeoutMs?: number): Promise<WorkerTranscript> {
		const response = await this.#expectOk("get_entries", since === undefined ? {} : { since }, timeoutMs);
		const data = (response.data ?? {}) as { entries?: unknown; leafId?: unknown };
		const all = Array.isArray(data.entries) ? (data.entries as SessionEntry[]) : [];
		const entries = all.length > TRANSCRIPT_MAX_ENTRIES ? all.slice(-TRANSCRIPT_MAX_ENTRIES) : all;
		return {
			entries,
			leafId: typeof data.leafId === "string" ? data.leafId : null,
			dropped: all.length - entries.length,
		};
	}

	// -- dialogs a console can see, hold and answer (cp-xbxz) ----------------

	/**
	 * Dialogs this transport has accepted and not yet answered, oldest first.
	 *
	 * An open dialog is one of these. `answerDialog` is how an answer reaches the
	 * worker. Empty is the normal state.
	 */
	pendingDialogs(): WorkerDialogRequest[] {
		return [...this.#dialogs.values()].filter((dialog) => !dialog.answered).map((dialog) => dialog.request);
	}

	/**
	 * Answer one in-flight dialog. **The boolean is the fact**: `true` means the
	 * `extension_ui_response` was written to a live child's stdin, and `false`
	 * means it was not — the child is gone, the id is unknown, or that dialog was
	 * already answered.
	 *
	 * Public and truthful because a console can hold a dialog open for as long as
	 * the operator takes, and the thing it must never do is tell them their
	 * answer landed when the planner it was for had already died. The old private
	 * version returned `void` and wrote into a destroyed stdin in silence, which
	 * is precisely how `questions.jsonl` came to record `answered` for an answer
	 * nobody received.
	 */
	answerDialog(id: string, answer: WorkerDialogAnswer): boolean {
		const dialog = this.#dialogs.get(id);
		if (!dialog || dialog.answered) return false;
		if (!this.#canAnswer()) return false;
		const stdin = this.#child.stdin as NonNullable<ChildProcess["stdin"]>;
		dialog.answered = true;
		this.#dialogs.delete(id);
		try {
			stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...answer })}\n`);
		} catch (error) {
			// The stream broke under us: nobody received this answer, so abort the
			// signal too. A relay still waiting on that dialog resolves `worker_exited`
			// instead of waiting for a delivery that already failed.
			dialog.controller.abort(error instanceof Error ? error : new WorkerError(String(error)));
			return false;
		}
		return true;
	}

	/**
	 * Resolve on the next matching event. Rejects on timeout or worker death.
	 *
	 * Only events that arrive AFTER registration are considered — there is no
	 * replay buffer. Register the waiter before the send that should trigger it,
	 * or use `onEvent` (registered at spawn) for anything that must not be missed.
	 */
	waitForEvent(predicate: (event: WorkerEvent) => boolean, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<WorkerEvent> {
		return new Promise<WorkerEvent>((resolve, reject) => {
			const waiter: Waiter = { predicate, resolve, reject };
			const settle = (fn: () => void) => {
				this.#waiters.delete(waiter);
				if (waiter.timer) clearTimeout(waiter.timer);
				fn();
			};
			waiter.resolve = (event) => settle(() => resolve(event));
			waiter.reject = (error) => settle(() => reject(error));
			waiter.timer = setTimeout(
				() => waiter.reject(new WorkerError(`timeout after ${timeoutMs}ms waiting for event${this.#stderrSuffix()}`)),
				timeoutMs,
			);
			this.#waiters.add(waiter);
			if (this.#exit) {
				waiter.reject(new WorkerError("worker already exited; event will never arrive"));
			}
		});
	}

	/** Resolve when the current run settles (no retry/compaction/queue left). */
	waitForSettled(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<WorkerEvent> {
		return this.waitForEvent((event) => event.type === "agent_settled", timeoutMs);
	}

	/**
	 * Graceful shutdown: close stdin (pi exits when the command stream ends),
	 * wait for the grace period, then SIGTERM, then SIGKILL. Always resolves
	 * with the OBSERVED exit.
	 */
	async shutdown(graceMs?: number): Promise<WorkerExit> {
		if (this.#exit) return this.#exit;
		const grace = graceMs ?? this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		try {
			this.#child.stdin?.end();
		} catch {
			// stdin already gone; SIGTERM below is the fallback.
		}
		const graceful = await this.#raceExit(grace);
		if (graceful) return graceful;

		this.#child.kill("SIGTERM");
		const terminated = await this.#raceExit(DEFAULT_KILL_GRACE_MS);
		if (terminated) return terminated;

		this.#child.kill("SIGKILL");
		return this.#closed;
	}

	/** Last resort. Prefer `shutdown()`; teardown requires an observed close. */
	async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<WorkerExit> {
		if (this.#exit) return this.#exit;
		this.#child.kill(signal);
		return this.#closed;
	}

	// -- internals ----------------------------------------------------------

	async #expectOk(type: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<WorkerResponse> {
		const response = await this.request(type, params, timeoutMs);
		if (response.success === false) {
			throw new WorkerError(`${type} rejected by worker: ${response.error ?? "unknown error"}`);
		}
		return response;
	}

	async #raceExit(ms: number): Promise<WorkerExit | undefined> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), ms);
		});
		try {
			return await Promise.race([this.#closed, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	#stderrSuffix(): string {
		const tail = this.#stderr.trim();
		return tail.length > 0 ? `\nworker stderr tail:\n${tail}` : "";
	}

	#consume(chunk: string): void {
		const { lines, rest } = consumeJsonLines(this.#stdout + chunk);
		this.#stdout = rest;
		for (const line of lines) {
			this.#handleLine(line);
		}
	}

	#handleLine(line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch (error) {
			this.#options.onProtocolError?.(line, error as Error);
			return;
		}
		const type = typeof record.type === "string" ? record.type : "";
		if (type === "response") {
			const id = typeof record.id === "string" ? record.id : undefined;
			const pending = id ? this.#pending.get(id) : undefined;
			if (pending && id) {
				this.#pending.delete(id);
				clearTimeout(pending.timer);
				pending.resolve(record as WorkerResponse);
				return;
			}
			// Unsolicited response (e.g. a parse error for a malformed line).
			this.#options.onProtocolError?.(
				line,
				new WorkerError(`unmatched response for command ${String(record.command ?? "?")}`),
			);
			return;
		}
		if (type === "extension_ui_request") {
			this.#handleUiRequest(record);
			// Still visible to listeners: a worker's notify is useful telemetry.
		}
		if (type === "agent_start") {
			this.#busy = true;
		} else if (type === "agent_settled") {
			this.#busy = false;
			this.#settledCount += 1;
		}
		this.#emit(record as WorkerEvent);
	}

	/**
	 * A worker's dialog gets exactly one of two answers, and both are decided
	 * here rather than by waiting.
	 *
	 * Default (no `onDialog`): "cancelled" — fail closed. There is normally no
	 * operator behind a worker, and the extension seeing `undefined`/`false` is
	 * what makes it report a blocker instead of stalling.
	 *
	 * With `onDialog` (T31): the relay decides. It may put the question in front
	 * of a real human, but it owns the deadline; if it throws or never resolves
	 * cleanly we fall back to the cancel, because a worker blocked on a dialog
	 * nobody will answer is the one outcome this transport must not produce.
	 */
	#handleUiRequest(record: Record<string, unknown>): void {
		const method = typeof record.method === "string" ? record.method : "";
		if (!["select", "confirm", "input", "editor"].includes(method)) return;
		const id = record.id;
		if (typeof id !== "string") return;
		const controller = new AbortController();
		const request: WorkerDialogRequest = {
			id,
			method,
			...(typeof record.title === "string" ? { title: record.title } : {}),
			...(typeof record.message === "string" ? { message: record.message } : {}),
			...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
			...(record.options !== undefined ? { options: record.options } : {}),
			...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}),
			signal: controller.signal,
		};
		// Tracked BEFORE it is answered, always: `answerDialog` refuses an id it has
		// never seen, and the auto-cancel below goes through the same public door as
		// a console's answer.
		this.#dialogs.set(id, { request, controller, answered: false });
		if (!this.#canAnswer()) {
			// A dialog that arrives when no answer can ever be written back: the child
			// has exited, or its stdin has been ended by `shutdown()` while it was
			// still mid-turn. Abort the signal *before* the relay sees the request, so
			// the relay closes the exchange `worker_exited` on the spot and no human
			// is asked a question whose answer has nowhere to go. It is still handed
			// to the relay: a question that arrived is a question that gets journaled.
			this.#abandonDialogs(new WorkerError("worker cannot be answered: its stdin is gone"));
		}
		const relay = this.#options.onDialog;
		if (!relay) {
			if (this.#options.autoCancelDialogs === false) return;
			this.answerDialog(id, { cancelled: true });
			return;
		}
		void relay(request)
			.then((answer) => this.answerDialog(id, answer))
			.catch((error: unknown) => {
				this.#options.onProtocolError?.(
					`extension_ui_request ${id}`,
					new WorkerError(`dialog relay failed: ${(error as Error).message}`),
				);
				this.answerDialog(id, { cancelled: true });
			});
	}

	/**
	 * Can an `extension_ui_response` still reach this child at all? One predicate,
	 * used by both the answer path and the arrival path, so "answered" and
	 * "answerable" can never disagree: an observed exit, a destroyed stdin, or a
	 * stdin `shutdown()` has already ended all mean no.
	 */
	#canAnswer(): boolean {
		if (this.#exit) return false;
		const stdin = this.#child.stdin;
		return stdin !== null && stdin !== undefined && !stdin.destroyed && !stdin.writableEnded;
	}

	/**
	 * Every in-flight dialog is abandoned with a reason, once, on observed death.
	 *
	 * Aborting the per-dialog signal is what makes this definite rather than a
	 * hope: the operator's `ctx.ui.*` closes because it was handed `{ signal }`,
	 * and a relay that races the signal resolves `worker_exited` instead of
	 * waiting out a deadline that can no longer mean anything. The dialogs are
	 * dropped from the map first, so a late `answerDialog` for one of them is
	 * `false` on two independent counts.
	 */
	#abandonDialogs(error: Error): void {
		for (const [id, dialog] of [...this.#dialogs]) {
			this.#dialogs.delete(id);
			if (dialog.answered) continue;
			try {
				dialog.controller.abort(error);
			} catch {
				// An abort listener that throws is not this transport's problem.
			}
		}
	}

	#emit(event: WorkerEvent): void {
		for (const waiter of [...this.#waiters]) {
			let matched = false;
			try {
				matched = waiter.predicate(event);
			} catch {
				matched = false;
			}
			if (matched) waiter.resolve(event);
		}
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// A broken listener must never take down the transport.
			}
		}
	}

	#failAllPending(error: Error): void {
		this.#abandonDialogs(error);
		for (const [id, pending] of [...this.#pending]) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		for (const waiter of [...this.#waiters]) {
			waiter.reject(error);
		}
	}
}
