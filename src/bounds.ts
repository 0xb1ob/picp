/**
 * Per-job hard bounds (wall-clock since spawn or the last delivered idle
 * promotion, tool-call starts).
 *
 * Soft dollar/token budgets still escalate and never kill. These two bounds
 * stop the worker: graceful close, then SIGTERM/SIGKILL on the existing
 * observed-close path. The worktree is not touched.
 *
 * A silent tool call still produces `cp-wedged` at 30 minutes. The same
 * wall-clock cap is the hard threshold: an open call that old is recorded
 * `wall_clock_exceeded` rather than observed forever.
 *
 * Mission-level caps (total spend, total jobs) are declared on the contract
 * and enforced by the mandate ticket, not here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BOUND_MESSAGE_TYPE,
	DEFAULT_JOB_TOOL_CALL_CAP,
	DEFAULT_JOB_WALL_CLOCK_SECONDS,
	type Failure,
	isoTimestamp,
	type JobHardBounds,
	LAYOUT,
	type UnreportedWork,
	describeUnreportedWork,
} from "./contracts.ts";
import type { FailJob } from "./failure-announcer.ts";
import type { FleetStore } from "./fleet.ts";
import type { RunRegistry } from "./runs.ts";
import type { WorkerEvent, WorkerProcess } from "./worker-process.ts";
import { inspectWorktreeWork } from "./worktree-work.ts";

export { BOUND_MESSAGE_TYPE };

export const HARD_BOUND_CLASSES = ["wall_clock_exceeded", "tool_call_cap_exceeded"] as const;
export type HardBoundClass = (typeof HARD_BOUND_CLASSES)[number];

export interface BoundBreach {
	class: HardBoundClass;
	bound: "wall_clock" | "tool_call_cap";
	limit: number;
	measured: number;
	unit: "seconds" | "starts";
}

export interface HardBoundOverride {
	wall_clock_seconds?: number;
	tool_call_cap?: number;
}

/** A positive env integer (floored), or undefined when absent, blank, non-finite or ≤0. */
export function parsePositiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
}

function positiveInt(raw: string | undefined, fallback: number): number {
	return parsePositiveInt(raw) ?? fallback;
}

/** `CP_JOB_WALL_CLOCK_SECONDS` or 90 minutes. A typo keeps the default. */
export function jobWallClockSeconds(env: NodeJS.ProcessEnv = process.env): number {
	return positiveInt(env.CP_JOB_WALL_CLOCK_SECONDS, DEFAULT_JOB_WALL_CLOCK_SECONDS);
}

/** `CP_JOB_TOOL_CALL_CAP` or 900 starts. A typo keeps the default. */
export function jobToolCallCap(env: NodeJS.ProcessEnv = process.env): number {
	return positiveInt(env.CP_JOB_TOOL_CALL_CAP, DEFAULT_JOB_TOOL_CALL_CAP);
}

export class WorkerBoundsConfigError extends Error {}

/**
 * Home-local `data/worker-bounds.json`, or undefined when the file is absent.
 * `wall_clock_seconds`, when present, must be a positive integer;
 * `allow_dispatch_override` (cp-7re9), when present, must be a boolean. A
 * present file with neither, or with an invalid one, refuses naming the file
 * and field: a cap the operator wrote must never silently fall back. Unknown
 * keys are ignored. This is the path that survives the parent launch — `CP_*`
 * env is stripped.
 */
export function homeWorkerBounds(home: string): { wall_clock_seconds?: number; allow_dispatch_override: boolean } | undefined {
	const file = join(home, LAYOUT.workerBoundsFile);
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new WorkerBoundsConfigError(`${file} is not valid JSON (${(error as Error).message}); fix or remove it`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new WorkerBoundsConfigError(`${file} must be a JSON object like {"wall_clock_seconds": 5400}; fix or remove it`);
	}
	const record = parsed as Record<string, unknown>;
	const flag = record.allow_dispatch_override;
	if (flag !== undefined && typeof flag !== "boolean") {
		throw new WorkerBoundsConfigError(
			`${file} allow_dispatch_override must be true or false, got ${JSON.stringify(flag)}; fix or remove the field`,
		);
	}
	const wall = record.wall_clock_seconds;
	if (flag === undefined || wall !== undefined) {
		if (typeof wall !== "number" || !Number.isInteger(wall) || wall < 1) {
			throw new WorkerBoundsConfigError(
				`${file} wall_clock_seconds must be a positive integer (seconds), got ${JSON.stringify(wall)}; fix or remove the field`,
			);
		}
	}
	return { ...(wall !== undefined ? { wall_clock_seconds: wall as number } : {}), allow_dispatch_override: flag ?? true };
}

