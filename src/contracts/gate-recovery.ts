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

const Identity = Type.String({ minLength: 1 });
const Dependents = Type.Array(JobIdSchema, { minItems: 2, maxItems: 2, uniqueItems: true });
export const GateRecoveryAnchorSchema = Type.Object({
	kind: Type.Literal("legacy_terminal"), anchor_id: Identity,
	root_job_id: JobIdSchema, source_job_id: JobIdSchema,
	legacy_attempt: Type.Integer({ minimum: 1 }), legacy_claim_sha256: Digest,
	legacy_verdict_sha256: Digest, history_sha256: Digest,
}, { additionalProperties: false });
export const GateRecoveryAuthoritySchema = Type.Object({
	schema_version: Type.Literal(2), authority_id: Identity,
	authority_mode: Type.Union([Type.Literal("single_use"), Type.Literal("standing")]),
	job_id: JobIdSchema, dependent_job_ids: Dependents,
	grant_id: Identity, scope_sha256: Digest, provenance_sha256: Digest,
	initial_predecessor: GateRecoveryAnchorSchema,
	release_scope: Type.Object({
		recovery_job_id: JobIdSchema, dependent_job_ids: Dependents,
		eligible_readiness_edges: Type.Array(Type.Object({
			dependent_job_id: JobIdSchema, blocker_id: JobIdSchema, reason: Identity,
		}, { additionalProperties: false })),
	}, { additionalProperties: false }),
}, { additionalProperties: false });
export type RecoveryAuthority = Static<typeof GateRecoveryAuthoritySchema>;
export const GateRecoveryAttemptSchema = Type.Object({
	schema_version: Type.Literal(2), attempt_id: Identity, authority_id: Identity,
	predecessor_id: Identity, job_id: JobIdSchema, root_job_id: JobIdSchema,
	dependent_job_ids: Dependents, history_sha256: Digest, graph_sha256: Digest,
	artifact_sha256: Digest, artifact_bytes: Type.Integer({ minimum: 0 }), task_sha256: Digest,
	artifact_base64: Type.String(), task_base64: Type.String(),
	state: Type.Literal("prepared"),
}, { additionalProperties: false });
export type RecoveryAttempt = Static<typeof GateRecoveryAttemptSchema>;
export const GateRecoveryAttemptClaimSchema = Type.Object({
	attempt_id: Identity, authority_id: Identity, attempt_sha256: Digest,
	gate_attempt: Type.Integer({ minimum: 1 }), owner_pid: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export const GateRecoveryAttemptTerminalSchema = Type.Object({
	attempt_id: Identity, claim_sha256: Type.Optional(Digest),
	outcome: Type.Union([Type.Literal("pass"), Type.Literal("nonpass"),
		Type.Literal("interrupted"), Type.Literal("spawn_failure"), Type.Literal("invalidated")]),
	decision_path: Type.Optional(Identity), decision_sha256: Type.Optional(Digest),
}, { additionalProperties: false });
