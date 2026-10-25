# Teardown retirement evidence

Production base: #492.
The previous partial delivery is superseded by this final evidence.

54 static original declarations: **51 mapped, 3 retained, 0 pending, 0 redundant**.
Declarations 18/35/54 move verbatim to `tests/teardown-retained.test.ts`.
This is one original path retired into a retained subset, **zero fully deleted files**.
Consumer execution: S17 32 cases; S18 14 cases; retained 3 cases. Static consumer
counts remain separate: S17 21 test calls, S18 3 test calls (including loops).

## Preservation and provenance

#492 refuses a return when branch-only ignore sources endanger ignored bytes.
The active S17 matrix covers normal and special paths at both force values;
no skip is credited. The successful-return scenario separately covers original
reporting: base-ignored `backtest/`, full nested `pkg/sub/out.log`, excluded
`node_modules` at top and nested levels, formatter text and surviving bytes of
all four entries. A tracked nested package prevents git collapsing the nested
ignored listing to `pkg/`.

The positive S18 shim check performs an actual CommandPost lease return in the
same environment used by startup reconciliation, asserts a logged return,
clears that log, and then asserts no startup calls. Off-PATH mutation fails the
positive observation; an absent logfile alone earns no coverage. Answer failure
uses permissions; pipeline failure uses a real multiline ledger schema error.
Both preserve formatter retry advice and exactly one recovery notice after the
second and third calls.

S11b/S26 sources and evidence are untouched. This retirement makes no claim that
S26's fixture-write time proves an actual child-start timestamp. S17 separately
preserves observed worker exit time versus teardown closed_at. Historical
build-history references remain historical facts. No production source change
or temporary mutation is retained.

## Assertion equivalence and original title census

