/**
 * awaiting_merge PR3: what one batch observation of a parked PR means, and applying it. `decideExit` is pure;
 * `applyExit` runs under the job claim, re-reads the record, and is idempotent so an interrupted apply re-runs whole.
 * No path here spawns a worker, takes a lease or runs git: merged closes the job, anything else marks it pending.
 */

import { type AwaitingMerge, isoTimestamp, type ParkedPending, type ParkedPendingKind } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { LedgerLike } from "./integrate.ts";
import { type JobClaims, withJobClaim } from "./job-claims.ts";
import type { MergeStore } from "./merges.ts";
import type { RunRegistry } from "./runs.ts";
import type { StackFollowups } from "./stack-followups.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";

/** A human event newer than the handoff and the stored cursors. */
export interface HumanEvent {
	kind: "changes_requested" | "human_comment";
	id: string;
	at: string;
}

/** One PR as the batch read saw it; `events` are new human events, oldest first. */
export interface PrSnapshot {
	url: string;
	number: number;
	state: "open" | "merged" | "closed";
	head_sha: string;
	base: string;
	head_branch?: string;
	merge_sha?: string;
	merged_at?: string;
	events: HumanEvent[];
}

export type ExitDecision =
	| { kind: "merged" }
	| { kind: "pending"; pending: ParkedPending; last_human_activity_at?: string }
	| { kind: "activity"; last_human_activity_at: string }
	| { kind: "none" };

/**
 * Precedence: merged > closed_unmerged > head_moved > changes_requested > human_comment > base_changed > activity.
 * An existing pending is never replaced by a lower-priority event; only a close overrides it (merged always wins).
 */
export function decideExit(parked: AwaitingMerge, snap: PrSnapshot, now: Date): ExitDecision {
	if (snap.state === "merged") return { kind: "merged" };
	const observed_at = isoTimestamp(now);
	const latest = (kind: HumanEvent["kind"]) => snap.events.filter((event) => event.kind === kind).at(-1);
	const changes = latest("changes_requested");
	const comment = latest("human_comment");
	const candidates: (ParkedPending | undefined)[] = [
		snap.state === "closed" ? { kind: "closed_unmerged", event_id: `closed:${parked.cycle}`, observed_at } : undefined,
		snap.head_sha !== parked.head_sha ? { kind: "head_moved", event_id: `head:${snap.head_sha}`, observed_at, head_sha: snap.head_sha } : undefined,
		changes ? { kind: "changes_requested", event_id: changes.id, observed_at } : undefined,
		comment ? { kind: "human_comment", event_id: comment.id, observed_at } : undefined,
		snap.base !== parked.base ? { kind: "base_changed", event_id: `base:${snap.base}`.slice(0, 200), observed_at, base: snap.base } : undefined,
	];
	const top = candidates.find((candidate) => candidate !== undefined);
	const newest = snap.events.map((event) => event.at).sort().at(-1);
	const activity = newest && (!parked.last_human_activity_at || newest > parked.last_human_activity_at) ? newest : undefined;
	const replaces = top && (!parked.pending || (top.kind === "closed_unmerged" && parked.pending.kind !== "closed_unmerged"));
	if (replaces) return { kind: "pending", pending: top, ...(activity ? { last_human_activity_at: activity } : {}) };
	return activity ? { kind: "activity", last_human_activity_at: activity } : { kind: "none" };
}

export interface ExitPorts {
	fleet: FleetStore;
	merges: Pick<MergeStore, "recordObserved">;
	ledger: () => LedgerLike;
	stacks: Pick<StackFollowups, "queueForMerge">;
	wakeups: { enqueue(input: DurableWakeupInput): boolean };
	/** After a merge closes the job: release dependents (`ArmedDispatches#release`). */
	onLanded?: () => Promise<void>;
	claims?: JobClaims;
	runs?: RunRegistry;
	now?: () => Date;
}

export interface ExitOutcome {
	job_id: string;
	applied: "merged" | ParkedPendingKind | "activity" | "none" | "skipped";
	reason?: string;
	stack_actions?: number;
}

/** Apply one observation to a parked job of `cycle`; another claim holder or a moved record skips it, never waits. */
export function applyExit(ports: ExitPorts, jobId: string, cycle: number, snap: PrSnapshot): Promise<ExitOutcome> {
	return withJobClaim(ports.claims, jobId, "watch", () => apply(ports, jobId, cycle, snap), async (holder) => ({
		job_id: jobId, applied: "skipped", reason: `${holder} is in flight on ${jobId}; the next sweep re-reads it`,
	}));
}

