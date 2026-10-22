# S14 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S14 owns the whole files merge-permission, pr-bind, pr-resolve and review-approval (33 declarations). Other slices own all other behavior-05 declarations. Original files stay whole until their final disposition is proved.

Final disposition: **30 mapped, 3 retained verbatim, 0 pending**, four source files retired, three retained files added, six E2E declarations added. Batch counts below are historical checkpoints.

| Source file | Mapped | Retained | Final disposition |
|---|---:|---:|---|
| tests/merge-permission.test.ts | 12 | 1 | retired; declaration 13 in merge-permission-retained.test.ts |
| tests/pr-bind.test.ts | 9 | 0 | deleted |
| tests/pr-resolve.test.ts | 9 | 1 | retired; declaration 9 in pr-resolve-retained.test.ts |
| tests/review-approval.test.ts | 0 | 1 | moved verbatim to review-approval-retained.test.ts |

## Batch 1

Scenario 05-S14-permission: `tests/e2e/landing-forge-ci.test.ts`, `landing S14: repository permission reports the allowlist and each blocked cause`. Real CommandPost, real reporter/implementer, isolated mock-provider agent directory, real scratch git, scripted external gh. Each permission row has its own stack and real held report; success rows execute a forge merge.

| Source declaration in tests/merge-permission.test.ts | Status | Failing assertion under control |
|---|---|---|
| 1 CLEAN and HAS_HOOKS | mapped | S14-NC1: both named subcases fail /permission: permitted/ |
| 2 BLOCKED required review | mapped | S14-NC1: REVIEW_REQUIRED fails /pending (reviews).*1 approving review/ |
| 3 CHANGES_REQUESTED | mapped | S14-NC1: CHANGES_REQUESTED fails /pending (reviews)/ |
| 4 required checks | mapped | S14-NC1: required-check row fails /pending (checks).*test/ |
| 5 unreadable rules | mapped | S14-NC1: BLOCKED without rules fails /pending (unknown_block).*cannot read why/ |
| 6 BEHIND, DIRTY, DRAFT | pending | consumer gates need further assertions and controls |
| 7 UNSTABLE | mapped | S14-NC1: UNSTABLE fails /pending (unstable).*403/ |
| 8 UNKNOWN | mapped | S14-NC1 fails UNKNOWN status /permission: retry/; S14-NC2 fails CLEAN with UNKNOWN mergeability, actually merges |
| 9 absent/empty/new status | mapped | S14-NC2: all three subcases fail /permission: unreadable/ |
| 10 parser | pending | rules payload variants need further assertions and controls |
| 11 strict up-to-date rule | pending | existing stale-base scenario needs mapping/control verification |
| 12 endpoint args | pending | structural assertion disposition unresolved |
| 13 blocking wait shape | pending | structural assertion disposition unresolved |

Other files: pr-bind 9 pending; pr-resolve 10 pending; review-approval 1 pending. Total: 8 mapped, 0 retained, 25 pending; no deleted files.

## Executed controls

Command for both: `node --import ./tests/harness/hermetic-env.ts --test --test-concurrency=1 --test-timeout=300000 --test-force-exit --test-name-pattern='landing S14:' tests/e2e/landing-forge-ci.test.ts`.

- S14-NC1: in `src/merge-permission.ts`, replace status normalization with `const status = "BROKEN";`. Executed: eight independently named subcases fail their permission/cause assertions (review required, changes requested, checks, unknown block, unstable, unknown status, HAS_HOOKS, CLEAN). Four unaffected subcases pass. This models losing the forge merge-state field. Production source restored.
- S14-NC2: in the same source, remove `|| mergeable === "UNKNOWN"` from the retry guard and change the final fallback permission from `unreadable` to `pending`. Executed: CLEAN/UNKNOWN fails retry assertion with an actual merge; absent, empty and novel states each fail unreadable assertion, actually pending. Eight unaffected subcases pass. Both production changes restored.
- Earlier exploratory control removed both values from REVIEW_BLOCKING; REVIEW_REQUIRED failed the reviews/counted-review assertion. Not used for additional declaration credit.

All controls failed observable assertions after real workers reported; none failed fixture startup. Fixed run and further batches are recorded below as work proceeds.

## Batch 2

Scenario 05-S14-resolution: `landing S14: worker PR reports resolve against the registered origin and drive the CI watch` in `tests/e2e/landing-forge-ci.test.ts`. Real worker report_result calls are resolved by the real CommandPost intake; corrected receipts feed a real CI-watch tick. The external git shim preserves GitHub origin identity while routing repository transport to scratch git.

