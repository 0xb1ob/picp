/**
 * Wake-up staleness (cp-p6m) — a message that wakes the parent must describe
 * the fleet as it is *when the parent reads it*, not as it was when the
 * message was written.
 *
 * ## The incident
 *
 * `cp-diffgate-watch-fp0` reported at 12:45:43 (PR open, green, one merge
 * behind main). A minute later the parent promoted the live worker with
 * `cp_send` to rebase and re-verify, which correctly reopened the envelope
 * slot: `envelope.json` was archived to `envelope-superseded-1.json`,
 * `reported_at` was cleared and the job went back to `waiting`
 * (`src/supersede.ts`). The parent then received:
 *
 *     cp-diffgate-watch-fp0 reported done (ship/pr) -> hold
 *     <the exact summary of the archived 12:45:43 envelope>
 *     PR: https://github.com/.../44
 *
 * On disk at that moment: no `envelope.json`, `reported_at` absent, phase
 * `waiting`, and the worker alive inside the very rebase it had just been
 * asked for. Acting on that message meant merging an unrebased PR, or tearing
 * down a worker mid-rebase. Two more of the same shape followed the same
 * session: a `cp-envelope` for a job already merged, torn down and closed, and
 * a `cp-answered` for a decision already acted on.
 *
 * Every one of them was *indistinguishable in form from a fresh one*. That is
 * the defect, and it is in the notification path — not in how carefully the
 * parent reads its messages.
 *
 * ## The fix, in two halves
 *
 *  1. **Every wake-up carries a stamp** (`WakeupStamp`): which job, which
 *     envelope generation, which `reported_at`, which tool call, and when the
 *     wake-up was issued. A message for generation N is then *recognisable*
 *     once the job has moved to N+1, instead of being prose that reads exactly
 *     like the current state.
 *  2. **The stamp is re-checked against disk twice**: once at send time
 *     (`WakeupNotifier.send`, which simply does not send an already-stale
 *     wake-up) and once at *delivery* time (`reviewWakeups`, wired to pi's
 *     `context` event, which is the last moment before the message reaches the
 *     model). The second check is the one that matters: pi queues a `followUp`
 *     and the observed messages arrived minutes behind the state they
 *     described, so a send-time check alone would still have delivered all
 *     three.
 *
 * A stale wake-up's body does not travel. It is replaced with a short notice
 * naming the job, what the message claimed and what is true now, because a
 * superseded summary that is still readable is a summary somebody will act on.
 *
 * ## Why `cp-answered` is annotated and never suppressed
 *
 * An envelope, a wedge and an unreported settle are all statements about a
 * job's *current* phase, and a phase moves. An answered decision is a
 * statement about something a human did, and that never becomes false: the
 * answer stays an answer even if the parent has already acted on it. The
 * failure mode there is the opposite one — a lost decision — and
 * `src/answered.ts` exists precisely because one went missing. So a
 * `cp-answered` wake-up is stamped and (when it is late) annotated, and it is
 * never dropped by this module.
 *
 * That is also what makes this compose with cp-nx7's delivery, rather than
 * fighting it. This module decides *what a message may say*; cp-nx7 decides
 * *when a message counts as delivered* (on observed arrival, never at enqueue)
 * and sends the due answers coalesced. Nothing here marks anything
 * delivered, nothing here drops an id out of a coalesced batch, and the
 * `details` a caller passes — including `details.answered`, which is the
 * arrival evidence — travel untouched beside the stamp.
 *
 * ## The one thing an answered wake-up may not do twice (cp-5mgg)
 *
 * "Never suppressed" is about the *answer*, not about the *copy*. One merge
 * authorization was delivered to the parent three times, each copy reading as
 * fresh news and each instructing it to act; only `cp_integrate`'s idempotence
 * kept that from mattering. `src/answered.ts` fixes the two defects that
 * emitted the copies, and this module holds the property they were meant to
 * guarantee: within the context handed to the model, the **first**
 * `cp-answered` message carrying an id is the delivery, and a later one
 * carrying *only* ids an earlier one already carried is a replay — rewritten
 * to a short notice that names them and says so.
 *
 * That is not a suppression of an answer and it cannot become one. A message
 * carrying a single id nobody has seen travels whole, and a first copy is
 * never touched, so the failure mode this whole path exists to prevent — a lost
 * decision — is untouched. What it removes is only the second and third
 * instruction to act on a decision already acted on.
 *
 * Nothing here polls, kills, or changes a phase. It only decides what a
 * message is allowed to say.
 *
 * ## Why wedged and unreported can never both be fresh for one job (cp-m44c)
 *
 * `AGENTS.md` states the property in prose: wedged is mid-call (`working`,
 * with an open tool call), unreported is after-the-fact (settled, no
 * envelope), and a job cannot be both at once. Until this fix that held only
 * as an emergent consequence of two independent producers (`src/wedged.ts`
 * checking `run_phase === "working"`, `src/settle.ts` firing on
 * `agent_settled`) — nothing here checked it. The `wedged` branch of
 * `checkWakeup` now supersedes a stamp whose job has left `run_phase
 * === "working"` or has since filed an envelope (`reported_at` set), the same
 * two facts that make a job eligible for `unreported` in the first place. So
 * the exclusion is mechanical here, at the one place both kinds are checked,
 * rather than trusted to stay true because two other modules happen to agree.
 *
 * An unreadable or absent `run_phase` (the status projection could not be
 * read) is treated as "not currently working" by both checks, on purpose:
 * `wedged` requires `run_phase === "working"` to stay fresh, so an unknown
 * phase withholds it — a wedge cannot be confirmed, so it does not fire.
 * `unreported` requires `run_phase === "working"` to go stale, so the same
 * unknown phase leaves it fresh — an unreported notice is already the
 * fail-safe direction (it withholds nothing; it only says the run settled
 * with no envelope), so an unreadable phase does not block it. Same
 * interpretation of the missing fact ("not confirmed working"), opposite
 * consequence, because the two checks are asking opposite questions of it.
 */

import { answeredIdsFromMessage } from "./answered.ts";
import { ciKeysFromMessage } from "./ci-watch.ts";
import { durableIdsFromMessage } from "./wakeup-outbox.ts";
import {
	ANSWERED_MESSAGE_TYPE,
	isoTimestamp,
	type JobPhase,
	type ReviewSurface,
	type RunPhase,
	BOUND_MESSAGE_TYPE,
	DEATH_MESSAGE_TYPE,
	DURABLE_WAKEUP_KINDS,
	RECOVERY_MESSAGE_TYPE,
	VERDICT_MESSAGE_TYPE,
	WAKEUP_LATE_SECONDS,
	type DurableWakeupKind,
	type Failure,
	type FailureClass,
	type UnreportedWork,
	describeUnreportedWork,
} from "./contracts.ts";
import { type ProjectOf, projectGroupedLines, UNKNOWN_PROJECT, withProjectTag } from "./project-report.ts";

