# Ledger rows: sr-a1

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A1 (cp-sr-a1-hold-3uar) | Hold writers and ship admission: `src/authority-hold.ts` (new), `raiseForGate`/`raisePlanApproval`/`replaceHold` in `src/escalation.ts`, the gate and pipeline producers, the shared admission check in `src/dispatch-authority.ts`, `cp_escalate action:replace`; new `tests/e2e/authority-hold.test.ts` (H1–H10, H15); `tests/e2e/authority-decoder-rollout.test.ts` H0 changes its expected producer shape (the policy gate and asking plan approval now carry `authority_hold`; nothing writes `replaces_escalation_id`); `tests/e2e/pipeline-run.test.ts` P11d-reanchor releases the hold by operator answer before reanchor; no assertion deleted | 0 |
<!-- /manifest:ledger -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/authority-hold.test.ts | cp-sr-a1-hold-3uar | Self-review A1: policy holds through real producers and real pi parents (cp_decide, cp_escalate, cp_dispatch), schedule-run admission, release only by a named operator or delegated answer |
<!-- /manifest:incoming -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| A1-H1 | tests/e2e/authority-hold.test.ts | H1-H3, H5-H8, H15: a withdrawn, torn-down, denied policy hold refuses covered ships across restarts until a delegated named-id approval |
| A1-H4 | tests/e2e/authority-hold.test.ts | H4: the operator's quote naming the live policy hold releases it, and the pipeline still needs its checkpoint |
| A1-H9 | tests/e2e/authority-hold.test.ts | H9-H10, H6: a schedule-run ship the hold links refuses before the schedule return; an uncovered run member keeps its run checks |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H1 | tests/e2e/authority-hold.test.ts | A1-H1 | `assertNoAuthorityHold` call removed from `assertDispatchAllowed` | ship: the fresh parent's cp_dispatch of the linked ship is accepted |
| NC-H2 | tests/e2e/authority-hold.test.ts | A1-H1 | mandate coverage disabled (`covered = false`: ship links only) | Missing expected rejection: the fresh covered ship refused |
| NC-H3 | tests/e2e/authority-hold.test.ts | A1-H1 | project and coverage checks removed (a global hold) | accepted: the other project's ship is refused |
| NC-H4 | tests/e2e/authority-hold.test.ts | A1-H4 | `releasesHold` always false | the pipeline implementer dispatch is refused after the named override |
| NC-H5 | tests/e2e/authority-hold.test.ts | A1-H1 | `releasesHold` accepts `operator-quote` only | accepted: the fresh ship is refused after the delegated approval |
| NC-H6 | tests/e2e/authority-hold.test.ts | A1-H9 | any option releases (`HOLD_RELEASES` check removed) | the second cp_dispatch after the replan answer is accepted |
| NC-H7 | tests/e2e/authority-hold.test.ts | A1-H1 | a withdrawn record releases | ship: cp_dispatch after withdrawal is accepted |
| NC-H8 | tests/e2e/authority-hold.test.ts | A1-H1 | only open records hold | ship: the restarted parent's cp_dispatch is accepted |
| NC-H9 | tests/e2e/authority-hold.test.ts | A1-H9 | the admission check moved below the schedule-run return | the linked run member's cp_dispatch is accepted |
| NC-H10 | tests/e2e/authority-hold.test.ts | A1-H9 | project-only matching (`covered = true`) | the uncovered run member's cp_dispatch is refused |
| NC-H15 | tests/e2e/authority-hold.test.ts | A1-H1 | `authority_hold` removed from `EscalationSchema` | bump-x: the policy gate recorded an authority hold |
<!-- /manifest:regressions -->

## Controls, pinned to the tested A1 sha

Tested A1 sha: `b3b36d1df88e7bde285146dd536a32b6b8c441fa` (production and test change; later commits on the branch touch
only docs, the ledger, the changelog and regenerated files unless a later row says otherwise). Each control was one
temporary `perl` mutation of a committed source file, restored by `git checkout` in the same script; `git status
--porcelain` showed only the uncommitted docs afterwards. Command for every row, with that row's scenario as the name
pattern: `NODE_OPTIONS=--max-old-space-size=1536 timeout 900 npm run test:one -- --test-name-pattern=<H1-H3|H4|H9-H10>
tests/e2e/authority-hold.test.ts`. Every control exited 1 at the assertion named above; restored, all three cases pass.

- A0's SHA-pinned H0 controls in `sr-a0.md` stay as recorded; A1 changes only H0's expected producer shape (the
  `held` ids), and the decoder assertions are unchanged.
- `cp_pipeline reanchor` is a replan and never releases a hold: P11d-reanchor now answers the superseded research's
  policy escalation with an operator override before the replacement ship dispatches.
