# worker-reporter (WORKER extension)

Loaded **only into worker sessions**, explicitly, via `pi --mode rpc -e
<pkg>/extensions/worker-reporter/index.ts`.

It is deliberately **absent from the `pi.extensions` manifest** in
`package.json`: the parent session must never register `report_result`, and
workers must never receive dispatch tools (recursion guard). Manifest loading
would give both sides both halves.

`report_result` / `report_verdict` live here; the parent never registers them.

Worker compaction uses pi 1.0.4's `session_compact_failed` and cancellable
`session_before_compact` hooks. A provider content, safety, or Terms of Service
block records one non-context `worker-compaction-policy-block` session entry
with the error and trigger reason. Later compactions of that active branch
(including manual and overflow attempts) are cancelled before summarization.
The marker survives worker revival; a fresh session starts without it. Other
failures and aborts retain pi's normal behavior. No threshold or pi settings
change is involved.
