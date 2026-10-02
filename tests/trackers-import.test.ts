import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import type { TrackerAdapter, TrackerItem } from "../src/trackers/adapter.ts";
import { TrackerStore, trackersFile } from "../src/trackers/config.ts";
import { importReady, mandateEpics, trackerTaskFile } from "../src/trackers/import.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const DB = "/dbs/demo.db";
const item = (id: string, extra: Partial<TrackerItem> = {}): TrackerItem => ({ id, title: `bead ${id}`, description: `do ${id}`, status: "open", issue_type: "task", labels: [], ...extra });

function bench(t: import("node:test").TestContext, options: { intake?: boolean; ready?: TrackerItem[]; children?: Record<string, TrackerItem[]> } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(dirname(trackersFile(home.path)), { recursive: true });
	writeFileSync(trackersFile(home.path), JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: DB, intake_enabled: options.intake ?? true, write_enabled: false, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const { ledger } = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const mandates = new MandateStore(home.path);
	const items = new Map<string, TrackerItem>();
	for (const row of [...(options.ready ?? []), ...Object.values(options.children ?? {}).flat()]) items.set(row.id, row);
	const calls: string[] = [];
	const adapter: TrackerAdapter = {
		name: "beads",
		probe: async (endpoint) => endpoint,
		get: async (db, id) => (calls.push(`get ${db} ${id}`), items.has(id) ? { status: "found", item: items.get(id)! } : { status: "missing" }),
		listReady: async (db, opts = {}) => (calls.push(`ready ${db} ${opts.parent ?? "*"}`), opts.parent ? options.children?.[opts.parent] ?? [] : options.ready ?? []),
	};
	const store = new TrackerStore({ home: home.path, registry: { require: () => ({}) } });
	const issue = async (extra: { objective?: string; job_cap?: number; named?: boolean } = {}) => {
		const seed = await ledger.create({ title: `seed ${Math.random()}`, project: "demo", delivery: "pr", kind: "ship" });
		return mandates.issue({
			projects: ["demo"], objective: extra.objective ?? "import the tracker batch", expiry: "2099-01-01T00:00:00Z",
			spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: extra.job_cap ?? 10, ...(extra.named === false ? {} : { job_ids: [seed.id] }),
		});
	};
	const ports = { home: home.path, store, adapter, ledger, mandates, fleetJobs: [] };
	return { home: home.path, ledger, mandates, items, calls, issue, ports };
}

test("mandateEpics reads every `epic: <id>` the objective records", () => {
	assert.deepEqual(mandateEpics("finish epic: pi-command-post-f7g. Then epic:b-2 and epic: pi-command-post-f7g"), ["pi-command-post-f7g", "b-2"]);
	assert.deepEqual(mandateEpics("no epic here"), []);
});

test("import creates open jobs for named ids and the mandate's epic children only, enrolled in the batch grant", async (t) => {
	const b = bench(t, { ready: [item("b-1"), item("b-2"), item("b-other")], children: { "b-epic": [item("b-c1"), item("b-1")] } });
	const mandate = await b.issue({ objective: "ship the batch; epic: b-epic" });
	const result = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-2", "b-missing"] });
	assert.deepEqual(result.created.map((row) => row.item_id), ["b-2", "b-c1", "b-1"]);
	assert.deepEqual(result.skipped, [{ item_id: "b-missing", reason: "refused: not in br ready (open, unblocked, not an epic, not deferred)" }]);
	assert.ok(!b.calls.some((call) => call.includes("b-other")), "a ready bead outside the mandate's work is never read");
	const enrolled = b.mandates.require(mandate.id).job_ids!;
	for (const row of result.created) {
		const job = b.ledger.findTracked("demo-beads", row.item_id)!;
		assert.equal(job.status, "open");
		assert.equal(job.external_ref, `br --db '${DB}' show ${row.item_id} --json`);
		assert.equal(job.tracker?.mandate_id, mandate.id);
		assert.match(job.tracker?.task_sha256 ?? "", /^[0-9a-f]{64}$/);
		assert.equal(job.notes, `task_file: ${trackerTaskFile(b.home, job.id)}`);
		assert.match(readFileSync(row.task_file, "utf8"), new RegExp(`Imported from demo-beads/${row.item_id} under ${mandate.id}`));
		assert.ok(enrolled.includes(job.id));
	}
	const again = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-2"] });
	assert.equal(again.created.length, 0);
	assert.ok(again.skipped.every((row) => row.reason.startsWith("already imported as")));
});

test("import refuses project-wide grants, a call with no named work, intake off, and a grant for another project", async (t) => {
	const b = bench(t, { ready: [item("b-1")] });
	const wide = await b.issue({ named: false });
	await assert.rejects(importReady(b.ports, { project: "demo", mandateId: wide.id, kind: "ship", delivery: "pr", ids: ["b-1"] }), /project-wide \(no job_ids\).*named-jobs/);
	const batch = await b.issue();
	await assert.rejects(importReady(b.ports, { project: "demo", mandateId: batch.id, kind: "ship", delivery: "pr" }), /name the bead ids.*epic: <id>/);
	await assert.rejects(importReady(b.ports, { project: "demo", mandateId: "md-none00", kind: "ship", delivery: "pr", ids: ["b-1"] }), /no mandate md-none00/);
	await assert.rejects(importReady(b.ports, { project: "other", mandateId: batch.id, kind: "ship", delivery: "pr", ids: ["b-1"] }), /no active tracker connection/);
	b.mandates.pause(batch.id);
	await assert.rejects(importReady(b.ports, { project: "demo", mandateId: batch.id, kind: "ship", delivery: "pr", ids: ["b-1"] }), /is paused/);
	assert.equal(b.ledger.findTracked("demo-beads", "b-1"), undefined);
	const off = bench(t, { intake: false, ready: [item("b-1")] });
	await assert.rejects(importReady(off.ports, { project: "demo", mandateId: (await off.issue()).id, kind: "ship", delivery: "pr", ids: ["b-1"] }), /intake off/);
});

test("import stays within the job cap, counting listed jobs not yet dispatched, and skips conflicting labels", async (t) => {
	const b = bench(t, { ready: [item("b-1"), item("b-2", { labels: ["kind:research"] }), item("b-3")] });
	const mandate = await b.issue({ job_cap: 2 }); // the seed job already holds one slot
	const result = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-2", "b-1", "b-3"] });
	assert.equal(result.capacity, 1);
	assert.deepEqual(result.created.map((row) => row.item_id), ["b-1"]);
	assert.deepEqual(result.skipped.map((row) => row.item_id), ["b-2", "b-3"]);
	assert.match(result.skipped[0]!.reason, /label kind:research conflicts/);
	assert.match(result.skipped[1]!.reason, /no room under .*job cap 2/);
	assert.equal(b.mandates.require(mandate.id).job_ids!.length, 2);
});

test("a crash between creating and enrolling leaves a deferred, unoffered job that the same import resumes", async (t) => {
	const b = bench(t, { ready: [item("b-1"), item("b-2")] });
	const mandate = await b.issue();
	const enroll = b.mandates.enroll.bind(b.mandates);
	b.mandates.enroll = () => { throw new Error("crash"); };
	const crashed = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-1", "b-2"] });
	assert.equal(crashed.created.length, 0);
	const stuck = b.ledger.findTracked("demo-beads", "b-1")!;
	assert.equal(stuck.status, "deferred");
	assert.ok(!(await b.ledger.ready()).some((job) => job.id === stuck.id), "a deferred import is never in the ready queue");
	assert.ok(!b.mandates.require(mandate.id).job_ids!.includes(stuck.id));
	// cp_dispatch's claim (the ledger's open -> in_progress path) refuses the unenrolled deferred job.
	await assert.rejects(b.ledger.claim(stuck.id, stuck.id), new RegExp(`${stuck.id} is deferred: run cp_tracker import again to finish enrollment`));
	assert.equal((await b.ledger.show(stuck.id)).status, "deferred");
	// b-2's source changed and its task file is gone: it stays deferred rather than freezing different text.
	const other = b.ledger.findTracked("demo-beads", "b-2")!;
	rmSync(trackerTaskFile(b.home, other.id));
	b.items.set("b-2", item("b-2", { description: "changed" }));
	b.mandates.enroll = enroll;
	const resumed = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-1", "b-2"] });
	assert.deepEqual(resumed.created.map((row) => [row.job_id, row.resumed]), [[stuck.id, true]]);
	assert.match(resumed.skipped[0]!.reason, new RegExp(`${other.id} stays deferred: the source changed`));
	assert.equal((await b.ledger.show(stuck.id)).status, "open");
	assert.ok(b.mandates.require(mandate.id).job_ids!.includes(stuck.id));
	assert.ok(!existsSync(trackerTaskFile(b.home, other.id)));
	assert.equal((await b.ledger.claim(stuck.id, stuck.id)).status, "in_progress", "once enrolled and open it is claimable");
});

test("a crash after enrolling, before opening, resumes even when the grant is at its job cap", async (t) => {
	const b = bench(t, { ready: [item("b-1"), item("b-2")] });
	const mandate = await b.issue({ job_cap: 2 }); // seed + b-1 fill it
	const update = b.ledger.update.bind(b.ledger);
	b.ledger.update = async () => { throw new Error("crash before open"); };
	await assert.rejects(importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-1"] }), /crash before open/);
	b.ledger.update = update;
	const stuck = b.ledger.findTracked("demo-beads", "b-1")!;
	assert.equal(stuck.status, "deferred");
	assert.ok(b.mandates.require(mandate.id).job_ids!.includes(stuck.id), "enrolled before the crash");
	const resumed = await importReady(b.ports, { project: "demo", mandateId: mandate.id, kind: "ship", delivery: "pr", ids: ["b-1", "b-2"] });
	assert.equal(resumed.capacity, 0);
	assert.deepEqual(resumed.created.map((row) => [row.job_id, row.resumed]), [[stuck.id, true]]);
	assert.deepEqual(resumed.skipped.map((row) => row.item_id), ["b-2"]);
	assert.match(resumed.skipped[0]!.reason, /no room under .*job cap 2/);
	assert.equal((await b.ledger.show(stuck.id)).status, "open");
	assert.equal(b.mandates.require(mandate.id).job_ids!.length, 2, "the resume took no new slot");
});

test("MandateStore.enroll refuses a project-wide or capped grant and is idempotent", async (t) => {
	const b = bench(t);
	const wide = await b.issue({ named: false });
	assert.throws(() => b.mandates.enroll(wide.id, { jobId: "cp-abcd", project: "demo", kind: "ship" }, [], new Set()), /project-wide/);
	const batch = await b.issue({ job_cap: 1 });
	const seed = batch.job_ids![0]!;
	assert.throws(() => b.mandates.enroll(batch.id, { jobId: "cp-abcd", project: "demo", kind: "ship" }, [], new Set([seed])), /job cap 1 reached/);
	assert.equal(b.mandates.enroll(batch.id, { jobId: seed, project: "demo", kind: "ship" }, [], new Set([seed])).job_ids!.length, 1);
	assert.deepEqual(b.mandates.enroll(batch.id, { jobId: "cp-abcd", project: "demo", kind: "ship" }, [], new Set()).job_ids, [seed, "cp-abcd"]);
});