Scenario aliases below use the S17/S18 ledgers' full names. Every row maps the
whole original declaration, including subordinate refusal, bookkeeping and
formatter assertions, to the indicated outcomes. Internal helper assertions map
to their public result; no internals are mocked to manufacture consumer access.
Retained mixed declarations keep their reachable assertions too.

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| TR-durable | tests/e2e/teardown-s17.test.ts | S17: pr teardown preserves dirty and unpushed work, then returns a reported pushed lease once |
| TR-local | tests/e2e/teardown-s17.test.ts | S17: local teardown preserves dirty and unpushed work, then returns a reported pushed lease once |
| TR-tree | tests/e2e/teardown-s17.test.ts | S17: landing evidence tree is checked against origin and the exact head |
| TR-squash | tests/e2e/teardown-s17.test.ts | S17: landing evidence squash is checked against origin and the exact head |
| TR-rebase | tests/e2e/teardown-s17.test.ts | S17: landing evidence rebase is checked against origin and the exact head |
| TR-stale | tests/e2e/teardown-s17.test.ts | S17: landing evidence stale is checked against origin and the exact head |
| TR-unreadable | tests/e2e/teardown-s17.test.ts | S17: landing evidence unreadable is checked against origin and the exact head |
| TR-receipt | tests/e2e/teardown-s17.test.ts | S17: landing evidence receipt is checked against origin and the exact head |
| TR-extra | tests/e2e/teardown-s17.test.ts | S17: landing evidence receipt-extra is checked against origin and the exact head |
| TR-lab | tests/e2e/teardown-s17.test.ts | S17: a GitLab squash receipt releases a deleted source branch after later base edits |
| TR-force | tests/e2e/teardown-s17.test.ts | S17: force closes a missing legacy worktree without claiming a gate pass |
| TR-head | tests/e2e/teardown-s17.test.ts | S17: failed ship teardown accepts only the current generation and intake attempt |
| TR-research | tests/e2e/teardown-s17.test.ts | S17: legacy research teardown preserves commits and exit time, and labels dead unreported work |
| TR-unowned | tests/e2e/teardown-s17.test.ts | S17: live unowned legacy workers refuse every teardown shape until an observed exit |
| TR-live | tests/e2e/teardown-s17.test.ts | S17: an owned unreported worker is named mid-turn or idle and dead workers stop blocking |
| TR-quote | tests/e2e/teardown-s17.test.ts | S17: public cp_teardown verifies operator quotes before attempting force |
| TR-return | tests/e2e/teardown-s17.test.ts | S17: failed lease return stays open and retries (gated) |
| TR-claim | tests/e2e/teardown-s17.test.ts | S17: concurrent teardown holds the job claim until the external return settles |
| TR-late | tests/e2e/teardown-s17.test.ts | S17: late worker events after observed close cannot block forced legacy cleanup |
| TR-ignored | tests/e2e/teardown-s17.test.ts | S17: successful return reports base-ignored data and filters dependency installs |
| TR-ignored-error | tests/e2e/teardown-s17.test.ts | S17: unreadable ignored listings are named in the public teardown result |
| TR-withdraw | tests/e2e/teardown-s17.test.ts | S17: human review withdrawal and checkpoint cleanup are scoped to the closed job |
| TR-empty | tests/e2e/teardown-s17.test.ts | S17: an empty local ship tears down after the base moves while dirty work still refuses |
| TR-ancestry | tests/e2e/teardown-s17.test.ts | S17: an empty PR ship proves ancestry after origin advances without claiming a merge |
| TR-detached | tests/e2e/teardown-s17.test.ts | S17: a detached head keeps its lease even when its commit is on origin |
| TR-review | tests/e2e/teardown-s17.test.ts | S17: opt-in review must exist before a reported pushed ship can tear down |
| TR-pass | tests/e2e/teardown-s18.test.ts | S18: teardown review pass |
| TR-bound | tests/e2e/teardown-s18.test.ts | S18: teardown review bound |
| TR-truncated | tests/e2e/teardown-s18.test.ts | S18: teardown review truncated |
| TR-flagged | tests/e2e/teardown-s18.test.ts | S18: teardown review flagged |
| TR-policy | tests/e2e/teardown-s18.test.ts | S18: teardown review policy |
| TR-review-force | tests/e2e/teardown-s18.test.ts | S18: teardown review force |
| TR-review-stale | tests/e2e/teardown-s18.test.ts | S18: teardown review stale |
| TR-review-revise | tests/e2e/teardown-s18.test.ts | S18: teardown review revise |
| TR-optout | tests/e2e/teardown-s18.test.ts | S18: teardown review none |
| TR-answer | tests/e2e/teardown-s18.test.ts | S18: research answer ledger closure survives a write failure |
| TR-pipeline | tests/e2e/teardown-s18.test.ts | S18: research pipeline ledger closure survives a write failure |
| TR-startup | tests/e2e/teardown-s18.test.ts | S18: done research ledger retry respects report, envelope, edit and ship guards |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/teardown.test.ts | 1 ship: pushed passes, unpushed and dirty keep everything | TR-durable | mapped | Dirty/unpushed refusal tuples, held fleet, pushed success, done/closed_at, keep bytes; dirty/unpushed controls |
| tests/teardown.test.ts | 2 ship: a merged PR whose head branch was deleted still tears down | TR-tree | mapped | Actual branch deletion and merged_head_deleted result; landing control |
| tests/teardown.test.ts | 3 ship: a squash-merged PR passes on its merge receipt, after the base has moved on | TR-squash | mapped | Content proof without receipt; receipt mode gives merged after later base, gated close; landing/receipt controls |
| tests/teardown.test.ts | 4 forge PR 3: a GitLab MR receipt tears down after the source branch is deleted and later base commits land | TR-lab | mapped | Actual GitLab observation, deleted branch flag/provider and merged reason; receipt control also applies to shared gate |
| tests/teardown.test.ts | 5 ship: a rebase-merged PR is recognised the same way | TR-rebase | mapped | Real rewritten rebase head and exact receipt pass; receipt control |
| tests/teardown.test.ts | 6 ship: a branch that only LOOKS pushed via a stale remote-tracking ref is refused | TR-stale | mapped | Stale tracking never proves push, unpushed refusal, held/no return; head-tracking control |
| tests/teardown.test.ts | 7 ship: the merged-and-absorbed fallback asks origin for the base, not a tracking ref | TR-tree | mapped | External trace pins base ls-remote, no tracking base read, advertised SHA diff; base-tracking control |
| tests/teardown.test.ts | 8 ship: a stale origin/<base> that matches HEAD's tree no longer passes teardown | TR-stale | mapped | Rewound origin and stale equal-tree tracking refuse; base-tracking control |
| tests/teardown.test.ts | 9 ship: an unanswerable origin fails the merged-and-absorbed fallback closed | TR-unreadable | mapped | landing_unverified, no return, held and no force advice; unknown control |
| tests/teardown.test.ts | 10 ship: with a merge receipt for this head, the base is never consulted at all | TR-receipt | mapped | Exact receipt passes despite base command failure, no fallback needed; receipt control |
| tests/teardown.test.ts | 11 ship: a merge receipt covers the merged head only, never later commits | TR-extra | mapped | Unlanded extra commit refused and named; receipt-head control |
| tests/teardown.test.ts | 12 ship: a merged, head-deleted job can still be forced, and force still proves nothing | TR-force | mapped | Forced close, undefined evidence reason, forced fleet marker; force control |
| tests/teardown.test.ts | 13 ship: a branch that was never pushed and never merged is refused | TR-durable | mapped | No upstream and mismatched remote messages, no return and held; unpushed/head-tracking controls |
| tests/teardown.test.ts | 14 failed ship: pushed but unreported head keeps its lease until reported or merged | TR-head | mapped | Intake absence, wrong attempt, stale SHA refused before current report passes; accepted-head control |
| tests/teardown.test.ts | 15 failed ship: a previous generation's report cannot release the current lease | TR-head | mapped | Superseded generation refused with unreported_head; generation control |
| tests/teardown.test.ts | 16 failed ship: exact merged receipt clears unreported head; force remains unverified | TR-receipt | mapped | Failed/unreported exact head clears via receipt, extra does not; force separately proves no reason; accepted-receipt/receipt-head/force |
| tests/teardown.test.ts | 17 research: clean and commit-free passes; a local commit is refused | TR-research | mapped | research_commits fix text then clean_research success; research control |
| tests/teardown.test.ts | 18 cp-t9yr F1: an unmanaged live worker is refused under every call shape; force and a quote do not skip it | TR-unowned | retained | tests/teardown-retained.test.ts verbatim; FleetStore rejects persisted model launching phase, so no public entry reaches that read-through fixture. Reachable waiting/held/failed shapes also tested publicly |
| tests/teardown.test.ts | 19 cp-t9yr F1: a reported held job with a live unowned worker is refused even by the gated (integrate) path | TR-unowned | mapped | Live unowned PID refuses, recorded or run-observed exit permits; unowned/observed-close controls |
| tests/teardown.test.ts | 20 N6: teardown keeps the recorded worker exit time; closed_at carries the teardown clock | TR-research | mapped | Exact old exited_at survives and closed_at differs; exit-time control |
| tests/teardown.test.ts | 21 issue #2: hand-off and dead workers pass but say no report was filed | TR-research | mapped | Live handoff refuses in Unowned; clean dead handoff unreported=true/no kill, dead formatter in Live; unowned/unreported-label |
| tests/teardown.test.ts | 22 unreportedLiveWorker: mid-turn wording, dead and reported workers, failed phase excluded | TR-live | mapped | Mid-turn/idle wording, dead no longer blocks; reported durability and accepted failed head outcomes cover helper exclusions; live-unreported control |
| tests/teardown.test.ts | 23 issue #2: cp_teardown verifies operator_quote before anything runs | TR-quote | mapped | Real registered tool refuses fabricated quote and quote without force, valid quote closes forced; quote control |
| tests/teardown.test.ts | 24 a missing worktree is refused; force is authorization and is recorded | TR-force | mapped | worktree_missing then forced close, no proof reason, forced shutdown event; force control |
| tests/teardown.test.ts | 25 cp-a9fq: a lease treehouse did not return is never reported returned, forced or not; the job stays open | TR-return | mapped | Both forced/gated variants require false return/torn_down and lease_return_failed, held/no close; return-failed control |
| tests/teardown.test.ts | 26 cp-a9fq: after lease_return_failed the lease and job are kept until a re-run teardown's return is confirmed | TR-return | mapped | Failed return then observed-close retry succeeds gated/forced, original closure fields absent before success; return-failed control |
| tests/teardown.test.ts | 27 cp-a9fq: teardown refuses while automatic recovery owns the job, and owns the job while it runs | TR-claim | mapped | Public overlapping teardown claim refuses before second return; first settles and closes; claim control pins shared claim exclusion |
| tests/teardown.test.ts | 28 a job whose events outlived its worker can still be torn down (cp-0wq7) | TR-late | mapped | Actual log reproduces post-exit events, forced success/done and exactly one shutdown marker; both-guard late-events control |
| tests/teardown.test.ts | 29 a normal (gated) teardown is marked closed_reason:gated, never left ambiguous | TR-durable | mapped | Exact gated closed_reason; closed-reason control |
| tests/teardown.test.ts | 30 cp-c1ur N18: teardown names gitignored data the recycled worktree keeps; dependency installs are not named | TR-ignored | mapped | Exact ignored array/formatter, nested path, both dependency exclusions and surviving bytes; four-case unsafe refusal matrix; ignored-preservation/reporting/filter/formatter controls |
| tests/teardown.test.ts | 31 cp-c1ur N18: an unreadable ignored listing is named, never read as nothing | TR-ignored-error | mapped | Exact first-line ignored_error, formatter unknown notice and no private second line; ignored-error control |
| tests/teardown.test.ts | 32 picp-pvo: closing a job withdraws its open human-review row and nothing else | TR-withdraw | mapped | Only same-job human row withdrawn, unrelated and merge reminder unchanged; withdraw control |
| tests/teardown.test.ts | 33 t3code adoption 7: teardown deletes the job's checkpoint ref; a missing one is not a failure | TR-withdraw | mapped | Actual ref deletion and absent-ref successful return; checkpoint control |
| tests/teardown.test.ts | 34 teardown is idempotent and refuses unknown jobs | TR-durable | mapped | Second close no-op tuple and unknown fleet rejection; idempotent control |
| tests/teardown.test.ts | 35 artifacts are removed only when the caller asks | TR-durable | retained | tests/teardown-retained.test.ts verbatim; no public CommandPost constructor exposes removeArtifacts=true. Public default preservation also asserted |
| tests/teardown.test.ts | 36 teardown returns a real lease and observes the worker's close | TR-durable | mapped | Real return, exit_code 0, managed worker dead/removed, done fleet/exit timestamp; worker-close control |
| tests/teardown.test.ts | 37 ship + delivery:local: committed but unpushed is still refused | TR-local | mapped | Dirty/unpublished refuse and held, pushed succeeds with remote branch; dirty/unpushed/publication both deliveries |
| tests/teardown.test.ts | 38 ship + delivery:local: no commits of its own tears down without an origin branch | TR-empty | mapped | Local empty no branch gives nothing_to_push, dirty refuses; PR ancestry pins proof/event/no merge receipt/wording; empty-local/empty-pr/ancestry |
| tests/teardown.test.ts | 39 ship: work on a detached HEAD is refused as unreachable, not as unpushed | TR-detached | mapped | Detached commit even published elsewhere keeps lease with unreachable_work; detached control |
| tests/teardown.test.ts | 40 review opt-in with no verdict at all is refused as review_missing | TR-review | mapped | No verdict refusal/held/no return and cp_review advice; review control |
| tests/teardown.test.ts | 41 a pass verdict on this HEAD lets teardown proceed exactly as today | TR-pass | mapped | Pushed reason unchanged, gated close; pass control |
| tests/teardown.test.ts | 42 picp-d0p: a bound job's gates read review state by job id, not by the PR head branch | TR-bound | mapped | Differing branch/job IDs still apply missing-review refusal then pass; bound/pass controls |
| tests/teardown.test.ts | 43 a truncated subject never clears teardown: not a historical pass, not an approved flag | TR-truncated | mapped | Truncated pass and approved flag refuse; moved head returns pending first; truncated control |
| tests/teardown.test.ts | 44 a flagged escalate needs an approved diff checkpoint, and nothing else clears it | TR-flagged | mapped | Missing/pending checkpoint refuses, approved flag passes; policy remains refused with message; checkpoint/policy controls |
| tests/teardown.test.ts | 45 a verdict on another commit is stale, and a revise is unfinished | TR-review-stale | mapped | HEAD wording and latest attempt refusal, then current latest pass; revise variant independently pins revise; stale/revise controls |
| tests/teardown.test.ts | 46 force bypasses the review gate like every other gate, and says so | TR-review-force | mapped | Missing review then forced pass with no proof reason, forced close/event; force control |
| tests/teardown.test.ts | 47 without the opt-in the review gate is invisible, verdict or no verdict | TR-optout | mapped | none/silent/off all pass with refusing legacy verdict; research ignores opt-in too; optout/research-review controls |
| tests/teardown.test.ts | 48 the gate asks one question of every ship job, whatever the delivery | TR-durable | mapped | Both real PR/local reject unpublished and accept pushed; publication control both |
| tests/teardown.test.ts | 49 teardown populates the fleet record's usage from the run status | TR-pass | mapped | After real exit seed zero fleet usage; exact nonzero observed run usage copied; usage control |
| tests/teardown.test.ts | 50 teardown of an answered Q&A job closes the ledger; a second teardown is a no-op | TR-answer | mapped | Answer reason, closed status, absent ready item, idempotent third call; ledger-reason control |
| tests/teardown.test.ts | 51 teardown of a ship job does not close the ledger | TR-pass | mapped | Ledger remains open after ship teardown; ship-ledger control |
| tests/teardown.test.ts | 52 research ledger close: a failed close is surfaced and retried by the next teardown | TR-pipeline | mapped | Answer permissions/pipeline schema first-line errors, one recovery ID/kind/job, no new lease on retry, correct close reason/formatter/third no-op; ledger-close/reason/retry-notice/error-first-line |
| tests/teardown.test.ts | 53 research ledger close: crash boundary and guards | TR-startup | mapped | Eligible/startup close; unreported/no-envelope/edited/ship stay open; no lease calls/recovery wakes; positive shim probe then reset; report-guard/startup-path |
| tests/teardown.test.ts | 54 research ledger close: a startup sweep whose fleet read throws journals ledger-close-failed:startup and never throws | — | retained | tests/teardown-retained.test.ts verbatim; public reconcile reads FleetStore earlier in fleet.reconcile, so no entry reaches a fleet read failing only inside guarded retryLedgerCloses. Direct tearDown also reads fleet first |
<!-- /manifest:assertions -->

