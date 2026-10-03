# pi-command-post — contracts

Binding contracts for every task from T2 onward. Schemas live in
[`src/contracts.ts`](../src/contracts.ts) as typebox; `src/contracts.ts` is a
re-export barrel over one module per contract in `src/contracts/`; import from
the barrel. A contract change updates `tests/golden/contracts-exports.txt`
(`CP_UPDATE_GOLDEN=1`). This file explains the
*why*, the invariants that are not expressible in JSON Schema, and the file
layout. **Where prose and code disagree, the code wins** — that is the point of
moving policy out of AGENTS.md.

Schema version: `SCHEMA_VERSION = 1`. Every persisted file carries
`schema_version`; readers reject unknown majors rather than guessing.

## Table of contents

- [Directory layout](#directory-layout)
- [Modes](#modes)
- [Atomicity and ownership](#atomicity-and-ownership)
- [Envelope (`report_result`)](#envelope-report_result)
- [Fleet state](#fleet-state)
  - [Wake-up staleness](#wake-up-staleness)
  - [State transitions and wake-ups](#state-transitions-and-wake-ups)
  - [The CI/PR watch](#the-cipr-watch)
  - [Headless parent (RPC / CP_HEADLESS)](#headless-parent-rpc--cp_headless)
- [Run artifacts: events and status projection](#run-artifacts-events-and-status-projection)
- [Worker profiles and briefs](#worker-profiles-and-briefs)
- [Trust policy](#trust-policy)
- [Gate verdict](#gate-verdict)
- [Project registry](#project-registry)
- [Dispatch (`cp_dispatch`)](#dispatch-cp_dispatch)
- [Preflight (`cp_check`)](#preflight-cp_check)
- [Teardown (`cp_teardown`)](#teardown-cp_teardown)
- [Integration (`cp_integrate`)](#integration-cp_integrate-cp-uug)
- [Artifacts and parent context guards](#artifacts-and-parent-context-guards)
- [Q&A answers (`delivery:answer`)](#qa-answers-deliveryanswer)
- [Pipeline and checkpoint](#pipeline-and-checkpoint)
- [Escalation](#escalation-one-schema-for-ask-the-human)
- [Research quality pass](#research-quality-pass)
- [Operator questions](#operator-questions)
- [Conversation revise / planner question reach the live planner](#conversation-revise--planner-question-reach-the-live-planner)
- [Awaiting you](#awaiting-you)
  - [One decision is one question](#one-decision-is-one-question)
  - [One surface at a time](#one-surface-at-a-time)
  - [The merge ask](#the-merge-ask)
  - [Suggested answers](#suggested-answers)
  - [The decide UI is the questionnaire](#the-decide-ui-is-the-questionnaire)
  - [The decision details pane](#the-decision-details-pane)
- [Web Push](#web-push)
- [Dashboard control](#dashboard-control)
- [Status view](#status-view)
- [Watch](#watch)
- [Doctor](#doctor)
- [Memory](#memory)
- [Curation, autonomous](#curation-autonomous)
- [Leases](#leases)
- [Ledger](#ledger)
- [Routing config](#routing-config)
- [Gate config](#gate-config)
- [Budgets and failure taxonomy](#budgets-and-failure-taxonomy)
- [Delivery receipts](#delivery-receipts)
  - [A promoted brief may replace the frozen task](#a-promoted-brief-may-replace-the-frozen-task)
- [Envelope supersession](#envelope-supersession)
- [Envelope correction](#envelope-correction)
- [Identifiers and timestamps](#identifiers-and-timestamps)
  - [Job id (renamed from br id)](#job-id-renamed-from-br-id)

## Directory layout

Everything below is relative to the **command post home**: the standard home
`~/.pi-command-post`, a source checkout, or `CP_HOME`; single-project mode was removed, see
[Modes](#modes). Every home-local file lives
under the one runtime root (cp-u3i2; see
[storage.md](storage.md) for the full inventory and who may write where): the
standard home is its own runtime root, any other home keeps it in a gitignored
`<home>/.pi-command-post/`. In this document `data/…`, `state/…` and `projects/…` mean
`<runtime root>/data/…` and so on.

```
defaults/routing.default.json  shipped default rubric template (tracked; cp-default-rubric)
<runtime root>/             the one runtime root (the standard home itself, else <home>/.pi-command-post/, gitignored)
  jobs.json               the job ledger: every job, its labels, blockers, comments (spec 2026-09-04)
  settings.json           mode preference, operator-written, read-only (multi|auto; single refused)
  data/                   operator + policy data
    projects.json         project registry (T10)
    routing.json          model routing config (T13); copy-once from defaults/routing.default.json
    capacity.json         optional admin capacity endpoint (no key; ignored locally)
    gate.json             gate reviewer config (cp-gate-timeout)
    budgets.json          budget config (T18)
    mandate-defaults.json home-level mandate defaults, scaffolded once (autonomy-programme-cur.2.5)
    learnings.md          curated memory (T26)
    candidates.md         append-only capture (T26)
    archive.md            cold tier (T26)
    push/config.json      Web Push origin, subject and VAPID public key (npm run push:init)
    push/vapid.key        Web Push signing key, 0600, never printed
    push/subscriptions/<id>.json  one subscribed device each, 0600
    dashboard-control.json  optional: {"enabled": false} turns dashboard control off (absent is on)
  projects/<name>/        one canonical clone per project
  operator/               the operator session's workspace: tasks/ handoffs/ reports/<topic>/ scratch/
  state/                  runtime truth
    fleet.json            the fleet: one record per in-flight job
    ci-watch.json         what the CI/PR watch has observed and announced (cp-e2d)
    main-ci.json          per-project red-main latch; pauses cp_integrate (k52)
    answer-cards.json     answer cards the operator is owed, and the ones shown (cp-6lg7)
    status-block-shipped.json  Shipped rows already reported, per session (cp-b5eg)
    runs/<job-id>/
      brief.md            the exact brief that was sent
      events.jsonl        append-only tee of everything observed
      status.json         projection of events.jsonl (the read surface)
      envelope.json       the accepted envelope (idempotent)
      gate-<attempt>.json the parent's post-policy gate decision, one per attempt
      gate-<attempt>/     that attempt's reviewer run (events, status, verdict.json)
        pending.json      a reviewer is running (spec 2026-09-05)
        review/artifact.md  the reviewer's whole world: a copy of the artifact
      review-<attempt>/   one diff-review attempt's reviewer run
        pending.json      a reviewer is running (spec 2026-09-05)
      quality.json        the opt-in pre-gate panel's report (T22)
      quality-<slot>/     one voter's run (events, status, verdict)
      quality-panel/pending.json  the panel is running (spec 2026-09-05)
    artifacts/<job-id>/
      report.md           research artifact body — the parent NEVER reads this
    pipelines/<research-id>.json   the two-job link and its state (T21)
    checkpoints/<job-id>.json       journaled human authorization (T21)
    mandates/<id>.json              operator-issued bounded authority
    escalations.json                structured ask-the-human records (autonomy-programme-cur.2.3)
    push-deliveries.json            Web Push delivery ledger, once per id (Pier 1.1)
    operator/dashboard.{json,sock}  dashboard-control record and socket, 0600 (the operator session's)
    operator/dashboard.jsonl        dashboard-control audit journal, append-only, 0600
.beads/                   frozen archive of the retired br ledger (gitignored; safe to delete; left in place)
```

`.pi-command-post/` and `.beads/` are never committed or pushed
(`NEVER_COMMIT_PATHS`; enforced by the T19 guard, not by good manners); see
[storage.md](storage.md).

### USER.md — optional machine-local operator context

`USER.md` lives at the repo root beside `AGENTS.md`. It is **optional**, it is
**never versioned** (`/USER.md` in `.gitignore`), and
[`src/user-context.ts`](../src/user-context.ts) is read-only: there is no path
in this package that creates, overwrites, stages or deletes it — `scaffoldHome`
deliberately leaves it alone, so an operator's file is only ever the operator's.

| | |
|---|---|
| absent (the normal case) | `readUserContext`/`userContextDigest` return `undefined`; session start loads nothing and says nothing — behaviour identical to before the file existed |
| present | loaded at `session_start` as a `cp-user-context` message (`display: false`, `deliverAs: "nextTurn"` — the same background delivery memory uses), trimmed and capped at `USER_CONTEXT_MAX_CHARS` (8000) with a truncation note |
| empty or unreadable | treated as absent; optional context that fails to load is never an error a session hears about |

**Precedence is one-way and stated in the payload itself.** The digest's first
lines say that `AGENTS.md` and this document remain binding and that `USER.md`
may only *add* local preferences and environment facts — it can never weaken a
safety, review, authorization or delivery rule. Authorization is delegated only
through the mandate store (`cp_mandate` / `state/mandates/`), never by free
prose in `USER.md`. Shipping the precedence with the content is the mechanism:
the file can never reach a parent as an unqualified instruction, and truncation
cannot cost it — the cap applies to the file's text and the header is composed
around the already-shortened body.

**It resolves under `PACKAGE_ROOT`, not the home — deliberately.** Every other
path in this package keys off the home (`CP_HOME`, else the standard home `~/.pi-command-post`);
`USER.md` does not, because it is defined by what it sits *beside*. `AGENTS.md`
is a repo file that ships in this package, and a standard home contains no
`AGENTS.md` at all, so on any home that is not the checkout "beside `AGENTS.md`"
and "under the home" are different places. `AGENTS.md` tells every parent that the
`USER.md` at this repo's root loads itself (never `read` or `ls` it); if the loader read the home's copy instead, the
sentence a model follows and the file the extension loads would be two different
files. A `USER.md` in a home directory is therefore not read, and
`tests/user-context.test.ts` exercises `root !== home` rather than collapsing the
two. The home's guarantees are not needed here in any case: this is context, not
state, and nothing writes it.

The call site is `deliverUserContext` in `extensions/command-post/index.ts` — a
function rather than inline `session_start` code so that both halves of the
contract (absent → no message at all; present → exactly one, with that
`customType`/`display`/`deliverAs`) are tested, not just described.

Path construction goes through `paths.*` in `src/contracts.ts`. Those helpers
reject any job id that is not `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, which is also
the traversal guard: a job id can never contain `/`, `.` or `..`.

## Atomicity and ownership

| File | Writer | Discipline |
|---|---|---|
| `state/fleet.json` | parent extension only, one process | read-modify-write under an in-process mutation queue, then `write tmp → fsync → rename` |
| `state/runs/<id>/events.jsonl` | the run's manager (parent) | append-only, one JSON object per LF line, never rewritten, never truncated |
| `state/runs/<id>/status.json` | the run's manager | full-file atomic replace (tmp + rename) after each applied event batch |
| `state/runs/<id>/envelope.json` | the **worker** (worker-reporter) | write-once **per generation**; an identical re-report is a no-op, a contradicting one is refused, and a promote reopens the slot by archiving it |
| `state/runs/<id>/envelope-superseded-<n>.json` | the **parent** (`src/supersede.ts`) | generation `n`, moved aside so the slot can be reopened; never rewritten, never deleted |
| `state/runs/<id>/envelope-rejected.json` | the **worker** (worker-reporter) | written once when repair attempts are exhausted |
| `state/runs/<id>/gate-<n>/verdict.json` | the **gate-reviewer worker** of attempt `n` | same write-once rules; a control message, not an artifact body |
| `state/runs/<id>/gate-<n>/verdict-rejected.json` | the **gate-reviewer worker** | written once when verdict repair is exhausted (parent reads it as `cause: operational`) |
| `state/runs/<id>/gate-<n>/verdict-raw.json` | the **gate-reviewer worker** | written beside `verdict.json` only when a reason/revision had to be clamped; holds the reviewer's unabridged payload |
| `state/runs/<id>/gate-<n>.json` | the gate module (parent) | the post-policy decision; written once per attempt |
| `state/artifacts/<id>/*` | worker (writes), parent (moves/deletes only) | parent may stat, move and delete; it may never read the body |
| `state/answer-cards.json` | parent extension only (`src/answer-delivery.ts`) | synchronous read-modify-write + atomic replace; queued at intake, marked delivered only after a surface took the card (cp-6lg7) |

Rules:

1. **Single writer.** Exactly one parent process owns `state/`. Concurrency
   inside that process is serialized (pi's `withFileMutationQueue`), not by
   lock files. Two parents on one home is unsupported and detectable (pid
   liveness on reconcile). Except the service-owned `state/health.json`
   (cp-health, run by cp-daemon, a oneshot) and `state/update.json` (cp-update, run by cp-daemon), and the
   viewer's `O_APPEND` lines in `state/operator/{dashboard,inbox}.jsonl`
   (cp-daemon v1 P3) and the viewer's `request` lines in
   `state/schedule-control.jsonl` (cp-hhuf P6).
2. **Facts only.** Nothing in `state/` may be written from an inference. A
   worker is dead when its child close was observed; a job reported when a
   valid envelope was accepted.
3. **Crash safety.** `events.jsonl` is the log; `status.json` is a cache. If
   they disagree, the log wins and the projection is rebuilt from it.
4. **LF framing.** Both the RPC transport and `events.jsonl` use strict LF
   JSONL. Never `node:readline` (it splits on U+2028/U+2029, which are legal
   inside JSON strings).

## Envelope (`report_result`)

The only way a worker finishes a job. No prose envelope, no mail parsing.
Schema: `EnvelopeSchema`; full contract: `validateEnvelope(value, ctx)`.

```jsonc
{
  "job_id": "cp-t14-dispatch-abc",
  "kind": "ship",                    // ship | research
  "status": "done",                  // done | blocked
  "summary": "Added retry ladder; local suite green on the rebased tree.",  // <= 3 lines, no CI claim required
  "pr_url": "https://github.com/org/repo/pull/42",      // delivery:pr ship
  "branch": "cp-t14-dispatch-abc",
  "head_sha": "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a", // ship: the commit the worker pushed; the parent verifies CI against it
  "base_sha": "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a", // ship: the origin/<base> sha rebased onto (optional but recommended)
  "artifact_path": "/abs/path/report.md",               // research
  "blockers": ["migration needs owner sign-off"],       // status: blocked
  "self_assessment": {                                  // research
    "confidence": "high", "scope": "M",
    "blocking_unknowns": false, "destructive_scope": false,
    "suggested_implementer_model": "claude-sonnet-5",       // identifier only
    "suggested_implementer_model_reason": "routine, low risk" // optional, one sentence
  }
}
```

Cross-field policy (all fail-closed, all in code):

- **Identity** — `job_id` and `kind` must equal the dispatch record. A worker
  cannot report for another job.
- **Summary is a headline** — at most 3 lines, no code fences, no markdown
  headings. This is the ported HARD RULE ("the findings body NEVER goes into
  mail"), now mechanical: a body-shaped summary is rejected and the worker is
  told to put it in the artifact.
- **research/done** requires `artifact_path`, absolute, and **outside the
  worktree** (that is why research keeps a clean tree). research may never
  carry `pr_url`.
- **ship/done** requires `branch`; `delivery:pr` additionally requires an
  https `pr_url`. It should carry `head_sha` (the commit it pushed,
  `git rev-parse HEAD`) and `base_sha` (the `origin/<base>` it rebased onto,
  where `<base>` is the repository's resolved base branch), so
  the run is self-describing: the parent verifies CI against exactly that head,
  on exactly that base. Intake resolves that url from gh rather than trusting it, and
  corrects or refuses a mismatch (see §Envelope intake).
- **A ship envelope never has to claim CI (cp-kzc).** An envelope carrying
  `head_sha` and saying nothing whatsoever about CI is **complete**; its silence
  is not an incomplete job and is never a reason to promote the worker for a
  restatement. The parent already re-verifies CI itself before every merge
  (ancestry contains the tip; the run's `headSha` equals the pushed head), so a
  worker waiting for CI duplicates a check the parent redoes and does not take
  on the worker's word. Requiring a green claim here is precisely what pushed
  workers into `sleep N; gh run list` inside a tool call.
- **blocked** requires at least one blocker. A planner (`kind: research`, not
  `delivery: answer`) sends objects, at most `PLANNER_BLOCKER_MAX_ITEMS` (3):
  `question`, `why`, `options` (each one line), `recommended` (one of those
  options), `assume_if_unanswered`. A fence, a heading, or a second line is
  body-shaped and rejected like a body-shaped summary. An implementer or a Q&A
  worker still sends strings. After `PLANNER_BLOCKED_ROUND_CAP` (2) blocked
  rounds on one job, the next blocked planner envelope is escalated
  (`loop_exhausted`) instead of being left for the parent to answer.

### One terminating tool per role

**The role that plans is `planner`** (Phase 7/D5). It was called `researcher`
until the name and the job stopped matching: the brief produces an
implementation plan, the gate scores that plan against the implementation-plan
rubric (§The rubric is the implementation-plan rubric), and the ask-the-operator
rule already read "a planner may ask". Nothing about the role's behaviour
changed with the word.

The old word survives only on disk, and only inbound: `LEGACY_ROLE_ALIASES` maps
`researcher → planner` and `normalizeLegacyRoles` — one function, called from
`validateFleetFile`, `validateRunStatus`, `validateQuestionRecord` and the
routing-config loader — rewrites it as the file is parsed, so a home that ran
the pre-rename build keeps loading its `state/fleet.json`, its run status
projections, its `questions.jsonl` lines and a `data/routing.json` rubric row
written against the old role. It only ever touches a property literally named
`role` whose value is the retired word, never prose that mentions it, and
`planner` is the only thing ever written back.

| role | terminating tool | record |
|---|---|---|
| planner, implementer | `report_result` | `envelope.json` |
| gate-reviewer | `report_verdict` | `gate-<attempt>/verdict.json` |

Never both (`TERMINATING_TOOL_BY_ROLE`, enforced at profile validation and at
spawn). An implementer cannot emit a verdict; a reviewer cannot emit a job
envelope. What a worker is not offered, it cannot call.

A reviewer needs no `blocked` path: an artifact it cannot score **is**
`verdict: escalate` with the reason.

`report_verdict` carries observation only — `{job_id, verdict, flags, reasons,
revisions?}` (`GateReviewSchema`). The reviewer never decides `cause`, never
applies flags-force-escalate and never counts revise attempts: that is parent
policy (T20). Cross-field rules: `revisions` are required on `revise` and
forbidden otherwise, and `job_id` must match the job under review.

**An over-long reason is clamped, not rejected.** pi validates a tool's
`parameters` before `execute()` runs, so a 450-char reason used to fail the
call outside this extension entirely — a complete finding thrown away, and a
whole extra reviewer turn to restate it shorter. `report_verdict` therefore
*advertises* a lenient item bound (`GATE_REVIEW_LENIENT_ITEM_MAX`, 2000) and
its `validate` hard-cuts each `reasons`/`revisions` item to the contract's
`maxLength: 400`, ending it in `…`, before checking the clamped payload against
`GateReviewSchema` and the cross-field rules as before. Whenever anything was
cut, the reviewer's unabridged payload is written to
`state/runs/<id>/gate-<n>/verdict-raw.json` next to the record and the tool's
success text names that path — the same degrade-rather-than-discard choice the
parent's decided verdict already makes (`capPayload` + `gate-<n>-raw.json`,
cp-yg2), so a clamped verdict is never the only copy. Nothing else is relaxed:
the item count, the non-empty `reasons`, the closed object and the lenient bound
itself all still reject, because past 2000 chars it is an artifact body rather
than a long finding. `revisions` on a non-`revise` verdict also still rejects —
that is semantics, one cheap repair, and silently dropping findings is worse
than one retry. `report_result.summary` gets no such treatment: an over-long
summary is usually a findings body leaking into the envelope, which must be
refused rather than shortened.

### Bounded repair, and what it actually covers

pi validates tool arguments against the typebox schema **before** `execute()`
runs, so pure shape errors (missing field, wrong type, empty required array)
are rejected by pi with its own message and never reach our loop. Our bounded
repair therefore covers **cross-field and local policy**: identity mismatch,
body-shaped summary, missing artifact, dirty research tree, revisions on a
non-revise verdict.

Rejection is not failure: the validator returns model-facing strings
(`path: what to fix`) and the worker retries up to
`ENVELOPE_REPAIR_MAX_ATTEMPTS` (bounded repair, pi-dynamic-workflows pattern).
After the cap the worker writes `envelope-rejected.json`, terminates its run,
and the job is an `envelope_invalid` failure the operator sees.

The worker also runs the checks only it can run before accepting a report
(`localChecks`): the research artifact must exist, be non-empty, and match the
predeclared path, and a research worktree must be clean
(`git status --porcelain` empty). Failing those is repairable, so the model can
fix the tree or report `blocked` instead.

### Ship worker final step: rebase, run focused checks, push, report the head sha

Every `ship` job **must** follow this final sequence before calling `report_result`.
It replaces stale-base green runs (a worker reported green, the base moved, the
PR merged red). Evidence from live runs: PRs #15–22 landed green locally and
went stale or conflicted by merge time; three needed re-dispatch, one took five
rebases across a day.

**Rebase onto `origin/<base>` — the base branch the brief names, resolved per
repository from `origin/HEAD` and `main` only when that is what it resolves to —
re-run typecheck and the touched tests locally, push, report the pushed head sha — and stop.** In
detail:

1. `git fetch origin` — ensure you have the latest base.
2. `git rebase origin/<base>` — rebase your commits onto the current base.
   - **If there are conflicts:** resolve them so **both sides survive**. Never
     weaken a test or delete code to make a conflict go away. If you cannot
     resolve both sides (the right resolution is unclear), report `blocked` with
     the exact conflict and the resolution you tried — the operator will take it
     from there.
3. Run `npm run typecheck` and only the touched test files
   (`npm run test:one -- tests/<x>.test.ts`) on the rebased tree — never the full
   `npm test` locally; CI (`.github/workflows/ci.yml`) runs the full suite once on
   the pushed head. That focused run on the rebased base is the evidence the worker owes.
4. `git push --force-with-lease` to update the branch with the rebased commits.
5. `git rev-parse HEAD` → `head_sha`, `git rev-parse origin/<base>` → `base_sha`.
   Call `report_result` with both. **The job ends here.**

`head_sha` and `base_sha` make the run self-describing: the parent knows exactly
which commit, on exactly which base, CI is read for before merging.

#### The worker never waits for CI

No sleeping, no polling, no `--watch`, at any (role, scope, risk) — the ship
brief says it for every rendering. The reason is not politeness about turn time:

- the parent **already** re-verifies CI before every merge, against the reported
  head sha, and does not take a worker's green claim as evidence;
- so a worker that waits duplicates that check, holds its lease, and burns its
  own turn to produce a fact the parent discards.

A single **non-blocking** snapshot is still allowed (`gh run list --branch
<branch> --limit 3 --json conclusion,status,headSha,workflowName`); whatever it
says — queued, in progress, no runs at all — the worker reports and stops. It is
one per worker process (`ciStatusQuery`): a second `gh run list|view`,
`gh pr checks` or check-runs call is refused with a pointer to `report_result`.
Failure logs (`gh run view <id> --log` / `--log-failed`) are not status and stay
allowed. If CI comes back red afterwards, the parent promotes the held worker or
re-dispatches; that is cheaper than a worker asleep in a tool call.

**Enforcement, because wording already failed here once.** PR #39 fixed this as
brief guidance and lost to the next brief that asked for a green confirmation,
while two live workers sat in `sleep 270; gh run list …`. So the rule is code:
`detectCiWait` (`src/ci-wait.ts`) classifies a bash command, and the
`worker-reporter` extension **blocks** the call at the tool-call boundary — the
same hook that blocks parent-only tools — with a refusal that names the
sanctioned path. Three shapes are refused and nothing else:

| shape | example |
|---|---|
| `sleep_then_poll` | `sleep 270; gh run list --branch b --json conclusion,status,headSha` |
| `poll_loop` | `while true; do gh pr checks 42; sleep 30; done` |
| `blocking_watch` | `gh run watch <id>`, `gh pr checks 42 --watch` |

What is **not** refused, deliberately — over-blocking would be the worse defect:
a long-running command with no CI query (`npm test`, a build, a big rebase); a
bare `sleep 5`; a single non-blocking `gh run list`; and any of these words
inside a quoted string (`grep "sleep 270; gh run list" …`), because the `sleep`
must be in command position (start of command, or after `;`, `&&`, `||`, `|`,
`(`, a newline, `do`, `then`).

Why this option and not the alternatives the issue weighed: a per-tool-call
timeout cannot distinguish a 6-minute suite from a 6-minute sleep (the 30-minute
wedge observer is far too coarse to be the control), and a parent-owned "wait
for CI" affordance would institutionalize a wait the parent's own merge check
makes unnecessary. Refusing three named shapes is the one that can be made
precise.

**What that last clause rejects is a *wait*, not a *watcher* (cp-e2d).** The
affordance being refused above is one that lets somebody block: a turn held, a
lease held, a tool call asleep. [The CI/PR watch](#the-cipr-watch) holds
none of those — it is a slow, unref'd interval outside the model's context that
issues two non-blocking REST queries per held PR and emits a message — and it
exists because this rule left a real gap: with no worker waiting and no local
file changing, **nothing told the parent there was anything to verify**, so
green PRs sat unmerged until a human happened to look. The worker CI-wait ban is
unchanged; a test asserts that every command the watcher itself builds passes
`detectCiWait`.

**The prohibition is on *workers*, and scoping it that way weakens nothing**
(cp-uug). `detectCiWait` is wired into one place: the worker-reporter's
`tool_call` hook. It does not run in the parent, and it never has. So when the
parent's own code reads CI — `readCiForHead` for the merge ask
(`src/merge-ask.ts`), the same function for `cp_integrate`'s `ci_green?` step —
that is not an exemption from this rule, it is a different process that the rule
was never about. Two things follow, and both are deliberate:

- **`src/ci-wait.ts` is not edited, not relaxed and not made role-aware.** The
  guard that exists because prose lost once stays exactly as strict, and a test
  pins `detectCiWait("gh run watch 123 --exit-status")` as `blocking_watch`.
- **`cp_integrate` and `cp_merged` are in `WORKER_FORBIDDEN_TOOLS`.** A worker
  holding the integration tool could reach a CI wait *through* it, which is this
  loophole in a different shape. Parent-only is what keeps the scoping honest.

`cp_integrate` itself does not block on CI either: it takes one non-blocking
snapshot and returns `next: "wait"`. A tool call that blocks for the length of a
CI run is indistinguishable from a wedged one, and cp-e2d's watcher above is
what tells the parent when to call again.

### Worker environment contract

Job identity reaches a worker only through the environment, set by dispatch:

| variable | required | meaning |
|---|---|---|
| `CP_JOB_ID` | yes | the job this worker may report for |
| `CP_KIND` | yes | `ship` \| `research` |
| `CP_DELIVERY` | yes | `pr` \| `local` \| `pipeline` |
| `CP_RUN_DIR` | yes | absolute `state/runs/<job-id>` where the envelope or verdict is written |
| `CP_ROLE` | yes | `planner` \| `implementer` \| `gate-reviewer`; decides the terminating tool |
| `CP_WORKTREE` | no | leased worktree (artifact-outside and porcelain checks) |
| `CP_ARTIFACT_PATH` | no | predeclared research artifact path |

A missing or malformed value is a **load failure**: a worker that cannot say
which job it is must not run. Briefs never carry secrets, and the worker's
environment is the only channel for identity.

The worker environment builder strips an inherited `BEADS_DIR`/`BEADS_DB` and never
selects the home's `.beads`. Dispatch sets `BEADS_DIR` explicitly from the project's
tracker (`projectBeadsDb`: its active connection's endpoint, else an existing
`<clone>/.beads/beads.db`, else none) so `br show <id>` resolves from leased worktrees too. Reference use is
read-only by instruction, not a filesystem restriction; no database is created.

`self_assessment` is ported from the command-post research envelope
(`confidence`, `scope`, `blocking_unknowns`, `destructive_scope`,
`suggested_implementer_model`); yes/no strings became booleans. The gate
consumes it.

## Fleet state

`state/fleet.json` = `{schema_version, updated_at, jobs: FleetRecord[]}`, keyed
by `job_id` (duplicates are a validation error).

Job phases — policy level, derived from facts:

| phase | meaning | entered by |
|---|---|---|
| `waiting` | dispatched, no envelope yet | `cp_dispatch` |
| `held` | envelope accepted, worker + lease still alive | envelope intake |
| `done` | torn down: lease returned, worker close observed | `cp_teardown` |
| `failed` | worker died or a failure class was recorded | failure classifier |

`held` requires `reported_at`; `failed` requires a `failure` with a class.
Validation enforces both.

`held` → `waiting` is a legal transition, and the only one that walks a phase
backwards: a promote to a reported job reopens its envelope slot (§[Envelope
supersession](#envelope-supersession)). `reported_at` is
cleared and `supersessions` counts how many times it happened, so the two
invariants above keep holding by construction — a job with no `reported_at` is
never `held`.

T16 amendment: `held` is entered for **every** delivery, not only `pr`. The
phase says "an envelope was accepted and the worker and lease are still here";
what differs is how long that lasts, which intake reports as `next`:
`hold` for `delivery:pr` (until the PR lands) and `teardown` for
`local`/`pipeline` (immediately). The alternative — leaving a reported job in
`waiting` — would make `waiting` mean two different things and break the
"`held` requires `reported_at`" invariant's usefulness.

### Envelope intake

[`src/intake.ts`](../src/intake.ts) reacts to the worker's own event stream
(the `report_result` tool completing, then `agent_settled`) — never to a poll.
It then, in order: re-validates the envelope against the dispatch record (the
worker's word is not evidence), stamps `reported_at` **once per envelope
generation**, moves the job to `held` (a blocked planner envelope stays
`waiting` — the parent answers and `cp_send`s; the gate does not run), records receipts (PR url, artifact) and a
`cp:envelope_received` marker, and calls back with an operator-facing headline.

- **The PR url is resolved, never taken on the worker's word (pi-command-post-fbn).**
  For a completed `ship`/`delivery:pr` envelope, intake asks `gh pr list --head
  <job branch> --state all` in the project's origin repo ([`src/pr-resolve.ts`](../src/pr-resolve.ts)).
  Exactly one PR makes that url canonical and the one the receipt carries — a worker
  url that differs is **corrected** on the intake line and in the run journal
  (`pr_url_corrected`), never silently. No PR on the branch, more than one, or an
  `owner/repo` that contradicts the origin remote **refuses** the envelope, naming the
  branch and the expected `owner/repo`. An unreachable `gh` is not a pass: the url is
  kept only when its `owner/repo` matches the origin remote, and is reported
  **unverified** (`pr_url_unverified`). This is the one place the url is decided — the
  CI/PR watch, `cp_integrate`, `cp_merged` and the status block all read the stored
  receipt.

- **Idempotent.** A second intake of the same generation writes nothing and
  notifies nobody; the fleet file is byte-identical.
- **One delivery, whatever the generation.** Receipts are merged, not appended
  again: a PR is identified by its url and an artifact by its file, so a job
  that reports twice across a supersession still shows one PR receipt. Exactly
  one `reported_at` exists at a time — two envelopes never both count as the
  delivery.
- **Artifacts are stat-and-move.** A research artifact is checked for
  existence and size and copied into `state/artifacts/<job-id>/report.md`. It is
  never read — the parent's no-bodies rule applies to its own code first.
- **Contradictions fail the job.** An envelope naming another job, another
  kind, or breaking a delivery rule is `envelope_invalid`, as is a worker that
  exhausted its repair attempts (`envelope-rejected.json`).
- The accepted headline reaches the parent session as a custom message
  (`pi.sendMessage`, `customType: "cp-envelope"`), which is how the operator's
  session learns about work it did not do. It carries the **generation** and the
  **`reported_at`** of the envelope it describes, so a message can be told apart
  from the job's current state — see
  [Wake-up staleness](#wake-up-staleness).

**`stalled` is retired.** In command-post it meant "idle pane + old dispatch +
no `reported_at`", i.e. a guess about an unobservable pane. With RPC a worker
is `working`, `idle`, or observed-dead; a dead worker is `failed` with a cause.
Nothing is inferred from age.

Other custom messages wake the parent unasked:

- **`cp-wedged`** — a live worker holding a tool call that has emitted nothing
  for `WEDGED_TOOL_CALL_SECONDS`. It reports an unmatched
  `tool_execution_start`, not a phase, and the 30-minute notice kills nothing — see
  [Status view](#status-view) for why an unmatched pair is an
  observation and `stalled` was not. At the per-job wall-clock cap the same
  open call is ended as `wall_clock_exceeded` (`src/bounds.ts`).
- **`cp-answered`** — a human answered an open decision. Same reason, same
  shape: the parent must *act* on an answer, and an answer that only lands in a
  file leaves the work it unblocked waiting for a turn nobody invoked. See
  [Awaiting you](#awaiting-you) §An answer wakes the parent.
- **`cp-ci`** — CI finished for a held PR's current pushed head, or that PR
  merged or closed. The one fact in this list that no process here produces, so
  the only way to it is a periodic read of the remote. See
  [The CI/PR watch](#the-cipr-watch).
- **`cp-verdict`** — a background reviewer's decision landed (spec
  2026-09-05-async-reviewers): the plan gate, the diff review or the quality
  panel. Stamped with the surface and attempt (and the reviewed head for a diff
  review); stale once that attempt has no decision on disk, a later attempt
  exists, the job is over, or the head moved. See
  [Asynchronous reviewers](#asynchronous-reviewers-pendingjson-cp-verdict).
- **`cp-bound`** — a worker hit its wall-clock or tool-call cap. The job is
  `failed` with a class that names the bound; the worktree is not touched.
- **`cp-death`** — a worker died. Classified failure, disk evidence, next tools.
- **`cp-recovery`** — restart reconciliation listed candidates. One message per
  distinct job set; replayed only if never delivered. A restart after a drain adds
  one `RESTART AFTER DRAIN` notice from `state/drain.json` (see below) and clears it.

**Graceful drain** ([`src/drain.ts`](../src/drain.ts)): `/cp-drain [seconds]` in the
parent, or `cp_parent drain` (`timeout_s`) from the operator session, writes
`state/drain.json` and returns at once — no handler waits, and the parent keeps
processing envelopes. While the file exists, `cp_next` answers `draining`, and every
process start is refused with the drain named (`assertNotDraining`): dispatch (direct
and pipeline), every send except a steer into a busy worker's running turn (prompts,
briefs, follow_ups, and anything to an idle worker), plan gate
and `cp_review` reviewers (including the held-PR continuation's), bounded-recovery
revives (no attempt spent) and, as a backstop, `WorkerManager.spawn`. The
integration hold reads it as a home-wide hold: a merge step already running
finishes, the next one waits. The parent's ordinary tick (the widget refresh, also
run on every envelope, settle and durable wake-up) moves the record once to
`drained` when no worker or reviewer is mid-turn and no merge step runs, or to
`timeout` at the deadline (default 600 s, at most 3600 s), and journals exactly one
`cp-recovery` wake (`DRAIN: drained: safe to restart` or `DRAIN: drain timed out …`
naming the survivors); the bridge relays it to the operator by its durable id. A
failed journal leaves the outcome `reported: false` and is retried on the next tick.
Only the parent-lock owner may start a drain or decide its outcome. A drain already idle
answers `drained` directly and no wake follows. Only a fresh parent's startup
reconcile reports the record (job, phase, lease, head) and removes the file — never
the process that is draining. `cp_parent stop` and `rotate` say whether the parent
was drained, or warn how many live workers they will kill. **Cancel:** `/cp-drain cancel`
(the host's `drainCancel` op, used by cp-update on a drain timeout) is owner-only too; it
removes a `draining` or `timeout` record — never a `drained` one, the restart already
prepared — and journals one wake `DRAIN: cancelled — … open again` (id
`drain:<started>:cancelled`), after which every gate is open.

(`cp-unreported` is a settle-boundary fact rather than a
message type of its own machinery — see
[The settle boundary](#the-settle-boundary-srcsettlets).)

### State transitions and wake-ups

Every change to `failed`, `unreported`, `held`, or an awaiting/checkpoint row
announces itself with a wake-up kind, or is parent-authored (`none`). Policy is
`STATE_WAKEUP_ANNOUNCEMENTS` in [`src/contracts.ts`](../src/contracts.ts).
Death, bound and recovery are journaled in `state/wakeups.json` so a parent
restart replays undelivered ones exactly once.

| event | to | wake-up |
|---|---|---|
| `envelope_accepted` | held | `cp-envelope` |
| `worker_death` | failed | `cp-death` |
| `hard_bound` | failed | `cp-bound` |
| `envelope_invalid` | failed | `cp-death` |
| `budget_exceeded` | failed | `cp-death` |
| `model_call_failed` | failed | `cp-death` |
| `reconcile_unsalvageable` | failed | `cp-recovery` |
| `unreported_recorded` | waiting | `cp-unreported` |
| `wedged_tool_call` | | `cp-wedged` |
| `ci_observation` | | `cp-ci` |
| `review_verdict` | | `cp-verdict` |
| `checkpoint_answered` | | `cp-answered` |
| `awaiting_answered` | | `cp-answered` |
| `deferred_regate` | | `cp-ci` |
| `checkpoint_created` | | none |
| `awaiting_created` | | none |

`origin` is preserved (default `terminal`) so Slack scoping can be added later
without a migration. Nothing reads it today.

### Wake-up staleness

**A wake-up describes the fleet as it is when the parent reads it, or it does
not describe it at all.** [`src/wakeups.ts`](../src/wakeups.ts) owns this, and
it applies to all five unasked messages above.

The defect: a `cp-envelope` was delivered carrying the summary of an envelope a
`cp_send` promote had already archived (`envelope-superseded-1.json`,
`reported_at` cleared, phase back to `waiting`, worker alive mid-rebase). It
read exactly like a fresh report; acting on it meant merging an unrebased PR or
tearing down a worker mid-rebase. Two more of the same shape followed in one
session, including a `cp-envelope` for a job already merged, torn down and
closed. pi's `followUp` queue delivers minutes after the send, so this is a
property of the notification path — not a prompt for more parent diligence.

- **Every wake-up carries a stamp** (`details.cp_wakeup`): kind, `job_id`, the
  envelope `generation`, the `reported_at` it describes, the tool call or
  awaiting ids it names, and `issued_at`. A message for generation N is then
  recognisable once the job is on N+1.
- **The stamp is re-checked against disk twice.** At send time
  (`WakeupNotifier`, which does not send an already-stale wake-up) and at
  **delivery** time (`reviewWakeups`, wired to pi's `context` event — the last
  moment before the message reaches the model). The second check is the load
  bearing one: a send-time check alone would have delivered all three observed
  messages.
- **A superseded wake-up's body does not travel.** The content the model sees is
  replaced with a short notice naming the job, what the message claimed and what
  is true now, pointing at `/status` and `/watch <job-id>`. A withheld summary
  that is still readable is a summary somebody still acts on.
- **Silence is recorded.** Every withheld or rewritten wake-up appends a
  `cp:wakeup_suppressed` marker (kind, generation, `issued_at`, delay, reason,
  the stamp's `keys` (at most 8), and which stage caught it) to the job's run
  log. A jobless `cp-recovery` marker lands in the run log of each listed job
  that has one. Never a body. **A marker is
  not activity**: it records a message the parent declined to send, so it
  advances `event_count` but never `last_activity_at` (see Run artifacts).
  The replay memory (`state/wakeup-replay.json`) keeps the first withhold
  reason (at most `WAKEUP_WITHHELD_REASON_MAX_CHARS`, 300) as the `withheld:`
  value, so a later context says *why* ("already withheld in an earlier
  context: …"); a legacy entry says "original reason not recorded".
- **Age is never evidence of staleness.** Staleness is decided from facts (a
  generation, a `reported_at`, a phase, an open tool call). `WAKEUP_LATE_SECONDS`
  only adds a line saying how late a still-true wake-up was — `stalled` stays
  retired and nothing is inferred from silence.

| kind | stale when |
|---|---|
| `cp-envelope` | the job is on a later generation, nothing is filed for the stamped one, a different `reported_at` is live, or the job is already `done`/`failed` |
| `cp-unreported` | the job has since reported, the slot was reopened, or the job is `done`/`failed` — **unless the stamp's `keys` name the very failure class the record now carries** (cp-0wq7): a stamp that names the class is explaining the current failure, not an old state. A `to: failed` transition itself is journaled as `cp-death` or `cp-bound`, not this kind |
| `cp-wedged` | that tool call ended, the worker is gone, or the job is `done`/`failed` |
| `cp-ci` | the branch's head moved off the sha the message describes, the slot was reopened, or the job is `done`/`failed` |
| `cp-answered` | **never** for the answer — stamped and annotated, never withheld. A second copy carrying only already-delivered ids is rewritten as a replay (cp-5mgg) |
| `cp-bound` | the job is `done`/`failed` with a different class, or has since reported — **unless** the stamp names the bound class the record now carries |
| `cp-death` | no fleet record (torn down), or the job is `done`/`failed` with a different class |
| `cp-recovery` | every listed job is gone or `done` |

That last row is the one asymmetry, and it is deliberate: an envelope, a wedge
and an unreported settle are claims about a job's current phase, and a phase
moves. An answered decision is a fact about something a human did, which never
becomes false — and the failure mode on that path is a *lost* decision, which is
the whole reason [`src/answered.ts`](../src/answered.ts) exists.

What that row does **not** license is the same answer delivered twice. cp-5mgg
adds one check to the same pass, and it is a property of the context rather than
of the fleet: the **first** `cp-answered` carrying an id is the delivery, and a
later message carrying *only* ids an earlier one already carried is rewritten to
a replay notice (`REPLAYED_WAKEUP_HEADLINE`) that names them and drops the
instruction to act. No cache, no disk state, nothing that can outlive the
conversation it reads; a first copy is never touched and a message with any
unseen id travels whole, so a lost decision stays impossible. See
[An answer wakes the parent](#an-answer-wakes-the-parent)
§One answer, one delivery.

The durable kinds get the same context-level check (cp-ze1t). A
`cp-death`/`cp-bound`/`cp-recovery` copy whose `details.durable_id` an earlier
message in the conversation already carried is rewritten as a replay: the
outbox re-sends after `DURABLE_WAKEUP_RETRY_SECONDS` while pi's `followUp` queue
may still hold the first copy, and `enqueue` refuses a known id, so one id is
never news twice. The first copy's `issued_at#timestamp` token is kept in the
persisted replay memory (`state/wakeup-replay.json`, key `durable:<id>`), so
re-review on every provider request keeps it and drops only later copies; a
message with no readable `durable_id` travels unchanged.

The `cp-ci` row needs one fact the other four do not: the branch's current head.
It is read from `state/ci-watch.json` — the watcher's own file — through
`wakeupFacts({… , ciHead})`, and that source is **files-only by contract**:
`reviewWakeups` is wired to pi's `context` event and therefore runs on every
provider request, so re-querying the remote there would be a poll in the hottest
path in the process.

#### A head check is directional

That watcher file is an *observation*, taken at its own cadence, and between a
rebase and the next tick it names the head the branch has already moved off. On
cp-cjmu it did exactly that: the worker pushed `a39e4425b7b4` and reported it, a
`cp_review` passed on that same head, and the `cp-verdict` was withheld as "the
branch moved" because the watcher still held the pre-rebase `3d3355f0c4d2`. The
one-shot resend was then spent on a second copy that was withheld for the same
reason, its key was dropped, and no card ever reached the parent.

The inverse gap is just as real, and rules it out as a matter of provenance: the
fleet record only knows the head a worker **reported**, so a push nobody
reported yet leaves it naming a head the PR has moved off — and a verdict about
*that* head must not read as fresh either.

So there are two readings of one branch, each with the moment it was taken
(`headMoved`, [`src/wakeups.ts`](../src/wakeups.ts)):

| reading | head | taken at | from |
|---|---|---|---|
| the watcher's observation | `head_sha` | `head_observed_at` | `state/ci-watch.json`'s `head_observed_at` |
| the fleet's own record | `fleet_head_sha` | `fleet_head_at` | the last filed envelope's `head_sha` / `received_at` |

**Ownership first, then time** (pi-command-post-8ok). Letting time alone decide
made the two readings interchangeable, and they are not: each kind of claim has
an owning source, and only that source can withhold it.

- A **`cp-ci`** claim is the watcher's own read of GitHub, so only a later read
  of GitHub can contradict it. Fleet-owned state never withholds a fact GitHub
  reported — not an envelope a worker filed, and not a head the fleet still
  remembers after `CiWatchStore.prune` dropped the observation (which is what a
  merged receipt does). A green or merged PR nobody is told about is the exact
  failure the watcher exists to prevent.
- A **`cp-verdict`** about a reviewed head is a claim about a head the fleet
  owns, so the fleet reading decides it — **except** that a *strictly later*
  reading of the remote is a push nobody reported, which is real news about the
  reviewed head and still supersedes it. That is the inverse gap above, and it
  is unchanged.

**"Strictly later" is proved, never assumed.** The observation may contradict a
fleet-owned claim only when it is **dated**, and — where a fleet reading exists
to compare it with — dated strictly after it. Neither an undated observation nor
a *missing* fleet reading is evidence of a later push: "there is nothing to be
later than" is ignorance, and reading it as proof is what let an undated,
uncorroborated observation withhold a verdict. So when nothing can be proved the
owning reading decides, and where the owning reading is itself absent or
degraded, nothing supersedes at all — the direction that delivers the card.

Genuine suppression is untouched — a head the owning reading has moved off is
still superseded — and the generation checks are unchanged. Both readings stay
files-only.

**A timestamp is the age of the head, never the age of the last attempt.**
`state/ci-watch.json` keeps `last_checked_at` (an attempt happened, advanced by a
failed query too) apart from `head_observed_at` (a head was actually read from
the remote), and `CiWatch.observedAt` — the source of `head_observed_at` above —
returns the second. They were one field, so every failed `gh` query made a head
nobody had re-read look freshly observed: a lagging observation grew *younger*
on each retry until it outranked the fleet's own record and withheld the pass,
and it did so more surely the longer the outage lasted.

**Absent and broken are different facts.** The head sources are supplied by
`wakeupHeadSources` in the extension and are deliberately catch-free; a source
that throws is reported through `onSourceFailure` (journaled once per source and
job as `wakeup_source_failed`, by `sourceFailureRecorder`, whose dedupe memory
is itself bounded at `WAKEUP_SOURCE_FAILURE_MEMORY`: cardinality never exceeds
the cap, and a key that recurs after the cap is reached is journaled exactly once
more — bounded repetition, never a stream) and marks that reading degraded —
`fleet_head_degraded` for the fleet record, `head_degraded` for the observation —
which supersedes nothing for the claims it owns. A bare `catch` returning
`undefined` reads exactly like "this home has no such fact", so a wiring failure
would have silently restored the lagging-observation behaviour with nothing
anywhere to say so.

The delivery side matches. A `cp-verdict` handed to the transport but *withheld*
by this check delivered nothing, so it does not spend the one resend
(`ReviewRuns.resendDue`): only a copy that actually reached the transport does,
and duplicate delivery stays bounded at two. What bounds a *withheld* one is
time, and the time is the watcher's: the fact it is waiting on can be
`CI_WATCH_MAX_BACKOFF_MS` (15 minutes) away, so the key survives until
`VERDICT_SUPPRESSED_RETRY_MAX_SECONDS` past its first send — derived from that
cadence constant — and is then dropped for good. A send-count bound at the
delivery interval expired before the watcher had even looked again.

### The CI/PR watch

**The parent is woken when a held PR's CI finishes for its current pushed head,
or when that PR merges or closes.** [`src/ci-watch.ts`](../src/ci-watch.ts) owns
it; the extension owns the interval.

The gap it closes is structural, and this repo created it: a worker never waits
for CI (cp-kzc, above), no worker emits a run's completion, and no local file
changes when GitHub finishes one. The parent sleeps on wake-ups and polls
nothing. So once the fleet went idle, green PRs sat unmerged until a human
noticed — twice in one session, after four merge-ready PRs had already sat for
fourteen hours.

**A third watcher shape, and the first two genuinely cannot reach this.** An
event-driven watcher (`EnvelopeIntake`, `SettleWatcher`) needs a stream, and
there is none. The 5-second snapshot tick (`WedgedWatch`) is *files-only* by
rule — `src/widget.ts`: "a 5-second `br`/`gh` call is not a widget". And
`cp_status_block`'s CI gate (cp-gmy) only runs **inside a parent turn**, which
cannot fix a defect whose symptom is the absence of turns. So: a dedicated,
`.unref()`ed `setInterval` at `CI_WATCH_INTERVAL_MS` (60s, overridable with
`CP_CI_WATCH_SECONDS`), started in **every** mode (TUI and `pi --mode rpc`,
including `hasUI: false`) and cleared at `session_shutdown`. The widget timer
stays `hasUI`-gated; the CI watch does not.

**What is watched** — every clause is a fact on the fleet record, and the set
drains itself:

| clause | why |
|---|---|
| `delivery === "pr"` | there is no PR to watch otherwise |
| `phase === "held"` | `waiting` has nothing contractually pushed; `done`/`failed` are over |
| a `pr` receipt with a url | written by `EnvelopeIntake` |
| that receipt is not `merged`/`landed` | once `cp_merged` records the receipt there is nothing left to watch |
| `reported_at` is present | a promote clears it and returns the phase to `waiting` |

Worker liveness is deliberately **not** in the predicate: a `held`
`delivery:pr` job keeps its worker alive by design.

**What it emits**, one `cp-ci` per tick coalescing every due fact for every job:
`ci_green`, `ci_failed`, `pr_merged`, `pr_closed`. Nothing at all for CI still
running, for a head no run has started on yet, or for an unknown state — those
are the states the watcher exists to sit through quietly.

- **CI is evaluated by cp-gmy's evaluator, unforked.** `evaluateMergeAskCi`
  already encodes the only correct rule ("a completed run counts only when its
  `headSha` is the branch's current pushed head; one unfinished run on that head
  defers the whole aggregate"). There is one evaluator, always.
- **Two REST queries per job per tick**: `gh api repos/{o}/{r}/pulls/{n}` (state,
  merged, merge commit *and* the head sha, in one request) and
  `gh run list --branch <b> --limit 10 --json conclusion,status,headSha,workflowName`.
  **Never the GraphQL check-rollup fields** (`gh pr checks`,
  `gh pr view --json statusCheckRollup`): they 403 with this home's token.
- **Never a blocking shape.** No `sleep`, no shell loop, no `gh run watch`, no
  `--watch`; every subprocess is bounded by `execFile`'s own `timeout` option,
  because `timeout(1)` is absent on these machines. A test feeds every command
  the watcher builds to `detectCiWait` and asserts `undefined`.
- **The 30-minute wedge observer cannot be tripped**: `isCandidate()` requires an
  open tool call on a live *worker* in a run projection, and these subprocesses
  are the parent extension's own children.
- **Backoff**, persisted per job in `next_due_at`: base while a verdict is still
  coming, `× CI_WATCH_IDLE_MULTIPLIER` once this head's verdict is known and only
  the merge question is left, and `60s → 2m → 4m → 8m` capped at
  `CI_WATCH_MAX_BACKOFF_MS` after a query error (reset on the first success).
  A missing `gh` (it is not in `REQUIRED_TOOLS`) disables the watch for the
  session and says so **once** — an alarm that fires every tick is an alarm
  nobody reads.
- **A tick never overlaps itself** (the `EnvelopeIntake.#inFlight` shape).

**Delivery is at-least-once, keyed on `(job_id, head_sha, event)`.** cp-nx7's
rule applies unchanged: a send is a hand-off to pi's `followUp` queue, not
evidence of arrival, so a fact is written to `announced` only when the `cp-ci`
message is **observed landing in the parent's context** (`ciKeysFromMessage`,
the `message_start`/`context` hooks). Until then it is in-memory in-flight and
is derived and sent again after `CI_WATCH_DELIVERY_RETRY_SECONDS`. A duplicate
CI notice is idempotent and visible; a lost one is invisible, which is the whole
reason this exists. `announced` is **persisted** — the deliberate inversion of
`WedgedWatch`'s in-memory memory, because a still-wedged call is news again to a
fresh session while "CI went green on `d48a81d`" is history once somebody has
read it.

A force-push is therefore simply an unseen key: the old head's runs stop
counting the moment the head moves, a green already delivered for it is not
retracted (it was true about a sha that is now history), and one still in flight
is withheld by the staleness check above.

**Evidence, never authorization.** A `cp-ci` wake-up merges nothing, closes no
br issue, tears nothing down, writes no merge receipt and **declares no
Awaiting-you row** — a background timer must never mint decisions. The watcher
still merges nothing and decides nothing. On red there is no merge question at
all (merging red is already forbidden). On `pr_merged` the follow-on is the
existing contract: `cp_merged <job-id>`, close the br issue, `cp_teardown`.

**The wake-up is the read, so the parent does not re-take it (cp-3zbp).** The
notice is derived from two REST queries against the remote for the branch's
current pushed head, through the same evaluator `cp_status_block`'s merge gate
uses. So on green the message *is* the CI verdict for the sha it names, and a
parent that answers it with `gh run list`, `gh pr checks` or `gh pr view` is
re-proving a fact it was handed — one of those (`--json statusCheckRollup`)
403s with this home's token, which is how an observed session spent a turn on a
second `gh pr view` after the first failed. Ancestry and merge permission are
not the parent's to hand-roll either (`git merge-base` on a PR base is exactly
the check `cp_integrate` derives from git and `gh` every call): the whole
follow-on to a green `cp-ci` is `cp_integrate <job-id>`, branching on `next`. A
stale notice is answered from the fleet files and then by `cp_integrate`, which
re-reads CI for the current head as its first step — never by a remote query in
the parent's own turn. The notice never says "merge it", because whether the
repository permits the merge is `cp_integrate`'s read of the repository's own
rules (cp-x7i, answered), not the watcher's word. And because the wake-up
declares no Awaiting-you row, it is not a reason to render a second
`cp_status_block` restating a row already open: re-pass a row only when the
decision it asks for has changed.

The watch **ends at the wake-up**. Whoever executes afterwards — the parent by
hand, or a merge executor — consumes that same message as its input; nothing
here rebases, resolves a conflict, merges, or decides who may.

`state/ci-watch.json` (`CiWatchFileSchema`, atomic, validated) holds per job:
the last observed `head_sha`, `announced`, `last_checked_at`, `next_due_at`,
`consecutive_failures`, the last CI classification and the last error. Entries
are pruned every tick to the current watch set, so the file is bounded by the
fleet and not by history; an unreadable one degrades to "no memory" (one
duplicate notice) rather than throwing out of a tick.

#### Main CI: a red `origin/main` pauses integration (k52)

The same tick also reads each registered project's own `main` ([`src/main-ci.ts`](../src/main-ci.ts)): `git fetch origin main`, `git rev-parse origin/main` (the tip), one `gh run list --branch main`. Only runs on the tip count.

- **Set** `state/main-ci.json`'s row for the project on the first completed non-green run on the tip: one job-less `cp-ci` wake (`details.main_ci`, `MAIN IS RED`) naming the sha, workflow and failing test line (or job name). A repeat or new red tip, pending, no runs, or an unreadable query changes nothing and wakes nobody.
- **Clear** only when every run on the current tip is green: one `MAIN IS GREEN AGAIN` wake. Green on an older sha never clears.
- **Pause.** While latched, `cp_integrate` returns `wait` (`main is red since <sha12>: …`) before its CI read, so neither the permitted merge nor the human-checkpoint fallback can run. **Fix-forward exception:** `origin/main` (freshly fetched) is an ancestor of `origin/<branch>` and CI is green on the pushed head; review, permission and draft rules still apply.
- **Per project, fail open, logged.** Another project's latch never blocks; a missing or unreadable file never blocks (an integrate fact says so). The tick never overwrites an unreadable file; every query or state fault is a durable `ciWatchFailed` recovery wake, once per cause. Transition-only: a lost send is journaled, not retried.

### Headless parent (RPC / `CP_HEADLESS`)

The CP parent is a full orchestrator without a TUI. `pi --mode rpc` is the
bridge-driven mode; `CP_HEADLESS=1` forces the same even in a TUI.

**Timers** (`src/parent-session.ts`, asserted per mode):

| timer | TUI + UI | RPC | print/json |
|---|---|---|---|
| widget refresh | on | on if `hasUI` | off |
| key listeners | on | off | off |
| CI watch | on | on | on |
| orchestration sweeps (answered / wedged / verdict resend) | on | on | on |

Display vs orchestration is the split: a headless re-entry used to skip the CI
watch because "nobody to wake". Under the bridge, that parent **is** the one
to wake. `/doctor` (human form) prints `session: <mode> · …` and which of
those timers are actually running.

**Overlays never open** when `mode !== "tui"` or `CP_HEADLESS=1`
(`routeAwaitingUi`). Escalations are structured messages (`operatorNotify` →
`ctx.ui.notify` when a UI exists, else stderr). The bridge is the operator
channel: RPC `extension_ui_request` / `sendMessage` follow-ups, not a TUI.

**Wake-ups.** `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
still produces a parent turn whose reply is on the RPC stream. A wake-up that
arrives **mid-turn** is queued by pi and delivered after the in-flight turn;
it is never dropped. `sendUserMessage` is that same `sendMessage` path.
An operator send through the bridge is a `prompt` with `streamingBehavior:
"steer"`, so it does not wait behind wake-ups already queued (see Bridge).

**Busy-wake gate (cp-vy73).** While the parent's run is busy (`agent_start` to
`agent_settled`) and one triggering wake-up already went out in that run, later
wake-ups are sent with `{ triggerTurn: false }`: they ride into the next
request instead of queueing one follow-up turn each. `cp-answered` always
triggers, and an idle parent never gets a non-triggering send (pi would append
it with no turn), so `agent_settled` clears busy before anything else runs.
A non-triggering notice that no later request carried (the run's last turn was
text-only) would be stranded, so `agent_settled` sends one triggering
`cp-wakeup-nudge` ("N fleet notice(s) arrived while you were busy; they are
above.") when more were sent than the last `before_provider_request` had seen.
After an operator abort (the run's last assistant message is `aborted`) no
nudge is sent, so the gate never starts a turn after an Esc; those notices
reach the model with the next prompt (outboxes still re-send unconfirmed facts
under their own rules). Two consequences:
- **Arrival of a non-triggering notice is confirmed by the `context` hook**, at
  the next model request, never by `message_start` — pi's flush does not emit
  extension `message_start`/`message_end` for it.
- **Notice order is not send order.** A non-triggering notice lands at the next
  `turn_end` flush, ahead of an earlier triggering follow-up that pi drains only
  after the current turn.

**`ctx.ui.*` audit** (headless path produces the same information as a plain
message):

| call | headless path |
|---|---|
| `ui.notify` | `operatorNotify` — notify if `hasUI`, else stderr |
| command output (`/status`, `/doctor`, …) | `emit` / `chooseOutputChannel`: entry in TUI, notify in RPC, stderr if no UI |
| `ui.select` / `ui.input` | refused or unused (`Asker` returns undefined without UI; `/cp-decide` has a direct form) |
| `ui.custom` (overlays) | `routeAwaitingUi` → plain, reason named |
| `ui.setWidget` | no-op when `!hasUI`; RPC still paints if `hasUI` |
| `ui.onTerminalInput` | not registered unless TUI + UI and not headless |
| `ui.setWorkingVisible` | only on `ui_prompt_*` (a UI is already attached) |

### Bridge (`src/cp-bridge.ts`)

The main session does not load `extensions/command-post`. `bin/cp-operator`
starts pi with `--no-extensions -e extensions/cp-bridge`. Fleet tools
(`cp_dispatch`, `cp_integrate`, the rest) stay on the headless parent.

`cp_parent start` takes a home (mode is always `multi` and may be omitted; `single` is refused), and an optional model.
Omitted model resolves, in order: `CP_PARENT_MODEL` env, the operator session's
own model (`ctx.model`, or `PI_PROVIDER`+`PI_MODEL`), else a refusal naming both
options — the model is never guessed. Either way the resolved id is checked
against `ctx.modelRegistry` (`registryProbe`) before spawn; an unknown or
unauthenticated model is refused with the known models, spawning nothing.
`cp_parent start` also refuses when `state/parent.lock` names a live pid.
`cp_parent send` writes prose over RPC and returns a `BRIDGE_RECEIPT_LEVELS`
level, its `send_id`, and the reply when the turn settles honestly within the
wait. `cp_parent status` reports alive, pid, session file, last reply time,
open escalations from the store, and `sends` (each unobserved send, plus the
last 10 observed, with its state and receipt level). `cp_parent stop` is a
graceful observed close that ends never-landed sends `undeliverable`.

**Operator questions.** Before relaying any human question, use `cp_parent ask`
with `ask: {project, question, options: [{label, consequence}], recommendation}`
and optional `source_escalation`, `job_ids`, `evidence_paths`, and `context` —
plain-text background up to 2,000 characters (what happened, what each option
really does, the risk), so the question itself stays short. It returns an
`ask-` id. `ask_answer` takes `id` and the human's verbatim `answer`;
`ask_withdraw` takes `id` and `reason`. Both refuse unknown or closed ids.
These actions append durable events to `state/operator/asks.jsonl`,
without sending to the parent or authorizing
anything. Existing parent decision channels remain mandatory. Questions and
one to five options are required; consequences over 200 characters are
shortened with an ellipsis. `status.asks` lists open questions. `OperatorAsks`
provides open/answer/withdraw/list and recent views; recent is newest-opened
first, including settled asks. The viewer shows every open ask as a decision
card — on `#awaiting` and pinned above the Full transcript's composer — whose
option buttons and "Other answer…" field go through the guarded
`POST /api/operator/message` path (`{kind:"answer"}` / `{kind:"message"}`).

`cp_parent doctor` and `version` read the live parent's `/doctor` and
`/cp-version` output, including its mode and home. They require a settled
parent with no pending send, attach without starting or replacing it, and
never create a durable send or an LLM turn. Missing commands, unavailable
parents and diagnostic failures return explicit errors; doctor findings
retain the parent's info/error level.

**Parent context control.** `cp_parent compact` and `rotate` require a settled parent with no pending durable send; `model <provider/id>` switches live without touching workers. Automatic compaction is on by default at 200000 context tokens (`DEFAULT_PARENT_COMPACT_TOKENS`, used when `data/parent.json` is absent); a home overrides it with `data/parent.json`:

```json
{ "compact_at_tokens": 150000 }
```

An existing `parent.json` with an invalid `compact_at_tokens` disables automatic compaction and `/doctor` warns; only an absent file takes the default. After each settled turn the bridge reads pi's context estimate and holds the next send until automatic control completes. At or above this limit it compacts before the next turn. Compaction instructions name the current open escalation ids, held PR jobs, active mandate ids and unsettled bridge sends from disk, preserving standing operator instructions and any caller-supplied focus. A `cp_next` mission-end recommendation rotates the session after settlement once no other active grant remains. The bridge archives the old transcript and persists the new path, last compact/rotate times, context tokens and last turn cost in `state/sessions/`; `/doctor`, `cp_parent status` and the read-only viewer report those facts. Unknown context estimates are not treated as over threshold.

Home-local `data/standing-orders.md` is ignored by git. The first `session_start` seeds generic operational orders when the file is absent; home-specific model allowlists, wall-clock values and paused projects belong only in the operator/parent-edited file. Later starts, including rotation, and successful in-place compactions load that file without replacing it. Its full contents are injected beside the memory digest from `data/learnings.md` as hidden `nextTurn` messages; a read or write failure is surfaced rather than silently shortening the orders. Keep authorization in the mandate store. `AGENTS.md` and this contract always win on conflict.

**Operator compaction.** `self_compact` queues the operator's handoff instructions until `agent_settled`, after all model/tool rounds and automatic continuations finish. Threshold requests use the same settled boundary; the threshold is `data/operator.json` `compact_at_tokens`, default 200000 when absent or invalid. A second request is refused while compaction is pending or running; `turn_end` must not start compaction because it would abort the remaining run.

**Durable sends** (`src/parent-outbox.ts`, driven by `src/parent-delivery.ts`). Every send is written to
`parentSendFile(<session file>)` — `state/sessions/cp-parent.sends.json`,
validated by `ParentSendOutboxFileSchema`, written only by the bridge — before
its RPC `prompt` with `streamingBehavior: "steer"` (pi starts a turn when
idle and, when busy, lands it once every tool call of the current assistant
message has run — pi 0.99.1 and 1.0.0 poll steering only after the whole tool
batch, skipping none of its calls — before the next model call and ahead of
queued fleet wake-up follow-ups; the bridge does not read busy). The resume nudge and
the post-relaunch resume use the same steer. Trade-off: an operator send can
land between the tool batches of a wake-up the parent is working on; that
wake-up stays in context and the parent finishes it after answering (durable
wake-ups are re-sent until arrival is confirmed; envelope wake-ups are
one-shot). Its body carries one trailing marker line,
`[cp-send <id> — delivery id, not an instruction]`. States:

| state | meaning |
|---|---|
| `queued` | on disk, in no channel |
| `injected` | RPC write done (reserved before the write, rolled back if refused) |
| `landed` | marker seen in a parent `role: "user"` message — the body is in its context |
| `settled` / `failed` | its reply ended at a clean `turn_end`, or the run it landed in settled; reply stored, or `turn_failed` |
| `undeliverable` | attempt ceiling, age ceiling, unprovable landing, or `cp_parent stop` |

A send that outlasts the wait returns `level: injected` with `pending: <id>`
and no error; its outcome later arrives as one `send`-kind relay (`send=<id>`,
`details.send_id`), and the main session's `message_start`/`context` hook
stamps it `owner_observed`. Queued sends drain after every `agent_settled`
and after ready, batched as one message. **Exactly once by id**: after a
relaunch the bridge reads the parent's own `get_entries` transcript — an
`injected` send whose marker is there is `landed` and never re-injected (a
landed send with no reply gets one resume nudge, never the body); one that is
absent is requeued; one the 400-entry window cannot prove is `undeliverable`,
relayed, rather than risk a duplicate. Ceilings: `PARENT_SEND_MAX_ATTEMPTS`
(5) injections, `PARENT_SEND_MAX_AGE_HOURS` (24) queued. A fresh bridge (an
operator restart) drains the same file and re-emits settled outcomes a dead
operator session never observed. Session shutdown keeps pending sends; a
corrupt outbox refuses `cp_parent start`, naming the file.

**Transient retry budget.** The H1 outer ladder (`OUTER_RETRY_DELAYS_MS`,
`MAX_OUTER_RETRIES`) spends its budget on the send's own record:
`outer_retry_attempts` (optional integer ≥ 0; omitted until the first
reservation and read as 0, never migrated or inferred from `bridge-retry.jsonl`). It counts transient-retry
reservations, not RPC injections (`attempts`). `ParentSendOutbox.reserveOuterRetry`
reserves the next ordinal on disk, `landed` sends only, before the sleep or the
nudge; a death mid-sleep therefore leaves it spent, and the next transient
failure takes the next ordinal and delay. The in-memory map keeps only pending
timer identities. A reservation that cannot be read or written journals
`outer_retry_reservation_failed`, retries nothing and fails the send once through
the usual waiter/relay path. The normal restart resume nudge is separate: not
counted, and no backoff deadline is persisted. Downgrade: an older binary's
schema rejects a sends file carrying the new field — roll back only with the
parent stopped and a backup, never by erasing counters on a running home.

**Segments** (`src/bridge-segments.ts`). A run that keeps taking follow-ups
settles late, so a clean `turn_end` — no tool results, `stopReason` not
`error`/`aborted`/`length` — ends a segment. There each landed, unsettled send
whose span holds an assistant answer settles with the text from its landing to
the segment end (or the next landing): its waiter returns `owner_observed`, or
its one `send` relay goes out, and it counts once toward the relaunch cap. The
parent's own text since the last segment that no send's span covers relays as
one `wake` with the jobs stamped since the last wake relay. `agent_settled`
handles only what is left: sends still open (a failed span, or the transient
resume ladder), the remaining wake text, the run's model error when no send is
open, refused escalations and automatic context control. No send settles or
counts twice.

Receipts are `injected | turn_settled | http_accepted | owner_observed |
turn_failed`. Never overload those as `accepted`. This channel is RPC, so
`http_accepted` is never claimed. A mid-turn wake into the main session is
`followUp`, not steer: a busy coordinator queues it and does not drop it.

Only the assistant's own messages ever count toward a reply or a wake; the
user message the bridge injects is never mistaken for one. A turn's last
assistant message carrying pi's own `stopReason: "error"` (or a turn with no
assistant message at all) is `turn_failed`: `reply` stays unset, the receipt
never climbs past `turn_settled`, and the error text is the provider's own
words. The same turn on the spontaneous (non-`send`) stream is relayed as
kind `error`, not `wake`. Three `turn_failed` sends in a row stop the parent
and emit one `relaunch`-kind message naming why, instead of leaving a
dead-model parent sitting "alive".
Turns the parent takes that were not caused by `send`, and `cp_escalate`
calls on the stream, become messages in the main session, tagged with kind
and job id. Escalation duplicates are suppressed by id. A parent message that
carries `STALE WAKE-UP — do not act on this` is marked stale.

**Escalation backstop** ([`src/escalation-backstop.ts`](../src/escalation-backstop.ts)).
The operator session relays, once per id, any escalation open at least
`ESCALATION_BACKSTOP_SECONDS` (600, the dashboard's amber threshold) that no
open operator ask represents and that never reached the session as a relay —
a gate-raised escalation has no `cp_escalate` relay path. Bridge escalation
relays are recorded too, in the same ledger, `state/operator/escalation-relays.json`,
so neither path repeats the other, across restarts. It runs at `session_start`
and on a 60 s tick; a send-reply mention of the id does not swallow it. It is
not a parent wake and never authorization. An unreadable ledger or store sets
the `escalation-backstop` status line and relays nothing. Two edges are
accepted: the ledger is claimed before the push, so a session that dies in
between loses that one relay; two operator sessions on one home can both relay.
A `wake` whose stamped job ids (wake-up stamps, and a `cp-schedule` fire
message's `details.job_id`) are all scheduled jobs (ledger label
`schedule:<id>`) is not relayed: scheduled jobs are independent jobs, and their
runs show on the Schedules page (cp-hhuf P1). Escalations and errors for the
same job still relay, and so does a turn that also touched an unscheduled job;
an unreadable ledger drops nothing. The filter is `deliverableRelay`
(`src/relay-scope.ts`), the one choke point for live and backlog relays.
A wake relay for a run that received an accepted `cp-envelope` appends
`envelope <job> (<status>), verbatim: <summary>` from the envelope's structured
details (`withEnvelopeSummaries`, issue #2), so the parent's paraphrase sits
next to what the worker filed. A `killed-unreported:` durable wake-up is relayed
directly, like `drain:`.

On observed parent death the bridge relaunches the same `--session` once per
death so `session_start` runs fleet reconcile, and announces once, naming how
many undelivered sends it will deliver once by id after ready; sends that
already reached the parent are not replayed. A file inbox for a wedged RPC
channel is deferred.

**Parent host** (`src/parent-host.ts`, item 23). A detached local child owns
the bridge above — parent `WorkerProcess`, outbox and relay stream — so the
parent and its workers outlive the operator process. Clients speak framed,
versioned (`PARENT_HOST_PROTOCOL`) JSON lines on the owner-only socket
`state/parent-host.<gen>.sock`, each request carrying the per-host token from
the 0600 record `state/parent-host.<gen>.json`; every RPC-reaching op runs on
one serialization queue. The current host is the highest generation, and its
record is never deleted, only superseded: a host whose pid and lock pid are
both dead is replaced by claiming `<gen + 1>` with an exclusive `link`, so
racing attaches start at most one host, and a claim made from a stale reading
(a taken or superseded generation) exits 3 without touching the live record.
A socket is unlinked only once nothing answers on it. `attachParentHost` is
attach-first: a responsive host is joined; a live parent lock with no matching
responsive host refuses; a live but silent host is never replaced. `stop`
replies with the parent's observed exit, then the host removes its socket and
exits, leaving its dead-pid record for the next generation to supersede; a
client disconnect stops nothing, and pending sends stay in the outbox. A host crash is an ordinary parent restart (same session, reconcile).
The `cp_parent` client attaches to the existing host before attempting a start; an ordinary operator `session_shutdown` disconnects only that client, leaving the parent, workers, pending sends and escalations owned by the host. Only `cp_parent stop` requests an observed shutdown and discards never-landed sends. Relays are deduplicated by structured send/escalation identity, never by send text; the durable outbox replays unobserved outcomes with the original send id and never reinjects a landed send.

The bridge exposes paths, not bodies: `state/runs/<id>/artifact.md`, the run
dir (gate files live there), and `evidence_paths`. The main session is the
tier allowed to read those bodies. The parent still must not. A remote seat
is ssh or tmux onto the main session; there is no remote protocol.

**Operator note** (`src/operator-note.ts`, autonomy-programme-cur.5.3). A
static, ≤60-line prompt appended to the main session's system prompt on every
`before_agent_start` turn, at a fixed position so the prefix stays cacheable.
It names the three tiers and who reads what, the lifecycle rules above,
the mandate template (name a project, or the several projects one topic spans,
and an objective, never ask for caps,
expiry or actions \u2014 they resolve through `src/mandate-defaults.ts`'s ladder \u2014
and echo the effective grant, fields and sources, in one line once issued),
one mandate per topic (a topic spanning repos is one mandate naming each
project; never a bucket for unrelated work, so cost, expiry,
revoke and mission-end summary stay per topic), the ask/decide split, and the plan-review
procedure. The ask/decide split is one tier up from AGENTS.md §Escalation's
own list: `operatorAction(kind, inScope)` in `src/operator-note.ts` says
`plan_approval` is a decide only when the mandate already covers it, every
other escalation kind is always an ask. `evals/operator-decide-vs-ask.json`
pins that mapping over at least four kinds, scored for free — a live-model
claim about what the main LLM actually does with the note is not made here,
same convention as the worker and parent-routing evals. The on-demand skill
(`skills/cp-operator/`) stays unwritten until the note proves insufficient
somewhere (ticket scope, not a gap).

### Reconcile

The parent runs `FleetStore.reconcile()` at `session_start`, before it forms any
belief about the fleet. Reconcile is a *truth pass*, not a recovery ladder: it
settles what the evidence settles and reports the rest. It never creates state
(a home with no `fleet.json` produces an empty report) and never kills anything.

Evidence, in precedence order: a recorded `worker.exited_at`, then the previous
parent's `status.json` (an `exited` projection **is** an observed close, just not
observed by us), then a pid probe. An observed close outranks a live pid,
because pids are reused and observations are not.

| outcome | evidence | effect on the record |
|---|---|---|
| `terminal` | phase is already `done`/`failed` | none — history is not re-litigated |
| `live` | pid alive **and** this process owns the worker (a reload, not a restart) | none |
| `orphan` | pid alive, nobody here owns it | none — reported to the operator; unreachable (its stdio died with the old parent), so teardown is a deliberate act, never a startup side effect |
| `revivable` | dead worker, phase `held` **or** `waiting` (cp-8km), session file present | none — the run survives on disk and `cp_revive` (or `/cp-revive`) can relaunch it (`--session <file>`) |
| `reported` | dead worker, no `reported_at`, but a valid `envelope.json` on disk | none — the work landed; envelope intake (T16) owns the phase change, and the id is listed in `needs_intake` |
| `failed` | dead worker with nothing to salvage | `phase: failed` + a `failure` |

`needs_intake` is **not** the `reported` outcome's list (pi-command-post-3ip). It
is keyed on the delivery, never on the worker: every non-terminal record with no
`reported_at` and an `envelope.json` on disk is listed, whether its worker is
dead, orphaned or still alive. A `failed` or `done` job is never listed — a
refused envelope was already fail-closed with a cause, and re-intaking it would
relitigate that decision.

And the list is **acted on**, by `CommandPost.reconcile()`: it runs the fleet
pass and then calls the ordinary `EnvelopeIntake.intake` once per listed job.
Same contract re-check, same generation scoping, same `onReported` wake-up, same
stat-and-move for artifacts — a restart is not a second intake path, it is the
same one, reached from a startup instead of from a worker's event stream.
Idempotent by construction (a stamped generation returns `already` and writes
nothing), and fail-closed: an invalid envelope is marked `envelope_invalid` with
its violation, and an intake that throws is returned as a `failure` on that job
while the rest of the pass continues.

This is the fix for a job that could not be finished by any surface: a worker
filed its envelope, the parent restarted (which kills every child), and nothing
ever stamped it — intake ran only from a live worker's stream. The settle
boundary then correctly refused to nudge a job that had reported and the
worker-reporter correctly refused a second envelope, so every gate was right and
the job stayed `waiting` forever.

Failure classification on `failed` prefers the class the previous parent already
recorded in `status.json` (e.g. `budget_exceeded`); only in its absence is it
`crash`, and the message names the evidence ("pid no longer exists" vs "close
observed at …"). `worker.exited_at` is stamped **only** from an observed close;
a pid that merely stopped existing yields no exit time and no exit code.

Resumability is derived, never stored: `isResumable(record)` = the failure class
is recoverable (`FAILURE_RECOVERABLE`) **and** the session file still exists.

Store mechanics: `read()` returns an empty fleet for a missing file, but refuses
corrupt JSON and any `schema_version` newer than this build. Every write is one
read-modify-write inside pi's per-path mutation queue, validated with
`validateFleetFile` before `write tmp → fsync → rename`; a mutation that would
produce an invalid fleet throws and leaves the file byte-identical.

A `revivable` job never moves phase (it stays `held` or `waiting`), so a caller
that only checks `ReconcileReport.changed` misses it; `report.revivable` is the
explicit list, and the `session_start` summary is never suppressed when it is
non-empty even if nothing else changed.

## Revival (`cp_revive`)

Revival is **relaunch, never reattach**: pi's transport has no detach/reattach
primitive (`WorkerProcess.spawn` owns anonymous pipes in this process's fd
table), so the only reachable mechanism is a fresh `pi --mode rpc --session
<file>` bound to the job's own worktree, lease, model and profile.

**Why this is safe at the session layer**, from a hermetic spike (mock
provider, real `pi --mode rpc` child, real `SIGKILL`), reproducible outside
every repository this fleet touches:

- **No auto-continuation.** A resumed process does nothing until it is
  prompted — zero events, no re-run of the interrupted tool — for every
  interruption shape (a dangling tool call, a completed `toolResult` with no
  next turn, an unanswered user message). This is why revival sends nothing:
  the operator's own first message is the first turn, exactly as pi already
  behaves.
- **The synthetic tool result, and what it means.** A dangling tool call is
  repaired at request-assembly time — `transformMessages` in `pi-ai`, called by
  every provider adapter — with a synthetic `{isError: true, "No result
  provided"}` result, never written back to the session file, recomputed on
  every request. It is provider-agnostic and unconditional: the revived model
  is told that call **failed**, whether or not it actually completed. A worker
  killed mid-`git rebase --continue` is told the rebase produced nothing, in a
  worktree where it may have finished.
- **A dead worker's tool child can outlive it.** A tool subprocess runs in its
  own process group, not pi's; killing the parent does not take it with it. A
  revived worktree may still have a live process mutating it.
- **One writer per session file.** Two `pi --mode rpc` processes on the same
  session file both accept writes and the transcript forks silently — neither
  process's own stats reveal the other branch exists. This is why a pid that is
  still alive is refused outright, re-probed at revive time rather than trusted
  from a startup classification: pids are reused and a `session_start`
  classification can be minutes stale by the time an operator acts on it.
- **`--model` on resume silently overrides the session's model**, and a
  mismatch drops or flattens restored thinking blocks (`isSameModel` in
  `transformMessages`). Revival always passes the recorded model, profile and
  thinking level explicitly — never lets a resumed process default to whatever
  `--model` says.

**What the session spike does not cover: the repository.** A ship job killed
mid-rebase leaves `.git/rebase-merge` (or a merge/cherry-pick in progress, or a
detached HEAD) behind, and resuming the session does not touch the worktree.
So before a plan is offered, `Reviver.plan()` inspects the worktree itself
(`git rev-parse --git-dir` resolves the real git dir even through a linked
worktree's `.git` file):

| worktree state | effect |
|---|---|
| a rebase, merge or cherry-pick in progress | refused (`repo_operation_in_progress`) — resuming a conversation that says nothing about it is the exact hazard this exists to name |
| detached HEAD | refused (`repo_detached_head`) — the job branch is not even checked out |
| uncommitted changes | **not refused** — the ordinary shape of a ship job mid-work; surfaced as `worktreeDirty` on the plan and the revive result instead, so the operator sees it without every real revival being blocked by it |

**The refusal ladder** (`Reviver.plan`, re-checked at revive time, never trusted
from a startup classification): no fleet record; phase is neither `held` nor
`waiting`; the session file is gone; a `WorkerManager` entry already exists for
the job; the pid is alive; the worktree is gone; the worktree has an
in-progress git operation or a detached HEAD. Every refusal is a `{ok: false,
code, message}` value, never a thrown error, so `cp_revive` can show it to the
operator instead of crashing.

**Constraint 9, mechanically:** before `cp_revive` spawns anything it shows the
interrupted tool call (name and arguments, read from the session file's last
entry — best-effort, never a hard requirement) and the model the revived worker
will be told that call failed. `cp_revive` without `confirm: true` only returns
the plan or refusal; nothing spawns until a second call sets it. `/cp-revive
<job-id>` is the human path: it plans, shows the plan, and asks before reviving.

**Crash-during-revival** is symmetric with `Dispatcher#dispatch`'s own
catch: the `WorkerManager` entry is created before any fleet write, and a
failed fleet patch after a successful spawn shuts the just-spawned worker back
down rather than leave a live process the fleet does not know about.

**What revival never does:** send a brief (Constraint 6 — the process lands
idle, which is what a resumed session does anyway); change the model, profile
or thinking level from what was recorded at dispatch (Constraint 10); rewrite
`session_id` or `session_file` on the fleet record (only `pid` and
`started_at` move); happen without an explicit operator action (Constraint 1).

**Continuing a failed job (`continue_failed`, pi-command-post-epic-pr-c-zh7.5).**
A `phase: failed` non-script job is continued on its **original** session,
worktree and lease, never through a takeover job, a new branch or a force push:
`cp_revive <id> continue_failed:true` (or `/cp-revive <id> --continue-failed`)
plans first, then confirms. Without the option a failed job is refused with a
message that points at it, and `cp_send` to a failed job points at it too. It
uses the same refusal ladder (script job, missing session, live worker or pid,
missing worktree, in-progress git op, detached HEAD), plus one more:
`envelope_unresolved`. That refusal fires when an envelope intake never accepted, or the
worker's `envelope-rejected.json`, is still on disk. A continued worker could not
report through either one, and nothing gets moved on the operator's behalf. The plan and the result
show the failure being continued and the interrupted tool call. On success,
`failure` is cleared and the phase is set back to `waiting`, in one
`FleetStore.mutate`, only after the spawn is recorded. A spawn that throws
leaves the failure and lease untouched. `cp:worker_revived` records
`continuation: "operator"` and `prior_failure`, which separates it from
bounded recovery's `continuation: "bounded_recovery"`. The automatic attempt
counter (`recovery-attempts.json`) is never reset. The worker lands idle. The
operator's `cp_send` is its first turn, and when the job had an accepted
envelope, that send supersedes it (`src/supersede.ts`), so the next report is
the next generation and the old one is never overwritten.

`cp_revive` is in `WORKER_FORBIDDEN_TOOLS`: a worker reviving a sibling job's
dead process is a recursion this fleet does not offer, ever.

## Run artifacts: events and status projection

Every line of `events.jsonl` is a `RunEvent`:

```json
{"seq":12,"ts":"2026-08-27T12:00:03Z","job_id":"cp-x","source":"pi","type":"tool_execution_start","payload":{...}}
```

- `source: "pi"` — the verbatim RPC event (`type` copied from it). Streaming
  `message_update` deltas are the one exception: they are **not** logged (they
  are token-granular and reconstructible from `message_end`), but they still
  advance `last_activity_at` and in-flight usage in the projection. A
  projection rebuilt from the log therefore equals the live one, `event_count`
  included.
- `source: "cp"` — a manager marker: `spawned`, `prompt_sent`, `steer_sent`,
  `follow_up_sent`, `envelope_received`, `envelope_superseded`,
  `envelope_rejected`, `budget_warning`, `budget_exceeded`, `budget_clamped`,
  `deps_prepared`, `failure`, `shutdown_requested`, `process_exit`.

`seq` is monotonic per run and is the ordering key (timestamps have second
precision and can tie).

`status.json` is the projection and the **only** read surface for run state.
Run phase is liveness, not policy:

| run phase | derived from |
|---|---|
| `starting` | `cp:spawned`, no `agent_start` yet |
| `working` | `agent_start` seen, no `agent_settled` since |
| `idle` | `agent_settled` seen, process still alive |
| `exited` | observed child close (`cp:process_exit`) — requires `exited_at` |

**Events that arrive after the close never un-exit a run (cp-0wq7).** A child's
stdout can still deliver a `turn_start`, an `agent_start` or a `message_start`
after its `close` was observed, and those events used to move the projection
back to `working` while `exited_at` stood — the one combination
`validateRunStatus` refuses. The projection then could not be written, so
`RunRecorder.open` threw, and `cp_revive` and `cp_teardown --force` both
refused the job with "run status projection is invalid": a job that could be
neither relaunched nor closed. Post-exit pi events are still logged and still
advance `event_count`, `last_activity_at`, `turns` and usage, but they cannot
set the phase, the settle mark or a current tool. Only a **new attempt** reopens
liveness: `cp:spawned`, or `cp:worker_revived` for a relaunch on the same
session file (which clears `exited_at`/`exit_code`/`settled_at` exactly as a
fresh spawn does, and which `Reviver` therefore writes **before** it tees the
new process). `exited_at` set implies phase `exited` is enforced as an
invariant at the end of the reducer, so no event type — including one added
later — can produce a projection that cannot be written.

Other projected fields: `turns` (`turn_end` count), `tool_calls`
(`tool_execution_start` count), `current_tool` (set on start, cleared on end),
`last_activity_at`, `reported` (`cp:envelope_received`, cleared again by
`cp:envelope_superseded` — a re-briefed run owes a report again), `failure`
(`cp:failure`).

**`cp:wakeup_suppressed` is the one event that never advances
`last_activity_at` (pi-command-post-long-idle-sessions-8sz).** It is not this
run doing anything — it records a message the *parent* declined to send — and
the re-check runs once per parent session, so a job that closed days ago keeps
collecting markers for wake-ups nobody will ever deliver. Counting them as
activity made two ordinary jobs read as 14–17h sessions in `/status` and
`/watch`: `cp-o77y` merged and was torn down at `12:44:37Z` (lease returned,
`fleet_done`, `br_closed` — nothing was held for a sweep) yet carried
`last_activity_at: 2026-09-06T15:31:54Z`, three hours of pure bookkeeping. The
marker is still logged and still advances `event_count`; the log is the
history. Age was never evidence of staleness, and it is not evidence of
liveness either.

`usage` is accumulated in two parts so a partially streamed turn is neither
double counted nor invisible: completed assistant `message_end` usages are
summed, and the in-flight message's cumulative `message_update` usage is added
on top until its `message_end` replaces it.

Writing discipline: `events.jsonl` is appended and `status.json` atomically
replaced on every logged event; the projection is validated before it is
written, so an invalid projection is a crash, not a file. Reopening a run dir
rebuilds from the existing log and continues the `seq` — it never truncates.

Relationship to fleet phases: run phase describes the *process*, job phase
describes the *work*. A `held` job normally has an `idle` run; a `done` job has
an `exited` run. They are stored separately because a live process with no work
left is a real state we must not collapse.

## Worker profiles and briefs

`profiles/<name>.md` = YAML frontmatter (`ProfileFrontmatterSchema`) + markdown
body. The body becomes the worker's appended system prompt.

```yaml
---
name: planner
role: planner               # planner | implementer | gate-reviewer
tools: [read, bash, glob]   # allowlist passed to `pi --tools`
model: anthropic/claude-sonnet-5
thinking: medium
briefTemplate: brief-research
readOnly: true
budget: { tokens: 300000 }
---
```

Invariants:

- `tools` may never contain a parent-only tool (`WORKER_FORBIDDEN_TOOLS`:
  `cp_dispatch`, `cp_send`, `cp_teardown`, `cp_check`, `cp_gate`,
  `cp_artifact`). This is the **recursion guard**: a worker cannot dispatch.
- `planner` profiles are read-only by contract; `readOnly: false` on a
  planner is a validation error.
- `packages: [...]` is optional and overrides the role's default package
  activation (§Trust policy, *Availability is not activation*); `[]` means
  none, and a name this home has not installed resolves to nothing.
- Brief templates may only use the placeholders in `BRIEF_PLACEHOLDERS`
  (`job_id`, `branch`, `base`, `worktree`, `task`, `artifact_path`,
  `original_task`, `project`, `kind`, `delivery`, `lens`), written as
  `${name}`. (`lens` is T22's addition:
  one voter template, one angle per voter. `base` is the preflight-resolved
  base branch of the job's clone, so a ship brief never hardcodes `main`.
  `original_task` is do8.3's: a **pointer and a boundary** for the gate
  reviewer, naming the frozen original task as a path — never its body, which
  is why it can carry a task the brief guard would refuse to inline.)
  Substitution fails
  closed in both directions: an unknown placeholder in a template is an error
  (typo protection), and a missing value is an error — a brief never renders
  an empty hole.
- Profiles live in `profiles/<name>.md` and the file name must equal the
  frontmatter `name`; exactly one profile per role. Brief templates live in
  `prompts/briefs/` and are deliberately **not** pi prompt templates: only
  top-level `prompts/*.md` are exposed as operator slash-commands, so a worker
  brief can never be injected into the parent session by accident.
- The gate reviewer needs no output-path placeholder: it *calls*
  `report_verdict`, and the worker-reporter writes the record into its run
  directory (`CP_RUN_DIR`). T20 amendment: the `verdict_path` placeholder
  described here before the `report_verdict` amendment never existed in
  `BRIEF_PLACEHOLDERS`, and the mechanism it described (reviewer reports a path
  in its envelope) was superseded — a reviewer has no envelope.

### Dispatch repo map

Every model dispatch appends a **Repo map** section, on by default for every
project. It indexes the committed tree at the newly created job branch's base
commit, not dirty or untracked worktree files: a depth-two tree excluding
`node_modules`, `state`, `data`, `projects` (at any depth), plus recursive `src/`
file line counts and approximate JS/TS exported names. Symlinks are not followed.
Export discovery uses declaration regexes, never an LSP or an extra dependency.

The section, including its heading and truncation note, is capped at 6 KiB
(UTF-8 bytes). Details are dropped from the largest directory groups first.
Maps are cached atomically at `state/repo-map/<project>/<commit>.md`; a repeat
dispatch at that commit reads the cache without rescanning source. Navigation
hints are separate from the frozen task and do not add acceptance criteria.
Failures produce an explicit unavailable note in the brief, never a partial cache.

To opt a project out, run `git config --local command-post.repoMap false` in
its canonical clone; linked leases share that config. Set it to `true` or unset
it to restore the default. Opt-out is checked before reading an existing cache.

## Trust policy

Workers are hostile-input processors: they run inside a clone we did not write,
reading files that can contain instructions. The policy is spawn-time and
mechanical (`WORKER_REQUIRED_FLAGS`):

| flag | why |
|---|---|
| `--mode rpc` | id-correlated delivery; receipts are facts |
| `--no-approve` | never load `.pi/` settings, extensions, skills or system prompts from the leased clone, regardless of `defaultProjectTrust` |
| `--no-extensions` | discovery off; the worker gets exactly the `-e worker-reporter` we pass |
| `--no-skills` | no ambient skills; the brief is the instruction set |
| `--tools <allowlist>` | from the profile; planners get no write/edit |

**Optional home packages (cp-5hui).** Discovery stays off, but two *user-level*
packages this home may have installed — `pi-caveman` and
`@dietrichgebert/ponytail` — are passed to a worker explicitly when they are
present: `-e <entry>` per declared extension and `--skill <dir>` per declared
skill directory (pi's `docs/skills.md`: `--skill <path>` is "repeatable,
additive even with `--no-skills`"; the manifest key shape `pi.extensions` /
`pi.skills` is pi's `docs/packages.md`, and both are pinned by
`tests/worker-packages.test.ts`).
`src/worker-packages.ts` detects them under `~/.pi/agent/npm/node_modules`,
reading each package's own `pi` manifest — no version and no absolute path is
hardcoded, each package is independent, and a missing, half-installed or
malformed one is silence: no flag, no warning, no failed spawn. Resolution
fails **open**: a manifest entry that is a directory is expanded to the entry
points pi documents for an extension directory (`*.ts`/`*.js` inside, plus
`<sub>/index.{ts,js}`), a glob or `!exclusion` entry is skipped because it is
not a path `-e` accepts, and anything not on disk is dropped — the worst case
is a worker spawned exactly as if the package were not installed. Detection
is a **startup snapshot**: it runs once at `CommandPost` construction, so a
package installed mid-session is picked up on the next parent restart. The required
and forbidden flags are unchanged, and nothing from the leased clone is
trusted.

At spawn, the profile allowlist is checked against builtins, the role's reporter,
and the tools of activated worker packages. Unresolved names remain on the
allowlist but are returned as `SpawnPlan.unresolvedTools` and warned through
`worker_packages_unresolved`, with package/profile repair and restart advice.
A package with only skills contributes no tools. This checks the resolved
package inventory, not successful execution of each extension in the child.
`/doctor` warns when profile mtimes are newer than the loaded worker-package
module: drain active workers, then restart the parent so disk profiles and
loaded code agree.

**Availability is not activation (cp-role-scoped-guidance).** Detection answers
*what this home has installed*; the **role** answers *what this worker loads*.
They were the same thing once, and that shipped caveman and ponytail into every
headless worker: prose compression fights a planner's complete plan and a
reviewer's evidence-bearing verdict, and a generic "delete it" minimalism lens
biases a review before the evidence does. So `ROLE_PACKAGES`
(`src/worker-packages.ts`) is the activation table:

| role | activates | why |
|---|---|---|
| `planner` | `pi-lens` (ast_grep only), `pi-web-access` | a plan is scored on completeness and evidence; compression loses the sections the rubric reads. Ponytail on a plan is a per-profile choice for a case where completeness and evidence explicitly win, never a default. `pi-web-access` gives research and Q&A workers (the `planner` and `qa` profiles) `web_search`, `fetch_content`, `get_search_content` and `source_check` (`PACKAGE_TOOLS`) on their `--tools` allowlist; its lazy loader `web_enable` is never allowlisted; every call passes the `webEgressRefusal` guard; an unavailable provider withholds the package (`withheld`); `/doctor` says which in its `web.search` line. The implementer and the gate-reviewer get no web tools by default |
| `gate-reviewer` | nothing | same for compression; a standing minimalism lens on every verdict has no measured evidence behind it here |
| `implementer` | `@dietrichgebert/ponytail`, `pi-lens` (trial), `pi-hashline-edit-pro` | minimal, root-cause, verified changes are the job. pi-lens loads only with `--no-read-guard` (`PACKAGE_FLAGS`): its read guard's one per-edit exemption is the `/lens-allow-edit` slash command, which no headless worker can type; `tests/pi-lens-headless.test.ts` proves the flag against the installed pi-lens |

**Web access (cp-if9x).** Availability is read from pi-web-access's own config
(`web-search.json`, located as the package does: `webSearchConfigPath`) and env
names only, never a network probe (`src/web-provider.ts`). No config, or
`auto`/`all`, reaches Exa's keyless public MCP, so it is available. A configured
keyed provider with neither its config key nor its env var set cannot search
(the package does not fall back), and a `web-search.json` that does not parse
refuses every search: both **withhold** the package at the startup snapshot, so
no worker gets its `-e` or tools and nothing warns at spawn. `openai`/`gemini`
with no key stay on but `/doctor` calls them unverified: pi auth, ADC or a
browser sign-in may still work (an `openai` provider with a non-`api.openai.com`
gateway baseUrl is refused by the package unless `openaiResponsesUrl` is set).
A key or config change takes effect after drain + parent restart. The worker
hook (`src/web-egress.ts`) refuses a web argument carrying `.pi-command-post`,
a `CP_HOME`/`CP_WORKTREE`/`CP_RUN_DIR`/`CP_ARTIFACT_PATH` value (≥ 8 chars), a
secret-named env value (≥ 12 chars) or a `SECRET_PATTERNS` shape, a proxy, a
`workflow` other than `none`, `fetch_content` answer mode, or a non-http(s) URL;
the reason names the rule, never the value. Accepted risk: it is a heuristic
floor, not a sandbox — base64 or paraphrase is not caught, `bash` egress is
pre-existing, and queries to the keyless Exa MCP leave the host. Web calls count
toward `tool_call_cap` and their results toward token caps like any tool. No
`cp-web` bash fetch CLI exists: it would be a second egress path outside the
allowlist, the guard and the package's SSRF protection; `fetch_content` covers it.

**No worker gets a `--skill` path (skillreads-vqy).** pi lists every loaded
skill with "use the read tool to load a skill's file", and some models then
read each `SKILL.md` at session start (34 gpt-6-sol jobs, about 11.6K tokens
and 3-6 turns each). An activated package contributes its extensions, flags,
tools and env, never its skill directories; ponytail's extension injects its
own mode, and the process rules the four superpowers skills carried
(`verification-before-completion`, `systematic-debugging`,
`test-driven-development`, `receiving-code-review`) are lines in
`profiles/implementer.md`. A skill an extension registers itself (pi-lens's
`resources_discover`) is that package's, outside this argv. **Never
activated**, by any role or profile (`NEVER_WORKER_RESOURCES`): `writing-plans`,
`brainstorming`, `requesting-code-review`, `rpiv-ask-user-question`,
`pi-goal-x`, `pi-subagents`; and `pi-caveman` never for a planner or a
reviewer (`ROLE_NEVER`).

Precedence, highest first: **profile** (`packages: [...]` in the frontmatter
replaces the role default outright; `packages: []` means none) → **role**
(`ROLE_PACKAGES`) → **availability** (an uninstalled or unknown name is
silence, exactly like a missing package). A **brief cannot change activation**:
resources are argv, fixed at spawn, and the brief arrives after it. What a
brief and a profile body *do* outrank is a loaded package's guidance — **the
role contract wins over any package's style or output-length advice**, so a
three-line envelope summary, a required test and a required check survive
ponytail (stated in `profiles/implementer.md`, so it reaches the model that
loads it). `tests/worker-packages.test.ts` asserts the launch argv of every
profile in `profiles/`: each gets only its configured resources, `--no-extensions`
and `--no-skills` stay on, and no artifact-producing role loads caveman.

**External skills do not reach a worker.** Workers run `--no-skills` and
receive no `--skill <path>`; a rule a worker needs is one line in its profile
or brief, not a skill file it is invited to read. The obra/superpowers suite
is not loaded, and `writing-plans` would conflict with the gate's own
implementation-plan rubric — two plan formats, one of which nothing scores.

Forbidden at spawn (`WORKER_FORBIDDEN_FLAGS`): `--approve`/`-a` (would trust
foreign project config) and `--continue`/`-c` (would resume an unrelated
session). Reviving a held worker uses `--session <file>`, which is explicit.

**Worker dialogs are auto-cancelled** (T3, `WorkerProcess`). There is no
operator behind a worker: any `extension_ui_request` dialog method (`select`,
`confirm`, `input`, `editor`) is answered `{cancelled: true}` immediately, so
the extension sees `undefined`/`false` and the worker must report a blocker
instead of hanging forever. Fire-and-forget UI methods (`notify`, `setStatus`,
…) are recorded as telemetry and otherwise ignored.

Accepted risk, documented rather than pretended away: **context files stay on**.
A worker doing a repo's work needs that repo's `AGENTS.md`. pi loads context
files regardless of trust, and prompt injection from repository content is
expected local-agent risk (pi `docs/security.md`). Our mitigations are the tool
allowlist, the lease boundary (one worktree), and the fact that a worker holds
no dispatch capability and no operator credentials beyond the model key.

Env hygiene (T7, `workerEnvironment`): the worker environment is the parent
environment **minus** the parent's session identity
(`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_MODEL`, `PI_PROVIDER`,
`PI_REASONING_LEVEL`) and **minus every inherited `CP_*` variable**, plus this
job's identity. Provider credentials are inherited on purpose — the worker
calls the model. A job that needs another credential gets it from the
environment, never from brief text: `assertBriefIsSafe` refuses a brief that
matches a private-key block, `sk-`/`sk-ant-`/`ghp_`/`AKIA`/`xox` token shape,
`Authorization: Bearer …`, or an inline `*_KEY|TOKEN|SECRET|PASSWORD=…`
assignment. The refusal names which pattern matched and the 1-indexed line it
matched on, never the matched text — a coordinate is enough to find and fix
the line without anyone reading the body back (cp-n7w).

**The guard only ever scans hand-typed brief text.** `cp_dispatch`'s
`taskFile` handover (§Pipeline's `taskFile` rule, below) substitutes a pointer
sentence naming the file's path into the brief, never the file's own content
— so an artifact that legitimately quotes credential-shaped environment facts
(measured `gh`/PAT output, a documented rate-limit header) can be handed to an
implementer through the sanctioned path without ever reaching
`assertBriefIsSafe`, and without the parent reading it either. A secret pasted
directly into a hand-written `task` (not `taskFile`) is unaffected and still
refused — the guard was never weakened, only scoped to text a human or a model
typed directly into the brief.

Other spawn-time policy, all fail-closed:

- `assertTrustPolicy(argv)` re-checks the final argv, so no refactor can
  quietly drop a trust flag — if the policy is not in the argv, nothing spawns.
- `untrustedResources(worktree)` records which project-local resources were
  found and deliberately refused; the list is kept on the spawn plan.
- `resolveWorkerTools(profile)` requires `report_result` (a worker that cannot
  report cannot finish) and refuses a `readOnly` profile that grants writers.
- `resolveJobBudget` takes the **stricter** of profile and fleet config: a
  profile can tighten a budget, never expand it.
- The spawn cap (`BudgetConfig.spawn_cap`, default 10) and one-worker-per-job
  are enforced by `WorkerManager.spawn`; a job that already has a live worker
  must be promoted, never given a second worker. Capacity frees on an observed
  close. The `gate-reviewer` profile role (review, gate and quality) may use
  three additional slots above the cap, so held authors cannot block their
  own reviews. Other roles cannot use this reserve; total live workers remain
  bounded by `spawn_cap + 3`. Refusals distinguish the ordinary cap from an
  exhausted review reserve. Held authors stay live for `cp_send` repairs;
  stopping them would require an explicit revive before promotion.
- `WorkerManager.shutdownAll()` is the `session_shutdown` cleanup: the parent
  never leaves orphaned children behind. From its first call `closing` is true:
  the failure monitor still runs intake but classifies no close as a death, the
  hard-bounds watch trips nothing, and `spawn` is refused as the backstop. A job
  the parent stopped stays `waiting` for the next parent's reconcile, with no
  failure, no spent recovery attempt and no death wake-up.
  Outside `--test-force-exit` (which `npm test` and CI pass), a test file that
  imports the harness and cannot exit 15s after its tests finish fails via
  `tests/harness/exit-watchdog.ts`, naming what holds it open.
  `npm test` also loads `scripts/test-file-guard.ts` as a second reporter: every
  file matching the suite's glob must report at least one test or a skip, and the
  run fails naming each discovered file that reported nothing.

## Gate verdict

Two schemas, deliberately separated:

- `GateReviewSchema` — what the reviewer worker reports through
  `report_verdict`, validated in-worker with bounded repair. Structured from
  the start, so the command-post prose parser (regex over `verdict:` /
  `flags:`) disappears — and a malformed verdict costs one extra turn while
  the artifact is still in context, instead of a whole new gate run.
  The reviewer runs with a **scratch cwd, never the worktree**: fresh context
  is mechanical, not aspirational, and its tools are exactly
  `[read, grep, report_verdict]` (`profiles/gate-reviewer.md`, `readOnly`). No
  `bash`, no `glob`: `grep` only says *where* in the files it was already
  given, which is what saves a second paging pass over a large `diff.md`
  (pi-command-post-reviewer-grep-utn), and the cwd holds nothing else to find.
  That cwd
  (`state/runs/<job-id>/gate-<n>/review/`) contains exactly one file, a copy of
  the artifact, and on a **`pass`** it is removed once the reviewer has been
  shut down (`removeGateScratch`, cp-yi73). A `revise` or an `escalate` keeps
  it: after a revise the store's artifact has moved on, and that copy is the
  only record of the bytes the attempt was judging. The removal is guarded to
  the point of paranoia — the path is built through `paths`, the job id must be
  id-shaped, the resolved path must be strictly inside `home` and its last
  segment must be `review` — it never touches `gate-<n>/` itself (`brief.md`,
  `events.jsonl`, the write-once `verdict.json`), it is logged as
  `gate_scratch_removed`, and it can never change a verdict: a removal that
  refuses or throws is recorded, never propagated.
- `GateVerdictSchema` — what the gate module decides *after* policy:
  `{job_id, attempt, verdict, cause, flags, reasons, revisions?, model, decided_at}`.

Policy applied between them (implemented in T20, constants here):

1. A **veto** flag true (`GATE_VETO_FLAGS`: `destructive_scope`,
   `scope_growth`) forces `escalate`. The cause depends on what the reviewer
   said underneath the flags (cp-n10): if the reviewer's own verdict was `pass`
   — the artifact is sound on every other criterion, and the flag is the *only*
   objection — the cause is `"flagged"`. Anything else the reviewer said (its
   own `escalate`, or a `revise`) means the plan itself is unresolved or
   disputed, and the cause is `"policy"`.
   **`blocking_unknowns` does not veto (cp-unknowns-no-veto).** It is reported
   — persisted in `flags`, with a `flag reported, no veto: …` line in
   `reasons` — and the reviewer's own verdict stands. The rubric defines it as
   an assumption nothing in the subject resolves, which a correctly decomposed
   ticket satisfies *by construction* (the rest is a sibling ticket's job), and
   because such a reviewer usually says `revise` rather than `pass`, the veto
   produced `escalate`/`policy`: unauthorizable, surfacing forever. Correct
   decomposition was therefore structurally unshippable (observed 2026-09-07 on
   cp-a2-prep-script-4zor, cp-b1-hub-scaffold-hbz7 and
   cp-amend-vm-tickets-691z). `scope_growth` keeps its veto **on the plan gate**: it is never true
   by construction, it takes an active reviewer assertion that the subject
   exceeded what was asked, and where that boundary sits is a human's call. DiffReview passes `vetoFlags: []`.
2. A `revise` when a prior revise exists becomes `escalate` with
   `cause: "policy"` (`GATE_MAX_REVISE = 1`) — always policy, never `flagged`:
   the plan was never judged sound in the first place.
3. A reviewer that dies, **settles without reporting**, never reports before
   the deadline, or exhausts its in-worker repairs (`verdict-rejected.json`) is
   `escalate` with `cause: "operational"`; if the immediately prior attempt was
   already `operational` (or `operational_persistent`), it is
   `operational_persistent`.
4. `cause` is `null` on `pass` and `revise`. **Branch on `cause`, never on
   reason prose.**

### The reviewer scores quality; the parent applies the flags

Rule 1 only works if a reviewer can actually return **`pass` with a flag true**:
that pair is the sole input that produces `cause: "flagged"`, the one escalate a
human may authorize. The shipped fixtures used to forbid exactly that — the
`gate-reviewer` profile and both rubrics said "escalate whenever any flag is
true" — so a compliant reviewer could never reach the authorizable path, and
every flagged plan surfaced as `policy` instead.

The fixtures ([`profiles/gate-reviewer.md`](../profiles/gate-reviewer.md),
[`prompts/briefs/gate-rubric.md`](../prompts/briefs/gate-rubric.md),
[`prompts/briefs/diff-review-rubric.md`](../prompts/briefs/diff-review-rubric.md))
now separate the two axes, and `tests/profiles.test.ts` holds them there:

- **Flags are observations, never verdict inputs.** The reviewer sets each flag
  from the subject and scores quality as if the flags did not exist.
- **`pass`** — no material, fixable quality gap. Still `pass` when flags are
  true, if the subject is sound.
- **`revise`** — a fixable quality gap. **A missing required section is normally
  `revise`**, not an escalate: it is the most fixable gap there is.
- **`escalate`** — unreadable, fundamentally unscorable, or ambiguous in a way
  no revision instruction could resolve.
- **Attempt caps and flag escalation stay the parent's**, in `decideGate` — the
  reviewer never counts attempts and never converts a flag into a verdict.

Output is actionable or it is not written: no praise, no style nits, no
speculation; every gate reason names its criterion and the evidence. A diff
review finding carries **severity, confidence, `path:line`, trigger, impact and
the required change** in one line, inside the existing string-array schema
(`reasons`/`revisions`, `maxLength: 400`) — no schema change was needed.

### The rubric is the implementation-plan rubric

The reviewer is handed one prompt, [`prompts/briefs/gate-rubric.md`](../prompts/briefs/gate-rubric.md), and it scores **one kind of thing**: an implementation plan. Its criteria (file list, test plan, approach, acceptance, implementation order, unknowns, scope, constraints, evidence) and its required sections are plan criteria, and its `pass` is defined as "an implementer could execute this artifact as written".

The required sections are one list, `RESEARCH_ARTIFACT_SECTIONS` in [`src/contracts.ts`](../src/contracts.ts), and the three prompts that state them ([`brief-research.md`](../prompts/briefs/brief-research.md), the rubric, [`quality-completeness.md`](../prompts/briefs/quality-completeness.md)) are held to it by test: **Goal; Acceptance; Non-goals; Evidence; Approach; File list; Implementation order; Constraints; Test plan; Unknowns/Blockers; Self-assessment**. A section is delivered only when something is written under its heading — an empty `Test plan` is a missing test plan — which is what `missingArtifactSections()` checks, and why "executable verification" is a mechanical property rather than a matter of taste. That function has **no production caller** and is not meant to acquire one here: the prompts state the list to the workers, and [`tests/planner-artifact.test.ts`](../tests/planner-artifact.test.ts) is what holds prompts and checker to the same list. The parent could not call it in any case — it never reads an artifact body. Its matching is first-word-only — the whole first word, so `File changes` satisfies `File list` while `Testing environment` does not satisfy `Test plan`, and the accepted cost is that an unrelated `Test rig` would: the check is a floor for a machine, and the gate reviewer is what judges whether a section is real. Fenced code is content, never structure, so a `# npm test` comment inside a block does not open a section. Self-assessment booleans are `true`/`false` in the artifact, matching the `report_result` schema (they used to be written as yes-or-no words, which no schema accepted).

Nothing in the rubric, the reviewer profile or `src/gate.ts` inspects what kind of artifact it was given. The rubric is applied to **any** artifact `cp_gate` is pointed at — a code review, a findings memo, a design note — exactly as written for a plan. So a verdict is a statement about **plan-readiness**, never about the artifact's quality on its own terms. "Test plan not runnable as written" or "file list covers 6 of 17 findings" can both be true of an excellent code review, because a code review is not a plan and was never trying to be one.

The flags read the same way. `destructive_scope` fires on a destructive operation the artifact *recommends* — data migrations, deletions, force-pushes, schema changes — not on one the artifact performs; an artifact that only proposes deletions still trips it. A **veto** flag true forces `escalate` — in the **parent's** decision (policy rule 1 above), never in the reviewer's verdict — so an artifact whose content merely mentions destructive work cannot pass the gate, whatever else the reviewer thought of it. What that escalate's `cause` is still depends on what the reviewer said underneath: a reviewer `pass` makes it `flagged` and authorizable. A true `blocking_unknowns` is reported and changes no verdict (rule 1).

Observed 2026-09-01 (cp-d2n): a 17-finding code review was gated and returned `escalate` / `policy` with `destructive_scope`, citing plan criteria. Every reason was correct about plan-readiness and misleading as a judgement about the review. Gate a non-plan artifact if you want plan-readiness scored; read the verdict as nothing more than that.

The verdict now says so itself (cp-950e). Every decision `decideGate` produces carries a constant `rubric` field (`GATE_RUBRIC_STATEMENT` in [`src/contracts.ts`](../src/contracts.ts)) naming the implementation-plan rubric, and `formatGate` renders it as a `rubric:` line under the headline, so a reader who never found this section still reads the verdict correctly. It is its own field rather than a reason on purpose: reasons are capped (`GATE_REASONS_MAX_ITEMS`, §cp-yg2), and a constant line spending that budget could drop a reviewer's own reason. The field is prose for a human — the parent still branches on `cause`, never on it. A diff review (`DiffVerdict`) drops the field, because it applies a different rubric.

### Running the gate

[`src/gate.ts`](../src/gate.ts) runs **one** attempt per call and returns the
decision plus a derived `next`, so the ported ladder is code rather than
operator memory:

| verdict / cause | `next` | meaning |
|---|---|---|
| `pass` | `proceed` | close the research job, then **checkpoint** (T21) |
| `revise` | `revise` | promoted to the still-live planner (same worker, same context) |
| `escalate` / `flagged` | `authorize` | reviewer-sound plan, escalated only by a veto flag (`destructive_scope`/`scope_growth`): close the research, then **checkpoint** (T21) with the flags and reasons carried into the evidence |
| `escalate` / `policy` | `surface` | a judgment about the artifact: tell the operator and stop — never authorizable |
| `escalate` / `operational` | `retry` | a tool fault: re-run the gate; the next attempt picks a **different** model |
| `escalate` / `operational_persistent` | `surface` | the reviewer model cannot meet the contract; stop looping |

`escalate` / `flagged` is the one escalate shape the pipeline still runs
through `#authorize`: gate policy (above) decides it, `PipelineRunner.advance`
only reads `cause`, and evidence is still not authorization — the checkpoint it
writes starts `pending` like any other, and only `/cp-authorize` moves it.

Mechanics that matter:

- **Attempt state is on disk.** `readPriorAttempts` reads
  `state/runs/<id>/gate-<n>.json` in order, so the one-revise cap and the
  operational ladder survive a parent restart. command-post kept this in br
  comments and re-derived it with regexes; the files are the record now.
- **Per-attempt run directories.** Each reviewer gets
  `state/runs/<id>/gate-<n>/` as its `CP_RUN_DIR` (events, status, its
  write-once verdict) and `state/runs/<id>/gate-<n>/review/` as its **cwd**,
  containing two files and nothing else: a copy of the artifact, and (do8.3,
  below) a copy of the frozen original task. Fresh context is mechanical — no
  repository, no history, no worktree. The reviewer is registered in the worker
  manager under the slot key `<job-id>#gate-<n>`, so a job may hold a live
  planner and a reviewer at once without breaking one-worker-per-job.
- **One-shot.** The reviewer is shut down when the attempt ends, whatever the
  outcome; `agent_settled` without a verdict is terminal, because a settled
  reviewer will never report without another prompt and the gate does not send
  one.
- **The in-run repair is already spent.** The reviewer repairs its own verdict
  in-run (bounded, artifact still in context), so a parent-side retry adds one
  more attempt on the same model — worth it for a transient fault, and capped:
  the second operational fault is `operational_persistent` and surfaces. To
  review on a different model, route the role elsewhere or pass an override
  (cp-eff removed the rung; the ordered `fallbacks` of pi-command-post-0a9 are
  resolution-time and never a retry).
- **Revise is a promote, never a re-dispatch.** The gate sends the revisions to
  the live planner through `cp_send`; if there is no live worker, that is
  reported (`revise_error`), never silently turned into a new research run.
- **The revise text asks for an edit; a reply is enough.** `reviseMessage`
  tells the planner to rewrite the artifact in place and answer in its
  **reply**: the artifact is the deliverable and the gate re-reads it from disk,
  so a second envelope buys nothing. What the message must not do is *promise a
  refusal*: delivering the revise is a promote, and a promote reopens the
  envelope slot (see [Envelope supersession](#envelope-supersession)),
  so a re-report **is** accepted. T29 amendment, found live: the message once
  ended "then call `report_result` again" when the contract refused it, and the
  cost was a paid revise round trip that left the artifact untouched. The fix
  for that was accurate wording, not a second lie in the other direction.
  Because the slot reopens, the research job goes back to `waiting` while it
  revises; the planner's `self_assessment` still routes the implementer, read
  from the archived generation through `lastFiledEnvelopeFile`.
- **The word cap and the item cap both hold, together.** Reasons and
  revisions are trimmed to `GATE_VERDICT_WORD_CAP` (300 words) **and** to
  `GATE_REASONS_MAX_ITEMS` (10 items, the same bound `GateReviewSchema` and
  `GateVerdictSchema` enforce on the wire), by dropping whole items and saying
  how many were dropped. T20 amendment: command-post truncated the last item
  mid-sentence; a half-quoted reason is worse than an honest count.
- **A capped verdict is never the only copy (cp-yg2).** `decideGate` composes
  the reviewer's own reasons with its own policy notes (`flag forced
  escalate: ...`, the one-revise attempt-cap note) — so an observation that
  arrived at the wire cap could still overflow it once policy added its own
  lines on top, and the word cap alone did not catch that: a dozen short
  reasons fit easily under 300 words while still being one item over the
  10-item cap. That overflow used to reach `validate()` only at the moment of
  persistence, in `Gate.gate()`, and `GateError` was thrown *before*
  `atomicWriteJson` — discarding a completed review outright instead of
  degrading it. `capPayload` now enforces both caps and, whenever it drops
  anything, hands back the pre-cap arrays; `Gate.gate()` persists those
  unabridged to `state/runs/<id>/gate-<n>-raw.json` next to the capped
  `gate-<n>.json`, so a truncated verdict is always recoverable in full from
  the run directory, and gating never again fails outright because a
  reviewer's real output was unrepresentable.

Verdict payload stays under `GATE_VERDICT_WORD_CAP` (300 words) **and**
`GATE_REASONS_MAX_ITEMS` (10 items) so it can be relayed to the operator
verbatim.

Gate pass is quality, never authorization: shipping still needs the
`checkpoint` (T21).

### The reviewer sees the original task, not just the plan

A reviewer given the artifact alone can check that a plan is internally
consistent. It cannot check that the plan is a plan for **the task that was
asked**: an artifact that quietly drops one acceptance criterion, or narrows a
requirement to the part the planner found tractable, reads as flawless, because
the only statement of the task it contains is the planner's own restated `Goal`.
Scoring coverage against that `Goal` is scoring the plan against itself.

So the parent freezes the task and hands it to the reviewer as a second file:

At dispatch, `src/task-references.ts` appends the same **Referenced material**
section to the worker brief and frozen task: a `br show` external reference
(including its pinned database), beads named in the task using the ledger's
configured prefix (seeded from `CP_LEDGER_PREFIX`, with the stored prefix taking
precedence), and absolute file paths outside the leased
worktree and the home's `state/` (checked through symlinks). Bead snapshots carry
id, title, status and description verbatim; files carry their text. Lookups run
against the canonical clone, without a shell, with a five-second command timeout.
There are at most 10 unique references, 4 KiB per entry and 24 KiB total, with
explicit truncation notes. Missing/unreadable references and unavailable `br`
become named notes, not dispatch failures. Prefix matching never depends on `br`
availability: only IDs with the configured prefix become task-text candidates,
so ordinary hyphenated prose produces no lookup notes. Named lookup failures
share the same reference count and byte caps.
Credential-shaped referenced content is withheld with the existing safety guard's
explicit diagnostic rather than leaked into a brief. When the home has a beads
database, the section also names its path and `BEADS_DIR`, with a read-only usage
note. With neither references nor a home database there is no section.
The `taskFile` itself remains a pointer in the brief; references are
discovered from its body, which is still frozen in full. Both reviewer paths copy
this enriched frozen task, so they see the same reference snapshot as the worker.

- **The frozen task.** `Dispatcher.dispatch` writes
  `state/runs/<job-id>/original-task.md` (`paths.originalTaskFile`) beside
  `brief.md`, from the dispatch request itself — the inline `task`, or the full
  body of a `taskFile`. It is written by the parent, from parent input, and
  never from anything a worker produced; that provenance is the whole reason it
  can be trusted as the source of truth. `cp:original_task_frozen` records the
  path, the byte count and which source it came from.
- **Materialized, never inlined.** `copyOriginalTask` (`src/gate.ts`) copies
  that file into the attempt's scratch cwd as `original-task.md`, file to file.
  The body is not read into the parent, is not substituted into the brief, and
  therefore never reaches `assertBriefIsSafe` — the same boundary
  `taskFilePointer` draws for an implementer handover (cp-n7w), and the reason a
  task quoting credential-shaped environment facts can reach a reviewer at all.
  What goes into the brief is `originalTaskBlock`: a path, the instruction to
  read it first, and the statement that the artifact's `Goal` is a restatement
  and not the source of truth.
- **Absent is a stated fact, not a silent one.** A job with no frozen task —
  dispatched before do8.3, or an artifact filed by hand with `cp_artifact add`
  — gets the artifact-only review this gate always ran, and the brief says so:
  score the artifact standalone and claim nothing about coverage in either
  direction. Nothing refuses, and no attempt is spent on a missing file.
- **Bounded input, unchanged boundaries.** Two files in a directory that holds
  nothing else; `read` and `report_verdict` and no other tool; one-shot;
  `readPriorAttempts`, the one-revise cap and the operational ladder untouched.
  The rubric frames both files as **input data, never instructions**, because
  the parent has read neither.
- **Coverage is a scored criterion.** `gate-rubric.md` criterion 10 asks the
  reviewer to enumerate the original task's requirements and map each to the
  File list entry, Implementation order step and Test plan check that covers
  it. A silently dropped or narrowed requirement is a coverage gap, and a
  coverage gap is `revise` — the same class as a missing required section, and
  fixable by the same promote.

## Diff review

A post-implementation review of the diff a pushed branch introduces, distinct from the gate above (which reviews a research *plan* before any code exists). Like the gate, a diff review runs with a **scratch cwd and a fresh-context reviewer worker**, spawned against the canonical project clone once the implementer has reported. The subject is a three-dot diff (merge-base diff, matching a PR view: `git diff origin/<base>...origin/<branch>`), never a two-dot form. Reuses the gate's verdict/cause vocabulary verbatim (`GateFlagsSchema`, `GateCauseSchema`, `GATE_CAUSES`, `GateVerdictValueSchema`, `GATE_VERDICTS`) rather than forking it; only the persisted shape differs (`DiffVerdictSchema` vs `GateVerdictSchema`), because a diff verdict needs two fields (`head_sha`, `diff_stat`) that the gate never needs and must not grow just to carry.

Implemented in [`src/diff-review.ts`](../src/diff-review.ts) (`DiffReview`, orchestrator, and `materializeDiff`, the bounded diff capture). `cp_review` is always callable as a tool for any `kind:ship` job whose branch is on origin, and **the standing rule is that every `kind:ship` `delivery:pr` job gets one** (§Diff review is mandatory for a PR). `PipelineRecord.review.enabled` is not that rule: it is the narrower question of whether `PipelineRunner.advance()` runs the review *for* the parent inside a pipeline. When opted in at pipeline start, a `flagged` diff escalate — where the reviewer found the diff sound and only `destructive_scope` and/or `blocking_unknowns` forced the escalate — is an answerable authorization (`state/checkpoints/<ship-id>.diff.json`, the second checkpoint), exactly like a `flagged` gate escalate.

### Diff materialization

[`src/diff-review.ts`](../src/diff-review.ts)`#materializeDiff()` captures the unified diff from a canonical project clone, bounded in two dimensions, in this exact order:

1. **File count.** `git diff --name-status <range>` is captured first, always, in full. The count is compared against `DIFF_REVIEW_MAX_STAT_FILES` (300 files, a generous ceiling for one reviewer's prompt budget). Over the cap: no diff is written, no reviewer is spawned, and the orchestrator decides `escalate`/`policy` outright — a diff this wide has already broken the premise of "freeze scope".
2. **Byte budget.** Within the file cap: the full `--stat` block (never truncated, all line counts present) plus unified-diff hunks for as many files as fit within `DIFF_REVIEW_MAX_BYTES` (300,000 bytes), accumulated file-by-file in the order git reports them, never mid-hunk. Files that do not fit are listed in an explicit "Omitted" section by path — nothing is silently hidden.

**An omitted path is diagnostic evidence, never a scoreable partial subject.** When the review subject (`diff.md`) omits any hunk — over the byte budget, or a listed path whose hunk could not be attributed (git reads run with `core.quotePath=false`; a name git must still quote is omitted) — no reviewer is spawned: the orchestrator persists `escalate`/`policy` with `diff_stat.truncated: true`, and its reasons name the byte cap and each omitted path. The same unchanged head returns that decision again without spending an attempt. The fix is staging, not a bigger cap: code and tests in one PR, generated data in ordered follow-ups, each head reviewed in full. For a delta review only the delta subject's truncation stops the review; `full-diff.md` is supplemental prior context the previous complete verdict already covered, and it may be bounded. A historical verdict with `diff_stat.truncated: true` (written before this rule) is never passing evidence: it grants no patch-id equivalence, is no delta baseline, and satisfies neither `cp_integrate`, merge asks, pipeline replay, nor teardown — not even a `flagged` escalate with an approved diff checkpoint.

The rubric's `review_context` placeholder states whether the subject is full or delta. The diff body stays inside `src/diff-review.ts` and is written to a scratch file the reviewer cwd holds, never leaving the module as a result field or log entry — only a `DiffSubject` (paths and counts, never text) is returned. A first review sees the full three-dot branch diff. After the head changes, the primary subject is only `<prior-content-review-head>..origin/<branch>` — when that prior head is an ancestor of the branch; after a rebase it is not (its tree-diff would carry upstream changes), and the full three-dot subject is reviewed instead; likewise after the base was merged into the branch: the prior head must also share the branch's current fork point with `origin/<base>` (`git merge-base --all` equal as sets), and a malformed or unresolvable prior head is no baseline; pass/revise verdicts are content reviews, operational verdicts are not, and the latest equivalent head is preferred. A same-head operational retry therefore receives the full three-dot subject. The scratch directory also carries the prior content verdict and a bounded `full-diff.md`, which the rubric requires the reviewer to consult when the delta touches or may invalidate a prior finding. The current `original-task.md` is copied on every attempt, so a task replaced by `cp_send task`/`task_file` is the scope scored by the delta review.

Every real verdict records git's stable `patch-id` for the complete branch diff. Before spawning, `cp_review` compares it to prior passing verdicts. An identical patch records `review-equivalent-<new-head>.json`, carrying the prior head and attempt, and returns `proceed` without a model call or numbered attempt. This is intentionally stricter than "rebased with no GitHub conflicts": any CI-fix or conflict-resolution edit changes the patch ID and receives a review (a delta on top of the reviewed head, the full three-dot subject after a rebase). Merge asks, status, pipeline replay, and teardown read equivalence records as passing evidence for the new head, only when the pass they point at was over a complete subject.

### Running the diff review

[`src/diff-review.ts`](../src/diff-review.ts)`#review()` runs **one** attempt per call and returns a `DiffReviewResult` with the decision plus a derived `next`, reusing the gate's policy machinery:

| verdict / cause | `next` | meaning |
|---|---|---|
| `pass` | `proceed` | diff review passed; the pipeline reaches done (or continues, if there is a checkpoint already answered) |
| `revise` | `revise` | promoted to the live **implementer** (same worker, same worktree); fix commit + push, then **review again** (up to `REVIEW_MAX_ATTEMPTS` reviews per branch) |
| `escalate` / `flagged` | `authorize` | gate-only: DiffReview passes `vetoFlags: []`, so a raised flag is reported and the reviewer's verdict stands |
| `escalate` / `policy` | `surface` | a judgment about the diff: tell the operator, stop — never authorizable |
| `escalate` / `operational` | `retry` | a tool fault: `cp_review` again (next attempt picks a **different** model) |
| `escalate` / `operational_persistent` | `surface` | the reviewer model cannot meet the contract; stop looping |

**In-pipeline automation.** When `PipelineRecord.review` is absent or `enabled: false`, a pipeline that reaches done does not review the diff itself: the parent still owes the branch a `cp_review` by the rule below, out of band. When `enabled: true` and the implementer reports, `advance()` checks the diff; an opt-in without a diff reviewer wired into the runner (`PipelineRunner#review`) is a hold short of done, naming `cp_review` as the out-of-band mechanism.

### Diff review is mandatory for a PR (cp-dlw7)

**Every `kind:ship` `delivery:pr` job gets a `cp_review` on its PR branch.** Not opt-in per job, not "when the diff looks risky", not only inside a pipeline. The prior wording ("opt-in per job — never automatic, never a merge blocker") described `PipelineRecord.review.enabled`, an automation flag, but read as the whole policy — so ordinary ship PRs merged unreviewed, and "never a merge blocker" was quoted as a reason not to run the tool at all.

**Who runs it, and when.** The implementer opens the PR: `cp_review` is in `WORKER_FORBIDDEN_TOOLS` ([`src/contracts.ts`](../src/contracts.ts)), so a worker can never review anything, its own diff least of all. The parent runs `cp_review <job-id>` **after the implementer's envelope**, once the PR exists and `head_sha` is on origin — that is the first moment the subject (a three-dot diff against the pushed head) exists at all. Workers are not changed to delay `gh pr create`: opening the PR is delivery, and reviewing it is the parent's next step, not a race with it.

**The unit is the branch patch, with a verdict bound to each pushed head.** A head with a direct pass or a persisted patch-ID equivalence pass is reviewed; nothing re-reviews an unchanged patch at any stage. Freshness is mechanical: direct and equivalence verdicts both name the current `head_sha`, while equivalence also names the prior passing head and attempt. Two consequences, and the second is not a second gate:

- **At envelope time** — the head has no verdict, so it gets one. On `revise` the head moves, and the new head is a different diff that needs its own pass; that loop is below.
- **Before `cp_integrate`** — a **catch-up, conditional on there being nothing to catch up on being false**: review only when the branch's current head still has no passing verdict (a PR opened before this rule, or a parent that skipped the envelope-time call). When a pass for that head already exists — the happy path, always — the parent runs nothing. Re-reviewing an unchanged head duplicates the review on every ordinary PR and spends the branch's five-review budget on a diff that did not move, so the catch-up is **conditional**, never a standing second pass.

**What is unchanged.** A review is evidence about the diff, **never authorization and never a merge action** — merge permission stays the repository's, per PR and per head sha (§Integration). CI remains authoritative for correctness, and nothing merges red. On `revise` the parent owns the loop (same implementer, same branch, re-run `cp_review` after the fix is pushed) until `proceed` or `surface`, capped at `REVIEW_MAX_ATTEMPTS` = 5 reviews per branch, unchanged.

**Out of scope.** `delivery:local` and `delivery:answer` produce no PR, so they get no `cp_review`. A head that already passed gets no second review. This rule **is hard-gated in `cp_integrate`**: before the merge step (both `repo_derived` and `human_checkpoint`), it reads the review store for the current pushed head and requires a `pass` on that sha or a recorded patch-equivalent, **or** an `escalate`/`flagged` verdict on that head with an approved diff checkpoint (`state/checkpoints/<job-id>.diff.json` — the same second authorization that clears teardown). Missing, `revise`, or a head that moved after the pass returns `next: review`, names the head, and mutates nothing. The reminder tells the parent to run `cp_review` on that head, or authorize the flagged escalate, never to re-review an unchanged one.

**The diff reviewer's own run directory.** Each attempt gets `state/runs/<job-id>/review-<n>/` as its `CP_RUN_DIR` (events, status, verdict, brief) and `state/runs/<job-id>/review-<n>/review/` as its **cwd**, containing the materialized diff and — when the job has one — the frozen original task beside it (do8.4, below), and nothing else. Fresh context is mechanical — no repository, no worktree history. The reviewer runs the same role as a gate reviewer (`gate-reviewer`), against the same `report_verdict` terminating tool, with a different brief (`DIFF_REVIEW_BRIEF_TEMPLATE`, `"diff-review-rubric"`).

**Attempt state is on disk.** `readPriorAttempts` reads `state/runs/<id>/review-<n>.json` in order, so the review cap and the operational ladder survive a parent restart. The same attempt bookkeeping as the gate, and the same reader — the budget it applies is passed in (`capExhausted`), which is the one place the two ladders differ.

### Review until clean, bounded at five

A plan gate's subject is a filed document: it is sound or it is not, and one revise settles it (`GATE_MAX_REVISE`, unchanged). A **diff** is not that. The implementer fixes what the reviewer named and pushes, and the new head is a *different subject* — so refusing to look again after a single revise ended the loop with the findings still unfixed and the operator holding a branch nobody had re-read.

So `cp_review` **keeps reviewing the same branch until a review comes back with no `[severity: high] [confidence: high]` finding**, bounded at `REVIEW_MAX_ATTEMPTS` = **5 reviews per branch** ([`src/contracts.ts`](../src/contracts.ts)). Mechanically:

- `pass` → `proceed`, at any review number. Unchanged: a pass is the end of the loop, and it is still evidence about the diff, never authorization to merge.
- a `revise` on review *n* < 5 → `revise`, delivered to the **live implementer** by promote (same worker, same branch, never a second PR, never a re-dispatch). The promote text names *n* of 5 and how many reviews remain.
- **review 5 is the last one, and it never asks for another revision.** `reviewCapExhausted` ([`src/gate.ts`](../src/gate.ts), beside `gateCapExhausted`) reports the budget spent on the attempt that *is* the cap, so `decideGate` turns that reviewer's `revise` into `escalate`/`policy` → **`surface`**, with `reviewCapReason` naming the cap in `reasons`. Nothing is promoted and nothing loops.
- a **6th** review is **refused before any diff is materialized**: `DiffReview.review` throws, naming the last verdict file and the operator's options (accept the diff, hand the branch back with a scope decision, or drop it). `PipelineRunner#reviewStep` holds `escalated`/`surface` for the same reason rather than calling the orchestrator.
- **One operator-approved final fix is the only exit from a complete capped review (pi-command-post-epic-pr-a-jje.3, [`src/final-fix.ts`](../src/final-fix.ts)).** When review 5 read the whole subject (a reviewer ran, nothing truncated) and its reviewer still said `revise`, `DiffReview` declares a `final_fix` checkpoint scoped to the capped head (`state/checkpoints/<id>.final-fix-<head12>.json`, Awaiting id `aw-checkpoint-<id>.final-fix-<head12>`) with the findings verbatim as evidence; the decision pane shows them against the current head. Only a human answers it — `cp_decide` with an operator quote, and `CheckpointStore.decide` refuses a final-fix approval without an operator-quote basis on every surface (`/cp-authorize` and the Awaiting dialog carry none) — and a mandate never can (`evaluateAuthority` refuses the kind; an answer without a quote is ignored). The checkpoint and the record are bound to the PR it names (`pr_url`), and a different PR never inherits it; a live head that moved from the capped head before promotion is refused. Approved, `cp_integrate` promotes the original implementer **once** with those findings and records the envelope generation the fix must report in (`state/runs/<id>/final-fix.json`, with the human basis and the capped head). That generation's report binds its pushed head, and only that exact head, in that generation, stands in for a passing review — in `cp_integrate`, the pipeline's opt-in review hold and the deferred merge-ask gate. A report that did not move the head, a later report or a push after the report voids it for good (recorded). It is risk acceptance, not a reviewer pass: red CI, GitHub's refusal and `--match-head-commit` still decide the merge, no sixth reviewer is ever spawned, and a pending, declined or truncated cap stays blocked (`surface`). The flagged `diff` authorization is unchanged and separate.

Every other cause is untouched by the cap: `flagged` still asks the second checkpoint, `operational` still retries the same decision (cp-eff removed the different-model rung), `operational_persistent` still surfaces — and each of those attempts spends one of the five, because the cap counts *reviews on the branch*, not revisions.

**The parent owns the loop.** Nothing re-reviews on its own outside a pipeline: after a revised envelope lands (or the implementer replies that the fix is pushed), the parent runs `cp_review <job-id>` again on the same branch, and keeps doing so until `proceed` or `surface`. `AGENTS.md` states that duty where the parent reads it. Inside a pipeline, `advance()` does it: a moved head makes the persisted verdict stale, so the next advance reviews the new head — the same loop, driven by the same cap.

**One-shot.** The reviewer is shut down when the attempt ends, whatever the outcome; `agent_settled` without a verdict is terminal.

**The in-run repair is already spent.** Same as gate: a parent-side retry adds one more attempt on the same model, and the second operational fault is `operational_persistent`.

**Revise is a promote to the live implementer, never a re-dispatch.** The diff review sends revisions to the implementer through `cp_send` (unlike gate revise, which goes to a planner); if the implementer is not alive, that is reported (`revise_error`), never silently ignored — and an undelivered revise becomes `surface`, because re-reviewing the same commit would only spend the cap. The revise message (`diffReviseMessage`) tells the implementer: "Fix this on the same branch with one more commit and push — never a second PR, never a new branch. Your envelope slot reopened when this promote was delivered, so if the fix changes what your envelope said you may report_result once more," and names which review this was of `REVIEW_MAX_ATTEMPTS` and how many remain before the findings go to the operator instead.

**A capped verdict is never the only copy (cp-yg2).** Same mechanism as gate: `capPayload` enforces both word cap and item cap, and when anything is dropped, the pre-cap arrays are persisted to `state/runs/<id>/review-<n>-raw.json` next to the capped `review-<n>.json`. A truncated verdict is always recoverable in full from the run directory.

**Verdict payload stays under `GATE_VERDICT_WORD_CAP` (300 words) and `GATE_REASONS_MAX_ITEMS` (10 items)** so it can be relayed to the operator verbatim.

### The diff reviewer sees the original task too

The plan gate's problem, one stage later. A reviewer given the diff alone can
say whether a change is internally sound; it cannot say whether it is the
change that was **asked for**. Before this, the only statement of scope in the
diff reviewer's packet was the job id and the branch name — the rubric said so
outright ("you have no plan to compare against here beyond what the job's own
job_id/branch imply") — so a diff that solved a different problem, or
implemented half of what was asked, scored as clean.

So the same frozen task the gate reads (`state/runs/<job-id>/original-task.md`,
written by `Dispatcher.dispatch` from the dispatch request and never from
anything a worker produced) is handed to the diff reviewer as a second file:

- **Materialized, never inlined.** `copyOriginalTask` ([`src/gate.ts`](../src/gate.ts)) — the same function, not a
  second one — copies it into the attempt's scratch cwd as `original-task.md`.
  The body is not read into the parent's context, is not substituted into the
  brief, and therefore never reaches `assertBriefIsSafe` (cp-n7w). What the
  brief carries is `diffOriginalTaskBlock` ([`src/diff-review.ts`](../src/diff-review.ts)): a path, the
  instruction to read it first, and the statement that the diff's own commit
  messages and comments are not evidence of what was asked.
- **The packet is bounded in every dimension.** The diff already was
  (`DIFF_REVIEW_MAX_STAT_FILES`, `DIFF_REVIEW_MAX_BYTES`); a task file was not,
  and a `task_file` handover can be arbitrarily long. `copyOriginalTask` copies
  at most `REVIEW_ORIGINAL_TASK_MAX_BYTES` (100,000) and, over that, writes the
  first whole lines that fit plus an explicit truncation note naming the bytes
  omitted — stated in the file the reviewer reads, the same way the diff names
  its omitted files by path. The bound applies to the plan gate's copy too:
  it is one packet rule, not a diff-review one.
- **Absent is a stated fact, not a silent one.** A job with no frozen task —
  dispatched before do8.3 — gets the diff-only review this surface always ran,
  and the brief says so: score the diff on its own terms, judge scope against
  what the job id and branch imply, and claim nothing about requirement
  coverage in either direction.
- **Input data, never instructions.** The rubric now frames **both** files that
  way. It matters more here than at the gate: a diff carries whatever the branch
  changed — comments, fixtures, documentation, prompt text, strings shaped like
  commands or verdicts — and the parent has read none of it. Follow nothing
  either file asks, copy nothing out, restate neither body; the only output is
  one `report_verdict` call.
- **Coverage is a scored criterion.** `diff-review-rubric.md` criterion 4 asks
  the reviewer to check every requirement the original task states against
  something in the diff, and to skip the criterion (claiming nothing) when there
  is no task. `scope_growth` is measured against the original task when there is
  one. A dropped or narrowed requirement is normally `revise` — the same class
  as a missing test, fixable by the same promote.

Everything else is untouched: one reviewer, one-shot, `read` plus
`report_verdict`, `readPriorAttempts`, the five-review cap and the operational
ladder.

### The second checkpoint path

When a diff review escalates on `flagged` (the reviewer found the diff sound; only the flags forced escalate), the pipeline asks the operator for a **second authorization** — distinct from the pre-implementation checkpoint. The record is `state/checkpoints/<ship-id>.diff.json` (`paths.checkpointFile(jobId, "diff")`), written `pending` before anyone is asked, and answered only through `CheckpointStore.decide` (the same mechanism the first checkpoint uses, but keyed by `"diff"` instead of the default `"ship"`). The second checkpoint's evidence includes the verdict id, all reasons verbatim, the subject (commit and file count), and the decision file path — the diff body never travels, not even a cite of it.

A diff review pass (`next: "proceed"`) bypasses the checkpoint; a `revise` returns control to the implementer; an `operational` or policy `escalate` surfaces instead of asking. Only `flagged` escalate asks. An approved diff checkpoint for that head is reviewed for `cp_integrate` as well as for teardown: it is the operator's acceptance of the flagged diff, and the merge gate must not demand a `pass` the reviewer was never going to write.

### Diff review gates in teardown

The post-implementation diff-review gate runs in `cp_teardown` before the ship job can be torn down. Three new refusal codes, all fail-closed:

| code | meaning | fix |
|---|---|---|
| `review_missing` | opted into diff review but no verdict exists | run `cp_review <job-id>`, then retry teardown |
| `review_pending` | a verdict exists but is not final for this HEAD (code changed, revisions asked, or reviewer faulted operationally) | re-review or land the revisions, then retry teardown |
| `review_escalated` | diff review escalated (cause: `policy`, `operational_persistent`, or `flagged` with no approved diff checkpoint) | authorize the diff checkpoint or fix the diff and re-review, then retry teardown |

The check asks four questions:

1. **Is there a verdict at all?** (refusal: `review_missing`)
2. **Is it fresh?** Does its `head_sha` match the current HEAD? (refusal: `review_pending` if not)
3. **What did it say?** 
   - `pass` → proceed (no refusal)
   - `revise` → the implementer has unmet revisions (refusal: `review_pending`)
   - `escalate` / `operational` → unfinished review, not a judgment (refusal: `review_pending`)
   - `escalate` / `flagged` + approved diff checkpoint → proceed
   - Anything else escalated → (refusal: `review_escalated`)

### Diff-review receipts

When a diff review escalates and the operator authorizes it (or when a review completes), a `receipt` is recorded on the `FleetRecord` with `kind: "review"` and `status` (`open`, `merged`, etc.), the same shape as `pr` receipts. The receipt tells an operator-facing surface "a diff review happened" and lets the second checkpoint's storage persist a durable link.

### The `diff_body_read` guard

The parent's no-bodies rule applies: `ContextGuard` blocks `read`/`grep`/`cat` on `state/runs/<job-id>/review-<n>/review/diff.md` in the parent context, the same as artifact reads. The only way to read a materialized diff is `cp_artifact get`-style — hand off the path and let the caller read outside the parent's session. A worker (the reviewer) reading the diff it was handed is the entire point.

## Project registry

`data/projects.json` (`ProjectRegistrySchema`) is the machine registry;
`data/projects.md` is a **rendered view** written on every mutation and never
read back. Implemented in [`src/projects.ts`](../src/projects.ts) (T10).

A record is `{name, clone_url, delivery, notes?, base_branch?, mandate?, archived?,
registered_at}`. Invariants, all enforced by `validateProjectRegistry` or at
registration:

- **One canonical clone per name.** The clone path is never stored: it is
  derived from the name alone (`paths.projectDir(name)`, under `LAYOUT.projects`),
  and a record carrying a `path` field is a validation error (cp-u3i2).
- **One canonical clone per remote.** Registering a `clone_url` that already
  belongs to another name is refused — a second name for one repo is how a
  fleet leases from the wrong checkout.
- **The name is three things at once**: the `projects/<name>` directory, the br
  `project:<name>` label and the fleet key. It therefore matches
  `PROJECT_NAME_PATTERN` = `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — T10 amendment:
  deliberately narrower than command-post's `^[A-Za-z0-9._-]+$`, because br
  labels reject dots.

`ensureClone(name)` is clone-on-demand: an existing clone is *verified*, a
missing one is cloned, and a directory whose `origin` is not the registered
remote is reported rather than adopted. Verification is the ported
`assertCanonicalClone`, and every check in it has cost somebody a dispatch into
the wrong tree:

1. the clone lives at `<home>/projects/<name>` (never `~/<name>`);
2. it is not a symlink to the operator's own checkout;
3. `git rev-parse --show-toplevel` is the clone itself (not nested in another repo);
4. `.git` is a directory (a `.git` *file* means a linked worktree);
5. `git-common-dir` is that `.git` — otherwise it **belongs to another repo**.

Recovery from a "belongs to another repo" finding stays an operator decision
(return the lease, fix the registration, re-lease); nothing is repaired
automatically.

### Registering one

`cp_project` is the operator surface: `list`, `add`, `show`. `add` is
`ensureProject` — register if absent, then clone on demand — so adding the same
project twice is a no-op that says `already present` rather than a second clone.

It exists because `cp_dispatch` resolves a `project:<name>` label through this
registry and refuses a name it does not know; before the tool, the only cure was
hand-editing `data/projects.json`, whose schema is strict on purpose. A worker
may **never** call it (`WORKER_FORBIDDEN_TOOLS`): choosing what to clone is
choosing your own scope.

`cp_project archive <name>` / `unarchive <name>` set `archived` (absent means
false; the clone, records and history are untouched). An archived project is
skipped by the periodic all-project pollers (`ProjectRegistry.activeNames()`, e.g.
the main-CI watch) but stays in `names()` for lookups, history and the viewer;
new jobs, mandates and dispatch into it refuse until it is unarchived.

## Dispatch (`cp_dispatch`)

[`src/dispatch.ts`](../src/dispatch.ts) (T14) is composition, not policy — the
policy lives in the modules it calls. The order is the contract:

```
ledger check (labels, not closed, not blocked)
  -> profile (kind -> role) -> routing decision      <- model probed HERE
  -> preflight (no worktree yet: clone, git, leftover branch, occupancy)
  -> lease -> branch = job id, cut from origin/<base>
  -> preflight again, on the leased worktree
  -> brief (pure) -> state/runs/<job-id>/brief.md
  -> spawn (trust policy) -> RPC prompt              <- receipt is a fact
  -> fleet record -> ledger claim
```

Two invariants are worth more than the code:

- **No orphans.** The model probe and the first preflight run *before* a lease
  exists (ported: "probe before lease, no orphan branch"). Anything that fails
  after the lease shuts the worker down and returns the lease, and the fleet
  never records a job whose worker did not start. The ledger claim is last:
  `in_progress` is only true once a worker exists.
- **The receipt is a fact.** `receipt: "accepted"` means pi answered the
  id-correlated `prompt`. command-post's `unconfirmed`/`unknown` receipts are
  gone with the paste broker.

Stdout parity with `cmdp dispatch` is kept: one JSON object
`{job_id, worker, worktree, branch, state, receipt}` (plus `model`, `profile`,
`routing`, `pid`, `session_id`). `state` is `dispatched` or `promote`; a
`promote` result carries the promote instruction and takes no lease.

### The route preview (`cp_dispatch dry_run`)

`dry_run: true` answers *which model and effort would this job get, and why*,
and is **an optional parameter on `cp_dispatch`, not a second subsystem**. It is
the same code path, stopped before the world is touched: the same task loading,
the same profile selection (`selectProfile`), the same input composition
(`composeRoutingInputs` → `resolveRoutingInputs`) and the same `resolveModel`
call against the same config and probe a dispatch one line later would use. The
result (`DispatchPreview`) carries the effective inputs and their per-axis
provenance, `source`/`rule`, `model`/`thinking`, the `source=/model=/rule=` line
itself, and what the probe knows about the model — with an **absent**
`supported_thinking` meaning "the probe cannot tell", never "nothing is
supported".

What it must never do is the other half of the contract, and it is structural
rather than remembered: the preview stops before the preflight, so it acquires
no lease, creates no branch, spawns no worker, writes no fleet record, run
directory, brief or routing event, claims nothing in the ledger and refreshes no
credentials. It returns no task-file or artifact **body** (source, byte count
and path only — the rule `cp_artifact` already follows) and no credential value.

**Every routing refusal is reported rather than thrown**, and so is an open
blocker — those are what a preview exists to show. `error` carries the
`RoutingError` verbatim for all three of its shapes (an unavailable model, a
model the allowlist rejects, an effort level the model cannot serve) and is
present exactly when `decision` is absent; `blockers[]` lists the ids dispatch
would refuse on. "It would be refused, for this reason" is an answer to *what
would this dispatch do*, not a failure of the question.

What still throws is everything that means the request cannot be **read** at
all: an unknown or closed job, a missing or empty task file, `task` and
`taskFile` together, an unlabelled issue, a missing profile. No route is
computed in those cases, and dispatch throws for them too.

**A preview reserves nothing and authorizes nothing.** Config is re-read per
call (`CommandPost.dispatcher()`), so a dispatch recomputes the whole decision
from the live policy: a config edited between the two is honoured by the
dispatch, never hidden behind what a preview said. Nothing in the parent's
workflow requires a preview first.

## Preflight (`cp_check`)

[`src/preflight.ts`](../src/preflight.ts) (T12) answers one question — *may
this job be dispatched here, right now?* — and never dispatches, leases or
writes state. Status is `ok`, `promote` or `fail`; every finding carries a
`code` (branch on the code, never on the prose) and a `fix`.

Checks, in order, all fail-closed:

1. **canonical clone** — delegated to the registry, plus `origin` matching the
   registration (`origin_mismatch`);
2. **git preflight** — `git fetch origin` (`fetch_failed`; ref-lock contention
   on the shared canonical clone is retried with a bounded backoff and only
   becomes a finding, `fetch_contention`, once retries are exhausted — it
   names contention, not a broken remote), `origin/<base>`
   exists (`base_missing`), primary checkout on the base branch
   (`primary_detached`, `primary_off_base`), and, when no worktree is named
   yet, no leftover `refs/heads/<job-id>` (`branch_exists`);
3. **target worktree** — a linked worktree of *this* clone (`worktree_missing`,
   `worktree_foreign`), not the primary checkout (`worktree_is_primary`), and
   clean before the worker starts (`worktree_dirty`);
4. **occupancy** — `decideOccupancy`, the ported promote-not-spawn rule.

A dirty **primary** checkout is a `warn`, not a `fail`: a job branch is cut
from `origin/<base>` into a leased worktree, so the operator's own tree cannot
endanger it. A dirty **target worktree** is a `fail`: a worker always starts
clean.

### promote-not-spawn

```
same repo AND the same worktree still held (phase waiting|held) AND the same model
  -> promote: cp_send <job-id> with the new brief; do not dispatch, do not lease
worktree returned, or an independent job (other repo / second worktree)
  -> new lease
```

Plus the invariant this build adds: **one worker per job**. A job that already
has a live worker is promoted, never given a second one, and a job never holds
two worktrees.

A cross-model role hop (planner → implementer) is **teardown + fresh
dispatch**, never a promote — refused here with that instruction. When no model
was resolved, occupancy refuses rather than assuming: "same model" cannot be
asserted about a model nobody named.

## Teardown (`cp_teardown`)

[`src/teardown.ts`](../src/teardown.ts) (T17). Teardown is the one place where
being wrong destroys work, so the failure mode is always **keep everything**:
the lease, the worker, the fleet record and the run stay exactly as they were,
and the refusal names the fix.

Kind-aware gates, ported from `cmdp teardown`. **Delivery does not appear here**
(see below):

| kind | gate | pass reasons |
|---|---|---|
| ship | clean porcelain, work on the job branch, **and** pushed; for failed/waiting non-script jobs, the current HEAD must also match an accepted current-generation ship/done report or an exact landed merge receipt | `pushed` (the branch **on origin** == HEAD), `upstream` (the branch its upstream names, on the remote, == HEAD), `merged` (a merge receipt for this head), `merged_head_deleted` |
| research | clean porcelain **and** no local commits past `origin/<base>` | `clean_research` |

### Where the work lives, and why delivery does not relax the gate

Measured against real treehouse, because the whole gate depends on it:

1. During a job the work is in the **leased worktree** on branch `<job-id>`. That
   worktree is a *linked* worktree of `projects/<name>` and shares its `.git`
   (objects and refs).
2. `treehouse return --force` does **not** delete the directory: it returns the
   slot to the pool, and the **next lease reuses that same path**, reset onto the
   base. Uncommitted work is gone, and the files there belong to the next job.
3. `refs/heads/<job-id>` **survives** in `projects/<name>`, and its commits are
   readable there afterwards.
4. Nothing merges into the clone's own base branch, ever. `projects/<name>`
   accumulates job branches, and preflight keeps its primary checkout on the
   base and clean so it stays a clean place to cut the next branch from.
5. Integration belongs to the delivery path: `pr` → the PR merges upstream (and
   the head is usually auto-deleted, which is what `merged_head_deleted`
   handles); `local` → the operator merges or cherry-picks when they choose.

So the gate asks **one** question of every ship job: *is this work durable
outside this lease?* And the answer is a push, because `projects/<name>` is a
gitignored, clone-on-demand **cache** the system may delete and re-clone. Work
that exists only there has been *parked*, not delivered.

**`delivery:local` therefore means "no PR, and the parent does not hold the
worker" — never "do not publish".** That is exactly what the ported operating
contract said it meant (command-post AGENTS.md: "teardown once relayed unless a
follow-up promote is needed"), and it matches the one other place delivery is
read: intake's `next` is `hold` for `pr` and `teardown` for everything else.
The ship brief says the same in the worker's own words, so a brief and a gate
can never disagree about it.

**`unreachable_work` (new in T29).** Because a returned slot is *reused*, a
commit that no branch points at is lost the moment the next job takes it. So
before asking about origin, the gate asks whether HEAD is the tip of
`refs/heads/<branch>`; a detached HEAD (or work committed onto another branch) is
refused with its own code and fix. The ported gate could only report the
misleading `unpushed` for that case.

**How this was found, and the correction.** T29's live scenario (a) refused
teardown with `unpushed`. The first diagnosis — that the gate was wrong for
`delivery:local` — was itself wrong: the real defect was that the *scenario's
task text* told the worker "do not push" while its brief said every ship job
pushes. A task that contradicts its brief makes the worker choose, and this one
chose the task. The gate is unchanged from the ported rule; what changed is the
detached-HEAD check, the brief spelling `local` out, and this section.

A pushed head alone is not a report: after a worker dies or waits without an
accepted current-generation ship/done envelope, `unreported_head` keeps the
lease until the reported HEAD matches or `cp_merged` records a receipt for
that exact head. The check runs after git/review gates and before shutdown;
script jobs are unchanged. `force` explicitly bypasses it and records
`closed_reason: "forced"`, with no verified pass reason.

**A live worker with no report is not finished work (issue #2).** Before any
other gate, `unreported_live_worker` refuses a non-script job in phase
`waiting`/`launching` with no `reported_at` whose worker is live — owned by the
manager and `alive`, or unowned with no `exited_at`, no observed close and a
live pid (the reconcile rule). The message says "mid-turn" when the worker is
busy or its status phase is `working`. `failed` jobs are excluded: their
failure was already announced and `unreported_head` covers failed ship jobs.
The pipeline's hung-planner hand-off is the one exemption: it passes
`acceptUnreported` with a reason, recorded on `shutdown_requested`, because it
runs only after a gate pass and an authorized plan. The model-facing
`cp_teardown` passes `requireAuthorization` with `force`: forcing past this
gate needs `operator_quote`, verified verbatim against the session's user
messages by `requireOperatorQuote` before anything runs. A force that ends such
a worker is `killed_unreported` — on `TeardownResult`, on the
`shutdown_requested` payload (with `authorized_by` and `operator_quote`), while
`closed_reason` stays `"forced"` — and journals one durable `recovery` wake-up
with id prefix `killed-unreported:` and no `keys` (a done job never stales it),
which the cp-bridge relays straight to the operator. Any teardown of a job with
no `reported_at` returns `unreported: true`, and `formatTeardown` says no report
was filed, so a pass reason such as `clean_research` never reads as a result.
`cp_job dep_remove` refuses to drop an open blocker whose worker never
reported; going on without it is `cp_job drop` and the operator's
dropped-dependency answer.

**An unowned live worker keeps its lease (cp-t9yr F1).** A non-script job whose
worker has no recorded exit, no observed close, a live pid, and no session here
that owns it is refused with `unmanaged_live_worker` before every other gate:
nothing here can observe that worker's close, and returning the lease would hand
its worktree to the next job while it can still write there. `force`,
`operator_quote` and the pipeline hand-off (`acceptUnreported`) do not skip it,
and neither does the plain gated path `cp_integrate` uses. `killed_unreported`
therefore only ever means an observed shutdown of a worker this session owns.
Recovery: confirm the pid is this job's worker, end it deliberately (or let it
exit), then re-run `cp_teardown`.

**The merged-head trap** (ported from
`reports/operating-knowledge.md`): when a PR is squash-merged and GitHub
auto-deletes the head branch, absence from origin reads exactly like "never
pushed". A **three-dot** diff still shows the branch's own changes after a
squash and would confirm the wrong conclusion. The mechanised check is:
the head branch is gone from `git ls-remote --heads origin <branch>` **and**
the **two-dot** tree diff `git diff HEAD <base sha>` is empty — the base
already holds this exact content. Both halves of that check ask **origin**: the
base sha comes from `git ls-remote --heads origin <base>` too (cp-p0r), never
from `refs/remotes/origin/<base>`.

### Landing is a PR fact, and "on origin" is a question for origin

Two real teardowns in one session, one false refusal and one false pass, from
the same root: the gate answered both questions from local git objects.

**The false refusal.** cp-kzc's PR was squash-merged and its head deleted;
teardown refused with "branch has no upstream, is not on origin, and origin/main
does not contain its content". Every clause was true and the conclusion was
wrong. Squash **and** rebase merges rewrite the commit, so the tree-diff check
above is only empty while the base has not moved on — in a repo that
squash-merges everything, it can recognise essentially no merged PR. Worse, the
refusal's own fix ("or confirm the PR merged") named **no mechanism**: nothing
let a caller confirm it, so the only exit was `force`, which records that
nothing was proven about a merge that was fully provable. That is a weaker claim
than the evidence supported, written into the audit trail.

The mechanism now exists: [`src/merges.ts`](../src/merges.ts) and the `cp_merged`
tool. When the parent merges, it records what `gh pr view` reports — state
`MERGED`, the merge commit oid, the head oid, the head branch — into
`state/runs/<job-id>/merge.json` (`MergeReceiptSchema`), and moves the job's `pr`
receipt from `open` to `merged` (the status `src/supersede.ts` already called
"set by whoever observes the merge", and which nothing set until now). A receipt
is an **observation**: the store refuses, and writes nothing, for a PR gh does
not call merged, a merged PR with no merge commit, a PR whose head branch is not
this job's branch, or a `gh` it cannot run at all.

The ship gate reads it: no branch on origin **and** a receipt whose `head_sha`
is this HEAD ⇒ pass reason `merged`, whatever the merge strategy was. A receipt
for a *different* head is a refusal, not a pass — commits made after the merge
are in no PR and on no remote, and the message names the sha that did land.

**The false pass.** Earlier the same session two jobs tore down reporting
`(pushed)` **after** their remote branches had been deleted, because their
worktrees still held `refs/remotes/origin/<branch>` equal to the local tip.
Worker worktrees are separate clones under `.treehouse/`, so remote-tracking
refs go stale independently, and the gate's verdict came down to whether anyone
happened to run `git fetch --prune`. So: **a remote-tracking ref is never
evidence a branch is on origin.** Every "is it on origin?" question — including
the one behind `upstream` — goes through `git ls-remote`, and the stale ref is
read only to *name* the condition in the refusal message. When origin cannot be
asked at all (no remote, no network), the gate refuses with `remote_unverified`
rather than falling back to the ref: not knowing is not the same as knowing.

**The base half of the fallback, missed until cp-p0r.** The merged-and-absorbed
check still resolved its *base* through `refs/remotes/origin/<base>`, which is
the same stale ref by another name — and this one gates a **pass**, so a
tracking ref that happens to match HEAD's tree would tear a job down as merged
when nothing merged. The base is now resolved with `ls-remote` (the same
`#remoteTip` used for the branch) and the diff runs against that **sha**. It
fails closed: origin unaskable, or no such branch on origin, ⇒ `false`, and the
gate falls through to its existing `unpushed` refusal. A sha origin names but
this clone does not have makes `git diff` exit non-zero, which is the same
`false`; no fetch is issued to repair it, because a false negative here is safe
and fetching is a side effect this gate does not own.

`force` is untouched by all of this. It is still operator authorization for the
genuinely unprovable case, it still claims no pass reason, and it is still
recorded as `closed_reason: "forced"`.

A research or `delivery:answer` job is closed in the ledger with a reason
derived from its filed envelope (`answered: <headline>`, `researched: <artifact
path>`, `gated: <verdict>`) only when the fleet record has `reported_at`, the
envelope is filed, and the ledger row is open/in_progress and not updated since
the fleet `closed_at` (a reopened row stays open). A close that fails returns
`ledger_close_error` on the teardown result, journals one `recovery` wake-up
with id prefix `ledger-close-failed:`, and is retried by a re-run `cp_teardown`
of the done job (`ledger_closed: true`; no lease or worker is touched) and once
per parent startup (`CommandPost.reconcile`). Ship jobs are unchanged:
`cp_integrate` still closes them. `cp_job close` remains the path for dropping
work.

Order: gates → **worker shutdown (observed close)** → lease return → fleet
`done` → ledger close for research/answer → optional artifact cleanup. T17 amendment to the ported order (lease
first): the worker's cwd *is* the worktree and `treehouse return` terminates
lingering processes inside it, so returning first would have treehouse kill our
child and turn an observed shutdown into a race.

`force` is operator authorization, not a shortcut: it exists so a job whose
worktree vanished can still be closed, it is recorded in the run log, and it
reports **no** pass reason — nothing was proven, so nothing is claimed. A
refused teardown is logged as `cp:teardown_refused`, which is deliberately not
a `failure`: nothing broke, the gate held.

**`closed_reason` (cp-8km)**, persisted on the `FleetRecord` itself, not only in
the run log (`events.jsonl` is read by no policy code): every teardown sets it,
`"gated"` when the gates above actually passed, `"forced"` when `force` skipped
them. The Shipped section of the status block (`renderShipped`) excludes a job
whose `closed_reason` is `"forced"` **and** whose `pr` receipt is still
`status: "open"` — nothing was proven about that job's state, so an unmerged PR
must never render as delivered. It is surfaced instead under an adjacent,
explicitly unverified heading. A normally torn-down `pr` job is unaffected: this
narrows Shipped by exactly the one unverified case, nothing more. Receipt
`status` reaches `"open"` at envelope-acceptance time (`src/intake.ts`) and
`"merged"` when `cp_merged` observes the merge (cp-vk1) — which is the check
cp-8km's research listed as unbuilt, and which is why a forced-but-merged job
no longer renders as unverified either.

### Post-implementation diff-review gates (from § Diff review)

When a pipeline opts into diff review (`PipelineRecord.review.enabled`), three additional gates run in `cp_teardown` before a ship job can be torn down, all fail-closed and named in code as `GATE_CODES` (`review_missing`, `review_pending`, `review_escalated`). See § Diff review for the full gate logic and what each refusal means; in short:

- **`review_missing`** — opted in but no verdict exists; run `cp_review <job-id>`.
- **`review_pending`** — verdict exists but code changed, revisions were asked, or reviewer faulted operationally; re-review or land revisions.
- **`review_escalated`** — diff review escalated on `policy`, `operational_persistent`, or `flagged` with no approved diff checkpoint; authorize the checkpoint or fix and re-review.

## Integration (`cp_integrate`, cp-uug)

[`src/integrate.ts`](../src/integrate.ts). Everything between "the PR is green"
and "the job is closed" — rebase, CI verification, merge, receipt, teardown,
head deletion, br close — as **one resumable step per call**, each with a
postcondition verified in code.

### Why a tool and not a role

Every step in that sequence is a git or `gh` fact. A model placed in the loop
cannot add evidence; it can only add a claim, and this home has two recorded
instances of exactly that (two of three ship envelopes claimed a rebase or a
report that never happened, PRs #42 and #44). Three further reasons an
integrator *worker* was rejected are structural, not stylistic:

- it could not wait for CI at all — `src/ci-wait.ts` refuses `gh run watch` by
  name for every worker, and that guard exists because prose already lost once;
- it would need `cp_teardown` and a br-close capability, both parent-only by
  `WORKER_FORBIDDEN_TOOLS`, so the recursion guard would have to be reopened;
- it would be a **second writer** to a branch whose implementer is still `held`
  and promotable.

And there is no fourth `Role`: `src/contracts.ts` says adding one is a contract
change, not a config, and nothing here needs one.

### The state machine

`advance` recomputes which step is due **from git, `gh`, and the review store**, never from the
stored step. That is what makes it resumable across a parent restart,
idempotent when called twice, and unable to re-merge anything on a stale
record. The record (`state/runs/<job-id>/integration.json`,
`IntegrationRecordSchema`) is continuity and two bounded counters, nothing more.

| step | precondition | action | postcondition |
|---|---|---|---|
| — | PR state `CLOSED` unmerged | none | `surface` |
| — | PR state `MERGED` | jump to `record` | not an error: the receipt is the observer either way |
| `conflict` | `mergeable == CONFLICTING` | promote the implementer | never resolved by this tool |
| `ci` | a *completed* run whose `headSha` is the pushed head | none | green, or `wait` / `resolve`; zero runs with an **unreadable** workflow list falls back to `authorize`, and with an authoritative empty one falls through to `permit` |
| `permit` | CI green on the pushed head | re-read `gh pr view`, evaluate `evaluateMergePermission` | `permitted` (merge), `pending` (merge-pending reminder, no merge), `retry` (head still resolving, or moved), or `unreadable` (fallback to `authorize`) |
| `fresh` | `permit` read `BEHIND`, or `BLOCKED` with a readable `strict_required_status_checks_policy: true` rule **and** `merge-base --is-ancestor origin/<base> origin/<branch>` exit 1 — a stale base alone, or unreadable ancestry, is never a rebase | `gh pr update-branch --rebase` | the head moved, so CI, `cp_review` **and** any authorization are void |
| `authorize` (fallback only) | `state/checkpoints/<job-id>.merge-<head>.json` is `approved` | request it `pending` if absent | fail closed otherwise |
| `review` | CI green (or no CI) on the pushed head, but no passing `cp_review` on that sha or a patch-equivalent, and no approved flagged-diff checkpoint for that head | none | `next: review`; nothing mutated |
| `merge` | `permit` said `permitted`, or the fallback `authorize` is `approved`, **and** a passing `cp_review` on this head (or an approved flagged-diff checkpoint) | `gh pr merge --squash --match-head-commit <head>`, **no `--admin`, no `--auto`, no `--delete-branch`** | `gh pr view` reports `MERGED` |
| `record` | merged | `MergeStore.record` (cp-vk1) | `merge.json` exists; `pr` receipt `merged` |
| `sync` | local HEAD ≠ remote tip, tree clean, **and** HEAD an ancestor of it *or* its content proven already in the base | `git fetch` + `reset --hard <the sha ls-remote reported>` | the teardown gate compares the *local* tip |
| `teardown` | receipt written | `Teardown.teardown` | pass reason `pushed` (or `merged`), lease returned |
| `delete_head` | torn down | `git push origin --delete <branch>` | `ls-remote` empty |
| `close` | torn down | `Ledger.close(job_id, reason)` | br issue closed with a reason |
| `prune_salvage` (part of `done`) | the merge is recorded and the base has moved | delete a `refs/cp-salvage/*` ref **only** when `merge-base --is-ancestor <ref sha> <ls-remote base tip>` succeeds | pruned and kept refs are both reported; never fails the integration |

Branch on `next` — `advance | wait | review | resolve | retry | surface | done` — never
on the prose reason, the same rule the gate's `cause` establishes.

### Durable integration holds (4r4)

`cp_integrate hold <job-id> reason` (tool arguments: `action: "hold"`,
`job_id`, `reason`) pauses that job until `cp_integrate release <job-id>`.
`status` includes the active hold even before any integration attempt.
The operator bridge exposes `cp_parent integration_hold` and
`integration_release` with `job_id` and a hold `reason`. These write directly
in the selected home without starting a parent, sending prose or waiting for
its current turn. Use the direct hold before sending a browser-QA request.

The validated record lives at `state/runs/<job-id>/integration-hold.json`
(under the mode's state directory), separate from the parent-owned fleet file.
It survives process restarts and head changes. Manual and automatic integration
read it at entry and again immediately before both the repository-permitted
and human-checkpoint merge commands. An active or unreadable hold returns
`next: wait` with the reason; neither green CI nor an approved checkpoint
clears it. Unknown jobs, non-PR jobs, unsafe ids and empty reasons are refused.

Release is idempotent and only removes the pause. Call `cp_integrate advance`
after release (from the bridge, send that instruction to the parent); the next
advance rechecks CI, review and repository permission. Release is not merge
authorization and does not start a background retry. A hold cannot cancel a
merge command already issued or prevent someone merging outside Command Post.

### The held-PR continuation (jje.2)

[`src/held-continuation.ts`](../src/held-continuation.ts). PR #219 sat green for
twelve minutes, two verdict revisions were missed and a PR was torn down on a
redelivered do-not-act notice (2026-09-25): each waited on a parent *turn* to
call `cp_integrate`, or acted on a notice rather than on facts. The live parent
(`continuation: true`, and only while it holds the parent lock) now runs the
sequence above by itself on four triggers:

| trigger | where it is observed |
|---|---|
| an accepted `hold` envelope | `EnvelopeIntake`'s `onReported` |
| a `ci_green` / `ci_failed` / `pr_merged` / `pr_closed` fact for the held head | `CiWatch`'s `onObserved` — at derivation, never at notice delivery |
| a diff review whose `next` is `proceed` | `ReviewRuns`' `beforeWakeup`, after the verdict is on disk and before `cp-verdict` is sent |
| startup | `session_start`, after `reconcile`: every held `delivery:pr` ship job, once |

Each trigger loops `Integrator.advance` while `next: advance` and stops on
anything else: `wait` is left to the watcher's next fact; `review` starts one
`cp_review` only when no attempt is pending (a revise still goes to the job's
own implementer, from the review itself); `resolve`, `surface`, `retry` and
`done` stop with one durable `HELD PR STOPPED`/`LANDED` notice (a `recovery`
wake-up whose id is job, generation, head, step and `next`, so the same outcome
is delivered once and a new head or generation is new news). An operational
fault is never retried here, nothing waits on CI and nothing mints an approval:
every step still re-reads the head, CI and GitHub's permission itself.

**Serial per project.** Every continuation step and every manual `cp_integrate`
share one lane per project, so a second PR's step reads the base the first merge
left (GitHub's `BEHIND` then drives the ordinary server-side update).

**Exactly once.** A trigger is coalesced on `job|head|event` (plus attempt or
generation) for the life of the process — a CI fact snapshots the generation it
was observed on — and re-checked *before every step*, not once: a job
that is no longer held with an open PR, a reopened generation, or a head its
owning source (the watcher for CI facts, the fleet for a verdict) has moved past
acts on nothing. The action's idempotence is therefore independent of whether
any notice was delivered; the notices themselves collapse too — a `cp-verdict`
(`job|surface|attempt`) or `cp-ci` (`job|head|event`) copy already delivered is
rewritten as a replay, across contexts, via the session's replay memory in
`reviewWakeups` — keyed on the delivering context entry (stamp `issued_at` plus
the message's own `timestamp`), so a redelivery with an identical stamp is still
a replay. Each run is one `cp:continuation` run-log line; a failed CI watch
query is a `cp:ci_watch_failed` line on its job, and a tick that throws is one
durable `CI/PR WATCH TICK FAILED` wake-up per cause (`state/wakeups.json`).

**The one destructive local call is guarded twice, and both guards fail
closed.** `git reset --hard` runs only when the worktree is clean *and*
`rev-list --count <remote-tip>..HEAD` is 0 — a clean worktree is not the same
as a worktree with nothing to lose, and an implementer that committed without
pushing has work that exists in exactly one place. A count that cannot be read
is "do not touch it", never zero. Either refusal surfaces as `sync`, which
leaves teardown to refuse the job as `unpushed`.

**A count above zero is not, by itself, work that exists in one place**
(cp-8vf6). That guard refused 7 times on 2026-09-01 — cp-n7w, cp-p0r, cp-rs1,
cp-jqk3, cp-to39, cp-bw4, cp-nz95, a 33% refusal rate against 21 completed
integrations — and every one of those refusals was literally correct and
substantively a false alarm: the commits were the branch's own **pre-rebase**
versions, whose content origin had already absorbed through the server-side
rebase and the squash merge. (The earlier claim here, that "those commits
really are unpushed", was false for all seven: each was a head the lease had
itself pushed, which origin then rewrote.) The parent proved losslessness by
hand each time, seven for seven, and then reset manually.

So the guard now *obtains* that proof rather than requiring a human to. When
the count is above zero, the sync step compares the **cumulative branch diff's
patch-id** of the local head and of the sha origin names — for each, `git diff
<merge-base with the base tip> <head> | git patch-id --stable`, with the base
tip read from **origin itself** (`git ls-remote origin <base>`, never
`origin/<base>`: a proof that read a tracking ref would reintroduce the bug PR
#71 fixed, in the one place where it decides whether work is discarded). Two
equal, non-empty ids mean both heads carry the same change against the same
base, which is exactly what a server-side rebase produces. Cheaper proofs are
not sound and were measured against the seven: `git cherry` still refused 3 of
7 (a squash merge collapses N commits into one), a plain diff against the merge
commit is never empty (the stale head sits on an older base), and `git diff
--raw` blob shas differ whenever the pre-image moved, refusing 4 of 7.

**Everything about that proof fails closed, and it is reversible.** An
unreadable base, a missing merge base, a diff that will not read, an *empty*
cumulative diff (two empty diffs are equal and prove nothing), a patch-id git
declines to give, or two ids that differ all end in the refusal this step has
always made, with the reason naming which question could not be answered.
Before a proven reset the discarded head is written to
`refs/cp-salvage/<job-id>/<utc>` and named in the fact the parent relays, so
recovery is `git reset --hard <that ref>` rather than reflog archaeology — and
a rescue ref that cannot be written is itself a refusal. What a passing proof
discards is **commit identity** (shas, boundaries, committer times), which a
squash merge has already discarded; a rebase that resolved a conflict changes
the cumulative diff, so it is refused, correctly and deliberately.

**Retention for `refs/cp-salvage/*`: deletion is as safe as the write**
(cp-wcy5). Those refs accumulate one per proven reset, and the one rule that
licenses removing one is that **its commit is provably reachable from the tip
origin names for the base** — never age, never count, never a timer, and never
a ref outside `refs/cp-salvage/` (checked in code by `isSalvageRef` behind
`for-each-ref`'s own scoping). The prune runs at the end of a successful
`cp_integrate`, in the same tool that wrote the ref, at the one moment the base
has demonstrably moved: no sweep, no background job, `SALVAGE_PRUNE_MAX` refs
examined per call — the listing is `for-each-ref --sort=refname`, so the slice
is deterministic and the refs beyond the bound are *kept* and are the same
remainder the next integration examines first. The base
tip is read from **origin itself** (`git ls-remote`, the PR #71 / PR #85
lesson, here deciding whether a rescue ref is destroyed), reachability is
`git merge-base --is-ancestor <sha> <that tip>` — exit 0 prunes, exit 1 keeps,
**any other exit keeps** — and the delete is `git update-ref -d <ref> <sha>`,
which git applies only if the ref still points at the sha that was proven. An
unlistable namespace, an unaskable origin, a base that cannot be fetched, an
unreadable ancestry answer and a refused delete all keep the ref.

Because this repository squash-merges, a pre-rebase head is *never* an ancestor
of the base, so the refs the 2026-09-01 shape produces are **kept** — and said
so: what was pruned (with the base tip that proved it) and what was kept (with
the reason for each) are facts on the integration record and an
`integration_advanced` run event with `step: "prune_salvage"`. A silently
deleted rescue ref would be indistinguishable from a lost one, which is why the
keeping is reported too. `/doctor` deliberately does not do this: it would have
to re-derive the base and would offer a deletion at a moment nothing changed.

**The reset names a sha, never `origin/<branch>`** (cp-uv5). The remote tip is
read from origin itself with `git ls-remote`, the guard compares HEAD against
*that* sha, and the `reset --hard` moves the worktree to *that* sha — so the
commit the worktree lands on is the one that was cleared, and the fact the
parent relays names where it actually went. Acting on the tracking ref instead
would act on a different answer from the one verified: `refs/remotes/origin/*`
goes stale on its own, is *shared* between leases in this layout (every lease is
a linked worktree of one clone, so another lease's fetch can move it), and does
not resolve at all in a `--single-branch` or `--depth` clone where `ls-remote`
answers fine. It fails closed exactly as cp-p0r does: an unreadable or absent
answer from origin leaves the worktree untouched and is never a fallback to the
ref.

**The order is the contract.** Merging with `--delete-branch` removes
`origin/<branch>` before the teardown gate can ask about it, and this repo
squash-merges everything, so branch content is never an ancestor of the base:
the gate is then left with `force`, which records that nothing was proven about
a merge that was fully provable. Deleting the head *after* teardown keeps the
strong `pushed` reason available and leaves the receipt as belt-and-braces.

### Authorization: repo-derived, per head sha, and nothing forced

`cp_integrate` never merges anything the repository itself would refuse. The
rule (cp-x7i, answered): **"if a given repository allows merging without force
then assume you can merge; if the repository does not allow it (e.g. minimum
reviewers), remind the operator that the merge is pending."** *Force* has an
exact mechanical meaning here: `--admin` (`gh pr merge --help`: "Use
administrator privileges to merge a pull request that does not meet
requirements") and any ruleset bypass. `cp_integrate` never passes `--admin`,
never passes `--auto`, and never invokes a bypass — so the refusal is **ours,
in code**, which matters because this home's PAT reports
`current_user_can_bypass: "always"` on the active ruleset: GitHub itself would
not necessarily refuse the merge for us.

The whole decision is one allowlist, read from `gh pr view`'s
`mergeStateStatus` on the branch's current pushed head, after CI is green for
that head (`src/merge-permission.ts`, `evaluateMergePermission`):

| `mergeStateStatus` | verdict | why |
|---|---|---|
| `CLEAN`, `HAS_HOOKS` | `permitted` | GitHub would take the merge unforced |
| `BLOCKED` | `pending` (cause: `reviews`, `checks`, or `unknown_block`) | needs `--admin`/bypass — that is *force* |
| `BEHIND`, `DIRTY`, `DRAFT`, `isDraft: true` | `pending` | already-current, already-conflict-checked, or a draft — never merged |
| `UNSTABLE` | `pending` (`unstable`) | GitHub would accept it, but a non-required check may be red and the check-rollup 403s for this token; **deliberately stricter than GitHub** so "never merge red" cannot be defeated by a check this home cannot see |
| `UNKNOWN` (or `mergeable: UNKNOWN`) | `retry` | GitHub is still computing mergeability — transient, nothing mutated |
| absent, empty, or an unrecognised value | `unreadable` | field drift or a token that cannot read it — **never** read as permission |

The **allowlist is the whole rule**, not a denylist: an unreadable or
unrecognised signal always falls to the fallback below, never to a merge. Cause
text for `BLOCKED` is read from `gh api repos/{owner}/{repo}/rules/branches/<base>`
when it is reachable (readable in this home; classic
`/branches/*/protection` is 403) — that query is reason-only and never widens
the verdict. Before the merge is attempted, the head is **re-read**
(`gh pr view` again) and compared to the head CI was verified for; a mismatch
(a force-push mid-check) voids the decision and re-enters CI verification from
scratch (`next: wait`). The merge itself passes
`--match-head-commit <head>`, which makes that binding atomic and server-side
rather than a comparison a later step could forget. An armed `autoMergeRequest`
is treated as a refusal to proceed (`gh pr merge` can silently arm auto-merge
instead of merging — the one shape that would be a standing authority in
disguise) and is surfaced, never re-issued.

**Where the repository refuses (`pending`), nothing is forced.** A **merge
pending** row is declared in Awaiting-you (`type: approval`, subject-keyed so
re-declaring updates one row, never mints a second) naming the cause, and
withdrawn automatically once a later call finds `permitted`. It is answerable
and droppable, never an authorization — an authorization row is never declared,
only derived from a checkpoint.

**A draft is a hold until review, not a refusal (jje.5).** Ship PRs open as
drafts (`gh pr create --draft` in `brief-ship`; an existing PR is reused as
is). A draft cause (`isDraft: true` or `DRAFT`) never raises a merge-pending
row or a `merge refused` escalation: with no pass on the current head (and no
approved flagged diff or accepted final fix — the same `#reviewRequired` gate
the merge takes) it returns `next: review`. Once the current head has one,
`cp_integrate` runs `gh pr ready <url>` once, re-reads the PR and returns
`next: advance` (the held-PR continuation calls again, and CI, permission and
review are all re-read before the `--match-head-commit` merge). A head that
moved across the ready call (or could not be re-read) is put back to draft with
`gh pr ready --undo` and returns `next: wait` naming the new head, which must
pass CI and review on its own; a stale pass never readies a new head, and a
refused undo surfaces. A refused ready (or a PR that still reads as a draft)
surfaces once and stops.
The same step runs on the CI-unreadable checkpoint path, before the checkpoint
is asked. An already-ready PR is never touched. No GitHub auto-merge is armed.

**Where the repository has no CI configured at all**, nothing is asked of a
human either. Zero observable runs used to mint the checkpoint below on its
own, which spent an authorization per head on repositories where no run will
ever exist (example-bot #6 and #7). That is now two conditions, and
only one of them relaxes anything. The test is **positive**, never an absence:
`gh api repos/{owner}/{repo}/actions/workflows` is asked, and only an answer
that parsed, from a command that succeeded, reporting `total_count: 0` with an
empty `workflows` array, is "no CI configured" (`readCiConfigured`,
`src/ci-configured.ts`). Such a branch falls through to the same repo-derived
permission read a green head takes and merges on authority `repo_derived` —
and a repository whose rules refuse the merge still refuses it, still surfaces
as **merge pending**, and is still never forced. Every other outcome of that
probe is CI-could-not-be-read and keeps the checkpoint: a 403 (`unauthorized`),
a network or other command failure (`command_failed`), a non-zero exit with no
output (`failed_silently`), a success that printed nothing (`empty_output`),
and output that will not parse (`unparsable`). Runs may exist behind any of
those, and they may be red. The same distinction unblocks the merge-ask gate:
`evaluateMergeAskCi` raises (`ci: "no_ci"`) on a runless branch **only** for a
positive `ciConfigured: "none"`, so a project with no CI no longer defers its
ship row forever waiting on a run that cannot happen, and every unreadable
state defers exactly as it always did. The review precondition is untouched:
no CI is not no review.

**The probe reads GitHub Actions and nothing else.** `none` means the
repository has no Actions workflows, which is a narrower claim than "no CI
anywhere": a repository whose CI is an external provider (CircleCI, Jenkins,
Buildkite, any commit-status poster) has zero Actions workflows and is
classified `none`. An external check that is **required** is still covered by
the permission read above — an unposted required status leaves
`mergeStateStatus` non-CLEAN, so the merge is `pending` and nothing lands. The
residual case is a **non-required** external check still in flight: GitHub can
report CLEAN while it runs, and the merge proceeds without that signal.

**Where this home cannot read the verdict at all** — `unreadable`, or a CI
state it cannot read for the branch — the per-PR, per-head-sha human
checkpoint survives as the named fallback, exactly as it worked before this
rule existed: `state/checkpoints/<job-id>.merge-<head>.json`, written `pending`
by the tool and answered **only** by a human channel (`/cp-authorize`,
`/cp-decline`, `/cp-decide`) through the one writer, `CheckpointStore.decide`.
It is answered by name (`/cp-authorize <job-id> --merge <head-sha>`, or the row
id `aw-checkpoint-<job-id>.merge-<head12>` pasted back). A bare `/cp-authorize
<job-id>` resolves to a merge authorization only when the job has exactly one
pending head; more than one refuses, names them, and writes nothing
(`resolveMergeScope`). It is bound to one commit **by its own file name**, so a
force-push after the answer has no authorization *at all* rather than a stale
one it might inherit. That name binds the *question*; the merge on this path
binds the *commit* the same way the repo-derived path does, with
`--match-head-commit <head>` (cp-n1a) — a force-push landing between the
answer and the merge is refused by GitHub itself (`next: retry`, nothing
recorded), instead of merging a head the human never saw and filing a
`human_checkpoint` receipt for it. **An approved checkpoint can never merge something the
repository refuses**: permission is evaluated before any checkpoint is
consulted, and `--admin` is never passed regardless of what a checkpoint says.

Every merge — either path — writes an audit record
(`MergeAuthoritySchema`: `repo_derived` or `human_checkpoint`) naming which rule
permitted it, journaled *before* the merge is attempted
(`integration_permitted`) and again onto `integration.json` and `merge.json`,
so "why did this merge happen" is answerable from disk months later with no
GitHub call.

**There is still no session-wide or blanket merge authority a human can
grant**, in chat or anywhere else: authority is the repository's, read fresh
for the head that would merge, and no sentence in this session or any other
widens what GitHub itself would refuse. That is what cp-x7i asked for and what
this section now describes, not a standing grant with a different name.

Checkpoint kinds do not collide: `ship` keeps `<id>.json` and the Awaiting-you
id `aw-checkpoint-<id>`; `diff` is `<id>.diff.json`; `merge` is
`<id>.merge-<head12>.json` with the id `aw-checkpoint-merge-<id>-<head12>`.
`listPending()` parses the file name (`parseCheckpointFileName`) rather than
stripping a suffix, so no store can report another kind's checkpoint under a br
id that was never a job id.

### The two-writer boundary

The branch has exactly one writer at any moment, and the boundaries are code:

1. the implementer owns the branch while its `pr` receipt is `open` — that is
   what the `delivery:pr` hold is *for*;
2. `cp_integrate` performs only server-side or read-only git
   (`gh pr update-branch --rebase`, `ls-remote`, `merge-base --is-ancestor`,
   `gh run list`). It never pushes commits from a worktree;
3. a conflict, or CI red after a rebase, is handed **back** to the job's own
   implementer with `cp_send` and a message generated in code — one promote,
   then a human (`INTEGRATE_MAX_RESOLVE`, the shape of `GATE_MAX_REVISE`). A
   replacement is never dispatched in its place. The message's first
   instruction is `git fetch origin && git reset --hard origin/<branch>`,
   because a server-side rebase leaves the worker's own clone behind origin;
4. `cp_merged` writes the receipt → the `pr` receipt becomes `merged` →
   `decideReopen` refuses any further `cp_send`. **Recording the merge is the
   code-enforced end of the implementer's write window**, which is why `record`
   must run after the last promote and before teardown.

### What the parent verifies afterwards

Three facts, all cheap local reads, returned by the tool as `end_state`:
`state/runs/<job-id>/merge.json` exists and validates; the fleet record is
`phase: done` with `closed_reason: "gated"` (never `"forced"`) and a `pr`
receipt of `merged`; the br issue is closed with a reason. `origin/main` moving
is not a check — it moves for everyone's merges — and `gh pr view` is a network
call the receipt already made once. The point is that the parent stops
re-deriving the sequence and reads a record that could only exist if it
happened.

### Queue ordering

Serial, by construction: `advance` advances exactly one PR, because each merge
restales the rest and keeping N PRs current off one base costs O(N²) rebases.
Which PR goes first is the operator's, expressed by which merge authorization
they answer first — so ordering needs no mechanism of its own, and v1 builds no
queue object.

### `gh` is a declared dependency now

`REQUIRED_TOOLS` gained `gh` (`src/tool-manifest.ts`, typechecked against
`TOOL_INSTALL` and `TOOL_SEVERITY`). A missing `gh` is a **warning**, not an
error: a home without it dispatches, runs and reports every job perfectly well,
and only merging is blocked — calling that "this home cannot dispatch" would
train an operator to ignore doctor.

## Artifacts and parent context guards

[`src/artifacts.ts`](../src/artifacts.ts) owns the store,
[`src/guards.ts`](../src/guards.ts) owns the rules that keep it out of the
parent's head. Both exist to make one ported HARD RULE mechanical: **the parent
never reads artifact bodies.**

### The store

One canonical file per job, `state/artifacts/<job-id>/report.md`, and three
operations — the ported `cmdp artifact path|add|get`:

| operation | does | returns |
|---|---|---|
| `path` | creates the directory, hands back the path a planner is *told* before it starts | the absolute path |
| `add` | files an existing file into the store by copy | `{path, bytes, source, copied}` |
| `get` | copies the body to a destination **the caller names** | `{out, bytes, source}` |

Every operation is `stat`, `mkdir`, `copyFile` or `rm`. Nothing in this module
opens the body, because the parent's no-bodies rule applies to its own code
first (the same discipline intake already follows). `get` has no inline mode at
all: the destination is a required argument, so the only way an artifact is
read is by a *worker* that was pointed at the file.

Fail-closed on `add`: an unknown job (no fleet record and no run directory —
the ported `requireBRIssue`), a missing source, a directory, or an empty file.
Fail-closed on `get`: no artifact, an empty destination, a destination inside
the store, or a destination that is a directory. `has()` is total — a job id
that is not even path-safe carries nothing, because a guard must never throw on
hostile input.

**T19 amendment.** command-post mirrored the body into a `br` comment
(`artifact:v1`) because `cmdp teardown` deleted `state/artifacts/<id>`. Here
teardown keeps the directory unless the operator asks for cleanup, so the file
system *is* the durable store — and copying a body into a ledger whose
`br show --json` inlines comment bodies would manufacture the exact hazard the
guard below exists to contain. `add` therefore registers a **file**, never a
comment. The `br show` guard survives the amendment because bodies can still
reach comments by other routes (an operator, an imported issue, a future
integration) and because the ported rule was always a blanket one.

### The guards

`ContextGuard.check()` is a pure decision over `{toolName, input, cwd}`, wired
to pi's `tool_call` event in the parent extension. It **blocks** (never
`terminate`s): the reason names the sanctioned alternative, so the model's next
move is the right one.

| code | fires on | the fix in the message |
|---|---|---|
| `artifact_body_read` | `read`/`grep` on a path in the store; any bash command that would emit one | `cp_artifact get` with an out file, `cp_artifact path`, or `ls`/`stat`/`wc` |
| `artifact_body_write` | `edit`/`write` into the store | the artifact is the worker's deliverable; `cp_artifact add` files one |
| `ledger_inlines_artifact` | `br show`/`comments`/`export` naming an **artifact-bearing** id | `br list`/`br ready` for status, `cp_artifact get` for the body |
| `never_commit_path` | `git add/commit/rm/stash/push` naming a `NEVER_COMMIT_PATHS` root (`.pi-command-post/`, and `.beads/` in multi mode) | commit source only |
| `bulk_stage_in_home` | `git add -A/./--all/-u` or `git commit -a` **in the command post home** | stage the explicit source paths |
| `leased_git_mutation` | parent bash `git checkout/switch/reset/clean` or force push targeting a live fleet lease, including `git -C` and compound commands | `cp_send`/`cp_revive` for worker changes, `cp_integrate` for merge/sync |
| `ci_checks_read` | parent bash `gh [flags] pr checks`, or a `gh` `--json`/`gh api` argument naming `statusCheckRollup` (the checks API is refused in this home; prose mentioning it is allowed) | `cp_integrate <job-id>`; CI is read from the Actions runs API by `cp_integrate` and the `cp-ci` wake-up |

The bash rule is an allowlist, because that is the only shape that fails
closed: a command that mentions an artifact path is refused unless it is a
plain metadata command (`ls`, `stat`, `wc`, `find`, `du`, `mkdir`, `test`,
`basename`, `dirname`, `realpath`, `file`, checksums) with no command
substitution and no input redirect. `ls state/artifacts` is fine;
`ls $(cat …/report.md)` is not. Commands are split on shell operators and
classified segment by segment, so `ls state/artifacts && cat …` is blocked on
its second segment.

`never_commit_path` matches two ways, both fail-closed: a leading path segment
that names one of the roots (`cd <home> && git add .beads` is the case
that motivates it) and any path that resolves inside this home's copy of one.
`data.json`, `src/data/x.ts` and, since cp-u3i2, a top-level `state/x` are not
matches — the roots are home-relative names, not substrings.

Live lease paths are resolved from the fleet at each parent tool call; a
returned lease is no longer guarded. Read-only git (`status`, `log`, `fetch`)
and commands outside a lease remain allowed. An unresolved destructive git
target is refused while leases are live. The guard applies only to parent bash,
never to worker git or internal integration operations.

**What the guards do not claim.** A worker's own `events.jsonl` records what the
worker did, including text it wrote — a planner that writes its artifact with
`bash` puts that text in its own run log. That is observability, and it is the
surface `watch` renders. The no-bodies rule is about the artifact **store**, the
**ledger**, and above all the parent's **context**: what the parent itself
writes (`fleet.json`, gate decisions, checkpoints, the intake headline) never
carries a body, and the guards stop the parent from reading one into the
session. §Reading the plan (cp-9c5) reads a body deliberately, but for the
**operator**, not the parent's context: it is not a tool call, so `ContextGuard`
never needs to know about it, and it stays mode-gated so nothing changes for
every caller that is not a real TUI a human is looking at.

**Scope: the parent only.** Workers spawn with `--no-extensions` and never load
this code; a worker reading the artifact it was handed is the entire point of
`cp_artifact get`.

`.beads/` was tracked in git for the duration of the build (it *was* the plan's
task list) while the guard refused to stage it — a contradiction that would have
shipped a home whose ledger is committable but unstageable. `cp-rnr` ended it:
the ledger is machine-local like `data/`, `state/` and `projects/`, the
`.gitignore` check is uniform over `NEVER_COMMIT_PATHS` with no exemption, and
the build's own history is rendered once into
[docs/build-history.md](build-history.md) instead of shipped as a database.

## Q&A answers (`delivery:answer`)

A small question about an onboarded project is not research and not ship: the
deliverable is **an answer a human reads once**, and the operator wants it in
front of them, not behind a `/cp-plan`. That is one new value on the delivery
axis and nothing else.

**Q&A is `kind:research` + `delivery:answer`.** The kind axis already describes
what a Q&A worker is — it reads, it reports, it changes nothing — so a Q&A
envelope is validated by the research rules verbatim (`artifact_path` required
and absolute and outside the worktree, `pr_url` forbidden, summary ≤ 3 lines
with no fences or headings), and teardown uses the same read-only gate (clean
tree, no local commits), because that gate is keyed on kind. `JOB_KINDS`,
`ROLES`, `EnvelopeSchema` and `TERMINATING_TOOL_BY_ROLE` are untouched.

| axis | value | why |
|---|---|---|
| kind | `research` | reads and reports; changes nothing |
| delivery | `answer` | the result lands as a card, not as a PR or a plan for a gate |
| role | `planner` | `ROLES` is fixed at three; `profiles/qa.md` reuses it (and inherits "planner profiles are read-only") |
| next, at intake | `teardown` | only `delivery === "pr"` holds |

**The br issue stays.** Every dispatch precondition keys on a job id
(`ledger.show`, the claim, `branch = job id`, `state/runs/<id>`,
`state/artifacts/<id>`, the lease holder, the fleet record), and so does the
whole observation stack (settle recovery, revive, `/watch`, wake-up staleness).
A "lighter id" would fork all of that to save one `br create` and one
`br close`. Labels: `project:<name>`, `delivery:answer`, `kind:research`; the
title is the question; `cp_teardown` closes with `answered: <headline>`. Lifecycle is an
ordinary research job's: open → claimed at dispatch → `held` on the envelope →
`cp_teardown`.

**Two doors, one code path.** `/cp-ask <project> <question…>` is the operator's
(deterministic — no model turn is spent deciding a question is a question), and
`cp_ask` is the parent's for a question asked in chat. `cp_ask` is in
`WORKER_FORBIDDEN_TOOLS` (it creates an issue and spawns a worker: the same
recursion guard as `cp_dispatch`) and in `FLEET_MUTATING_TOOLS` (it needs this
home's parent lock). `classifyIntake` gains an advisory third mode, `qa`; it
errs toward work, never toward a question, and `/cp-ask` is the door for the
cases it declines.

**Where the answer lives, and why the parent still cannot read it.** The answer
is an ordinary artifact at `state/artifacts/<job-id>/report.md`, so
[the guards](#the-guards) already refuse a parent `read`, `grep` or `bash` on
it — no new guard code, and `cp_artifact get` remains the only way a body
reaches a worker. `cp_ask`'s tool result is the **dispatch record**; the
wake-up is `formatIntake`'s headline; the card entry payload is a **pointer**
(job id, project, path, bytes) plus the envelope headline.

**The card.** `src/answer-card.ts` is the pure half (capped read, header,
collapsed/expanded selection, degrade line) and the extension renders it as a
pi **custom session entry** (`ANSWER_ENTRY_TYPE = "cp-answer"`), queued at
intake and drained onto the transcript by the parent extension (see
[the answer outbox](#the-answer-outbox) — it used to be appended
inline from `onReported`, which is how two answers were lost). Custom entries do not
participate in LLM context (docs/extensions.md), which is the same guarantee
`cp-output` already relies on for long `/status` output; the body is read
**at render time**, from disk, so nothing body-shaped is persisted in the
session file either. It cannot be confused with a plan: a plan has no entry
surface at all, the type is `cp-answer`, and the header word is `ANSWER`.
A missing or unreadable file degrades to one line naming the path and the byte
count — a renderer never throws.

**Bounds.** The envelope summary is unchanged (≤ 3 lines, no fences, no
headings — a body-shaped summary is still rejected). The answer file is bounded
by `ANSWER_MAX_BYTES` (8 KiB), enforced worker-side in the worker-reporter's
`localChecks` as a **repairable** error ("tighten it, or say the honest answer
is a plan") and capped again at render. A collapsed card shows
`ANSWER_CARD_COLLAPSED_LINES` body lines.

**What a Q&A job never does.** It raises no Awaiting-you row:
`deriveFromHeldResearch` skips `delivery === "answer"`, because "ship, drop or
follow-up?" is a question nobody asked — the operator asked a question and got
an answer. It mints no checkpoint, holds nothing, opens no PR, and a `blocked`
Q&A envelope produces no card at all (the wake-up headline and the blockers
carry it, as for any research job). Escalating from an answer to action is a
**new job**, never a promote of the Q&A worker. A pipeline refuses
`delivery:answer` in code, and a project's *default* delivery may not be
`answer` — it is chosen per question.

**Non-TUI modes.** Entries are TUI-only session data (the same two exclusions
`chooseOutputChannel` makes): RPC, print and json get a notice naming the path
and the byte count, never a body.

**Scheduled answers (cp-hhuf P1).** A card whose job is scheduled (ledger label
`schedule:<id>`) is delivered to channel `schedules_page`, before the TUI and
notice branches: it is never shown in the operator transcript. The answer
renders under that run on the Schedules page, read only from the job's own
`state/artifacts/<id>/` (symlinks resolved, a path outside it refused) and
capped at `ANSWER_MAX_BYTES`.

### The answer outbox

A Q&A job's answer is the whole deliverable, and it was delivered by a
single synchronous side effect at the worst possible moment. `cp-n9jh` filed
its envelope at 17:41:07, the parent relayed the headline and tore the job down
seven seconds later — exactly what this document tells it to do — and the
operator saw nothing at all. The only trace was a line about a *different*
message:

```
wakeup_suppressed { kind: envelope, stage: delivery, delay_seconds: 7,
  reason: "cp-n9jh is already done: the delivery landed and the job was torn down" }
```

`cp-5vl9` had lost its answer the same way an hour earlier. **Only a slow
parent escaped it.**

So delivery is now an outbox, the shape
[an answered decision](#an-answer-wakes-the-parent)
already proved:

- **`state/answer-cards.json`** (`src/answer-delivery.ts`) holds `pending` and
  `delivered`. A record is a **pointer plus the headline** — job id, project,
  path, bytes, `reported_at` — never a body, exactly like the entry payload it
  becomes.
- **`CommandPost` queues it at intake**, inside its own `onReported`, before
  the extension is told anything and before the wake-up is built. A queue write
  that fails never fails the envelope.
- **The extension drains it** at intake, at `session_start` and on the widget
  tick that already reads `state/`. Nothing new polls.
- **`markDelivered` runs after the surface took the card**, and persists: a
  restart never shows yesterday's answer again.

Four properties, and the reasons they are drawn where they are:

1. **Teardown cannot drop a card.** Nothing in this path reads the job's phase.
   A `done`, closed, torn-down job still owes its answer.
2. **The envelope wake-up's staleness is unchanged.** That message instructs
   the *parent* to act on a job, and acting on a torn-down job is the defect
   `checkWakeup` exists to prevent — so it is still suppressed, for every kind,
   with every reason it had before. The card was never the parent's message and
   should never have depended on one: it instructs nobody, it is the answer.
   (The alternative — exempting "card-bearing" envelopes from the staleness
   gate — would have put a stale instruction back into the parent's context to
   fix an operator-facing surface, and would still have left the card as a
   fire-and-forget side effect of a message.)
3. **Exactly once.** The key is `<job-id>#<generation>`: one envelope
   generation, one card. `enqueue` refuses an id that is pending or already
   delivered, so no trigger can mint a second card and no restart can
   resurrect a shown one. A promote that reopens the envelope slot mints a new
   generation, which is a new answer and correctly a new card.
4. **A surface that cannot show it does not consume it.** The sink returns
   `undefined` in modes with no operator surface (print/json, or before a ctx
   exists), and the card stays queued for the operator's terminal. RPC keeps
   the notice it always got.

**When a card is due.** `answerCardDue` prefers an idle session — a card
appended into a streaming turn is the one nobody saw — and bounds the wait at
`ANSWER_CARD_DEFER_SECONDS` (90s), after which it is shown anyway. Late is a
nuisance; never is the bug.

**Both halves are journaled** in the job's own run log: `answer_card_queued`
when the envelope earns a card, `answer_card_delivered` when a surface takes it
(with the channel). "Did the operator ever see the answer?" is now a fact,
whatever the job's phase has since become.

**Reproducing the TUI half (cur-20260901-5).** A green unit suite is not
evidence that a card renders. On a real pi TUI, in a scratch home with a
registered project: run `/cp-ask <project> "where is X configured?"`, confirm
the br issue carries the three labels and the widget shows the job running;
when the envelope lands, confirm the card appears in the transcript with no
operator action and a header reading `ANSWER — <job-id> · <project> · <bytes>`;
tear the job down immediately (`cp_teardown`, within seconds of the envelope)
and confirm the card is there and stays there — that is cp-6lg7's whole
regression, and it is the one step a green suite cannot stand in for;
toggle expansion with pi's own gesture and confirm the collapsed and expanded
views; restart pi on the same session and confirm the card re-renders from
disk; move the answer file away and confirm the degrade line; then ask the
parent model to read the answer path and confirm the guard refusal.

## Pipeline and checkpoint

[`src/pipeline.ts`](../src/pipeline.ts) runs research → gate → **checkpoint** →
implement, and [`src/checkpoint.ts`](../src/checkpoint.ts) holds the human
decision. Everything the machine needs is on disk, so a restarted parent picks
the pipeline up where it stopped:

```
state/pipelines/<research-id>.json   the link: {research_id, ship_id, project, delivery, state}
state/runs/<research-id>/gate-<n>.json   the verdicts (T20)
state/checkpoints/<ship-id>.json     the journaled human authorization
state/runs/<ship-id>/task.md         the artifact, handed over by path
state/runs/<ship-id>/review-<n>.json      the verdicts (diff review, Stage D, opt-in)
state/checkpoints/<ship-id>.diff.json     the second, post-diff authorization (opt-in)
```

States: `researching → gating → awaiting_authorization → implementing`, with
`escalated` as the gate's exit. After the implementer reports, an optional diff-review stage (when opted in) may hold the pipeline short of `done`, and `done` when the implementer reports (or after diff review passes when it is opted in). Each
`advance()` recomputes the state from facts and takes at most one step.

`cp_pipeline start wall_clock_seconds` is an optional positive integer applied
to both planner and implementer dispatches through the usual bound resolver.
The request is persisted across advances and reanchors; omission keeps the
home/env defaults. Each dispatch result reports its effective `wall_clock_seconds`.

**`escalate` is not one exit (cp-n10).** `escalated` is reserved for the
verdicts that must never reach a human: `policy`, `operational` and
`operational_persistent`. A `flagged` escalate — the reviewer found the plan
sound and only a veto flag (`destructive_scope`/`scope_growth`) forced the escalate —
takes the **same path as `pass`**: research closes, `#authorize` runs, and the
state becomes `awaiting_authorization` like any other checkpoint. The
distinction lives in gate policy (`decideGate`, above), not here; `advance()`
only reads `cause`. An explicit `override` answer to the escalation for the latest
terminal gate attempt lets `advance` continue through that same checkpoint path,
without spawning another planner or gate. The override must postdate the verdict
and the artifact must not have changed after the answer. It overrides gate
judgment, never the separate implementation authorization; checkpoint evidence
retains the original escalation cause.

### Asynchronous reviewers (`pending.json`, `cp-verdict`)

`cp_gate`, `cp_review` and the quality panel spawn a one-shot reviewer and
return `next: "wait"` at once; `cp_pipeline advance` returns `wait` in state
`gating` while any of them is pending. Each surface is split at its
`awaitVerdict` seam: `start()` is everything before the wait, `finish()` is
everything after it (decide, write the decision file, deliver a revise, shut
the reviewer down), and [`src/review-runs.ts`](../src/review-runs.ts) chains
them.

- **`pending.json`** lives in the attempt directory (`gate-<n>/`,
  `review-<n>/`, `quality-panel/`) from before the brief is sent until the
  decision is filed. It is what `/status`, the one-pending rule and the orphan
  sweep read. Schema `PendingReviewSchema`; `handed_back` flips when the caller
  has been given its `wait` result.
- **One pending attempt per (job, surface).** A second `start` is refused with
  the pending record.
- **Durable before announce.** The decision file is written and `pending.json`
  removed before the wake-up is sent. A failed send leaves the decision.
- **Handback before announce.** The wake-up waits until the tool result (or the
  `advance` result) that started the attempt has been composed.
- **Orphans.** A `pending.json` whose pid is dead and whose attempt has no
  decision is finished at `session_start` as an operational fault (the ladder
  retries); its wake-up is sent only when `handed_back` is true. The quality
  panel writes no report for an orphan: it runs again.
- **A finish that throws.** `review_orphaned` is journaled. With no decision on
  disk, `finish` runs once more with `{ operational: "reviewer finish failed: …" }`
  (one line, at most 400 characters): the attempt is decided
  `escalate`/`operational` (`operational_persistent` after an operational prior),
  never `pass` (the quality panel writes no report and says to run it again),
  and its wake-up goes out the ordinary way — so the next review is
  attempt N+1, never a replay of attempt N's scratch `verdict.json`. When a
  decision was already written (a partial finish), the fallback throws too, or it
  produces no wake-up, no `cp-verdict` is sent; one durable `recovery` notice
  (`review-finish:<job>:<surface>:<attempt>:<started_at>`, one per reviewer run)
  names the attempt and points at `cp_review`/`cp_gate` `status` and `/watch`. The notice authorizes nothing:
  `cp_integrate` still reads only the persisted decision on the exact head. An
  orphan finisher that throws gets the same notice, and the sweep continues.
  A diff review never carries the gate-only `decision_summary` into
  `DiffVerdictSchema` (it is projected out with `rubric`).
- **Delivery.** `verdict_wakeup_sent` and `verdict_wakeup_delivered` are
  journaled on the job's run log; arrival is confirmed from the message in the
  parent's context, never from the send. An unconfirmed wake-up is resent once
  after `VERDICT_DELIVERY_RETRY_SECONDS`.

### The three rules that make it a pipeline and not a script

1. **Evidence is not authorization.** A gate `pass` means the plan is good; it
   never means "ship it". The implementer is not dispatched until
   `state/checkpoints/<ship-id>.json` says `approved`. The record is written
   `pending` **before** anyone is asked, so a crash mid-question can never look
   like a yes; `decide()` is the only writer of an answer and refuses to
   overwrite one. Dismissing the dialog ("not now") leaves it pending — a
   decline is a decision that stays on the record.
   Channels that may answer: `cp_decide` citing a re-evaluated mandate
   (`decided_by: mandate:<id>`) or a verbatim operator quote (`decided_by:
   operator-quote`), or an active mandate auto-deciding when a checkpoint is
   minted. A model has no free-text path. Merge checkpoints need an operator
   quote unless the mandate's `ask_on` omits `merge`.

### Mandate evaluation (`MandateSchema`, `evaluateAuthority`)

Persisted at `state/mandates/<id>.json`. Written only by `cp_mandate`
(`issue|pause|resume|revoke|show|raise_tokens|supersede_stale|defaults_show|defaults_set`). `evaluateAuthority`
is pure: given a pending checkpoint (kind, job, project, routing `risk`/`scope`,
artifact hash) and the mandates on disk it returns `permitted (mandate id,
clause)` or `not permitted (reason)`.

| Input | Permitted? |
|---|---|
| active mandate, project listed, action allowed, risk not high, cap not reached, `ask_on` not hit | yes, clause names the action and project |
| project mismatch, excluded path/subsystem/job kind, expired, paused, revoked | no |
| expired, `diff` or `merge` checkpoint of an in-flight job (same-id, same-project, same-kind fleet record), no active grant covering it, the expired grant the latest to speak (*one permission rule* below) | evaluated like an active grant — allowed actions, exclusions, `ask_on`, risk and caps unchanged; clause says the expired grant continues the job. A `ship` checkpoint (first authorization) is never |
| `risk:high` with any provenance (including `inferred`) | no, unless `ask_on` omits `risk:high` **and** the objective names the job |
| unknown risk that does not resolve to high | not treated as high |
| `ask_on` includes `plan_approval` (ship) or `merge` (merge) | no |
| any gate flag raised (`destructive_scope`, `scope_growth`, `blocking_unknowns`) on the ship (plan) checkpoint's verdict | no; the checkpoint stays pending as a plan-approval escalation for the operator — the danger travels into its evidence, and a flagged plan checkpoint is never mandate-decided |
| USD cap reached | no; mandate pauses (`spend_cap`); one `budget_exhausted` escalation; no new dispatch; in-flight continues |
| job cap reached | only an implement (`ship`) decision for a job the grant does not yet count is refused; the grant **never pauses** on it, raises nothing, and review, repair, promotion and merge of the jobs it counts continue (`jobCapRefuses`; a project-wide grant counts jobs dispatched after issue and pre-existing ones once they spend under it) |
| token cap reached, cap under the home's `token_ceiling` | no; mandate pauses (`token_cap`); **no** operator escalation — the parent raises it itself (`cp_mandate raise_tokens`); in-flight continues |
| token cap reached, cap already at `token_ceiling` | no; mandate pauses (`token_cap`); one `budget_exhausted` escalation |

**Schedule grants (schedlater S3).** `cp_mandate issue … schedule_grant:true` writes `schedule_grant: true` on the
grant. Coverage (`covers`, and so every gate, `cp_next`, spend and cap read) then splits two ways: a schedule grant
covers **only** jobs of the one schedule naming it — a ledger job labelled `schedule:<id>`, or a fleet record whose
`schedule_id` is that id, where `state/schedules.json` says schedule `<id>` names this grant
(`MandateStore.scheduleMandates`; an unreadable file covers nothing) — and a grant without the flag covers **no**
scheduled job. So a schedule grant never covers, counts or recommends unrelated work (`cp_next` offers only its
schedule's ready jobs), and a project-wide grant's caps and parallelism never count a scheduled run. Both dispatch
paths write the fleet record's `schedule_id` (`^sch-[0-9a-f]{6}$`) from the ledger job's `schedule:` label; an
unscheduled record carries none.

**Caps count what covered jobs spend after the grant is issued.** `MandateStore.issue(input, jobs)` records
`usage_baseline` on the new grant: one entry per fleet job it covers (whatever its phase, zero-usage ones included),
holding that job's worker and reviewer usage at issue (USD, and **non-cached** tokens — see *Token caps* below),
read from the live view the cap watch uses (`liveUsageJobs`, plus reviewer spend — see *Reviewer spend* below).
`mandateSpend` then counts, per covered job and separately for its worker and reviewer part, `max(0, now − baseline)`:
a job with no entry (dispatched after issue) counts in full, and a reading that shrinks (a re-dispatch resets the
fleet usage until intake) contributes zero and never offsets another job's growth. Every unit a covered job spends
after issue is counted, so the caps bind as tightly as before on everything the grant existed for; what is left
out is only usage from before the grant existed. The job count follows the same line: a named grant (`job_ids`)
counts every job it names; a project-wide grant counts jobs dispatched after issue plus pre-existing jobs once they
spend under it, so a project's history never fills its job cap. `inFlight` (the parallelism slot) is unchanged.
A grant without `usage_baseline` (every grant issued before it existed) keeps lifetime counting. A new grant's counted
spend at issue is therefore zero: only a zero USD or token cap is refused, nothing is written, and the refusal shows all three
used/cap totals (tokens, USD, jobs).
The job cap is not an issue-time refusal: it limits new dispatches only, so a grant whose covered jobs already fill it still carries their review, repair and merge. A
replacement grant starts from each covered job's usage at its own issue; the capped grant keeps its pause, nothing is
auto-raised, no older grant is changed, and a wider USD budget is still only a new grant. Usage accrued after issue
pauses the grant on a later sweep.

**Caps are watched while workers run, not only at the next parent action** (`src/mandate-usage.ts`). Every
spawn path (dispatch, revive, bounded recovery) passes one `onUsage` observer through `attachWorkerObservers`;
the run recorder calls it after a `message_end` whose usage advanced the job's run total, from a single slot
replaced on every attach (a revived worker never stacks a second listener). It lays each job's live run usage
over the fleet's (each job counted once), sweeps the mandates, and journals one durable `recovery` notice per
crossing, keyed to the mandate (never staled by its job's teardown): `mandate-usage:<id>:warn-tokens` / `warn-usd`
when that message moves spend from under 80% of the cap to at or over it (tokens and USD independently), and
`mandate-usage:<id>:cap` (USD cap) / `token-cap` (token cap) only when this sweep paused the mandate — once a grant's token cap
has been raised its token keys carry the cap they crossed (`warn-tokens@<cap>`, `token-cap@<cap>`), so each raised round notices afresh — an older grant the parent already capped
says nothing, and a message that crosses nothing writes nothing. Each states the
used/cap totals and that the in-flight worker continues. Nothing is killed and nothing is raised automatically: the paused
mandate refuses the next dispatch and ship promotion, and a `token-cap` notice tells the parent to raise it itself. Mission caps pause future work and notify during
in-flight work, but they are not a strict monetary ceiling — a single model or tool event may exceed a cap
before it is observed.

### Token caps: non-cached, parent-raisable within a ceiling

**What a token cap counts.** `mandateSpend` sums `mandateTokens(usage)` = input + output + cache_write, i.e.
`total_tokens` minus `cache_read` — the rule the per-job budget already applies (`billableTokens`,
`src/failures.ts`). It is the one sum behind the issue-time check, the sweep's pause, the 80% and cap
notices (whose per-message delta is non-cached too), `cp_next`'s `tokens` and `cp_mandate show`. A cache reread is
priced at roughly a tenth of an input token; counting it at full weight is what paused grants this session with
most of their USD cap unspent: md-7852fe (3M cap) on 80.7M total tokens that were 2.38M non-cached, at $13.42 of
$20; md-8c91b7 (10M cap) on 16.85M total, 0.61M non-cached, at $9.12 of $20.

**The default: `spend_usd` $100, `spend_tokens` 10,000,000.** This session's 22 runs (`state/runs/*/status.json`): 97.7M total
tokens, 3.06M non-cached (96.9% cache reads), $19.12. Non-cached per job: median 0.10M, p90 0.26M, max 0.71M
(cp-78vu, 23.1M total). At ~$6.25 per 1M non-cached tokens 10M non-cached is ~$62, inside the $100 USD cap, so the token
cap is the first to bind; 10M is ~3x the whole session and ~14x its largest job — a runaway guard for cheap models,
never the brake on an ordinary mission. An existing home keeps its file (it is never rewritten):
`cp_mandate defaults_set spend_usd 100` and `cp_mandate defaults_set spend_tokens 10000000` adopt the new defaults.

**Raising a token cap is the parent's own decision.** A token cap under the home's `token_ceiling`
(`data/mandate-defaults.json`, default 100,000,000; `defaults_set token_ceiling <n>`) pauses the grant with
`pause_reason: token_cap` and raises nothing to the operator. The parent calls `cp_mandate raise_tokens` with
`mandate_id`, `spend_tokens` (the new cap) and `reason` (`raiseTokenCap`, `src/mandate-usage.ts`): the new cap
must be above the current one and at most the ceiling; the raise is journaled on `Mandate.token_raises` (`at`,
`from`, `to`, `reason`, shown by `cp_mandate show`); a `token_cap`-paused grant resumes and is re-swept (any
other cap still pauses it); the in-flight job never stopped. Revoked or expired grants cannot be raised. Only
the USD cap or a token cap already at the ceiling raises `budget_exhausted`. **The ceiling is enforced in
`MandateStore.save` itself**, not only in `raiseTokenCap`: no write path persists a token cap above
`token_ceiling` — `save` and `issue` (an operator's explicit `spend_tokens` included) refuse it, naming the fix:
an operator who wants a larger grant raises the ceiling first (`cp_mandate defaults_set token_ceiling <n>`). **The USD cap has no
parent path:** `raiseTokenCap` refuses any request naming a USD amount, `cp_mandate raise_tokens` passes
`spend_usd` through only so that refusal happens in code, and no `MandateStore` method but `issue` sets
`spend_cap.usd` — a wider USD cap is always a new operator grant. An unreadable defaults file yields a ceiling
of 0 (fail closed: every token cap goes to the operator).

**Which grant speaks: one permission rule** (`grantStanding`, `src/mandate-permission.ts`; b-qbi.4 — lanes
expired 00:05Z and the review, repair and merge queue froze until 04:10Z). Every path that spends under a grant
asks one pure question — grant x use x job x `now` — and gets `none` (the grant does not cover the job: project,
`job_ids`, excluded job kind), `permit`, `refuse` or `silent` (covers it, does not speak):

| use | caller |
|---|---|
| `dispatch` | `cp_dispatch`, script dispatch (`assertDispatchAllowed`) |
| `promote` | `cp_send` with a new ship brief (`task`/`task_file`) (`assertDispatchAllowed`, `promotion`) |
| `implement` / `review` / `merge` | ship / diff / merge checkpoint auto-decision and `cp_decide` (`evaluateAuthority`) |
| `review` | `cp_review` reviewer spend (`assertReviewAllowed`) |
| `repair` | a fix sent to the job's own implementer: `cp_integrate` conflict or red CI, a diff-review revise (`cp_send` `purpose: repair`) |

| grant \ use | dispatch | promote | implement | review | repair | merge |
|---|---|---|---|---|---|---|
| active | permit | permit | permit | permit | permit | permit |
| paused (operator) | silent | silent | refuse | refuse | silent | refuse |
| paused (`spend_cap`/`token_cap`) | refuse | refuse | refuse | refuse | refuse | refuse |
| revoked | silent | silent | refuse | refuse | refuse | refuse |
| expired, job in flight (working or held) | refuse | permit* | refuse | permit* | permit* | permit* |
| expired, job in flight, its worker failed | permit* | permit* | refuse | permit* | permit* | permit* |
| expired, no same-kind fleet record | refuse | refuse | refuse | refuse | refuse | refuse |

*only when the grant's `allowed_actions` still names the continuation's action — `implement` for a failed-job
re-dispatch, `repair` for a promotion or repair, `review`, `merge` — otherwise refuse. **Expired** is read against
`now` as well as the stored status, so an unswept crossing is already expired; a paused grant past its expiry
takes the stricter of its two rows; a revoked grant is only revoked. **In flight** is the job's own fleet record:
same id, same project, same kind — it proves continuation, never new-task permission, so a kind- or
scope-changing promotion (research to ship) finds no record and is refused. The rule, as the operator stated it:
after expiry, permit same-job/same-kind promotion or steering of its existing worker for review fixes, CI or
conflict repair; `cp_revive` and continue-failed-job on original lease; review, integrate and merge for a job
already in flight under the grant. Refuse fresh dispatch/new jobs and kind- or scope-changing promotion. A plain
steer (`cp_send` with no brief and no `purpose`), `cp_revive` and bounded recovery on the job's own lease were never
mandate-gated and are not now. An expired continuation keeps the grant's USD/token caps and its risk:high ask. Every
non-expired cell is the behaviour that shipped before this rule, except that a cap-paused or revoked grant now
refuses repair before delivery. A new job needs a new grant (`cp_mandate issue`). A **reviewer start**
(`cp_review`, `assertReviewAllowed`) keeps its pre-rule path: an expired grant neither refuses it (no fleet record,
`review` not allowed, a cap reached) nor speaks for it, while paused and revoked still refuse; the expired row
still binds a `diff` checkpoint decided through `evaluateAuthority`.

**A revocation predating a job does not speak for it.** `grantStanding` ignores a
revoked grant only when its `revoked_at` is strictly before the job's dispatch
(or creation time before dispatch). Missing timestamps and same-second ties
keep the existing fail-closed standing. Review, repair and merge share this
rule; ignoring an old grant creates no new authority. A checkpoint with no
covering grant stays pending and names the job in its no-active-mandate reason.

**Combining grants** (`assertGrantsPermit`, and `evaluateAuthority` the same way): any active covering grant
decides — for a dispatch or promotion its own rules follow (risk:high ask, job cap, parallelism), for a
checkpoint its exclusions, allowed actions, `ask_on`, risk and caps (`judgeCovered`); otherwise the most recently
issued grant that speaks (`permit` or `refuse`) decides. A refusal names the grant and the fix; an expired
continuation still passes only under that grant's USD and token caps (for a checkpoint, every `judgeCovered` rule
too) and its clause says the expired grant continues the in-flight job. Nothing speaking passes (a gate) or stays
pending (a checkpoint). So a revoked grant keeps its `pause_reason` without ever refusing a dispatch (md-7852fe
once refused `cp_pipeline start` / `cp_dispatch` although newer active grants covered the job); `cp_next` offers
no fresh work under an expired grant and prefers the earliest-issued active grant over any paused one; a
patch-equivalent review pass costs nothing and stays available; merge stays per head, CI- and review-governed.

**Reviewer spend counts.** Every diff-review, gate and quality-panel reviewer records its own run under
`state/runs/<job>/{review-<n>,gate-<n>,quality-<slot>}/status.json`. `MandateStore.withReviewerSpend` lays their
summed usage on the reviewed job as `reviewer_usage` (idempotent, only for jobs a live grant covers), and
`mandateSpend` adds it to the job's worker usage with the same non-cached rule (`mandateTokens`), so reviewer
spend moves the covering grant toward its USD and token caps in every sum above: issue, sweep, `evaluateAuthority`
(via `cp_decide` and auto-decision), `cp_next` and `cp_mandate show`. A reviewer run carries no live usage observer,
so its spend is seen at the next sweep, not mid-review.

### The risk:high dispatch gate (`assertDispatchAllowed`, cur.2.4)

The table above is a checkpoint's own evaluation; a direct `kind:ship` dispatch
has no checkpoint before implementation, so `ask_on: [risk:high]` used to let
one through unasked. `assertDispatchAllowed` (`src/mandate.ts`) now takes the
resolved routing (`risk`, the evidence words routing matched) and the job kind
alongside caps, and runs before the preflight's lease, in both places implementation
starts:

- `cp_dispatch` (`src/dispatch.ts`), after preflight, before the lease.
- `cp_send` promoting a `kind:ship` job with a new `task`/`taskFile` — risk
  is read fresh from the new brief's own words, the same signal set
  `cp_dispatch` reads, so a job started low-risk cannot be promoted into risky
  work unasked.

When an active, covering mandate's `ask_on` names `risk:high` and the gate's
risk is `high` (see H6 below for the one inferred case that only warns), the call is refused and
one `risk_high_irreversible` escalation is raised (duplicate-safe: a second
refused attempt raises nothing new), naming the job and the risk evidence
words. Options: `approve` (the next `cp_dispatch`/`cp_send` for this job
proceeds) or `drop`. The escalation is answered directly by `cp_decide` with an
operator quote (never a mandate basis — `risk:high` never auto-permits) —
a structured escalation is never a checkpoint or a declared Awaiting-you row,
so `decide()` answers it through `EscalationStore.answer` and never through
`CheckpointStore`/`AwaitingStore`. The record: a **decided, approving**
`risk_high_irreversible` escalation naming a job id is permission for that job
id only; a new job id needs a new decision, and an escalation answered `drop`
leaves the job refused. `cp_dispatch dry_run` reports `mandate_gate: "would ask:
risk:high"` from the same predicate (`MandateStore.wouldAskRiskHigh`), with
nothing escalated.

**H6: an inferred risk:high warns; an assessed risk:high gates** (`src/risk-warning.ts`).
`inferScopeAndRisk` is a keyword heuristic. When routing's risk is `high` only
because keywords matched (provenance `inferred`) and a parent or planner recorded
`low`, the gate reads `low` and — where a covering grant would have asked — the
result carries one `risk_warning` line naming every matched keyword. A recorded
low is: an explicit `risk: low` on `cp_dispatch` or `cp_pipeline start` (the
latter frozen on `task_impact`, the value `cp_pipeline classify` advises), or a
planner `self_assessment` with `destructive_scope: false` and no
`blocking_unknowns`/low confidence. `composeImplementationRouting` hands it to the
implementer dispatch as `DispatchRequest.recordedRisk`, never as routing input:
routing still infers from the ship job's words and may pick the risky-ship tier.
A pipeline axis is a record only when it was `explicit` or `assessed`: a `defaulted`
axis (nobody named a risk at `cp_pipeline start`) and an `inferred` one are not
records, so a standing low can never warn a high away, and the planner's own half is
named as its own source (`assessed by the planner`, never `by the pipeline`).
The composition reads the **plan's own** two halves: the planner's `self_assessment`
(`destructive_scope`, `blocking_unknowns`, `confidence: low`) and the newest gate verdict's
`flags` (`destructive_scope`, `blocking_unknowns`; `scope_growth` is size, not impact). Either
half sets `risk: high` with `assessed` provenance and suppresses the recorded low, so a plan
the reviewer could not resolve is never dispatched as low-risk. The ship job's `risk:` ledger
label follows that assessed value (`recordAssessedRisk`, `src/risk-warning.ts`): one `risk:high`
written at the implementer handoff for an assessed high, replacing a stale `risk:low`, and
never written for a `defaulted`/`inferred` axis or as a low.
When routing's risk and the recorded one differ, the fleet record keeps it as
`JobRouting.recorded_risk` (a single additive field) so a later `cp_send`
promotion reads the same low. The warning lands in three places: the
`cp_dispatch`/`cp_send` result (`risk_warning`; a pipeline advance appends it to
`message` and carries it on `dispatch`), the run journal (`routing_resolved` /
`prompt_sent` payload `risk_warning`), and a cp-bridge `wake` relay built from
the tool result (`src/cp-bridge.ts`). A high that is `explicit` or `assessed`
(an explicit `risk: high`, a planner's destructive/uncertain assessment, a
start-time high) gates exactly as above; so does an inferred high nobody
recorded a low against.

**The job's own record** (riskkw-f10). A recorded low is also a `risk:low` ledger
label (`cp_job create risk`, `cp_pipeline start risk` on both jobs; parent/operator
surfaces only, `cp_job` is worker-forbidden) or a header declaration: in the
dispatch `task`/`task_file` or the job's ledger `description` (never the title),
the lines before the first `##`-or-deeper heading, thematic break or fence (20
lines, 2000 chars), `risk` at a clause start, an optional `:`/`=`, then `low` or
`high` (`Scope M each, risk low.`, `**Risk:** high`); `low-level`, `risk:high-x` or
a following `escalation`/`gate`/`job`/`ask`/`checkpoint`/`warning`/`refusal`/`approval`
declares nothing, and both `low` and `high` declare `high` (`declaredRisk`). A
recorded or declared **high** gates, routes as an explicit high when the caller
named no risk (`riskField`), and beats every low — an explicit `cp_dispatch risk:
low` included — for the gate; a recorded low never routes and never lowers an
explicit or assessed high. One precedence serves dispatch, dry run and `cp_send`
(`recordedRisk`): any high (the job's label, description header, task header, then
the caller's), then the explicit/assessed request, the pipeline's, the fleet
record's, the job's own low. A malformed or second `risk:` label refuses at
create, update and dispatch (`requireJobLabels`). Every surface names the source:
the warning (`…; risk low was recorded on the job's risk: label, so …`, or `in the
task header`, `in the job description header`, `on the dispatch`, `by the
pipeline`, `assessed by the planner`, `at dispatch`), a refused recorded high's escalation evidence (`risk
high recorded …`), and the `routing_resolved` payload (`recorded_risk`,
`recorded_risk_from`). Script jobs read a recorded or declared description high
only; a recorded low does not soften their keyword gate.

#### Mandate defaults (`src/mandate-defaults.ts`, autonomy-programme-cur.2.5)

`cp_mandate issue` needs only `projects` and `objective`. Every other field
(`expiry`/`expiry_hours`, `spend_cap.usd`, `spend_cap.tokens`, `job_cap`,
`dispatch_parallelism`, `allowed_actions`, `ask_on`, `exclusions.paths`) resolves
through a three-tier ladder, `resolveMandateGrant`: an explicit argument on the
`cp_mandate issue` call wins, then a matching `mandate` override object on the
named project's `data/projects.json` entry, then the home's
`data/mandate-defaults.json` (scaffolded once by `scaffoldHome` with
conservative values — 8h expiry, $100, 10M non-cached tokens (`token_ceiling` 100M), 3-job cap, 3 jobs at once,
every action including merge, `ask_on: [risk:high]`, and `.github/workflows/`,
`secrets/`, `**/.env*` excluded — and never rewritten after). A mandate that
names more than one project only takes a project tier when every named project
agrees; disagreement falls through to home. Every resolved field's source
(`explicit` | `project` | `home`) is written onto the issued mandate
(`Mandate.provenance`) and shown by `cp_mandate show`. `cp_mandate defaults_show`
/ `defaults_set <key> <value>` (and `/cp-mandate-defaults` in a TUI parent) read
and atomically write the home file.

`exclusions.paths` matches are substring (`value === needle`, `startsWith`, `includes`) except when a
needle contains `*` (autonomy-programme-cur.2.6): `**/` at the start means "any directory or none",
a trailing `*` means "any suffix", so the scaffolded `**/.env*` actually excludes `.env`,
`services/api/.env` and `.env.production` (`hitsNeedle`, `src/mandate.ts`).

A bare `#N` (or `owner/repo#N`) in `cp_mandate issue`'s `objective` — with exactly one named
project — resolves against that project's `clone_url` to a GitHub issue url, is checked through
the same `verifyExternalRef`/`describeRefMismatch` read `cp_job create` uses, and either mints one
job or refuses the whole `issue` call and raises one
`conflicting_acceptance` escalation, exactly as a bad `external_ref` refuses `cp_job create`
(`resolveMandateObjectiveRef`, `src/mandate.ts`). The minted job's id is **not** appended to
`Mandate.job_ids` (b-qbi.3; ~15 reissues when an issue objective pinned the grant to its first job):
the objective is operator-defined mission scope, so a grant without explicit `job_ids` stays
project-wide and covers second PRs and takeovers, under the same project, exclusion, cap and
risk:high predicates; `cp_next` raises no mission end for it on the first close. The parent records
follow-ons only within that scope and escalates scope growth (`scope expansion`) — no code reads
the objective prose for scope. Explicit `job_ids` (or the this-turn sentinel) still narrow the grant. An unqualified `#N` counts only as the whole
objective or right after an issue-task word (`issue`, `fix`, `closes`, `resolves`, `address`,
`implement`, `target`); a PR label (`PR #7`) or an incidental status number (`after #220 merged`)
is prose — no verification, no job, no escalation (bead b-qbi.2). `owner/repo#N` is explicit and
always verified; `cp_job create`'s `external_ref` stays strict.

The operator note's Mandate template (`src/operator-note.ts`) tells the main LLM
the same thing: name a project (or the several projects one topic spans) and an
objective, never ask for caps/expiry/
actions, echo the effective grant (fields and sources) in one line once issued.

### Continuation (`cp_next`, cur.4.1)

[`src/next.ts`](../src/next.ts) is one read \u2014 no dispatch, no job created \u2014 that
answers what a continuation loop needs after every wake-up: given the active
mandate (the earliest-issued active mandate covering the project, else the earliest paused one; revoked and expired never count),
the open unblocked jobs it covers (`cp_job ready`, filtered by `covers()`),
how many of them are already working (`phase: waiting`) against `dispatch_parallelism` (the resolved
default, 3 on a fresh home, 1 = serial; a grant without one is serial; a `held` delivery counts toward spend and jobs but not the slot). A slot is one *fresh*
implementer at a time: `assertDispatchAllowed(..., { promotion: true })` — a `cp_send` promotion of an
existing job's own worker — is still gated by risk and pauses but never by the slot, so repairing a held PR
may overlap the next job's work. The mandate's status and remaining spend/token/job caps, and one
recommendation:

| Condition | `action.kind` |
|---|---|
| no active or paused mandate covers the project | `no_mandate` |
| mandate is paused | `paused` \u2014 no new dispatch; in-flight continues; on `token_cap` under the ceiling the reason tells the parent to `cp_mandate raise_tokens` |
| every job the mandate names (`job_ids`) is closed | `mission_end` — raises one `mission_end` escalation (`landed`, `dropped`, `cost`); a repeat call returns the same escalation id, never a second one. A clean finish (nothing dropped, no fleet record `failed`) closes itself: the escalation is answered `close` by `mandate:<id>` (basis `{mandate, clause}` on the record) and the grant is revoked, so Map and Board show it closed; a messy one stays open and the bridge relays it to the main session as an escalation. Once that grant's mission end is answered (`close` or `extend`) the call returns the answered id, reason `already answered … not re-asked`, and raises nothing — a replacement grant has its own id and its own mission end |
| nothing is ready under the mandate | `wait` |
| live workers already meet `dispatch_parallelism` | `wait` |
| live worker processes (every manager-owned process, held authors and reviewers included) ≥ `spawn_cap` | `wait` for every grant's `dispatch`, `others` included — names the cap, the live count and up to three held job ids; nothing is queued, the job dispatches on a later `cp_next` once one tears down. A `pipeline` recommendation stands: `cp_pipeline advance` spawns a gate-reviewer (inside the manager's review reserve) or nothing, and its implementer dispatch meets the manager's own refusal |
| every ready job is new and the job cap is reached | `wait` \u2014 no new dispatch; the grant stays active for the jobs it counts |
| a ready job has a `PipelineStore` record | `pipeline` \u2014 `cp_pipeline advance <id>` |
| otherwise, the first ready job | `dispatch` \u2014 `cp_dispatch <id>` |

When several grants cover the project, every other grant's result rides along in `others`; one the parent must act on (`dispatch`, `pipeline`, `mission_end`, an escalation id, a warning, or a blocked row with a `cp_decide` id) renders in full, and the rest is one line each (`<id>: <status> <live>/<parallelism>, jobs <used>/<cap> — <kind>: <reason>`), so the answer does not grow with the number of waiting grants.

`cp_next` also reads each registered project's `br ready --json` once per call
(10-second command timeout, 4 MiB output bound), using the canonical clone's
explicit bead database. It skips epics, `deferred` labels, and beads already
referenced by a job, including closed jobs. With spare mandate slots or no
active grant, it names the count and up to five IDs per project; a failed read
is explicitly unavailable, never an empty queue. These are intake suggestions,
not dispatch candidates or authority. A working-to-idle fleet transition reads
the same evidence and sends one `cp-bridge` wake per idle period. Starting work
again invalidates an outstanding idle read; repeated `cp_next` calls do not wake.

The recommendation is derived from labels (`project:`, `kind:`) and the
ledger's own dependency graph, never from prose: a blocked job enters `ready`
when its blocker closes as landed. A `dropped:` close does not satisfy the
result the dependent needs. `cp_next` includes blocked jobs separately from
ready candidates and names each blocker with its grant standing (active,
paused, expired, revoked or uncovered). Explanations are bounded to three
blockers per line and ten rendered job rows, with omitted counts; a wait
headline shows at most three jobs. The status block derives `waiting_on`
from the same read-only explanation, even when the caller omits blocked rows.

A dropped dependency under a covering active or paused, unexpired mandate
raises one `scope_expansion` question per dependent/blocker pair, even when
several grants cover it. Without a covering mandate the dependent is named
but nothing is escalated. `Escalation.dropped_dependency` stores the ordered
pair. Its answer is journaled first, then applied atomically in the ledger:
`proceed` removes the dependency, `drop` closes the dependent with a reason,
and `reopen` reopens the blocker while retaining its dropped history in a
comment. Repeating the answer is idempotent; other answers are refused. An
answered pair is not re-asked (a superseded unanswered record can be replaced
under a new grant). Ready-job ordering and in-flight recommendations stay
unchanged. Same-project overlap
beyond the parallelism count is not modeled separately (ponytail: capacity
cap only; add per-pair conflict rules if a mandate ever needs finer control).

### Escalation (one schema for "ask the human")

Persisted at `state/escalations.json`. Written only by `EscalationStore`
(`cp_escalate`, or the tools that already know the fact). Duplicate key is
a stable question identity among **open** records (`escalationIdentity`): kind, mandate id, job set and subject.
When a mandate is named the subject is the question with every number normalized out, so live numbers (mission_end
cost and counts, cap totals) refresh the open record — question, options, recommendation, evidence and clause
together — instead of minting a second; with no mandate it is the exact question text. A repeated wake-up does not
mint a second; a different question (a USD cap after a token cap on one grant), under another grant, or with no
grant, files as its own record, never merged into an older one (es-12172b, keyed job+kind, kept "md-a70d44 job cap reached (3)" and swallowed a later USD budget question).
Evidence is **paths**, never bodies. Status: `open` | `answered` | `withdrawn` |
`superseded`. A withdrawn or superseded record cannot be answered.

**Superseded.** When a mandate is revoked, expires, or is replaced (it is paused and a later-issued active grant
covers the escalation's first job), every open escalation belonging to it closes as `superseded`, with
`superseded_at` and `superseded_reason` recorded and no operator answer (`MandateStore.supersedeEscalations`,
run by `revoke`, the expiring sweep and `issue`). An escalation belongs to the grant named by its `mandate_id`
(cap and risk:high escalations now record it), or — for records raised before that — a leading `md-…` in its
question. `cp_mandate supersede_stale` runs the same pass on demand for records left open under grants revoked
or expired before this rule shipped. A superseded record is not open, so it leaves `cp_awaiting list`.
`/cp-decide <es-id>` journals the answer and, when `checkpoint_job_id` is set,
resolves that checkpoint in the same method.

**Mission-end close.** An operator-quoted `cp_decide <es-id> close` on a `mission_end` record answers it first,
then `MandateStore.revoke`s that record's `mandate_id` alone — no other grant changes. The answer lands before
the revoke, so the revoke's supersede pass never closes the record it answers; if the revoke fails after the
answer, the same call retried reaches the answered record by id (`getEscalation` — it is no longer an Awaiting
row) and re-runs the idempotent revoke. A different answer to an answered record is refused; `cp_decide` on a
withdrawn or superseded id is refused by the store, never read as a job checkpoint.

**Withdraw.** `cp_escalate action: withdraw, escalation_id, reason` (reason nonempty) closes a moot **open**
record as `withdrawn` via `EscalationStore.withdraw`: it leaves Awaiting-you, it can no longer be answered, and
it never decides a linked checkpoint — withdrawal is not an answer and not authorization. An answered or
superseded record is refused, and so is an unknown id. The persisted schema has no withdrawal reason; the reason
travels in the tool result only.

An open escalation is projected into Awaiting-you (`type: escalation`) from
the same store. The bridge (`src/cp-bridge.ts`) reads this store for
`cp_parent status` and relays `cp_escalate` tool calls on the RPC stream.
It exposes evidence paths, never artifact bodies.

| Operator-facing surface | Kind |
|---|---|
| product ambiguity | `product_ambiguity` |
| scope expansion | `scope_expansion` |
| risk high/irreversible (`risk:high`) | `risk_high_irreversible` |
| loop exhausted / 5th review / `operational_persistent` | `loop_exhausted` |
| budget breach / mandate cap | `budget_exhausted` |
| gate `escalate`/`policy` | `conflicting_acceptance` (cap → `loop_exhausted`) |
| integrate `surface` / repo refuses merge | `merge_refused` |
| mission end | `mission_end` |
| plan approval | `plan_approval` |

Ask the human when: mandate creation, product ambiguity, scope expansion,
risk:high, loop exhausted, budget exhausted (the USD cap, or a token
cap at `token_ceiling`), conflicting acceptance, merge refused, mission end.

Never ask: in-scope plan approval, how-questions, review findings, test
failures, next job, merge when the repository permits, bounded recovery, a
token-cap raise within the ceiling (`cp_mandate raise_tokens`, journaled).

Auto-decision: when a checkpoint is minted and evaluation permits, `decide()`
runs with `decided_by: mandate:<id>` and the clause in `note`; the existing
`cp-answered` wake-up fires. `cp_mandate show` lists every auto-decision.
Expiry/revoke: no new auto-decisions (except an expired grant's diff/merge for an in-flight job, see
*one permission rule*); workers are not killed. Merge authority
stays the repository's — the mandate may only allow the parent to proceed when
GitHub permits.
2. **The parent never reads the artifact.** The hand-off is
   `cp_artifact get -> state/runs/<ship-id>/task.md`, and dispatch reads that
   file **in code** (`taskFile`, the ported `--task-file`). The body never
   passes through the parent's context, which is the same rule the T19 guards
   enforce from the other side — and (cp-n7w) it never passes through the
   *implementer's brief* either: the brief names the file's path and tells the
   worker to read it directly. Earlier, `taskFile`'s content was substituted
   into the brief text verbatim, which put the whole artifact in front of
   `assertBriefIsSafe` — a plan that legitimately quoted credential-shaped
   environment facts (a measured `gh` rate-limit line, for instance) then
   tripped a guard the parent has no sanctioned way to resolve, since
   resolving it requires reading the artifact to redact or judge the match.
   Naming the path keeps the guard scanning only hand-typed brief text —
   where a real pasted secret is still refused, unchanged.
3. **An implementation failure never re-runs the research.** `recoverShip()`
   re-dispatches the implementer from the same task file, bounded by
   `MAX_RECOVERY_ATTEMPTS`; `mayRerunResearch` is asserted, not remembered.

### Ported details worth keeping

- **Two br issues, dep-linked.** `start()` creates `research: <title>`
  (`kind:research`, `delivery:pipeline`) and `ship: <title>` (`kind:ship`,
  the intake delivery) and adds the dependency, so `br ready` cannot offer the
  ship job while the research is open. The ledger is the operator's view; the
  pipeline file is the machine's.
- **Hung-planner recovery.** An artifact at the predeclared path with no
  envelope is still evidence: `advance()` gates it and reports
  `hung_planner: true`. A missing envelope is a worker problem, never a
  reason to redo the research.
- **The planner's measurements route the implementer (cp-rte).** The research
  envelope's `self_assessment` is contract-typed, so `advance()` passes it into
  the implementer's dispatch: `scope` becomes the routing scope, and `risk` is
  `high` when `destructive_scope`, `blocking_unknowns` or `confidence: "low"` is
  set — any one of them, because each is its own reason to spend a better model.
  Before this, every pipeline implementer routed as `S`/`low` and rubric rows for
  bigger work were dead code.

  **`suggested_implementer_model` is never read as an input.** A worker naming
  its successor's model is a worker choosing its own budget, with an obvious
  incentive and no way to check the claim. It travels as **checkpoint evidence**
  (`planner suggested model: … (advisory; routing decides)`) and, when it
  disagrees with the decision, as a line in the advance message. The operator
  sees the opinion next to the choice; the choice stays with the rubric.

  The field is an identifier, not a paragraph (`SUGGESTED_MODEL_MAX_CHARS`,
  80 chars) — real run logs showed workers cramming a justification into it
  ("claude-opus-4-6 (high-stakes incident-response runbook …)", 191 chars
  against the old 120-char cap), which both overflowed and broke the verbatim
  comparison against the routing decision above. The justification has its own
  field, `suggested_implementer_model_reason` (`SUGGESTED_MODEL_REASON_MAX_CHARS`,
  240 chars), folded into the same advisory line when present.
- **A revised artifact is a new artifact.** After a `revise`, the gate re-runs
  only when the artifact's mtime is newer than the last decision. Without that,
  the one-revise cap would be spent by a verdict on the *unrevised* file. So an
  advance while the revision is outstanding says the artifact **has not changed
  yet** rather than "the planner has it", which reads like progress forever.
- **`done` is a projection, and only `advance()` writes it.** Once the ship job
  has an accepted envelope (or is torn down), the next `advance()` records
  `done`. Nothing reaches sideways into the pipeline record — teardown does not
  — so the operator's last pipeline step is one more advance. T29 amendment: the
  state was documented and unreachable, and the same gap meant a second advance
  on a settled record walked the ladder down to a **second implementer**. An
  advance now stops at the ship job's facts: `done` when it reported, `wait`
  while it works, `surface` when it failed (recover it, never re-run research).
- **The research lease comes back before the implementer takes one.**
  `advance()` tears the research job down (kind-aware gates, T17) and refuses to
  dispatch if teardown is refused — a dirty research tree means research changed
  code, which is a finding of its own.
- **Classification is advisory.** `classifyIntake()` recommends single vs
  pipeline from deterministic signals (scope L, risk high, investigation or
  cross-cutting wording; "do not split small jobs" for named small changes) and
  says why. The caller can force either mode. What is *not* advisory is the
  structure this module enforces once a pipeline starts.
- **Reanchor supersedes a research job without touching `state/` by hand
  (cp-n10).** `PipelineRunner.reanchor(researchId, replacementResearchId)` —
  `cp_pipeline reanchor` — points a pipeline at a different, already-existing
  research job: the old record is marked `superseded_by` and `advance()`
  refuses it outright (its artifact must never reach an implementer, however
  the ladder is walked), while a **fresh** record is written for the
  replacement, keyed by its own research id with no gate history — so the next
  `advance()` gates it as if for the first time. The ledger dep on the ship job
  is moved to name the replacement, best-effort. Reanchor only applies while
  the pipeline is still `researching`, `gating` or `escalated`. Once it has
  reached a checkpoint (`awaiting_authorization`, pending or declined) or a
  dispatch (`implementing` / `done`), swapping the research is a new pipeline
  (`cp_pipeline start`), not a reanchor: the ship job's authorization is
  write-once and keyed by ship id, so a declined checkpoint would be inherited
  by the replacement rather than asked again. Decline does not unlock reanchor.
  Artifact resolution at implementer dispatch always reads `record.research_id`
  off the record `advance()` was called with, so following the replacement is
  not a special case — it is the only case `advance()` ever had.
- **Diff review is a post-implementation stage (Stage D); the pipeline's
  `review.enabled` flag decides only whether `advance()` runs it.** The standing
  obligation to review every `delivery:pr` diff is the parent's and is not
  opt-in (§Diff review is mandatory for a PR). When
  `PipelineRecord.review.enabled === true`, the pipeline does not reach `done`
  until a diff review verdict exists for the current HEAD. Review is stepped into
  after the implementer reports and is stepped through the same `nextAction`
  ladder as the gate: `pass` proceeds to done, `revise` promotes the implementer,
  `flagged` escalate asks a **second checkpoint**, and any other escalate surfaces
  to the operator. A pipeline that never opted in reaches `done` without
  reviewing — the parent still owes that branch an out-of-band `cp_review`.

## Research quality pass

[`src/quality.ts`](../src/quality.ts) is a cheap panel that runs **before** the
gate, and only when a job asks for it. It ports pi-dynamic-workflows' `verify()`
and `completenessCheck()`:

| capability | what it does | result |
|---|---|---|
| `verify` | N cheap voters, **one lens each** (`evidence`, `file_list`, `test_plan`, `scope`, `unknowns`), and a threshold over their votes | `{sound, sound_count, total, ratio, threshold, votes[]}` |
| `completenessCheck` | one pass asking whether the artifact covers the task it was given | `{complete, missing[]}` |

Defaults are the borrowed ones: 2 voters, threshold `0.5` (a fraction, applied
with `>=`). Both are **off** unless `data/quality.json` or the job's own opt-in
(`PipelineRecord.quality`, set by `cp_pipeline start`) turns them on.

T22 amendments, both forced by contracts already in this build:

1. Upstream `verify(item)` votes on one *finding*. Extracting findings would
   mean reading the artifact in the parent (forbidden, T19) or adding a fourth
   role with a fourth terminating tool (a contract change). Here each voter
   votes on the whole artifact **through one lens** — which is where
   per-finding disagreement actually shows up — and the tally is per lens.
2. A voter **is** a `gate-reviewer` worker with a different brief
   (`prompts/briefs/quality-verify.md`, `quality-completeness.md`), so the panel
   reuses the single terminating tool that role owns (`report_verdict`): no new
   role, no new schema, no new plumbing. A voter's `pass` is a sound vote; its
   `revise` carries the fixes.

Fail-closed choices in the math (`tallyVotes`):

- the denominator is every **expected** vote, so an abstention (a voter that
  never voted, timed out, or could not spawn) counts against the artifact;
- an empty panel is never sound, whatever the threshold says;
- a voter that cannot run **abstains**; it never blocks the job with an error.

Running it: the panel is one pass per job (`state/runs/<job-id>/quality.json` is
written once) and voters run **sequentially**, because they share the fleet's
spawn cap with workers doing actual work. In a pipeline, a *fresh* failing pass
promotes the planner once with the fixes and waits; the next `advance` goes
to the gate regardless. The panel is a pre-check, not a second gate — it must
not be able to loop.

## Operator questions

A planner's product question is a `blocked` envelope (cur.3.1), not
`ask_operator`. The tool is no longer granted at spawn. A finished plan is an
ordinary envelope (cur.3.2): gate, then a decision. The attach console is
deleted (cur.3.4). Neither a question nor its answer passes through the
parent's LLM context.

The channel is pi's own, not an invention: a worker runs in RPC mode, so a
`ctx.ui.select` inside the worker becomes an `extension_ui_request` on the
worker's stdout (`docs/rpc.md`, "Extension UI Protocol"), and
[`src/worker-process.ts`](../src/worker-process.ts) already intercepted those.
Before T31 it answered every one with `cancelled: true` — "a worker has no
operator to ask". T31 keeps that as the **default** and adds one governed
exception:

```
worker: ask_operator tool → ctx.ui.select
  → extension_ui_request (worker stdout)
    → WorkerProcess.onDialog → QuestionRelay: policy → journal → Asker
      → the operator's real dialog (ctx.ui in the parent extension)
    → extension_ui_response (worker stdin)
  → tool result, in the WORKER's context only
```

| rule | where it is enforced |
|---|---|
| **Planner only.** An implementer that stops to ask is an implementer not implementing; a reviewer's value is a fresh context with nobody in it | `ASKING_ROLES`, checked in `decideAsk` **and** at spawn (`WorkerManager#mayAsk`) |
| **Planners do not get `ask_operator`.** Questions are a blocked envelope. `CP_ASK_OPERATOR` is not set at spawn. A profile that lists the tool is still refused | `WorkerManager.plan`; `resolveWorkerTools` |
| **Fail closed.** No operator, wrong role, cap reached, dialog dismissed, deadline passed, asker throws → "no answer", exactly as before T31 | `QuestionRelay.handle` never throws; `#handleUiRequest` falls back to `cancelled` |
| **Bounded.** `QUESTION_MAX_CHARS`, `QUESTION_MAX_OPTIONS`, `QUESTION_MAX_PER_JOB`, `QUESTION_DEFAULT_TIMEOUT_MS` | contract constants, applied in `decideAsk` |
| **An answer is not an authorization.** A question that reads like permission is refused, and the refusal names `/cp-authorize` | `looksLikeAuthorization`, `QUESTION_AUTHORIZATION_PATTERNS` |
| **Journaled.** `state/runs/<job-id>/questions.jsonl`, append-only. A dead worker closes `worker_exited` | `QuestionStore`; also teed to `events.jsonl` as `question_asked` / `question_closed` |
| **Not the parent's reading material.** `read`/`grep`/`cat` of a questions journal is blocked, pointing at `/watch` | `ContextGuard`, code `question_journal_read` |

Mechanics worth knowing:

- **One exchange, two lines, one `seq`.** The `asked` line is written before a
  human is disturbed and is never rewritten; the closing line carries the
  outcome. So the cap counts **exchanges** (distinct `seq`), and "open" means no
  line with that `seq` carries `closed_at` — not "the first line lacks one".
- **A waiting job is still `waiting`.** There is no fifth phase and nothing is
  inferred from age: `/status` carries `open_question` (`seq`, question,
  `asked_at`). The `? asked you` marker is gone. A waiting planner with blockers
  is an ordinary waiting job; the fleet widget shows the blocker count.
- **The deadline is the relay's.** pi resolves a dialog itself when `timeout`
  passes, so a human is never load-bearing for a worker's liveness. The cost of a
  long deadline is a held lease, which is why it is minutes.
- **What the worker is told when nobody answers** is an instruction, not an
  apology: record the question under Unknowns/Blockers and finish — `blocked` if
  the plan cannot stand without it. That path is the planner brief's existing
  one, which is why no new failure mode appears.
- **An unanswered question reaches the operator anyway**, one step later: the
  planner's `blockers` travel in the envelope, the reviewer's `blocking_unknowns`
  flag is persisted on the verdict with its own reason line, and `pass` still
  reaches a **checkpoint** rather than a dispatch — so the open question is in
  front of a human before any implementation starts. Since cp-unknowns-no-veto
  that flag no longer forces `escalate` / `policy` → `surface`: an unresolved
  plan is the reviewer's own `revise` or `escalate` to give, not a flag's.

## Conversation revise / planner question reach the live planner

The operator's own words in the conversation — "revise the plan for job X: …" or "ask the planner of job X: …" — become a `cp_send` promote with no console and no new tool. AGENTS.md §Pipeline carries the two phrasings for the parent LLM; `src/plan-followup.ts` (`decidePlanSend`, wired into `Sender.send`) carries the two invariants no amount of prose can guarantee:

| rule | where |
|---|---|
| A revise names the artifact path and quotes the revision verbatim (`planReviseBrief`); a question asks for one `blocked` envelope, never a new plan (`planQuestionBrief`) | `src/plan-followup.ts` |
| `cp_send` recognizes both the operator's own sentence (`revise the plan for job <id>: …` / `ask the planner of job <id>: …`) and its own generated brief (so a promote it already sent round-trips through the same guard) | `parseOperatorPlanAsk`, `decidePlanSend` |
| One open revise at a time per job: a second revise before the first is re-gated is refused | `decision-revise.json`, `reviseStillOpen` — the same file `PipelineRunner.revisePlan` already wrote |
| A revise is refused once the plan checkpoint is `approved` and the implementer has been dispatched (a fleet record exists for the ship id); the refusal names the sanctioned path — a new research job, or `cp_send <ship-id>` to steer the implementer | `implementedReviseRefusal`, checked in `Sender.send` before anything is delivered |
| The bridge forwards the operator's sentence as plain prose; nothing new on the wire | `src/cp-bridge.ts`, unchanged |

## Awaiting you

The status block's "Awaiting you" table (above, and AGENTS.md §Status block) used
to be prose the model typed and the operator had to notice and answer in chat.
[`src/awaiting.ts`](../src/awaiting.ts) turns it into an answerable, durable
surface, without adding a second authorization path and without ever blocking
the parent session on an absent human.

**Three sources, merged, never one store:**

| source | `type` | where it lives | writer |
|---|---|---|---|
| pending checkpoints, **both kinds** | `authorization` | `state/checkpoints/<id>.json` and `<id>.diff.json` (`CheckpointStore.listPending`, one store per kind) | `CheckpointStore.decide` — the same one T21 already uses |
| finished research, no PR receipt **whose ship job has no checkpoint** (cp-80cv) | `approval` | `state/fleet.json` (`phase: held`, `kind: research`, no `pr` receipt) | `AwaitingStore.answerResolved`, and only once a human answers it |
| everything else | `approval` \| `design` | `state/awaiting.json` | `AwaitingStore.answer` / `.declare` / `.withdraw` |

A declared row is `open`, `answered`, `withdrawn` — or `deferred`, a row that
exists but is not yet askable, which is §The merge ask (cp-gmy) below.

**The id the operator is shown is the id that answers.** That identity is the
invariant the whole surface rests on, and derived rows are the *common* case —
the parent never declares one by hand. A derived row exists nowhere until it is
answered, so `AwaitingStore.answerResolved` takes the projected row (not just an
id), materialises it under **its own derived id** (`aw-research-<job-id>`, never a
fresh hash, never truncated) and answers it in the same atomic write.
`mergeAwaiting` then stops re-deriving that row, because the stored answer is the
only place "a human answered this" can live for a source — a held research job —
that has no other slot for one. `AwaitingStore.answer` refuses a derived id *by
name*, pointing at `answerResolved`, rather than reporting "no awaiting item".

### One decision is one question

**A pipeline's implement decision is asked once, as the checkpoint.** Two of the
three sources above can describe the same decision: the finished research job of
a pipeline derives "cp-uf00: ship, drop or follow-up?" while the authorization
checkpoint minted for its dep-linked ship job asks "Authorize implementation of
cp-76xa?". On 2026-09-04 the operator answered both, eighteen seconds apart
(`drop` at 18:07:26, `declined` at 18:07:44) and reported it as a bug: the
cascade worked, so the defect was being asked at all.

The **checkpoint survives**, and the derived research row is the one suppressed.
It is the stronger instrument in every way that matters here: only
`/cp-authorize`, `/cp-decline` or an approve/decline answer in `/cp-decide` can
answer it, `CheckpointStore.decide` is its single writer, a model has no path to
it, and its answer is what `cp_pipeline advance` reads before an implementer can
be dispatched at all. Nothing about that path changes: the suppression is a
filter over a *projection* (`mergeAwaiting`), not a write, and it can only ever
remove a duplicate question — never mint, answer or withdraw one.

- **The link is read, never guessed.** `Checkpoint.research_id` (written by
  `cp_pipeline advance` when it mints the checkpoint) is the normal case; the
  pipeline records themselves (`PipelineStore.list`, `{research_id, ship_id}`)
  are the fallback for a checkpoint file written without that field.
- **Pending *and* answered.** A checkpoint is answered milliseconds before the
  parent tears the research job down, and in that window the derived row would
  re-ask what the human just decided — "decline the implementation" and "drop
  the research" are the same answer. So a research job whose ship job has a
  checkpoint *at all* raises no derived row. `CheckpointStore.list` is the
  read behind it (`listPending` is now a filter over the same walk); an answered
  checkpoint still renders nothing anywhere.
- **The `ship` checkpoint, and only it.** A `diff` and a `merge` checkpoint
  carry a `research_id` too, but both ask about code that already exists, not
  about whether to implement the plan; reading them would make the suppression
  depend on which of a ship job's three authorizations happened to be open. They
  neither create it nor remove one the ship checkpoint established, and each
  still renders its own row (cp-khf, cp-uug).
- **Nothing else is suppressed** by the checkpoint filter. A standalone
  (non-pipeline) finished research job with no PR receipt raises its row
  exactly as before, and so does a pipeline still `researching` or `gating`
  with no ship checkpoint and no `superseded_by`. A pending or answered
  checkpoint for some *other* job never silences a research row. A pipeline
  research job that is `escalated` (gate surfaced) or has `superseded_by`
  (reanchored) raises no derived approval row — `researchApprovalIneligibleReason`,
  still a filter over the projection, never a write. Standalone finished
  research is unchanged.
- **Skip is unchanged**, on the survivor as everywhere else: it writes nothing,
  the checkpoint stays `pending`, and the question reappears next render — still
  once.

`tests/awaiting-one-decision.test.ts` pins the observed shape against the real
stores over a scratch home, including the production wiring: `CommandPost`'s
`awaitingSnapshot` and `awaitingSnapshotSync` read the same split ship
checkpoints and the same pipeline links, and the test asserts the two agree so
the call sites cannot drift. The pipeline link is best-effort by construction —
an absent or unreadable `state/pipelines` costs the *secondary* half of the link
and never the listing, because `Checkpoint.research_id` still carries it.

### One surface at a time

**Two overlays on screen is one overlay too many, and the second one steals the
first one's keystrokes.** Until p18 two independent owners could each reach
`ctx.ui.custom`: the Awaiting-you loop (`runAwaitingDialog`) and the checkpoint
authorizer (`authorizer.ask`). The loop was guarded by `SingleRunLatch`; the
authorizer was guarded by nothing. A wake-up is delivered as
`{ deliverAs: "followUp", triggerTurn: true }`, so a whole turn can run while an
overlay is up — and a turn that calls `cp_pipeline advance` mints the ship
checkpoint and asks about it, over the overlay already there.

pi composites every visible overlay into one stack and focuses the **newest**
(`docs/tui.md` §Overlay Focus), so the two questions overlapped line by line and
only the newest received input. Measured (`docs/tui-verification/pi-command-post-p18.md`):
`↓`+`Enter` aimed at a visible "ship, drop or follow-up?" resolved the *checkpoint*
as `{"approved":false}` — an authorization written by `CheckpointStore.decide`,
which is given once and stays on the record. The defect was never only a dead
dialog; it was an authorization answerable by a keystroke meant for another
question.

**The latch now carries a holder, and every parent-owned overlay surface
acquires it.** `SingleRunLatch.run(surface, body)` records *who* is on screen
and returns `{ran:false, holder}` to whoever loses, and the release stays in the
class's own `finally` so an answer, a throw and the auto-open deadline all free
it. The same one-overlay rule applies to the surfaces themselves.

- **A refused checkpoint ask is T21's "not now", never a decline.**
  `askCheckpointUnderLatch` returns `undefined` and writes nothing at all. The
  checkpoint was written `pending` *before* anyone was asked, so `#authorize`
  returns it, `advance` still reports `state: awaiting_authorization,
  next: "authorize"`, and the row is already in Awaiting you.
- **No queue, because none is needed.** A rendered overlay is a frozen snapshot,
  but the in-flight loop re-snapshots between rounds — and by §One decision is
  one question above, that next `mergeAwaiting` returns the checkpoint row
  *instead of* the research row for the same pair. The question the latch
  refused is the question the next round offers.
- **Nothing is ever closed under the operator.** The fix prevents the second
  overlay; it never takes the first one away. `overlayTimeoutMs` still returns
  `undefined` for `decide` and `checkpoint` — a human typed the first and a human
  is being asked by the second.
- **A surface that loses says so.** `surfaceBusyNotice` is the one wording, beside
  `overlayFallbackNotice`. An auto-open stays silent (nobody asked for it); a
  typed `/cp-decide` and a checkpoint ask name the surface that is open, exactly
  as `ConsoleGate.allowAwaiting` does. Where there is no notify port (headless),
  nothing is lost: the row and the widget marker carry it.
- **Who writes an answer is unchanged.** `CheckpointStore.decide` remains the
  single writer of an authorization, free text is still a note and never a
  verdict, and cp-80cv's data-level dedup is untouched.

**A pager, or any other extension prompt, is not a latch holder.** `/cp-plan`,
T31's worker-question dialog stays off `SingleRunLatch`
— nested `View the plan…` from `/cp-decide` already runs *inside*
`awaitingLatch.run`, so putting the pager on the same latch would refuse itself.
`humanPrompt.open` (set on the coalesced `ui_prompt_start`/`end` span) is OR'd
into the existing busy checks instead: `runAwaitingDialog`'s early return,
`authorizer.ask` in front of `askCheckpointUnderLatch` (still latch-only),
and `autoOpenDecision({ … latchBusy: awaitingLatch.busy || humanPrompt.open })`.
Auto-open stays silent; a typed `/cp-decide` and a checkpoint ask notify with
`promptBusyNotice` and write nothing (`undefined` / T21 "not now"). Stacking a
pager on decide is not p18; stacking an *answering* overlay on a pager is.

The **worker-question dialog** (`asker.ask`, T31) still stacks by the same
mechanism: it renders through `ctx.ui.select`/`input` and is gated by neither
`ConsoleGate` nor this latch. It is a different contract — an unasked question
fails closed to "no answer" and the planner records an unknown — so whether it
should refuse or wait is its own decision, and it is the known remaining stacker.

**A ship job can have two open authorizations, and both are in the table
(cp-khf).** A flagged diff review raises a *second*, post-implementation
checkpoint at `paths.checkpointFile(ship_id, "diff")` — "accept the diff that
was pushed?", asked about code that exists, where the pre-implementation
checkpoint asked "act on this plan?" before any did. They are two **subjects**
under cp-nx7's identity model, never one question asked twice, and the whole
surface treats them that way:

- **two ids.** `checkpointAwaitingId` is the one definition:
  `aw-checkpoint-<ship-id>` and `aw-checkpoint-<ship-id>.diff`. The suffix
  mirrors the file name and is safe for the same reason it is: a job id can never
  contain a `.`, so the diff row of `cp-x` can never collide with the ship row of
  a job legitimately named `diff-cp-x`.
- **two rows, listed together.** `mergeAwaiting` takes `checkpoints` and
  `diffCheckpoints` (one `CheckpointStore` per kind — a `Checkpoint` record does
  not say which question it is, its store does) and derives both, oldest-first,
  with different decision text and different `blocks`. Neither hides the other,
  and `listPending` never crosses the two kinds.
- **two answers, one writer.** The row carries `checkpoint_kind`, and that is
  what `resolveAwaitingResponse` hands `decideCheckpoint` — so `/cp-decide`
  answers the very question it offered. `/cp-authorize` and `/cp-decline` take
  `<job-id>` (the ship checkpoint, unchanged), `<job-id> --diff`, or the row id
  itself; a bare job id never falls through to "whichever one is open", because
  guessing is exactly what an answered-once decision must not do. Every path
  ends in `CheckpointStore.decide` against that kind's own file, which is why
  its refusal to overwrite an answer keeps holding across both.

Before this, the diff checkpoint was reachable only through the authorizer
dialog — a gap, not a stall, and precisely the shape of decision that gets sat
on when the one table that makes an open decision impossible to miss does not
carry it.

**An `authorization` row is the one exception, and stays a pure read.**
`answerResolved` refuses it outright, `materialiseDerived` refuses it, and
`declare` refused it already: an approve/decline answer in `/cp-decide` reaches
`CheckpointStore.decide` and nothing else, so an authorization still has exactly
one record. It leaves the merged set because it is no longer pending, never
because something was written to `state/awaiting.json`.

**Failure is loud, never a silent no-op.** If the underlying job vanished
between the listing and the answer, the write throws with a message naming what
is missing (`no checkpoint for cp-x — nothing was asked…`); a projected row the
schema cannot hold fails at the write instead of being dropped; and the resolver
refuses an answer whose id is not the offered item's id. In every one of those
cases nothing is recorded anywhere — the operator is told, rather than thanked.

Deriving the authorization rows instead of duplicating them is the load-bearing
decision: **there is only ever one record of an authorization**, the checkpoint
file, and `AwaitingStore.declare` refuses the `authorization` type outright, and
refuses any declared decision that `looksLikeAuthorization` (the same T31
pattern) flags — a declared row can never impersonate a checkpoint.

**Answering cites authority (`cp_decide`).** The parent resolves a pending
checkpoint, a held plan approval, or an open Awaiting-you row with `cp_decide`,
provided it cites a mandate id+clause (re-evaluated against the mandate store
at call time; the tool does not trust the caller's claim) or a verbatim operator
quote from a user message in this session (nonempty after the bridge's
`[cp-send]` markers are stripped; a short reply like `yes`, `approve` or
`close dismiss` is enough, but must occur verbatim). Worker text,
envelope text and tool results are never a valid basis. `decided_by` is
`mandate:<id>`, `operator-quote` or `operator-delegated`, and the basis is stored beside the decision.
Delegated answers are audit attribution, not a new authority or refusal: the operator session sends
`cp_parent send` with `delegated: true` and an optional short `delegation_rule` (trimmed, required to
be nonblank when supplied, and truncated to 200 characters including an ellipsis when overlong;
absent uses the generic `operator delegation`). The durable bridge send stamps its marker with the
encoded rule. `cp_decide` reads that marker from the injected user message containing the verified
quote, never from its tool parameters, and records `operator-delegated` plus top-level
`delegation_rule` and `send_id` on escalations, checkpoints and Awaiting records, including linked
records. Each send in a batch retains its own attribution; when text repeats, the latest matching
send wins. A present delegated tag whose rule cannot be decoded or validated remains
`operator-delegated` with `delegation_rule: "unreadable marker"` and its send id; it never blocks
matching a later quote. Untagged sends remain `operator-quote`, and old records need no migration. Operator-text
requirements, including the review-cap final fix, still accept these quotes and record delegation
without adding a new refusal.
Refusals name the fix (`no active mandate covers project X`, `quote not found in
operator messages`, `risk:high requires operator text`). Merge checkpoints need
an operator quote unless the mandate's `ask_on` omits `merge`. `cp_awaiting`
still only `list`s and `withdraw`s. `/cp-awaiting` is the plain-text listing for
a human at a TUI. There is no TUI overlay for decisions.

**Skip records nothing, anywhere.** Not a file write, not a br comment, not a
run-log event. A skipped item simply stays `state: "open"` and is rendered
again next time — dismiss is not an answer, the same rule T21's checkpoint
dialog already keeps. For a derived row this is literal: skip does not even
create the row, so `state/awaiting.json` may still not exist afterwards, and
the next merge re-derives the item unchanged.

**Free text on an authorization item is a note, never a verdict.**
`resolveAwaitingResponse` recognises only approve/decline-shaped text as a
verdict for a `type: authorization` row; anything else is returned as a `note`
and the checkpoint stays `pending` — the operator is told to use
`/cp-authorize` or `/cp-decline` instead.

**br is the audit trail, not the queue.** Answering a declared item with a
`job_id` appends one best-effort `br` comment naming the decision, the answer,
who and when. A failed comment never loses the answer: the write to
`state/awaiting.json` already happened, and the item simply has no
`audit_ref` until a later answer or sync retries it. This is the opposite
trade-off from the operator's first instinct (br as the store) — br has no slot
for a live, multi-item, no-job-required queue that survives br being down, and
the parent's own guard (`ContextGuard`, `BR_INLINING_SUBCOMMANDS`) already
blocks `br show`/`br comments` on an artifact-bearing issue, which is exactly
the "finished research" row that matters most.

**Never blocks the parent on an absent human.** `cp_status_block` never opens a
dialog — it only renders (merging every open item, including ones the model
never mentioned this turn) and upserts what the model *did* pass. The wait
lives entirely inside `/cp-decide`, which the operator invokes; a dialog's
`timeout` (`AWAITING_DIALOG_TIMEOUT_MS`, mirroring `QUESTION_DEFAULT_TIMEOUT_MS`)
auto-resolves exactly as T31's does, so a client that never answers still frees
the loop rather than hanging it.

**Identity is the decision's subject, not its prose (cp-nx7).** A declared row's
id is `sha1(job_id | type | subject)`, and the *subject* is what is being decided
with the prose that describes it stripped away (`decisionSubject`):
parentheticals, a dash-introduced aside and a trailing conditional clause go,
and a PR reference collapses to `<verb> pr#<n>`. So "Merge PR #44 once its
rebase lands green", "Merge PR #44 when CI goes green on cd178f4" and "Merge PR
#44 (rebased) - ANSWER IN CHAT" are **one** row, updated in place. The wording of
an open question changes constantly and legitimately; what is being decided does
not, and hashing the wording is what asked a human the same merge approval three
times under three ids. A caller that can name the subject better than the
derivation does passes `subject` explicitly, and then only that field is
identity; a subject the *caller* gave is persisted, a derived one never is, so
improving the derivation reaches rows written before it.

**One id, one record, and a re-render is harmless.** `declare` is an upsert
keyed by that subject with exactly three outcomes: no such subject creates a
row; an **open** row is updated in place (prose, why, blocks, options — never
the id, never `opened_at`); an **answered or withdrawn** row is returned
untouched. Re-rendering a decision a human already answered is *normal* parent
behaviour under delivery lag — the status block re-declares its open rows every
time it is rendered, and the wake-up carrying the answer may not have arrived yet — so it can
neither reopen the item nor mint a second one. A store that already holds two
records under one id is repaired **on load**, deterministically
(`repairAwaitingItems`): the record carrying a human's answer wins, then a
withdrawal, then an open row, with ties broken on the earliest timestamp and
finally on file order. Every read returns the repaired set and the next write
persists it, so no id-keyed operation ever picks an arbitrary one of two — the
failure that let `withdraw` overwrite an operator's recorded answer. `withdraw`
now refuses an answered item outright: an answer is never withdrawn.

**Durable and visible even when nobody is answering.** Declared items survive a
restart (`state/awaiting.json`, atomic write, validated read); the widget grows
one extra line, `⧗ N decisions awaiting you — /cp-decide`, whenever the merged
open set is non-empty — file-derived, no tokens, never suppressed by a session's
own snooze (only re-*prompting* is). An unreadable derived source renders
`Awaiting you: unavailable (<source>: <reason>)`, never a silent "none".

### Rendered open ⇔ stored open

**A row is rendered as an open question if and only if the store holds it
`open`.** `cp_status_block` used to upsert the caller's rows *and* render them as
two independent steps, so the two could disagree — and they did, for about three
hours: the operator was told three decisions awaited them and `/cp-decide`
offered one. Three refusals reached the table as live rows: `type:
"authorization"` (thrown by `#upsert`), a decision whose prose
`looksLikeAuthorization` ("Authorize the 5 destructive findings…"), and a row the
merge-ask gate stored `deferred`. Only the render was visible to the operator,
so the parent believed it had asked.

[`src/awaiting-rows.ts`](../src/awaiting-rows.ts) is now the single path from the
parent's judgment to the table, and it partitions every supplied row by what the
store actually did with it:

| store outcome | rendered as | answerable |
|---|---|---|
| `open` | a row under **Awaiting you**, carrying the id `/cp-decide` answers | yes |
| `deferred` (§The merge ask) | `Not asked yet — not ready to merge` / `Not asked — CI red`, under the table | no — it is raised automatically |
| refused (throw) | `Not asked — refused by the awaiting store`, with the refusal verbatim | no — it was never stored |
| already `answered` / `withdrawn` | the same refused notice, saying so | no — and nothing was re-asked |

### A declared row does not outlive its job

Declared rows were the one Awaiting-you source with no staleness rule: unasked
wake-ups are staleness-checked, and a derived row clears when its source
condition does (a checkpoint is decided, a PR receipt appears), but a declared
row persisted until answered or withdrawn — through teardown, br close, merge
and a parent restart. On 2026-09-04 the operator was asked at 18:52 whether to
merge PR #111, merged at 18:45 with br cp-gb3w closed, and answered "this is
obsolete".

The mechanism is **obsolete-on-read**, not a retire pass and not a store field:
`obsoleteDeclaredReason` ([`src/awaiting.ts`](../src/awaiting.ts)) is a pure
predicate over the same fleet snapshot every surface already reads. A declared
row is not offered as open when its `job_id` names a job that is `phase: "done"`,
closed in br, or carries a **merged** PR receipt. `mergeAwaiting` (so
`/cp-decide`, the auto-open surface and the widget) drops it; `resolveAwaitingRows`
refuses it before the store is touched, so the status block prints the reason
under the table instead of a question.

It fires on evidence, never on ignorance: a row with **no `job_id`**, or one whose
job the snapshot has no record of, is untouched and still answerable — silently
dropping a still-meaningful decision is worse than the bug. Nothing is written,
so an answered row and its journalled answer are unaffected, and skip semantics
are unchanged (a skip still writes nothing and a still-valid item still
reappears).

**The rules did not move; only their silence did.** `type: "authorization"` is
still refused outright (only a checkpoint authorizes, and the status block writes
one by no path), and `looksLikeAuthorization` still fires. What changed is that
both refusals now *reach the parent*, in the tool result, the way every other
refusal in this system does — and they name the fix: `authorizationTrigger`
quotes the exact wording that fired and the message says what to write instead
("Ship cp-x, drop it, or open a follow-up?"), because discovering the trigger
word by experiment cost three attempts.

**A store that cannot write is a refusal, not an unanswerable row.** The old code
warned and rendered the row anyway; an unwritable `state/awaiting.json` therefore
produced exactly the question nobody could answer. Louder and correct beats
degraded and wrong here: the row prints as refused with the write error attached.

### The merge ask

**A merge approval is never asked while that PR's CI is still running for its
current head.** The parent used to ask anyway, bank the answer and wait: #42 and
#44 were approved while their runs were unfinished, and #47 was approved twice,
six minutes apart, because the question outlived the state it was asked in. An
answer that cannot be acted on when it is given is a premature ask, and it is
now refused by construction rather than discouraged in prose.

**"CI has finished" is the check the parent already runs before every merge**,
promoted from a merge precondition to an *ask* precondition
([`src/merge-ask.ts`](../src/merge-ask.ts)): a completed run exists for the
branch **and** that run's `headSha` is the branch's current pushed head. A
completed run on a superseded sha says nothing about the commit that would
merge, so it does not count. (`gh pr checks` 403s in this home;
`gh run list --branch <b> --json conclusion,status,headSha` is the query, issued
once per render — never the poll shapes [`src/ci-wait.ts`](../src/ci-wait.ts)
refuses.)

**The gate lives where the row is created, not in the render.**
`AwaitingStore.declare` is the choke point, so a premature ask cannot exist even
if something else renders it — the failure that displayed an unpersisted row for
45 minutes (§Awaiting you) cannot recur through this path.

| CI for the current head | verdict | row state | what the operator sees |
|---|---|---|---|
| completed, green, and `cp_review`-passed on that head | `raise` | `open` | the ask |
| queued / in progress, or no run on this head yet | `defer` | `deferred` | `Not asked yet — not ready to merge`, plus the reason |
| completed, not green | `refuse` | `deferred` | `Not asked — CI red`; merging red is forbidden, so the failure is surfaced instead of a merge prompt |
| not determinable | `defer` (`ci: unknown`) | `deferred` | `Not asked yet`, with the reason attached (cp-1som) |
| green, no passing review on that head | `defer` (`ci: unreviewed`) | `deferred` | `Not asked yet`, naming the head to review (cp-1som) |
| the job itself is gone | `orphaned` (`ci: job_gone`) | `deferred` | `Not asked — the job is gone`; answer or withdraw it with `/cp-decide` |
| the merge already happened | `resolved` (`ci: already_merged`) | `withdrawn` | `Not asked — already merged`; the row is closed, reported once |

**Ignorance defers, it does not raise (cp-1som — reversing the original rule).**
The first version of this gate raised on an unreadable CI state, reasoning that
deferring on ignorance would turn "we could not reach the API" into "the
operator is never asked". In practice it produced the failure the gate exists to
prevent: the parent passed a ship row **at envelope time**, when no run had
started on the pushed head, so the row was raised on `ci: unknown`, the operator
answered "ship", and `cp_integrate` then found CI `in_progress` — three times in
one session (PRs #117, #118, #119). A row that names *ship* rather than *merge*
reached the table by the same path, because the classifier only knew the word
"merge".

Both halves are now closed. `isMergeAsk` counts "ship"/"shipped"/"shipping"
alongside "merge" **when the row also names a PR**, so "Ship cp-dlw7 (PR 119),
drop it, or open a follow-up?" is a merge ask; and every not-determinable state
— unreachable `gh`, no runs yet, no pushed head, a row with no `job_id` — is
`defer` rather than `raise`. Deferring is not losing the question: the row is
stored, printed under the table on **every** render, re-reviewed by
`reviewDeferred` on every render, and woken by the `cp-ci` watch when a run
finishes. Asking early is the irreversible half — the answer is spent on a head
nobody has read — so this asymmetry now runs the other way.

**Green is necessary, not sufficient: the head must also be reviewed (cp-1som).**
Every `delivery:pr` job gets a `cp_review` per pushed head (AGENTS.md §Fan out),
and a `revise` moves the head, so a review of a superseded diff says exactly as
little as a green run on a superseded sha. When the caller can supply the heads
a review has **passed** on — `state/runs/<job-id>/review-<n>.json`, `verdict:
"pass"`, a local file this home wrote — the gate requires one for the current
head and defers with `ci: "unreviewed"` otherwise. What clears it is the
passing review itself: a `pass` → `proceed` verdict re-gates the deferred rows
as it is delivered (§The deferred-row recheck is runtime), which is where
`reviewDeferred` finds the row now reviewed and raises it — no render, and no
parent turn, in the path. The fact is optional in
`evaluateMergeAskCi`: `readCiForHead` never passes it. `cp_integrate` has its own
review gate before merge (`readReviewPassVerdict` on the current head), independent of this ask.

**The ship/drop row for finished research is out of scope.** "Ship cp-x, drop
it, or open a follow-up?" for research with no PR names no PR number, has no
branch head and no CI to read; gating it would defer a question nothing could
ever raise. Naming a PR is what makes a ship row a merge ask.

#### Both new deferrals are unbounded, and that is the product

Neither `unreviewed` nor `unknown` has a timeout, a retry budget or an escape
hatch, and neither should grow one. A deferred row is not a lost row: it is in
`state/awaiting.json`, returned by `list("deferred")`, printed under the status
block's table on **every** render, and re-run through the gate by
`reviewDeferred` each time. What each case is waiting for is a fact somebody
produces, and the row raising itself on the *absence* of that fact is the
incident this section exists to prevent.

**The review pass is read from the review store `cp_review` already writes.**
No second store exists and none should: `DiffReview.#persist`
([`src/diff-review.ts`](../src/diff-review.ts)) validates a `DiffVerdict`
against `DiffVerdictSchema` and writes it to `paths.reviewFile(jobId, attempt)`
(`state/runs/<job-id>/review-<n>.json`), and `readReviewPassHeads`
([`src/merge-ask.ts`](../src/merge-ask.ts)) reads *that* path with *that*
schema, taking `head_sha` from every verdict whose `verdict` is `pass`. Sharing
the schema is what makes a field rename impossible to get half-done: the writer
refuses to write a verdict the schema does not accept, the reader refuses to
count one, and `tests/merge-ask.test.ts` round-trips a schema-validated verdict
through the same path function so a mismatch fails a test rather than silently
deferring every merge ask. The reader looks at **every** attempt slot up to
`REVIEW_MAX_ATTEMPTS` rather than stopping at the first missing file: it is
asking "did any review pass on this sha", not "how many attempts has this branch
spent" (which is `readPriorAttempts`' question, and where a contiguous prefix is
the right answer).

**A deferral has to be releasable — and one shape was not.** Every ready fact is
resolved through the job's fleet record, and the CI/PR watch iterates fleet
records, so a merge ask with **no `job_id`** could never be released by
anything: no branch, no head, no runs, no review, no watcher pass that would
ever look at it. Such a row is now **refused before it is stored**
(`MERGE_ASK_NEEDS_JOB_REFUSAL`), printed under the table as refused with the fix
named (re-pass it with the job it concerns), and never minted as a deferred
zombie. This is the opposite of an escape hatch: nothing is asked about an
unready PR, and no row is created that a human would have to withdraw by hand.
A row stored before this refusal existed is left exactly where it is — still
listed, still printed, answerable or withdrawable through `/cp-decide`.

A branch with **no pushed head** is a different case and is releasable, so it
keeps deferring: the job exists, the watcher asks the remote for that branch's
head every tick, and the moment the branch is pushed the head resolves, CI runs
and the `cp-ci` wake-up re-gates the row.

**`unreviewed`: a job whose current head has never been reviewed never raises a
merge ask.** That is not a gap in the design — it is the design. `cp_review` is
mandatory for every `kind:ship` `delivery:pr` job, once per pushed head
(AGENTS.md §Fan out), and running it is the parent's job, not the operator's and
not the worker's. So "nothing makes the review exist" has a named actor: **the
parent runs `cp_review <job-id>`**, the pass lands in
`state/runs/<job-id>/review-<n>.json`, and the verdict that wrote it re-gates
the row on the spot (§The deferred-row recheck is runtime), with no render and
no operator action. There is deliberately **no ask-without-review path**: one
would make the mandatory review optional in the exact moment it is load-bearing,
which is the moment a human is about to say "ship it". A PR that sits deferred
for want of a review is a PR nobody has read, and the fix is to read it.

**`unknown`: an unreadable CI state waits for a fact, never for a clock.** The
recovery path is already built and requires nothing new: [the CI/PR
watch](#the-cipr-watch) queries GitHub for the branch's current head on
its own timer, and the observation it produces re-runs this gate over every
deferred row before it wakes anybody (§The deferred-row recheck is runtime).
Where observability recovers with nothing to announce — no `cp-ci` tick observes
a change, and no review verdict lands — the fallback is an **explicit**
`cp_status_block` invocation by the parent (the block is opt-in, so this one is
deliberate), and that render re-runs the same gate. What is not offered — and must not be added — is a bypass
that asks anyway after N attempts or M minutes: `gh` being unreachable is not
evidence that a head is mergeable, and an answer given on that basis is spent on
a commit nobody has read. `cp_integrate` has its own, narrower fallback for the
different case of a CI state it **cannot read at all** (§Integration), and that
one mints a human checkpoint rather than a merge ask — a human deciding with
the absence of evidence in full view, which is not the same thing as a question
raised as though the evidence existed.

One case is not ignorance and is therefore not deferred: a repository that
**positively reports no workflows** (`ciConfigured: "none"`, established by
`readCiConfigured`, never inferred from zero runs) will never produce a run, so
the row raises with `ci: "no_ci"` once this head has a passing review. That is
the same distinction §Integration draws, applied here so a project with no CI
does not defer its ship row forever waiting on an event that cannot happen.

**A deferred ask is durable, and it comes back by itself.** `deferred` is a real
`AwaitingState`, persisted in `state/awaiting.json`: it is not open (not
rendered as a decision, not counted by the widget marker, not answerable) but it
is not settled either. `AwaitingStore.reviewDeferred` re-runs the gate over
every deferred row on every render of the set (`awaitingSnapshot`,
`cp_status_block`) **and on the two events that can release one** (§The
deferred-row recheck is runtime), promoting the ones whose CI has finished green
— no operator action, and no dependence on the parent remembering to re-ask,
because `cp_status_block` folds a row promoted this turn into the table even if
the model never mentioned it. A row that is deferred and never promoted is still
printed under the table on every render, so "deferred" can never decay into
"silently dropped".

### The deferred-row recheck is runtime

**A row is released by the event, not by a turn.** Both render call sites above
run *inside a parent turn*, and the files-only `awaitingSnapshotSync()` the
widget tick calls cannot promote anything (it is synchronous, and `gh` is a
subprocess). In an idle session there is no turn at all, and since the status
block became opt-in (§The status block is opt-in) even a woken parent might not
render one — so "the row appears later, with no operator action" rested on a
model following AGENTS.md prose. It is now code:
[`src/deferred-recheck.ts`](../src/deferred-recheck.ts), wired in
`extensions/command-post/index.ts` at exactly two places.

| event | where it is wired | what it releases |
|---|---|---|
| a `cp-ci` observation for a held PR | `surfaceCi`, awaited before the wake-up is sent | a `CI still running` / `superseded` deferral whose head has just gone green, and a row whose PR merged (`already_merged`) |
| a `cp-verdict` for `surface: review` with `next: proceed` | `ReviewRuns`' `beforeWakeup` hook, awaited between `finish` and `#send` | a `green but unreviewed` deferral — the verdict file is on disk by then, so the re-gate reads the pass it is about |

**The row is open before the parent is woken, and that ordering is the point.**
A fire-and-forget recheck on the delivery path would have raced the message it
belongs to: the parent could read "cp_review passed on cp-x" with the merge row
still deferred, which is the same invisible decision this job set out to remove,
only narrower. `WakeupPort` is synchronous and reports only whether the
transport accepted a message, so the seam is a separate awaited hook
(`ReviewRunsOptions.beforeWakeup`, plumbed through `CommandPostOptions`), run
after the decision is on disk and before `#send`.

**And the wait is bounded, because "before" must never become "instead of".**
Both callers are things that have to keep going — a timer tick carrying the
`cp-ci` notice and wake-up, and a verdict delivery holding an attempt's slot —
so each bounds the re-gate with the same helper the suggestion path uses
(`withDeadline`, `src/suggest.ts`) and the same convention as
`HANDBACK_MAX_WAIT_MS`:

| bound | value | protects |
|---|---|---|
| `DEFERRED_RECHECK_MAX_WAIT_MS` (`src/deferred-recheck.ts`) | 30s | the watch tick: `recheckDeferredBounded` never throws and never outlives it, so the notice and the `cp-ci` wake-up follow either way |
| `BEFORE_WAKEUP_MAX_WAIT_MS` (`src/review-runs.ts`) | 30s | the verdict: a hook that throws, rejects **or never settles** cannot pin the slot or swallow a decision already on disk |

The guarantee is therefore conditional and says so: **when the re-gate finishes
in time, the row is open before the wake-up; when it does not, the wake-up is
delivered anyway and the failure is reported in one bounded line** (a `warning`
notice on the `cp-ci` path, `onBeforeWakeupFailure` plus a
`cp:verdict_wakeup_sent` marker on the reviewer path). A hook is an ordering
guarantee, never a veto.

**A deadline stops a wait; it does not cancel work, and it does not throw away
news.** The work under the bound is a `gh` query and a queued write, so there is
nothing to cancel — which leaves two facts to keep straight, and the contract is
both of them:

- **The deadline itself opens nothing and announces nothing.** Only
  `AwaitingStore.reviewDeferred` opens a row, and at the deadline it has not
  finished, so every deferred row is still deferred: a later ask, never a wrong
  one. That is the fail-closed half, unchanged.
- **An *evidenced* late completion may open and announce.** If the slow re-gate
  finishes afterwards and the gate opens rows on its ordinary terms (green on
  the current head, reviewed, not merged), those rows reach the operator through
  `onLate` — the **same continuation** the in-bound path uses
  (`announceRaised`, shared by both events), so a decision that became
  answerable is announced exactly once, with one repaint, whichever timing it
  arrived on. Dropping it would recreate the defect this whole change removes,
  one bound later.

A late *failure* is silent: the deadline already printed one bounded line about
that call and a second would be a duplicate. It is awaited rather than
abandoned — the inner promise is built so it can never reject — so no path here
leaves an unhandled rejection. An in-bound completion never takes the late path
at all: `onLate` fires only when the timeout branch actually ran.

**The payload is parsed defensively, and never assumed.** The wake-up crosses a
transport boundary, so `isPassingDiffReview` takes `unknown`: absent, null,
non-object or foreign `details`, a `next` of the wrong type, a `verdict` that
contradicts `next` — each is `false`, none throws, and none re-gates anything.
The two fields it reads are the ones `DiffReview.finish` writes (`surface`, and
`details` = the `DiffReviewResult`, whose `next` is `nextAction(verdict)`), and
the tests build that payload with `DiffReview.finish` itself rather than with a
hand-written stand-in that could drift.

Four more properties, and each is a refusal of an obvious alternative:

- **The gate is not duplicated.** `AwaitingStore.reviewDeferred` remains the
  only writer and the only rule; this module decides *when* to call it, never
  *whether* a row is ready. Red stays refused, an unfinished run stays deferred,
  a job that is gone stays orphaned, and a row with no `job_id` is still refused
  at declare time.
- **Ordinary turns stay quiet.** Only those two events re-gate anything: a
  widget tick, an envelope, a wedged call, a plan-gate verdict, a quality
  verdict and a `revise` do nothing at all — not even a CI query
  (`releasesDeferredAsks`).
- **A row opens exactly once**, including when both events land at once.
  `reviewDeferred` only ever flips rows still in `deferred`, and it decides that
  **inside** `#mutate` — which runs under the per-real-path mutation queue
  (`queued`, `src/json-store.ts`) and re-reads the file there. So two overlapping
  rechecks that both read the row as `deferred` and both compute `raise` still
  produce one promotion, one notice and one durable row: the loser's mutator
  sees the row already `open` and skips it. This is pinned by a barrier-driven
  regression (`tests/deferred-recheck.test.ts`) that holds a `cp-ci` recheck and
  a `beforeWakeup` recheck inside their CI query until both are past the read,
  releases them together with a third unrelated writer on the same file, and
  asserts one raise, one notice, no lost row and a file that still parses and
  validates. Deciding `raised` from the pre-mutation snapshot instead fails that
  test, which is what makes it evidence rather than decoration.
  Under a concurrent read failure (`gh` down in both racers) nothing is raised
  at all and both rows survive intact — the fail-closed direction — and the next
  event raises the row once.
- **Nothing is rendered.** The recheck opens the row and, when one opens, emits
  one bounded notice and repaints the widget marker. The status block stays
  opt-in, and its manual invocation stays the fallback for the `unknown` CI
  state, which no event announces.

The watcher still never calls `reviewDeferred` itself and does not know this
gate exists: the extension is the seam, which is what keeps `src/ci-watch.ts`
free of any awaiting concept.

**Identity is cp-nx7's, unchanged.** A deferral is keyed on the decision's
subject (`{job_id,type,subject}`), so deferring the same decision twice — with
the facts of the moment reworded into the prose each turn — updates one row, and
when it is finally raised there is exactly one item to answer.

**The gate governs raising, never retracting.** It runs only for a row that does
not exist yet or is already `deferred`. Once a question is open the operator can
see it, and a new push that restarts CI does not withdraw it: un-asking a
visible question is its own kind of lost decision. An answered or withdrawn row
is returned untouched, exactly as before.

**A row whose job is gone is neither raised nor destroyed (cp-to39).** "We
cannot read CI" and "there is no job to read CI for" are different facts, and
before this they were the same catch-all: the probe resolves its facts through
the fleet record, so a torn-down job made `deps.head` throw, the catch-all
returned `raise`/`unknown`, and `reviewDeferred` promoted it — an unanswerable
merge ask for a PR whose job no longer exists, with `no fleet record for <id>`
as its reason. The cause is now explicit and structural
(`MergeAskJobGoneError`, `isJobGoneError`), never a string match on an error
message: only the missing *fleet record* raises it, while a missing clone or an
unreachable `gh` stays `ci: "unknown"` (which since cp-1som defers rather than
raises, and is still not this cause). On that
cause — and only for a row that already exists as `deferred`, because a merge
ask *declared now* for a job the fleet does not know is the ignorance case,
which defers with `ci: "unknown"` — the row stays `deferred` with a reason naming the job, is still returned
by `list("deferred")` and is printed under the table as its own notice. Nothing
is expired, withdrawn or deleted — `state/awaiting.json` has no journal, so an
expired row would be an unrecoverable lost question; withdrawing is the
operator's call, through `/cp-decide`.

**A deferred ask whose merge already happened is closed, not asked (cp-p1sh).**
A deferral had exactly one exit — CI finishing — so a PR that merged *while its
row was deferred* still raised the row afterwards, asking the operator to
approve a merge whose commit already existed (cp-rud / PR #69, cp-n1a / PR #70,
both withdrawn by hand). Since `cp_integrate` merges on repo-derived authority
without consuming an operator turn, that is the ordinary path, not an edge case.
The gate now reads one **local** fact first, before any fact that needs a clone
or the network: the job's merge receipt (`state/runs/<job-id>/merge.json`), which
is written only for a PR `gh pr view` itself reported as `MERGED`
(`src/merges.ts`), so it is an observation rather than a claim and costs the
render path no network call. On that evidence the verdict is `resolved` /
`already_merged` and the row is moved to `withdrawn` — the state that already
means "this decision is no longer needed" — with the reason kept on the row in
`deferred_reason` so the disposition is readable afterwards. Nothing is deleted,
no answer is invented on a human's behalf, and it is reported once under the
table and then gone, because a closed row is not re-rendered.

The scoping is the same discipline as the two rules above. The match is
structural — PR number against the receipt's PR number (its `pr_number`, or the
number in its `pr_url`), never prose — so a receipt for another PR resolves
nothing. Two absences are deliberate: a row that names no PR is resolved by its
own job's receipt, and a receipt that names no PR number still resolves a row
that names one, because the receipt was looked up *by that row's job id* and is
this job's merge either way. **A settled row is never closed by this cause:** the
gate runs only for a row that does not exist yet or is `deferred`, and the
transition itself refuses anything that is not `deferred`/`open`, so a recorded
answer (or a human's withdrawal) survives a re-declaration of the same decision
untouched. **Absence of a receipt is not evidence:** no
receipt, an unreadable one or a contract-violating one all fall straight through
to the CI rule, so an unreadable merge state is never read as "merged", genuinely
unfinished CI still defers and red CI still raises no ask at all. Only a row that
is `deferred` (or a merge ask being declared for the first time) is ever touched:
an answered row, another deferred row, a `job_gone` row and an
authorization-derived projection are all left exactly as they were.

**A stale base is deliberately NOT gated here.** The parent also verifies, before
merging, that a branch is not built on a superseded base, and both conditions
caused the repeat prompts this rule came from. It is excluded on purpose, and
the reason is asymmetry: CI is a wait nobody can shorten, so asking during it
wastes the operator's answer, while a stale base is fixed by a rebase the parent
can order on its own without asking anybody. Deferring on a stale base would
make the ask wait on work the parent has not started yet. A rebase also moves
the head, which re-enters *this* gate through the front door, so the CI rule
already covers the dangerous half of it. If the repeat prompts persist for
base-staleness alone, that is a separate change with its own issue.

### An answer wakes the parent

Recording an answer is not delivering one. The operator answered an item through
`/cp-decide`, `state/awaiting.json` held the id, the type, the answer and the
timestamp — and the parent's turn was never invoked, so the work that decision
unblocked simply sat there. That is the same defect as an envelope that reaches
nobody, and it gets the same fix, not a poll.

**An answer is a message.** Every *newly recorded* answer reaches the parent as
a `cp-answered` custom message (`deliverAs: "followUp"`, `triggerTurn: true`),
carrying the id, the type, the `job_id` if there is one, and the answer text —
enough to act on without re-reading a file, and never a body. `formatAnsweredNotice`
says out loud that an approved authorization is permission to act, because an
approved-then-stalled pipeline is the failure mode this bug creates for shipping.

**Every source, not just the one that broke.** The sink is injected into the two
writers, so there is still exactly one writer per decision and no new one:

| source | writer | wake-up |
|---|---|---|
| declared row (`cp_status_block`, `/cp-decide`) | `AwaitingStore.answer` | `cp-answered` |
| derived approval (held research, no PR) | `AwaitingStore.answerResolved` | `cp-answered` |
| checkpoint authorization (`/cp-authorize`, `/cp-decline`, `/cp-decide approve`, the authorizer dialog) | `CheckpointStore.decide` | `cp-answered` |

**Queue first, deliver second** ([`src/answered.ts`](../src/answered.ts)). The
answer is already on disk when the sink runs; the sink appends it to
`state/answered.json` `pending`, and delivery is a *drain* the live parent
performs on three triggers it already has — the answer itself, `session_start`,
and the widget tick. Nothing polls. A send that throws leaves the queue intact
and is retried on the next drain, so an answer given with no parent attached (a
headless `/cp-authorize`) is delivered late rather than lost.

**Sent is not delivered (cp-nx7).** `pi.sendMessage` queues a `followUp` that pi
hands to the parent on some later turn — minutes later, when the fleet is
producing wake-ups faster than the parent takes turns. Stamping `delivered_at`
at that hand-off made a four-and-a-half-minute lag read as an instant delivery,
and made a message that never arrived indistinguishable from one that did. So
delivery has two steps and only the second writes `delivered`:

- `drain(send)` sends every **due** answer, coalesced into one message with
  every due id present — never one message per answer — and records the
  emission. Nothing is marked delivered.
- `confirmDelivered(ids)` is called by whoever **observed** the message land in
  the parent's context (the extension's `message_start` and `context` hooks,
  reading the ids back off the message with `answeredIdsFromMessage`). That is
  the evidence, and it is the only thing that stamps `delivered_at`.

An answer whose wake-up is not observed stays `pending` and is sent again once
`ANSWERED_DELIVERY_RETRY_SECONDS` (120) have passed. **Losing an answer is worse
than repeating one**, so the retry exists and the notice tells the parent to
check the fleet before acting — a late wake-up may describe something already
done. `AnsweredOutbox.stats()` exposes queue depth, in-flight count, emissions
and oldest-pending age, so lag is a fact rather than an inference. *In flight*
means emitted **and still inside its retry window**: an emitted answer whose
window has expired is due again, and due is not in flight.

#### One answer, one delivery

A repeat is a defect, not a feature. One merge authorization
(`aw-checkpoint-cp-ehsc.merge-f7b8769f0606`) was delivered to the parent **three
times**, each copy reading as fresh news and each saying "approved means
dispatch it"; by the third the PR was merged, the receipt written, the head
deleted and the br issue closed. Nothing bad happened only because
`cp_integrate` is idempotent — a replayed authorization for a deploy, a
dispatch or any non-idempotent step would have been executed once per copy.
Two independent defects produced it:

- **The arrival evidence could not name the id.** When a message reaches the
  parent without its `details`, `answeredIdsFromMessage` falls back to reading
  ids out of the notice text — and its pattern stopped at the first `.`. Every
  scoped checkpoint row (`aw-checkpoint-<job-id>.diff`,
  `aw-checkpoint-<job-id>.merge-<head>`) was therefore **unconfirmable**: it was
  read as its unscoped prefix, matched nothing pending, stayed `pending`, and
  was re-emitted every retry window for as long as the session lived. An
  arrival observer that cannot recognise an id is an outbox that never stops
  repeating it.
- **A drain re-sent everything pending whenever anything was due.** Two answers
  three seconds apart meant the first went out again inside its own retry
  window, bundled with the second. A window that is ignored whenever something
  else is due is not a window. Only *due* answers are emitted now.

**The emission is recorded before the message is emitted**, on disk
(`sends: [{id, sent_at, attempts}]` in `state/answered.json`), not in memory
afterwards. So a crash between the record and the transport costs **at most one
repeat** (the record is there, the answer is still pending, the window applies)
and a restart no longer re-emits what a dying session had already emitted. A
`send` that *throws* is observed non-delivery, so that record is rolled back and
the answer is due again immediately — the honest degradation for "there is no
live parent right now". The rollback is **per id, never a whole-array restore**:
`send` is arbitrary caller code and the extension's own drain is re-entrant
through `onAnswered`, so undoing a snapshot of the array would erase an emission
this drain never made. Each id goes back to exactly the entry it had, or to
nothing — and a restored entry is always an expired one, because an entry inside
its window would not have been drained. An answer that was never emitted at all
has no record, which reads as due: under-delivery is not reintroduced, and the
fail-safe direction is preserved at every step. The `sends` key is optional in
the schema, so an outbox written before cp-5mgg reads as "never emitted" and its
answers go out on the first drain.

#### A dead session's reservation is not this session's

That emission record is a **reservation**, and a reservation only means
something while the process that made it is still there to be woken. An answer
emitted by a parent that then died was handed to `pi.sendMessage` as a
`followUp` into a context that will never take another turn — so the successor
session inherited the reservation, left the answer alone, and the operator's
`/cp-decide` answer sat undelivered until `ANSWERED_DELIVERY_RETRY_SECONDS`
(120s) expired and a widget tick resent it. The answer was never lost (it was on
disk before anything was sent); the *wake-up* was two minutes late, and the
parent read as stuck.

So an emission records **who made it**: `sends: [{id, sent_at, attempts,
owner}]`, where `owner` is the emitting process (its pid plus a per-process
nonce, because pids are reused). Dueness is then a question about ownership as
well as time — an answer is due when nothing has been emitted for it, when its
last emission was made by **another** process, or when its own process's
emission is older than the window. The reclaim needs no new trigger and no new
state: it happens at the first drain a new parent performs, which is
`session_start`, so a restart replays immediately.

**One owner per process, not per module instance.** The token is anchored on
`globalThis` (`Symbol.for("pi-command-post.answered.owner")`), because the
property it has to hold is about the *process*: a second instance of
`src/answered.ts` in one process — a differently-specified import, a `?query`
suffix, two copies on disk — would otherwise mint a second nonce, and each half
would read the other's in-flight emission as a dead session's and re-emit it
inside the retry window. That is the cp-5mgg duplicate, reintroduced by the
fix's own mechanism, so it is pinned by a test that imports the module twice.

Everything the two earlier fixes established is preserved, and each for its own
reason:

- **The answer is durable either way.** `enqueue` runs after the real writer
  (`AwaitingStore.answerResolved`, `CheckpointStore.decide`) has recorded the
  decision, so a crash at any point costs a wake-up's timing, never a decision.
- **Acknowledged is acknowledged.** Only observed arrival stamps `delivered`,
  and a delivered answer is not `pending` — so no reclaim can reach it, and
  `enqueue` still refuses its id. Exactly-once by id survives the restart.
- **Within one session the window still bounds repeats** (cp-5mgg): the owner
  is the *process*, not the session file, so a second `session_start` in one
  process (a reload, a re-entrant lock acquisition) keeps its own reservations
  and cannot emit twice. What is reclaimed is only a record no live process owns.
- **Authorizations keep their single writer.** Nothing here decides anything:
  the reclaim changes when a `cp-answered` message is emitted, never what it
  says, who may answer, or what an answer authorizes.
- **Staleness is unchanged.** `cp-answered` is still never withheld for the
  answer, and a replayed copy carrying only already-delivered ids is still
  rewritten as a replay notice by `reviewWakeups` — the defence below, which a
  faster replay does not weaken. Durable wake-ups (`cp-death`/`cp-bound`/
  `cp-recovery`) have the same defence, keyed on `details.durable_id` (cp-ze1t).
- **An unowned record reads as somebody else's**, so an outbox written before
  this field is reclaimed once on the first drain after the upgrade. Under-
  delivery is the failure this module exists to prevent; that is the direction
  every unknown resolves in.

#### Only the home's owner consumes the outbox

The reclaim above answers "whose reservation is this?" with the emitting
process. The same question has a second half: **which session may consume the
outbox at all?** One parent per home is already a contract
(`state/parent.lock`), and the answered outbox is fleet state like any other, so
its consuming surfaces are gated on holding that lock:

- `CommandPost.drainAnswered` — every trigger the extension has (the answer
  itself, `session_start`, the widget tick) and every manual or slash path that
  reaches them (`/cp-decide`, `/cp-authorize`, `/cp-decline`, a headless
  re-entry's writers).
- `CommandPost.confirmAnswered` — the arrival observer on `message_start` and
  `context`.

A session whose `acquireParentLock` was **refused** therefore reserves nothing,
emits nothing and acknowledges nothing: it cannot burn a reservation on a
context the real parent will never see, and it cannot stamp `delivered` for a
wake-up that landed in its own transcript instead of the owner's. Both surfaces
return empty and mutate not one byte, which is the fail-closed direction — the
answer stays queued for whoever does own the home.

**Recording is not consuming, and is deliberately not gated.** `enqueue` runs
after the real writer has already recorded a human's decision, and a headless
`/cp-authorize` in a `pi -p` re-entry (which by definition does not hold the
lock) must still queue its answer durably — that is the whole reason this is an
outbox and not a callback. Single-writer authorization, exactly-once by id and
the staleness guards are untouched: this gate only decides *who drains*.

The check is the lock **file**, read per call (`holdsParentLock`), not a
variable set at startup: a lock reclaimed under a still-running session flips
the answer immediately, and unreadable or absent both read as "not ours".

#### Who owns the parent's "working…" row

The operator-facing half of the same report — "the session looked busy" — is a
surface **this package does not own**, and the ownership is worth stating
exactly rather than assuming.

- **pi owns it.** The busy row is a status indicator in pi's interactive mode
  (`dist/modes/interactive/interactive-mode.js`): shown on `turn_start` when
  `workingVisible`, re-shown while `session.isStreaming`, cleared on
  `agent_end`. It follows the parent's own agent run and nothing else.
- **The only extension handles on it** are `ctx.ui.setWorkingVisible`,
  `ctx.ui.setWorkingMessage` and `ctx.ui.setWorkingIndicator` (plus
  `ctx.ui.setStatus` for the footer). The command post calls `ctx.ui.setWorkingVisible`
  **only** from `applyPromptWorking` on the coalesced `ui_prompt_start` /
  `ui_prompt_end` span: hide the row while an extension prompt is up, restore it
  when the span ends. It still does not call `setWorkingMessage` /
  `setWorkingIndicator` / `setStatus`. The row still follows pi's turn; this
  write only hides it while pi reports `reason: "ui_prompt"`. A session that
  never opens a prompt still issues no `setWorking*` request — asserted at the
  production boundary in `tests/answered-restart.test.ts`. It reads
  `ctx.isIdle()` in exactly one place (deferring an answer card until the parent
  is not streaming), which is a read and never a write.
- **Nothing rendered reads this outbox.** `/status` and the widget derive
  `working` from an **alive worker with a `working` run phase**
  (`assembleStatus`, whose `StatusFacts` contain no outbox at all), and the one
  in-flight number this home computes, `AnsweredOutbox.stats()`, is now
  per-parent by the ownership rule above.

So an inherited reservation could never *paint* a parent as busy. What it did
was the opposite: leave a parent **idle** with an answer waiting, which is what
"it looked stuck" describes. The reconciliation available here is therefore the
turn itself, and that is what the boundary test asserts: on a home holding a
dead parent's reservation, a real pi session emits the wake-up on its first
drain, pi takes an actual turn on it (a model request is made) and the arrival
observer stamps it `delivered` — all well inside the 120s window, so a
regression fails the test by waiting the window out.

**The last line of defence is at delivery, not at send.** `reviewWakeups`
(§[Wake-up staleness](#wake-up-staleness)) recognises a `cp-answered`
message carrying **only** ids an earlier `cp-answered` in the same context
already carried, and replaces it with a replay notice that names them and drops
the instruction to act. That is a property of the conversation, so it needs no
cache and cannot outlive the delivery it describes; a first copy is never
touched, and a copy carrying any unseen id travels whole. "`cp-answered` is
never suppressed" is about the *answer*, which is still true: what is withheld
is only the second and third instruction to act on a decision already acted on.

**This and [Wake-up staleness](#wake-up-staleness) are orthogonal, and
they compose in that order.** cp-nx7 owns *when a message counts as delivered*
(on observed arrival, never at enqueue) and cp-p6m owns *what a message is
allowed to say* (a stamp, re-checked against disk at send and again in the
`context` hook). So: nothing in the staleness path marks anything delivered,
nothing in it drops an id out of a coalesced batch, and `details.answered` — the
arrival evidence — travels untouched beside `details.cp_wakeup`. The shared
`context` hook confirms arrival from the messages **as they arrived**, before
any review can rewrite one. And `cp-answered` is the one kind staleness never
withholds, precisely because the failure mode on this path is a lost decision.

**Exactly once, by id.** `delivered` is persisted, which is what stops a restart
replaying yesterday's answers as fresh wake-ups — deliberately the opposite of
`WedgedWatch`'s in-memory memory, because a still-wedged call is news again to a
fresh session and an answer that already woke somebody is history. Since cp-5mgg
"in flight" is persisted too, for the same reason: an emission a dying session
made is still an emission, and a restart that forgets it is a restart that
repeats it. Both writers report only an answer they actually recorded (an
idempotent repeat returns early), and `enqueue` refuses an id that is already
pending or delivered: answering twice never wakes twice.

**Skip still writes nothing and wakes nobody.** It never reaches a writer, so
there is nothing to queue — `state/answered.json` may not even exist afterwards.
Free text on an authorization stays a note, never a verdict, and a note is not an
answer, so it is not a wake-up either.

### Auto-open on settle

The marker and `/cp-decide` are still the whole surface for every mode but
one: in a real interactive TUI, `pi.on("agent_settled", …)` opens the *same*
dialog `/cp-decide` opens — same resolver, same answer semantics, same menu —
the moment the agent settles with at least one open item, instead of leaving
it to the operator to notice the widget line. This adds a trigger, never a
second answering path: `extensions/command-post/index.ts`'s `runAwaitingDialog`
is the one loop both `/cp-decide` (`auto: false`) and the settle hook
(`auto: true`) call.

**Gated hard to a provable human surface.** `canAutoOpenDialog` (`src/awaiting.ts`)
requires `ctx.mode === "tui" && ctx.hasUI`. RPC's `extension_ui_request` dialogs
are functional (docs/rpc.md), but an RPC client may be a program with nobody
watching; `json`/`print` have no UI at all; a worker never loads this extension
in the first place. Every one of those — headless, no TTY, RPC, worker context,
no human attached — falls back to today's behaviour untouched: no error, no
hang, just the marker plus `/cp-decide`.

**Never blocks the parent.** `canAutoOpenDialog` opens this surface only where a
real interactive TUI is proven, so what the operator faces is either the overlay
(on screen, Esc-dismissible) or a plain dialog carrying
`AWAITING_DIALOG_TIMEOUT_MS`, which auto-resolves on its deadline exactly as
`/cp-decide`'s loop always has; `awaitingDialogOpen` refuses to stack a second
loop (auto over auto, or auto over a manual `/cp-decide` already running).
Nothing here blocks the event loop — only this one handler's own continuation —
so an envelope arriving from a live worker while the dialog is open is
unaffected: `onReported` still fires and queues its follow-up message
independently of whether a dialog is open.

**Do not nag.** A session-scoped set (`awaitingSnoozed`, reset at
`session_start`, never persisted) records every item an auto-opened dialog has
already offered — answered, skipped, or the whole dialog dismissed via
Done/timeout — via `snoozeOffered` (`src/awaiting.ts`). `hasAutoOpenCandidate`
is false when every open item is in that set, so the very next settle does not
reopen for the same batch; a genuinely new item is never in the set and still
triggers the next auto-open. An item that is actually answered is freed with
`forgetSnoozed`. This is the same `snoozed` plumbing `mergeAwaiting` and
`command-post.ts#awaitingSnapshot` already carry: a snoozed item is still
rendered everywhere else (the marker, `/cp-decide`'s own listing, tagged
`(skipped this session)`) — only *auto*-opening is suppressed for it, per the
rule stated above.

**Answer semantics are unchanged.** Free text, `skip` (writes nothing,
anywhere, the item stays open), and any-order answering all go through the
same `resolveAwaitingResponse` the manual path already uses; `/cp-decide`
itself is untouched for manual invocation — it always shows every open item,
unaffected by any session snooze, and never records "do not nag" state.

### Suggested answers

[`src/suggest.ts`](../src/suggest.ts) adds **model-generated candidate
answers** to the `/cp-decide` menu, as ordinary selectable options — no new
answering path, no persistence, no richer context than the operator already
sees in the status block. The pure core is inert on its own
(`src/diff-review.ts`'s "new, tested, unwired" shape); the pi-facing half
(`extensions/command-post/suggest-model.ts`) is the only place that calls
`ModelRegistry.complete`, mirroring the `plan-view.ts` / `plan-viewer.ts`
split.

**Permitted input.** `SuggestionInput` is a closed type: `type`, `decision`,
`why`, `blocks`, `options`, `job_id`, `opened_at`, and — only when the merged
row already carries them from a `StatusJob` — `title`, `project`, `kind`,
`delivery`. Each field is truncated to `SUGGEST_FIELD_MAX_CHARS` and the whole
prompt is capped at `SUGGEST_PROMPT_MAX_CHARS`. There is no field to put an
artifact body, a diff, a gate document or a br comment in, and
`buildSuggestionPrompt` accepts only `SuggestionInput`, never a string.

**The six invariants:**

1. **Never a verdict until a human selects it.** A candidate is just a member
   of the `options` array passed to `ctx.ui.select`; the write path is
   untouched (`deps.answer` → `resolveAwaitingResponse` →
   `decideCheckpoint`/`answerDeclared`). `answerMenuOptions` never lets a
   candidate lead: `Type an answer…` is pushed before the candidates when
   nothing else has been pushed yet, so `options[0]` is always a sentinel or
   an item-declared option.
2. **No body reaches the parent's context, either direction.** Input is the
   closed type above (no file is read on the generation path but
   `data/suggest.json`); output reaches `ctx.ui.select` and nothing else —
   never `sendMessage`, never `appendEntry`, never a run-log event, never
   `state/awaiting.json`. The adapter is handed a registry, a config resolver
   and a notifier, never `pi: ExtensionAPI`.
3. **Skip stays a non-answer.** `parseSuggestions` drops every
   `AWAITING_SENTINEL_OPTIONS` string, so a model can never mint a second
   "Skip"; skipping after suggestions were shown writes nothing, anywhere.
4. **`authorization` items keep their single writer.** `suggestionsEnabled`
   refuses to call a model for one at all; as defence in depth,
   `parseSuggestions` filters any authorization candidate through
   `authorizationVerdict` (`src/awaiting.ts`) — the same anchored vocabulary
   `resolveAwaitingResponse` uses — so a phrase like "approve — the gate
   passed", which would otherwise resolve to an unwritable *note*, can never be
   offered.
5. **The dialog never blocks on the model.** `SUGGEST_DEADLINE_MS` (2s
   default, operator-tunable in `data/suggest.json` within
   `SUGGEST_DEADLINE_MIN_MS`…`SUGGEST_DEADLINE_MAX_MS`) bounds one item's
   generation, once per item per session; a missing config, a disallowed or
   unavailable model, a throw, or a timeout all degrade to `[]` — today's exact
   menu.
6. **Cost is bounded.** A cheap default model (`SUGGEST_DEFAULT_MODEL`), at
   most `SUGGEST_MAX_CANDIDATES` candidates, `SUGGEST_MAX_OUTPUT_TOKENS`,
   `temperature: 0`. `SuggestionCache` memoises by `suggestionFingerprint` —
   sha1 over the whitelisted input — session-scoped, LRU-capped at
   `SUGGEST_CACHE_MAX_ENTRIES`, negative-caching a failed generation so a
   broken provider is asked once per item, never once per redraw.

**Menu ordering** (`suggestions = []` is byte-identical to the pre-cp-9zj
menu):

```
[PLAN_VIEW_OPTION            if planViewable && !planViewed]
[PLAN_VIEW_BACK_OPTION       if planViewed]
…item.options
[AWAITING_TYPE_OPTION        if nothing has been pushed yet]   ← never lead with a candidate
…suggestions
[AWAITING_TYPE_OPTION        unless already pushed]
[PLAN_VIEW_AGAIN_OPTION      if planViewable && planViewed]
AWAITING_SKIP_OPTION
```

**Config.** `data/suggest.json` (`LAYOUT.suggestFile`), read fresh on every
call — never cached at construction (cp-sr5's rule, again): `enabled`
(default true), `model`, `deadline_ms`, `max_candidates`. Absent means "no
override", not "suggestions off".

**Degraded surfaces.** The headless `/cp-decide` listing (no UI) may print
`suggested (model-generated, nothing preselected): a | b | c` per item, for at
most `SUGGEST_MAX_ITEMS_PER_LISTING` items, from the same session cache and
deadline — text only, no numbering that implies a default. The status block
(`cp_status_block`) is untouched: suggestions are a `/cp-decide` surface only.

### The decide UI is the questionnaire

A typed `/cp-decide` **is** the questionnaire overlay from the installed pi
package `@juicesharp/rpiv-ask-user-question`: every open Awaiting-you item is
one **tab** of one overlay call, answered in any order and submitted once, with
the package's own `Type something.` row on every tab, its notes, its collapse
key, and no countdown. **Nothing about answering moved.** The writers
(`resolveAwaitingResponse`, `CheckpointStore.decide`), `state/awaiting.json`,
the sentinels, and the rule that skip writes nothing anywhere are what they
always were.

**What cp-4864 got wrong, and why a green suite did not catch it.** That change
wired the package in as a *shim* behind `driveAwaitingDialog`'s injected
`select`/`input` pair — one overlay per prompt — and resolved it with a single
bare `import()`. On the operator's real TUI the hand-check found the **old**
dialog: "Awaiting you — pick one to answer (Done to stop) (Ns)", `Type an
answer…`, `Skip`, a timeout countdown. Two causes, one visible symptom:

1. **Resolution.** A bare specifier resolves against *this checkout's*
   `node_modules`. The package the operator installed lives in **pi's** package
   root (`packages: ["npm:…"]` in `~/.pi/agent/settings.json` → installed under
   `~/.pi/agent/npm/node_modules`), and a command-post checkout whose
   `node_modules` predates the dependency has no copy at all — so every prompt
   took the fallback.
2. **Silence.** The fallback was deliberate and unannounced, so a total failure
   to load the package looked exactly like normal operation.

So `extensions/command-post/questionnaire.ts` now **finds** the package where pi
put it and **names** every failure:

- candidates, in order: the bare specifier (a checkout that depends on the
  package keeps using its own copy), the same specifier resolved with
  `createRequire`, then pi's own package roots — user scope
  (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, `+/npm/node_modules`) and project
  scope (`<cwd>/.pi/npm/node_modules`). The entry inside a root is read from the
  package's **own** `package.json` (`exports["."]`, then `main`), so this is
  still the public `.` entry and never a hand-written subpath. Loading a
  package from pi's root relies on pi's jiti aliases for its peers
  (`@earendil-works/pi-tui` and friends), which is exactly how pi loads user
  packages;
- the load record carries either a `tool` and its `source`, or a `reason` that
  lists every specifier tried, the first line of each failure, and the fix
  (install it as a pi package, or `npm install` in the checkout). `/cp-decide`
  shows that reason before it falls back — a silent degrade is the defect.

**How the package is reached.** Through its public entry and pi's own
`ToolDefinition` contract, with no vendoring: the default export is an
`(pi) => void` factory, so the adapter calls it with a **shim** API whose
`registerTool` *captures* the definition, then invokes
`tool.execute(id, params, undefined, undefined, ctx)` with the real
`ExtensionContext`. The overlay renders through `ctx.ui.custom` and the
structured answers come back in `details`. The package is deliberately **not**
listed in `pi.extensions`: registering it would put a second model-facing
`ask_user_question` next to the operator's own install. The captured
registration is inert, because the shim is not pi.

**The projection** lives in
[`src/awaiting-questionnaire.ts`](../src/awaiting-questionnaire.ts) — pure, pi
free, and injected exactly like `driveAwaitingDialog`. One item becomes one
question:

```
question  <decision>\nwhy: <why>\nblocks: <blocks>[\n<plan hint>]\n[<id>]
header    Authorize | Approve | Design            (≤ 16 chars)
options   [View the plan…            if planViewable && !planViewed]
          …item.options                            (never reordered, never dropped)
          …candidates                              (only while there is room)
          [View the plan again…      if planViewable && planViewed]
          [Skip                      only to reach the 2-option floor]
```

The id is in the body because the package refuses two identical question texts
in one call — and because the operator answers by id everywhere else. The
package's limits are the projection's limits: **4 questions per call, 2–4
options per question, 60-char labels, no reserved label** (`Other`,
`Type something.`, `Next`).

**Three properties are load-bearing**, and all three are tested
(`tests/awaiting-questionnaire.test.ts`, `tests/questionnaire.test.ts`):

1. **An option round-trips byte-identically.** An awaiting option may be 120
   chars (`AWAITING_OPTION_MAX_CHARS`) against a 60-char label budget, so a
   menu that does not fit is rendered as numbered, truncated **labels** with the
   full string as the **description** and mapped back through an identity map. A
   label the adapter never sent resolves to **nothing** — a skip, never a guess.
2. **Skip writes nothing, anywhere.** An untouched tab is a skip. Esc
   (`cancelled: true`) is a skip for the whole batch, never a decline. `Skip`,
   `View the plan…` and every other sentinel is compared by identity before
   anything is resolved, so none of them can reach a writer. The overlay's
   per-question notes and its global note are not answers and are not recorded.
3. **What the overlay cannot render is deferred, never dropped.** An item with
   more than 4 options, or with fewer than 2 the overlay can show, comes back in
   `deferred` with a reason; `/cp-decide` says so and answers exactly those
   items with the plain dialogs in the same sitting. Reading the plan is a
   *step*, not an answer: the item stays open and is re-offered with
   `View the plan again…` **last**, so a stray Enter never reopens the pager
   (cp-viewer-scroll-stuck, unchanged).

### Every surface that asks uses it

Until cp-gb3w the overlay was `/cp-decide`'s alone, so answering the same item
looked like two different products depending on which surface happened to ask.
**Every surface now asks with the overlay first**, and there are exactly three:

| surface | trigger | UI |
|---|---|---|
| `decide` | a typed `/cp-decide` | overlay, else the plain dialogs |
| `auto_open` | `agent_settled` (`options.auto === true` in `runAwaitingDialog`) | overlay, else the plain dialogs |
| `checkpoint` | `Authorizer.ask` — a minted checkpoint's approve/decline/not-now | overlay, else `ctx.ui.select` |

The widget asks nothing: it renders the marker (`⧗ N decisions awaiting you`) and
points at `/cp-decide`, which is the first row above. A planner's `ask_operator`
question is **not** an Awaiting-you item (it is answered at that planner's own
console and raises no row), and the direct form `/cp-decide <id> <answer>` opens
no UI at all — both are unchanged.

**One routing function decides, and it names its reason.**
[`src/awaiting-ui.ts`](../src/awaiting-ui.ts)'s `routeAwaitingUi(surface, {mode,
hasUI})` returns `overlay` only for a real TUI, and `plain` with a reason
everywhere else — no UI attached (`pi -p`, `json`), or a host that is not a TUI
(`--mode rpc`, an ACP pendant). `overlayFallbackNotice` is the single wording
every surface prints before it degrades, so the operator always learns *why*
they are looking at the plain prompts. **Degrade, never fail**: the plain path is
always available, no awaiting item is unanswerable in any context, and the
package is never a hard dependency of answering.

**The auto-open keeps its deadline** (review 2). The plain dialogs carried
`AWAITING_DIALOG_TIMEOUT_MS` here because a surface nobody asked for must not
wait on a human forever, and the overlay has no external cancel of its own (its
`execute` ignores the abort signal and the handle never leaves the package). So
the adapter keeps the one thing that *can* close it: the `done` callback pi hands
the component factory, captured on the way past through the `ExtensionContext`
the package is given. On expiry `askQuestionnaire` calls
`done({answers: [], cancelled: true})` — byte-identical to Esc — and reports
`cancelled`. **That is the existing skip, exactly**: nothing is written anywhere,
every item stays open and simply reappears, and the settle handler and the
single-run latch are both released. The number is
`AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS`, which *is* `AWAITING_DIALOG_TIMEOUT_MS`
— the same 600s the plain dialog carried on this path, not a longer one.
`overlayTimeoutMs(surface)` is the only place that decides: **auto-open only**.
A typed `/cp-decide` and the checkpoint ask carry no deadline, because a human
asked for the first and a human is being asked by the second.

**The deadline holds in both orders** (review 3). `overlayDeadlineContext` is a
small state machine, not a captured variable: if the overlay is already up,
`expire()` closes it; if the deadline fires *before* the package ever reached
`ui.custom` (a slow load, a slow `execute`), the wrapper **refuses to render** —
the real `ctx.ui.custom` is never invoked and the package is handed the same
cancelled result — so nothing can be left orphaned on screen after the batch was
reported as a skip. The abandoned execution is never awaited and never becomes
an unhandled rejection.

**Closing the overlay is best effort; settling the ask is not** (review 4,
operator decision). Closing depends on an assumption about somebody else's
package — that it renders through `ctx.ui.custom` and that the factory's fourth
argument is `done`. The timeout layer therefore takes that API as it stands and
defends against it: `expire()` returns which of four things it managed —
`closed`, `refused` (nothing had rendered), `no_handle` (it rendered through
something this wrapper does not intercept, or with a shape carrying no `done`)
or `close_failed` — and **every one of them settles the ask as `cancelled`**,
releases the `SingleRunLatch` and releases the settle handler's continuation,
writing nothing anywhere. Anything that is not `closed` also emits
`OVERLAY_NO_CLOSE_HANDLE_NOTICE` as a warning, so a package whose shape has
moved surfaces as a signal instead of a deadline that quietly does nothing. The
overlay may then stay visible until the human dismisses it (Esc, which is the
same skip) — that is accepted; an ask that never settles is not. The proxy is otherwise faithful: every non-`custom`
member is forwarded to the real object, with methods **bound to it** so nothing
is ever called with a proxy as `this`, and with stable identity across reads.

Two further guarantees, and both are the code that runs rather than a claim about
it. `canAutoOpenOverlay(env)` — `canAutoOpenDialog(env) &&
routeAwaitingUi("auto_open", env).ui === "overlay"` — **is** the settle hook's
gate, and the rest of that hook's decision is `autoOpenDecision({env, latchBusy,
items})`, a pure function tested by running it (`no_human_surface` · `busy` ·
`nothing_open` · `open`) rather than by matching the hook's source.
`SingleRunLatch` replaces the bare `awaitingDialogOpen` flag: the release lives
in the class's own `finally`, so a run that answers, throws, or ends on the
overlay's deadline all leave the latch free for the next settle.

**The checkpoint surface is one function**, `askCheckpointDecision`
([`extensions/command-post/questionnaire.ts`](../extensions/command-post/questionnaire.ts)),
so it is *exercised* by tests rather than matched as a source string: the
overlay branch, the four ways out that are not a verdict (`not now`, an
untouched tab, Esc, dismissing the plain dialog), free text as a note, and the
degrade to `ctx.ui.select` with the reason named.

**The invariants did not move.** `CheckpointStore.decide` is still the one writer
for an authorization; a skip writes nothing anywhere and the item reappears;
`cp_awaiting` still only lists and withdraws, and still refuses to withdraw an
authorization row. On the checkpoint surface, only the two verdict rows are
verdicts (`interpretCheckpointAnswer`): `not now`, an untouched tab and Esc all
leave the checkpoint pending, and typed free text is surfaced as a **note**,
never a verdict — the same rule `resolveAwaitingResponse` already enforced for an
authorization row. "Do not nag" is one rule for both runs (`snoozeCandidates`):
the overlay run and the plain run snooze the same items, and an answered row is
never snoozed.

**Real-TUI verification, as of cp-gb3w:** `/cp-decide`'s overlay was hand-checked
when cp-vvaz shipped it. The two surfaces cp-gb3w newly routed to the same
overlay — the `agent_settled` auto-open and the checkpoint ask — have **not** been
hand-checked on a real pi TUI; their unit coverage is the routing decision, the
fallback wording and the answer semantics, not the rendering. Treat their chrome
as unobserved until somebody looks.

**A green suite is not evidence for this surface** (AGENTS.md, cur-20260901-5).
Every failure path here is unit-tested with a fake package and a fake overlay,
and the resolution order is tested against a fake `node_modules` tree — but that
is what cp-4864 also had. What proves the overlay renders is a hand-check on a
real pi TUI: the tabbed dialog, `Type something.`, `n` for notes, `ctrl+]` to
collapse, **no countdown**. If the plain countdown dialog appears, read the
warning `/cp-decide` printed: it names the specifiers it tried.

### The decision details pane

An Awaiting-you row carries three bounded strings — `decision`, `why`, `blocks` —
and nothing else, so a decision that exists *because* a review found three
issues was put to the operator with none of them on screen. The findings were on
disk the whole time (`state/runs/<job-id>/review-<n>.json`); the only way to read
them was to leave the dialog. [`src/decision-context.ts`](../src/decision-context.ts)
is the projection that closes that gap, and
`CommandPost.decisionContext(item)` is the one call site every surface uses.

**What it may read is a closed list**, and it is what this home itself wrote:
the newest diff-review verdict, the newest plan-gate verdict, the row's own
pending checkpoint, and the CI watcher's last observation of the branch head
(`state/ci-watch.json` — files only, because this runs on a render path and no
network call belongs there). It reads **no artifact body, no diff, no task file
and no run log**: there is no path function for one in the module, and a test
asserts that by reading its source, the same way `src/suggest.ts` closes its
input type.

**Every line is tied to the job, the head and the attempt it describes.**
Evidence for another job is dropped outright. A review verdict whose `head_sha`
is not the branch's current pushed head is rendered as **stale**, naming both
shas, and contributes **no findings** — a review of a superseded diff says
nothing about the commit that would merge, which is the same rule §The merge ask
applies to CI. A `merge` authorization scoped to another commit is stale for the
same reason (a force-push voids it), and a checkpoint that is already answered is
not a current question. Every finding carries its attempt (`review-3`), because
"the reviewer said this" is only useful with "in which round".

**No observed head means nothing is current** (PR #151, finding 1). The anchor
is the head the CI watch recorded for this job, and a head this home never
observed is not a weaker fact than a superseded one — it is **no** fact. So with
no head on file, the review verdict, the gate verdict and a `merge`
authorization's scope are all **untied**: each is *named*, with its finding count
and `/watch <job-id>`, and none of it is rendered as describing the state the
operator is being asked about. The recommendation says exactly that rather than
reading a verdict nobody can place. The consequence is deliberate and worth
stating: a research row whose job has no branch (so no head) shows its gate's
findings as a **count and a pointer**, not as current findings — the pane would
otherwise assert currency it cannot prove.

**Bounded and redacted.** Each line is whitespace-collapsed, passed through
`redactSecrets` (`src/decision-context.ts`) and clipped to
`DECISION_CONTEXT_LINE_MAX_CHARS`; the pane is capped at
`DECISION_CONTEXT_MAX_LINES`. Order **is** priority — header, findings
(up to `DECISION_CONTEXT_MAX_FINDINGS`), recommendation, then the verdict
headers, checkpoint text, CI line and stale notes — and **whatever the budget
cuts is always announced, inside the budget**: one truncation, one
`+N more line(s) — /watch <job-id>` marker in the last slot, plus
`+N more finding(s)` when the finding cap itself bites. A budget of zero renders
nothing at all rather than a claim nobody can check. (The earlier shape had a
hole at "no room left for the tail", where lines were dropped with nothing said
— PR #151, finding 3.)

**The budget is the terminal's, when the terminal says what it is** (PR #151,
finding 4). A bounded pane is not a small pane: on a 40×24 terminal a 20-line
pane wrapped past the bottom of the screen and pushed the overlay's answer rows
out of sight, and the overlay does not scroll to the selection — so the operator
could navigate but not see what they were about to answer. `decisionPaneBudget`
therefore reads `process.stdout.{columns,rows}` in the pi process and gives the
pane `rows - DECISION_PANE_RESERVED_ROWS` **wrapped screen rows**; the builder
counts `ceil(len / columns)` per line and cuts with the same explicit marker. The
pane yields, never the decision. A terminal that reports no size keeps the
line-only budget, unchanged.

**The recommendation is a reading, never a decision.** It is one line, always
prefixed with `DECISION_CONTEXT_RECOMMENDATION_LABEL` ("recommendation (not a
decision, nothing is preselected):"), it is derived mechanically from the
verdicts and the counts rather than generated, and it lives in the **question**,
never in the option list. That is the load-bearing half: a recommendation that
could be selected would be a preselected authorization, and the option list is
byte-identical with and without a pane — so what a stray Enter lands on cannot
move because evidence appeared.

**Nothing else about answering moves.** Skip is still no answer; free text is
still free text and still a note on an authorization row; `CheckpointStore.decide`
is still the single writer; keyboard, focus and scrolling are untouched because
only the question body grew. The plain-prompt fallback shows the same pane
indented under its row and names where the rest lives (`/watch <job-id>`,
`/cp-plan <job-id>`), so a headless `/cp-decide` is not a blinder.

**Real-TUI verification: done, and it found the row-budget defect above.** The
record — how the TUI was driven, the frames it rendered at 100×40 and 40×24
before and after the fix, and what each checklist line rests on — is
[`docs/tui-verification/pi-command-post-4mn.md`](tui-verification/pi-command-post-4mn.md).
What was observed on a real pi 0.85.0 TUI with the real overlay: the pane in the
question with every finding numbered, the credential shape redacted to `•••` on
screen, the labelled recommendation, the answer rows unchanged with the cursor on
the first one, **Kitty-encoded Enter (`CSI 13 u`) selecting a row** and writing
through `CheckpointStore.decide`, a second Enter re-triggering nothing, and Esc
leaving the checkpoint pending with no `state/awaiting.json` written at all. Not
covered: a real emulator's own Kitty negotiation (this was pi's, over an `expect`
pty), mouse selection, a resize while the overlay is open, and the
`agent_settled` auto-open surface.

## Web Push

When something needs the operator, their phone or desktop gets a Web Push notification (Pier 1.1; implemented
from RFC 8030/8188/8291/8292, no Pier code). This section is the **push service**: the parent side. The
dashboard half (subscribe control, service worker, Home Screen manifest) is §Web Push: the dashboard below.

**What pushes, once per id.** Exactly two notification types (`PUSH_RULE` in
[`src/push/sweep.ts`](../src/push/sweep.ts), shown by `/doctor` as a second `[push]` line):

- **mandate complete** (informational, asks nothing): once per **mandate id** (ledger `source: mandate`),
  triggered by the mandate's `mission_end` escalation being raised — the one trigger; it pushes whether or not
  that escalation is already answered, and a later mission end for the same mandate (after an extend) does not
  push again. Headline `<mandate id> complete: landed N, dropped M, $cost`. A revoke alone does not push.
- **decision needed**: something waits on the human specifically —
  - a new **open operator ask** in `state/operator/asks.jsonl` (`cp_parent ask`): the ask id is the key, the
    ask's question the headline and its own `project` the project tag. An ask whose `source_escalation` is
    pushed directly (open human-only escalation, or a `sent`/`pending` ledger record) is not pushed again;
  - a new **open human-only escalation** — `PUSH_ESCALATION_KINDS`: `risk_high_irreversible`,
    `budget_exhausted`, `merge_refused` (only the operator's own words close them, even with the main session
    down);
  - a pending **`final_fix` checkpoint** (keyed by its Awaiting-you id);
  - a new **open merge ask**: an Awaiting-you row `isMergeAsk` recognises. A `deferred` row pushes when it is
    promoted to `open`, not before; a `merge-pending pr <url>` reminder never pushes (its `merge_refused`
    escalation already did).

Everything else never pushes: `plan_approval`, `conflicting_acceptance`, `mission_end` as a question and any
kind the main session may decide under delegation reach the human only through an operator ask; routine
wakes, answer cards, CI wakes and other checkpoints never push. A refreshed escalation (same id, fresher
numbers) is not new. When a ledger written before this rule is first swept (no `rule_baseline_at`), what the
sources hold then is `skipped` ("open before the push rule changed"), never replayed.

**Health, from the watchdog, not this sweep** (cp-daemon v1 P3; `PUSH_RULE` ends `; health (cp-health, once per
failure/recovery)`). cp-health ([`src/service/health.ts`](../src/service/health.ts), run by cp-daemon every 5
min) pushes `{project: "command-post", kind: "health: <parent down | viewer down | crash-looping |
disk low | git credential | gh credential | update failed>", headline}` once when a check starts failing (parent and
viewer only after 2 runs in a row, never while `state/update.json` `phase` is not idle unless it is a `held` rollback with no run in flight), nothing while it stays
failed, once more for each distinct updater failure (keyed `result:to`: `failed`, `drain_timeout`, `rolled_back`,
`rollback_failed`, `config_invalid`, `fetch_failed` three times), and `health: <name> recovered` once. It sends
directly to the subscribed devices with the same RFC code; its only record is `state/health.json`. A failed push
is retried on the next ≤ 3 runs, then logged and given up. It never writes `state/push-deliveries.json` and never
deletes a subscription, even on 404/410.

**A sweep of the durable records, not a hook in the raise path.** `runPushSweep` runs every
`PUSH_TICK_MS` (15 s, plus one catch-up pass at `session_start`) only while this session holds the parent
lock, never overlapping ([`extensions/command-post/push-tick.ts`](../extensions/command-post/push-tick.ts)).
It reads `state/escalations.json`, `state/awaiting.json`, `state/operator/asks.jsonl` and the final_fix checkpoints fresh, so a raise through a fresh store, or a
crash between a raise and its push, loses nothing — the record is the queue. `EscalationStore`,
`AwaitingStore` and every raise path are untouched, and every error is caught into one stderr line: a push
outage delays nothing in the fleet. Latency is at most one tick plus the push service.

**The ledger is `state/push-deliveries.json`** ([`src/push/deliveries.ts`](../src/push/deliveries.ts)),
single-writer, typebox-validated before every write, refused by name when invalid (nothing is sent then).
One record per `source` (`escalation` | `merge_ask` | `checkpoint` | `ask` | `mandate`) + `id`: `status` `pending` | `sent` | `failed` |
`skipped`, `attempts`, `delivered`, the subscription ids still owed (`targets`), `next_attempt_at`,
`last_error` (≤ 300 chars), `created_at`, `settled_at`. **No payload is stored.** The first sweep after push
is set up writes the baseline: everything already open is `skipped` ("open before push was enabled").
A new item with no subscribed device is `skipped` ("no subscribed device"), so a later subscriber gets no
backlog; an item that stops being open before its attempt is `skipped` too. Pending records, records still
open and the newest 200 settled ones are kept.

**Delivery and failure.** At most `PUSH_MAX_RECORDS_PER_SWEEP` (10) records per sweep, sent to every
target in parallel with a fresh salt and sender key per message and a 10 s timeout. 2xx is delivered;
**404/410 delete that device's subscription file**; 429, 5xx, a network error or a timeout retries that
device after 30, 60, 120 and 240 s and the record is `failed` after `PUSH_MAX_ATTEMPTS` (5); any other
status fails that device without retry. An endpoint off the push-service allowlist
(`PUSH_SERVICE_HOST_SUFFIXES`: `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`) is rejected and never fetched, and no redirect is followed. Every non-delivery is
one stderr line `push <id> → <subscription id first 8>: <gone|retry|rejected> (<reason>)` and a ledger
entry; `/doctor` warns on pushes undelivered in the last 24 h. No line, finding or ledger entry carries an
endpoint, a key or a payload.

**Payload** (`pushPayload`): exactly `{"project", "kind", "headline"}` — the project tag as the bridge
computes it (≤ 80 chars, `project unknown` when none; an operator ask's own `project`), the kind —
`mandate complete`, or `decision needed` with the underlying kind as a suffix (`decision needed: risk high
irreversible`, `decision needed: merge ask`, `decision needed: final fix`; a bare `decision needed` for an
operator ask) — and the headline whitespace-collapsed and clipped to 100 characters. Never options,
evidence paths, plans, ids or artifact text. It is encrypted per RFC 8291 (`aes128gcm`, one 4096-byte
record) and signed per RFC 8292 (ES256 VAPID JWT for the push service's origin, 12 h) with `node:crypto`
only ([`src/push/webpush.ts`](../src/push/webpush.ts)); no dependency.

**Files** (home-local, never committed):

| File | Written by | Read by |
|---|---|---|
| `data/push/config.json` | `npm run push:init` | the sweep, `/doctor`, the viewer: origin, subject, VAPID public key |
| `data/push/vapid.key` (0600) | `npm run push:init`, once, never overwritten | the sweep and cp-health only; never printed, logged or quoted |
| `data/push/subscriptions/<sha256(endpoint)[0:32]>.json` (0600) | the dashboard; the sweep deletes on 404/410 (cp-health never deletes) | the sweep, cp-health, `/doctor` |
| `state/push-deliveries.json` | the sweep (parent-lock holder) | `/doctor` |
| `state/health.json` | cp-health (run by cp-daemon, its only writer) | `/doctor` `service.health`, the Overview status line |

One file per device, so two processes (the viewer adding, the parent deleting) never read-modify-write the
same file.

**Set up once.** The Push API needs a secure context. The dashboard's HTTPS origin is served by
infrastructure the operator runs outside this repository (for this home: `https://cp.example.com` through a
private Traefik proxy to the viewer), with TLS terminated there, not in the viewer. Then:
`npm run push:init -- --origin https://<dashboard host>` (optional `--home`, `--subject mailto:<address>`;
the origin must be `https:` with no path) and restart the parent at a quiet point so the tick loads.
`/doctor` then shows `[push] web push for <origin>: <n> subscribed device(s)`. **Off switch:** remove
`data/push/config.json`; the sweep does nothing and says nothing, and the subscription route answers 409.

### Web Push: the dashboard

More → **Notifications** is the only way a device subscribes ([`viewer-app/push.ts`](../viewer-app/push.ts),
[`viewer-app/components/PushControl.tsx`](../viewer-app/components/PushControl.tsx)). Turn on asks the browser
for permission, registers `/sw.js`, subscribes with the VAPID public key from `/api/push` and stores the
subscription; a refused store unsubscribes the browser again. Turn off deletes it on the home, then in the
browser (a failed delete still unsubscribes; the home drops it on its next push with 410). The control
never offers Turn on where it cannot work, and says why: no HTTPS (with a link to the configured origin),
iPhone/iPad outside a Home Screen app (Share → Add to Home Screen; Turn on only when `navigator.standalone`
or `display-mode: standalone`), no Web Push, push not set up, or notifications blocked.

**Home Screen install** (iOS delivers Web Push only there): a same-origin `/manifest.webmanifest`
(`display: standalone`, `start_url: /#awaiting`, palette `--background` for theme and background), icons at
192 and 512 px plus a 180 px `/apple-touch-icon.png`, drawn from the Awaiting-you glyph in `--amber`
([`src/viewer/app-manifest.ts`](../src/viewer/app-manifest.ts)).

**The service worker** ([`src/viewer/service-worker.ts`](../src/viewer/service-worker.ts)) shows
`[project] kind` with the headline as body — no actions, since the dashboard decides nothing — and a click
focuses a dashboard window on `/#awaiting`, or opens one.

**Its write route**, `POST|DELETE /api/push/subscription` ([`src/viewer/push-api.ts`](../src/viewer/push-api.ts)),
checks in order: push set up (409), `Origin` equal to `config.origin` or, on a loopback bind, the bind's own
`http://` origin (403), `Sec-Fetch-Site` same-origin when sent (403), `application/json` (415), ≤ 4 KiB
(413), a valid `https:` subscription on the push-service allowlist (400), ≤ `PUSH_MAX_SUBSCRIPTIONS` (10)
devices (409). Only [`src/viewer/push-subscriptions.ts`](../src/viewer/push-subscriptions.ts) writes (one
0600 file per device, create+rename or unlink); a guard test pins that. `/api/push` returns the origin, the
public key, the device count and 24 h undelivered count and last error — never an endpoint, an auth secret or
the private key. APP_CSP gains exactly `worker-src 'self'; manifest-src 'self'`. The viewer's Host guard is
unchanged: the HTTPS proxy sends the bind address as Host (`passHostHeader = false`), and only `Origin`
names the public origin.

## Dashboard control

The operator steers its own running operator (main) session from the dashboard's Sessions → Operator ↔ you →
**Full transcript** (cp-dashboard-operator-control). **This is a risk:high surface**: remote input into an agent
session that has a shell. It is **on by default** wherever the viewer runs with `--require-tailnet`
(`bin/cp-operator` always passes it — the service viewer binds the address cp-install pinned (`CP_VIEWER_HOST`) or
the Tailscale address; whoever can reach it holds these controls, so the installer accepts only Tailscale, private
or loopback addresses of the machine, and `cp-view --require-tailnet` refuses a wildcard, public or non-IP host)
and an operator session is serving it; the only switch is the opt-out
`data/dashboard-control.json` with exactly `{"enabled": false}` (any other content is invalid and refuses, fail
closed). `/doctor` prints one `[dashboard-control]` line: `on` or `off`, and why, and whether an operator session
serves it. Access is the dashboard's own: the HTTPS origin is reachable only from the operator's tailnet devices,
so there is no login, identity or device allowlist (operator addendum, 2026-09-27).

**Two ways in, one effect: a user message.** The composer's text, or one click on a decision card, is delivered
into the session with `pi.sendUserMessage` — exactly what the human could type at the CLI, and nothing more. Text
is literal (`expandPromptTemplates` is never set, so no slash command, template or skill), idle is a new prompt,
busy is `deliverAs: "followUp"` (Send after this turn) or `"steer"` (Steer now), and Abort turn calls
`ctx.abort()`. A click on option *Keep* of open ask `ask-abcd` sends `ask-abcd: Keep` (the reply the Awaiting
screen copies). Every injected message ends with one marker line, `[cp-dashboard dc-… — from the dashboard]`
(a click adds `; ask=<id>`), so the transcript shows it tagged `dashboard`. **A click is the human's answer, never
an authorization**: it never calls `cp_decide`, a `cp_parent` action or the parent host, and never writes
`state/operator/asks.jsonl`; the main session records it with `ask_answer` (verbatim) and relays it, by its
`cp_parent` guideline, and the card stays open until the ask journal says otherwise. Refused: a label that is not
an option (400), an answered or withdrawn ask (409), a second click on one ask within 10 minutes unless the
first failed (409).

**Transport** ([`src/dashboard-control.ts`](../src/dashboard-control.ts), loaded by the cp-bridge extension): at
`session_start` the operator session binds `state/operator/dashboard.sock` (umask 077, then 0600; ≤ 107 bytes; a
live socket another session serves is a named refusal, a stale one is unlinked only when nothing answers) and
writes the 0600 record `state/operator/dashboard.json` (`pid`, `socket`, a fresh 32-byte socket `token` and CSRF
`csrf` per session start). Frames are NDJSON `{v, token, id, op, args}`; a wrong socket token closes the
connection. `session_shutdown` closes the socket and removes the record. No new network listener: with no
operator session there is no socket, and the dashboard says **session not running**.

**The viewer's routes** ([`src/viewer/control-api.ts`](../src/viewer/control-api.ts)). `GET
/api/operator/control` returns `{enabled, running, reason, token, busy, pending, session_file, recent}` — the
session's CSRF token, which the page fetches itself; it never writes. `POST /api/operator/message` takes
`{kind:"message", text, deliver?}`, `{kind:"answer", ask_id, label}` or `{kind:"abort"}` and refuses, in order:

| Check | Refusal |
|---|---|
| method is POST | 405 |
| viewer runs `--require-tailnet` | 403 |
| 20 requests per 60 s and one in flight per client address (refusals count, so this also bounds the journal) | 429 with `retry-after` |
| `data/dashboard-control.json` invalid / `enabled:false` | 503 / 403 `dashboard control is off (…)` |
| `Origin` equals the public origin `/api/push` reports (or a loopback bind's own) | 403 `Origin must be …` |
| `Sec-Fetch-Site` same-origin when sent | 403 |
| `application/json` | 415 |
| body ≤ 20 KiB | 413 |
| body shape; text 1–16,000 characters | 400 |
| the session's record exists | 503 `session not running: no dashboard control record at …` |
| `x-cp-control-token` equals the record's `csrf` | 403 `control token missing or stale; reload the transcript` |
| the socket answers within 5 s | 503 `session not running: … refused the connection (…)` / 504 |
| the session's own checks | 202 `{id, state, deliver}` (state `queued` or `delivered`), or 400/403/409/500/502 with the reason |

`APP_CSP`, `hostAllowed`, the push route and every read route are unchanged; a POST to any other `/api/*` route is
still 405. The Full transcript itself stays served only under `--require-tailnet`.

**Audit journal** `state/operator/dashboard.jsonl` (0600, append-only, one `O_APPEND` write + `fsync` per line, two
writers). The session appends a `request` line (`by:"bridge"`, `id`, `at`, `peer` — the client address — `kind`,
`text`, `ask_id`, `deliver`) **before** anything happens — a request line that cannot be written refuses the request
(500) and nothing is injected — then `outcome` lines (`injected`, then `delivered` once the marker is seen in a
`message_start` or `context` event, `queued` when it is not seen within 2 s, `failed` or `refused` with the reason).
The viewer appends one `refused` line (`by:"viewer"`, `status`, `reason`, `peer`, and whatever `kind`/`text`/`ask_id`
it parsed; an unreadable or oversized body records `bytes`, never the bytes) for every POST it refuses after the
`--require-tailnet` guard ([`src/viewer/control-audit.ts`](../src/viewer/control-audit.ts), the viewer's only other
request-time writer besides push subscriptions, imported only by `control-api.ts`); only the first 429 per window is journaled. A viewer audit
line that cannot be written still answers the refusal, with `audit: "unwritten: …"` in the body and one stderr
line. `text` is clipped to 16,000 characters. No rotation yet; the rate limit bounds its growth.

**The inbox: no operator session running** (cp-daemon v1 P3; [`src/viewer/control-inbox.ts`](../src/viewer/control-inbox.ts)).
When the session's record is absent, invalid or names a pid that is gone, `GET /api/operator/control` answers
`offline: true`, `held` (the count waiting) and `inbox_token` — a random token per viewer process, since the
session's CSRF token does not exist then — and the dashboard says **operator session offline · N held**. The POST
runs the same chain up to the record step, then, instead of 503: the inbox token (403 `inbox token missing or
stale`), `abort` is 409 (`nothing to abort; the operator session is offline`), at most 20 waiting (409), and one
`held` line `{type, id: dc-…, at, text, ask_id}` appended to `state/operator/inbox.jsonl` (0600, one `O_APPEND`
write, like the journal) → 202 `{id, state: "held"}`. A click holds as `<ask>: <label>` with its `ask_id`. At the
next `session_start`, once dashboard control listens, the session injects every held message younger than 24 h as
**one** user message, oldest first, headed `[cp-dashboard inbox — N message(s) typed while this session was
offline; each line keeps its time; re-check state before acting on them]`, each line with its time and id and an
ask no longer open marked so, then appends one `delivered` line per id; an older one gets a `dropped` line and is
listed, never injected. An injection the session refuses leaves them held for the next session. Held messages are
the human's words, never an authorization.

**Start session** (`POST /api/operator/start`). While offline, the Overview's status line and the composer offer
**Start session**: the same chain (method, `--require-tailnet`, rate, opt-out, Origin, Sec-Fetch-Site, JSON), a body
of exactly `{"via": "herdr"}` or `{"via": "tmux"}` (400 otherwise), no live session record (409 `already_running`,
with `via`), the inbox token (403), at most one start per 60 s (429), then a fixed argv, no request data: `tmux` runs
exactly `<absolute tmux> new-session -d -s cp-operator <absolute ~/.local/bin/cp-operator>` (cp-rrye: only from the
viewer cp-daemon runs, `CP_DAEMON_ROLE=viewer`; its env minus `CP_DAEMON_*`; an existing `cp-operator` session is
409 `already_running`); `herdr` checks its server (`herdr status server --json`),
runs `herdr workspace create --cwd <home> --label cp-operator --env CP_HOME=<home> --no-focus` and `herdr pane run
<pane_id> "'<absolute ~/.local/bin/cp-operator>'"` — the command is one sh-quoted argument, since herdr's own parser takes a
global `--session` from anywhere in its argv (the absolute herdr, ≤ 10 s per call; a failed `pane run` closes the workspace it
created) — answering 202 `{state: "starting", via}` or 503 `{state: "unavailable", via, reason}` (
tmux: not the cp-daemon-run viewer, tmux not on PATH or the wrapper not installed; herdr not on PATH or its server
not running; or the command's own error).
`GET /api/operator/control` carries `launchers: {tmux, herdr}` (herdr: binary and server running, checked ≤ 30 s
ago), and the page offers one button per launcher. Every refusal is a `refused` line (`kind: "start"`, `via` once
parsed), every start or unavailable a `start` line with `via` in the audit journal. The page then polls the status
until `running` (≤ 60 s) and opens the composer; the held messages arrive with the session. Attach from a terminal
with `tmux attach -t cp-operator`,
or open herdr → workspace `cp-operator` (docs/service.md). **Nothing
auto-starts**: a message alone never starts a session (it spends model tokens), only this explicit click.

**Trust boundary.** Any local process of the same user can already read the 0600 record and reach the socket;
that is the same boundary as the parent host's. The Origin check and CSRF token stop a hostile web page in the
operator's own browser, not a local process. **Recovery:** write `{"enabled": false}` to
`data/dashboard-control.json` — the viewer refuses the next request, the session refuses the next frame, and the
socket closes at the next session start; the state files are home-local and may be deleted while no operator
session runs.

### Schedule controls (cp-hhuf P6)

The Schedules page offers **Enable/Disable, Run now and Remove** per schedule, and an **Add schedule…** link that
only opens the Full transcript with a prefilled composer draft (a schedule needs its own grant, issued only on the
operator's words). **This is a risk:high surface**: a browser-reachable write that the fleet owner acts on. It adds
no daemon, socket or listener: the viewer appends a line, the parent reads it.

`GET /api/schedules/control` (403 without `--require-tailnet`; never writes) returns `{enabled, reason, token,
parent: {running, pid, reason}, requests, error}` — `token` is this viewer process's random schedule token, only
while control is on; `parent` is `state/parent.lock` and whether its pid runs; `requests` are the last 20 with their
latest state (a queued one older than 120 s is shown `expired`). `POST /api/schedules/request` takes exactly
`{"op": "enable" | "disable" | "run_now" | "remove", "schedule_id": "sch-<6 hex>"}` and refuses, in order:

| Check | Refusal |
|---|---|
| method, `--require-tailnet`, rate, opt-out, Origin, Sec-Fetch-Site, JSON, 20 KiB, JSON parse | as in the Dashboard control table (kind `schedule`) |
| body shape | 400 `body must be {"op": …, "schedule_id": "sch-<6 hex>"}` |
| the parent holds the home (`state/parent.lock` pid alive) | 503 `parent not running: …` |
| `x-cp-control-token` equals the schedule token | 403 `control token missing or stale; reload the page` |
| `state/schedules.json` readable / names the schedule | 503 `schedules unreadable: …` / 404 `no schedule <id>` |
| fewer than 20 fresh requests queued | 409 |
| the `request` line is appended | 500 `schedule control journal unwritable (…)` |
| — | 202 `{id: "sc-<14 digits>-<8 hex>", state: "queued"}` |

Every refusal after the `--require-tailnet` guard is one `refused` line (`kind: "schedule"`, `op`/`schedule_id` once
parsed) in `state/operator/dashboard.jsonl`; no refusal writes a request line.

**Journal** `state/schedule-control.jsonl` (0600, append-only, one `O_APPEND` write + `fsync` per line, two writers
through [`src/viewer/control-audit.ts`](../src/viewer/control-audit.ts)): the viewer's `request` (`id`, `at`, `peer`,
`op`, `schedule_id`), then the parent's `claimed` (`pid`) and `outcome` (`done` | `refused` | `expired` |
`interrupted`, `reason`, `job_id`).

**The parent's consumer** ([`src/schedule-control.ts`](../src/schedule-control.ts)), polled every 2 s by the
command-post extension while it holds the lock, holds no authority of its own. Per queued request, oldest first: older
than 120 s → `expired` (never applied late); `data/dashboard-control.json` not on → `refused`; else it appends
`claimed` **before** it acts — a claim that cannot be written acts on nothing — and applies the op through the one
`Scheduler` `cp_schedule` uses, then appends the `outcome`. A claim another pid left without an outcome is
`interrupted`, never re-applied. Effects: `enable` is refused unless the schedule's grant passes the fire check, and
restarts cron slot evaluation at the enable time; `disable` and `remove` are never grant-gated; `run_now` is a manual
fire (see Schedules), whose job goes to the schedule runner (answer/board/local) or the `cp-schedule` wake
(pr/pipeline) exactly like a slot fire.

**Recovery:** `{"enabled": false}` in `data/dashboard-control.json` stops the route and refuses queued requests at
the parent; `state/schedule-control.jsonl` may be deleted while nothing is queued. The trust boundary is the
dashboard control one: a same-user local process can already write `state/`.

## Reading the plan

[`src/plan-view.ts`](../src/plan-view.ts) resolves a job id to a viewable research
artifact or gate decision and reads it, capped;
[`extensions/command-post/plan-viewer.ts`](../extensions/command-post/plan-viewer.ts)
is the one place that decides whether that read may happen at all. Together
they give the **operator** a paged, searchable view of a plan at the moment
§Awaiting you asks "ship, drop or follow-up?" — without moving the no-bodies
rule (§Artifacts) an inch: the parent's model context, its session file and
every tool-visible surface stay exactly as blind to that body as before.

**The mechanism has one load-bearing property: it is not a tool call.**
`ContextGuard` polices `tool_call` events, which is the only shape a model can
emit; a slash command handler and a dialog the operator drove are not that
shape, so nothing here needs a guard exception and `src/guards.ts` is untouched
by this feature. The safety instead comes from three facts, each verified
rather than assumed:

1. **`ctx.ui.custom()` writes to the terminal only.** The pager is a full-screen
   overlay (`overlay: true`, `overlayOptions: { width: "100%", maxHeight: "100%",
   margin: 0 }`, `onHandle: (handle) => handle.focus()` — full-screen overlay options), not an editor swap. Nested `View the plan…`
   from `/cp-decide` is overlay-on-overlay: `q` / Esc / idle-timeout call
   `done(undefined)`, which fires `ui_prompt_end` for the outer span only when
   the pager was the outer prompt, and `hideOverlay` pops one frame so the
   questionnaire stays on the stack and is focused and answerable. No
   `sessionManager` call exists anywhere on that path. `pi.appendEntry` — the
   mechanism `/status` and `/watch` use for long output (§Where long output
   goes) — was considered and rejected here for the opposite reason it is safe
   for a fleet table: `appendEntry` does not reach the LLM, but it **does**
   persist to the session JSONL (`SessionManager.appendCustomEntry` →
   `_persist`), and a research artifact belongs in the artifact store, not
   copied into a session file.
2. **The read is gated inside the one function that performs it.**
   `openPlanViewer(ctx, target, deps)` checks `ctx.mode === "tui" && ctx.hasUI`
   **before** calling `deps.readSource` — not at any call site. `print`/`json`
   modes have `hasUI: false`; RPC has `hasUI: true` but `mode: "rpc"`, and
   `ctx.ui.custom()` itself returns `undefined` there (docs/rpc.md) even if the
   gate were skipped. Every non-TUI path gets a message naming the resolved
   path and byte count — the same headline §Artifacts already allows through
   `ls`/`stat`/`wc` — and never the body.
3. **`openPlanViewer` never receives `pi: ExtensionAPI`.** Only `ctx` and a
   small `deps` object. `pi.appendEntry` and `pi.sendMessage` are therefore
   unreachable from this file by construction, not by discipline: there is no
   variable in scope that names them. `tests/plan-viewer.test.ts`'s Guard C
   asserts the call arity has no such parameter.

**The one model-reachable route, and why it closes here, not at a call site.**
A model cannot type a slash command, but it can run `bash: pi -p "/cp-plan
<id>"` or drive `pi --mode rpc` directly — a fresh process where this extension
loads and `ContextGuard` never fires, because that command line names no
artifact path (`ContextGuard` matches on tool-call *arguments*, and a shell
invocation of `pi` is not one). Both of those land in `ctx.mode !== "tui"`, so
the gate inside `openPlanViewer` is what stops them — which is exactly why the
check lives there and not scattered across every future caller.

**Surfaces**, all thin wrappers around the same `resolvePlanTarget` /
`openPlanViewer` pair:

| surface | when | degrades to |
|---|---|---|
| `/cp-plan <job-id> [--gate [n]]` | any time, including before a checkpoint exists | a path+size notify (RPC) or stderr line (print/json) |
| the `/cp-decide` answer menu | at the decision itself — inserted **first**, non-destructively | absent when no plan is viewable, or outside a real TUI |
| `/watch`'s output | a pointer line only — path and byte count, appended when `artifacts.has(jobId)` | nothing when there is no artifact |

The `/cp-decide` dialog step is inserted **first** in the answer menu, ahead of
any checkpoint option, so the default-highlighted choice stays non-destructive
— today's default was `approve`, and a stray Enter after closing the pager
must never land on it. Picking it opens the viewer and, on close, re-shows the
**same item's** menu: nothing is recorded, the operator's place is kept. The
option string is compared by identity (`PLAN_VIEW_OPTION`,
`src/contracts.ts`) before `resolveAwaitingResponse` ever runs, the same way
`"Type an answer…"` and `"Skip"` already are — it can never be recorded as an
answer or a note.

**After the plan has been read, the default option is `Done`, never the viewer
again** (cp-viewer-scroll-stuck). "First option = the viewer" is correct only
until the operator has been in the pager; keeping it there afterwards made
Enter reopen the pager, forever, which is what "even though I seen the plan and
I clicked done, we are still stuck on this decide" is: read the plan, press
Enter, read the plan, press Enter. So the menu is a **function of one bit of
state** (`answerMenuOptions` in [`src/awaiting-dialog.ts`](../src/awaiting-dialog.ts)):

| state | menu, in order |
|---|---|
| plan viewable, not yet read | `View the plan…`, the item's options, `Type an answer…`, `Skip` |
| plan viewable, already read | `Done reading — back to the list`, the item's options, `Type an answer…`, `View the plan again…`, `Skip` |
| no plan viewable (no artifact, or not a TUI) | the item's options, `Type an answer…`, `Skip` |

`Done reading — back to the list` records nothing: the item stays open and the
list is re-shown, so the operator can answer it now, answer another one first,
or pick `Done` and leave. Every label above is in `AWAITING_SENTINEL_OPTIONS`
and is compared by identity before anything is written — including when it is
*typed verbatim* as free text, which `driveAwaitingDialog` refuses too.

**The dialog loop lives in `src/`, not in the extension.**
[`src/awaiting-dialog.ts`](../src/awaiting-dialog.ts) owns the state machine
(item list → one item's menu → answer, skip, or the reading step) with every
prompt injected — `select`, `input`, `viewPlan`, `answer`. The extension only
adapts it to `ctx.ui` and keeps the "do not nag" bookkeeping, because the loop
was previously inline in `extensions/command-post/index.ts` where no test could
reach it, and the defect it shipped with was exactly the kind a test catches.
The machine never throws out of a decision: a failed snapshot, a dismissed
prompt and a refused write all end in an outcome (`AWAITING_DIALOG_MAX_ROUNDS`
and `AWAITING_ITEM_MAX_STEPS` bound it), because a dialog that throws mid-item
leaves the operator with a row they cannot answer.

**Scope.** Viewable: a research artifact (`state/artifacts/<job-id>/report.md`,
ship ids resolved via `Checkpoint.research_id` then `PipelineStore.findByShipId`)
and, behind `--gate`, a gate decision (`state/runs/<research-id>/gate-<n>-raw.json`,
falling back to `gate-<n>.json` when nothing had to be capped) — rendered
through `renderGateDocument` into the same markdown path a report already
takes. Gate files are not guard-protected (`tests/guards.test.ts`: "reading run
artifacts, briefs, envelopes and verdicts stays allowed"), so this adds no new
guard risk. **Not viewable, on purpose:** `events.jsonl` (that is `/watch`'s
surface) and `questions.jsonl` (`question_journal_read` already names `/watch`
as the one sanctioned surface for it; a second pager here would undo the point
of that guard).

**Idle timeout.** `PLAN_VIEW_IDLE_TIMEOUT_MS` equals `AWAITING_DIALOG_TIMEOUT_MS`
(§Awaiting you: "a human is never load-bearing for a dialog's liveness") — a
viewer left open resets `awaitingDialogOpen` on close exactly like every other
dialog, so an abandoned pager cannot silently suppress the auto-open or
`/cp-decide`.

**Windowing is the viewer's own job.** `render(width)` returns exactly the
viewport's row count every time — header, a slice of pre-rendered markdown
lines, footer — because the main-screen TUI paints a component's full line
list to the terminal; a component that ever returned its whole document would
be the wall of text this job exists to avoid. `Markdown.render` is memoized per
width (measured 22–57ms per render on a 70KB document) and never re-invoked
inside a scroll frame.

**The key map is the contract, and it is matched, never compared.**

| keys | what they do |
|---|---|
| `↓`/`↑`, `j`/`k`, `ctrl+n`/`ctrl+p` | one line |
| `PgDn`/`PgUp`, `Space`/`b`, `ctrl+f`/`ctrl+b`, `f` | one page (viewport minus one line of overlap) |
| `d`/`u`, `ctrl+d`/`ctrl+u` | half a page |
| `g`/`Home`, `G`/`End` | top / bottom |
| `/`, then `Enter` | search; `Escape` leaves the search box, not the viewer |
| `n` / `N` | next / previous match, wrapping |
| `q`, `Escape`, `ctrl+c` | close (returns to whatever opened it) |
| `Enter` | **nothing** — the accidental-answer guard |

Every one of those goes through pi-tui's `matchesKey` (and printable search
input through `decodeKittyPrintable`), never through `data === "G"`. That is
not style: on any terminal that negotiates the **Kitty keyboard protocol** —
Ghostty, Kitty, WezTerm, recent iTerm2, i.e. most of them — a printable key
arrives as a CSI-u sequence (`\x1b[103;2u` for `G`), so the three raw
comparisons cp-9c5 shipped (`G`, `/`, `N`) and the search box's `data.length
=== 1` test were dead on exactly the terminals the operator uses.
`tests/plan-viewer.test.ts` drives the whole key map twice, once legacy and
once with `setKittyProtocolActive(true)` and CSI-u bytes.

**The position indicator is chrome, not decoration.** The header always names
the visible range, the total and where it sits — `line 885-902/902 (bot)`,
`(top)`, `(all)`, or a percentage — because an operator paging through 70 KB
has no other way to know that the document moved at all. State changes ask the
host for a repaint (`onChange` → `tui.requestRender()`, docs/tui.md §Using
Components) so a frame is never stale, including when the idle timer fires.

**Not reversed by this feature:** cp-ti5's decision that `/watch --detailed`
never expands an artifact payload stands untouched — that guard is about a
*model-reachable* renderer being called repeatedly to reassemble a plan.
`/cp-plan` is a different renderer on a different, non-model-reachable path,
gated the way this whole section describes; it does not create a second way for
`/watch` (or anything tool-visible) to leak a body.

**Residual, operator-controlled, out of scope:** `PI_TUI_WRITE_LOG`, if an
operator sets it, appends every terminal byte — including a rendered plan — to
a debug log. It is opt-in and not a context path; noted here so nobody
discovers it by surprise, not because this feature changes its risk.

## Status view

[`src/status.ts`](../src/status.ts) is the read-only fleet view: `/status`, its
`--json` snapshot and the persistent widget. It is a **projection of files** —
`state/fleet.json` plus each run's `status.json`, plus one pid probe and an
optional `br list` join. It writes nothing, and it is built per call, because a
status view that caches is a status view that lies.

Three layers: `assembleStatus()` (pure, facts in / `StatusSnapshot` out, pinned
by golden files), `StatusReporter` (collects those facts), and the renderers
(`formatStatusTable`, `formatStatusJson`, and the widget's own renderer in
[`src/widget.ts`](../src/widget.ts) over the cell vocabulary all three share,
[`src/status-render.ts`](../src/status-render.ts)). Only the
renderers know about glyphs and column widths.

### Three liveness facts, never collapsed

| field | source | means |
|---|---|---|
| `phase` | `fleet.json` | job policy: `waiting` \| `held` \| `done` \| `failed` |
| `run_phase` | `state/runs/<id>/status.json` | process liveness projected from observed events; `null` when the run has no readable projection |
| `alive` | pid probe, taken now | the pid answered `kill(pid, 0)` |

The renderer's `RUN` cell combines them under one rule: `exited` is printed
**only** for an observed close. A pid that no longer answers prints `no-pid`,
because that is what we know; an absent projection prints `-`. And a record
with `worker.exited_at` is never probed at all — an observed close outranks a
live pid, since pids are reused and observations are not (the same precedence
reconcile uses).

**`stalled` stays retired.** In command-post it was "idle pane + old dispatch +
no `reported_at`": a guess about an unobservable pane. Nothing here is derived
from age; age is displayed, never interpreted.

**Scope, risk and thinking travel with the job, read back verbatim
(cp-status-scope-risk).** The routing decision that picked a job's model
(cp-rte, [§Routing config](#routing-config)) is persisted once, at dispatch time,
on `FleetRecord.routing` (`JobRoutingSchema`: `scope?`, `risk?`, `thinking?`,
`inferred`, `provenance?`, `reasons?`) and carried straight through onto
`StatusJob.routing` — `/status`,
the widget and the status block's "In progress" section never recompute it, so
a rendered value can never drift from what actually routed the job. Two
renderers, `formatScopeRisk()` and `formatThinking()`, share the one convention:

| situation | scope/risk cell | thinking cell |
|---|---|---|
| chosen — the caller named it, or a planner's `self_assessment` did | `S/low` | `medium` |
| inferred (`inferScopeAndRisk` found the signal) | `M?/high?` — `?` **per axis** | `medium` (thinking is never itself "inferred" in this sense) |
| one axis inferred, the other named | `M?/low` — one inferred axis never relabels the other | `medium` |
| defaulted — nobody named it and nothing was found | `-` on that side; routing used `S`/`low`, but nobody decided it | `-` |
| a legacy record with only the one-bit `inferred` flag | read exactly as it rendered then, on both sides | unchanged |
| no `routing` at all — dispatched before this field existed | `—` (em dash), the whole cell | `—` |

The missing-vs-guessed distinction is the point: a legacy job with no recorded
decision must never render as a fabricated `S/low` — that is exactly the
silent-default bug cp-rte fixed for routing itself, now guarded on the read
side too. The table adds `SCOPE/RISK` and `THINK` columns; the widget and the
status block fold both into one `scope/risk/thinking` cell placed right after
the model, and degrade the same way the model already does (dropped whole
before any field after it is touched, never truncated into something else
looking valid) — tokens and cost are never the casualty.

**A long tool call is a measured fact, not a phase.** `current_tool_seconds`
(`jobs[].current_tool_seconds`, `/status`'s `TOOL` cell, `/watch`'s header) is
sourced from the same `current_tool.started_at` the run projection already
records — no second source of truth for it. Past `LONG_TOOL_CALL_SECONDS` it
grows a marker (`bash (7m!)` in the table/widget, `! long-running tool call: …`
as a row note, `current tool bash running 7m !` in `/watch`'s header). This
invents nothing: "this call has been running for 7 minutes" is an observation,
not a guess about *why* — a real build and a wedged editor look identical from
here, so nothing is auto-killed and no `stalled` phase is added. This is the
detection half of the fix for the incident where a worker wedged for seven
minutes inside `git rebase --continue` (no `GIT_EDITOR` set, vi blocked on
stdin) and nothing surfaced it; the prevention half is `NONINTERACTIVE_WORKER_ENV`
(`src/worker-manager.ts`), which sets `GIT_EDITOR`/`EDITOR`/`VISUAL=true`,
`GIT_PAGER`/`PAGER=cat` and `GIT_TERMINAL_PROMPT=0` on every worker at spawn —
not as brief guidance a worker could skip.

**A tool call that has gone silent is surfaced to the parent, once
(cp-wedged-tool-call).** The paragraph above is the *display* half: a duration
rendered where an operator happens to look. It is not enough on its own, and
the incident that proved it is on record — two workers each stopped with
`tool_execution_update` as their final event and sat for **fifteen hours**.
`/status` said `working` the entire time, correctly, because a turn really was
in flight. Both held their leases; one had four modified files that had to be
salvaged by hand. Neither of them was the cp-4dx cause recurring: both were
ordinary non-interactive commands (`npm test … | tail -50` and `npm test … |
grep -A 30 …`), so there was no narrow command left to de-interactivize. What
was missing was not a threshold, it was a *wake*.

An envelope is normally the only thing that wakes the parent session. A wedged
worker files no envelope, so this is the second — and the only other — thing
allowed to: `src/wedged.ts` folds the same file-derived `StatusSnapshot` the
fleet widget already computes, and a newly wedged call arrives as a
`cp-wedged` follow-up message (headline and facts, never a worker's output),
exactly like `cp-envelope`. It is announced **once** per call, not once per
widget tick, and a fresh session re-announces a still-wedged call on purpose.

| | `LONG_TOOL_CALL_SECONDS` | `WEDGED_TOOL_CALL_SECONDS` |
|---|---|---|
| default | 300s (5m) | **1800s (30m)**, `CP_WEDGED_TOOL_CALL_SECONDS` overrides |
| measures | time since `current_tool.started_at` | time since `current_tool.last_progress_at` (**silence**) |
| on `StatusJob` | `current_tool_seconds` | `current_tool_idle_seconds` (optional) |
| effect | a marker in the table/widget/`/watch` | that, plus a `cp-wedged` message to the parent |

**Hard bounds (`src/bounds.ts`).** Per-job wall-clock per round (default 5400s / 90 minutes) and a cap on `tool_execution_start` events (default 900). Wall-clock precedence: per-dispatch override on `cp_dispatch` > home-local `data/worker-bounds.json` `{"wall_clock_seconds": <positive integer>}` > env `CP_JOB_WALL_CLOCK_SECONDS` > default. The home file exists because the bridge strips `CP_*` before the parent launches, so an env cap never reached workers; a present file whose `wall_clock_seconds` is missing, misspelled or not a positive integer refuses the dispatch, naming the file and field, instead of falling back. Tool-call cap: override > `CP_JOB_TOOL_CALL_CAP` > default. The effective bounds are resolved once and frozen on the fleet record (`bounds`) for direct, script and both pipeline dispatches (start and advance); revive and bounded-recovery redispatch reuse the recorded value, never re-resolve it. A round starts at spawn and again when `cp_send` delivers a prompt to an idle worker (`HardBoundsWatch.rearm`, run log `wall_clock_rearmed: true`); a steer, a follow_up (queued) or a failed send never rearms, and the tool-call count is never reset. A breach requests a graceful stop then kill on the observed-close path, records `failed` with `wall_clock_exceeded` or `tool_call_cap_exceeded` (class names the bound and the measured value), leaves the worktree untouched, and wakes the parent once as `cp-bound` with settle-boundary evidence of what is on disk. `/doctor` reports the effective caps as `config.bounds.wall_clock` and `config.bounds.tool_call_cap`. Soft cost/token budgets are unchanged. Mission-level caps (total spend, total jobs) are declared here and enforced by the mandate ticket, not this module. A wedged call still fires at 30 minutes; at the wall-clock cap the job is ended.

**Why a duration is allowed here when phases forbid one.** `stalled` is still
retired and nothing about a *phase* is inferred from age. Four things keep
this on the right side of that line:

1. **The fact is structural, not temporal.** The run's append-only log holds a
   `tool_execution_start` with no matching `tool_execution_end`. An unmatched
   pair is an observation, the same kind of fact as an observed process exit.
   `stalled` had no fact underneath it at all: it read a dispatch timestamp and
   guessed about a pane nobody could see.
2. **The duration is a reporting threshold, not a verdict.** It answers "when
   is this already-observed open call worth an operator's attention", never
   "what state is this job in". No `JobPhase` moves, no `RunPhase` moves, and
   no phase is added; `/status` still says `working`, because that is true.
3. **Progress resets the clock.** What accumulates is silence since the last
   `tool_execution_update` *for this exact `tool_call_id`*, not the call's age.
   A build or a backtest that keeps emitting output is never surfaced however
   long it runs — an hour-long ML backtest is legitimate work and stays
   legitimate. A projection written before `last_progress_at` existed falls
   back to `started_at`, and a snapshot with no `current_tool_idle_seconds` at
   all reads as *not measurable*, which is never *wedged*.
4. **Surfacing is not killing.** There is no kill path in `src/wedged.ts` — no
   signal, no lease action, nothing. A wedge and a genuinely silent long build
   are indistinguishable from here, so "possibly wedged" is the honest verdict
   and the operator decides. Ending a worker stays what it already was: an
   explicit operator action (`cp_teardown`, or `/cp-revive` once it is gone).

A dead worker's open call is deliberately *not* reported here: that is already
an observed close with no envelope, surfaced by the widget's ATTENTION section
and classified by `src/failures.ts`. A wedged call is only ever a call on a
**live** worker whose projection says `working`.

**pi's own auto-retry is not a wedge.** After a transient model/API failure pi
restarts its agent loop, which produces `auto_retry_start`/`auto_retry_end` and
an `agent_start` with no matching `agent_end`, with a real pause and no tool
activity in between. `cp-viewer-scroll-stuck-dam` was observed doing exactly
this while healthy, and recovered on its own. Three things keep it unflagged:

- **Agent-level asymmetry is not an input.** The only unmatched pair this reads
  is `tool_execution_start` → `tool_execution_end`, projected as `current_tool`.
  An unmatched `agent_start` cannot reach the detector by any route, and a test
  pins that so a later refactor cannot quietly start treating it as a signal.
- **An in-flight retry is excluded outright.** `RunStatus.retrying` is set by an
  observed `auto_retry_start` and cleared by `auto_retry_end` (and by
  `agent_settled`, `process_exit`, `spawned`). A pause explained by an observed
  event is not a wedge, and `StatusJob.retrying` carries the fact to the
  detector and to the `/status` row note alike.
- **A retry refreshes the progress mark of any call open across it.** The loop
  demonstrably ran, so whatever is still open was not what blocked it, and its
  silence is measured from the retry rather than from a start that may now be
  hours old. This is what stops a stale `current_tool` becoming a permanent
  false positive.

A healthy job has matched tool start/end counts (54/54, in that case) and recent
activity, and matches nothing here. The two casualties had an unmatched
`tool_execution_start` whose last activity was hours old, with a
`tool_execution_update` as the final line in the file.

**Considered and declined: a worker-side bound on each tool call.** A worker
that capped its own tool calls would have to choose a number that is wrong for
somebody: the same 30 minutes that catches this incident aborts the hour-long
backtest that was correct. It also puts the decision in the process least able
to make it — a wedged worker is by definition not running, so a bound it set
itself is enforced by the thing that is stuck. And `timeout(1)` is not
installed on these machines (BSD userland), which three separate workers have
now rediscovered, so the obvious shell-level version is not available either.
The parent is awake, has the files, and can ask a human. It watches.

**Considered and declined: a heartbeat event for a long-running tool call.**
It would keep `event_count`/`last_activity_at` from *looking* frozen while a
worker is merely blocked inside one call. Declined for this fix: it would add
a synthetic event with no corresponding pi RPC activity (the transport genuinely
saw nothing, and `events.jsonl` is supposed to be exactly what was observed),
and `current_tool.started_at` already gives `/status` and `/watch` everything
they need to compute the duration without one. If a future need appears for
`event_count` itself to move during a long call (e.g. a liveness probe distinct
from tool duration), it should be its own `cp` event kind, reviewed on its own,
not bundled into this fix.

### What the port kept, changed and dropped

| `cmdp status` | here | why |
|---|---|---|
| `nodes[]` with `job_id`, `project`, `kind`, `delivery`, `title`, `br_status`, `branch`, `cwd`, `timestamp`, `time_source` | `jobs[]` with the same fields (`cwd` → `worktree`) plus `profile`, `role`, `model`, `run_phase`, `current_tool`, `turns`, `tool_calls`, `usage`, `alive` | the RPC rebuild knows more about a worker than a pane ever did |
| `broker` block, degraded banner | `ledger` block, degraded banner | there is no paste broker; the shape survives because the *policy* does (below) |
| `joined_via`, `cli`, `pane`, `session`, `drawing` | dropped | the join is `job_id` (fleet.json is keyed by it), there is one CLI, and there are no panes |
| `glyph` | renderer-only | it was a field for the HTML dashboard, which is out of scope |
| `edges[]` (muxa parent/child) | dropped | a worker's parent is this session, always |
| `phase: "orphaned"` nodes synthesized from br | `unclaimed[]` | see below |
| `--origin` filter | `--project` filter | origin scoping is deferred; `origin` is still carried on every row |
| `--html`, `--serve`, `--pane` | dropped | explicitly out of scope |
| ported `age()` (`Ns`/`Nm`/`Nh`/`Nd`, negative clamps to 0) | identical | |

**Degradation is a policy, not an accident.** A ledger join that fails (br
missing, db locked, anything) sets `ledger: {ok: false, queried: true, error}`
and the view still renders every worker, with a `LEDGER degraded (…)` banner —
the ported "BROKER degraded (unavailable) -- nodes below may be stale" line.
This is the one place the fleet deliberately does **not** fail closed, and the
reason is that fail-closed protects work: a *read-only* view refusing to show
running workers because a title lookup failed would hide the fleet exactly when
something is already broken. Nothing is dispatched, leased or written from a
degraded snapshot; the degradation is on the record, in the payload.

**`unclaimed[]`** is the ported `orphaned` node, minus the invented phase. It
lists jobs br calls `in_progress` that this home has **no fleet record for** —
real evidence (a dispatch that never landed, a restart that lost a record,
another machine). It is not given a job phase, because the four phases describe
records this home owns, and a fifth phase for something we cannot observe is
precisely the guessing this rebuild exists to end. Its `time_source` is
`br_updated_at` (a fleet row's is always `dispatched_at`), and br's sub-second
timestamps are truncated to the contract format rather than dropped.
`unclaimed` is measured against the **whole** fleet even when the view is
filtered: a job hidden by `--project` is still claimed.

### Wait reasons on a row

A `held` job's row used to say only what its *worker* was doing (`exited`,
`no-pid`), never why the delivery could not advance. `StatusJob.ci` carries that
context — `head_sha` and `state` straight from `state/ci-watch.json`'s last
observation, plus `reviewed` when a `cp_review` **pass** exists for that exact
head (`state/runs/<id>/review-<n>.json`, read by `readReviewPassHeads`). Carried,
never re-derived: `/status` and the widget stay files-only, because a `gh` call
on a render path is not a widget.

`waitReason()` ([`src/status-render.ts`](../src/status-render.ts)) is the one
rule over those facts, shared by both renderers — the table prints
`waiting on: <phrase>` under the row, the widget appends `waits: <phrase>` to
the activity cell (bounded, and dropped whole with the column when the terminal
is narrow):

| fact | phrase |
|---|---|
| no head on record, `delivery:pr` | `a pushed head on origin` |
| `in_progress` / `unknown` | `CI on <head>` |
| `superseded` | `CI to start on <head>` |
| `failed` | `a fix for red CI on <head>` |
| green (or the gate's `unreviewed`), no review pass on that head | `review of green <head>` |
| green, reviewed head | `merge of reviewed <head>` |
| `already_merged`, `job_gone`, a reviewer in flight, or any job not `held` | nothing at all |

`ci.state` is a bounded string on the contract only because `contracts.ts`
cannot import the gate that imports it; its producer is `ciStateOf`
([`src/ci-watch.ts`](../src/ci-watch.ts)) and its type is `MergeAskCi`, so
`waitReason`'s switch is keyed on that union through a compiler-checked
`Record<MergeAskCi, true>` — a classification added to the gate cannot slip past
this renderer. Any value that is *not* a member falls through to `CI on <head>`,
which is the one deliberate free-string path: a file written by a newer (or
hand-edited) home still names a head worth waiting on.

Every phrase fits `WAIT_REASON_MAX_CHARS` (27, the length of
`a fix for red CI on d48a81d`), and that is a **bound the phrases satisfy**
rather than a truncation applied to them: the widget sizes its cell from the
constant, so a short sha is never cut in half — half an identifier in a status
row is worse than none.

Three deliberate absences. **A job that is not `held` has no wait reason**: a
live worker's row already says what it is doing, so active and unblocked rows
are byte-identical to what they were. **A reviewer in flight is not a wait
reason either**, though it is plainly a wait: both surfaces already say so where
it belongs (`review 2 running 4m (deadline …)` under the table row, `review 2 ⋅
4m` in the widget's activity cell), and one fact printed twice on one row is
noise. The suppression lives in `waitReason` itself, so the two renderers cannot
disagree about it. And **a pending checkpoint is never rendered here**: an
authorization is a human decision that lives in **Awaiting you** (§The awaiting
store), and restating it as an ordinary blocker would give one decision two
homes. Nothing here is parent-authored judgment — that is what the status
block's `waiting_on` is for.

### Filters, counts and the widget

- `include: "active"` (default) shows `waiting`, `held` and `failed`; `"all"`
  adds `done`. Torn-down jobs are history, and history is br's job.
- **Counts must equal rows.** `validateStatusSnapshot` re-checks every count and
  the job-id uniqueness before `assembleStatus` returns; a snapshot that
  disagrees with itself throws rather than renders. `usage` totals only the
  rows shown, so a filtered view's total matches what is on screen.
- Row order is fully specified — phase (`waiting`, `held`, `failed`, `done`),
  then oldest dispatch, then job id — because golden files are the test and
  "whatever the map iterator did" is not an order.
- The **widget** (`ctx.ui.setWidget`, key `command-post`) renders from
  `statusNow()` — **files only, never br** — because it also refreshes on a
  timer (`WIDGET_REFRESH_MS`, unref'd) so ages and tool names stay true between
  events. Identical lines are never re-sent: in RPC mode every `setWidget` is a
  protocol message. An empty fleet clears the widget instead of drawing a header.
  Its layout is [§The widget](#the-widget) below.
- Titles come from `br list` (never `br show`, which inlines comment bodies —
  the T19 hazard) and only `title` and `status` are kept from each issue.

### The widget

[`src/widget.ts`](../src/widget.ts) is the widget's renderer:
`renderFleetWidget(snapshot, {width, maxLines, awaiting, ascii})` in, one
`{text, role}` per line out. It is pure — every age is measured against the
snapshot's own `generated_at` — so the golden files need no terminal, no clock
and no theme. `statusWidgetLines` is the plain-string adapter.

**Grouped by what it asks of you.** One line per worker, sorted by phase, gave
every row the same weight, so the one row that needed a human was invisible.
Three sections instead, in this fixed order, each drawn only when it has a row:

| section | membership (`jobState`, `src/status-render.ts`) | glyphs |
|---|---|---|
| `NEEDS YOU` | `open_question`, or an open Awaiting-you item names the job | `?` asked · `◆` decision |
| `ATTENTION` | `phase === "failed"`; `run_phase === "exited"` with no envelope; a tool call open past `LONG_TOOL_CALL_SECONDS`; plus the `unclaimed` note | `✗` · `!` |
| `RUNNING` | **everything else** | `▶` working · `○` idle/other |

`RUNNING` is the residual on purpose: membership is total, so a job can never
fall out of every section and disappear. Row order within a section is
unchanged (phase, then oldest dispatch, then job id), and the three liveness
facts stay uncollapsed — policy is the section, liveness is the word on the
row, so nothing has to be parenthesised as `working (held)`.

**Height: `WIDGET_MAX_LINES = 10`, marker included.** pi slices a widget at
exactly ten lines and appends its own `... (widget truncated)`
(`InteractiveMode.MAX_WIDGET_LINES`), so ten is a ceiling, not a taste — past it
our overflow line is what gets eaten. Allocation: the `⧗` marker, the headline,
then one header plus at least one line per section, then the remainder by
priority (`NEEDS YOU`, `ATTENTION`, `RUNNING`). Overflow collapses **per
section** with a count (`… 8 more running (/status)`); `NEEDS YOU` is collapsed
last and never dropped without its count. Below the floor every section
collapses to one summary line.

**Width is a parameter, never a guess.** In the TUI the widget is a component
factory, so `render(width)` is handed the real width; over RPC (where factories
are ignored) it is the documented `WIDGET_MAX_WIDTH = 100` fallback. This
matters because pi *wraps* an overlong widget line rather than truncating it
(`Text#render` → `wrapTextWithAnsi`, with a one-column inset on each side): a
line over budget silently becomes two and the editor jumps. The old renderer
chose its degradation **per row** against a hardcoded 100, which is why the
model vanished from exactly the two rows with the longest job ids. The ladder now
runs once for the whole fleet — first dropped to last: `SCOPE/RISK/EFF` →
`MODEL` → `TOKENS` → `TOOL` — so a column is on every running row or on none.
Never dropped: the glyph, the job id (truncated with `…`, minimum 12 columns),
the state/summary text, the age and `COST`. Floor: 60 columns.

**No blank lines, ever.** `Text#render` returns nothing for a whitespace-only
line, so a spacer would vanish in the TUI and survive over RPC — two layouts
from one renderer. Section headers are the separator.

**One unit per column.** `formatTokens` picks a unit per value, which is right
for a cell and wrong for a column (`558.2k` above `2.39M` cannot be compared).
The widget's `TOKENS` column takes one unit from the fleet maximum
(`chooseTokenUnit`); `/status`'s table is unchanged.

**Typography, and what a terminal cannot do.** The operator asked for the worker
rows in a smaller font than the headers. **No terminal application can set a
font size** — pi's `Theme` exposes exactly `fg`/`bg`/`bold`/`italic`/
`underline`/`inverse`/`strikethrough`, a widget is a list of lines, and a cell's
size belongs to the emulator. Double-height (DECDHL) is not a substitute: pi
renders a diffed, padded, full-width buffer and would count a double-height line
as one row while it occupied two. So the hierarchy is carried by intensity,
named rather than silently swapped — marker `bold`+`warning`, headline
`bold`+`text`, section headers `bold`+`accent` (`error` for `ATTENTION`),
running rows `text` for the job id and `dim` for everything after it. The mapping
lives in `extensions/command-post/fleet-widget.ts` and runs **only** in the TUI
path; RPC gets plain strings, because a client receives them verbatim. Colour is
never the only carrier: every state is also a glyph and a spelled-out word, so
`NO_COLOR`, a monochrome terminal and the RPC path lose emphasis and lose no
information.

**ASCII fallback.** `CP_WIDGET_ASCII=1` maps `○◆✗▶⧗…·—` to `o # x > ! ... - --`
and replaces any other non-ASCII with `?`. It is an env flag because this repo
has **no terminal-capability detection**; inventing a probe here would be a
guess, and a guess about the terminal is the defect this design fixed.

### The status block is opt-in

It is **opt-in** (AGENTS.md §Status block): the parent renders it when a status
summary is asked for or a turn needs the full picture, and not otherwise.

This is a guidance change only — no gate moved. Nothing in `src/` renders,
requires or counts blocks, so every rule that reads or writes through the same
paths behaves exactly as before:

- An **open Awaiting-you row** is durable in `state/awaiting.json` and reachable
  without any block: the widget marker (`⧗ N decisions awaiting you`) and
  `/cp-decide` both read the store directly.
- A **deferred merge ask** is likewise stored, re-gated on every render of the
  set (`awaitingSnapshot`, and the sync widget path for display), and raised
  **by the two events that can change the answer, in runtime** — a `cp-ci`
  observation and a passing `cp_review` verdict (§The deferred-row recheck is
  runtime). This used to be prompt guidance ("always end such a turn with
  `cp_status_block`"), i.e. a model behaviour: an omitted call left a now-ready
  decision hidden. It is now `src/deferred-recheck.ts`, so a row surfaces on the
  event its blocking fact changed, whatever the parent does with its turn.
- A row deferred on **`unknown`** has the one gap those two events do not
  cover: observability can come back with nothing to announce (`gh` reachable
  again, a run finally listed for a branch nobody pushed to since). No event
  fires, so the fallback is manual — the parent invokes `cp_status_block`
  itself, and that render re-gates the row. "It comes back by itself" is true
  of the `ci` and `unreviewed` causes; for `unknown` it is true only when a
  `cp-ci` tick observes the change.
- Review, authorization and merge authority are untouched: a block was never
  evidence and never permission.

That guidance is the *only* thing per-turn rendering ever provided, and it is
checked statically: no module under `src/` imports `status-block.ts` except the
two that render (`awaiting-rows.ts`, `shipped-seen.ts`), and no `src/` module
references `cp_status_block` outside a comment (`tests/status-block.test.ts`).
The gates — `AwaitingStore`, `evaluateMergeAskCi`, `reviewDeferred`, the CI/PR
watch — hold their invariants with no block rendered at all; a render only
decides *when* an operator sees a row, never whether the rule applied.

### The status block's Shipped memory is persisted, keyed by session

AGENTS.md §Status block: Shipped is "capped to what is new since the block you
last rendered this session; a job already shown collapses to a one-line count
instead of repeating its row". `renderShipped` implements that as a pure
function of an already-shown set, and always did.

The set itself used to live in one `Set` in the extension's activation closure,
reset in the `session_start` handler. That is not the same thing as "per
session": pi fires `session_start` with `reason: "startup" | "reload" | "new" |
"resume" | "fork"`, and a reload emits `session_shutdown` for the old extension
instance and `session_start` for a new one **inside the same session, with the
same conversation and the same session id**. Every reload therefore dropped the
memory, and the next block replayed the session's entire shipped history (~80
rows, observed twice), burying the Awaiting-you table above it. The block before
it and the block after it were both correct, because the replaying render
refilled the set — which is exactly why it read as intermittent and unrelated to
its own inputs.

So the set is durable: `state/status-block-shipped.json`, one entry per session
id (`ctx.sessionManager.getSessionId()`), read from disk on every render and
written back after it (`src/shipped-seen.ts`). A new extension instance in the
same session sees what the previous one reported; a genuinely new session starts
empty, which is the contract. Bounded by `SHIPPED_SEEN_KEEP_SESSIONS` sessions
and `SHIPPED_SEEN_MAX_IDS` ids per session, oldest dropped first.

**Why the session id is the right key, and the evidence for it.** The claim this
rests on is that a reload keeps the id, so the memory it keys is still the right
memory. That is not inferred from the reason list; it is what pi's own reload
does. In `dist/core/agent-session.js`, `AgentSession.reload()` emits
`session_shutdown { reason: "reload" }`, invalidates the old extension runner,
reloads settings and resources, rebuilds the *extension* runtime, and emits
`session_start { reason: "reload" }` — it never touches `this.sessionManager`,
which is assigned exactly once, in the constructor. So `getSessionId()` returns
the same string before and after a reload, while every variable in the old
extension instance's closure is gone. That asymmetry is the defect in one line,
and it is why the fix moves the state rather than the reset.

The other branch is pinned by a test rather than assumed away: if a rebind ever
*did* produce a new id, the contract for a new session applies — the set is
reported once, nothing throws, and the previous session's entry survives
untouched in the file (`tests/shipped-seen.test.ts`).

**A corrupt file is degraded for one render, not forever.** `read()` throws on
an invalid document, and `record()` reads before it writes — so without care one
bad file would fail every read *and* every write from then on, replaying a
section on every render for the life of the home. Instead the write rebuilds the
file from empty and says so, and every degradation message names the file and
states that `state/status-block-shipped.json` is safe to delete: it records only
which rows have already been printed, so deleting it costs one repeated section
at most. The rebuild's own cost — other sessions' entries in the unreadable file
are gone — is named in the same warning.

**Concurrency: atomic writes, no lock, and a bounded worst case.** The file is
written only by `cp_status_block`, i.e. by an attached parent taking a turn; no
worker and no timer touches it. The write is `atomicWriteJson` (temp → fsync →
rename) — the mechanism cp-nqj established for every whole-file write here (§No
write ever truncates a memory file), because `writeFileSync` opens `O_TRUNC` and
a kill between the open and the write leaves nothing; `durableAppend` is the
wrong half of that precedent for a document that is rewritten rather than added
to. A structural test in `tests/shipped-seen.test.ts` keeps this store on that
path, exactly as `tests/memory.test.ts` does for the memory files. So a reader
never sees a torn document and two parents on one home cannot corrupt it. They
can interleave: each writer re-reads, replaces its own
session's entry and copies the rest, so two writers that read before either
writes can lose *another session's* entry — whose cost is one repeated Shipped
section in that other session, never a wrong row and never a lost PR url.
Sequential writers (the normal case, including a reload replacing a parent) lose
nothing, which is pinned by a test. A lock is deliberately not taken: it would
prevent a duplicated section and risk a stale lock file blocking the parent's
only report.

What this deliberately is **not** is a cap on the Shipped section's output. A
full replay is evidence that the seen-set was lost; truncating the rows would
have hidden that evidence and left the cause in place. Nothing here truncates a
row, and nothing here drops a PR url.

Degradation is loud, never silent: an unreadable or unwritable memory is a
warning through the tool's own `warn` channel (`ctx.ui.notify`, or stderr
headless) and the block still renders. Within one process an in-memory mirror is
unioned with the file, so a failed *write* cannot make a row this process
already printed look new to the very next render.

### Where long output goes

`/status` and `/doctor` render documents, not notices, so a payload longer than
`LONG_OUTPUT_LINES` (6) is delivered as a **durable entry**
(`pi.appendEntry("cp-output", …)` with a registered entry renderer) instead of
`ctx.ui.notify`. Entries render in the transcript, survive the session, and
**do not participate in LLM context** (docs/extensions.md) — so this changes
where the operator reads a 40-line table, not what the model can see, which is
nothing either way.

Two exclusions, both asserted in `tests/output.test.ts`:

- **`--json` always notifies.** Headless callers (and this repo's own RPC tests)
  read `extension_ui_request`; an entry carries no protocol event, so a JSON
  payload delivered as one would be invisible to the caller that asked for it.
- **Only `ctx.mode === "tui"` gets entries.** In RPC mode `hasUI` is true because
  the dialog sub-protocol works, but the client is a program.

Without a UI at all (print/json modes) the text goes to **stderr**: stdout
belongs to the transcript and the event stream.

## Watch

[`src/watch.ts`](../src/watch.ts) renders `state/runs/<job-id>/events.jsonl`.
It replaces `muxa tail`, and the difference is the point: `muxa tail` scraped a
terminal pane, so it could show only the last lines of *text* and could not tell
a working worker from a hung one. The log is a fact stream the parent teed
itself, so the viewer renders **events** — tool calls with the argument that says
what they did, turn ends, assistant text, envelopes, gate decisions, budget
warnings, the observed exit — and behaves identically while a worker runs and
long after it is gone.

Surface: `/watch <job-id> [--detailed] [--last N] [--export]`, in the parent
session. **There is no CLI** (T30): `cmdp watch` existed, nothing but a human
ever ran it, and `/watch` already did everything it did except an unbounded live
tail. A second entry point had to keep agreeing with the parent about the home,
the fleet and the renderer, so it was deleted along with `follow()`. A live tail
is `tail -f state/runs/<job-id>/events.jsonl` — the log is a file on purpose, and
that is also what makes it readable post-mortem, by a restarted parent, or by a
parent that never dispatched the job.

### Who is allowed to loop

| | `/watch` (the parent session) | `tail -f events.jsonl` (a human) |
|---|---|---|
| follow | **refused**, and the error says why | as long as you like; it is your terminal |
| default extent | the last `PARENT_TAIL_DEFAULT` (40) lines | the whole file |
| `--export` | **prints** `pi --export <session-file>` | run it yourself |

This is the ported "inspect once, do not loop" rule, mechanised. The parent
wakes on envelopes (T16) and never polls, so a follow loop inside its session
would be both pointless and expensive; a bounded tail is the most it needs. And
`--export` produces a whole transcript, so the parent gets the *command* rather
than the output: the one thing its context must not become is a place other
sessions' contents are pasted.

### Bodies, caps and torn writes

- A worker's run log records what the worker did, **including text it wrote**
  (see [§Artifacts](#artifacts-and-parent-context-guards) — this is the
  surface `watch` renders). So every rendered line is clipped to
  `WATCH_LINE_CAP` (200 chars) in both modes, and detailed mode shows at most
  `WATCH_DETAIL_LINES` (5) lines of one event's payload and says how many it
  dropped. A viewer summarizes work; it never reproduces an artifact.
- **An artifact payload is never expanded** (cp-ti5, decided). Those caps bound
  one *event*, not a session, and `/watch --detailed` can be called repeatedly —
  so a patient parent could reassemble a research plan in its own context, which
  is precisely what the T19 guards exist to prevent — a decision §Reading the
  plan (cp-9c5) does not reverse: that section's viewer is a different,
  non-model-reachable path (a slash command and a dialog, never a tool call),
  gated on a real TUI a human is looking at, not a renderer a model can call
  repeatedly. A tool call whose arguments
  name the artifact store (or `CP_ARTIFACT_PATH`) is remembered by its
  `toolCallId` at `tool_execution_start`, and its `tool_execution_end` renders
  one line saying the payload is not shown, with `cp_artifact get` named as the
  way to obtain it. That includes the **failure** headline, which clips the
  payload as well — the first implementation redacted only the detail lines and
  leaked the body into the summary. The alternative (restrict `--detailed` to a
  CLI, as `--follow` once was) stopped being available when T30 deleted the CLI:
  `/watch` is the only viewer, so the rule has to live in the renderer.
- **An unknown run is not an idle one.** A job id this home never dispatched is
  `WatchError` `unknown_run` — the ported `muxa tail` behaviour (which exited
  **2**), for the ported reason: nobody may read "no output" as "idle". A
  path-unsafe id is refused before it touches the filesystem (`unsafe_id`), and
  `knows()` is total, because a probe must not throw on hostile input.
- **A torn log still renders.** `parseWatchLines` skips lines that are not JSON,
  counts them, and the view says so. This is deliberately *softer* than
  `parseEventLog`, which still throws for state-critical paths
  (`rebuildStatus`): a projection built over a hole would be a wrong number,
  while a viewer refusing to open the log of a worker that was `kill -9`'d
  mid-append fails exactly when it is needed most. `follow()` buffers partial
  lines and never parses one — the log is append-only, so a short read means
  "mid-line", and the completed line parses whole.
- A follow and a post-hoc render of the same log produce the **same lines**
  (asserted), because both fold the same events through the same renderer.
- `--export`'s session file comes from the fleet record, then the run
  projection; a missing or deleted session file is reported, never invented,
  and the answer names the run log as the history that survives.

## Doctor

[`src/doctor.ts`](../src/doctor.ts) diagnoses the environment: `/doctor` and
`/doctor --json`. Ported from `cmdp doctor` minus muxa, tmux, worker CLIs and
Slack. Three rules carried over, and they are the design:

1. **A finding names its fix.** The old shape was `{what, kind, fix}`;
   `validateDoctorReport` now *refuses* a report whose non-`ok` finding has no
   `fix`, so "a diagnosis nobody can act on" is a contract violation rather than
   a style problem. Branch on `check`, never on the prose.
2. **Advisory stays green.** `warn` is for degraded-or-absent-by-choice (no
   `data/routing.json`, no `.beads/` yet, no `state/` yet, a dead worker
   reconcile will handle). `error` means *this home cannot dispatch*, and only
   an error sets the exit code (`DOCTOR_EXIT_BROKEN = 2`, ported). A fresh home
   is therefore green, which is what makes the green meaningful.
3. **Read-only.** Doctor creates nothing and repairs nothing — it is what an
   operator runs when they already do not trust the state. Fleet findings are
   *reports*: a dead worker is a `warn` with the revive command, and moving it to
   `failed` stays reconcile's job (`session_start`).

Checks: `host.*` (git, br, treehouse, pi — all four required), `ledger.*`,
`package.*` (worker-reporter, profiles validate, one profile per role, every
`briefTemplate` exists), `config.*` (routing/budgets/projects parse) including
`config.budget.<profile>` (each profile's live effective ceiling against the
current `data/budgets.json`, `warn` when the fleet config clamps it — cp-sr5),
`models.*`, `scaffold.*`, `home.gitignore`, `fleet.*`, `session.tools`, and
`storage.*` (warn-only: stray files in `state/`, home entries outside
`.pi-command-post/` and `.beads/`, a `handoffs_dir` outside the home; see
[storage.md](storage.md#doctor-checks)).

When the home is also the running package's source checkout, `/doctor`
(`home.checkout`) and `cp_next` compare HEAD with the local `origin/main` ref.
A clean, strictly behind checkout warns: `home is N commits behind origin/main:
git merge --ff-only origin/main, then restart the parent at a quiet point`.
Dirty, ahead, diverged, and separate state homes receive no update advice;
an unreadable comparison is reported as unavailable. This is advisory only:
no fetch, pull, merge, or restart is performed, and dispatch recommendations
do not change. The comparison sees only the last fetched remote-tracking ref.

### Foreign tools (`session.tools`)

The artifact-body guards hook only `read` and `bash` (plus `grep`/`edit`/`write`
for the same paths). A global extension or skill (pi-lens, fetch tools, other
agent skills) can still read `state/runs/<id>/artifact.md` and pollute the
parent's context. At `session_start` the extension records `pi.getAllTools()`;
`/doctor` diffs that list against pi builtins (`PARENT_BUILTIN_TOOLS`) plus
command-post's own `cp_*` tools, and **warns** (never errors, never refuses)
about the rest, with a capability guess (`file_read` / `shell` / `network`)
from the tool name and parameter schema. Tools that can read files or run a
shell are marked *outside guard coverage*.

A headless bridge parent is started with `PARENT_BRIDGE_FLAGS` (`--no-extensions
--no-skills`) plus `-e` the command-post extension and `--skill
<home>/skills/cp-memory` only (falling back to the package's shipped copy when
the home has none), so that path reports zero foreign tools and loads no
implementation skills. The doctor check is for a human-launched TUI parent that still loads
global extensions.

**Limits.** The guess is a name-and-schema heuristic, not a sandbox. Guards
still do not wrap unknown tools: a foreign file tool is warned about, not
blocked. Extending the guard to every tool whose arguments mention `state/`
would also refuse command-post's own tools (`cp_artifact`, `/watch` paths).

### The br checks this build's own history earned

Recorded on `cp-t25-doctor-gc7` (evidence: commit `1803a2c`):

- **`host.br.conflict`** — a homebrew `br` 0.2.19 and a `~/.local/bin` 0.5.2 on
  one PATH made `br ready` work in one shell and fail in another. What is
  flagged is **conflicting versions**, not duplicate paths: version managers
  (fnm, asdf, mise) legitimately expose several shims for the *same* build, and
  calling that broken would train an operator to ignore doctor. Every path is
  probed the same way, so two spellings of one version cannot invent a conflict.
- **`host.br.version`** — br older than `MIN_BR_VERSION` (`src/ledger.ts`) is an
  `error`, not a degraded mode. This build targets **one** br and reads the
  contract br publishes (`br schema commands --format json`); it does not sniff
  versions at runtime or shim older envelopes, so the floor exists to be
  *reported* rather than branched on. An unreadable `--version` is left alone —
  `host.br` already says `(version unknown)`, and an error invented from a failed
  probe would train an operator to ignore doctor.
- **`ledger.schema`** — `br doctor migrate-schema plan --json` is read-only and
  reports `from_version`/`to_version`; a gap is an `error` whose fix is the
  review-then-apply migration, because a schema older than the binary turns
  every ledger call into a cryptic failure.
- **`ledger.doctor`** — br's own findings are **surfaced, not re-implemented**
  (including `sqlite3.integrity_check`, which catches legacy DDL only br's
  patched sqlite can reparse). br's `warn` stays a warn; anything else becomes an
  `error`, because softening br's verdict about its own database would be a lie.
  Unreadable or non-JSON br output is a `warn`, never a wrong verdict.

### Models, and the probe that must not lie

`models.<role>` resolves each profile through routing and the availability probe.
With no live registry (a headless caller) the answer is `models.probe: ok,
"not probed"` — claiming a model is missing because we could not ask would be a
false alarm. With a registry: reachable is `ok` and unreachable is an `error`
naming `pi auth`; a route whose whole candidate list is unusable is that error,
naming each candidate and its reason, and a route carried by a fallback is `ok`
with `fallback from <preferred>` in the summary (pi-command-post-0a9). This is the check
that catches the expensive mistake: a lease and a branch cut for a worker whose
provider has no credentials.

T25 amendment (a bug the acceptance test caught): `CommandPostOptions.modelRegistry`
is now a **getter**, not a value. The composition root is built once per session
but the registry arrives on whichever `ctx` calls first — a widget refresh has
none, a tool call does — so a registry captured at construction silently froze
the probe as "unavailable" for the rest of the session.

### Models are resolved the way a job would resolve them

Rubric rows may name a `project` (cp-cxt), so probing with a synthetic project
reported the model a *fake* job would get: a home with per-repo policy could be
told it was green while a real project's model was unauthenticated. `#models()` therefore resolves each role once for the probe
context **and once per registered project**, and emits a `models.<role>.<project>`
row only when that project's answer differs from the role default — one row per
role per project would bury the finding that matters.

Two honest edges, both reported rather than implied:

- **Every scope and risk is exercised (routing T5).** The probe used to resolve
  at `scope: S`, `risk: low` only, so a row that fires for `L` or `risk: high`
  was listed as unexercised and its unreachable model was discovered by the
  first big job of the day. `#models()` now resolves the whole `PROBE_COMBOS`
  grid (3 scopes x 2 risks) for every profile and every registered project.
  Cost and output stay bounded by **dedup, not by asking less**: `resolveModel`
  is pure over the config and the probe (no inference call, no auth refresh, no
  write), and identical answers share a row instead of repeating. Dedup is keyed
  by the answer **and** the combinations that produced it, at two levels:

  - **within one project** — combinations that resolve the same way share one
    finding that names them (`scope/risk: S/low, M/low, …`);
  - **across projects** — a project whose whole grid answers the way the
    baseline does adds no row at all, and projects that answer the same way as
    *each other* share one row that **names every one of them** (`implementer in
    web, mobile: …`, bounded, with a `+N more` count past `MAX_LINT_DETAIL`).
    Naming them is the point: silently keeping only the first would leave a
    project whose model cannot be reached mentioned nowhere, which is cp-2bm's
    own bug one level up. (In practice an unreachable model rarely dedups at
    all — the refusal names the row that chose it, so two projects routed by two
    different rows are two findings.)

  What `models.rubric`
  warns about now is derived from what actually fired — including a row that
  fired and was then refused (`RoutingError.rule`), which is not the same thing
  as a row nothing reached: a row **no** probe could
  reach — it names an unregistered project, or an earlier row shadows it — and
  its fix names `cp_dispatch dry_run`, which really does show a job's route
  (`cp_check` never selected a model; it takes one as an argument).
- **An unreadable registry is not silence.** If `data/projects.json` cannot be
  read, `models.projects` says only role-level resolution was checked. Swallowing
  that would be the same bug in a new place.

The configured-policy checks live beside the config, not here:
`config.routing.shadowed` (warn) and `config.routing.effort` (error, and only
with a live registry) are described under
[Routing config](#routing-config); a duplicate rubric id is refused by
`loadRoutingConfig` itself and therefore arrives as the `config.routing` error,
naming the colliding rows.

### install-tools: the mutating half doctor deliberately isn't

A fresh home has no supported way to get `REQUIRED_TOOLS` onto PATH; doctor
only names the gap. `node scripts/install-tools.ts` is the separate script
that closes it — doctor stays read-only, so this is not a mode of doctor, it
is a different file.

- **One list, not two.** `REQUIRED_TOOLS` and each tool's install spec live in
  [`src/tool-manifest.ts`](../src/tool-manifest.ts); `doctor.ts` imports the
  same array (`tests/tool-manifest.test.ts` asserts identity, not just equal
  values) and `TOOL_INSTALL` is typed as `Record<RequiredTool, ToolInstallSpec>`,
  so a tool added to one without the other fails `tsc`, which `npm test` always
  runs first.
- **Never shadow.** A tool already on PATH — once or more than once — is left
  alone; more than one match is reported as the same `host.<tool>.conflict`
  hazard doctor catches, not installed over.
- **`--dry-run`/`--check`** prints the plan, mutates nothing, and exits
  non-zero when anything is missing, so it doubles as a preflight.
- **No silent sudo.** `git` on Linux has no non-sudo install path in any
  distro-agnostic way, so it is reported (`kind: "manual"`), never run.
- **pi is special.** If `pi` is missing from PATH but `PI_SESSION_ID` or
  `PI_CODING_AGENT` is set in the environment (a live worker's own env), the
  script is running inside a pi session and refuses to install or replace pi
  from there.
- Core logic (`src/install-tools.ts`) is dependency-injected the same way
  `Doctor` is (`which`/`run`/`env`), so its policy is tested without touching a
  real machine; `scripts/install-tools.ts` wires the real world once, at the
  edge.

### install nudge: the discovery half neither of the above is

A fresh clone's user has no way to learn that `npm run doctor:install` exists
until something already failed. [`src/install-nudge.ts`](../src/install-nudge.ts)
closes that gap without adding a second probe:

- **Reuses detection, adds no new one.** `computeInstallNudge` walks the same
  `REQUIRED_TOOLS` (`src/tool-manifest.ts`) with an injected `which` — the
  parent extension wires it to `doctor.ts#whichAll`, the same function `Doctor`
  itself uses.
- **Fires once, at `session_start`**, in the parent extension
  (`extensions/command-post/index.ts`) — the point a fresh clone's user is
  already sitting at, before any command fails. A module-scoped flag keeps it
  to one line per session; nothing is written to disk, so there is no
  first-run marker to go stale.
- **Silent once everything is present.** No missing tool means no output, no
  finding, no state change — the steady state after installing is exactly as
  quiet as before this existed.
- **Read-only, matching `/doctor`'s own contract.** It only formats a string;
  it does not install, does not shell out, and never suggests `sudo`.

## Memory

Three files under `data/`, ported from command-post's `cp-memory` skill and the
contracts `bin/install.sh` scaffolded. [`src/memory.ts`](../src/memory.ts) owns
the mechanics; [`skills/cp-memory/SKILL.md`](../skills/cp-memory/SKILL.md) owns
the judgment (what generalizes, what supersedes what, when to consolidate).

| File | Role | Write rule |
|---|---|---|
| `data/learnings.md` | curated core, loaded every session start | append-only (`cp_memory promote`, proved on the bytes by `assertAppendOnly`); removal only through `cp_memory retire`, which is a move to `archive.md`; budget `LEARNINGS_MAX_LINES` (60) |
| `data/candidates.md` | observations awaiting routing | append-only, one dated line (`YYYY-MM-DD <lesson>`) |
| `data/archive.md` | demoted or absorbed entries | append with provenance; never delete |
| `data/curation.jsonl` | the audit trail of every promotion, rejection and retirement | append-only, one JSON record per decision |

Tiers live on learnings lines as trailing HTML comments: `<!--P-->` pinned
(never decays), `<!--a:DATE-->` aging (stale at `AGING_STALE_DAYS` = 30),
`<!--p:DATE-->` perishable (stale at `PERISHABLE_STALE_DAYS` = 7, and must name
a checkable expiry). Each file carries its own contract as a header comment, so
the rules travel with the memory rather than living only in a skill nobody has
loaded.

### What moved from prose into code

Every one of these was a rule the model had to remember, and is now a property
of the only function that can do the thing:

- **Capture cannot reach learnings.** `captureCandidate` is the module's only
  append and it writes to `candidates.md`. The ported "never blind-append to
  learnings / capture is not promotion" is now structural.
- **Archiving is a move.** `archiveEntry` writes the provenance line to
  `archive.md` **first**, then removes the original, so a crash leaves a
  duplicate (recoverable) rather than a hole (not). It refuses an inexact line
  match and an empty reason: provenance is the point.
- **No write can truncate a memory file** (cp-nqj). `writeFileSync` opens
  `O_TRUNC`: the target is **zero bytes** between the open and the write, so a
  process killed in that window left `data/learnings.md` empty — the whole
  curated memory, not a line of it. That window was on every retirement
  (`archiveEntry`) and every capture (`captureCandidate`). Both now write
  through `atomicWriteText` (tmp → `fsync` → `rename`, per-call temp name), so a
  crash mid-write leaves the previous file whole and a failed write leaves no
  staging litter. What did **not** change is the append: `learnings.md` and
  `curation.jsonl` are written with `durableAppend` (`O_APPEND` + `fsync`),
  because a read-modify-write would trade this tear for lost updates — measured,
  424 of 1600 concurrent writes survive a read-modify-write against 1600 of 1600
  through `O_APPEND`, and the operator's own hand edit is one of those writers.
- **Decay is dated arithmetic.** `decayCandidates` applies the two windows;
  pinned never decays and an **untiered** entry is never decayed either — it is
  reported as the contract violation it is, because guessing a tier would
  silently archive somebody's note.
- **An off-shape candidate is reported, not dropped** (cp-2lh). `scanCandidates`
  counts `YYYY-MM-DD <lesson>` lines and returns the rest as
  `malformed_candidates`, which `/memory status` prints with the shape it wanted.
  Curation reads what the file says it contains, so a line the counter cannot see
  is a lesson that will never be promoted — invisible, not merely uncounted. Same
  treatment as an untiered learning: named, never rewritten, because a status
  command that edits somebody's note is worse than one that complains.
- **The scaffold is idempotent.** `ensureMemoryScaffold` is the ported
  `write_if_absent`: an existing file is left byte-identical, because the one
  unforgivable bug in a scaffold is overwriting curated memory. It runs on every
  `session_start`, which is why `data/` exists in a home that has never
  dispatched.
- **The session-start read is bounded.** `sessionStartDigest` loads the entries
  (never the header), truncates at the budget and says how many it dropped — the
  budget exists precisely because this text enters every session's context. A
  fresh home returns nothing rather than announcing that it has no memory.

Delivery: the digest reaches the parent as a `cp-memory` custom message with
`deliverAs: "nextTurn"`, so it is in context when the operator speaks and never
triggers a turn of its own. Memory is background, not an event.

`/memory status` renders budget, tiers, decay candidates, untiered lines and
off-shape candidates, plus the curation pass's arithmetic; `/memory capture
<lesson>` is the capture path, and `/memory curate` / `/memory audit [line]` are
the operator's read-only windows onto the parent's own pass. The **judgment**
stays a skill — what generalizes, what supersedes what, what is noise — while
the pass itself is the parent's job (see [Curation, autonomous](#curation-autonomous)).

`/memory` is a slash command: only a human typing in the TUI can invoke it, and
the parent session itself had no way to call it. `cp_memory` (`status` |
`capture` | `curate` | `promote` | `reject` | `retire` | `audit`) is the
tool-level counterpart, for the parent to call on its own —
at a job's completion or failure, per `data/candidates.md`'s own header ("the
parent session, at job completion or failure"). Both surfaces share the same
functions underneath, so capture's invariants (append-only, one dated line,
never touches `learnings.md`) hold whoever calls it, and the curation actions
carry the properties in [Curation, autonomous](#curation-autonomous) the same
way. `cp_memory` is in `WORKER_FORBIDDEN_TOOLS`: `data/` is the parent's home
only, and a worker must never promote into a memory it does not live in.

Scope, ported unchanged: `data/` is machine-local and gitignored. Anything a
fresh command post would need is a **contract edit** (AGENTS.md, docs/), not a
learning; project-intrinsic facts belong in that repo's `AGENTS.md` via a
dispatched worker; **job history lives in br**, not in memory.

## Curation, autonomous

[`src/curation.ts`](../src/curation.ts). Promotion into `data/learnings.md` used
to need a human: the parent captured candidates, triaged them, proposed
promotions and stopped. On the session that motivated this, 9 of 12 candidates
were already superseded by code merged the same day, 3 were worth promoting, and
the human step added authorization and nothing else.

The gate is gone, and the properties it was nominally holding are now held by
the only functions that can write. This is not a convenience: `learnings.md` is
loaded into **every** future session, and a session that inherits a wrong lesson
has no way to notice, so each property below is pinned by a test in
[`tests/curation.test.ts`](../tests/curation.test.ts) that fails if it is removed.

| Property | How the code holds it |
|---|---|
| **Bounded growth** | `LEARNINGS_MAX_LINES` (60) is a ceiling, not a target: a promotion into a full file is refused, and the pass must retire something first. At most `PROMOTIONS_PER_DAY_MAX` (3) promotions land in one UTC day. |
| **Nothing autonomous is permanent** | `PROMOTABLE_TIERS` is `aging \| perishable`. A pass cannot write `<!--P-->`, so every line it adds decays (30d / 7d) and leaves on its own. A bad promotion has a shelf life; pinning stays a human edit. |
| **Evidence and a date, or no line** | `promoteCandidate` composes the line itself from lesson + evidence + tier (+ expiry, required for perishable). Evidence must name a checkable source — job id, PR/issue number, commit sha, path, url or date — so "because I think so" is unwritable. There is no path that appends an undated, unevidenced or untiered learning. |
| **Append-only, never a silent rewrite** | The new line goes at the end and `assertAppendOnly` proves on the bytes that the old content is an exact prefix of the new. Folding a duplicate or editing an entry is not something this module can do; a near-duplicate is refused rather than appended. |
| **A superseded or disproven candidate is never promotable** | `rejectCandidate` journals a disposition (`superseded`, `disproven`, `generalizes`, `noise`) and a candidate carries **at most one**, forever. `candidates.md` stays byte-identical — the judgment lives in the journal, not in a rewrite of somebody's note. `superseded` and `disproven` must cite their evidence. |
| **Auditable after the fact** | `data/curation.jsonl` gets the record **before** `learnings.md` is touched, so a crash leaves a record for a line that does not exist (visible, and it costs a slot of today's budget) rather than a line nobody can trace. `traceLearning` turns a suspect line back into its candidate, evidence, date and id. |
| **No stuck candidates through drift** | `CANDIDATE_MAX_CHARS` (300) bounds the lesson text at capture; the stored line is `YYYY-MM-DD ` + lesson = 11 + 300 = 311 chars max. `promoteCandidate` and `rejectCandidate` now accept either the full candidate line (backward compatible) or just the lesson text (robust). A 290–300 char lesson that was previously undecidable is now resolvable via the lesson text alone, solving the stuck-candidate problem. |

The way out is held to the way in's standard, because the motivating case was a
lesson going false within a day. `retireLearning` needs a reason **and**
evidence, is journalled first, is bounded at `RETIREMENTS_PER_DAY_MAX` (10, higher
than promotion's bound because a retirement is recoverable and the failure mode
is a loop, not a loss), and removes the line only through `archiveEntry` —
archive written first, never a delete. Decay feeds it: `curationPlan` lists the
entries past their window as the retirement worklist.

`curationPlan` is the pass: pending candidates in full (the parent has to read
them to judge them), stale learnings, and what today's bounds still allow. It is
computed from the files and the journal, never remembered, so a restarted
session runs the same pass.

Surfaces. `cp_memory` (parent-only, in `WORKER_FORBIDDEN_TOOLS`) gained
`curate`, `promote`, `reject`, `retire` and `audit` alongside `status` and
`capture`. `/memory` gained `curate` and `audit` and stays read-plus-capture: the
operator watches the pass and can answer for a bad line, but never has to run
one. **Capture is still not promotion** — it is the observation; the pass is the
decision.

## Leases

Worktrees come from `treehouse` and only from treehouse
([`src/leases.ts`](../src/leases.ts), T11). **There is no fallback**: a missing
treehouse is a hard error, never a silent `git worktree add`, because a
hand-rolled worktree sits outside the pool, outside the lease state and outside
every check that follows.

- `acquire(clone)` runs `treehouse get --lease --json` **from the canonical
  clone**. Post-conditions, all fail-closed: the printed path exists, is a
  directory, is not the clone itself, and shares the clone's `git-common-dir`.
  A lease that fails them is returned immediately rather than handed to a
  worker.
- `release(lease)` runs `treehouse return --force` **from the home**, and is
  refused when the home or the process cwd is inside the worktree — teardown
  runs from outside, always.
- **Path binding.** A `Lease` is produced only by `acquire()` or
  `leaseFromRecord()` (rebuilding one from fleet state after a restart), and
  `release()` takes a `Lease`, never a string. The `path` is stored **exactly
  as treehouse printed it**, since that is treehouse's key for the worktree;
  comparisons canonicalize a copy.
- T11 amendment: modern treehouse reports a `lease_id`, and `release()` passes
  it as `--if-lease-id`, so a teardown can never return a worktree somebody
  else has since leased. `FleetRecord.lease_id` carries it across restarts.
  Older treehouse prints only a path; the guard is then absent rather than
  faked.

## Modes

One mode is left: **multi-project**. Single-project mode (spec
`docs/superpowers/specs/2026-09-04-single-project-mode-design.md`) was removed
(cp-8knh). Implemented in [`src/mode.ts`](../src/mode.ts); the layout switch
lives in `src/contracts.ts` (`configureLayout`).

**Resolution**, once per process, before any path is read: `CP_MODE`
(`multi|auto`; `single` is refused, anything else ends startup) →
`.pi-command-post/settings.json` in the launch directory's git toplevel
(read only; `multi|auto` work, `single` is refused, an unreadable or unknown
value is reported and ignored) → the default: `CP_HOME`, the source checkout,
or a directory with `.pi-command-post/projects/` and `.pi-command-post/state/`
give multi; a git repository is refused; anything else gives multi on today's
default home.

**Refusals**, all raised by `resolveRuntime` itself as a `ModeError`, before
any path is written: `CP_MODE=single` and a settings file saying `single`
(`single-project mode was removed; …` naming the fix); a launch inside a git
repository that is not a home (`<repo> is a git repository, not a
command-post home — …`, naming `bin/cp-operator`, `CP_HOME` and
`CP_MODE=multi`, and saying when the repository holds a former single-project
home's state, which is not migrated); and a former single-project home used
as `CP_HOME` (`isLegacySingleHome`: `.git/` present, `.pi-command-post/state/`
present, `.pi-command-post/projects/` absent, `.git/info/exclude` lists
`.pi-command-post/`). Nothing is scaffolded and nothing is deleted.
This checkout is therefore always a multi home.

**Layout** (`configureLayout(mode)`; a second call with another mode throws):
one runtime root (cp-u3i2): `data`, `state`, `projects` and
`operatorWorkspace` resolve under `.pi-command-post/`;
`NEVER_COMMIT_PATHS` is `[".pi-command-post/", ".beads/"]`; see
[storage.md](storage.md).

**The contract**: pi loads `AGENTS.md` only from the working directory and
its parents, so in `before_agent_start` the extension appends this package's
`AGENTS.md` to the system prompt whenever it is not already among the loaded
context files. When pi loaded it (a session in this checkout), nothing changes.

**Doctor**: `mode`, `home.gitignore`, `scaffold.projects`, `storage.home`,
`storage.state` and `storage.handoffs_dir`.

**The contract surface**: `MODES` is `["multi"]`, so `Mode` and `ModeSchema`
accept only `multi`; `Runtime` has no `repo` and `RUNTIME_SOURCES` no `repo`.
`MODE_SETTINGS` keeps `single` only so a legacy `settings.json` is read and
refused, not ignored. `layoutForHome`, `layoutFor`, `neverCommitFor` and
`configureLayout` keep their `mode` parameter (always `multi`).

**`cp_parent start`** takes `home`; `mode` may be omitted (it is always
`multi`; the schema enum is `["multi"]`), and `mode: "single"` is refused by message. **Compatibility**: an
operator-target file (`<PI_HOME>/command-post/operator-targets/*.json`,
`selected.json`) keeps its `{home, mode, hostPid, parentPid}` shape and is
written with `mode: "multi"`; a stored `mode: "single"` is refused naming
the file, the home and both pids (stop that parent with the previous release,
then delete the file — it is never deleted automatically). The parent-host
argv keeps `[HOST_SCRIPT, home, mode, gen]`; `single` in `argv[3]` is refused.
`/cp-mode` was deleted; `settings.json` is operator-written only.

## Ledger

Ported from command-post AGENTS.md §Backlog and implemented in
[`src/ledger.ts`](../src/ledger.ts) (T9; in-house document since spec
2026-09-04). **The ledger is not a backlog.** It holds work the parent has
accepted, from `open` through `in_progress` to `closed` with a reason, and the
closed jobs are the job history. Issues live wherever the operator says in the
prompt; a job points at its issue through `external_ref` — one non-empty line,
at most 1000 characters: a tracker URL, a file path, or the command that shows
the task (`br show <id> --json` for a `br` tracker). The store never holds an
issue body (T19); the one-line rule is what keeps the field a pointer. A job
has no `type` and no `priority` (retired 2026-09-05: nothing read them;
`ready` orders by `created_at`, grouping is `blocked_by`). A document written
before that date still reads: `stripLegacyJobFields` drops the two keys before
validation in `Ledger.read()` and `/doctor`, and the next mutation persists the
cleaned shape.

**Retirement archives before it removes, and is failure-closed.** A field is
dropped from the contract, never from the record. Every mutation re-reads the
document on disk and, when it still carries retired values,
`collectLegacyJobFields` takes them and appends one JSON line — `{ at, source,
jobs: [{ id, fields }] }` — to `.pi-command-post/jobs-legacy-fields.jsonl`
(`LAYOUT.jobsLegacyArchive`) through `durableAppend` (`O_APPEND` + `fsync`),
**before** `atomicWriteJson` runs. The order is the contract: `Ledger.read()`
has already dropped the values in memory, so the write is the last moment they
exist, and an archive that cannot be written aborts the mutation with a
`LedgerError` naming the jobs — the document keeps its retired values and the
mutation does not land. Reads never archive and never rewrite; a document with
nothing retired (every document written after 2026-09-05) costs one parse and
writes nothing, so the archive holds exactly one record per document that was
actually cleaned. The archive is under the runtime dotdir, so it is covered by
`NEVER_COMMIT_PATHS` like the ledger itself.

**Script declaration (X1).** `Ledger.create({
scriptPath: "scripts/run.sh", kind: "ship", delivery: "local", ... })` and
`cp_job create` with `script_path` store `job.script: { path }`. The path must
be a nonempty POSIX repository-relative path (at most 1000 characters): no
absolute path, empty/dot/dot-dot component, backslash or control character.
Creation does not check the filesystem; the runtime must verify the leased
worktree's realpath, component symlinks, regular-file status and git tracking
before launch. Older jobs without `script` remain model jobs. `cp_job create`
refuses a repeated title or ref whose script action differs from the recorded
one; direct `Ledger.create` also refuses that mismatch while preserving mint
semantics for matching actions. `script_path` is create-only.

`cp_dispatch <id>` (or `dry_run`) reads the declared action before model routing.
A script needs no task, model or pi session; task, task_file, model, profile,
thinking and tool_call_cap are refused. Preflight, mandate/risk, lease and
branch checks run before `/bin/sh <tracked path>` starts with cwd at the leased
worktree and an allowlisted environment. The wall cap sends TERM to the owned
process group, then KILL if it ignores TERM. Stdout and stderr retain only the
last 64 KiB each, with byte counts and truncation markers in the artifact
outside the worktree; neither stream enters the parent context. Script jobs
cost zero model tokens and occupy a parallel slot while waiting. `cp_send` and
`cp_revive` cannot replay them.

The runner writes the artifact and durable result before intake stamps the
single `cp-envelope` wake-up. Exit 0 becomes held/done, nonzero, signal or
timeout becomes failed with exit reason; `/watch` and `/status` show script
path, pid and observed exit without inventing a model or session. On parent
restart, a durable result is intaken once. Dispatch writes a `launching` fleet
record and claims the ledger before spawning; only after spawn does it write
`script_process: { pid, started_at }` and move to `waiting`. A restarted
`launching` record has no observed pid. Without a durable result, reconciliation
marks it failed/unknown, retains the lease, and never replays it; normal
teardown refuses the unknown outcome unless the operator inspects and uses
`--force`. A validated durable result takes precedence even for a PID-less
`launching` or provisionally failed record: intake stores
`script_observed_exit: { exited_at, exit_code, signal }`, stamps one report and
`cp-envelope`, and permits normal teardown. `spawn_error` has failure class
`spawn_failed`; it is not a crash inferred from a missing pid. A dead pid
without a durable result is also unknown, never permission to rerun.
`cp_teardown` retains the ship clean/pushed gate even for failed scripts; a
dirty/unpushed lease stays held until corrected or explicitly forced.

The fleet wire shape adds `executor: "script"`, `script_path` and
`script_process: { pid, started_at, exited_at?, exit_code?, signal? }` after
launch for ship/local scripts **without** a `worker`; while `launching`, the
process is absent. Once a PID-less result is validated, `script_observed_exit`
records its exit facts instead of fabricating a process. Model records require
a `worker` and forbid script fields. Absent `executor` means model for legacy
records.
A script's durable `state/runs/<id>/script-result.json` contains
`{ schema_version, job_id, result }`, where `result` has matching `job_id`,
`status: done|failed`, `exit_code: integer|null`, `signal: string|null`,
`timed_out: boolean`, `reason: success|exit|signal|timeout|spawn_error`,
a plain-prose bounded `summary`, and an absolute `artifact_path` outside the
worktree. It carries no stdout/stderr; the runtime writes those only to the
artifact. `script_exit`, `script_signal` and `spawn_failed` are nonrecoverable
failure classes; timeout uses `wall_clock_exceeded`. X2 may declare a
`scriptPath` job and ordinary dependencies, then use `cp_next`/`cp_dispatch`;
no direct process-launch API exists.

**Schedules (X2, Pier 1.5).** `cp_schedule add` saves a cron schedule (five
fields — numbers, `*`, ranges, lists, `/step`; day-of-month and day-of-week
restricted together match either — plus an IANA `tz`) or a watch (a tracked
repository-relative script run every 30–86400 s in the project's canonical
clone with the script runner's bare environment and resolution rules, firing on
`exit0` or on `changed` stdout; the first output is the baseline) in
`state/schedules.json` (`src/scheduler.ts`). Each names a mandate that must be
an active schedule grant (`schedule_grant: true`, *Schedule grants* above;
`cp_schedule add` with any other grant is refused naming `schedule_grant`), cover
the project and job kind, name no `job_ids` (every fire is a new id), and be
named by no other schedule (one grant per schedule, checked at add and at every
fire). **Upgrade note (S3, no migration):** a schedule saved before S3 under a
project-wide grant stays on disk, but every fire is skipped with `fire at <slot>
not recorded: <id> is not a schedule grant …` (the schedule's `last_skip`, logged
by the parent; no job is created). To resume it the
operator issues a fresh grant with `cp_mandate issue … schedule_grant:true`, then
`cp_schedule remove` and `add` the schedule under it — a saved schedule's
`mandate_id` is never rewritten in place. A fire only records an ordinary ledger job — title plus the slot,
label `schedule:<id>`, notes naming the schedule and mandate — and wakes the
parent with `cp-schedule`; dispatch stays `cp_next`/`cp_dispatch`, so job caps,
dispatch parallelism, risk gates and review apply unchanged. A fire is skipped,
with the reason recorded on the schedule and reported once, when the mandate is
not active or the schedule's previous fire is still open; the same slot twice
is the same job. Schedules tick every 30 s only while a session holds the
parent lock; the first tick after start fires each schedule's latest missed
slot (cron, 366-day lookback) or due run (watch) once and notes
`missed <time>`. An always-on host is a non-goal: `Scheduler.tick()` takes its
clock and ports as arguments so one can drive it later. `cp_schedule enable`
(and the page's Enable, cp-hhuf P6) is refused unless the schedule's grant
passes the fire check, and enabling a disabled cron schedule restarts slot
evaluation at the enable time, so a slot that passed while it was disabled never
fires. The page's Run now is a manual fire (title `<title> (<name> run now
<minute>Z)`) under the same grant and open-fire checks; it never writes
`last_fire`/`last_skip`, is refused on a disabled schedule, and is serialized
with slot fires, so the two never both create.

**Trackers (B2).** Each registered project has at most one active tracker
connection in `data/trackers.json` (`TrackerConnectionSchema`,
`validateTrackersFile`, `src/trackers/config.ts`), managed only by `cp_tracker
connect|disconnect|list` — never hand-edited. `connect project=<p> adapter=beads
endpoint=<abs path to beads.db or its .beads dir>` stores the realpath of the
database with `intake_enabled` and `write_enabled` both off unless passed. The
database must exist before `br` runs (`br --db <missing>` silently creates one)
and a read-only `br list --json --limit 1` probe must return `{issues:[...]}`.
Refused, writing nothing: an unregistered project, a second active connection
for the project (switching is `cp_tracker disconnect <project>`, then connect),
a connection id (default `<project>-<adapter>`) already bound to another
endpoint or project (pass a new `connection_id`), an endpoint another active
connection holds, and `adapter=github`, which the contract admits but refuses as
`github: adapter not implemented (B6)` until B6. `disconnect` keeps the record as
a `disconnected` tombstone; jobs keep `job.tracker.connection_id`. A job's
optional `tracker: { connection_id, item_id, linked_at }` link is unique across
open and closed history: `Ledger.createTracked` returns the existing job for a
known key and refuses to link an open unlinked job carrying the same ref.
Any other job links through `Ledger.link` (laf, `src/trackers/link.ts`): it is
idempotent for the same item and refuses another item, or an item another job
links, naming that job. `cp_job create` and `cp_dispatch` link automatically
when the job's pinned `br --db <db> show <id> --json` ref names a database whose
path or realpath equals its project's **active** beads connection endpoint; any
other ref, db or project stays unlinked with `not linked to a tracker bead:
<reason>` in the result, and linking never fails a create or a dispatch. No `br`
runs at link time. `cp_tracker link job_id=<id> [item_id=<bead>]` links one job
(open or closed) explicitly or from its ref; with no `job_id` it backfills every
non-closed unlinked job whose ref resolves, printing each link and each skip with
its reason. The write-back tick runs the same backfill first. Closed jobs link
only explicitly, so history is never retro-closed by a backfill.
A project's beads database resolves in one place (`projectTracker`): its active
beads connection's endpoint, else `<clone>/.beads/beads.db` when that file
exists, else none. The home's `.beads` is **never** inherited — not in ready-bead
discovery or the idle notice, not when a bare `br show` ref is pinned or
verified, not in dispatch-time reference snapshots, and not in a worker's
`BEADS_DIR` (set only by dispatch from that database; a parent
`BEADS_DIR`/`BEADS_DB` is stripped). An active github connection shows a visible
ready-beads error row.

**Tracker import (B4).** `cp_tracker import project=<p> mandate_id=<md-…>
kind=<ship|research> delivery=<pr|local> [ids] [limit]` (`src/trackers/import.ts`)
turns ready beads into ordinary jobs. It needs the project's active beads
connection with `intake_enabled`, and a **named-jobs (batch) mandate**: active,
covering the project and kind, under its spend and token caps, and naming
`job_ids` — a project-wide grant is refused. Only beads related to that
mandate's work qualify: the ids the call names, and the ready direct children
(`br ready --parent <id>`) of every epic the mandate's objective records as
`epic: <id>`. With neither, the call is refused; a named id that `br ready` does
not list is refused by id. There is no label or selector matching (B3). Each
created job is capped by `enrollCapacity` (job cap less dispatched jobs and
listed jobs still waiting, at most 64 `job_ids`); a label `kind:`/`delivery:`
that contradicts the call, an item already linked, or a ref another job already
tracks is skipped with its reason. A job is born `deferred` (out of `ready()`,
so `cp_next` never offers it) with `tracker.mandate_id` and `task_sha256`, gets a
frozen `state/tracker-tasks/<job>.md`, is enrolled into the mandate's `job_ids`
by `MandateStore.enroll` (which re-checks the grant and caps), and only then opens
with `notes: task_file: <path>`. A crash anywhere in that sequence leaves a
deferred job no grant was asked to cover, which `Ledger.claim` (the claim
`cp_dispatch` makes) refuses with `<id> is deferred: run cp_tracker import again
to finish enrollment`; the same import resumes it — an already-enrolled job takes
no new slot, even at the job cap — rewriting a missing task file only when the
source still hashes to `task_sha256`.
Nothing is dispatched: the parent runs the printed
`cp_dispatch <job> task_file=<path>` through `cp_next` as usual.

**Tracker write-back (B5).** It replaces the operator's manual `br close`
(`src/trackers/sync.ts`, `src/trackers/sync-store.ts`). While this session holds
the parent lock, `cp_tracker` ticks every 60 s (plus one catch-up at start).
Each tick derives intents from facts — the ledger and `readMergeReceipt` — for
jobs whose `tracker` link names an **active, `write_enabled`** connection; write
off, a disconnected connection or an unlinked job derives nothing. A tracker-linked
`kind:ship` `delivery:pr` job whose receipt matches (`job_id` and
`head_branch` equal the job id), and which was not dropped, closes its bead once
with `CP <job> merged: <full pr_url> merge <merge_commit_sha> head <head_sha>`.
Every other closed, undropped job — research, local, board, answer, pipeline — closes its bead once
with `CP <job> done: <close_reason>`; a dropped job, or a `kind:ship` `delivery:pr` job with no
matching receipt, gets one comment and its bead stays open. An intent key is the sha256 of
connection, item, job, op and evidence; its first 12 hex digits are a
`[cp:<key>]` marker in the text. Intents live in `state/tracker-sync.json` and
are never deleted; deleting the file only re-derives the same keys. The beads
adapter never passes `--force` or `--bypass-policy`, never runs `br` against a
database that does not exist, trusts a close only when a `br show` read-back says
`closed` (already closed upstream records the evidence as a comment instead), and
lists comments before adding one. A marker already listed counts as done. An add
that was acknowledged but whose marker is not listed is held `ambiguous`, never
appended again. A missing bead is held `refused`. Any other failure, including
github's `adapter not implemented (B6)`, retries after 60, 120, 240 … s, capped
at 900 s. `cp_tracker list` shows every write-back that is not done yet. Nothing in
`src/integrate.ts`, `src/merges.ts` or `src/teardown.ts` imports tracker code, so a
tracker outage delays a write-back but never gates a merge. `cp_integrate`
returning `next: done` and the held continuation's `HELD PR LANDED` notice each
carry one `tracker write-back:` line, computed from local files only (ledger,
`data/trackers.json`, the merge receipt, `state/tracker-sync.json`) by the
extension and `command-post.ts`, never by the merge path: which bead closes with
which PR URL on the next tick, the stored intent's status, or exactly why nothing
is written (unlinked, unknown or disconnected connection, write off, no matching
receipt). A failure to compute it becomes an `unknown` line, never a throw.

**Conversation intake (autonomy-programme-cur.4.3).** Work arrives as prose.
The parent records each item once with `cp_job create`. That call is
idempotent on `(project, normalized title)` or `external_ref` among **open**
jobs and returns the existing id — a repeated list creates nothing. Closed jobs
do not match, so finished work may be filed again. `cp_pipeline start` and
`cp_ask` still mint; only `cp_job create` dedupes. `cp_mandate issue` accepts
`job_ids: ["all jobs created in this turn"]`, expanded to the ids `cp_job
create` returned since `before_agent_start` (the same parent generation, so a
mandate can cover intake without waiting for the ids). There is **no board, no
brief, and no `PLAN.md` as a task record**: the mandate objective plus the
ledger are the whole record.

**`external_ref` is verified before a job is recorded (autonomy-programme-cur.4.5).**
The first live mission stored `.../issues/12` as `external_ref` and dispatched
an implementer against it: the number was a merged PR, not the open issue the
operator named, and nothing had read the ref before trusting it.
`verifyExternalRef` (`src/verify-external-ref.ts`) is the read, run once by
`cp_job create` (so `cp_pipeline start` and `cp_ask` are covered the same way
the moment either ever passes one through `Ledger.create`): a GitHub
`issues|pull` url calls `gh api repos/<o>/<r>/issues/<n>` (the issues endpoint
returns PRs too, with a `pull_request` key); a `--db`-pinned `br show` ref runs
the exact command the ledger already stores and reads `status` (a bare `br show`
ref whose project has no beads database is not run at all — it is noted as
unverified, never read against the home's or the cwd's `.beads`); a bare file path is an
`existsSync`; anything else is `unverifiable`, not an error. A **mismatch** —
the kind an issue/pull url implies does not match what came back, the state is
not `open`, or a 404/missing path — refuses the `cp_job create` call before
anything is written and raises one `conflicting_acceptance` escalation per
project (`raiseConflictingRef`/`EscalationStore.appendToOpenQuestion`, so two
bad refs named in the same mission read as one open question, not two).
`unverifiable` and a `gh`/`br` transport failure are **not** mismatches —
ignorance is not a finding — and the job is created normally with the fact (or
the failure) recorded on `notes`, which `cp_job show` then prints.


Every job carries labels, and they are the dispatchability contract:

| label | required | values |
|---|---|---|
| `project:<name>` | yes | a name the project registry knows (T10); intake refuses others when a registry is wired in |
| `delivery:<mode>` | yes | `pr` \| `local` \| `pipeline` |
| `kind:<axis>` | no | `ship` \| `research` |
| `risk:<level>` | no | `low` \| `high` — recorded by `cp_job create risk` / `cp_pipeline start risk`; read by the risk:high gate (H6), a low never routes |

`requireJobLabels(issue)` is the fail-closed read: dispatch calls it before a
lease exists, so an issue that cannot say which project and delivery it is
never reaches a worktree. Label values are restricted to
`[A-Za-z0-9_-]+` because labels travel comma-separated on the CLI.

Policy that lives in code rather than in prose:

- **Closed is a transition, not an edit.** `update()` refuses
  `status: closed`; `close(id, reason)` always carries a reason, and `--force`
  is not exposed — a job blocked by an open dependency is unblocked
  deliberately.
- **Dropped work is closed, never deleted** (`drop()` prefixes
  `dropped: `); `br delete` has no wrapper.
- **Real dependencies only.** `addDep(blocked, blocker)` means "blocked cannot
  start until blocker lands"; a dropped close remains unresolved and self-dependencies are refused.
- **Blockers are comments, not statuses.** A blocked job stays `in_progress`
  with a `blocker: …` comment (ported).
- Every call passes `--json` and validates the envelope
  (`LedgerIssueSchema`, deliberately open because br owns that shape); br's
  error envelope becomes a `LedgerError` carrying its `code` and `hint`. Prose
  output is never scraped.
- **Every query states its limit.** No call omits `--limit`, because br's
  defaults are not uniform: `br blocked` pages at **50**, while `br ready` and
  `br list` are unlimited. `blocked()` is hard-wired to `--limit 0` and takes no
  caller limit at all — there is no correct page size for "does this exist" — and
  every other query sends `--limit 0` unless the caller asked for a page.

  br's envelope shapes are **per command and published**, not uniform:
  `br schema commands --format json` reports `list`, `blocked` and `search` as
  wrapper objects whose rows are at `.issues`, while `ready`, `show`, `dep list`
  and `comments list` are bare arrays. `unwrapIssues()` reads the rows out of
  whichever shape arrives, which is why br's 0.5.2 → 0.5.4 change of
  `blocked`/`list` from array to wrapper never reached dispatch — only a test
  that read `.length` off the raw JSON noticed, and it failed as
  `undefined !== 50`, naming neither br nor the shape. `tests/ledger.test.ts` now
  pins the published table itself, so the next move fails with the command, the
  new shape and the function to teach.

  This is the ported rule "pass `--limit 0` when the result decides membership or
  existence" (command-post `reports/operating-knowledge.md`), and it is a rule
  because inheriting the default was a **fail-open** bug (`cp-i2s`): dispatch
  refuses a job when `blockersOf()` finds blockers, so with more than 50 blocked
  issues in a home, a job whose blocker fell past the page read as unblocked and
  got a lease, a branch and a worker. `tests/ledger.test.ts` pins both halves —
  the argv of every query, and br's own 50-row default against a real scratch
  workspace, so an upstream change to that default fails our suite instead of
  our dispatch.

### Advisory gateway capacity

`data/capacity.json` is optional and gitignored. An admin-only setup uses
`{"url":"https://gateway.example","path":"/api/v1/admin/ops/concurrency","quota":{"five_hour":90,"seven_day":85}}`
and sets `CP_GATEWAY_ADMIN_KEY` in the parent environment. `cp-install --gateway-url
<origin> --gateway-key-file <file>` writes both: the config, and the key as
`CP_GATEWAY_ADMIN_KEY=<key>` in `${XDG_CONFIG_HOME:-~/.config}/pi-command-post/gateway.env`
(0600, outside the home and every unit). The parent host's `parentEnv` reads
that file only when `data/capacity.json` exists and the environment has no key;
a group/other-readable or malformed file is one stderr line in `state/parent-host.log`
(never the key) and no key; workers never get it (docs/service.md §7b). The quota thresholds
are optional percentages; unknown config keys are refused. The bridge passes
the key to the parent, not workers. Never put credentials in config or output.
Without the key, neither gateway endpoint is called and eligible candidates
keep rubric/profile order (`quota=off:no admin key`), without fleet scoring.

The HTTPS concurrency GET has a 500 ms timeout and sends the key in `x-api-key`.
Its response is `{code:0,data:{enabled:true,timestamp:"...",platform:{anthropic:
{max_capacity:8,current_in_use:2,waiting_in_queue:0}}}}`. Free slots are maximum
minus in-use minus queued. On a failed read with a key configured, all providers
fall back to waiting-worker counts (`source: fleet`, fewer workers is higher).
An unreadable fleet means unknown; gateway slots and local counts never mix.
401/403 records `capacity auth rejected`; malformed data records
`capacity response unreadable`. No quota or capacity score refuses a spawn.

Subscription quotas come from one `/api/v1/admin/accounts?page=1&page_size=50`
GET and parallel `/api/v1/admin/accounts/<id>/usage` GETs, with one 1500 ms total
deadline. Only platforms named by models/fallbacks in the active routing config
are queried (`DEFAULT_ROUTING_CONFIG` when absent; currently its rubric is
empty). Only active, schedulable OAuth accounts with both temporary block dates
null or in the past are queried or counted. Incomplete account lists are
unreadable. API-key accounts and unsupported usage shapes have unknown quota,
never tight. No credential or account name is recorded.

For each provider, take the account with the lowest `max(five_hour, seven_day)`.
Its figures are tight at 5h >= 90 or 7d >= 85, unless configured otherwise.
When `five_hour` reads 0 while `seven_day` is nonzero, the gateway is not reporting that account's 5h window at all (a sub2api quirk on openai oauth accounts); it is shown as `5h=n/a` and judged on 7d alone, never counted as a real 0%.
Eligible non-tight providers rank before tight ones; within that group the
first free admin slot wins, otherwise the most free (ties keep rubric order).
If all eligible providers are tight, capacity and rubric order still choose a
model. An explicit model override ignores quota. Running workers never change
model. Failed quota reads preserve ordinary capacity behavior and record
`quota unavailable: auth rejected|unreadable|timeout`.

Among healthy candidates with free admin slots and known quota, routing prefers
the lowest 7-day utilization only when it is more than `quota.balance_margin`
percentage points below the first free candidate in rubric/profile order.
The optional setting in `data/capacity.json` defaults to 10 in source; `null`
or any negative number disables balancing. Ties and differences within the
margin keep rubric order. Unknown quota, unavailable admin slots, and the
all-tight fallback preserve ordinary capacity behavior. Only configured
providers are compared, with the existing quota read and timeout unchanged.
A changed pick records `quota.balance_reason` in `routing_resolved` and
`formatQuota` output, naming both providers, their 7-day figures and the margin.

The in-memory snapshot, including failures, is shared by concurrent reads and
cached for 60 seconds. `RoutingDecision.quota`, dispatch and reviewer events,
and the routing line record provider figures and tightness or the named reason.
`/status` appends the latest snapshot in one line without making a gateway call.
The existing `RoutingDecision.capacity` continues to record scores/source.

## Routing config

How the integrated result of the routing epic was checked — what was run, what is
still unverified, and what an operator has to do to adopt the shipped default —
is recorded once in [`docs/routing-verification.md`](routing-verification.md)
(routing T7). It is a record, not a second contract: everything binding is here.

`data/routing.json` (`RoutingConfigSchema`). Resolution order (T13, amended by
cp-cxt):

1. **explicit override** — caller-passed model and/or effort; the model must
   match `allow` (`source: "override"`)
2. **rubric** — first matching `rubric[]` row on `role` (required) plus
   optional `project`, `scope` and `risk`; a row may also set `thinking`
   (`source: "rubric"`)
3. **profile default** — the profile's `model` and `thinking`
   (`source: "profile"`)

**Fallback is capability-gated and confined to the picked source.** A rubric
row and a profile may carry `fallbacks: […]` (≤4 refs) after `model`. The
allowlist, availability and effective effort gates filter `[model, ...fallbacks]`
first. When capacity is known, the highest free-slot provider wins; otherwise
the first eligible candidate wins in file order. Ties keep file order. This
keeps everything cp-eff was protecting:

- **The installation contract is one provider.** Anthropic or OpenAI
  authenticated in pi is enough: the shipped template and the shipped profiles
  resolve **every** (role, scope, risk) route under either one alone, and
  `tests/routing.test.ts` proves both one-provider matrices against pi's own
  registry metadata. (xAI was dropped from every ladder in the 2026-09-23 model
  refresh.) Anthropic stays first when capacity is tied or unknown; an eligible
  OpenAI candidate with more available slots can win a new spawn.
- **An explicit override never falls back.** A caller-named model is one
  candidate by construction; an unavailable one is a `RoutingError` **before the
  lease**, because the person who named it is the person to tell. Same for a
  `cp_gate`/`cp_review` `model` and a `QualityConfig.model`.
- **No cross-source fall-through.** An exhausted rubric row refuses
  (`refusal: "exhausted"`); it does not fall to the profile default. The row is
  operator policy for that class of job, and running something else there is the
  silent substitution cp-eff refused.
- **The effort is never substituted.** The effective level is the override's,
  else the row's, else the profile's, exactly as before; a candidate that pi's
  metadata says cannot serve it is **skipped**, never downgraded.
- **Every skipped candidate is recorded.** `RoutingDecision.attempted` is a
  bounded list (≤8) of `{ model, refusal }` with `refusal` ∈
  `allowlist | availability | effort` — model refs and enum words only, so it can
  carry no credential. It appears in the printed line as
  `attempted=<model>(<reason>),…`, in `cp:routing_resolved` (dispatch and every
  reviewer surface), and in doctor's summary as `fallback from <preferred>`.
  Capacity-based selection is recorded in `capacity`, never as a refusal;
  a decision with no refusal has no `attempted` field.
- **The allowlist still gates every candidate, and skips rather than throws when
  there is a list.** Narrowing `allow` to the providers you authenticate is
  exactly what this document tells operators to do, so with candidates a
  disallowed one is skipped *with provenance*; a **single**-candidate source (an
  override, or a row/profile with no `fallbacks`) keeps the hard `allowlist`
  configuration error it always had. All candidates gone is `exhausted`, naming
  each candidate and the gate that refused it.

The gate's old "retry on a *different* model" rung is still gone and does not
come back: fallback is resolution-time, walked once before the spawn, never a
retry mechanism. A running worker that gets a 503 stays on its existing
bounded same-session retry/recovery ladder: switching its model mid-session
could invalidate restored thinking and conversation state. The next new spawn
re-scores capacity independently. A repeat operational review fault remains
capped at `operational_persistent`, which reaches a human.

Activating the multi-vendor policy on a machine that already has a
`data/routing.json` is an operator step with a backup and a validation, not
something any code path does: [`docs/routing-rollout.md`](routing-rollout.md).

**A rubric id names one row, and a dead row is said out loud (routing T5).**
First-match-wins policy can hide a later row, and an id worn twice makes the
`rule=` a routing decision prints ambiguous — the run log, the fleet record and
every doctor finding point at a name that no longer identifies a row. So:

- **Duplicate rubric ids are refused at load** (`loadRoutingConfig`, so every
  caller gets the same answer), with the refusal naming each colliding row by
  position and by the model it routes to. Nothing guesses which one was meant.
- **A provably shadowed row warns, and nothing is reordered.** A row is reported
  only when an *earlier* row covers it entirely on all four selectors
  (`role` equal, and the earlier row's `project`/`risk` absent-or-equal and its
  `scope` a superset), i.e. when it can never fire. Partial overlap, per-project
  narrowing and a broad row that follows a narrow one are intentional
  narrow-to-broad policy and are never reported. Precedence stays the
  operator's: `shadowedRubricRows()` reports, `doctor` prints
  (`config.routing.shadowed`), and no code path sorts, rewrites or disables a
  row.
- **Configured effort is checked against pi's own metadata, before a job needs
  it.** `effortPolicyDrift()` walks the pairs a spawn would actually use — each
  profile's own model+level and each of its `fallbacks` at that level, and each
  rubric row's model **and every candidate after it** at the level that row
  would apply (its own, else the profile's) — and applies exactly the rule
  `resolveModel` refuses with, through the one predicate both call
  (`unserviceableEffort()`). Identical pairs are one probe and one finding
  naming every source. Absent metadata is ignorance rather than proof, and an
  inert level on a non-reasoning model stays inert: neither is drift. Doctor
  reports it as `config.routing.effort` (an error — the same rule would refuse
  that spawn before its lease) and only when this session has a live registry.

**A refusal says what it refused, and about which row.** `RoutingError` carries
`refusal` (`allowlist` | `availability` | `effort`) and, when a rubric row chose
the model, `rule`. Both exist for the *diagnosis* side: doctor prints a
different fix for a model the operator's own allowlist rejects (add a pattern —
nothing was ever authenticated) than for a provider with no credentials (`pi
auth`) or an effort the model does not serve, and a row whose model the
allowlist refuses is an **exercised** row — it fired — so `models.rubric` must
not report it as "not exercised: register the project", which is advice about a
problem that is not there. Branch on the field, never on the prose.

The same three checks run once at session start (`computeRoutingNudge()`), so a
refused config, a dead row or a drifted pair is news at startup rather than at
the dispatch it would refuse. It is read-only, silent when there is nothing to
say, and bounded: at most `MAX_NUDGE_LINES` (5) lines per list, with the rest
counted on their own line.

**Every bounded list counts what it dropped** (`boundedList()`). Doctor's
findings are contract-bounded (`DoctorFindingSchema`: `check` 64, `what` 200,
`detail` 2000, `fix` 500) and `validateDoctorReport` *refuses* a report that
breaks them — so a home with fourteen 64-character project names, or a rubric
full of dead rows, must produce a long diagnosis and never a crashed one. Items
dropped for **either** bound (count or length) are in the `(+N more)`, because a
count that only knew about the item limit would be wrong exactly when the output
got big, which is the moment somebody reads it.

### The parent's two decisions, and what the enums mean

The parent was handed bare enums — `scope: S|M|L`, `risk: low|high`, with no
criteria anywhere near the call — and workflow advice that read like routing
advice. Two things fix that, and neither is a new mechanism:

- **The criteria live beside the enums** (`SCOPE_CRITERIA`, `RISK_CRITERIA` in
  `src/contracts.ts`) and are the *verbatim* parameter descriptions of
  `cp_dispatch`'s and `cp_pipeline`'s `scope`/`risk`. `S` = a bounded, known
  change; `M` = cross-component work or substantial investigation; `L` =
  explicitly broad or deep multi-stage work — **scope is not a file count**.
  `risk: high` = security/auth, credentials, money, production, or destructive
  and irreversible operations; `low` = work a rerun undoes. **Uncertainty is not
  impact**: it is separately recorded evidence for stronger resources
  (`self_assessment`, and the escalation rule above), never a reason to call a
  task high-impact. One text, whether it is read in a tool schema, in AGENTS.md
  §Classify or here.
- **An unknown axis stays absent.** Inventing `S`/`low` to satisfy a schema is
  the one input that cannot be told apart from a measurement afterwards, which
  is exactly what `provenance` exists to record. An explicit value overrides
  **only its own axis** (the paragraph above), and repository-dependent sizing
  is the planner's evidence — not a protected artifact body the parent reads,
  and not an extra worker dispatched to classify.

**Workflow and resources are separate choices.** `cp_pipeline classify` answers
"how many workers, and does a plan come first" (`single` / `pipeline` / `qa`);
`scope`/`risk` answer "which model and effort". It stays **advisory** — a
high-impact keyword is not a reason to insert a research stage, and the caller
may force any mode. `ClassifyInput.kind` has always existed and the tool did not
offer it, so a parent that already knew the operator asked for *research* could
not say so and got the keyword answer for the task text instead ("investigate
the flake" reads as a pipeline until you know it is one research job). The tool
now passes `kind` through to `classifyIntake` and nothing else changed: no new
enum, no persistent classification token, and no merge of the workflow and
routing policies.

**The category choices are a labeled corpus, and the parent-model half is not
measured yet.** `evals/parent-routing.json` holds one hand-written case per
required scenario, and each case carries two layers that must not be confused:
`labels` (human ground truth — a *set* per axis, because several cases are
legitimately ambiguous) and `deterministic` (what `classifyIntake` and
`resolveRoutingInputs` do with the case today). The deterministic layer is a
wiring and regression pin — `tests/parent-routing-evals.test.ts` — and it is
**not** a measurement of a parent model's judgment; where it falls outside the
labels the case must say why in `divergence`, which is how the advisory
classifier's known disagreements stay written down instead of being
rationalised into a widened label. What a parent model actually passes to
`cp_dispatch`/`cp_pipeline` costs money to measure: `live_trials.status` is
`pending_operator_approval`, no quality number is claimed anywhere, and
`docs/evals.md` §Parent classification cases holds the protocol to run once an
operator approves it — which reuses do8.7's own runner primitives (arm
versioning, the `CP_EVAL_LIVE` money gate, transcript parsing) rather than a
second eval platform. The loader and validator live in `src/evals.ts` beside
the worker-prompt corpus's, for the same reason.

**Scope and risk are inferred when nobody supplies them (cp-rte).** The rubric
matches on `scope` and `risk`, and both defaulted to `S`/`low` for any dispatch
that omitted them — so unlabelled work silently routed as small. For every axis
a caller does not name, `inferScopeAndRisk` reads the job's own words (task plus
the br title and description): structural or cross-cutting wording means
`scope: M` (not `L` — that is a human's call), and destructive,
history-rewriting, credential-touching, money-touching or production wording
means `risk: high`. Both `inferScopeAndRisk` and the H6 `riskKeywords` read one
traversal, `acceptedRiskMatches` (bead b-qbi.2): every signal match is checked,
and one negated in its own short clause is dropped: `do not`, `must not`,
`don't`, `never`, or `no` allows up to three intervening words ("no database
migration", "no schema or data migration", "never deploy to production";
bead nfm). `not` and `without` retain the narrower gerund/safety-verb rule
("without touching production"). Punctuation or `but`/`and`/`then` ends the clause.
"Never force-push" is not evidence, while "deploy without tests to
production", "do not wait to purge the table" (bead b-qbi.6) and an affirmative
match elsewhere still are. Coordinated credential nouns share the negation
("never expose secrets or tokens"), but a new action does not ("or delete rows"
or "or rotate credentials"). `or` starts a fresh clause by default, except
for coordinated credential nouns and schema/data/database migration modifiers;
unrecognized noun coordination may conservatively warn.
Markdown sections headed `Constraints`, `Non-goals`, `Test plan`, `Evidence`, `Unknowns`
(`Unknowns/Blockers`), `Self-assessment` or `Acceptance` are excluded, including
subsections, until the next same-level or higher heading (bead dbn, cp-wkv1); the
dispatch joins the job title as a `# Job: <title>` heading, so neither a task's last
section nor a title such as "Evidence" swallows the job description.
Access wording means access work (`auth`,
`authentication`, `authorization`, `credentials`, …), never `authority` or
`author`. Explicit/assessed highs and the H6 recorded-low rule are unchanged.
These senses are not risk evidence (`benignSenseAt`, `src/risk-negation.ts`,
riskkw-f10): R1 `token(s)` as LLM usage or design tokens (a context/cached/output/
colour qualifier, a magnitude such as `53.6M`, or a following `cap`/`budget`/
`window`/`usage`/… or "in context"), unless a credential qualifier (`api`,
`access`, `bearer`, `leaked`, …) precedes it; R2 `delete`/`backfill` inside an
identifier (a path, a dotted name, a job id of three or more hyphenated
segments); R3 `delete`/`backfill` naming a step (`backfill failure`, `delete
advice`); R4 a negation — `stop advising/recommending/suggesting/telling` joins
the negation cues for every signal, and `delete`/`backfill` inside a quoted span
after a mention verb (`calls it 'safe to delete'`) is reported speech. R2, R3 and
the quoted-span rule stay limited to those two words. cp-wkv1 adds three more:
R1 also covers spend tokens (`estimate the tokens`, `context-tokens`, `noncached`,
and `tokens` coordinated with `usd`/`cost`/`spend`/a bare `$`); R5 `migration`
followed by `: none` or `: n/a`; R6 a history rewrite named only as one option of
a remedy list right after `fix`/`remedy`/`recommend…` (`fix (delete/redact/rewrite
history)`) in a purely advisory text that declares a read-only audit, review, answer
or report and has no action cue (`then`, `first`, `next`, `apply`, `run`, `execute`,
`perform`, `push`, `on main`); a bare `read-only` elsewhere ("keep backups read-only;
run squash/rewrite history") or a later action ("Read-only audit first, then fix:
squash/rewrite history on main") is not enough. A credential qualifier counts joined
by a hyphen too (`github-tokens`).
Approval-sense `authorization` ("applicable risk
authorization") is still evidence: record `risk: low` on the job instead.
Explicit values always win, and the run log records which it was:
`cp:routing_resolved` carries `model`, `source`, `rule`, `thinking`, the inputs
used and, when inferred, the reasons. A model chosen from inferred inputs has to
be explainable afterwards.

**The two axes are assessed independently (cp-routing-provenance).** Inference
used to be switched off wholesale the moment *either* axis was supplied, so
`scope: M` on "rotate production credentials across services" threw away every
risk signal in the text and routed it `M`/`low`. `resolveRoutingInputs()`
(the one resolution boundary — it lives in `src/pipeline.ts` beside
`inferScopeAndRisk` so the pipeline can use it without a module cycle, and
`src/dispatch.ts` re-exports it) assesses each missing axis on
its own and overlays the caller's value on **its own axis only**;
`override > rubric > profile` and the workflow-mode classifier are untouched.
The standing `S`/`low` defaults are normalized there, once, instead of being
substituted invisibly inside `pickModel()`, so the record carries the values
routing was actually given.

Where each of them came from is `JobRouting.provenance`, per axis, one of four
words: `explicit` (the caller named it), `assessed` (a planner's own
`self_assessment` did — the pipeline passes `inputsFrom: "assessed"`),
`inferred` (a keyword signal found it), `defaulted` (nothing named it and
nothing was found). **The object is present or absent as a whole**: both axes
are required inside it, so a half-written `provenance` is refused by the
contract rather than leaving one axis to fall back to the one-bit flag — which
is the very relabelling this field exists to remove. `formatScopeRisk` applies
the legacy fallback only when `provenance` is absent entirely, so even a
hand-edited partial object cannot mark an axis it does not describe.
`JobRouting.reasons` carries the bounded keyword evidence,
and only for the axes that were actually inferred. The legacy `inferred` boolean
stays required and means "**any** axis was inferred"; a reader that has
`provenance` prefers it, because one inferred axis must never relabel an
explicit one. Records written before `provenance` existed keep validating and
keep rendering exactly as they did — no provenance is invented for old data, and
no historical event is rewritten. Same record, same `cp:routing_resolved` event:
the event carries `provenance` beside its existing one-word `inputs` summary,
never a second journal.

**A plan's confidence is not a measurement of what the work touches (routing
T2).** `cp_pipeline start` passed the operator's `scope`/`risk` to the *research*
dispatch and kept neither, so at handoff time the implementer's inputs came from
the planner's `self_assessment` alone: `routingInputsFrom()` emitted `risk: low`
for any plan that was confident, non-destructive and unblocked. Rotating
production credentials with a good plan therefore routed as low risk — and
because an emitted axis switches off dispatch's own inference, the task's own
words could not put it back. The two things being conflated are:

- the **plan's** properties — `scope`, `confidence`, `destructive_scope`,
  `blocking_unknowns`. That is what a planner can measure;
- the **task's** impact — production, credentials, money, data. That is
  `PipelineRecord.task_impact` (`TaskImpactSchema`, a `JobRouting` plus the
  source it was read from), assessed from the original task at `start` — the
  axes the operator named, overlaid on what the task's own words say — and never
  rewritten by an advance.

`composeImplementationRouting()` (`src/pipeline-risk.ts`) puts them together, and it
is the same composition `#authorize` shows the human and `#dispatchImplementer`
sends: **known impact is never lowered** (a `risk: high` from any source but
`defaulted` stays high, whatever the planner reports), **uncertainty may only
escalate** (a destructive, blocked or low-confidence plan raises risk to `high`),
and **`risk: low` is never emitted by the pipeline at all** — silence leaves that
axis to `resolveRoutingInputs()` at dispatch, which re-reads the ship job's own
br title and description (the original task) and defaults to `low` only when it
finds nothing. **Scope may shrink**: a plan that narrows an `L` task to an `S`
change is exactly the evidence scope is for, so the planner's `scope` wins its
own axis and the task's is the fallback, never a floor to max against.
`DispatchRequest.inputsFrom` is per-axis for this reason — one dispatch can
carry an `assessed` scope beside an `explicit` risk.

Deliberate reclassification is unchanged and still explicit: `cp_dispatch` with
`scope`/`risk` on the ship job, recorded as `explicit` provenance with a human
behind it. **No automatic advance can do it**, and none of this touches the gate
or the checkpoint — a passed gate is still not authorization, and an absent or
declined one still dispatches nothing.

What happens when the fact is missing is the other half of the contract.
`recoverShip` re-dispatches from the same record, so it retains the same impact
for free; `reanchor` copies `task_impact` onto the replacement record, because
replacing the *plan* does not change what the ship job's task touches. A record
written before `task_impact` existed falls back, in order, to the research job's
persisted `FleetRecord.routing` (the effective input its dispatch was actually
given, provenance included) and then to the frozen original task on disk
(`paths.originalTaskFile`, do8.3) — reusing trustworthy facts rather than
inventing an assessment. Nothing found at all is **absent**, not low: no axis is
emitted and dispatch assesses the ship job's own words. A frozen task that
*exists and cannot be read* is neither — it throws `PipelineError`, because "we
could not look" must never be rendered as "there is no risk".

**The decision is persisted on the fleet record too, not just the run log
(cp-status-scope-risk).** `cp:routing_resolved` answers "what happened", but it
is an append-only log entry — not something `/status` or the status block reads
for a live view. Dispatch writes the same scope/risk/thinking, plus whether they
were inferred, onto `FleetRecord.routing` (`JobRoutingSchema`) once, at dispatch
time. `/status`, the widget and the status block's "In progress" section read
*that* field back verbatim — they never call `inferScopeAndRisk` again, so a
rendered value can never drift from what actually chose the model. Rendering
convention: `S/low` was chosen, `M?/high?` was inferred (the `?` is **per axis**,
so `M?/low` is an inferred scope beside a named risk), `-` on a side means
routing defaulted there, and a job with no `routing` at all — dispatched before
this field existed — renders as `—` (em dash), never a guessed `S/low`: exactly
the silent-default failure mode cp-rte fixed for routing itself. See
[§Status view](#status-view) for where this is read and shown.

**Effort travels with the model (cp-eff).** `thinking` on a rubric row sets the
worker's level for jobs that row matches; a row that omits it leaves the
profile's in force, because routing narrows policy rather than resetting what it
did not mention. Levels are pi's: `off | minimal | low | medium | high | xhigh |
max`, and they are valid on **any** model — pi maps a level to whatever the
provider supports (extended-thinking budgets on Claude Haiku 4.5, adaptive effort
on the opus/sonnet/fable line). A level on a non-reasoning model is inert, not an
error, which is why there is no model table here to rot — but a level pi's own
live metadata says the resolved model **cannot serve** is refused before the
spawn whichever source named it (see the effective-effort rule below).

**An explicit override can carry the effort, and never downgrades it silently
(cp-ot3b).** `cp_dispatch` accepted `model` and no effort, so an operator who
asked for a model *at `xhigh`* got the model they named and the **profile's**
level, with nothing announcing it: the routing line read `source=override
model=… rule=explicit override thinking=high`, and the only way to get both was
to edit the rubric row — which changes routing for every job that row matches
instead of the one job the operator asked about. So:

- `cp_dispatch`'s `thinking` parameter is part of the same explicit override as
  `model`, and works **without** it (today's model at a different effort is
  still an instruction). A caller-named level outranks the matched rubric row's
  and the profile's; the ladder's own precedence is untouched, and the allowlist
  still gates the model — "period" is about the effort being honoured, not about
  bypassing the gate that caught a bad model id.
- **It is honoured or refused, never substituted.** `ModelProbe.supportedThinking`
  reads pi's own model metadata (`reasoning: false` serves nothing but `off`;
  `thinkingLevelMap[level] === null` marks a level unsupported), and a level the
  model cannot serve is a `RoutingError` before the lease, naming what was asked
  and what is available — the same shape as the allowlist's refusal, which is
  what let an operator find the real model id after a bad one was refused.
  A probe that cannot answer is **ignorance, not evidence**: the override is
  honoured, never quietly reduced.
- **A differing effort is legible.** `RoutingDecision.requested_thinking` records
  what was asked whenever an override named a level, and
  `formatRoutingDecision` appends `effort=override` when it was honoured and
  `requested_thinking=<level> effort=NOT-HONOURED` when the resolved level is not
  the requested one. A dispatch that names no effort produces exactly the line it
  produced before.

`cp_send` carries no effort by design (a promote is the same worker, same
session, same model — routing is not re-run).

**A reviewer routes on its subject's axes, and spawns the whole decision
(cp-reviewer-routing).** The three reviewer surfaces — the plan gate, the diff
review, the quality panel — used to resolve `.model` and throw the rest away:
they passed routing no `scope` and no `risk`, so every reviewer resolved at the
standing `S`/`low` default and a rubric row scoped to large or risky work could
never fire; and because the resolver returned a string, the row's `thinking` was
dropped and the worker spawned at the profile's level. Now:

- **The inputs are the subject job's own**, per axis, read from
  `FleetRecord.routing` (`reviewerRoutingInputs()` in `src/routing.ts`).
  Reviewing an L/high job is L/high work — the reviewer reads that plan or that
  diff — even though the reviewer itself is a read-only, research-shaped worker.
- **A missing axis is `unknown`, never a measurement.** A subject dispatched
  before `routing` was recorded has no axes; routing still needs a value and
  still uses its documented `S`/`low` default (`pickModel`), but nothing claims
  that subject was *measured* small or low-risk. Provenance is per axis
  (`inherited` | `unknown`), so a known-high risk is never overridden by the
  other axis being missing.
- **Model and effort travel together to the spawn.** Each surface passes
  `RoutingDecision.thinking` to `WorkerManager.spawn`, so the argv carries the
  level routing resolved rather than the profile's.
- **The spawn records the decision once**, as a `cp:routing_resolved` event in
  its own run directory (`reviewerRoutingEvent()`): model, source, rule, effort,
  the axes routing was given, their provenance and the subject's own. Requested
  and effective are separate fields under `RoutingDecisionSchema`'s own names —
  `model`/`thinking` are what spawned, `requested`/`requested_thinking` are what
  an override asked for — and each appears only when it exists, so a reader
  parsing fields sees exactly what the prose `line` says. `attempt`
  is present only for the surfaces that *have* one — the gate and the diff review
  number their attempts; the quality panel does not (one pass per job,
  write-once report), and its unit of work is the voter slot, which `surface`
  names (`quality/verify-1`). A constant `attempt: 1` there would invent a
  numbering the panel does not have. The quality panel resolves once at the start
  of the attempt and carries that decision through every voter, so a config
  edited mid-panel can never re-attribute a voter that is already running.
- An explicit reviewer model override (`cp_gate`/`cp_review`'s `model`,
  `QualityConfig.model`) is unchanged: it still wins, and a model-only override
  still keeps the profile's effort.

**The effective effort is capability-checked, whichever source named it
(cp-reviewer-routing).** `resolveModel` used to check `supportedThinking` only
when the caller explicitly named a level, so a rubric row's or a profile's level
that the model cannot serve reached the spawn and was silently substituted by the
provider — the same defect cp-ot3b refused for overrides, arriving through the
other two doors. The level that will actually spawn is now the level that is
checked, and the refusal names which of the three sources asked for it. The two
exceptions are deliberate: **absent metadata** is ignorance, not proof (as
before), and a model that **does not reason at all** keeps its inert-level
semantics for a level nobody explicitly asked for — every profile carries a
level, so refusing there would ground every worker routed to such a model. An
explicit override is still refused there, because a person asked for effort they
would otherwise silently not get.

"Does not reason at all" means **both** shapes of `supportedThinking`'s answer:
`["off"]` (what `supportedThinkingFor` returns for `reasoning: false`) and `[]`
(a `thinkingLevelMap` that nulls every level, `off` included — and any
`ModelProbe` implementation that answers empty; the refusal's `(none — this model
does not reason)` branch has existed since cp-ot3b for exactly that answer).
Reading `[]` as "this level is unsupported" would refuse every profile-supplied
effort on such a model, which is the outcome the exemption exists to prevent.

**`pins[]` was removed (cp-cxt).** Two mechanisms decided one thing and the
identity-based one ran first, so any pin silently switched off size-based routing
for everything it covered, a broad pin shadowed a narrow one with no warning, and
a `job_id` pin could be neither probed by `/doctor` nor pruned by anything. The
rubric absorbed the useful half — a row may name a `project` — and a single job's
exception is an `override` at dispatch, where the person making the exception is.
A config that still carries `pins` is **refused with the migration**, not
silently ignored: rows become `{ id, role, project?, scope?, risk?, model }`.

`allow` is a glob allowlist over `provider/model-id`; an empty `allow` **in the
file** allows nothing (fail closed — an operator who writes `allow: []` means
it). A **missing** `data/routing.json` means "no policy configured yet" and
falls back to `DEFAULT_ROUTING_CONFIG` (`allow: ["*/*"]`, no rubric rows):
the only reachable models are then the profile's own and one the operator
explicitly names. `DEFAULT_ROUTING_CONFIG` itself never changed for this: the
in-code fallback still means exactly that, whether or not a file ever gets
copied in.

**The rubric below is shipped, not merely illustrated (cp-default-rubric).**
It lives as a tracked template, [`defaults/routing.default.json`](../defaults/routing.default.json),
its single location (cp-u3i2). `scaffoldHome`'s `routing.default` step — the same self-scaffold
`session_start` and `cmdp scaffold` already run — copies it to
`data/routing.json` **once**: only when that file does not already exist. The
copy is a step in `ScaffoldReport.steps` (`created` the first time, `present`
ever after), so it is visible in the same log a fresh home already prints; an
operator's existing `data/routing.json`, however it got there, is never
touched again — this is the *only* write the scaffold ever makes to a routing
decision. A home whose package root ships no template (an old install) gets a
`skipped` step and behaves exactly as before: `DEFAULT_ROUTING_CONFIG`'s
in-code fallback is what fires, because a missing file still means "no policy
configured yet", copy-once or not.

A copied default reads as configured policy, not as a surprise: once it lands,
`/doctor`'s `config.routing` finding reports it exactly like any other
`data/routing.json` (`routing config: N rubric row(s)`), because from
`loadRoutingConfig`'s side there is no difference — the file exists, and it
validates.

`allow: ["*/*"]` in the shipped default is deliberate: a template that locked
an operator into `anthropic/*` would fail closed for anyone on another
provider. **Narrow it** to the providers you actually authenticate once you
have copied the file — this is the one line every operator should expect to
edit.

T13 amendment: the matcher is a dependency-free subset of minimatch — `*`
within a segment, `**` across segments, everything else literal. That covers
every shape the allowlist uses (`anthropic/*`, `*/*`, `**`, exact refs) without
importing brace/negation semantics nobody wanted.

The allowlist gates **every** source, including the profile default: a rubric row
or profile that names a refused model is a configuration error, not a silent
skip. Availability means the pi model registry knows the model **and**
its provider auth resolves (`registryProbe`) — known-but-unauthenticated is
unavailable. It is probed *before* the lease, so an unavailable model never
leaves an orphan branch. Every decision is printed and stored as
`source=/model=/rule=` (`RoutingDecisionSchema`).

The shipped default, `defaults/routing.default.json` (models as of this writing —
check `pi --list-models`, and see [choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)):

```json
{
  "schema_version": 1,
  "allow": ["*/*"],
  "rubric": [
    { "id": "risky-any", "role": "planner", "risk": "high", "model": "anthropic/claude-opus-5-5", "fallbacks": ["openai/gpt-6.1-sol"], "thinking": "xhigh" },
    { "id": "risky-ship", "role": "implementer", "risk": "high", "model": "anthropic/claude-opus-5-5", "fallbacks": ["openai/gpt-6.1-sol"], "thinking": "high" },
    { "id": "reviews", "role": "gate-reviewer", "model": "anthropic/claude-opus-5-5", "fallbacks": ["openai/gpt-6.1-sol"], "thinking": "high" },
    { "id": "research-big", "role": "planner", "scope": ["L"], "model": "anthropic/claude-opus-5-5", "fallbacks": ["openai/gpt-6.1-sol"], "thinking": "high" },
    { "id": "big-ship", "role": "implementer", "scope": ["M", "L"], "model": "anthropic/claude-opus-5-5", "fallbacks": ["openai/gpt-6.1-sol"], "thinking": "medium" },
    { "id": "small-ship", "role": "implementer", "scope": ["S"], "model": "anthropic/claude-sonnet-5-5", "fallbacks": ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"], "thinking": "high" }
  ]
}
```

The four shipped profiles carry the same shape, one `fallbacks:` line each
(`[openai/gpt-6.1-sol]`), which is what makes the profile-sourced routes
— ordinary planning and QA — resolve on a one-provider machine too. The
candidates and the capability evidence behind them are in
[`docs/routing-rollout.md`](routing-rollout.md); with Anthropic authenticated
every route resolves to its preferred candidate, with no `attempted` list.

Rows are matched in order, so the narrow ones come first: the two `risk: "high"`
rows before the size rows. Both remaining planner rows resolve to opus and
differ only in `thinking` — kept explicit rather than collapsed, because each row
documents an operator decision and a later model change is then a one-row edit.
`claude-fable-5` is deliberately unused. Add `"project": "<registered name>"` to
a row to make it apply in one repository only.

**Ordinary planning and ordinary QA route through their profiles, not through a
rubric row (cp-routing-t4).** The shipped template used to carry a broad
`research` catch-all (`role: planner`, no `scope`, no `risk`) as its last planner
row. Because `qa` shares the `planner` role — there is no separate role, purpose
field or profile matcher, and none is being added — that row matched **every**
small question `cp_ask` dispatched as well as every ordinary plan, and the two
profiles' own `model`/`thinking` defaults could never take effect. The row is
removed. What each case resolves to now:

| case | source | model | effort |
|---|---|---|---|
| QA (`cp_ask`, S/low) | `profile qa` | `profiles/qa.md` (Opus 5.5) | `low` |
| ordinary planning (S or M, low risk) | `profile planner` | `profiles/planner.md` (Opus 5.5) | `medium` |
| planning, scope L, low risk | rubric `research-big` | Opus 5.5 | `high` |
| planning, any scope, high risk | rubric `risky-any` | Opus 5.5 | `xhigh` |
| explicit `model`/`thinking` override | `override` | as named | as named |

**History.** cp-routing-t4 moved ordinary low-risk planning off the catch-all
(then Opus 5) onto the planner profile (then Sonnet 5), with `profiles/planner.md`'s
`thinking` moved `high` → `medium` so the ordinary effort was retained rather
than raised by the fall-through. Since the 2026-09-23 model refresh that profile
is Opus 5.5 at `medium`, so ordinary planning is back on the top Anthropic tier
without a row; large and high-risk planning still come from their narrow rows,
which differ only in effort. Re-adding a planner catch-all is now only a way to
change the ordinary *effort*.

**An existing `data/routing.json` is unaffected by this, on upgrade and
forever.** The scaffold's `routing.default` step is copy-once (`present`, never
`created`, once the file exists), so a home that already carries the old
seven-row rubric keeps its `research` catch-all byte for byte and keeps routing
ordinary planning to Opus. That is not a stale file to be corrected: it is
configured policy, and it stays in force until the operator deletes the row
deliberately. Only a home with no `data/routing.json` at all gets the new
six-row template.

The ported rubric (command-post `reports/model-routing.md`) becomes `rubric[]`
rows on `role`/`project`/`scope`/`risk`, first match wins, with the ported
defaults `scope: S`, `risk: low` — so **order rows narrow-to-broad**, because a
broad row placed first shadows every narrower one after it. Row 0 (caller
override) is resolution rule 1 here; the
gate's "operational retry on a different model" row is an explicit `override`
issued by the gate module (T20), because it depends on the previous attempt's
cause — gate state, not routing input.

## Gate config

`data/gate.json` (`GateConfigSchema`): the one operator knob on the gate reviewer,
`review_timeout_ms` — how long a one-shot review may run before `#awaitVerdict`
counts it as `operational` (no verdict file, no rejection file, the worker
exited, or it settled without reporting one). Absent means the built-in
default (`DEFAULT_REVIEW_TIMEOUT_MS`, 300_000ms / 5 minutes) — no behaviour
change for an operator who never opts in. Bounds are `GATE_REVIEW_TIMEOUT_MIN_MS`
(1_000ms — below this a "timeout" is just a flaky reviewer with extra steps)
and `GATE_REVIEW_TIMEOUT_MAX_MS` (1_800_000ms / 30 minutes — the ladder already
caps retries at two attempts before `operational_persistent` reaches a human,
so 30 minutes per attempt is generous slack for a slow model without turning
one stuck reviewer into an hours-long silent stall). A value outside the bounds,
non-numeric, zero or negative is a refusal (`GateError`) naming the fix, not a
silent clamp.

This config exists apart from `data/routing.json` and `data/budgets.json`
because it answers a different question than either: routing decides *which*
model reviews, budgets bound *cost*, and this decides how long the parent waits
for *this one attempt's* answer before giving up on it. It is not a routing rule
(no role/project/scope/risk to match on — there is exactly one reviewer role)
and not a budget (a slow reviewer that eventually answers is not an overspend).

**Read per attempt, not at parent startup (cp-sr5 amendment).** This repo
already shipped the cached-config bug once — a budget raise that needed a
parent restart because the fleet ceiling was read once, at construction, and
never again. `Gate#awaitVerdict` calls `resolveReviewTimeoutMs(home)` itself,
fresh, every time a review attempt starts; the constructor's `reviewTimeoutMs`
option is an explicit override for callers (tests) that want a fixed value
regardless of what is on disk, and it takes priority when set. An operator who
edits `data/gate.json` and re-runs `cp_gate` sees the new value on the very next
attempt, whether that attempt reuses the same `Gate` instance (a shared pipeline
runner retrying an operational fault) or a freshly constructed one
(`CommandPost.gateModule()`, built per call for exactly this reason).

`/doctor` reports the resolved value as `config.gate.review_timeout_ms`
(`ok`, always — there is nothing to clamp against, unlike the budget ceiling),
naming whether it came from `data/gate.json` or the default, the same way it
reports `config.budget.<profile>`.

## Budgets and failure taxonomy

`data/budgets.json` (`BudgetConfigSchema`): `per_job_tokens`,
`per_job_cost_usd`, optional `cumulative_cost_usd`, `warn_ratio` (soft gate),
`spawn_cap` (ordinary concurrent-worker limit, with three extra reviewer-only
slots). Defaults: 50M tokens, $50, warn at 0.8,
10 workers (`DEFAULT_BUDGET_CONFIG`).

Budget breach **escalates to the operator**; it never silently kills a worker
and it never blocks parent -> worker delivery (cp-d7y) — the message that
fixes a run is the cheapest correction there is, and refusing it does not save
a token; the worker keeps running and burning them regardless, just without
the correction. The soft gate is checked from usage events before the next
prompt/steer, purely to shape the receipt and the escalation.

The budgeted token total excludes `cache_read` (cp-d7y): a cache read prices
at a small fraction of an input token, so counting it at full weight makes a
long, mostly-cached, cheap run look like it is burning budget when the real
backstop — cost — says otherwise. `checkBudget` computes its token ratio from
`total_tokens - cache_read` (`billableTokens`), not raw `total_tokens`.

The effective per-job ceiling is frozen into the run at dispatch
(`resolveJobBudget` = `min(profile budget, data/budgets.json)`), so neither
file can be edited to change a limit for an already-dispatched job — only a
fresh dispatch picks up a new `data/budgets.json` (and, if the profile sets
its own `budget:`, that profile file too, since the effective ceiling is the
stricter of the two).

Two more ways a raise used to fail to apply, both closed by cp-sr5:

- `CommandPost` reads `data/budgets.json` per call (`budgets()`, per the file
  header in `src/command-post.ts`) and hands `WorkerManager`/`Sender` a
  **getter**, not a value — a raise reaches the very next spawn or send in the
  same parent session, with no restart. `WorkerManager.spawnCap` reads the
  same config the same way, so it is not a second, separately-stale path.
- The `min()` clamp is silent by design (a caller gets only the winning
  number), so a raise to a profile or to `data/budgets.json` that the other
  side still overrides must be surfaced separately:
  `detectBudgetClamp(profile, config)` answers which side clamped, dispatch
  logs a `cp:budget_clamped` event on any job it clamps, and `doctor` reports
  each profile's live effective ceiling as `config.budget.<profile>` (`warn`
  when clamped) — checkable before dispatching, not discovered when a send is
  refused.

Failure classes (`FailureClassSchema`) and whether a retry is even permitted
(`FAILURE_RECOVERABLE`; the ladder itself is T18):

| class | recoverable | typical evidence |
|---|---|---|
| `agent_empty_output` | yes | settled with no assistant content and no envelope |

| `provider_limit` | yes | `auto_retry_*` exhausted / provider limit error |
| `model_call_failed` | no | assistant `message_end` with `stopReason: "error"`, and the run has no assistant text and no tool call at all |
| `timeout` | yes | no events past the inactivity deadline |
| `crash` | yes | observed close **with no settle behind it** |
| `settled_without_report` | no | the run settled (or settled then exited) with work done and no envelope |
| `tool_loop` | no | repeated identical tool calls past the cap |
| `budget_exceeded` | no | soft gate breached |
| `wall_clock_exceeded` | no | per-job wall-clock per round (`DEFAULT_JOB_WALL_CLOCK_SECONDS`, `data/worker-bounds.json`, `CP_JOB_WALL_CLOCK_SECONDS`) |
| `tool_call_cap_exceeded` | no | per-job `tool_execution_start` count (`DEFAULT_JOB_TOOL_CALL_CAP`, `CP_JOB_TOOL_CALL_CAP`) |
| `envelope_invalid` | yes | repair attempts exhausted |
| `spawn_failed` | no | child exited without emitting a single event |

### Classification, budgets and the recovery ladder

[`src/failures.ts`](../src/failures.ts) keeps three jobs apart:

**Classify** (`classifyRun`) reads the run's event log and names what happened,
with the evidence attached. It answers `undefined` when there is nothing to
classify — an unfinished job is not a failure, and no cause is ever guessed
into existence. Two rules earn their keep:

- a run that **reported** is never a failure, whatever its process did next;
- a close preceded by `cp:shutdown_requested` is **ours** and deliberate
  (teardown), so it is not a crash. T18 amendment: `spawn_failed` therefore
  means "exited without emitting a single event", because pi's RPC stream has
  no `session_start` event to wait for.

cp-0wq7 amendment: **a worker that could not call its model is not a worker
that chose to stop.** When the model call fails — an invalid API key, an
unroutable model, a provider refusing outright — pi still starts the agent
loop, still emits `turn_start`/`message_start`, and still settles; the
assistant message just comes back `stopReason: "error"` with zero tokens and
empty content. The turn *looks* complete, which is why four such workers were
recorded as `unreported` (a two-second run, 0 tokens, 0 tool calls) and each
absorbed a nudge, a revive and a hand-written promote before anyone read the
error out of the log. `classifyRun` now names it `model_call_failed`, before
the exit/settle branches, and only when the run produced **nothing at all** and
pi is not still retrying it. Three exclusions, all evidence: an errored call in
a run that went on to write code is an incident pi already recovered from; an
`auto_retry_start` with no matching `auto_retry_end` is pi's own ladder still
working, and a ladder that gives up says so with `auto_retry_end`
(`success: false`), which is `provider_limit` and is checked first; an
`auto_retry_end` with `success: true` clears the error outright, because the
provider answered (`readModelCallError` / `detectDeadModelCall`).

cp-settle-without-report amendment: **a settle before the exit is the whole
difference between `crash` and `settled_without_report`.** A crash is an exit
with no settle; a run that settled cleanly and then ended did its work and
skipped the last tool call, and its branch is usually pushed and its PR usually
open. Naming that a crash is what recorded four green, merge-ready PRs as
failures.

### The settle boundary (`src/settle.ts`)

A settled agent never reports without another prompt. That was already known
for gate reviewers (T20) and applied nowhere else, so five workers finished
their jobs — four with green PRs, one with a 19KB artifact — and filed nothing;
the parent, which sleeps on envelopes and polls nothing, slept for fourteen
hours.

`SettleWatcher` closes that seam **at the worker boundary, never with a
parent-side poll**. Every trigger is an `agent_settled` event on the worker's
own stream, the same fact intake already wakes on:

1. ask intake (idempotent) whether an envelope is on disk — "did it report?"
   stays a fact, not a race;
2. a job that reported, or that is not in a live phase, is left alone;
3. otherwise increment `unreported_settles` on the fleet record and, on the
   **first** one only, prompt the worker once with `REPORT_NUDGE_TEXT`
   (`cp:report_nudged`);
4. any later unreported settle — or a nudge that cannot be delivered, or a
   worker already gone — is recorded as `cp:settled_without_report` and never
   prompted again. One prompt, then the truth.

**One settle is never prompted at all (cp-0wq7): a worker that could not reach
its model.** Before any prompt is composed, the boundary reads the run log and
asks `detectDeadModelCall`: an errored model call, no assistant text, no tool
call. That worker is dead on arrival — there is no branch to inspect, no
artifact, nothing to promote — and a prompt cannot fix a credential, so every
prompt sent at it produces one more two-second, zero-token settle (which is
exactly what four of them did). It is recorded as a `model_call_failed` failure
with the provider's own words and the job is marked `failed` with that cause,
so `/status` says what happened instead of `unreported`. The log read is gated
on the projection this boundary has already loaded (`mayBeDeadOnArrival`):
parsing the whole of `events.jsonl` is only ever done for a run whose
`status.json` reports **zero tokens and zero tool calls**, so a long job's
multi-megabyte log is never re-scanned on a settle, and the logs that are
parsed are a handful of events by construction. A missing or unreadable
projection answers "maybe": the gate saves work, it never decides the question. This is the **only**
place the settle boundary marks a job failed, and the reason it may is the exact
inverse of the invariant below.

Two invariants hold it honest:

- **The job is not marked `failed`.** Its worker may still be idle, alive and
  holding the whole job's context, and `cp_send` refuses anything that is not
  live — marking finished work `failed` is precisely what closed the natural
  recovery path ("there is nothing to promote") at the moment it was needed.
  The phase stays `waiting`; the counter carries the fact.
- **The nudge budget is per brief, not per job.** An accepted envelope
  (`EnvelopeIntake`) and a promote (`Sender.send`) both call
  `FleetStore.clearUnreportedSettles`, so a worker handed new work always has
  a fresh chance to report it — the same invariant `src/supersede.ts` enforces
  for the envelope slot itself.

`unreported_settles` travels to `StatusJob`, and `jobState` (`status-render.ts`)
returns the state kind `unreported` — ahead of `failed`, because when both are
true the specific word is the honest one. `/status`, the fleet widget and the
status block therefore all say `unreported` rather than `idle` or `failed`,
from the one shared vocabulary.

#### Unreported-with-work, recovered automatically and bounded

`unreported` covered two situations that need opposite handling and could not be
told apart: a run that settled with **nothing** on disk, and a run that settled
with the work **still in its worktree**. The second happened seven times in one
day — up to 834 insertions across 12 files and $8.56 of spend in a single job,
three of them cut off mid-turn by provider incidents — and every recovery was
the parent noticing by hand, running `git status` in the worktree, and sending a
promote that said *this is what is on disk; do not redo it; commit, push,
report*. Teardown would have destroyed the work in every one of those cases.

So the settle boundary now **looks, acts once with evidence, and stops**:

1. **Looks.** `inspectWorktreeWork` (`src/worktree-work.ts`) runs read-only git
   in the job's own worktree — `status --porcelain`, `rev-list --count HEAD --not
   --remotes=origin`, and one `ls-remote` — and classifies it as `clean`,
   `dirty`, `unpushed` or `unknown`. Those first two words are the teardown
   gate's own (`GATE_CODES`): the same two git conditions, observed at the other
   end of the job. The result is written to the fleet record as
   `unreported_work` — a **fact, not a log line** — so `/status`, the widget,
   `/watch` and the wake-up all read one observation instead of each re-deriving
   it. `unknown` is ignorance, never evidence: it can never trigger a prompt.
2. **Acts.** When work is present the prompt is `recoveryPromptText`, not the
   bare nudge: it carries the worktree path, the branch, whether origin has that
   branch, the counts and up to `UNREPORTED_WORK_FILES_SHOWN` paths, and it asks
   for exactly the mechanical finish — commit on the job branch, push, verify,
   `report_result` once, or `blocked` with the command and error. It explicitly
   forbids redoing or re-analysing anything, and it is deliberately **not** a
   re-brief: the worker still holds the job's context, and re-describing the
   task is the token cost the bound exists to avoid.
3. **Stops.** `MAX_RECOVERY_PROMPTS` (2) attempts per generation, counted on the
   **existing** `unreported_settles` counter — no second counter, and it lives on
   disk, so a parent restart cannot hand out a fresh budget. The second prompt
   says it is the last. Beyond the bound: `cp:settled_without_report` plus
   `cp:recovery_exhausted` with the evidence, the job stays `waiting`, and the
   `cp-unreported` wake-up names what is on disk and that nothing was deleted.
   Never another prompt for that generation.

Four things this path may never do, each enforced above rather than remembered:

- **Never prompt a job that has reported.** It reads the same `reported_at` the
  accept path writes (plus `hasEnvelopeOnDisk` on the retry), which is the fix
  cp-rud made structural after a stale flag produced an unbreakable
  prompt→refuse loop.
- **Never prompt a delivery that landed.** A merge receipt (`cp_merged`), a
  `merged` PR receipt, or a `done` job is ignored with a reason.
- **Never prompt a job mid-tool-call.** The wedged/unreported exclusion stays
  structural (cp-m44c): if the projection says the run is `working` with a call
  in flight, this settle is not unreported and nothing is sent.
- **Never touch the worktree.** `WORKTREE_READ_ONLY_GIT` limits this module to
  `status`, `rev-list` and `ls-remote`, and the runner throws on anything else.
  Nothing in the recovery path deletes, resets or cleans anything — the work on
  disk is the entire reason the path exists.

`unreported_work` is cleared by the same atomic mutation that stamps
`reported_at` and by `clearUnreportedSettles` (a promote), for the same reason
the counter is: it describes one generation's silence and must not outlive it.

#### Unreported vs. wedged: two watchers, one vocabulary

This and the wedged-tool-call watch (cp-wedged-tool-call, `src/wedged.ts`) are
two of the four things besides an envelope that wake the parent unasked (the
others are an answered decision, cp-answer-doesnt-wake, and a CI/PR fact,
cp-e2d), and these two describe **opposite halves of the worker lifecycle**:

| | wedged | unreported |
|---|---|---|
| the run is | mid-call (`working`) | stopped (settled, or exited) |
| the fact is | a `tool_execution_start` with no matching end, silent past the threshold | an `agent_settled` with no envelope for the live generation |
| how it is noticed | the widget tick, over the file-derived snapshot | the worker's own `agent_settled` event |
| what happens | one `cp-wedged` notice per call | one prompt, then one `cp-unreported` notice |

The different trigger mechanisms are **required, not duplicated plumbing**: a
wedged worker emits no events at all, so nothing on the stream could ever fire
for it and only a periodic read of the projection can see it; a settled worker
does emit the event, so adding a tick for it would be exactly the parent-side
poll this fix exists to avoid. Neither module scans the run log a second time.

[The CI/PR watch](#the-cipr-watch) is the **third** shape, by the same
argument taken one step further: its fact lives on GitHub, no process here emits
it and no local file moves when it happens, so neither a stream nor a read of
local files can ever see it. That is what buys it its own — much slower —
interval and its own cost accounting, and it is the only thing in this process
that asks a third-party server a question on a timer.

What they *do* share, deliberately, is the state vocabulary in
`status-render.ts`, and that is where they are made **mutually exclusive**:
`settledWithoutReport()` returns false whenever `current_tool` is open — the
same single fact `isWedgedToolCall()` reads. The exclusion is structural rather
than keyed on a phase name, because an open call *is* proof the run did not
settle. The seam it closes is a nudged worker that started running again: its
counter is still set, but the present-tense truth is `working`, and a call that
then goes silent must surface as the wedge it is instead of being masked by a
stale counter. The fact returns the moment that run settles with no envelope.
A property test over every combination of the inputs both predicates read pins
that no job can ever be reported as both.

**Budget** (`checkBudget`) is a soft gate checked from usage events *before*
the next prompt or steer, in `cp_send`. `warn_ratio` logs `cp:budget_warning`;
a breach logs `cp:budget_exceeded` and is carried on the send receipt so the
operator sees it — but the send still happens (cp-d7y). It never kills a
worker or severs the channel to it: killing mid-edit loses work, blocking a
steer just lets the worker keep burning tokens uncorrected, and whether a job
is worth more money is an operator decision either way.

**Recover** (`decideRecovery`) is bounded by class, role and attempt count:

| class | policy |
|---|---|
| `crash`, `timeout`, `agent_empty_output` | re-dispatch the **same brief**, up to `MAX_RECOVERY_ATTEMPTS` |
| `provider_limit` | retry the **same** model (transient), up to the cap, then escalate |
| `envelope_invalid` | escalate — the worker already exhausted its in-run repairs |
| `tool_loop`, `budget_exceeded`, `spawn_failed`, `wall_clock_exceeded`, `tool_call_cap_exceeded` | escalate — never retried |
| `settled_without_report` | escalate — the delivery may already exist; look at the branch/PR, then promote, revive or tear down. Never re-run the brief blind |
| `model_call_failed` | escalate — the worker never ran a turn, so there is nothing to recover, and the same call with the same credentials fails identically. Fix the credential or the routed model, then re-dispatch |

`mayRerunResearch` carries the ported cross-role rule: **an implementation
failure never re-runs the research that preceded it**. The findings are not
what broke.

### Bounded recovery without the operator (`src/recovery.ts`, cur.4.2)

`decideRecovery` above answers "may the same brief be retried?" for the
interactive `cp_pipeline recoverShip` ladder. `BoundedRecovery` answers a
different question — **with nobody watching**, when a worker dies
(`FailureMonitor.onFailure`) or hits a hard bound
(`HardBoundsWatch.onBreach`), what does the parent do before anyone reads a
wake-up? — bounded at `RECOVERY_ATTEMPT_BOUND` (one) automatic attempt per
failure class per job, then escalation. Nothing here retries a brief; a
revive resumes the same run so it can still call `report_result`, which is
safe even for a class `decideRecovery` will not retry (`settled_without_report`).

The policy table (`RECOVERY_POLICY` in `src/contracts.ts`):

| class | action |
|---|---|
| `crash`, `timeout`, `provider_limit`, `agent_empty_output`, `settled_without_report` | `revive` — relaunch on the same session file (`cp_revive`), then send a brief that says continue, do not redo |
| `wall_clock_exceeded`, `tool_call_cap_exceeded` | `redispatch` — the worktree is intact and the process is already stopped; the brief carries the on-disk evidence (`describeUnreportedWork`) and says finish from exactly that state |
| `tool_loop`, `budget_exceeded`, `envelope_invalid`, `spawn_failed`, `model_call_failed` | `none` — a policy cause, escalated on the very first occurrence, never auto-recovered |

A `risk:high` job never auto-recovers either, whatever the class — checked
separately from the table, because risk lives on the job
(`record.routing.risk`), not on the failure.

**The attempt counter is persisted in the run dir**
(`state/runs/<job-id>/recovery-attempts.json`, keyed by class), so a parent
restart cannot hand out a second automatic attempt for a class that already
spent its one. A second occurrence of the same class on the same job
escalates — `raiseLoopExhausted`, naming the failure and the worktree — with
no further action attempted.

**The guarantee**: recovery never deletes or resets a worktree. `revive` goes
through `Reviver.revive`, which relaunches on the existing session inside the
existing worktree. `redispatch` (cur.4.4) does not go through `Reviver` at all
— it never resumes the dead session — but it is bound by the same guarantee: a
fresh worker is spawned straight onto the job's existing worktree/branch (via
`WorkerManager.spawn` and the observer wiring `src/dispatch.ts` exports, never
`Dispatcher.dispatch`, which would take a new lease from the treehouse pool).
Neither path ever takes a new lease or cuts a new branch, so a re-dispatched
job's partial work is exactly where it was left, never redone.

On success, nothing is sent to the operator: one `cp:recovery_attempted`
journal entry (class, action, attempt, the bound) is the whole record. Only
an escalation reaches a human, via the existing `loop_exhausted` escalation
kind — this module adds no new wake-up transport.

**Ordering, and why it is load-bearing (2026 review, cur.4.2 findings 1/2).**
`FailureMonitor`/`HardBoundsWatch` still call `fail()` (`FailureAnnouncer`,
#191's one `waiting \u2192 failed` writer) first, exactly as every other failure
path does, and only fire `BoundedRecovery.onDeath`/`onBound` afterward, from
`onFailure`/`onBreach`. That order is not incidental: `fail()` must win the
race against the generic close-observer classification a `shutdown()` can
otherwise trigger on the same job, or two paths could both call
`recordRecoveryAttempt` for the same (job, class) pair. The consequence is
that by the time bounded recovery ever reaches `Reviver.plan`/`revive`, the
record is already `phase: failed` — so both take a `recovering: true` option
(`RevivePlanOptions` in `src/revive.ts`) that widens the accepted phase to
include the job's own just-written `failed`, and, on a successful revive,
write the phase back to `waiting` and clear `failure` (via `FleetStore.mutate`,
not `patch`, since `patch` skips `undefined` and can never erase a field). The
ordinary `cp_revive`/`/cp-revive` path never sets `recovering`. It only sees a
failed job through the operator's explicit `continue_failed` (see Revival),
which is journaled separately and leaves this counter alone.

A wake-up journaled by `fail()` would say something not yet true for an
occurrence bounded recovery might revive a moment later — and a delivered
wake-up cannot be retracted (on 2026-09-25 one said recovery "did not stick"
while the replacement was live, and the parent tore it down). So:

- **A hard bound announces after its outcome (zh7.4).** `HardBoundsWatch`
  is wired with `deferNotice`: `fail(..., "defer")` records the failed
  transition and nothing else, then `BoundedRecovery.settleBound` runs
  `onBound` and announces once, through `FailureAnnouncer.announce`, under the
  same occurrence id and generation. A revive announces nothing. A spent or
  refused attempt is announced — only when neither the fleet (phase moved off
  `failed`) nor the manager (a worker other than the tripped pid) shows a live
  replacement — with its exact `attempted`/`attemptsLeft` and a same-lease
  `next:` (`cp_revive`, once any escalation is decided; `cp_teardown` only to
  abandon). A rejected attempt is journaled as `failed operationally (…)` with
  a `cp:recovery_failed` run event; the lease is untouched. No bound notice
  carries `cp_teardown` advice unless no recovery is wired at all.
- **Replays are stale beside a live worker.** `checkWakeup` supersedes a
  `bound`/`death` wake-up whose job is `waiting`/`launching` again: its
  advice describes a worker that has been replaced.
- **The death fact, ahead of the attempt.** `BoundedRecovery.previewDecision(jobId,
  failure)` runs the same `decideBoundedRecovery` verdict `#recover` uses a
  moment later — same persisted attempt count, same fleet `risk` — but reads
  only. `CommandPost` wires it as `recoveryFact` on `FailureMonitor`;
  `fail()`'s death wake-up gets one more line: `automatic recovery: attempt
  in flight — N attempt(s) left for this class after it` (a preview never
  claims an outcome), or `not attempted — N attempt(s) left` when N > 0. When
  N is 0 (cur.4.4) that reads instead as `BOUND_SPENT_PHRASE`: "bound spent —
  one automatic attempt was already made and did not stick; escalated to a
  human, no further automatic attempt is coming" — the ordinary phrase would
  otherwise say "not attempted" about a bound that is in fact exhausted,
  which a parent reads as permission to hand-revive. This phrase names the
  opposite: one automatic attempt already ran and failed, a human has it now,
  and no further automatic attempt follows. Never a claim about *this*
  wake-up being wrong, only about whether a further automatic try is coming.
- **Death retraction on success.** `CommandPost`'s `onFailure` hook
  still fires `onDeath` after `fail()`; on
  `action: "revived"` it also reconstructs the death wake-up id
  (`death:<job>:<failure.at>` / `bound:<job>:<class>:<failure.at>` (cur.4.4:
  the occurrence key both ids need, so a second breach of the same class is a
  second wake-up rather than a suppressed duplicate), via the shared
  `deathWakeupId`/`boundWakeupId` helpers `FailureAnnouncer#announce`
  computed) and call `DurableWakeupOutbox.discard` on it. `discard` is a
  no-op on an id that is
  not (still) pending — a wake-up already delivered, or one this recovery
  attempt did not itself produce, is left alone; "stale suppression is
  terminal" (`src/wakeup-outbox.ts`), so a parent that has not yet drained it
  simply never sees a wake-up for a job that already came back on its own.

`AGENTS.md`'s cp-bound/cp-death guidance follows from this: the wake-up, when
it reaches the parent at all, already states whether an attempt ran and how
many remain — the parent reads that off the message, rather than assuming a
fixed history.

## Delivery receipts

`cp_send` returns `delivered | queued | failed` (`SendReceiptSchema`):

- `delivered` — pi's per-input `disposition` was `started` (a run began) or
  `handled` (an extension command or input handler consumed it).
- `queued` — disposition `queued`: pending in the worker's steer/follow-up
  queue.
- `failed` — rejected, timed out, or the worker is not alive.

The receipt never comes from the busy flag. Without a disposition (pi < 0.99.1)
a bare `prompt` is `delivered` and a `steer`, a `follow_up` or a `prompt` with
`streamingBehavior` is `queued`.

pi rejects a bare `prompt` during a run, which shows up as `failed`; a bare
prompt is never queued. Promotion of a busy worker is an explicit
`steer`/`follow_up`.

`cp_send` ([`src/send.ts`](../src/send.ts), T15) picks the mode in `auto`:
`prompt` when the worker is idle, `steer` when it is busy. It refuses, rather
than improvises, when:

- the job is not in the fleet, or is `done`/`failed` — there is nothing to
  promote, and a finished job is teardown plus a fresh dispatch, not a revival;
- the job's delivery has already landed (a `merged`/`landed` PR receipt) — its
  envelope slot cannot be reopened, so a brief sent now could never be
  reported ([Envelope supersession](#envelope-supersession));
- this session owns no live worker for it (a restart, an orphan, a dead
  worker) — the fix names the session file to revive from, or teardown;
- the caller asserts a model the worker is not running — promotion is
  **same-model** by contract, and a cross-model role hop is teardown plus a
  fresh dispatch;
- the caller explicitly asks for `steer`/`follow_up` while the worker is
  **idle** (cp-send-idle-steer). Both are delivered only once a turn actually
  consumes the queue — `steer` "after the current assistant turn", `follow_up`
  "when the agent finishes" — and an idle worker has no such turn running, so
  pi still answers `success: true` and the message sits queued with nothing to
  ever flush it. `auto` never hits this: it already resolves to `prompt` for
  an idle worker. The refusal names the fix, `mode: "prompt"` (or `auto`),
  which is exactly the sanctioned path an idle worker is promoted through
  everywhere else (the settle nudge, an ordinary promote).

Every delivery, including a refused one, is written to the run log as
`cp:prompt_sent` / `cp:steer_sent` / `cp:follow_up_sent` with its receipt and
pi's `disposition`.
One `RunRegistry` per process owns those recorders, because `events.jsonl` has
exactly one writer per run.

"Delivered" means pi accepted the user message, **not** that the model complied.
pi-subagents' `scheduled` and `missed` are intentionally absent: nothing here
schedules, and a worker that cannot receive is `failed` with a cause.

**A promoted worker may re-report, and a promoted job always can.** See
[Envelope supersession](#envelope-supersession): the
promote reopens the slot before the message is delivered. A `delivery:pr` hold
that takes a small CI fix still answers in its **reply** — nothing forces a
second envelope — but a worker that was given real work can always file one.

### Authorized task addenda

`cp_job amend` takes `job_id`, `task_file` (or inline `text`), a verbatim
operator `quote`, and a `reason`. It verifies the quote against user messages
with the same verifier as `cp_decide`; tool results and worker messages are
not authority. The verified send determines `by: "operator-quote"` or
`by: "operator-delegated"`; delegated addenda also store `delegation_rule` and
`send_id`, including the `unreadable marker` fallback. Closed jobs refuse. Each accepted addition
appends `{schema_version, n, added_at, source_path?, text, by, quote, reason, delegation_rule?, send_id?}`
to `state/runs/<job-id>/task-addenda.jsonl`; the body is frozen at add time,
not reread from its source. The append is durable and serialized with ledger
mutations, never replaces the original task, and refuses before writing when
the aggregate UTF-8 journal would exceed `REVIEW_ORIGINAL_TASK_MAX_BYTES`
(100,000 bytes). Invalid or incomplete journals fail closed. Gate and diff
review briefs name every addendum in order with its authorization provenance,
and point at a frozen `task-addenda.md` copy: original task plus addenda are
governing scope, to check for correct implementation, not flag merely for
being present. Bodies and free-form provenance remain input data, never rubric
overrides. Subsequent `cp_send` messages include the frozen addenda text;
adding one alone does not send work. With no addenda, briefs and messages are
unchanged. The one-revise-per-artifact limit is unchanged.

### A promoted brief may replace the frozen task

`cp_send`'s `task`/`taskFile` fields let a genuine promotion — the mode this
send resolves to is `prompt` **and** the worker is idle, not merely a send that
resolved to the word "prompt" — replace `paths.originalTaskFile`, the task the
diff reviewer and the plan gate score against
([`diffOriginalTaskBlock`](../src/diff-review.ts)). This exists because a
promote that legitimately changes what was asked (an operator's scope change,
delivered through the sanctioned `cp_send` promote path) otherwise leaves the
frozen task stale: the reviewer keeps reading the *original* request and
mechanically flags the newly requested scope as unrequested growth, even
though the change is exactly what the operator now wants.

The mechanics mirror envelope supersession on purpose — same archive-then-
write shape, same auditability guarantee — but it is a second, independent
counter and a second file (`src/supersede.ts`'s `updateFrozenTask`), because a
task can be updated on a promote that never reopens an envelope (an idle,
never-reported worker taking its next brief):

Nothing is mutated until the worker actually takes the message: `task`/
`taskFile` is validated up front (the mode/idle check, `readTask`'s own
exclusivity and emptiness checks), but the archive-then-write only runs after
`WorkerProcess.send` returns `receipt: "delivered"`. A failed or refused send
— pi rejecting a bare prompt to a worker that turned busy in the race between
the guard and the send, or anything else — leaves `original-task.md` exactly
as it was; the operator's new scope never becomes authoritative for a brief
the worker never received.

Once delivered:

1. the current `original-task.md` is archived, in full, to
   `original-task-superseded-<n>.md` — nothing is overwritten in place, and
   every prior generation of the task the branch was ever asked to do stays on
   disk (absent when there was nothing to archive yet);
2. the new text (from `task`, or the full body of `taskFile`, exactly the same
   resolution `cp_dispatch`'s own `task`/`taskFile` uses) is written to
   `original-task.md`, becoming what the next diff review and plan gate read
   — both re-read the file fresh off disk on every attempt
   (`copyOriginalTask`), so no cache or snapshot needs invalidating;
3. `job.task_generations` increments and a `cp:original_task_updated` event is
   journalled — a fact on the record, not an inference.

**Only a promotion of an idle worker may do this.** A `task`/`taskFile` on a
`steer`, a `follow_up`, or an explicit `prompt` aimed at a worker that is still
busy is refused before anything is mutated: the first two are mid-run guidance
to a worker already acting on the frozen brief, not a redefinition of it, and
the third is not actually a promotion — pi refuses a bare prompt to a busy
worker outright, so gating only on the mode string would let a rewrite race
ahead of a delivery that was never going to happen. Letting any of them
silently rewrite scope would make an ordinary course correction
indistinguishable from an operator's deliberate scope change. There is no
parallel task store: this reuses the one file `cp_dispatch` already writes and
reads, updated in place with its own history kept beside it.

## Envelope supersession

One invariant, encoded in [`src/supersede.ts`](../src/supersede.ts) and enforced
by `cp_send`:

> **A worker that can be given work must have a way to report it.** A job is
> never simultaneously promotable and unreportable.

### What it is for

A job filed a `blocked` envelope; intake stamped `reported_at` and moved it to
`held`. The parent then promoted it twice with `cp_send`. Both prompts were
accepted, both ran to completion (`prompt_sent`, `agent_start`, `agent_end`,
`agent_settled` all at 3; ~70 tool calls; turns 5 → 61) and `envelope_received`
stayed at **1**. The worker implemented the work, committed, pushed and opened a
PR, and none of it was ever reported: `reported_at` was already stamped and
`envelope.json` was already written. Nothing refused anything. The PR was found
by accident, hours later. **That silence was the defect** — not the promote,
which is exactly the right move for a blocker the operator just cleared.

### The mechanics

`Sender.send` reopens the slot **before** it delivers anything:

1. `envelope.json` → `envelope-superseded-<n>.json` (and any
   `envelope-rejected.json` alongside it). Moving the record aside is what makes
   the worker's write-once file writable again; nothing is destroyed.
2. `reported_at` is cleared and the job goes `held` → `waiting`, with
   `supersessions = n`.
3. `cp:envelope_superseded` is journaled with the generation, the cleared
   `reported_at`, the archived path and a one-clause reason — never a body. The
   run projection's `reported` flips back to `false`, so an idle worker that
   owes a report is distinguishable from one that has already filed.

The ordering is the contract: the slot opens first, the brief follows. The
opposite order leaves a window in which the worker is already working and cannot
report, which is the whole defect. A refused delivery therefore leaves an open
slot and an archived envelope — visible, recorded, recoverable.

### `reported_at`, stamped once — across a supersession

"Stamped once" now means **once per envelope generation**, and a job has exactly
one live generation at a time:

- generation `n` = `supersessions + 1`; a job that was never promoted after
  reporting is generation 1 and behaves exactly as before;
- `reported_at` is the acceptance time of the **current** generation, and it is
  cleared (never overwritten in place) by a supersession;
- a second intake of the *same* generation is still a no-op (`already: true`);
- receipts are merged across generations, so one PR is one receipt. **Two
  envelopes never both count as the delivery.**

Every superseded envelope survives on disk, so "what did this worker report
before?" is answerable: `lastFiledEnvelopeFile` returns the live envelope, or
the newest archived generation when the slot is open.

### The boundary: a landed delivery is not reopenable

`cp_send` fails closed, in the style of `cp_dispatch`'s promote finding and
`cp_teardown`'s gates, when the work is already delivered:

| condition | refusal names |
|---|---|
| a `pr` receipt whose status is `merged`/`landed` (case-insensitive) | `cp_teardown <id>`, then `cp_dispatch` a new job id |
| phase `done` | dispatch a fresh job: the lease is returned and the slot is closed |
| phase `failed` | recover or re-dispatch deliberately; a brief does not revive a failed job |

A landed delivery must not be reopened by a stray brief: the envelope that
named the merged PR is the job's delivery, and follow-up work is a new job with
its own job id. An `open` PR receipt is the ordinary `delivery:pr` hold and
**does** reopen — that hold exists precisely so the same worker can take the CI
fix and report it.

### The worker's half

`worker-reporter` treats its record file as the truth: if it reported and the
file is gone, the parent reopened the slot, so `report_result` is accepted again
and the bounded-repair budget resets (the allowance belongs to a generation, not
to a process lifetime). Its refusal text for a genuine double report now names
the sanctioned path instead of implying the work is unreportable forever.

## Envelope correction

Supersession above answers *a job that reported and was given more work*. This
answers the other half of the same invariant: **a job whose report was refused
must still have a way to report.**

### What it is for

A refused envelope used to strand the worker: `report_result` is write-once, so
a corrected report had nowhere to go (cp-o77y, see docs/build-history.md).

### The mechanics

Every refusal in `EnvelopeIntake` — an unparseable file, a record that fails
`EnvelopeRecordSchema`, an envelope that contradicts the dispatch record, an
artifact that is missing, empty or not a file — goes through one place, and the
**first** refusal of a generation:

1. moves `envelope.json` → `envelope-invalid-<generation>.json`
   (`paths.invalidEnvelopeFile`). Moved, never deleted and never onto an
   existing file: the refused record is the evidence, and moving it aside is
   what reopens the worker's write-once slot;
2. writes `envelope_correction` on the fleet record — `{generation, at,
   quarantined, reason}` — which is both the audit entry and the budget. The
   reason is validation errors only, bounded to
   `ENVELOPE_CORRECTION_REASON_MAX_CHARS`: no envelope body, and nothing read
   out of an artifact;
3. journals `cp:envelope_rejected`.

The slot is the **same** generation's. A refused envelope was never a delivery,
so nothing is superseded, `supersessions` is not bumped, `reported_at` is not
touched and no receipt is minted. Everything downstream then works unchanged:
the settle boundary sees an open slot, `cp_send` sees a promotable job and
`cp_revive` sees a revivable one.

### Exactly one, and never a delivery

It fails closed in three cases, so it can never loop and can never overwrite
work:

| condition | what happens |
|---|---|
| the generation's correction is already spent | the job is `failed` with `envelope_invalid`; the message names both the earlier quarantine and this refusal's own cause, and **both** records stay on disk |
| the generation is already stamped (`reported_at` set) | nothing is moved: a valid envelope is immutable, and correcting a delivery is a promote ([supersession](#envelope-supersession)) |
| the envelope is no longer on disk | nothing to quarantine; the ordinary fail-closed path |

`envelope_correction` is generation-stamped, so a correction spent before a
promote is inert afterwards: the new generation gets its own budget, and the
earlier generation's quarantine file is never overwritten.

### Crash-safe naming

Step 1 happens before step 2, so a crash in between leaves
`envelope-invalid-<generation>.json` on disk with the budget **unspent**. The
record is what the budget lives on, so the next refusal of that generation is a
first refusal — and renaming over that file would destroy the one copy the
interrupted refusal preserved.

So the move is non-clobbering. `paths.invalidEnvelopeFile(jobId, generation,
ordinal)` takes an ordinal that defaults to 1 and renders the unchanged name;
intake tries the ordinals in order and takes the first free one
(`envelope-invalid-<generation>-2.json`, `-3.json`, …) with `linkSync`, which
fails with `EEXIST` rather than overwriting, so the test and the move are one
step. `envelope_correction.quarantined`, the operator line and
`cp:envelope_rejected` all name the path that was actually used, so the audit
trail points at real bytes.

Nothing else moves: it is still one correction per generation (the second
refusal fails closed and leaves its envelope where the worker wrote it), a
stamped envelope is still never quarantined, and a stale correction still never
spends the live generation's budget.

### The two halves that keep the budget from being wasted

- **The worker checks the artifact it names, whatever the job's kind.**
  `localChecks` used to check existence only for `kind: "research"`, so a ship
  envelope naming a nonexistent path (cp-o77y's exact shape) reached the parent
  unchecked. It is now checked at the source, where the model can repair it
  inside its repair budget with its context still warm.
- **The settle boundary says why.** A worker with an open correction slot *did*
  report, so the ordinary nudge ("you stopped without calling report_result")
  would be false and would spend the generation's one correction re-filing the
  same envelope. It gets `correctionPromptText` instead: the refusal reason, the
  quarantine path, and an explicit instruction not to redo the work. The nudge
  budget itself is unchanged.

## Identifiers and timestamps

- job id: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` — also the run/artifact directory
  name; enforced by `paths.*`.
- Timestamps: `YYYY-MM-DDTHH:MM:SSZ` (UTC, second precision) everywhere, via
  `isoTimestamp()`. No local time, no millisecond variants, no `Date.now()`
  numbers in persisted files.
- Branch name for a job is the job id (dispatch sets `branch = job_id`).

### Job id (renamed from br id)

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

## Structure test (tests/structure.test.ts, pi-command-post-autonomy-programme-cur.6.2)

Growth is a decision, not a drift. `tests/structure.test.ts` fixes four things as constants at
the top of that one file: a per-file cap with a
grandfathered list of files that were already over it (each pinned to its historical
size plus a 3% margin, rounded up to the next 10 lines), an exact two-package runtime allowlist (`preact`, `esbuild`)
on `package.json`, line caps on AGENTS.md
and the operator note, and a short list of banned identifiers for surfaces that were
deliberately deleted (`attachConsole` and friends) so they cannot quietly come back.

**Raising a cap:** edit the constant at the top of `tests/structure.test.ts` and put a
one-sentence justification in the PR description — never in the assertion message, which stays a fact ("X is N
lines, over the cap") and not a changelog. Splitting a grandfathered file below the general
per-file cap removes it from `GRANDFATHERED` instead of raising anything.

**Storage ratchet (cp-u3i2).** Three more rules keep every home path derived
from `LAYOUT`: R1 refuses a literal top-level `state`/`data`/`projects` root in
a `join`/`resolve` (`src/`, `extensions/`, `scripts/`, `tests/`), R1b a literal
`.pi-command-post` join outside `src/contracts/layout.ts` and `src/viewer/`, and
R2 names every `homedir()`/`tmpdir()` call in runtime code. Each allowlist must
still hit. Rules, allowlists and the known limit: [storage.md](storage.md#adding-a-path).

The bounded viewer exception permits Preact rendering and esbuild startup
bundling, not a general dependency budget. The 800-line cap also covers
`viewer-app/` TS/TSX/CSS and `scripts/build-viewer.ts`. Only the trusted
`src/viewer/build.ts` startup/build-CLI path writes generated assets, confined
to the selected home's resolved `stateDir/viewer-dist/`. Request handlers and
projections remain read-only. Static serving uses the successful build's exact
in-memory output allowlist, never a request-supplied filesystem path. A failed
build leaves JSON APIs, health and published boards available; `/` returns 503
without a classic fallback. Stale disk output is never served as the current app.
Board CSP and operational authority rules are unchanged. See
[the viewer app contract](viewer-app.md) for exact policies, routes, data
availability, refresh semantics and source/font provenance.
