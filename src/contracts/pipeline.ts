/** Pipeline records (research → gate → implement). Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Delivery, DeliverySchema, IsoTimestampSchema, JobIdSchema } from "./core.ts";
import { type JobRouting, JobRoutingSchema } from "./routing.ts";
import { DiffReviewConfigSchema, QualityConfigSchema } from "./reviews.ts";
import type { Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// Pipeline and checkpoint (T21)
// ---------------------------------------------------------------------------

/**
 * Pipeline state, derived from facts and re-projected on every advance:
 *  researching             — planner dispatched, no accepted envelope yet
 *  gating                  — an artifact exists; a gate attempt decides next
 *  awaiting_authorization  — gate passed; a human has not yet said "ship it"
 *  implementing            — implementer dispatched with the artifact as task
 *  escalated               — gate escalate: the operator owns it now
 *  done                    — implementer reported
 */
export const PIPELINE_STATES = [
	"researching",
	"gating",
	"awaiting_authorization",
	"implementing",
	"escalated",
	"done",
] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];
export const PipelineStateSchema = StringEnum([...PIPELINE_STATES]);

/**
 * Where a pipeline's frozen task impact was read from (routing T2).
 *
 *  - `start`         — `cp_pipeline start` assessed the original task text and
 *                      overlaid the axes the operator named. The normal case.
 *  - `fleet_routing`  — a record written before `task_impact` existed: the
 *                      research dispatch's own persisted `JobRouting`, which is
 *                      the effective input routing was actually given.
 *  - `original_task`  — neither of those, but the frozen original task
 *                      (`paths.originalTaskFile`) is still on disk, so the
 *                      task's own words are re-assessed from it.
 *
 * There is no fourth value for "nothing was found": that is `task_impact`
 * absent, and it is not the same thing as evidence that the work is low risk.
 */
export const TASK_IMPACT_SOURCES = ["start", "fleet_routing", "original_task"] as const;
export type TaskImpactSource = (typeof TASK_IMPACT_SOURCES)[number];
export const TaskImpactSourceSchema = StringEnum([...TASK_IMPACT_SOURCES]);

/**
 * The impact of the **task**, as opposed to the impact of the plan somebody
 * later wrote for it (routing T2).
 *
 * A planner reports on its own plan: `scope`, `confidence`, `destructive_scope`,
 * `blocking_unknowns`. None of those is a measurement of whether the work
 * touches production, credentials or money — so a confident, non-destructive,
 * unblocked plan for rotating production credentials used to hand the
 * implementer `risk: low`, erasing the one fact nobody had disputed. This is
 * that fact, frozen at `cp_pipeline start` and never rewritten by an advance:
 * the `JobRouting` shape is reused deliberately, so the per-axis provenance the
 * routing record already defines is what travels.
 */
export const TaskImpactSchema = Type.Object(
	{
		routing: JobRoutingSchema,
		source: TaskImpactSourceSchema,
	},
	{ additionalProperties: false },
);
export type TaskImpact = Replace<Static<typeof TaskImpactSchema>, { routing: JobRouting; source: TaskImpactSource }>;

/** state/pipelines/<research-id>.json — the machine link between the two jobs. */
export const PipelineRecordSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		research_id: JobIdSchema,
		ship_id: JobIdSchema,
		project: Type.String({ minLength: 1 }),
		/** Delivery of the *ship* job; the research job is always `pipeline`. */
		delivery: DeliverySchema,
		state: PipelineStateSchema,
		created_at: IsoTimestampSchema,
		updated_at: IsoTimestampSchema,
		/** Requested per-stage override; absent keeps dispatch's home/env defaults. */
		wall_clock_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
		/** Per-job opt-in for the T22 quality pass. Absent means off. */
		quality: Type.Optional(QualityConfigSchema),
		/** Per-job opt-in for the post-implementation diff-review gate. Absent means off. */
		review: Type.Optional(DiffReviewConfigSchema),
		/** Why intake split this job; kept so the decision can be reviewed. */
		reasons: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 })),
		/**
		 * The task's own known impact, frozen at `start` and carried across a
		 * reanchor (routing T2). Optional because records written before it existed
		 * must keep validating: `PipelineRunner` recovers those from the research
		 * job's fleet routing or its frozen original task instead, and an absent
		 * assessment leaves the axis for dispatch to infer — never a confident `low`.
		 */
		task_impact: Type.Optional(TaskImpactSchema),
		/**
		 * Set only on the record this one replaces (cp-n10 reanchor): the research
		 * job named here is superseded and its artifact must never be handed to an
		 * implementer again. `advance` refuses a superseded record outright.
		 */
		superseded_by: Type.Optional(JobIdSchema),
		/**
		 * When the pipeline acted on the quality report (promoted fixes, or went on
		 * to the gate) — spec 2026-09-05. The report is written in the background,
		 * so "fresh" is "no advance has acted on it yet", not "this call wrote it".
		 */
		quality_acted_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);
export type PipelineRecord = Replace<
	Static<typeof PipelineRecordSchema>,
	{ delivery: Delivery; state: PipelineState }
>;
