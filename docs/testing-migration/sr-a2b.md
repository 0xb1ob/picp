# Ledger rows: sr-a2b

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A2b (cp-sr-a2b-replay-release-angu) | A released hold survives pipeline replay and `cp_decide` refuses off-menu answers on holds: `src/escalation.ts` (`holdReleasedFor` beside `gateOverride`; the hold-record off-menu refusal in `EscalationStore.answer`), `src/pipeline.ts` (the replay branch consults `holdReleasedFor` alongside `gateOverride`); `tests/e2e/authority-hold-parity.test.ts` gains H17 and H18 and a `releasedByReplacement` helper; no assertion changed or deleted | 0 |
<!-- /manifest:ledger -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| A2b-H17 | tests/e2e/authority-hold-parity.test.ts | H17: a replay of the unchanged gate attempt respects a replacement's release; a changed plan still needs cp_gate |
| A2b-H18 | tests/e2e/authority-hold-parity.test.ts | H18: cp_decide refuses an off-menu answer on a hold and writes nothing; approve then releases; a non-hold record keeps free answers |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H17 | tests/e2e/authority-hold-parity.test.ts | A2b-H17 | `holdReleasedFor` always returns undefined | H17: the released replay proceeds (the replay re-raised the policy verdict) |
| NC-H18 | tests/e2e/authority-hold-parity.test.ts | A2b-H18 | the hold-record off-menu refusal in `EscalationStore.answer` disabled (`if (false && …)`) | H18: the replacement stays open and unanswered |
<!-- /manifest:regressions -->

## Controls

Treehouse was on PATH for every evidence run; every case ran, none skipped (`ℹ skipped 0`). Each control was one
temporary `sed -i` mutation of `src/escalation.ts` in one command: `cp src/escalation.ts /tmp/a2b-esc.bak`, then a
subshell with `trap 'cp /tmp/a2b-esc.bak src/escalation.ts' EXIT`, the `sed -i`, `git diff --shortstat` confirming a
one-line change, and the run below; afterwards `git status --porcelain` was empty.

- NC-H17: `sed -i 's/^\tif (!kind || verdict.cause !== "policy") return undefined;$/\treturn undefined;/'`, then
  `NODE_OPTIONS=--max-old-space-size=1536 timeout 180 npm run test:one -- --test-name-pattern=H17 tests/e2e/authority-hold-parity.test.ts`:
  exit 1, `AssertionError: H17: the released replay proceeds: … (cause policy). This is yours now.` Restored: pass.
- NC-H18: `sed -i 's/if (!retry && existing.authority_hold && !planRevise/if (false \&\& existing.authority_hold \&\& !planRevise/'`,
  then `NODE_OPTIONS=--max-old-space-size=1536 timeout 180 npm run test:one -- --test-name-pattern=H18 tests/e2e/authority-hold-parity.test.ts`:
  exit 1, `AssertionError: H18: the replacement stays open and unanswered`. Restored: pass.

- H17 runs two pipelines on one bench: the unchanged replay (no new escalation, the covered ship dispatches through a
  real parent's `cp_dispatch`), then the variant whose artifact changes a second after the answer (timestamps have
  second resolution): the replay surfaces `cp_gate`, the covered and pipeline ships stay refused and nothing is leased.
- H18's control is inline: an in-process `product_ambiguity` record without a hold accepts the free answer
  `use the blue copy` through the same real `cp_decide`.
