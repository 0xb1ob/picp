# Ledger rows: p9h

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9h (cp-e2e-migration-p9h-hdo6) | behavior 11, eighth slice: the parent bridge (`tests/cp-bridge.test.ts`) through a real `CpBridge` over a real parent pi on the mock provider, in `tests/e2e/cp-bridge-p9h.test.ts` (85 declarations: 31 mapped to P9h-bridge-* and to P9f, P9, S24, S25 and S26 scenarios, 54 retained verbatim in `tests/cp-bridge-retained.test.ts`; controls P9h-S29..S33). #546 low: the sweep-edge comment in `tests/parent-delivery-retained.test.ts` now says the edges are new | 1 (mixed move: no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 11, eighth slice. Each P9h-bridge-* scenario starts a real `CpBridge` with a scratch home and agent dir, so
the parent is a real `pi --mode rpc` that talks to the mock provider. The scenarios read the bridge's receipts, relays,
status, control record, session files, archive and viewer rows: owner_observed receipts, a transient 503 resumed once,
compaction refused while a send is pending, a SIGKILL relaunch into the same session, rotation, model precedence and
live switch, refused `cp_escalate` calls, and the operator main session's commands.

Retained, not reachable: the 54 kept units depend on the fake parent's injection knobs or on direct helper calls.
The knobs are synthetic wakes, worker pid files, busy stats, diagnostics outcomes and argv capture. The helper calls
are operator targets, argv and skill builders, `parentEnv`, model resolution and observe stubs. Each row names what
is missing. The real host's attach and backlog are pinned by S26, its compaction by S24 and S25, and the send outbox
by P9f.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9h | 11 | `tests/e2e/cp-bridge-p9h.test.ts` | 5 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9h-bridge-receipts | `tests/e2e/cp-bridge-p9h.test.ts` | P9h-bridge-receipts: a send climbs to owner_observed, a transient turn resumes once, compaction waits for settlement and stop is observed |
| P9h-bridge-relaunch | `tests/e2e/cp-bridge-p9h.test.ts` | P9h-bridge-relaunch: a killed parent relaunches its same session once and never replays a send; rotation moves that session |
| P9h-bridge-model | `tests/e2e/cp-bridge-p9h.test.ts` | P9h-bridge-model: start precedence, a live switch and rotation settle the parent model without a restart |
| P9h-bridge-escalation | `tests/e2e/cp-bridge-p9h.test.ts` | P9h-bridge-escalation: a refused cp_escalate is one error notice, never keyed by its call id; a retry in the same turn relays only the escalation |
| P9h-bridge-operator | `tests/e2e/cp-bridge-p9h.test.ts` | P9h-bridge-operator: the operator main session offers cp_parent and never a fleet tool |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/cp-bridge.test.ts | receipt levels are the five names and not accepted | P9h-bridge-receipts | mapped | `BRIDGE_RECEIPT_LEVELS` and a real receipt that never names http_accepted or accepted |
| tests/cp-bridge.test.ts | send returns owner_observed and the reply; http_accepted is not claimed | P9h-bridge-receipts | mapped | reached injected, turn_settled, owner_observed; the reply is the model's text; status alive, pid, session file, lastReplyAt |
| tests/cp-bridge.test.ts | parent controls compact only when settled and status reports context tokens | P9h-bridge-receipts | mapped | a hang send pends and compact rejects; manual compact reports tokensBefore; control P9h-S29 |
| tests/cp-bridge.test.ts | N6: a length stop is not compacted, and the skip is logged once | S25-low | mapped | the `skipped_length_stop raw= effective= threshold=200000` daemon line and no compaction |
| tests/cp-bridge.test.ts | C1: a failed automatic compact is logged and relayed, never silent | S25-auto | mapped | the failed outcome reaches the daemon log and one `parent automatic context control failed:` relay |
| tests/cp-bridge.test.ts | C1: a timed-out automatic compact is logged once as timed_out | S25-auto | mapped | `timed_out ... error="timeout after 5000ms` logged and the timed-out relay |
| tests/cp-bridge.test.ts | rotate archives old session and relaunches the new file | P9h-bridge-relaunch | mapped | new session file, same pid, archive holding the session header; a kill relaunches the rotated file and a later start opens it |
| tests/cp-bridge.test.ts | start model precedence: data/parent.json model beats the saved control model and a resolved model; an explicit start model beats the file | P9h-bridge-model | mapped | saved beats env, file beats saved, explicit skips the file, an invalid file model is ignored; control P9h-S31 |
| tests/cp-bridge.test.ts | rotate applies the configured parent model; a set_model rejection keeps the running model, relays one error and still returns | P9h-bridge-model | mapped | rotation applies the file model; an unknown model relays one `parent rotate kept` error and keeps the model; control P9h-S30 |
| tests/cp-bridge.test.ts | rotate keeps an explicit start model and a live cp_parent model switch over data/parent.json; absent explicit, the file applies | P9h-bridge-model | mapped | an explicit start model and a live switch both survive rotation over the file, and persist to the control record; control P9h-S31 |
| tests/cp-bridge.test.ts | operator-edited standing orders reach a fresh rotated session and viewer follows its file | P9h-bridge-relaunch | mapped | standing orders delivered once after rotation; the viewer's parentFile and parentRow follow the rotated session |
| tests/cp-bridge.test.ts | cp-hhuf P1: a cp-schedule fire turn takes its job ids from details.job_id; all-scheduled is not relayed | P9-relay-scope | mapped | a scheduled-only wake never reaches the outbox; a mixed turn does |
| tests/cp-bridge.test.ts | a re-raised escalation relays again with its refreshed numbers, under the same id | P9-relay-refresh | mapped | the re-raised escalation replaces its pending text under the same id |
| tests/cp-bridge.test.ts | a refused cp_escalate tool call is an error notice, never keyed by its raw tool call id | P9h-bridge-escalation | mapped | one error relay, no escalation relay, no escalationId taken from the call id |
| tests/cp-bridge.test.ts | a refused cp_escalate followed by a successful call in the same parent turn relays only the escalation | P9h-bridge-escalation | mapped | one escalation relay for the stored id; the error count stays at one; control P9h-S33 |
| tests/cp-bridge.test.ts | killing the parent relaunches the same session once and does not replay sends | P9h-bridge-relaunch | mapped | one relaunch notice (same session, reconcile, not replayed), no new model request; control P9h-S32 |
| tests/cp-bridge.test.ts | stop is an observed close and does not relaunch | P9h-bridge-receipts | mapped | exit code 0, not alive, no relaunch relay |
| tests/cp-bridge.test.ts | start refuses a live lock holder | P9h-bridge-receipts | mapped | a held `acquireParentLock` refuses start with `already holds` |
| tests/cp-bridge.test.ts | status lists open escalations from the store, not bodies | P9h-bridge-receipts | mapped | one open escalation with its question; paths carry the evidence path |
| tests/cp-bridge.test.ts | main session has no cp_dispatch or cp_integrate | P9h-bridge-operator | mapped | get_commands has cp-bridge, not cp-version; the /cp-bridge notice names cp_parent, never cp_dispatch or cp_integrate |
| tests/cp-bridge.test.ts | a turn whose assistant message ends in error yields turn_failed, never owner_observed, reply undefined | P9f-send-receipts | mapped | a 400 turn is turn_failed with its error and never reaches owner_observed |
| tests/cp-bridge.test.ts | a normal send turn yields owner_observed with only assistant text, never the echoed prompt | P9f-send-receipts | mapped | the receipt's reply is exactly the model's text |
| tests/cp-bridge.test.ts | H1: transient provider failure runs the outer ladder and resumes, never re-sending the original text | P9h-bridge-receipts | mapped | one 5000 ms sleep; the resume text reaches the model and the original is not re-sent |
| tests/cp-bridge.test.ts | three consecutive turn_failed sends stop the parent and emit one relaunch relay | P9f-delivery-cap | mapped | `parent model failed 3 turns in a row` relayed once, then the bridge stops |
| tests/cp-bridge.test.ts | a send that outlasts the wait returns pending, then relays its reply once by id | P9f-send-batch | mapped | a pending send relays once by id; observe() marks only a cp-bridge message's own send_id |
| tests/cp-bridge.test.ts | a send that landed before death is never re-injected, only nudged | P9f-delivery-resume | mapped | a restart nudges each landed, unanswered send once and never re-injects it |
| tests/cp-bridge.test.ts | a new bridge drains another bridge's pending sends | P9f-send-batch | mapped | a new owner relays the unobserved sends |
| tests/cp-bridge.test.ts | a corrupt send outbox refuses the start, naming the file | P9f-send-receipts | mapped | a `{ nope` outbox refuses start naming the file |
| tests/cp-bridge.test.ts | the outer retry ladder runs in the background under the same send id: pending now, one relay later | P9f-send-ladder | mapped | retries keep the same send id, journaled per attempt, with one outcome |
| tests/cp-bridge.test.ts | a restarted bridge continues a send's persisted transient budget: remaining delays only, then one failed receipt | P9f-delivery-restart | mapped | the ladder's budget survives a death mid-sleep |
| tests/cp-bridge.test.ts | parent host: a current unobserved wake is delivered on subscribe after reconnect | S26-bridge | mapped | a read-only attach delivers the unobserved backlog once |
| tests/cp-bridge.test.ts | fake-parent tracker recognizes Linux zombie process states | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; tests the fake-parent fixture's own tracker, which has no product entry point |
| tests/cp-bridge.test.ts | operator targets are keyed by home and stale pids refuse attachment | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs forged target files with dead pids under PI_HOME |
| tests/cp-bridge.test.ts | a stored single-project operator target is refused, naming the file and pids; a multi one reads unchanged | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a hand-written legacy single target, which no current entry point writes |
| tests/cp-bridge.test.ts | cp_parent start refuses mode single without spawning anything | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; single-mode-refused pins the refusal, but not that the home stays empty |
| tests/cp-bridge.test.ts | stale operator targets are retired unless their own parent still holds the lock | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a forged target whose pids are a live foreign lock holder |
| tests/cp-bridge.test.ts | parent host restart retires dead target after crash and does not replay an observed send | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a SIGKILL of the host and fake parent pids read from the host record |
| tests/cp-bridge.test.ts | operator launcher loads the bridge, pi's built-in MCP extensions and the web extension | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; a source and argv shape check of bin/cp-operator, with no runtime output |
| tests/cp-bridge.test.ts | operator argv adds only the resolved web extension, after the bridge, and only the allowlisted skills | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the argv builder's order is never visible to a running operator |
| tests/cp-bridge.test.ts | operator skills: <home>/skills/<name> wins, else <agentDir>/skills/<name>, a missing one is skipped | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; skill path resolution has no output short of a captured argv |
| tests/cp-bridge.test.ts | parent starts with --no-skills plus --skill <home>/skills/<name> for each PARENT_SKILLS entry, and nothing else skill-wise | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the parent's argv is visible only through the fake parent's argv file |
| tests/cp-bridge.test.ts | cp_parent ask accepts and records the ask's context in state/operator/asks.jsonl | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; calls the extension's tool executor with a stub ctx instead of a model turn |
| tests/cp-bridge.test.ts | automatic compact runs after settlement, never with a pending durable send | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; reads the fake parent's prompt log for compaction order against a durable send |
| tests/cp-bridge.test.ts | an immediate next send waits for automatic compaction | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the order is visible only in the fake parent's prompt log |
| tests/cp-bridge.test.ts | C1: automatic compact runs before a queued send drains, and is logged once | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; queues by writing ParentSendOutbox directly, not through an operator entry point |
| tests/cp-bridge.test.ts | C1: ready-time control compacts before a queued send drains | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; S25-queued pins the startup summary, not its order against the drain |
| tests/cp-bridge.test.ts | C1: a refused automatic compact names its reason | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs FAKE_PARENT_STATS_BUSY_ONCE, a busy get_session_stats that real pi never answers |
| tests/cp-bridge.test.ts | mission-end rotates after settlement without restarting the parent or its worker | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent's live worker pid; S25-rotate pins the rotation itself |
| tests/cp-bridge.test.ts | model changes without restarting the parent or its live worker and persists for next start | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the worker-survival half needs the fake parent's worker pid; P9h-bridge-model pins the switch |
| tests/cp-bridge.test.ts | standing orders seed once, survive operator edits, and deliver beyond 8000 characters | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; calls deliverStandingOrders with a stub send |
| tests/cp-bridge.test.ts | fresh home seeds generic operational orders and reloads them after rotation | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; calls deliverStandingOrders with a stub send around a fake-parent rotation |
| tests/cp-bridge.test.ts | a synthetic wake is relayed once, tagged, paths not bodies | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the wake is injected by FAKE_PARENT_WAKE; a real parent emits one only from a live fleet |
| tests/cp-bridge.test.ts | a wake-up about a PR URL takes its job id from the structured job field, never the URL | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a synthetic wake whose details carry a PR URL |
| tests/cp-bridge.test.ts | prose with only a PR URL names no job rather than job=https | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a synthetic wake with URL-only prose |
| tests/cp-bridge.test.ts | wake identity never comes from parent reply prose | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs synthetic wakes whose reply prose names other jobs |
| tests/cp-bridge.test.ts | a Running reply keeps the structured wake identity, including legacy IDs | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs synthetic wakes with legacy job ids |
| tests/cp-bridge.test.ts | issue #2: a wake carries the envelope summary verbatim; a killed_unreported notice reaches the operator directly | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a synthetic wake segment and a killed_unreported notice |
| tests/cp-bridge.test.ts | a landed continuation reaches the operator once without a parent reply | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a synthetic continuation wake with no reply |
| tests/cp-bridge.test.ts | a withdrawn escalation is not replayed by a stale tool result in a fresh bridge | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a stale cp_escalate tool result replayed by the fake parent |
| tests/cp-bridge.test.ts | a mission end that cp_next raised itself reaches the relay, once by id | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a fake-parent cp_next result carrying a raised mission end |
| tests/cp-bridge.test.ts | escalation on the stream is one message; stale headline is marked | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a fake-parent escalation stream with a stale headline |
| tests/cp-bridge.test.ts | a deliberately failing fake-parent test leaves no parent or descendant pid | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; tests the fixture's own cleanup through a failing child test file |
| tests/cp-bridge.test.ts | H6: a dispatch or pipeline advance carrying a risk_warning wakes the main session with that one line; a result without one relays nothing | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs fake-parent cp_dispatch results carrying risk_warning |
| tests/cp-bridge.test.ts | H1 review: a persistently transient failure runs the ladder to its full cap of 5, and never trips the 3-consecutive-turn_failed relaunch | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; P9f-send-ladder and P9f-delivery-cap pin each half, but not that an exhausted ladder counts once |
| tests/cp-bridge.test.ts | resolveParentModel: env, then session, then refusal naming both options | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; a pure resolver whose refusal needs no model in env or session |
| tests/cp-bridge.test.ts | parentEnv: CP_GATEWAY_ADMIN_KEY from the env first, else gateway.env only with capacity.json and a 0600 file; workers never get it | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; the parent's env is never visible to an operator, and a secret must not be printed |
| tests/cp-bridge.test.ts | requireAvailableParentModel refuses an unknown model before spawn, naming known models | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a stub registry probe |
| tests/cp-bridge.test.ts | a send is answered at its clean turn_end, before the run settles, and never relayed again | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent to hold agent_end after turn_end |
| tests/cp-bridge.test.ts | a wake answered at a clean turn_end relays before the run settles | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a synthetic wake and a held agent_end |
| tests/cp-bridge.test.ts | a follow-up lost with the parent is delivered once after relaunch | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent to drop a follow_up and then die |
| tests/cp-bridge.test.ts | cp_parent stop discards never-landed sends with one relay | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent's NOLAND prompt, which never lands |
| tests/cp-bridge.test.ts | operator diagnostics use the live parent's commands without creating work | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; reads the fake parent's prompt log; S26-bridge pins the real diagnostics answer |
| tests/cp-bridge.test.ts | <expr> | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts (parent diagnostics fail explicitly when the command is missing, error, silent or rejected); needs FAKE_PARENT_DIAGNOSTIC |
| tests/cp-bridge.test.ts | parent host: the parent and its live worker outlive the operator process that started them | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent's worker pid file |
| tests/cp-bridge.test.ts | cp_parent delegated send crosses the host socket and stamps the injected message | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; reads the fake parent's injected-entry log |
| tests/cp-bridge.test.ts | cp_parent starts again immediately after stopping the host | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; drives the extension's tool executor with a stub ctx over the fake parent |
| tests/cp-bridge.test.ts | cp_parent start wiring: data/parent.json model beats CP_PARENT_MODEL; an explicit model is sent as modelExplicit and beats the file | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; reads the spawned model from the fake parent's argv file; P9h-bridge-model pins the bridge half |
| tests/cp-bridge.test.ts | cp_parent start retires a dead saved target and attaches to the new live parent holding the lock | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a forged target with a reaped pid |
| tests/cp-bridge.test.ts | parent host: concurrent attaches share one host and one parent, and mutations serialize | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a raw socket request racing two clients |
| tests/cp-bridge.test.ts | parent host: a live lock without a matching host refuses; a stale socket is replaced only once host and lock pids are dead | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a forged stale host record and socket |
| tests/cp-bridge.test.ts | parent host: racing attaches over a stale record start one host; a claim from a stale reading exits without touching it | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; spawns the host module directly with a stale claim |
| tests/cp-bridge.test.ts | parent host: unobserved backlog survives reconnect, retaining stale annotations without replaying drained relays | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs synthetic wakes; S26-bridge pins the real backlog once |
| tests/cp-bridge.test.ts | parent host: withdrawal suppresses an escalation already queued for reconnect | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs a fake-parent escalation queued while no client listens |
| tests/cp-bridge.test.ts | parent host: a pending send survives its client's disconnect; stop observes the parent's close | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; needs the fake parent's HANG prompt and its own lock pid |
| tests/cp-bridge.test.ts | observe sends only cp-bridge send-id stubs, never a whole oversized context | — | retained | kept verbatim in tests/cp-bridge-retained.test.ts; a pure stub builder whose payload size is never shown to the operator |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P9h-S29 | tests/cp-bridge.test.ts | P9h-bridge-receipts | compact() skips the PARENT_UNSETTLED refusal | `Missing expected rejection: a manual compact waits for settlement` |
| P9h-S30 | tests/cp-bridge.test.ts | P9h-bridge-model | rotation ignores the configured parent model | `rotation applies the configured model` |
| P9h-S31 | tests/cp-bridge.test.ts | P9h-bridge-model | a live model switch does not mark the model explicit | `a live switch survives rotation over the file` |
| P9h-S32 | tests/cp-bridge.test.ts | P9h-bridge-relaunch | a relaunch spawns a fresh session file instead of the same one | `the earlier send is history, never replayed` |
| P9h-S33 | tests/cp-bridge.test.ts | P9h-bridge-escalation | a successful cp_escalate leaves the turn's refusals queued | `the refused call beside a successful one adds no notice` |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/cp-bridge-p9h.test.ts | cp-e2e-migration-p9h-hdo6 | P9h-bridge-* through a real CpBridge and a real parent pi on the mock provider |
| tests/cp-bridge-retained.test.ts | cp-e2e-migration-p9h-hdo6 | 54 verbatim declarations: fake-parent knobs, the parent host's forged records and pure helpers |
<!-- /manifest:incoming -->
