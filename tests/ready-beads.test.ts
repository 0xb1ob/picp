import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, isoTimestamp, LAYOUT, type FleetRecord } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { Ledger, normalizeExternalRef } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { cpNext, formatNext, type NextPorts } from "../src/next.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { idleBeadObserver, readReadyBeads } from "../src/ready-beads.ts";
import { trackersFile } from "../src/trackers/config.ts";
import { CpBridge, type BridgeRelay } from "../src/cp-bridge.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

async function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://example.com/demo.git" });
	const { ledger } = createScratchLedger({ knownProjects: ["demo"], home: home.path });
	const ports: NextPorts = { ledger, registry, fleet: new FleetStore({ home: home.path }), mandates: new MandateStore(home.path), escalations: new EscalationStore({ home: home.path }) };
	return { home, registry, ledger, ports };
}

/** A clone-local beads DB: the project's own `.beads`, never the home's. */
function cloneDb(registry: ProjectRegistry, name: string): string {
	const db = join(registry.pathOf(name), ".beads/beads.db");
	mkdirSync(dirname(db), { recursive: true });
	writeFileSync(db, "");
	return db;
}

function worker(id: string): FleetRecord {
	return { job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting", worker: { pid: 4242, session_id: "test", session_file: "/sessions/test", profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() }, worktree: `/wt/${id}`, branch: id, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE };
}

test("cp_next reads each project once, filters epics/deferred and existing jobs, and bounds displayed IDs", async (t) => {
	const { ports, registry, ledger } = await bench(t);
	await registry.register({ name: "other", clone_url: "https://example.com/other.git" });
	for (const name of ["demo", "other"]) cloneDb(registry, name);
	const existing = await ledger.create({ title: "tracked", project: "demo", delivery: "pr", externalRef: "br show b-tracked --json" });
	await ledger.close(existing.id, "done");
	await ledger.create({ title: "pinned", project: "demo", delivery: "pr", externalRef: `br --db '${join(registry.pathOf("demo"), ".beads/beads.db")}' show b-pinned --json` });
	const calls: string[] = [];
	ports.beadExec = async (command, args, options) => {
		assert.equal(command, "br");
		assert.deepEqual(args, ["--db", join(options.cwd, ".beads/beads.db"), "ready", "--json", "--limit", "0"]);
		assert.ok(options.timeoutMs >= 5000 && options.timeoutMs <= 15000);
		calls.push(options.cwd);
		return JSON.stringify(options.cwd === registry.pathOf("other") ? [{ id: "b-tracked", issue_type: "task", labels: [] }] : [
			{ id: "b-tracked", issue_type: "task", labels: [] }, { id: "b-pinned", issue_type: "task", labels: [] },
			{ id: "b-epic", issue_type: "epic", labels: [] }, { id: "b-later", issue_type: "task", labels: ["deferred"] },
			...Array.from({ length: 7 }, (_, i) => ({ id: `b-${i}`, issue_type: "task", labels: [] })),
		]);
	};
	const before = await ledger.list({ all: true });
	const result = await cpNext(ports);
	const text = formatNext(result);
	assert.match(text, /\[demo\] 7 ready beads have no job: b-0, b-1, b-2, b-3, b-4/);
	assert.doesNotMatch(text, /b-5|b-6|b-epic|b-later|b-pinned/);
	assert.match(text, /\[other\] 1 ready beads have no job: b-tracked/);
	assert.equal(result.action.kind, "no_mandate");
	assert.deepEqual(calls.sort(), [registry.pathOf("demo"), registry.pathOf("other")].sort());
	assert.deepEqual(await ledger.list({ all: true }), before, "discovery creates no jobs");
	assert.deepEqual(ports.mandates.list(), [], "discovery grants no authority");
});

test("a project without a connection or its own .beads never inherits the home's beads", async (t) => {
	const { home, ports, registry, ledger } = await bench(t);
	mkdirSync(registry.pathOf("demo"), { recursive: true });
	mkdirSync(join(home.path, ".beads"));
	writeFileSync(join(home.path, ".beads/beads.db"), "");
	const never = async (): Promise<string> => { throw new Error("br must not run for a project with no beads database"); };
	ports.beadExec = never;
	const result = await cpNext(ports);
	assert.deepEqual((result.ready_beads ?? []).filter((row) => row.project === "demo"), []);
	assert.doesNotMatch(formatNext(result), /demo\].*beads/);
	const notices: string[] = [];
	const observe = idleBeadObserver(() => readReadyBeads(registry, ledger, undefined, never), (text) => notices.push(text), () => []);
	await observe([worker("cp-one")], [{ ...worker("cp-one"), phase: "held" }]);
	assert.deepEqual(notices, [], "no idle notice lists the home's beads under an unconnected project");
});

