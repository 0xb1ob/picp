# Ledger rows: e3-compaction

Self-review D / E3 (S1-02, L3-F1), job `cp-sr-d-compaction-atl9`: worker compaction instrumentation only. No baseline
file or declaration is deleted, moved or narrowed; `tests/e2e/worker-compaction-s25.test.ts` and
`tests/worker-compaction-retained.test.ts` are unchanged and still pass.

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| cp-sr-d-compaction-atl9 | E3 worker compaction telemetry: one new e2e file, four declarations, no production decision change | 0 |
<!-- /manifest:ledger -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-compaction-telemetry.test.ts | cp-sr-d-compaction-atl9 | Real WorkerProcess and MockProvider telemetry journeys plus the 28 L3 numeric fixtures |
<!-- /manifest:incoming -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| E3-threshold | tests/e2e/worker-compaction-telemetry.test.ts | E3 telemetry: threshold compaction records resolved override settings, retained estimate and next input |
| E3-manual | tests/e2e/worker-compaction-telemetry.test.ts | E3 telemetry: manual compaction closes on shutdown; revival and abrupt death never attach stale state |
| E3-failures | tests/e2e/worker-compaction-telemetry.test.ts | E3 telemetry: failure, cancellation, failed next response and session replacement keep correlation |
| E3-fixtures | tests/e2e/worker-compaction-telemetry.test.ts | E3 telemetry: 28 historical compactions keep terminal unknowns and distinguish useful reductions |
<!-- /manifest:scenarios -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| E3-unregistered | tests/e2e/worker-compaction-telemetry.test.ts | E3-threshold | the telemetry handlers are never registered | observation count 0 != 2 after request counts and sentinel pass; E3-manual and E3-failures fail too |
| E3-output | tests/e2e/worker-compaction-telemetry.test.ts | E3-threshold | next input adds output tokens to input, cacheRead and cacheWrite | end record nextInput total differs from 52000 |
| E3-zero | tests/e2e/worker-compaction-telemetry.test.ts | E3-manual | a closure without next usage records an all-zero next input instead of null | shutdown end record nextInput is not null |
| E3-cancel | tests/e2e/worker-compaction-telemetry.test.ts | E3-threshold | telemetry cancels a successful threshold compaction | threshold compaction summarizes once: 1 != 2; E3-failures fails the same way |
| E3-spread | tests/e2e/worker-compaction-telemetry.test.ts | E3-threshold | the start record spreads the whole hook event | start record deep-equal fails; E3-manual names key type; E3-failures finds the secret sentinel |
<!-- /manifest:regressions -->

Controls ran one at a time with `NODE_OPTIONS=--max-old-space-size=1536 timeout 180 npm run test:one --
tests/e2e/worker-compaction-telemetry.test.ts`, mutating `extensions/worker-reporter/compaction.ts` from a backup that a
`trap … EXIT` restored in the same command. These are semantic mutations, not historical defects. E3-fixtures is data
only and passes under every control; it does not reproduce historical model behaviour.
