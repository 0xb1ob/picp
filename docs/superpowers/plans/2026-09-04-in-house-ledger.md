# In-house job ledger (drop br) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `br` binary with an in-house ledger over one JSON document at `<home>/.pi-command-post/jobs.json`, give the model a `cp_job` tool and the operator a `/cp-jobs` command, import the open `.beads/` issues once, and remove br from doctor, scaffold and the tool manifest.

**Architecture:** `src/ledger.ts` keeps its public `Ledger` surface (same method names, same `LedgerError`) but reads and writes the document through the atomic store and per-path queue `fleet.json` already uses; `ready`/`blocked` are computed from `blocked_by`. A new adapter `extensions/command-post/jobs.ts` registers the tool and the command over the `CommandPost` object; `src/ledger-import.ts` reads `.beads/issues.jsonl` directly. Doctor's six br checks become file checks. This is PR 2 of the spec and assumes PR 1 (the `job_id` rename) has landed: every identifier below already says `job_id`, `JobIdSchema`, `CP_JOB_ID`.

**Tech Stack:** TypeScript (ES2023, `nodenext`, strict), Node 24 (`node:crypto` `randomInt`), `node --test`, typebox, pi extension API.

**Spec:** `docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md`

## Global Constraints

- The document path is `<home>/.pi-command-post/jobs.json` (`LAYOUT.jobsFile`); `.pi-command-post/` joins `NEVER_COMMIT_PATHS` and the scaffolded `.gitignore`; `.beads/` **stays** on that list.
- Statuses: `open | in_progress | deferred | closed`. Types: `task|bug|feature|epic|question|docs|chore`. Priority 0–4, default 2.
- Ids: `<prefix>-<4 chars of [a-z0-9]>` or `<prefix>-<slug>-<4 chars>`; 8 collisions at 4 chars, then 5 chars; slug matches `^[a-z0-9][a-z0-9-]{0,40}$`; every id satisfies `JOB_ID_PATTERN` (unchanged). The prefix is recorded in the document and wins over `CP_LEDGER_PREFIX` afterwards.
- Every write: inside `queued(file, …)`, read → validate → mutate → validate → `atomicWriteJson`. No in-memory cache.
- `ready` = `status === "open"` and every `blocked_by` id is `closed`. `blockersOf(id)` = `blocked_by` ids whose status is not `closed`. No page size anywhere; `limit: 0` means unlimited (callers pass it today).
- `Ledger.close` refuses a different reason on an already-closed job and is a no-op for the same reason. The class never refuses a close because of a live worker; **the `cp_job` tool does** (fleet phase `waiting` or `held` → refuse, name `cp_teardown`).
- `cp_job create` refuses `delivery:pipeline` and `delivery:answer`; `cp_job claim` refuses an `in_progress` job.
- Import keeps only rows with status `open`, `in_progress` or `deferred` (`closed` and `tombstone` stay in `.beads/`), preserves ids, normalises timestamps to second precision, refuses when any incoming id exists or the prefix differs.
- Doctor size warning at 5,000 jobs.
- No new npm dependency. Every commit passes `npm run typecheck`; the PR passes `npm test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Golden files are regenerated with `CP_UPDATE_GOLDEN=1` and the diff reviewed before committing.

## File structure

| file | responsibility |
|---|---|
| `src/contracts.ts` | `JobSchema`, `JobsDocumentSchema`, `validateJobsDocument`, `jobsInvariantErrors`, `findDependencyCycle`, `emptyJobsDocument`, constants, `LAYOUT.runtimeDir/jobsFile`, never-commit path, `cp_job` in `WORKER_FORBIDDEN_TOOLS`. |
| `src/ledger.ts` (rewritten) | `Ledger` over the document; label contract (kept); `mintJobId`; `initJobsDocument`, `readJobsDocument`, `jobsFile`; pure `openBlockersOf`, `isReady`. |
| `tests/harness/ledger.ts` (new, replaces `beads.ts`) | `createScratchLedger` over a temp home. |
| `src/scaffold.ts` | ledger step writes the empty document; `dir.runtime`. |
| `src/doctor.ts` | br checks out; `ledger.file/ids/deps/prefix/size/beads_archive` in. |
| `src/tool-manifest.ts`, `src/install-tools.ts`, `scripts/install-tools.ts` | br removed. |
| `src/guards.ts` | `#checkBr` and `ledger_inlines_artifact` removed. |
| `extensions/command-post/jobs.ts` (new) | `registerJobs(pi, ports)`: `cp_job` tool, `/cp-jobs` command; pure `runJobAction`, `parseJobsArgs`, `formatJobLine`, `formatJobDetail`. |
| `src/ledger-import.ts` (new) | `planBeadsImport` (pure), `importBeads`. |
| `tests/fixtures/beads-issues.jsonl` (new) | importer fixture. |
| docs | AGENTS.md §Jobs, contracts.md §Ledger + §Doctor, parity.md, README, e2e README, cp-memory skill. |

---

### Task 1: Contracts for the jobs document

**Files:**
- Modify: `src/contracts.ts` (new section before `// Validation`; `LAYOUT`; `NEVER_COMMIT_PATHS`; `WORKER_FORBIDDEN_TOOLS`)
- Modify: `.gitignore` (repo root)
- Test: `tests/contracts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const JOB_STATUSES: readonly ["open","in_progress","deferred","closed"]; export type JobStatus; export const JobStatusSchema;
  export const OPEN_JOB_STATUSES: readonly JobStatus[];
  export const JOB_TYPES; export type JobType; export const JobTypeSchema;
  export const JOB_PRIORITY_MIN = 0, JOB_PRIORITY_MAX = 4, DEFAULT_JOB_PRIORITY = 2;
  export const JOB_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,40}$";
  export const JOB_ID_SUFFIX_LENGTH = 4, JOB_ID_MINT_RETRIES = 8, JOBS_SIZE_WARNING = 5000;
  export const JobCommentSchema; export type JobComment = { at: string; author: string; text: string };
  export const JobSchema; export type Job;
  export const JobsDocumentSchema; export type JobsDocument = { schema_version: number; prefix: string; jobs: Job[] };
  export function emptyJobsDocument(prefix: string): JobsDocument;
  export function findDependencyCycle(jobs: readonly Job[]): string[] | undefined;
  export function jobsInvariantErrors(doc: JobsDocument): { ids: string[]; deps: string[] };
  export function validateJobsDocument(value: unknown): ValidationResult<JobsDocument>;
  LAYOUT.runtimeDir === ".pi-command-post"; LAYOUT.jobsFile === ".pi-command-post/jobs.json";
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/contracts.test.ts` (add the new names to the import block from `../src/contracts.ts`: `emptyJobsDocument`, `findDependencyCycle`, `type Job`, `JOB_STATUSES`, `jobsInvariantErrors`, `LAYOUT`, `NEVER_COMMIT_PATHS`, `validateJobsDocument`, `WORKER_FORBIDDEN_TOOLS` — some are already imported; do not duplicate):

```ts
// ---------------------------------------------------------------------------
// Jobs document (spec 2026-09-04)
// ---------------------------------------------------------------------------

function job(overrides: Partial<Job> & { id: string }): Job {
	return {
		title: "t",
		status: "open",
		priority: 2,
		labels: ["project:demo", "delivery:pr"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T10:00:00Z",
		updated_at: "2026-09-04T10:00:00Z",
		...overrides,
	};
}

test("the jobs document lives in the runtime dotdir, which is never committed", () => {
	assert.equal(LAYOUT.runtimeDir, ".pi-command-post");
	assert.equal(LAYOUT.jobsFile, ".pi-command-post/jobs.json");
	assert.ok(NEVER_COMMIT_PATHS.includes(".pi-command-post/"));
	assert.ok(NEVER_COMMIT_PATHS.includes(".beads/"), "the frozen archive stays uncommittable");
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_job"));
	assert.deepEqual(JOB_STATUSES, ["open", "in_progress", "deferred", "closed"]);
});

test("validateJobsDocument accepts an empty document and a sound one", () => {
	assert.equal(validateJobsDocument(emptyJobsDocument("cp")).ok, true);
	const doc = { ...emptyJobsDocument("cp"), jobs: [job({ id: "cp-a" }), job({ id: "cp-b", blocked_by: ["cp-a"] })] };
	assert.equal(validateJobsDocument(doc).ok, true);
});

test("validateJobsDocument refuses shape errors with a path", () => {
	const result = validateJobsDocument({ ...emptyJobsDocument("cp"), jobs: [{ ...job({ id: "cp-a" }), status: "tombstone" }] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.errors.join("\n"), /\/jobs\/0\/status/);
	assert.equal(validateJobsDocument({ ...emptyJobsDocument("CP") }).ok, false, "prefix must match LEDGER_PREFIX_PATTERN");
});

test("jobsInvariantErrors names duplicates, foreign prefixes, closed inconsistencies, unknown blockers, self-deps and cycles", () => {
	const doc = {
		...emptyJobsDocument("cp"),
		jobs: [
			job({ id: "cp-a", blocked_by: ["cp-b"] }),
			job({ id: "cp-a" }),
			job({ id: "xx-1" }),
			job({ id: "cp-b", blocked_by: ["cp-a"] }),
			job({ id: "cp-c", status: "closed" }),
			job({ id: "cp-d", closed_at: "2026-09-04T10:00:00Z", close_reason: "r" }),
			job({ id: "cp-e", blocked_by: ["cp-e", "cp-nope"] }),
		],
	};
	const errors = jobsInvariantErrors(doc);
	assert.deepEqual(errors.ids, [
		"duplicate id cp-a",
		"xx-1 does not carry this document's prefix cp-",
		"cp-c is closed without closed_at/close_reason",
		"cp-d carries closed_at/close_reason but is open",
	]);
	assert.ok(errors.deps.includes("cp-e depends on itself"));
	assert.ok(errors.deps.includes("cp-e is blocked by unknown cp-nope"));
	assert.ok(errors.deps.some((line) => line.startsWith("dependency cycle: cp-a -> cp-b -> cp-a")), errors.deps.join("\n"));

	const invalid = validateJobsDocument(doc);
	assert.equal(invalid.ok, false, "validateJobsDocument runs the invariants too");
});

test("findDependencyCycle returns the cycle path or undefined", () => {
	assert.equal(findDependencyCycle([job({ id: "cp-a" }), job({ id: "cp-b", blocked_by: ["cp-a"] })]), undefined);
	assert.deepEqual(findDependencyCycle([job({ id: "cp-a", blocked_by: ["cp-b"] }), job({ id: "cp-b", blocked_by: ["cp-a"] })]), ["cp-a", "cp-b", "cp-a"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/contracts.test.ts`
Expected: FAIL — the new exports do not exist (`SyntaxError: The requested module does not provide an export named 'validateJobsDocument'`).

- [ ] **Step 3: Add the contracts**

In `src/contracts.ts`, immediately before the `// Validation` section header, add:

```ts
// ---------------------------------------------------------------------------
// Jobs ledger — <home>/.pi-command-post/jobs.json (spec 2026-09-04)
// ---------------------------------------------------------------------------

export const JOB_STATUSES = ["open", "in_progress", "deferred", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JobStatusSchema = StringEnum([...JOB_STATUSES]);
/** Statuses `update()` may set. Closing is a transition (`close()`), never an edit. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = Object.freeze(["open", "in_progress", "deferred"]);

export const JOB_TYPES = ["task", "bug", "feature", "epic", "question", "docs", "chore"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JobTypeSchema = StringEnum([...JOB_TYPES]);

export const JOB_PRIORITY_MIN = 0;
export const JOB_PRIORITY_MAX = 4;
export const DEFAULT_JOB_PRIORITY = 2;
/** `<prefix>-<slug>-<suffix>`: lowercase, hyphenated, short enough to stay a readable branch name. */
export const JOB_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,40}$";
export const JOB_ID_SUFFIX_LENGTH = 4;
/** Collisions tolerated at 4 characters before the suffix grows to 5. */
export const JOB_ID_MINT_RETRIES = 8;
/** Doctor warns past this many jobs in one document. */
export const JOBS_SIZE_WARNING = 5000;

export const JobCommentSchema = Type.Object(
	{
		at: IsoTimestampSchema,
		author: Type.String({ minLength: 1, maxLength: 120 }),
		text: Type.String({ minLength: 1, maxLength: 4000 }),
	},
	{ additionalProperties: false },
);
export type JobComment = Static<typeof JobCommentSchema>;

/**
 * One job. `blocked_by` is the only place a dependency lives; `ready` and
 * `blocked` are computed from it, never stored. `closed_at` and
 * `close_reason` are present iff `status` is `closed` (an invariant, below).
 */
export const JobSchema = Type.Object(
	{
		id: JobIdSchema,
		title: Type.String({ minLength: 1, maxLength: 500 }),
		description: Type.Optional(Type.String({ maxLength: 20_000 })),
		notes: Type.Optional(Type.String({ maxLength: 20_000 })),
		status: JobStatusSchema,
		type: Type.Optional(JobTypeSchema),
		priority: Type.Integer({ minimum: JOB_PRIORITY_MIN, maximum: JOB_PRIORITY_MAX }),
		labels: Type.Array(Type.String({ minLength: 1, maxLength: 120 })),
		assignee: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		external_ref: Type.Optional(Type.String({ pattern: "^https://\\S+$", maxLength: 1000 })),
		blocked_by: Type.Array(JobIdSchema),
		comments: Type.Array(JobCommentSchema),
		created_at: IsoTimestampSchema,
		updated_at: IsoTimestampSchema,
		closed_at: Type.Optional(IsoTimestampSchema),
		close_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	},
	{ additionalProperties: false },
);
export type Job = Omit<Static<typeof JobSchema>, "status" | "type"> & { status: JobStatus; type?: JobType };

export const JobsDocumentSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		prefix: Type.String({ pattern: LEDGER_PREFIX_PATTERN }),
		jobs: Type.Array(JobSchema),
	},
	{ additionalProperties: false },
);
export type JobsDocument = Omit<Static<typeof JobsDocumentSchema>, "jobs"> & { jobs: Job[] };

export function emptyJobsDocument(prefix: string): JobsDocument {
	return { schema_version: SCHEMA_VERSION, prefix, jobs: [] };
}

/** The first cycle found over `blocked_by`, as a path that ends where it starts, or `undefined`. */
export function findDependencyCycle(jobs: readonly Job[]): string[] | undefined {
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		const mark = state.get(id);
		if (mark === "done") return undefined;
		if (mark === "visiting") return [...path.slice(path.indexOf(id)), id];
		state.set(id, "visiting");
		path.push(id);
		for (const blocker of byId.get(id)?.blocked_by ?? []) {
			if (!byId.has(blocker)) continue;
			const found = visit(blocker);
			if (found) return found;
		}
		path.pop();
		state.set(id, "done");
		return undefined;
	};
	for (const job of jobs) {
		const found = visit(job.id);
		if (found) return found;
	}
	return undefined;
}

/**
 * Cross-record invariants shape validation cannot express. `ids` are faults in
 * a single record; `deps` are faults in the graph. Both empty means sound.
 */
export function jobsInvariantErrors(doc: JobsDocument): { ids: string[]; deps: string[] } {
	const ids: string[] = [];
	const deps: string[] = [];
	const seen = new Set<string>();
	for (const job of doc.jobs) {
		if (seen.has(job.id)) ids.push(`duplicate id ${job.id}`);
		seen.add(job.id);
		if (!job.id.startsWith(`${doc.prefix}-`)) ids.push(`${job.id} does not carry this document's prefix ${doc.prefix}-`);
		const hasClosedFields = job.closed_at !== undefined && job.close_reason !== undefined;
		if (job.status === "closed" && !hasClosedFields) ids.push(`${job.id} is closed without closed_at/close_reason`);
		if (job.status !== "closed" && (job.closed_at !== undefined || job.close_reason !== undefined)) {
			ids.push(`${job.id} carries closed_at/close_reason but is ${job.status}`);
		}
	}
	for (const job of doc.jobs) {
		for (const blocker of job.blocked_by) {
			if (blocker === job.id) deps.push(`${job.id} depends on itself`);
			else if (!seen.has(blocker)) deps.push(`${job.id} is blocked by unknown ${blocker}`);
		}
	}
	const cycle = findDependencyCycle(doc.jobs);
	if (cycle) deps.push(`dependency cycle: ${cycle.join(" -> ")}`);
	return { ids, deps };
}

export function validateJobsDocument(value: unknown): ValidationResult<JobsDocument> {
	const shape = validate<JobsDocument>(JobsDocumentSchema, value);
	if (!shape.ok) return shape;
	const invariants = jobsInvariantErrors(shape.value);
	const errors = [...invariants.ids, ...invariants.deps];
	if (errors.length > 0) return { ok: false, errors };
	return shape;
}
```

`validateJobsDocument` references `ValidationResult` and `validate`, which are declared in the section that follows; function declarations hoist, and `ValidationResult` is a type, so the order compiles. If `tsc` complains about `validate` being used before its `const`/`function` declaration, move the whole block **after** the `validate` function instead.

Then:

1. In `LAYOUT`, after `migrationsDir`, add:
   ```ts
   	/** The runtime dotdir: one directory a single-project home can ignore wholesale (spec 2026-09-04 D2). */
   	runtimeDir: ".pi-command-post",
   	/** The jobs ledger — what br's `.beads/` used to be. */
   	jobsFile: ".pi-command-post/jobs.json",
   ```
2. `NEVER_COMMIT_PATHS` becomes `Object.freeze(["data/", "state/", "projects/", ".beads/", ".pi-command-post/"])`.
3. In `WORKER_FORBIDDEN_TOOLS`, after `"cp_memory",` add:
   ```ts
   	/** The ledger is the parent's bookkeeping; a worker that could close or reopen jobs could hide its own failure. */
   	"cp_job",
   ```
4. Repo root `.gitignore`: add a line `.pi-command-post/` after `.beads/`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contracts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts tests/contracts.test.ts .gitignore
git commit -m "feat(contracts): the jobs document — JobSchema, invariants, layout, never-commit path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `src/ledger.ts` over the document, and the scratch-home harness

**Files:**
- Rewrite: `src/ledger.ts`
- Rewrite: `tests/ledger.test.ts`
- Create: `tests/harness/ledger.ts`; Delete: `tests/harness/beads.ts`
- Modify: `tests/harness/index.ts:8`, `tests/harness/live.ts:22,53-57,206`
- Modify: `src/command-post.ts:579-582`, `src/dispatch.ts:44,267-271,567-571`, `src/status.ts:96,135,173,203,440,672` (+ comments at 11, 27-31, 410-429)
- Modify: `src/doctor.ts` (remove the `MIN_BR_VERSION` import, `#belowFloor` and its call; `TOOL_FIX.br` text), `scripts/install-tools.ts:27,97-99`
- Modify: tests that gated on br: `tests/dispatch.test.ts`, `tests/pipeline.test.ts`, `tests/live-harness.test.ts`, `tests/awaiting.test.ts`, `tests/doctor.test.ts`, `tests/status.test.ts`, `tests/e2e/{questions,phase2,phase3,attach,live-smoke,packaging}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class LedgerError extends Error {}
  export const LABEL_PREFIX; export interface JobLabels; export function formatJobLabels, parseJobLabels, requireJobLabels(job: Job): JobLabels;   // unchanged
  export interface LedgerOptions { home: string; actor?: string; now?: () => Date; knownProjects?: readonly string[]; random?: (max: number) => number }
  export interface IntakeInput { title; project; delivery: Delivery; kind?: JobKind; type?: JobType; priority?: number; description?; externalRef?; slug?; assignee?; labels?: readonly string[] }
  export interface ListFilter { project?; delivery?; kind?; status?: JobStatus | readonly JobStatus[]; all?: boolean; limit?: number; labels?: readonly string[] }
  export interface UpdatePatch { status?: JobStatus; assignee?; priority?; notes?; addLabels?; removeLabels? }
  export function jobsFile(home: string): string
  export function initJobsDocument(home: string, prefix: string): { document: JobsDocument; created: boolean }
  export function readJobsDocument(home: string): JobsDocument
  export function mintJobId(prefix: string, existing: ReadonlySet<string>, options?: { slug?: string; random?: (max: number) => number }): string
  export function openBlockersOf(doc: JobsDocument, id: string): string[]
  export function isReady(doc: JobsDocument, job: Job): boolean
  export class Ledger { home; file; knownProjects; read(); create(); show(); list(); ready(); blocked(); history(); blockersOf(); update(); claim(); close(); drop(); comment(): Promise<Job>; addDep(); removeDep(); importJobs(jobs: readonly Job[]): Promise<void> }
  ```
