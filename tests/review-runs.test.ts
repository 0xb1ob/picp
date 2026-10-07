/**
 * The review registry (spec 2026-09-05-async-reviewers): one pending attempt
 * per (job, surface); pending.json written before the waiter starts and gone
 * before the wake-up is sent; the wake-up waits for the handback; an orphan
 * is finished without a worker and wakes the parent only if the parent had
 * been told to wait for it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	CI_WATCH_MAX_BACKOFF_MS,
	type GateReview,
	type PendingReview,
	paths,
	SCHEMA_VERSION,
	VERDICT_SUPPRESSED_RETRY_MAX_SECONDS,
} from "../src/contracts.ts";
import {
	listPendingReviews,
	readPendingReview,
	type ReviewAttempt,
	ReviewRuns,
	ReviewRunsError,
	type ReviewWakeup,
} from "../src/review-runs.ts";
import { decideGate, readPriorAttempts } from "../src/gate.ts";
import { RunRegistry } from "../src/runs.ts";
import type { FleetRecord } from "../src/contracts.ts";
import { HeldContinuation } from "../src/held-continuation.ts";
import type { IntegrateResult } from "../src/integrate.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

import { deadlineClock, writeWindowPass } from "./harness/review-window.ts";
import { readReviewMergeWindow } from "../src/review-merge-window.ts";
interface Bench {
	home: string;
	runs: RunRegistry;
	sent: ReviewWakeup[];
	registry: ReviewRuns;
	alive: Set<number>;
	finishFailures: { pending: PendingReview; reason: string }[];
}

function benchOf(
	t: { after(fn: () => void | Promise<void>): void },
	options: { failSend?: boolean; handbackTimeoutMs?: number } = {},
): Bench {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	const sent: ReviewWakeup[] = [];
	const alive = new Set<number>();
	const finishFailures: Bench["finishFailures"] = [];
	const registry = new ReviewRuns({
		home: home.path,
		runs,
		wakeup: (wakeup) => {
			if (options.failSend) throw new Error("transport down");
			sent.push(wakeup);
			return true;
		},
		onFinishFailure: (pending, reason) => finishFailures.push({ pending, reason }),
		now: () => new Date("2026-09-05T10:00:00Z"),
		isAlive: (pid) => alive.has(pid),
		...(options.handbackTimeoutMs === undefined ? {} : { handbackTimeoutMs: options.handbackTimeoutMs }),
	});
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home: home.path, runs, sent, registry, alive, finishFailures };
}

/** A waiter the test releases by hand, and a finish that records what it saw. */
function attemptOf(
	b: Bench,
	overrides: Partial<ReviewAttempt<string>> & { finished?: string[]; wake?: boolean } = {},
): { attempt: ReviewAttempt<string>; release: (outcome: string) => void; finished: string[] } {
	let release: (outcome: string) => void = () => {};
	const finished: string[] = overrides.finished ?? [];
	const attemptNumber = overrides.attempt ?? 1;
	const attempt: ReviewAttempt<string> = {
		jobId: "cp-a",
		surface: "gate",
		attempt: 1,
		model: "mock/reviewer",
		pid: 4242,
		deadline: "2026-09-05T10:15:00Z",
		wait: () => new Promise<string>((resolve) => (release = resolve)),
		finish: async (outcome) => {
			finished.push(outcome);
			// The decision file is what "finished" means on disk.
			const file = join(b.home, paths.gateFile("cp-a", attemptNumber));
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, JSON.stringify({ outcome }));
			if (overrides.wake === false) return undefined;
			return {
				jobId: "cp-a",
				surface: "gate",
				attempt: attemptNumber,
				content: `verdict: ${outcome}`,
				details: { outcome },
			};
		},
		...overrides,
	};
	return { attempt, release: (outcome) => release(outcome), finished };
}

