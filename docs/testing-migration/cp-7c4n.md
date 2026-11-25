# Ledger rows: cp-7c4n

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/boards-settings.test.ts` | cp-7c4n | new e2e for Settings → Boards through a real `bin/cp-view` and the session's real settings ports: the boards keys read from both files, exact-key writes in cp-install's text, clear = off, five named refusals with no write, the live listener move with the same dashboard pid, settings routes 404 on the new boards port; no conversion owner, no exception or deletion credit claimed |
| `tests/e2e/boards-settings-flat.test.ts` | cp-7c4n | new e2e for Settings → Boards on a flat home (its own runtime root): the session's `<home>/data/daemon.json` is the file the viewer reloads; its own process because `configureLayout` is process-global; no conversion owner, no exception or deletion credit claimed |
<!-- /manifest:incoming -->
