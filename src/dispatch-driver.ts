/**
 * Native routing S1: which driver a dispatch runs on. A rubric row's `driver` binds (cp-qmry: never another CLI, a
 * full one queues), a started job keeps its driver (D1). Each driver's spec (src/drivers/registry.ts) decides eligibility.
 */
import { type Delivery, type FleetRecord, isScriptFleetRecord, type JobKind, type Role, type RoutingConfig, type RoutingDecision, type RoutingDriver } from "./contracts.ts";
import { liveNativeJobs, nativeBaseEnv, NativeDriverError, type NativeRefusal, nativeSlotRefusal, nativeThinkingEnv } from "./drivers/claude.ts";
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
	/** A human's recorded per-job driver override (the only switch off the configured CLI), as `driver_reason` text. */
	driverOverride?: { driver: RoutingDriver; reason: string };
	/** Reviewer only: the held, idle author on the same CLI whose slot this reviewer may borrow (cp-912x ruling). */
	borrowFrom?: string;
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

/** Take `driver`'s slot for `jobId` until its `holdNativeSlot` settles. */
export function reserveNativeSlot(home: string, jobId: string, driver: NativeDriver): void {
	slots.set(slotKey(home, driver), (slots.get(slotKey(home, driver)) ?? new Set<string>()).add(jobId));
}

/** The routing decision plus the driver it runs on; the pi lane is `resolveWithCapacity` unchanged. */
export async function resolveDriverRoute(
	route: RouteRequest, config: RoutingConfig, probe: ModelProbe, capacity: Capacity, ctx: DriverContext,
): Promise<RoutingDecision> {
	const prior = ctx.jobs.find((job) => job.job_id === ctx.jobId);
	const locked = prior && !isScriptFleetRecord(prior) ? (prior.worker.driver ?? "pi") : undefined;
	// The CLI settings bind this job to: its row's driver without any model override (absent is pi).
	const configuredRow = overrideRow(route, config);
	const configured = configuredRow?.driver === undefined || configuredRow.driver === "pi" ? undefined : (configuredRow.driver as NativeDriver);
	const override = ctx.driverOverride !== undefined && ctx.driverOverride.driver === ctx.explicit ? ctx.driverOverride : undefined;
	if (ctx.explicit === "pi") {
		if (locked !== undefined && locked !== "pi") throw new NativeDriverError(`refused: ${ctx.jobId} started on ${locked} and a started job keeps its driver; dispatch a new job to run pi`);
		if (locked === undefined && configured !== undefined && !override) {
			throw new NativeDriverError(`refused: ${ctx.jobId} is configured to run on the ${nativeDriverSpec(configured).label} (rule ${configuredRow!.id}), and a parent's driver choice is not an override; only the operator's own per-job request (cp_parent model_pick with driver) switches the CLI`, "switch", configured);
		}
		const pi = await resolveWithCapacity(route, config, probe, capacity);
		return { ...pi, requested_driver: "pi", driver: "pi", driver_reason: bounded(override?.reason ?? "explicit: cp_dispatch driver pi") };
	}
	if (locked === "pi" && ctx.explicit) {
		throw new NativeDriverError(`refused: ${ctx.jobId} started on pi and a started job keeps its driver; dispatch a new job to run native`);
	}
	if (locked !== undefined && ctx.explicit !== undefined && ctx.explicit !== locked) {
		throw new NativeDriverError(`refused: ${ctx.jobId} started on ${locked} and a started job keeps its driver; dispatch a new job to run ${ctx.explicit}`);
	}
	const picked = pickModel(route, config);
	const fresh = ctx.explicit === undefined && locked === undefined;
	const rule = !route.override ? rowOf(picked, config) : fresh ? configuredRow : undefined;
	const rowDriver = rule?.driver === undefined || rule.driver === "pi" ? undefined : (rule.driver as NativeDriver);
	// A model-only change never changes the CLI: a model the configured CLI cannot run refuses (J4 used to run pi).
	if (fresh && rowDriver !== undefined && route.override && !nativeDriverSpec(rowDriver).isModel(route.override)) {
		throw new NativeDriverError(`refused: ${ctx.jobId} asks for ${route.override}, which cannot run on the configured ${nativeDriverSpec(rowDriver).label} (rule ${rule!.id}); a model change never changes the CLI — pick a model that CLI runs, or omit model`, "model", rowDriver);
	}
	// `explicit` is not `pi` here, and `locked` is a fleet `worker.driver` (a native name) or `pi`.
	const wanted = (ctx.explicit ?? (locked !== undefined && locked !== "pi" ? locked : undefined) ?? (fresh ? rowDriver : undefined)) as NativeDriver | undefined;
	if (wanted === undefined) return resolveWithCapacity(route, config, probe, capacity);
	const spec = nativeDriverSpec(wanted);
	const why = override ? override.reason : ctx.explicit ? `explicit: cp_dispatch driver ${wanted}` : locked ? `lock: the job started on ${wanted}`
		: `rule: ${rule!.id} prefers ${wanted}${route.override ? `; override ${route.override}` : ""}`;
	// A config error, never a silent fallback: the native primary is the row's (or caller's) own explicit model.
	spec.modelId(picked.model);
	spec.assertEffort(picked.thinking);
	// Selection counts fleet slots too: a lent author's is not counted there either.
	const jobs = ctx.borrowFrom === undefined ? ctx.jobs : ctx.jobs.filter((job) => job.job_id !== ctx.borrowFrom);
	const selection = { home: ctx.home, jobId: ctx.jobId, driver: wanted, kind: ctx.kind, role: ctx.role, delivery: ctx.delivery, jobs,
		...(ctx.profile !== undefined ? { profile: ctx.profile } : {}) };
	let selected: ReturnType<NativeDriverSpec["selectionRefusal"]> | undefined;
	let note: string | undefined;
	let model: string | undefined;
	let skipped: { category: NativeRefusal; why: string } | undefined;
	// J5: the row's native candidates in order; the first allowed one S2's subscription evidence does not block wins.
	// An explicit model is never substituted: a blocked override refuses.
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
	// Never another CLI: a full CLI is `occupied` (the caller queues), every other refusal is named.
	if (refusal) throw new NativeDriverError(`refused: ${ctx.jobId} cannot run on the ${spec.label} driver: ${refusal.why}`, refusal.category, wanted);
	const borrowed = ctx.borrowFrom !== undefined && slotRefusal({ ...ctx, borrowFrom: undefined }, wanted) !== undefined
		? `borrowed: reviewer using held author's slot (${ctx.borrowFrom}); ` : "";
	if (ctx.reserve) reserveNativeSlot(ctx.home, ctx.jobId, wanted);
	const native: RoutingDecision = {
		model: model!, source: picked.source, rule: picked.rule,
		...(picked.thinking ? { thinking: picked.thinking } : {}),
		...(route.override ? { requested: route.override } : {}),
		...(route.thinking ? { requested_thinking: route.thinking } : {}),
	};
	const fellBack = skipped ? `; ${skipped.category}: ${skipped.why}; native fallback ${model}` : "";
	return { ...native, requested_driver: wanted, driver: wanted, driver_reason: bounded(`${borrowed}${why}; effort ${picked.thinking ?? "CLI default"}${fellBack}${note ? `; ${note}` : ""}`) };
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
	const holders = [...liveNativeJobs(ctx.jobs, driver), ...(slots.get(slotKey(ctx.home, driver)) ?? []), ...(ctx.nativeLive?.[driver] ?? [])]
		.filter((id) => id !== ctx.borrowFrom);
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
