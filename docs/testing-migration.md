# Unit → e2e test migration manifest

The auditable record of the unit-to-e2e programme: every test file in the pinned baseline gets exactly one
disposition, every deleted unit assertion maps to an e2e scenario, and every deleted regression test carries a
negative control (the old defect patched back fails the e2e, the fix passes it). `scripts/test-migration-check.ts`
validates this file against git; it imports no production code.

```
node scripts/test-migration-check.ts --base 0a4a8944dd7292e458dbd2ec4afbf6d2b89d197e --manifest docs/testing-migration.md
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --verify-regressions
node scripts/test-migration-check.ts --manifest docs/testing-migration.md --runner-log <saved test:one output>
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
| S02 (cp-e2e-slice-s02-l7ph) | behavior 05; `tests/ci-watch.test.ts` declarations 1–40: 36 mapped, 4 mixed/unreachable and kept in place; five added e2e declarations, 05-8 extended. S03 owns 41–80 and whole-file retirement. | 0 (split-file bookkeeping: all units stay) | 378 → 378 | 4,274 → 4,279 |
| S07 (cp-e2e-slice-s07-eaux) | P3c-rest behavior 05: only integrate-held-ci; 3 mapped, 0 retained, 1 deleted file; extends 05-13 and adds 05-S07; all other slices retain their ownership | 1 (`tests/integrate-held-ci.test.ts`) | 378 → 377 | 4,274 → 4,272 (3 removed, 1 added) |
| S04 (cp-e2e-slice-s04-vep1) | behavior 05; original `tests/diff-review.test.ts` declarations 1–40. [Declaration accounting](testing-migration-s04-declarations.md): 38 mapped, 2 retained, 0 pending in S04; S05 owns 41–55 and whole-file retirement. | 0; baseline intentionally kept whole | +1 incoming e2e file | 55 source declarations unchanged; +13 e2e scenarios |
| S06 (cp-e2e-slice-s06-15yh) | All four whole files accounted for: 40 declarations, 24 mapped and 16 retained; six new landing consumer cases. | 4 | unchanged (four source files replaced by four retained files) | 40 source declarations → 16 retained + 6 new e2e cases |
| S08 (cp-e2e-slice-s08-9p6d) | behavior 05; `tests/integrate.test.ts` static declarations 1–40: 38 mapped, 2 retained mixed declarations; [range accounting](testing-migration-s08.md); nine added landing declarations; later ranges keep their ownership | 0; the entire unit file stays unchanged | 378 → 378 | 4,290 → 4,299 (+9 e2e) |
| S15 (cp-e2e-slice-s15-764h) | behavior 05; whole-file review-context, review-merge-window, review-runs and review-tool; [declaration accounting](testing-migration-s15.md); 16 mapped, 3 retained; review-runs 19 pending | 3 | -2 test files | -16 source declarations; real reviewer and RPC cases added |

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
`/status` and `/doctor` are the consumers. Ten units are `retained`, moved verbatim: the Actions paths, normalisation,
budget and status runner plus `ciReadDenied` and the viewer label parity to `tests/actions-ci-policy.test.ts` (an
exception; P3b moved them on to `tests/main-ci.test.ts`), the infra classifier table and the guards no landing entry point reaches to `tests/main-ci.test.ts`, and
the throwing-runner `ghCiConfigured` to `tests/merge-ask.test.ts`. Plan and tree disagree once: the infra rerun's drain
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
to the convert-owned `tests/main-ci.test.ts`, and the two "run by hand" sub-asserts (the
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
| P3c-rest | 05 | `tests/e2e/landing.test.ts` | follow-on slices: 128 pending declarations and two retained timer cases across five unfinished files |
| S06 | 05 | `tests/e2e/landing.test.ts` | foreign CI, forge observers/runtime and held release; file-by-file conversion |
| S08 | 05 | `tests/e2e/landing.test.ts` | integrate declarations 1–40: 38 mapped, 2 retained (5%), 0 deleted files; nine scenarios added and 05-13 extended; [range ledger](testing-migration-s08.md); original unit file kept whole |
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
<!-- /manifest:prs -->

The plan proposed 6 cases for all of behavior 05. P3 is a first slice of 4 cases over 4 files. P3b
(cp-e2e-migration-p3b-stth) is the second, 3 cases over 3 files (merge receipts and the landing proof). The other 23
behavior-05 files keep their `convert` rows (owner P3) for P3c, which the main session cuts.

<!-- census -->
Census snapshot, printed by the checker on `03ed8749a76085c9938517b6f149bb49ebe7a8fd`; the checker's live output wins over this table.

| PR | Behavior | Files `F` | Declarations `D` at baseline | Declarations `D` at `03ed8749a760` |
|---|---|---|---|---|
| P2 | 02 | 14 | 151 | 151 |
| P3 | 05 | 30 | 603 | 603 |
| P4 | 06 | 10 | 164 | 164 |
| P5 | 07 | 7 | 55 | 55 |
| P6 | 08 | 9 | 74 | 74 |
| P7 | 03 | 11 | 128 | 128 |
| P8 | 04 | 20 | 310 | 310 |
| P9 | 11 | 28 | 350 | 350 |
| P10 | 09 | 18 | 267 | 267 |
| P11 | 10 | 16 | 255 | 255 |
| P12 | 16 | 14 | 104 | 104 |
| P13 | 12 | 18 | 141 | 141 |
| P14 | 15 | 19 | 337 | 337 |
| P15 | 13 | 13 | 160 | 160 |
| P16 | 14 | 17 | 181 | 181 |
| P17 | 17 | 11 | 71 | 71 |
| P18 | 18 | 22 | 194 | 194 |
| P19 | 19 | 24 | 165 | 166 |
| P20 | 20 | 9 | 64 | 64 |
| P21 | 21 | 12 | 55 | 55 |
| P22 | 22 | 13 | 91 | 91 |
| P23 | 23 | 5 | 121 | 121 |
| P24 | 24 | 4 | 38 | 38 |
| total | | 344 | 4079 | 4080 |
<!-- /census -->

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
| 02-1 | `tests/e2e/authority.test.ts` | authority: a scoped mandate dispatches the job it names under its id; an unnamed job is not its to speak for |
| 02-2 | `tests/e2e/authority.test.ts` | authority: a paused or revoked mandate stops speaking; an expired or job-capped one refuses new paid work |
| 02-3 | `tests/e2e/authority.test.ts` | authority: a risk:high answer authorizes only the job it names; a replacing grant supersedes the open ask |
| 02-4 | `tests/e2e/authority.test.ts` | authority: token raises stay inside the ceiling, the USD cap never moves, and budgets.json is re-read live |
| 02-5 | `tests/e2e/authority.test.ts` | authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot |
| 02-6 | `tests/e2e/authority.test.ts` | authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource |
| 02-7 | `tests/e2e/authority.test.ts` | authority: keyword risk inference skips negated, excluded and benign senses; the risk:high ask names every word it matched |
| 02-8 | `tests/e2e/authority.test.ts` | authority: cp_mandate issue needs only projects and an objective; every other field resolves explicit > project > home and says which |
| 02-9 | `tests/e2e/authority.test.ts` | authority: a recorded or declared low turns a keyword-only high into a warning; a recorded, supplied or planner high still gates |
| 02-10 | `tests/e2e/authority.test.ts` | authority: an operator-quoted risk:high pre-approval lets covered dispatches and promotions proceed with an audit row; anything else still asks |
| 02-11 | `tests/e2e/authority.test.ts` | authority: cp_escalate batch_risk_high files one approve/drop record for jobs one asking grant gates; every refusal writes nothing |
| 02-12 | `tests/e2e/authority.test.ts` | authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement |
| 02-13 | `tests/e2e/authority.test.ts` | authority: live usage crosses each cap line once while the worker runs; cache reads and pre-grant usage never count; a USD cap or the ceiling is the operator's |
| 02-14 | `tests/e2e/authority.test.ts` | authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key |
| 02-15 | `tests/e2e/authority.test.ts` | authority: a pipeline's plan checkpoint is mandate-decided and journaled; task-text exclusions, gate flags, an unnamed high and a denied project leave it pending |
| 02-16 | `tests/e2e/authority.test.ts` | authority: cp_mandate through a real parent sets the reviewer model, names this turn's jobs, filters show, refuses every bad issue before writing, and a revoke or expiry closes its asks |
| 02-17 | `tests/e2e/authority.test.ts` | authority: an expired, revoked, serial or job-capped grant stops fresh starts while its own in-flight workers keep promotion and repair |
| 05-1 | `tests/e2e/landing.test.ts` | landing: a denied, rate-limited, malformed, partial or capped Actions read never merges and names its cause; a full paged read finds page two's failure |
| 05-2 | `tests/e2e/landing.test.ts` | landing: only an authoritative empty workflow list is no CI; every unanswered workflows read keeps its own cause and never reads as none |
| 05-3 | `tests/e2e/landing.test.ts` | landing: /doctor ci.<project> reads workflows, then the newest run and its attempt jobs; a refused read is loud and gh output never echoes |
| 05-4 | `tests/e2e/landing.test.ts` | landing: an infra-only CI failure is claimed, then rerun once per head; a test failure, a cancel, a second attempt, a drain or an unreadable claim or job list goes to the parent |
| 05-5 | `tests/e2e/landing.test.ts` | landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job |
| 05-6 | `tests/e2e/landing.test.ts` | landing: cp_merged reads a GitLab MR only from the project's own GitLab with its token; a squash, or a fast-forward git sees on the target, is recorded and anything else records nothing |
| 05-7 | `tests/e2e/landing.test.ts` | landing: cp_teardown passes a deleted branch as landed_by_git when origin's base holds its content (merge, squash, rebase, a later edit, literal odd paths) and keeps the lease when it does not |
| 05-8 | `tests/e2e/landing.test.ts` | landing: CI watch persists arrival and attempt identity, follows pushed heads and prunes finished deliveries |
| 05-9 | `tests/e2e/landing.test.ts` | landing: operator-forwarded CI requires a quoted current head and never substitutes for native CI |
| 05-10 | `tests/e2e/landing.test.ts` | landing: foreign CI stays read-only, follows the base repo's current head and stops after merge |
| 05-11 | `tests/e2e/landing.test.ts` | landing: a real parent's timer latches only its mandated main runs and clears only current-tip green |
| 05-12 | `tests/e2e/landing.test.ts` | landing: parked PR timer stores native CI for each observed head without reviving its released worker |
| 05-13 | `tests/e2e/landing.test.ts` | landing: held CI repairs the same real worker once while preserving an integration hold |
| S06-1 | `tests/e2e/landing.test.ts` | landing: foreign CI selection, failed reads, corrupt memory and reviewer timeout remain visible at dispatch |
| S06-2 | `tests/e2e/landing.test.ts` | landing: a deploy ledger failure preserves the merge receipt and retries through cp_merged |
| S06-3 | `tests/e2e/landing.test.ts` | landing: legacy unregistered projects retain GitHub observation and refuse a GitLab reference |
| S06-4 | `tests/e2e/landing.test.ts` | landing: teardown proves landing on the project's configured trunk instead of main |
| 05-S08-1 | `tests/e2e/landing.test.ts` | landing: held repair rejects invalid PR identity, CI, holds, drains and worktree hazards |
| 05-S08-2 | `tests/e2e/landing.test.ts` | landing: held CI revalidates local state after each external read |
| 05-S08-3 | `tests/e2e/landing.test.ts` | landing: a reviewed green head merges once, records, tears down and closes from forge facts |
| 05-S08-4 | `tests/e2e/landing.test.ts` | landing: the review deadline resumes once and rechecks current gates |
| 05-S08-5 | `tests/e2e/landing.test.ts` | landing: main red gates only the mandated login and permits a green fix-forward |
| 05-S08-6 | `tests/e2e/landing.test.ts` | landing: repository and fallback merges bind the approved head at the forge |
| 05-S08-7 | `tests/e2e/landing.test.ts` | landing: stale bases update only for BEHIND or an authoritative strict rule |
| 05-S08-8 | `tests/e2e/landing.test.ts` | landing: the operator bridge persists a hold without a parent and a restarted parent reads and releases it |
| 05-S08-9 | `tests/e2e/landing.test.ts` | landing: a hold arriving during green CI stops both merge authority paths |
| 05-S02-1 | `tests/e2e/landing.test.ts` | landing S02: only reported held PR deliveries are queried |
| 05-S02-2 | `tests/e2e/landing.test.ts` | landing S02: aggregate CI and terminal PR facts preserve the current head |
| 05-S02-3 | `tests/e2e/landing.test.ts` | landing S02: watch delivery, restart and query cadence survive real forge failures |
| 05-S02-4 | `tests/e2e/landing.test.ts` | landing S02: unavailable gh disables GitHub queries while GitLab remains observable |
| 05-S02-5 | `tests/e2e/landing.test.ts` | landing S02: watcher queries stay nonblocking while workers refuse CI waits |
| 05-S07 | `tests/e2e/landing.test.ts` | landing: held CI repair checks Sender authority before restoring a worker |
| S06-5 | `tests/e2e/landing.test.ts` | landing: forge observation failures refuse merge receipts without leaking external replies |
| S06-6 | `tests/e2e/landing.test.ts` | landing: spawn pressure releases the oldest held author and a journal refusal leaves room retryable |
| 05-S15-C | `tests/e2e/diff-review.test.ts` | S15: reviewers receive bounded whole-file snapshots with resolved task paths and capped consumers |
| 05-S15-F | `tests/e2e/diff-review.test.ts` | S15: a git object read failure is named in reviewer context without fabricating absence |
| 05-S15-W | `tests/e2e/landing.test.ts` | landing S15: durable review evidence owns the merge window across parent restarts |
| 05-S15-T | `tests/e2e/diff-review.test.ts` | S15: the real cp_review tool relays bounded verdicts and policy refusals without review bodies |
| 05-S15-P | `tests/e2e/diff-review.test.ts` | S15: dispatch preview rejects parent tools in external worker profile configuration |
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
| `tests/integrate-held-ci.test.ts` | CI observation repairs without parent notice delivery; duplicates and manual integration share the project lane | 05-13 | mapped | S07: watch-driven repair overlaps manual cp_integrate and a second real job at a forge barrier; S07-NC-2 fails queued-peer assertion. One supersession, same worker/branch/worktree, correct run and hold in model request, archived first envelope and accepted replacement; green holds with no merge ask/checkpoint, release requires review; NC-37 fails spent-allowance outcome |
| `tests/integrate-held-ci.test.ts` | startup repair and restart preserve the cumulative allowance after repaired green and failing reports | 05-13 | mapped | S07: real parent restart reads green hold and spent allowance; failing head in fresh parent says already asked once, never a missing-worker fallback; NC-37 fails the already-asked reason assertion |
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
| `tests/budgets.test.ts` | with no data/budgets.json, per_job_tokens and spawn_cap are the fleet defaults | 02-4 | mapped | with no budgets file on disk, the spender's record carries DEFAULT_BUDGET_CONFIG's per_job_tokens and per_job_cost_usd, and an eleventh dispatch is refused "spawn cap reached (10/10 workers)" |
| `tests/budgets.test.ts` | a raise written after the parent started reaches per_job_tokens on the live manager | 02-4 | mapped | `overflow` dispatches with budget.tokens 1,000 from a file written after the CommandPost was built; negative control NC-04 |
| `tests/budgets.test.ts` | the raised per_job_cost_usd reaches the live manager | 02-4 | mapped | `overflow` and `next` dispatch with budget.cost_usd 3 |
| `tests/budgets.test.ts` | spawn_cap is not stale independently of the rest of the budget config | 02-4 | mapped | spawn_cap 11, written after start, admits `overflow` that the default 10 refused; negative control NC-04 |
| `tests/budgets.test.ts` | CommandPost.budgets() sees the raise without reconstruction | 02-4 | mapped | dispatch reads the budget through budgets(); `overflow`'s record shows the raise |
| `tests/budgets.test.ts` | a second raise on the same live CommandPost also takes effect | 02-4 | mapped | the second write (2,000 tokens, spawn_cap 12) dispatches `next` with 2,000 as an eleventh live worker |
| `tests/ops-jobs.test.ts` | opsClass is undefined for a job with no ops: label | 02-6 | mapped | `plain research` previews with its own planner profile; an unlabelled job with profile ops is refused |
| `tests/ops-jobs.test.ts` | opsClass reads one known ops:<class> label | 02-6 | mapped | ops:deploy, ops:process and ops:pull each preview with profile ops |
| `tests/ops-jobs.test.ts` | opsClass refuses two ops: labels | 02-6 | mapped | ops:pull + ops:deploy: "exactly one ops:<pull\|deploy\|process> label" from the dispatch preview |
| `tests/ops-jobs.test.ts` | opsClass refuses an unknown class | 02-6 | mapped | ops:reboot: "found ops:reboot" from the dispatch preview |
| `tests/ops-jobs.test.ts` | opsRequest: a deploy is high and runs the ops profile whatever risk the caller names | 02-6 | mapped | preview with risk low gives [ops, high]; negative control NC-08 |
| `tests/ops-jobs.test.ts` | opsRequest: a process job is always high | 02-6 | mapped | preview routing risk high |
| `tests/ops-jobs.test.ts` | opsRequest: a pull defaults low | 02-6 | mapped | preview routing risk low |
| `tests/ops-jobs.test.ts` | opsRequest: a recorded risk:high still wins on a pull | 02-6 | mapped | `risky pull` (ledger risk high) previews high |
| `tests/ops-jobs.test.ts` | opsRequest returns a non-ops request untouched | 02-6 | mapped | profile planner kept on `plain research` |
| `tests/ops-jobs.test.ts` | opsRequest refuses the ops profile without an ops: label | 02-6 | mapped | "the ops profile needs an ops:<pull\|deploy\|process> label" |
| `tests/ops-jobs.test.ts` | opsRequest refuses another profile on an ops job | 02-6 | mapped | "an ops:pull job runs the ops profile, not planner" |
| `tests/ops-jobs.test.ts` | opsRequest refuses an ops job that is not kind:research delivery:local | 02-6 | mapped | ship/pr job with ops:pull: "an ops job is kind:research delivery:local" |
| `tests/ops-jobs.test.ts` | riskGateExempt exempts read-only research | 02-6 | mapped | risk:high read-only planner job under ask_on risk:high: no mandate_gate in the preview |
| `tests/ops-jobs.test.ts` | riskGateExempt never exempts an ops job, even with a read-only profile | 02-6 | mapped | `risky pull` (ops profile, readOnly) previews "would ask: risk:high"; negative control NC-07 |
| `tests/ops-jobs.test.ts` | a resource:<name> label is leased while its holder is live | 02-6 | mapped | `wanting` refused "resource:tg-session is leased by live job <holder>" with no fleet record or model request; negative control NC-09 |
| `tests/ops-jobs.test.ts` | the resource is free once its holder is torn down (phase done) | 02-6 | mapped | after the holder's forced teardown `wanting` dispatches |
| `tests/ops-jobs.test.ts` | a job's own failed record is not a resource conflict | 02-6 | redundant-unreachable | preflight refuses a failed job's re-dispatch on its own leftover branch (`branch_exists`) before assertResourcesFree runs, and the operator path tears the record down (phase done) first; 02-6 pins a killed, failed `wanting` re-dispatch refused by branch_exists, never "leased by live job"; standing rule 3 (ask-0088e0332d00) |
| `tests/ops-jobs.test.ts` | a different resource label is free while another is leased | 02-6 | mapped | `other` (resource:mt5-2) dispatches while the holder of resource:tg-session is live |
| `tests/risk-negation.test.ts` | safety constraints (no migration, never expose secrets or tokens, …) infer no risk and name no word | 02-7 | mapped | each text previews risk low, provenance defaulted, no mandate_gate. The empty `riskKeywords` result reaches no consumer by itself: dispatch reads the same `acceptedRiskMatches` path (`inferScopeAndRisk`, `src/pipeline.ts`) for routing.risk, and the risk:high ask names `riskKeywords` words only when that path matched; negative control NC-10 breaks that path |
| `tests/risk-negation.test.ts` | brief negations with up to three intervening words infer nothing; the affirmative half of a mixed text stays high with its word | 02-7 | mapped | negated texts preview low; mixed texts are refused under the bridge grant and the ask names exactly the expected words |
| `tests/risk-negation.test.ts` | a modified destructive action after `or` stays high; a negated modifier does not | 02-7 | mapped | delete/destroy/truncate/purge/backfill/drop the table/migrate each named alone; the two negated texts preview low |
| `tests/risk-negation.test.ts` | cp-ukqv: a list after a negated destructive verb shares the negation; a positive action still trips high | 02-7 | mapped | ten shared-negation texts preview low; fifteen positive texts name their words in the ask |
| `tests/risk-negation.test.ts` | independent credential and access actions after `or` stay high; negated ones infer nothing | 02-7 | mapped | credentials/secrets/permissions/authentication/secrets, tokens named; five negated texts preview low |
| `tests/risk-negation.test.ts` | Constraints/Non-goals sections end at the next peer or parent heading | 02-7 | mapped | the section alone previews low; a following ## or # Implementation, or a leading line, names credentials |
| `tests/risk-negation.test.ts` | fenced headings cannot open or close excluded sections | 02-7 | mapped | four fences × two headings name credentials, production; fenced-only and false-close texts as in the unit file |
| `tests/risk-negation.test.ts` | positive evidence survives safety wording | 02-7 | mapped | credentials; billing, production; delete; "Expose secrets or tokens" is high |
| `tests/risk-negation.test.ts` | a supplied risk (explicit or assessed, low or high) wins over excluded-section words and keeps its provenance | 02-7 | mapped | previewDispatch with risk and inputsFrom returns [risk, provenance] as supplied |
| `tests/risk-negation.test.ts` | riskkw-f10: the four refused jobs' keyword senses infer no risk; approval-sense authorization stays evidence | 02-7 | mapped | eleven texts preview low; the cp_gate authorization text names authorization |
| `tests/risk-negation.test.ts` | riskkw-f10: real risk wording stays high | 02-7 | mapped | eighteen texts are refused under the bridge grant, each ask naming at least one word |
| `tests/risk-negation.test.ts` | cp-wkv1: no-migration notes, plan evidence sections, spend tokens and audit remedies infer no risk | 02-7 | mapped | eleven texts preview low |
| `tests/risk-negation.test.ts` | cp-wkv1: real operational risk stays high next to the new benign senses | 02-7 | mapped | eighteen texts named with their exact words in the ask |
| `tests/risk-negation.test.ts` | cp-wkv1: an excluded section at the end of the task or an excluded-heading title never swallows the job description | 02-7 | mapped | description "Delete the production database" names delete, production under a Self-assessment-ended task and under seven excluded-heading titles; "Render it." previews low |
| `tests/mandate-defaults.test.ts` | loadMandateDefaults falls back to the scaffold values when the file does not exist | 02-8 | redundant-unreachable | every reader runs in a pi session, and session start scaffolds the file with exactly these values first; 02-8 asserts the scaffolded values and a bare issue resolved from them |
| `tests/mandate-defaults.test.ts` | scaffold writes data/mandate-defaults.json once with the conservative values; an operator edit survives | 02-8 | mapped | the first parent session creates the file (values, notes, actions, ask_on, exclude_paths); spend_usd 42 shows after the next session |
| `tests/mandate-defaults.test.ts` | an existing home's dispatch_parallelism 1 survives scaffold and resolves as is | 02-8 | mapped | defaults_show shows 1 after the next session; the next bare issue has dispatch_parallelism 1 from home |
| `tests/mandate-defaults.test.ts` | an invalid file is refused rather than guessed | 02-8 | mapped | job_cap 0 makes cp_mandate defaults_show an error naming job_cap |
| `tests/mandate-defaults.test.ts` | defaults_set writes, rejects an unknown key or a non-number; token_ceiling binds; an unreadable file fails closed | 02-8 | mapped | cp_mandate defaults_set job_cap/ask_on/token_ceiling; bogus and not-a-number error; raise_tokens past 50000000 and under "{ not json" (ceiling 0) are refused |
| `tests/mandate-defaults.test.ts` | formatMandateDefaults prints every field and its note | 02-8 | mapped | defaults_show text carries expiry_hours, spend_usd and the conservative note |
| `tests/mandate-defaults.test.ts` | the ladder: explicit wins over project, project over home | 02-8 | mapped | spend_usd 99 explicit, job_cap and allowed_actions from the project, spend_tokens from home, each with its provenance |
| `tests/mandate-defaults.test.ts` | expiry comes from expiry_hours when no explicit expiry is given | 02-8 | mapped | a bare issue expires issued_at + 8 h with provenance home |
| `tests/mandate-defaults.test.ts` | an explicit expiry wins over a project expiry_hours | 02-8 | mapped | `dated` keeps 2030-01-01 with provenance explicit under a project expiry_hours 1 |
| `tests/mandate-defaults.test.ts` | 'fix example-infra #17' resolves into one complete grant; show names every field's source | 02-8 | mapped | issue with projects and objective only: every provenance is home; cp_mandate show prints field sources and expiry_hours:home |
| `tests/mandate-defaults.test.ts` | identical project overrides agree regardless of key order; a differing one falls through | 02-8 | mapped | agreeing overrides in a different key order apply; job_cap 6 on one project falls through to home; an override beside a project with none falls through to home; negative control NC-12 |
| `tests/risk-warning.test.ts` | declaredRisk reads a clause-start risk in the header only; a named gate declares nothing | 02-9 | mapped | six declared-low headers preview no mandate_gate; eight named-gate, later-section, fenced and look-alike headers preview "would ask: risk:high"; negative control NC-13 |
| `tests/risk-warning.test.ts` | recordedRisk: any high first, then the caller's, then the job's own low | 02-9 | mapped | a risk:high label beats an explicit low; an explicit high beats a risk:low label; a header high beats a planner low; a high label beats a defaulted pipeline low |
| `tests/risk-warning.test.ts` | a pipeline risk is a record only when it was explicit or assessed, and says which half recorded it | 02-9 | mapped | defaulted and inferred pipeline lows still gate; explicit and planner-assessed lows warn "recorded by the pipeline" and "assessed by the planner" |
| `tests/risk-warning.test.ts` | riskField routes a recorded high only, never a low, and never overrides the caller | 02-9 | mapped | preview routing: risk:high label and header high route [high, explicit]; risk:low label routes [low, defaulted]; the caller's explicit low wins the route |
| `tests/risk-warning.test.ts` | inferredRiskGate: a recorded high gates, a recorded low warns on inferred-only, explicit/assessed highs gate | 02-9 | mapped | each recorded low's warning names its source (label, planner, pipeline, description header, task header, dispatch) and a cp_send promotion's names "recorded at dispatch"; each gated ask names its risk source |
| `tests/risk-warning.test.ts` | #321: a classify-sourced high on an operator-chat grant warns with its word; bridge, schedule, ops, hard stops and recorded highs gate | 02-9 | mapped | the operator-chat grant warns "word: delete, migration"; explicit, planner and label highs and three hard stops gate under it; the bridge grant gates every undeclared text. Ops: 02-6 pins an ops job never exempt from the gate. The schedule half is the next row |
| `tests/risk-warning.test.ts` | #321 (schedule half): a schedule fire grant, or a schedule run with no selected grant, still gates a keyword-only high | 02-9 | retained | No entry point creates either state any more: a native fire mints no grant, and a run with an `ask_on` snapshot is a legacy run still draining. Kept as a unit on real stores in `tests/schedule-authority.test.ts` ("#321: a legacy schedule fire grant or schedule run …", owned by P13). Dropping `!grant.schedule_fire`, or a schedule-run job's selection, fails it. 02-9 pins the operator-chat warning it contrasts with. Relabelled from redundant-unreachable by P2e (P2d review finding) |
| `tests/risk-warning.test.ts` | riskkw-qno: audit tags and an unapproved named item do not warn; the gate and inference are unchanged | 02-9 | mapped | the three qno texts still gate with no recorded low and warn nothing under a risk:low label |
| `tests/risk-warning.test.ts` | deleting a named source/doc file or dead code does not warn; a bare or data deletion still does | 02-9 | mapped | named-file, doc-file and dead-code deletions warn nothing; seven bare or data deletions warn "keywords only (delete"; `gh auth status` routes low |
| `tests/risk-preapproval.test.ts` | hardStops: affirmative force push, publishing, deletion and credential acts stop; negated mentions do not | 02-10 | mapped | the noisy task names (credential handling, data deletion, force push, external publishing); "no force-push and never npm publish" dispatches; 02-9 pins rm -rf, auth.json and force push as hard stops; negative control NC-14 |
| `tests/risk-preapproval.test.ts` | preapprovalCovers: named_jobs names ids; mandate_jobs covers the grant's ids or jobs created at/after issue in its projects | 02-10 | mapped | named ids proceed and `other` asks; the pre-approval written at issue covers `late`, created after it, and not `other`, created before |
| `tests/risk-preapproval.test.ts` | a quote not found in operator messages is refused; a found one records who decided | 02-10 | mapped | cp_mandate preapprove_risk with an absent quote errors and writes nothing; the found one records the quote and its job ids |
| `tests/risk-preapproval.test.ts` | a covered risk:high dispatch and promotion raise no escalation and append one audit row each, shown by cp_mandate show | 02-10 | mapped | `covered` dispatches and is promoted with no new question; rows [dispatch, promote] operator-delegated with quoteSha, never the quote; show prints both |
| `tests/risk-preapproval.test.ts` | uncovered jobs, scripts and hard-stop text escalate exactly as without a pre-approval | 02-10 | mapped | `other` asks with no hard-stop evidence; a named script job is refused; `pushing` names "hard stop force push"; the noisy refusal carries categories only, no raw text or secret |
| `tests/risk-preapproval.test.ts` | the selected serial grant still caps a pre-approved job, and a refusal writes no audit row | 02-10 | mapped | `serial` refuses its own pre-approved job "dispatch-parallelism 1 is full" and has no risk_preapproved rows |
| `tests/risk-preapproval.test.ts` | a nonselected full serial grant cannot veto a pre-approved dispatch | 02-10 | mapped | the later project-wide serial grant is not selected; `negated` dispatches under the pre-approved grant |
| `tests/risk-preapproval.test.ts` | a pre-approval never widens or outlives a grant, and issue writes it with the grant | 02-10 | mapped | a repeated pre-approval leaves `pushing` refused; `narrow` refuses "does not cover" an outside job; a revoked grant refuses; issue writes the quote |
| `tests/risk-preapproval.test.ts` | a pre-approval never reaches a merge or a checkpoint | 02-10 | redundant-unreachable | `evaluateAuthority` (merge and checkpoint decisions) never reads risk_preapproval, so no consumer can hand it one; only the dispatch and promotion gates call `riskPreapproval`. 02-10 pins that the pre-approval reaches only dispatch and promote audit rows and that the result and show say "never merge". cp_decide passes no job risk to a checkpoint (`lookupJob`, `extensions/command-post/tools-mandate.ts`), so the unit's risk:high checkpoint refusal has no consumer; reported to the main session as a finding. Standing rule 3 (ask-0088e0332d00) |
| `tests/risk-preapproval.test.ts` | cp_mandate preapprove_risk verifies the quote against operator messages before writing; show prints it | 02-10 | mapped | absent quote refused with nothing written; show prints "build all except N12" |
| `tests/risk-preapproval.test.ts` | N3 (b): cp_mandate preapprove_risk accepts an operator quote with no es- id while a risk_high escalation is open | 02-10 | mapped | `covered`'s open ask, then the N3 quote pre-approves it |
| `tests/risk-batch.test.ts` | tv8: overlapping askers use one selected grant; selected nonasking and requested-ID mismatch write nothing | 02-11 | mapped | overlap names the selected grant; md-000000 is refused as not the asking mandate; a selected grant that stops asking lends nothing; escalations.json stays byte-identical |
| `tests/risk-batch.test.ts` | batchRiskHigh: every refusal writes nothing; a valid batch is one sorted approve/drop record and the per-job rows withdrawn | 02-11 | mapped | nine cp_escalate refusals (count, duplicates, unknown, ungated, named, overlap, mixed, approved) leave the file byte-identical; the valid batch is sorted, approve/drop, recommended drop, withdrew 2 rows, carries each row's evidence; approve dispatches; negative control NC-15 |
| `tests/risk-batch.test.ts` | batchRiskHigh: mixed asking mandates and an already-approved job are refused with nothing written | 02-11 | mapped | "one asking mandate must cover every job"; "already approved: <job>" |
| `tests/risk-batch.test.ts` | batchRiskHigh: the batch is raised before any withdraw, so a failing withdraw leaves it open | 02-11 | redundant-unreachable | a failing withdraw needs an injected EscalationStore; no consumer can make withdraw fail on demand. 02-11 pins the ordering's outcome: the batch is open and both per-job rows withdrawn, and only the batches and the unbatched ask stay open. Standing rule 3 (ask-0088e0332d00) |
| `tests/mandate-selection.test.ts` | active selection is named-first, earliest-issued, then code-point ID, in every permutation | 02-12 | mapped | `first` previews and dispatches under md-a994c5 over md-b994c5 (same second) and md-000001 (later); an unnamed job takes the project-wide md-000000; negative control NC-16 |
| `tests/mandate-selection.test.ts` | coverage and standing precede precedence, including schedule-only grants | 02-12 | mapped | six earlier grants that do not cover, are paused, expired or schedule-only leave the project-wide grant selected; a scheduled job speaks only through its schedule's grant |
| `tests/mandate-selection.test.ts` | latest-speaking fallback keeps input-order ties; silent/none never acquire authority | 02-12 | mapped | same-second refusing grants: the later in file order is named and refuses; a paused and an other-project grant give no mandate |
| `tests/mandate-supplement.test.ts` | full named grant yields to supplement for dispatch, advice and implement in either order | 02-12 | mapped | the preview (advice) and the dispatch select md-supp01 once md-older1 is full; cp_decide reads the supplement's allowed_actions; negative control NC-17 |
| `tests/mandate-supplement.test.ts` | cpNext partitions the incident job under the same supplement in either order | 02-12 | mapped | cp_next through the parent: the supplement's view recommends dispatching `target`, and no other grant's view lists it ready |
| `tests/mandate-supplement.test.ts` | ineligible supplement leaves the original job-cap refusal in every order | 02-12 | mapped | nine ineligible variants (both full, project-wide, kind excluded, operator/cap paused, revoked, expired, schedule-only, other job) leave md-older1 refusing "job cap 3 reached" |
| `tests/mandate-supplement.test.ts` | under-cap original, omitted jobs, and first eligible supplement preserve deterministic order | 02-12 | mapped | room under md-older1 keeps three dispatches; md-supp02 before md-supp03; a full supplement is skipped for md-supp05 |
| `tests/mandate-supplement.test.ts` | cap-paused original does not shadow active supplement in either order | 02-12 | mapped | `shadowed` previews under md-supp06 |
| `tests/mandate-supplement.test.ts` | current job is excluded from selection headroom; accounting and continuations stay stable after re-dispatch | 02-12 | mapped | the cap-1 supplement dispatches its own job, keeps it for the cp_send promotion, and shows "job cap: 1 / 1"; an operator cap raise returns selection to the original |
| `tests/mandate-supplement.test.ts` | selected supplement owns risk approval and audit (approved=false/true) in either order | 02-12 | mapped | md-supp08's ask names it, not md-older1; md-supp09's pre-approval dispatches with its own audit row and none on md-older1; a hard stop still asks |
| `tests/mandate-supplement.test.ts` | selected supplement denial cannot fall back to weaker policy in any permutation | 02-12 | mapped | parallelism, allowed_actions and plan_approval: md-supp10's full slot refuses `weak` despite md-weak01, and cp_decide refuses under its allowed_actions and ask_on, leaving the checkpoint pending. The other three causes are the next two rows |
| `tests/mandate-supplement.test.ts` | selected supplement denial (path and subsystem exclusion) cannot fall back to weaker policy | 02-15 | mapped | A pipeline's auto-decided plan checkpoint carries the task text that exclusions read. 02-15 issues a strict named grant (earliest) and a later weak grant naming the same ship: src/legacy (path), billing (subsystem) and services/api/.env (scaffold exclusion) each leave the checkpoint pending, and the weak grant decides nothing. P2e replaced P2d's unit in `tests/decide.test.ts` with this (P2d review finding) |
| `tests/mandate-supplement.test.ts` | selected supplement denial (spend cap) cannot fall back to weaker policy | 02-12 | redundant-unreachable | Every consumer sweeps first: cp_decide, auto-decide and dispatch. The sweep cap-pauses the supplement, so "spend cap reached" never reaches a judgement, and the later grant then decides. That outcome is the cap-paused-yields rule 02-12 pins (`shadowed` under md-supp06). Reported to the main session as a finding. Standing rule 3 (ask-0088e0332d00) |
| `tests/mandate-usage.test.ts` | tokens: one 80% warning, one cap-pause notice, never repeated across re-observation or a revived worker | 02-13 | mapped | warn-tokens then token-cap; paused once with one escalation; the worker is still waiting. After the cap, a bounded-recovery relaunch and a cp_revive relaunch each send a message that adds no notice or escalation. With the project-wide grant revoked, a cp_send promotion of the idle worker is refused with "paused (token_cap) … raise it yourself: cp_mandate raise_tokens" (02-4 pins the dispatch's) |
| `tests/mandate-usage.test.ts` | cache reads never count toward the token cap; the notice totals are non-cached | 02-13 | mapped | a 50M-cache-read turn shows 7000 non-cached and notices nothing; the cap notice reads "used 10100 / 10000 non-cached tokens"; negative control NC-18 |
| `tests/mandate-usage.test.ts` | the parent raises a token cap itself: the grant resumes, the job continues, and the next round notices afresh | 02-13 | mapped | cp_mandate raise_tokens in a real parent: active again with its reason; warn-tokens@20000 and token-cap@20000 follow once each |
| `tests/mandate-usage.test.ts` | at the token ceiling, the cap is the operator's: budget_exhausted is raised once | 02-13 | mapped | token_ceiling 1000 set through cp_mandate defaults_set; the cap notice says TOKEN CEILING and a second budget_exhausted ask is raised; 02-4 pins the raise past the ceiling refused |
| `tests/mandate-usage.test.ts` | a USD cap is always the operator's, even with tokens to spare | 02-13 | mapped | priced mock model: $1 cap pauses spend_cap with one budget_exhausted ask |
| `tests/mandate-usage.test.ts` | usd crosses independently of tokens | 02-13 | mapped | warn-usd at $0.85, then cap at $1.05, with tokens far under their cap |
| `tests/mandate-usage.test.ts` | an old grant the parent already capped says nothing; the replacement grant's notices are its own and survive teardown | 02-13 | mapped | the capped grant's later turns add nothing; a project-wide grant over the job has no notices of its own; notices carry no job keys and survive the forced teardown |
| `tests/mandate-usage.test.ts` | a project-wide grant issued over history and an in-flight job counts only what accrues after issue, live | 02-13 | mapped | issued on the live view mid-run: usage_baseline 10100 for the in-flight job, then "10001 / 30000 non-cached tokens" and "job cap: 1 / 10" |
| `tests/mandate-usage.test.ts` | cp_mandate and cp_decide read the live view, so the baseline and every cap check see the same usage | 02-13 | redundant-unreachable | a source scan; the e2e parent is its own process and owns no live run, so no e2e parent can show it. Kept verbatim in `tests/structure.test.ts`; 02-13 pins the outcome on the live view the tool passes (baseline 10100, show 10001). Standing rule 3 (ask-0088e0332d00) |
| `tests/mandate-usage.test.ts` | every CommandPost spawn path (dispatch, revive, bounded recovery) shares one observer set | 02-13 | mapped | notices fire from the dispatched worker, the bounded-recovery relaunch (worker_revived) and the cp_revive relaunch, each counted once |
| `tests/capacity.test.ts` | admin capacity is numeric per provider, uses only admin key and redacts source | 02-14 | mapped | "capacity=admin:mock=6,other=0"; every gateway call is a GET with x-api-key and no Authorization; no preview carries the key |
| `tests/capacity.test.ts` | malformed, missing provider, disabled and timeout use fleet counts; no key preserves order | 02-14 | mapped | six malformed snapshots fall back with "reason=capacity response unreadable"; a timeout falls back; with no key there are no capacity scores and mock/a stays first |
| `tests/capacity.test.ts` | 401 uses fleet counts and names the rejected admin credential | 02-14 | mapped | "capacity=fleet:mock=-2,other=0 reason=capacity auth rejected" and other/b; negative control NC-19 |
| `tests/capacity.test.ts` | unreadable or missing fleet means unknown, never a fabricated zero | 02-14 | redundant-unreachable | CommandPost always builds the reader with its own fleet store, and the unit's no-key reader returns unknown before any fleet read. 02-14 pins the no-key outcome: no capacity scores and the rubric order stands. Standing rule 3 (ask-0088e0332d00) |
| `tests/quota.test.ts` | loadCapacityConfig reads <home>/.pi-command-post/data/capacity.json, never a top-level data/ (cp-u3i2) | 02-14 | mapped | a legacy top-level data/capacity.json alone reaches no gateway and reads "quota unavailable: unreadable" |
| `tests/quota.test.ts` | quota filters accounts, selects the lowest maximum, and coalesces cached reads | 02-14 | mapped | of nine accounts only 1, 5 and 6 are read; mock's 7d 86 is tight and steers to other/b; two concurrent routes share one snapshot |
| `tests/quota.test.ts` | an unreported 5h window keeps the account on 7d alone; a real 0/0 stays real | 02-14 | mapped | "5h=n/a,7d=11" and "5h=0,7d=0" |
| `tests/quota.test.ts` | quota accepts a confirmed full page and refuses incomplete or uncertain lists | 02-14 | mapped | nine count/total pairs; uncertain lists read no account usage |
| `tests/quota.test.ts` | unsupported shapes and API key accounts are unknown, custom thresholds apply | 02-14 | mapped | 95/90 thresholds leave 7d 86 untight; an apikey account and a tokens-only reply are unknown |
| `tests/quota.test.ts` | quota thresholds include their boundary and invalid percentages stay unknown | 02-14 | mapped | 90 (5h) and 85 (7d) are tight, 89/84 are not, 101 is unknown; negative control NC-20 |
| `tests/quota.test.ts` | quota names failures without secrets and makes no call without a key | 02-14 | mapped | "auth rejected", "unreadable", "timeout" with the key in every reply body and never in a preview; no key: "quota=off:no admin key" and no request |
| `tests/quota.test.ts` | quota refreshes after 60 seconds and rejects malformed configuration before fetching | 02-14 | mapped | 4 calls at 59.999 s, 8 at 60 s; ten malformed configs reach no gateway |
| `tests/quota.test.ts` | quota has a total timeout even when fetch ignores the abort signal | 02-14 | mapped | an accounts reply that never settles and ignores abort gives "quota unavailable: timeout" |
| `tests/mandate.test.ts` | tv8: selected named grant alone binds risk, job cap and parallelism; overlapping coverage still counts | 02-12 | mapped | the named md-a994c5 is selected over the project-wide grant; md-supp10's full slot refuses `weak` (parallelism_full) despite md-weak01; md-supp08's risk ask names it, not md-older1; md-supp09's pre-approval is audited on it alone; a job counts toward every grant covering it ("job cap: 1 / 1"); negative control NC-16 |
| `tests/mandate.test.ts` | tv8: selected checkpoint denial is final in either input order | 02-12 | mapped | allowed_actions, plan_approval and parallelism through cp_decide under md-supp10 (02-12); path and subsystem exclusions under the strict grant, with a later weak grant lending nothing, through a pipeline's checkpoint (02-15); an unnamed risk:high stays pending (02-15) |
| `tests/mandate.test.ts` | reviewer preference round-trips and changes only the setting, including expired grants | 02-16 | mapped | cp_mandate reviewer_model sets mock/b and clears it ("reviewer model: unset"); an expired grant takes mock/b and stays expired |
| `tests/mandate.test.ts` | cp_mandate forwards issue reviewer preference and set/clear; null on issue refuses | 02-16 | mapped | issue with reviewer_model mock/a stores it; reviewer_model null on issue is refused "null only clears an existing grant"; reviewer_model with no value is refused |
| `tests/mandate.test.ts` | cp_mandate is parent-only | 02-16 | redundant-unreachable | no worker can hold cp_mandate: profile validation refuses every `WORKER_FORBIDDEN_TOOLS` entry (`tests/contracts.test.ts`, `tests/profiles.test.ts` and the contracts-exports golden, all exceptions). 02-16 pins the parent surface that holds it. Standing rule 3 (ask-0088e0332d00) |
| `tests/mandate.test.ts` | resolveMandateJobIds expands all jobs created in this turn | 02-16 | mapped | two cp_job creates, then issue with the sentinel: job_ids are both ids; the sentinel beside an id is refused "cannot mix with job ids"; negative control NC-22 |
| `tests/mandate.test.ts` | cp_mandate issue stores expanded this-turn job ids | 02-16 | mapped | the stored grant's job_ids equal the turn's created ids; negative control NC-22 |
| `tests/mandate.test.ts` | evaluateAuthority: permitted / not-permitted matrix | 02-15 | mapped | permitted with clause "allowed_actions includes implement for project demo", path exclusion, gate flags and an unnamed risk:high (02-15); an unnamed job (02-1); expired and paused grants (02-2); spend cap (02-13, the USD cap pause); ask_on plan_approval (02-12, cp_decide refused) |
| `tests/mandate.test.ts` | auto-decision journals the clause; revoke leaves pending pending | 02-15 | mapped | decided_by mandate:<id>, the clause as note, decisions [ship]; a revoked grant speaks for nothing (02-2) and cp_decide under a revoked grant is refused "no active mandate covers" (02-17) |
| `tests/mandate.test.ts` | cp-7re9: autoDecideCheckpoint in a denied project leaves the checkpoint pending and journals nothing; the grant keeps its standing | 02-15 | mapped | deny_projects demo: pending, no decision journaled, the grant active; with the key removed the next advance decides it; negative control NC-21 |
| `tests/mandate.test.ts` | cp-7re9: issue honours deny_projects and scope_policy, and a malformed mandate-defaults.json refuses naming the file | 02-16 | mapped | cp_mandate issue under deny_projects, scope_policy named_jobs_only and "{ not json" is refused each time; the existing grant stays active |
| `tests/mandate.test.ts` | no-id cp_mandate show lists active and paused only; statuses lists revoked and expired; show(id) still returns a revoked grant | 02-16 | mapped | show lists the active and the paused grant, not the revoked one; statuses [revoked] lists only it; show by id prints "<id>: revoked" |
| `tests/mandate.test.ts` | a raised gate flag is never mandate-decided | 02-15 | mapped | a gate verdict with destructive_scope or blocking_unknowns raised leaves the checkpoint pending with nothing journaled |
| `tests/mandate.test.ts` | hitting the spend cap pauses, refuses a new dispatch, and escalates once | 02-13 | mapped | priced mock model: the $1 cap pauses the grant spend_cap with one budget_exhausted ask; a cap-paused grant refuses the next dispatch with its raise hint (02-4) |
| `tests/mandate.test.ts` | MandateStore writes every instant it is handed at second precision (2026-10-06T00:05Z) | 02-16 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): cp_mandate and the sweeps hand the store no millisecond instant, so restoring the old handed-instant bug cannot fail an e2e. 02-16 pins whole-second issued_at |
| `tests/mandate.test.ts` | MandateStore.sweep refuses an invalid timestamp | 02-16 | retained | the last assertion of the second-precision unit, moved verbatim to `tests/decide.test.ts` (owned by P10): every caller hands the sweep an isoTimestamp or nothing. 02-16 pins the sweep that expires a grant and closes its ask |
| `tests/mandate.test.ts` | a new grant counts only usage accrued after issue; only a zero cap is refused, and nothing is written | 02-13 | mapped | a grant issued over an in-flight job records usage_baseline 10100 and counts only later usage; a zero USD cap is refused with no grant written (02-16) |
| `tests/mandate.test.ts` | a grant with no usage_baseline keeps the lifetime rule | 02-13 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): a legacy grant shape that only an old on-disk file carries; 02-13 pins the baselined count beside it |
| `tests/mandate.test.ts` | a project-wide grant: history never fills the job cap; new dispatches and pre-existing jobs that spend under it do | 02-13 | mapped | issued mid-run over history: "job cap: 1 / 10" counts only the job spending after issue; held jobs count (02-5); a named grant counts every job it names ("job cap: 1 / 1", 02-12) |
| `tests/mandate.test.ts` | projectWideCapWarning: a project-wide grant is warned that its job cap counts other mandates' jobs; a named grant is not | 02-16 | mapped | the project-wide issue says "warning: md-… is project-wide, so its job cap 3 counts every job"; the named issue carries no warning |
| `tests/mandate.test.ts` | a shrinking reading on one baselined job never funds another job's growth | 02-13 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): no scenario lowers a baselined job's usage reading; 02-13 pins the baselined count |
| `tests/mandate.test.ts` | worker accrual is never masked by a reviewer baseline | 02-13 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): no scenario runs a reviewer before a grant and a worker after it; 02-13 pins worker usage and 02-15 gate spend in show |
| `tests/mandate.test.ts` | the job cap limits new dispatches only: at 3/3 the grant stays active and its covered jobs keep review, repair and merge | 02-17 | mapped | cap 1: `extra` is refused "job cap 1 reached — no new dispatch", the grant stays active, and `capped` keeps its promotion, repair and a cp_decide diff decision |
| `tests/mandate.test.ts` | a grant paused on job_cap before this rule resumes on the next save | 02-17 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): a legacy pause that only an old on-disk file carries, since nothing writes pause_reason job_cap any more; 02-17 pins that a full job cap never pauses the grant |
| `tests/mandate.test.ts` | save itself refuses a token cap above the home's token_ceiling, naming defaults_set as the fix; USD never moves | 02-4 | mapped | cp_mandate raise_tokens past the ceiling is refused naming defaults_set; the USD cap never moves |
| `tests/mandate.test.ts` | an operator issue above token_ceiling is refused, naming defaults_set; it succeeds once the operator raises the ceiling | 02-16 | mapped | spend_tokens 200000000 is refused naming "cp_mandate defaults_set token_ceiling 200000000"; after that defaults_set the same issue is active |
| `tests/mandate.test.ts` | revoke, a replacing grant and supersede_stale close a mandate's open escalations as superseded, with no answer | 02-16 | mapped | revoke supersedes its own ask ("<id> was revoked", no answer); supersede_stale closes a title-only legacy ask; a new budget question files its own record; the replacing grant: 02-3 |
| `tests/mandate.test.ts` | cp_awaiting list output drops an escalation once its mandate is revoked | 02-16 | mapped | cp_awaiting list names the ask, then omits it after cp_mandate revoke |
| `tests/mandate.test.ts` | expiry supersedes the grant's open escalations on the sweep that expires it | 02-16 | mapped | an expired grant's ask reads "<id> expired" after the sweep |
| `tests/mandate.test.ts` | gate, diff-review and quality-panel reviewer spend counts toward the covering grant's USD and token caps, non-cached | 02-15 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): no scenario starts a diff-review or quality-panel run, so reviewer spend alone crossing the USD cap (spend_cap, a refused diff) is pinned there. 02-15 pins the gate reviewer's tokens against the grant ("1230xx / 10000000 non-cached tokens"); cache reads: 02-13, NC-18 |
| `tests/mandate.test.ts` | assertDispatchAllowed: serial limits fresh dispatches by working jobs; a same-worker promotion never takes the slot | 02-17 | mapped | serial grant: a working `first` refuses `second`, and `first`'s promotion proceeds; a held job holds no slot (02-5, NC-05) |
| `tests/mandate.test.ts` | 4B2-T0: the parallelism refusal carries code parallelism_full on a real MandateError; a job-cap refusal has no code | 02-17 | mapped | the dispatch refusal has code parallelism_full; the job-cap refusal has none |
| `tests/mandate.test.ts` | a revoked grant predating dispatch has no standing for review, repair or merge; revocation after dispatch still refuses | 02-17 | mapped | a grant revoked before `before` dispatched is silent and its repair proceeds; one revoked after `after` dispatched refuses the repair ("is revoked … no repair") and its diff decision |
| `tests/mandate.test.ts` | grantStanding: the complete status x use x in-flight matrix | 02-17 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): 216 cells; 02-2 and 02-17 drive representative cells through dispatch, cp_send and cp_decide |
| `tests/mandate.test.ts` | after expiry: in-flight review, repair, same-kind promotion and failed-job continuation go on; fresh dispatch and kind changes never | 02-17 | mapped | after expiry `fresh` and the risk:high `risky` are refused with no risk ask; `old`'s promotion and repair continue; a newer active grant speaks for `fresh`; negative control NC-23. Kind changes and the failed column: the retained matrix |
| `tests/mandate.test.ts` | after expiry: risk:high still gates the continuation; a newer expired grant without repair refuses it; a revoked-only project never refuses dispatch | 02-17 | retained | moved verbatim by P3 (P2e review) to `tests/decide.test.ts` (owned by P10), test of the same name: no scenario promotes a risk:high job under an expired grant, stacks two expired grants, or dispatches beside only a revoked grant |
| `tests/mandate.test.ts` | a reviewer start keeps its pre-rule path under an expired grant: no fleet record, review not allowed, cap reached all pass; paused and revoked still refuse | 02-17 | retained | moved verbatim to `tests/decide.test.ts` (owned by P10): a cp_review start needs a pushed PR head no authority scenario has; 02-17 pins the expired grant's repair and diff decision |
| `tests/mandate.test.ts` | an expired grant decides diff and merge for an in-flight job, never a ship; every other rule still binds | 02-17 | mapped | cp_decide approves `old`'s diff under the expired grant ("expired grant continues in-flight") and refuses its ship "has expired"; 02-17 fails on either if the expiry rule is reverted. Merge and the other rules: the retained row below |
| `tests/mandate.test.ts` | an expired grant decides diff and merge for an in-flight job: merge, risk:high, caps, ask_on merge, exclusions, allowed actions and multi-grant ordering | 02-17 | retained | moved verbatim by P3 (P2e review) to `tests/decide.test.ts` (owned by P10), test "an expired grant decides diff and merge for an in-flight job, never a ship; every other rule still binds": no scenario stacks grants on an expired continuation |
| `tests/mandate.test.ts` | a project-wide grant covers follow-on jobs in the project; explicit job_ids still narrow it | 02-1 | mapped | a scoped grant speaks only for the jobs it names; an unnamed job takes the project-wide grant (02-12) |
| `tests/mandate.test.ts` | cp_escalate caps option text and preserves the original consequence | 02-16 | mapped | a 300-character consequence is stored as 200 ending "…", the original kept, and the result names "trimmed fields: options[0].consequence" |
| `tests/mandate.test.ts` | cp_mandate objective ref is verified into a job but never pins the grant; explicit job_ids and sentinel still narrow | 02-16 | mapped | "fix issue #17" mints a job noted 'issue open "real bug"' and the grant has no job_ids; the sentinel grant keeps its ids |
| `tests/mandate.test.ts` | cp_mandate issue: an objective issue ref that gh reports as a PR refuses before any grant is written | 02-16 | mapped | "fix issue #18" (an open PR) is refused "is a pr, open" with one conflicting_acceptance ask; only the two good issues wrote a grant |
| `tests/mandate.test.ts` | cp_mandate issue refuses an archived project before any grant is written | 02-16 | mapped | an archived `attic` is refused "archived project(s) attic" with no grant written |
| `tests/mandate.test.ts` | a revoked grant that was cap-paused never refuses dispatch; the newer active grant covering the job decides | 02-17 | mapped | `shadow`'s spend-capped, revoked grant keeps pause_reason spend_cap and the newer grant dispatches it |
| `tests/mandate.test.ts` | token caps count non-cached tokens only, past the issue-time baseline, in evaluation and in show | 02-13 | mapped | 50M cache reads count nothing; show reads "10001 / 30000 non-cached tokens" past baseline 10100; negative control NC-18 |
| `tests/mandate.test.ts` | a token cap is the parent's to raise within the ceiling; the USD cap never is | 02-4 | mapped | raise_tokens resumes the grant inside the ceiling and is refused past it; the USD cap never moves (02-4, 02-13) |
| `tests/mandate.test.ts` | path and subsystem exclusions match original-task text | 02-15 | mapped | tasks naming src/legacy, billing and services/api/.env leave the checkpoint pending under the selected grant |
| `tests/mandate.test.ts` | high risk is permitted only when ask_on omits it and the objective names the job | 02-15 | mapped | risk:high with ask_on [merge] and an objective that does not name the ship stays pending; once the objective names it, it is decided "risk high named in objective" |
| `tests/mandate.test.ts` | assertDispatchAllowed: risk:high under ask_on refuses a direct dispatch and raises one escalation; an operator-quoted decide then lets it proceed | 02-3 | mapped | each job gets its own ask; the approved one dispatches, the other stays refused |
| `tests/mandate.test.ts` | assertDispatchAllowed: risk:high answered 'drop' stays refused — drop is not authorization | 02-3 | mapped | `dropped`'s ask answered drop; its next dispatch is still refused under ask_on |
| `tests/mandate.test.ts` | assertDispatchAllowed (6B-T3): one approved batch authorizes every listed job, promotion included; drop refuses them all; an open batch is named, never duplicated | 02-11 | mapped | an approved batch dispatches its jobs; an already-batched job is refused naming the open batch; drop: 02-3 pins a dropped answer staying refused |
| `tests/mandate.test.ts` | assertDispatchAllowed: risk:low and a mandate without risk:high in ask_on dispatch untouched | 02-9 | mapped | a recorded low previews no mandate_gate; a grant with ask_on [] dispatches its job (02-1) |
| `tests/mandate.test.ts` | wouldAskRiskHigh: dry-run predicate matches the gate without raising anything | 02-9 | mapped | the dispatch preview says "would ask: risk:high" where the dispatch asks, and raises nothing |
| `tests/mandate.test.ts` | risk:high gate: read-only planning is exempt; ship, writing profiles, promotions and scripts still ask | 02-6 | mapped | a read-only planner job under ask_on risk:high previews no mandate_gate, and an ops job never is exempt; scripts and promotions still ask (02-10) |
| `tests/mandate.test.ts` | evaluateAuthority: the scaffolded **/.env* exclusion actually refuses .env paths | 02-15 | mapped | a task naming services/api/.env stays pending under the scaffolded exclude_paths; the clean task, with no .env path, is decided |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: an open issue named as a bare #N mints one job with the full url | 02-16 | mapped | "fix issue #17" mints https://github.com/o/infra/issues/17, "#33" mints issues/33, and "fix #17 again" reuses the #17 job |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: a merged PR named as #N refuses and escalates once | 02-16 | mapped | "fix #19" (a merged PR) is refused "is a pr, merged" twice; one conflicting_acceptance ask names it |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: no bare ref, more than one project, or a non-GitHub remote is quietly undefined | 02-16 | mapped | "fix #17" over two projects and on demo's local remote issue grants, call no gh and mint nothing |
| `tests/mandate.test.ts` | extractBareIssueRef: a PR-labelled #N is prose, never issue intake; a real bare ref beside it still resolves | 02-16 | mapped | the eight PR-labelled texts and the two APR texts call no gh; "fix #36 despite PR #7" and "despite PR #7, fix #37" verify #36 and #37, never #7; "see o/infra#21" mints issues/21 |
| `tests/mandate.test.ts` | extractBareIssueRef: only explicit issue-task contexts count; incidental status numbers do not (b-qbi.2) | 02-16 | mapped | the three incidental texts (#220, "cp-jxqp #3 of 5") call no gh; each of the eight explicit forms verifies its own number once, and "after #220 merged, fix #35" verifies #35 |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: incidental #N never verifies; fix issue #N verifies exactly once | 02-16 | mapped | gh's log has no call for prose and exactly one per new ref; an existing issue job is reused unverified |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: an explicit issue context naming a PR still refuses as wrong kind | 02-16 | mapped | "fix issue #18" is refused "is a pr, open" |
| `tests/mandate.test.ts` | resolveMandateObjectiveRef: PR prose never calls verifyRef, creates nothing, raises nothing | 02-16 | mapped | thirteen prose objectives leave gh's log, the ledger and the open asks unchanged |
| `tests/mandate.test.ts` | schedlater S3: covers matrix — a schedule grant covers only its own schedule's jobs, any other grant no scheduled job | 02-12 | mapped | schedule-only grants leave the project-wide grant selected; a scheduled job speaks only through its schedule's grant |
| `tests/mandate.test.ts` | S3 (T3.1): issue takes a code-only id and schedule_fire; a taken or unsafe id is refused; cp_mandate exposes neither | 02-16 | redundant-unreachable | no caller passes an id or schedule_fire: no fire mints a grant (`tests/schedule-grant.test.ts`, "PR4: no fire mints a grant"), and cp_mandate has no such parameter. 02-16 pins cp_mandate issue minting its own md- id. Standing rule 3 (ask-0088e0332d00) |
| `tests/actions-ci.test.ts` | paths: exact head, explicit repo or gh placeholders, attempt-bound jobs; malformed ids refused | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: malformed ids do not reach the validated consumer; 05-1 pins the exact-head path |
| `tests/actions-ci.test.ts` | readActionsCi: normalizes runs with identity, event, actor and their attempt's jobs and steps | 05-4 | retained | verbatim in `tests/main-ci.test.ts`, convert owner P3c-rest. Missing entry point: inspect the full normalized run/job/step records through a public parent tool; 05-11 exposes filtering outcomes rather than these raw records. |
| `tests/actions-ci.test.ts` | readActionsCi: zero runs is an observation; two runs with one workflow name both survive | 05-1 | mapped | 05-1's 101 runs all share the workflow name `ci`; collapsing them by name loses run 101 and "ci: failed … (run 101 …)" fails. Zero runs: 05-2 asks for workflows only after an empty runs read |
| `tests/actions-ci.test.ts` | readActionsCi: a null run status is unfinished, never success | 05-1 | mapped | a null-status run on the head: `doesNotMatch(/ci: green/)` fails if null reads as success |
| `tests/actions-ci.test.ts` | pagination: runs and jobs pages are followed to the short page; a boundary duplicate counts once | 05-1 | mapped | two runs pages with the boundary run repeated, and run 1's 101 jobs: stopping at page one fails "ci: failed … (run 101 …)", counting the duplicate twice fails it as incomplete |
| `tests/actions-ci.test.ts` | fail closed: a short read, conflicting duplicate, page cap or API ceiling is incomplete, never a subset | 05-1 | mapped | each case asserts `next: retry` and its own "read incomplete" cause; a subset taken as complete fails `next: retry` |
| `tests/actions-ci.test.ts` | fail closed: malformed bodies, missing identity and a mixed head are malformed | 05-1 | mapped | the seven runs bodies each assert `read malformed` and `next: retry`; skipping the bad row fails `next: retry` |
| `tests/actions-ci.test.ts` | parseJobsPage: a job from another run, attempt or head is malformed | 05-1 | mapped | the three job pages assert "not of the run", "not of attempt 1" and "requested head"; accepting the foreign job fails `next: retry`. The upper-case head: a run whose `head_sha` gh returns in upper case asserts "ci: green"; a case-sensitive compare (`headSha !== sha` in `parseRunsPage`, `src/actions-ci.ts:158`) fails `assert.match(upper.text, /ci: green/)` with "Actions CI read malformed: … (run 1 is not on the requested head) … Nothing was merged" (run by P3b: `npm run test:one -- --test-name-pattern="a denied, rate-limited" tests/e2e/landing.test.ts`, 0 pass, 1 fail) |
| `tests/actions-ci.test.ts` | jobs read failure fails the whole observation: no run-only green | 05-1 | mapped | a jobs 502, 404 or rate limit beside a green run asserts `next: retry`; a run-only green fails it |
| `tests/actions-ci.test.ts` | errors: denial stays classifiable as unreadable CI; rate limit does not; raw output never carried | 05-1 | mapped | the runs 403 asserts the Actions-only label after one call, the rate limit asserts no label, and no record carries `canary`; each fails if its rule is dropped |
| `tests/actions-ci.test.ts` | retry: a truncated body recovers on retry; a persisting one is one malformed fault with status and preview | 05-1 | mapped | "ci: green" after exactly two runs calls fails without the retry; the HTML 200 asserts "not JSON; gh exit 0; body … [redacted] …; 3 attempts" |
| `tests/actions-ci.test.ts` | retry: an HTML 403 is a transport fault with its status and body, never a token denial; JSON 403 is denied | 05-1 | mapped | NC-24: the HTML 403 reads as denied and its `read transport … status 403` match fails |
| `tests/actions-ci.test.ts` | retry: never past the budget, and a structurally wrong JSON page is not retried | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: exact budget requires the injected clock; 05-1 pins one malformed read without retry |
| `tests/actions-ci.test.ts` | budget: one total deadline across pages, each request gets only what remains | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: exact remaining deadlines require the injected clock |
| `tests/actions-ci.test.ts` | readActionsJobs: one attempt's jobs, all pages, through the same validation | 05-4 | mapped | the rerun's own jobs read: a denied, short, empty or unparseable listing asserts "run 41 jobs unreadable" and no rerun or claim; skipping the validation reruns and fails `[reruns(), claims()]` |
| `tests/actions-ci.test.ts` | statusRunner: forwards each request's remaining budget as timeoutMs; a non-zero status throws | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: per-request timeout forwarding lacks consumer sensitivity proof; 05-1 pins nonzero read failure |
| `tests/ci-access.test.ts` | ciReadDenied: only a permission refusal of a CI read counts | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: check-runs, commit-status, PR-read and gh-run classifier inputs remain protected; 05-1 pins Actions denial |
| `tests/ci-access.test.ts` | the browser mirrors the backend's Actions-only label and advice, keeping its needs prefix | 05-1 | retained | verbatim in `tests/main-ci.test.ts`: source parity with the viewer is not exercised by landing; 05-1 pins the integrate label |
| `tests/ci-access.test.ts` | a held job whose CI read was refused names the token as its wait reason, before any head is known | 05-1 | mapped | after the CI watch tick writes `last_ci: unreadable`, the `/status` table's "waiting on: CI unreadable (token)" fails without the unreadable branch in `waitReason` |
| `tests/ci-access.test.ts` | doctor ci.<project>: workflows, then the newest run and its attempt jobs; each outcome is distinct and gh output is never echoed | 05-3 | mapped | the exact gh call sequence (`o/denied` registered as an https `.git` URL, `o/bare` as an ssh URL), each project's severity and text, and no `sentinel-credential-value` in the report; a denied jobs read read as unknown fails the `locked` row. No gh on PATH: a second `/doctor` asserts no `ci.*` finding ("no gh: host.gh says so"); dropping the ENOENT check (`&& false` on the `gh_missing` return, `src/ci-access-doctor.ts:70`) fails `deepEqual(…, [], "no gh: host.gh says so")` with an extra `ci.denied` warn "CI state unknown for o/denied: the Actions read failed (command_failed)" (run by P3b: `npm run test:one -- --test-name-pattern="doctor ci" tests/e2e/landing.test.ts`, 0 pass, 1 fail) |
| `tests/ci-access.test.ts` | doctor ci.<project>: a jobs list shorter than its total_count is unknown, never readable | 05-3 | mapped | NC-26: `o/short` reads ok and its [warn, "the Actions read failed (incomplete)"] assertion fails |
| `tests/ci-configured.test.ts` | only an authoritative empty workflow list is 'no CI configured' | 05-2 | mapped | the empty list asserts `none (authoritative_empty)`, "reports 0 Actions workflows" and the permission read; reading it as unreadable fails `permission: permitted` |
| `tests/ci-configured.test.ts` | a repository that has workflows is 'present', however few runs it has produced | 05-2 | mapped | one workflow with no runs asserts "present (workflows_present) — the repository has 1 Actions workflow(s)" and the human checkpoint |
| `tests/ci-configured.test.ts` | every way of not getting an answer is unreadable, and each is its own cause | 05-2 | mapped | NC-25: the truncated page reads `none` and its `[step, next]` = `[authorize, surface]` fails; the other nine assert their own cause |
| `tests/ci-configured.test.ts` | the workflows question is one gh call, with gh's own owner/repo placeholders | 05-2 | mapped | every advance asserts exactly one `api repos/{owner}/{repo}/actions/workflows` |
| `tests/ci-configured.test.ts` | ghCiConfigured maps a throwing runner onto the same rule, 403 included | 05-2 | retained | moved verbatim to `tests/merge-ask.test.ts` (P3b): the throwing runner is the merge-ask awaiting row's `ciConfigured`, which no landing case renders. 05-2 pins the same rule, 403 included, through cp_integrate's status runner |
| `tests/ci-infra-rerun.test.ts` | classifyInfraFailure: setup steps are infra; the suite and a cancel are not | 05-4 | retained | verbatim in `tests/main-ci.test.ts`: Set up job, Set up Node and Install dependencies still lack separate failure evidence |
| `tests/ci-infra-rerun.test.ts` | an infra-only failure is claimed first, then rerun once; the same job+head never again | 05-4 | mapped | the claim is on disk when `gh run rerun` runs ("the claim was on disk before gh run rerun ran"), then "was spent at" and no second rerun; claiming after the rerun fails the first |
| `tests/ci-infra-rerun.test.ts` | attempt 2, a test failure, a cancel, no run id, a green head and a drain all leave it to the parent | 05-4 | retained | verbatim in `tests/main-ci.test.ts`, convert owner P3c-rest. Missing entry point: send a green head or a run without an id into the infra-rerun policy through cp_integrate; earlier CI evaluation and Actions validation handle these inputs. 05-4 pins the reachable attempt-2, suite, cancel, timeout and drain outcomes. |
| `tests/ci-infra-rerun.test.ts` | fail closed: an unreadable claim file or jobs listing reruns nothing; a refused rerun keeps its claim | 05-4 | mapped | the corrupt claim file asserts "unparseable"; the denied, short, empty and unparseable listings assert "run 41 jobs unreadable" with no rerun or claim; gh's refusal asserts "claimed … but gh refused" and one claim, then "was spent at" |
| `tests/after-merge.test.ts` | a merge into the deploy branch creates one blocked ops:deploy job with a frozen task file, never dispatched | 05-5 | mapped | cp_merged on a merged PR asserts exactly one deploy job with every label, `blocked_by` the merged job, `open`, its task file note and facts, the created line, the `created` record, one `after_merge_deploy` event and no fleet record; `previewDispatch` asserts profile `ops` and risk `high`, and the project-wide grant's preview asserts "would ask: risk:high". Dropping the hook fails "exactly one deploy job" |
| `tests/after-merge.test.ts` | re-recording and a crash before the record write resume onto the same single job | 05-5 | mapped | a second cp_merged asserts no `after_merge` line; with the record removed it asserts "after-merge deploy <same id> created"; after the deploy job is dropped it asserts one deploy job ("a closed deploy job still holds the key"). Creating a second job fails that count |
| `tests/after-merge.test.ts` | base mismatch, missing base and a pre-opt-in merge write skipped and create nothing; no opt-in is silent | 05-5 | mapped | gh answers base develop, no base and a 2020 `mergedAt`: each asserts its reason line, a `skipped` record and no deploy job (NC-31: dropping the opt-in date rule fails `before opt-in`); the project with no opt-in asserts no `after_merge` and no record file. Creating on a mismatch fails `["skipped", 0]` |
| `tests/after-merge.test.ts` | coverage: a named grant listing the merged job enrolls the deploy; at its cap it is refused; project-wide covers | 05-5 | mapped | real grants via the mandate store: the named grant asserts "enrolled in", its `job_ids` and `coverage: enrolled`; the capped grant "job cap 1 reached" and `none`; project-wide "covered by project-wide" and `project_wide`; the research exclusion `none`. Enrolling past the cap fails the capped `job_ids` |
| `tests/after-merge.test.ts` | a ledger refusal throws and writes no record, so the merge store names it and a retry can still create | S06-2 | mapped | real ledger corruption now reaches the failure through recordMerge, leaves no deploy record and retries successfully; S06-deploy mutation fails this consumer. |
| `tests/landing-proof.test.ts` | landed: merge, multi-commit squash, rebase onto an advanced base and a later edit, all with the branch deleted | 05-7 | mapped | cp_teardown on held local jobs asserts `landed_by_git` with `ancestry` for the merge commit, `path_tree` with 3 paths, origin's own base sha and a witness reachable at or after the squash for the two-commit squash and later edit, and the replayed commit as the rebase's witness; one `teardown_landing_proven` event each. The worktree never fetched the squash, so a proof that does not fetch the base by sha reads unknown and fails `landed_by_git`. The read-only runner guard runs with the units in `tests/forge-runtime-retained.test.ts` |
| `tests/landing-proof.test.ts` | landed: path names with spaces, newlines and pathspec magic are compared literally | 05-7 | mapped | NC-30: without `:(literal)` the glob `star*[ab].txt` also compares origin's own `starXa.txt`, and the odd-paths job fails `landed_by_git` as `unpushed` |
| `tests/landing-proof.test.ts` | not proven: partial, near-miss and extra content never pass | 05-7 | mapped | six labelled path near misses assert unpushed. The added post-squash extra commit remains unlanded assertion compares [false,unpushed]; control L1 derives paths through HEAD^ (ignoring the final commit) and fails it with [true,undefined], reason landed_by_git. Exact patch and command below; fixed case passes |
| `tests/landing-proof.test.ts` | not proven: a stale tracking ref that held the squash is not the base origin advertises | 05-7 | mapped | the worktree's `origin/main` holds the squash while origin's main was reset past it: teardown asserts `unpushed` with "survives here only as a stale remote-tracking ref". A proof based on the tracking ref finds the squash and passes it |
| `tests/landing-proof.test.ts` | unknown: missing inputs, broken commands, odd history and every budget keep the lease | 05-7 | retained | moved verbatim to `tests/forge-runtime-retained.test.ts` (P3b, relocated S06): each case bends one git answer (unreachable origin, failed fetch, shallow clone, two merge bases, a hung command) or injects a limit or clock, and no entry point exposes those seams. 05-7 pins the reachable outcomes: landed or `unpushed` |
| `tests/landing-proof.test.ts` | defaultGit kills a git that outlives its timeout and answers status null | 05-7 | retained | moved verbatim to `tests/forge-runtime-retained.test.ts` (P3b, relocated S06): a git that hangs past its timeout needs an injected alias no entry point runs |
| `tests/landing-proof.test.ts` | the pre-release recheck refuses a proof whose HEAD moved or whose tree went dirty | 05-7 | retained | moved verbatim to `tests/forge-runtime-retained.test.ts` (P3b, relocated S06): the window between the proof and the lease release is inside one teardown call, which no entry point can interleave a write into |
| `tests/merges.test.ts` | a merged PR is recorded from what gh reports, and the pr receipt becomes merged | 05-5 | mapped | P3c control M1 flips head_branch_deleted: the receipt tuple at landing.test.ts:760 fails, actual false versus expected true. Reproduce with the M1 patch and command in P3b review controls below; fixed case passes |
| `tests/merges.test.ts` | picp-d0p: a bound job's receipt names the PR head branch and is marked bound | 05-5 | mapped | a seeded fleet record with `bound_pr` and branch `cp-b55w` asserts `head_branch` `cp-b55w` and `bound: true` in the result and on disk. Comparing the job id instead of the bound branch fails it as "not this job's delivery" |
| `tests/merges.test.ts` | nothing is recorded for a PR gh does not call merged | 05-5 | mapped | NC-28: an open PR is not refused, and its "as open, not MERGED" match fails. The no-merge-commit and other-branch answers assert their refusals, no receipt and the PR receipt still `open` |
| `tests/merges.test.ts` | an unreachable gh refuses and names force as the honest exit | 05-5 | mapped | P3c control M2 removes force fallback advice: assertion force stays the exit for the unprovable case fails, expected /cp_teardown <job> force/. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | a job with no PR receipt must be told which PR, and an unknown job is refused | 05-5 | mapped | P3c control M3 defaults a missing PR to 77: /carries no PR receipt/ fails, actual could not read PR 77. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | an unreadable receipt is no receipt, never an exception out of a gate | 05-5 | retained | preserved in tests/forge-observers-retained.test.ts: missing and unsafe ids cannot pass fleet validation to the receipt reader. |
| `tests/merges.test.ts` | forge PR 2: a GitLab squash MR is recorded with its squash commit, provider and project, never through gh | 05-6 | mapped | P3c control M4 drops squash strategy inference: MR 7 receipt tuple fails, actual unknown versus expected squash. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | forge PR 3: a GitLab normal merge records its merge commit, never infers a strategy, and asks git nothing about reachability | 05-6 | mapped | MR 10 (merge and squash commits) asserts the merge commit, the source head, base `main` and `squash`; MR 11 (merge commit only) asserts strategy `unknown`. Both merge commits are absent from origin, so asking git for reachability would refuse them |
| `tests/merges.test.ts` | forge PR 2: a GitLab fast-forward MR records its head only when git sees it on the target | 05-6 | mapped | NC-29: MR 9's head is not on origin and must be refused ("names no merge commit"); once origin's main is that head it records it with strategy `unknown` and the PR receipt `merged` |
| `tests/merges.test.ts` | forge PR 2: a stored receipt for another job or branch is refused, and a crash before the fleet patch is repaired | 05-6 | mapped | P3c control M5 skips repairing an existing receipt: actual [false,false,open,1], expected [false,true,merged,1]. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | forge PR 2: a mismatched observation records nothing, and a legacy receipt with no forge block still reads | 05-6 | mapped | P3c control M6 drops the GitLab web_url repository check: /could not read PR .*\(mismatch: / fails, actual merged but names no merge commit. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | #326: afterRecorded runs on new and existing receipts; a throwing port leaves the receipt and names the failure | S06-2 | mapped | real ledger corruption preserves receipt, names deploy failure and retry, then quiet idempotent replay; 05-5 covers no opt-in. S06-deploy mutation fails the actual call. |
| `tests/ci-watch.test.ts` | a held delivery:pr job with an open PR receipt is watched | 05-S02-1 | mapped | S02 declaration 1; eligible delivery emits ci_green; NC-S02-eligibility bypasses the shared predicate and fails checked exclusion. |
| `tests/ci-watch.test.ts` | waiting, done and failed jobs are not watched | 05-S02-1 | mapped | S02 declaration 2; each phase makes no forge request; NC-S02-eligibility fails checked excludes waiting. |
| `tests/ci-watch.test.ts` | delivery local and pipeline are not watched | 05-S02-1 | mapped | S02 declaration 3; NC-S02-eligibility bypasses the shared eligibility predicate and fails checked exclusion. |
| `tests/ci-watch.test.ts` | a held job with no PR receipt is not watched | 05-S02-1 | mapped | S02 declaration 4; NC-S02-eligibility bypasses the shared eligibility predicate and fails checked exclusion. |
| `tests/ci-watch.test.ts` | the set drains itself: a merged or landed PR receipt is not watched | 05-S02-1 | mapped | S02 declaration 5; NC-S02-eligibility bypasses the shared eligibility predicate and fails checked exclusion. |
| `tests/ci-watch.test.ts` | a job whose envelope slot was reopened by a promote is not watched | 05-S02-1 | unreachable | S02 declaration 6 stays verbatim here: FleetStore rejects held without reported_at before ciTick reaches isWatched, including legacy disk seeding. A promotion changes phase to waiting; that reachable outcome is pinned by 05-S02-1. Last range owner must preserve this unit on whole-file retirement. |
| `tests/ci-watch.test.ts` | all runs completed green on the current head derives exactly one ci_green | 05-S02-2 | mapped | S02 declaration 7; success plus skipped emits one current-head green; NC-39 suppressing green fails the green event assertion. |
| `tests/ci-watch.test.ts` | rerunwake-12z: the derived key carries the attempt, and stays historical without a run id | 05-8 | unreachable | S02 declaration 8 stays verbatim here: attempts are pinned by NC-32 and 05-8, but Actions parsing rejects id-less runs before the legacy-key helper input reaches a consumer. Last range owner must preserve this mixed unit. |
| `tests/ci-watch.test.ts` | one unfinished run on the head emits nothing — the aggregate rule | 05-S02-2 | mapped | S02 declaration 9; NC-S02-aggregate fails one unfinished workflow defers the aggregate. |
| `tests/ci-watch.test.ts` | a green run on a superseded sha with none on the current head emits nothing | 05-S02-2 | mapped | S02 declaration 10; NC-S02-superseded relabels a stale raw Actions response and fails a superseded green is no verdict. |
| `tests/ci-watch.test.ts` | a completed non-green run on the current head derives ci_failed, never ci_green | 05-S02-2 | mapped | S02 declaration 11; NC-S02-red suppresses red and fails its observation count, actual 0 versus expected 1. |
| `tests/ci-watch.test.ts` | a merged PR derives pr_merged carrying the merge commit, and no CI event | 05-S02-2 | mapped | S02 declaration 12; NC-S02-terminal fails pr_merged equality with actual pr_closed. |
| `tests/ci-watch.test.ts` | a closed unmerged PR derives pr_closed | 05-S02-2 | mapped | S02 declaration 13; NC-S02-closed fails closed fact count, actual 0 versus expected 1. |
| `tests/ci-watch.test.ts` | zero runs for the branch emits nothing and is not an error | 05-S02-2 | mapped | S02 declaration 14; NC-S02-empty fabricates green and fails no runs is no verdict. |
| `tests/ci-watch.test.ts` | two ticks with identical facts and an observed arrival wake once | 05-8 | mapped | S02 declaration 15; confirmed green is absent on repeat; NC-41 fails an arrived green attempt is not announced again. |
| `tests/ci-watch.test.ts` | sent is not delivered: an unconfirmed fact is sent again after the retry window | 05-S02-3 | mapped | S02 declaration 16; first send, retry-window suppression, same-key resend and one journal event; NC-S02-retry fails one resend preserves identity. |
| `tests/ci-watch.test.ts` | pi-command-post-jua: an unconfirmed fact gets one resend, never a third send | 05-S02-3 | mapped | S02 declaration 17; NC-S02-resend removes resent guard and fails never a third send. |
| `tests/ci-watch.test.ts` | a restart over the same state file does not re-announce a confirmed fact | 05-S02-3 | mapped | S02 declaration 18; NC-S02-restart fails confirmed arrival survives reconstruction. |
| `tests/ci-watch.test.ts` | rerunwake-12z: a re-run that fails again on the same head wakes again | 05-8 | mapped | S02 declaration 19; NC-32 forces attempt 1 identity and fails a new attempt is a new failure even on the same head. |
| `tests/ci-watch.test.ts` | rerunwake-12z: a green re-run after a red attempt wakes | 05-8 | mapped | S02 declaration 20; NC-39 suppresses green and fails a green rerun follows a failed attempt. |
| `tests/ci-watch.test.ts` | rerunwake-12z: a re-run of an already-announced green head is a new fact | 05-8 | mapped | S02 declaration 21; NC-32 forces attempt 1 identity and fails a new attempt is a new failure even on the same head; the same scenario also checks green attempt 4 after confirmed attempt 3. |
| `tests/ci-watch.test.ts` | rerunwake-12z: the same completed attempt polled twice wakes once | 05-8 | mapped | S02 declaration 22; NC-40 removes red arrival deduplication and fails an arrived attempt is not announced again. |
| `tests/ci-watch.test.ts` | rerunwake-12z: a restart over the same run identity does not re-announce | 05-S02-3 | mapped | S02 declaration 23; NC-S02-restart fails confirmed arrival survives reconstruction. |
| `tests/ci-watch.test.ts` | a force-push makes the new head a new key, and does not retract the old one | 05-8 | mapped | S02 declaration 24; NC-S02-key fails pushed-head key includes its current head; NC-S02-history pins historical red facts. |
| `tests/ci-watch.test.ts` | ci_failed, then a force-push, then green: the failure is neither repeated nor retracted | 05-8 | mapped | S02 declaration 25; NC-S02-history fails one journal event per completed attempt before reaching the pushed-green historical count; NC-S02-key pins current-head identity. |
| `tests/ci-watch.test.ts` | a job that leaves the watch set is pruned from the state file | 05-8 | mapped | S02 declaration 26; NC-S02-prune fails finished deliveries leave the watch. |
| `tests/ci-watch.test.ts` | a parked job's row survives the prune but is never ticked; isWatched still excludes it; done rows still prune | 05-S02-1 | mapped | S02 declaration 27; NC-S02-parked fails parked rows survive held-watch pruning; NC-S02-prune pins done pruning and NC-S02-eligibility pins shared exclusion. |
| `tests/ci-watch.test.ts` | every command the watcher builds passes detectCiWait | 05-S02-5 | mapped | S02 declaration 28; actual gh calls contain pulls, runs, attempt jobs and no waits; actual worker bash waits are refused; NC-S02-policy fails blocking_watch refusal in model request. |
| `tests/ci-watch.test.ts` | a query error backs off exponentially and a success resets it | 05-S02-3 | mapped | S02 declaration 29; twelve real failed reads, exact exponential delays through cap, then success resets count; NC-S02-cap fails errors back off exponentially and cap. |
| `tests/ci-watch.test.ts` | a CI read refused for permission records last_ci unreadable until a read succeeds; a network error is unknown | 05-S02-3 | mapped | S02 declaration 30; NC-S02-permission fails last_ci equality, actual unknown versus expected unreadable. |
| `tests/ci-watch.test.ts` | a query that learned nothing does not age the head it did not read (pi-command-post-8ok) | 05-S02-3 | mapped | S02 declaration 31; twelve failed reads keep old observedAt, legacy unresolved head keeps it too; NC-S02-age advances failed-query age and fails failed queries never refresh an unread head. |
| `tests/ci-watch.test.ts` | a missing gh disables the watch, says so once, and emits nothing | 05-S02-4 | unreachable | S02 declaration 32 stays verbatim here: ENOENT disabling and stopped queries are pinned by 05-S02-4, but CommandPost constructs CiWatch without onDisabled, and no public entry point installs that callback. Its exactly-once callback assertion cannot reach a consumer. Last range owner must preserve this mixed unit. |
| `tests/ci-watch.test.ts` | forge PR 3: missing gh stops only the GitHub job; a GitLab MR is still observed, claims no CI while open and wakes once on merge | 05-S02-4 | unreachable | S02 declaration 33 stays verbatim here: local https GitLab checks open, failed, closed and merged states while GitHub stops (NC-S02-gitlab), but this mixed unit also asserts onDisabled callback count. CommandPost supplies no callback, so that sub-assertion has no public entry point. Last range owner must preserve it. |
| `tests/ci-watch.test.ts` | forge PR 3: a GitLab MR maps onto the watch's terminal shape, a failed read is that job's error, and GitHub urls never reach the observer | 05-S02-4 | mapped | S02 declaration 34; NC-S02-gitlab fails the checked list after gh disablement; the scenario also asserts scoped 503 and exact closed/merge payloads. |
| `tests/ci-watch.test.ts` | an announced verdict on an open PR is re-checked at the idle multiplier | 05-S02-3 | mapped | S02 declaration 35; NC-S02-idle fails settled heads use idle cadence. |
| `tests/ci-watch.test.ts` | a job with no verdict yet is re-checked at the base interval | 05-S02-3 | mapped | S02 declaration 36; NC-S02-base fails unfinished heads use base cadence. |
| `tests/ci-watch.test.ts` | a tick that is not due yet is skipped, not queried | 05-S02-3 | mapped | S02 declaration 37; NC-S02-due fails skipped includes job. |
| `tests/ci-watch.test.ts` | an overlapping tick returns the first one's promise: no double query | 05-S02-3 | mapped | S02 declaration 38; NC-S02-overlap fails overlapping ticks query once. |
| `tests/ci-watch.test.ts` | nextDueMs: base, idle multiplier, exponential backoff, capped | 05-S02-3 | mapped | S02 declaration 39; NC-S02-base, NC-S02-idle and NC-S02-cap fail the corresponding public scheduling assertions. |
| `tests/ci-watch.test.ts` | a malformed CP_CI_WATCH_SECONDS falls back to the default, never to off | 05-S02-3 | mapped | S02 declaration 40; NC-S02-env fails watch interval "nope", actual 0 versus expected 60000. |
| `tests/ci-watch.test.ts` | confirming the same key twice is a no-op | 05-8 | mapped | NC-42 disables confirmation deduplication; command below exits 1 at `arrival is idempotent`, actual repeated key, expected [] |
| `tests/ci-evidence.test.ts` | recordForwardedCi: stores source forwarded with its quote; an identical repeat appends nothing | 05-9 | mapped | tool writes verify head, repo, source, quote, ISO timestamp, URL, duplicate suppression and changed-result append; NC-43 fails `an identical forwarded result is stored once`, actual 2 expected 1 |
| `tests/ci-evidence.test.ts` | recordForwardedCi: refuses a short or moved head, a credential-shaped quote or url, and another repo | 05-9 | mapped | real cp_integrate rejects short/stale heads, secret quote, credential/query URLs and mismatched persisted repo, with no refused writes; NC-33, NC-44 and NC-46 fail the superseded-head, invalid-input and repository-binding assertions |
| `tests/ci-evidence.test.ts` | recordForwardedCi: keeps the newest CI_EVIDENCE_KEEP observations | 05-9 | mapped | 52 real tool writes assert the bound and oldest retained quote; NC-47 fails `every bounded forwarded write succeeds`, actual false expected true, because unsliced history exceeds the schema bound |
| `tests/ci-evidence.test.ts` | forwardedCi (viewer): the newest forwarded result for the head only; native rows and other heads are not forwarded | 05-9 | mapped | real /api/jobs over seeded legacy data asserts pending A, green B, unseen/unknown heads and missing file, with unsafe URL stripped; NC-48 fails `viewer ignores native and other-head evidence and strips unsafe URLs`, actual green expected in_progress |
| `tests/ci-evidence.test.ts` | cp_integrate record_ci: needs a verbatim operator quote and the job's current head; stores display-only evidence | 05-9 | mapped | real parent verifies absent head, fabricated quote, superseded head, stored source/quote/repo and native gate; NC-45 fails `forwarded evidence rejects invalid input through the tool`, expected /no known current head/, actual recorded success |
| `tests/parked-ci.test.ts` | parked CI: head A green, then the moved head B pending, then red — each stored for its own head, journaled once | 05-12 | mapped | real parent timer asserts A green, completed idle sweep without another Actions read, B pending then red, and exact head-tagged journal; NC-36 and NC-49 fail green arrival and idle-read assertions |
| `tests/parked-ci.test.ts` | parked CI: a permission denial is loud even after a green; a transient fault is unknown; both back off | 05-12 | mapped | same-head denial replaces green with unreadable/1, moved-head transport fault stores unknown/2; completed sweeps exceed the base interval without re-reading, and faults journal nothing; NC-50–NC-52 and NC-55 fail counter, classification and backoff assertions |
| `tests/parked-ci.test.ts` | parked CI: a resume or re-park during the read drops the observation; merged/closed snapshots read nothing | 05-12 | mapped | NC-53 and NC-54 fail stale-observation and terminal-read assertions; external forge barriers span public resume/re-park, and CLOSED/MERGED snapshots issue no native CI read. |
| `tests/parked-ci.test.ts` | parked CI: a held job reads nothing | 05-12 | redundant-unreachable | The direct held-with-handoff helper input cannot reach the observer: watch candidates must be awaiting_merge, and the fleet schema refuses legacy held parking records before observation. 05-12 pins both boundaries with `a held job is not read by the parked CI timer` and `the public sweep rejects a legacy held parking record before observing CI`; this is not a claimed failing phase-guard control. |
| `tests/awaiting-merge-tick.test.ts` | a lock taken after session_start still sweeps on the next interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: transfer ownership to an already-started parent session. Acquisition occurs only at session_start, before timer registration; release only at session_shutdown. The startup-guard probe passes 05-12 and is not a failing consumer control. |
| `tests/awaiting-merge-tick.test.ts` | session_shutdown clears the startup catch-up and the interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: observe timer callbacks after shutdown while ownership remains held, including before the startup timer fires. Shutdown releases the lock and exits; removing both clears passes 05-12 but fails the retained unit. |
| `tests/foreign-ci-watch.test.ts` | selection: an open job naming a PR in its project's repo, never a closed job, another repo, or a PR this home shipped | S06-1 | mapped | checked is exactly the selected job; deferred remains selected; other repo, issue, closed and own PR are excluded. Removing closed filtering fails checked (S06 selection control). |
| `tests/foreign-ci-watch.test.ts` | green runs on the head give one ci_green, and the next tick gives nothing; runs are asked of the URL's base repo by head sha | 05-10 | mapped | exact ci_green then empty replay; base-repo head query; S06-1 observes operator notice text through real parent RPC/UI output. |
| `tests/foreign-ci-watch.test.ts` | a moved head gives head_moved once, then CI is re-derived for the new head | 05-10 | mapped | head_moved assertion fails under S06 moved-head control; next-head ci_failed carries the new sha. |
| `tests/foreign-ci-watch.test.ts` | a merged PR gives pr_merged and is never queried again; an unreadable PR is reported once and dropped | S06-1 | mapped | 05-10 asserts pr_merged and no later query; S06-1 asserts stopped length 1 for HTTP 404 and subsequent checked empty. |
| `tests/foreign-ci-watch.test.ts` | a failing query backs off and names a cause once; the per-tick cap defers the rest | S06-1 | mapped | HTTP 502 yields one named error, immediate tick checks nothing, forced-due repeat yields no duplicate error; default cap checks 20 and defers job 21. |
| `tests/foreign-ci-watch.test.ts` | the store is a total read: a corrupt file is no memory, and the next write is valid | S06-1 | mapped | corrupt JSON is replaced by the selected job's valid memory, then dispatch reads it and refuses in_progress. |
| `tests/foreign-ci-watch.test.ts` | evidence only: the ports are read-only, the module reaches no merge or wake path, and its query never waits | S06-1 | retained | Static source-import and injected port-key inspection has no runtime product entry point. Unit preserved verbatim in tests/foreign-ci-watch-retained.test.ts; S06-1 pins real no-merge behavior and actual operator evidence notice. |
| `tests/foreign-ci-watch.test.ts` | ghForeignRuns reads Actions runs and attempt jobs on the PR's base repo; an unreadable read never becomes [] | S06-1 | mapped | 05-10 asserts base-repo sha query; S06-1 reaches Actions through real gh, rejects malformed head and HTTP 403 instead of empty runs. |
| `tests/foreign-ci-watch.test.ts` | the reviewer gate waits for CI, then carries its state into the brief; past the timeout it goes ahead with CI unknown | S06-1 | mapped | real worker request contains timed-out CI unknown; disabling timeout fails accepted dispatch (S06 timeout control). Armed real worker gets green; gh ENOENT yields watch-off text; non-reviewers reach ordinary preflight. |
| `tests/foreign-ci-watch.test.ts` | binding (c) holds for the head the reviewer reads: a success recorded for an old head never releases once the PR moved | S06-1 | mapped | 05-10 rejects moved-head dispatch; S06-1 rejects unreadable current head and carries that reason after timeout. |
| `tests/foreign-ci-watch.test.ts` | CommandPost.dispatch arms a waiting reviewer; the armed release (no blockers) re-runs the gate every pass and starts it only once CI completed | S06-1 | mapped | real cp_dispatch writes armed state without fleet or provider request; real scheduler release starts one worker after green and its actual request carries the head's CI. |
| `tests/forge-runtime.test.ts` | an unregistered project keeps gh for GitHub refs and names its GitLab MR failure | S06-3 | mapped | legacy GitHub receipt is recorded_by gh pr view with observed main; unsupported GitLab records nothing and runs no gh. 05-5 covers bare PR numbers. Runtime legacy mutation removes fallback and fails recording. |
| `tests/forge-runtime.test.ts` | a registered GitLab project gets the GitLab observer and its base branch | S06-4 | mapped | 05-6 records the registered GitLab MR through its own API without gh; S06-4's real teardown lands on configured trunk while main lacks the change. Removing projectBaseBranch fails teardown. |
| `tests/forge-runtime.test.ts` | unknown: missing inputs, broken commands, odd history and every budget keep the lease | 05-7 | retained | Preserved in tests/forge-runtime-retained.test.ts. Custom limits, injected clock, hung runner and command stdout bends are not accepted by cp_teardown. 05-7 pins normal git landing and near misses, but does not expose these runner budgets. |
| `tests/forge-runtime.test.ts` | defaultGit kills a git that outlives its timeout and answers status null | 05-7 | retained | Preserved in tests/forge-runtime-retained.test.ts. Product teardown uses fixed production timeouts; it cannot supply alias.hang or a 100ms timeout through its entry point. Keep runner timeout regression. |
| `tests/forge-runtime.test.ts` | the pre-release recheck refuses a proof whose HEAD moved or whose tree went dirty | 05-7 | retained | Preserved in tests/forge-runtime-retained.test.ts. No public barrier between proof generation and the immediate synchronous release recheck; keep dirty/moved proof assertions without mocking internal git. |
| `tests/forge-observers.test.ts` | github observer runs the same gh pr view command and normalizes its answer | 05-5 | retained | tests/forge-observers-retained.test.ts preserves barrel alias identity and injected command/cwd assertions; a product consumer cannot observe export identity or an injected cwd. |
| `tests/forge-observers.test.ts` | github observer names gh failures, non-JSON and missing fields | S06-5 | mapped | actual recordMerge refusals preserve unavailable/invalid/open, first-line cause and no receipt; missing-fields uses a bare PR number. |
| `tests/forge-observers.test.ts` | gitlab observer sends one GET with the token only in PRIVATE-TOKEN, nested path encoded, no redirects followed | 05-6 | retained | tests/forge-observers-retained.test.ts preserves security assertions on RequestInit.signal and exact header keys; server observation cannot inspect the client's AbortSignal. |
| `tests/forge-observers.test.ts` | gitlab states and landing shas: merge, squash, fast-forward, open, closed, locked | S06-5 | mapped | 05-6 asserts merge/squash priority and git-proved fast-forward; S06-5 asserts all four nonmerged states, diff_refs fallback and deleted source identity through receipts/refusals. |
| `tests/forge-observers.test.ts` | gitlab malformed or conflicting answers are named, never an empty success | S06-5 | mapped | all 14 malformed/mismatch/unsupported answer variants refuse actual receipts; HTML and token/body text never reach the error. Conflicting-head mutation fails expected refusal. |
| `tests/forge-observers.test.ts` | gitlab HTTP failures: 401/403/404/429/500 are unavailable with status and static cause only | S06-5 | mapped | Real local HTTP refusals and a registered CP_S06_UNSET_TOKEN credential name assert status, unset-variable diagnostic, no token header and no body/value leakage. review-unset mutation removes that diagnostic and fails its assertion. |
| `tests/forge-observers.test.ts` | gitlab redirects are refused, not followed, and the token is not forwarded | S06-5 | mapped | local HTTPS redirect is refused with HTTP 302; exactly one request, no destination request, no Location/body/token text exposed. |
| `tests/forge-observers.test.ts` | gitlab network errors, timeouts and oversize bodies fail closed without echoing the exception | S06-5 | retained | tests/forge-observers-retained.test.ts preserves custom 5ms timeout, 1024-byte limits and ReadableStream cancellation assertions; no product entry accepts these injected transports/limits. |
| `tests/forge-observers.test.ts` | a foreign or malformed MR reference makes zero requests | S06-5 | retained | Retained verbatim in tests/forge-observers-retained.test.ts for the empty-string guard: CommandPost.recordMerge replaces empty pr with its bound receipt URL before the observer, so cp_merged cannot submit an empty ref to that guard. All nonempty guards, including a registered /gitlab web prefix, now run through recordMerge; review-prefix fails the prefix refusal. |
| `tests/forge-observers.test.ts` | a gitlab.com project sends GITLAB_TOKEN; with none set it reads unauthenticated | 05-6 | retained | tests/forge-observers-retained.test.ts preserves default gitlab.com token selection with injected transport; local HTTPS fixtures use a configured custom token name, never a live public forge. |
| `tests/forge-observers.test.ts` | observerFor: unknown hosts are unsupported with no request; known kinds get their observer | S06-5 | mapped | S06-3 records legacy GitHub and refuses a registered unknown host without gh; 05-6 records GitLab through its API; S06-5 rejects a foreign GitLab reference without a request. review-provider disables the GitLab adapter and fails the expected invalid-answer refusal. |
| `tests/forge-observers.test.ts` | an unreadable receipt is no receipt, never an exception out of a gate | S06-5 | retained | tests/forge-observers-retained.test.ts keeps missing/unsafe receipt-reader inputs; fleet validation rejects unsafe ids before a public caller reaches that helper. |
| `tests/forge-observers.test.ts` | #326: afterRecorded runs on new and existing receipts; a throwing port leaves the receipt and names the failure | S06-2 | mapped | real corrupt deploy ledger preserves the merge receipt, emits retry text, creates no after-merge record, retries once and then yields no after_merge field. 05-5 pins no opt-in and existing receipt handling. Throwing catch mutation fails actual call. |
| `tests/forge-observers.test.ts` | a ledger refusal throws and writes no record, so the merge store names it and a retry can still create | S06-2 | mapped | corrupt real ledger reproduces refusal through recordMerge, preserves receipt, leaves no deploy record and creates exactly one deploy on retry. |
| `tests/held-release.test.ts` | 4B1-T2: releasable keeps only live, idle, not-stopping held ship/pr authors, oldest reported first | S06-6 | retained | Retained verbatim in tests/held-release-retained.test.ts for dead-but-not-reaped selection: CommandPost.dispatch calls manager.reap in makeRoom before releasable, so cp_dispatch cannot present that unit's dead registered worker to the selector. The unit also directly asserts the pre-reap active count and completes an injected shutdown promise; cp_dispatch/cp_send cannot inject a shutdown promise or pause between synchronous selection reads. Public oldest selection and admission are pinned by S06-6. |
| `tests/held-release.test.ts` | 4B1-T2: a script record is never releasable, even one shaped as a held ship/pr author | S06-6 | retained | tests/held-release-retained.test.ts preserves defense in depth for a fleet shape rejected by the public fleet schema; no internal mocking is added. |
| `tests/held-release.test.ts` | 4B1-T2: capacityFree counts only releasable authors as free (dead, busy, stopping never) | S06-6 | mapped | Real CommandPost dispatchQueue.drain at spawn_cap starts queued work by releasing an author; after authors are resumed/working, another job remains queued without a worker. review-capacity returning false fails the queued-worker assertion. |
| `tests/held-release.test.ts` | 4B1-T2: makeRoom — reviewer, below the cap, and nothing releasable all do nothing | S06-6 | retained | Retained verbatim in tests/held-release-retained.test.ts for the gate-reviewer role guard. CommandPost.dispatch with profile gate-reviewer fails assembleBrief with missing original_task before makeRoom; cp_review/cp_gate spawn their reviewer directly, bypassing HeldRelease, and cp_revive requires a fleet record those reviewers do not create. S06-6 pins below-cap author survival and queued refusal when no author is releasable. |
| `tests/held-release.test.ts` | 4B1-T2: makeRoom at the cap releases the oldest author, journals it, and reserves the slot | S06-6 | mapped | real dispatch journals exact victim/for_job, preserves held phase/lease/branch, starts the caller and successfully resumes the released author. Reservation consumption and shutdown are pinned by actual worker requests and revival, rather than fake call counts. |
| `tests/held-release.test.ts` | 4B1-T2: two concurrent makeRoom calls with one releasable author — exactly one wins | S06-6 | retained | tests/held-release-retained.test.ts preserves concurrent direct calls and exactly-one reservation; no public barrier exposes the same artificial one-victim selection race deterministically. |
| `tests/held-release.test.ts` | 4B1-T3(a): a journal failure rejects before any shutdown and leaks no reservation | S06-6 | mapped | an events.jsonl directory makes real journal append fail EISDIR before caller starts; restoring it allows same-job dispatch, exact release event and successful author resume. Removing reservation cleanup makes retry reject duplicate reservation. |
| `tests/held-release.test.ts` | 4B1-T3(b): a shutdown that rejects leaks no reservation and leaves nothing stopping | S06-6 | retained | tests/held-release-retained.test.ts preserves injected shutdown rejection; the real RPC shutdown cannot be made to throw the supplied fake error through a public request. |
| `tests/held-release.test.ts` | 4B1-T3(c): busy flips between selection and re-check — refused, nothing shut down or journaled | S06-6 | retained | tests/held-release-retained.test.ts preserves the getter that flips busy on its second read; production has no await between selection and recheck, so an external request cannot inject that getter race. |
| `tests/held-release.test.ts` | wasReleased: the last lifecycle marker decides | S06-6 | mapped | cp_send restores the released author and records worker_revived; another send reaches that revived process with unchanged pid, while ordinary workers do not need restoration. review-lifecycle returning false fails sending to the released author. |
| `tests/review-context.test.ts` | (1) deleted task file: fork body, head absence, changed precedence, exact SHAs and persisted manifest | 05-S15-C | mapped | C01; both packet and brief inspected through diffReview |
| `tests/review-context.test.ts` | (2) unique basename resolves; duplicate candidates sorted; missing basename unresolved | 05-S15-C | mapped | C02; manifest entries preserve reason and state |
| `tests/review-context.test.ts` | (3) absolute and home paths neither read nor emitted | 05-S15-C | mapped | C03; real git audit excludes cat-file reads; private marker bodies absent |
| `tests/review-context.test.ts` | (4) budget omits entire blob with byte count, used-byte sum and one section per included file | 05-S15-C | mapped | C04; same public fixed-budget boundary with 300000-byte task fixture |
| `tests/review-context.test.ts` | (5) failed blob is unreadable with error; failed merge-base has unavailable manifest, no packet, named pointer | 05-S15-F | mapped | C05; real git process fails at OS boundary |
| `tests/review-context.test.ts` | (6) NUL-containing blob has binary state and byte length; body omitted | 05-S15-C | mapped | C06; same 18-byte fixture |
| `tests/review-context.test.ts` | (7) exact sorted order, sha256 and identical regenerated manifest/body | 05-S15-C | mapped | C07; same head regenerated by real reviewer after packet loss |
| `tests/review-context.test.ts` | (8) sorted consumers capped at five; no grep for changed test file | 05-S15-C | mapped | C08; real git audit checks test-file query exclusion |
| `tests/review-context.test.ts` | (9) brief names SHAs, manifest-first reading and absent-versus-unknown semantics | 05-S15-C | mapped | C09; actual reviewer brief inspected |
| `tests/review-context.test.ts` | (10) cp-c1ur N11: changed sources precede large fixtures; unchanged fork dedup; absent invariants excluded | 05-S15-C | mapped | C10 and C04; known regression preserved through public packet |
| `tests/review-merge-window.test.ts` | complete pass: fixed durable deadline, before/elapsed boundary, replay, restart, head change and equivalent pass | 05-S15-W | mapped | W01; fresh parent reads original deadline without rewriting pass; expired equivalent pass advances; existing real deadline scenario also waits across the boundary |
| `tests/review-merge-window.test.ts` | incomplete/malformed pass and wrong-head equivalence cannot arm a window | 05-S15-W | mapped | W02; actual cp_integrate returns no review_resume_at on all invalid inputs |
| `tests/review-tool.test.ts` | (1) distinct tool names and schemas; retry description; dispatch precondition/error fix; no decided file | 05-S15-T | mapped | T00; actual RPC schemas, refusal and filesystem assertions |
| `tests/review-tool.test.ts` | (2) review/gate are parent-only | 05-S15-P | mapped | T05; external profile read by public dispatch preview; missing expected rejection if review deny is removed |
| `tests/review-tool.test.ts` | (3) valid round-trip plus closed schema rejects injected next | — | retained | tests/review-tool-retained.test.ts; cp_review accepts no caller-supplied DiffVerdict; defensive closed-schema contract; real round-trip also pinned by T01 |
| `tests/review-tool.test.ts` | (4) medium reason reaches relay while next proceeds | 05-S15-T | mapped | T02; actual RPC content lacks medium reason under control |
| `tests/review-tool.test.ts` | (5) helper refuses injected negative file count | — | retained | tests/review-tool-retained.test.ts; cp_review validates stored and generated counts before payload construction; no verdict-input argument |
| `tests/review-tool.test.ts` | (6) combined raw observation, revise receipt and materialized diff input | — | retained | tests/review-tool-retained.test.ts; live cp_review returns wait, then finishes asynchronously; cached and spawn-failure helper paths have no observation; T03 additionally pins reachable materialized subject leakage |
| `tests/review-tool.test.ts` | (7) model-free stat overflow remains valid and has no subject/model | 05-S15-T | mapped | T04; real wide/large branches; fabricated model fails policy assertion |
<!-- /manifest:assertions -->

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

<!-- patch:NC-43 -->
```diff
diff --git a/src/ci-evidence.ts b/src/ci-evidence.ts
--- a/src/ci-evidence.ts
+++ b/src/ci-evidence.ts
@@ -69,1 +69,1 @@
-	if (last && last.result === observation.result && last.operator_quote === observation.operator_quote && last.url === observation.url) return last;
+	if (false && last && last.result === observation.result && last.operator_quote === observation.operator_quote && last.url === observation.url) return last;
```
<!-- /patch:NC-43 -->

<!-- patch:NC-44 -->
```diff
diff --git a/src/ci-evidence.ts b/src/ci-evidence.ts
--- a/src/ci-evidence.ts
+++ b/src/ci-evidence.ts
@@ -59,1 +59,1 @@
-		const hit = SECRET_PATTERNS.find((pattern) => pattern.re.test(text));
+		const hit = undefined;
```
<!-- /patch:NC-44 -->

<!-- patch:NC-45 -->
```diff
diff --git a/extensions/command-post/tools-integrate.ts b/extensions/command-post/tools-integrate.ts
--- a/extensions/command-post/tools-integrate.ts
+++ b/extensions/command-post/tools-integrate.ts
@@ -178,1 +178,1 @@
-				if (!currentHead) throw new Error(`cp_integrate record_ci: ${params.job_id} has no known current head; wait for the CI watch to observe one`);
+				if (false && !currentHead) throw new Error(`cp_integrate record_ci: ${params.job_id} has no known current head; wait for the CI watch to observe one`);
```
<!-- /patch:NC-45 -->

<!-- patch:NC-46 -->
```diff
diff --git a/src/ci-evidence.ts b/src/ci-evidence.ts
--- a/src/ci-evidence.ts
+++ b/src/ci-evidence.ts
@@ -67,1 +67,1 @@
-	if (prior && prior.repo !== input.repo) throw new CiEvidenceError(`${input.jobId}'s CI evidence is for ${prior.repo}, not ${input.repo}`);
+	if (false && prior && prior.repo !== input.repo) throw new CiEvidenceError(`${input.jobId}'s CI evidence is for ${prior.repo}, not ${input.repo}`);
```
<!-- /patch:NC-46 -->

<!-- patch:NC-47 -->
```diff
diff --git a/src/ci-evidence.ts b/src/ci-evidence.ts
--- a/src/ci-evidence.ts
+++ b/src/ci-evidence.ts
@@ -72,1 +72,1 @@
-		observations: [...(prior?.observations ?? []), observation].slice(-CI_EVIDENCE_KEEP),
+		observations: [...(prior?.observations ?? []), observation],
```
<!-- /patch:NC-47 -->

<!-- patch:NC-48 -->
```diff
diff --git a/src/viewer/overview-jobs.ts b/src/viewer/overview-jobs.ts
--- a/src/viewer/overview-jobs.ts
+++ b/src/viewer/overview-jobs.ts
@@ -59,1 +59,1 @@
- const latest = (Array.isArray(list) ? list.map(obj) : []).filter((o): o is Json => o?.source === "forwarded" && str(o.head_sha)?.toLowerCase() === head?.toLowerCase() && Object.hasOwn(FORWARDED_VIEW, str(o.result) ?? "") && timestamp(o.observed_at))
+ const latest = (Array.isArray(list) ? list.map(obj) : []).filter((o): o is Json => o?.source === "forwarded" && Object.hasOwn(FORWARDED_VIEW, str(o.result) ?? "") && timestamp(o.observed_at))
```
<!-- /patch:NC-48 -->

V2 parked-CI controls NC-49–NC-55 use
`npm run test:one -- --test-name-pattern='parked PR timer' tests/e2e/landing.test.ts`.
Each exited 1 at the assertion in its regression row and was restored. NC-54 removes both open-snapshot gates:
the public watch ordinarily excludes terminal snapshots before the observer's defensive guard can see them.
The old direct held-with-handoff helper call is redundant-unreachable: normal watch candidates must be awaiting_merge,
and legacy held parking records violate the fleet schema before observation. Scenario 05-12 pins both outcomes:
`a held job is not read by the parked CI timer` and `the public sweep rejects a legacy held parking record before observing CI`.
These assertions exercise valid lifecycle state and raw legacy disk data; no internal ports are mocked.

<!-- patch:NC-49 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -42,1 +42,1 @@
-		if (prior?.head_sha === head && Number.isFinite(checked) && now().getTime() < checked + wait) return;
+		if (false && prior?.head_sha === head && Number.isFinite(checked) && now().getTime() < checked + wait) return;
```
<!-- /patch:NC-49 -->

