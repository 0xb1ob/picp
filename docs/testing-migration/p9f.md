# Ledger rows: p9f

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9f (cp-e2e-migration-p9f-4ylo) | behavior 11, sixth slice: the operator's relay consumer (`tests/operator-delivery.test.ts`) through a real cp-bridge in an RPC operator over a seeded home, in `tests/e2e/operator-relay-p9f.test.ts`. 24 declarations: 16 mapped, 8 retained verbatim in `tests/operator-delivery-retained.test.ts`; controls P9f-R1..R15, P9f-T1..T4. Also aligns p9.md's P9b assertion notes with their `P9b-NC*` ids (#523 review low). Stopped on the session context budget; cp-bridge, intake, parent-delivery, parent-outbox and send stay `convert` | 1 (mixed move: no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 11, sixth slice. P9f-relay-recheck seeds the relay outbox and ack journal, escalations, the fleet, a drain record and
parent sends on a scratch home, then starts the real cp-bridge in an RPC pi three times: the first start delivers and
retires, the second (store corrupted, drain gone) hands over only the new relays, and the third (acks unreadable) delivers
nothing. P9f-relay-turn holds the operator's turn on a hanging mock step and enqueues relays around it.

The two other #523 review lows were already closed by P9e: `userMessageContent` is mapped by control I6 (p9d.md, relabelled
by P9e), and the exact-ms 24 h TTL and 7-day lost-send boundaries are kept in `tests/control-pending-retained.test.ts`.

Not reachable: mutating the consumer's per-session reclaim skip passes both P9f scenarios and `operator-compact`; a real
pi never hands a relay off without it reaching context, so (d)..(d4) stay retained.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9f | 11 | `tests/e2e/operator-relay-p9f.test.ts` | 2 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9f-relay-recheck | `tests/e2e/operator-relay-p9f.test.ts` | P9f-relay-recheck: a seeded outbox is rechecked at delivery, retired with reasons, acked at context entry and never handed twice |
| P9f-relay-turn | `tests/e2e/operator-relay-p9f.test.ts` | P9f-relay-turn: relays wait out the operator's turn, informational ones are quiet, and a batch is capped |
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
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/operator-relay-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-relay-recheck, P9f-relay-turn through a real cp-bridge |
| tests/operator-delivery-retained.test.ts | cp-e2e-migration-p9f-4ylo | eight verbatim declarations: reclaim, emit_failed and the answered backstop recheck no real pi reaches |
<!-- /manifest:incoming -->
