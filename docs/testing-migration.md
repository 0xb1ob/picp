# Unit → e2e test migration manifest

The auditable record of the unit-to-e2e programme: every test file in the pinned baseline gets exactly one
disposition, every deleted unit assertion maps to an e2e scenario, and every deleted regression test carries a
negative control (the old defect patched back fails the e2e, the fix passes it). `scripts/test-migration-check.ts`
validates this file and the per-slice ledger against git; it imports no production code.

The ledger rows are moving out of this file, one file per slice, into `docs/testing-migration/<slice>.md`: that
slice's rows of the seven `manifest:*` tables and its regression patch blocks. The checker reads this file and every
slice file as one union, so duplicate ids and the baseline counts are checked across both. A new slice adds its own
file. `node scripts/split-migration-ledger.ts --list | <slice...>` moves rows mechanically; never hand-move them.

```
node scripts/test-migration-check.ts --base 0a4a8944dd7292e458dbd2ec4afbf6d2b89d197e --manifest docs/testing-migration.md
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --verify-regressions
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --runner-log <saved test:one output>
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --preserved-from <ref before a split>
```

Baseline sha: `0a4a8944dd7292e458dbd2ec4afbf6d2b89d197e`

The baseline is 400 `tests/**/*.test.ts` files with 4,487 static declarations (calls to the bare `test`
identifier, counted on the TypeScript AST). Static declarations are not executed cases: the runner's own
`ℹ tests N` totals are reported separately, and only from a supplied log.

## Dispositions

| Disposition | Meaning | Evidence required |
|---|---|---|
| `convert` | Candidate for its owner PR's e2e conversion; stays until that PR passes the deletion gate | `behavior <id>` of a Conversion PRs row |
| `e2e` | Already an e2e acceptance file (`tests/e2e/`) | the reason it stays |
| `retained` | Kept on purpose; not deletable yet | the reason and a link |
| `exception` | Structural, golden, contract or security check kept by policy | the policy link (see Exceptions) |
| `deleted` | Removed; every assertion mapped or redundant-unreachable, and a negative control recorded | assertion map + regression row |
| `deleted-with-feature` | Removed with the production feature it tested; nothing is left to patch back | owner names the removing PR/job; evidence cites the removed source modules |

P1 completed the manifest: the checker refuses any other disposition, so a new baseline row cannot stay undecided.

## Method

Standing rule 3, approved by the main session under ask-0088e0332d00 on 2026-10-20: an assertion that cannot reach a
public consumer is `redundant-unreachable` when an e2e case pins the consumer-visible outcome of that path. The e2e case
must be named, and the checker enforces it. Otherwise the assertion stays and the worker reports it. Do not mock
internals to reach it. This rule holds for P1–P24. The checker accepts `redundant-unreachable` only with a named,
existing scenario, and refuses to delete a file that still holds an `unreachable` assertion.

A `convert` file is deleted only by its owner PR, and only when every assertion in it has a row in the assertion map and
every regression it guards has a negative control. A file whose assertions belong to another unfinished behavior is split
or waits; a partly converted file is never counted as removed.

A test file whose production feature is removed is `deleted-with-feature`, not `deleted`: no consumer remains, so it
needs no assertion map and no negative control. Its owner must name the removing PR (`#123`) or job (`cp-…`), and its
evidence must cite the removed `src/` or `extensions/` modules it tested; the checker confirms each cited path is gone.
A kept file that loses declarations with a removed feature gets one `feature-removed` row per lost declaration in the
Feature-removed section: its baseline title (still absent from the tree) and the removing PR/job. The checker accepts a
net loss in a kept file only when that many rows cover it. Decided by the main session as programme owner under
ask-0088e0332d00, 2026-10-21.

## PR ledger

| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P0 (cp-e2e-migration-p0-pilot-xp6x) | behavior 01; this manifest; the check script | 1 (`tests/ci-run-ref.test.ts`) | 400 → 400 | 4,488 → 4,487 |
| P1 (cp-e2e-migration-p1-policy-census-gtep) | policy texts; every baseline disposition; per-PR census | 0 | 400 → 400 | 4,497 → 4,497 |
| P2 (cp-e2e-migration-p2-tyir) | behavior 02, first slice: `tests/e2e/authority.test.ts`. P2 is a first slice; the remaining 12 behavior-02 files belong to P2b (cp-e2e-migration-p2b-3e1w); send-first-gate moves to behavior 06 / P4. | 1 (`tests/budgets.test.ts`) | 398 → 398 | 4,464 → 4,466 |
| P2b (cp-e2e-migration-p2b-3e1w) | behavior 02, second slice: held-job cap counting and ops jobs (02-5, 02-6) in `tests/e2e/authority.test.ts`. The other 11 behavior-02 files move to P2c (job to be created by the main session). | 1 (`tests/ops-jobs.test.ts`) | 398 → 397 | 4,467 → 4,465 |
| P2c (cp-e2e-migration-p2c-wtsd) | behavior 02, third slice: keyword risk inference (02-7), mandate defaults and the issue ladder (02-8), and the P2b review's two lows (NC-11; 02-5 raises through `cp_mandate raise_tokens`). The other 9 behavior-02 files move to P2d (8) and P2e (`tests/mandate.test.ts`). | 2 (`tests/risk-negation.test.ts`, `tests/mandate-defaults.test.ts`) | 394 → 392 | 4,415 → 4,393 |
| P2d (cp-e2e-migration-p2d-k5to) | behavior 02, fourth slice: the risk warning (02-9), risk:high pre-approval (02-10), batch risk:high (02-11), grant selection and supplements (02-12), live mandate usage (02-13) and the gateway's capacity and quota (02-14), and the P2c review's two lows. `tests/mandate.test.ts` stays with P2e. | 8 (`tests/capacity.test.ts`, `tests/mandate-selection.test.ts`, `tests/mandate-supplement.test.ts`, `tests/mandate-usage.test.ts`, `tests/quota.test.ts`, `tests/risk-batch.test.ts`, `tests/risk-preapproval.test.ts`, `tests/risk-warning.test.ts`) | 392 → 384 | 4,393 → 4,346 |
| P2e (cp-e2e-migration-p2e-fmi5) | behavior 02, last slice: a pipeline's mandate-decided plan checkpoint (02-15), cp_mandate and cp_escalate through a real parent (02-16), and in-flight continuation under expired, revoked, serial and capped grants (02-17); the P2d review's three findings. No behavior-02 file remains; send-first-gate belongs to P4. | 1 (`tests/mandate.test.ts`) | 384 → 383 | 4,346 → 4,295 |
| P3 (cp-e2e-migration-p3-rhym) | behavior 05, first slice: the Actions CI read behind cp_integrate, the CI watch and `/status` (05-1), the no-CI workflows question (05-2), `/doctor` `ci.<project>` (05-3) and the one infra-only rerun (05-4) in `tests/e2e/landing.test.ts`; the P2e review's three findings. The other 26 behavior-05 files stay `convert`, for P3b (a job the main session creates). | 4 (`tests/actions-ci.test.ts`, `tests/ci-access.test.ts`, `tests/ci-configured.test.ts`, `tests/ci-infra-rerun.test.ts`) | 385 → 382 | 4,300 → 4,287 |
| P3b (cp-e2e-migration-p3b-stth) | behavior 05, second slice: merge receipts and landing proof in `tests/e2e/landing.test.ts`: cp_merged through `gh` with the after-merge deploy job (05-5), cp_merged against a local https GitLab (05-6), and cp_teardown's git-only landing proof (05-7). The other 23 behavior-05 files stay `convert` (owner P3), for P3c (a job the main session cuts). | 3 (`tests/after-merge.test.ts`, `tests/landing-proof.test.ts`, `tests/merges.test.ts`) | 382 → 379 | 4,287 → 4,272 |
| P3c (cp-e2e-migration-p3c-l5fc) | Approved partial delivery (ask-c77a4f32b23b). [Per-file accounting](testing-migration-p3c-declarations.md): 13/143 declarations mapped, 2 retained, 128 pending. Five unfinished files are convert-owned by P3c-rest for follow-on slices. | 2 files deleted (ci-evidence, parked-ci); 8 declarations removed; timer rename earns zero deletion credit | 379 + 1 incoming → 378 | 4,272 + 4 incoming → 4,274 |
| P3c-rest main-ci (cp-e2e-slice-main-ci-41d3) | Whole-file retirement: 39 = 32 mapped + 7 retained (17.95%), 0 pending; mixed declarations retain only unreachable assertions. Controls and entry-point map: docs/testing-migration-main-ci-declarations.md. Collector waived. | 1 (`tests/main-ci.test.ts`) | 378 → 378 (one retained replacement) | 4,281 → 4,253 (32 units removed, 4 e2e declarations added) |
| S02 (cp-e2e-slice-s02-l7ph) | behavior 05; `tests/ci-watch.test.ts` declarations 1–40: 36 mapped, 4 mixed/unreachable and kept in place; five added e2e declarations, 05-8 extended. S03 owns 41–80 and whole-file retirement. | 0 (split-file bookkeeping: all units stay) | 378 → 378 | 4,274 → 4,279 |
| S03 / S03b (cp-e2e-slice-s03-r5f7 / cp-e2e-slice-s03b-pntl) | behavior 05; 39 S03 mapped, 1 pending-fix (71) parked by frozen Addendum 1. S02 6/8/32/33 retained verbatim in tests/ci-watch-retained.test.ts. #443 is on main; the blocker is gone. S10b owns mapping 71 and retirement by sequencing decision. [Decision/evidence](testing-migration-s03-declarations.md), [controls](testing-migration-s03b-controls.md). | 1 retained file; 0 deleted files; original stays whole | retained copies add 4 declarations | 80 original declarations unchanged |
| S07 (cp-e2e-slice-s07-eaux) | P3c-rest behavior 05: only integrate-held-ci; 3 mapped, 0 retained, 1 deleted file; extends 05-13 and adds 05-S07; all other slices retain their ownership | 1 (`tests/integrate-held-ci.test.ts`) | 378 → 377 | 4,274 → 4,272 (3 removed, 1 added) |
| S04 (cp-e2e-slice-s04-vep1) | behavior 05; original `tests/diff-review.test.ts` declarations 1–40. [Declaration accounting](testing-migration-s04-declarations.md): 38 mapped, 2 retained, 0 pending in S04; S05 owns 41–55 and whole-file retirement. | 0; baseline intentionally kept whole | +1 incoming e2e file | 55 source declarations unchanged; +13 e2e scenarios |
| S05 (cp-e2e-slice-s05-mzpm) | behavior 05; declarations 41–55 and final retirement of `tests/diff-review.test.ts`. [S05 accounting and controls](testing-migration-s05-declarations.md): 15 mapped; whole file 53 mapped, 2 retained declarations plus the split unknown-job guard. | 1 original file retired; retained replacement is not deletion credit | +1 retained file (convert-owned P3c-rest), 3 tests; +7 e2e scenarios | -55 original declarations, +3 retained, +7 e2e = -45 net declarations |
| S06 (cp-e2e-slice-s06-15yh) | All four whole files accounted for: 40 declarations, 24 mapped and 16 retained; six new landing consumer cases. | 4 | unchanged (four source files replaced by four retained files) | 40 source declarations → 16 retained + 6 new e2e cases |
| S08 (cp-e2e-slice-s08-9p6d) | behavior 05; `tests/integrate.test.ts` static declarations 1–40: 38 mapped, 2 retained mixed declarations; [range accounting](testing-migration-s08.md); nine added landing declarations; later ranges keep their ownership | 0; the entire unit file stays unchanged | 378 → 378 | 4,290 → 4,299 (+9 e2e) |
| S15 (cp-e2e-slice-s15-764h) | behavior 05; whole-file review-context, review-merge-window, review-runs and review-tool; [declaration accounting](testing-migration-s15.md); 38 closed: 32 mapped, 6 retained (15.8%); 2 whole files deleted, 2 moved to retained subsets | 2 deleted; 2 moved-retained (no deletion credit) | 378 → 376 (on merged base); slice sources 4 → 2 | 4,204 → 4,185; slice 38 → 6 retained + 13 added consumer declarations |
| S14 (cp-e2e-slice-s14-zm4e) | behavior 05; [declaration accounting and executed controls](testing-migration-s14.md): 30 mapped, 3 retained verbatim with unreachable-input evidence, 0 pending | 4 original paths retired (3 mixed moved/split) | +3 retained files | +6 e2e declarations |
| S09 (cp-e2e-slice-s09-wznx) | behavior 05; `tests/integrate.test.ts` static declarations 41–80: 34 mapped, 6 retained mixed/internal declarations; [range accounting](testing-migration-s09.md); eight added landing declarations; later ranges keep their ownership | 0; the entire unit file stays unchanged | 378 → 378 | 4,282 → 4,290 (+8 e2e, after S06 merge) |
| S10 (cp-e2e-slice-s10-4dzb) | behavior 05; integrate declarations 81–120: 38 mapped, 1 retained mixed, 1 pending-fix (92); [range ledger and executed patch controls](testing-migration-s10.md); S09 carry-ins reconciled | 0; original unit file stays whole | unchanged | +6 e2e declarations |
| S20 (cp-e2e-slice-s20-8nn3) | behavior 06; complete: 25 mapped/13 retained/0 pending across all 38 declarations; [final assertion accounting](testing-migration-s20.md); 47 executed production controls | 1 fully mapped file deleted; 3 mixed paths replaced by retained files, without deletion credit | 3 e2e consumer files; delivery shared with S19/S21 and lifecycle shared with S19; net 0 test files against merged base; existing held-home fixture shared with S19 | -38 original +13 retained +22 static e2e = -3 net declarations (24 e2e runtime cases) |
| S21 (cp-e2e-slice-s21-5gtl) | behavior 06; [declaration map and replayed controls](testing-migration-s21.md): 15 mapped, 7 retained/moved verbatim, 0 pending | 1 original path retired; mixed retained replacement is not deletion credit | +1 net file: +1 e2e, +1 retained, -1 source | -22 source, +7 retained, +9 e2e = -6 net declarations |
| S16 (cp-e2e-slice-s16-koqy) | behavior 05; reviewer-model whole file: 3 mapped, 0 retained, 1 deleted file; [declaration accounting](testing-migration-s16.md); other slices retain their ownership | 1 | 378 → 378 | 4,204 → 4,203 (3 removed, 2 added) |
| S19 (cp-e2e-slice-s19-jiwz) | behavior 06; [declaration evidence](testing-migration-s19.md); 28 mapped, 9 retained, 0 pending across all 37 declarations in five original files; 11 static e2e declarations | 5 original paths removed; 9 declarations retained/moved verbatim in 3 replacements earn no deletion credit | 379 → 381 (original: origin/main 695a8528 → pre-merge S19 3c6568f); 384 → 384 (wrapper split: 56ca846 → split tree) | 4,205 → 4,188 (original); 4,186 → 4,186 (wrapper split; measured static declarations) |

S19 carry-in (main session carry-in, S14 review 1): baseline `deleted` labels describe absent original paths.
The checker requires this even when declarations move: `scripts/test-migration-check.ts` rejects an absent
baseline path marked `retained` and has no `moved` disposition. The nine moved declarations remain explicitly
`retained` in the assertion map and their three replacement files are incoming retained/moved evidence;
they earn no declaration deletion credit. All 30 S19 controls have a regression row, SHA-256, patch and matching
closing marker. The totals above count all tracked test files/static declarations at the named base and HEAD.

S19 operator-approved split measurements (local, milliseconds; each top-level case has a 120,000-ms timeout):

| Scenario | Variant | Initial pass ms | Clean repeat ms |
|---|---|---:|---:|
| S19-4 | ready | 3,178.1 | 3,070.6 |
| S19-4-revise | revise | 2,541.6 | 3,981.3 |
| S19-4-red | red | 2,617.2 | 4,015.7 |
| S19-4-running | running | 2,648.8 | 2,643.9 |
| S19-4-late | late | 68,726.4 | 68,853.8 |
| S19-4-late-failure | late-failure | 68,819.2 | 68,715.4 |
| S19-9 | race | 28,446.2 | 28,741.1 |
| S19-9-failure | failure | 33,522.6 | 34,161.4 |
| S19-9-late | late | 111,481.6 | 112,223.6 |

These are independent top-level registrations with fresh fixtures, not aggregate durations. Both variant callback bodies are AST-equal to their pre-split bodies. Logs: worktree-local `node_modules/.cache/s19/split-headless.log` and `split-deferred.log`.

S06 foreign-watch proof: the source file's blob before deletion was `537b98df76fc920162dc01aeb31cea9775f3a4ab`.
V8 e2e-only captures on both sides of deletion each include nine product processes and cover 338 lines of
`src/foreign-ci-watch.ts`, with no gained or lost lines (source SHA-256
`2ccacd9909526f0cf24520f979996baf78f6ccfc560a31700ffdbcd050200276`). Captures and the comparison command
live in the S06 artifact directory. Comparing the direct unit capture to e2e gives nine apparent lost lines,
373–381, all in `formatForeignCiNotice`: pi transforms extension imports, so raw child V8 offsets alone do not
prove source-mapped coverage of that formatter. S06-1 instead pins its actual operator RPC/UI notice: the foreign
PR URL, green head, and evidence-only disclaimer. The retained test covers static import/port inspection.
S06-timeout and S06-moved are semantic mutations run against the real entry-point scenarios; both fail their
named assertions and the fixed 15-case file passes without skips before and after deleting the source file.

S06 forge-runtime proof: original blob `042537e3e52c67ad40c2feaa63f0a5f1c4ebcdac`; the three retained
regression bodies are unchanged. E2e-only V8 captures before/after retirement each include nine product
processes and cover 94 lines of `src/forge-runtime.ts`, with no lost or gained lines (SHA-256
`f7025eb885c798fb40b3f815ba62583213ca8209585f10d236ea9b4a53030017`). The fixed landing file passes
17/17 without skips; the retained file passes 3/3. Legacy-fallback and configured-trunk controls fail the
actual merge recording and teardown outcome, respectively. Patch blocks use zero context (`git apply --unidiff-zero`).

S02 follows the operator's split-file amendment: a range slice adds consumer evidence without removing or moving any
unit declaration. `tests/ci-watch.test.ts` remains 80 static declarations / 89 executed cases. No checker or contract
changes are required. Of the owned 40, 36 map to the five S02 scenarios and extended 05-8; four stay explicitly
`unreachable` in the assertion map (declarations 6, 8, 32, 33). Fleet validation rejects held records without an envelope
on disk; Actions parsing rejects id-less runs; CommandPost supplies no onDisabled callback to observe its call count.
Those helper inputs need preservation by the final range owner. Their reachable outcomes have consumer assertions.
There are no new redundant-unreachable claims or deleted-file credits.
S02 records 24 controls (eight initial plus sixteen review controls); every mapped declaration cites an executed
control in the regression table. All source mutations were restored. No original unit coverage is removed.

P0 deletes `tests/ci-run-ref.test.ts` (3 declarations) and adds `tests/e2e/ci-evidence.test.ts` (2). Ten of the
unit file's 14 assertions are pinned by a scenario. The other four cannot reach a public consumer and are
`redundant-unreachable`, as approved by the main session under ask-0088e0332d00 on 2026-10-20. Incoming files
from the parallel E2E A/B/C jobs are listed under Incoming as they land, not in the baseline. The P0 counts are
taken on P0's base (`af46cfbf091439d98138f35c80254e74e484ee75`). They start at 4,488, not 4,487, because
`tests/e2e/planner-blocked.test.ts` gained one declaration after the pinned baseline. Baseline files keep
changing on main, so the checker prints the live tree's counts instead of trusting this row.

P1 (cp-e2e-migration-p1-policy-census-gtep) deletes no test. It applies the e2e-default test policy and standing
rule 3 to `AGENTS.md`, the implementer and planner profiles, the ship and research briefs, the diff-review rubric,
`docs/development.md`, `tests/e2e/README.md` and `evals/corpus.json`. It gives every baseline path a final
disposition, and the checker now prints each conversion PR's census.

P2 (cp-e2e-migration-p2-tyir) adds `tests/e2e/authority.test.ts` (4 cases, scenarios 02-1 to 02-4) and deletes
`tests/budgets.test.ts` (2 declarations): all six of its assertions map to 02-4, under negative control NC-04.
P2 is a first slice; the remaining 12 behavior-02 files belong to P2b (cp-e2e-migration-p2b-3e1w); send-first-gate
moves to behavior 06 / P4. Their baseline rows name those owners, and none is deleted before its assertions are
mapped one by one. Two of the plan's assumptions did not hold against the tree. An operator-paused or
revoked grant is *silent* for dispatch (`GRANT_MATRIX`, `src/mandate-permission.ts`), not refusing: 02-2 pins that
such a dispatch runs under no grant. A replacing `issue` supersedes the old grant's open ask by itself, so 02-3 pins
the superseded record and an empty later `supersede_stale` sweep. Held-job cap counting belongs to P2b.

P2b (cp-e2e-migration-p2b-3e1w) adds two cases to `tests/e2e/authority.test.ts`. 02-5 closes the gap left in 02-4: a
held PR job counts toward the job cap and the spend cap but never holds a dispatch slot (NC-05, NC-06). 02-6 replaces
`tests/ops-jobs.test.ts` (4 declarations): 17 of its 18 assertions are mapped (NC-07 to NC-09), and one is
`redundant-unreachable` under standing rule 3. P2b does not convert the other 11 behavior-02 files.
`tests/mandate.test.ts` alone is 98 KB across 61 cases, and those 11 files hold about 140 cases, which is more than
one reviewable slice. They move to P2c, a job the main session creates. NC-05 and NC-06 name `tests/mandate.test.ts`,
which pins the same rule at unit level and stays until it is converted.

P2c (cp-e2e-migration-p2c-wtsd) adds 02-7 (keyword risk inference, replacing `tests/risk-negation.test.ts`) and 02-8
(mandate defaults and the issue ladder through a real pi parent, replacing `tests/mandate-defaults.test.ts`), and folds
in the P2b review's two lows: NC-11 drops a held job from the job count alone, and 02-5 raises the paused grant's token
cap through `cp_mandate raise_tokens` in the parent. 02-6 still spends the recovery attempt with a direct
`recordRecoveryAttempt`: only a real worker death spends it, and that death would revive the worker the scenario needs
dead. The other 9 behavior-02 files were re-cut on measured sizes (main-session decision of 2026-10-20 19:41Z,
confirmed ps-20261021013902-85977f1f): P2d (cp-e2e-migration-p2d-k5to) owns capacity, mandate-selection,
mandate-supplement, mandate-usage, quota, risk-batch, risk-preapproval and risk-warning; P2e
(cp-e2e-migration-p2e-fmi5) owns `tests/mandate.test.ts`.

P2d (cp-e2e-migration-p2d-k5to) adds six cases to `tests/e2e/authority.test.ts`, 02-9 to 02-14, and deletes its eight
files (56 declarations) under negative controls NC-13 to NC-20, one per file. 02-13 crashes its worker twice: bounded
recovery and `cp_revive` each relaunch it on the same usage observer. 02-14 stubs `globalThis.fetch` for the gateway, an
external service like the LLM. Seven assertions are `redundant-unreachable` under standing rule 3, each naming its
scenario. No entry point reaches three of them, so they stay as units. The live usage view that cp_mandate and cp_decide
read moves to `tests/structure.test.ts`, because the e2e parent is a separate process and owns no live run. #321's
legacy fire grant and draining schedule run go to `tests/schedule-authority.test.ts`, because no fire mints a grant or a
legacy run any more. The supplement's path and subsystem exclusions went to `tests/decide.test.ts`, because P2d drove
no pipeline auto-decide; P2e drives them there (02-15) and removes that unit. The P2c review's lows: 02-7 names the
`acceptedRiskMatches` consumer that pins the low-risk row (Assertion map), and 02-6's `recordRecoveryAttempt` comment
is two lines.
`tests/e2e/authority.test.ts` joins R1_ALLOWED in place of `tests/quota.test.ts`: 02-14 writes the legacy top-level
`data/capacity.json` that cp-u3i2 must ignore. P2d's declaration count is 4,346, not 4,344: it added one declaration
each to `tests/decide.test.ts` and `tests/schedule-authority.test.ts` (P2e review finding).

P2e (cp-e2e-migration-p2e-fmi5) adds three cases to `tests/e2e/authority.test.ts` and deletes `tests/mandate.test.ts`
(61 declarations), under negative controls NC-21 to NC-23 beside P2b's NC-05, NC-06 and NC-11. 02-15 runs a real
pipeline (planner, gate reviewer, plan checkpoint) and lets the mandate decide the checkpoint: it is the consumer
that hands a grant the task text, so the path, subsystem and scaffolded `**/.env*` exclusions, the gate flags and the
denied project are driven there. 02-16 drives cp_mandate, cp_job, cp_escalate and cp_awaiting through a real pi
parent, with a scripted `gh` for objective refs. 02-17 drives dispatch, cp_send promotion and repair, and cp_decide on
diff and ship checkpoints, under expired, revoked, serial, job-capped and cap-paused grants. Eight units are `retained`:
moved verbatim to `tests/decide.test.ts` (owned by P10), because no e2e drives them. They are the `grantStanding`
matrix (216 cells), the reviewer-start table (a cp_review start needs a pushed PR head), two accounting edges (a
shrinking usage reading, a reviewer-run baseline), reviewer spend from diff-review and quality-panel runs pausing a
grant on its USD cap (no scenario starts either run), the store's second-precision instants (cp_mandate hands it no
millisecond instant), and two legacy grant shapes (no usage_baseline; paused on job_cap). Of those eight, the
grantStanding matrix, the reviewer-start table and the two accounting edges were already split out in the first
commit; the P2e review moved the other four. `retained` is a new assertion-map status: the
assertion still runs as a unit in the file the note names, so it neither pins a scenario nor blocks a deletion. The
P2d review's findings: 02-15 drives the exclusion row, #321's schedule half is `retained`, and P2d's count is 4,346.

