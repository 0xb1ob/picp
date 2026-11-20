/**
 * Native routing S1: which driver a dispatch runs on. A rubric row's `driver` is a preference, an explicit request is
 * strict, and a started job keeps its driver (D1). Each driver's spec (src/drivers/registry.ts) decides eligibility.
 */
import { type Delivery, type FleetRecord, isScriptFleetRecord, type JobKind, type Role, type RoutingConfig, type RoutingDecision, type RoutingDriver } from "./contracts.ts";
import { liveNativeJobs, nativeBaseEnv, NativeDriverError, type NativeRefusal, nativeSlotRefusal, nativeThinkingEnv } from "./drivers/claude.ts";
import { codexPersistRefusal } from "./drivers/codex.ts";
import { nativeDriverSpec, type NativeDriverSpec } from "./drivers/registry.ts";
import { deniedFor, isAllowed, type ModelProbe, pickModel, resolveWithCapacity, type RouteRequest, RoutingError } from "./routing.ts";
export { observeNative } from "./native-availability-observer.ts";
import { NATIVE_DRIVERS, type NativeDriver } from "./worker-driver.ts";
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
	/** Native workers live in this parent that the fleet does not list (reviewers, N4h), per driver; each holds a slot. */
	nativeLive?: Partial<Record<NativeDriver, readonly string[]>>;
	/** The selected profile's name: `ops` makes a job ineligible for native. */
	profile?: string;
}

type Capacity = Parameters<typeof resolveWithCapacity>[3];

/** Per home and driver, the jobs holding a native slot between route resolution and their fleet record (or failure). */
const slots = new Map<string, Set<string>>();
const slotKey = (home: string, driver: NativeDriver): string => `${home}\0${driver}`;

/** Runs one admission and releases the native slot it reserved when it settles (the fleet record holds it by then). */
export async function holdNativeSlot<T>(home: string, jobId: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} finally {
		for (const driver of NATIVE_DRIVERS) {
			const held = slots.get(slotKey(home, driver));
			held?.delete(jobId);
			if (held?.size === 0) slots.delete(slotKey(home, driver));
		}
	}
}

