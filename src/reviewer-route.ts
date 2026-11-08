/** N4h: a reviewer's route through the driver resolver; native only for a `driver: "claude"` row with claude_review on. */
import type { Delivery, FleetRecord, RoutingConfig, RoutingDecision } from "./contracts.ts";
import { holdNativeSlot, liveNativeWorkers, resolveDriverRoute } from "./dispatch-driver.ts";
import type { ModelProbe, RouteRequest, resolveWithCapacity } from "./routing.ts";
import type { WorkerManager } from "./worker-manager.ts";

export interface ReviewerDriverContext {
	home: string;
	jobId: string;
	record?: FleetRecord | undefined;
	jobs: readonly FleetRecord[];
	manager: Pick<WorkerManager, "active">;
	/** Take the native slot until the caller's `holdReviewerSlot` settles; a caller that spawns later must not set it. */
	reserve?: boolean;
	/** `pi` re-routes a reviewer that lost the native slot after its route was resolved. */
	explicit?: "pi";
}

/** Runs one review start, releasing the native slot its route reserved once the reviewer is spawned (or failed). */
export const holdReviewerSlot = <T>(home: string, jobId: string, run: () => Promise<T>): Promise<T> =>
	holdNativeSlot(home, reviewerSlot(jobId), run);

const reviewerSlot = (jobId: string): string => `${jobId}/review`;

/**
 * The reviewer is its own worker under its own slot id, so the subject's D1 driver lock never binds it, while every
 * native worker this parent runs (the subject's own included) holds a slot: a full home routes the reviewer to pi.
 */
export function resolveReviewerRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Parameters<typeof resolveWithCapacity>[3], ctx: ReviewerDriverContext,
): Promise<RoutingDecision> {
	return resolveDriverRoute(route, config, probe, capacity, {
		home: ctx.home,
		jobId: reviewerSlot(ctx.jobId),
		kind: "research",
		delivery: (ctx.record?.delivery ?? "pipeline") as Delivery,
		role: "gate-reviewer",
		jobs: ctx.jobs,
		...(ctx.reserve ? { reserve: true } : {}),
		...(ctx.explicit ? { explicit: ctx.explicit } : {}),
		nativeLive: liveNativeWorkers(ctx.manager, ""),
	});
}
