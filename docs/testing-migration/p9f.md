# Ledger rows: p9f

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9f (cp-e2e-migration-p9f-4ylo) | behavior 11, sixth slice: the operator's relay consumer (`tests/operator-delivery.test.ts`) through a real cp-bridge in an RPC operator over a seeded home, in `tests/e2e/operator-relay-p9f.test.ts` (24 declarations: 16 mapped, 8 retained verbatim in `tests/operator-delivery-retained.test.ts`; controls P9f-R1..R15, P9f-T1..T4); the parent send outbox (`tests/parent-outbox.test.ts`) through the in-process CpBridge, a real parent host process and the dashboard restart preflight, in `tests/e2e/parent-send-p9f.test.ts` and S26-dashboard-refusals (20 declarations: 18 mapped, 2 retained verbatim in `tests/parent-outbox-retained.test.ts`; controls P9f-S1..S21); envelope intake (`tests/intake.test.ts`) through the real parent's startup intake over a seeded home, in `tests/e2e/intake-p9f.test.ts` (20 declarations: 18 mapped, 2 retained verbatim in `tests/board-publish-retained.test.ts`; controls P9f-I1..I12); parent delivery (`tests/parent-delivery.test.ts`) through a real CpBridge and parent pi in `tests/e2e/parent-delivery-p9f.test.ts` (31 declarations: 21 mapped, 10 retained verbatim in `tests/parent-delivery-retained.test.ts`; controls P9f-D1..D14, two reported). Also aligns p9.md's P9b assertion notes with their `P9b-NC*` ids (#523 review low) and maps `relayIdsOfMessage` through a seeded legacy session (P9f-relay-legacy-ids, #515 review low) | 4 (mixed moves: no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 11, sixth slice. P9f-relay-recheck seeds the relay outbox and ack journal, escalations, the fleet, a drain
record and parent sends on a scratch home, then starts the real cp-bridge in an RPC pi three times: the first start
delivers and retires, the second (store corrupted, drain gone) hands over only the new relays, and the third (acks
unreadable) delivers nothing. P9f-relay-turn holds the operator's turn on a hanging mock step and enqueues relays
around it.

The two other #523 review lows were already closed by P9e: `userMessageContent` is mapped by control I6 (p9d.md,
relabelled by P9e), and the exact-ms 24 h TTL and 7-day lost-send boundaries are kept in
`tests/control-pending-retained.test.ts`.

Not reachable: mutating the consumer's per-session reclaim skip passes both P9f scenarios and `operator-compact`; a real
pi never hands a relay off without it reaching context, so (d)..(d4) stay retained.

P9f-send-* drive the parent send outbox through `CpBridge.send`/`observe`/`sweepSends` against a real RPC parent,
seed the outbox and a 420-entry parent transcript for the restart reconcile, and start a second parent host process
for another owner's relays. S26-dashboard-refusals (restart preflight) gains a newer writer's unknown fields: the
tolerant read's one consumer. Not reachable: the notice-once guards in `overdue` and in `markPendingNotice` each hold
alone (P9f-S16 removes both); `reserveOuterRetry`'s invalid-limit refusal takes the only caller's constant, whose cap
P9f-send-ladder pins.

P9f-intake-* seed fleet records, envelopes, artifacts and board sites on a scratch home and start the real parent in
RPC pi: its startup intake takes each envelope and the cp-envelope wakes carry the card. A FIFO under a board site hangs
the parent's startup when its refusal is removed (P9f-I10). A refused no-tailnet board still leaves
`state/boards/<id>` behind; the unit never asserted otherwise, so it is reported, not pinned.

