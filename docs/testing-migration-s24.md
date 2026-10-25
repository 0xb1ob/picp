# S24 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

The authoritative declaration, scenario, regression, patch and inventory rows remain in `docs/testing-migration.md`. This summary does not split those ledgers; the S03b migration is still a prerequisite for moving them. Both sides' rows were preserved when merging S21/S15, with duplicate inventory entries consolidated.

| Owned original file | Original declarations | Mapped | Retained verbatim | Pending | Retirement |
|---|---:|---:|---:|---:|---|
| dashboard-compaction | 3 | 3 | 0 | 0 | wholly deleted |
| operator-compact | 22 | 20 | 2 | 0 | original retired; retained replacement |
| operator-context | 3 | 2 | 1 | 0 | original retired; retained replacement |
| parent-compact-hold | 7 | 4 | 3 | 0 | original retired; retained replacement |
| Original S24 total | 35 | 29 | 6 | 0 | four original paths retired; one wholly deleted-file credit |
| Incoming #447 parent knob declaration | 1 | 1 | 0 | 0 | mapped with its parent file |
| Total including incoming declaration | 36 | 30 | 6 | 0 | 16.67% retained (17.14% of original slice) |

## Retained declarations

- `tests/operator-context-retained.test.ts`: the empty-home builder declaration stays verbatim. Real bridge startup creates control state before loading context; no public consumer can call just the builder against a nonexistent home. S24-empty also pins absent preference files and zero custom context through the bridge.
- `tests/operator-compact-retained.test.ts`: the whole S1 benign-skip declaration stays verbatim because it includes synchronous `ctx.compact` throws, unavailable through the SDK's asynchronous wrapper. The reachable benign skip is additionally covered by S24-op-spent.
- The same retained compact file preserves the whole classifier declaration, including undefined/malformed input and arbitrary role/stopReason combinations unavailable through the SDK event schema. Public rejection, overload, user, abort and custom relay behavior is covered by S24-op-streak, S24-op-explicit and S24-op-nudge. Neither declaration is labelled redundant-unreachable.
- `tests/parent-compact-hold-retained.test.ts`: T3(b), T3(f) and T3(g)/(h) remain whole and byte-identical under the round-2 decision. The public entry limitations are listed below; the retained T3(f) also pins the 270,000 ms default. These three declarations earn retained credit only.

An assert-based comparison against the original unit file verified both retained compact declarations byte for byte before retirement. No original regression assertion was silently deleted.

## Public proof

Parent cases use a scratch home, real Command Post extension, actual parent RPC/JSON CLI and mock provider. `CP_PARENT_COMPACT_HOLD_SECONDS=5` is set in the parent environment; the production default remains 270 seconds. The expiry case executes manual failure, real 15-second start timeout, five-second cap expiry, disabling after three failures/expiries, successful-compaction reenable and a live setting change releasing wakes below threshold. It also verifies another agent start cannot release a held batch.

The incoming `tests/timer-knobs.test.ts` case `CP_PARENT_COMPACT_HOLD_SECONDS: default, override, garbage` pins the unchanged 270,000 ms default and invalid-input fallback. The expiry scenario closes only its undispatched schedule-run fixtures between phases so they can fire again; no public worker-completion event exists for these deliberately undispatched runs. Those setup closures are not behavior assertions.

The round-2 decision retains T3(b), T3(f) and T3(g)/(h) whole and verbatim in `tests/parent-compact-hold-retained.test.ts`. The public parent CLI/RPC has no entry to inject jobless mixed-kind wakes at individual hold offers, advance the hold clock independently through the default cap, or combine an injected threshold-cancel failure with an independent OVER reading. T3(f) preserves the explicit `PARENT_COMPACT_HOLD_MS === 270_000` assertion. Reachable schedule, busy, CI and expiry outcomes remain additionally covered by the existing e2e cases and controls; these three declarations receive retained status, not mapped credit.

The inventory follows the existing S03b/S19 convention: absent original paths use the checker's `deleted` disposition with explicit moved wording and retained destinations; retained declarations earn no deletion credit. Only dashboard-compaction is wholly deleted. All six retained declarations are named individually in the assertion map.

The ordered case steers a framed operator question through RPC during a busy hold, exercising send-first release before schedule wake delivery. Schedule notices arrive A/B/C only after manual compaction. A separate existing CI watcher fixture proves an actual fleet CI wake stays held across settlement until manual compaction; there is exactly one cp-ci arrival. Non-headless JSON print, disabled control and low context deliver without engaging a hold. Real provider length stops cancel threshold compaction repeatedly without disabling later manual and normal compaction.

