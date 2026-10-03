# Storage: where every command-post file lives

**One way only.** Every kind of file has exactly one location and one
definition. There are no fallbacks, aliases, legacy paths, symlinks or stored
copies of a derived value. The structure ratchet (`tests/structure.test.ts`)
and `/doctor`'s `storage.*` checks enforce it. This page is binding for code,
the parent, workers, the operator session and tests.

Decided in cp-u3i2 (storage blueprint, PRs 1–3). Where this page and the code
disagree, the code wins and this page is the bug.

## The home and its one root

The **home** is the command post's working directory: the standard home
`~/.pi-command-post` (the code at `~/.pi-command-post/app`, or an installed pi
package), `CP_HOME`, or a source checkout (single-project mode was removed;
a plain git repository is refused as a home). Everything command-post owns in a home
lives under **one runtime root**. The rule is one, decided by the path alone,
never by probing, with no fallback or alias:

- a home whose own basename is `.pi-command-post` (the standard home) **is**
  its runtime root (`runtimeDirFor(home)` is `""`);
- every other home keeps it in one gitignored directory,
  `<home>/.pi-command-post/` — checkout homes and `CP_HOME` homes.

```text
<runtime root>/     = ~/.pi-command-post/ (standard) or <home>/.pi-command-post/
  data/        durable machine-local config and memory
  state/       runtime and fleet records, owned by code and the parent
  projects/    canonical clones
  operator/    the operator session's workspace
    tasks/  handoffs/  reports/<topic>/  scratch/
  jobs.json  jobs-legacy-fields.jsonl  settings.json
~/.pi-command-post/app/  the standard home's code checkout (not state; never a home itself)
<home>/.beads/ br's frozen archive; br owns it, command-post only reads it
```

Resolution (`src/home.ts` `describeHome`): `CP_HOME` wins; then the standard
app (`<$HOME>/.pi-command-post/app`) and an installed pi package both resolve
the standard home; any other source checkout is its own home. A standard home
is not a repository: the scaffold makes no dotdir and no `.gitignore` there.
Before the mode is known (`settingsPath`, `isMultiHomeDir` in `src/mode.ts`) a
directory is read flat only when it is named `.pi-command-post`, is not a git
repository (a repository keeps `<repo>/.pi-command-post/`
whatever it is called), and is not another home's nested root
(`enclosingHome`); resolution then goes on to git toplevel detection. A home
configured at another home's nested root is flat by name; `storage.alias` warns
and names the parent to use instead.

- The layout is defined once, in [`src/contracts/layout.ts`](../src/contracts/layout.ts):
  `LAYOUT` (`data`, `state`, `projects`, `operatorWorkspace`, `runtimeDir`, every
  `*File`) and `paths.*`, configured per process by `configureLayout(mode, home)`.
  A flat root is `layoutFor("multi", "")`.
- `.gitignore` has exactly two runtime entries, `.pi-command-post/` and
  `.beads/`. `NEVER_COMMIT_PATHS` is `[".pi-command-post/", ".beads/"]`.
- A project's clone path is never stored: `paths.projectDir(name)` derives it,
  and a `data/projects.json` record carrying `path` is refused.
- The shipped routing template has one location, the tracked
  `defaults/routing.default.json`; the scaffold copies it once to
  `data/routing.json`.
- **Prose convention.** In docs, briefs, tool results and this page, `data/…`,
  `state/…`, `projects/…` and `operator/…` mean
  `<runtime root>/data/…` and so on. Nothing else is meant by them.

### Why `operator/` and not `state/operator/`

`state/` is code-and-parent territory: the operator note says "never touch
`state/`", task-reference snapshots skip it, and its records are facts written
by tools. The operator session's own notes are authored material, so they get
their own sibling. `state/operator/` keeps only what code writes on the
operator session's behalf (the ask journal, the escalation-relay ledger and `self_compact` handoffs).

## Inventory

Class: **V** versioned, **H** home-local (under `<home>/.pi-command-post/`
unless named otherwise), **M** machine-local outside the home, **T** temp.
Writers name files, not line numbers, so this table does not rot on every edit.

