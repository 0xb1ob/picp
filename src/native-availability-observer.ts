/** Native routing S2 and C3: the parent-side subscriber that writes each driver's availability snapshot. */
import { OBSERVATION_EVENT } from "./drivers/claude-observation.ts";
import { recordCodexObservation, recordNativeObservation } from "./native-availability.ts";
import type { WorkerDriverHandle } from "./worker-driver.ts";

/** Subscribes a freshly spawned native worker (dispatch or revive); a pi worker is returned untouched. */
export function observeNative<T extends { driver?: string; jobId: string; worker: Pick<WorkerDriverHandle, "onEvent"> }>(home: string, managed: T): T {
	if (!managed.driver) return managed;
	const record = managed.driver === "codex" ? recordCodexObservation : recordNativeObservation;
	managed.worker.onEvent((event) => {
		if (event.type !== OBSERVATION_EVENT) return;
		try {
			record(home, event);
		} catch (error) {
			// The event itself is in the run log; only the snapshot write failed, and the next observation retries it.
			process.stderr.write(`[native availability] ${managed.jobId}: the snapshot was not written (${(error as Error).message})\n`);
		}
	});
	return managed;
}