Operator cases enter through the real bridge, self_compact tool, RPC compaction and SDK threshold/overflow paths. They pin validation, failed persistence, exact handoff bytes/path, settlement ordering, settings/defaults, retry and process caps, streak accounting, latest handoff enrichment and read-failure fallback. Real outbox/journal records and the health CLI pin unacked held relays, completion/cancellation release and one handoff when a relay precedes automatic compaction. No live model or test-only production hook is used.

Dashboard cases pin queue editing during compaction, one consumption after a dropped handoff, one re-hand and terminal failure after two drops. Context cases pin orders, parsed learnings, mtime-selected latest handoff, hidden startup context and persisted resume without reload. Scratch agent/auth configuration comes only from createAgentDir with the mock provider and is cleaned in test teardown; no installed-home credentials are read or copied.

## Controls and replay

All 26 canonical production mutations were executed, restored and replayed after the plain merge of main. Canonical files are in `docs/testing-migration-s24/`; each control is described in words in the main regression ledger. The interrupted no-rehand replay had no verdict, was explicitly recorded as incomplete, and was rerun to the expected failure before retirement.

Use `npm run test:one -- --test-name-pattern='<pattern>' <file>` for the commands below. Each row identifies the canonical patch basename and the expected failing public assertion. Main-ledger IDs prefix these names with S24 (operator patches use S24-compact-*).

| Patch | E2e file | Pattern | Observed failure |
|---|---|---|---|
| oldest | operator-context | entire file | newest mtime handoff missing |
| empty | operator-context | entire file | context count 1 instead of 0 |
| resume | operator-context | entire file | SHOULD NOT RELOAD appears after resume |
| hold | headless-lifecycle | survives compaction / before a self-compaction | no eventual injection/consumption |
| macrotask | headless-lifecycle | survives compaction | queue_edit returns 409 already sent |
| no-rehand | headless-lifecycle | before a self-compaction | pending state failed instead of delivered |
| third | headless-lifecycle | dropped twice | third handoff delivers instead of terminal failure |
| compact-validation | operator-compact | invalid instructions | expected empty-instructions refusal missing |
| compact-under | operator-compact | invalid instructions | small context queues instead of refusing |
| compact-early | operator-compact | queued handoff / ignored threshold | completion/settlement ordering and backstop count fail |
| compact-default | operator-compact | live operator settings | value 0 incorrectly requests at 500 tokens |
| compact-failures | operator-compact | automatic retries stop | third-failure stop notice missing |
| compact-spent | operator-compact | provider rejection compacts / skipped and failed / explicit queued | extra compaction, spent-streak notices missing |
| compact-abort | operator-compact | explicit queued | abort clears spent streak |
| compact-callback | operator-compact | held relays | both completion/cancellation variants lose durable ack |
| compact-relay-gate | operator-compact | held relays / handed to the automatic | early emits and duplicate handoff |
| compact-streak-cap | operator-compact | provider rejection compacts | two compactions instead of three |
| compact-nudge | operator-compact | rejection nudges | unanswered relay IDs absent |
| compact-enrich | operator-compact | manual summarizers / SDK threshold and overflow | four manual plus threshold/overflow variants lose enrichment |
| compact-own | operator-compact | queued handoff | own explicit instructions enriched again |
| compact-write | operator-compact | failed handoff write | persistence error swallowed and queues |
| parent-order | parent-compaction | hold in order | C/B/A instead of A/B/C |
| parent-cap | parent-compaction | failures and expiries | five-second cap never releases within ten-second wait |
| parent-busy | parent-compaction and headless-lifecycle | hold in order / rpc parent S24 | busy hold absent, fleet hold assertion fails |
| parent-context | parent-compaction | non-headless contexts | low, disabled and JSON print consumers fail |
| parent-length | parent-compaction | length stops cancel | threshold cancellation absent |

Inspected production history includes macrotask ordering, handoff recovery, benign skip handling and the #447 cap knob. Production `src/` and `extensions/` are byte-identical to main after controls are restored.

No duration exception, live-model gate or full local suite was used. Individual new cases stay below two minutes; final focused validation and measured diff size are recorded in the job artifact and PR description. CI remains the integration gate.