P9f-delivery-* drive a real CpBridge with `outerRetrySleep` held or instant. A startup envelope wake is the turn no send
owns; `bash sleep 2` tool calls hold a span open so a second send steers in. Two controls pass and are reported rather
than claimed: P9f-D9 (relay_failed journaled once per send id) because `relaysDue` runs once per start, so a second
failing pass inside one delivery has no entry point and that declaration is retained; P9f-D13 (the settled-mark skip in
`settle`) because the outbox's own settle is idempotent, so a second finish relays nothing a consumer could see.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9f | 11 | `tests/e2e/operator-relay-p9f.test.ts`, `tests/e2e/parent-send-p9f.test.ts`, `tests/e2e/intake-p9f.test.ts`, `tests/e2e/parent-delivery-p9f.test.ts` | 16 |
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
| P9f-intake-policy | `tests/e2e/intake-p9f.test.ts` | P9f-intake-policy: a restart takes each settled envelope once, by delivery, and never carries an artifact body |
| P9f-intake-board | `tests/e2e/intake-p9f.test.ts` | P9f-intake-board: a board envelope publishes its site at the viewer's address, and bad boards are refused with a reason |
| P9f-delivery-wake | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-wake: a wake turn that ends on a transient error is nudged on the send ladder, then relays once when exhausted |
| P9f-delivery-wake-paths | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-wake-paths: a never-retried error relays at once, a recovered wake relays nothing, a clean turn cancels a pending nudge |
| P9f-delivery-span | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-span: a send answered only by tool calls takes the next finished answer with its own commentary; a later error fails both |
| P9f-delivery-relay | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-relay: a relay that throws is journaled, never stops the rest, and lands on the next pass |
| P9f-delivery-restart | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-restart: the ladder's budget survives a death mid-sleep, and a reservation that cannot be written fails the send |
| P9f-delivery-resume | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-resume: a restart nudges each landed, unanswered send once, never a settled one or one already nudged |
| P9f-delivery-cap | `tests/e2e/parent-delivery-p9f.test.ts` | P9f-delivery-cap: failed turns count toward the relaunch cap when their outcome is pending, then the bridge stops |
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
| tests/intake.test.ts | board delivery publishes a static site and relays its URL | P9f-intake-board | mapped | the board receipt, the wake's board line and the copied site; controls P9f-I7, P9f-I12 |
| tests/intake.test.ts | production intake uses the viewer's configured address | P9f-intake-board | mapped | CP_VIEWER_HOST/CP_VIEWER_PORT in the parent's env name the url |
| tests/intake.test.ts | board delivery with no configured viewer host resolves the tailnet address the viewer binds under --require-tailnet, never a default (pi-command-post-1jz) | P9f-intake-board | mapped | a fake `tailscale ip -4` on the parent's PATH; control P9f-I9 |
| tests/intake.test.ts | board delivery with no configured viewer host and no tailnet is refused, never silently defaulted (pi-command-post-1jz) | P9f-intake-board | mapped | a failing `tailscale`: the refusal names require-tailnet and nothing is stamped |
| tests/intake.test.ts | board publication refuses a site file swapped to an external symlink after validation | — | retained | kept verbatim in tests/board-publish-retained.test.ts; the swap needs publishBoard's test-only hook between validation and copy |
| tests/intake.test.ts | board publication rejects a directory swapped to a symlink while staging | — | retained | kept verbatim in tests/board-publish-retained.test.ts; the swap needs publishBoard's test-only hook while staging |
| tests/intake.test.ts | board publication refuses a FIFO under site without blocking | P9f-intake-board | mapped | a FIFO under site is refused with its reason; control P9f-I10 hangs the parent's startup |
| tests/intake.test.ts | bad board metadata, slug and external symlinks refuse the envelope with a reason | P9f-intake-board | mapped | json, date, slug, link and traverse refused with their reasons, nothing published; controls P9f-I8, P9f-I11 |
| tests/intake.test.ts | delivery:pr holds; delivery:local is ready for teardown | P9f-intake-policy | mapped | the hold and teardown wakes, PR receipt and line; control P9f-I1 |
| tests/intake.test.ts | a ship envelope with no CI claim is accepted, and its pushed head sha becomes a receipt (cp-kzc) | P9f-intake-policy | mapped | the unverified ci receipt titled with the head; control P9f-I2 |
| tests/intake.test.ts | cp-u3o4: a delivery:answer envelope is teardown-next, and onReported carries a pointer only | P9f-intake-policy | mapped | the answer wake is teardown-next and carries no body; control P9f-I1 |
| tests/intake.test.ts | a research artifact is registered by stat and move, never read | P9f-intake-policy | mapped | the stored artifact and receipt; no body in any wake or the fleet; control P9f-I3 |
| tests/intake.test.ts | re-reporting is idempotent; the second intake writes nothing | P9f-intake-policy | mapped | a second start: no wake, no restamp, one envelope_received per job |
| tests/intake.test.ts | a blocked envelope is accepted, with its blockers | P9f-intake-policy | mapped | the wake's blockers line; control P9f-I4 |
| tests/intake.test.ts | a blocked planner envelope waits, and the wake-up carries the questions not the body | P9f-intake-policy | mapped | waiting, round 1, both questions and no body or path; control P9f-I5 |
| tests/intake.test.ts | the third blocked planner round escalates instead of asking the parent | P9f-intake-policy | mapped | an es- id and do-not-answer in the wake; control P9f-I6 |
| tests/intake.test.ts | an envelope that contradicts the dispatch record is refused, then fails the job when it is repeated | S27-intake-invalid | mapped | cp-conflict is quarantined, then fails envelope_invalid on repeat |
| tests/intake.test.ts | an exhausted worker (envelope-rejected.json) is an envelope_invalid failure | 04-4 | mapped | a real worker's rejection file fails the job envelope_invalid and the job stays failed |
| tests/intake.test.ts | nothing on disk yet is not an error | P9f-intake-policy | mapped | cp-quiet stays waiting and unstamped; the parent only intakes fleet records, so the unknown-id refusal has no caller |
| tests/intake.test.ts | intake fires from the worker's own event stream | P9e-settle | mapped | a real worker's report_result is stamped by the settle watcher |
| tests/parent-delivery.test.ts | every parent injection is one prompt with streamingBehavior steer, busy or idle | P9f-delivery-span | mapped | a send made mid-turn steers into the open span; control P9f-D1 |
| tests/parent-delivery.test.ts | segmentEnd settles each landed send at its own clean turn_end: own reply, counted once, never relayed again | P9f-send-batch | mapped | own reply per span and one relay per pending send; the settled-mark skip is shadowed (P9f-D13, reported) |
| tests/parent-delivery.test.ts | a send answered only by tool calls is not settled empty by a later send's answer | P9f-delivery-span | mapped | C's reply is D's finished answer, D points at C; control P9f-D2 |
| tests/parent-delivery.test.ts | an interleaved send's reply keeps its own commentary and shares the next finished answer | P9f-delivery-span | mapped | A's reply is its commentary plus the answer, B points at A; control P9f-D2 |
| tests/parent-delivery.test.ts | unload-parent PR3: 12 sends absorbed into one span get one full reply and 11 pointers, each settled once | P9f-send-batch | mapped | sends absorbed into one span: one full reply, pointers for the rest, each relayed once |
| tests/parent-delivery.test.ts | an interleaved send gets the run's error when no answer finished | P9f-delivery-span | mapped | E and G both turn_failed with the run's error, nothing journaled; control P9f-D6 |
| tests/parent-delivery.test.ts | cleanSegmentEnd: only a text-only turn_end that did not fail or get cut off | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; tool turns are pinned by P9f-D2, but no consumer tells a length, aborted or missing stop from settling at agent_settled |
| tests/parent-delivery.test.ts | a send injected or landed while the restart reconcile reads the transcript is never requeued nor nudged | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; needs a send to land between afterReady's get_entries request and its answer |
| tests/parent-delivery.test.ts | a superseded afterReady neither reconciles nor RPCs the old process | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; needs the live process replaced while its get_entries is in flight |
| tests/parent-delivery.test.ts | a superseded afterReady that fails leaves no stale reconcile flag | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; needs the live process replaced while its get_entries is in flight |
| tests/parent-delivery.test.ts | a failed turn counts toward the relaunch cap when its outcome is pending or relayed, not only synchronous | P9f-delivery-cap | mapped | three pending failures stop the bridge with the relaunch relay; control P9f-D12 |
| tests/parent-delivery.test.ts | H3c: a usage-limit or auth error never enters the outer ladder — zero retries | P9f-delivery-span | mapped | usage limit fails at once with an empty journal (P9f-D6); a wake's 401 in P9f-delivery-wake-paths (P9f-D3) |
| tests/parent-delivery.test.ts | H3c: a settled (never relayed) send is not nudged as 'reached you before the restart' after a relaunch | P9f-delivery-resume | mapped | a settled landed send is absent from the restart's nudge |
| tests/parent-delivery.test.ts | N5: a successor whose transcript already holds an id's resume line does not nudge it again; an empty transcript still nudges once | P9f-delivery-resume | mapped | done is skipped while its resume line is in the transcript and nudged once over an empty one; control P9f-D11 |
| tests/parent-delivery.test.ts | N5: a landed-only resume whose transcript read fails still nudges once and drains | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; a live pi's get_entries cannot be made to fail |
| tests/parent-delivery.test.ts | H3c: a relay that throws is journaled, never aborts the rest of the replay loop, and is retried until it lands | P9f-delivery-relay | mapped | an onRelay listener throws for one send: the other relays, one relay_failed row, the next start relays it once; control P9f-D10 |
| tests/parent-delivery.test.ts | H3c: a relay that keeps throwing for the same send id journals relay_failed only once | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; relaysDue runs once per start, so a second failing pass in one delivery has no entry point (P9f-D9) |
| tests/parent-delivery.test.ts | the transient retry budget is on disk: a restarted delivery continues at the next ordinal and delay | P9f-delivery-restart | mapped | the second start sleeps the second delay and reserves attempt 2; control P9f-D14 |
| tests/parent-delivery.test.ts | a death mid-sleep keeps the reservation spent; the stale timer sends nothing and the next failure takes the next ordinal | P9f-delivery-restart | mapped | a stop mid-sleep sends nothing on release; the next failure takes ordinal 2 |
| tests/parent-delivery.test.ts | a second failure while a timer is pending schedules no second timer and spends nothing | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; the same send id cannot fail in a second turn while its own timer is pending |
| tests/parent-delivery.test.ts | a spent budget fails the send once: final receipt, no timer, exhausted journaled | P9f-send-ladder | mapped | the doomed send fails once at the cap with its count kept |
| tests/parent-delivery.test.ts | a success after retries journals the persisted count | P9f-delivery-restart | mapped | outer_retry_succeeded with afterAttempts 2 across the restart; control P9f-D7 |
| tests/parent-delivery.test.ts | a reservation that cannot be written is named, schedules no retry and fails the send | P9f-delivery-restart | mapped | a corrupt outbox mid-turn: reservation_failed journaled, no rung, the send names the file; control P9f-D8 |
| tests/parent-delivery.test.ts | sweep with no live parent expires a 25 h queued send and relays it undeliverable | P9f-delivery-cap | mapped | the self-stopped bridge's sweep expires a 25 h queued send as not delivered |
| tests/parent-delivery.test.ts | a send open past 600 s gets exactly one notice, persisted as pending_notice_at | P9f-delivery-cap | mapped | two sweeps with no parent: one 'parent not running' notice, stamped on disk |
| tests/parent-delivery.test.ts | a landed send with no reply 24 h after landing ends undeliverable; stop retires a landed send | P9f-send-reconcile | mapped | the silent send ends with no reply within 24 h; the stop half is P9f-send-batch's stuck send |
| tests/parent-delivery.test.ts | a wake turn that ends on a transient error is nudged on the send ladder, then relays once when exhausted | P9f-delivery-wake | mapped | five nudges on the send delays, no send marker, exhausted once, one error relay; control P9f-D4 |
| tests/parent-delivery.test.ts | a wake turn that recovers resets the ladder; stale, non-transient and send-owned turns are never nudged | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; the reset and the stale case need a second wake turn; the reachable non-transient case is P9f-D3 |
| tests/parent-delivery.test.ts | a clean turn while a wake nudge is pending cancels it | P9f-delivery-wake-paths | mapped | an operator send's clean turn during the held sleep: no nudge on release; control P9f-D5 |
| tests/parent-delivery.test.ts | a send-owned clean turn does not reset the wake budget | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; needs a second wake turn after the send to observe the kept budget |
| tests/parent-delivery.test.ts | a wake nudge that cannot be sent gives the error relay back to the caller | — | retained | kept verbatim in tests/parent-delivery-retained.test.ts; no entry point makes a real pi refuse an RPC prompt write |
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
| P9f-I1 | tests/intake.test.ts | P9f-intake-policy | every delivery but local holds | `only pr holds; an answer needs no PR` |
| P9f-I2 | tests/intake.test.ts | P9f-intake-policy | the ci receipt drops the head sha | `silence about CI is accepted; the parent verifies the pushed head itself` |
| P9f-I3 | tests/intake.test.ts | P9f-intake-policy | no artifact receipt is stored | the cp-question artifact receipt's `stored` status |
| P9f-I4 | tests/intake.test.ts | P9f-intake-policy | the wake drops the blockers line | the `blockers: migration needs owner sign-off` match |
| P9f-I5 | tests/intake.test.ts | P9f-intake-policy | the planner round is never counted | `a blocked planner waits for an answer` |
| P9f-I6 | tests/intake.test.ts | P9f-intake-policy | every planner round asks the parent | `the third round escalates` |
| P9f-I7 | tests/intake.test.ts | P9f-intake-board | the board receipt is never stored | `the board url survives as a durable receipt, not only the one-time wake text` |
| P9f-I8 | tests/intake.test.ts | P9f-intake-board | the artifact_path check is removed | timed out waiting for every bad board refused with its reason |
| P9f-I9 | tests/intake.test.ts | P9f-intake-board | an unconfigured host is loopback | `never the loopback default` |
| P9f-I10 | tests/intake.test.ts | P9f-intake-board | a non-regular site entry is skipped, not refused | the parent's startup times out on the FIFO |
| P9f-I11 | tests/intake.test.ts | P9f-intake-board | the board slug check is removed | timed out waiting for every bad board refused with its reason |
| P9f-I12 | tests/intake.test.ts | P9f-intake-board | the wake drops the board line | the `board: http://127.0.0.2:9911/boards/cp-board/` match |
| P9f-D1 | tests/parent-delivery.test.ts | P9f-delivery-span | every injection is followUp, not steer | `one answer, one copy: B points at A` |
| P9f-D2 | tests/parent-delivery.test.ts | P9f-delivery-span | a tool-use turn_end counts as a clean segment end | `A keeps its commentary and shares the finished answer` |
| P9f-D3 | tests/parent-delivery.test.ts | P9f-delivery-wake-paths | a non-transient wake error is nudged | `never nudged, never journaled, relayed once` |
| P9f-D4 | tests/parent-delivery.test.ts | P9f-delivery-wake | the wake ladder runs one rung past the cap | the journal's attempt and exhausted rows |
| P9f-D5 | tests/parent-delivery.test.ts | P9f-delivery-wake-paths | a clean turn no longer clears the pending wake timer | `no stale nudge after a clean turn` |
| P9f-D6 | tests/parent-delivery.test.ts | P9f-delivery-span | any send failure enters the outer ladder | `a non-transient error never enters the outer ladder` |
| P9f-D7 | tests/parent-delivery.test.ts | P9f-delivery-restart | success after retries is not journaled | timed out waiting for the recovery |
| P9f-D8 | tests/parent-delivery.test.ts | P9f-delivery-restart | a failed reservation is not journaled | `named, never silent` |
| P9f-D9 | tests/parent-delivery.test.ts | P9f-delivery-relay | relay_failed is journaled on every failing pass | passes (reported): one pass per start; the declaration is retained |
| P9f-D10 | tests/parent-delivery.test.ts | P9f-delivery-relay | a failed relay is still stamped relayed | `left due, so the next pass retries it` |
| P9f-D11 | tests/parent-delivery.test.ts | P9f-delivery-resume | a resume line in the transcript is ignored | `a resume line already in the transcript is not repeated` |
| P9f-D12 | tests/parent-delivery.test.ts | P9f-delivery-cap | a final outcome never counts toward the relaunch cap | timed out waiting for the cap |
| P9f-D13 | tests/parent-delivery.test.ts | P9f-send-batch | settle no longer skips a send segmentEnd settled | passes (reported): the outbox settle is idempotent |
| P9f-D14 | tests/parent-delivery.test.ts | P9f-delivery-restart | the reservation is never written before the sleep | `reserved before the sleep` |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/operator-relay-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-relay-recheck, P9f-relay-turn through a real cp-bridge |
| tests/operator-delivery-retained.test.ts | cp-e2e-migration-p9f-4ylo | eight verbatim declarations: reclaim, emit_failed and the answered backstop recheck no real pi reaches |
| tests/e2e/parent-send-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-send-receipts, -batch, -reconcile, -ladder through CpBridge and a real parent host |
| tests/parent-outbox-retained.test.ts | cp-e2e-migration-p9f-4ylo | two verbatim declarations: a refused RPC write's rollback and the reserveOuterRetry read/write race |
| tests/e2e/intake-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-intake-policy, P9f-intake-board through the real parent's startup intake |
| tests/board-publish-retained.test.ts | cp-e2e-migration-p9f-4ylo | two verbatim declarations: symlink swaps during board publication |
| tests/e2e/parent-delivery-p9f.test.ts | cp-e2e-migration-p9f-4ylo | P9f-delivery-* through a real CpBridge and parent pi |
| tests/parent-delivery-retained.test.ts | cp-e2e-migration-p9f-4ylo | ten verbatim declarations: interleaves with no entry point |
<!-- /manifest:incoming -->
