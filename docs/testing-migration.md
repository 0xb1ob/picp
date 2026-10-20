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
| `pending` | Not yet decided; P1 completes the manifest | none |
| `e2e` | Already an e2e acceptance file (`tests/e2e/`) | the reason it stays |
| `retained` | Kept on purpose; not deletable yet | the reason and a link |
| `exception` | Structural, golden, contract or security check kept by policy | the policy link |
| `deleted` | Removed; every assertion mapped and a negative control recorded | assertion map + regression row |

## PR ledger

| PR | Scope | Baseline files deleted | Files (tree) | Static declarations (tree) |
|---|---|---|---|---|
| P0 (cp-e2e-migration-p0-pilot-xp6x) | behavior 01; this manifest; the check script | 0 | 400 → 401 | 4,488 → 4,490 |

P0 was planned as 400 → 400 files and 4,487 → 4,486 declarations, with `tests/ci-run-ref.test.ts` deleted. The
deletion did not happen: four of its assertions cannot reach a public consumer (see the assertion map). The plan
says such an assertion keeps the file "until a genuine boundary contract or approved redundant-case disposition
exists". Incoming files from the parallel E2E A/B/C jobs are listed under Incoming as they land, not in the
baseline. The P0 counts are on P0's base (`af46cfbf091439d98138f35c80254e74e484ee75`); they start at 4,488,
not 4,487, because `tests/e2e/planner-blocked.test.ts` gained one declaration after the pinned baseline. Baseline
files keep changing on main, so the checker prints the live tree's counts rather than trusting this row
(after merging main at `52d14e3`: 401 files, 4,496 declarations).

## Scenarios

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 01-1 | `tests/e2e/ci-evidence.test.ts` | ci evidence: wake, cp_integrate and the promote name only the current head's failing run, and none once it is gone |
| 01-2 | `tests/e2e/ci-evidence.test.ts` | ci evidence: absent head, absent run id, a branch-name PR ref and an enterprise host never fabricate an Actions link |
<!-- /manifest:scenarios -->

Both run a real CommandPost with continuation on (the in-process host `tests/e2e/mission.test.ts` uses), real
implementer workers and reporter on a treehouse pool, a mock LLM, scratch git, and a scripted `gh` on PATH. The
consumers under test are the CI watch tick and its wake text (`src/ci-watch.ts`), the held-PR continuation's
`cp_integrate` record (`src/integrate-held.ts`, `src/integrate.ts`), and the promote the implementer receives.

## Assertion map