/**
 * The nine messages that wake the parent unasked. There are no others.
 */
export type WakeupKind =
	| "envelope"
	| "answered"
	| "wedged"
	| "unreported"
	| "ci"
	| "verdict"
	| "bound"
	| "death"
	| "recovery";

/** `customType` per kind — the wire name the parent's session sees. */
export const WAKEUP_CUSTOM_TYPES: Readonly<Record<WakeupKind, string>> = Object.freeze({
	envelope: "cp-envelope",
	// Shared with the arrival observer (cp-nx7): the type this module stamps and
	// the type `answeredIdsFromMessage` recognises are one constant, because a
	// wake-up whose type drifted would be sent and then never confirmed.
	answered: ANSWERED_MESSAGE_TYPE,
	wedged: "cp-wedged",
	unreported: "cp-unreported",
	// cp-e2d: a fact GitHub owns (CI finished for the pushed head, or the PR
	// merged/closed). Evidence, never authorization.
	ci: "cp-ci",
	// spec 2026-09-05: a background reviewer's verdict landed. Evidence about a
	// decision file that already exists, never authorization.
	verdict: VERDICT_MESSAGE_TYPE,
	bound: BOUND_MESSAGE_TYPE,
	death: DEATH_MESSAGE_TYPE,
	recovery: RECOVERY_MESSAGE_TYPE,
});

/** Where the stamp travels on a custom message: `details.cp_wakeup`. */
export const WAKEUP_DETAILS_KEY = "cp_wakeup";

/**
 * How many (source, job) head-source failures a session remembers before it
 * forgets them all and starts again (pi-command-post-8ok).
 *
 * `onSourceFailure` is journaled once per source and job so a broken wiring is
 * news rather than a stream, and that memory is keyed by job id — unbounded in
 * a long session over many jobs. Clearing at the cap keeps it bounded and
 * costs, at worst, one more journal line per source per cycle.
 */
export const WAKEUP_SOURCE_FAILURE_MEMORY = 512;

/**
 * "Have I already recorded this?", with the memory itself bounded
 * (pi-command-post-8ok).
 *
 * The parent journals a degraded head source — and a suppressed wake-up — once
 * per key per session, so a broken wiring is news rather than a stream. Each of
 * those memories is a `Set` keyed by something that grows with the session (a
 * job id, an `issued_at`), so the bound on the *journal* was leaving the
 * *memory* unbounded.
 *
 * Returns `true` the first time it sees a key and `false` while it remembers
 * it. At `limit` distinct keys it forgets all of them, so cardinality never
 * exceeds `limit` and the cost of forgetting is one more journal line per key
 * that recurs — bounded repetition, never a stream.
 */
export function boundedSeen(limit: number = WAKEUP_SOURCE_FAILURE_MEMORY): (key: string) => boolean {
	const seen = new Set<string>();
	return (key: string): boolean => {
		if (seen.has(key)) return false;
		if (seen.size >= limit) seen.clear();
		seen.add(key);
		return true;
	};
}

/**
 * What a wake-up asserts about the world, in facts that can be re-checked.
 * Deliberately small: it is a claim ticket, never a copy of the message.
 */
export interface WakeupStamp {
	kind: WakeupKind;
	/** The job this describes. Absent only for a jobless answered decision. */
	job_id?: string;
	/**
	 * Envelope generation this describes: 1 for the ordinary single report,
	 * N+1 after N promotes reopened the slot. The whole point of the stamp.
	 */
	generation?: number;
	/** The `reported_at` this describes (envelope wake-ups). */
	reported_at?: string;
	/**
	 * Identity of the underlying fact where one exists beyond the job: the open
	 * tool call for a wedge, the awaiting ids for an answered batch, the failure
	 * class an unreported settle already knew about (cp-0wq7).
	 */
	keys?: string[];
	/** Its project(s): the content, and any stale/replayed rewrite, opens with their `[tag]`. */
	projects?: string[];
	/** When the wake-up was issued. Never when it was delivered. */
	issued_at: string;
}

/** The facts a stamp is checked against, read from disk at check time. */
export interface JobWakeupFacts {
	phase: JobPhase;
	script?: boolean;
	/** The live generation: `(supersessions ?? 0) + 1`. */
	generation: number;
	/** Present only while an envelope is filed for the live generation. */
	reported_at?: string;
	/** pid probe from the run projection; absent when it could not be read. */
	alive?: boolean;
	run_phase?: RunPhase | null;
	/** Identity of the open tool call, when one is open. */
	tool_call_key?: string;
	/**
	 * The class of the failure the record now carries, when it carries one
	 * (cp-0wq7). Read so a wake-up that already named a failure is not
	 * superseded by that same failure landing on the record.
	 */
	failure_class?: string;
	/**
	 * The branch's pushed head as the CI watcher last observed it (cp-e2d).
	 * Read from `state/ci-watch.json` — a **file**, never a subprocess: this
	 * check runs on every `context` event, i.e. on every provider request.
	 *
	 * **An observation with a time on it** (pi-command-post-b04): the watcher
	 * ticks on its own cadence, so between a rebase and the next tick this names
	 * the head the branch has already moved *off*. Which of the two heads below
	 * may contradict a claim is decided by which source **owns** that claim, and
	 * only then by `head_observed_at` vs `fleet_head_at` — see `headMoved`.
	 */
	head_sha?: string;
	/**
	 * When the watcher last actually read this head from the remote
	 * (`head_observed_at`, never its attempt timestamp — pi-command-post-8ok).
	 */
	head_observed_at?: string;
	/**
	 * The observation source **failed** rather than having nothing to say
	 * (pi-command-post-8ok). The mirror of `fleet_head_degraded`, and it was the
	 * missing half: a throwing `ciHead` used to read as "this home has never
	 * observed a head", which silently handed a CI claim to the fleet record.
	 */
	head_degraded?: boolean;
	/**
	 * The head this home's own records say the job pushed: the `head_sha` of the
	 * last filed envelope. A file read like every other fact here.
	 */
	fleet_head_sha?: string;
	/** When that envelope was received — the moment this head was recorded. */
	fleet_head_at?: string;
	/**
	 * The fleet head source **failed** rather than having nothing to say
	 * (pi-command-post-b04, finding 2). Absent and broken are different facts: a
	 * broken authority must not silently hand the decision back to the lagging
	 * observation, so a head claim is never superseded while this is set.
	 */
	fleet_head_degraded?: boolean;
}

