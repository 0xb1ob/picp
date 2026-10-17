Self-review synthesis S1 ({{s1}}). Schedule {{schedule}}, run {{run}}, recipe self-review v{{version}}.
Project {{project}}. Window: {{start}} to {{end}} (ISO-8601 UTC).

Merge the six reader reports; read each directly (paths under the command-post home):
{{readers}}

Prioritize NEW first. Classify each finding:

- NEW;
- ALREADY COVERED, naming the job id or PR URL;
- PARTIALLY COVERED, naming what is missing.

Dedupe against (all read-only): active and paused mandates (`state/mandates/*.json`), open PRs
(`gh pr list --state open --json number,title,url,headRefName` in the project's canonical clone), beads
(`br --db <absolute beads.db> list --json`, never bare `br`), `data/learnings.md`, and non-closed ledger jobs
(`jobs.json`). Respect the current statuses over any older list. Keep the finding shape, the redaction, the report-only
and the no-builds rules: no builds, tests, installs, git writes, or writes to live state, any repository, or ~/.pi.

Add a "Context & compaction" section: fleet-wide totals, the worst sessions, the cost attributable to re-sending large
context, and concrete fixes (e.g. trimming relay bodies, tool-output caps, compaction threshold or rotate policy),
classified NEW/COVERED as usual.

Deliver as a board (delivery `board`; the brief's board rules apply), in `state/artifacts/{{s1}}/`:

- `board.json` — `title` ("Self-review {{start}}–{{end}}"), `description` (window and one-line headline), `job_ids`
  ({{job_ids}}), `created_at` (ISO-8601 UTC). Its path is your `artifact_path`.
- `report.md` — the full synthesis above.
- `site/index.html` — the static web report: no scripts, inline `<style>` or `/boards/board.css`; the window, the
  prioritized findings (NEW first) and the "Context & compaction" section; six reader links, one per reader, each its
  job id, title, a link to `/#job/<L-id>` and its artifact path `state/artifacts/<L-id>/report.md`; and the S1 artifact
  path. The served URL is `/boards/{{s1}}/` once intake publishes it. Same redaction as the reports: no secret reaches
  the page.
