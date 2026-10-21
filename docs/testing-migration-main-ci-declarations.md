# Main-CI whole-file slice

Owner: cp-e2e-slice-main-ci-41d3, behavior 05 / P3c-rest. Other slices keep their ownership.
Authorized addendum ps-20261021163741-8362b144 drops the unbuilt coverage collector prerequisite.
Retirement gates are the migration checker, contract test, focused positives and executed semantic controls.

Accounting: 39 source declarations = 27 mapped + 12 retained + 0 redundant; no pending declarations.
Mapped declarations retire together. Retained declarations move verbatim to `tests/main-ci-retained.test.ts`.
The retained share is 30.77%. They have missing entry points described below, rather than missing controls.
New e2e declarations: 3 (main-red integration, scope/login, and the corruption race); existing 05-11 and 05-4 extend.

Scenario names below are exact titles in `tests/e2e/landing.test.ts`:

- T / 05-11: `landing: a real parent's timer latches only its mandated main runs and clears only current-tip green`.
- I / 05-main-red: `landing: main-red integration holds stale heads and permits only a current green fix-forward under its own mandate`.
- S / 05-main-scope: `landing: main CI scope skips inactive grants and login faults preserve latches until the next successful login`.
- C / 05-main-corrupt: `landing: main latch writes refuse corruption introduced during an Actions read`.
- F / 05-4: `landing: an infra-only CI failure is claimed, then rerun once per head; a test failure, a cancel, a second attempt, a drain or an unreadable claim or job list goes to the parent`.

Indices follow the original declaration order. A mapped row names the consumer assertion that fails when its behavior is broken.

