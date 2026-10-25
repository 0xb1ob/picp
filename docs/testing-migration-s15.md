# S15 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S15 owns the whole of review-context, review-merge-window, review-runs and review-tool. Other slices own all other conversions.

## Dispositions

All 38 declarations are closed: 32 mapped and 6 retained (15.8%), with none pending and no whole declarations discarded as redundant. Context: 10 mapped, source file deleted. Window: 2 mapped, source file deleted. Tool: 4 mapped and 3 retained in `tests/review-tool-retained.test.ts`. Review-runs: 16 mapped and 3 retained in `tests/review-runs-retained.test.ts`. Thus two files are wholly deleted and two are replaced by retained subsets; four original paths retire, two retained paths are added, net two fewer test files. Thirteen consumer declarations replace the 32 removed source declarations, net 19 fewer declarations.

The baseline inventory requires `deleted` for a missing original path (`GONE` in `scripts/test-migration-check.ts`); it has no moved disposition. That mechanical path label gives no whole-file deletion credit for review-runs or review-tool. Their six assertion rows and two incoming replacement files are retained under P3c-rest. The ledger counts only context and merge-window as whole-file deletions. On the merged base, measured tree totals are 378 → 376 files and 4,204 → 4,185 declarations; the isolated S15 change is 4 → 2 source files and 38 → 6 retained declarations, plus 13 declarations in existing consumer files.

All 34 executed controls have canonical regression rows and committed patches described in words below. R15–R17 and W01 were re-executed against the current knob-configured scenarios for review 1; other controls retain the original S15 execution evidence.
All product entry points use real product code and mocked models. Temporary agent directories, git shims and invalid profile configuration live outside the checkout and are removed by test cleanup. Filesystem fault cases alter the OS rename boundary and restore it in `finally`.

## Window equivalence

`landing S15: durable review evidence owns the merge window across parent restarts` exercises `CommandPost.integrate` and a fresh real RPC parent's `cp_integrate`. It checks missing, incomplete, malformed and wrong-head evidence; the configured 20-second deadline across restart; unchanged verdict bytes; and fresh/elapsed equivalent passes. The twelve-variant deadline matrix uses a configured 3-second window.

Current W01 removes `reviewMergeWindowMs()` from the merge deadline: L fails `assert.ok(Date.now() >= Date.parse(verdict.decided_at) + 5_000)` and the restart scenario fails `'advance' !== 'wait'`. Both failed again during review 1. W02's original head-match control (the pass no longer has to match the head) remains inherited.

V8 captures `/tmp/cp-s15-window-before-Zj7vN0` and `/tmp/cp-s15-window-final-GJoDIs` each contain two window module records and the same six positive named-function tuples. Anonymous wrapper offsets change when files are loaded through the real parent; they are excluded from the named-function comparison.

## Tool assertion accounting

Scenario T is `S15: the real cp_review tool relays bounded verdicts and policy refusals without review bodies`; P is `S15: dispatch preview rejects parent tools in external worker profile configuration`, both in `tests/e2e/diff-review.test.ts`.

