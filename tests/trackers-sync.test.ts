import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import type { MergeReceipt, TrackerConnection } from "../src/contracts.ts";
import type { TrackerWrite, TrackerWriter } from "../src/trackers/adapter.ts";
import { backoffSeconds, SyncStore, trackerSyncFile } from "../src/trackers/sync-store.ts";
import { deriveIntents, marker, runSync } from "../src/trackers/sync.ts";
import { createScratchLedger } from "./harness/index.ts";

const SHA_M = "a".repeat(40), SHA_H = "b".repeat(40);
const conn = (patch: Partial<TrackerConnection> = {}): TrackerConnection => ({
	id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z", ...patch,
});
const receiptFor = (jobId: string, headBranch = jobId): MergeReceipt => ({
	schema_version: 1, job_id: jobId, pr_url: "https://github.com/o/r/pull/7", merge_commit_sha: SHA_M, head_sha: SHA_H, head_branch: headBranch, recorded_at: "2026-09-02T00:00:00Z", recorded_by: "test",
});

/** An in-memory bead store with the adapter's dedupe semantics: read-back close, marker-deduped comments. */
function fakeWriter(outcome?: () => TrackerWrite | undefined) {
	const closed = new Set<string>();
	const comments: Array<{ id: string; text: string }> = [];
	const calls: string[] = [];
	const writer: TrackerWriter = {
		async close(db, id, reason) {
			calls.push(`close ${db} ${id} ${reason}`);
			const forced = outcome?.();
			if (forced) return forced;
			if (closed.has(id)) return { status: "already" };
			closed.add(id);
			return { status: "applied" };
		},
		async comment(db, id, text, marker) {
			calls.push(`comment ${db} ${id} ${text}`);
			const forced = outcome?.();
			if (forced) return forced;
			if (comments.some((c) => c.id === id && c.text.includes(marker))) return { status: "already" };
			comments.push({ id, text });
			return { status: "applied" };
		},
	};
	return { writer, closed, comments, calls };
}

async function bench(t: import("node:test").TestContext) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const receipts = new Map<string, MergeReceipt>();
	const link = async (item: string, kind: "ship" | "research", delivery: "pr" | "local" | "board" | "answer") =>
		(await scratch.ledger.createTracked({ title: item, project: "demo", kind, delivery, tracker: { connection_id: "demo-beads", item_id: item } })).job;
	return { home: scratch.path, ledger: scratch.ledger, receipts, link, readReceipt: (id: string) => receipts.get(id) };
}

test("a ship/pr job with a matching merge receipt closes its bead once with the PR URL, merge and head commits", async (t) => {
	const { home, ledger, receipts, link, readReceipt } = await bench(t);
	const job = await link("b-1", "ship", "pr");
	receipts.set(job.id, receiptFor(job.id));
	const fake = fakeWriter();
	const report = await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt });
	assert.deepEqual(report.attempted.map((row) => [row.op, row.outcome]), [["close", "applied"]]);
	assert.match(fake.calls[0]!, new RegExp(`^close /dbs/demo\\.db b-1 CP ${job.id} merged: https://github\\.com/o/r/pull/7 merge ${SHA_M} head ${SHA_H} \\[cp:[0-9a-f]{12}\\]$`));
	assert.deepEqual((await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt })).attempted, [], "done is done");
});

test("a mismatched receipt never closes: the closed job only comments", async (t) => {
	const { home, ledger, receipts, link, readReceipt } = await bench(t);
	const job = await link("b-1", "ship", "pr");
	receipts.set(job.id, receiptFor(job.id, "some-other-branch"));
	assert.deepEqual(deriveIntents(ledger.read().jobs, [conn()], readReceipt), [], "open without a matching receipt: nothing yet");
	await ledger.close(job.id, "abandoned after review");
	const fake = fakeWriter();
	await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt });
	assert.equal(fake.closed.size, 0);
	assert.match(fake.comments[0]!.text, /closed: abandoned after review \(no matching merge receipt; bead left open\)/);
});

