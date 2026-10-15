/** Awaiting-merge parking: a handed-off human_handoff PR with no worker or lease. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, UsageSchema, validate, type ValidationResult } from "./core.ts";
import type { Narrow, Replace } from "./internal.ts";

export const FULL_SHA_PATTERN = "^[0-9a-f]{40}$";
const ShaSchema = Type.String({ pattern: FULL_SHA_PATTERN });
const RepoSchema = Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 200 });
const PrUrlSchema = Type.String({ pattern: "^https://\\S+$", maxLength: 500 });
const BranchSchema = Type.String({ minLength: 1, maxLength: 200 });
const EventIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const CursorSchema = Type.String({ minLength: 1, maxLength: 400 });

/** Remote events that turn a quiescent parked job into pending CP work (never a spawn by themselves). */
export const PARKED_PENDING_KINDS = ["changes_requested", "human_comment", "head_moved", "base_changed", "closed_unmerged"] as const;
export type ParkedPendingKind = (typeof PARKED_PENDING_KINDS)[number];

export const ParkedPendingSchema = Type.Object(
	{
		kind: StringEnum([...PARKED_PENDING_KINDS]),
		/** Opaque remote identity of the triggering event: one transition and one wake per id. */
		event_id: EventIdSchema,
		observed_at: IsoTimestampSchema,
		head_sha: Type.Optional(ShaSchema),
		base: Type.Optional(BranchSchema),
	},
	{ additionalProperties: false },
);
export type ParkedPending = Narrow<Static<typeof ParkedPendingSchema>, "kind", ParkedPendingKind>;

/**
 * The parking record on a fleet row (`phase: "awaiting_merge"`). `frozen_*` stop the execution clock and cost
 * at release; `pending` marks CP work owed (it leaves With-the-team) while the phase stays parked until resumed.
 */
export const AwaitingMergeSchema = Type.Object(
	{
		/** Increments on every park of the same job, so events from an earlier cycle are recognisably stale. */
		cycle: Type.Integer({ minimum: 1 }),
		pr_url: PrUrlSchema,
		repo: RepoSchema,
		branch: BranchSchema,
		head_sha: ShaSchema,
		base: BranchSchema,
		handed_at: IsoTimestampSchema,
		/** When worker shutdown was observed and the lease return confirmed; parking never precedes it. */
		released_at: IsoTimestampSchema,
		frozen_seconds: Type.Integer({ minimum: 0 }),
		frozen_usage: UsageSchema,
		last_human_activity_at: Type.Optional(IsoTimestampSchema),
		pending: Type.Optional(ParkedPendingSchema),
	},
	{ additionalProperties: false },
);
export type AwaitingMerge = Replace<Static<typeof AwaitingMergeSchema>, { pending?: ParkedPending }>;

/** A parked job with no pending CP work: it belongs With the team, not In flight. */
export function isQuiescentParked(record: { phase: string; awaiting_merge?: AwaitingMerge }): boolean {
	return record.phase === "awaiting_merge" && record.awaiting_merge !== undefined && record.awaiting_merge.pending === undefined;
}

// ---------------------------------------------------------------------------
// Release intent — state/runs/<id>/park-intent.json, written before any external effect
// ---------------------------------------------------------------------------

/** intent → worker_closed → lease_returned; recovery resumes from the recorded stage, never earlier. */
export const PARK_STAGES = ["intent", "worker_closed", "lease_returned"] as const;
export type ParkStage = (typeof PARK_STAGES)[number];

export const ParkIntentSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		cycle: Type.Integer({ minimum: 1 }),
		stage: StringEnum([...PARK_STAGES]),
		pr_url: PrUrlSchema,
		repo: RepoSchema,
		branch: BranchSchema,
		head_sha: ShaSchema,
		base: BranchSchema,
		/** The lease this job held when the intent was written; recovery returns only this identity. */
		lease_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		created_at: IsoTimestampSchema,
		updated_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type ParkIntent = Narrow<Static<typeof ParkIntentSchema>, "stage", ParkStage>;

