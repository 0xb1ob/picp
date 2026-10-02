# Asynchronous reviewers: gate, diff review and quality panel return `wait` — design

Date: 2026-09-05. Status: approved in conversation, pending spec review.
Item 4, after the three-item sequence of 2026-09-04. Assumes items 1 and 2
(`2026-09-04-drop-br-ledger-design.md`, both PRs) have landed: ids are
`job_id`, the ledger is the in-house `Ledger` behind `cp_job`, and `br` is
gone from the codebase. Neutral on item 3 (single-project mode): every file
named here is reached through `paths.*`, so the layout switch needs nothing
from this spec.

## Problem

The parent sleeps on wake-ups and polls nothing. Every fact that moves the
fleet reaches it as one of five unasked messages (`cp-envelope`,
`cp-answered`, `cp-wedged`, `cp-unreported`, `cp-ci`), each stamped and
re-checked against disk at delivery. Dispatch, send, teardown and integrate all
return within seconds and let the wake-ups drive the next turn.

Three surfaces do not. `cp_gate`, `cp_review` and the quality panel each spawn
a one-shot reviewer worker and then **block the parent's tool call until the
verdict lands**: `await awaitVerdict(...)` inside `execute`. The bound is
`review_timeout_ms` (15 minutes) per gate or review attempt, and one vote
timeout (3 minutes) per voter for the panel, sequentially. `cp_pipeline
advance` inherits the block because it calls the gate and the panel inline. A
review loop that runs five rounds is up to 75 minutes of a parent that cannot
take any other turn: no envelope from another job is acted on, no Awaiting-you
row is raised, no answer card is shown, and the operator sees a spinner that is
indistinguishable from a wedged call.

A review of `pi-background-tasks` (pi.dev, 2026-09-05; recorded in
`2026-09-04-package-audit.md`) found nothing to adopt: its runtime is a weaker
copy of the fleet transport, its provider extension refuses this home's
Anthropic auth mode, and its shell tool would bypass the parent's tool-call
guards. But it named the gap correctly, and two of its rules are worth
carrying over: never announce a task before the caller holds its id, and never
announce before the result is durable. This spec closes the gap in-house and
adopts those two rules.

## Decisions

| # | decision | why |
|---|---|---|
| D1 | **All three reviewer surfaces go asynchronous** (gate, diff review, quality panel), and `cp_pipeline advance` returns `wait` while any of them is pending. | One mechanism, one wake-up kind, no half-converted ladder. Converting only the gate would leave `advance` blocking on the panel and `cp_review` blocking on its own. |
| D2 | **The extension applies the ladder; the parent advances.** On verdict the extension decides, files the decision, delivers a revise to the live worker (as today), then wakes the parent. For a pipeline the parent calls `cp_pipeline advance` again. | Mirrors how `cp-ci` drives `cp_integrate`. Pipeline transitions stay in the model's loop; policy the code already owns stays in the code. Auto-advancing the pipeline from the wake-up path was considered and rejected: it would move checkpoint minting out of a parent turn. |
| D3 | **Mechanism: split each surface at the `awaitVerdict` seam** into `start()` and `finish()`. The waiter itself is unchanged and runs in the background. | Smallest change that reuses every existing discipline: the ladder, the decision files, the stamps, the delivery observer. The alternative, making a reviewer a fleet job with its own envelope, was rejected: a verdict is not an envelope, an attempt has no ledger job, and a research job would carry two live workers. |
| D4 | **A reviewer in flight when the parent exits fails closed.** The reviewer dies with the parent (existing `shutdownAll`). The orphaned attempt is finished as an operational fault, which the ladder already answers with a retry on a different model. | Reviewers are one-shot and their whole world is one file; a fresh run costs what a revive would. Detaching them would create a worker nobody observes, which the fleet forbids. |
| D5 | **One new file, `pending.json`, in the attempt directory**, written before the reviewer is briefed and deleted when the decision is filed. | Three readers need to agree without a subprocess: the status view (“gate 2 in flight, 4m”), the one-pending rule, and the orphan sweep. A file is the only source all three can read. |
| D6 | **One new wake-up kind, `verdict` (`cp-verdict`)**, for all three surfaces, with `keys: [surface, attempt]`. | Six kinds, not eight. The staleness rules are the same shape for every surface; the surface is data on the stamp. |
| D7 | **Handback before announce.** `finish` waits until the `start` that spawned the attempt has returned to its caller before sending the wake-up. | A reviewer that refuses its brief in under a second would otherwise wake the parent about an attempt the parent has not been told exists. Borrowed from `pi-background-tasks`’ terminal-publication gate. |
| D8 | **Durable before announce.** The decision file is written atomically and `pending.json` removed before the wake-up is sent. A failed send leaves the decision standing. | The file is the fact; the wake-up is a courtesy. Same rule the envelope path already follows. |
| D9 | **One pending attempt per `(job_id, surface)`.** A second `start` returns the pending record. | The fleet's “one worker per job” rule, applied to reviewers. |
| D10 | **The quality panel's private waiter is replaced by the shared `awaitVerdict`.** | `src/quality.ts` carries a copy with a 50 ms poll loop. The split touches it anyway; two waiters for one job is the kind of duplication this codebase removes when it is in the file. |
| D11 | **A stat overflow in `cp_review` still decides synchronously.** | It spawns no reviewer today. There is nothing to wait for. |

