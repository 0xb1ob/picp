# Drop br: an in-house job ledger — design

Date: 2026-09-04. Status: approved in conversation, pending spec review.
Item 1 of a three-item sequence (2: audit in-house code against pi.dev
packages; 3: a single-project mode). Items 2 and 3 get their own specs and
assume this one has landed.

## Problem

The parent records every job in `br` (beads_rust), an external Rust binary the
operator must install at one targeted version. Everything the parent needs from
it is small: create a job with labels, read it back, list by label and status,
know whether it is blocked, claim it, comment on it, link a dependency, close it
with a reason. The cost is not small: a fourth required binary with its own
installer and version floor, six `/doctor` checks about that binary, an
envelope-shape contract we re-pin on every br release, a bash surface the model
types by hand (`br create`, `br ready --json`, `br close --reason`) that a
tool-call guard has to police, and fifteen test suites that self-skip wherever
`br` is not on PATH — which is CI.

The operator wants it gone, replaced by something lighter, with no additional
CLI to install. A survey of the 5,458 packages on pi.dev (2026-09-03) found no
local ledger that offers labels, blocking dependencies, close reasons,
comments, a configurable id prefix, a per-home store and an importable
TypeScript API without an external binary; the two closest (`stepstone`,
`@tintinweb/pi-tasks`) each lack half of that list, and every beads wrapper
still shells out to `bd`. So the ledger is written in-house, over the atomic
JSON store the fleet file already trusts.

## Decisions

| # | decision | why |
|---|---|---|
| D1 | **In-house JSON ledger**, one document per home, no new dependency. | No pi.dev package is a drop-in (see Problem). Wrapping the closest one would mean a sidecar store for labels, comments and close reasons — two files for one job. |
| D2 | The document lives at **`<home>/.pi-command-post/jobs.json`**, not under `state/`. | Operator decision: a single-project home (item 3) gets one dotdir that is easy to ignore, with no `state/` name clash against the project's own tree. In the multi-project home the dotdir sits beside `data/` and `state/`; item 3 may move those under it. |
| D3 | **`br_id` is renamed `job_id` everywhere**, including persisted files, with a one-shot state sweep. | Operator decision, taking the larger scope knowingly: no `br` left in the codebase once br is gone. |
| D4 | The rename lands **first**, as its own PR, while br is still the backend. | Mechanical and behaviour-free, so it reviews as a rename. The ledger then lands on clean names and AGENTS.md changes once. |
| D5 | **Only open jobs are imported** from `.beads/`; closed rows stay there as a frozen archive. | Operator decision. Today that is three jobs. Closed history is not queried by anything that matters enough to carry 207 rows across. |
| D6 | The model's surface is **one tool, `cp_job`**, with an `action` parameter; the operator's is **`/cp-jobs`**. No bash. | Matches every other `cp_*` tool; arguments are typed at the boundary instead of parsed by a CLI; the guard no longer has to recognise `br` argv. |
| D7 | `cp_job close` and `cp_job drop` **refuse a job whose fleet record has a live worker** and name `cp_teardown`. The `Ledger` class itself does not refuse. | The model is the only caller that could close a job under a running worker. Trusted code paths close legitimately while a worker lives: the pipeline closes a research job after a gate pass, before the planner is torn down. |
| D8 | `ready` and `blocked` are **computed from `blocked_by`**, never asked of a binary, and have no page size. | The `--limit 0` rule exists because br's default page made dispatch fail open (cp-i2s). A computed query cannot page. |
| D9 | Id minting moves in-house: `<prefix>-<4 lowercase base36>` or `<prefix>-<slug>-<4>`, collision-checked. `CP_LEDGER_PREFIX` keeps its meaning and its refusal. The prefix is **recorded in the document**. | Ids are branch names and run-directory names; the pattern and prefix constraints stay exactly as constrained today. Recording the prefix stops a home from silently switching namespaces mid-life. |
| D10 | The tool-call guard's `br` branch and its `ledger_inlines_artifact` code **retire**. `.beads/` **stays** on the never-commit list; `.pi-command-post/` joins it. | The store never holds an artifact body (T19), so `show` is safe by construction. `.beads/` remains on disk as an archive and must still never be committed. |
| D11 | The choreography around close is **unchanged**: teardown leaves the close to the parent, integrate closes on its own. | Replacing br is not a licence to redesign teardown. Folding the close into teardown is recorded as a follow-up. |
| D12 | Statuses are `open`, `in_progress`, `deferred`, `closed`. br's `tombstone` is dropped. Types and priority (0–4) are kept as optional fields. | Everything the parent reads or writes today; nothing it does not. |