| Original declaration | Disposition | Assertion coverage and executed control |
|---|---|---|
| 1 registers beside gate; dispatch refusal | mapped T | Actual parent tool schemas and descriptions, dispatch-specific error, no decision; T00 fails the cp_dispatch repair assertion. |
| 2 parent-only review and gate | mapped P | Public dispatch preview reads external invalid profiles for both tools; T05 fails the cp_review rejection assertion. Real reviewer requests also contain neither parent tool. |
| 3 round-trip and closed schema | retained | T pins real RPC schema validity, head, separate next and verdict-file equality (T01). The remaining closed-schema assertion supplies an extra next property directly to validate: cp_review has no argument permitting a caller-supplied DiffVerdict; DiffReview validates persisted decisions and removes next before returning. Keep the original declaration verbatim for this schema contract. |
| 4 medium finding still proceeds | mapped T | The complete medium reason reaches RPC content and next remains proceed; T02 removes formatted content and fails the reason assertion. |
| 5 malformed negative file count | retained | cp_review cannot return a negative diff_stat.files: git output is counted, persisted prior verdicts are validated, and finish validates before writing. No tool argument supplies a verdict. Keep the helper's defensive validator assertion verbatim. |
| 6 uncapped observation and raw subject | retained | T now covers real materialized subjects: a drain starts after preflight but before spawn, producing a bounded operational verdict with subject counts and no diff path (T03 fails). The original combined input additionally contains a raw review observation, a revise receipt and materialized diff together. cp_review cannot return that combination: its live reviewer returns wait and the observation finishes asynchronously; cached and policy results have no raw observation, and synchronous spawn failure has no reviewer observation. Keep the original declaration verbatim for that unreachable helper input. |
| 7 model-free stat overflow | mapped T | Wide and oversized real branches return validated policy verdicts, no model/subject and no reviewer; T04 fabricates a model and fails the model-free assertion. |

The retained source keeps every original assertion for declarations 3, 5 and 6; unused imports and explanatory comments were removed. Four mapped declarations are removed only after the replacement scenarios and their controls pass/fail as recorded. Direct typed-helper invalid inputs remain protected; they are not invented through mocks of product functions.

## Executed additional controls

To reproduce a control, apply its patch with `git apply --unidiff-zero`, run the named scenario through `npm run test:one -- --test-name-pattern='<prefix>' tests/e2e/diff-review.test.ts`, then restore source. R15–R17 use `landing S15 retry:` in `tests/e2e/landing-*.test.ts`; W01 uses both `landing S15 order:` and `landing S15: durable review evidence`. Review 1 re-executed these four patches individually, restoring each with reverse application; `git apply --check --unidiff-zero` passed for all four.

| Patch | Scenario prefix | Mutation | Observed failing assertion |
|---|---|---|---|
| R01.patch | S15: real reviewer attempts | a new pending marker is written as already handed back | initial pending handed_back true instead of false |
| R02.patch | S15: real reviewer attempts | the wake no longer waits for the caller's handback | one wake before handback instead of zero |
| R03.patch | S15: real reviewer attempts | the handback never sends the wake | zero wakes after handback instead of one |
| R04.patch | S15: a failed verdict transport | a failed verdict transport leaves the pending marker in place | pending.json still exists after failed transport |
| R05.patch | S15: orphan reconciliation | orphan reconciliation wakes even for markers never handed back | untold legacy attempt unexpectedly wakes |
| R06.patch | S15: orphan reconciliation | orphan reconciliation stops at the first failed decision write | later healthy job absent from finished report |
| R07.patch | S15: orphan reconciliation | malformed pending JSON throws and stops the sweep | malformed pending files never stop the orphan sweep: unwanted rejection |
| R08.patch | S15: real review decision writes | an already persisted partial decision is ignored and overwritten | partial-write pass overwritten by escalate |
| R09.patch | S15: real review decision writes | the fallback finish after a failed write is skipped | transient failure emits an unwanted notice; persistent failure has one write instead of two |
| R10.patch | S15: real review decision writes | a failing notice transport throws out of the review registry | failing durable-notice transport rejects reviewer settlement |
| R11.patch | S15: real reviewer attempts | the pending-slot check always looks at the review surface | forcing quality to check the review slot fails `doesNotReject`: a different review surface uses its own slot |
| R15.patch | landing S15 retry | a confirmed key stays in flight instead of being consumed | retaining a confirmed key fails one arrival confirms a verdict only once: actual 2, expected 1 |
| R16.patch | landing S15 retry | a withheld copy counts as resent even when it was not sent | `Got unwanted rejection: withheld copies preserve resend eligibility`; `timed out after 10000ms waiting for a second withheld copy never spends resend eligibility; last = 2` |
| R17.patch | landing S15 retry | verdict suppression expires immediately | `timed out after 30000ms waiting for the busy parent leaves its first verdict unconfirmed through one resend; last = 1` |
| Q01.patch | S15: a real quality waiter | a failed quality wait returns an empty outcome without its operational reason | wake says undefined quality pass instead of quality panel failed / reviewer wait failed |
| B01.patch | S15: a lost caller handback | the handback wait bound grows from 60 to 120 seconds | zero wakes after the production 60-second bound, expected one |
| T00.patch | S15: the real cp_review | the unknown-job refusal names cp_pipeline instead of cp_dispatch | unknown-job refusal names cp_pipeline instead of cp_dispatch |
| T01.patch | S15: the real cp_review | the RPC result carries an empty verdict | every successful RPC result carries a valid verdict: false instead of true |
| T02.patch | S15: the real cp_review | RPC content is a fixed `review complete` instead of the formatted review | RPC content lacks retry can stay stale |
| T03.patch | S15: the real cp_review | RPC details include the materialized diff path | actual operational RPC details contain review/diff.md |
| T04.patch | S15: the real cp_review | a model-free result gets a fabricated model | fabricated policy model instead of undefined |
| T05.patch | S15: dispatch preview | cp_review is dropped from the parent-only tool list | missing expected rejection for a worker profile containing cp_review |

