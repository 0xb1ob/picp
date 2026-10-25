# S26 executed controls

Retirement controls and declaration mappings are documented in ../testing-migration/s26.md.
S26 closes with 32 mapped declarations, four retained verbatim and two parked pending-fix shutdown declarations.
Apply the patches with `git apply --unidiff-zero` and restore production code after each run.

| Patch | Command after `npm run test:one --` | Observed failure |
|---|---|---|
| journal.patch | tests/e2e/drain-worker-s26.test.ts | Missing expected JSON exception; removing the journal bypasses the real corrupted outbox |
| reviewer.patch | --test-name-pattern='settles before' tests/e2e/drain-reviewer-s26.test.ts | Expected draining, actual drained; a real cp_review child was excluded from busy keys |
| delivery.patch | --test-name-pattern='actual session delivery' tests/e2e/drain-edge-s26.test.ts | Timed out waiting for stale outcome discard; the session received an outcome for a missing drain |
| lock.patch | --test-name-pattern='second real session' tests/e2e/drain-edge-s26.test.ts | Expected lock refusal, actual drained: safe to restart from the second session |
| unsupported.patch | --test-name-pattern='real bridge restart' tests/e2e/drain-restart.test.ts | Exact unsupported-restart response assertion fails |

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
status after actual start. All three are described in words in the declaration ledger.

| Retained control | Observed result |
|---|---|
| retained-listener.patch | real host diagnostic passes; verbatim drain diagnostic fails listener count |
| retained-version.patch | real host diagnostic passes; verbatim legacy version declaration fails diagnostic output |
| retained-stopping.patch | both real bridge cases pass; both injected stopping variants fail start retried |

`dashboard-busy.patch` used `npm run test:one -- tests/e2e/dashboard-refusals-s26.test.ts` and failed the real busy
status equality (actual empty blockers/null reason).
The restored case passes all seven refusal requests; the shutdown declarations and their original file remain parked.
