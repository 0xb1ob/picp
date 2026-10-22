# Ledger rows: p3b

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