## Architecture

```
model ──▶ cp_job (typed actions) ──▶ Ledger ──▶ <home>/.pi-command-post/jobs.json
operator ──▶ /cp-jobs (ready | list | show | import-beads) ──▶ Ledger
cp_pipeline / cp_ask / cp_integrate / cp_dispatch / status ──▶ Ledger (class, direct)
                                                                    ▲
                                       .beads/issues.jsonl ──▶ ledger-import (open rows only, once)
state/** (br_id) ──▶ state-migrations (rename sweep, once) ──▶ state/** (job_id)
```

Modules (policy in `src/`, pure and pi-free; adapters in `extensions/`):

- `src/ledger.ts` (rewritten): the `Ledger` class over the document. Same
  public methods as today (`create`, `show`, `list`, `ready`, `blocked`,
  `history`, `update`, `claim`, `close`, `drop`, `comment`, `addDep`,
  `removeDep`, `blockersOf`), same `LedgerError`. Options shrink to
  `{ home, actor?, now?, knownProjects?, random? }`; `cwd`, `brBin`, `db`,
  `timeoutMs`, `runner`, `env` go. Id minting (`mintJobId`) lives here.
- `src/ledger-import.ts` (new): reads `.beads/issues.jsonl` directly, maps
  open rows onto job records, refuses duplicates. No br binary involved.
- `src/state-migrations.ts` (new, PR 1): the `br_id` → `job_id` sweep with its
  marker file, plus the doctor check that reports an unswept home.
- `src/contracts.ts`: `JobSchema`, `JobsDocumentSchema`, `JOB_ID_PATTERN`,
  `JobIdSchema`, `isSafeJobId`, `LAYOUT.runtimeDir`, `LAYOUT.jobsFile`; every
  `br_id` field becomes `job_id`; `NEVER_COMMIT_PATHS` gains `.pi-command-post/`.
- `src/scaffold.ts`: the ledger step writes an empty document instead of
  running `br init`; the generated `.gitignore` gains the dotdir.
- `src/doctor.ts`: br checks out, ledger checks in (below).
- `src/tool-manifest.ts`, `src/install-tools.ts`, `scripts/install-tools.ts`:
  `br` leaves the required tools and its install spec; `MIN_BR_VERSION` goes.
- `src/guards.ts`: `#checkBr`, `BR_INLINING_SUBCOMMANDS` and the
  `ledger_inlines_artifact` code are removed.
- `src/status.ts`: unchanged interface; the degraded line names the document
  rather than br.
- `extensions/command-post/jobs.ts` (new adapter): registers `cp_job` and
  `/cp-jobs`; `index.ts` calls it. This keeps a 3,700-line composition file
  from growing further.
- `extensions/worker-reporter/index.ts`: reads `CP_JOB_ID` instead of
  `CP_BR_ID`; envelope and verdict carry `job_id`.
- `tests/harness/ledger.ts` (replaces `tests/harness/beads.ts`): a scratch
  home with a real `Ledger` over it; no binary probe.

## The store

Path: `<home>/.pi-command-post/jobs.json`. One document, whole-file rewrite,
same discipline as `state/fleet.json`: every mutation runs inside pi's
per-path mutation queue (`queued`), reads the file, validates, mutates,
validates again, then `atomicWriteJson` (tmp → fsync → rename). No in-memory
cache: the parent lock already guarantees one writer process per home, and the
document is small (hundreds of jobs; a few megabytes at ten thousand).

