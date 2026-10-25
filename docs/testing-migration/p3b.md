# Ledger rows: p3b

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P3b (cp-e2e-migration-p3b-stth) | behavior 05, second slice: merge receipts and landing proof in `tests/e2e/landing.test.ts`: cp_merged through `gh` with the after-merge deploy job (05-5), cp_merged against a local https GitLab (05-6), and cp_teardown's git-only landing proof (05-7). The other 23 behavior-05 files stay `convert` (owner P3), for P3c (a job the main session cuts). | 3 (`tests/after-merge.test.ts`, `tests/landing-proof.test.ts`, `tests/merges.test.ts`) | 382 → 379 | 4,287 → 4,272 |
<!-- /manifest:ledger -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P3b | 05 | `tests/e2e/landing.test.ts` | adds 05-5 to 05-7 |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/after-merge.test.ts` | deleted | P3b | 5 declarations: 05-5 and S06-2; ledger-refusal regression now public-entry coverage; NC-31 and S06-deploy |
| `tests/landing-proof.test.ts` | deleted | P3b | 7 declarations: scenario 05-7 (Assertion map); three units retained in `tests/forge-runtime-retained.test.ts` (relocated S06); NC-30 |
| `tests/merges.test.ts` | deleted | P3b | 12 declarations: 05-5, 05-6 and S06-2; one receipt guard retained in tests/forge-observers-retained.test.ts; NC-28, NC-29, S06-deploy |
<!-- /manifest:baseline -->
