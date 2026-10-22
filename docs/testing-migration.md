# Unit → e2e test migration manifest

The auditable record of the unit-to-e2e programme: every test file in the pinned baseline gets exactly one
disposition, every deleted unit assertion maps to an e2e scenario, and every deleted regression test carries a
negative control (the old defect patched back fails the e2e, the fix passes it). `scripts/test-migration-check.ts`
validates this file and the per-slice ledger against git; it imports no production code.

The ledger rows live one file per slice in `docs/testing-migration/<slice>.md` (`s19.md`, `p3c.md`, `b05.md` for
pre-slice scenarios by behavior, `unowned.md`), each holding that slice's rows of the seven `manifest:*` tables and the
patch blocks of its regression rows. A new slice adds its own file and edits no shared table. The checker merges every
file in memory, so duplicate ids and the baseline counts are checked over the union; its census is printed, not committed.

```
node scripts/test-migration-check.ts --base 0a4a8944dd7292e458dbd2ec4afbf6d2b89d197e --manifest docs/testing-migration.md
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --verify-regressions
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --runner-log <saved test:one output>
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --preserved-from <ref of the old single file>
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

The `prs` table rows live in `docs/testing-migration/*.md`, one file per slice.

The plan proposed 6 cases for all of behavior 05. P3 is a first slice of 4 cases over 4 files. P3b
(cp-e2e-migration-p3b-stth) is the second, 3 cases over 3 files (merge receipts and the landing proof). The other 23
behavior-05 files keep their `convert` rows (owner P3) for P3c, which the main session cuts.

The census (files and declarations per conversion PR) is computed by the checker and not committed.

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

The `scenarios` table rows live in `docs/testing-migration/*.md`, one file per slice.

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

The `assertions` table rows live in `docs/testing-migration/*.md`, one file per slice.

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

The `regressions` table rows live in `docs/testing-migration/*.md`, one file per slice.

S02 controls run with `npm run test:one -- --test-name-pattern='landing S02: <scenario prefix>' tests/e2e/landing.test.ts`.
Each patch below was applied alone and restored; each exited 1 on the observable assertion above.
The restored S02 scenarios pass. Existing NC-32 and NC-39–NC-42 continue to cover shared scenario 05-8.

Review-1 controls below were each applied alone to source revision b744b908413b97d7fb9a39ae6056179ec3f8ae07,
run with `node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='landing S02: watch delivery' tests/e2e/landing.test.ts`,
then restored. For aggregate/empty/red/closed/superseded use `landing S02: aggregate`; for key/history/prune use
`landing: CI watch persists`; for parked use `landing S02: only reported`. Each command exited 1 at the regression
assertion recorded above. The superseded case returns raw Actions rows so fake gh cannot filter away the stale input.
All sixteen logs and patches are also retained in the S02 worker artifact directory.

NC-01 brings back the pre-#131 rule, where any non-success conclusion was the failing run:

```
✖ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: [ 'ci_failed', 'f5058acb…', 2, 'https://github.com/example/demo/actions/runs/2' ],
    expected: [ 'ci_failed', 'f5058acb…', 6, 'https://github.com/example/demo/actions/runs/6' ],
ℹ pass 1
ℹ fail 1
```

NC-02 withholds the run reference from `cp_integrate`'s CI-failed fact:

```
✖ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on d6e051c (ci) — merging red is forbidden
✖ ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on 4b2857c (ci) — merging red is forbidden
ℹ pass 0
ℹ fail 2
```

NC-03 derives an Actions link for any host:

```
✔ ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone
✖ ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link
  AssertionError [ERR_ASSERTION]: ci: failed — CI failure on 582b570 (ci) — merging red is forbidden
    (run 16 https://ghe.example.com/example/demo/actions/runs/16)
ℹ pass 1
ℹ fail 1
```

NC-04 puts back the cp-sr5 defect `tests/budgets.test.ts` guarded: the manager's budget getter is a snapshot taken
when the CommandPost is built, so a `data/budgets.json` written later never reaches a dispatch. The file has no
separate fix commit in this repository's history; the bug commit column names the release that carries the getter.

```
✔ authority: a scoped mandate dispatches the job it names under its id; an unnamed job is not its to speak for
✔ authority: a paused or revoked mandate stops speaking; an expired or job-capped one refuses new paid work
✔ authority: a risk:high answer authorizes only the job it names; a replacing grant supersedes the open ask
✖ authority: token raises stay inside the ceiling, the USD cap never moves, and budgets.json is re-read live
  Error: spawn cap reached (10/10 workers): cp-0d02, cp-s0e0, cp-2jeu, cp-d91l, cp-i96u, cp-0otr, cp-bkjz, cp-t474, …
ℹ pass 3
ℹ fail 1
```

NC-05 to NC-09 were run the same way on `tests/e2e/authority.test.ts`: each patch applied to `src/`, the file run, the
patch reversed, and the file run again: 6 pass, 0 fail. NC-05 and NC-06 name the release that carries the held-job
rule, because it has no separate fix commit. NC-07 to NC-09 name #284, which added ops jobs.

NC-05 lets a held job hold a dispatch slot:

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  Error: cp-g1so: mandate md-68b4c8 dispatch-parallelism 1 is full
ℹ pass 5
ℹ fail 1
```

NC-06 stops counting a held job toward the grant's spend and job count:

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  Error: timed out after 60000ms waiting for held + second spend to reach the token cap; last = error: undefined
ℹ pass 5
ℹ fail 1
```

NC-07 lets a read-only ops profile exempt its job from the risk:high gate:

```
✖ authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: undefined,
    expected: 'would ask: risk:high',
ℹ pass 5
ℹ fail 1
```

NC-08 lets the caller's risk override a deploy's fixed high:

```
✖ authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource
  AssertionError [ERR_ASSERTION]: a deploy is high whatever the caller says
    actual: [ 'ops', 'low' ],
    expected: [ 'ops', 'high' ],
ℹ pass 5
ℹ fail 1
```

NC-09 leases a resource only to a reported (held) holder, not a working one:

```
✖ authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ pass 5
ℹ fail 1
```

NC-10 to NC-12 (P2c) were run the same way, with `--test-name-pattern` on the one scenario each patch breaks; the
clean run of the whole file afterwards gave 8 pass, 0 fail. NC-10 names `b63fe8457e76` (#66), the commit that put the
negation filter on the shared risk-match path. NC-11 is the P2b review's job-cap control: it drops a held job from the
grant's job count only, leaving its spend and slot rules alone, and names the release that carries the rule as NC-05 does.
NC-12 names that release too: the key-order fix (cur.2.6) has no separate commit.

NC-10 stops skipping negated risk words:

```
✖ authority: keyword risk inference skips negated, excluded and benign senses; the risk:high ask names every word it matched
  AssertionError [ERR_ASSERTION]: no migration
  + actual - expected
  + [
  +   'migration'
  + ]
  - []
ℹ pass 0
ℹ fail 1
```

NC-11 stops counting a held job toward the grant's job count, and nothing else:

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Error: cp-0e9m: mandate md-9fb896 dispatch-parallelism 1 is full
ℹ pass 0
ℹ fail 1
```

NC-12 brings back the key-order-sensitive override comparison (cur.2.6), so agreeing overrides fall through to home:

```
✖ authority: cp_mandate issue needs only projects and an objective; every other field resolves explicit > project > home and says which
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: [ { usd: 99, tokens: 10000000 }, 9, [ 'plan', 'implement', 'review', 'repair', 'merge' ] ],
    expected: [ { usd: 99, tokens: 10000000 }, 5, [ 'implement', 'review' ] ],
ℹ pass 0
ℹ fail 1
```

NC-13 to NC-20 (P2d) were run the same way, one per deleted file, with `--test-name-pattern` on the scenario each
patch breaks; each patch was reverted with `git checkout -- <file>` and the whole file then gave 14 pass, 0 fail.
Four bug commits are the initial release (`ea631794e9de`), which carries those rules with no separate commit.

NC-13 lets a recorded low stand down only a high that routing never recorded either, so every keyword-only high gates:

```
✖ authority: a recorded or declared low turns a keyword-only high into a warning; a recorded, supplied or planner high still gates
  AssertionError [ERR_ASSERTION]: Scope M each, risk low.
  + 'would ask: risk:high'
  - undefined
ℹ pass 0
ℹ fail 1
```

NC-14 lets a pre-approval cover a hard stop:

```
✖ authority: an operator-quoted risk:high pre-approval lets covered dispatches and promotions proceed with an audit row; anything else still asks
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ pass 0
ℹ fail 1
```

NC-15 refuses a duplicate only when two different ids repeat:

```
✖ authority: cp_escalate batch_risk_high files one approve/drop record for jobs one asking grant gates; every refusal writes nothing
  AssertionError [ERR_ASSERTION]: twice: {"content":[{"type":"text","text":"es-87f890 batch risk:high: 2 jobs (cp-utjq, cp-utjq); …
ℹ pass 0
ℹ fail 1
```

NC-16 prefers the latest-issued grant:

```
✖ authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement
  + 'md-000001'
  - 'md-a994c5'
ℹ pass 0
ℹ fail 1
```

NC-17 brings back the full named grant shadowing its eligible supplement (#184):

```
✖ authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement
  + 'md-older1'
  - 'md-supp01'
ℹ pass 0
ℹ fail 1
```

NC-18 counts cache reads toward the token cap:

```
✖ authority: live usage crosses each cap line once while the worker runs; cache reads and pre-grant usage never count; a USD cap or the ceiling is the operator's
  AssertionError [ERR_ASSERTION]: cache reads never count; 70% says nothing
  + [
  +   'token-cap'
  + ]
ℹ pass 0
ℹ fail 1
```

NC-19 stops naming a 401 as a rejected admin credential:

```
✖ authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key
  AssertionError [ERR_ASSERTION]: source=rubric model=other/b rule=implementer thinking=medium quota unavailable: auth rejected capacity=fleet:mock=-2,other=0
ℹ pass 0
ℹ fail 1
```

NC-20 drops the 5h threshold's own boundary:

```
✖ authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key
  AssertionError [ERR_ASSERTION]: 90/0
ℹ pass 0
ℹ fail 1
```

NC-21 drops the cp-7re9 deny_projects check from the mandate's auto-decision:

```
✖ authority: a pipeline's plan checkpoint is mandate-decided and journaled; task-text exclusions, gate flags, an unnamed high and a denied project leave it pending
  Error: preflight refused cp-s1yq: ... [fail] project_denied: settings: project demo is denied ...
ℹ pass 0
ℹ fail 1
```

NC-22 keeps only the last job created this turn when the sentinel expands:

```
✖ authority: cp_mandate through a real parent sets the reviewer model, names this turn's jobs, filters show, refuses every bad issue before writing, and a revoke or expiry closes its asks
  AssertionError [ERR_ASSERTION]: Expected values to be deeply equal: [ 'cp-ovpy' ] vs [ 'cp-ovpy', 'cp-vyp7' ]
ℹ pass 0
ℹ fail 1
```

NC-23 takes repair off an expired grant's in-flight continuations:

```
✖ authority: an expired, revoked, serial or job-capped grant stops fresh starts while its own in-flight workers keep promotion and repair
  Error: cp-5ldk: mandate md-8bab6a expired at ... — no first authorization under it; only a job already in flight under it continues. A new job needs a new grant (cp_mandate issue).
ℹ pass 0
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

The `incoming` table rows live in `docs/testing-migration/*.md`, one file per slice.

## Feature-removed

Declarations a kept baseline file lost with a removed production feature (see Method). One row per lost title.

The `feature-removed` table rows live in `docs/testing-migration/*.md`, one file per slice.

## Baseline

The `baseline` table rows live in `docs/testing-migration/*.md`, one file per slice.
