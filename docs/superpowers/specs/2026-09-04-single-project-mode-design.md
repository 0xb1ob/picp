# Single-project mode — design

Date: 2026-09-04. Status: approved in conversation, pending spec review.
Item 3 of a three-item sequence; assumes item 1
(`2026-09-04-drop-br-ledger-design.md`, both PRs) has landed: the ledger is
`<home>/.pi-command-post/jobs.json`, ids are `job_id`, and `br` is gone. Item 2
(`2026-09-04-package-audit.md`) decided nothing else is replaced.

## Problem

The extension has one shape today: a **multi-project** command post. Its home
is this checkout (or `~/.pi/command-post` for an installed package), every
project is a clone under `projects/<name>`, and the parent dispatches workers
into leased worktrees of those clones. The operator wants a second shape: run
pi inside *any* repository and get the same tools, rules and gates — dispatch,
envelopes, gates, checkpoints, the ledger, doctor, memory — scoped to that one
repository, with nothing cloned and the repository itself untouched.

Two facts shape the design. First, pi loads `AGENTS.md` only from the working
directory, its parents and `~/.pi/agent/AGENTS.md`, never from a package, so a
parent launched outside this checkout runs without its operating contract
today. Second, the layout (`data/`, `state/`, `projects/`) is a frozen constant
read in 20 files and built into the path helpers used by 23 more, so a
second shape has to be chosen once per process, not threaded through.

## Decisions

| # | decision | why |
|---|---|---|
| D1 | **Repo-aware default.** Multi when the working directory is inside this checkout, or `CP_HOME` is set, or the directory is already a multi home; single when it is inside any other git repository; otherwise multi on today's default home. | Operator decision. Installed packages launched outside a repo keep today's behaviour byte for byte. |
| D2 | **In single mode the repository root is the home**, and the layout moves `data/` and `state/` under `.pi-command-post/`. The ledger stays at `.pi-command-post/jobs.json`. No `projects/`. | Operator decision, and the reason the ledger was put in the dotdir in item 1: one directory to exclude, no name clash with the repository's own `data/` or `state/`. |
| D3 | **Layout is configured once per process**: `configureLayout(mode)` produces `LAYOUT`, `paths` and `NEVER_COMMIT_PATHS`; a second call with another mode throws. | Operator choice between this and threading a `Layout` object through ~160 references in 43 files. A process never runs two modes, and `node --test` already isolates suites per process. |
| D4 | **`/cp-mode` saves a preference; it applies at the next session start.** Precedence: `CP_MODE` env, then `.pi-command-post/settings.json` in the launch directory's toplevel, then D1. | Operator decision. Switching a live session would release the parent lock and abandon the fleet view while workers may be running; refusing that is the fail-closed choice. |
| D5 | **The repository is never edited.** Single-mode scaffold appends `.pi-command-post/` to `.git/info/exclude`; the repository's `.gitignore` is not touched. | The scaffold's standing rule is "never rewrite anything you own"; a project's `.gitignore` is the operator's file. `info/exclude` is git's local-only list for exactly this. |
| D6 | **Single mode in a directory that is also a multi home is refused**, and so is single mode where there is no git repository. | Two layouts in one directory would share `jobs.json` while keeping separate fleets and parent locks — two writer processes on one ledger. This checkout therefore stays a multi home and keeps managing itself as `project:pi-command-post`. |
| D7 | **The project is virtual.** One pinned entry derived from the repository; `data/projects.json` is never written; add/update/remove refuse; `project` becomes optional everywhere and any other name is refused. | There is exactly one project, and it is where the session runs. Writing a registry file for it would be a second source of truth for a fact the filesystem already holds. |
| D8 | **The parent's contract is injected by the extension** in `before_agent_start` whenever pi did not load this package's `AGENTS.md` itself. Applies in both modes. | Single mode cannot work without it, and it closes the installed-package gap (Problem, first fact) with the same rule. When the file is already loaded, nothing changes. |
| D9 | **Leases still come from treehouse**, run from the repository root; the canonical-clone traps still run against the repository. | The lease and preflight contracts are the product's safety; single mode changes where the canonical clone is, not what is checked. A launch from a linked worktree or a nested clone is refused with the fix named. |
| D10 | **No worker-side change.** `CP_HOME` carries the repository root; run directories are absolute; a leased worktree never contains the dotdir. | Workers never knew where the home was; they receive paths. |

## Architecture

