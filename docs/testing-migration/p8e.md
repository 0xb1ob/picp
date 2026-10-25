# Ledger rows: p8e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8e (cp-e2e-migration-p8e-sdwz) | behavior 04, fifth slice: spawn safety through cp_dispatch (04-27), the brief guard (04-28), the model-call look-alike (04-29) and the episode-end exit (04-30) in `tests/e2e/worker-lifecycle-p8e.test.ts`: 10 of the 25 `tests/worker-manager.test.ts` declarations mapped, the file kept intact as `convert` until p8f settles the other 15; the #531 review lows (S21-budget policy escalation, two budget-gate declarations kept verbatim, p8d rows and docstring); `tests/harness.test.ts`, `tests/script-jobs.test.ts`, `tests/worker-packages.test.ts`, `tests/worker-process.test.ts` and `tests/worker-reporter.test.ts` stay `convert` for p8f | 0 |
<!-- /manifest:ledger -->

P8e (job `cp-e2e-migration-p8e-sdwz`) is the fifth behavior-04 slice. It maps ten `tests/worker-manager.test.ts`
declarations onto four scenarios on real pi workers. The file keeps all 25 declarations as `convert`: its other
fifteen are not yet settled (mapped or retained with a named missing entry point), and a kept file may not lose
declarations without a deletion record, so p8f retires it whole. It also closes the #531 review lows: S21-budget now
pins the policy-cause escalation, the unpinned cost-only breach is kept verbatim in `tests/failures-retained.test.ts`,
and the p8d rows are corrected. Each control below changed one guard, failed in the named case, and was restored.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8e | 04 | tests/e2e/worker-lifecycle-p8e.test.ts | 4 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-27 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e spawn: a worker dispatched into a hostile clone loads none of its config, carries only its own job identity in a non-interactive environment, and gets the stricter budget |
| 04-28 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e brief guard: a task carrying a credential is refused before any worker starts, naming the pattern and line, never the secret |
| 04-29 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e look-alike: a worker whose own text reads like a provider error is an ordinary unreported settle, never a model-call failure or an outer retry |
| 04-30 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e episode end: a drained parent's shutdown leaves no worker alive and its held and waiting jobs revivable on the next start, none failed |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/worker-manager.test.ts | per-job budget takes the stricter of profile and config | 04-27 | mapped | a 90M config leaves the implementer's 50M; a stricter config wins and is journaled; control NC-P8e-min |
| tests/worker-manager.test.ts | a budget raised between two reads takes effect on the second, without reconstructing the manager (cp-sr5) | 04-27 | mapped | the same CommandPost clamps the first dispatch and not the second after the config changes; control NC-P8e-clamp |
| tests/worker-manager.test.ts | briefs are refused when they smell of credentials | 04-28 | mapped | cp_dispatch rejects each credential-bearing task and spawns nothing; control NC-P8e-brief-scan |
| tests/worker-manager.test.ts | cp-n7w: a credential refusal names the pattern and a line number, never the secret itself | 04-28 | mapped | the refusal names the pattern and line and never the matched text; control NC-P8e-brief-echo |
| tests/worker-manager.test.ts | worker environment carries job identity and drops the parent's | 04-27 | mapped | the live worker's /proc environ has its own CP_* identity, no PI_SESSION_ID and no inherited ask grant; controls NC-P8e-strip, NC-P8e-cp-prefix, NC-P8e-artifact |
| tests/worker-manager.test.ts | worker environment is structurally incapable of hanging on an editor, pager or credential prompt | 04-27 | mapped | the worker's environ overrides the parent's GIT_EDITOR, pager and prompt variables; control NC-P8e-noninteractive |
| tests/worker-manager.test.ts | a worker in an untrusted clone loads none of its config | 04-27 | mapped | the clone's extension never runs, its tool and SYSTEM.md never reach the model; control NC-P8e-trust |
| tests/worker-manager.test.ts | manager plumbs budget, identity and reporter extension into every spawn | 04-27 | mapped | the model sees report_result, the record carries the budget, the environ the identity; controls NC-P8e-min, NC-P8e-artifact |
| tests/worker-manager.test.ts | quiesce() reports active workers and which of them are mid-turn | 04-30 | mapped | two settled workers drain to active 2, busy none, then 0 after shutdown; control NC-P8e-quiesce |
| tests/worker-manager.test.ts | the episodic exit invariant: shutdownAll after drain leaves every job revivable | 04-30 | mapped | no worker pid survives and the next parent's reconcile lists both jobs revivable, none failed; control NC-P8e-closing |
| tests/failures.test.ts | the soft gate warns before it breaches, and never kills | — | retained | P8e restores it verbatim in tests/failures-retained.test.ts. Missing entry point: the mock provider's cost table is zero, so no run reaches a cost-only breach. |
| tests/failures.test.ts | cache_read is excluded from the budgeted token total (cp-d7y) | — | retained | P8e restores it verbatim in tests/failures-retained.test.ts. Same: its cost-only breach line needs a non-zero cost. |
| tests/failures.test.ts | readModelCallError: assistant text that reads like a provider error is not a failed model call | 04-29 | mapped | a worker saying "401 Invalid API key" is nudged as an unreported settle, with no failure and no outer retry; control NC-P8e-look-alike |
| tests/recovery.test.ts | a policy cause escalates immediately, on the very first occurrence (budget_exceeded) | S21-budget | mapped | a killed over-budget worker escalates as a policy cause with no recovery attempt; control NC-P8e-budget-policy |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-P8e-min | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: resolveJobBudget takes the config's tokens | the profile is stricter: tokens 90000000, not 50000000 |
| NC-P8e-clamp | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: detectBudgetClamp never reports a token clamp | the clamp is journaled on the job |
| NC-P8e-brief-scan | tests/worker-manager.test.ts | 04-28 | src/worker-manager.ts: assertBriefIsSafe returns at once | Missing expected rejection |
| NC-P8e-brief-echo | tests/worker-manager.test.ts | 04-28 | src/worker-manager.ts: the refusal appends the matched text | the message never echoes the matched text |
| NC-P8e-strip | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: STRIPPED_ENV_KEYS not skipped | PI_SESSION_ID must not leak into a worker |
| NC-P8e-cp-prefix | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: the parent's CP_* keys are inherited | a worker never inherits another job's permission to ask |
| NC-P8e-artifact | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: CP_ARTIFACT_PATH is never set | the planner's environ has no CP_ARTIFACT_PATH |
| NC-P8e-noninteractive | tests/worker-manager.test.ts | 04-27 | src/worker-manager.ts: NONINTERACTIVE_WORKER_ENV not applied | GIT_EDITOR overrides the parent's |
| NC-P8e-trust | tests/worker-manager.test.ts | 04-27 | src/worker-process.ts and src/worker-manager.ts: --no-approve and --no-extensions dropped, --approve added, the argv self-check off (combined: pi's own trust gate keeps the clone out unless --approve is passed) | a project-local extension never loads |
| NC-P8e-quiesce | tests/worker-manager.test.ts | 04-30 | src/worker-manager.ts: quiesce counts every worker busy | timed out waiting for a drained episode |
| NC-P8e-closing | tests/worker-manager.test.ts | 04-30 | src/failures.ts: the monitor classifies closes during shutdown | the next parent's revivable list misses the waiting job |
| NC-P8e-look-alike | tests/failures.test.ts | 04-29 | src/failures.ts: readModelCallError reads a 4xx/5xx in assistant text | timed out waiting for the report nudge |
| NC-P8e-budget-policy | tests/recovery.test.ts | S21-budget | src/contracts/limits.ts: budget_exceeded revives | timed out waiting for the budget breach's policy escalation |
| NC-P8e-budget-class | tests/failures.test.ts | S21-budget | src/failures.ts: the budget_exceeded marker is not read | timed out waiting for the budget_exceeded durable emitter |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8e.test.ts | P8e | behavior 04, spawn safety, the brief guard, the model-call look-alike and the episode-end exit; scenarios 04-27..04-30 |
<!-- /manifest:incoming -->
