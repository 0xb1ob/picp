# Ledger rows: unowned

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/viewer-job-report.test.ts` | #380 | unit test landed on main after the baseline (viewer job report pages); recorded by P2 so the check stays at 0 findings, disposition left to its behavior's PR |
| `tests/e2e/ci-watch-transient.test.ts` | #484 | #420 regression: a slow or empty Actions jobs read then a valid one must not fail the CI watch tick |
| `tests/e2e/retired-integration.test.ts` | #379 | existing-home compatibility after the tracker removal |
| `tests/test-migration-check.test.ts` | #379 | exception (verification integrity, like `tests/test-file-guard.test.ts`; operator ask-0088e0332d00 (Exceptions)): tests `scripts/test-migration-check.ts` itself, which no product entry point reaches, so it has no e2e consumer path; covers accept and reject paths of `deleted-with-feature` and `feature-removed` |
| `tests/retired-integration-guard.test.ts` | #392 | exception (verification integrity, like `tests/test-migration-check.test.ts`): tests `scripts/check-retired-integration.ts` itself, a CI guard no product entry point reaches, so it has no e2e consumer path; covers the clean tree and every rejection path |
| `tests/e2e/viewer-endpoints-speed.test.ts` | #395 | e2e landed on main after the baseline (viewer dashboard endpoint caching); recorded by P2e so the check stays at 0 findings, disposition left to its behavior's PR |
| `tests/e2e/installer.test.ts` | #375 | installer sandbox: real bootstrap/cp-install/cp-daemon/doctor in Docker with the mock provider; opt-in `CP_INSTALL_E2E=1` (CI's install sandbox job) |
| `tests/entry-guard.test.ts` | main 5e8106b | unit landed upstream after the baseline; convert, owner P24 (entry-module/runtime compatibility), outside P3c; recorded when plain-merging main |
| `tests/diff-review-retained.test.ts` | retained, convert-owned P3c-rest: structural declaration 12, synthetic shutdown regression 25, unknown-job sub-probe 21; no deletion credit |
| `tests/timer-knobs.test.ts` | #439 | convert-owned #439; incoming timer/environment parser coverage introduced by merged #439, outside S19 conversion scope |
| `tests/bridge-reattach-knobs.test.ts` | #447 | incoming #447 default-knob regression moved verbatim from the retired original path; four older declarations retain their S19 mapped/retained dispositions |
| `tests/e2e/ci-watch-jobless.test.ts` | #443 | incoming #443-owned consumer coverage for job-less CI watch errors, outside S19 conversion scope |
| `tests/held-continuation-fleet-read.test.ts` | #433 (ac50447082b15959140ec40b04080102eadbaf87) | incoming known-regression coverage for unreadable fleet during continuation failure notice; unit landed upstream after the baseline and is preserved unchanged; convert, owner P3c-rest (held continuation), pending the separately parked declaration-71 e2e conversion. Recorded when plain-merging main; no exception or deletion is claimed. |
| `tests/e2e/ci-watch-jobless.test.ts` | #443 | incoming public RPC regression: distinct job-less CI watch errors retain distinct durable notice causes; preserved unchanged when merging main; behavior 06. S10b owns declaration-71 mapping and original-file retirement under the main-session decision. |
| `tests/timer-knobs.test.ts` | #439 | incoming timer configuration contract: defaults, positive overrides and invalid-input fallback; landed with the public knobs consumed by S15 Addendum 2; registered by S20 after plain-merging 695a8528, with no S20 conversion credit; preserved unchanged; convert owner P16, outside S03b. No exception or deletion credit claimed. |
| `tests/e2e-hermetic-gh.test.ts` | PR #454 (hermetic e2e gh) | retained, no conversion |
| `tests/split-migration-ledger.test.ts` | cp-ledger-split-gewy | incoming regression for the ledger split script (a `$&` in a kept row); no conversion owner, no exception or deletion credit claimed |
<!-- /manifest:incoming -->

<!-- manifest:feature-removed -->
| Unit file | Declaration | Removed by | Note |
|---|---|---|---|
| `tests/worker-beads.test.ts` | a worker's BEADS_DIR comes only from dispatch, never the home's .beads or the parent environment | #384 | dispatch database injection removed; the parent-env strip is kept under a new title |
<!-- /manifest:feature-removed -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/ledger-import.test.ts` | deleted-with-feature | #379 | tested `src/ledger-import.ts` |
| `tests/ready-beads.test.ts` | deleted-with-feature | #384 | tested `src/ready-beads.ts`, `src/trackers/config.ts` |
| `tests/trackers-beads.test.ts` | deleted-with-feature | #384 | tested `src/trackers/beads.ts`, `src/trackers/adapter.ts` |
| `tests/trackers-config.test.ts` | deleted-with-feature | #384 | tested `src/trackers/config.ts`, `src/contracts/trackers.ts` |
| `tests/trackers-import.test.ts` | deleted-with-feature | #379 | tested `src/trackers/import.ts` |
| `tests/trackers-link.test.ts` | deleted-with-feature | #379 | tested `src/trackers/link.ts`, `src/trackers/sync.ts` |
| `tests/trackers-sync.test.ts` | deleted-with-feature | #379 | tested `src/trackers/sync.ts`, `src/trackers/sync-store.ts` |
| `tests/trackers-tool.test.ts` | deleted-with-feature | #379 | tested `extensions/command-post/tools-tracker.ts`, `src/trackers/sync-store.ts` |
| `tests/worker-beads.test.ts` | deleted-with-feature | #392 | tested the retired database variables in a worker's environment; their source `src/trackers/beads.ts` went with #384 and the environment strip went with #392 |
<!-- /manifest:baseline -->