test("start writes pending.json before the waiter runs and returns wait", (t) => {
	const b = benchOf(t);
	const { attempt } = attemptOf(b);
	const wait = b.registry.start(attempt);
	assert.deepEqual(
		{ next: wait.next, surface: wait.surface, attempt: wait.attempt, model: wait.model, deadline: wait.deadline },
		{ next: "wait", surface: "gate", attempt: 1, model: "mock/reviewer", deadline: "2026-09-05T10:15:00Z" },
	);
	assert.equal(wait.key, ReviewRuns.key("cp-a", "gate", 1));
	const pending = readPendingReview(b.home, "cp-a", "gate", 1);
	assert.ok(pending, "pending.json is on disk");
	assert.equal(pending.handed_back, false);
	assert.equal(pending.pid, 4242);
	assert.equal(pending.schema_version, SCHEMA_VERSION);
	assert.deepEqual(b.registry.pending("cp-a", "gate"), pending);
	const events = readRunEvents(b.home, "cp-a").map((event) => event.type);
	assert.ok(events.includes("review_started"));
});

test("one pending per (job, surface): a second start is refused with the record", (t) => {
	const b = benchOf(t);
	b.registry.start(attemptOf(b).attempt);
	try {
		b.registry.start(attemptOf(b).attempt);
		assert.fail("second start must throw");
	} catch (error) {
		assert.ok(error instanceof ReviewRunsError);
		assert.equal(error.pending.attempt, 1);
	}
	// A different surface on the same job is a different slot.
	const quality = b.registry.start({ ...attemptOf(b).attempt, surface: "quality", attempt: 1 });
	assert.equal(quality.surface, "quality");
	assert.equal(listPendingReviews(b.home, "cp-a").length, 2);
});

test("finish runs after the waiter resolves; the wake-up waits for handBack", async (t) => {
	const b = benchOf(t);
	const { attempt, release, finished } = attemptOf(b);
	const wait = b.registry.start(attempt);
	release("pass");
	// Let the chain run as far as it can without a handback.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(finished, ["pass"], "finish ran once");
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false, "pending.json is gone");
	assert.ok(existsSync(join(b.home, paths.gateFile("cp-a", 1))), "the decision is on disk");
	assert.equal(b.sent.length, 0, "no wake-up before the caller holds its result (D7)");

	b.registry.handBack(wait.key);
	await b.registry.settled(wait.key);
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.content, "verdict: pass");
	assert.equal(b.registry.pending("cp-a", "gate"), undefined);
	const events = readRunEvents(b.home, "cp-a").map((event) => event.type);
	assert.ok(events.includes("verdict_wakeup_sent"));
});

test("handBack before the waiter resolves is the ordinary order, and sends once", async (t) => {
	const b = benchOf(t);
	const { attempt, release } = attemptOf(b);
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	assert.equal(readPendingReview(b.home, "cp-a", "gate", 1)?.handed_back, true, "the flag flips on disk");
	release("pass");
	await b.registry.settled(wait.key);
	assert.equal(b.sent.length, 1);
	// A second handBack for a finished key is a no-op, never a second send.
	b.registry.handBack(wait.key);
	assert.equal(b.sent.length, 1);
});

test("durable before announce: a throwing transport leaves the decision and the cleared pending (D8)", async (t) => {
	const b = benchOf(t, { failSend: true });
	const { attempt, release } = attemptOf(b);
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	release("pass");
	await b.registry.settled(wait.key);
	assert.ok(existsSync(join(b.home, paths.gateFile("cp-a", 1))));
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false);
	assert.equal(b.registry.pending("cp-a", "gate"), undefined, "a failed send never resurrects the pending slot");
});

test("a waiter that throws is finished as an operational outcome, never left pending", async (t) => {
	const b = benchOf(t);
	const seen: string[] = [];
	const wait = b.registry.start<{ operational?: string }>({
		jobId: "cp-a",
		surface: "gate",
		attempt: 1,
		model: "m",
		deadline: "2026-09-05T10:15:00Z",
		wait: async () => {
			throw new Error("stream cut");
		},
		finish: async (outcome) => {
			seen.push(outcome.operational ?? "none");
			return undefined;
		},
	});
	b.registry.handBack(wait.key);
	await b.registry.settled(wait.key);
	assert.deepEqual(seen, ["reviewer wait failed: stream cut"]);
	assert.equal(b.registry.pending("cp-a", "gate"), undefined);
});

