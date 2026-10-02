import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TrackerAdapterName } from "../src/contracts.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { adapterFor, type TrackerAdapter, TrackerError } from "../src/trackers/adapter.ts";
import { formatTrackers, projectBeadsDb, projectTracker, TrackerStore, trackersFile } from "../src/trackers/config.ts";
import { createScratchHome } from "./harness/index.ts";

async function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const registry = new ProjectRegistry({ home: home.path });
	for (const name of ["demo", "other"]) await registry.register({ name, clone_url: `https://example.com/${name}.git` });
	const probed: string[] = [];
	const fake: TrackerAdapter = {
		name: "beads",
		probe: async (endpoint) => {
			if (!endpoint.startsWith("/")) throw new TrackerError("beads endpoint must be an absolute path");
			probed.push(endpoint);
			return endpoint;
		},
		get: async () => ({ status: "missing" }),
		listReady: async () => [],
	};
	const store = new TrackerStore({ home: home.path, registry, adapters: (name: TrackerAdapterName) => name === "beads" ? fake : adapterFor(name) });
	return { home: home.path, registry, store, probed };
}

test("connect writes one active connection with both capabilities off unless passed", async (t) => {
	const { home, store } = await bench(t);
	const { connection, created } = await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db" });
	assert.equal(created, true);
	assert.deepEqual({ ...connection, connected_at: "x" }, {
		id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: false, status: "active", connected_at: "x",
	});
	assert.equal(JSON.parse(readFileSync(trackersFile(home), "utf8")).connections.length, 1);
	const flagged = await store.connect({ project: "other", adapter: "beads", endpoint: "/dbs/other.db", intake: true, write: true });
	assert.equal(flagged.connection.intake_enabled && flagged.connection.write_enabled, true);
	assert.deepEqual(await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db" }), { connection, created: false }, "identical reconnect is idempotent");
	await assert.rejects(store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake: true }), /disconnect then connect to change capabilities/);
});

test("connect refuses, writing nothing: unknown project, relative endpoint, github, second active, reused id, held endpoint", async (t) => {
	const { home, store, probed } = await bench(t);
	await assert.rejects(store.connect({ project: "ghost", adapter: "beads", endpoint: "/dbs/x.db" }), /ghost/);
	await assert.rejects(store.connect({ project: "demo", adapter: "beads", endpoint: "dbs/x.db" }), /absolute/);
	await assert.rejects(store.connect({ project: "demo", adapter: "github", endpoint: "o/r" }), /adapter not implemented \(B6\)/);
	assert.equal(existsSync(trackersFile(home)), false, "nothing written");
	assert.deepEqual(probed, [], "github is refused before its endpoint is read");
	await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db" });
	const before = readFileSync(trackersFile(home), "utf8");
	await assert.rejects(store.connect({ project: "demo", adapter: "github", endpoint: "o/r" }), /adapter not implemented \(B6\)/);
	await assert.rejects(store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/new.db" }), /cp_tracker disconnect demo/);
	await assert.rejects(store.connect({ project: "other", adapter: "beads", endpoint: "/dbs/demo.db" }), /already held by active connection demo-beads/);
	await assert.rejects(store.connect({ project: "other", adapter: "beads", endpoint: "/dbs/other.db", connection_id: "demo-beads" }), /connection_id=<new id>/);
	assert.equal(readFileSync(trackersFile(home), "utf8"), before, "every refusal leaves trackers.json unchanged");
});

test("disconnect keeps a tombstone; a reused id is bound to its endpoint; reactivation takes new flags", async (t) => {
	const { store } = await bench(t);
	await assert.rejects(store.disconnect("demo"), /project demo has no active tracker connection/);
	await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db" });
	const gone = await store.disconnect("demo");
	assert.equal(gone.status, "disconnected");
	assert.ok(gone.disconnected_at);
	assert.equal(store.active("demo"), undefined);
	assert.equal(store.get("demo-beads")?.status, "disconnected", "the record is kept");
	await assert.rejects(store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/moved.db" }), /connection id demo-beads is already bound to beads \/dbs\/demo\.db.*connection_id=<new id>/);
	const moved = await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/moved.db", connection_id: "demo-moved" });
	assert.equal(moved.created, true);
	await store.disconnect("demo");
	const back = await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake: true });
	assert.deepEqual([back.connection.id, back.connection.status, back.connection.intake_enabled, back.connection.disconnected_at], ["demo-beads", "active", true, undefined]);
	assert.equal(store.list().length, 2);
});