/** Home-local `data/worker-bounds.json` `wall_clock_seconds`, or undefined when absent (file or field); refuses as `homeWorkerBounds`. */
export function homeWallClockSeconds(home: string): number | undefined {
	return homeWorkerBounds(home)?.wall_clock_seconds;
}

/**
 * Wall clock: explicit override > home `data/worker-bounds.json` > env > default.
 * Tool-call cap: explicit override > env > default. Resolve once at dispatch and
 * freeze the result on the record; revive/redispatch reuse the frozen value.
 * With a home whose file says `allow_dispatch_override: false` (cp-7re9), an
 * explicit override that differs from the machine value (home or env or
 * default) refuses instead of winning; an equal one passes. A home file is
 * read whenever `home` is given, override or not, so a broken file refuses.
 */
export function resolveJobHardBounds(
	override: HardBoundOverride | undefined = undefined,
	env: NodeJS.ProcessEnv = process.env,
	home?: string,
): JobHardBounds {
	const policy = home !== undefined ? homeWorkerBounds(home) : undefined;
	const machine = { wall_clock_seconds: policy?.wall_clock_seconds ?? jobWallClockSeconds(env), tool_call_cap: jobToolCallCap(env) };
	const bound = (name: keyof JobHardBounds): number => {
		const value = override?.[name];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return machine[name];
		const floored = Math.floor(value);
		if (policy?.allow_dispatch_override === false && floored !== machine[name]) {
			throw new WorkerBoundsConfigError(
				`settings: ${name} override ${floored} conflicts with enforced machine value ${machine[name]} (${LAYOUT.workerBoundsFile} allow_dispatch_override=false)`,
			);
		}
		return floored;
	};
	return { wall_clock_seconds: bound("wall_clock_seconds"), tool_call_cap: bound("tool_call_cap") };
}

/**
 * Pure: which bound, if any, this snapshot has crossed.
 * Tool-call cap wins when both are over — it is the more specific cause.
 */
export function detectHardBound(
	bounds: JobHardBounds,
	measured: { elapsedSeconds: number; toolStarts: number; currentToolSeconds?: number },
): BoundBreach | undefined {
	if (measured.toolStarts >= bounds.tool_call_cap) {
		return {
			class: "tool_call_cap_exceeded",
			bound: "tool_call_cap",
			limit: bounds.tool_call_cap,
			measured: measured.toolStarts,
			unit: "starts",
		};
	}
	const clock = Math.max(measured.elapsedSeconds, measured.currentToolSeconds ?? 0);
	if (clock >= bounds.wall_clock_seconds) {
		return {
			class: "wall_clock_exceeded",
			bound: "wall_clock",
			limit: bounds.wall_clock_seconds,
			measured: clock,
			unit: "seconds",
		};
	}
	return undefined;
}

export function boundFailureMessage(breach: BoundBreach): string {
	const unit = breach.unit === "seconds" ? "s" : " starts";
	return `${breach.bound} bound ${breach.limit}${unit} exceeded (measured ${breach.measured}${unit})`;
}

export function formatBoundNotice(jobId: string, breach: BoundBreach, work: UnreportedWork): string {
	const unit = breach.unit === "seconds" ? "s" : " starts";
	return [
		`HARD BOUND — ${jobId} hit ${breach.bound} ${breach.limit}${unit} (measured ${breach.measured}${unit})`,
		`  on disk: ${describeUnreportedWork(work)}`,
		"  job recorded failed; worktree left untouched",
	].join("\n");
}

/** No automatic recovery is wired: the job is over, tear it down. */
export function boundTeardownNext(jobId: string): string {
	return `  next: cp_teardown ${jobId}. Do not re-dispatch.`;
}

/**
 * After bounded recovery did not revive (spent, refused, or it threw): the
 * lease and worktree are kept, so the job continues on the same lease (zh7.4).
 */
export function boundContinueNext(jobId: string): string {
	return `  next: lease and worktree kept \u2014 continue on the same lease with cp_revive ${jobId} once any escalation it raised is decided; cp_teardown ${jobId} only to abandon it. Do not re-dispatch.`;
}

