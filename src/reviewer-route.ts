/**
 * N4h/C6: a reviewer's route through the driver resolver; native only for a row naming `claude` or `codex` whose review
 * switch (`claude_review`, `codex_review`) is on.
 */
import { type Delivery, type FleetRecord, isScriptFleetRecord, type RoutingConfig, type RoutingDecision } from "./contracts.ts";
import { holdNativeSlot, liveNativeWorkers, reserveNativeSlot, resolveDriverRoute } from "./dispatch-driver.ts";
import { waitingLabel } from "./dispatch-queue.ts";
import { NativeDriverError } from "./drivers/claude.ts";
import { lendable } from "./drivers/registry.ts";
import type { ModelProbe, RouteRequest, resolveWithCapacity } from "./routing.ts";
import type { NativeDriver } from "./worker-driver.ts";
import type { WorkerManager } from "./worker-manager.ts";

export interface ReviewerDriverContext {
	home: string;
	jobId: string;
	record?: FleetRecord | undefined;
	jobs: readonly FleetRecord[];
	manager: Pick<WorkerManager, "active" | "get" | "stopping">;
	/** Take the native slot until the caller's `holdReviewerSlot` settles; a caller that spawns later must not set it. */
	reserve?: boolean;
}

/** Runs one review start, releasing the native slot its route reserved once the reviewer is spawned (or failed). */
export const holdReviewerSlot = <T>(home: string, jobId: string, run: () => Promise<T>): Promise<T> =>
	holdNativeSlot(home, reviewerSlot(jobId), run);

/** Re-take the reviewer's slot between two serial voters, so a panel keeps the one slot its route got. */
export const reserveReviewerSlot = (home: string, jobId: string, driver: NativeDriver): void => reserveNativeSlot(home, reviewerSlot(jobId), driver);

const reviewerSlot = (jobId: string): string => `${jobId}/review`;

/** cp-912x ruling: a held, idle author's slot, lent to its own reviewer only (same CLI: the resolver counts per CLI). */
function lender(ctx: ReviewerDriverContext): string | undefined {
	const record = ctx.record;
	if (!record || record.phase !== "held" || isScriptFleetRecord(record) || record.worker.driver === undefined) return undefined;
	return lendable(ctx.manager, record.job_id) ? record.job_id : undefined;
}

/** The subject a decision borrowed its slot from (its `driver_reason` starts `borrowed:`), for the spawn. */
export function borrowedFrom(decision: RoutingDecision, subject: string): { borrowsSlotOf: string } | Record<string, never> {
	return decision.driver_reason?.startsWith("borrowed:") ? { borrowsSlotOf: subject } : {};
}

/**
 * The reviewer is its own worker under its own slot id, so the subject's D1 driver lock never binds it, while every
 * native worker this parent runs holds a slot: a full CLI refuses `occupied` (never pi), except the held author's own.
 */
export function resolveReviewerRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Parameters<typeof resolveWithCapacity>[3], ctx: ReviewerDriverContext,
): Promise<RoutingDecision> {
	const borrowFrom = lender(ctx);
	return resolveDriverRoute(route, config, probe, capacity, {
		home: ctx.home,
		jobId: reviewerSlot(ctx.jobId),
		kind: "research",
		delivery: (ctx.record?.delivery ?? "pipeline") as Delivery,
		role: "gate-reviewer",
		jobs: ctx.jobs,
		...(ctx.reserve ? { reserve: true } : {}),
		...(borrowFrom ? { borrowFrom } : {}),
		nativeLive: liveNativeWorkers(ctx.manager, ""),
	}).catch((error: unknown) => {
		const waiting = waitingLabel(error);
		if (waiting === undefined) throw error;
		const native = error as NativeDriverError;
		throw new NativeDriverError(`${native.message} — the review of ${ctx.jobId} is ${waiting}; it never runs on another CLI`, native.category, native.driver);
	});
}
