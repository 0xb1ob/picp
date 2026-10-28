import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, REPO_ROOT, startPiChild } from "../harness/index.ts";
import { drainFile } from "../../src/drain.ts";
import { CommandPost } from "../../src/command-post.ts";
import { readDrain, restartNotice } from "../../src/drain.ts";
import { readFileSync } from "node:fs";
import { waitFor } from "../harness/index.ts";
import { JOB, seedHeldHome } from "../harness/held-home.ts";
import { RunRegistry } from "../../src/runs.ts";
import { join } from "node:path";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { UPDATE_HOLD_MAX_MS } from "../../src/update-hold.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { createScratchHome, createScratchLedger } from "../harness/index.ts";

const calls = [
	{ name: "cp_next", args: {} },
	{ name: "cp_dispatch", args: { job_id: "cp-any", task: "work" } },
	{ name: "cp_integrate", args: { job_id: JOB } },
	{ name: "cp_review", args: { job_id: JOB } },
	{ name: "cp_gate", args: { job_id: JOB } },
	{ name: "cp_send", args: { job_id: JOB, message: "Repair the held PR", purpose: "repair" } },
];

test("S26: real tools refuse starts while drain state exists or is malformed", { timeout: 90_000 }, async (t) => {
	for (const call of [...calls, { name: "cp_dispatch", args: { job_id: "cp-any", task: "malformed" } }]) {
		await t.test(`${call.name} ${"task" in call.args ? call.args.task : ""}`, async () => {
			const s = await seedHeldHome({ ciState: "in_progress" });
			if (call.name === "cp_send") new RunRegistry(s.home.path).open(JOB).cp("held_released", { for_job: "cp-next", reason: "spawn cap" });
			const provider = await MockProvider.start();
			const agent = createAgentDir({ provider });
			const model = provider.addScript("s26-gate", [{ kind: "tool_calls", calls: [call] }, { kind: "text", text: "gate checked" }], { onExhausted: "repeat" });
			agent.writeModels(provider);
			const child = startPiChild({ cwd: s.home.path, model, env: { ...agent.env, CP_HOME: s.home.path, PATH: `${s.bin}:${process.env.PATH}` }, extensions: [COMMAND_POST_EXTENSION] });
			try {
				await child.prompt("/cp-drain 30");
				await child.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000);
				const malformed = "task" in call.args && call.args.task === "malformed";
				if (malformed) writeFileSync(drainFile(s.home.path), "{broken");
				await child.prompt(`Check ${call.name}.`);
				const result = await child.waitFor((r) => r.type === "tool_execution_end" && r.toolName === call.name, 20_000);
				assert.match(JSON.stringify(result.result), malformed ? /not a drain record/ : /draining/, call.name);
			} finally { await child.close(); agent.cleanup(); await provider.stop(); s.repo.cleanup(); s.home.cleanup(); }
		});
	}
});


test("S26: a real integrate step stays tracked through timeout and releases after its forge response", { timeout: 60_000 }, async (t) => {
	const s = await seedHeldHome({ ciState: "in_progress", review: "none" });
	const previous = process.env.PATH;
	process.env.PATH = `${s.bin}:${previous}`;
	const post = new CommandPost({ home: s.home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	writeFileSync(`${s.headFile}.delay`, "6000");
	const integration = post.integrate({ jobId: JOB });
	t.after(async () => { await integration.catch(() => undefined); await post.shutdown(); process.env.PATH = previous; s.repo.cleanup(); s.home.cleanup(); });
	await waitFor(() => readFileSync(s.ghLog, "utf8"), (text) => text.includes("pr view"), { what: "real forge request enters delayed response" });
	assert.match(restartNotice(s.home.path, () => post.fleet.list()), /not drained; this kills 1 live worker/);
	assert.equal(post.drain.start(2).state, "draining");
	assert.equal(post.drain.check()?.state, "draining", "nothing is reported inside the deadline");
	assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":timeout")).length, 0);
	await waitFor(() => post.drain.check()?.state, (state) => state === "timeout", { timeoutMs: 5000, what: "real drain deadline while forge remains busy" });
	post.drain.check();
	assert.equal(post.durableWakeups.pending().filter((entry) => entry.id.endsWith(":timeout")).length, 1);
	assert.deepEqual(readDrain(s.home.path)?.survivors, ["1 merge step(s)"]);
	assert.match(restartNotice(s.home.path, () => post.fleet.list()), /timed out.*this kills 1 live worker/);
	const result = await integration;
	assert.ok(result.next);
	assert.equal(post.drain.mergeSteps, 0, "the public integrate step releases its drain hold");
});


