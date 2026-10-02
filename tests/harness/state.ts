/**
 * Readers and assertions over the only sanctioned read surfaces:
 * state/fleet.json, state/runs/<job-id>/events.jsonl, .../status.json.
 *
 * Tests read files, never internals — the same contract the operator has.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killParentHosts } from "./parent-hosts.ts";
import {
	type FleetFile,
	LAYOUT,
	type RunEvent,
	type RunStatus,
	paths,
	validateFleetFile,
	validateRunStatus,
} from "../../src/contracts.ts";

/** A throwaway command-post home (`state/`, `data/`, `projects/` live here). */
export interface ScratchHome {
	path: string;
	cleanup(): void;
}

export function createScratchHome(): ScratchHome {
	const path = mkdtempSync(join(tmpdir(), "cp-home-"));
	return {
		path,
		/**
		 * Never throws (cp-widget-test-hangs). node:test runs `t.after` hooks in
		 * registration order and stops at the first one that throws, so a failed
		 * `rm` here used to skip the hook that closes the pi child — leaving a live
		 * process holding the runner's event loop open forever, after every test in
		 * the file had already printed a tick. A scratch temp dir that outlives the
		 * run is litter; a wedged worker is an outage, so the litter wins.
		 *
		 * The retries are for the race that produced it: a child is still writing
		 * into the home while the tree is being removed.
		 */
		cleanup() {
			killParentHosts(path); // a detached host never outlives its home (testleak-44z)
			try {
				rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {
				// Swallowed by design. See above.
			}
		},
	};
}

export function readFleet(home: string): FleetFile {
	const raw = readFileSync(join(home, LAYOUT.fleetFile), "utf8");
	const result = validateFleetFile(JSON.parse(raw));
	if (!result.ok) {
		throw new Error(`fleet.json violates the contract:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}

export function readRunStatus(home: string, jobId: string): RunStatus {
	const raw = readFileSync(join(home, paths.statusFile(jobId)), "utf8");
	const result = validateRunStatus(JSON.parse(raw));
	if (!result.ok) {
		throw new Error(`status.json violates the contract:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}

export function readRunEvents(home: string, jobId: string): RunEvent[] {
	const raw = readFileSync(join(home, paths.eventsFile(jobId)), "utf8");
	const events: RunEvent[] = [];
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		events.push(JSON.parse(line) as RunEvent);
	}
	return events;
}

/**
 * Assert that `expected` appears as an ordered subsequence of the observed
 * types. Extra events in between are fine; order and presence are not.
 */
export function assertEventSequence(observed: readonly string[], expected: readonly string[]): void {
	let cursor = 0;
	for (const type of observed) {
		if (type === expected[cursor]) cursor += 1;
		if (cursor === expected.length) return;
	}
	assert.fail(
		`missing event subsequence\n  expected: ${expected.join(" -> ")}\n  matched ${cursor}/${
			expected.length
		}\n  observed: ${observed.join(", ")}`,
	);
}

/** Poll until `predicate` holds, or fail after `timeoutMs` (default 10 s) naming `what` and the last value. */
export async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 25;
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = read();
			last = value;
			if (predicate(value)) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	const detail = last !== undefined ? JSON.stringify(last) : `error: ${String(lastError)}`;
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.what ?? "condition"}; last = ${detail}`);
}
