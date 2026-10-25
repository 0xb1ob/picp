# Ledger rows: main-ci

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| cp-e2e-slice-main-ci-41d3 (#416) | 05 | `tests/e2e/landing.test.ts` | main-CI: 39 source declarations, 32 mapped with executed controls, 7 retained (mixed tests narrowed), 0 pending; 05-11/05-4/05-1 extended and 4 scenarios added; docs/testing-migration-main-ci-declarations.md |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 05-main-red | `tests/e2e/landing-ci-watch.test.ts` | landing: main-red integration holds stale heads and permits only a current green fix-forward under its own mandate |
| 05-main-scope | `tests/e2e/landing-ci-watch.test.ts` | landing: main CI scope skips inactive grants and login faults preserve latches until the next successful login |
| 05-main-corrupt | `tests/e2e/landing-ci-watch.test.ts` | landing: main latch writes refuse corruption introduced during an Actions read |
| 05-main-deadlines | `tests/e2e/landing-forge-ci.test.ts` | landing: Actions deadlines stop a hung request and share the budget across pages |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| `tests/actions-ci.test.ts` | retry: never past the budget, and a structurally wrong JSON page is not retried | 05-main-deadlines | mapped | nc-retry-budget: spent retry budget reports the failed request without another attempt; 05-1 pins one structural-error request |
| `tests/actions-ci.test.ts` | budget: one total deadline across pages, each request gets only what remains | 05-main-deadlines | mapped | nc-page-budget: one total deadline bounds runs plus jobs |
| `tests/actions-ci.test.ts` | statusRunner: forwards each request's remaining budget as timeoutMs; a non-zero status throws | 05-main-deadlines | mapped | nc-request-timeout: per-request timeout cancels hung gh; 05-1 pins nonzero status failure |
| `tests/main-ci.test.ts` | #9 unreadable state never overwritten and reported | 05-main-corrupt | mapped | nc-corruption: in-flight latch mutation preserves corrupt bytes; timer names the corrupt file |
| `tests/main-ci.test.ts` | #11 missing clone skipped | 05-main-scope | mapped | nc-missing-clone: missing clone creates no project error |
| `tests/main-ci.test.ts` | #15 main-red hold, ancestry and corrupt state | 05-main-red | mapped | nc-ancestry: cp_integrate.next expected wait, actual review |
| `tests/main-ci.test.ts` | #19 inactive mandate skips even internal login callback | 05-main-scope | retained | verbatim in tests/main-ci-retained.test.ts; timer shares cached login with other watches, so extra main callback invocation has no attributable subprocess effect; ordering probe passes S but fails this unit |
| `tests/main-ci.test.ts` | #20 unreadable login fails open | 05-main-scope | mapped | nc-login-fault: failed login reads no CI |
| `tests/main-ci.test.ts` | #22 memoized login retries/validation | 05-main-scope | mapped | nc-login-validation: invalid login retries, successful login is cached |
| `tests/main-ci.test.ts` | #23 own-row hold only under enforced scope | 05-main-red | mapped | nc-hold-scope: expected no active mandate / not blocking fact |
| `tests/main-ci.test.ts` | #24 scope resolution fails open | 05-main-red | mapped | nc-scope-fault: expected ENOTDIR / not blocking fact |
| `tests/main-ci.test.ts` | #35 retry budget | 05-main-deadlines | mapped | nc-retry-budget: spent retry budget reports the failed request without another attempt; 05-1 asserts structural malformed JSON makes one request |
| `tests/main-ci.test.ts` | #36 cross-page deadline | 05-main-deadlines | mapped | nc-page-budget: one total deadline bounds runs plus jobs |
| `tests/main-ci.test.ts` | #37 runner timeout forwarding | 05-main-deadlines | mapped | nc-request-timeout: per-request timeout cancels hung gh; 05-1 pins nonzero read failures |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Bug commit | Scenario | Patch | sha256 | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-main-corrupt | `tests/main-ci.test.ts` |  | 05-main-corrupt | MainCiStore reads a corrupt file as empty instead of refusing to overwrite it |  | in-flight latch mutation preserves corrupt bytes | pass |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/main-ci-retained.test.ts` | cp-e2e-slice-main-ci-41d3 (#416): 7 internal-only tests; mixed declarations retain only unreachable portions; concrete entry-point limits in docs/testing-migration-main-ci-declarations.md |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/main-ci.test.ts` | deleted | cp-e2e-slice-main-ci-41d3 (#416) | 39 declarations: 32 mapped, 7 retained (mixed tests narrowed) in tests/main-ci-retained.test.ts, 0 pending; per-declaration controls in docs/testing-migration-main-ci-declarations.md; NC-35 and NC-main-corrupt |
<!-- /manifest:baseline -->

