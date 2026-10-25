# Ledger rows: p8e

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8e (cp-e2e-migration-p8e-sdwz) | behavior 04, fifth slice: spawn safety through cp_dispatch (04-27), the brief guard (04-28), the model-call look-alike (04-29), the episode-end exit (04-30), the spawn cap (04-31) and send receipts (04-32) in `tests/e2e/worker-lifecycle-p8e.test.ts`: `tests/worker-manager.test.ts` 10 mapped, 15 retained verbatim in `tests/worker-manager-retained.test.ts`; `tests/worker-process.test.ts` 3 mapped, 14 retained in `tests/worker-process-retained.test.ts`; the #531 review lows (S21-budget policy escalation, two budget-gate declarations kept verbatim, p8d rows and docstring) | 2 (`tests/worker-manager.test.ts`, `tests/worker-process.test.ts`) |
<!-- /manifest:ledger -->

P8e (job `cp-e2e-migration-p8e-sdwz`) is the fifth behavior-04 slice, on real pi workers through a real CommandPost.
It also closes the #531 review lows: S21-budget now pins the policy-cause escalation, the unpinned cost-only breach is
kept verbatim in `tests/failures-retained.test.ts`, and the p8d rows are corrected. Each control below changed one
guard, failed in the named case, and was restored.

`tests/worker-manager.test.ts` retains 15 of 25 (60%): the worker profiles are package files (`CommandPost`'s
`packageRoot/profiles`), so no home file or seeded data supplies a profile that lacks report_result, lies about
readOnly, lists ask_operator, names a cost or asks for more than 50M tokens; no caller has set `mayAskOperator` since
cur.3.1; and the manager's bookkeeping (a duplicate refusal behind preflight's promote, a reservation's window, a
hanging or throwing shutdown, a throwing slot-free listener) has no input a real worker can produce.

