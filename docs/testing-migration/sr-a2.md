# Ledger rows: sr-a2

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review A2 (cp-sr-a2-parity-n3k7) | Script, promotion, freshness and replacement parity for the A1 hold: `src/authority-hold.ts` (a released hold is stale once its lineage's gate inputs moved past the answered attempt; `latestGateCause` reads the gate files present, no 32 cap), `src/send.ts` (a new ship-task promotion meets the hold before any continuation write, resume, restore, reopen or delivery); new `tests/e2e/authority-hold-parity.test.ts` (H11–H14, attempt > 32); `tests/e2e/authority-hold.test.ts` bench helper `refused` now drives a real parent's `cp_dispatch` instead of in-process `post.dispatch` (same patterns, same no-fleet/no-brief assertions); no assertion deleted | 0 |
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
| A2-G33 | tests/e2e/authority-hold-parity.test.ts | carried low: an escalated pipeline's latest gate is read past attempt 32, and an unknown cause still fails closed |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-H11 | tests/e2e/authority-hold-parity.test.ts | A2-H11 | `assertDispatchAllowed` call removed from `src/script-dispatch.ts` | script: the held script's cp_dispatch is accepted (lease taken, process launched) |
| NC-H12 | tests/e2e/authority-hold-parity.test.ts | A2-H11 | the early promotion check removed from `src/send.ts` and `assertNoAuthorityHold` skipped for `promotion` in `assertDispatchAllowed` | promote: the cp_send promotion is delivered to the idle worker |
| NC-H13 | tests/e2e/authority-hold-parity.test.ts | A2-H13 | freshness skipped (`const stale = undefined`) | stale: the ship's cp_dispatch after the plan changed is accepted |
| NC-H14 | tests/e2e/authority-hold-parity.test.ts | A2-H14 | a hold whose source research is closed is skipped | ship: the cp_dispatch after recovery of the closed capped source is accepted |
| NC-G33 | tests/e2e/authority-hold-parity.test.ts | A2-G33 | `latestGateCause` scans attempts 32→1 again | past-32: the ship whose pipeline stopped operationally at attempt 33 is refused |
<!-- /manifest:regressions -->

## Controls

Treehouse was on PATH (`~/.local/bin/treehouse`) for every evidence run; every case ran, none skipped (`ℹ skipped 0`).
Each control was one temporary `perl -0pi` mutation run by `/tmp/a2-nc.sh`, which first copied each mutated file to
`/tmp/a2-nc-backup-<name>`, armed an `EXIT` trap restoring it, refused a mutation that changed nothing, then ran
`NODE_OPTIONS=--max-old-space-size=1536 node --import ./tests/harness/hermetic-env.ts --test --test-force-exit
--test-name-pattern <scenario> tests/e2e/authority-hold-parity.test.ts`. The worker contract for this job forbids the
`timeout` command, so the runs relied on each test's own timeout; none was reached (slowest 54 s). All five controls
exited 1 at the assertion named above; afterwards `git status --porcelain` showed only this branch's edits, and the
restored file passes all four cases.

- H12's live worker belongs to the real parent that promotes it: one prompt dispatches the ship, a `bash` turn holds
  the parent until the in-process policy gate has recorded the hold, then the script and promotion are dispatched.
- `replace_work` and mechanical `cp_gate handoff` are not exercised here. Neither writes the escalation journal, and
  an unreleased hold never consults lineage; a released hold follows `gate-replacement.json`, which both write
  through `prepareGateReplacement`, to the lineage head and needs a fresh bound gate there.
- `tests/e2e/authority-hold.test.ts`: `accepted` stays an in-process `post.dispatch` seam because the bench tears the
  admitted worker down in process right after; a worker launched by an exited parent cannot be torn down there.