## Executed final-state controls

All 33 S17 and 18 S18 inherited controls applied unchanged; they are the
canonical [S17](s17.md#executed-controls) and
[S18](s18.md#executed-controls) inventories. Each was applied individually,
executed and reversed, then the same selected consumer run passed. No mutation
was committed. Production base stayed #492. Late-events removes BOTH guards.
Usage seeds stale zero fleet usage after actual exit. Startup rows precede
reconcile. Each error below was a consumer assertion, except late-events,
which reproduces the original invalid-projection throw at the consumer call.

Exact runner command for each table row:
`npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/teardown-s<N>.test.ts`.
N=17 for S17 and publication; N=18 for other S18 controls. Patch paths are
`docs/s<N>-controls/<stem>.patch`; publication's patch remains under s18.
Every mutated command exited 1, every restored command exited 0, no matched
case skipped. 58 runs were recorded: 51 inherited controls, the startup PATH control, five declaration-30
controls, and a separate GitLab receipt replay.

Final scoped checks after removal: S17 32/32, S18 14/14, retained 3/3, zero skips; typecheck passes. Measured suite timings were 97,386 / 43,839 / 2,521 ms; retained timing uses the 5,000 ms floor. Ordinary/regression migration and four-shard checks pass. Contract eval scores 22/22 (28 intentionally skipped); golden regeneration produces no content change and its ordinary rerun passes.

Carry-in accounting remains S11b 132 mapped / 12 retained / zero pending, with original 144 intact and no stage-2 credit. S26 remains 32 mapped / 4 retained / 2 pending out of 38 (37 baseline plus same-second regression), three moved paths and zero fully deleted-file credit. Actual child process-start time remains required for its age/same-second controls; parent/pre-spawn/fixture timestamps and fixture termination earn no production shutdown credit. #456 rounding and own/live-drain guards remain outside this change.

| Slice/stem | Exact pattern | Failing consumer assertion |
|---|---|---|
| 17/accepted-head | failed ship teardown | filed report without intake acceptance tuple |
| 17/accepted-receipt | landing evidence (receipt\|rebase)  | both merged success tuples refuse |
| 17/ancestry | empty PR ship proves ancestry | landed_by_git success tuple |
| 17/base-tracking | landing evidence (tree\|stale)  | tree success and stale refusal tuples |
| 17/checkpoint | human review withdrawal | for-each-ref expected empty |
| 17/claim | concurrent teardown | second result expected job_in_flight |
| 17/closed-reason | (pr\|local) teardown preserves | both expected gated |
| 17/detached | detached head | unreachable_work tuple |
| 17/dirty | (pr\|local) teardown preserves | both expected dirty refusal |
| 17/empty-local | empty local ship | nothing_to_push tuple |
| 17/empty-pr | empty PR ship still needs | expected unpushed tuple |
| 17/exit-time | legacy research teardown | exact exited_at |
| 17/force | force closes a missing | forced success tuple |
| 17/generation | failed ship teardown | previous generation tuple |
| 17/head-tracking | landing evidence stale  | expected unpushed tuple |
| 17/idempotent | pr teardown preserves | second no-op tuple |
| 17/ignored-error | unreadable ignored listings | exact ignored_error |
| 17/landing | landing evidence (tree\|squash)  | both success tuples |
| 17/late-events | late worker events | public tearDown throws invalid projection |
| 17/live-unreported | owned unreported worker | expected unreported_live_worker |
| 17/observed-close | live unowned legacy | run observation proves the old worker closed |
| 17/quote | public cp_teardown | tool output expected quote not found |
| 17/receipt-head | landing evidence receipt-extra  | expected unpushed tuple |
| 17/receipt | landing evidence (receipt\|rebase)  | both expected merged |
| 17/research | legacy research teardown | expected research_commits refusal |
| 17/return-failed | failed lease return | both gated/forced false return tuples |
| 17/review | opt-in review | expected review_missing tuple |
| 17/unknown | landing evidence unreadable  | expected landing_unverified tuple |
| 17/unowned | live unowned legacy | expected unmanaged_live_worker tuple |
| 17/unpushed | (pr\|local) teardown preserves | both expected unpushed |
| 17/unreported-label | legacy research teardown | expected unreported=true tuple |
| 17/withdraw | human review withdrawal | expected withdrawn row |
| 17/worker-close | pr teardown preserves | worker.alive expected false |
| 18/bound | teardown review bound$ | expected review_missing tuple |
| 18/checkpoint | teardown review flagged$ | unapproved expected review_escalated |
| 18/force | teardown review force$ | forced success tuple |
| 18/ledger-close | research answer | ledger write failure is visible |
| 18/ledger-reason | research (answer\|pipeline) | both exact close reasons |
| 18/optout | teardown review (none\|silent\|off)$ | all three success tuples |
| 18/pass | teardown review (pass\|bound)$ | both expected pushed success |
| 18/policy | teardown review policy$ | approved policy expected refused |
| 18/publication | S17: (pr\|local) teardown preserves | both expected unpushed |
| 18/report-guard | done research | unreported closed-status assertion |
| 18/revise | teardown review revise$ | expected review_pending |
| 18/ship-ledger | teardown review pass$ | ledger expected not closed |
| 18/stale | teardown review stale$ | expected review_pending |
| 18/truncated | teardown review truncated$ | expected review_escalated |
| 18/usage | teardown review pass$ | exact usage differs from zero fleet record |
| 18/retry-notice | research (answer\|pipeline) | both retry formatter matches |
| 18/error-first-line | research pipeline | doesNotMatch newline |
| 18/research-review | research (answer\|pipeline) | both first.torn_down expected true |
| 18/startup-path | done research | CommandPost lease return must reach the startup shim |
| 17/ignored-preservation | branch-only ignored data | all four cases: data deleted, seeded survivors missing |
| 17/ignored-reporting | successful return reports | ignored array empty instead of backtest/ and nested path |
| 17/ignored-filter | successful return reports | ignored array wrongly includes both node_modules paths |
| 17/ignored-formatter | successful return reports | missing exact ignored entries observed before return text |
| 17/ignored-safe-bytes | successful return reports | returned lease preserves every ignored entry (all four missing) |
| 17/receipt | GitLab squash receipt | merged teardown expected true |

## Retained comparison

TypeScript AST verification collected every bare `test(...)` call in source
order, required original count 54 and retained count 3, then compared each
entire call's source text with strict equality: retained calls 1/2/3 equal
original calls 18/35/54 byte-for-byte. Test names, bodies, comments and timeouts
are unchanged. No substituted mocks were added to public consumer tests.
The retained helper uses the same real scratch git/fleet/run/worker stores and
stub lease runner needed by those original contracts.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/teardown-retained.test.ts | TR | Original declarations 18/35/54 verbatim; three retained cases, missing-entry-point reasons above |
<!-- /manifest:incoming -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| TR | 05 | tests/e2e/teardown-s17.test.ts | Final S17/S18 retirement: 51 mapped, 3 retained verbatim, zero pending; one original path moved to retained subset, zero fully deleted files |
<!-- /manifest:prs -->

<!-- manifest:regressions -->
| ID | Unit file | Bug commit | Scenario | Patch | sha256 | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| TR-ignored | tests/teardown.test.ts |  | TR-ignored | a lease return no longer refuses when branch-only ignored data would be deleted |  | all four unsafe matrix cases lose seeded ignored bytes; restored pass | pass |
<!-- /manifest:regressions -->