test("a finish that returns no wake-up sends nothing and still clears the slot", async (t) => {
	const b = benchOf(t);
	const { attempt, release } = attemptOf(b, { wake: false });
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	release("pass");
	await b.registry.settled(wait.key);
	assert.equal(b.sent.length, 0);
	assert.equal(b.registry.pending("cp-a", "gate"), undefined);
});

/**
 * A gate-shaped attempt whose `finish` is scripted per call: `throw` (before
 * writing), `write-then-throw` (partial), or `persist` (the real ladder's
 * decision, written where `readPriorAttempts` counts it).
 */
function scriptedFinish(
	b: Bench,
	steps: Array<"throw" | "write-then-throw" | "persist">,
): { attempt: ReviewAttempt<{ review?: GateReview; operational?: string }>; release: () => void; seen: string[] } {
	let release: () => void = () => {};
	const seen: string[] = [];
	const file = join(b.home, paths.gateFile("cp-a", 1));
	return {
		seen,
		release: () => release(),
		attempt: {
			jobId: "cp-a",
			surface: "gate",
			attempt: 1,
			model: "mock/reviewer",
			deadline: "2026-09-05T10:15:00Z",
			wait: () =>
				new Promise((resolve) => {
					release = () => resolve({ review: { verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["ok"] } as GateReview });
				}),
			finish: async (outcome) => {
				seen.push(outcome.operational ?? "review");
				const step = steps[seen.length - 1];
				const { raw: _raw, ...decided } = decideGate({
					jobId: "cp-a",
					attempt: 1,
					prior: { priorRevise: false, priorCause: null },
					model: "mock/reviewer",
					...(outcome.review ? { review: outcome.review } : {}),
					...(outcome.operational ? { operational: outcome.operational } : {}),
					at: "2026-09-05T10:01:00Z",
				});
				if (step === "throw") throw new Error("decision for cp-a violates the contract:\n  /decision_summary: unexpected property");
				mkdirSync(join(file, ".."), { recursive: true });
				writeFileSync(file, JSON.stringify(decided));
				if (step === "write-then-throw") throw new Error("raw write failed");
				return { jobId: "cp-a", surface: "gate", attempt: 1, content: `verdict: ${decided.verdict}/${decided.cause}`, details: {} };
			},
		},
	};
}

test("a finish that throws before writing is decided operational once: one decision, one wake-up, attempt 2 next", async (t) => {
	const b = benchOf(t);
	const { attempt, release, seen } = scriptedFinish(b, ["throw", "persist"]);
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	release();
	await b.registry.settled(wait.key);

	assert.equal(seen.length, 2, "one fallback finish, never more");
	assert.match(seen[1] ?? "", /^reviewer finish failed: decision for cp-a violates the contract: \/decision_summary/);
	assert.ok(!(seen[1] ?? "").includes("\n"), "the persisted reason is one line");
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile("cp-a", 1)), "utf8")) as { verdict: string; cause: string };
	assert.deepEqual([decision.verdict, decision.cause], ["escalate", "operational"], "never a pass");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.content, "verdict: escalate/operational");
	assert.equal(b.finishFailures.length, 0, "a decided fallback needs no recovery notice");
	const orphaned = readRunEvents(b.home, "cp-a").filter((event) => event.type === "review_orphaned");
	assert.equal(orphaned.length, 1);
	assert.equal(readPriorAttempts(b.home, "cp-a", paths.gateFile).attempt, 2, "the next review is attempt 2, not a replay of 1");
	assert.equal(b.registry.pending("cp-a", "gate"), undefined);
});

test("a finish that throws after its decision is written gets no fallback and no cp-verdict, one notice", async (t) => {
	const b = benchOf(t);
	const { attempt, release, seen } = scriptedFinish(b, ["write-then-throw"]);
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	release();
	await b.registry.settled(wait.key);

	assert.equal(seen.length, 1, "no second, conflicting decision");
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile("cp-a", 1)), "utf8")) as { verdict: string };
	assert.equal(decision.verdict, "pass", "the written decision is left as it was");
	assert.equal(b.sent.length, 0, "no fabricated cp-verdict");
	assert.equal(b.finishFailures.length, 1);
	assert.equal(b.finishFailures[0]?.pending.attempt, 1);
	assert.match(b.finishFailures[0]?.reason ?? "", /raw write failed; a decision was already written/);
	assert.equal(b.registry.pending("cp-a", "gate"), undefined, "cleanup ran before the notice");
});

