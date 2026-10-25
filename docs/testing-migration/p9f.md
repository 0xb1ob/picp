# Ledger rows: p9f

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9f (cp-e2e-migration-p9f-4ylo) | behavior 11, sixth slice: the operator's relay consumer (`tests/operator-delivery.test.ts`) through a real cp-bridge in an RPC operator over a seeded home, in `tests/e2e/operator-relay-p9f.test.ts` (24 declarations: 16 mapped, 8 retained verbatim in `tests/operator-delivery-retained.test.ts`; controls P9f-R1..R15, P9f-T1..T4); the parent send outbox (`tests/parent-outbox.test.ts`) through the in-process CpBridge, a real parent host process and the dashboard restart preflight, in `tests/e2e/parent-send-p9f.test.ts` and S26-dashboard-refusals (20 declarations: 18 mapped, 2 retained verbatim in `tests/parent-outbox-retained.test.ts`; controls P9f-S1..S21). Also aligns p9.md's P9b assertion notes with their `P9b-NC*` ids (#523 review low) and maps `relayIdsOfMessage` through a seeded legacy session (P9f-relay-legacy-ids, #515 review low) | 2 (mixed moves: no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 11, sixth slice. P9f-relay-recheck seeds the relay outbox and ack journal, escalations, the fleet, a drain record and
parent sends on a scratch home, then starts the real cp-bridge in an RPC pi three times: the first start delivers and
retires, the second (store corrupted, drain gone) hands over only the new relays, and the third (acks unreadable) delivers
nothing. P9f-relay-turn holds the operator's turn on a hanging mock step and enqueues relays around it.

The two other #523 review lows were already closed by P9e: `userMessageContent` is mapped by control I6 (p9d.md, relabelled
by P9e), and the exact-ms 24 h TTL and 7-day lost-send boundaries are kept in `tests/control-pending-retained.test.ts`.

Not reachable: mutating the consumer's per-session reclaim skip passes both P9f scenarios and `operator-compact`; a real
pi never hands a relay off without it reaching context, so (d)..(d4) stay retained.