### Versioned

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `src/ extensions/ docs/ profiles/ prompts/ skills/ tests/ viewer-app/ scripts/ bin/ evals/ defaults/ *.md` | git | source, docs, prompts, tests | V | implementer workers in a worktree, via PR; the operator, via PR |
| `evals/results/contract.json` | `scripts/eval.ts --out` | committed eval result | V | a worker or developer in a worktree |
| `defaults/routing.default.json` | git | shipped default rubric | V | PR only |

### `<home>/.pi-command-post/data/`

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `routing.json`, `mandate-defaults.json` | `src/scaffold.ts`, `src/mandate-defaults.ts` | policy, copied once | H | code; the operator edits |
| `projects.json`, `projects.md` | `src/projects.ts` | registry (no stored path) and its rendered view | H | code (`cp_project`) |
| `budgets.json gate.json worker-bounds.json suggest.json quality.json capacity.json parent.json operator.json` | read-only in code (`src/gate.ts`, `src/bounds.ts`, `src/suggest.ts`, `src/quality.ts`, `src/quota.ts`, `src/parent-context.ts`, `src/operator-compact.ts`); `capacity.json` (0600) is also written by `src/service/gateway.ts` (`cp-install --gateway-url`: once, or its `url` with `--force`) | operator knobs; `compact_at_tokens` in `parent.json`/`operator.json` defaults to 200000 when the file is absent | H | the operator, by hand; the install for `capacity.json` |
| `standing-orders.md` | `src/parent-context.ts` (created once) | parent preference template | H | code once, then the operator or the operator session |
| `learnings.md candidates.md archive.md curation.jsonl` | `src/memory.ts`, `src/curation.ts` | memory tiers | H | code (`cp_memory`) |
| `trackers.json` | `src/trackers/config.ts` | tracker connections (an endpoint may name `<home>/.beads/beads.db`) | H | code (`cp_tracker`) |
| `push/config.json`, `push/vapid.key` (0600) | `src/push/keys.ts` via `npm run push:init` | Web Push origin and keys | H | code, operator-run |
| `push/subscriptions/<id>.json` (0600) | the **viewer**: `src/viewer/push-subscriptions.ts`; the parent: `src/push/sweep.ts` (removes a gone device) | one subscribed device each | H | code: a viewer request-time write, and the push sweep |
| `dashboard-control.json` (optional) | read-only in code (`src/viewer/control-files.ts`) | the dashboard-control opt-out: only `{"enabled": false}`; absent is on | H | the operator, by hand |
| `update.json` (0600) | `src/service/install.ts` (written once, only when absent; `--no-update` → `enabled: false`) | the auto-update switch `{enabled, interval_min}`: absent is off, invalid is `config_invalid` (read by `src/service/update.ts`, `docs/service.md` §Auto-update) | H | install once, then the operator |
| `daemon.json` (0600) | `src/service/install.ts` (`--force` replaces a changed one; `--uninstall` and a failed migration remove it); read by `src/service/daemon-files.ts` | the cp-daemon config `{schema_version, generated_by, backend, node, app, home, path, port, viewer_host?, parent_model?}`; invalid names the bad field and cp-daemon exits 78 | H | install only |

