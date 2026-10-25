/**
 * P11c retained gate units: each has no product entry point that can reach it (named per block, and in
 * docs/testing-migration/p11c.md). Everything else in the old tests/gate.test.ts is tests/e2e/gate-review.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	GATE_REASONS_MAX_ITEMS,
	type GateFlags,
	type GateReview,
	type GateVerdict,
	GateVerdictSchema,
	isoTimestamp,
	paths,
	SCHEMA_VERSION,
	validate,
	type VerdictRecord,
} from "../src/contracts.ts";
import { awaitVerdict, BACKSTOP_POLL_INTERVAL_MS, capPayload, decideGate, removeGateScratch, SETTLE_GRACE_MS } from "../src/gate.ts";

const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const NO_PRIOR = { priorRevise: false, priorCause: null } as const;

function review(overrides: Partial<GateReview> & { job_id: string }): GateReview {
	return {
		verdict: "pass",
		flags: { ...NO_FLAGS },
		reasons: ["file list is concrete"],
		...overrides,
	} as GateReview;
}

// Retained: a single revision over the 300-word budget cannot be sent — GateReviewSchema caps an item at 400
// characters — so the "huge first revision is not reserved" branch has no reviewer that can reach it.
test("capPayload reserves the first revision so an over-budget reasons list cannot crowd it out", () => {
	const item = (label: string, size: number) => `${label} ${"w ".repeat(size - 1).trim()}`;
	const reasons = Array.from({ length: 4 }, (_unused, index) => item(`reason${index}`, 90));
	const revisions = [item("fix-first", 40), item("fix-second", 40)];
	const capped = capPayload(reasons, revisions, 300);
	assert.equal(capped.revisions?.[0], revisions[0], "the first required change survives the cap");
	assert.deepEqual(capped.raw, { reasons, revisions }, ".raw holds every input");
	const kept = capped.reasons.length + (capped.revisions?.length ?? 0);
	assert.ok(kept <= GATE_REASONS_MAX_ITEMS, `${kept} items kept`);

	// A first revision that alone exceeds the cap is not reserved: today's behavior.
	const huge = capPayload(["short reason"], [item("huge", 310)], 300);
	assert.deepEqual(huge.reasons, ["short reason"]);
	assert.equal(huge.revisions?.length, 1);
	assert.ok(huge.revisions?.[0]?.includes("dropped"));

	// The plan gate (no highOnlyBar) still produces a schema-valid decision.
	const decision = decideGate({
		jobId: "cp-r3",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-r3", verdict: "revise", reasons, revisions }),
	});
	const { raw: _raw, ...persisted } = decision;
	const validated = validate<GateVerdict>(GateVerdictSchema, persisted);
	assert.ok(validated.ok, !validated.ok ? validated.errors.join("; ") : "");
	assert.equal(persisted.verdict, "revise");
	assert.equal(persisted.revisions?.[0], revisions[0]);
});

// Retained (security path guard): job ids and attempts are validated before any gate run, and `scratchDir` is
// an injection seam only, so the unsafe_id/outside_home/unexpected_segment refusals have no entry point.
test("removeGateScratch removes only the reviewer's own cwd, and refuses every near miss", () => {
	const home = mkdtempSync(join(tmpdir(), "cp-gate-scratch-"));
	try {
		const dir = join(home, paths.gateScratchDir("cp-guard", 1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "artifact.md"), "# Goal\nx\n");
		let rmCalls: string[] = [];
		const rm = (target: string) => {
			rmCalls.push(target);
			rmSync(target, { recursive: true, force: true });
		};

		// The reported hazard: an id or attempt that could collapse the path toward
		// `state/runs/` never produces a path at all.
		for (const jobId of ["", ".", "..", "../..", "cp/../..", "-cp", "cp guard"]) {
			const removal = removeGateScratch({ home, jobId, attempt: 1, rm });
			assert.equal(removal.removed, false, `removed for ${JSON.stringify(jobId)}`);
			assert.equal(removal.reason, "unsafe_id");
		}
		for (const attempt of [0, -1, 1.5, Number.NaN]) {
			assert.equal(removeGateScratch({ home, jobId: "cp-guard", attempt, rm }).reason, "unsafe_id");
		}

		// A path that escapes `home`, and one whose final segment is not `review`:
		// both refuse, and `rm` is never reached.
		const outside = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm, scratchDir: () => "../../review" });
		assert.deepEqual([outside.removed, outside.reason], [false, "outside_home"]);
		const homeItself = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm, scratchDir: () => "." });
		assert.deepEqual([homeItself.removed, homeItself.reason], [false, "outside_home"]);
		const wrongSegment = removeGateScratch({
			home,
			jobId: "cp-guard",
			attempt: 1,
			rm,
			// `gate-1` itself: brief.md, events.jsonl and verdict.json live there.
			scratchDir: paths.gateRunDir,
		});
		assert.deepEqual([wrongSegment.removed, wrongSegment.reason], [false, "unexpected_segment"]);
		assert.deepEqual(rmCalls, [], "a refused removal never calls rm");
		assert.ok(existsSync(join(dir, "artifact.md")), "and nothing on disk moved");
		assert.ok(existsSync(join(home, paths.gateRunDir("cp-guard", 1))));

		// The one path it does take.
		const removed = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm });
		assert.deepEqual([removed.removed, removed.reason], [true, "removed"]);
		assert.deepEqual(rmCalls, [dir]);
		assert.ok(!existsSync(dir));
		assert.ok(existsSync(join(home, paths.gateRunDir("cp-guard", 1))), "the run's own record survives");

		// Idempotent: a second call is `absent`, not an error and not a wider rm.
		rmCalls = [];
		assert.equal(removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm }).reason, "absent");
		assert.deepEqual(rmCalls, []);

		// A removal that throws is reported, never propagated.
		mkdirSync(dir, { recursive: true });
		const failed = removeGateScratch({
			home,
			jobId: "cp-guard",
			attempt: 1,
			rm: () => {
				throw new Error("EBUSY: device or resource busy");
			},
		});
		assert.deepEqual([failed.removed, failed.reason], [false, "failed"]);
		assert.match(String(failed.error), /EBUSY/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// Retained (wake timing): which path woke the wait — tool event, backstop poll, early-event race, settle grace —
// is not consumer-visible; only a fake worker can withhold or reorder the event. Outcomes are e2e-pinned.
// ---------------------------------------------------------------------------
// `awaitVerdict` (cp-x78): event-driven wake, with a long-interval backstop
// poll underneath. A fake worker exercises the `VerdictWorker` surface
// directly — no real process, no MockProvider — so the event path and the
// poll path are each individually observable.
// ---------------------------------------------------------------------------

class FakeVerdictWorker {
	#listeners = new Set<(event: { type: string; toolName?: string }) => void>();
	#closeResolve!: () => void;
	readonly closed: Promise<unknown>;

	constructor() {
		this.closed = new Promise<void>((resolve) => {
			this.#closeResolve = resolve;
		});
	}

	onEvent(listener: (event: { type: string; toolName?: string }) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: { type: string; toolName?: string }): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	close(): void {
		this.#closeResolve();
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}
}

function verdictRecord(jobId: string): VerdictRecord {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		review: review({ job_id: jobId }),
	};
}

function awaitVerdictFiles(
	t: { after(fn: () => void | Promise<void>): void },
	prefix: string,
): { verdictFile: string; rejectedFile: string } {
	const dir = join(tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { verdictFile: join(dir, "verdict.json"), rejectedFile: join(dir, "verdict-rejected.json") };
}

test("awaitVerdict: a verdict file plus the verdict tool's tool_execution_end resolves without waiting for the backstop poll", async (t) => {
	const jobId = "cp-await-event";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-event");
	const worker = new FakeVerdictWorker();
	const record = verdictRecord(jobId);

	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

	// The reviewer writes its verdict, then reports through its terminating
	// tool — the same order the real worker uses.
	writeFileSync(verdictFile, JSON.stringify(record));
	worker.emit({ type: "tool_execution_end", toolName: "report_verdict" });

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.deepEqual(result.review, record.review);
	assert.ok(
		elapsed < BACKSTOP_POLL_INTERVAL_MS / 2,
		`expected the tool_execution_end event to wake the wait well under the ${BACKSTOP_POLL_INTERVAL_MS}ms backstop, took ${elapsed}ms`,
	);
	assert.equal(worker.listenerCount, 0, "the event listener must be removed once the wait resolves");
});

test(
	"awaitVerdict: tool_execution_end for a different tool is ignored — the verdict-tool filter actually filters",
	async (t) => {
		const jobId = "cp-await-wrong-tool";
		const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-wrong-tool");
		const worker = new FakeVerdictWorker();
		const record = verdictRecord(jobId);

		const start = Date.now();
		const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

		// The verdict file already exists, so a listener that failed to filter by
		// tool name would wake and resolve on this event immediately. It must not:
		// only the backstop poll may find the file from here.
		writeFileSync(verdictFile, JSON.stringify(record));
		worker.emit({ type: "tool_execution_end", toolName: "some_other_tool" });

		const result = await promise;
		const elapsed = Date.now() - start;
		assert.deepEqual(result.review, record.review);
		assert.ok(
			elapsed >= BACKSTOP_POLL_INTERVAL_MS - 100,
			`expected the mismatched tool event to be ignored, resolving only via the backstop poll (~${BACKSTOP_POLL_INTERVAL_MS}ms), took ${elapsed}ms`,
		);
		assert.equal(worker.listenerCount, 0);
	},
);

test(
	"awaitVerdict: an early tool_execution_end (the .tmp-rename race) never throws, and the verdict is still found once the file lands",
	async (t) => {
		const jobId = "cp-await-early-event";
		const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-early-event");
		const worker = new FakeVerdictWorker();
		const record = verdictRecord(jobId);

		const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

		// The reviewer's report_verdict tool call can complete a tick before its
		// write-once verdict file's temp-write-then-rename becomes visible on
		// disk. Firing the event before the file exists must not resolve the wait
		// with a false negative (or throw) — it must keep waiting until the file
		// itself is the fact on the ground.
		worker.emit({ type: "tool_execution_end", toolName: "report_verdict" });
		assert.equal(existsSync(verdictFile), false, "the race only means something if the file is not there yet");
		setTimeout(() => writeFileSync(verdictFile, JSON.stringify(record)), 50);

		const result = await promise;
		assert.deepEqual(result.review, record.review);
		assert.equal(worker.listenerCount, 0);
	},
);


test("awaitVerdict: settle without a verdict waits the full grace, then is a terminal operational fault", async (t) => {
	const jobId = "cp-await-settle";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-settle");
	const worker = new FakeVerdictWorker();

	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	worker.emit({ type: "agent_settled" });

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.equal(result.operational, "reviewer settled without reporting a verdict");
	assert.ok(elapsed >= SETTLE_GRACE_MS - 25, `expected to wait out the settle grace (~${SETTLE_GRACE_MS}ms), took ${elapsed}ms`);
	assert.equal(worker.listenerCount, 0);
});

test("awaitVerdict: a verdict file with no event at all is still found, by the backstop poll", async (t) => {
	const jobId = "cp-await-backstop";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-backstop");
	const worker = new FakeVerdictWorker();
	const record = verdictRecord(jobId);

	// Written to disk only after the wait has already started its first sleep,
	// and the fake worker never emits anything at all: the only thing that can
	// find this file is the long-interval backstop poll, never the initial
	// synchronous check and never an event wake. This is the failure path a
	// missed or unrecognized event falls back to.
	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	setTimeout(() => writeFileSync(verdictFile, JSON.stringify(record)), 50);

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.deepEqual(result.review, record.review);
	assert.ok(
		elapsed >= 50 && elapsed < BACKSTOP_POLL_INTERVAL_MS + 500,
		`expected the backstop poll (~${BACKSTOP_POLL_INTERVAL_MS}ms) to find the file, took ${elapsed}ms`,
	);
	assert.equal(worker.listenerCount, 0);
});
