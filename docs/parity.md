# Parity audit (T28)

A line-by-line walk of command-post's `README.md` and `AGENTS.md` (plus its
`cmdp` subcommands, `templates/`, `share/`, `scripts/` and `reports/`)
against this build. Every row is **capability → new home → evidence**, where
evidence is a file plus the test that holds it up.

Paths in the **new home** and **evidence** columns are this repo. Paths in the
**command-post** column (and in §4) belong to the old checkout.

Verdict vocabulary:

| verdict | meaning |
|---|---|
| **ported** | the capability exists here, usually as code instead of prose |
| **mechanised** | it was a rule a human/model had to remember; it is now enforced |
| **deleted** | the *mechanism* is gone because the transport it served is gone |
| **out of scope** | declared in [README.md](../README.md#not-in-scope) |
| **gap** | unaccounted for; a job exists (none block T29 except where noted) |

Zero capabilities are unaccounted for: every row below is one of the five.

## 1. Commands (command-post `cmdp`, `install.sh`)

| command-post | verdict | new home | evidence |
|---|---|---|---|
| `cmdp dispatch --project --job-id --template --task-file --scope --risk` | ported | `cp_dispatch` tool → [`src/dispatch.ts`](../src/dispatch.ts) | `tests/dispatch.test.ts`, `tests/e2e/phase2.test.ts` |
| `cmdp dispatch --name <alias>` | deleted | worker identity **is** the job id (one worker per job); aliases existed to name panes | `WorkerManager.spawn` one-worker-per-job, `tests/worker-manager.test.ts` |
| `cmdp dispatch --origin` | out of scope | `origin` is still carried on every fleet record and status row, unread | `FleetRecordSchema.origin`, `StatusJobSchema.origin` |
| `cmdp dispatch -- CMD…` (CLI override) | ported (narrowed) | `model` override on `cp_dispatch`; there is one CLI (pi) by design | `tests/routing.test.ts` |
| `cmdp check --project <worktree> --base` | ported | `cp_check` tool → [`src/preflight.ts`](../src/preflight.ts) | `tests/preflight.test.ts`, `tests/contract.test.ts` (tool is exposed) |
| `cmdp lease --project NAME` | deleted (deliberate) | leasing is a step *inside* dispatch; a lease with no worker is an orphan waiting to happen. `LeaseManager` is still a module | `tests/leases.test.ts` |
| `cmdp jobs add\|set\|reported\|done\|list` | ported | `state/fleet.json` store (add/update), envelope intake (`reported`), teardown (`done`), `/status` (`list`) | `tests/fleet.test.ts`, `tests/intake.test.ts`, `tests/teardown.test.ts`, `tests/status.test.ts` |
| `cmdp artifact path\|add\|get` | ported | `cp_artifact` → [`src/artifacts.ts`](../src/artifacts.ts); `get` requires an out file (no inline bodies) | `tests/artifacts.test.ts`, `tests/guards.test.ts` |
| `cmdp gate [--model]` | ported | `cp_gate` → [`src/gate.ts`](../src/gate.ts); verdict is a schema, not a regex over prose | `tests/gate.test.ts`, `tests/e2e/phase3.test.ts` |
| `cmdp teardown <job-id> [--research]` | ported (improved) | `cp_teardown`; the kind comes from the fleet record, so the flag cannot disagree with the job | `tests/teardown.test.ts` |
| `cmdp status [--json] [--origin]` | ported | `/status` + widget → [`src/status.ts`](../src/status.ts) | `tests/status.test.ts` + goldens |
| `cmdp status --html --serve --port --pane` | out of scope | HTML dashboard deferred; `fleet.json` + `runs/` are shaped to feed one later | README.md out-of-scope |
| `cmdp doctor` | ported | `/doctor` → [`src/doctor.ts`](../src/doctor.ts), plus the ledger checks (document shape, ids, dependency graph, prefix, size, `.beads/` archive) | `tests/doctor.test.ts` + golden |
| `cmdp models` (catalog, families, TTL cache, allowlist) | ported (narrowed) | pi owns the model registry (`/models`, `get_available_models`); the allowlist and rubric are `data/routing.json`, availability is probed with real auth in `/doctor` | `tests/routing.test.ts`, `tests/doctor.test.ts` |
| `cmdp threads bind\|unbind\|list\|events\|status\|log` | out of scope | Slack | README.md out-of-scope |
| `cmdp relay` | out of scope | Slack | README.md out-of-scope |
| command-post `install.sh` (deps + scaffold + hooks) | ported (T30) | self-scaffold on `session_start` (`src/scaffold.ts`): `data/`, `state/`, `projects/`, a home `.gitignore`, and an empty `.pi-command-post/jobs.json` when absent; idempotent | `tests/scaffold.test.ts`, `tests/e2e/packaging.test.ts` |
| `install.sh` skill copies into `.cursor/skills`, `.claude/skills`, `.agents/skills` | **deleted (T30, operator decision)** | pi discovers `skills/` through the package manifest, so the copies only served *other* agent CLIs. The operator's answer for this home: no Cursor, no Claude Code, so nothing to copy — and a copy of a skill is a second source of truth that drifts | `package.json` `pi.skills`, `tests/scaffold.test.ts` |
| command-post `cmdp` as a shell CLI | **deleted (T30)** | every parent surface is a tool or a slash command. A `cmdp watch` CLI survived T24-T29 for one capability — an unbounded live tail — and nothing but a human ever ran it; a live tail is now `tail -f state/runs/<job-id>/events.jsonl`, and a second entry point no longer has to agree with the parent about the home, the fleet and the renderer | `tests/watch.test.ts` (`/watch` parsing + rendering), `tests/e2e/packaging.test.ts` |

## 2. Transport (muxa)

Everything in this section is **deleted with its transport**, and the replacement
is a fact rather than a heuristic. This is the rebuild's reason for existing.

| command-post / muxa | verdict | replacement | evidence |
|---|---|---|---|
| `muxa spawn` / `muxa dispatch` (pane + first brief) | deleted | `WorkerProcess`: spawn `pi --mode rpc`, then an id-correlated `prompt` | `tests/worker-process.test.ts`, `tests/e2e/phase1.test.ts` |
| Paste broker, free-detection, `pending/` | deleted | RPC request/response; `receipt: "accepted"` means pi answered | `tests/dispatch.test.ts` |
| First-brief **receipt heuristics** (Cursor: tail for `Branch:`; Claude: footer `Context: N%`; `unconfirmed`/`unknown`) | deleted | there is nothing to guess: the response is the receipt | `docs/contracts.md` §Dispatch |
| `muxa send` (mail, promote) | ported | `cp_send` → prompt/steer/follow_up with `delivered\|queued\|failed` | `tests/send.test.ts` |
| `muxa who` (roster, idle/busy/ghost) | ported | `fleet.json` + `agent_start`/`agent_settled` + pid probe + observed close | `tests/fleet.test.ts`, `tests/status.test.ts` |
| `muxa tail NAME` (one-shot read, exit 2 unknown) | ported | `/watch` (bounded, rendered from `events.jsonl`); an unknown run is still refused as `unknown_run`, never shown as idle. A live tail is `tail -f` on the log | `tests/watch.test.ts` |
| `muxa attach NAME` (attach to a worker's pane and type at it) | **deleted** (cur.3.4) | the attach console is deleted. No decision path runs through a pane or a console. Replacement: a planner question is a blocked envelope answered by `cp_send` or one escalation; plan approval is a mandate decision or one `plan_approval` escalation answered by `cp_decide`. `/watch` and `/cp-plan` stay (inspection). A waiting planner is an ordinary waiting job with the blocker count | `docs/contracts.md` §Attach console deleted; `src/widget.ts` blocker count |
| `muxa kill NAME\|ID` | ported | teardown's graceful shutdown with an observed close | `tests/teardown.test.ts` |
| Broker parent turns (`never ready` / `dispatch refused` / `dispatch unsubmitted` recovery table) | deleted | none of the three states can exist: delivery is acknowledged or it failed | `docs/contracts.md` §Delivery receipts |
| "Never call `tmux` directly" / muxa boundary rules / the two tests | deleted | one harness, no boundary to police | AGENTS.md (no transport prose; `tests/contract.test.ts` enforces that) |
| `muxa parent` role check | deleted | a worker is a child process with no dispatch tools; recursion is impossible by construction | `WORKER_FORBIDDEN_TOOLS`, `tests/worker-reporter.test.ts` |
| command-post `scripts/muxa-hook.sh` (pane self-registration) | deleted | no panes to register | — |
| command-post `share/clis.tsv`, `share/families.tsv` (multi-CLI registry) | out of scope | pi-only by design | README.md |

## 3. Operating contract (`AGENTS.md`, section by section)

| old section | verdict | new home | evidence |
|---|---|---|---|
| Parent job ("intake, classify, dispatch, wait, relay, teardown. Nothing else") | ported | AGENTS.md §The loop | `tests/contract.test.ts` |
| "Never do the worker's job / never read project source" | ported | AGENTS.md §The loop (never-list) | — |
| Session start: read learnings, then `cp_job ready` | mechanised | memory digest is injected at `session_start`; `/status` + `cp_job ready` are step 2–3 | `tests/memory.test.ts` |
| Classify (kind × delivery, do not blur) | ported | AGENTS.md §Classify; labels are the dispatchability contract | `tests/ledger.test.ts` (`requireJobLabels`) |
| "Evidence is not authorization" | mechanised | the checkpoint: written `pending` before anyone is asked, answerable only by a human channel | `tests/pipeline.test.ts`, `tests/e2e/phase3.test.ts` |
| Pipeline: two jobs, dep-linked, three roles | ported | `cp_pipeline start` | `tests/pipeline.test.ts` |
| Gate verdicts + `cause` ladder (policy / operational / operational_persistent) | mechanised | `decideGate` + `nextAction`; one revise max in code | `tests/gate.test.ts` (every branch), `tests/e2e/phase3.test.ts` |
| "HARD RULE: workers never mail the findings body" | mechanised | `validateEnvelope`: ≤3 lines, no fences, no headings; a body-shaped summary is rejected in-worker | `tests/worker-reporter.test.ts`, `tests/contracts.test.ts` |
| "Parent never reads artifact bodies" | mechanised | `ContextGuard` blocks `read`/`grep`/`bash`/`edit`/`write`; the ledger holds no bodies | `tests/guards.test.ts`, `tests/e2e/phase3.test.ts` |
| Hung planner (artifact, no envelope) → gate from the path | ported | `advance()` gates it and reports `hung_planner` | `tests/pipeline.test.ts` |
| "Never re-run research for an implementation failure" | mechanised | `mayRerunResearch` is asserted, not remembered | `tests/failures.test.ts` |
| Pre-dispatch path (lease-bind, branch=job-id, check, jobs add) | ported | `cp_dispatch`'s fixed order; probe **before** lease, no orphan branch | `tests/dispatch.test.ts` |
| Promote vs new lease (same repo + held worktree + same model) | mechanised | `decideOccupancy`; cross-model role hop refused with the teardown instruction | `tests/preflight.test.ts` |
| "Research evidence is not authorization to dispatch a second pane" | mechanised | one worker per job, enforced at spawn | `tests/worker-manager.test.ts` |
| Stale clone / "belongs to another repo" recovery | ported | `assertCanonicalClone`'s five checks; recovery stays an operator decision | `tests/projects.test.ts` |
| `git worktree add` allowed only when treehouse is missing | ported (hardened) | **no** fallback at all: a missing treehouse is a hard error | `tests/leases.test.ts` |
| Project management (clone on demand, registry, one canonical clone) | ported | `data/projects.json` + rendered `projects.md` view | `tests/projects.test.ts` |
| Worker dispatch: "pass only the CLI and optional `--model`; no trust/yolo/skip-permissions flags" | mechanised | `WORKER_REQUIRED_FLAGS` / `WORKER_FORBIDDEN_FLAGS` + `assertTrustPolicy(argv)` re-checks the final argv | `tests/worker-manager.test.ts`, `tests/contracts.test.ts` |
| Model routing (order, allowlist, `source=/model=/rule=`) | ported | [`src/routing.ts`](../src/routing.ts); resolution table from `reports/model-routing.md` reproduced | `tests/routing.test.ts` |
| First brief contract (`templates/`, placeholders, `--brief-file`) | ported | `prompts/briefs/` + `assembleBrief`; unknown placeholder **or** missing value fails closed | `tests/profiles.test.ts` |
| Workers search with `grep`/`glob`/`read`, not `bash` grep/cat (audit 2026-09-06: ~2173 bash grep/cat/head/tail/ls calls, `glob` called 0 times) | mechanised | the rule is in all three briefs and all three worker profiles (`prompts/briefs/`, `profiles/`), and five contract cases fail the suite if a surface loses the sentence | `tests/evals.test.ts` (`evals/corpus.json` `*-bounded-search-tools`) |
| Broker parent turns | deleted | see §2 | — |
| While they run: "never poll", inspect once, no auto-restart | mechanised | the parent wakes on envelopes; `/watch` cannot follow; recovery is bounded by class | `tests/watch.test.ts`, `tests/failures.test.ts` |
| Fan out; serialize only for real dependencies | ported | AGENTS.md §Fan out, and where to stop | `tests/contract.test.ts` |
| Parallel PRs from one base (rebase before the second merge) | ported | AGENTS.md §Fan out (this audit restored it) | `tests/contract.test.ts` |
| "Freeze scope once validation starts" | ported | AGENTS.md §Fan out (restored) | `tests/contract.test.ts` |
| "The delivery path owns the rigor; never merge red" | ported | AGENTS.md §Fan out (restored) + PLAN out-of-scope rationale | `tests/contract.test.ts` |
| Worker envelope: `jobs reported` first, then relay, then teardown | mechanised | intake stamps `reported_at` once and returns `next: hold\|teardown` | `tests/intake.test.ts` |
| `delivery:pr` hold until CI/review settles | ported | `held` phase + `next: "hold"`; AGENTS.md §Teardown (restored: not at first envelope) | `tests/intake.test.ts`, `tests/contract.test.ts` |
| `stalled` phase | deleted | structurally impossible: a worker is working, idle or observed-dead | `tests/status.test.ts` ("never invents a phase") |
| `held` phase | ported | requires `reported_at`, validated | `tests/contracts.test.ts` |
| Teardown gates (ship clean+pushed; research clean+no local commits) | ported | `cp_teardown`, fail-closed keeps everything | `tests/teardown.test.ts` |
| Merged-PR auto-deleted-head trap (two-dot, not three-dot) | ported | `merged_head_deleted` pass reason: `ls-remote` empty **and** two-dot tree diff empty | `tests/teardown.test.ts` (squash-merge case) |
| "Confirm the PR merged" (a fix with no mechanism) | mechanised (cp-vk1) | `cp_merged` writes a merge receipt from `gh pr view`; the gate reads it as the `merged` pass reason, for squash and rebase alike | `tests/merges.test.ts`, `tests/teardown.test.ts` |
| "Is the branch on origin?" answered from a remote-tracking ref | fixed (cp-vk1) | every such question goes through `git ls-remote`; an unreachable origin is `remote_unverified`, never a fallback to the stale ref | `tests/teardown.test.ts` (stale-ref case) |
| "What is the base?" answered from a remote-tracking ref, on a **pass** path | fixed (cp-p0r) | `#mergedAndAbsorbed` resolves the base with `ls-remote` and diffs against that sha; unaskable origin or absent base ⇒ refuse | `tests/teardown.test.ts` (stale-base case) |
| The last tracking-ref **action**: `reset --hard origin/<branch>` in the leased worktree | fixed (cp-uv5) | `#syncWorktree` resets to the sha `ls-remote` reported — the same sha its guard compared HEAD against; origin unaskable or the ref absent ⇒ no reset, and never a fallback to `refs/remotes/origin/*`. Which commits may be discarded is unchanged | `tests/integrate.test.ts` (ls-remote sha, unresolvable tracking ref, both refusals) |
| The losslessness proof the parent ran **by hand**, 7 times on 2026-09-01, before every manual `reset --hard` | mechanised (cp-8vf6) | `#syncWorktree` proves it itself: equal, non-empty cumulative-branch-diff patch-ids for the local head and the `ls-remote` sha, against a base tip read from origin; the discarded head is kept at `refs/cp-salvage/<job-id>/<utc>` first. Anything unreadable, empty or unequal refuses exactly as before | `tests/sync-lossless.test.ts` (real git: the replay, the unpushed-work inverse, binary-only, conflict-resolved rebase, unknown base), `tests/integrate.test.ts` (which questions were asked) |
| Rescue refs (`refs/cp-salvage/*`) accumulating with nothing to prune them | bounded (cp-wcy5) | `#pruneSalvageRefs` runs at the end of a successful `cp_integrate` and deletes a ref **only** once its commit is an ancestor of the base tip `ls-remote` names — never age, never count, never a timer, never a ref outside that namespace; every unreadable answer keeps the ref, and both the pruned and the kept refs are reported with their reason | `tests/sync-lossless.test.ts` (real git: reachable pruned, unreachable kept with its object intact, unaskable origin), `tests/integrate.test.ts` (which question decided, and that no other ref is ever named in a delete) |
| The merge itself: rebase → CI on the pushed head → merge → receipt → teardown → head delete → job close, done by hand on the parent's turns | mechanised (cp-uug) | `cp_integrate` → [`src/integrate.ts`](../src/integrate.ts): one verified step per call, resumable, parent-side (so `src/ci-wait.ts` is untouched); merge authority is repo-derived (cp-e0c, answering cp-x7i): `evaluateMergePermission` reads whether GitHub itself would accept the merge unforced, and only falls back to a per-PR **per-head-sha** human checkpoint when that cannot be read | `tests/integrate.test.ts`, `tests/merge-permission.test.ts`, `docs/contracts.md` §Integration |
| Teardown drops `state/artifacts/<id>` | changed (T19) | artifacts are kept unless the operator asks; the store is the durable record | `docs/contracts.md` §Artifacts, `tests/teardown.test.ts` |
| Report discipline: full PR URLs, never paste worker dumps, stop after two ping-pongs | ported | AGENTS.md §Reporting to the operator (restored) | `tests/contract.test.ts` |
| STATUS BLOCK (four tables, always rendered, self-describing rows, Awaiting-you types, ≤5 shipped rows, finished research) | ported | AGENTS.md §Status block | `tests/contract.test.ts` (four tables + the rules) |
| Slack threads / origins / confidentiality edge | out of scope | — | README.md |
| Jobs ledger: not a backlog (the issue lives where the operator says; `external_ref` points at it), labels, intake, deps, completion, history | ported (in-house document, spec 2026-09-04; `type`/`priority` retired and `external_ref` freed 2026-09-05) | [`src/ledger.ts`](../src/ledger.ts) + AGENTS.md §Jobs | `tests/ledger.test.ts` |
| `slug` on `cp_job create` | ported | `IntakeInput.slug` | `tests/ledger.test.ts` |
| membership queries are never paged | mechanised | `ready`/`blocked`/`blockersOf` are computed over the whole document; there is no page to fall off | `tests/ledger.test.ts`, `tests/status.test.ts` — **found by this audit**; the fail-open case was `cp-i2s` |
| Memory (three files, budgets, tiers, decay, capture/curation, retrieval) | ported | [`src/memory.ts`](../src/memory.ts) + `skills/cp-memory` | `tests/memory.test.ts` |
| Curation as a human-run pass ("a curation pass promotes ones that generalize") | mechanised | the pass is the parent's own ([`src/curation.ts`](../src/curation.ts)): promotion is bounded (3/day, 60-line ceiling), never pinned, evidence-required, append-only and journalled to `data/curation.jsonl` before the file changes; a superseded/disproven candidate is permanently unpromotable; retirement is a reason+evidence move to the archive | `tests/curation.test.ts` (one test per property) |
| State files: never commit `data/ state/ projects/ .beads/` | mechanised | `NEVER_COMMIT_PATHS` + guard blocks `git add/commit/push` and bulk staging in the home | `tests/guards.test.ts` |
| Slack tokens in `state/slack/tokens.env` (mode 600) | out of scope | no Slack; brief secret-scanning covers the general hazard | `tests/worker-manager.test.ts` (`assertBriefIsSafe`) |

## 4. Reports (ported *knowledge*, not prose)

These are files in **command-post's** `reports/` (the old checkout), not paths in
this repo. Each was a research write-up whose *conclusion* is now enforced here;
the write-ups themselves stay where they were written.

| command-post `reports/` | where the knowledge lives now |
|---|---|
| `dispatch-hardening.md` (probe before lease, no orphan branch; stalled-worker empty composer; teardown) | `src/dispatch.ts` order + `docs/contracts.md` §Dispatch; the composer failure mode is deleted with the paste broker |
| `teardown-research.md` (research gate: clean + no local commits) | `Teardown` research gate, `tests/teardown.test.ts` |
| `operating-knowledge.md` (merged auto-deleted head; ledger membership queries; promote-not-spawn; parallel PRs) | `merged_head_deleted` check; unpaged membership queries; `decideOccupancy`; AGENTS.md §Fan out |
| `model-routing.md` (rubric table) | `data/routing.json` rubric rows; the table is reproduced in `tests/routing.test.ts` |
| `br-slug-install.md`, `br-tracker-research.md` (pinned br, migrate-schema) | retired with br (spec 2026-09-04); `/doctor` checks the jobs document instead |
| `ai-memory-research.md` (tiers, budgets, decay) | `src/memory.ts` constants + the file headers |
| `origin-scoping.md` | out of scope (Slack), `origin` field preserved |

## 5. Gaps filed as jobs

| gap | issue | why it is not a T29 blocker |
|---|---|---|
| Always-on parent (command-post `scripts/cp-parent-start.sh`, `share/launchd/`, `always-on-parent.md`): running the parent as a login item so the fleet survives a terminal closing | [`cp-zkj`](#) — **done** (cp-daemon v1 P2: `cp-parent.service` + `cp-view.service`, `scripts/install.sh`; [`docs/service.md`](service.md)) | it **attaches**, never starts a second parent: the supervisor uses only `attachParentHost` (attach-first, lock refusal, generation claim). systemd user units only; launchd stays out of scope |
| Harness skill copies (`.cursor/skills`, `.claude/skills`, `.agents/skills`) for other agent CLIs | folded into **T30** (`cp-t30-packaging-l9e`, comment) | pi discovers `skills/` from the package manifest; copies matter only if the operator also runs Cursor/Claude Code in this home, so T30 decides explicitly rather than leaving it unaccounted |

## 6. Deliberate improvements (no old counterpart)

Recorded so a future audit does not mistake them for scope creep: run artifacts
(`events.jsonl` + `status.json` projection, T4), the failure taxonomy with
bounded recovery and token budgets (T18), the journaled checkpoint (T21), the
opt-in research quality panel (T22), `report_verdict` as a second terminating
tool (gate-verdict amendment), the scriptable mock provider and three milestone
E2E gates (M0–M3), and `/doctor`'s ledger checks. Each is a rule the predecessors
enforced by hand, or a failure they hit without a test.