| Source | Declaration | Status | Control and failing assertion |
|---|---|---|---|
| tests/pr-resolve.test.ts | 1 typo owner corrected and named | mapped | S14-NC3 corrected: stored receipt URL is typo/demo, expected example/demo |
| tests/pr-resolve.test.ts | 2 missing PR refuses | mapped | S14-NC3 absent: expected correction reason /no PR is on branch.*example\/demo/, actual empty |
| tests/pr-resolve.test.ts | 3 gh down with mismatched owner refuses | mapped | S14-NC3 mismatch-down: expected correction /typo\/demo.*example\/demo/, actual empty |
| tests/pr-resolve.test.ts | 4 matching owner unverified | mapped | S14-NC3 matching-down: unverified run event count actual 0, expected 1 |
| tests/pr-resolve.test.ts | 5 watch uses corrected receipt | mapped | S14-NC3 corrected: the receipt consumed by the watch is wrong; fixed case also asserts repos/example/demo/pulls/151 and zero typo repository reads |
| tests/pr-bind.test.ts | 5 absent local checkout | mapped | S14-NC4 absent: leased HEAD differs from PR c2 |
| tests/pr-bind.test.ts | 6 behind checkout | mapped | S14-NC4 behind: leased HEAD differs from PR c2 |
| tests/pr-bind.test.ts | 7 diverged checkout preserves history | mapped | S14-NC5 diverged: salvage ref object id is empty, expected local commit |
| tests/pr-bind.test.ts | 8 occupied worktree refuses | mapped | S14-NC4 other-worktree: Missing expected rejection |
| tests/pr-bind.test.ts | 9 moved PR head refuses | mapped | S14-NC4 moved: Missing expected rejection |

Checkout scenario 05-S14-bind: `landing S14: binding an existing PR checks forge facts and preserves checkout history`. Consumer is real dispatch, actual leased git checkout, real bound worker report, and the model request containing the bound brief. Originals remain whole. Totals after batch 2: 18 mapped, 0 retained, 15 pending, 0 deleted files.

Executed controls (same node invocation as above, name pattern respectively `landing S14: worker PR` and `landing S14: binding`):

- S14-NC3, `src/pr-resolve.ts`: disable owner-mismatch fallback refusal; return verified instead of unverified for matching fallback; accept the worker URL when no PR exists; use `given ?? row.url` in the successful list resolution. All four independently named resolution subcases failed the assertions above. Restored all four mutations.
- S14-NC4, `src/pr-bind.ts`: early `return {};` in checkoutBoundBranch. Executed after placing actual-checkout assertions before report-settle waits. Absent, behind and diverged fail HEAD=c2; occupied and moved fail expected rejection. This is consumer evidence, not a fixture timeout. Restored.
- S14-NC5, `src/pr-bind.ts`: delete only the salvage `update-ref` command. Diverged fails salvage object-id equality, with four unaffected checkout cases passing. Restored.

Fixed resolution and checkout cases passed before mutations; final fixed rerun follows each checkpoint. No unit removal credit yet.

## Batch 3: first whole-file retirement

