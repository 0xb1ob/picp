# Ledger rows: selfreview-b1

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review B1 (cp-sr-b1-digests-on92) | S1-03/E1 changed-only parent digests: one real-RPC e2e case added to `tests/e2e/parent-compaction.test.ts`; `tests/parent-context-retained.test.ts` counts moved from whole-set to per-type with partial-failure assertions added and none deleted; two S25-guidance counts in `tests/e2e/parent-context-s25.test.ts` updated to the per-type contract | 0 |
<!-- /manifest:ledger -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| B1-digests | tests/e2e/parent-compaction.test.ts | B1 parent: resumes send only changed digests and a successful compaction restores the full set without a turn |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| B1-whole-set | tests/e2e/parent-compaction.test.ts | B1-digests | the base's whole-set emission (`digestsInContext` plus one aggregate reservation) restored | memory-only change sends memory alone: guidance, orders and recent work 2 != 1 |
| B1-epoch | tests/parent-context-retained.test.ts | B1-digests | `session_compact` no longer advances the reservation epoch | e2e: a successful compaction sends the complete set once (cp-recent-work 0 != 1); retained: a successful compaction opens a fresh epoch |
<!-- /manifest:regressions -->

The send-throw and same-tick cases stay in `tests/parent-context-retained.test.ts` (S25 retained row 10): no public RPC
makes `pi.sendMessage` throw synchronously or hides a just-queued digest from the branch. Control B1-retry, a failed
type kept reserved after its send throws, fails that file's "a failed send releases its reservation, so the retry goes
out". Stale rows disclosed, not edited: s25.md assertion row 10 still says "Verbatim" for that retained declaration,
which now asserts per-type counts and gains partial-failure assertions; s25.md assertion row 9 still says "pair".