An earlier cached-result-only path-leak probe passed and earns no credit. T03 now reaches the actual materialized-subject path. Moving the afterWakeup hook ahead of send also passed the real landing outcome: the production continuation schedules asynchronous work, while the old unit injects synchronous work. This exploratory mutation was restored and earns no credit for exact callback order.

An exploratory mutation omitting the required pending surface matched no slot and passed the lifecycle e2e; it earns no credit. Public duplicate guards still rejected the second call, which is why declaration 2's direct-registry rejection remains retained. R11 instead forces a cross-surface collision and fails the real quality-start assertion.

## Review-runs assertion accounting

All 19 original declarations passed before retirement. Current D uses a 1-second delivery retry and 32-second suppression lifetime with a 100-second test timeout; current L uses a 5-second merge window. After final controls were restored, D passed in 68,067 ms and L in 16,867 ms; restart used 20 seconds and passed in 9,062 ms; the twelve-variant matrix used 3 seconds and passed in 90,653 ms with a 119-second timeout. A = `S15: real reviewer attempts persist before waiting, reject duplicates and announce only after handback`; FS = `S15: real review decision writes recover once before persistence and preserve partial decisions`; O = `S15: orphan reconciliation consumes durable legacy markers and isolates a failed decision write`, all in `tests/e2e/diff-review.test.ts`. D = `landing S15 retry: real parent delivery confirms, retries withheld verdicts and expires permanent suppression`; L = `landing S15 order: a real verdict wakes the parent before its deadline continuation merges` in `tests/e2e/landing-review-window.test.ts`.

