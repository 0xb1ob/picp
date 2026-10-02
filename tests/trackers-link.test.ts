import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job, MergeReceipt, TrackerConnection } from "../src/contracts.ts";
import type { TrackerWriter } from "../src/trackers/adapter.ts";
import { autoLink, backfillLinks, beadForRef, describeWriteBack, linkJob, writeBackLine } from "../src/trackers/link.ts";
import { runSync } from "../src/trackers/sync.ts";
import { createScratchLedger } from "./harness/index.ts";

const PR = "https://github.com/o/r/pull/7";
const REF = "br --db '/dbs/demo.db' show b-1 --json";
const conn = (patch: Partial<TrackerConnection> = {}): TrackerConnection => ({
	id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z", ...patch,
});
const receiptFor = (jobId: string): MergeReceipt => ({
	schema_version: 1, job_id: jobId, pr_url: PR, merge_commit_sha: "a".repeat(40), head_sha: "b".repeat(40), head_branch: jobId, recorded_at: "2026-09-02T00:00:00Z", recorded_by: "test",
});

function bench(t: import("node:test").TestContext) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const create = (title: string, externalRef?: string) =>
		scratch.ledger.create({ title, project: "demo", kind: "ship", delivery: "pr", ...(externalRef ? { externalRef } : {}) });
	return { home: scratch.path, ledger: scratch.ledger, create };
}

test("Ledger.link sets the link once, repeats idempotently, and refuses another item or an item another job links", async (t) => {
	const { ledger, create } = bench(t);
	const a = await create("a"), b = await create("b");
	const first = await ledger.link(a.id, { connection_id: "demo-beads", item_id: "b-1" });
	assert.equal(first.linked, true);
	assert.deepEqual({ ...first.job.tracker, linked_at: "x" }, { connection_id: "demo-beads", item_id: "b-1", linked_at: "x" });
	assert.equal((await ledger.link(a.id, { connection_id: "demo-beads", item_id: "b-1" })).linked, false);
	await assert.rejects(ledger.link(a.id, { connection_id: "demo-beads", item_id: "b-2" }), /already linked to demo-beads\/b-1/);
	await assert.rejects(ledger.link(b.id, { connection_id: "demo-beads", item_id: "b-1" }), new RegExp(`${a.id} already links demo-beads/b-1`));
});

test("beadForRef resolves a pinned br ref on the active beads connection, and names every reason it does not", () => {
	const job = (external_ref?: string, project = "demo"): Job => ({
		id: "cp-x1", title: "x", status: "open", labels: [`project:${project}`, "delivery:pr", "kind:ship"], blocked_by: [], comments: [],
		created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...(external_ref ? { external_ref } : {}),
	});
	const ok = beadForRef(job(REF), [conn()]);
	assert.ok(ok.ok);
	assert.equal(ok.item_id, "b-1");
	assert.equal(ok.connection.id, "demo-beads");
	const reason = (r: ReturnType<typeof beadForRef>) => (r.ok ? "ok" : r.reason);
	assert.equal(reason(beadForRef(job(), [conn()])), "no external_ref");
	assert.equal(reason(beadForRef(job("https://github.com/o/r/issues/1"), [conn()])), "external_ref is not a br show command");
	assert.equal(reason(beadForRef(job("br show b-1 --json"), [conn()])), "external_ref has no --db, so it names no database");
	assert.equal(reason(beadForRef(job(REF, "other"), [conn()])), "project other has no active tracker connection");
	assert.equal(reason(beadForRef(job(REF), [conn({ adapter: "github", endpoint: "o/r" })])), "active connection demo-beads is github, not beads");
	assert.equal(reason(beadForRef(job("br --db /dbs/else.db show b-1 --json"), [conn()])), "external_ref names /dbs/else.db, not demo-beads's database /dbs/demo.db");
	assert.equal(reason(beadForRef(job("br --db /dbs/link.db show b-1 --json"), [conn()], () => "/dbs/demo.db")), "ok", "compared by realpath");
});

test("autoLink links a resolvable job and says why it does not link otherwise, never throwing", async (t) => {
	const { ledger, create } = bench(t);
	const job = await create("linked", REF);
	assert.equal(await autoLink(ledger, job, [conn()]), "linked to demo-beads/b-1");
	assert.equal((await ledger.show(job.id)).tracker?.item_id, "b-1");
	const url = await create("url", "https://example.com/x");
	assert.equal(await autoLink(ledger, url, [conn()]), "not linked to a tracker bead: external_ref is not a br show command");
	const clash = await create("clash", "br --db /dbs/demo.db show b-1 --json");
	assert.match(await autoLink(ledger, clash, [conn()]), new RegExp(`^not linked to a tracker bead: ${job.id} already links demo-beads/b-1`));
});

