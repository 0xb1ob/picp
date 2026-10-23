import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, LAYOUT, SCHEMA_VERSION, isoTimestamp, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, MockProvider, createAgentDir, createScratchHome, readFleet, startRpc, waitFor } from "../harness/index.ts";

const DEAD = 2 ** 22;
const invalid = ["", "not json", "[]", "null", "{}", '{"pid":7}', '{"pid":"nope","started_at":"2026-09-02T00:00:00Z","home":"/x"}',
	'{"pid":0,"started_at":"2026-09-02T00:00:00Z","home":"/x"}', '{"pid":7,"started_at":"nope","home":"/x"}',
	'{"pid":7,"started_at":"2026-09-02T00:00:00Z","home":""}'];

test("S27 lock: malformed legacy locks refuse startup without reconciling or rewriting evidence", { timeout: 90_000 }, async (t) => {
	for (const raw of invalid) {
		const home = createScratchHome();
		const agent = createAgentDir();
		mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
		const lock = join(home.path, LAYOUT.state, "parent.lock");
		writeFileSync(lock, raw);
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
		t.after(async () => { await rpc.close(); agent.cleanup(); home.cleanup(); });
		const notification = await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("parent lock"), 15_000);
		assert.match(String(notification.message), /refus/);
		assert.equal(readFileSync(lock, "utf8"), raw);
		rpc.endInput();
		await rpc.close();
		assert.equal(readFileSync(lock, "utf8"), raw);
		agent.cleanup(); home.cleanup();
	}
});

for (const live of [true, false]) {
	test(live ? "S27 lock: a live holder fences mutations and startup leaves the fleet untouched" : "S27 lock: a stale holder is reclaimed, reconciled and released on shutdown", { timeout: 90_000 }, async (t) => {
		const home = createScratchHome();
		const provider = await MockProvider.start();
		const model = provider.addScript("s27-lock", [{ kind: "tool_calls", calls: [
			{ name: "cp_dispatch", args: { project: "demo", job_id: "cp-new", task: "Check the lock" } },
			{ name: "cp_check", args: { project: "demo", job_id: "cp-new" } },
		] }, { kind: "text", text: "Lock observed." }]);
		const agent = createAgentDir({ provider });
		const store = new FleetStore({ home: home.path });
		await store.add({ job_id: "cp-old", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "waiting",
			worktree: join(home.path, "wt"), branch: "cp-old", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: DEAD, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
		} as FleetRecord);
		const fleet = join(home.path, LAYOUT.fleetFile);
		const before = readFileSync(fleet, "utf8");
		const mtime = statSync(fleet).mtimeMs;
		const lock = join(home.path, LAYOUT.state, "parent.lock");
		writeFileSync(lock, JSON.stringify({ schema_version: SCHEMA_VERSION, pid: live ? process.pid : DEAD, home: home.path, started_at: "2026-09-02T00:00:00Z" }));
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session", "--model", model] });
		t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
		const notice = await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes(live ? "parent lock" : "reclaimed from pid"), 30_000);
		if (live) {
			assert.match(String(notice.message), new RegExp(`pid ${process.pid}`));
			rpc.send({ type: "prompt", id: "mutate", message: "Attempt dispatch and then inspect." });
			await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
			const results = rpc.records().filter((r) => r.type === "tool_execution_end");
			const dispatch = results.filter((r) => r.toolName === "cp_dispatch");
			assert.equal(dispatch.length, 1);
			assert.match(JSON.stringify(dispatch[0]), /needs this home's parent lock/);
			assert.match(JSON.stringify(dispatch[0]), new RegExp(`pid ${process.pid} holds it`));
			assert.match(JSON.stringify(dispatch[0]), /One parent per home is a contract/);
			assert.equal(results.filter((r) => r.toolName === "cp_check").length, 1);
			assert.equal(readFileSync(fleet, "utf8"), before);
			assert.equal(statSync(fleet).mtimeMs, mtime);
			assert.equal(readFleet(home.path).jobs[0]?.phase, "waiting");
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
			assert.equal(provider.remaining("s27-lock"), 0);
			rpc.endInput();
			await rpc.close();
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
		} else {
			const job = await waitFor(() => readFleet(home.path).jobs[0], (job) => job?.phase === "failed", { what: "stale worker reconciliation" });
			assert.equal(job?.failure?.class, "crash");
			const holder = JSON.parse(readFileSync(lock, "utf8"));
			assert.notEqual(holder.pid, DEAD);
			assert.equal(holder.home, home.path);
			assert.equal(holder.schema_version, SCHEMA_VERSION);
			rpc.send({ type: "new_session", id: "new-session" });
			await rpc.waitFor((r) => r.type === "response" && r.id === "new-session", 15_000);
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, holder.pid);
			assert.equal(rpc.records().filter((r) => r.type === "extension_ui_request" && String(r.message).includes("parent lock: refused")).length, 0);
			rpc.endInput();
			await waitFor(() => existsSync(lock), (exists) => !exists, { what: "lock release on shutdown" });
		}
	});
}

test("S27 lock: an unwritable home refuses acquisition visibly", { timeout: 60_000, skip: process.getuid?.() === 0 }, async (t) => {
	const home = createScratchHome();
	const agent = createAgentDir();
	const state = join(home.path, LAYOUT.state);
	mkdirSync(state, { recursive: true });
	chmodSync(state, 0o500);
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
	t.after(async () => { await rpc.close(); chmodSync(state, 0o700); agent.cleanup(); home.cleanup(); });
	const notice = await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("parent lock"), 30_000);
	assert.match(String(notice.message), /refused.*cannot take the parent lock/);
	assert.equal(existsSync(join(state, "parent.lock")), false);
});