| # | Original declaration | Disposition | Scenario/assertion or missing entry point |
|---|---|---|---|
| 1 | row 1: a failure on the fetched tip latches once, naming the sha, workflow and failing test line | mapped | T: expected project/sha/login/workflow/failing row; suppressing red gives an empty array |
| 2 | row 1: no matching log line falls back to the failing job name | mapped | T: missing failure log falls back to the failed job; removing fallback gives undefined |
| 3 | row 1: a failure fires at once even while another workflow on the tip is still running | mapped | T: expected red row while an own workflow remains pending; suppressing red gives an empty array |
| 4 | row 2: nothing latched, and green / pending / no run on the tip emits nothing | mapped | T: green, pending, absent and wrong-head runs never latch; the state stays empty |
| 5 | row 3: a repeat red, or red on a new tip, emits nothing and keeps red_since byte-identical | mapped | T: repeat red emits one parent wake; red on a new main tip preserves original bytes |
| 6 | row 5: stale green on an old sha never clears the latch | mapped | T: stale green never clears main red; old-tip green cannot replace current-tip red |
| 7 | row 4: green on every run for the current tip clears once with one main_ci_green | mapped | T: pending current-tip workflow prevents clearing; green notice reaches parent; repeat green preserves bytes |
| 8 | row 6: git or gh failures are inconclusive: latch unchanged, onError names the project | retained | No entry point makes successful real git rev-parse return the injected non-sha text. Mixed declaration stays intact; T pins actual denied/malformed read outcomes and project error wording. |
| 9 | row 7: an unreadable main-ci.json is never overwritten and is reported | mapped | T pins pre-read corruption; C races corruption after the read and before both set and clear. Treating corrupt rows as empty fails in-flight latch mutation preserves corrupt bytes. |
| 10 | per project: one project's latch is independent of another's | mapped | T: clearing demo preserves another project's latch; the other seeded row survives |
| 11 | row 8: a project with no clone dir is skipped without any command | mapped | S: missing clone reads no CI and creates no project error; removing exists guard creates a project error |
| 12 | tick: one red transition sends exactly one wake; a refused send is reported | retained | The registered main-CI timer sends jobless ci stamps, which checkWakeup always accepts. This entry point cannot return the synthetic false send result; transport errors throw instead. T pins delivered wake deduplication. |
| 13 | formatMainCiNotice: red and green wording | mapped | T: red wording/advice and exact current-tip green notice in real parent provider requests |
| 14 | classifyMainTip ignores every run not on the tip | retained | No entry point supplies old-head rows directly to this classifier: readActionsCi already filters the queried head. T pins the stale-head consumer outcome. |
| 15 | mainRedHold: fails open with a fact on unreadable state, holds a latched project | mapped | I: stale head requires wait; current green ancestry gives fix-forward; denied CI holds; corrupt latch gives not-blocking fact |
| 16 | cp-oc0m: a dynamic run (Dependabot Updates) never latches and never blocks a green clear | mapped | T: dynamic-only red never latches and dynamic red beside own green permits clearing; counting all actors fails empty-state assertion |
| 17 | cp-oc0m: another user's or a bot's run never latches and never blocks a green clear; the login match is case-insensitive | mapped | T rejects foreign/bot/absent actor; S clears case-insensitive own green and permits authenticated bot identity |
| 18 | cp-oc0m: a re-run counts by its own triggering actor | mapped | T: foreign attempt-two red never latches, own attempt-two red latches; actor-filter mutation fails empty-state assertion |
| 19 | cp-oc0m: without an active mandate the tick runs no command at all, not even the login | retained | No public observation attributes shared gh login calls to one watch. Other watches read the same cached identity. Moving main's login ahead of its empty-project guard passes S but fails this unit. |
| 20 | cp-oc0m: an unreadable login fails open — no command, file byte-identical, one onError | mapped | S: failed login reads no CI and preserves latch bytes; failed login retries on next tick |
| 21 | cp-oc0m: a pre-change row is released on a mandated tick; a foreign row is replaced by an own red | mapped | T: legacy/foreign pending releases reach parent; foreign row followed by own red becomes own current-tip failure |
| 22 | cp-oc0m: memoLogin asks gh once, retries after a failure, refuses a non-login | mapped | S: invalid login retries, successful login is cached (2 requests); valid bot identity clears its own row |
| 23 | cp-oc0m: mainRedHold enforces only an own row under an enforced scope; no row never asks the scope | mapped | I: no latch never resolves scope; own stale waits; paused/foreign/legacy rows produce not-blocking facts |
| 24 | cp-oc0m: resolveMainCiScope — active mandate and readable login enforce; anything else fails open | mapped | I covers active/paused and a legacy mandate-directory file producing ENOTDIR/not-blocking; S covers login faults |
| 25 | cp-oc0m: the Actions query carries event and triggering actor, and the counted filter uses them | mapped | T: exact current-tip query/attempt-two jobs and actor-filtered latch outcomes; actor mutation fails empty-state assertion |
| 26 | main CI: an unreadable jobs read or a malformed runs page latches nothing and throws a named error | mapped | T: denied attempt jobs never create latch; malformed read names project and cause in parent context |
| 27 | formatMainCiNotice: released wording | mapped | T: exact foreign release notice reaches parent with original sha and login reason |
| 28 | PR1: an attempt-1 Install treehouse failure on main is claimed, rerun once and not latched; attempt 2 latches | mapped | T: main-demo/head/run/step claim, no latch until attempt two, one rerun, correct attempt jobs and parent rerun notice |
| 29 | PR1: a suite failure on main latches with no rerun and no claim | mapped | T: initial ordinary failure latches; claim table remains empty until infra phase |
| 30 | PR1: a refused gh run rerun latches, names the refusal and keeps its claim | mapped | T: refused infra rerun latches, keeps second claim, does not retry, refusal reaches parent |
| 31 | classifyInfraFailure: setup steps are infra; the suite and a cancel are not | mapped | F: setup table reruns once; test/build/mixed/stepless/cancel/timeout variants do not. Rejecting Set up Node fails its wait assertion. |
| 32 | attempt 2, a test failure, a cancel, no run id, a green head and a drain all leave it to the parent | retained | No entry point sends a green head or id-less run to maybeRerunInfra: earlier CI evaluation and Actions validation intercept them. Mixed guard declaration stays verbatim; F covers reachable variants. |
| 33 | paths: exact head, explicit repo or gh placeholders, attempt-bound jobs; malformed ids refused | retained | No entry point forwards these invalid SHA/branch/repo/id values past validated git, registry and Actions boundaries into the path builders. |
| 34 | readActionsCi: normalizes runs with identity, event, actor and their attempt's jobs and steps | retained | No public tool returns the entire normalized run/job/step array with these exact internal field names. T/F pin decisions using those fields. |
| 35 | retry: never past the budget, and a structurally wrong JSON page is not retried | retained | No public entry point supplies the synthetic millisecond clock and sleep function used to pin an exact remaining budget. |
| 36 | budget: one total deadline across pages, each request gets only what remains | retained | No public entry point supplies the synthetic clock or exposes exact per-request remaining timeout values. |
| 37 | statusRunner: forwards each request's remaining budget as timeoutMs; a non-zero status throws | retained | No external executable can inspect the internal runner options object or injected exact clock. The consumer denial behavior remains in 05-1. |
| 38 | ciReadDenied: only a permission refusal of a CI read counts | retained | No current entry point submits legacy Checks/status/gh-run classifier strings to the Actions-only reader; public tools do not expose the classifier. |
| 39 | the browser mirrors the backend's Actions-only label and advice, keeping its needs prefix | retained | No UI entry point exposes source-literal equality; this static source-parity contract stays verbatim. |

