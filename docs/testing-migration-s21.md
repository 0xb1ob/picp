# S21: wakeup-journal declaration accounting

Owner: cp-e2e-slice-s21-5gtl. Original source: `tests/wakeup-journal.test.ts`, now retired.
22 declarations: **15 mapped, 7 retained/moved verbatim, 0 pending, 1 original path retired**.
Retained share: 31.8%. The mixed retained replacement is not deletion credit: net file count is unchanged.
The seven structural/documentation declarations live in `tests/wakeup-journal-retained.test.ts`; P4 later mapped
declarations 2, 16 and 7's phrase asserts and removed them ([P4 ledger](testing-migration/p4.md)).

## Long recovery-set proof

Fix #442 is included from main. The new scenario “S21: forty failed reconcile
candidates retain distinct bounded notices through RPC restart” seeds two real forty-worker fleets
sharing their first 39 candidates, with dead PID 2147483647 and absent sessions. Each actual reconcile
returns 40 failed candidates and persists a bounded recovery notice with all 40 keys and “...and N more”.
Two real RPC parents consume and confirm those notices. Their capped IDs differ despite sharing a long
prefix. It passes locally in about nine seconds, with a 110-second deadline.

The long-recovery control restores unbounded rendering in the production formatter. Actual reconciliation
still observes all 40 failures, but its fallback notice fails the expected recovery-inventory assertions.
No product fix is authored here. All fifteen controls were replayed against the merged base.

## Consumer scenarios and entry points

- **Restart** — `tests/e2e/wake-delivery.test.ts`, “S21: restart delivers an unobserved death once and discards obsolete fleet notices”. Legacy fleet/outbox files feed the real extension in two pi RPC children. It checks failed file-transport preservation, duplicate enqueue refusal, successor replay, replacement/gone-job suppression, mixed recovery retention, actual startup reconciliation, arrival confirmation and no replay. Dead workers use an impossible PID; live orphan fixtures use this test's PID, which is never killed.
- **Host failures** — same file, “S21: host failure events survive restart with distinct CI causes and one arrival per class”. Real exported `CommandPost.fail` and `ciWatchFailed` host event APIs feed the real RPC consumer. A legacy pre-event spawn exit is seeded through the run recorder and replayed through `FailureMonitor.evaluate`, the close observer's event entry. Other classes use the shared failure event API; this case does not claim to exercise each producer. All 14 classes arrive once; CI causes share a 240-character prefix and retain distinct HTTP tails.
- **Bound** — `tests/e2e/bounds.test.ts`, “S21: a real bound whose checkout disappears journals its recovery outcome once”. Actual worker bash calls cross the public tool cap; moving its checkout at the public bound callback makes recovery refuse. Checks final occurrence, generation, class, wording and retained file contents.
- **Intake/loop** — same file, “S21: a rejected envelope and an observed worker loop emit durable deaths”. A legacy rejected-envelope marker is present when the real worker settles. Six real identical bash calls followed by an observed kill of this test's worker exercise the loop observer.
- **Budget/provider** — same file, “S21: budget and provider failures reach the durable death journal”. Public home budgets, real mock usage and `send` record a breach; an observed kill exercises classification. Repeated mock HTTP 401 failures exercise the model-call emitter without exhausting into a transient provider error.
- **Shutdown** — same file, “S21: parent shutdown preserves the interrupted worker without a death or spent recovery”. Real hung worker, real shutdown, then completion of the close observer's public `evaluate` boundary. This avoids asserting before its asynchronous classification finishes.
- **Unreported** — same file, “S21: an idle worker that ignores its report nudge emits one unreported outcome”. Two real model turns reach the public recorded-outcome callback exactly once; the worker remains waiting.
- **Review finish** — `tests/e2e/diff-review.test.ts`, “S21: a reviewer decision followed by a run-log failure owes one durable recovery notice”. Actual reviewer reports a verdict; replacing its event-file path with a directory makes subsequent finish I/O fail. A new host observes one durable recovery notice and confirms it.

The host APIs above are called directly where the production entry is an extension lifecycle/event callback rather than a model tool. No product method is replaced and no fake WorkerProcess is injected. The failed file-transport callback uses actual ENOENT I/O; subsequent delivery uses real pi RPC. All new cases have 110-second deadlines and pass locally within two minutes.

## Declaration map

Each mapped row names an executed mutation and the assertion that fails. Original declaration order is stable.

