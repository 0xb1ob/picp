# S03 work log

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

Scope: tests/ci-watch.test.ts declarations 41–80, plus S02 and S07 carry-ins. No source unit is deleted here. Frozen Addendum 1 assigns declaration 71 and final retirement to S10b; the other 39 S03 declarations are mapped.

## Latest operator ruling and declaration-71 blocker

Frozen Addendum 1 (operator-delegated, 2026-10-22T04:17:17Z; send `ps-20261022012038-2316a19c`):
> decl 71 is parked pending-fix in S03b by main-session decision, and S10b maps it and retires tests/ci-watch.test.ts.

Product fix #443 and `tests/e2e/ci-watch-jobless.test.ts` are already on main: the product blocker is gone.
The `pending-fix` ledger label now records the operator's sequencing decision to stop S03b's conflict rounds,
not a pending product fix. S10b owns mapping 71 and retirement; S03b keeps the original whole and adds no case.

On merged source HEAD 0ed75a6ed0f5bcf28e600c84275678cc6336f4ac, the strengthened real-parent case
fails: malformed JSON and invalid fleet schema produce only one durable notice, both keyed by
`unsafe job id "-"`, instead of two notices for distinct causes. The parent survives the first error.
The test took 60.45 seconds. Exact reproducer (replace the existing watch-failure case in landing.test.ts):
`/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s03b-pntl/watch-failure-per-cause-reproducer.ts`.
Log: `s03b-71-positive.log`; assertion `different malformed fleet causes must remain distinct`, actual 1,
expected 2. This is an unmodified-product failure, not an executed negative control.

Historical root cause at that HEAD: CiWatch.tick returned job-less errors with job_id "-"; surfaceCi passed
the sentinel to paths.runDir before journaling, replacing distinct causes with the unsafe-ID exception.
#433 fixed the crash; #443 subsequently fixed cause preservation. The blocker described here is resolved.
The failed fragment stays outside the pushed suite; no production change or deletion is claimed.

Four S02 declarations remain retained verbatim in tests/ci-watch-retained.test.ts. The original file is
still whole by the frozen sequencing decision above; S10b's retirement will remove duplication.
Review 2 replaces the incomplete inherited provenance with the new replay catalog linked below. Its exact
production patches, full base SHAs, commands and observed failing assertions supersede the historical prose.

## Executed controls (restored immediately)

