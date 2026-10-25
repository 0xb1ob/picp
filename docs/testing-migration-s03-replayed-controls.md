# S03 inherited control replay

These are new executions, not reconstructed historical provenance. Each mutation was applied independently and restored immediately. Each section names its control, the bug patched back, in words. Commands use `TMPDIR="$PWD/.s03b-review2-runtime" npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing-*.test.ts`. Only production is mutated; fixtures and assertions stay fixed.

For a replay, first create `.s03b-review2-runtime/package.json` containing `{"type":"commonjs"}`.
The local TMPDIR keeps the mock `gh` executable in CommonJS mode under this ES-module repository;
remove that directory after the run. Each test still creates and cleans its own isolated home and agent.

## S03-exclusions

Pattern: `landing S02: only reported`. Exit 1, all eleven independent exclusion subtests fail, including local/pipeline, absent/artifact receipts, merged/landed/uppercase/trimmed statuses and waiting/done/failed phases.

Control: the CI watch watches every record, dropping all delivery, phase, report and receipt exclusions.

## S03-authority

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/evidence, not authorization/i` fails on the actual CI message.

Control: the CI notice drops its evidence-not-authorization sentence.

## S03-advice

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/cp_integrate/` fails on the actual CI message.

Control: the CI notice tells the parent to verify CI and ancestry with gh instead of calling cp_integrate.