test("a fallback that throws too sends nothing and reports once; a throwing reporter changes nothing", async (t) => {
	const b = benchOf(t);
	const { attempt, release, seen } = scriptedFinish(b, ["throw", "throw"]);
	const wait = b.registry.start(attempt);
	b.registry.handBack(wait.key);
	release();
	await b.registry.settled(wait.key);

	assert.equal(seen.length, 2);
	assert.equal(existsSync(join(b.home, paths.gateFile("cp-a", 1))), false);
	assert.equal(b.sent.length, 0);
	assert.equal(b.finishFailures.length, 1);
	assert.match(b.finishFailures[0]?.reason ?? "", /operational fallback also failed/);
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false);

	// The reporter is caller code: its throw must not escape the chain.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const loud = new ReviewRuns({
		home: home.path,
		onFinishFailure: () => {
			throw new Error("outbox down");
		},
	});
	const again = scriptedFinish({ ...b, home: home.path }, ["throw", "throw"]);
	const key = loud.start(again.attempt).key;
	loud.handBack(key);
	again.release();
	await loud.settled(key);
	assert.equal(loud.pending("cp-a", "gate"), undefined);
});

test("a caller that never hands back cannot pin the slot or swallow the verdict", async (t) => {
	// The barrier is an ordering rule, not a permission: a tool result that threw
	// between `start` and `handBack` must not park the chain forever. The bound
	// is spent, the decision (already on disk) is announced, and the slot is free
	// for the next attempt — all inside this session, with no orphan sweep.
	const b = benchOf(t, { handbackTimeoutMs: 30 });
	const { attempt, release } = attemptOf(b);
	const wait = b.registry.start(attempt);
	release("pass");
	await b.registry.settled(wait.key);

	assert.equal(b.sent.length, 1, "the verdict is announced once the bound is spent");
	assert.equal(b.sent[0]?.content, "verdict: pass");
	assert.ok(existsSync(join(b.home, paths.gateFile("cp-a", 1))), "the decision was durable first (D8)");
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false);
	assert.equal(b.registry.pending("cp-a", "gate"), undefined, "the slot is not pinned in flight");

	// And the slot is genuinely reusable: a second attempt starts, unrefused.
	const second = b.registry.start({ ...attemptOf(b, { attempt: 2 }).attempt, attempt: 2 });
	assert.equal(second.attempt, 2);
});

/** A pending.json written by a previous parent process: nothing in memory knows it. */
function seedOrphan(b: Bench, overrides: Partial<PendingReview> = {}): PendingReview {
	const pending: PendingReview = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-a",
		surface: "gate",
		attempt: 1,
		model: "mock/reviewer",
		pid: 9999,
		started_at: "2026-09-05T09:00:00Z",
		deadline: "2026-09-05T09:15:00Z",
		handed_back: true,
		...overrides,
	};
	const file = join(b.home, paths.pendingReviewFile(pending.job_id, pending.surface, pending.attempt));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(pending));
	return pending;
}

test("orphan sweep: dead pid + no decision → finished operationally; handed_back decides the wake-up", async (t) => {
	const b = benchOf(t);
	const told = seedOrphan(b, { attempt: 1, handed_back: true });
	seedOrphan(b, { attempt: 2, handed_back: false, surface: "gate" });
	const reasons: string[] = [];
	const report = await b.registry.sweepOrphans(
		{
			gate: async (pending, reason) => {
				reasons.push(`${pending.attempt}:${reason}`);
				const file = join(b.home, paths.gateFile("cp-a", pending.attempt));
				mkdirSync(join(file, ".."), { recursive: true });
				writeFileSync(file, "{}");
				return { jobId: "cp-a", surface: "gate", attempt: pending.attempt, content: "lost", details: {} };
			},
		},
		["cp-a"],
	);
	assert.equal(report.finished.length, 2);
	assert.deepEqual(reasons, ["1:reviewer lost with the parent session", "2:reviewer lost with the parent session"]);
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false);
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 2))), false);
	// Only the attempt the parent had been told to wait for wakes it.
	assert.deepEqual(
		b.sent.map((wakeup) => wakeup.attempt),
		[told.attempt],
	);
	const events = readRunEvents(b.home, "cp-a").filter((event) => event.type === "review_orphaned");
	assert.equal(events.length, 2);
});

