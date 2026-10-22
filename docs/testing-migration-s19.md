# S19 declaration conversion evidence

Scope: only bridge-reattach, cp-bridge-reattach, deferred-recheck, escalation-relay-watch and send-first-gate.
Final accounting: 28 mapped, 9 retained, 0 pending across 37 declarations in five original files.
All five original paths are retired; nine declarations remain verbatim in three retained replacements.
Retained declarations earn no deletion credit. The checker-required absent-path exception is documented in the manifest.

Entry points: real `pi --mode rpc` operator with cp-bridge, real parent-host Unix socket and real parent pi;
all models are served by MockProvider. Agent settings/models use isolated `cp-agent-*` directories under TMPDIR,
removed in teardown. The resumed run uses the worktree-local `.t` root with a CommonJS package boundary for fake CLIs;
its logs and run setup remain in `node_modules/.cache/s19/`, and temporary fixture directories are removed.

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

Original deferred-recheck blob: `4c18990f86b4d0e0261238dcea0a18e29905352b` at
`534cd14d952af040f2385fd92f3ee968a810ee62`. Its 23 declarations are fully disposed below: 17 mapped, 6 retained.
All six retained declarations are byte-for-byte copies of the original declaration bodies, checked with the TypeScript AST.

S19-4 observes the actual review verdict at the parent model request, before another tool can recheck the gate.
S19-9 runs actual CI/review races, CI read failures followed by a new successful run, and a three-row late CI gate.
The supported wake-rule switch exposes CI facts to the parent; `cp_project list` records receipt without re-gating awaiting rows.
Real CLI query timestamps prove both rechecks overlap, and another real store writer adds an unrelated decision in flight.
S19-10 delivers real CI facts before checking unreviewed, superseded and unpushed heads; S19-4 covers red/running review facts.
S19-11 starts a real plan reviewer with `cp_gate` and observes its native verdict without any CI query or awaiting-file change.

| Deferred ordinal / declaration | Disposition | Consumer proof / failing control assertion |
|---|---|---|
| 1 real passing/revise wake-up | mapped S19-4 | NC-8 leaves the decision deferred at verdict receipt; NC-18 makes a revise read the CI gate and fails the query-count assertion; awaiting bytes also remain unchanged in the positive revise case. |
| 2 malformed/absent/foreign payload | retained | `report_verdict`, pending-review recovery and native finish functions validate/build the wake-up; no public parent/tool entry accepts an arbitrary primitive or contradictory `ReviewWakeup`. The full mixed declaration remains in deferred-recheck-retained; valid native gate/revise variants also run in S19-11/4. |
| 3 running-CI row opens once without render | mapped S19-9 race | NC-19 makes the actual CI consumer see a deferred row instead of open; NC-20 produces two promotion notices. No status render is used. |
| 4 green but unreviewed, stale head and repeat | mapped S19-4 ready | NC-8 fails the open-at-verdict snapshot; stale review leaves the initial row deferred, and a later public render repeats neither the decision nor notice. |
| 5 ReviewRuns awaits before send | mapped S19-4 ready | NC-8 leaves the real parent verdict snapshot deferred instead of open. |
| 6 throwing before hook | retained | The public extension supplies CommandPost's `async` before hook, whose bounded recheck absorbs storage/probe failure. There is no public entry to inject the synchronous throwing callback used here; its whole declaration stays verbatim. |
| 7 after-hook ordering and synchronous throw | retained | Public `afterWakeup` calls `HeldContinuation.onVerdict`, an async method; it cannot produce this injected synchronous `afterWakeup threw` branch. No parent/tool option replaces that callback. The known-regression ordering and fault assertions stay together verbatim. |
| 8 CommandPost before-hook wiring | mapped S19-4 ready | NC-8 removes the actual extension hook and fails the open-at-verdict parent snapshot. |
| 9 concurrent CI/review, one promotion and third writer | mapped S19-9 race | NC-20 fails one-notice (two notices); NC-21 fails preservation of the unrelated concurrent decision. Actual persisted IDs remain unique. |
| 10 both CI readers fail, later recovery | mapped S19-9 failure | NC-25 opens the failed racers' decision and fails the one-deferred-row assertion. A real later CI run opens that same ID once and preserves the concurrent writer. |
| 11 real default budgets | mapped S19-4 ready | NC-28 zeroes the recheck budget and NC-29 zeroes the outer review budget; each fails the open-at-verdict parent snapshot. Production budgets remain 30 seconds; zero exists only in the recorded deliberate defects. |
| 12 unbounded before hook and injected deadline | retained | No public RPC/tool setting supplies `beforeWakeupTimeoutMs` or replaces the native callback with an unbounded promise. The native callback has its own 30-second bounded recheck; the injected outer-hook branch and slot assertions stay verbatim. |
| 13 synchronous before-hook throw | retained | CommandPost wraps the configured before hook in an async function, so even real filesystem failure cannot synchronously throw at ReviewRuns' hook invocation. There is no public callback replacement entry; the specific branch stays verbatim. |
| 14 CI gate exceeds deadline | mapped S19-9 late | NC-22 removes the bound and fails the deferred-at-CI-delivery assertion. The positive consumer spends the actual deadline, sees nothing opened at timeout and receives one bounded warning. |
| 15 probe failure and irrelevant no-op | mapped S19-9 failure / S19-4 revise | NC-25 fails the same-deferred-decision assertion; NC-18 makes an irrelevant revise probe CI. A probe's fail-closed result emits no failed-recheck warning; malformed input guards also remain in retained declaration 2. |
| 16 late CI completion | mapped S19-9 late | NC-23 removes the real late continuation and fails the one-promotion-notice assertion after the three original rows open. |
| 17 late review completion | mapped S19-4 late | NC-23 times out waiting for the real late gate's operator notice. Three original IDs survive and open without an additional status render. |
| 18 late failure reports once | mapped S19-4 late-failure | NC-24 reports the failed late continuation again and fails `late failure must not report a second warning` (two instead of one); no decision opens and the process continues. |
| 19 in-bound never takes late path | mapped S19-4 ready | NC-16 removes the returned in-bound rows and fails the one-opening/one-notice assertion. The positive real parent has no second late turn. |
| 20 foreign/unknown no-op matrix | retained | S19-11/NC-30 pins the native plan-gate no-op and S19-4/NC-18 pins native revise. The mixed declaration also injects `surface: future` and quality `details.next: proceed`: REVIEW_SURFACES rejects the former and QualityReportSchema has no `next` field (additional properties forbidden). No native/recovered quality or tool entry constructs those wake-ups; the full original stays verbatim without deletion credit. |
| 21 red/running/unreviewed/superseded/missing heads | mapped S19-4 red/running / S19-10 | NC-26 bypasses the review precondition and fails `unreviewed must not open a merge decision`. All five real variants preserve the deferred ID and emit no ready notice. |
| 22 notice format | mapped S19-4 ready | NC-17 removes the decision name and fails the actual operator notice regex. One line, cp_decide and the 300-character bound are asserted. |
| 23 wiring lint and guidance | mapped S19-9 / S19-4 | NC-19 fails CI receipt ordering; NC-8 fails review receipt ordering; NC-23 fails late notice delivery; NC-27 removes the manual unknown-CI fallback and fails its actual model-context regex. Syntax-only closure-count/order and path-spelling assertions are redundant-unreachable behind these named consumer outcomes, with no separate declaration credit. |

