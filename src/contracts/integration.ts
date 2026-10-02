/** Merge receipts, merge authority, integration records and the CI/PR watch. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import type { Narrow, Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// CI / PR watch (cp-e2d) — the fifth unasked wake-up
// ---------------------------------------------------------------------------

/**
 * How often the parent asks GitHub about the PRs it is holding (`src/ci-watch.ts`).
 *
 * This is the one place the command post reaches a *third-party* server on a
 * timer, and it is deliberately slow. Nothing local changes when CI finishes or
 * a PR merges — no worker emits an event for it (workers are forbidden from
 * waiting for CI, cp-kzc) and no file moves — so the only way the fact can ever
 * reach the parent is a periodic read of the remote, exactly as `src/wedged.ts`
 * is the only way an emitting-nothing worker can be seen.
 *
 * Overridable per home with `CP_CI_WATCH_SECONDS` (see `ciWatchIntervalMs()` in
 * src/ci-watch.ts). A malformed or non-positive value falls back to this
 * default rather than disabling the watch, for the same reason
 * `wedgedToolCallSeconds()` does: a typo in an env var must not silently turn
 * detection off.
 */
export const CI_WATCH_INTERVAL_MS = 60_000;

/**
 * The cadence multiplier for a job whose CI verdict is already known and
 * announced for its current head: only the merge question is left, and that one
 * is answered by a human on their own schedule.
 */
export const CI_WATCH_IDLE_MULTIPLIER = 5;

/** The ceiling on the per-job error backoff. 15 minutes, then it stops growing. */
export const CI_WATCH_MAX_BACKOFF_MS = 900_000;

/**
 * How long a sent-but-unobserved `cp-ci` wake-up is left alone before it is
 * derived and sent again (cp-nx7's rule, applied to this transport). Delivery is
 * **at-least-once**: a duplicate CI notice is idempotent and visible, a lost one
 * is neither — and this whole module exists because a missed wake-up is
 * invisible.
 */
export const CI_WATCH_DELIVERY_RETRY_SECONDS = 120;

/** Announced keys kept per job. Bounded by force-pushes, not by history. */
export const CI_WATCH_KEEP_ANNOUNCED = 50;

// ---------------------------------------------------------------------------
// Merge receipt (cp-vk1) — state/runs/<job-id>/merge.json
// ---------------------------------------------------------------------------

/**
 * How the PR was integrated. Recorded because it is the reason ancestry cannot
 * answer "did this land?": `squash` and `rebase` both rewrite the commit, so the
 * branch tip is never an ancestor of the base afterwards.
 */
export const MERGE_STRATEGIES = ["squash", "rebase", "merge", "unknown"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];
export const MergeStrategySchema = StringEnum([...MERGE_STRATEGIES]);

/** A 40- or 64-char hex object name, as git and the GitHub API report them. */
const CommitShaSchema = Type.String({ pattern: "^[0-9a-f]{7,64}$" });

// ---------------------------------------------------------------------------
// Merge authority (cp-e0c, answering cp-x7i) — repo-derived, per head sha
// ---------------------------------------------------------------------------

/**
 * Which rule permitted a merge. `repo_derived` means `cp_integrate` read that
 * GitHub itself would accept the merge unforced (mergeStateStatus ∈ {CLEAN,
 * HAS_HOOKS}) and merged without minting a checkpoint; `human_checkpoint` means
 * this home could not read whether the repo permits the merge (or could not
 * observe CI at all) and fell back to a per-head `/cp-authorize`. Additive to
 * `IntegrationRecordSchema`/`MergeReceiptSchema`, never a replacement for the
 * checkpoint machinery, which stays as that named fallback.
 */
export const MERGE_AUTHORITIES = ["repo_derived", "human_checkpoint"] as const;
export type MergeAuthorityKind = (typeof MERGE_AUTHORITIES)[number];
export const MergeAuthorityKindSchema = StringEnum([...MERGE_AUTHORITIES]);

