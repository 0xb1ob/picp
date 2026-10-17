Self-review reader {{role}}: {{title}}. Schedule {{schedule}}, run {{run}}, recipe self-review v{{version}}.

Window: {{window}} (ISO-8601 UTC, to the second).
Reads (read-only, paths under the command-post home): {{sources}}
Looks for: {{focus}}

- Report only: no builds, tests, installs, git writes, or writes to live state, any repository, or ~/.pi. Read-only
  commands only.
- Document the sample: the files enumerated, counts, the selection method (all, or stratified with the rule), what was
  skipped and why.
- Each finding: symptom; evidence (path:line or transcript file + ISO time); root cause; fix (type code | prompt |
  order); effort S/M/L.
- Redact: never quote tokens, keys, cookies, auth headers or the contents of auth/models-store/daemon.json/
  dashboard.json/vapid.key — write [REDACTED].
- Bound every read: never `ls` `state/sessions` (find the files you need by glob or by the paths the job names); read
  `daemon.log`, `events.jsonl` and `model-windows.json` only through `grep` or a `read` with `offset` and `limit`, never
  whole.
- Required section "Context usage": per session, peak context tokens, the number of compactions/rotations, tokens
  before→after each, and failed compactions. Quote message `usage` fields and compaction entries from the JSONL
  (path:line + ISO time). Include a top-5 list of the largest single contributors (entry type + approximate tokens).
