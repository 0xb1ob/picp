# S14 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S14 owns the whole files merge-permission, pr-bind, pr-resolve and review-approval (33 declarations). Other slices own all other behavior-05 declarations. Original files stay whole until their final disposition is proved.

## Batch 1

Scenario 05-S14-permission: `tests/e2e/landing.test.ts`, `landing S14: repository permission reports the allowlist and each blocked cause`. Real CommandPost, real reporter/implementer, isolated mock-provider agent directory, real scratch git, scripted external gh. Each permission row has its own stack and real held report; success rows execute a forge merge.

| Source declaration in tests/merge-permission.test.ts | Status | Failing assertion under control |
|---|---|---|
| 1 CLEAN and HAS_HOOKS | mapped | S14-NC1: both named subcases fail /permission: permitted/ |
| 2 BLOCKED required review | mapped | S14-NC1: REVIEW_REQUIRED fails /pending (reviews).*1 approving review/ |
| 3 CHANGES_REQUESTED | mapped | S14-NC1: CHANGES_REQUESTED fails /pending (reviews)/ |
| 4 required checks | mapped | S14-NC1: required-check row fails /pending (checks).*test/ |
| 5 unreadable rules | mapped | S14-NC1: BLOCKED without rules fails /pending (unknown_block).*cannot read why/ |
| 6 BEHIND, DIRTY, DRAFT | pending | consumer gates need further assertions and controls |
| 7 UNSTABLE | mapped | S14-NC1: UNSTABLE fails /pending (unstable).*403/ |
| 8 UNKNOWN | mapped | S14-NC1 fails UNKNOWN status /permission: retry/; S14-NC2 fails CLEAN with UNKNOWN mergeability, actually merges |
| 9 absent/empty/new status | mapped | S14-NC2: all three subcases fail /permission: unreadable/ |
| 10 parser | pending | rules payload variants need further assertions and controls |
| 11 strict up-to-date rule | pending | existing stale-base scenario needs mapping/control verification |
| 12 endpoint args | pending | structural assertion disposition unresolved |
| 13 blocking wait shape | pending | structural assertion disposition unresolved |

Other files: pr-bind 9 pending; pr-resolve 10 pending; review-approval 1 pending. Total: 8 mapped, 0 retained, 25 pending; no deleted files.

## Executed controls

Command for both: `node --import ./tests/harness/hermetic-env.ts --test --test-concurrency=1 --test-timeout=300000 --test-force-exit --test-name-pattern='landing S14:' tests/e2e/landing.test.ts`.

- S14-NC1: in `src/merge-permission.ts`, replace status normalization with `const status = "BROKEN";`. Executed: eight independently named subcases fail their permission/cause assertions (review required, changes requested, checks, unknown block, unstable, unknown status, HAS_HOOKS, CLEAN). Four unaffected subcases pass. This models losing the forge merge-state field. Production source restored.
- S14-NC2: in the same source, remove `|| mergeable === "UNKNOWN"` from the retry guard and change the final fallback permission from `unreadable` to `pending`. Executed: CLEAN/UNKNOWN fails retry assertion with an actual merge; absent, empty and novel states each fail unreadable assertion, actually pending. Eight unaffected subcases pass. Both production changes restored.
- Earlier exploratory control removed both values from REVIEW_BLOCKING; REVIEW_REQUIRED failed the reviews/counted-review assertion. Not used for additional declaration credit.

All controls failed observable assertions after real workers reported; none failed fixture startup. Fixed run and further batches are recorded below as work proceeds.

## Batch 2

Scenario 05-S14-resolution: `landing S14: worker PR reports resolve against the registered origin and drive the CI watch` in `tests/e2e/landing.test.ts`. Real worker report_result calls are resolved by the real CommandPost intake; corrected receipts feed a real CI-watch tick. The external git shim preserves GitHub origin identity while routing repository transport to scratch git.

| Source | Declaration | Status | Control and failing assertion |
|---|---|---|---|
| tests/pr-resolve.test.ts | 1 typo owner corrected and named | mapped | S14-NC3 corrected: stored receipt URL is typo/demo, expected example/demo |
| tests/pr-resolve.test.ts | 2 missing PR refuses | mapped | S14-NC3 absent: expected correction reason /no PR is on branch.*example\/demo/, actual empty |
| tests/pr-resolve.test.ts | 3 gh down with mismatched owner refuses | mapped | S14-NC3 mismatch-down: expected correction /typo\/demo.*example\/demo/, actual empty |
| tests/pr-resolve.test.ts | 4 matching owner unverified | mapped | S14-NC3 matching-down: unverified run event count actual 0, expected 1 |
| tests/pr-resolve.test.ts | 5 watch uses corrected receipt | mapped | S14-NC3 corrected: the receipt consumed by the watch is wrong; fixed case also asserts repos/example/demo/pulls/151 and zero typo repository reads |
| tests/pr-bind.test.ts | 5 absent local checkout | mapped | S14-NC4 absent: leased HEAD differs from PR c2 |
| tests/pr-bind.test.ts | 6 behind checkout | mapped | S14-NC4 behind: leased HEAD differs from PR c2 |
| tests/pr-bind.test.ts | 7 diverged checkout preserves history | mapped | S14-NC5 diverged: salvage ref object id is empty, expected local commit |
| tests/pr-bind.test.ts | 8 occupied worktree refuses | mapped | S14-NC4 other-worktree: Missing expected rejection |
| tests/pr-bind.test.ts | 9 moved PR head refuses | mapped | S14-NC4 moved: Missing expected rejection |

Checkout scenario 05-S14-bind: `landing S14: binding an existing PR checks forge facts and preserves checkout history`. Consumer is real dispatch, actual leased git checkout, real bound worker report, and the model request containing the bound brief. Originals remain whole. Totals after batch 2: 18 mapped, 0 retained, 15 pending, 0 deleted files.

Executed controls (same node invocation as above, name pattern respectively `landing S14: worker PR` and `landing S14: binding`):

- S14-NC3, `src/pr-resolve.ts`: disable owner-mismatch fallback refusal; return verified instead of unverified for matching fallback; accept the worker URL when no PR exists; use `given ?? row.url` in the successful list resolution. All four independently named resolution subcases failed the assertions above. Restored all four mutations.
- S14-NC4, `src/pr-bind.ts`: early `return {};` in checkoutBoundBranch. Executed after placing actual-checkout assertions before report-settle waits. Absent, behind and diverged fail HEAD=c2; occupied and moved fail expected rejection. This is consumer evidence, not a fixture timeout. Restored.
- S14-NC5, `src/pr-bind.ts`: delete only the salvage `update-ref` command. Diverged fails salvage object-id equality, with four unaffected checkout cases passing. Restored.

Fixed resolution and checkout cases passed before mutations; final fixed rerun follows each checkpoint. No unit removal credit yet.
