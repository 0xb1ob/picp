/**
 * cp-held-cannot-report: a job must never be simultaneously promotable and
 * unreportable.
 *
 * These are the hermetic halves — the policy decision, the slot mechanics and
 * intake's behaviour across a supersession. The live half (a promoted worker
 * that actually files a second envelope through `report_result`) is in
 * tests/send.test.ts, against a real pi child.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Delivery,
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	paths,
	type Receipt,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { rebuildStatus } from "../src/run-artifacts.ts";
import { RunRegistry } from "../src/runs.ts";
import {
	decideReopen,
	landedReceipt,
	lastFiledEnvelopeFile,
	readLiveReport,
	reopenEnvelopeSlot,
	SupersedeError,
} from "../src/supersede.ts";
import { createScratchHome, readFleet, readRunEvents, type ScratchHome } from "./harness/index.ts";

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
	});
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home, fleet, runs, intake };
}

function jobRecord(home: string, jobId: string, delivery: Delivery = "pr"): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery,
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

function writeEnvelopeFile(home: string, jobId: string, envelope: Record<string, unknown>): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1, envelope }, null, 2)}\n`,
	);
}

const BLOCKED = (jobId: string) => ({
	job_id: jobId,
	kind: "ship" as const,
	status: "blocked" as const,
	summary: "Cannot proceed: the base branch is missing.",
	blockers: ["origin/main does not exist"],
});

const SHIPPED = (jobId: string, pr = "https://github.com/o/r/pull/22") => ({
	job_id: jobId,
	kind: "ship" as const,
	status: "done" as const,
	summary: "Stage A landed; CI green on the pushed head.",
	branch: jobId,
	pr_url: pr,
});

// ---------------------------------------------------------------------------
// the policy, as a pure function
// ---------------------------------------------------------------------------

test("decideReopen: an unreported job is open, a reported one reopens", (t) => {
	const b = benchOf(t);
	const fresh = jobRecord(b.home.path, "cp-a");
	assert.deepEqual(decideReopen(fresh), { kind: "open" });

	const reported: FleetRecord = { ...fresh, phase: "held", reported_at: "2026-08-30T10:00:00Z" };
	assert.deepEqual(decideReopen(reported), {
		kind: "reopen",
		reported_at: "2026-08-30T10:00:00Z",
		generation: 1,
	});

	// A second supersession is the next generation, not a repeat of the first.
	const second = decideReopen({ ...reported, supersessions: 2 });
	assert.equal(second.kind === "reopen" && second.generation, 3);
});

test("decideReopen: a landed delivery is refused, naming teardown + fresh dispatch", (t) => {
	const b = benchOf(t);
	const merged: Receipt = { kind: "pr", status: "merged", title: "PR for cp-a", url: "https://github.com/o/r/pull/22" };
	const landed: FleetRecord = {
		...jobRecord(b.home.path, "cp-a"),
		phase: "held",
		reported_at: "2026-08-30T10:00:00Z",
		receipts: [merged],
	};

	assert.equal(landedReceipt(landed)?.url, merged.url);
	const decision = decideReopen(landed);
	assert.equal(decision.kind, "refuse");
	assert.match(decision.kind === "refuse" ? decision.reason : "", /landed delivery/);
	assert.match(decision.kind === "refuse" ? decision.reason : "", /cp_teardown cp-a/);
	assert.match(decision.kind === "refuse" ? decision.reason : "", /cp_dispatch a new job id/);

	// An OPEN pr receipt is the ordinary hold: it reopens, it is not a landing.
	const open: FleetRecord = { ...landed, receipts: [{ ...merged, status: "open" }] };
	assert.equal(decideReopen(open).kind, "reopen");
	// Case and padding must not decide whether real work can be reported.
	const shouty: FleetRecord = { ...landed, receipts: [{ ...merged, status: " Merged " }] };
	assert.equal(decideReopen(shouty).kind, "refuse");
});

test("decideReopen: done and failed jobs are refused, each with its own path", (t) => {
	const b = benchOf(t);
	const base = jobRecord(b.home.path, "cp-a");
	const done = decideReopen({ ...base, phase: "done", closed_at: "2026-08-30T12:00:00Z", reported_at: "2026-08-30T10:00:00Z" });
	assert.equal(done.kind, "refuse");
	assert.match(done.kind === "refuse" ? done.reason : "", /Dispatch a fresh job/);

	const failed = decideReopen({
		...base,
		phase: "failed",
		failure: { class: "crash", message: "gone", at: isoTimestamp() },
	});
	assert.equal(failed.kind, "refuse");
	assert.match(failed.kind === "refuse" ? failed.reason : "", /a brief does not revive a failed job/);
});

// ---------------------------------------------------------------------------
// the mechanics
// ---------------------------------------------------------------------------

test("reopening archives the envelope, clears reported_at and journals the supersession", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-reopen"));
	writeEnvelopeFile(b.home.path, "cp-reopen", BLOCKED("cp-reopen"));
	const first = await b.intake.intake("cp-reopen");
	assert.equal(first.accepted, true);
	assert.equal(first.generation, 1);
	assert.equal(b.fleet.require("cp-reopen").phase, "held");
	const reportedAt = b.fleet.require("cp-reopen").reported_at;

	const supersession = await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-reopen",
		reason: "operator cleared the blocker",
	});

	assert.ok(supersession);
	assert.equal(supersession.generation, 1);
	assert.equal(supersession.prior_status, "blocked");
	assert.equal(supersession.prior_reported_at, reportedAt);

	// The job can be worked again, and owes a report again.
	const record = b.fleet.require("cp-reopen");
	assert.equal(record.phase, "waiting");
	assert.equal(record.reported_at, undefined, "the slot is open: nothing is stamped");
	assert.equal(record.supersessions, 1);

	// Nothing was destroyed: the worker's own record survives, moved aside.
	assert.equal(existsSync(join(b.home.path, paths.envelopeFile("cp-reopen"))), false);
	const archived = join(b.home.path, paths.supersededEnvelopeFile("cp-reopen", 1));
	assert.ok(existsSync(archived));
	assert.match(readFileSync(archived, "utf8"), /base branch is missing/);
	assert.equal(lastFiledEnvelopeFile(b.home.path, record), archived);

	// The supersession is a fact in the run log, not an inference.
	const events = readRunEvents(b.home.path, "cp-reopen").filter((event) => event.source === "cp");
	const marker = events.find((event) => event.type === "envelope_superseded");
	assert.ok(marker, "a supersession that nobody could see is the bug this fixes");
	assert.equal((marker?.payload as { generation?: number }).generation, 1);
	assert.equal((marker?.payload as { reason?: string }).reason, "operator cleared the blocker");
	assert.ok(!JSON.stringify(marker?.payload).includes("origin/main does not exist"), "no body travels in a marker");

	// And the run projection stops claiming this run already reported.
	assert.equal(rebuildStatus(b.home.path, "cp-reopen").reported, false);
});

test("reopening a job with nothing filed changes nothing", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-open"));
	const before = readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8");

	const result = await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-open",
		reason: "ordinary promote",
	});

	assert.equal(result, undefined);
	assert.equal(readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8"), before);
	assert.equal(existsSync(join(b.home.path, paths.eventsFile("cp-open"))), false, "no run log was opened either");
});

test("readLiveReport: absent, done, blocked (strings and planner objects), unreadable", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, paths.envelopeFile("cp-live"));
	mkdirSync(join(file, ".."), { recursive: true });
	const write = (envelope: unknown) => writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: "cp-live", envelope }));
	const read = () => readLiveReport(home.path, "cp-live");

	assert.deepEqual(readLiveReport(home.path, "cp-none"), { state: "absent" });
	write({ status: "done" });
	assert.deepEqual(read(), { state: "done" });
	write({ status: "blocked", blockers: ["  no screenshots  ", "x".repeat(300)], head_sha: "abc" });
	assert.deepEqual(read(), { state: "blocked", blockers: ["no screenshots", "x".repeat(200)], head_sha: "abc" });
	write({ status: "blocked", blockers: [{ question: "which base?" }, { why: "no question" }, 7] });
	assert.deepEqual(read(), { state: "blocked", blockers: ["which base?"] });
	writeFileSync(file, "{");
	assert.equal(read().state, "unreadable");
	write({ status: "maybe" });
	assert.deepEqual(read(), { state: "unreadable", detail: "status maybe is neither done nor blocked" });
});

test("reopening a landed delivery throws instead of reviving it", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-landed"));
	writeEnvelopeFile(b.home.path, "cp-landed", SHIPPED("cp-landed"));
	await b.intake.intake("cp-landed");
	// Somebody observed the merge and said so on the receipt.
	const record = b.fleet.require("cp-landed");
	await b.fleet.patch("cp-landed", {
		receipts: (record.receipts ?? []).map((receipt) => (receipt.kind === "pr" ? { ...receipt, status: "merged" } : receipt)),
	});

	await assert.rejects(
		() =>
			reopenEnvelopeSlot({
				home: b.home.path,
				fleet: b.fleet,
				runs: b.runs,
				jobId: "cp-landed",
				reason: "a stray brief",
			}),
		(error: SupersedeError) => {
			assert.match(error.message, /landed delivery/);
			assert.match(error.message, /cp_teardown cp-landed/);
			return true;
		},
	);

	// Fail closed means nothing moved: the envelope and the hold are intact.
	assert.ok(existsSync(join(b.home.path, paths.envelopeFile("cp-landed"))));
	assert.equal(b.fleet.require("cp-landed").phase, "held");
	assert.ok(b.fleet.require("cp-landed").reported_at);
});

// ---------------------------------------------------------------------------
// intake across a supersession
// ---------------------------------------------------------------------------

test("intake accepts the superseding envelope, and only one of them is the delivery", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-tvr"));

	// 1. blocked, reported, held — the incident's starting state.
	writeEnvelopeFile(b.home.path, "cp-tvr", BLOCKED("cp-tvr"));
	const blocked = await b.intake.intake("cp-tvr");
	assert.equal(blocked.status, "blocked");
	const firstReportedAt = b.fleet.require("cp-tvr").reported_at;
	assert.ok(firstReportedAt);

	// 2. the operator clears the blocker and the parent promotes the worker.
	await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-tvr",
		reason: "promoted with a new brief (cp_send auto)",
	});

	// 3. the worker does Stage A, pushes, opens the PR — and reports it.
	writeEnvelopeFile(b.home.path, "cp-tvr", SHIPPED("cp-tvr"));
	const shipped = await b.intake.intake("cp-tvr");

	assert.equal(shipped.accepted, true);
	assert.equal(shipped.already, false, "the superseding envelope is accepted, not swallowed as a duplicate");
	assert.equal(shipped.status, "done");
	assert.equal(shipped.generation, 2);
	assert.equal(shipped.next, "hold");

	const record = b.fleet.require("cp-tvr");
	assert.equal(record.phase, "held");
	assert.notEqual(record.reported_at, undefined);
	assert.equal(
		record.receipts?.filter((receipt) => receipt.kind === "pr").length,
		1,
		"two envelopes never both count as the delivery",
	);
	assert.equal(record.receipts?.find((receipt) => receipt.kind === "pr")?.url, "https://github.com/o/r/pull/22");

	// One live envelope, one archived; the run log tells the whole story.
	const types = readRunEvents(b.home.path, "cp-tvr")
		.filter((event) => event.source === "cp")
		.map((event) => event.type);
	// `pr_url_unverified` is the last line because this bench wires no origin remote
	// (pi-command-post-fbn): with nothing to check the worker's url against, intake says
	// so on the record instead of passing it off as verified.
	assert.deepEqual(types, ["envelope_received", "envelope_superseded", "envelope_received", "pr_url_unverified"]);
	assert.equal(rebuildStatus(b.home.path, "cp-tvr").reported, true);

	// The second intake of the SECOND generation is still a no-op.
	const again = await b.intake.intake("cp-tvr");
	assert.equal(again.already, true);
	assert.equal(readFleet(b.home.path).jobs[0]?.receipts?.length, 1);
});

test("the ordinary report-once path is untouched by any of this", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-once", "local"));
	writeEnvelopeFile(b.home.path, "cp-once", {
		job_id: "cp-once",
		kind: "ship",
		status: "done",
		summary: "Done once, reported once.",
		branch: "cp-once",
	});

	const first = await b.intake.intake("cp-once");
	const fleetAfterFirst = readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8");
	const second = await b.intake.intake("cp-once");

	assert.equal(first.already, false);
	assert.equal(first.generation, 1);
	assert.equal(second.already, true);
	assert.equal(readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8"), fleetAfterFirst);
	assert.equal(b.fleet.require("cp-once").supersessions, undefined, "no promote, no supersession");
	assert.equal(
		readRunEvents(b.home.path, "cp-once").filter((event) => event.type === "envelope_received").length,
		1,
	);
	assert.equal(existsSync(join(b.home.path, paths.supersededEnvelopeFile("cp-once", 1))), false);
});

test("an exhausted worker's rejection record is archived with the envelope it would have failed", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-stale"));
	writeEnvelopeFile(b.home.path, "cp-stale", BLOCKED("cp-stale"));
	await b.intake.intake("cp-stale");
	writeFileSync(
		join(b.home.path, paths.runDir("cp-stale"), "envelope-rejected.json"),
		JSON.stringify({ job_id: "cp-stale", attempts: 3 }),
	);

	await reopenEnvelopeSlot({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		jobId: "cp-stale",
		reason: "promoted with a new brief (cp_send auto)",
	});

	assert.equal(existsSync(join(b.home.path, paths.runDir("cp-stale"), "envelope-rejected.json")), false);
	assert.ok(existsSync(join(b.home.path, paths.supersededRejectionFile("cp-stale", 1))));

	// A reopened job with no envelope yet is simply a job that has not reported;
	// the stale rejection must not fail it.
	const result = await b.intake.intake("cp-stale");
	assert.deepEqual(result, { job_id: "cp-stale", accepted: false, already: false, phase: "waiting" });
	assert.equal(b.fleet.require("cp-stale").phase, "waiting");
});
