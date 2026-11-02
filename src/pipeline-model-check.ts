/** The advance/recover entry check: every stored model a step could spawn on must be one data/routing.json routes. */

import { LAYOUT, paths, type PipelineRecord, type QualityConfig } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { MandateStore } from "./mandate.ts";
import { ProjectRegistry } from "./projects.ts";
import { isEnabled, resolveQualityConfig } from "./quality.ts";
import { requireRouted } from "./routed-models.ts";
import { loadRoutingConfig } from "./routing.ts";
import { selectReviewerModel } from "./reviewer-model.ts";
import { nativeRunOf } from "./schedule-native.ts";
import { isNativePolicy } from "./viewer/schedule-policy.ts";

export interface StoredModelsInput {
	home: string;
	record: PipelineRecord;
	/** The advance argument: a string is checked instead of the stored pin; `null` skips both. */
	implementerModel?: string | null;
	qualityDefaults?: QualityConfig;
	fleet: FleetStore;
	mandates?: MandateStore;
	now: Date;
}

/** Throws `RoutingError` (`unrouted`) before anything is written; routing.json is read only when a model is stored. */
export function requireStoredModelsRouted(input: StoredModelsInput): void {
	const { home, record, implementerModel, qualityDefaults, fleet, mandates, now } = input;
	const file = paths.pipelineFile(record.research_id);
	const fields: Array<[model: string | undefined, where: string]> = [
		[implementerModel === undefined ? record.implementer_model : undefined, `${file} implementer_model — pass implementer_model ` +
			`with a routed model, or implementer_model: null to let routing decide (cp_pipeline advance ${record.research_id}) —`],
		[typeof implementerModel === "string" ? implementerModel : undefined, "cp_pipeline advance implementer_model"],
		[record.quality?.model, `${file} quality.model`],
		[record.quality?.model === undefined && isEnabled(resolveQualityConfig(qualityDefaults, record.quality))
			? qualityDefaults?.model : undefined, `${LAYOUT.data}/quality.json model`],
		[record.review?.model, `${file} review.model`],
	];
	const runs = [[record.research_id, ["reviewer"]], [record.ship_id, ["implementer", "reviewer"]]] as const;
	for (const [jobId, roles] of runs) {
		const run = nativeRunOf(mandates?.scheduleRuns, jobId);
		if (!run) continue;
		const effective = run.execution?.effective.model;
		if (effective) fields.push([effective, `state/schedule-runs.json run ${run.id} execution.effective.model`]);
		else if (isNativePolicy(run.policy) && run.policy.model_policy.mode === "pinned") {
			for (const role of roles) {
				fields.push([run.policy.model_policy.by_role[role], `state/schedule-runs.json run ${run.id} model_policy.by_role.${role}`]);
			}
		}
	}
	const reviewed = [fleet.get(record.research_id), record.review?.enabled ? fleet.get(record.ship_id) : undefined];
	const registry = new ProjectRegistry({ home });
	for (const fleetRecord of reviewed) {
		if (!fleetRecord) continue;
		const chosen = selectReviewerModel({ record: fleetRecord, registry, ...(mandates ? { mandates } : {}), now });
		if (chosen?.source === "mandate") fields.push([chosen.model, `${paths.mandateFile(chosen.mandate_id!)} reviewer_model`]);
		if (chosen?.source === "project") fields.push([chosen.model, `${LAYOUT.projectsFile} ${fleetRecord.project} reviewer_model`]);
	}
	const present = fields.filter((field): field is [string, string] => field[0] !== undefined);
	if (present.length === 0) return;
	const config = loadRoutingConfig(home);
	for (const [model, where] of present) requireRouted(config, model, where);
}

/** `cp_pipeline start`: every explicit model must be routed before either job exists. */
export function requireStartModelsRouted(home: string, models: Record<string, string | undefined>): void {
	const present = Object.entries(models).filter((field): field is [string, string] => field[1] !== undefined);
	if (present.length === 0) return;
	const config = loadRoutingConfig(home);
	for (const [where, model] of present) requireRouted(config, model, `cp_pipeline start ${where}`);
}
