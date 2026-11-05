/**
 * The native Claude research driver's dispatch side (N3b): which job may run on it, and the spawn that starts
 * src/drivers/claude-worker.ts in place of pi. Every refusal names its reason and happens before any process starts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Delivery, type FleetRecord, type JobKind, paths, type Role } from "../contracts.ts";
import { loadNativeConfig, nativeConfigFile, type NativeDriver } from "../worker-driver.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";

/** Why a job may not run native (S1): the resolver falls back to pi on these; an explicit request refuses. */
export type NativeRefusal = "switch" | "pipeline" | "ineligible" | "occupied" | "cli_missing" | "cli_version" | "model" | "effort" | "denied" | "window" | "auth" | "lockdown";

export class NativeDriverError extends Error {
	readonly category?: NativeRefusal;
	constructor(message: string, category?: NativeRefusal) {
		super(message);
		if (category) this.category = category;
	}
}

const WORKER_ENTRY = fileURLToPath(new URL("./claude-worker.ts", import.meta.url));
const LIVE_PHASES: readonly string[] = ["launching", "waiting", "held"];
// One shared load: concurrent admissions awaiting their own import() could see a half-evaluated module.
let spike: Promise<typeof import("./claude-spike.ts")> | undefined;
const DELIVERIES: readonly Delivery[] = ["local", "answer"];
const NATIVE_MODEL = /^anthropic\/(claude-[A-Za-z0-9][A-Za-z0-9._[\]-]*)$/;
/** Routed levels the SDK serves as `effort`; `off` disables thinking and `minimal` has no native equivalent. */
export const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface NativeSelection {
	home: string;
	jobId: string;
	driver: NativeDriver;
	kind: JobKind;
	role: Role;
	delivery: Delivery;
	jobs: readonly FleetRecord[];
	env?: NodeJS.ProcessEnv;
}

/** The first N3b condition that fails, typed, or undefined: switch on, local/answer research not owned by a
 * pipeline (D2), concurrency 1, pinned claude. */
export async function nativeSelectionRefusal(input: NativeSelection): Promise<{ category: NativeRefusal; why: string } | undefined> {
	let on: boolean;
	try {
		on = loadNativeConfig(nativeConfigFile(input.home)).claude_research;
	} catch (error) {
		return { category: "switch", why: `the native switch is unreadable (${(error as Error).message})` };
	}
	if (!on) return { category: "switch", why: "the switch workers.native_claude_research is off (dashboard Settings → Native workers)" };
	if (existsSync(join(input.home, paths.pipelineFile(input.jobId)))) {
		return { category: "pipeline", why: "pipeline-owned research stays on pi; only local and answer research run native" };
	}
	if (input.kind !== "research" || input.role !== "planner" || !DELIVERIES.includes(input.delivery)) {
		return { category: "ineligible", why: `only research jobs (role planner, delivery local or answer) run native; this is ${input.kind}/${input.role}/${input.delivery}` };
	}
	const live = liveNativeJobs(input.jobs).filter((id) => id !== input.jobId);
	if (live.length > 0) return { category: "occupied", why: `native concurrency is 1 and ${live.join(", ")} is live; tear it down first` };
	try {
		// Loaded on use: the SDK it imports is not on the extension's startup path.
		spike ??= import("./claude-spike.ts");
		const { resolveClaude } = await spike;
		resolveClaude(input.env ?? process.env);
	} catch (error) {
		return { category: (error as { cli?: string }).cli === "missing" ? "cli_missing" : "cli_version", why: (error as Error).message };
	}
	return undefined;
}

/** Throws the named refusal unless every N3b condition holds (explicit requests, resumes and revives). */
export async function assertNativeSelection(input: NativeSelection): Promise<void> {
	const refusal = await nativeSelectionRefusal(input);
	if (refusal) throw new NativeDriverError(`refused: ${input.jobId} cannot run on the native ${input.driver} driver: ${refusal.why}`, refusal.category);
}

/** The installed CLI's version (S2 invalidation iii), or undefined when it cannot be resolved. */
export async function installedClaudeVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	try {
		spike ??= import("./claude-spike.ts");
		return (await spike).resolveClaude(env).version;
	} catch {
		return undefined;
	}
}

/** Fleet jobs whose native worker has not been observed to exit. */
export function liveNativeJobs(jobs: readonly FleetRecord[]): string[] {
	return jobs.filter((job) => job.worker?.driver !== undefined && job.worker.exited_at === undefined && LIVE_PHASES.includes(job.phase)).map((job) => job.job_id);
}

/** The CLI's model id from an explicit `anthropic/claude-…` ref; any other ref is refused, never silently omitted. */
export function nativeModelId(model: string): string {
	const id = NATIVE_MODEL.exec(model)?.[1];
	if (id === undefined) {
		throw new NativeDriverError(`the native claude driver runs an explicit anthropic/claude-… model, and ${model} is not one: fix the rubric row or the dispatch model`, "model");
	}
	return id;
}

/** Overrides pi's argv with the native worker; the env is the planned worker env plus the routed Anthropic model. */
export function nativeSpawnOptions(model: string, env: NodeJS.ProcessEnv): Pick<WorkerSpawnOptions, "piBin" | "argv" | "env"> {
	return { piBin: process.execPath, argv: [WORKER_ENTRY], env: { ...env, CP_NATIVE_MODEL: nativeModelId(model) } };
}

/** Refuses a routed level with no native effort; absent (the CLI default), `off` and low…max pass. */
export function assertNativeEffort(level: string | undefined): asserts level is (typeof NATIVE_EFFORTS)[number] | "off" | "" | undefined {
	if (level === undefined || level === "" || level === "off" || (NATIVE_EFFORTS as readonly string[]).includes(level)) return;
	throw new NativeDriverError(`thinking=${level} has no native claude effort; route off, low, medium, high, xhigh or max`, "effort");
}

/** The routed thinking level for the native worker's SDK options; absent leaves the CLI default (recorded as such). */
export function nativeThinkingEnv(thinking: string | undefined): Record<string, string> {
	return thinking ? { CP_NATIVE_THINKING: thinking } : {};
}
