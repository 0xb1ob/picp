# Ledger rows: p2d

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P2d | 02 | `tests/e2e/authority.test.ts` | adds 02-9 to 02-14 |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/capacity.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-14 or redundant-unreachable (Assertion map); negative control NC-19 |
| `tests/mandate-selection.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-16 |
| `tests/mandate-supplement.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-17 |
| `tests/mandate-usage.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-13 or redundant-unreachable (Assertion map); one source scan kept in `tests/structure.test.ts`; negative control NC-18 |
| `tests/quota.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-14 (Assertion map); negative control NC-20 |
| `tests/risk-batch.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-11 or redundant-unreachable (Assertion map); negative control NC-15 |
| `tests/risk-preapproval.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-10 or redundant-unreachable (Assertion map); negative control NC-14 |
| `tests/risk-warning.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-9 (Assertion map); negative control NC-13 |
<!-- /manifest:baseline -->