```jsonc
{
  "schema_version": 1,
  "prefix": "cp",
  "jobs": [
    {
      "id": "cp-nz95",                 // JOB_ID_PATTERN; also branch, run dir, lease holder
      "title": "…",
      "description": "…",             // optional
      "notes": "…",                   // optional
      "status": "open",               // open | in_progress | deferred | closed
      "type": "task",                 // optional: task|bug|feature|epic|question|docs|chore
      "priority": 2,                  // 0..4
      "labels": ["project:x", "delivery:pr", "kind:ship"],
      "assignee": "cp-nz95",          // optional; set by claim()
      "external_ref": "https://…",    // optional; https only
      "blocked_by": ["cp-9tq7"],      // job ids in this document
      "comments": [{ "at": "2026-09-04T10:00:00Z", "author": "0xb1ob", "text": "…" }],
      "created_at": "…", "updated_at": "…",
      "closed_at": "…", "close_reason": "…"   // present iff status is closed
    }
  ]
}
```

Derived queries:

- **ready**: `status === "open"` and every id in `blocked_by` names a job whose
  status is `closed`.
- **blockersOf(id)**: the ids in that job's `blocked_by` whose status is not
  `closed`. Dispatch refuses when this is non-empty, exactly as today.
- **blocked**: every job whose status is not `closed` and whose `blockersOf` is
  non-empty.
- **history**: `status === "closed"`, newest `closed_at` first.

