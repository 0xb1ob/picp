# Asynchronous reviewers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cp_gate`, `cp_review` and the quality panel return `next: "wait"` the moment their reviewer is spawned, finish in the background, and wake the parent with a stamped `cp-verdict` message; `cp_pipeline advance` returns `wait` while any of them is pending.

**Architecture:** A new registry, `src/review-runs.ts`, owns the pending attempt (`pending.json`, an in-memory map, a handback promise, the orphan sweep) and is generic over what is being waited for. Each reviewer module splits at its `awaitVerdict` seam into `start()` (everything before the wait, then hand the waiter to the registry) and `finish()` (everything after the wait, unchanged), and the registry chains them. The wake-up is a sixth kind in `src/wakeups.ts` with its own staleness branch; the extension resolves the handback after composing the tool result and confirms arrival like it does for `cp-ci`.

**Tech Stack:** TypeScript (ES2023, `nodenext`, strict), Node 24, `node --test`, typebox, pi extension API (`@earendil-works/pi-coding-agent`).

**Spec:** `docs/superpowers/specs/2026-09-05-async-reviewers-design.md`

## Global Constraints

- Assumes PR 1 (`br_id` → `job_id`) and PR 2 (in-house ledger) of `2026-09-04-drop-br-ledger-design.md` have landed. Every identifier below says `job_id`, `jobId`, `JobIdSchema`, `requireJobId`, `isSafeJobId`. If a file you open still says `br_id`, stop: the prerequisite has not landed.
- Every file path is built through `paths.*` in `src/contracts.ts`. No literal `state/` anywhere in new code (single-project mode may move it).
- One pending attempt per `(job_id, surface)`; a second `start` returns the existing pending record.
- `finish` writes the decision file and deletes `pending.json` **before** it sends the wake-up (D8); it sends the wake-up only after `handBack` has been called for the attempt (D7).
- The ladders (`decideGate`, `nextAction`, `reviewCapExhausted`, `tallyVotes`), the revise caps, `REVIEW_MAX_ATTEMPTS`, the rubric and every decision file name are unchanged.
- `awaitVerdict` in `src/gate.ts` is unchanged and remains the only verdict waiter; `src/quality.ts`'s private copy is deleted (D10).
- Reviewers still die with the parent (`manager.shutdownAll()` on `session_shutdown`); nothing is detached or revived (D4).
- The wake-up kind is `verdict`, wire type `cp-verdict`, stamp `keys: [surface, String(attempt)]` plus `head_sha` as `keys[2]` for `surface: review`.
- `VERDICT_DELIVERY_RETRY_SECONDS = 120`.
- No new npm dependency. Every commit passes `npm run typecheck`; the PR passes `npm test`. Goldens regenerate with `CP_UPDATE_GOLDEN=1` and the diff is reviewed before committing.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Line numbers cited below are hints from 2026-09-05; the file may have drifted. Find the quoted code, not the number.

## File structure

| file | responsibility |
|---|---|
| `src/contracts.ts` | `REVIEW_SURFACES`, `PendingReviewSchema`, `QUALITY_PANEL_SLOT`, `PENDING_REVIEW_FILE`, `VERDICT_MESSAGE_TYPE`, `VERDICT_DELIVERY_RETRY_SECONDS`, `paths.pendingReviewFile`, `paths.reviewAttemptDir`, three event kinds, `StatusJobSchema.pending_review`. |
| `src/review-runs.ts` (new) | `ReviewRuns`: the pending map, `pending.json` lifecycle, handback, the `wait → finish → wakeup` chain, orphan sweep. Pure over fs; knows nothing about verdicts. |
| `tests/review-runs.test.ts` (new) | every registry rule, with fake waiters. |
| `src/gate.ts` | `GATE_NEXT` gains `wait`; `Gate.gate()` becomes `start()`/`finish()`/`status()`/`orphan()`; `formatGate` handles a waiting result. |
| `src/diff-review.ts` | same split; stat overflow stays synchronous. |
| `src/quality.ts` | `run()` becomes `start()`/`finish()`/`orphan()`; private waiter deleted. |
| `src/pipeline.ts` | `advance` returns `wait` while a review is pending; calls `start()`. |
| `src/wakeups.ts` | kind `verdict`, facts accessor `review()`, staleness branch, `verdictKeysFromMessage`. |
| `src/status.ts`, `src/widget.ts` | `pending_review` on the job row and the widget row. |
| `src/command-post.ts` | owns `reviewRuns`, passes it to the three modules and the pipeline; `confirmVerdict`, `sweepOrphanReviews`. |
| `extensions/command-post/index.ts` | `cp_gate`/`cp_review` `action`, `handBack` after composing results, `confirmVerdictArrival`, orphan sweep at `session_start`, `sendWakeup` port into `CommandPost`. |
| docs | `AGENTS.md`, `docs/contracts.md`, `src/wakeups.ts` header, `docs/superpowers/specs/2026-09-04-package-audit.md`. |

---

### Task 1: Contracts

**Files:**
- Modify: `src/contracts.ts` (new section after `GateConfigSchema`; `CP_EVENT_KINDS`; `paths`; `StatusJobSchema`)
- Test: `tests/contracts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REVIEW_SURFACES = ["gate", "review", "quality"] as const;
  export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
  export const ReviewSurfaceSchema; // StringEnum
  export const PENDING_REVIEW_FILE = "pending.json";
  export const QUALITY_PANEL_SLOT = "panel";
  export const VERDICT_MESSAGE_TYPE = "cp-verdict";
  export const VERDICT_DELIVERY_RETRY_SECONDS = 120;
  export const PendingReviewSchema; export type PendingReview = {
    schema_version: number; job_id: string; surface: ReviewSurface; attempt: number; model: string;
    pid?: number; started_at: string; deadline: string; handed_back: boolean;
    subject?: { head_sha: string; branch: string; files: number; truncated: boolean };
  };
  export function validatePendingReview(value: unknown): ValidationResult<PendingReview>;
  paths.reviewAttemptDir(jobId, surface, attempt): string   // gate-<n> | review-<n> | quality-panel
  paths.pendingReviewFile(jobId, surface, attempt): string  // <attemptDir>/pending.json
  CpEventKind gains "review_started" | "verdict_wakeup_sent" | "verdict_wakeup_delivered" | "review_orphaned"
  StatusJobSchema.pending_review?: { surface, attempt, started_at, deadline }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/contracts.test.ts` (extend the import from `../src/contracts.ts` with `paths`, `PENDING_REVIEW_FILE`, `QUALITY_PANEL_SLOT`, `REVIEW_SURFACES`, `validatePendingReview`, `CP_EVENT_KINDS`, `VERDICT_MESSAGE_TYPE`; do not duplicate names already imported):

```ts
// ---------------------------------------------------------------------------
// Pending reviews (spec 2026-09-05-async-reviewers)
// ---------------------------------------------------------------------------

test("pending review paths: one attempt directory per surface, the panel in its own slot", () => {
	assert.equal(paths.reviewAttemptDir("cp-a", "gate", 2), paths.gateRunDir("cp-a", 2));
	assert.equal(paths.reviewAttemptDir("cp-a", "review", 3), paths.reviewRunDir("cp-a", 3));
	assert.equal(paths.reviewAttemptDir("cp-a", "quality", 1), paths.qualityRunDir("cp-a", QUALITY_PANEL_SLOT));
	assert.equal(paths.pendingReviewFile("cp-a", "gate", 2), `${paths.gateRunDir("cp-a", 2)}/${PENDING_REVIEW_FILE}`);
	assert.throws(() => paths.pendingReviewFile("../x", "gate", 1));
	assert.throws(() => paths.pendingReviewFile("cp-a", "gate", 0));
	assert.throws(() => paths.reviewAttemptDir("cp-a", "quality", 2), /quality panel runs once/);
});

test("pending review documents validate closed, and the review subject is optional", () => {
	const base = {
		schema_version: 1,
		job_id: "cp-a",
		surface: "gate",
		attempt: 1,
		model: "mock/reviewer",
		pid: 4242,
		started_at: "2026-09-05T10:00:00Z",
		deadline: "2026-09-05T10:15:00Z",
		handed_back: false,
	};
	assert.ok(validatePendingReview(base).ok);
	assert.ok(
		validatePendingReview({
			...base,
			surface: "review",
			subject: { head_sha: "a".repeat(40), branch: "cp-a", files: 3, truncated: false },
		}).ok,
	);
	assert.equal(validatePendingReview({ ...base, surface: "panel" }).ok, false);
	assert.equal(validatePendingReview({ ...base, extra: 1 }).ok, false);
	assert.equal(validatePendingReview({ ...base, attempt: 0 }).ok, false);
	assert.deepEqual([...REVIEW_SURFACES], ["gate", "review", "quality"]);
	assert.equal(VERDICT_MESSAGE_TYPE, "cp-verdict");
	for (const kind of ["review_started", "verdict_wakeup_sent", "verdict_wakeup_delivered", "review_orphaned"]) {
		assert.ok((CP_EVENT_KINDS as readonly string[]).includes(kind), `${kind} missing from CP_EVENT_KINDS`);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/contracts.test.ts`
Expected: FAIL — `paths.reviewAttemptDir is not a function`, `validatePendingReview` not exported.

- [ ] **Step 3: Add the contracts**

In `src/contracts.ts`, directly after the gate config section (search for `export const GateConfigSchema`; add after its `export type GateConfig` line):

```ts
// ---------------------------------------------------------------------------
// Pending reviews (spec 2026-09-05-async-reviewers)
// ---------------------------------------------------------------------------

/** The three reviewer surfaces that run in the background and wake the parent. */
export const REVIEW_SURFACES = ["gate", "review", "quality"] as const;
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
export const ReviewSurfaceSchema = StringEnum([...REVIEW_SURFACES]);

/** One file per attempt directory while a reviewer is running; deleted by `finish`. */
export const PENDING_REVIEW_FILE = "pending.json";
/** The quality panel's own attempt slot; the votes keep `verify-<n>` and `completeness`. */
export const QUALITY_PANEL_SLOT = "panel";
/** The sixth unasked wake-up: a reviewer's verdict landed (D6). */
export const VERDICT_MESSAGE_TYPE = "cp-verdict";
/** An unconfirmed `cp-verdict` is re-derived from disk and sent once more after this. */
export const VERDICT_DELIVERY_RETRY_SECONDS = 120;

export const PendingReviewSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		job_id: JobIdSchema,
		surface: ReviewSurfaceSchema,
		attempt: Type.Integer({ minimum: 1 }),
		model: Type.String({ minLength: 1 }),
		/** Absent when the spawn never produced a pid (the brief was refused first). */
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		started_at: IsoTimestampSchema,
		deadline: IsoTimestampSchema,
		/** Flipped by `ReviewRuns.handBack` once the caller has its `wait` result (D7). */
		handed_back: Type.Boolean(),
		/**
		 * `surface: review` only: what the reviewer was pointed at, so an orphaned
		 * attempt can still be decided as a schema-valid `DiffVerdict` (which
		 * requires `head_sha` and `diff_stat`) and so the wake-up can carry the head.
		 */
		subject: Type.Optional(
			Type.Object(
				{
					head_sha: Type.String({ minLength: 1 }),
					branch: Type.String({ minLength: 1 }),
					files: Type.Integer({ minimum: 0 }),
					truncated: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type PendingReview = Replace<Static<typeof PendingReviewSchema>, { surface: ReviewSurface }>;

export function validatePendingReview(value: unknown): ValidationResult<PendingReview> {
	return validate<PendingReview>(PendingReviewSchema, value);
}
```

(`Replace`, `ValidationResult`, `validate`, `StringEnum`, `IsoTimestampSchema` and `JobIdSchema` already exist in this file; use the same names the neighbouring schemas use.)

In `CP_EVENT_KINDS`, after `"review_decided",` add:

```ts
	/** A reviewer was spawned and handed to the background (spec 2026-09-05). */
	"review_started",
	/** The `cp-verdict` wake-up for an attempt was handed to the transport. */
	"verdict_wakeup_sent",
	/** That wake-up was observed landing in the parent's context (cp-nx7). */
	"verdict_wakeup_delivered",
	/**
	 * An attempt whose reviewer died with a previous parent session was finished
	 * as an operational fault, with no worker (D4). The ladder decides what next.
	 */
	"review_orphaned",
```

In `paths`, after `reviewScratchDir`, add:

```ts
	/**
	 * The attempt directory a pending review lives in: the gate's and the diff
	 * review's own run directories, and the quality panel's reserved slot. The
	 * panel runs once per job, so its attempt is always 1.
	 */
	reviewAttemptDir(jobId: string, surface: ReviewSurface, attempt: number): string {
		switch (surface) {
			case "gate":
				return paths.gateRunDir(jobId, attempt);
			case "review":
				return paths.reviewRunDir(jobId, attempt);
			case "quality":
				if (attempt !== 1) throw new ContractError(`the quality panel runs once per job; attempt ${attempt} is not a thing`);
				return paths.qualityRunDir(jobId, QUALITY_PANEL_SLOT);
		}
	},
	pendingReviewFile(jobId: string, surface: ReviewSurface, attempt: number): string {
		return `${paths.reviewAttemptDir(jobId, surface, attempt)}/${PENDING_REVIEW_FILE}`;
	},
```

In `StatusJobSchema`, after `routing: Type.Optional(JobRoutingSchema),` add:

```ts
		/**
		 * A reviewer is running for this job in the background (spec
		 * 2026-09-05-async-reviewers). Read from the attempt directory's
		 * `pending.json`, files only; absent means no review is in flight.
		 */
		pending_review: Type.Optional(
			Type.Object(
				{
					surface: ReviewSurfaceSchema,
					attempt: Type.Integer({ minimum: 1 }),
					started_at: IsoTimestampSchema,
					deadline: IsoTimestampSchema,
				},
				{ additionalProperties: false },
			),
		),
```

If `ReviewSurfaceSchema` is declared below `StatusJobSchema` in the file, move the whole pending-review section above `StatusJobSchema` (typebox needs the value defined first).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts tests/contracts.test.ts
git commit -m "contracts: pending reviews, the cp-verdict wake-up type and review event kinds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `src/review-runs.ts` — the registry

**Files:**
- Create: `src/review-runs.ts`
- Create: `tests/review-runs.test.ts`

