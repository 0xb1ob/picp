---
name: cp-self-review
description: >-
  Command post self-review recipe: expands a parent-expanded manual schedule
  fire (deferred anchor) into six read-only reader jobs and one synthesis job
  over the last N hours (default 36). Use only on a cp-schedule wake that names
  a parent-expanded run of this skill. Parent session only.
---

# cp-self-review

## When

Only on a `cp-schedule` wake that names a parent-expanded run (an anchor job, a schedule id and this skill), or on the
restart re-wake of the same anchor. Never on your own initiative, never for unlabelled review jobs, never a second
expansion of a closed anchor. This skill grants nothing: the schedule's grant is the only authority, and every dispatch
below is still gated by `cp_dispatch` (mandate, job cap, parallelism, risk).

## Window

`end` = the anchor's `created_at`; `start` = `end` − N hours. N = 36 unless the anchor's description has a line
`window_hours: <1-168>`. The L3-L5 slices are thirds of the window: `[start, start+N/3)`, `[start+N/3, start+2N/3)`,
`[start+2N/3, end]`. Write every instant as ISO-8601 UTC to the second.

## Jobs

Each is `cp_job create` with project = the anchor's project, kind `research`, delivery `local`, labels
`["schedule:<id>"]` (the schedule id from the wake) and the title suffixed ` [<anchor-id>]`. A re-expansion returns the
existing ids (create dedupes on project + title).

| Job | Title | Reads (read-only) | Looks for |
|---|---|---|---|
| L1 | Review parent session errors | `state/sessions/cp-parent*.jsonl` | protocol errors, self-resolved gates, wrong relays, long turns, duplicate relays |
| L2 | Review main-session delivery and operator asks | operator session files listed in `state/sessions/operator-sessions.jsonl` (pi session dir for the home cwd), `state/operator/dashboard.jsonl`, `state/operator/asks.jsonl` | missed or late messages, chat-only questions, hung turns, wrong delegations |
| L3-L5 | Review worker session failures, slice 1/2/3 | `state/sessions/<iso>_<uuid>.jsonl` worker transcripts in the slice, `state/runs/<id>/` | tool errors, waste, CI, treehouse, wrong repo (including bare `br`), rebase, caps, cost outliers |
| L6 | Review daemon health and delivery failures | `state/daemon.log`, `daemon.prev.log`, `escalations.json`, `wakeups.json`, `answered.json`, `update.json` (+ `update-before-reset-*.json`), `health.json`, `runs/*/events.jsonl` | updater rollbacks, missing alerts, stale held rows |
| S1 | Synthesize self-review against current work | the six L reports; the dedupe sources below | merge, prioritize, classify |

## Order

1. Create L1-L6, then S1.
2. `cp_job dep_add` S1 ← each of L1-L6.
3. `cp_job comment <anchor> "expanded: L1 <id>, …, L6 <id>, S1 <id>"`.
4. `cp_dispatch` each of L1-L6 with `model: "xai/grok-4.7"`, `thinking: "xhigh"`, `wall_clock_seconds: 10800` and the
   reader task below (window or slice, sources, focus).
5. When `cp_next` offers S1, dispatch it with the same three overrides and the S1 task below.
6. Tear each job down on its envelope as usual.
7. After S1's teardown, `cp_job close <anchor> reason "researched: synthesis <S1-id>"`.

A model or thinking refusal is relayed, never substituted. Failures follow the ordinary contract (bounded recovery,
`cp_revive`, the dropped-dependency question). Do not re-run a reader on your own.

## Reader task template (L1-L6)

The window or slice, the sources and the focus from the table. Then:

- "Report only: no builds, tests, installs, git writes, or writes to live state, any repository, or ~/.pi. Read-only
  commands only."
- "Document the sample: the files enumerated, counts, the selection method (all, or stratified with the rule), what was
  skipped and why."
- "Each finding: symptom; evidence (path:line or transcript file + ISO time); root cause; fix (type code | prompt |
  order); effort S/M/L."
- "Redact: never quote tokens, keys, cookies, auth headers or the contents of auth/models-store/daemon.json/
  dashboard.json/vapid.key — write [REDACTED]."

## S1 task template

Merge the six reports (`cp_artifact get` is the parent's; S1 reads `state/artifacts/<L-id>/report.md` directly).
Prioritize NEW first. Classify each finding:

- NEW;
- ALREADY COVERED, naming the job id or PR URL;
- PARTIALLY COVERED, naming what is missing.

Dedupe against (all read-only): active and paused mandates (`state/mandates/*.json`), open PRs
(`gh pr list --state open --json number,title,url,headRefName` in the project's canonical clone), beads
(`br --db <absolute beads.db> list --json`, never bare `br`), `data/learnings.md`, and non-closed ledger jobs
(`jobs.json`). Respect the current statuses over any older list. Keep the finding shape, the redaction, the report-only
and the no-builds rules.

## Do not

- dispatch the anchor;
- create `schedule:` jobs outside an expansion;
- change the model or effort;
- read an artifact body yourself (hand S1 the paths);
- relay bodies.
