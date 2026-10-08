/** The jobs ledger — <home>/.pi-command-post/jobs.json. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { ContractError, DELIVERIES, IsoTimestampSchema, isSafeProjectName, JOB_KINDS, JobIdSchema, LEDGER_PREFIX_PATTERN, SCHEMA_VERSION, validate, type ValidationResult } from "./core.ts";
import { RISKS } from "./routing.ts";

import { REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./reviews.ts";
import { DelegationProvenanceFields } from "./escalations.ts";
import { TrackerLinkSchema } from "./trackers.ts";

/** Append-only authorized scope, with the body frozen even when its source was a file. */
export const TaskAddendumSchema = Type.Object(
	{
		schema_version: Type.Literal(SCHEMA_VERSION),
		n: Type.Integer({ minimum: 1 }),
		added_at: IsoTimestampSchema,
		source_path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
		text: Type.String({ minLength: 1, maxLength: REVIEW_ORIGINAL_TASK_MAX_BYTES }),
		by: StringEnum(["operator-quote", "operator-delegated"]),
		...DelegationProvenanceFields,
		quote: Type.String({ minLength: 1, maxLength: 4000 }),
		reason: Type.String({ minLength: 1, maxLength: 2000 }),
	},
	{ additionalProperties: false },
);
export type TaskAddendum = Static<typeof TaskAddendumSchema>;

// ---------------------------------------------------------------------------
// Jobs ledger — <home>/.pi-command-post/jobs.json (spec 2026-09-04)
// ---------------------------------------------------------------------------

export const JOB_STATUSES = ["open", "in_progress", "deferred", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JobStatusSchema = StringEnum([...JOB_STATUSES]);
/** Statuses `update()` may set. Closing is a transition (`close()`), never an edit. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = Object.freeze(["open", "in_progress", "deferred"]);

/** `<prefix>-<slug>-<suffix>`: lowercase, hyphenated, short enough to stay a readable branch name. */
export const JOB_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,40}$";
export const JOB_ID_SUFFIX_LENGTH = 4;
/** Collisions tolerated at 4 characters before the suffix grows to 5. */
export const JOB_ID_MINT_RETRIES = 8;
/** Doctor warns past this many jobs in one document. */
export const JOBS_SIZE_WARNING = 5000;

export const ScriptDeclarationSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export type ScriptDeclaration = Static<typeof ScriptDeclarationSchema>;

/** Syntax only at intake; the runner checks realpath, symlinks and git tracking after lease. */
export function isSafeScriptPath(path: string): boolean {
	return path.length > 0 && path.length <= 1000 && !/[\\\x00-\x1f\x7f]/.test(path) &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const JobCommentSchema = Type.Object(
	{
		at: IsoTimestampSchema,
		author: Type.String({ minLength: 1, maxLength: 120 }),
		text: Type.String({ minLength: 1, maxLength: 4000 }),
	},
	{ additionalProperties: false },
);
export type JobComment = Static<typeof JobCommentSchema>;

/**
 * One job. `blocked_by` is the only place a dependency lives; `ready` and
 * `blocked` are computed from it, never stored. `closed_at` and
 * `close_reason` are present iff `status` is `closed` (an invariant, below).
 */
export const JobSchema = Type.Object(
	{
		id: JobIdSchema,
		title: Type.String({ minLength: 1, maxLength: 500 }),
		description: Type.Optional(Type.String({ maxLength: 20_000 })),
		notes: Type.Optional(Type.String({ maxLength: 20_000 })),
		status: JobStatusSchema,
		labels: Type.Array(Type.String({ minLength: 1, maxLength: 120 })),
		assignee: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		/** Where the issue lives: a tracker url, a file path, or the command that shows it. One line; a pointer, never a body. */
		external_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: "^[^\\r\\n]+$" })),
		script: Type.Optional(ScriptDeclarationSchema),
		/** Stable tracker identity (B2); unique across open and closed jobs. */
		tracker: Type.Optional(TrackerLinkSchema),
		blocked_by: Type.Array(JobIdSchema),
		comments: Type.Array(JobCommentSchema),
		created_at: IsoTimestampSchema,
		updated_at: IsoTimestampSchema,
		closed_at: Type.Optional(IsoTimestampSchema),
		close_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	},
	{ additionalProperties: false },
);
export type Job = Omit<Static<typeof JobSchema>, "status"> & { status: JobStatus };

