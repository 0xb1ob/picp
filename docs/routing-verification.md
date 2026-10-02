# Routing epic: integration verification (T7)

The routing reliability epic (T1–T6) landed as six separate changes. This is the
record of checking the **integrated** result: what was run, what it proved, what
is still unproven, and what an operator has to do (and must not do) to adopt it.

It is deliberately a record and not a claim of completeness. Where evidence does
not exist, the row says so instead of borrowing a neighbouring test's green tick.

## 1. Commands and results

| what | command | result |
|---|---|---|
| typecheck | `npm run typecheck` (`tsc --noEmit`) | clean; it is the first half of `npm test`, so every row below includes it |
| full suite | `npm test` (the command `.github/workflows/ci.yml` runs) | **1742 tests, 1729 pass, 0 fail, 13 skipped** |

The skipped live-model tests (`tests/e2e/live*.test.ts`, `live-smoke`) are gated
on `CP_LIVE_TESTS=1` and operator-run because they spend real money.

Nothing in the routing epic is covered only by a skipped test. These counts are
from a developer machine that has `br` and `treehouse` on `PATH`; a host without
them (GitHub's runner) additionally self-skips every suite that leases a real
worktree, which is why the local run is the one quoted here. No inference API
was called by this verification: every worker in it is a `pi --mode rpc` child on
the mock provider.

## 2. The checklist, and what actually proves each line

| # | required | evidence |
|---|---|---|
| 1 | typecheck + suite, with real skip counts | §1 above |
| 2 | mock end-to-end: a parent supplies only `scope` for credential work; the high route is **recorded** and the **spawned** model/effort agree | `tests/routing-integration.test.ts` — "a scope-only dispatch of credential work". One dispatch: risk inferred `high` from the job's words, `risky-ship` fires, the fleet record and `cp:routing_resolved` carry it, and the captured spawn's `--model`/`--thinking` are that row's |
| 3 | mock pipeline: high impact retained at implementation; restart/recovery/reanchor preserve it; a declined or absent authorization dispatches nothing | `tests/pipeline.test.ts` — "routing T2: a high-risk pipeline still hands the implementer risk high", "…recovery re-dispatches with the same retained impact", "…reanchor keeps the ship job's impact and re-gates the new plan", "…a frozen task that exists and cannot be read refuses, it does not route low", "pipeline: without a human answer nothing is dispatched", "pipeline: a declined checkpoint stops the pipeline and says so" |
| 4 | mock gate/diff/quality: narrow subject rules fire, the spawned effort differs from the profile's; head freshness, attempt limits, async lifecycle | `tests/gate.test.ts` — "cp-reviewer-routing: the gate routes on the subject's axes and spawns that model AND effort" (with the fixture check that the profile's own level is *not* what spawned); `tests/diff-review.test.ts` — "cp-reviewer-routing: a read-only reviewer still inherits the ship job's high-impact axes", "a verdict on another commit is stale…", "the cap is reviews-per-branch…", "start returns wait with the head under review; the wake-up carries that head"; `tests/quality.test.ts` — "cp-reviewer-routing: a voter routes on the subject's axes, and a model override keeps them" |
| 5 | QA through the real dispatch path uses the QA profile's defaults with the shipped template; the operator catch-all is not migrated; preview agrees with the dispatch and writes no state | `tests/routing-integration.test.ts` — "the scaffolded default routes QA and ordinary planning through their own profiles" (scaffold → `loadRoutingConfig` → `Dispatcher.preview`, `source=profile`, `rule=profile qa`), "a home that kept the old planner catch-all is not migrated by anything in this epic", and the preview-vs-dispatch half of the T7 end-to-end test (same `line`, same `JobRouting`, and no fleet file, run dir, spawn or lease before the dispatch) |
| 6 | legacy fixtures load: old roles, old fleet/provenance records, missing assessments, old pipeline records, custom configs; `paths`/`LAYOUT`, flat layout; no live document migrated | `tests/routing-integration.test.ts` — "pre-epic fleet records load, route as unknown rather than as measured, and are not rewritten" (three generations in one file; a byte comparison after the read), "a home that kept the old planner catch-all…" (retired role word mapped forward on read, file unchanged); `tests/layout-flat.test.ts` — "a flat home scaffolds data/, state/, projects/ and the ledger directly…" (the copied default at `data/routing.json`); `tests/contracts.test.ts` — "a legacy \"researcher\" role on disk loads as planner…"; `tests/pipeline.test.ts` — "routing T2: a legacy record recovers the impact from the facts that do exist", "routing T2: a legacy `JobRouting` with no per-axis provenance is still read honestly" |
| 7 | real pi TUI inspection of `/doctor` and the routing status/preview output | **not performed** — see §4. Headless tests are not evidence about a TUI |
| 8 | docs match behaviour | §5 |
| 9 | parent eval evidence summarized, quality honestly labeled | §6 |

## 3. Compatibility cases actually exercised

Every one of these is a fixture written by the test, never a live document:

- a `data/routing.json` written for the **pre-rename** role vocabulary
  (`role: "researcher"`) — loads, routes, and is not rewritten;
- a `data/routing.json` that still carries the **broad planner catch-all** the
  shipped template dropped (cp-routing-t4) — still first-match-wins in that
  home's favour; the scaffold reports `present` and copies nothing;
- `state/fleet.json` holding three generations at once: a record with **no
  `routing` at all**, one with the **one-bit `inferred`** shape and no per-axis
  provenance, and one written by this build. All three load; the oldest routes a
  reviewer as `unknown`/`unknown` rather than as a measured `S`/`low`;
- a **flat** home: the copied default is scaffolded at `data/routing.json` under
  the home itself through the same `LAYOUT.routingFile` (`tests/layout-flat.test.ts`,
  which configures the flat layout in its own process).

A config that still carries `pins[]` is a refusal with the migration text, not a
silent load (`tests/routing.test.ts`) — that is intentional and unchanged here.

## 4. Real pi TUI: not inspected

`/doctor`'s routing findings and the routing lines in `/status` were **not**
opened in a real pi TUI for this task. The verification ran headless, and a green
headless suite is not evidence about what a terminal renders — this repo has the
incident on record (cur-20260901-5, PR #35) where the suite passed and the UI
failed differently.

What *is* covered headlessly, and is all that is claimed: `tests/doctor.test.ts`
over the routing findings (shadowed rows, effort drift, allowlist and
availability refusals) and `tests/dispatch-preview-tool.test.ts` over the
`cp_dispatch dry_run` payload. The visual pass stays open work for an operator at
a console; it is not a blocker for the deterministic changes above, and it must
not be reported as done.

## 5. Docs reviewed

Read against the integrated code, with only task-related stale text touched:

- `docs/contracts.md` §Routing config — resolution order, no fallback ladder, the
  T5 lint, the copy-once template and the cp-routing-t4 table: all match the code
  as merged;
- `docs/contracts.md` §Parent assessment (T6) — scope vs risk vs uncertainty, and
  the explicit "the parent-model half is not measured yet";
- `AGENTS.md` §Scope and risk are the resource decision — workflow and resource
  decisions kept separate, an unknown axis stays absent;
- `docs/evals.md` §Parent classification cases — the paid trial is described as
  pending, with the protocol;
- `docs/parity.md`, `README.md` — nothing about routing has gone stale;
- `src/routing.ts` — **fixed**: `resolveModel`'s doc comment still promised "the
  fallback ladder", which cp-eff removed and which the module header, the
  refusal message and `docs/contracts.md` all correctly deny.

`docs/build-history.md`'s T13 row still says "override>pin>rubric>profile +
fallback ladder". That is deliberate: the file is a dated snapshot of *why each
issue closed at the time*, not a description of today's code.

## 6. Parent-selection quality: unverified

The parent's own category choices (`evals/parent-routing.json`, T6) carry two
layers: human `labels` and the `deterministic` answer `classifyIntake` /
`resolveRoutingInputs` give today. `tests/parent-routing-evals.test.ts` pins the
deterministic layer and the corpus's shape.

**No parent-model quality number exists and none is claimed here.**
`live_trials.status` is `pending_operator_approval`; the paid trial has not been
run and this task did not run it. So the changed parent guidance in `AGENTS.md`
is *not* being rolled out as a measured improvement — it is a documented policy
change whose deterministic half is tested and whose model-judgment half is
unmeasured. The deterministic fixes in T1–T5 stand on their own tests and can be
reviewed independently of that.

## 7. Rollout and recovery

- **Nothing here rewrites a live config.** The only write the scaffold ever makes
  to a routing decision is the copy-once of `data/routing.default.json` into
  `data/routing.json` when that file does not exist. An existing file — however
  it got there — reports `present` forever after. Verified by byte comparison,
  not by reading the code.
- **No auth or provider change** is part of this epic, and none was made.
- **Migrating an existing home is an operator edit, and it is opt-in.** A home
  that predates cp-routing-t4 keeps its broad `research` planner row and keeps
  routing ordinary planning to Opus. To adopt the shipped default's behaviour,
  delete that row (ordinary planning and QA then fall through to
  `profiles/planner.md` and `profiles/qa.md`); to keep it, do nothing. To take
  the whole new template, move `data/routing.json` aside and start a session —
  the copy-once step will then run, and the old file is still on disk to restore.
- **Running and held workers are not re-routed.** Routing is resolved once per
  dispatch; a model change reaches a job only through the existing
  teardown-and-fresh-dispatch contract, never by promoting a live worker onto
  another model, and never by restarting the parent while workers are live
  (cur-20260901-4).
- **Before any later authorized config change**: keep the exact prior file, and
  validate the proposed one with `/doctor` (allowlist, availability, duplicate
  ids, shadowed rows, effort drift — all read-only) plus `cp_dispatch
  dry_run: true`, which resolves the real route and takes nothing. Roll back by
  restoring that one file; nothing else in this epic is stateful.
- **A multi-vendor model rollout is out of scope** for this epic and is not
  proposed here. If one is written later, the operator's standing preference is
  Grok 4.6 rather than Codex, and current model ids and availability must be
  re-checked at that time — the ids in the shipped template are as of writing.

## 8. Open, and next permitted action

1. The **real pi TUI pass** (§4) — an operator at a console, reported separately.
2. The **paid parent-model trial** (§6) — needs an explicit operator
   authorization before any inference is run; the protocol is in
   `docs/evals.md`.

Neither is closed by this verification, and neither should be marked done by it.
