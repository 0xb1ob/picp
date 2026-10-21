# S19 declaration conversion evidence (in progress)

Scope: only bridge-reattach, cp-bridge-reattach, deferred-recheck, escalation-relay-watch and send-first-gate.
Current accounting: 11 mapped, 3 retained, 23 pending; three original files retired with two retained replacements.
The deferred-recheck and send-first-gate originals remain intact. No pending declaration earns deletion credit.

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

Original cp-bridge-reattach blob: `089f0e15737bcb406265a1613cd122a693681e53`.
Its one declaration maps to S19-1 under NC-1, rerun after adding real parent send outcomes.
The real host is killed by its owned PID; its owned parent is stopped, then the replacement starts explicitly.
The operator model receives unseen/live sends and pre-gap/gap escalations in four distinct turns; no extra
request occurs after replay. The generation stays unchanged while absent, then advances once.

Original bridge-reattach blob: `0faa9ec985ee517e81c437d8fdc79d02b07a16e6`.
Declarations 1 and 4 map to S19-3 under NC-6 and NC-7. Declarations 2 and 3 are preserved verbatim in
`tests/bridge-reattach-retained.test.ts`. The public cancel caller is operator `session_shutdown`, after which
that process exits; there is no continuing operator entry point to inspect the resumed injected callback.
The other retained declaration synchronously invokes schedule inside the attempt; real `reattachOnce` has no
await between track/afterAttach and returning, so socket-close I/O cannot enter that synchronous window.
The real entry point's ordinary later close is exercised by S19-3 instead.

Deferred-recheck declarations 4, 5, 8 and 19 map to S19-4 ready mode under NC-8, but stay in the original
until all of that file is disposed. At the model request carrying the actual passing review, the disk row
is already open. A stale pass on a different head leaves it deferred before review. A public status render
then repeats the gate without another decision or operator notice. The remaining review matrix cases are
in progress and earn no additional mapping/deletion credit yet.
## Executed controls

Control source base: `53d55fb0d144cee0109e0086ad98add0a196e056`.
Each patch was applied alone to production, the focused scenario executed, and production restored.
The full focused file passed before retirement; the extended host-watch case including the real operator backstop
also passed before retirement. Post-retirement focused checks are recorded with the next delivery commit.
Apply the recorded patches with `git apply --unidiff-zero` against the source base.

| Control / recorded patch | SHA-256 | Scenario and observed failure |
|---|---|---|
| [NC-1](testing-migration-s19-controls/NC-1.patch) | 3d33e3f2ca7b40c98fb267e59d6c89d0a6a28465303a890559c1f49288e3f7ea | S19-1; timeout waiting for bridge reattaches to replacement host after 45 seconds; rerun on the extended real-send scenario |
| [NC-2](testing-migration-s19-controls/NC-2.patch) | 7c4d57a6682275a28ab9bd00eb9a94346ba4f7c1efb68302d50f61e55d2754ba | S19-2; failed outbox write must not reframe each tick: actual 2, expected 1 |
| [NC-3](testing-migration-s19-controls/NC-3.patch) | 9f4653b93f70f3d463920b80ee4fdd299763b868bcc97db2081a11752d4e494d | S19-2; restart must not reframe an existing outbox relay: actual true, expected false |
| [NC-4](testing-migration-s19-controls/NC-4.patch) | db39261155d548331f55a6ed40fbb26aa610ec643dae1a60a32dc98dee0ff344 | S19-2; actual relay text is `[project unknown] S19 mutation removed the decision text`, fails the decision regex |
| [NC-5](testing-migration-s19-controls/NC-5.patch) | 8e9fa61a9a799f3cf28781cf192a971c6897e0315b86bd8a138479924cfbb869 | S19-2; timeout waiting for visible read failure for escalations.json in host log |
| [NC-6](testing-migration-s19-controls/NC-6.patch) | 144b1e6d4522172d680a1093af116c565ff6dce64257af08f3ff11e6fdde97b1 | S19-3; retry delay must cap at 30 seconds: 64009 |
| [NC-7](testing-migration-s19-controls/NC-7.patch) | dc7f844a16a4c94e976114e44dec581e28cdaafd4e90a992ec296acf9c0f9fe6 | S19-3; timeout waiting for silent established host is probed and detached |
| [NC-8](testing-migration-s19-controls/NC-8.patch) | 6560446f04e528f94725566c2e0a40f2f36c64a0b4e88481ccc51050387437fc | S19-4 ready; decision must already be open when verdict reaches parent |

Commands: `npm run test:one -- tests/e2e/wake-delivery.test.ts` for NC-1;
`node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern 'host escalation watch' --test-force-exit tests/e2e/wake-delivery.test.ts` for NC-2/3/4/5.
`npm run test:one -- tests/e2e/wake-reattach.test.ts` for NC-6/7;
`node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern 'rpc S19:' --test-force-exit tests/e2e/headless-lifecycle.test.ts` for NC-8 (before adding the other matrix variants).

NC-3 initially passed: outbox storage deduplicates a stable id even when the host wrongly reframes it.
The scenario was extended to observe actual host subscriber frames; rerunning the mutation then failed the
restart-frame assertion. A separate eligibility timing failure during development was discarded as evidence.

No coverage-runner claim is made: it is explicitly optional in the slice brief. Runtime positive and negative
consumer assertions are the retirement evidence. No production behavior is changed by this slice.
