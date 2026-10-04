/** `state/dispatch-queue.json` — `cp_dispatch` requests refused only by the spawn cap (cp-itl4 4b-2). Import via src/contracts.ts. */

import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, validate, type ValidationResult } from "./core.ts";

/** At most this many queued dispatches; a full queue refuses the enqueue (today's spawn_cap refusal stands). */
export const DISPATCH_QUEUE_MAX = 32;

/** The `cp_dispatch` parameters a queued entry replays, verbatim (tool names, snake_case). */
export const QueuedDispatchRequestSchema = Type.Object(
	{
		task: Type.Optional(Type.String()),
		task_file: Type.Optional(Type.String({ minLength: 1 })),
		scope: Type.Optional(Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")])),
		risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high")])),
		model: Type.Optional(Type.String({ minLength: 1 })),
		thinking: Type.Optional(Type.String({ minLength: 1 })),
		profile: Type.Optional(Type.String({ minLength: 1 })),
		base: Type.Optional(Type.String({ minLength: 1 })),
		wall_clock_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
		tool_call_cap: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type QueuedDispatchRequest = Static<typeof QueuedDispatchRequestSchema>;

export const DispatchQueueEntrySchema = Type.Object(
	{
		job_id: JobIdSchema,
		request: QueuedDispatchRequestSchema,
		queued_at: IsoTimestampSchema,
		/** Drop/start bookkeeping only; a head kept by spawn_cap/parallelism_full is never rewritten. */
		attempts: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type DispatchQueueEntry = Static<typeof DispatchQueueEntrySchema>;

export const DispatchQueueFileSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		entries: Type.Array(DispatchQueueEntrySchema, { maxItems: DISPATCH_QUEUE_MAX }),
	},
	{ additionalProperties: false },
);
export type DispatchQueueFile = { schema_version: 1; entries: DispatchQueueEntry[] };

/** Schema plus the one rule a schema cannot say: each `job_id` appears once. */
export function validateDispatchQueueFile(value: unknown): ValidationResult<DispatchQueueFile> {
	const result = validate<DispatchQueueFile>(DispatchQueueFileSchema, value);
	if (!result.ok) return result;
	const ids = result.value.entries.map((entry) => entry.job_id);
	const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
	return duplicate === undefined ? result : { ok: false, errors: [`/entries: job_id ${duplicate} is queued twice`] };
}
