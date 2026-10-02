# Job id rename (`br_id` → `job_id`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every `br_id` (and its spellings `brId`, `br-id`, `BrId`, `BR_ID`) to `job_id` across code, tests, templates and docs, and migrate the persisted files under `state/` once, with no behaviour change and `br` still the backend.

**Architecture:** One new pure module, `src/state-migrations.ts`, walks `state/` at session start, renames the key in every JSON document and every JSONL journal, and leaves a marker so it never runs twice. A doctor check reports a home that has not been swept. The rename itself is a mechanical `perl -pi` over tracked files with five patterns, followed by a typecheck and the full suite. This is PR 1 of the spec; PR 2 (the in-house ledger) lands on the clean names.

**Tech Stack:** TypeScript (ES2023, `nodenext`, strict), Node 24, `node --test`, typebox, pi extension API (`@earendil-works/pi-coding-agent`).

**Spec:** `docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md` (§Migrations → PR 1, §Contract additions, §Testing, §Task order → PR 1).

## Global Constraints

- No behaviour change in this PR: `br` remains the ledger backend; only names and persisted keys move.
- `JOB_ID_PATTERN` keeps today's value verbatim: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.
- The worker environment variable becomes `CP_JOB_ID` (was `CP_BR_ID`); the worker-reporter reads the new name only.
- The sweep runs at `session_start` **after** the parent lock is acquired and **before** anything reads `state/` (`surfaceAnswered`, the widget, reconcile).
- The sweep never touches `state/sessions/`, any `.md`, or any file whose name contains `.bak`; a JSONL line that does not parse is copied byte for byte; every write is atomic (`atomicWriteText`).
- Marker: `<home>/state/.migrations/2026-09-job-id.done`. Present ⇒ the sweep is a no-op.
- Historical records are not renamed: `PLAN.md`, `docs/build-history.md`, `docs/spikes/`, `docs/superpowers/`.
- Every commit must pass `npm run typecheck`; the PR must pass `npm test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File structure

| file | role |
|---|---|
| `src/state-migrations.ts` (new) | `renameKeyDeep`, `listSweepTargets`, `sweepJobIdRename`, `jobIdMigrationFinding`, marker constants. Pure over the filesystem; no pi imports. |
| `tests/state-migrations.test.ts` (new) | fixture `state/` tree in a scratch home; every rule above asserted. |
| `src/contracts.ts` | `LAYOUT.migrationsDir`; then the mechanical rename (`JOB_ID_PATTERN`, `JobIdSchema`, `isSafeJobId`, every `job_id` field, `BRIEF_PLACEHOLDERS`). |
| `src/doctor.ts` | `#migrations()` → `state.job_id_migration`; `DOCTOR_PROBE_JOB_ID`. |
| `tests/doctor.test.ts`, `tests/golden/doctor-broken.txt` | the new check; regenerated golden. |
| `extensions/command-post/index.ts` | calls the sweep right after the parent lock. |
| `tests/extension-load.test.ts` | seeds a `br_id` fleet file, asserts it is renamed and the marker exists after startup. |
| everything tracked under `src/`, `extensions/`, `tests/`, `scripts/`, `prompts/`, `profiles/`, `skills/`, `AGENTS.md`, `README.md`, `docs/contracts.md`, `docs/parity.md` | the mechanical rename. |
| `docs/contracts.md` | one new subsection under *Identifiers and timestamps* describing the sweep. |

---

### Task 1: `src/state-migrations.ts` — the rename sweep

**Files:**
- Create: `src/state-migrations.ts`
- Create: `tests/state-migrations.test.ts`
- Modify: `src/contracts.ts:3327-3363` (`LAYOUT` gains `migrationsDir`)

**Interfaces:**
- Consumes: `atomicWriteText` from `src/json-store.ts`; `LAYOUT` from `src/contracts.ts`; `DoctorFinding` type from `src/contracts.ts`.
- Produces (used by Tasks 2 and 3):
  ```ts
  export const JOB_ID_MIGRATION_MARKER = "2026-09-job-id.done";
  export const LEGACY_JOB_ID_KEY = "br_id";
  export const JOB_ID_KEY = "job_id";
  export interface SweepDocument { file: string; action: "renamed" | "unchanged" | "unparseable"; renamed: number }
  export interface SweepJournal { file: string; lines_renamed: number; lines_copied: number }
  export interface SweepReport { home: string; marker: string; already_done: boolean; documents: SweepDocument[]; journals: SweepJournal[] }
  export function renameKeyDeep(value: unknown, from: string, to: string): { value: unknown; renamed: number }
  export function listSweepTargets(home: string): { documents: string[]; journals: string[] }
  export function sweepJobIdRename(options: { home: string }): SweepReport
  export function formatSweep(report: SweepReport): string
  export function jobIdMigrationFinding(home: string): DoctorFinding
  ```