/**
 * The audit trail for one merge decision: which rule permitted it, and enough
 * of the evidence that "why did this merge happen" is answerable from disk,
 * months later, with no GitHub call. Written before the merge is attempted
 * (`integration_permitted`), and again onto the integration record and the
 * merge receipt once the merge lands.
 */
export const MergeAuthoritySchema = Type.Object(
	{
		kind: MergeAuthorityKindSchema,
		head_sha: CommitShaSchema,
		merge_state_status: Type.Optional(Type.String({ maxLength: 40 })),
		review_decision: Type.Optional(Type.String({ maxLength: 40 })),
		/** e.g. "gh api repos/{owner}/{repo}/rules/branches/main", or "unreadable". */
		rules_source: Type.Optional(Type.String({ maxLength: 200 })),
		rules: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 20 })),
		/** `human_checkpoint` only: the file a human actually answered. */
		checkpoint_file: Type.Optional(Type.String({ maxLength: 300 })),
		decided_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type MergeAuthority = Replace<Static<typeof MergeAuthoritySchema>, { kind: MergeAuthorityKind }>;

/**
 * state/runs/<job-id>/merge.json — the observed fact that this job's PR landed.
 *
 * The mechanism behind "confirm the PR merged" (cp-vk1). Before it existed the
 * teardown gate could only ask git whether the branch content was an ancestor
 * of the base, which is false for every squash- and rebase-merged PR, so the
 * only exit from a landed-but-unprovable job was `force` — a weaker claim than
 * the evidence supported.
 *
 * Written from what `gh pr view` reported, never from an assertion: a receipt
 * exists only for a PR GitHub itself called `MERGED` with a merge commit, so
 * reading one back is reading an observation.
 */
export const MergeReceiptSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		/** The job whose delivery landed. `branch === job_id` by contract. */
		job_id: JobIdSchema,
		pr_url: Type.String({ minLength: 1, maxLength: 500 }),
		pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
		/** The commit the merge produced on the base — squash, rebase or merge. */
		merge_commit_sha: CommitShaSchema,
		/** The PR head commit that was merged: what the local tip must still be. */
		head_sha: CommitShaSchema,
		head_branch: Type.String({ minLength: 1, maxLength: 200 }),
		/** Whether the head branch is gone from the remote (GitHub's auto-delete). */
		head_branch_deleted: Type.Optional(Type.Boolean()),
		base_branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		strategy: Type.Optional(MergeStrategySchema),
		merged_at: Type.Optional(IsoTimestampSchema),
		recorded_at: IsoTimestampSchema,
		/** The channel that observed the merge (`gh pr view`, an operator command). */
		recorded_by: Type.String({ minLength: 1, maxLength: 120 }),
		/** Which rule permitted this merge (cp-e0c). Absent: not observed by this tool. */
		authority: Type.Optional(MergeAuthoritySchema),
	},
	{ additionalProperties: false },
);
export type MergeReceipt = Replace<Static<typeof MergeReceiptSchema>, { strategy?: MergeStrategy; authority?: MergeAuthority }>;

// ---------------------------------------------------------------------------
// Integration (cp-uug) — state/runs/<job-id>/integration.json
// ---------------------------------------------------------------------------

/**
 * The merge sequence, as steps. Each one has a precondition read from git or
 * `gh` and a postcondition verified in code, which is the whole argument for a
 * tool rather than a role: a model in this loop can only add an unverifiable
 * claim to a chain where every link is independently checkable.
 */
