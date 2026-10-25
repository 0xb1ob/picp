# S21: wakeup-journal declaration accounting

Owner: cp-e2e-slice-s21-5gtl. Original source: `tests/wakeup-journal.test.ts`, now retired.
22 declarations: **15 mapped, 7 retained/moved verbatim, 0 pending, 1 original path retired**.
Retained share: 31.8%. The mixed retained replacement is not deletion credit: net file count is unchanged.
The seven structural/documentation declarations live in `tests/wakeup-journal-retained.test.ts`; P4 later mapped
declarations 2, 16 and 7's phrase asserts and removed them ([P4 ledger](testing-migration/p4.md)).

## Long recovery-set proof

Fix #442 (636ec3990273) is included from main. The new scenario “S21: forty failed reconcile
candidates retain distinct bounded notices through RPC restart” seeds two real forty-worker fleets
sharing their first 39 candidates, with dead PID 2147483647 and absent sessions. Each actual reconcile
returns 40 failed candidates and persists a bounded recovery notice with all 40 keys and “...and N more”.
Two real RPC parents consume and confirm those notices. Their capped IDs differ despite sharing a long
prefix. It passes locally in about nine seconds, with a 110-second deadline.

`long-recovery.patch` restores unbounded rendering in the production formatter. Actual reconciliation
still observes all 40 failures, but its fallback notice fails the expected recovery-inventory assertions.
The prior 9,654-character reproduction remains in the job artifact as historical evidence. No product
fix is authored here. All fifteen saved controls were replayed against the merged base; logs are in
`node_modules/.s21-runs/replay-*.log` and the per-control exit summary.

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
| 2 | exhaustive failure-class durable-kind table | retained: compile-time enum/table exhaustiveness has no runtime entry for adding a new enum member; Host failures additionally checks current values |
| 3 | markFailed callers | retained: source call-graph restriction has no runtime entry exposing all call sites |
| 4 | distinct long recovery-set IDs | mapped: Forty candidates scenario; long-recovery restores unbounded formatting, so the fallback has undefined keys instead of 40; long-id restores prefix truncation and makes the two actual reconcile IDs equal; positive checks forty failures/keys, bounded RPC content and distinct capped IDs |
| 5 | N7 long CI cause tails | mapped: Host failures; ci-cause control collapses pending count from 16 to 15; distinct-ID and HTTP-tail assertions pin the result |
| 6 | AGENTS death/recovery guidance | retained: no product entry reads the parent's instruction prose as a verifiable runtime result |
| 7 | spent-bound guidance and phrase | retained: mixed prose/format contract; no entry can verify that AGENTS contains the required instruction; Bound additionally pins emitted outcome wording |
| 8 | no preview-derived recovery claim in docs | retained: repository-wide prose prohibition has no runtime consumer exposing all documentation; bound-outcome control pins actual outcome wording |
| 9 | bound/death versus replacement | mapped: Restart; live-replacement control exposes S21_OBSOLETE in model messages. A launching model record is rejected by the canonical fleet validator, so that synthetic subcase adds no reachable model behavior |
| 10 | outbox handoff/restart/ack | mapped: Restart; owner control prevents the replayed death reaching the model. Duplicate enqueue is false, handoff stays pending and delivered ID occurs once |
| 11 | torn-down death stale | mapped: Restart; missing-job control leaves death:cp-gone:1 pending instead of discarding it; model messages also exclude its marker |
| 12 | all versus some recovery candidates gone | mapped: Restart; finished-recovery control leaves recovery:finished pending; mixed live keys reach the model |
| 13 | disk evidence, next tools, no polling | mapped: Host failures and Restart; failure-journal control reduces host pending count to 2 instead of 16; reconcile-journal control prevents the recovery message reaching the model. Positive assertions check on disk, cp_teardown, cp_revive and absence of poll |
| 14 | reconcile journal/restart/confirm | mapped: Restart; reconcile-journal control times out waiting for reconciliation reaching the mock model. Exactly one startup recovery ID is delivered; confirmed source IDs are not replayed |
| 15 | reviewer partial-finish failure | mapped: Review finish; review-finish control yields zero recovery notices instead of one after the new host starts |
| 16 | wakeup file layout | retained: storage path is a structural contract, with no runtime entry choosing between alternate constant definitions |
| 17 | invalid intake emits once | mapped: Intake/loop; failure-journal control times out waiting for envelope_invalid durable death; positive asserts one class-keyed death |
| 18 | every failure class survives parent death | mapped: Host failures; failure-journal control leaves only the two CI events instead of all 16, breaking count before restart; positive checks per-class IDs, kinds, message content and no second-parent replay |
| 19 | shutdown owns close/bound events | mapped: Shutdown; own-close control changes the preserved waiting record into failed after real close evaluation; no durable notice or recovery attempt is allowed |
| 20 | every nonrecoverable emitter | mapped: Intake/loop, Budget/provider, Unreported, Bound, Restart and Host failures' legacy spawn observer. failure-journal breaks the envelope/budget death waits; unreported control suppresses the recorded callback; reconcile-journal removes recovery; bound-occurrence/outcome break bound assertions. The existing real wall-clock case also observes its bound callback. Static enum/table checks remain under row 2 |
| 21 | hard-bound occurrence/outcome wording | mapped: Bound; bound-occurrence removes the failure timestamp from ID; bound-outcome replaces attempted/not-revived with did-not-stick, failing the emitted wording assertion |
| 22 | stale discard versus transport retry | mapped: Restart; transport-discard control loses the finally-persisted discard when real ENOENT interrupts the sweep, leaving cp-gone in the pending-ID assertion; the surviving death then reaches the real restarted parent |

