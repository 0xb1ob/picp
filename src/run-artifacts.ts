/**
 * Run artifacts — `state/runs/<job-id>/`.
 *
 * Everything observed about a worker is teed to an append-only
 * `events.jsonl`, and a `status.json` projection is derived from it. Those two
 * files are the ONLY read surface for run state: the widget, `watch`, the
 * failure classifier and the operator all read files, never process internals.
 *
 * The log is the truth; the projection is a cache. `rebuildStatus()` recovers
 * the cache from the log after a crash.
 *
 * Streaming `message_update` deltas are NOT stored (see docs/contracts.md):
 * they multiply log size by orders of magnitude and are reconstructible from
 * `message_end`. They still advance liveness and usage in the projection.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type CpEventKind,
	EMPTY_USAGE,
	type Failure,
	isoTimestamp,
	paths,
	type RunEvent,
	type RunStatus,
	SCHEMA_VERSION,
	type Usage,
	validateRunStatus,
} from "./contracts.ts";
import type { WorkerEvent, WorkerProcess } from "./worker-process.ts";

/** pi events that carry no information worth a log line of their own. */
const NON_PERSISTED_EVENT_TYPES = new Set(["message_update"]);

export interface RunMeta {
	pid?: number;
	model?: string;
	profile?: string;
	session_id?: string;
	session_file?: string;
}

export interface RunRecorderOptions {
	/** Command post home; run dir is `<home>/state/runs/<job-id>`. */
	home: string;
	jobId: string;
	/**
	 * Absolute run directory override. Used for runs that belong to a job but
	 * are not *the* job's run — a gate attempt's reviewer (T20) writes into
	 * `state/runs/<job-id>/gate-<attempt>/` so the job's own append-only log keeps
	 * its single writer.
	 */
	dir?: string;
	meta?: RunMeta;
	/** Persist streaming deltas too (debugging only). Default false. */
	recordStreamingDeltas?: boolean;
	/** Debounce for projection writes triggered by non-persisted events. */
	flushIntervalMs?: number;
	now?: () => Date;
}

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

function readUsage(value: unknown): Usage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as RawUsage;
	if (
		raw.input === undefined &&
		raw.output === undefined &&
		raw.totalTokens === undefined &&
		raw.cacheRead === undefined &&
		raw.cacheWrite === undefined
	) {
		return undefined;
	}
	const input = raw.input ?? 0;
	const output = raw.output ?? 0;
	const cacheRead = raw.cacheRead ?? 0;
	const cacheWrite = raw.cacheWrite ?? 0;
	return {
		input,
		output,
		cache_read: cacheRead,
		cache_write: cacheWrite,
		total_tokens: raw.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost_usd: raw.cost?.total ?? 0,
	};
}

function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cache_read: a.cache_read + b.cache_read,
		cache_write: a.cache_write + b.cache_write,
		total_tokens: a.total_tokens + b.total_tokens,
		cost_usd: a.cost_usd + b.cost_usd,
	};
}

export function initialStatus(jobId: string, meta: RunMeta = {}, at: string = isoTimestamp()): RunStatus {
	const status: RunStatus = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		phase: "starting",
		turns: 0,
		tool_calls: 0,
		usage: EMPTY_USAGE,
		started_at: at,
		last_activity_at: at,
		event_count: 0,
		reported: false,
	};
	return applyMeta(status, meta);
}

function applyMeta(status: RunStatus, meta: RunMeta): RunStatus {
	const next = { ...status };
	if (meta.pid !== undefined) next.pid = meta.pid;
	if (meta.model !== undefined) next.model = meta.model;
	if (meta.profile !== undefined) next.profile = meta.profile;
	if (meta.session_id !== undefined) next.session_id = meta.session_id;
	if (meta.session_file !== undefined) next.session_file = meta.session_file;
	return next;
}

/**
 * Usage accounting is split: completed assistant messages are summed into
 * `base`, and the in-flight message's cumulative usage is held separately so
 * a partially streamed turn is neither double counted nor invisible.
 */
export interface ProjectionState {
	status: RunStatus;
	baseUsage: Usage;
	currentUsage: Usage;
}

