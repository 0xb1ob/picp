# Ledger rows: p3c-rest

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P3c-rest | 05 | `tests/e2e/landing.test.ts` | CI-watch retirement completed by S10b: 75 mapped, five retained, zero pending. Main-CI's 39 declarations are accounted in #416. [Current evidence](s10b.md). |
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
| `tests/ci-watch.test.ts` | deleted | S10b | 80 declarations: 75 mapped, five retained verbatim in tests/ci-watch-retained.test.ts (S02 6/8/32/33 and S03 70), zero pending. S10b maps 71 with the executed two-cause RPC control and replays the inherited controls; canonical evidence in testing-migration/s10b.md. |
| `tests/integrate-held-ci.test.ts` | deleted | P3c-rest | S07: three declarations mapped to 05-13 and 05-S07; NC-37 and S07-NC-1..3; S03 strengthens startup recomputation, actual worker death and queued integrate assertions |
<!-- /manifest:baseline -->
