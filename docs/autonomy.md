# Autonomy: three tiers, the mandate, the drill list

(pi-command-post-autonomy-programme-cur.7). This is the short version;
`AGENTS.md` is the parent's own operating contract and `docs/contracts.md` is
the full prose. This page exists so the shape of the whole programme reads in
one place instead of being pieced together from ticket history.

## Three tiers, smallest first

1. **You** — the main LLM session. Only tool is `cp_parent` (`start`,
   `send`, `status`, `stop`). Never calls a fleet tool, never touches
   `state/` directly. Drives the CP parent by sending it prose over RPC and
   watching for `cp-bridge` messages (`src/cp-bridge.ts`).
2. **The CP parent** — headless `pi --mode rpc`, every fleet tool
   (`cp_dispatch`, `cp_gate`, `cp_decide`, `cp_integrate`, `cp_teardown`,
   `cp_next`, ...), never loaded into the main session
   (`extensions/command-post`). Classifies work, dispatches workers, gates
   research, relays outcomes, tears jobs down. Never does a worker's job.
3. **Workers** — headless `pi --mode rpc` children the parent spawns per
   job. A worker finishes by calling `report_result`; nothing is polled.

The main session gets a static operator note in its system prompt
(`src/operator-note.ts`) naming the tiers, the mandate template, and the
ask/decide split — so it can drive the parent without a human explaining it
turn by turn.

## The mandate

`cp_mandate issue` grants bounded authority in advance: projects, objective,
expiry, `allowed_actions` (plan, implement, review, repair, merge),
`spend_cap` (usd, tokens), `job_cap`, `dispatch_parallelism`, `ask_on`
(e.g. `plan_approval`, `merge`, `risk:high`). Authorization is delegated only
through the mandate store (`src/mandate.ts`), never by free prose.

`cp_decide` grants authorization only by citing the mandate clause it falls
under, or an operator quote in the conversation. `cp_next` refuses to
dispatch under a paused or revoked mandate but lets in-flight jobs finish.
A spent USD cap pauses the mandate, refuses new dispatch under it, and raises one
`budget_exhausted`/`spend_cap` escalation for the breach. A reached job cap limits fresh starts under the
selected grant; it never pauses that grant or blocks review, repair and merge of already-counted jobs.
Coverage-based counts and spend remain unchanged. A spent token cap (non-cached input + output +
cache_write) pauses it too but asks no one: the parent raises it itself with
`cp_mandate raise_tokens`, journaled with a reason, up to the home's
`token_ceiling` (default 100M); only a token cap already at the ceiling is
`budget_exhausted`. The parent can never raise the USD cap
(`docs/contracts.md`, *Token caps*).

Ask vs. decide (`src/operator-note.ts`, `OPERATOR_ASK_LIST` /
`OPERATOR_DECIDE_LIST`):

- **Ask the human**: mandate creation, product ambiguity, scope expansion,
  risk high/irreversible, loop exhausted, budget (USD cap or token
  ceiling), conflicting acceptance, merge refused, mission end.
- **Decide yourself, never ask**: in-scope plan approval, how-questions,
  review findings, test failures, next job, merge when the repo permits,
  bounded recovery, a token-cap raise within the ceiling.

`plan_approval` is the one escalation kind that flips from ask to decide —
only when the mandate already covers it (`operatorAction()`).

## The drill list

Nine deterministic failure scenarios the mock-provider e2e suite proves.
Each already has a home; `tests/e2e/mission.test.ts` exercises the happy-path
neighbours of these nine together as one mission (a mandate, a planner's
blocked question, a gate revise-then-pass, an auto-approved checkpoint, an
implementer, a review revise-then-pass, CI green, `cp_integrate`'s real merge,
a second job's continuation and a mission-end escalation), but every
behaviour below is also pinned on its own so a regression in any one of them
fails fast and close to the cause.

| # | Drill | Proven in |
|---|---|---|
| 1 | Missed wake-up: parent restarted between envelope and turn | `tests/e2e/headless-lifecycle.test.ts`, `tests/wakeups.test.ts` |
| 2 | Duplicate wake-up is not replayed after confirm | `tests/e2e/silent-stops.test.ts` |
| 3 | Worker death, recovered once | `tests/e2e/silent-stops.test.ts`, `tests/recovery.test.ts` |
| 4 | Parent death: bridge relaunches the same session once; undelivered sends delivered once by id, landed ones never replayed | `tests/cp-bridge.test.ts`, `tests/parent-outbox.test.ts`, `tests/revive.test.ts` |
| 5 | Moved head after review requires re-review | `tests/pipeline.test.ts` ("a moved head is a new subject"), `tests/wakeups.test.ts`, `tests/integrate.test.ts` |
| 6 | Revoked mandate mid-mission: in-flight finishes, no new dispatch | `tests/decide.test.ts` ("stale/revoked mandate refuses"), `tests/mandate.test.ts` ("expiry and revoke stop auto-decision, not human dispatch") |
| 7 | Spend cap hit: pause, refuse new dispatch, escalate once | `tests/mandate.test.ts` ("hitting the spend cap pauses...") |
| 8 | Out-of-scope planner request escalates | `tests/e2e/planner-blocked.test.ts`, `tests/pipeline.test.ts` (escalate/policy) |
| 9 | `ask_on: plan_approval` path: escalation with summary and paths | `tests/e2e/planner-blocked.test.ts`, `src/operator-note.ts` (plan review), `tests/operator-note.test.ts` |

The live suite (`tests/e2e/live.test.ts`, `tests/e2e/live-smoke.test.ts`,
opt-in via `CP_LIVE_TESTS=1`, never a CI gate) repeats a subset of this
against a real model on a scratch repo, token-budgeted; see
`tests/e2e/README.md` for the scenarios and running instructions.