export function initialProjection(jobId: string, meta: RunMeta = {}, at?: string): ProjectionState {
	return {
		status: initialStatus(jobId, meta, at),
		baseUsage: EMPTY_USAGE,
		currentUsage: EMPTY_USAGE,
	};
}

/**
 * Is this projection past an OBSERVED close? (cp-0wq7.)
 *
 * `exited_at` is the fact; the phase follows from it. A pi event that arrives
 * after the close — pi flushing a buffered `turn_start`, a `message_start` the
 * kernel had not delivered when the child's `close` fired — belongs to a
 * process that is already gone, and must not move the projection back to
 * `working` while `exited_at` stands. That contradiction is what made
 * `validateRunStatus` refuse, `RunRecorder.open` throw, and both `cp_revive`
 * and `cp_teardown --force` dead-end on the same job.
 */
function hasExited(status: RunStatus): boolean {
	return status.exited_at !== undefined;
}

/**
 * A `cp:wakeup_suppressed` marker is the one run event that is not about this
 * run doing anything: it records a message the PARENT declined to send. A
 * later session re-checks the same queued wake-ups and re-records the same
 * markers into a job that closed hours or days ago, so advancing
 * `last_activity_at` on one made a finished job read as freshly active
 * (pi-command-post-long-idle-sessions-8sz: cp-o77y exited 12:44:31Z and merged,
 * yet carried `last_activity_at: 15:31:54Z` from suppression markers alone,
 * which is what made two ordinary overnight jobs look like 14-17h sessions).
 * The marker is still logged and still advances `event_count` — the log is the
 * history — it just does not count as activity.
 */
function isParentBookkeeping(event: RunEvent): boolean {
	return event.source === "cp" && event.type === "wakeup_suppressed";
}