test("connection, clone-local and unconnected projects resolve separately", async (t) => {
	const { home, ports, registry } = await bench(t);
	for (const name of ["connected", "local", "gh"]) await registry.register({ name, clone_url: `https://example.com/${name}.git` });
	mkdirSync(join(home.path, ".beads"));
	writeFileSync(join(home.path, ".beads/beads.db"), "");
	const connectedDb = join(home.path, "elsewhere", "beads.db");
	mkdirSync(join(home.path, "elsewhere"));
	writeFileSync(connectedDb, "");
	const localDb = cloneDb(registry, "local");
	const at = isoTimestamp();
	const connection = (id: string, project: string, adapter: string, endpoint: string) =>
		({ id, project, adapter, endpoint, intake_enabled: false, write_enabled: false, status: "active", connected_at: at });
	mkdirSync(dirname(trackersFile(home.path)), { recursive: true });
	writeFileSync(trackersFile(home.path), JSON.stringify({ schema_version: 1, connections: [
		connection("connected-beads", "connected", "beads", connectedDb), connection("gh-github", "gh", "github", "o/r"),
	] }));
	const calls: string[] = [];
	ports.beadExec = async (_command, args) => {
		calls.push(args[1]!);
		return JSON.stringify([{ id: args[1] === localDb ? "local-ready" : "connected-ready", issue_type: "task" }]);
	};
	const result = await cpNext(ports);
	assert.deepEqual([...(result.ready_beads ?? [])].sort((a, b) => a.project.localeCompare(b.project)), [
		{ project: "connected", ids: ["connected-ready"] },
		{ project: "gh", ids: [], error: "github: adapter not implemented (B6)" },
		{ project: "local", ids: ["local-ready"] },
	]);
	assert.deepEqual(calls.sort(), [connectedDb, localDb].sort(), "demo (home DB only) is never read");
	// An imported bead (B4: tracker-linked, ref pinned to the connection DB) is no longer "ready beads have no job".
	await new Ledger({ home: home.path }).createTracked({ title: "imported", project: "connected", delivery: "pr", kind: "ship", externalRef: normalizeExternalRef("br show connected-ready --json", connectedDb), tracker: { connection_id: "connected-beads", item_id: "connected-ready" } });
	assert.deepEqual((await cpNext(ports)).ready_beads?.find((row) => row.project === "connected"), { project: "connected", ids: [] });
});

test("a bead linked to a non-closed job is never reported as 'no job', blocked or in_progress", async (t) => {
	const { ports, registry, ledger } = await bench(t);
	cloneDb(registry, "demo");
	ports.beadExec = async () => JSON.stringify([
		{ id: "b-blocked", issue_type: "task", labels: [] },
		{ id: "b-running", issue_type: "task", labels: [] },
		{ id: "b-free", issue_type: "task", labels: [] },
	]);
	const blocked = await ledger.create({ title: "waiting on its planner", project: "demo", delivery: "pr" });
	const blocker = await ledger.create({ title: "the planner", project: "demo", delivery: "pr" });
	await ledger.link(blocked.id, { connection_id: "demo-beads", item_id: "b-blocked" });
	await ledger.addDep(blocked.id, blocker.id);
	const running = await ledger.create({ title: "in flight", project: "demo", delivery: "pr" });
	await ledger.link(running.id, { connection_id: "demo-beads", item_id: "b-running" });
	await ledger.update(running.id, { status: "in_progress" });

	const result = await cpNext(ports);
	assert.deepEqual(result.ready_beads?.find((row) => row.project === "demo"), { project: "demo", ids: ["b-free"] });
	assert.doesNotMatch(formatNext(result), /b-blocked|b-running/);
});