export const JobsDocumentSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		prefix: Type.String({ pattern: LEDGER_PREFIX_PATTERN }),
		jobs: Type.Array(JobSchema),
	},
	{ additionalProperties: false },
);
export type JobsDocument = Omit<Static<typeof JobsDocumentSchema>, "jobs"> & { jobs: Job[] };

export function emptyJobsDocument(prefix: string): JobsDocument {
	return { schema_version: SCHEMA_VERSION, prefix, jobs: [] };
}

/** The first cycle found over `blocked_by`, as a path that ends where it starts, or `undefined`. */
export function findDependencyCycle(jobs: readonly Job[]): string[] | undefined {
	const byId = new Map<string, Job>();
	for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		const mark = state.get(id);
		if (mark === "done") return undefined;
		if (mark === "visiting") return [...path.slice(path.indexOf(id)), id];
		state.set(id, "visiting");
		path.push(id);
		for (const blocker of byId.get(id)?.blocked_by ?? []) {
			if (!byId.has(blocker)) continue;
			const found = visit(blocker);
			if (found) return found;
		}
		path.pop();
		state.set(id, "done");
		return undefined;
	};
	for (const job of jobs) {
		const found = visit(job.id);
		if (found) return found;
	}
	return undefined;
}

/** Reserved labels are singular; identical duplicates are invalid too. Shared by intake and persisted validation. */
export function jobLabelErrors(labels: readonly string[]): string[] {
	const errors: string[] = [];
	for (const [prefix, required, values] of [
		["project:", true, undefined],
		["delivery:", true, DELIVERIES],
		["kind:", false, JOB_KINDS],
		["risk:", false, RISKS],
	] as const) {
		const found = labels.filter((label) => label.startsWith(prefix)).map((label) => label.slice(prefix.length));
		if (found.length > 1 || (required && found.length !== 1)) {
			errors.push(`labels ${prefix}: ${required ? "exactly" : "at most"} one ${prefix} label is allowed (found ${found.length})`);
		}
		for (const value of found) {
			if (values ? !(values as readonly string[]).includes(value) : !isSafeProjectName(value)) {
				errors.push(`label ${prefix}${value} is not ${values ? `one of ${values.join("|")}` : "a valid project name"}`);
			}
		}
	}
	return errors;
}

/**
 * Cross-record invariants shape validation cannot express. `ids` are faults in
 * a single record; `deps` are faults in the graph. Both empty means sound.
 */