Commands use `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.

The [replay catalog](testing-migration-s03-replayed-controls.md) records the exact production diff and
observed failing assertion for every control below. These are new executions, not reconstructed history.
Base SHA for every row except exclusions: `f30d532f5eed302ec17661dafad2cdf56b3d1d42`.
Exclusions ran on `7266e5df1d469ee861abb20f2b5559d3d5144fce` before the required plain merge.
Each row's ID names its catalog section; grouped aliases share one independently executed production mutation.

| Control IDs | Command pattern | Exact patch and failing assertion |
|---|---|---|
| S03-authority | landing S03: actual parent CI notices | [Catalog](testing-migration-s03-replayed-controls.md#s03-authority) |
| S03-confirm | landing S03: corrupt | [Catalog](testing-migration-s03-replayed-controls.md#s03-confirm) |
| S03-corrupt | landing S03: corrupt | [Catalog](testing-migration-s03-replayed-controls.md#s03-corrupt) |
| S03-exclusions | landing S02: only reported | [Catalog](testing-migration-s03-replayed-controls.md#s03-exclusions); eleven independently failing exclusion subtests |
| S03-delivery | landing S02: only reported | [Catalog](testing-migration-s03-replayed-controls.md#s03-delivery); local and pipeline independently fail |
| S03-receipt | landing S02: only reported | [Catalog](testing-migration-s03-replayed-controls.md#s03-receipt); empty and artifact-only receipts independently fail |
| S03-landed | landing S02: only reported | [Catalog](testing-migration-s03-replayed-controls.md#s03-landed); landed/uppercase/padded statuses independently fail |
| S03-blocking | landing S02: watcher queries | [Catalog](testing-migration-s03-replayed-controls.md#s03-blocking) |
| S03-eligible | landing S02: only reported | [Catalog](testing-migration-s03-replayed-controls.md#s03-eligible) |
| S03-advice | landing S03: actual parent CI notices | [Catalog](testing-migration-s03-replayed-controls.md#s03-advice) |
| S03-red | landing S03: actual parent CI notices | [Catalog](testing-migration-s03-replayed-controls.md#s03-red) |
| S03-failed-run | landing S03: actual parent CI notices | [Catalog](testing-migration-s03-replayed-controls.md#s03-failed-run) |
| S03-generation / S03-observed-head / S03-missing-head | landing S03: facts changed | [Catalog](testing-migration-s03-replayed-controls.md); independent generation/observed/missing failures |
| S03-pending | landing S03: new CI | [Catalog](testing-migration-s03-replayed-controls.md#s03-pending) |
| S07-NC-3 / NC-37 rerun | landing: held CI repairs the same | [Catalog](testing-migration-s03-replayed-controls.md) |
| S03-sampled | landing S03: a real review verdict samples | [Catalog](testing-migration-s03-replayed-controls.md#s03-sampled) |
| S03-remote-head | landing S03: facts changed | [Catalog](testing-migration-s03-replayed-controls.md#s03-remote-head) |
| S03-fleet-write | landing S03: corrupt | [Catalog](testing-migration-s03-replayed-controls.md#s03-fleet-write) |
| S03-schema | landing S03: corrupt | [Catalog](testing-migration-s03-replayed-controls.md#s03-schema) |
| S03-rest-merged | landing S03: REST | [Catalog](testing-migration-s03-replayed-controls.md#s03-rest-merged) |
| S03-deadline | landing S03: a restarted parent | [Catalog](testing-migration-s03-replayed-controls.md#s03-deadline) |
| S03-owner | landing S03: a real parent that loses | [Catalog](testing-migration-s03-replayed-controls.md#s03-owner) |
| S03-each-step | landing S03: changes during | [Catalog](testing-migration-s03-replayed-controls.md#s03-each-step) |
| S03-mid-drain | landing S03: changes during | [Catalog](testing-migration-s03-replayed-controls.md#s03-mid-drain) |
| S03-coalesce / S03-red-coalesce | landing S03: lost watch\|landing S03: a stopped red | [Catalog](testing-migration-s03-replayed-controls.md); both assertions fail independently |
| S03-rearm | landing S03: lost watch | [Catalog](testing-migration-s03-replayed-controls.md#s03-rearm) |
| S03-run-key | landing S03: a stopped red | [Catalog](testing-migration-s03-replayed-controls.md#s03-run-key) |
| S03-generation-key | landing S03: a stopped red | [Catalog](testing-migration-s03-replayed-controls.md#s03-generation-key) |
| S07-NC-2 rerun | landing: held CI repairs the same | [Catalog](testing-migration-s03-replayed-controls.md) |
| S07-NC-1 rerun | landing: held CI repair checks Sender | [Catalog](testing-migration-s03-replayed-controls.md) |
| S03-outcome | rpc: one CI-green key whose review is in flight (headless-lifecycle.test.ts) | [Catalog](testing-migration-s03-replayed-controls.md#s03-outcome) |
| S03-driving | landing S03: a driving worker | [Catalog](testing-migration-s03-replayed-controls.md#s03-driving) |
| S03-driving-finally | landing S03: a driving worker | [Catalog](testing-migration-s03-replayed-controls.md#s03-driving-finally) |
| S03-resume | landing S03: a restarted parent | [Catalog](testing-migration-s03-replayed-controls.md#s03-resume) |
| S03-landed-turn | landing S03: a restarted parent | [Catalog](testing-migration-s03-replayed-controls.md) |
| S03-tracker | landing S03: a restarted parent | [Catalog](testing-migration-s03-replayed-controls.md#s03-tracker) |
| S03-stop-head | landing S03: a stopped red | [Catalog](testing-migration-s03-replayed-controls.md#s03-stop-head) |

Removing only the landed branch of isQuietWakeup, and then also removing its isRelayOnlyNotice text classification, did not break the parent case. Neither attempt is counted as evidence. Forcing triggerTurn at the actual sendMessage boundary did break the model-turn assertion; the final test allows the queued follow-up 500 ms and takes a fresh RPC state snapshot before counting requests.

## Positive verification

The initial full landing run passed 23 cases. The expanded checkpoint passed 61 cases with zero failures/skips in 717 seconds, but overlapped other control experiments and is not the final retirement gate. A subsequent restored deadline/busy-fence run passed all 11 cases in 308 seconds. The headless outcome case passed separately in 19 seconds. Typecheck, migration checker, contract eval (22/22 scored, 28 skipped), and the regenerated contracts export golden passed; generated artifacts had no diff. Declaration-specific controls, final non-overlapping checks and retirement bookkeeping remain to be completed.

Review 2 restored verification on merged base `f30d532f5eed302ec17661dafad2cdf56b3d1d42`: all 66 selected
S03/S02/S07 landing tests and subtests passed in 836.11 seconds; the headless CI-outcome case passed in
21.00 seconds. Typecheck and six focused unit files passed (CI-watch 89, retained CI-watch 4, bridge
reattach 5, compact hold 8, review runs 20, timer knobs 9), as did the migration checker with zero findings.
After the three final eligibility controls, typecheck, the restored only-reported scenario and checker
passed again. Logs: `s03b-review2-positive.log` (exit 0), `s03b-review2-final-predicate.log`,
`s03b-review2-final-migration.log`. The [catalog](testing-migration-s03-replayed-controls.md) records **37**
new independent production mutations covering all inherited table entries. Every mutation is restored;
no production or test change is committed in this revision.

The existing harness creates an isolated throwaway agent directory through createAgentDir, configures only the mock provider, and removes it in t.after. No operator credentials or installed agent configuration are used.

## Follow-up status (2026-10-21)

Declaration 64: **pending-fix**, owned by separate product job cp-parked-notice-no-wake-r2gr. Reproducer: `/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s03-r5f7/parked-reproducer.ts`; expected result: **0 parent wakes**. Keep this fragment outside the pushed suite. Declaration 64 is no longer a blocker for mapping other declarations; file retirement is deferred until the product fix lands.

The continuation send arrived immediately before this worker's 10,800-second wall-clock cap. Observed process start: 2026-10-21 16:32:07 UTC; observed elapsed 02:59:44 at 19:31:52 UTC (PID 2301445). No remaining declaration has been newly claimed mapped. The remaining non-64 mappings and the final full-file gate still require continuation on this branch; the PR stays draft until those checks finish.

## Product blocker: declaration 64

A real parent parks a reviewed green PR under human_handoff, then starts a new model turn whose final input is HELD PR PARKED. The focused reproducer isolates that turn from an unrelated RESTART RECOVERY turn and fails parking is relayed without waking the parent model (actual 1, expected 0). The original declaration explicitly requires no parent wake. The migration brief prohibits product changes, so this blocks retirement rather than authorizing a routing fix.

The reproducible fragment is in the job artifact directory as parked-reproducer.ts. Insert it before the busy-fence case in tests/e2e/landing.test.ts and run npm run test:one -- --test-name-pattern='landing S03: a real parent relays a newly parked' tests/e2e/landing.test.ts. The unmodified product failed this assertion twice, including the isolated check in 6.09 seconds. It uses the real parent, real held worker/session, real park/lease release, scratch git, and mock forge/model boundaries.

Routing explains the result: HeldContinuation.#parked uses relay; CommandPost wires relay and notify to the same recovery journal. isQuietWakeup covers landed/window ids, and isRelayOnlyNotice covers landed/resolve/handled-green text; neither recognizes parked notices. The real wakeup surface therefore sends the parked recovery notice with triggerTurn true. A separate product fix and a green reproducer are needed before continuing declaration 64.

Historical pre-S03b checkpoint: 26/40 S03 plus 36/40 S02 declarations were mapped (62/80); the remaining S03 declarations were 45, 54–56, 58, 60, 64–68, 70–71 and 78. This snapshot is superseded by the current declaration ledger below.

## S03b parked-path verification

On merged base `86b4cec` (#429), the real parked reproducer now lives in
`tests/e2e/landing.test.ts` as `landing S03: a real parent relays a newly parked handoff without a model turn`.
It passed (12.68 seconds), asserting exactly one durable id with prefix `continuation:parked:<job>:`
and zero model requests whose final input contains HELD PR PARKED.
Removing `|| id.startsWith("continuation:parked:")` from `isLandedContinuation` in
`src/wakeup-outbox.ts` failed that exact assertion (actual 1, expected 0; 13.80 seconds).
The mutation was restored immediately. This executes the production producer path and resolves the #429 review unknown.
Other pending declarations and final retirement controls remain unfinished; ci-watch.test.ts stays whole.

## S03b continuation: declaration 71 product failure

On `512d3395db0bf78902ef9e0685a1edfd92d86338`, a real parent crashes when the fleet becomes malformed
while it is watching a held PR. The new conversion attempt failed twice before receiving any durable watch-failure
notice. The second run captured the child stack: `FleetStore.read` → `FleetStore.get` →
`HeldContinuation.#notice` (held-continuation.ts:457) → the trigger error handler (line 227).
`#notice` computes generation using `fleet.get` before its try block, so an error while handling the first fleet
read failure escapes the continuation promise and terminates Node. This is a product issue, outside this migration.

