# Ledger rows: p2c

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P2c (cp-e2e-migration-p2c-wtsd) | behavior 02, third slice: keyword risk inference (02-7), mandate defaults and the issue ladder (02-8), and the P2b review's two lows (NC-11; 02-5 raises through `cp_mandate raise_tokens`). The other 9 behavior-02 files move to P2d (8) and P2e (`tests/mandate.test.ts`). | 2 (`tests/risk-negation.test.ts`, `tests/mandate-defaults.test.ts`) | 394 → 392 | 4,415 → 4,393 |
<!-- /manifest:ledger -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P2c | 02 | `tests/e2e/authority.test.ts` | adds 02-7 and 02-8 |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/mandate-defaults.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-8 or redundant-unreachable (Assertion map); negative control NC-12 |
| `tests/risk-negation.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-7 (Assertion map); negative control NC-10 |
<!-- /manifest:baseline -->