All 9 declarations in `tests/pr-bind.test.ts` are now mapped, with no retention. Deleted only after the fixed bound and unsafe scenarios passed (19 executed tests). Source history inspected: 580289b5c0f709bdc9ae28a50bf55dd12c38d04a (#238), including the original pr-bind production diff. Reference search found only migration evidence rows; no live docs/test/script reference needed retargeting.

| Source declaration | Status | Control and failing assertion |
|---|---|---|
| pr-bind 1 open/default-base by URL or number | mapped | S14-NC7: draft flag forced false; absent subcase fails actual worker prompt's complete bound identity/draft/head/base assertion |
| pr-bind 2 unsafe refs/facts | mapped | S14-NC6: all eight unsafe subcases fail Missing expected rejection |
| pr-bind 3 held/failed peer, done/self allowed | mapped | S14-NC9: held/failed fail Missing expected rejection; done and own-failed dispatch throw an incorrect holder refusal |
| pr-bind 4 branch history instructions | mapped | S14-NC8: absent/behind/diverged fail prompt assertion never rewrite or drop existing commits |

Exact additional executed production mutations, restored after each run:

- S14-NC6: replace `throw new DispatchError(...)` in readBoundPr's local refuse helper with `return undefined as never;`. All 8 unsafe rows actually dispatch instead of rejecting.
- S14-NC7: in readBoundPr's returned facts, replace `draft: row.isDraft === true` with `draft: false`. Absent row fails prompt identity; 4 unaffected checkout rows pass.
- S14-NC8: in boundPrNote replace final `never rewrite or drop existing commits.` with `rewrite existing commits freely.`. Three successful binding rows fail their actual model-request assertion; moved/occupied remain passing refusals.
- S14-NC9: replace assertBranchFree's finder predicate with `job.branch === head && (job.phase === "done" || job.job_id === jobId)`. All four holder variants fail. Own-failed uses a valid legacy failure record and an unrelated done peer, so the observed erroneous refusal names the job itself, not a different done job.

These controls use the same binding/unsafe focused commands recorded above. Total so far: 22 mapped, 0 retained, 11 pending; 1 deleted file. Remaining: permission 5, PR resolution 5, artifact approval 1. No unreachable behavior has yet required retention.

## Completion: final consumer controls and retained mixed declarations

| Source declaration | Disposition | Executed evidence |
|---|---|---|
| permission 6 | mapped | S14-NC17 fails all BEHIND/DIRTY/DRAFT/CLEAN-isDraft consumer permission assertions |
| permission 10 | mapped | S14-NC15 discards parsed rules; real one/two approving-review counts disappear from integration output |
| permission 11 | mapped | S14-NC14 inverts rulesRequireUpToDate; all seven independently named stale-base variants fail the requires-up-to-date output assertion |
| permission 12 | mapped | S14-NC16 targets wrong-base; real gh endpoint call assertion fails twice |
| permission 13 | retained | no public entry point feeds ghBranchRulesArgs output into detectCiWait: cp_integrate executes it directly, while the worker guard accepts worker-supplied commands; retain this compositional safety assertion verbatim |
| pr-resolve 6 | mapped | S14-NC10 removes bound dispatch in resolvePr; accepted bound cases become waiting instead of held; fixed run also asserts view 169 --repo and no list |
| pr-resolve 7 | mapped | S14-NC11 disables wrong-number and moved-branch guards; both real worker reports are wrongly accepted; correction-reason assertions fail with empty actual |
| pr-resolve 8 | mapped | S14-NC10 produces waiting instead of held; fixed report preserves bound URL receipt |
| pr-resolve 9 | retained | mixed declaration preserved verbatim: validateEnvelope rejects missing pr_url for delivery:pr before EnvelopeIntake.#resolvePr, so no real report can reach its missing-URL or no-given bound fallback assertions; reachable GitLab variants additionally covered by 05-S14-gitlab |
| pr-resolve 10 | mapped | S14-NC12 disables GitLab source-branch check; actual wrong-branch worker report is wrongly held and expected refusal is empty |
| review-approval 1 | retained | mixed declaration preserved verbatim: PipelineRunner.#authorize calls artifacts.info before matches, so missing-artifact matches cannot be reached; its only production write call uses questionSeq 1, never the declaration's sequence-2/3 overwrite; no public consumer accepts those inputs. Reachable authorization additionally covered by 05-S14-approval |

Additional executed production mutations, all restored:

- S14-NC10: delete `if (input.bound) return resolveBound(...)` in src/pr-resolve.ts. Seven binding/report subcases fail, including waiting != held and both correction reasons.
- S14-NC11: replace both wrong-bound-number and changed-head-branch conditions in resolveBound with false. Two bound report subcases fail /not the bound PR/ and /someone-else/ with empty actual.
- S14-NC12: replace GitLab source-branch condition with false. GitLab wrong-branch fails its expected correction reason; six unaffected GitLab subcases pass.
- S14-NC13: replace sha256 comparison in ReviewApprovalStore.matches with return true. Pipeline edited subcase is approved instead of pending; identical and absent pass.
- S14-NC14: negate the return expression in rulesRequireUpToDate. Seven stale-base subcases all fail requires-up-to-date boolean assertions, including actual false vs expected true for strict true and true vs false for all other variants.
- S14-NC15: replace parseBranchRules final return rules with return []. Both review-required subcases lose the one/two approving-review detail and fail.
- S14-NC16: return a fixed wrong-base rules endpoint from ghBranchRulesArgs. Both review-required subcases fail actual external endpoint equality.
- S14-NC17: force merge status BROKEN and disable isDraft guard. BEHIND, DIRTY, DRAFT and CLEAN/isDraft each fail their pending cause assertion with unreadable permission.
- S14-NC18: in src/ci-watch.ts ghPrRest, replace the parsed owner in the external REST path with typo. Corrected intake still succeeds and stores the canonical receipt; the actual watch call assertion repos/example/demo/pulls/151 fails. Three other resolution subcases pass. Restored. This independently proves watch consumption after the receipt assertion, rather than crediting an earlier intake assertion failure.

Commands: the node invocation above with name pattern landing S14: binding, landing S14: GitLab or pipeline S14: (phase3.test.ts), respectively. Permission controls use pattern landing S14: repository and test-skip-pattern to select baseAdvance (NC14), REVIEW_REQUIRED (NC15/16), or BEHIND/DIRTY/DRAFT/draft (NC17). These selectors skip subcases only; the real public entry points and production implementations remain intact. Fixed all-S14 landing run passed all 64 executed tests in 243 seconds before final retirements; approval fixed run passed all 4 tests. No production mutation remains.

The three retained declarations are byte-for-byte original bodies, not replacement tests or weakened assertions. They are reported as retained, never as redundant-unreachable or deletion credit. Reachable portions of the two mixed declarations have real consumer coverage despite retaining their whole declarations. See src/contracts/envelope.ts validation, EnvelopeIntake.#resolvePr, PipelineRunner.#authorize/#pinApproval and their caller searches for the exact boundary evidence.
