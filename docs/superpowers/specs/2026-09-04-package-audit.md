# In-house code vs pi.dev packages — audit

Date: 2026-09-04. Status: decided in conversation (item 2 of the three-item
sequence; item 1 is `2026-09-04-drop-br-ledger-design.md`, item 3 is the
single-project mode). This is a record, not a spec: nothing here is built.

## Question

Which pieces we wrote into `extensions/command-post` and `src/` could be
replaced by an existing, well-maintained package from
[pi.dev/packages](https://pi.dev/packages)? Selection rule from the operator:
prefer a package that is frequently updated or widely downloaded.

## Method

Two research passes, both on 2026-09-03/04, both reading package sources
rather than READMEs where a claim mattered:

1. A catalogue sweep of pi.dev (5,458 packages; server-rendered, `name=`,
   `type=`, `sort=downloads|recent` query parameters; monthly downloads on each
   card equal npm's monthly count) plus npm search on the `pi-package` keyword
   and the GitHub topic. Every package touching tasks, todos, kanban, beads,
   subagents, worktrees, memory, statuslines/widgets, review, attach, doctor
   and pager was tabulated.
2. A verification pass on the strongest candidates: exports, dependencies,
   process model, persistence and API read from the registry JSON and the
   repository default branch. URLs are cited per row below.

Nothing was installed.

## Verdict

| In-house piece | Best candidate (downloads/mo, version, last publish) | Fit | Single blocking gap | Evidence |
|---|---|---|---|---|
| Worker runtime: headless `pi --mode rpc` children, schema-validated envelope via a worker-side tool | `pi-subagents` (362.5K, 0.65.0, 2026-09-04); `@tintinweb/pi-subagents` (47.9K, 0.19.0); `@gotgenes/pi-subagents` (10K, 21.4.0) | weak | All three run children in-process via the SDK or in their own detached node runner. None spawns or manages a `pi --mode rpc` process, so the envelope tool, the stdio delivery contract, observed close, revive and wedged detection have no home. | nicobailon `src/runs/shared/child-session.ts`, `src/runs/background/async-execution.ts` L589, `docs/observability.md`; tintinweb `src/agent-runner.ts` L966-1008; gotgenes README "no spawned subprocesses" |
| Fleet widget above the editor | `pi-subagents/external-runs` (`registerExternalRun`, `updateExternalRun`, `unregisterExternalRun`) | medium | Display-only: shows foreign runs in its FleetView with label, state, preview and paths, but no stop, steer or attach, and it makes the whole runtime a dependency. tintinweb and gotgenes widgets list only their own agents. | nicobailon `src/api/external-runs.ts`, `docs/extension-api.md` "External jobs in FleetView"; tintinweb `src/ui/fleet-list.ts` L248 |
| Worktree leasing (`treehouse`: pool, `get --lease`, `return --if-lease-id`) | `@gotgenes/pi-subagents-worktrees` (818, 0.3.2, 2026-09-02); tintinweb `isolation:"worktree"`; nicobailon managed worktrees | weak | No pool or lease semantics in any of them: a detached tmpdir worktree per agent, committed to `pi-agent-<id>` and removed. gotgenes' `registerWorkspaceProvider({prepare → {cwd, dispose}})` is the only seam a caller could fill with a leased path, and it only applies to children running in gotgenes' in-process runtime. No package uses treehouse. | gotgenes `packages/pi-subagents/src/lifecycle/workspace.ts`, `packages/pi-subagents-worktrees/src/worktree.ts`; tintinweb `src/worktree.ts` L117-213; nicobailon `docs/configuration.md` L391-430 |
| Diff review (`cp_review`, fresh-context reviewer, validated verdict) | `@georgedong32/pi-review` (2,147, 0.8.4, 2026-09-03, Apache-2.0) | weak | No programmatic API: `index.ts` registers slash commands and a report tool; the *main agent* must then call nicobailon's `subagent` tool (hard peer `pi-subagents >=0.41`). `reviewers.<id>.promptPath` is accepted by the config merge but referenced nowhere else. Reusable idea only: its issue/gate JSON schema (`status`, `issues[]{file,line,category,severity,confidence,evidence,fingerprint}`, `verdict`, `dispositions[]`). | `index.ts` L45-179, `src/review-run.ts`, `src/workflow-schemas.ts`, `src/config.ts` L209 |
| Memory capture and curation (`cp_memory`, budgets, decay, journal) | `pi-experiences` (2,410, 0.1.64, 2026-08-31); `@fradser/pi-memory` (1,390, superseded by `pi-continual-learning` 0.2.2) | weak | `pi-experiences` has the right ideas (evidence table, staleness decay, human approval of every habit, redaction) but no public exports (`exports: null`; capture/approve/reject/retire are internal functions over a `node:sqlite` handle), TUI-only injection, and a heavy runtime (sqlite ledger, optional ~150 MB embedding model). `@fradser/pi-memory` has no decay and no per-item approval. | misunders2d/pi-experiences `src/review.ts`, `src/consolidate/math.ts`, `index.ts` L4607-4650; FradSer/pi-packages `packages/continual-learning/extensions/inject-memory.ts` |
| Attach console onto a running RPC planner | `@zhuxixi/pi-agent-board` (1,121, 0.5.2, 2026-09-03); `pi-interactive-shell` (4,754, 0.15.1) | none | Both attach only to PTYs or hosts they spawned themselves (`node-pty` host over `control.sock`; `zigpty` sessions in an in-memory map). Neither can speak to a foreign process's RPC stdin/stdout. `node-pty` is a native addon. | zhuxixi `src/ui/pty-attach.ts` L385, `runner/pty-runner.mjs` L152-173; nicobailon pi-interactive-shell `session-manager.ts` L144-148 |
| Human authorization checkpoint (journaled, model cannot answer) | `@gotgenes/pi-permission-system` (30.2K, 31.0.1); `@erichll/pi-auto-review` (3,821, 0.15.3) | weak | Permission-system asks exist only as tool/bash/path gates (`confirmation_unavailable` when headless); no API to raise an arbitrary human question. Auto-review's broker accepts arbitrary requests but the verdict is model-made and it keeps daily aggregates, not per-decision records. Its `permissions:decision` events and JSONL log are the only reusable shape. | gotgenes `packages/pi-permission-system/src/service.ts` L83-275, `docs/cross-extension-api.md`; erichll `packages/pi-auto-review/src/broker/service.ts` |
| Pager / plan viewer overlay (j/k, `/`, n/N) | `@tmustier/pi-files-widget` (646); `@agnishc/edb-context-viewer` (1,460) | weak | The one file viewer with the right keymap needs `bat`, `git-delta` and `glow` on PATH; the context viewer has the keymap but only over the LLM context. `pi-markdown-preview` (16.2K) renders PNG pages through pandoc and Chromium with no text search. | registry READMEs of each |
| `/doctor` with JSON output | `pi-env-probe` (382, 0.1.5) | weak | Fixed generic shell/runtime checks, no extension point for pi, treehouse, git or our own files. | registry README "Probe result fields" |
| Project registry with clone-on-demand; parent lock; atomic JSON store; `/status --json`; CI wake-ups keyed to a held PR's head sha | none | none | Not on the registry in any usable shape. `@hank-warren/pi-github-actions-watch` is deprecated by its author; `proper-lockfile` is an npm library several packages use internally, not a pi package. | catalogue sweep |
| Background task runtime with completion wake-ups; delegated read-only child; multi-model review | `pi-background-tasks` (107.7K, 2.5.0, 2026-09-04) | none | Its Anthropic provider extension loads globally and refuses non-OAuth credentials (this home uses an API key); peers pin pi 0.81–0.84 (this home runs 0.85); `bg_run` is a second shell tool the parent's `tool_call` guards do not inspect; `bg_delegate`/`bg_result` return bodies inline into the parent's context. The one gap it named (reviewer tool calls blocking the parent) is closed in-house by `2026-09-05-async-reviewers-design.md`, which borrows two of its rules: publish only after the result is durable, and only after the caller holds the task id. | `pi.dev/packages/pi-background-tasks`; package `docs/api/eventbus-v1.md`, `docs/subsystems/anthropic-attribution.md`, `src/core/registry.ts` L2287-2327 |
| Questionnaire overlay | `@juicesharp/rpiv-ask-user-question` (117K, 2.9.0, 2026-09-01) | in use | Already the dependency behind `/cp-decide`. No change. | `package.json` |
| Job ledger | none | decided in item 1 | Replaced by the in-house jobs document; see `2026-09-04-drop-br-ledger-design.md` §Problem for the ledger candidates and why each fell short. | — |

## Decision

Keep every remaining in-house piece. The subagent runtime, the leases, the
envelope contract and the observation stack are the product, not plumbing
around it; the packages that overlap them solve a different problem
(in-process delegation from one session) and would have to be rewritten
around, not adopted.

One optional follow-up, not scheduled: register our workers in
`pi-subagents`' FleetView through `registerExternalRun`, so an operator who
also runs that package sees both fleets in one place. Display-only, and only
worth it if that package is in use here.

## When to re-check

Revisit this audit when a pi.dev package appears that does any of these,
because each would change a row above from weak to plausible:

- spawns and supervises `pi --mode rpc` children with a typed, validated
  result contract and pid-based reconciliation after a parent restart;
- offers worktree **leases** from a shared pool (acquire from a canonical
  clone, return by lease id) rather than a tmpdir per agent;
- exposes a programmatic diff-review API that takes a ref range or diff file
  and returns structured findings without going through the main agent;
- opens an arbitrary markdown file in a TUI overlay with `j/k` and `/`
  search and no external binaries;
- raises an arbitrary human authorization question with a journaled,
  machine-readable decision that a model cannot answer.

Sources for the next sweep: `https://pi.dev/packages?name=<term>&sort=recent`
for `subagent`, `worktree`, `review`, `pager`, `viewer`, `permission`,
`memory`; the card attributes `data-package-downloads` and
`data-package-date` carry the numbers.
