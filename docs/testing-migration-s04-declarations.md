# S04 declaration migration

Owner: cp-e2e-slice-s04-vep1. Original declarations 1–40 of `tests/diff-review.test.ts`. S05 owns 41–55 and final whole-file retirement. Static declarations include the indented, parameterized configured-refusal declaration (14).

The baseline file is intentionally kept whole and unchanged: 55 declarations. Per the split-file ruling, a partly converted file is never counted as removed. Counts: **38 mapped, 2 retained, 0 pending in S04, 0 deleted files, 0 redundant-unreachable**. S05 must preserve the two retained declarations when retiring the file; this PR moves or deletes none.

Scenarios below are the `S04:` cases in `tests/e2e/diff-review.test.ts`:

| Key | Scenario title after `S04:` | Negative control |
|---|---|---|
| subject | cp_review gives the reviewer a complete three-dot subject from the canonical clone | nc-three-dot |
| limits | cp_review stops wide, oversized and unparseable subjects before a model sees them | nc-stat, nc-incomplete, nc-quoted |
| packet | review packets preserve frozen scope and context while persisted verdicts exclude gate-only fields | nc-summary |
| refusal | cp_review refuses absent, research and unpushed subjects with their recovery action | nc-refusal |
| delta | moved heads use complete deltas and patch-equivalent rebases reuse only complete passes | nc-delta, nc-partial-pass |
| flags | review flags remain reported while blocking findings surface when the implementer is gone | nc-flags |
| mandate | a paused or revoked mandate refuses reviewer spend and replacement authority restores it | nc-mandate |
| legacy | legacy stranded verdicts settle once and oversized frozen tasks state their boundary | nc-summary |
| preferences | reviewer preferences reread project and mandate settings while preserving the ship route | nc-preference |
| routing | configured reviewer denials never fall back, while an unconfigured route uses its authenticated fallback | nc-preference |
| pipeline | pipeline advance holds unresolved and moved heads until a review of the current commit exists | nc-head, nc-config |
| promotion | blocking review promotes the real implementer on the same branch with the remaining review budget | nc-promotion |
| history | complete deltas remain reviewable when supplemental branch history exceeds the byte cap | nc-delta |

The table maps behavior rather than reproducing internal assertions. Each mapped row names the assertion that fails if that behavior regresses. Controls are per scenario/behavior, not per assertion.