## Architecture

```
cp_gate start ─┐
cp_review start ┼──▶ ReviewRuns.start(surface, job_id)
advance ────────┘         │  spawn reviewer, write pending.json, register attempt
                          │  hand back {next:"wait", surface, attempt, deadline}
                          ▼
                    awaitVerdict (background, unchanged, timeout enforced)
                          ▼
                    ReviewRuns.finish(attempt, outcome)
                          │  decide → atomic write gate-<n>.json | review-<n>.json | quality.json
                          │  deliver revise (as today) → shutdown reviewer → scratch cleanup
                          │  delete pending.json
                          │  await handback  ──────────── D7
                          ▼
                    WakeupNotifier.send(cp-verdict stamp)   ──── D8 (file first)
                          ▼
                    pi followUp queue → context hook → checkWakeup(verdict) → parent turn
                          ▼
                    parent: cp_pipeline advance <job_id>  |  act on `next`
```

Modules (policy in `src/`, pure and pi-free; adapters in `extensions/`):

- `src/review-runs.ts` (new): the `ReviewRuns` registry. Owns the in-memory
  map of pending attempts keyed `${job_id}#${surface}-${attempt}`, the
  `pending.json` lifecycle, the handback promise, the orphan sweep, and the
  `finish` fan-in that calls back into the owning module's decide step. It
  does not know how to review anything.
- `src/gate.ts`: `Gate.gate()` becomes `Gate.start()` and `Gate.finish()`.
  Everything before the await is `start`; everything after is `finish`. A
  `Gate.status()` reads disk. `awaitVerdict` is unchanged and stays exported.
- `src/diff-review.ts`: same split. The stat-overflow branch stays inside
  `start` and returns a finished result.
- `src/quality.ts`: `run()` becomes `start()` and `finish()`; the panel is one
  attempt whose background waiter runs the votes sequentially and writes
  `quality.json` once. The private `#awaitVerdict` is deleted in favour of the
  shared one.
- `src/pipeline.ts`: `advance` consults `ReviewRuns` for a pending attempt on
  the research job before steps 2 and 3, and returns `wait` in state `gating`
  when one exists; otherwise it calls `start()` where it used to call
  `gate()`/`run()`, and returns `wait` with the pending record.
- `src/wakeups.ts`: sixth kind, sixth branch in `checkWakeup`, facts extended
  with the attempt state.
- `src/status.ts`: a `pending_review` detail on the job row, read from
  `pending.json`.
