/**
 * Spawn capture: what a surface actually launched, argv included.
 *
 * The routing tests can prove a resolver returns the right model without ever
 * proving a worker was started with it — which is exactly the defect
 * cp-reviewer-routing fixed (the gate resolved an effort and spawned the
 * profile's). So the assertion has to be on the launch itself: this shadows
 * `spawn` on one manager instance, records the request and the argv the plan
 * produced, and delegates to the real thing.
 */

import type { ManagedWorker, SpawnRequest, WorkerManager } from "../../src/worker-manager.ts";

export interface CapturedSpawn {
	request: SpawnRequest;
	/** The argv `pi` was launched with (`plan.args`), including `--model`/`--thinking`. */
	args: string[];
}

/** Record every spawn this manager makes from now on. The array fills in order. */
export function captureSpawns(manager: WorkerManager): CapturedSpawn[] {
	const captured: CapturedSpawn[] = [];
	const real = manager.spawn.bind(manager);
	// Own property, shadowing the prototype method: no subclass, and no change to
	// production code to make it observable.
	(manager as { spawn: (request: SpawnRequest) => ManagedWorker }).spawn = (request: SpawnRequest) => {
		const managed = real(request);
		captured.push({ request, args: managed.plan.args });
		return managed;
	};
	return captured;
}

/** The value of `--flag` in an argv, or `undefined` when it is not there. */
export function argOf(args: readonly string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
}
