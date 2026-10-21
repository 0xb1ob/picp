# S05 production control patches

These are the exact zero-context production diffs executed during review-1 repair, against the merged production tree. They are evidence, not production changes. Every mutation was restored. The declaration maps in ../testing-migration-s05-declarations.md and ../testing-migration-s04-declarations.md retain the declaration-level accounting; this index binds their control names to committed patches and the observed consumer assertions.

To replay a row, apply its patch with `git apply --unidiff-zero docs/testing-migration-s05-controls/<patch>.patch`, then run:

```sh
node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='<filter>' --test-timeout=300000 --test-force-exit tests/e2e/diff-review.test.ts
```

The filter is shown below. Each recorded replay exited 1. Reverse the same patch afterward with `git apply --reverse --unidiff-zero ...`. Replay one patch at a time. These controls use the mock provider and temporary agent configuration; no operator credentials are used.

Shared patches are credited only for the independently observed assertions below. A failure earlier in a scenario does not credit later assertions. Logs `replay-<patch>.log` beside the job report preserve the full runs; the assertions and actual/expected values here make the evidence reviewable without that local log directory.

| Patch | Test-name filter used |
|---|---|
| [ladder](ladder.patch) | `S04: blocking review promotes\|S05: a settled reviewer\|S05: pending reviews\|S05: the fifth complete` |
| [history](history.patch) | `S04: moved heads\|S04: a paused\|S05: unknown\|S05: integrating` |
| [refusals](refusals.patch) | `S04: cp_review refuses\|S04: pipeline advance` |
| [consumer-packet](consumer-packet.patch) | `S04: cp_review gives\|S04: review packets\|S04: moved heads\|S04: review flags\|S04: legacy stranded\|S05: pending` |
| [subject-packet](subject-packet.patch) | `S04: review packets\|S04: review flags\|S04: configured\|S04: pipeline advance\|S04: complete deltas\|S04: moved heads\|S05: integrating\|S05: the fifth complete` |
| [replay-head](replay-head.patch) | `S04: cp_review stops\|S04: review packets\|S04: pipeline advance\|S05: a pass at review` |
| [incomplete-boundary](incomplete-boundary.patch) | `S04: cp_review stops\|S04: review packets\|S04: configured` |
| [quoted-history](quoted-history.patch) | `S04: cp_review stops\|S04: review packets` |
| [review-path](review-path.patch) | `S04: review packets` |
| [eligibility](eligibility.patch) | `S05: only a complete fifth` |
| [boundary-context](boundary-context.patch) | `S04: cp_review stops\|S04: review packets\|S04: pipeline advance\|S05: a pass at review` |
| [stat](stat.patch) | `S04: cp_review stops\|S05: a pass at review` |
| [canonical](canonical.patch) | `S04: cp_review gives` |
| [summary](summary.patch) | `S04: review packets\|S04: legacy stranded` |
| [preference](preference.patch) | `S04: reviewer preferences\|S04: configured` |
| [role-deny](role-deny.patch) | `S04: configured` |
| [final-consumers](final-consumers.patch) | `S04: blocking review promotes\|S05: pending` |

## Executed assertion ledger

