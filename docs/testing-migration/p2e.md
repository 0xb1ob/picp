# Ledger rows: p2e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P2e (cp-e2e-migration-p2e-fmi5) | behavior 02, last slice: a pipeline's mandate-decided plan checkpoint (02-15), cp_mandate and cp_escalate through a real parent (02-16), and in-flight continuation under expired, revoked, serial and capped grants (02-17); the P2d review's three findings. No behavior-02 file remains; send-first-gate belongs to P4. | 1 (`tests/mandate.test.ts`) | 384 → 383 | 4,346 → 4,295 |
<!-- /manifest:ledger -->

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P2e | 02 | `tests/e2e/authority.test.ts` | adds 02-15 to 02-17 |
<!-- /manifest:prs -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/mandate.test.ts` | deleted | P2e | 61 declarations: scenarios 02-1 to 02-17 (Assertion map); eight units retained in `tests/decide.test.ts` (P10); NC-05, NC-06, NC-11, NC-21 to NC-23 |
<!-- /manifest:baseline -->
