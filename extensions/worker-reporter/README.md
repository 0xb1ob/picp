# worker-reporter (WORKER extension)

Loaded **only into worker sessions**, explicitly, via `pi --mode rpc -e
<pkg>/extensions/worker-reporter/index.ts`.

It is deliberately **absent from the `pi.extensions` manifest** in
`package.json`: the parent session must never register `report_result`, and
workers must never receive dispatch tools (recursion guard). Manifest loading
would give both sides both halves.

`report_result` / `report_verdict` live here; the parent never registers them.