Status `mapped` names the scenario that pins the same behaviour at a public consumer. Status `unreachable` means no
public consumer can feed the helper that input today, so the e2e can only pin the consumer outcome.

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Status | Note |
|---|---|---|---|---|
| `tests/ci-run-ref.test.ts` | failedRunOn picks the completed failure on HEAD over another head's failure | 01-1 | mapped | wrong-head failure (older sha) never named; run 6 on the pushed head is |
| `tests/ci-run-ref.test.ts` | failedRunOn skips skipped, neutral and success runs | 01-1 | mapped | runs 2-4 precede run 6; negative control NC-01 |
| `tests/ci-run-ref.test.ts` | failedRunOn skips an in_progress run | — | unreachable | a failed verdict needs every head run complete: with run 7 in_progress beside run 6 the watch emits no ci_failed |
| `tests/ci-run-ref.test.ts` | failedRunOn is undefined when only green or unfinished runs exist | 01-1 | mapped | unfinished and fixed phases: no run reference in facts, reason or wake |
| `tests/ci-run-ref.test.ts` | failedRunOn is undefined for an undefined head | — | unreachable | every consumer passes a string head; with no head cp_integrate stops at "no head commit" (pinned by 01-2) |
| `tests/ci-run-ref.test.ts` | runUrl derives the github.com Actions URL from the PR URL | 01-1 | mapped | exact (run 6 https://github.com/example/demo/actions/runs/6) in wake, fact and promote |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for an enterprise host | 01-2 | mapped | ghe.example.com: run 16 by id only; negative control NC-03 |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for a branch-name PR ref | 01-2 | mapped | cp_integrate with the branch as its PR ref: (run 17) and no link |
| `tests/ci-run-ref.test.ts` | runUrl is undefined for an undefined PR URL | — | unreachable | cp_integrate passes `view.url ?? pr`, always a string; the watch's `pr?.url` absence is not exercised |
| `tests/ci-run-ref.test.ts` | ciRunRef + formatRunRef render the id and URL of a github.com failure | 01-1 | mapped | negative controls NC-01 and NC-02 |
| `tests/ci-run-ref.test.ts` | ciRunRef gives the id alone for an enterprise host | 01-2 | mapped | wake observation run_id 16, run_url absent |
| `tests/ci-run-ref.test.ts` | formatRunRef of an id alone is " (run N)" | 01-2 | mapped | (run 16) and (run 17) at the end of the ci fact |
| `tests/ci-run-ref.test.ts` | ciRunRef of a legacy run without databaseId is {} | — | unreachable | readActionsCi refuses an id-less row, so no consumer sees one; 01-2 pins "could not read CI", no reference |
| `tests/ci-run-ref.test.ts` | formatRunRef of {} is "" | 01-1 | mapped | held facts for superseded, in_progress and green heads carry no reference |
<!-- /manifest:assertions -->

## Negative controls

Each patch was applied to this worktree's `src/` (no other checkout), `npm run test:one -- tests/e2e/ci-evidence.test.ts`
run, the patch reversed, and the same command run again: 2 pass, 0 fail, 0 skipped. The bug commit is
`90c1f22ba20c416abc9fc96b04addd07e2f58ed3` (#131), which added `src/ci-run-ref.ts`. Its whole diff is not
reverted; each patch puts back one rule it introduced.

<!-- manifest:regressions -->
| ID | Unit file | Bug commit | Scenario | Patch | sha256 | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-01 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-01-green | e5cc55b97d22e820228a709e858fbe2f7294fcc8dce00aa980f63982c09660f3 | wake observation names run 2 (skipped), not run 6 | pass |
| NC-02 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-1 | NC-02-integrate | 0a2c3b3942c839731d201a0a07d8ddf2c6bf6ea2d6163d5a00430568bb3d6e86 | the ci fact does not end with (run 6 …/actions/runs/6) | pass |
| NC-03 | `tests/ci-run-ref.test.ts` | 90c1f22ba20c416abc9fc96b04addd07e2f58ed3 | 01-2 | NC-03-host | 0bb48b55ddc16d72b68109e136da58d310bb118ebbe641f411e9ba7980ef6ac0 | the enterprise ci fact links ghe.example.com/…/actions/runs/16 | pass |
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

## Incoming

Test files added after the baseline, with the PR that owns them.

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/ci-evidence.test.ts` | P0 | behavior 01, scenarios 01-1 and 01-2 |
<!-- /manifest:incoming -->

## Baseline

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/actions-ci-policy.test.ts` | pending | P1 | |
| `tests/actions-ci.test.ts` | pending | P1 | |
| `tests/after-merge.test.ts` | pending | P1 | |
| `tests/answer-card.test.ts` | pending | P1 | |
| `tests/answer-delivery.test.ts` | pending | P1 | |
| `tests/answered-restart.test.ts` | pending | P1 | |
| `tests/answered.test.ts` | pending | P1 | |
| `tests/artifacts.test.ts` | pending | P1 | |
| `tests/ask-guard.test.ts` | pending | P1 | |
| `tests/ask.test.ts` | pending | P1 | |
| `tests/awaiting-merge-lifecycle.test.ts` | pending | P1 | |
| `tests/awaiting-merge-park.test.ts` | pending | P1 | |
| `tests/awaiting-merge-resume.test.ts` | pending | P1 | |
| `tests/awaiting-merge-tick.test.ts` | pending | P1 | |
| `tests/awaiting-merge-viewer.test.ts` | pending | P1 | |
| `tests/awaiting-merge-watch.test.ts` | pending | P1 | |
| `tests/awaiting-merge.test.ts` | pending | P1 | |
| `tests/awaiting-obsolete.test.ts` | pending | P1 | |
| `tests/awaiting-one-decision.test.ts` | pending | P1 | |
| `tests/awaiting-rows.test.ts` | pending | P1 | |
| `tests/awaiting-ui.test.ts` | pending | P1 | |
| `tests/awaiting.test.ts` | pending | P1 | |
| `tests/bounds.test.ts` | pending | P1 | |
| `tests/bridge-reattach.test.ts` | pending | P1 | |
| `tests/budgets.test.ts` | pending | P1 | |
| `tests/capacity.test.ts` | pending | P1 | |
| `tests/checkpoint-root.test.ts` | pending | P1 | |
| `tests/ci-access.test.ts` | pending | P1 | |
| `tests/ci-configured.test.ts` | pending | P1 | |
| `tests/ci-evidence.test.ts` | pending | P1 | |
| `tests/ci-host-tools.test.ts` | pending | P1 | |
| `tests/ci-infra-rerun.test.ts` | pending | P1 | |
| `tests/ci-run-ref.test.ts` | retained | P0 | pilot deletion blocked: 4 assertions unreachable from a public consumer (see Assertion map) |
| `tests/ci-wait.test.ts` | pending | P1 | |
| `tests/ci-watch.test.ts` | pending | P1 | |
| `tests/contract-injection.test.ts` | pending | P1 | |
| `tests/contract.test.ts` | pending | P1 | |
| `tests/contracts-anchors.test.ts` | pending | P1 | |
| `tests/contracts-exports.test.ts` | pending | P1 | |
| `tests/contracts.test.ts` | pending | P1 | |
| `tests/control-pending.test.ts` | pending | P1 | |
| `tests/cp-bridge-reattach.test.ts` | pending | P1 | |
| `tests/cp-bridge-restart.test.ts` | pending | P1 | |
| `tests/cp-bridge.test.ts` | pending | P1 | |
| `tests/curation.test.ts` | pending | P1 | |
| `tests/daemon-backend.test.ts` | pending | P1 | |
| `tests/daemon-cli.test.ts` | pending | P1 | |
| `tests/daemon-files.test.ts` | pending | P1 | |
| `tests/daemon-outer.test.ts` | pending | P1 | |
| `tests/daemon-runtime.test.ts` | pending | P1 | |
| `tests/daemon-tunnel-files.test.ts` | pending | P1 | |
| `tests/daemon-tunnel.test.ts` | pending | P1 | |
| `tests/dashboard-compaction.test.ts` | pending | P1 | |
| `tests/dashboard-control-images.test.ts` | pending | P1 | |
| `tests/dashboard-control-remote.test.ts` | pending | P1 | |
| `tests/dashboard-control.test.ts` | pending | P1 | |
| `tests/dashboard-restart.test.ts` | pending | P1 | |
| `tests/decide-listing.test.ts` | pending | P1 | |
| `tests/decide.test.ts` | pending | P1 | |
| `tests/decision-context.test.ts` | pending | P1 | |
| `tests/deferred-recheck.test.ts` | pending | P1 | |
| `tests/dependency-dispatch.test.ts` | pending | P1 | |
| `tests/device-notifications.test.ts` | pending | P1 | |
| `tests/device-notify.test.ts` | pending | P1 | |
| `tests/diff-review.test.ts` | pending | P1 | |
| `tests/dispatch-preview-tool.test.ts` | pending | P1 | |
| `tests/dispatch-queue-tool.test.ts` | pending | P1 | |
| `tests/dispatch-queue-wiring.test.ts` | pending | P1 | |
| `tests/dispatch-queue.test.ts` | pending | P1 | |
| `tests/dispatch.test.ts` | pending | P1 | |
| `tests/doctor.test.ts` | pending | P1 | |
| `tests/drain-stale-gate.test.ts` | pending | P1 | |
| `tests/drain.test.ts` | pending | P1 | |
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
| `tests/envelope-correction.test.ts` | pending | P1 | |
| `tests/escalation-backstop.test.ts` | pending | P1 | |
| `tests/escalation-relay-watch.test.ts` | pending | P1 | |
| `tests/escalation.test.ts` | pending | P1 | |
| `tests/evals.test.ts` | pending | P1 | |
| `tests/extension-deps.test.ts` | pending | P1 | |
| `tests/extension-load.test.ts` | pending | P1 | |
| `tests/failure-announcer.test.ts` | pending | P1 | |
| `tests/failures.test.ts` | pending | P1 | |
| `tests/fake-parent-tracker.test.ts` | pending | P1 | |
| `tests/fleet.test.ts` | pending | P1 | |
| `tests/foreign-ci-watch.test.ts` | pending | P1 | |
| `tests/forge-observers.test.ts` | pending | P1 | |
| `tests/forge-runtime.test.ts` | pending | P1 | |
| `tests/forge-url.test.ts` | pending | P1 | |
| `tests/gate-replacement.test.ts` | pending | P1 | |
| `tests/gate.test.ts` | pending | P1 | |
| `tests/gateway-key.test.ts` | pending | P1 | |
| `tests/guards.test.ts` | pending | P1 | |
| `tests/harness.test.ts` | pending | P1 | |
| `tests/held-release.test.ts` | pending | P1 | |
| `tests/home-checkout.test.ts` | pending | P1 | |
| `tests/human-handoff.test.ts` | pending | P1 | |
| `tests/install-nudge.test.ts` | pending | P1 | |
| `tests/install-tools.test.ts` | pending | P1 | |
| `tests/intake-settle-atomicity.test.ts` | pending | P1 | |
| `tests/intake.test.ts` | pending | P1 | |
| `tests/integrate-held-ci.test.ts` | pending | P1 | |
| `tests/integrate.test.ts` | pending | P1 | |
| `tests/job-skills.test.ts` | pending | P1 | |
| `tests/jobs-tool.test.ts` | pending | P1 | |
| `tests/json-store.test.ts` | pending | P1 | |
| `tests/landing-proof.test.ts` | pending | P1 | |
| `tests/layout-capture.test.ts` | pending | P1 | |
| `tests/layout-flat.test.ts` | pending | P1 | |
| `tests/leases.test.ts` | pending | P1 | |
| `tests/ledger-import.test.ts` | pending | P1 | |
| `tests/ledger.test.ts` | pending | P1 | |
| `tests/live-harness.test.ts` | pending | P1 | |
| `tests/main-ci.test.ts` | pending | P1 | |
| `tests/mandate-defaults.test.ts` | pending | P1 | |
| `tests/mandate-selection.test.ts` | pending | P1 | |
| `tests/mandate-supplement.test.ts` | pending | P1 | |
| `tests/mandate-usage.test.ts` | pending | P1 | |
| `tests/mandate.test.ts` | pending | P1 | |
| `tests/mcp-access.test.ts` | pending | P1 | |
| `tests/memory.test.ts` | pending | P1 | |
| `tests/merge-ask.test.ts` | pending | P1 | |
| `tests/merge-permission.test.ts` | pending | P1 | |
| `tests/merges.test.ts` | pending | P1 | |
| `tests/mode.test.ts` | pending | P1 | |
| `tests/model-call-failure-recovery.test.ts` | pending | P1 | |
| `tests/next.test.ts` | pending | P1 | |
| `tests/operator-answers.test.ts` | pending | P1 | |
| `tests/operator-asks.test.ts` | pending | P1 | |
| `tests/operator-cache-warming.test.ts` | pending | P1 | |
| `tests/operator-compact.test.ts` | pending | P1 | |
| `tests/operator-context.test.ts` | pending | P1 | |
| `tests/operator-decide-vs-ask-evals.test.ts` | pending | P1 | |
| `tests/operator-delivery.test.ts` | pending | P1 | |
| `tests/operator-note.test.ts` | pending | P1 | |
| `tests/operator-outbox-host.test.ts` | pending | P1 | |
| `tests/operator-outbox.test.ts` | pending | P1 | |
| `tests/operator-relaunch.test.ts` | pending | P1 | |
| `tests/operator-session-log.test.ts` | pending | P1 | |
| `tests/operator-target-real-home.test.ts` | pending | P1 | |
| `tests/operator-threads-bridge.test.ts` | pending | P1 | |
| `tests/operator-threads-journal.test.ts` | pending | P1 | |
| `tests/operator-tool-guard.test.ts` | pending | P1 | |
| `tests/ops-jobs.test.ts` | pending | P1 | |
| `tests/output.test.ts` | pending | P1 | |
| `tests/parent-compact-hold.test.ts` | pending | P1 | |
| `tests/parent-context.test.ts` | pending | P1 | |
| `tests/parent-control.test.ts` | pending | P1 | |
| `tests/parent-delivery.test.ts` | pending | P1 | |
| `tests/parent-hosts-harness.test.ts` | pending | P1 | |
| `tests/parent-lock.test.ts` | pending | P1 | |
| `tests/parent-outbox.test.ts` | pending | P1 | |
| `tests/parent-routing-evals.test.ts` | pending | P1 | |
| `tests/parent-session.test.ts` | pending | P1 | |
| `tests/parked-ci.test.ts` | pending | P1 | |
| `tests/pi-hashline-compaction.test.ts` | pending | P1 | |
| `tests/pi-lens-headless.test.ts` | pending | P1 | |
| `tests/pi-server-dependency.test.ts` | pending | P1 | |
| `tests/pi-version-nudge.test.ts` | pending | P1 | |
| `tests/pipeline-classify-tool.test.ts` | pending | P1 | |
| `tests/pipeline.test.ts` | pending | P1 | |
| `tests/plan-followup.test.ts` | pending | P1 | |
| `tests/plan-view.test.ts` | pending | P1 | |
| `tests/plan-viewer.test.ts` | pending | P1 | |
| `tests/planner-artifact.test.ts` | pending | P1 | |
| `tests/pr-bind.test.ts` | pending | P1 | |
| `tests/pr-resolve.test.ts` | pending | P1 | |
| `tests/preflight.test.ts` | pending | P1 | |
| `tests/profiles.test.ts` | pending | P1 | |
| `tests/project-report.test.ts` | pending | P1 | |
| `tests/projects.test.ts` | pending | P1 | |
| `tests/provider-retry.test.ts` | pending | P1 | |
| `tests/push-keys.test.ts` | pending | P1 | |
| `tests/push-status.test.ts` | pending | P1 | |
| `tests/push-sweep.test.ts` | pending | P1 | |
| `tests/push-tick.test.ts` | pending | P1 | |
| `tests/push-webpush.test.ts` | pending | P1 | |
| `tests/quality.test.ts` | pending | P1 | |
| `tests/questions.test.ts` | pending | P1 | |
| `tests/quota.test.ts` | pending | P1 | |
| `tests/ready-beads.test.ts` | pending | P1 | |
| `tests/recovery.test.ts` | pending | P1 | |
| `tests/relay-preflight.test.ts` | pending | P1 | |
| `tests/relay-scope.test.ts` | pending | P1 | |
| `tests/repo-map.test.ts` | pending | P1 | |
| `tests/restart-intake.test.ts` | pending | P1 | |
| `tests/review-approval.test.ts` | pending | P1 | |
| `tests/review-context.test.ts` | pending | P1 | |
| `tests/review-merge-window.test.ts` | pending | P1 | |
| `tests/review-runs.test.ts` | pending | P1 | |
| `tests/review-tool.test.ts` | pending | P1 | |
| `tests/reviewer-model.test.ts` | pending | P1 | |
| `tests/revive.test.ts` | pending | P1 | |
| `tests/risk-batch.test.ts` | pending | P1 | |
| `tests/risk-negation.test.ts` | pending | P1 | |
| `tests/risk-preapproval.test.ts` | pending | P1 | |
| `tests/risk-warning.test.ts` | pending | P1 | |
| `tests/routing-integration.test.ts` | pending | P1 | |
| `tests/routing.test.ts` | pending | P1 | |
| `tests/run-artifacts.test.ts` | pending | P1 | |
| `tests/scaffold.test.ts` | pending | P1 | |
| `tests/schedule-activation.test.ts` | pending | P1 | |
| `tests/schedule-authority.test.ts` | pending | P1 | |
| `tests/schedule-control.test.ts` | pending | P1 | |
| `tests/schedule-cutover.test.ts` | pending | P1 | |
| `tests/schedule-expand.test.ts` | pending | P1 | |
| `tests/schedule-grant.test.ts` | pending | P1 | |
| `tests/schedule-migrations.test.ts` | pending | P1 | |
| `tests/schedule-native-migration.test.ts` | pending | P1 | |
| `tests/schedule-native-tool.test.ts` | pending | P1 | |
| `tests/schedule-native.test.ts` | pending | P1 | |
| `tests/schedule-org-review.test.ts` | pending | P1 | |
| `tests/schedule-policy.test.ts` | pending | P1 | |
| `tests/schedule-results.test.ts` | pending | P1 | |
| `tests/schedule-run-now.test.ts` | pending | P1 | |
| `tests/schedule-runner.test.ts` | pending | P1 | |
| `tests/schedule-runs.test.ts` | pending | P1 | |
| `tests/schedule-self-review.test.ts` | pending | P1 | |
| `tests/schedule-wake.test.ts` | pending | P1 | |
| `tests/scheduler.test.ts` | pending | P1 | |
| `tests/script-jobs.test.ts` | pending | P1 | |
| `tests/send-first-gate.test.ts` | pending | P1 | |
| `tests/send.test.ts` | pending | P1 | |
| `tests/service-alerts.test.ts` | pending | P1 | |
| `tests/service-health.test.ts` | pending | P1 | |
| `tests/service-install.test.ts` | pending | P1 | |
| `tests/service-models.test.ts` | pending | P1 | |
| `tests/service-supervise.test.ts` | pending | P1 | |
| `tests/service-units.test.ts` | pending | P1 | |
| `tests/service-update.test.ts` | pending | P1 | |
| `tests/session-tools.test.ts` | pending | P1 | |
| `tests/settings-control.test.ts` | pending | P1 | |
| `tests/settings-lock.test.ts` | pending | P1 | |
| `tests/settings-policy.test.ts` | pending | P1 | |
| `tests/settings-write.test.ts` | pending | P1 | |
| `tests/settings.test.ts` | pending | P1 | |
| `tests/settle-recovery.test.ts` | pending | P1 | |
| `tests/settle.test.ts` | pending | P1 | |
| `tests/shipped-seen.test.ts` | pending | P1 | |
| `tests/skill-catalog.test.ts` | pending | P1 | |
| `tests/stale-notice-context.test.ts` | pending | P1 | |
| `tests/state-migrations.test.ts` | pending | P1 | |
| `tests/stats-view.test.ts` | pending | P1 | |
| `tests/stats-wakeup-drift.test.ts` | pending | P1 | |
| `tests/status-block.test.ts` | pending | P1 | |
| `tests/status-wait-reasons.test.ts` | pending | P1 | |
| `tests/status.test.ts` | pending | P1 | |
| `tests/storage.test.ts` | pending | P1 | |
| `tests/structure.test.ts` | pending | P1 | |
| `tests/suggest.test.ts` | pending | P1 | |
| `tests/supersede.test.ts` | pending | P1 | |
| `tests/sync-lossless.test.ts` | pending | P1 | |
| `tests/task-addenda.test.ts` | pending | P1 | |
| `tests/task-references.test.ts` | pending | P1 | |
| `tests/teardown.test.ts` | pending | P1 | |
| `tests/test-concurrency-bound.test.ts` | pending | P1 | |
| `tests/test-file-guard.test.ts` | pending | P1 | |
| `tests/test-runner-bounds.test.ts` | pending | P1 | |
| `tests/timeout-floor.test.ts` | pending | P1 | |
| `tests/tool-manifest.test.ts` | pending | P1 | |
| `tests/trackers-beads.test.ts` | pending | P1 | |
| `tests/trackers-config.test.ts` | pending | P1 | |
| `tests/trackers-import.test.ts` | pending | P1 | |
| `tests/trackers-ledger.test.ts` | pending | P1 | |
| `tests/trackers-link.test.ts` | pending | P1 | |
| `tests/trackers-sync.test.ts` | pending | P1 | |
| `tests/trackers-tool.test.ts` | pending | P1 | |
| `tests/tunnel-cli.test.ts` | pending | P1 | |
| `tests/tunnel-cloudflared.test.ts` | pending | P1 | |
| `tests/tunnel-qr.test.ts` | pending | P1 | |
| `tests/user-context.test.ts` | pending | P1 | |
| `tests/verify-external-ref.test.ts` | pending | P1 | |
| `tests/version-records.test.ts` | pending | P1 | |
| `tests/version-view.test.ts` | pending | P1 | |
| `tests/viewer-answers-http.test.ts` | pending | P1 | |
| `tests/viewer-answers-ui.test.ts` | pending | P1 | |
| `tests/viewer-app-build.test.ts` | pending | P1 | |
| `tests/viewer-app-http.test.ts` | pending | P1 | |
| `tests/viewer-app-live.test.ts` | pending | P1 | |
| `tests/viewer-app-navigation.test.ts` | pending | P1 | |
| `tests/viewer-app-render.test.ts` | pending | P1 | |
| `tests/viewer-bind-host.test.ts` | pending | P1 | |
| `tests/viewer-boards.test.ts` | pending | P1 | |
| `tests/viewer-compression-http.test.ts` | pending | P1 | |
| `tests/viewer-context-usage.test.ts` | pending | P1 | |
| `tests/viewer-control-http.test.ts` | pending | P1 | |
| `tests/viewer-control-ui.test.ts` | pending | P1 | |
| `tests/viewer-copy-reply.test.ts` | pending | P1 | |
| `tests/viewer-decision-card.test.ts` | pending | P1 | |
| `tests/viewer-decision-render.test.ts` | pending | P1 | |
| `tests/viewer-decisions.test.ts` | pending | P1 | |
| `tests/viewer-delta-http.test.ts` | pending | P1 | |
| `tests/viewer-deploy.test.ts` | pending | P1 | |
| `tests/viewer-device-control.test.ts` | pending | P1 | |
| `tests/viewer-device-notices-ui.test.ts` | pending | P1 | |
| `tests/viewer-device-notices.test.ts` | pending | P1 | |
| `tests/viewer-device-store.test.ts` | pending | P1 | |
| `tests/viewer-devices-ui.test.ts` | pending | P1 | |
| `tests/viewer-explorer.test.ts` | pending | P1 | |
| `tests/viewer-job-detail-render.test.ts` | pending | P1 | |
| `tests/viewer-job-transcript-render.test.ts` | pending | P1 | |
| `tests/viewer-jobs-qa.test.ts` | pending | P1 | |
| `tests/viewer-jobs-render.test.ts` | pending | P1 | |
| `tests/viewer-jobs.test.ts` | pending | P1 | |
| `tests/viewer-json-delta.test.ts` | pending | P1 | |
| `tests/viewer-linkify.test.ts` | pending | P1 | |
| `tests/viewer-mandates-map-render.test.ts` | pending | P1 | |
| `tests/viewer-mandates-map.test.ts` | pending | P1 | |
| `tests/viewer-map-edges.test.ts` | pending | P1 | |
| `tests/viewer-mobile-keyboard.test.ts` | pending | P1 | |
| `tests/viewer-model-list.test.ts` | pending | P1 | |
| `tests/viewer-more-menu.test.ts` | pending | P1 | |
| `tests/viewer-not-found.test.ts` | pending | P1 | |
| `tests/viewer-operator-composer-images.test.ts` | pending | P1 | |
| `tests/viewer-operator-composer.test.ts` | pending | P1 | |
| `tests/viewer-operator-relaunch.test.ts` | pending | P1 | |
| `tests/viewer-operator-restart.test.ts` | pending | P1 | |
| `tests/viewer-operator.test.ts` | pending | P1 | |
| `tests/viewer-overview.test.ts` | pending | P1 | |
| `tests/viewer-pairing.test.ts` | pending | P1 | |
| `tests/viewer-palette.test.ts` | pending | P1 | |
| `tests/viewer-performance.test.ts` | pending | P1 | |
| `tests/viewer-pr-chips.test.ts` | pending | P1 | |
| `tests/viewer-push-http.test.ts` | pending | P1 | |
| `tests/viewer-push-ui.test.ts` | pending | P1 | |
| `tests/viewer-queued-bubbles.test.ts` | pending | P1 | |
| `tests/viewer-remote-control.test.ts` | pending | P1 | |
| `tests/viewer-remote-http.test.ts` | pending | P1 | |
| `tests/viewer-remote-runtime.test.ts` | pending | P1 | |
| `tests/viewer-reports.test.ts` | pending | P1 | |
| `tests/viewer-restart-ui.test.ts` | pending | P1 | |
| `tests/viewer-schedule-control-http.test.ts` | pending | P1 | |
| `tests/viewer-schedule-control-ui.test.ts` | pending | P1 | |
| `tests/viewer-schedule-editor.test.ts` | pending | P1 | |
| `tests/viewer-schedule-run-groups.test.ts` | pending | P1 | |
| `tests/viewer-schedules.test.ts` | pending | P1 | |
| `tests/viewer-search.test.ts` | pending | P1 | |
| `tests/viewer-service-worker.test.ts` | pending | P1 | |
| `tests/viewer-sessions-chat-v2.test.ts` | pending | P1 | |
| `tests/viewer-sessions-files-render.test.ts` | pending | P1 | |
| `tests/viewer-sessions-files.test.ts` | pending | P1 | |
| `tests/viewer-sessions-qa.test.ts` | pending | P1 | |
| `tests/viewer-sessions-rollup.test.ts` | pending | P1 | |
| `tests/viewer-sessions-skills.test.ts` | pending | P1 | |
| `tests/viewer-settings-http.test.ts` | pending | P1 | |
| `tests/viewer-settings-ui.test.ts` | pending | P1 | |
| `tests/viewer-stats-render.test.ts` | pending | P1 | |
| `tests/viewer-thread-turns.test.ts` | pending | P1 | |
| `tests/viewer-threads-http.test.ts` | pending | P1 | |
| `tests/viewer-threads-ui.test.ts` | pending | P1 | |
| `tests/viewer-transcript-chat.test.ts` | pending | P1 | |
| `tests/viewer-transcript-tools.test.ts` | pending | P1 | |
| `tests/viewer-upload-http.test.ts` | pending | P1 | |
| `tests/viewer-upload-metadata.test.ts` | pending | P1 | |
| `tests/viewer-uploads.test.ts` | pending | P1 | |
| `tests/viewer-version-badge.test.ts` | pending | P1 | |
| `tests/viewer-workbench.test.ts` | pending | P1 | |
| `tests/viewer.test.ts` | pending | P1 | |
| `tests/wake-rules.test.ts` | pending | P1 | |
| `tests/wakeup-head-sources.test.ts` | pending | P1 | |
| `tests/wakeup-journal.test.ts` | pending | P1 | |
| `tests/wakeups.test.ts` | pending | P1 | |
| `tests/watch.test.ts` | pending | P1 | |
| `tests/web-access.test.ts` | pending | P1 | |
| `tests/web-egress.test.ts` | pending | P1 | |
| `tests/wedged.test.ts` | pending | P1 | |
| `tests/widget.test.ts` | pending | P1 | |
| `tests/worker-beads.test.ts` | pending | P1 | |
| `tests/worker-compaction.test.ts` | pending | P1 | |
| `tests/worker-credential-guard.test.ts` | pending | P1 | |
| `tests/worker-history-guard.test.ts` | pending | P1 | |
| `tests/worker-host-guard.test.ts` | pending | P1 | |
| `tests/worker-manager.test.ts` | pending | P1 | |
| `tests/worker-mcp.test.ts` | pending | P1 | |
| `tests/worker-merge-guard.test.ts` | pending | P1 | |
| `tests/worker-packages.test.ts` | pending | P1 | |
| `tests/worker-process.test.ts` | pending | P1 | |
| `tests/worker-reporter.test.ts` | pending | P1 | |
| `tests/worker-role-tools.test.ts` | pending | P1 | |
| `tests/worker-session-policy.test.ts` | pending | P1 | |
| `tests/worker-spawn-reserve.test.ts` | pending | P1 | |
| `tests/worktree-deps.test.ts` | pending | P1 | |
<!-- /manifest:baseline -->