/** What is on disk for one (job, surface): the pending attempt and the decided ones. */
export interface ReviewWakeupFacts {
	pending?: number;
	decided: number[];
}

/** The read surface this module needs. Injected — nothing here touches fs. */
export interface WakeupFacts {
	job(jobId: string): JobWakeupFacts | undefined;
	review?(jobId: string, surface: ReviewSurface): ReviewWakeupFacts | undefined;
}

export type WakeupState = "fresh" | "superseded";

export interface WakeupVerdict {
	state: WakeupState;
	/** Seconds between `issued_at` and the check. Never negative. */
	delay_seconds: number;
	/** `delay_seconds` past `WAKEUP_LATE_SECONDS`. Annotated, never suppressed. */
	late: boolean;
	/** Why it is superseded, in one clause. Absent when it is fresh. */
	reason?: string;
	/**
	 * An answered decision whose job has already reached a terminal phase: still
	 * `fresh` (an answer can never be wrong), but worth reading as after-the-fact
	 * rather than live news. Annotate, never suppress — see the module header.
	 */
	note?: string;
}

/** Terminal phases: the job's story is over, whatever the message says. */
const TERMINAL: readonly JobPhase[] = ["done", "failed"];

/**
 * The head that contradicts a claim about `claimed`, or `undefined` when
 * nothing does. **Directional and source-aware** (pi-command-post-b04).
 *
 * The incident: cp-cjmu rebased, pushed `a39e4425b7b4` and reported it; the
 * diff review passed on that same head; and the verdict was withheld as "the
 * branch moved" because the CI watcher's file still held `3d3355f0c4d2` — the
 * head from *before* the rebase. The lagging source staled a claim about the
 * current head, and the verdict never reached the parent.
 *
 * And the inverse gap is just as real: the fleet record only knows the head a
 * worker *reported*, so a push nobody reported yet leaves it naming a head the
 * PR has already moved off — and a verdict about that abandoned head must not
 * read as fresh either.
 *
 * ## Ownership first, then time (pi-command-post-8ok)
 *
 * Letting time alone decide made the two readings interchangeable, and they are
 * not. **Each kind of claim has an owning source, and only that source can
 * withhold it:**
 *
 *  - a `cp-ci` claim is the watcher's *own* reading of GitHub. Only a later
 *    reading of GitHub can contradict it. Fleet-owned state — an envelope a
 *    worker filed, a head the fleet still remembers after `CiWatchStore.prune`
 *    dropped the observation, a source that threw — must never withhold a fact
 *    GitHub reported, because a green PR nobody is told about is the exact
 *    failure `src/ci-watch.ts` exists to prevent;
 *  - a `cp-verdict` about a reviewed head is a claim about a head the fleet
 *    owns, so the fleet reading decides it — **except** that a *strictly later*
 *    reading of the remote is a push nobody reported, which is real news about
 *    the reviewed head and still supersedes it. That protection is the inverse
 *    gap above, and it survives unchanged.
 *
 * ## What "strictly later" has to be proved against
 *
 * The promotion above is evidence, so it is only ever taken on evidence. An
 * observation may contradict a fleet-owned claim **only when it is dated**, and
 * — where a fleet reading exists to compare it with — dated strictly after it.
 * An undated observation is not evidence of a later push in either case, and
 * the absence of a fleet reading is not evidence either: "there is nothing to
 * be later than" is ignorance, not proof, and it must not be spelled as a later
 * push. So when nothing can be proved, the owning reading decides, and where
 * the owning reading is itself absent, nothing supersedes at all.
 *
 * Three fail-safes, all on the side of *not* withholding a card:
 *  - a degraded reading (the source threw, not "had nothing to say") supersedes
 *    nothing for the claims it owns — `fleet_head_degraded` for a verdict,
 *    `head_degraded` for a CI notice;
 *  - an absent owning reading supersedes nothing, because the only reading left
 *    is one that does not own the claim and cannot be shown to be current;
 *  - an undated reading never promotes itself over the owner, so a home with no
 *    timestamps leaves every fleet-owned claim to the fleet, which is the
 *    direction that delivers the card.
 */
function headMoved(job: JobWakeupFacts, claimed: string, prefer: "fleet" | "observed"): string | undefined {
	const observed = { sha: job.head_sha, at: Date.parse(job.head_observed_at ?? "") };
	if (prefer === "observed") {
		// A CI claim is the observation's own. Broken or silent, nothing else speaks
		// for it.
		if (job.head_degraded === true || observed.sha === undefined || observed.sha === claimed) return undefined;
		return observed.sha;
	}
	if (job.fleet_head_degraded === true) return undefined;
	const fleet = { sha: job.fleet_head_sha, at: Date.parse(job.fleet_head_at ?? "") };
	// Named for what it is: a reading of the remote that is *provably* the later
	// one. An undated observation proves nothing, and neither does a missing fleet
	// reading — the short-circuit that used to sit here read `fleet.sha ===
	// undefined` as a later push and let an undated, uncorroborated observation
	// withhold a verdict.
	const laterPush =
		observed.sha !== undefined &&
		job.head_degraded !== true &&
		Number.isFinite(observed.at) &&
		(fleet.sha === undefined || (Number.isFinite(fleet.at) && observed.at > fleet.at));
	const current = laterPush ? observed : fleet;
	if (current.sha === undefined || current.sha === claimed) return undefined;
	return current.sha;
}

/**
 * Does this stamp already name the failure the job now carries (cp-0wq7)?
 *
 * A terminal phase normally supersedes an unreported settle: the job's story
 * moved on and the message is history. It does not when the message is *what
 * moved it* — the fail-closed settle (a model call that never happened) marks
 * the job `failed` itself, and this wake-up carries the provider's error, which
 * has no other channel to the operator. So a stamp whose keys name the record's
 * own failure class is still fresh: it is not describing an old state, it is
 * explaining the current one.
 */
function describesJobFailure(stamp: WakeupStamp, job: JobWakeupFacts): boolean {
	if (job.phase !== "failed" || job.failure_class === undefined) return false;
	return stamp.keys?.includes(job.failure_class) === true;
}

function elapsedSeconds(from: string, now: Date): number {
	const issued = Date.parse(from);
	if (!Number.isFinite(issued)) return 0;
	return Math.max(0, Math.floor((now.getTime() - issued) / 1000));
}