`tests/worker-process.test.ts` retains 14 of 17 (82%): a worker loads only the reporter extension (a clone's are
refused, 04-27), and no caller has set `mayAskOperator` since cur.3.1, so no worker raises a dialog; a prompt with
`streamingBehavior` and `getEntries` have only the parent bridge as caller; and byte-level framing (a CRLF, a chunk
split mid-line, a pi older than 0.99.1, a child closing its stdin) cannot be produced through pi's own stdout.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8e | 04 | tests/e2e/worker-lifecycle-p8e.test.ts | 6 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-27 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e spawn: a worker dispatched into a hostile clone loads none of its config, carries only its own job identity in a non-interactive environment, and gets the stricter budget |
| 04-28 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e brief guard: a task carrying a credential is refused before any worker starts, naming the pattern and line, never the secret |
| 04-29 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e look-alike: a worker whose own text reads like a provider error is an ordinary unreported settle, never a model-call failure or an outer retry |
| 04-30 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e episode end: a drained parent's shutdown leaves no worker alive and its held and waiting jobs revivable on the next start, none failed |
| 04-31 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e spawn cap: at the cap another job is refused naming the live worker, the same job promotes instead of a second worker, and the slot frees on the observed close |
| 04-32 | tests/e2e/worker-lifecycle-p8e.test.ts | P8e send receipts: a busy worker queues a follow_up and a steer, refuses a bare prompt with pi's reason, and the steer reaches the model first |
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
| tests/worker-manager.test.ts | tool allowlist comes from the profile and must include report_result | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: profiles load only from the package's profiles/, so no input supplies one without report_result or with a lying readOnly; 04-27 pins the allowlist half. |
| tests/worker-manager.test.ts | readOnly refuses pi-lens and hashline writers | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Same: a readOnly profile granting a writer is package data, never a runtime input. |
| tests/worker-manager.test.ts | ask_operator is granted by the parent per spawn, never by a profile | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: no caller sets mayAskOperator since cur.3.1, and a profile listing the tool is package data. |
| tests/worker-manager.test.ts | CP_ASK_OPERATOR is set only when the parent granted the ask | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point for the grant half: no caller sets mayAskOperator since cur.3.1; 04-27 pins the never-inherited half (NC-P8e-cp-prefix). |
| tests/worker-manager.test.ts | a clamp is detectable, not just silently applied (cp-sr5) | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point for the cost-only clamp: no shipped profile names cost_usd; 04-27 pins the token clamp (NC-P8e-clamp). |
| tests/worker-manager.test.ts | raising only one side of profile/config surfaces the clamp, raising both clears it (cp-sr5) | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: the profile-side raise needs a profile over 50M tokens; none ships. |
| tests/worker-manager.test.ts | a static (non-function) budget value still works, unchanged (back-compat) | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: CommandPost always hands the manager a live getter; the static form has no product caller. |
| tests/worker-manager.test.ts | trust policy self-check refuses a tampered argv | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: buildWorkerArgs always prepends the required flags and refuses forbidden extra args, so no input reaches a tampered argv; 04-27 pins the policy (NC-P8e-trust). |
| tests/worker-manager.test.ts | untrusted project resources in a clone are detected | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: SpawnPlan.refusedResources has no reader in src/; 04-27 pins that those resources never load. |
| tests/worker-manager.test.ts | spawn cap and one-worker-per-job are enforced | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point for the manager's own duplicate refusal: preflight promotes first (removing that refusal leaves 04-31 green); 04-31 pins the cap (NC-P8e-cap), the promote and the freed slot. |
| tests/worker-manager.test.ts | shutdownAll leaves no orphans | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: a revive fired by the shutdown's own close cannot be timed from outside, and the monitor's closing gate stops it first; 04-30 pins no orphan (NC-P8e-closing). |
| tests/worker-manager.test.ts | 4b-1: spawn refusals carry a typed code; the messages are unchanged | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: the duplicate code has no reader and no input (see the cap row); 04-31 pins the cap message. |
| tests/worker-manager.test.ts | 4b-1: a reservation holds a slot for its key; spawn consumes it silently, release notifies once | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: only HeldRelease reserves, inside a revive at the cap, and no competing spawn can be timed into that window; 04-24 pins the consumed reservation. |
| tests/worker-manager.test.ts | 4b-1: a stopping worker is marked from shutdown's first tick until its exit; notify fires once | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: a shutdown that hangs or throws; pi always exits on the shutdown ladder. |
| tests/worker-manager.test.ts | 4b-1: slot-free fires after an observed close; unsubscribe works; a throwing listener breaks nothing | — | retained | Verbatim in tests/worker-manager-retained.test.ts. Missing entry point: the product's only listener never throws or unsubscribes. |
| tests/worker-process.test.ts | prompt -> events -> settled -> graceful shutdown against a real pi child | 04-32 | mapped | cp_dispatch's prompt is delivered, the worker's tool call is on the run log, and 04-30 pins the clean shutdown; controls NC-P8e-receipt, NC-P8e-quiesce |
| tests/worker-process.test.ts | busy worker takes steer and follow_up as queued receipts | 04-32 | mapped | cp_send to a busy worker: follow_up and steer queued, a bare prompt failed with pi's reason and logged; controls NC-P8e-receipt, NC-P8e-refused |
| tests/worker-process.test.ts | observed close: kill -9 resolves the closed promise with the signal | 04-20 | mapped | a worker killed mid-call is failed as a crash only from its observed close |
| tests/worker-process.test.ts | buildWorkerArgs applies the trust policy and refuses forbidden flags | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no caller passes a forbidden extra flag; 04-27 pins the trust flags (NC-P8e-trust) and 04-20 the revive's session. |
| tests/worker-process.test.ts | busy worker: a prompt+steer reaches the model before an earlier queued prompt+followUp | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: prompt with streamingBehavior has no worker caller (only the parent bridge's delivery); 04-32 pins steer over follow_up through cp_send. |
| tests/worker-process.test.ts | send(): the receipt is pi's disposition, never the busy flag | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: the pinned pi always sends a disposition, so the pre-0.99.1 fallback has no input; 04-32 pins the disposition half (NC-P8e-receipt). |
| tests/worker-process.test.ts | dialog requests from a worker extension are auto-cancelled, never blocking | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: a worker loads no extension that raises a dialog (04-27 refuses a clone's). |
| tests/worker-process.test.ts | a relayed dialog is answered by the relay, and a broken relay still cancels | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no dialog source, and no caller sets mayAskOperator since cur.3.1. |
| tests/worker-process.test.ts | LF framing: unicode separators are payload, partial lines are buffered | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: chunk boundaries and CRLF in pi's stdout cannot be chosen from outside. |
| tests/worker-process.test.ts | cp-xbxz: a dialog in flight when the child dies resolves worker-gone, and answerDialog then lies to nobody | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no worker dialog source. |
| tests/worker-process.test.ts | cp-xbxz: a held dialog answered later reaches the worker, its transcript and the model | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no worker dialog source. |
| tests/worker-process.test.ts | cp-xbxz: getEntries caps the window and keeps the tail | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: getEntries' only caller is the parent bridge's delivery. |
| tests/worker-process.test.ts | cp-xbxz: a dialog that arrives when no answer can be written is aborted, not left tracked | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no worker dialog source. |
| tests/worker-process.test.ts | cp-xbxz: pi itself honours the dialog signal — an aborted dialog resolves without any response | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no worker dialog source. |
| tests/worker-process.test.ts | cp-xbxz: dialogOptions forwards the worker's signal, and omits the key when there is none | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: no worker dialog source. |
| tests/worker-process.test.ts | decoder: a message_update is a delta, never a cumulative message snapshot | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: run-artifacts never persists message_update, so no worker output shows the decoded delta. |
| tests/worker-process.test.ts | a request to a worker that closed its stdin rejects; the EPIPE is never an uncaught error | — | retained | Verbatim in tests/worker-process-retained.test.ts. Missing entry point: pi never closes its own stdin while alive. |
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
| NC-P8e-cap | tests/worker-manager.test.ts | 04-31 | src/worker-manager.ts: the spawn-cap check never fires | Missing expected rejection |
| NC-P8e-receipt | tests/worker-process.test.ts | 04-32 | src/worker-process.ts: a queued disposition reads delivered | the follow_up and steer receipts read delivered |
| NC-P8e-refused | tests/worker-process.test.ts | 04-32 | src/worker-process.ts: a rejected send reads delivered | the bare prompt's receipt reads delivered |
| NC-P8e-look-alike | tests/failures.test.ts | 04-29 | src/failures.ts: readModelCallError reads a 4xx/5xx in assistant text | timed out waiting for the report nudge |
| NC-P8e-budget-policy | tests/recovery.test.ts | S21-budget | src/contracts/limits.ts: budget_exceeded revives | timed out waiting for the budget breach's policy escalation |
| NC-P8e-budget-class | tests/failures.test.ts | S21-budget | src/failures.ts: the budget_exceeded marker is not read | timed out waiting for the budget_exceeded durable emitter |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8e.test.ts | P8e | behavior 04, spawn safety, the brief guard, the model-call look-alike, the episode-end exit and the spawn cap; scenarios 04-27..04-31 |
| tests/worker-manager-retained.test.ts | P8e | convert-owned; 15 declarations of tests/worker-manager.test.ts retained verbatim, no e2e entry point |
| tests/worker-process-retained.test.ts | P8e | convert-owned; 14 declarations of tests/worker-process.test.ts retained verbatim, no e2e entry point |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/worker-manager.test.ts` | deleted | P8e | behavior 04: 10 mapped (04-27, 04-28, 04-30), 15 retained in tests/worker-manager-retained.test.ts; controls NC-P8e-min, NC-P8e-clamp, NC-P8e-brief-scan, NC-P8e-brief-echo, NC-P8e-strip, NC-P8e-cp-prefix, NC-P8e-artifact, NC-P8e-noninteractive, NC-P8e-trust, NC-P8e-quiesce, NC-P8e-closing, NC-P8e-cap |
| `tests/worker-process.test.ts` | deleted | P8e | behavior 04: 3 mapped (04-20, 04-32), 14 retained in tests/worker-process-retained.test.ts; controls NC-P8e-receipt, NC-P8e-refused |
<!-- /manifest:baseline -->
