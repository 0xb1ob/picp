# Ledger rows: p9g

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9g (cp-e2e-migration-p9g-gb8c) | behavior 11, seventh slice: `cp_send` (`tests/send.test.ts`) through a real CommandPost and real implementer workers on a treehouse pool, in `tests/e2e/send-p9g.test.ts` (33 declarations: 25 mapped, 8 retained verbatim in `tests/send-retained.test.ts`, 3 of them split with their reachable half mapped; controls P9g-S23..S28). `tests/cp-bridge.test.ts` stays `convert`, owned by P9g and deferred to one follow-on at the review-diff cap. #541 lows: the 599 s and 24 h + 1 s sweep edges kept in `tests/parent-delivery-retained.test.ts`, P9f-send-ladder asserts its `outer_retry_exhausted` row and waiter-only outcome, P9f-delivery-wake-paths snapshots the env once per test, p9.md and p9f.md cite P9f-R1..R17 and P9f-S1..S22 | 1 (mixed move: no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 11, seventh slice. Each P9g-send-* scenario dispatches ship/local jobs through `CommandPost.dispatch` onto
a treehouse pool with scripted mock workers, then drives `post.send` against a worker that is idle, busy (a `sleep 6`
bash call), held on a report, failed, or reading a plan pipeline. Grants, checkpoints, gate records and session files are
seeded on the scratch home; every receipt, run-journal marker, frozen task file and escalation is read back.

Retained, not reachable: a delivery that fails after every guard passed (pi answers a real idle prompt), the
receipt-not-busy rearm while pi's busy flag lags, `copyOriginalTask`'s reviewer copy (no `cp_review` runs here), and
the release hook (`released`/`revive` racing a stopping worker) with its policy-block and unwritten-session halves.