/**
 * The whole policy, as a pure function: is this wake-up still true?
 *
 * Staleness is decided from facts only (a generation, a `reported_at`, a
 * phase, an open tool call). Age is never evidence of staleness — it only sets
 * `late`, which annotates and suppresses nothing. That is the same line
 * `src/wedged.ts` draws and the reason `stalled` stays retired.
 */
export function checkWakeup(stamp: WakeupStamp, facts: WakeupFacts, now: Date = new Date()): WakeupVerdict {
	const delay = elapsedSeconds(stamp.issued_at, now);
	const base = { delay_seconds: delay, late: delay >= WAKEUP_LATE_SECONDS };
	const stale = (reason: string): WakeupVerdict => ({ state: "superseded", ...base, reason });
	const fresh: WakeupVerdict = { state: "fresh", ...base };

	// An answered decision is a fact about a human, not about a phase: it can be
	// late, and it can never be wrong. See the header. It is annotated, never
	// suppressed, when the job it names has already reached a terminal phase —
	// that only tells the reader the answer is after-the-fact, not that it is
	// stale.
	if (stamp.kind === "answered") {
		if (stamp.job_id) {
			const job = facts.job(stamp.job_id);
			if (job && TERMINAL.includes(job.phase)) {
				return { ...fresh, note: `${stamp.job_id} is already ${job.phase}: this answer arrived after the job was already wrapped up` };
			}
		}
		return fresh;
	}
	if (stamp.kind === "recovery") {
		const ids = stamp.keys ?? [];
		if (ids.length === 0) return fresh;
		const still = ids.some((id) => {
			const candidate = facts.job(id);
			return candidate !== undefined && candidate.phase !== "done";
		});
		if (!still) return stale("every candidate it listed has been torn down");
		return fresh;
	}
	if (!stamp.job_id) return fresh;

	const job = facts.job(stamp.job_id);
	if (!job) return stale(`there is no fleet record for ${stamp.job_id} any more`);

	if (stamp.kind === "verdict") {
		const surface = stamp.keys?.[0] as ReviewSurface | undefined;
		const attempt = Number(stamp.keys?.[1]);
		if (TERMINAL.includes(job.phase)) {
			return stale(`${stamp.job_id} is already ${job.phase}: the review it describes is history`);
		}
		if (!surface || !Number.isInteger(attempt) || attempt < 1) return fresh;
		const review = facts.review?.(stamp.job_id, surface);
		if (!review) return fresh;
		if (!review.decided.includes(attempt)) {
			return stale(
				`there is no decision on disk for ${surface} attempt ${attempt} of ${stamp.job_id}: ` +
					"its finish never completed, so there is nothing to act on",
			);
		}
		const newer = review.decided.filter((decided) => decided > attempt).at(-1);
		if (newer !== undefined) {
			return stale(`${surface} attempt ${newer} has since been decided for ${stamp.job_id}; attempt ${attempt} is superseded`);
		}
		if (review.pending !== undefined && review.pending > attempt) {
			return stale(`${surface} attempt ${review.pending} is in flight for ${stamp.job_id}; attempt ${attempt} is superseded`);
		}
		const reviewedHead = stamp.keys?.[2];
		const movedTo = surface === "review" && reviewedHead !== undefined ? headMoved(job, reviewedHead, "fleet") : undefined;
		if (movedTo !== undefined) {
			return stale(
				`the branch moved: this reviewed ${reviewedHead?.slice(0, 12)}, and ${stamp.job_id} is now pushed at ${movedTo.slice(0, 12)}`,
			);
		}
		return fresh;
	}

	if (stamp.kind === "envelope") {
		if (stamp.generation !== undefined && job.generation !== stamp.generation) {
			return stale(
				`the envelope slot was reopened: this describes generation ${stamp.generation}, ` +
					`and ${stamp.job_id} is on generation ${job.generation} (phase ${job.phase})`,
			);
		}
		if (job.reported_at === undefined) {
			return stale(
				`the envelope it describes was archived: nothing is filed for generation ${stamp.generation ?? job.generation} ` +
					`and ${stamp.job_id} is ${job.phase}`,
			);
		}
		if (stamp.reported_at !== undefined && job.reported_at !== stamp.reported_at) {
			return stale(
				`a different envelope is filed for ${stamp.job_id}: this describes the report of ${stamp.reported_at}, ` +
					`the live one was reported at ${job.reported_at}`,
			);
		}
		if (TERMINAL.includes(job.phase) && !(job.phase === "failed" && job.script && job.reported_at)) {
			return stale(`${stamp.job_id} is already ${job.phase}: the delivery landed and the job was torn down`);
		}
		return fresh;
	}

	// cp-e2d: a CI fact is a claim about one commit. Once the branch's head has
	// moved, "CI is green" was true about a sha that is now history, and a message
	// that still reads as live news is one somebody will merge on.
	if (stamp.kind === "ci") {
		if (TERMINAL.includes(job.phase)) {
			return stale(`${stamp.job_id} is already ${job.phase}: the delivery landed and the job was torn down`);
		}
		if (stamp.generation !== undefined && job.generation !== stamp.generation) {
			return stale(
				`the envelope slot was reopened: this describes generation ${stamp.generation}, ` +
					`and ${stamp.job_id} is on generation ${job.generation} (phase ${job.phase})`,
			);
		}
		const head = stamp.keys?.[0];
		const movedTo = head !== undefined ? headMoved(job, head, "observed") : undefined;
		if (movedTo !== undefined) {
			return stale(
				`the branch moved: this describes CI on ${head?.slice(0, 12)}, and ${stamp.job_id} is now pushed at ${movedTo.slice(0, 12)}`,
			);
		}
		return fresh;
	}

	if (stamp.kind === "unreported") {
		if (job.reported_at !== undefined) {
			return stale(`${stamp.job_id} has since reported (generation ${job.generation}, at ${job.reported_at})`);
		}
		if (stamp.generation !== undefined && job.generation !== stamp.generation) {
			return stale(
				`the envelope slot was reopened: this describes generation ${stamp.generation}, ` +
					`and ${stamp.job_id} is on generation ${job.generation}`,
			);
		}
		if (TERMINAL.includes(job.phase) && !describesJobFailure(stamp, job)) {
			return stale(`${stamp.job_id} is already ${job.phase}`);
		}
		// cp-m44c: the other half of the wedged/unreported exclusion. "Unreported"
		// means the run settled (or exited) with no envelope filed; a job whose
		// run_phase has gone back to `working` has not settled, whatever the stamp
		// claims, so it cannot be read as unreported. See the module header.
		if (job.run_phase === "working") {
			return stale(`${stamp.job_id} is working again: a run that has not settled is not unreported`);
		}
		return fresh;
	}

	if (stamp.kind === "bound" || stamp.kind === "death") {
		if (describesJobFailure(stamp, job)) return fresh;
		if (TERMINAL.includes(job.phase)) return stale(`${stamp.job_id} is already ${job.phase}`);
		if (job.reported_at !== undefined) {
			return stale(`${stamp.job_id} has already reported (at ${job.reported_at})`);
		}
		// zh7.4: a failure notice replayed after a relaunch (bounded recovery or a
		// hand revive) describes a worker that has been replaced; its teardown
		// advice would kill the live one.
		if (job.phase === "waiting" || job.phase === "launching") {
			return stale(`${stamp.job_id} has a live worker again (phase ${job.phase}): the failure it describes was recovered`);
		}
		return fresh;
	}

	// wedged
	if (TERMINAL.includes(job.phase)) return stale(`${stamp.job_id} is already ${job.phase}`);
	if (job.alive === false) return stale(`the worker for ${stamp.job_id} is gone: an open call on a dead worker is over, not wedged`);
	// cp-m44c: wedged and unreported must never both fire for one job — a run that
	// has settled (left `working`) or already filed an envelope is not mid-call,
	// whatever the stamp claims. See the module header for the property this
	// enforces.
	if (job.run_phase !== "working") {
		return stale(`${stamp.job_id} is no longer working (run phase ${job.run_phase ?? "unknown"}): a settled run cannot be wedged`);
	}
	if (job.reported_at !== undefined) {
		return stale(`${stamp.job_id} has already reported (at ${job.reported_at}): a job that filed an envelope is not mid-call`);
	}
	const key = stamp.keys?.[0];
	if (key !== undefined && job.tool_call_key !== key) {
		return stale(
			job.tool_call_key === undefined
				? `that tool call ended: ${stamp.job_id} has no call open`
				: `that tool call ended: ${stamp.job_id} is on a different call now`,
		);
	}
	return fresh;
}

