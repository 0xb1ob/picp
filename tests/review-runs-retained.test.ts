import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type PendingReview, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { listPendingReviews, type ReviewAttempt, ReviewRuns, ReviewRunsError, type ReviewWakeup } from "../src/review-runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome } from "./harness/index.ts";

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
	const quality = b.registry.start({ ...attemptOf(b).attempt, surface: "quality", attempt: 1 });
	assert.equal(quality.surface, "quality");
	assert.equal(listPendingReviews(b.home, "cp-a").length, 2);
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
