# Ledger rows: cp-jobs-queued-time-ac1h

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/viewer-jobs-queued.test.ts` | cp-jobs-queued-time-ac1h | new e2e through a real `bin/cp-view`: one job per wait reason with its queued-at stamp and derived wait, the served Jobs row ticking on the tab's own clock, and a started job keeping only `waited`; no conversion owner, no exception or deletion credit claimed |
<!-- /manifest:incoming -->