| Original declaration | Disposition | Assertion equivalence and executed control |
|---|---|---|
| 1 durable start/wait result | mapped A | Actual pending schema, pid, handed_back flag, wait model/attempt/surface and review_started event; R01 fails the initial false flag. |
| 2 one pending slot per job/surface | retained | A pins duplicate preflight refusal and simultaneous real review/quality slots (R11). CommandPost.diffReview rejects a duplicate before ReviewRuns.start, while gate/quality reuse their pending wait; no product entry bypasses those guards to expose ReviewRunsError.pending. Keep the original direct-registry declaration verbatim. |
| 3 late handback | mapped A | Real decision persists and pending disappears while wake is withheld; handback sends once and repeat handback is inert; R02 produces an early wake. |
| 4 ordinary early handback | mapped A | Real reviewer with immediate handback produces exactly one wake; R03 removes it. |
| 5 throwing transport | mapped | Failed-transport scenario preserves decision, removes marker and slot; R04 leaves pending.json behind. |
| 6 throwing waiter | mapped | Real quality waiter's atomic file write fails at the filesystem boundary; Q01 loses the operational reason and emits an invalid normal quality summary. |
| 7 finish returns no wake | retained | CommandPost.diffReview, gate and quality supply concrete finishers that return a wake on success or operational outcome. Their thrown writes take the explicit fallback/failure path, not a successful undefined return. No product entry supplies a custom ReviewAttempt.finish; preserve the direct-registry assertion. |
| 8 finish fails before persistence | mapped FS/once | Exactly two write attempts, one normalized operational decision/wake, no notice, one orphan event, no pending marker/slot and next real attempt 2; R09 loses fallback persistence. |
| 9 partial persisted decision | mapped FS/partial | Exactly one write, original pass retained, no fabricated verdict, one durable notice naming attempt and partial write, slot cleared; R08 overwrites pass with escalate. |
| 10 fallback/reporting both fail | mapped FS/always | Two writes fail, no decision/wake, one durable notice, no pending marker; throwing public notice transport cannot reject settlement. R09 loses the second write; R10 makes reporter failure escape. |
| 11 lost handback | mapped | Real lost-handback scenario waits the production 60-second bound, observes durable pass/one wake/cleared slot and starts attempt 2; B01 extends the bound and fails delivery. |
| 12 orphan/legacy handback | mapped O | Actual dead-PID legacy markers finish operationally, preserve expected reason and clean markers; only handed-back marker wakes; replay is inert. R05 wakes the untold marker. |
| 13 orphan failure isolation | mapped O | Unwritable decision directory leaves one failure report, clears broken marker and finishes later healthy job; R06 ends the sweep before that job. |
| 14 live/decided/missing finisher | retained | O pins public live-PID and existing-decision skips. CommandPost.sweepOrphanReviews always supplies review, gate and quality finishers, and validation rejects any other legacy surface. No product entry supplies an incomplete finisher map; keep the original mixed declaration verbatim for its missing-finisher branch. |
| 15 retry/confirmation | mapped D | R15 keeps a confirmed key and fails one arrival confirms a verdict only once (2 instead of 1). D also checks two sends for an unconfirmed verdict and no resend after the confirmed key's deadline. |
| 16 withheld retry eligibility | mapped D | D restores stale facts after at least six withheld copies, requires successful delivery beyond the old five-copy bound, and prohibits a stream. Retry is configured to 1 second; suppression to 32 seconds. The default suppression/backoff relationship is explicitly asserted in tests/timer-knobs.test.ts. |
| 17 finite suppression lifetime | mapped D | D requires at least seven suppressed attempts near the configured 32-second cutoff, no sends at/after cutoff, and no revival after restoring facts. R17 sets eligibility to zero and fails `the busy parent leaves its first verdict unconfirmed through one resend` with last count 1. |
| 18 malformed marker | mapped O | Sweep never rejects the original invalid JSON or an invalid contract shape, preserves both files byte-for-byte, and creates no finished/skipped records for either; R07 makes malformed input reject the sweep. |
| 19 wake then deadline continuation | mapped L | Real raw verdict reaches parent context before its configured 5-second deadline; decision is durable, pending absent, no early merge, exactly one completed merge after the deadline, no second reviewer, and verdict/completion both reach the model. W01 removes that interval. Exact fake-clock task-map size and synchronous injected callback order are redundant-unreachable: L pins the continuation's consumer-visible completed merge. |

The three retained review-runs declarations stay verbatim in `tests/review-runs-retained.test.ts`; only unused imports and comments are removed. Their public portions are additionally covered above. No production function is mocked to force an impossible callback return or finisher map.

The plain merge of #447 adds one upstream `resendDue reads CP_VERDICT_DELIVERY_RETRY_SECONDS and CP_REVIEW_SUPPRESSION_SECONDS` contract to that retained file, verbatim using its existing helpers; all four declarations pass. This incoming contract is outside the original 38-declaration S15 census. No upstream assertion was dropped when resolving the modify/delete conflict.

