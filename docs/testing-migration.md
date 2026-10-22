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
| S24-context | `tests/e2e/operator-context.test.ts` | S24 context: fresh bridge loads orders, parsed learnings and newest handoff into the provider request |
| S24-empty | `tests/e2e/operator-context.test.ts` | S24 context: an empty home adds no operator context or preference files |
| S24-dashboard-hold | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge S24: a queued message survives compaction without a dropped handoff |
| S24-dashboard-rehand | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge: a message queued before a self-compaction is held through it and consumed once after one dropped handoff |
| S24-dashboard-terminal | `tests/e2e/headless-lifecycle.test.ts` | rpc bridge: a queued message whose handoff is dropped twice ends failed, never re-injected again |
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

## Incoming

Test files added after the baseline, with the PR that owns them.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/wake-delivery.test.ts` | S19 / S20 / S21 | S19 escalation reconnect and send-first consumer cases; S20 shipped memory, stale context and busy/answered/tool/abort/error delivery; three S21 restart/death/failure/reconciliation RPC scenarios, including forty-candidate reconciliation and bounded distinct recovery IDs; declaration maps testing-migration-s19.md, testing-migration-s20.md and testing-migration-s21.md |
| `tests/shipped-seen-retained.test.ts` | S20 | retained structural atomic-write assertion; cp_status_block cannot expose import tokens or syscall ordering |
| `tests/wakeup-head-sources-retained.test.ts` | S20 | retained 3 declarations: accessor call contract and throwing-source degradation/journal paths; RPC has no throwing HeadSourcePost port |
| `tests/e2e/wake-rules.test.ts` | S20 (cp-e2e-slice-s20-8nn3) | real bridge, resolve-cache and CI-rule consumer coverage; original wake-rules path retired after complete 17-declaration accounting |
| `tests/wake-rules-retained.test.ts` | S20 | 9 original declarations retained verbatim for injected-input, direct-cache/clock, unsafe-journal and disabled-composition contracts; no deletion credit; testing-migration-s20.md |
| `tests/e2e/operator-context.test.ts` | S24 | real bridge context startup and resume; 2 scenarios |
| `tests/operator-context-retained.test.ts` | S24 | 1 retained verbatim declaration: no public entry calls only the context builder without first creating control state |
| `tests/operator-compact-retained.test.ts` | S24 | Two verbatim declarations: synchronous compact skip callback and malformed classifier inputs unavailable through public SDK events. |
| `tests/e2e/operator-compact.test.ts` | S24 | Fourteen real bridge scenarios, 20 original declarations mapped; canonical controls and declaration accounting above. |
| `tests/e2e/parent-compaction.test.ts` | S24 | Four parent CLI scenarios plus CI fleet coverage in headless-lifecycle; 4 original declarations plus incoming #447 mapped with controls; 3 original declarations moved verbatim to tests/parent-compact-hold-retained.test.ts. |
| `tests/parent-compact-hold-retained.test.ts` | S24 | Three declarations moved verbatim: T3(b), T3(f), T3(g)/(h); retained under the round-2 decision, with missing public entry points named in the assertion map; no deletion credit. |
<!-- /manifest:incoming -->

## Feature-removed

Declarations a kept baseline file lost with a removed production feature (see Method). One row per lost title.

<!-- manifest:feature-removed -->
| Unit file | Declaration | Removed by | Note |
|---|---|---|---|
<!-- /manifest:feature-removed -->

## Baseline

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/dashboard-compaction.test.ts` | deleted | S24 | 3 mapped, 0 retained; S24-dashboard-hold/rehand/terminal; executed controls S24-hold/rehand/third; real pi input loss and compaction lifecycle |
| `tests/operator-compact.test.ts` | deleted | S24 | Original path removed; 20 mapped, 2 declarations moved verbatim to tests/operator-compact-retained.test.ts; no deletion credit for retained/moved declarations; 14 real bridge scenarios and executed S24-compact-* controls |
| `tests/operator-context.test.ts` | deleted | S24 | Original path removed; 2 mapped, 1 declaration moved verbatim to tests/operator-context-retained.test.ts; no deletion credit for retained/moved declarations; S24-context, S24-empty and executed S24-oldest/S24-empty/S24-resume controls |
| `tests/parent-compact-hold.test.ts` | deleted | S24 | Original path removed; 4 original plus incoming #447 declaration mapped, 3 declarations moved verbatim to tests/parent-compact-hold-retained.test.ts; no deletion credit for retained/moved declarations; executed S24-parent-* controls cover mapped declarations |
| `tests/shipped-seen.test.ts` | deleted | S20 | 10 mapped to 06-S20-shipped with eight executed controls; 1 structural declaration retained in tests/shipped-seen-retained.test.ts; original path retired, retained declaration is not deletion credit |
| `tests/stale-notice-context.test.ts` | deleted | S20 | all 5 declarations mapped to real RPC wake-delivery scenarios with 14 executed production controls |
| `tests/wake-rules.test.ts` | deleted | S20 | 8 mapped with real-parent coverage and executed controls; 9 original declarations retained verbatim in tests/wake-rules-retained.test.ts, without deletion credit; all 17 accounted for in testing-migration-s20.md |
| `tests/wakeup-head-sources.test.ts` | deleted | S20 | 2 mapped to 06-S20-head with four executed production controls; 3 declarations moved to tests/wakeup-head-sources-retained.test.ts without deletion credit |
<!-- /manifest:baseline -->
