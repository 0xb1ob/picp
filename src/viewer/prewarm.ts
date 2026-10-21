/**
 * Background cache build at viewer start: the viewer restarts on every self-update, so the first Jobs, Map or Stats
 * request would otherwise pay the cold read of every run. Per-job reads go in small slices, each its own turn.
 */
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { workerContext, modelWindows } from "./context-usage.ts";
import { statScope } from "./file-cache.ts";
import { jobsView } from "./jobs-view.ts";
import { dependencyMap } from "./mandates-map-view.ts";
import { recordedEvents } from "./overview-health.ts";
import { headCi, recordedReview } from "./overview-jobs.ts";
import { fleetJobs, isSafeId, readObject, readStatus, str, type ViewerState } from "./sessions.ts";
import { statsView, statsWarmSteps } from "./stats-view.ts";

const SLICE = 8;
// Any head reads the run's CI-event tail into its file cache; the answer is discarded.
const PRIME_HEAD = "0".repeat(40);
type Stage = "jobs" | "map" | "stats";
const STAGES: readonly Stage[] = ["jobs", "map", "stats"];
const builds = new Map<string, Map<Stage, Promise<void>>>();
const keyOf = (state: ViewerState) => `${state.home}|${state.stateDir}`;

/** The pre-warm stage `view` still waits on for this home, if any: the view awaits it instead of scanning beside it. */
export const warming = (state: ViewerState, view: Stage): Promise<void> | undefined => builds.get(keyOf(state))?.get(view);

/** Start the build once per home; `onStage` hears each view turn warm, `log` the one `caches warm` line or failure. */
export function prewarm(state: ViewerState, log: (line: string) => void, onStage: (view: Stage) => void = () => {}): void {
	const key = keyOf(state);
	if (builds.has(key)) return;
	const stages = new Map<Stage, Promise<void>>(); const release = new Map<Stage, () => void>();
	for (const stage of STAGES) stages.set(stage, new Promise<void>((resolve) => release.set(stage, resolve)));
	builds.set(key, stages);
	const reached = (stage: Stage) => { stages.delete(stage); release.get(stage)!(); onStage(stage); };
	void (async () => {
		const start = performance.now();
		await nextTurn();
		const ids = fleetJobs(state).map((job) => str(job.job_id)).filter((id): id is string => id !== undefined && isSafeId(id));
		const windows = modelWindows(state.stateDir);
		for (let i = 0; i < ids.length; i += SLICE) {
			statScope(() => {
				for (const id of ids.slice(i, i + SLICE)) {
					readStatus(state, id); readObject(join(state.stateDir, "runs", id, "envelope.json")); recordedReview(state, id, null);
					workerContext(state, id, null, windows); recordedEvents(state, id); headCi(state, id, undefined, PRIME_HEAD);
				}
			});
			await nextTurn();
		}
		statScope(() => jobsView(state));
		reached("jobs");
		await nextTurn();
		statScope(() => dependencyMap(state));
		reached("map");
		await nextTurn();
		for (const step of statScope(() => statsWarmSteps(state, Date.now()))) { statScope(step); await nextTurn(); }
		statScope(() => statsView(state, new URLSearchParams(), Date.now()));
		reached("stats");
		log(`cp-view: caches warm in ${Math.round(performance.now() - start)} ms (${ids.length} runs; jobs, map, stats)\n`);
	})().catch((error: unknown) => {
		log(`cp-view: cache pre-warm failed, views read cold: ${error instanceof Error ? error.message : String(error)}\n`);
	}).finally(() => { builds.delete(key); for (const resolve of release.values()) resolve(); });
}