// ---------------------------------------------------------------------------
// Building the facts
// ---------------------------------------------------------------------------

/** The slice of a fleet record this module reads. Structural on purpose. */
export interface FleetRecordLike {
	phase: JobPhase;
	executor?: string;
	reported_at?: string;
	supersessions?: number;
	/** The recorded cause, when the record is `failed` (cp-0wq7). */
	failure?: { class: string };
}

/** The slice of a status projection this module reads. */
export interface StatusJobLike {
	alive: boolean;
	run_phase: RunPhase | null;
	current_tool: string | null;
	tool_calls: number;
}

/**
 * The identity of one open tool call, shared by the stamp and the check.
 * `tool_calls` is the run projection's monotonic count of
 * `tool_execution_start` events, so it names the current call without needing
 * a tool call id plumbed onto `StatusJob` — the same key `src/wedged.ts`
 * already deduplicates on.
 */
export function toolCallKey(jobId: string, toolCalls: number): string {
	return `${jobId}#${toolCalls}`;
}

/** Every read surface `wakeupFacts` assembles its answers from. */
export interface WakeupFactSources {
	record: (jobId: string) => FleetRecordLike | undefined;
	statusJob?: (jobId: string) => StatusJobLike | undefined;
	/**
	 * cp-e2d: the branch head the CI watcher last observed, read from its own
	 * state file. Files-only by contract — `reviewWakeups` runs on every provider
	 * request, so re-querying the remote here would be a poll in the hottest
	 * path in the process.
	 */
	ciHead?: (jobId: string) => string | undefined;
	/** When that observation was taken (`last_checked_at`), for `headMoved`. */
	ciHeadObservedAt?: (jobId: string) => string | undefined;
	/**
	 * pi-command-post-b04: the head this home's own records say the job pushed —
	 * the last filed envelope's `head_sha` — and when that envelope was received.
	 * File reads like `ciHead`, and read through the same failure reporting: a
	 * source that **throws** is degraded, not absent.
	 */
	fleetHead?: (jobId: string) => string | undefined;
	fleetHeadAt?: (jobId: string) => string | undefined;
	/**
	 * Called when a head source throws (pi-command-post-b04, finding 2). A wiring
	 * failure used to be swallowed by a bare `catch` at the call site, which reads
	 * exactly like "this home has no such fact" and would quietly restore the
	 * behaviour this fix removed. Reporting is best-effort and never throws back.
	 */
	onSourceFailure?: (source: "fleetHead" | "ciHead", jobId: string, error: Error) => void;
	/**
	 * spec 2026-09-05: what is on disk for one reviewer surface of one job.
	 * Files only, for the same reason `ciHead` is.
	 */
	review?: (jobId: string, surface: ReviewSurface) => ReviewWakeupFacts | undefined;
}

/** Which sources are heads, and therefore reported when they throw. */
type HeadSourceName = "ciHead" | "ciHeadObservedAt" | "fleetHead" | "fleetHeadAt";

/**
 * One source, read once, with "it threw" kept distinct from "it had nothing"
 * (pi-command-post-b04, finding 2). A bare `catch` at the call site collapses
 * the two, and the collapsed value is indistinguishable from a home where the
 * fact does not exist — which is how a broken wiring would silently put the
 * lagging observation back in charge.
 */
function readSource(
	sources: WakeupFactSources,
	name: HeadSourceName,
	jobId: string,
): { value?: string; failed: boolean } {
	const source = sources[name];
	if (!source) return { failed: false };
	try {
		const value = source(jobId);
		return value ? { value, failed: false } : { failed: false };
	} catch (error) {
		try {
			sources.onSourceFailure?.(name === "ciHead" || name === "ciHeadObservedAt" ? "ciHead" : "fleetHead", jobId, error as Error);
		} catch {
			// Reporting a failure must never become one.
		}
		return { failed: true };
	}
}

/**
 * Assemble a `WakeupFacts` from the read surfaces the parent already has.
 * Memoised per instance: one review pass over a whole context asks about the
 * same handful of jobs repeatedly, and each answer is a file read.
 */
