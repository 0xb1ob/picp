/**
 * The one mandate permission rule (b-qbi.4, operator direction on #251): how one grant stands on one use of one
 * job at `now`. Every path that spends under a grant routes through `grantStanding` — `cp_dispatch` and script
 * dispatch (`dispatch`), a `cp_send` ship brief (`promote`), checkpoint auto-decision and `cp_decide`
 * (`implement`/`review`/`merge`, via `evaluateAuthority`), `cp_review` reviewer spend (`review`), and a repair
 * message to a job's own implementer from `cp_integrate` or a diff-review revise (`repair`). `cp_revive` and
 * bounded recovery relaunch a worker on the job's own lease without a mandate check, before and after this rule.
 *
 * Expiry is read against `now` as well as the stored status, so an unswept crossing is already expired. An expired
 * grant only continues a job already in flight under it — a fleet record with the same id, project and kind:
 * review, repair and merge; a same-kind promotion of its existing worker (review fix, CI or conflict repair); and a
 * re-dispatch that continues it after its worker failed. It never permits a fresh dispatch or a new job, a first
 * (`implement`) authorization, or a kind-changing promotion (research to ship: no same-kind record). Each
 * continuation still needs its action in `allowed_actions`, and the grant's caps and risk:high ask still bind.
 * Every non-expired cell is the behaviour that shipped before this rule, except that a cap-paused or revoked grant
 * refuses repair. `docs/contracts.md` has the matrix.
 * Active selection may substitute only another non-schedule named grant when the first is full without this job.
 * All checks after selection remain final; no persistence or dispatch-order binding is introduced.
 */
import type { JobKind, Mandate, MandateAction } from "./contracts.ts";
import { capReached, covers, jobCapFullWithout, MandateError, type MandateUsageJob, type ScheduleScope } from "./mandate-accounting.ts";
import { compareActiveGrants } from "./grant-order.ts";

export const GRANT_USES = ["dispatch", "promote", "implement", "review", "repair", "merge"] as const;
export type GrantUse = (typeof GRANT_USES)[number];
export type GrantCause = "active" | "paused" | "cap_paused" | "revoked" | "expired";
/** `permit`: the grant authorizes it (its own rules follow); `refuse`: it forbids it; `silent`: it covers the job but does not speak. */
export type GrantCell = "permit" | "refuse" | "silent";

/** `scheduleId`/`scheduleMandate`: a scheduled job's schedule and the grant it names (schedlater S3; `covers`). */
export interface GrantJob extends ScheduleScope {
	jobId: string;
	project: string;
	jobKind?: JobKind;
	pathHints?: string[];
	subsystem?: string;
	/** Dispatch time, or creation time before dispatch. Missing timestamps preserve legacy standing. */
	startedAt?: string;
	/** A fleet record with the same id, project and kind exists (`inFlightRecord`). */
	inFlight: boolean;
	/** That record's worker failed: a re-dispatch continues it. */
	failed?: boolean;
}

export type GrantStanding = { standing: "none" } | { standing: GrantCell; cause: GrantCause; detail?: string };

const P: GrantCell = "permit";
const R: GrantCell = "refuse";
const S: GrantCell = "silent";
/** status x use for every grant that has not expired. */
export const GRANT_MATRIX: Readonly<Record<Exclude<GrantCause, "expired">, Readonly<Record<GrantUse, GrantCell>>>> = {
	active: { dispatch: P, promote: P, implement: P, review: P, repair: P, merge: P },
	paused: { dispatch: S, promote: S, implement: R, review: R, repair: S, merge: R },
	cap_paused: { dispatch: R, promote: R, implement: R, review: R, repair: R, merge: R },
	revoked: { dispatch: S, promote: S, implement: R, review: R, repair: R, merge: R },
};
/** The allowed action each continuation needs under an expired grant; `implement` (a first authorization) has none. */
const CONTINUATION_ACTION: Partial<Record<GrantUse, MandateAction>> = { dispatch: "implement", promote: "repair", review: "review", repair: "repair", merge: "merge" };
const RANK: Record<GrantCell, number> = { permit: 0, silent: 1, refuse: 2 };

/** The job's own fleet record: same id and project, and the same kind when both sides name one. */
export function inFlightRecord(job: { jobId: string; project: string; jobKind?: JobKind }, jobs: readonly MandateUsageJob[]): MandateUsageJob | undefined {
	return jobs.find((entry) => entry.job_id === job.jobId && entry.project === job.project && (!job.jobKind || !entry.kind || entry.kind === job.jobKind));
}

export function isInFlight(job: { jobId: string; project: string; jobKind?: JobKind }, jobs: readonly MandateUsageJob[]): boolean {
	return inFlightRecord(job, jobs) !== undefined;
}

export function isExpired(grant: Mandate, now: string): boolean {
	return grant.status === "expired" || (grant.status !== "revoked" && grant.expiry <= now);
}

/** Pure: grant x use x job x now. A paused grant past its expiry takes the stricter of its two cells. */
export function grantStanding(grant: Mandate, use: GrantUse, job: GrantJob, now: string): GrantStanding {
	if (!covers(grant, job)) return { standing: "none" };
	if (grant.status === "revoked" && grant.revoked_at && job.startedAt && grant.revoked_at < job.startedAt) return { standing: "none" };
	const cause: Exclude<GrantCause, "expired"> =
		grant.status === "revoked" ? "revoked" : grant.status !== "paused" ? "active" : ["spend_cap", "token_cap"].includes(grant.pause_reason ?? "") ? "cap_paused" : "paused";
	const stored = { standing: GRANT_MATRIX[cause][use], cause };
	if (cause === "revoked" || !isExpired(grant, now)) return stored;
	const lapsed = expiredCell(grant, use, job);
	return cause === "active" || RANK[lapsed.standing] > RANK[stored.standing] ? lapsed : stored;
}