<!-- patch:NC-50 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -56,1 +56,1 @@
-			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: ciReadDenied(error ?? "") ? CI_UNREADABLE : "unknown" });
+			store.record(jobId, { ...observed, consecutive_failures: 0, last_error: error, last_ci: ciReadDenied(error ?? "") ? CI_UNREADABLE : "unknown" });
```
<!-- /patch:NC-50 -->

<!-- patch:NC-51 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -56,1 +56,1 @@
-			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: ciReadDenied(error ?? "") ? CI_UNREADABLE : "unknown" });
+			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: "unknown" });
```
<!-- /patch:NC-51 -->

<!-- patch:NC-52 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -56,1 +56,1 @@
-			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: ciReadDenied(error ?? "") ? CI_UNREADABLE : "unknown" });
+			store.record(jobId, { ...observed, consecutive_failures: failures + 1, last_error: error, last_ci: CI_UNREADABLE });
```
<!-- /patch:NC-52 -->

<!-- patch:NC-53 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -52,1 +52,1 @@
-		if (current?.phase !== "awaiting_merge" || current.awaiting_merge?.cycle !== cycle) return;
+		if (false && (current?.phase !== "awaiting_merge" || current.awaiting_merge?.cycle !== cycle)) return;
```
<!-- /patch:NC-53 -->

