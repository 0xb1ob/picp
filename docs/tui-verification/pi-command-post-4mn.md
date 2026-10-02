# Real-TUI verification — the decision details pane (pi-command-post-4mn)

AGENTS.md (cur-20260901-5) says a TUI change is not verified by a green suite:
it has to be reproduced on a real pi TUI. This is the record of that run for the
`/cp-decide` details pane, taken on **pi 0.85.0**, against the **real**
`extensions/command-post/index.ts` and the real
`@juicesharp/rpiv-ask-user-question` overlay pi resolves from
`~/.pi/agent/npm/node_modules`.

It found one defect, which is fixed on this branch and re-verified below.

## How it was driven

The worker that made this change has no controlling terminal (`script(1)`
refuses: *tcgetattr/ioctl: Operation not supported on socket*). `expect(1)`
allocates its own pty with `openpty()`, which pi accepts as a terminal: it
enters the alternate screen, enables mouse reporting, and **negotiates the Kitty
keyboard protocol** — the capture contains `CSI ? u` (query) and `CSI > 7 u`
(push flags: disambiguate + report event types + report alternate keys). So
Kitty-encoded keys are genuinely in play here, not simulated.

```bash
# a throwaway home with one pending checkpoint and its evidence
CP_HOME=/tmp/cp-pane-home            # state/checkpoints/cp-pane.json      (pending)
                                     # state/runs/cp-pane/review-2.json    (revise, 3 reasons + 1 revision, head 8c7d014)
                                     # state/runs/cp-pane/gate-1.json      (escalate/flagged, 2 reasons + 1 revision)
                                     # state/ci-watch.json                 (head 8c7d014, last_ci green)

expect -f drive.exp "$CP_HOME" "$PWD/extensions/command-post/index.ts" capture.txt <cols> <rows> <phase>
#   spawn pi --no-session -e <extension>;  stty rows/cols on the pty slave
#   drain 12s -> send "/cp-decide\r" -> drain 12s -> phase keys -> close
node render.mjs capture.txt <cols> <rows>   # replays the CSI stream onto a grid
```

Two notes worth keeping:

