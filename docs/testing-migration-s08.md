# S08: integration declarations 1–40

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

This range covers static `test(...)` declarations 1–40 of `tests/integrate.test.ts`, from the review-window loop to superseded-head CI. Loop expansions are not extra declarations. Later declarations belong to other slices. This is a range delivery: the entire original unit file is intentionally kept intact. No declarations are deleted or moved. The final range slice must reconcile every range, preserve the exceptions, and rerun negative controls against the final state before deleting that file.

The disposition is 38 mapped declarations, two retained declarations (8 and 19), zero redundant-unreachable declarations and zero deleted files. The retained share is 5%. A retained declaration can contain mapped consumer checks alongside an injection-only check; its unmatched assertion remains in the original file. The file-level manifest remains `convert`, rather than claiming that this range retires the whole file.

All scenario IDs below resolve to exact names in `docs/testing-migration.md`; all execute through `CommandPost`, the real tool extension, or the bridge extension, with mock-provider workers and scratch git/forge state. Production source is unchanged.

| Declaration | Original behavior | Disposition | Scenario | Consumer assertion that detects the regression |
|---|---|---|---|---|
| 1 | 30-second review minimum and hold race, both authority paths | mapped | 05-S08-4 | Before the deadline, next is wait and merge calls are empty; a hold still blocks at the deadline. |
| 2 | Deadline continuation rechecks current gates | mapped | 05-S08-4 | Each changed hold/head/CI/permission yields zero merges; the unchanged case merges once. |
| 3 | Durable hold preserves current green CI identity | mapped | 05-S08-1, 05-S08-9 | Held green result waits, names CI and preserves head/PR identity with zero merges. |
| 4 | Persistence and explicit release with fresh gates | mapped | 05-S08-8, 05-S08-4 | A separate parent reads the bridge's durable hold; release requires review, and reviewed release rechecks authority. |
| 5 | One sourced held-red repair | mapped | 05-13 | The same worker receives the Actions run URL and hold warning; one attempt is charged and hold persists. |
| 6 | Open PR, branch proof and current failed CI | mapped | 05-S08-1 | Foreign/closed/unproven PR and stale/malformed/nonfailed CI wait without promotion or expenditure. |
| 7 | Blocked reports and git hazards | mapped | 05-S08-2, 05-S08-1 | Blocked/unreadable reports and unfinished operations surface without promotion; all four hazard markers refuse. |
| 8 | Active/failed/terminal/unreported fleet phases | retained | 05-S08-1, 05-S08-2 | Waiting/done and malformed fleet records have consumer assertions. Injection-only launching/unreported/held-without-report combinations cannot reach the helper through the validated public fleet store; retain those assertions. |
| 9 | Revalidation after both external reads | mapped | 05-S08-2 | Both barriers refuse stale hold/report/drain/generation/PR/head/worktree state; a changed valid hold reason is used. |
| 10 | Cumulative allowance across heads, green reads and restarts | mapped | 05-13 | Parent startup preserves the recorded allowance after green; a second red head surfaces with one supersession. |
| 11 | Sender refusal does not spend or release | mapped | 05-S08-1 | A public deny policy causes sender refusal, zero attempts, and the original durable hold. |
| 12 | Drain and unreadable drain start no process | mapped | 05-S08-1, 05-S08-2 | Entry drains produce no gh calls and a CI-not-read fact; mid-read drains prevent promotion. |
| 13 | Hold arriving during CI, both authorities | mapped | 05-S08-9 | The arriving hold prevents merge and preserves green head/PR evidence; release uses the original authority path. |
| 14 | Invalid/unreadable holds fail closed and release | mapped | 05-S08-1, 05-S08-4 | Invalid hold JSON/schema starts no process; explicit release permits fresh reviewed gates. |
| 15 | Invalid hold requests | mapped | 05-S08-8 | Real cp_integrate rejects unknown/unsafe IDs, local delivery and empty reasons, creating no hold. |
| 16 | Red main and green fix-forward | mapped | 05-S08-5 | A stale red main waits for every PR CI state; a pushed head containing main with green CI reaches review. |
| 17 | Other project, corrupt or cleared main latch | mapped | 05-S08-5 | Unrelated/corrupt/cleared latches reach review; corruption is named in the result. |
| 18 | Repeated latch preserves first red identity | mapped | 05-S08-5 | A repeated setRed still names the first red head; clearing resumes review. |
| 19 | Mandate/login scoping and absent scope port | retained | 05-S08-5 | Consumer cases cover absent mandate, unreadable login and foreign login. A missing mainCiScope port is constructor injection only: CommandPost always wires it, so that assertion stays. |
| 20 | Bridge writes without a parent; restart reads/releases | mapped | 05-S08-8 | A real bridge child writes the hold before parent startup; status reads it and public release removes it. |
| 21 | Legacy tracker metadata and malformed config | mapped | 05-S08-3 | A legacy-linked job completes and cp_integrate emits no tracker/write-back advice; malformed config is unchanged. |
| 22 | Review already in flight | mapped | 05-S08-8 | The public tool says review already in flight and leaves persisted attempt 2 pending. |
| 23 | Green repository-authorized merge | mapped | 05-S08-3 | A real squash merge records repo_derived authority, then receipt, teardown and ledger close. |
| 24 | After-merge line exactly once or absent | mapped | 05-S08-3 | Opted-in completion has one after-merge fact and one deploy job; ordinary completion has none. |
| 25 | No admin/auto/delete-branch merge flags | mapped | 05-S08-3, 05-S08-6 | Observed merge calls bind the head and contain none of the three unsafe flags. |
| 26 | Bound branch is kept while job closes | mapped | 05-S08-3 | Bound completion says head kept, remote branch remains, receipt/closed ledger/fleet done still hold. |
| 27 | Completed integration is idempotent | mapped | 05-S08-3 | Repeat returns done, merge command count remains one and no receipt is re-recorded. |
| 28 | Restart after merge resumes forge facts | mapped | 05-S08-3 | The first CommandPost shuts down after merge; a new instance records/tears down/closes without another merge. |
| 29 | Missing/pending/declined fallback authority | mapped | 05-S08-6 | Missing and declined answers surface, pending waits, and no merge occurs before approval. |
| 30 | Fallback approval binds its head | mapped | 05-S08-6 | A concurrent push invalidates old approval; the moved head needs fresh review and approval. |
| 31 | Both paths send server head binding | mapped | 05-S08-6 | Both merge commands contain --match-head-commit with the approved head. |
| 32 | Fallback push during merge is refused | mapped | 05-S08-6 | The forge rejects the concurrent push: retry, no receipt/authority, worker remains held. |
| 33 | Repository push during merge is refused | mapped | 05-S08-6 | The repository path has the same retry/no-receipt/no-authority outcome. |
| 34 | CLEAN stale base merges original head | mapped | 05-S08-7 | CLEAN issues one merge, no update-branch, and retains the original head. |
| 35 | BEHIND updates once and invalidates old evidence | mapped | 05-S08-7 | One update advances the real branch; old review/CI cannot authorize its new head. |
| 36 | BLOCKED without authoritative rule stays pending | mapped | 05-S08-7 | BLOCKED and unreadable rules surface with no update or merge. |
| 37 | Strict rule updates only with proven stale ancestry | mapped | 05-S08-7 | Strict stale branch updates once; unreadable ancestry and current base do not. |
| 38 | Red/conflict/moved heads never update | mapped | 05-S08-7 | Each mode has zero update-branch and merge commands and its own resolve/wait outcome. |
| 39 | Unknown mergeability | mapped | 05-S08-7 | UNKNOWN retries without update or merge. |
| 40 | Superseded green is not current green | mapped | 05-S08-7 | Green only on another SHA waits without updating or merging. |

