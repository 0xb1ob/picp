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
temporary `sed -i` mutation of `src/escalation.ts`: the file was first copied to `/tmp/a2b-esc.bak` and restored by an
`EXIT` trap in the same subshell, a grep confirmed the mutation applied, then
`NODE_OPTIONS=--max-old-space-size=1536 npm run test:one -- --test-name-pattern=<H17|H18> tests/e2e/authority-hold-parity.test.ts`
ran. GNU `timeout` does not exist on this host, so the `timeout 180` wrapper was dropped; both controls finished in
about 34 s. Both exited 1 at the assertion named above; afterwards `git diff --stat` showed only this branch's edits,
and the restored file passes every case.

- H17 runs two pipelines on one bench: the unchanged replay (no new escalation, the covered ship dispatches through a
  real parent's `cp_dispatch`), then the variant whose artifact changes a second after the answer (timestamps have
  second resolution): the replay surfaces `cp_gate`, the covered and pipeline ships stay refused and nothing is leased.
- H18's control is inline: an in-process `product_ambiguity` record without a hold accepts the free answer
  `use the blue copy` through the same real `cp_decide`.