test("a closed no-PR job — research/board, ship/local — closes its bead with its close reason", async (t) => {
	const { home, ledger, receipts, link, readReceipt } = await bench(t);
	const research = await link("b-r", "research", "board");
	const local = await link("b-l", "ship", "local");
	// A stray receipt must not change the op for a job that is not kind:ship + delivery:pr.
	receipts.set(research.id, receiptFor(research.id));
	await ledger.close(research.id, "findings delivered");
	await ledger.close(local.id, "pushed");
	const fake = fakeWriter();
	const report = await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt });
	assert.deepEqual(report.attempted.map((row) => [row.op, row.item_id]).sort(), [["close", "b-l"], ["close", "b-r"]]);
	assert.match(fake.calls.find((c) => c.includes(" b-r "))!, new RegExp(`^close /dbs/demo\\.db b-r CP ${research.id} done: findings delivered \\[cp:[0-9a-f]{12}\\]$`));
	assert.match(fake.calls.find((c) => c.includes(" b-l "))!, new RegExp(`^close /dbs/demo\\.db b-l CP ${local.id} done: pushed \\[cp:[0-9a-f]{12}\\]$`));
});

test("a dropped research job only comments and its bead stays open", async (t) => {
	const { home, ledger, link, readReceipt } = await bench(t);
	const dropped = await link("b-d", "research", "local");
	await ledger.drop(dropped.id, "superseded");
	const fake = fakeWriter();
	await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt });
	assert.equal(fake.closed.size, 0);
	assert.match(fake.comments[0]!.text, new RegExp(`CP ${dropped.id} dropped: superseded \\(bead left open\\)`));
});

test("a dropped ship/pr job with a matching receipt only comments: the receipt never closes a dropped bead", async (t) => {
	const { home, ledger, receipts, link, readReceipt } = await bench(t);
	const dropped = await link("b-dp", "ship", "pr");
	receipts.set(dropped.id, receiptFor(dropped.id));
	await ledger.drop(dropped.id, "superseded after review");
	const fake = fakeWriter();
	await runSync({ home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt });
	assert.equal(fake.closed.size, 0, "a dropped job's bead stays open, matching receipt or not");
	assert.equal(fake.comments.length, 1);
	assert.match(fake.comments[0]!.text, new RegExp(`CP ${dropped.id} dropped: superseded after review \\(bead left open\\) \\[cp:[0-9a-f]{12}\\]$`));
});

test("upgrade: a stored comment intent for a closed job derives exactly one close intent, twice, with no loop", async (t) => {
	const { home, ledger, link, readReceipt } = await bench(t);
	const job = await link("b-up", "research", "board");
	await ledger.close(job.id, "findings delivered");
	// What the pre-#352 sync recorded for this closed job: one applied comment, the bead left open.
	const store = new SyncStore(home);
	const seededKey = "0".repeat(64);
	await store.enqueue([{ key: seededKey, connection_id: "demo-beads", item_id: "b-up", job_id: job.id, op: "comment", text: `CP ${job.id} closed: findings delivered (no matching merge receipt; bead left open) ${marker(seededKey)}` }], "2026-09-02T00:00:00Z");
	await store.settle(seededKey, { status: "applied" }, new Date("2026-09-02T00:00:00Z"));
	const fake = fakeWriter();
	const ports = { home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt };
	const first = await runSync(ports);
	assert.deepEqual(first.attempted.map((row) => row.op), ["close"], "the stored comment is done; only the new close runs");
	assert.equal(fake.closed.size, 1);
	assert.equal(fake.comments.length, 0, "the applied comment is never written again");
	assert.equal(store.list().filter((intent) => intent.op === "close").length, 1);
	assert.deepEqual((await runSync(ports)).attempted, [], "the second sync derives nothing new");
	assert.equal(store.list().filter((intent) => intent.op === "close").length, 1, "exactly one close intent, no loop");
});

test("re-deriving a closed no-PR job is idempotent: the same key twice gives one intent", async (t) => {
	const { home, ledger, link, readReceipt } = await bench(t);
	const job = await link("b-i", "research", "answer");
	await ledger.close(job.id, "answered");
	const first = deriveIntents(ledger.read().jobs, [conn()], readReceipt);
	const second = deriveIntents(ledger.read().jobs, [conn()], readReceipt);
	assert.equal(first.length, 1);
	assert.equal(first[0]!.op, "close");
	assert.equal(second[0]!.key, first[0]!.key);
	const fake = fakeWriter();
	const ports = { home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt };
	await runSync(ports);
	await runSync(ports);
	assert.equal(fake.calls.filter((c) => c.startsWith("close")).length, 1, "one close; the second read back as already closed");
	assert.equal(new SyncStore(home).list().length, 1, "one stored intent");
});

