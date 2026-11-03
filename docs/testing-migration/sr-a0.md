# Ledger rows: sr-a0

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A0 (cp-sr-a0-decoder-5f60) | Decoder-only: `src/contracts/escalations.ts` reads the optional `authority_hold` and `replaces_escalation_id`; `tests/contracts.test.ts` gains one legacy/new/malformed case; new `tests/e2e/authority-decoder-rollout.test.ts` adds H0 (real producers write neither field) and H0-decoder (separate-home new-format fixtures decode through a real parent); no assertion deleted | 0 |
<!-- /manifest:ledger -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/authority-decoder-rollout.test.ts | cp-sr-a0-decoder-5f60 | Self-review A0: H0 real-producer writer-off journey on a field-absent journal, and separate-home new-format decoder fixtures through a real parent |
<!-- /manifest:incoming -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| A0-H0 | tests/e2e/authority-decoder-rollout.test.ts | H0: on a field-absent journal, cp_escalate raise/answer/withdraw, a policy gate, a pending plan approval and parent restarts write neither authority field |
| A0-decoder | tests/e2e/authority-decoder-rollout.test.ts | H0-decoder: a separate home's legacy and new-format records decode through a real parent, and an answer keeps the metadata |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H0a | tests/e2e/authority-decoder-rollout.test.ts | A0-H0 | `EscalationStore.raise()` constructor (`src/escalation.ts`) writes a valid `authority_hold` | policy escalation: es-a47cd4 carries authority_hold |
| NC-H0b | tests/e2e/authority-decoder-rollout.test.ts | A0-H0 | `EscalationStore.raise()` constructor (`src/escalation.ts`) writes `replaces_escalation_id` | policy escalation: es-6a2afc carries replaces_escalation_id |
| A0-decoder-drop | tests/e2e/authority-decoder-rollout.test.ts | A0-decoder | `replaces_escalation_id` dropped from `EscalationSchema` | d-fresh: escalations.json violates the escalation contract: /items/2/replaces_escalation_id: schema is false |
<!-- /manifest:regressions -->

## Controls, pinned to the tested A0 sha

Tested A0 sha: `2041721426626e1043c4f5b453000c39bbded291` (production and test change; later commits on the branch touch
only docs, the ledger, the changelog and regenerated files). Each control was a temporary worktree mutation restored by
an `EXIT` trap in the same shell command; `git status --porcelain` was empty afterwards. Command for every row:
`NODE_OPTIONS=--max-old-space-size=1536 timeout 180 npm run test:one -- tests/e2e/authority-decoder-rollout.test.ts`.

- NC-H0a: exit 1; H0 fails at its first absence check after the real policy gate escalation; H0-decoder passes.
- NC-H0b: exit 1; H0 fails at the same check on `replaces_escalation_id`; H0-decoder passes.
- Decoder control (`replaces_escalation_id` removed from the schema): the e2e command exits 1 (H0-decoder's cp_decide
  is refused with the contract error, H0 passes); `npm run test:one -- tests/contracts.test.ts` exits 1 on the new
  legacy/new/malformed case.
- Restored file: exit 0, 2 pass, 0 skipped.
