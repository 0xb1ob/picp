# Unit → e2e test migration manifest

The auditable record of the unit-to-e2e programme: every test file in the pinned baseline gets exactly one
disposition, every deleted unit assertion maps to an e2e scenario, and every deleted regression test carries a
negative control (the old defect patched back fails the e2e, the fix passes it). `scripts/test-migration-check.ts`
validates this file and the per-slice ledger against git; it imports no production code.

The ledger rows are moving out of this file, one file per slice, into `docs/testing-migration/<slice>.md`: that
slice's rows of the eight `manifest:*` tables. The checker reads this file and every
slice file as one union, so duplicate ids and the baseline counts are checked across both. A new slice adds its own
file. `node scripts/split-migration-ledger.ts --list | <slice...>` moves rows mechanically; never hand-move them.

```
node scripts/test-migration-check.ts --base 0a4a8944dd7292e458dbd2ec4afbf6d2b89d197e --manifest docs/testing-migration.md
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
| `deleted` | Removed; every assertion mapped, narrowed (with `Narrowed:`) or redundant-unreachable, and a negative control recorded | assertion map + regression row |
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

Each PR's ledger row lives only in its own slice file, `docs/testing-migration/<slice>.md`, under this section's
header; the checker refuses a row here and a second row for the same PR. Record no running totals: the checker computes
and prints the baseline's and the live tree's file and declaration counts on every run. Older rows keep their recorded
`Files (tree)` and `Static declarations (tree)` cells as history. A new e2e file needs no `scripts/test-timings.json`
entry: `npm run check:shards` weighs an untimed file at the table's median.

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
<!-- /manifest:ledger -->

S06 foreign-watch proof: V8 e2e-only captures on both sides of deletion each include nine product processes and
cover 338 lines of `src/foreign-ci-watch.ts`, with no gained or lost lines. Comparing the direct unit capture to e2e
gives nine apparent lost lines,
373–381, all in `formatForeignCiNotice`: pi transforms extension imports, so raw child V8 offsets alone do not
prove source-mapped coverage of that formatter. S06-1 instead pins its actual operator RPC/UI notice: the foreign
PR URL, green head, and evidence-only disclaimer. The retained test covers static import/port inspection.
S06-timeout and S06-moved are semantic mutations run against the real entry-point scenarios; both fail their
named assertions and the fixed 15-case file passes without skips before and after deleting the source file.

S06 forge-runtime proof: the three retained regression bodies are unchanged. E2e-only V8 captures before/after
retirement each include nine product processes and cover 94 lines of `src/forge-runtime.ts`, with no lost or gained
lines. The fixed landing file passes
17/17 without skips; the retained file passes 3/3. Legacy-fallback and configured-trunk controls fail the
actual merge recording and teardown outcome, respectively.

S02 follows the operator's split-file amendment: a range slice adds consumer evidence without removing or moving any
unit declaration. At S02 delivery, `tests/ci-watch.test.ts` remained 80 static declarations / 89 executed cases.
Of S02's 40, 36 map to five scenarios and extended 05-8; four helper-only contracts (6/8/32/33)
remain retained. S10b preserves those four plus S03's synchronous callback contract (70), maps 71 after #443,
and retires the duplicate original. [Final accounting and controls](testing-migration/s10b.md) supersede
the split slices' keep-whole instructions; no retained contract is claimed as removed coverage.
S02 records 24 controls (eight initial plus sixteen review controls); every mapped declaration cites an executed
control in the regression table. All source mutations were restored. No original unit coverage is removed.

P0 deletes `tests/ci-run-ref.test.ts` (3 declarations) and adds `tests/e2e/ci-evidence.test.ts` (2). Ten of the
unit file's 14 assertions are pinned by a scenario. The other four cannot reach a public consumer and are
`redundant-unreachable`, as approved by the main session under ask-0088e0332d00 on 2026-10-20. Incoming files
from the parallel E2E A/B/C jobs are listed under Incoming as they land, not in the baseline. The P0 counts are
taken on P0's base. They start at 4,488, not 4,487, because
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
legacy fire grant and draining schedule run go to `tests/schedule-authority-retained.test.ts`, because no fire mints a grant or a
legacy run any more. The supplement's path and subsystem exclusions went to `tests/decide.test.ts`, because P2d drove
no pipeline auto-decide; P2e drives them there (02-15) and removes that unit. The P2c review's lows: 02-7 names the
`acceptedRiskMatches` consumer that pins the low-risk row (Assertion map), and 02-6's `recordRecoveryAttempt` comment
is two lines.
`tests/e2e/authority.test.ts` joins R1_ALLOWED in place of `tests/quota.test.ts`: 02-14 writes the legacy top-level
`data/capacity.json` that cp-u3i2 must ignore. P2d's declaration count is 4,346, not 4,344: it added one declaration
each to `tests/decide.test.ts` and `tests/schedule-authority.test.ts`, both since deleted (their declarations live on in
`tests/decide-retained.test.ts` and `tests/schedule-authority-retained.test.ts`) (P2e review finding).

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
The throwing-runner `ghCiConfigured` coverage now lives in S13-workflows in `tests/e2e/merge-ask.test.ts` ([retirement ledger](testing-migration/s13.md)). Plan and tree disagree once: the infra rerun's drain
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
- 1 host-integration file, added after the 36 above: `tests/pi-hashline-compaction.test.ts`. Reason: host-integration:
  needs the host-installed pi-hashline-edit-pro; self-skips without it. Decision: main session, es-077c7d. Ledger
  rows: [`docs/testing-migration/s25.md`](testing-migration/s25.md#operator-approved-non-e2e-exception).

Pairing, remote authorization and MCP access are not exceptions. They convert, and every negative assertion in them
moves first.

## CI-skipped tests

Every test the main CI test shards skip, with its reason (main run on 4ac2840b). Treehouse-gated tests
(`treehouseAvailable()`) run on CI: `tests/ci-host-tools.test.ts` fails the run without treehouse. No skipped e2e
case is cited as `covered-by` for a deleted baseline file, so none is a coverage gap.

| File | Skipped tests | Reason |
|---|---|---|
| `tests/e2e/installer.test.ts` | the installer sandbox suite | opt-in `CP_INSTALL_E2E=1`; CI's `install sandbox` job runs it |
| `tests/e2e/live.test.ts` | live (a)–(f) and the spend report | `CP_LIVE_TESTS=1`, operator-run real models only |
| `tests/e2e/live-smoke.test.ts` | live smoke m1–m3 | `CP_LIVE_TESTS=1`, operator-run real models only |
| `tests/e2e/questions.test.ts` | the two t31 planner-question cases | always skipped: ask_operator left the planner path (cur.3.1); `tests/e2e/planner-blocked.test.ts` covers the successor |
| `tests/pi-hashline-compaction.test.ts` | manual and threshold compaction, 4 cases | pi-hashline-edit-pro is not installed on CI (host-integration exception above) |
| `tests/web-access.test.ts` | the installed pi-web-access lazy-loader case | pi-web-access is not installed on CI |
| `tests/worker-packages-retained.test.ts` | the really-installed optional package case | neither optional package is installed on CI |

## Scenarios

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
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
`narrowed` names the scenario that pins part of the assertion; its note says `Narrowed:` and names the uncovered part.
Claim count: for each `mapped` row of a deleted file, the static `assert`/`assert.x`/`t.assert.x`/`expect` calls in the
e2e `test(…)` bodies its Scenario names and its `covered-by: file.ts:line` lines land in (each body once, summed over
rows naming the same case) must be at least those in that literal `test("<Assertion>")` body at the file's
pre-deletion revision, unless a note says `Narrowed:`. A new or edited row fails when short. A short case whose rows
are all byte-identical to rows at `CLAIM_SINCE` (the script's pin, `--claim-since <ref>` overrides; unreachable, the
merge-base with origin/main, else the gate is skipped with a WARN) only warns. An unchanged row citing no
`covered-by:` line is legacy format and not counted.
`Narrowed:` exempts a short case because it already names the uncovered part, which a count cannot judge.

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
<!-- /manifest:assertions -->

### Pending-fix declarations (parked or product-blocked; no deletion credit)

| File | Declaration | Status | Evidence and expected outcome |
|---|---|---|---|
| `tests/integrate.test.ts` | 92 dirty worktree | mapped by S10b | [Current mapping and executed control](testing-migration/s10b.md); original file retired by cp-xwu0 ([S11b](testing-migration/s11b.md)). |
| `tests/ci-watch.test.ts` | 71 distinct watch-failure causes | mapped by S10b | [Current mapping and executed control](testing-migration/s10b.md); real-parent two-cause case passes with #443. |

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
`npm run test:one -- --test-name-pattern='cp_merged records only' tests/e2e/landing-forge-ci.test.ts`;
M4–M6 use `npm run test:one -- --test-name-pattern='cp_merged reads a GitLab' tests/e2e/landing-forge-ci.test.ts`;
L1 uses `npm run test:one -- --test-name-pattern='cp_teardown passes a deleted branch' tests/e2e/landing-forge-ci.test.ts`.
Every run exited 1 with one failing case and no skips; failures below are observed output, not predictions.

| Control | Bug patched back | Observed failure |
|---|---|---|
| M1 | `src/merges.ts` records `head_branch_deleted` as the remote branch's presence, not its absence | receipt tuple: actual `head_branch_deleted: false`, expected `true` |
| M2 | `src/merges.ts` drops the `cp_teardown <job> force` fallback advice from the unprovable refusal | `AssertionError: force stays the exit for the unprovable case`; expected `/cp_teardown <job> force/` |
| M3 | `src/merges.ts`: a missing PR defaults to 77 | expected `/carries no PR receipt/`, actual `could not read PR 77` |
| M4 | `src/merges.ts` records every GitLab merge strategy as unknown, never inferring squash | MR 7 receipt tuple: actual `unknown`, expected `squash` |
| M5 | `src/merges.ts` never marks an existing receipt merged when repairing it | receipt repair tuple: actual `[false,false,'open',1]`, expected `[false,true,'merged',1]` |
| M6 | `src/forges/gitlab.ts` skips the web_url same-project merge request check | expected `/could not read PR .*\(mismatch: /`, actual `merged but names no merge commit` |
| L1 | `src/landing-proof.ts` derives changed paths through `HEAD^`, ignoring the final commit | `post-squash extra commit remains unlanded`: actual `[true,undefined]` (`landed_by_git`), expected `[false,'unpushed']` |

### P3c CI-watch negative controls

Each command uses `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing-*.test.ts`.
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

A negative control is proven by running it: put the bug back in `src/`, run the scenario's e2e file with
`npm run test:one`, see the named assertion fail, remove the bug and see it pass again. Nothing of that run is committed.

A negative-control row needs only the scenario, the control (the bug patched back, in words) and the failing
assertion: `| ID | Unit file | Scenario | Control | Failing assertion |`. Record no patch, commit sha or hash; the
checker reads an older 8-cell row's Patch cell (a patch id or the control in words) as its control, fails it when
empty, and verifies none of the row's other cells.

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|

<!-- /manifest:regressions -->

## Incoming

Test files added after the baseline, with the PR that owns them.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/wake-ci-promoted.test.ts | cp-fix-promoted-ci-notice-dropped-z1n7 (https://github.com/0xb1ob/picp/pull/473) | S22 fix-job regression: a promoted job's CI notice keeps its promotion note at the provider |
| tests/e2e/mandate-continuity.test.ts | cp-iojy (https://github.com/0xb1ob/picp/pull/504) | Original admission, authenticated confirmation, shared-root successors and PASS-bound handoff |
| tests/e2e/review-policy-escalation.test.ts | cp-fin-promote-haql (https://github.com/0xb1ob/picp/pull/603) | Policy review escalate surfaces one escalation; an operator-quote cp_decide clears that head only, a push voids it |
| tests/e2e/validated-reads.test.ts | cp-lag-f2-zic7 (https://github.com/0xb1ob/picp/pull/602) | F2 perf: unchanged schedule-run and mandate text is validated once; invalid or changed text never skips validation |
| tests/e2e/ci-watch-nongithub.test.ts | cp-ci-watch-nongithub-jt2p (https://github.com/0xb1ob/picp/pull/635) | main, held-PR, foreign-PR and merge-ask gh CI readers skip a non-GitHub project with no forge (one log line, no wake); GitHub projects are still read and wake |
| tests/e2e/worker-isolation.test.ts | cp-issue-576-ycpj (https://github.com/0xb1ob/picp/pull/636) | #576: a worker's memory-capped systemd scope, its unscoped fallback and the detached backend; no viewer outlives a SIGKILLed runner |
| tests/e2e/parent-boot-timeout.test.ts | cp-537-pr4-1e47 (https://github.com/0xb1ob/picp/pull/649) | #537 fix 3: the parent's cold-start get_state budget scales with its session file; the boot phase is logged and a timeout names size and budget |
| tests/e2e/armed-dispatch-wake.test.ts | cp-issue-647-impl-vqvg (PR URL on the branch) | #647: an armed dispatch dropped at release wakes the parent with ARMED DISPATCH DROPPED and leaves no stub status.json |
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
<!-- /manifest:baseline -->
