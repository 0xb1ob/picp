/**
 * Native CI for a parked (`awaiting_merge`) PR, observed by the parked sweep for the head it just read: Actions runs
 * and jobs into the shared ci-watch row, a new green/red journaled as `ci_observed`. Observation only: no `cp-ci`
 * wake, no resume, no merge — `isWatched` and held continuation never see a parked job.
 */
import { CI_WATCH_IDLE_MULTIPLIER, CI_WATCH_MAX_BACKOFF_MS, type FleetRecord, isoTimestamp } from "./contracts.ts";
import type { PrSnapshot } from "./awaiting-merge-exits.ts";
import { CI_UNREADABLE, ciReadDenied } from "./ci-access.ts";
import { recordCiObserved } from "./ci-evidence.ts";
import { type CiWatchCadence, CiWatchStore, ciStateOf, ciWatchIntervalMs, deriveCiEvents, nextDueMs } from "./ci-watch.ts";
import type { CiRun } from "./merge-ask.ts";
import type { RunRegistry } from "./runs.ts";

export interface ParkedCiPorts {
	home: string;
	fleet: { get(jobId: string): FleetRecord | undefined };
	/** Every Actions run (with attempt jobs) on exactly `head`; throws when it cannot read them all. */
	read: (record: FleetRecord, head: string) => Promise<readonly CiRun[]>;
	runs?: Pick<RunRegistry, "open">;
	now?: () => Date;
	cadence?: CiWatchCadence;
}

export type ObserveParkedCi = (record: FleetRecord, snap: PrSnapshot) => Promise<void>;

const SETTLED = new Set(["green", "failed"]);

/** One observation per due open snapshot; a read failure is stored (unreadable or unknown), never thrown. */
export function parkedCiObserver(ports: ParkedCiPorts): ObserveParkedCi {
	const now = ports.now ?? (() => new Date());
	const store = new CiWatchStore({ home: ports.home, now });
	const cadence = ports.cadence ?? { intervalMs: ciWatchIntervalMs(), idleMultiplier: CI_WATCH_IDLE_MULTIPLIER, maxBackoffMs: CI_WATCH_MAX_BACKOFF_MS };
	return async (record, snap) => {
		const cycle = record.awaiting_merge?.cycle;
		if (snap.state !== "open" || record.phase !== "awaiting_merge" || cycle === undefined) return;
		const jobId = record.job_id;
		const head = snap.head_sha;
		const prior = store.job(jobId);
		const failures = prior?.consecutive_failures ?? 0;
		const wait = nextDueMs(cadence, { failures, settled: SETTLED.has(prior?.last_ci ?? "") });
		const checked = Date.parse(prior?.last_checked_at ?? "");
		if (prior?.head_sha === head && Number.isFinite(checked) && now().getTime() < checked + wait) return;
		let runs: readonly CiRun[] | undefined;
		let error: string | undefined;
		try {
			runs = await ports.read(record, head);
		} catch (caught) {
			error = (caught as Error).message.slice(0, 300) || "Actions read failed";
		}
		// A resume or re-park during the read makes this another cycle's fact: drop it.
		const current = ports.fleet.get(jobId);
		if (current?.phase !== "awaiting_merge" || current.awaiting_merge?.cycle !== cycle) return;
		const at = isoTimestamp(now());
		const observed = { head_sha: head, head_observed_at: at, last_checked_at: at, next_due_at: undefined };
		if (runs === undefined) {
			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: ciReadDenied(error ?? "") ? CI_UNREADABLE : "unknown" });
			return;
		}
		const facts = { jobId, branch: record.branch, head: { sha: head }, runs };
		const state = ciStateOf(facts);
		const changed = prior?.head_sha !== head || prior.last_ci !== state;
		store.record(jobId, { ...observed, consecutive_failures: 0, last_error: undefined, last_ci: state });
		if (!changed || !ports.runs) return;
		for (const event of deriveCiEvents({ ...facts, pr: { merged: false, state: "open", url: snap.url, number: snap.number, head_sha: head } })) {
			recordCiObserved(ports.runs, jobId, event);
		}
	};
}