- [ ] **Step 1: Add `migrationsDir` to `LAYOUT`**

In `src/contracts.ts`, inside `export const LAYOUT = Object.freeze({ ... })`, after the `parentLock` entry add:

```ts
	/** One-shot state migrations leave a marker here so they never run twice. */
	migrationsDir: "state/.migrations",
```

Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 2: Write the failing tests**

Create `tests/state-migrations.test.ts`:

```ts
/**
 * The br_id -> job_id state sweep (spec §Migrations, PR 1). Every rule is a
 * test: documents are deep-renamed, journals are rewritten line by line, a
 * malformed line is copied verbatim, sessions/ and .bak files are skipped,
 * the marker makes the second run a no-op, and doctor can tell an unswept
 * home from a swept one.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import {
	JOB_ID_MIGRATION_MARKER,
	jobIdMigrationFinding,
	listSweepTargets,
	renameKeyDeep,
	sweepJobIdRename,
} from "../src/state-migrations.ts";
import { createScratchHome } from "./harness/index.ts";

function write(home: string, relative: string, text: string): string {
	const file = join(home, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return file;
}

/** A home that looks like one written before the rename. */
function seedLegacyHome(home: string): void {
	write(home, "state/fleet.json", JSON.stringify({ schema_version: 1, updated_at: "2026-09-01T00:00:00Z", jobs: [{ br_id: "cp-a", phase: "waiting", nested: { br_id: "cp-a" } }] }));
	write(home, "state/awaiting.json", JSON.stringify({ items: [{ id: "aw-1", br_id: "cp-a" }] }));
	write(home, "state/checkpoints/cp-a.json", JSON.stringify({ br_id: "cp-a", decision: "pending" }));
	write(home, "state/runs/cp-a/status.json", JSON.stringify({ br_id: "cp-a", phase: "working" }));
	write(home, "state/runs/cp-a/gate-1/verdict.json", JSON.stringify({ br_id: "cp-a", verdict: "pass" }));
	write(
		home,
		"state/runs/cp-a/events.jsonl",
		[
			JSON.stringify({ seq: 1, br_id: "cp-a", type: "spawned", payload: { br_id: "cp-a" } }),
			"this line is not json {",
			JSON.stringify({ seq: 2, br_id: "cp-a", type: "text", payload: { text: "the string br_id stays" } }),
			"",
		].join("\n"),
	);
	// Must be left alone: pi's own transcripts, a backup, prose.
	write(home, "state/sessions/2026-09-01.jsonl", JSON.stringify({ br_id: "cp-a" }));
	write(home, "state/awaiting.json.bak-1", JSON.stringify({ br_id: "cp-a" }));
	write(home, "state/runs/cp-a/brief.md", "Job br_id cp-a");
	write(home, "state/parent.lock", "12345");
}

test("renameKeyDeep renames object keys at every depth and never touches values", () => {
	const input = { br_id: "cp-a", list: [{ br_id: "cp-b" }, "br_id"], deep: { x: { br_id: null } }, text: "br_id" };
	const { value, renamed } = renameKeyDeep(input, "br_id", "job_id");
	assert.deepEqual(value, { job_id: "cp-a", list: [{ job_id: "cp-b" }, "br_id"], deep: { x: { job_id: null } }, text: "br_id" });
	assert.equal(renamed, 3);
	assert.deepEqual(renameKeyDeep(42, "br_id", "job_id"), { value: 42, renamed: 0 });
});

test("listSweepTargets finds json documents and jsonl journals under state/ and skips sessions, backups and prose", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLegacyHome(home.path);
	const targets = listSweepTargets(home.path);
	const rel = (files: string[]) => files.map((file) => file.slice(home.path.length + 1)).sort();
	assert.deepEqual(rel(targets.documents), [
		"state/awaiting.json",
		"state/checkpoints/cp-a.json",
		"state/fleet.json",
		"state/runs/cp-a/gate-1/verdict.json",
		"state/runs/cp-a/status.json",
	]);
	assert.deepEqual(rel(targets.journals), ["state/runs/cp-a/events.jsonl"]);
});

test("the sweep renames documents and journal lines, copies a malformed line verbatim, writes the marker, and is a no-op afterwards", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLegacyHome(home.path);

	const first = sweepJobIdRename({ home: home.path });
	assert.equal(first.already_done, false);
	assert.equal(first.documents.filter((d) => d.action === "renamed").length, 5);
	assert.deepEqual(first.journals, [{ file: join(home.path, "state/runs/cp-a/events.jsonl"), lines_renamed: 2, lines_copied: 1 }]);
	assert.ok(existsSync(join(home.path, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER)));

	const fleet = JSON.parse(readFileSync(join(home.path, "state/fleet.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
	assert.deepEqual(fleet.jobs[0], { job_id: "cp-a", phase: "waiting", nested: { job_id: "cp-a" } });
	assert.ok(!readFileSync(join(home.path, "state/checkpoints/cp-a.json"), "utf8").includes('"br_id"'));

	const events = readFileSync(join(home.path, "state/runs/cp-a/events.jsonl"), "utf8").split("\n");
	assert.deepEqual(JSON.parse(events[0] as string), { seq: 1, job_id: "cp-a", type: "spawned", payload: { job_id: "cp-a" } });
	assert.equal(events[1], "this line is not json {");
	assert.deepEqual(JSON.parse(events[2] as string), { seq: 2, job_id: "cp-a", type: "text", payload: { text: "the string br_id stays" } });
	assert.equal(events[3], "", "the trailing newline survives");

	// Untouched by contract.
	assert.equal(readFileSync(join(home.path, "state/sessions/2026-09-01.jsonl"), "utf8"), JSON.stringify({ br_id: "cp-a" }));
	assert.equal(readFileSync(join(home.path, "state/awaiting.json.bak-1"), "utf8"), JSON.stringify({ br_id: "cp-a" }));
	assert.equal(readFileSync(join(home.path, "state/runs/cp-a/brief.md"), "utf8"), "Job br_id cp-a");

	const second = sweepJobIdRename({ home: home.path });
	assert.equal(second.already_done, true);
	assert.deepEqual(second.documents, []);
	assert.deepEqual(second.journals, []);
});

test("an unparseable document is reported and left exactly as it was", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = write(home.path, "state/runs/cp-x/status.json", '{"br_id": "cp-x", broken');
	const report = sweepJobIdRename({ home: home.path });
	assert.deepEqual(report.documents, [{ file, action: "unparseable", renamed: 0 }]);
	assert.equal(readFileSync(file, "utf8"), '{"br_id": "cp-x", broken');
	assert.ok(existsSync(join(home.path, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER)), "the marker is written: the sweep did all it could");
});

test("a home with no state at all sweeps to an empty report and still writes the marker", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = sweepJobIdRename({ home: home.path });
	assert.equal(report.already_done, false);
	assert.deepEqual(report.documents, []);
	assert.ok(existsSync(report.marker));
});

test("doctor: unswept files are an error, a swept home is ok, and a legacy file behind the marker is a warning", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const fresh = jobIdMigrationFinding(home.path);
	assert.equal(fresh.check, "state.job_id_migration");
	assert.equal(fresh.severity, "ok");

	seedLegacyHome(home.path);
	const unswept = jobIdMigrationFinding(home.path);
	assert.equal(unswept.severity, "error");
	assert.match(unswept.what, /5 file\(s\) still carry "br_id"/);
	assert.match(unswept.fix ?? "", /start a pi session/);

	sweepJobIdRename({ home: home.path });
	assert.equal(jobIdMigrationFinding(home.path).severity, "ok");

	write(home.path, "state/checkpoints/restored.json", JSON.stringify({ br_id: "cp-z" }));
	const restored = jobIdMigrationFinding(home.path);
	assert.equal(restored.severity, "warn");
	assert.match(restored.fix ?? "", /remove the marker/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/state-migrations.test.ts`