```
session_start
  └─ resolveRuntime({cwd, env, packageRoot})      src/mode.ts
       │  CP_MODE → settings.json → repo-aware default
       ▼
     configureLayout(mode)                        src/contracts.ts   (once; throws on a second mode)
       ▼
     scaffoldHome(runtime)                        src/scaffold.ts    (single: dotdir dirs, exclude line, jobs.json)
       ▼
     acquireParentLock(home) → sweep → reconcile   unchanged
       ▼
     CommandPost({home, packageRoot, runtime})    src/command-post.ts
       ├─ ProjectRegistry({home, pinned?})        src/projects.ts    (single: virtual, one project)
       └─ every other module: unchanged, reads LAYOUT/paths as today

before_agent_start ── contractInjection(event, packageRoot, runtime) ──▶ { systemPrompt } | undefined
/cp-mode ──────────── ModeSettings.read/write(<toplevel>/.pi-command-post/settings.json)
/doctor ───────────── mode, home.exclude, home.overlap, project.canonical
```

Modules (policy in `src/`, pure and pi-free; adapters in `extensions/`):

- `src/mode.ts` (new): `resolveRuntime(options): Runtime`, the settings file
  reader/writer, `describeRuntime(runtime): string` (the line `/cp-version`,
  `/doctor` and `/cp-mode` print), `contractInjection(...)`.
- `src/contracts.ts`: `configureLayout(mode)`, `LAYOUT`/`paths`/
  `NEVER_COMMIT_PATHS` become its products (same names, same shape in multi
  mode), `ModeSettingsSchema`, `RuntimeSchema`.
- `src/home.ts`: `describeHome` is subsumed by `resolveRuntime`; kept as a
  thin wrapper for its existing callers (`doctor`, `scaffold`, `index.ts`)
  returning the runtime's home and reason.
- `src/projects.ts`: `ProjectRegistryOptions.pinned?: Project`; the virtual
  read; refusals on writes; `assertCanonicalRepo(path)` — the existing traps
  3–5 (toplevel is the path, `.git` is a directory, common dir is that
  `.git`) applied to an absolute path, used by `assertCanonicalClone` when the
  project is pinned.
- `src/scaffold.ts`: the single-mode step list.
- `src/doctor.ts`: the four findings.
- `src/guards.ts`: unchanged in code; `NEVER_COMMIT_PATHS` is now the layout's.
- `extensions/command-post/index.ts`: calls `resolveRuntime` first in
  `session_start`, registers `before_agent_start`, registers `/cp-mode`;
  `project` parameters become optional on `cp_job create`, `cp_ask`,
  `cp_pipeline start`, `cp_check`, and `/cp-ask`, `/status --project`.
- `extensions/command-post/mode-command.ts` (new adapter): `/cp-mode` parse,
  refusals, messages.

## Mode resolution

`resolveRuntime({ cwd, env, packageRoot, git })` returns

```
{ mode: "multi" | "single",
  home: string,
  source: "CP_MODE" | "settings" | "CP_HOME" | "checkout" | "home-dir" | "repo" | "managed",
  reason: string,                       // one operator-facing line
  repo?: { toplevel, name, origin_url?, default_branch } }   // single only
```

Order:

1. `CP_MODE` when set. `single`, `multi` or `auto`; anything else is a
   `ModeError` that ends startup: "CP_MODE must be single, multi or auto".
2. `<toplevel-or-cwd>/.pi-command-post/settings.json`, field `mode`, same
   values. A file that does not parse or carries another value is reported and
   ignored (auto applies), so a typo cannot lock an operator out.
3. `auto`:
   - `CP_HOME` set → multi on `CP_HOME` (`source: "CP_HOME"`).
   - `cwd` inside `packageRoot` and the package is a source checkout → multi on
     the package root (`checkout`).
   - `cwd` has both `projects/` and `state/` → multi on `cwd` (`home-dir`).
   - `git rev-parse --show-toplevel` succeeds → single on the toplevel (`repo`).
   - otherwise → multi on today's default (`managed` for an installed package,
     `checkout` for a source checkout), exactly `describeHome()` today.

Forced `single` (by env or settings) where step 3 finds no repository is a
`ModeError`: "single-project mode needs a git repository; run from inside one
or set CP_MODE=multi". Forced `multi` from inside a repository uses the default
multi home (`CP_HOME`, else managed/checkout).

Refusal D6: whichever path produced `single`, if the toplevel also has
`projects/` and `state/`, startup ends with "this directory is a command-post
home; single-project mode here would share its ledger — run multi mode here
(`/cp-mode multi`) or launch from a project repository".

The repo record: `toplevel` is `git rev-parse --show-toplevel` resolved through
`realpath`; `name` is the toplevel's basename with every character outside
`[A-Za-z0-9_-]` replaced by `-`, truncated to 64, so it satisfies
`PROJECT_NAME_PATTERN`; `origin_url` is `git remote get-url origin` when it
exists; `default_branch` is resolved as today (`origin/HEAD`, else `main`).