- `src/contracts.ts`: `PendingReviewSchema`, `REVIEW_SURFACES`, `GATE_NEXT`
  gains `wait`, `paths.pendingReviewFile`, `VERDICT_MESSAGE_TYPE`,
  `VERDICT_DELIVERY_RETRY_SECONDS`.
- `extensions/command-post/index.ts`: `cp_gate` and `cp_review` gain
  `action: start | status`; `confirmVerdictArrival` joins the two existing
  arrival observers; `session_start` runs the orphan sweep after the parent
  lock.

## Lifecycle

**start.** For surface `S` on job `J`:

1. Refuse if `ReviewRuns` holds a pending attempt for `(J, S)`: return that
   record with `next: "wait"` (D9).
2. Run the surface's existing preconditions and attempt numbering
   (`readPriorAttempts`). Compute `attempt = n`.
3. Write `pending.json` atomically to the attempt directory (D5). For `gate`
   and `review` that is `paths.gateRunDir(J, n)` / `paths.reviewRunDir(J, n)`;
   for `quality` it is `paths.qualityRunDir(J, QUALITY_PANEL_SLOT)`, which
   resolves to `quality-panel/`, a slot reserved for the panel record so the
   votes keep their own `quality-verify-<n>/` and `quality-completeness/`.
4. Spawn the reviewer through `WorkerManager.spawn` exactly as today, send
   the brief, record `prompt_sent`.
5. Register the attempt in `ReviewRuns` with an unresolved handback promise,
   and start the background waiter: `awaitVerdict(...)` followed by
   `finish(...)`. Errors thrown by the waiter are caught and converted to an
   operational outcome; nothing is left unfinished.
6. Return `{ next: "wait", surface: S, attempt: n, model, deadline }`. The
   caller (the tool adapter, or `advance`) calls `ReviewRuns.handBack(key)`
   **after** it has composed its own result (D7); that call resolves the
   handback promise and flips `handed_back` in `pending.json`. A caller that
   throws before reaching it leaves the flag false, which the orphan sweep
   reads as “the parent was never told”.

A brief refused at step 4 (`receipt: "failed"`) still goes through `finish`
with an operational outcome, so the ladder's retry branch handles it and
the attempt is never half-recorded.

**finish.** With the waiter's outcome (`review`, or `operational`):

1. Decide exactly as today (`decideGate`, the diff ladder, `tallyVotes`),
   validate against the schema, atomically write the decision file
   (`gate-<n>.json`, `review-<n>.json`, `quality.json`) plus the raw file when
   capped.
2. Deliver a `revise` to the live worker when the surface does so today, and
   record its receipt on the result.
3. `manager.shutdown(key)`; scratch cleanup by the surface's existing rule.
4. Delete `pending.json`; remove the attempt from `ReviewRuns`.
5. `await handback` (D7).
6. Send one `cp-verdict` wake-up through `WakeupNotifier` (D8: files are
   already on disk). Record `cp:verdict_wakeup_sent` in the job's run log.

The worker's own `cp:gate_decided` / `cp:review_decided` markers are written
where they are written today, in step 1.

## Files

`pending.json`, one per attempt directory, schema `PendingReviewSchema`:

```jsonc
{
  "schema_version": 1,
  "job_id": "cp-nz95",
  "surface": "gate",            // gate | review | quality
  "attempt": 2,                 // quality: always 1 (the panel runs once per job)
  "model": "anthropic/claude-opus-5",
  "pid": 48213,
  "started_at": "2026-09-05T10:00:00Z",
  "deadline": "2026-09-05T10:15:00Z",
  "handed_back": true,          // set by start after the tool result is composed
  "subject": {                  // surface: review only — what the reviewer was pointed at
    "head_sha": "…", "branch": "cp-nz95", "files": 3, "truncated": false
  }
}
```

`subject` exists so an orphaned diff review can still be decided as a
schema-valid `DiffVerdict` (which requires `head_sha` and `diff_stat`) with no
clone to consult, and so the wake-up can carry the head it describes.