| Control name in declaration maps | Committed patch | Independently observed failing assertion |
|---|---|---|
| nc-promotion | ladder | DR-12 review 1, 2 and 3 each fail the author-request same-branch guidance assertion (`assert.ok(received.includes(...))`, actual false). Each awaited subtest executes independently. |
| nc-operational | ladder | DR-16 second missing verdict: cause actual operational, expected operational_persistent. |
| nc-start-head | ladder | DR-17 started head: actual forty zeros, expected the pushed SHA. |
| nc-cap | ladder | DR-18 fifth verdict: actual revise, expected escalate. |
| nc-delta | history | DR-14 invalid-head and malformed-head subtests each fail assert.doesNotReject during real git materialization. DR-15 merge and rebase subtests each have actual escalate, expected pass. |
| nc-equivalence | history | DR-05 equivalent_to actual undefined, expected `{head_sha: <prior>, attempt: 2}`. |
| nc-mandate | history | DR-07 missing expected rejection `/is paused.*no new reviewer spend/`. |
| nc-refusal | refusals | DR-04 absent subtest: diagnostic fails `/no dispatch record.*cp_dispatch/`. |
| nc-recovery-actions | refusals | DR-04 research subtest fails `/kind:research.*cp_gate/`; unpushed subtest independently fails `/branch not pushed.*git push/`. |
| nc-config | refusals | DR-11 missing expected rejection `/pipeline contract/`. |
| nc-three-dot | consumer-packet | DR-01 diff stat actual `{files: 4, truncated: false}`, expected `{files: 3, truncated: false}`. This is the branch-file count and exclusion of the base-only file. |
| nc-partial-pass | consumer-packet | DR-05 inherited equivalent_to actual prior-head/attempt object, expected undefined. |
| nc-delivery-error | consumer-packet | DR-06 final wake lacks `/no live worker/`; actual wake reports revise instead of the delivery failure. |
| nc-task-cap | consumer-packet | DR-08 oversized frozen task length assertion: actual false, expected true. |
| nc-pending-head | consumer-packet | DR-17 in-flight refusal omits reviewed head: includes assertion actual false, expected true. |
| nc-task-copy | subject-packet | DR-03 copied task actual `lost task`, expected `Keep README.md. S04_TASK_CANARY\n`. |
| nc-flags | subject-packet | DR-06 flagged pass actual escalate, expected pass. |
| nc-inherited-route | subject-packet | DR-10 inherited L/high case actual mock/script-spare, expected mock/script-axis. |
| nc-checkpoint-path | subject-packet | DR-11 review question actual original ship decision, expected a different question (assert.notEqual fails). |
| nc-no-delta (including nc-no-delta-final) | subject-packet | DR-05 delta_from actual undefined, expected prior reviewed head; DR-13 complete delta actual escalate, expected pass; DR-15 none subtest delta_from actual undefined, expected prior head. All three execute in separate cases. |
| nc-max-findings | subject-packet | DR-18 checkpoint evidence deep equality fails: actual first 10 revisions, expected all 20 revisions and reasons of 400 characters each. |
| nc-policy-replay | replay-head | DR-02 wide, bytes, quoted and hidden-code subtests independently fail replay attempt equality: actual 2, expected 1. |
| nc-addenda | replay-head | DR-03 brief task-addenda.md path assertion: actual false, expected true. |
| nc-head | replay-head | DR-11 pipeline next state actual implementing, expected done. |
| nc-third-pass | replay-head | DR-19 review-three verdict actual escalate, expected pass. |
| nc-incomplete | incomplete-boundary | DR-02 bytes, quoted and hidden-code subtests independently have actual `[pass, null]`, expected `[escalate, policy]`. |
| nc-task-boundary | incomplete-boundary | DR-03 brief fails `/source of truth for what was asked/`. |
| nc-fallback | incomplete-boundary | DR-10 unconfigured authenticated fallback fails assert.doesNotReject: no available model because removing the fallback leaves the unavailable primary alone. |
| nc-quoted | quoted-history | DR-02 quoted subtest actual `[pass, null]`, expected `[escalate, policy]`. |
| nc-prior-isolation | quoted-history | DR-03 assert.doesNotReject fails: plan-gate history is consumed as diff history, causing `Cannot read properties of undefined (reading 'truncated')`. |
| nc-review-path | review-path | DR-03 fails `review must persist at its public review verdict path` before the fixture reads the verdict. |
| nc-final-fix-eligibility | eligibility | DR-20 earlier, escalate, pass and no-pr subtests independently create checkpoint objects where assert.equal expects undefined. The truncated case already stops before requestFinalFix and receives no deletion credit from this mutation. |
| nc-context | boundary-context | DR-03 README.md/head/included manifest-entry assertion actual false, expected true. Removing only the invariant loop in consumer-packet did not remove the task-named README, so that hunk receives no context credit. This patch excludes README from all candidate reasons and proves the actual consumer assertion. |
| nc-research-head | boundary-context | DR-11 legacy reported research record: next state actual done; assert.notEqual(next, done) fails. |
| nc-stat | stat | DR-02 wide actual `[pass, null]`, expected `[escalate, policy]`; DR-19 wide start independently fails assert.doesNotReject when loss of the synchronous stop attempts unavailable reviewer routing. No later assertion is credited in DR-19. |
| nc-canonical | canonical | DR-01 assert.doesNotReject fails when the public review reads the recycled worktree instead of the canonical clone. |
| nc-summary | summary | DR-03 summary-bearing pass actual escalate, expected pass; DR-08 stranded-summary replay independently actual escalate, expected pass. |
| nc-preference | preference | DR-09 configured project model fails assert.doesNotReject after its preference is ignored; DR-10 configured allowlist refusal independently misses expected rejection `/allowlist refuses/`. |
| nc-role-deny | role-deny | DR-10 role mode misses expected rejection `/not allowed for role gate-reviewer/`. |
| nc-wakeup-head | final-consumers | DR-17 sole wake headSha actual undefined, expected started.head_sha. Returned head itself is unchanged. |
| nc-final-delivery | final-consumers | DR-12 approved final fix goes through post.integrate to the existing real author. Dropping evidence item 20 fails `assert.ok(finalMessages.includes(finding), finding)` for the full 400-character final reason 9 (actual false, expected true). Findings are unique to review five, so earlier repair requests cannot satisfy this assertion. |

## Fixture boundary for the approved final fix

The author is a real mock-provider implementer. The first three reviews each prove same-branch promotion; the fourth repair has distinct findings and is awaited. Because this scripted author acknowledges that repair without submitting another report, the fixture seeds a legacy held report before integration. It approves the final-fix checkpoint with an operator-quote basis and calls public `CommandPost.integrate`; it asserts `final fix promoted once` before observing the author's request. The fake forge supplies an open draft on the actual branch/head and empty Actions workflow/run inventories. No production sender or integrator is mocked.

All 20 fifth-review findings are distinct 400-character strings, including the severity/confidence prefixes. The test compares every complete string against the actual author request. DR-17 preserves whole wake objects and checks exactly one wake whose headSha equals the reviewed head. Runtime next-action, sixth-refusal diagnostic and review-three formatting assertions also run through the public consumers.