## Layout

`configureLayout(mode)` in `src/contracts.ts`:

| key | multi (unchanged) | single |
|---|---|---|
| `runtimeDir` | `.pi-command-post` | `.pi-command-post` |
| `jobsFile` | `.pi-command-post/jobs.json` | `.pi-command-post/jobs.json` |
| `data` | `data` | `.pi-command-post/data` |
| `state` | `state` | `.pi-command-post/state` |
| `projects` | `projects` | `.pi-command-post/projects` (never created) |
| every derived entry (`runs`, `artifacts`, `pipelines`, `checkpoints`, `fleetFile`, `awaitingFile`, …, `routingFile`, `learningsFile`, …) | as today | the same relative name under the single `data`/`state` |
| `migrationsDir` | `state/.migrations` | `.pi-command-post/state/.migrations` |
| `NEVER_COMMIT_PATHS` | `data/ state/ projects/ .beads/ .pi-command-post/` | `.pi-command-post/` |

`LAYOUT`, `paths` and `NEVER_COMMIT_PATHS` keep their names and are still
imported everywhere. Before `configureLayout` runs they hold the multi values
(so every existing test and every multi-mode path is unchanged); the first
call sets the mode and freezes; a call with a different mode throws
`ContractError("layout already configured for <mode>")`. `paths.*` read
`LAYOUT` at call time, which they already do.

## The project in single mode

`ProjectRegistry` gets `pinned?: Project`. When set: `read()` returns
`{ projects: [pinned] }` without touching disk; `list/get/require/names/pathOf/
originUrl/ensureClone` answer for it (`ensureClone` verifies and returns the
path, never clones); `register/update/remove` throw
`ProjectError("single-project mode: this session manages <name> only")`;
`assertCanonicalClone(name)` runs `assertCanonicalRepo(pinned.path)` — traps
3–5 of the existing check. Trap 1 (`<home>/projects/<name>`) and trap 2
(`~/<name>` symlink) are multi-mode traps and do not apply.

The pinned project: `{ name, clone_url: origin_url ?? toplevel, path:
toplevel, delivery: origin_url ? "pr" : "local", registered_at: <session
start>, base_branch: default_branch }`. `ProjectSchema.path` keeps its
description but the cross-field rule "path must be `projects/<name>`" applies
only to registry *files*, which single mode never writes.

`project` parameters: on `cp_job create`, `cp_ask`, `cp_pipeline start`,
`cp_check`, `/cp-ask <project> <question…>` and `/status --project`, single
mode fills in the pinned name when omitted and refuses another name with
"single-project mode: this session manages <name> only". Multi mode keeps
today's requirements. `cp_project add|update|remove` refuse as above;
`list`/`show` work.

Leases: `LeaseManager.acquire(toplevel, …)` from the repository root; the
treehouse pool and `CP_TREEHOUSE_ROOT` behave as today. `release` already
refuses when the home or the process cwd is inside the worktree; neither is.

Guards: unchanged code. With the home at the repository root,
`bulk_stage_in_home` now blocks a parent-typed `git add -A` or `git commit
-a` in the repository, and `never_commit_path` covers `.pi-command-post/`.
Both match "the parent never does a worker's job".

## Contract injection

`contractInjection(event, { packageRoot, runtime })` is pure over the
`before_agent_start` event:

- If `event.systemPromptOptions.contextFiles` contains an entry whose `path`
  resolves (realpath) to `<packageRoot>/AGENTS.md`, return `undefined`.
- Otherwise return `{ systemPrompt: event.systemPrompt + "\n\n" + preamble +
  contents of <packageRoot>/AGENTS.md }`, where `preamble` is empty in multi
  mode and, in single mode, three lines: `# Command post — single-project
  mode`, `This session manages exactly one project: <name> at <toplevel>.`,
  `Every project argument defaults to it; another name is refused.`
- The file is read once per session and cached; a missing file is a `warn`
  notify at session start, not a crash.

The repository's own `AGENTS.md`, loaded by pi from the working directory,
stays in the parent's context; nothing here removes it.

## `/cp-mode`

- No argument: prints `describeRuntime(runtime)` — mode, home, source, reason
  — and the settings file path, then the effect of each value.
- `single | multi | auto`: writes `{ schema_version: 1, mode }` to
  `<toplevel-or-cwd>/.pi-command-post/settings.json` (atomic write; creates the
  dotdir; in a repository also ensures the exclude line), then prints "saved;
  takes effect at the next session start".
- `single` from inside a multi home: refused with the D6 message; nothing
  written.
- Never changes the running session.

`CP_MODE` is documented as the override that wins over the file.