## Context retirement proof (10 declarations)

All ten declarations are mapped to scenarios 05-S15-C (whole-file packet) and 05-S15-F (object failures) in the canonical manifest. The real git audit checks forbidden object reads and consumer queries. A second actual review after removing the first decision and scratch packet verifies manifest/body determinism from the same git objects. The used-byte sum and whole-section count cover the old small-budget accounting assertions at the product's fixed budget.

The patches in `testing-migration-s15-controls/` target src/review-context.ts. Each was applied individually via the anchor editor, executed against the real-entry scenario, and restored. C01–C04 and C06–C10 run `node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='S15: reviewers receive bounded' --test-force-exit tests/e2e/diff-review.test.ts`; C05 runs the same command with pattern `S15: a git object read failure`. All ten returned exit 1 with the assertions below; the restored scenario passed.

| Control | Mutation | Failing consumer assertion |
|---|---|---|
| C01 | changed paths are added for the head side only, not the fork | deleted docs/legacy.md fork state: undefined instead of included |
| C02 | task-named paths are never added | lib/unique.ts head state: undefined instead of included |
| C03 | the task-path pattern loses its leading-boundary guard | forbidden etc/hosts.md and x.ts cat-file commands present in real git audit |
| C04 | the byte-budget check never omits a file | big.json state: included instead of omitted-budget |
| C05 | an unreadable blob is recorded as absent without its error | unreadable src/fault.ts with named error absent from manifest |
| C06 | binary detection never fires | img.bin state: included instead of binary |
| C07 | included entries drop their sha256 | src/run.py sha256 missing instead of 64 hex characters |
| C08 | the consumer list is no longer capped | consumer array contains use-6 and use-7 |
| C09 | the reviewer brief says all missing context is absent | reviewer brief lacks confirmed-absence explanation |
| C10 | task-named paths are also added on the fork side | unchanged lib/core.py fork unexpectedly included |

E2e-only V8 captures before and after deleting the context source test each contain two review-context module records and the same 80 positive function/range tuples: no lost or gained tuple. Both runs executed all 23 cases with zero skips. The captures include the real product host; reviewer children consume its materialized packets. Ten assertion rows and executed regression controls are recorded before retiring the whole file. The migration checker with --verify-regressions passes.

## Addendum 2: public timer configuration

After #439, these scenarios use `startStack`'s existing per-home `env` option: retry delivery uses `CP_VERDICT_DELIVERY_RETRY_SECONDS=1` and `CP_REVIEW_SUPPRESSION_SECONDS=35`; verdict/continuation ordering uses `CP_REVIEW_MERGE_WINDOW_SECONDS=5`; restart/equivalence uses 20; the twelve-variant deadline matrix uses 3. The fixture restores the environment on cleanup and real RPC children inherit it. No test-only hook or production change is added.

The retry case still requires at least seven attempts across withheld delivery, confirms one arrival exactly once, permits exactly one successful resend, checks attempts near the configured suppression cutoff, and verifies expired verdicts stay dropped after facts recover. Wall-clock expectations now follow the configured durations. The default 15-minute watcher-backoff/20-minute suppression relationship is protected separately by the existing timer-knobs default checks; this accelerated scenario proves configured delivery behavior rather than waiting through the default cadence.

The final combined focused run passed all 16 runner cases with zero skips: retry 55,956 ms, ordering 10,093 ms, restart 10,452 ms, deadline matrix 88,611 ms. A subsequent focused window run passed ordering in 9,713 ms and restart in 8,890 ms. The initial expiry-wait budget was too short; it was corrected and the retry and combined runs both passed.

## Addendum 3: CI run 39706266193 repairs

(main session carry-in) "three real failures from this slice's own changes, not flakes. Repair all three:"