test("list output: active first, capabilities, linked counts, github named as not implemented, empty usage", async (t) => {
	const { home, store } = await bench(t);
	assert.match(formatTrackers([], () => 0), /no tracker connections.*cp_tracker connect project=/);
	// A hand-written github record (the contract admits it) validates and is listed visibly.
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [
		{ id: "old", project: "demo", adapter: "beads", endpoint: "/dbs/old.db", intake_enabled: false, write_enabled: false, status: "disconnected", connected_at: "2026-09-01T00:00:00Z", disconnected_at: "2026-09-02T00:00:00Z" },
		{ id: "other-github", project: "other", adapter: "github", endpoint: "o/r", intake_enabled: true, write_enabled: false, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const connections = store.list();
	const text = formatTrackers(connections, (id) => (id === "old" ? 3 : 0));
	assert.match(text.split("\n")[0]!, /^other-github \[active\].*intake=on write=off linked_jobs=0 — github: adapter not implemented \(B6\)/);
	assert.match(text.split("\n")[1]!, /^old \[disconnected\].*linked_jobs=3/);
	assert.throws(() => adapterFor(connections.find((c) => c.adapter === "github")!.adapter), /github: adapter not implemented \(B6\)/);
	assert.deepEqual(projectTracker(home, "other", () => "/nowhere"), { adapter: "github", connection_id: "other-github" });
});

test("an invalid trackers.json is refused, never guessed at", async (t) => {
	const { home, store } = await bench(t);
	mkdirSync(dirname(trackersFile(home)), { recursive: true });
	writeFileSync(trackersFile(home), "{ not json");
	assert.throws(() => store.list(), /not valid JSON/);
	assert.throws(() => projectTracker(home, "demo", () => "/nowhere"), TrackerError);
	const at = "2026-09-01T00:00:00Z";
	const row = (id: string, endpoint: string) => ({ id, project: "demo", adapter: "beads", endpoint, intake_enabled: false, write_enabled: false, status: "active", connected_at: at });
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [row("a", "/a.db"), row("b", "/b.db")] }));
	assert.throws(() => store.list(), /already has active connection a/);
	writeFileSync(trackersFile(home), JSON.stringify({ schema_version: 1, connections: [row("a", "relative.db")] }));
	assert.throws(() => store.list(), /absolute path/);
});

test("projectTracker: connection beats clone DB, disconnected falls back to clone, the home DB is never used", async (t) => {
	const { home, registry, store } = await bench(t);
	const clone = registry.pathOf("demo");
	mkdirSync(join(home, ".beads"), { recursive: true });
	writeFileSync(join(home, ".beads", "beads.db"), "");
	assert.equal(projectTracker(home, "demo", () => clone), undefined, "no connection and no clone DB: none, even with a home DB");
	assert.equal(projectTracker(home, "demo", () => { throw new Error("no clone"); }), undefined);
	mkdirSync(join(clone, ".beads"), { recursive: true });
	writeFileSync(join(clone, ".beads", "beads.db"), "");
	assert.deepEqual(projectTracker(home, "demo", () => clone), { adapter: "beads", db: join(clone, ".beads", "beads.db"), source: "clone" });
	await store.connect({ project: "demo", adapter: "beads", endpoint: "/dbs/demo.db" });
	assert.deepEqual(projectTracker(home, "demo", () => clone), { adapter: "beads", db: "/dbs/demo.db", source: "connection" });
	assert.equal(projectBeadsDb(home, "demo", () => clone), "/dbs/demo.db");
	await store.disconnect("demo");
	assert.equal(projectBeadsDb(home, "demo", () => clone), join(clone, ".beads", "beads.db"));
});
