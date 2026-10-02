# Single-project mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pi session launched inside any git repository run the whole command post (dispatch, envelopes, gates, checkpoints, ledger, doctor, memory) for that one repository, with its state under `<repo>/.pi-command-post/` and the repository itself untouched, while the multi-project home behaves exactly as today.

**Architecture:** A new `src/mode.ts` resolves a frozen `Runtime` (`mode`, `home`, `source`, `reason`, `repo?`) first thing at session start from `CP_MODE`, then `.pi-command-post/settings.json`, then a repo-aware default. `configureLayout(mode)` in `src/contracts.ts` fixes `LAYOUT`, `paths` and `NEVER_COMMIT_PATHS` for the process (single mode moves `data/` and `state/` under the dotdir). The project registry gets a pinned, virtual project; the parent's contract is injected through `before_agent_start` when pi did not load it; `/cp-mode` saves a preference that applies at the next start. Assumes item 1 has landed (both PRs): ids are `job_id`, the ledger is `<home>/.pi-command-post/jobs.json`, `cp_job` and `extensions/command-post/jobs.ts` exist.

**Tech Stack:** TypeScript (ES2023, `nodenext`, strict), Node 24, `node --test`, typebox, pi extension API (`before_agent_start`, `registerCommand`).

**Spec:** `docs/superpowers/specs/2026-09-04-single-project-mode-design.md`

## Global Constraints