test("linkJob links an existing job explicitly or from its ref, repeats as already linked, and refuses without a connection", async (t) => {
	const { ledger, create } = bench(t);
	const job = await create("explicit");
	await ledger.close(job.id, "merged earlier");
	assert.equal(await linkJob(ledger, [conn()], job.id, "b-9"), `linked ${job.id} to demo-beads/b-9`);
	assert.equal(await linkJob(ledger, [conn()], job.id, "b-9"), `${job.id} already linked to demo-beads/b-9`);
	await assert.rejects(linkJob(ledger, [conn()], job.id, "b-8"), /already linked to demo-beads\/b-9/);
	const other = await create("other");
	await assert.rejects(linkJob(ledger, [], other.id, "b-2"), /project demo has no active tracker connection; cp_tracker connect first/);
	await assert.rejects(linkJob(ledger, [conn()], other.id), /no external_ref; pass item_id=<bead>/);
	const fromRef = await create("from ref", REF);
	assert.equal(await linkJob(ledger, [conn()], fromRef.id), `linked ${fromRef.id} to demo-beads/b-1`);
});

test("backfillLinks links open unlinked jobs whose ref resolves and skips the rest with reasons; closed jobs are left alone", async (t) => {
	const { ledger, create } = bench(t);
	const open = await create("open", REF);
	const closed = await create("closed", "br --db /dbs/demo.db show b-2 --json");
	await ledger.close(closed.id, "done");
	const url = await create("url", "https://example.com/x");
	await create("no ref");
	const result = await backfillLinks(ledger, [conn()]);
	assert.deepEqual(result.linked, [`${open.id} -> demo-beads/b-1`]);
	assert.deepEqual(result.skipped, [`${url.id}: external_ref is not a br show command`]);
	assert.equal((await ledger.show(closed.id)).tracker, undefined);
	assert.deepEqual(await backfillLinks(ledger, [conn()]), { linked: [], skipped: [`${url.id}: external_ref is not a br show command`] });
});

test("merge closes bead: a backfilled ship/pr job with its merge receipt closes the bead with the PR URL", async (t) => {
	const { home, ledger, create } = bench(t);
	const job = await create("ship it", REF);
	await backfillLinks(ledger, [conn()]);
	const calls: string[] = [];
	const writer: TrackerWriter = {
		async close(db, id, reason) { calls.push(`close ${db} ${id} ${reason}`); return { status: "applied" }; },
		async comment(db, id, text) { calls.push(`comment ${db} ${id} ${text}`); return { status: "applied" }; },
	};
	const report = await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => writer, readReceipt: (id) => (id === job.id ? receiptFor(id) : undefined) });
	assert.deepEqual(report.attempted.map((row) => [row.op, row.item_id, row.outcome]), [["close", "b-1", "applied"]]);
	assert.match(calls[0]!, new RegExp(`^close /dbs/demo\\.db b-1 CP ${job.id} merged: ${PR.replaceAll(".", "\\.")} `));
});

test("unlinked names why: describeWriteBack says exactly what write-back does, or why nothing is written", async (t) => {
	const { home, ledger, create } = bench(t);
	const unlinked = await create("unlinked", "https://example.com/x");
	assert.equal(
		describeWriteBack(unlinked, [conn()], undefined, []),
		`tracker write-back: nothing written for ${unlinked.id}: not linked to a tracker bead (external_ref is not a br show command); cp_tracker link job_id=${unlinked.id} item_id=<bead> links it`,
	);
	const linked = (await ledger.link((await create("linked")).id, { connection_id: "demo-beads", item_id: "b-1" })).job;
	assert.match(describeWriteBack(linked, [conn()], receiptFor(linked.id), []), new RegExp(`^tracker write-back: demo-beads/b-1 closes with ${PR.replaceAll(".", "\\.")} on the next write-back tick`));
	assert.match(describeWriteBack(linked, [conn({ write_enabled: false })], receiptFor(linked.id), []), /nothing written for .*: connection demo-beads has write off$/);
	assert.match(describeWriteBack(linked, [], receiptFor(linked.id), []), /connection demo-beads is not in data\/trackers\.json/);
	assert.match(describeWriteBack(linked, [conn()], undefined, []), /demo-beads\/b-1 for .*: nothing to write yet \(open, no matching merge receipt\)/);
	assert.match(writeBackLine(home, () => ledger, () => [conn()], unlinked.id), /^tracker write-back: nothing written for /);
	assert.match(writeBackLine(home, () => ledger, () => { throw new Error("trackers.json is not valid JSON"); }, unlinked.id), /^tracker write-back: unknown for .* \(trackers\.json is not valid JSON\)$/);
});
