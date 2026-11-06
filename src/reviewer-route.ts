/** N4h: a reviewer's route through the driver resolver; native only for a `driver: "claude"` row with claude_review on. */
import type { Delivery, FleetRecord, RoutingConfig, RoutingDecision } from "./contracts.ts";
import { liveNativeWorkers, resolveDriverRoute } from "./dispatch-driver.ts";
import type { ModelProbe, RouteRequest, resolveWithCapacity } from "./routing.ts";
import type { WorkerManager } from "./worker-manager.ts";

export interface ReviewerDriverContext {
	home: string;
	jobId: string;
	record?: FleetRecord | undefined;
	jobs: readonly FleetRecord[];
	manager: Pick<WorkerManager, "active">;
}

/**
 * The reviewer is its own worker, so the subject job's D1 driver lock never binds it: the subject leaves `jobs`, and
 * every native worker this parent runs (the subject's own included) holds the slot, so a busy slot routes to pi.
 */
export function resolveReviewerRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Parameters<typeof resolveWithCapacity>[3], ctx: ReviewerDriverContext,
): Promise<RoutingDecision> {
	return resolveDriverRoute(route, config, probe, capacity, {
		home: ctx.home,
		jobId: ctx.jobId,
		kind: "research",
		delivery: (ctx.record?.delivery ?? "pipeline") as Delivery,
		role: "gate-reviewer",
		jobs: ctx.jobs.filter((job) => job.job_id !== ctx.jobId),
		// shortcut: no reservation between route and spawn, so two reviews racing in one parent could both go native.
		nativeLive: liveNativeWorkers(ctx.manager, ""),
	});
}
