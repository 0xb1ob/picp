# Real-TUI verification — one surface at a time (pi-command-post-p18)

AGENTS.md (cur-20260901-5) says a TUI change is not verified by a green suite:
it has to be reproduced on a real pi TUI. This is the record of that run for the
overlay latch, taken on **pi 0.85.1** with
`@juicesharp/rpiv-ask-user-question` resolved from `~/.pi/agent/npm/node_modules`,
against the **real** `askQuestionnaire`, `askCheckpointDecision`,
`askCheckpointUnderLatch` and `SingleRunLatch` from this worktree.

Both halves were driven here: **before** (the two owners unsynchronised, as
`0ff78cb` wired them) and **after** (this branch). The defect reproduced, and it
is gone.

## How it was driven

The worker that made this change has no controlling terminal. `expect(1)`
allocates its own pty with `openpty()`, which pi accepts as a terminal: the
capture contains `CSI ? u` / `CSI > 7 u`, so pi **negotiated the Kitty keyboard
protocol** and the key-encoding path is the real one, as in
`pi-command-post-4mn.md`.

```bash
# /tmp/cp-p18-verify/ — outside the repository; nothing here was touched
#   ext.ts      a throwaway extension that imports the real surfaces from this
#               worktree and wires them exactly as extensions/command-post/index.ts
#               does: runAwaitingDialog takes `awaitingLatch.run(surface, …)`, the
#               checkpoint ask goes through `askCheckpointUnderLatch(awaitingLatch, …)`,
#               and the settle hook computes `autoOpenDecision({… latchBusy …})`.
#               CP_P18_LEGACY=1 wires the checkpoint ask *without* the latch — the
#               pre-fix shape, which is how "before" below was produced.
#   drive.exp   spawn pi --no-session -e ext.ts; stty the pty slave to <cols>x<rows>;
#               drain in 1s `expect` rounds (a `sleep` captures nothing); send the
#               phase's keys; SIGKILL rather than Ctrl+C where the frame under test
#               is the overlay itself (a teardown repaint would wipe it).
#   render.mjs  replays the CSI stream onto a grid and prints the frame.

expect -f drive.exp <capture> 120 40 <a|b|hold>
node render.mjs <capture> 120 40
```

Three phases, both wirings:

| phase | what happens |
|---|---|
| `hold` | the Awaiting-you overlay opens; 3s later the checkpoint is minted and asked about; **no keys are sent** — the final frame is what the operator sees |
| `a` | same, then `↓` `Enter` are sent at the question the operator can see |
| `b` | the checkpoint ask opens first; 3s later the `agent_settled` decision runs and the auto-open is attempted |

A real checkpoint file is written by the real `CheckpointStore` under a scratch
home, so "still pending" is read off disk and not claimed.

## Before — the defect, reproduced

**Phase `a`, `CP_P18_LEGACY=1`, 120×40.** The Awaiting-you overlay is on screen
showing `cp-4ay3: ship, drop or follow-up?`. The checkpoint ask opens over it.
`↓` `Enter` are sent at the visible question:

```
awaiting(decide): opening
checkpoint(cp-rk48) requested: {… "decision":"pending"}
checkpoint(cp-rk48) verdict: {"approved":false,"by":"operator dialog (tui)"}
checkpoint(cp-rk48) on disk: {… "decision":"declined","decided_by":"operator dialog (tui)"}
awaiting(decide): {"ran":true,"value":{"kind":"cancelled"}}
```

```json
// state/checkpoints/cp-rk48.json
{ "job_id": "cp-rk48", "research_id": "cp-4ay3",
  "decision": "declined", "decided_by": "operator dialog (tui)" }
```

The keystrokes aimed at the research question **declined an authorization**. The
research overlay received nothing and only resolved `cancelled` at teardown.
That is the observed defect, and it is worse than a dead dialog: the write went
through `CheckpointStore.decide`, which refuses to be overwritten, so the
operator cannot take it back.

**Phase `b`, `CP_P18_LEGACY=1`.** The reverse order, and the settle hook's own
decision is the thing measured:

```
checkpoint(cp-rk48) requested: {… "decision":"pending"}
settle: latchBusy=false holder=undefined decision={"open":true,"reason":"open"}
awaiting(auto_open): opening
```

`autoOpenDecision` returned `{open:true}` while a checkpoint overlay was up,
because nothing held the latch — so a second overlay opened over it, and the
frame shows the *newest* one only:

```
────────────────────────────────────────────────
  Approve
 cp-4ay3: ship, drop or follow-up?
 why: finished research with no ship decision yet
 blocks: cp-rk48
 [aw-research-cp-4ay3]

❯ 1. ship
     dispatch the implementation
  2. drop
…
```

The checkpoint's question is underneath it and deaf. (At 120×40 the newer
overlay covers the older one completely; the research artifact's frames, taken
at other sizes, show the two interleaved line by line. Same composite, same
defect — pi sorts every visible overlay into one stack and focuses the newest.)

## After — one overlay, and the keys answer the question on screen

**Phase `hold`, 120×40.** The Awaiting-you overlay is up; the checkpoint ask
arrives 3s later and is refused by the latch. This is the whole frame:

