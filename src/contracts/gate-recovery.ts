import { Type, type Static } from "typebox";
import { JobIdSchema } from "./core.ts";

const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const GateRecoveryInputSchema = Type.Object({
	source: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }),
	bytes: Type.Integer({ minimum: 0 }), sha256: Digest, source_sha256: Digest,
}, { additionalProperties: false });
export const GateRecoveryReservationSchema = Type.Object({
	schema_version: Type.Literal(1), source_job: JobIdSchema, replacement_job: JobIdSchema,
	attempt: Type.Integer({ minimum: 1 }), decision_sha256: Digest,
	escalation_id: Type.String({ pattern: "^es-[a-z0-9]+$" }), authority_sha256: Digest,
	inputs: Type.Array(GateRecoveryInputSchema, { minItems: 1 }),
}, { additionalProperties: false });
export type RecoveryReservation = Static<typeof GateRecoveryReservationSchema>;
export const GateRecoveryClaimSchema = Type.Object({
	reservation_sha256: Digest, replacement_job: JobIdSchema, attempt: Type.Integer({ minimum: 1 }),
	artifact_sha256: Digest, artifact_bytes: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type RecoveryClaim = Static<typeof GateRecoveryClaimSchema>;
export interface GateRecoveryStatus {
	remaining: 0 | 1;
	source_job: string;
	replacement_job: string;
	state: "reserved" | "prepared" | "claimed" | "finished";
}
