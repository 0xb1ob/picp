# Ledger rows: selfreview-b2

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review B2 (cp-sr-b2-withdraw-ts-61zr) | S1-04 withdrawal timestamps: the existing cp_parent ask case in `tests/e2e/decisions.test.ts` gains a bounded `withdrawn_at` check (raw event equals fold); one real-bridge e2e case added for a legacy untimed journal and a malformed-timestamp refusal; no assertion deleted | 0 |
<!-- /manifest:ledger -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| B2-withdrawn-at | tests/e2e/decisions.test.ts | decisions: cp_parent ask journals open, answer and withdraw append-only; every invalid ask, answer or withdraw is refused before append |
| B2-legacy | tests/e2e/decisions.test.ts | decisions: cp_parent reads a legacy untimed withdrawal as withdrawn at an unknown time and refuses a malformed withdrawal time before append |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| B2-writer | tests/e2e/decisions.test.ts | B2-withdrawn-at | `withdraw` appends without `withdrawn_at` | the journaled withdrawal time matches the ISO pattern: 'undefined' |
| B2-required | tests/e2e/decisions.test.ts | B2-legacy | `withdrawn_at` required on read | the legacy ask's answer is refused as not open: the bridge refuses the whole legacy journal instead |
| B2-malformed | tests/e2e/decisions.test.ts | B2-legacy | `withdrawn_at` accepts any string | a malformed withdrawal time is refused |
<!-- /manifest:regressions -->