export function jobsInvariantErrors(doc: JobsDocument, options: { tolerateLegacyLabels?: boolean } = {}): { ids: string[]; deps: string[] } {
	const ids: string[] = [];
	const deps: string[] = [];
	const seen = new Set<string>();
	const trackerKeys = new Map<string, string>();
	for (const job of doc.jobs) {
		if (!options.tolerateLegacyLabels) ids.push(...jobLabelErrors(job.labels).map((error) => `${job.id}: ${error}`));
		if (seen.has(job.id)) ids.push(`duplicate id ${job.id}`);
		seen.add(job.id);
		if (!job.id.startsWith(`${doc.prefix}-`)) ids.push(`${job.id} does not carry this document's prefix ${doc.prefix}-`);
		if (job.script && !isSafeScriptPath(job.script.path)) ids.push(`${job.id} has an unsafe script path`);
		if (job.script && (!job.labels.includes("kind:ship") || !job.labels.includes("delivery:local"))) {
			ids.push(`${job.id} script requires kind:ship and delivery:local`);
		}
		const hasClosedFields = job.closed_at !== undefined && job.close_reason !== undefined;
		if (job.status === "closed" && !hasClosedFields) ids.push(`${job.id} is closed without closed_at/close_reason`);
		if (job.status !== "closed" && (job.closed_at !== undefined || job.close_reason !== undefined)) {
			ids.push(`${job.id} carries closed_at/close_reason but is ${job.status}`);
		}
		if (job.tracker) {
			const key = `${job.tracker.connection_id}\u0000${job.tracker.item_id}`;
			const other = trackerKeys.get(key);
			if (other) ids.push(`${job.id} and ${other} link the same tracker item ${job.tracker.connection_id}/${job.tracker.item_id}`);
			trackerKeys.set(key, job.id);
		}
	}
	for (const job of doc.jobs) {
		for (const blocker of job.blocked_by) {
			if (blocker === job.id) deps.push(`${job.id} depends on itself`);
			else if (!seen.has(blocker)) deps.push(`${job.id} is blocked by unknown ${blocker}`);
		}
	}
	const cycle = findDependencyCycle(doc.jobs);
	if (cycle) deps.push(`dependency cycle: ${cycle.join(" -> ")}`);
	return { ids, deps };
}

/** Fields the jobs document once carried and no longer does. Dropped on read; the next write persists the cleaned shape. */
export const LEGACY_JOB_FIELDS = ["type", "priority"] as const;

/** One job's retired field values, as they were on disk. */
export interface LegacyJobFields {
	id: string;
	fields: Record<string, unknown>;
}

/**
 * The retired values a parsed document still carries, in document order. Empty
 * when there is nothing to archive — which is every document written after
 * 2026-09-05. Pure; never mutates its argument.
 */
export function collectLegacyJobFields(value: unknown): LegacyJobFields[] {
	if (typeof value !== "object" || value === null || !Array.isArray((value as { jobs?: unknown }).jobs)) return [];
	const found: LegacyJobFields[] = [];
	for (const [index, job] of (value as { jobs: unknown[] }).jobs.entries()) {
		if (typeof job !== "object" || job === null) continue;
		const row = job as Record<string, unknown>;
		const fields: Record<string, unknown> = {};
		for (const field of LEGACY_JOB_FIELDS) {
			if (Object.hasOwn(row, field)) fields[field] = row[field];
		}
		if (Object.keys(fields).length === 0) continue;
		found.push({ id: typeof row.id === "string" ? row.id : `#${index}`, fields });
	}
	return found;
}

/**
 * Tolerate a document written before `type` and `priority` were removed
 * (2026-09-05). Returns a copy with those keys deleted from every job; any
 * value that is not `{ jobs: [...] }` is returned as is, so the schema still
 * names the real fault.
 */
type LegacyJobsInput = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function stripLegacyJobFields(value: unknown): LegacyJobsInput {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") throw new ContractError("jobs document must contain a JSON value");
	if (Array.isArray(value)) return value;
	if (!Array.isArray((value as { jobs?: unknown }).jobs)) return value as Record<string, unknown>;
	const doc = value as { jobs: unknown[] };
	return {
		...doc,
		jobs: doc.jobs.map((job) => {
			if (typeof job !== "object" || job === null) return job;
			const copy: Record<string, unknown> = { ...(job as Record<string, unknown>) };
			for (const field of LEGACY_JOB_FIELDS) delete copy[field];
			return copy;
		}),
	};
}

/** Strict by default; legacy-aware mutations separately enforce labels on every added or changed record. */
export function validateJobsDocument(value: unknown, options: { tolerateLegacyLabels?: boolean } = {}): ValidationResult<JobsDocument> {
	const shape = validate<JobsDocument>(JobsDocumentSchema, value);
	if (!shape.ok) return shape;
	const invariants = jobsInvariantErrors(shape.value, options);
	const errors = [...invariants.ids, ...invariants.deps];
	if (errors.length > 0) return { ok: false, errors };
	return shape;
}