<!-- patch:NC-54 -->
```diff
diff --git a/src/awaiting-merge-watch.ts b/src/awaiting-merge-watch.ts
--- a/src/awaiting-merge-watch.ts
+++ b/src/awaiting-merge-watch.ts
@@ -154,1 +154,1 @@
-				if (read.snap.state === "open") {
+				if (true) {
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -35,1 +35,1 @@
-		if (snap.state !== "open" || record.phase !== "awaiting_merge" || cycle === undefined) return;
+		if (record.phase !== "awaiting_merge" || cycle === undefined) return;
```
<!-- /patch:NC-54 -->

<!-- patch:NC-55 -->
```diff
diff --git a/src/parked-ci.ts b/src/parked-ci.ts
--- a/src/parked-ci.ts
+++ b/src/parked-ci.ts
@@ -40,1 +40,1 @@
-		const wait = nextDueMs(cadence, { failures, settled: SETTLED.has(prior?.last_ci ?? "") });
+		const wait = nextDueMs(cadence, { failures: 0, settled: SETTLED.has(prior?.last_ci ?? "") });
```
<!-- /patch:NC-55 -->

NC-39 through NC-42 each use their own patch below and this command:
`npm run test:one -- --test-name-pattern='CI watch persists arrival' tests/e2e/landing.test.ts`.
Each command exited 1 at the named assertion; production mutations were restored. Logs are `NC-39.log` through
`NC-42.log` in this job's artifact directory. The restored 05-8 scenario passes all four assertions.

