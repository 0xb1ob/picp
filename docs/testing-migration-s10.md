# S10 declaration evidence

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S10 owns static declarations 81–120 of tests/integrate.test.ts. The original file stays whole. Declarations 121–144 and final retirement belong to the later range. No production edit is shipped. S10 adds six scenarios in tests/e2e/landing-merge.test.ts and extends 05-S02-5, using real CommandPost integration/continuation/dispatch, mock-provider worker/report, scratch git and external gh/git faults. Temporary agent directories come from createAgentDir and are removed by fixture cleanup. The profile-validation fixture copies only product profiles/prompts and links source/extensions from this worktree into a fresh temporary package directory.

Current range counts after S10b: 39 mapped, 1 retained mixed declaration, 0 pending, 0 redundant-unreachable, 0 deleted files, +6 e2e declarations. Retained share: 2.5%. No integrate unit is moved or deleted.

On its base, the checker reports 378 test files and 4,251 static declarations after S10 (4,245 before; +6). Pending-fix is kept in a separate canonical ledger because the checker rejects that status inside its parsed assertion section; no checker change or retained relabelling is used.

## Scenarios

| ID | Exact title after `landing S10: ` |
|---|---|
| 05-S10-1 | synchronization preserves local work and proves origin before resetting |
| 05-S10-2 | rescue retention proves reachability and bounds cleanup |
| 05-S10-3 | review evidence authorizes only the reviewed complete head |
| 05-S10-4 | unreadable forge and Actions evidence names the cause and makes no mutation |
| 05-S10-5 | cleanup failures preserve landed effects and resume |
| 05-S10-6 | dispatch rejects profiles granting parent integration tools |

Declaration 110 extends existing 05-S02-5 (`landing S02: watcher queries stay nonblocking while workers refuse CI waits`) with the second watch command and requires both tool replies to expose blocking_watch. The token is public in ciWaitRefusal, so this declaration is mapped rather than retained.

## Declaration map

The source-order numbers below count static test calls, not loop expansions. Every mapped row cites an executed control and its failing assertion; additional positive assertions are not independent mutation claims.