export const INTEGRATION_STEPS = [
	/** Nothing has been done yet for this job. */
	"start",
	/** The per-PR, per-head merge authorization was requested or read (fallback path). */
	"authorize",
	/**
	 * Whether the repository itself would accept the merge unforced was read
	 * (cp-e0c). Either it merges (`repo_derived`), it is surfaced as merge
	 * pending, or the fallback checkpoint is requested (`unreadable`/no CI).
	 */
	"permit",
	/** The PR was behind its base and a server-side rebase was asked for. */
	"fresh",
	/** The PR conflicts; the implementer was promoted to resolve it. */
	"conflict",
	/** CI was read for the pushed head. */
	"ci",
	/** Stopped: no passing `cp_review` on this head (or a patch-equivalent of it). */
	"review",
	/** `gh pr merge --squash`, deliberately without `--delete-branch`. */
	"merge",
	/** `cp_merged` / MergeStore.record wrote the receipt. */
	"record",
	/** The leased worktree was brought back to origin after a server-side rebase. */
	"sync",
	/** `cp_teardown`'s gates ran; the lease came back. */
	"teardown",
	/** The remote head branch was deleted — only ever after teardown. */
	"delete_head",
	/** The br issue was closed with a reason. */
	"close",
	/** Everything above holds. */
	"done",
] as const;
export type IntegrationStep = (typeof INTEGRATION_STEPS)[number];
export const IntegrationStepSchema = StringEnum([...INTEGRATION_STEPS]);

/**
 * What the caller does next. Branch on this, never on the prose reason — the
 * same rule the gate's `cause` already establishes.
 *
 *  | next | meaning |
 *  |---|---|
 *  | `advance` | one step landed; call `cp_integrate` again |
 *  | `wait` | CI is unfinished for the pushed head; nothing to do yet |
 *  | `review` | no passing `cp_review` on this head; run it, never re-review an unchanged one |
 *  | `resolve` | the job's own implementer was promoted; wait for its report |
 *  | `retry` | an operational fault (gh 403, rate limit); nothing was mutated |
 *  | `surface` | a human decision is required; nothing was mutated |
 *  | `done` | the delivery landed, was recorded, torn down and closed |
 */
export const INTEGRATION_NEXT = ["advance", "wait", "review", "resolve", "retry", "surface", "done"] as const;
export type IntegrationNext = (typeof INTEGRATION_NEXT)[number];
export const IntegrationNextSchema = StringEnum([...INTEGRATION_NEXT]);

/**
 * state/runs/<job-id>/integration.json — what integration has already done.
 *
 * Read for continuity and for the two bounded counters, **never** as the source
 * of truth for "which step is due": `advance` recomputes that from git, `gh`, and the review store
 * every call, which is what makes it resumable across a parent restart and what
 * stops a stale record from re-merging anything.
 *
 * Deliberately absent: any field that could be read as *standing* merge
 * authority — no session flag, no expiry, no "always allow" that a human could
 * set once and have it apply to every future head. `merge_authority` (cp-e0c,
 * answering cp-x7i) is the opposite of that: a per-decision audit fact, read
 * fresh from `gh` for one specific head sha every time, naming *which rule*
 * permitted (or a human authorized) that one merge — never a grant that
 * outlives the head it was computed for.
 */
export const IntegrationRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		branch: Type.String({ minLength: 1, maxLength: 200 }),
		step: IntegrationStepSchema,
		next: IntegrationNextSchema,
		pr_url: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		/** The pushed head this call reasoned about. */
		head_sha: Type.Optional(CommitShaSchema),
		/** The head sha a human actually authorized merging, if one has been (fallback path). */
		approved_head: Type.Optional(CommitShaSchema),
		/** Which rule permitted the merge that happened, if one has (cp-e0c). */
		merge_authority: Type.Optional(MergeAuthoritySchema),
		/** How many times the implementer has been promoted to resolve something. */
		resolve_attempts: Type.Integer({ minimum: 0, maximum: 20 }),
		/** Observed facts behind this step. Headlines only — never a diff or a log. */
		facts: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 20 }),
		/** One operator-facing line: what happened, and what is due next. */
		reason: Type.String({ minLength: 1, maxLength: 600 }),
		started_at: IsoTimestampSchema,
		updated_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type IntegrationRecord = Replace<
	Static<typeof IntegrationRecordSchema>,
	{ step: IntegrationStep; next: IntegrationNext; merge_authority?: MergeAuthority }
>;

/** One promote per stuck integration, then a human. The gate's shape (`GATE_MAX_REVISE`). */
export const INTEGRATE_MAX_RESOLVE = 1;

