/**
 * pi-command-post-uad: a refused envelope leaves the job reportable — once.
 *
 * The defect, observed on cp-o77y after the restart reconciliation of #142:
 * the worker filed `state/runs/cp-o77y/envelope.json` naming the artifact
 * `docs/evals.md`, which did not exist. Intake refused it, correctly. But the
 * refused record stayed exactly where the worker had written it, and
 * `report_result` is write-once against that path — so every attempt to
 * correct the report came back "already filed", and the promote path could not
 * help either: `decideReopen` supersedes a *stamped* envelope, and a refused
 * one is never stamped. A clean pushed PR and a finished worker had no way
 * back at all.
 *
 * What is asserted here is the whole of the recovery, and its bound:
 *
 *  1. an envelope naming an artifact that is not there is refused, quarantined
 *     (never deleted) and journalled, and the job stays reportable;
 *  2. the corrected replacement is accepted as that same generation's one
 *     delivery — no new generation, no invented receipt;
 *  3. a second refusal of the same generation fails closed, with both records
 *     still on disk;
 *  4. a restart re-runs the pass without re-refusing or double-quarantining;
 *  5. a correction recorded for an earlier generation never spends the current
 *     one's budget, and never overwrites the earlier quarantine;
 *  6. a *stamped* envelope is immutable: nothing here can move a delivery that
 *     was already accepted.
 *
 * pi-command-post-snj adds the crash case to that bound (§7): the quarantine
 * file is written before the fleet stamp that spends the budget, so a crash in
 * between leaves it on disk with the correction unspent — and the retry that
 * follows must take a fresh name rather than rename over the evidence.
 *
 * Every case runs against a scratch home. Nothing reads or writes the real
 * fleet, and cp-o77y's own runtime files are never touched.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { localChecks } from "../extensions/worker-reporter/index.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Envelope,
	type EnvelopeCorrection,
	type FleetRecord,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, formatIntake, type IntakeResult } from "../src/intake.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, readRunEvents, REPO_ROOT, type ScratchHome } from "./harness/index.ts";

const JOB_ID = "cp-uad";

function record(home: ScratchHome, overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: JOB_ID,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
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

/** The cp-o77y shape: a ship envelope naming an artifact that is not there. */
function shipEnvelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		job_id: JOB_ID,
		kind: "ship",
		status: "done",
		summary: "shipped it",
		branch: JOB_ID,
		head_sha: "0".repeat(40),
		pr_url: "https://github.com/demo/demo/pull/42",
		...overrides,
	} as Envelope;
}