/** The routing decision plus the driver it runs on; the pi lane is `resolveWithCapacity` unchanged. */
export async function resolveDriverRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Capacity, ctx: DriverContext,
): Promise<RoutingDecision> {
	const prior = ctx.jobs.find((job) => job.job_id === ctx.jobId);
	const locked = prior && !isScriptFleetRecord(prior) ? (prior.worker.driver ?? "pi") : undefined;
	if (ctx.explicit === "pi") {
		if (locked !== undefined && locked !== "pi") throw new NativeDriverError(`refused: ${ctx.jobId} started on ${locked} and a started job keeps its driver; dispatch a new job to run pi`);
		const pi = await resolveWithCapacity(route, config, probe, capacity);
		return { ...pi, requested_driver: "pi", driver: "pi", driver_reason: "explicit: cp_dispatch driver pi" };
	}
	if (locked === "pi" && ctx.explicit) {
		throw new NativeDriverError(`refused: ${ctx.jobId} started on pi and a started job keeps its driver; dispatch a new job to run native`);
	}
	if (locked !== undefined && ctx.explicit !== undefined && ctx.explicit !== locked) {
		throw new NativeDriverError(`refused: ${ctx.jobId} started on ${locked} and a started job keeps its driver; dispatch a new job to run ${ctx.explicit}`);
	}
	const picked = pickModel(route, config);
	const fresh = ctx.explicit === undefined && locked === undefined;
	const rule = !route.override ? rowOf(picked, config) : fresh ? overrideRow(route, config) : undefined;
	// J4: an override is native only when the row's own driver accepts that model.
	const rowDriver = rule?.driver === undefined || rule.driver === "pi" ? undefined : (rule.driver as NativeDriver);
	const ruleDriver = rowDriver !== undefined && (!route.override || nativeDriverSpec(rowDriver).isModel(route.override)) ? rowDriver : undefined;
	// `explicit` is not `pi` here, and `locked` is a fleet `worker.driver` (a native name) or `pi`.
	const wanted = (ctx.explicit ?? (locked !== undefined && locked !== "pi" ? locked : undefined) ?? (fresh ? ruleDriver : undefined)) as NativeDriver | undefined;
	if (wanted === undefined) return resolveWithCapacity(route, config, probe, capacity);
	const spec = nativeDriverSpec(wanted);
	const why = ctx.explicit ? `explicit: cp_dispatch driver ${wanted}` : locked ? `lock: the job started on ${wanted}`
		: `rule: ${rule!.id} prefers ${wanted}${route.override ? `; override ${route.override}` : ""}`;
	// A config error, never a silent fallback: the native primary is the row's (or caller's) own explicit model.
	spec.modelId(picked.model);
	spec.assertEffort(picked.thinking);
	const selection = { home: ctx.home, jobId: ctx.jobId, driver: wanted, kind: ctx.kind, role: ctx.role, delivery: ctx.delivery, jobs: ctx.jobs,
		...(ctx.profile !== undefined ? { profile: ctx.profile } : {}) };
	let selected: ReturnType<NativeDriverSpec["selectionRefusal"]> | undefined;
	let note: string | undefined;
	let model: string | undefined;
	let skipped: { category: NativeRefusal; why: string } | undefined;
	// J5: the row's native candidates in order; the first allowed one S2's subscription evidence does not block wins.
	// An explicit model is never substituted: a blocked override refuses (then pi), as before J5.
	const candidates = route.override ? [picked.model] : [picked.model, ...(rule?.fallbacks ?? [])];
	for (const candidate of candidates.filter(spec.isModel)) {
		const blocked = allowRefusal(config, ctx.role, candidate)
			?? await (selected ??= spec.selectionRefusal(selection))
			?? (spec.availability ? await spec.availability(ctx.home, candidate).then((seen) => ((note = seen.note), seen.blocked)) : undefined);
		if (!blocked) { model = candidate; break; }
		skipped ??= blocked;
	}
	// The slot is still taken synchronously after the last await.
	const refusal = model === undefined ? skipped : slotRefusal(ctx, wanted);
	if (refusal && (ctx.explicit || locked)) {
		throw new NativeDriverError(`refused: ${ctx.jobId} cannot run on the ${spec.label} driver: ${refusal.why}`, refusal.category);
	}
	if (refusal) {
		const pi = await resolveWithCapacity(route, config, probe, capacity);
		// While codex is off no persisted record names it: the previous build reads the fleet and run log.
		const off = wanted === "codex" && codexPersistRefusal(ctx.home, `the routing record of ${ctx.jobId}`) !== undefined;
		return { ...pi, ...(off ? {} : { requested_driver: wanted }), driver: "pi", driver_reason: bounded(`${refusal.category}: ${refusal.why}`) };
	}
	if (ctx.reserve) slots.set(slotKey(ctx.home, wanted), (slots.get(slotKey(ctx.home, wanted)) ?? new Set<string>()).add(ctx.jobId));
	const native: RoutingDecision = {
		model: model!, source: picked.source, rule: picked.rule,
		...(picked.thinking ? { thinking: picked.thinking } : {}),
		...(route.override ? { requested: route.override } : {}),
		...(route.thinking ? { requested_thinking: route.thinking } : {}),
	};
	const fellBack = skipped ? `; ${skipped.category}: ${skipped.why}; native fallback ${model}` : "";
	return { ...native, requested_driver: wanted, driver: wanted, driver_reason: bounded(`${why}; effort ${picked.thinking ?? "CLI default"}${fellBack}${note ? `; ${note}` : ""}`) };
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

/** Checked synchronously after the last await, so admissions in one parent never overfill a driver's N slots. */
function slotRefusal(ctx: DriverContext, driver: NativeDriver): { category: NativeRefusal; why: string } | undefined {
	const holders = [...liveNativeJobs(ctx.jobs, driver), ...(slots.get(slotKey(ctx.home, driver)) ?? []), ...(ctx.nativeLive?.[driver] ?? [])];
	const spec = nativeDriverSpec(driver);
	return nativeSlotRefusal(holders, ctx.jobId, spec.maxConcurrent(ctx.home), "live or being admitted", spec.noun);
}

/** Keys of this parent's live native workers other than `except`'s, per driver: reviewers hold a slot without a record. */
export function liveNativeWorkers(manager: Pick<WorkerManager, "active">, except: string): Partial<Record<NativeDriver, string[]>> {
	const live: Partial<Record<NativeDriver, string[]>> = {};
	for (const worker of manager.active) if (worker.driver !== undefined && worker.key !== except) (live[worker.driver] ??= []).push(worker.key);
	return live;
}

/** The three driver fields `JobRouting` and `cp:routing_resolved` persist; absent is pi. */
export function driverFields(decision: RoutingDecision): Pick<RoutingDecision, "requested_driver" | "driver" | "driver_reason"> {
	const { requested_driver, driver, driver_reason } = decision;
	return { ...(requested_driver ? { requested_driver } : {}), ...(driver ? { driver } : {}), ...(driver_reason ? { driver_reason } : {}) };
}

/** Spawn fields for the decided driver: the native worker gets its routed effort and the job's base branch (its
 * forge tools' PR base and refused push target); pi gets nothing extra. */
export function nativeSpawn(decision: RoutingDecision, base?: string): { driver?: NativeDriver; extraEnv?: Record<string, string> } {
	if (decision.driver === "codex") return { driver: "codex", extraEnv: { ...nativeThinkingEnv(decision.thinking), ...nativeBaseEnv(base) } };
	return decision.driver === "claude" ? { driver: "claude", extraEnv: { ...nativeThinkingEnv(decision.thinking), ...nativeBaseEnv(base) } } : {};
}

function bounded(reason: string): string {
	return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}
