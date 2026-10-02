# Real-TUI verification — false-working loader and `/cp-plan` overlay

AGENTS.md (cur-20260901-5) says a TUI change is not verified by a green suite:
it has to be reproduced on a real pi TUI. This is the record of that run for
hiding pi's working loader during an extension prompt and opening the plan pager
as a full-screen overlay, taken on **pi 0.85.1** against the **real**
`openPlanViewer`, `HumanPrompt`, `applyPromptWorking`, `autoOpenDecision` and
`askCheckpointUnderLatch` from this worktree.

The loader defect (working indicator still visible while the operator is blocked
on a prompt) and the editor-replacement pager are gone. Nested pager-on-decide
restores the questionnaire; a free latch plus an overlay pager does not recreate
p18.

## How it was driven

The worker that made this change has no controlling terminal. `expect(1)`
allocates its own pty with `openpty()`, which pi accepts as a terminal: the
capture contains `CSI ? u` / `CSI > 7 u`, so pi **negotiated the Kitty keyboard
protocol** and the key-encoding path is the real one, as in
`pi-command-post-p18.md`.

```bash
# /tmp/cp-stuck-working-verify/ — outside the repository; nothing here was touched
#   ext.ts         throwaway extension that imports the real surfaces from this
#                  worktree and wires them as extensions/command-post/index.ts
#                  does: ui_prompt_start/end → applyPromptWorking, busy checks
#                  OR humanPrompt.open, /plan → openPlanViewer (the same
#                  ctx.ui.custom /cp-plan uses).
#   drive.exp      spawn pi --no-session --no-extensions --no-skills -e ext.ts;
#                  stty the pty slave to 120×40; drain in 1s expect rounds;
#                  SIGKILL rather than Ctrl+C when the frame under test is the
#                  overlay itself.
#   render.mjs     replays the CSI stream onto a grid and prints the frame.
#   provider.mjs   MockProvider hang script for the streaming-loader phases.

expect -f drive.exp <capture> 120 40 <phase>
node render.mjs <capture> 120 40
```

Streaming phases (`loader`, `loader-after`) additionally set
`PI_CODING_AGENT_DIR` to a hermetic agent dir whose mock model hangs for 20s,
so `session.isStreaming` is true for the whole overlay span.

## Overlay — `/plan` is a full-screen overlay, not an editor swap

**Phase `overlay`, 120×40.** `/plan` opens `openPlanViewer`. Logged:

```
custom options={"overlay":true,"overlayOptions":{"width":"100%","maxHeight":"100%","margin":0},"hasOnHandle":true}
ui_prompt_start kind=custom open=false
ui_prompt_start applied open=true
```

The frame is the pager. The editor input (inverse cursor between the two
horizontal rules) is gone; the pager footer owns the bottom of the component:

```
cp-x — plan · 142 B · line 1-12/12 (all)
# Implementation plan

STUCK-WORKING-PLAN-BODY

## Goal

Hide the false-working loader while a prompt is up.

## Unknowns and Blockers

None.
…
↓/↑ j/k scroll · PgDn/PgUp Spc/b page · d/u half · g/G Home/End top/bottom · / search · n/N match · q/Esc close
```

## Esc / idle — loader flag clears; a later overlay still opens

**Phase `esc`.** Escape closes the pager:

```
ui_prompt_end kind=custom open=true
ui_prompt_end applied open=false
plan: closed {"shown":true,"reason":"closed",…}
```

The frame is the editor again (startup chrome, empty input between the rules).

**Phase `idle`.** `/plan idle` uses `idleTimeoutMs: 4000`. The same
`ui_prompt_end` / `open=false` / `plan: closed` sequence, without a key.

**Phase `esc-then-decide`.** After Esc, `/decide` opens. Logged
`ui_prompt_end … open=false` then a fresh `ui_prompt_start kind=custom
open=false` → `applied open=true`. The frame is the questionnaire. `humanPrompt`
is not stuck.

## Nested — `q` pops the pager; the questionnaire answers

**Phase `nested`.** `/decide` then `1` (View the plan…). Nested `custom` does
**not** fire a second `ui_prompt_start` (pi coalesces). The frame is the pager
on top of the questionnaire.

**Phase `nested-hold`.** Same, then `q`. `hideOverlay` pops one frame. The
questionnaire is back, focused, with the caret still on "View the plan…":

```
  Approve
 cp-x: ship, drop or follow-up?
 [aw-research-cp-x]

❯ 1. View the plan…
  2. ship
  3. drop
```

**Phase `nested-q`.** Same, then `q`, then Enter. Logged:

```
decide: pager closed {"shown":true,"reason":"closed",…}
decide: answered ship
ui_prompt_end kind=custom open=true
ui_prompt_end applied open=false
decide: latch released
```

