# Ledger rows: p9e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9e (cp-e2e-migration-p9e-s8s3) | behavior 11, fifth slice: worker envelope intake through the real parent's startup reconcile, settle watcher and a real worker's reporter in `tests/e2e/envelope-intake-p9e.test.ts`, and cp_integrate's worktree sync against real git in `tests/e2e/sync-lossless-p9e.test.ts`; 25 mapped, 1 retained verbatim in `tests/envelope-correction-retained.test.ts`; four harness, eval-corpus and pi-host files `retained` (no command-post entry point); #523 review lows (I6, exact-ms boundaries, NC ids); [ledger and controls](testing-migration/p9e.md). Seven behavior-11 files (cp-bridge, dashboard-control, intake, operator-delivery, parent-delivery, parent-outbox, send) stay `convert` / P9 for p9f; #515's p9b files are untouched | 3 (`tests/envelope-correction.test.ts`, `tests/intake-settle-atomicity.test.ts`, `tests/sync-lossless.test.ts`) |
<!-- /manifest:ledger -->

Behavior 11, fifth slice. P9e-correction seeds fleet records and envelopes on a scratch home and starts the real
command-post extension in RPC pi four times; P9e-reporter, P9e-settle and P9e-sync dispatch real mock-model workers on a
treehouse pool (P9e-sync then lands through `cp_integrate` with a fake `gh` and real git). Each control was applied alone
to `src/` or `extensions/`, failed on the named assertion, and passed once restored.

Retained whole files (no command-post entry point reaches what they assert):
`tests/operator-target-real-home.test.ts` and `tests/parent-hosts-harness.test.ts` assert the test harness itself (the
hermetic PI_HOME preload, scratch-home host teardown); `tests/parent-routing-evals.test.ts` checks the offline
`evals/parent-routing.json` corpus (the P10c `operator-decide-vs-ask-evals` precedent); `tests/relay-preflight.test.ts`
pins the pinned pi's own hook contract through a probe extension, which no command-post tool or command can drive.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9e | 11 | `tests/e2e/envelope-intake-p9e.test.ts`, `tests/e2e/sync-lossless-p9e.test.ts` | 4 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9e-correction | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-correction: a refused envelope is quarantined once per generation and its one corrected report is the delivery |
| P9e-reporter | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-reporter: a worker's report naming a missing artifact is refused at the worker and files nothing |
| P9e-settle | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-settle: the settle watcher stamps an envelope on disk atomically, never nudges it, and refuses a second report |
| P9e-sync | `tests/e2e/sync-lossless-p9e.test.ts` | P9e-sync: a squash-merged rebased branch resets its lease with a rescue ref, and any unproven work refuses |
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
| tests/sync-lossless.test.ts | the 7 refusals of 2026-09-01, replayed against real git: the reset now proceeds | P9e-sync | mapped | absorbed: done, reset to the rebased sha, rescue ref on the discarded head, discard fact; controls Y1, Y3 |
| tests/sync-lossless.test.ts | the dangerous inverse: a commit whose content the base does not carry still refuses, and the work survives | P9e-sync | mapped | unpushed: surface at sync, head and file unchanged, no rescue ref; control Y2 |
| tests/sync-lossless.test.ts | a binary-only unpushed change is not invisible to the proof: it refuses too | P9e-sync | mapped | binary; control Y2 (dropping --binary still refuses: patch-id differs on the binary stanza) |
| tests/sync-lossless.test.ts | a rebase whose conflict was resolved by hand changed the content, so it refuses | P9e-sync | mapped | conflict; control Y2 |
| tests/sync-lossless.test.ts | a base origin does not have proves nothing, and is never looked up as a tracking ref | 05-S10-1 | mapped | existing base-denied and base-empty modes; control Y4 |
| tests/sync-lossless.test.ts | a rescue ref whose commit the base carries is pruned; one it does not carry survives, object and all | 05-S10-2 | mapped | existing mixed and outside modes; control Y5 |
| tests/sync-lossless.test.ts | an origin that cannot be asked keeps every rescue ref, and it is the ls-remote answer that decided | 05-S10-2 | mapped | existing origin-denied mode; control Y6 |
| tests/sync-lossless.test.ts | a base origin does not have prunes nothing at all | 05-S10-2 | mapped | existing origin-empty mode; control Y6 |
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
| Y1 | tests/sync-lossless.test.ts | P9e-sync | integrate.ts identifies the cumulative diff by its raw text (hash-object) instead of patch-id | absorbed: next surface, expected done |
| Y2 | tests/sync-lossless.test.ts | P9e-sync | integrate.ts never compares the two patch-ids | unpushed, binary, conflict: next done (reset), expected surface |
| Y3 | tests/sync-lossless.test.ts | P9e-sync | integrate.ts resets without writing the rescue ref | `the discarded head is kept in the shared clone` |
| Y4 | tests/sync-lossless.test.ts | 05-S10-1 | integrate.ts reads the proof's base tip from `origin/<base>` instead of ls-remote | base-denied: `reset requires proof`; base-empty fails too |
| Y5 | tests/sync-lossless.test.ts | 05-S10-2 | integrate.ts treats every rescue ref as reachable | mixed: refs [], expected the orphan kept |
| Y6 | tests/sync-lossless.test.ts | 05-S10-2 | integrate.ts reads the prune's base tip from `origin/<base>` instead of ls-remote | origin-denied and origin-empty: refs [], expected the reachable ref kept |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/envelope-intake-p9e.test.ts | cp-e2e-migration-p9e-s8s3 | P9e behavior 11: envelope correction, reporter refusal and settle intake |
| tests/e2e/sync-lossless-p9e.test.ts | cp-e2e-migration-p9e-s8s3 | P9e behavior 11: cp_integrate worktree sync against real git |
| tests/envelope-correction-retained.test.ts | cp-e2e-migration-p9e-s8s3 | P9e: the stamped-envelope unit no entry point reaches |
| tests/control-pending-retained.test.ts | cp-e2e-migration-p9e-s8s3 | #523 review low: exact-ms 24 h TTL and 7-day lost-send boundaries the wall-clock e2e pins only to the minute |
<!-- /manifest:incoming -->
