# Ledger rows: cp-boards-public-url-reports-ajun

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/boards-public-links.test.ts` | cp-boards-public-url-reports-ajun | new e2e through a real `bin/cp-view`: `/api/reports`, `/api/schedules` `board_href` and `/api/decisions` evidence `read` are relative with `boards_public_url` unset or invalid and absolute on it (with and without a trailing slash) after a Settings write, no restart; the decision read link opens a new tab; no conversion owner, no exception or deletion credit claimed |
<!-- /manifest:incoming -->