- Removed: `LedgerIssue` (use `Job`), `LedgerRunner`, `RunResult`, `unwrapIssues`, `DEFAULT_BR_BIN`, `MIN_BR_VERSION`, `DEFAULT_LEDGER_TIMEOUT_MS`, `LEDGER_STATUSES`, `LedgerStatus`, `OPEN_STATUSES`, `LEDGER_ISSUE_TYPES`, `LedgerIssueType`, `LedgerIssueSchema`, `DEFAULT_PRIORITY` (use `DEFAULT_JOB_PRIORITY`).

- [ ] **Step 1: Write the harness**

Create `tests/harness/ledger.ts`:

```ts
/**
 * Scratch ledger: a throwaway home with an empty jobs document, so ledger
 * suites exercise the real class without touching this build's own ledger.
 * Replaces the br-backed `beads.ts`; no binary is needed any more.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobsDocument } from "../../src/contracts.ts";
import { initJobsDocument, Ledger, type LedgerOptions, readJobsDocument } from "../../src/ledger.ts";

export interface ScratchLedger {
	/** The home the document lives under. */
	path: string;
	ledger: Ledger;
	/** The document as it is on disk right now (for asserting on state the class does not expose). */
	document(): JobsDocument;
	cleanup(): void;
}

export interface ScratchLedgerOptions {
	prefix?: string;
	knownProjects?: readonly string[];
	/** Put the document under an existing home instead of a fresh temp dir. */
	home?: string;
}

export function createScratchLedger(options: ScratchLedgerOptions = {}): ScratchLedger {
	const path = options.home ?? mkdtempSync(join(tmpdir(), "cp-ledger-"));
	initJobsDocument(path, options.prefix ?? "cp");
	const ledgerOptions: LedgerOptions = {
		home: path,
		actor: "cp-test",
		...(options.knownProjects ? { knownProjects: options.knownProjects } : {}),
	};
	return {
		path,
		ledger: new Ledger(ledgerOptions),
		document: () => readJobsDocument(path),
		cleanup() {
			if (!options.home) rmSync(path, { recursive: true, force: true });
		},
	};
}
```

Delete `tests/harness/beads.ts`. In `tests/harness/index.ts` replace line 8 with:

```ts
export { createScratchLedger, type ScratchLedger, type ScratchLedgerOptions } from "./ledger.ts";
```

- [ ] **Step 2: Write the failing ledger tests**

Replace `tests/ledger.test.ts` entirely:

```ts
/**
 * The in-house ledger (spec 2026-09-04). Hermetic: a scratch home, no binary.
 *
 * What is asserted is the contract: project/delivery labels are mandatory,
 * ids are minted collision-free, deps gate `ready`, closing carries a reason
 * and is a transition, dropped work is closed and never deleted, and every
 * write goes to disk atomically as a valid document.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Job, LAYOUT } from "../src/contracts.ts";
import {
	formatJobLabels,
	initJobsDocument,
	isReady,
	jobsFile,
	Ledger,
	LedgerError,
	mintJobId,
	openBlockersOf,
	parseJobLabels,
	readJobsDocument,
	requireJobLabels,
} from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const NOW = new Date("2026-09-04T10:00:00Z");

const JOB: Job = {
	id: "cp-a",
	title: "job",
	status: "open",
	priority: 2,
	labels: ["project:demo", "delivery:pr", "kind:ship"],
	blocked_by: [],
	comments: [],
	created_at: "2026-09-04T10:00:00Z",
	updated_at: "2026-09-04T10:00:00Z",
};

// ---------------------------------------------------------------------------
// labels (unchanged contract)
// ---------------------------------------------------------------------------

test("job labels round trip and are read fail-closed", () => {
	assert.deepEqual(formatJobLabels({ project: "demo", delivery: "pr", kind: "ship" }), ["project:demo", "delivery:pr", "kind:ship"]);
	assert.deepEqual(requireJobLabels(JOB), { project: "demo", delivery: "pr", kind: "ship" });
	assert.deepEqual(parseJobLabels(["project:demo"]), { project: "demo" });
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["delivery:pr"] }), /missing project:/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo"] }), /missing delivery:/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo", "delivery:carrier-pigeon"] }), /not one of/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:demo", "delivery:pr", "kind:vibes"] }), /kind:vibes is not one of/);
	assert.throws(() => requireJobLabels({ ...JOB, labels: ["project:a", "project:b", "delivery:pr"] }), /2 project: labels/);
});

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

test("initJobsDocument creates an empty document once and never rewrites it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const first = initJobsDocument(home.path, "cp");
	assert.equal(first.created, true);
	assert.deepEqual(first.document, { schema_version: 1, prefix: "cp", jobs: [] });
	assert.equal(jobsFile(home.path), join(home.path, LAYOUT.jobsFile));
	assert.ok(existsSync(jobsFile(home.path)));

	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [JOB] }));
	const second = initJobsDocument(home.path, "cps");
	assert.equal(second.created, false);
	assert.equal(second.document.prefix, "cp", "an existing document wins over a new prefix");
	assert.equal(second.document.jobs.length, 1);

	assert.throws(() => initJobsDocument(join(home.path, "other"), "Not-Ok"), /not a usable ledger prefix/);
});

test("readJobsDocument fails closed: missing, not JSON, invalid shape, broken invariant", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.throws(() => readJobsDocument(home.path), /no ledger at .*jobs\.json/);
	mkdirSync(join(home.path, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(jobsFile(home.path), "{not json");
	assert.throws(() => readJobsDocument(home.path), /is not JSON/);
	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [{ id: "cp-a" }] }));
	assert.throws(() => readJobsDocument(home.path), /violates the jobs contract/);
	writeFileSync(jobsFile(home.path), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: [JOB, JOB] }));
	assert.throws(() => readJobsDocument(home.path), /duplicate id cp-a/);
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test("mintJobId draws four lowercase base36 characters, redraws on collision and lengthens after eight", () => {
	const fixed = (values: number[]) => {
		let index = 0;
		return (_max: number) => values[index++ % values.length] as number;
	};
	assert.equal(mintJobId("cp", new Set(), { random: fixed([0, 1, 2, 3]) }), "cp-abcd");
	assert.equal(mintJobId("cp", new Set(), { slug: "t02-contracts", random: fixed([0, 1, 2, 3]) }), "cp-t02-contracts-abcd");
	// First draw collides, second does not.
	assert.equal(mintJobId("cp", new Set(["cp-aaaa"]), { random: fixed([0, 0, 0, 0, 0, 0, 0, 1]) }), "cp-aaab");
	// Eight collisions in a row: the ninth draw is five characters long.
	const always = (_max: number) => 0;
	assert.equal(mintJobId("cp", new Set(["cp-aaaa"]), { random: always }), "cp-aaaaa");
	assert.throws(() => mintJobId("cp", new Set(["cp-aaaa", "cp-aaaaa"]), { random: always }), /could not mint a unique id/);
	assert.throws(() => mintJobId("cp", new Set(), { slug: "Has Spaces" }), /slug .* must match/);
	// Real randomness: 200 mints, all unique, all path-safe.
	const seen = new Set<string>();
	for (let i = 0; i < 200; i += 1) {
		const id = mintJobId("cp", seen);
		assert.match(id, /^cp-[a-z0-9]{4}$/);
		seen.add(id);
	}
	assert.equal(seen.size, 200);
});

// ---------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------

test("intake refuses what the contract forbids, before anything is written", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	await assert.rejects(ledger.create({ title: "  ", project: "demo", delivery: "pr" }), /needs a title/);
	await assert.rejects(ledger.create({ title: "x", project: "bad name", delivery: "pr" }), /not a valid label value/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "fax" as never }), /delivery .* must be one of/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", kind: "vibes" as never }), /kind .* must be one of/);
	await assert.rejects(ledger.create({ title: "x", project: "unknown", delivery: "pr" }), /unknown project "unknown" — register it first; known: demo/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", externalRef: "github.com/x" }), /must be a full https url/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", labels: ["a,b"] }), /may not contain a comma/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", type: "saga" as never }), /type .* must be one of/);
	await assert.rejects(ledger.create({ title: "x", project: "demo", delivery: "pr", priority: 9 }), /priority .* between 0 and 4/);
	assert.deepEqual(scratch.document().jobs, [], "nothing was written");
});

test("create writes a valid record with the job labels, defaults and the actor-free shape", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], now: () => NOW });
	const job = await ledger.create({
		title: "  fix the thing  ",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		description: "d",
		externalRef: "https://github.com/o/r/issues/1",
		labels: ["phase:7"],
		slug: "fix-thing",
	});
	assert.match(job.id, /^cp-fix-thing-[a-z0-9]{4}$/);
	assert.equal(job.title, "fix the thing");
	assert.equal(job.status, "open");
	assert.equal(job.priority, 2);
	assert.equal(job.type, "task");
	assert.deepEqual(job.labels, ["project:demo", "delivery:pr", "kind:ship", "phase:7"]);
	assert.equal(job.external_ref, "https://github.com/o/r/issues/1");
	assert.deepEqual(job.blocked_by, []);
	assert.equal(job.created_at, "2026-09-04T10:00:00Z");
	assert.deepEqual(scratch.document().jobs, [job], "what was returned is what is on disk");
	assert.deepEqual(await ledger.show(job.id), job);
	await assert.rejects(ledger.show("cp-nope"), /cp-nope: no such job/);
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("the full job lifecycle: create -> ready -> claim -> comment -> close, and a close is a transition", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const job = await ledger.create({ title: "a", project: "demo", delivery: "pr", kind: "ship" });

	assert.deepEqual((await ledger.ready()).map((j) => j.id), [job.id]);
	const claimed = await ledger.claim(job.id, job.id);
	assert.equal(claimed.status, "in_progress");
	assert.equal(claimed.assignee, job.id);
	assert.deepEqual(await ledger.ready(), [], "a claimed job is not ready");

	const commented = await ledger.comment(job.id, "blocker: waiting on the operator");
	assert.equal(commented.comments.length, 1);
	assert.equal(commented.comments[0]?.author, "cp-test");
	assert.equal(commented.comments[0]?.text, "blocker: waiting on the operator");
	await assert.rejects(ledger.comment(job.id, "   "), /empty comment/);

	await assert.rejects(ledger.update(job.id, { status: "closed" }), /refusing to set .* to closed through update/);
	await assert.rejects(ledger.update(job.id, {}), /nothing to change/);
	await assert.rejects(ledger.close(job.id, " "), /a reason is required/);

	const closed = await ledger.close(job.id, "merged: https://github.com/o/r/pull/1");
	assert.equal(closed.status, "closed");
	assert.equal(closed.close_reason, "merged: https://github.com/o/r/pull/1");
	assert.ok(closed.closed_at);
	assert.deepEqual(await ledger.close(job.id, "merged: https://github.com/o/r/pull/1"), closed, "same reason: idempotent");
	await assert.rejects(ledger.close(job.id, "something else"), /already closed .* a close is a fact/);
	assert.deepEqual((await ledger.history()).map((j) => j.id), [job.id]);
	assert.deepEqual(await ledger.list(), [], "closed jobs are hidden without all");
	assert.equal((await ledger.list({ all: true })).length, 1);
});

test("drop closes with a reason and never deletes", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const job = await scratch.ledger.create({ title: "a", project: "demo", delivery: "local" });
	await assert.rejects(scratch.ledger.drop(job.id, ""), /say why it was dropped/);
	const dropped = await scratch.ledger.drop(job.id, "superseded by cp-b");
	assert.equal(dropped.close_reason, "dropped: superseded by cp-b");
	assert.equal(scratch.document().jobs.length, 1);
	const again = await scratch.ledger.drop(job.id, "dropped: superseded by cp-b");
	assert.equal(again.close_reason, "dropped: superseded by cp-b", "an already-prefixed reason is not double-prefixed");
});

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

test("dependencies gate ready, blockersOf is fail-closed, and the graph refuses self, unknown and cycles", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const { ledger } = scratch;
	const research = await ledger.create({ title: "research", project: "demo", delivery: "pipeline", kind: "research" });
	const ship = await ledger.create({ title: "ship", project: "demo", delivery: "pr", kind: "ship" });

	await ledger.addDep(ship.id, research.id);
	await ledger.addDep(ship.id, research.id); // idempotent
	assert.deepEqual((await ledger.show(ship.id)).blocked_by, [research.id]);
	assert.deepEqual((await ledger.ready()).map((j) => j.id), [research.id]);
	assert.deepEqual((await ledger.blocked()).map((j) => j.id), [ship.id]);
	assert.deepEqual(await ledger.blockersOf(ship.id), [research.id]);
	assert.deepEqual(await ledger.blockersOf("cp-unknown"), []);

	await assert.rejects(ledger.addDep(ship.id, ship.id), /cannot depend on itself/);
	await assert.rejects(ledger.addDep(ship.id, "cp-nope"), /cp-nope: no such job/);
	await assert.rejects(ledger.addDep(research.id, ship.id), /dependency cycle/);

	await ledger.close(research.id, "gate pass");
	assert.deepEqual(await ledger.blockersOf(ship.id), [], "a closed blocker blocks nothing");
	assert.deepEqual((await ledger.ready()).map((j) => j.id), [ship.id]);
	assert.deepEqual(await ledger.blocked(), []);

	await ledger.removeDep(ship.id, research.id);
	await ledger.removeDep(ship.id, research.id); // idempotent
	assert.deepEqual((await ledger.show(ship.id)).blocked_by, []);

	const doc = scratch.document();
	assert.equal(isReady(doc, doc.jobs.find((j) => j.id === ship.id) as Job), true);
	assert.deepEqual(openBlockersOf(doc, ship.id), []);
});

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

test("list filters AND labels and statuses, limit 0 is unlimited, history is newest-closed first", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["a", "b"] });
	t.after(() => scratch.cleanup());
	let tick = 0;
	const ledger = new Ledger({ home: scratch.path, now: () => new Date(NOW.getTime() + tick++ * 1000) });
	const a1 = await ledger.create({ title: "a1", project: "a", delivery: "pr", kind: "ship" });
	const a2 = await ledger.create({ title: "a2", project: "a", delivery: "local", kind: "research" });
	const b1 = await ledger.create({ title: "b1", project: "b", delivery: "pr" });
	await ledger.claim(b1.id, b1.id);
	await ledger.update(a2.id, { status: "deferred", priority: 0, notes: "later", addLabels: ["phase:7"] });

	assert.deepEqual((await ledger.list({ project: "a" })).map((j) => j.title), ["a1", "a2"]);
	assert.deepEqual((await ledger.list({ project: "a", delivery: "pr" })).map((j) => j.title), ["a1"]);
	assert.deepEqual((await ledger.list({ kind: "research" })).map((j) => j.title), ["a2"]);
	assert.deepEqual((await ledger.list({ labels: ["phase:7"] })).map((j) => j.title), ["a2"]);
	assert.deepEqual((await ledger.list({ status: "in_progress" })).map((j) => j.title), ["b1"]);
	assert.deepEqual((await ledger.list({ status: ["open", "deferred"] })).map((j) => j.title), ["a1", "a2"]);
	assert.equal((await ledger.list({ limit: 0 })).length, 3, "limit 0 is unlimited");
	assert.equal((await ledger.list({ limit: 2 })).length, 2);
	assert.deepEqual((await ledger.ready({ project: "a" })).map((j) => j.title), ["a1"], "deferred is not ready");

	await ledger.close(a1.id, "first");
	await ledger.close(b1.id, "second");
	assert.deepEqual((await ledger.history()).map((j) => j.title), ["b1", "a1"]);
	assert.deepEqual((await ledger.list({ status: "closed", project: "a" })).map((j) => j.title), ["a1"]);
	assert.equal((await ledger.show(a2.id)).notes, "later");
	assert.equal((await ledger.show(a2.id)).priority, 0);
	await assert.rejects(ledger.update(a2.id, { removeLabels: ["project:a"] }), /not dispatchable: missing project:/);
});

// ---------------------------------------------------------------------------
// import surface and atomicity
// ---------------------------------------------------------------------------

test("importJobs appends pre-built records and refuses a duplicate id", async (t) => {
	const scratch = createScratchLedger();
	t.after(() => scratch.cleanup());
	await scratch.ledger.importJobs([JOB, { ...JOB, id: "cp-b", blocked_by: ["cp-a"] }]);
	assert.equal(scratch.document().jobs.length, 2);
	await assert.rejects(scratch.ledger.importJobs([JOB]), /already in the ledger: cp-a/);
	assert.equal(scratch.document().jobs.length, 2, "a refused import writes nothing");
});

test("a write that cannot land leaves the previous document intact", { skip: process.getuid?.() === 0 ? "root ignores directory modes" : false }, async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const before = readFileSync(jobsFile(scratch.path), "utf8");
	const dir = join(scratch.path, LAYOUT.runtimeDir);
	chmodSync(dir, 0o500);
	try {
		await assert.rejects(scratch.ledger.create({ title: "a", project: "demo", delivery: "pr" }), LedgerError);
		assert.equal(readFileSync(jobsFile(scratch.path), "utf8"), before);
	} finally {
		// Restore before the scratch cleanup runs, or rmSync cannot remove the dir.
		chmodSync(dir, 0o700);
	}
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/ledger.test.ts`
Expected: FAIL — `does not provide an export named 'initJobsDocument'`.

- [ ] **Step 4: Rewrite `src/ledger.ts`**

