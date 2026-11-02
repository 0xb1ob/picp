/** The operator's one-job model pick (R1 D2): reference, proof, claim, provenance. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, JobIdSchema } from "./core.ts";

export const OPERATOR_PICK_VERSION = 1;
export const OPERATOR_PICK_PROOF_ID = "^omp-[a-f0-9]{32}$";
export const OPERATOR_PICK_ERRORS = [
	"operator_pick_missing",
	"operator_pick_edited",
	"operator_pick_worker_authored",
	"operator_pick_parent_authored",
	"operator_pick_main_session_authored",
	"operator_pick_fabricated",
	"operator_pick_consumed",
	"operator_pick_bridge_unsupported",
] as const;
export type OperatorPickErrorCode = (typeof OPERATOR_PICK_ERRORS)[number];

/** What `cp_dispatch`/`cp_ask` carry as `operator_quote`; an unknown `version` refuses as bridge_unsupported. */
export const OperatorModelPickReferenceSchema = Type.Object(
	{
		version: Type.Integer({ minimum: 1 }),
		proof_id: Type.String({ pattern: OPERATOR_PICK_PROOF_ID }),
		quote: Type.String({ minLength: 1, maxLength: 16_000 }),
	},
	{ additionalProperties: false },
);
export type OperatorModelPickReference = Static<typeof OperatorModelPickReferenceSchema>;

const SourceFields = {
	kind: StringEnum(["terminal", "dashboard"]),
	session_file: Type.String({ minLength: 1 }),
	entry_id: Type.String({ minLength: 1 }),
	sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	control_id: Type.Optional(Type.String({ minLength: 1 })),
};

/** The human message a proof was issued from, frozen at issuance (text included). */
export const OperatorPickSourceSchema = Type.Object({ ...SourceFields, text: Type.String() }, { additionalProperties: false });
export type OperatorPickSource = Static<typeof OperatorPickSourceSchema>;

/** `state/operator/model-picks/<proof_id>.json`, written once by the operator bridge. */
export const OperatorModelPickProofSchema = Type.Object(
	{
		version: Type.Literal(OPERATOR_PICK_VERSION),
		proof_id: Type.String({ pattern: OPERATOR_PICK_PROOF_ID }),
		issuer: Type.Literal("operator-bridge"),
		issued_at: IsoTimestampSchema,
		model: Type.String({ minLength: 3 }),
		quote: Type.String({ minLength: 1, maxLength: 16_000 }),
		job_id: Type.Optional(JobIdSchema),
		source: OperatorPickSourceSchema,
	},
	{ additionalProperties: false },
);
export type OperatorModelPickProof = Static<typeof OperatorModelPickProofSchema>;

/** `claims/proof-<id>.json` and `claims/job-<id>.json`: the one use of a proof and the one pick of a job. */
export const OperatorModelPickClaimSchema = Type.Object(
	{
		version: Type.Literal(OPERATOR_PICK_VERSION),
		proof_id: Type.String({ pattern: OPERATOR_PICK_PROOF_ID }),
		job_id: JobIdSchema,
		attempt_id: Type.String({ minLength: 1 }),
		source_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		claimed_at: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export type OperatorModelPickClaim = Static<typeof OperatorModelPickClaimSchema>;

/** `routing.operator_pick`: present only on the picked attempt's record, never on a later one. */
export const OperatorPickRecordSchema = Type.Object(
	{
		proof_id: Type.String({ pattern: OPERATOR_PICK_PROOF_ID }),
		attempt_id: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 3 }),
		quote: Type.String({ minLength: 1, maxLength: 16_000 }),
		source: Type.Object(SourceFields, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
export type OperatorPickRecord = Static<typeof OperatorPickRecordSchema>;
