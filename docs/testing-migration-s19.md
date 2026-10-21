# S19 declaration conversion evidence (in progress)

Scope: only bridge-reattach, cp-bridge-reattach, deferred-recheck, escalation-relay-watch and send-first-gate.
No source file is retired yet. The 37 original declarations remain intact while consumer evidence is built.

Entry points: real `pi --mode rpc` operator with cp-bridge, real parent-host Unix socket and real parent pi;
all models are served by MockProvider. Agent settings/models use `/tmp/cp-agent-*`, removed in test teardown.

## Executed controls

Control source base: `53d55fb0d144cee0109e0086ad98add0a196e056`.
Each patch below was applied alone to production, the focused scenario executed, and production restored.
The full focused file passed with both scenarios before the outbox restart-frame assertions were added.
No deletion credit is claimed from a control that passed.

| Control | Scenario / command selector | Failure observed |
|---|---|---|
| S19-NC-1 | `a real operator reconnects`; full focused file at one-scenario revision | timeout waiting for `bridge reattaches to replacement host` after 45 seconds |
| S19-NC-2 | `host escalation watch` | `failed outbox write must not reframe each tick`: actual 2, expected 1 |
| S19-NC-3 | `host escalation watch` | `restart must not reframe an existing outbox relay`: actual true, expected false |

Commands: `npm run test:one -- tests/e2e/wake-delivery.test.ts` for NC-1;
`node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern 'host escalation watch' --test-force-exit tests/e2e/wake-delivery.test.ts` for NC-2/3.

NC-3 initially passed: outbox storage deduplicates a stable id even when the host wrongly reframes it.
The scenario was extended to observe actual host subscriber frames; rerunning the mutation then failed the
restart-frame assertion. A separate eligibility timing failure during development was discarded as evidence.

### S19-NC-1

```diff
--- a/extensions/cp-bridge/index.ts
+++ b/extensions/cp-bridge/index.ts
@@ -405,1 +405,1 @@
-			reattach.schedule();
+			// S19 negative control: skip reconnect after host closure.
```

### S19-NC-2

Executed full git-diff blob SHA: `300b3a87476c5d8c70252e02312eb285a705b7bf`.

```diff
--- a/src/escalation-relay-watch.ts
+++ b/src/escalation-relay-watch.ts
@@ -69,1 +69,1 @@
-		ports.sent.add(escalation.id);
+		// S19 negative control: forget the attempted delivery.
```

### S19-NC-3

```diff
--- a/src/escalation-relay-watch.ts
+++ b/src/escalation-relay-watch.ts
@@ -36,1 +36,1 @@
-		.filter((item) => !inOutbox(ids, item.id));
+		.filter(() => true);
```
