/**
 * Native routing S1: which driver a dispatch runs on. A rubric row's `driver` is a preference, an explicit request is
 * strict, and a started job keeps its driver (D1). Only local/answer research may run native (D2).
 */
import { type Delivery, type FleetRecord, isScriptFleetRecord, type JobKind, type Role, type RoutingConfig, type RoutingDecision, type RoutingDriver } from "./contracts.ts";
import {
	assertNativeEffort, isNativeModel, liveNativeJobs, nativeBaseEnv, nativeMaxConcurrent, nativeModelId, NativeDriverError, nativeSelectionRefusal, type NativeRefusal,
	nativeSlotRefusal, nativeThinkingEnv,
} from "./drivers/claude.ts";
import { deniedFor, isAllowed, type ModelProbe, pickModel, resolveWithCapacity, type RouteRequest, RoutingError } from "./routing.ts";
import { nativeAvailability } from "./native-availability.ts";
export { observeNative } from "./native-availability-observer.ts";
import type { NativeDriver } from "./worker-driver.ts";
import type { WorkerManager } from "./worker-manager.ts";

export interface DriverContext {
	home: string;
	jobId: string;
	kind: JobKind;
	delivery: Delivery;
	role: Role;
	jobs: readonly FleetRecord[];
	/** `cp_dispatch driver`: strict, refused rather than falling back; `pi` pins the job off native routing. */
	explicit?: RoutingDriver;
	/** Admission (not preview): take the home's one native slot before the async spawn. */
	reserve?: boolean;
	/** Native workers live in this parent that the fleet does not list (reviewers, N4h); each holds the native slot. */
	nativeLive?: readonly string[];
	/** The selected profile's name and the per-job skill count: both can make a job ineligible for native. */
	profile?: string;
	skills?: number;
}

type Capacity = Parameters<typeof resolveWithCapacity>[3];

/** Per home, the jobs holding a native slot between route resolution and their fleet record (or their failure). */
const slots = new Map<string, Set<string>>();

/** Runs one admission and releases the native slot it reserved when it settles (the fleet record holds it by then). */
export async function holdNativeSlot<T>(home: string, jobId: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} finally {
		const held = slots.get(home);
		held?.delete(jobId);
		if (held?.size === 0) slots.delete(home);
	}
}

/** The routing decision plus the driver it runs on; the pi lane is `resolveWithCapacity` unchanged. */
export async function resolveDriverRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Capacity, ctx: DriverContext,
): Promise<RoutingDecision> {
	const prior = ctx.jobs.find((job) => job.job_id === ctx.jobId);
	const locked = prior && !isScriptFleetRecord(prior) ? (prior.worker.driver ?? "pi") : undefined;
	if (ctx.explicit === "pi") {
		if (locked === "claude") throw new NativeDriverError(`refused: ${ctx.jobId} started on claude and a started job keeps its driver; dispatch a new job to run pi`);
		const pi = await resolveWithCapacity(route, config, probe, capacity);
		return { ...pi, requested_driver: "pi", driver: "pi", driver_reason: "explicit: cp_dispatch driver pi" };
	}
	if (locked === "pi" && ctx.explicit) {
		throw new NativeDriverError(`refused: ${ctx.jobId} started on pi and a started job keeps its driver; dispatch a new job to run native`);
	}
	const picked = pickModel(route, config);
	const fresh = ctx.explicit === undefined && locked === undefined;
	const rule = !route.override ? rowOf(picked, config) : fresh && isNativeModel(route.override) ? overrideRow(route, config) : undefined;
	const wants = ctx.explicit !== undefined || locked === "claude" || (fresh && rule?.driver === "claude");
	if (!wants) return resolveWithCapacity(route, config, probe, capacity);
	const why = ctx.explicit ? "explicit: cp_dispatch driver claude" : locked ? "lock: the job started on claude"
		: `rule: ${rule!.id} prefers claude${route.override ? `; override ${route.override}` : ""}`;
	// A config error, never a silent fallback: the native primary is the row's (or caller's) own explicit model.
	nativeModelId(picked.model);
	assertNativeEffort(picked.thinking);
	const selection = { home: ctx.home, jobId: ctx.jobId, driver: "claude" as const, kind: ctx.kind, role: ctx.role, delivery: ctx.delivery, jobs: ctx.jobs,
		...(ctx.profile !== undefined ? { profile: ctx.profile } : {}), ...(ctx.skills !== undefined ? { skills: ctx.skills } : {}) };
	let selected: ReturnType<typeof nativeSelectionRefusal> | undefined;
	let note: string | undefined;
	let model: string | undefined;
	let skipped: { category: NativeRefusal; why: string } | undefined;
	// J5: the row's native candidates in order; the first allowed one S2's subscription evidence does not block wins.
	// An explicit model is never substituted: a blocked override refuses (then pi), as before J5.
	const candidates = route.override ? [picked.model] : [picked.model, ...(rule?.fallbacks ?? [])];
	for (const candidate of candidates.filter(isNativeModel)) {
		const blocked = allowRefusal(config, ctx.role, candidate)
			?? await (selected ??= nativeSelectionRefusal(selection))
			?? await nativeAvailability(ctx.home, candidate).then((seen) => ((note = seen.note), seen.blocked));
		if (!blocked) { model = candidate; break; }
		skipped ??= blocked;
	}
	// The slot is still taken synchronously after the last await.
	const refusal = model === undefined ? skipped : slotRefusal(ctx);
	if (refusal && (ctx.explicit || locked)) {
		throw new NativeDriverError(`refused: ${ctx.jobId} cannot run on the Claude CLI driver: ${refusal.why}`, refusal.category);
	}
	if (refusal) {
		const pi = await resolveWithCapacity(route, config, probe, capacity);
		return { ...pi, requested_driver: "claude", driver: "pi", driver_reason: bounded(`${refusal.category}: ${refusal.why}`) };
	}
	if (ctx.reserve) slots.set(ctx.home, (slots.get(ctx.home) ?? new Set<string>()).add(ctx.jobId));
	const native: RoutingDecision = {
		model: model!, source: picked.source, rule: picked.rule,
		...(picked.thinking ? { thinking: picked.thinking } : {}),
		...(route.override ? { requested: route.override } : {}),
		...(route.thinking ? { requested_thinking: route.thinking } : {}),
	};
	const fellBack = skipped ? `; ${skipped.category}: ${skipped.why}; native fallback ${model}` : "";
	return { ...native, requested_driver: "claude", driver: "claude", driver_reason: bounded(`${why}; effort ${picked.thinking ?? "CLI default"}${fellBack}${note ? `; ${note}` : ""}`) };
}

