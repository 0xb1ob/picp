/**
 * The native Claude research driver's dispatch side (N3b): which job may run on it, and the spawn that starts
 * src/drivers/claude-worker.ts in place of pi. Every refusal names its reason and happens before any process starts.
 */
import { fileURLToPath } from "node:url";
import type { Delivery, FleetRecord, JobKind, Role } from "../contracts.ts";
import { loadNativeConfig, nativeConfigFile, type NativeDriver } from "../worker-driver.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";

export class NativeDriverError extends Error {}

const WORKER_ENTRY = fileURLToPath(new URL("./claude-worker.ts", import.meta.url));
const LIVE_PHASES: readonly string[] = ["launching", "waiting", "held"];
const DELIVERIES: readonly Delivery[] = ["local", "answer"];

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

/** Throws the named refusal unless every N3b condition holds: switch on, research role, concurrency 1, pinned claude. */
export async function assertNativeSelection(input: NativeSelection): Promise<void> {
	const refuse = (why: string): never => {
		throw new NativeDriverError(`refused: ${input.jobId} cannot run on the native ${input.driver} driver: ${why}`);
	};
	let on: boolean;
	try {
		on = loadNativeConfig(nativeConfigFile(input.home)).claude_research;
	} catch (error) {
		return refuse(`the native switch is unreadable (${(error as Error).message})`);
	}
	if (!on) refuse("the switch workers.native_claude_research is off (dashboard Settings → Native workers)");
	if (input.kind !== "research" || input.role !== "planner" || !DELIVERIES.includes(input.delivery)) {
		refuse(`only research jobs (role planner, delivery local or answer) run native; this is ${input.kind}/${input.role}/${input.delivery}`);
	}
	const live = liveNativeJobs(input.jobs).filter((id) => id !== input.jobId);
	if (live.length > 0) refuse(`native concurrency is 1 and ${live.join(", ")} is live; tear it down first`);
	try {
		// Loaded on use: the SDK it imports is not on the extension's startup path.
		const { resolveClaude } = await import("./claude-spike.ts");
		resolveClaude(input.env ?? process.env);
	} catch (error) {
		refuse((error as Error).message);
	}
}

/** Fleet jobs whose native worker has not been observed to exit. */
export function liveNativeJobs(jobs: readonly FleetRecord[]): string[] {
	return jobs.filter((job) => job.worker?.driver !== undefined && job.worker.exited_at === undefined && LIVE_PHASES.includes(job.phase)).map((job) => job.job_id);
}

/** Overrides pi's argv with the native worker; the env stays the planned worker env,
 * plus the routed Anthropic model. */
export function nativeSpawnOptions(model: string, env: NodeJS.ProcessEnv): Pick<WorkerSpawnOptions, "piBin" | "argv" | "env"> {
	const [provider, id] = model.includes("/") ? [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)] : ["", model];
	return { piBin: process.execPath, argv: [WORKER_ENTRY], env: { ...env, ...(provider === "anthropic" ? { CP_NATIVE_MODEL: id } : {}) } };
}
