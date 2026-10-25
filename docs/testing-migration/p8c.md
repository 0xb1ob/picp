# Ledger rows: p8c

P8c (job `cp-e2e-migration-p8c-pew6`) is the third behavior-04 slice. It converts `tests/live-harness.test.ts`,
`tests/worker-spawn-reserve.test.ts` and `tests/settle-recovery.test.ts`: the reviewer's spend charged to its own run
(04-13, an extension of the m3 pipeline e2e), the spawn cap's gate-reviewer reserve (04-14), and the bounded recovery
of a silent settle (04-15, 04-16), on real pi workers. Each control below changed one guard, ran only the named case,
failed as stated, and was restored. The other 10 P8-owned behavior-04 files stay `convert` for cp-e2e-migration-p8d;
P8b (#518) owns bounds, worker-mcp and wedged.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8c | 04 | tests/e2e/worker-lifecycle-p8c.test.ts | 3 new; m3 in tests/e2e/phase3.test.ts extended |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-13 | tests/e2e/phase3.test.ts | m3: research → gate (revise, then pass) → checkpoint → implement |
| 04-14 | tests/e2e/worker-lifecycle-p8c.test.ts | P8c reserve: held authors at the spawn cap refuse another author, yet gate reviewers start until the reserve is full and a closed reviewer frees it |
| 04-15 | tests/e2e/worker-lifecycle-p8c.test.ts | P8c unreported: a silent settle with work on disk gets two recovery prompts carrying the evidence, then a record; a promote reopens them; a clean or unobservable tree gets the plain nudge |
| 04-16 | tests/e2e/worker-lifecycle-p8c.test.ts | P8c unreported: a job that reported, or whose delivery merged, is never prompted after it settles |
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
| tests/settle-recovery.test.ts | a settle with work on disk records a different fact than a settle with a clean tree | 04-15 | mapped | the dirty job's record carries 40 files and validates; the clean job's says clean and gets the plain nudge; control NC-P8c-unknown-work |
| tests/settle-recovery.test.ts | an observation that failed is `unknown`, and unknown never counts as work | 04-15 | mapped | a worker that deletes its own worktree is observed unknown and nudged, never recovered; control NC-P8c-unknown-work |
| tests/settle-recovery.test.ts | an inspector that throws degrades to `unknown` instead of losing the settle | 04-15 | redundant-unreachable | the product inspector never throws (it returns unknown); 04-15's deleted-worktree job pins the unknown outcome |
| tests/settle-recovery.test.ts | the recovery prompt fires automatically, carries the file evidence, and never asks for a redo | 04-15 | mapped | the first prompt names the worktree, the files, origin and "Do NOT redo it", with recovery_prompted 1 of 2; control NC-P8c-bound |
| tests/settle-recovery.test.ts | the automatic recovery is bounded: prompts stop permanently once the bound is spent | 04-15 | mapped | two prompts, then recovery_exhausted, the job left waiting and the 3-line operator line; control NC-P8c-bound |
| tests/settle-recovery.test.ts | the bound is on disk: a restarted parent inherits the spent budget, not a fresh one | — | retained | Verbatim in tests/settle-recovery-retained.test.ts. Missing entry point: a parent restart kills every live worker, so no restarted post sees the same worker settle. |
| tests/settle-recovery.test.ts | a promote reopens the budget and clears the observation with it | 04-15 | mapped | cp_send clears the count and the observation, and the next settle is attempt 1 again; control NC-P8c-clear |
| tests/settle-recovery.test.ts | a job that has reported is never prompted, even with a stale unreported flag on the record | 04-16 | mapped | a reported job settles with no further prompt; control NC-P8c-reported |
| tests/settle-recovery.test.ts | a job whose PR has merged is never prompted | 04-16 | mapped | a merge receipt on disk stops the prompt; the record's merged receipt is only ever written after that file (src/merges.ts); control NC-P8c-landed |
| tests/settle-recovery.test.ts | a job mid-tool-call is never classified unreported | — | retained | Verbatim in tests/settle-recovery-retained.test.ts. Missing entry point: no product input makes a settle race a new tool call on demand. |
| tests/settle-recovery.test.ts | a job that is done, or otherwise not live, is left alone | — | retained | Verbatim in tests/settle-recovery-retained.test.ts. Missing entry point: teardown closes the worker before the job is done, so no settle reaches a done record. |
| tests/settle-recovery.test.ts | inspectWorktreeWork classifies a real worktree: dirty, unpushed, clean | 04-15 | mapped | real worktrees observed dirty (2 commits, branch on origin), unpushed (branch not on origin), clean and unknown |
| tests/settle-recovery.test.ts | nothing in the recovery path deletes, resets or cleans a worktree | — | retained | Verbatim in tests/settle-recovery-retained.test.ts. Missing entry point: every product call site passes read-only git, so the runner's refusal has no caller; 04-15 checks the files survive. |
| tests/settle-recovery.test.ts | /status and the widget say which unreported situation this is | 04-15 | mapped | /status reads unreported WITH WORK ON DISK, 40 files, never failed, and the widget says work on disk; control NC-P8c-status |
| tests/settle-recovery.test.ts | the recovery prompt names the worktree, the branch and the bound, and truncates a long file list | 04-15 | mapped | the prompts carry the worktree, "28 more file(s)", "2 unpushed commit(s)" and "the last one"; control NC-P8c-bound |
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
| NC-P8c-bound | tests/settle-recovery.test.ts | src/settle.ts MAX_RECOVERY_PROMPTS | 04-15 | a bound of 3 prompts | — | two prompts, sent by the settle boundary itself, then none | pass |
| NC-P8c-unknown-work | tests/settle-recovery.test.ts | src/contracts/fleet.ts unreportedWorkPresent | 04-15 | any non-clean observation counts as work | — | timed out waiting for the unobservable job's nudge | pass |
| NC-P8c-clear | tests/settle-recovery.test.ts | src/send.ts clearUnreportedSettles call | 04-15 | a promote keeps the count | — | a promote clears the count and its observation | pass |
| NC-P8c-status | tests/settle-recovery.test.ts | src/status-render.ts jobState unreported | 04-15 | no unreported state | — | jobState is not unreported | pass |
| NC-P8c-reported | tests/settle-recovery.test.ts | src/settle.ts reported_at and envelope-on-disk checks | 04-16 | both removed (either alone keeps the job quiet) | — | timed out waiting for the reported turn: a third request | pass |
| NC-P8c-landed | tests/settle-recovery.test.ts | src/settle.ts deliveryLanded check | 04-16 | a landed delivery is not checked | — | a landed delivery is never prompted | pass |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8c.test.ts | P8c | behavior 04, the spawn cap's gate-reviewer reserve; scenario 04-14 |
| tests/live-harness-retained.test.ts | P8c | convert-owned; 6 declarations of tests/live-harness.test.ts retained verbatim, the paid live suite's own scaffolding |
| tests/worker-spawn-reserve-retained.test.ts | P8c | convert-owned; the one declaration of tests/worker-spawn-reserve.test.ts, kept verbatim for its live-key duplicate assertion |
| tests/settle-recovery-retained.test.ts | P8c | convert-owned; 4 declarations of tests/settle-recovery.test.ts retained verbatim, no e2e entry point |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/live-harness.test.ts` | deleted | P8c | behavior 04: 1 mapped (04-13), 6 retained in tests/live-harness-retained.test.ts; controls NC-P8c-gate-dir, NC-P8c-gate-reader |
| `tests/worker-spawn-reserve.test.ts` | deleted | P8c | behavior 04: 5 assertions mapped (04-14), 1 retained with its declaration in tests/worker-spawn-reserve-retained.test.ts; controls NC-P8c-reserve-off, NC-P8c-reserve-size, NC-P8c-author-reserve, NC-P8c-close |
| `tests/settle-recovery.test.ts` | deleted | P8c | behavior 04: 10 mapped (04-15, 04-16), 1 redundant-unreachable, 4 retained in tests/settle-recovery-retained.test.ts; controls NC-P8c-bound, NC-P8c-unknown-work, NC-P8c-clear, NC-P8c-status, NC-P8c-reported, NC-P8c-landed |
<!-- /manifest:baseline -->