/**
 * Where `cp_integrate`'s sync step keeps a head it is about to discard
 * (cp-8vf6), and the only namespace its retention policy (cp-wcy5) may ever
 * delete from. The trailing slash is part of the constant on purpose: a prefix
 * test against `refs/cp-salvage` alone would also match `refs/cp-salvage-old/x`,
 * which nothing here wrote and nothing here may remove.
 */
export const SALVAGE_REF_PREFIX = "refs/cp-salvage/";

/**
 * How many rescue refs one integration will examine. A bound on the work per
 * call, not a retention limit: refs beyond it are *kept*, and the next
 * integration examines them. Count and age never license a deletion here
 * (cp-wcy5) — only reachability from the base does.
 */
export const SALVAGE_PRUNE_MAX = 100;

// ---------------------------------------------------------------------------
// CI/PR watch (cp-e2d) — state/ci-watch.json
// ---------------------------------------------------------------------------

/**
 * The four facts a `cp-ci` wake-up can carry. Nothing is emitted for CI that is
 * still running, or for a head no run has started on yet: those are the states
 * the watcher exists to sit through quietly.
 */
export const CI_WATCH_EVENTS = ["ci_green", "ci_failed", "pr_merged", "pr_closed"] as const;
export type CiWatchEvent = (typeof CI_WATCH_EVENTS)[number];
export const CiWatchEventSchema = StringEnum([...CI_WATCH_EVENTS]);

/**
 * One watched job's memory. `announced` is the idempotence record — one key per
 * `(job_id, head_sha, event)`, plus a run-identity suffix on a CI event — and it
 * is **persisted**, deliberately the
 * opposite choice from `WedgedWatch`'s in-memory memory: a still-wedged call is
 * news again to a fresh session, while "CI went green on d48a81d" is history
 * the moment somebody has read it, and replaying it on every restart is the
 * cp-answered failure mode in reverse.
 */
export const CiWatchJobSchema = Type.Object(
	{
		job_id: JobIdSchema,
		/** The branch's pushed head as of `head_observed_at`. Files-only source of truth for staleness. */
		head_sha: Type.Optional(Type.String({ minLength: 7, maxLength: 64 })),
		/** `${job_id}|${head_sha}|${event}` for every fact already delivered. */
		announced: Type.Array(Type.String({ minLength: 1, maxLength: 220 })),
		/**
		 * When the watcher last *attempted* a query — a scheduler fact, advanced by a
		 * failed one too. Never the age of `head_sha` (pi-command-post-8ok).
		 */
		last_checked_at: Type.Optional(IsoTimestampSchema),
		/**
		 * When `head_sha` was last actually read from the remote. Separate from
		 * `last_checked_at` on purpose: `headMoved` in `src/wakeups.ts` decides which
		 * of two readings of the branch is current by comparing their ages, so a
		 * timestamp advanced by a query that learned nothing would make a stale head
		 * look freshly observed and let it withhold a live verdict.
		 */
		head_observed_at: Type.Optional(IsoTimestampSchema),
		/** Per-job backoff: the watcher skips this job until then. */
		next_due_at: Type.Optional(IsoTimestampSchema),
		consecutive_failures: Type.Optional(Type.Integer({ minimum: 0 })),
		/** The last CI classification (`green`/`in_progress`/…), for /doctor and tests. */
		last_ci: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
		/** The last query error, bounded. A reason, never a stack. */
		last_error: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
	},
	{ additionalProperties: false },
);
export type CiWatchJob = Static<typeof CiWatchJobSchema>;

/** `state/ci-watch.json` — the watcher's whole durable state. */
export const CiWatchFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		jobs: Type.Array(CiWatchJobSchema),
	},
	{ additionalProperties: false },
);
export type CiWatchFile = Narrow<Static<typeof CiWatchFileSchema>, "jobs", CiWatchJob[]>;

export const EMPTY_CI_WATCH_FILE: CiWatchFile = {
	schema_version: SCHEMA_VERSION,
	updated_at: "1970-01-01T00:00:00Z",
	jobs: [],
};

export function validateCiWatchFile(value: unknown): ValidationResult<CiWatchFile> {
	return validate<CiWatchFile>(CiWatchFileSchema, value);
}
