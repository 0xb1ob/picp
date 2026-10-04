/**
 * The parent's mechanical cadence records (unload-parent PR2). Import via src/contracts.ts.
 *  - `state/ci-reruns.json`: the one infra-only CI rerun claimed per job + head (src/ci-infra-rerun.ts).
 *  - `state/armed-dispatches.json`: `cp_dispatch` requests refused only by open blockers, replayed
 *    through `CommandPost.dispatch` once the blockers close (src/dependency-dispatch.ts).
 */

import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, validate, type ValidationResult } from "./core.ts";
import { QueuedDispatchRequestSchema } from "./dispatch-queue.ts";

/** Claims kept; the oldest fall off (a claim only matters while its head is the PR's head). */
export const CI_RERUNS_MAX = 200;

export const CiRerunEntrySchema = Type.Object(
	{
		job_id: JobIdSchema,
		head_sha: Type.String({ pattern: "^[0-9a-f]{7,64}$" }),
		/** The workflow run's `databaseId`. */
		run_id: Type.Integer({ minimum: 1 }),
		/** The first failed step that made it infra-only, e.g. `Install treehouse`. */
		step: Type.String({ minLength: 1, maxLength: 200 }),
		at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type CiRerunEntry = Static<typeof CiRerunEntrySchema>;

export const CiRerunsFileSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		entries: Type.Array(CiRerunEntrySchema, { maxItems: CI_RERUNS_MAX }),
	},
	{ additionalProperties: false },
);
export type CiRerunsFile = { schema_version: 1; entries: CiRerunEntry[] };

export function validateCiRerunsFile(value: unknown): ValidationResult<CiRerunsFile> {
	return validate<CiRerunsFile>(CiRerunsFileSchema, value);
}

/** At most this many armed dispatches; a full file refuses the arm (the blocked refusal stands). */
export const ARMED_DISPATCH_MAX = 32;

export const ArmedDispatchEntrySchema = Type.Object(
	{
		job_id: JobIdSchema,
		request: QueuedDispatchRequestSchema,
		armed_at: IsoTimestampSchema,
		/** The open blockers when it was armed (informational; release re-reads the ledger). */
		blockers: Type.Array(JobIdSchema, { maxItems: 64 }),
	},
	{ additionalProperties: false },
);
export type ArmedDispatchEntry = Static<typeof ArmedDispatchEntrySchema>;

export const ArmedDispatchFileSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		entries: Type.Array(ArmedDispatchEntrySchema, { maxItems: ARMED_DISPATCH_MAX }),
	},
	{ additionalProperties: false },
);
export type ArmedDispatchFile = { schema_version: 1; entries: ArmedDispatchEntry[] };

/** Schema plus the one rule a schema cannot say: each `job_id` is armed once. */
export function validateArmedDispatchFile(value: unknown): ValidationResult<ArmedDispatchFile> {
	const result = validate<ArmedDispatchFile>(ArmedDispatchFileSchema, value);
	if (!result.ok) return result;
	const ids = result.value.entries.map((entry) => entry.job_id);
	const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
	return duplicate === undefined ? result : { ok: false, errors: [`/entries: job_id ${duplicate} is armed twice`] };
}
