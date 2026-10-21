# S05 declaration migration and retirement controls

Owner: cp-e2e-slice-s05-mzpm. S05 owns declarations 41–55 of `tests/diff-review.test.ts`; S04 owns 1–40. Original blob: `4c2662fffc918138acaef068b62a557c95634e88`.

S05: 15 mapped, 0 retained, 0 redundant-unreachable. Whole-file accounting: 53 mapped declarations, 2 retained declarations, plus the unknown-job sub-probe split from mapped declaration 21. Retained tests live in `tests/diff-review-retained.test.ts`. S04's declarations and these 15 cover the complete 55-declaration file.

## S05 behavior map

All scenarios are in `tests/e2e/diff-review.test.ts`. Controls below are executed production mutations, restored immediately after each run. Failure logs live beside the job report at `/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s05-mzpm/`.

Review-1 replay evidence, exact production patches and failing consumer assertions are committed in [the control index](testing-migration-s05-controls/README.md). Shared patches below are credited only to the independently observed assertions that index names.

| Declaration | Scenario | Executed control and failing assertion |
|---|---|---|
| 41 unchanged incomplete subject | S04 limits / S05 third-pass and wide stop | nc-policy-replay disables the unchanged incomplete-subject cache; replay attempt differs from the first attempt, including byte overflow. |
| 42 rebase with edit | S05 base integration, rebase subtest | nc-delta makes deltaBaselineHolds always true; upstream history pollutes the subject and expected pass becomes policy escalation. |
| 43 merge of advanced base | S05 base integration, merge subtest | nc-delta: expected pass becomes policy escalation. |
| 44 unmerged base advance | S05 base integration, none subtest | nc-no-delta disables delta selection; delta_from differs from the first reviewed head. |
| 45 unknown/malformed prior heads | S05 legacy heads, two subtests | nc-delta accepts every prior head; assert.doesNotReject fails at the real git materialization for each invalid revision. |
| 46 operational ladder | S05 settled reviewer | nc-operational always emits operational; second cause must be operational_persistent. |
| 47 recycled worktree | S04 complete subject | nc-canonical reads record.worktree instead of the canonical clone; assert.doesNotReject fails because the recycled path is absent. |
| 48 review-count cap | S05 fifth review | nc-cap makes reviewCapExhausted always false; expected fifth-review escalation becomes revise. Exact static constants/import identity stay in the retained structural declaration 12. |
| 49 third revise delivery | S04 real promotion, review 3 subtest | nc-promotion sends raw revisions without diffReviseMessage; actual implementer request lacks same-branch guidance. |
| 50 third pass proceeds | S05 third-pass and wide stop | nc-third-pass changes a third pass observation to escalate; expected pass fails. |
| 51 fifth review and sixth refusal | S05 fifth review | nc-cap: fifth verdict is revise instead of escalate. |
| 52 final-fix eligibility and maximum findings | S05 eligibility + fifth review + S04 real promotion | nc-final-fix-eligibility rejects forbidden checkpoints; nc-max-findings pins checkpoint evidence; nc-final-delivery drives approved post.integrate promotion and requires all twenty 400-character findings verbatim in the real author's request. Dropping evidence item 20 fails `assert.ok(finalMessages.includes(finding))` for final reason 9. |
| 53 async head/pending identity | S05 pending review | nc-start-head pins the returned head; nc-wakeup-head removes the production wakeup headSha and fails `assert.equal(s.wakes[0]?.headSha, started.head_sha)` (actual undefined). The harness preserves the full wake object. |
| 54 duplicate-start fence | S05 pending review | nc-pending-head drops the head from the in-flight refusal; error must contain the actual reviewed head. |
| 55 synchronous stat stop | S04 limits / S05 third-pass and wide stop | nc-stat removes the materializer's file cap; the wide subject must stop as policy before any model. |

## S04 per-declaration controls

This index supplements `testing-migration-s04-declarations.md`; a scenario-level control is credited only for the declaration behavior its recorded assertion breaks.

