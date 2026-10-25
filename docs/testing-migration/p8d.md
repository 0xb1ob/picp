# Ledger rows: p8d

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8d (cp-e2e-migration-p8d-om9z) | behavior 04, fourth slice: cp_revive's plan and relaunch (04-18, 04-19), bounded recovery after a death or a hard bound (04-20, 04-21), the on-disk settle budget (04-22) and the held-author release on revive (04-23) in `tests/e2e/worker-lifecycle-p8d.test.ts`: 31 mapped, 9 retained verbatim in two `*-retained.test.ts` files; the #528 review fixes in p8c.md; the other 7 P8-owned behavior-04 files stay `convert` for the next slice | 2 (`tests/recovery.test.ts`, `tests/revive.test.ts`) |
<!-- /manifest:ledger -->

P8d (job `cp-e2e-migration-p8d-om9z`) is the fourth behavior-04 slice. It converts `tests/revive.test.ts` and
`tests/recovery.test.ts` on real pi workers: 04-18 drives cp_revive's planner over seeded fleet records, 04-19 kills a
risk:high worker mid-call and continues it, 04-20 and 04-21 let bounded recovery act on real deaths and real bounds,
04-22 maps the restart-budget assertion P8c had retained (a count written to the fleet file by a second store reaches
the live settle), and 04-23 revives at the spawn cap. Each control below changed one guard, failed in the named case,
and was restored. It stops at two files: `tests/failures.test.ts`, `tests/harness.test.ts`, `tests/script-jobs.test.ts`,
`tests/worker-manager.test.ts`, `tests/worker-packages.test.ts`, `tests/worker-process.test.ts` and
`tests/worker-reporter.test.ts` stay `convert` in p8.md for the next slice.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8d | 04 | tests/e2e/worker-lifecycle-p8d.test.ts | 6 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-18 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d revive plan: cp_revive over seeded fleet records refuses each unsafe state by code, surfaces dirt, the interrupted call and the checkpoint, and continues a failed job only on request |
| 04-19 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d continue: a risk:high worker killed mid-call is failed as a crash and never auto-recovered; continue_failed relaunches it idle on its session, lease and re-resolved skills |
| 04-20 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d recovery: a bound redispatches into the same worktree with its evidence, a death revives once on the same session naming the cut-off call, and the second death escalates |
| 04-21 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d recovery refusals: a tool loop escalates without a revive, a policy-blocked session spends its attempt and escalates, and a redispatch whose skill vanished is announced once |
| 04-22 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d unreported bound: a spent count written to the fleet file by another store is the budget a live settle reads; the same job without it is prompted |
| 04-23 | tests/e2e/worker-lifecycle-p8d.test.ts | P8d release: a revive at the spawn cap releases the other idle held author, never itself, and spawns into the reserved slot |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/recovery.test.ts | the policy table has an action for every failure class | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: a sweep over every failure class has no runtime input; 04-20/04-21 reach crash, the bound and tool_loop. |
| tests/recovery.test.ts | a transient class recovers on attempt one, escalates on attempt two | 04-20 | mapped | a killed worker is revived once, the second kill escalates naming crash; control NC-P8d-attempt-bound |
| tests/recovery.test.ts | a hard bound redispatches once, then escalates | 04-20 | mapped | the first tool-call bound redispatches, the second is spent and escalates; control NC-P8d-attempt-bound |
| tests/recovery.test.ts | a policy cause escalates immediately, on the very first occurrence | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: 04-21 reaches tool_loop only; budget_exceeded, envelope_invalid, spawn_failed and model_call_failed fail before any death this path sees. |
| tests/recovery.test.ts | risk:high never auto-recovers, whatever the class | 04-19 | mapped | the killed risk:high worker escalates with no recovery_attempted and no counter; control NC-P8d-risk |
| tests/recovery.test.ts | the attempt counter is per (job, class) and survives a fresh read | 04-20 | mapped | a fresh read gives the bounded job tool_call_cap_exceeded 1 and crash 0, the blocked job crash 1 (04-21); control NC-P8d-attempt-bound |
| tests/recovery.test.ts | the revive brief with no detected call still says a 'No result provided' error is synthetic | 04-20 | mapped | a worker killed during a model request gets a brief with "No result provided" and no call id; control NC-P8d-no-call |
| tests/recovery.test.ts | the revive brief names the interrupted call and asks for its effect to be checked, not a blind retry | 04-20 | mapped | the brief names "bash (call id …)", "does not say whether it ran" and "unresolved in report_result"; control NC-P8d-call-named |
| tests/recovery.test.ts | the redispatch brief carries the on-disk evidence | 04-20 | mapped | the redispatch brief says SAME worktree, app.txt and Do NOT redo the work; control NC-P8d-evidence |
| tests/recovery.test.ts | a policy failure (tool_loop) escalates immediately, no revive attempted | 04-21 | mapped | six identical calls fail as tool_loop and escalate as a policy cause, no recovery_attempted; control NC-P8d-tool-loop |
| tests/recovery.test.ts | a risk:high job never auto-recovers, even a transient class | 04-19 | mapped | a crash on a risk:high job escalates; control NC-P8d-risk |
| tests/recovery.test.ts | cp-a9fq: a teardown in flight wins; recovery stands down without spending an attempt, and owns the job while it runs | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: a death landing while cp_teardown holds the job's claim cannot be timed from outside. |
| tests/recovery.test.ts | a revive after a cut-off tool call names that call in the brief, never its arguments | 04-20 | mapped | the brief names the call and never carries its ARG-MARKER argument; control NC-P8d-brief-args |
| tests/recovery.test.ts | a transient worker death (crash) is revived once for real, then escalates on the second occurrence | 04-20 | mapped | a new pid on the same session, one delivered brief, then one escalation and no further request; control NC-P8d-attempt-bound |
| tests/recovery.test.ts | a hard bound (wall_clock_exceeded) redispatches once for real, then escalates on the second occurrence | 04-20 | mapped | the tool-call bound takes the same hard-bound path: a fresh session in the same worktree, then a spent escalation; control NC-P8d-evidence |
| tests/recovery.test.ts | a refused revive plan escalates instead of throwing | 04-21 | mapped | a policy-blocked session's revive is refused, the crash attempt is spent and one escalation names session_policy_blocked; control NC-P8d-policy-block |
| tests/recovery.test.ts | a live tool child refuses the revive before the attempt is spent: one escalation, attempted false | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: a killed worker's tool children are reparented, so its stored pid never has a live child. |
| tests/recovery.test.ts | settleBound: a revive announces nothing | 04-20 | mapped | the recovered bound leaves no bound wake-up; control NC-P8d-announce |
| tests/recovery.test.ts | settleBound: a refused redispatch announces the outcome once, never a preview | 04-21 | mapped | one bound wake-up "attempted, not revived (… skill_unresolved)", never "did not stick", still one a second later; control NC-P8d-redispatch-skill |
| tests/recovery.test.ts | skill mentions PR2: a redispatch whose recorded skill vanished escalates revive_refused naming skill_unresolved | 04-21 | mapped | the redispatch is refused, one escalation, nothing spawned; control NC-P8d-redispatch-skill |
| tests/recovery.test.ts | settleBound: a spent bound announces BOUND_SPENT_PHRASE with 0 attempts left | 04-20 | mapped | the second bound's wake-up carries BOUND_SPENT_PHRASE; control NC-P8d-attempt-bound |
| tests/recovery.test.ts | settleBound: a rejected attempt is announced as operational, logged, and keeps the lease | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: no product input makes the redispatch throw. |
| tests/recovery.test.ts | settleBound: a live replacement that raced the outcome gets no notice | — | retained | Verbatim in tests/recovery-retained.test.ts. Missing entry point: a replacement racing the outcome cannot be timed from outside. |
| tests/revive.test.ts | plan refuses: no record, wrong phase, missing session, live pid, missing worktree | 04-18 | mapped | not_found, not_revivable_phase, session_missing, pid_alive, worktree_missing; control NC-P8d-continue-gate |
| tests/revive.test.ts | plan refuses tool_child_alive while a child of the stored pid lives; the stored pid only, nothing signalled | 04-18 | mapped | a live pid with a live child refuses naming both, the pid survives, a child-less live pid gets pid_alive; control NC-P8d-child |
| tests/revive.test.ts | childPids reads a real child of this process from procfs | 04-18 | mapped | the refusal names the real child pid read from procfs, and no dead-pid job refuses on children; control NC-P8d-child |
| tests/revive.test.ts | plan refuses a worktree with a rebase/merge/cherry-pick in progress or a detached HEAD; dirty is surfaced, not refused | 04-18 | mapped | rebase and detached HEAD refuse, a dirty tree plans with "uncommitted changes", clean trees plan; control NC-P8d-hazard |
| tests/revive.test.ts | readInterruptedTool parses a real dangling-tool-call session (spike shape) | 04-18 | mapped | the dangling bash call is the plan's interrupted tool, a resolved one is not; control NC-P8d-interrupted |
| tests/revive.test.ts | formatRevivePlan names the refusal code and, on success, the interrupted tool | 04-18 | mapped | the rendered refusal names its code, the rendered plan the interrupted tool; control NC-P8d-interrupted |
| tests/revive.test.ts | plan shows the dispatch-time checkpoint ref and its sha, HEAD unchanged; a deleted ref is shown missing, not refused (t3code adoption 7) | 04-18 | mapped | the ref, its sha and an unchanged HEAD, then "missing" after the ref is deleted; 04-19 checks a real dispatch captures it; control NC-P8d-checkpoint |
| tests/revive.test.ts | kill mid-tool-call, then revive: new pid, same session, idle until prompted, the interrupted call is surfaced | 04-19 | mapped | a new pid on the same session, model and worktree; the marker ran once; the first later request is the operator's send; control NC-P8d-idle |
| tests/revive.test.ts | revive() writes the worker_revived marker before it tees a single event (cp-0wq7) | — | retained | Verbatim in tests/revive-retained.test.ts. Missing entry point: a child emitting before the marker is written needs a fake spawn; no real stdout chunk can be timed into that gap. |
| tests/revive.test.ts | revive() throws with the refusal code and message when the plan refuses | 04-18 | mapped | cp_revive on each refused job rejects with ReviveError naming the code, and mutates nothing; control NC-P8d-envelope |
| tests/revive.test.ts | continueFailed: a failed job continues on its original session, worktree and lease; failed clears only after the recorded spawn | 04-19 | mapped | phase waiting, failure cleared, same session, worktree and branch, worker_revived continuation operator, counter untouched; 04-18 plans it; control NC-P8d-continue-gate |
| tests/revive.test.ts | skill mentions PR2: a revive re-resolves the record's skills by name and spawns with them; a vanished skill refuses skill_unresolved | 04-19 | mapped | a stale recorded dir is re-resolved, pi's system prompt lists the real SKILL.md, a removed skill refuses skill_unresolved; control NC-P8d-skill |
| tests/revive.test.ts | continueFailed refuses without mutation: live pid, script job, missing session, hazardous git, unresolved envelope | 04-18 | mapped | each refusal code, an unchanged fleet record and nothing spawned; control NC-P8d-envelope |
| tests/revive.test.ts | S5: explicit and automatic revival refuse a policy-blocked or unreadable session before shutdown or spawn | 04-18 | mapped | explicit: session_policy_blocked and session_scan_failed naming the path; automatic: 04-21's blocked job; control NC-P8d-policy-block |
| tests/revive.test.ts | continueFailed: a spawn that fails keeps the failure and the lease | — | retained | Verbatim in tests/revive-retained.test.ts. Missing entry point: no product input makes pi's spawn fail after the plan passed. |
| tests/revive.test.ts | 4B1-T7: a revive at the cap releases another idle author (never itself) and spawns into the reserved slot | 04-23 | mapped | the other idle author is released, the reservation consumed, continuation held_release, both phases held; control NC-P8d-release |
| tests/revive.test.ts | 4B1-T7: a failed revive spawn after makeRoom leaves no reservation | — | retained | Verbatim in tests/revive-retained.test.ts. Same: the failed spawn needs a fake spawn. |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-P8d-continue-gate | tests/revive.test.ts | 04-18 | src/revive.ts: a failed job is revivable without continue_failed | the plain plan of a failed job is not refused naming continue_failed:true |
| NC-P8d-envelope | tests/revive.test.ts | 04-18 | src/revive.ts: the unresolved-envelope check is skipped | cp-f-unaccepted plans ok instead of envelope_unresolved |
| NC-P8d-child | tests/revive.test.ts | 04-18 | src/revive.ts: no live-child check | cp-child refuses pid_alive instead of tool_child_alive |
| NC-P8d-hazard | tests/revive.test.ts | 04-18 | src/revive.ts: no in-progress-operation check | the mid-rebase plan is not refused repo_operation_in_progress |
| NC-P8d-interrupted | tests/revive.test.ts | 04-18 | src/revive.ts: the dangling call is never read | the plan's interrupted tool is undefined |
| NC-P8d-checkpoint | tests/revive.test.ts | 04-18 | src/revive.ts: the plan omits the checkpoint | the plan's checkpoint is undefined |
| NC-P8d-idle | tests/revive.test.ts | 04-19 | src/revive.ts: the relaunched worker is prompted | the revive itself prompted nothing |
| NC-P8d-skill | tests/revive.test.ts | 04-19 | src/revive.ts: the spawn takes the record's skill dirs | the relaunch throws: per-job skill /stale/recorded/dir is not an absolute skill directory |
| NC-P8d-policy-block | tests/revive.test.ts | 04-21 | src/revive.ts: a policy-blocked session is not refused | timed out waiting for the refused revive's escalation |
| NC-P8d-release | tests/revive.test.ts | 04-23 | src/revive.ts: revive never makes room | spawn cap reached (1/1 workers) |
| NC-P8d-risk | tests/recovery.test.ts | 04-19 | src/recovery.ts: risk:high is not checked | timed out waiting for the risk:high escalation |
| NC-P8d-attempt-bound | tests/recovery.test.ts | 04-20 | src/recovery.ts: two attempts per class | timed out waiting for the second bound's wake-up |
| NC-P8d-brief-args | tests/recovery.test.ts | 04-20 | src/recovery.ts: the revive brief carries the call's arguments | the brief names the call, never its arguments |
| NC-P8d-call-named | tests/recovery.test.ts | 04-20 | src/recovery.ts: the revive brief never names the cut-off call | /bash \(call id …\)/ is not in the brief |
| NC-P8d-no-call | tests/recovery.test.ts | 04-20 | src/recovery.ts: the no-call brief drops its synthetic-error line | /No result provided/ is not in the brief |
| NC-P8d-evidence | tests/recovery.test.ts | 04-20 | src/recovery.ts: the redispatch brief gets an empty observation | /app\.txt/ is not in the redispatch brief |
| NC-P8d-announce | tests/recovery.test.ts | 04-20 | src/recovery.ts: a revived bound is announced anyway | a recovered bound announces nothing |
| NC-P8d-tool-loop | tests/recovery.test.ts | 04-21 | src/contracts/limits.ts: tool_loop revives | timed out waiting for the loop's escalation |
| NC-P8d-redispatch-skill | tests/recovery.test.ts | 04-21 | src/recovery.ts: the redispatch ignores an unresolved skill | the wake-up does not say "could not redispatch … skill_unresolved" |
| NC-P8d-disk-bound | tests/settle-recovery.test.ts | 04-22 | src/settle.ts: the settle count ignores the fleet record and starts at 1 | timed out waiting for the spent budget's record |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8d.test.ts | P8d | behavior 04, revive, bounded recovery and the on-disk settle budget; scenarios 04-18..04-23 |
| tests/recovery-retained.test.ts | P8d | convert-owned; 6 declarations of tests/recovery.test.ts retained verbatim, no e2e entry point |
| tests/revive-retained.test.ts | P8d | convert-owned; 3 declarations of tests/revive.test.ts retained verbatim, no e2e entry point |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/recovery.test.ts` | deleted | P8d | behavior 04: 17 mapped (04-19..04-21), 6 retained in tests/recovery-retained.test.ts; controls NC-P8d-risk, NC-P8d-attempt-bound, NC-P8d-brief-args, NC-P8d-call-named, NC-P8d-no-call, NC-P8d-evidence, NC-P8d-announce, NC-P8d-tool-loop, NC-P8d-redispatch-skill, NC-P8d-policy-block |
| `tests/revive.test.ts` | deleted | P8d | behavior 04: 14 mapped (04-18, 04-19, 04-23), 3 retained in tests/revive-retained.test.ts; controls NC-P8d-continue-gate, NC-P8d-envelope, NC-P8d-child, NC-P8d-hazard, NC-P8d-interrupted, NC-P8d-checkpoint, NC-P8d-idle, NC-P8d-skill, NC-P8d-policy-block, NC-P8d-release |
<!-- /manifest:baseline -->
