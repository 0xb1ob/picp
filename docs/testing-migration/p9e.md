# Ledger rows: p9e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9e (cp-e2e-migration-p9e-s8s3) | behavior 11, fifth slice: worker envelope intake through the real parent's startup reconcile, settle watcher and a real worker's reporter in `tests/e2e/envelope-intake-p9e.test.ts`; 17 mapped, 1 retained verbatim in `tests/envelope-correction-retained.test.ts`; four harness, eval-corpus and pi-host files `retained` (no command-post entry point); #523 review lows (I6, exact-ms boundaries, NC ids); [ledger and controls](testing-migration/p9e.md). Eight behavior-11 files (cp-bridge, dashboard-control, intake, operator-delivery, parent-delivery, parent-outbox, send, sync-lossless) stay `convert` / P9 for p9f; #515's p9b files are untouched | 2 (`tests/envelope-correction.test.ts`, `tests/intake-settle-atomicity.test.ts`) |
<!-- /manifest:ledger -->

Behavior 11, fifth slice. P9e-correction seeds fleet records and envelopes on a scratch home and starts the real
command-post extension in RPC pi four times; P9e-reporter and P9e-settle dispatch real mock-model workers on a treehouse
pool. Each control was applied alone to `src/` or `extensions/`, failed on the named assertion, and passed once restored.