- **The CI watcher rewrites `state/ci-watch.json` at session start** for a home
  with no fleet records, so the fixture head has to be written *after* pi is up
  or the pane correctly reports "untied". That is not a bug — the first run
  produced `recommendation … no evidence here is tied to a current head`, which
  is the untied rule (PR #151 finding 1) doing its job on a real screen.
- `expect` only reads the pty while an `expect` command is running. A script
  that `sleep`s captures nothing; every phase below drains in one-second
  `expect` rounds.

## What the pane looks like — 100×40, evidence tied to the head

```
  Authorize

 authorize cp-pane?
 why: act on this plan?
 blocks: cp-pane implementation
 evidence for cp-pane @8c7d014 — from review-2, gate-1, checkpoint:ship, ci-watch; 7 actionable
 finding(s)
 1/7 finding [review-2 revise]: src/pay.ts:41 charges the card before the idempotency key is
 written, so a retried request double-charges and the ledger has no …
 2/7 finding [review-2 revise]: tests/pay.test.ts covers only the happy path: no test asserts what
 happens when the gateway times out mid-charge
 3/7 finding [review-2 revise]: the fixture hardcodes ••• and the retry loop around it has no bound
 4/7 required change [review-2]: write the idempotency key first, then charge, and add the timeout
 test
 5/7 finding [gate-1 escalate]: the plan rotates production credentials with no rollback step
 6/7 finding [gate-1 escalate]: no test covers the failure path
 7/7 required change [gate-1]: name the rollback
 recommendation (not a decision, nothing preselected): read the 7 finding(s) above before
 answering; a fix moves the head and needs a fresh review.
 review-2: revise on 8c7d014 (anthropic/claude-sonnet-5), decided 2026-09-06T09:00:00Z
 gate-1: escalate/flagged, decided 2026-09-06T08:00:00Z
 gate-1 flags: destructive_scope, blocking_unknowns
 checkpoint:ship: act on this plan?
 CI: green on 8c7d014 (checked 2026-09-06T09:30:00Z)
 [aw-checkpoint-cp-pane]

❯ 1. approve
  2. decline
  3. Type something.

 Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel · Ctrl+] to collapse
```

Observed, on screen: every finding numbered out of its true total; the
credential shape redacted to `•••` **in the terminal**, not just in a unit test;
the recommendation labelled and rendered as text; the answer rows unchanged with
the cursor on the first one; the package's own legend intact.

## The defect this run found — and the fix

**40×24, before:** the pane wrapped to more rows than the screen had, so the
answer rows were pushed off the bottom, and the overlay did **not** scroll to
follow the selection. Arrow keys still moved the highlight (the footer's
affordances changed as the selection passed rows), but the operator could not
see what they were about to answer. `Ctrl+]` still collapsed the whole question
(`ask_user_question hidden — press Ctrl+] to reopen`), which is the package's own
escape hatch, but a decision surface must not depend on it.

```
 evidence for cp-pane @8c7d014 — from
 review-2, gate-1, checkpoint:ship,
 ci-watch; 7 actionable finding(s)
 1/7 finding [review-2 revise]:
 src/pay.ts:41 charges the card before
 the idempotency key is written, so a
 retried request double-charges and the
 ledger has no …
 2/7 finding [review-2 revise]:
 tests/pay.test.ts covers only the
 happy path: no test asserts what
 happens when the gateway times out
 mid-charge
↓                                          <- the answer rows are below the fold
```

**The fix**: the pane is budgeted in **wrapped screen rows** whenever the
terminal size is known, not only in lines. `decisionPaneBudget`
(`extensions/command-post/index.ts`) reads `process.stdout.{columns,rows}` in the
pi process and leaves `DECISION_PANE_RESERVED_ROWS` for the question, the answer
rows and the legend; `buildDecisionContext` counts `ceil(len / columns)` per line
and cuts with the explicit `+N more line(s) — /watch <job-id>` marker. A
terminal that reports no size keeps the old line-only budget.

**40×24, after (same fixture, same keys):**

```
  Authorize

 authorize cp-pane?
 why: act on this plan?
 blocks: cp-pane implementation
 evidence for cp-pane @8c7d014 — from
 review-2, gate-1, checkpoint:ship,
 ci-watch; 7 actionable finding(s)
 1/7 finding [review-2 revise]:
 src/pay.ts:41 charges the card before
 the idempotency key is written, so a
 retried request double-charges and the
 ledger has no …
 +12 more line(s) — /watch cp-pane
 [aw-checkpoint-cp-pane]

❯ 1. approve
  2. decline
↓

 Enter to select · ↑/↓ to navigate · n …
```

## The checklist, and what each line rests on

| checked | how | result |
|---|---|---|
| the pane renders in the overlay, before submission | 100×40 run, frame above | pass |
| focus / default row | cursor `❯` on row 1 with the pane present; option order unchanged | pass |
| wrapping and long findings | 100×40 and 40×24 frames; findings wrap at word boundaries, each line already clipped at 160 chars with `…` | pass |
| narrow terminal (40 cols) | 40×24 frames above | pass **after** the row-budget fix |
| scrolling | overlay renders its own `↓` indicator; it does **not** scroll to the selection, which is why the pane yields instead | fixed by bounding, not by scrolling |
| Kitty keys via `matchesKey` | pi negotiated the protocol (`CSI ? u`, `CSI > 7 u`); sending Enter as **`CSI 13 u`** selected the highlighted row and wrote `decision: approved`, `decided_by: "operator dialog (tui)"` through `CheckpointStore.decide` | pass |
| Enter does not re-trigger a default | a second `\r` after the answer did nothing: one decision on disk, no second write, no re-opened overlay | pass |
| skip = no answer | Esc on the overlay: checkpoint still `pending`, and **no `state/awaiting.json` was created at all** | pass |
| free text | `3. Type something.` is offered with the pane present; nothing was written on the run that did not submit a verdict | partial — the row renders; free-text-as-note stays covered by `tests/awaiting-ui.test.ts` |
| authorization single writer | the only write any run produced was the checkpoint file above, by `CheckpointStore.decide` | pass |

## Not covered by this run

- A real terminal emulator's own Kitty negotiation (this was pi's, over an
  `expect` pty). The key *encoding* path is exercised; the emulator's is not.
- Mouse selection, and a resize **while** the overlay is open.
- The `agent_settled` auto-open surface: same loop, same factory, but it was not
  triggered here (it needs a settled agent turn, which needs a model call).
- Colour/theme rendering: the replay strips SGR.

## Redoing it

The driver scripts are three small files (`drive.exp`, `render.mjs`, the
fixture). They live outside the repository on purpose — they poke a real pi with
a scratch `CP_HOME` and are not part of `npm test` — and everything they prove
about the *projection* is pinned by `tests/decision-context.test.ts` and
`tests/decide-pane-wiring.test.ts`, which do run in CI. To repeat the run,
recreate the fixture above and drive pi through an `expect` pty as shown.
