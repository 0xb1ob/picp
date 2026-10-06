/**
 * A pending checkpoint decided by the mandate store when an active grant permits it (`evaluateAuthority`),
 * journaled on that grant. Moved out of src/mandate.ts to keep it under the module size cap.
 */
import type { CheckpointStore } from "./checkpoint.ts";
import { type Checkpoint, checkpointAwaitingId, isoTimestamp } from "./contracts.ts";
import { evaluateAuthority, type MandateStore, type MandateSubject } from "./mandate.ts";

export function autoDecideCheckpoint(
	store: CheckpointStore,
	checkpoint: Checkpoint,
	subject: MandateSubject,
	mandates: MandateStore,
): Checkpoint {
	if (checkpoint.decision !== "pending") return checkpoint;
	const now = subject.now ?? isoTimestamp();
	const jobs = mandates.withReviewerSpend(subject.usageJobs ?? []);
	mandates.sweep(now, jobs);
	const scope = subject.scheduleId ? {} : mandates.scheduleOf(subject.jobId);
	const verdict = evaluateAuthority({ ...subject, ...scope, createdAt: subject.createdAt ?? mandates.jobCreatedAt(subject.jobId), now, usageJobs: jobs }, mandates.list());
	if (!verdict.permitted) return checkpoint;
	const decided = store.decide(checkpoint.job_id, true, {
		by: `mandate:${verdict.mandateId}`,
		note: verdict.clause,
		at: now,
		basis: { mandate: verdict.mandateId, clause: verdict.clause },
		...(checkpoint.scope ? { scope: checkpoint.scope } : {}),
	});
	mandates.journal(verdict.mandateId, {
		at: decided.decided_at ?? now,
		job_id: checkpoint.job_id,
		kind: store.kind,
		clause: verdict.clause,
		checkpoint: checkpointAwaitingId(checkpoint.job_id, store.kind, checkpoint.scope),
	});
	return decided;
}
