# Ledger rows: p2c

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