## Executed controls

Patches are complete, independent production mutations and were restored after execution. Logs are in
`node_modules/.s21-runs/` in this worktree. The runner is `npm run test:one --`; the target is the scenario's
file, with `--test-name-pattern='S21: …'` for focused controls. No live provider is used.

| Patch under `docs/s21-controls/` | SHA-256 | Failing observation |
|---|---|---|
| owner.patch | baf73e91ef201c005ca50bf9c54c9965cc6c60d7f6cca59709a479f4ed290e0e | replay wait has zero requests |
| missing-job.patch | 8835db102665d7cc832feff995339983d37e42377e3e11316644becdaa517d72 | gone death remains pending |
| finished-recovery.patch | 50b06b867852afbfe8e97cc49bf775453446e2ff97bb3ff1972db7cf62b2ef43 | obsolete recovery remains pending |
| bound-occurrence.patch | fa6b0c1233283a902c91602bbbd2627168ff285c723949555e690d1ea71ad3e7 | ID omits occurrence timestamp |
| bound-outcome.patch | 89629f1152e31523f9dc21fabfaf96c73521e9e370ed80d858ab47e8f9928041 | attempted/not-revived wording absent |
| ci-cause.patch | e3a4c4856f4c421d6819b3391880f5ca943676148d55688c31f0d8574c9997fd | 15 pending rather than 16 |
| failure-journal.patch | 24f00a37c8e7797ce7060dad3d000a69d0e1b3753b89130af821918f919db704 | host count 2, emitter waits empty |
| live-replacement.patch | 9110f7eb29cdcde1c2ee960ac30633331cb7c8545cda8cf9e4b532b7b738a6ec | obsolete replacement text reaches model |
| own-close.patch | eec378cc45dcc1b1ef9b242fc25778182183503a4eefc98c39a81c7a801ab11e | waiting phase assertion becomes failed |
| reconcile-journal.patch | 2a3611bec029d49a94816cdcd4673f4cb9861d53476a41b812f0fa9de1ce1c8a | reconciliation model-message wait times out |
| review-finish.patch | d13e4abd5dad1eab26a4b6c3a36fdfcf210e8baaed86fd0adf550d3712d20433 | zero notices instead of one |
| transport-discard.patch | 0b34330a10eb9bd9fdf3ea7a3c6c154810ac8ddeb820fb175c3047beec2fb3dc | pending-ID assertion still contains gone job |
| unreported.patch | 68162e6da50f5c762b18f7da4ef4389f60e7bb9b994f073dd38f7f9d9fc6f888 | recorded unreported callback wait times out |
| long-recovery.patch | 9fd54412bc0b81731730dcf3493cda8c271fc7aae8430edf11ba1e2a81a17ab0 | forty failures reconcile, but fallback candidate keys are undefined rather than 40 |
| long-id.patch | f0f80e6aaead687779285ba0845e03da141ebb89f6d3eb8e2eb7b45237ca9e7b | two sets sharing 39 candidates collapse to the same durable ID |

## Timers and cleanup

The separate knob job owns fixed timer findings: 120 seconds at `src/contracts/wakeups.ts:86`, alias
`:196`, consumed at `src/wakeup-outbox.ts:80`; inactivity defaults to 900 seconds at `src/failures.ts:45`.
Successor ownership and legacy timestamps avoid waiting for those timers; no test-only timer hooks were added.
Agent fixtures use mode-0700 temp directories outside the worktree, containing only mock models/settings.
Cleanup closes owned children before removing agents/homes/providers; worker kills target only PIDs started by that case.
No production code or credentials are changed by S21. Full-suite and live-model runs are deliberately skipped. Fifteen runtime declarations are retired only after their consumer scenarios and recorded controls; seven structural/documentation declarations are preserved verbatim in the retained replacement.
