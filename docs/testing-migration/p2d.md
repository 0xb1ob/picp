# Ledger rows: p2d

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P2d (cp-e2e-migration-p2d-k5to) | behavior 02, fourth slice: the risk warning (02-9), risk:high pre-approval (02-10), batch risk:high (02-11), grant selection and supplements (02-12), live mandate usage (02-13) and the gateway's capacity and quota (02-14), and the P2c review's two lows. `tests/mandate.test.ts` stays with P2e. | 8 (`tests/capacity.test.ts`, `tests/mandate-selection.test.ts`, `tests/mandate-supplement.test.ts`, `tests/mandate-usage.test.ts`, `tests/quota.test.ts`, `tests/risk-batch.test.ts`, `tests/risk-preapproval.test.ts`, `tests/risk-warning.test.ts`) | 392 → 384 | 4,393 → 4,346 |
<!-- /manifest:ledger -->

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