export function validateParkIntent(value: unknown): ValidationResult<ParkIntent> {
	return validate<ParkIntent>(ParkIntentSchema, value);
}

// ---------------------------------------------------------------------------
// Batched watch — state/awaiting-merge-watch.json (one home-wide sweep, never per job)
// ---------------------------------------------------------------------------

export const PR_REMOTE_STATES = ["open", "merged", "closed"] as const;
export type PrRemoteState = (typeof PR_REMOTE_STATES)[number];

export const ParkedPrWatchSchema = Type.Object(
	{
		job_id: JobIdSchema,
		cycle: Type.Integer({ minimum: 1 }),
		pr_url: PrUrlSchema,
		state: StringEnum([...PR_REMOTE_STATES]),
		head_sha: ShaSchema,
		base: BranchSchema,
		merge_sha: Type.Optional(ShaSchema),
		/** Approvals by distinct reviewers; `approvals_required` null means unknown, never zero. */
		approvals: Type.Integer({ minimum: 0 }),
		approvals_required: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		/** Pagination cursors per connection; a cursor never advances past an unprocessed event. */
		cursors: Type.Object(
			{ comments: Type.Optional(CursorSchema), reviews: Type.Optional(CursorSchema), review_comments: Type.Optional(CursorSchema) },
			{ additionalProperties: false },
		),
		last_human_activity_at: Type.Optional(IsoTimestampSchema),
		observed_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type ParkedPrWatch = Narrow<Static<typeof ParkedPrWatchSchema>, "state", PrRemoteState>;

export const AwaitingMergeWatchFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		last_sweep_at: Type.Optional(IsoTimestampSchema),
		/** Global backoff (Retry-After / rate-limit reset); no sweep starts before it. */
		backoff_until: Type.Optional(IsoTimestampSchema),
		last_error: Type.Optional(Type.String({ maxLength: 500 })),
		prs: Type.Array(ParkedPrWatchSchema),
	},
	{ additionalProperties: false },
);
export type AwaitingMergeWatchFile = Narrow<Static<typeof AwaitingMergeWatchFileSchema>, "prs", ParkedPrWatch[]>;