test("orphan sweep: a finisher that throws is reported once and the sweep keeps going", async (t) => {
	const b = benchOf(t);
	seedOrphan(b, { job_id: "cp-a" });
	seedOrphan(b, { job_id: "cp-b" });
	const report = await b.registry.sweepOrphans(
		{
			gate: async (pending) => {
				if (pending.job_id === "cp-a") throw new Error("disk full");
				return { jobId: pending.job_id, surface: "gate", attempt: 1, content: "verdict: operational", details: {} };
			},
		},
		["cp-a", "cp-b"],
	);
	assert.deepEqual(report.finished.map((pending) => pending.job_id), ["cp-b"]);
	assert.match(report.skipped[0]?.reason ?? "", /orphaned reviewer finish failed: disk full/);
	assert.deepEqual(b.finishFailures.map((failure) => failure.pending.job_id), ["cp-a"]);
	assert.deepEqual(b.sent.map((wakeup) => wakeup.jobId), ["cp-b"]);
	assert.deepEqual(listPendingReviews(b.home, "cp-a"), [], "the marker is cleared either way");
});

test("orphan sweep: a live pid, a decision already on disk, or no finisher are all left alone", async (t) => {
	const b = benchOf(t);
	seedOrphan(b, { attempt: 1, pid: 4242 });
	b.alive.add(4242);
	seedOrphan(b, { attempt: 2 });
	writeFileSync(join(b.home, paths.gateFile("cp-a", 2)), "{}");
	seedOrphan(b, { attempt: 1, surface: "quality" });
	const report = await b.registry.sweepOrphans({ gate: async () => undefined }, ["cp-a"]);
	assert.equal(report.finished.length, 0);
	assert.deepEqual(
		report.skipped.map((entry) => `${entry.pending.surface}-${entry.pending.attempt}:${entry.reason}`).sort(),
		["gate-1:reviewer still alive", "gate-2:decision already on disk", "quality-1:no finisher for quality"],
	);
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))));
	assert.equal(b.sent.length, 0);
});

test("an unconfirmed wake-up is resent once after the retry window; a confirmed one never is", async (t) => {
	const b = benchOf(t);
	let clock = new Date("2026-09-05T10:00:00Z");
	const registry = new ReviewRuns({
		home: b.home,
		runs: b.runs,
		wakeup: (wakeup) => (b.sent.push(wakeup), true),
		now: () => clock,
	});
	const { attempt, release } = attemptOf(b);
	const wait = registry.start(attempt);
	registry.handBack(wait.key);
	release("pass");
	await registry.settled(wait.key);
	assert.equal(b.sent.length, 1);

	// Too early: nothing happens.
	clock = new Date("2026-09-05T10:01:00Z");
	assert.deepEqual(registry.resendDue(clock), []);
	// Past the window: exactly one resend, and then never again.
	clock = new Date("2026-09-05T10:02:30Z");
	assert.deepEqual(registry.resendDue(clock), ["cp-a|gate|1"]);
	assert.equal(b.sent.length, 2);
	clock = new Date("2026-09-05T10:10:00Z");
	assert.deepEqual(registry.resendDue(clock), []);
	assert.equal(b.sent.length, 2);

	// A confirmed key leaves the in-flight set.
	const { attempt: second, release: release2 } = attemptOf(b, { attempt: 2 });
	const wait2 = registry.start({
		...second,
		finish: async () => ({ jobId: "cp-a", surface: "gate", attempt: 2, content: "v", details: {} }),
	});
	registry.handBack(wait2.key);
	release2("pass");
	await registry.settled(wait2.key);
	assert.deepEqual(registry.confirm(["cp-a|gate|2", "cp-a|gate|9"]), ["cp-a|gate|2"]);
	clock = new Date("2026-09-05T10:20:00Z");
	assert.deepEqual(registry.resendDue(clock), []);
	const events = readRunEvents(b.home, "cp-a").filter((event) => event.type === "verdict_wakeup_sent");
	assert.equal(events.length, 3, "two firsts and one resend, all journaled");
	assert.equal(events.filter((event) => (event.payload as { resend?: boolean }).resend === true).length, 1);
});