```
 authorization: /cp-decide is already on screen — answer or dismiss it first; nothing was asked and nothing was
 written.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  Approve

 cp-4ay3: ship, drop or follow-up?
 why: finished research with no ship decision yet
 blocks: cp-rk48
 [aw-research-cp-4ay3]

❯ 1. ship
     dispatch the implementation
  2. drop
     close it; nothing is implemented
  3. follow-up
     open a follow-up job
  4. Type something.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

 Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel · Ctrl+] to collapse
```

**One** overlay. The `surfaceBusyNotice` wording is on screen, above it, naming
the surface that is open. And on disk:

```
checkpoint(cp-rk48) verdict: undefined
checkpoint(cp-rk48) on disk: {… "decision":"pending"}
```

**Phase `a`, 120×40.** Same setup, then `↓` `Enter`:

```
awaiting(decide): opening
checkpoint(cp-rk48) requested: {… "decision":"pending"}
checkpoint(cp-rk48) verdict: undefined
checkpoint(cp-rk48) on disk: {… "decision":"pending"}
awaiting(decide): {"ran":true,"value":{"kind":"answers","answers":[{"kind":"option","label":"drop"}]}}
```

The same two keystrokes that declined an authorization before now answer the
question the operator is looking at — `drop` — and the checkpoint is untouched,
still `pending`.

**Phase `b`, 120×40.** The checkpoint ask is up when the settle decision runs:

```
checkpoint(cp-rk48) requested: {… "decision":"pending"}
settle: latchBusy=true holder=checkpoint decision={"open":false,"reason":"busy"}
awaiting(auto_open): refused, holder=checkpoint
```

The frame is the checkpoint's overlay, alone and undisturbed:

```
  Authorize

 cp-rk48: authorize implementation?
 [cp-rk48]

❯ 1. approve
     authorize it now
  2. decline
     refuse it; the job stops here
  3. not now
     leave the checkpoint pending; it stays in Awaiting you
  4. Type something.
```

`autoOpenDecision(… latchBusy: true …) → {open:false, reason:"busy"}` was
already the rule; it now actually covers a checkpoint ask, because the latch has
a holder to report.

## The checklist, and what each line rests on

| checked | how | result |
|---|---|---|
| two overlays could stack, and the newest owned input | phase `a` legacy: `↓`+`Enter` wrote `decision: declined` to the checkpoint while the research question was visible | reproduced |
| the auto-open gate did not cover the checkpoint ask | phase `b` legacy: `latchBusy=false` with a checkpoint overlay on screen, `{open:true}` | reproduced |
| after the fix: one overlay at a time | phase `hold` and phase `b` frames above | pass |
| the notice is on screen, naming the holder | phase `hold` frame, `surfaceBusyNotice("decide","checkpoint")` verbatim | pass |
| the refused ask writes nothing | checkpoint file read back from the scratch home: `"decision": "pending"` in every non-legacy run | pass |
| keys answer the *visible* question | phase `a`: `{"kind":"option","label":"drop"}` on the research question | pass |
| the settle auto-open is refused while a checkpoint ask is in flight | phase `b`: `{open:false, reason:"busy"}`, `holder=checkpoint` | pass |
| nothing is closed under the operator | the first overlay is never touched: it is still up, still focused, and still answers | pass |
| Kitty keys | pi negotiated the protocol on this pty (`CSI ? u`, `CSI > 7 u`); the arrow/Enter that answered `drop` went through it | pass |
| the latch releases | every run ended with the first surface resolving normally (`answers` / `cancelled`) and no run left a second ask stuck | pass |

## Not covered by this run

- A real terminal emulator's own Kitty negotiation (this was pi's, over an
  `expect` pty); mouse; a resize while an overlay is open.
- **A typed `/cp-decide` arriving second cannot be driven on a real TUI**: an
  open overlay owns the keyboard, so `/cp-decide\r` is typed *into* the overlay
  (measured — an early phase-`b` run submitted the checkpoint's default row that
  way) and never reaches the editor. The surface that genuinely arrives second
  in production is the `agent_settled` auto-open, which is what phase `b` drives.
  The manual-refusal wording itself is exercised by
  `tests/awaiting-ui.test.ts` and pinned in `index.ts` by the source-shape
  assertion there.
- The production trigger end to end (a live gate verdict minting the checkpoint
  through `cp_pipeline advance`). The research artifact's R3 measured the part
  that matters — a `deliverAs: "followUp", triggerTurn: true` wake-up runs a
  whole model turn with an overlay on screen — and this run stands in for the
  turn with a 3s timer.
- Colour/theme rendering: the replay strips SGR.

## Redoing it

The driver is three small files under `/tmp/cp-p18-verify/` (`ext.ts`,
`drive.exp`, `render.mjs`). They live outside the repository on purpose — they
poke a real pi and are not part of `npm test` — and everything they prove about
the *decision* is pinned by `tests/awaiting-ui.test.ts` (the holder, the
refusal, `askCheckpointUnderLatch`, and both production call sites) and
`tests/awaiting-one-decision.test.ts` (why a refused ask loses nothing), which
do run in CI. To repeat the run, rebuild the three files from the sketch above
and drive pi through an `expect` pty as shown.