- "tests/timeout-floor.test.ts:55 fails on tests/e2e/landing-s09.test.ts:74 (\"timeout option of 15 ms is under 5000 ms\"). Wait on the event, not a short clock."
- "tests/e2e/diff-review.test.ts:502: assertion falsy at :577."
- "tests/e2e/diff-review.test.ts:612: the FIFO release `sh -c exec 3>\"$1\"; rm \"$1\"; printf release ...` failed on /tmp/cp-s15-slots-*/reviewer-read. This is an open/rm ordering race on the FIFO; make the release robust, not a blind retry. Put its scratch dir under the test's own temp root."

Packet regeneration now clears the complete prior reviewer run, including `verdict.json`, before reusing attempt 1; deleting just the scratch packet left a stale verdict that the waiter could consume before a new provider request. The FIFO barrier lives under this scenario's scratch home. Its writer holds the FIFO open until the regular release file is published, then closes it without writing to the MIME reader's pipe: CI showed SIGPIPE when that reader had already closed. No retry is added. The scripted bash call uses its default timeout rather than the unnecessary explicit `15` that triggered the floor scanner; event-based assertions remain unchanged.

A concurrent validation run hit the retry's 60-second bound. The public suppression setting is now 32 seconds and expiry is observed at its actual cutoff, without an extra second. Seven withheld attempts, confirmation and terminal-expiry checks remain. Final retry passed in 57,111 ms; ordering passed in 9,750 ms, restart in 10,326 ms and the deadline matrix in 108,596 ms.

Final full reviewer file: 53/53, including both reported failures. Timeout-floor: 2/2. Final typecheck: exit 0. Migration regression verification, contract eval 22/22 and normal golden check passed; regeneration changed no golden. An earlier typecheck invocation reached the tool's wall-clock limit; the final standalone invocation completed successfully.

Skipped: full local suite and CI polling. Risk: measured retry margin is about three seconds under load; the scenario retains its 60-second bound.

## Addendum 4: review 1 evidence refresh

(main session carry-in) "Rule v2 controls for decls 15–17 and 19 are unproven against the current tests." Also: "the text still cites 'production 60/120/1200-second timers', a 15-minute watcher backoff, a 120-second resend and the 1493767 ms run."

Re-executed R15, R16 and R17 against the current D scenario; re-executed W01 against both L and the restart/equivalence scenario. All five scenario/control pairs failed their intended assertions, with exact text updated above and in the canonical regression rows. R17 and W01 now patch the public knob readers after #439; all four patches applied cleanly and were restored individually. No production mutation remains.

The default suppression/backoff relation now has an explicit assertion inside the existing timer-knobs suppression contract case. The per-home fixture sets `process.env` and `CommandPost.parentEnv`, and its cleanup restores the prior values; RPC children inherit the configured environment. Timing bounds remain 60 seconds per S15 case and 120 seconds for the matrix. Shortening 32-second suppression further would crowd seven five-second public delivery ticks; shortening the 3-second matrix window would reduce the time available to assert the public pre-deadline gate. This evidence repair keeps those durations and bounds, with load sensitivity disclosed.

(main session carry-in, operator ruling) "Commit and push your local review fixes now as a WIP commit on your branch"; "On resume, the failing exactly-once resend assertion comes first. If it is a product defect and not a test issue, park it as pending-fix with a reproducer and report it (migration-defect rule), do not work around it."

WIP status: the restored retry run failed `a queued unconfirmed verdict is resent exactly once` (actual 1, expected 2). Its cause is unclassified; investigate it before acceleration on resume. The operator's new targets supersede the earlier timing decision: retry <=40 seconds and matrix <=80 seconds using #447's public knobs. This commit only preserves the evidence fixes and default contract assertion while that dependency lands; it does not claim the final scenarios or their future control reruns are complete.

## Addendum 5: #447 merge and resend classification

