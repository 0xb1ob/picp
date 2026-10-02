import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FLEET_MUTATING_TOOLS, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import { MandateStore } from "../src/mandate.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { trackersFile } from "../src/trackers/config.ts";
import { trackerSyncFile } from "../src/trackers/sync-store.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
type Hook = () => Promise<void>;

async function bench(t: import("node:test").TestContext, holdsLock = false) {
	const { registerTrackerTools } = await import("../extensions/command-post/tools-tracker.ts");
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://example.com/demo.git" });
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const tools = new Map<string, Tool>();
	const hooks = new Map<string, Hook>();
	registerTrackerTools({ registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool), on: (name: string, fn: Hook) => hooks.set(name, fn) } as never, {
		commandPost: () => ({ home: home.path, registry, ledger: () => scratch.ledger, mandates: new MandateStore(home.path), fleet: { read: () => ({ jobs: [] }) } }), setLive: () => {},
	} as never, () => holdsLock);
	const call = async (params: Record<string, unknown>) => (await tools.get("cp_tracker")!.execute("call", params, undefined, undefined, { modelRegistry: {} })).content[0]!.text;
	return { home: home.path, ledger: scratch.ledger, call, hooks };
}

test("cp_tracker list, connect and disconnect through the tool surface", async (t) => {
	const { home, ledger, call } = await bench(t);
	assert.match(await call({ action: "list" }), /no tracker connections.*cp_tracker connect/);
	await assert.rejects(call({ action: "connect", project: "demo", adapter: "beads" }), /cp_tracker connect needs endpoint/);
	await assert.rejects(call({ action: "connect", project: "demo", adapter: "github", endpoint: "o/r" }), /adapter not implemented \(B6\)/);
	await assert.rejects(call({ action: "connect", project: "demo", adapter: "beads", endpoint: join(home, "missing.db") }), /br would create one; refusing/);
	// A connection on disk (the real probe needs br); list counts the jobs linked to it.
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: false, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	await ledger.createTracked({ title: "linked", project: "demo", delivery: "pr", tracker: { connection_id: "demo-beads", item_id: "b-1" } });
	assert.match(await call({ action: "list" }), /^demo-beads \[active\] project=demo adapter=beads endpoint=\/dbs\/demo\.db intake=off write=off linked_jobs=1$/);
	assert.match(await call({ action: "disconnect", project: "demo" }), /disconnected demo-beads .*linked jobs keep their link/);
	assert.equal((await ledger.findTracked("demo-beads", "b-1"))?.tracker?.connection_id, "demo-beads");
	await assert.rejects(call({ action: "disconnect", project: "demo" }), /project demo has no active tracker connection/);
});

test("cp_tracker import needs its parameters and an active beads connection", async (t) => {
	const { call } = await bench(t);
	await assert.rejects(call({ action: "import", project: "demo", kind: "ship", delivery: "pr" }), /cp_tracker import needs mandate_id/);
	await assert.rejects(call({ action: "import", project: "demo", mandate_id: "md-abcd12", kind: "ship", delivery: "pr", ids: ["b-1"] }), /project demo has no active tracker connection/);
});

test("write-back ticks only while this session holds the parent lock, and list shows what is not done", async (t) => {
	for (const holdsLock of [false, true]) {
		const { home, ledger, call, hooks } = await bench(t, holdsLock);
		mkdirSync(dirname(trackersFile(home)), { recursive: true });
		// A write-enabled connection whose database is gone: the attempt is refused before br runs and rescheduled.
		writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
			{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: join(home, "gone.db"), intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" },
		] }));
		const { job } = await ledger.createTracked({ title: "linked", project: "demo", kind: "research", delivery: "local", tracker: { connection_id: "demo-beads", item_id: "b-1" } });
		await ledger.close(job.id, "findings delivered");
		await hooks.get("session_start")!();
		for (let i = 0; i < (holdsLock ? 250 : 3) && !(existsSync(trackerSyncFile(home)) && /attempts": 1/.test(readFileSync(trackerSyncFile(home), "utf8"))); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		await hooks.get("session_shutdown")!();
		assert.equal(existsSync(trackerSyncFile(home)), holdsLock, `lock held: ${holdsLock}`);
		if (holdsLock) assert.match(await call({ action: "list" }), /write-back pending close demo-beads\/b-1 for .* \(attempts 1 next .*\): no beads database at .*gone\.db/);
	}
});

