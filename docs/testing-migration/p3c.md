# Ledger rows: p3c

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P3c (cp-e2e-migration-p3c-l5fc) | Approved partial delivery (ask-c77a4f32b23b). [Per-file accounting](testing-migration-p3c-declarations.md): 13/143 declarations mapped, 2 retained, 128 pending. Five unfinished files are convert-owned by P3c-rest for follow-on slices. | 2 files deleted (ci-evidence, parked-ci); 8 declarations removed; timer rename earns zero deletion credit | 379 + 1 incoming → 378 | 4,272 + 4 incoming → 4,274 |
<!-- /manifest:ledger -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P3c | 05 | `tests/e2e/landing.test.ts` | partial delivery: 05-8–05-13 provide consumer coverage; ci-evidence and parked-ci retired; five unfinished files continue under P3c-rest |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/ci-evidence.test.ts` | deleted | P3c | all five declarations mapped to real tool and viewer consumers in 05-9; NC-33 and NC-43–NC-48 record failing assertions; no units moved or retained |
| `tests/parked-ci.test.ts` | deleted | P3c | behavior 05; all three declarations mapped to 05-12, NC-36 and NC-49–NC-55; no moved or retained units |
<!-- /manifest:baseline -->