Expected: FAIL — `Cannot find module '../src/state-migrations.ts'`.

- [ ] **Step 4: Implement `src/state-migrations.ts`**

```ts
/**
 * One-shot state migrations (spec 2026-09-04 §Migrations, PR 1).
 *
 * The rename `br_id` -> `job_id` changed the key every persisted document and
 * journal under `state/` is written with. This module moves the files that
 * were written before the rename, once, at session start:
 *
 *  - **Documents** (`*.json`) are parsed, the key is renamed wherever it is an
 *    object key (values are never touched), and the file is rewritten
 *    atomically. A document that does not parse is reported and left alone.
 *  - **Journals** (`*.jsonl`) are rewritten line by line the same way; a line
 *    that does not parse is copied byte for byte, because a journal is an
 *    append-only record and losing a line is worse than keeping an old key.
 *  - **Skipped**: `state/sessions/` (pi's own transcripts), anything with
 *    `.bak` in its name, `state/.migrations/`, and every non-JSON file.
 *  - **The marker** `state/.migrations/2026-09-job-id.done` is written when
 *    the sweep completes, and its presence makes every later call a no-op.
 *
 * Doctor reads the same walk to say whether a home still carries the old key.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type DoctorFinding, LAYOUT } from "./contracts.ts";
import { atomicWriteText } from "./json-store.ts";

export const JOB_ID_MIGRATION_MARKER = "2026-09-job-id.done";
export const LEGACY_JOB_ID_KEY = "br_id";
export const JOB_ID_KEY = "job_id";

export interface SweepDocument {
	file: string;
	action: "renamed" | "unchanged" | "unparseable";
	renamed: number;
}

export interface SweepJournal {
	file: string;
	lines_renamed: number;
	lines_copied: number;
}

export interface SweepReport {
	home: string;
	marker: string;
	already_done: boolean;
	documents: SweepDocument[];
	journals: SweepJournal[];
}

/** Rename `from` to `to` wherever it appears as an object key. Values are never touched. */
export function renameKeyDeep(value: unknown, from: string, to: string): { value: unknown; renamed: number } {
	let renamed = 0;
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (typeof node !== "object" || node === null) return node;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			if (key === from) renamed += 1;
			out[key === from ? to : key] = walk(child);
		}
		return out;
	};
	return { value: walk(value), renamed };
}

export function migrationMarkerPath(home: string): string {
	return join(home, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER);
}

const SKIPPED_DIRS = new Set(["sessions", ".migrations"]);

/** Every `.json` document and `.jsonl` journal under `state/` that the sweep may touch. */
export function listSweepTargets(home: string): { documents: string[]; journals: string[] } {
	const documents: string[] = [];
	const journals: string[] = [];
	const root = join(home, LAYOUT.state);
	if (!existsSync(root)) return { documents, journals };
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				const top = relative(root, path).split(sep)[0] ?? "";
				if (SKIPPED_DIRS.has(top)) continue;
				visit(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name.includes(".bak")) continue;
			if (entry.name.endsWith(".json")) documents.push(path);
			else if (entry.name.endsWith(".jsonl")) journals.push(path);
		}
	};
	visit(root);
	return { documents: documents.sort(), journals: journals.sort() };
}

function sweepDocument(file: string): SweepDocument {
	const text = readFileSync(file, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { file, action: "unparseable", renamed: 0 };
	}
	const { value, renamed } = renameKeyDeep(parsed, LEGACY_JOB_ID_KEY, JOB_ID_KEY);
	if (renamed === 0) return { file, action: "unchanged", renamed: 0 };
	atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
	return { file, action: "renamed", renamed };
}

function sweepJournal(file: string): SweepJournal {
	const text = readFileSync(file, "utf8");
	const lines = text.split("\n");
	let linesRenamed = 0;
	let linesCopied = 0;
	const out = lines.map((line, index) => {
		// The split leaves one empty string after a trailing newline; keep it as is.
		if (line.length === 0 && index === lines.length - 1) return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			linesCopied += 1;
			return line;
		}
		const { value, renamed } = renameKeyDeep(parsed, LEGACY_JOB_ID_KEY, JOB_ID_KEY);
		if (renamed === 0) return line;
		linesRenamed += 1;
		return JSON.stringify(value);
	});
	if (linesRenamed > 0) atomicWriteText(file, out.join("\n"));
	return { file, lines_renamed: linesRenamed, lines_copied: linesCopied };
}

/**
 * Run the sweep once. Idempotent by the marker: the second call reports
 * `already_done` and touches nothing. Never throws for a file it cannot
 * parse — that is a report line, and the marker is still written, because a
 * sweep that stops at the first odd file would re-run forever.
 */
export function sweepJobIdRename(options: { home: string }): SweepReport {
	const marker = migrationMarkerPath(options.home);
	if (existsSync(marker)) {
		return { home: options.home, marker, already_done: true, documents: [], journals: [] };
	}
	const targets = listSweepTargets(options.home);
	const documents = targets.documents.map(sweepDocument);
	const journals = targets.journals.map(sweepJournal).filter((j) => j.lines_renamed > 0 || j.lines_copied > 0);
	mkdirSync(join(options.home, LAYOUT.migrationsDir), { recursive: true });
	writeFileSync(marker, `${new Date().toISOString()}\n`);
	return { home: options.home, marker, already_done: false, documents, journals };
}

/** One operator-facing block; silent about the boring case. */
export function formatSweep(report: SweepReport): string {
	if (report.already_done) return "";
	const renamed = report.documents.filter((d) => d.action === "renamed");
	const unparseable = report.documents.filter((d) => d.action === "unparseable");
	const lines = [
		`state migration: renamed br_id -> job_id in ${renamed.length} document(s) and ${report.journals.length} journal(s) under ${report.home}`,
	];
	for (const doc of unparseable) lines.push(`  ! ${doc.file}: not JSON, left as is`);
	return lines.join("\n");
}

const LEGACY_KEY_RE = /"br_id"\s*:/;

/** Files under state/ (same walk as the sweep) that still carry the old key. */
function legacyFiles(home: string): string[] {
	const targets = listSweepTargets(home);
	return [...targets.documents, ...targets.journals].filter((file) => {
		try {
			return statSync(file).isFile() && LEGACY_KEY_RE.test(readFileSync(file, "utf8"));
		} catch {
			return false;
		}
	});
}

/**
 * Doctor's view. Error when the marker is missing and old keys exist (the
 * next session start fixes it); warn when the marker exists but a file still
 * carries the key (something was restored from a backup after the sweep).
 */
export function jobIdMigrationFinding(home: string): DoctorFinding {
	const marker = migrationMarkerPath(home);
	const legacy = legacyFiles(home);
	if (legacy.length === 0) {
		return { check: "state.job_id_migration", severity: "ok", what: "no state files carry the pre-rename br_id key" };
	}
	const detail = legacy.slice(0, 5).map((file) => relative(home, file)).join(", ") + (legacy.length > 5 ? ", …" : "");
	if (!existsSync(marker)) {
		return {
			check: "state.job_id_migration",
			severity: "error",
			what: `${legacy.length} file(s) still carry "br_id" and the rename sweep has not run`,
			detail,
			fix: "start a pi session in this home: session_start runs the br_id -> job_id sweep once and writes state/.migrations/2026-09-job-id.done",
		};
	}
	return {
		check: "state.job_id_migration",
		severity: "warn",
		what: `${legacy.length} file(s) carry "br_id" although the sweep already ran (restored from a backup?)`,
		detail,
		fix: `remove the marker ${relative(home, marker)} and start a session to sweep again, or fix the files by hand`,
	};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/state-migrations.test.ts && npm run typecheck`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/state-migrations.ts tests/state-migrations.test.ts src/contracts.ts
