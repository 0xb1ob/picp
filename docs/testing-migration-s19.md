# S19 declaration conversion evidence (in progress)

Scope: only bridge-reattach, cp-bridge-reattach, deferred-recheck, escalation-relay-watch and send-first-gate.
Current accounting: 4 mapped, 1 retained, 32 pending; one original file retired and replaced by one retained file.
The other four original files remain intact. No pending declaration earns deletion credit.

Entry points: real `pi --mode rpc` operator with cp-bridge, real parent-host Unix socket and real parent pi;
all models are served by MockProvider. Agent settings/models use `/tmp/cp-agent-*`, removed in test teardown.

## Declaration accounting

Original escalation-relay-watch blob: `f3e85481871b4137bbf4a60168a78f9c2964d8ee`.

| Original declaration | Disposition | Consumer proof / failing control assertion |
|---|---|---|
| 1 dueDirect eligibility matrix | retained | The host socket watcher always feeds EscalationStore.open(); an answered record cannot reach dueDirect, including from seeded legacy state. The declaration remains verbatim in tests/escalation-relay-watch-retained.test.ts. Reachable eligibility also runs through S19-2. |
| 2 host watch, restart and undelivered backstop | mapped S19-2 | NC-3: restart must not reframe an existing outbox relay; real socket frame received unexpectedly. Actual operator model also receives a seeded overdue decision through the backstop. |
| 3 attempted write is framed once | mapped S19-2 | NC-2: failed outbox write must not reframe each tick; actual 2, expected 1. |
| 4 read failures propagate visibly | mapped S19-2 | NC-5: timeout waiting for visible read failure in parent-host log. |
| 5 direct relay formatting and identity | mapped S19-2 | NC-4: actual host text fails project-tagged decision regex; kind, escalationId and jobId also pinned. |

## Executed controls

Control source base: `53d55fb0d144cee0109e0086ad98add0a196e056`.
Each patch was applied alone to production, the focused scenario executed, and production restored.
The full focused file passed before retirement; the extended host-watch case including the real operator backstop
also passed before retirement. Post-retirement focused checks are recorded with the next delivery commit.
Apply the recorded patches with `git apply --unidiff-zero` against the source base.

| Control / recorded patch | SHA-256 | Scenario and observed failure |
|---|---|---|
| [NC-1](testing-migration-s19-controls/NC-1.patch) | 3d33e3f2ca7b40c98fb267e59d6c89d0a6a28465303a890559c1f49288e3f7ea | S19-1; timeout waiting for bridge reattaches to replacement host after 45 seconds; not yet retirement evidence for cp-bridge-reattach |
| [NC-2](testing-migration-s19-controls/NC-2.patch) | 7c4d57a6682275a28ab9bd00eb9a94346ba4f7c1efb68302d50f61e55d2754ba | S19-2; failed outbox write must not reframe each tick: actual 2, expected 1 |
| [NC-3](testing-migration-s19-controls/NC-3.patch) | 9f4653b93f70f3d463920b80ee4fdd299763b868bcc97db2081a11752d4e494d | S19-2; restart must not reframe an existing outbox relay: actual true, expected false |
| [NC-4](testing-migration-s19-controls/NC-4.patch) | db39261155d548331f55a6ed40fbb26aa610ec643dae1a60a32dc98dee0ff344 | S19-2; actual relay text is `[project unknown] S19 mutation removed the decision text`, fails the decision regex |
| [NC-5](testing-migration-s19-controls/NC-5.patch) | 8e9fa61a9a799f3cf28781cf192a971c6897e0315b86bd8a138479924cfbb869 | S19-2; timeout waiting for visible read failure for escalations.json in host log |

Commands: `npm run test:one -- tests/e2e/wake-delivery.test.ts` for NC-1;
`node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern 'host escalation watch' --test-force-exit tests/e2e/wake-delivery.test.ts` for NC-2/3/4/5.

NC-3 initially passed: outbox storage deduplicates a stable id even when the host wrongly reframes it.
The scenario was extended to observe actual host subscriber frames; rerunning the mutation then failed the
restart-frame assertion. A separate eligibility timing failure during development was discarded as evidence.

No coverage-runner claim is made: it is explicitly optional in the slice brief. Runtime positive and negative
consumer assertions are the retirement evidence. No production behavior is changed by this slice.