(main session carry-in) "First, the failing exactly-once resend assertion ... establish whether it is a test issue or a product defect." The former six-second sleep did not guarantee the parent remained busy until the first review completed. A late first verdict could be confirmed immediately, correctly yielding one send. The scenario now starts its prompt without awaiting completion, holds the parent in a public bash-tool file barrier until two sends are observed, releases it in `finally`, and then awaits the prompt. The diagnostic run passed in 58,470 ms with counts `[2 sends, 1 confirmation]` for that job, seven withheld attempts with successful recovery, and no revived expired verdict. No production defect was established; the exact two-send assertion remains.

Plain-merged #447, retaining both slices' controls and incoming rows. Its incoming resend knob contract is preserved unchanged in the retained file and passes alongside the original three retained contracts.

Acceleration limitation: #447 adds compact hold, host escalation/probe and bridge reattach knobs. It does not parameterize `WIDGET_REFRESH_MS = 5000` in `extensions/command-post/helpers.ts`, used by both widget and headless orchestration intervals in `session-hooks.ts` to call `reviewRuns.resendDue()`. Seven suppressed attempts still need six five-second intervals, plus fixture/reviewer startup and expiry verification. A public knob for this orchestration interval is needed to provide retry <=40 seconds with reliable margin. The requested final timing configuration and control reruns remain pending; no test-only hook or weakened assertion is introduced.

The final run without diagnostic logging reached the unchanged 60-second bound; this is not a green delivery. The earlier diagnostic run establishes the two-send/one-confirmation behavior, but acceleration remains blocked on the missing orchestration-interval knob. Typecheck, all nine timer-knob contracts, all four retained registry contracts, timeout-floor, migration regression verification, contract eval and normal golden checks pass. The final R15–R17/W01 reruns must follow the final accelerated scenario.

## Addendum 6: final operator timing ruling

(main session carry-in, operator ruling) "No new knob job; the operator's rule is under 2 minutes per new case, and 40/80 were only flake margin. Keep the observed-resend barrier. Set the retry case's test timeout to 100 s ... Run the deadline matrix at <=100 s through the existing knobs, with its timeout at 119 s."

This supersedes the acceleration blocker above. Retry retains the observed-resend barrier, 1-second delivery retry and 32-second suppression; its runner timeout is 100 seconds. The matrix initially retains the 3-second merge window, with a 119-second runner timeout. WIDGET_REFRESH_MS is an operator cleanup-list item outside this slice. Final timing and mutation evidence follows below.

The final ruling run passed 16/16 cases with zero skips: retry 53,645 ms, ordering 14,505 ms, restart 11,563 ms, and all twelve deadline variants together 86,199 ms. The matrix meets <=100 seconds without changing its 3-second knob. No new timer knob or production code was added.

Re-executed R15–R17 against the final barrier-based retry case and W01 against both final window scenarios, serially and with individual restoration. All patches applied cleanly and are unchanged from the regenerated #439 patches above. R15 fails `one arrival confirms a verdict only once` (2 vs 1). R16 fails `Got unwanted rejection: withheld copies preserve resend eligibility` (last = 2). R17 now fails `timed out after 30000ms waiting for the busy parent leaves its first verdict unconfirmed through one resend; last = 1`. W01 fails `assert.ok(Date.now() >= Date.parse(verdict.decided_at) + 5_000)` and restart `'advance' !== 'wait'`. Only runner timeouts and evidence text changed in this final revision.

After restoring every mutation, the repeated focused run passed 16/16 with zero skips: retry 68,067 ms, ordering 16,867 ms, restart 9,062 ms and deadline matrix 90,653 ms. Retry increased from 53.6 to 68.1 seconds under load but stays below the approved 100-second bound and two-minute case rule; matrix stays below 100 seconds on both runs. Final typecheck, regression verification, timer-knobs 9/9, timeout-floor 2/2, contract eval 22/22 and normal contracts-exports golden check passed; regeneration changed no generated files. Main was already up to date on the plain merge at the start of this continuation.

Skipped: full local suite and CI waiting/polling.
Risk: wall-clock durations remain load-sensitive; the approved timeouts provide margin without changing assertions or production timers.