## S03-red

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/Merging red is forbidden/` fails on the actual red CI message.

Control: the red CI notice asks whether to merge instead of forbidding a red merge.

## S03-confirm

Pattern: `landing S03: corrupt`. Exit 1: `duplicate arrival changes nothing`, actual [key], expected [].

Control: confirming an arrival no longer skips a key that was already announced.

## S03-corrupt

Pattern: `landing S03: corrupt`. Exit 1: `corrupt memory is forgotten, not a failed read`, actual 1 error, expected 0.

Control: reading corrupt watch memory throws instead of forgetting it.

## S03-schema

Pattern: `landing S03: corrupt`. Exit 1: `corrupt memory is forgotten, not a failed read`, actual 1 error, expected 0.

Control: watch memory is read without schema validation.

## S03-blocking

Pattern: `landing S02: watcher queries`. Exit 1: `watcher command: run watch 12345` (blocking_watch versus undefined).

Control: the PR REST read issues a blocking gh run watch.

## S03-eligible

Pattern: `landing S02: only reported`. Exit 1: `the eligible delivery is queried`.

Control: the CI watch watches no record at all.

## S03-rest-merged

Pattern: `landing S03: REST`. Exit 1: `REST merged flag reaches the public observation`.

Control: the PR REST observation always reports merged false.

## S03-failed-run

Pattern: `landing S03: actual parent CI notices`. Exit 1: `only the failing run is named`.

Control: the failed-run lookup returns the first run instead of the failing run on the head.

## S03-fleet-write

Pattern: `landing S03: corrupt`. Exit 1: `a watch tick writes no receipts or fleet state`. Insert immediately before `return fresh` in confirm.

Control: confirming an arrival rewrites the fleet file and erases its receipts.

## S03-generation / S03-observed-head / S03-missing-head

Pattern: `landing S03: facts changed`. Exit 1, generation/observed/missing independently fail with review_started instead of stale/stale/wait; remote stays guarded. Insert first in #stale.

Control: the continuation stale check always reports fresh.

## S03-remote-head

Pattern: `landing S03: facts changed`. Exit 1, remote subcase fails with review_started instead of stale.

Control: the continuation never compares the reviewed head with the triggering head.

## S03-coalesce / S03-red-coalesce

Pattern: `landing S03: lost watch|landing S03: a stopped red`. Exit 1: `an in-flight replay starts no additional integration read` and `a completed red replay starts no integration step`.

Control: the continuation no longer coalesces a key it already handled or queued.

## S03-rearm

Pattern: `landing S03: lost watch`. Exit 1: `the same identity can read again after settling on wait`.

Control: a key that settled on wait or draining is never re-armed.

## S03-run-key

Pattern: `landing S03: a stopped red`. Exit 1: `a new attempt reaches integration once`.

Control: the continuation key drops the CI run identity.

## S03-generation-key

Pattern: `landing S03: a stopped red`. Exit 1: `a reopened generation is a new continuation identity`.

Control: the continuation key drops the generation identity.

## S03-driving

Pattern: `landing S03: a driving worker`. Exit 1: spawn-cap `assert.rejects` reports `Missing expected rejection`.

Control: the continuation never reports a job as being driven.

## S03-driving-finally

Pattern: `landing S03: a driving worker`. Exit 1: `the throwing step clears its busy fence`, unwanted spawn-cap rejection.

Control: a throwing continuation step never clears its driving fence.

## S03-sampled

Pattern: `landing S03: a real review verdict samples`. Exit 1: all three independent sampled-hold regex assertions fail (none recorded, bounded recorded reason, unconfirmed state). Insert first in #sampledHold.

Control: the sampled hold text is always Hold not sampled.

## S03-each-step

Pattern: `landing S03: changes during`. Exit 1: generation, phase and head subcases return stopped rather than stale; drain remains guarded.

Control: the continuation loop skips the stale check between steps.

## S03-mid-drain

Pattern: `landing S03: changes during`. Exit 1: drain subcase reaches the next integration step and returns wait rather than draining. Insert first in #draining.

Control: the continuation never sees a drain.

## S03-pending

Pattern: `landing S03: new CI`. Exit 1: `a new fact reaches the already-pending review gate`.

Control: the continuation skips the pending-review guard.

## S03-deadline

Pattern: `landing S03: a restarted parent`. Exit 1: `the restarted deadline reaches its terminal gate` times out after 45000ms; the persisted gate remains wait. This replaces the historical slow nine-variant control with the existing real-parent restart consumer, without changing its assertions.

Control: the deadline timer never triggers the continuation.

## S03-resume

Pattern: `landing S03: a restarted parent`. Exit 1: `startup did not arm the durable window`, no initial wait recomputation within 10000ms. Insert first in resume.

Control: startup resume returns no outcomes and arms no window.

## S03-owner

Pattern: `landing S03: a real parent that loses`. Exit 1: `disabled ownership cannot advance beyond the review wait`.

Control: the continuation runs even when this parent does not own the home.

## S03-outcome

Command pattern: `rpc: one CI-green key whose review is in flight` in `tests/e2e/headless-lifecycle.test.ts`. Exit 1 after 91.61 seconds: the handled-in-code notification does not arrive within its 90000ms RPC wait.

Control: the continuation hides its CI outcome.

## S03-stop-head

Pattern: `landing S03: a stopped red`. Exit 1: `a changed handed-off head gets one more durable stop`.

Control: the durable stop identity drops its head tag.

## S03-tracker

Pattern: `landing S03: a restarted parent`. Exit 1: the landed UI relay fails `doesNotMatch(/tracker|write-back|receipt note/i)`.

Control: the landed notice appends a tracker sync chore.

## S03-landed-turn

Pattern: `landing S03: a restarted parent`. Exit 1: `landing is relayed without waking the parent model`.

Control: a quiet landing notice wakes the parent model.

## S07-NC-3 / NC-37 rerun

Pattern: `landing: held CI repairs the same`. Exit 1: `restarted parent reads the spent allowance before looking for a local worker`. No manual integrate call is added.

Control: the repair allowance is reset to zero, forgetting spent repairs.

## S07-NC-2 rerun

Pattern: `landing: held CI repairs the same`. Exit 1: `another job in the project waits behind the CI repair`.

Control: CI repairs serialize per job instead of per project.

## S07-NC-1 rerun

Pattern: `landing: held CI repair checks Sender`. Exit 1: `revoked` assert.match expects the mandate refusal and instead reaches the absent-worker restore refusal.

Control: cp_send skips the repair authority check.

## S03-delivery

Pattern: `landing S02: only reported`. Exit 1: independent local and pipeline exclusions fail.

Control: the CI watch no longer excludes non-PR deliveries.

## S03-receipt

Pattern: `landing S02: only reported`. Exit 1: independent empty and artifact-only receipt exclusions fail.

Control: the CI watch watches records that have no PR receipt.

## S03-landed

Pattern: `landing S02: only reported`. Exit 1: landed, uppercase MERGED and padded-merged exclusions independently fail.

Control: only the exact merged receipt status counts as landed.

## Replay total

Review 2 re-executed **37 independent production mutations**, replacing all 40 historical table entries (grouped stale-read and coalescing controls retain independently failing scenarios/subtests). Eligibility also has separate delivery, receipt and landed controls. Every mutation exited 1 on its named consumer assertion and was restored. No production or fixture mutation belongs in the final diff.