/** Pure reducer: one run event in, next projection out. */
export function applyEvent(state: ProjectionState, event: RunEvent): ProjectionState {
	const status: RunStatus = {
		...state.status,
		...(isParentBookkeeping(event) ? {} : { last_activity_at: event.ts }),
		event_count: state.status.event_count + 1,
	};
	let baseUsage = state.baseUsage;
	let currentUsage = state.currentUsage;
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	// Read from the state we came in with: this event may be the exit itself.
	const afterExit = hasExited(state.status);

	if (event.source === "cp") {
		switch (event.type as CpEventKind) {
			case "spawned":
			case "worker_revived":
				Object.assign(status, applyMeta(status, payload as RunMeta));
				// A new attempt for the same job appends to the same log, so the
				// liveness fields of the previous one are cleared here. Counters and
				// usage stay cumulative: they are what the JOB cost, across attempts.
				//
				// `worker_revived` is the same fact for a relaunch (cp-8km): a live
				// process on the old session file. Without it the revived worker's
				// events landed on a projection that still carried the previous
				// `exited_at`, which is exactly the invalid status nobody could clear.
				status.phase = "starting";
				status.started_at = event.ts;
				status.current_tool = null;
				delete status.retrying;
				delete status.settled_at;
				delete status.exited_at;
				delete status.exit_code;
				break;
			case "envelope_received":
				status.reported = true;
				break;
			case "envelope_superseded":
				// The slot was reopened by a promote: this run owes a report again.
				// Without this, an idle worker that has been re-briefed still reads as
				// "reported", which is precisely the state nobody could see.
				status.reported = false;
				break;
			case "failure":
				status.failure = payload as unknown as Failure;
				break;
			case "process_exit":
				status.phase = "exited";
				status.exited_at = event.ts;
				status.exit_code = (payload.code as number | null | undefined) ?? null;
				status.current_tool = null;
				delete status.retrying;
				break;
			default:
				break;
		}
	} else if (afterExit) {
		// Post-exit pi events (cp-0wq7). They are still recorded — the log is the
		// history, and `event_count`, `last_activity_at` and usage all advance —
		// but nothing about a process that has been observed to close may set the
		// phase, the settle mark or a current tool. Only a new attempt
		// (`cp:spawned` / `cp:worker_revived`) reopens liveness.
		switch (event.type) {
			case "message_end": {
				const message = payload.message as { role?: string; usage?: unknown } | undefined;
				if (message?.role === "assistant") {
					const usage = readUsage(message.usage);
					if (usage) baseUsage = addUsage(baseUsage, usage);
					currentUsage = EMPTY_USAGE;
				}
				break;
			}
			case "turn_end":
				status.turns = status.turns + 1;
				break;
			default:
				break;
		}
	} else {
		switch (event.type) {
			case "agent_start":
				status.phase = "working";
				break;
			case "agent_settled":
				status.phase = "idle";
				status.settled_at = event.ts;
				status.current_tool = null;
				delete status.retrying;
				break;
			case "auto_retry_start":
				// pi's own retry after a transient model/API failure: the agent loop
				// restarts, which produces a pause with no tool activity and an
				// `agent_start` with no matching `agent_end`. Recorded as an observed
				// fact so the wedged-call watch can decline to flag it (cp-wedged-tool-
				// call); it is emphatically not a failure and not a wedge.
				status.retrying = true;
				if (status.current_tool) status.current_tool = { ...status.current_tool, last_progress_at: event.ts };
				break;
			case "auto_retry_end":
				delete status.retrying;
				// The loop is demonstrably running again, so anything still open is
				// not what is blocking it: the silence clock restarts from here.
				if (status.current_tool) status.current_tool = { ...status.current_tool, last_progress_at: event.ts };
				break;
			case "turn_end":
				status.turns = status.turns + 1;
				break;
			case "tool_execution_start":
				status.tool_calls = status.tool_calls + 1;
				status.current_tool = {
					name: String(payload.toolName ?? "unknown"),
					tool_call_id: String(payload.toolCallId ?? "unknown"),
					started_at: event.ts,
				};
				break;
			case "tool_execution_update": {
				// Progress, not a new call: refresh the in-flight call's progress mark
				// so a long-but-talking tool call is never mistaken for a wedged one
				// (cp-wedged-tool-call). Guarded by the id, because an update that
				// belongs to a different call proves nothing about this one.
				const current = status.current_tool;
				if (current && String(payload.toolCallId ?? "") === current.tool_call_id) {
					status.current_tool = { ...current, last_progress_at: event.ts };
				}
				break;
			}
			case "tool_execution_end":
				status.current_tool = null;
				break;
			case "message_update": {
				const usage = readUsage(payload.usage);
				if (usage) currentUsage = usage;
				break;
			}
			case "message_end": {
				const message = payload.message as { role?: string; usage?: unknown } | undefined;
				if (message?.role === "assistant") {
					const usage = readUsage(message.usage);
					if (usage) baseUsage = addUsage(baseUsage, usage);
					currentUsage = EMPTY_USAGE;
				}
				break;
			}
			default:
				break;
		}
	}

	// Session facts appear on the first event that carries them.
	const sessionId = payload.sessionId ?? payload.session_id;
	if (typeof sessionId === "string" && !status.session_id) status.session_id = sessionId;
	const sessionFile = payload.sessionFile ?? payload.session_file;
	if (typeof sessionFile === "string" && !status.session_file) status.session_file = sessionFile;

	status.usage = addUsage(baseUsage, currentUsage);
	// The invariant `validateRunStatus` enforces, kept here rather than hoped
	// for: `exited_at` set means the phase is `exited`, whatever arrived after
	// the close. A projection that cannot be written is a run that can be
	// neither revived nor torn down (cp-0wq7), so no event type — including one
	// added later — is allowed to produce that state.
	if (status.exited_at !== undefined && status.phase !== "exited") {
		status.phase = "exited";
		status.current_tool = null;
	}
	return { status, baseUsage, currentUsage };
}

/**
 * Liveness-only update for an event that is deliberately not logged
 * (streaming deltas). It advances `last_activity_at` and usage but never
 * `event_count`, so a projection rebuilt from the log matches the live one.
 */
export function applyEphemeral(state: ProjectionState, event: RunEvent): ProjectionState {
	const status: RunStatus = { ...state.status, last_activity_at: event.ts };
	let currentUsage = state.currentUsage;
	if (event.type === "message_update") {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const usage = readUsage(payload.usage);
		if (usage) currentUsage = usage;
	}
	status.usage = addUsage(state.baseUsage, currentUsage);
	return { status, baseUsage: state.baseUsage, currentUsage };
}