P9f-send-* drive the parent send outbox through `CpBridge.send`/`observe`/`sweepSends` against a real RPC parent,
seed the outbox and a 420-entry parent transcript for the restart reconcile, and start a second parent host process
for another owner's relays. S26-dashboard-refusals (restart preflight) gains a newer writer's unknown fields: the
tolerant read's one consumer. Not reachable: the notice-once guards in `overdue` and in `markPendingNotice` each hold
alone (P9f-S16 removes both); `reserveOuterRetry`'s invalid-limit refusal takes the only caller's constant, whose cap
P9f-send-ladder pins.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9f | 11 | `tests/e2e/operator-relay-p9f.test.ts`, `tests/e2e/parent-send-p9f.test.ts` | 7 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9f-relay-recheck | `tests/e2e/operator-relay-p9f.test.ts` | P9f-relay-recheck: a seeded outbox is rechecked at delivery, retired with reasons, acked at context entry and never handed twice |
| P9f-relay-turn | `tests/e2e/operator-relay-p9f.test.ts` | P9f-relay-turn: relays wait out the operator's turn, informational ones are quiet, and a batch is capped |
| P9f-relay-legacy-ids | `tests/e2e/operator-relay-p9f.test.ts` | P9f-relay-legacy-ids: a resumed legacy session acks only its well-formed cp-bridge relay ids |
| P9f-send-receipts | `tests/e2e/parent-send-p9f.test.ts` | P9f-send-receipts: a send is durable beside the session, framed with its trimmed rule, and its receipt climbs to owner_observed |
| P9f-send-batch | `tests/e2e/parent-send-p9f.test.ts` | P9f-send-batch: sends landing in one span share one reply, a stop names what reached the parent, and a new owner relays the unobserved |
| P9f-send-reconcile | `tests/e2e/parent-send-p9f.test.ts` | P9f-send-reconcile: a restart lands, requeues or names each injected send, expires the stale one and trims observed history |
| P9f-send-ladder | `tests/e2e/parent-send-p9f.test.ts` | P9f-send-ladder: a transient failure retries the same send id up to the ladder's cap, counted per send and kept on disk |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/operator-delivery.test.ts | (a) one relay is one message, acked only at context entry; a new owner over the same files delivers nothing | P9f-relay-recheck | mapped | every delivered id acked; the restarted operator hands over only the new relays; controls P9f-R11, P9f-R14 |
| tests/operator-delivery.test.ts | (b) emitted but unacked: a new owner re-emits once | P9f-relay-recheck | mapped | P9F-FOREIGN, emitted by a dead owner, is delivered once; control P9f-R7 |
| tests/operator-delivery.test.ts | (b') the same owner in a new session file re-emits | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; needs an emit that never reached context, which a real pi never leaves |
| tests/operator-delivery.test.ts | (c) same owner and session: three pokes are one emit, never a trickle | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; the bridge's pokes cannot be ordered against an unacked emit from outside |
| tests/operator-delivery.test.ts | (d) an idle settle with nothing pending re-emits this session's unacked emits; pending messages hold them | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; reclaim needs a hand-off that never reached context |
| tests/operator-delivery.test.ts | (d2) picp-75g: reclaim-once is per consumer instance and per session | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; the reclaim skip mutated passes both P9f scenarios |
| tests/operator-delivery.test.ts | (d3) picp-75g: a failed reclaim is not counted; an ack clears | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; a reclaim hand-off never throws in a real pi |
| tests/operator-delivery.test.ts | (d4) picp-75g: busy holds the whole pass and never spends the reclaim | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; the busy half is mapped by P9f-relay-turn (P9f-T1) |
| tests/operator-delivery.test.ts | (e) three relays raised during the operator's turn go out as one coalesced message on settle | P9f-relay-turn | mapped | three relays enqueued under a hanging turn; control P9f-T1 |
| tests/operator-delivery.test.ts | N9: a message of informational relays only is quiet; one actionable relay makes it triggering | P9f-relay-turn | mapped | no provider request for the quiet pair; the actionable batch starts one; control P9f-T2 |
| tests/operator-delivery.test.ts | coalescing is capped; the remainder goes on the next pass; a send outcome stays alone with its send_id | P9f-relay-turn | mapped | RELAY_COALESCE_MAX + 3 wakes and a send; controls P9f-T3, P9f-T4 |
| tests/operator-delivery.test.ts | (f) an escalation answered before delivery is a discard line with its reason and a retired: status, never a bare skip | P9f-relay-recheck | mapped | P9F-ANSWERED in the acks fold, the retired: suffix and the status line; controls P9f-R1, P9f-R10 |
| tests/operator-delivery.test.ts | (g) a send outcome a tool result already returned is discarded 'returned in tool result' | P9f-relay-recheck | mapped | P9F-OBSERVED for an owner_observed send; control P9f-R2 |
| tests/operator-delivery.test.ts | (g2) cp-ukqv: a drain wake is rechecked against the live state/drain.json; a stale one arrives as one line with no stop or hold to act on | P9f-relay-recheck | mapped | a moved and an old drain notice, then no drain on disk; control P9f-R5 |
| tests/operator-delivery.test.ts | (h) a 2 h old wake is delivered headline-only under stale — do not act, and still acked | P9f-relay-recheck | mapped | P9F-OLD keeps its first line only; controls P9f-R6, P9f-R15 |
| tests/operator-delivery.test.ts | (i) a throwing hand-off appends emit_failed and the relay is due at the next poke | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; pi's sendMessage never throws in a real session |
| tests/operator-delivery.test.ts | (j) an escalation named in a send reply is a discard line; an overdue backstop relay is still delivered | P9f-relay-recheck | mapped | P9F-SAME retired, the 11 min old escalation delivered; controls P9f-R8, P9f-R9 |
| tests/operator-delivery.test.ts | cp-gb8d: an overdue backstop relay survives a send-reply mention, never the answered recheck | — | retained | kept verbatim in tests/operator-delivery-retained.test.ts; the survive half is mapped (P9f-R9), the answered half needs an overdue answered relay the escalation watch never enqueues |
| tests/operator-delivery.test.ts | a send reply that names an escalation queued in the same pass retires it (replied rule before classify) | P9f-relay-recheck | mapped | the send and P9F-SAME queued together; control P9f-R8 |
| tests/operator-delivery.test.ts | unreadable files are named on the status line, never treated as empty silence | P9f-relay-recheck | mapped | a corrupt escalation store and an acks path that is a directory; controls P9f-R12, P9f-R14 |
| tests/operator-delivery.test.ts | (k) cp-nbxo incident replay: a wake whose escalation was answered and whose jobs moved on after it was queued is retired, never delivered | P9f-relay-recheck | mapped | P9F-HANDLED with its already-handled reason; controls P9f-R4, P9f-R13 |
| tests/operator-delivery.test.ts | (k2) cp-nbxo fail-open: no es- id, an undecided, early, withdrawn, unknown or mixed escalation, an unmoved job or an unreadable store delivers the wake in full | P9f-relay-recheck | mapped | OPEN, EARLY, UNKNOWN, FAILED, HELD, GONE, SECOND, WITHDRAWN, MIXED and BADSTORE in full; controls P9f-R3, P9f-R14 |
| tests/operator-delivery.test.ts | (k3) cp-nbxo: a fleet job named only in the prose blocks the drop until it moved on | P9f-relay-recheck | mapped | P9F-PROSE names the still-running cp-zzzz and is delivered in full |
| tests/operator-delivery.test.ts | (k4) cp-nbxo: error, escalation and drain relays keep their own rechecks | P9f-relay-recheck | mapped | P9F-ERROR in full beside the drain notices; controls P9f-R5, P9f-R15 |
| tests/parent-outbox.test.ts | the outbox file sits beside the session file | P9f-send-receipts | mapped | `the outbox sits beside cp-parent.jsonl` |
| tests/parent-outbox.test.ts | enqueue is on disk before it returns, with a well-formed id | P9f-send-receipts | mapped | the ps- id and the file after the first send; an empty send writes nothing; control P9f-S3 |
| tests/parent-outbox.test.ts | restart read drops unknown optional fields; the strict read still rejects them | P9f-send-receipts | mapped | the bridge start refuses unknown fields naming the file; S26-dashboard-refusals' preflight still names the pending send past them; control P9f-S20 |
| tests/parent-outbox.test.ts | delegation survives reload and batching without changing legacy send records | P9f-send-batch | mapped | default and absent rules in the framed bodies, blank rules refused, a restart rewrites nothing; per-send provenance is P10e-quotes; control P9f-S18 |
| tests/parent-outbox.test.ts | send rules are trimmed and truncated to 200 characters before persistence and framing | P9f-send-receipts | mapped | the stored and framed rule; control P9f-S2 |
| tests/parent-outbox.test.ts | truncation preserves Unicode boundaries through accepted send framing | P9f-send-receipts | mapped | an emoji straddling the cut is dropped whole; control P9f-S1 |
| tests/parent-outbox.test.ts | injection reserves, a refused write rolls back, landing is idempotent | — | retained | kept verbatim in tests/parent-outbox-retained.test.ts; no harness entry point makes a real pi refuse one RPC prompt write |
| tests/parent-outbox.test.ts | receipts map each state onto the existing levels; failed never reaches owner_observed | P9f-send-receipts | mapped | owner_observed once, turn_failed with its error, pending by id, an undeliverable receipt that reached nothing; controls P9f-S4, P9f-S5 |
| tests/parent-outbox.test.ts | the attempt ceiling and the max age end a send undeliverable, never silently | P9f-send-reconcile | mapped | a queued send at the ceiling and a 25 h old one, both relayed; controls P9f-S13, P9f-S17 |
| tests/parent-outbox.test.ts | reconcile: seen lands, absent requeues, unprovable is undeliverable | P9f-send-reconcile | mapped | a 420-entry seeded transcript; controls P9f-S9, P9f-S10 |
| tests/parent-outbox.test.ts | sendRelayText keeps the furthest established delivery fact and its cause | P9f-send-batch | mapped | landed at stop and after 24 h, unprovable and never injected in P9f-send-reconcile; controls P9f-S7, P9f-S11 |
| tests/parent-outbox.test.ts | relaysDue skips this owner's own relays and keeps another owner's unobserved ones | P9f-send-batch | mapped | a second parent host process relays all but the observed send; control P9f-S8 |
| tests/parent-outbox.test.ts | trimming keeps every unobserved entry and the newest observed ones | P9f-send-reconcile | mapped | 202 seeded observed entries; controls P9f-S12, P9f-S14 |
| tests/parent-outbox.test.ts | an invalid file is refused, naming the path | P9f-send-receipts | mapped | status().sendsError and the refused send name the file |
| tests/parent-outbox.test.ts | frameBatch round-trips through sendIdsInText; relays carry send_id in details | P9f-send-batch | mapped | the framed markers, and observe() marks only a cp-bridge message's own send_id; control P9f-S21 |
| tests/parent-outbox.test.ts | reserveOuterRetry: landed-only, capped, independent of injections, survives reload and settle | P9f-send-ladder | mapped | five reservations then a terminal failure, per-send counters, attempts separate; the invalid-limit guard is unreachable (constant caller); control P9f-S15 |
| tests/parent-outbox.test.ts | a record without outer_retry_attempts reads as zero; a negative or fractional one is refused | P9f-send-ladder | mapped | the field absent until a first retry, then 1; -1 and 0.5 refused at start in P9f-send-receipts |
| tests/parent-outbox.test.ts | reserveOuterRetry returns no ordinal when nothing was persisted | — | retained | kept verbatim in tests/parent-outbox-retained.test.ts; a state change between the read and the write needs an interleave no entry point injects |
| tests/parent-outbox.test.ts | pending_notice_at round-trips the schema; markPendingNotice writes once and never on a terminal send | P9f-send-reconcile | mapped | two sweeps, one notice, stamped on disk; control P9f-S16 |
| tests/parent-outbox.test.ts | unload-parent PR3: sends sharing a span end share one reply; separate spans and failed marks keep their own | P9f-send-batch | mapped | three sends in one span: one reply and two pointers, the earlier span's own reply; control P9f-S6 |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P9f-R1 | tests/operator-delivery.test.ts | P9f-relay-recheck | operator-delivery.ts never discards an answered escalation | `one coalesced message, oldest first, the stale wake last` |
| P9f-R2 | tests/operator-delivery.test.ts | P9f-relay-recheck | the owner_observed send discard never matches | `a send outcome goes alone with its send_id` |
| P9f-R3 | tests/operator-delivery.test.ts | P9f-relay-recheck | the answered-before-queued check is dropped, so an early answer retires the wake | `one coalesced message, oldest first, the stale wake last` |
| P9f-R4 | tests/operator-delivery.test.ts | P9f-relay-recheck | the handled-wake discard is disabled | `one coalesced message, oldest first, the stale wake last` |
| P9f-R5 | tests/operator-delivery.test.ts | P9f-relay-recheck | the stale drain recheck is disabled | `a stale drain notice is one line` |
| P9f-R6 | tests/operator-delivery.test.ts | P9f-relay-recheck | the stale age is a thousand times longer | the stale headlines-only match |
| P9f-R7 | tests/operator-delivery.test.ts | P9f-relay-recheck | an emit reserves the relay whatever its owner or session | `one coalesced message, oldest first, the stale wake last` |
| P9f-R8 | tests/operator-delivery.test.ts | P9f-relay-recheck | the named-in-send-reply discard is off | `one coalesced message, oldest first, the stale wake last` |
| P9f-R9 | tests/operator-delivery.test.ts | P9f-relay-recheck | the overdue backstop exception is removed | timed out waiting for the outbox and the overdue backstop relay delivered |
| P9f-R10 | tests/operator-delivery.test.ts | P9f-relay-recheck | the retired list is never cleared after a delivery | `a retirement is named once` |
| P9f-R11 | tests/operator-delivery.test.ts | P9f-relay-recheck | the ack line is never appended at context entry | timed out waiting for every delivered relay acked at context entry |
| P9f-R12 | tests/operator-delivery.test.ts | P9f-relay-recheck | unreadable acks are read as empty | timed out waiting for `cp-relays: acks unreadable (` |
| P9f-R13 | tests/operator-delivery.test.ts | P9f-relay-recheck | a handled wake skips to the next escalation id instead of retiring | `one coalesced message, oldest first, the stale wake last` |
| P9f-R14 | tests/operator-delivery.test.ts | P9f-relay-recheck | an unreadable escalation store retires the wake as answered | `a new owner over the same files hands over only the new relays` |
| P9f-R15 | tests/operator-delivery.test.ts | P9f-relay-recheck | the stale age is applied to every relay kind, not only wakes | `one coalesced message, oldest first, the stale wake last` |
| P9f-T1 | tests/operator-delivery.test.ts | P9f-relay-turn | the running-turn guard is removed | `nothing is handed over while the operator's turn runs` |
| P9f-T2 | tests/operator-delivery.test.ts | P9f-relay-turn | the quiet flag is dropped from informational-only messages | `a message of informational relays only starts no turn` |
| P9f-T3 | tests/operator-delivery.test.ts | P9f-relay-turn | the coalesce cap is raised by 100 | `a send outcome stays alone; coalescing is capped and the remainder goes on the next pass` |
| P9f-T4 | tests/operator-delivery.test.ts | P9f-relay-turn | a send outcome is never split out of the batch | timed out waiting for the send, the capped batch and its remainder |
| P9f-L1 | tests/operator-outbox.test.ts | P9f-relay-legacy-ids | relayIdsOfMessage keeps every non-null relay id, numbers and empty strings included | `only the well-formed cp-bridge ids are acked, once each` |
| P9f-L2 | tests/operator-outbox.test.ts | P9f-relay-legacy-ids | relayIdsOfMessage reads relay_ids from any custom message, not only cp-bridge | `only the well-formed cp-bridge ids are acked, once each` |
| P9f-S1 | tests/parent-outbox.test.ts | P9f-send-receipts | the rule cut keeps a lone high surrogate | the send rejects with `URI malformed` from the marker |
| P9f-S2 | tests/parent-outbox.test.ts | P9f-send-receipts | the rule is not trimmed | `trimmed and cut at 200 characters, never splitting a code point` |
| P9f-S3 | tests/parent-outbox.test.ts | P9f-send-receipts | the empty-text refusal is removed | `an empty send is refused before it is written` |
| P9f-S4 | tests/parent-outbox.test.ts | P9f-send-receipts | markObserved accepts an already observed send | `observed once` |
| P9f-S5 | tests/parent-outbox.test.ts | P9f-send-receipts | a failed receipt drops the turn's error | `the stored receipt keeps the turn's error` |
| P9f-S6 | tests/parent-outbox.test.ts | P9f-send-batch | the shared-span pointer text changes | `one full reply, then pointers for the sends in the same span` |
| P9f-S7 | tests/parent-outbox.test.ts | P9f-send-batch | the relay ignores landed_at | `a landed send says it landed, never 'not delivered'` |
| P9f-S8 | tests/parent-outbox.test.ts | P9f-send-batch | relaysDue keeps only never-relayed entries | timed out waiting for a new host process to relay the previous owner's unobserved outcomes |
| P9f-S9 | tests/parent-outbox.test.ts | P9f-send-reconcile | the transcript window is never consulted | the lost send's `undeliverable` state |
| P9f-S10 | tests/parent-outbox.test.ts | P9f-send-reconcile | a send seen in the transcript is never marked landed | `a send framed in the transcript lands, then settles; never requeued` |
| P9f-S11 | tests/parent-outbox.test.ts | P9f-send-reconcile | a never-injected send is worded as unconfirmed | `and a never-injected send says it was not delivered` |
| P9f-S12 | tests/parent-outbox.test.ts | P9f-send-reconcile | the observed cap is 1,000 higher | `observed history is trimmed to its cap` |
| P9f-S13 | tests/parent-outbox.test.ts | P9f-send-reconcile | the max age never expires a queued send | `a 25 h old queued send expires` |
| P9f-S14 | tests/parent-outbox.test.ts | P9f-send-reconcile | trimming drops the newest observed entries | `the oldest observed entries go first` |
| P9f-S15 | tests/parent-outbox.test.ts | P9f-send-ladder | one reservation past the cap | `capped, and the terminal record keeps the count` |
| P9f-S16 | tests/parent-outbox.test.ts | P9f-send-reconcile | both notice-once guards removed (each alone is equivalent) | `one pending notice, never two` |
| P9f-S17 | tests/parent-outbox.test.ts | P9f-send-reconcile | the attempt ceiling is one higher | `the attempt ceiling ends a queued send` |
| P9f-S18 | tests/parent-outbox.test.ts | P9f-send-receipts | a blank delegation rule is accepted | the blank-rule rejection does not match `delegation_rule must not be blank` |
| P9f-S19 | tests/parent-outbox.test.ts | P9f-send-reconcile | a landed send never ages out | the silent send's `no reply within 24 h of landing` |
| P9f-S20 | tests/parent-outbox.test.ts | S26-dashboard-refusals | the restart read keeps unknown fields | the refusal never names `cp_parent send <id> pending` |
| P9f-S21 | tests/parent-outbox.test.ts | P9f-send-batch | sendIdOfMessage reads any custom message type | `a foreign message observes nothing` |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/operator-relay-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-relay-recheck, P9f-relay-turn through a real cp-bridge |
| tests/operator-delivery-retained.test.ts | cp-e2e-migration-p9f-4ylo | eight verbatim declarations: reclaim, emit_failed and the answered backstop recheck no real pi reaches |
| tests/e2e/parent-send-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-send-receipts, -batch, -reconcile, -ladder through CpBridge and a real parent host |
| tests/parent-outbox-retained.test.ts | cp-e2e-migration-p9f-4ylo | two verbatim declarations: a refused RPC write's rollback and the reserveOuterRetry read/write race |
<!-- /manifest:incoming -->