## Negative-control evidence

Each mutation was applied alone, its named scenario exited 1 with the assertion below, and production source was restored. All nine new scenarios have a control; 05-13 also has fresh allowance and repair-context controls. The complete unmutated landing file passed 52 tests before the main merge. Replays use `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='<exact scenario name>' tests/e2e/landing.test.ts`.

| Scenario | Temporary production mutation | Observed failing assertion |
|---|---|---|
| 05-S08-1 | In `src/integrate-held.ts`, bypass both `headRefName !== record.branch` checks. | Foreign branch promoted: actual `resolve`, expected `wait`. |
| 05-S08-2 | In `src/integrate-held.ts`, make `paused()` always return undefined. | `ci/drain`: actual `surface`, expected `wait`; the read must stop before sender refusal. |
| 05-S08-3 | In `src/integrate.ts`, replace `const bound = record?.bound_pr !== undefined` with `const bound = false`. | `only a job-owned branch is deleted`: bound remote branch absent, expected present. |
| 05-S08-4 | In `src/review-merge-window.ts`, remove `+ REVIEW_MERGE_WINDOW_MS` from the deadline. | Initial next is `done` rather than `wait`, before the operator can hold it. |
| 05-S08-5 | In `src/integrate.ts`, replace the `mainRedHold(...)` result with `{}`. | Latched red main reaches `review`, expected `wait`. |
| 05-S08-6 | In both merge argument lists in `src/integrate.ts`, remove `--match-head-commit` and its head argument. | Both concurrent-push subcases return `advance`, expected `retry`. |
| 05-S08-7 | In `src/integrate.ts`, make the update condition only `verdict.permission === "pending"`. | BLOCKED, denied rules, current and unreadable ancestry return `advance`, expected `surface`. |
| 05-S08-8 | In `extensions/cp-bridge/index.ts`, remove the `holds.release(params.job_id)` call from integration_release. | The post-release durable hold is still an object, expected undefined. |
| 05-S08-9 | In both merge paths in `src/integrate.ts`, remove the `if (heldBeforeMerge) return this.#heldResult(...)` guard. | Both authority subcases merge: actual `advance`, expected `wait`. |
| 05-13 | In `src/integrate.ts`, set the prior repair count to zero. | `a second red result exhausts the repair allowance`: actual `resolve`, expected `surface`. |
| 05-13 | In `src/integrate-held.ts`, omit `formatRunRef(ref)` from failure text. | The real worker's provider request no longer contains the Actions run URL. |