## Executed controls

Logs and exact semantic patches live beside the job artifact. All mutations were restored.
Red suppression, failed-job fallback removal, pending-green clearing, ancestry bypass, mandate activity bypass,
malformed-login acceptance, missing-clone guard removal, actor-filter removal, corrupted-store-as-empty and
Set up Node rejection were executed. Their failures name consumer assertions, rather than startup errors.
The inactive-login ordering probe passes S but fails the retained unit, demonstrating the attribution limit.
Existing NC-35 remains the manifest's original main-CI regression record; the new corruption race has its own patch record.

The following table is the per-declaration control gate (addendum ps-20261021170156-5a482970).
Each basename identifies an executed `nc-<name>.patch` and `nc-<name>.log` in the job artifact directory.
Each command used `node --import ./tests/harness/hermetic-env.ts --test --test-timeout=300000 --test-force-exit --test-name-pattern=<scenario title substring> tests/e2e/landing.test.ts`.
Every listed e2e run exited 1 with an AssertionError on the named consumer outcome; startup failures and timeout-only probes do not count.

| Declaration # | Control basename | Production mutation | Failing consumer assertion |
|---|---|---|---|
| 1, 3 | red | Disable the red-transition branch in checkMainCi | Expected demo/tip/e2e/ci/main regression row, got [] while another own workflow is pending |
| 2 | fallback | Remove failingJobName fallback | missing failure log falls back to the failed job |
| 4 | empty | Force classified.status to red | green, pending, absent and wrong-head runs never latch |
| 5 | repeat | Remove !own from red-transition guard | repeat red emits one parent wake |
| 6 | unknown-clear | Treat unknown as green when clearing | stale green never clears main red |
| 7 | stale | Clear when any counted run succeeds | pending current-tip workflow prevents clearing |
| 9 | corruption | Treat unreadable store rows as empty | in-flight latch mutation preserves corrupt bytes |
| 10 | project | Write only the new project's row in setRed | latching demo preserves another project's latch |
| 11 | missing-clone | Remove clone-existence guard | missing clone creates no project error |
| 13 | format | Return empty formatMainCiNotice text | main red wake reaches parent provider |
| 15 | ancestry | Bypass mainRedHold ancestry guard | cp_integrate.next expected wait, actual review |
| 16 | dynamic | Remove dynamic-event guard, retaining actor guard | green, pending, absent and wrong-head runs never latch (own dynamic run) |
| 17, 25 | actor | Return every run from countedMainRuns | green, pending, absent and wrong-head runs never latch (foreign actor) |
| 18 | rerun-actor | Accept all attempt-two actors | green, pending, absent and wrong-head runs never latch (foreign re-run actor) |
| 20 | login-fault | Return a valid identity when gh login fails | failed login reads no CI |
| 21 | release | Disable foreign/legacy release branch | legacy latch releases even while main CI is inconclusive |
| 22 | login-validation | Bypass login syntax validation | invalid login retries, successful login is cached |
| 23 | hold-scope | Hold instead of fail-open when scope is off | expected no active mandate / not blocking fact |
| 24 | scope-fault | Enforce scope on mandate/login read errors | expected ENOTDIR / not blocking fact |
| 26 | read-fault | Swallow Actions read errors in checkMainCi | malformed main CI read names project and cause |
| 27 | format-release | Return empty text only for released notices | legacy release reaches parent |
| 28 | main-rerun | Fall through to latching after an accepted infra rerun | infra rerun does not latch demo |
| 29 | suite | Classify every failure as infra | suite failure claims no infra rerun |
| 30 | rerun-refusal | Treat a refused rerun as accepted | refused infra rerun latches main |
| 31 | setup | Reject Set up Node as an infra setup step | Set up Node expected wait/rerun, got resolve |

The shared red mutation also fails both original declarations 1 and 3 (`nc-red-units.log`).
The shared actor mutation also fails original declarations 17 and 25 (`nc-actor-units.log`),
including the filtered normalized-array expectation, rather than merely another case in the scenario.
Additional unit sensitivity probes for unknown-clear, format, login-fault and suite are recorded separately;
the table still assigns a consumer control to each mapped declaration.

Retained entry points are concrete: the registered main-CI extension timer for 8, 12, 14 and 19;
`cp_integrate` for 32; the timer and `cp_integrate` for 33–37;
`cp_integrate`'s Actions reader for 38; and the browser UI for 39.
For 12 specifically, the timer sends jobless `ci` stamps: `checkWakeup` returns fresh when `job_id` is absent,
so `WakeupNotifier.send` returns true. A transport exception throws; it does not return the synthetic false callback value.
Retention preserves each mixed declaration whole, with no claim that its reachable portions are untested.