export function validateAwaitingMergeWatchFile(value: unknown): ValidationResult<AwaitingMergeWatchFile> {
	const result = validate<AwaitingMergeWatchFile>(AwaitingMergeWatchFileSchema, value);
	if (!result.ok) return result;
	const errors = duplicates(result.value.prs.map((pr) => pr.job_id), "/prs", "job_id");
	for (const pr of result.value.prs) {
		if ((pr.state === "merged") !== (pr.merge_sha !== undefined)) errors.push(`/prs/${pr.job_id}: merge_sha is recorded exactly when the PR is merged`);
	}
	return errors.length === 0 ? result : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Stacked follow-ups — state/stack-followups.json (queued for the parent, never executed here)
// ---------------------------------------------------------------------------

/** A tracked child PR whose base was another tracked job's branch, captured before GitHub can retarget it. */
export const StackEdgeSchema = Type.Object(
	{
		parent_job: JobIdSchema,
		child_job: JobIdSchema,
		repo: RepoSchema,
		parent_branch: BranchSchema,
		child_branch: BranchSchema,
		observed_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type StackEdge = Static<typeof StackEdgeSchema>;

export const STACK_ACTION_STATUSES = ["pending", "done", "disposed"] as const;
export type StackActionStatus = (typeof STACK_ACTION_STATUSES)[number];

/** Plain-merge `target_base` into the child branch, push normally, retarget the child PR. No rebase, no force push. */
export const StackActionSchema = Type.Object(
	{
		/** `<parent_job>:<child_job>:<merge_sha>` — one action per parent merge and child. */
		id: Type.String({ minLength: 1, maxLength: 400 }),
		parent_job: JobIdSchema,
		child_job: JobIdSchema,
		repo: RepoSchema,
		child_branch: BranchSchema,
		previous_base: BranchSchema,
		target_base: BranchSchema,
		merge_sha: ShaSchema,
		queued_at: IsoTimestampSchema,
		status: StringEnum([...STACK_ACTION_STATUSES]),
		settled_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);
export type StackAction = Narrow<Static<typeof StackActionSchema>, "status", StackActionStatus>;

export const StackFollowupsFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		edges: Type.Array(StackEdgeSchema),
		actions: Type.Array(StackActionSchema),
	},
	{ additionalProperties: false },
);
export type StackFollowupsFile = Replace<Static<typeof StackFollowupsFileSchema>, { actions: StackAction[] }>;

export function validateStackFollowupsFile(value: unknown): ValidationResult<StackFollowupsFile> {
	const result = validate<StackFollowupsFile>(StackFollowupsFileSchema, value);
	if (!result.ok) return result;
	const { edges, actions } = result.value;
	const errors = [
		...duplicates(edges.map((edge) => `${edge.parent_job}:${edge.child_job}`), "/edges", "parent/child pair"),
		...duplicates(actions.map((action) => action.id), "/actions", "id"),
	];
	for (const edge of edges) if (edge.parent_job === edge.child_job) errors.push(`/edges/${edge.child_job}: a job cannot stack on itself`);
	for (const action of actions) {
		if (action.id !== `${action.parent_job}:${action.child_job}:${action.merge_sha}`) errors.push(`/actions/${action.id}: id must be <parent_job>:<child_job>:<merge_sha>`);
		if ((action.status === "pending") === (action.settled_at !== undefined)) errors.push(`/actions/${action.id}: settled_at is set exactly when the action is no longer pending`);
	}
	return errors.length === 0 ? result : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// CI evidence — state/runs/<id>/ci-evidence.json (head-keyed, provenance kept)
// ---------------------------------------------------------------------------

export const CI_EVIDENCE_RESULTS = ["success", "failure", "pending", "none", "unreadable"] as const;
export type CiEvidenceResult = (typeof CI_EVIDENCE_RESULTS)[number];
/** `forwarded` is display-only: native evidence alone gates the human_handoff handoff. */
export const CI_EVIDENCE_SOURCES = ["actions", "commit_status", "forwarded"] as const;
export type CiEvidenceSource = (typeof CI_EVIDENCE_SOURCES)[number];
export const CI_EVIDENCE_KEEP = 50;

export const CiObservationSchema = Type.Object(
	{
		head_sha: ShaSchema,
		result: StringEnum([...CI_EVIDENCE_RESULTS]),
		source: StringEnum([...CI_EVIDENCE_SOURCES]),
		observed_at: IsoTimestampSchema,
		url: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		/** Verified operator quote that forwarded this result; required for `forwarded`, forbidden otherwise. */
		operator_quote: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	},
	{ additionalProperties: false },
);
export type CiObservation = Static<typeof CiObservationSchema> & { result: CiEvidenceResult; source: CiEvidenceSource };

export const CiEvidenceFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		repo: RepoSchema,
		observations: Type.Array(CiObservationSchema, { maxItems: CI_EVIDENCE_KEEP }),
	},
	{ additionalProperties: false },
);
export type CiEvidenceFile = Narrow<Static<typeof CiEvidenceFileSchema>, "observations", CiObservation[]>;

export function validateCiEvidenceFile(value: unknown): ValidationResult<CiEvidenceFile> {
	const result = validate<CiEvidenceFile>(CiEvidenceFileSchema, value);
	if (!result.ok) return result;
	const errors: string[] = [];
	result.value.observations.forEach((observation, index) => {
		if ((observation.source === "forwarded") !== (observation.operator_quote !== undefined)) {
			errors.push(`/observations/${index}: operator_quote is required for a forwarded result and forbidden for a native one`);
		}
	});
	return errors.length === 0 ? result : { ok: false, errors };
}

function duplicates(keys: string[], at: string, what: string): string[] {
	const seen = new Set<string>();
	const errors: string[] = [];
	for (const key of keys) {
		if (seen.has(key)) errors.push(`${at}: duplicate ${what} "${key}"`);
		seen.add(key);
	}
	return errors;
}