The retained rows name unavailable product entry points. Their source evidence is
`CommandPost`'s async before wrapper, `HeldContinuation.onVerdict`'s async signature, the closed `ReviewSurfaceSchema`,
and `QualityReportSchema`/`QualityPanel.start`'s constructed details. The valid native branches run through actual reviewers.
All retained declaration bodies, including known-regression assertions, remain intact.

Original send-first-gate blob: `a5e4866f76f5e8db5320cac602994bc5b88a52e4` at
`22a6ead8bfbc9c5087cca4ac02e5873923b324d6`. All four declarations map to S19-5/6/7/8 and the file is retired.
The real parent receives framed user/custom sends and durable notices. Public RPC `clear_queue` distinguishes
notices still held by SendFirstGate from notices already passed to pi: held notices survive the clear and later
reach the model; passed notices are removed. This is necessary because RPC pendingMessageCount counts user
queue strings, while extension custom messages enter the agent queue directly. No private queue is inspected.

- Declaration 1: NC-9 removes the user-role guard; the custom marker incorrectly preserves a notice behind the
  cleared queue, creating 3 model requests instead of 2.
- Declaration 2: NC-10 bypasses holding and NC-11 clears on tool turns; both lose ordinary notices at clear_queue
  and time out waiting for the model's post-reply request. NC-12 holds answered decisions, so the supposedly
  cleared answer reaches the model. NC-15 reverses flush order and fails the consumer ordering assertion.
- Declaration 3: NC-13 removes settle clearing; a resumed reply releases the notice only after queue clearing,
  creating 3 model requests instead of 2. The positive case waits for the second actual agent_settled event.
- Declaration 4: NC-14 resets the oldest hold clock. The oldest notice survives clearing before settle and
  unexpectedly reaches the model. The positive case measures from the first actual emission, within 120 seconds,
  and receives middle/fresh notices once. Exact private offer return values are not exposed by parent RPC.

The shared held-home fixture is extracted from headless-lifecycle; the complete existing file passes after the
extraction. All temporary production mutations are restored. Patch files NC-9 through NC-17 and their exact
hashes, source commit and failing assertions are recorded in the shared manifest regression table.
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


## Deferred completion controls

NC-18 through NC-30 use source commit `1a0861bed9caec7a2ceaef4dccd3e0b2925ea7b3`.
Each patch ran alone against production and was restored before the next control. Both NC-23 consumers ran with the same patch.
The default-budget zero values in NC-28/29 are deliberate defects only; shipped test timeouts retain the 5-second floor.
All 30 controls have patch/hash regression rows and balanced inline patch markers in the shared manifest.

