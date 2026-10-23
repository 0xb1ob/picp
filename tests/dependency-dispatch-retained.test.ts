import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ARMED_DISPATCH_MAX, type FleetRecord, type Job, LAYOUT } from "../src/contracts.ts";
import { ArmedDispatches } from "../src/dependency-dispatch.ts";
import { BlockedDispatchError } from "../src/dispatch.ts";
import { drainFile } from "../src/drain.ts";
import { MandateError } from "../src/mandate-accounting.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome } from "./harness/index.ts";

type Port = (request: { jobId: string; task?: string }) => Promise<{ state: string }>;

function armedBench(t: { after(fn: () => void): void }, options: { dispatch?: Port; owns?: () => boolean; jobs?: Record<string, Partial<Job>>; fleet?: string[]; pipeline?: string[] } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const calls: { jobId: string; task?: string }[] = [];
	const wakes: DurableWakeupInput[] = [];
	const blockers = new Map<string, string[]>();
	const queued: string[] = [];
	const armed = new ArmedDispatches({
		home: home.path,
		dispatch: async (request) => {
			calls.push({ jobId: request.jobId, ...(request.task === undefined ? {} : { task: request.task }) });
			return options.dispatch ? options.dispatch(request) : { state: "dispatched" };
		},
		enqueue: (id) => queued.push(id),
		owns: options.owns ?? (() => true),
		ledger: () => ({ show: async (id: string) => ({ id, status: "open", ...options.jobs?.[id] }) as Job, blockersOf: async (id: string) => blockers.get(id) ?? [] }),
		fleet: { get: (id: string) => (options.fleet?.includes(id) ? ({ job_id: id } as FleetRecord) : undefined) },
		pipelineOwned: (id) => options.pipeline?.includes(id) ?? false,
		journal: (wake) => void wakes.push(wake),
		now: () => new Date("2026-10-04T15:00:00Z"),
	});
	const file = join(home.path, LAYOUT.armedDispatchFile);
	return { home: home.path, armed, calls, wakes, blockers, queued, file, bytes: () => readFileSync(file, "utf8") };
}

test("arm persists the request; re-arm replaces it; a pipeline job, a drain and the cap refuse; disarm is idempotent", async (t) => {
	const b = armedBench(t, { pipeline: ["cp-pipe"] });
	assert.deepEqual(b.armed.ids(), [], "an absent file reads as empty");
	assert.deepEqual(b.armed.arm("cp-dep1", { task: "one" }, ["cp-base"]), { rearmed: false });
	assert.deepEqual(b.armed.arm("cp-dep1", { task: "newer" }, ["cp-base"]), { rearmed: true });
	assert.deepEqual(JSON.parse(b.bytes()).entries, [{ job_id: "cp-dep1", request: { task: "newer" }, armed_at: "2026-10-04T15:00:00Z", blockers: ["cp-base"] }]);
	assert.throws(() => b.armed.arm("cp-pipe", {}, ["cp-x"]), /belongs to a pipeline/);
	assert.throws(() => b.armed.arm("cp-bad", { scope: "XL" } as never, ["cp-x"]), /refusing to write an invalid/);
	for (let n = 2; n <= ARMED_DISPATCH_MAX; n++) b.armed.arm(`cp-dep${n}`, {}, ["cp-base"]);
	assert.throws(() => b.armed.arm("cp-full", {}, ["cp-base"]), /32 dispatches are already armed/);
	b.armed.arm("cp-dep2", { task: "re-arm at the cap" }, ["cp-base"]);
	b.armed.disarm("cp-dep2");
	b.armed.disarm("cp-dep2");
	assert.equal(b.armed.ids().length, ARMED_DISPATCH_MAX - 1);
	mkdirSync(dirname(drainFile(b.home)), { recursive: true });
	writeFileSync(drainFile(b.home), JSON.stringify({ state: "draining", started_at: "2026-10-04T15:00:00Z", deadline: "x", timeout_s: 1, jobs: [] }));
	assert.throws(() => b.armed.arm("cp-late", {}, ["cp-base"]), /drain/i);
	await b.armed.release();
	assert.deepEqual(b.calls, [], "nothing is released during a drain");
});


test("spawn_cap queues; parallelism_full and a reopened blocker keep; other refusals, promote and stale entries drop with a wake-up", async (t) => {
	const b = armedBench(t, {
		dispatch: async (request) => {
			if (request.jobId === "cp-cap") throw new SpawnSafetyError("spawn cap reached (2/2 workers)", { code: "spawn_cap" });
			if (request.jobId === "cp-par") throw new MandateError("dispatch-parallelism 1 is full", { code: "parallelism_full" });
			if (request.jobId === "cp-reblock") throw new BlockedDispatchError("cp-reblock is blocked by cp-new", ["cp-new"]);
			if (request.jobId === "cp-risk") throw new Error("risk:high needs authorization\nsecond line");
			if (request.jobId === "cp-live") return { state: "promote" };
			return { state: "dispatched" };
		},
		jobs: { "cp-closed": { status: "closed", close_reason: "dropped: superseded" }, "cp-script": { script: { path: "scripts/run.sh" } } as Partial<Job> },
		fleet: ["cp-fleet"],
	});
	const ids = ["cp-cap", "cp-par", "cp-reblock", "cp-risk", "cp-live", "cp-closed", "cp-script", "cp-fleet"];
	for (const id of ids) b.armed.arm(id, {}, ["cp-base"]);
	await b.armed.release();
	assert.deepEqual(b.calls.map((call) => call.jobId), ["cp-cap", "cp-par", "cp-reblock", "cp-risk", "cp-live"], "stale entries drop before any dispatch");
	assert.deepEqual(b.queued, ["cp-cap"]);
	assert.deepEqual(b.armed.ids(), ["cp-par", "cp-reblock"], "kept entries stay armed");
	const text = b.wakes.map((wake) => wake.content).join("\n");
	assert.match(text, /ARMED DISPATCH QUEUED — cp-cap \(position 1\)/);
	assert.match(text, /DROPPED: risk:high needs authorization — cp-risk/);
	assert.doesNotMatch(text, /second line/);
	assert.match(text, /DROPPED: the job already has a live worker .* cp-live/);
	assert.match(text, /DROPPED: the job is closed \(dropped: superseded\) — cp-closed/);
	assert.match(text, /DROPPED: script jobs are never armed — cp-script/);
	assert.match(text, /DROPPED: the job is already in the fleet — cp-fleet/);
	assert.equal(b.wakes.length, 6);
	assert.equal(new Set(b.wakes.map((wake) => wake.id)).size, 6, "one durable id per outcome");
});
