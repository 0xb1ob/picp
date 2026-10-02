# Build history

A **snapshot**, written when `.beads/` stopped being tracked (`cp-rnr`). The rebuild plan that used to live in `PLAN.md` is this table; `PLAN.md` is now a pointer.

br is the in-flight ledger of a *running* command post, so it is machine-local:
`.beads/` is in `.gitignore` like `data/`, `state/` and `projects/`, and the T19
guard refuses to stage any of them. During this build the ledger was tracked on
purpose — it *was* the plan's task list — which contradicted that guard and would
have shipped an installed home whose ledger is committable but unstageable.

So the ledger left the repository and its history stayed, rendered here. A fresh
install starts with an empty ledger (`br init --prefix cp`, run by the
`session_start` scaffold), and this file is what the build itself did:
**39 closed issues**, in the order they closed.

Each row's *reason* is the `br close --reason` text — the same sentence that
justified closing the job at the time, not a later summary.

| # | phase | id | what | reason it closed |
|---|---|---|---|---|
| 1 | 0 | `cp-t01-scaffold-ij0` | Scaffold pi package skeleton | pi package skeleton: package.json pi manifest (parent ext only), strict tsconfig, dirs, /cp-version probe in extensions/command-post/index.ts, tests/{scaffold,extension-load}.test.ts + tests/helpers/rpc.ts (7 tests green) |
| 2 | 0 | `cp-t02-contracts-vuh` | Contracts doc + typebox schemas | Binding contracts: src/contracts.ts (typebox: envelope+validateEnvelope, fleet, run events/status, profiles, gate, routing, budgets, failure taxonomy, path guards) + docs/contracts.md; tests/contracts.test.ts 24 tests; PLAN.md amended |
| 3 | 0 | `cp-m0-harness-i2e` | Test harness: mock model provider + fixtures | Mock openai-completions provider (scripts, error/hang injection), hermetic agent dir, pi-child spawn helper, scratch-repo + remote fixtures, file-only state readers; tests/harness.test.ts green (6 tests, real pi child) |
| 4 | 1 | `cp-t03-rpc-client-7yk` | WorkerProcess RPC client | src/worker-process.ts (LF framing, id-correlated RPC, events/busy, receipts, dialog auto-cancel, shutdown ladder, observed close) + tests/worker-process.test.ts (6 tests, real pi child) |
| 5 | 1 | `cp-t04-run-artifacts-x9o` | Per-job run artifacts | src/run-artifacts.ts (pure projection reducer + RunRecorder tee, atomic status, log-wins rebuild) + contracts enum narrowing; tests/run-artifacts.test.ts 8 tests |
| 6 | 1 | `cp-t05-worker-reporter-ayo` | Worker reporter extension | extensions/worker-reporter/index.ts: report_result (terminating), env job identity, bounded repair + envelope-rejected.json, worker-side artifact/porcelain checks, write-once envelope, recursion guard; tests/worker-reporter.test.ts 9 tests |
| 7 | 1 | `cp-t06-profiles-2va` | Worker profiles + brief templates | profiles/*.md (3 roles), prompts/briefs/*.md (ported policy, transport deleted), src/profiles.ts (validated loader + pure fail-closed brief assembly); tests/profiles.test.ts 9 tests |
| 8 | 1 | `cp-t07-spawn-safety-9j1` | Spawn trust and safety policy | src/worker-manager.ts (trust argv self-check, tool allowlist, env hygiene, brief secret scan, budget clamp, spawn cap, one-worker-per-job, shutdownAll); tests/worker-manager.test.ts 10 tests incl. hostile clone |
| 9 | 1 | `cp-m1-e2e-worker-afi` | MILESTONE E2E phase 1: worker lifecycle round-trip | m1 gate green: tests/e2e/phase1.test.ts (npm run e2e:phase1) covers profile+brief -> spawn -> teed events -> status phases -> validated envelope -> observed close; live smoke implemented and documented (CP_LIVE_TESTS=1 npm run smoke:live), not executed |
| 10 | 1 | `cp-gate-verdict-tool-xtv` | Gate verdict via report_verdict tool | report_verdict as the gate-reviewer's terminating tool (role-gated in worker-reporter, enforced in worker-manager/profiles/contracts); verdict.json write-once + in-run bounded repair; 4 new tests, suites green |
| 11 | 2 | `cp-t08-fleet-store-xgn` | Fleet state store + reconcile | fleet.json single-writer atomic store (queued RMW, validate, tmp->fsync->rename) + session_start reconcile with outcomes terminal/live/orphan/revivable/reported/failed; observed close outranks pid probe; resumability derived. Acceptance proven: kill -9 worker, reconcile from a fresh process, fleet reflects reality. tests/fleet.test.ts, 18 tests. |
| 12 | 2 | `cp-t09-ledger-b02` | br ledger integration | src/ledger.ts: br wrapper with the ported Backlog contract (labels mandatory+validated, external-ref, real deps, close-with-reason, no force/delete). tests/ledger.test.ts: policy units + full lifecycle against a scratch beads workspace. |
| 13 | 2 | `cp-t10-projects-ltg` | Project registry + clone-on-demand | src/projects.ts: data/projects.json registry + rendered data/projects.md view, clone-on-demand, one-canonical-clone-per-name/remote, ported assertCanonicalClone (nested/linked-worktree/foreign git-common-dir). tests/projects.test.ts, 10 tests. |
| 14 | 2 | `cp-t11-leases-sn7` | Worktree lease module | src/leases.ts: treehouse-only lease/return with verified post-conditions, outside-the-worktree returns, lease-id guard (FleetRecord.lease_id), no silent git worktree add. tests/leases.test.ts, 7 tests incl. a real cycle. |
| 15 | 2 | `cp-t12-preflight-yxf` | cp_check preflight | src/preflight.ts: canonical-clone + git preflight + occupancy with ported promote-not-spawn; coded findings with fixes, fail-closed. tests/preflight.test.ts, 9 tests covering every branch. |
| 16 | 2 | `cp-t13-routing-xwc` | Model routing | src/routing.ts: override>pin>rubric>profile + fallback ladder, glob allowlist gating every source, auth-aware availability probe before lease, source=/model=/rule= output. tests/routing.test.ts, 8 tests incl. the ported rubric table. |
| 17 | 2 | `cp-t14-dispatch-na4` | cp_dispatch tool | src/dispatch.ts + src/command-post.ts + cp_dispatch tool: probe-before-lease, preflight twice, brief, spawn, id-correlated receipt, fleet add, ledger claim last; full cleanup on failure. tests/dispatch.test.ts, 8 tests end-to-end. |
| 18 | 2 | `cp-t15-send-x0j` | cp_send promote/steer/follow_up | src/send.ts + cp_send tool: auto/prompt/steer/follow_up with delivered\|queued\|failed receipts, ported same-model promote rule, no silent revival; every delivery logged. tests/send.test.ts, 3 live-worker tests. |
| 19 | 2 | `cp-t16-envelope-intake-v44` | Envelope intake + held state | src/intake.ts: event-driven envelope intake, idempotent reported_at, held + next(hold\|teardown), stat-and-move artifact registration, receipts, parent custom message. tests/intake.test.ts, 8 tests incl. a live worker. |
| 20 | 2 | `cp-t17-teardown-kuq` | cp_teardown | src/teardown.ts + cp_teardown tool: kind-aware fail-closed gates incl. the squash-merge deleted-head case, observed worker close before lease return, fleet done, artifact cleanup opt-in. tests/teardown.test.ts, 8 tests. |
| 21 | 2 | `cp-t18-failures-budgets-cks` | Failure taxonomy + budgets | src/failures.ts: classifyRun (evidence-based, never guesses), checkBudget soft gate wired into cp_send (escalate, never kill), decideRecovery bounded ladder + mayRerunResearch, FailureMonitor on observed closes. tests/failures.test.ts, 17 tests. |
| 22 | 2 | `cp-m2-e2e-dispatch-1by` | MILESTONE E2E phase 2: dispatch to teardown on scratch project | npm run e2e:phase2 green: intake->dispatch->envelope->promote->teardown, fail-closed dirty teardown, crash + bounded re-dispatch, budget escalation. Caught and fixed the re-dispatch projection bug and the ~/.treehouse pool leak. Live m2 smoke added (env-gated). |
| 23 | 3 | `cp-t19-artifacts-guards-7le` | Artifact store + context guards | Artifact store (src/artifacts.ts: path\|add\|get, stat/copy only, get writes to a file) + tool_call context guards (src/guards.ts: artifact_body_read/write, ledger_inlines_artifact, never_commit_path, bulk_stage_in_home) wired in the parent extension; cp_artifact tool on the CommandPost root. Amendment: add files a file, no br-comment mirror. Tests: artifacts.test.ts, guards.test.ts incl. a live pi parent block; npm test + phase1/phase2 green. cdeef72 |
| 24 | 3 | `cp-t20-gate-6kc` | Gate module | src/gate.ts: one-shot gate-reviewer on a scratch copy of the artifact, decideGate() policy (flags force escalate, one revise max, operational/operational_persistent), next = proceed\|revise\|retry\|surface, per-attempt run dirs + gate-<n>.json history, revise promoted via cp_send, cp_gate tool. tests/gate.test.ts 13 cases; npm test + phase1/phase2 green. |
| 25 | 3 | `cp-t21-pipeline-w07` | Pipeline orchestration | src/pipeline.ts + src/checkpoint.ts: two dep-linked issues, hung-researcher gate, one-revise re-gate on a newer artifact, journaled human checkpoint (pending before asking, answered once, human channels only), research teardown, artifact handed to the implementer as dispatch({taskFile}) read in code, bounded ship recovery that never re-runs research. cp_pipeline tool + /cp-authorize\|/cp-decline. tests/pipeline.test.ts 7 cases incl. 3 e2e; npm test + phase1/phase2 green. |
| 26 | 3 | `cp-t22-research-quality-ayt` | verify + completenessCheck (opt-in) | src/quality.ts: opt-in pre-gate panel (verify with N lens-voters + threshold, completenessCheck), fail-closed tally (abstentions count, empty panel never sound), voters are gate-reviewer workers reusing report_verdict, one write-once pass per job, pipeline promotes once on a fresh failure. tests/quality.test.ts 11 cases + pipeline opt-in e2e; npm test + phase1/phase2 green. |
| 27 | 3 | `cp-m3-e2e-pipeline-p0q` | MILESTONE E2E phase 3: full pipeline with gate | npm run e2e:phase3 green: research -> artifact -> envelope -> every gate verdict/cause branch (pass, revise+promote, capped revise, flag-forced escalate, operational, operational_persistent on a different model) -> checkpoint (pending/declined/approved) -> implementer dispatched with the artifact task file, plus parent context-safety guards. Fixed: gate ladder now respects the routing allowlist; mock provider supports request-derived tool args. Live m3 smoke added (operator-run). |
| 28 | 4 | `cp-t23-status-vrd` | /status + fleet widget | /status + fleet widget: src/status.ts (pure assembleStatus + StatusReporter + renderers), CommandPost.status()/statusNow(), /status [--json\|--all\|--project\|--no-titles] and the setWidget fleet widget. Golden files pin table/JSON/widget. Amendments: orphaned -> unclaimed[] (evidence, not a fifth phase), broker block -> ledger degraded banner, --origin -> --project, glyph/pane/cli/edges dropped. 271 tests, 268 pass, 3 skipped; e2e phase1/2/3 green. |
| 29 | 4 | `cp-t24-watch-rzv` | cp watch live viewer | cp watch (bin/cp.ts, --follow/--detailed/--last/--export) + bounded /watch in the parent; src/watch.ts renders events.jsonl live and post-hoc. Amendments: follow+real export are CLI-only (parent gets a bounded tail and the printed command), tolerant log parse for the viewer, src/home.ts owns home resolution. Golden renders + live-follow tested; 288 tests, 285 pass, 3 skipped; e2e phase1/2/3 green. |
| 30 | 4 | `cp-t25-doctor-gc7` | /doctor | /doctor + --json: src/doctor.ts checks host tools, ledger (schema version + br doctor's own findings incl. sqlite3.integrity_check + PATH version conflicts), package resources, config, per-role model availability with live auth, scaffold, .gitignore and fleet consistency. Read-only; warn stays green, only error exits 2; every non-ok finding must name a fix (validated). Fixed CommandPost.modelRegistry to be a getter (a captured registry froze the probe for the session). 24 doctor tests incl. a golden broken report and a live pi session; 312 tests, 309 pass, 3 skipped; e2e phase1/2/3 green. |
| 31 | 4 | `cp-t26-memory-wxp` | cp-memory port + data contract | cp-memory skill ported (skills/cp-memory/SKILL.md, loads in pi as skill:cp-memory) + src/memory.ts: idempotent scaffold of learnings/candidates/archive with their contract headers, tiers + dated decay windows, budget, append-only capture that cannot reach learnings, archive-as-move with provenance, and a budget-bounded session-start digest delivered as a nextTurn custom message. /memory status\|capture. 12 memory tests; 324 tests, 321 pass, 3 skipped; e2e phase1/2/3 green. |
| 32 | 4 | `cp-t27-contract-ngl` | New AGENTS.md + README | New AGENTS.md (slim operating contract: session, loop, classify, dispatch, envelopes, pipeline, teardown, backlog, STATUS BLOCK, memory; transport prose deleted, code-enforced policy referenced) + README (why, requirements, quick start, surfaces, layout, out of scope). tests/contract.test.ts makes both acceptance criteria mechanical (named commands/tools must be registered, deleted prose stays deleted, links resolve, STATUS BLOCK rules survive). Amendments: CLI renamed cp -> cmdp (a ~/.local/bin/cp shadows POSIX cp -- ported incident), and cp_check exposed as a tool (T12 gap found by the parity review). 333 tests, 330 pass, 3 skipped; e2e phase1/2/3 green. |
| 33 | 5 | `cp-t28-parity-audit-s8e` | Feature parity audit | docs/parity.md: line-by-line audit of command-post README/AGENTS.md + cmdp subcommands/templates/share/scripts/reports, with capability -> new home -> evidence and a closed verdict vocabulary; zero unaccounted capabilities. Found and fixed a real bug (/status decided unclaimed membership from a capped br list -- now --limit 0, per the ported rule), restored five general operating rules the T27 rewrite dropped (fan-out, parallel PRs one base, freeze scope, delivery owns rigor/never merge red, report discipline + delivery:pr hold) with tests, and filed cp-zkj (always-on parent) + a T30 comment (harness skill copies). Audit citations are themselves tested. 335 tests, 332 pass, 3 skipped; e2e phase1/2/3 green. |
| 34 | 5 | `cp-i2s` | dispatch can dispatch a blocked job: br blocked defaults to --limit 50 | Fixed: Ledger.blocked() is hard-wired to --limit 0 (no caller limit -- there is no correct page size for a membership question) and limitArgs() sends --limit 0 whenever the caller named no page, so no query inherits a br default. br's defaults are not uniform (blocked pages at 50; ready/list do not), which is why it is per-call and explicit. Tests: argv of every query; a stub that pages at 50; and real br with 51 blocked issues pinning br's own default (50) plus --limit 0 (51), asserting all 51 stay blocked and none reach br ready. Documented in docs/contracts.md (Ledger) and docs/parity.md. 338 tests, 335 pass, 3 skipped; e2e phase1/2/3 green. |
| 35 | 5 | `cp-t29-e2e-pfe` | End-to-end scenarios | tests/e2e/live.test.ts + npm run e2e:live: five live scenarios (single ship, pipeline with a real verdict/checkpoint/implementation, delivery:pr hold + promote, real parent kill -9 + reconcile-as-orphan, worker crash + bounded re-dispatch), env-gated on CP_LIVE_TESTS=1 and operator-run only -- implemented and documented, never executed here. Per-job and suite token budgets asserted with a printed spend table. Amendments: scenarios assert machinery not model opinion; (c) supplies the PR url from the test and does not ask for a second report_result (envelope.json is write-once -- contracts updated); (d) kills a real parent process. Suite scaffolding tested for free in tests/live-harness.test.ts. Runbook in tests/e2e/README.md. 350 tests, 341 pass, 9 skipped; e2e:phase1/2/3 green. |
| 36 | 5 | `cp-stt` | teardown demanded a push for delivery:local ship jobs (fail-closed forever) | Settled as option A: the teardown gate is keyed on kind only, and every ship job pushes. delivery:local means 'no PR, no hold' -- never 'do not publish' -- because a returned lease is recycled and the job branch survives only in projects/<name>, a gitignored clone-on-demand cache; work that lives only there is parked, not delivered (measured against real treehouse). Reverted the committed_local relaxation. Kept the new unreachable_work refusal for work on a detached HEAD, which the reused slot genuinely destroys. brief-ship.md now states the per-delivery rule so a brief and a gate cannot disagree; live scenarios no longer contradict their brief; m2 pushes and asserts reason=pushed. Both guards verified by disabling them. 353 tests, 344 pass, 9 skipped; e2e phase1/2/3 green. |
| 37 | 5 | `cp-33s` | First live-suite run: fix six wrong assertions (2 product, 4 suite) | First live run done: 6/6 green, 9 jobs, 271629 tokens, $0.1987 on haiku-4-5. Fixed 2 product bugs (unreachable pipeline done + second-implementer hole; revise message asking for a second report_result) and 4 wrong suite assertions (lease recycling, advance's next vocabulary, retry_same + branch_exists, process.kill(pid,0) returns true). Budgets re-based on measured spend; gate spend charged to the reviewer's run. All six pinned by free tests. 493c8b1 |
| 38 | 6 | `cp-c1l` | Operator questions: a planner may ask the human, off the parent's context | Landed 761963e: ask_operator (researcher-only, granted per spawn), QuestionRelay with policy + append-only journal, transport relay in WorkerProcess with fail-closed fallback, question_journal_read guard, /status open_question + widget marker, cmdp watch rendering. Tests: tests/questions.test.ts, worker-process/worker-manager/guards/status/watch units, mock e2e tests/e2e/questions.test.ts, live scenario (f) green with a real model. Free suite 374 tests green; live 7/7. |
| 39 | 5 | `cp-t30-packaging-l9e` | Packaging + self-scaffold | Landed 6e0049a: home resolution (CP_HOME > managed ~/.pi/command-post for an installed package > checkout root) so pi update cannot delete the fleet; src/scaffold.ts self-scaffold on session_start (dirs, home .gitignore, br init when absent, idempotent, missing br = skip); /cp-version + /doctor home.location; README quick-start with the install path and the state-location table. T28 answered: no Cursor/Claude skill copies (operator: neither runs in this home). cmdp CLI deleted with follow() and the bin entry (operator decision). Accept: tests/e2e/packaging.test.ts clean-machine simulation green; npm test 377 tests, 0 fail. |

## Still open at snapshot time

| id | status | what |
|---|---|---|
| `cp-2bm` | deferred | doctor's model check resolves with a synthetic project and br id |
| `cp-2lh` | deferred | /memory status does not lint malformed candidate lines |
| `cp-8v1` | deferred | /status and /doctor long output goes through ctx.ui.notify |
| `cp-ti5` | deferred | Parent /watch --detailed can accumulate artifact fragments |
| `cp-zkj` | deferred | Always-on parent (login item + start script) |
| `cp-rnr` | in_progress | Release cleanup: re-ignore .beads/ and drop doctor's build-time exemption |

## Chronology moved from contracts.md

### Attach console deleted (cur.3.4)

The attach console is deleted. No decision path runs through it.

`/cp-attach`, `/cp-next`, `shift+down` into a console, `state/runs/<job-id>/attach.jsonl` and `attach.json` are gone. Approve, revise, and answer are not console keys.

Replacement:

- a planner question is a blocked envelope; the parent answers with `cp_send` or one escalation
- plan approval is a decision: mandate, or one `plan_approval` escalation answered by `cp_decide`
- `/watch` still renders historical `attach_opened` / `attach_closed` run-log events (counts and a duration). New runs do not emit them
- `/cp-plan` stays a read-only pager
- a waiting planner shows in the fleet widget as an ordinary waiting job with the blocker count
### The answer card used to share a call stack with the envelope wake-up (cur.6.4 survey)

`cp-n9jh`'s answer was lost: the parent relayed the headline and tore the job
down seven seconds later, exactly as instructed, and the operator saw nothing.
The card used to be appended inside intake's `onReported`, in the same instant
and the same call stack as the envelope wake-up: one attempt, mid-turn (an
entry appended while the parent is streaming is spliced above the message being
written), with no record that anything was owed and no second chance if the
surface was not there. Everything else about that moment was already keyed on
the job's *phase*, and the phase was seconds from `done`. Replaced by the
outbox described in docs/contracts.md §The answer outbox.

### The status block used to be an end-of-turn ritual (cur.6.4 survey)

Every operator-facing turn ended with `cp_status_block`. That duplicated the
live status line and the fleet widget, which already render "In progress" from
the same projection, so most blocks were noise around one changed row. Made
opt-in; see docs/contracts.md §The status block is opt-in.

### cp-o77y: a refused envelope had no way back (cur.6.4 survey)

cp-o77y's worker filed a ship envelope naming the artifact `docs/evals.md`,
which did not exist. Intake refused it, correctly — but the refused record
stayed exactly where the worker had written it, at
`state/runs/cp-o77y/envelope.json`, and `report_result` is write-once against
that path. Every attempt to correct the report came back "already filed", and
the promote path could not help either: `decideReopen` supersedes a **stamped**
envelope, and a refused one is never stamped. A clean pushed PR and a finished
worker had no path back at all. Fixed by envelope correction; see
docs/contracts.md §Envelope correction.