Ids. `mintJobId(prefix, existing, slug?)`: suffix of four characters drawn
with `crypto.randomInt` from `[a-z0-9]`; on collision draw again, and after
eight collisions draw five characters. A slug is validated against
`^[a-z0-9][a-z0-9-]{0,40}$` and yields `<prefix>-<slug>-<suffix>`. The result
must satisfy `JOB_ID_PATTERN` (unchanged from today's `BR_ID_PATTERN`:
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`). The prefix comes from the document; a
document is created with the prefix `resolveLedgerPrefix(env)` yields, and a
later environment value that disagrees is a doctor warning, never a switch.

Labels keep today's rules verbatim: `project:` and `delivery:` are required,
`kind:` optional, values `[A-Za-z0-9_-]+`, exactly one of each prefix, and a
`project:` value must be a registered name when a registry is wired in.

## Ledger API and policy

| method | behaviour |
|---|---|
| `create(input)` | validates title, labels, registry gate, https external ref; mints the id; appends; returns the job. |
| `show(id)` | the job, or `LedgerError` when unknown. |
| `list(filter)` | filter shape unchanged: `project`, `delivery`, `kind`, `status` (one or many), `all`, `limit`, `labels`. Without `all` or a closed status, closed jobs are excluded. `limit` applies after sorting by `created_at`. |
| `ready(filter)`, `blocked()`, `blockersOf(id)`, `history(filter)` | as defined under The store. |
| `update(id, patch)` | status (never `closed`), assignee, priority, notes, add/remove labels; label edits re-validate the job contract. |
| `claim(id, assignee)` | `in_progress` + assignee. |
| `close(id, reason)` | reason required and non-empty; sets `closed`, `closed_at`, `close_reason`. Idempotent on an already-closed job with the same reason; a different reason is refused (a close is a fact, not an edit). |
| `drop(id, reason)` | `close` with the `dropped: ` prefix. |
| `comment(id, text)` | appends `{ at, author, text }`; `author` is the `actor` option, default the OS username. |
| `addDep(blocked, blocker)` | refuses self, unknown ids and a cycle; idempotent when present. |
| `removeDep(blocked, blocker)` | idempotent when absent. |

All writes stamp `updated_at`. All errors are `LedgerError`; the `code`/`hint`
fields that mirrored br's envelope go.

## Model surface: `cp_job`

One tool, `action` discriminated, every action's arguments typed in the schema:

| action | arguments | returns |
|---|---|---|
| `create` | `title`, `project`, `delivery`, `kind?`, `type?`, `priority?`, `description?`, `external_ref?`, `slug?`, `labels?` | the job |
| `show` | `job_id` | the job |
| `list` | `project?`, `delivery?`, `kind?`, `status?`, `all?`, `limit?` | jobs |
| `ready` | `project?` | jobs |
| `blocked` | — | jobs, each with `blockers` |
| `claim` | `job_id` | the job |
| `update` | `job_id`, `status?` (open/in_progress/deferred), `priority?`, `notes?`, `add_labels?`, `remove_labels?` | the job |
| `comment` | `job_id`, `text` | the job |
| `dep_add` / `dep_remove` | `job_id`, `blocker_id` | the job |
| `close` / `drop` | `job_id`, `reason` | the job |

Refusals at the tool boundary, each naming the sanctioned path:

- `close` / `drop` when `fleet.json` has a record for the job in phase
  `waiting` or `held`: "a worker holds this job; `cp_teardown <id>` first, or
  `cp_integrate <id>` for a merged PR".
- `claim` when the job is already `in_progress`: dispatch claims; a second
  claim is a sign the model is bypassing `cp_dispatch`.
- `create` with `delivery:pipeline` or `delivery:answer`: pipelines are
  created by `cp_pipeline start`, which also creates the dependency, and Q&A
  jobs by `cp_ask`, which also dispatches the worker; a hand-made one would
  have no ship half, or no worker.

The tool result is the job record rendered as JSON plus a one-line headline.
It never contains anything the store does not hold.

`cp_pipeline`, `cp_ask`, `cp_integrate` and `cp_dispatch` keep calling the
class directly, so the two-job pipeline choreography and the claim-at-dispatch
rule cannot be skipped by hand.

## Operator surface: `/cp-jobs`

- `/cp-jobs` or `/cp-jobs ready [--project N]`: the ready queue, one line per
  job: id, project, delivery/kind, title.
- `/cp-jobs list [--all] [--project N] [--status S]`: same rendering, wider
  filter.
- `/cp-jobs show <id>`: the record in full — labels, status, blockers with
  their statuses, comments in order, close reason.
- `/cp-jobs import-beads`: the one write (Migrations, PR 2). Operator-only;
  nothing here is a tool.

The first three are read-only and never mutate the document.

## Guards

`ContextGuard` loses `#checkBr`, `BR_INLINING_SUBCOMMANDS` and the
`ledger_inlines_artifact` code. The artifact-read rule, the journal rules and
the git-publishing rule are unchanged. `NEVER_COMMIT_PATHS` becomes
`["data/", "state/", "projects/", ".beads/", ".pi-command-post/"]`.

## Migrations

### PR 1: `br_id` → `job_id`

Code: every `br_id`, `brId`, `br-id`, `BrId`, `BR_ID` in `src/`,
`extensions/`, `tests/`, `docs/`, `AGENTS.md`, `README.md`, profiles, prompts
and golden files becomes `job_id`, `jobId`, `job-id`, `JobId`, `JOB_ID`. The
worker environment variable `CP_BR_ID` becomes `CP_JOB_ID`. Behaviour is
otherwise identical; br remains the backend in this PR.

State sweep (`src/state-migrations.ts`), run at `session_start` after the
parent lock is acquired and before reconcile spawns anything:

- Walks the known layout under `state/`: `fleet.json`, `awaiting.json`,
  `answered.json`, `ci-watch.json`, `status-block-shipped.json`,
  `checkpoints/*.json`, `pipelines/*.json`, `runs/**/*.json` (status,
  envelope, envelope-superseded-N, merge, integration, gate-N, gate-N-raw,
  review-N, review-N-raw, and the status/verdict files inside gate-N/ and
  review-N/).
- For each JSON document: parse, rename the key `br_id` to `job_id` wherever it
  appears as an object key (values are never touched), write atomically. A
  document that does not parse is left alone and reported.
- For each journal (`runs/**/events.jsonl`, `questions.jsonl`, `attach.jsonl`):
  rewrite line by line with the same key rename; a line that does not parse is
  copied byte for byte. The rewrite is atomic (tmp → fsync → rename).
- Skips `state/sessions/` (pi's transcripts), every `.md`, every `.bak*`.
- Writes `state/.migrations/2026-09-job-id.done` on completion; the presence of
  that marker makes every later start a no-op.
- Doctor check `state.job_id_migration`: error when the marker is absent and
  any known file still carries the old key; the fix is "start a session".

Accepted edge: a worker started by a pre-rename parent and still alive after
the parent restarts (an orphan) would file an envelope carrying `br_id`; it
fails validation and the job lands `unreported`, which the existing recovery
path handles.

### PR 2: import open jobs from `.beads/`

`/cp-jobs import-beads` reads `<home>/.beads/issues.jsonl` directly:

- Keeps rows whose `status` is not `closed` (today: `cp-mcs-dup-memories-1ape`
  in_progress, `cp-m-day-validator-kmsb` in_progress, `cp-afdq` deferred with
  one dependency).
- Maps `id`, `title`, `status`, `priority`, `issue_type → type`, `labels`,
  `assignee`, `description`, `notes`, `created_at`, `updated_at`,
  `comments[] → {at: created_at, author, text}`, and
  `dependencies[type == "blocks"].depends_on_id → blocked_by`. A dependency on
  a closed row is dropped with a note (a closed blocker blocks nothing).
- Refuses to run when any incoming id already exists in the document, and when
  the document's prefix differs from the ids' prefix. Idempotence is therefore
  a refusal, not a merge.
- Reports one line per job imported and one for each dependency kept or
  dropped. Writes nothing to `.beads/`.

Doctor check `ledger.beads_archive`: warning while `.beads/` exists and the
document has at least one job — "frozen archive; safe to delete".

## Doctor, scaffold, manifest

Doctor removes `host.br.conflict`, the br version floor, `ledger.workspace`,
`ledger.schema`, `ledger.doctor` and the br install hint, and adds:

| check | severity | when |
|---|---|---|
| `ledger.file` | error | the document is missing, unparseable, or fails `JobsDocumentSchema`; fix: "start a session (the scaffold creates it)" or "restore from a backup" |
| `ledger.ids` | error | a duplicate id, or an id outside `JOB_ID_PATTERN` |
| `ledger.deps` | error | a `blocked_by` entry naming an unknown id, or a cycle |
| `ledger.prefix` | warning | `CP_LEDGER_PREFIX` resolves to a value different from the document's |
| `ledger.size` | warning | more than 5,000 jobs |
| `ledger.beads_archive` | warning | as above |
| `state.job_id_migration` | error | as above (PR 1) |

Scaffold: `dir.runtime` creates `.pi-command-post/`; the `ledger` step writes
`{ schema_version, prefix, jobs: [] }` when the document is missing and
refuses an invalid `CP_LEDGER_PREFIX` exactly as today; an existing document
is never touched. The generated `.gitignore` lists `.pi-command-post/`.

Tool manifest: `REQUIRED_TOOLS = ["git", "treehouse", "pi", "gh"]`; the br
install spec and the installer's br note go. The install nudge and doctor's
missing-tool table follow automatically. README's requirements section drops
br; its layout table replaces the `.beads/` row with `.pi-command-post/` and
notes `.beads/` as an archive.

## Documentation

- `AGENTS.md`: §Backlog (br) becomes §Jobs and describes `cp_job`; "Each
  session" step 3 becomes `cp_job ready`; §A small question, §Teardown and
  §Integration say `cp_job close` where they say `br close`; the Never list
  says `.pi-command-post/`. Prose that says "br id" says "job id".
- `docs/contracts.md`: §Ledger (br) becomes §Ledger and describes the
  document, the derived queries, the refusals and the two migrations; the br
  checks paragraph under §Doctor is replaced by the table above; the T19 guard
  section drops the `br show` rule.
- `docs/parity.md`: rows that cite br cite the ledger.
- `README.md`: requirements, quick start (`br init` line), layout table, the
  `CP_LEDGER_PREFIX` row.
- `tests/e2e/README.md`: br prerequisites removed.
- `PLAN.md` is a historical build record and is left as is, with one line at
  the top of its ledger note pointing here.

## Contract additions (`src/contracts.ts`)

- `JOB_ID_PATTERN`, `JobIdSchema`, `isSafeJobId` (renamed from the `BR_`
  forms; values unchanged).
- `JOB_STATUSES`, `JobStatusSchema`; `JOB_TYPES`, `JobTypeSchema`.
- `JobCommentSchema`, `JobSchema`, `JobsDocumentSchema`, `validateJobsDocument`.
- `LAYOUT.runtimeDir = ".pi-command-post"`, `LAYOUT.jobsFile =
  ".pi-command-post/jobs.json"`, `LAYOUT.migrationsDir = "state/.migrations"`.
- `NEVER_COMMIT_PATHS` gains `.pi-command-post/`.
- `GuardCode` loses `ledger_inlines_artifact`.
- Every `br_id: BrIdSchema` field becomes `job_id: JobIdSchema`.

## Testing

- `tests/ledger.test.ts` (rewritten, hermetic): every method against a scratch
  home; label validation; id minting with an injected random source
  (collision → redraw → lengthen); `ready`/`blocked`/`blockersOf` over a small
  graph; `close` idempotence and the differing-reason refusal; `addDep`
  cycle refusal; the atomic write leaves the previous document on a simulated
  failure; the document written matches `JobsDocumentSchema`.
- `tests/ledger-import.test.ts`: a fixture `issues.jsonl` with closed and
  open rows, comments, a `blocks` dependency on an open row and one on a closed
  row; the duplicate-id and prefix refusals; nothing written to the fixture.
- `tests/state-migrations.test.ts`: a fixture `state/` tree with every file
  kind; keys renamed, values untouched, a malformed journal line copied
  verbatim, `.bak` and `sessions/` skipped, marker written, second run a no-op;
  the doctor check on an unswept tree.
- `tests/jobs-tool.test.ts`: `cp_job` actions through the registered tool with
  a fake fleet; the three refusals; `/cp-jobs` rendering.
- `tests/guards.test.ts`: the br cases removed; `br show` on an artifact id is
  no longer a decision.
- `tests/doctor.test.ts` and `tests/golden/doctor-broken.txt`: the new checks.
- `tests/scaffold.test.ts`, `tests/tool-manifest.test.ts`,
  `tests/install-tools.test.ts`, `tests/install-nudge.test.ts`: br removed.
- `tests/harness/ledger.ts` replaces `beads.ts`; `liveSkip` needs only
  treehouse; `dispatch`, `pipeline`, `doctor`, `awaiting`, `status` and the e2e
  suites use the scratch home. The e2e harness replaces `br init` with the
  scaffold. The suites that self-skipped without br now run in CI.
- The rename PR is verified by `npm test` plus a grep that finds no `br_id`,
  `brId`, `br-id`, `BrId` or `BR_ID` outside the historical records:
  `PLAN.md`, `docs/build-history.md`, `docs/spikes/` and
  `docs/superpowers/specs/`.

## Out of scope

- Archiving or compacting closed jobs (doctor warns at 5,000; nothing acts).
- Folding the job close into `cp_teardown`.
- Moving `data/` and `state/` under `.pi-command-post/` (item 3).
- Importing closed history from `.beads/`.
- Any operator write to the ledger other than `import-beads`.

## Task order

PR 1 — rename (no behaviour change; br still the backend):
1. `src/state-migrations.ts` with tests; doctor check `state.job_id_migration`.
2. The mechanical rename across code, tests, golden files and docs; `CP_JOB_ID`.
3. Session-start wiring: sweep after the parent lock, before reconcile.
4. One real session on this home confirms the sweep and a green `/doctor`.

PR 2 — the ledger:
1. Contracts: `JobSchema`, `JobsDocumentSchema`, `LAYOUT` entries, never-commit path.
2. `src/ledger.ts` over the document, with `tests/ledger.test.ts` and the
   scratch-home harness; every existing caller compiles unchanged.
3. Scaffold and doctor changes; tool manifest and installer changes.
4. `extensions/command-post/jobs.ts`: `cp_job` and `/cp-jobs`, with tests.
5. Guard retirement, with tests.
6. `src/ledger-import.ts` and `/cp-jobs import-beads`, with tests.
7. Docs: AGENTS.md, contracts.md, parity.md, README, e2e README.
8. Operator runs `/cp-jobs import-beads` once on this home; `/doctor` is green
   apart from the `.beads/` archive warning.