`tests/cp-bridge.test.ts` (2,120 lines, 116,386 bytes) is not converted here: with `tests/send.test.ts` and the #541
lows the review diff measured 118,177 bytes before cp-bridge, and its deletion alone adds about 118,000 more, past the
250 KB stop line before any e2e scenario. Its baseline row keeps `convert`; the follow-on owns it.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9g | 11 | `tests/e2e/send-p9g.test.ts` | 8 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9g-send-promote | `tests/e2e/send-p9g.test.ts` | P9g-send-promote: an idle worker takes a promote with its addenda, refuses an idle steer, records each task generation and refuses what is not its own |
| P9g-send-busy | `tests/e2e/send-p9g.test.ts` | P9g-send-busy: a busy worker's auto send steers and queues, and no steer, follow_up or busy prompt changes scope |
| P9g-send-held | `tests/e2e/send-p9g.test.ts` | P9g-send-held: a held worker refuses an idle follow_up, a promote reopens its report and the next one supersedes it; a landed job refuses, a handed-off PR reopens |
| P9g-send-continue | `tests/e2e/send-p9g.test.ts` | P9g-send-continue: a send to a failed job names continue_failed; the continued worker's report supersedes the accepted envelope |
| P9g-send-plan | `tests/e2e/send-p9g.test.ts` | P9g-send-plan: a conversation revise is refused once the plan is approved or vetoed, delivered once until re-gated, and a question is delivered |
| P9g-send-risk | `tests/e2e/send-p9g.test.ts` | P9g-send-risk: a promotion's risk gates, warns or proceeds on an answered ask exactly as a dispatch would, and a denied project refuses every send |
| P9g-send-grants | `tests/e2e/send-p9g.test.ts` | P9g-send-grants: an expired grant keeps its in-flight promotion and repair only while repair is allowed, refuses after a revoke or cap pause, and a serial slot never blocks the held job's own promotion |
| P9g-send-policy | `tests/e2e/send-p9g.test.ts` | P9g-send-policy: a torn or policy-blocked worker session refuses every send mode before delivery; marker-looking prose still delivers |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/send.test.ts | promotion delivers frozen task addenda with provenance without replacing the original | P9g-send-promote | mapped | the brief carries the addendum and its quote; the frozen task is unchanged |
| tests/send.test.ts | idle worker: a promote is delivered | P9g-send-promote | mapped | delivered as a prompt, one prompt_sent marker started with wall_clock_rearmed; control P9g-S23 |
| tests/send.test.ts | settled, unreported worker: an explicit steer is refused, not queued into the void | P9g-send-promote | mapped | steer and follow_up refused naming mode "prompt"; no steer_sent or follow_up_sent; control P9g-S23 |
| tests/send.test.ts | busy worker: steer and follow_up queue, a bare prompt fails honestly | P9g-send-busy | mapped | auto steers, follow_up queues, a bare prompt's failed receipt is logged; none rearms; control P9g-S27 |
| tests/send.test.ts | busy worker: a delivered prompt rearms even when the busy flag reads true | — | retained | kept verbatim in tests/send-retained.test.ts; needs worker.send stubbed to deliver while busy |
| tests/send.test.ts | a promoted held job can still report: the superseding envelope is accepted | P9g-send-held | mapped | received, superseded, received; the blocked envelope archived; run status reported |
| tests/send.test.ts | settled, reported (held) worker: an explicit follow_up is refused the same way | P9g-send-held | mapped | refused before any reopen: still held, no supersession |
| tests/send.test.ts | a failed job continues on its original lease: cp_send refuses it failed, then the resumed worker's report supersedes the accepted envelope | P9g-send-continue | mapped | the refusal names continue_failed; the revived worker's report is the second envelope |
| tests/send.test.ts | a landed delivery is refused, not silently reopened | P9g-send-held | mapped | refused naming cp_teardown and a new job id; no supersession or prompt; control P9g-S25 |
| tests/send.test.ts | human_handoff change request: cp_send to the handed-off job reopens it on the same branch; a dead worker points at cp_revive | P9g-send-held | mapped | the open PR's job reopens on its branch, no new job; a stopped worker names revive |
| tests/send.test.ts | promote rules: same model only, live jobs only, live workers only | P9g-send-promote | mapped | empty, unknown, cross-model, done and workerless sends refused; nothing reaches the model |
| tests/send.test.ts | a promotion (mode prompt) replaces the frozen task, and keeps every prior generation | P9g-send-promote | mapped | generations 1 (task) and 2 (relative taskFile), each prior text archived; control P9g-S26 |
| tests/send.test.ts | risk:high under ask_on refuses a cp_send promotion into a ship brief; an operator-quoted decide then lets it proceed | P9g-send-risk | mapped | one risk_high_irreversible escalation naming the job; answered, the same promotion delivers |
| tests/send.test.ts | under an expired grant a same-kind promotion and a repair send reach the in-flight implementer; a grant without repair refuses both | P9g-send-grants | mapped | both delivered under the expired grant; a later grant without repair refuses both |
| tests/send.test.ts | a repair send is refused before delivery under an expired grant that was revoked or cap-paused | P9g-send-grants | mapped | revoked and spend_cap-paused grants each refuse with no repair under it; nothing delivered |
| tests/send.test.ts | cp-7re9: every cp_send into a denied project is refused before delivery; the frozen task is untouched | P9g-send-risk | mapped | steer, promotion and repair refused; prompts, frozen task and generations unchanged |
| tests/send.test.ts | H6: a cp_send promotion whose risk:high is inferred-only against a recorded low delivers with the warning on the result and in the run journal; an assessed high still escalates | P9g-send-risk | mapped | the warning on the receipt and the prompt_sent marker; the explicit high escalates |
| tests/send.test.ts | #321: a cp_send promotion with a classify-only high under an operator-chat grant warns; a hard stop still escalates | P9g-send-risk | mapped | the classify warning names the operator-chat grant; force push escalates |
| tests/send.test.ts | riskkw-f10: a cp_send promotion reads the new task's header: a declared low warns on a keyword-only high, a declared high gates and names it | P9g-send-risk | mapped | a header low warns, a header high escalates naming the header |
| tests/send.test.ts | serial mandate: promoting the held job itself passes the slot check and reuses its one worker | P9g-send-grants | mapped | a parallelism-1 grant with another job working: delivered, same pids, no new job |
| tests/send.test.ts | a steer or follow_up refuses task/taskFile: scope only changes through a promotion | P9g-send-busy | mapped | steer, auto and follow_up with a task refused; the frozen task untouched; control P9g-S24 |
| tests/send.test.ts | an explicit prompt aimed at a busy worker also refuses task/taskFile: mode alone is not a promotion | P9g-send-busy | mapped | refused naming the busy worker; control P9g-S24 |
| tests/send.test.ts | a task replacement is applied only on a delivered receipt; a failed send mutates nothing | — | retained | kept verbatim in tests/send-retained.test.ts; a real idle prompt is never refused after every guard passed |
| tests/send.test.ts | a promotion with no pre-existing frozen task writes one with no archive to restore | P9g-send-grants | mapped | the frozen task removed before the first promotion: generation 1, nothing archived |
| tests/send.test.ts | the diff reviewer/plan gate reads the latest generation, not a stale copy | — | retained | kept verbatim in tests/send-retained.test.ts; copyOriginalTask's consumer is cp_review, which no send scenario runs |
| tests/send.test.ts | cp_send refuses a conversation revise once the plan checkpoint is approved and the implementer is dispatched | P9g-send-plan | mapped | refused naming the implementer to steer |
| tests/send.test.ts | N4: cp_send refuses a revise after a veto-forced gate escalate, naming the gate file; other text passes the guard | P9g-send-plan | mapped | the gate file named; non-revise text reaches the fleet check |
| tests/send.test.ts | conversation revise: delivered, recorded, and refused a second time until re-gated | P9g-send-plan | mapped | delivered, the open-revise marker written, the second revise refused; control P9g-S28 |
| tests/send.test.ts | conversation question: delivered as a blocked-envelope ask, not refused | P9g-send-plan | mapped | the question delivered after an open revise and reaches the model |
| tests/send.test.ts | 4B1-T5: a send during a release never reaches the stopping worker; it waits, restores, then delivers | — | retained | kept verbatim in tests/send-retained.test.ts; needs a release racing a fake worker's shutdown |
| tests/send.test.ts | 4B1-T5: a dead job that was not released keeps today's cp_revive refusal; sending() clears after a throw | — | retained | kept verbatim in tests/send-retained.test.ts; sending() has no consumer outside the release hook; the refusal is P9g-send-promote's |
| tests/send.test.ts | 4B1-T5: a repair refusal comes before any revive; a revive refusal is surfaced | — | retained | kept verbatim in tests/send-retained.test.ts; needs the release hook's revive callback |
| tests/send.test.ts | S5: every send mode refuses a policy-blocked session before restore, envelope reopen, settle clear or delivery | P9g-send-policy | mapped | every mode, a task and a repair refused naming the session; record unchanged |
| tests/send.test.ts | S5: a released worker is never restored onto a blocked transcript | — | retained | kept verbatim in tests/send-retained.test.ts; needs the release hook |
| tests/send.test.ts | S5: a malformed session is a named refusal; marker-looking prose and an unwritten session still deliver | P9g-send-policy | mapped | a torn line names its line number; the marker inside a brief is prose |
| tests/send.test.ts | S5: an unwritten session still delivers | — | retained | kept verbatim in tests/send-retained.test.ts; a live worker always has written its session file |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P9g-S23 | tests/send.test.ts | P9g-send-promote | an explicit steer or follow_up to an idle worker is not refused | `Missing expected rejection` on the idle steer |
| P9g-S24 | tests/send.test.ts | P9g-send-busy | task/taskFile is accepted with any mode | `Missing expected rejection` on the steer with a task |
| P9g-S25 | tests/send.test.ts | P9g-send-held | decideReopen never refuses a landed delivery | `Missing expected rejection` on the landed job |
| P9g-S26 | tests/send.test.ts | P9g-send-promote | updateFrozenTask overwrites without archiving | ENOENT reading `original-task-superseded-1.md` |
| P9g-S27 | tests/send.test.ts | P9g-send-busy | any prompt rearms, whatever its receipt | `the refused prompt is logged and never restarts the wall clock` |
| P9g-S28 | tests/send.test.ts | P9g-send-plan | a second revise is not refused while one is open | `Missing expected rejection` on the second revise |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/send-p9g.test.ts | cp-e2e-migration-p9g-gb8c | P9g-send-* through a real CommandPost and treehouse-pooled workers |
| tests/send-retained.test.ts | cp-e2e-migration-p9g-gb8c | eight verbatim declarations: a stubbed delivery, the reviewer copy and the release hook |
<!-- /manifest:incoming -->