| # | Behavior | Disposition and proof |
|---|---|---|
| 1 | announced transitions and docs table | retained: developer documentation/table consistency has no runtime entry that can inspect the markdown table |
| 2 | exhaustive failure-class durable-kind table | mapped by P4: S21-host requires every FAILURE_CLASSES member to queue a durable wake that arrives after restart; the non-durable `crash` control fails the pending count (15, expected 16) ([P4 ledger](testing-migration/p4.md)) |
| 3 | markFailed callers | retained: source call-graph restriction has no runtime entry exposing all call sites |
| 4 | distinct long recovery-set IDs | mapped: Forty candidates scenario; long-recovery restores unbounded formatting, so the fallback has undefined keys instead of 40; long-id restores prefix truncation and makes the two actual reconcile IDs equal; positive checks forty failures/keys, bounded RPC content and distinct capped IDs |
| 5 | N7 long CI cause tails | mapped: Host failures; ci-cause control collapses pending count from 16 to 15; distinct-ID and HTTP-tail assertions pin the result |
| 6 | AGENTS death/recovery guidance | retained: no product entry reads the parent's instruction prose as a verifiable runtime result |
| 7 | spent-bound guidance and phrase | retained: mixed prose/format contract; no entry can verify that AGENTS contains the required instruction; Bound additionally pins emitted outcome wording. P4 mapped the BOUND_SPENT_PHRASE asserts to P4-spent |
| 8 | no preview-derived recovery claim in docs | retained: repository-wide prose prohibition has no runtime consumer exposing all documentation; bound-outcome control pins actual outcome wording |
| 9 | bound/death versus replacement | mapped: Restart; live-replacement control exposes S21_OBSOLETE in model messages. A launching model record is rejected by the canonical fleet validator, so that synthetic subcase adds no reachable model behavior |
| 10 | outbox handoff/restart/ack | mapped: Restart; owner control prevents the replayed death reaching the model. Duplicate enqueue is false, handoff stays pending and delivered ID occurs once |
| 11 | torn-down death stale | mapped: Restart; missing-job control leaves death:cp-gone:1 pending instead of discarding it; model messages also exclude its marker |
| 12 | all versus some recovery candidates gone | mapped: Restart; finished-recovery control leaves recovery:finished pending; mixed live keys reach the model |
| 13 | disk evidence, next tools, no polling | mapped: Host failures and Restart; failure-journal control reduces host pending count to 2 instead of 16; reconcile-journal control prevents the recovery message reaching the model. Positive assertions check on disk, cp_teardown, cp_revive and absence of poll |
| 14 | reconcile journal/restart/confirm | mapped: Restart; reconcile-journal control times out waiting for reconciliation reaching the mock model. Exactly one startup recovery ID is delivered; confirmed source IDs are not replayed |
| 15 | reviewer partial-finish failure | mapped: Review finish; review-finish control yields zero recovery notices instead of one after the new host starts |
| 16 | wakeup file layout | mapped by P4: S21-restart reads the delivered row at the literal `.pi-command-post/state/wakeups.json`; the moved-path control fails with ENOENT ([P4 ledger](testing-migration/p4.md)) |
| 17 | invalid intake emits once | mapped: Intake/loop; failure-journal control times out waiting for envelope_invalid durable death; positive asserts one class-keyed death |
| 18 | every failure class survives parent death | mapped: Host failures; failure-journal control leaves only the two CI events instead of all 16, breaking count before restart; positive checks per-class IDs, kinds, message content and no second-parent replay |
| 19 | shutdown owns close/bound events | mapped: Shutdown; own-close control changes the preserved waiting record into failed after real close evaluation; no durable notice or recovery attempt is allowed |
| 20 | every nonrecoverable emitter | mapped: Intake/loop, Budget/provider, Unreported, Bound, Restart and Host failures' legacy spawn observer. failure-journal breaks the envelope/budget death waits; unreported control suppresses the recorded callback; reconcile-journal removes recovery; bound-occurrence/outcome break bound assertions. The existing real wall-clock case also observes its bound callback. Static enum/table checks remain under row 2 |
| 21 | hard-bound occurrence/outcome wording | mapped: Bound; bound-occurrence removes the failure timestamp from ID; bound-outcome replaces attempted/not-revived with did-not-stick, failing the emitted wording assertion |
| 22 | stale discard versus transport retry | mapped: Restart; transport-discard control loses the finally-persisted discard when real ENOENT interrupts the sweep, leaving cp-gone in the pending-ID assertion; the surviving death then reaches the real restarted parent |

## Executed controls

Controls are complete, independent production mutations and were restored after execution. The runner is
`npm run test:one --`; the target is the scenario's file, with `--test-name-pattern='S21: …'` for focused
controls. No live provider is used.

| Control (bug patched back) | Failing observation |
|---|---|
| the durable outbox lets a non-owner claim an entry another process owns | replay wait has zero requests |
| a wake for a job with no fleet record stays fresh instead of stale | gone death remains pending |
| a recovery notice whose candidates were all torn down stays fresh | obsolete recovery remains pending |
| the bound wake-up id drops its occurrence timestamp | ID omits occurrence timestamp |
| the bound recovery line drops the not-revived reason wording | attempted/not-revived wording absent |
| the bounded wake-up id truncates long CI causes with no distinguishing digest | 15 pending rather than 16 |
| the failure announcer never journals a durable death or bound wake-up | host count 2, emitter waits empty |
| a wake for a job whose replacement worker is waiting or launching is not judged stale | obsolete replacement text reaches model |
| a close the command post asked for, or one during shutdown, is classified as a failure | waiting phase assertion becomes failed |
| startup reconciliation no longer journals its recovery notice | reconciliation model-message wait times out |
| a review finish failure is no longer journaled as a durable recovery notice | zero notices instead of one |
| a throwing wake transport skips discarding the entries already judged stale | pending-ID assertion still contains gone job |
| the settle watcher never reports an unreported settle | recorded unreported callback wait times out |
| the recovery notice renders every candidate with no length cap | forty failures reconcile, but fallback candidate keys are undefined rather than 40 |
| long wake-up ids are truncated with no digest, so ids sharing a prefix collide | two sets sharing 39 candidates collapse to the same durable ID |

## Timers and cleanup

The separate knob job owns fixed timer findings: 120 seconds at `src/contracts/wakeups.ts:86`, alias
`:196`, consumed at `src/wakeup-outbox.ts:80`; inactivity defaults to 900 seconds at `src/failures.ts:45`.
Successor ownership and legacy timestamps avoid waiting for those timers; no test-only timer hooks were added.
Agent fixtures use mode-0700 temp directories outside the worktree, containing only mock models/settings.
Cleanup closes owned children before removing agents/homes/providers; worker kills target only PIDs started by that case.
No production code or credentials are changed by S21. Full-suite and live-model runs are deliberately skipped. Fifteen runtime declarations are retired only after their consumer scenarios and recorded controls; seven structural/documentation declarations are preserved verbatim in the retained replacement.