| Control / patch | SHA-256 | Scenario and observed consumer failure |
|---|---|---|
| [NC-18](testing-migration-s19-controls/NC-18.patch) | 8ca85d25ccbd99762cff508bbe5816800357b99367149fcc48a8f889ded3cad1 | S19-4 revise: a revise verdict must not read the CI gate |
| [NC-19](testing-migration-s19-controls/NC-19.patch) | ee7dcb337ee1e7285d2cd5282959b016c7c2d058b8bc8f37a94438474f6a6880 | S19-9 race: the CI wake must reach its consumer after the raced gate completes |
| [NC-20](testing-migration-s19-controls/NC-20.patch) | b871b500ed174f787fbb401326fd634affc3ff4f8ff4383e11c8eb34fe663dcb | S19-9 race: one decision promotion must produce one notice (two received) |
| [NC-21](testing-migration-s19-controls/NC-21.patch) | df6294c2ec381f827ae935f5ffca1d970c2ba593def37c05fe0d7a567dad0369 | S19-9 race: the concurrent unrelated writer must survive both rechecks |
| [NC-22](testing-migration-s19-controls/NC-22.patch) | 50607cfafda3d24ede436e4326f76356567e2ace1686a1133b82aeb7053535e8 | S19-9 late: bounded CI delivery must precede the slow gate's writes |
| [NC-23](testing-migration-s19-controls/NC-23.patch) | 7195e71a55cf6cd5f9cca87e3f2f0623486d5b2a9c2e2946ad850c438f1ab254 | S19-9 late: one promotion notice (zero received); S19-4 late: timeout waiting for late gate announces actual opened decisions |
| [NC-24](testing-migration-s19-controls/NC-24.patch) | 0cd3d5fe11f894346da8b1e704c1749e00c5016b8b38699ac8d112fbf00306a8 | S19-4 late-failure: late failure must not report a second warning |
| [NC-25](testing-migration-s19-controls/NC-25.patch) | 5f1eb59cc899f92f1d1597cb7e51a8cf9398abee57195670dc47ca50786166f1 | S19-9 failure: failed racers must keep the same deferred decision |
| [NC-26](testing-migration-s19-controls/NC-26.patch) | e821197675861a113e9d3976864cf5a0b0239dec773e5097b6dc9e19fd76a3ce | S19-10 unreviewed: unreviewed must not open a merge decision |
| [NC-27](testing-migration-s19-controls/NC-27.patch) | de0b5c6bb6707d2e3c615b9cf34e52b831deec31bb633f2b21a1f10f1a16abc2 | S19-9 race: actual model context fails unknown-CI manual-fallback regex |
| [NC-28](testing-migration-s19-controls/NC-28.patch) | 51889a6bdf4b64c29796c1c87e783530a18465420e53e95bdffefdd58a27e8cf | S19-4 ready: row state when actual verdict reaches parent is deferred instead of open |
| [NC-29](testing-migration-s19-controls/NC-29.patch) | e1499900506bc3b6f66a3365ddb5d066df30f59449b9adeae0240e891c4cd7ca | S19-4 ready: row state when actual verdict reaches parent is deferred instead of open |
| [NC-30](testing-migration-s19-controls/NC-30.patch) | 6ff37e5c2e33f19fe238e1a1b2529ce2ce5093b15a078845c8ab046b0b9afa3a | S19-11: a native plan gate must not probe the held merge gate |

Focused commands use `npm run test:one --` with `tests/e2e/wake-deferred.test.ts` for S19-9/10/11 and
`tests/e2e/headless-lifecycle.test.ts` for S19-4; `--test-name-pattern` selects the root and `--test-skip-pattern`
selects the named variants. Exact executions and failures are in worktree-local `node_modules/.cache/s19/NC-*.log`.

The initial CI-await mutation passed a post-delivery state check: another reader could already have opened the row.
The case now snapshots state at the actual model request and uses the supported wake-rule switch to expose the CI turn.
The same production patch then fails the receipt assertion. Its early passing attempt earns no retirement credit.


## Addendum 1 — frozen S14 review 1 carry-ins

Operator-supplied findings under the standing delegation:

> “Retained/moved evidence must not claim deletion credit. Checker-required absent-path `deleted` exception must be confirmed/explained.” (main session carry-in)
>
> “Every `patch:<NC>` block requires matching closing marker and checker zero findings.” (main session carry-in)
>
> “Slice ledger must give measured file/declaration counts before → after.” (main session carry-in)
>
> “Every control needs a regression-table patch/SHA-256 row.” (main session carry-in)

Confirmed against the current checker: its six dispositions include no `moved`, and an absent baseline path must use `deleted` or `deleted-with-feature`. The five absent original paths use `deleted`; the nine moved bodies remain `retained` and the three replacements are incoming retained evidence. No retained declaration earns deletion credit. The shared S19 row records measured totals; all 30 controls have matching closing markers, regression rows and verified patch hashes.