function expiredCell(grant: Mandate, use: GrantUse, job: GrantJob): { standing: GrantCell; cause: "expired"; detail?: string } {
	const refuse = (detail: string) => ({ standing: R as GrantCell, cause: "expired" as const, detail });
	const action = CONTINUATION_ACTION[use];
	if (!action) return refuse("no first authorization under it; only a job already in flight under it continues");
	if (!job.inFlight) return refuse(`${job.jobId} has no fleet record of that kind, so it is a fresh start or a kind change, never a continuation`);
	if (use === "dispatch" && !job.failed) return refuse(`${job.jobId} is in flight; continue its existing worker (cp_send, cp_revive) instead of a fresh dispatch`);
	if (!grant.allowed_actions.includes(action)) return refuse(`${action} is not an allowed action`);
	return { standing: P, cause: "expired" };
}

/** Pure selection: standing, deterministic active precedence, then named headroom without this job. */
export function selectGrant(grants: readonly Mandate[], use: GrantUse, job: GrantJob, now: string, jobs?: readonly MandateUsageJob[]) {
	const judged = grants.map((grant) => ({ grant, at: grantStanding(grant, use, job, now) }))
		.filter((entry): entry is { grant: Mandate; at: Exclude<GrantStanding, { standing: "none" }> } => entry.at.standing !== "none");
	const active = judged.filter(({ at }) => at.standing === P && at.cause === "active").sort((a, b) => compareActiveGrants(a.grant, b.grant));
	const first = active[0];
	const named = (grant: Mandate) => (grant.job_ids?.length ?? 0) > 0 && !grant.schedule_grant;
	if (jobs && first && named(first.grant) && jobCapFullWithout(first.grant, job.jobId, jobs)) {
		return active.slice(1).find(({ grant }) => named(grant) && !jobCapFullWithout(grant, job.jobId, jobs)) ?? first;
	}
	return first ?? judged.filter(({ at }) => at.standing === P || at.standing === R).at(-1);
}

export interface GrantStore {
	sweep(now: string, jobs: readonly MandateUsageJob[]): Mandate[];
	withReviewerSpend(jobs: readonly MandateUsageJob[], grants?: readonly Mandate[]): MandateUsageJob[];
	tokenCeiling(): number;
}

/** Who decided: one active covering grant, or the expired grant continuing the job. */
export interface GrantPermission {
	selected?: Mandate;
	cause?: GrantCause;
	run?: { id: string; schedule_id: string };
}

/** A selected refusal throws; an expired continuation keeps its own caps. Nothing speaking passes. */
export function assertGrantsPermit(
	store: GrantStore,
	use: GrantUse,
	job: Omit<GrantJob, "inFlight" | "failed">,
	jobs: readonly MandateUsageJob[],
	now: string,
): GrantPermission {
	const record = inFlightRecord(job, jobs);
	const target = { ...job, startedAt: record?.dispatched_at ?? job.startedAt, inFlight: record !== undefined, failed: record?.phase === "failed" };
	const selected = selectGrant(store.sweep(now, jobs), use, target, now, jobs);
	if (!selected) return {};
	const { grant, at } = selected;
	if (at.standing === P && at.cause === "active") return { selected: grant, cause: at.cause };
	// A reviewer start (`cp_review`, the only `assertGrantsPermit("review")` caller) keeps its pre-rule path: an expired
	// grant neither refuses it (no fleet record, review not allowed, cap reached) nor speaks for it. Paused and revoked
	// still refuse. The expired row still binds a diff checkpoint, which `evaluateAuthority` reads through grantStanding.
	if (use === "review" && at.cause === "expired") return {};
	if (at.standing === P) {
		const cap = capReached(grant, store.withReviewerSpend(jobs, [grant]));
		if (cap) throw new MandateError(`${job.jobId}: expired mandate ${grant.id} ${cap} cap reached \u2014 no ${use} under it`);
		return { selected: grant, cause: at.cause };
	}
	throw new MandateError(`${job.jobId}: ${refusal(store, grant, use, at.cause, at.detail)}`);
}

function refusal(store: GrantStore, grant: Mandate, use: GrantUse, cause: GrantCause, detail?: string): string {
	if (cause === "expired") return `mandate ${grant.id} expired at ${grant.expiry} \u2014 ${detail}. A new job needs a new grant (cp_mandate issue).`;
	const state = `mandate ${grant.id} is ${grant.status}${grant.status === "paused" && grant.pause_reason ? ` (${grant.pause_reason})` : ""}`;
	const tokenCap = grant.status === "paused" && grant.pause_reason === "token_cap";
	if (use === "review") {
		return (
			`${state} \u2014 no new reviewer spend under it. ` +
			(tokenCap
				? `Raise its token cap (cp_mandate raise_tokens ${grant.id}), then review again.`
				: "Resume it, or have the operator issue a new grant (cp_mandate issue), then review again.")
		);
	}
	const raise = tokenCap && grant.spend_cap.tokens < store.tokenCeiling() ? `; raise it yourself: cp_mandate raise_tokens ${grant.id}` : "";
	if (use === "repair") return `${state} \u2014 no repair under it${raise}`;
	return `${state} \u2014 no new dispatch; in-flight continues${raise}`;
}
