/**
 * The only `waiting → failed` transition.
 *
 * `fleet.markFailed` plus a durable wake-up, same step, every failure class.
 * Kind comes from the class. It is never `none` and never a non-durable kind:
 * a parent that dies before consuming a followUp must still find the notice
 * on disk. Callers receive `fail`, they do not call `markFailed`.
 */
import type { Failure, FleetRecord, UnreportedWork } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";
import { FAILURE_CLASS_WAKEUP, formatDeathNotice } from "./wakeups.ts";
import { inspectWorktreeWork } from "./worktree-work.ts";

/**
 * `recovery` is the fact bounded recovery already knows before this call
 * (cur.4.2 review, finding 2): whether an automatic attempt ran for this
 * occurrence, and how many are left for the (job, class) pair. `fail` is only
 * ever invoked when recovery did **not** revive, so this is never a claim
 * about *this* wake-up being wrong \u2014 only about whether the parent should
 * expect a further automatic try. Omitted by a caller that has no recovery
 * ladder wired (a test, `cp_teardown`'s own `fail`), which reads as "unknown".
 */
export interface FailRecoveryFact {
	attempted: boolean;
	attemptsLeft: number;
	/** A preview (death path): the attempt is about to run, its outcome is not known yet. */
	pending?: boolean;
	/** Why the attempt did not revive, or what recovery threw. */
	reason?: string;
	/** Recovery itself rejected: an operational failure, not a decided outcome. */
	error?: boolean;
}

/**
 * `"defer"` (zh7.4): record the failed transition and nothing else \u2014 the
 * caller announces once bounded recovery's outcome is known (`announce`).
 */
export type FailJob = (jobId: string, failure: Failure, notice?: string, recovery?: FailRecoveryFact | "defer") => Promise<FleetRecord>;

/**
 * The durable wake-up id `#announce` computes for this occurrence \u2014 exported
 * so `CommandPost#retractFailureWakeup` reconstructs the exact same id when a
 * bounded-recovery success needs to discard the wake-up `fail()` just
 * journaled. One function, not two copies that can drift apart.
 */
export function boundWakeupId(jobId: string, cls: Failure["class"], at: string): string {
	return boundedWakeupId(`bound:${jobId}:${cls}:${at}`);
}

export function deathWakeupId(jobId: string, at: string): string {
	return boundedWakeupId(`death:${jobId}:${at}`);
}

/**
 * cur.4.4: the unambiguous phrase for a bound that is spent (`attempted:
 * false, attemptsLeft: 0`) \u2014 exported so the AGENTS.md/docs consistency test
 * (`tests/wakeup-journal.test.ts`) pins it against the actual code, not a copy.
 * "not attempted \u2014 0 attempt(s) left" reads as permission to hand-revive;
 * this does not \u2014 and it must not itself read as a green light to hand-revive.
 */
export const BOUND_SPENT_PHRASE =
	"bound spent \u2014 one automatic attempt was already made and did not stick; escalated to a human, no further automatic attempt is coming";

/**
 * The `automatic recovery:` line. Only an outcome may claim what happened: a
 * preview says an attempt is in flight, never that it "did not stick" (zh7.4).
 * cur.4.4: a just-spent bound (`attempted: false, attemptsLeft: 0`) reads as
 * `BOUND_SPENT_PHRASE`, never as the ordinary "not attempted" one.
 */
export function recoveryLine(recovery: FailRecoveryFact): string {
	const left = `${recovery.attemptsLeft} attempt(s) left for this class`;
	if (recovery.error) {
		return `failed operationally (${recovery.reason ?? "unknown error"}); outcome unknown, lease and worktree kept \u2014 ${left}`;
	}
	if (recovery.pending) return `attempt in flight \u2014 ${left} after it; a successful revive supersedes this notice`;
	if (recovery.attempted) return `attempted, not revived${recovery.reason ? ` (${recovery.reason})` : ""} \u2014 ${left}`;
	if (recovery.attemptsLeft === 0) return BOUND_SPENT_PHRASE;
	return `not attempted \u2014 ${left}`;
}

export class FailureAnnouncer {
	readonly #fleet: FleetStore;
	readonly #journal: (input: DurableWakeupInput) => void;
	readonly #inspect: typeof inspectWorktreeWork;

	constructor(options: {
		fleet: FleetStore;
		journal: (input: DurableWakeupInput) => void;
		inspect?: typeof inspectWorktreeWork;
	}) {
		this.#fleet = options.fleet;
		this.#journal = options.journal;
		this.#inspect = options.inspect ?? inspectWorktreeWork;
	}

	async fail(jobId: string, failure: Failure, notice?: string, recovery?: FailRecoveryFact | "defer"): Promise<FleetRecord> {
		const record = await this.#fleet.markFailed(jobId, failure);
		if (recovery === "defer") return record;
		try {
			await this.#announce(record, failure, notice, recovery);
		} catch {
			// Phase is already failed. A journal miss must not skip the caller's shutdown.
		}
		return record;
	}

	/** The deferred half of `fail(..., "defer")`: journal the wake-up for the failure the record already carries. */
	async announce(jobId: string, failure: Failure, notice?: string, recovery?: FailRecoveryFact): Promise<void> {
		const record = this.#fleet.get(jobId);
		if (!record) throw new Error(`${jobId}: no fleet record to announce a failure for`);
		await this.#announce(record, failure, notice, recovery);
	}

	async #announce(record: FleetRecord, failure: Failure, notice?: string, recovery?: FailRecoveryFact): Promise<void> {
		const kind = FAILURE_CLASS_WAKEUP[failure.class];
		const base = notice && notice.length > 0 ? notice : await this.#deathNotice(record, failure);
		const auto = recovery ? recoveryLine(recovery) : undefined;
		const content = auto !== undefined ? `${base}\n  automatic recovery: ${auto}` : base;
		this.#journal({
			// cur.4.4: a bound id without an occurrence component collapses every
			// breach of the same (job, class) into one wake-up: `enqueue` suppresses an
			// id already pending/delivered/discarded, so a second breach after a
			// successful auto-redispatch never reached the parent. `failure.at` is the
			// occurrence key death ids already carry.
			id: kind === "bound" ? boundWakeupId(record.job_id, failure.class, failure.at) : deathWakeupId(record.job_id, failure.at),
			kind,
			job_id: record.job_id,
			content: content.slice(0, 4000),
			keys: [failure.class],
			generation: (record.supersessions ?? 0) + 1,
		});
	}

	async #deathNotice(record: FleetRecord, failure: Failure): Promise<string> {
		let work: UnreportedWork;
		try {
			work = await this.#inspect(record.worktree, record.branch, { askOrigin: false });
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
		return formatDeathNotice(record.job_id, failure, work);
	}
}