const rowOf = (picked: ReturnType<typeof pickModel>, config: RoutingConfig) =>
	picked.source === "rubric" ? config.rubric.find((row) => row.id === picked.rule) : undefined;

/**
 * J4: the row the role would get without the override; only its `driver` is read. No row (or a refused one) is pi.
 * The J5 walk reads a row's fallbacks only without an override: an explicit model is never substituted.
 */
function overrideRow(route: RouteRequest, config: RoutingConfig): RoutingConfig["rubric"][number] | undefined {
	try {
		return rowOf(pickModel({ ...route, override: undefined }, config), config);
	} catch (error) {
		if (error instanceof RoutingError) return undefined;
		throw error;
	}
}

/** `pickModel` skips the allowlist for a row with fallbacks (the pi walk filters there): check the native primary. */
function allowRefusal(config: RoutingConfig, role: Role, model: string): { category: NativeRefusal; why: string } | undefined {
	if (!isAllowed(config, model)) return { category: "denied", why: `the allowlist refuses ${model}` };
	const pattern = deniedFor(config, role, model);
	return pattern === undefined ? undefined : { category: "denied", why: `deny_by_role.${role} matches ${pattern} for ${model}` };
}

/** Checked synchronously after the last await, so admissions in one parent never overfill the home's N slots. */
function slotRefusal(ctx: DriverContext): { category: NativeRefusal; why: string } | undefined {
	const holders = [...liveNativeJobs(ctx.jobs), ...(slots.get(ctx.home) ?? []), ...(ctx.nativeLive ?? [])];
	return nativeSlotRefusal(holders, ctx.jobId, nativeMaxConcurrent(ctx.home), "live or being admitted");
}

/** Keys of this parent's live native workers other than `except`'s: reviewers hold the slot without a fleet record. */
export const liveNativeWorkers = (manager: Pick<WorkerManager, "active">, except: string): string[] =>
	manager.active.filter((worker) => worker.driver !== undefined && worker.key !== except).map((worker) => worker.key);

/** The three driver fields `JobRouting` and `cp:routing_resolved` persist; absent is pi. */
export function driverFields(decision: RoutingDecision): Pick<RoutingDecision, "requested_driver" | "driver" | "driver_reason"> {
	const { requested_driver, driver, driver_reason } = decision;
	return { ...(requested_driver ? { requested_driver } : {}), ...(driver ? { driver } : {}), ...(driver_reason ? { driver_reason } : {}) };
}

/** Spawn fields for the decided driver: the native worker gets its routed effort and the job's base branch (its
 * forge tools' PR base and refused push target); pi gets nothing extra. */
export function nativeSpawn(decision: RoutingDecision, base?: string): { driver?: NativeDriver; extraEnv?: Record<string, string> } {
	return decision.driver === "claude" ? { driver: "claude", extraEnv: { ...nativeThinkingEnv(decision.thinking), ...nativeBaseEnv(base) } } : {};
}

function bounded(reason: string): string {
	return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}