test("cp_next surfaces beads with spare slots, hides them at capacity, and reports br failures even when busy", async (t) => {
	const { ports, registry } = await bench(t);
	cloneDb(registry, "demo");
	ports.beadExec = async () => JSON.stringify([{ id: "b-ready", issue_type: "task", labels: [] }]);
	for (let i = 0; i < 2; i++) ports.mandates.issue({ projects: ["demo"], objective: `grant ${i}`, expiry: isoTimestamp(new Date(Date.now() + 86400000)), spend_cap: { usd: 100, tokens: 1000000 }, job_cap: 10, dispatch_parallelism: 2 });
	await ports.fleet.add(worker("cp-one"));
	assert.match(formatNext(await cpNext(ports)), /1 ready beads have no job/);
	await ports.fleet.add(worker("cp-two"));
	assert.doesNotMatch(formatNext(await cpNext(ports)), /ready beads have no job/);
	ports.beadExec = async () => { throw new Error("spawn br ENOENT"); };
	assert.match(formatNext(await cpNext(ports)), /\[demo\] ready beads unavailable:.*ENOENT/);
	ports.beadExec = async () => '{"not":"an array"}';
	assert.match(formatNext(await cpNext(ports)), /ready beads unavailable:.*array/);
	ports.beadExec = async () => '[{"id":"b-bad","labels":"deferred"}]';
	assert.match(formatNext(await cpNext(ports)), /ready beads unavailable:.*invalid/);
});

test("schedlater S3: ready-bead capacity reads only the grants a bead's job could run under, counting only their own records", async (t) => {
	const { home, ports, registry } = await bench(t);
	cloneDb(registry, "demo");
	ports.beadExec = async () => JSON.stringify([{ id: "b-ready", issue_type: "task", labels: [] }]);
	const base = { projects: ["demo"], expiry: isoTimestamp(new Date(Date.now() + 86400000)), spend_cap: { usd: 100, tokens: 1000000 }, job_cap: 10, dispatch_parallelism: 1 };
	const schedule = ports.mandates.issue({ ...base, objective: "nightly", schedule_grant: true });
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [{ id: "sch-abc123", name: "nightly", project: "demo", mandate_id: schedule.id, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job: { title: "nightly", kind: "ship", delivery: "pr" }, enabled: true, created_at: isoTimestamp() }] }));
	await ports.fleet.add({ ...worker("cp-sched"), schedule_id: "sch-abc123" });
	// Only a schedule grant, and it is full: a bead's job would be uncovered by it, so the bead still shows.
	assert.match(formatNext(await cpNext(ports)), /1 ready beads have no job/);
	// A project-wide grant with one slot: the scheduled run never holds it...
	ports.mandates.issue({ ...base, objective: "ship it" });
	assert.match(formatNext(await cpNext(ports)), /1 ready beads have no job/);
	// ...an unscheduled worker does, and a schedule grant with room never re-opens it.
	await ports.fleet.add(worker("cp-plain"));
	ports.mandates.issue({ ...base, objective: "another nightly", schedule_grant: true });
	assert.doesNotMatch(formatNext(await cpNext(ports)), /ready beads have no job/);
});