```ts
/**
 * The job ledger (spec 2026-09-04): the parent's memory of *work* — what is
 * in flight, what is blocked on what, and, once closed, what happened.
 *
 * One JSON document per home at `<home>/.pi-command-post/jobs.json`, written
 * with the same discipline as `state/fleet.json`: every mutation runs inside
 * pi's per-path mutation queue, reads the file, validates, mutates, validates
 * again and lands with tmp → fsync → rename. No in-memory cache; the parent
 * lock already guarantees one writer process per home.
 *
 * The contract it enforces is the one ported from command-post §Backlog:
 *
 *  - Every job carries `project:<name>` and `delivery:<mode>` labels, plus
 *    `kind:<ship|research>` when it helps. A job without them is not
 *    dispatchable, and that is checked here rather than hoped for.
 *  - Real dependencies only: A is blocked by B when A *cannot start* until B
 *    closes. `ready` and `blocked` are computed from `blocked_by`, never
 *    stored, and never paged — the fail-open page that cp-i2s found cannot
 *    recur because there is no page.
 *  - Closed is a transition, not an edit: `update()` refuses `closed`,
 *    `close()` always carries a reason, and a second close with a different
 *    reason is refused (a close is a fact). Dropped work is closed, never
 *    deleted.
 *
 * A live worker does not stop the class from closing a job (the pipeline
 * closes a research job after a gate pass while its planner is still up); the
 * `cp_job` tool is where that refusal lives, because the model is the only
 * caller that could do it by accident.
 */

import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_JOB_PRIORITY,
	type Delivery,
	DELIVERIES,
	findDependencyCycle,
	isoTimestamp,
	isSafeJobId,
	isSafeLedgerPrefix,
	type Job,
	JOB_ID_MINT_RETRIES,
	JOB_ID_SUFFIX_LENGTH,
	JOB_KINDS,
	JOB_PRIORITY_MAX,
	JOB_PRIORITY_MIN,
	JOB_SLUG_PATTERN,
	JOB_TYPES,
	type JobKind,
	type JobsDocument,
	type JobStatus,
	type JobType,
	LAYOUT,
	OPEN_JOB_STATUSES,
	SCHEMA_VERSION,
	validateJobsDocument,
} from "./contracts.ts";
import { atomicWriteJson, canonicalDir, queued } from "./json-store.ts";

export class LedgerError extends Error {}

// ---------------------------------------------------------------------------
// Job labels — the dispatchability contract (unchanged)
// ---------------------------------------------------------------------------

export const LABEL_PREFIX = Object.freeze({
	project: "project:",
	delivery: "delivery:",
	kind: "kind:",
});

/** Label values are branch- and CLI-safe: alphanumerics, hyphen, underscore. */
const LABEL_VALUE_RE = /^[A-Za-z0-9_-]+$/;

export interface JobLabels {
	project: string;
	delivery: Delivery;
	kind?: JobKind;
}

export function formatJobLabels(job: JobLabels): string[] {
	const labels = [`${LABEL_PREFIX.project}${job.project}`, `${LABEL_PREFIX.delivery}${job.delivery}`];
	if (job.kind) labels.push(`${LABEL_PREFIX.kind}${job.kind}`);
	return labels;
}

function labelValue(labels: readonly string[], prefix: string): string | undefined {
	const found = labels.filter((label) => label.startsWith(prefix)).map((label) => label.slice(prefix.length));
	if (found.length > 1) {
		throw new LedgerError(`job carries ${found.length} ${prefix} labels (${found.join(", ")}); exactly one is allowed`);
	}
	return found[0];
}

/** Best-effort parse; missing pieces come back undefined. */
export function parseJobLabels(labels: readonly string[] = []): Partial<JobLabels> {
	const project = labelValue(labels, LABEL_PREFIX.project);
	const delivery = labelValue(labels, LABEL_PREFIX.delivery);
	const kind = labelValue(labels, LABEL_PREFIX.kind);
	const parsed: Partial<JobLabels> = {};
	if (project) parsed.project = project;
	if (delivery && (DELIVERIES as readonly string[]).includes(delivery)) parsed.delivery = delivery as Delivery;
	if (kind && (JOB_KINDS as readonly string[]).includes(kind)) parsed.kind = kind as JobKind;
	return parsed;
}

/**
 * Fail-closed read of a job's labels. Dispatch calls this before anything is
 * leased: a job that does not say which project and which delivery it is, is
 * not a job. `update()` calls it after a label edit for the same reason.
 */
export function requireJobLabels(job: Pick<Job, "id" | "labels">): JobLabels {
	const labels = job.labels ?? [];
	const parsed = parseJobLabels(labels);
	const problems: string[] = [];
	if (!parsed.project) problems.push(`missing ${LABEL_PREFIX.project}<name>`);
	const rawDelivery = labelValue(labels, LABEL_PREFIX.delivery);
	if (!parsed.delivery) {
		problems.push(
			rawDelivery
				? `${LABEL_PREFIX.delivery}${rawDelivery} is not one of ${DELIVERIES.join("|")}`
				: `missing ${LABEL_PREFIX.delivery}<${DELIVERIES.join("|")}>`,
		);
	}
	const rawKind = labelValue(labels, LABEL_PREFIX.kind);
	if (rawKind && !parsed.kind) problems.push(`${LABEL_PREFIX.kind}${rawKind} is not one of ${JOB_KINDS.join("|")}`);
	if (problems.length > 0) throw new LedgerError(`${job.id} is not dispatchable: ${problems.join("; ")}`);
	return {
		project: parsed.project as string,
		delivery: parsed.delivery as Delivery,
		...(parsed.kind ? { kind: parsed.kind } : {}),
	};
}

// ---------------------------------------------------------------------------
// The document on disk
// ---------------------------------------------------------------------------

export function jobsFile(home: string): string {
	return join(home, LAYOUT.jobsFile);
}

/**
 * Create the document when there is none. Never rewrites an existing one —
 * the prefix recorded on disk wins over the one asked for, which is how a home
 * cannot silently switch id namespaces (doctor reports the mismatch instead).
 */
export function initJobsDocument(home: string, prefix: string): { document: JobsDocument; created: boolean } {
	const file = jobsFile(home);
	if (existsSync(file)) return { document: readJobsDocument(home), created: false };
	if (!isSafeLedgerPrefix(prefix)) {
		throw new LedgerError(`${JSON.stringify(prefix)} is not a usable ledger prefix: lowercase, starts with a letter, at most 8 chars`);
	}
	const document: JobsDocument = { schema_version: SCHEMA_VERSION, prefix, jobs: [] };
	atomicWriteJson(file, document);
	return { document, created: true };
}

/** Read and validate, or throw a `LedgerError` that names the file and the fault. */
export function readJobsDocument(home: string): JobsDocument {
	const file = jobsFile(home);
	if (!existsSync(file)) {
		throw new LedgerError(`no ledger at ${file} — start a session (the scaffold creates it), or run /doctor`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new LedgerError(`${file} is not JSON: ${(error as Error).message}`);
	}
	const result = validateJobsDocument(parsed);
	if (!result.ok) throw new LedgerError(`${file} violates the jobs contract:\n  ${result.errors.join("\n  ")}`);
	return result.value;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_RE = new RegExp(JOB_SLUG_PATTERN);

/**
 * `<prefix>-<suffix>` or `<prefix>-<slug>-<suffix>`. Four characters of
 * `[a-z0-9]`, redrawn on collision; after `JOB_ID_MINT_RETRIES` collisions the
 * suffix grows to five. `random(max)` is injectable so tests can force both.
 */
export function mintJobId(
	prefix: string,
	existing: ReadonlySet<string>,
	options: { slug?: string; random?: (max: number) => number } = {},
): string {
	const random = options.random ?? ((max: number) => randomInt(max));
	if (options.slug !== undefined && !SLUG_RE.test(options.slug)) {
		throw new LedgerError(`slug ${JSON.stringify(options.slug)} must match ${JOB_SLUG_PATTERN}`);
	}
	const stem = options.slug ? `${prefix}-${options.slug}` : prefix;
	const attempts = JOB_ID_MINT_RETRIES * 2;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const length = attempt < JOB_ID_MINT_RETRIES ? JOB_ID_SUFFIX_LENGTH : JOB_ID_SUFFIX_LENGTH + 1;
		let suffix = "";
		for (let i = 0; i < length; i += 1) suffix += SUFFIX_ALPHABET[random(SUFFIX_ALPHABET.length)] ?? "0";
		const id = `${stem}-${suffix}`;
		if (!existing.has(id) && isSafeJobId(id)) return id;
	}
	throw new LedgerError(`could not mint a unique id under ${stem}- after ${attempts} attempts`);
}

// ---------------------------------------------------------------------------
// Pure queries over a document
// ---------------------------------------------------------------------------

/** Blockers that are still open. Unknown ids block nothing (fail-closed callers check existence first). */
export function openBlockersOf(doc: JobsDocument, id: string): string[] {
	const byId = new Map(doc.jobs.map((job) => [job.id, job]));
	const job = byId.get(id);
	if (!job) return [];
	return job.blocked_by.filter((blocker) => byId.get(blocker)?.status !== "closed");
}

export function isReady(doc: JobsDocument, job: Job): boolean {
	return job.status === "open" && openBlockersOf(doc, job.id).length === 0;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerOptions {
	/** Command post home; the document is `<home>/.pi-command-post/jobs.json`. */
	home: string;
	/** Recorded as the author of comments. Defaults to the OS user name. */
	actor?: string;
	now?: () => Date;
	/**
	 * Project names allowed on `project:` labels (the registry). When present,
	 * intake refuses a project the registry does not know.
	 */
	knownProjects?: readonly string[];
	/** Injected in tests to force id collisions. */
	random?: (max: number) => number;
}

export interface IntakeInput {
	title: string;
	project: string;
	delivery: Delivery;
	kind?: JobKind;
	type?: JobType;
	priority?: number;
	description?: string;
	/** GitHub issue URL. The product backlog lives there; the ledger only points at it. */
	externalRef?: string;
	slug?: string;
	assignee?: string;
	/** Extra labels beyond the job contract. */
	labels?: readonly string[];
}

export interface ListFilter {
	project?: string;
	delivery?: Delivery;
	kind?: JobKind;
	status?: JobStatus | readonly JobStatus[];
	/** Include closed jobs (job history). */
	all?: boolean;
	/** `0` or absent: unlimited. */
	limit?: number;
	labels?: readonly string[];
}

export interface UpdatePatch {
	status?: JobStatus;
	assignee?: string;
	priority?: number;
	notes?: string;
	addLabels?: readonly string[];
	removeLabels?: readonly string[];
}

function assertLabelValue(value: string, what: string): void {
	if (!LABEL_VALUE_RE.test(value)) {
		throw new LedgerError(
			`${what} ${JSON.stringify(value)} is not a valid label value — use alphanumerics, hyphen or underscore`,
		);
	}
}

function assertPriority(value: number): void {
	if (!Number.isInteger(value) || value < JOB_PRIORITY_MIN || value > JOB_PRIORITY_MAX) {
		throw new LedgerError(`priority ${JSON.stringify(value)} must be an integer between ${JOB_PRIORITY_MIN} and ${JOB_PRIORITY_MAX}`);
	}
}

function safeUsername(): string {
	try {
		return userInfo().username || "operator";
	} catch {
		return "operator";
	}
}

function wantedLabels(filter: ListFilter): string[] {
	return [
		...(filter.project ? [`${LABEL_PREFIX.project}${filter.project}`] : []),
		...(filter.delivery ? [`${LABEL_PREFIX.delivery}${filter.delivery}`] : []),
		...(filter.kind ? [`${LABEL_PREFIX.kind}${filter.kind}`] : []),
		...(filter.labels ?? []),
	];
}

export class Ledger {
	readonly home: string;
	readonly file: string;
	readonly #options: LedgerOptions;
	readonly #now: () => Date;
	readonly #actor: string;

	constructor(options: LedgerOptions) {
		this.home = options.home;
		this.file = join(canonicalDir(options.home), LAYOUT.jobsFile);
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#actor = options.actor ?? safeUsername();
	}

	get knownProjects(): readonly string[] | undefined {
		return this.#options.knownProjects;
	}

	/** The document as it is on disk. Throws `LedgerError` when missing or invalid. */
	read(): JobsDocument {
		return readJobsDocument(this.home);
	}

	// -- intake -------------------------------------------------------------

	async create(input: IntakeInput): Promise<Job> {
		const title = input.title.trim();
		if (title.length === 0) throw new LedgerError("intake needs a title");
		assertLabelValue(input.project, "project");
		if (!(DELIVERIES as readonly string[]).includes(input.delivery)) {
			throw new LedgerError(`delivery ${JSON.stringify(input.delivery)} must be one of ${DELIVERIES.join("|")}`);
		}
		if (input.kind && !(JOB_KINDS as readonly string[]).includes(input.kind)) {
			throw new LedgerError(`kind ${JSON.stringify(input.kind)} must be one of ${JOB_KINDS.join("|")}`);
		}
		if (input.type && !(JOB_TYPES as readonly string[]).includes(input.type)) {
			throw new LedgerError(`type ${JSON.stringify(input.type)} must be one of ${JOB_TYPES.join("|")}`);
		}
		if (input.priority !== undefined) assertPriority(input.priority);
		const known = this.#options.knownProjects;
		if (known && !known.includes(input.project)) {
			throw new LedgerError(
				`unknown project ${JSON.stringify(input.project)} — register it first; known: ${known.join(", ") || "(none)"}`,
			);
		}
		if (input.externalRef !== undefined && !/^https:\/\/\S+$/.test(input.externalRef)) {
			throw new LedgerError(
				`external ref must be a full https url (the GitHub issue this job serves), got ${JSON.stringify(input.externalRef)}`,
			);
		}
		for (const label of input.labels ?? []) {
			if (label.includes(",") || label.trim().length === 0) throw new LedgerError(`label ${JSON.stringify(label)} may not contain a comma or be empty`);
		}
		const labels = [
			...formatJobLabels({ project: input.project, delivery: input.delivery, ...(input.kind ? { kind: input.kind } : {}) }),
			...(input.labels ?? []),
		];
		return this.#mutate((doc) => {
			const id = mintJobId(doc.prefix, new Set(doc.jobs.map((job) => job.id)), {
				...(input.slug !== undefined ? { slug: input.slug } : {}),
				...(this.#options.random ? { random: this.#options.random } : {}),
			});
			const at = isoTimestamp(this.#now());
			const job: Job = {
				id,
				title,
				status: "open",
				type: input.type ?? "task",
				priority: input.priority ?? DEFAULT_JOB_PRIORITY,
				labels,
				blocked_by: [],
				comments: [],
				created_at: at,
				updated_at: at,
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.externalRef !== undefined ? { external_ref: input.externalRef } : {}),
				...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
			};
			doc.jobs.push(job);
			return job;
		});
	}

	// -- queries ------------------------------------------------------------

	async show(id: string): Promise<Job> {
		return this.#require(this.read(), id);
	}

	async list(filter: ListFilter = {}): Promise<Job[]> {
		return filterJobs(this.read(), filter);
	}

	/** Open, unblocked, not deferred — the only queue dispatch may pull from. */
	async ready(filter: Omit<ListFilter, "status" | "all"> = {}): Promise<Job[]> {
		const doc = this.read();
		return filterJobs(doc, { ...filter, status: "open" }).filter((job) => isReady(doc, job));
	}

	/** Every job that is not closed and still waits on an open blocker. */
	async blocked(): Promise<Job[]> {
		const doc = this.read();
		return doc.jobs.filter((job) => job.status !== "closed" && openBlockersOf(doc, job.id).length > 0);
	}

	/** Closed jobs are the job history; newest close first. */
	async history(filter: Omit<ListFilter, "status" | "all"> = {}): Promise<Job[]> {
		return filterJobs(this.read(), { ...filter, status: "closed" }).sort((a, b) =>
			(b.closed_at ?? "").localeCompare(a.closed_at ?? "") || a.id.localeCompare(b.id),
		);
	}

	/** Open blockers of one job. The fail-closed pre-dispatch check. */
	async blockersOf(id: string): Promise<string[]> {
		return openBlockersOf(this.read(), id);
	}

	// -- transitions --------------------------------------------------------

	async update(id: string, patch: UpdatePatch): Promise<Job> {
		if (patch.status === "closed") {
			throw new LedgerError(`refusing to set ${id} to closed through update — close it with a reason (close())`);
		}
		if (patch.status !== undefined && !OPEN_JOB_STATUSES.includes(patch.status)) {
			throw new LedgerError(`status ${JSON.stringify(patch.status)} must be one of ${OPEN_JOB_STATUSES.join("|")}`);
		}
		if (patch.priority !== undefined) assertPriority(patch.priority);
		const touches =
			patch.status !== undefined ||
			patch.assignee !== undefined ||
			patch.priority !== undefined ||
			patch.notes !== undefined ||
			(patch.addLabels?.length ?? 0) > 0 ||
			(patch.removeLabels?.length ?? 0) > 0;
		if (!touches) throw new LedgerError(`update ${id}: nothing to change`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			if (patch.status !== undefined) job.status = patch.status;
			if (patch.assignee !== undefined) job.assignee = patch.assignee;
			if (patch.priority !== undefined) job.priority = patch.priority;
			if (patch.notes !== undefined) job.notes = patch.notes;
			const removed = new Set(patch.removeLabels ?? []);
			job.labels = [...job.labels.filter((label) => !removed.has(label)), ...(patch.addLabels ?? []).filter((label) => !job.labels.includes(label))];
			requireJobLabels(job);
			job.updated_at = isoTimestamp(this.#now());
			return job;
		});
	}

	/** Dispatch claim: in_progress + the worker alias that holds it. */
	async claim(id: string, assignee: string): Promise<Job> {
		return this.update(id, { status: "in_progress", assignee });
	}

	/**
	 * Close with a reason. Idempotent for the same reason; a different reason
	 * is refused, because a close is a fact and not an edit.
	 */
	async close(id: string, reason: string): Promise<Job> {
		const trimmed = reason.trim();
		if (trimmed.length === 0) throw new LedgerError(`close ${id}: a reason is required (PR url, artifact, or "dropped: …")`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			if (job.status === "closed") {
				if (job.close_reason === trimmed) return job;
				throw new LedgerError(`${id} is already closed (${job.close_reason}) — a close is a fact; reopen it deliberately before closing it for another reason`);
			}
			const at = isoTimestamp(this.#now());
			job.status = "closed";
			job.closed_at = at;
			job.close_reason = trimmed;
			job.updated_at = at;
			return job;
		});
	}

	/** Dropped work is closed with a reason, never deleted. */
	async drop(id: string, reason: string): Promise<Job> {
		const trimmed = reason.trim();
		if (trimmed.length === 0) throw new LedgerError(`drop ${id}: say why it was dropped`);
		return this.close(id, trimmed.startsWith("dropped:") ? trimmed : `dropped: ${trimmed}`);
	}

	/** Blockers and decisions are comments; the job's status does not change. */
	async comment(id: string, text: string): Promise<Job> {
		const trimmed = text.trim();
		if (trimmed.length === 0) throw new LedgerError(`comment ${id}: empty comment`);
		return this.#mutate((doc) => {
			const job = this.#require(doc, id);
			const at = isoTimestamp(this.#now());
			job.comments.push({ at, author: this.#actor, text: trimmed });
			job.updated_at = at;
			return job;
		});
	}

	// -- dependencies -------------------------------------------------------

	/** `blockedId` cannot start until `blockerId` closes. Refuses self, unknown ids and cycles. */
	async addDep(blockedId: string, blockerId: string): Promise<void> {
		if (blockedId === blockerId) throw new LedgerError(`${blockedId} cannot depend on itself`);
		await this.#mutate((doc) => {
			const blocked = this.#require(doc, blockedId);
			this.#require(doc, blockerId);
			if (blocked.blocked_by.includes(blockerId)) return;
			blocked.blocked_by.push(blockerId);
			const cycle = findDependencyCycle(doc.jobs);
			if (cycle) throw new LedgerError(`refusing dependency ${blockedId} -> ${blockerId}: dependency cycle ${cycle.join(" -> ")}`);
			blocked.updated_at = isoTimestamp(this.#now());
		});
	}

	async removeDep(blockedId: string, blockerId: string): Promise<void> {
		await this.#mutate((doc) => {
			const blocked = this.#require(doc, blockedId);
			if (!blocked.blocked_by.includes(blockerId)) return;
			blocked.blocked_by = blocked.blocked_by.filter((id) => id !== blockerId);
			blocked.updated_at = isoTimestamp(this.#now());
		});
	}

	// -- import -------------------------------------------------------------

	/** Append pre-built records (the `.beads/` importer). A duplicate id refuses the whole batch. */
	async importJobs(jobs: readonly Job[]): Promise<void> {
		await this.#mutate((doc) => {
			const existing = new Set(doc.jobs.map((job) => job.id));
			const duplicates = jobs.filter((job) => existing.has(job.id)).map((job) => job.id);
			if (duplicates.length > 0) throw new LedgerError(`refusing import: already in the ledger: ${duplicates.join(", ")}`);
			doc.jobs.push(...jobs.map((job) => structuredClone(job)));
		});
	}

	// -- internals ----------------------------------------------------------

	#require(doc: JobsDocument, id: string): Job {
		const job = doc.jobs.find((candidate) => candidate.id === id);
		if (!job) throw new LedgerError(`${id}: no such job in ${this.file}`);
		return job;
	}

	/** Read → mutate a clone → validate → atomic write, serialized per file. */
	#mutate<T>(fn: (doc: JobsDocument) => T): Promise<T> {
		return queued(this.file, async () => {
			const draft = structuredClone(this.read());
			const out = fn(draft);
			const result = validateJobsDocument(draft);
			if (!result.ok) throw new LedgerError(`refusing to write an invalid jobs document:\n  ${result.errors.join("\n  ")}`);
			try {
				atomicWriteJson(this.file, result.value);
			} catch (error) {
				throw new LedgerError(`could not write ${this.file}: ${(error as Error).message}`);
			}
			return out;
		});
	}
}

function filterJobs(doc: JobsDocument, filter: ListFilter): Job[] {
	const statuses =
		filter.status === undefined ? undefined : Array.isArray(filter.status) ? [...(filter.status as readonly JobStatus[])] : [filter.status as JobStatus];
	const labels = wantedLabels(filter);
	let jobs = doc.jobs.filter((job) => {
		if (statuses) {
			if (!statuses.includes(job.status)) return false;
		} else if (!filter.all && job.status === "closed") {
			return false;
		}
		return labels.every((label) => job.labels.includes(label));
	});
	jobs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
	if (filter.limit !== undefined && filter.limit > 0) jobs = jobs.slice(0, filter.limit);
	return jobs;
}
```

