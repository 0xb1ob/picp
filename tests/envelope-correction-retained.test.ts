/**
 * pi-command-post-uad, retained: a stamped envelope is immutable; no entry point re-reads one (reconcile skips held
 * jobs, report_result ends the run, a later turn is a promote). The rest is tests/e2e/envelope-intake-p9e.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Envelope,
	type FleetRecord,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, type IntakeResult } from "../src/intake.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, type ScratchHome } from "./harness/index.ts";

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

