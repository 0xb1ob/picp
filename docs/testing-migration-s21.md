# S21: wakeup-journal migration, blocked on recovery notice size

Owner: cp-e2e-slice-s21-5gtl. Source: `tests/wakeup-journal.test.ts` (22 declarations, unchanged).
No retirement credit: 0 mapped, 0 retained/moved, 0 deleted files, 22 pending.
One replacement scenario has been added; it is partial evidence, not a complete declaration mapping.

## Production blocker

The long recovery-set behavior (source declaration 4) reaches real startup reconciliation but loses its
notice for a sufficiently large set. On base 547f8bd941519fe0b068ed735c9bc28c34fb2dd3, seeding 40 valid
waiting model-worker records with dead PID 2147483647, missing sessions, and IDs of the form
`cp-recovery-00-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, then calling `CommandPost.reconcile()`, gives
40 failed candidates and zero pending recovery notices. A one-record control journals one notice.

`src/command-post.ts` formats all candidates in `#journalRecovery`; `src/wakeups.ts:927` does not bound
that notice. The durable schema limits content to 4,000 characters. `#journalDurable` catches the
validation rejection and returns silently. No product mutation was needed to expose this defect.
The programme plan excludes product fixes; a bounded/split recovery-notice fix needs its own job.
Until it lands, declaration 4 cannot honestly be retired as consumer-covered for long recovery sets.

## New consumer evidence

`tests/e2e/wake-delivery.test.ts`: **S21: restart delivers an unobserved death once and discards obsolete fleet notices**.
Real command-post extension in two real pi RPC children, mock provider, isolated scratch home,
legacy on-disk fleet/outbox state. It observes a previous parent's unacknowledged death reaching the
provider, durable arrival confirmation, terminal disposal of gone-job/all-finished recovery notices,
and no replay in a fresh parent's explicit inspection request. No production hooks were added.
The positive run takes approximately three seconds locally. The case has a 110-second bound.

Agent isolation uses `createAgentDir`: a mode-0700 `cp-agent-*` directory outside the worktree containing
mock models/settings, removed after both child handles close in the test's cleanup hook. No credentials.

## Executed production mutation controls

Each patch is complete and applies independently to the base with `git apply`. All were restored after execution.
Command: `npm run test:one -- tests/e2e/wake-delivery.test.ts`.
Run logs remain under `node_modules/.s21-runs/` in this worktree.

| Patch | SHA-256 | Observed failure |
|---|---|---|
| `s21-controls/owner.patch` | baf73e91ef201c005ca50bf9c54c9965cc6c60d7f6cca59709a479f4ed290e0e | no request arrives: replayed death reaching the model times out (0 requests) |
| `s21-controls/missing-job.patch` | 8835db102665d7cc832feff995339983d37e42377e3e11316644becdaa517d72 | pending queue is not empty: death:cp-gone:1 survives |
| `s21-controls/finished-recovery.patch` | 50b06b867852afbfe8e97cc49bf775453446e2ff97bb3ff1972db7cf62b2ef43 | pending queue is not empty: recovery:finished survives |

## Declaration inventory

All rows stay pending; no full equivalence is claimed from partial scenario coverage.

| # | Original declaration behavior | Status / evidence still required |
|---|---|---|
| 1 | announced transitions and docs table | pending structural retention accounting |
| 2 | failure-class durable-kind table | pending structural retention accounting |
| 3 | markFailed callers | pending structural retention accounting |
| 4 | distinct long recovery IDs | blocked by production notice-size loss above |
| 5 | N7 long CI-watch causes retain tail | pending public watch failure controls |
| 6 | AGENTS death/recovery guidance | pending structural retention accounting |
| 7 | spent-bound guidance | pending structural retention accounting |
| 8 | no preview-derived recovery claim | pending structural retention accounting |
| 9 | bound/death versus replacement | pending live replacement and controls |
| 10 | outbox handoff/restart/ack | partial new scenario; enqueue-duplicate evidence still required |
| 11 | torn-down death stale | partial new scenario; context rewrite evidence still required |
| 12 | all versus some recovery candidates gone | partial new scenario; mixed live-candidate evidence still required |
| 13 | notice disk evidence and next tools | pending emitted notice assertions and controls |
| 14 | reconcile journal/restart/confirm | pending real reconcile scenario and controls |
| 15 | reviewer partial-finish failure | pending public reviewer filesystem failure scenario |
| 16 | wakeup file layout | pending structural retention accounting |
| 17 | invalid intake emits once | pending public rejected envelope scenario |
| 18 | every failure class survives parent death | pending emitter scenarios and per-behavior controls |
| 19 | shutdown owns close/bound events | pending real shutdown scenario and controls |
| 20 | every nonrecoverable emitter | pending public emitter scenarios and controls |
| 21 | hard-bound occurrence/outcome wording | pending extension of real bounds consumer evidence |
| 22 | stale discard versus transport retry | partial stale-discard evidence; transport retry still required |

## Timer inventory

The durable same-owner unacknowledged-send retry is fixed at 120 seconds:
`src/contracts/wakeups.ts:86`, alias at `src/contracts/wakeups.ts:196`, consumed at
`src/wakeup-outbox.ts:80`. No public runtime override is wired by CommandPost. The new scenario needs
no wait for it: the real successor-owner path immediately makes an old reservation due.
The inactivity classifier defaults to 900,000 ms at `src/failures.ts:45`; legacy timestamped run logs
may avoid waiting when covering classification. No new case waits for either fixed timer.