test("a wake-up the staleness check withheld keeps its resend eligibility, bounded (pi-command-post-b04)", async (t) => {
	// cp-cjmu's second half: the pass was suppressed at send time by a lagging CI
	// observation, the one-shot resend was spent on a copy that also went nowhere,
	// and the key was dropped — so no card ever arrived, even after the watcher
	// caught up. A send that delivered nothing must not spend the resend.
	const b = benchOf(t);
	let clock = new Date("2026-09-05T10:00:00Z");
	let suppressed = true;
	const attempts: ReviewWakeup[] = [];
	const registry = new ReviewRuns({
		home: b.home,
		runs: b.runs,
		wakeup: (wakeup) => {
			attempts.push(wakeup);
			if (suppressed) return false;
			b.sent.push(wakeup);
			return true;
		},
		now: () => clock,
	});
	const { attempt, release } = attemptOf(b);
	const wait = registry.start(attempt);
	registry.handBack(wait.key);
	release("pass");
	await registry.settled(wait.key);
	assert.equal(attempts.length, 1);
	assert.equal(b.sent.length, 0, "withheld: nothing reached the parent");

	// Still stale, window after window — including past the point a five-send
	// bound would have expired (8 minutes). The watcher it is waiting on can be a
	// full CI_WATCH_MAX_BACKOFF_MS (15 minutes) from its next look, so a bound
	// shorter than that drops the verdict before the fact it needs can arrive.
	for (const minute of [2.5, 5, 7.5, 10, 12]) {
		clock = new Date("2026-09-05T10:00:00Z");
		clock = new Date(clock.getTime() + minute * 60_000);
		assert.deepEqual(registry.resendDue(clock), ["cp-a|gate|1"], `still eligible at ${minute} minutes`);
		assert.equal(b.sent.length, 0, "a withheld attempt delivers nothing, so it duplicates nothing");
	}

	// The watcher catches up — well past the old window — and the card lands.
	suppressed = false;
	clock = new Date("2026-09-05T10:14:30Z");
	assert.deepEqual(registry.resendDue(clock), ["cp-a|gate|1"]);
	assert.equal(b.sent.length, 1, "the verdict eventually reaches the parent");
	assert.ok(
		VERDICT_SUPPRESSED_RETRY_MAX_SECONDS * 1000 > CI_WATCH_MAX_BACKOFF_MS,
		"the retry window must outlast the watcher's own worst-case backoff",
	);

	// And a delivered copy still spends the one resend: no stream.
	clock = new Date("2026-09-05T10:17:00Z");
	assert.deepEqual(registry.resendDue(clock), []);
	assert.equal(b.sent.length, 1);
	assert.equal(attempts.length, 7, "six withheld attempts and the one that landed");
});

test("a wake-up that stays withheld terminates at the retry window, never retried forever", async (t) => {
	const b = benchOf(t);
	const start = new Date("2026-09-05T10:00:00Z");
	let clock = start;
	const attempts: ReviewWakeup[] = [];
	const registry = new ReviewRuns({
		home: b.home,
		runs: b.runs,
		wakeup: (wakeup) => (attempts.push(wakeup), false),
		now: () => clock,
	});
	const { attempt, release } = attemptOf(b);
	const wait = registry.start(attempt);
	registry.handBack(wait.key);
	release("pass");
	await registry.settled(wait.key);

	// One tick short of the window: still eligible.
	clock = new Date(start.getTime() + (VERDICT_SUPPRESSED_RETRY_MAX_SECONDS - 60) * 1000);
	assert.deepEqual(registry.resendDue(clock), ["cp-a|gate|1"]);
	const spent = attempts.length;

	// At the window it is dropped, and every later tick is a no-op forever after.
	clock = new Date(start.getTime() + VERDICT_SUPPRESSED_RETRY_MAX_SECONDS * 1000);
	assert.deepEqual(registry.resendDue(clock), []);
	clock = new Date(start.getTime() + 10 * VERDICT_SUPPRESSED_RETRY_MAX_SECONDS * 1000);
	assert.deepEqual(registry.resendDue(clock), []);
	assert.equal(attempts.length, spent, "nothing is handed to the transport once the window is spent");
});