Additional controls: bypassing both worktree-hazard guards promotes a rebase-in-progress (`resolve`, expected `surface`); charging `bumpResolve: true` on sender refusal records one attempt instead of zero. Removing the main-CI login guard blocks a foreign login (`wait`, expected `review`); selecting the first project's row blocks another project (`wait`, expected `review`); returning a hold for an unreadable main-CI store blocks corruption (`wait`, expected `review`).

## Review 1: behavior-specific controls

Addendum 2 supersedes the older one-control-per-scenario rule. The following additional production mutations were each executed alone and restored. These controls break the listed declaration's own behavior, rather than another assertion in its scenario. Every run exited 1 with the assertion below; none relies on a timeout or compilation error.

| Declaration | Scenario | Executed production mutation | Observed failing assertion |
|---|---|---|---|
| 2 | 05-S08-4, repository/hold | In `Integrator.#readHold`, replace the durable `.get(jobId)` result with undefined. Leave the review duration intact. | Initial review still waits, but at the real deadline the new hold is ignored: merge count 1, expected 0 (`false/hold`). |
| 14 | 05-S08-1 | In `Integrator.#readHold`'s catch, return undefined instead of an unreadable-hold result. | The malformed `{` hold reaches `review`, expected `wait`. |
| 15 | 05-S08-8 | Remove `IntegrationHolds.#validateJob`'s delivery:pr ship-job guard. | Public cp_integrate accepts the local-delivery hold: `isError` false, expected true. |
| 18 | 05-S08-5 | Remove `MainCiStore.setRed`'s same-login early return. | `setting the same login twice preserves its first red head` is false instead of true. |
| 21 | 05-S08-3 | In cp_integrate's final text, append `tracker write-back required` when next is done and the ledger job has legacy tracker metadata. | `assert.doesNotMatch(JSON.stringify(events), /tracker\|write-back/)` fails for the legacy-linked job beside malformed tracker config. |
| 22 | 05-S08-8 | Set cp_integrate's `inFlight` lookup to undefined. | The second public result lacks `/review already in flight/` for persisted attempt 2. |
| 24 | 05-S08-3 | Change the after-merge fact append to `facts.push(merge.after_merge, merge.after_merge)`. | Opted-in after-merge fact count is 2, expected 1. |
| 27 | 05-S08-3 | In `MergeRecorder`'s existing-receipt return, change `recorded: false` to true. | Repeated integration reports `again.record.merge?.recorded` true, expected false, in both branch variants. |
| 28 | 05-S08-3 | Disable Integrator's `state === "MERGED"` jump to `#finish`. | After shutdown and new CommandPost construction, resume returns `surface`, expected `done`, in both branch variants. |
| 29 missing | 05-S08-6, fallback | Replace a missing checkpoint lookup with a requested checkpoint copied with `decision: "approved"`. | Missing approval merges: actual `advance`, expected `surface`. |
| 29 pending | 05-S08-6, fallback | Change the nonapproved guard to refuse only `decision === "declined"`. | Pending approval merges; the result lacks `/awaiting a human/`. |
| 29 declined | 05-S08-6, fallback | Change the nonapproved guard to refuse only `decision === "pending"`. | Declined approval merges; the result lacks `/declined/`. |
| 39 | 05-S08-7, unknown | In `evaluateMergePermission`'s UNKNOWN branch, change `permission: "retry"` to pending. | UNKNOWN returns `surface`, expected `retry`. |
| 40 | 05-S08-7, superseded | In `evaluateMergeAskCi`, replace the current-head filtered `forHead` list with all input runs. | Superseded green merges: actual `advance`, expected `wait`. |