The exact real-process reproducer is preserved at
`/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s03b-pntl/watch-failure-reproducer.ts`.
Insert it in landing.test.ts and run the case pattern `landing S03: the real parent journals`.
Expected: one durable CI/PR WATCH TICK FAILED entry for the malformed fleet, parent remains alive.
Observed: no entries after 15 seconds and child FleetError crash. The intentionally failing fragment was removed
from the pushed suite. Declaration 71 stays pending; the original unit file remains whole.

## S03b current declaration ledger

| Declaration | Disposition | Evidence |
|---|---|---|
| 45, 54–56, 58, 60, 64–68, 70, 78 | mapped | Main assertion ledger and docs/testing-migration-s03b-controls.md; thirteen newly mapped declarations |
| S02 6/8/32/33 | retained | Verbatim copies in tests/ci-watch-retained.test.ts; originals stay whole by operator ruling. Missing entry points: FleetStore refuses the unreported slot before isWatched; Actions refuses the id-less run before derivation; CommandPost supplies no onDisabled callback. Boundary controls do not replace those helper assertions. |
| 71 | pending-fix | Deferred to S10b by frozen Addendum 1; S10b maps it and retires the original. #443 and tests/e2e/ci-watch-jobless.test.ts are already on main; the product blocker is gone. Saved historical reproducer evidence remains above. |

`pending-fix` is recorded here because the assertion-map parser rejects that status; it is not represented as retained.
The unit file stays whole by main-session decision while 71 is pending-fix. S03 is 39 mapped / 1 pending-fix; S02 is 36 mapped / 4 retained. Total: 75 mapped / 4 retained / 1 pending-fix; one retained file, zero deleted files.
S03b's authorized slice is complete with 71 deferred by frozen Addendum 1. #443 is already on main; S10b owns formal mapping 71 and whole-file retirement. Declaration 64 is mapped after #429.

An exploratory timer-health case was also removed: two different malformed fleet shapes both surfaced as unsafe job id "-" rather than supplying the two distinct failure causes needed by declaration 71. That failed conversion attempt is not counted as mapping or negative-control evidence.
