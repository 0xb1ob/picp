# S03 work log

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

Scope: tests/ci-watch.test.ts declarations 41–80, last range; S02 and S07 carry-ins. No source unit has been deleted yet. Mapping remains in progress; the passing scenarios alone do not authorize retirement.

## Executed controls (restored immediately)

Commands use `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.

| ID | Production mutation | Pattern | Observed assertion failure |
|---|---|---|---|
| S03-authority | src/ci-watch.ts: replace the green evidence/authorization/Awaiting row/merged disclaimer with `CI finished.` | landing S03: actual parent | /evidence, not authorization/i fails on the actual CI message, excluding the system prompt |
| S03-confirm | src/ci-watch.ts: remove `if (existing.announced.includes(key)) continue;` | landing S03: corrupt | duplicate arrival changes nothing: actual [key], expected [] |
| S03-corrupt | src/ci-watch.ts: read() JSON catch throws CiWatchError instead of returning EMPTY_CI_WATCH_FILE | landing S03: corrupt | corrupt memory is forgotten, not a failed read: actual 1, expected 0 errors |
| S03-delivery | src/ci-watch.ts: remove delivery !== pr guard | landing S02: only reported | checked exclusion fails for delivery local |
| S03-receipt | src/ci-watch.ts: absent receipt returns true | landing S02: only reported | checked exclusion fails for receipts [] |
| S03-landed | src/ci-watch.ts: status comparison becomes status !== merged | landing S02: only reported | checked exclusion fails for landed receipt |
| S03-blocking | src/ci-watch.ts: ghPrRest invokes gh run watch 12345 instead of gh api pulls | landing S02: watcher queries | watcher command run watch 12345: detectCiWait returns blocking_watch, expected undefined |
| S03-exclusions | src/ci-watch.ts: isWatched returns true; variants are independent subtests | landing S02: only reported | all 11 exclusions fail individually (waiting/done/failed, local/pipeline, empty/artifact receipts, merged/landed/MERGED/trim); no variant is masked by an earlier failure |
| S03-eligible | src/ci-watch.ts: isWatched returns false | landing S02: only reported | the eligible delivery is queried: actual undefined, expected ci_green |
| S03-advice | src/ci-watch.ts: replace two green integration-advice strings with Verify CI yourself and check ancestry with gh pr view | landing S03: actual parent | /cp_integrate/ fails on actual delivered CI message |
| S03-red | src/ci-watch.ts: replace red policy strings with Ask whether to merge the failing run | landing S03: actual parent | /Merging red is forbidden/ fails on actual delivered red notice |
| S03-failed-run | src/ci-run-ref.ts: failedRunOn returns runs[0] | landing S03: actual parent | only the failing run is named: actual false (skipped run 300 replaces failing run 302) |
| S03-generation | src/held-continuation.ts: remove generation mismatch guard | landing S03: facts changed | generation subcase returns review_started instead of stale; repeated with configured mock reviewer, exit 1 |
| S03-pending | src/held-continuation.ts: replace pending-review guard with false | landing S03: new CI | a new fact reaches the already-pending review gate: actual stopped, expected review_pending |
| S07-NC-3 / NC-37 rerun | src/integrate.ts: replace cumulative prior allowance with 0 | landing: held CI repairs the same | restarted parent reads the spent allowance before looking for a local worker: expected /already asked once/, actual no live worker; assertion follows observed startup timestamp change, with no manual integrate call |
| S03-sampled | src/held-continuation.ts: sampledHold returns Hold not sampled | landing S03: a real review verdict | all three independent hold variants fail their sampled-state regex assertions; no fixture setup or model selection failure |
| S03-observed-head | src/held-continuation.ts: remove shaMatches current-head mismatch guard | landing S03: facts changed | observed subcase returns review_started instead of stale, exit 1 |
| S03-remote-head | src/held-continuation.ts: post-read reviewing mismatch uses false instead of comparing remote head | landing S03: facts changed | remote subcase returns review_started instead of stale, exit 1 |
| S03-fleet-write | src/ci-watch.ts: after own-state write, read fleet JSON, clear first job receipts and atomicWriteJson the fleet file | landing S03: corrupt | a watch tick writes no receipts or fleet state fails with receipts [] versus original open PR/CI receipts |
| S03-schema | src/ci-watch.ts: read returns JSON.parse without validateCiWatchFile | landing S03: corrupt | corrupt memory is forgotten, not a failed read: 1 error instead of 0 |
| S03-rest-merged | src/ci-watch.ts: parsePrRest merged becomes false | landing S03: REST | REST merged flag reaches the public observation: pr_closed instead of pr_merged |
| S03-deadline | src/held-continuation.ts: timer callback no longer calls trigger | landing S03: a durable; skip guards other than none | deadline resumes through none fails after 45000ms; only the original envelope stop and pre-deadline CI wait are recorded |
| S03-owner | src/command-post.ts: continuation enabled ignores ownsHome | landing S03: a real parent that loses | disabled ownership cannot advance beyond the review wait fails: surface instead of wait |
| S03-each-step | src/held-continuation.ts: delete loop stale check | landing S03: changes during | generation, phase and head subcases each fail stopped versus stale; head/generation perform repeated branch updates |
| S03-mid-drain | src/held-continuation.ts: draining returns false | landing S03: changes during | drain subcase fails wait versus draining after entering the next integration step |
| S03-missing-head | src/held-continuation.ts: current owner head falls back to trigger.head | landing S03: facts changed | missing subcase fails review_started versus wait |
| S03-coalesce | src/held-continuation.ts: delete seen-key coalescing guard | landing S03: lost watch | an in-flight replay starts no additional integration read: 3 versus 2 |
| S03-rearm | src/held-continuation.ts: delete removal of settled wait/draining keys | landing S03: lost watch | the same identity can read again after settling on wait: 2 versus 3 |
| S03-red-coalesce | src/held-continuation.ts: delete seen-key coalescing guard | landing S03: a stopped red | a completed red replay starts no integration step: 3 versus 2 |
| S03-run-key | src/held-continuation.ts: continuationKey run becomes empty | landing S03: a stopped red | a new attempt reaches integration once: 2 versus 3 |
| S03-generation-key | src/held-continuation.ts: continuationKey generation becomes empty | landing S03: a stopped red | a reopened generation is a new continuation identity: 3 versus 4 |
| S07-NC-2 rerun | src/held-continuation.ts: serialize lane becomes jobId | landing: held CI repairs the same | another job in the project waits behind the CI repair: advanced versus queued |
| S07-NC-1 rerun | src/send.ts: remove repair assertPermitted call | landing: held CI repair checks Sender | revoked: expected /is revoked/, actual no live worker/shutting down restore refusal |
| S03-outcome | src/held-continuation.ts: ciOutcome returns undefined | rpc: one CI-green key whose review is in flight (tests/e2e/headless-lifecycle.test.ts) | the handled-in-code/no-parent-turn notification never arrives; the RPC trace instead contains agent_start/turn_start. Completed negative run exits 1 after 90 seconds; restored case passes in 19 seconds. A first 60-second command was terminated by tool timeout and is not counted as evidence. |
| S03-driving | src/held-continuation.ts: driving returns false | landing S03: a driving worker | spawn-cap assert.rejects: Missing expected rejection |
| S03-driving-finally | src/held-continuation.ts: delete finally's driving.delete | landing S03: a driving worker | the throwing step clears its busy fence: Got unwanted rejection, spawn cap reached |
| S03-resume | src/held-continuation.ts: resume returns [] immediately | landing S03: a restarted parent resumes | startup did not arm the durable window (assert.fail after a bounded 10-second wait) |
| S03-landed-turn | extensions/command-post/wakeup-surfaces.ts: always send triggerTurn true | landing S03: a restarted parent resumes | landing is relayed without waking the parent model: 2 versus 1 |
| S03-tracker | src/held-continuation.ts: append tracker sync pending to NEXT_HINT.done | landing S03: a restarted parent resumes | landed notice doesNotMatch tracker sync / tracker update / receipt note fails; final assertion also rejects every tracker or write-back suffix |
| S03-stop-head | src/held-continuation.ts: stop notice id uses next instead of the head-bearing tag | landing S03: a stopped red | a changed handed-off head gets one more durable stop: 2 versus 3 |

Removing only the landed branch of isQuietWakeup, and then also removing its isRelayOnlyNotice text classification, did not break the parent case. Neither attempt is counted as evidence. Forcing triggerTurn at the actual sendMessage boundary did break the model-turn assertion; the final test allows the queued follow-up 500 ms and takes a fresh RPC state snapshot before counting requests.

## Positive verification

The initial full landing run passed 23 cases. The expanded checkpoint passed 61 cases with zero failures/skips in 717 seconds, but overlapped other control experiments and is not the final retirement gate. A subsequent restored deadline/busy-fence run passed all 11 cases in 308 seconds. The headless outcome case passed separately in 19 seconds. Typecheck, migration checker, contract eval (22/22 scored, 28 skipped), and the regenerated contracts export golden passed; generated artifacts had no diff. Declaration-specific controls, final non-overlapping checks and retirement bookkeeping remain to be completed.

The existing harness creates an isolated throwaway agent directory through createAgentDir, configures only the mock provider, and removes it in t.after. No operator credentials or installed agent configuration are used.

## Follow-up status (2026-10-21)

Declaration 64: **pending-fix**, owned by separate product job cp-parked-notice-no-wake-r2gr. Reproducer: `/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s03-r5f7/parked-reproducer.ts`; expected result: **0 parent wakes**. Keep this fragment outside the pushed suite. Declaration 64 is no longer a blocker for mapping other declarations; file retirement is deferred until the product fix lands.

The continuation send arrived immediately before this worker's 10,800-second wall-clock cap. Observed process start: 2026-10-21 16:32:07 UTC; observed elapsed 02:59:44 at 19:31:52 UTC (PID 2301445). No remaining declaration has been newly claimed mapped. The remaining non-64 mappings and the final full-file gate still require continuation on this branch; the PR stays draft until those checks finish.

## Product blocker: declaration 64

A real parent parks a reviewed green PR under human_handoff, then starts a new model turn whose final input is HELD PR PARKED. The focused reproducer isolates that turn from an unrelated RESTART RECOVERY turn and fails parking is relayed without waking the parent model (actual 1, expected 0). The original declaration explicitly requires no parent wake. The migration brief prohibits product changes, so this blocks retirement rather than authorizing a routing fix.

The reproducible fragment is in the job artifact directory as parked-reproducer.ts. Insert it before the busy-fence case in tests/e2e/landing.test.ts and run npm run test:one -- --test-name-pattern='landing S03: a real parent relays a newly parked' tests/e2e/landing.test.ts. The unmodified product failed this assertion twice, including the isolated check in 6.09 seconds. It uses the real parent, real held worker/session, real park/lease release, scratch git, and mock forge/model boundaries.

Routing explains the result: HeldContinuation.#parked uses relay; CommandPost wires relay and notify to the same recovery journal. isQuietWakeup covers landed/window ids, and isRelayOnlyNotice covers landed/resolve/handled-green text; neither recognizes parked notices. The real wakeup surface therefore sends the parked recovery notice with triggerTurn true. A separate product fix and a green reproducer are needed before continuing declaration 64.

Current accounting is 26/40 S03 declarations mapped, plus S02's 36/40: 62/80 total. Still pending in S03: 45, 54–56, 58, 60, 64–68, 70–71, 78. S02's 6, 8, 32, 33 still require their retained-file disposition. Declaration 54's fresh-parent deadline path is covered, but its expired-pass/retry clauses are not all proved, so its earlier mapped row was removed. No unit file was deleted or moved, no retained file was invented, and no product mutation remains. Final retirement controls remain outstanding.

An exploratory timer-health case was also removed: two different malformed fleet shapes both surfaced as unsafe job id "-" rather than supplying the two distinct failure causes needed by declaration 71. That failed conversion attempt is not counted as mapping or negative-control evidence.