Retained whole files (no command-post entry point reaches what they assert):
`tests/operator-target-real-home.test.ts` and `tests/parent-hosts-harness.test.ts` assert the test harness itself (the
hermetic PI_HOME preload, scratch-home host teardown); `tests/parent-routing-evals.test.ts` checks the offline
`evals/parent-routing.json` corpus (the P10c `operator-decide-vs-ask-evals` precedent); `tests/relay-preflight.test.ts`
pins the pinned pi's own hook contract through a probe extension, which no command-post tool or command can drive.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9e | 11 | `tests/e2e/envelope-intake-p9e.test.ts` | 3 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9e-correction | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-correction: a refused envelope is quarantined once per generation and its one corrected report is the delivery |
| P9e-reporter | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-reporter: a worker's report naming a missing artifact is refused at the worker and files nothing |
| P9e-settle | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-settle: the settle watcher stamps an envelope on disk atomically, never nudges it, and refuses a second report |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/envelope-correction.test.ts | an envelope naming an artifact that is not there is refused and quarantined, never deleted | P9e-correction | mapped | byte-equal envelope-invalid-1.json, slot free, waiting, no receipt, one envelope_rejected, operator notice; control E1 |
| tests/envelope-correction.test.ts | the corrected replacement is accepted as the same generation's delivery | P9e-correction | mapped | third start: held, generation 1, pr receipt, one cp-envelope wake; fourth start never restamps; control E1 |
| tests/envelope-correction.test.ts | a second refusal of the same generation fails closed, with both records still on disk | P9e-correction | mapped | cp-twice; control E2 |
| tests/envelope-correction.test.ts | a restart neither re-refuses a quarantined envelope nor hands out a fresh correction | P9e-correction | mapped | second start: corrections unchanged, one envelope_rejected each, cp-uad revivable; control E1 |
| tests/envelope-correction.test.ts | a correction spent on an earlier generation never spends this one's, and never overwrites it | P9e-correction | mapped | cp-stale; control E3 |
| tests/envelope-correction.test.ts | a stamped generation's envelope is never quarantined | — | retained | kept verbatim in tests/envelope-correction-retained.test.ts; missing entry point: reconcile offers held jobs no intake, report_result ends the worker's run, and any later turn is a promote that supersedes the stamp |
| tests/envelope-correction.test.ts | a quarantine left by a crash before the stamp is preserved, not overwritten by the retry | P9e-correction | mapped | cp-crash: envelope-invalid-1-2.json in fleet, journal and notice; control E4 |
| tests/envelope-correction.test.ts | a ship envelope naming an artifact that is not there is repairable at the worker | P9e-reporter | mapped | the report_result tool result names the path; the artifact-less done report is accepted; control E5 |
| tests/intake-settle-atomicity.test.ts | a successful intake leaves reported_at non-null and status.json reported:true | P9e-settle | mapped | late job; control S1 |
| tests/intake-settle-atomicity.test.ts | fleet.patch and clearUnreportedSettles happen in one atomic mutation | P9e-settle | mapped | unreported_settles 1 after the nudge, cleared with the stamp; control S1 |
| tests/intake-settle-atomicity.test.ts | a thrown fleet.mutate leaves reported_at unset, unreported_settles unchanged, and no envelope_received event | P9e-settle | mapped | state dir made read-only before the settle: no stamp, no envelope_received, status.json unreported; control S3 |
| tests/intake-settle-atomicity.test.ts | settle watcher does not nudge a worker whose envelope is on disk | P9e-settle | mapped | late job: three requests only; twice job: no report_nudged; broken job not nudged; control S2 |
| tests/intake-settle-atomicity.test.ts | settle watcher retries intake when envelope is on disk but reported_at is missing | P9e-settle | mapped | broken job's reason carries the retry's EACCES; control S2 |
| tests/intake-settle-atomicity.test.ts | settle watcher answers a refused envelope with one correction prompt | S27-intake-settle | mapped | existing case; control S5 |
| tests/intake-settle-atomicity.test.ts | worker-reporter duplicate refusal throws with 'already filed' and names the record file | P9e-settle | mapped | two report_result calls in one turn; the second's result in the run log; control S4 |
| tests/intake-settle-atomicity.test.ts | concurrent settle calls are serialized and both see the same result | P9e-settle | mapped | the stream's and the settle watcher's intakes race on the late job; control S6 |
| tests/intake-settle-atomicity.test.ts | settle after a previously nudged worker writes its envelope is accepted | P9e-settle | mapped | late job: nudge, envelope by bash, settle stamps; control S1 |
| tests/intake-settle-atomicity.test.ts | settle watcher records (not nudges) when fleet.mutate fails and envelope is on disk | P9e-settle | mapped | broken job: settled_without_report, two requests; control S2 |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| E1 | tests/envelope-correction.test.ts | P9e-correction | intake.ts never quarantines: the first refusal fails the job (the uad bug) | timed out waiting for four quarantines: every job failed |
| E2 | tests/envelope-correction.test.ts | P9e-correction | intake.ts never counts a spent correction | timed out waiting for delivery and three closed slots: cp-twice quarantined again |
| E3 | tests/envelope-correction.test.ts | P9e-correction | intake.ts counts a correction of any generation as spent | `a stale correction never spends the live generation's`: 1, envelope-invalid-1.json |
| E4 | tests/envelope-correction.test.ts | P9e-correction | intake.ts renames over an existing quarantine file (the snj bug) | cp-crash quarantined envelope-invalid-1.json, expected envelope-invalid-1-2.json |
| E5 | tests/envelope-correction.test.ts | P9e-reporter | worker-reporter localChecks skips the artifact check for ship (the o77y bug) | `the worker is told which artifact is missing` |
| S1 | tests/intake-settle-atomicity.test.ts | P9e-settle | intake.ts keeps unreported_settles in the stamping mutation | `reported_at, the cleared settle counter and status.json land together`: 1 |
| S2 | tests/intake-settle-atomicity.test.ts | P9e-settle | settle.ts drops the envelope-on-disk retry branch (the rud bug) | timed out waiting for the recorded settle: the broken job was nudged |
| S3 | tests/intake-settle-atomicity.test.ts | P9e-settle | intake.ts marks the envelope before the fleet write | `and journals no delivery` |
| S4 | tests/intake-settle-atomicity.test.ts | P9e-settle | worker-reporter restores the old "already accepted with different content" text | timed out waiting for the duplicate refusal |
| S5 | tests/intake-settle-atomicity.test.ts | S27-intake-settle | settle.ts never applies the prompt bound | `one correction prompt, no retry loop` |
| S6 | tests/intake-settle-atomicity.test.ts | P9e-settle | intake.ts drops its in-flight dedupe | `the racing settle and stream intakes journal one delivery`: 2 |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/envelope-intake-p9e.test.ts | cp-e2e-migration-p9e-s8s3 | P9e behavior 11: envelope correction, reporter refusal and settle intake |
| tests/envelope-correction-retained.test.ts | cp-e2e-migration-p9e-s8s3 | P9e: the stamped-envelope unit no entry point reaches |
| tests/control-pending-retained.test.ts | cp-e2e-migration-p9e-s8s3 | #523 review low: exact-ms 24 h TTL and 7-day lost-send boundaries the wall-clock e2e pins only to the minute |
<!-- /manifest:incoming -->