Written with `atomicWriteJson`, deleted with `rmSync(force)`. It is never
rewritten except for the single `handed_back` flip, which lets the orphan
sweep tell an attempt that died before handback (nothing was ever told to the
parent) from one that died after.

Decision files, run directories, scratch directories, verdict files and raw
files keep their names and their write-once rules.

## The wake-up

`WakeupKind` gains `verdict`; `WAKEUP_CUSTOM_TYPES.verdict = "cp-verdict"`.

Stamp: `{ kind: "verdict", job_id, keys: [surface, String(attempt)],
issued_at }`. For `surface: review`, `keys[2]` is the reviewed `head_sha`.

Content: the surface's existing formatter output (`formatGate`,
`diffReviewToolPayload`'s text, the panel summary) followed by one directive
line:

- pipeline job: `Next: cp_pipeline advance <research job_id>.`
- direct call: `Next: act on next=<value>.` (proceed | revise | retry | surface)

`details` carries the full result object plus `cp_wakeup` (the stamp), as the
other kinds do. Nothing in the content is an artifact body: the formatter
already caps reasons and never reproduces the artifact or the diff.

**Staleness (`checkWakeup`, kind `verdict`).** Facts are read from files
only, via a `review(job_id, surface)` accessor added to `WakeupFacts` that
returns `{ pending?: {attempt}, decided: number[] }` from the attempt
directories and `pending.json`.

| condition | verdict |
|---|---|
| no fleet record for the job | stale: torn down |
| job phase terminal (`done`, `failed`) | stale: torn down |
| decision file for `attempt` absent | stale: finish never completed, do not act |
| a `pending.json` or decision file exists for a later attempt of this surface | stale: superseded by a newer review |
| `surface: review` and the job's `head_sha` differs from `keys[2]` | stale: reviewed a head that is history |
| otherwise | fresh |

A stale verdict's body does not travel; the notice names the job, the
surface, the attempt and what is true now, as for the other kinds.

**Delivery observation.** `confirmVerdictArrival` sits beside
`confirmAnsweredArrival` and `confirmCiArrival` in the `message_start` and
`context` hooks. Identity `${job_id}|${surface}|${attempt}`; on observed
arrival the attempt's `cp:verdict_wakeup_delivered` marker is written to the
run log. An unconfirmed wake-up is derived from disk and sent once more after
`VERDICT_DELIVERY_RETRY_SECONDS` (120, matching the CI watch and the answered
outbox); a second copy that lands is idempotent, because acting on it is
reading a decision file that has not changed.

## Surfaces

**`cp_gate`, `cp_review`.** New parameter `action: start | status`, default
`start`.

- `start` returns either `{ next: "wait", surface, attempt, model, deadline
  }` or, when the attempt directory already holds a decision (a re-call after
  the wake-up, or a synchronous stat overflow), the finished result exactly as
  today.
- `status` reads `pending.json` and the decision files and reports `{
  pending?, decisions: [...] }`, changing nothing.
- `GATE_NEXT` gains `"wait"`. The tool descriptions say: `next: wait` means
  a reviewer is running; end the turn, a `cp-verdict` wake-up will arrive; do
  not call `status` to wait.

**`cp_pipeline advance`.**

- Before step 2 (panel) and step 3 (gate), consult `ReviewRuns` for a pending
  attempt on the research job. If one exists, return `next: "wait"`, state
  `gating`, message naming the surface, attempt and deadline, and
  `pending: { surface, attempt, deadline }` on `AdvanceResult`.
- Where it called `quality.run()` or `gate.gate()`, it calls `start()` and
  returns the same `wait`. The `gating` state is already what the pipeline
  writes here; no new pipeline state.
- On the next `advance`, the decision file is on disk and the existing ladder
  (revise / escalate / pass / flagged) runs unchanged.
- The quality panel's report is acted on exactly once, by whichever `advance`
  first reads it. Today "fresh" means "this call wrote the report"; with the
  report written in the background that would make every reader see it as
  old. The pipeline record gains an optional `quality_acted_at`, set when the
  pipeline promotes the fixes or proceeds to the gate; a report with no
  `quality_acted_at` is fresh.