test("S26: held continuation refuses a persisted or malformed drain and reopens the same event after removal", { timeout: 60_000 }, async (t) => {
	const s = await seedHeldHome({ ciState: "in_progress", review: "none" });
	const previous = process.env.PATH;
	process.env.PATH = `${s.bin}:${previous}`;
	const post = new CommandPost({ home: s.home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, continuation: true });
	t.after(async () => { await post.shutdown(); process.env.PATH = previous; s.repo.cleanup(); s.home.cleanup(); });
	post.drain.start();
	const event = { jobId: JOB, event: "startup" as const };
	assert.equal((await post.continuation.trigger(event)).action, "draining");
	writeFileSync(drainFile(s.home.path), "{broken");
	assert.equal((await post.continuation.trigger(event)).action, "draining");
	const { rmSync } = await import("node:fs");
	rmSync(drainFile(s.home.path));
	const reopened = await post.continuation.trigger(event);
	assert.equal(reopened.action, "wait", reopened.reason);
	assert.equal(reopened.steps, 1, "the same event advances an actual integration step after drain removal");
	assert.match(readFileSync(s.ghLog, "utf8"), /pr view/);
});

test("S26: an update waiting on mid-turn workers holds fresh dispatch, not sends, and lapses after its bound", { timeout: 90_000 }, async () => {
	// Issue 396: while the updater skipped busy, dispatch kept refilling the fleet and the update never applied.
	const s = await seedHeldHome({ ciState: "in_progress" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const dispatch = { name: "cp_dispatch", args: { job_id: JOB, task: "work" } };
	const send = { name: "cp_send", args: { job_id: JOB, message: "Repair the held PR", purpose: "repair" } };
	const tool = (call: typeof dispatch | typeof send) => ({ kind: "tool_calls" as const, calls: [call] });
	const done = { kind: "text" as const, text: "checked" };
	const model = provider.addScript("s26-update-hold", [tool(dispatch), tool(send), done], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const to = "ab".repeat(20);
	const pending = (ageMs: number) => writeFileSync(join(s.home.path, LAYOUT.state, "update.json"), JSON.stringify({ schema_version: 1, phase: "idle", fetch_failures: 0, last_result: "skipped_busy", to, busy_since: new Date(Date.now() - ageMs).toISOString() }));
	writeFileSync(join(s.home.path, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true }));
	pending(60_000);
	const held = new RegExp(`auto-update to ${to.slice(0, 12)} waits for mid-turn workers`);
	const child = startPiChild({ cwd: s.home.path, model, env: { ...agent.env, CP_HOME: s.home.path, PATH: `${s.bin}:${process.env.PATH}` }, extensions: [COMMAND_POST_EXTENSION] });
	try {
		const ends = (name: string) => child.eventsOfType("tool_execution_end").filter((r) => r.toolName === name).map((r) => JSON.stringify(r.result));
		await child.prompt("Check the gates.");
		await child.waitFor(() => ends("cp_send").length > 0, 20_000);
		assert.match(ends("cp_dispatch")[0] ?? "", held, "a fresh dispatch is refused, naming the update");
		assert.match(ends("cp_send")[0] ?? "", /cp-held has no live worker in this session/, "a send passes the hold and reaches its worker lookup");
	} finally { await child.close(); agent.cleanup(); await provider.stop(); }
	// Past the bound the hold lapses: the same dispatch passes both gates and reaches the ledger lookup.
	pending(UPDATE_HOLD_MAX_MS + 60_000);
	const post = new CommandPost({ home: s.home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	try {
		const lapsed = await post.dispatch({ jobId: JOB, task: "work" }).then((result) => JSON.stringify(result), (error: Error) => error.message);
		assert.match(lapsed, /cp-held: no such job/, "past the bound the hold lapses");
	} finally { await post.shutdown(); s.repo.cleanup(); s.home.cleanup(); }
});

/** Turn the update hold on (auto-update enabled, the updater skipped busy a minute ago) for `home`. */
function holdUpdate(home: string): void {
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	writeFileSync(join(home, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true }));
	writeFileSync(join(home, LAYOUT.state, "update.json"), JSON.stringify({ schema_version: 1, phase: "idle", fetch_failures: 0, last_result: "skipped_busy", to: "cd".repeat(20), busy_since: new Date(Date.now() - 60_000).toISOString() }));
}

test("S26: queued and armed dispatches made before the update hold survive a slot freeing under it", { timeout: 60_000 }, async (t) => {
	// Review 1 of PR 667: the hold's refusal reached the queue and armed pumps as an unknown error, and each entry was
	// dropped for good with a DROPPED wake-up. Both entries must stay, untouched, until the hold clears.
	const home = createScratchHome();
	const { ledger } = createScratchLedger({ home: home.path });
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(async () => { await post.shutdown(); home.cleanup(); });
	const queued = await ledger.create({ title: "queued work", project: "demo", kind: "ship", delivery: "pr" });
	const armed = await ledger.create({ title: "armed work", project: "demo", kind: "ship", delivery: "pr" });
	post.dispatchQueue.enqueue(queued.id, { task: "queued" });
	post.armedDispatches.arm(armed.id, { task: "armed" }, ["cp-landed"]);
	holdUpdate(home.path);
	await post.dispatchQueue.drain();
	await post.armedDispatches.release();
	assert.deepEqual([post.dispatchQueue.ids(), post.armedDispatches.ids()], [[queued.id], [armed.id]], "both entries kept");
	const wakes = post.durableWakeups.pending().map((entry) => entry.content).join("\n");
	assert.doesNotMatch(wakes, /DROPPED|DRAIN FAILED/, "no drop and no failed drain journalled");
	assert.equal(post.fleet.get(queued.id) ?? post.fleet.get(armed.id), undefined, "nothing was dispatched");
});

test("S26: a pipeline advance under the update hold defers the implementer dispatch and never records a failure", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const { ledger } = createScratchLedger({ home: home.path });
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(async () => { await post.shutdown(); home.cleanup(); });
	const research = await ledger.create({ title: "plan it", project: "demo", kind: "research", delivery: "pipeline" });
	const ship = await ledger.create({ title: "ship it", project: "demo", kind: "ship", delivery: "pr" });
	const at = "2026-09-04T18:00:00Z";
	// The planner reported and was torn down, its plan passed the gate and the checkpoint is approved: step 6 is next.
	await post.fleet.add({ job_id: research.id, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN, phase: "done", reported_at: at,
		worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "planner", role: "planner", model: "mock/test", started_at: at },
		worktree: `/wt/${research.id}`, branch: research.id, dispatched_at: at, usage: EMPTY_USAGE });
	writeFileSync(post.artifacts.path(research.id), "# plan\n");
	atomicWriteJson(join(home.path, paths.gateFile(research.id, 1)), { schema_version: SCHEMA_VERSION, job_id: research.id, attempt: 1, verdict: "pass", cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["sound"], decided_at: at });
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: ship.id, researchId: research.id, question: `Authorize implementation of ${ship.id}?` });
	checkpoints.decide(ship.id, true, { by: "operator command" });
	post.pipelines.write({ schema_version: SCHEMA_VERSION, research_id: research.id, ship_id: ship.id, project: "demo", delivery: "pr", state: "awaiting_authorization", created_at: at, updated_at: at });
	holdUpdate(home.path);
	for (let i = 0; i < 2; i++) {
		const step = await post.advancePipeline(research.id);
		assert.deepEqual([step.state, step.next], ["awaiting_authorization", "wait"], step.message);
		assert.match(step.message, /implementer dispatch deferred, not failed — refused: an auto-update to cdcdcdcdcdcd/);
	}
	assert.equal(post.pipelines.get(research.id)?.state, "awaiting_authorization", "the step stays retryable");
	assert.equal(post.fleet.get(ship.id), undefined, "nothing was dispatched or failed");
});