- [ ] **Step 5: Fix the callers so the tree compiles**

1. `src/command-post.ts:579-582`:
   ```ts
   	/** The ledger, over this home's jobs document, with the registry gate on. */
   	ledger(): Ledger {
   		return new Ledger({ home: this.home, knownProjects: this.registry.names() });
   	}
   ```
2. `src/dispatch.ts`: line 44 → `import { type Job, type Ledger, requireJobLabels } from "./ledger.ts";`; in the blocked refusal replace `br ready is the queue` with `cp_job ready is the queue`; `assertDispatchable`:
   ```ts
   function assertDispatchable(job: Job): void {
   	if (job.status === "closed") throw new DispatchError(`${job.id} is closed; reopen it before dispatching`);
   }
   ```
   and rename the local `issue` variables to `job` where the diff is small (optional; the type is what matters).
3. `src/status.ts`: line 96 → `import { type Job, type Ledger, parseJobLabels } from "./ledger.ts";`; replace every `LedgerIssue` with `Job` (lines 135, 173, 203, 440); line 672 → `` lines.push("UNCLAIMED (ledger says in_progress; this fleet has no record)"); ``; reword the comments at lines 11, 27-31 and 410-429 so they say "the ledger" instead of "br" (the `limit: 0` call stays: it means unlimited).
4. `src/doctor.ts`: delete `import { MIN_BR_VERSION } from "./ledger.ts";`; delete the `#belowFloor` method and the line `findings.push(...this.#belowFloor(tool, version));`; in `TOOL_FIX` set `br: \`install br (\\\`${installScriptHint("br")}\\\`)\`` (a placeholder string; Task 5 deletes the entry).
5. `scripts/install-tools.ts`: delete line 27 (`import { MIN_BR_VERSION }`) and the `if ((only ?? REQUIRED_TOOLS).includes("br")) { console.log(...) }` block.
6. `tests/harness/live.ts`: delete `import { brAvailable } from "./beads.ts";`; add `import { initJobsDocument } from "../../src/ledger.ts";`; in `liveSkip` replace `!(brAvailable() && treehouseAvailable())` with `!treehouseAvailable()` and the message with `"treehouse must be installed"`; replace line 206 (`execFileSync("br", ["init", "--prefix", "cp"], …)`) with `initJobsDocument(home.path, "cp");` (remove the `execFileSync` import if nothing else uses it).
7. In each of `tests/dispatch.test.ts`, `tests/pipeline.test.ts`, `tests/live-harness.test.ts`, `tests/e2e/questions.test.ts`, `tests/e2e/phase2.test.ts`, `tests/e2e/phase3.test.ts`, `tests/e2e/attach.test.ts`: remove `brAvailable,` from the harness import and change `brAvailable() && treehouseAvailable()` to `treehouseAvailable()`; reword the skip strings to drop "br and". In `tests/e2e/live-smoke.test.ts` do the same at lines 24, 144 and 218.
8. `tests/e2e/packaging.test.ts`: remove `brAvailable` from the import and `const HAS_BR = brAvailable();`; line 85 → `for (const dir of ["data", "state", "projects", ".pi-command-post"])`; the two `if (HAS_BR) assert…` lines become unconditional assertions on the new document: `assert.match(message, /ledger: created/, message);` and `assert.ok(existsSync(join(machine.home, ".pi-command-post/jobs.json")), "the scaffold should have created the ledger");` (these pass once Task 3 lands; leave them in now — the packaging suite is an e2e that self-skips without `pi` on PATH, and Task 3 is the next commit). Lines 198 and 224: read `.pi-command-post/jobs.json` instead of `.beads/issues.jsonl`, unconditionally.
9. `tests/awaiting.test.ts`: import line 46 → `import { createScratchHome, createScratchLedger, REPO_ROOT } from "./harness/index.ts";`; replace the test at 739-757 with:
   ```ts
   test("ledger audit: answering a declared item with a job_id adds exactly one comment", async (t) => {
   	const scratch = createScratchLedger({ knownProjects: ["demo"] });
   	t.after(() => scratch.cleanup());
   	const job = await scratch.ledger.create({ title: "demo job", project: "demo", delivery: "pr", description: "d" });
   	await scratch.ledger.comment(job.id, `decision: ship it? — answered "yes" by operator command at 2026-08-30T12:00:00Z (awaiting aw-1)`);
   	assert.equal((await scratch.ledger.show(job.id)).comments.length, 1);
   });
   ```
10. `tests/doctor.test.ts`: remove `import { MIN_BR_VERSION } from "../src/ledger.ts";` and `brAvailable,` from the harness import; delete the test `"a br older than the targeted one is an error; an unreadable version is not"` (lines 248-288); at line 793 the skip becomes `treehouseAvailable() ? false : "needs treehouse on PATH"`.
11. `tests/status.test.ts`: line 33 → `import { type Job, Ledger } from "../src/ledger.ts";`; rename the `issue()` helper's type from `LedgerIssue` to `Job` and give it the required fields (`priority: 2, blocked_by: [], comments: [], created_at: "2026-08-27T11:00:00Z", updated_at: "2026-08-27T11:00:00Z"`); delete `stubLedger`; in the test at ~845-870 build a real ledger and seed it:
    ```ts
    	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
    	await scratch.ledger.importJobs([
    		issue({ id: "cp-known", title: "Known job", status: "in_progress", labels: ["project:demo", "delivery:pr"] }),
    		issue({ id: "cp-elsewhere", title: "Claimed elsewhere", status: "in_progress", labels: ["project:demo", "delivery:pr"] }),
    	]);
    	…
    		ledger: () => scratch.ledger,
    ```
    and drop the `calls` assertions that checked br argv (they asserted `--limit 0`; the equivalent guarantee is now that `list()` has no page — covered in `tests/ledger.test.ts`). In the degraded test at ~892 use a ledger over a home with no document: `ledger: () => new Ledger({ home: join(home.path, "nowhere") })` and change the regex to `/no ledger at/`. Add `createScratchLedger` to the harness import.

- [ ] **Step 6: Run the ledger suite, typecheck, then the whole suite**

Run: `node --test tests/ledger.test.ts && npm run typecheck`
Expected: PASS (13 tests).

Run: `npm test`
Expected: PASS. Status goldens: if `tests/golden/status-table*.txt` contain the `UNCLAIMED (br says` heading, regenerate them (`CP_UPDATE_GOLDEN=1 node --test tests/status.test.ts`) and confirm the only diff is that heading.

- [ ] **Step 7: Commit**

```bash
git add -A src tests scripts
git commit -m "feat(ledger): the in-house jobs document replaces br as the backend

Same Ledger surface, computed ready/blocked, in-house id minting, one
atomic document per home. Scratch-home test harness; every suite that
gated on a br binary now runs everywhere.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Scaffold writes the document instead of running `br init`

**Files:**
- Modify: `src/scaffold.ts` (`ScaffoldOptions.run` removed; `ledgerStep` rewritten; `dir.runtime` added)
- Modify: `tests/scaffold.test.ts:120-305`

**Interfaces:**
- Consumes: `initJobsDocument`, `LedgerError` from Task 2; `LAYOUT.runtimeDir` from Task 1.
- Produces: scaffold steps `dir.runtime` and `ledger` (`created` | `present` | `failed`); the `skipped` action no longer occurs for the ledger.

- [ ] **Step 1: Rewrite the scaffold tests**

In `tests/scaffold.test.ts`, replace the T30 tests from `"scaffolding a fresh home creates what a dispatch needs, once"` through `"an invalid CP_LEDGER_PREFIX is refused before br is ever invoked"` (lines ~124-305) with:

```ts
test("scaffolding a fresh home creates what a dispatch needs, once", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const first = scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	assert.equal(first.already_ready, false);
	assert.deepEqual(
		first.steps.map((step) => [step.step, step.action]),
		[
			["dir.data", "created"],
			["dir.state", "created"],
			["dir.projects", "created"],
			["dir.runtime", "created"],
			["gitignore", "created"],
			["routing.default", "created"],
			["ledger", "created"],
		],
	);
	for (const dir of [LAYOUT.data, LAYOUT.state, LAYOUT.projects, LAYOUT.runtimeDir]) {
		assert.ok(existsSync(join(home.path, dir)), `${dir} was not created`);
	}
	const gitignore = readFileSync(join(home.path, ".gitignore"), "utf8");
	for (const entry of NEVER_COMMIT_PATHS) assert.ok(gitignore.includes(entry), `.gitignore misses ${entry}`);
	assert.deepEqual(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")), { schema_version: 1, prefix: "cp", jobs: [] });
	const routingStep = first.steps.find((step) => step.step === "routing.default");
	assert.equal(routingStep?.action, "created");
	const copied = JSON.parse(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"));
	assert.equal(copied.rubric.length, 7);

	// Idempotent: a second call writes nothing and says so.
	const second = scaffoldHome({ home: home.path, env: { CP_HOME: home.path } });
	assert.equal(second.already_ready, true);
	assert.ok(second.steps.every((step) => step.action === "present"));
	assert.match(formatScaffold(second), /^command post home ready \(CP_HOME\): /);
});

test("an existing jobs document is never rewritten, whatever the prefix in the environment says", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.runtimeDir), { recursive: true });
	const seeded = JSON.stringify({ schema_version: 1, prefix: "cps", jobs: [] }, null, 2);
	writeFileSync(join(home.path, LAYOUT.jobsFile), seeded);
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: "other" } });
	assert.equal(report.steps.find((step) => step.step === "ledger")?.action, "present");
	assert.equal(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8"), seeded);
});

test("the ledger step can be turned off for a home that will never dispatch", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, ledger: false });
	assert.ok(!report.steps.some((step) => step.step === "ledger"));
	assert.ok(!existsSync(join(home.path, LAYOUT.jobsFile)));
});

// ---------------------------------------------------------------------------
// cp-epy2 §4.2: a per-home prefix (CP_LEDGER_PREFIX)
// ---------------------------------------------------------------------------

test("CP_LEDGER_PREFIX unset or empty: the document is created with prefix cp", (t) => {
	for (const env of [{}, { CP_LEDGER_PREFIX: "" }, { CP_LEDGER_PREFIX: "   " }]) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		scaffoldHome({ home: home.path, env: { CP_HOME: home.path, ...env } });
		assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")).prefix, "cp");
	}
});

test("CP_LEDGER_PREFIX=cps: the document records that prefix", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: "cps" } });
	assert.equal(report.steps.find((step) => step.step === "ledger")?.action, "created");
	assert.match(report.steps.find((step) => step.step === "ledger")?.detail ?? "", /prefix cps/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.jobsFile), "utf8")).prefix, "cps");
});

test("an invalid CP_LEDGER_PREFIX is refused and no document is written", (t) => {
	for (const bad of ["CP", "1cp", "toolongprefix", "cp-x", "c p"]) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path, CP_LEDGER_PREFIX: bad } });
		const ledger = report.steps.find((step) => step.step === "ledger");
		assert.equal(ledger?.action, "failed", `${bad} must be refused`);
		assert.match(ledger?.detail ?? "", new RegExp(LEDGER_PREFIX_PATTERN.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
		assert.ok(!existsSync(join(home.path, LAYOUT.jobsFile)), `a document was written for ${bad}`);
	}
});
```

Keep the `resolveLedgerPrefix` unit tests that follow if they exist separately; delete any remaining test that references `run:` or `.beads`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/scaffold.test.ts`
Expected: FAIL — `dir.runtime` missing; the ledger step reports `skipped` (br not found) or shells out.

- [ ] **Step 3: Rewrite the scaffold's ledger step**

In `src/scaffold.ts`:

1. Replace the `execFileSync` import with nothing (delete the line) and add `import { initJobsDocument, LedgerError } from "./ledger.ts";`.
2. Update the header comment's third rule to: `- **The ledger is a file.** A missing jobs document is created empty with the home's prefix; an existing one is never touched.`
3. Delete the `run?:` option from `ScaffoldOptions` and its doc comment.
4. In `scaffoldHome`, change the directory loop to `for (const dir of [LAYOUT.data, LAYOUT.state, LAYOUT.projects, LAYOUT.runtimeDir] as const)` and the step name to `` `dir.${dir === LAYOUT.runtimeDir ? "runtime" : dir}` `` (so the runtime dotdir reports as `dir.runtime`).
5. Replace `if (options.ledger !== false) steps.push(ledgerStep(home, options.run, env));` with `if (options.ledger !== false) steps.push(ledgerStep(home, env));`.
6. Replace `ledgerStep` and delete `defaultRun`:
   ```ts
   /**
    * The jobs document, created empty with this home's prefix when there is
    * none (`CP_LEDGER_PREFIX`, default `cp`). An existing document is never
    * touched: it is the operator's job history, and its recorded prefix wins
    * over the environment from then on (doctor reports a mismatch).
    */
   function ledgerStep(home: string, env: NodeJS.ProcessEnv = process.env): ScaffoldStep {
   	if (existsSync(join(home, LAYOUT.jobsFile))) return { step: "ledger", action: "present" };
   	const resolved = resolveLedgerPrefix(env);
   	if ("error" in resolved) return { step: "ledger", action: "failed", detail: resolved.error };
   	try {
   		initJobsDocument(home, resolved.prefix);
   		return { step: "ledger", action: "created", detail: `${LAYOUT.jobsFile} with prefix ${resolved.prefix}` };
   	} catch (error) {
   		const message = error instanceof LedgerError ? error.message : (error as Error).message;
   		return { step: "ledger", action: "failed", detail: `could not create ${LAYOUT.jobsFile}: ${message}` };
   	}
   }
   ```
7. In `resolveLedgerPrefix`'s error text replace `is not a usable br prefix` with `is not a usable ledger prefix`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/scaffold.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scaffold.ts tests/scaffold.test.ts
git commit -m "feat(scaffold): create the jobs document and the runtime dotdir; no more br init

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Doctor checks the document, not the binary

**Files:**
- Modify: `src/doctor.ts` (`#ledger()`, `#ledgerSchema()`, `#ledgerDoctor()` replaced; `MAX_PATH_PROBES`/`#conflictingVersions` stay for the other tools)
- Modify: `tests/doctor.test.ts` (replace the four br/ledger tests; `healthyRunner` loses the br stubs)
- Modify: `tests/golden/doctor-broken.txt` (regenerated)

**Interfaces:**
- Consumes: `readJobsDocument`, `jobsFile` from Task 2; `jobsInvariantErrors`, `JOBS_SIZE_WARNING`, `validate`, `JobsDocumentSchema` from Task 1; `resolveLedgerPrefix` from `src/scaffold.ts`.
- Produces: findings `ledger.file`, `ledger.ids`, `ledger.deps`, `ledger.prefix`, `ledger.size`, `ledger.beads_archive`.

- [ ] **Step 1: Write the failing tests**

In `tests/doctor.test.ts`, delete the tests `"two br versions on PATH is an error; identical shims are not"`, `"br's own findings are surfaced, warns as warns and everything else as errors"`, `"a home with no ledger is a warning, not a failure"` and `"unreadable br output degrades to a warning instead of a wrong verdict"`. In `healthyRunner`, delete the two `if (key.includes("migrate-schema plan"))` and `if (key.includes("doctor --json"))` branches. Add:

```ts
function writeJobs(home: string, document: unknown): void {
	mkdirSync(join(home, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify(document, null, 2));
}

const JOB_ROW = {
	id: "cp-a",
	title: "t",
	status: "open",
	priority: 2,
	labels: ["project:demo", "delivery:pr"],
	blocked_by: [],
	comments: [],
	created_at: "2026-08-27T11:00:00Z",
	updated_at: "2026-08-27T11:00:00Z",
};

test("ledger.file: a missing document is an error naming the scaffold; a sound one is ok with a count", async (t) => {
	const fixture = homeFixture(t);
	const missing = (await fixture.doctor().run()).findings.find((f) => f.check === "ledger.file");
	assert.equal(missing?.severity, "error");
	assert.match(missing?.fix ?? "", /start a pi session/);

	writeJobs(fixture.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [JOB_ROW] });
	const report = await fixture.doctor().run();
	const file = report.findings.find((f) => f.check === "ledger.file");
	assert.equal(file?.severity, "ok");
	assert.match(file?.what ?? "", /1 job\(s\), prefix cp/);
	for (const check of ["ledger.ids", "ledger.deps", "ledger.prefix", "ledger.size"]) {
		assert.equal(report.findings.find((f) => f.check === check)?.severity, "ok", check);
	}
	assert.ok(!report.findings.some((f) => f.check === "ledger.beads_archive"), "no .beads/, no archive finding");
});

test("ledger.file: not JSON or the wrong shape is an error with the parser's words", async (t) => {
	const fixture = homeFixture(t);
	mkdirSync(join(fixture.home.path, LAYOUT.runtimeDir), { recursive: true });
	writeFileSync(join(fixture.home.path, LAYOUT.jobsFile), "{nope");
	const notJson = (await fixture.doctor().run()).findings.find((f) => f.check === "ledger.file");
	assert.equal(notJson?.severity, "error");
	assert.match(notJson?.what ?? "", /not JSON/);

	writeJobs(fixture.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [{ id: "cp-a" }] });
	const badShape = (await fixture.doctor().run()).findings.find((f) => f.check === "ledger.file");
	assert.equal(badShape?.severity, "error");
	assert.match(badShape?.detail ?? "", /\/jobs\/0/);
});

test("ledger.ids and ledger.deps report duplicates, foreign prefixes, unknown blockers and cycles separately", async (t) => {
	const fixture = homeFixture(t);
	writeJobs(fixture.home.path, {
		schema_version: SCHEMA_VERSION,
		prefix: "cp",
		jobs: [JOB_ROW, JOB_ROW, { ...JOB_ROW, id: "cp-b", blocked_by: ["cp-zzz", "cp-c"] }, { ...JOB_ROW, id: "cp-c", blocked_by: ["cp-b"] }],
	});
	const report = await fixture.doctor().run();
	assert.equal(report.findings.find((f) => f.check === "ledger.file")?.severity, "ok", "shape is fine; the invariants are separate findings");
	const ids = report.findings.find((f) => f.check === "ledger.ids");
	assert.equal(ids?.severity, "error");
	assert.match(ids?.detail ?? "", /duplicate id cp-a/);
	const deps = report.findings.find((f) => f.check === "ledger.deps");
	assert.equal(deps?.severity, "error");
	assert.match(deps?.detail ?? "", /unknown cp-zzz/);
	assert.match(deps?.detail ?? "", /dependency cycle/);
	assert.match(deps?.fix ?? "", /cp_job dep_remove/);
});

test("ledger.prefix warns when the environment disagrees with the document; ledger.size warns past the cap", async (t) => {
	const fixture = homeFixture(t);
	const jobs = Array.from({ length: JOBS_SIZE_WARNING + 1 }, (_, i) => ({ ...JOB_ROW, id: `cp-${i.toString(36).padStart(4, "0")}` }));
	writeJobs(fixture.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs });
	const report = await fixture.doctor({ env: { CP_HOME: fixture.home.path, CP_LEDGER_PREFIX: "cps" } }).run();
	const prefix = report.findings.find((f) => f.check === "ledger.prefix");
	assert.equal(prefix?.severity, "warn");
	assert.match(prefix?.what ?? "", /CP_LEDGER_PREFIX=cps but the document mints cp-/);
	const size = report.findings.find((f) => f.check === "ledger.size");
	assert.equal(size?.severity, "warn");
	assert.match(size?.what ?? "", new RegExp(`${JOBS_SIZE_WARNING + 1} jobs`));
});

test("ledger.beads_archive: a leftover .beads/ beside a populated document is a warning that says it is safe to delete", async (t) => {
	const fixture = homeFixture(t);
	mkdirSync(join(fixture.home.path, ".beads"), { recursive: true });
	writeJobs(fixture.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [JOB_ROW] });
	const finding = (await fixture.doctor().run()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.fix ?? "", /safe to delete/);

	writeJobs(fixture.home.path, { schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [] });
	const empty = (await fixture.doctor().run()).findings.find((f) => f.check === "ledger.beads_archive");
	assert.equal(empty?.severity, "ok");
	assert.match(empty?.what ?? "", /not imported yet/);
	assert.match(empty?.fix ?? "", /\/cp-jobs import-beads/);
});
```