**`/status` and the widget.** The job row gains `pending_review?: { surface,
attempt, started_at, deadline }` read from `pending.json`. The widget renders
it as a detail suffix on the row, files-only, inside the existing 5-second
tick. `/status --json` carries the field verbatim.

**`cp_status_block`.** Unchanged. A pending review is not a Shipped row and
not an Awaiting-you row.

## Restart and orphaned attempts

On `session_shutdown`, `post.shutdown()` runs `manager.shutdownAll()`;
reviewers are ordinary managed workers and die there. `ReviewRuns` is
in-memory and empties with the process.

`ReviewRuns.sweepOrphans(home)` runs at `session_start` after the parent lock
and before the status widget's first tick, and also lazily inside `start` and
`advance` for the job they touch. For every `pending.json` whose pid is not
alive and whose attempt directory has no decision file, it calls the owning
surface's `finish` with `operational: "reviewer lost with the parent session"`
and **no wake-up** when `handed_back` is false (the parent never learned of the
attempt; the next `advance` or `start` reads the decision from disk). When
`handed_back` is true the wake-up is sent, because the parent was told to wait
for it. The ladder then does what it does for any operational fault: retry on
a different model, up to its existing caps.

Nothing is revived, nothing is detached, and `cp_revive` is not extended.

## Concurrency

- One pending attempt per `(job_id, surface)` (D9). A `start` that finds one
  returns it. A `start` for a different surface on the same job is allowed:
  the panel and the gate never overlap in the pipeline, and a direct
  `cp_review` on a ship job is a different job from the research job it
  follows.
- Reviewers count against the fleet's spawn cap as they do today.
- `finish` runs on the waiter's microtask, never concurrently with another
  `finish` for the same attempt: the registry removes the attempt under a
  synchronous check-and-delete before doing anything else, so a duplicate
  resolution (waiter and sweep racing) is a no-op.

## Documentation

- `AGENTS.md` §The loop: the gate row reads “`cp_gate` → `wait`; act on the
  `cp-verdict` wake-up”; `cp_review`'s paragraph says the same for the review
  loop, keeping “you own the loop until it ends” and adding that each round
  ends in a wake-up, not a return value.
- `docs/contracts.md`: new subsection *Asynchronous reviewers (pending.json,
  cp-verdict)* under *Pipeline and checkpoint*; the wake-up table under
  *Fleet state* lists six kinds; the *Directory layout* block gains
  `pending.json` under `gate-<attempt>/`, `review-<attempt>/` and
  `quality-panel/`.
- `src/wakeups.ts` header: “The five messages that wake the parent unasked.
  There are no others.” becomes six, naming `verdict` and this spec.
- `docs/superpowers/specs/2026-09-04-package-audit.md`: one row for
  `pi-background-tasks` (2.5.0, 107.7K/mo, 2026-09-04): fit *none*; blocking
  gaps: provider extension refuses non-OAuth Anthropic credentials, peer range
  excludes pi 0.85, `bg_run` bypasses the tool-call guards; ideas borrowed:
  D7 and D8 above.

## Contract additions (`src/contracts.ts`)

```ts
export const REVIEW_SURFACES = ["gate", "review", "quality"] as const;
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
export const PendingReviewSchema = Type.Object({
  schema_version: Type.Integer({ minimum: 1 }),
  job_id: JobIdSchema,
  surface: StringEnum([...REVIEW_SURFACES]),
  attempt: Type.Integer({ minimum: 1 }),
  model: Type.String(),
  pid: Type.Integer({ minimum: 1 }),
  started_at: IsoTimestampSchema,
  deadline: IsoTimestampSchema,
  handed_back: Type.Boolean(),
  subject: Type.Optional(Type.Object({
    head_sha: Type.String({ minLength: 1 }), branch: Type.String({ minLength: 1 }),
    files: Type.Integer({ minimum: 0 }), truncated: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
// PipelineRecordSchema gains quality_acted_at?: IsoTimestamp (see Surfaces)
export type PendingReview = Static<typeof PendingReviewSchema>;
export const PENDING_REVIEW_FILE = "pending.json";
export const QUALITY_PANEL_SLOT = "panel";
export const VERDICT_MESSAGE_TYPE = "cp-verdict";
export const VERDICT_DELIVERY_RETRY_SECONDS = 120;
// paths
pendingReviewFile(jobId: string, surface: ReviewSurface, attempt: number): string
// GATE_NEXT (src/gate.ts) gains "wait"
```

