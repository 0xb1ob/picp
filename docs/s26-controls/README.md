# S26 executed controls

Retirement controls, hashes and declaration mappings are documented in ../testing-migration/s26.md.
Drain coverage is complete: 21 declarations mapped and two preserved verbatim; bridge/dashboard work continues.
Apply the patches with `git apply --unidiff-zero` and restore production code after each run.

| Patch | sha256 | Command after `npm run test:one --` | Observed failure |
|---|---|---|---|
| journal.patch | 50d7436ebf4862df3d539fd22089a9b5f6e21e921d2d709f4f155310b2d351e7 | tests/e2e/drain-worker-s26.test.ts | Missing expected JSON exception; removing the journal bypasses the real corrupted outbox |
| reviewer.patch | 20633d9f6830b1ff64c41d9728063500754c3032cf69efdea2cd5cb02e31c63a | --test-name-pattern='settles before' tests/e2e/drain-reviewer-s26.test.ts | Expected draining, actual drained; a real cp_review child was excluded from busy keys |
| delivery.patch | f8b8f3e519f222b99096318aad3c913b9b4dae6a6d7a1e8e1082c2dfeea607a8 | --test-name-pattern='actual session delivery' tests/e2e/drain-edge-s26.test.ts | Timed out waiting for stale outcome discard; the session received an outcome for a missing drain |
| lock.patch | cc4a68666943872863e64c36e27b95ca2d5444d86baf51c9b281380593010d63 | --test-name-pattern='second real session' tests/e2e/drain-edge-s26.test.ts | Expected lock refusal, actual drained: safe to restart from the second session |
| unsupported.patch | a7a64795c6862c7e17df567cffba594eded3efaedd8a9be1eecaa2a9e8f3f00f | --test-name-pattern='real bridge restart' tests/e2e/drain-restart.test.ts | Exact unsupported-restart response assertion fails |

Additional executed commands after `npm run test:one --`:

- `cancel-remove.patch`: drain-worker-s26 and drain-edge-s26 full files fail cancellation file-removal assertions.
- `outcome-retract.patch`: drain-worker-s26 fails cancellation/startup pending-outcome assertions.
- `lock-check.patch`: `--test-name-pattern='second real session' tests/e2e/drain-edge-s26.test.ts` fails the non-owner status render (drained instead of draining).
- `external-delete.patch`: `--test-name-pattern='external delete while actual' tests/e2e/drain-worker-s26.test.ts` fails no-resurrection (timeout instead of undefined).
- `update-idle.patch`: `--test-name-pattern='production updater dry-run' tests/e2e/drain-worker-s26.test.ts` fails idle update classification (skipped_busy instead of would drain/update).
- `start-gates.patch`: `--test-name-pattern='dispatch prevents|death during|reports while draining' tests/e2e/drain-worker-s26.test.ts` fails all three; `--test-name-pattern='real tools refuse' tests/e2e/drain-gates-s26.test.ts` fails dispatch/review/gate/released-send refusals.
- `continuation.patch`: `--test-name-pattern='held continuation' tests/e2e/drain-gates-s26.test.ts` fails expected draining/actual wait.
- `restart-live.patch`: `--test-name-pattern='production updater dry-run' tests/e2e/drain-worker-s26.test.ts` fails the actual cp_parent stop warning (zero instead of one live idle worker).

Retained controls earn no retirement credit: leaving `released()` owned passes real RPC new_session but fails the
retained reused-post test. Removing diagnostic unsubscribe or the legacy version prefix passes the real host diagnostic
consumer but fails the corresponding verbatim declaration in tests/drain-retained.test.ts. All mutations were restored.