export function wakeupFacts(sources: WakeupFactSources): WakeupFacts {
	const cache = new Map<string, JobWakeupFacts | undefined>();
	return {
		job(jobId: string): JobWakeupFacts | undefined {
			if (cache.has(jobId)) return cache.get(jobId);
			const record = sources.record(jobId);
			let facts: JobWakeupFacts | undefined;
			if (record) {
				const status = sources.statusJob?.(jobId);
				facts = {
					phase: record.phase,
					...(record.executor === "script" ? { script: true } : {}),
					generation: (record.supersessions ?? 0) + 1,
					...(record.reported_at !== undefined ? { reported_at: record.reported_at } : {}),
					...(record.failure ? { failure_class: record.failure.class } : {}),
					...(status ? { alive: status.alive, run_phase: status.run_phase } : {}),
					...(status && status.current_tool !== null
						? { tool_call_key: toolCallKey(jobId, status.tool_calls) }
						: {}),
					...(() => {
						const observed = readSource(sources, "ciHead", jobId);
						// pi-command-post-8ok: the mirror of the fleet side below. A throwing
						// observation used to be indistinguishable from a home that has never
						// watched this branch, which quietly let the fleet record answer a
						// question only GitHub can.
						if (observed.failed) return { head_degraded: true };
						if (observed.value === undefined) return {};
						const at = readSource(sources, "ciHeadObservedAt", jobId).value;
						return { head_sha: observed.value, ...(at ? { head_observed_at: at } : {}) };
					})(),
					...(() => {
						const fleetHead = readSource(sources, "fleetHead", jobId);
						if (fleetHead.failed) return { fleet_head_degraded: true };
						if (fleetHead.value === undefined) return {};
						const at = readSource(sources, "fleetHeadAt", jobId).value;
						return { fleet_head_sha: fleetHead.value, ...(at ? { fleet_head_at: at } : {}) };
					})(),
				};
			}
			cache.set(jobId, facts);
			return facts;
		},
		...(sources.review ? { review: sources.review } : {}),
	};
}

/** The stamp a `cp-verdict` carries: surface, attempt, and the head for a diff review. */
export function verdictStamp(
	jobId: string,
	surface: ReviewSurface,
	attempt: number,
	headSha?: string,
): Omit<WakeupStamp, "issued_at"> {
	return {
		kind: "verdict",
		job_id: jobId,
		keys: headSha ? [surface, String(attempt), headSha] : [surface, String(attempt)],
	};
}

/** `${job}|${surface}|${attempt}` for a `cp-verdict` message, else nothing. Never throws. */
export function verdictKeysFromMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const carrier = message as WakeupCarrier;
	if (carrier.customType !== VERDICT_MESSAGE_TYPE) return [];
	const stamp = wakeupStampOf(carrier);
	if (!stamp || stamp.kind !== "verdict" || !stamp.job_id || !stamp.keys || stamp.keys.length < 2) return [];
	return [`${stamp.job_id}|${stamp.keys[0]}|${stamp.keys[1]}`];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The banner that makes a superseded wake-up unmistakable at a glance. */
export const STALE_WAKEUP_HEADLINE = "STALE WAKE-UP — do not act on this";

function describe(stamp: WakeupStamp): string {
	const type = WAKEUP_CUSTOM_TYPES[stamp.kind];
	const job = stamp.job_id ? ` for ${stamp.job_id}` : "";
	const generation = stamp.generation !== undefined ? `, generation ${stamp.generation}` : "";
	const reported = stamp.reported_at ? `, reported at ${stamp.reported_at}` : "";
	const attempt = stamp.kind === "verdict" && stamp.keys ? `, ${stamp.keys[0]} attempt ${stamp.keys[1]}` : "";
	return `${type}${job}${generation}${attempt}${reported}, issued at ${stamp.issued_at}`;
}

/** A rewrite keeps the original's project tag, so even a stale notice names its project. */
function tagged(stamp: WakeupStamp, text: string): string {
	return stamp.projects && stamp.projects.length > 0 ? withProjectTag(stamp.projects, text) : text;
}

/**
 * What the parent reads instead of a superseded wake-up. The original body is
 * deliberately gone: the summary of an archived envelope is exactly the thing
 * that got a worker torn down mid-rebase, and a message that still carries it
 * is a message somebody will still act on.
 */
export function formatStaleWakeup(stamp: WakeupStamp, verdict: WakeupVerdict): string {
	const lines = [
		`${STALE_WAKEUP_HEADLINE}${stamp.job_id ? ` (${stamp.job_id})` : ""}.`,
		`A ${describe(stamp)} was superseded before you read it: ${verdict.reason ?? "the facts it described have moved on"}.`,
		"Its contents are withheld on purpose. This is not a request to repair or resume the job.",
		"Do not promote, send instructions, rebase, revive, merge or tear down anything because of this notice.",
	];
	lines.push(
		stamp.job_id
			? `For independent current evidence only: /status or /watch ${stamp.job_id}. This notice requires no action.`
			: "For independent current evidence only: /status. This notice requires no action.",
	);
	return tagged(stamp, lines.join("\n"));
}

/** The banner on a `cp-answered` copy the parent has already been given. */
export const REPLAYED_WAKEUP_HEADLINE = "REPLAYED WAKE-UP — you have already been told about this";

/**
 * What the parent reads instead of a second copy of an answer it already has.
 * The ids are named (so the message is traceable to the decision it repeats)
 * and the instruction to act is deliberately gone: acting on a replayed
 * authorization is the entire defect (cp-5mgg).
 */
export function formatReplayedWakeup(stamp: WakeupStamp, ids: readonly string[]): string {
	const named = ids.length > 0 ? ids.join(", ") : "the same decision";
	return tagged(stamp, [
		`${REPLAYED_WAKEUP_HEADLINE}${stamp.job_id ? ` (${stamp.job_id})` : ""}.`,
		`A ${describe(stamp)} repeats an answer already delivered to you in this conversation: ${named}.`,
		"Nothing new was decided and nothing was lost. Do not act on it a second time;",
		"the delivery you already read is the one that counts.",
	].join("\n"));
}

/**
 * What the parent reads instead of a second copy of the same CI/PR fact
 * (pi-command-post-jua). The wording is deliberately its own — `cp-ci` never
 * carries a decision to repeat, only a fact about one commit, so "an answer"
 * would misdescribe what travelled twice.
 */
export function formatReplayedCiWakeup(stamp: WakeupStamp): string {
	const head = stamp.keys?.[0]?.slice(0, 12);
	return tagged(stamp, [
		`${REPLAYED_WAKEUP_HEADLINE}${stamp.job_id ? ` (${stamp.job_id})` : ""}.`,
		`A ${describe(stamp)} repeats CI/PR facts already delivered to you in this conversation` +
			`${head ? ` for head ${head}` : ""}.`,
		"Nothing new happened and nothing was lost. Do not act on it a second time;",
		"the copy you already read is the one that counts.",
	].join("\n"));
}

/** One line appended to a still-true wake-up that took a while to arrive. */
export function formatLateWakeup(stamp: WakeupStamp, verdict: WakeupVerdict): string {
	return (
		`(This wake-up was issued at ${stamp.issued_at} and reached you ${verdict.delay_seconds}s later; ` +
		"its facts were re-checked just now and still hold.)"
	);
}

