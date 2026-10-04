/**
 * 4b-1: release a held author's idle process when a fresh dispatch or revive
 * needs its spawn slot.
 *
 * A `held` delivery:pr ship job keeps its worker alive for repairs, and at the
 * spawn cap that blocks every new job. `makeRoom` stops exactly one **live,
 * idle, not-stopping** held author (oldest `reported_at`) and reserves the slot
 * it freed for the caller. Phase, lease and branch are untouched; the next
 * `cp_send` to the released job relaunches it on its own session (Sender).
 *
 * Invariants (docs/contracts.md "Release on demand"):
 *  - live workers + outstanding reservations <= the non-reviewer cap;
 *  - only `makeRoom` reserves; ownership passes to the caller only after the
 *    victim's shutdown succeeded, otherwise the reservation is released here;
 *  - from selection through the call to `shutdown`, nothing awaits, so no other
 *    task can make the victim busy or pick the same victim (`stopping` excludes it).
 */

import type { FleetRecord, IntegrationRecord, Role } from "./contracts.ts";
import { isScriptFleetRecord } from "./contracts.ts";
import { readEventLog } from "./run-artifacts.ts";
import { SpawnSafetyError, type WorkerManager } from "./worker-manager.ts";

export interface HeldReleaseOptions {
	home: string;
	fleet: { list(): FleetRecord[] };
	manager: Pick<WorkerManager, "get" | "active" | "reserved" | "spawnCap" | "reserve" | "reap" | "shutdown" | "stopping">;
	/** In-flight work on a job: a promote (Integrator), a send (Sender), a continuation drive (HeldContinuation). */
	busy: { sending(id: string): boolean; promoting(id: string): boolean; driving(id: string): boolean };
	integration: (id: string) => IntegrationRecord | undefined;
	/** Synchronous run-log append (`runs.open(id).cp`). */
	journal: (jobId: string, kind: "held_released", payload: Record<string, unknown>) => void;
}

/** The last of these in a run log decides whether the job's process was released. */
const LIFECYCLE = new Set(["spawned", "worker_revived", "held_released"]);

export class HeldRelease {
	readonly #options: HeldReleaseOptions;

	constructor(options: HeldReleaseOptions) {
		this.#options = options;
	}

	/** Held ship/pr authors whose live, idle process may be stopped, oldest `reported_at` first. */
	releasable(exclude?: string): string[] {
		const { fleet, manager, busy, integration } = this.#options;
		const out: { id: string; at: string }[] = [];
		for (const record of fleet.list()) {
			const id = record.job_id;
			if (id === exclude || record.phase !== "held" || record.kind !== "ship" || record.delivery !== "pr") continue;
			if (isScriptFleetRecord(record) || record.failure || record.reported_at === undefined) continue;
			const m = manager.get(id);
			if (!m || !m.worker.alive || m.worker.busy || manager.stopping(id)) continue;
			if (busy.promoting(id) || busy.sending(id) || busy.driving(id)) continue;
			const resolve = integration(id);
			if (resolve?.next === "resolve" && resolve.updated_at > record.reported_at) continue;
			out.push({ id, at: record.reported_at });
		}
		return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map((entry) => entry.id);
	}

	/** Could a non-reviewer spawn start now, counting releasable authors as free? */
	capacityFree(): boolean {
		const { manager } = this.#options;
		return manager.active.length + manager.reserved - this.releasable().length < manager.spawnCap;
	}

	/**
	 * At the cap, stop one releasable author and return the release for the slot
	 * reserved for `forJob`; `undefined` when nothing needed (or could) be done.
	 * The caller calls the release on failure; a successful spawn of `forJob` consumes it.
	 */
	async makeRoom(forJob: string, role: Role): Promise<(() => void) | undefined> {
		const manager = this.#options.manager;
		if (role === "gate-reviewer") return undefined;
		manager.reap();
		if (manager.active.length + manager.reserved < manager.spawnCap) return undefined;
		const victim = this.releasable(forJob)[0];
		if (victim === undefined) return undefined;
		// No await from here through the call to shutdown (its prefix marks the victim stopping).
		const release = manager.reserve(forJob);
		let transferred = false;
		try {
			if (!this.releasable(forJob).includes(victim)) {
				throw new SpawnSafetyError(`${victim} is no longer releasable; no slot freed for ${forJob}`, { code: "spawn_cap" });
			}
			this.#options.journal(victim, "held_released", { for_job: forJob, reason: "spawn cap" });
			await manager.shutdown(victim);
			transferred = true;
			return release;
		} finally {
			if (!transferred) release();
		}
	}

	/** True when the job's process was last stopped by a release (not since spawned or revived). */
	wasReleased(id: string): boolean {
		let last: string | undefined;
		try {
			for (const event of readEventLog(this.#options.home, id)) {
				if (event.source === "cp" && LIFECYCLE.has(event.type)) last = event.type;
			}
		} catch {
			return false;
		}
		return last === "held_released";
	}
}