P3 (cp-e2e-migration-p3-rhym) adds `tests/e2e/landing.test.ts` (4 cases, 05-1 to 05-4) and deletes four of behavior
05's 30 files (30 declarations) under negative controls NC-24 to NC-27, one per scenario. Behavior 05 is about 1 MB of
unit tests (`tests/integrate.test.ts` alone is 192 KB), far past one reviewable diff, so P3 is a first slice: the CI
read, its configuration, its doctor probe and its infra rerun. Each case runs a real CommandPost with mock-provider
implementers that push and report, a scratch remote and a scripted `gh` on PATH; cp_integrate, the CI watch tick,
`/status` and `/doctor` are the consumers. P3 originally retained ten units. After #416's review,
the normalization, budget, runner and rendered viewer parity assertions are mapped to 05-11,
05-main-deadlines and 05-1; the infra classifier maps to 05-4. Only path-builder boundaries,
legacy ciReadDenied strings and unreachable rerun guards remain in `tests/main-ci-retained.test.ts`.
The throwing-runner `ghCiConfigured` stays in `tests/merge-ask.test.ts`. Plan and tree disagree once: the infra rerun's drain
guard is unreachable from cp_integrate, which reads no CI at all while draining (05-4 pins that); only the main CI
watch reaches it. It also folds in the P2e review: the expired-grant matrix and the after-expiry sub-asserts are
`retained` in `tests/decide.test.ts`, and the checker refuses a `retained` row whose note names no kept test file.

P3b (cp-e2e-migration-p3b-stth) adds three cases to `tests/e2e/landing.test.ts` and deletes three of the 26 remaining
behavior-05 files (24 declarations) under negative controls NC-28 to NC-31, one per file and at least one per
scenario. The slice is the merge receipt and the landing proof: what cp_merged records from a forge's answer, the
after-merge deploy job it creates, and what cp_teardown accepts as git evidence once the head branch is gone. 05-5 and
05-6 drive cp_merged on real held jobs and on seeded legacy fleet records (a bound PR, no PR receipt); 05-6 serves the
GitLab REST API and the repository (`git http-backend`) from one local https server with a throwaway certificate, so the
project's real GitLab observer, its token and git's fast-forward check all run. 05-7 tears down held local jobs whose
branches were merged, squashed, rebased or never landed on the scratch remote. Six units were retained at the
P3b handoff. S06 preserves the three landing-proof boundaries in `tests/forge-runtime-retained.test.ts` and the
receipt reader in `tests/forge-observers-retained.test.ts`; S06-2 replaces the throwing-port and ledger-refusal
units through real ledger corruption. The current S06 dispositions supersede the original P3c handoff.
The P2e review's three findings were already folded in by P3. P3b folds in the P3
review's two lows: the seven units P3 retained in the P1 exception `tests/actions-ci-policy.test.ts` move verbatim
to `tests/main-ci.test.ts`; #416 subsequently mapped five more and narrowed mixed guards, leaving only internal assertions in `tests/main-ci-retained.test.ts`. The two "run by hand" sub-asserts (the
upper-case head, the missing-gh ENOENT) now name the exact patch, command and failing assertion.

## Conversion PRs

