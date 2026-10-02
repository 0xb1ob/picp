# Viewer App

The dashboard app serves every screen at `/`. The classic server-rendered
viewer, its boards sidebar and HTML transcript stream have been removed;
`/classic` and `/classic/` return 404. JSON APIs and published `/boards/`
artifacts remain available. This is a read-only operational viewer, never an
authority or decision endpoint. Decisions still go through the operator chat.
Its writes are a browser's own Web Push subscription (see Web Push below) and,
under `--require-tailnet`, one message into the operator's own running session
with its audit line (see Dashboard control below) — a message is exactly what
the human could type in that chat, never an authorization.

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
`state/operator/dashboard.jsonl` and a Schedules page `request` line in `state/schedule-control.jsonl`, which the
parent reads), contact a gateway, invoke policy stores, probe process
liveness or communicate with a parent or worker (dashboard control talks only to the
operator's own session, over its owner-only socket). Build failure is logged to
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
GET/HEAD-only handling (except `POST|DELETE /api/push/subscription`, `POST /api/operator/message` and `POST /api/schedules/request`) and explorer
confinement remain in force. HEAD never starts a refresh timer.

## Routes

| Entry | Destination |
| --- | --- |
| Overview / More | `#overview` / `#more` |
| Decisions | `#decisions`; `#awaiting` and `#decided` open it scrolled to its Awaiting you and Decided sections |
| Sessions | `#sessions?view=you`, `#sessions?view=you&transcript=1&session=<file-id>`, `#sessions?view=parent`, `#sessions?view=workers&id=<id>` |
| Jobs (List / Board / Map) / Job | `#jobs` / `#board` / `#map` / `#job/<safe-id>` |
| Reports / Schedules / Files | `#reports` / `#schedules` / `#files?root=<root-id>&path=<relative-path>` |
| Search | Shell dialog (f7g.7), available from every screen |
| Web Push | `/sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/api/push`, `POST\|DELETE /api/push/subscription` |
| Dashboard control | `GET /api/operator/control` (status + this session's CSRF token), `POST /api/operator/message` (only under `--require-tailnet`) |
| Schedule controls | `GET /api/schedules/control` (status + this viewer's schedule token), `POST /api/schedules/request` (only under `--require-tailnet`; journaled for the parent) |

Native `hashchange` drives routing, including Back/Forward. Empty, malformed and
unknown fragments show Overview. Legacy root session, files and dashboard hashes
resolve to the corresponding app screens; legacy git hashes open that root in
Files. The Files screen links no git view: the read-only JSON log endpoint stays,
but a raw JSON page is a dead end for a human. The classic Git UI is removed.
There is no catch-all SPA route across APIs, published boards or files. The
Mandates page is removed: Map lanes carry every grant, and `#mandates` and
`#overview/mandates` fall back to Overview like any unknown fragment.

Navigation (dashboard audit P4): the desktop sidebar has six items — Overview, Decisions (with the
awaiting badge), Jobs, Sessions, Reports, More — and the phone tab bar five: Overview, Decisions, Jobs,
Sessions, More, with Reports under More on phone only. Jobs carries a List | Board | Map toggle on all
three views, and Board and Map light the Jobs item. More holds Schedules, Files and Notifications on
both layouts. Decisions is one page (`/api/decisions`, the Awaiting asks as `items` plus the Decided log
as `decided`): the one-click Awaiting you cards on top, then "Being handled · N (oldest Xm)" — the
parent's questions the operator session is still handling, collapsed, amber past 10 minutes, and
hidden when there are none — then the Decided for you log. `/api/awaiting` and `/api/decided` stay.

The Sessions **Operator ↔ you** tier opens on the **Full transcript** (the default
for `#sessions` and `#sessions?view=you`) with no Decisions toggle, since the decision log lives on the
Decisions page; `transcript=0` still renders the recorded asks, answers, delegated decisions and sends,
and where the transcript is refused with 403 the app falls back to it silently. The Full transcript is
the operator session's own pi JSONL, entry for entry, as the CLI
shows it (user and assistant messages, collapsed thinking, tool calls hidden by default behind
one header toggle — *Show tool calls (N)*, the number still hidden, flipping to *Hide tool
calls*; the choice is remembered in `localStorage` under one key shared by every view, and a
run of consecutive calls collapses to one faint *· N tool calls ·* line that opens that run
alone. Messages, notices, system entries and ask cards are never hidden. A
result truncated behind one *show all*, `cp-bridge` messages marked `bridge`,
compaction markers, timestamps). The cp-bridge appends each `PI_SESSION_FILE` it
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
cost, and whether the system is healthy. Top to bottom: a health strip (parent alive when the pid
`parent.lock` records is still running; operator running or offline, amber with "N unanswered,
oldest Xm" once any parent question has waited 10 minutes, linking to Decisions (`#decided`); main CI per project
from `state/main-ci.json`, "red since <sha> <time>" while latched and otherwise "no red latch" —
never "green", since a missing row is no proof of green, and the viewer re-reads the file rather
than importing `src/main-ci.ts`; workers live / slots summed from active grants'
`dispatch_parallelism`; quota tightness only once a quota was observed), one line with the
watchdog's last run (Start session beside it while the operator is offline), Needs you (count plus
at most three lines, or one Nothing needs you line), Blocked & failed (dependency blocks plus every
`failed` fleet job with its failure headline in 80 chars; hidden when empty), In flight (one line
per job with its PR, a project tag once more than one project has work, and for a held job the one
fact that matters: CI red, CI running, review N/5, or CI green) and Landed today (N merged · M closed
without PR: the same total as the Board's Landed today column, which counts every lane, and the Jobs
Finished today tab's done rows; the heading carries the merged jobs' total cost — worker plus
reviewer, as the Jobs list counts it — and each row its own, capped at five rows with "N more in
Jobs →"). The shell shows the browser's local time and short zone
name in the phone header and the desktop top-right corner, updated every 15 s.

Search filters enabled entries from the current route table plus in-flight job
titles and IDs. The shell reads `/api/overview` once per opening, aborts on close
or unmount, and discards late responses. It creates no search API or extra SSE
connection; failures leave navigation available with an explicit job-data warning.
Sessions and Files are navigation shortcuts, not transcript or file-content search.
The native modal dialog supports Ctrl/Cmd+K, arrow-key selection, Enter, Escape,
and restoring focus to the opener. Its 390px maximum width and scrolling results
reuse screen 11's Search field and screen 05's menu rows because no separate search
screen was supplied.

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
with expired and revoked history behind its toggle.

Map also counts revoked grants with a recorded mission-end
close answer and a revocation timestamp today as closed today. It includes these grants
by default, still labeled revoked; older revoked and expired grants stay behind
the history toggle, which uses the browser's local calendar day.
Ordinary revocations are not completions.
Board reads the same rule: a grant revoked today by its answered mission-end close is a `closed` lane, so its finished jobs stay grouped under it.

Decided displays the recorded `basis.operator_quote` beneath an answer, never
an option ID. Newly answered escalations retain this basis; historical records
without a quote omit the line. Questions clamp to three lines, and Jobs/Board
escalation notes to two, with the full text available in their titles.

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
  carries the hint) and a round send button that does what Enter does. While the
  session is busy a ⋯ menu beside it holds `Steer now` and `Abort turn` (abort
  needs a second, confirming tap). Enter sends — after this turn while the session
  is busy, a plain send while it is idle — and Shift+Enter starts a new line
  (Ctrl/Cmd+Enter does the same as Enter; Enter never sends while an IME is
  composing). The text arrives in the
  session as a user message, literally (no slash commands or templates). The
  delivery line reads Sending, Queued, Delivered to the session, or
  `Failed: <reason>`; `Session not running` or `Dashboard control is off (…)`
  replaces the controls when they cannot work.
- **Mobile layout** (below 900 px, every Sessions view): the global header and the
  bottom nav give way to one 48 px top bar — back to Overview, a menu of every
  session (Operator ↔ you, CP parent, each worker), the view's name, the live dot,
  the ctx percent, the composer's status chip (`busy`/`idle`/`not running`, then the
  last send's state) and a ⋯ sheet with Decisions / Full transcript, the tool-call
  toggle, Search, the session file picker and the file name. Only the transcript
  scrolls; the shell follows `visualViewport` so the composer sits above the
  on-screen keyboard. Open decisions collapse to one "N decisions waiting ▾" bar
  that opens into a sheet and closes after an answer. The whole app disables zoom
  (viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover`,
  `touch-action: manipulation`, 16 px fields on mobile).
- **Decision cards** (`components/TranscriptAsk.tsx`): every operator ask sits right
  after the `cp_parent ask` call that raised it (an open ask with no call in the
  file is placed by when it was raised; the 300-entry window never drops one). One
  button per option with its consequence, the recommended one marked; a click sends
  `<ask-id>: <label>`. The card stays open until the main session records the
  answer with `ask_answer`; answered and withdrawn cards are read-only with the
  answer or reason. Without control the card falls back to Copy reply.
- Dashboard-sent messages show as `Operator (dashboard)`, tagged `dashboard`, with
  their `dc-…` id and the ask a click answered.
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
imported only by `control-api.ts`); the operator session journals what it
receives. There is no login or device allowlist: the HTTPS origin is reachable only
from the operator's tailnet devices. No `<form>` (CSP `form-action 'none'`), no
inline styles; `components/control.css` wraps long text and the action buttons at
390 px and keeps the composer at the transcript's 780 px column at 1440 px.

**Schedule controls** (cp-hhuf P6, docs/contracts.md §Schedule controls). The Schedules page reads
`GET /api/schedules/control` (`use-schedule-control.ts`, on mount, on every refresh and after each send) and shows
one status line; each card gets Disable/Enable, Run now (enabled schedules only) and Remove (a second, confirming
tap), disabled unless control is on, the parent holds the home and nothing is pending for that schedule, with the
latest request's state under them. A click is one `POST /api/schedules/request` `{op, schedule_id}` with the
`x-cp-control-token` header; the parent applies it. **Add schedule…** opens
`#sessions?view=you&transcript=1&draft=…`: the composer starts with that draft (it never reaches the API). The
buttons wrap (`.schedule-controls`, flex-wrap) at 390 px and sit in the card grid at 1440 px; long reasons wrap with
the card (`overflow-wrap: anywhere`).

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
Phone is below 900px; desktop has a 232px sidebar. Dense job tracks scroll inside
the table, not the page. More remains a centered max-width 390px column. At
900px and up Jobs is a column table (job, title, phase, model, CI, cost, time;
model and time fold into the detail line below 1200px), Job detail splits into
summary + timeline and a facts column, Reports is a card grid, and Files takes
the listing into a right column; the phone layout is unchanged. Native
progress values replace inline percentage styles under the strict CSP.

All eight unmodified WOFF2 subset binaries come from screen 00. `fonts.css`
preserves the export's unicode ranges, Instrument Sans weights 400/500/600 and
JetBrains Mono weights 400/500, with font-display swap. Matching notices are
included beside the font files, with original copyright lines:

- Instrument Sans: https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentsans/OFL.txt
- JetBrains Mono: https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt

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
