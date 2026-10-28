# Ledger rows: p9e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9e (cp-e2e-migration-p9e-s8s3) | behavior 11, fifth slice: worker envelope intake through the real parent's startup reconcile, settle watcher and a real worker's reporter in `tests/e2e/envelope-intake-p9e.test.ts`, cp_integrate's worktree sync against real git in `tests/e2e/sync-lossless-p9e.test.ts`, and the operator session's dashboard control through the real cp-bridge in `tests/e2e/operator-dashboard.test.ts`; 37 mapped, 7 retained verbatim in `tests/envelope-correction-retained.test.ts` and `tests/dashboard-control-retained.test.ts`; four harness, eval-corpus and pi-host files `retained` (no command-post entry point); #523 review lows (I6, exact-ms boundaries, NC ids); [ledger and controls](p9e.md). Eleven behavior-11 files stay `convert` / P9, owner p9f: cp-bridge, intake, operator-cache-warming, operator-delivery, operator-note, operator-outbox-host, operator-outbox, parent-delivery, parent-outbox, relay-scope, send (operator-cache-warming, operator-note, operator-outbox-host, operator-outbox and relay-scope are also in the open #515, p9b; p9f takes them if it does not land); this PR does not touch them | 4 (`tests/dashboard-control.test.ts`, `tests/envelope-correction.test.ts`, `tests/intake-settle-atomicity.test.ts`, `tests/sync-lossless.test.ts`) |
<!-- /manifest:ledger -->

Behavior 11, fifth slice. P9e-correction seeds fleet records and envelopes on a scratch home and starts the real
command-post extension in RPC pi four times; P9e-reporter, P9e-settle and P9e-sync dispatch real mock-model workers on a
treehouse pool (P9e-sync then lands through `cp_integrate` with a fake `gh` and real git). P9e-control* start the
operator's own RPC pi with the real cp-bridge and drive its control socket as the viewer does. Each control was applied
alone to `src/` or `extensions/`, failed on the named assertion, and passed once restored.

