# Ledger rows: p8b

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8b | 04 | tests/e2e/worker-lifecycle-p8b.test.ts | 4 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-6 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: dispatch freezes the resolved hard bounds, and a bad worker-bounds.json refuses before any lease |
| 04-7 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a delivered send starts a fresh wall-clock round, and tool starts carry across it |
| 04-8 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a bound names the job, bound and work on disk, and the redispatched worker is bounded again |
| 04-9 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a legacy record without frozen bounds revives on env bounds, never the home file |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/bounds.test.ts | defaults match limen-scale caps and sit past the wedge warning | 04-6 | mapped | Default dispatch freezes 5400 s / 900 calls on the fleet record. |
| tests/bounds.test.ts | env override, malformed values keep the default | 04-6 | mapped | Env 12/4 is frozen; "nope"/"0" fall back to the defaults. |
| tests/bounds.test.ts | per-dispatch override wins over env | 04-6 | mapped | cp_dispatch override 8/3 beats env 99/99. |
| tests/bounds.test.ts | wall clock precedence: explicit override > home data/worker-bounds.json > env > default | 04-6 | mapped | Home file 1800 beats env; override 8 beats the file; tool cap ignores the file. |
| tests/bounds.test.ts | a present but malformed data/worker-bounds.json refuses, naming the file and field | 04-6 | mapped | Ten malformed bodies refuse dispatch with no fleet record. |
| tests/bounds.test.ts | allow_dispatch_override=false enforces the machine value | 04-6 | mapped | Equal override dispatches; different wall/cap refuse, flag-only file uses env then default. |
| tests/bounds.test.ts | rearm starts a fresh wall-clock round without resetting the tool count (fake clock) | 04-7 | mapped | Real cp_send rearms the 10 s round; a pre-send tool start still trips cap 2. |
| tests/bounds.test.ts | the wall-clock timer trips even when it fires 1 ms before Date.now() shows the full cap | — | retained | Verbatim in tests/bounds-retained.test.ts: timer/clock skew needs a mocked clock no entry point offers. |
| tests/bounds.test.ts | tool-call cap trips at the limit; wall-clock uses spawn or open-tool age | — | retained | Verbatim in tests/bounds-retained.test.ts: exact 9 s/10 s and open-tool-age boundaries need a mocked clock. |
| tests/bounds.test.ts | the notice names the job, the bound, and what is on disk | 04-8 | mapped | onHardBound notice names job, cap, the uncommitted file and the untouched worktree. |
| tests/bounds.test.ts | a revived worker re-arms the hard bound guard for the same jobId | 04-8 | mapped | Bounded recovery redispatches the same job id and its new worker trips the cap again. |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Guard | Scenario | Control | Evidence | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-P8b-env-parse | tests/bounds.test.ts | src/bounds.ts parsePositiveInt | 04-6 | accept a non-positive env value | — | dispatch of env-typo refused writing an invalid fleet.json | pass |
| NC-P8b-precedence | tests/bounds.test.ts | src/bounds.ts resolveJobHardBounds | 04-6 | env wall clock before the home file | — | home-file bounds deepEqual | pass |
| NC-P8b-missing-field | tests/bounds.test.ts | src/bounds.ts homeWorkerBounds | 04-6 | accept a file with no wall_clock_seconds | — | Missing expected rejection: bad-0 | pass |
| NC-P8b-enforce | tests/bounds.test.ts | src/bounds.ts resolveJobHardBounds | 04-6 | ignore allow_dispatch_override=false | — | Missing expected rejection: enforced-wall | pass |
| NC-P8b-rearm | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch rearm | 04-7 | rearm keeps the spawn round's start | — | the spawn round's 10s passed; the new round has not | pass |
| NC-P8b-count-reset | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch rearm | 04-7 | rearm resets the tool-start count | — | tool-round never failed (timed out) | pass |
| NC-P8b-retrip | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch watch | 04-8 | keep the tripped mark across a respawn | — | timed out waiting for a second bound | pass |
| NC-P8b-notice | tests/bounds.test.ts | src/bounds.ts formatBoundNotice | 04-8 | drop "worktree left untouched" | — | notice does not match /job recorded failed; worktree left untouched/ | pass |
| NC-P8b-legacy | tests/bounds.test.ts | src/revive.ts hardBounds fallback | 04-9 | legacy revive reads the home file | — | legacy-bounds never failed at 4 s (timed out) | pass |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8b.test.ts | P8b | behavior 04 hard bounds; 4 runtime cases |
| tests/bounds-retained.test.ts | P8b | 2 declarations retained/moved verbatim; mocked-clock boundaries |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/bounds.test.ts` | deleted | P8b | behavior 04: 9 assertions mapped to 04-6..04-9, 2 retained in tests/bounds-retained.test.ts |
<!-- /manifest:baseline -->