Add `JOBS_SIZE_WARNING` to the `../src/contracts.ts` import. Use whatever the file's home-fixture helper is actually called (it is defined around line 80 as `HomeFixture`; the neighbouring tests show the call shape — copy it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/doctor.test.ts`
Expected: FAIL — `ledger.file` not found (the old `ledger.workspace` still reports).

- [ ] **Step 3: Rewrite the ledger section of `src/doctor.ts`**

Replace the imports: add `import { jobsFile, LedgerError, readJobsDocument } from "./ledger.ts";`, `import { resolveLedgerPrefix } from "./scaffold.ts";`, and add `JOBS_SIZE_WARNING`, `JobsDocumentSchema`, `type JobsDocument`, `jobsInvariantErrors`, `validate` to the `./contracts.ts` import. Then replace `#ledger()`, `#ledgerSchema()` and `#ledgerDoctor()` with:

```ts
	// -- ledger -------------------------------------------------------------

	/**
	 * The jobs document (spec 2026-09-04). Six findings, all read-only: the file
	 * parses and validates; ids are unique and carry the prefix; the dependency
	 * graph is closed and acyclic; the environment's prefix agrees with the
	 * document's; the document is not outgrowing whole-file rewrites; and a
	 * leftover `.beads/` is named for what it is now — an archive.
	 */
	#ledger(): DoctorFinding[] {
		const home = this.#options.home;
		const file = jobsFile(home);
		if (!existsSync(file)) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "no jobs document in this home",
					detail: file,
					fix: "start a pi session in this home: session_start scaffolds an empty ledger (dispatch needs one)",
				},
			];
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "the jobs document is not JSON",
					detail: `${file}: ${(error as Error).message}`,
					fix: "restore the document from a backup, or move it aside and start a session to scaffold an empty one (jobs would be lost)",
				},
			];
		}
		const shape = validate<JobsDocument>(JobsDocumentSchema, parsed);
		if (!shape.ok) {
			return [
				{
					check: "ledger.file",
					severity: "error",
					what: "the jobs document violates the jobs contract",
					detail: shape.errors.join("; ").slice(0, 2000),
					fix: "fix the named fields by hand (every job needs id, title, status, priority, labels, blocked_by, comments, created_at, updated_at)",
				},
			];
		}
		const doc = shape.value;
		const findings: DoctorFinding[] = [
			{ check: "ledger.file", severity: "ok", what: `jobs document: ${doc.jobs.length} job(s), prefix ${doc.prefix}`, detail: file },
		];
		const invariants = jobsInvariantErrors(doc);
		findings.push(
			invariants.ids.length === 0
				? { check: "ledger.ids", severity: "ok", what: "every job id is unique, well-formed and carries the prefix" }
				: {
						check: "ledger.ids",
						severity: "error",
						what: `${invariants.ids.length} id problem(s) in the jobs document`,
						detail: invariants.ids.join("; ").slice(0, 2000),
						fix: "edit the document by hand: a duplicate or foreign id cannot be minted by this build, so one was written by something else",
					},
		);
		findings.push(
			invariants.deps.length === 0
				? { check: "ledger.deps", severity: "ok", what: "every dependency names a known job and the graph is acyclic" }
				: {
						check: "ledger.deps",
						severity: "error",
						what: `${invariants.deps.length} dependency problem(s) in the jobs document`,
						detail: invariants.deps.join("; ").slice(0, 2000),
						fix: "remove the offending edge with `cp_job dep_remove` (or by hand): a blocked job whose blocker does not exist can never become ready",
					},
		);
		const resolved = resolveLedgerPrefix(this.#options.env ?? process.env);
		if ("error" in resolved) {
			findings.push({ check: "ledger.prefix", severity: "warn", what: "CP_LEDGER_PREFIX is not a usable prefix", detail: resolved.error, fix: "unset it, or set a value matching the pattern; the document keeps minting with its recorded prefix either way" });
		} else if (resolved.prefix !== doc.prefix) {
			findings.push({
				check: "ledger.prefix",
				severity: "warn",
				what: `CP_LEDGER_PREFIX=${resolved.prefix} but the document mints ${doc.prefix}-`,
				fix: `the recorded prefix wins (ids are branch names); unset CP_LEDGER_PREFIX or set it to ${doc.prefix} to silence this`,
			});
		} else {
			findings.push({ check: "ledger.prefix", severity: "ok", what: `ids are minted as ${doc.prefix}-…` });
		}
		findings.push(
			doc.jobs.length > JOBS_SIZE_WARNING
				? {
						check: "ledger.size",
						severity: "warn",
						what: `${doc.jobs.length} jobs in one document (whole-file rewrites past ${JOBS_SIZE_WARNING} get slow)`,
						fix: "archive closed jobs (not automated yet; see the spec's out-of-scope list)",
					}
				: { check: "ledger.size", severity: "ok", what: `${doc.jobs.length} job(s) (warning past ${JOBS_SIZE_WARNING})` },
		);
		const beads = join(home, ".beads");
		if (existsSync(beads)) {
			findings.push(
				doc.jobs.length > 0
					? {
							check: "ledger.beads_archive",
							severity: "warn",
							what: ".beads/ is still present beside the jobs document",
							detail: beads,
							fix: "it is a frozen archive of closed br issues and is safe to delete once you no longer want to read it",
						}
					: {
							check: "ledger.beads_archive",
							severity: "ok",
							what: ".beads/ present and the jobs document is empty — not imported yet",
							detail: beads,
							fix: "run `/cp-jobs import-beads` once to carry the open br issues over",
						},
			);
		}
		return findings;
	}
```

Remove the now-unused `LedgerError` import if the typechecker flags it. Also update the module header comment (lines 16-21) to describe the document checks instead of br's.

- [ ] **Step 4: Regenerate the golden and run the suite**

Run: `CP_UPDATE_GOLDEN=1 node --test tests/doctor.test.ts && git diff tests/golden/doctor-broken.txt`
Expected diff: the `! [ledger.workspace] no .beads/ in this home` block is replaced by `✗ [ledger.file] no jobs document in this home` with the scaffold fix; counts move accordingly (one more error, one fewer warn). Nothing else.

Run: `node --test tests/doctor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts tests/golden/doctor-broken.txt
git commit -m "feat(doctor): ledger.file/ids/deps/prefix/size/beads_archive replace the br checks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: br leaves the tool manifest and the installer

**Files:**
- Modify: `src/tool-manifest.ts:19,55-60` (and the header comment about `MIN_BR_VERSION`)
- Modify: `src/doctor.ts` (`TOOL_SEVERITY`, `TOOL_FIX` lose `br`; header comment)
- Modify: `src/install-tools.ts:18` (comment), `scripts/install-tools.ts` (usage text if it lists tools)
- Modify: `tests/install-tools.test.ts:96-97,160`, `tests/tool-manifest.test.ts` (if it enumerates tools), `tests/golden/doctor-broken.txt`

**Interfaces:**
- Produces: `REQUIRED_TOOLS = ["git", "treehouse", "pi", "gh"]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-manifest.test.ts`:

```ts
test("br is not a required tool any more: the ledger is a file", () => {
	assert.deepEqual([...REQUIRED_TOOLS], ["git", "treehouse", "pi", "gh"]);
	assert.ok(!("br" in TOOL_INSTALL));
});
```

(Import `TOOL_INSTALL` and `REQUIRED_TOOLS` from `../src/tool-manifest.ts` if not already.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tool-manifest.test.ts`
Expected: FAIL — `REQUIRED_TOOLS` still contains `br`.

- [ ] **Step 3: Remove br**

1. `src/tool-manifest.ts`: `export const REQUIRED_TOOLS = ["git", "treehouse", "pi", "gh"] as const;`; delete the `br: { … }` entry of `TOOL_INSTALL`; delete the paragraph in the header comment that mentions `MIN_BR_VERSION`; in the comment above `TOOL_INSTALL` drop "br and" from "br and treehouse both ship a `curl | sh` one-liner".
2. `src/doctor.ts`: delete `br: "error",` from `TOOL_SEVERITY` and the `br:` line from `TOOL_FIX` (the typechecker enforces both once `REQUIRED_TOOLS` shrinks). Delete the `DOCTOR_PROBE_JOB_ID` comment's reference to br if any.
3. `src/install-tools.ts:18`: reword the comment example to use `treehouse` instead of `br`.
4. `tests/install-tools.test.ts`: line 96 `only: ["br"]` → `only: ["treehouse"]` and line 97's paths → `["/opt/homebrew/bin/treehouse", "/Users/x/.local/bin/treehouse"]`; line 160 `only: ["br"]` → `only: ["treehouse"]`. Adjust any assertion text in those tests that names `br`.
5. `README.md` is handled in Task 10.

- [ ] **Step 4: Regenerate the golden and run the suite**

Run: `CP_UPDATE_GOLDEN=1 node --test tests/doctor.test.ts && git diff tests/golden/doctor-broken.txt`
Expected diff: the `✗ [host.br] br is not on PATH` block disappears; the header error count drops by one.

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-manifest.ts src/doctor.ts src/install-tools.ts scripts/install-tools.ts tests/install-tools.test.ts tests/tool-manifest.test.ts tests/golden/doctor-broken.txt
git commit -m "feat(tools): br is no longer a required tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The guard forgets br

**Files:**
- Modify: `src/guards.ts:9-12,34-35,193-194,264-267,355-374` and the header comment
- Modify: `tests/guards.test.ts:183-232,269-270,360-380`

**Interfaces:**
- Produces: `GUARD_CODES` without `ledger_inlines_artifact`.

- [ ] **Step 1: Rewrite the guard tests**

In `tests/guards.test.ts`, replace the test `"br show/comments on an artifact-bearing issue is blocked; other ledger reads are not"` (line ~360) with:

```ts
test("the ledger has no bash surface any more: br-shaped commands are neither blocked nor special", (t) => {
	const b = fixture(t);
	for (const command of ["br show cp-research-1", "br list --status open", "br ready --json"]) {
		assert.equal(b.bash(command), undefined, `${command} is an ordinary command now`);
	}
	assert.ok(!(GUARD_CODES as readonly string[]).includes("ledger_inlines_artifact"));
});
```

(`fixture(t)` is whatever helper the file uses to build a `ContextGuard` with an artifact-bearing `cp-research-1`; reuse it. Import `GUARD_CODES` from `../src/guards.ts`.) In the tests around lines 183-232 and 269-270 the `br create -d "...${path}"` and `br close --reason "...${path}"` commands are used as *examples of a textual mention that must not trip the artifact guard*; keep them — they still prove that rule — but rename the test titles from "br" to "an unrelated command". Line 218's pipeline (`ls … && br close … && cat ${path}`) still must be blocked by `cat`; unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/guards.test.ts`
Expected: FAIL — `br show cp-research-1` is still blocked with `ledger_inlines_artifact`.

- [ ] **Step 3: Remove the br branch**

In `src/guards.ts`: delete `"ledger_inlines_artifact"` and its comment from `GUARD_CODES`; delete `const BR_INLINING_SUBCOMMANDS`; delete the `if (program === "br") { … }` block in `check()`; delete the `#checkBr` method; rewrite rule 2 in the header comment to: `2. **The ledger never holds an artifact body.** \`state/artifacts/<job-id>/report.md\` is the only home of findings, so no ledger read can leak one.`; keep rule 3 as is (`.beads/` stays on the list, `.pi-command-post/` is on it too). Update the `docs/contracts.md` guard table in Task 10.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/guards.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guards.ts tests/guards.test.ts
git commit -m "refactor(guards): retire the br show guard; the ledger holds no artifact bodies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `cp_job` and `/cp-jobs` — the two surfaces

**Files:**
- Create: `extensions/command-post/jobs.ts`
- Create: `tests/jobs-tool.test.ts`
- Modify: `extensions/command-post/index.ts` (one import, one call after the other `registerTool`s)
- Modify: `tests/extension-load.test.ts` (assert `cp-jobs` is registered)

**Interfaces:**
- Consumes: `Ledger` (Task 2), `CommandPost.ledger()`, `CommandPost.fleet.get(id)?.phase`, the `emit` closure in `index.ts` (`(ctx, source, text, options?) => void`).
- Produces:
  ```ts
  export const JOB_ACTIONS = ["create","show","list","ready","blocked","claim","update","comment","dep_add","dep_remove","close","drop"] as const;
  export const JobActionSchema;  export type JobActionInput = Static<typeof JobActionSchema>;
  export interface JobPorts { ledger: Ledger; hasLiveWorker: (jobId: string) => boolean }
  export interface JobActionResult { text: string; details: Record<string, unknown> }
  export async function runJobAction(params: JobActionInput, ports: JobPorts): Promise<JobActionResult>
  export type JobsCommand = { kind: "ready"; project?: string } | { kind: "list"; project?: string; all: boolean; status?: JobStatus } | { kind: "show"; jobId: string } | { kind: "import-beads" };
  export function parseJobsArgs(args: string): JobsCommand
  export function formatJobLine(job: Job): string
  export function formatJobDetail(job: Job, blockers: readonly Job[]): string
  export interface JobsRegistration { commandPost: (registry?: unknown) => CommandPost; emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error" }) => void }
  export function registerJobs(pi: ExtensionAPI, ports: JobsRegistration): void
  ```
  `import-beads` parses in this task but its handler answers "not available yet"; Task 8 wires it.

- [ ] **Step 1: Write the failing tests**

Create `tests/jobs-tool.test.ts`:

```ts
/**
 * The ledger's two surfaces (spec 2026-09-04 §Model surface, §Operator surface).
 *
 * `runJobAction` is exercised directly over a scratch ledger; `registerJobs` is
 * exercised through a fake `pi` that captures what was registered, so the tool
 * and the command are proven to be wired to the same policy without a process.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import {
	formatJobLine,
	JOB_ACTIONS,
	type JobActionInput,
	parseJobsArgs,
	registerJobs,
	runJobAction,
} from "../extensions/command-post/jobs.ts";
import { createScratchLedger } from "./harness/index.ts";

function ports(t: { after(fn: () => void): void }, live: Set<string> = new Set()) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	return { scratch, ports: { ledger: scratch.ledger, hasLiveWorker: (id: string) => live.has(id) } };
}

test("cp_job is forbidden to workers and exposes exactly the spec's actions", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_job"));
	assert.deepEqual([...JOB_ACTIONS], ["create", "show", "list", "ready", "blocked", "claim", "update", "comment", "dep_add", "dep_remove", "close", "drop"]);
});

test("create -> show -> list -> ready -> claim -> comment -> close through the action runner", async (t) => {
	const { ports: p } = ports(t);
	const created = await runJobAction({ action: "create", title: "fix it", project: "demo", delivery: "pr", kind: "ship" }, p);
	const id = (created.details.job as { id: string }).id;
	assert.match(id, /^cp-[a-z0-9]{4}$/);
	assert.match(created.text, new RegExp(`^created ${id}`));

	const shown = await runJobAction({ action: "show", job_id: id }, p);
	assert.match(shown.text, /fix it/);
	assert.match(shown.text, /project:demo/);

	const ready = await runJobAction({ action: "ready" }, p);
	assert.deepEqual((ready.details.jobs as Array<{ id: string }>).map((j) => j.id), [id]);

	const claimed = await runJobAction({ action: "claim", job_id: id }, p);
	assert.equal((claimed.details.job as { status: string }).status, "in_progress");
	await assert.rejects(runJobAction({ action: "claim", job_id: id }, p), /already in_progress .* cp_dispatch/);

	const commented = await runJobAction({ action: "comment", job_id: id, text: "blocker: waiting" }, p);
	assert.equal((commented.details.job as { comments: unknown[] }).comments.length, 1);

	const listed = await runJobAction({ action: "list", status: "in_progress" }, p);
	assert.match(listed.text, new RegExp(id));

	const closed = await runJobAction({ action: "close", job_id: id, reason: "merged: https://x/pr/1" }, p);
	assert.equal((closed.details.job as { status: string }).status, "closed");
	assert.deepEqual((await runJobAction({ action: "list" }, p)).details.jobs, []);
	assert.equal(((await runJobAction({ action: "list", all: true }, p)).details.jobs as unknown[]).length, 1);
});

test("refusals at the boundary: pipeline/answer deliveries, a live worker on close/drop, missing arguments", async (t) => {
	const live = new Set<string>();
	const { ports: p } = ports(t, live);
	await assert.rejects(runJobAction({ action: "create", title: "x", project: "demo", delivery: "pipeline" }, p), /cp_pipeline start/);
	await assert.rejects(runJobAction({ action: "create", title: "x", project: "demo", delivery: "answer" }, p), /cp_ask/);
	const created = await runJobAction({ action: "create", title: "x", project: "demo", delivery: "pr" }, p);
	const id = (created.details.job as { id: string }).id;
	live.add(id);
	await assert.rejects(runJobAction({ action: "close", job_id: id, reason: "r" }, p), /a worker holds this job; cp_teardown/);
	await assert.rejects(runJobAction({ action: "drop", job_id: id, reason: "r" }, p), /a worker holds this job; cp_teardown/);
	live.delete(id);
	await assert.rejects(runJobAction({ action: "close", job_id: id } as JobActionInput, p), /cp_job close needs reason/);
	await assert.rejects(runJobAction({ action: "show" } as JobActionInput, p), /cp_job show needs job_id/);
	await assert.rejects(runJobAction({ action: "dep_add", job_id: id } as JobActionInput, p), /cp_job dep_add needs blocker_id/);
	const dropped = await runJobAction({ action: "drop", job_id: id, reason: "not needed" }, p);
	assert.equal((dropped.details.job as { close_reason: string }).close_reason, "dropped: not needed");
});

test("dependencies through the runner: dep_add gates ready, blocked lists blockers, dep_remove frees", async (t) => {
	const { ports: p } = ports(t);
	const a = (await runJobAction({ action: "create", title: "a", project: "demo", delivery: "pr" }, p)).details.job as { id: string };
	const b = (await runJobAction({ action: "create", title: "b", project: "demo", delivery: "pr" }, p)).details.job as { id: string };
	await runJobAction({ action: "dep_add", job_id: b.id, blocker_id: a.id }, p);
	assert.deepEqual(((await runJobAction({ action: "ready" }, p)).details.jobs as Array<{ id: string }>).map((j) => j.id), [a.id]);
	const blocked = await runJobAction({ action: "blocked" }, p);
	assert.deepEqual(blocked.details.jobs, [{ id: b.id, blockers: [a.id] }]);
	assert.match(blocked.text, new RegExp(`${b.id}.*blocked by ${a.id}`));
	await runJobAction({ action: "dep_remove", job_id: b.id, blocker_id: a.id }, p);
	assert.deepEqual((await runJobAction({ action: "blocked" }, p)).details.jobs, []);
	const updated = await runJobAction({ action: "update", job_id: b.id, status: "deferred", priority: 0, add_labels: ["phase:7"] }, p);
	assert.equal((updated.details.job as { status: string }).status, "deferred");
});

test("parseJobsArgs: ready by default, list flags, show needs an id, import-beads", () => {
	assert.deepEqual(parseJobsArgs(""), { kind: "ready" });
	assert.deepEqual(parseJobsArgs("ready --project demo"), { kind: "ready", project: "demo" });
	assert.deepEqual(parseJobsArgs("list --all --status closed --project demo"), { kind: "list", all: true, status: "closed", project: "demo" });
	assert.deepEqual(parseJobsArgs("list"), { kind: "list", all: false });
	assert.deepEqual(parseJobsArgs("show cp-a1b2"), { kind: "show", jobId: "cp-a1b2" });
	assert.deepEqual(parseJobsArgs("import-beads"), { kind: "import-beads" });
	assert.throws(() => parseJobsArgs("show"), /needs a job id/);
	assert.throws(() => parseJobsArgs("list --status bogus"), /--status must be one of/);
	assert.throws(() => parseJobsArgs("frobnicate"), /usage: \/cp-jobs/);
});

test("formatJobLine is one line: id, status, project, delivery/kind, title", () => {
	const line = formatJobLine({
		id: "cp-a1b2",
		title: "fix the thing",
		status: "open",
		priority: 2,
		labels: ["project:demo", "delivery:pr", "kind:ship"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T10:00:00Z",
		updated_at: "2026-09-04T10:00:00Z",
	});
	assert.match(line, /^cp-a1b2\s+open\s+demo\s+pr\/ship\s+fix the thing$/);
	assert.ok(!line.includes("\n"));
});

test("registerJobs wires cp_job and /cp-jobs to the same ledger", async (t) => {
	const { scratch } = ports(t);
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }> }>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		registerTool: (spec: { name: string }) => tools.set(spec.name, spec as never),
		registerCommand: (name: string, spec: unknown) => commands.set(name, spec as never),
	} as unknown as ExtensionAPI;
	const emitted: string[] = [];
	const fakePost = {
		ledger: () => scratch.ledger,
		fleet: { get: () => undefined },
	};
	registerJobs(pi, {
		commandPost: () => fakePost as never,
		emit: (_ctx, _source, text) => {
			emitted.push(text);
		},
	});
	assert.ok(tools.has("cp_job"));
	assert.ok(commands.has("cp-jobs"));

	const ctx = { modelRegistry: undefined, hasUI: false } as unknown as ExtensionContext;
	const result = await tools.get("cp_job")!.execute("t1", { action: "create", title: "via tool", project: "demo", delivery: "local" }, new AbortController().signal, () => {}, ctx);
	assert.match(result.content[0]?.text ?? "", /^created cp-/);

	await commands.get("cp-jobs")!.handler("", ctx);
	assert.match(emitted[0] ?? "", /via tool/, "the command reads what the tool wrote");
	await commands.get("cp-jobs")!.handler("import-beads", ctx);
	assert.match(emitted[1] ?? "", /not available yet/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/jobs-tool.test.ts`
