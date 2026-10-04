/**
 * cp-itl4 4b-2 (4B2-T2): the cp_dispatch tool boundary — a spawn_cap refusal queues,
 * a queued job is never dispatched again, and queue:false, other errors and script
 * jobs keep the plain refusal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registerDispatchTools } from "../extensions/command-post/tools-dispatch.ts";
import { type Job, LAYOUT } from "../src/contracts.ts";
import { DispatchQueue } from "../src/dispatch-queue.ts";
import { MandateError } from "../src/mandate-accounting.ts";
import { SpawnSafetyError } from "../src/worker-manager.ts";
import { createScratchHome } from "./harness/index.ts";

type Tool = { parameters: { properties: Record<string, unknown> }; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };

function toolBench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const state = { error: new SpawnSafetyError("spawn cap reached (2/2 workers)", { code: "spawn_cap" }) as Error, script: false, calls: [] as string[] };
	const ledger = { show: async (id: string) => ({ id, status: "open", ...(state.script ? { script: "scripts/run.sh" } : {}) }) as unknown as Job };
	const dispatchQueue = new DispatchQueue({
		home: home.path, owns: () => false, capacityFree: () => false, dispatch: async () => ({ state: "dispatched" }),
		ledger: () => ledger, fleet: { get: () => undefined }, journal: () => {},
	});
	const post = {
		home: home.path, registry: undefined, ledger: () => ledger, dispatchQueue,
		dispatch: async (request: { jobId: string }) => {
			state.calls.push(request.jobId);
			throw state.error;
		},
	};
	const tools = new Map<string, Tool>();
	registerDispatchTools({ registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool) } as never, {
		commandPost: () => post, setLive: () => {}, refreshWidget: () => {}, askQuestion: async () => ({}),
	} as never);
	const tool = tools.get("cp_dispatch")!;
	const call = (params: Record<string, unknown>) => tool.execute("c", params, undefined, undefined, { hasUI: false, modelRegistry: undefined });
	return { tool, call, state, dispatchQueue, file: join(home.path, LAYOUT.dispatchQueueFile) };
}

test("4B2-T2: spawn_cap queues with a position; a re-dispatch is refused untouched; queue:false, other errors and scripts rethrow", async (t) => {
	const b = toolBench(t);
	assert.ok("queue" in b.tool.parameters.properties, "the schema has queue");

	assert.deepEqual((await b.call({ job_id: "cp-aaa1", task: "one" })).details, { state: "queued", position: 1, job_id: "cp-aaa1" });
	assert.deepEqual((await b.call({ job_id: "cp-aaa2", task: "two", wall_clock_seconds: 60 })).details, { state: "queued", position: 2, job_id: "cp-aaa2" });
	assert.deepEqual(b.dispatchQueue.ids(), ["cp-aaa1", "cp-aaa2"]);
	assert.deepEqual(JSON.parse(readFileSync(b.file, "utf8")).entries[1].request, { task: "two", wall_clock_seconds: 60 }, "only the request params persist");

	const before = readFileSync(b.file, "utf8");
	const calls = b.state.calls.length;
	await assert.rejects(b.call({ job_id: "cp-aaa1", task: "again" }), /already queued at position 1/);
	assert.equal(b.state.calls.length, calls, "no dispatch call");
	assert.equal(readFileSync(b.file, "utf8"), before, "the file is byte-identical");

	await assert.rejects(b.call({ job_id: "cp-aaa3", queue: false }), (error: unknown) => error instanceof SpawnSafetyError);
	b.state.error = new MandateError("dispatch-parallelism 1 is full", { code: "parallelism_full" });
	await assert.rejects(b.call({ job_id: "cp-aaa4" }), (error: unknown) => error instanceof MandateError);
	b.state.error = new SpawnSafetyError("spawn cap reached (2/2 workers)", { code: "spawn_cap" });
	b.state.script = true;
	await assert.rejects(b.call({ job_id: "cp-aaa5" }), /spawn cap reached/);
	assert.deepEqual(b.dispatchQueue.ids(), ["cp-aaa1", "cp-aaa2"], "none of those was queued");
	assert.equal(readFileSync(b.file, "utf8"), before);
});
