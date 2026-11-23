/**
 * `state/native-wait.json` — work on an existing job (a review, revive, send or pipeline advance) that a full CLI keeps
 * waiting, replayed FIFO per CLI on that same CLI when a slot frees (cp-912x R6). Import via src/contracts.ts.
 */

import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema, validate, type ValidationResult } from "./core.ts";

/** At most this many waiting entries; a full file refuses the enqueue by name (the occupied refusal stands). */
export const NATIVE_WAIT_MAX = 32;

export const NATIVE_WAIT_KINDS = ["review", "gate", "revive", "send", "pipeline-advance"] as const;
export type NativeWaitKind = (typeof NATIVE_WAIT_KINDS)[number];

/** What a replay re-runs with (snake_case, like the tool parameters); the send body lives in the run dir, never here. */
export const NativeWaitRequestSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ minLength: 1 })),
		deliver_revise: Type.Optional(Type.Boolean()),
		directive: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		native_recovery: Type.Optional(Type.Boolean()),
		message_file: Type.Optional(Type.String({ minLength: 1 })),
		mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("prompt"), Type.Literal("follow_up")])),
		purpose: Type.Optional(Type.Literal("repair")),
		keep_round: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type NativeWaitRequest = Static<typeof NativeWaitRequestSchema>;

export const NativeWaitEntrySchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("review"), Type.Literal("gate"), Type.Literal("revive"), Type.Literal("send"), Type.Literal("pipeline-advance")]),
		job_id: JobIdSchema,
		driver: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
		/** The visible status, e.g. `waiting for Codex CLI capacity`. */
		text: Type.String({ minLength: 1, maxLength: 500 }),
		request: NativeWaitRequestSchema,
		queued_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type NativeWaitEntry = Static<typeof NativeWaitEntrySchema>;

export const NativeWaitFileSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		entries: Type.Array(NativeWaitEntrySchema, { maxItems: NATIVE_WAIT_MAX }),
	},
	{ additionalProperties: false },
);
export type NativeWaitFile = { schema_version: 1; entries: NativeWaitEntry[] };

/** Schema plus the one rule a schema cannot say: each kind waits once per job. */
export function validateNativeWaitFile(value: unknown): ValidationResult<NativeWaitFile> {
	const result = validate<NativeWaitFile>(NativeWaitFileSchema, value);
	if (!result.ok) return result;
	const keys = result.value.entries.map((entry) => `${entry.kind}:${entry.job_id}`);
	const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
	return duplicate === undefined ? result : { ok: false, errors: [`/entries: ${duplicate} waits twice`] };
}
