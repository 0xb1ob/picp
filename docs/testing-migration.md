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
| P3c (cp-e2e-migration-p3c-l5fc) | behavior 05 fixed CI-watch slice, scenarios 05-8 to 05-13. [143 declaration assessments](testing-migration-p3c-declarations.md): 5 mapped, 138 retained (96.50%), 0 redundant. All seven partial files restored to baseline paths, convert owner P3c2. P3d owns only the other 16 files; 23 behavior-05 files remain convert in total. | 0 files retired; 0 declarations removed | 379 → 379 | 4,272 → 4,278 |

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
branches were merged, squashed, rebased or never landed on the scratch remote. Six units are `retained`, moved
verbatim: the landing proof's injected-failure, timeout and recheck units to `tests/forge-runtime.test.ts`, and the
total receipt reader, the throwing after-merge port and the ledger refusal to `tests/forge-observers.test.ts`; both
files stay `convert` for P3c. The P2e review's three findings were already folded in by P3. P3b folds in the P3
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
| P3c | 05 | `tests/e2e/landing.test.ts` | adds 05-8 to 05-13; seven partial files remain convert under P3c2 |
| P3c2 | 05 | `tests/e2e/landing.test.ts` | future owner of the seven partial CI-watch files; 138 retained declarations remain |
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
| `tests/actions-ci.test.ts` | readActionsCi: normalizes runs with identity, event, actor and their attempt's jobs and steps | 05-4 | retained | verbatim in `tests/main-ci.test.ts`: 05-11 exercises actor filtering, but full normalization fields still lack individual sensitivity proof |
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
| `tests/ci-infra-rerun.test.ts` | attempt 2, a test failure, a cancel, no run id, a green head and a drain all leave it to the parent | 05-4 | retained | verbatim in `tests/main-ci.test.ts`: keep the complete guard matrix; 05-4 pins the attempt-2, suite, cancel, timeout and draining outcomes |
| `tests/ci-infra-rerun.test.ts` | fail closed: an unreadable claim file or jobs listing reruns nothing; a refused rerun keeps its claim | 05-4 | mapped | the corrupt claim file asserts "unparseable"; the denied, short, empty and unparseable listings assert "run 41 jobs unreadable" with no rerun or claim; gh's refusal asserts "claimed … but gh refused" and one claim, then "was spent at" |
| `tests/after-merge.test.ts` | a merge into the deploy branch creates one blocked ops:deploy job with a frozen task file, never dispatched | 05-5 | mapped | cp_merged on a merged PR asserts exactly one deploy job with every label, `blocked_by` the merged job, `open`, its task file note and facts, the created line, the `created` record, one `after_merge_deploy` event and no fleet record; `previewDispatch` asserts profile `ops` and risk `high`, and the project-wide grant's preview asserts "would ask: risk:high". Dropping the hook fails "exactly one deploy job" |
| `tests/after-merge.test.ts` | re-recording and a crash before the record write resume onto the same single job | 05-5 | mapped | a second cp_merged asserts no `after_merge` line; with the record removed it asserts "after-merge deploy <same id> created"; after the deploy job is dropped it asserts one deploy job ("a closed deploy job still holds the key"). Creating a second job fails that count |
| `tests/after-merge.test.ts` | base mismatch, missing base and a pre-opt-in merge write skipped and create nothing; no opt-in is silent | 05-5 | mapped | gh answers base develop, no base and a 2020 `mergedAt`: each asserts its reason line, a `skipped` record and no deploy job (NC-31: dropping the opt-in date rule fails `before opt-in`); the project with no opt-in asserts no `after_merge` and no record file. Creating on a mismatch fails `["skipped", 0]` |
| `tests/after-merge.test.ts` | coverage: a named grant listing the merged job enrolls the deploy; at its cap it is refused; project-wide covers | 05-5 | mapped | real grants via the mandate store: the named grant asserts "enrolled in", its `job_ids` and `coverage: enrolled`; the capped grant "job cap 1 reached" and `none`; project-wide "covered by project-wide" and `project_wide`; the research exclusion `none`. Enrolling past the cap fails the capped `job_ids` |
| `tests/after-merge.test.ts` | a ledger refusal throws and writes no record, so the merge store names it and a retry can still create | 05-5 | retained | moved verbatim to `tests/forge-observers.test.ts` (P3b): no entry point makes the real ledger refuse a deploy job for a registered, opted-in project. 05-5 pins the retry path: a removed record resumes onto the same job |
| `tests/landing-proof.test.ts` | landed: merge, multi-commit squash, rebase onto an advanced base and a later edit, all with the branch deleted | 05-7 | mapped | cp_teardown on held local jobs asserts `landed_by_git` with `ancestry` for the merge commit, `path_tree` with 3 paths, origin's own base sha and a witness reachable at or after the squash for the two-commit squash and later edit, and the replayed commit as the rebase's witness; one `teardown_landing_proven` event each. The worktree never fetched the squash, so a proof that does not fetch the base by sha reads unknown and fails `landed_by_git`. The read-only runner guard runs with the units in `tests/forge-runtime.test.ts` |
| `tests/landing-proof.test.ts` | landed: path names with spaces, newlines and pathspec magic are compared literally | 05-7 | mapped | NC-30: without `:(literal)` the glob `star*[ab].txt` also compares origin's own `starXa.txt`, and the odd-paths job fails `landed_by_git` as `unpushed` |
| `tests/landing-proof.test.ts` | not proven: partial, near-miss and extra content never pass | 05-7 | mapped | six labelled path near misses assert unpushed. The added post-squash extra commit remains unlanded assertion compares [false,unpushed]; control L1 derives paths through HEAD^ (ignoring the final commit) and fails it with [true,undefined], reason landed_by_git. Exact patch and command below; fixed case passes |
| `tests/landing-proof.test.ts` | not proven: a stale tracking ref that held the squash is not the base origin advertises | 05-7 | mapped | the worktree's `origin/main` holds the squash while origin's main was reset past it: teardown asserts `unpushed` with "survives here only as a stale remote-tracking ref". A proof based on the tracking ref finds the squash and passes it |
| `tests/landing-proof.test.ts` | unknown: missing inputs, broken commands, odd history and every budget keep the lease | 05-7 | retained | moved verbatim to `tests/forge-runtime.test.ts` (P3b): each case bends one git answer (unreachable origin, failed fetch, shallow clone, two merge bases, a hung command) or injects a limit or clock, and no entry point exposes those seams. 05-7 pins the reachable outcomes: landed or `unpushed` |
| `tests/landing-proof.test.ts` | defaultGit kills a git that outlives its timeout and answers status null | 05-7 | retained | moved verbatim to `tests/forge-runtime.test.ts` (P3b): a git that hangs past its timeout needs an injected alias no entry point runs |
| `tests/landing-proof.test.ts` | the pre-release recheck refuses a proof whose HEAD moved or whose tree went dirty | 05-7 | retained | moved verbatim to `tests/forge-runtime.test.ts` (P3b): the window between the proof and the lease release is inside one teardown call, which no entry point can interleave a write into |
| `tests/merges.test.ts` | a merged PR is recorded from what gh reports, and the pr receipt becomes merged | 05-5 | mapped | P3c control M1 flips head_branch_deleted: the receipt tuple at landing.test.ts:760 fails, actual false versus expected true. Reproduce with the M1 patch and command in P3b review controls below; fixed case passes |
| `tests/merges.test.ts` | picp-d0p: a bound job's receipt names the PR head branch and is marked bound | 05-5 | mapped | a seeded fleet record with `bound_pr` and branch `cp-b55w` asserts `head_branch` `cp-b55w` and `bound: true` in the result and on disk. Comparing the job id instead of the bound branch fails it as "not this job's delivery" |
| `tests/merges.test.ts` | nothing is recorded for a PR gh does not call merged | 05-5 | mapped | NC-28: an open PR is not refused, and its "as open, not MERGED" match fails. The no-merge-commit and other-branch answers assert their refusals, no receipt and the PR receipt still `open` |
| `tests/merges.test.ts` | an unreachable gh refuses and names force as the honest exit | 05-5 | mapped | P3c control M2 removes force fallback advice: assertion force stays the exit for the unprovable case fails, expected /cp_teardown <job> force/. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | a job with no PR receipt must be told which PR, and an unknown job is refused | 05-5 | mapped | P3c control M3 defaults a missing PR to 77: /carries no PR receipt/ fails, actual could not read PR 77. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | an unreadable receipt is no receipt, never an exception out of a gate | 05-5 | retained | moved verbatim to `tests/forge-observers.test.ts` (P3b): `readMergeReceipt` on a missing or `../escape` id; job ids reach it only after fleet validation, so no entry point feeds it an unsafe id |
| `tests/merges.test.ts` | forge PR 2: a GitLab squash MR is recorded with its squash commit, provider and project, never through gh | 05-6 | mapped | P3c control M4 drops squash strategy inference: MR 7 receipt tuple fails, actual unknown versus expected squash. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | forge PR 3: a GitLab normal merge records its merge commit, never infers a strategy, and asks git nothing about reachability | 05-6 | mapped | MR 10 (merge and squash commits) asserts the merge commit, the source head, base `main` and `squash`; MR 11 (merge commit only) asserts strategy `unknown`. Both merge commits are absent from origin, so asking git for reachability would refuse them |
| `tests/merges.test.ts` | forge PR 2: a GitLab fast-forward MR records its head only when git sees it on the target | 05-6 | mapped | NC-29: MR 9's head is not on origin and must be refused ("names no merge commit"); once origin's main is that head it records it with strategy `unknown` and the PR receipt `merged` |
| `tests/merges.test.ts` | forge PR 2: a stored receipt for another job or branch is refused, and a crash before the fleet patch is repaired | 05-6 | mapped | P3c control M5 skips repairing an existing receipt: actual [false,false,open,1], expected [false,true,merged,1]. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | forge PR 2: a mismatched observation records nothing, and a legacy receipt with no forge block still reads | 05-6 | mapped | P3c control M6 drops the GitLab web_url repository check: /could not read PR .*\(mismatch: / fails, actual merged but names no merge commit. Exact patch and command below; fixed case passes |
| `tests/merges.test.ts` | #326: afterRecorded runs on new and existing receipts; a throwing port leaves the receipt and names the failure | 05-5 | retained | moved verbatim to `tests/forge-observers.test.ts` (P3b): the throwing port needs a ledger that refuses (see the after-merge ledger refusal). 05-5 pins the port on new and existing receipts and the quiet result with no opt-in |
| `tests/ci-watch.test.ts` | rerunwake-12z: a re-run that fails again on the same head wakes again | 05-8 | mapped | the second attempt must emit `ci_failed` under a different key; replacing actual attempts with `.1` fails `a new attempt is a new failure even on the same head` (P3c control 05-8) |
| `tests/ci-watch.test.ts` | rerunwake-12z: a green re-run after a red attempt wakes | 05-8 | mapped | NC-39 suppresses ci_green; command below exits 1 at `a green rerun follows a failed attempt`, actual undefined, expected true |
| `tests/ci-watch.test.ts` | rerunwake-12z: the same completed attempt polled twice wakes once | 05-8 | mapped | NC-40 disables red arrival deduplication; command below exits 1 at `an arrived attempt is not announced again`, actual ci_failed observation, expected [] |
| `tests/ci-watch.test.ts` | two ticks with identical facts and an observed arrival wake once | 05-8 | mapped | NC-41 disables green arrival deduplication; command below exits 1 at `an arrived green attempt is not announced again`, actual ci_green observation, expected [] |
| `tests/ci-watch.test.ts` | confirming the same key twice is a no-op | 05-8 | mapped | NC-42 disables confirmation deduplication; command below exits 1 at `arrival is idempotent`, actual repeated key, expected [] |
<!-- /manifest:assertions -->

The [P3c declaration assessment](testing-migration-p3c-declarations.md) covers all 143 declarations in the seven
partial files, retained at their original paths with `convert` owner P3c2. Five are mapped, 138 retained with
individual reasons, none redundant-unreachable. Other consumer assertions in 05-9–05-13 remain useful coverage,
but do not claim whole original declarations retired. All 23 remaining behavior-05 files stay convert: seven
owned by P3c2, the other 16 reserved for the main session's P3d.

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

These controls prove the named consumer scenarios. Only four CI-watch declarations are retired; every other
original assertion is preserved verbatim in the convert-owned retained files named in the assertion map.

## Negative controls

Each patch was applied to this worktree's `src/` (no other checkout), `npm run test:one -- tests/e2e/ci-evidence.test.ts`
run, the patch reversed, and the same command run again: 2 pass, 0 fail, 0 skipped. The bug commit is
`90c1f22ba20c416abc9fc96b04addd07e2f58ed3` (#131), which added `src/ci-run-ref.ts`. Its whole diff is not
reverted; each patch puts back one rule it introduced.

What `--verify-regressions` checks: only that each recorded patch block hashes to its sha256, and that the bug commit
exists in this repository. It does not apply the patch, and it does not rerun the e2e. The failing and fixed runs
quoted below were run by hand when each control was recorded, and they are evidence only to that extent.

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
| NC-38 | `tests/awaiting-merge-tick.test.ts` | 8ed23aa09e14395777c9ed86f280e7b9d3478556 | 05-12 | NC-36 | 160bf6227e64578fad081ed6325566424cfc0a28ad79d50f6538fefc07dca69b | timed out waiting for parked green through extension timer; exact lock/shutdown assertions retained verbatim | pass |
| NC-39 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-39 | 3b171a4343a649cf97b5484d8436b270652f31a73e48043823d6d88cac71728b | a green rerun follows a failed attempt: actual undefined, expected true; exit 1 | pass |
| NC-40 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-40 | 89140ecdb7e179ded4475bbae1fdd8503bc7d6e1c498391bc5373e5cff3175a6 | an arrived attempt is not announced again: actual ci_failed observation, expected []; exit 1 | pass |
| NC-41 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-41 | 3247052c5ba325182bb6bc40b10310d9ba19c3efca12adaaaf82021ae65325e8 | an arrived green attempt is not announced again: actual ci_green observation, expected []; exit 1 | pass |
| NC-42 | `tests/ci-watch.test.ts` | 7f63e8205c6ee5e573aefd816725c389a1c2bb72 | 05-8 | NC-42 | bdf24d76db79fa3de72985fd27fdf823b0e03b824e3f2f3c8b6198f67ffe563b | arrival is idempotent: actual repeated key, expected []; exit 1 | pass |
<!-- /manifest:regressions -->

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
| `tests/after-merge.test.ts` | deleted | P3b | 5 declarations: scenario 05-5 (Assertion map); one unit retained in `tests/forge-observers.test.ts`; NC-31 |
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
| `tests/awaiting-merge-tick.test.ts` | convert | P3c2 | behavior 05; both declarations retained with individual reasons in testing-migration-p3c-declarations.md; original path restored |
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
| `tests/ci-evidence.test.ts` | convert | P3c2 | behavior 05; five declarations retained with individual reasons in testing-migration-p3c-declarations.md; original path restored |
| `tests/ci-host-tools.test.ts` | exception | P1 | guard: CI never silently skips treehouse acceptance; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-infra-rerun.test.ts` | deleted | P3 | 4 declarations: scenario 05-4 (Assertion map); two units retained in `tests/main-ci.test.ts`; NC-27 |
| `tests/ci-run-ref.test.ts` | deleted | P0 | 10 assertions mapped, 4 redundant-unreachable; negative controls NC-01..NC-03 |
| `tests/ci-wait.test.ts` | exception | P1 | contract: worker report-and-stop policy and guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-watch.test.ts` | convert | P3c2 | behavior 05; 5 declarations mapped to 05-8 with individual controls, 75 retained; all 80 stay in this partial file; testing-migration-p3c-declarations.md |
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
| `tests/foreign-ci-watch.test.ts` | convert | P3c2 | behavior 05; eleven declarations retained with individual reasons in testing-migration-p3c-declarations.md; original path restored |
| `tests/forge-observers.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/forge-runtime.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/forge-url.test.ts` | exception | P1 | security: exhaustive hostile-input guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/gate-replacement.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gate.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/gateway-key.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/guards.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/held-release.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/home-checkout.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/human-handoff.test.ts` | convert | P18 | behavior 18 (Dashboard navigation and jobs) |
| `tests/install-nudge.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/install-tools.test.ts` | convert | P14 | behavior 15 (Install, service, doctor) |
| `tests/intake-settle-atomicity.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/intake.test.ts` | convert | P9 | behavior 11 (Operator to parent delivery) |
| `tests/integrate-held-ci.test.ts` | convert | P3c2 | behavior 05; three declarations retained with individual reasons in testing-migration-p3c-declarations.md; original path restored |
| `tests/integrate.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/job-skills.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/jobs-tool.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/json-store.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/landing-proof.test.ts` | deleted | P3b | 7 declarations: scenario 05-7 (Assertion map); three units retained in `tests/forge-runtime.test.ts`; NC-30 |
| `tests/layout-capture.test.ts` | exception | P1 | contract: assembled layout; operator ask-0088e0332d00 (Exceptions) |
| `tests/layout-flat.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/leases.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/ledger-import.test.ts` | deleted-with-feature | #379 | tested `src/ledger-import.ts` |
| `tests/ledger.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/live-harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/main-ci.test.ts` | convert | P3c2 | behavior 05; all 39 declarations retained, including P3/P3b inheritances; individual reasons in testing-migration-p3c-declarations.md |
| `tests/mandate-defaults.test.ts` | deleted | P2c | behavior 02: every assertion mapped to 02-8 or redundant-unreachable (Assertion map); negative control NC-12 |
| `tests/mandate-selection.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-16 |
| `tests/mandate-supplement.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-12 (Assertion map); negative control NC-17 |
| `tests/mandate-usage.test.ts` | deleted | P2d | behavior 02: every assertion mapped to 02-13 or redundant-unreachable (Assertion map); one source scan kept in `tests/structure.test.ts`; negative control NC-18 |
| `tests/mandate.test.ts` | deleted | P2e | 61 declarations: scenarios 02-1 to 02-17 (Assertion map); eight units retained in `tests/decide.test.ts` (P10); NC-05, NC-06, NC-11, NC-21 to NC-23 |
| `tests/mcp-access.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/memory.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/merge-ask.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merge-permission.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merges.test.ts` | deleted | P3b | 12 declarations: scenarios 05-5 and 05-6 (Assertion map); two units retained in `tests/forge-observers.test.ts`; NC-28, NC-29 |
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
| `tests/parked-ci.test.ts` | convert | P3c2 | behavior 05; three declarations retained with individual reasons in testing-migration-p3c-declarations.md; original path restored |
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
| `tests/review-context.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/review-merge-window.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/review-runs.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/review-tool.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
