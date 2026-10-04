/**
 * unload-parent PR2: dependency-landed dispatch — arm/disarm and their refusals, a release
 * that waits for every blocker, re-gates through dispatch, hands spawn_cap to the queue,
 * keeps parallelism_full and a reopened blocker, drops stale entries with one wake-up, and
 * never runs for a non-owner or during a drain. Plus the cp_dispatch tool boundary.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerDispatchTools } from "../extensions/command-post/tools-dispatch.ts";
import { ARMED_DISPATCH_MAX, type FleetRecord, type Job, LAYOUT } from "../src/contracts.ts";
import { ArmedDispatches } from "../src/dependency-dispatch.ts";
import { BlockedDispatchError } from "../src/dispatch.ts";
import { DispatchQueue } from "../src/dispatch-queue.ts";
import { drainFile } from "../src/drain.ts";
import { MandateError } from "../src/mandate-accounting.ts";
import type { DurableWakeupInput } from "../src/wakeup-outbox.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { CommandPost } from "../src/command-post.ts";
import { acquireParentLock, releaseParentLock } from "../src/parent-lock.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

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

test("release waits for every blocker, then dispatches the armed request through the gates exactly once", async (t) => {
	const b = armedBench(t);
	b.armed.arm("cp-dep1", { task: "build it" }, ["cp-base", "cp-other"]);
	b.blockers.set("cp-dep1", ["cp-other"]);
	await b.armed.release();
	assert.equal(b.calls.length, 0, "one blocker landed, one still open: kept");
	assert.equal(b.wakes.length, 0, "an entry still waiting is silent");
	b.blockers.delete("cp-dep1");
	await Promise.all([b.armed.release(), b.armed.release()]);
	assert.deepEqual(b.calls, [{ jobId: "cp-dep1", task: "build it" }], "two concurrent releases dispatch it once");
	assert.deepEqual(b.armed.ids(), []);
	assert.equal(b.wakes.length, 1);
	assert.match(b.wakes[0]!.content, /ARMED DISPATCH STARTED — cp-dep1 \(dispatched\)/);
	assert.equal(b.wakes[0]!.job_id, "cp-dep1");
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

test("only the lock owner releases, re-read per entry; a corrupt file wakes the parent instead of throwing", async (t) => {
	let owner = false;
	const b = armedBench(t, { owns: () => owner, dispatch: async () => ((owner = false), { state: "dispatched" }) });
	b.armed.arm("cp-a", {}, ["cp-base"]);
	b.armed.arm("cp-b", {}, ["cp-base"]);
	await b.armed.release();
	assert.equal(b.calls.length, 0, "a non-owner never dispatches");
	owner = true;
	await b.armed.release();
	assert.deepEqual(b.calls.map((call) => call.jobId), ["cp-a"], "the lock lost mid-release stops before the next entry");
	assert.deepEqual(b.armed.ids(), ["cp-b"]);

	owner = true;
	writeFileSync(b.file, "{ not json");
	await b.armed.release();
	assert.match(b.wakes.at(-1)!.content, /ARMED DISPATCH RELEASE FAILED — refusing to read an unparseable/);
	assert.throws(() => b.armed.arm("cp-c", {}, ["cp-base"]), /unparseable/, "never silently overwritten");
});

test("CommandPost wiring: the real lock owner releases an armed job through its own dispatch; a non-owner releases nothing", async (t) => {
	for (const owner of [true, false]) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const lock = owner ? acquireParentLock({ home: home.path }) : acquireParentLock({ home: home.path, pid: 999_999, isPidAlive: () => true });
		assert.equal(lock.ok, true);
		t.after(() => void releaseParentLock(owner ? { home: home.path } : { home: home.path, pid: 999_999 }));
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		t.after(() => post.shutdown());
		const calls: string[] = [];
		// Instance overrides: ArmedDispatches calls `this.dispatch` / `this.ledger()` at release time.
		Object.assign(post, {
			ledger: () => ({ show: async (id: string) => ({ id, status: "open" }) as Job, blockersOf: async () => [] }),
			dispatch: async (request: { jobId: string }) => (calls.push(request.jobId), { state: "dispatched" }),
		});
		post.armedDispatches.arm("cp-dep1", { task: "one" }, ["cp-base"]);
		await post.armedDispatches.release();
		assert.deepEqual(calls, owner ? ["cp-dep1"] : []);
		assert.deepEqual(post.armedDispatches.ids(), owner ? [] : ["cp-dep1"]);
	}
});

type Tool = { parameters: { properties: Record<string, unknown> }; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };

test("cp_dispatch: a blocked refusal arms the request; when_ready:false, a pipeline job and other errors keep the refusal; a started dispatch disarms", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const state = { error: new BlockedDispatchError("cp-dep1 is blocked by cp-base — close the blocker", ["cp-base"]) as Error | undefined };
	const ledger = { show: async (id: string) => ({ id, status: "open" }) as Job, blockersOf: async () => [] };
	const fleet = { get: () => undefined };
	const dispatchQueue = new DispatchQueue({ home: home.path, owns: () => false, capacityFree: () => false, dispatch: async () => ({ state: "dispatched" }), ledger: () => ledger, fleet, journal: () => {} });
	const armedDispatches = new ArmedDispatches({ home: home.path, dispatch: async () => ({ state: "dispatched" }), enqueue: () => 1, owns: () => false, ledger: () => ledger, fleet, pipelineOwned: (id) => id === "cp-pipe", journal: () => {} });
	const post = {
		home: home.path, registry: undefined, ledger: () => ledger, dispatchQueue, armedDispatches,
		dispatch: async (request: { jobId: string }) => {
			if (state.error) throw state.error;
			return { state: "dispatched", job_id: request.jobId };
		},
	};
	const tools = new Map<string, Tool>();
	registerDispatchTools({ registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool) } as never, { commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, askQuestion: async () => ({}) } as never);
	const tool = tools.get("cp_dispatch")!;
	const call = (params: Record<string, unknown>) => tool.execute("c", params, undefined, undefined, { hasUI: false, modelRegistry: undefined });
	assert.ok("when_ready" in tool.parameters.properties);

	assert.deepEqual((await call({ job_id: "cp-dep1", task: "one", queue: true })).details, { state: "armed", job_id: "cp-dep1", blockers: ["cp-base"], rearmed: false });
	assert.deepEqual(armedDispatches.read().entries[0]!.request, { task: "one" }, "only the request params persist");
	assert.equal((await call({ job_id: "cp-dep1", task: "two" })).details.rearmed, true);
	await assert.rejects(call({ job_id: "cp-dep2", when_ready: false }), (error: unknown) => error instanceof BlockedDispatchError);
	await assert.rejects(call({ job_id: "cp-pipe" }), /blocked by cp-base .*not armed: cp-pipe belongs to a pipeline/);
	state.error = new Error("preflight refused");
	await assert.rejects(call({ job_id: "cp-dep3" }), /preflight refused/);
	assert.deepEqual(armedDispatches.ids(), ["cp-dep1"]);

	state.error = undefined;
	await call({ job_id: "cp-dep1" });
	assert.deepEqual(armedDispatches.ids(), [], "a dispatch that started supersedes the armed one");
});
