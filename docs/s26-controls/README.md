# S26 executed controls

Retirement controls, hashes and declaration mappings are documented in ../testing-migration/s26.md.
S26 closes with 32 mapped declarations, four retained verbatim and two parked pending-fix shutdown declarations.
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

Bridge controls used `tests/e2e/bridge-host-s26.test.ts`: `bridge-attach.patch` fails read-only startup attachment;
`bridge-ledger.patch` fails replay suppression (one instead of zero); `bridge-notifications.patch` fails the attached
status after actual start. All three hashes and inline patches are in the declaration ledger.

| Retained control | sha256 | Observed result |
|---|---|---|
| retained-listener.patch | 262a2c79e02b7c688245f4e132b66290a5a9654430cdbfab86c24589ed2f0fe1 | real host diagnostic passes; verbatim drain diagnostic fails listener count |
| retained-version.patch | fa36cabd008645bc1ded63b6cdf78c4179f6c01b668ce47784eac44c35ad819d | real host diagnostic passes; verbatim legacy version declaration fails diagnostic output |
| retained-stopping.patch | b6377b8fd394335aefccc2f02a4aaae1b932acb0bc71de2323d969c47bb58be9 | both real bridge cases pass; both injected stopping variants fail start retried |

`dashboard-busy.patch` used `npm run test:one -- tests/e2e/dashboard-refusals-s26.test.ts` and failed the real busy
status equality (actual empty blockers/null reason). SHA-256: 8599c7b62c6a15e4b2238eea4aca47d9097d6a59b3aa12f9dbc4c0967ff299df.
The restored case passes all seven refusal requests; the shutdown declarations and their original file remain parked.
