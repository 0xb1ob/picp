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
| P2b | 02 | `tests/e2e/authority.test.ts` | extends 02-1 to 02-4 |
| P3 | 05 | `tests/e2e/landing.test.ts` | 6 |
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
<!-- /manifest:scenarios -->

Both run a real CommandPost with continuation on (the in-process host `tests/e2e/mission.test.ts` uses), real
implementer workers and reporter on a treehouse pool, a mock LLM, scratch git, and a scripted `gh` on PATH. The
consumers under test are the CI watch tick and its wake text (`src/ci-watch.ts`), the held-PR continuation's
`cp_integrate` record (`src/integrate-held.ts`, `src/integrate.ts`), and the promote the implementer receives.

## Assertion map

Disposition `mapped` names the scenario that pins the same behaviour at a public consumer. `redundant-unreachable`
means no public consumer can feed the helper that input today. The named scenario pins the consumer-visible
outcome of that path instead (see Method). `unreachable`, with no pinning scenario, blocks the file's deletion.

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
<!-- /manifest:assertions -->

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

## Incoming

Test files added after the baseline, with the PR that owns them.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/ci-evidence.test.ts` | P0 | behavior 01, scenarios 01-1 and 01-2 |
| `tests/e2e/authority.test.ts` | P2 | behavior 02, scenarios 02-1 to 02-4 |
| `tests/viewer-job-report.test.ts` | #380 | unit test landed on main after the baseline (viewer job report pages); recorded by P2 so the check stays at 0 findings, disposition left to its behavior's PR |
| `tests/e2e/retired-integration.test.ts` | cp-remove-beads-pr1-0f3z | existing-home compatibility after the tracker removal |
| `tests/test-migration-check.test.ts` | cp-remove-beads-pr1-0f3z | exception (verification integrity, like `tests/test-file-guard.test.ts`; operator ask-0088e0332d00 (Exceptions)): tests `scripts/test-migration-check.ts` itself, which no product entry point reaches, so it has no e2e consumer path; covers accept and reject paths of `deleted-with-feature` and `feature-removed` |
<!-- /manifest:incoming -->

## Feature-removed

Declarations a kept baseline file lost with a removed production feature (see Method). One row per lost title.

<!-- manifest:feature-removed -->
| Unit file | Declaration | Removed by | Note |
|---|---|---|---|
| `tests/jobs-tool.test.ts` | parseJobsArgs: ready by default, list flags, show needs an id, import-beads | cp-remove-beads-pr1-0f3z (#379) | importer subcommand removed; the rest is kept under a new title |
| `tests/jobs-tool.test.ts` | cp_job create auto-links a job whose br ref names a bead on the active connection, and says why otherwise (laf) | cp-remove-beads-pr1-0f3z (#379) | tracker auto-link removed |
| `tests/trackers-ledger.test.ts` | createTracked mints exactly one job per (connection_id, item_id), even under concurrency | cp-remove-beads-pr1b-t68e | `Ledger.createTracked` removed with tracker import |
| `tests/trackers-ledger.test.ts` | closed and dropped linked jobs still dedupe; equal titles on different keys are distinct jobs | cp-remove-beads-pr1b-t68e | `Ledger.createTracked` removed with tracker import |
| `tests/trackers-ledger.test.ts` | an open unlinked job with the same ref is refused, never linked automatically | cp-remove-beads-pr1b-t68e | `Ledger.createTracked` removed with tracker import |
| `tests/worker-beads.test.ts` | a worker's BEADS_DIR comes only from dispatch, never the home's .beads or the parent environment | cp-remove-beads-pr1b-t68e | dispatch database injection removed; the parent-env strip is kept under a new title |
| `tests/task-references.test.ts` | resolves own-prefix beads and pinned external refs once, preserving text | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | missing beads and unavailable br are explicit nonfatal material | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | unavailable br names a custom-prefix bead even without another reference | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | br down never turns read-only or follow-up prose into references | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | reads real br show JSON using the configured prefix | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | bead responses accept legacy objects and diagnose malformed output | cp-remove-beads-pr1b-t68e | worker bead snapshots removed |
| `tests/task-references.test.ts` | bare references use only the resolved project database, never the home's | cp-remove-beads-pr1b-t68e | worker bead snapshots and database injection removed |
| `tests/dispatch.test.ts` | dispatch snapshots referenced beads for the worker and reviewers, including missing refs | cp-remove-beads-pr1b-t68e | worker bead snapshots and database injection removed |
| `tests/projects.test.ts` | cp_project add readiness: delivery:local wording, a connected tracker, and a throwing probe never fails add | cp-remove-beads-pr1b-t68e | tracker readiness line removed; the rest is kept under a new title |
| `tests/jobs-tool.test.ts` | create verifies the selected project's pinned database before recording array beads | cp-remove-beads-pr1b-t68e | command-ref verification removed |
| `tests/jobs-tool.test.ts` | a bare ref is not pinned to or verified against the home database, while explicit pins win | cp-remove-beads-pr1b-t68e | command-ref pinning removed |
| `tests/jobs-tool.test.ts` | cp_job create: a br show ref with status closed refuses | cp-remove-beads-pr1b-t68e | command-ref verification removed |
| `tests/jobs-tool.test.ts` | picp-t4n: an answered legacy override admits only its deferred bead and records the es | cp-remove-beads-pr1b-t68e | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: aggregated overrides bind exact pinned deferred refs, never another bead, DB, project or mismatch | cp-remove-beads-pr1b-t68e | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: a capped question cannot authorize an undisclosed deferred ref | cp-remove-beads-pr1b-t68e | deferred-bead admission override removed |
| `tests/jobs-tool.test.ts` | picp-t4n: only an answered override on this admission escalation counts | cp-remove-beads-pr1b-t68e | deferred-bead admission override removed |
| `tests/verify-external-ref.test.ts` | br show ref: closed status is a mismatch; open is not | cp-remove-beads-pr1b-t68e | command-ref verification removed |
| `tests/verify-external-ref.test.ts` | br --db pinned ref: the db path is unquoted and passed through as one arg | cp-remove-beads-pr1b-t68e | command-ref verification removed |
| `tests/verify-external-ref.test.ts` | br arrays preserve open and closed states; malformed responses stay diagnostic | cp-remove-beads-pr1b-t68e | command-ref verification removed |
| `tests/doctor.test.ts` | ledger.beads_archive: a leftover .beads/ beside a populated document is a warning that says it is safe to delete | cp-remove-beads-pr1b-t68e | import and live-connection advice removed; kept under a new title, which cp-remove-beads-pr2-6exd replaced with the `storage.retired_integration` case |
| `tests/doctor.test.ts` | ledger.beads_archive: a .beads/ that an active tracker connection uses is ok and never advised for deletion | cp-remove-beads-pr1b-t68e | tracker connections removed |
| `tests/ledger.test.ts` | normalizeExternalRef pins a bare `br show <id> --json`, shell-quoted; every other shape passes through unchanged | cp-remove-beads-pr1b-t68e | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | create pins a bare br show ref to the project's beads DB when the caller wires one | cp-remove-beads-pr1b-t68e | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | an older job stored with a bare br show ref reads pinned through every query path, with no write and no updated_at bump | cp-remove-beads-pr1b-t68e | read-time ref projection removed |
| `tests/ledger.test.ts` | a closed job with a bare br show ref is projected pinned through history() and blocked() | cp-remove-beads-pr1b-t68e | read-time ref projection removed |
| `tests/ledger.test.ts` | the pinned form runs from a fresh leased worktree with no .beads/; the bare form does not (root cause, not just the string) | cp-remove-beads-pr1b-t68e | command-ref pinning removed; refs are opaque |
| `tests/ledger.test.ts` | the stored ref is one valid shell word even when the project's checkout path has a space in it | cp-remove-beads-pr1b-t68e | command-ref pinning removed; refs are opaque |
| `tests/guards.test.ts` | the ledger has no bash surface any more: br-shaped commands are neither blocked nor special | cp-remove-beads-pr2-6exd | product-named commands replaced by generic ones; kept under a new title |
| `tests/guards.test.ts` | only the home's own .beads/ is never-commit; a project worktree tracks its .beads/ | cp-remove-beads-pr2-6exd | home directory never-commit exception removed (`src/guards.ts`, `src/contracts/layout.ts`); the any-cwd runtime-root case moved into the staging test |
| `tests/doctor.test.ts` | the one runtime root plus .beads covers runtime state | cp-remove-beads-pr2-6exd | never-commit exception removed; kept under a new title |
| `tests/contracts.test.ts` | layoutFor(multi) keeps one root; neverCommitFor(multi) lists .beads | cp-remove-beads-pr2-6exd | never-commit exception removed; kept under a new title |
| `tests/storage.test.ts` | a home with only .pi-command-post/, .beads/ and .gitignore is one ok storage finding | cp-remove-beads-pr2-6exd | known-directory allowance removed (`src/storage.ts`); kept under a new title |
| `tests/service-install.test.ts` | install: the br prompt defaults to no, to yes with a beads tracker; --with-br / --no-br answer it | cp-remove-beads-pr2-6exd | optional CLI prompt, probe and flags removed (`src/service/install.ts`, `src/tool-manifest.ts`) |
| `tests/service-install.test.ts` | install: tmux and br missing, gh logged out and no provider login are reported, never fatal | cp-remove-beads-pr2-6exd | optional CLI step removed; kept under a new title |
<!-- /manifest:feature-removed -->

## Baseline

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/actions-ci-policy.test.ts` | exception | P1 | contract: disallowed forge read surface; operator ask-0088e0332d00 (Exceptions) |
| `tests/actions-ci.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/after-merge.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/awaiting-merge-tick.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/capacity.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/checkpoint-root.test.ts` | convert | P11 | behavior 10 (Research pipeline/artifacts) |
| `tests/ci-access.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/ci-configured.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/ci-evidence.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/ci-host-tools.test.ts` | exception | P1 | guard: CI never silently skips treehouse acceptance; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-infra-rerun.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/ci-run-ref.test.ts` | deleted | P0 | 10 assertions mapped, 4 redundant-unreachable; negative controls NC-01..NC-03 |
| `tests/ci-wait.test.ts` | exception | P1 | contract: worker report-and-stop policy and guard; operator ask-0088e0332d00 (Exceptions) |
| `tests/ci-watch.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/foreign-ci-watch.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/integrate-held-ci.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/integrate.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/job-skills.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/jobs-tool.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/json-store.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/landing-proof.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/layout-capture.test.ts` | exception | P1 | contract: assembled layout; operator ask-0088e0332d00 (Exceptions) |
| `tests/layout-flat.test.ts` | convert | P16 | behavior 14 (Home, routing, settings) |
| `tests/leases.test.ts` | convert | P7 | behavior 03 (Dispatch, dependency and slots) |
| `tests/ledger-import.test.ts` | deleted-with-feature | cp-remove-beads-pr1-0f3z (#379) | tested `src/ledger-import.ts` |
| `tests/ledger.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/live-harness.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
| `tests/main-ci.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/mandate-defaults.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/mandate-selection.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/mandate-supplement.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/mandate-usage.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/mandate.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/mcp-access.test.ts` | convert | P24 | behavior 24 (Packaging and host compatibility) |
| `tests/memory.test.ts` | convert | P23 | behavior 23 (Memory and guidance) |
| `tests/merge-ask.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merge-permission.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
| `tests/merges.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/ops-jobs.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
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
| `tests/parked-ci.test.ts` | convert | P3 | behavior 05 (Review, CI and merge) |
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
| `tests/quota.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/ready-beads.test.ts` | deleted-with-feature | cp-remove-beads-pr1b-t68e | tested `src/ready-beads.ts`, `src/trackers/config.ts` |
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
| `tests/risk-batch.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/risk-negation.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/risk-preapproval.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
| `tests/risk-warning.test.ts` | convert | P2b | behavior 02 (Mandate, budgets and authority); left by the P2 first slice to P2b (cp-e2e-migration-p2b-3e1w) |
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
| `tests/trackers-beads.test.ts` | deleted-with-feature | cp-remove-beads-pr1b-t68e | tested `src/trackers/beads.ts`, `src/trackers/adapter.ts` |
| `tests/trackers-config.test.ts` | deleted-with-feature | cp-remove-beads-pr1b-t68e | tested `src/trackers/config.ts`, `src/contracts/trackers.ts` |
| `tests/trackers-import.test.ts` | deleted-with-feature | cp-remove-beads-pr1-0f3z (#379) | tested `src/trackers/import.ts` |
| `tests/trackers-ledger.test.ts` | convert | P15 | behavior 13 (Ledger, projects and trackers) |
| `tests/trackers-link.test.ts` | deleted-with-feature | cp-remove-beads-pr1-0f3z (#379) | tested `src/trackers/link.ts`, `src/trackers/sync.ts` |
| `tests/trackers-sync.test.ts` | deleted-with-feature | cp-remove-beads-pr1-0f3z (#379) | tested `src/trackers/sync.ts`, `src/trackers/sync-store.ts` |
| `tests/trackers-tool.test.ts` | deleted-with-feature | cp-remove-beads-pr1-0f3z (#379) | tested `extensions/command-post/tools-tracker.ts`, `src/trackers/sync-store.ts` |
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
| `tests/worker-beads.test.ts` | convert | P8 | behavior 04 (Worker lifecycle and recovery) |
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