| Declarations | Executed control | Failing consumer assertion |
|---|---|---|
| 1 | nc-config | extra review property must reject at pipeline advance |
| 2, 22, 23, 24 | nc-summary | summary-bearing pass must persist and stranded receipt must settle as pass |
| 3 | nc-checkpoint-path | diff decision must have its own review question, not the original ship question |
| 4 | nc-review-path | persisted public review verdict path must exist; directing persistence to gate-1.json fails that assertion before reading the verdict |
| 5, 36 | nc-flags | destructive flag must remain reported without changing pass to escalation |
| 6 | nc-prior-isolation | assert.doesNotReject: a review with existing plan-gate history must start; reading it as diff history raises TypeError on diff_stat.truncated |
| 7, 11 | nc-three-dot | complete subject must count three branch files and exclude the base-only file |
| 8 | nc-quoted | unparseable quoted path must cause policy stop |
| 9, 37 | nc-stat | wide input must stop as policy without model calls |
| 10, 38 | nc-incomplete | bytes and hidden-code subtests must each stop as policy |
| 13, 14 | nc-preference | configured project model must run; configured allowlist refusal must reject |
| 15 | nc-role-deny | deniedFor always returns undefined; configured role denial must reject instead of starting a review |
| 16 | nc-inherited-route | inherited L/high axes must remain inherited and select the large-risky rule |
| 17 | nc-fallback | authenticated fallback review must not reject |
| 18 | nc-refusal | absent dispatch refusal must name cp_dispatch |
| 19, 20 | nc-recovery-actions | research and unpushed subtests must name cp_gate and git push respectively |
| 21 | nc-head, nc-research-head | current reviewed ship must reach done; a legacy reported research subject must hold |
| 26 | nc-equivalence | patch-equivalent rebase must reuse its existing review attempt |
| 27 | nc-mandate | paused/revoked mandate must refuse reviewer spend |
| 28, 40 | nc-no-delta | delta_from must name prior head and complete small delta must pass despite oversized history |
| 29 | nc-task-copy | copied frozen task must equal the dispatched task |
| 30 | nc-context | README head context entry must be included |
| 31 | nc-addenda | reviewer brief must point to task-addenda.md |
| 32 | nc-task-boundary | reviewer brief must state source-of-truth framing |
| 33 | nc-task-cap | copied task must be shorter than the oversized source |
| 34 | nc-promotion | real implementer must receive same-branch repair guidance |
| 35 | nc-delivery-error | wake must report no live worker |
| 39 | nc-partial-pass | truncated historical pass must not be inherited |

## Retention boundaries

- Declaration 12 is a structural contract: cp_review and cp_pipeline expose outcomes, not whether functions are imported or copied, nor schema object identity. Import/source/schema assertions stay; the live review budget is separately exercised through review three and five and mutated by nc-cap/nc-third-pass. This is not retention because a scenario omitted a combination.
- Declaration 25 replaces manager.shutdown with a synthetic one-shot throwing function. cp_review accepts no port or request that replaces manager.shutdown; the original regression assertions remain in the retained file with real reviewer processes. The ordinary missing-verdict operational ladder is mapped separately.
- Only the unknown-job sub-probe of declaration 21 remains. The sole production headSha caller is PipelineRunner.#reviewStep, entered by advance only inside `if (fleet.get(ship_id))`; a missing fleet record cannot reach that caller. The non-ship half is reachable by seeding a legacy reported research record and is now driven by pipeline advance and nc-research-head.

## Final retirement reruns

The final 20-scenario file passes 40 tests including subtests, with no skips. All 39 named production controls were rerun before the original unit file was removed. Grouped runs combine independent defects and check each listed failing assertion; the earlier single-control logs establish the individual mutation. Every mutation was restored before the passing rerun.

| Final failing log | Controls rerun |
|---|---|
| final-controls-1.log | stat, promotion (all three reviews fail independently), operational, start-head |
| final-controls-2.log | delta (both invalid heads and both integrated-base modes fail independently), equivalence, mandate |
| final-controls-3.log | refusal, recovery-actions (research and unpushed each fail), config, cap |
| final-controls-4.log | three-dot, context, partial-pass, delivery-error, task-cap, pending-head |
| final-controls-5.log | task-copy, flags, inherited-route, checkpoint-path, no-delta (history and unmerged base), max-findings |
| final-controls-6.log | policy-replay (all four variants fail independently), addenda, head, third-pass |
| final-controls-7.log | incomplete (bytes, quoted, hidden-code each fail), task-boundary, fallback |
| final-controls-8.log | quoted, prior-isolation |
| final-controls-9.log | review-path, final-fix-eligibility |
| nc-summary.log | summary, packet and stranded-receipt cases each fail |
| nc-canonical.log | canonical |
| nc-preference.log | preference, configured preference and configured refusal each fail |
| nc-role-deny.log | role-deny, Missing expected rejection |
| nc-research-head.log | research-head, actual done must not be done |
| nc-no-delta-final.log | additional direct delta_from assertion for S04 declaration 28 |

All external agent configurations use createAgentDir and t.after cleanup; no live credentials or live model calls are used. No production mutation is retained in the branch.
