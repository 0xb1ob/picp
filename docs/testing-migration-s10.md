# S10 declaration evidence

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S10 owns static declarations 81–120 of tests/integrate.test.ts. The original file stays whole. Declarations 121–144 and final retirement belong to the later range. No production edit is shipped. S10 adds six scenarios in tests/e2e/landing.test.ts and extends 05-S02-5, using real CommandPost integration/continuation/dispatch, mock-provider worker/report, scratch git and external gh/git faults. Temporary agent directories come from createAgentDir and are removed by fixture cleanup. The profile-validation fixture copies only product profiles/prompts and links source/extensions from this worktree into a fresh temporary package directory.

Counts: 38 mapped, 1 retained mixed declaration, 1 pending-fix, 0 redundant-unreachable, 0 deleted files, +6 e2e declarations. Retained share: 2.5%. No unit is moved or deleted.

On base `aea915131f8e521d2dc1ae9caf02c82ba1009421`, the checker reports 378 test files and 4,251 static declarations after S10 (4,245 before; +6). Patch SHA columns below identify patch blobs; production mutation source revision is that full base SHA. Pending-fix is kept in a separate canonical ledger because the checker rejects that status inside its parsed assertion section; no checker change or retained relabelling is used.

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
| 92 dirty worktree | pending-fix | 1/dirty passes and dirty control fails no-reset assertion, but unreadable status can destroy dirty content. See pending-fix below. |
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
| 104 isSalvageRef contract | retained | Mixed structural assertions: literal exported prefix/max constants and direct helper booleans. `cp_integrate` accepts a job id, not a raw ref argument, and real git rejects bare namespace/space-containing ref names before listing; it cannot expose those direct boolean inputs/results. Reachable namespace protection maps to 2/outside and ref-scope; reachable bound maps to 2/bound. Keep the mixed declaration unchanged. |
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

Patch paths are `docs/testing-migration-s10-<name>.patch`. SHA is the Git blob SHA of the exact patch (`git hash-object`), not an invented historical bug commit. Patches were generated from the actual temporarily mutated production tree, executed, then restored. Logs are outside the suite at `/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s10-4dzb/<name>-control.log`. These are semantic mutations, not live-model calls. Every listed run exits 1 at the stated consumer assertion; syntax/startup failures earn no credit.

Run with `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='<scenario prefix>' tests/e2e/landing.test.ts`. Use anchored `--test-skip-pattern` to select the table's subcases (skip the other leaf names, never the parent). Apply a patch with `git apply <path>`, run the selected scenario, restore with `git apply -R <path>`. All source edits remain temporary.