`CpEventKind` gains `verdict_wakeup_sent`, `verdict_wakeup_delivered`,
`review_orphaned`.

## Testing

Pure, in `tests/review-runs.test.ts` (new):

- one pending per `(job, surface)`: second `start` returns the first record;
- handback barrier: `finish` resolving before handback does not send; sending
  happens once handback resolves;
- durable before announce: the decision file exists and `pending.json` is
  gone before the injected `send` is called; a throwing `send` leaves both;
- orphan sweep: dead pid + no decision → operational finish; `handed_back`
  false → no wake-up, true → wake-up; live pid → untouched; decision present
  → untouched.

`tests/wakeups.test.ts`: the six-row staleness table above, one test per row,
plus the `review` head-moved row.

`tests/gate.test.ts`: the thirteen `gate()` calls become `start()` then
`finish()` against the same fake worker, asserting the same decisions and the
same files. One new test: `start` returns `wait` and writes `pending.json`.

`tests/diff-review.test.ts`, `tests/quality.test.ts`: same split; the stat
overflow test asserts a finished result from `start`; a quality test asserts
one `pending.json` for the panel and none for a vote.

`tests/pipeline.test.ts`: the `wait` round-trip: `advance` → `wait` with
`pending`; verdict lands (fake worker); `advance` → the same state the
synchronous path reached. One test per ladder outcome (pass, revise,
escalate, operational retry).

`tests/status.test.ts`, `tests/widget.test.ts`: `pending_review` appears from
a seeded `pending.json` and disappears without it.

`tests/extension-load.test.ts`: a `cp-verdict` message in the `context` hook
is stamped, reviewed and, when stale, rewritten; `confirmVerdictArrival`
writes the delivered marker.

Golden files regenerate with `CP_UPDATE_GOLDEN=1` and the diff is reviewed.

## Out of scope

- Auto-advancing the pipeline from the wake-up path (D2 rejected it).
- Reviving or detaching reviewers (D4).
- Any change to what the ladders decide, the revise caps, the review cap of
  five, or the gate rubric.
- Adopting `pi-background-tasks` or any part of its runtime.
- `cp_integrate`, which is already one step per call.

## Task order

1. Contracts: `REVIEW_SURFACES`, `PendingReviewSchema`, `paths.pendingReviewFile`,
   `GATE_NEXT` + `wait`, message type and retry constant, event kinds.
2. `src/review-runs.ts` with its tests: registry, pending file lifecycle,
   handback, orphan sweep. No surface wired yet.
3. `src/gate.ts` split (`start`/`finish`/`status`), `tests/gate.test.ts`
   converted.
4. `src/diff-review.ts` split; `src/quality.ts` split and its waiter
   replaced by the shared `awaitVerdict`.
5. `src/wakeups.ts`: kind `verdict`, facts accessor, staleness branch, tests.
6. `src/pipeline.ts`: `wait` round-trip, tests.
7. `src/status.ts`, `src/widget.ts`: `pending_review`, tests.
8. Extension: `cp_gate`/`cp_review` `action`, handback resolution in the
   adapters, `confirmVerdictArrival`, orphan sweep at `session_start`,
   extension-load test.
9. Docs: AGENTS.md, contracts.md, wakeups header, package-audit row.
10. Operator step: one real session on this checkout; run a pipeline through
    a gate and confirm the `cp-verdict` wake-up arrives and `advance` completes.