Retained whole files (no command-post entry point reaches what they assert):
`tests/operator-target-real-home.test.ts` and `tests/parent-hosts-harness.test.ts` assert the test harness itself (the
hermetic PI_HOME preload, scratch-home host teardown); `tests/parent-routing-evals.test.ts` checks the offline
`evals/parent-routing.json` corpus (the P10c `operator-decide-vs-ask-evals` precedent); `tests/relay-preflight.test.ts`
pins the pinned pi's own hook contract through a probe extension, which no command-post tool or command can drive.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9e | 11 | `tests/e2e/envelope-intake-p9e.test.ts`, `tests/e2e/sync-lossless-p9e.test.ts`, `tests/e2e/operator-dashboard.test.ts` | 8 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9e-correction | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-correction: a refused envelope is quarantined once per generation and its one corrected report is the delivery |
| P9e-reporter | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-reporter: a worker's report naming a missing artifact is refused at the worker and files nothing |
| P9e-settle | `tests/e2e/envelope-intake-p9e.test.ts` | P9e-settle: the settle watcher stamps an envelope on disk atomically, never nudges it, and refuses a second report |
| P9e-sync | `tests/e2e/sync-lossless-p9e.test.ts` | P9e-sync: a squash-merged rebased branch resets its lease with a rescue ref, and any unproven work refuses |
| P9e-control | `tests/e2e/operator-dashboard.test.ts` | P9e-control: the real bridge's dashboard control delivers, holds, steers, aborts and answers, journaling every frame |
| P9e-control-queue | `tests/e2e/operator-dashboard.test.ts` | P9e-control-queue: held messages are edited, cancelled and handed over one per settled turn, and survive a restart once |
| P9e-control-target | `tests/e2e/operator-dashboard.test.ts` | P9e-control-target: a selected.json naming a missing per-home target still starts dashboard control on the CP_HOME home |
| P9e-control-inbox | `tests/e2e/operator-dashboard.test.ts` | P9e-control-inbox: the offline inbox and a reloaded queue hand over in time order, once, across starts |
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
| tests/dashboard-control.test.ts | parsers: config defaults on and opts out; record and marker round-trip and refuse malformed input | S26-dashboard-refusals | mapped | split (P9f, #533 low): off, `{}` and `{"enabled":true}` on; a non-boolean, an extra key, non-JSON and an array refused as off naming why; controls P9f-C1, P9f-C2 |
| tests/dashboard-control.test.ts | parsers: config defaults on and opts out; record and marker round-trip and refuse malformed input | — | retained | split: record and marker kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: malformed records and markers are never written by a real session |
| tests/dashboard-control.test.ts | lifecycle: off opens nothing; on binds a 0600 socket and record; a bad token journals nothing; stop removes both | P9e-control | mapped | plus a second session leaving the live socket served; controls C1, C9, C10 |
| tests/dashboard-control.test.ts | delivery: idle is a prompt, busy is held until a settled turn, steer on request; unseen-within-wait, late sighting, shutdown drop | — | retained | kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: a real pi always echoes the message, so unseen-within-wait, a late sighting and an unseen shutdown drop need the fake ports' echo switch; the idle, held and steer paths are pinned by P9e-control (control C2) |
| tests/dashboard-control.test.ts | clicks: verbatim label with the ask id; unknown label 400, settled ask 409, second click 409; asks.jsonl never changes | P9e-control | mapped | refusals table, one request and one refused outcome per frame, no refused text reaches the model; control C12 |
| tests/dashboard-control.test.ts | threaded sends: normalize the tag in the footer; clicks keep ask=; invalid tags inject nothing | P9e-control | narrowed | Narrowed: thread parts removed with the feature by #588; a stale `thread` is dropped and the marker carries no `; thread=`; clicks keep `ask=` |
| tests/dashboard-control.test.ts | states: a throwing inject fails with its message; abort refused idle, called busy; off refuses the next frame | — | retained | kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: a real pi never throws from sendUserMessage; abort and off are pinned by P9e-control (control C10) |
| tests/dashboard-control.test.ts | audit: an unwritable request line refuses without injecting | P9e-control | mapped | control journal made read-only: 500 naming EACCES, no journal line, nothing injected; control C16 |
| tests/dashboard-control.test.ts | audit: appendControlAudit is 0600, clips text, never throws | — | retained | kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: only the viewer's HTTP control route journals over-length text (its refused line), and no e2e starts the viewer server; the unwritable path is P9e-control (control C16) |
| tests/dashboard-control.test.ts | cp-bridge wiring: session_start opens the socket, a frame reaches the session as a user message, shutdown closes it; off opens nothing | P9e-control | mapped | the operator-sessions row, the status reply, shutdown and an off start; controls C1, C10 |
| tests/dashboard-control.test.ts | cp-bridge wiring: selected.json naming a missing per-home target still starts control | P9e-control-target | mapped | selected.json seeded under PI_HOME before the session starts; control C15 |
| tests/dashboard-control.test.ts | inbox: held messages arrive once, oldest first, with times; >24 h dropped and listed; a closed ask is marked; a refused injection keeps them held | — | retained | kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: a real pi never refuses the injection; the delivered path is pinned by P9e-control-inbox (controls C7, C8, C11) |
| tests/dashboard-control.test.ts | held thread tags survive replay without changing untagged messages | P9e-control-inbox | narrowed | Narrowed: thread parts removed with the feature by #588; held lines replay in the one inbox turn and a legacy `thread` key adds no marker |
| tests/dashboard-control.test.ts | queue: busy messages wait, one per settled turn, oldest first; edit and cancel apply before the handoff | P9e-control-queue | mapped | edit, cancel, empty edit, 404, sent 409, cancelled 409; controls C3, C4 |
| tests/dashboard-control.test.ts | queue race: edit or cancel while the handoff is in flight; a late failure frees the next turn | — | retained | kept verbatim in tests/dashboard-control-retained.test.ts; missing entry point: holding pi's handoff promise open and rejecting it needs the fake inject |
| tests/dashboard-control.test.ts | queue restart: a stopped bridge's held messages reload in order with their edits; a handed-over one is never resent | P9e-control-queue | mapped | second and third session starts; controls C3, C5 |
| tests/dashboard-control.test.ts | queue restart, FIFO across the offline inbox: older held first, newer after; one handoff per settled turn | P9e-control-inbox | mapped | held-first and inbox-first subtests; controls C5, C6 |
| tests/dashboard-control.test.ts | queue keeps ask ids: reload keeps the marker's ask id; a free-text reply keeps its prefix; a click never queues | P9e-control-queue | mapped | and the reloaded card in P9e-control-inbox; control C5 |
| tests/dashboard-control.test.ts | queue edit whitespace matches the composer: ends trimmed, inner spaces and blank lines kept | P9e-control-queue | mapped | control C4 |
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
| C1 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts accepts any socket token | `a wrong socket token closes the connection without a reply`: a delivered reply |
| C2 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts never holds a busy send | `busy: the dashboard holds it` |
| C3 | tests/dashboard-control.test.ts | P9e-control-queue | dashboard-control.ts hands over without waiting for the previous handoff's turn | each reloaded message injected once: 2, expected 1 |
| C4 | tests/dashboard-control.test.ts | P9e-control-queue | dashboard-control.ts stops trimming a queue edit | edit result text `'  alpha, edited  '` |
| C5 | tests/dashboard-control.test.ts | P9e-control-queue | dashboard-control.ts reloads no held message at start | timed out waiting for `two, edited` (P9e-control-inbox also times out on `linked to a card`) |
| C6 | tests/dashboard-control.test.ts | P9e-control-inbox | dashboard-control.ts always puts the inbox turn first | held-first: `the older one first, …` |
| C7 | tests/dashboard-control.test.ts | P9e-control-inbox | dashboard-control.ts never marks inbox lines delivered | the inbox's delivered lines: [] |
| C8 | tests/dashboard-control.test.ts | P9e-control-inbox | dashboard-control.ts never drops a >24 h inbox line | inbox-first: `3 message(s)`, expected 2 |
| C9 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts never checks whether the socket already answers | `a second session never takes over a live socket` |
| C10 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts ignores the off config on a frame | off: ok true, expected 403 |
| C11 | tests/dashboard-control.test.ts | P9e-control-inbox | dashboard-control.ts never marks a closed ask in the inbox | `the closed ask is marked` |
| C12 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts accepts any label | `{"ask_id":"ask-abcd","label":"keep"}`: 409, expected 400 |
| C15 | tests/dashboard-control.test.ts | P9e-control-target | cp-bridge startControl rethrows an unreadable saved target instead of using CP_HOME | timed out waiting for the dashboard control record |
| C16 | tests/dashboard-control.test.ts | P9e-control | dashboard-control.ts injects although the request line was not journaled | `no request line, no delivery`: ok true |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/envelope-intake-p9e.test.ts | cp-e2e-migration-p9e-s8s3 | P9e behavior 11: envelope correction, reporter refusal and settle intake |
| tests/e2e/sync-lossless-p9e.test.ts | cp-e2e-migration-p9e-s8s3 | P9e behavior 11: cp_integrate worktree sync against real git |
| tests/envelope-correction-retained.test.ts | cp-e2e-migration-p9e-s8s3 | P9e: the stamped-envelope unit no entry point reaches |
| tests/control-pending-retained.test.ts | cp-e2e-migration-p9e-s8s3 | #523 review low: exact-ms 24 h TTL and 7-day lost-send boundaries the wall-clock e2e pins only to the minute |
| tests/dashboard-control-retained.test.ts | cp-e2e-migration-p9e-s8s3 | P9e: the dashboard-control units that need fake ports, a fake journal or an unwritten target |
<!-- /manifest:incoming -->