Replay the exact scenario command above with each mutation. The deadline control used `--test-skip-pattern='repository/(unreadable-hold|head|ci|permission|none)|fallback/'` to run repository/hold while preserving the real 30-second timer. UNKNOWN and superseded controls skipped the other named subtests with anchored skip patterns; all unselected modes were explicitly skipped. The three fallback mutations are separate executions so that missing, pending and declined each reach and fail their own assertion. The source changes are temporary; none is included in the delivered diff.

A trial removing the `alreadyClosed` optimization did not fail: the real ledger close is idempotent. It earns no proof credit. The executed existing-receipt mutation above supplies declaration 27's idempotency evidence instead.

## S09 carry-in: declaration 2 rechecks

S09 separately executed these production mutations against 05-S08-4. Each run exited 1 at the merge-count assertion after the real review deadline; source was restored after each run.

| Recheck | Executed mutation | Failing assertion |
|---|---|---|
| Head | In `src/integrate.ts`, obtain `head` from the accepted envelope's `head_sha` instead of the observed PR, and set `permHead = head`. | repository/head: merge command count 1, expected 0 (`false/head`). |
| CI | In `src/integrate.ts`, replace `if (ci.ci !== "green")` with `if (false)`. | repository/ci: merge command count 1, expected 0 (`false/ci`). |
| Permission | In `src/merge-permission.ts`, add `BLOCKED` to `PERMITTED_MERGE_STATES`. | repository/permission: merge command count 1, expected 0 (`false/permission`). |

Replay each with `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='landing: the review deadline' --test-skip-pattern='^(repository/(hold|unreadable-hold|ci|permission|none)|fallback/.*)$' tests/e2e/landing.test.ts` for head; exchange `head` for the selected recheck in that skip expression for CI/permission. The original duration remains intact. The head mutation models trusting the previously reported head; the fake forge still refuses its stale bound merge, and the assertion detects the forbidden attempt.

The harness's `setGh` uses `Object.assign(gh, patch)` before writing the complete state file (`tests/e2e/landing.test.ts`, startStack). Therefore partial permission/runs updates retain `integration` and other omitted fields. No harness change is required for that review uncertainty.

Measured accounting for the PR ledger: the migration checker reports 378 tree test files and 4,299 static declarations. S08 keeps the file count unchanged and adds exactly nine test declarations to the 4,290-declaration merged base; no unit declaration is removed. The PR body supplies the Scope block, verbatim Ownership, counts, diff size, isolation details and validation evidence.

Negative controls and final validation are recorded in the job report and the PR validation notes. The final range must rerun the controls before removing any unit declarations; this range provides no permission to delete unconverted assertions.