- Precedence: `CP_MODE` (`single|multi|auto`; any other value ends startup with a named fix) → `<toplevel-or-cwd>/.pi-command-post/settings.json` field `mode` (unparseable or unknown value is reported and ignored) → repo-aware default (`CP_HOME` set / inside this source checkout / directory already has `projects/` and `state/` → multi; inside a git repository → single on its toplevel; else multi on today's default home).
- Two refusals end startup: single mode forced where there is no git repository; single mode where the toplevel also holds `projects/` and `state/`.
- Single layout: `data` → `.pi-command-post/data`, `state` → `.pi-command-post/state`, `projects` → `.pi-command-post/projects` (never created), `jobsFile` unchanged at `.pi-command-post/jobs.json`, `NEVER_COMMIT_PATHS` → `[".pi-command-post/"]`. Multi layout is byte-identical to today.
- `configureLayout(mode)` is called once per process; a second call with a different mode throws `ContractError`. `node --test` runs each suite file in its own process, so a suite that configures `single` lives in its own file.
- The repository is never edited: single-mode scaffold appends `.pi-command-post/` to `.git/info/exclude`; the repository's `.gitignore` is not touched.
- The pinned project: `name` = toplevel basename with every character outside `[A-Za-z0-9_-]` replaced by `-`, prefixed with `p` if it does not start with an alphanumeric, truncated to 64; `clone_url` = origin url or the toplevel path; `path` = toplevel; `delivery` = `pr` with an origin, `local` without; `base_branch` = `origin/HEAD` minus `origin/`, else `main`. Never written to `data/projects.json`.
- `project` is optional on `cp_job create`, `cp_ask`, `/cp-ask`, `cp_pipeline start`, `cp_check` in single mode (defaults to the pinned name; another name is refused with `single-project mode: this session manages <name> only`); multi mode keeps today's requirements.
- Contract injection returns `undefined` when `systemPromptOptions.contextFiles` already contains `<packageRoot>/AGENTS.md`.
- No worker-side change. No new npm dependency. Every commit passes `npm run typecheck`; the PR passes `npm test`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Goldens regenerate with `CP_UPDATE_GOLDEN=1`.

## File structure

| file | responsibility |
|---|---|
| `src/contracts.ts` | `MODES`, `ModeSchema`, `MODE_SETTINGS`, `ModeSettingsSchema`, `validateModeSettings`, `RuntimeSchema`, `validateRuntime`, `ENV_MODE`, `Layout` type, `layoutFor`, `configureLayout`, `currentLayoutMode`; `LAYOUT` and `NEVER_COMMIT_PATHS` become configurable products. |
| `src/mode.ts` (new) | `ModeError`, `resolveRuntime`, `readModeSettings`/`writeModeSettings`/`settingsPath`, `gitToplevel`, `isMultiHomeDir`, `sanitizeProjectName`, `repoRecord`, `describeRuntime`, `pinnedProject`, `resolveProjectArg`, `contractInjection`. Pure over injected `git`/fs; no pi imports. |
| `src/projects.ts` | `pinned?: Project` option; virtual read; write refusals; `assertCanonicalRepo(path)`. |
| `src/scaffold.ts` | `mode` option; single-mode steps; `exclude` step; fixed step names. |
| `src/doctor.ts` | `runtime` option; `mode`, `home.exclude`, `home.overlap`, `project.canonical` findings; mode-aware scaffold dirs. |
| `extensions/command-post/mode-command.ts` (new) | `/cp-mode`: parse, show, set, refusal. |
| `extensions/command-post/jobs.ts` | `resolveProject` port for `cp_job create`. |
| `extensions/command-post/index.ts` | `currentRuntime()`, session-start ordering, `before_agent_start`, `/cp-version` line, `project` optional on `cp_ask`/`/cp-ask`/`cp_pipeline start`/`cp_check`, registrations. |
| `src/command-post.ts` | `runtime?: Runtime` option → pinned registry, doctor runtime. |
| tests | `tests/mode.test.ts`, `tests/layout-single.test.ts`, `tests/contract-injection.test.ts`, `tests/mode-command.test.ts`, `tests/e2e/single-mode.test.ts` (new); `tests/contracts.test.ts`, `tests/projects.test.ts`, `tests/scaffold.test.ts`, `tests/doctor.test.ts`, `tests/jobs-tool.test.ts`, `tests/extension-load.test.ts` (modified). |
| docs | `README.md`, `AGENTS.md`, `docs/contracts.md`. |

---

### Task 1: Contracts — modes, settings, runtime, and the configurable layout

**Files:**
- Modify: `src/contracts.ts` (the `LAYOUT` block near line 3327, `NEVER_COMMIT_PATHS` near 3366; new section before `// Validation`)
- Test: `tests/contracts.test.ts` (multi values unchanged), `tests/layout-single.test.ts` (new; configures single)

**Interfaces:**
- Produces:
  ```ts
  export const MODES = ["multi", "single"] as const; export type Mode; export const ModeSchema;
  export const MODE_SETTINGS = ["single", "multi", "auto"] as const; export type ModeSetting; export const ModeSettingSchema;
  export const ENV_MODE = "CP_MODE";
  export const ModeSettingsSchema; export type ModeSettings = { schema_version: number; mode: ModeSetting }; export function validateModeSettings(value): ValidationResult<ModeSettings>;
  export const RUNTIME_SOURCES = ["CP_MODE","settings","CP_HOME","checkout","home-dir","repo","managed"] as const; export type RuntimeSource;
  export const RuntimeRepoSchema; export type RuntimeRepo = { toplevel: string; name: string; origin_url?: string; default_branch: string };
  export const RuntimeSchema; export type Runtime = { mode: Mode; home: string; source: RuntimeSource; reason: string; repo?: RuntimeRepo }; export function validateRuntime(value): ValidationResult<Runtime>;
  export interface Layout { data; state; projects; runs; artifacts; pipelines; checkpoints; fleetFile; awaitingFile; answeredFile; ciWatchFile; shippedSeenFile; parentLock; migrationsDir; runtimeDir; jobsFile; routingFile; projectsFile; projectsView; budgetsFile; gateConfigFile; suggestFile; learningsFile; candidatesFile; archiveFile; curationLog }  // all string
  export function layoutFor(mode: Mode): Layout;
  export function neverCommitFor(mode: Mode): string[];
  export const LAYOUT: Layout;                       // multi values until configured
  export const NEVER_COMMIT_PATHS: string[];         // multi values until configured
  export function configureLayout(mode: Mode): Layout;   // once; different mode throws ContractError
  export function currentLayoutMode(): Mode | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/contracts.test.ts` (add `configureLayout`, `currentLayoutMode`, `layoutFor`, `neverCommitFor`, `MODES`, `MODE_SETTINGS`, `validateModeSettings`, `validateRuntime`, `LAYOUT`, `NEVER_COMMIT_PATHS` to the import if missing):

```ts
// ---------------------------------------------------------------------------
// Modes and the configurable layout (spec 2026-09-04 single-project mode)
// ---------------------------------------------------------------------------

test("the multi layout is exactly today's constants, before and after configuration", () => {
	const expected = {
		data: "data",
		state: "state",
		projects: "projects",
		runs: "state/runs",
		artifacts: "state/artifacts",
		pipelines: "state/pipelines",
		checkpoints: "state/checkpoints",
		fleetFile: "state/fleet.json",
		awaitingFile: "state/awaiting.json",
		answeredFile: "state/answered.json",
		ciWatchFile: "state/ci-watch.json",
		shippedSeenFile: "state/status-block-shipped.json",
		parentLock: "state/parent.lock",
		migrationsDir: "state/.migrations",
		runtimeDir: ".pi-command-post",
		jobsFile: ".pi-command-post/jobs.json",
		routingFile: "data/routing.json",
		projectsFile: "data/projects.json",
		projectsView: "data/projects.md",
		budgetsFile: "data/budgets.json",
		gateConfigFile: "data/gate.json",
		suggestFile: "data/suggest.json",
		learningsFile: "data/learnings.md",
		candidatesFile: "data/candidates.md",
		archiveFile: "data/archive.md",
		curationLog: "data/curation.jsonl",
	};
	assert.deepEqual({ ...LAYOUT }, expected, "unconfigured LAYOUT is the multi layout");
	assert.deepEqual(layoutFor("multi"), expected);
	assert.deepEqual([...NEVER_COMMIT_PATHS], ["data/", "state/", "projects/", ".beads/", ".pi-command-post/"]);
	assert.equal(currentLayoutMode(), undefined);

	configureLayout("multi");
	assert.equal(currentLayoutMode(), "multi");
	assert.deepEqual({ ...LAYOUT }, expected, "configuring multi changes nothing");
	assert.ok(Object.isFrozen(LAYOUT));
	configureLayout("multi"); // same mode again: fine
	assert.throws(() => configureLayout("single"), /layout already configured for multi/);
});

test("layoutFor(single) puts data and state under the dotdir and keeps the ledger path", () => {
	const single = layoutFor("single");
	assert.equal(single.runtimeDir, ".pi-command-post");
	assert.equal(single.jobsFile, ".pi-command-post/jobs.json");
	assert.equal(single.data, ".pi-command-post/data");
	assert.equal(single.state, ".pi-command-post/state");
	assert.equal(single.projects, ".pi-command-post/projects");
	assert.equal(single.runs, ".pi-command-post/state/runs");
	assert.equal(single.fleetFile, ".pi-command-post/state/fleet.json");
	assert.equal(single.migrationsDir, ".pi-command-post/state/.migrations");
	assert.equal(single.routingFile, ".pi-command-post/data/routing.json");
	assert.equal(single.learningsFile, ".pi-command-post/data/learnings.md");
	assert.deepEqual(neverCommitFor("single"), [".pi-command-post/"]);
	// Every key of the multi layout exists in the single layout, and nothing else.
	assert.deepEqual(Object.keys(single).sort(), Object.keys(layoutFor("multi")).sort());
});

test("mode settings and runtime records validate", () => {
	assert.deepEqual([...MODES], ["multi", "single"]);
	assert.deepEqual([...MODE_SETTINGS], ["single", "multi", "auto"]);
	assert.equal(validateModeSettings({ schema_version: 1, mode: "auto" }).ok, true);
	assert.equal(validateModeSettings({ schema_version: 1, mode: "both" }).ok, false);
	assert.equal(validateModeSettings({ mode: "single" }).ok, false, "schema_version is required");
	assert.equal(
		validateRuntime({ mode: "multi", home: "/h", source: "checkout", reason: "r" }).ok,
		true,
	);
	assert.equal(
		validateRuntime({
			mode: "single",
			home: "/r",
			source: "repo",
			reason: "r",
			repo: { toplevel: "/r", name: "r", origin_url: "git@x:y.git", default_branch: "main" },
		}).ok,
		true,
	);
	assert.equal(validateRuntime({ mode: "single", home: "/r", source: "repo", reason: "r", repo: { toplevel: "/r", name: "bad.name", default_branch: "main" } }).ok, false);
});
```

Create `tests/layout-single.test.ts` (its own process, so it may configure `single`):

```ts
/**
 * The single layout, configured for real. Lives in its own file because
 * `configureLayout` is process-global: `node --test` runs each suite in its
 * own process, so this is the one process that ever sees single.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { configureLayout, currentLayoutMode, LAYOUT, NEVER_COMMIT_PATHS, paths } from "../src/contracts.ts";

test("configureLayout(single) rewrites LAYOUT, NEVER_COMMIT_PATHS and every paths.* helper", () => {
	configureLayout("single");
	assert.equal(currentLayoutMode(), "single");
	assert.equal(LAYOUT.state, ".pi-command-post/state");
	assert.equal(LAYOUT.data, ".pi-command-post/data");
	assert.deepEqual([...NEVER_COMMIT_PATHS], [".pi-command-post/"]);
	assert.ok(Object.isFrozen(NEVER_COMMIT_PATHS));
	assert.equal(paths.runDir("cp-a1b2"), ".pi-command-post/state/runs/cp-a1b2");
	assert.equal(paths.artifactDir("cp-a1b2"), ".pi-command-post/state/artifacts/cp-a1b2");
	assert.equal(paths.checkpointFile("cp-a1b2"), ".pi-command-post/state/checkpoints/cp-a1b2.json");
	assert.equal(paths.projectDir("demo"), ".pi-command-post/projects/demo");
	assert.throws(() => configureLayout("multi"), /layout already configured for single/);
	configureLayout("single"); // idempotent
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/contracts.test.ts tests/layout-single.test.ts`
Expected: FAIL — `configureLayout` is not exported.

- [ ] **Step 3: Make the layout configurable**

In `src/contracts.ts`, replace the `export const LAYOUT = Object.freeze({ … })` block and `NEVER_COMMIT_PATHS` with:

```ts
// ---------------------------------------------------------------------------
// Modes (spec 2026-09-04 single-project mode)
// ---------------------------------------------------------------------------

export const MODES = ["multi", "single"] as const;
export type Mode = (typeof MODES)[number];
export const ModeSchema = StringEnum([...MODES]);

/** What an operator may write: `auto` means "use the repo-aware default". */
export const MODE_SETTINGS = ["single", "multi", "auto"] as const;
export type ModeSetting = (typeof MODE_SETTINGS)[number];
export const ModeSettingSchema = StringEnum([...MODE_SETTINGS]);

/** Wins over the settings file and the default. `single|multi|auto`. */
export const ENV_MODE = "CP_MODE";

export const ModeSettingsSchema = Type.Object(
	{ schema_version: Type.Integer({ minimum: 1 }), mode: ModeSettingSchema },
	{ additionalProperties: false },
);
export type ModeSettings = Omit<Static<typeof ModeSettingsSchema>, "mode"> & { mode: ModeSetting };
export function validateModeSettings(value: unknown): ValidationResult<ModeSettings> {
	return validate<ModeSettings>(ModeSettingsSchema, value);
}

export const RUNTIME_SOURCES = ["CP_MODE", "settings", "CP_HOME", "checkout", "home-dir", "repo", "managed"] as const;
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number];

export const RuntimeRepoSchema = Type.Object(
	{
		toplevel: Type.String({ minLength: 1 }),
		name: Type.String({ pattern: PROJECT_NAME_PATTERN }),
		origin_url: Type.Optional(Type.String({ minLength: 1 })),
		default_branch: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type RuntimeRepo = Static<typeof RuntimeRepoSchema>;

export const RuntimeSchema = Type.Object(
	{
		mode: ModeSchema,
		home: Type.String({ minLength: 1 }),
		source: StringEnum([...RUNTIME_SOURCES]),
		reason: Type.String({ minLength: 1, maxLength: 1000 }),
		repo: Type.Optional(RuntimeRepoSchema),
	},
	{ additionalProperties: false },
);
export type Runtime = Omit<Static<typeof RuntimeSchema>, "mode" | "source"> & { mode: Mode; source: RuntimeSource };
export function validateRuntime(value: unknown): ValidationResult<Runtime> {
	return validate<Runtime>(RuntimeSchema, value);
}

// ---------------------------------------------------------------------------
// Layout — relative to the home; configured once per process
// ---------------------------------------------------------------------------

export interface Layout {
	data: string;
	state: string;
	projects: string;
	runs: string;
	artifacts: string;
	pipelines: string;
	checkpoints: string;
	fleetFile: string;
	awaitingFile: string;
	answeredFile: string;
	ciWatchFile: string;
	shippedSeenFile: string;
	parentLock: string;
	migrationsDir: string;
	runtimeDir: string;
	jobsFile: string;
	routingFile: string;
	projectsFile: string;
	projectsView: string;
	budgetsFile: string;
	gateConfigFile: string;
	suggestFile: string;
	learningsFile: string;
	candidatesFile: string;
	archiveFile: string;
	curationLog: string;
}

const RUNTIME_DIR = ".pi-command-post";

/**
 * The layout for a mode. Multi is today's shape. Single moves `data/` and
 * `state/` under the runtime dotdir so a project repository gets one
 * directory to exclude and no clash with its own `data/` or `state/`; the
 * ledger path is the same in both (it was put in the dotdir for this reason).
 */
export function layoutFor(mode: Mode): Layout {
	const data = mode === "single" ? `${RUNTIME_DIR}/data` : "data";
	const state = mode === "single" ? `${RUNTIME_DIR}/state` : "state";
	const projects = mode === "single" ? `${RUNTIME_DIR}/projects` : "projects";
	return {
		data,
		state,
		projects,
		runs: `${state}/runs`,
		artifacts: `${state}/artifacts`,
		pipelines: `${state}/pipelines`,
		checkpoints: `${state}/checkpoints`,
		fleetFile: `${state}/fleet.json`,
		awaitingFile: `${state}/awaiting.json`,
		answeredFile: `${state}/answered.json`,
		ciWatchFile: `${state}/ci-watch.json`,
		shippedSeenFile: `${state}/status-block-shipped.json`,
		parentLock: `${state}/parent.lock`,
		migrationsDir: `${state}/.migrations`,
		runtimeDir: RUNTIME_DIR,
		jobsFile: `${RUNTIME_DIR}/jobs.json`,
		routingFile: `${data}/routing.json`,
		projectsFile: `${data}/projects.json`,
		projectsView: `${data}/projects.md`,
		budgetsFile: `${data}/budgets.json`,
		gateConfigFile: `${data}/gate.json`,
		suggestFile: `${data}/suggest.json`,
		learningsFile: `${data}/learnings.md`,
		candidatesFile: `${data}/candidates.md`,
		archiveFile: `${data}/archive.md`,
		curationLog: `${data}/curation.jsonl`,
	};
}

/** Paths that must never be committed or pushed (T19 guard), per mode. */
export function neverCommitFor(mode: Mode): string[] {
	return mode === "single" ? [`${RUNTIME_DIR}/`] : ["data/", "state/", "projects/", ".beads/", `${RUNTIME_DIR}/`];
}

/**
 * The live layout. Holds the multi values until `configureLayout` runs, so
 * every existing path and every multi-mode test is unchanged; `paths.*` read
 * it at call time. Frozen once configured.
 */
export const LAYOUT: Layout = layoutFor("multi");
export const NEVER_COMMIT_PATHS: string[] = neverCommitFor("multi");

let layoutMode: Mode | undefined;

/**
 * Fix the layout for this process. Idempotent for the same mode; a different
 * mode is refused, because half a process on one layout and half on another
 * is two homes in one directory.
 */
export function configureLayout(mode: Mode): Layout {
	if (layoutMode !== undefined) {
		if (layoutMode !== mode) {
			throw new ContractError(`layout already configured for ${layoutMode}; cannot switch to ${mode} in this process`);
		}
		return LAYOUT;
	}
	Object.assign(LAYOUT, layoutFor(mode));
	NEVER_COMMIT_PATHS.splice(0, NEVER_COMMIT_PATHS.length, ...neverCommitFor(mode));
	Object.freeze(LAYOUT);
	Object.freeze(NEVER_COMMIT_PATHS);
	layoutMode = mode;
	return LAYOUT;
}

export function currentLayoutMode(): Mode | undefined {
	return layoutMode;
}
```

Notes for the implementer: `PROJECT_NAME_PATTERN` (line ~2907) and `ContractError` (line ~3368) are declared elsewhere in the file; `RuntimeRepoSchema` is evaluated at module load, so place this block **after** `PROJECT_NAME_PATTERN`'s declaration (the old `LAYOUT` position, ~3327, satisfies that). `ContractError` is only referenced inside `configureLayout`, which runs later, so its position does not matter. `validate`/`ValidationResult` are hoisted function/type declarations. Delete the old `export const LAYOUT = Object.freeze({…})` and `export const NEVER_COMMIT_PATHS = Object.freeze([...])`. Any code that typed `NEVER_COMMIT_PATHS` as `readonly string[]` still compiles.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contracts.test.ts tests/layout-single.test.ts && npm run typecheck && npm test`
Expected: PASS (nothing else changes: unconfigured `LAYOUT` equals the old constant).

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts tests/contracts.test.ts tests/layout-single.test.ts
git commit -m "feat(contracts): modes, runtime and settings schemas; the layout is configured once per process

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `src/mode.ts` — resolve the runtime

**Files:**
- Create: `src/mode.ts`
- Create: `tests/mode.test.ts`

**Interfaces:**
- Consumes: `describeHome`, `isManagedInstall`, `PACKAGE_ROOT` from `src/home.ts`; `isInside`, `isSafeProjectName`, `isoTimestamp`, `LAYOUT.runtimeDir`, `MODE_SETTINGS`, `ENV_MODE`, `validateModeSettings`, `validateRuntime`, types from Task 1; `atomicWriteJson` from `src/json-store.ts`.
- Produces:
  ```ts
  export class ModeError extends Error {}
  export type GitRunner = (cwd: string, args: readonly string[]) => string | undefined;
  export const defaultGit: GitRunner;
  export interface ResolveRuntimeOptions { cwd: string; env?: NodeJS.ProcessEnv; packageRoot?: string; git?: GitRunner }
  export function settingsPath(dir: string): string
  export function readModeSettings(dir: string): { mode: ModeSetting } | { error: string } | undefined
  export function writeModeSettings(dir: string, mode: ModeSetting): string
  export function gitToplevel(cwd: string, git?: GitRunner): string | undefined
  export function isMultiHomeDir(dir: string): boolean
  export function sanitizeProjectName(basename: string): string
  export function repoRecord(toplevel: string, git?: GitRunner): RuntimeRepo
  export function resolveRuntime(options: ResolveRuntimeOptions): Runtime
  export function describeRuntime(runtime: Runtime): string
  export function pinnedProject(runtime: Runtime, now?: () => Date): Project | undefined
  export function resolveProjectArg(runtime: Runtime, given: string | undefined, what: string): string
  ```
  (`contractInjection` is added to this module in Task 6.)

- [ ] **Step 1: Write the failing tests**

Create `tests/mode.test.ts`:

```ts
/**
 * Mode resolution (spec 2026-09-04 single-project mode §Mode resolution). A
 * table of cases over an injected git runner and real scratch directories:
 * every row names the environment, the settings file, the directory shape and
 * the expected mode/home/source. Plus the two refusals and the helpers.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, type Runtime } from "../src/contracts.ts";
import {
	describeRuntime,
	type GitRunner,
	isMultiHomeDir,
	ModeError,
	pinnedProject,
	readModeSettings,
	repoRecord,
	resolveProjectArg,
	resolveRuntime,
	sanitizeProjectName,
	settingsPath,
	writeModeSettings,
} from "../src/mode.ts";

function scratch(prefix = "cp-mode-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A fake git: `toplevels` maps a cwd (or any of its descendants) to a repo toplevel. */
function fakeGit(toplevels: Record<string, string>, extras: { origin?: string; head?: string } = {}): GitRunner {
	return (cwd, args) => {
		const key = args.join(" ");
		if (key === "rev-parse --show-toplevel") {
			const hit = Object.keys(toplevels).find((root) => cwd === root || cwd.startsWith(`${root}/`));
			return hit ? toplevels[hit] : undefined;
		}
		if (key === "remote get-url origin") return extras.origin;
		if (key === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") return extras.head;
		return undefined;
	};
}

const PACKAGE_ROOT = scratch("cp-pkg-"); // stands in for the source checkout
const NO_GIT: GitRunner = () => undefined;

test("resolution table: environment, settings, directory shape -> mode, home, source", (t) => {
	const repo = scratch("cp-repo-");
	const nested = join(repo, "src", "deep");
	mkdirSync(nested, { recursive: true });
	const plain = scratch("cp-plain-");
	const home = scratch("cp-home-");
	mkdirSync(join(home, "projects"));
	mkdirSync(join(home, "state"));
	t.after(() => {
		for (const dir of [repo, plain, home]) rmSync(dir, { recursive: true, force: true });
	});
	const inRepo = fakeGit({ [repo]: repo }, { origin: "git@github.com:o/r.git", head: "origin/main" });

	const cases: Array<{ name: string; cwd: string; env?: NodeJS.ProcessEnv; git: GitRunner; mode: Runtime["mode"]; home: string; source: Runtime["source"] }> = [
		{ name: "inside the checkout", cwd: join(PACKAGE_ROOT, "src"), git: fakeGit({ [PACKAGE_ROOT]: PACKAGE_ROOT }), mode: "multi", home: PACKAGE_ROOT, source: "checkout" },
		{ name: "CP_HOME wins over a repo", cwd: repo, env: { CP_HOME: home }, git: inRepo, mode: "multi", home, source: "CP_HOME" },
		{ name: "an existing multi home dir", cwd: home, git: NO_GIT, mode: "multi", home, source: "home-dir" },
		{ name: "inside a repository, at the toplevel", cwd: repo, git: inRepo, mode: "single", home: repo, source: "repo" },
		{ name: "inside a repository, deep", cwd: nested, git: inRepo, mode: "single", home: repo, source: "repo" },
		{ name: "not a repo, not a home: today's default", cwd: plain, git: NO_GIT, mode: "multi", home: PACKAGE_ROOT, source: "checkout" },
		{ name: "CP_MODE=multi inside a repo", cwd: repo, env: { CP_MODE: "multi" }, git: inRepo, mode: "multi", home: PACKAGE_ROOT, source: "CP_MODE" },
		{ name: "CP_MODE=auto is the default", cwd: repo, env: { CP_MODE: "auto" }, git: inRepo, mode: "single", home: repo, source: "repo" },
	];
	for (const c of cases) {
		mkdirSync(join(PACKAGE_ROOT, "src"), { recursive: true });
		const runtime = resolveRuntime({ cwd: c.cwd, env: { ...c.env }, packageRoot: PACKAGE_ROOT, git: c.git });
		assert.equal(runtime.mode, c.mode, `${c.name}: mode`);
		assert.equal(runtime.home, c.home, `${c.name}: home`);
		assert.equal(runtime.source, c.source, `${c.name}: source`);
		assert.ok(runtime.reason.length > 0, `${c.name}: reason`);
		if (c.mode === "single") {
			assert.equal(runtime.repo?.toplevel, repo);
			assert.equal(runtime.repo?.origin_url, "git@github.com:o/r.git");
			assert.equal(runtime.repo?.default_branch, "main");
		} else {
			assert.equal(runtime.repo, undefined);
		}
	}
});

test("the settings file wins over the default and loses to CP_MODE; garbage is reported and ignored", (t) => {
	const repo = scratch("cp-repo-");
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const inRepo = fakeGit({ [repo]: repo });

	assert.equal(readModeSettings(repo), undefined);
	const file = writeModeSettings(repo, "multi");
	assert.equal(file, settingsPath(repo));
	assert.equal(file, join(repo, LAYOUT.runtimeDir, "settings.json"));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema_version: 1, mode: "multi" });
	assert.deepEqual(readModeSettings(repo), { mode: "multi" });

	mkdirSync(join(repo, "x"), { recursive: true });
	const forcedMulti = resolveRuntime({ cwd: join(repo, "x"), packageRoot: PACKAGE_ROOT, git: inRepo, env: {} });
	assert.equal(forcedMulti.mode, "multi");
	assert.equal(forcedMulti.source, "settings");

	const envWins = resolveRuntime({ cwd: repo, packageRoot: PACKAGE_ROOT, git: inRepo, env: { CP_MODE: "single" } });
	assert.equal(envWins.mode, "single");
	assert.equal(envWins.source, "CP_MODE");

	writeFileSync(file, "{not json");
	const garbage = readModeSettings(repo);
	assert.ok(garbage && "error" in garbage && /not JSON/.test(garbage.error));
	const fallback = resolveRuntime({ cwd: repo, packageRoot: PACKAGE_ROOT, git: inRepo, env: {} });
	assert.equal(fallback.mode, "single", "an unreadable settings file falls back to auto");
	assert.match(fallback.reason, /settings\.json ignored/);

	writeFileSync(file, JSON.stringify({ schema_version: 1, mode: "both" }));
	const unknown = readModeSettings(repo);
	assert.ok(unknown && "error" in unknown && /mode/.test(unknown.error));
});

test("refusals: an invalid CP_MODE, single with no repository, single in a multi home", (t) => {
	const plain = scratch("cp-plain-");
	const overlap = scratch("cp-overlap-");
	mkdirSync(join(overlap, "projects"));
	mkdirSync(join(overlap, "state"));
	t.after(() => {
		rmSync(plain, { recursive: true, force: true });
		rmSync(overlap, { recursive: true, force: true });
	});
	assert.throws(
		() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "dual" } }),
		(error: unknown) => error instanceof ModeError && /CP_MODE must be single, multi or auto/.test((error as Error).message),
	);
	assert.throws(
		() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: { CP_MODE: "single" } }),
		/single-project mode needs a git repository/,
	);
	writeModeSettings(plain, "single");
	assert.throws(() => resolveRuntime({ cwd: plain, packageRoot: PACKAGE_ROOT, git: NO_GIT, env: {} }), /needs a git repository/);

	const overlapGit = fakeGit({ [overlap]: overlap });
	assert.throws(
		() => resolveRuntime({ cwd: overlap, packageRoot: PACKAGE_ROOT, git: overlapGit, env: { CP_MODE: "single" } }),
		/this directory is a command-post home; single-project mode here would share its ledger/,
	);
	// auto in the same directory is multi (home-dir), not a refusal
	assert.equal(resolveRuntime({ cwd: overlap, packageRoot: PACKAGE_ROOT, git: overlapGit, env: {} }).source, "home-dir");
});

test("isMultiHomeDir needs both projects/ and state/", (t) => {
	const dir = scratch();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(isMultiHomeDir(dir), false);
	mkdirSync(join(dir, "state"));
	assert.equal(isMultiHomeDir(dir), false);
	mkdirSync(join(dir, "projects"));
	assert.equal(isMultiHomeDir(dir), true);
});

test("sanitizeProjectName makes a basename a legal project name", () => {
	assert.equal(sanitizeProjectName("my-repo"), "my-repo");
	assert.equal(sanitizeProjectName("my.repo"), "my-repo");
	assert.equal(sanitizeProjectName("Über Repo!"), "p-ber-Repo-", "non-alphanumerics become hyphens; a leading hyphen gets a p");
	assert.equal(sanitizeProjectName(".dotfiles"), "p-dotfiles");
	assert.equal(sanitizeProjectName("a".repeat(80)).length, 64);
	assert.throws(() => sanitizeProjectName(""), ModeError);
});

test("repoRecord reads origin and origin/HEAD, with the documented fallbacks", () => {
	const withRemote = repoRecord("/tmp/some.repo", fakeGit({}, { origin: "https://x/y.git", head: "origin/trunk" }));
	assert.deepEqual(withRemote, { toplevel: "/tmp/some.repo", name: "some-repo", origin_url: "https://x/y.git", default_branch: "trunk" });
	const local = repoRecord("/tmp/local", NO_GIT);
	assert.deepEqual(local, { toplevel: "/tmp/local", name: "local", default_branch: "main" });
});

test("pinnedProject, describeRuntime and resolveProjectArg follow the runtime", () => {
	const single: Runtime = {
		mode: "single",
		home: "/r",
		source: "repo",
		reason: "inside the git repository at /r",
		repo: { toplevel: "/r", name: "r", origin_url: "git@x:y.git", default_branch: "main" },
	};
	const local: Runtime = { ...single, repo: { toplevel: "/r", name: "r", default_branch: "main" } };
	const multi: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "checkout" };

	const pinned = pinnedProject(single, () => new Date("2026-09-04T10:00:00Z"));
	assert.deepEqual(pinned, { name: "r", clone_url: "git@x:y.git", path: "/r", delivery: "pr", registered_at: "2026-09-04T10:00:00Z", base_branch: "main" });
	assert.equal(pinnedProject(local)?.delivery, "local");
	assert.equal(pinnedProject(local)?.clone_url, "/r");
	assert.equal(pinnedProject(multi), undefined);

	assert.match(describeRuntime(single), /^single-project mode on \/r — project r \(source: repo; inside the git repository at \/r\)$/);
	assert.match(describeRuntime(multi), /^multi-project mode, home \/h \(source: checkout; checkout\)$/);

	assert.equal(resolveProjectArg(single, undefined, "cp_job create"), "r");
	assert.equal(resolveProjectArg(single, "r", "cp_job create"), "r");
	assert.throws(() => resolveProjectArg(single, "other", "cp_job create"), /single-project mode: this session manages r only/);
	assert.equal(resolveProjectArg(multi, "demo", "cp_job create"), "demo");
	assert.throws(() => resolveProjectArg(multi, undefined, "cp_job create"), /cp_job create needs `project`/);
});

test("gitToplevel against a real repository resolves symlinks and returns undefined outside one", (t) => {
	const dir = scratch("cp-real-");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	mkdirSync(join(dir, "a", "b"), { recursive: true });
	assert.equal(gitToplevel(join(dir, "a", "b")), dir);
	const outside = scratch("cp-outside-");
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	assert.equal(gitToplevel(outside), undefined);
});
```

(`gitToplevel` is in the static import list at the top of the file: add it to the `../src/mode.ts` import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/mode.test.ts`
Expected: FAIL — `Cannot find module '../src/mode.ts'`.

- [ ] **Step 3: Write `src/mode.ts`**

```ts
/**
 * Modes (spec 2026-09-04 single-project mode).
 *
 * A session is either a **multi-project** command post (today's shape: a
 * home with `projects/<name>` clones) or a **single-project** one (the git
 * repository the session was launched in is the home and the only project).
 * `resolveRuntime` decides which, once, before anything reads a path:
 *
 *   1. `CP_MODE` (`single|multi|auto`) — any other value ends startup;
 *   2. `<toplevel-or-cwd>/.pi-command-post/settings.json` `{ mode }` — what
 *      `/cp-mode` writes; garbage is reported and ignored;
 *   3. the repo-aware default: `CP_HOME`, the source checkout, or an existing
 *      multi home give multi; a git repository gives single; else multi on
 *      today's default home.
 *
 * Two refusals: single mode with no repository, and single mode where the
 * toplevel is also a multi home (two layouts would share one ledger while
 * keeping two fleets and two parent locks).
 *
 * Everything here is pure over an injected `git` runner and the filesystem;
 * nothing imports pi.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	ENV_MODE,
	isInside,
	isoTimestamp,
	isSafeProjectName,
	LAYOUT,
	MODE_SETTINGS,
	type ModeSetting,
	PROJECT_NAME_PATTERN,
	type Project,
	type Runtime,
	type RuntimeRepo,
	type RuntimeSource,
	SCHEMA_VERSION,
	validateModeSettings,
	validateRuntime,
} from "./contracts.ts";
import { describeHome, isManagedInstall, PACKAGE_ROOT } from "./home.ts";
import { atomicWriteJson } from "./json-store.ts";

export class ModeError extends Error {}

export type GitRunner = (cwd: string, args: readonly string[]) => string | undefined;

/** Real git, quiet: a failure (not a repo, no remote) is `undefined`, never a throw. */
export const defaultGit: GitRunner = (cwd, args) => {
	try {
		const out = execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
};

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/** `<dir>/.pi-command-post/settings.json` — the same dotdir in both modes. */
export function settingsPath(dir: string): string {
	return join(dir, LAYOUT.runtimeDir, "settings.json");
}

export function readModeSettings(dir: string): { mode: ModeSetting } | { error: string } | undefined {
	const file = settingsPath(dir);
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { error: `${file} is not JSON (${(error as Error).message})` };
	}
	const result = validateModeSettings(parsed);
	if (!result.ok) return { error: `${file}: ${result.errors.join("; ")} (mode must be ${MODE_SETTINGS.join("|")})` };
	return { mode: result.value.mode };
}

export function writeModeSettings(dir: string, mode: ModeSetting): string {
	if (!(MODE_SETTINGS as readonly string[]).includes(mode)) throw new ModeError(`mode must be ${MODE_SETTINGS.join("|")}, got ${JSON.stringify(mode)}`);
	const file = settingsPath(dir);
	atomicWriteJson(file, { schema_version: SCHEMA_VERSION, mode });
	return file;
}

// ---------------------------------------------------------------------------
// Repository facts
// ---------------------------------------------------------------------------

export function gitToplevel(cwd: string, git: GitRunner = defaultGit): string | undefined {
	if (!existsSync(cwd)) return undefined;
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	return top ? realpathOrSelf(top) : undefined;
}

/** A multi home has `projects/` and `state/`; nothing else is taken as evidence. */
export function isMultiHomeDir(dir: string): boolean {
	return existsSync(join(dir, "projects")) && existsSync(join(dir, "state"));
}

/** A directory basename as a project name: `[A-Za-z0-9_-]`, alphanumeric first, at most 64. */
export function sanitizeProjectName(name: string): string {
	if (name.length === 0) throw new ModeError("cannot derive a project name from an empty directory name");
	let out = name.replace(/[^A-Za-z0-9_-]/g, "-");
	if (!/^[A-Za-z0-9]/.test(out)) out = `p${out}`;
	out = out.slice(0, 64);
	if (!isSafeProjectName(out)) throw new ModeError(`cannot derive a project name from ${JSON.stringify(name)} (must match ${PROJECT_NAME_PATTERN})`);
	return out;
}

export function repoRecord(toplevel: string, git: GitRunner = defaultGit): RuntimeRepo {
	const origin = git(toplevel, ["remote", "get-url", "origin"]);
	const head = git(toplevel, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	return {
		toplevel,
		name: sanitizeProjectName(basename(toplevel)),
		...(origin ? { origin_url: origin } : {}),
		default_branch: head?.startsWith("origin/") ? head.slice("origin/".length) : "main",
	};
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveRuntimeOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	packageRoot?: string;
	git?: GitRunner;
}

function finish(runtime: Runtime): Runtime {
	const result = validateRuntime(runtime);
	if (!result.ok) throw new ModeError(`internal: runtime record invalid: ${result.errors.join("; ")}`);
	return Object.freeze(result.value);
}

function single(toplevel: string, source: RuntimeSource, reason: string, git: GitRunner): Runtime {
	if (isMultiHomeDir(toplevel)) {
		throw new ModeError(
			"this directory is a command-post home; single-project mode here would share its ledger — run multi mode here (`/cp-mode multi`) or launch from a project repository",
		);
	}
	return finish({ mode: "single", home: toplevel, source, reason, repo: repoRecord(toplevel, git) });
}

function multi(home: string, source: RuntimeSource, reason: string): Runtime {
	return finish({ mode: "multi", home: resolve(home), source, reason });
}

export function resolveRuntime(options: ResolveRuntimeOptions): Runtime {
	const env = options.env ?? process.env;
	const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT);
	const git = options.git ?? defaultGit;
	const cwd = realpathOrSelf(resolve(options.cwd));
	const toplevel = gitToplevel(cwd, git);
	const anchor = toplevel ?? cwd;

	// 1. CP_MODE
	const envMode = (env[ENV_MODE] ?? "").trim();
	let forced: ModeSetting | undefined;
	let source: RuntimeSource | undefined;
	if (envMode.length > 0) {
		if (!(MODE_SETTINGS as readonly string[]).includes(envMode)) {
			throw new ModeError(`${ENV_MODE} must be single, multi or auto, got ${JSON.stringify(envMode)}`);
		}
		if (envMode !== "auto") {
			forced = envMode as ModeSetting;
			source = "CP_MODE";
		}
	}

	// 2. settings.json in the launch directory's toplevel (or the directory itself)
	let note = "";
	if (!forced) {
		const settings = readModeSettings(anchor);
		if (settings && "error" in settings) note = ` (settings.json ignored: ${settings.error})`;
		else if (settings && settings.mode !== "auto") {
			forced = settings.mode;
			source = "settings";
		}
	}

	if (forced === "single") {
		if (!toplevel) throw new ModeError("single-project mode needs a git repository; run from inside one or set CP_MODE=multi");
		return single(toplevel, source as RuntimeSource, `${source === "CP_MODE" ? ENV_MODE : "settings.json"} says single; the repository at ${toplevel} is the home`, git);
	}
	if (forced === "multi") {
		const fallback = env.CP_HOME && env.CP_HOME.length > 0 ? { home: env.CP_HOME, reason: "CP_HOME" } : describeHome(env, packageRoot);
		return multi(fallback.home, source as RuntimeSource, `${source === "CP_MODE" ? ENV_MODE : "settings.json"} says multi; home ${resolve(fallback.home)} (${fallback.reason})`);
	}

	// 3. auto
	if (env.CP_HOME && env.CP_HOME.length > 0) return multi(env.CP_HOME, "CP_HOME", `CP_HOME is set; it wins over every default${note}`);
	if (!isManagedInstall(packageRoot) && isInside(cwd, packageRoot)) {
		return multi(packageRoot, "checkout", `running inside the source checkout; the package root is the home${note}`);
	}
	if (isMultiHomeDir(cwd)) return multi(cwd, "home-dir", `this directory is already a command-post home (projects/ and state/)${note}`);
	if (toplevel) return single(toplevel, "repo", `inside the git repository at ${toplevel}${note}`, git);
	const fallback = describeHome(env, packageRoot);
	return multi(fallback.home, fallback.source === "managed" ? "managed" : "checkout", `${fallback.reason}${note}`);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** One operator-facing line for /cp-version, /doctor and /cp-mode. */
export function describeRuntime(runtime: Runtime): string {
	if (runtime.mode === "single" && runtime.repo) {
		return `single-project mode on ${runtime.home} — project ${runtime.repo.name} (source: ${runtime.source}; ${runtime.reason})`;
	}
	return `multi-project mode, home ${runtime.home} (source: ${runtime.source}; ${runtime.reason})`;
}

/** The one project a single-mode session manages, as a registry record. Never written to disk. */
export function pinnedProject(runtime: Runtime, now: () => Date = () => new Date()): Project | undefined {
	if (runtime.mode !== "single" || !runtime.repo) return undefined;
	const repo = runtime.repo;
	return {
		name: repo.name,
		clone_url: repo.origin_url ?? repo.toplevel,
		path: repo.toplevel,
		delivery: repo.origin_url ? "pr" : "local",
		registered_at: isoTimestamp(now()),
		base_branch: repo.default_branch,
	};
}

/**
 * The `project` argument every tool and command takes: optional in single mode
 * (defaults to the pinned project; another name is refused), required in multi.
 */
export function resolveProjectArg(runtime: Runtime, given: string | undefined, what: string): string {
	const value = given?.trim();
	if (runtime.mode === "single" && runtime.repo) {
		if (!value || value === runtime.repo.name) return runtime.repo.name;
		throw new ModeError(`single-project mode: this session manages ${runtime.repo.name} only (got project ${JSON.stringify(value)})`);
	}
	if (!value) throw new ModeError(`${what} needs \`project\` (a registered project name)`);
	return value;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/mode.test.ts && npm run typecheck`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mode.ts tests/mode.test.ts
git commit -m "feat(mode): resolve the runtime — CP_MODE, settings.json, repo-aware default, two refusals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The pinned project — a virtual registry entry

**Files:**
- Modify: `src/projects.ts` (`ProjectRegistryOptions`, `read`, `pathOf`, `register/update/remove`, `assertCanonicalClone`, `ensureClone`; new exported `assertCanonicalRepo`)
- Test: `tests/projects.test.ts`

**Interfaces:**
- Consumes: `pinnedProject` (Task 2) is how callers build the pinned record; this task only consumes `Project`.
- Produces:
  ```ts
  export interface ProjectRegistryOptions { home: string; now?; gitBin?; cloneTimeoutMs?; pinned?: Project }
  export function assertCanonicalRepo(path: string, label?: string): string   // traps 3–5; returns the realpath
  ```
  With `pinned`: `read()` → `{ schema_version, updated_at: pinned.registered_at, projects: [pinned] }`; `register/update/remove` throw `ProjectError("single-project mode: this session manages <name> only")`; `pathOf(pinned.name)` → `pinned.path`; `assertCanonicalClone(pinned.name)` → `assertCanonicalRepo(pinned.path)`; `ensureClone(pinned.name)` verifies and returns `{ project, path, cloned: false }`; `exists` is `true`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/projects.test.ts` (import `assertCanonicalRepo`, `ProjectError`, `ProjectRegistry` from `../src/projects.ts`; `createScratchHome`, `createScratchRepo`, `git` from `./harness/index.ts`; `existsSync`, `join`, `execFileSync` as needed):

```ts
// ---------------------------------------------------------------------------
// Single-project mode: the pinned, virtual project (spec 2026-09-04)
// ---------------------------------------------------------------------------

function pinnedFor(repoPath: string, origin?: string) {
	return {
		name: "demo",
		clone_url: origin ?? repoPath,
		path: repoPath,
		delivery: origin ? ("pr" as const) : ("local" as const),
		registered_at: "2026-09-04T10:00:00Z",
		base_branch: "main",
	};
}

test("a pinned registry answers for one project, writes nothing, and refuses every mutation", async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	t.after(() => {
		repo.cleanup();
		home.cleanup();
	});
	const pinned = pinnedFor(repo.path, repo.remote);
	const registry = new ProjectRegistry({ home: home.path, pinned });

	assert.equal(registry.exists, true);
	assert.deepEqual(registry.list(), [pinned]);
	assert.deepEqual(registry.get("demo"), pinned);
	assert.equal(registry.get("other"), undefined);
	assert.deepEqual(registry.names(), ["demo"]);
	assert.equal(registry.pathOf("demo"), repo.path);
	assert.throws(() => registry.require("other"), /other/, "require() refuses a name that is not the pinned one, with today's message");
	assert.ok(!existsSync(join(home.path, "data/projects.json")), "nothing is written for a virtual registry");

	await assert.rejects(registry.register({ name: "x", clone_url: "https://x/y.git" }), /single-project mode: this session manages demo only/);
	await assert.rejects(registry.update("demo", { notes: "n" }), /single-project mode: this session manages demo only/);
	await assert.rejects(registry.remove("demo"), /single-project mode: this session manages demo only/);
	assert.ok(!existsSync(join(home.path, "data/projects.json")));

	const ensured = await registry.ensureClone("demo");
	assert.equal(ensured.cloned, false);
	assert.equal(ensured.path, repo.path);
	assert.equal(registry.assertCanonicalClone("demo"), repo.path);
	assert.equal(registry.originUrl("demo"), repo.remote);
});

test("assertCanonicalRepo passes the main worktree and refuses a linked worktree and a nested clone", (t) => {
	const repo = createScratchRepo({ name: "canon" });
	t.after(() => repo.cleanup());
	assert.equal(assertCanonicalRepo(repo.path), repo.path);

	// A linked worktree: `.git` is a file, the common dir is elsewhere.
	const linked = join(repo.path, "..", "canon-linked");
	repo.git("worktree", "add", "-q", "--detach", linked);
	t.after(() => {
		try {
			repo.git("worktree", "remove", "--force", linked);
		} catch {
			// best effort
		}
	});
	assert.throws(() => assertCanonicalRepo(linked), /is not a primary clone .* linked worktree/);

	// A clone nested inside another repository's tree.
	const nestedParent = createScratchRepo({ name: "outer", withRemote: false });
	t.after(() => nestedParent.cleanup());
	const nested = join(nestedParent.path, "inner");
	execFileSync("git", ["clone", "-q", repo.path, nested]);
	// `inner` is its own toplevel, so it passes; the trap is a *subdirectory* of a repo pretending to be one:
	assert.equal(assertCanonicalRepo(nested), realpathSync(nested));
	mkdirSync(join(nestedParent.path, "src"), { recursive: true });
	assert.throws(() => assertCanonicalRepo(join(nestedParent.path, "src")), /nested wrong git/);
});
```

Add `realpathSync` to the `node:fs` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/projects.test.ts`
Expected: FAIL — `pinned` is not an option and `assertCanonicalRepo` is not exported.

- [ ] **Step 3: Implement**

In `src/projects.ts`:

1. `ProjectRegistryOptions` gains:
   ```ts
   	/**
   	 * Single-project mode (spec 2026-09-04): the one project this session
   	 * manages, derived from the repository it runs in. The registry is then
   	 * virtual — `read()` answers with this record, nothing is written, and every
   	 * mutation is refused.
   	 */
   	pinned?: Project;
   ```
2. `get exists()` → `return this.#options.pinned !== undefined || existsSync(this.file);`
3. `read()` — first line: `if (this.#options.pinned) return { schema_version: SCHEMA_VERSION, updated_at: this.#options.pinned.registered_at, projects: [this.#options.pinned] };`
4. `pathOf(name)` → `const pinned = this.#options.pinned; if (pinned && pinned.name === name) return pinned.path; return join(this.home, paths.projectDir(name));`
5. Add a private guard and call it first thing in `mutate`, `register`, `update`, `remove`:
   ```ts
   	#refuseWhenPinned(): void {
   		const pinned = this.#options.pinned;
   		if (pinned) throw new ProjectError(`single-project mode: this session manages ${pinned.name} only`);
   	}
   ```
   (`register` builds the record before mutating; put the guard at the top of `register`, `update` and `remove` so nothing is computed for a refused call. `mutate` keeps the guard too, for any other caller.)
6. Extract traps 3–5 of `assertCanonicalClone` into an exported function and call it from both places:
   ```ts
   /**
    * Traps 3–5 of the canonical-clone check, for an absolute path: the path is
    * its own git toplevel (not nested), `.git` is a directory (not a linked
    * worktree), and the common dir is that `.git` (not another repo's).
    * Returns the realpath. `label` names the path in messages.
    */
   export function assertCanonicalRepo(path: string, label: string = path): string {
   	const abs = realpathOrSelf(path);
   	if (!isDirectory(abs)) throw new ProjectError(`${label}: not a directory (${abs})`);
   	const toplevel = tryGit(abs, "rev-parse", "--show-toplevel");
   	if (!toplevel) throw new ProjectError(`not a git clone: ${abs}`);
   	const toplevelAbs = realpathOrSelf(toplevel);
   	if (toplevelAbs !== abs) {
   		throw new ProjectError(`nested wrong git: ${abs} is inside ${toplevelAbs} — ${label} must be its own clone`);
   	}
   	const gitDir = join(abs, ".git");
   	if (!isDirectory(gitDir)) {
   		throw new ProjectError(`${label} is not a primary clone (${gitDir} is not a directory; it belongs to another repo as a linked worktree) — launch from the main worktree of the repository`);
   	}
   	const common = tryGit(abs, "rev-parse", "--git-common-dir");
   	if (!common) throw new ProjectError(`cannot resolve git-common-dir for ${abs}`);
   	const commonAbs = realpathOrSelf(isAbsolute(common) ? common : resolve(abs, common));
   	if (commonAbs !== realpathOrSelf(gitDir)) {
   		throw new ProjectError(`${label} git-common-dir is ${commonAbs}, not ${gitDir} — it belongs to another repo. Lease only from the canonical clone.`);
   	}
   	return abs;
   }
   ```
   Then `assertCanonicalClone(name)` becomes: name check → `if (this.#options.pinned?.name === name) return assertCanonicalRepo(this.#options.pinned.path, name);` → traps 1 and 2 as today → `return assertCanonicalRepo(clone, \`projects/${name}\`)`.
7. `ensureClone(name)`: when pinned, `const path = this.assertCanonicalClone(name); return { project: this.require(name), path, cloned: false };` before any clone attempt (the existing "exists → verify origin" branch already does this; make sure the origin-mismatch check compares against `pinned.clone_url`, which for a local-only repo equals the path and `originUrl` returns `undefined`, so the check is skipped).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/projects.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/projects.ts tests/projects.test.ts
git commit -m "feat(projects): a pinned, virtual project for single-project mode; assertCanonicalRepo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Scaffold in single mode

**Files:**
- Modify: `src/scaffold.ts` (the directory loop, a new `exclude` step, the gitignore step gated to multi, `mode` option)
- Test: `tests/scaffold.test.ts`

**Interfaces:**
- Consumes: `LAYOUT` (already configured by the caller), `Mode` from Task 1.
- Produces: `ScaffoldOptions.mode?: Mode` (default `"multi"`); steps `dir.data`, `dir.state`, `dir.projects` (multi only), `dir.runtime`, `exclude` (single only), `gitignore` (multi only), `routing.default`, `ledger`. Exported helper `ensureGitExclude(home: string, entry: string): ScaffoldStep`.

- [ ] **Step 1: Write the failing tests**

Because `configureLayout("single")` is process-global, the single-mode scaffold test lives in `tests/layout-single.test.ts` (Task 1), which already configures single. Add these imports at the **top** of that file (merge with the existing import lines) and append the tests below them:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scaffoldHome } from "../src/scaffold.ts";
import { createScratchRepo } from "./harness/index.ts";
```

```ts
test("single-mode scaffold: dotdir dirs, exclude line once, no projects/, no .gitignore", (t) => {
	const repo = createScratchRepo({ name: "single-scaffold" });
	t.after(() => repo.cleanup());
	const gitignoreBefore = existsSync(join(repo.path, ".gitignore")) ? readFileSync(join(repo.path, ".gitignore"), "utf8") : undefined;

	const first = scaffoldHome({ home: repo.path, env: { CP_HOME: repo.path }, mode: "single" });
	assert.deepEqual(
		first.steps.map((step) => [step.step, step.action]),
		[
			["dir.runtime", "created"],
			["dir.data", "created"],
			["dir.state", "created"],
			["exclude", "created"],
			["routing.default", "created"],
			["ledger", "created"],
		],
	);
	assert.ok(existsSync(join(repo.path, ".pi-command-post/data")));
	assert.ok(existsSync(join(repo.path, ".pi-command-post/state")));
	assert.ok(existsSync(join(repo.path, ".pi-command-post/jobs.json")));
	assert.ok(existsSync(join(repo.path, ".pi-command-post/data/routing.json")));
	assert.ok(!existsSync(join(repo.path, "projects")));
	assert.ok(!existsSync(join(repo.path, ".pi-command-post/projects")));
	const exclude = readFileSync(join(repo.path, ".git/info/exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((line) => line.trim() === ".pi-command-post/").length, 1);
	const gitignoreAfter = existsSync(join(repo.path, ".gitignore")) ? readFileSync(join(repo.path, ".gitignore"), "utf8") : undefined;
	assert.equal(gitignoreAfter, gitignoreBefore, "the repository's .gitignore is never touched");

	const second = scaffoldHome({ home: repo.path, env: { CP_HOME: repo.path }, mode: "single" });
	assert.equal(second.already_ready, true);
	assert.ok(second.steps.every((step) => step.action === "present"));
	assert.equal(readFileSync(join(repo.path, ".git/info/exclude"), "utf8"), exclude, "the exclude line is appended once");
});

test("single-mode scaffold appends to an existing exclude file without rewriting it", (t) => {
	const repo = createScratchRepo({ name: "single-exclude" });
	t.after(() => repo.cleanup());
	mkdirSync(join(repo.path, ".git/info"), { recursive: true });
	writeFileSync(join(repo.path, ".git/info/exclude"), "# mine\n*.swp\n");
	scaffoldHome({ home: repo.path, env: { CP_HOME: repo.path }, mode: "single" });
	assert.equal(readFileSync(join(repo.path, ".git/info/exclude"), "utf8"), "# mine\n*.swp\n.pi-command-post/\n");
});
```

In `tests/scaffold.test.ts` (multi, unconfigured layout) add one assertion to the existing fresh-home test: the step list is `dir.data, dir.state, dir.projects, dir.runtime, gitignore, routing.default, ledger` — the same as item 1 left it, so the names are now fixed keys rather than directory paths.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/layout-single.test.ts`
Expected: FAIL — `mode` is not an option; the step list differs; no exclude file.

- [ ] **Step 3: Implement**

In `src/scaffold.ts`:

1. Import `type Mode` from `./contracts.ts`; add to `ScaffoldOptions`:
   ```ts
   	/** Which layout this home has (spec 2026-09-04). Default multi. The caller has already run `configureLayout`. */
   	mode?: Mode;
   ```
2. Replace the directory loop with fixed keys:
   ```ts
   	const mode = options.mode ?? "multi";
   	const dirs: Array<[string, string]> =
   		mode === "single"
   			? [["runtime", LAYOUT.runtimeDir], ["data", LAYOUT.data], ["state", LAYOUT.state]]
   			: [["data", LAYOUT.data], ["state", LAYOUT.state], ["projects", LAYOUT.projects], ["runtime", LAYOUT.runtimeDir]];
   	for (const [key, dir] of dirs) {
   		const path = join(home, dir);
   		if (existsSync(path)) {
   			steps.push({ step: `dir.${key}`, action: "present" });
   			continue;
   		}
   		try {
   			mkdirSync(path, { recursive: true });
   			steps.push({ step: `dir.${key}`, action: "created", detail: path });
   		} catch (error) {
   			steps.push({ step: `dir.${key}`, action: "failed", detail: (error as Error).message });
   		}
   	}
   	steps.push(mode === "single" ? ensureGitExclude(home, `${LAYOUT.runtimeDir}/`) : gitignoreStep(home));
   ```
3. Add the exported step:
   ```ts
   /**
    * Single mode never edits the repository, so the runtime dotdir goes into
    * git's local-only exclude list, `.git/info/exclude`, appended once. A
    * repository whose `.git` is a file (a linked worktree) cannot be scaffolded
    * here — the mode resolver refuses it first, and this reports rather than
    * guesses if it is ever reached.
    */
   export function ensureGitExclude(home: string, entry: string): ScaffoldStep {
   	const gitDir = join(home, ".git");
   	try {
   		if (!statSync(gitDir).isDirectory()) {
   			return { step: "exclude", action: "failed", detail: `${gitDir} is not a directory (a linked worktree?) — launch from the main worktree` };
   		}
   		const file = join(gitDir, "info", "exclude");
   		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
   		if (text.split("\n").some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""))) {
   			return { step: "exclude", action: "present" };
   		}
   		mkdirSync(join(gitDir, "info"), { recursive: true });
   		const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
   		durableAppend(file, `${separator}${entry}\n`);
   		return { step: "exclude", action: "created", detail: `${file} += ${entry}` };
   	} catch (error) {
   		return { step: "exclude", action: "failed", detail: (error as Error).message };
   	}
   }
   ```
   Add `readFileSync`, `statSync` to the `node:fs` import and `durableAppend` to the `./json-store.ts` import.
4. Update the header comment: a fourth rule, `- **Single mode never edits the repository.** The dotdir is excluded through .git/info/exclude; the repository's .gitignore is not touched.`

- [ ] **Step 4: Run the tests**

Run: `node --test tests/layout-single.test.ts tests/scaffold.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scaffold.ts tests/scaffold.test.ts tests/layout-single.test.ts
git commit -m "feat(scaffold): single-mode layout under the dotdir, excluded via .git/info/exclude

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Doctor knows the mode

**Files:**
- Modify: `src/doctor.ts` (`DoctorOptions.runtime?`, `#scaffold()`)
- Test: `tests/doctor.test.ts` (multi: the `mode` line), `tests/layout-single.test.ts` (single findings), `tests/golden/doctor-broken.txt`

**Interfaces:**
- Consumes: `Runtime`, `describeRuntime` (Task 2), `assertCanonicalRepo`, `ProjectError` (Task 3), `isMultiHomeDir` (Task 2).
- Produces: findings `mode` (always), `home.exclude`, `home.overlap`, `project.canonical` (single only); `home.gitignore` and `scaffold.projects` multi only.

- [ ] **Step 1: Write the failing tests**

In `tests/doctor.test.ts`, extend the golden test's expectations by regenerating later, and add:

```ts
test("mode: a multi-mode report says so, with the runtime's reason", async (t) => {
	const fixture = homeFixture(t);
	const report = await fixture.doctor().run();
	const mode = report.findings.find((f) => f.check === "mode");
	assert.equal(mode?.severity, "ok");
	assert.match(mode?.what ?? "", /^multi-project mode, home /);
	assert.ok(report.findings.some((f) => f.check === "home.gitignore") || !existsSync(join(fixture.home.path, ".gitignore")));
	assert.ok(!report.findings.some((f) => f.check === "home.exclude"), "exclude is a single-mode finding");
});
```

(If the fixture's `doctor()` helper does not take a `runtime`, the multi finding must still appear: `Doctor` builds a multi runtime from its `home` when none is given. Assert exactly that.)

Append to `tests/layout-single.test.ts`, adding these imports at the **top** of the file (merge with the existing ones, and extend the harness import to `import { createScratchRepo, REPO_ROOT } from "./harness/index.ts";`):

```ts
import { Doctor } from "../src/doctor.ts";
import { FleetStore } from "../src/fleet.ts";
import { resolveRuntime } from "../src/mode.ts";
```

```ts
test("single-mode doctor: mode line, exclude, overlap and canonical findings", async (t) => {
	const repo = createScratchRepo({ name: "single-doctor" });
	t.after(() => repo.cleanup());
	const runtime = resolveRuntime({ cwd: repo.path, env: {}, packageRoot: "/nonexistent/package/root" });
	assert.equal(runtime.mode, "single");
	const doctor = () =>
		new Doctor({
			home: repo.path,
			packageRoot: REPO_ROOT,
			fleet: new FleetStore({ home: repo.path }),
			runtime,
			which: (command) => [`/usr/local/bin/${command}`],
			run: (command, args) => (args[0] === "--version" ? { status: 0, stdout: `${command} 1.0.0`, stderr: "" } : { status: 0, stdout: "", stderr: "" }),
			env: {},
		});

	const before = await doctor().run();
	const mode = before.findings.find((f) => f.check === "mode");
	assert.equal(mode?.severity, "ok");
	assert.match(mode?.what ?? "", /^single-project mode on .* — project single-doctor/);
	assert.equal(before.findings.find((f) => f.check === "home.exclude")?.severity, "warn", "no exclude line yet");
	assert.match(before.findings.find((f) => f.check === "home.exclude")?.fix ?? "", /start a session/);
	assert.equal(before.findings.find((f) => f.check === "home.overlap")?.severity, "ok");
	assert.equal(before.findings.find((f) => f.check === "project.canonical")?.severity, "ok");
	assert.ok(!before.findings.some((f) => f.check === "home.gitignore"));
	assert.ok(!before.findings.some((f) => f.check === "scaffold.projects"));
	assert.equal(before.findings.find((f) => f.check === "scaffold.data")?.severity, "warn", "not scaffolded yet");

	scaffoldHome({ home: repo.path, env: {}, mode: "single" });
	const after = await doctor().run();
	assert.equal(after.findings.find((f) => f.check === "home.exclude")?.severity, "ok");
	assert.equal(after.findings.find((f) => f.check === "scaffold.data")?.severity, "ok");

	mkdirSync(join(repo.path, "projects"));
	mkdirSync(join(repo.path, "state"));
	const overlap = (await doctor().run()).findings.find((f) => f.check === "home.overlap");
	assert.equal(overlap?.severity, "error");
	assert.match(overlap?.fix ?? "", /\/cp-mode multi/);
});
```

Add `REPO_ROOT` to the harness import in that file (`import { createScratchRepo, REPO_ROOT } from "./harness/index.ts";`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/doctor.test.ts tests/layout-single.test.ts`
Expected: FAIL — no `mode` finding; `runtime` is not an option.

- [ ] **Step 3: Implement**

In `src/doctor.ts`:

1. Imports: `import { describeRuntime, isMultiHomeDir } from "./mode.ts";`, `import { assertCanonicalRepo, ProjectError } from "./projects.ts";` (merge with any existing `./projects.ts` import), and `type Runtime` from `./contracts.ts`.
2. `DoctorOptions` gains:
   ```ts
   	/** The session's runtime (spec 2026-09-04). Absent means multi mode on `home`, as every caller before modes did. */
   	runtime?: Runtime;
   ```
3. In the constructor store `this.#runtime = options.runtime ?? { mode: "multi", home: options.home, source: "checkout", reason: "no runtime supplied; multi mode on the given home" };` (declare `readonly #runtime: Runtime;`).
4. In `#scaffold()`:
   - First finding: `findings.push({ check: "mode", severity: "ok", what: describeRuntime(this.#runtime) });`
   - Keep the `home.location` block as is.
   - Directory loop becomes mode-aware:
     ```ts
     		const dirs: Array<[string, string]> =
     			this.#runtime.mode === "single"
     				? [["data", LAYOUT.data], ["state", LAYOUT.state]]
     				: [["data", LAYOUT.data], ["state", LAYOUT.state], ["projects", LAYOUT.projects]];
     		for (const [key, dir] of dirs) { … check: `scaffold.${key}`, what: `${dir}/ …` … }
     ```
   - Replace the `.gitignore` block with:
     ```ts
     		if (this.#runtime.mode === "single") {
     			findings.push(...this.#singleModeHome());
     		} else {
     			// (the existing .gitignore block, unchanged)
     		}
     ```
   - Add:
     ```ts
     	/** Single mode (spec 2026-09-04): the repository is the home, so the checks are about not touching it. */
     	#singleModeHome(): DoctorFinding[] {
     		const home = this.#options.home;
     		const findings: DoctorFinding[] = [];
     		const exclude = join(home, ".git", "info", "exclude");
     		const entry = `${LAYOUT.runtimeDir}/`;
     		const listed = existsSync(exclude) && readFileSync(exclude, "utf8").split("\n").some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""));
     		findings.push(
     			listed
     				? { check: "home.exclude", severity: "ok", what: `.git/info/exclude lists ${entry}` }
     				: {
     						check: "home.exclude",
     						severity: "warn",
     						what: `.git/info/exclude does not list ${entry}`,
     						detail: exclude,
     						fix: `start a session (the scaffold appends it) or add the line ${entry} to ${exclude}; the repository's .gitignore is deliberately left alone`,
     					},
     		);
     		findings.push(
     			isMultiHomeDir(home)
     				? {
     						check: "home.overlap",
     						severity: "error",
     						what: "this repository is also a multi-project command-post home (projects/ and state/ exist)",
     						detail: home,
     						fix: "two layouts in one directory would share jobs.json with separate fleets and locks: run multi mode here (`/cp-mode multi`) or launch from a project repository",
     					}
     				: { check: "home.overlap", severity: "ok", what: "not also a multi-project home" },
     		);
     		try {
     			assertCanonicalRepo(this.#runtime.repo?.toplevel ?? home, "the repository");
     			findings.push({ check: "project.canonical", severity: "ok", what: "the repository is a primary clone (its own toplevel, its own .git)" });
     		} catch (error) {
     			findings.push({
     				check: "project.canonical",
     				severity: "error",
     				what: error instanceof ProjectError ? error.message.split("\n")[0] ?? "not a canonical repository" : (error as Error).message,
     				detail: home,
     				fix: "launch from the main worktree of the repository (not a linked worktree or a nested checkout)",
     			});
     		}
     		return findings;
     	}
     ```

- [ ] **Step 4: Regenerate the golden and run**

Run: `CP_UPDATE_GOLDEN=1 node --test tests/doctor.test.ts && git diff tests/golden/doctor-broken.txt`
Expected diff: one new line `✓ [mode] multi-project mode, home <HOME> (source: checkout; no runtime supplied; multi mode on the given home)` (the golden harness masks the home path as `<HOME>`; if the reason text is not masked and leaks a temp path, make the fallback reason path-free, e.g. `"no runtime supplied; multi mode on the given home"`, which it already is) and the ok count bumped by one.

Run: `node --test tests/doctor.test.ts tests/layout-single.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts tests/layout-single.test.ts tests/golden/doctor-broken.txt
git commit -m "feat(doctor): mode line; single-mode exclude, overlap and canonical-repo findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The parent's contract, injected

**Files:**
- Modify: `src/mode.ts` (add `contractInjection`)
- Create: `tests/contract-injection.test.ts`
- Modify: `extensions/command-post/index.ts` (register `before_agent_start`; wiring is finished in Task 9 once `currentRuntime()` exists — this task adds the handler behind a small accessor that Task 9 replaces)

**Interfaces:**
- Produces:
  ```ts
  export interface ContractInjectionEvent { systemPrompt: string; contextFiles?: ReadonlyArray<{ path: string }> }
  export interface ContractInjectionOptions { packageRoot: string; runtime: Runtime; readContract?: () => string | undefined }
  export function contractInjection(event: ContractInjectionEvent, options: ContractInjectionOptions): { systemPrompt: string } | undefined
  export function singleModePreamble(runtime: Runtime): string   // "" in multi mode
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/contract-injection.test.ts`:

```ts
/**
 * The parent's operating contract reaches the model even when pi did not load
 * it (spec 2026-09-04 single-project mode D8): injected in before_agent_start,
 * skipped when AGENTS.md is already among the context files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/contracts.ts";
import { contractInjection, singleModePreamble } from "../src/mode.ts";

const MULTI: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "r" };
const SINGLE: Runtime = {
	mode: "single",
	home: "/repo",
	source: "repo",
	reason: "r",
	repo: { toplevel: "/repo", name: "repo", origin_url: "git@x:y.git", default_branch: "main" },
};

function packageWithContract(text = "# Command Post\n\nYou are the parent.\n"): { root: string; cleanup(): void } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-pkg-")));
	writeFileSync(join(root, "AGENTS.md"), text);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("injects the contract when pi did not load it, appended after the chained prompt", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	const result = contractInjection(
		{ systemPrompt: "SYSTEM", contextFiles: [{ path: "/some/project/AGENTS.md" }] },
		{ packageRoot: pkg.root, runtime: MULTI },
	);
	assert.ok(result);
	assert.ok(result.systemPrompt.startsWith("SYSTEM\n\n"));
	assert.ok(result.systemPrompt.endsWith("# Command Post\n\nYou are the parent.\n"));
	assert.equal(singleModePreamble(MULTI), "");
});

test("returns undefined when the package's AGENTS.md is already a context file (also through a symlink)", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	assert.equal(
		contractInjection({ systemPrompt: "S", contextFiles: [{ path: join(pkg.root, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }),
		undefined,
	);
	const link = join(tmpdir(), `cp-link-${process.pid}`);
	symlinkSync(pkg.root, link);
	t.after(() => rmSync(link, { force: true }));
	assert.equal(
		contractInjection({ systemPrompt: "S", contextFiles: [{ path: join(link, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }),
		undefined,
	);
});

test("single mode adds the three-line preamble naming the project", (t) => {
	const pkg = packageWithContract("CONTRACT");
	t.after(pkg.cleanup);
	const preamble = singleModePreamble(SINGLE);
	assert.deepEqual(preamble.trimEnd().split("\n"), [
		"# Command post — single-project mode",
		"This session manages exactly one project: repo at /repo.",
		"Every project argument defaults to it; another name is refused.",
	]);
	const result = contractInjection({ systemPrompt: "S" }, { packageRoot: pkg.root, runtime: SINGLE });
	assert.equal(result?.systemPrompt, `S\n\n${preamble}CONTRACT`);
});

test("a missing contract file injects nothing; readContract is injectable", () => {
	assert.equal(contractInjection({ systemPrompt: "S" }, { packageRoot: "/nonexistent", runtime: MULTI }), undefined);
	const result = contractInjection({ systemPrompt: "S" }, { packageRoot: "/nonexistent", runtime: MULTI, readContract: () => "FROM TEST" });
	assert.equal(result?.systemPrompt, "S\n\nFROM TEST");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/contract-injection.test.ts`
Expected: FAIL — `contractInjection` is not exported.

- [ ] **Step 3: Implement**

Append to `src/mode.ts`:

```ts
// ---------------------------------------------------------------------------
// The parent's contract (D8)
// ---------------------------------------------------------------------------

export interface ContractInjectionEvent {
	systemPrompt: string;
	contextFiles?: ReadonlyArray<{ path: string }>;
}

export interface ContractInjectionOptions {
	packageRoot: string;
	runtime: Runtime;
	/** Injected in tests; production reads `<packageRoot>/AGENTS.md`. `undefined` means "no contract". */
	readContract?: () => string | undefined;
}

/** Three lines in single mode, nothing in multi. Ends with a blank line when present. */
export function singleModePreamble(runtime: Runtime): string {
	if (runtime.mode !== "single" || !runtime.repo) return "";
	return [
		"# Command post — single-project mode",
		`This session manages exactly one project: ${runtime.repo.name} at ${runtime.repo.toplevel}.`,
		"Every project argument defaults to it; another name is refused.",
		"",
		"",
	].join("\n");
}

/**
 * pi loads context files from the working directory and its parents only, so
 * a parent launched anywhere but this checkout has no AGENTS.md. When the
 * package's own AGENTS.md is not among the loaded context files, append it to
 * the chained system prompt; when it is, return nothing and change nothing.
 */
export function contractInjection(event: ContractInjectionEvent, options: ContractInjectionOptions): { systemPrompt: string } | undefined {
	const contractPath = realpathOrSelf(join(options.packageRoot, "AGENTS.md"));
	const loaded = (event.contextFiles ?? []).some((file) => realpathOrSelf(file.path) === contractPath);
	if (loaded) return undefined;
	const read =
		options.readContract ??
		(() => {
			try {
				return readFileSync(contractPath, "utf8");
			} catch {
				return undefined;
			}
		});
	const contract = read();
	if (contract === undefined) return undefined;
	return { systemPrompt: `${event.systemPrompt}\n\n${singleModePreamble(options.runtime)}${contract}` };
}
```

In `extensions/command-post/index.ts`, add the import `import { contractInjection } from "../../src/mode.ts";` and, next to the other `pi.on(...)` registrations, the handler (the `currentRuntime()` accessor is introduced in Task 9; until then use a local `const runtimeForContract = () => ({ mode: "multi", home: resolveHome(), source: "checkout", reason: "pre-mode" }) as Runtime;` and replace it in Task 9):

```ts
	// Spec 2026-09-04 D8: the parent's contract, when pi did not load it. Read
	// once per session; a missing file is one warning, never a crash.
	let contractMissingShown = false;
	pi.on("before_agent_start", async (event, ctx) => {
		const result = contractInjection(
			{ systemPrompt: event.systemPrompt, contextFiles: event.systemPromptOptions.contextFiles ?? [] },
			{ packageRoot: PACKAGE_ROOT, runtime: runtimeForContract() },
		);
		if (result) return result;
		const alreadyLoaded = (event.systemPromptOptions.contextFiles ?? []).some((file) => file.path.endsWith("/AGENTS.md"));
		if (!alreadyLoaded && !contractMissingShown && !existsSync(join(PACKAGE_ROOT, "AGENTS.md"))) {
			contractMissingShown = true;
			const message = `pi-command-post: ${join(PACKAGE_ROOT, "AGENTS.md")} is missing; the parent runs without its operating contract`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		return undefined;
	});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/contract-injection.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mode.ts tests/contract-injection.test.ts extensions/command-post/index.ts
git commit -m "feat(mode): inject the parent's contract in before_agent_start when pi did not load it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `/cp-mode`

**Files:**
- Create: `extensions/command-post/mode-command.ts`
- Create: `tests/mode-command.test.ts`
- Modify: `extensions/command-post/index.ts` (one import, one `registerModeCommand` call; finished in Task 9)

**Interfaces:**
- Consumes: `Runtime`, `describeRuntime`, `settingsPath`, `writeModeSettings`, `gitToplevel`, `isMultiHomeDir`, `ModeError` (Task 2).
- Produces:
  ```ts
  export type ModeCommand = { kind: "show" } | { kind: "set"; mode: ModeSetting };
  export function parseModeArgs(args: string): ModeCommand
  export interface ModeCommandPorts { runtime: Runtime; cwd: string; writeSettings?: (dir: string, mode: ModeSetting) => string; toplevel?: (cwd: string) => string | undefined }
  export function runModeCommand(command: ModeCommand, ports: ModeCommandPorts): string   // throws ModeError on refusal
  export function registerModeCommand(pi: ExtensionAPI, ports: { runtime: () => Runtime; cwd: () => string; emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error" }) => void }): void
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/mode-command.test.ts`:

```ts
/**
 * `/cp-mode` (spec 2026-09-04 single-project mode §/cp-mode): show, set with
 * "next session start", and the D6 refusal inside a multi home.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../src/contracts.ts";
import { parseModeArgs, registerModeCommand, runModeCommand } from "../extensions/command-post/mode-command.ts";

const SINGLE: Runtime = {
	mode: "single",
	home: "/repo",
	source: "repo",
	reason: "inside the git repository at /repo",
	repo: { toplevel: "/repo", name: "repo", default_branch: "main" },
};

test("parseModeArgs: bare shows; single|multi|auto sets; anything else is usage", () => {
	assert.deepEqual(parseModeArgs(""), { kind: "show" });
	assert.deepEqual(parseModeArgs("  single "), { kind: "set", mode: "single" });
	assert.deepEqual(parseModeArgs("multi"), { kind: "set", mode: "multi" });
	assert.deepEqual(parseModeArgs("auto"), { kind: "set", mode: "auto" });
	assert.throws(() => parseModeArgs("dual"), /usage: \/cp-mode \[single\|multi\|auto\]/);
	assert.throws(() => parseModeArgs("single now"), /usage/);
});

test("show prints the runtime line, the settings path and what each value does", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-modecmd-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const text = runModeCommand({ kind: "show" }, { runtime: SINGLE, cwd: dir, toplevel: () => dir });
	assert.match(text, /^single-project mode on \/repo — project repo/);
	assert.match(text, new RegExp(`settings: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.pi-command-post/settings\\.json \\(absent\\)`));
	assert.match(text, /\/cp-mode single/);
	assert.match(text, /\/cp-mode multi/);
	assert.match(text, /\/cp-mode auto/);
	assert.match(text, /CP_MODE/);
});

test("set writes the settings file in the launch toplevel and says it applies at the next start", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-modecmd-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const text = runModeCommand({ kind: "set", mode: "multi" }, { runtime: SINGLE, cwd: join(dir, "sub"), toplevel: () => dir });
	assert.match(text, /saved mode multi to .*settings\.json; takes effect at the next session start/);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".pi-command-post/settings.json"), "utf8")), { schema_version: 1, mode: "multi" });
});

test("set single inside a multi home is refused and writes nothing", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-modecmd-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "projects"));
	mkdirSync(join(dir, "state"));
	const multi: Runtime = { mode: "multi", home: dir, source: "home-dir", reason: "r" };
	assert.throws(
		() => runModeCommand({ kind: "set", mode: "single" }, { runtime: multi, cwd: dir, toplevel: () => undefined }),
		/this directory is a command-post home; single-project mode here would share its ledger/,
	);
	assert.ok(!readFileSyncSafe(join(dir, ".pi-command-post/settings.json")));
	// auto and multi are still allowed there
	assert.match(runModeCommand({ kind: "set", mode: "auto" }, { runtime: multi, cwd: dir, toplevel: () => undefined }), /saved mode auto/);
});

function readFileSyncSafe(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

test("registerModeCommand wires /cp-mode to emit", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = { registerCommand: (name: string, spec: unknown) => commands.set(name, spec as never) } as unknown as ExtensionAPI;
	const emitted: Array<{ text: string; level?: string }> = [];
	registerModeCommand(pi, {
		runtime: () => SINGLE,
		cwd: () => "/nonexistent-cwd",
		emit: (_ctx, _source, text, options) => {
			emitted.push({ text, ...(options?.level ? { level: options.level } : {}) });
		},
	});
	const ctx = { hasUI: false } as unknown as ExtensionContext;
	await commands.get("cp-mode")!.handler("", ctx);
	assert.match(emitted[0]?.text ?? "", /single-project mode/);
	await commands.get("cp-mode")!.handler("bogus", ctx);
	assert.equal(emitted[1]?.level, "error");
	assert.match(emitted[1]?.text ?? "", /usage/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/mode-command.test.ts`
Expected: FAIL — `Cannot find module '../extensions/command-post/mode-command.ts'`.

- [ ] **Step 3: Implement**

Create `extensions/command-post/mode-command.ts`:

```ts
/**
 * `/cp-mode` (spec 2026-09-04 single-project mode D4): show the mode this
 * session resolved, or save a preference that applies at the **next** session
 * start. It never changes the running session — switching live would release
 * the parent lock and abandon the fleet view while workers may be running.
 *
 * Pure over ports; `index.ts` supplies the runtime, the cwd and `emit`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { ENV_MODE, MODE_SETTINGS, type ModeSetting, type Runtime } from "../../src/contracts.ts";
import { describeRuntime, gitToplevel, isMultiHomeDir, ModeError, settingsPath, writeModeSettings } from "../../src/mode.ts";

export type ModeCommand = { kind: "show" } | { kind: "set"; mode: ModeSetting };

const USAGE = "usage: /cp-mode [single|multi|auto] — no argument shows the current mode";

export function parseModeArgs(args: string): ModeCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "show" };
	const [mode, ...rest] = tokens;
	if (rest.length > 0 || !(MODE_SETTINGS as readonly string[]).includes(mode as string)) throw new Error(USAGE);
	return { kind: "set", mode: mode as ModeSetting };
}

export interface ModeCommandPorts {
	runtime: Runtime;
	cwd: string;
	writeSettings?: (dir: string, mode: ModeSetting) => string;
	toplevel?: (cwd: string) => string | undefined;
}

/** The directory the settings file belongs to: the launch cwd's git toplevel, else the cwd. */
function anchorFor(ports: ModeCommandPorts): string {
	const toplevel = (ports.toplevel ?? gitToplevel)(ports.cwd);
	return toplevel ?? ports.cwd;
}

export function runModeCommand(command: ModeCommand, ports: ModeCommandPorts): string {
	const anchor = anchorFor(ports);
	const file = settingsPath(anchor);
	if (command.kind === "show") {
		return [
			describeRuntime(ports.runtime),
			`settings: ${file} (${existsSync(file) ? "present" : "absent"}); ${ENV_MODE} in the environment wins over it`,
			"  /cp-mode single  — manage the git repository you launch from, state under its .pi-command-post/",
			"  /cp-mode multi   — the multi-project command post on its default home (CP_HOME, the checkout, or ~/.pi/command-post)",
			"  /cp-mode auto    — decide from the directory (the default)",
			"a saved value takes effect at the next session start; this session is unchanged",
		].join("\n");
	}
	if (command.mode === "single" && isMultiHomeDir(anchor)) {
		throw new ModeError(
			"this directory is a command-post home; single-project mode here would share its ledger — run multi mode here (`/cp-mode multi`) or launch from a project repository",
		);
	}
	const written = (ports.writeSettings ?? writeModeSettings)(anchor, command.mode);
	return `saved mode ${command.mode} to ${written}; takes effect at the next session start (this session stays ${ports.runtime.mode}-project)`;
}

export function registerModeCommand(
	pi: ExtensionAPI,
	ports: {
		runtime: () => Runtime;
		cwd: () => string;
		emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error" }) => void;
	},
): void {
	pi.registerCommand("cp-mode", {
		description: "Show the command-post mode, or save single|multi|auto for the next session start",
		getArgumentCompletions: (prefix: string) => {
			const words = [...MODE_SETTINGS].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word }));
			return words.length > 0 ? words : null;
		},
		handler: async (args, ctx) => {
			try {
				const text = runModeCommand(parseModeArgs(args), { runtime: ports.runtime(), cwd: ports.cwd() });
				ports.emit(ctx, "cp-mode", text);
			} catch (error) {
				ports.emit(ctx, "cp-mode", (error as Error).message, { level: "error" });
			}
		},
	});
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/mode-command.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/command-post/mode-command.ts tests/mode-command.test.ts
git commit -m "feat(mode): /cp-mode shows the mode or saves a preference for the next start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `project` becomes optional in single mode

**Files:**
- Modify: `extensions/command-post/jobs.ts` (`JobPorts.resolveProject`, `create`, `registerJobs` ports), `tests/jobs-tool.test.ts`
- Modify: `extensions/command-post/index.ts` (`cp_ask` schema + `askQuestion`, `parseAskArgs`, `/cp-ask`, `cp_pipeline start`, `cp_check`)
- Test: `tests/jobs-tool.test.ts`, `tests/ask.test.ts` (or wherever `parseAskArgs` is tested — `grep -ln parseAskArgs tests`)

**Interfaces:**
- Consumes: `resolveProjectArg(runtime, given, what)` (Task 2).
- Produces: `JobPorts.resolveProject: (given: string | undefined) => string`; `JobsRegistration.runtime: () => Runtime`; `parseAskArgs(args, options?: { pinnedProject?: string })`.

- [ ] **Step 1: Write the failing tests**

In `tests/jobs-tool.test.ts`, change the `ports` helper to accept a resolver and add a test:

```ts
function ports(t: { after(fn: () => void): void }, live: Set<string> = new Set(), pinned?: string) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	return {
		scratch,
		ports: {
			ledger: scratch.ledger,
			hasLiveWorker: (id: string) => live.has(id),
			resolveProject: (given: string | undefined) => {
				if (pinned) {
					if (!given || given === pinned) return pinned;
					throw new Error(`single-project mode: this session manages ${pinned} only`);
				}
				if (!given) throw new Error("cp_job create needs `project`");
				return given;
			},
		},
	};
}

test("create resolves project through the runtime: required in multi, defaulted and pinned in single", async (t) => {
	const multi = ports(t);
	await assert.rejects(runJobAction({ action: "create", title: "x", delivery: "pr" }, multi.ports), /needs `project`/);
	const single = ports(t, new Set(), "demo");
	const created = await runJobAction({ action: "create", title: "x", delivery: "pr" }, single.ports);
	assert.ok((created.details.job as { labels: string[] }).labels.includes("project:demo"));
	await assert.rejects(runJobAction({ action: "create", title: "x", project: "other", delivery: "pr" }, single.ports), /manages demo only/);
});
```

In the `registerJobs` test of the same file, pass `runtime: () => ({ mode: "multi", home: scratch.path, source: "checkout", reason: "test" })` in the ports object.

For `parseAskArgs`, in the file that tests it today (`grep -ln parseAskArgs tests/*.test.ts`), add:

```ts
test("parseAskArgs in single mode: the whole line is the question, a leading pinned name is tolerated", () => {
	assert.deepEqual(parseAskArgs("what does the scheduler do", { pinnedProject: "demo" }), { project: "demo", question: "what does the scheduler do" });
	assert.deepEqual(parseAskArgs("demo what does the scheduler do", { pinnedProject: "demo" }), { project: "demo", question: "what does the scheduler do" });
	assert.deepEqual(parseAskArgs("what is X --model openai/gpt-5", { pinnedProject: "demo" }), { project: "demo", question: "what is X", model: "openai/gpt-5" });
	assert.throws(() => parseAskArgs("", { pinnedProject: "demo" }), /usage: \/cp-ask/);
	// multi mode is unchanged
	assert.deepEqual(parseAskArgs("demo what is X"), { project: "demo", question: "what is X" });
});
```

(Match the exact shape `parseAskArgs` returns today — read its remaining lines after `if (project === undefined) throw new Error(usage);` — and adjust the expected objects to it, e.g. if `model` is present as `undefined` when absent.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/jobs-tool.test.ts tests/ask.test.ts`
Expected: FAIL — `resolveProject` is not a port; `parseAskArgs` takes one argument.

- [ ] **Step 3: Implement**

`extensions/command-post/jobs.ts`:

1. `JobPorts` gains `resolveProject: (given: string | undefined) => string;`.
2. In `runJobAction` case `create`, replace `project: need(params, "project"),` with `project: ports.resolveProject(params.project),`.
3. `JobsRegistration` gains `runtime: () => Runtime;` (import `type Runtime` from contracts and `resolveProjectArg` from `../../src/mode.ts`); `portsFor(post, runtime)` adds `resolveProject: (given) => resolveProjectArg(runtime, given, "cp_job create")`. Both call sites (`cp_job` execute and the `/cp-jobs` handler) pass `ports.runtime()`.
4. In the tool description, change "project (a registered name)" to "project (a registered name; optional in single-project mode, where it defaults to the repository)".

`extensions/command-post/index.ts`:

1. `cp_ask` parameters: `project: Type.Optional(Type.String({ description: "Registered project name; optional in single-project mode (defaults to the repository)" }))`. In `askQuestion`, `project: resolveProjectArg(currentRuntime(), request.project, "cp_ask")` before `ledger().create(...)`; the request type's `project` becomes `project?: string`.
2. `parseAskArgs(args: string, options: { pinnedProject?: string } = {})`: when `options.pinnedProject` is set, the first non-flag token is **not** a project — it is part of the question — unless it equals the pinned name, in which case it is dropped; `project` is the pinned name; the usage string becomes `usage: /cp-ask <question…> [--model <ref>]  (single-project mode: the project is <name>)`. When unset, behaviour is unchanged.
3. `/cp-ask` handler: `const runtime = currentRuntime(); const parsed = parseAskArgs(args, runtime.mode === "single" && runtime.repo ? { pinnedProject: runtime.repo.name } : {});`; the completions callback returns `null` in single mode.
4. `cp_pipeline start`: replace `if (!params.title || !params.project || !params.task)` with `if (!params.title || !params.task) throw new Error("cp_pipeline start needs \`title\` and \`task\`");` and pass `project: resolveProjectArg(currentRuntime(), params.project, "cp_pipeline start")`.
5. `cp_check`: `project: Type.Optional(Type.String({ description: "Registered project name; optional in single-project mode" }))`; in the handler `project: resolveProjectArg(currentRuntime(), params.project, "cp_check")`.

Until Task 9 lands `currentRuntime()`, use the same temporary `runtimeForContract()` accessor from Task 6 (it returns multi, so every existing test keeps today's "project required" behaviour); Task 9 replaces both with the real accessor.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/jobs-tool.test.ts tests/ask.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/command-post/jobs.ts extensions/command-post/index.ts tests/jobs-tool.test.ts tests/ask.test.ts
git commit -m "feat(mode): project is optional in single mode across cp_job, cp_ask, /cp-ask, cp_pipeline and cp_check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Session-start wiring and the end-to-end proof

**Files:**
- Modify: `extensions/command-post/index.ts` (`currentRuntime()`, every `resolveHome()` call, `session_start` ordering, `/cp-version`, `registerModeCommand`, `CommandPost` options)
- Modify: `src/command-post.ts` (`CommandPostOptions.runtime?`, pinned registry, doctor runtime)
- Create: `tests/e2e/single-mode.test.ts`
- Modify: `tests/extension-load.test.ts` (asserts `cp-mode` is registered)

**Interfaces:**
- Consumes: everything above.
- Produces: `export function currentRuntime(): Runtime` from `index.ts` (resolves once from `process.cwd()`, `process.env`, `PACKAGE_ROOT`; calls `configureLayout`); `CommandPostOptions.runtime?: Runtime`.

- [ ] **Step 1: Write the failing tests**

In `tests/extension-load.test.ts`, beside the `cp-jobs` assertion:

```ts
	const cpMode = commands.find((command) => command.name === "cp-mode");
	assert.ok(cpMode, `cp-mode not registered; got: ${commands.map((c) => c.name).join(",")}`);
```

Create `tests/e2e/single-mode.test.ts`:

```ts
/**
 * Single-project mode, end to end (spec 2026-09-04): a real pi child started
 * inside a scratch git repository with the extension loaded and no CP_HOME.
 * It must resolve single mode, scaffold under the repository's dotdir, say so
 * in /cp-version, and let the model create a job without naming a project.
 *
 * Two children: an RPC one for commands (no model), and a mock-model one for
 * the tool call.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchRepo,
	MockProvider,
	startPiChild,
	startRpc,
} from "../harness/index.ts";

test("single mode: /cp-version says so and the scaffold lands under <repo>/.pi-command-post", { timeout: 120_000 }, async (t) => {
	const repo = createScratchRepo({ name: "single-e2e" });
	t.after(() => repo.cleanup());
	const rpc = startRpc({
		cwd: repo.path,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		// No CP_HOME, no CP_MODE: the repo-aware default must pick single.
		env: { CP_HOME: "", CP_MODE: "" },
	});
	t.after(async () => {
		await rpc.close();
	});

	const scaffolded = await rpc.waitFor(
		(record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes("command post home"),
		60_000,
	);
	const block = String(scaffolded.message);
	assert.match(block, /dir\.runtime: created/);
	assert.match(block, /exclude: created/);
	assert.match(block, /ledger: created/);
	assert.doesNotMatch(block, /dir\.projects/);

	rpc.send({ id: "cmds", type: "get_commands" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as { data?: { commands?: Array<{ name: string }> } };
	const names = (response.data?.commands ?? []).map((c) => c.name);
	for (const name of ["cp-mode", "cp-jobs", "cp-version", "status", "doctor"]) assert.ok(names.includes(name), `${name} missing from ${names.join(",")}`);

	rpc.send({ id: "run", type: "prompt", message: "/cp-version" });
	const version = await rpc.waitFor(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && typeof r.message === "string" && (r.message as string).startsWith("pi-command-post "),
	);
	assert.match(String(version.message), /single-project mode on .*single-e2e — project single-e2e \(source: repo/);

	assert.ok(existsSync(join(repo.path, ".pi-command-post/jobs.json")));
	assert.ok(existsSync(join(repo.path, ".pi-command-post/state")));
	assert.ok(existsSync(join(repo.path, ".pi-command-post/data/routing.json")));
	assert.ok(!existsSync(join(repo.path, "projects")));
	assert.ok(!existsSync(join(repo.path, "state")));
	assert.match(readFileSync(join(repo.path, ".git/info/exclude"), "utf8"), /^\.pi-command-post\/$/m);
	assert.equal(repo.isClean(), true, "the repository's tracked tree is untouched");
});

test("single mode: cp_job create without a project lands with the repository's label; cp_check passes on the repo", { timeout: 180_000 }, async (t) => {
	const repo = createScratchRepo({ name: "single-tools" });
	const provider = await MockProvider.start();
	const model = provider.addScript("single-tools", [
		{ kind: "tool_calls", calls: [{ name: "cp_job", args: { action: "create", title: "first job here", delivery: "pr", kind: "ship" } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_check", args: { job_id: "cp-check-probe" } }] },
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: repo.path,
		model,
		env: { ...agentDir.env, CP_HOME: "", CP_MODE: "" },
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		repo.cleanup();
	});

	await child.prompt("create the first job and check the repo");
	await child.waitForSettled(120_000);

	const doc = JSON.parse(readFileSync(join(repo.path, ".pi-command-post/jobs.json"), "utf8")) as { jobs: Array<{ id: string; labels: string[]; title: string }> };
	assert.equal(doc.jobs.length, 1);
	assert.equal(doc.jobs[0]?.title, "first job here");
	assert.ok(doc.jobs[0]?.labels.includes("project:single-tools"), doc.jobs[0]?.labels.join(","));

	const checks = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_check");
	assert.equal(checks.length, 1);
	const text = JSON.stringify((checks[0] as { result?: unknown }).result ?? {});
	assert.match(text, /single-tools/);
	assert.doesNotMatch(text, /needs `project`/);
});
```

(`createAgentDir({ provider })` and `MockProvider.addScript` are used exactly as `tests/review-tool.test.ts` uses them; `child.eventsOfType` and `child.waitForSettled` likewise. If `startPiChild`'s hermetic default passes `--no-extensions`, that only affects *package* extensions; `-e` files still load, as the review-tool test relies on.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/e2e/single-mode.test.ts`
Expected: FAIL — the scaffold block reports `dir.data: created` at the repo root and `/cp-version` says nothing about a mode (the runtime is not wired).

- [ ] **Step 3: Wire the runtime**

`src/command-post.ts`:

1. `CommandPostOptions` gains `runtime?: Runtime;` (import `type Runtime` from contracts, `pinnedProject` from `./mode.ts`).
2. Registry construction: `this.registry = new ProjectRegistry({ home: options.home, ...(options.runtime ? (() => { const pinned = pinnedProject(options.runtime); return pinned ? { pinned } : {}; })() : {}) });`
3. `doctor()` (wherever `new Doctor({...})` is built) passes `...(this.#options.runtime ? { runtime: this.#options.runtime } : {})`.

`extensions/command-post/index.ts`:

1. Imports: `configureLayout`, `type Runtime` from contracts; `ModeError`, `resolveRuntime`, `describeRuntime` from `../../src/mode.ts`; `registerModeCommand` from `./mode-command.ts`.
2. Replace the temporary `runtimeForContract` with the real accessor, exported for tests:
   ```ts
   let runtimeCache: Runtime | undefined;
   /**
    * The session's runtime, resolved once (spec 2026-09-04): mode, home and the
    * pinned repository. Configures the layout as a side effect, so every path
    * read after this call is the right mode's. Throws `ModeError` for the two
    * refusals and an invalid CP_MODE; `session_start` turns that into a notify
    * and ends startup.
    */
   export function currentRuntime(): Runtime {
   	if (!runtimeCache) {
   		runtimeCache = resolveRuntime({ cwd: process.cwd(), env: process.env, packageRoot: PACKAGE_ROOT });
   		configureLayout(runtimeCache.mode);
   	}
   	return runtimeCache;
   }
   ```
3. Every `resolveHome()` call becomes `currentRuntime().home` (`reconcileFleet`'s default parameter, the stamp check near line 736, `commandPost()` construction, `session_start`, the parent-lock read near 1717); `describeHome()` in `/cp-version` becomes `describeRuntime(currentRuntime())` and the line is `` `${formatVersionLine(readPackageIdentity())}\n${describeRuntime(currentRuntime())}` ``.
4. `commandPost()` passes `runtime: currentRuntime()` into `new CommandPost({...})`.
5. `session_start`: at the very top, before `const home = …`:
   ```ts
   		let runtime: Runtime;
   		try {
   			runtime = currentRuntime();
   		} catch (error) {
   			const message = `pi-command-post: ${error instanceof ModeError ? error.message : (error as Error).message}`;
   			if (ctx.hasUI) ctx.ui.notify(message, "error");
   			else process.stderr.write(`${message}\n`);
   			return;
   		}
   		const home = runtime.home;
   ```
   and `scaffoldHome({ home })` becomes `scaffoldHome({ home, mode: runtime.mode })`.
6. Register the command beside `registerJobs(...)`: `registerModeCommand(pi, { runtime: () => currentRuntime(), cwd: () => process.cwd(), emit });` and pass `runtime: () => currentRuntime()` into `registerJobs`' ports.
7. `/cp-ask` completions: return `null` when `currentRuntime().mode === "single"`.

Then delete the temporary accessor from Tasks 6 and 8.

- [ ] **Step 4: Run everything**

Run: `node --test tests/extension-load.test.ts tests/e2e/single-mode.test.ts && npm run typecheck && npm test`
Expected: PASS. Every pre-existing suite runs with `CP_HOME` set or from the checkout, which resolves multi, so nothing else changes.

- [ ] **Step 5: Commit**

```bash
git add extensions/command-post/index.ts src/command-post.ts tests/e2e/single-mode.test.ts tests/extension-load.test.ts
git commit -m "feat(mode): resolve the runtime first at session start; single-project mode end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/contracts.md`

- [ ] **Step 1: README**

1. Under *Quick start*, after the checkout instructions, add a subsection:

   ```markdown
   ### Run it inside one repository

   Launch pi from any git repository (not this checkout) and the extension runs in
   **single-project mode**: that repository is the only project, its state lives
   under `<repo>/.pi-command-post/` (excluded through `.git/info/exclude`, so the
   repository itself is never edited), and every `project` argument defaults to it.

   ```bash
   cd ~/src/my-repo
   pi                          # the extension is installed as a package
   ```

   `/cp-version` and `/doctor` print which mode you are in and why. To pin a
   directory to one mode, `/cp-mode single|multi|auto` saves the choice in
   `.pi-command-post/settings.json` for the next session start; `CP_MODE` in the
   environment wins over it. Multi-project mode (this checkout, `CP_HOME`, or an
   existing home) is unchanged.
   ```
2. In *Where your state lives*, add a row: `| a git repository (single-project mode) | the repository root; \`data/\` and \`state/\` under \`.pi-command-post/\` | one directory to exclude, no clash with the repository's own directories |`.
3. In *Surfaces*, add `| \`/cp-mode [single \| multi \| auto]\` | show the mode, or save a preference for the next session start |`.
4. In the layout table, note that in single mode `data/` and `state/` live under `.pi-command-post/`.

- [ ] **Step 2: AGENTS.md**

After the opening paragraphs (before *Each session*), add:

```markdown
## Two modes

You run in one of two modes, decided when the session starts and printed by
`/cp-version`. **Multi-project**: the home holds `projects/<name>` clones and
every job names its project. **Single-project**: the session was launched
inside a git repository; that repository is the home and the only project,
`project` defaults to it on every tool (`cp_job create`, `cp_ask`,
`cp_pipeline start`, `cp_check`), another name is refused, and `cp_project
add` is refused. Nothing else differs: the same tools, gates, checkpoints and
guards apply. A mode change (`/cp-mode`) takes effect at the next session
start, never in this one.
```

- [ ] **Step 3: docs/contracts.md**

1. *Directory layout*: replace "Everything below is relative to the **command post home** (this repo)." with "Everything below is relative to the **command post home**. In multi-project mode that is this checkout (or `~/.pi/command-post`); in single-project mode it is the repository root, and `data/` and `state/` sit under `.pi-command-post/` (see §Modes)." Add `.pi-command-post/settings.json   the saved mode preference (/cp-mode)` to the dotdir block.
2. New section before *Ledger*, with a TOC entry `- [Modes](#modes)`:

```markdown
## Modes

Spec: `docs/superpowers/specs/2026-09-04-single-project-mode-design.md`.
Implemented in [`src/mode.ts`](../src/mode.ts); the layout switch lives in
`src/contracts.ts` (`configureLayout`).

**Resolution**, once per process, before any path is read: `CP_MODE`
(`single|multi|auto`; anything else ends startup) → `.pi-command-post/settings.json`
in the launch directory's git toplevel (an unreadable or unknown value is
reported and ignored) → the repo-aware default: `CP_HOME`, the source
checkout, or a directory with `projects/` and `state/` give **multi**; a git
repository gives **single** on its toplevel; anything else gives multi on
today's default home.

**Refusals**: single mode forced with no repository; single mode where the
toplevel is also a multi home (two layouts would share `jobs.json` while
keeping separate fleets and parent locks). This checkout is therefore always
a multi home.

**Layout** (`configureLayout(mode)`; a second call with another mode throws):
multi is unchanged; single maps `data` → `.pi-command-post/data`, `state` →
`.pi-command-post/state`, `projects` → `.pi-command-post/projects` (never
created), keeps `.pi-command-post/jobs.json`, and `NEVER_COMMIT_PATHS` is
`[".pi-command-post/"]`.

**The project** in single mode is virtual: derived from the repository
(`name` = sanitised basename, `clone_url` = origin or the path, `path` = the
toplevel, `delivery` = `pr` with an origin else `local`), never written to
`data/projects.json`; `cp_project add|update|remove` refuse; `project` is
optional on `cp_job create`, `cp_ask`, `/cp-ask`, `cp_pipeline start` and
`cp_check` and any other name is refused. The canonical-clone traps 3–5 run
against the repository (`assertCanonicalRepo`); a linked worktree or nested
clone refuses with "launch from the main worktree".

**The repository is never edited**: the scaffold appends `.pi-command-post/`
to `.git/info/exclude`; doctor's `home.exclude` warns when it is missing.

**The contract**: pi loads `AGENTS.md` only from the working directory and
its parents, so in `before_agent_start` the extension appends this package's
`AGENTS.md` to the system prompt whenever it is not already among the loaded
context files — in both modes; single mode adds a three-line preamble naming
the project. When pi loaded it (a session in this checkout), nothing changes.

**Doctor**: `mode` (always), `home.exclude`, `home.overlap`,
`project.canonical` (single only); `home.gitignore` and `scaffold.projects`
(multi only).

**`/cp-mode`**: shows the runtime line or saves `single|multi|auto` to the
settings file for the next session start; `single` inside a multi home is
refused. A live switch is out of scope.
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add README.md AGENTS.md docs/contracts.md
git commit -m "docs: two modes — README quick start from a repository, AGENTS.md §Two modes, contracts §Modes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Verify on a real repository, then open the PR

**Files:** none (operator steps).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: A real single-mode session**

In a terminal, `cd` into a real project repository (not this checkout), run `pi`, then in the session: `/cp-version` (expects the single-project line naming the repository), `/doctor` (expects `✓ [mode]`, `✓ [home.exclude]`, `✓ [project.canonical]`, and no `home.gitignore`), `/cp-jobs` (empty), then ask the parent to `cp_job create` a small job without naming a project and confirm `/cp-jobs` lists it with `project:<repo-name>`. Check `git status` in the repository shows nothing new (the dotdir is excluded).

- [ ] **Step 3: The multi home is unchanged**

`cd` into this checkout, run `pi -e extensions/command-post/index.ts`; `/cp-version` says multi-project mode with source `checkout`; `/status` and `/doctor` behave as before; `/cp-mode single` is refused with the overlap reason.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(mode): single-project mode — run the command post inside any repository" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-09-04-single-project-mode-design.md.

- src/mode.ts resolves the runtime once: CP_MODE -> .pi-command-post/settings.json -> repo-aware default; two refusals (no repo; a multi home).
- configureLayout(mode): single mode puts data/ and state/ under .pi-command-post/; multi is unchanged.
- Virtual pinned project; `project` optional on cp_job create, cp_ask, /cp-ask, cp_pipeline start, cp_check.
- The parent's AGENTS.md is injected in before_agent_start when pi did not load it (fixes installed packages too).
- Scaffold excludes the dotdir via .git/info/exclude; the repository is never edited.
- /cp-mode saves a preference for the next start; doctor gains mode/home.exclude/home.overlap/project.canonical.

Verified: a real repository session and the checkout's multi session (see plan Task 11).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