**Interfaces:**
- Consumes: `PendingReview`, `validatePendingReview`, `paths`, `REVIEW_SURFACES`, `isoTimestamp`, `SCHEMA_VERSION`, `type CpEventKind` from `src/contracts.ts`; `atomicWriteJson` from `src/json-store.ts`; `isPidAlive` from `src/fleet.ts`; `type RunRegistry` from `src/runs.ts`.
- Produces (used by Tasks 3–8):
  ```ts
  export interface ReviewWakeup {
    jobId: string; surface: ReviewSurface; attempt: number;
    /** `surface: review` only: the head the verdict describes (stamp keys[2]). */
    headSha?: string;
    content: string;                       // formatted result + directive line
    details: Record<string, unknown>;      // the full result object
  }
  export type WakeupPort = (wakeup: ReviewWakeup) => boolean;
  export interface ReviewWait { next: "wait"; surface: ReviewSurface; attempt: number; model: string; deadline: string; key: string }
  export interface ReviewAttempt<T> {
    jobId: string; surface: ReviewSurface; attempt: number; model: string; pid?: number; deadline: string;
    subject?: PendingReview["subject"];
    wait: () => Promise<T>;
    finish: (outcome: T) => Promise<ReviewWakeup | undefined>;
  }
  export type OrphanFinisher = (pending: PendingReview, reason: string) => Promise<ReviewWakeup | undefined>;
  export interface OrphanReport { finished: PendingReview[]; skipped: { pending: PendingReview; reason: string }[] }
  export class ReviewRuns {
    constructor(options: { home: string; wakeup?: WakeupPort; runs?: RunRegistry; now?: () => Date; isAlive?: (pid: number) => boolean });
    static key(jobId: string, surface: ReviewSurface, attempt: number): string;   // `${jobId}#${surface}-${attempt}`
    pending(jobId: string, surface: ReviewSurface): PendingReview | undefined;   // memory first, then disk
    pendingFor(jobId: string): PendingReview[];                                  // every surface, files only
    start<T>(attempt: ReviewAttempt<T>): ReviewWait;                             // throws ReviewRunsError on a live duplicate
    handBack(key: string): void;
    settled(key: string): Promise<void>;                                         // resolves when finish has run (tests)
    sweepOrphans(finishers: Partial<Record<ReviewSurface, OrphanFinisher>>, jobIds: readonly string[]): Promise<OrphanReport>;
    /** Arrival evidence for `${job}|${surface}|${attempt}` keys; returns the keys that were still unconfirmed. */
    confirm(keys: readonly string[]): string[];
    /** Resend, once, every sent-but-unconfirmed wake-up older than VERDICT_DELIVERY_RETRY_SECONDS. Returns the keys resent. */
    resendDue(now?: Date): string[];
    set wakeupPort(port: WakeupPort | undefined);
  }
  export class ReviewRunsError extends Error { readonly pending: PendingReview }
  export function readPendingReview(home: string, jobId: string, surface: ReviewSurface, attempt: number): PendingReview | undefined;
  export function listPendingReviews(home: string, jobId: string): PendingReview[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/review-runs.test.ts`:

```ts
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
import { type PendingReview, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { RunRegistry } from "../src/runs.ts";
import {
	listPendingReviews,
	readPendingReview,
	type ReviewAttempt,
	ReviewRuns,
	ReviewRunsError,
	type ReviewWakeup,
} from "../src/review-runs.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

interface Bench {
	home: string;
	runs: RunRegistry;
	sent: ReviewWakeup[];
	registry: ReviewRuns;
	alive: Set<number>;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }, options: { failSend?: boolean } = {}): Bench {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	const sent: ReviewWakeup[] = [];
	const alive = new Set<number>();
	const registry = new ReviewRuns({
		home: home.path,
		runs,
		wakeup: (wakeup) => {
			if (options.failSend) throw new Error("transport down");
			sent.push(wakeup);
			return true;
		},
		now: () => new Date("2026-09-05T10:00:00Z"),
		isAlive: (pid) => alive.has(pid),
	});
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return { home: home.path, runs, sent, registry, alive };
}

/** A waiter the test releases by hand, and a finish that records what it saw. */
function attemptOf(
	b: Bench,
	overrides: Partial<ReviewAttempt<string>> & { finished?: string[]; wake?: boolean } = {},
): { attempt: ReviewAttempt<string>; release: (outcome: string) => void; finished: string[] } {
	let release: (outcome: string) => void = () => {};
	const finished: string[] = overrides.finished ?? [];
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
			writeFileSync(join(b.home, paths.gateFile("cp-a", 1)), JSON.stringify({ outcome }));
			if (overrides.wake === false) return undefined;
			return { jobId: "cp-a", surface: "gate", attempt: 1, content: `verdict: ${outcome}`, details: { outcome } };
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
				writeFileSync(join(b.home, paths.gateFile("cp-a", pending.attempt)), "{}");
				return { jobId: "cp-a", surface: "gate", attempt: pending.attempt, content: "lost", details: {} };
			},
		},
		["cp-a"],
	);
	assert.equal(report.finished.length, 2);
	assert.deepEqual(reasons, [
		"1:reviewer lost with the parent session",
		"2:reviewer lost with the parent session",
	]);
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 1))), false);
	assert.equal(existsSync(join(b.home, paths.pendingReviewFile("cp-a", "gate", 2))), false);
	// Only the attempt the parent had been told to wait for wakes it.
	assert.deepEqual(b.sent.map((wakeup) => wakeup.attempt), [told.attempt]);
	const events = readRunEvents(b.home, "cp-a").filter((event) => event.type === "review_orphaned");
	assert.equal(events.length, 2);
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
	const registry = new ReviewRuns({ home: b.home, runs: b.runs, wakeup: (wakeup) => (b.sent.push(wakeup), true), now: () => clock });
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
	const wait2 = registry.start({ ...second, finish: async () => ({ jobId: "cp-a", surface: "gate", attempt: 2, content: "v", details: {} }) });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/review-runs.test.ts`
Expected: FAIL — cannot find module `../src/review-runs.ts`.

- [ ] **Step 3: Write the registry**

Create `src/review-runs.ts`:

```ts
/**
 * ReviewRuns — the one place a background reviewer attempt is pending
 * (spec 2026-09-05-async-reviewers).
 *
 * Three surfaces (the plan gate, the diff review, the quality panel) each
 * spawn a one-shot reviewer and used to block the parent's tool call until
 * its verdict landed. They now split at that wait: everything before it is
 * the surface's `start()`, everything after it is its `finish()`, and this
 * registry chains the two around the waiter so the tool call can return
 * `wait` at once.
 *
 * What this module owns, and only this:
 *
 *  - **one pending attempt per (job, surface)** — a `start` that finds one is
 *    refused with the record, never allowed to spawn a second reviewer (D9);
 *  - **`pending.json`** in the attempt directory, written before the waiter
 *    starts and deleted before the wake-up is sent (D5, D8): the fact three
 *    readers agree on without a subprocess — the status view, the duplicate
 *    check and the orphan sweep;
 *  - **the handback barrier** (D7): a wake-up is not sent until the caller
 *    that started the attempt says it has composed its own result, because a
 *    reviewer that refuses its brief in under a second would otherwise wake
 *    the parent about an attempt the parent has not been told exists;
 *  - **the orphan sweep** (D4): a `pending.json` whose pid is dead and whose
 *    attempt has no decision belonged to a reviewer that died with a previous
 *    parent; it is finished as an operational fault by the owning surface, and
 *    the wake-up is sent only if the parent had been handed a `wait` for it.
 *
 * It knows nothing about verdicts. The waiter and the finisher are the
 * surface's; the registry only orders them, records them, and never lets an
 * attempt stay pending after its waiter has resolved or thrown.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	isoTimestamp,
	PENDING_REVIEW_FILE,
	type PendingReview,
	paths,
	REVIEW_SURFACES,
	type ReviewSurface,
	SCHEMA_VERSION,
	validatePendingReview,
	VERDICT_DELIVERY_RETRY_SECONDS,
} from "./contracts.ts";
import { isPidAlive } from "./fleet.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { RunRegistry } from "./runs.ts";

/** The wake-up a finished attempt asks the transport to send. */
export interface ReviewWakeup {
	jobId: string;
	surface: ReviewSurface;
	attempt: number;
	/** `surface: review` only: the head the verdict describes (stamp `keys[2]`). */
	headSha?: string;
	/** The formatted result plus one directive line. Never an artifact body. */
	content: string;
	/** The full result object, for `details`. */
	details: Record<string, unknown>;
}

/** The transport. Returns whether the wake-up was sent; may throw. */
export type WakeupPort = (wakeup: ReviewWakeup) => boolean;

/** What `start` hands back to its caller: the reviewer is running, nothing else. */
export interface ReviewWait {
	next: "wait";
	surface: ReviewSurface;
	attempt: number;
	model: string;
	deadline: string;
	key: string;
}

/** One attempt, as the owning surface describes it. `T` is the waiter's outcome. */
export interface ReviewAttempt<T> {
	jobId: string;
	surface: ReviewSurface;
	attempt: number;
	model: string;
	pid?: number;
	deadline: string;
	subject?: PendingReview["subject"];
	/** The background wait (`awaitVerdict`, or the panel's vote loop). */
	wait: () => Promise<T>;
	/** Everything after the wait: decide, write, deliver, clean up. */
	finish: (outcome: T) => Promise<ReviewWakeup | undefined>;
}

/** Finish an attempt whose reviewer is gone, with no worker to wait on. */
export type OrphanFinisher = (pending: PendingReview, reason: string) => Promise<ReviewWakeup | undefined>;

export interface OrphanReport {
	finished: PendingReview[];
	skipped: { pending: PendingReview; reason: string }[];
}

export const ORPHAN_REASON = "reviewer lost with the parent session";

export class ReviewRunsError extends Error {
	readonly pending: PendingReview;
	constructor(message: string, pending: PendingReview) {
		super(message);
		this.pending = pending;
	}
}

export interface ReviewRunsOptions {
	home: string;
	wakeup?: WakeupPort;
	runs?: RunRegistry;
	now?: () => Date;
	isAlive?: (pid: number) => boolean;
}

interface Slot {
	pending: PendingReview;
	handedBack: Promise<void>;
	handBack: () => void;
	/** Resolves once `finish` and the wake-up (or its failure) are done. */
	settled: Promise<void>;
}

