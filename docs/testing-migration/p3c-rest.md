# Ledger rows: p3c-rest

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P3c-rest | 05 | `tests/e2e/landing.test.ts` | ci-watch: 75 mapped, 4 retained in tests/ci-watch-retained.test.ts, 1 pending-fix (71) parked by frozen Addendum 1. #443 is on main; S10b owns mapping 71 and retirement by sequencing decision. Main-CI's 39 declarations are accounted in #416. [Evidence](testing-migration-s03-declarations.md), [controls](testing-migration-s03b-controls.md). |
<!-- /manifest:prs -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| `tests/awaiting-merge-tick.test.ts` | a lock taken after session_start still sweeps on the next interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: transfer ownership to an already-started parent session. Acquisition occurs only at session_start, before timer registration; release only at session_shutdown. The startup-guard probe passes 05-12 and is not a failing consumer control. |
| `tests/awaiting-merge-tick.test.ts` | session_shutdown clears the startup catch-up and the interval | — | retained | verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest). Missing entry point: observe timer callbacks after shutdown while ownership remains held, including before the startup timer fires. Shutdown releases the lock and exits; removing both clears passes 05-12 but fails the retained unit. |
<!-- /manifest:assertions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/awaiting-merge-tick-retained.test.ts` | P3c-rest | convert, owner P3c-rest; two declarations retained verbatim from tests/awaiting-merge-tick.test.ts; no public entry point transfers a running session's lock or observes dormant timers after shutdown |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/awaiting-merge-tick.test.ts` | deleted | P3c-rest | RENAME ONLY, not retired coverage: tests/awaiting-merge-tick-retained.test.ts keeps both declarations (convert, owner P3c-rest). The checker requires `deleted` for an absent baseline path; it rejects `retained` unless that original path exists. Both assertion dispositions remain retained, with zero removed-declaration or deleted-file credit. |
| `tests/ci-watch.test.ts` | convert | P3c-rest | behavior 05 follow-on; 80 declarations: 75 mapped, 4 retained in tests/ci-watch-retained.test.ts, 1 pending-fix (71) parked by frozen Addendum 1. #443 is already on main and the blocker is gone; S10b owns mapping 71 and whole-file retirement by sequencing decision. |
| `tests/integrate-held-ci.test.ts` | deleted | P3c-rest | S07: three declarations mapped to 05-13 and 05-S07; NC-37 and S07-NC-1..3; S03 strengthens startup recomputation, actual worker death and queued integrate assertions; original blob 367d199760c7c5927e5cc1fe268aa97d862bc4e5 |
<!-- /manifest:baseline -->
