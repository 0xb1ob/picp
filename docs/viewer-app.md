# Viewer App

The dashboard app serves every screen at `/`. The classic server-rendered
viewer, its boards sidebar and HTML transcript stream have been removed;
`/classic` and `/classic/` return 404. JSON APIs and published `/boards/`
artifacts remain available. This is a read-only operational viewer, never an
authority or decision endpoint. Decisions still go through the operator chat.
Its writes are a browser's own Web Push subscription (see Web Push below), under `--require-tailnet`
one message into the operator's own running session with its audit line (see Dashboard control below) — a message is
exactly what the human could type in that chat, never an authorization — and an Answers acknowledgement, one `acked`
line in `state/operator/answers.jsonl` that reaches no session and no parent and is not a decision. A Settings write is
an operator-configuration change, forwarded to the operator's own session, which validates, audits and writes the owner
file; never a decision, grant or authorization.

## Build And Security

`bin/cp-view --home DIR --host 127.0.0.1 --port 8766` builds once at startup.
`npm run build:viewer -- --home DIR` uses the same builder without a listener.
Sources resolve relative to the installed package, not the operator home or
current directory. Runtime dependencies are exactly `preact` and `esbuild`;
`preact-render-to-string` is test-only. Install normally with `npm ci`, including
esbuild's platform binary. There is no Vite, development watcher, remote font,
production SSR server, frontend state package or request-time build.

The builder uses an esbuild context, a 30-second compilation deadline and
cancel/dispose cleanup. It emits hashed JS, CSS and WOFF2 only, writes temporary
files beside their final paths, and renames them into the resolved
`stateDir/viewer-dist/`. A symlinked output directory is refused. Only after all
outputs publish does the server receive an asset snapshot. Asset requests match
exact snapshot paths; normalized traversal, malformed escapes, maps and unknown
names cannot read disk. Old hashed files may remain for ordinary home cleanup.

