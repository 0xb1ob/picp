/** Native routing S2: the parent-side subscriber that writes the availability snapshot from native worker events. */
import { OBSERVATION_EVENT } from "./drivers/claude-observation.ts";
import { recordNativeObservation } from "./native-availability.ts";
import type { WorkerDriverHandle } from "./worker-driver.ts";

/** Subscribes a freshly spawned native worker (dispatch or revive); a pi worker is returned untouched. */
export function observeNative<T extends { driver?: string; jobId: string; worker: Pick<WorkerDriverHandle, "onEvent"> }>(home: string, managed: T): T {
	if (!managed.driver) return managed;
	managed.worker.onEvent((event) => {
		if (event.type !== OBSERVATION_EVENT) return;
		try {
			recordNativeObservation(home, event);
		} catch (error) {
			// The event itself is in the run log; only the snapshot write failed, and the next observation retries it.
			process.stderr.write(`[native availability] ${managed.jobId}: the snapshot was not written (${(error as Error).message})\n`);
		}
	});
	return managed;
}