| Original declaration | Disposition | Scenario | Assertion sensitive to the old defect |
|---|---|---|---|
| 1 configuration schema | mapped | pipeline | Advancing a seeded record with an extra review property must reject; empty/disabled review records reach done. nc-config produces a missing rejection. |
| 2 parallel verdict schema | mapped | packet | A real pass with head_sha and diff_stat persists successfully; gate-only decision_summary/rubric must be absent. nc-summary fails the successful pass. |
| 3 distinct checkpoint paths | mapped | pipeline | A seeded flagged legacy review creates a pending diff checkpoint and preserves the existing ship checkpoint byte for byte. Colliding paths break this assertion. |
| 4 distinct review paths | mapped | packet | The existing plan gate remains unchanged, review attempt is 1, and separate reviewer brief/verdict/scratch files exist. A gate/review path collision breaks isolation. |
| 5 subject-independent policy | mapped | flags | A destructive flag still passes; blocking_unknowns with a high finding remains revise with its revisions intact. nc-flags changes pass to escalate. |
| 6 isolated prior attempts | mapped | packet | A seeded plan gate does not spend a review: review attempt remains 1 and the gate is unchanged. Reading gate attempts as review attempts breaks this assertion. |
| 7 complete small diff | mapped | subject | Files count is 3, subject is complete, and expected hunks reach diff.md. nc-three-dot counts 4 files. |
| 8 quoted/non-ASCII paths | mapped | limits | Quoted input produces escalate/policy with named omissions while the non-ASCII hunk remains. nc-quoted incorrectly passes. |
| 9 file cap | mapped | limits | Wide input produces policy without model requests or diff.md. nc-stat incorrectly passes. |
| 10 byte cap | mapped | limits | Oversized input produces policy, preserves the tiny file, and names omissions. nc-incomplete incorrectly passes. |
| 11 three-dot range | mapped | subject | The base-only file is absent and file count is 3; nc-three-dot counts 4. |
| 12 ladder imports and constants | retained | Structural exception | No runtime entry point exposes whether equivalent policy was imported or copied. Source/import identity and pure constant assertions remain verbatim. Flags/promotion exercise outcomes but cannot detect a behavior-preserving copy. |
| 13 configured preferences | mapped | preferences | Real mock requests, persisted model and selection source match each current project/mandate/explicit preference; cached passes preserve their model. nc-preference loses project selection and the expected review fails. |
| 14 configured refusal matrix | mapped | routing | Allowlist/auth/effort refusals reject with zero requests to both configured and fallback models. nc-preference loses configured allowlist refusal. |
| 15 role denial | mapped | routing | Both configured and explicit denied reviewer requests reject without fallback. Ignoring role restrictions makes rejection fail. |
| 16 inherited impact routing | mapped | routing/preferences | L/high selects large-risky, its actual model and medium thinking; inherited axes are recorded. Losing axes selects the wrong model/rule. |
| 17 fallback | mapped | routing | Only the authenticated spare receives requests and availability refusal is recorded. Losing fallback prevents the expected reviewer request. |
| 18 absent dispatch | mapped | refusal | Rejection names cp_dispatch. nc-refusal removes that recovery action and the regex fails. |
| 19 research dispatch | mapped | refusal | A seeded research job rejects and names cp_gate. Accepting research or naming the wrong recovery action fails the regex. |
| 20 unpushed branch | mapped | refusal | A seeded unknown branch rejects and names git push. Guessing a head or omitting recovery fails the regex. |
| 21 canonical head lookup | mapped + retained guard | pipeline | Canonical/current and unresolved heads remain consumer-visible; a seeded reported research fleet record holds instead of accepting its existing pass (nc-research-head). Only the unknown-job headSha probe stays in `tests/diff-review-retained.test.ts`: `PipelineRunner.advance` checks fleet.get(ship_id) before #reviewStep, the sole headSha caller, so no missing-record input reaches it. |
| 22 pass persistence and privacy | mapped | packet | Pass has actual head SHA; bodies/tasks are absent from run/job events and brief; the reviewer process is cleaned up. nc-summary prevents the successful persisted pass. |
| 23 decision_summary projection | mapped | packet | Summary-bearing pass persists without gate-only fields. nc-summary fails persistence. |
| 24 stranded receipt | mapped | legacy | Seeded receipt is decided once at attempt 1, passes, omits decision_summary, and wakes once. nc-summary changes pass to operational. |
| 25 injected shutdown fault | retained | Missing fault-injection entry point | The original test replaces manager.shutdown to throw once before delegating. No product entry point injects that synthetic one-shot shutdown refusal; it stays verbatim. No internal mocking was added to the e2e harness. |
| 26 equivalent rebase | mapped | delta | Equivalent rebase uses zero model requests and retains attempt 2 with equivalent_to and the new head. Losing equivalence causes another model request/attempt. |
| 27 mandate standing | mapped | mandate | Paused/revoked grants reject spend; a newer grant permits pass. nc-mandate produces a missing rejection. |
| 28 delta review | mapped | delta | delta_from equals prior head, fix hunk appears only in delta, and full diff/prior findings remain. nc-delta loses delta_from. |
| 29 task file packet | mapped | packet | nc-task-copy replaces the copied task with `task copy lost`; exact copied-task equality fails. |
| 30 unchanged-file context | mapped | packet | nc-context drops README.md from the persisted context manifest; the included head README entry assertion fails. |
| 31 authorized addenda | mapped | packet | nc-addenda omits the addenda block from the reviewer brief; the task-addenda.md pointer assertion fails. |
| 32 pointer/boundary | mapped | packet/legacy | nc-task-boundary removes source-of-truth framing; the brief's source-of-truth regex fails. |
| 33 oversized task | mapped | legacy | nc-task-cap removes the copy byte limit; the bounded-copy length assertion fails. |
| 34 live revise | mapped | promotion | Real dispatched implementer receives each revision on its original branch with budget and no-second-PR instruction. nc-promotion drops branch guidance and includes assertion fails. |
| 35 implementer gone | mapped | flags | High finding remains revise with revisions; parent wake names no live worker. Silently dropping delivery failure breaks wake assertion. |
| 36 non-veto flags | mapped | flags | Destructive flag is reported while pass/cause stay pass/null. nc-flags escalates. |
| 37 stat policy | mapped | limits | File-cap stop is escalate/policy with accurate file count and zero model requests. nc-stat passes instead. |
| 38 omitted code | mapped | limits | Oversized history plus omitted src/app.ts stops before a model and names that code in reasons. Missing incomplete-subject guard permits review, breaking policy/zero-request assertions. |
| 39 truncated historical pass | mapped | delta | Seeded truncated prior pass cannot be inherited: no equivalent_to, no delta_from, attempt 3, real reviewer requests. nc-partial-pass incorrectly inherits the truncated pass. |
| 40 complete delta / oversized history | mapped | history | Small complete delta passes with prior head and untruncated subject while full-diff.md names omissions. nc-delta stops on full history instead of passing. |

Every listed control was run against the real consumer and failed; all production mutations were restored. They are semantic patched-back regressions rather than claims about historical commit identities. No removed declaration receives credit: all 55 baseline declarations continue to run until S05 performs whole-file retirement.