Only this trusted startup/build command writes generated output. Requests never
write operational state (the request-time writes are a device's Web Push
subscription under `data/push/subscriptions/`, the dashboard-control audit line in
`state/operator/dashboard.jsonl`, a Schedules page `request` line in `state/schedule-control.jsonl`, which the
parent reads, an Answers `acked` line in `state/operator/answers.jsonl`, which nothing reads but the dashboard, and a thread `open`/`bind`/`done` line in `state/operator/threads.jsonl`, likewise), contact a gateway, invoke policy stores, probe process
liveness or communicate with a parent or worker (dashboard control talks only to the
operator's own session, over its owner-only socket). No viewer request writes a settings file: a Settings change is one
`settings_apply` frame to that session, which writes the owner file. Build failure is logged to
stderr and `/` returns a generic 503 without paths, stack traces or a classic
fallback. Identity, health, published boards and JSON APIs remain usable.
Recovery is reinstalling/rebuilding, not deleting state or silently using an old
bundle. `createViewer(options)` stays synchronous and accepts an optional built
snapshot for embedders/tests.

App document and assets use this exact policy:

```text
default-src 'none'; script-src 'self'; script-src-attr 'none'; worker-src 'self'; manifest-src 'self'; style-src 'self'; style-src-attr 'none'; font-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`worker-src 'self'` and `manifest-src 'self'` are the only additions Web Push
needs (the same-origin `/sw.js` and `/manifest.webmanifest`); nothing else is
loosened. The separate published-board policy still forbids scripts. Host binding,
GET/HEAD-only handling (except `POST|DELETE /api/push/subscription`, `POST /api/operator/message`, `POST /api/schedules/request`, `POST /api/answers/ack`, `POST /api/threads/done`, `POST /api/settings/apply` and `POST /api/settings/restore`) and explorer
confinement remain in force. HEAD never starts a refresh timer.

## Routes

| Entry | Destination |
| --- | --- |
| Overview / More | `#overview` / `#more` |
| Decisions | `#decisions`; `#awaiting`, `#answers` and `#decided` open it scrolled to its Awaiting you, Answers to acknowledge and Decided sections |
| Sessions | `#sessions?view=you`, `#sessions?view=you&transcript=1&session=<file-id>`, `#sessions?view=parent`, `#sessions?view=workers&id=<id>` |
| Jobs (List / Board / Map) / Job | `#jobs` / `#board` / `#map` / `#job/<safe-id>` |
| Reports / Schedules / Files / Settings | `#reports` / `#schedules` / `#files?root=<root-id>&path=<relative-path>` / `#settings` |
| Search | Shell dialog (f7g.7), available from every screen |
| Version | Shell ⋮ menu row (phone and desktop) and the Sessions top bar; `GET /api/version` |
| Web Push | `/sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/api/push`, `POST\|DELETE /api/push/subscription` |
| Dashboard control | `GET /api/operator/control` (status + this session's CSRF token), `POST /api/operator/message` and `POST /api/operator/restart` (only under `--require-tailnet`) |
| Schedule controls | `GET /api/schedules/control` (status + schedule token), `GET /api/schedules/policy?schedule_id=` (pure policy preview), `POST /api/schedules/request` (only under `--require-tailnet`; journaled for the parent) |
| Answers | `GET /api/answers/control` (status + this viewer's answer token), `POST /api/answers/ack` (only under `--require-tailnet`; appends one `acked` line, no session or parent) |
| Threads | `GET /api/threads` (list + this viewer's thread token), `POST /api/threads/done` (only under `--require-tailnet`; appends one `done` line, no session or parent) |
| Settings | `GET /api/settings`, `POST /api/settings/apply`, `POST /api/settings/restore` (only under `--require-tailnet`; forwarded to the operator session, which validates, audits and writes the owner file) |
| Stats | `#stats?range=&project=&mandate=&from=&to=` (range `1h`, `24h`, `7d` or `custom`; `from`/`to` only for custom, UTC ISO). The screen reads `GET /api/stats?range=1h\|24h\|7d\|custom&from=&to=&project=&mandate=&tz=<IANA zone>` (read-only; 400 `{error}` for a bad range; the browser's `tz` is optional) and `stats` in the `/api/stream?view=` allowlist |

**Stats API** (`src/viewer/stats-view.ts`, `stats-series.ts`; types `StatsResponse`). Default range is 24h ending at `generated_at`; `custom` needs UTC ISO `from` < `to` and at most 31 days, otherwise 400 (never clamped). Buckets are 5 minutes for 1h and epoch-aligned hours up to 48h; beyond that, local calendar days in the optional `tz` IANA zone the browser sends (`Intl.DateTimeFormat().resolvedOptions().timeZone`; DST days are 23h/25h, so use each bucket's `start`/`end`; an invalid zone is 400, no `tz` means UTC and `range.tz` says which was used); instants are UTC ISO and the client formats them in the browser zone. A job is finished when its finish time (the Jobs list's `finished_at`) is in `[from, to)`: merged = merge receipt; closed without PR = done, not merged, not failed; failed jobs are in neither. Spend = worker + reviewer `cost_usd` from run status (the fleet total when further along), including reviewer runs the Jobs list omits once no live grant covers the job, so the model rows sum to it. Token KPI = input + output; a mandate row's tokens = `total_tokens - cache_read` (the grant's token-cap basis), so the two differ. Wall clock = `finish - ledger created_at` (not `started_at`, which resets on revive); queue wait = first `spawned` - `created_at`; a job missing an endpoint is skipped for that figure, never counted as 0. Phase medians: queued, working (first spawned to first envelope, else process exit), review (reviewer-run overlap), held (envelope to finish minus review). Merge rate = merged / finished; CI green first try = first `ci_green`/`ci_failed` observation over jobs with one. Spend delta is a whole percent against an equal window ending at `from`; a prior of 0 or unknown is `null`. Decisions are delegated escalations and answered asks by `answered_at` in range; worth = recorded basis is the operator's judgement. Any unreadable or missing source is `null` plus a warning. Cost bound: status and reviewer directories are read only for jobs whose `finished_at` is in the window or its prior window, and the only scan is each finished job's `events.jsonl` (worker and reviewer runs), uncached, at most 16 MiB per file and 128 MiB per request; a file over either bound is left out of the phase, CI and hourly-token figures and named in `warnings`. No rollup and no write.

Native `hashchange` drives routing, including Back/Forward. Empty, malformed and
unknown fragments show Overview. Legacy root session, files and dashboard hashes
resolve to the corresponding app screens; legacy git hashes open that root in
Files. The Files screen links no git view: the read-only JSON log endpoint stays,
but a raw JSON page is a dead end for a human. The classic Git UI is removed.
There is no catch-all SPA route across APIs, published boards or files. The
Mandates page is removed: Map lanes carry every grant, and `#mandates` and
`#overview/mandates` fall back to Overview like any unknown fragment.

Navigation (dashboard audit P4): the desktop sidebar has eight items — Overview, Decisions (with the
awaiting badge), Jobs, Sessions, Stats, Reports, Settings, More — and the phone tab bar five: Overview, Decisions, Jobs,
Sessions, More, with Stats and Reports under More on phone only. Jobs carries a List | Board | Map toggle on all
three views, and Board and Map light the Jobs item. More holds Schedules, Files and Notifications on both layouts, and Stats, Reports and Settings on phone only. The Stats screen (`screens/Stats.tsx`) has one filter row (range segment, Project, Mandate; From/To only for Custom, and the caption of the two range instants in the browser zone, no zone suffix, then `· compared with the <window> before`), six KPI cards in this order — Jobs finished (merged · closed; null when either is unknown), Spend (vs prior period, plus **Spend includes reviewers**: worker + reviewer `cost_usd`, as Jobs shows it), Tokens (in · out), Merge rate (CI green first try is its subline), Median wall clock (queue wait), Decisions (for you · by you) — then four charts each with a quiet Table link, and the per-mandate rows with an Export CSV (client-side). Its empty state is `Nothing finished in this range`. A missing figure shows `-`, never 0. Decisions is one page (`/api/decisions`, the Awaiting asks as `items` plus the Decided log
as `decided`): the one-click Awaiting you cards on top, then "Being handled · N (oldest Xm)" — the
parent's questions the operator session is still handling, collapsed, amber past 10 minutes, and
hidden when there are none — then the Decided log, two tabs (Decided for you / Answered by you) with counts for the Today/All range, the summary on the toolbar row. Each row is four cells (time; a content stack of job link plus escalation id, the question with its job id stripped, the bold answer and the quote clamped to 2 lines, click or Enter expanding it; a basis chip; evidence on desktop). After the mission-end fold five rows show, then "N more decided for you today" reveals the rest; phone adds a basis legend. Worth a look (with its for-you count) filters only the for-you tab, and only rows whose recorded basis is the operator's own judgement. `/api/awaiting` and `/api/decided` stay.

The Sessions **Operator ↔ you** tier opens on the **Full transcript** (the default
for `#sessions` and `#sessions?view=you`) with no Decisions toggle, since the decision log lives on the
Decisions page; `transcript=0` still renders the recorded asks, answers, delegated decisions and sends,
and where the transcript is refused with 403 the app falls back to it silently. The Full transcript is
the operator session's own pi JSONL, entry for entry, as the CLI
shows it (user and assistant messages, collapsed thinking, tool calls hidden by default behind
one header toggle — *Tools N*, N the tool calls in view (its label names Show/Hide); the choice is remembered in `localStorage` under one key shared by every view, and a
run of consecutive calls collapses to one faint *· N tool calls ·* line that opens that run
alone. Messages, notices, system entries and ask cards are never hidden. A
result truncated behind one *show all*, `cp-bridge` messages marked `bridge`,
compaction markers, timestamps). A bridge notice is one line, `bridge <verb> <job> · <receipt>` (`wake` reads `woke`; underscores in a receipt become spaces), and a body of more than one line stays in a collapsed disclosure. A say line in this transcript that starts `[<project>] ` drops that prefix when `<project>` is a directory under `projects/`; the name shows as a chip, and any other bracket stays in the text. The session file picker labels each file with its date and time, marks the newest `current`, and puts the file id on the option title. From 900px the Sessions screen is two flush columns (frames 06/16): a full-height 248px list with a hairline, titled *Sessions*, whose rows are two lines (name, status dot and ctx percent; muted `model · state`, no bars) with *Fleet* holding CP parent and the workers, and a transcript that fills the rest edge to edge. The transcript heading is one 48px row (name, muted ctx percent, session picker, quiet *Tools N*, then the shell's status dot and ⋮), not sticky. The session's messages are plain text under an initials avatar and `Name · HH:MM` (the operator transcript calls you *You* and the session *Operator*); only your own messages, and a parent brief in a worker view, are right-hand accent bubbles; a collapsed run of tool calls is a dashed `▸ N tool calls · …` row. the first message keeps scroll padding so its header is never clipped. The cp-bridge appends each `PI_SESSION_FILE` it
runs under to `state/sessions/operator-sessions.jsonl` on `cp_parent start`,
`cp_parent send` and (with dashboard control on) `session_start`, so a relaunch is a new file and the older ones stay
selectable, newest first. Read-only: a recorded file that is missing or is not a
file names its path and reason in a warning, and an unknown `session` id is a
404 like an unknown worker id. The view is `/api/sessions?view=you&transcript=1`
under the same Host guard as every other route and the same refresh stream, and
only under `--require-tailnet` — the flag `bin/cp-operator` always passes: a
`bin/cp-view` started by hand without it answers that route with 403.
Message text, tool-call text and notice bodies link their URLs (`src/viewer/linkify.ts`):
`http(s)` and markdown `[label](url)` links open in a new tab with `noopener noreferrer`, any
other scheme stays text, and a bare `.pi-command-post` path links where the `paths:` block's
evidence helper resolves it (`SessionEntry.links`).

Overview is the executive landing page and answers four questions at a glance (dashboard audit P3):
what runs now and on which project, what is blocked or needs you, what landed today and what it
cost, and whether the system is healthy. Top to bottom: Needs you (count plus at most three lines, or one Nothing needs you line), a health strip (parent alive when the pid
`parent.lock` records is still running; operator running or offline, with "N unanswered,
oldest Xm" once any parent question has waited 10 minutes, linking to Decisions (`#decided`); main CI per project
from `state/main-ci.json`, "red since <sha> <time>" while latched and otherwise "no red latch" —
never "green", since a missing row is no proof of green, and the viewer re-reads the file rather
than importing `src/main-ci.ts`; workers live / slots summed from active grants'
`dispatch_parallelism`; quota tightness only once a quota was observed), one line with the
watchdog's last run (Start session beside it while the operator is offline, Restart session while it runs; one flat strip with this line at its end from 900px up, a 2×2 tile grid on a phone), Blocked & failed (dependency blocks plus every
`failed` fleet job with its failure headline in 80 chars; hidden when empty), In flight (one line
per job: the columns Job, Title, Wall clock, Context, Review, CI, Model and Cost, each clock and context a value over a 2px bar, with the hint "held = waiting on CI or review, normal for hours"; a held row leads with the one fact that matters — CI red, CI running, review N/5, or CI green — and a project tag once more than one project has work). Paused projects are `<project> · paused` pills in the title row. A blocker names that job's in-flight phase, or "no run status" instead of waiting. Needs you, when empty, links N decided today · X for you, Y by you. Landed today rows read `#<n> ↗ merged <sha7>` plus the cost (N merged · M closed without PR, the same total as the Board's Landed today column; the heading carries the merged jobs' total cost — worker plus reviewer, as its title says — capped at five rows with "N more merged in Jobs →"). Jobs filters are All / In flight / Done today, one line. Done today is newest first, grouped by project in the order of each project's newest job (`<project> · N merged · M closed without PR`, the bare cost flush right, five rows). Columns: In flight `Job, Title, Wall clock, Context, Review, CI, Model, Cost`; Done `Job, Title, Outcome, Commit, Model, Done, Cost`. The held hint sits on the In flight header, not the toolbar. A foot row holds "Show N more from <project>" and the projects with nothing done today. Finished rows have no context chip. The shell shows one time, the data's `generated_at` in the browser's own zone: on a phone, a dot + `HH:MM` inside the header on main screens (`stale · HH:MM` / `offline · HH:MM` otherwise; the full time with zone is its title) and `HH:MM <zone>` on a subpage or job page; on a desktop, the 48px header row reads `updated HH:MM` beside ⋮. There is no second clock and no fixed overlay.


**Job page** (`#job/<id>`). The phone header already has back and the id. At 900px and up, a breadcrumb `← Jobs` / the id sits above the title. Facts do not use a dash: the head is a 7-character sha with a copy button, or "no commits yet"; the PR is `#<n> ↗ <status>` (merged adds `as <sha7>` and a copy of the merge sha), or "none yet"; CI is `<state> on <sha7>` (from the CI watch, or from the last recorded CI event for this head once the watch has dropped a merged job), or "not run yet" when neither exists; review is `N / 5 · verdict`, or "not started · 0 / 5"; the model is the short name plus its provider; context is the chip, including the last compaction time, or "none"; the mandate links to `#map`, or "none"; cost is the recorded amount, or "not recorded". Fact text is 13px. The title is 17px below 900px and 22px from there up.

**Job page tabs and transcript.** Desktop opens on `Transcript | Timeline` beside the facts rail; the phone opens on `Details | Transcript | Timeline` (Details holds the facts, the JOB card from the ledger `description`, and the mandate snippet with spend/cap). Asks, questions, the failure headline, the summary (clamped to one line, `more`) and `Web report` stay above the tabs. The `Ask about this failure` action stays with Files and Run log in the facts rail (desktop, always beside the content) and the phone Details tab, where the phone opens; it is not shown on the phone Transcript or Timeline tabs. The Transcript is a read-only document (no composer, no POST) fetched from `GET /api/job/<id>/transcript`: the worker session through the same safe resolution as Sessions (inside `state/sessions`, `.jsonl`, non-script), last 300 entries, and the first Parent message kept when the window cut it. It works for done and torn-down jobs; a job with no readable session answers 200 with `warning: "No worker session recorded"`, and an unknown job id is 404.
**Version badge** (cp-kz20, `viewer-app/components/VersionBadge.tsx`): a 44 px button with a dot and a short
text — `✓` latest, `N↓` behind, `↻` a stale process, `!` alert, `?` unknown — as the Viewer row of the ⋮ menu,
labelled in that row, and in the Sessions top bar on phone (where the shell header is hidden).
Colour is never the only signal. Tapping it opens the three layers: the deployed commit and upstream (behind/ahead
origin/main and when the updater last fetched, its result and detail), each running process — viewer, parent host,
CP parent, operator session — with its state and the restart that fixes it, and this page: when its app script differs
from the server's `bundle.script` the badge is at least a warning and the panel offers **Reload page** (the browser's own
reload; no write route). The shell reads `/api/version` once on mount, every 60 s and when the tab becomes visible,
one read for every badge. Semantics: `docs/contracts.md`, *Version view*.

Amber and coral are for an open human decision (an ask or escalation still needing the operator, including the documented amber past 10 minutes) and CI that is actually red. Alarms, failed jobs, failed composer sends, context pressure, stranded dependencies, a stale live dot and version warnings stay neutral: the word carries the state. Failed composer sends use a solid neutral border, a **Failed** badge and Send again/Discard. `.overview-alarm` is one of those neutral alarms.

Search is one dialog with three groups: Go to (enabled entries from the current route
table), In flight (`<id> · <phase>`, and fleet `waiting` reads "no run status") and
Recently landed (`<id> · #<n> merged`, from the same `/api/overview` response's
`shipped_today`). The shell reads that response once per opening, aborts on close
or unmount, and discards late responses. It creates no search API or extra SSE
connection; failures leave navigation available with an explicit job-data warning.
Sessions and Files are navigation shortcuts, not transcript or file-content search.
The native modal dialog supports Ctrl/Cmd+K, arrow-key selection, Enter, Escape,
and restoring focus to the opener. At 900px and up the dialog footer reads
`↑ ↓ move · ↵ open · esc close`. The field has no border of its own; the dialog's
border is the only one. Its 390px maximum width and scrolling results reuse screen
11's Search field and screen 05's menu rows because no separate search screen was
supplied. An unknown job (`#job/<id>` answered 404) and an unknown worker session
(`#sessions?view=workers&id=<id>` answered 404) render a calm page with a back link
and a button that opens this Search, not the recorded-data alert. Any other status
stays that alert.

## Recorded Data

`/api/overview` uses plain shared interfaces in `src/viewer/api-types.ts`.
Required source availability is `ok`, `missing`, or `unavailable`; missing means
no recorded values, while corrupt/unreadable records produce sanitized warnings.
Null is unknown, not zero. An unavailable ask journal cannot say Nothing needs
you. Complete ask events are validated and folded by ID; an incomplete last
line waits for its newline. Reads are bounded to 16 MiB without partial folding.

Operator asks are separate from parent escalations; represented source
escalations are excluded from the parent-question tier. Decided-for-you counts
only `answered_by: operator-delegated`. All open asks render, not just the first.
Reply text is `<ask-id>: <option label>`, ordinary operator-chat prose, never an
executable authorization link. Copy awaits clipboard success; unavailable or
denied clipboard selects the visible reply and announces failure.

Today is the viewer host's local calendar day for server projections. Responses
carry no time zone: the browser formats every time in its own zone. Shipment requires a matching safe merge
receipt with actual `merged_at` today, a GitHub PR URL and a 40-hex merge SHA.
Close/recording time never proves shipment. Review passes must match the current
recorded head, include nontruncated evidence, and may come from a persisted
review-equivalence record. Historical/old-head passes do not become current.

Mandate spending reuses the existing dashboard's accounting, including reviewer
usage and noncached tokens. Full objectives and full revoked counts come from
all recorded grants, not the dashboard's truncated historical list. Active
counts exclude clock-expired grants. Blockers include missing IDs and dropped
closes; grant selection mirrors the latest covering active/unexpired grant,
then latest matching recorded grant. Corrupt grants or ledger suppress the
healthy stranded-dependency claim.

On Map, a display-only `closed` status means every explicitly named
job has a recorded close, and the latest close falls today on the host's calendar day.
Missing close records or broad project grants cannot imply completion. Paused and
revoked grants retain those states; no grant is mutated or authority revoked by
this projection. Map shows active, paused and closed-today grants first,
with expired and revoked history behind its toggle. Nothing is selected or dimmed until a job or mandate is picked; the aside sits beside the graph and never covers a node. A fleet phase of waiting reads "no run status".

Map also counts revoked grants with a recorded mission-end
close answer and a revocation timestamp today as closed today. It includes these grants
by default, still labeled revoked; older revoked and expired grants stay behind
the history toggle, which uses the browser's local calendar day.
Ordinary revocations are not completions.
Board reads the same rule: a grant revoked today by its answered mission-end close is a `closed` lane, so its finished jobs stay grouped under it.
Empty Board columns, Waiting included, fold to a narrow strip (the column name, written vertically, and 0) after the columns that have cards, on the phone and on the desktop. There is no separate "empty now" line, and the column hint is the heading's `title`. Landed today stays a full column while any lane, shown or not, landed a job today. The mandate filter is a `Mandate` listbox (a popover on desktop, a sheet titled `Mandate` with `Done` above the tab bar on the phone): a search field (`Filter by id or goal`), `All mandates` with its job count, `ACTIVE · N` and `OTHER` (unassigned, paused, closed and revoked lanes); each row is the mono id over a one-line goal with a right-aligned count (`N working`, `N landed` or `N jobs`) and a check on the selected row; the footer holds the `↑ ↓ ↵` hint and a toggle switch `Include N revoked mandates`, off by default and hidden at 0, that adds `hidden_mandates` (`{id, status, objective}`, the revoked grants with no lane) to Other. The selection is component state, not the hash. Cards carry one meta line, `phase · elapsed / limit · $cost` (landed: `#n · merged · HH:MM · $cost`), plus blocker tags, the failure line, the note and the ledger tag; a card says `blocks <id>` for each job that lists it as a blocker. The toolbar's right-aligned status line carries the stranded-dependency count and, while the switch is off, `N revoked mandates hidden`.

Decided shows each row's basis, computed from the recorded delegation rule only: an `ask-` id of 12 hex digits (your words, ids joined with ` · `), otherwise the word standing or a double-quoted string found verbatim in `data/standing-orders.md` (standing order; ref is that quote, or the rule cut at 80 characters), otherwise `verbatim` or any double-quoted string (your words; a `YYYY-MM-DD` in the rule is shown as `Oct 4 · “quote”`), otherwise the operator's own judgement. A missing or unreadable standing-orders file matches no quote. Answered-by-you rows are your reply, with the ask id. Worth a look is judgement only. The recorded `basis.operator_quote` still sits beneath an answer, never an option ID. Newly answered escalations retain this quote; historical records without one omit the line. Questions clamp to three lines, and Jobs/Board escalation notes to two, with the full text available in their titles.
Parent activity is recorded transcript activity, never proof of a live process. The
Overview parent chip probes the recorded lock pid: a lock a crashed parent left behind
reads `down (stale lock since <t>)`, not alive (`/doctor` names the stale lock, and the
next `session_start` reclaims it).
Context denominators and PIDs appear only when actually recorded. Workers include
idle held executions and scripts, but scripts never get model-session links.
Operator-session health is null: there is no durable source. No assumed 260K
context limit, closed-mandate state, quota reset, worth-a-look count
or predictive observations paragraph is supplied.

Quota is explicitly historical: the latest valid routing observation among the
20 latest-dispatched safe jobs, reading at most the first 256 KiB of each event
file. Cache keys include file identity, mtime and size, and the cache is bounded.
Only sanitized provider utilization/tightness and same-event nonnegative admin
capacity scores are exposed. Fleet capacity fallback is not free slots. The UI
shows the observation date/time and source job, not a current gateway claim.

## Web Push

More → **Notifications** turns Web Push on or off for this device; a push opens
Awaiting you. The parent sends (docs/contracts.md §Web Push); the viewer only
stores subscriptions and serves the worker. The control states exactly why it
cannot offer Turn on: needs the HTTPS address (with a link), add to Home Screen
first (iPhone/iPad: Share → Add to Home Screen; Turn on appears only when
`navigator.standalone` or `display-mode: standalone`), no Web Push in this
browser, not set up on this home, or blocked in browser settings. It also shows
the device count and pushes undelivered in the last 24 h from `/api/push`.

Pushes are for what only you can do (`PUSH_RULE`): an open ask card (Awaiting you), nothing else. A completed mandate
(`mission_end`), `risk_high_irreversible`, `budget_exhausted`, `merge_refused`, a merge ask and a final fix never push
directly; the main session handles them, and when one needs you it opens an ask card, which pushes. A failing or
recovered service never pushes either: the Overview `health failing: <check>` line and the `service_health` question
on Decisions show it.

- `/manifest.webmanifest`: `display: standalone`, `start_url: /#awaiting`, theme
  and background `--background`; icons at 192/512 px and a 180 px apple-touch-icon
  are drawn at request time from the Awaiting-you glyph in `--amber`
  (`src/viewer/app-manifest.ts`), no binary assets.
- `/sw.js` (`src/viewer/service-worker.ts`): shows `[project] kind` with the
  headline, no actions; a click focuses a dashboard window on `/#awaiting` or opens one.
- `POST|DELETE /api/push/subscription` (`src/viewer/push-api.ts`) requires, in
  order: push set up (`data/push/config.json`, else 409), `Origin` equal to its
  `origin` (or this bind's own `http://` origin on loopback, else 403), a
  same-origin `Sec-Fetch-Site` when sent (403), `application/json` (415), at most
  4 KiB (413), a valid subscription on the push-service allowlist (400) and at
  most 10 devices (409). Only `src/viewer/push-subscriptions.ts` writes: one 0600
  file per device under `data/push/subscriptions/`.
- The Host guard is unchanged. The HTTPS origin is a TLS proxy the operator runs
  outside this repository (for this home `https://cp.example.com`, a private
  Traefik with `passHostHeader = false`), so the viewer still sees its bind
  address as Host; the subscription route checks `Origin` against the configured
  origin (`npm run push:init -- --origin https://cp.example.com`).

## Dashboard control

**risk:high, on by default.** In Sessions → Operator ↔ you → **Full transcript**
the operator steers its own running session (docs/contracts.md §Dashboard control):

- **Composer** (`components/OperatorComposer.tsx`): one row — an auto-growing textarea
  (16,000 characters; one line, up to about five before it scrolls; the placeholder
  carries the hint, `Message #tag (Enter to send)` with a thread selected; the paperclip sits inside the field and a status line reads `Posting to #tag` / `Posting to no thread`) and a round send button that does what Enter does. While the
  session is busy a ⋯ menu beside it holds `Steer now` and `Abort turn` (abort
  needs a second, confirming tap). Enter sends — after this turn while the session
  is busy, a plain send while it is idle — and Shift+Enter starts a new line
  (Ctrl/Cmd+Enter does the same as Enter; Enter never sends while an IME is
  composing). The text arrives in the
  session as a user message, literally (no slash commands or templates). The
  delivery line remains for decision clicks and aborts; composer sends have their own queued bubbles below.
  `Session not running` or `Dashboard control is off (…)` replaces the controls when they cannot work.
- **Queued bubbles** (`components/PendingBubble.tsx`, `pending-sends.ts`): every composer send appears immediately on your side, after the newest transcript entry. Pending sends stay FIFO as responses stream above them; the existing bottom-follow and Jump to latest behavior includes them. Sending, queued and held messages use muted dashed bubbles with a **Queued · 1 of N** badge and their original send time, text and attachment chips. A delivered status keeps the bubble visible as **Delivered · waiting for transcript** until its `dashboard_id` actually appears; that render replaces the pending bubble with the real entry without a duplicate or empty interval. An inbox replay containing the held id likewise removes its pending bubble. A selected thread shows only its own pending sends (including a new tag with no transcript yet); **All** includes unthreaded sends too. State changes are announced with `aria-live=polite`.
  A failed send stays as a solid neutral-bordered bubble with a **Failed** badge, its reason, **Send again** (a new message with the original body, including attachment ids and thread, appended to the FIFO) and **Discard**. It is never removed just because another message is sent. Reload recovers accepted sends from the dashboard/inbox journals through the read-only control status `sends` projection, including failures after acceptance and expired held messages. The browser also keeps still-unseen sends and failures in `localStorage` under `cp-operator-pending-sends`, plus ids already promoted, retried or discarded so an older status cannot resurrect them. A reload during an unacknowledged POST shows an interrupted-send failure and asks you to check the transcript before retrying; it does not resend automatically. Unreadable journals produce a visible warning; unavailable browser storage warns and retains sends for this view.
  Accepted queued/injected sends settle when their target operator session ends, its recorded transcript file is missing, or their age exceeds the inbox's 24-hour TTL (exactly 24 hours remains queued). New requests record the session start and transcript path; older requests use the serving session's start time. These checks read metadata only. The bridge journals unseen sends as dropped on shutdown; the read-only projection also settles abandoned history after a crash. **No silent loss** (cp-y43c addendum 2): such a loss — and any bridge `dropped` line — projects as `failed`, with the original text and a reason that says `Not confirmed: …` (handed to the session, never seen in its transcript: check it first) or `Not sent: …` (never given to the session). The bubble offers **Send again** and **Discard**. Send again is the only way such a message is sent again: one click queues a **new** message (fresh `client_id`) with the same body, and the old id is dismissed; nothing is ever resent automatically. Only an operator's own Cancel send (or discard) removes a message without a failure.
  **Edit / Cancel send** (cp-y43c): a message the dashboard still holds (status `editable: true`: sent while the session was busy, not yet handed over) shows 44 px **Edit** and **Cancel send** buttons. Edit swaps the text for an inline textarea prefilled with the exact text; Enter or **Save** sends one `POST /api/operator/queue` `{"op":"edit","id","text"}` (session `x-cp-control-token`), Esc or **Cancel** keeps the original. **Cancel send** posts `{"op":"cancel","id"}` and the bubble goes away. The buttons disappear once the bridge hands the message over (one per settled turn, oldest first). A save or cancel that loses that race answers 409 already sent: the bubble shows the text the session received and the note "Already sent — your change was not applied…", and a stale status read never brings Edit back. While its images are being prepared for the handoff, a save or cancel answers 503 "being handed to the session" and the editor stays open with that note. Saved text is treated like a composer send: ends trimmed, inner spaces and newlines kept. Steers and decision-card clicks do not queue; a card's free-text reply does, keeping its `ask-…:` prefix. Offline-held inbox messages are not editable; after a restart they take their place in time order with held messages. A lost send stays a visible failure for 7 days after it was sent (`LOST_SEND_VISIBLE_MS`), then becomes history.
  Browser recovery validates each stored send and dismissal id individually: malformed entries are skipped with a visible warning while valid queued/failed sends and dismissal ids are retained. Unreadable JSON, denied/missing storage and failed writes also show a neutral `role=status`, `aria-live=polite` warning above the transcript. A write failure keeps sends and failures in this view and explicitly warns that browser persistence is unavailable. Recovery warnings remain visible through subsequent sends, retries, discards and transcript/status reconciliation for this view; they do not trigger automatic replay.
  Composer POSTs carry an optional shape-checked `client_id` (`dc-<timestamp>-<8 hex>`), chosen before the request. The current bridge/inbox uses it as the dashboard id so even a transcript that beats the HTTP acknowledgement replaces the sending bubble directly. Send again chooses a fresh id. It is correlation, not automatic retry or an authorization field; old clients without it still receive a server id. A running older bridge may ignore it until the session restarts.
  Shared attachment interface: `ControlMessageBody` in `src/viewer/api-types.ts` is the message arm of the server's body and viewer `ControlBody`; `PendingSend.body` retains that entire body for retry. Chips, browser persistence and journal projection preserve both `images` and `files` id lists, including mixed sends from the text attachment flow below. Queued bubbles add no upload or file-delivery capability. The pending styles inherit the existing light/dark tokens and the bubble widths (100% on a phone, `min(760px, 100%)` from 900 px); controls stay 44 px and long text and ids wrap at 390 px and 1440 px.
- **Image attachments** (cp-br81; docs/contracts.md §Image attachments): a 44 px
  paperclip before the textarea (only when the status says `images: true`, i.e. the
  session's bridge takes them) opens a hidden `<input type=file multiple
  accept=image/*>`; pasting image files into the textarea attaches them too (a paste
  that also carries text keeps the text). Each file uploads at once, one at a time,
  with `POST /api/operator/upload` (raw bytes, `x-cp-control-token`) and shows as a
  62 px thumbnail from `/api/operator/uploads/<id>` (same origin, so `img-src 'self'`
  holds) with a 44 px-target × to remove it. The composer refuses before uploading
  HEIC/HEIF, a type that is not PNG/JPEG/WebP/GIF, a file over 10 MiB and a 9th image,
  and shows the reason (or the server's) on the failed tile. Send needs text or at
  least one image, no tile still uploading and no failed tile; the send body carries
  `images: [id…]` and the tiles clear. Styles: `.operator-composer-attach*`,
  `.operator-composer-thumb*` in `components/control.css` (wrapping row at 390 px).
- **Sent images** (cp-br81 PR2): a dashboard message whose marker lists `images=`
  carries `images` (`SessionEntry`), and its operator bubble shows each as a 96 px
  `object-fit: cover` thumbnail from `/api/operator/uploads/<id>` under the text
  (`components/TranscriptImages.tsx`; tiles wrap at 390 px). A tap opens one at the
  bubble's width (at most 70vh tall), a second tap closes it. A file the route
  answers 404 for (the 7-day sweep, a cleaned `/tmp`) swaps its tile for the text
  "image expired". Styles: `.session-image*` in `screens/sessions.css`.
- **Text attachments** (cp-chat-text-uploads-idox; docs/contracts.md §Image attachments): `.txt`, `.md`, `.html` and
  `.json` join images in the native multiple-file picker when the running bridge advertises `files: true`; drop and
  paste use the same upload flow. Text files show removable filename/size chips with 44 px targets. The server validates
  strict UTF-8/no NUL, JSON syntax and a 4 MiB cap. `files: [id…]` sends alongside `images`, with 8 attachments total.
  Sent chips (`components/TranscriptFiles.tsx`, `SessionEntry.files` and `file_metadata`) link to a plain-text view;
  HTML is always literal text. Long chip names wrap within the composer/bubble at 390 px and 1440 px.
- **Mobile layout** (below 900 px, every Sessions view): the global header and the
  bottom nav give way to one 48 px top bar — back to Overview, a menu of every
  session (Operator ↔ you, CP parent, each worker), the view's name, the live dot,
  the ctx percent, the composer's status chip (`busy`/`idle`/`not running`, then the
  last send's state) and a ⋯ sheet with Decisions / Full transcript, the tool-call
  toggle, Search, the session file picker and the file name. Only the transcript
  scrolls; the shell follows `visualViewport` so the composer sits above the
  on-screen keyboard. The whole app disables zoom
  (viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover`,
  `touch-action: manipulation`, 16 px fields on mobile).
- **Pinned decisions** (cp-6kt6; every width): open asks sit above the composer as one
  "N decisions waiting ▾" bar (`aria-expanded`) that opens into a sheet of the full cards
  (45vh, 60dvh below 900 px, scrolling inside) and closes after an answer. The open/collapsed
  choice is remembered per browser (`localStorage` `cp-sessions-pinned-open`; collapsed by
  default); the bar opens by itself only when an ask id it has not shown before appears
  (`cp-sessions-pinned-seen`), never because the count alone changed. A storage that refuses
  the write warns and the choice holds for the view.
- **Decision cards** (`components/TranscriptAsk.tsx`): every operator ask sits right
  after the `cp_parent ask` call that raised it (an open ask with no call in the
  file is placed by when it was raised; the 300-entry window never drops one). One
  button per option with its consequence, the recommended one marked; a click sends
  `<ask-id>: <label>`. The card stays open until the main session records the
  answer with `ask_answer`; answered and withdrawn cards are read-only with the
  answer or reason. Without control the card falls back to Copy reply.
- Dashboard-sent messages show as `Operator (dashboard)`, tagged `dashboard`, with
  their `dc-…` id and the ask a click answered.
- **Restart session** (cp-aqxl; `components/RestartSession.tsx`, `use-restart.ts`,
  `restart-control.ts`; docs/contracts.md §Dashboard control): the last row of the shell's
  **⋮ More actions** menu (`components/MoreMenu.tsx`). The menu is always there — after Search on the phone header, and at the right end of the desktop page header row (`components/PageHeader.tsx`) — with Refresh now (reloads, and shows the last updated time), Copy link to this view, Notifications (the push phase, linking to `#more` where the toggle stays) and Viewer (the version badge). Restart session
  is shown only when the operator control view is available **and a session runs**, or while its own restart is under way
  (a dot on the button while a restart runs or the version level is alert; the status line stays inside the menu); Esc or a tap outside closes the menu, and a half-made confirm with it. The same Restart row is in
  the ⋯ sheet on the mobile Sessions top bar, which replaces the shell header — never inline in the composer or the Overview.
  Offline, Start session / Resume last session own that space. Two taps: `Restart session` opens the
  confirm, `Tap again to restart · resumes <session file>` sends (`Cancel` backs out), so a stray tap
  never stops the session. The button is disabled, with the reason as its title and on the line
  beside it, when the status carries no `restart` field ("reload the
  page"), when the session cannot restart (`restart.supported` false: not started by a relaunching
  `cp-operator` — restart it once by hand: `/quit`, then `cp-operator -c` — or its bridge predates the
  feature), or while it must wait (`not now: <blockers>`: busy, queued messages, an unseen dashboard
  message or answer click, a pending `cp_parent send`). One `POST /api/operator/restart`
  `{"restart": true}` with the `x-cp-control-token` header; then the status every 2 s for up to 90 s.
  The line reads `Restarting…` (the POST), `Stopping the session…` (the same session still serves:
  same `session_started_at`), `Relaunching · resumes <file>` (no session serves), `Operator session
  restarted · <file>` (a new session serves), `Refused: <reason>` (a 4xx: the viewer's or the
  bridge's) or `Failed: <reason>` (a 5xx, the network, or no session back within 90 s, with where to
  look: the `cp-operator` herdr workspace or `tmux attach -t cp-operator`, or Resume last session);
  Refused/Failed is `role="alert"`. The composer is held from the POST until a final state. The page
  only posts and reads: it spawns, signals and locates no process. `.operator-restart*` in
  `components/control.css` wraps the button and the line (`overflow-wrap: anywhere`, `max-width:
  100%`) at 390 px; `.more-menu*` in `styles/shell.css` sizes the ⋮ button (44 px) and a popover that stays
  inside the viewport (`max-width: calc(100vw - 16px)`, theme tokens for light and dark), stacking the
  button and the line in one column. The shell owns one `useControl` for the menu (`ShellContext.control`);
  the transcript composer stays held while that restart runs.
- `use-control.ts` (route-level, in `app.tsx`) reads `/api/operator/control` on
  mount and on every refresh of the transcript, and sends with the
  `x-cp-control-token` header; `control.ts` holds the fetch and the one-line texts.

The POST route is refused unless the viewer runs under `--require-tailnet`; then it
checks, in order: 20 requests per 60 s and one in flight per client address, the
opt-out (`data/dashboard-control.json` `{"enabled": false}`), `Origin` (the origin
`/api/push` reports), `Sec-Fetch-Site`, JSON, ≤ 20 KiB, the body, the session's
record, its CSRF token, and the socket. Every refusal after the
`--require-tailnet` guard appends one `refused` line to
`state/operator/dashboard.jsonl` (`src/viewer/control-audit.ts`, append-only,
imported only by `control-api.ts`, the image upload route `operator-upload-api.ts` and the thread done route `threads-api.ts`); the operator session journals what it
receives. There is no login or device allowlist: the HTTPS origin is reachable only
from the operator's tailnet devices. No `<form>` (CSP `form-action 'none'`), no
inline styles; `components/control.css` wraps long text and the action buttons at
390 px and lets the composer, the pinned decisions and the plain session messages run the transcript pane's full width at 1440 px (frames 06/16, main addendum ps-20261009102407-b9a45251); only your own right-hand bubbles stay capped at `min(760px, 100%)`.

P3a server controls also accept `save_policy`, `adopt`, `deactivate`, expected `revision`, a validated draft `policy`
and optional `client_id` correlation. Activated Run now requires its current revision. The policy route returns saved,
legacy and effective policy with blocking reasons; saves preserve frozen open runs. The P3b UI (below) drives them.

**Schedule controls** (cp-hhuf P6, docs/contracts.md §Schedule controls). The Schedules page reads
`GET /api/schedules/control` (`use-schedule-control.ts`, on mount, on every refresh and after each send) and shows
one status line; each card gets Run now (a filled primary button, enabled schedules only), then Disable/Enable, then Remove…
(a second, confirming tap; the confirm text stays "Tap again to remove"), disabled unless control is on, the parent holds the home and nothing is pending for that schedule, with the
latest request's state under them. A click is one `POST /api/schedules/request` `{op, schedule_id}` with the
`x-cp-control-token` header; the parent applies it. **+ Add** opens
`#sessions?view=you&transcript=1&draft=…`: the composer starts with that draft (it never reaches the API). The long note on how schedules run sits in a `<details>` ("How schedules run"). The
buttons wrap (`.schedule-controls`, flex-wrap) at 390 px and sit in the card grid at 1440 px; long reasons wrap with
the card (`overflow-wrap: anywhere`). Chrome (S10, frames 09/19): the card heading shows an enabled/disabled pill (dot plus word, green dot only when enabled); below 900 px `+ Add` sits right-aligned on the title row, the Schedules/Files tabs stay as a compact row under it, the card shows a `title · trigger · mandate` identity line instead of the result sentence and facts, the aside becomes a closed "How schedules run" `<details>`, and the controls sit in a two-column grid (Run now/Disable) with Remove centered below.
Run history groups jobs by run (`src/viewer/schedule-run-groups.ts`): one anchor job (a fire or Run now) and the jobs it fanned out to are one run, the five newest runs show, "Last fire" shows the newest run, and a job no run claims sits under "Unattributed jobs". A done Run now reads "Run accepted · <job>" (acceptance, not completion). Display only: no authority, schedule or journal write.

**Schedules body (P3b)** (`screens/Schedules.tsx`, `screens/ScheduleEditor.tsx`, `use-schedule-control.ts`). Each card adds a one-line policy summary ("Up to 3 reviewers, 3 at once, plus a report board; $X/run; model …", "1 at a time" when concurrency is 1, never more than the child-job cap allows), a readiness line from `GET /api/schedules/policy` ("Ready" or "Blocked: …"; an unreadable policy is never Ready) and **Last 3 runs** (anchor, trigger, time, open/closed job counts, result link; "closed" means every job closed, not that the run succeeded). An open durable run adds stage, child jobs admitted against the cap, the saved USD/token limits and the deadline (spend is not in the projection, so none is shown). Run now sends the active policy `revision` (a stale one is refused: "Schedule changed; review updated settings") and becomes **View active run** while a run is open; **Edit settings**, **Adopt saved settings** (legacy schedules) and **Back to per-fire grants** sit below the controls, so the two-column grid is unchanged. The editor is plain inputs, no `<form>`: USD, tokens, child jobs, parallelism and run hours, model policy (routing default or pinned by role), per-field errors (client `schedulePolicyErrors`, then the server's), read-only inherited ceilings and org-review config; Save sends one `save_policy` with the latest saved revision. Request lines: `Request queued · <op> · <id>`, `Starting run…`, `Run accepted · <job> · view run` (accepted, not completed), the server's `Settings saved · revision N (applies to the next run)`, `Back on per-fire grants`. Every send carries a `client_id` and is never retried or resent; the ids of accepted requests persist in `localStorage` `cp-schedule-receipts` (ids only). Layout holds at 390 px and 1440 px (44 px targets, `overflow-wrap: anywhere`, no inline style).

**Answers to acknowledge** (cp-mxk4, docs/contracts.md §Answers to acknowledge). `screens/Answers.tsx` renders
`answers` from `/api/decisions` as a section between Awaiting you and Being handled (`#answers`); it is absent while no
journal exists. A row is the `[project]` tag, the time, the job and `read` links, the question (3-line clamp, the whole text
as its title), the short answer, the **Full answer** expander (`white-space: pre-wrap`; only `http(s)` URLs and resolved
local paths become links), the evidence list and a 44 px **✓ Acknowledge** button. The tick is one `POST /api/answers/ack`
`{id}` with the `x-cp-control-token` header (`answers-control.ts`, `use-answers-control.ts`); the row hides at once and
moves to the collapsed **Acknowledged · N** history (read-only). Disabled, with the reason line, unless control is on. It
sends nothing to the operator session or the parent and never pushes. `screens/answers.css` uses only palette tokens
(light and dark), no inline styles; rows wrap and long text breaks (`overflow-wrap: anywhere`) at 390 px and sit in the
page column at 1440 px.

**Threads** (cp-xmw2, docs/contracts.md §Operator threads). In Sessions → Operator ↔ you → **Full transcript** the operator
sorts the one chat into threads: views of one session, never separate contexts, and no model call. `use-threads.ts` reads
`GET /api/threads` (`threads.ts`) on mount, on every refresh and after each Mark done. One selection, a thread **tag**,
is kept in `localStorage` `cp-thread` (absent is **All messages**; a storage that refuses the write warns and the choice holds for
the view). It drives everything at once: the transcript filter (`visibleEntries`: the entries filed under that thread, plus a `shared` one — a bridge relay, a system entry, the inbox replay — only between that thread's first and last own entry; **All messages** shows everything), the chips, the
sidebar and the composer picker. A tag with no thread yet shows no entries and `No messages in <tag> yet`; its first send creates it. A thread with no own entries shows none either. The pinned "N decisions waiting" section is never filtered. Below 900 px a `<nav
class="session-threads" aria-label="Threads">` filter line sits directly under the top bar: **All messages**, then each thread not
done, its label the tag plus a waiting badge (`· 2`, open asks plus unacknowledged answers, spelled out in its
`aria-label`), `aria-pressed` on the selected one, then **Mark done** for it (on the phone it ends the filter line; on desktop it is quiet text on the selected row); 44 px chips, the row scrolls sideways and
is `display: none` at 900 px and up. There the sidebar gets a **Threads** section under Operator ↔ you (only in the Full
transcript): **All messages** first, a row per open or waiting thread, done threads in a collapsed `Done (n)`. **Mark done** (`POST
/api/threads/done {id}` with the thread token, `x-cp-control-token`) is disabled, with the reason as its title, while the
thread waits, while control is off and while asks or answers are unreadable; a refusal is an alert (`Not done: …`), a
success goes back to **All** (a later send or bind reopens the thread). The composer's **Thread** select (`ThreadPicker`
in `components/ThreadNav.tsx`, above the text row) offers No thread, each open or waiting tag and a `Done` group. **`+ New`** (the last phone chip) / **`+`** (the sidebar's Threads heading) opens `components/NewThreadDialog.tsx`: a centred 12px-radius dialog at 900 px and up, a bottom sheet below, with a name field (`#` adornment, the tag rule as its hint: a leading `#` is stripped client-side, the server still refuses `#tag`), an optional first message and Cancel (desktop) / Create (44 px targets, 16 px fields). Nothing is requested until Create; Create selects the tag and, only with non-empty text, sends it once as the usual `POST /api/operator/message` (`POST /api/threads/done` is unchanged); Esc, the scrim and × close without selecting. While a thread is selected, entries before its first and after its last own entry are not dropped but collapsed as `Show N earlier` / `Show N later` buttons (`threadBands`). A thread's row/chip adds a neutral `· N working` badge (`counts.jobs_working`: its job refs that are live workers; `null` and 0 show nothing). The tag is normalized the server's way (trim, lowercase,
spaces to `-`). A send with a tag carries `thread` in the
`POST /api/operator/message` body; its normalized tag reaches the session's footer marker as `; thread=<tag>`.
The session passes that tag on its answer/ask and files jobs it creates with `cp_parent thread_bind`; bound job
bridge notices open a turn in that thread. Unbound notices, compactions and the aggregate inbox replay stay shared.
A bind the server could not write still delivers, and the delivery line adds `· thread not recorded: <error>` as an
alert (shown on the phone too). The picker and chips are hidden while `/api/threads` is forbidden or unreadable, and the
sidebar section says `Threads unavailable: <reason>`. Styles: `.session-thread*` in `screens/sessions.css`, `.operator-composer-thread` in `components/control.css`
(44 px controls, 16 px fields below 900 px, palette tokens only, no inline styles); tags render as text, long ones
ellipsize in their chip at 390 px and in the 300 px sidebar at 1440 px.

**Settings** (cp-settings-minimal, docs/contracts.md §Settings writes; `screens/Settings.tsx`,
`use-settings-control.ts`, `settings-control.ts`). `#settings`, in the desktop rail and under More on phone, has exactly three sections, each with its own
**Save** and **Restore defaults** (a `confirm()` first) in each rounded hairline card's footer (≤1000 px wide), with `{n} unsaved change(s)` beside them (for Model routing, changed rubric rows; an edited row gets an accent left bar and tint): **Model routing** (one row per `data/routing.json` rubric entry,
a desktop header row `Rule · Model · Fallbacks, in order · Thinking`: the mono id and `role · scope · risk:<level> · project` meta, a compact model select, fallbacks as inline mono chips with × that wrap only when needed, ending in a dashed `+ Add fallback` chip (still a native select; ×/chip hold the same 4-fallback cap),
and a thinking select whose
blank is the profile default; with no `routing.json`, one line "No data/routing.json: workers use each profile's own
model." and no controls), **Parent and operator models** (`data/parent.json` / `data/operator.json` `model`, each with
its source; empty unsets it) and **Grant defaults** (the `grants.*` fields from the catalog). It reads `GET /api/settings`
on mount and after each write; a write is one `POST /api/settings/apply` (only the drafted keys) or `/restore` with
`If-Match` and the operator session's `x-cp-control-token` from `/api/operator/control`. A 412 swaps in the fresh
snapshot and keeps the drafts ("Changed on disk"), a 400 lists its errors, and every control is disabled with the reason
when the response is not `writable`. The last five audit lines sit at the foot. `screens/settings.css`: one column at
390 px with 44 px controls (fallback chip selects and × have 44 px hit areas below 900 px) and `overflow-wrap: anywhere`; from 900 px the rubric columns are 200 px Rule / 250 px Model / flexible fallbacks / 110 px Thinking. Screenshots:
`docs/tui-verification/settings-minimal.md`.

Model pickers: `GET /api/settings` also carries `available_models` (`provider/id`, from `pi --no-extensions --list-models` through
the cp-install parser, `src/viewer/model-list.ts`; cached 5 minutes, a failure 30 seconds) or `null` with `models_error`. The read never
waits for pi: it answers with the cached list (stale included) or `models_loading: true` while one deduplicated background run fills it,
and the page asks again after 2 seconds until the list lands. Every
model field is a `<select>` (cp-lol1): the rubric row model, one dropdown per fallback (each with a × to remove it, plus an "Add
fallback…" dropdown that appends, up to 4), the parent and the operator model. Options are one `<optgroup>` per provider, alphabetical
within each; parent and operator start with "(unset)" (empty is unset), rubric models have none. A current value not in the list stays
selected as "<id> (not in pi's list)" with the inline "Not in pi's model list" warning, and still saves; the last option, "Custom…",
reveals a text input for any id. While the list loads or is unavailable each dropdown holds only the current value and "Custom…", and the
page says "Loading the model list…" or "Model list unavailable". Screenshots: `docs/tui-verification/settings-model-dropdown.md`.

## Live Data

`/api/stream?view=overview` is an explicit read-only refresh clock: immediate
named `refresh`, then every two seconds, retry 2000. It is not exact file-change
notification and has no replay IDs. Backpressure suspends writes until drain;
close/error clear the interval once. Unknown views fail closed. The old `?id=`
HTML transcript stream returns 404; Sessions refetches its JSON projection.

Overview and More own one shared resource. GETs coalesce to at most one trailing
request; generation checks and aborts reject obsolete responses. Hidden tabs
close/abort and visibility return reconnects/refetches. Live requires an open
stream and a successful GET within five seconds; a one-shot freshness deadline
marks delayed reads stale without adding a polling loop. Failed reads retain
last data visibly stale. Listeners, aborts and timers are cleaned up on unmount.

## Design And Fonts

Ported from the supplied design export screens `00-28bafde0-overview`,
`05-446eb237-more`, and `11-34217bd9-overview-desktop`. The design export runtime
and sample-data scripts are not shipped. The approved foundation amendments reserved
Search for f7g.7, use the design's exact SVG paths in `components/icons.tsx`, and omit
Playwright entirely. Search now uses those same icons; no icon package was added.

Palette literals live only in `styles/tokens.css`; `tests/viewer-palette.test.ts`
has an independently evidenced fixed palette and rejects functional-color and
inline-style bypasses. All type sizes are fixed; letter spacing is zero.
Phone is below 900px; desktop has a 208px sidebar. Dense job tracks scroll inside
the table, not the page. More remains a centered max-width 390px column. At
900px and up Jobs is a column table (job, title, phase, model, CI, cost, time;
model and time fold into the detail line below 1200px), Job detail splits into
summary + timeline and a facts column, Reports is a card grid, and Files takes
the listing into a right column; the phone layout is unchanged. Native
progress values replace inline percentage styles under the strict CSP.

Type uses the system font stacks from doc 00 (`--font-sans`, `--font-mono` in `tokens.css`); no font files ship.

## Conventions For Following Beads

- Browser code is `viewer-app/`: PascalCase props-only screens/components,
  per-screen CSS beside screens, global tokens/fonts/shell under `styles/`.
  Source/CSS/build-script files stay below the 800-line cap.
- Use prefixed classes and existing tokens/design declarations, no inline
  styles, new palette literals or remote resources. Cite the design when
  extending the palette.
- Shared API types have no runtime imports. Add one read-only projection and
  endpoint per new screen, with explicit missing/unavailable states.
- A route-level hook owns fetching; children receive props. Register future
  view SSE names explicitly when their endpoints land; no per-card connections.
- The route table owns navigation destinations. Keep deep links inside the app
  and preserve external links.
- Add fixture projection and real esbuild/Preact render smoke tests per screen.
  Browser verification needs no committed browser dependency; the ordinary
  suite uses HTTP, CSP, asset-build, controller and render checks.