| Declaration | Disposition | Scenario / failing assertion under production mutation |
|---|---|---|
| 81 rate-limited Actions | mapped | 4/rate, ci-refusal: advance != retry. |
| 82 permission advice | mapped | 4/permission, ci-refusal: advance != retry; positive text names Actions read. |
| 83 denied/partial/malformed jobs | mapped | 4/jobs-denied, jobs-partial, jobs-malformed, ci-refusal: each advance != retry. |
| 84 absent gh | mapped | 4/missing-gh, missing-gh: retry != surface. |
| 85 resync behind origin | mapped | 1/behind, sync-reset: no reset != reset to observed SHA. |
| 86 authoritative reset SHA | mapped | 1/behind, sync-reset: no reset != reset to observed SHA. |
| 87 absent tracking ref | mapped | 1/stale, sync-reset: no reset != reset to observed SHA, despite deliberately removed tracking ref. |
| 88 unreachable branch origin | mapped | 1/branch-denied, sync-guards: unchecked reset != no reset. |
| 89 absent branch ref | mapped | 1/branch-empty, sync-guards: unchecked reset != no reset. |
| 90 unpushed unique work | mapped | 1/unpushed, sync-guards: reset != no reset. |
| 91 unreadable divergence | mapped | 1/divergence, sync-guards: reset != no reset. |
| 92 dirty worktree | mapped by S10b | Dirty and unreadable-status public cases preserve content and refuse reset; [canonical mapping and executed status control](testing-migration/s10b.md). |
| 93 absorbed pre-rebase content | mapped | 1/absorbed, sync-reset: no reset != reset to observed SHA; rescue-target: actual rescue SHA differs from discarded local SHA. Positive case requires rescue creation before reset and proof detail. |
| 94 dangerous inverse | mapped | 1/unpushed, sync-guards: reset != no reset. |
| 95 proof refusals | mapped | 1/base-denied, base-empty, merge-base, diff, patch-id, empty-id, empty-diff, salvage, sync-guards: each reset != no reset. Positive checks pin each specific cause. |
| 96 zero ahead avoids proof | mapped | 1/behind, proof-skip: forcing proof prevents the expected reset. Positive case requires no patch-id/rescue creation. |
| 97 reachable prune/unreachable keep | mapped | 2/mixed, prune: reachable ref remains unexpectedly; prune-safety: orphan is deleted, actual [] instead of [/999]. |
| 98 unreadable origin keeps refs | mapped | 2/origin-denied, prune-safety: actual [] instead of retained /001; prune also removes the origin-did-not-name-tip reason. |
| 99 missing tip/list/ancestry/delete refusal | mapped | 2/origin-empty and ancestry, prune-safety: actual [] instead of retained /001; listing and delete, prune: each loses its specific operator cause. |
| 100 unfetchable base | mapped | 2/fetch, prune-safety: actual [] instead of retained /001; prune also removes the could-not-be-fetched cause. |
| 101 sorted bound | mapped | 2/bound, prune-safety: actual [] instead of retained /101; prune: 101 refs remain instead of only /101. |
| 102 namespace boundary | mapped | 2/outside, ref-scope: cleanup must preserve main assertion fails, exit 128 instead of 0. |
| 103 empty namespace | mapped | 2/empty, prune: unexpected rescue-ref fact. |
| 104 isSalvageRef contract | retained | Unit-only assertions are the literal prefix/max constants and helper results for git-invalid refs: trailing-slash refs/cp-salvage/, refs/cp-salvage/../heads/main and space-containing names. Valid outside-namespace refs map to 2/outside and ref-scope; the pruning bound maps to 2/bound. [S10b's canonical rationale](testing-migration/s10b.md) supersedes the broader helper-input rationale. Keep the mixed declaration for S11. |
| 105 unfinished rebase | mapped | 5/rebase, rebase: advance != surface. |
| 106 refused branch deletion | mapped | 5/delete, cleanup-retry: wait != retry. Positive case preserves receipt, landed-effect notice, then resumes without another merge. |
| 107 refused ledger close | mapped | 5/close, cleanup-retry: wait != retry. Positive case corrupts on-disk ledger after actual branch deletion, restores it and resumes. |
| 108 retry notice honesty | mapped | 5/delete and close, retry-notice: durable notice unexpectedly contains nothing-was-mutated. |
| 109 parent-only tool list | mapped | 6/cp_integrate and cp_merged: real dispatch rejects package profiles granting either tool before fleet allocation. Separate forbid-integrate and forbid-merged controls each accept dispatch instead of the required parent-only rejection. |
| 110 blocking-watch recognizer | mapped | 05-S02-5 now drives both gh run watch and gh pr checks --watch through real worker bash and requires two blocking_watch tool replies. watch-shape: replacing the public shape token removes blocking_watch from the worker's messages. |
| 111 unreviewed head | mapped | 3/missing, review-gate: advance != review. |
| 112 passing review | mapped | 3/pass, review-pass: review != advance. |
| 113 patch equivalence | mapped | 3/equivalent, review-pass: review != advance (only equivalence file exists). |
| 114 moved reviewed head | mapped | 3/moved, review-gate: advance != review. |
| 115 revise | mapped | 3/revise, review-gate: advance != review. |
| 116 unapproved flagged verdict | mapped | 3/flagged, review-gate: advance != review. |
| 117 approved flagged verdict | mapped | 3/approved, review-pass: review != advance. |
| 118 truncated historical verdict | mapped | 3/truncated and truncated-flag (approved flagged verdict), review-gate: each advance != review. |
| 119 moved flagged approval | mapped | 3/moved-flag, review-gate: advance != review. |
| 120 fallback needs review | mapped | 3/fallback, review-gate: advance != review despite approved merge checkpoint. |

## Executed production controls

Patch paths are `docs/testing-migration-s10-<name>.patch`. Patches were generated from the actual temporarily mutated production tree, executed, then restored. These are semantic mutations, not live-model calls. Every listed run exits 1 at the stated consumer assertion; syntax/startup failures earn no credit.

Run with `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='<scenario prefix>' tests/e2e/landing-*.test.ts`. Use anchored `--test-skip-pattern` to select the table's subcases (skip the other leaf names, never the parent). Apply a patch with `git apply <path>`, run the selected scenario, restore with `git apply -R <path>`. All source edits remain temporary.

| Name | Executed mutation and failure |
|---|---|
| dirty | Disable dirty guard: 1/dirty reset array nonempty, expected empty. S10b adds the unreadable-status control and resolves declaration 92's mapping. |
| sync-guards | Reset directly from ls-remote before guards: all thirteen negative 1 subcases fail reset-requires-proof (reset attempted, expected none). |
| sync-reset | Replace reset with status: behind/stale/absorbed each lack expected reset command. |
| prune | Return generic rescue cleanup fact before pruning: mixed and bound retain extra refs; origin-denied/origin-empty/listing/ancestry/delete/fetch lose named causes; empty emits spurious rescue fact. |
| ref-scope | Remove namespace filter: outside deletes main; preserve-main assertion fails. |
| review-gate | Bypass review gate: missing/moved/revise/flagged/truncated/moved-flag/fallback each advance instead of review. |
| review-pass | Ignore review passes and flagged authorization: pass/equivalent/approved each review instead of advance. |
| ci-refusal | Unreadable Actions result returns advance: all five CI subcases advance instead of retry. |
| missing-gh | Missing gh retries forever instead of surfacing: missing-gh retry != surface. |
| cleanup-retry | Cleanup failures return wait: delete/close wait != retry. |
| rebase | Ignore operation markers: rebase advance != surface. |
| retry-notice | Restore dishonest retry hint: delete/close durable notice contains forbidden nothing-was-mutated claim. |
| reminder-dedupe | Give reminders changing identity: S09-2/reminder row count 2 != 1. |
| reminder-withdraw | Omit withdrawal: S09-2/reminder open != withdrawn after merge. |
| conflict-head | Carry spent allowance into new conflict head: S09-5/conflict surface != resolve at second head handoff. |
| repair-exhaustion | Reset spent allowance: S09-5/red and conflict resolve != surface after completed repair. |
| prune-safety | Trust a fallback origin SHA, ignore fetch/ancestry failures and remove the bound: mixed/origin-denied/origin-empty/ancestry/fetch/bound each deletes a ref that must remain; actual [] instead of the one expected ref. |
| rescue-target | Save the parent of the discarded head: absorbed's actual rescue SHA differs from its captured local SHA. |
| proof-skip | Force patch proof for zero-ahead work: behind lacks its expected reset. |
| watch-shape | Mislabel both watch refusals sleep_then_poll: 05-S02-5 lacks blocking_watch in the worker conversation; the existing public shape assertion fails. |
| forbid-integrate | Remove cp_integrate from the forbidden list: 6/cp_integrate dispatch is accepted; Missing expected rejection. |
| forbid-merged | Remove cp_merged from the forbidden list: 6/cp_merged dispatch is accepted; Missing expected rejection. |
| s08-head | Trust envelope head and reuse it for permission: 05-S08-4/repository/head attempts one merge, expected zero (false/head). |
| s08-ci | Ignore non-green CI: 05-S08-4/repository/ci attempts one merge, expected zero (false/ci). |
| s08-permission | Permit BLOCKED: 05-S08-4/repository/permission attempts one merge, expected zero (false/permission). |

The review-gate patch was also re-executed against approved `truncated-flag` alone; it returns advance instead of review (exit 1).

## Carry-ins

S09 declarations 59, 63 and 70 now have separate executed dedupe, withdrawal, completed-exhaustion and new-head controls above. Existing S09-NC-5 remains their active-repair control. S09-2 ready/reminder follow-ups now require exactly one actual merge command. Checker-visible assertion rows for all 41–80 are added to the canonical manifest, preserving the six unreachable/mixed entries.

S08 declaration 2's head, CI and permission rechecks were freshly re-executed independently in S10 with the three s08-* patches above, after the real 31-second review deadline. Each failed the merge-count assertion (one instead of zero); each production edit was restored. Its original hold control and earlier S09 evidence remain in docs/testing-migration-s08.md. No review duration was shortened.

## Declaration 92: historical pending-fix, resolved in S10b

S10 parked the unreadable-status defect: exit 128 with empty stdout could permit a reset and destroy
uncommitted content. The saved reproducer remains in that slice's investigation report. The fix is now
on main. S10b maps the dirty and unreadable-status outcomes and executes the guard-removal control;
[its canonical mapping](testing-migration/s10b.md) supersedes the pending status above.
The integrate unit file remains whole for S11's remaining declarations.
