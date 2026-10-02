/**
 * pi-command-post-3ip: a valid envelope survives the parent that dispatched it.
 *
 * The defect, observed on cp-o77y: the worker wrote
 * `state/runs/<job>/envelope.json` and the parent was restarted (which kills
 * every child). Nothing ever stamped that envelope — intake ran only from a
 * live worker's event stream, and `reconcile()`'s `needs_intake` list was
 * computed at startup and thrown away. Every gate downstream then behaved
 * correctly and kept the job stuck: the settle boundary refused to nudge a job
 * whose envelope was on disk, and the worker-reporter refused to file a second
 * one. The ledger stayed `in_progress` and the fleet record stayed `waiting`
 * forever.
 *
 * What is asserted here is the whole of the fix: reconcile lists an unstamped
 * envelope whoever the worker is, the startup pass stamps it exactly once
 * through ordinary intake (so the ordinary `onReported` wake-up fires), a
 * second pass is a no-op, and an envelope that violates the contract fails
 * closed with a reason an operator can act on.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../src/command-post.ts";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Envelope,
	type EnvelopeRecord,
	type FleetRecord,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
	type SendReceipt,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, type IntakeResult } from "../src/intake.ts";
import { RunRegistry } from "../src/runs.ts";
import { formatSettleOutcome, SettleWatcher } from "../src/settle.ts";
import type { WorkerEvent } from "../src/worker-process.ts";
import { createScratchHome, REPO_ROOT, type ScratchHome } from "./harness/index.ts";

const JOB_ID = "cp-3ip";

function record(home: ScratchHome, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			// A dead pid by construction: the parent restart took the worker with it.
			pid: 2_147_483_600,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: JOB_ID,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		...overrides,
	};
}

function writeEnvelope(home: string, jobId: string, envelope: Partial<Envelope> = {}): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	const stored: EnvelopeRecord = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		envelope: {
			job_id: jobId,
			kind: "ship",
			status: "done",
			summary: "shipped it",
			branch: jobId,
			head_sha: "0".repeat(40),
			pr_url: "https://github.com/demo/demo/pull/42",
			...envelope,
		} as Envelope,
	};
	writeFileSync(join(home, paths.envelopeFile(jobId)), `${JSON.stringify(stored, null, 2)}\n`);
}

interface Bench {
	home: ScratchHome;
	post: CommandPost;
	reported: IntakeResult[];
}

function bench(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const reported: IntakeResult[] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		onReported: (result) => reported.push(result),
	});
	t.after(() => {
		post.runs.closeAll();
		home.cleanup();
	});
	return { home, post, reported };
}

// ---------------------------------------------------------------------------
// 1. Reconcile lists the envelope, whoever the worker is
// ---------------------------------------------------------------------------

test("needs_intake is keyed on the unstamped envelope, not on the worker's pid", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record(home, { job_id: "cp-dead" }));
	await fleet.add(record(home, { job_id: "cp-orphan" }));
	await fleet.add(record(home, { job_id: "cp-silent" }));
	writeEnvelope(home.path, "cp-dead");
	writeEnvelope(home.path, "cp-orphan");

	// cp-orphan's pid answers "alive" and nobody here owns it: reconcile calls
	// that an orphan, which is a statement about the worker and says nothing
	// about the delivery it already filed.
	const report = await fleet.reconcile({ isPidAlive: (pid) => pid === 1, owned: [] });
	const pids = new Map(report.entries.map((entry) => [entry.job_id, entry.outcome]));
	assert.equal(pids.get("cp-dead"), "reported");
	assert.deepEqual(
		[...report.needs_intake].sort(),
		["cp-dead", "cp-orphan"],
		"an envelope nobody stamped needs intake however its worker ended",
	);
	assert.ok(!report.needs_intake.includes("cp-silent"), "no envelope, nothing to intake");
});

test("a stamped or terminal record is never listed for intake again", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record(home, { job_id: "cp-stamped", phase: "held", reported_at: isoTimestamp() }));
	await fleet.add(
		record(home, {
			job_id: "cp-failed",
			phase: "failed",
			failure: { class: "envelope_invalid", message: "already refused, with a cause", at: isoTimestamp() },
		}),
	);
	writeEnvelope(home.path, "cp-stamped");
	writeEnvelope(home.path, "cp-failed");

	const report = await fleet.reconcile({ isPidAlive: () => false });
	assert.deepEqual(report.needs_intake, [], "a stamped generation and a fail-closed job are both settled");
});

// ---------------------------------------------------------------------------
// 2. The startup pass stamps it — exactly once
// ---------------------------------------------------------------------------

test("a restart stamps a valid unstamped envelope and emits the ordinary envelope handling", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home));
	writeEnvelope(b.home.path, JOB_ID);

	const { report, intake } = await b.post.reconcile({ isPidAlive: () => false });

	assert.deepEqual(report.needs_intake, [JOB_ID]);
	assert.equal(intake.length, 1);
	assert.equal(intake[0]?.accepted, true);
	assert.equal(intake[0]?.already, false);
	assert.equal(intake[0]?.generation, 1, "the first generation, stamped once");
	assert.equal(intake[0]?.next, "hold", "delivery:pr still holds; the restart changes nothing about that");

	const stamped = b.post.fleet.require(JOB_ID);
	assert.equal(stamped.phase, "held");
	assert.ok(stamped.reported_at, "the envelope is the delivery: reported_at is stamped");
	assert.ok(
		stamped.receipts?.some((receipt) => receipt.kind === "pr"),
		"receipts are recorded exactly as on the live path",
	);
	assert.equal(b.reported.length, 1, "one cp-envelope wake-up, from the ordinary onReported");
	assert.equal(b.reported[0]?.job_id, JOB_ID);
});

test("a second restart is a no-op: the envelope is stamped once, ever", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home));
	writeEnvelope(b.home.path, JOB_ID);

	await b.post.reconcile({ isPidAlive: () => false });
	const first = b.post.fleet.require(JOB_ID).reported_at;

	const second = await b.post.reconcile({ isPidAlive: () => false });
	assert.deepEqual(second.report.needs_intake, [], "a stamped record is not offered for intake again");
	assert.deepEqual(second.intake, []);
	assert.equal(b.post.fleet.require(JOB_ID).reported_at, first, "reported_at is never restamped");
	assert.equal(b.reported.length, 1, "and the operator is not woken twice for one report");
});

test("a promote's reopened slot is stamped as its own generation", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home, { supersessions: 1 }));
	writeEnvelope(b.home.path, JOB_ID, { summary: "the promoted run's delivery" });

	const { intake } = await b.post.reconcile({ isPidAlive: () => false });
	assert.equal(intake[0]?.accepted, true);
	assert.equal(intake[0]?.generation, 2, "generation semantics survive the restart path");
});

// ---------------------------------------------------------------------------
// 3. Invalid and conflicting envelopes fail closed, with evidence
// ---------------------------------------------------------------------------

test("an envelope that violates the contract is refused with the violation, and repeating it fails closed", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home));
	// A conflicting envelope: it claims to belong to another job.
	writeEnvelope(b.home.path, JOB_ID, { job_id: "cp-someone-else" });

	const { intake } = await b.post.reconcile({ isPidAlive: () => false });
	assert.equal(intake[0]?.accepted, false);
	assert.match(intake[0]?.correction?.reason ?? "", /cp-someone-else/, "the evidence names the conflict itself");
	assert.equal(b.post.fleet.require(JOB_ID).phase, "waiting", "never stamped, and still reportable");
	assert.equal(b.post.fleet.require(JOB_ID).reported_at, undefined);
	assert.deepEqual(b.reported, [], "nothing is announced as a delivery");

	// pi-command-post-uad: exactly one correction. The same violation again is
	// where it fails closed.
	writeEnvelope(b.home.path, JOB_ID, { job_id: "cp-someone-else" });
	const again = await b.post.reconcile({ isPidAlive: () => false });
	assert.equal(again.intake[0]?.failure?.class, "envelope_invalid");
	assert.equal(b.post.fleet.require(JOB_ID).phase, "failed", "fail closed on the second refusal");
	assert.deepEqual(b.reported, [], "and still nothing is announced as a delivery");
});

test("a malformed envelope file is refused with the path in the message", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home));
	mkdirSync(join(b.home.path, paths.runDir(JOB_ID)), { recursive: true });
	writeFileSync(join(b.home.path, paths.envelopeFile(JOB_ID)), `${JSON.stringify({ job_id: JOB_ID })}\n`);

	const { intake } = await b.post.reconcile({ isPidAlive: () => false });
	assert.equal(intake[0]?.accepted, false);
	assert.match(intake[0]?.correction?.reason ?? "", /envelope\.json/);
	assert.equal(b.post.fleet.require(JOB_ID).phase, "waiting");
});

test("an envelope naming an artifact that is not there is refused, and the pass continues", async (t) => {
	const b = bench(t);
	await b.post.fleet.add(record(b.home, { job_id: "cp-throws" }));
	await b.post.fleet.add(record(b.home, { job_id: "cp-fine" }));
	// cp-o77y's exact shape: a ship envelope naming an artifact that does not
	// exist. It used to throw out of intake before anything was recorded, leaving
	// the filed envelope in place and the report slot shut.
	writeEnvelope(b.home.path, "cp-throws", { artifact_path: join(b.home.path, "nowhere/plan.md") });
	writeEnvelope(b.home.path, "cp-fine");

	const { intake } = await b.post.reconcile({ isPidAlive: () => false });
	const byId = new Map(intake.map((result) => [result.job_id, result]));
	assert.equal(byId.get("cp-throws")?.accepted, false);
	assert.match(byId.get("cp-throws")?.correction?.reason ?? "", /nowhere\/plan\.md/, "the cause, not a category");
	assert.equal(byId.get("cp-fine")?.accepted, true, "one bad envelope does not take the startup pass down");
});

// ---------------------------------------------------------------------------
// 4. And the settle boundary still never nudges a job that has an envelope
// ---------------------------------------------------------------------------

class StubWorker {
	alive = true;
	readonly sent: string[] = [];
	async send(message: string): Promise<{ receipt: SendReceipt }> {
		this.sent.push(message);
		return { receipt: "delivered" };
	}
	onEvent(_listener: (event: WorkerEvent) => void): () => void {
		return () => undefined;
	}
}

test("a settle whose envelope was refused is answered with the refusal reason, once", async (t) => {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const fail = (jobId: string, failure: Parameters<FleetStore["markFailed"]>[1]) => fleet.markFailed(jobId, failure);
	const intake = new EnvelopeIntake({ home: home.path, fleet, runs, fail });
	const watcher = new SettleWatcher({ fleet, runs, intake, fail });
	await fleet.add(record(home));
	writeEnvelope(home.path, JOB_ID, { job_id: "cp-someone-else" });

	const worker = new StubWorker();
	const outcome = await watcher.settled(JOB_ID, worker);

	// pi-command-post-uad: the envelope was refused and quarantined, so the slot
	// is open and the one thing this worker needs is the reason.
	assert.equal(outcome.action, "nudged");
	assert.equal(outcome.action === "nudged" ? outcome.prompt : undefined, "correction");
	assert.equal(worker.sent.length, 1, "one prompt, not a loop");
	assert.match(worker.sent[0] ?? "", /REFUSED/);
	assert.match(worker.sent[0] ?? "", /cp-someone-else/, "the reason it could not be stamped");
	assert.match(worker.sent[0] ?? "", /envelope-invalid-1\.json/, "and where the refused record is kept");
	assert.ok(
		existsSync(join(home.path, paths.invalidEnvelopeFile(JOB_ID, 1))),
		"the refused record is kept, never deleted",
	);

	// The nudge budget is unchanged by this path: the second settle records.
	const second = await watcher.settled(JOB_ID, worker);
	assert.equal(second.action, "recorded");
	assert.equal(worker.sent.length, 1, "and no second prompt");
	assert.ok((formatSettleOutcome(JOB_ID, second) ?? "").length > 0, "the operator still gets a line");
});
