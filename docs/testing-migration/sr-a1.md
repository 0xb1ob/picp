# Ledger rows: sr-a1

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A1 (cp-sr-a1-hold-3uar) | Hold writers and ship admission: `src/authority-hold.ts` (new), `raiseForGate`/`raisePlanApproval`/`replaceHold` in `src/escalation.ts`, the gate and pipeline producers, the shared admission check in `src/dispatch-authority.ts`, `cp_escalate action:replace`; new `tests/e2e/authority-hold.test.ts` (H1–H10, H15, H16); `tests/e2e/authority-decoder-rollout.test.ts` H0 changes its expected producer shape (the policy gate and asking plan approval now carry `authority_hold`; nothing writes `replaces_escalation_id`); `tests/e2e/pipeline-run.test.ts` P11d-reanchor releases the hold through a real parent's operator-quote cp_decide before reanchor; no assertion deleted | 0 |
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
| A1-H9 | tests/e2e/authority-hold.test.ts | H9-H10, H6, H16: a schedule-run ship a real policy gate holds refuses before the schedule return; an uncovered run member keeps its run checks; an unreadable pipeline file refuses its project |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H1 | tests/e2e/authority-hold.test.ts | A1-H1 | `assertNoAuthorityHold` call removed from `assertDispatchAllowed` | ship: the fresh parent's cp_dispatch of the linked ship is accepted |
| NC-H2 | tests/e2e/authority-hold.test.ts | A1-H1 | mandate coverage disabled (`covered = false`: ship links only) | h2: the real parent's cp_dispatch of the fresh covered ship is accepted |
| NC-H3 | tests/e2e/authority-hold.test.ts | A1-H1 | project and coverage checks removed (a global hold) | h3: the real parent's cp_dispatch of the other project's ship is refused |
| NC-H4 | tests/e2e/authority-hold.test.ts | A1-H4 | `releasesHold` always false | the pipeline implementer dispatch is refused after the named override |
| NC-H5 | tests/e2e/authority-hold.test.ts | A1-H1 | `releasesHold` accepts `operator-quote` only | the fresh ship is refused after the delegated approval |
| NC-H6 | tests/e2e/authority-hold.test.ts | A1-H9 | any option releases (`HOLD_RELEASES` check removed) | again: the cp_dispatch after the replan answer is accepted |
| NC-H7 | tests/e2e/authority-hold.test.ts | A1-H1 | a withdrawn record releases | ship: cp_dispatch after withdrawal is accepted |
| NC-H8 | tests/e2e/authority-hold.test.ts | A1-H1 | only open records hold | ship: the restarted parent's cp_dispatch is accepted |
| NC-H9 | tests/e2e/authority-hold.test.ts | A1-H9 | the admission check moved below the schedule-run return | linked: the held run member's cp_dispatch is accepted |
| NC-H10 | tests/e2e/authority-hold.test.ts | A1-H9 | project-only matching (`covered = true`) | other: the uncovered run member's cp_dispatch is refused |
| NC-H15 | tests/e2e/authority-hold.test.ts | A1-H1 | `authority_hold` removed from `EscalationSchema` | bump-x: the policy gate recorded an authority hold |
| NC-H16 | tests/e2e/authority-hold.test.ts | A1-H9 | an unreadable pipeline file is silently dropped again | Missing expected rejection: the ship after the corrupt pipeline file is refused |
<!-- /manifest:regressions -->

## Controls, pinned to the tested A1 sha

Tested A1 sha: the review-1 repair commit on this branch, whose `src/` equals the tree these controls mutated (later
commits touch only docs unless a later row says otherwise). Treehouse was on PATH (`~/.local/bin/treehouse`) for every
evidence run, and every H case ran, none skipped (`ℹ skipped 0`). Each control was one temporary `perl` mutation of a
source file inside a subshell that first ran `cp -p <file> /tmp/a1-nc-<id>.bak` and armed
`trap 'cp -p "$bak" "$file"; rm -f "$bak"' EXIT`; afterwards `diff -r` against a pre-run copy of `src/` was empty.
Command for every row, with that row's scenario as the name pattern: `NODE_OPTIONS=--max-old-space-size=1536 timeout
180 npm run test:one -- --test-name-pattern=<H1-H3|H4|H9-H10> tests/e2e/authority-hold.test.ts`. All 12 controls
exited 1 at the assertion named above, none at the timeout (slowest 158 s); restored, all three cases pass.

- A0's SHA-pinned H0 controls in `sr-a0.md` stay as recorded; A1 changes only H0's expected producer shape (the
  `held` ids), and the decoder assertions are unchanged.
- `cp_pipeline reanchor` is a replan and never releases a hold: P11d-reanchor now answers the superseded research's
  policy escalation through a real pi parent's operator-quote `cp_decide` naming its id before the replacement ships.