git commit -m "feat(state): one-shot br_id -> job_id sweep for state/ documents and journals

Pure module with a marker under state/.migrations; doctor finding for an
unswept home. Not wired yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Doctor reports an unswept home

**Files:**
- Modify: `src/doctor.ts:180-192` (the `run()` finding list) and add a `#migrations()` method near `#parentLock()`
- Modify: `tests/doctor.test.ts` (one new test)
- Modify: `tests/golden/doctor-broken.txt` (regenerated)

**Interfaces:**
- Consumes: `jobIdMigrationFinding(home)` from Task 1.
- Produces: finding `state.job_id_migration` in every `DoctorReport`.

- [ ] **Step 1: Write the failing test**

Append to `tests/doctor.test.ts` (after the `"a home with no ledger is a warning, not a failure"` test):

```ts
test("state.job_id_migration: a pre-rename fleet file is an error until the sweep runs", async (t) => {
	const fixture = homeFixture(t);
	mkdirSync(join(fixture.home.path, "state"), { recursive: true });
	writeFileSync(
		join(fixture.home.path, "state/fleet.json"),
		JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-08-27T00:00:00Z", jobs: [{ br_id: "cp-old" }] }),
	);
	const before = await fixture.doctor().run();
	const finding = before.findings.find((f) => f.check === "state.job_id_migration");
	assert.equal(finding?.severity, "error");
	assert.match(finding?.fix ?? "", /session_start runs the br_id -> job_id sweep/);

	sweepJobIdRename({ home: fixture.home.path });
	const after = await fixture.doctor().run();
	assert.equal(after.findings.find((f) => f.check === "state.job_id_migration")?.severity, "ok");
});
```