/**
 * One line appended to a `cp-answered` wake-up whose job has already reached
 * a terminal phase: still live news about the human's decision, just
 * after-the-fact about the job. Annotate, never suppress — see the module
 * header.
 */
export function formatAnsweredJobDone(verdict: WakeupVerdict): string {
	return `(${verdict.note})`;
}

/**
 * Failure class → durable wake-up for a `to: failed` transition.
 * Never `none`, never a followUp-only kind: the parent may die before it reads one.
 * A still-waiting unreported settle is `unreported_recorded`, not this map.
 */
export const FAILURE_CLASS_WAKEUP: Readonly<Record<FailureClass, DurableWakeupKind>> = Object.freeze({
	agent_empty_output: "death",
	provider_limit: "death",
	timeout: "death",
	crash: "death",
	tool_loop: "death",
	budget_exceeded: "death",
	envelope_invalid: "death",
	spawn_failed: "death",
	settled_without_report: "death",
	model_call_failed: "death",
	script_exit: "death",
	script_signal: "death",
	wall_clock_exceeded: "bound",
	tool_call_cap_exceeded: "bound",
});

export function formatDeathNotice(jobId: string, failure: Failure, work: UnreportedWork): string {
	return [
		`WORKER DEATH — ${jobId} failed (${failure.class})`,
		`  cause: ${failure.message}`,
		`  on disk: ${describeUnreportedWork(work)}`,
		`  next: cp_teardown ${jobId} or cp_revive ${jobId}.`,
	].join("\n");
}

export interface RecoveryCandidate {
	job_id: string;
	outcome: string;
	detail: string;
	resumable: boolean;
}

export function formatRecoveryNotice(candidates: readonly RecoveryCandidate[], projectOf?: ProjectOf): string {
	const lines = [`RESTART RECOVERY — ${candidates.length} candidate(s)`];
	const row = (candidate: RecoveryCandidate) => `  ${candidate.job_id} ${candidate.outcome}${candidate.resumable ? " (resumable)" : ""}: ${candidate.detail}`;
	lines.push(...projectGroupedLines(candidates, projectOf && ((candidate) => projectOf(candidate.job_id)), row));
	const revive = candidates.filter((candidate) => candidate.resumable).map((candidate) => candidate.job_id);
	const tear = candidates.filter((candidate) => !candidate.resumable).map((candidate) => candidate.job_id);
	const next: string[] = [];
	if (revive.length > 0) next.push(`cp_revive ${revive.join(", ")}`);
	if (tear.length > 0) next.push(`cp_teardown ${tear.join(", ")}`);
	lines.push(`  next: ${next.join(" or ") || "cp_teardown the listed jobs"}.`);
	return lines.join("\n");
}

/** The message a notifier hands to the transport. Content is always a string. */
export interface WakeupMessage {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

/** What one `send` did — the observable a test (and the run log) reads. */
export interface WakeupSendResult {
	sent: boolean;
	verdict: WakeupVerdict;
	stamp: WakeupStamp;
	message?: WakeupMessage;
}

export interface WakeupNotifierOptions {
	facts: WakeupFacts;
	/** The transport. Throwing is allowed: it is caught and reported as unsent. */
	send: (message: WakeupMessage) => void;
	now?: () => Date;
	/** Called for a wake-up that was withheld, so silence is still a fact. */
	onSuppressed?: (stamp: WakeupStamp, verdict: WakeupVerdict) => void;
	/** Resolves a single-job stamp's project; a multi-job stamp carries `projects` itself. */
	projectOf?: ProjectOf;
}

/**
 * The send-time half. It stamps the message, re-checks the stamp against disk
 * and refuses to send one that is already stale — the cheapest possible fix
 * for the case where the supersession happened between "the fact occurred" and
 * "we got round to telling anyone".
 */
export class WakeupNotifier {
	readonly #options: WakeupNotifierOptions;

	constructor(options: WakeupNotifierOptions) {
		this.#options = options;
	}