test("write off, a disconnected connection or an unlinked job derives nothing", async (t) => {
	const { home, ledger, link, readReceipt } = await bench(t);
	const job = await link("b-1", "research", "local");
	await ledger.close(job.id, "done");
	await ledger.create({ title: "plain", project: "demo", kind: "research", delivery: "local" });
	assert.equal(deriveIntents(ledger.read().jobs, [conn({ write_enabled: false })], readReceipt).length, 0);
	assert.equal(deriveIntents(ledger.read().jobs, [conn({ status: "disconnected", disconnected_at: "2026-09-03T00:00:00Z" })], readReceipt).length, 0);
	assert.equal(deriveIntents(ledger.read().jobs, [conn()], readReceipt).length, 1);
	const fake = fakeWriter();
	await runSync({ home, ledger, trackers: { list: () => [conn({ write_enabled: false })] }, writer: () => fake.writer, readReceipt });
	assert.deepEqual(fake.calls, []);
});

test("keys are stable: deleting the store re-derives the same work and never double-closes", async (t) => {
	const { home, ledger, receipts, link, readReceipt } = await bench(t);
	const job = await link("b-1", "ship", "pr");
	receipts.set(job.id, receiptFor(job.id));
	const fake = fakeWriter();
	const ports = { home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt };
	await runSync(ports);
	const key = new SyncStore(home).list()[0]!.key;
	rmSync(trackerSyncFile(home));
	await runSync(ports);
	assert.equal(new SyncStore(home).list()[0]!.key, key);
	assert.equal(fake.closed.size, 1);
	assert.equal(fake.calls.filter((c) => c.startsWith("close")).length, 2, "the second close read back as already closed");
	assert.equal(fake.comments.length, 1, "closed already: the evidence is recorded as a comment instead");
	await runSync(ports);
	assert.equal(fake.comments.length, 1, "and only once");
});

test("failures back off 60, 120, 240 … capped at 900 s; an ambiguous write is held", async (t) => {
	assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffSeconds), [60, 120, 240, 480, 900, 900]);
	const { home, ledger, link, readReceipt } = await bench(t);
	const job = await link("b-1", "research", "local");
	await ledger.close(job.id, "done");
	let now = new Date("2026-09-10T00:00:00Z");
	let outcome: TrackerWrite | undefined = { status: "retryable", message: "database is locked" };
	const fake = fakeWriter(() => outcome);
	const ports = { home, ledger, trackers: { list: () => [conn()] }, writer: () => fake.writer, readReceipt, now: () => now };
	await runSync(ports);
	assert.equal(new SyncStore(home).list()[0]!.next_attempt_at, "2026-09-10T00:01:00Z");
	now = new Date("2026-09-10T00:00:59Z");
	assert.equal((await runSync(ports)).attempted.length, 0, "not due yet");
	now = new Date("2026-09-10T00:01:00Z");
	await runSync(ports);
	assert.deepEqual(new SyncStore(home).list()[0], { ...new SyncStore(home).list()[0], attempts: 2, next_attempt_at: "2026-09-10T00:03:00Z", last_error: "database is locked", status: "pending" });
	outcome = { status: "ambiguous", message: "not listed" };
	now = new Date("2026-09-10T00:03:00Z");
	await runSync(ports);
	now = new Date("2026-09-11T00:00:00Z");
	assert.equal((await runSync(ports)).attempted.length, 0, "ambiguous is held, never re-appended blind");
	assert.equal(new SyncStore(home).list()[0]!.status, "ambiguous");
});

test("a github connection is refused visibly as adapter not implemented (B6), and retried later", async (t) => {
	const { home, ledger, link, readReceipt } = await bench(t);
	const job = await link("b-1", "research", "local");
	await ledger.close(job.id, "done");
	await runSync({ home, ledger, trackers: { list: () => [conn({ adapter: "github", endpoint: "o/r" })] }, readReceipt });
	const [intent] = new SyncStore(home).list();
	assert.equal(intent!.status, "pending");
	assert.equal(intent!.last_error, "github: adapter not implemented (B6)");
});

test("the merge path never imports tracker code, so an outage cannot gate a merge", () => {
	for (const file of ["src/integrate.ts", "src/merges.ts", "src/teardown.ts"]) {
		assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /trackers\//, file);
	}
});
