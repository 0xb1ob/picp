# Ledger rows: sr-a2

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A2 (cp-sr-a2-parity-n3k7) | Script, promotion, freshness and replacement parity for the A1 hold: `src/authority-hold.ts` (a released hold is stale once its lineage's gate inputs moved past the answered attempt; `latestGateCause` reads the gate files present, no 32 cap), `src/send.ts` (a new ship-task promotion meets the hold before any continuation write, resume, restore, reopen or delivery); new `tests/e2e/authority-hold-parity.test.ts` (H11–H14, H14b replace_work, H14c mechanical handoff plus a released hold whose plan moved to a replacement, attempt > 32); `tests/e2e/authority-hold.test.ts` bench helper `refused` now drives a real parent's `cp_dispatch` instead of in-process `post.dispatch` (same patterns, same no-fleet/no-brief assertions); no assertion deleted | 0 |
<!-- /manifest:ledger -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/authority-hold-parity.test.ts | cp-sr-a2-parity-n3k7 | Self-review A2: held script and ship-task promotion refuse before lease, launch, reopen or message; stale consent after a plan change needs a fresh gate; replacement and recovery research run while the ship hold stays |
<!-- /manifest:incoming -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| A2-H11 | tests/e2e/authority-hold-parity.test.ts | H11-H12: a held script never leases or launches, and a held ship-task promotion never reopens or messages |
| A2-H13 | tests/e2e/authority-hold-parity.test.ts | H13: a plan changed after its answered gate attempt needs a fresh gate for direct and pipeline admission |
| A2-H14 | tests/e2e/authority-hold-parity.test.ts | H14: replace_planner and authorized recovery run eligible research; neither they nor source closure clears the ship hold |
| A2-H14b | tests/e2e/authority-hold-parity.test.ts | H14b: replace_work runs the replacement research of expired admitted work; the ship stays held until a named-id release |
| A2-H14c | tests/e2e/authority-hold-parity.test.ts | H14c: a mechanical cp_gate handoff of a recovered plan keeps the ship hold; a released consent follows the replacement's plan |
| A2-G33 | tests/e2e/authority-hold-parity.test.ts | carried low: an escalated pipeline's latest gate is read past attempt 32, and an unknown cause still fails closed |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H11 | tests/e2e/authority-hold-parity.test.ts | A2-H11 | `assertDispatchAllowed` call in `src/script-dispatch.ts` replaced by `undefined` | script: the held script's cp_dispatch is accepted |
| NC-H12 | tests/e2e/authority-hold-parity.test.ts | A2-H11 | the early promotion check removed from `src/send.ts` and `assertNoAuthorityHold` skipped for `promotion` in `src/dispatch-authority.ts` | promote: the cp_send promotion is delivered to the idle worker |
| NC-H13 | tests/e2e/authority-hold-parity.test.ts | A2-H13 | freshness skipped (`const stale = undefined`) | stale: the ship's cp_dispatch after the plan changed is accepted |
| NC-H14 | tests/e2e/authority-hold-parity.test.ts | A2-H14 | a hold whose source research is closed is skipped | ship: the cp_dispatch after recovery of the closed capped source is accepted |
| NC-H14b | tests/e2e/authority-hold-parity.test.ts | A2-H14b | every hold skipped once a mandate holds a committed `same_work_replacements` link | ship: the cp_dispatch after replace_work is accepted |
| NC-H14c | tests/e2e/authority-hold-parity.test.ts | A2-H14c | a hold skipped for a ship whose dependency points at the hold's lineage head (the handoff retarget) | pipeline-ship: the handed-off ship's cp_dispatch is accepted |
| NC-H14d | tests/e2e/authority-hold-parity.test.ts | A2-H14c | `lineageHead` returns the hold's source, ignoring `gate-replacement.json` | stale: the cp_dispatch after the replacement's plan changed is accepted |
| NC-G33 | tests/e2e/authority-hold-parity.test.ts | A2-G33 | `latestGateCause` reads only attempts ≤ 32 | past-32: the ship whose pipeline stopped operationally at attempt 33 is refused |
| NC-H16 | tests/e2e/authority-hold.test.ts | A1-H9 | the unreadable-pipeline record dropped from `pipelineLinks` | refused: the ship in a project with an unreadable pipeline file is accepted |
<!-- /manifest:regressions -->

## Controls

Treehouse was on PATH (`~/.local/bin/treehouse`) for every evidence run; every case ran, none skipped (`ℹ skipped 0`).
Each control was one temporary `perl -0pi` mutation run by `/tmp/a2-nc.sh`, which first copied each mutated file to
`/tmp/a2-nc-backup-<name>`, armed an `EXIT` trap restoring it, refused a mutation that changed nothing, then ran
`NODE_OPTIONS=--max-old-space-size=1536 timeout 180 npm run test:one -- --test-name-pattern <scenario> <file>`.
All nine controls (re-run after review 1, including the six from the first push) exited 1 at the assertion named
above, well inside the 180 s cap (slowest 54 s); afterwards `git status --porcelain` showed only this branch's edits,
and the restored files pass every case.

- H12's live worker belongs to the real parent that promotes it: one prompt dispatches the ship, a `bash` turn holds
  the parent until the in-process policy gate has recorded the hold, then the script and promotion are dispatched.
- H14b and H14c drive `cp_mandate replace_work`, `cp_gate replace_planner`, `cp_gate handoff`, `cp_escalate replace`
  and `cp_decide` through real parents. The planner runs whose artifact, gate and teardown feed them are dispatched
  in process, as the bench's pipeline producers are, because a worker launched by an exited parent cannot be torn
  down here.
- H14c is the released-hold-plus-replacement case: after the named-id release, the approved plan is the recovered
  replacement's (`gate-replacement.json`), and changing it there makes the consent stale; NC-H14d proves the lineage.
- H13 also pins the pipeline path: `advancePipeline` on the changed plan surfaces the replayed verdict, dispatches
  nothing and records one new hold; overriding that one still leaves the consent stale until a fresh gate binds.
- `tests/e2e/authority-hold.test.ts`: `accepted` stays an in-process `post.dispatch` seam because the bench tears the
  admitted worker down in process right after; a worker launched by an exited parent cannot be torn down there.