One row per later PR. Its candidate deletion set is every baseline row whose owner is that PR. The checker prints
each PR's exact file count and its static declarations, both at the baseline and in the live tree; the live tree is
the count at that PR's own base. Per the plan, a PR's local count goes from `F` files / `D` declarations to 1 file
(0 when it extends an existing e2e file) / `N` declarations. The suite delta is `1−F` files and `N−D` declarations.
`N` may rise when uncovered acceptance needs it.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P2 | 02 | `tests/e2e/authority.test.ts` | 4 |
| P2b | 02 | `tests/e2e/authority.test.ts` | adds 02-5 and 02-6 |
| P2c | 02 | `tests/e2e/authority.test.ts` | adds 02-7 and 02-8 |
| P2d | 02 | `tests/e2e/authority.test.ts` | adds 02-9 to 02-14 |
| P2e | 02 | `tests/e2e/authority.test.ts` | adds 02-15 to 02-17 |
| P3 | 05 | `tests/e2e/landing.test.ts` | 4 (05-1 to 05-4) |
| P3b | 05 | `tests/e2e/landing.test.ts` | adds 05-5 to 05-7 |
| P3c | 05 | `tests/e2e/landing.test.ts` | partial delivery: 05-8–05-13 provide consumer coverage; ci-evidence and parked-ci retired; five unfinished files continue under P3c-rest |
| cp-e2e-slice-main-ci-41d3 (#416) | 05 | `tests/e2e/landing.test.ts` | main-CI: 39 source declarations, 32 mapped with executed controls, 7 retained (mixed tests narrowed), 0 pending; 05-11/05-4/05-1 extended and 4 scenarios added; docs/testing-migration-main-ci-declarations.md |
| P3c-rest | 05 | `tests/e2e/landing.test.ts` | ci-watch: 75 mapped, 4 retained in tests/ci-watch-retained.test.ts, 1 pending-fix (71) parked by frozen Addendum 1. #443 is on main; S10b owns mapping 71 and retirement by sequencing decision. Main-CI's 39 declarations are accounted in #416. [Evidence](testing-migration-s03-declarations.md), [controls](testing-migration-s03b-controls.md). |
| S08 | 05 | `tests/e2e/landing.test.ts` | integrate declarations 1–40: 38 mapped, 2 retained (5%), 0 deleted files; nine scenarios added and 05-13 extended; [range ledger](testing-migration-s08.md); original unit file kept whole |
| S09 | 05 | `tests/e2e/landing.test.ts` | integrate declarations 41–80: 34 mapped, 6 retained (15%), 0 deleted files; eight scenarios added; [range ledger](testing-migration-s09.md); original unit file kept whole |
| S10 | 05 | `tests/e2e/landing.test.ts` | integrate declarations 81–120: 38 mapped, 1 retained mixed, 1 pending-fix (92), 0 deleted files; six added scenarios and 05-S02-5 extended; [range ledger](testing-migration-s10.md); original unit file kept whole |
| S16 | 05 | `tests/e2e/reviewer-model.test.ts` | 2 added declarations: S16-model here and S16-auto in landing; 3 units mapped, 0 retained, 1 deleted file |
| S21 | 06 | `tests/e2e/wake-delivery.test.ts` | 15 mapped, 7 retained/moved, zero pending; nine added e2e declarations across wake-delivery, bounds and diff-review; original path retired with a retained replacement |
| P4 | 06 | `tests/e2e/wake-delivery.test.ts` | up to 3 |
| P5 | 07 | `tests/e2e/compaction.test.ts` | up to 4 |
| P6 | 08 | `tests/e2e/drain-restart.test.ts` | up to 3 |
| P7 | 03 | `tests/e2e/dispatch-acceptance.test.ts` | up to 4 |
| P8 | 04 | `tests/e2e/worker-recovery.test.ts` | 5 |
| P9 | 11 | `tests/e2e/operator-delivery.test.ts` | 5 |
| P10 | 09 | `tests/e2e/decisions.test.ts` | up to 3 |
| P11 | 10 | `tests/e2e/research-delivery.test.ts` | up to 4 |
| P12 | 16 | `tests/e2e/remote-access.test.ts` | 5 |
| P13 | 12 | `tests/e2e/schedules.test.ts` | 5 |
| P14 | 15 | `tests/e2e/service.test.ts` | 5 |
| P15 | 13 | `tests/e2e/project-tracker.test.ts` | 4 |
| P16 | 14 | `tests/e2e/configuration.test.ts` | 4 |
| P17 | 17 | `tests/e2e/viewer-control.test.ts` | 3 |
| P18 | 18 | `tests/e2e/viewer-jobs.test.ts` | 4 |
| P19 | 19 | `tests/e2e/viewer-conversations.test.ts` | 4 |
| P20 | 20 | `tests/e2e/viewer-settings.test.ts` | 3 |
| P21 | 21 | `tests/e2e/viewer-serving.test.ts` | 4 |
| P22 | 22 | `tests/e2e/reports-push.test.ts` | 4 |
| P23 | 23 | `tests/e2e/memory.test.ts` | 3 |
| P24 | 24 | `tests/e2e/host-compatibility.test.ts` | 3 |
| S24 | 07 | `tests/e2e/operator-compact.test.ts` | 35 |
<!-- /manifest:prs -->

The plan proposed 6 cases for all of behavior 05. P3 is a first slice of 4 cases over 4 files. P3b
(cp-e2e-migration-p3b-stth) is the second, 3 cases over 3 files (merge receipts and the landing proof). The other 23
behavior-05 files keep their `convert` rows (owner P3) for P3c, which the main session cuts.

The census (files and declarations per conversion PR) is printed by the checker and is not committed.

Reconciled against the plan's behavior map, which names its candidates by bare name:

- `tests/model-call-failure-recovery.test.ts` is listed under 04 and 14; it is owned by 04 (P8) only.
- `tests/awaiting-merge-resume.test.ts` is listed under 18 and 23; it is owned by 18 (P18) only.
- `restartActivity` (08) and `viewer-pending-sends` (17) are not test files, and neither is `blocked-jobs` (23):
  `src/blocked-jobs.ts` exists, `tests/blocked-jobs.test.ts` does not. None of these names is a deletion.
- `tests/script-jobs.test.ts` was in no row. It is owned by 04 (P8): its cases are script-worker lease, spawn-claim
  and restart recovery.

## Exceptions

These 36 baseline files stay as non-e2e checks. The operator kept them by approving the plan ("Pilot, then
continue", ask-0088e0332d00). A behavioral case inside one of them may still move to e2e, but the file and the
contract it holds stay. Also kept, though outside the 400-file count: `scripts/test-file-guard.ts`, every
`tests/golden/` fixture a kept test reads, `evals/corpus.json`, `evals/results/contract.json` and `npm run eval:check`.

- 26 contract, golden and guard files. Contract and golden: `tests/actions-ci-policy.test.ts` (the disallowed forge
  read surface), `tests/ci-wait.test.ts` (worker report-and-stop), `tests/contract.test.ts`,
  `tests/contract-injection.test.ts`, `tests/contracts.test.ts`, `tests/contracts-anchors.test.ts` and
  `tests/contracts-exports.test.ts` (schema, prompt and export consistency, golden compatibility),
  `tests/evals.test.ts` (the offline prompt corpus), `tests/extension-deps.test.ts` and
  `tests/pi-server-dependency.test.ts` (package boundaries), `tests/layout-capture.test.ts`,
  `tests/parent-session.test.ts`, `tests/planner-artifact.test.ts` and `tests/profiles.test.ts` (assembled layout,
  session, role and artifact contracts), `tests/schedule-policy.test.ts` (static authority policy),
  `tests/tool-manifest.test.ts` (installed tool surface), and `tests/viewer-palette.test.ts`, `tests/status.test.ts`,
  `tests/widget.test.ts` and `tests/watch.test.ts` (design and TUI goldens). Guards: `tests/ci-host-tools.test.ts`
  (CI never silently skips treehouse acceptance), `tests/structure.test.ts` (module size and structure), and
  `tests/test-concurrency-bound.test.ts`, `tests/test-file-guard.test.ts`, `tests/test-runner-bounds.test.ts` and
  `tests/timeout-floor.test.ts` (verification integrity).
- 10 security guards, kept as exhaustive local adversarial checks beside the e2e denial cases:
  `tests/worker-credential-guard.test.ts`, `tests/worker-history-guard.test.ts`, `tests/worker-host-guard.test.ts`,
  `tests/worker-merge-guard.test.ts`, `tests/worker-role-tools.test.ts`, `tests/worker-session-policy.test.ts`,
  `tests/operator-tool-guard.test.ts`, `tests/forge-url.test.ts`, `tests/web-access.test.ts`,
  `tests/web-egress.test.ts`.

Pairing, remote authorization and MCP access are not exceptions. They convert, and every negative assertion in them
moves first.

## Scenarios

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 01-1 | `tests/e2e/ci-evidence.test.ts` | ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone |
| 01-2 | `tests/e2e/ci-evidence.test.ts` | ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link |
| 05-S08-1 | `tests/e2e/landing.test.ts` | landing: held repair rejects invalid PR identity, CI, holds, drains and worktree hazards |
| 05-S08-2 | `tests/e2e/landing.test.ts` | landing: held CI revalidates local state after each external read |
| 05-S08-3 | `tests/e2e/landing.test.ts` | landing: a reviewed green head merges once, records, tears down and closes from forge facts |
| 05-S08-4 | `tests/e2e/landing.test.ts` | landing: the review deadline resumes once and rechecks current gates |
| 05-S08-5 | `tests/e2e/landing.test.ts` | landing: main red gates only the mandated login and permits a green fix-forward |
| 05-S08-6 | `tests/e2e/landing.test.ts` | landing: repository and fallback merges bind the approved head at the forge |
| 05-S08-7 | `tests/e2e/landing.test.ts` | landing: stale bases update only for BEHIND or an authoritative strict rule |
| 05-S08-8 | `tests/e2e/landing.test.ts` | landing: the operator bridge persists a hold without a parent and a restarted parent reads and releases it |
| 05-S08-9 | `tests/e2e/landing.test.ts` | landing: a hold arriving during green CI stops both merge authority paths |
| 05-S10-1 | `tests/e2e/landing.test.ts` | landing S10: synchronization preserves local work and proves origin before resetting |
| 05-S10-2 | `tests/e2e/landing.test.ts` | landing S10: rescue retention proves reachability and bounds cleanup |
| 05-S10-3 | `tests/e2e/landing.test.ts` | landing S10: review evidence authorizes only the reviewed complete head |
| 05-S10-4 | `tests/e2e/landing.test.ts` | landing S10: unreadable forge and Actions evidence names the cause and makes no mutation |
| 05-S10-5 | `tests/e2e/landing.test.ts` | landing S10: cleanup failures preserve landed effects and resume |
| 05-S10-6 | `tests/e2e/landing.test.ts` | landing S10: dispatch rejects profiles granting parent integration tools |
| 05-S09-1 | `tests/e2e/landing.test.ts` | landing S09: exact head and branch evidence distinguish pending, superseded and absent CI |
| 05-S09-2 | `tests/e2e/landing.test.ts` | landing S09: repository refusals and draft transitions preserve head authority |
| 05-S09-3 | `tests/e2e/landing.test.ts` | landing S09: external PR facts stop or finish without an automated merge |
| 05-S09-4 | `tests/e2e/landing.test.ts` | landing S09: GitLab integration observes the target and never asks GitHub to merge |
| 05-S09-5 | `tests/e2e/landing.test.ts` | landing S09: a real repair stays single while active and conflict handoffs follow heads |
| 05-S09-6 | `tests/e2e/landing.test.ts` | landing S09: public promotion before or during integration waits for a fresh report |
| 05-S09-7 | `tests/e2e/landing.test.ts` | landing S09: infra reruns once while second attempts and test failures promote |
| 05-S09-8 | `tests/e2e/landing.test.ts` | landing S09: a missing implementer surfaces without spending the same-head repair |
| 05-S03b-snapshot | `tests/e2e/landing.test.ts` | landing S03: startup snapshots queued held heads and generations before the lane opens |
| 05-S03b-parked | `tests/e2e/landing.test.ts` | landing S03: a real parent relays a newly parked handoff without a model turn |
| 05-S03b-expired | `tests/e2e/landing.test.ts` | landing S03: expired review passes advance immediately and deadline faults never rearm |
| 05-S03b-drain | `tests/e2e/landing.test.ts` | landing S03: unreadable drain blocks a deadline and leaves its fact actionable |
| 05-S03b-equivalent | `tests/e2e/landing.test.ts` | landing S03: patch-equivalent review waits synchronously on its new durable pass |
| 05-S03b-arrival | `tests/e2e/landing.test.ts` | landing S03: actual parent arrival accepts legacy CI keys and rejects unrelated messages |
| 05-S03b-stops | `tests/e2e/landing.test.ts` | landing S03: actionable surface and retry stops reach the real parent once |
| 05-S03b-revise | `tests/e2e/landing.test.ts` | landing S03: a real revise verdict belongs to its implementer and starts no continuation |
| 05-S03b-gate | `tests/e2e/landing.test.ts` | landing S03: a real passing research gate starts no held-PR continuation |
| 05-S03b-hook | `tests/e2e/landing.test.ts` | landing S03: armed-release failure stays visible after landing and a stop never releases |
| 05-S02b-legacy | `tests/e2e/landing.test.ts` | landing S02: Actions refuses historical runs without a database id |
| 05-S07 | `tests/e2e/landing.test.ts` | landing: held CI repair checks Sender authority before restoring a worker |
| 05-main-red | `tests/e2e/landing.test.ts` | landing: main-red integration holds stale heads and permits only a current green fix-forward under its own mandate |
| 05-main-scope | `tests/e2e/landing.test.ts` | landing: main CI scope skips inactive grants and login faults preserve latches until the next successful login |
| 05-main-corrupt | `tests/e2e/landing.test.ts` | landing: main latch writes refuse corruption introduced during an Actions read |
| 05-main-deadlines | `tests/e2e/landing.test.ts` | landing: Actions deadlines stop a hung request and share the budget across pages |
| 06-S20-shipped | `tests/e2e/wake-delivery.test.ts` | S20: shipped rows collapse through cp_status_block and survive a resumed parent |
| 06-S20-context | `tests/e2e/wake-delivery.test.ts` | S20: persisted stale notices are filtered at the actual provider boundary |
| 06-S20-busy | `tests/e2e/wake-delivery.test.ts` | S20: busy durable wakes wait for an operator answer and late notices receive one nudge |
| 06-S20-abort | `tests/e2e/wake-delivery.test.ts` | S20: abort strands no autonomous turn and the next prompt carries the notices |
| 06-S20-tool | `tests/e2e/wake-delivery.test.ts` | S20: tool turns do not answer operator sends and an errored run releases held wakes |
| 06-S20-head | `tests/e2e/headless-lifecycle.test.ts` | S20: reported envelope heads survive failed watch queries until a newer remote observation supersedes the verdict |
| 06-S20-bridge | `tests/e2e/wake-rules.test.ts` | S20: the real parent bridge relays landing, resolve, green and flagged notices once |
| 06-S20-switch | `tests/e2e/wake-rules.test.ts` | S20: switch files control resolve relays and malformed settings restore a parent turn |
| 06-S20-identities | `tests/e2e/wake-rules.test.ts` | S20: non-resolve and hashed legacy continuation IDs reach context without a resolve ruling |
| 06-S20-expiry | `tests/e2e/wake-rules.test.ts` | S20: a resolve cache stays quiet within its minute and refreshes to dispatch after expiry |
| 06-S20-failure | `tests/e2e/wake-rules.test.ts` | S20: a failed next refresh wakes with a reason and is not retried during its cache minute |
| 06-S20-review-start | `tests/e2e/headless-lifecycle.test.ts` | S20: a green watch fact starts a real mock reviewer and relays without a parent request |
| 06-S20-batch | `tests/e2e/headless-lifecycle.test.ts` | S20: multi-fact green batches and a single red fact wake without a single-green ruling |
| 06-S20-overlap | `tests/e2e/headless-lifecycle.test.ts` | S20: overlapping green sweeps leave one owner for a delayed continuation ruling |
| 06-S20-ci-next-dispatch | `tests/e2e/wake-rules.test.ts` | S20: green review fact wakes for dispatch |
| 06-S20-ci-next-mission | `tests/e2e/wake-rules.test.ts` | S20: green review fact wakes for mission_end |
| 06-S20-ci-next-failure | `tests/e2e/wake-rules.test.ts` | S20: green review fact wakes for failure |
| 06-S20-ci-wait | `tests/e2e/wake-rules.test.ts` | S20: green CI on an operator-held PR wakes with the continuation wait reason |
| 06-S20-ci-stopped | `tests/e2e/wake-rules.test.ts` | S20: a green fact overtaken by a closed PR wakes with the stopped reason |
| 06-S20-ci-coalesced | `tests/e2e/wake-rules.test.ts` | S20: a legacy unconfirmed green key wakes when its continuation was already handled |
| 06-S20-ci-unsettled | `tests/e2e/wake-rules.test.ts` | S20: a slow forge continuation times out the green rule and leaves the fact to the parent |
| 06-S20-ci-done | `tests/e2e/wake-rules.test.ts` | S20: a green fact overtaken by a merged PR emits an ordinary notice after completion |
| 06-S20-ci-new-key | `tests/e2e/wake-rules.test.ts` | S20: a different green head receives its own woke journal measurement |
| 06-S20-ci-warms | `tests/e2e/wake-rules.test.ts` | S20: a quiet green lookup warms the resolve cache before independent work becomes ready |
| 06-S20-review-pending | `tests/e2e/headless-lifecycle.test.ts` | rpc: one CI-green key whose review is in flight is relayed without a parent turn; ticks, restart and a moved head repeat nothing |
| 06-S20-ci-off | `tests/e2e/headless-lifecycle.test.ts` | rpc: with the wake-rules switch off, the same CI-green fact wakes the parent and journals why |
| S16-model | `tests/e2e/reviewer-model.test.ts` | S16: public plan gates select reviewer preferences from current and legacy authority |
| S16-auto | `tests/e2e/landing.test.ts` | landing S16: automatic green CI reviews use the current mandate reviewer |
| S24-context | `tests/e2e/operator-context.test.ts` | S24 context: fresh bridge loads orders, parsed learnings and newest handoff into the provider request |
| S24-empty | `tests/e2e/operator-context.test.ts` | S24 context: an empty home adds no operator context or preference files |
| S24-dashboard-hold | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge S24: a queued message survives compaction without a dropped handoff |
| S24-dashboard-rehand | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge: a message queued before a self-compaction is held through it and consumed once after one dropped handoff |
| S24-dashboard-terminal | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge: a queued message whose handoff is dropped twice ends failed, never re-injected again |
| S21-long | `tests/e2e/wake-delivery.test.ts` | S21: forty failed reconcile candidates retain distinct bounded notices through RPC restart |
| S21-restart | `tests/e2e/wake-delivery.test.ts` | S21: restart delivers an unobserved death once and discards obsolete fleet notices |
| S24-op-invalid | `tests/e2e/operator-compact.test.ts` | S24 compact: invalid instructions refuse before writing, and a small context never queues |
| S24-op-queued | `tests/e2e/operator-compact.test.ts` | S24 compact: queued handoff survives tool replies and reaches one summarizer after settlement |
| S24-op-settings | `tests/e2e/operator-compact.test.ts` | S24 compact: live operator settings honor positive integer triggers and default every invalid value |
| S24-op-failures | `tests/e2e/operator-compact.test.ts` | S24 compact: a failed self compact is visible and automatic retries stop after three failures |
| S24-op-streak | `tests/e2e/operator-compact.test.ts` | S24 compact: provider rejection compacts once per streak and stops at three per process |
| S24-op-spent | `tests/e2e/operator-compact.test.ts` | S24 compact: skipped and failed summarizers spend the rejection streak once |
| S24-op-relays | `tests/e2e/operator-compact.test.ts` | S24 compact: held relays remain unacked for health, then enter context once after compaction |
| S24-op-manual | `tests/e2e/operator-compact.test.ts` | S24 compact: manual summarizers receive the latest handoff and read failures preserve the fallback |
| S24-op-order | `tests/e2e/operator-compact.test.ts` | S24 compact: a relay handed to the automatic compact-request turn is never handed twice |
| S24-op-nudge | `tests/e2e/operator-compact.test.ts` | S24 compact: rejection nudges name unanswered relays and a good answer clears them |
| S24-op-explicit | `tests/e2e/operator-compact.test.ts` | S24 compact: an explicit queued compact spends the provider-rejection streak without a retry nudge |
| S24-op-backstop | `tests/e2e/operator-compact.test.ts` | S24 compact: an ignored threshold request compacts automatically and a low settle rearms it |
| S24-op-sdk | `tests/e2e/operator-compact.test.ts` | S24 compact: SDK threshold and overflow summarizers receive handoff enrichment |
| S24-op-write | `tests/e2e/operator-compact.test.ts` | S24 compact: a failed handoff write refuses the tool and never leaves compaction pending |
| S24-parent-order | `tests/e2e/parent-compaction.test.ts` | S24 parent: schedule wakes hold in order until manual compaction finishes |
| S24-parent-expiry | `tests/e2e/parent-compaction.test.ts` | S24 parent: failures and expiries release wakes, three disable, compaction reenables, low context releases |
| S24-parent-immediate | `tests/e2e/parent-compaction.test.ts` | S24 parent: low, disabled and non-headless contexts deliver schedule wakes immediately |
| S24-parent-length | `tests/e2e/parent-compaction.test.ts` | S24 parent: length stops cancel threshold compaction without disabling later manual and normal compaction |
| S24-parent-ci | `tests/e2e/headless-lifecycle.test.ts` | rpc parent S24: a CI fleet wake stays held across settlement until manual compaction |
<!-- /manifest:scenarios -->

Both run a real CommandPost with continuation on (the in-process host `tests/e2e/mission.test.ts` uses), real
implementer workers and reporter on a treehouse pool, a mock LLM, scratch git, and a scripted `gh` on PATH. The
consumers under test are the CI watch tick and its wake text (`src/ci-watch.ts`), the held-PR continuation's
`cp_integrate` record (`src/integrate-held.ts`, `src/integrate.ts`), and the promote the implementer receives.

## Assertion map

Disposition `mapped` names the scenario that pins the same behaviour at a public consumer. `redundant-unreachable`
means no public consumer can feed the helper that input today. The named scenario pins the consumer-visible
outcome of that path instead (see Method). `unreachable`, with no pinning scenario, blocks the file's deletion.
`retained` means the assertion was moved verbatim into the kept unit file its note names, where it still runs; the
scenario column names the e2e case that pins the reachable outcomes beside it.

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| `tests/reviewer-model.test.ts` | reviewer selection: explicit, newest active (tie by id), expired continuation, project, unset | S16-model | mapped | S16-NC1 fails explicit selection source; matrix drives real plan gates, including excluded grants, fallback and recordless routing |
| `tests/reviewer-model.test.ts` | scheduled and legacy schedule subjects use only their actual schedule grant | S16-model | mapped | S16-NC2 fails schedule actual chosen reviewer receives plan; disk schedules and legacy ledger labels feed the real gate |
| `tests/reviewer-model.test.ts` | production factories and automatic ci_green reviews honor current preferences | S16-auto | mapped | S16-NC3 fails automatic review reaches the mandated model; S16-model pins gate rereads, spawned model and high thinking; DR-09 pins public diff review factory preferences |
| `tests/integrate-held-ci.test.ts` | held repair uses real Sender permission before delivery or revival, including eligible expired grants | 05-S07 | mapped | S07: revoked/capped refuse before missing-worker lookup, expired permits one repair, missing/dead worker refuses; hold and original envelope survive refusal, PID unchanged; S07-NC-1 fails revoked error match |
| `tests/ci-run-ref.test.ts` | failedRunOn picks the completed failure on HEAD over another head's failure | 01-1 | mapped | wrong-head failure (older sha) never named; run 6 on the pushed head is |
| `tests/ci-run-ref.test.ts` | failedRunOn skips skipped, neutral and success runs | 01-1 | mapped | runs 2-4 precede run 6; negative control NC-01 |
| `tests/ci-run-ref.test.ts` | failedRunOn skips an in_progress run | 01-1 | redundant-unreachable | consumers call ciRunRef only on a failed verdict, and `evaluateMergeAskCi` (`src/merge-ask.ts`) answers in_progress, never failed, while any run on the head is unfinished. 01-1 pins only that outcome: run 5 in_progress on the pushed head, no failure beside it, gives `ci: in_progress`, `next: wait`, no run reference and no watch observation. No case puts an in_progress run beside a completed failure; approved by main session under ask-0088e0332d00, 2026-10-20 |
| `tests/ci-run-ref.test.ts` | failedRunOn is undefined when only green or unfinished runs exist | 01-1 | mapped | unfinished and fixed phases: no run reference in facts, reason or wake |
| `tests/ci-run-ref.test.ts` | failedRunOn is undefined for an undefined head | 01-2 | redundant-unreachable | every consumer passes a string head; 01-2 pins cp_integrate stopping at "no head commit" with no reference; approved by main session under ask-0088e0332d00, 2026-10-20 |
| `tests/ci-run-ref.test.ts` | runUrl derives the github.com Actions URL from the PR URL | 01-1 | mapped | exact (run 6 https://github.com/example/demo/actions/runs/6) in wake, fact and promote |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for an enterprise host | 01-2 | mapped | ghe.example.com: run 16 by id only; negative control NC-03 |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for a branch-name PR ref | 01-2 | mapped | cp_integrate with the branch as its PR ref: (run 17) and no link |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for an undefined PR URL | 01-2 | redundant-unreachable | cp_integrate passes `view.url ?? pr`, always a string; 01-2 pins a non-github.com PR ref naming the run by id with no link; approved by main session under ask-0088e0332d00, 2026-10-20 |
| `tests/ci-run-ref.test.ts` | ciRunRef + formatRunRef render the id and URL of a github.com failure | 01-1 | mapped | negative controls NC-01 and NC-02 |
| `tests/ci-run-ref.test.ts` | ciRunRef gives the id alone for an enterprise host | 01-2 | mapped | wake observation run_id 16, run_url absent |
| `tests/ci-run-ref.test.ts` | formatRunRef of an id alone is " (run N)" | 01-2 | mapped | (run 16) and (run 17) at the end of the ci fact |
| `tests/ci-run-ref.test.ts` | ciRunRef of a legacy run without databaseId is {} | 01-2 | redundant-unreachable | readActionsCi refuses an id-less row, so no consumer sees one; 01-2 pins "could not read CI" with no reference; approved by main session under ask-0088e0332d00, 2026-10-20 |
| `tests/ci-run-ref.test.ts` | formatRunRef of {} is "" | 01-1 | mapped | held facts for superseded, in_progress and green heads carry no reference |
| `tests/actions-ci.test.ts` | retry: never past the budget, and a structurally wrong JSON page is not retried | 05-main-deadlines | mapped | nc-retry-budget: spent retry budget reports the failed request without another attempt; 05-1 pins one structural-error request |
| `tests/actions-ci.test.ts` | budget: one total deadline across pages, each request gets only what remains | 05-main-deadlines | mapped | nc-page-budget: one total deadline bounds runs plus jobs |
| `tests/actions-ci.test.ts` | statusRunner: forwards each request's remaining budget as timeoutMs; a non-zero status throws | 05-main-deadlines | mapped | nc-request-timeout: per-request timeout cancels hung gh; 05-1 pins nonzero status failure |
| `tests/ci-watch.test.ts` | rerunwake-12z: the derived key carries the attempt, and stays historical without a run id | 05-S02b-legacy | retained | S02 declaration 8 retained verbatim in tests/ci-watch-retained.test.ts. Actions rejects id-less runs before derivation; no CommandPost entry supplies that helper-only run. Attempt identities remain covered by 05-8 / NC-32; consumer refusal and legacy-arrival controls do not replace this helper assertion. |
| `tests/ci-watch.test.ts` | jje.2 snapshot: a startup trigger carries the head and generation it was observed on, and a later change stops it | 05-S03b-snapshot | mapped | Declaration 78; real startup queues two held jobs behind the first forge read, then disk changes the second head or generation. S03b-snapshot-generation fails queued startup cannot adopt a reopened generation; S03b-snapshot-head fails stale queued startup reaches no forge read. Executed patches and base SHA: docs/testing-migration-s03b-controls.md. |
| `tests/ci-watch.test.ts` | awaiting_merge PR6: a handoff that parked relays once without waking the parent; the parked job is then stale | 05-S03b-parked | mapped | Declaration 64; real handoff parks and emits exactly one durable continuation:parked notice without a model turn; S03b-parked control removing quiet parked recognition fails parking is relayed without waking the parent model (1 versus 0). Shared parked exclusion is covered by 05-S02-1 and NC-S02-eligibility. Patch and SHA: docs/testing-migration-s03b-controls.md. |
| `tests/ci-watch.test.ts` | restart arms only the remaining interval; expired pass advances and retry never re-arms | 05-S03b-expired | mapped | Declaration 54; 05-S03-restart proves remaining window after process restart; expired startup completes immediately and operational retry produces no new startup deadline. S03b-expiration removes deadline expiry and fails expired startup reaches terminal result; S03b-retry rearms retry and fails operational retry never rearms its deadline. Patches/SHA in docs/testing-migration-s03b-controls.md. |
| `tests/ci-watch.test.ts` | jje.2 stale: a moved head, a reopened generation or a job no longer held acts on nothing | 05-S03b-snapshot | mapped | Declaration 65; queued startup head/generation changes reach no forge read; phase exclusions are pinned by 05-S02-1. S03b-stale bypasses the stale guard and fails both queued variants; phase exclusions use executed S03-exclusions. |
| `tests/ci-watch.test.ts` | jje.2 wait/retry/pending: wait is left to the watcher, a fault is never retried, a pending review is not doubled | 05-S03b-expired | mapped | Declaration 66; retry is pinned by S03b-retry, wait replay by S03-rearm in 05-S03-replay, and pending reviewer by S03-pending in 05-S03-pending. Each control fails the corresponding consumer assertion. |
| `tests/ci-watch.test.ts` | jje.2 restart: startup resumes every held PR once, and a fresh process resumes again | 05-S03b-snapshot | mapped | Declaration 67; two real held PRs are snapshotted into startup's project lane; 05-S03-restart verifies a second process resumes again and 05-S03-owner verifies lock fencing. S03b-resume returns no resumed jobs and fails first startup holds the project lane and startup did not arm the durable window. |
| `tests/ci-watch.test.ts` | unload-parent PR2 drain: no step while draining, the key is not consumed, and resume after the restart acts | 05-S03b-drain | mapped | Declaration 68; unreadable drain prevents all steps and the identical CI key can land after recovery; ordinary drain variants also remain in 05-S03-deadline. S03b-unreadable-drain makes the error branch fail open and fails unreadable drain fails closed at the real deadline (wait versus draining). |
| `tests/ci-watch.test.ts` | a valid new head/generation replaces the timer; canceled deadlines never drive | 05-S03b-equivalent | mapped | Declaration 55; live base merge changes the watched head, then reopened generation replaces its window again. Original deadline passes without a merge; newest deadline lands once. Replacement-head/generation controls each fail their notice-count assertion; patches/SHA in docs/testing-migration-s03b-controls.md. |
| `tests/ci-watch.test.ts` | synchronous patch equivalence releases the lane and waits on its new durable pass | 05-S03b-equivalent | mapped | Declaration 56; real patch-id equivalence persists a fresh pass and arms a deadline in one step; manual cp_integrate can acquire the released lane. S03b-equivalent-window deletes synchronous arming and fails steps equality (2 versus 1). |
| `tests/ci-watch.test.ts` | arrival evidence comes off the message, and only off a cp-ci message | 05-S03b-arrival | mapped | Declaration 45; a fixture extension sends legacy strings, key objects, missing details and unrelated messages into the real pi parent. Only CI keys reach their owning job's announcement memory. S03b-legacy and S03b-arrival-type fail arrival confirmation / unrelated-key rejection; production patches and SHAs in docs/testing-migration-s03b-controls.md. |
| `tests/ci-watch.test.ts` | a landed continuation relays once without waking the parent; actionable stops still wake | 05-S03b-stops | mapped | Declaration 58; real surface/retry stop messages reach the parent model once. 05-S03-restart pins one quiet landed relay, full URL and no parent-work instructions; existing 05-S03-red pins the resolve notice. S03b-stop removes stop notifications and both actual-parent wake assertions time out. Resolve notification remains subject to current held_stop_resolve wake policy. |
| `tests/ci-watch.test.ts` | jje.2 revise: a revise verdict continues nothing — the fix belongs to the job's own implementer | 05-S03b-revise | mapped | Declaration 60; real revise verdict reaches its author, starts no second reviewer and schedules no continuation; S03b-revise fails verdict-event count. 05-S03b-gate pins real research-gate pass with no PR continuation; S03b-gate fails the event count (1 versus 0). |
| `tests/ci-watch.test.ts` | unload-parent PR2: a landing calls onLanded once; a stop does not, and a throwing onLanded never undoes the landing | 05-S03b-hook | mapped | Declaration 70; real armed-file failure is journaled after a completed landing, and stop releases nothing. S03b-landed-hook and S03b-stop-hook independently fail these assertions. Existing mission armed-dependant case pins one dispatch and no replay spawn. Synchronous injected callback throw is redundant-unreachable: the sole production callback returns void starting async release; this named e2e pins the consumer's real failure outcome. |
| `tests/awaiting-merge-tick.test.ts` | a lock taken after session_start still sweeps on the next interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: transfer ownership to an already-started parent session. Acquisition occurs only at session_start, before timer registration; release only at session_shutdown. The startup-guard probe passes 05-12 and is not a failing consumer control. |
| `tests/awaiting-merge-tick.test.ts` | session_shutdown clears the startup catch-up and the interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: observe timer callbacks after shutdown while ownership remains held, including before the startup timer fires. Shutdown releases the lock and exits; removing both clears passes 05-12 but fails the retained unit. |
| `tests/main-ci.test.ts` | #9 unreadable state never overwritten and reported | 05-main-corrupt | mapped | nc-corruption: in-flight latch mutation preserves corrupt bytes; timer names the corrupt file |
| `tests/main-ci.test.ts` | #11 missing clone skipped | 05-main-scope | mapped | nc-missing-clone: missing clone creates no project error |
| `tests/main-ci.test.ts` | #15 main-red hold, ancestry and corrupt state | 05-main-red | mapped | nc-ancestry: cp_integrate.next expected wait, actual review |
| `tests/main-ci.test.ts` | #19 inactive mandate skips even internal login callback | 05-main-scope | retained | verbatim in tests/main-ci-retained.test.ts; timer shares cached login with other watches, so extra main callback invocation has no attributable subprocess effect; ordering probe passes S but fails this unit |
| `tests/main-ci.test.ts` | #20 unreadable login fails open | 05-main-scope | mapped | nc-login-fault: failed login reads no CI |
| `tests/main-ci.test.ts` | #22 memoized login retries/validation | 05-main-scope | mapped | nc-login-validation: invalid login retries, successful login is cached |
| `tests/main-ci.test.ts` | #23 own-row hold only under enforced scope | 05-main-red | mapped | nc-hold-scope: expected no active mandate / not blocking fact |
| `tests/main-ci.test.ts` | #24 scope resolution fails open | 05-main-red | mapped | nc-scope-fault: expected ENOTDIR / not blocking fact |
| `tests/main-ci.test.ts` | #35 retry budget | 05-main-deadlines | mapped | nc-retry-budget: spent retry budget reports the failed request without another attempt; 05-1 asserts structural malformed JSON makes one request |
| `tests/main-ci.test.ts` | #36 cross-page deadline | 05-main-deadlines | mapped | nc-page-budget: one total deadline bounds runs plus jobs |
| `tests/main-ci.test.ts` | #37 runner timeout forwarding | 05-main-deadlines | mapped | nc-request-timeout: per-request timeout cancels hung gh; 05-1 pins nonzero read failures |
| `tests/integrate.test.ts` | S09 declaration 41: pending head | 05-S09-1 | mapped | NC-2: advance != wait; S09 ledger. |
| `tests/integrate.test.ts` | S09 declaration 42: workflows present | 05-S09-1 | mapped | NC-2: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 43: older branch run | 05-S09-1 | mapped | NC-1: surface != wait. |
| `tests/integrate.test.ts` | S09 declaration 44: empty head/branch | 05-S09-1 | mapped | NC-2: present advances and none loses authoritative-empty fact. |
| `tests/integrate.test.ts` | S09 declaration 45: branch failures | 05-S09-1 | mapped | NC-2: each advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 46: branch-only green | 05-S09-1 | mapped | NC-2: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 47: no workflows | 05-S09-1 | mapped | NC-2: missing authoritative-empty fact. |
| `tests/integrate.test.ts` | S09 declaration 48: no-CI refusal | 05-S09-2 | mapped | NC-3: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 49: unreadable workflows | 05-S09-1 | mapped | NC-2: each advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 50: red no workflows | 05-S09-5 | mapped | NC-7: wait != resolve. |
| `tests/integrate.test.ts` | S09 declaration 51: required review | 05-S09-2 | mapped | NC-3: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 52: unreadable rules | 05-S09-2 | mapped | NC-3: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 53: unstable | 05-S09-2 | mapped | NC-3: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 54: unreviewed draft | 05-S09-2 | mapped | NC-11: surface != review. |
| `tests/integrate.test.ts` | S09 declaration 55: ready once | 05-S09-2 | mapped | NC-4: surface != advance; S10 adds follow-up actual merge assertion. |
| `tests/integrate.test.ts` | S09 declaration 56: moved/refused ready | 05-S09-2 | mapped | NC-4: surface != wait or missing error cause. |
| `tests/integrate.test.ts` | S09 declaration 57: approved blocked | 05-S09-2 | mapped | NC-3: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 58: permission head moved | 05-S09-2 | mapped | NC-10: advance != wait. |
| `tests/integrate.test.ts` | S09 declaration 59: reminder lifecycle | 05-S09-2 | mapped | S10 reminder-dedupe: 2 != 1; reminder-withdraw: open != withdrawn. |
| `tests/integrate.test.ts` | S09 declaration 60: auto merge | 05-S09-2 | mapped | NC-10: advance != surface. |
| `tests/integrate.test.ts` | S09 declaration 61: sourced repair | 05-S09-5 | mapped | NC-7: wait != resolve. |
| `tests/integrate.test.ts` | S09 declaration 62: infra rerun | 05-S09-7 | mapped | NC-7: missing rerun reason or wait != resolve. |
| `tests/integrate.test.ts` | S09 declaration 63: duplicate repair | 05-S09-5 | mapped | NC-5 active guard; S10 repair-exhaustion: resolve != surface. |
| `tests/integrate.test.ts` | S09 declaration 64: active phase matrix | 05-S09-6 | unreachable | Retained mixed: validated FleetStore rejects launching model records; see S09 ledger; reachable waiting covered by NC-5. |
| `tests/integrate.test.ts` | S09 declaration 65: permission promotion | 05-S09-6 | mapped | NC-5: advance != resolve. |
| `tests/integrate.test.ts` | S09 declaration 66: raw concurrent promotion | 05-S09-6 | unreachable | Retained: CommandPost serializes same-job integration, so two raw advance calls cannot overlap publicly. |
| `tests/integrate.test.ts` | S09 declaration 67: working before integration | 05-S09-6 | mapped | NC-5: attempt count 1 != 0. |
| `tests/integrate.test.ts` | S09 declaration 68: raw duplicate pending send | 05-S09-5 | unreachable | Retained: public per-job serialization prevents overlapping raw Integrator advance calls. |
| `tests/integrate.test.ts` | S09 declaration 69: isolated promoting predicate | 05-S09-5 | unreachable | Retained: CommandPost has no port for an idle fake worker manager plus private pending send; real Sender marks RPC busy. |
| `tests/integrate.test.ts` | S09 declaration 70: per-head conflict handoff | 05-S09-5 | mapped | NC-8 first step; S10 repair-exhaustion completed surface; conflict-head second handoff surface != resolve. |
| `tests/integrate.test.ts` | S09 declaration 71: missing implementer | 05-S09-8 | mapped | NC-12: resolve != surface. |
| `tests/integrate.test.ts` | S09 declaration 72: missing sender | 05-S09-8 | unreachable | Retained: CommandPost always constructs Integrator with Sender; no public option removes it. |
| `tests/integrate.test.ts` | S09 declaration 73: external merge | 05-S09-3 | mapped | NC-13: review != done. |
| `tests/integrate.test.ts` | S09 declaration 74: external close | 05-S09-3 | mapped | NC-13: review != surface. |
| `tests/integrate.test.ts` | S09 declaration 75: GitLab squash | 05-S09-4 | mapped | NC-9: retry != done. |
| `tests/integrate.test.ts` | S09 declaration 76: GitLab merge commit | 05-S09-4 | mapped | NC-9: retry != done. |
| `tests/integrate.test.ts` | S09 declaration 77: GitLab refusal matrix | 05-S09-4 | unreachable | Retained mixed: real GitLab adapter rejects missing target before successful observation; S09 ledger maps reachable failures with NC-9. |
| `tests/integrate.test.ts` | S09 declaration 78: contradictory base/bound | 05-S09-4 | mapped | NC-9: retry instead of initial merged tail, both cases. |
| `tests/integrate.test.ts` | S09 declaration 79: foreign branch | 05-S09-3 | mapped | NC-13: review != surface. |
| `tests/integrate.test.ts` | S09 declaration 80: gh denied | 05-S09-3 | mapped | NC-13: wait != retry. |
| `tests/integrate.test.ts` | S10 declaration 81: rate limit | 05-S10-4 | mapped | ci-refusal: advance != retry. |
| `tests/integrate.test.ts` | S10 declaration 82: Actions permissions | 05-S10-4 | mapped | ci-refusal: advance != retry; Actions advice pinned. |
| `tests/integrate.test.ts` | S10 declaration 83: denied partial malformed jobs | 05-S10-4 | mapped | ci-refusal: all three advance != retry. |
| `tests/integrate.test.ts` | S10 declaration 84: missing gh | 05-S10-4 | mapped | missing-gh: retry != surface. |
| `tests/integrate.test.ts` | S10 declaration 85: behind sync | 05-S10-1 | mapped | sync-reset: expected observed-SHA reset missing. |
| `tests/integrate.test.ts` | S10 declaration 86: authoritative SHA | 05-S10-1 | mapped | sync-reset: expected observed-SHA reset missing. |
| `tests/integrate.test.ts` | S10 declaration 87: stale tracking ref | 05-S10-1 | mapped | sync-reset: expected reset missing with tracking ref removed. |
| `tests/integrate.test.ts` | S10 declaration 88: branch origin denied | 05-S10-1 | mapped | sync-guards: reset != no reset. |
| `tests/integrate.test.ts` | S10 declaration 89: branch absent | 05-S10-1 | mapped | sync-guards: reset != no reset. |
| `tests/integrate.test.ts` | S10 declaration 90: unique unpushed | 05-S10-1 | mapped | sync-guards: reset != no reset. |
| `tests/integrate.test.ts` | S10 declaration 91: unreadable divergence | 05-S10-1 | mapped | sync-guards: reset != no reset. |
| `tests/integrate.test.ts` | S10 declaration 93: absorbed content | 05-S10-1 | mapped | sync-reset: missing reset; rescue-target: rescue SHA differs from discarded local SHA. |
| `tests/integrate.test.ts` | S10 declaration 94: dangerous inverse | 05-S10-1 | mapped | sync-guards: reset != no reset. |
| `tests/integrate.test.ts` | S10 declaration 95: proof refusal matrix | 05-S10-1 | mapped | sync-guards: each of eight refusal shapes attempts forbidden reset. |
| `tests/integrate.test.ts` | S10 declaration 96: zero ahead | 05-S10-1 | mapped | proof-skip: forcing proof prevents expected reset. |
| `tests/integrate.test.ts` | S10 declaration 97: prune reachable keep orphan | 05-S10-2 | mapped | prune: extra reachable ref remains; prune-safety: orphan deleted. |
| `tests/integrate.test.ts` | S10 declaration 98: origin unreadable prune | 05-S10-2 | mapped | prune-safety: /001 deleted; prune: missing named origin refusal. |
| `tests/integrate.test.ts` | S10 declaration 99: prune refusal matrix | 05-S10-2 | mapped | prune-safety: missing-tip/ancestry deletes /001; prune: listing/delete causes missing. |
| `tests/integrate.test.ts` | S10 declaration 100: unfetchable base | 05-S10-2 | mapped | prune-safety: /001 deleted; prune: missing fetch refusal cause. |
| `tests/integrate.test.ts` | S10 declaration 101: deterministic bound | 05-S10-2 | mapped | prune-safety: /101 deleted; prune: 101 refs remain instead of /101 only. |
| `tests/integrate.test.ts` | S10 declaration 102: namespace guard | 05-S10-2 | mapped | ref-scope: main no longer resolves, preserve-main assertion fails. |
| `tests/integrate.test.ts` | S10 declaration 103: empty namespace | 05-S10-2 | mapped | prune: unexpected rescue-ref fact. |
| `tests/integrate.test.ts` | S10 declaration 104: salvage static contract | 05-S10-2 | unreachable | Retained mixed: no public entry exposes literal helper booleans or accepts bare/space-containing ref names real git rejects; reachable scope/bound covered separately. |
| `tests/integrate.test.ts` | S10 declaration 105: rebase marker | 05-S10-5 | mapped | rebase: advance != surface. |
| `tests/integrate.test.ts` | S10 declaration 106: delete refusal | 05-S10-5 | mapped | cleanup-retry: wait != retry. |
| `tests/integrate.test.ts` | S10 declaration 107: close refusal | 05-S10-5 | mapped | cleanup-retry: wait != retry. |
| `tests/integrate.test.ts` | S10 declaration 108: honest retry notice | 05-S10-5 | mapped | retry-notice: forbidden nothing-was-mutated in durable notice. |
| `tests/integrate.test.ts` | S10 declaration 109: forbidden-tool constant | 05-S10-6 | mapped | forbid-integrate/forbid-merged: each corresponding profile is accepted instead of rejected at dispatch. |
| `tests/integrate.test.ts` | S10 declaration 111: unreviewed | 05-S10-3 | mapped | review-gate: advance != review. |
| `tests/integrate.test.ts` | S10 declaration 112: pass | 05-S10-3 | mapped | review-pass: review != advance. |
| `tests/integrate.test.ts` | S10 declaration 113: equivalent pass | 05-S10-3 | mapped | review-pass: review != advance with equivalence alone. |
| `tests/integrate.test.ts` | S10 declaration 114: moved pass | 05-S10-3 | mapped | review-gate: advance != review. |
| `tests/integrate.test.ts` | S10 declaration 115: revise | 05-S10-3 | mapped | review-gate: advance != review. |
| `tests/integrate.test.ts` | S10 declaration 116: unapproved flag | 05-S10-3 | mapped | review-gate: advance != review. |
| `tests/integrate.test.ts` | S10 declaration 117: approved flag | 05-S10-3 | mapped | review-pass: review != advance. |
| `tests/integrate.test.ts` | S10 declaration 118: truncated review | 05-S10-3 | mapped | review-gate: pass and approved-flag truncation each advance != review. |
| `tests/integrate.test.ts` | S10 declaration 119: moved flag | 05-S10-3 | mapped | review-gate: advance != review. |
| `tests/integrate.test.ts` | S10 declaration 120: fallback review | 05-S10-3 | mapped | review-gate: advance != review despite merge approval. |
| `tests/shipped-seen.test.ts` | a second render in the same session collapses Shipped to the count, not the rows | 06-S20-shipped | mapped | S20-repeat: second tool result fails none-new count; old PR row repeats |
| `tests/shipped-seen.test.ts` | the collapse holds when the render also changes the awaiting set and supplies new labels | 06-S20-shipped | mapped | S20-repeat: second call with changed label and awaiting fails none-new count; decision still asserted |
| `tests/shipped-seen.test.ts` | REGRESSION (cp-b5eg): a reloaded extension in the same session still collapses Shipped | 06-S20-shipped | mapped | S20-disk: resumed parent tool result repeats both rows instead of none-new count |
| `tests/shipped-seen.test.ts` | a job shipped between two renders appears exactly once, in the second | 06-S20-shipped | mapped | S20-repeat breaks old-row absence alongside new PR; third tool result pins new PR and absence of old PR |
| `tests/shipped-seen.test.ts` | a genuinely new session starts empty — the memory is keyed by session id | 06-S20-shipped | mapped | S20-scope: fresh session does not show pull/20, because another session has reported it |
| `tests/shipped-seen.test.ts` | a corrupt memory names the file and the remedy, is rebuilt, and recovers on the next render | 06-S20-shipped | mapped | S20-heal: warning/recovery assertions fail; first corrupt memory renders rows, warns with remedy, then resumed parent collapses |
| `tests/shipped-seen.test.ts` | a rebind that DOES change the session id replays once, and neither throws nor corrupts the store | 06-S20-shipped | mapped | S20-scope fails fresh PR row; S20-writer fails other-session preservation assertion |
| `tests/shipped-seen.test.ts` | the Shipped memory is written the way cp-nqj established: tmp -> fsync -> rename, never a truncating call | 06-S20-shipped | retained | tests/shipped-seen-retained.test.ts; cp_status_block never exposes import tokens or syscall sequence; structural trust guard preserved |
| `tests/shipped-seen.test.ts` | a second writer on the same home does not drop the first session's entry | 06-S20-shipped | mapped | S20-writer: persisted sessions count/preserved original entry assertion fails after a different parent session writes |
| `tests/shipped-seen.test.ts` | the store bounds itself: sessions and ids per session | 06-S20-shipped | mapped | S20-id-bound fails recent-ID tail equality; S20-session-bound fails newest-session identity after cap+1 sessions |
| `tests/shipped-seen.test.ts` | a write that fails cannot un-report a row this process already printed | 06-S20-shipped | mapped | S20-mirror: fourth tool result repeats rows after corrupt memory instead of none-new count; warning is asserted |
| `tests/stale-notice-context.test.ts` | qra: stale and replayed notices stay journaled, not in the parent's model context | 06-S20-context | mapped | S20-filter fails obsolete/duplicate body exclusion; S20-recovery-replay/gone fail recovery exclusions; S20-context-journal fails suppression journal assertions; persisted history and reload asserted |
| `tests/stale-notice-context.test.ts` | N9: a withheld tail wake never leaves the context ending on assistant | 06-S20-context | mapped | S20-tail fails exact neutral user-tail text after an assistant response; obsolete body absent and persisted history preserved |
| `tests/stale-notice-context.test.ts` | N2: a withheld verdict with findings reaches the model as its findings stand-in | 06-S20-context | mapped | S20-findings fails medium finding presence at provider boundary; cp_integrate instructions absent |
| `tests/stale-notice-context.test.ts` | cp-vy73: busy wake-ups ride along non-triggering, and agent_settled nudges once for a stranded one | 06-S20-busy | mapped | S20-busy fails carried W2/W3; S20-answered-busy fails no-nudge assertion for carried answer; S20-nudge fails fourth request; 06-S20-abort with S20-abort fails absence of a stranded-notice nudge after abort and next prompt; idle wake asserted |
| `tests/stale-notice-context.test.ts` | unload-parent PR3: wakes wait while a landed operator send is unanswered; answered never waits | 06-S20-busy | mapped | S20-send-first fails held session exclusion; S20-answered-hold fails answer in first follow-up; 06-S20-tool with S20-tool-answer fails held notice absence during tool continuation; S20-settled-release times out waiting for recovered held notice after provider error |
| `tests/wakeup-head-sources.test.ts` | the extension's head sources call the command post accessors, with no catch of their own | 06-S20-head | retained | tests/wakeup-head-sources-retained.test.ts; RPC context exposes neither accessor call names/order nor a HeadSourcePost override throwing on demand; observable head selection mapped below |
| `tests/wakeup-head-sources.test.ts` | a head source that throws is reported and supersedes nothing, instead of reading as an absent fact | 06-S20-head | retained | tests/wakeup-head-sources-retained.test.ts; RPC context has no throwing source port: CiWatch.head/observedAt catch store errors, reportedHead catches envelope errors, and unreadable fleet is rejected before head lookups |
| `tests/wakeup-head-sources.test.ts` | CommandPost.reportedHeadSha/reportedHeadAt read the envelope the sources are wired to | 06-S20-head | mapped | S20-head-source fails initial verdict presence if CI replaces the envelope SHA; S20-head-time fails moved-head verdict absence if envelope age is missing; S20-watch-time fails initial presence if attempt age replaces observation age |
| `tests/wakeup-head-sources.test.ts` | the failure journal is once per (source, job), and its memory is bounded (pi-command-post-8ok) | 06-S20-head | retained | tests/wakeup-head-sources-retained.test.ts; RPC context cannot call the failure recorder: both CI accessors catch read errors, envelope parse errors are caught, and fleet failure prevents source evaluation; no entry point installs a throwing HeadSourcePost or custom journal sink/limit |
| `tests/wakeup-head-sources.test.ts` | a long-lagging watcher delivers the verdict eventually, and terminates it definitively (pi-command-post-8ok) | 06-S20-head | mapped | S20-watch-failure fails unchanged observation timestamp after real failed gh query; S20-watch-time fails deliverable verdict presence; S20-head-time fails definitive newer-head suppression for successive fresh decisions |
| `tests/wake-rules.test.ts` | wakeRulesEnabled: absent is on, false or anything malformed is off | 06-S20-switch | retained | tests/wake-rules-retained.test.ts keeps all 7 assertions, including undefined-home composition; public settings covered by switch scenario; see testing-migration-s20.md row 1 |
| `tests/wake-rules.test.ts` | isResolveStop matches only resolve stops; a hashed long id fails safe | 06-S20-identities | mapped | true resolves are relayed by switch/expiry; surface/retry/done/window/hashed IDs reach provider with no resolve journal; S20-resolve-id and S20-resolve-defer fail |
| `tests/wake-rules.test.ts` | isRelayOnlyNotice and relayOnlyMessage | 06-S20-bridge | retained | tests/wake-rules-retained.test.ts keeps all 8 assertions: real bridge covers notification/flag branches, but undefined message is rejected by the caller before this helper and cannot be supplied at its public call site; row 3 |
| `tests/wake-rules.test.ts` | NextCache: fresh for 60 s, failure reported, refresh attempts remembered | 06-S20-expiry | retained | tests/wake-rules-retained.test.ts keeps all 7 exact accessor/time assertions; public expiry and failed-refresh/backoff effects separately covered; see testing-migration-s20.md row 4 |
| `tests/wake-rules.test.ts` | createWakeRules: a pending resolve with no cache defers one sweep for one refresh, then relays on a quiet next | 06-S20-switch | mapped | real cold sweep gives one quiet relay/ruling, confirmed after send; direct resweep/refresh counts and repeated delivered bookkeeping are redundant-unreachable behind that named switch consumer; S20-resolve-defer fails; full mapping row 5 |
| `tests/wake-rules.test.ts` | createWakeRules: a relay whose send failed, then woke the parent, journals woke | 06-S20-bridge | retained | tests/wake-rules-retained.test.ts preserves injected omission of delivered then direct next invocation on the same object; public RPC bridge cannot supply a throw-once resumable transport port; row 6 |
| `tests/wake-rules.test.ts` | createWakeRules: a refresh that never settles times out, re-sweeps once, and the stop wakes the parent | 06-S20-failure | retained | tests/wake-rules-retained.test.ts keeps never-settling cpNext override, resweep callback count and shortened dependency wait; no public override supplies that infinite promise; row 7 |
| `tests/wake-rules.test.ts` | createWakeRules: another job's work pending wakes the parent and journals why | 06-S20-expiry | mapped | independently authorized job changes next to dispatch; resolve reaches provider with woke/dispatch; surface ID delivered without resolve ruling; S20-resolve-action and S20-resolve-id fail |
| `tests/wake-rules.test.ts` | createWakeRules: a stale cache wakes the parent | 06-S20-expiry | retained | tests/wake-rules-retained.test.ts keeps direct relayOnly bypass of deferSweep with stale clock and exact stale reason; public host refreshes before this call; row 9 |
| `tests/wake-rules.test.ts` | createWakeRules: the kill switch off restores today's wake with no cp_next and no journal | 06-S20-switch | mapped | false switch yields actual provider resolve turn, no held_stop_resolve ruling and no quiet deferral; S20-rule-switch fails provider assertion |
| `tests/wake-rules.test.ts` | journalWakeRule writes one continuation event and never throws for an unsafe id | 06-S20-failure | retained | tests/wake-rules-retained.test.ts keeps valid event count plus unsafe path and undefined registry contracts; public ID validation prevents unsafe registry calls; row 11 |
| `tests/wake-rules.test.ts` | ciGreen: a single green fact whose continuation started or awaits a review, with a quiet cp_next, is suppressed | 06-S20-ci-warms | mapped | real review-start/pending quiet relays include PR URL, suppress model turns, confirm keys and journal once; warm-cache consumer resolve stays wait after independent work becomes ready; S20-ci-started/pending/warms fail; row 12 |
| `tests/wake-rules.test.ts` | ciGreen: every off-rule single green fact wakes the parent and journals why | 06-S20-ci-wait | retained | tests/wake-rules-retained.test.ts keeps all 11 cases; real cases now cover 9 branches, but missing/different-job outcomes require replacing onObserved/ciOutcome ports; no deletion credit; row 13 |
| `tests/wake-rules.test.ts` | ciGreen: two facts or a non-green fact are no candidate and journal nothing | 06-S20-batch | mapped | real two-green batch and single red fact reach provider without ci_green rulings or candidate next; S20-ci-shape and S20-ci-nongreen fail |
| `tests/wake-rules.test.ts` | ciGreen: re-derived ticks for one key journal woke once | 06-S20-ci-new-key | mapped | busy operator turn permits bounded repeat offers but one woke ruling per key; second pushed head yields second green key/ruling; S20-ci-once and S20-ci-new-key fail |
| `tests/wake-rules.test.ts` | ciGreen: a tick for a key still waiting is suppressed without a ruling of its own | 06-S20-overlap | mapped | delayed real gh plus bounded retry emits overlap relay without owning/confirming keys or journaling; first owner later suppresses/journals alone and guard releases; S20-ci-overlap fails |
| `tests/wake-rules.test.ts` | CommandPost.observeCi, the CiWatch onObserved wiring, records ciOutcome(key) on the real continuation | 06-S20-review-start | retained | tests/wake-rules-retained.test.ts keeps default disabled CommandPost and arbitrary-key promise accessor contract; running extension enables continuation and validates watch keys; row 17 |
| `tests/operator-context.test.ts` | a fresh main session gets the orders, the learnings and the newest handoff by mtime | S24-context | mapped | S24-oldest fails newest handoff assertion; real bridge provider request pins orders, parsed learnings and policy |
| `tests/operator-context.test.ts` | an empty home has no start context and building it creates no file | S24-empty | retained | Verbatim in tests/operator-context-retained.test.ts: bridge session_start creates its control state before context loading, so no public entry point can observe an entirely nonexistent home after calling only the context builder |
| `tests/operator-context.test.ts` | the bridge sends one hidden cp-operator-context to a fresh session and none to a resumed one | S24-context | mapped | S24-resume fails SHOULD NOT RELOAD exclusion in actual resumed provider request; get_messages pins one hidden context |
| `tests/dashboard-compaction.test.ts` | order 1: the compact request starts its turn first; the queued message is held through the compaction, then delivered once | S24-dashboard-hold | mapped | S24-hold fails queued delivery; real compaction_start queue_edit remains editable, compaction_end precedes one consumption, exact journal and pending state |
| `tests/dashboard-compaction.test.ts` | order 2: a handoff pi drops because the compaction's own turn started first is re-handed at that turn's settle, delivered once | S24-dashboard-rehand | mapped | S24-rehand fails delivered state after nudge: actual failed; exact re-hand reason, one consumption and pending delivered |
| `tests/dashboard-compaction.test.ts` | a handoff pi drops twice is failed with a reason, never left injected | S24-dashboard-terminal | mapped | S24-third fails terminal failed assertion: third injection delivers; scenario also pins exact reason and no third handoff after later settle |
| `tests/wakeup-journal.test.ts` | declaration 4: forty-candidate recovery rendering and distinct long IDs | S21-long | mapped | long-recovery control fails real reconciliation inventory assertions; forty failures, bounded RPC arrival and distinct IDs |
| `tests/wakeup-journal.test.ts` | runtime declarations 5, 9–15, 17–22 | S21-restart | mapped | Individual scenarios and all executed controls are enumerated by declaration in testing-migration-s21.md; includes real worker/reviewer emitters and host event APIs |
| `tests/wakeup-journal.test.ts` | structural/documentation declarations 1–3, 6–8, 16 | — | retained | tests/wakeup-journal-retained.test.ts preserves these seven declarations verbatim; missing runtime entry points are listed per declaration in testing-migration-s21.md |
| `tests/operator-compact.test.ts` | 1 self_compact refuses empty, short and pathless instructions before writing | S24-op-invalid | mapped | S24-compact-validation: invalid refusal assertions fail before any handoff write |
| `tests/operator-compact.test.ts` | 2 N13: self_compact under the threshold returns without queueing or writing a handoff | S24-op-invalid | mapped | S24-compact-under: small-context queued=false assertion fails |
| `tests/operator-compact.test.ts` | 3 self_compact writes instructions and only compacts once after settlement, with visible outcomes | S24-op-queued | mapped | S24-compact-early: settlement ordering fails; real tool result, exact handoff bytes/path, duplicate refusal and one summarizer |
| `tests/operator-compact.test.ts` | 4 threshold crossing requests once, then compacts automatically if ignored, and rearms below threshold | S24-op-backstop | mapped | S24-compact-early: ignored-request/backstop assertion fails; two threshold crossings with a low settle between |
| `tests/operator-compact.test.ts` | 5 a failed self_compact is recorded and next settle compacts automatically, up to three failures | S24-op-failures | mapped | S24-compact-failures: three-failure stop assertion fails; actual visible tool/session errors |
| `tests/operator-compact.test.ts` | 6 S1: benign compact skips never count as failures, release waiters and leave next settle eligible | — | retained | Verbatim in tests/operator-compact-retained.test.ts; includes synchronous ctx.compact throw unavailable through SDK's asynchronous wrapper. Public benign skip additionally pinned by S24-op-spent; declaration retained whole |
| `tests/operator-compact.test.ts` | 7 S1: a benign skip still spends the provider-rejection streak's one compaction | S24-op-spent | mapped | S24-compact-spent: benign-skip subtest loses already-compacted notice |
| `tests/operator-compact.test.ts` | 8 bridge wakes arriving during a compaction wait for it to end | S24-op-relays | mapped | S24-compact-callback: both complete/cancel subtests time out waiting for relay ack; exact emit/ack counts and context entry |
| `tests/operator-compact.test.ts` | 9 picp-75g: relay handed off before compaction is not handed off again after it | S24-op-order | mapped | S24-compact-relay-gate: exact one-emit assertion fails; real automatic compact-request turn and durable outbox |
| `tests/operator-compact.test.ts` | 10 compaction that never ends holds relays unjournaled so health sees them unacked | S24-op-relays | mapped | S24-compact-relay-gate: pre-release no-emit assertion fails; real health CLI reports aged unacked relay failure |
| `tests/operator-compact.test.ts` | 11 N5: isToolAdditionRejection matches only assistant error naming tool_addition with a 400 | — | retained | Verbatim in tests/operator-compact-retained.test.ts; malformed/undefined message inputs and arbitrary role/stopReason combinations cannot be emitted through the SDK. Public 400/529 and aborted reply behavior additionally pinned by S24-op-streak/S24-op-nudge/S24-op-explicit |
| `tests/operator-compact.test.ts` | 12 N5: tool_addition 400 compacts once per failure streak ahead of threshold request | S24-op-streak | mapped | S24-compact-spent: extra compaction per streak; public successful replies reset streaks and nudge uses operator-compact |
| `tests/operator-compact.test.ts` | 13 N5: other errors, aborts, user and custom messages neither open nor end a streak | S24-op-explicit | mapped | S24-compact-abort: aborted reply resets spent streak; S24-op-nudge additionally pins unrelated 529 and relay custom message tracking |
| `tests/operator-compact.test.ts` | 14 N5: failed streak compaction is not retried in the streak | S24-op-spent | mapped | S24-compact-spent: failed-summarizer subtest loses already-compacted notice |
| `tests/operator-compact.test.ts` | 15 N5: streak compactions stop at three per process | S24-op-streak | mapped | S24-compact-streak-cap: actual compaction count is two instead of three; fourth streak refuses |
| `tests/operator-compact.test.ts` | 16 N5: nudge names relays failed turns never answered | S24-op-nudge | mapped | S24-compact-nudge: unanswered-ID assertion fails; latest twenty of twenty-five IDs, earlier IDs excluded, good answer clears them |
| `tests/operator-compact.test.ts` | 17 operator settings override trigger; invalid settings use 200000 | S24-op-settings | mapped | S24-compact-default: actual request count wrong; positive 500 plus seven invalid values and malformed JSON tested live |
| `tests/operator-compact.test.ts` | 18 manual and backstop compaction enrich prepared input with latest handoff without cancelling | S24-op-manual | mapped | S24-compact-enrich: four manual variants and S24-op-sdk threshold/overflow variants lose enrichment |
| `tests/operator-compact.test.ts` | 19 enrichment reaches actual default summarizer for normal and split compaction | S24-op-manual | mapped | S24-compact-enrich: keepRecentTokens 1/200 variants fail; actual summarizer requests preserve SDK completion |
| `tests/operator-compact.test.ts` | 20 read failures notify without cancelling backstop; write failures never queue | S24-op-write | mapped | S24-compact-write loses persistent-write error; S24-op-manual additionally pins read-failure fallback, broken by S24-compact-enrich |
| `tests/operator-compact.test.ts` | 21 queued self_compact lets tool-result reply finish before compacting real Pi run | S24-op-queued | mapped | S24-compact-early fails settlement ordering; S24-compact-own also fails own-instructions enrichment exclusion/exact summarizer count |
| `tests/operator-compact.test.ts` | 22 fresh-home state operator directory and configured handoffs_dir | S24-op-manual | mapped | S24-compact-enrich loses configured latest handoff path/input; both default state directory and custom directory checked |
| `tests/parent-compact-hold.test.ts` | T3(a): pure hold — settle, timers, failures, busy phase, runStarted, not_over | S24-parent-expiry | mapped | S24-parent-cap loses five-second cap release; failure, 15-second start timeout, cap, disable after three, reenable and not_over exercised through parent CLI |
| `tests/parent-compact-hold.test.ts` | T3(b): threshold settle holds fleet and schedule wakes in offer order until session_compact | — | retained | Moved verbatim to tests/parent-compact-hold-retained.test.ts. No public parent CLI/RPC entry injects the fixture's jobless CI/envelope/answered wakes between individual schedule offers; retain the exact mixed-kind ordering contract per round-2 decision. |
| `tests/parent-compact-hold.test.ts` | T3(c)/(d): below threshold or off headless parent nothing holds | S24-parent-immediate | mapped | S24-parent-context fails low, disabled and non-headless JSON print consumers |
| `tests/parent-compact-hold.test.ts` | T3(e): N6 length stop cancels threshold compaction and never holds | S24-parent-length | mapped | S24-parent-length loses threshold cancellation; three real provider length stops never disable later manual/normal compaction |
| `tests/parent-compact-hold.test.ts` | T3(f): busy run holds all wakes including schedule and send-first release until compaction | — | retained | Moved verbatim to tests/parent-compact-hold-retained.test.ts, including PARENT_COMPACT_HOLD_MS === 270_000. No public parent CLI/RPC entry advances the hold's clock independently through the default cap and injected mixed wakes; round-2 decision retains the whole declaration. Reachable busy/schedule/CI behavior also has S24-parent-order and S24-parent-ci controls. |
| `tests/parent-compact-hold.test.ts` | incoming #447: cap timer reads CP_PARENT_COMPACT_HOLD_SECONDS | S24-parent-expiry | mapped | S24-parent-cap restores hardcoded 270000 and fails ten-second wait for five-second expiry; knob set in parent environment |
| `tests/parent-compact-hold.test.ts` | T3(g)/(h): failure, start timeout and cap release; three disable; agent_start never releases | — | retained | Moved verbatim to tests/parent-compact-hold-retained.test.ts. No public parent CLI/RPC entry injects the cancelled-threshold failure while keeping the fixture's independent OVER reading and engaged hold; retain the whole declaration per round-2 decision. Public failure/expiry portions also have S24-parent-cap coverage. |
| `tests/parent-compact-hold.test.ts` | below-threshold settle releases schedule wakes; disabled control delivers immediately | S24-parent-immediate | mapped | S24-parent-context fails disabled/low consumers; S24-parent-expiry additionally changes public settings and pins held-batch not_over release |
<!-- /manifest:assertions -->

### Pending-fix declarations (parked or product-blocked; no deletion credit)

| File | Declaration | Status | Evidence and expected outcome |
|---|---|---|---|
| `tests/integrate.test.ts` | 92 dirty worktree | pending-fix | [S10 reproducer location](testing-migration-s10.md#pending-fix-declaration-92); unreadable status must preserve original bytes and issue no reset. Original file stays whole. |
| `tests/ci-watch.test.ts` | 71 distinct watch-failure causes | pending-fix | Parked by frozen Addendum 1; #443 and its real-parent regression are already on main, so the blocker is gone. S10b owns mapping 71 and retirement by sequencing decision. [Decision and historical reproducer](testing-migration-s03-declarations.md#latest-operator-ruling-and-declaration-71-blocker). |

The checker does not accept `pending-fix` inside its assertion section. This separate ledger records parked or product-blocked items without relabelling them retained or changing the checker; original files and declaration counts remain intact until the required consumer behavior passes.

S06's [declaration control ledger](testing-migration-s06-controls.md) maps each of its 24 mapped declarations to
an executed production mutation and the failing consumer assertion. Twenty-three controls cover those declarations;
the shared deploy control breaks both original throwing-afterRecorded and ledger-refusal contracts. A further
prefix control verifies the reachable part of the retained reference guard.

P3c is an approved partial delivery (ask-c77a4f32b23b): two files deleted, thirteen declarations mapped,
two retained and 128 pending. The five unfinished files are convert-owned by P3c-rest. Reachable gaps need
real-entry assertions and failing controls before retirement; retained cases must name a missing entry point.
A moved unit is `retained`, never removed coverage. Other behavior-05 files remain outside this partial slice.

V2 forwarded-evidence controls NC-43–NC-48 were each applied alone, then restored. Each command
`npm run test:one -- --test-name-pattern='operator-forwarded CI' tests/e2e/landing.test.ts` exited 1 at the
assertion named in its regression row; the restored scenario passes. Logs: `NC-43.log` through `NC-48.log`.

V2 parked-CI controls NC-49–NC-55 use
`npm run test:one -- --test-name-pattern='parked PR timer' tests/e2e/landing.test.ts`.
Each exited 1 at the assertion in its regression row and was restored. NC-54 removes both open-snapshot gates:
the public watch ordinarily excludes terminal snapshots before the observer's defensive guard can see them.
The old direct held-with-handoff helper call is redundant-unreachable: normal watch candidates must be awaiting_merge,
and legacy held parking records violate the fleet schema before observation. Scenario 05-12 pins both outcomes:
`a held job is not read by the parked CI timer` and `the public sweep rejects a legacy held parking record before observing CI`.
These assertions exercise valid lifecycle state and raw legacy disk data; no internal ports are mocked.

NC-39 through NC-42 each use their own patch below and this command:
`npm run test:one -- --test-name-pattern='CI watch persists arrival' tests/e2e/landing.test.ts`.
Each command exited 1 at the named assertion; production mutations were restored. Logs are `NC-39.log` through
`NC-42.log` in this job's artifact directory. The restored 05-8 scenario passes all four assertions.
<!-- patch:S07-NC-1 -->
```diff
diff --git a/src/send.ts b/src/send.ts
--- a/src/send.ts
+++ b/src/send.ts
@@ -245,1 +245,1 @@
-				this.#options.mandates.assertPermitted("repair", { jobId: request.jobId, project: record.project, kind: record.kind }, fleet.read().jobs);
+				// S07 negative control: omit repair authority check.
```

### P3b review controls reproduced by P3c

Each control was applied alone and restored immediately after its failing run. M1–M3 use
`npm run test:one -- --test-name-pattern='cp_merged records only' tests/e2e/landing.test.ts`;
M4–M6 use `npm run test:one -- --test-name-pattern='cp_merged reads a GitLab' tests/e2e/landing.test.ts`;
L1 uses `npm run test:one -- --test-name-pattern='cp_teardown passes a deleted branch' tests/e2e/landing.test.ts`.
Every run exited 1 with one failing case and no skips; failures below are observed output, not predictions.

| Control | Observed failure |
|---|---|
| M1 | receipt tuple: actual `head_branch_deleted: false`, expected `true` |
| M2 | `AssertionError: force stays the exit for the unprovable case`; expected `/cp_teardown <job> force/` |
| M3 | expected `/carries no PR receipt/`, actual `could not read PR 77` |
| M4 | MR 7 receipt tuple: actual `unknown`, expected `squash` |
| M5 | receipt repair tuple: actual `[false,false,'open',1]`, expected `[false,true,'merged',1]` |
| M6 | expected `/could not read PR .*\(mismatch: /`, actual `merged but names no merge commit` |
| L1 | `post-squash extra commit remains unlanded`: actual `[true,undefined]` (`landed_by_git`), expected `[false,'unpushed']` |

M1 (`src/merges.ts`):
```diff
@@ -279,1 +279,1 @@
-			...(onRemote === undefined ? {} : { head_branch_deleted: !onRemote }),
+			...(onRemote === undefined ? {} : { head_branch_deleted: onRemote }),
```
M2 (`src/merges.ts`):
```diff
@@ -208,1 +208,1 @@
-					`cp_teardown ${jobId} can still pass on git evidence when the work is in the base's history; only if neither can prove it, cp_teardown ${jobId} force — which proves nothing, and records that.`,
+					`cp_teardown ${jobId} can still pass on git evidence when the work is in the base's history.`,
```
M3 (`src/merges.ts`):
```diff
@@ -193,1 +193,1 @@
-		const pr = request.pr?.trim() || prUrlFromReceipts(record.receipts);
+		const pr = request.pr?.trim() || prUrlFromReceipts(record.receipts) || "77";
```
M4 (`src/merges.ts`):
```diff
@@ -268,1 +268,1 @@
-		const strategy = request.strategy ?? (view.provider === "gitlab" ? (view.squash_commit_sha ? "squash" : "unknown") : undefined);
+		const strategy = request.strategy ?? (view.provider === "gitlab" ? "unknown" : undefined);
```
M5 (`src/merges.ts`):
```diff
@@ -190,1 +190,1 @@
-			return { receipt: existing, recorded: false, receipt_status_updated: await this.#markReceiptMerged(jobId, existing) };
+			return { receipt: existing, recorded: false, receipt_status_updated: false };
```
M6 (`src/forges/gitlab.ts`):
```diff
@@ -148,1 +148,1 @@
-	if (!web || web.number !== iid || !changeRequestBelongsTo(web, repository)) return refuse("mismatch", "response web_url is not this project's merge request");
+	if (false && (!web || web.number !== iid || !changeRequestBelongsTo(web, repository))) return refuse("mismatch", "response web_url is not this project's merge request");
```
L1 (`src/landing-proof.ts`):
```diff
@@ -147,1 +147,1 @@
-		const paths = (await run(["diff", "--name-only", "-z", ...DIFF, fork, head])).stdout.split("\0").filter(Boolean);
+		const paths = (await run(["diff", "--name-only", "-z", ...DIFF, fork, `${head}^`])).stdout.split("\0").filter(Boolean);
```

### P3c CI-watch negative controls

Each command uses `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.
Only the stated semantic mutation was present during its failing run; it was restored immediately afterward.
The fixed file passed all 13 cases without skips before these controls. No production mutation is committed.

| Scenario | Pattern | Semantic mutation | Observed failing assertion |
|---|---|---|---|
| 05-8 | CI watch persists arrival | `src/ci-watch.ts`: completed-run identity uses `${run.databaseId}.1` instead of the actual attempt | `a new attempt is a new failure even on the same head`: actual `undefined`, expected truthy |
| 05-9 | operator-forwarded CI | `src/ci-evidence.ts`: disable the current-head mismatch guard | `/superseded head/` fails: tool records forwarded success on `bbbbbbbbbbbb` instead |
| 05-10 | foreign CI stays | `src/foreign-ci-watch.ts`: suppress the moved-head notification guard (NC-34) | tick observation assertion: actual `[]`, expected `['head_moved']`; supersedes the earlier downstream model-selection failure |
| 05-11 | real parent's timer | `src/main-ci.ts`: count all runs without actor or dynamic-event filtering | `own current-tip green clears latch` times out with the red row still present |
| 05-12 | parked PR timer | `src/awaiting-merge.ts`: remove the parked watch's `observeCi` wiring | `parked green through extension timer` times out with no CI row |
| 05-13 | held CI repairs | `src/integrate.ts`: set cumulative prior repair count to zero | `a second red result exhausts the repair allowance`: actual `resolve`, expected `surface` |

These controls prove the named consumer scenarios. The P3c ledger and declaration assessment report the current
mapped, retained and removed counts; proof of a behavior alone does not count a moved unit as deleted.

## Negative controls

Each patch was applied to this worktree's `src/` (no other checkout), `npm run test:one -- tests/e2e/ci-evidence.test.ts`
run, the patch reversed, and the same command run again: 2 pass, 0 fail, 0 skipped. The bug commit is
`90c1f22ba20c416abc9fc96b04addd07e2f58ed3` (#131), which added `src/ci-run-ref.ts`. Its whole diff is not
reverted; each patch puts back one rule it introduced.

What `--verify-regressions` checks: only that each recorded patch block hashes to its sha256, and that the bug commit
exists in this repository. It does not apply the patch, and it does not rerun the e2e. The failing and fixed runs
quoted below were run by hand when each control was recorded, and they are evidence only to that extent.
<!-- patch:S20-repeat -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..19fb66b 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -252,7 +252,7 @@ export function renderSessionStatusBlock(args: {
 	const result = assembleStatusBlock(
 		args.snapshot,
 		args.input ?? {},
-		{ shownShipped: shown.ids, ...(args.width ? { width: args.width } : {}) },
+		{ shownShipped: new Set(), ...(args.width ? { width: args.width } : {}) },
 	);
 	const written = args.store.record(args.sessionId, result.shippedIds);
 	if (written.healed) {
```
<!-- /patch:S20-repeat -->

<!-- patch:S20-disk -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..66ad574 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -164,7 +164,7 @@ export class ShippedSeenStore {
 		const mirrored = this.#mirror.get(sessionId) ?? new Set<string>();
 		try {
 			const stored = this.read().sessions.find((session) => session.session_id === sessionId);
-			return { ids: new Set([...mirrored, ...(stored?.shipped_ids ?? [])]) };
+			return { ids: new Set(mirrored) };
 		} catch (error) {
 			// A corrupt or unreadable memory must not take the status block down with
 			// it: the worst case is one replayed section, and the operator is told —
```
<!-- /patch:S20-disk -->

<!-- patch:S20-heal -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..40ad917 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -190,7 +190,7 @@ export class ShippedSeenStore {
 			current = this.read();
 		} catch (error) {
 			current = EMPTY_SHIPPED_SEEN_FILE;
-			healed = `rebuilt ${this.file} from scratch (it was unreadable: ${(error as Error).message}); other sessions' Shipped memories in it are gone`;
+			return { persisted: false, error: "unreadable memory was not rebuilt" };
 		}
 		try {
 			const others = current.sessions.filter((session) => session.session_id !== sessionId);
```
<!-- /patch:S20-heal -->

<!-- patch:S20-scope -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..84d4336 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -164,7 +164,7 @@ export class ShippedSeenStore {
 		const mirrored = this.#mirror.get(sessionId) ?? new Set<string>();
 		try {
 			const stored = this.read().sessions.find((session) => session.session_id === sessionId);
-			return { ids: new Set([...mirrored, ...(stored?.shipped_ids ?? [])]) };
+			return { ids: new Set([...mirrored, ...this.read().sessions.flatMap((session) => session.shipped_ids)]) };
 		} catch (error) {
 			// A corrupt or unreadable memory must not take the status block down with
 			// it: the worst case is one replayed section, and the operator is told —
```
<!-- /patch:S20-scope -->

<!-- patch:S20-writer -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..d90f7ac 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -193,7 +193,7 @@ export class ShippedSeenStore {
 			healed = `rebuilt ${this.file} from scratch (it was unreadable: ${(error as Error).message}); other sessions' Shipped memories in it are gone`;
 		}
 		try {
-			const others = current.sessions.filter((session) => session.session_id !== sessionId);
+			const others: ShippedSeenSession[] = [];
 			const previous = current.sessions.find((session) => session.session_id === sessionId);
 			const merged: string[] = [];
 			for (const id of [...(previous?.shipped_ids ?? []), ...ids]) {
```
<!-- /patch:S20-writer -->

<!-- patch:S20-mirror -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..34acf2f 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -170,7 +170,7 @@ export class ShippedSeenStore {
 			// it: the worst case is one replayed section, and the operator is told —
 			// with the file named and the remediation stated, because "unreadable" on
 			// its own is a fact nobody can act on.
-			return { ids: new Set(mirrored), error: `${(error as Error).message}; ${shippedSeenRemedy(this.file)}` };
+			return { ids: new Set(), error: `${(error as Error).message}; ${shippedSeenRemedy(this.file)}` };
 		}
 	}
 
```
<!-- /patch:S20-mirror -->

<!-- patch:S20-id-bound -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..bf205ba 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -203,7 +203,7 @@ export class ShippedSeenStore {
 				session_id: sessionId,
 				// Oldest first, so an over-long history drops the ids least likely to
 				// still be in any snapshot.
-				shipped_ids: merged.slice(Math.max(0, merged.length - SHIPPED_SEEN_MAX_IDS)),
+				shipped_ids: merged.slice(0, SHIPPED_SEEN_MAX_IDS),
 				updated_at: isoTimestamp(this.#now()),
 			};
 			// Newest last: the tail is what a bound keeps.
```
<!-- /patch:S20-id-bound -->

<!-- patch:S20-session-bound -->
```diff
diff --git a/src/shipped-seen.ts b/src/shipped-seen.ts
index 31282e3..0a5d1f5 100644
--- a/src/shipped-seen.ts
+++ b/src/shipped-seen.ts
@@ -207,7 +207,7 @@ export class ShippedSeenStore {
 				updated_at: isoTimestamp(this.#now()),
 			};
 			// Newest last: the tail is what a bound keeps.
-			const sessions = [...others, session].slice(-SHIPPED_SEEN_KEEP_SESSIONS);
+			const sessions = [...others, session].slice(0, SHIPPED_SEEN_KEEP_SESSIONS);
 			const next: ShippedSeenFile = {
 				schema_version: SCHEMA_VERSION,
 				updated_at: isoTimestamp(this.#now()),
```
<!-- /patch:S20-session-bound -->

<!-- patch:S20-filter -->
```diff
diff --git a/extensions/command-post/session-hooks.ts b/extensions/command-post/session-hooks.ts
index 616c450..bef3e70 100644
--- a/extensions/command-post/session-hooks.ts
+++ b/extensions/command-post/session-hooks.ts
@@ -525,7 +525,7 @@ export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session:
 		const fresh = reviewed.filter((message, index) => message === messages[index] || isWithheldFindings(message));
 		// N9: a withheld tail must not leave the context ending on assistant (provider 400, no prefill).
 		// SAFETY: retained messages are unchanged members of event.messages; the one stand-in is a custom message.
-		return { messages: keepUserTail(messages as WakeupCarrier[], fresh) as unknown as typeof event.messages };
+		return { messages: messages as unknown as typeof event.messages };
 	});
 
 	// The parent never leaves orphaned children behind.
```
<!-- /patch:S20-filter -->

<!-- patch:S20-findings -->
```diff
diff --git a/extensions/command-post/session-hooks.ts b/extensions/command-post/session-hooks.ts
index 616c450..9d141f3 100644
--- a/extensions/command-post/session-hooks.ts
+++ b/extensions/command-post/session-hooks.ts
@@ -522,7 +522,7 @@ export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session:
 		const reviewed = reviewWakeupsInContext(messages as WakeupCarrier[]);
 		if (!reviewed) return;
 		// Review preserves order and fresh object identities; withheld entries drop, verdict findings stay (N2).
-		const fresh = reviewed.filter((message, index) => message === messages[index] || isWithheldFindings(message));
+		const fresh = reviewed.filter((message, index) => message === messages[index]);
 		// N9: a withheld tail must not leave the context ending on assistant (provider 400, no prefill).
 		// SAFETY: retained messages are unchanged members of event.messages; the one stand-in is a custom message.
 		return { messages: keepUserTail(messages as WakeupCarrier[], fresh) as unknown as typeof event.messages };
```
<!-- /patch:S20-findings -->

<!-- patch:S20-tail -->
```diff
diff --git a/extensions/command-post/session-hooks.ts b/extensions/command-post/session-hooks.ts
index 616c450..e461deb 100644
--- a/extensions/command-post/session-hooks.ts
+++ b/extensions/command-post/session-hooks.ts
@@ -525,7 +525,7 @@ export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session:
 		const fresh = reviewed.filter((message, index) => message === messages[index] || isWithheldFindings(message));
 		// N9: a withheld tail must not leave the context ending on assistant (provider 400, no prefill).
 		// SAFETY: retained messages are unchanged members of event.messages; the one stand-in is a custom message.
-		return { messages: keepUserTail(messages as WakeupCarrier[], fresh) as unknown as typeof event.messages };
+		return { messages: fresh as unknown as typeof event.messages };
 	});
 
 	// The parent never leaves orphaned children behind.
```
<!-- /patch:S20-tail -->

<!-- patch:S20-recovery-replay -->
```diff
diff --git a/src/wakeups.ts b/src/wakeups.ts
index 3c65ed9..9112cef 100644
--- a/src/wakeups.ts
+++ b/src/wakeups.ts
@@ -1118,7 +1118,7 @@ export function reviewWakeups<T extends WakeupCarrier>(
 			// on the identity `job_id|head` would confuse them under.
 			// Durable wake-ups (death/bound/recovery) replay on `durable_id`: the outbox re-sends
 			// after its retry window while pi still holds the first copy (cp-ze1t).
-			const ids = durable ? durableIdsFromMessage(message).map((id) => `durable:${id}`) : stamp.kind === "ci" ? ciKeysFromMessage(message) : verdictKeysFromMessage(message);
+			const ids = durable ? [] : stamp.kind === "ci" ? ciKeysFromMessage(message) : verdictKeysFromMessage(message);
 			if (ids.length > 0) {
 				// The delivery is the context entry, not the stamp: a redelivered copy with an
 				// identical stamp is still a new entry (its own `timestamp`), so still a replay.
```
<!-- /patch:S20-recovery-replay -->

<!-- patch:S20-recovery-gone -->
```diff
diff --git a/src/wakeups.ts b/src/wakeups.ts
index 3c65ed9..6b86ce8 100644
--- a/src/wakeups.ts
+++ b/src/wakeups.ts
@@ -461,7 +461,7 @@ export function checkWakeup(stamp: WakeupStamp, facts: WakeupFacts, now: Date =
 			const candidate = facts.job(id);
 			return candidate !== undefined && candidate.phase !== "done";
 		});
-		if (!still) return stale("every candidate it listed has been torn down");
+		if (false) return stale("every candidate it listed has been torn down");
 		return fresh;
 	}
 	if (!stamp.job_id) return fresh;
```
<!-- /patch:S20-recovery-gone -->

<!-- patch:S20-context-journal -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..e2188a2 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -171,7 +171,7 @@ export function createWakeupSurfaces(
 		for (const jobId of targets) {
 			try {
 				if (!existsSync(join(currentRuntime().home, paths.runDir(jobId)))) continue;
-				commandPost().runs.open(jobId).cp("wakeup_suppressed", {
+				if (false) commandPost().runs.open(jobId).cp("wakeup_suppressed", {
 					kind: stamp.kind,
 					...(stamp.generation !== undefined ? { generation: stamp.generation } : {}),
 					issued_at: stamp.issued_at,
```
<!-- /patch:S20-context-journal -->

<!-- patch:S20-busy -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..4baebd1 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -268,7 +268,7 @@ export function createWakeupSurfaces(
 			facts: wakeupFactsNow(),
 			send: (message: WakeupMessage) => {
 				const deliver = (): void => {
-					const quiet = !triggerTurn || (gate.busy && gate.triggered && stamp.kind !== "answered");
+					const quiet = !triggerTurn;
 					pi.sendMessage(
 						{
 							customType: message.customType,
```
<!-- /patch:S20-busy -->

<!-- patch:S20-send-first -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..f70f9a8 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -285,7 +285,7 @@ export function createWakeupSurfaces(
 				// unload-parent PR3: an unanswered operator send goes first; held wakes count as sent (not acked).
 				releaseHeld();
 				const gated = (): void => { if (compactHold.offer(deliver) === "send") deliver(); };
-				if (sendFirst.offer(stamp.kind, gated) === "send") gated();
+				gated();
 			},
 			onSuppressed: (suppressed, verdict) => recordStaleWakeup(suppressed, verdict, "send"),
 			projectOf: projectOf(),
```
<!-- /patch:S20-send-first -->

<!-- patch:S20-nudge -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..7eb03c5 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -254,7 +254,7 @@ export function createWakeupSurfaces(
 				{ customType: WAKEUP_NUDGE_TYPE, content: `${unseen} fleet notice(s) arrived while you were busy; they are above.`, display: true },
 				{ deliverAs: "followUp", triggerTurn: true },
 			);
-			if (compactHold.offer(nudge) === "send") nudge();
+			if (false) nudge();
 		},
 	};
 	const quietPending = new Set<string>();
```
<!-- /patch:S20-nudge -->

<!-- patch:S20-abort -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..80a7784 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -249,7 +249,7 @@ export function createWakeupSurfaces(
 			if (!gate.aborted) releaseHeld();
 			const unseen = gate.nonTriggeringSent - gate.seenUpTo;
 			gate.seenUpTo = gate.nonTriggeringSent;
-			if (unseen <= 0 || gate.aborted) return;
+			if (unseen <= 0) return;
 			const nudge = () => pi.sendMessage(
 				{ customType: WAKEUP_NUDGE_TYPE, content: `${unseen} fleet notice(s) arrived while you were busy; they are above.`, display: true },
 				{ deliverAs: "followUp", triggerTurn: true },
```
<!-- /patch:S20-abort -->

<!-- patch:S20-answered-hold -->
```diff
diff --git a/src/send-first-gate.ts b/src/send-first-gate.ts
index d9d0955..fd03475 100644
--- a/src/send-first-gate.ts
+++ b/src/send-first-gate.ts
@@ -47,7 +47,7 @@ export class SendFirstGate<Wake> {
 
 	/** `send` now, or `hold` (kept until `flush`). `answered` always goes. */
 	offer(kind: string, wake: Wake): "send" | "hold" {
-		if (kind === "answered" || this.#unanswered.size === 0) return "send";
+		if (this.#unanswered.size === 0) return "send";
 		if (this.#held.length === 0) this.#since = this.#now();
 		this.#held.push(wake);
 		return "hold";
```
<!-- /patch:S20-answered-hold -->

<!-- patch:S20-answered-busy -->
```diff
diff --git a/extensions/command-post/wakeup-surfaces.ts b/extensions/command-post/wakeup-surfaces.ts
index 7fb97bd..c7928a5 100644
--- a/extensions/command-post/wakeup-surfaces.ts
+++ b/extensions/command-post/wakeup-surfaces.ts
@@ -268,7 +268,7 @@ export function createWakeupSurfaces(
 			facts: wakeupFactsNow(),
 			send: (message: WakeupMessage) => {
 				const deliver = (): void => {
-					const quiet = !triggerTurn || (gate.busy && gate.triggered && stamp.kind !== "answered");
+					const quiet = !triggerTurn || (gate.busy && gate.triggered);
 					pi.sendMessage(
 						{
 							customType: message.customType,
```
<!-- /patch:S20-answered-busy -->

<!-- patch:S20-tool-answer -->
```diff
diff --git a/src/send-first-gate.ts b/src/send-first-gate.ts
index d9d0955..24e80a8 100644
--- a/src/send-first-gate.ts
+++ b/src/send-first-gate.ts
@@ -37,7 +37,7 @@ export class SendFirstGate<Wake> {
 
 	/** A clean `turn_end` (the bridge's segment end) answered every send that landed before it. */
 	turnEnd(event: { type: string; [key: string]: unknown }): void {
-		if (cleanSegmentEnd(event)) this.#unanswered.clear();
+		this.#unanswered.clear();
 	}
 
 	/** The run settled: whatever it did not answer, the bridge has already settled or failed. */
```
<!-- /patch:S20-tool-answer -->

<!-- patch:S20-settled-release -->
```diff
diff --git a/src/send-first-gate.ts b/src/send-first-gate.ts
index d9d0955..68ee6ff 100644
--- a/src/send-first-gate.ts
+++ b/src/send-first-gate.ts
@@ -42,7 +42,7 @@ export class SendFirstGate<Wake> {
 
 	/** The run settled: whatever it did not answer, the bridge has already settled or failed. */
 	settled(): void {
-		this.#unanswered.clear();
+		return;
 	}
 
 	/** `send` now, or `hold` (kept until `flush`). `answered` always goes. */
```
<!-- /patch:S20-settled-release -->

S20 wake-rule controls cover all reachable consumer branches before retirement of the original path.
All were executed against the real bridge/parent and restored; nine injected-input declarations remain verbatim.

<!-- patch:S20-rule-switch -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..0b3081f 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -34,7 +34,7 @@ export function wakeRulesEnabled(home: string | undefined): boolean {
 		const value: unknown = JSON.parse(text);
 		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 		const enabled = (value as { enabled?: unknown }).enabled;
-		return enabled === undefined || enabled === true;
+		return enabled !== false;
 	} catch {
 		return false;
 	}
```
<!-- /patch:S20-rule-switch -->

<!-- patch:S20-resolve-id -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..a31bd98 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -42,7 +42,7 @@ export function wakeRulesEnabled(home: string | undefined): boolean {
 
 /** A `HELD PR STOPPED … (next: resolve)` durable id; a hashed (over-long) id fails the match and wakes the parent. */
 export function isResolveStop(id: string): boolean {
-	return /^continuation:.+:resolve$/.test(id);
+	return id.startsWith("continuation:") && !id.startsWith("continuation:done:") && !id.startsWith("continuation:window:");
 }
 
 /** Notify text the bridge relays straight to the operator. */
```
<!-- /patch:S20-resolve-id -->

<!-- patch:S20-bridge-text -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..30985b8 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -47,7 +47,7 @@ export function isResolveStop(id: string): boolean {
 
 /** Notify text the bridge relays straight to the operator. */
 export function isRelayOnlyNotice(text: string): boolean {
-	return /^(?:\[[^\]\n]+\] )?(?:HELD PR LANDED — |HELD PR STOPPED — \S+ \(continuation, next: resolve\)|CI GREEN — .* handled in code, no parent turn\.)/.test(text);
+	return false;
 }
 
 /** A custom message a wake rule sent with no parent turn; the bridge relays it. */
```
<!-- /patch:S20-bridge-text -->

<!-- patch:S20-bridge-flag -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..a064f40 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -53,7 +53,7 @@ export function isRelayOnlyNotice(text: string): boolean {
 /** A custom message a wake rule sent with no parent turn; the bridge relays it. */
 export function relayOnlyMessage(message: unknown): boolean {
 	const details = (message as { details?: unknown } | undefined)?.details;
-	return !!details && typeof details === "object" && (details as { relay_only?: unknown }).relay_only === true;
+	return false;
 }
 
 /** The fleet generation a wake for `jobId` is stamped with; undefined with no id or an unreadable fleet. */
```
<!-- /patch:S20-bridge-flag -->

<!-- patch:S20-cache-age -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..27e83f8 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -120,7 +120,7 @@ export class NextCache {
 	fresh(now = Date.now()): { kind: NextActionKind } | { reason: string } {
 		if (this.#error !== undefined) return { reason: `cp_next unavailable: ${this.#error}` };
 		if (this.#kind === undefined || this.#at === undefined) return { reason: "cp_next unavailable: never computed" };
-		return now - this.#at <= NEXT_CACHE_MAX_AGE_MS ? { kind: this.#kind } : { reason: "cp_next stale" };
+		return { kind: this.#kind };
 	}
 
 	attemptedRecently(now = Date.now()): boolean {
```
<!-- /patch:S20-cache-age -->

<!-- patch:S20-cache-fail -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..7809e2c 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -110,7 +110,7 @@ export class NextCache {
 	fail(message: string, at = Date.now()): void {
 		this.#kind = undefined;
 		this.#at = at;
-		this.#error = message;
+		this.#error = undefined;
 	}
 
 	attempt(at = Date.now()): void {
```
<!-- /patch:S20-cache-fail -->

<!-- patch:S20-cache-attempt -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..079d0bb 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -124,7 +124,7 @@ export class NextCache {
 	}
 
 	attemptedRecently(now = Date.now()): boolean {
-		return this.#attemptAt !== undefined && now - this.#attemptAt < NEXT_CACHE_MAX_AGE_MS;
+		return false;
 	}
 }
 
```
<!-- /patch:S20-cache-attempt -->

<!-- patch:S20-resolve-defer -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..28c5440 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -183,6 +183,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 		try {
 			if (!wakeRulesEnabled(home())) return false;
 			if (!deps.post().durableWakeups.pending().some((entry) => isResolveStop(entry.id))) return false;
+			return false;
 			const at = now();
 			if ("kind" in cache.fresh(at) || cache.attemptedRecently(at)) return false;
 			cache.attempt(at);
```
<!-- /patch:S20-resolve-defer -->

<!-- patch:S20-resolve-action -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..4f45b00 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -217,7 +217,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 		try {
 			if (!wakeRulesEnabled(home())) return false;
 			const state = cache.fresh(now());
-			const quiet = "kind" in state && isQuietKind(state.kind);
+			const quiet = "kind" in state;
 			const reason = "kind" in state ? `cp_next ${state.kind}` : state.reason;
 			const nextKind = "kind" in state ? { next_kind: state.kind } : {};
 			decided.set(entry.id, { wake_rule: "held_stop_resolve", decision: quiet ? "relayed" : "woke", reason, ...nextKind });
```
<!-- /patch:S20-resolve-action -->

<!-- patch:S20-ci-pending -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..34d5d43 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -273,7 +273,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 			});
 			const outcome: ContinuationOutcome | undefined = await Promise.race([pending, bound]).finally(() => clearTimeout(timer));
 			if (!outcome) return woke(`continuation unsettled after ${waitMs}ms`);
-			const reviewing = outcome.action === "review_started" || outcome.action === "review_pending";
+			const reviewing = outcome.action === "review_started";
 			if (outcome.job_id !== only.job_id || !reviewing || outcome.next !== "review") return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
 			let kind: NextActionKind;
 			try {
```
<!-- /patch:S20-ci-pending -->

<!-- patch:S20-ci-started -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..096a14b 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -273,7 +273,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 			});
 			const outcome: ContinuationOutcome | undefined = await Promise.race([pending, bound]).finally(() => clearTimeout(timer));
 			if (!outcome) return woke(`continuation unsettled after ${waitMs}ms`);
-			const reviewing = outcome.action === "review_started" || outcome.action === "review_pending";
+			const reviewing = outcome.action === "review_pending";
 			if (outcome.job_id !== only.job_id || !reviewing || outcome.next !== "review") return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
 			let kind: NextActionKind;
 			try {
```
<!-- /patch:S20-ci-started -->

<!-- patch:S20-ci-shape -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..b8a4a8e 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -240,7 +240,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 
 	/** A single green CI fact the continuation already turned into a review is relayed and confirmed, not a turn. */
 	const ciGreen = async (observations: readonly CiObservation[]): Promise<CiRuling> => {
-		const only = observations.length === 1 ? observations[0] : undefined;
+		const only = observations[0];
 		if (!only || only.event !== "ci_green") return { suppress: false };
 		// A later tick for a key still waiting on its outcome must not race it; the first pass owns the ruling.
 		if (ciInFlight.has(only.key)) return { suppress: true, relay: "CI GREEN — already being handled in code.", keys: [] };
```
<!-- /patch:S20-ci-shape -->

<!-- patch:S20-ci-nongreen -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..9b6705a 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -241,7 +241,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 	/** A single green CI fact the continuation already turned into a review is relayed and confirmed, not a turn. */
 	const ciGreen = async (observations: readonly CiObservation[]): Promise<CiRuling> => {
 		const only = observations.length === 1 ? observations[0] : undefined;
-		if (!only || only.event !== "ci_green") return { suppress: false };
+		if (!only) return { suppress: false };
 		// A later tick for a key still waiting on its outcome must not race it; the first pass owns the ruling.
 		if (ciInFlight.has(only.key)) return { suppress: true, relay: "CI GREEN — already being handled in code.", keys: [] };
 		ciInFlight.add(only.key);
```
<!-- /patch:S20-ci-nongreen -->

<!-- patch:S20-ci-once -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..743a103 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -254,7 +254,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 	const ciGreenRule = async (only: CiObservation): Promise<CiRuling> => {
 		const woke = (reason: string, extra: Record<string, unknown> = {}): CiRuling => {
 			const once = `ci_green:${only.key}`;
-			if (!journaled.has(once)) {
+			if (true) {
 				journaled.add(once);
 				journalWakeRule(runsOf(), only.job_id, { wake_rule: "ci_green", decision: "woke", reason, ...extra });
 			}
```
<!-- /patch:S20-ci-once -->

<!-- patch:S20-ci-overlap -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..1089f0e 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -243,7 +243,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 		const only = observations.length === 1 ? observations[0] : undefined;
 		if (!only || only.event !== "ci_green") return { suppress: false };
 		// A later tick for a key still waiting on its outcome must not race it; the first pass owns the ruling.
-		if (ciInFlight.has(only.key)) return { suppress: true, relay: "CI GREEN — already being handled in code.", keys: [] };
+		if (false) return { suppress: true, relay: "CI GREEN — already being handled in code.", keys: [] };
 		ciInFlight.add(only.key);
 		try {
 			return await ciGreenRule(only);
```
<!-- /patch:S20-ci-overlap -->

<!-- patch:S20-ci-off-outcomes -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..9392f91 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -274,7 +274,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 			const outcome: ContinuationOutcome | undefined = await Promise.race([pending, bound]).finally(() => clearTimeout(timer));
 			if (!outcome) return woke(`continuation unsettled after ${waitMs}ms`);
 			const reviewing = outcome.action === "review_started" || outcome.action === "review_pending";
-			if (outcome.job_id !== only.job_id || !reviewing || outcome.next !== "review") return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
+			if (false) return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
 			let kind: NextActionKind;
 			try {
 				kind = (await next()).action.kind;
```
<!-- /patch:S20-ci-off-outcomes -->

<!-- patch:S20-ci-unsettled -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..1f061c1 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -272,7 +272,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 				timer.unref();
 			});
 			const outcome: ContinuationOutcome | undefined = await Promise.race([pending, bound]).finally(() => clearTimeout(timer));
-			if (!outcome) return woke(`continuation unsettled after ${waitMs}ms`);
+			if (!outcome) return { suppress: true, relay: "CI GREEN incorrectly quiet", keys: [only.key] };
 			const reviewing = outcome.action === "review_started" || outcome.action === "review_pending";
 			if (outcome.job_id !== only.job_id || !reviewing || outcome.next !== "review") return woke(`outcome ${outcome.action}/${outcome.next ?? "none"}`);
 			let kind: NextActionKind;
```
<!-- /patch:S20-ci-unsettled -->

<!-- patch:S20-ci-new-key -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..a81d088 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -253,7 +253,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 	};
 	const ciGreenRule = async (only: CiObservation): Promise<CiRuling> => {
 		const woke = (reason: string, extra: Record<string, unknown> = {}): CiRuling => {
-			const once = `ci_green:${only.key}`;
+			const once = "ci_green";
 			if (!journaled.has(once)) {
 				journaled.add(once);
 				journalWakeRule(runsOf(), only.job_id, { wake_rule: "ci_green", decision: "woke", reason, ...extra });
```
<!-- /patch:S20-ci-new-key -->

<!-- patch:S20-ci-warms -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..24f21e1 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -169,7 +169,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 	const next = async (): Promise<NextResult> => {
 		try {
 			const result = await nextFor(deps.post(), deps.override);
-			cache.remember(result.action.kind, now());
+			// S20 control: do not warm the resolve cache after CI.
 			return result;
 		} catch (error) {
 			cache.fail(firstLine(error), now());
```
<!-- /patch:S20-ci-warms -->

<!-- patch:S20-ci-next-action -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..3f32fc4 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -281,7 +281,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 			} catch (error) {
 				return woke(`cp_next failed: ${firstLine(error)}`);
 			}
-			if (!isQuietKind(kind)) return woke(`cp_next ${kind}`, { next_kind: kind });
+			if (false) return woke(`cp_next ${kind}`, { next_kind: kind });
 			const project = homeProjectResolver(at)(only.job_id);
 			const relay = `${project ? `[${project}] ` : ""}CI GREEN — ${outcome.reason} — handled in code, no parent turn.${only.pr_url ? ` ${only.pr_url}` : ""}`;
 			journalWakeRule(runsOf(), only.job_id, { wake_rule: "ci_green", decision: "suppressed", reason: outcome.reason, next_kind: kind, action: outcome.action });
```
<!-- /patch:S20-ci-next-action -->

<!-- patch:S20-ci-next-failure -->
```diff
diff --git a/src/wake-rules.ts b/src/wake-rules.ts
index cac03d6..0c41046 100644
--- a/src/wake-rules.ts
+++ b/src/wake-rules.ts
@@ -279,7 +279,7 @@ export function createWakeRules(deps: WakeRulesDeps) {
 			try {
 				kind = (await next()).action.kind;
 			} catch (error) {
-				return woke(`cp_next failed: ${firstLine(error)}`);
+				return { suppress: true, relay: "CI GREEN incorrectly quiet after lookup failure", keys: [only.key] };
 			}
 			if (!isQuietKind(kind)) return woke(`cp_next ${kind}`, { next_kind: kind });
 			const project = homeProjectResolver(at)(only.job_id);
```
<!-- /patch:S20-ci-next-failure -->

<!-- patch:S20-head-source -->
```diff
diff --git a/extensions/command-post/helpers.ts b/extensions/command-post/helpers.ts
index f5039c6..d043121 100644
--- a/extensions/command-post/helpers.ts
+++ b/extensions/command-post/helpers.ts
@@ -505,7 +505,7 @@ export function wakeupHeadSources(
 	return {
 		ciHead: (jobId) => post.ciHead(jobId),
 		ciHeadObservedAt: (jobId) => post.ciHeadObservedAt(jobId),
-		fleetHead: (jobId) => post.reportedHeadSha(jobId),
+		fleetHead: (jobId) => post.ciHead(jobId),
 		fleetHeadAt: (jobId) => post.reportedHeadAt(jobId),
 	};
 }
```
<!-- /patch:S20-head-source -->

<!-- patch:S20-head-time -->
```diff
diff --git a/extensions/command-post/helpers.ts b/extensions/command-post/helpers.ts
index f5039c6..730bf5c 100644
--- a/extensions/command-post/helpers.ts
+++ b/extensions/command-post/helpers.ts
@@ -506,7 +506,7 @@ export function wakeupHeadSources(
 		ciHead: (jobId) => post.ciHead(jobId),
 		ciHeadObservedAt: (jobId) => post.ciHeadObservedAt(jobId),
 		fleetHead: (jobId) => post.reportedHeadSha(jobId),
-		fleetHeadAt: (jobId) => post.reportedHeadAt(jobId),
+		fleetHeadAt: (_jobId) => undefined,
 	};
 }
 
```
<!-- /patch:S20-head-time -->

<!-- patch:S20-watch-time -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..779778c 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -620,7 +620,7 @@ export class CiWatch {
 	 */
 	observedAt(jobId: string): string | undefined {
 		try {
-			return this.store.job(jobId)?.head_observed_at;
+			return this.store.job(jobId)?.last_checked_at;
 		} catch {
 			return undefined;
 		}
```
<!-- /patch:S20-watch-time -->

<!-- patch:S20-watch-failure -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..3094349 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -779,6 +779,7 @@ export class CiWatch {
 		}
 		this.#save(jobId, {
 			last_checked_at: isoTimestamp(now),
+			head_observed_at: isoTimestamp(now),
 			next_due_at: isoTimestamp(new Date(now.getTime() + nextDueMs(this.#cadence, { failures, settled: false }))),
 			consecutive_failures: failures,
 			last_error: message.slice(0, 300),
```
<!-- /patch:S20-watch-failure -->
<!-- manifest:regressions -->
| ID | Unit file | Bug commit | Scenario | Patch | sha256 | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| S21-NC-long | `tests/wakeup-journal.test.ts` | 636ec3990273 | S21-long | S21-long | 9fd54412bc0b81731730dcf3493cda8c271fc7aae8430edf11ba1e2a81a17ab0 | real forty-failure reconcile fallback has undefined candidate keys instead of 40 | pass |
| S16-NC1 | `tests/reviewer-model.test.ts` | fb70938e2e94680d9f6df1a76de53c5c633a6c8a | S16-model | S16-explicit | 5aaa41c24b9012ee897a1ceda1b5e4455095d382793c03fd294f0bd13c8f8c9d | explicit: selection source undefined instead of explicit | pass |
| S16-NC2 | `tests/reviewer-model.test.ts` | fb70938e2e94680d9f6df1a76de53c5c633a6c8a | S16-model | S16-schedule | c74f53c7ecd37c0f80bf1a4222610ee15b105bdd81900d3a6667f294036f0c18 | schedule actual: chosen reviewer receives plan is false | pass |
| S16-NC3 | `tests/reviewer-model.test.ts` | fb70938e2e94680d9f6df1a76de53c5c633a6c8a | S16-auto | S16-automatic | 283f1915f714569675e037df7b56da370e426f38715f8adb5a9d65464117e85b | automatic review reaches the mandated model is false | pass |
| NC-01 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-01-green | e5cc55b97d22e820228a709e858fbe2f7294fcc8dce00aa980f63982c09660f3 | wake observation names run 2 (skipped), not run 6 | pass |
| NC-02 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-02-integrate | 0a2c3b3942c839731d201a0a07d8ddf2c6bf6ea2d6163d5a00430568bb3d6e86 | the ci fact does not end with (run 6 …/actions/runs/6) | pass |
| NC-03 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-2 | NC-03-host | 0bb48b55ddc16d72b68109e136da58d310bb118ebbe641f411e9ba7980ef6ac0 | the enterprise ci fact links ghe.example.com/…/actions/runs/16 | pass |
| S07-NC-1 | `tests/integrate-held-ci.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S07 | S07-NC-1 | 514a60abe4fb0adfa420e8b12651e3e1641c36ee4446eed0e1bf4e7900347d18 | revoked error expected /is revoked/, actual no live worker; authority must precede worker lookup | pass |
| NC-main-corrupt | `tests/main-ci.test.ts` | 8a41e6c50b89e4de21c159a104f3633de32a3a82 | 05-main-corrupt | NC-main-corrupt | 4609cbb374efaa4b725a8029ae2dfd1d8efd04b889f42e408d109f6cd7f3cb6f | in-flight latch mutation preserves corrupt bytes | pass |
| S20-repeat | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-repeat | 28b2c86b9aa7dc48af8d5d37caf338ed8d035e8c0e1786785fcc5f42e2fd573d | second status call repeats PR instead of none-new count | pass |
| S20-disk | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-disk | 25781adcb27a8bb791bb3666bd619a232376ec9482c4d20e73bf185b7d1aa012 | resumed parent repeats PR instead of none-new count | pass |
| S20-heal | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-heal | 1ff2fd042a02a26d310884f7b0b7e36e18c1073b4d098386ef741271ec2944bc | unreadable memory is not healed and resumed status replays rows | pass |
| S20-scope | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-scope | 1979c64bd0ff0d757ab8a03e58f70e7887ae2fc9881ec0df4283a870f9d1410a | fresh session suppresses PR that belongs to another session | pass |
| S20-writer | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-writer | 9d5a5a464821a70233d363057c4d734159e49c7f5a82231135ce2c93579987c5 | writing a second session drops others; persisted session count is wrong | pass |
| S20-mirror | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-mirror | 0abb5ceefb9923ddbfc8b94c8a7629dd5fe7814da10cb654eb8651cbaa1871be | corrupt memory replays already printed rows in fourth tool result | pass |
| S20-id-bound | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-id-bound | 902f1f03b8a886f392418aa3e6f60437307e95e253fa8d3a6f28c980b0351c9f | persisted ID tail loses newly reported jobs | pass |
| S20-session-bound | `tests/shipped-seen.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-shipped | S20-session-bound | aef63e5edaa170bfb1baa3c3159a3bd52f5ff450277bfde5115a5471e77ab809 | cap+1 writer is absent from newest session position | pass |
| S20-filter | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-filter | 14db3817c5581d52c2ccf56ec34de10fad5eb2cf6fd69a5b220ef4f5ccaeab8d | obsolete body exclusion fails | pass |
| S20-findings | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-findings | fa99feec45af268d962ea958bfccf37edc5a258fab05cf15a12376230c7a76df | medium finding presence fails | pass |
| S20-tail | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-tail | bd009e0d7deae7ca260dcbac0b46be8b9a3b96ed37fe3a0d2202b817bbcebec1 | exact neutral tail text absent | pass |
| S20-recovery-replay | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-recovery-replay | 489ab96e7035f3100627cb0aa4c6544919a086a6ee9774e3705f26c6aaabea9d | duplicate landing body exclusion fails | pass |
| S20-recovery-gone | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-recovery-gone | 1c262e06a68009716aa8ad3325cd0e3534cf325311161fabd959ffb08acece4b | jobless gone body exclusion fails | pass |
| S20-context-journal | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-context | S20-context-journal | 4ef20e8fe22d3ea60a790ee501ac50f9e0f66e4777f41272875eec90a290c2f3 | suppression journal assertion fails | pass |
| S20-busy | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-busy | S20-busy | 41d32cf8ce215819a012372aeda2d5d501cb5f5b80b038edbe3c67deb0cd5625 | W2/W3 not carried in first follow-up | pass |
| S20-send-first | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-busy | S20-send-first | ec43e840813d1220b9715ad02e59fc1b9392064d475b91f429c20fef914fe94e | held session body exclusion fails | pass |
| S20-nudge | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-busy | S20-nudge | b0788e221f06ad29a1fe087331a6c24d57f8a2b9f108d66ea42c7a0766c9a808 | timeout waiting for stranded-notice request | pass |
| S20-abort | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-abort | S20-abort | b8cc6126c20b0047c1b1439c39eb8dd0a385c96b4ecf28d551b7f1db7924a93b | nudge absent assertion fails on resumed context | pass |
| S20-answered-hold | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-busy | S20-answered-hold | 2d96953f09d83477bf9f9ec54a20094ad0e08c18c326d36913e6a1de3d104942 | first follow-up lacks bypass answer | pass |
| S20-answered-busy | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-busy | S20-answered-busy | ad7d87d70993beb29b4201640cc39c1a27257acffa5a8868619767b63f115561 | carried-answer request unexpectedly includes nudge | pass |
| S20-tool-answer | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-tool | S20-tool-answer | 13033311aabc217f60082571c8d3c8cc0f3f5f3e39e486d6f2c86a3b456fe960 | held second body leaked into tool continuation | pass |
| S20-settled-release | `tests/stale-notice-context.test.ts` | f10ff48d2e8914b669ad4601dac3886be8f15f63 | 06-S20-tool | S20-settled-release | 0a8f08320a58c36fb00977a3ec3025fe41f099c72b0b0c8dbf4b4cf3dd027e63 | timeout waiting for held notice after provider error | pass |
| S20-head-source | `tests/wakeup-head-sources.test.ts` | c7cf30bd8ace68d33d71bf6539db45a12ffe30b4 | 06-S20-head | S20-head-source | b3a9fbb4afd5d17fdeff125053489ddfa006acffda7a6f017e12d0bf2f0e59b9 | initial authoritative verdict absent | pass |
| S20-head-time | `tests/wakeup-head-sources.test.ts` | c7cf30bd8ace68d33d71bf6539db45a12ffe30b4 | 06-S20-head | S20-head-time | dc3632783dcd5404031703d0cd2e5b9915855a052e324ab833f0bda1db6a83d4 | newer-head verdict body leaks | pass |
| S20-watch-time | `tests/wakeup-head-sources.test.ts` | c7cf30bd8ace68d33d71bf6539db45a12ffe30b4 | 06-S20-head | S20-watch-time | 7a71869f5237dd0492d184a6885747dbea2b54ea134a1cfb2b9e573b1864c660 | initial authoritative verdict absent | pass |
| S20-watch-failure | `tests/wakeup-head-sources.test.ts` | c7cf30bd8ace68d33d71bf6539db45a12ffe30b4 | 06-S20-head | S20-watch-failure | 2b44580427f1d46396495a3412b0e7006ab65b86af9b7321fd8326328187b851 | failed query advances observation timestamp | pass |
| S20-rule-switch | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-switch | S20-rule-switch | a28e341b8b1e6b0b714282e469b4b423819772cf029b29464cab4eeb809f8c3d | malformed enabled string fails to reach provider | pass |
| S20-resolve-id | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-identities | S20-resolve-id | 368525224456f79a83a81bb5d8452a2ff4bcd47e945a3811202ab13360ca3e17 | non-resolve notices incorrectly acquire resolve journal rulings | pass |
| S20-bridge-text | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-bridge | S20-bridge-text | 948ecc94fc7d4bd48433b95f7b52613aae00df66f0df8e825298aa7afc52d42e | bridge startup relay notifications never arrive | pass |
| S20-bridge-flag | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-bridge | S20-bridge-flag | 148f2c1dc068fe0366e6a17bf2e00eb3bf87391b2fb678a7e7ef9a7ae4b9babc | flagged custom message never reaches the bridge consumer | pass |
| S20-cache-age | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-expiry | S20-cache-age | 4e4bf0f31851b7bf26045e3e547a099b6f2d5facd4344090cb4eb017c90d0c2f | expired cache fails to wake for independent ready work | pass |
| S20-cache-fail | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-failure | S20-cache-fail | 641536fdce338c2580c914632cdf693d787bba38aafaacd2a94d56ec25092cff | failure reason incorrectly says never computed | pass |
| S20-cache-attempt | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-failure | S20-cache-attempt | 42624e0d750901a6134ab26a157a0f4df14fda8e15110e67a081217c564ffcf8 | restored ledger is retried early and strands the remembered-failure wake | pass |
| S20-resolve-defer | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-switch | S20-resolve-defer | 5706f5c35cdf16520ba9bb68e38d6393c9633844137216f121de9e8ffb0ce97e | initial resolve journals woke instead of relayed/no_mandate | pass |
| S20-resolve-action | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-expiry | S20-resolve-action | 27d66990db6425defc93ab6c9dccd7dff95b5b7e114295b0b498ec814cb97efc | actionable dispatch is incorrectly quiet and never reaches provider | pass |
| S20-ci-pending | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-review-pending | S20-ci-pending | 10f7337427ba5616f8879b78d38114c5e84104f8af2fbb332048f815a26a9733 | pending-review notice lacks handled-in-code relay wording | pass |
| S20-ci-started | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-review-start | S20-ci-started | a8391518d6d74b94b8d317fc4aee38fa3bbd68950916c14f8c9ccff41e9f6c73 | newly started review lacks handled-in-code relay wording | pass |
| S20-ci-shape | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-batch | S20-ci-shape | 519b3abe95bc046323a2d4e16d1e45d17bd0bf5abcd67961aa9aebcd04104ff5 | two-fact CI batch never reaches provider | pass |
| S20-ci-nongreen | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-batch | S20-ci-nongreen | 93fe86bdc349198d1c807a029cc0f2e2ac60601a84db3f019bf422fcd01df38d | red fact incorrectly produces a ci_green journal ruling | pass |
| S20-ci-once | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-ci-off | S20-ci-once | 19e4ee2c3eeb76ba7ad6fb84afab10d8e1431d7de75d08c7d1b6efd33785c7ad | bounded resend writes duplicate woke journal rulings | pass |
| S20-ci-overlap | `tests/wake-rules.test.ts` | 2546252cfaad8a0b8a28a90fe9489fd59087b963 | 06-S20-overlap | S20-ci-overlap | 02e7eefc72d6a6c157fffb939e56ffb522afe4536fbd36777534c5b0d1d1f544 | overlapping sweep receives an owning ruling instead of the no-keys relay | pass |
| S20-ci-off-wait | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-wait | S20-ci-off-outcomes | fa1e5a52f5196dc6f276d0c41696ed59d76424bc32d2fe090c04364287d625fa | held wait fact never reaches provider | pass |
| S20-ci-off-stopped | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-stopped | S20-ci-off-outcomes | fa1e5a52f5196dc6f276d0c41696ed59d76424bc32d2fe090c04364287d625fa | closed PR fact never reaches provider | pass |
| S20-ci-off-coalesced | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-coalesced | S20-ci-off-outcomes | fa1e5a52f5196dc6f276d0c41696ed59d76424bc32d2fe090c04364287d625fa | coalesced legacy fact never reaches provider | pass |
| S20-ci-off-done | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-done | S20-ci-off-outcomes | fa1e5a52f5196dc6f276d0c41696ed59d76424bc32d2fe090c04364287d625fa | ordinary operator CI notification never emitted after landing | pass |
| S20-ci-unsettled | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-unsettled | S20-ci-unsettled | 2e4d8edbda38a530979ee609e3df6e7508cd22c4a10d27f1fe030f7908389666 | bound expires without a provider CI notice | pass |
| S20-ci-new-key | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-new-key | S20-ci-new-key | 0f6034a69619fe50d628bb00b4ef308abdf922142d39c99b538799aa13ceda6a | second independent head has no woke measurement | pass |
| S20-ci-warms | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-warms | S20-ci-warms | a58faaeb691b9bd2deed6043c7f77128f70d46b7de54fc358d8874ce734da263 | resolve is woke/unavailable instead of relayed/wait | pass |
| S20-ci-next-dispatch | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-next-dispatch | S20-ci-next-action | 67fcefe5391e091f3216fd02a55779f4434d0490c7caa4a5ef53ac00039e6d44 | independent dispatch CI fact never reaches provider | pass |
| S20-ci-next-mission | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-next-mission | S20-ci-next-action | 67fcefe5391e091f3216fd02a55779f4434d0490c7caa4a5ef53ac00039e6d44 | mission end CI fact never reaches provider | pass |
| S20-ci-next-failure | `tests/wake-rules.test.ts` | 00fbbefaf818a1afdcc257290a50a18f18962ba5 | 06-S20-ci-next-failure | S20-ci-next-failure | fb032d69ca70d705b476133bb2b97e48460acc70ad358666d07d5a40bb8d2c7b | failed lookup CI fact never reaches provider | pass |
| S24-oldest | `tests/operator-context.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-context | S24-oldest | 846e30e759797d70e7938e9b158f37e8690539b8b7a0fd425c25738bb502f5bd | newest handoff regex missing in provider request | pass |
| S24-empty | `tests/operator-context.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-empty | S24-empty | 5774bcca5420abe9c0ff0493b33738ae1d0c2e1fb4deb7158b3e4bb216989eb5 | context count 1 instead of 0 | pass |
| S24-resume | `tests/operator-context.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-context | S24-resume | 18b964ca774a4867cec756874c63e78de547505864cb67212ba36364333afd73 | SHOULD NOT RELOAD present in resumed provider request | pass |
| S24-hold | `tests/dashboard-compaction.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-dashboard-hold | S24-hold | 9e7a47bdb0fa37de27b1035fef9db0d4637f57b6254c1335fe33134c04bc74d7 | queued delivery times out with request,queued | pass |
| S24-rehand | `tests/dashboard-compaction.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-dashboard-rehand | S24-rehand | 386112058b6e0075910469d7a5ecb318a976007c8ec9906d779e90f7267ff3a6 | delivery after re-hand remains failed | pass |
| S24-third | `tests/dashboard-compaction.test.ts` | 2f9613010dabcfb43a97733e3d320ce85a97209d | S24-dashboard-terminal | S24-third | 23c346dfd1f2efb8f7ccb087896536bc5fb58318d577463fac98ef7b03ad4dec | expected failed, actual third injection and delivered | pass |
| S24-macrotask | `tests/dashboard-compaction.test.ts` | df24d7e506776d2bc72efd583258f413040f9b81 | S24-dashboard-hold | S24-macrotask | 432df65cb3d18d995a048705e158a9f4918527c79790fc6f552e65c6325941c3 | held while compacting: queue_edit returned 409 already sent | pass |
| S24-compact-validation | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-invalid | S24-compact-validation | 32cb62a57d73c6da388158a9ed6b2c0a186fd28a970b5c07be7802a5158bf155 | refusal assertion fails | pass |
| S24-compact-under | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-invalid | S24-compact-under | 81f25789e77d8bb452c6965d19d764d7be3ba6fed90ad74e779f8fdb0d36f2d5 | small-context tool queues | pass |
| S24-compact-early | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-queued | S24-compact-early | 0d32cf3d8b836c51c4badff0298146e81c54dd5f51a40e8a3d9ebdc4d886a08b | settlement ordering and ignored-request backstop fail | pass |
| S24-compact-default | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-settings | S24-compact-default | 24370e52702ca34311eaa2e21147205c0b023d53db9b33a9b797e5d1dad150a6 | request count wrong for invalid setting | pass |
| S24-compact-failures | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-failures | S24-compact-failures | 8afef31cb9e6d7ef399d077f3f82cab91b2827bf887a4a5d8dce7ebc6b1e6efb | automatic retries stop before third failure | pass |
| S24-compact-spent | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-spent | S24-compact-spent | 3a25e20ca600b735f2ef0e72c7a1afa2ec62a34e49e57e81d8e7ec9e9c9e16f5 | benign/failed skip and explicit compact lose spent-streak refusal | pass |
| S24-compact-abort | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-explicit | S24-compact-abort | badc4eb41b772fd6af372968c0b37a085eb4ec34464b3ffd4d138d321214b7bb | aborted reply clears spent streak | pass |
| S24-compact-callback | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-relays | S24-compact-callback | aa0bac8dca155b7037c9be416b45e1a20f33d850b481b05f56130ee5f1337df2 | both variants time out awaiting durable relay ack | pass |
| S24-compact-relay-gate | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-order | S24-compact-relay-gate | 1f828a8374e4999c073a6dca2d7f4750a27493b7516fb0793c939d916e79a7eb | pre-release no-emit and one-handoff counts fail | pass |
| S24-compact-streak-cap | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-streak | S24-compact-streak-cap | 057321bc702633cb0e6f5c1b980c06f5391425f948247b7cb2550dd9e81ff255 | only two compactions instead of three | pass |
| S24-compact-nudge | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-nudge | S24-compact-nudge | 43337e880bed8164c842a699514fafd5b12cdc7330efb8bba99e33f9c7dda840 | unanswered relay IDs absent | pass |
| S24-compact-enrich | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-manual | S24-compact-enrich | 6e501f2944fbc91d41d8484569d27ff3462e6e02e92f9426fd4e39601cc3617c | all four manual and threshold/overflow variants lose enrichment | pass |
| S24-compact-own | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-queued | S24-compact-own | 169ec45fbc2df437078792d5705a4468326893289ca7bd553902d075461387e4 | own-instructions summarizer enriched twice | pass |
| S24-compact-write | `tests/operator-compact.test.ts` | f270756f95b469990583ce7e78a1df5c1889c0d0 | S24-op-write | S24-compact-write | fcdcc0c46570235fb9183e2b502f35ded62c444e06b6a2383b535024a8b446aa | handoff-write failure swallowed and queues | pass |
| S24-parent-busy | `tests/parent-compact-hold.test.ts` | a61a117757f69c6a7ea28d23be8a1ccf80f74d97 | S24-parent-order | S24-parent-busy | 26be9270d4e8788e207d7579e9b6170932a8e5d269ead234f61a6cf6c33b23c4 | busy hold fails before operator question; fleet CI case fails too | pass |
| S24-parent-cap | `tests/parent-compact-hold.test.ts` | a61a117757f69c6a7ea28d23be8a1ccf80f74d97 | S24-parent-expiry | S24-parent-cap | c28f74e7e0c55ffc55762935e0e5d3ca4cdbd94122a8bd1794d25e80728f0273 | five-second cap never releases within ten-second wait | pass |
| S24-parent-context | `tests/parent-compact-hold.test.ts` | a61a117757f69c6a7ea28d23be8a1ccf80f74d97 | S24-parent-immediate | S24-parent-context | 20ac331c3e4164b4068acca4f84cd6963b3928269a5647cea211fefec4dfbeb8 | low, disabled and non-headless variants fail | pass |
| S24-parent-length | `tests/parent-compact-hold.test.ts` | a61a117757f69c6a7ea28d23be8a1ccf80f74d97 | S24-parent-length | S24-parent-length | bebe12afe7dc59b1d975a0d9eba0574ee2bbf07ad635b5e1ae0aea296170172c | no threshold cancellation for length stops | pass |
| S24-parent-order | `tests/parent-compact-hold.test.ts` | a61a117757f69c6a7ea28d23be8a1ccf80f74d97 | S24-parent-order | S24-parent-order | b82c3848c083d61f935ef90b66e21dbfb29e7ad51fa5efb13ca0042292cdd31a | schedule wakes arrive C/B/A instead of A/B/C | pass |
<!-- patch:S24-compact-validation -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -100,5 +100,0 @@
-			if (!instructions) throw new Error("self_compact refused: empty instructions");
-			if (instructions.length < 200) throw new Error("self_compact refused: instructions must be at least 200 characters");
-			if (!/(?:^|[\s`("'\[])(?:~\/|\/|\.{1,2}\/)?(?:[\w.-]+\/)+[\w.:-]+\.[\w-]+(?=$|[\s`"')\].,;:])/.test(instructions)) {
-				throw new Error("self_compact refused: instructions must mention a handoff file path");
-			}
```
<!-- /patch:S24-compact-validation -->
<!-- patch:S24-compact-under -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -111 +111 @@
-			if (typeof tokens === "number" && tokens < limit) {
+			if (false) {
```
<!-- /patch:S24-compact-under -->
<!-- patch:S24-compact-early -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -174 +174 @@
-	pi.on("agent_settled", (_event, ctx) => {
+	pi.on("turn_end", (_event, ctx) => {
```
<!-- /patch:S24-compact-early -->
<!-- patch:S24-compact-default -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -9 +9 @@
-export const OPERATOR_COMPACT_DEFAULT_TOKENS = 200000;
+export const OPERATOR_COMPACT_DEFAULT_TOKENS = 500;
```
<!-- /patch:S24-compact-default -->
<!-- patch:S24-compact-failures -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -13 +13 @@
-const MAX_AUTO_FAILURES = 3;
+const MAX_AUTO_FAILURES = 1;
```
<!-- /patch:S24-compact-failures -->
<!-- patch:S24-compact-spent -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -139 +138,0 @@
-		if (streak) streak.compacted = true; // any compaction during a streak is the streak's one
```
<!-- /patch:S24-compact-spent -->
<!-- patch:S24-compact-abort -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -132 +132 @@
-		if (role === "assistant" && stopReason !== "error" && stopReason !== "aborted") {
+		if (role === "assistant" && stopReason !== "error") {
```
<!-- /patch:S24-compact-abort -->
<!-- patch:S24-compact-callback -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -72 +72 @@
-		for (const fn of deferred.splice(0)) fn();
+		deferred.splice(0);
```
<!-- /patch:S24-compact-callback -->
<!-- patch:S24-compact-relay-gate -->
```diff
diff --git a/extensions/cp-bridge/index.ts b/extensions/cp-bridge/index.ts
--- a/extensions/cp-bridge/index.ts
+++ b/extensions/cp-bridge/index.ts
@@ -309 +309 @@
-			if (!compaction.compacting()) return false;
+			if (true) return false;
```
<!-- /patch:S24-compact-relay-gate -->
<!-- patch:S24-compact-streak-cap -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -15 +15 @@
-const MAX_STREAK_COMPACTIONS = 3;
+const MAX_STREAK_COMPACTIONS = 2;
```
<!-- /patch:S24-compact-streak-cap -->
<!-- patch:S24-compact-nudge -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -188 +188 @@
-				const relays = unanswered.slice();
+				const relays: string[] = [];
```
<!-- /patch:S24-compact-nudge -->
<!-- patch:S24-compact-enrich -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -232 +231,0 @@
-		event.preparation.messagesToSummarize.push({ role: "user", content: instructions, timestamp: Date.now() });
```
<!-- /patch:S24-compact-enrich -->
<!-- patch:S24-compact-own -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -214 +213,0 @@
-		if (running && event.customInstructions === running) return;
```
<!-- /patch:S24-compact-own -->
<!-- patch:S24-compact-write -->
```diff
diff --git a/src/operator-compact.ts b/src/operator-compact.ts
--- a/src/operator-compact.ts
+++ b/src/operator-compact.ts
@@ -119 +119 @@
-			catch (error) { throw new Error(`self_compact handoff write failed: ${handoff}: ${String(error)}`); }
+			catch {}
```
<!-- /patch:S24-compact-write -->
<!-- patch:S24-parent-busy -->
```diff
diff --git a/src/parent-compact-hold.ts b/src/parent-compact-hold.ts
--- a/src/parent-compact-hold.ts
+++ b/src/parent-compact-hold.ts
@@ -119 +118,0 @@
-		if (reading.over && !this.holding) this.#engage("busy", reading);
```
<!-- /patch:S24-parent-busy -->
<!-- patch:S24-parent-cap -->
```diff
diff --git a/src/parent-compact-hold.ts b/src/parent-compact-hold.ts
--- a/src/parent-compact-hold.ts
+++ b/src/parent-compact-hold.ts
@@ -163 +163 @@
-		this.#cancelCap = this.#timer(() => this.#release("cap_timeout", true), parentCompactHoldMs());
+		this.#cancelCap = this.#timer(() => this.#release("cap_timeout", true), PARENT_COMPACT_HOLD_MS);
```
<!-- /patch:S24-parent-cap -->
<!-- patch:S24-parent-context -->
```diff
diff --git a/src/parent-compact-hold.ts b/src/parent-compact-hold.ts
--- a/src/parent-compact-hold.ts
+++ b/src/parent-compact-hold.ts
@@ -45 +45 @@
-	if (!ctx || !isHeadlessParent(ctx, env)) return NOT_OVER;
+	if (!ctx) return NOT_OVER;
@@ -47 +47 @@
-		const threshold = parentSettings(home()).compact_at_tokens;
+		const threshold = 1;
```
<!-- /patch:S24-parent-context -->
<!-- patch:S24-parent-length -->
```diff
diff --git a/src/parent-compact-hold.ts b/src/parent-compact-hold.ts
--- a/src/parent-compact-hold.ts
+++ b/src/parent-compact-hold.ts
@@ -68 +68 @@
-	if (event.reason !== "threshold") return undefined;
+	if (true) return undefined;
```
<!-- /patch:S24-parent-length -->
<!-- patch:S24-parent-order -->
```diff
diff --git a/src/parent-compact-hold.ts b/src/parent-compact-hold.ts
--- a/src/parent-compact-hold.ts
+++ b/src/parent-compact-hold.ts
@@ -198 +198 @@
-		for (const fn of held) fn();
+		for (const fn of held.reverse()) fn();
```
<!-- /patch:S24-parent-order -->

<!-- /manifest:regressions -->

<!-- patch:S24-macrotask -->
```diff
diff --git a/extensions/cp-bridge/index.ts b/extensions/cp-bridge/index.ts
--- a/extensions/cp-bridge/index.ts
+++ b/extensions/cp-bridge/index.ts
@@ -356 +356 @@
-		setImmediate(() => compaction.whenIdle(() => control?.settled()));
+		compaction.whenIdle(() => control?.settled());
```
<!-- /patch:S24-macrotask -->

<!-- patch:S24-hold -->
```diff
diff --git a/extensions/cp-bridge/index.ts b/extensions/cp-bridge/index.ts
--- a/extensions/cp-bridge/index.ts
+++ b/extensions/cp-bridge/index.ts
@@ -356 +356 @@
-		setImmediate(() => compaction.whenIdle(() => control?.settled()));
+		setImmediate(() => control?.settled());
```
<!-- /patch:S24-hold -->

<!-- patch:S24-rehand -->
```diff
diff --git a/src/dashboard-control.ts b/src/dashboard-control.ts
--- a/src/dashboard-control.ts
+++ b/src/dashboard-control.ts
@@ -401 +401 @@
-			if (tries < 2) { give(entry, tries + 1); return true; }
+			if (tries < 1) { give(entry, tries + 1); return true; }
```
<!-- /patch:S24-rehand -->

<!-- patch:S24-third -->
```diff
diff --git a/src/dashboard-control.ts b/src/dashboard-control.ts
--- a/src/dashboard-control.ts
+++ b/src/dashboard-control.ts
@@ -401 +401 @@
-			if (tries < 2) { give(entry, tries + 1); return true; }
+			if (tries < 3) { give(entry, tries + 1); return true; }
```
<!-- /patch:S24-third -->

<!-- patch:S24-oldest -->
```diff
diff --git a/src/operator-context.ts b/src/operator-context.ts
--- a/src/operator-context.ts
+++ b/src/operator-context.ts
@@ -17 +17 @@
-	return stamped.sort((a, b) => b.at - a.at)[0]?.file;
+	return stamped.sort((a, b) => a.at - b.at)[0]?.file;
```
<!-- /patch:S24-oldest -->

<!-- patch:S24-empty -->
```diff
diff --git a/src/operator-context.ts b/src/operator-context.ts
--- a/src/operator-context.ts
+++ b/src/operator-context.ts
@@ -35 +35 @@
-	if (parts.length === 0) return undefined;
+	if (parts.length === 0) return "unexpected empty context";
```
<!-- /patch:S24-empty -->

<!-- patch:S24-resume -->
```diff
diff --git a/extensions/cp-bridge/index.ts b/extensions/cp-bridge/index.ts
--- a/extensions/cp-bridge/index.ts
+++ b/extensions/cp-bridge/index.ts
@@ -524 +524 @@
-			if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) {
+			if (true) {
```
<!-- /patch:S24-resume -->
<!-- patch:S21-long -->
```diff
diff --git a/src/recovery-notice.ts b/src/recovery-notice.ts
index 9ba8c60..298d34b 100644
--- a/src/recovery-notice.ts
+++ b/src/recovery-notice.ts
@@ -25,11 +25,5 @@ export function formatRecoveryNotice(candidates: readonly RecoveryCandidate[], p
 		lines.push(`  next: ${next.join(" or ") || "cp_teardown the listed jobs"}.`);
 		return lines.join("\n");
 	};
-	let shown = candidates.length;
-	let text = render(candidates);
-	while (text.length > RECOVERY_NOTICE_MAX_CHARS && shown > 1) {
-		shown = Math.max(1, Math.min(shown - 1, Math.floor(shown * (RECOVERY_NOTICE_MAX_CHARS / text.length))));
-		text = render(candidates.slice(0, shown));
-	}
-	return text.slice(0, RECOVERY_NOTICE_MAX_CHARS);
+	return render(candidates);
 }
```
<!-- /patch:S21-long -->

<!-- patch:S16-explicit -->
```diff
diff --git a/src/reviewer-model.ts b/src/reviewer-model.ts
index 9a8a190..d43a740 100644
--- a/src/reviewer-model.ts
+++ b/src/reviewer-model.ts
@@ -29,7 +29,7 @@ export function selectReviewerModel(input: {
 	const runModel = run && runModelFor(run, "reviewer"), thinking = run?.execution?.effective.thinking as ThinkingLevel | undefined;
 	const chosenModel = runModel ?? input.model;
 	if (run && (runModel || thinking)) return { ...(chosenModel ? { model: chosenModel } : {}), source: "schedule-run", run_id: run.id, ...(thinking ? { thinking } : {}) };
-	if (input.model !== undefined) return { model: input.model, source: "explicit" };
+ if (input.model !== undefined) return undefined;
 	if (!record) return undefined;
 	if (mandates) {
 		const subject = {
```
<!-- /patch:S16-explicit -->

<!-- patch:S16-schedule -->
```diff
diff --git a/src/reviewer-model.ts b/src/reviewer-model.ts
index 9a8a190..5f2e317 100644
--- a/src/reviewer-model.ts
+++ b/src/reviewer-model.ts
@@ -35,7 +35,7 @@ export function selectReviewerModel(input: {
 		const subject = {
 			jobId: record.job_id, project: record.project, jobKind: record.kind,
 			startedAt: record.dispatched_at, inFlight: true,
-			...(record.schedule_id ? scheduleScope(record.schedule_id, mandates.scheduleMandates()) : mandates.scheduleOf(record.job_id)),
+   ...(record.schedule_id ? {} : mandates.scheduleOf(record.job_id)),
 		};
 		const eligible = mandates.list().filter((grant) => grant.reviewer_model !== undefined && grant.status !== "paused" && grant.status !== "revoked")
 			.map((grant) => ({ grant, at: grantStanding(grant, "review", subject, isoTimestamp(input.now)) }))
```
<!-- /patch:S16-schedule -->

<!-- patch:S16-automatic -->
```diff
diff --git a/src/reviewer-model.ts b/src/reviewer-model.ts
index 9a8a190..058b9e2 100644
--- a/src/reviewer-model.ts
+++ b/src/reviewer-model.ts
@@ -31,6 +31,7 @@ export function selectReviewerModel(input: {
 	if (run && (runModel || thinking)) return { ...(chosenModel ? { model: chosenModel } : {}), source: "schedule-run", run_id: run.id, ...(thinking ? { thinking } : {}) };
 	if (input.model !== undefined) return { model: input.model, source: "explicit" };
 	if (!record) return undefined;
+ if (record.kind === "ship") return undefined;
 	if (mandates) {
 		const subject = {
 			jobId: record.job_id, project: record.project, jobKind: record.kind,
```
<!-- /patch:S16-automatic -->

<!-- patch:NC-main-corrupt -->
```diff
diff --git a/src/main-ci.ts b/src/main-ci.ts
index 6fa8248..eed3141 100644
--- a/src/main-ci.ts
+++ b/src/main-ci.ts
@@ -120,7 +120,7 @@ export class MainCiStore {
 	/** Never overwrite an unreadable file: that would drop other projects' rows and re-fire their wakes. */
 	#rows(): MainCiEntry[] {
 		const read = this.read();
-		if (!read.ok) throw new MainCiError(`${read.error}; not overwritten — fix or delete ${this.file}`);
+		if (!read.ok) return [];
 		return read.file.projects;
 	}
 
```

NC-01 brings back the pre-#131 rule, where any non-success conclusion was the failing run:

<!-- patch:NC-01-green -->
```diff
--- a/src/ci-run-ref.ts
+++ b/src/ci-run-ref.ts
@@ -15,5 +15,5 @@
 /** The first completed run on `head` whose conclusion is not green, or `undefined`. */
 export function failedRunOn(runs: readonly CiRun[], head: string | undefined): CiRun | undefined {
-	return runs.find((run) => shaMatches(run.headSha, head) && run.status === "completed" && !GREEN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
+	return runs.find((run) => shaMatches(run.headSha, head) && run.status === "completed" && (run.conclusion ?? "").toLowerCase() !== "success");
 }
 
```

```
✖ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: [ 'ci_failed', 'f5058acb…', 2, 'https://github.com/example/demo/actions/runs/2' ],
    expected: [ 'ci_failed', 'f5058acb…', 6, 'https://github.com/example/demo/actions/runs/6' ],
ℹ pass 1
ℹ fail 1
```

NC-02 withholds the run reference from `cp_integrate`'s CI-failed fact:

<!-- patch:NC-02-integrate -->
```diff
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -486,3 +486,3 @@
 		else if (older.length) ci = readCiForHead({ branch, headSha: head, runs: older });
-		const runRef = ci.ci === "failed" ? formatRunRef(ciRunRef(runsParsed, head, prUrl)) : "";
+		const runRef = "";
 		facts.push(`ci: ${ci.ci} — ${ci.reason}${runRef}`);
```

```
✖ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on d6e051c (ci) — merging red is forbidden
✖ ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on 4b2857c (ci) — merging red is forbidden
ℹ pass 0
ℹ fail 2
```

NC-03 derives an Actions link for any host:

<!-- patch:NC-03-host -->
```diff
--- a/src/ci-run-ref.ts
+++ b/src/ci-run-ref.ts
@@ -21,3 +21,3 @@
 export function runUrl(prUrl: string | undefined, id: number): string | undefined {
-	const repo = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(prUrl ?? "")?.[1];
+	const repo = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(prUrl ?? "")?.[1];
 	return repo ? `${repo}/actions/runs/${id}` : undefined;
```

```
✔ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
✖ ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on 582b570 (ci) — merging red is forbidden
    (run 16 https://ghe.example.com/example/demo/actions/runs/16)
ℹ pass 1
ℹ fail 1
```

NC-24 reads any 403 or 404 as the token's denial, HTML proxy pages included (P3; fixed run: 4 pass, 0 fail):

```
✖ landing: a denied, rate-limited, malformed, partial or capped Actions read never merges and names its cause; a full paged read finds page two's failure
  AssertionError [ERR_ASSERTION]: HTML 403: gh: https://github.com/example/demo/pull/81 is OPEN at …
ℹ pass 3
ℹ fail 1
```

NC-25 takes an empty first workflows page as no CI, whatever total_count says:

```
✖ landing: only an authoritative empty workflow list is no CI; every unanswered workflows read keeps its own cause and never reads as none
  AssertionError [ERR_ASSERTION]: a truncated page: ci configuration: none (authoritative_empty) — …
ℹ pass 3
ℹ fail 1
```

NC-26 lets the doctor's jobs probe call a short jobs list readable:

```
✖ landing: /doctor ci.<project> reads workflows, then the newest run and its attempt jobs; a refused read is loud and gh output never echoes
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: [ 'ok', 'CI readable for o/short (2 workflow(s); latest run and its 1 job(s) read)' ]
ℹ pass 3
ℹ fail 1
```

NC-27 drops the attempt-2 guard, so a second infra failure is rerun again:

```
✖ landing: an infra-only CI failure is claimed, then rerun once per head; a test failure, a cancel, a second attempt, a drain or an unreadable claim or job list goes to the parent
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /run 41 is on attempt 2: a second failure is the parent's/
ℹ pass 3
ℹ fail 1
```

NC-28 lets an open PR past the state rule, as if gh's answer were enough:

```
✖ landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /reports .* as open, not MERGED — nothing is recorded/. Input:
  'Error: cp-v2fy: gh reports https://github.com/example/demo/pull/91 merged but names no merge commit — nothing is recorded. …'
ℹ pass 0
ℹ fail 1
```

NC-29 skips the fast-forward reachability question, so an MR head git cannot see on the target is recorded:

```
✖ landing: cp_merged reads a GitLab MR only from the project's own GitLab with its token; a squash, or a fast-forward git sees on the target, is recorded and anything else records nothing
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ pass 0
ℹ fail 1
```

NC-30 drops the literal pathspec magic, so a changed path that is a glob also compares other files:

```
✖ landing: cp_teardown passes a deleted branch as landed_by_git when origin's base holds its content (merge, squash, rebase, a later edit, literal odd paths) and keeps the lease when it does not
  AssertionError [ERR_ASSERTION]: {"code":"unpushed","message":"… branch cp-hcr6 is not on origin (origin/cp-hcr6 survives here only as a stale remote-tracking ref at 2916708594e5), and origin/main does not contain its content", …}
    actual: [ false, undefined, undefined ],
    expected: [ true, 'landed_by_git', 'path_tree' ],
ℹ pass 0
ℹ fail 1
```

NC-31 drops the opt-in date rule, so a merge from before `after_merge_deploy` was enabled still creates a deploy job:

```
✖ landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job
  AssertionError [ERR_ASSERTION]: before opt-in
ℹ pass 0
ℹ fail 1
```

## Incoming

Test files added after the baseline, with the PR that owns them.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/ci-evidence.test.ts` | P0 | behavior 01, scenarios 01-1 and 01-2 |
| `tests/e2e/authority.test.ts` | P2 | behavior 02, scenarios 02-1 to 02-4; P2b adds 02-5 and 02-6 |
| `tests/viewer-job-report.test.ts` | #380 | unit test landed on main after the baseline (viewer job report pages); recorded by P2 so the check stays at 0 findings, disposition left to its behavior's PR |
| `tests/e2e/retired-integration.test.ts` | #379 | existing-home compatibility after the tracker removal |
| `tests/test-migration-check.test.ts` | #379 | exception (verification integrity, like `tests/test-file-guard.test.ts`; operator ask-0088e0332d00 (Exceptions)): tests `scripts/test-migration-check.ts` itself, which no product entry point reaches, so it has no e2e consumer path; covers accept and reject paths of `deleted-with-feature` and `feature-removed` |
| `tests/retired-integration-guard.test.ts` | #392 | exception (verification integrity, like `tests/test-migration-check.test.ts`): tests `scripts/check-retired-integration.ts` itself, a CI guard no product entry point reaches, so it has no e2e consumer path; covers the clean tree and every rejection path |
| `tests/e2e/viewer-endpoints-speed.test.ts` | #395 | e2e landed on main after the baseline (viewer dashboard endpoint caching); recorded by P2e so the check stays at 0 findings, disposition left to its behavior's PR |
| `tests/e2e/landing.test.ts` | P3 | behavior 05, scenarios 05-1 to 05-4; P3b adds 05-5 to 05-7 |
| `tests/e2e/installer.test.ts` | #375 | installer sandbox: real bootstrap/cp-install/cp-daemon/doctor in Docker with the mock provider; opt-in `CP_INSTALL_E2E=1` (CI's install sandbox job) |
| `tests/entry-guard.test.ts` | main 5e8106b | unit landed upstream after the baseline; convert, owner P24 (entry-module/runtime compatibility), outside P3c; recorded when plain-merging main |
| `tests/awaiting-merge-tick-retained.test.ts` | P3c-rest | convert, owner P3c-rest; two declarations retained verbatim from tests/awaiting-merge-tick.test.ts; no public entry point transfers a running session's lock or observes dormant timers after shutdown |
| `tests/main-ci-retained.test.ts` | cp-e2e-slice-main-ci-41d3 (#416): 7 internal-only tests; mixed declarations retain only unreachable portions; concrete entry-point limits in docs/testing-migration-main-ci-declarations.md |
| `tests/diff-review-retained.test.ts` | retained, convert-owned P3c-rest: structural declaration 12, synthetic shutdown regression 25, unknown-job sub-probe 21; no deletion credit |
| `tests/timer-knobs.test.ts` | #439 | convert-owned #439; incoming timer/environment parser coverage introduced by merged #439, outside S19 conversion scope |
| `tests/bridge-reattach-knobs.test.ts` | #447 | incoming #447 default-knob regression moved verbatim from the retired original path; four older declarations retain their S19 mapped/retained dispositions |
| `tests/e2e/ci-watch-jobless.test.ts` | #443 | incoming #443-owned consumer coverage for job-less CI watch errors, outside S19 conversion scope |
| `tests/recovery-notice-bound.test.ts` | #442 | convert-owned #442; incoming recovery-notice bounds and rejected-write coverage, outside S19 conversion scope |
| `tests/held-continuation-fleet-read.test.ts` | #433 (ac50447082b15959140ec40b04080102eadbaf87) | incoming known-regression coverage for unreadable fleet during continuation failure notice; unit landed upstream after the baseline and is preserved unchanged; convert, owner P3c-rest (held continuation), pending the separately parked declaration-71 e2e conversion. Recorded when plain-merging main; no exception or deletion is claimed. |
| `tests/ci-watch-retained.test.ts` | S03b review 1 | Four verbatim retained declarations (S02 6/8/32/33); convert, owner P3c-rest. Originals remain whole by operator ruling until the declaration-71 retirement follow-up. |
| `tests/e2e/wake-delivery.test.ts` | S19 / S20 / S21 | S19 escalation reconnect and send-first consumer cases; S20 shipped memory, stale context and busy/answered/tool/abort/error delivery; three S21 restart/death/failure/reconciliation RPC scenarios, including forty-candidate reconciliation and bounded distinct recovery IDs; declaration maps testing-migration-s19.md, testing-migration-s20.md and testing-migration-s21.md |
| `tests/shipped-seen-retained.test.ts` | S20 | retained structural atomic-write assertion; cp_status_block cannot expose import tokens or syscall ordering |
| `tests/wakeup-head-sources-retained.test.ts` | S20 | retained 3 declarations: accessor call contract and throwing-source degradation/journal paths; RPC has no throwing HeadSourcePost port |
| `tests/e2e/wake-rules.test.ts` | S20 (cp-e2e-slice-s20-8nn3) | real bridge, resolve-cache and CI-rule consumer coverage; original wake-rules path retired after complete 17-declaration accounting |
| `tests/wake-rules-retained.test.ts` | S20 | 9 original declarations retained verbatim for injected-input, direct-cache/clock, unsafe-journal and disabled-composition contracts; no deletion credit; testing-migration-s20.md |
| `tests/wakeup-journal-retained.test.ts` | S21 | seven verbatim structural/documentation declarations, convert-owned P4; original declarations 1–3, 6–8, 16 |
| `tests/e2e/operator-context.test.ts` | S24 | real bridge context startup and resume; 2 scenarios |
| `tests/operator-context-retained.test.ts` | S24 | 1 retained verbatim declaration: no public entry calls only the context builder without first creating control state |
| `tests/operator-compact-retained.test.ts` | S24 | Two verbatim declarations: synchronous compact skip callback and malformed classifier inputs unavailable through public SDK events. |
| `tests/e2e/operator-compact.test.ts` | S24 | Fourteen real bridge scenarios, 20 original declarations mapped; canonical controls and declaration accounting above. |
| `tests/e2e/parent-compaction.test.ts` | S24 | Four parent CLI scenarios plus CI fleet coverage in headless-lifecycle; 4 original declarations plus incoming #447 mapped with controls; 3 original declarations moved verbatim to tests/parent-compact-hold-retained.test.ts. |
| `tests/e2e/reviewer-model.test.ts` | S16 | behavior 05, public gate reviewer selection and persisted schedule scope; scenario S16-model |
| `tests/e2e/ci-watch-jobless.test.ts` | #443 | incoming public RPC regression: distinct job-less CI watch errors retain distinct durable notice causes; preserved unchanged when merging main; behavior 06. S10b owns declaration-71 mapping and original-file retirement under the main-session decision. |
| `tests/recovery-notice-bound.test.ts` | #442 | incoming UTF-8 bound and hostile-control-byte regression: forty failed recovery candidates journal exactly one bounded notice; preserved unchanged; convert owner P4, behavior 06. No exception or deletion credit claimed. |
| `tests/timer-knobs.test.ts` | #439 | incoming timer configuration contract: defaults, positive overrides and invalid-input fallback; landed with the public knobs consumed by S15 Addendum 2; registered by S20 after plain-merging 695a8528, with no S20 conversion credit; preserved unchanged; convert owner P16, outside S03b. No exception or deletion credit claimed. |
| `tests/parent-compact-hold-retained.test.ts` | S24 | Three declarations moved verbatim: T3(b), T3(f), T3(g)/(h); retained under the round-2 decision, with missing public entry points named in the assertion map; no deletion credit. |
| `tests/e2e-hermetic-gh.test.ts` | PR #454 (hermetic e2e gh) | retained, no conversion |
| `tests/split-migration-ledger.test.ts` | cp-ledger-split-gewy | incoming regression for the ledger split script (a `$&` in a kept row); no conversion owner, no exception or deletion credit claimed |
<!-- /manifest:incoming -->

## Feature-removed

Declarations a kept baseline file lost with a removed production feature (see Method). One row per lost title.

<!-- manifest:feature-removed -->
| Unit file | Declaration | Removed by | Note |
|---|---|---|---|
| `tests/jobs-tool.test.ts` | parseJobsArgs: ready by default, list flags, show needs an id, import-beads | #379 | importer subcommand removed; the rest is kept under a new title |
| `tests/jobs-tool.test.ts` | cp_job create auto-links a job whose br ref names a bead on the active connection, and says why otherwise (laf) | #379 | tracker auto-link removed |
| `tests/trackers-ledger.test.ts` | createTracked mints exactly one job per (connection_id, item_id), even under concurrency | #384 | `Ledger.createTracked` removed with tracker import |
| `tests/trackers-ledger.test.ts` | closed and dropped linked jobs still dedupe; equal titles on different keys are distinct jobs | #384 | `Ledger.createTracked` removed with tracker import |
| `tests/trackers-ledger.test.ts` | an open unlinked job with the same ref is refused, never linked automatically | #384 | `Ledger.createTracked` removed with tracker import |
| `tests/worker-beads.test.ts` | a worker's BEADS_DIR comes only from dispatch, never the home's .beads or the parent environment | #384 | dispatch database injection removed; the parent-env strip is kept under a new title |
| `tests/task-references.test.ts` | resolves own-prefix beads and pinned external refs once, preserving text | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | missing beads and unavailable br are explicit nonfatal material | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | unavailable br names a custom-prefix bead even without another reference | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | br down never turns read-only or follow-up prose into references | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | reads real br show JSON using the configured prefix | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | bead responses accept legacy objects and diagnose malformed output | #384 | worker bead snapshots removed |
| `tests/task-references.test.ts` | bare references use only the resolved project database, never the home's | #384 | worker bead snapshots and database injection removed |
| `tests/dispatch.test.ts` | dispatch snapshots referenced beads for the worker and reviewers, including missing refs | #384 | worker bead snapshots and database injection removed |
| `tests/projects.test.ts` | cp_project add readiness: delivery:local wording, a connected tracker, and a throwing probe never fails add | #384 | tracker readiness line removed; the rest is kept under a new title |
| `tests/jobs-tool.test.ts` | create verifies the selected project's pinned database before recording array beads | #384 | command-ref verification removed |
| `tests/jobs-tool.test.ts` | a bare ref is not pinned to or verified against the home database, while explicit pins win | #384 | command-ref pinning removed |
| `tests/jobs-tool.test.ts` | cp_job create: a br show ref with status closed refuses | #384 | command-ref verification removed |
| `tests/jobs-tool.test.ts` | picp-t4n: an answered legacy override admits only its deferred bead and records the es | #384 | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: aggregated overrides bind exact pinned deferred refs, never another bead, DB, project or mismatch | #384 | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: a capped question cannot authorize an undisclosed deferred ref | #384 | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: only an answered override on this admission escalation counts | #384 | deferred-bead admission override removed |
| `tests/verify-external-ref.test.ts` | br show ref: closed status is a mismatch; open is not | #384 | command-ref verification removed |
| `tests/verify-external-ref.test.ts` | br --db pinned ref: the db path is unquoted and passed through as one arg | #384 | command-ref verification removed |
| `tests/verify-external-ref.test.ts` | br arrays preserve open and closed states; malformed responses stay diagnostic | #384 | command-ref verification removed |
| `tests/doctor.test.ts` | ledger.beads_archive: a leftover .beads/ beside a populated document is a warning that says it is safe to delete | #384 | import and live-connection advice removed; kept under a new title, which #388 replaced with the `storage.retired_integration` case |
| `tests/doctor.test.ts` | ledger.beads_archive: a .beads/ that an active tracker connection uses is ok and never advised for deletion | #384 | tracker connections removed |
| `tests/ledger.test.ts` | normalizeExternalRef pins a bare `br show <id> --json`, shell-quoted; every other shape passes through unchanged | #384 | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | create pins a bare br show ref to the project's beads DB when the caller wires one | #384 | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | an older job stored with a bare br show ref reads pinned through every query path, with no write and no updated_at bump | #384 | read-time ref projection removed |
| `tests/ledger.test.ts` | a closed job with a bare br show ref is projected pinned through history() and blocked() | #384 | read-time ref projection removed |
| `tests/ledger.test.ts` | the pinned form runs from a fresh leased worktree with no .beads/; the bare form does not (root cause, not just the string) | #384 | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | the stored ref is one valid shell word even when the project's checkout path has a space in it | #384 | command-ref pinning removed; refs are opaque |
| `tests/guards.test.ts` | the ledger has no bash surface any more: br-shaped commands are neither blocked nor special | #388 | product-named commands replaced by generic ones; kept under a new title |
| `tests/guards.test.ts` | only the home's own .beads/ is never-commit; a project worktree tracks its .beads/ | #388 | home directory never-commit exception removed (`src/guards.ts`, `src/contracts/layout.ts`); the any-cwd runtime-root case moved into the staging test |
| `tests/doctor.test.ts` | the one runtime root plus .beads covers runtime state | #388 | never-commit exception removed; kept under a new title |
| `tests/contracts.test.ts` | layoutFor(multi) keeps one root; neverCommitFor(multi) lists .beads | #388 | never-commit exception removed; kept under a new title |
| `tests/storage.test.ts` | a home with only .pi-command-post/, .beads/ and .gitignore is one ok storage finding | #388 | known-directory allowance removed (`src/storage.ts`); kept under a new title |
| `tests/service-install.test.ts` | install: the br prompt defaults to no, to yes with a beads tracker; --with-br / --no-br answer it | #388 | optional CLI prompt, probe and flags removed (`src/service/install.ts`, `src/tool-manifest.ts`) |
| `tests/service-install.test.ts` | install: tmux and br missing, gh logged out and no provider login are reported, never fatal | #388 | optional CLI step removed; kept under a new title |
<!-- /manifest:feature-removed -->

## Baseline

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/actions-ci-policy.test.ts` | exception | P1 | contract: disallowed forge read surface; operator ask-0088e0332d00 (Exceptions) |
| `tests/actions-ci.test.ts` | deleted | P3 | 16 declarations: 05-1/05-4 and 05-main-deadlines; only path-builder unit remains in tests/main-ci-retained.test.ts; normalization/deadline units mapped by #416 revision; NC-24 |
| `tests/after-merge.test.ts` | deleted | P3b | 5 declarations: 05-5 and S06-2; ledger-refusal regression now public-entry coverage; NC-31 and S06-deploy |
| `tests/answer-card.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/answer-delivery.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/answered-restart.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/answered.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/artifacts.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/ask-guard.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/ask.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/awaiting-merge-lifecycle.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/awaiting-merge-park.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/awaiting-merge-resume.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs); also listed under 23, owned here only |
| `tests/awaiting-merge-tick.test.ts` | deleted | P3c-rest | RENAME ONLY, not retired coverage: tests/awaiting-merge-tick-retained.test.ts keeps both declarations (convert, owner P3c-rest). The checker requires `deleted` for an absent baseline path; it rejects `retained` unless that original path exists. Both assertion dispositions remain retained, with zero removed-declaration or deleted-file credit. |
| `tests/awaiting-merge-viewer.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/awaiting-merge-watch.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/awaiting-merge.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/awaiting-obsolete.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/awaiting-one-decision.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/awaiting-rows.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/awaiting-ui.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/awaiting.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/bounds.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/budgets.test.ts` | deleted | P2 | 6 assertions mapped to 02-4; negative control NC-04 |
| `tests/capacity.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-14 or redundant-unreachable (Assertion map); negative control NC-19 |
| `tests/checkpoint-root.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/ci-access.test.ts` | deleted | P3 | 5 declarations: scenarios 05-1 and 05-3 (Assertion map); two units now retained in `tests/main-ci-retained.test.ts`; NC-26 |
| `tests/ci-configured.test.ts` | deleted | P3 | 5 declarations: scenario 05-2 (Assertion map); one unit retained in `tests/merge-ask.test.ts`; NC-25 |
| `tests/ci-evidence.test.ts` | deleted | P3c | all five declarations mapped to real tool and viewer consumers in 05-9; NC-33 and NC-43–NC-48 record failing assertions; no units moved or retained |
| `tests/ci-host-tools.test.ts` | exception | P1 | guard: CI never silently skips treehouse acceptance; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-infra-rerun.test.ts` | deleted | P3 | 4 declarations: scenario 05-4 (Assertion map); one unit now retained in `tests/main-ci-retained.test.ts`, classifier declaration mapped by main-CI follow-on; NC-27 |
| `tests/ci-run-ref.test.ts` | deleted | P0 | 10 assertions mapped, 4 redundant-unreachable; negative controls NC-01..NC-03 |
| `tests/ci-wait.test.ts` | exception | P1 | contract: worker report-and-stop policy and guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-watch.test.ts` | convert | P3c-rest | behavior 05 follow-on; 80 declarations: 75 mapped, 4 retained in tests/ci-watch-retained.test.ts, 1 pending-fix (71) parked by frozen Addendum 1. #443 is already on main and the blocker is gone; S10b owns mapping 71 and whole-file retirement by sequencing decision. |
| `tests/contract-injection.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contract.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts-anchors.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts-exports.test.ts` | exception | P1 | golden: export compatibility; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/control-pending.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/cp-bridge-restart.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/cp-bridge.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/curation.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/daemon-backend.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/daemon-cli.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/daemon-files.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/daemon-outer.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/daemon-runtime.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/daemon-tunnel-files.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/daemon-tunnel.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/dashboard-compaction.test.ts` | deleted | S24 | 3 mapped, 0 retained; S24-dashboard-hold/rehand/terminal; executed controls S24-hold/rehand/third; real pi input loss and compaction lifecycle |
| `tests/dashboard-control-images.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-control-remote.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-control.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-restart.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/decide-listing.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/decide.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/decision-context.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/dependency-dispatch.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/device-notifications.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/device-notify.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/diff-review.test.ts` | deleted | P3 | S04 + S05: all 55 declarations accounted in DR-01–DR-20; 53 mapped, 2 retained plus split guard in tests/diff-review-retained.test.ts; retained replacement has no deletion credit |
| `tests/dispatch-preview-tool.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/dispatch-queue-tool.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/dispatch-queue-wiring.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/dispatch-queue.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/dispatch.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/doctor.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/drain-stale-gate.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/drain.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/e2e/awaiting-count.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/awaiting.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/bounds.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/decide.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/headless-lifecycle.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/live-smoke.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/live.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/mission.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/operator-note.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/packaging.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/phase1.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/phase2.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/phase3.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/plan-view.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/planner-blocked.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/questions.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/silent-stops.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/single-mode-refused.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/e2e/worker-mcp.test.ts` | e2e | P1 | existing e2e acceptance file |
| `tests/envelope-correction.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/escalation-backstop.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/escalation.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/evals.test.ts` | exception | P1 | contract: offline assembled prompt corpus; operator ask-0088e0332d00 (Exceptions) |
| `tests/extension-deps.test.ts` | exception | P1 | contract: package boundary constraints; operator ask-0088e0332d00 (Exceptions) |
| `tests/extension-load.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/failure-announcer.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/failures.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/fake-parent-tracker.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/fleet.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/forge-url.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/gate-replacement.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gate.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gateway-key.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/guards.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/home-checkout.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/human-handoff.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/install-nudge.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/install-tools.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/intake-settle-atomicity.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/intake.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/integrate-held-ci.test.ts` | deleted | P3c-rest | S07: three declarations mapped to 05-13 and 05-S07; NC-37 and S07-NC-1..3; S03 strengthens startup recomputation, actual worker death and queued integrate assertions; original blob 367d199760c7c5927e5cc1fe268aa97d862bc4e5 |
| `tests/integrate.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/job-skills.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/jobs-tool.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/json-store.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/landing-proof.test.ts` | deleted | P3b | 7 declarations: scenario 05-7 (Assertion map); three units retained in `tests/forge-runtime-retained.test.ts` (relocated S06); NC-30 |
| `tests/layout-capture.test.ts` | exception | P1 | contract: assembled layout; operator ask-0088e0332d00 (Exceptions) |
| `tests/layout-flat.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/leases.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/ledger-import.test.ts` | deleted-with-feature | #379 | tested `src/ledger-import.ts` |
| `tests/ledger.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/live-harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/main-ci.test.ts` | deleted | cp-e2e-slice-main-ci-41d3 (#416) | 39 declarations: 32 mapped, 7 retained (mixed tests narrowed) in tests/main-ci-retained.test.ts, 0 pending; per-declaration controls in docs/testing-migration-main-ci-declarations.md; NC-35 and NC-main-corrupt |
| `tests/mandate-defaults.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-8 or redundant-unreachable (Assertion map); negative control NC-12 |
| `tests/mandate-selection.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-16 |
| `tests/mandate-supplement.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-17 |
| `tests/mandate-usage.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-13 or redundant-unreachable (Assertion map); one source scan kept in `tests/structure.test.ts`; negative control NC-18 |
| `tests/mandate.test.ts` | deleted | P2e | 61 declarations: scenarios 02-1 to 02-17 (Assertion map); eight units retained in `tests/decide.test.ts` (P10); NC-05, NC-06, NC-11, NC-21 to NC-23 |
| `tests/mcp-access.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/memory.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/merge-ask.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merges.test.ts` | deleted | P3b | 12 declarations: 05-5, 05-6 and S06-2; one receipt guard retained in tests/forge-observers-retained.test.ts; NC-28, NC-29, S06-deploy |
| `tests/mode.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/model-call-failure-recovery.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery); also listed under 14, owned here only |
| `tests/next.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/operator-answers.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/operator-asks.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/operator-cache-warming.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-compact.test.ts` | deleted | S24 | Original path removed; 20 mapped, 2 declarations moved verbatim to tests/operator-compact-retained.test.ts; no deletion credit for retained/moved declarations; 14 real bridge scenarios and executed S24-compact-* controls |
| `tests/operator-context.test.ts` | deleted | S24 | Original path removed; 2 mapped, 1 declaration moved verbatim to tests/operator-context-retained.test.ts; no deletion credit for retained/moved declarations; S24-context, S24-empty and executed S24-oldest/S24-empty/S24-resume controls |
| `tests/operator-decide-vs-ask-evals.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/operator-delivery.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-note.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-outbox-host.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-outbox.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-relaunch.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/operator-session-log.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-target-real-home.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-threads-bridge.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-threads-journal.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-tool-guard.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/ops-jobs.test.ts` | deleted | P2b | behavior 02: every assertion mapped to 02-6 or redundant-unreachable (Assertion map); negative controls NC-07 to NC-09 |
| `tests/output.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-compact-hold.test.ts` | deleted | S24 | Original path removed; 4 original plus incoming #447 declaration mapped, 3 declarations moved verbatim to tests/parent-compact-hold-retained.test.ts; no deletion credit for retained/moved declarations; executed S24-parent-* controls cover mapped declarations |
| `tests/parent-context.test.ts` | convert | P5 | behavior 07 (Compaction) |
| `tests/parent-control.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-delivery.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-hosts-harness.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-lock.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/parent-outbox.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-routing-evals.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/parent-session.test.ts` | exception | P1 | contract: assembled parent session; operator ask-0088e0332d00 (Exceptions) |
| `tests/parked-ci.test.ts` | deleted | P3c | behavior 05; all three declarations mapped to 05-12, NC-36 and NC-49–NC-55; no moved or retained units |
| `tests/pi-hashline-compaction.test.ts` | convert | P5 | behavior 07 (Compaction) |
| `tests/pi-lens-headless.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/pi-server-dependency.test.ts` | exception | P1 | contract: package boundary constraints; operator ask-0088e0332d00 (Exceptions) |
| `tests/pi-version-nudge.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/pipeline-classify-tool.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/pipeline.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/plan-followup.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/plan-view.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/plan-viewer.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/planner-artifact.test.ts` | exception | P1 | contract: planner artifact; operator ask-0088e0332d00 (Exceptions) |
| `tests/preflight.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/profiles.test.ts` | exception | P1 | contract: role profiles and briefs; operator ask-0088e0332d00 (Exceptions) |
| `tests/project-report.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/projects.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/provider-retry.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/push-keys.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/push-status.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/push-sweep.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/push-tick.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/push-webpush.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/quality.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/questions.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/quota.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-14 (Assertion map); negative control NC-20 |
| `tests/ready-beads.test.ts` | deleted-with-feature | #384 | tested `src/ready-beads.ts`, `src/trackers/config.ts` |
| `tests/recovery.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/relay-preflight.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/relay-scope.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/repo-map.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/restart-intake.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/review-context.test.ts` | deleted | P3 | S15: all ten declarations mapped to 05-S15-C/F; ten executed controls with patches/hashes in testing-migration-s15.md; known cp-c1ur N11 regression pinned by S15-C10 |
| `tests/review-merge-window.test.ts` | deleted | P3 | S15: both declarations mapped to 05-S15-W through cp_integrate and a fresh parent; executed W01/W02 patches and hashes in testing-migration-s15.md |
| `tests/review-runs.test.ts` | deleted | P3 | S15: source path replaced by tests/review-runs-retained.test.ts; 16 mapped declarations in 05-S15-A/X/Q/S/B/O/D/L, 3 retained verbatim plus incoming #447 contract; 60-second handback, configured 1-second retry/32-second suppression/5-second merge window; final restored retry 68,067 ms and order 16,867 ms, matrix 90,653 ms at 3 seconds; final timeouts 100/119 seconds; R01–R11/R15–R17/Q01/B01/W01 controls; assertion dispositions remain mapped/retained |
| `tests/review-tool.test.ts` | deleted | P3 | S15: four mapped declarations in 05-S15-T/P; three declarations ledgered retained and moved verbatim to tests/review-tool-retained.test.ts; typed-helper/schema entry-point traces and T00–T05 controls in testing-migration-s15.md |
| `tests/reviewer-model.test.ts` | deleted | S16 | 3 mapped, 0 retained; scenarios S16-model and S16-auto; controls S16-NC1–3; [accounting](testing-migration-s16.md) |
| `tests/revive.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/risk-batch.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-11 or redundant-unreachable (Assertion map); negative control NC-15 |
| `tests/risk-negation.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-7 (Assertion map); negative control NC-10 |
| `tests/risk-preapproval.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-10 or redundant-unreachable (Assertion map); negative control NC-14 |
| `tests/risk-warning.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-9 (Assertion map); negative control NC-13 |
| `tests/routing-integration.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/routing.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/run-artifacts.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/scaffold.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/schedule-activation.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-authority.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-control.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-cutover.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-expand.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-grant.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-migrations.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-native-migration.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-native-tool.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-native.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-org-review.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-policy.test.ts` | exception | P1 | contract: static schedule authority policy; operator ask-0088e0332d00 (Exceptions) |
| `tests/schedule-results.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-run-now.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-runner.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-runs.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-self-review.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/schedule-wake.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/scheduler.test.ts` | convert | P13 | behavior 12 (Schedules) |
| `tests/script-jobs.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery); P1 amendment, in no plan row |
| `tests/send.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/service-alerts.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-health.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-install.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-models.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-supervise.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-units.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/service-update.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/session-tools.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/settings-control.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/settings-lock.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/settings-policy.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/settings-write.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/settings.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/settle-recovery.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/settle.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/shipped-seen.test.ts` | deleted | S20 | 10 mapped to 06-S20-shipped with eight executed controls; 1 structural declaration retained in tests/shipped-seen-retained.test.ts; original path retired, retained declaration is not deletion credit |
| `tests/skill-catalog.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/stale-notice-context.test.ts` | deleted | S20 | all 5 declarations mapped to real RPC wake-delivery scenarios with 14 executed production controls |
| `tests/state-migrations.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/stats-view.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/stats-wakeup-drift.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/status-block.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/status-wait-reasons.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/status.test.ts` | exception | P1 | golden: status TUI; operator ask-0088e0332d00 (Exceptions) |
| `tests/storage.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/structure.test.ts` | exception | P1 | guard: module size and repository structure; operator ask-0088e0332d00 (Exceptions) |
| `tests/suggest.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/supersede.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/sync-lossless.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/task-addenda.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/task-references.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/teardown.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/test-concurrency-bound.test.ts` | exception | P1 | guard: executable verification integrity; operator ask-0088e0332d00 (Exceptions) |
| `tests/test-file-guard.test.ts` | exception | P1 | guard: executable verification integrity; operator ask-0088e0332d00 (Exceptions) |
| `tests/test-runner-bounds.test.ts` | exception | P1 | guard: executable verification integrity; operator ask-0088e0332d00 (Exceptions) |
| `tests/timeout-floor.test.ts` | exception | P1 | guard: executable verification integrity; operator ask-0088e0332d00 (Exceptions) |
| `tests/tool-manifest.test.ts` | exception | P1 | contract: installed tool surface; operator ask-0088e0332d00 (Exceptions) |
| `tests/trackers-beads.test.ts` | deleted-with-feature | #384 | tested `src/trackers/beads.ts`, `src/trackers/adapter.ts` |
| `tests/trackers-config.test.ts` | deleted-with-feature | #384 | tested `src/trackers/config.ts`, `src/contracts/trackers.ts` |
| `tests/trackers-import.test.ts` | deleted-with-feature | #379 | tested `src/trackers/import.ts` |
| `tests/trackers-ledger.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/trackers-link.test.ts` | deleted-with-feature | #379 | tested `src/trackers/link.ts`, `src/trackers/sync.ts` |
| `tests/trackers-sync.test.ts` | deleted-with-feature | #379 | tested `src/trackers/sync.ts`, `src/trackers/sync-store.ts` |
| `tests/trackers-tool.test.ts` | deleted-with-feature | #379 | tested `extensions/command-post/tools-tracker.ts`, `src/trackers/sync-store.ts` |
| `tests/tunnel-cli.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/tunnel-cloudflared.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/tunnel-qr.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/user-context.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/verify-external-ref.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/version-records.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/version-view.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/viewer-answers-http.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-answers-ui.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-app-build.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-app-http.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-app-live.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-app-navigation.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-app-render.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-bind-host.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-boards.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/viewer-compression-http.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-context-usage.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-control-http.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-control-ui.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-copy-reply.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-decision-card.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-decision-render.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-decisions.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-delta-http.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-deploy.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-device-control.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-device-notices-ui.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-device-notices.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-device-store.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-devices-ui.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-explorer.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-job-detail-render.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-job-transcript-render.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-jobs-qa.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-jobs-render.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-jobs.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-json-delta.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-linkify.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-mandates-map-render.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-mandates-map.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-map-edges.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-mobile-keyboard.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-model-list.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-more-menu.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-not-found.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-operator-composer-images.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-operator-composer.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-operator-relaunch.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/viewer-operator-restart.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/viewer-operator.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-overview.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-pairing.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-palette.test.ts` | exception | P1 | golden: viewer design palette; operator ask-0088e0332d00 (Exceptions) |
| `tests/viewer-performance.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-pr-chips.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/viewer-push-http.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/viewer-push-ui.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/viewer-queued-bubbles.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-remote-control.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-remote-http.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-remote-runtime.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/viewer-reports.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/viewer-restart-ui.test.ts` | convert | P17 | behavior 17 (Dashboard decisions/control) |
| `tests/viewer-schedule-control-http.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-schedule-control-ui.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-schedule-editor.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-schedule-run-groups.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-schedules.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-search.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-service-worker.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/viewer-sessions-chat-v2.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-sessions-files-render.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-sessions-files.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-sessions-qa.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-sessions-rollup.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-sessions-skills.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-settings-http.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-settings-ui.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-stats-render.test.ts` | convert | P22 | behavior 22 (Notifications and reports) |
| `tests/viewer-thread-turns.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-threads-http.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-threads-ui.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-transcript-chat.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-transcript-tools.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-upload-http.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-upload-metadata.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-uploads.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer-version-badge.test.ts` | convert | P20 | behavior 20 (Dashboard schedules/settings) |
| `tests/viewer-workbench.test.ts` | convert | P19 | behavior 19 (Dashboard conversations/files) |
| `tests/viewer.test.ts` | convert | P21 | behavior 21 (Dashboard serving/live refresh) |
| `tests/wake-rules.test.ts` | deleted | S20 | 8 mapped with real-parent coverage and executed controls; 9 original declarations retained verbatim in tests/wake-rules-retained.test.ts, without deletion credit; all 17 accounted for in testing-migration-s20.md |
| `tests/wakeup-head-sources.test.ts` | deleted | S20 | 2 mapped to 06-S20-head with four executed production controls; 3 declarations moved to tests/wakeup-head-sources-retained.test.ts without deletion credit |
| `tests/wakeup-journal.test.ts` | deleted | S21 | cp-e2e-slice-s21-5gtl: 15 mapped and 7 moved verbatim to tests/wakeup-journal-retained.test.ts; declaration map testing-migration-s21.md; fifteen replayed controls |
| `tests/wakeups.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/watch.test.ts` | exception | P1 | golden: watch TUI; operator ask-0088e0332d00 (Exceptions) |
| `tests/web-access.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/web-egress.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/wedged.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/widget.test.ts` | exception | P1 | golden: widget TUI; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-beads.test.ts` | deleted-with-feature | #392 | tested the retired database variables in a worker's environment; their source `src/trackers/beads.ts` went with #384 and the environment strip went with #392 |
| `tests/worker-compaction.test.ts` | convert | P5 | behavior 07 (Compaction) |
| `tests/worker-credential-guard.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-history-guard.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-host-guard.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-manager.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worker-mcp.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worker-merge-guard.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-packages.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worker-process.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worker-reporter.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worker-role-tools.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-session-policy.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/worker-spawn-reserve.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/worktree-deps.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
<!-- /manifest:baseline -->