Add to the imports at the top of `tests/doctor.test.ts`:

```ts
import { sweepJobIdRename } from "../src/state-migrations.ts";
```

(`homeFixture`, `mkdirSync`, `writeFileSync`, `join`, `SCHEMA_VERSION` are already imported/defined in that file — check the existing `HomeFixture` helper name at `tests/doctor.test.ts:80-110` and use the exact helper the other tests call, e.g. `const fixture = homeFixture(t)` or `const { home, doctor } = await fixtureHome(t)`; match what the neighbouring tests do.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/doctor.test.ts`
Expected: FAIL — `finding?.severity` is `undefined` (no such check yet). The golden test also fails because the report now differs; that is expected until Step 4.

- [ ] **Step 3: Add the check to `Doctor`**

In `src/doctor.ts`:

1. Add the import next to the other `./` imports:
   ```ts
   import { jobIdMigrationFinding } from "./state-migrations.ts";
   ```
2. In `run()`, insert `...this.#migrations(),` directly after `...this.#parentLock(),`.
3. Add the method after `#parentLock()`:
   ```ts
   	// -- state migrations ---------------------------------------------------

   	/** The br_id -> job_id sweep (spec 2026-09-04, PR 1): has this home been moved? */
   	#migrations(): DoctorFinding[] {
   		return [jobIdMigrationFinding(this.#options.home)];
   	}
   ```

- [ ] **Step 4: Regenerate the golden and run the suite**

Run: `CP_UPDATE_GOLDEN=1 node --test tests/doctor.test.ts` then `git diff tests/golden/doctor-broken.txt`.
Expected: the diff adds exactly one line `✓ [state.job_id_migration] no state files carry the pre-rename br_id key` and bumps the header count from `17 ok` to `18 ok`. Nothing else changes. (`tests/harness/golden.ts` reads `CP_UPDATE_GOLDEN=1` as its rewrite switch.)

Run: `node --test tests/doctor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts tests/golden/doctor-broken.txt
git commit -m "feat(doctor): state.job_id_migration reports a home the rename sweep has not moved

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The mechanical rename

**Files:**
- Modify: every tracked file under `src/`, `extensions/`, `tests/`, `scripts/`, `prompts/`, `profiles/`, `skills/`, plus `AGENTS.md`, `README.md`, `docs/contracts.md`, `docs/parity.md`.
- Not modified: `PLAN.md`, `docs/build-history.md`, `docs/spikes/**`, `docs/superpowers/**`, `package.json`, `package-lock.json`, anything untracked (`.beads/`, `data/`, `state/`, `projects/`).

**Interfaces:**
- Produces: `JOB_ID_PATTERN`, `JobIdSchema`, `isSafeJobId`, `requireJobId`, `DOCTOR_PROBE_JOB_ID`, `CP_JOB_ID`, and `job_id`/`jobId` everywhere. The `BRIEF_PLACEHOLDERS` entry becomes `"job_id"` and every brief template's `${br_id}` becomes `${job_id}` in the same pass, so templates and validator stay in step.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npm test`
Expected: PASS (suites that need `br`/`treehouse` self-skip if those are not on PATH; that is fine).

- [ ] **Step 2: Apply the rename**

```bash
FILES=$(git ls-files src extensions tests scripts prompts profiles skills AGENTS.md README.md docs/contracts.md docs/parity.md)
perl -pi -e '
  s/\bbr_id\b/job_id/g;
  s/\bbrId\b/jobId/g;
  s/BrId/JobId/g;
  s/BR_ID/JOB_ID/g;
  s/<br-id>/<job-id>/g;
  s/\bbr-id\b/job-id/g;
  s/\bbr issue id\b/job id/g;
  s/\bbr ids\b/job ids/g;
  s/\bbr id\b/job id/g;
' $FILES
```

What each pattern catches: `br_id` fields, params and template placeholders; `brId` variables; `BrId` inside `BrIdSchema`/`isSafeBrId`/`requireBrId`; `BR_ID` inside `BR_ID_PATTERN`/`CP_BR_ID`/`DOCTOR_PROBE_BR_ID`; `<br-id>` and `br-id` in paths and prose; the three prose spellings.

- [ ] **Step 3: Check for leftovers and fix the handful by hand**

```bash
grep -rnE 'br_id|brId|br-id|BrId|BR_ID' $FILES && echo "LEFTOVERS" || echo "clean"
grep -rnE '\bbr id\b|\bbr ids\b' $FILES && echo "PROSE LEFTOVERS" || echo "clean"
```

Expected: both `clean`. If a line survives (a spelling the patterns miss, e.g. `br's id`), edit it by hand to `job id`.

- [ ] **Step 4: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS. The goldens under `tests/golden/` were renamed by the same pass, so rendered `job_id` keys match them. If a golden fails, inspect with `git diff tests/golden/` after `CP_UPDATE_GOLDEN=1 node --test <that suite>` and confirm the only differences are `br_id` → `job_id`.

- [ ] **Step 5: Confirm the worker side agrees**

```bash
grep -n 'CP_JOB_ID' extensions/worker-reporter/index.ts src/worker-manager.ts
grep -n 'job_id' prompts/briefs/brief-ship.md src/contracts.ts | head
```

Expected: `worker-manager.ts` sets `env.CP_JOB_ID`, `worker-reporter/index.ts` reads `env.CP_JOB_ID`, the brief templates say `job_id: "${job_id}"`, and `BRIEF_PLACEHOLDERS` lists `"job_id"`.

- [ ] **Step 6: Commit**

```bash
git add -A src extensions tests scripts prompts profiles skills AGENTS.md README.md docs/contracts.md docs/parity.md
git commit -m "refactor: rename br_id to job_id everywhere (code, tests, templates, docs)

Mechanical: br_id/brId/BrId/BR_ID/br-id and the prose spellings. No
behaviour change; br remains the backend. CP_BR_ID is now CP_JOB_ID.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Wire the sweep into `session_start`

**Files:**
- Modify: `extensions/command-post/index.ts:1521-1580` (inside the `session_start` handler, after the parent-lock block)
- Modify: `tests/extension-load.test.ts`

**Interfaces:**
- Consumes: `sweepJobIdRename`, `formatSweep` from Task 1.

- [ ] **Step 1: Write the failing test**

In `tests/extension-load.test.ts`, inside the existing test that starts a pi child on a scratch home and runs `/cp-version` (the one at lines 30-80), seed a legacy fleet file **before** `startRpc` is called, and assert after the `/cp-version` response:

```ts
	// Spec 2026-09-04 PR 1: the rename sweep runs at session start, after the
	// parent lock and before anything reads state/.
	mkdirSync(join(home.path, "state"), { recursive: true });
	writeFileSync(
		join(home.path, "state/fleet.json"),
		JSON.stringify({ schema_version: 1, updated_at: "2026-09-01T00:00:00Z", jobs: [{ br_id: "cp-legacy" }] }),
	);
```

and after `assert.equal(promptResponse.success, true);`:

```ts
	const swept = readFileSync(join(home.path, "state/fleet.json"), "utf8");
	assert.ok(swept.includes('"job_id"'), `fleet.json was not swept: ${swept}`);
	assert.ok(!swept.includes('"br_id"'));
	assert.ok(existsSync(join(home.path, "state/.migrations/2026-09-job-id.done")), "the sweep marker was not written");
```

Add `existsSync`, `mkdirSync`, `readFileSync`, `writeFileSync` to the `node:fs` import and `join` to the `node:path` import if they are not already there.

Note: the seeded fleet record is deliberately not a valid `FleetRecord`; reconcile will report it as unreadable **after** the sweep. That is fine for this test — the assertion is about the sweep, and `/cp-version` does not read the fleet. If reconcile's notify makes `waitFor` pick the wrong message, keep the existing `startsWith(identity.name)` predicate, which already filters it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/extension-load.test.ts`
Expected: FAIL — `fleet.json was not swept`.

- [ ] **Step 3: Wire the sweep**

In `extensions/command-post/index.ts`:

1. Import, next to the other `../../src/` imports:
   ```ts
   import { formatSweep, sweepJobIdRename } from "../../src/state-migrations.ts";
   ```
2. Inside the `session_start` handler, immediately after the parent-lock `if (!parentLock) { ... }` block and **before** `awaitingSnoozed = new Set<string>();`, add:
   ```ts
   		// Spec 2026-09-04 PR 1: move pre-rename state files once, under the lock
   		// (no other parent can be writing) and before anything below reads them.
   		try {
   			const sweep = sweepJobIdRename({ home });
   			const text = formatSweep(sweep);
   			if (text.length > 0) {
   				if (ctx.hasUI) ctx.ui.notify(text, "info");
   				else process.stderr.write(`${text}\n`);
   			}
   		} catch (error) {
   			const message = `pi-command-post: state migration failed for ${home}: ${(error as Error).message}`;
   			if (ctx.hasUI) ctx.ui.notify(message, "error");
   			else process.stderr.write(`${message}\n`);
   		}
   ```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/extension-load.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/command-post/index.ts tests/extension-load.test.ts
git commit -m "feat(session): run the br_id -> job_id state sweep once at session start

After the parent lock, before any read of state/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Document the rename and the sweep

**Files:**
- Modify: `docs/contracts.md` (§Identifiers and timestamps, and the TOC)

- [ ] **Step 1: Add the subsection**

At the end of `## Identifiers and timestamps` in `docs/contracts.md`, add:

```markdown
### Job id (renamed from br id, 2026-09)

The identifier of a job was called `br_id` after the tool that minted it. It is
now `job_id` everywhere: schema fields, tool parameters, the `${job_id}` brief
placeholder, the worker's `CP_JOB_ID` environment variable, and prose. The
value and the pattern are unchanged (`JOB_ID_PATTERN`, `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`),
so every existing id, branch and run directory is still valid.

Files written before the rename are moved once, by
[`src/state-migrations.ts`](../src/state-migrations.ts), at `session_start`,
after the parent lock is taken and before anything reads `state/`:

- every `*.json` under `state/` is parsed, the key `br_id` is renamed to
  `job_id` wherever it appears as an object key (values are never touched),
  and the file is rewritten atomically; a document that does not parse is
  reported and left alone;
- every `*.jsonl` journal is rewritten line by line the same way; a line that
  does not parse is copied byte for byte;
- `state/sessions/` (pi's transcripts), files with `.bak` in the name and
  every non-JSON file are skipped;
- `state/.migrations/2026-09-job-id.done` is written at the end, and its
  presence makes every later start a no-op.

`/doctor` reports `state.job_id_migration`: an **error** when files still
carry `br_id` and the marker is absent (the fix is to start a session), a
**warning** when the marker exists but a file carries the key anyway (a
restore from backup), and ok otherwise.
```

Add the TOC entry under `- [Identifiers and timestamps](#identifiers-and-timestamps)`:

```markdown
  - [Job id (renamed from br id)](#job-id-renamed-from-br-id-2026-09)
```

- [ ] **Step 2: Commit**

```bash
git add docs/contracts.md
git commit -m "docs(contracts): the job id rename and the one-shot state sweep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Verify on the live home, then open the PR

**Files:** none (operator verification).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Start one real session on this checkout**

In a terminal at the repo root: `pi -e extensions/command-post/index.ts`, then in the session run `/doctor` and `/status`.
Expected: a one-line `state migration: renamed br_id -> job_id in N document(s) and M journal(s)` notice at start; `/doctor` shows `✓ [state.job_id_migration]`; `/status` renders every job as before. Check `ls state/.migrations/` shows `2026-09-job-id.done`.

- [ ] **Step 3: Confirm the sweep left nothing behind**

```bash
grep -rl '"br_id"' state --include='*.json' --include='*.jsonl' | grep -v '^state/sessions/' | grep -v '\.bak' || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "refactor: rename br_id to job_id, with a one-shot state sweep" --body "$(cat <<'EOF'
PR 1 of docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md.

- Mechanical rename br_id/brId/BrId/BR_ID/br-id -> job_id across code, tests, templates and docs. No behaviour change; br remains the backend.
- New src/state-migrations.ts: sweeps state/ once at session start (documents deep-renamed, journals line by line, malformed lines copied verbatim, sessions/ and .bak skipped, marker under state/.migrations).
- Doctor check state.job_id_migration.
- CP_BR_ID -> CP_JOB_ID for workers.

Verified on the live home: sweep notice at start, /doctor green, /status renders.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
