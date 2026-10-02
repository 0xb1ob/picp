/**
 * One operator-approved final fix at the review cap (pi-command-post-epic-pr-a-jje.3).
 *
 * `REVIEW_MAX_ATTEMPTS` stays five. When the fifth review read the whole subject
 * (a reviewer ran, nothing was truncated) and still asked for revisions, the
 * cap turns it into escalate/policy and no sixth review ever runs. Before this,
 * the only exit from that state was a hand merge.
 *
 * The exit is one scoped human decision, `final_fix`, bound to the job, its PR
 * and the capped head (`state/checkpoints/<id>.final-fix-<head12>.json`):
 *
 *  1. `DiffReview` declares it `pending` with the exact findings as evidence.
 *  2. Only an operator quote approves it (`cp_decide`; `CheckpointStore.decide`
 *     refuses a final-fix approval without one on every surface). A mandate
 *     never can (`evaluateAuthority` refuses the kind, and an answer without a
 *     quote is ignored here). It is bound to the PR it names, and it is only
 *     promoted while the live head is still the capped head.
 *  3. Approved, `cp_integrate` promotes the original implementer **once** with
 *     those findings and records the envelope generation the fix must report
 *     in (`state/runs/<id>/final-fix.json`).
 *  4. That generation's report binds its pushed head. Only that exact head, in
 *     that generation, stands in for a passing review — in `cp_integrate`, in the
 *     pipeline's opt-in review hold and in the deferred merge-ask gate.
 *  5. A later report, a report that did not move the head, or a push after the
 *     report voids it for good.
 *
 * It is operator risk acceptance, not a reviewer pass: red CI, GitHub's own
 * refusal and `--match-head-commit` still decide the merge, and the flagged
 * `diff` authorization keeps its own file and meaning.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { CheckpointStore } from "./checkpoint.ts";
import {
	type Checkpoint,
	checkpointAwaitingId,
	DecisionBasisSchema,
	type DiffVerdict,
	DiffVerdictSchema,
	type FleetRecord,
	type GateReview,
	IsoTimestampSchema,
	isoTimestamp,
	paths,
	REVIEW_MAX_ATTEMPTS,
	SCHEMA_VERSION,
	validate,
} from "./contracts.ts";
import { FleetStore } from "./fleet.ts";
import { atomicWriteJson } from "./json-store.ts";
import { readFiledEnvelope } from "./teardown-head.ts";

const FinalFixRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: Type.String({ minLength: 1 }),
		capped_head: Type.String({ minLength: 7 }),
		/** The PR the human approved the fix for; a different PR never inherits it. */
		pr_url: Type.String({ minLength: 1 }),
		/** The Awaiting-you id of the answered checkpoint. */
		checkpoint: Type.String({ minLength: 1 }),
		decided_by: Type.String({ minLength: 1 }),
		basis: Type.Optional(DecisionBasisSchema),
		promoted_at: IsoTimestampSchema,
		/** The envelope generation whose report is the fix. */
		fix_generation: Type.Integer({ minimum: 1 }),
		fix_head: Type.Optional(Type.String({ minLength: 7 })),
		bound_at: Type.Optional(IsoTimestampSchema),
		invalidated: Type.Optional(
			Type.Object({ at: IsoTimestampSchema, reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
export type FinalFixRecord = Static<typeof FinalFixRecordSchema>;

export type FinalFix =
	| { state: "none" }
	| {
			/** pending/declined/invalid: blocked on a human; promoted: waiting for the fix report; approved: promote due. */
			state: "pending" | "declined" | "approved" | "promoted" | "invalid" | "accepted";
			reason: string;
			capped: DiffVerdict;
			checkpoint: Checkpoint;
			record?: FinalFixRecord;
	  };

/** A final-fix checkpoint is scoped like a merge one: the first 12 hex of the head. */
export function finalFixScope(head: string): string {
	return head.trim().toLowerCase().slice(0, 12);
}

export function finalFixFile(jobId: string): string {
	return `${paths.runDir(jobId)}/final-fix.json`;
}

function prUrlOf(job: FleetRecord): string | undefined {
	return job.receipts?.find((receipt) => receipt.kind === "pr")?.url;
}

function samePr(a: string | undefined, b: string | undefined): boolean {
	const norm = (url: string | undefined) => (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
	return norm(a).length > 0 && norm(a) === norm(b);
}

function same(a: string | undefined, b: string | undefined): boolean {
	const left = (a ?? "").trim().toLowerCase();
	const right = (b ?? "").trim().toLowerCase();
	return left.length >= 7 && right.length >= 7 && (left.startsWith(right) || right.startsWith(left));
}

/**
 * DiffReview, right after persisting a verdict: a fifth, complete review whose
 * reviewer still asked for revisions declares the question. Anything else —
 * a pass, a reviewer's own escalate, a truncated subject, an earlier attempt —
 * declares nothing. Idempotent (`CheckpointStore.request`).
 */
export function requestFinalFix(
	home: string,
	input: { verdict: DiffVerdict; review?: GateReview; prUrl?: string },
): Checkpoint | undefined {
	const { verdict, review, prUrl } = input;
	if (
		!prUrl ||
		verdict.attempt !== REVIEW_MAX_ATTEMPTS ||
		review?.verdict !== "revise" ||
		verdict.verdict !== "escalate" ||
		verdict.cause !== "policy" ||
		!verdict.model ||
		verdict.diff_stat.truncated
	) {
		return undefined;
	}
	// The reviewer's own findings, verbatim: at most 10 revisions + 10 reasons (GateReviewSchema),
	// each at most 400 chars: exactly the checkpoint's 20-item evidence bound, so none is ever dropped. The
	// parent's cap/flag notes are not findings and stay on the verdict.
	const findings = [...(review.revisions ?? []), ...review.reasons];
	const head = verdict.head_sha;
	return new CheckpointStore(home, { kind: "final_fix" }).request({
		jobId: verdict.job_id,
		scope: finalFixScope(head),
		prUrl,
		question:
			`One final fix for ${verdict.job_id} (${prUrl}) at capped head ${head.slice(0, 12)}? ` +
			`Review ${verdict.attempt} of ${REVIEW_MAX_ATTEMPTS} still names ${findings.length} finding(s) and no sixth review runs. ` +
			"Approving promotes the original implementer once with exactly these findings; only the head its next report " +
			"names may merge, and only on green CI and GitHub's own permission. A later push or report voids it. " +
			`Operator text only — a mandate cannot grant this. Capped review: ${paths.reviewFile(verdict.job_id, verdict.attempt)} ` +
			`(${verdict.model}); the evidence is every finding, verbatim.`,
		evidence: findings,
	});
}

/** The fifth review, when it is a complete, reviewer-decided escalate — the only subject this exception has. */
export function cappedVerdict(home: string, jobId: string): DiffVerdict | undefined {
	const file = join(home, paths.reviewFile(jobId, REVIEW_MAX_ATTEMPTS));
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validate<DiffVerdict>(DiffVerdictSchema, JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.ok) return undefined;
		const verdict = parsed.value;
		return verdict.verdict === "escalate" && verdict.cause === "policy" && verdict.model && !verdict.diff_stat.truncated
			? verdict
			: undefined;
	} catch {
		return undefined;
	}
}

export function readFinalFixRecord(home: string, jobId: string): FinalFixRecord | undefined {
	try {
		const parsed = validate<FinalFixRecord>(FinalFixRecordSchema, JSON.parse(readFileSync(join(home, finalFixFile(jobId)), "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

function writeRecord(home: string, record: FinalFixRecord): FinalFixRecord {
	const parsed = validate<FinalFixRecord>(FinalFixRecordSchema, record);
	if (!parsed.ok) throw new Error(`refusing to write an invalid final-fix record: ${parsed.errors.join("; ")}`);
	atomicWriteJson(join(home, finalFixFile(record.job_id)), record);
	return record;
}

/**
 * Where this job stands on its one final fix, for the head that would merge.
 * Writes only to bind the fix report's head or to record that it was voided,
 * both once; every other answer is read from the checkpoint, the record, the
 * fleet generation and the filed envelope.
 */
export function resolveFinalFix(
	home: string,
	job: FleetRecord,
	head: string,
	options: { now?: Date; prUrl?: string } = {},
): FinalFix {
	const jobId = job.job_id;
	const now = options.now ?? new Date();
	const pr = options.prUrl ?? prUrlOf(job);
	const capped = cappedVerdict(home, jobId);
	if (!capped) return { state: "none" };
	const scope = finalFixScope(capped.head_sha);
	const checkpoint = new CheckpointStore(home, { kind: "final_fix" }).get(jobId, { scope });
	if (!checkpoint) return { state: "none" };
	const id = checkpointAwaitingId(jobId, "final_fix", scope);
	const at = `${jobId}: one final fix at capped head ${capped.head_sha.slice(0, 12)}`;
	const out = (state: Exclude<FinalFix["state"], "none">, reason: string, record?: FinalFixRecord): FinalFix => ({
		state,
		reason,
		capped,
		checkpoint,
		...(record ? { record } : {}),
	});
	if (checkpoint.decision === "pending") {
		return out("pending", `${at} awaits a human: answer ${id} with an operator quote (cp_decide). No sixth review runs; nothing was merged.`);
	}
	const quoted = checkpoint.basis !== undefined && "operator_quote" in checkpoint.basis;
	if (checkpoint.decision === "declined" || !quoted || (checkpoint.decided_by ?? "").startsWith("mandate:")) {
		return out("declined", `${at} was not granted on an operator quote (${checkpoint.decided_by ?? "?"}: ${checkpoint.decision}). Nothing was merged.`);
	}
	if (!samePr(checkpoint.pr_url, pr)) {
		return out("invalid", `${at} was approved for ${checkpoint.pr_url ?? "no PR"}, not ${pr ?? "an unknown PR"}; another PR never inherits it. Nothing was merged.`);
	}
	const record = readFinalFixRecord(home, jobId);
	if (!record || record.capped_head !== capped.head_sha) {
		// Promotion is for the capped head the human read: an unreported push before it is unreviewed code.
		if (!same(head, capped.head_sha)) {
			return out("invalid", `${at} cannot be promoted: the head moved to ${head.slice(0, 12)} before promotion. Nothing was merged.`);
		}
		return out("approved", `${at} was approved by ${checkpoint.decided_by ?? "a human"}; the implementer is promoted once.`);
	}
	if (!samePr(record.pr_url, pr)) {
		return out("invalid", `${at} was promoted for ${record.pr_url}, not ${pr ?? "an unknown PR"}. Nothing was merged.`, record);
	}
	if (record.invalidated) return out("invalid", `${at} is void: ${record.invalidated.reason}. Nothing was merged.`, record);
	const voided = (reason: string): FinalFix =>
		out("invalid", `${at} is void: ${reason}. Nothing was merged.`, writeRecord(home, { ...record, invalidated: { at: isoTimestamp(now), reason } }));
	const generation = (job.supersessions ?? 0) + 1;
	let bound = record;
	if (!bound.fix_head) {
		if (generation > bound.fix_generation) return voided(`envelope generation ${generation} superseded fix generation ${bound.fix_generation} before it reported`);
		if (generation < bound.fix_generation || !job.reported_at) {
			return out("promoted", `${at}: the implementer was promoted; waiting for its fix report (generation ${bound.fix_generation}). Nothing was merged.`, bound);
		}
		const envelope = readFiledEnvelope(home, jobId);
		if (!envelope?.head_sha) return voided(`the fix report (generation ${generation}) named no pushed head`);
		if (same(envelope.head_sha, capped.head_sha)) return voided("the fix report did not move the head");
		bound = writeRecord(home, { ...bound, fix_head: envelope.head_sha, bound_at: isoTimestamp(now) });
	}
	if (generation !== bound.fix_generation) return voided(`envelope generation ${generation} superseded fix generation ${bound.fix_generation}`);
	if (!same(head, bound.fix_head)) return voided(`the head moved to ${head.slice(0, 12)} after the fix report named ${bound.fix_head?.slice(0, 12)}`);
	return out(
		"accepted",
		`review: operator-approved final fix at ${head.slice(0, 12)} (generation ${bound.fix_generation}, capped ${capped.head_sha.slice(0, 12)}, ${bound.decided_by}) — not a reviewer pass`,
		bound,
	);
}

/** The one promote an approved final fix gets: the findings the human approved, verbatim. */
export function finalFixMessage(fix: { capped: DiffVerdict; checkpoint: Checkpoint }): string {
	const { capped, checkpoint } = fix;
	return [
		`One final fix for ${capped.job_id} at capped head ${capped.head_sha.slice(0, 12)}, approved by ${checkpoint.decided_by ?? "a human"}.`,
		`Review ${capped.attempt} of ${REVIEW_MAX_ATTEMPTS} surfaced these findings and no further review will run:`,
		"",
		...(checkpoint.evidence ?? []).map((finding) => `- ${finding}`),
		"",
		`Fix all of them on the same branch (${capped.job_id}) with one more commit and push it — never a second PR, never a`,
		"new branch. Run the project's checks, then call report_result once with the new pushed head_sha. Only that",
		"reported head may merge; a later push or a second report voids this approval.",
	].join("\n");
}

/** After the promote was delivered: the generation the fix must report in (read from the fleet after the reopen). */
export function recordFinalFixPromotion(home: string, job: FleetRecord, fix: { capped: DiffVerdict; checkpoint: Checkpoint }, now: Date = new Date()): FinalFixRecord {
	const { capped, checkpoint } = fix;
	return writeRecord(home, {
		schema_version: SCHEMA_VERSION,
		job_id: job.job_id,
		capped_head: capped.head_sha,
		pr_url: checkpoint.pr_url ?? "",
		checkpoint: checkpointAwaitingId(job.job_id, "final_fix", finalFixScope(capped.head_sha)),
		decided_by: checkpoint.decided_by ?? "operator",
		...(checkpoint.basis ? { basis: checkpoint.basis } : {}),
		promoted_at: isoTimestamp(now),
		fix_generation: (job.supersessions ?? 0) + 1,
	});
}

/**
 * The deferred merge-ask gate's reader: a bound fix head counts as reviewed only while
 * `resolveFinalFix` still accepts it against the live fleet generation and PR — a later
 * report (even at the same head) or another PR voids it here, before the gate sees it.
 */
export function acceptedFinalFixHeads(home: string, jobId: string): string[] {
	const record = readFinalFixRecord(home, jobId);
	if (!record?.fix_head || record.invalidated) return [];
	let job: FleetRecord | undefined;
	try {
		job = new FleetStore({ home }).get(jobId);
	} catch {
		return []; // an unreadable fleet proves no generation, so nothing counts as reviewed
	}
	return job && resolveFinalFix(home, job, record.fix_head).state === "accepted" ? [record.fix_head] : [];
}