test("fleet settling emits once per idle period, not per mutation, and cancels stale reads after dispatch", async (t) => {
	const { home, registry, ledger } = await bench(t);
	cloneDb(registry, "demo");
	const notices: string[] = [];
	let resolveRead: ((value: string) => void) | undefined;
	const pending: Promise<void>[] = [];
	const observe = idleBeadObserver(() => readReadyBeads(registry, ledger, undefined, async () => new Promise<string>((resolve) => { resolveRead = resolve; })), (text) => notices.push(text), () => fleet.read().jobs);
	const fleet = new FleetStore({ home: home.path, onChanged: (before, after) => { pending.push(observe(before, after)); } });
	await fleet.add(worker("cp-one"));
	await fleet.add(worker("cp-two"));
	await fleet.patch("cp-one", { phase: "held", reported_at: isoTimestamp() });
	assert.equal(resolveRead, undefined, "another worker still occupies a slot");
	await fleet.patch("cp-two", { phase: "held", reported_at: isoTimestamp() });
	await new Promise<void>((resolve) => setImmediate(resolve));
	resolveRead!(JSON.stringify([{ id: "b-ready", issue_type: "task", labels: [] }]));
	await Promise.all(pending);
	await fleet.patch("cp-two", { reported_at: isoTimestamp() });
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /fleet idle with 1 ready beads/);
	await fleet.patch("cp-one", { phase: "waiting" });
	await fleet.patch("cp-one", { phase: "held" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	await fleet.patch("cp-two", { phase: "waiting" });
	resolveRead!(JSON.stringify([{ id: "b-ready", issue_type: "task", labels: [] }]));
	await Promise.all(pending);
	assert.equal(notices.length, 1, "a stale idle observation must not wake a busy fleet");
	await fleet.patch("cp-two", { phase: "held" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	resolveRead!(JSON.stringify([{ id: "b-ready", issue_type: "task", labels: [] }]));
	await Promise.all(pending);
	assert.equal(notices.length, 2, "the next idle period gets its own notice");
});

test("a bead linked while br ready runs is not 'no job' when the idle probe emits (cp-05wj race)", async (t) => {
	const { registry, ledger } = await bench(t);
	cloneDb(registry, "demo");
	const notices: string[] = [];
	let resolveRead: ((value: string) => void) | undefined;
	const observe = idleBeadObserver(() => readReadyBeads(registry, ledger, undefined, async () => new Promise<string>((resolve) => { resolveRead = resolve; })), (text) => notices.push(text), () => []);
	const probe = observe([worker("cp-7w8j")], [{ ...worker("cp-7w8j"), phase: "held" }]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	// The job is created and linked mid-probe; no fleet change cancels the probe.
	const job = await ledger.create({ title: "linked mid-probe", project: "demo", delivery: "pr" });
	await ledger.link(job.id, { connection_id: "demo-beads", item_id: "b-linked" });
	resolveRead!(JSON.stringify([{ id: "b-linked", issue_type: "task", labels: [] }, { id: "b-free", issue_type: "task", labels: [] }]));
	await probe;
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /1 ready beads have no job: b-free/);
	assert.doesNotMatch(notices[0]!, /b-linked/);
});

test("no idle notice when a worker is live at emit time, even one recorded outside the observed store (cp-05wj/cp-hhuf)", async (t) => {
	const { home, registry, ledger } = await bench(t);
	cloneDb(registry, "demo");
	const ready = JSON.stringify([{ id: "b-free", issue_type: "task", labels: [] }]);
	const notices: string[] = [];
	let resolveRead: ((value: string) => void) | undefined;
	const pending: Promise<void>[] = [];
	const observe = idleBeadObserver(() => readReadyBeads(registry, ledger, undefined, async () => new Promise<string>((resolve) => { resolveRead = resolve; })), (text) => notices.push(text), () => observed.read().jobs);
	const observed = new FleetStore({ home: home.path, onChanged: (before, after) => { pending.push(observe(before, after)); } });
	// A second store over the same file fires no callback here, like another CommandPost instance.
	const other = new FleetStore({ home: home.path });
	await observed.add(worker("cp-7w8j"));
	await observed.patch("cp-7w8j", { phase: "held", reported_at: isoTimestamp() });
	await new Promise<void>((resolve) => setImmediate(resolve));
	await other.add(worker("cp-hhuf"));
	resolveRead!(ready);
	await Promise.all(pending);
	assert.deepEqual(notices, [], "a worker spawned while the probe ran keeps the notice silent");

	// Control: the same probe with no live worker at emit time does fire.
	await other.patch("cp-hhuf", { phase: "held", reported_at: isoTimestamp() });
	await observed.patch("cp-7w8j", { phase: "waiting" });
	await observed.patch("cp-7w8j", { phase: "held" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	resolveRead!(ready);
	await Promise.all(pending);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /fleet idle with 1 ready beads/);
});

test("the bridge relays idle bead evidence without relying on the parent's prose", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: join(import.meta.dirname, "fixtures/fake-parent.mjs"), requestTimeoutMs: 5000 });
	await bridge.send("IDLEBEADS", 5000);
	const wakes = relays.filter((relay) => relay.kind === "wake" && relay.text.includes("fleet idle"));
	assert.equal(wakes.length, 1);
	assert.match(wakes[0]!.text, /fleet idle with 2 ready beads/);
	assert.equal(wakes[0]!.receipt.level, "owner_observed");
});