test("a pending.json that does not validate is skipped and reported, never thrown on", async (t) => {
	const b = benchOf(t);
	const file = join(b.home, paths.pendingReviewFile("cp-a", "gate", 1));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "{not json");
	assert.equal(readPendingReview(b.home, "cp-a", "gate", 1), undefined);
	const report = await b.registry.sweepOrphans({ gate: async () => undefined }, ["cp-a"]);
	assert.equal(report.finished.length, 0);
	assert.equal(report.skipped.length, 0, "an unreadable file is not a pending review");
	assert.equal(readFileSync(file, "utf8"), "{not json", "and it is never rewritten");
});

test("passing verdict settles and wakes the parent before deadline integration", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const order: string[] = [];
	const clock = deadlineClock("2026-10-07T10:00:00Z");
	const record = {
		job_id: "cp-v2", branch: "cp-v2", project: "demo", kind: "ship", phase: "held", delivery: "pr",
		reported_at: "2026-09-05T09:00:00Z", supersessions: 0,
		receipts: [{ kind: "pr", status: "open", title: "PR", url: "https://github.com/o/r/pull/7" }],
	} as unknown as FleetRecord;
	const continuation = new HeldContinuation({
		enabled: () => true,
		now: clock.now, schedule: clock.schedule,
		reviewWindow: (jobId, head) => readReviewMergeWindow(home.path, jobId, head, clock.now()),
		fleet: { get: () => record, list: () => [record] } as never,
		advance: async (jobId) => {
			order.push(existsSync(join(home.path, paths.reviewFile(jobId, 1))) ? "advance:decided" : "advance:undecided");
			return { next: "done", step: "done", reason: "merged", facts: [] } as unknown as IntegrateResult;
		},
		review: async () => assert.fail("a passing verdict never starts another review"),
		reviews: { pending: () => undefined, handBack: () => {} },
		head: () => "a".repeat(40),
		notify: () => void order.push("notice"),
		relay: () => void order.push("notice"),
	});
	const registry = new ReviewRuns({
		home: home.path,
		wakeup: () => (order.push("wakeup"), true),
		beforeWakeup: (wakeup) => continuation.onVerdict(wakeup),
	});
	let release: (outcome: string) => void = () => {};
	const wait = registry.start<string>({
		jobId: "cp-v2", surface: "review", attempt: 1, model: "mock/reviewer", deadline: "2026-09-05T10:15:00Z",
		wait: () => new Promise<string>((resolve) => (release = resolve)),
		finish: async (outcome) => {
			assert.equal(outcome, "pass");
			writeWindowPass(home.path, "cp-v2", "a".repeat(40), clock.now().toISOString());
			return { jobId: "cp-v2", surface: "review", attempt: 1, headSha: "a".repeat(40), content: "pass", details: { next: "proceed" } };
		},
	});
	registry.handBack(wait.key);
	release("pass");
	await registry.settled(wait.key);
	assert.deepEqual(order, ["notice", "wakeup"], "durable pass and notice reach the operator without a GitHub read or merge");
	assert.equal(registry.pending("cp-v2", "review"), undefined, "the reviewer slot is released during the interval");
	clock.tick(Date.parse("2026-10-07T10:00:30Z") - 1);
	assert.deepEqual(order, ["notice", "wakeup"]);
	clock.tick(clock.now().getTime() + 1);
	await continuation.serialize("cp-v2", async () => {});
	assert.deepEqual(order, ["notice", "wakeup", "advance:decided", "notice"]);
	assert.equal(clock.tasks.size, 0);
	continuation.stop();
});
