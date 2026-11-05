/**
 * R1 D2: where an operator pick enters routing and where it never re-enters. A pick honours one attempt; every
 * later execution of that job (retry, revive, continue_failed, recovery, pipeline recover) routes freshly.
 */

import type { FleetRecord, JobRouting, OperatorModelPickReference, OperatorPickRecord, RoutingConfig, RoutingDecision, ThinkingLevel, WorkerHandle } from "./contracts.ts";
import { claimOperatorPick, pickedJobClaim, snapshotPickedAttempt, type VerifiedPick, verifyOperatorPick } from "./operator-model-pick.ts";
import { loadProfile } from "./profiles.ts";
import { requireRouted } from "./routed-models.ts";
import { ALWAYS_AVAILABLE, loadRoutingConfig, type ModelProbe, resolveModel } from "./routing.ts";
import { driverFields } from "./dispatch-driver.ts";
import { nativeModelId } from "./drivers/claude.ts";

/** The pick fields a dispatch request carries; `pick`/`pickSpent` are set only by `withOperatorPick`. */
export interface PickRequest { jobId: string; model?: string; operatorQuote?: OperatorModelPickReference; pick?: VerifiedPick; pickSpent?: string }

/**
 * Verify a quote (read-only, so preview may call it), or, for an already-picked job, validate then drop the model.
 * `raw` is the caller's own model, before a schedule run overlaid its pin: the quote exempts only that model.
 */
export function withOperatorPick<T extends PickRequest>(home: string, raw: string | undefined, request: T, config: RoutingConfig): T {
	const { pick: _pick, pickSpent: _spent, ...clean } = request;
	const pinned = request.model !== undefined && request.model !== raw;
	if (request.operatorQuote) {
		if (pinned) requireRouted(config, request.model!, "the schedule run's model pin");
		const pick = verifyOperatorPick(home, request.operatorQuote, { model: raw, jobId: request.jobId, config });
		return { ...clean, model: raw, pick } as T;
	}
	const spent = pickedJobClaim(home, request.jobId);
	if (!spent) return clean as T;
	if (request.model) requireRouted(config, request.model, pinned ? "the schedule run's model pin" : "model");
	const { model: _model, ...rest } = clean;
	return { ...rest, pickSpent: spent.attempt_id } as T;
}

/** Before a queued/armed request is stored: the quote must verify now, and is verified again at admission. */
export function checkStoredPick(home: string, jobId: string, model: string | undefined, quote: OperatorModelPickReference | undefined): void {
	if (quote) verifyOperatorPick(home, quote, { model, jobId, config: loadRoutingConfig(home) });
}

/** At admission, before any side effect: freeze a picked previous attempt, then spend this request's pick. */
export function admitOperatorPick(home: string, request: PickRequest, previous: FleetRecord | undefined, now: Date): OperatorPickRecord | undefined {
	if (previous) snapshotPickedAttempt(home, previous);
	return request.pick ? claimOperatorPick(home, request.pick, request.jobId, now) : undefined;
}

/** The decision half of `cp:routing_resolved`. */
export function decisionFields(d: RoutingDecision): Record<string, unknown> {
	return { model: d.model, source: d.source, rule: d.rule, ...(d.thinking ? { thinking: d.thinking } : {}), ...(d.attempted ? { attempted: d.attempted } : {}),
		...(d.capacity ? { capacity: d.capacity } : {}), ...(d.quota ? { quota: d.quota } : {}), ...driverFields(d) };
}

export interface RespawnRoute { model: string; thinking?: ThinkingLevel; routing?: JobRouting; priorPick?: string }

/**
 * The model a respawn runs. Never picked: the recorded model, which must still be routed (PR2 P6). Picked: a fresh
 * rubric route without override, recorded without `operator_pick`; the old model and quote are never route inputs.
 */
export function respawnRoute(options: {
	home: string; profilesDir: string; record: FleetRecord & { worker: WorkerHandle }; probe?: ModelProbe; where: string;
}): RespawnRoute {
	const { home, record } = options;
	const config = loadRoutingConfig(home);
	const spent = pickedJobClaim(home, record.job_id);
	if (!spent) {
		requireRouted(config, record.worker.model, options.where);
		return { model: record.worker.model, ...(record.routing?.thinking ? { thinking: record.routing.thinking } : {}) };
	}
	const { operator_pick: _pick, thinking: _thinking, ...kept } = record.routing ?? { inferred: false };
	// shortcut: availability probe only, no capacity scores; upgrade when respawns need capacity-ordered fallbacks.
	const decision = resolveModel({
		profile: loadProfile(options.profilesDir, record.worker.profile), jobId: record.job_id, project: record.project, kind: record.kind,
		...(kept.scope ? { scope: kept.scope } : {}), ...(kept.risk ? { risk: kept.risk } : {}),
	}, config, options.probe ?? ALWAYS_AVAILABLE);
	// D1: a fresh pick never moves a native job to pi; a model the recorded driver cannot run refuses the respawn.
	if (record.worker.driver) nativeModelId(decision.model);
	const thinking = decision.thinking ? { thinking: decision.thinking } : {};
	return { model: decision.model, ...thinking, routing: { ...kept, ...thinking }, priorPick: spent.attempt_id };
}
