---
name: cp-memory
description: >-
  Command post session-memory curation (capture, promote, reject, retire) over
  data/learnings.md, data/candidates.md, data/archive.md and the
  data/curation.jsonl audit. Use when the session-start digest or a capture reports
  pending candidates or stale learnings, when the
  operator asks to curate or archive memory, or when a worker's result yields a
  lesson specific to this machine or this home. Parent session only (it needs
  cp_memory); the main session proposes a lesson with a `capture:` line in a send.
---

# cp-memory

`data/…` paths below are under `<home>/.pi-command-post/`.

Session-memory curation for the command post parent. **Curation is your job, and
you do not ask permission to run it.** The safety properties a human approval was
nominally holding are enforced in code
([docs/contracts.md §Curation](../../docs/contracts.md#curation-autonomous)); what
is left for you is the part code cannot do — **judgment**: what generalizes, what
supersedes what, what is noise, what is worth a line in every future session's
context.

Everything mechanical is a tool call, and you should use it instead of editing
files by hand:

| Want | Use |
|---|---|
| capture a lesson | `cp_memory capture` (operator: `/memory capture <lesson>`) — appends to `data/candidates.md`, never to learnings |
| the pass's worklist | `cp_memory curate` — pending candidates, stale learnings, today's remaining bounds |
| promote one candidate | `cp_memory promote` — composes the dated, evidenced, decaying line and appends it |
| kill one candidate | `cp_memory reject` with a cause — permanent, journalled, never a rewrite of candidates.md |
| remove a learning | `cp_memory retire` — reason + evidence, moved to `data/archive.md` with provenance |
| trace a bad line | `cp_memory audit [line]` — the decision, its candidate, its evidence, its date |
| budget / decay / off-shape lines | `cp_memory status` (operator: `/memory status`) |
| scaffold the files | happens at `session_start`, idempotent |

Run this in the command post **home**, never from a leased worktree: `data/` is
the parent's, and a worker has no business writing it (`cp_memory` is in
`WORKER_FORBIDDEN_TOOLS`, and so it cannot). Never commit `data/` (the T19 guard
refuses, and so should you).

## Fresh-home test (routing)

Before promoting anything into `data/learnings.md`, ask:

> Would a fresh, clean command post need this?

| Answer | Destination |
|--------|-------------|
| Yes — a general orchestration rule | `AGENTS.md` (the rule) + `docs/` (the rationale); that is a commit, not memory. Reject the candidate as `generalizes` so it stops reappearing |
| Yes — but it is a defect in a dependency | a job; the workaround is a **perishable** promotion with the issue named as its expiry |
| No — this machine or this home only | promote it |
| Not yet sure — needs one more observation | leave it captured; it stays pending and the next pass sees it again |

Job history lives in **the ledger** (`cp_job list --all`, closed jobs), not here.
Project-intrinsic facts ("repo X's tests need flag Y") belong in that repo's
`AGENTS.md`, which means a dispatched worker, not an edit from this session.

## When to run

| Trigger | Pass |
|---------|------|
| A worker reported or failed, and the lesson is local | **Capture** only |
| The digest or a capture reports pending or stale | **Curation** |
| Operator asks to curate / consolidate / archive | **Curation** |

Most jobs yield nothing. **Capture is not promotion** — it is the observation;
the pass is the decision.

## Files

| File | Role | Write rule |
|------|------|------------|
| `data/learnings.md` | curated core; loaded every session start | append-only through `cp_memory promote`; ≤60 lines, enforced |
| `data/candidates.md` | observations awaiting a decision | append-only, one dated line — a line that is not `YYYY-MM-DD <lesson>` is invisible to curation, and `status` names it |
| `data/archive.md` | retired entries | append with provenance; never delete |
| `data/curation.jsonl` | every promotion, rejection and retirement | append-only audit, written **before** the file it describes changes |

Each markdown file carries its own contract as an HTML comment at the top. Read
it before writing. Shapes:

```
# candidates.md — one dated line
YYYY-MM-DD <one-line lesson>

# learnings.md — one line each, composed by cp_memory promote
- YYYY-MM-DD what happened; what to do; evidence: <source>. <!--tier-->

# archive.md — with provenance
- YYYY-MM-DD (from data/learnings.md, <!--a:DATE-->, archived YYYY-MM-DD): <entry>. Reason: <why>. Now: AGENTS.md §X
```

Tiers, on learnings lines only: `<!--P-->` pinned (never decays);
`<!--a:DATE-->` aging (stale at ≥30 days); `<!--p:DATE-->` perishable (stale at
≥7 days, and it **must** name a checkable expiry). **A pass cannot write a
pinned line** — pinning is permanent, and permanence is the operator's own edit.
Everything you promote decays, which is what makes a mistaken promotion
survivable.

## Capture

On a worker's envelope or failure, ask: is this lesson specific to this machine
or home, or would every command post need it? If it generalizes, it is a
contract edit, not a learning.

`cp_memory capture` when the lesson is:

- environment-specific (paths, a local tool version, a recovery this machine
  needs until an upstream fix lands);
- an interim workaround tied to an open issue with a named expiry.

Skip: job outcomes, PR URLs, gate verdicts (all in the ledger), rules every clone needs,
project-intrinsic facts.

A product defect's workaround is promoted `perishable`, with its fix (job/PR) as `expires`.

## Curation

1. `cp_memory curate`. It gives you every pending candidate in full, the
   learnings past their decay window, and what today's bounds still allow
   (3 promotions, 10 retirements, the room left under 60 lines).
2. Read `data/learnings.md` in full before you decide anything — the file is
   small on purpose, and a promotion you make without reading it is how a
   near-duplicate gets in (the code refuses the obvious ones; it cannot refuse
   the subtle ones).
3. **Decide every pending candidate.** There are two outcomes, and undecided is
   not one of them:
   - `cp_memory promote` — machine-local, still true, worth a line. Give the
     lesson as it should *read* ("what happened; what to do"), the evidence
     (a job id, a PR, a commit, a path or a date), and a tier: `perishable` with
     an `expires` condition when it dies with an issue, `aging` otherwise.
   - `cp_memory reject` with a cause — `superseded` (merged code made it moot;
     cite it), `disproven` (it did not hold; cite it), `generalizes` (it belongs
     in AGENTS.md/docs, so make that edit), `noise` (one-off). Rejection is
     permanent: if the evidence later changes, that is a **new** observation and
     a new capture.
4. Retire what has decayed or gone false: `cp_memory retire` with a reason,
   evidence and — when you know it — `now:` naming where the knowledge lives
   instead. Nothing is deleted; it moves to `data/archive.md`.
5. Enforce the budget by retiring, not by rewriting. At 60 lines the next
   promotion is refused until something leaves.
6. Never hand-edit `data/learnings.md` to fold, reword or reinforce an entry.
   Promotion is append-only by construction; a rewrite is an operator's edit,
   and it is the one write no audit can trace.
7. `data/candidates.md` is append-only: a rejection is a journal record, never a
   deletion of somebody's note.

Reinforcement counts only when an entry was actually *used* this session, and
re-reading memory is never reinforcement. Since you cannot rewrite a line's
date, an aging entry that keeps mattering will decay and can be promoted again
from a fresh, freshly evidenced capture — which is the honest version of
reinforcement anyway.

## A bad line

If a line in the session-start digest reads wrong, it is one lookup from its
decision: `cp_memory audit <line>` gives the candidate it came from, the
evidence claimed, the date and the record id. Then `cp_memory retire` it with
that as the reason. Do not edit it away — an edited line leaves no trace, and
the whole point of the audit is that a bad promotion can be found later by
someone who was not there.

## Retrieval

- **Session start:** the parent extension loads `data/learnings.md` for you.
  Do not re-read it out of habit (a curation pass is the exception — that pass
  is exactly when you must).
- **Pre-dispatch:** `AGENTS.md` and `docs/` first; `rg -i "<repo>" data/` only
  when you need machine-local detail.

Never load `data/archive.md` wholesale. For past jobs use `cp_job list --all` / `cp_job show`.

## Report

One line per file: `unchanged` / `captured` / `promoted` / `rejected` /
`retired` / `routed-to-contract`, with counts, plus any contract edit still
owed. No file dumps in the transcript. The operator can see the same thing with
`/memory curate` and `/memory audit`; you do not need their approval, and you
should not ask for it.

## Do not

- ask the operator to approve a promotion (that gate is gone on purpose)
- promote general orchestration rules into learnings (they belong in AGENTS.md;
  reject them as `generalizes` and make the edit)
- hand-edit `data/learnings.md`, or rewrite `data/candidates.md`
- delete an entry (retiring is a move, and the archive line is written first)
- promote without evidence a later reader can check
- record a perishable entry with no named expiry condition
- commit `data/`
- write `data/` from a worker or a leased worktree