	send(
		stamp: Omit<WakeupStamp, "issued_at"> & { issued_at?: string },
		content: string,
		details: Record<string, unknown> = {},
	): WakeupSendResult {
		const now = (this.#options.now ?? (() => new Date()))();
		const projects = stamp.projects ?? (stamp.job_id && this.#options.projectOf ? [this.#options.projectOf(stamp.job_id) ?? UNKNOWN_PROJECT] : []);
		const stamped: WakeupStamp = { ...stamp, ...(projects.length > 0 ? { projects: [...new Set(projects)] } : {}), issued_at: stamp.issued_at ?? isoTimestamp(now) };
		content = tagged(stamped, content);
		const verdict = checkWakeup(stamped, this.#options.facts, now);
		if (verdict.state === "superseded") {
			this.#options.onSuppressed?.(stamped, verdict);
			return { sent: false, verdict, stamp: stamped };
		}
		const annotations: string[] = [];
		if (verdict.note) annotations.push(formatAnsweredJobDone(verdict));
		if (verdict.late) annotations.push(formatLateWakeup(stamped, verdict));
		const message: WakeupMessage = {
			customType: WAKEUP_CUSTOM_TYPES[stamped.kind],
			content: annotations.length ? [content, ...annotations].join("\n") : content,
			display: true,
			details: { ...details, [WAKEUP_DETAILS_KEY]: stamped },
		};
		this.#options.send(message);
		return { sent: true, verdict, stamp: stamped, message };
	}
}

// ---------------------------------------------------------------------------
// Delivery-time review
// ---------------------------------------------------------------------------

/** The slice of an agent message this module can review. */
export interface WakeupCarrier {
	role: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	[key: string]: unknown;
}

/** The stamp on a message, if it carries one. Never throws on odd shapes. */
export function wakeupStampOf(message: WakeupCarrier): WakeupStamp | undefined {
	if (message.role !== "custom") return undefined;
	const details = message.details;
	if (!details || typeof details !== "object") return undefined;
	const stamp = (details as Record<string, unknown>)[WAKEUP_DETAILS_KEY];
	if (!stamp || typeof stamp !== "object") return undefined;
	const candidate = stamp as Partial<WakeupStamp>;
	if (typeof candidate.issued_at !== "string") return undefined;
	if (candidate.kind === undefined || !(candidate.kind in WAKEUP_CUSTOM_TYPES)) return undefined;
	return candidate as WakeupStamp;
}

/**
 * The ids one answered wake-up carries. The stamp is the primary source (the
 * sender puts every coalesced id in `keys`); the message itself is the
 * fallback, read exactly the way the arrival observer reads it, so a payload
 * that lost its `details` is still recognised as the copy it is.
 */
function answeredWakeupIds(stamp: WakeupStamp, message: WakeupCarrier): string[] {
	if (stamp.keys && stamp.keys.length > 0) return [...stamp.keys];
	return answeredIdsFromMessage(message);
}

/** Bounded CI/verdict delivery tokens and identities of notices already withheld, kept across contexts. */
export type WakeupReplayMemory = Map<string, string>;

export interface WakeupReview<T> {
	messages: T[];
	/** True when at least one message was rewritten. */
	changed: boolean;
	/** One entry per rewritten message, for the run log and for tests. */
	superseded: { stamp: WakeupStamp; verdict: WakeupVerdict }[];
}

const DURABLE_KINDS: ReadonlySet<string> = new Set<string>(DURABLE_WAKEUP_KINDS);

/**
 * The delivery-time half: re-check stamps immediately before model delivery.
 * Rewriting is remembered by stamp identity: a phase can return to an earlier
 * value, but an already-withheld notice must not regain its actionable body.
 *
 * Never mutates its input, never throws for a shape it does not recognise.
 */
export function reviewWakeups<T extends WakeupCarrier>(
	messages: readonly T[],
	facts: WakeupFacts,
	now: Date = new Date(),
	memory: WakeupReplayMemory = new Map(),
): WakeupReview<T> {
	const reviewed: T[] = [];
	const superseded: { stamp: WakeupStamp; verdict: WakeupVerdict }[] = [];
	let changed = false;
	// cp-5mgg: which answered ids this context has already delivered, in order.
	// Positional, not a cache: the evidence is the conversation itself, so it
	// needs no state, survives a restart with the context, and cannot outlive the
	// delivery it describes.
	const answeredSeen = new Set<string>();
	// CI keys include the event, not just the head: pr_merged after ci_green is
	// new information. A batch with any unseen key is news; missing identity
	// stays conservative. Verdict keys name job/surface/attempt. Memory retains
	// the first context entry's issued_at#timestamp across compaction/reload.
	const ciSeen = new Set<string>();
	for (const message of messages) {
		const stamp = wakeupStampOf(message);
		if (!stamp || typeof message.content !== "string") {
			reviewed.push(message);
			continue;
		}
		if (stamp.kind === "answered") {
			const ids = answeredWakeupIds(stamp, message);
			const replay = ids.length > 0 && ids.every((id) => answeredSeen.has(id));
			for (const id of ids) answeredSeen.add(id);
			if (replay) {
				const delay = elapsedSeconds(stamp.issued_at, now);
				const verdict: WakeupVerdict = {
					state: "superseded",
					delay_seconds: delay,
					late: delay >= WAKEUP_LATE_SECONDS,
					reason: `you have already been given this answer in this conversation (${ids.join(", ")})`,
				};
				changed = true;
				superseded.push({ stamp, verdict });
				reviewed.push({ ...message, content: formatReplayedWakeup(stamp, ids) });
				continue;
			}
		}
		const durable = DURABLE_KINDS.has(stamp.kind);
		if (stamp.kind === "ci" || stamp.kind === "verdict" || durable) {
			// Conservative on purpose: the event lives only in `details.ci`
			// (`ciKeysFromMessage`), never in `stamp.keys` (head only, no event). A
			// message that lost its details — or never had them — cannot be told
			// apart from a different fact on the same head by anything weaker than
			// the full key, so it is left alone rather than risk collapsing a
			// `pr_merged`/`ci_failed` notice into a replay of an earlier `ci_green`
			// on the identity `job_id|head` would confuse them under.
			// Durable wake-ups (death/bound/recovery) replay on `durable_id`: the outbox re-sends
			// after its retry window while pi still holds the first copy (cp-ze1t).
			const ids = durable ? durableIdsFromMessage(message).map((id) => `durable:${id}`) : stamp.kind === "ci" ? ciKeysFromMessage(message) : verdictKeysFromMessage(message);
			if (ids.length > 0) {
				// The delivery is the context entry, not the stamp: a redelivered copy with an
				// identical stamp is still a new entry (its own `timestamp`), so still a replay.
				const token = `${stamp.issued_at}#${typeof message.timestamp === "number" ? message.timestamp : ""}`;
				const earlier = (id: string) => ciSeen.has(id) || (memory.get(id) ?? token) !== token;
				const replay = ids.every(earlier);
				for (const id of ids) {
					ciSeen.add(id);
					if (memory.has(id)) continue;
					if (memory.size >= WAKEUP_SOURCE_FAILURE_MEMORY) memory.delete(memory.keys().next().value!);
					memory.set(id, token);
				}
				if (replay) {
					const delay = elapsedSeconds(stamp.issued_at, now);
					const what = stamp.kind === "ci" ? `the CI/PR facts for ${stamp.job_id} on ${stamp.keys?.[0]?.slice(0, 12) ?? "this head"}` : `this ${durable ? "notice" : "verdict"} (${ids.join(", ")})`;
					const verdict: WakeupVerdict = {
						state: "superseded",
						delay_seconds: delay,
						late: delay >= WAKEUP_LATE_SECONDS,
						reason: `you have already been given ${what} in this conversation`,
					};
					changed = true;
					superseded.push({ stamp, verdict });
					reviewed.push({ ...message, content: stamp.kind === "ci" ? formatReplayedCiWakeup(stamp) : formatReplayedWakeup(stamp, ids) });
					continue;
				}
			}
		}
		const verdict = checkWakeup(stamp, facts, now);
		// A later phase read must not resurrect a notice already withheld. A new
		// issue time is a new notice; the key stores no body or project prose.
		const withheldKey = `withheld:${JSON.stringify([stamp.kind, stamp.job_id, stamp.generation, stamp.reported_at, stamp.keys, stamp.issued_at])}`;
		if (memory.has(withheldKey)) {
			verdict.state = "superseded";
			verdict.reason = "this notice was already withheld in an earlier context";
		}
		if (verdict.state !== "superseded") {
			reviewed.push(message);
			continue;
		}
		if (!memory.has(withheldKey)) {
			if (memory.size >= WAKEUP_SOURCE_FAILURE_MEMORY) memory.delete(memory.keys().next().value!);
			memory.set(withheldKey, "");
		}
		changed = true;
		superseded.push({ stamp, verdict });
		reviewed.push({ ...message, content: formatStaleWakeup(stamp, verdict) });
	}
	return { messages: changed ? reviewed : [...messages], changed, superseded };
}