| Name | Patch blob SHA | Executed mutation and failure |
|---|---|---|
| dirty | 9d5e0e0451cb63c91c877e13f1cd444583afad1e | Disable dirty guard: 1/dirty reset array nonempty, expected empty. Supplemental evidence only; declaration 92 remains pending-fix. |
| sync-guards | 802c238d3950a66015d0319852aec72b456d2e38 | Reset directly from ls-remote before guards: all thirteen negative 1 subcases fail reset-requires-proof (reset attempted, expected none). |
| sync-reset | a45bdc56823175f0dcd171502c7083bc0bbe0362 | Replace reset with status: behind/stale/absorbed each lack expected reset command. |
| prune | c0234b96b4e605d8951d42866d46f8f1b849d580 | Return generic rescue cleanup fact before pruning: mixed and bound retain extra refs; origin-denied/origin-empty/listing/ancestry/delete/fetch lose named causes; empty emits spurious rescue fact. |
| ref-scope | f7c64fbfcf1aff611bb26d54e7b655d89cd4d5b5 | Remove namespace filter: outside deletes main; preserve-main assertion fails. |
| review-gate | 65ad07a41f0f9d36c44e3524d14c1e13b9951d1b | Bypass review gate: missing/moved/revise/flagged/truncated/moved-flag/fallback each advance instead of review. |
| review-pass | ca2a49082ad19b541a5b289d4a8e22cc349e84e0 | Ignore review passes and flagged authorization: pass/equivalent/approved each review instead of advance. |
| ci-refusal | d7dc1066af71be5a8aee8bd19e2d2d3fa64b4846 | Unreadable Actions result returns advance: all five CI subcases advance instead of retry. |
| missing-gh | cdf35ae0096f2fe508b052bb795d853d184e91e5 | Missing gh retries forever instead of surfacing: missing-gh retry != surface. |
| cleanup-retry | 7acb4bb197e209a1e6e3d8e6c419f79cb3e799ce | Cleanup failures return wait: delete/close wait != retry. |
| rebase | 148512732881fa8938dadc5a707afc9f81fa1290 | Ignore operation markers: rebase advance != surface. |
| retry-notice | 328b9ce1ff38db7a5c549e988741bfcad3dd4d68 | Restore dishonest retry hint: delete/close durable notice contains forbidden nothing-was-mutated claim. |
| reminder-dedupe | 41e4056ff105485cca152ca2734fee6aa8de233b | Give reminders changing identity: S09-2/reminder row count 2 != 1. |
| reminder-withdraw | 8f2a4a4bd01f99f2325fd0cb8af0157db503cbd8 | Omit withdrawal: S09-2/reminder open != withdrawn after merge. |
| conflict-head | 9f8d296406dea3070b16a678d3403133d3112fdb | Carry spent allowance into new conflict head: S09-5/conflict surface != resolve at second head handoff. |
| repair-exhaustion | 622a86e9d33eeeb4ce75b77239258ac91771683b | Reset spent allowance: S09-5/red and conflict resolve != surface after completed repair. |
| prune-safety | d908308f978faa6ef87b3a195af9a40eb464ad69 | Trust a fallback origin SHA, ignore fetch/ancestry failures and remove the bound: mixed/origin-denied/origin-empty/ancestry/fetch/bound each deletes a ref that must remain; actual [] instead of the one expected ref. |
| rescue-target | b3d6430085ada865fde606b7198c3c5faccccc5b | Save the parent of the discarded head: absorbed's actual rescue SHA differs from its captured local SHA. |
| proof-skip | 974635ddafeef5154a5848b1aff21eb7b87f2da4 | Force patch proof for zero-ahead work: behind lacks its expected reset. |
| watch-shape | 121427bd667ae2c2cd9955bb63fa51d065c28c2a | Mislabel both watch refusals sleep_then_poll: 05-S02-5 lacks blocking_watch in the worker conversation; the existing public shape assertion fails. |
| forbid-integrate | cf84e578d5c2e16a5eb6971d7719e99efa9925a7 | Remove cp_integrate from the forbidden list: 6/cp_integrate dispatch is accepted; Missing expected rejection. |
| forbid-merged | cd8b7c15d12bf1e98ff92933f2d72fafffc711d8 | Remove cp_merged from the forbidden list: 6/cp_merged dispatch is accepted; Missing expected rejection. |
| s08-head | 4b78534de0e1638fd7cd0b091bd5d5e18b1937e1 | Trust envelope head and reuse it for permission: 05-S08-4/repository/head attempts one merge, expected zero (false/head). |
| s08-ci | 01dc04249ca154891bac69b2f2915671a76a4230 | Ignore non-green CI: 05-S08-4/repository/ci attempts one merge, expected zero (false/ci). |
| s08-permission | 7eec4315b06443c14d96c63ee7bbf6a6849454e5 | Permit BLOCKED: 05-S08-4/repository/permission attempts one merge, expected zero (false/permission). |

The review-gate patch was also re-executed against approved `truncated-flag` alone; it returns advance instead of review (exit 1, `truncated-flag-control.log`). Its patch SHA remains 65ad07a41f0f9d36c44e3524d14c1e13b9951d1b.

## Carry-ins

S09 declarations 59, 63 and 70 now have separate executed dedupe, withdrawal, completed-exhaustion and new-head controls above. Existing S09-NC-5 remains their active-repair control. S09-2 ready/reminder follow-ups now require exactly one actual merge command. Checker-visible assertion rows for all 41–80 are added to the canonical manifest, preserving the six unreachable/mixed entries.

S08 declaration 2's head, CI and permission rechecks were freshly re-executed independently in S10 with the three s08-* patches above, after the real 31-second review deadline. Each failed the merge-count assertion (one instead of zero); each production edit was restored. Its original hold control and earlier S09 evidence remain in docs/testing-migration-s08.md. No review duration was shortened.

## Pending-fix: declaration 92

The operator explicitly parked the product defect instead of blocking S10. Unreadable `git status --porcelain` (exit 128, empty stdout) currently permits reset and destroys tracked uncommitted content. The exact reproducer and fail/pass causal experiment remain outside the pushed suite at `/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s10-4dzb/report.md` (initial investigation report). Expected result: no reset and original tracked bytes preserved. No failing test is committed, no production fix is shipped, and the unit file must remain whole while this item is pending-fix.