<!-- patch:NC-39 -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -289,1 +289,1 @@
-		return [at("ci_green", { reason: verdict.reason, conclusion: "success" }, identity)];
+		return [];
```
<!-- /patch:NC-39 -->

<!-- patch:NC-40 -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -719,1 +719,1 @@
-			if (announced.has(observation.key)) continue;
+			if (observation.event !== "ci_failed" && announced.has(observation.key)) continue;
```
<!-- /patch:NC-40 -->

<!-- patch:NC-41 -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -719,1 +719,1 @@
-			if (announced.has(observation.key)) continue;
+			if (observation.event !== "ci_green" && announced.has(observation.key)) continue;
```
<!-- /patch:NC-41 -->

<!-- patch:NC-42 -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -463,1 +463,1 @@
-				if (existing.announced.includes(key)) continue;
+				if (false && existing.announced.includes(key)) continue;
```
<!-- /patch:NC-42 -->

<!-- patch:NC-32-attempt-identity -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -322,1 +322,1 @@
-		.map((run) => `${run.databaseId}.${run.attempt ?? 1}`)
+		.map((run) => `${run.databaseId}.1`)
```

<!-- patch:NC-33 -->
```diff
diff --git a/src/ci-evidence.ts b/src/ci-evidence.ts
--- a/src/ci-evidence.ts
+++ b/src/ci-evidence.ts
@@ -53,1 +53,1 @@
-	if (input.currentHead && input.currentHead.toLowerCase() !== head) {
+	if (false && input.currentHead && input.currentHead.toLowerCase() !== head) {
```
<!-- patch:NC-34 -->
```diff
diff --git a/src/foreign-ci-watch.ts b/src/foreign-ci-watch.ts
--- a/src/foreign-ci-watch.ts
+++ b/src/foreign-ci-watch.ts
@@ -282,1 +282,1 @@
-		if (head && entry.head_sha && entry.head_sha !== head) {
+		if (false && head && entry.head_sha && entry.head_sha !== head) {
```
<!-- patch:NC-35 -->
```diff
diff --git a/src/main-ci.ts b/src/main-ci.ts
--- a/src/main-ci.ts
+++ b/src/main-ci.ts
@@ -154,1 +154,1 @@
-	return runs.filter((run) => run.event !== "dynamic" && run.triggeringActor !== undefined && sameLogin(run.triggeringActor, login));
+	return [...runs];
```
<!-- patch:NC-36 -->
```diff
diff --git a/src/awaiting-merge.ts b/src/awaiting-merge.ts
--- a/src/awaiting-merge.ts
+++ b/src/awaiting-merge.ts
@@ -98,1 +98,0 @@
-			observeCi: parkedCiObserver({ home: host.home, fleet: host.fleet, runs: host.runs, read: (record, sha) => readParkedActionsCi(host, record, sha) }),
```
<!-- patch:S07-NC-2 -->
```diff
diff --git a/src/held-continuation.ts b/src/held-continuation.ts
--- a/src/held-continuation.ts
+++ b/src/held-continuation.ts
@@ -175,1 +175,1 @@
-		const lane = this.#deps.fleet.get(jobId)?.project ?? jobId;
+		const lane = jobId;
```
<!-- patch:S07-NC-1 -->
```diff
diff --git a/src/send.ts b/src/send.ts
--- a/src/send.ts
+++ b/src/send.ts
@@ -245,1 +245,1 @@
-				this.#options.mandates.assertPermitted("repair", { jobId: request.jobId, project: record.project, kind: record.kind }, fleet.read().jobs);
+				// S07 negative control: omit repair authority check.
```
<!-- patch:NC-37 -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1302,1 +1302,1 @@
-		const prior = input.step === "conflict" && !!input.headSha && priorRec?.head_sha !== input.headSha ? 0 : (priorRec?.resolve_attempts ?? 0);
+		const prior = 0;
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

<!-- patch:S06-moved -->
```diff
diff --git a/src/foreign-ci-watch.ts b/src/foreign-ci-watch.ts
--- a/src/foreign-ci-watch.ts
+++ b/src/foreign-ci-watch.ts
@@ -282 +282 @@
-		if (head && entry.head_sha && entry.head_sha !== head) {
+		if (false && head && entry.head_sha && entry.head_sha !== head) {
```

<!-- patch:S06-timeout -->
```diff
diff --git a/src/foreign-ci-watch.ts b/src/foreign-ci-watch.ts
--- a/src/foreign-ci-watch.ts
+++ b/src/foreign-ci-watch.ts
@@ -334 +334 @@
-		if (!(now.getTime() < deadline)) return { line: `${target.url}: CI unknown — not completed within ${Math.round(timeout / 60_000)} min of ${job.created_at} (last seen: ${seen}).` };
+		if (false) return { line: `${target.url}: CI unknown — not completed within ${Math.round(timeout / 60_000)} min of ${job.created_at} (last seen: ${seen}).` };
```

<!-- patch:S06-legacy -->
```diff
diff --git a/src/forge-runtime.ts b/src/forge-runtime.ts
--- a/src/forge-runtime.ts
+++ b/src/forge-runtime.ts
@@ -60 +60 @@
-	if (parseChangeRequestUrl(ref)?.kind !== "gitlab") return githubObserver(ports.run, ports.cwd);
+	if (false) return githubObserver(ports.run, ports.cwd);
```

<!-- patch:S06-trunk -->
```diff
diff --git a/src/forge-runtime.ts b/src/forge-runtime.ts
--- a/src/forge-runtime.ts
+++ b/src/forge-runtime.ts
@@ -30 +30 @@
-	return registryEntry(home, project)?.entry.base_branch;
+	return undefined;
```

<!-- patch:S06-conflict -->
```diff
diff --git a/src/forges/gitlab.ts b/src/forges/gitlab.ts
--- a/src/forges/gitlab.ts
+++ b/src/forges/gitlab.ts
@@ -160 +160 @@
-	if (sha && diffHead && sha !== diffHead) return refuse("invalid", "response head sha and diff_refs head disagree");
+	if (false) return refuse("invalid", "response head sha and diff_refs head disagree");
```

<!-- patch:S06-deploy -->
```diff
diff --git a/src/merges.ts b/src/merges.ts
--- a/src/merges.ts
+++ b/src/merges.ts
@@ -172 +172 @@
-			return { ...result, after_merge: `after-merge deploy NOT created: ${first} — cp_merged ${result.receipt.job_id} retries` };
+			throw error;
```

<!-- patch:S06-reservation -->
```diff
diff --git a/src/held-release.ts b/src/held-release.ts
--- a/src/held-release.ts
+++ b/src/held-release.ts
@@ -93 +93 @@
-			if (!transferred) release();
+			if (false) release();
```

<!-- manifest:regressions -->
| ID | Unit file | Bug commit | Scenario | Patch | sha256 | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-01 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-01-green | e5cc55b97d22e820228a709e858fbe2f7294fcc8dce00aa980f63982c09660f3 | wake observation names run 2 (skipped), not run 6 | pass |
| NC-02 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-02-integrate | 0a2c3b3942c839731d201a0a07d8ddf2c6bf6ea2d6163d5a00430568bb3d6e86 | the ci fact does not end with (run 6 …/actions/runs/6) | pass |
| NC-03 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-2 | NC-03-host | 0bb48b55ddc16d72b68109e136da58d310bb118ebbe641f411e9ba7980ef6ac0 | the enterprise ci fact links ghe.example.com/…/actions/runs/16 | pass |
| NC-04 | `tests/budgets.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-4 | NC-04-budgets | b8262869069a8a4a19ff794bf37b176539f3574d54373523f6e0b03804229851 | spawn_cap 11 written after start does not admit `overflow` (spawn cap reached (10/10 workers)) | pass |
| NC-05 | `tests/mandate.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-5 | NC-05-held-slot | 8727a7604f0ea2e0dfd10cdb6ba3cc800ea166fac472807ab43590eb6423fec3 | `second` refused "dispatch-parallelism 1 is full" while the only other job is held | pass |
| NC-06 | `tests/mandate.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-5 | NC-06-held-spend | 6443d0c2c2740f69963160711b17d5578e859d4476d0900a5133f5426bbd8720 | the grant never pauses on token_cap: held + second spend is not counted | pass |
| NC-07 | `tests/ops-jobs.test.ts` | de411ad5bffa75690f8f546a2d8ea50e0354910d | 02-6 | NC-07-ops-gate | d6f1dd6c5c61ba81bbd501bd8a93a96226fef5f00a69e5780ac3e21444ac8ff7 | `risky pull` previews no mandate_gate, expected "would ask: risk:high" | pass |
| NC-08 | `tests/ops-jobs.test.ts` | de411ad5bffa75690f8f546a2d8ea50e0354910d | 02-6 | NC-08-ops-risk | 46a5538a435ffea34d00a22229d29079c987fbe4c764f0f1970ff7dd8092baa7 | a deploy previewed with risk low routes [ops, low], expected [ops, high] | pass |
| NC-09 | `tests/ops-jobs.test.ts` | de411ad5bffa75690f8f546a2d8ea50e0354910d | 02-6 | NC-09-ops-lease | 693734ac1563a6fca17c1fe9be919aabf92cbe8719238a7ba2de1c4651df0e62 | `wanting` dispatches beside a live holder of resource:tg-session (missing expected rejection) | pass |
| NC-10 | `tests/risk-negation.test.ts` | b63fe8457e763e7e4a2b5c31b1be6c12cc235fe7 | 02-7 | NC-10-negation | ce33b2293ec4566920d332b54dccf06d83a2f713f86fb698718f758befca78bb | "no migration" names the risk word migration, expected none | pass |
| NC-11 | `tests/mandate.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-5 | NC-11-held-jobs | b0cd9e923ba17aa39b1e02d55a94369572668e0fcab68794f9371a5b27dad546 | `third` passes the job cap 2 with the held job uncounted and is refused only by dispatch-parallelism | pass |
| NC-12 | `tests/mandate-defaults.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-8 | NC-12-override-order | 330071f2749a42ddfd58350bdaf005f9e7e34e5063a20f1e71428b56e74366a0 | two agreeing overrides in a different key order fall through to home: job_cap 9, home allowed_actions | pass |
| NC-13 | `tests/risk-warning.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-9 | NC-13-low-warning | 0fd26f8d54064ac457da570839006c37ca82a3601f2f033b7dcd39ccb4f09d6b | "Scope M each, risk low." previews would ask: risk:high, expected no mandate_gate | pass |
| NC-14 | `tests/risk-preapproval.test.ts` | 7edb8447adfdbd6032fdd518cac20f70f3bc0ddf | 02-10 | NC-14-hard-stop | e121778390e471657fd0cf50e815e231c1664f6bc9931644106edd16324586a2 | `pushing` ("force push to main", pre-approved) dispatches: missing expected rejection | pass |
| NC-15 | `tests/risk-batch.test.ts` | 0dd627e1af848a754fae094363bc679bd1334b21 | 02-11 | NC-15-batch-duplicates | ba25ec085ebfdd42c570125e4db60a986161a2947fd8191a08d259ef26ad1536 | batch_risk_high with one job id twice files es-… for 2 jobs (cp-…, cp-…) instead of refusing | pass |
| NC-16 | `tests/mandate-selection.test.ts` | 182d661df39ae976d40c0ffe39da603a51762465 | 02-12 | NC-16-issue-order | df65e10f0187be25616ddda1f083fba62776ac831cecc44fd3375400ec1c3b3b | `first` previews under md-000001 (issued later), expected md-a994c5 | pass |
| NC-17 | `tests/mandate-supplement.test.ts` | f4b5ba870f1b53cc5aa03b608443be8f453cfdd0 | 02-12 | NC-17-supplement | 5da1c2239f05459f067ec55ff86387caea4ebe5941c4bc5fd1611ef05036c6cb | `target` previews under the full md-older1, expected the supplement md-supp01 | pass |
| NC-18 | `tests/mandate-usage.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-13 | NC-18-cache-reads | 043260b1680570db9a085e8b5a7971d13dfc39745029ade7fb16443312026225 | 50M cache reads on the first turn pause the grant: notices [token-cap], expected [] | pass |
| NC-19 | `tests/capacity.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-14 | NC-19-capacity-auth | dde6d244107712dfd4cf198267181686bb04111d15c4422569160713c16fc373 | a 401 from the gateway falls back with no `reason=capacity auth rejected` | pass |
| NC-20 | `tests/quota.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-14 | NC-20-quota-tight | f45a2895b0d9c81b69f7f8740c57fc2af3d108e6718475376ed44cb4348787f7 | a 5h window at the 90 threshold is not tight ("90/0") | pass |
| NC-21 | `tests/mandate.test.ts` | 9cba8aa2fe960ac975cd7266e6bc79ffb57d97f0 | 02-15 | NC-21-denied-project | 066c4517d1bbb7a4108205f50dc3d2ac52584324ec11bd40fd61dbaae36729ee | a denied project's plan checkpoint is auto-decided, so the implementer's preflight refuses "project_denied" | pass |
| NC-22 | `tests/mandate.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-16 | NC-22-this-turn-jobs | 9e9711d04c7bea1a95154480de37a9d12f3376c3ce215219e35d9df5a21db086 | the sentinel grant names only the last job created this turn | pass |
| NC-23 | `tests/mandate.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 02-17 | NC-23-expired-repair | e9c69c9bfa7ed2457df70ccb635fc085a15259a9a43611c6865241e17a4d112c | an expired grant refuses its in-flight job's repair: "no first authorization under it" | pass |
| NC-24 | `tests/actions-ci.test.ts` | 2404bb71d2c653c78cb751879d269948be1ffb59 | 05-1 | NC-24-html-403 | e72132413fc99cd02b4f925f8b2c27cb86970f5fd3a97564948945fed2d947d4 | an HTML 403 proxy page reads as the token's denial, not `read transport … status 403` | pass |
| NC-25 | `tests/ci-configured.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 05-2 | NC-25-truncated-empty | 9136f6c7b38762eb24ae90db95957b08018ad14b9ce7ec99a8b64d04f10627ab | a truncated workflows page (total_count 3, no rows) reads `none (authoritative_empty)` | pass |
| NC-26 | `tests/ci-access.test.ts` | 3701ebcf12e77e5f3bac90c498efdd56f0016c19 | 05-3 | NC-26-short-jobs | 8af5a117fa4f3344232b10a82f44e378f4c55de8632e1902025ec529063c119f | `ci.short` with 1 of 4 jobs reads ok "CI readable", expected warn "the Actions read failed (incomplete)" | pass |
| NC-27 | `tests/ci-infra-rerun.test.ts` | 5e1dcaee597b7fb7deb4cbc4a538e104fff214b8 | 05-4 | NC-27-second-attempt | f21876229231409f51b2134f511e2234233fe8acbf75a5f5ae64b03435dcf960 | an infra failure on attempt 2 is rerun, not "a second failure is the parent's" | pass |
| NC-28 | `tests/merges.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 05-5 | NC-28-open-pr | 6895859eab22d32f0a13f2a7240fde11f5e1b66e08c91d5ea07c88b48da41877 | an open PR passes the state rule and reads "merged but names no merge commit", not "as open, not MERGED — nothing is recorded" | pass |
| NC-29 | `tests/merges.test.ts` | 3a27fd9a3c099512e779b3cf36e670efa71c7587 | 05-6 | NC-29-unseen-ff | d1140a88d18614739af2d16a773504d4784ed99314da8cd54762c08e060c9b4d | a fast-forward MR whose head origin's main lacks is recorded: "Missing expected rejection" | pass |
| NC-30 | `tests/landing-proof.test.ts` | 3a27fd9a3c099512e779b3cf36e670efa71c7587 | 05-7 | NC-30-glob-paths | a7c56cdf50d4977e9ffaa5bace6e4d3cead67e685514bea31ae8a86046cba079 | the odd-paths job keeps its lease as `unpushed`, expected `landed_by_git` with `path_tree` | pass |
| NC-31 | `tests/after-merge.test.ts` | 8532dda3b36d59141ef007d6996595ff2f825cbc | 05-5 | NC-31-pre-opt-in | bbd4b95f011b7fc8b6d9eea04c66a1ce7c3d169f9a7cd34abe807a103d40aa12 | a merge from before the opt-in creates a deploy job: "before opt-in" fails | pass |
| NC-32 | `tests/ci-watch.test.ts` | ea631794e9de7491a65d7f4eb49d100635b5c57f | 05-8 | NC-32-attempt-identity | 31b8070cb5bf5755fe50f02b99ec4d0c69af3829ff01b31d1ab3dc1df4807bd8 | `a new attempt is a new failure even on the same head`: actual undefined, expected truthy | pass |
| NC-33 | `tests/ci-evidence.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-9 | NC-33 | f3376f3e6c9824b272c272b574d5dba2f16bf53e3c8bf1536134ef052b5ee267 | expected /superseded head/, instead forwarded success recorded on bbbbbbbbbbbb | pass |
| NC-34 | `tests/foreign-ci-watch.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-10 | NC-34 | 6404b4e7cc8ee8fd7bb6d253758e0727c482bcc8001b938351d9fe9c525e3cca | tick observations: actual [], expected [head_moved] | pass |
| NC-35 | `tests/main-ci.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-11 | NC-35 | f1a2e028adf4e9dcc42aa3f5fb68a4bce417edf303edcd23c081bc12d39f4b0e | timed out waiting for own current-tip green clears latch | pass |
| NC-36 | `tests/parked-ci.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-12 | NC-36 | 160bf6227e64578fad081ed6325566424cfc0a28ad79d50f6538fefc07dca69b | timed out waiting for parked green through extension timer | pass |
| NC-37 | `tests/integrate-held-ci.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-13 | NC-37 | 08885fb069f9156f222db16be799935bbede6b4804a0cdc7344c5bee0bdb6fa1 | a second red result exhausts the repair allowance: actual resolve, expected surface | pass |
| S07-NC-1 | `tests/integrate-held-ci.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S07 | S07-NC-1 | 514a60abe4fb0adfa420e8b12651e3e1641c36ee4446eed0e1bf4e7900347d18 | revoked error expected /is revoked/, actual no live worker; authority must precede worker lookup | pass |
| S07-NC-2 | `tests/integrate-held-ci.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-13 | S07-NC-2 | 7b765ed1addb1bcc787c7fa4ee3995fc74dbb63856ed7a8be661842a55f0e911 | another job in the project waits behind the CI repair: actual advanced, expected queued | pass |
| S07-NC-3 | `tests/integrate-held-ci.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-13 | NC-37 | 08885fb069f9156f222db16be799935bbede6b4804a0cdc7344c5bee0bdb6fa1 | restarted parent reads spent allowance: expected /already asked once/, actual no live worker | pass |
| NC-38 | `tests/awaiting-merge-tick.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-12 | NC-36 | 160bf6227e64578fad081ed6325566424cfc0a28ad79d50f6538fefc07dca69b | RENAME BOOKKEEPING ONLY: NC-36 fails the parked observer-wiring assertion; this is no control for either retained timer unit and earns no retirement credit | pass |
| NC-39 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-39 | 3b171a4343a649cf97b5484d8436b270652f31a73e48043823d6d88cac71728b | a green rerun follows a failed attempt: actual undefined, expected true; exit 1 | pass |
| NC-40 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-40 | 89140ecdb7e179ded4475bbae1fdd8503bc7d6e1c498391bc5373e5cff3175a6 | an arrived attempt is not announced again: actual ci_failed observation, expected []; exit 1 | pass |
| NC-41 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-41 | 3247052c5ba325182bb6bc40b10310d9ba19c3efca12adaaaf82021ae65325e8 | an arrived green attempt is not announced again: actual ci_green observation, expected []; exit 1 | pass |
| NC-42 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-42 | bdf24d76db79fa3de72985fd27fdf823b0e03b824e3f2f3c8b6198f67ffe563b | arrival is idempotent: actual repeated key, expected []; exit 1 | pass |
| NC-43 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-43 | 1ab00c25fcb6f6beec90067b887e04cb604986b936ec84e87529fd74a6acc728 | an identical forwarded result is stored once: actual 2 expected 1; exit 1 | pass |
| NC-44 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-44 | 1e23c1f307c54d5f011114b4e2867c81398446c93168b3e83de3008348700d0c | forwarded evidence rejects invalid input through the tool: expected /github token/, actual recorded success; exit 1 | pass |
| NC-45 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-45 | b56732d87fd1e902de3998d8330d4e596c903c69dfd9a3e538e0289d4c5e4dbc | forwarded evidence rejects invalid input through the tool: expected /no known current head/, actual recorded success; exit 1 | pass |
| NC-46 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-46 | b167ba1c73842346b33fbc3f5a82cba32174d8b356baa6b3abd16cd1cdeb694f | evidence cannot be rebound to another repository: expected `/is for other\/repository/`, actual recorded success; exit 1 | pass |
| NC-47 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-47 | 603dd9661e1e596f888b39eb14b9bdc66078a98709fe8f022402c4b203a7b84c | every bounded forwarded write succeeds: actual false expected true; exit 1 | pass |
| NC-48 | `tests/ci-evidence.test.ts` | be875d50d00f707cf1574e372ac8031f687273cd | 05-9 | NC-48 | 97c3cb3752d2333372ea71e943083cde0d1183a0616689ebe15372ff4800bacc | viewer ignores native and other-head evidence and strips unsafe URLs: actual green expected in_progress; exit 1 | pass |
| NC-49 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-49 | a74f29820429a3edc569e921ad1c59514c3c7a83c52afbee81efe57fcf3d8923 | a settled head is not re-read before the idle interval: actual 2 expected 1; exit 1 | pass |
| NC-50 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-50 | 6b130b6e821c69c5f3300f337dd072c514254db98d8fef7f40783e99db0d1b08 | consecutive_failures assertion: actual 0 expected 1; exit 1 | pass |
| NC-51 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-51 | 377f7f3b0591d09e03c7e9fee7017df96c330e6e449996c2ef3c998e6e8e5210 | permission denial replaces prior green: actual unknown expected unreadable; exit 1 | pass |
| NC-52 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-52 | 5acaec2af379bcfc1e81071685ef44c9dea8e31e54077554cf7a9d8dcbcfe2e8 | a transient fault is unknown: actual unreadable expected unknown; exit 1 | pass |
| NC-53 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-53 | 38f8d8e9b4ee45085a53a7b0ab3bf727bcb6dff132a7f9ccaf91b7725964834d | resume or re-park drops the old cycle's terminal observation: actual false expected true; exit 1 | pass |
| NC-54 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-54 | c659006b3d4f625d0f3ca065766b8a331cfec0d460cefd0b52d73c491be85d74 | merged and closed snapshots do not read native CI: actual 1 expected 0; exit 1 | pass |
| NC-55 | `tests/parked-ci.test.ts` | e49eaa5ba75ddb1976bf1b2b4311f1f683b7cc15 | 05-12 | NC-55 | b982458f1edafa0ef99eb6f9a6e601c82067dbbdffe56318cd15ebc5303b5b13 | a failing head backs off instead of re-reading every sweep: actual 12 expected 6; exit 1 | pass |
| S06-moved | `tests/foreign-ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-10 | S06-moved | 56e133c0e8de4fce2a1efba54419ec2b83ee25d9051291cb54f50420abb87f15 | head_moved observation is empty instead of one moved-head fact | pass |
| S06-timeout | `tests/foreign-ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | S06-1 | S06-timeout | 1869d77ee9e6ea51f37ebd3cff7afbbd562b01a4a7b30e6e81f0afb850d92503 | timed-out reviewer dispatch rejects instead of returning receipt accepted | pass |
| S06-legacy | `tests/forge-runtime.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | S06-3 | S06-legacy | b8d4b63cfb4605d74cd3b15b213e7f7e4df925c3ebb8a2a537ec02997a38b309 | legacy GitHub recordMerge rejects unsupported instead of recording a receipt | pass |
| S06-trunk | `tests/forge-runtime.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | S06-4 | S06-trunk | 786335f44ee49a7b6f0394a0f69f7c497a146c81b7ca221fcd18dcfed9e424b1 | configured trunk teardown refuses rather than landed_by_git on trunk | pass |
| NC-S02-eligibility | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-1 | NC-S02-eligibility | cba3486781d72c3cca30f9264d17af40f63ab3a47c2efab8e09416c8847025ce | checked excludes waiting: actual true, expected false; exit 1 | pass |
| NC-S02-terminal | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-2 | NC-S02-terminal | 29dc07af1d1ab16d4f6886ceaaf483fb20b4aa2f06f90db68d6b381aea34850d | merged event: actual pr_closed, expected pr_merged; exit 1 | pass |
| NC-S02-retry | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-3 | NC-S02-retry | 81f9556674f6127b1151cfbbf5ad25b882f5a05f5cf9bb991f014ab4dfca8e70 | one resend preserves identity: actual [], expected first key; exit 1 | pass |
| NC-S02-resend | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-3 | NC-S02-resend | ea57dd2d42611a0e0a168eae3ec4cf5aa3a1ec528e4948d37bd664e7b4d6c535 | never a third send: actual ci_green, expected []; exit 1 | pass |
| NC-S02-age | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-3 | NC-S02-age | 2b44580427f1d46396495a3412b0e7006ab65b86af9b7321fd8326328187b851 | failed queries never refresh an unread head: actual advanced time, expected prior time; exit 1 | pass |
| NC-S02-cap | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-3 | NC-S02-cap | 26a3f8333daafd2ae8b0f0ebdb46b86714e5133453a2803f04de74af53898f8d | errors back off exponentially and cap: actual 1024000, expected 900000; exit 1 | pass |
| NC-S02-gitlab | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-4 | NC-S02-gitlab | 243b8e9764b768dd710c258168e7a3a8d6162b54d8b167698710b985446f67cb | first checked list omits GitLab; exit 1 | pass |
| NC-S02-policy | `tests/ci-watch.test.ts` | 1648f3c2567c9647b1b4a5e508ac6c211079d4b2 | 05-S02-5 | NC-S02-policy | 8007cb6e4ee2f41fcc853e37340d0573097ea3e87fdba165f0d2b3911c2c8551 | model request lacks blocking_watch refusal; exit 1 | pass |
| NC-S02-restart | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-restart | 2f627246d2e68af424584bd914671e0720e8accd775c1bd0440e0360593d548e | confirmed arrival survives reconstruction: actual repeated green, expected []; exit 1 | pass |
| NC-S02-permission | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-permission | c72f4c390f8cb285b3c27ca4cb05c4bee2201579432d6fa946dafc0caa117a43 | last_ci: actual unknown, expected unreadable; exit 1 | pass |
| NC-S02-idle | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-idle | 62c2effa84c81f6dde53a4139a73d3909a8f1d69b9e942233fcee6287888d395 | settled heads use idle cadence: actual 1000, expected 5000; exit 1 | pass |
| NC-S02-base | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-base | dd476f83e0321681ccb7755264c4ae5054a969deacd15cbb16a6bd623212a959 | unfinished heads use base cadence: actual 5000, expected 1000; exit 1 | pass |
| NC-S02-due | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-due | cde265ae1b61d50448fa8fe1c8f0c9db4bc0307ff96c40f99f7c1a90e34f4779 | assert.ok(skipped.skipped.includes(live.jobId)): actual false; exit 1 | pass |
| NC-S02-overlap | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-overlap | 69fab3003604be320366327f74f921c001279a0b71adece13adaa0b69e480d2b | overlapping ticks query once: actual 2, expected 1; exit 1 | pass |
| NC-S02-env | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-3 | NC-S02-env | 860f168bf79282b1ff9a0286e6856f91742e5db80668b1386f1df9765752ede5 | watch interval nope: actual 0, expected 60000; exit 1 | pass |
| NC-S02-aggregate | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-2 | NC-S02-aggregate | 24c30b1dd9ea6b8326382a9b1941dd7b93b385aaa7b5f7fc549d42ce9efc5d99 | one unfinished workflow defers the aggregate: actual green, expected []; exit 1 | pass |
| NC-S02-superseded | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-2 | NC-S02-superseded | 572fd908ccfd5b8634c69451c2d52332dd88652e7940170c8491992060ad1259 | a superseded green is no verdict: actual green, expected []; exit 1 | pass |
| NC-S02-empty | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-2 | NC-S02-empty | f9ec1ce89ac3a46ce69c5fc60d0fb5a724546d44772172f1d0f76f5653c38a8c | no runs is no verdict: actual green, expected []; exit 1 | pass |
| NC-S02-red | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-2 | NC-S02-red | 5b475ee8fadb9041e50bc177d463b3b18877050d18fd2e7911e9c0292747601b | red observation count: actual 0, expected 1; exit 1 | pass |
| NC-S02-closed | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-2 | NC-S02-closed | 0de66d27f209c0dc36244274c69324d6860e6955d36ceb921197be982a47197e | closed fact count: actual 0, expected 1; exit 1 | pass |
| NC-S02-key | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-8 | NC-S02-key | 0b06ee0819dc98ec73d55c1ae42ff477a48d5520b6fcd4bbad8ce38c1cd6a51d | pushed-head key includes its current head: actual false; exit 1 | pass |
| NC-S02-history | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-8 | NC-S02-history | 0d48c887d1af2446f53577b1f9f6eda249166df3551a841f89b67113726f1214 | one journal event per completed attempt: actual 0, expected 1; exit 1 | pass |
| NC-S02-prune | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-8 | NC-S02-prune | befd614a3c744cb5d70cf0d5506088c7b91e9ec800fa072e9d3e0180f0d4ee92 | finished deliveries leave the watch: actual row, expected undefined; exit 1 | pass |
| NC-S02-parked | `tests/ci-watch.test.ts` | b744b908413b97d7fb9a39ae6056179ec3f8ae07 | 05-S02-1 | NC-S02-parked | 880cf412abeebff72c830b94956bde9fbcea6d2df6625ec90c2de8a93f7134f9 | parked rows survive held-watch pruning: actual undefined, expected head; exit 1 | pass |
| S06-conflict | `tests/forge-observers.test.ts` | 4157663bc336411bac920a7a7fcd0d8dbad4d49e | S06-5 | S06-conflict | 78c301aba9e55b637f3e1af9acda02c4846effe5c065b7adec47d8f5f83c104b | Missing expected rejection for conflicting heads; exit 1 | pass |
| S06-deploy | `tests/forge-observers.test.ts` | 4157663bc336411bac920a7a7fcd0d8dbad4d49e | S06-2 | S06-deploy | 9c2bb5361529d74f70a4713044b66f3ea497e4e615d75ee95cf1a29c078a065a | corrupt ledger exception escapes recordMerge instead of preserving named retry outcome; exit 1 | pass |
| S06-reservation | `tests/held-release.test.ts` | 4157663bc336411bac920a7a7fcd0d8dbad4d49e | S06-6 | S06-reservation | 0a723cad1b905543dda1bcffc250f7677cf6bb8451580d5e5779c674cd65f16d | queue capacity counts a releasable author as free after journal recovery: expected worker, got undefined; leaked reservation prevents retry; exit 1 | pass |
| S15-C10 | `tests/review-context.test.ts` | 66c803bd47a3638e228a4183edd14aa34c647e8a | 05-S15-C | S15-C10 | bda2cbe060162587fea753d9651f19d0201685595492b7edb9a63672159582e5 | unchanged lib/core.py fork unexpectedly included | pass |
| S15-W01 | `tests/review-merge-window.test.ts` | 53d55fb0d144cee0109e0086ad98add0a196e056 | 05-S15-W | S15-W01 | 76fe8e4aee8fad87cbd5a6f9f100ede181f1bbbd6aab1beced777a94cdf5ca00 | fresh pass advances rather than waiting for its window | pass |
| S15-T05 | `tests/review-tool.test.ts` | 53d55fb0d144cee0109e0086ad98add0a196e056 | 05-S15-P | S15-T05 | 96f894ad8f6d5e6615375c7a4900dfa1155c973c18905dfba652195611ffe5c0 | missing expected rejection for a worker profile containing cp_review | pass |
<!-- /manifest:regressions -->

<!-- patch:S15-T05 -->
```diff
diff --git a/src/contracts/workers.ts b/src/contracts/workers.ts
--- a/src/contracts/workers.ts
+++ b/src/contracts/workers.ts
@@ -84,3 +84,2 @@
 	 */
-	"cp_review",
 	"cp_artifact",
```

<!-- patch:S15-W01 -->
```diff
--- a/src/review-merge-window.ts
+++ b/src/review-merge-window.ts
@@ -15 +15 @@
-	const deadline = Date.parse(pass.decided_at) + REVIEW_MERGE_WINDOW_MS;
+	const deadline = Date.parse(pass.decided_at);
```

<!-- patch:S15-C10 -->
```diff
--- a/src/review-context.ts
+++ b/src/review-context.ts
@@ -154 +154 @@
-	for (const path of named) add(path, "head", "task-named");
+	for (const path of named) { add(path, "head", "task-named"); add(path, "fork", "task-named"); }
```

S02 controls run with `npm run test:one -- --test-name-pattern='landing S02: <scenario prefix>' tests/e2e/landing.test.ts`.
Each patch below was applied alone and restored; each exited 1 on the observable assertion above.
The restored S02 scenarios pass. Existing NC-32 and NC-39–NC-42 continue to cover shared scenario 05-8.

<!-- patch:NC-S02-eligibility -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..152e949 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -155,12 +155,7 @@ export function prReceiptOf(record: WatchableRecord): Receipt | undefined {
  * `delivery:pr` job keeps its worker alive by design, and this must not care.
  */
 export function isWatched(record: WatchableRecord): boolean {
-	if (record.delivery !== "pr") return false;
-	if (record.phase !== "held") return false;
-	if (record.reported_at === undefined) return false;
-	const receipt = prReceiptOf(record);
-	if (!receipt) return false;
-	return !LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase());
+	return true;
 }
 
 // ---------------------------------------------------------------------------
```

<!-- patch:NC-S02-terminal -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..d5d5e64 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -261,7 +261,7 @@ export function deriveCiEvents(facts: CiFacts): CiObservation[] {
 		...rest,
 	});
 
-	if (facts.pr?.merged) {
+	if (false && facts.pr?.merged) {
 		const commit = facts.pr.merge_commit_sha?.trim();
 		return [
 			at("pr_merged", {
```

<!-- patch:NC-S02-retry -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..72c010e 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -723,7 +723,7 @@ export class CiWatch {
 			// defect this bound exists to close, and confirmation (or the job leaving
 			// the watch set) is what clears it, never a third send.
 			if (existing?.resent) continue;
-			if (existing !== undefined && millis - existing.sentAt < this.#retryMs) continue;
+			if (existing !== undefined) continue;
 			const isResend = existing !== undefined;
 			this.#inFlight.set(observation.key, { sentAt: millis, resent: isResend });
 			due.push(observation);
```

<!-- patch:NC-S02-resend -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..b099b5d 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -722,7 +722,7 @@ export class CiWatch {
 			// left alone from here on — resending it again on every future tick is the
 			// defect this bound exists to close, and confirmation (or the job leaving
 			// the watch set) is what clears it, never a third send.
-			if (existing?.resent) continue;
+			if (false && existing?.resent) continue;
 			if (existing !== undefined && millis - existing.sentAt < this.#retryMs) continue;
 			const isResend = existing !== undefined;
 			this.#inFlight.set(observation.key, { sentAt: millis, resent: isResend });
```

<!-- patch:NC-S02-age -->
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

<!-- patch:NC-S02-cap -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..4ee7970 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -364,7 +364,7 @@ export function ciWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number
 export function nextDueMs(cadence: CiWatchCadence, state: { failures: number; settled: boolean }): number {
 	if (state.failures > 0) {
 		const grown = cadence.intervalMs * 2 ** Math.max(0, state.failures - 1);
-		return Math.min(grown, cadence.maxBackoffMs);
+		return grown;
 	}
 	return state.settled ? cadence.intervalMs * cadence.idleMultiplier : cadence.intervalMs;
 }
```

<!-- patch:NC-S02-gitlab -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..e246b2b 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -674,7 +674,7 @@ export class CiWatch {
 		const now = this.#now();
 		for (const record of watched) {
 			const gitlab = parseChangeRequestUrl(prReceiptOf(record)?.url ?? "")?.kind === "gitlab";
-			if (this.#disabled && !gitlab) continue;
+			if (this.#disabled) continue;
 			if (!this.#due(record.job_id, now)) {
 				result.skipped.push(record.job_id);
 				continue;
```

<!-- patch:NC-S02-policy -->
```diff
diff --git a/src/ci-wait.ts b/src/ci-wait.ts
index 1cb3d19..d4b1e1c 100644
--- a/src/ci-wait.ts
+++ b/src/ci-wait.ts
@@ -115,7 +115,7 @@ export function detectCiWait(command: string): CiWaitFinding | undefined {
 	if (typeof command !== "string" || command.trim().length === 0) return undefined;
 
 	const watch = firstMatch(command, BLOCKING_WATCH_RES);
-	if (watch) {
+	if (false && watch) {
 		return {
 			shape: "blocking_watch",
 			matched: bound(watch),
```

Review-1 controls below were each applied alone to source revision b744b908413b97d7fb9a39ae6056179ec3f8ae07,
run with `node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='landing S02: watch delivery' tests/e2e/landing.test.ts`,
then restored. For aggregate/empty/red/closed/superseded use `landing S02: aggregate`; for key/history/prune use
`landing: CI watch persists`; for parked use `landing S02: only reported`. Each command exited 1 at the regression
assertion recorded above. The superseded case returns raw Actions rows so fake gh cannot filter away the stale input.
All sixteen logs and patches are also retained in the S02 worker artifact directory.

<!-- patch:NC-S02-restart -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..b68731d 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -415,7 +415,7 @@ export class CiWatchStore {
 	}
 
 	announced(jobId: string): Set<string> {
-		return new Set(this.job(jobId)?.announced ?? []);
+		return new Set();
 	}
 
 	#mutate(mutator: (file: CiWatchFile) => CiWatchFile): CiWatchFile {
```

<!-- patch:NC-S02-permission -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..da6a089 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -782,7 +782,7 @@ export class CiWatch {
 			next_due_at: isoTimestamp(new Date(now.getTime() + nextDueMs(this.#cadence, { failures, settled: false }))),
 			consecutive_failures: failures,
 			last_error: message.slice(0, 300),
-			last_ci: ciReadDenied(message) ? CI_UNREADABLE : "unknown", // loud when refused; never a stale green either way
+			last_ci: "unknown",
 		});
 	}
 
```

<!-- patch:NC-S02-idle -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..a91929f 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -366,7 +366,7 @@ export function nextDueMs(cadence: CiWatchCadence, state: { failures: number; se
 		const grown = cadence.intervalMs * 2 ** Math.max(0, state.failures - 1);
 		return Math.min(grown, cadence.maxBackoffMs);
 	}
-	return state.settled ? cadence.intervalMs * cadence.idleMultiplier : cadence.intervalMs;
+	return cadence.intervalMs;
 }
 
 // ---------------------------------------------------------------------------
```

<!-- patch:NC-S02-base -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..0d57078 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -366,7 +366,7 @@ export function nextDueMs(cadence: CiWatchCadence, state: { failures: number; se
 		const grown = cadence.intervalMs * 2 ** Math.max(0, state.failures - 1);
 		return Math.min(grown, cadence.maxBackoffMs);
 	}
-	return state.settled ? cadence.intervalMs * cadence.idleMultiplier : cadence.intervalMs;
+	return cadence.intervalMs * cadence.idleMultiplier;
 }
 
 // ---------------------------------------------------------------------------
```

<!-- patch:NC-S02-due -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..455899a 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -675,7 +675,7 @@ export class CiWatch {
 		for (const record of watched) {
 			const gitlab = parseChangeRequestUrl(prReceiptOf(record)?.url ?? "")?.kind === "gitlab";
 			if (this.#disabled && !gitlab) continue;
-			if (!this.#due(record.job_id, now)) {
+			if (false) {
 				result.skipped.push(record.job_id);
 				continue;
 			}
```

<!-- patch:NC-S02-overlap -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..fcfe197 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -647,7 +647,6 @@ export class CiWatch {
 	 * so a slow `gh` cannot stack queries on the next timer beat.
 	 */
 	async tick(): Promise<CiWatchTick> {
-		if (this.#tick) return this.#tick;
 		const promise = this.#run().finally(() => {
 			this.#tick = undefined;
 		});
```

<!-- patch:NC-S02-env -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..b7a1b8d 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -352,7 +352,7 @@ export function ciWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number
 	const raw = env.CP_CI_WATCH_SECONDS;
 	if (raw === undefined || raw.trim() === "") return CI_WATCH_INTERVAL_MS;
 	const parsed = Number(raw);
-	if (!Number.isFinite(parsed) || parsed <= 0) return CI_WATCH_INTERVAL_MS;
+	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
 	return Math.floor(parsed * 1000);
 }
 
```

<!-- patch:NC-S02-aggregate -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..b1cc303 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -284,7 +284,7 @@ export function deriveCiEvents(facts: CiFacts): CiObservation[] {
 	// cp-gmy's evaluator, unforked: a completed run counts only when its headSha
 	// is the branch's current pushed head, and one unfinished run on that head
 	// defers the whole aggregate.
-	const verdict = evaluateMergeAskCi({ branch: facts.branch, head: { sha: head }, runs: facts.runs });
+	const verdict = evaluateMergeAskCi({ branch: facts.branch, head: { sha: head }, runs: facts.runs.filter((r) => r.status === "completed") });
 	if (verdict.ci === "green") {
 		return [at("ci_green", { reason: verdict.reason, conclusion: "success" }, identity)];
 	}
```

<!-- patch:NC-S02-superseded -->
```diff
diff --git a/src/actions-ci.ts b/src/actions-ci.ts
index 06e38d4..a1b4fe6 100644
--- a/src/actions-ci.ts
+++ b/src/actions-ci.ts
@@ -149,7 +149,7 @@ type RunRow = Omit<ActionsRun, "jobs">;
 export function parseRunsPage(stdout: string, sha: string | undefined, endpoint = "actions/runs"): Page<RunRow> {
 	const page = pageOf(stdout, endpoint, "workflow_runs");
 	const items = page.items.map((row): RunRow => {
-		const { id, run_attempt: attempt, head_sha: headSha } = row;
+		const { id, run_attempt: attempt, head_sha: headSha } = { ...row, head_sha: sha ?? row.head_sha };
 		const status = nullableString(row.status);
 		const conclusion = nullableString(row.conclusion);
 		if (typeof id !== "number" || !positive(id) || typeof attempt !== "number" || !positive(attempt)) {
```

<!-- patch:NC-S02-empty -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..66ac2e9 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -284,6 +284,7 @@ export function deriveCiEvents(facts: CiFacts): CiObservation[] {
 	// cp-gmy's evaluator, unforked: a completed run counts only when its headSha
 	// is the branch's current pushed head, and one unfinished run on that head
 	// defers the whole aggregate.
+	if (facts.runs.length === 0) return [at("ci_green", { reason: "no runs", conclusion: "success" }, identity)];
 	const verdict = evaluateMergeAskCi({ branch: facts.branch, head: { sha: head }, runs: facts.runs });
 	if (verdict.ci === "green") {
 		return [at("ci_green", { reason: verdict.reason, conclusion: "success" }, identity)];
```

<!-- patch:NC-S02-red -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..ebbb99a 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -288,7 +288,7 @@ export function deriveCiEvents(facts: CiFacts): CiObservation[] {
 	if (verdict.ci === "green") {
 		return [at("ci_green", { reason: verdict.reason, conclusion: "success" }, identity)];
 	}
-	if (verdict.ci === "failed") {
+	if (false) {
 		const failing = failedRunOn(facts.runs, head);
 		return [
 			at("ci_failed", {
```

<!-- patch:NC-S02-closed -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..bd5b0f2 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -271,7 +271,7 @@ export function deriveCiEvents(facts: CiFacts): CiObservation[] {
 			}),
 		];
 	}
-	if (facts.pr && (facts.pr.state ?? "").trim().toLowerCase() === "closed") {
+	if (false) {
 		return [
 			at("pr_closed", {
 				reason: `PR closed without merging${facts.pr.closed_at ? ` at ${facts.pr.closed_at}` : ""}`,
```

<!-- patch:NC-S02-key -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..d0beeb6 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -212,7 +212,7 @@ export interface CiObservation {
  * same head, so a re-run wakes once (pi-command-post-rerunwake-12z).
  */
 export function ciEventKey(jobId: string, headSha: string, event: CiWatchEvent, runIdentity?: string): string {
-	const key = `${jobId}|${headSha}|${event}`;
+	const key = `${jobId}|unknown|${event}`;
 	return runIdentity && runIdentity.length > 0 ? `${key}|${runIdentity}` : key;
 }
 
```

<!-- patch:NC-S02-history -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..386e1be 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -729,7 +729,7 @@ export class CiWatch {
 			due.push(observation);
 			if (!isResend) {
 				try {
-					this.#deps.onObserved?.(record.job_id, observation);
+					if (observation.event !== "ci_failed") this.#deps.onObserved?.(record.job_id, observation);
 				} catch {
 					// A run log that cannot be written must never swallow a wake-up.
 				}
```

<!-- patch:NC-S02-prune -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..8a38105 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -667,7 +667,6 @@ export class CiWatch {
 			return result;
 		}
 		try {
-			this.store.prune(new Set([...watched, ...this.#deps.jobs().filter((r) => r.phase === "awaiting_merge")].map((r) => r.job_id)));
 		} catch {
 			// Pruning is housekeeping; a failure here must not skip the tick.
 		}
```

<!-- patch:NC-S02-parked -->
```diff
diff --git a/src/ci-watch.ts b/src/ci-watch.ts
index 25eb6e0..5a07606 100644
--- a/src/ci-watch.ts
+++ b/src/ci-watch.ts
@@ -667,7 +667,7 @@ export class CiWatch {
 			return result;
 		}
 		try {
-			this.store.prune(new Set([...watched, ...this.#deps.jobs().filter((r) => r.phase === "awaiting_merge")].map((r) => r.job_id)));
+			this.store.prune(new Set(watched.map((r) => r.job_id)));
 		} catch {
 			// Pruning is housekeeping; a failure here must not skip the tick.
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

NC-04 puts back the cp-sr5 defect `tests/budgets.test.ts` guarded: the manager's budget getter is a snapshot taken
when the CommandPost is built, so a `data/budgets.json` written later never reaches a dispatch. The file has no
separate fix commit in this repository's history; the bug commit column names the release that carries the getter.

<!-- patch:NC-04-budgets -->
```diff
--- a/src/command-post.ts
+++ b/src/command-post.ts
@@ -384,3 +384,3 @@
 			workerReporterPath: join(options.packageRoot, "extensions/worker-reporter/index.ts"),
-			budget: () => this.budgets(),
+			budget: ((snapshot) => () => snapshot)(this.budgets()),
 			questions: this.questions,
```

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

<!-- patch:NC-05-held-slot -->
```diff
--- a/src/mandate-accounting.ts
+++ b/src/mandate-accounting.ts
@@ -138,3 +138,3 @@ export function mandateSpend(
 		// delivery (a promote moves it back to `waiting`). Held jobs still count toward spend and jobs.
-		if (job.phase === "waiting" || job.phase === "launching") inFlight += 1;
+		if (job.phase === "waiting" || job.phase === "launching" || job.phase === "held") inFlight += 1;
 	}
```

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  Error: cp-g1so: mandate md-68b4c8 dispatch-parallelism 1 is full
ℹ pass 5
ℹ fail 1
```

NC-06 stops counting a held job toward the grant's spend and job count:

<!-- patch:NC-06-held-spend -->
```diff
--- a/src/mandate-accounting.ts
+++ b/src/mandate-accounting.ts
@@ -121,3 +121,3 @@ export function mandateSpend(
 ): { usd: number; tokens: number; jobs: number; inFlight: number } {
-	const matched = matchingJobs(mandate, jobs);
+	const matched = matchingJobs(mandate, jobs).filter((job) => job.phase !== "held");
 	const baseline = new Map((mandate.usage_baseline ?? []).map((entry) => [entry.job_id, entry]));
```

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  Error: timed out after 60000ms waiting for held + second spend to reach the token cap; last = error: undefined
ℹ pass 5
ℹ fail 1
```

NC-07 lets a read-only ops profile exempt its job from the risk:high gate:

<!-- patch:NC-07-ops-gate -->
```diff
--- a/src/dispatch-authority.ts
+++ b/src/dispatch-authority.ts
@@ -19,3 +19,3 @@ export interface DispatchAuthorityJob {
 export const riskGateExempt = (job: Pick<DispatchAuthorityJob, "kind" | "readOnly" | "promotion" | "script" | "ops">): boolean =>
-	job.kind === "research" && job.readOnly === true && !job.promotion && !job.script && !job.ops;
+	job.kind === "research" && job.readOnly === true && !job.promotion && !job.script;
 export async function assertDispatchAllowed(store: MandateStore, job: DispatchAuthorityJob, jobs: readonly MandateUsageJob[] = []): Promise<GrantPermission> {
```

```
✖ authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: undefined,
    expected: 'would ask: risk:high',
ℹ pass 5
ℹ fail 1
```

NC-08 lets the caller's risk override a deploy's fixed high:

<!-- patch:NC-08-ops-risk -->
```diff
--- a/src/ops-jobs.ts
+++ b/src/ops-jobs.ts
@@ -37,3 +37,3 @@ export function opsRequest<R extends { profile?: string; risk?: Risk }>(request:
 	if (request.profile !== undefined && request.profile !== OPS_PROFILE_NAME) throw new DispatchError(`${job.id}: an ops:${cls} job runs the ops profile, not ${request.profile} — drop profile`);
-	return { ...request, profile: OPS_PROFILE_NAME, risk: cls === "pull" ? (request.risk ?? parseJobLabels(job.labels).risk ?? "low") : "high" };
+	return { ...request, profile: OPS_PROFILE_NAME, risk: cls === "pull" ? (request.risk ?? parseJobLabels(job.labels).risk ?? "low") : (request.risk ?? "high") };
 }
```

```
✖ authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource
  AssertionError [ERR_ASSERTION]: a deploy is high whatever the caller says
    actual: [ 'ops', 'low' ],
    expected: [ 'ops', 'high' ],
ℹ pass 5
ℹ fail 1
```

NC-09 leases a resource only to a reported (held) holder, not a working one:

<!-- patch:NC-09-ops-lease -->
```diff
--- a/src/ops-jobs.ts
+++ b/src/ops-jobs.ts
@@ -44,3 +44,3 @@ export function assertResourcesFree(job: Pick<Job, "id" | "labels">, fleet: read
 	if (wanted.length === 0) return;
-	const live = new Set(fleet.filter((record) => record.job_id !== job.id && record.phase !== "done").map((record) => record.job_id));
+	const live = new Set(fleet.filter((record) => record.job_id !== job.id && record.phase === "held").map((record) => record.job_id));
 	for (const other of jobs) {
```

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

<!-- patch:NC-10-negation -->
```diff
--- a/src/pipeline.ts
+++ b/src/pipeline.ts
@@ -284,3 +284,3 @@ export function acceptedRiskMatches(text: string, alsoBenign?: (text: string, in
 	}
-	return found.filter((match) => !negated.has(match) && !benignSenseAt(text, match.at, match.word) && !alsoBenign?.(text, match.at, match.word)).map(({ word, why }) => ({ word, why }));
+	return found.filter((match) => !benignSenseAt(text, match.at, match.word) && !alsoBenign?.(text, match.at, match.word)).map(({ word, why }) => ({ word, why }));
 }
```

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

<!-- patch:NC-11-held-jobs -->
```diff
--- a/src/mandate-accounting.ts
+++ b/src/mandate-accounting.ts
@@ -135,3 +135,3 @@ export function mandateSpend(
 		// pre-existing jobs once they spend under it, so a project's history never fills its job cap.
-		if (named || !base || spent.usd > 0 || spent.tokens > 0) counted += 1;
+		if ((named || !base || spent.usd > 0 || spent.tokens > 0) && job.phase !== "held") counted += 1;
 		// A working worker holds a parallelism slot; a `held` job has reported and waits on its
```

```
✖ authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Error: cp-0e9m: mandate md-9fb896 dispatch-parallelism 1 is full
ℹ pass 0
ℹ fail 1
```

NC-12 brings back the key-order-sensitive override comparison (cur.2.6), so agreeing overrides fall through to home:

<!-- patch:NC-12-override-order -->
```diff
--- a/src/mandate-defaults.ts
+++ b/src/mandate-defaults.ts
@@ -310,3 +310,3 @@ export function resolveMandateGrant(
 export function sameProjectMandateOverride(a: ProjectMandateOverride | undefined, b: ProjectMandateOverride | undefined): boolean {
-	return canonicalJson(a) === canonicalJson(b);
+	return JSON.stringify(a) === JSON.stringify(b);
 }
```

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

<!-- patch:NC-13-low-warning -->
```diff
--- a/src/risk-warning.ts
+++ b/src/risk-warning.ts
@@ -155,3 +155,3 @@ export function inferredRiskGate(input: {
 	}
-	if (recorded !== "low" || (routed === "high" && recordedProvenance(routedFrom))) {
+	if (recorded !== "low" || routed === "high") {
 		if (routed !== "high") return { risk: routed };
```

```
✖ authority: a recorded or declared low turns a keyword-only high into a warning; a recorded, supplied or planner high still gates
  AssertionError [ERR_ASSERTION]: Scope M each, risk low.
  + 'would ask: risk:high'
  - undefined
ℹ pass 0
ℹ fail 1
```

NC-14 lets a pre-approval cover a hard stop:

<!-- patch:NC-14-hard-stop -->
```diff
--- a/src/risk-preapproval.ts
+++ b/src/risk-preapproval.ts
@@ -55,3 +55,3 @@ export function riskPreapproval(
 	const named = asking.length > 0 && asking.every((grant) => preapprovalCovers(grant, job, createdAt));
-	return { covered: named && !job.script && stops.length === 0, stops: named ? stops : [] };
+	return { covered: named && !job.script, stops: named ? stops : [] };
 }
```

```
✖ authority: an operator-quoted risk:high pre-approval lets covered dispatches and promotions proceed with an audit row; anything else still asks
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ pass 0
ℹ fail 1
```

NC-15 refuses a duplicate only when two different ids repeat:

<!-- patch:NC-15-batch-duplicates -->
```diff
--- a/src/risk-batch.ts
+++ b/src/risk-batch.ts
@@ -32,3 +32,3 @@ export async function batchRiskHigh(
 	const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
-	if (duplicates.length > 0) refuse(`duplicate job ids: ${duplicates.join(", ")}`);
+	if (duplicates.length > 1) refuse(`duplicate job ids: ${duplicates.join(", ")}`);
 
```

```
✖ authority: cp_escalate batch_risk_high files one approve/drop record for jobs one asking grant gates; every refusal writes nothing
  AssertionError [ERR_ASSERTION]: twice: {"content":[{"type":"text","text":"es-87f890 batch risk:high: 2 jobs (cp-utjq, cp-utjq); …
ℹ pass 0
ℹ fail 1
```

NC-16 prefers the latest-issued grant:

<!-- patch:NC-16-issue-order -->
```diff
--- a/src/grant-order.ts
+++ b/src/grant-order.ts
@@ -3,3 +3,3 @@ export function compareActiveGrants(a: { id: string; issued_at: string; job_ids?
 	return Number(Boolean(b.job_ids?.length)) - Number(Boolean(a.job_ids?.length))
-		|| (a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0)
+		|| (a.issued_at > b.issued_at ? -1 : a.issued_at < b.issued_at ? 1 : 0)
 		|| (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
```

```
✖ authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement
  + 'md-000001'
  - 'md-a994c5'
ℹ pass 0
ℹ fail 1
```

NC-17 brings back the full named grant shadowing its eligible supplement (#184):

<!-- patch:NC-17-supplement -->
```diff
--- a/src/mandate-permission.ts
+++ b/src/mandate-permission.ts
@@ -103,3 +103,3 @@ export function selectGrant(grants: readonly Mandate[], use: GrantUse, job: Gran
 	if (jobs && first && named(first.grant) && jobCapFullWithout(first.grant, job.jobId, jobs)) {
-		return active.slice(1).find(({ grant }) => named(grant) && !jobCapFullWithout(grant, job.jobId, jobs)) ?? first;
+		return first;
 	}
```

```
✖ authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement
  + 'md-older1'
  - 'md-supp01'
ℹ pass 0
ℹ fail 1
```

NC-18 counts cache reads toward the token cap:

<!-- patch:NC-18-cache-reads -->
```diff
--- a/src/mandate-accounting.ts
+++ b/src/mandate-accounting.ts
@@ -92,3 +92,3 @@ export function matchingJobs(mandate: Mandate, jobs: readonly MandateUsageJob[])
 /** What a token cap counts: non-cached tokens, input + output + cache_write = total minus cache_read (as `billableTokens`, src/failures.ts). */
-export const mandateTokens = (usage?: { total_tokens: number; cache_read?: number }): number => Math.max(0, (usage?.total_tokens ?? 0) - (usage?.cache_read ?? 0));
+export const mandateTokens = (usage?: { total_tokens: number; cache_read?: number }): number => Math.max(0, usage?.total_tokens ?? 0);
 
```

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

<!-- patch:NC-19-capacity-auth -->
```diff
--- a/src/capacity.ts
+++ b/src/capacity.ts
@@ -42,3 +42,3 @@ export class CapacityReader {
 			if (!response.ok) {
-				if (response.status === 401 || response.status === 403) reason = "capacity auth rejected";
+				if (response.status === 403) reason = "capacity auth rejected";
 				throw new Error("capacity unavailable");
```

```
✖ authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key
  AssertionError [ERR_ASSERTION]: source=rubric model=other/b rule=implementer thinking=medium quota unavailable: auth rejected capacity=fleet:mock=-2,other=0
ℹ pass 0
ℹ fail 1
```

NC-20 drops the 5h threshold's own boundary:

<!-- patch:NC-20-quota-tight -->
```diff
--- a/src/quota.ts
+++ b/src/quota.ts
@@ -100,3 +100,3 @@ export class QuotaReader {
 					const best = known[0];
-					return best ? { ...best, tight: (best.five_hour !== undefined && best.five_hour >= config.quota.five_hour) || best.seven_day! >= config.quota.seven_day } : { provider, tight: false };
+					return best ? { ...best, tight: (best.five_hour !== undefined && best.five_hour > config.quota.five_hour) || best.seven_day! >= config.quota.seven_day } : { provider, tight: false };
 				}) };
```

```
✖ authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key
  AssertionError [ERR_ASSERTION]: 90/0
ℹ pass 0
ℹ fail 1
```

NC-21 drops the cp-7re9 deny_projects check from the mandate's auto-decision:

<!-- patch:NC-21-denied-project -->
```diff
--- a/src/mandate-autodecide.ts
+++ b/src/mandate-autodecide.ts
@@ -16,5 +16,4 @@ export function autoDecideCheckpoint(
 ): Checkpoint {
 	if (checkpoint.decision !== "pending") return checkpoint;
-	if (projectDenial(mandates.home, subject.project)) return checkpoint;
 	const now = subject.now ?? isoTimestamp();
 	const source = runAuthority(mandates.runContext(), subject.jobId).source;
```

```
✖ authority: a pipeline's plan checkpoint is mandate-decided and journaled; task-text exclusions, gate flags, an unnamed high and a denied project leave it pending
  Error: preflight refused cp-s1yq: ... [fail] project_denied: settings: project demo is denied ...
ℹ pass 0
ℹ fail 1
```

NC-22 keeps only the last job created this turn when the sentinel expands:

<!-- patch:NC-22-this-turn-jobs -->
```diff
--- a/src/mandate.ts
+++ b/src/mandate.ts
@@ -73,5 +73,5 @@ export function resolveMandateJobIds(
 		throw new MandateError("cp_mandate issue: no jobs created in this turn");
 	}
-	return [...createdThisTurn];
+	return [...createdThisTurn].slice(-1);
 }
 
```

```
✖ authority: cp_mandate through a real parent sets the reviewer model, names this turn's jobs, filters show, refuses every bad issue before writing, and a revoke or expiry closes its asks
  AssertionError [ERR_ASSERTION]: Expected values to be deeply equal: [ 'cp-ovpy' ] vs [ 'cp-ovpy', 'cp-vyp7' ]
ℹ pass 0
ℹ fail 1
```

NC-23 takes repair off an expired grant's in-flight continuations:

<!-- patch:NC-23-expired-repair -->
```diff
--- a/src/mandate-permission.ts
+++ b/src/mandate-permission.ts
@@ -86,5 +86,5 @@ export function grantStanding(grant: Mandate, use: GrantUse, job: GrantJob, now:
 function expiredCell(grant: Mandate, use: GrantUse, job: GrantJob): { standing: GrantCell; cause: "expired"; detail?: string } {
 	const refuse = (detail: string) => ({ standing: R as GrantCell, cause: "expired" as const, detail });
-	const action = CONTINUATION_ACTION[use];
+	const action = use === "repair" ? undefined : CONTINUATION_ACTION[use];
 	if (!action) return refuse("no first authorization under it; only a job already in flight under it continues");
 	if (!job.inFlight) return refuse(`${job.jobId} has no fleet record of that kind, so it is a fresh start or a kind change, never a continuation`);
```

```
✖ authority: an expired, revoked, serial or job-capped grant stops fresh starts while its own in-flight workers keep promotion and repair
  Error: cp-5ldk: mandate md-8bab6a expired at ... — no first authorization under it; only a job already in flight under it continues. A new job needs a new grant (cp_mandate issue).
ℹ pass 0
ℹ fail 1
```

NC-24 reads any 403 or 404 as the token's denial, HTML proxy pages included (P3; fixed run: 4 pass, 0 fail):

<!-- patch:NC-24-html-403 -->
```diff
--- a/src/actions-ci.ts
+++ b/src/actions-ci.ts
@@ -260,7 +260,7 @@ async function attempt(options: ActionsReadOptions, endpoint: string, timeoutMs:
 		if (/rate limit/i.test(message)) return { fault: new ActionsCiError("rate_limited", endpoint), retry: false };
 		// GitHub's own denials are JSON; an HTML 403/404 is a proxy or abuse page, not the token's answer.
 		const html = body.trim() !== "" && !isJson(body);
-		if ((code === "403" || code === "404") && !html) return { fault: new ActionsCiError("denied", endpoint, `HTTP ${code}`), retry: false };
+		if (code === "403" || code === "404") return { fault: new ActionsCiError("denied", endpoint, `HTTP ${code}`), retry: false };
 		// "status", not "HTTP": src/ci-access.ts reads any "HTTP 403" as the token's denial.
 		return { fault: new ActionsCiError("transport", endpoint, evidence(code ? `status ${code}` : "no HTTP status", body)), retry: true };
 	}
```

```
✖ landing: a denied, rate-limited, malformed, partial or capped Actions read never merges and names its cause; a full paged read finds page two's failure
  AssertionError [ERR_ASSERTION]: HTML 403: gh: https://github.com/example/demo/pull/81 is OPEN at …
ℹ pass 3
ℹ fail 1
```

NC-25 takes an empty first workflows page as no CI, whatever total_count says:

<!-- patch:NC-25-truncated-empty -->
```diff
--- a/src/ci-configured.ts
+++ b/src/ci-configured.ts
@@ -152,7 +152,7 @@ export function readCiConfigured(result: { status: number | null; stdout: string
 	}
 	// Both fields must agree on zero. A truncated page (`total_count: 3` with an
 	// empty first page) is not an authoritative empty list.
-	if (total === 0 && workflows.length === 0) {
+	if (workflows.length === 0) {
 		return {
 			state: "none",
 			cause: "authoritative_empty",
```

```
✖ landing: only an authoritative empty workflow list is no CI; every unanswered workflows read keeps its own cause and never reads as none
  AssertionError [ERR_ASSERTION]: a truncated page: ci configuration: none (authoritative_empty) — …
ℹ pass 3
ℹ fail 1
```

NC-26 lets the doctor's jobs probe call a short jobs list readable:

<!-- patch:NC-26-short-jobs -->
```diff
--- a/src/ci-access-doctor.ts
+++ b/src/ci-access-doctor.ts
@@ -36,7 +36,7 @@ function probeLatestRun(run: Run, home: string, repo: string): Failed | { runs:
 			if (!("stdout" in answer)) return answer;
 			const parsed = parseJobsPage(answer.stdout, { runId: latest.databaseId, attempt: latest.attempt, sha: latest.headSha }, endpoint);
 			jobs += parsed.items.length;
-			if (parsed.items.length < ACTIONS_PER_PAGE) return jobs === parsed.total ? { jobs } : { failed: "unknown", cause: "incomplete" };
+			if (parsed.items.length < ACTIONS_PER_PAGE) return { jobs };
 		}
 		return { failed: "unknown", cause: "incomplete" };
 	} catch (error) {
```

```
✖ landing: /doctor ci.<project> reads workflows, then the newest run and its attempt jobs; a refused read is loud and gh output never echoes
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: [ 'ok', 'CI readable for o/short (2 workflow(s); latest run and its 1 job(s) read)' ]
ℹ pass 3
ℹ fail 1
```

NC-27 drops the attempt-2 guard, so a second infra failure is rerun again:

<!-- patch:NC-27-second-attempt -->
```diff
--- a/src/ci-infra-rerun.ts
+++ b/src/ci-infra-rerun.ts
@@ -138,7 +138,7 @@ export async function maybeRerunInfra(input: InfraRerunInput & InfraRerunPorts):
 	const unidentified = failed.find((run) => run.databaseId === undefined || run.attempt === undefined);
 	if (unidentified) return skip("a failed run has no id or attempt to rerun by");
 	const repeated = failed.find((run) => (run.attempt ?? 0) >= 2);
-	if (repeated) return skip(`run ${repeated.databaseId} is on attempt ${repeated.attempt}: a second failure is the parent's`);
+	if (repeated && false) return skip(`run ${repeated.databaseId} is on attempt ${repeated.attempt}: a second failure is the parent's`);
 	let claimed: CiRerunEntry | undefined;
 	try {
 		claimed = input.store.claimed(input.jobId, input.head);
```

```
✖ landing: an infra-only CI failure is claimed, then rerun once per head; a test failure, a cancel, a second attempt, a drain or an unreadable claim or job list goes to the parent
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /run 41 is on attempt 2: a second failure is the parent's/
ℹ pass 3
ℹ fail 1
```

NC-28 lets an open PR past the state rule, as if gh's answer were enough:

<!-- patch:NC-28-open-pr -->
```diff
--- a/src/merges.ts
+++ b/src/merges.ts
@@ -237,7 +237,7 @@ export class MergeStore {
 		const jobId = record.job_id;
 		const label = view.provider === "gitlab" ? "GitLab" : "gh";
 
-		if (view.state !== "merged") {
+		if (view.state !== "merged" && view.state !== "open") {
 			throw new MergeError(
 				`${jobId}: ${label} reports ${view.url} as ${view.state}, not MERGED — nothing is recorded. ` +
 					"A merge receipt is an observation, never a claim.",
```

```
✖ landing: cp_merged records only a merge gh observed for this job's branch, marks its PR merged once, and an opted-in deploy branch gets one blocked ops:deploy job
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /reports .* as open, not MERGED — nothing is recorded/. Input:
  'Error: cp-v2fy: gh reports https://github.com/example/demo/pull/91 merged but names no merge commit — nothing is recorded. …'
ℹ pass 0
ℹ fail 1
```

NC-29 skips the fast-forward reachability question, so an MR head git cannot see on the target is recorded:

<!-- patch:NC-29-unseen-ff -->
```diff
--- a/src/merges.ts
+++ b/src/merges.ts
@@ -329,6 +329,7 @@ export class MergeStore {
 	/** Fast-forward evidence: origin's `target` tip has `head` in its history (the tip object fetched by sha if missing). */
 	async #reachable(cwd: string, head: string, target: string): Promise<boolean> {
 		const git = (dir: string, args: readonly string[]) => this.#run(dir, "git", args);
+		return true;
 		const tip = await remoteTip(git, cwd, target);
 		if (!tip.ok || !tip.sha || !(await haveCommit(git, cwd, tip.sha))) return false;
 		return (await git(cwd, ["merge-base", "--is-ancestor", head, tip.sha])).status === 0;
```

```
✖ landing: cp_merged reads a GitLab MR only from the project's own GitLab with its token; a squash, or a fast-forward git sees on the target, is recorded and anything else records nothing
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ pass 0
ℹ fail 1
```

NC-30 drops the literal pathspec magic, so a changed path that is a glob also compares other files:

<!-- patch:NC-30-glob-paths -->
```diff
--- a/src/landing-proof.ts
+++ b/src/landing-proof.ts
@@ -152,7 +152,7 @@ export async function readLandingProof(git: GitRun, worktree: string, head: stri
 		const truncated = listed.length > limits.candidates;
 		const candidates = [baseSha, ...listed.filter((sha) => sha !== baseSha)].slice(0, limits.candidates);
 		// shortcut: every path rides one argv; a job past ~1 MB of path names hits ARG_MAX and reads as unknown, which keeps the lease.
-		const pathspecs = paths.map((path) => `:(literal)${path}`);
+		const pathspecs = paths.map((path) => path);
 		for (const candidate of candidates) {
 			if ((await run(["diff", "--quiet", ...DIFF, head, candidate, "--", ...pathspecs], [0, 1])).status !== 0) continue;
 			if ((await run(["merge-base", "--is-ancestor", candidate, baseSha], [0, 1])).status !== 0) {
```

```
✖ landing: cp_teardown passes a deleted branch as landed_by_git when origin's base holds its content (merge, squash, rebase, a later edit, literal odd paths) and keeps the lease when it does not
  AssertionError [ERR_ASSERTION]: {"code":"unpushed","message":"… branch cp-hcr6 is not on origin (origin/cp-hcr6 survives here only as a stale remote-tracking ref at 2916708594e5), and origin/main does not contain its content", …}
    actual: [ false, undefined, undefined ],
    expected: [ true, 'landed_by_git', 'path_tree' ],
ℹ pass 0
ℹ fail 1
```

NC-31 drops the opt-in date rule, so a merge from before `after_merge_deploy` was enabled still creates a deploy job:

<!-- patch:NC-31-pre-opt-in -->
```diff
--- a/src/after-merge.ts
+++ b/src/after-merge.ts
@@ -73,7 +73,7 @@ export async function afterMergeDeploy(ports: AfterMergePorts, receipt: MergeRec
 		const mergedAt = receipt.merged_at ?? receipt.recorded_at;
 		const skip = !receipt.base_branch ? "the merge receipt names no base branch"
 			: receipt.base_branch !== deploy.branch ? `merged into ${receipt.base_branch}, not the deploy branch ${deploy.branch}`
-			: Date.parse(mergedAt) < Date.parse(deploy.enabled_at) ? `merged ${mergedAt}, before after_merge_deploy was enabled ${deploy.enabled_at}`
+			: Date.parse(mergedAt) < Date.parse(deploy.enabled_at) && false ? `merged ${mergedAt}, before after_merge_deploy was enabled ${deploy.enabled_at}`
 			: undefined;
 		if (skip) {
 			atomicWriteJson(file, { ...base, status: "skipped", reason: skip, recorded_at: now });
```

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
| `tests/e2e/diff-review.test.ts` | S04 (cp-e2e-slice-s04-vep1), behavior 05 public review conversion |
| `tests/foreign-ci-watch-retained.test.ts` | S06 | one retained static source/port inspection; no runtime entry point exposes implementation imports or injected dependency key enumeration |
| `tests/forge-runtime-retained.test.ts` | S06 | three verbatim landing proof regressions: injected runner budgets, direct runner timeout and proof/release recheck |
| `tests/forge-observers-retained.test.ts` | S06 | eight preserved structural, security and direct-reader boundary declarations; reasons in assertion map |
| `tests/held-release-retained.test.ts` | S06 | eight preserved private-state, schema-defense and injected-race declarations; reasons in assertion map |
| `tests/review-tool-retained.test.ts` | S15 | convert-owned; three verbatim declarations retained from tests/review-tool.test.ts for unreachable closed-schema, invalid-verdict and combined raw-observation helper inputs; see testing-migration-s15.md |
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
| `tests/actions-ci.test.ts` | deleted | P3 | 16 declarations: scenarios 05-1 and 05-4 (Assertion map); five units retained in `tests/main-ci.test.ts`; NC-24 |
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
| `tests/bridge-reattach.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/budgets.test.ts` | deleted | P2 | 6 assertions mapped to 02-4; negative control NC-04 |
| `tests/capacity.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-14 or redundant-unreachable (Assertion map); negative control NC-19 |
| `tests/checkpoint-root.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/ci-access.test.ts` | deleted | P3 | 5 declarations: scenarios 05-1 and 05-3 (Assertion map); two units retained in `tests/main-ci.test.ts`; NC-26 |
| `tests/ci-configured.test.ts` | deleted | P3 | 5 declarations: scenario 05-2 (Assertion map); one unit retained in `tests/merge-ask.test.ts`; NC-25 |
| `tests/ci-evidence.test.ts` | deleted | P3c | all five declarations mapped to real tool and viewer consumers in 05-9; NC-33 and NC-43–NC-48 record failing assertions; no units moved or retained |
| `tests/ci-host-tools.test.ts` | exception | P1 | guard: CI never silently skips treehouse acceptance; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-infra-rerun.test.ts` | deleted | P3 | 4 declarations: scenario 05-4 (Assertion map); two units retained in `tests/main-ci.test.ts`; NC-27 |
| `tests/ci-run-ref.test.ts` | deleted | P0 | 10 assertions mapped, 4 redundant-unreachable; negative controls NC-01..NC-03 |
| `tests/ci-wait.test.ts` | exception | P1 | contract: worker report-and-stop policy and guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-watch.test.ts` | convert | P3c-rest | behavior 05 follow-on; 80 declarations, five already mapped to 05-8 with controls, 75 pending |
| `tests/contract-injection.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contract.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts-anchors.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts-exports.test.ts` | exception | P1 | golden: export compatibility; operator ask-0088e0332d00 (Exceptions) |
| `tests/contracts.test.ts` | exception | P1 | contract: schema/prompt/export consistency; operator ask-0088e0332d00 (Exceptions) |
| `tests/control-pending.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/cp-bridge-reattach.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
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
| `tests/dashboard-compaction.test.ts` | convert | P5 | behavior 07 (Compaction) |
| `tests/dashboard-control-images.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-control-remote.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-control.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/dashboard-restart.test.ts` | convert | P6 | behavior 08 (Drain/restart) |
| `tests/decide-listing.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/decide.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/decision-context.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/deferred-recheck.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/dependency-dispatch.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/device-notifications.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/device-notify.test.ts` | convert | P12 | behavior 16 (Tunnel, pairing, remote access) |
| `tests/diff-review.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/escalation-relay-watch.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/escalation.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/evals.test.ts` | exception | P1 | contract: offline assembled prompt corpus; operator ask-0088e0332d00 (Exceptions) |
| `tests/extension-deps.test.ts` | exception | P1 | contract: package boundary constraints; operator ask-0088e0332d00 (Exceptions) |
| `tests/extension-load.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/failure-announcer.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/failures.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/fake-parent-tracker.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/fleet.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/foreign-ci-watch.test.ts` | deleted | S06 | 11 declarations: 10 mapped (05-10, S06-1), 1 static inspection retained in tests/foreign-ci-watch-retained.test.ts; S06-moved and S06-timeout controls |
| `tests/forge-observers.test.ts` | deleted | S06 | 14 declarations: 8 mapped, 6 retained in tests/forge-observers-retained.test.ts; declaration controls in testing-migration-s06-controls.md |
| `tests/forge-runtime.test.ts` | deleted | S06 | 5 declarations: two mapped to 05-5/05-6/S06-3/S06-4, three retained verbatim in tests/forge-runtime-retained.test.ts; runtime negative controls |
| `tests/forge-url.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/gate-replacement.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gate.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gateway-key.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/guards.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/held-release.test.ts` | deleted | S06 | 10 declarations: 4 mapped, 6 retained in tests/held-release-retained.test.ts; declaration controls in testing-migration-s06-controls.md |
| `tests/home-checkout.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/human-handoff.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/install-nudge.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/install-tools.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/intake-settle-atomicity.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/intake.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/integrate-held-ci.test.ts` | deleted | P3c-rest | S07: three declarations mapped to 05-13 and 05-S07; NC-37 and S07-NC-1; original blob 367d199760c7c5927e5cc1fe268aa97d862bc4e5 |
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
| `tests/main-ci.test.ts` | convert | P3c-rest | behavior 05 follow-on; 39 declarations pending conversion, including inherited P3/P3b coverage |
| `tests/mandate-defaults.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-8 or redundant-unreachable (Assertion map); negative control NC-12 |
| `tests/mandate-selection.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-16 |
| `tests/mandate-supplement.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-17 |
| `tests/mandate-usage.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-13 or redundant-unreachable (Assertion map); one source scan kept in `tests/structure.test.ts`; negative control NC-18 |
| `tests/mandate.test.ts` | deleted | P2e | 61 declarations: scenarios 02-1 to 02-17 (Assertion map); eight units retained in `tests/decide.test.ts` (P10); NC-05, NC-06, NC-11, NC-21 to NC-23 |
| `tests/mcp-access.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/memory.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/merge-ask.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merge-permission.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merges.test.ts` | deleted | P3b | 12 declarations: 05-5, 05-6 and S06-2; one receipt guard retained in tests/forge-observers-retained.test.ts; NC-28, NC-29, S06-deploy |
| `tests/mode.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/model-call-failure-recovery.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery); also listed under 14, owned here only |
| `tests/next.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/operator-answers.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/operator-asks.test.ts` | convert | P10 | behavior 09 (Escalations, asks and answers) |
| `tests/operator-cache-warming.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/operator-compact.test.ts` | convert | P5 | behavior 07 (Compaction) |
| `tests/operator-context.test.ts` | convert | P5 | behavior 07 (Compaction) |
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
| `tests/parent-compact-hold.test.ts` | convert | P5 | behavior 07 (Compaction) |
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
| `tests/pr-bind.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/pr-resolve.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/review-approval.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/review-context.test.ts` | deleted | P3 | S15: all ten declarations mapped to 05-S15-C/F; ten executed controls with patches/hashes in testing-migration-s15.md; known cp-c1ur N11 regression pinned by S15-C10 |
| `tests/review-merge-window.test.ts` | deleted | P3 | S15: both declarations mapped to 05-S15-W through cp_integrate and a fresh parent; executed W01/W02 patches and hashes in testing-migration-s15.md |
| `tests/review-runs.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/review-tool.test.ts` | deleted | P3 | S15: four mapped declarations in 05-S15-T/P; three declarations ledgered retained and moved verbatim to tests/review-tool-retained.test.ts; typed-helper/schema entry-point traces and T00–T05 controls in testing-migration-s15.md |
| `tests/reviewer-model.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/send-first-gate.test.ts` | convert | P4 | behavior 06 (Wake delivery); moved from P2: it pins the send-first wake hold, not authority |
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
| `tests/shipped-seen.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/skill-catalog.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/stale-notice-context.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
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
| `tests/wake-rules.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/wakeup-head-sources.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
| `tests/wakeup-journal.test.ts` | convert | P4 | behavior 06 (Wake delivery) |
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