## Scaffold

Single mode steps, in order: `dir.runtime`, `dir.data`, `dir.state` (both
under the dotdir), `exclude` (append `.pi-command-post/` to
`.git/info/exclude` when missing; `present` when there), `routing.default`
(copied into the dotdir's data), `ledger`. No `dir.projects`, no `gitignore`.
Idempotent and silent on the second run, as today.

## Doctor

| check | severity | when |
|---|---|---|
| `mode` | ok | always: `single-project mode on <toplevel> (source: settings)` or `multi-project mode, home <path> (source: checkout)` |
| `home.exclude` | warn | single: `.git/info/exclude` lacks `.pi-command-post/`; fix: "start a session (the scaffold appends it) or add the line" |
| `home.overlap` | error | single: the toplevel also holds `projects/` and `state/`; fix: the D6 message |
| `project.canonical` | error | single: the repository fails a repo trap (linked worktree, nested clone, foreign common dir); fix: "launch from the main worktree of the repository" |

`home.gitignore` runs in multi mode only. `home.location` keeps its meaning
and prints the runtime's reason.

## Contract additions (`src/contracts.ts`)

- `MODES = ["multi", "single"]`, `ModeSchema`; `MODE_SETTINGS = ["single",
  "multi", "auto"]`, `ModeSettingsSchema = { schema_version, mode }`,
  `validateModeSettings`.
- `RuntimeSchema` (`mode`, `home`, `source`, `reason`, `repo?`),
  `validateRuntime`.
- `configureLayout(mode)`, `currentLayoutMode(): Mode | undefined`.
- `ENV_MODE = "CP_MODE"`.

## Testing

- `tests/mode.test.ts`: a table of cases (env, settings file, directory shape,
  expected mode/home/source), the two refusals, the invalid `CP_MODE`, an
  unparseable settings file falling back to auto, the repo record's name
  sanitisation (`my.repo` → `my-repo`), `configureLayout` idempotence and the
  throw on a second mode, single-layout paths.
- `tests/scaffold.test.ts`: single mode over a scratch git repo; exclude line
  appended once, never duplicated; no `projects/`, no `.gitignore` write.
- `tests/projects.test.ts`: the pinned registry (virtual read, refusals, no
  file written); `assertCanonicalRepo` against real scratch repos — the main
  worktree passes, a linked worktree and a nested clone refuse.
- `tests/contract-injection.test.ts`: injects when the package `AGENTS.md` is
  absent from `contextFiles`; returns `undefined` when present; single-mode
  preamble; missing file handled.
- `tests/mode-command.test.ts`: `/cp-mode` parse, print, write, the D6
  refusal, "next session start" wording.
- `tests/doctor.test.ts`: the four findings; golden regenerated.
- `tests/jobs-tool.test.ts`, `tests/ask.test.ts`, `tests/pipeline.test.ts`,
  `tests/preflight.test.ts`: `project` omitted in single mode resolves to the
  pinned name; another name is refused; multi mode still requires it.
- `tests/e2e/single-mode.test.ts`: a real pi child inside a scratch git repo
  with the extension loaded: `/cp-version` says single, the scaffold block
  appears once, `/doctor` is green, `cp_job create` without a project
  succeeds; with treehouse on PATH one scripted dispatch leases from the repo
  and reports an envelope.

## Out of scope

- A live mode switch.
- More than one project in single mode.
- Migrating an existing multi home's `data/`, `state/` or ledger into a
  repository (or back).
- A `--cp-mode` command-line flag; `CP_MODE` and the settings file cover it.
- Any change to the worker extension, the briefs or the profiles.
- Removing the repository's own `AGENTS.md` from the parent's context.

## Task order

1. Contracts: `configureLayout`, `MODES`, settings and runtime schemas; tests
   proving multi is byte-identical before and after configuration.
2. `src/mode.ts`: `resolveRuntime`, settings reader/writer, `describeRuntime`;
   `home.ts` wrapper; tests (the matrix and the refusals).
3. `src/projects.ts`: pinned registry and `assertCanonicalRepo`; tests with
   scratch repos.
4. `src/scaffold.ts` single-mode steps and the exclude line; tests.
5. `src/doctor.ts` findings; golden.
6. `contractInjection` and the `before_agent_start` registration; tests.
7. `/cp-mode` adapter; tests.
8. `project` optional across tools and commands; tests.
9. Session-start wiring (`resolveRuntime` first, then layout, scaffold, lock),
   `/cp-version` line; the e2e suite.
10. Docs: README (two modes, quick start from a repository), AGENTS.md (one
    paragraph on single mode and the `project` default), `docs/contracts.md`
    §Directory layout and a new §Modes.