async function apply(ports: ExitPorts, jobId: string, cycle: number, snap: PrSnapshot): Promise<ExitOutcome> {
	const now = (ports.now ?? (() => new Date()))();
	const record = ports.fleet.get(jobId);
	const parked = record?.awaiting_merge;
	if (!record || record.phase !== "awaiting_merge" || !parked || parked.cycle !== cycle) {
		return { job_id: jobId, applied: "skipped", reason: `${jobId} is ${record?.phase ?? "gone"}, not parked in cycle ${cycle}` };
	}
	const decision = decideExit(parked, snap, now);
	if (decision.kind === "none") return { job_id: jobId, applied: "none" };
	if (decision.kind === "merged") return landed(ports, jobId, cycle, snap, now);
	await patchParked(ports.fleet, jobId, cycle, (job) => {
		if (decision.last_human_activity_at) job.last_human_activity_at = decision.last_human_activity_at;
		if (decision.kind === "pending") job.pending = decision.pending;
	});
	if (decision.kind === "activity") return { job_id: jobId, applied: "activity" };
	const { pending } = decision;
	ports.runs?.open(jobId).cp("awaiting_merge_exit", { exit: pending.kind, event_id: pending.event_id, pr_url: parked.pr_url });
	ports.wakeups.enqueue({
		id: boundedWakeupId(`awaiting-merge:pending:${jobId}:${cycle}:${pending.event_id}`),
		kind: "recovery",
		job_id: jobId,
		keys: [`parked-cycle:${cycle}`],
		content: `[cp-awaiting-merge] ${jobId}: ${parked.pr_url} — ${pending.kind.replaceAll("_", " ")} while parked with the team. ` +
			`It stays parked until you act: cp_send ${jobId} resumes it on a fresh lease.`,
	});
	return { job_id: jobId, applied: pending.kind };
}

/** Receipt → ledger close → stack follow-ups → fleet done → dependents → one wake; every step is idempotent. */
async function landed(ports: ExitPorts, jobId: string, cycle: number, snap: PrSnapshot, now: Date): Promise<ExitOutcome> {
	const record = ports.fleet.get(jobId)!;
	const { receipt } = await ports.merges.recordObserved(jobId, {
		provider: "github", url: snap.url, number: snap.number, state: "merged", source_branch: snap.head_branch ?? record.branch,
		target_branch: snap.base, head_sha: snap.head_sha,
		...(snap.merge_sha ? { merge_commit_sha: snap.merge_sha } : {}), ...(snap.merged_at ? { merged_at: snap.merged_at } : {}),
	}, "awaiting-merge watch");
	await ports.ledger().close(jobId, `merged: ${receipt.pr_url}`);
	const actions = ports.stacks.queueForMerge(jobId, receipt.merge_commit_sha, snap.base);
	await ports.fleet.mutate((jobs) => {
		const job = jobs.find((candidate) => candidate.job_id === jobId);
		if (!job || job.phase !== "awaiting_merge" || job.awaiting_merge?.cycle !== cycle) return;
		job.phase = "done";
		job.closed_at = isoTimestamp(now);
		job.closed_reason = "gated";
	});
	ports.runs?.open(jobId).cp("awaiting_merge_exit", { exit: "merged", pr_url: receipt.pr_url, merge_commit_sha: receipt.merge_commit_sha });
	await ports.onLanded?.();
	const stacked = actions.length ? ` ${actions.length} stacked PR(s) now owe a merge-and-retarget onto ${snap.base}: ${actions.map((action) => action.child_job).join(", ")}.` : "";
	ports.wakeups.enqueue({
		id: boundedWakeupId(`awaiting-merge:merged:${jobId}:${cycle}`),
		kind: "recovery",
		job_id: jobId,
		content: `[cp-awaiting-merge] ${jobId}: the team merged ${receipt.pr_url} (${receipt.merge_commit_sha.slice(0, 12)}); job closed.${stacked}`,
	});
	return { job_id: jobId, applied: "merged", stack_actions: actions.length };
}

async function patchParked(fleet: FleetStore, jobId: string, cycle: number, change: (parked: AwaitingMerge) => void): Promise<void> {
	await fleet.mutate((jobs) => {
		const job = jobs.find((candidate) => candidate.job_id === jobId);
		if (job?.phase === "awaiting_merge" && job.awaiting_merge?.cycle === cycle) change(job.awaiting_merge);
	});
}