/** Rebuild a projection from a full event log (the log always wins). */
export function projectEvents(jobId: string, events: readonly RunEvent[], meta: RunMeta = {}): RunStatus {
	let state = initialProjection(jobId, meta, events[0]?.ts);
	for (const event of events) {
		state = applyEvent(state, event);
	}
	return state.status;
}

export function parseEventLog(text: string): RunEvent[] {
	const events: RunEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		events.push(JSON.parse(line) as RunEvent);
	}
	return events;
}

export function readEventLog(home: string, jobId: string): RunEvent[] {
	const file = join(home, paths.eventsFile(jobId));
	if (!existsSync(file)) return [];
	return parseEventLog(readFileSync(file, "utf8"));
}

/**
 * The projection as the run's writer left it. Readers get `undefined` for a run
 * that has none and for one whose file is unreadable or off-contract: a status
 * *view* must never throw on a file it does not own (crash safety says the log
 * wins, and `rebuildStatus` is how a caller that needs certainty gets it).
 */
export function readStatusFile(home: string, jobId: string): RunStatus | undefined {
	const file = join(home, paths.statusFile(jobId));
	if (!existsSync(file)) return undefined;
	try {
		const result = validateRunStatus(JSON.parse(readFileSync(file, "utf8")));
		return result.ok ? result.value : undefined;
	} catch {
		return undefined;
	}
}

/** Recover `status.json` from `events.jsonl` after a crash. */
export function rebuildStatus(home: string, jobId: string, meta: RunMeta = {}): RunStatus {
	return projectEvents(jobId, readEventLog(home, jobId), meta);
}

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

export class RunRecorder {
	readonly jobId: string;
	readonly runDir: string;
	readonly eventsFile: string;
	readonly statusFile: string;
	readonly #options: RunRecorderOptions;
	readonly #now: () => Date;
	#state: ProjectionState;
	#seq = 0;
	#flushTimer: NodeJS.Timeout | undefined;
	#dirty = false;
	#closed = false;
	#usageListener: ((previous: Usage, current: Usage) => void) | undefined;
	#usageSeen: Usage = EMPTY_USAGE;
	#detach: Array<() => void> = [];

	private constructor(options: RunRecorderOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.jobId = options.jobId;
		this.runDir = options.dir ?? join(options.home, paths.runDir(options.jobId));
		this.eventsFile = join(this.runDir, "events.jsonl");
		this.statusFile = join(this.runDir, "status.json");
		this.#state = initialProjection(options.jobId, options.meta ?? {}, isoTimestamp(this.#now()));
	}

	/**
	 * Open (or reopen) a run directory. An existing log is never truncated:
	 * the projection is rebuilt from it and new events append after it.
	 */
	static open(options: RunRecorderOptions): RunRecorder {
		const recorder = new RunRecorder(options);
		mkdirSync(recorder.runDir, { recursive: true });
		if (existsSync(recorder.eventsFile)) {
			const events = parseEventLog(readFileSync(recorder.eventsFile, "utf8"));
			recorder.#seq = events.at(-1)?.seq ?? 0;
			let state = initialProjection(options.jobId, options.meta ?? {}, events[0]?.ts);
			for (const event of events) state = applyEvent(state, event);
			recorder.#state = state;
		}
		recorder.#writeStatus();
		return recorder;
	}

	get status(): RunStatus {
		return this.#state.status;
	}

	/**
	 * One listener, replaced on every attach (a revived worker re-attaches, never stacks):
	 * called after a `message_end` whose usage advanced the run total. Never throws out.
	 */
	onUsageAdvance(listener: ((previous: Usage, current: Usage) => void) | undefined): void {
		this.#usageListener = listener;
		this.#usageSeen = this.#state.status.usage;
	}

	#notifyUsage(): void {
		const current = this.#state.status.usage;
		const previous = this.#usageSeen;
		if (!this.#usageListener || current.total_tokens === previous.total_tokens) return;
		this.#usageSeen = current;
		try {
			this.#usageListener(previous, current);
		} catch {
			// A cap check must never break the transport.
		}
	}