Expected: FAIL — `Cannot find module '../extensions/command-post/jobs.ts'`.

- [ ] **Step 3: Write `extensions/command-post/jobs.ts`**

```ts
/**
 * The ledger's two surfaces (spec 2026-09-04 D6, D7).
 *
 *  - **`cp_job`** is the model's. One tool, `action`-discriminated, every
 *    argument typed in the schema so a malformed call is refused at the
 *    boundary. It returns the affected job (or the list) and never anything
 *    the ledger does not store.
 *  - **`/cp-jobs`** is the operator's: `ready`, `list`, `show` (read-only) and
 *    the one write, `import-beads`.
 *
 * Three refusals live here and not in `Ledger`, because the model is the only
 * caller that could make them by accident: closing a job a live worker holds
 * (`cp_teardown` is the path), claiming a job that is already `in_progress`
 * (dispatch claims), and hand-creating a `pipeline` or `answer` job (those
 * come from `cp_pipeline start` and `cp_ask`, which also do the rest).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { CommandPost } from "../../src/command-post.ts";
import {
	DELIVERIES,
	type Job,
	JOB_KINDS,
	JOB_PRIORITY_MAX,
	JOB_PRIORITY_MIN,
	JOB_STATUSES,
	JOB_TYPES,
	type JobStatus,
	OPEN_JOB_STATUSES,
} from "../../src/contracts.ts";
import { type Ledger, parseJobLabels } from "../../src/ledger.ts";

export const JOB_ACTIONS = [
	"create",
	"show",
	"list",
	"ready",
	"blocked",
	"claim",
	"update",
	"comment",
	"dep_add",
	"dep_remove",
	"close",
	"drop",
] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const JobActionSchema = Type.Object({
	action: StringEnum([...JOB_ACTIONS]),
	job_id: Type.Optional(Type.String({ description: "show/claim/update/comment/dep_*/close/drop: the job" })),
	title: Type.Optional(Type.String({ description: "create: the job title (a question, for Q&A; a one-line task otherwise)" })),
	project: Type.Optional(Type.String({ description: "create: a registered project name; list/ready: filter" })),
	delivery: Type.Optional(StringEnum([...DELIVERIES], { description: "create: pr|local (pipeline and answer come from cp_pipeline / cp_ask); list: filter" })),
	kind: Type.Optional(StringEnum([...JOB_KINDS], { description: "create: ship|research; list: filter" })),
	type: Type.Optional(StringEnum([...JOB_TYPES])),
	priority: Type.Optional(Type.Integer({ minimum: JOB_PRIORITY_MIN, maximum: JOB_PRIORITY_MAX })),
	description: Type.Optional(Type.String()),
	external_ref: Type.Optional(Type.String({ description: "create: the GitHub issue url this job serves" })),
	slug: Type.Optional(Type.String({ description: "create: optional readable stem, e.g. fix-login -> cp-fix-login-a1b2" })),
	labels: Type.Optional(Type.Array(Type.String(), { description: "create: extra labels; list: AND filter" })),
	status: Type.Optional(StringEnum([...JOB_STATUSES], { description: "update: open|in_progress|deferred (never closed); list: filter" })),
	all: Type.Optional(Type.Boolean({ description: "list: include closed jobs" })),
	limit: Type.Optional(Type.Integer({ minimum: 0, description: "list: page size; 0 or absent = unlimited" })),
	notes: Type.Optional(Type.String({ description: "update: replace the notes" })),
	add_labels: Type.Optional(Type.Array(Type.String())),
	remove_labels: Type.Optional(Type.Array(Type.String())),
	text: Type.Optional(Type.String({ description: "comment: the comment" })),
	blocker_id: Type.Optional(Type.String({ description: "dep_add/dep_remove: the job that must close first" })),
	reason: Type.Optional(Type.String({ description: "close/drop: why (a PR url, an artifact, or what superseded it)" })),
});
export type JobActionInput = Static<typeof JobActionSchema>;

export interface JobPorts {
	ledger: Ledger;
	/** True when fleet.json has a record for the job in phase `waiting` or `held`. */
	hasLiveWorker: (jobId: string) => boolean;
}

export interface JobActionResult {
	text: string;
	details: Record<string, unknown>;
}

function need<K extends keyof JobActionInput>(params: JobActionInput, key: K): NonNullable<JobActionInput[K]> {
	const value = params[key];
	if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
		throw new Error(`cp_job ${params.action} needs ${String(key)}`);
	}
	return value as NonNullable<JobActionInput[K]>;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** One line per job: id, status, project, delivery/kind, title. */
export function formatJobLine(job: Job): string {
	const labels = parseJobLabels(job.labels);
	const route = `${labels.delivery ?? "?"}${labels.kind ? `/${labels.kind}` : ""}`;
	return `${pad(job.id, 12)} ${pad(job.status, 12)} ${pad(labels.project ?? "?", 16)} ${pad(route, 10)} ${job.title}`.trimEnd();
}

/** The whole record, for `show`: labels, blockers with their statuses, comments in order. */
export function formatJobDetail(job: Job, blockers: readonly Job[]): string {
	const lines = [
		`${job.id}  ${job.status}${job.assignee ? `  (assignee ${job.assignee})` : ""}`,
		`  title:     ${job.title}`,
		`  labels:    ${job.labels.join(", ")}`,
		`  priority:  ${job.priority}${job.type ? `  type: ${job.type}` : ""}`,
		`  created:   ${job.created_at}  updated: ${job.updated_at}`,
	];
	if (job.external_ref) lines.push(`  ref:       ${job.external_ref}`);
	if (job.description) lines.push(`  desc:      ${job.description.split("\n")[0]}${job.description.includes("\n") ? " …" : ""}`);
	if (job.notes) lines.push(`  notes:     ${job.notes.split("\n")[0]}`);
	if (job.blocked_by.length > 0) {
		lines.push("  blocked by:");
		for (const id of job.blocked_by) {
			const blocker = blockers.find((b) => b.id === id);
			lines.push(`    ${id}  ${blocker ? blocker.status : "(unknown)"}`);
		}
	}
	if (job.status === "closed") lines.push(`  closed:    ${job.closed_at}  ${job.close_reason}`);
	if (job.comments.length > 0) {
		lines.push(`  comments (${job.comments.length}):`);
		for (const comment of job.comments) lines.push(`    ${comment.at} ${comment.author}: ${comment.text}`);
	}
	return lines.join("\n");
}

function listResult(jobs: Job[], empty: string): JobActionResult {
	return {
		text: jobs.length === 0 ? empty : jobs.map(formatJobLine).join("\n"),
		details: { jobs },
	};
}

/** The policy behind `cp_job`. Pure over its ports; the tool and the tests call this. */
export async function runJobAction(params: JobActionInput, ports: JobPorts): Promise<JobActionResult> {
	const { ledger } = ports;
	switch (params.action) {
		case "create": {
			const delivery = need(params, "delivery");
			if (delivery === "pipeline") {
				throw new Error("cp_job create refuses delivery:pipeline — a pipeline is two dep-linked jobs and a planner dispatch; use `cp_pipeline start`");
			}
			if (delivery === "answer") {
				throw new Error("cp_job create refuses delivery:answer — a Q&A job is created and dispatched together; use `cp_ask`");
			}
			const job = await ledger.create({
				title: need(params, "title"),
				project: need(params, "project"),
				delivery,
				...(params.kind ? { kind: params.kind } : {}),
				...(params.type ? { type: params.type } : {}),
				...(params.priority !== undefined ? { priority: params.priority } : {}),
				...(params.description !== undefined ? { description: params.description } : {}),
				...(params.external_ref !== undefined ? { externalRef: params.external_ref } : {}),
				...(params.slug !== undefined ? { slug: params.slug } : {}),
				...(params.labels ? { labels: params.labels } : {}),
			});
			return { text: `created ${job.id}: ${formatJobLine(job)}`, details: { job } };
		}
		case "show": {
			const job = await ledger.show(need(params, "job_id"));
			const blockers = await Promise.all(job.blocked_by.map((id) => ledger.show(id).catch(() => undefined)));
			return { text: formatJobDetail(job, blockers.filter((b): b is Job => b !== undefined)), details: { job } };
		}
		case "list": {
			const jobs = await ledger.list({
				...(params.project ? { project: params.project } : {}),
				...(params.delivery ? { delivery: params.delivery } : {}),
				...(params.kind ? { kind: params.kind } : {}),
				...(params.status ? { status: params.status as JobStatus } : {}),
				...(params.all ? { all: true } : {}),
				...(params.limit !== undefined ? { limit: params.limit } : {}),
				...(params.labels ? { labels: params.labels } : {}),
			});
			return listResult(jobs, "no jobs match");
		}
		case "ready": {
			const jobs = await ledger.ready(params.project ? { project: params.project } : {});
			return listResult(jobs, "nothing is ready");
		}
		case "blocked": {
			const jobs = await ledger.blocked();
			const rows = await Promise.all(jobs.map(async (job) => ({ id: job.id, blockers: await ledger.blockersOf(job.id) })));
			return {
				text: rows.length === 0 ? "nothing is blocked" : rows.map((row) => `${row.id}  blocked by ${row.blockers.join(", ")}`).join("\n"),
				details: { jobs: rows },
			};
		}
		case "claim": {
			const id = need(params, "job_id");
			const current = await ledger.show(id);
			if (current.status === "in_progress") {
				throw new Error(
					`${id} is already in_progress (assignee ${current.assignee ?? "unknown"}) — dispatch claims a job; a second claim means a dispatch was skipped. Use cp_dispatch.`,
				);
			}
			const job = await ledger.claim(id, id);
			return { text: `claimed ${job.id}`, details: { job } };
		}
		case "update": {
			const job = await ledger.update(need(params, "job_id"), {
				...(params.status ? { status: params.status as JobStatus } : {}),
				...(params.priority !== undefined ? { priority: params.priority } : {}),
				...(params.notes !== undefined ? { notes: params.notes } : {}),
				...(params.add_labels ? { addLabels: params.add_labels } : {}),
				...(params.remove_labels ? { removeLabels: params.remove_labels } : {}),
			});
			return { text: `updated ${job.id}: ${formatJobLine(job)}`, details: { job } };
		}
		case "comment": {
			const job = await ledger.comment(need(params, "job_id"), need(params, "text"));
			return { text: `commented on ${job.id} (${job.comments.length} comment(s))`, details: { job } };
		}
		case "dep_add": {
			const id = need(params, "job_id");
			await ledger.addDep(id, need(params, "blocker_id"));
			const job = await ledger.show(id);
			return { text: `${id} is now blocked by ${job.blocked_by.join(", ")}`, details: { job } };
		}
		case "dep_remove": {
			const id = need(params, "job_id");
			await ledger.removeDep(id, need(params, "blocker_id"));
			const job = await ledger.show(id);
			return { text: `${id} is blocked by ${job.blocked_by.length === 0 ? "nothing" : job.blocked_by.join(", ")}`, details: { job } };
		}
		case "close":
		case "drop": {
			const id = need(params, "job_id");
			const reason = need(params, "reason");
			if (ports.hasLiveWorker(id)) {
				throw new Error(
					`${id}: a worker holds this job; cp_teardown ${id} first (or cp_integrate ${id} for a merged PR), then ${params.action} it`,
				);
			}
			const job = params.action === "close" ? await ledger.close(id, reason) : await ledger.drop(id, reason);
			return { text: `${params.action === "close" ? "closed" : "dropped"} ${job.id}: ${job.close_reason}`, details: { job } };
		}
	}
}

// ---------------------------------------------------------------------------
// /cp-jobs
// ---------------------------------------------------------------------------

export type JobsCommand =
	| { kind: "ready"; project?: string }
	| { kind: "list"; project?: string; all: boolean; status?: JobStatus }
	| { kind: "show"; jobId: string }
	| { kind: "import-beads" };

const USAGE = "usage: /cp-jobs [ready [--project N] | list [--all] [--status S] [--project N] | show <job-id> | import-beads]";

export function parseJobsArgs(args: string): JobsCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const head = tokens[0] ?? "ready";
	const rest = tokens.slice(1);
	const flag = (name: string): string | undefined => {
		const index = rest.indexOf(name);
		if (index < 0) return undefined;
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`/cp-jobs: ${name} needs a value — ${USAGE}`);
		return value;
	};
	switch (head) {
		case "ready": {
			const project = flag("--project");
			return { kind: "ready", ...(project ? { project } : {}) };
		}
		case "list": {
			const project = flag("--project");
			const status = flag("--status");
			if (status !== undefined && !(JOB_STATUSES as readonly string[]).includes(status)) {
				throw new Error(`/cp-jobs list: --status must be one of ${JOB_STATUSES.join("|")}`);
			}
			return { kind: "list", all: rest.includes("--all"), ...(project ? { project } : {}), ...(status ? { status: status as JobStatus } : {}) };
		}
		case "show": {
			const jobId = rest[0];
			if (!jobId || jobId.startsWith("--")) throw new Error(`/cp-jobs show needs a job id — ${USAGE}`);
			return { kind: "show", jobId };
		}
		case "import-beads":
			return { kind: "import-beads" };
		default:
			throw new Error(`/cp-jobs: unknown subcommand ${JSON.stringify(head)} — ${USAGE}`);
	}
}

export interface JobsRegistration {
	commandPost: (registry?: unknown) => CommandPost;
	emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error" }) => void;
}

function portsFor(post: CommandPost): JobPorts {
	return {
		ledger: post.ledger(),
		hasLiveWorker: (jobId) => {
			try {
				const phase = post.fleet.get(jobId)?.phase;
				return phase === "waiting" || phase === "held";
			} catch {
				return false;
			}
		},
	};
}

/** Wire `cp_job` and `/cp-jobs`. Called once from `index.ts`. */
export function registerJobs(pi: ExtensionAPI, ports: JobsRegistration): void {
	pi.registerTool({
		name: "cp_job",
		label: "Jobs ledger",
		description:
			"The job ledger: create a job (project + delivery labels are the dispatchability contract), show/list/ready/blocked, " +
			"claim, update, comment, add or remove a blocking dependency, close or drop with a reason. Pipelines come from cp_pipeline, " +
			"Q&A jobs from cp_ask; a job a live worker holds is closed through cp_teardown, never here.",
		promptSnippet: "Record and query jobs in the ledger: create/show/list/ready/blocked/claim/update/comment/dep_add/dep_remove/close/drop (cp_job)",
		promptGuidelines: [
			"Every job needs project (a registered name) and delivery (pr|local); add kind ship|research when it helps routing.",
			"cp_job ready is the queue: one job at a time unless the operator says otherwise.",
			"Close with a reason, always; dropped work is closed with `drop`, never deleted. A job with a live worker is torn down first.",
			"Decisions and blockers are comments on the job, not a parallel journal.",
		],
		parameters: JobActionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runJobAction(params, portsFor(ports.commandPost(ctx.modelRegistry)));
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("cp-jobs", {
		description: "The job ledger: ready (default), list [--all] [--status S] [--project N], show <job-id>, import-beads",
		getArgumentCompletions: (prefix: string) => {
			const words = ["ready", "list", "show", "import-beads", "--all", "--status", "--project"]
				.filter((word) => word.startsWith(prefix))
				.map((word) => ({ value: word, label: word }));
			return words.length > 0 ? words : null;
		},
		handler: async (args, ctx) => {
			try {
				const command = parseJobsArgs(args);
				const post = ports.commandPost(ctx.modelRegistry);
				const p = portsFor(post);
				let text: string;
				switch (command.kind) {
					case "ready":
						text = (await runJobAction({ action: "ready", ...(command.project ? { project: command.project } : {}) }, p)).text;
						break;
					case "list":
						text = (
							await runJobAction(
								{
									action: "list",
									all: command.all,
									...(command.project ? { project: command.project } : {}),
									...(command.status ? { status: command.status } : {}),
								},
								p,
							)
						).text;
						break;
					case "show":
						text = (await runJobAction({ action: "show", job_id: command.jobId }, p)).text;
						break;
					case "import-beads":
						text = "import-beads is not available yet";
						break;
				}
				ports.emit(ctx, "cp-jobs", text);
			} catch (error) {
				ports.emit(ctx, "cp-jobs", (error as Error).message, { level: "error" });
			}
		},
	});
}
```