function fileEnvelope(home: string, envelope: Envelope, jobId = JOB_ID): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify(
			{ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1, envelope },
			null,
			2,
		)}\n`,
	);
}

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	reported: IntakeResult[];
}

async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	overrides: Partial<FleetRecord> = {},
): Promise<Bench> {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const reported: IntakeResult[] = [];
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onReported: (r) => reported.push(r),
	});
	await fleet.add(record(home, overrides));
	return { home, fleet, runs, intake, reported };
}

// ---------------------------------------------------------------------------
// 1. The refusal itself: quarantined, journalled, still reportable
// ---------------------------------------------------------------------------

test("an envelope naming an artifact that is not there is refused and quarantined, never deleted", async (t) => {
	const b = await bench(t);
	const missing = join(b.home.path, "docs/evals.md");
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: missing }));
	const filed = readFileSync(join(b.home.path, paths.envelopeFile(JOB_ID)), "utf8");

	const result = await b.intake.intake(JOB_ID);

	assert.equal(result.accepted, false, "an artifact that is not there is not a delivery");
	assert.equal(result.failure, undefined, "and it is not a job failure either: it is correctable");
	assert.equal(result.correction?.generation, 1);
	assert.match(result.correction?.reason ?? "", /docs\/evals\.md/, "the reason names the cause, not a category");

	// The refused record is kept, byte for byte, and the slot it occupied is free.
	const quarantine = join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1));
	assert.equal(result.correction?.quarantined, paths.invalidEnvelopeFile(JOB_ID, 1));
	assert.equal(readFileSync(quarantine, "utf8"), filed, "nothing is deleted and nothing is rewritten");
	assert.equal(
		existsSync(join(b.home.path, paths.envelopeFile(JOB_ID))),
		false,
		"envelope.json is free again — that is what reopens the worker's write-once slot",
	);

	// The job is still reportable: nothing stamped, nothing announced, no receipt.
	const after = b.fleet.require(JOB_ID);
	assert.equal(after.reported_at, undefined);
	assert.equal(after.phase, "waiting");
	assert.equal(after.receipts, undefined, "a refused envelope never mints a receipt");
	assert.deepEqual(b.reported, [], "and nobody is woken with a delivery that was refused");

	// Auditable: one journalled rejection, and an operator line that names both
	// the reason and where the record went.
	const rejected = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "envelope_rejected");
	assert.equal(rejected.length, 1);
	const line = formatIntake(result);
	assert.match(line, /envelope-invalid-1\.json/);
	assert.match(line, /docs\/evals\.md/);
	assert.match(line, /nothing was deleted/i);
});

// ---------------------------------------------------------------------------
// 2. The corrected replacement — the same generation's one delivery
// ---------------------------------------------------------------------------

test("the corrected replacement is accepted as the same generation's delivery", async (t) => {
	const b = await bench(t);
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/evals.md") }));
	await b.intake.intake(JOB_ID);

	// The worker corrects exactly what the reason named and reports again.
	fileEnvelope(b.home.path, shipEnvelope());
	const corrected = await b.intake.intake(JOB_ID);

	assert.equal(corrected.accepted, true);
	assert.equal(corrected.already, false);
	assert.equal(corrected.generation, 1, "a refused envelope was never a delivery: nothing was superseded");
	assert.equal(corrected.next, "hold", "delivery:pr still holds");
	const after = b.fleet.require(JOB_ID);
	assert.ok(after.reported_at, "the corrected report is the one that is stamped");
	assert.equal(after.phase, "held");
	assert.equal(after.supersessions, undefined, "and no generation was burned by the correction");
	assert.ok(after.receipts?.some((receipt) => receipt.kind === "pr"));
	assert.equal(b.reported.length, 1, "the operator is woken once, by the delivery that was accepted");

	// The refused record survives the delivery that replaced it.
	assert.ok(existsSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1))));

	// And the accepted envelope is immutable and idempotent, exactly as before.
	const second = await b.intake.intake(JOB_ID);
	assert.equal(second.already, true);
	assert.equal(b.fleet.require(JOB_ID).reported_at, after.reported_at, "reported_at is never restamped");
	assert.equal(b.reported.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Exactly one: the second refusal of a generation fails closed
// ---------------------------------------------------------------------------

test("a second refusal of the same generation fails closed, with both records still on disk", async (t) => {
	const b = await bench(t);
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/evals.md") }));
	const first = await b.intake.intake(JOB_ID);
	assert.ok(first.correction);

	// The worker files the same invalid envelope again: the budget is spent.
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/still-nowhere.md") }));
	const second = await b.intake.intake(JOB_ID);

	assert.equal(second.accepted, false);
	assert.equal(second.correction, undefined, "one correction per generation, not one per refusal");
	assert.equal(second.phase, "failed");
	assert.equal(second.failure?.class, "envelope_invalid");
	assert.match(second.failure?.message ?? "", /already spent its one correction/);
	assert.match(second.failure?.message ?? "", /docs\/still-nowhere\.md/, "and it still names this refusal's cause");
	assert.equal(b.fleet.require(JOB_ID).phase, "failed", "a human decides from here");

	// Nothing was deleted: the first refusal is quarantined and the second is
	// left exactly where the worker wrote it.
	assert.ok(existsSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1))), "the first refusal is kept");
	assert.ok(existsSync(join(b.home.path, paths.envelopeFile(JOB_ID))), "and so is the second");
	assert.equal(
		existsSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 2))),
		false,
		"generation 1 has one quarantine, and a second refusal does not invent a second generation",
	);
});

// ---------------------------------------------------------------------------
// 4. A restart re-runs the pass and changes nothing
// ---------------------------------------------------------------------------

test("a restart neither re-refuses a quarantined envelope nor hands out a fresh correction", async (t) => {
	const home = createScratchHome();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(() => {
		post.runs.closeAll();
		home.cleanup();
	});
	const job = record(home);
	await post.fleet.add(job);
	// The worker exited (cp-o77y's shape), but its session file is on disk: that
	// is what makes a `waiting` job revivable, and it is the recovery this path
	// exists to keep open.
	writeFileSync(job.worker.session_file, "");
	fileEnvelope(home.path, shipEnvelope({ artifact_path: join(home.path, "docs/evals.md") }));

	const first = await post.reconcile({ isPidAlive: () => false });
	assert.deepEqual(first.report.needs_intake, [JOB_ID]);
	const correction = post.fleet.require(JOB_ID).envelope_correction as EnvelopeCorrection;
	assert.equal(correction.generation, 1);

	// The parent restarts. There is no envelope to stamp any more, so the job is
	// not offered for intake at all — and the budget, which lives on disk,
	// survives the restart that spends it.
	const second = await post.reconcile({ isPidAlive: () => false });
	assert.deepEqual(second.report.needs_intake, [], "a quarantined envelope is not re-refused");
	assert.deepEqual(second.intake, []);
	assert.deepEqual(post.fleet.require(JOB_ID).envelope_correction, correction, "the budget is not reset by a restart");
	assert.equal(post.fleet.require(JOB_ID).phase, "waiting", "and the job is still promotable");
	assert.deepEqual(second.report.revivable, [JOB_ID], "and revivable: the exited worker can be relaunched to correct it");

	// The corrected report, filed after the restart, is accepted as ever.
	fileEnvelope(home.path, shipEnvelope());
	const third = await post.reconcile({ isPidAlive: () => false });
	assert.deepEqual(third.report.needs_intake, [JOB_ID]);
	assert.equal(third.intake[0]?.accepted, true);
	assert.equal(third.intake[0]?.generation, 1);
});

// ---------------------------------------------------------------------------
// 5. Generation staleness
// ---------------------------------------------------------------------------

test("a correction spent on an earlier generation never spends this one's, and never overwrites it", async (t) => {
	// A job that was promoted once (generation 2) and whose generation-1
	// envelope had already been refused and quarantined.
	const stale: EnvelopeCorrection = {
		generation: 1,
		at: isoTimestamp(new Date(0)),
		quarantined: paths.invalidEnvelopeFile(JOB_ID, 1),
		reason: "the previous generation's refusal",
	};
	const b = await bench(t, { supersessions: 1, envelope_correction: stale });
	mkdirSync(join(b.home.path, paths.runDir(JOB_ID)), { recursive: true });
	writeFileSync(join(b.home.path, stale.quarantined), "generation 1's refused record\n");

	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/evals.md") }));
	const result = await b.intake.intake(JOB_ID);

	assert.equal(result.correction?.generation, 2, "the live generation gets its own budget");
	assert.equal(result.failure, undefined, "a stale correction never fails a generation that has not spent one");
	assert.equal(result.correction?.quarantined, paths.invalidEnvelopeFile(JOB_ID, 2));
	assert.equal(
		readFileSync(join(b.home.path, stale.quarantined), "utf8"),
		"generation 1's refused record\n",
		"and the earlier generation's quarantine is untouched",
	);

	// And generation 2's budget is now spent, on generation 2's own terms.
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/evals.md") }));
	const again = await b.intake.intake(JOB_ID);
	assert.equal(again.correction, undefined);
	assert.match(again.failure?.message ?? "", /generation 2 already spent its one correction/);
});

// ---------------------------------------------------------------------------
// 6. A stamped envelope is immutable, whatever happens to the file afterwards
// ---------------------------------------------------------------------------

test("a stamped generation's envelope is never quarantined", async (t) => {
	const b = await bench(t);
	fileEnvelope(b.home.path, shipEnvelope());
	assert.equal((await b.intake.intake(JOB_ID)).accepted, true);
	const stampedAt = b.fleet.require(JOB_ID).reported_at;

	// The file is corrupted after the fact. The delivery still happened, so the
	// recovery path must not touch it: correcting a delivery is a promote, and
	// that is `src/supersede.ts`'s decision to make, not this one's.
	writeFileSync(join(b.home.path, paths.envelopeFile(JOB_ID)), "{ not an envelope record\n");
	const result = await b.intake.intake(JOB_ID);

	assert.equal(result.correction, undefined, "a delivery that landed is not correctable here");
	assert.equal(result.failure?.class, "envelope_invalid");
	assert.ok(existsSync(join(b.home.path, paths.envelopeFile(JOB_ID))), "and the file is left exactly where it is");
	assert.equal(
		existsSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1))),
		false,
		"nothing was moved aside",
	);
	assert.equal(b.fleet.require(JOB_ID).reported_at, stampedAt, "the stamp is never cleared by a refusal");
});

// ---------------------------------------------------------------------------
// 7. A crash between the quarantine and the stamp (pi-command-post-snj)
// ---------------------------------------------------------------------------

test("a quarantine left by a crash before the stamp is preserved, not overwritten by the retry", async (t) => {
	const b = await bench(t);
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/evals.md") }));
	const first = await b.intake.intake(JOB_ID);
	assert.equal(first.correction?.quarantined, paths.invalidEnvelopeFile(JOB_ID, 1));
	const preserved = readFileSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1)), "utf8");

	// The crash: the move landed, the fleet patch that spends the budget did not.
	// On disk that is `envelope-invalid-1.json` beside a record with no
	// `envelope_correction` at all — which is exactly what the parent reads when
	// it comes back up, and what makes the next refusal a *first* refusal again.
	await b.fleet.mutate((jobs) => {
		const job = jobs.find((candidate) => candidate.job_id === JOB_ID) as Record<string, unknown>;
		delete job.envelope_correction;
	});

	// The restart, and the worker's retry: still invalid, still correctable.
	const restartedFleet = new FleetStore({ home: b.home.path });
	const restarted = new EnvelopeIntake({
		home: b.home.path,
		fleet: restartedFleet,
		runs: b.runs,
		fail: (jobId, failure) => restartedFleet.markFailed(jobId, failure),
	});
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/still-nowhere.md") }));
	const retryFiled = readFileSync(join(b.home.path, paths.envelopeFile(JOB_ID)), "utf8");
	const retry = await restarted.intake(JOB_ID);

	// Both records exist, under distinct names, holding their own bytes.
	assert.equal(retry.correction?.quarantined, paths.invalidEnvelopeFile(JOB_ID, 1, 2));
	assert.equal(
		readFileSync(join(b.home.path, paths.invalidEnvelopeFile(JOB_ID, 1)), "utf8"),
		preserved,
		"the evidence the interrupted refusal preserved is still byte for byte what it was",
	);
	assert.equal(
		readFileSync(join(b.home.path, retry.correction?.quarantined ?? ""), "utf8"),
		retryFiled,
		"and the record named by the stamp is this refusal's own",
	);
	assert.match(retry.correction?.reason ?? "", /docs\/still-nowhere\.md/);
	assert.match(formatIntake(retry), /envelope-invalid-1-2\.json/, "the operator line names where it actually went");
	const rejected = readRunEvents(b.home.path, JOB_ID).filter((event) => event.type === "envelope_rejected");
	const journalled = rejected.at(-1)?.payload as { quarantined?: string } | undefined;
	assert.equal(journalled?.quarantined, paths.invalidEnvelopeFile(JOB_ID, 1, 2), "and so does the journal");

	// It is still generation 1's one correction: no new generation, nothing
	// stamped, the slot open for exactly one corrected report.
	const after = b.fleet.require(JOB_ID);
	assert.equal(retry.correction?.generation, 1);
	assert.equal(after.supersessions, undefined);
	assert.equal(after.reported_at, undefined);
	assert.equal(after.phase, "waiting");
	assert.equal(
		existsSync(join(b.home.path, paths.envelopeFile(JOB_ID))),
		false,
		"and the slot the worker writes into is free again",
	);

	// And the budget it spent is spent: the next refusal fails closed without
	// minting a third quarantine.
	fileEnvelope(b.home.path, shipEnvelope({ artifact_path: join(b.home.path, "docs/nor-here.md") }));
	const third = await restarted.intake(JOB_ID);
	assert.equal(third.correction, undefined, "one correction per generation, crash or no crash");
	assert.match(third.failure?.message ?? "", /already spent its one correction/);
	assert.match(third.failure?.message ?? "", /envelope-invalid-1-2\.json/, "naming the record it did keep");
	assert.deepEqual(
		readdirSync(join(b.home.path, paths.runDir(JOB_ID)))
			.filter((name) => name.startsWith("envelope-invalid-"))
			.sort(),
		["envelope-invalid-1-2.json", "envelope-invalid-1.json"],
		"two refusals, two records, and no third",
	);
	assert.ok(existsSync(join(b.home.path, paths.envelopeFile(JOB_ID))), "the refused third is left where the worker wrote it");
});

// ---------------------------------------------------------------------------
// 8. Root cause: the worker checks the artifact it names, whatever its kind
// ---------------------------------------------------------------------------

test("a ship envelope naming an artifact that is not there is repairable at the worker", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const missing = join(home.path, "docs/evals.md");
	const context = {
		job_id: JOB_ID,
		kind: "ship" as const,
		delivery: "pr" as const,
		role: "implementer" as const,
		runDir: "/tmp/does-not-matter",
		mayAskOperator: false,
	};

	// cp-o77y filed exactly this shape (a ship envelope naming `docs/evals.md`,
	// which was not there) and nothing noticed until the parent, by which time
	// the slot was shut. The worker can still fix it here.
	const errors = localChecks(shipEnvelope({ artifact_path: missing }), context);
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /docs\/evals\.md/);
	assert.match(errors[0] ?? "", /does not exist/);

	// A ship envelope that names no artifact is unaffected.
	assert.deepEqual(localChecks(shipEnvelope(), context), []);
});
