/**
 * P23: the declarations of tests/supersede.test.ts kept verbatim (V2): decideReopen's padded-status, done and failed
 * branches that cp_send pre-empts. tests/e2e/send-p9g.test.ts and tests/e2e/landing-merge.test.ts hold the rest.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Delivery,
	type FleetRecord,
	isoTimestamp,
	type Receipt,
} from "../src/contracts.ts";
import { decideReopen, landedReceipt } from "../src/supersede.ts";
import { createScratchHome, type ScratchHome } from "./harness/index.ts";

/** Only the scratch home of the original bench: these tests never open the fleet or a run. */
function benchOf(t: { after(fn: () => void | Promise<void>): void }): { home: ScratchHome } {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return { home };
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