If `StringEnum` does not accept a second `{ description }` argument in this pi version, drop those descriptions and put the guidance in the field's surrounding `Type.Optional(...)` comment instead — the tests do not depend on them.

- [ ] **Step 4: Wire it into `index.ts`**

In `extensions/command-post/index.ts`: add `import { registerJobs } from "./jobs.ts";` beside the other `./` imports, and after the last `pi.registerTool({ … })` block (the `cp_status_block` tool near the end of the activation function) add:

```ts
	// Spec 2026-09-04: the ledger's two surfaces. `emit` and `commandPost` are
	// this closure's; the policy lives in ./jobs.ts so it is testable without pi.
	registerJobs(pi, { commandPost: (registry) => commandPost(registry), emit });
```

(`commandPost` in `index.ts` takes the registry as its argument — match its actual parameter type; if it is typed as `ModelRegistry | undefined`, cast: `commandPost: (registry) => commandPost(registry as never)`.)

In `tests/extension-load.test.ts`, next to the `cp-ask` assertion, add:

```ts
	const cpJobs = commands.find((command) => command.name === "cp-jobs");
	assert.ok(cpJobs, `cp-jobs not registered; got: ${commands.map((c) => c.name).join(",")}`);
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/jobs-tool.test.ts tests/extension-load.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/command-post/jobs.ts extensions/command-post/index.ts tests/jobs-tool.test.ts tests/extension-load.test.ts
git commit -m "feat(jobs): cp_job tool and /cp-jobs command over the ledger

Three boundary refusals: pipeline/answer creation, claim of an in_progress
job, close/drop under a live worker.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Import the open `.beads/` issues once

**Files:**
- Create: `src/ledger-import.ts`
- Create: `tests/fixtures/beads-issues.jsonl`
- Create: `tests/ledger-import.test.ts`
- Modify: `extensions/command-post/jobs.ts` (the `import-beads` branch), `tests/jobs-tool.test.ts` (the `not available yet` assertion)

**Interfaces:**
- Consumes: `Ledger.importJobs`, `Ledger.read`, `Ledger.home` (Task 2); `validate`, `JobSchema`, `JOB_TYPES`, `isoTimestamp` (contracts).
- Produces:
  ```ts
  export interface BeadsRow { id: string; title: string; status: string; priority?: number; issue_type?: string | null; labels?: string[]; assignee?: string | null; description?: string | null; notes?: string | null; created_at?: string; updated_at?: string; comments?: Array<{ author?: string; text?: string; created_at?: string }>; dependencies?: Array<{ issue_id?: string; depends_on_id: string; type?: string }> }
  export function parseBeadsJsonl(text: string): BeadsRow[]
  export interface BeadsImportPlan { jobs: Job[]; skipped: Array<{ id: string; status: string }>; dependencies_kept: Array<[string, string]>; dependencies_dropped: Array<{ blocked: string; blocker: string; reason: string }> }
  export function planBeadsImport(rows: readonly BeadsRow[], doc: JobsDocument, now?: () => Date): BeadsImportPlan
  export interface BeadsImportReport extends BeadsImportPlan { source: string }
  export async function importBeads(ledger: Ledger, options?: { beadsDir?: string; now?: () => Date }): Promise<BeadsImportReport>
  export function formatBeadsImport(report: BeadsImportReport): string
  ```

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/beads-issues.jsonl` (five lines, one JSON object each; timestamps deliberately sub-second like br writes them):

```
{"id":"cp-old1","title":"an old closed job","status":"closed","priority":1,"issue_type":"bug","labels":["project:demo","delivery:pr","kind:ship"],"created_at":"2026-08-30T10:00:00.123456Z","updated_at":"2026-08-30T12:00:00.1Z","closed_at":"2026-08-30T12:00:00.1Z","close_reason":"merged: https://github.com/o/r/pull/1","comments":[{"id":1,"issue_id":"cp-old1","author":"0xb1ob","text":"landed","created_at":"2026-08-30T12:00:00.5Z"}]}
{"id":"cp-open1","title":"ship the follow-up","status":"open","priority":2,"issue_type":"task","labels":["project:demo","delivery:pr","kind:ship"],"created_at":"2026-09-01T08:00:00.000001Z","updated_at":"2026-09-01T08:00:00.000001Z","dependencies":[{"issue_id":"cp-open1","depends_on_id":"cp-old1","type":"blocks"},{"issue_id":"cp-open1","depends_on_id":"cp-open2","type":"blocks"}]}
{"id":"cp-open2","title":"research the thing","status":"in_progress","priority":0,"issue_type":"feature","assignee":"cp-open2","description":"look at X\nand Y","labels":["project:demo","delivery:local","kind:research"],"created_at":"2026-09-01T09:00:00.777777Z","updated_at":"2026-09-02T09:00:00.1Z","comments":[{"id":2,"issue_id":"cp-open2","author":"0xb1ob","text":"blocker: waiting on operator","created_at":"2026-09-02T09:00:00.2Z"},{"id":3,"issue_id":"cp-open2","author":"0xb1ob","text":"","created_at":"2026-09-02T09:01:00Z"}]}
{"id":"cp-def1","title":"deferred idea","status":"deferred","priority":3,"issue_type":"epic","labels":["project:demo","delivery:pr","phase:7","weird,label"],"created_at":"2026-09-02T10:00:00Z","updated_at":"2026-09-02T10:00:00Z","notes":"later"}
{"id":"cp-tomb","title":"deleted","status":"tombstone","priority":2,"issue_type":"task","labels":["project:demo","delivery:pr"],"created_at":"2026-09-02T11:00:00Z","updated_at":"2026-09-02T11:00:00Z"}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/ledger-import.test.ts`:

```ts
/**
 * `/cp-jobs import-beads` (spec 2026-09-04 §Migrations PR 2): open rows only,
 * ids preserved, timestamps normalised, comments and blocking deps carried,
 * a dependency on a closed row dropped with a note, duplicates and a foreign
 * prefix refused before anything is written, `.beads/` never touched.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyJobsDocument } from "../src/contracts.ts";
import { formatBeadsImport, importBeads, parseBeadsJsonl, planBeadsImport } from "../src/ledger-import.ts";
import { createScratchLedger } from "./harness/index.ts";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/beads-issues.jsonl");
const NOW = () => new Date("2026-09-04T12:00:00Z");

function seedBeads(home: string, text: string = readFileSync(FIXTURE, "utf8")): string {
	const dir = join(home, ".beads");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "issues.jsonl"), text);
	return join(dir, "issues.jsonl");
}

test("parseBeadsJsonl reads one object per line, skips blank lines and names a malformed line", () => {
	const rows = parseBeadsJsonl(readFileSync(FIXTURE, "utf8"));
	assert.deepEqual(rows.map((row) => row.id), ["cp-old1", "cp-open1", "cp-open2", "cp-def1", "cp-tomb"]);
	assert.equal(parseBeadsJsonl("\n\n").length, 0);
	assert.throws(() => parseBeadsJsonl('{"id":"cp-a","title":"t","status":"open"}\n{not json'), /line 2 is not JSON/);
	assert.throws(() => parseBeadsJsonl('{"title":"no id","status":"open"}'), /line 1 has no string id/);
});

test("planBeadsImport keeps open/in_progress/deferred rows, preserves ids, maps fields and normalises timestamps", () => {
	const plan = planBeadsImport(parseBeadsJsonl(readFileSync(FIXTURE, "utf8")), emptyJobsDocument("cp"), NOW);
	assert.deepEqual(plan.skipped, [
		{ id: "cp-old1", status: "closed" },
		{ id: "cp-tomb", status: "tombstone" },
	]);
	assert.deepEqual(plan.jobs.map((job) => job.id), ["cp-open1", "cp-open2", "cp-def1"]);

	const open2 = plan.jobs.find((job) => job.id === "cp-open2");
	assert.equal(open2?.status, "in_progress");
	assert.equal(open2?.type, "feature");
	assert.equal(open2?.priority, 0);
	assert.equal(open2?.assignee, "cp-open2");
	assert.equal(open2?.description, "look at X\nand Y");
	assert.equal(open2?.created_at, "2026-09-01T09:00:00Z", "sub-second precision is dropped");
	assert.equal(open2?.updated_at, "2026-09-02T09:00:00Z");
	assert.deepEqual(open2?.comments, [{ at: "2026-09-02T09:00:00Z", author: "0xb1ob", text: "blocker: waiting on operator" }], "an empty comment is dropped");

	const def1 = plan.jobs.find((job) => job.id === "cp-def1");
	assert.equal(def1?.status, "deferred");
	assert.equal(def1?.type, "epic");
	assert.equal(def1?.notes, "later");
	assert.deepEqual(def1?.labels, ["project:demo", "delivery:pr", "phase:7"], "a label with a comma is not a label");

	const open1 = plan.jobs.find((job) => job.id === "cp-open1");
	assert.deepEqual(open1?.blocked_by, ["cp-open2"]);
	assert.deepEqual(plan.dependencies_kept, [["cp-open1", "cp-open2"]]);
	assert.deepEqual(plan.dependencies_dropped, [{ blocked: "cp-open1", blocker: "cp-old1", reason: "blocker is closed in .beads (blocks nothing)" }]);
});

test("planBeadsImport refuses an id already in the document and a foreign prefix, before anything is built", () => {
	const rows = parseBeadsJsonl(readFileSync(FIXTURE, "utf8"));
	const doc = { ...emptyJobsDocument("cp"), jobs: [] };
	doc.jobs.push({
		id: "cp-open1",
		title: "already here",
		status: "open",
		priority: 2,
		labels: ["project:demo", "delivery:pr"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T12:00:00Z",
		updated_at: "2026-09-04T12:00:00Z",
	});
	assert.throws(() => planBeadsImport(rows, doc, NOW), /already in the ledger: cp-open1/);
	assert.throws(() => planBeadsImport(rows, emptyJobsDocument("cps"), NOW), /prefix cps- but the rows are cp-open1/);
});

test("a row with an unknown type or an out-of-range priority gets the defaults, and a row missing labels still imports", () => {
	const plan = planBeadsImport(
		parseBeadsJsonl('{"id":"cp-x","title":"t","status":"open","issue_type":"saga","priority":9}'),
		emptyJobsDocument("cp"),
		NOW,
	);
	assert.equal(plan.jobs[0]?.type, undefined);
	assert.equal(plan.jobs[0]?.priority, 2);
	assert.deepEqual(plan.jobs[0]?.labels, []);
	assert.equal(plan.jobs[0]?.created_at, "2026-09-04T12:00:00Z", "a missing timestamp is now");
});

test("importBeads writes the plan into the ledger, is refused the second time, and never touches .beads/", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const file = seedBeads(scratch.path);
	const before = readFileSync(file, "utf8");

	const report = await importBeads(scratch.ledger, { now: NOW });
	assert.equal(report.source, file);
	assert.deepEqual(scratch.document().jobs.map((job) => job.id), ["cp-open1", "cp-open2", "cp-def1"]);
	assert.deepEqual(await scratch.ledger.blockersOf("cp-open1"), ["cp-open2"]);
	assert.equal(readFileSync(file, "utf8"), before);

	const text = formatBeadsImport(report);
	assert.match(text, /imported 3 job\(s\) from .*issues\.jsonl/);
	assert.match(text, /skipped 2 closed\/tombstone row\(s\)/);
	assert.match(text, /kept cp-open1 -> cp-open2/);
	assert.match(text, /dropped cp-open1 -> cp-old1: blocker is closed/);

	await assert.rejects(importBeads(scratch.ledger, { now: NOW }), /already in the ledger: cp-open1, cp-open2, cp-def1/);
	assert.equal(scratch.document().jobs.length, 3);
});

test("importBeads names a missing .beads/issues.jsonl", async (t) => {
	const scratch = createScratchLedger();
	t.after(() => scratch.cleanup());
	await assert.rejects(importBeads(scratch.ledger), /no \.beads\/issues\.jsonl under/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/ledger-import.test.ts`
Expected: FAIL — `Cannot find module '../src/ledger-import.ts'`.

- [ ] **Step 4: Write `src/ledger-import.ts`**

```ts
/**
 * One-shot import of the open `.beads/` issues (spec 2026-09-04 §Migrations,
 * PR 2). Reads `issues.jsonl` directly — br's documented interchange file — so
 * no br binary is involved.
 *
 *  - Only rows whose status is `open`, `in_progress` or `deferred` are carried;
 *    `closed` and `tombstone` rows stay in `.beads/` as the frozen archive.
 *  - Ids are preserved (they are branch names and run directories).
 *  - br writes sub-second timestamps; ours are second precision, so every
 *    timestamp is re-rendered through `isoTimestamp`.
 *  - A `blocks` dependency on another carried row is kept; one on a closed or
 *    unknown row is dropped with a note (a closed blocker blocks nothing).
 *  - The plan is refused as a whole when any incoming id already exists in
 *    the document or does not carry the document's prefix. Idempotence is a
 *    refusal, not a merge.
 *  - Nothing under `.beads/` is ever written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isoTimestamp,
	type Job,
	JOB_PRIORITY_MAX,
	JOB_PRIORITY_MIN,
	JOB_TYPES,
	type JobComment,
	type JobsDocument,
	type JobStatus,
	type JobType,
	JobSchema,
	DEFAULT_JOB_PRIORITY,
	validate,
} from "./contracts.ts";
import { type Ledger, LedgerError } from "./ledger.ts";

export interface BeadsRow {
	id: string;
	title: string;
	status: string;
	priority?: number;
	issue_type?: string | null;
	labels?: string[];
	assignee?: string | null;
	description?: string | null;
	notes?: string | null;
	created_at?: string;
	updated_at?: string;
	comments?: Array<{ author?: string; text?: string; created_at?: string }>;
	dependencies?: Array<{ issue_id?: string; depends_on_id: string; type?: string }>;
}

const CARRIED_STATUSES: readonly JobStatus[] = ["open", "in_progress", "deferred"];

export function parseBeadsJsonl(text: string): BeadsRow[] {
	const rows: BeadsRow[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new LedgerError(`.beads/issues.jsonl line ${index + 1} is not JSON`);
		}
		const row = parsed as Partial<BeadsRow>;
		if (typeof row.id !== "string" || row.id.length === 0) throw new LedgerError(`.beads/issues.jsonl line ${index + 1} has no string id`);
		if (typeof row.title !== "string") throw new LedgerError(`.beads/issues.jsonl line ${index + 1} (${row.id}) has no string title`);
		if (typeof row.status !== "string") throw new LedgerError(`.beads/issues.jsonl line ${index + 1} (${row.id}) has no string status`);
		rows.push(row as BeadsRow);
	}
	return rows;
}

export interface BeadsImportPlan {
	jobs: Job[];
	skipped: Array<{ id: string; status: string }>;
	dependencies_kept: Array<[string, string]>;
	dependencies_dropped: Array<{ blocked: string; blocker: string; reason: string }>;
}

function stamp(value: string | undefined, fallback: Date): string {
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return isoTimestamp(parsed);
	}
	return isoTimestamp(fallback);
}

function text(value: string | null | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function planBeadsImport(rows: readonly BeadsRow[], doc: JobsDocument, now: () => Date = () => new Date()): BeadsImportPlan {
	const carried = rows.filter((row) => (CARRIED_STATUSES as readonly string[]).includes(row.status));
	const skipped = rows.filter((row) => !(CARRIED_STATUSES as readonly string[]).includes(row.status)).map((row) => ({ id: row.id, status: row.status }));

	const existing = new Set(doc.jobs.map((job) => job.id));
	const duplicates = carried.filter((row) => existing.has(row.id)).map((row) => row.id);
	if (duplicates.length > 0) throw new LedgerError(`refusing import: already in the ledger: ${duplicates.join(", ")}`);
	const foreign = carried.filter((row) => !row.id.startsWith(`${doc.prefix}-`)).map((row) => row.id);
	if (foreign.length > 0) throw new LedgerError(`refusing import: the document mints prefix ${doc.prefix}- but the rows are ${foreign.join(", ")}`);

	const carriedIds = new Set(carried.map((row) => row.id));
	const closedIds = new Set(skipped.map((row) => row.id));
	const dependenciesKept: Array<[string, string]> = [];
	const dependenciesDropped: Array<{ blocked: string; blocker: string; reason: string }> = [];
	const at = now();

	const jobs = carried.map((row): Job => {
		const blockedBy: string[] = [];
		for (const dep of row.dependencies ?? []) {
			if (dep.type !== undefined && dep.type !== "blocks") continue;
			const blocker = dep.depends_on_id;
			if (carriedIds.has(blocker) || existing.has(blocker)) {
				if (!blockedBy.includes(blocker)) blockedBy.push(blocker);
				dependenciesKept.push([row.id, blocker]);
			} else if (closedIds.has(blocker)) {
				dependenciesDropped.push({ blocked: row.id, blocker, reason: "blocker is closed in .beads (blocks nothing)" });
			} else {
				dependenciesDropped.push({ blocked: row.id, blocker, reason: "blocker is unknown" });
			}
		}
		const comments: JobComment[] = [];
		for (const comment of row.comments ?? []) {
			const body = text(comment.text);
			if (!body) continue;
			comments.push({ at: stamp(comment.created_at, at), author: text(comment.author) ?? "beads", text: body });
		}
		const type = typeof row.issue_type === "string" && (JOB_TYPES as readonly string[]).includes(row.issue_type) ? (row.issue_type as JobType) : undefined;
		const priority =
			typeof row.priority === "number" && Number.isInteger(row.priority) && row.priority >= JOB_PRIORITY_MIN && row.priority <= JOB_PRIORITY_MAX
				? row.priority
				: DEFAULT_JOB_PRIORITY;
		const job: Job = {
			id: row.id,
			title: row.title.trim().length > 0 ? row.title : row.id,
			status: row.status as JobStatus,
			priority,
			labels: (row.labels ?? []).filter((label) => typeof label === "string" && label.length > 0 && !label.includes(",")),
			blocked_by: blockedBy,
			comments,
			created_at: stamp(row.created_at, at),
			updated_at: stamp(row.updated_at, at),
			...(type ? { type } : {}),
			...(text(row.assignee) ? { assignee: row.assignee as string } : {}),
			...(text(row.description) ? { description: row.description as string } : {}),
			...(text(row.notes) ? { notes: row.notes as string } : {}),
		};
		const shape = validate<Job>(JobSchema, job);
		if (!shape.ok) throw new LedgerError(`refusing import: ${row.id} does not fit the job contract:\n  ${shape.errors.join("\n  ")}`);
		return shape.value;
	});

	return { jobs, skipped, dependencies_kept: dependenciesKept, dependencies_dropped: dependenciesDropped };
}

export interface BeadsImportReport extends BeadsImportPlan {
	source: string;
}

/** Read `<home>/.beads/issues.jsonl`, plan, write. Refuses rather than merges. */
export async function importBeads(ledger: Ledger, options: { beadsDir?: string; now?: () => Date } = {}): Promise<BeadsImportReport> {
	const dir = options.beadsDir ?? join(ledger.home, ".beads");
	const source = join(dir, "issues.jsonl");
	if (!existsSync(source)) throw new LedgerError(`no .beads/issues.jsonl under ${dir} — nothing to import`);
	const plan = planBeadsImport(parseBeadsJsonl(readFileSync(source, "utf8")), ledger.read(), options.now);
	await ledger.importJobs(plan.jobs);
	return { ...plan, source };
}

export function formatBeadsImport(report: BeadsImportReport): string {
	const lines = [`imported ${report.jobs.length} job(s) from ${report.source}; skipped ${report.skipped.length} closed/tombstone row(s) (they stay in .beads/ as the archive)`];
	for (const job of report.jobs) lines.push(`  + ${job.id}  ${job.status}  ${job.title}`);
	for (const [blocked, blocker] of report.dependencies_kept) lines.push(`  kept ${blocked} -> ${blocker}`);
	for (const dropped of report.dependencies_dropped) lines.push(`  dropped ${dropped.blocked} -> ${dropped.blocker}: ${dropped.reason}`);
	if (report.jobs.length > 0) lines.push("  .beads/ is now a frozen archive; /doctor will say so until you delete it");
	return lines.join("\n");
}
```

