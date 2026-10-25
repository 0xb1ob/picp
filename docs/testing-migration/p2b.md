# Ledger rows: p2b

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P2b (cp-e2e-migration-p2b-3e1w) | behavior 02, second slice: held-job cap counting and ops jobs (02-5, 02-6) in `tests/e2e/authority.test.ts`. The other 11 behavior-02 files move to P2c (job to be created by the main session). | 1 (`tests/ops-jobs.test.ts`) | 398 → 397 | 4,467 → 4,465 |
<!-- /manifest:ledger -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P2b | 02 | `tests/e2e/authority.test.ts` | adds 02-5 and 02-6 |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/ops-jobs.test.ts` | deleted | P2b | behavior 02: every assertion mapped to 02-6 or redundant-unreachable (Assertion map); negative controls NC-07 to NC-09 |
<!-- /manifest:baseline -->
