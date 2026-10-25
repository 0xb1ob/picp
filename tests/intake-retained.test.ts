/**
 * Envelope intake, retained: the unknown-id refusal has no entry point; the parent only intakes jobs it holds a
 * fleet record for. The rest is tests/e2e/intake-p9f.test.ts.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, type Delivery, EMPTY_USAGE, type FleetRecord, isoTimestamp, type JobKind } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, type IntakeResult } from "../src/intake.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, type ScratchHome } from "./harness/index.ts";

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	reported: IntakeResult[];
	/** Cleanups run in registration order, always before the home is removed. */
	onCleanup(fn: () => void | Promise<void>): void;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }, viewer: { host?: string; port?: number } = { host: "127.0.0.1", port: 9876 }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const reported: IntakeResult[] = [];
	const intake = new EnvelopeIntake({
		home: home.path,
		viewerHost: viewer.host,
		viewerPort: viewer.port,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onReported: (result) => reported.push(result),
	});
	const cleanups: Array<() => void | Promise<void>> = [];
	t.after(async () => {
		for (const fn of cleanups) await fn();
		home.cleanup();
	});
	return { home, fleet, runs, intake, reported, onCleanup: (fn) => cleanups.push(fn) };
}

async function addJob(
	b: Bench,
	jobId: string,
	options: { kind?: JobKind; delivery?: Delivery; worktree?: string } = {},
): Promise<FleetRecord> {
	const record: FleetRecord = {
		job_id: jobId,
		project: "demo",
		kind: options.kind ?? "ship",
		delivery: options.delivery ?? "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(b.home.path, "s.jsonl"),
			profile: options.kind === "research" ? "planner" : "implementer",
			role: options.kind === "research" ? "planner" : "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: options.worktree ?? join(b.home.path, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	return b.fleet.add(record);
}

test("nothing on disk yet is not an error", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-quiet", { delivery: "pr" });
	const result = await b.intake.intake("cp-quiet");
	assert.deepEqual(result, { job_id: "cp-quiet", accepted: false, already: false, phase: "waiting" });
	await assert.rejects(() => b.intake.intake("cp-unknown"), /no fleet record/);
});