- [ ] **Step 5: Wire `/cp-jobs import-beads`**

In `extensions/command-post/jobs.ts`: add `import { formatBeadsImport, importBeads } from "../../src/ledger-import.ts";` and replace the `import-beads` branch of the handler with:

```ts
					case "import-beads":
						text = formatBeadsImport(await importBeads(post.ledger()));
						break;
```

In `tests/jobs-tool.test.ts`, replace the last two lines of the `registerJobs` test (`await commands.get("cp-jobs")!.handler("import-beads", ctx); assert.match(emitted[1] ?? "", /not available yet/);`) with:

```ts
	await commands.get("cp-jobs")!.handler("import-beads", ctx);
	assert.match(emitted[1] ?? "", /no \.beads\/issues\.jsonl under/, "a home without .beads/ is told so, not crashed");
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/ledger-import.test.ts tests/jobs-tool.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ledger-import.ts tests/ledger-import.test.ts tests/fixtures/beads-issues.jsonl extensions/command-post/jobs.ts tests/jobs-tool.test.ts
git commit -m "feat(jobs): /cp-jobs import-beads carries the open br issues over, once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Documentation says "ledger", not "br"

**Files:**
- Modify: `AGENTS.md`, `docs/contracts.md`, `docs/parity.md`, `README.md`, `tests/e2e/README.md`, `skills/cp-memory/SKILL.md`
- Modify: code comments in `src/` and `extensions/` that still describe br (grep-driven, below)

- [ ] **Step 1: AGENTS.md**

1. In *Each session*, step 3 becomes: `` 3. `cp_job ready` — what is next. One job at a time unless the operator says otherwise. ``
2. In *The loop* diagram replace `br issue` with `cp_job create`; in the table, the `record` row becomes `` | record | `cp_job create` (see [Jobs](#jobs)) | `project:` + `delivery:` labels are the dispatchability contract | ``.
3. In the `Never:` paragraph replace `` commit `data/`, `state/`, `projects/` or `.beads/` `` with `` commit `data/`, `state/`, `projects/`, `.pi-command-post/` or `.beads/` ``.
4. In *Classify* replace `Both live on the br issue as labels.` with `Both live on the job as labels.`
5. In *A small question*: `One br issue, labels` → `One job, labels`; `` `cp_teardown` (the read-only gate) → `br close --reason "answered: …"` `` → `` `cp_teardown` (the read-only gate) → `cp_job close` with reason `answered: …` ``; `through `br show` on an artifact-bearing issue` → delete that clause (the guard is gone; the sentence keeps `read` and `bash cat`).
6. In *Pipeline*: `creates two dep-linked br issues` → `creates two dep-linked jobs`.
7. In *Teardown*: `the PR landed and the br issue is closed or dropped` → `the PR landed and the job is closed or dropped`; in *Integration*: `close the br issue` → `close the job` (twice), `` `br_closed` `` → `` `job_closed` `` (check the field name `cp_integrate` actually returns after PR 1 — it was `br_closed` and the rename made it `job_closed`).
8. In *While they work*, `cp-ci` bullet: `run `cp_merged <job-id>`, close the br issue and tear it down` → `run `cp_merged <job-id>`, close the job (`cp_job close`) and tear it down`.
9. In *Reporting to the operator*: `assuming a closed br issue cleared it` → `assuming a closed job cleared it`.
10. Replace the whole *Backlog (br)* section with:

```markdown
## Jobs

**GitHub Issues are the product backlog.** The ledger tracks in-flight work;
closed jobs are the job history. A GitHub issue travels as `external_ref`,
never as a mirrored copy. The ledger is one file under the home
(`.pi-command-post/jobs.json`); you never edit it, you call `cp_job`.

Every job carries labels: `project:<name>` (a name the registry knows),
`delivery:pr|local`, and `kind:ship|research` when it helps.
`delivery:pipeline` jobs come from `cp_pipeline start` and `delivery:answer`
jobs from `cp_ask` — `cp_job create` refuses both, because each needs more
than a record.

- Record: `cp_job create` with `title`, `project`, `delivery`, `kind`.
- Queue: `cp_job ready` (open, no open blocker). `cp_job blocked` names what
  waits on what.
- Claim: dispatch does it. `cp_job claim` exists for a job you deliberately
  take without a worker, and refuses one already `in_progress`.
- Blocked: a `blocker: …` comment (`cp_job comment`); the job stays
  `in_progress`.
- Real dependencies only: `cp_job dep_add <blocked> <blocker>` means the
  blocked job cannot start until the blocker closes. Cycles are refused.
- Close with a reason, always: `cp_job close`. Dropped work is `cp_job drop`
  (closed with `dropped: …`), never deleted. A job whose worker is alive is
  refused here: `cp_teardown` (or `cp_integrate`) first.
- Dispatch decisions live in job comments. Do not keep a parallel journal.

The operator reads the same ledger with `/cp-jobs` (`ready`, `list`, `show`).
```

11. In *Memory*: `Job history belongs in br.` → `Job history belongs in the ledger (`cp_job list --all`).`
12. Grep: `grep -n '\bbr\b' AGENTS.md` — every remaining hit is a historical job id (`cp-…`) or must be reworded to "the ledger"/"job".

- [ ] **Step 2: docs/contracts.md**

1. TOC: `- [Ledger (br)](#ledger-br)` → `- [Ledger](#ledger)`.
2. *Directory layout*: add under `state/` block's sibling level:
   ```
   .pi-command-post/         the runtime dotdir (gitignored)
     jobs.json               the job ledger: every job, its labels, blockers, comments (spec 2026-09-04)
   .beads/                   frozen archive of the retired br ledger (gitignored; safe to delete)
   ```
   and change the never-commit sentence to name `.pi-command-post/` too.
3. *Worker environment contract* table: already `CP_JOB_ID` after PR 1; no change.
4. *Artifacts and parent context guards*: delete the `ledger_inlines_artifact` row from the guard table; in the *T19 amendment* paragraph replace the last two sentences (from `and copying a body into a ledger whose`) with: `and the ledger holds no bodies at all: a job record carries labels, blockers and short comments, so no ledger read can leak findings. `add` therefore registers a **file**, never a comment.`
5. *Doctor*: replace the subsection *The br checks this build's own history earned* with:
   ```markdown
   ### The ledger checks

   The jobs document (spec 2026-09-04) is checked read-only, six ways:

   | check | severity | when |
   |---|---|---|
   | `ledger.file` | error | the document is missing, not JSON, or fails `JobsDocumentSchema`; fix: start a session (the scaffold creates it) or restore a backup |
   | `ledger.ids` | error | a duplicate id, an id outside `JOB_ID_PATTERN`, an id without the document's prefix, or closed fields on an open job |
   | `ledger.deps` | error | a `blocked_by` entry naming an unknown job, a self-dependency, or a cycle |
   | `ledger.prefix` | warn | `CP_LEDGER_PREFIX` resolves to a value other than the document's (the document wins) |
   | `ledger.size` | warn | more than `JOBS_SIZE_WARNING` (5,000) jobs in one document |
   | `ledger.beads_archive` | warn / ok | `.beads/` still exists: a warning beside a populated document (safe to delete), ok beside an empty one (`/cp-jobs import-beads` not run yet) |

   The br checks this build once carried (`host.br.conflict`, `host.br.version`, `ledger.schema`, `ledger.doctor`) went with the binary; their history is in `docs/build-history.md`.
   ```
6. Replace the whole *Ledger (br)* section with:

```markdown
## Ledger

Implemented in [`src/ledger.ts`](../src/ledger.ts) over one document,
`<home>/.pi-command-post/jobs.json` (spec
`docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md`). **GitHub Issues
are the product backlog**; the ledger tracks in-flight work and, once closed,
is the job history. A GitHub issue travels as `external_ref` (an https url),
never as a mirrored copy.

The document: `{ schema_version, prefix, jobs: Job[] }`. A job carries `id`,
`title`, `status` (`open | in_progress | deferred | closed`), optional `type`
and `description`/`notes`, `priority` 0–4, `labels`, optional `assignee` and
`external_ref`, `blocked_by` (job ids), `comments` (`{at, author, text}`),
timestamps, and `closed_at`/`close_reason` iff closed. `validateJobsDocument`
checks the shape and the invariants: unique ids that carry the prefix, blockers
that exist, no cycles, closed fields consistent with status.

Every job carries labels, and they are the dispatchability contract:

| label | required | values |
|---|---|---|
| `project:<name>` | yes | a name the project registry knows; intake refuses others when a registry is wired in |
| `delivery:<mode>` | yes | `pr` \| `local` \| `pipeline` \| `answer` |
| `kind:<axis>` | no | `ship` \| `research` |

`requireJobLabels(job)` is the fail-closed read: dispatch calls it before a
lease exists, and `update()` calls it after a label edit.

Policy that lives in code:

- **Writes are atomic and serialized.** Every mutation runs inside pi's
  per-path queue, reads the file, validates, mutates, validates again, then
  tmp → fsync → rename (`src/json-store.ts`). There is no cache; the parent
  lock is what makes one writer per home true.
- **Ready and blocked are computed, never stored, never paged.** `ready` is
  `open` with every blocker `closed`; `blockersOf(id)` is the blockers that
  are not closed. The `--limit 0` rule br needed (cp-i2s) has nothing to page.
- **Ids are minted here.** `<prefix>-<4 chars of [a-z0-9]>`, or
  `<prefix>-<slug>-<4 chars>`; eight collisions at four characters, then
  five. The prefix is recorded in the document when it is created
  (`CP_LEDGER_PREFIX`, default `cp`) and wins afterwards; doctor reports a
  disagreeing environment.
- **Closed is a transition, not an edit.** `update()` refuses `closed`;
  `close(id, reason)` needs a reason, is idempotent for the same reason, and
  refuses a different one. `drop()` prefixes `dropped: `. Nothing deletes.
- **Real dependencies only.** `addDep(blocked, blocker)` refuses self, unknown
  ids and a cycle; `removeDep` is idempotent.
- **The class does not know the fleet.** The pipeline closes a research job
  after a gate pass while its planner is still up. The refusal "a worker holds
  this job" lives in the `cp_job` tool, where the model is the caller.

Surfaces: `cp_job` (model; actions `create show list ready blocked claim update
comment dep_add dep_remove close drop`; refuses `delivery:pipeline`/`answer`
on create, a second claim, and close/drop under a live worker) and `/cp-jobs`
(operator; `ready`, `list`, `show`, and the one write, `import-beads`).

Migration from br: `/cp-jobs import-beads` reads `.beads/issues.jsonl`
directly (no binary), carries rows with status `open`/`in_progress`/`deferred`
with their ids, labels, comments and `blocks` dependencies (a dependency on a
closed row is dropped with a note), normalises timestamps to second precision,
and refuses when any incoming id already exists or the prefix differs. Closed
and tombstone rows stay in `.beads/`, which doctor names an archive.
```

7. Grep `docs/contracts.md` for `\bbr\b` and reword remaining mechanism prose (not historical job ids, not the build-history pointers).

- [ ] **Step 3: docs/parity.md**

Edit the rows at these lines (current text → new text):
- 19: `a br issue exists` → `a job exists`.
- 28: `worker identity **is** the br id` → `worker identity **is** the job id`.
- 39: `plus checks this build earned (br version conflict, ledger schema, br's own findings)` → `plus the ledger checks (document shape, ids, dependency graph, prefix, size, `.beads/` archive)`.
- 43: `` and `br init --prefix …` `` → `` and an empty `.pi-command-post/jobs.json` ``.
- 74: `` read learnings, then `br ready` `` → `` read learnings, then `cp_job ready` ``; `` `/status` + `br ready` are step 2–3 `` → `` `/status` + `cp_job ready` are step 2–3 ``.
- 77: `two br issues, dep-linked` → `two jobs, dep-linked`.
- 80: `` never `br show` on artifact-bearing issues `` → delete; `` `ContextGuard` blocks `read`/`grep`/`bash`/`edit`/`write`/`br show` `` → `` `ContextGuard` blocks `read`/`grep`/`bash`/`edit`/`write`; the ledger holds no bodies ``.
- 83: `branch=br-id` → `branch=job-id` (PR 1 did this; confirm).
- 110: `→ br close` → `→ job close`.
- 115: `Backlog (br): …` → `Jobs ledger: GitHub is the product backlog, labels, intake, deps, completion, history | ported (in-house document, spec 2026-09-04) | [`src/ledger.ts`](../src/ledger.ts) + AGENTS.md §Jobs | `tests/ledger.test.ts``.
- 116: `` `--slug` on `br create` `` → `` `slug` on `cp_job create` ``.
- 117: `br verification cap ("`--limit 0` when the result decides membership")` → `membership queries are never paged` | mechanised | `ready`/`blocked`/`blockersOf` are computed over the whole document; there is no page to fall off`.
- 120: `never commit `data/ state/ projects/ .beads/`` → `never commit `data/ state/ projects/ .beads/ .pi-command-post/``.
- 133: `br list cap` → `ledger membership queries`.
- 135: `` `br-slug-install.md`, `br-tracker-research.md` (pinned br, migrate-schema) | `/doctor` `ledger.schema` + `host.br.conflict` `` → `` `br-slug-install.md`, `br-tracker-research.md` (pinned br, migrate-schema) | retired with br (spec 2026-09-04); `/doctor` checks the jobs document instead ``.
- 139: `## 5. Gaps filed as br issues` → `## 5. Gaps filed as jobs`.

- [ ] **Step 4: README.md, e2e README, cp-memory skill**

`README.md`:
- Line 25: delete `and `br show` on artifact-bearing issues` (keep `read`, `bash cat`).
- Lines 37-40 (*Requirements*): `` `pi`, `git`, [`treehouse`](…) (worktree leases — there is no `git worktree add` fallback, by design) and [`gh`](…) `` — remove the br clause entirely. In the paragraph below, `(`git`/`br`/`treehouse`/`pi`/`gh`)` → `(`git`/`treehouse`/`pi`/`gh`)`; `Linux is supported for `br`, `treehouse` and `pi`` → `Linux is supported for `treehouse` and `pi``.
- Line 92: `` and `br init --prefix cp` when there is no ledger yet `` → `` and an empty `.pi-command-post/jobs.json` when there is no ledger yet ``.
- Line 117 (`CP_LEDGER_PREFIX` row): `br mints ids per database with no knowledge of another home's` → `each home mints ids with no knowledge of another home's`.
- Line 131: `records the job in `br`` → `records the job in the ledger (`cp_job`)`.
- Layout table: `| `.beads/` | **no** | the br ledger |` → two rows: `| `.pi-command-post/` | **no** | `jobs.json`, the job ledger |` and `| `.beads/` | **no** | frozen archive of the retired br ledger; safe to delete |`; line 200: `` `data/`, `state/`, `projects/` and `.beads/` `` → `` `data/`, `state/`, `projects/`, `.pi-command-post/` and `.beads/` ``.
- *Surfaces* table: add `| `/cp-jobs [ready \| list \| show <job-id> \| import-beads]` | the job ledger, read-only except the one-shot import |` and `| `cp_job` | the model's ledger tool: create/show/list/ready/blocked/claim/update/comment/dep_add/dep_remove/close/drop |`.

`tests/e2e/README.md`: line 10 `br intake` → `ledger intake`; line 32 delete the `br --version` prerequisite line; lines 38-39 `scratch `br` workspace` → `scratch ledger`, `your `.beads/`` → `your ledger`; line 90 `→ `br close`` → `→ job close`, and drop `br,` from the needs column; line 174 `additionally need `br` and` → `additionally need`.

`PLAN.md`: it is a historical build record and is otherwise left alone; directly under its line 7 (`Task ledger for this build: **br** …`) add one line: `> 2026-09-04: br was retired; the ledger is now the in-house jobs document — see docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md.`

`skills/cp-memory/SKILL.md`: line 49 `a br issue` → `a job`; line 53 `Job history lives in **br** (`br list`, closed issues), not here.` → `Job history lives in **the ledger** (`cp_job list --all`, closed jobs), not here.`; line 111 `(all in br)` → `(all in the ledger)`; line 127 `a br id` → `a job id`; line 168 `` For past jobs use `br list` / `br show`. `` → `` For past jobs use `cp_job list --all` / `cp_job show`. ``

- [ ] **Step 5: Code comments**

```bash
grep -rn '\bbr\b' src extensions | grep -v 'cp-[a-z0-9]' | cut -c1-160
```

For every hit that describes a mechanism (not a historical job id or a filename), reword to "the ledger"/"job". Expected hot spots: `src/artifacts.ts:18`, `src/status.ts` header, `src/pipeline.ts:553`, `src/status-block.ts:213`, `src/integrate.ts:1013-1020` (the facts string `br ${id} closed:` → `job ${id} closed:`), `extensions/command-post/index.ts:1449-1460` (the `cp_ask` comment) and `:2905-2925` (the audit comment), `src/doctor.ts` header. Leave `docs/build-history.md`, `PLAN.md`, `docs/spikes/`, `docs/superpowers/` alone.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`
Expected: PASS (integrate tests may pin the `br … closed` fact string; update the assertion to `job … closed`).

```bash
git add -A AGENTS.md docs/contracts.md docs/parity.md README.md tests/e2e/README.md skills/cp-memory/SKILL.md src extensions tests
git commit -m "docs: the ledger replaces br in AGENTS.md, contracts, parity, README and comments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Import on the live home, verify, open the PR

**Files:** none (operator steps).

- [ ] **Step 1: Full suite on the branch**

Run: `npm test`
Expected: PASS, and no suite reports `skip: … br …`.

- [ ] **Step 2: Flush br one last time, then import**

br is still installed on this machine; make sure its JSONL is current before reading it:

```bash
br sync --flush-only
```

Start a session at the repo root (`pi -e extensions/command-post/index.ts`) and run:

```
/cp-jobs import-beads
/cp-jobs
/doctor
```

Expected: the import lists every open/in_progress/deferred issue that `.beads/` holds at that moment (ids preserved), `/cp-jobs` shows the ready ones, and `/doctor` is green except `! [ledger.beads_archive]`, which says `.beads/` is safe to delete. Confirm the in-progress jobs' worktrees and branches still match their ids (`/status`).

- [ ] **Step 3: Prove the model path once**

In the same session ask the parent to run `cp_job ready` and `cp_job show <one id>`. Expected: it uses the tool (no bash `br`), and the tool result matches `/cp-jobs show`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(ledger): in-house jobs document replaces br" --body "$(cat <<'EOF'
PR 2 of docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md.

- src/ledger.ts over <home>/.pi-command-post/jobs.json: same Ledger surface, computed ready/blocked, in-house ids, atomic writes.
- cp_job tool + /cp-jobs command (extensions/command-post/jobs.ts) with the three boundary refusals.
- /cp-jobs import-beads: open .beads/ issues carried over once; closed rows stay as an archive.
- Doctor: ledger.file/ids/deps/prefix/size/beads_archive replace the br checks; br leaves the tool manifest; the br guard retires.
- Fifteen suites that gated on a br binary now run in CI.

Verified on the live home: import, /cp-jobs, /doctor green apart from the archive warning.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
