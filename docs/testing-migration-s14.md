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