/** Read one attempt's `pending.json`. Unreadable or invalid means "none". */
export function readPendingReview(
	home: string,
	jobId: string,
	surface: ReviewSurface,
	attempt: number,
): PendingReview | undefined {
	const file = join(home, paths.pendingReviewFile(jobId, surface, attempt));
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validatePendingReview(JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/** Every pending review for a job, across surfaces and attempts, files only. */
export function listPendingReviews(home: string, jobId: string): PendingReview[] {
	const runDir = join(home, paths.runDir(jobId));
	if (!existsSync(runDir)) return [];
	const found: PendingReview[] = [];
	for (const entry of readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const located = attemptOfDirName(entry.name);
		if (!located) continue;
		if (!existsSync(join(runDir, entry.name, PENDING_REVIEW_FILE))) continue;
		const pending = readPendingReview(home, jobId, located.surface, located.attempt);
		if (pending) found.push(pending);
	}
	return found.sort((a, b) => a.surface.localeCompare(b.surface) || a.attempt - b.attempt);
}

/** `gate-2` → gate/2, `review-3` → review/3, `quality-panel` → quality/1; anything else is not an attempt dir. */
function attemptOfDirName(name: string): { surface: ReviewSurface; attempt: number } | undefined {
	const gate = /^gate-(\d+)$/.exec(name);
	if (gate) return { surface: "gate", attempt: Number(gate[1]) };
	const review = /^review-(\d+)$/.exec(name);
	if (review) return { surface: "review", attempt: Number(review[1]) };
	if (name === paths.reviewAttemptDir("x", "quality", 1).split("/").at(-1)) return { surface: "quality", attempt: 1 };
	return undefined;
}

/** Does the attempt's decision file exist? The surface's own file names, read by shape. */
export function decisionExists(home: string, pending: PendingReview): boolean {
	switch (pending.surface) {
		case "gate":
			return existsSync(join(home, paths.gateFile(pending.job_id, pending.attempt)));
		case "review":
			return existsSync(join(home, paths.reviewFile(pending.job_id, pending.attempt)));
		case "quality":
			return existsSync(join(home, paths.qualityFile(pending.job_id)));
	}
}

export class ReviewRuns {
	readonly #options: ReviewRunsOptions;
	readonly #slots = new Map<string, Slot>();

	constructor(options: ReviewRunsOptions) {
		this.#options = options;
	}

	static key(jobId: string, surface: ReviewSurface, attempt: number): string {
		return `${jobId}#${surface}-${attempt}`;
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	#record(jobId: string, kind: "review_started" | "verdict_wakeup_sent" | "review_orphaned", payload: Record<string, unknown>): void {
		try {
			this.#options.runs?.open(jobId).cp(kind, payload);
		} catch {
			// The run log explains; it never decides. A log that cannot be written
			// must not change what happens to the attempt.
		}
	}

	/** The pending attempt for a slot: this process's memory first, then disk. */
	pending(jobId: string, surface: ReviewSurface): PendingReview | undefined {
		for (const slot of this.#slots.values()) {
			if (slot.pending.job_id === jobId && slot.pending.surface === surface) return slot.pending;
		}
		return listPendingReviews(this.#options.home, jobId).find((pending) => pending.surface === surface);
	}

	/** Every pending attempt for a job, files only (the status view's read). */
	pendingFor(jobId: string): PendingReview[] {
		return listPendingReviews(this.#options.home, jobId);
	}

	/**
	 * Register an attempt whose reviewer is already spawned, write its
	 * `pending.json`, start the waiter, and return `wait`. The chain
	 * `wait → finish → handback → wakeup` runs in the background; it never
	 * rejects, and it always clears the slot.
	 */
	start<T>(attempt: ReviewAttempt<T>): ReviewWait {
		const existing = this.pending(attempt.jobId, attempt.surface);
		if (existing) {
			throw new ReviewRunsError(
				`${attempt.jobId} already has a ${attempt.surface} review in flight (attempt ${existing.attempt}, ` +
					`started ${existing.started_at}, deadline ${existing.deadline}) — one reviewer per job and surface; wait for its cp-verdict wake-up`,
				existing,
			);
		}
		const key = ReviewRuns.key(attempt.jobId, attempt.surface, attempt.attempt);
		const pending: PendingReview = {
			schema_version: SCHEMA_VERSION,
			job_id: attempt.jobId,
			surface: attempt.surface,
			attempt: attempt.attempt,
			model: attempt.model,
			...(attempt.pid !== undefined ? { pid: attempt.pid } : {}),
			started_at: isoTimestamp(this.#now()),
			deadline: attempt.deadline,
			handed_back: false,
			...(attempt.subject ? { subject: attempt.subject } : {}),
		};
		atomicWriteJson(join(this.#options.home, paths.pendingReviewFile(pending.job_id, pending.surface, pending.attempt)), pending);
		this.#record(attempt.jobId, "review_started", {
			surface: pending.surface,
			attempt: pending.attempt,
			model: pending.model,
			...(pending.pid !== undefined ? { pid: pending.pid } : {}),
			deadline: pending.deadline,
		});

		let handBack: () => void = () => {};
		const handedBack = new Promise<void>((resolve) => {
			handBack = resolve;
		});
		const settled = this.#run(key, pending, attempt, handedBack);
		this.#slots.set(key, { pending, handedBack, handBack, settled });
		return { next: "wait", surface: pending.surface, attempt: pending.attempt, model: pending.model, deadline: pending.deadline, key };
	}

	async #run<T>(key: string, pending: PendingReview, attempt: ReviewAttempt<T>, handedBack: Promise<void>): Promise<void> {
		let wakeup: ReviewWakeup | undefined;
		try {
			let outcome: T;
			try {
				outcome = await attempt.wait();
			} catch (error) {
				// A waiter that throws is an operational outcome, never a pending
				// attempt nobody will ever finish. The surfaces' outcome types all
				// carry `operational`; the cast is the seam's one concession.
				outcome = { operational: `reviewer wait failed: ${(error as Error).message}` } as unknown as T;
			}
			try {
				wakeup = await attempt.finish(outcome);
			} catch (error) {
				this.#record(pending.job_id, "review_orphaned", {
					surface: pending.surface,
					attempt: pending.attempt,
					reason: `finish failed: ${(error as Error).message}`,
				});
			}
		} finally {
			// D8: the slot is cleared — and the file is gone — before anything is
			// announced. `finish` has already written the decision (or failed to,
			// in which case the next start/advance finds no decision and retries).
			this.#clear(pending);
		}
		if (!wakeup) {
			this.#slots.delete(key);
			return;
		}
		// D7: the caller holds its `wait` result before the parent hears the verdict.
		await handedBack;
		this.#send(wakeup);
		this.#slots.delete(key);
	}

	#clear(pending: PendingReview): void {
		rmSync(join(this.#options.home, paths.pendingReviewFile(pending.job_id, pending.surface, pending.attempt)), { force: true });
	}

	/** Sent wake-ups nobody has confirmed yet, by `${job}|${surface}|${attempt}`. */
	readonly #inFlight = new Map<string, { wakeup: ReviewWakeup; sentAt: number; resent: boolean }>();
	#port: WakeupPort | undefined;

	/** Tests and shutdown swap the transport after construction. */
	set wakeupPort(port: WakeupPort | undefined) {
		this.#port = port;
	}

	static deliveryKey(wakeup: Pick<ReviewWakeup, "jobId" | "surface" | "attempt">): string {
		return `${wakeup.jobId}|${wakeup.surface}|${wakeup.attempt}`;
	}

	#send(wakeup: ReviewWakeup, resend = false): void {
		let sent = false;
		try {
			sent = (this.#port ?? this.#options.wakeup)?.(wakeup) ?? false;
		} catch {
			sent = false;
		}
		this.#record(wakeup.jobId, "verdict_wakeup_sent", {
			surface: wakeup.surface,
			attempt: wakeup.attempt,
			sent,
			resend,
			...(wakeup.headSha ? { head_sha: wakeup.headSha } : {}),
		});
		// cp-nx7: a send is a hand-off to a queue, not evidence of arrival. Keep it
		// until the message is observed in the parent's context, or resent once.
		const key = ReviewRuns.deliveryKey(wakeup);
		const existing = this.#inFlight.get(key);
		this.#inFlight.set(key, { wakeup, sentAt: this.#now().getTime(), resent: resend || existing?.resent === true });
	}

	/** The message reached the parent: these keys are delivered. Returns the ones that were still in flight. */
	confirm(keys: readonly string[]): string[] {
		const fresh: string[] = [];
		for (const key of keys) {
			if (this.#inFlight.delete(key)) fresh.push(key);
		}
		return fresh;
	}

	/**
	 * Resend every unconfirmed wake-up older than the retry window, once each.
	 * A duplicate that lands is idempotent — acting on it means reading a
	 * decision file that has not changed — while a lost one is invisible, which
	 * is why this exists. After the one resend the key is dropped: two copies
	 * is the bound, not a stream.
	 */
	resendDue(now: Date = this.#now()): string[] {
		const resent: string[] = [];
		for (const [key, entry] of this.#inFlight) {
			if (entry.resent) {
				this.#inFlight.delete(key);
				continue;
			}
			if (now.getTime() - entry.sentAt < VERDICT_DELIVERY_RETRY_SECONDS * 1000) continue;
			this.#send(entry.wakeup, true);
			resent.push(key);
		}
		return resent;
	}

	/** The caller has composed its result: release the wake-up and flip the flag on disk. */
	handBack(key: string): void {
		const slot = this.#slots.get(key);
		if (!slot) return;
		slot.handBack();
		const file = join(this.#options.home, paths.pendingReviewFile(slot.pending.job_id, slot.pending.surface, slot.pending.attempt));
		if (existsSync(file)) {
			slot.pending = { ...slot.pending, handed_back: true };
			atomicWriteJson(file, slot.pending);
		}
	}

	/** Resolves once the attempt's chain has run to its end. For tests and shutdown. */
	async settled(key: string): Promise<void> {
		await this.#slots.get(key)?.settled;
	}

	/**
	 * Finish every attempt a previous parent left pending: a dead pid and no
	 * decision on disk. Live pids, decided attempts and surfaces with no
	 * finisher are reported and left alone. Nothing here spawns anything.
	 */
	async sweepOrphans(
		finishers: Partial<Record<ReviewSurface, OrphanFinisher>>,
		jobIds: readonly string[],
	): Promise<OrphanReport> {
		const report: OrphanReport = { finished: [], skipped: [] };
		const alive = this.#options.isAlive ?? isPidAlive;
		for (const jobId of jobIds) {
			for (const pending of listPendingReviews(this.#options.home, jobId)) {
				if (this.#slots.has(ReviewRuns.key(pending.job_id, pending.surface, pending.attempt))) continue;
				if (pending.pid !== undefined && alive(pending.pid)) {
					report.skipped.push({ pending, reason: "reviewer still alive" });
					continue;
				}
				if (decisionExists(this.#options.home, pending)) {
					// A crash between the decision write and the pending delete: the
					// decision stands, the marker is stale. Clear it without a wake-up —
					// the next start/advance reads the decision from disk.
					this.#clear(pending);
					report.skipped.push({ pending, reason: "decision already on disk" });
					continue;
				}
				const finisher = finishers[pending.surface];
				if (!finisher) {
					report.skipped.push({ pending, reason: `no finisher for ${pending.surface}` });
					continue;
				}
				let wakeup: ReviewWakeup | undefined;
				try {
					wakeup = await finisher(pending, ORPHAN_REASON);
				} finally {
					this.#clear(pending);
				}
				this.#record(pending.job_id, "review_orphaned", {
					surface: pending.surface,
					attempt: pending.attempt,
					reason: ORPHAN_REASON,
					handed_back: pending.handed_back,
				});
				report.finished.push(pending);
				if (wakeup && pending.handed_back) this.#send(wakeup);
			}
		}
		return report;
	}
}

/** Exported for the status view and the widget: which surfaces exist. */
export const SURFACES: readonly ReviewSurface[] = REVIEW_SURFACES;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/review-runs.test.ts`
Expected: PASS (11 tests). The resend test's `resent` entries are dropped on the *next* `resendDue` after their resend, which is why the third call returns `[]` and sends nothing.

- [ ] **Step 5: Commit**

```bash
git add src/review-runs.ts tests/review-runs.test.ts
git commit -m "review-runs: the registry of pending reviewer attempts

pending.json before the waiter, decision before the wake-up, wake-up after
the handback, one attempt per (job, surface), and the orphan sweep for
attempts a previous parent left behind.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `src/gate.ts` — split `gate()` into `start()` and `finish()`

**Files:**
- Modify: `src/gate.ts` (`GATE_NEXT`; `GateResult`; `GateOptions`; the `Gate` class; `formatGate`)
- Modify: `tests/gate.test.ts` (every `b.gate.gate(` call; bench)

**Interfaces:**
- Consumes: `ReviewRuns`, `type ReviewWait`, `type ReviewWakeup`, `ReviewRunsError` from `src/review-runs.ts`; `type PendingReview` from `src/contracts.ts`.
- Produces:
  ```ts
  export const GATE_NEXT = ["proceed", "revise", "retry", "surface", "authorize", "wait"] as const;
  export type GateStart = GateResult | GateWait;
  export interface GateWait extends ReviewWait { surface: "gate" }
  export function isGateWait(value: GateStart): value is GateWait;
  export interface GateOptions { ...existing; reviews?: ReviewRuns; onFinished?: (result: GateResult) => void }
  export interface GateRequest { ...existing; directive?: string }   // the wake-up's "Next:" line; default "act on next"
  class Gate {
    async start(request: GateRequest): Promise<GateStart>;
    async finish(input: { jobId: string; attempt: number; model: string; prior: PriorAttempts; outcome: { review?: GateReview; operational?: string }; deliverRevise: boolean; directive: string; managedKey?: string; recorder?: RunRecorder }): Promise<{ result: GateResult; wakeup: ReviewWakeup }>;
    status(jobId: string): { pending?: PendingReview; decisions: GateVerdict[] };
    async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined>;
    /** Test convenience, blocking: start, hand back, await settle, read the decision. */
    async gateAndWait(request: GateRequest): Promise<GateResult>;
  }
  export function gateDirective(result: GateResult, directive: string): string;  // formatGate + "\nNext: …"
  ```

- [ ] **Step 1: Convert the tests**

In `tests/gate.test.ts`:

1. In `benchOf`, after `const runs = new RunRegistry(home.path);` add:
   ```ts
   const sent: ReviewWakeup[] = [];
   const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
   ```
   Pass `reviews` into `new Gate({ ... })` as `reviews,` and add `sent` and `reviews` to the returned bench (and to the `Bench` interface: `sent: ReviewWakeup[]; reviews: ReviewRuns;`). Import `ReviewRuns, type ReviewWakeup` from `../src/review-runs.ts`.
2. Replace every `await b.gate.gate({` with `await b.gate.gateAndWait({` (13 sites). `gateAndWait` is the blocking convenience the tests keep; production never calls it.
3. Add these tests after the first worker-backed pass test:

```ts
test("start returns wait at once, writes pending.json, and the verdict arrives as a wake-up", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-async";
	b.writeArtifact(jobId);
	const model = b.script("gate-async", [verdictCall(jobId, { reasons: ["file list is concrete"] })]);
	b.seal();

	const started = await b.gate.start({ jobId, model, directive: "call cp_pipeline advance cp-gate-async" });
	assert.ok(isGateWait(started), `expected wait, got ${JSON.stringify(started)}`);
	assert.equal(started.attempt, 1);
	assert.equal(started.model, model);
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile(jobId, "gate", 1))), "pending.json while the reviewer runs");
	assert.equal(existsSync(join(b.home, paths.gateFile(jobId, 1))), false, "no decision yet");
	assert.equal(b.sent.length, 0);

	// A second start while one is pending is refused with the pending record.
	await assert.rejects(() => b.gate.start({ jobId, model }), /already has a gate review in flight/);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);

	assert.equal(existsSync(join(b.home, paths.pendingReviewFile(jobId, "gate", 1))), false);
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.verdict, "pass");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.surface, "gate");
	assert.equal(b.sent[0]?.attempt, 1);
	assert.match(b.sent[0]?.content ?? "", /gate attempt 1: pass/);
	assert.match(b.sent[0]?.content ?? "", /Next: call cp_pipeline advance cp-gate-async/);
	assert.ok(!b.sent[0]?.content.includes("ship it"), "the wake-up never carries the artifact");

	// After the decision, start returns the finished result, not another reviewer.
	const again = await b.gate.start({ jobId, model });
	assert.ok(!isGateWait(again));
	assert.equal(again.verdict.attempt, 1);
	assert.equal(again.next, "proceed");
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /review_started/);
	assert.match(events, /verdict_wakeup_sent/);
});

test("status reads pending and decided attempts from disk, changing nothing", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-status";
	b.writeArtifact(jobId);
	const model = b.script("gate-status", [verdictCall(jobId, { reasons: ["ok"] })]);
	b.seal();
	assert.deepEqual(b.gate.status(jobId), { decisions: [] });
	const started = await b.gate.start({ jobId, model });
	assert.ok(isGateWait(started));
	assert.equal(b.gate.status(jobId).pending?.attempt, 1);
	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	const after = b.gate.status(jobId);
	assert.equal(after.pending, undefined);
	assert.equal(after.decisions.length, 1);
});

test("orphan: an attempt with no reviewer is decided operational and the ladder says retry", async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-orphan";
	b.writeArtifact(jobId);
	const pending = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		surface: "gate" as const,
		attempt: 1,
		model: "mock/gone",
		pid: 999_999,
		started_at: isoTimestamp(),
		deadline: isoTimestamp(),
		handed_back: true,
	};
	const wakeup = await b.gate.orphan(pending, "reviewer lost with the parent session");
	assert.ok(wakeup);
	assert.match(wakeup.content, /escalate \(cause: operational\)/);
	assert.match(wakeup.content, /-> retry/);
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.cause, "operational");
	assert.ok(decision.reasons.some((reason) => reason.includes("reviewer lost with the parent session")));
});
```

Add `isGateWait` to the `../src/gate.ts` import and `SCHEMA_VERSION` to the contracts import if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gate.test.ts`
Expected: FAIL — `gateAndWait is not a function`, `isGateWait` not exported, `reviews` unknown option (typecheck).

- [ ] **Step 3: Rewrite the `Gate` class**

In `src/gate.ts`:

1. `GATE_NEXT` becomes `["proceed", "revise", "retry", "surface", "authorize", "wait"] as const`.
2. Add imports: `import { ReviewRuns, ReviewRunsError, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";` and `type PendingReview` from `./contracts.ts`.
3. Add to `GateOptions`:
   ```ts
   	/**
   	 * The registry that makes an attempt asynchronous (spec 2026-09-05). Absent
   	 * only in tests that exercise the pieces separately: production always
   	 * passes `CommandPost.reviewRuns`.
   	 */
   	reviews?: ReviewRuns;
   ```
4. Add to `GateRequest`:
   ```ts
   	/** The wake-up's "Next:" line. Default: "act on next=<value>". */
   	directive?: string;
   ```
5. Add after `GateResult`:
   ```ts
   export interface GateWait extends ReviewWait {
   	surface: "gate";
   }
   export type GateStart = GateResult | GateWait;
   export function isGateWait(value: GateStart): value is GateWait {
   	return (value as GateWait).next === "wait" && (value as GateWait).surface === "gate";
   }
   ```
6. Replace the whole `async gate(request: GateRequest): Promise<GateResult>` method with the three methods below, keeping `#resolveModel`, `#awaitVerdict` and `#deliverRevise` as they are:

```ts
	/**
	 * Spawn a reviewer and return `wait` (spec 2026-09-05). Everything that used
	 * to happen before `awaitVerdict` happens here; everything after it is
	 * `finish`, run by the registry when the waiter resolves. If this attempt is
	 * already decided on disk, the decision is returned as it stands.
	 */
	async start(request: GateRequest): Promise<GateStart> {
		const { home, artifacts, manager, runs, reviews } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const jobId = request.jobId;
		const directive = request.directive ?? "act on next";

		if (!artifacts.has(jobId)) {
			throw new GateError(
				`no artifact for ${jobId} — cannot gate. The planner must write ${artifacts.file(jobId)} first ` +
					"(cp_artifact add files an existing report into the store).",
			);
		}
		const pending = reviews?.pending(jobId, "gate");
		if (pending) {
			throw new ReviewRunsError(
				`${jobId} already has a gate review in flight (attempt ${pending.attempt}, started ${pending.started_at}, ` +
					`deadline ${pending.deadline}) — wait for its cp-verdict wake-up instead of starting another`,
				pending,
			);
		}

		const prior = readPriorAttempts(home, jobId);
		const attempt = prior.attempt;
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		const record = this.#options.fleet?.get(jobId);
		const model = this.#resolveModel(profile, jobId, prior, request.model);

		// The reviewer sees one file, in a directory that contains nothing else.
		const gateRunDir = join(home, paths.gateRunDir(jobId, attempt));
		const scratch = join(home, paths.gateScratchDir(jobId, attempt));
		mkdirSync(scratch, { recursive: true });
		const artifactCopy = artifacts.get(jobId, join(scratch, "artifact.md")).out;

		const brief = assembleBrief({
			profile,
			template: readBriefTemplate(this.#options.briefsDir, profile.frontmatter.briefTemplate),
			values: {
				job_id: jobId,
				project: record?.project ?? "unregistered",
				artifact_path: artifactCopy,
			},
		});
		writeFileSync(join(gateRunDir, "brief.md"), brief);

		const recorder = RunRecorder.open({ home, jobId, dir: gateRunDir });
		const key = `${jobId}#gate-${attempt}`;
		const timeoutMs = this.#options.reviewTimeoutMs ?? resolveReviewTimeoutMs(home);
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));
		const deliverRevise = request.deliverRevise ?? true;

		let managed: ReturnType<WorkerManager["spawn"]>;
		try {
			managed = manager.spawn({
				key,
				identity: {
					jobId,
					kind: "research",
					delivery: (record?.delivery ?? "pipeline") as Delivery,
					runDir: gateRunDir,
					worktree: scratch,
				},
				profile,
				model,
				brief,
				sessionDir: join(home, LAYOUT.sessions),
				sessionName: key,
				...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
			});
		} catch (error) {
			// A reviewer that cannot even start is an operational fault, not a
			// judgment about the artifact — decided now, synchronously, so the
			// ladder can retry. Nothing is pending because nothing is running.
			recorder.close();
			const { result } = await this.finish({
				jobId,
				attempt,
				model,
				prior,
				outcome: { operational: `reviewer could not run: ${(error as Error).message}` },
				deliverRevise,
				directive,
			});
			return result;
		}
		recorder.markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
		recorder.attach(managed.worker);

		const worker = managed.worker;
		const wait = async (): Promise<{ review?: GateReview; operational?: string }> => {
			const receipt = await worker.send(brief);
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });
			if (receipt.receipt === "failed") {
				return { operational: `reviewer refused the brief: ${receipt.error ?? "unknown error"}` };
			}
			return this.#awaitVerdict(jobId, attempt, worker);
		};

		if (!reviews) {
			// No registry (a unit test of the pieces): behave as the old blocking
			// gate did, so the ladder tests keep their shape.
			const outcome = await wait();
			return (await this.finish({ jobId, attempt, model, prior, outcome, deliverRevise, directive, managedKey: key, recorder })).result;
		}

		return {
			...reviews.start({
				jobId,
				surface: "gate",
				attempt,
				model,
				...(worker.pid !== undefined ? { pid: worker.pid } : {}),
				deadline,
				wait,
				finish: async (outcome) =>
					(await this.finish({ jobId, attempt, model, prior, outcome, deliverRevise, directive, managedKey: key, recorder })).wakeup,
			}),
			surface: "gate",
		};
	}

	/**
	 * Everything after the wait, unchanged from the blocking gate: decide, write
	 * `gate-<n>.json` (and the raw file), shut the reviewer down, clean scratch
	 * on a pass, record `gate_decided`, deliver a revise. Returns the result
	 * and the wake-up the registry sends once the caller has been handed `wait`.
	 */
	async finish(input: {
		jobId: string;
		attempt: number;
		model: string;
		prior: PriorAttempts;
		outcome: { review?: GateReview; operational?: string };
		deliverRevise: boolean;
		directive: string;
		managedKey?: string;
		recorder?: RunRecorder;
	}): Promise<{ result: GateResult; wakeup: ReviewWakeup }> {
		const { home, manager, runs } = this.#options;
		const now = this.#options.now ?? (() => new Date());
		const { jobId, attempt, model, prior } = input;
		const { review, operational } = input.outcome;

		// One-shot: the reviewer never survives its own verdict.
		if (input.managedKey) await manager.shutdown(input.managedKey);
		input.recorder?.close();

		const { raw, ...verdict } = decideGate({
			jobId,
			attempt,
			prior,
			model,
			...(review ? { review } : {}),
			...(operational ? { operational } : {}),
			at: isoTimestamp(now()),
		});
		const validated = validate<GateVerdict>(GateVerdictSchema, verdict);
		if (!validated.ok) {
			throw new GateError(`gate decision for ${jobId} violates the contract:\n  ${validated.errors.join("\n  ")}`);
		}
		const path = join(home, paths.gateFile(jobId, attempt));
		atomicWriteJson(path, verdict);
		if (raw) {
			const rawPath = join(home, paths.gateFileRaw(jobId, attempt));
			atomicWriteJson(rawPath, { ...verdict, reasons: raw.reasons, ...(raw.revisions ? { revisions: raw.revisions } : {}) });
		}

		if (verdict.verdict === "pass") {
			try {
				const removal = removeGateScratch({
					home,
					jobId,
					attempt,
					...(this.#options.rmScratch ? { rm: this.#options.rmScratch } : {}),
				});
				runs?.open(jobId).cp("gate_scratch_removed", {
					attempt,
					dir: removal.dir,
					removed: removal.removed,
					reason: removal.reason,
					...(removal.error ? { error: removal.error } : {}),
				});
			} catch {
				// Cleanup is never allowed to change a decided verdict.
			}
		}

		const result: GateResult = {
			verdict,
			next: nextAction(verdict),
			path,
			model,
			...(review ? { review } : {}),
		};
		runs?.open(jobId).cp("gate_decided", {
			attempt,
			verdict: verdict.verdict,
			cause: verdict.cause,
			model,
			next: result.next,
			path,
		});
		if (result.next === "revise" && input.deliverRevise) {
			await this.#deliverRevise(result);
		}
		const wakeup: ReviewWakeup = {
			jobId,
			surface: "gate",
			attempt,
			content: gateDirective(result, input.directive),
			details: result as unknown as Record<string, unknown>,
		};
		return { result, wakeup };
	}

	/** What is on disk for this job's gate: the pending attempt, if any, and every decision. */
	status(jobId: string): { pending?: PendingReview; decisions: GateVerdict[] } {
		const pending = this.#options.reviews?.pending(jobId, "gate");
		return { ...(pending ? { pending } : {}), decisions: readPriorAttempts(this.#options.home, jobId).decisions };
	}

	/**
	 * Finish an attempt whose reviewer died with a previous parent (D4): no
	 * worker, an operational outcome, the ordinary ladder. The registry decides
	 * whether the wake-up is sent (only when the parent had been handed `wait`).
	 */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		const prior = readPriorAttempts(this.#options.home, pending.job_id);
		if (prior.attempt !== pending.attempt) return undefined; // decided meanwhile
		return (
			await this.finish({
				jobId: pending.job_id,
				attempt: pending.attempt,
				model: pending.model,
				prior,
				outcome: { operational: reason },
				deliverRevise: false,
				directive: "act on next",
			})
		).wakeup;
	}

	/**
	 * Blocking convenience for tests: start, hand back, await the registry's
	 * chain, and return the decision the wake-up described. Production code
	 * never calls this — the whole point of the split is that it does not wait.
	 */
	async gateAndWait(request: GateRequest): Promise<GateResult> {
		const started = await this.start(request);
		if (!isGateWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new GateError("gateAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		const decisions = readPriorAttempts(this.#options.home, request.jobId).decisions;
		const verdict = decisions[started.attempt - 1];
		if (!verdict) throw new GateError(`attempt ${started.attempt} for ${request.jobId} left no decision on disk`);
		return { verdict, next: nextAction(verdict), path: join(this.#options.home, paths.gateFile(request.jobId, started.attempt)), model: started.model };
	}
```

Note `LAYOUT.sessions`: if `LAYOUT` has no `sessions` entry, add `sessions: "state/sessions"` to it in `src/contracts.ts` (the literal `join(home, "state/sessions")` appears three times across the three modules and must go through `LAYOUT` now — see Global Constraints).

7. After `formatGate`, add:

```ts
/** The wake-up body: the decision, then one line saying what to do with it. */
export function gateDirective(result: GateResult, directive: string): string {
	return `${formatGate(result)}\nNext: ${directive}.`;
}

/** One line for a tool result that returned `wait`. */
export function formatGateWait(wait: GateWait): string {
	return (
		`${wait.surface} review attempt ${wait.attempt} is running [${wait.model}] -> wait\n` +
		`  deadline: ${wait.deadline}\n` +
		"  End the turn; a cp-verdict wake-up will arrive with the verdict. Do not call status to wait."
	);
}
```

8. `gateAndWait` rebuilds its result from the decision file, so it carries no `review`, `revise_receipt` or `revise_error`. A converted test that asserted `result.review.*` reads the reviewer's `verdict.json` (`paths.gateVerdictFile`) instead. Anywhere the conversions reveal a test that asserted `revise_receipt` on the result (the "revise: the verdict is promoted" test): `gateAndWait` rebuilds the result from disk and has no receipt, so change those assertions to read the receipt from the job's run log, which the existing test already does two lines later (`prompt_sent ... "receipt":"delivered"`). Delete the two `result.revise_receipt` / `result.revise_error` assertions in that test and keep the log assertions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/gate.test.ts`
Expected: PASS. If the operational-retry tests time out, check that `finish` is called with `managedKey` (so `manager.shutdown` runs) in the `!reviews` fallback and in the registry path alike.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts src/contracts.ts tests/gate.test.ts
git commit -m "gate: start() returns wait, finish() decides in the background

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `src/diff-review.ts` and `src/quality.ts` — the same split

**Files:**
- Modify: `src/diff-review.ts` (`DiffReviewOptions`, `DiffReviewRequest`, `DiffReviewResult`, `review()`)
- Modify: `src/quality.ts` (`QualityOptions`, `run()`, `#review`, delete `#awaitVerdict`)
- Modify: `tests/diff-review.test.ts`, `tests/quality.test.ts`

**Interfaces:**
- Consumes: `ReviewRuns`, `ReviewRunsError`, `type ReviewWait`, `type ReviewWakeup` from `src/review-runs.ts`; `awaitVerdict` from `src/gate.ts`.
- Produces:
  ```ts
  // diff-review.ts
  export interface DiffReviewWait extends ReviewWait { surface: "review"; head_sha: string }
  export type DiffReviewStart = DiffReviewResult | DiffReviewWait;
  export function isDiffReviewWait(v: DiffReviewStart): v is DiffReviewWait;
  export interface DiffReviewOptions { ...existing; reviews?: ReviewRuns }
  export interface DiffReviewRequest { ...existing; directive?: string }
  class DiffReview {
    async start(request: DiffReviewRequest): Promise<DiffReviewStart>;   // replaces review()
    async finish(input: {...}): Promise<{ result: DiffReviewResult; wakeup: ReviewWakeup }>;
    async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined>;
    async reviewAndWait(request: DiffReviewRequest): Promise<DiffReviewResult>;   // tests only
  }
  export function diffReviewDirective(result: DiffReviewResult, directive: string): string;
  // quality.ts
  export interface QualityWait extends ReviewWait { surface: "quality" }
  export type QualityStart = QualityReport | QualityWait | undefined;
  export function isQualityWait(v: QualityStart): v is QualityWait;
  export interface QualityOptions { ...existing; reviews?: ReviewRuns }
  export interface QualityRequest { ...existing; directive?: string }
  class QualityPass {
    async start(request: QualityRequest): Promise<QualityStart>;   // replaces run()
    async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined>;
    async runAndWait(request: QualityRequest): Promise<QualityReport | undefined>;   // tests only
  }
  ```

- [ ] **Step 1: Convert the diff-review tests**

In `tests/diff-review.test.ts`, the bench is `reviewBenchOf(t)` and returns `{ home, repo, provider, fleet, manager, runs, review, script, seal, pushJobBranch(jobId, files?) → head sha, shipRecord(jobId, overrides?) }`. In `reviewBenchOf`, after `const runs = new RunRegistry(home.path);` add

```ts
	const sent: ReviewWakeup[] = [];
	const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
```

pass `reviews,` into `new DiffReview({...})`, and add `sent` and `reviews` to the returned object and to `ReviewBench` (`sent: ReviewWakeup[]; reviews: ReviewRuns;`). Import `ReviewRuns, readPendingReview, type ReviewWakeup` from `../src/review-runs.ts` and `isDiffReviewWait` from `../src/diff-review.ts`. Replace every `b.review.review({` with `b.review.reviewAndWait({` (the three `assert.rejects` sites and the two result sites), then add:

```ts
test("start returns wait with the head under review; the wake-up carries that head", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-async";
	const head = b.pushJobBranch(jobId);
	await b.shipRecord(jobId);
	const model = b.script("review-async", [verdictCall(jobId, { reasons: ["diff is small and tested"] })]);
	b.seal();

	const started = await b.review.start({ jobId, model });
	assert.ok(isDiffReviewWait(started), JSON.stringify(started));
	assert.equal(started.surface, "review");
	assert.equal(started.head_sha, head);
	const pending = readPendingReview(b.home, jobId, "review", 1);
	assert.equal(pending?.subject?.head_sha, head);
	assert.equal(pending?.subject?.branch, jobId);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	assert.equal(readPendingReview(b.home, jobId, "review", 1), undefined);
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.headSha, head);
	assert.match(b.sent[0]?.content ?? "", /review attempt 1: pass/);
	assert.ok(!b.sent[0]?.content.includes(BODY_MARKER), "the wake-up never carries the diff");
});

test("a stat overflow is decided synchronously: no pending, no wake-up", { timeout: 120_000 }, async (t) => {
	const b = await reviewBenchOf(t);
	const jobId = "cp-review-wide";
	b.pushJobBranch(jobId, { "a.ts": "1\n", "b.ts": "2\n" });
	await b.shipRecord(jobId);
	b.seal();
	const started = await b.review.start({ jobId, maxStatFiles: 1 });
	assert.ok(!isDiffReviewWait(started));
	assert.equal(started.verdict.cause, "policy");
	assert.equal(readPendingReview(b.home, jobId, "review", 1), undefined);
	assert.equal(b.sent.length, 0);
});
```

`verdictCall` and `BODY_MARKER` already exist in this file; `maxStatFiles` is an existing `DiffReviewRequest` field (see `request.maxStatFiles` in `src/diff-review.ts`).

- [ ] **Step 2: Convert the quality tests**

In `tests/quality.test.ts`, the bench is `bench(t)` returning `{ home, artifacts, pass(model, options?) → QualityPass, script, seal }`. In `bench`, add `const runs = new RunRegistry(home.path);`, `const sent: ReviewWakeup[] = [];` and `const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });`, pass `reviews,` into `new QualityPass({...})`, close `runs` in `t.after`, and return `sent` and `reviews` too. Replace every `.run({` on a `QualityPass` with `.runAndWait({`. The file writes artifacts with a helper (search `artifacts.path(` near the first panel test) — call it `writeArtifact(jobId)` below. Add:

```ts
test("the panel is one pending attempt in its own slot, and one wake-up", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-async";
	writeArtifact(b, jobId);
	const model = b.script("q-async", [verdictStep(jobId, "pass"), verdictStep(jobId, "pass")]);
	b.seal();
	const pass = b.pass(model);

	const started = await pass.start({ jobId, task: "t", config: { verify: true, voters: 2, threshold: 1 } });
	assert.ok(isQualityWait(started), JSON.stringify(started));
	assert.equal(started.attempt, 1);
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile(jobId, "quality", 1))));
	assert.equal(existsSync(join(b.home, paths.qualityRunDir(jobId, "verify-1"), PENDING_REVIEW_FILE)), false, "votes carry no pending file");

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	assert.ok(existsSync(join(b.home, paths.qualityFile(jobId))));
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.surface, "quality");
	assert.match(b.sent[0]?.content ?? "", /quality pass: passed/);
	// One pass per job: a second start returns the report, spawning nothing.
	const again = await pass.start({ jobId, task: "t", config: { verify: true } });
	assert.ok(again && !isQualityWait(again));
	assert.equal(again.passed, true);
});

test("an orphaned panel writes no report and asks for the panel to run again", async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-orphan";
	writeArtifact(b, jobId);
	const wakeup = await b.pass("mock/none").orphan(
		{ schema_version: SCHEMA_VERSION, job_id: jobId, surface: "quality", attempt: 1, model: "m", pid: 999_999, started_at: isoTimestamp(), deadline: isoTimestamp(), handed_back: true },
		"reviewer lost with the parent session",
	);
	assert.ok(wakeup);
	assert.match(wakeup.content, /quality panel .* was lost .* run the panel again/);
	assert.equal(existsSync(join(b.home, paths.qualityFile(jobId))), false);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `node --test tests/diff-review.test.ts tests/quality.test.ts`
Expected: FAIL — `start`/`reviewAndWait`/`runAndWait` not functions.

- [ ] **Step 4: Split `DiffReview.review()`**

In `src/diff-review.ts`:

1. Imports: `import { ReviewRuns, ReviewRunsError, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";` and `type PendingReview` from contracts.
2. `DiffReviewOptions` gains `reviews?: ReviewRuns;`. `DiffReviewRequest` gains `directive?: string;`.
3. Add after `DiffReviewResult`:
   ```ts
   export interface DiffReviewWait extends ReviewWait {
   	surface: "review";
   	head_sha: string;
   }
   export type DiffReviewStart = DiffReviewResult | DiffReviewWait;
   export function isDiffReviewWait(value: DiffReviewStart): value is DiffReviewWait {
   	return (value as DiffReviewWait).next === "wait" && (value as DiffReviewWait).surface === "review";
   }
   ```
4. Rename `async review(request)` to `async start(request): Promise<DiffReviewStart>`. Keep steps 1–4 (preconditions, attempt bookkeeping, materialize, stat overflow → `return this.#persist(...)`) verbatim, except: before step 2, add the pending check
   ```ts
   		const pending = this.#options.reviews?.pending(jobId, "review");
   		if (pending) {
   			throw new ReviewRunsError(
   				`${jobId} already has a diff review in flight (attempt ${pending.attempt}, started ${pending.started_at}) — ` +
   					"wait for its cp-verdict wake-up instead of starting another",
   				pending,
   			);
   		}
   ```
   Replace step 5 (from `const recorder = RunRecorder.open(` to the end of the method) with:

```ts
		const recorder = RunRecorder.open({ home, jobId, dir: runDir });
		const key = `${jobId}#review-${attempt}`;
		const timeoutMs = this.#options.reviewTimeoutMs ?? resolveReviewTimeoutMs(home);
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));
		const deliverRevise = request.deliverRevise ?? true;
		const directive = request.directive ?? "act on next";
		const subject = { head_sha: headSha, branch, files: diff.files, truncated: diff.truncated };

		let managed: ReturnType<WorkerManager["spawn"]>;
		try {
			managed = manager.spawn({
				key,
				identity: { jobId, kind: "research", delivery: (record.delivery ?? "pr") as Delivery, runDir, worktree: scratch },
				profile,
				model,
				brief,
				sessionDir: join(home, LAYOUT.sessions),
				sessionName: key,
				...(this.#options.parentEnv ? { parentEnv: this.#options.parentEnv } : {}),
			});
		} catch (error) {
			recorder.close();
			return (
				await this.finish({
					jobId,
					attempt,
					model,
					prior,
					branch,
					subject,
					diff,
					outcome: { operational: `reviewer could not run: ${(error as Error).message}` },
					deliverRevise,
					directive,
				})
			).result;
		}
		recorder.markSpawned({ pid: managed.worker.pid, model, profile: profile.frontmatter.name });
		recorder.attach(managed.worker);
		const worker = managed.worker;

		const wait = async (): Promise<{ review?: GateReview; operational?: string }> => {
			const receipt = await worker.send(brief);
			recorder.cp("prompt_sent", { receipt: receipt.receipt, bytes: brief.length });
			if (receipt.receipt === "failed") return { operational: `reviewer refused the brief: ${receipt.error ?? "unknown error"}` };
			return awaitVerdict({
				jobId,
				verdictFile: join(home, paths.reviewVerdictFile(jobId, attempt)),
				rejectedFile: join(runDir, "verdict-rejected.json"),
				timeoutMs,
				worker,
			});
		};
		const finish = async (outcome: { review?: GateReview; operational?: string }) =>
			this.finish({ jobId, attempt, model, prior, branch, subject, diff, outcome, deliverRevise, directive, managedKey: key, recorder });

		const reviews = this.#options.reviews;
		if (!reviews) return (await finish(await wait())).result;
		return {
			...reviews.start({
				jobId,
				surface: "review",
				attempt,
				model,
				...(worker.pid !== undefined ? { pid: worker.pid } : {}),
				deadline,
				subject,
				wait,
				finish: async (outcome) => (await finish(outcome)).wakeup,
			}),
			surface: "review",
			head_sha: headSha,
		};
	}

	/** Everything after the wait, unchanged: shut down, decide, persist, deliver a revise. */
	async finish(input: {
		jobId: string;
		attempt: number;
		model: string;
		prior: PriorAttempts;
		branch: string;
		subject: { head_sha: string; branch: string; files: number; truncated: boolean };
		diff?: DiffSubject;
		outcome: { review?: GateReview; operational?: string };
		deliverRevise: boolean;
		directive: string;
		managedKey?: string;
		recorder?: RunRecorder;
	}): Promise<{ result: DiffReviewResult; wakeup: ReviewWakeup }> {
		const now = this.#options.now ?? (() => new Date());
		if (input.managedKey) await this.#options.manager.shutdown(input.managedKey);
		input.recorder?.close();
		const { review, operational } = input.outcome;
		const { raw, rubric: _rubric, ...decided } = decideGate({
			jobId: input.jobId,
			attempt: input.attempt,
			prior: input.prior,
			model: input.model,
			capReason: reviewCapReason(input.attempt, input.branch),
			...(review ? { review } : {}),
			...(operational ? { operational } : {}),
			at: isoTimestamp(now()),
		});
		const verdict: DiffVerdict = {
			...decided,
			head_sha: input.subject.head_sha,
			diff_stat: { files: input.subject.files, truncated: input.subject.truncated },
		};
		const result = this.#persist({
			jobId: input.jobId,
			attempt: input.attempt,
			verdict,
			raw,
			model: input.model,
			...(input.diff ? { diff: input.diff } : {}),
			...(review ? { review } : {}),
		});
		if (result.next === "revise" && input.deliverRevise) await this.#deliverRevise(result);
		return {
			result,
			wakeup: {
				jobId: input.jobId,
				surface: "review",
				attempt: input.attempt,
				headSha: input.subject.head_sha,
				content: diffReviewDirective(result, input.directive),
				details: result as unknown as Record<string, unknown>,
			},
		};
	}

	/** An attempt whose reviewer died with a previous parent: decided operational from its recorded subject. */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		if (!pending.subject) return undefined;
		const prior = readPriorAttempts(this.#options.home, pending.job_id, paths.reviewFile, DiffVerdictSchema, {
			capExhausted: reviewCapExhausted,
		});
		if (prior.attempt !== pending.attempt) return undefined;
		return (
			await this.finish({
				jobId: pending.job_id,
				attempt: pending.attempt,
				model: pending.model,
				prior,
				branch: pending.subject.branch,
				subject: pending.subject,
				outcome: { operational: reason },
				deliverRevise: false,
				directive: "act on next",
			})
		).wakeup;
	}

	/** Blocking convenience for tests only; see `Gate.gateAndWait`. */
	async reviewAndWait(request: DiffReviewRequest): Promise<DiffReviewResult> {
		const started = await this.start(request);
		if (!isDiffReviewWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new DiffReviewError("reviewAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		const prior = readPriorAttempts(this.#options.home, request.jobId, paths.reviewFile, DiffVerdictSchema, { capExhausted: reviewCapExhausted });
		const verdict = prior.decisions[started.attempt - 1] as DiffVerdict | undefined;
		if (!verdict) throw new DiffReviewError(`review ${started.attempt} for ${request.jobId} left no decision on disk`);
		return { verdict, next: nextAction(verdict), path: join(this.#options.home, paths.reviewFile(request.jobId, started.attempt)), model: started.model };
	}
```

   Add three formatters at the end of `src/diff-review.ts`. `diffReviewToolPayload` in `extensions/command-post/index.ts` builds its text inline today; leave it, and make it call `formatDiffReview` in Task 8 so the tool result and the wake-up read the same.

```ts
/** One relayable block per decision — the verdict travels verbatim, the diff never does. */
export function formatDiffReview(result: DiffReviewResult): string {
	const { verdict } = result;
	const head = `${verdict.job_id} review attempt ${verdict.attempt}: ${verdict.verdict}${
		verdict.cause ? ` (cause: ${verdict.cause})` : ""
	}${result.model ? ` [${result.model}]` : ""} -> ${result.next}`;
	const lines = [head, `  head ${verdict.head_sha.slice(0, 12)}, ${verdict.diff_stat.files} file(s)${verdict.diff_stat.truncated ? " (truncated)" : ""}`];
	const flags = (Object.keys(verdict.flags) as Array<keyof GateFlags>).filter((flag) => verdict.flags[flag]);
	if (flags.length > 0) lines.push(`  flags: ${flags.join(", ")}`);
	for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
	if (verdict.revisions?.length) {
		lines.push("  revisions:");
		for (const revision of verdict.revisions) lines.push(`    - ${revision}`);
	}
	if (result.revise_receipt) lines.push(`  revise delivered: ${result.revise_receipt}`);
	if (result.revise_error) lines.push(`  revise NOT delivered: ${result.revise_error}`);
	return lines.join("\n");
}

/** The wake-up body: the decision, then one line saying what to do with it. */
export function diffReviewDirective(result: DiffReviewResult, directive: string): string {
	return `${formatDiffReview(result)}\nNext: ${directive}.`;
}

/** One block for a tool result that returned `wait`. */
export function formatReviewWait(wait: DiffReviewWait): string {
	return (
		`review attempt ${wait.attempt} on head ${wait.head_sha.slice(0, 12)} is running [${wait.model}] -> wait\n` +
		`  deadline: ${wait.deadline}\n` +
		"  End the turn; a cp-verdict wake-up will arrive with the verdict. Do not call status to wait."
	);
}
```

   (`GateFlags` is already imported in this file or comes from contracts.)

   Import `PriorAttempts` and `awaitVerdict` from `./gate.ts` if not already imported. Every other caller of `.review(` on a `DiffReview` (grep `src/` and `extensions/`) changes to `.start(`; the pipeline's `DiffReviewer` interface (`src/pipeline.ts`, search `interface DiffReviewer`) changes its `review(` member to `start(` returning `Promise<DiffReviewStart>` — Task 6 handles the pipeline's use of the result.

- [ ] **Step 5: Split `QualityPass.run()`**

In `src/quality.ts`:

1. Imports: `import { awaitVerdict } from "./gate.ts";` and `import { ReviewRuns, type ReviewWait, type ReviewWakeup } from "./review-runs.ts";` and `type PendingReview, QUALITY_PANEL_SLOT` from contracts. Delete `SETTLE_GRACE_MS` and `POLL_INTERVAL_MS` constants (they belonged to the private waiter) — keep `DEFAULT_VOTE_TIMEOUT_MS`.
2. `QualityOptions` gains `reviews?: ReviewRuns;`. `QualityRequest` gains `directive?: string;`.
3. Add:
   ```ts
   export interface QualityWait extends ReviewWait {
   	surface: "quality";
   }
   export type QualityStart = QualityReport | QualityWait | undefined;
   export function isQualityWait(value: QualityStart): value is QualityWait {
   	return value !== undefined && (value as QualityWait).next === "wait" && (value as QualityWait).surface === "quality";
   }
   ```
4. Replace `async run(request: QualityRequest): Promise<QualityReport | undefined>` with:

```ts
	/**
	 * One pass per job, whatever the outcome (unchanged), now asynchronous: the
	 * panel is one pending attempt in `quality-panel/`, its votes run
	 * sequentially inside the background waiter, and one wake-up follows the
	 * report. An existing report is returned as is.
	 */
	async start(request: QualityRequest): Promise<QualityStart> {
		const config = request.config;
		if (!isEnabled(config)) return undefined;
		const existing = this.read(request.jobId);
		if (existing) return existing;
		const { artifacts, reviews } = this.#options;
		if (!artifacts.has(request.jobId)) {
			throw new QualityError(`no artifact for ${request.jobId} — nothing to check`);
		}
		const pending = reviews?.pending(request.jobId, "quality");
		if (pending) {
			throw new QualityError(
				`${request.jobId} already has a quality panel in flight (started ${pending.started_at}) — wait for its cp-verdict wake-up`,
			);
		}
		const directive = request.directive ?? "act on next";
		const profile = profileForRole(this.#options.profilesDir, "gate-reviewer");
		const model = this.#model(profile, request);
		const votes = (config.verify === true ? (config.voters ?? DEFAULT_QUALITY_VOTERS) : 0) + (config.completeness === true ? 1 : 0);
		const timeoutMs = (this.#options.voteTimeoutMs ?? DEFAULT_VOTE_TIMEOUT_MS) * Math.max(1, votes);
		const now = this.#options.now ?? (() => new Date());
		const deadline = isoTimestamp(new Date(now().getTime() + timeoutMs));

		const wait = () => this.#panel(request);
		const finish = async (report: QualityReport): Promise<ReviewWakeup> => {
			// The registry substitutes `{ operational }` when the waiter throws; for
			// the panel that is not a report, and no report is written for it.
			const failed = (report as unknown as { operational?: string }).operational;
			if (failed) {
				return {
					jobId: request.jobId,
					surface: "quality",
					attempt: 1,
					content: `${request.jobId}: the quality panel failed — ${failed}. No report was written; advance to run the panel again.`,
					details: { job_id: request.jobId, failed },
				};
			}
			return {
				jobId: request.jobId,
				surface: "quality",
				attempt: 1,
				content: `${formatQuality(report)}\nNext: ${directive}.`,
				details: report as unknown as Record<string, unknown>,
			};
		};

		if (!reviews) {
			// No registry (a unit test of the pieces): run the panel inline. The
			// report is on disk when `#panel` returns.
			await wait();
			return this.read(request.jobId);
		}
		mkdirSync(join(this.#options.home, paths.qualityRunDir(request.jobId, QUALITY_PANEL_SLOT)), { recursive: true });
		return {
			...reviews.start<QualityReport>({ jobId: request.jobId, surface: "quality", attempt: 1, model, deadline, wait, finish }),
			surface: "quality",
		};
	}

	/** The whole panel: votes, completeness, tally, the write-once report. Runs in the background. */
	async #panel(request: QualityRequest): Promise<QualityReport> {
		const config = request.config;
		const at = isoTimestamp((this.#options.now ?? (() => new Date()))());
		const verify = config.verify === true ? await this.#verify(request) : undefined;
		const completeness = config.completeness === true ? await this.#completeness(request) : undefined;
		const partial: Omit<QualityReport, "fixes"> = {
			schema_version: SCHEMA_VERSION,
			job_id: request.jobId,
			ran_at: at,
			passed: (verify?.sound ?? true) && (completeness?.complete ?? true),
			...(verify ? { verify } : {}),
			...(completeness ? { completeness } : {}),
		};
		const fixes = fixesFrom(partial);
		const report: QualityReport = { ...partial, ...(fixes.length > 0 ? { fixes } : {}) };
		const validated = validate<QualityReport>(QualityReportSchema, report);
		if (!validated.ok) {
			throw new QualityError(`quality report for ${request.jobId} violates the contract:\n  ${validated.errors.join("\n  ")}`);
		}
		atomicWriteJson(join(this.#options.home, paths.qualityFile(request.jobId)), report);
		return report;
	}

	/**
	 * A panel whose voters died with a previous parent never happened: no
	 * report is written (a write-once report of all-abstained votes would hold
	 * the job back for a fault that was nobody's), so the next advance runs the
	 * panel again. The wake-up says exactly that.
	 */
	async orphan(pending: PendingReview, reason: string): Promise<ReviewWakeup | undefined> {
		if (this.read(pending.job_id)) return undefined;
		return {
			jobId: pending.job_id,
			surface: "quality",
			attempt: 1,
			content: `${pending.job_id}: the quality panel (started ${pending.started_at}) was lost — ${reason}. No report was written; advance the pipeline to run the panel again.`,
			details: { job_id: pending.job_id, orphaned: true, reason },
		};
	}

	/** Blocking convenience for tests only; see `Gate.gateAndWait`. */
	async runAndWait(request: QualityRequest): Promise<QualityReport | undefined> {
		const started = await this.start(request);
		if (!isQualityWait(started)) return started;
		const reviews = this.#options.reviews;
		if (!reviews) throw new QualityError("runAndWait needs a ReviewRuns registry");
		reviews.handBack(started.key);
		await reviews.settled(started.key);
		return this.read(request.jobId);
	}
```

   Keep `#verify`, `#vote`, `#completeness`, `#review`, `#model` as they are, except: in `#review`, replace `return { ...(await this.#awaitVerdict(request.jobId, runDir, managed.worker)), model };` with

```ts
			const outcome = await awaitVerdict({
				jobId: request.jobId,
				verdictFile: join(runDir, "verdict.json"),
				rejectedFile: join(runDir, "verdict-rejected.json"),
				timeoutMs: this.#options.voteTimeoutMs ?? DEFAULT_VOTE_TIMEOUT_MS,
				worker: managed.worker,
			});
			return { ...(outcome.review ? { review: outcome.review } : {}), ...(outcome.operational ? { note: outcome.operational } : {}), model };
```

   and delete the private `#awaitVerdict` method entirely (D10). Replace `sessionDir: join(home, "state/sessions")` with `sessionDir: join(home, LAYOUT.sessions)` (import `LAYOUT`).

   The `failed` guard inside `finish` above is what handles the registry's throw path (`{ operational }` substituted for a report): nothing is written, and the wake-up says to run the panel again.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/diff-review.test.ts tests/quality.test.ts tests/gate.test.ts`
Expected: PASS. Typecheck will also flag every remaining caller of `.review(`/`.run(` in `src/pipeline.ts` and `src/command-post.ts`: change `diffReview(request)` in `command-post.ts` to call `.start(request)` and return `DiffReviewStart`; leave the pipeline's callers for Task 6 by temporarily calling `reviewAndWait`/`runAndWait` there **only if** typecheck blocks the commit, and note it in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/diff-review.ts src/quality.ts src/command-post.ts tests/diff-review.test.ts tests/quality.test.ts
git commit -m "diff-review, quality: start()/finish() split; the panel uses the shared awaitVerdict

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `src/wakeups.ts` — the sixth kind

**Files:**
- Modify: `src/wakeups.ts` (`WakeupKind`, `WAKEUP_CUSTOM_TYPES`, `WakeupFacts`, `checkWakeup`, `wakeupFacts`, header comment)
- Test: `tests/wakeups.test.ts`

**Interfaces:**
- Consumes: `VERDICT_MESSAGE_TYPE`, `type ReviewSurface` from contracts. Nothing from `src/review-runs.ts`: the facts are injected (files are read by the extension's `wakeupFactsNow`, Task 8), so this module stays fs-free like the rest of `wakeups.ts`.
- Produces:
  ```ts
  export type WakeupKind = "envelope" | "answered" | "wedged" | "unreported" | "ci" | "verdict";
  export interface ReviewWakeupFacts { pending?: number; decided: number[] }   // attempts
  export interface WakeupFacts { job(jobId): JobWakeupFacts | undefined; review?(jobId, surface: ReviewSurface): ReviewWakeupFacts | undefined }
  export function wakeupFacts(sources: { ...existing; review?: (jobId, surface) => ReviewWakeupFacts | undefined }): WakeupFacts;
  export function verdictKeysFromMessage(message: unknown): string[];   // [`${job}|${surface}|${attempt}`] or []
  export function verdictStamp(jobId, surface, attempt, headSha?): Omit<WakeupStamp, "issued_at">;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/wakeups.test.ts` (extend imports: `verdictKeysFromMessage`, `verdictStamp`, `type ReviewWakeupFacts` from `../src/wakeups.ts`; `VERDICT_MESSAGE_TYPE` from contracts):

```ts
// ---------------------------------------------------------------------------
// cp-verdict (spec 2026-09-05-async-reviewers): a verdict is a claim about one
// attempt of one surface on one job. It goes stale when that attempt has no
// decision, a later attempt exists, the job is over, or (a diff review) the
// branch head moved.
// ---------------------------------------------------------------------------

function verdictFacts(bench: Bench, reviews: Map<string, ReviewWakeupFacts>) {
	return wakeupFacts({
		record: (jobId) => bench.fleet.get(jobId),
		statusJob: (jobId) => bench.status.get(jobId),
		ciHead: (jobId) => (jobId === "cp-v" ? "b".repeat(40) : undefined),
		review: (jobId, surface) => reviews.get(`${jobId}|${surface}`),
	});
}

test("verdict: fresh when the attempt is decided and nothing newer exists", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	const reviews = new Map([["cp-v|gate", { decided: [1] }]]);
	const verdict = checkWakeup({ ...verdictStamp("cp-v", "gate", 1), issued_at: isoTimestamp(b.now()) }, verdictFacts(b, reviews), b.now());
	assert.equal(verdict.state, "fresh");
});

test("verdict: stale when the decision is missing, superseded by a later attempt, or the job is over", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pipeline"));
	const at = isoTimestamp(b.now());
	const missing = checkWakeup({ ...verdictStamp("cp-v", "gate", 1), issued_at: at }, verdictFacts(b, new Map([["cp-v|gate", { decided: [] }]])), b.now());
	assert.equal(missing.state, "superseded");
	assert.match(missing.reason ?? "", /no decision on disk for gate attempt 1/);

	const later = checkWakeup({ ...verdictStamp("cp-v", "gate", 1), issued_at: at }, verdictFacts(b, new Map([["cp-v|gate", { decided: [1, 2] }]])), b.now());
	assert.equal(later.state, "superseded");
	assert.match(later.reason ?? "", /gate attempt 2 has since been decided/);

	const pendingLater = checkWakeup({ ...verdictStamp("cp-v", "gate", 1), issued_at: at }, verdictFacts(b, new Map([["cp-v|gate", { decided: [1], pending: 2 }]])), b.now());
	assert.equal(pendingLater.state, "superseded");
	assert.match(pendingLater.reason ?? "", /gate attempt 2 is in flight/);

	await b.fleet.update("cp-v", (record) => ({ ...record, phase: "done" }));
	const over = checkWakeup({ ...verdictStamp("cp-v", "gate", 1), issued_at: at }, verdictFacts(b, new Map([["cp-v|gate", { decided: [1] }]])), b.now());
	assert.equal(over.state, "superseded");
	assert.match(over.reason ?? "", /already done/);
});

test("verdict: a diff review is a claim about one head; a moved head makes it stale", async (t) => {
	const b = benchOf(t);
	await b.fleet.add(jobRecord(b.home.path, "cp-v", "pr"));
	const at = isoTimestamp(b.now());
	const reviews = new Map([["cp-v|review", { decided: [1] }]]);
	const same = checkWakeup({ ...verdictStamp("cp-v", "review", 1, "b".repeat(40)), issued_at: at }, verdictFacts(b, reviews), b.now());
	assert.equal(same.state, "fresh");
	const moved = checkWakeup({ ...verdictStamp("cp-v", "review", 1, "a".repeat(40)), issued_at: at }, verdictFacts(b, reviews), b.now());
	assert.equal(moved.state, "superseded");
	assert.match(moved.reason ?? "", /branch moved/);
});

test("verdict: the arrival key is read off the message the parent actually received", () => {
	const stamp = { ...verdictStamp("cp-v", "gate", 2), issued_at: "2026-09-05T10:00:00Z" };
	const message = { role: "custom", customType: VERDICT_MESSAGE_TYPE, content: "x", details: { cp_wakeup: stamp } };
	assert.deepEqual(verdictKeysFromMessage(message), ["cp-v|gate|2"]);
	assert.deepEqual(verdictKeysFromMessage({ role: "custom", customType: "cp-envelope", details: {} }), []);
	assert.deepEqual(verdictKeysFromMessage("nonsense"), []);
});
```

If `FleetStore` has no `update(jobId, fn)` helper, use whatever the bench in this file already uses to move a record to `done` (search the file for `phase: "done"`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/wakeups.test.ts`
Expected: FAIL — `verdictStamp` not exported.

- [ ] **Step 3: Add the kind**

In `src/wakeups.ts`:

1. Header comment: replace the sentence `The five messages that wake the parent unasked. There are no others.` (above `WakeupKind`) with:
   ```ts
   /**
    * The six messages that wake the parent unasked. There are no others. The
    * sixth, `verdict`, is a reviewer's decision landing in the background
    * (spec 2026-09-05-async-reviewers): a claim about one attempt of one
    * surface, stale once that attempt has no decision, a later attempt exists,
    * the job is over, or — for a diff review — the branch head moved.
    */
   ```
   and `export type WakeupKind = "envelope" | "answered" | "wedged" | "unreported" | "ci" | "verdict";`.
2. `WAKEUP_CUSTOM_TYPES` gains `verdict: VERDICT_MESSAGE_TYPE,` (import it from contracts).
3. Add after `JobWakeupFacts`:
   ```ts
   /** What is on disk for one (job, surface): the pending attempt and the decided ones. */
   export interface ReviewWakeupFacts {
   	pending?: number;
   	decided: number[];
   }
   ```
   and `WakeupFacts` gains `review?(jobId: string, surface: ReviewSurface): ReviewWakeupFacts | undefined;`.
4. In `checkWakeup`, before the `if (stamp.kind === "envelope")` block (after `if (!job) return stale(...)`), add:

```ts
	if (stamp.kind === "verdict") {
		const surface = stamp.keys?.[0] as ReviewSurface | undefined;
		const attempt = Number(stamp.keys?.[1]);
		if (TERMINAL.includes(job.phase)) return stale(`${stamp.job_id} is already ${job.phase}: the review it describes is history`);
		if (!surface || !Number.isInteger(attempt) || attempt < 1) return fresh;
		const review = facts.review?.(stamp.job_id, surface);
		if (!review) return fresh;
		if (!review.decided.includes(attempt)) {
			return stale(`there is no decision on disk for ${surface} attempt ${attempt} of ${stamp.job_id}: its finish never completed, so there is nothing to act on`);
		}
		const newer = review.decided.filter((decided) => decided > attempt).at(-1);
		if (newer !== undefined) return stale(`${surface} attempt ${newer} has since been decided for ${stamp.job_id}; attempt ${attempt} is superseded`);
		if (review.pending !== undefined && review.pending > attempt) {
			return stale(`${surface} attempt ${review.pending} is in flight for ${stamp.job_id}; attempt ${attempt} is superseded`);
		}
		const head = stamp.keys?.[2];
		if (surface === "review" && head !== undefined && job.head_sha !== undefined && job.head_sha !== head) {
			return stale(`the branch moved: this reviewed ${head.slice(0, 12)}, and ${stamp.job_id} is now pushed at ${job.head_sha.slice(0, 12)}`);
		}
		return fresh;
	}
```

5. `wakeupFacts(sources)` gains `review?: (jobId: string, surface: ReviewSurface) => ReviewWakeupFacts | undefined;` in its parameter type and returns `{ job(...) {...}, ...(sources.review ? { review: sources.review } : {}) }`.
6. Add:

```ts
/** The stamp a `cp-verdict` carries: surface, attempt, and the head for a diff review. */
export function verdictStamp(jobId: string, surface: ReviewSurface, attempt: number, headSha?: string): Omit<WakeupStamp, "issued_at"> {
	return { kind: "verdict", job_id: jobId, keys: headSha ? [surface, String(attempt), headSha] : [surface, String(attempt)] };
}

/** `${job}|${surface}|${attempt}` for a `cp-verdict` message, else nothing. Never throws. */
export function verdictKeysFromMessage(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const carrier = message as WakeupCarrier;
	if (carrier.customType !== VERDICT_MESSAGE_TYPE) return [];
	const stamp = wakeupStampOf(carrier);
	if (!stamp || stamp.kind !== "verdict" || !stamp.job_id || !stamp.keys || stamp.keys.length < 2) return [];
	return [`${stamp.job_id}|${stamp.keys[0]}|${stamp.keys[1]}`];
}
```

   Import `type ReviewSurface` from contracts. Check `describe(stamp)` renders `keys` sensibly for a verdict (add `const keys = stamp.kind === "verdict" && stamp.keys ? `, ${stamp.keys[0]} attempt ${stamp.keys[1]}` : "";` into the template).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/wakeups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wakeups.ts tests/wakeups.test.ts
git commit -m "wakeups: cp-verdict, the sixth unasked wake-up, with its staleness rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `src/pipeline.ts` — `advance` returns `wait` while a review is pending

**Files:**
- Modify: `src/pipeline.ts` (`PipelineOptions`, `AdvanceResult`, `DiffReviewer`, `advance` steps 2–3, `#quality`, `#reviewStep`)
- Modify: `src/command-post.ts` (`pipeline()` passes `reviews`)
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `ReviewRuns`, `type ReviewWait` from `src/review-runs.ts`; `type GateStart, isGateWait` from `src/gate.ts`; `type QualityStart, isQualityWait` from `src/quality.ts`; `type DiffReviewStart, isDiffReviewWait` from `src/diff-review.ts`.
- Produces:
  ```ts
  export interface PipelineOptions { ...existing; reviews?: ReviewRuns }
  export interface AdvanceResult { ...existing; pending?: { surface: ReviewSurface; attempt: number; deadline: string } }
  export interface DiffReviewer { start(request: { jobId: string; directive?: string }): Promise<DiffReviewStart>; headSha(jobId): Promise<string | undefined> }
  ```

- [ ] **Step 1: Write the failing test**

In `tests/pipeline.test.ts`, the existing end-to-end tests call `b.post.advancePipeline` and assert `first.gate?.verdict.verdict === "revise"` on the *same* call. With the split, the first `advance` returns `wait` with `pending`, the verdict lands in the background, and the next `advance` reads it. Convert the main test (`"pipeline: two dep-linked issues, hung-planner gate, one revise, authorization, implementer hand-off"`) like this — replace the block from `// --- advance #1` to `assert.equal(b.approvals.length, 0, ...)` with:

```ts
		// --- advance #1: spawn the gate reviewer and return at once -----------
		const first = await b.post.advancePipeline(researchId);
		assert.equal(first.state, "gating");
		assert.equal(first.next, "wait");
		assert.equal(first.hung_planner, true, "an artifact without an envelope is still evidence");
		assert.equal(first.gate, undefined, "the verdict is not in the tool result any more");
		assert.equal(first.pending?.surface, "gate");
		assert.equal(first.pending?.attempt, 1);
		assert.ok(existsSync(join(b.home, paths.pendingReviewFile(researchId, "gate", 1))));

		// While the reviewer runs, advancing again changes nothing and says why.
		const busy = await b.post.advancePipeline(researchId);
		assert.equal(busy.next, "wait");
		assert.match(busy.message, /gate attempt 1 is running/);

		// The verdict lands in the background; the wake-up names the next step.
		await b.settle(researchId, "gate", 1);
		assert.equal(b.sent.at(-1)?.surface, "gate");
		assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 1: revise/);
		assert.match(b.sent.at(-1)?.content ?? "", new RegExp(`Next: call cp_pipeline advance ${researchId}`));

		// --- advance #2: the revise was already delivered by finish -----------
		const revised = await b.post.advancePipeline(researchId);
		assert.equal(revised.state, "gating");
		assert.equal(revised.next, "wait");
		assert.match(revised.message, /has not changed yet/);
		assert.equal(b.approvals.length, 0, "nothing is authorized before a pass");
```

and the block from `// --- advance #2: pass` through `assert.equal(second.next, "wait");` with:

```ts
		// --- advance #3: a changed artifact is re-gated; the pass lands later ---
		const regate = await b.post.advancePipeline(researchId);
		assert.equal(regate.next, "wait");
		assert.equal(regate.pending?.attempt, 2);
		await b.settle(researchId, "gate", 2);
		assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 2: pass/);

		// --- advance #4: pass -> close research -> authorize -> implement -----
		const second = await b.post.advancePipeline(researchId);
		assert.equal(second.gate, undefined, "the verdict was read from disk, not decided here");
		assert.equal(second.state, "implementing");
		assert.equal(second.next, "wait");
```

Add to the pipeline `Bench` interface and `bench()`:

```ts
	sent: ReviewWakeup[];
	/** Hand back and wait for one attempt's chain to finish. */
	settle(jobId: string, surface: ReviewSurface, attempt: number): Promise<void>;
```

```ts
	const sent: ReviewWakeup[] = [];
	// after `post` is constructed:
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);
	state.sent = sent;
	state.settle = async (jobId, surface, attempt) => {
		const key = ReviewRuns.key(jobId, surface, attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
	};
```

(`wakeupPort` is the setter Task 2 added to `ReviewRuns`.)

Convert the quality test (`"pipeline: the opt-in quality pass runs before the gate, once"`) to this sequence:

```ts
	// The panel starts and returns at once.
	const panel = await b.post.advancePipeline(researchId);
	assert.equal(panel.state, "gating");
	assert.equal(panel.next, "wait");
	assert.equal(panel.pending?.surface, "quality");
	assert.equal(panel.gate, undefined, "the expensive gate is not paid for before the panel");
	await b.settle(researchId, "quality", 1);
	assert.match(b.sent.at(-1)?.content ?? "", /quality pass: not ready/);

	// The first advance to see the failed report acts on it: one promote, no gate.
	const checked = await b.post.advancePipeline(researchId);
	assert.equal(checked.state, "gating");
	assert.equal(checked.next, "wait");
	assert.equal(checked.quality?.passed, false);
	assert.deepEqual(checked.quality?.fixes, ["[evidence] name the exact files"]);
	assert.equal(checked.pending, undefined, "nothing is running: the planner was asked to fix");
	assert.match(checked.message, /promote: delivered/);
	assert.equal(existsSync(join(b.home, paths.gateFile(researchId, 1))), false);

	// One pass per job, acted on once: the next advance starts the gate.
	const gating = await b.post.advancePipeline(researchId);
	assert.equal(gating.pending?.surface, "gate");
	assert.equal(gating.quality?.passed, false, "the report is write-once and still says what it said");
	await b.settle(researchId, "gate", 1);
	const gated = await b.post.advancePipeline(researchId);
	assert.equal(gated.state, "implementing");
```

This needs the pipeline to remember that it has acted on the report — see step 3, `quality_acted_at`.

Convert the remaining `advancePipeline` gate assertions in the file with the same shape (start → `settle` → advance). For the diff-gate tests (`#reviewStep`), the `DiffReviewer` test double's `review(` member becomes `start(` returning either a finished `DiffReviewResult` (what the doubles already return, so they keep working) or a wait.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/pipeline.test.ts`
Expected: FAIL (`post.reviewRuns` undefined; `first.pending` undefined).

- [ ] **Step 3: Wire the pipeline**

In `src/pipeline.ts`:

1. Imports: `import { ReviewRuns, type ReviewWait } from "./review-runs.ts";` `import { type GateStart, isGateWait } from "./gate.ts";` (alongside the existing gate imports); `import { isQualityWait, type QualityStart } from "./quality.ts";` `import { type DiffReviewStart, isDiffReviewWait } from "./diff-review.ts";` `type ReviewSurface` from contracts.
2. `PipelineOptions` gains `reviews?: ReviewRuns;`. `AdvanceResult` gains
   ```ts
   	/** A reviewer is running for the research job; act on its cp-verdict wake-up (spec 2026-09-05). */
   	pending?: { surface: ReviewSurface; attempt: number; deadline: string };
   ```
3. `DiffReviewer`'s `review(` member becomes `start(request: { jobId: string; model?: string; directive?: string }): Promise<DiffReviewStart>;`.
4. Add a private helper:

```ts
	/** The one message for "a reviewer is running"; the ladder resumes on the next advance. */
	#waitOn(record: PipelineRecord, state: PipelineState, wait: ReviewWait, extra: Partial<AdvanceResult> = {}): AdvanceResult {
		this.store.setState(record.research_id, state, this.#now());
		return this.#step(
			record,
			state,
			"wait",
			`${record.research_id}: ${wait.surface} attempt ${wait.attempt} is running (deadline ${wait.deadline}). ` +
				`End the turn; its cp-verdict wake-up will say to advance again.`,
			{ ...extra, pending: { surface: wait.surface, attempt: wait.attempt, deadline: wait.deadline } },
		);
	}

	/** A pending attempt for this job on any surface, from disk. */
	#pendingOn(jobId: string): ReviewWait | undefined {
		const pending = this.#options.reviews?.pendingFor(jobId)[0];
		if (!pending) return undefined;
		return {
			next: "wait",
			surface: pending.surface,
			attempt: pending.attempt,
			model: pending.model,
			deadline: pending.deadline,
			key: ReviewRuns.key(pending.job_id, pending.surface, pending.attempt),
		};
	}
```

5. In `advance`, at the start of step 2 (before `const { report: quality, fresh } = await this.#quality(record);`):

```ts
		// --- 2/3. a reviewer already running owns this step ---------------------
		const running = this.#pendingOn(researchId);
		if (running) return this.#waitOn(record, "gating", running, hungPlanner ? { hung_planner: true } : {});
```

6. **The panel's report is acted on exactly once, whichever advance first sees it.** Today `fresh` means "this call produced the report". The report is now produced in the background, so the first `advance` to read it must still treat it as fresh, and no later one may. Add to `PipelineRecordSchema` in `src/contracts.ts`, after `review`:

```ts
		/**
		 * When the pipeline acted on the quality report (promoted fixes, or went on
		 * to the gate) — spec 2026-09-05. The report is written in the background,
		 * so "fresh" is "no advance has acted on it yet", not "this call wrote it".
		 */
		quality_acted_at: Type.Optional(IsoTimestampSchema),
```

   and a `PipelineStore.setQualityActed(researchId, at)` beside `setState` (same read-validate-write shape). `#quality` returns `Promise<{ report?: QualityReport; fresh: boolean; wait?: ReviewWait }>`; replace its body from `const existing = pass.read(...)` on with:

```ts
		const existing = pass.read(record.research_id);
		if (existing) return { report: existing, fresh: record.quality_acted_at === undefined };
		const task = await this.#task(record.research_id);
		const started = await pass.start({
			jobId: record.research_id,
			task,
			config,
			directive: `call cp_pipeline advance ${record.research_id}`,
		});
		if (isQualityWait(started)) return { fresh: false, wait: started };
		// Decided inline (no registry): the report is new and nobody has acted on it.
		return { ...(started ? { report: started } : {}), fresh: started !== undefined };
```

   In `advance`, change the destructuring to `const { report: quality, fresh, wait: qualityWait } = await this.#quality(record);`, add `if (qualityWait) return this.#waitOn(record, "gating", qualityWait, hungPlanner ? { hung_planner: true } : {});` right after it, and inside the existing `if (quality && fresh && !quality.passed)` block, before `return this.#step(...)`, add `this.store.setQualityActed(researchId, this.#now());`. Add the same `setQualityActed` call once more immediately before step 3's `readPriorAttempts` when `quality && fresh` (a passing fresh report is acted on by going to the gate).

7. In step 3, replace `gateResult = await this.#options.gate().gate({ brId: researchId });` `last = gateResult.verdict;` with:

```ts
			const started = await this.#options.gate().start({
				jobId: researchId,
				directive: `call cp_pipeline advance ${researchId}`,
			});
			if (isGateWait(started)) return this.#waitOn(record, "gating", started, { ...qualityExtra, ...(hungPlanner ? { hung_planner: true } : {}) });
			gateResult = started;
			last = gateResult.verdict;
```

   (The synchronous branch is reached only when `start` decided without a reviewer.)

8. In `#reviewStep`, where it calls the reviewer (search `reviewer.review(`), replace with:

```ts
			const started = await reviewer.start({ jobId: shipId, directive: `call cp_pipeline advance ${record.research_id}` });
			if (isDiffReviewWait(started)) {
				return { held: this.#waitOn(record, "implementing", started) };
			}
			const result = started;
```

   and keep what follows using `result`. Also at the top of `#reviewStep`, after `const shipId = record.ship_id;`, add `const running = this.#pendingOn(shipId); if (running) return { held: this.#waitOn(record, "implementing", running) };`.

In `src/command-post.ts`:
- Add `readonly reviewRuns: ReviewRuns;` constructed in the constructor after `this.runs = new RunRegistry(...)`: `this.reviewRuns = new ReviewRuns({ home: options.home, runs: this.runs, ...(options.sendWakeup ? { wakeup: (wakeup) => options.sendWakeup!(wakeup) } : {}) });` where `CommandPostOptions` gains
  ```ts
  	/**
  	 * The parent's wake-up transport for reviewer verdicts (spec 2026-09-05).
  	 * Absent (tests, headless): the decision is on disk and nothing is sent.
  	 */
  	sendWakeup?: (wakeup: ReviewWakeup) => boolean;
  ```
- `gateModule()`, `diffReviewModule()`, `qualityPass()` each pass `reviews: this.reviewRuns,`; `pipeline()` passes `reviews: this.reviewRuns,`.
- `gate(request)` returns `Promise<GateStart>` via `.start(request)`; `diffReview(request)` returns `Promise<DiffReviewStart>` via `.start(request)`.
- Add:
  ```ts
  	/** Finish attempts a previous parent left pending (D4). Once per session, after the parent lock. */
  	async sweepOrphanReviews(): Promise<OrphanReport> {
  		const jobIds = this.fleet.read().jobs.map((job) => job.job_id);
  		return this.reviewRuns.sweepOrphans(
  			{
  				gate: (pending, reason) => this.gateModule().orphan(pending, reason),
  				review: (pending, reason) => this.diffReviewModule().orphan(pending, reason),
  				quality: (pending, reason) => this.qualityPass().orphan(pending, reason),
  			},
  			jobIds,
  		);
  	}
  ```
- The tests inject the transport through the `wakeupPort` setter Task 2 already added to `ReviewRuns`; nothing to add here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/pipeline.test.ts tests/review-runs.test.ts`
Expected: PASS (the e2e pipeline tests self-skip without treehouse; run them where it is installed).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts src/command-post.ts src/review-runs.ts tests/pipeline.test.ts
git commit -m "pipeline: advance returns wait while a reviewer runs; the verdict is read from disk next time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `/status` and the widget show a pending review

**Files:**
- Modify: `src/status.ts` (`StatusFacts`, `assembleStatus`, `StatusReporter.collect`, the table renderer's detail line)
- Modify: `src/widget.ts` (`runningRow`'s activity cell or a detail suffix)
- Test: `tests/status.test.ts`, `tests/widget.test.ts` (+ goldens)

**Interfaces:**
- Consumes: `listPendingReviews` from `src/review-runs.ts`; `StatusJob.pending_review` from Task 1.
- Produces: `StatusFacts.pendingReviews?: ReadonlyMap<string, PendingReview>` (first pending per job); `StatusJob.pending_review` populated.

- [ ] **Step 1: Write the failing tests**

Append to `tests/status.test.ts`:

```ts
test("a pending review is carried onto the job row from pending.json, files only", () => {
	const record = jobRecord("cp-pr"); // use this file's existing FleetRecord fixture helper
	const pending = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-pr",
		surface: "gate" as const,
		attempt: 2,
		model: "mock/reviewer",
		pid: 1,
		started_at: "2026-09-05T10:00:00Z",
		deadline: "2026-09-05T10:15:00Z",
		handed_back: true,
	};
	const snapshot = assembleStatus({
		home: "/h",
		generated_at: "2026-09-05T10:04:00Z",
		include: "all",
		records: [record],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
		pendingReviews: new Map([["cp-pr", pending]]),
	});
	assert.deepEqual(snapshot.jobs[0]?.pending_review, {
		surface: "gate",
		attempt: 2,
		started_at: "2026-09-05T10:00:00Z",
		deadline: "2026-09-05T10:15:00Z",
	});
	assert.ok(validateStatusSnapshot(snapshot).ok);
	assert.match(formatStatusTable(snapshot), /gate 2 running 4m/);
	const without = assembleStatus({ home: "/h", generated_at: "2026-09-05T10:04:00Z", include: "all", records: [record], runs: new Map(), alive: new Map(), ledger: { ok: false, queried: false } });
	assert.equal(without.jobs[0]?.pending_review, undefined);
});

test("StatusReporter reads pending.json off disk for each fleet job", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(jobRecord("cp-pr")); // this file's FleetRecord fixture helper
	const file = join(home.path, paths.pendingReviewFile("cp-pr", "gate", 1));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: "cp-pr", surface: "gate", attempt: 1, model: "m", started_at: "2026-09-05T10:00:00Z", deadline: "2026-09-05T10:15:00Z", handed_back: false }),
	);
	// Same construction the attach and usage tests in this file use: no ledger, files only.
	const reporter = new StatusReporter({ home: home.path, fleet, now: () => new Date(NOW), isPidAlive: () => true });
	assert.equal(reporter.collect({ include: "all" }).jobs.find((job) => job.job_id === "cp-pr")?.pending_review?.attempt, 1);
});
```

Append to `tests/widget.test.ts` a golden: a running research job with `pending_review` set (extend `snapshotOf` to accept `pendingReviews`), named `"golden: a research job with its gate reviewer running"`, asserting through `assertGolden` like the neighbouring golden tests and, in addition, `assert.match(rendered, /gate 2 ⋅ 4m/)` (ASCII fallback: `gate 2 . 4m`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/status.test.ts tests/widget.test.ts`
Expected: FAIL (`pendingReviews` unknown; no `pending_review`).

- [ ] **Step 3: Carry the fact through**

`src/status.ts`:
- `StatusFacts` gains
  ```ts
  	/**
  	 * The first pending reviewer attempt per job (spec 2026-09-05), read from
  	 * each attempt directory's `pending.json`. Files only, like everything here.
  	 */
  	pendingReviews?: ReadonlyMap<string, PendingReview>;
  ```
- In `assembleStatus`'s job literal, after the `routing` spread:
  ```ts
  			...(facts.pendingReviews?.get(record.job_id)
  				? {
  						pending_review: (({ surface, attempt, started_at, deadline }) => ({ surface, attempt, started_at, deadline }))(
  							facts.pendingReviews.get(record.job_id) as PendingReview,
  						),
  					}
  				: {}),
  ```
- In `StatusReporter.collect`, after the attach map is built:
  ```ts
  		const pendingReviews = new Map<string, PendingReview>();
  		for (const record of records) {
  			const first = listPendingReviews(this.home, record.job_id)[0];
  			if (first) pendingReviews.set(record.job_id, first);
  		}
  ```
  and pass `...(pendingReviews.size > 0 ? { pendingReviews } : {})` into `assembleStatus`.
- In the table renderer (`formatStatusTable`, near the `open_question` detail line at ~line 625), add:
  ```ts
  			if (job.pending_review) {
  				lines.push(
  					`  ${job.pending_review.surface} ${job.pending_review.attempt} running ${formatAge(ageSeconds(job.pending_review.started_at, snapshot.generated_at))} (deadline ${job.pending_review.deadline})`,
  				);
  			}
  ```

`src/widget.ts`: in `runningRow`, extend the activity cell: `activity: \`${charset.text(activityCell(job, kind, word, now))}${withGap(reviewMark(job, now, charset))}${withGap(attachMark(job, now, charset, false))}\`` with

```ts
/** `gate 2 ⋅ 4m`: a reviewer is running for this job (spec 2026-09-05). Never a phase. */
function reviewMark(job: StatusJob, now: string, charset: Charset): string {
	const pending = job.pending_review;
	if (!pending) return "";
	return `${pending.surface} ${pending.attempt} ${charset.dot} ${formatAge(ageSeconds(pending.started_at, now))}`;
}
```

Regenerate goldens: `CP_UPDATE_GOLDEN=1 node --test tests/widget.test.ts tests/status.test.ts`, then `git diff tests/golden` and read every changed line before committing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/status.test.ts tests/widget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status.ts src/widget.ts tests/status.test.ts tests/widget.test.ts tests/golden
git commit -m "status, widget: show the reviewer running for a job, from pending.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The extension — tools, handback, arrival, orphan sweep

**Files:**
- Modify: `extensions/command-post/index.ts` (`commandPost()` construction; `cp_gate`; `cp_review`; `cp_pipeline`; `message_start`/`context` hooks; `session_start`; `wakeupFactsNow`)
- Test: `tests/extension-load.test.ts`

**Interfaces:**
- Consumes: everything above; `verdictKeysFromMessage`, `verdictStamp` from `src/wakeups.ts`; `formatGateWait`, `isGateWait` from `src/gate.ts`; `isDiffReviewWait` from `src/diff-review.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/extension-load.test.ts`:

```ts
test("cp_gate and cp_review accept action start|status, and the sixth wake-up type is registered", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({ cwd: REPO_ROOT, args: ["--no-session", "-e", EXTENSION], env: { CP_HOME: home.path } });
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});
	rpc.send({ id: "tools", type: "get_tools" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "tools")) as RpcRecord & {
		data?: { tools?: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }> };
	};
	const tools = response.data?.tools ?? [];
	for (const name of ["cp_gate", "cp_review"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} not registered`);
		assert.ok(tool.parameters?.properties?.action, `${name} has no action parameter`);
	}
});
```

(If `get_tools` is not an RPC request pi supports in this version, assert instead through `get_commands` that `/status` exists and add a unit test in `tests/awaiting-ui.test.ts`'s style for `parseGateArgs` below.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/extension-load.test.ts`
Expected: FAIL (`action` missing).

- [ ] **Step 3: Wire the extension**

In `extensions/command-post/index.ts`:

1. **Transport into CommandPost.** In `commandPost()`, add to `new CommandPost({...})`:
   ```ts
   				// spec 2026-09-05: a reviewer's verdict wakes this session like an
   				// envelope does — stamped, re-checked at delivery, confirmed on arrival.
   				sendWakeup: (wakeup) =>
   					sendWakeup(
   						verdictStamp(wakeup.jobId, wakeup.surface, wakeup.attempt, wakeup.headSha),
   						wakeup.content,
   						{ ...wakeup.details, verdict_key: `${wakeup.jobId}|${wakeup.surface}|${wakeup.attempt}` },
   					),
   ```
   `sendWakeup` is defined later in the file than `commandPost()`; both are `const` arrow functions inside the same factory scope, and `sendWakeup` is only *called* at finish time, so the reference is fine. If typecheck complains about use-before-define, hoist `sendWakeup` above `commandPost`.

2. **Facts for staleness.** In `wakeupFactsNow`, add a fourth source:
   ```ts
   			review: (jobId, surface) => {
   				try {
   					const pending = post.reviewRuns.pending(jobId, surface);
   					const decided =
   						surface === "gate"
   							? readPriorAttempts(resolveHome(), jobId).decisions.map((decision) => decision.attempt)
   							: surface === "review"
   								? readPriorAttempts(resolveHome(), jobId, paths.reviewFile, DiffVerdictSchema, { capExhausted: reviewCapExhausted }).decisions.map((decision) => decision.attempt)
   								: existsSync(join(resolveHome(), paths.qualityFile(jobId)))
   									? [1]
   									: [];
   					return { ...(pending ? { pending: pending.attempt } : {}), decided };
   				} catch {
   					return undefined;
   				}
   			},
   ```
   Import `readPriorAttempts`, `reviewCapExhausted` from `../../src/gate.ts` and `DiffVerdictSchema` from contracts.

3. **Arrival.** Beside `confirmCiArrival`, add:
   ```ts
   	/** A `cp-verdict` reached this session's context (cp-nx7): confirm it and journal it. */
   	const confirmVerdictArrival = (message: unknown): void => {
   		try {
   			const keys = verdictKeysFromMessage(message);
   			if (keys.length === 0) return;
   			const post = commandPost();
   			for (const key of post.reviewRuns.confirm(keys)) {
   				const [jobId, surface, attempt] = key.split("|");
   				if (!jobId || !surface || !attempt) continue;
   				post.runs.open(jobId).cp("verdict_wakeup_delivered", { surface, attempt: Number(attempt) });
   			}
   		} catch {
   			// Observation only; never break the message pipeline.
   		}
   	};
   ```
   and call it next to `confirmCiArrival(message)` in both the `message_start` and `context` hooks. The once-only resend rides the widget timer: inside `refreshWidget` (or a sibling called from the same `setInterval`), add
   ```ts
   		try {
   			post?.reviewRuns.resendDue();
   		} catch {
   			// A resend that fails costs a duplicate later, never a missed verdict.
   		}
   ```
   Files-only rule holds: `resendDue` reads memory and calls the transport; it opens no subprocess.

4. **`cp_gate`.** Replace the tool's `parameters` and `execute`:
   ```ts
   		parameters: Type.Object({
   			job_id: Type.String({ description: "The research job whose artifact is reviewed" }),
   			action: Type.Optional(
   				StringEnum(["start", "status"], {
   					description: "start (default): spawn the reviewer and return wait, or the decision if this attempt is already decided. status: what is pending and decided, changing nothing.",
   				}),
   			),
   			model: Type.Optional(Type.String({ description: "Explicit reviewer model override (provider/model-id)" })),
   			deliver_revise: Type.Optional(Type.Boolean({ description: "Promote a revise verdict to the live planner. Default true." })),
   		}),
   		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
   			live = ctx;
   			const post = commandPost(ctx.modelRegistry);
   			if (params.action === "status") {
   				const status = post.gateModule().status(params.job_id);
   				return { content: [{ type: "text", text: formatGateStatus(params.job_id, status) }], details: status as unknown as Record<string, unknown> };
   			}
   			const started = await post.gate({
   				jobId: params.job_id,
   				...(params.model ? { model: params.model } : {}),
   				...(params.deliver_revise === undefined ? {} : { deliverRevise: params.deliver_revise }),
   			});
   			refreshWidget(ctx);
   			if (isGateWait(started)) {
   				const payload = { content: [{ type: "text" as const, text: formatGateWait(started) }], details: started as unknown as Record<string, unknown> };
   				// D7: the parent holds this result before the verdict may wake it.
   				post.reviewRuns.handBack(started.key);
   				return payload;
   			}
   			return { content: [{ type: "text", text: formatGate(started) }], details: started as unknown as Record<string, unknown> };
   		},
   ```
   Update the tool `description` so it says: "Returns {next: wait, attempt, deadline} the moment the reviewer is spawned; the verdict arrives as a cp-verdict wake-up. Returns the decision directly only when this attempt is already decided on disk." and add a `promptGuidelines` line: "next: wait means end the turn; never call cp_gate status to wait for a verdict."

   Add near `formatGate` in `src/gate.ts`:
   ```ts
   export function formatGateStatus(jobId: string, status: { pending?: PendingReview; decisions: GateVerdict[] }): string {
   	const lines = [`${jobId} gate: ${status.decisions.length} decided attempt(s)${status.pending ? `, attempt ${status.pending.attempt} running (deadline ${status.pending.deadline})` : ""}`];
   	for (const decision of status.decisions) lines.push(`  ${decision.attempt}: ${decision.verdict}${decision.cause ? ` (${decision.cause})` : ""} at ${decision.decided_at}`);
   	return lines.join("\n");
   }
   ```

5. **`cp_review`.** Make `diffReviewToolPayload` use `formatDiffReview(result)` for its text. Then the same shape as `cp_gate`: `action` parameter; `status` reads `readPriorAttempts(home, jobId, paths.reviewFile, DiffVerdictSchema, { capExhausted: reviewCapExhausted })` plus `post.reviewRuns.pending(jobId, "review")`; `start` calls `post.diffReview({...})`, and on `isDiffReviewWait(started)` composes `formatReviewWait(started)` (`${wait.surface} review attempt ${wait.attempt} on head ${wait.head_sha.slice(0, 12)} is running [${wait.model}] -> wait` + the same two lines as `formatGateWait`), then `post.reviewRuns.handBack(started.key)`, then returns. Description gains the same sentences as `cp_gate`'s.

6. **`cp_pipeline advance`.** After `const result = await runner.advance(...)`, compose the payload, then:
   ```ts
   			if (result.pending) {
   				// D7 for the pipeline path: advance started the reviewer, so advance hands back.
   				commandPost().reviewRuns.handBack(ReviewRuns.key(result.pending.surface === "review" ? result.ship_id : result.research_id, result.pending.surface, result.pending.attempt));
   			}
   ```
   (`handBack` on a key that is not in this process's map is a no-op, so a `wait` returned for an attempt started by a previous session is harmless.) `formatAdvance` in `src/pipeline.ts` appends `\n  pending: ${result.pending.surface} attempt ${result.pending.attempt}, deadline ${result.pending.deadline}` when `pending` is set.

7. **Orphan sweep.** In `session_start`, immediately after the parent lock block (after `parentLock = acquired.lock; ...}`) and before `surfaceAnswered();`:
   ```ts
   		// spec 2026-09-05 D4: reviewers died with the previous parent. Finish their
   		// attempts as operational faults now, before the widget reads pending.json.
   		try {
   			const report = await commandPost().sweepOrphanReviews();
   			if (report.finished.length > 0) {
   				const text = `pi-command-post: ${report.finished.length} reviewer attempt(s) were lost with the previous session and recorded as operational (${report.finished.map((p) => `${p.job_id} ${p.surface} ${p.attempt}`).join(", ")}); the ladder retries on the next advance.`;
   				if (ctx.hasUI) ctx.ui.notify(text, "warning");
   				else process.stderr.write(`${text}\n`);
   			}
   		} catch (error) {
   			const message = `pi-command-post: orphan review sweep failed: ${(error as Error).message}`;
   			if (ctx.hasUI) ctx.ui.notify(message, "warning");
   			else process.stderr.write(`${message}\n`);
   		}
   ```

8. **Shutdown.** In `session_shutdown`, before `await post?.shutdown();` nothing changes: `manager.shutdownAll()` kills the reviewers; the registry's chains then resolve with `operational` outcomes whose `finish` may run against a closing process. To keep that from writing after teardown, `CommandPost.shutdown()` first sets `this.reviewRuns.wakeupPort = () => false` (no wake-ups during shutdown), then shuts the manager down.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test tests/extension-load.test.ts && npm test`
Expected: PASS. `npm test` is the whole suite; the e2e phases self-skip where their tools are missing.

- [ ] **Step 5: Commit**

```bash
git add extensions/command-post/index.ts src/gate.ts src/diff-review.ts src/pipeline.ts src/command-post.ts tests/extension-load.test.ts
git commit -m "extension: cp_gate/cp_review return wait, hand back, confirm cp-verdict arrival, sweep orphans

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `AGENTS.md` (§The loop table row `gate`; the `cp_review` paragraph; the wake-ups list)
- Modify: `docs/contracts.md` (Fleet state wake-up list; new subsection under Pipeline and checkpoint; Directory layout)
- Modify: `docs/superpowers/specs/2026-09-04-package-audit.md` (one row)
- Test: `tests/contracts.test.ts` if it pins doc/code agreement (search for `docs/contracts.md` in tests; if a test reads the wake-up list, update its expectation).

- [ ] **Step 1: AGENTS.md**

In the loop table, change the `gate` row to:

```
| gate | `cp_gate` | fresh-context reviewer, one revise max, cause-based ladder; returns `wait` at once — the verdict arrives as a `cp-verdict` wake-up, and a pipeline's says to `cp_pipeline advance` |
```

In the `cp_review` paragraph, after "A revise is not the verdict: it is one round.", add: "Every round ends in a `cp-verdict` wake-up, never in the tool's return value: `cp_review` returns `wait` the moment its reviewer is spawned, so end the turn and act when the wake-up lands." Where the text says "you run `cp_review <job-id>` again on that branch", keep it.

Where the wake-up kinds are listed (search `cp-wedged` and "one of four other things"), make it "one of five other things" and add `cp-verdict`: "a reviewer's verdict landed (gate, diff review or quality panel). Act on `next`, or for a pipeline job call `cp_pipeline advance`."

- [ ] **Step 2: docs/contracts.md**

Under *Fleet state*, the list beginning "Three other custom messages wake the parent unasked, and only three:" becomes "Four other custom messages…, and only four:" with a new bullet:

```
- **`cp-verdict`** — a background reviewer's decision landed (spec
  2026-09-05-async-reviewers): the plan gate, the diff review or the quality
  panel. Stamped with the surface and attempt (and the reviewed head for a diff
  review); stale once that attempt has no decision on disk, a later attempt
  exists, the job is over, or the head moved. See
  [Asynchronous reviewers](#asynchronous-reviewers-pendingjson-cp-verdict).
```

and the parenthetical about `cp-unreported` says "the sixth".

Under *Pipeline and checkpoint*, add:

```
### Asynchronous reviewers (`pending.json`, `cp-verdict`)

`cp_gate`, `cp_review` and the quality panel spawn a one-shot reviewer and
return `next: "wait"` at once; `cp_pipeline advance` returns `wait` in state
`gating` while any of them is pending. Each surface is split at its
`awaitVerdict` seam: `start()` is everything before the wait, `finish()` is
everything after it (decide, write the decision file, deliver a revise, shut
the reviewer down), and `src/review-runs.ts` chains them.

- **`pending.json`** lives in the attempt directory (`gate-<n>/`,
  `review-<n>/`, `quality-panel/`) from before the brief is sent until the
  decision is filed. It is what `/status`, the one-pending rule and the orphan
  sweep read. Schema `PendingReviewSchema`; `handed_back` flips when the caller
  has been given its `wait` result.
- **One pending attempt per (job, surface).** A second `start` returns the
  pending record.
- **Durable before announce.** The decision file is written and `pending.json`
  removed before the wake-up is sent. A failed send leaves the decision.
- **Handback before announce.** The wake-up waits until the tool result (or the
  `advance` result) that started the attempt has been composed.
- **Orphans.** A `pending.json` whose pid is dead and whose attempt has no
  decision is finished at `session_start` as an operational fault (the ladder
  retries on another model); its wake-up is sent only when `handed_back` is
  true. The quality panel writes no report for an orphan: it runs again.
- **Delivery.** `verdict_wakeup_sent` and `verdict_wakeup_delivered` are
  journaled on the job's run log; arrival is confirmed from the message in the
  parent's context, never from the send.
```

In *Directory layout*, add `pending.json  a reviewer is running (spec 2026-09-05)` under `gate-<attempt>/` and `review-<attempt>/`, and `quality-panel/pending.json` under the quality entries.

- [ ] **Step 3: Package audit row**

In `docs/superpowers/specs/2026-09-04-package-audit.md`, add to the verdict table before the *Questionnaire overlay* row:

```
| Background task runtime with completion wake-ups; delegated read-only child; multi-model review | `pi-background-tasks` (107.7K, 2.5.0, 2026-09-04) | none | Its Anthropic provider extension loads globally and refuses non-OAuth credentials (this home uses an API key); peers pin pi 0.81–0.84 (this home runs 0.85); `bg_run` is a second shell tool the parent's `tool_call` guards do not inspect; `bg_delegate`/`bg_result` return bodies inline into the parent's context. The one gap it named (reviewer tool calls blocking the parent) is closed in-house by `2026-09-05-async-reviewers-design.md`, which borrows two of its rules: publish only after the result is durable, and only after the caller holds the task id. | `pi.dev/packages/pi-background-tasks`; package `docs/api/eventbus-v1.md`, `docs/subsystems/anthropic-attribution.md`, `src/core/registry.ts` L2287-2327 |
```

- [ ] **Step 4: Typecheck and full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/contracts.md docs/superpowers/specs/2026-09-04-package-audit.md
git commit -m "docs: the sixth wake-up, pending.json, and the pi-background-tasks audit row

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Operator step — one real session

**Files:** none (verification only).

- [ ] **Step 1: Start a parent on this checkout**

Run: `pi -e extensions/command-post/index.ts` from the repo root. Confirm `/doctor` is clean and `/status` renders.

- [ ] **Step 2: Run a pipeline through a gate**

In the session: `cp_pipeline start` on a small research task for `project:pi-command-post`; when the planner's envelope lands, `cp_pipeline advance <research_id>`. Expected: the tool returns within seconds with `[gating/wait]` and a `pending: gate attempt 1, deadline …` line; the widget row shows `gate 1 ⋅ <age>`; a `cp-verdict` message arrives in the transcript reading `<research_id> gate attempt 1: <verdict> … Next: call cp_pipeline advance <research_id>.`

- [ ] **Step 3: Advance on the wake-up**

`cp_pipeline advance <research_id>` again. Expected: the ladder continues exactly as before the change (revise delivered / checkpoint minted / surface), with no second reviewer spawned. `state/runs/<research_id>/events.jsonl` (or the dotdir path in single mode) contains `review_started`, `gate_decided`, `verdict_wakeup_sent`, `verdict_wakeup_delivered` in that order.

- [ ] **Step 4: Orphan path**

Start a gate (`cp_gate <job_id>`), quit pi before the verdict lands, restart. Expected: a warning at start naming the lost attempt; `gate-1.json` exists with `cause: operational`; `pending.json` is gone; `cp_gate <job_id>` starts attempt 2.

- [ ] **Step 5: Report**

Paste the tool outputs and the `events.jsonl` type sequence verbatim into the PR description, open the PR against `main`, and stop.

```bash
gh pr create --title "feat(reviewers): gate, review and quality panel return wait; verdicts wake the parent" --body "$(cat <<'EOF'
## Summary
- cp_gate, cp_review and the quality panel return `wait` at spawn and finish in the background
- new registry `src/review-runs.ts`: pending.json, one attempt per (job, surface), handback and durability barriers, orphan sweep
- sixth wake-up kind `cp-verdict` with staleness rules; cp_pipeline advance returns wait while a reviewer runs
- /status and the widget show the running reviewer

Spec: docs/superpowers/specs/2026-09-05-async-reviewers-design.md
Plan: docs/superpowers/plans/2026-09-05-async-reviewers.md

## Test plan
- [ ] npm test
- [ ] operator session: pipeline through a gate, wake-up observed, advance completes
- [ ] orphan path: parent restarted mid-review, attempt finished operational

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
