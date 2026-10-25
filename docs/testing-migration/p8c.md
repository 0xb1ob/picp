# Ledger rows: p8c

P8c (job `cp-e2e-migration-p8c-pew6`) is the third behavior-04 slice. It converts `tests/live-harness.test.ts` and
`tests/worker-spawn-reserve.test.ts`: the reviewer's spend charged to its own run (04-13, an extension of the m3
pipeline e2e) and the spawn cap's gate-reviewer reserve (04-14, a new case on real pi planners and reviewers). Each
control below changed one guard, ran only the named case, failed as stated, and was restored. The other 11 P8-owned
behavior-04 files stay `convert` for cp-e2e-migration-p8d; P8b (#518) owns bounds, worker-mcp and wedged.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8c | 04 | tests/e2e/worker-lifecycle-p8c.test.ts | 1 new; m3 in tests/e2e/phase3.test.ts extended |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-13 | tests/e2e/phase3.test.ts | m3: research → gate (revise, then pass) → checkpoint → implement |
| 04-14 | tests/e2e/worker-lifecycle-p8c.test.ts | P8c reserve: held authors at the spawn cap refuse another author, yet gate reviewers start until the reserve is full and a closed reviewer frees it |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/live-harness.test.ts | a gate attempt is charged to the reviewer's own run, not to the job it reviews; an attempt that never spawned costs zero | 04-13 | mapped | recordGateSpend over the real gate runs gives 950, 950, 0 and the planner's own run 3,100; controls NC-P8c-gate-dir, NC-P8c-gate-reader |
| tests/live-harness.test.ts | the live gate is closed unless the operator opens it | — | retained | Verbatim in tests/live-harness-retained.test.ts. Missing entry point: liveSkip's only consumer is tests/e2e/live.test.ts, which runs only on a paid CP_LIVE_TESTS=1 run. |
| tests/live-harness.test.ts | the live defaults are cheap and overridable | — | retained | Verbatim in tests/live-harness-retained.test.ts. Same: LIVE_MODEL and the budgets reach only the paid live suite. |
| tests/live-harness.test.ts | the fixture builds the state a real command post is in before its first dispatch | — | retained | Verbatim in tests/live-harness-retained.test.ts. createLiveFixture's only consumer is the paid live suite. |
| tests/live-harness.test.ts | the fixture cleans up after itself | — | retained | Verbatim in tests/live-harness-retained.test.ts. Same: the live fixture has no mock-run consumer. |
| tests/live-harness.test.ts | the PR url a delivery:pr scenario uses comes from the test, not a model | — | retained | Verbatim in tests/live-harness-retained.test.ts. fakePrUrl feeds only the paid live suite's delivery:pr scenario. |
| tests/live-harness.test.ts | spend accounting reads the run projection and enforces both budgets | — | retained | Verbatim in tests/live-harness-retained.test.ts. The per-job and suite budget refusals fire only inside the paid live suite; the reading half runs in 04-13. |
| tests/worker-spawn-reserve.test.ts | held workers at the cap are active and idle before the reserve is tested | 04-14 | mapped | three held planners keep their process; the refusal names 3/1 workers (NC-P8c-author-reserve) |
| tests/worker-spawn-reserve.test.ts | implementer, planner and qa spawns at the cap are refused, naming the gate-reviewer reserve | 04-14 | mapped | a fresh ship dispatch is refused with "Three extra slots are reserved for gate-reviewer"; control NC-P8c-author-reserve |
| tests/worker-spawn-reserve.test.ts | review, gate and quality reviewers start past the authors' cap | 04-14 | mapped | cp_gate's reviewer starts at 3 held authors over cap 1; control NC-P8c-reserve-off |
| tests/worker-spawn-reserve.test.ts | the reserve is three slots: one more reviewer is refused "review reserve exhausted (n/n)" | 04-14 | mapped | the second gate records an operational "review reserve exhausted (4/4 workers)" verdict; control NC-P8c-reserve-size |
| tests/worker-spawn-reserve.test.ts | an observed reviewer close frees reserve capacity | 04-14 | mapped | after the first reviewer settles and closes, a retried gate starts; control NC-P8c-close |
| tests/worker-spawn-reserve.test.ts | a second spawn for a live reviewer key is refused "already has a live worker" | — | retained | Whole declaration verbatim in tests/worker-spawn-reserve-retained.test.ts. Missing entry point: every gate or review attempt spawns under a fresh `<job>#<surface>-<n>` key, so no public tool asks for a live key twice. |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Guard | Scenario | Control | Evidence | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-P8c-gate-dir | tests/live-harness.test.ts | src/gate.ts reviewer RunRecorder dir | 04-13 | record the reviewer's run in the job's run dir | — | one verdict call per reviewer: [0, 0, 0] instead of [950, 950, 0] | pass |
| NC-P8c-gate-reader | tests/live-harness.test.ts | tests/harness/live.ts recordGateSpend | 04-13 | read the job's status.json for a gate attempt | — | one verdict call per reviewer: [3100, 3100, 3100] instead of [950, 950, 0] | pass |
| NC-P8c-reserve-off | tests/worker-spawn-reserve.test.ts | src/worker-manager.ts spawn limit | 04-14 | no reserve: reviewers share the authors' cap | — | the first gate returns a verdict instead of a wait | pass |
| NC-P8c-reserve-size | tests/worker-spawn-reserve.test.ts | src/worker-manager.ts spawn limit | 04-14 | a four-slot reserve | — | no reviewer past the reserve | pass |
| NC-P8c-author-reserve | tests/worker-spawn-reserve.test.ts | src/worker-manager.ts spawn limit | 04-14 | authors may take the reserve too | — | Missing expected rejection: an author never takes the reserve | pass |
| NC-P8c-close | tests/worker-spawn-reserve.test.ts | src/worker-manager.ts close and shutdown handlers | 04-14 | a closed reviewer stays registered | — | timed out waiting for the first reviewer's close | pass |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8c.test.ts | P8c | behavior 04, the spawn cap's gate-reviewer reserve; scenario 04-14 |
| tests/live-harness-retained.test.ts | P8c | convert-owned; 6 declarations of tests/live-harness.test.ts retained verbatim, the paid live suite's own scaffolding |
| tests/worker-spawn-reserve-retained.test.ts | P8c | convert-owned; the one declaration of tests/worker-spawn-reserve.test.ts, kept verbatim for its live-key duplicate assertion |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/live-harness.test.ts` | deleted | P8c | behavior 04: 1 mapped (04-13), 6 retained in tests/live-harness-retained.test.ts; controls NC-P8c-gate-dir, NC-P8c-gate-reader |
| `tests/worker-spawn-reserve.test.ts` | deleted | P8c | behavior 04: 5 assertions mapped (04-14), 1 retained with its declaration in tests/worker-spawn-reserve-retained.test.ts; controls NC-P8c-reserve-off, NC-P8c-reserve-size, NC-P8c-author-reserve, NC-P8c-close |
<!-- /manifest:baseline -->
