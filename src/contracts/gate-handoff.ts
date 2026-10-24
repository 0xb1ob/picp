import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema } from "./core.ts";

const DigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const GateHandoffSchema = Type.Object({
	version: Type.Literal(1),
	handoff_id: DigestSchema,
	source_job_id: JobIdSchema,
	replacement_job_id: JobIdSchema,
	link_id: Type.String({ pattern: "^[a-z0-9_-]{1,100}$" }),
	input_digest: DigestSchema,
	edges: Type.Array(Type.Object({
		dependent_job_id: JobIdSchema,
		original_blocker_id: JobIdSchema,
		replacement_blocker_id: JobIdSchema,
		provenance_reference: Type.String({ minLength: 1, maxLength: 4000 }),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
	phase: StringEnum(["waiting_review", "prepared", "committed"]),
	created_at: IsoTimestampSchema,
	pass_digest: Type.Optional(DigestSchema),
}, { additionalProperties: false });
export type GateHandoff = Static<typeof GateHandoffSchema>;