test("cp_tracker link links an existing job, repeats as already linked, refuses a clash, and backfills open jobs from their br ref (laf)", async (t) => {
	const { home, ledger, call } = await bench(t);
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const plain = await ledger.create({ title: "plain", project: "demo", kind: "ship", delivery: "pr" });
	assert.equal(await call({ action: "link", job_id: plain.id, item_id: "b-2" }), `linked ${plain.id} to demo-beads/b-2`);
	assert.equal(await call({ action: "link", job_id: plain.id, item_id: "b-2" }), `${plain.id} already linked to demo-beads/b-2`);
	const other = await ledger.create({ title: "other", project: "demo", kind: "ship", delivery: "pr" });
	await assert.rejects(call({ action: "link", job_id: other.id, item_id: "b-2" }), new RegExp(`${plain.id} already links demo-beads/b-2`));
	await assert.rejects(call({ action: "link", item_id: "b-3" }), /cp_tracker link item_id needs job_id/);
	const reffed = await ledger.create({ title: "reffed", project: "demo", kind: "ship", delivery: "pr", externalRef: "br --db '/dbs/demo.db' show b-1 --json" });
	assert.equal(await call({ action: "link" }), `linked 1:\n  ${reffed.id} -> demo-beads/b-1\nskipped 0`);
	assert.equal(await call({ action: "link" }), "nothing to link: no open unlinked job carries an external_ref");
});

test("the write-back tick backfills links before it derives write-backs (laf)", async (t) => {
	const { home, ledger, hooks } = await bench(t, true);
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: false, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const job = await ledger.create({ title: "reffed", project: "demo", kind: "ship", delivery: "pr", externalRef: "br --db /dbs/demo.db show b-7 --json" });
	await hooks.get("session_start")!();
	for (let i = 0; i < 250 && !(await ledger.show(job.id)).tracker; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	await hooks.get("session_shutdown")!();
	assert.equal((await ledger.show(job.id)).tracker?.item_id, "b-7");
});

test("a backfill failure is one named stderr line and the write-back still runs that tick (sha)", async (t) => {
	const lines: string[] = [];
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
	t.after(() => {
		process.stderr.write = write;
	});
	const { home, ledger, hooks } = await bench(t, true);
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: join(home, "gone.db"), intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const { job } = await ledger.createTracked({ title: "linked", project: "demo", kind: "research", delivery: "local", tracker: { connection_id: "demo-beads", item_id: "b-1" } });
	await ledger.close(job.id, "findings delivered");
	// backfillLinks reads ledger.list; runSync reads ledger.read, so only the backfill fails.
	ledger.list = async () => {
		throw new Error("ledger read failed");
	};
	await hooks.get("session_start")!();
	for (let i = 0; i < 250 && !(existsSync(trackerSyncFile(home)) && /attempts": 1/.test(readFileSync(trackerSyncFile(home), "utf8"))); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	await hooks.get("session_shutdown")!();
	process.stderr.write = write;
	assert.deepEqual(lines.filter((line) => line.includes("tracker backfill failed")), ["pi-command-post: tracker backfill failed: ledger read failed\n"]);
	assert.ok(!lines.some((line) => line.includes("tick failed")), lines.join(""));
	assert.match(readFileSync(trackerSyncFile(home), "utf8"), /attempts": 1/);
});

test("cp_tracker is parent-only and not fleet-mutating", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_tracker"));
	assert.ok(!FLEET_MUTATING_TOOLS.includes("cp_tracker"));
});