export interface HardBoundsWatchOptions {
	fleet: FleetStore;
	/** The only failed transition. Journals the durable wake-up. Pass the notice so the journal keeps the bound wording. */
	fail: FailJob;
	runs: RunRegistry;
	shutdown: (jobId: string) => Promise<void>;
	now?: () => Date;
	inspect?: typeof inspectWorktreeWork;
	onBreach?: (jobId: string, failure: Failure, work: UnreportedWork, notice: string) => void;
	/**
	 * zh7.4: `onBreach` owns the wake-up. `fail` records the transition only and
	 * the notice carries no `next:` line; the owner announces once bounded
	 * recovery's outcome is known. Without it the notice advises `cp_teardown`.
	 */
	deferNotice?: boolean;
	/** The parent is shutting down: the worker is already being stopped, so nothing trips. */
	closing?: () => boolean;
}

/**
 * One watch per live worker. Counts `tool_execution_start` and arms a
 * wall-clock timer at attach. A second trip on the same job is a no-op.
 * `rearm` starts a fresh wall-clock round (a delivered idle promotion); the
 * tool-call count is never reset.
 */
export class HardBoundsWatch {
	readonly #options: HardBoundsWatchOptions;
	readonly #tripped = new Set<string>();
	readonly #rounds = new Map<string, () => void>();

	constructor(options: HardBoundsWatchOptions) {
		this.#options = options;
	}

	watch(jobId: string, worker: WorkerProcess, bounds: JobHardBounds): () => void {
		// A revived worker re-arms the watch under the same jobId. Drop any prior
		// trip so the new session's counters can trip the guard again.
		this.#tripped.delete(jobId);
		let started = Date.now();
		let starts = 0;
		let timer: NodeJS.Timeout | undefined;
		const offEvent = worker.onEvent((event: WorkerEvent) => {
			if (event.type !== "tool_execution_start") return;
			starts += 1;
			const breach = detectHardBound(bounds, {
				elapsedSeconds: Math.floor((Date.now() - started) / 1000),
				toolStarts: starts,
			});
			if (breach) void this.#trip(jobId, breach);
		});
		const arm = (): void => {
			const ms = Math.max(0, bounds.wall_clock_seconds * 1000 - (Date.now() - started));
			timer = setTimeout(() => {
				// setTimeout can fire up to ~1 ms before Date.now() shows the full span; flooring
				// then read 19 s of a 20 s cap and the one-shot timer never tripped. Round up.
				const elapsed = Math.ceil((Date.now() - started) / 1000);
				const breach = detectHardBound(bounds, { elapsedSeconds: elapsed, toolStarts: starts });
				if (breach) void this.#trip(jobId, breach);
			}, ms);
			timer.unref?.();
		};
		arm();
		const rearm = (): void => {
			started = Date.now();
			if (timer) clearTimeout(timer);
			arm();
		};
		this.#rounds.set(jobId, rearm);
		const cleanup = (): void => {
			offEvent();
			if (timer) clearTimeout(timer);
			if (this.#rounds.get(jobId) === rearm) this.#rounds.delete(jobId);
		};
		void worker.closed.then(cleanup);
		return cleanup;
	}

	/** Fresh wall-clock round for the job's live watch; false when none is armed. */
	rearm(jobId: string): boolean {
		const rearm = this.#rounds.get(jobId);
		rearm?.();
		return rearm !== undefined;
	}

	async #trip(jobId: string, breach: BoundBreach): Promise<void> {
		if (this.#tripped.has(jobId) || this.#options.closing?.()) return;
		const { fleet, runs } = this.#options;
		const record = fleet.get(jobId);
		if (!record || record.phase !== "waiting" || record.reported_at !== undefined) return;
		this.#tripped.add(jobId);
		const failure: Failure = {
			class: breach.class,
			message: boundFailureMessage(breach),
			at: isoTimestamp((this.#options.now ?? (() => new Date()))()),
		};
		runs.open(jobId).markFailure(failure);
		const inspect = this.#options.inspect ?? inspectWorktreeWork;
		let work: UnreportedWork;
		try {
			work = await inspect(record.worktree, record.branch, { askOrigin: false });
		} catch (error) {
			work = {
				state: "unknown",
				files: [],
				file_count: 0,
				commits_ahead: 0,
				observed_at: failure.at,
				reason: String(error),
			};
		}
		const notice = formatBoundNotice(jobId, breach, work);
		if (this.#options.deferNotice) await this.#options.fail(jobId, failure, notice, "defer");
		else await this.#options.fail(jobId, failure, `${notice}\n${boundTeardownNext(jobId)}`);
		this.#options.onBreach?.(jobId, failure, work, notice);
		await this.#options.shutdown(jobId);
	}
}
