# Handoff — implementing the asynchronous reviewers (PR 4)

Paste the prompt below into a fresh Claude Code session opened at the root of
`pi-command-post`. The spec and plan are committed on the branch
`spec/async-reviewers`; merge it into `main` first, or start from it.

This plan comes **after** the three-item sequence in
`2026-09-04-handoff.md`: PR 1 (`br_id` → `job_id`) and PR 2 (in-house
ledger) must be merged before this starts. PR 3 (single-project mode) may
land before or after; the plan goes through `paths.*` everywhere and needs
nothing from it.

---

```
Implement the asynchronous-reviewers change to pi-command-post as one PR. It is specified and planned already; do not re-brainstorm or re-scope. Open the PR when the plan's last task is done and stop.

Read first, in this order:
1. docs/superpowers/specs/2026-09-05-async-reviewers-design.md — decisions D1–D11 are settled. cp_gate, cp_review and the quality panel return `wait` at spawn and finish in the background; a sixth wake-up, cp-verdict, carries the verdict; cp_pipeline advance returns `wait` while a reviewer runs.
2. docs/superpowers/plans/2026-09-05-async-reviewers.md — ten tasks, each with tests and code, ending in an operator step and the PR.
3. docs/superpowers/specs/2026-09-04-drop-br-ledger-design.md — context only: this plan assumes both of its PRs have landed.

Precondition, check before anything else: `grep -rn "br_id" src extensions tests | head` must return nothing and `src/ledger.ts` must be the in-house JSON ledger (no `br` binary). If either check fails, stop and report; do not start.

Ground rules the plan already states and that must hold:
- Every commit passes `npm run typecheck`; the PR passes `npm test`. Tests are `node --test`; goldens regenerate with `CP_UPDATE_GOLDEN=1` and the diff is reviewed before committing.
- TDD as written: failing test, run it, implement, run it, commit. Each task's code is in the plan — use it, adapting only where the file has drifted since 2026-09-05 (line numbers are hints, not contracts; find the quoted code).
- Every file path in new code goes through `paths.*` in src/contracts.ts. No literal `state/`.
- Do not change what the ladders decide: decideGate, nextAction, reviewCapExhausted, tallyVotes, the revise caps, REVIEW_MAX_ATTEMPTS and every decision file name stay as they are.
- `awaitVerdict` in src/gate.ts stays the only verdict waiter; the private copy in src/quality.ts is deleted (D10).
- The decision file is written and pending.json deleted before a wake-up is sent (D8); the wake-up waits for handBack (D7); one pending attempt per (job, surface) (D9); orphans fail closed and the ladder retries (D4).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. The PR body ends with the "Generated with Claude Code" line the plan includes.
- Never touch data/, state/, projects/, .beads/ or .pi-command-post/ in git.

Sequencing detail:
- Tasks 1–2 (contracts, src/review-runs.ts) have no dependency on the reviewer modules and can be reviewed on their own before Task 3 starts.
- Task 4 may leave src/pipeline.ts calling the temporary `reviewAndWait`/`runAndWait` only if typecheck would otherwise block the commit; Task 6 removes them from the pipeline. Say so in the commit message if you do.
- Task 6 adds `quality_acted_at` to PipelineRecordSchema; without it the pipeline would skip acting on a panel report written in the background. Do not drop it as optional.
- Task 10 is the operator step: a real session on this checkout, a pipeline run through a gate with the cp-verdict wake-up observed, and the orphan path (quit mid-review, restart, see the attempt recorded operational). Report the tool outputs and the events.jsonl type sequence verbatim in the PR body, then stop.

When a plan step disagrees with what you find in the code, prefer the spec's decision, note the discrepancy in the commit message, and keep going. If a decision genuinely is not covered by the spec, stop and ask rather than inventing one.

Start with Task 1. Report progress task by task, briefly.
```