	get seq(): number {
		return this.#seq;
	}

	/** Append a manager marker (`source: "cp"`). */
	cp(kind: CpEventKind, payload: Record<string, unknown> = {}): RunEvent {
		return this.record("cp", kind, payload);
	}

	/** Append a verbatim pi event (`source: "pi"`). */
	pi(event: WorkerEvent): RunEvent | undefined {
		const persist = this.#options.recordStreamingDeltas === true || !NON_PERSISTED_EVENT_TYPES.has(event.type);
		if (!persist) {
			// Not logged, but it still proves liveness and carries usage.
			this.#state = applyEphemeral(this.#state, this.#makeEvent("pi", event.type, event));
			this.#scheduleFlush();
			return undefined;
		}
		return this.record("pi", event.type, event as Record<string, unknown>);
	}

	record(source: "pi" | "cp", type: string, payload: Record<string, unknown>): RunEvent {
		if (this.#closed) throw new Error(`run recorder for ${this.jobId} is closed`);
		const event = this.#makeEvent(source, type, payload, true);
		appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`);
		this.#project(event);
		this.#writeStatus();
		return event;
	}

	/**
	 * Tee a worker: every event is recorded, and the OBSERVED close is written
	 * as `cp:process_exit`. Returns a detach function.
	 */
	attach(worker: WorkerProcess): () => void {
		const off = worker.onEvent((event) => {
			try {
				this.pi(event);
			} catch {
				// Recording must never break the transport.
			}
			if (event.type === "message_end") this.#notifyUsage();
		});
		let exited = false;
		void worker.closed.then((exit) => {
			exited = true;
			if (this.#closed) return;
			try {
				this.cp("process_exit", { code: exit.code, signal: exit.signal });
			} catch {
				// The observed close is still a fact; a run dir that vanished under
				// us (teardown, a removed scratch home) must not raise here.
			}
		});
		const detach = () => {
			off();
			if (!exited) {
				// Nothing to do: the closed handler is idempotent by construction.
			}
		};
		this.#detach.push(detach);
		return detach;
	}

	/** Convenience markers used by dispatch/intake/failure paths. */
	markSpawned(meta: RunMeta): RunEvent {
		return this.cp("spawned", { ...meta });
	}

	markFailure(failure: Failure): RunEvent {
		return this.cp("failure", { ...failure });
	}

	markEnvelope(payload: Record<string, unknown>): RunEvent {
		return this.cp("envelope_received", payload);
	}

	/** Flush the projection and stop timers. Detaches nothing else. */
	close(): RunStatus {
		this.#flush();
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		for (const detach of this.#detach) detach();
		this.#detach = [];
		this.#closed = true;
		return this.#state.status;
	}

	// -- internals ----------------------------------------------------------

	#makeEvent(source: "pi" | "cp", type: string, payload: unknown, assignSeq = false): RunEvent {
		const seq = assignSeq ? ++this.#seq : this.#seq + 1;
		return {
			seq,
			ts: isoTimestamp(this.#now()),
			job_id: this.jobId,
			source,
			type,
			payload,
		};
	}

	#project(event: RunEvent): void {
		this.#state = applyEvent(this.#state, event);
	}

	#scheduleFlush(): void {
		this.#dirty = true;
		if (this.#flushTimer) return;
		const interval = this.#options.flushIntervalMs ?? 250;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flush();
		}, interval);
		this.#flushTimer.unref?.();
	}

	#flush(): void {
		if (!this.#dirty) return;
		this.#writeStatus();
	}

	#writeStatus(): void {
		const status = this.#state.status;
		const result = validateRunStatus(status);
		if (!result.ok) {
			// A projection that violates its own contract is a bug, not a file to write.
			throw new Error(`run status projection is invalid for ${this.jobId}:\n  ${result.errors.join("\n  ")}`);
		}
		atomicWrite(this.statusFile, `${JSON.stringify(status, null, 2)}\n`);
		this.#dirty = false;
	}
}