The key after `q` answers **that** item, not a hidden overlay. One
`ui_prompt_end` for the outer span.

## p18-pager — a free latch plus an overlay pager does not stack an answering overlay

**Phase `p18-pager`.** Pager held open; 2s later the settle decision and the
checkpoint ask run. Logged:

```
settle: latchBusy=false humanPrompt.open=true decision={"open":false,"reason":"busy"}
checkpoint refused: authorization: a prompt is already on screen — dismiss it first; nothing was asked and nothing was written.
checkpoint verdict: undefined
checkpoint on disk: {… "decision":"pending"}
```

The frame is the pager **alone**. Auto-open stayed silent (`reason: "busy"`).
The checkpoint ask notified `promptBusyNotice` and wrote nothing —
`CheckpointStore.decide` was not called; the record is still `pending`.

## Select — `kind: "select"` hides the loader too

**Phase `select`.** `/which` → `ctx.ui.select("Which plan?", …)`:

```
ui_prompt_start kind=select open=false
ui_prompt_start applied open=true
```

```
 Which plan?

 → cp-x
   cp-y

 ↑↓ navigate  enter select  escape/ctrl+c cancel
```

## Loader — hidden while the prompt is up; restored iff still streaming

**Phase `loader`.** A mock model hangs for 20s. `hello` starts a turn
(`turn_start` shows Working). 2.5s later the pager opens on that stream.
`ui_prompt_start kind=custom` → `applyPromptWorking` → `setWorkingVisible(false)`.
The **final** frame is the pager; the Working row is not on it:

```
 hello
cp-x — plan · 142 B · line 1-12/12 (all)
# Implementation plan
STUCK-WORKING-PLAN-BODY
…
↓/↑ j/k scroll · … · q/Esc close
```

**Phase `loader-after`.** Same, then `q` while the hang is still in flight.
`ui_prompt_end` → `setWorkingVisible(true)` re-shows because
`session.isStreaming`. The final frame:

```
 hello


── ⠏ Working ───────────────────────────────────────────────────────────────────────────────────────────────────────────
```

## The checklist, and what each line rests on

| checked | how | result |
|---|---|---|
| `/plan` is an overlay with attach-console's options | phase `overlay` log: `overlay:true`, `width/maxHeight 100%`, `margin:0`, `hasOnHandle:true`; frame is the pager, not the editor | pass |
| `q` / Esc restore the editor | phase `esc`: `open=false`, editor chrome back | pass |
| idle timeout restores and does not stick `humanPrompt` | phase `idle` + `esc-then-decide`: a later overlay opens | pass |
| nested pager-on-decide: `q` pops one frame | phase `nested-hold`: questionnaire focused after `q` | pass |
| the next key answers the questionnaire | phase `nested-q`: `decide: answered ship` | pass |
| nested custom does not double-toggle | phases `nested*`: one `ui_prompt_start`/`end` pair for the outer span | pass |
| pager is not a latch holder; `humanPrompt.open` fills p18's hole | phase `p18-pager`: `latchBusy=false`, `humanPrompt.open=true`, `{open:false,reason:"busy"}`, checkpoint still `pending` | pass |
| `kind: "select"` is the same span | phase `select`: `ui_prompt_start kind=select` | pass |
| loader gone while the prompt is up | phase `loader`: streaming turn, pager frame has no Working row | pass |
| loader returns iff still streaming | phase `loader-after`: `q` then `── ⠏ Working ──` on the hanging mock | pass |
| Kitty keys | every capture has `CSI ? u` / `CSI > 7 u`; `q` / `1` / Enter went through it | pass |

## Not covered by this run

- A real terminal emulator's own Kitty negotiation (this was pi's, over an
  `expect` pty); mouse; a resize while an overlay is open.
- The production `/cp-plan` slash command end to end (this run calls the same
  `openPlanViewer` the command uses; the command is a thin wrapper pinned by
  `tests/plan-viewer.test.ts` Guard B). Non-TUI `/cp-plan` is
  `tests/e2e/plan-view.test.ts`.
- T31 `asker.ask` remaining stacker — documented and out of scope.
- Colour/theme rendering: the replay strips SGR.

## Redoing it

The driver is under `/tmp/cp-stuck-working-verify/` (`ext.ts`, `drive.exp`,
`render.mjs`, `provider.mjs`). They live outside the repository on purpose —
they poke a real pi and are not part of `npm test` — and everything they prove
about the *decision* is pinned by `tests/awaiting-ui.test.ts` (`HumanPrompt`,
`applyPromptWorking`, `promptBusyNotice`, the production `pi.on` handlers and
busy ORs, no `"plan"` surface) and `tests/plan-viewer.test.ts` (overlay options
match attach-console, Guards A–C). To repeat the run, rebuild those files from
the sketch above and drive pi through an `expect` pty as shown.