### `<home>/.pi-command-post/state/`

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `fleet.json escalations.json awaiting.json answered.json wakeups.json answer-cards.json ci-watch.json status-block-shipped.json` | `src/fleet.ts`, `src/escalation.ts`, `src/awaiting.ts`, `src/answered.ts`, `src/wakeup-outbox.ts`, `src/answer-delivery.ts`, `src/ci-watch.ts`, `src/shipped-seen.ts` | fleet and outboxes | H | code only |
| `parent.lock`, `parent-host.<gen>.json/.sock`, `parent-host.log` | `src/parent-lock.ts`, `src/parent-host.ts` | one-parent lock, host records | H | code only |
| `parent-host.stopped.json` (0600) | `src/parent-host.ts` (the `stop` op, before the host exits) | `{gen, at}`: the generation an operator stop closed; the parent supervisor never respawns it (`docs/service.md`) | H | code only |
| `health.json` | `src/service/health.ts` (run by cp-daemon, a oneshot: its only writer), atomic replace | the watchdog's record: `{schema_version, last_run_at, checks: {<name>: {status, key, since, detail, fails, notified_key, notified_state, push_attempts, checked_at}}}`; read by `/doctor` `service.health` and the Overview status line | H | code only |
| `update.json` | `src/service/update.ts` (run by cp-daemon, a oneshot: its only writer), atomic replace | the updater's record: `{schema_version, phase, last_run_at, last_result, since, detail, from, to, lock, bad_sha, fetch_failures, behind, held, updated_at}`; `bad_sha` is set only by `rolled_back`; `phase` ≠ `idle` is a run in flight (or one that died: the next run rolls back), except `held: true`, a rollback live workers held back with no run in flight; read by cp-health (`update` check, parent/viewer suppression, never for `held`) and `/doctor` `service.update`; remove it by hand only after a `rollback_failed` | H | code only |
| `daemon.lock`, `daemon.json` (0600), `daemon.sock` (0600) | `src/service/daemon-outer.ts` (the cp-daemon outer; O_EXCL lock, atomic replace, removed at its stop) | one-daemon-per-home lock `{pid, started_at, argv}`; the outer's record `{schema_version, protocol, pid, state, started_at, backend, outer_hash, token, socket, inner, last_reload}`; the token-authenticated control socket | H | code only |
| `daemon-runtime.json` | `src/service/daemon-runtime.ts` (the cp-daemon inner), atomic replace | per-unit pids, states, start history, viewer hold and the health/update `next_due` timers | H | code only |
| `daemon.log`, `daemon.prev.log` | `src/service/daemon-outer.ts` (the outer's and children's output; over 5 MiB copied to `daemon.prev.log` and truncated) | the cp-daemon log, read by `cp-daemon log` and the reload/start failure tails | H | code only |
| `daemon-crontab.tmp` | `src/service/daemon-backend.ts` (`cp-install --crontab`, removed after `crontab <file>`) | the new crontab, handed to `crontab` as a file | H | code only |
| `drain.json schedules.json tracker-sync.json push-deliveries.json wakeup-replay.json bridge-retry.jsonl main-ci.json` (`bridge-retry.jsonl` is the outer-retry journal, including `outer_retry_reservation_failed`) | `src/drain.ts`, `src/scheduler.ts`, `src/trackers/sync-store.ts`, `src/push/deliveries.ts`, `extensions/command-post/wakeup-surfaces.ts`, `src/cp-bridge.ts`, `src/main-ci.ts` | runtime records | H | code only |
| `tracker-tasks/<id>.md` | `src/trackers/import.ts` | imported task text | H | code |
| `repo-map/<project>/<commit>.md` | `src/repo-map.ts` | repo-map cache | H | code |
| `runs/<id>/…` (brief, tasks, events, status, gate/review/quality runs, merge, integration, questions, …) | `src/dispatch.ts`, `src/recovery.ts`, `src/run-artifacts.ts`, `src/gate.ts`, `src/diff-review.ts`, `src/quality.ts`, `src/pipeline.ts`, `src/supersede.ts`, `src/questions.ts`, `src/task-addenda.ts`, `src/script-runner.ts`, `src/final-fix.ts`, `src/plan-followup.ts` | per-job run records, reviewer scratch | H | code; a **worker** writes `envelope*.json` and a reviewer `verdict*.json` only through `extensions/worker-reporter/` |
| `artifacts/<id>/report.md` | the **worker's** artifact heredoc (`prompts/briefs/brief-research.md`, `brief-qa.md`); `src/artifacts.ts`, `src/intake.ts`, `src/teardown.ts` | research/QA artifact | H | the worker writes; the parent moves or deletes it, never reads it |
| `artifacts/<id>/board.json`, `site/**` | the **worker** (`brief-research.md`, delivery:board) | a board's source | H | worker |
| `boards/<slug>/board.json`, `site/**` (staged in `boards/.publishing-*`) | `src/board-delivery.ts`, from `src/intake.ts` | published board, served read-only | H | code (intake) |
| `viewer-dist/*` | `src/viewer/build.ts` (viewer startup, `npm run build:viewer`) | viewer bundle | H | code |
| `pipelines/ checkpoints/ mandates/` | `src/pipeline.ts`, `src/checkpoint.ts`, `src/mandate.ts` | links, authorizations, mandates | H | code (parent tools) |
| `sessions/` (worker transcripts, `cp-parent.jsonl`, `cp-parent-control.json`, `cp-parent-context.json`, `cp-parent.sends.json` (per send: optional `outer_retry_attempts`, the spent transient-retry budget), `operator-sessions.jsonl`) | pi via `--session-dir` (`src/dispatch.ts`, `src/gate.ts`, `src/diff-review.ts`, `src/quality.ts`); `src/cp-bridge.ts`; `src/parent-context.ts`; the operator session record (`extensions/cp-bridge/index.ts` writes it through `src/operator-session-log.ts`, `src/viewer/operator-sessions.ts` reads it) | transcripts, bridge control | H | pi and code |
| `model-windows.json` | `src/model-windows.ts` (parent session start, from pi's model registry); `src/viewer/context-usage.ts` reads it | model-window snapshot for the viewer's context chips | H | code only |
| `operator/asks.jsonl`, `operator/compact-<iso>.md`, `operator/escalation-relays.json` | `extensions/cp-bridge/index.ts`; `src/operator-compact.ts`; `src/escalation-backstop.ts` (called from `extensions/cp-bridge/index.ts`) | operator-ask journal, compaction handoffs, the escalation ids relayed to the operator session (bridge or backstop) | H | code running in the operator session; never hand-written |
| `operator/dashboard.json` (0600), `operator/dashboard.sock` (0600) | `src/dashboard-control.ts` (in the operator session, at `session_start`) | the dashboard-control record (pid, socket token, CSRF token) and socket | H | code running in the operator session; removed at its shutdown |
| `operator/dashboard.jsonl` (0600) | `src/dashboard-control.ts` (request/outcome lines) and the **viewer**: `src/viewer/control-audit.ts` (refused and Start-session `start` lines), both through one `O_APPEND` write per line | the dashboard-control audit journal, append-only; no rotation yet (bounded by the 20-per-minute rate limit) | H | code only |
| `operator/inbox.jsonl` (0600) | the **viewer** (`held` lines, `src/viewer/control-audit.ts`) and the operator session (`delivered`/`dropped`, `src/dashboard-control.ts`), one `O_APPEND` write per line | composer messages held while no operator session runs (at most 20 waiting), delivered once at the next `session_start`; older than 24 h dropped, never injected | H | code only |
| `schedule-control.jsonl` (0600) | the **viewer** (`request` lines, `src/viewer/control-audit.ts`) and the parent (`claimed`/`outcome`, `src/schedule-control.ts` through the same writer), one `O_APPEND` write per line | Schedules page requests and their outcomes (cp-hhuf P6); no rotation yet (rate-limited) | H | code only |
| `.migrations/` | `src/state-migrations.ts` | one-shot markers | H | code |

### Other home-local

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `<home>/.pi-command-post/projects/<name>/` | `src/projects.ts` (clone on demand) | canonical clones | H | code only |
| `<home>/.pi-command-post/operator/{tasks,handoffs,reports/<topic>,scratch}/` | nothing in code | the operator workspace | H | the **operator session** and the human only |
| `<home>/.pi-command-post/jobs.json`, `jobs-legacy-fields.jsonl`, `settings.json` | `src/ledger.ts`; `settings.json` is read-only in code (`src/mode.ts`) | ledger, mode preference | H | code (`cp_job`); settings.json: operator |
| `<home>/.beads/` | br only; code reads it (`src/doctor.ts`, `src/ledger-import.ts`) | frozen br archive / read-only tracker DB | H | nobody through command-post |
| `<package-root>/USER.md` | the operator, by hand | optional context (gitignored) | H | the operator only |

### Outside the home

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `${PI_HOME:-~/.pi}/command-post/operator-targets/<sha>.json`, `selected.json` | `extensions/cp-bridge/index.ts` | the operator session's target selector (the only thing left in the retired managed home) | M | code in the operator session |
| `~/.pi/agent/**` | pi | pi settings, auth, packages | M | pi |
| `~/.pi-lens` (`PI_LENS_HOME`) | env set by `src/worker-packages.ts` | pi-lens logs | M | pi-lens |
| `~/.treehouse/<pool>/<n>/<repo>/` or `$CP_TREEHOUSE_ROOT` | treehouse, via `src/leases.ts` | **worker worktrees** | M | treehouse; each worker only inside its own lease |
| `~/.local/bin`, installers | `src/install-tools.ts` via `scripts/install-tools.ts` | host tools | M | third-party, operator-initiated |
| `${XDG_CONFIG_HOME:-~/.config}/systemd/user/cp-daemon.service` | `src/service/install.ts` (rendered by `src/service/units.ts`; the systemd backend only) | the thin unit that runs cp-daemon (`docs/service.md`). The legacy `cp-parent`/`cp-view`/`cp-health`/`cp-update` units are removed by the migration (`daemon-backend.ts`); a generated `cp-operator.service`/`cp-operator-resume.service` an older install wrote is removed, never stopped, by the install (on a legacy home: by the migration at its success) (cp-rrye: Start in tmux runs tmux directly) | M | the install only; a changed unit is replaced only with `--force` |
| `~/.local/bin/cp-operator` | `src/service/install.ts` | the generated operator wrapper (`CP_HOME`, multi mode, the service viewer, the pinned `CP_PARENT_MODEL`/`CP_OPERATOR_MODEL`) | M | the install only; same `--force` rule |
| `${XDG_CONFIG_HOME:-~/.config}/pi-command-post/gateway.env` (0600, dir 0700) | `src/service/gateway.ts` (`cp-install --gateway-key-file`, atomic replace) | the optional gateway admin key, `CP_GATEWAY_ADMIN_KEY=<key>`; read by the parent host (`src/gateway-key.ts`), never by a unit or a worker; kept by `--uninstall` | M | the install; the operator |

### Temp and shell redirections

| Path | Writer | What | Class | Who may write |
|---|---|---|---|---|
| `$TMPDIR/cp-hermetic-pi-home-*` | `tests/harness/hermetic-env.ts` (removed on exit) | scratch `PI_HOME` per test process | T | tests |
| `$TMPDIR/cp-home-*`, `cp-wt-*`, `cp-bridge-*`, … | `tests/harness/state.ts`; `mkdtempSync(join(tmpdir(), …))` in test files | test homes, repos, worktrees | T | tests |
| `cat > "${artifact_path}" <<'EOF'` | `brief-research.md`, `brief-qa.md` (recognized by `src/watch.ts`) | the sanctioned planner/QA write | — | worker |
| commit / PR body file | `brief-ship.md`: written with the `write` tool for `git commit -F` / `gh pr create --body-file`, location not stated | ship worker scratch | — | worker (see Known gaps) |

## Who writes where

- **Implementer:** only inside its leased worktree, plus `report_result`.
- **Planner and QA:** only the artifact heredoc.
- **Reviewers:** only `report_verdict`.
- **Parent:** only through its tools.
- **Operator session:** only in `<home>/.pi-command-post/operator/` and `data/standing-orders.md`, plus `cp_parent`.
- **Tests:** only in their own `mkdtemp` roots.
- **Nobody** writes ad hoc to `$HOME`, the `/tmp` root, sibling repositories or
  another home.

## Temp

One `mkdtempSync(join(tmpdir(), "cp-<purpose>-"))` root per process, removed
on exit. Never a fixed `/tmp/<name>`. Runtime code uses none.

## Adding a path

Use a `LAYOUT` field, a `paths.*` helper, or `join(home, LAYOUT.<root>, …)`;
never a literal root. A new location outside the home needs a change to this
page plus an R2 allowlist entry. `tests/structure.test.ts` enforces three
rules over `.ts`/`.tsx`/`.mjs` files, skipping comment lines; every allowlisted
file must still hit, so an allowlist never outlives its reason:

- **R1, literal home root:** `join|resolve(x, "state|data|projects…")` in
  `src/`, `extensions/`, `scripts/` and `tests/`. Allowlisted: a few test files
  that build the old layout on purpose, to prove it is ignored or flagged.
- **R1b, literal runtime dotdir:** `join|resolve(…".pi-command-post"…)` in
  `src/`, `extensions/` and `scripts/`, except `src/contracts/layout.ts` and the
  contracts-free `src/viewer/`.
- **R2, outside the home:** `homedir(` / `tmpdir(` in `src/`, `extensions/` and
  `scripts/`, allowlisted per file. `tests/` follows the temp rule instead.
- **Known limit:** template strings and multi-segment joins are not caught.

## `/doctor` checks

Warn-only; each finding names its fix ([`src/storage.ts`](../src/storage.ts)):

- **`storage.state`:** a regular file at the top of `state/` whose name does
  not end in `.json`, `.jsonl`, `.lock`, `.sock`, `.log` or `.tmp` — operator
  material that belongs in `operator/`.
- **`storage.home`** (multi mode only): in a checkout home, untracked paths
  that `.gitignore` does not cover (`git ls-files --others --exclude-standard
  --directory`); in a home without `.git`, any top-level entry other than
  `.pi-command-post/`, `.beads/`, `.gitignore` and `operator-targets/` — or, in
  a flat standard home, other than the layout's own top-level entries,
  `settings.json`, `app/`, `.beads/` and `operator-targets/`. A leftover
  top-level `data/`, `state/` or `projects/` in a nested home shows up here.
- **`storage.alias`** (multi mode only): a flat-named home whose parent is
  itself a home (`enclosingHome`: it has `.beads/`, or a `.gitignore` or
  `.git/info/exclude` listing `.pi-command-post/`) — the session was pointed
  (by `CP_HOME`, a setting or a launch directory) at another home's runtime root.
- **`storage.handoffs_dir`:** `data/operator.json` is not valid JSON, or its
  `handoffs_dir` is outside the home.
- Otherwise one `storage` ok.

## `BEADS_DIR` and `.beads`

`.beads/` stays at `<home>/.beads/` — in the standard home that is
`~/.pi-command-post/.beads/`, beside the runtime entries. It is br's directory, not command-post's:
code only reads it (`br --db … --no-auto-flush --no-auto-import`), and
`/doctor`'s `ledger.beads_archive` reports it: ok while an active tracker
connection's endpoint lives under it (live tracker state, never delete), the
"frozen archive, safe to delete" warning only when none does. `BEADS_DIR` is not a stored
setting: dispatch derives it per worker from the project's tracker
(`projectBeadsDb`: an active connection's `endpoint`, else
`<clone>/.beads/beads.db`, never the home's own `.beads`). Moving `.beads/`
would force rewriting `data/trackers.json` and every recorded `br --db` path,
and a stale hand-typed `br --db <old path>` silently creates an empty database.
So `.gitignore` and `neverCommitFor("multi")` keep `.beads/`, and `storage.home`
treats it as known.

## Moving an old multi home

A multi home from before cp-u3i2 kept `data/`, `state/` and `projects/` at the
top level. There is no compatibility read, no fallback and no shipped
migration: the operator moves such a home once, by hand, drained and with the
parent and viewer stopped. `storage.home` flags a home that has not moved.

## Known gaps

1. **Test `/tmp` litter.** Test roots are not always removed, and leaked
   `tests/fixtures/fake-parent.mjs --mode rpc` processes have been seen.
2. **Worker scratch.** `brief-ship.md` names no location for the commit/PR body
   file, and ship and research workers have written ad hoc `/tmp` files (logs,
   scripts) that no brief sanctions.
3. **Stale operator targets.** `operator-targets/<sha>.json` files are never
   pruned.
4. ~~**Managed-home path doubling.**~~ Closed (cp-daemon v1 P1): an installed
   package now uses the flat standard home `~/.pi-command-post`, and the
   managed `~/.pi/command-post` holds only `operator-targets/`.
