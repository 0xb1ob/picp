/** cp-dashboard-operator-control, the UI: decision cards, the composer and its client (plan T5). SSR via preact-render-to-string. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { AwaitingDetail, ControlStatusResponse, SessionEntry } from "../src/viewer/api-types.ts";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { type ControlView, controlChip, controlLine, deliveryLine, sendControl, startOperator } from "../viewer-app/control.ts";
import { overview } from "../src/viewer/overview-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const status = (over: Partial<ControlStatusResponse>): ControlStatusResponse => ({ generated_at: "2026-09-27T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, ...over });
const view = (s: ControlStatusResponse, delivery: ControlView["delivery"] = null): ControlView => ({ status: s, delivery, send: () => {} });
const base = { name: null, send_id: null, failed: false, trace: [] };
const ask = (id: string, state: "open" | "answered" | "withdrawn", extra: object = {}): SessionEntry => ({
	...base, id: `ask-card-${id}`, at: "2026-09-27T08:20:00Z", kind: "ask", who: "Operator → you", text: `Question ${id}`, tag: state === "open" ? "awaiting you" : state, ask_id: id,
	ask: { id, question: `Question ${id}`, recommendation: "Keep", state, answer: null, answered_at: null, reason: null, options: [{ label: "Keep", consequence: "Paused until Monday", reply: `${id}: Keep` }, { label: "Raise", consequence: "Spends more", reply: `${id}: Raise` }], ...extra },
});
const card = (html: string, state: string) => new RegExp(`<div class="session-ask session-ask-${state}">(.*?)</div>`).exec(html)?.[1] ?? "";
const detail = (id: string, extra: Partial<AwaitingDetail> = {}): AwaitingDetail => ({
	id, project: "demo", question: `Question ${id}`, created_at: "2026-09-27T08:20:00Z", recommendation: "Keep", source_escalation: null, job_ids: [], context: null, evidence_paths: [],
	options: [{ label: "Keep", consequence: "Paused until Monday", reply: `${id}: Keep` }, { label: "Raise", consequence: "Spends more", reply: `${id}: Raise` }],
	reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null, mandate_objective: null, jobs: [], escalation: null, evidence: [], ...extra,
});
const pinned = (html: string) => /<section class="session-pinned"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

test("cards and composer: open asks pinned above the composer with a button per option; inline history is a pointer; no control disables with the reason; busy offers follow-up, steer and abort", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	const built = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const screen=(data,control)=>render(h(Sessions,{data,control}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	const { screen } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { screen: (data: unknown, control?: ControlView) => string };
	const full = sessionsView(state, "you", null, { transcript: true })!;
	full.entries = [
		ask("ask-aaaa", "open"),
		ask("ask-bbbb", "answered", { answer: "Raise", answered_at: "2026-09-27T08:25:00Z" }),
		ask("ask-cccc", "withdrawn", { reason: "No longer needed" }),
		{ ...base, id: "d1", at: "2026-09-27T08:26:00Z", kind: "via", who: "Operator (dashboard)", text: "ask-aaaa: Keep", tag: "dashboard", dashboard_id: "dc-20260927082600-0123abcd", ask_id: "ask-aaaa" },
	];
	full.open_asks = [detail("ask-aaaa"), detail("ask-dddd", { question: "Older than the window" })];

	const ready = screen(full, view(status({})));
	const open = pinned(ready);
	assert.match(open, /<h2><button type="button" aria-expanded="false">2 decisions waiting<span aria-hidden="true"> ▾<\/span><\/button><\/h2>/, "one compact bar at every width, collapsed until tapped when nothing is remembered");
	assert.ok(ready.indexOf("session-pinned") < ready.indexOf("operator-composer"), "the pinned block sits directly above the composer");
	assert.ok(open.indexOf("Question ask-aaaa") < open.indexOf("Older than the window"), "oldest first, as given");
	assert.equal(open.match(/<button type="button" class="decision-card-option/g)?.length, 4, "one button per option, per card");
	assert.match(open, /<button type="button" class="decision-card-option decision-card-recommended"><span class="decision-card-option-heading"><strong>Keep<\/strong><span class="overview-rec-badge">recommended<\/span><\/span><span class="decision-card-consequence">Paused until Monday<\/span>/);
	assert.doesNotMatch(ready, /Copy reply/);
	assert.match(open, /operator session recommends <strong>Keep<\/strong>/);
	assert.equal(card(ready, "open"), '<p class="session-ask-pointer">open, answer below</p>', "the inline card is history, a one-line pointer");
	assert.match(card(ready, "answered"), /Answered: Raise · /);
	assert.doesNotMatch(card(ready, "answered"), /<button/);
	assert.equal(card(ready, "withdrawn"), '<p class="session-ask-settled">Withdrawn: No longer needed</p>');
	assert.doesNotMatch(screen({ ...full, open_asks: [] }, view(status({}))), /session-pinned/, "no open ask, no pinned block");
	assert.match(ready, /Operator \(dashboard\)<\/span><span>dashboard<\/span>/);
	assert.match(ready, /dashboard dc-20260927082600-0123abcd · ask-aaaa/);
	assert.match(ready, /<textarea aria-label="Message to the operator session" maxLength="16000"|<textarea aria-label="Message to the operator session" maxlength="16000"/);
	assert.match(ready, /placeholder="Message \(Enter to send\)"/, "one short placeholder that fits the 390px one-row box; no separate hint line");
	assert.doesNotMatch(ready, /operator-composer-hint/);
	assert.match(ready, /<button type="button" class="operator-composer-send" aria-label="Send" title="Send" disabled(?:="")?>/, "one round send button, idle: a plain send");
	assert.doesNotMatch(ready, /operator-composer-more/, "no steer/abort menu while idle");
	assert.match(ready, /delivers to the running session <code>op\.jsonl<\/code>/);
	assert.match(ready, /class="operator-composer-state operator-composer-state-ready"/, "the ready status line is the one mobile hides");
	// The mobile top bar: back, the view's name, the compact ctx, the status chip and the ⋯ sheet; no tab rows.
	const bar = /<header class="session-bar">[\s\S]*?<\/header>/.exec(ready)?.[0] ?? "";
	assert.match(bar, /href="#overview" aria-label="Back to Overview"/);
	assert.match(bar, /<summary aria-label="Switch session"><strong>Operator ↔ you<\/strong>/);
	assert.match(bar, /class="session-bar-status" role="status" title="Ready">idle<\/span>/);
	assert.doesNotMatch(bar, />Decisions<\/a>|>Full transcript<\/a>/, "audit P4 #27: no Decisions | Full transcript toggle in the ⋯ sheet");
	assert.match(bar, />Search<\/button>/);
	assert.match(bar, /class="session-bar-file">Delivers to <code>op\.jsonl<\/code>/, "the session file name lives in the ⋯ sheet");
	assert.doesNotMatch(ready, /session-tabs|session-mobile-controls/, "the old tab rows are gone");
	assert.doesNotMatch(ready, /<form/);

	const busy = screen(full, view(status({ busy: true })));
	assert.match(busy, /class="operator-composer-send" aria-label="Send after this turn"/, "busy: the send button follows up, like Enter");
	assert.match(busy, /placeholder="Message \(Enter to send\)"/, "the placeholder never grows: the send button's tooltip says what Enter does while busy");
	assert.match(busy, /<details class="operator-composer-more"><summary aria-label="Steer or abort"/, "busy: steer and abort behind the ⋯ menu");
	for (const label of ["Steer now", "Abort turn"]) assert.match(busy, new RegExp(`>${label}</button>`));
	assert.match(busy, /Session busy — send after this turn, steer, or abort/);
	assert.match(busy, /class="session-bar-status" role="status"[^>]*>busy<\/span>/);

	const down = screen(full, view(status({ running: false, token: null, reason: "Session not running: no dashboard control record at /x/dashboard.json" })));
	assert.match(down, /Session not running: no dashboard control record/);
	assert.doesNotMatch(down, /<textarea/);
	assert.match(pinned(down), /<button type="button" class="decision-card-option decision-card-recommended" disabled(?:="")?>/, "no control: buttons stay, disabled");
	assert.match(pinned(down), /class="decision-card-disabled" role="status">Session not running: no dashboard control record/, "with the one reason");
	assert.doesNotMatch(down, /Copy reply/);
	const off = screen(full, view(status({ enabled: false, running: false, token: null, reason: "Dashboard control is off: data/dashboard-control.json has enabled:false" })));
	assert.match(off, /Dashboard control is off/);
	assert.doesNotMatch(off, /<textarea/);

	const sending = screen(full, view(status({}), { id: null, state: "sending", reason: null, ask_id: "ask-aaaa" }));
	assert.match(pinned(sending), /class="decision-card-option decision-card-recommended" disabled(?:="")?><span class="decision-card-option-heading"><strong>Keep/, "a click in flight disables the card");
	assert.match(pinned(sending), /class="decision-card-delivery">Sending — the card closes when the session records the answer/);
	const failed = screen(full, view(status({}), { id: null, state: "failed", reason: "ask-aaaa is answered; nothing to answer", ask_id: null }));
	assert.match(failed, /role="alert" class="operator-composer-delivery operator-composer-failed">Failed: ask-aaaa is answered/);

	const decisions = screen(sessionsView(state, "you", null)!, view(status({})));
	assert.doesNotMatch(decisions, /operator-composer/, "the Decisions view renders no composer");
	const parent = screen(sessionsView(state, "parent", null)!, view(status({})));
	assert.doesNotMatch(parent, /operator-composer/, "nor does any other tier");
	assert.match(parent, /<header class="session-bar">[\s\S]*?<strong>CP parent<\/strong>/, "the parent transcript gets the compact top bar too");
	assert.doesNotMatch(parent, /session-bar-status/, "no composer, no status chip");
	assert.match(decisions, /<header class="session-bar">/);
});

test("client: sendControl and controlLine map 202/403/409/503 and an unreachable home to one line each", async () => {
	const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const seen: RequestInit[] = [];
	const ok = await sendControl(async (_url, init) => { seen.push(init!); return reply(202, { id: "dc-20260927082600-0123abcd", state: "queued", deliver: "followUp" })(); }, "tok", { kind: "message", text: "hi", deliver: "followUp" });
	assert.deepEqual(ok, { id: "dc-20260927082600-0123abcd", state: "queued", deliver: "followUp" });
	assert.equal((seen[0]!.headers as Record<string, string>)["x-cp-control-token"], "tok");
	assert.equal(seen[0]!.method, "POST");
	for (const [code, error] of [[403, "control token missing or stale; reload the transcript"], [409, "ask-aaaa is answered; nothing to answer"], [503, "session not running: no dashboard control record at /x"]] as const) {
		assert.deepEqual(await sendControl(reply(code, { error }), "tok", { kind: "abort" }), { error, status: code });
	}
	assert.deepEqual(await sendControl(async () => { throw new Error("offline"); }, "tok", { kind: "abort" }), { error: "Could not reach this home", status: 0 });
	assert.equal(controlLine(null), "Checking dashboard control");
	assert.equal(controlLine({ error: "HTTP 403" }), "Not available: HTTP 403");
	assert.equal(controlLine(status({ enabled: false, running: false, token: null, reason: null })), "Dashboard control is off");
	assert.equal(controlLine(status({ running: false, token: null, reason: null })), "Session not running");
	assert.equal(controlLine(status({})), "Ready");
	assert.equal(deliveryLine({ id: "dc-1", state: "queued", reason: null, ask_id: null }), "Queued · dc-1");
	assert.equal(deliveryLine({ id: "dc-1", state: "delivered", reason: null, ask_id: null }), "Delivered to the session · dc-1");
	assert.equal(deliveryLine({ id: null, state: "failed", reason: "boom", ask_id: null }), "Failed: boom");
	assert.equal(controlChip(null, null), "checking");
	assert.equal(controlChip(status({}), null), "idle");
	assert.equal(controlChip(status({ busy: true }), { id: "dc-1", state: "queued", reason: null, ask_id: null }), "busy · queued");
	assert.equal(controlChip(status({ running: false, token: null }), null), "not running");
	assert.equal(controlChip(status({ enabled: false, running: false, token: null }), null), "off");
	assert.equal(controlChip({ error: "HTTP 403" }, { id: null, state: "failed", reason: "x", ask_id: null }), "unavailable · failed");
});

test("offline → starting → running (cp-daemon P3): the composer holds with the inbox token and offers Start session with the tmux hint; starting disables it; running opens it; the Overview line says offline · N held", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	const built = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=(data,control)=>render(h(Sessions,{data,control})); export const overview=(data,control)=>render(h(Overview,{data,control}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	const ui = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { screen: (data: unknown, control?: ControlView) => string; overview: (data: unknown, control?: ControlView) => string };
	const full = sessionsView(state, "you", null, { transcript: true })!;
	const offline = status({ running: false, token: null, offline: true, held: 2, inbox_token: "i".repeat(64), reason: "Operator session offline: no dashboard control record" });
	const composer = (html: string) => /<section class="operator-composer"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

	const down = composer(ui.screen(full, view(offline)));
	assert.match(down, /Operator session offline · 2 held — a message waits here until a session attaches/);
	assert.match(down, /<button type="button" class="start-session-button">Start in tmux<\/button>/, "one launcher: one button naming it");
	assert.doesNotMatch(down, /Start in herdr/);
	assert.match(down, /attach from a terminal: <code>tmux attach -t cp-operator<\/code>/);
	assert.doesNotMatch(down, /open herdr/);
	assert.match(down, /<textarea/, "offline still takes a message: it is held");
	assert.doesNotMatch(down, /operator-composer-more/, "no steer or abort while offline");
	assert.match(ui.screen(full, view(offline, { id: "dc-1", state: "held", reason: null, ask_id: null })), /Held until an operator session attaches · dc-1/);

	const both = composer(ui.screen(full, view({ ...offline, launchers: { tmux: true, herdr: true } })));
	assert.equal(both.match(/class="start-session-button"/g)?.length, 2, "both launchers: two buttons");
	assert.match(both, /class="start-session-button">Start in herdr<\/button><button type="button" class="start-session-button">Start in tmux<\/button>/);
	assert.match(both, /open herdr → workspace <code>cp-operator<\/code>/, "the herdr hint");
	assert.match(both, /attach from a terminal: <code>tmux attach -t cp-operator<\/code>/, "and the tmux hint");
	const herdrOnly = composer(ui.screen(full, view({ ...offline, launchers: { tmux: false, herdr: true } })));
	assert.match(herdrOnly, /class="start-session-button">Start in herdr<\/button>/);
	assert.doesNotMatch(herdrOnly, /Start in tmux|tmux attach/, "herdr only: no tmux button or hint");

	const resumable = composer(ui.screen(full, view({ ...offline, launchers: { tmux: true, herdr: true }, resume: { tmux: true, herdr: true } })));
	assert.match(resumable, /Start in herdr<\/button><button type="button" class="start-session-button">Start in tmux<\/button><button type="button" class="start-session-button">Resume last session in herdr<\/button><button type="button" class="start-session-button">Resume last session in tmux<\/button>/, "fresh starts kept; one Resume per launcher after them");
	assert.match(resumable, /Resume continues this home(?:&#39;|')s most recent operator session \(cp-operator -c\); with none, it starts a fresh one/, "the no-previous-session fallback is said");
	const resumeHerdrOnly = composer(ui.screen(full, view({ ...offline, launchers: { tmux: true, herdr: true }, resume: { tmux: false, herdr: true } })));
	assert.match(resumeHerdrOnly, /Resume last session in herdr/);
	assert.doesNotMatch(resumeHerdrOnly, /Resume last session in tmux/, "no tmux resume launcher: no tmux resume");
	assert.doesNotMatch(both, /Resume/, "no resume launchers: no Resume button, no line");

	const neither = composer(ui.screen(full, view({ ...offline, launchers: { tmux: false, herdr: false }, start_unavailable: "Start in tmux needs the cp-daemon-run dashboard: rerun cp-install; herdr is not on PATH" })));
	assert.match(neither, /<button type="button" class="start-session-button" disabled(?:="")?>Start session/, "no launcher: one button, disabled");
	assert.equal(neither.match(/class="start-session-button"/g)?.length, 1);
	assert.match(neither, /Start session unavailable: Start in tmux needs the cp-daemon-run dashboard: rerun cp-install; herdr is not on PATH/, "and says why");

	const viaHerdr = composer(ui.screen(full, { ...view({ ...offline, launchers: { tmux: true, herdr: true } }), starting: { state: "starting", reason: null, via: "herdr" } }));
	assert.match(viaHerdr, /open herdr → workspace <code>cp-operator<\/code>/, "starting in herdr: the herdr hint");
	assert.doesNotMatch(viaHerdr, /tmux attach/, "and only it");

	const starting = composer(ui.screen(full, { ...view(offline), starting: { state: "starting", reason: null } }));
	assert.match(starting, /class="start-session-button" disabled(?:="")?>Starting…<\/button>/);
	assert.match(starting, /Starting the operator session… the composer opens when it serves the dashboard/);
	assert.match(starting, /<textarea[^>]* disabled/, "the composer waits for the live session");
	const failed = composer(ui.screen(full, { ...view(offline), starting: { state: "failed", reason: "no session served the dashboard within 60 s" } }));
	assert.match(failed, /start-session-failed" role="status">Start failed: no session served the dashboard within 60 s/);

	const running = composer(ui.screen(full, { ...view(status({})), starting: { state: "running", reason: null } }));
	assert.doesNotMatch(running, /start-session/, "running: no Start session");
	assert.match(running, /<textarea(?![^>]* disabled)[^>]*>/, "the composer is open");

	const data = overview(state);
	const offlineHtml = ui.overview({ ...data, fleet: { ...data.fleet, operator: { running: false, pid: null, since: null, held: 2 } }, services: { health: { last_run_at: data.generated_at, failing: [] } } }, view(offline));
	const line = /<p class="overview-meta overview-services-line"[^>]*>(.*?)<\/p>/.exec(offlineHtml)?.[1];
	assert.equal(line, "health ok 0m ago", "audit P3 #18: parent and operator moved to their chips; the line keeps the watchdog");
	assert.match(offlineHtml, /operator<\/span><strong title="offline · 2 held">offline · 2 held</);
	assert.match(ui.overview({ ...data, fleet: { ...data.fleet, operator: { running: false, pid: null, since: null, held: 0 } } }, view(offline)), /class="start-session-button">Start in tmux/, "the Overview offline line offers Start session");
	assert.doesNotMatch(ui.overview({ ...data, fleet: { ...data.fleet, operator: { running: true, pid: 7, since: null, held: 0 } } }, view(status({}))), /start-session/);
	const since = (secondsAgo: number) => new Date(Date.parse(data.generated_at) - secondsAgo * 1000).toISOString();
	const disk = (secondsAgo: number) => ({ ...data, services: { health: { last_run_at: data.generated_at, failing: [{ check: "disk", detail: "3 GiB", since: since(secondsAgo) }] } } });
	assert.match(ui.overview(disk(0)), /health failing: disk \(0m ago\)/);
	// cp-6fyl PR2: the alarm banner (role="alert") only for a health check failing 15 min or an unacked relay 10 min.
	const banner = /<section class="overview-alarm" role="alert">([\s\S]*?)<\/section>/;
	assert.doesNotMatch(ui.overview(data), banner, "a calm page has no banner");
	assert.doesNotMatch(ui.overview(disk(899)), banner, "14 min 59 s: not yet");
	assert.match(banner.exec(ui.overview(disk(900)))?.[1] ?? "", /health check disk failing 15m: 3 GiB/);
	const unseen = (age: number, alarm: boolean) => ({ ...data, delivery: { availability: "ok", unseen: 2, oldest_id: "esc:es-demo1", oldest_kind: "escalation", oldest_age_seconds: age, consumer_seen_at: null, alarm } });
	assert.doesNotMatch(ui.overview(unseen(599, false)), banner);
	assert.match(banner.exec(ui.overview(unseen(600, true)))?.[1] ?? "", /2 parent messages not seen by the main session, oldest 10m \(escalation esc:es-demo1\)/);
});

test("client: startOperator posts {via} with the inbox token and maps starting / already_running / unavailable / a refusal; chip and line say offline", async () => {
	const seen: Array<[string, RequestInit]> = [];
	const reply = (code: number, body: unknown) => async (url: string, init?: RequestInit) => { seen.push([url, init!]); return new Response(JSON.stringify(body), { status: code }); };
	assert.deepEqual(await startOperator(reply(202, { state: "starting" }), "tok", "tmux"), { state: "starting" });
	assert.deepEqual([seen[0]![0], seen[0]![1].method, seen[0]![1].body, (seen[0]![1].headers as Record<string, string>)["x-cp-control-token"]], ["/api/operator/start", "POST", '{"via":"tmux"}', "tok"]);
	await startOperator(reply(202, { state: "starting" }), "tok", "herdr");
	assert.equal(seen[1]![1].body, '{"via":"herdr"}');
	await startOperator(reply(202, { state: "starting", resume: true }), "tok", "tmux", true);
	assert.equal(seen[2]![1].body, '{"via":"tmux","resume":true}', "resume: the fixed flag, nothing else");
	seen.splice(2, 1);
	assert.deepEqual(await startOperator(reply(409, { state: "already_running", error: "an operator session is already running (pid 7)" }), "tok", "tmux"), { state: "already_running", reason: "an operator session is already running (pid 7)" });
	assert.deepEqual(await startOperator(reply(503, { state: "unavailable", reason: "no unit" }), "tok", "tmux"), { state: "unavailable", reason: "no unit" });
	assert.deepEqual(await startOperator(reply(429, { error: "one start per 60 s; retry in 40 s" }), "tok", "tmux"), { error: "one start per 60 s; retry in 40 s" });
	assert.deepEqual(await startOperator(async () => { throw new Error("x"); }, "tok", "herdr"), { error: "Could not reach this home" });
	assert.equal(controlChip(status({ running: false, token: null, offline: true, inbox_token: "i" }), null), "offline");
	assert.equal(controlLine(status({ running: false, token: null, offline: true, inbox_token: "i" })), "Operator session offline — a message waits here until a session attaches");
});

test("layout: the pinned decision block and its cards hold at 390px and 1440px", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8");
	const [phone, desktop = ""] = css.split("@media (min-width: 900px) {");
	assert.match(phone ?? "", /\.session-pinned \{ display: flex;[^}]*max-height: 45vh;[^}]*overflow-y: auto;[^}]*padding: 0 16px;[^}]*\}/, "a bounded, inset pinned block that scrolls inside at 390px");
	const everyWidth = css.split("@media")[0] ?? "";
	assert.match(everyWidth, /\.session-pinned:not\(\.session-pinned-open\) > :not\(h2\) \{ display: none; \}/, "collapsed to its one-line bar at every width, not only on phones");
	assert.match(everyWidth, /\.session-pinned-open > h2 \{ position: sticky;/, "the open sheet keeps its bar in reach while the cards scroll");
	assert.match(phone ?? "", /@media \(max-width: 899px\) \{\n \.session-pinned-open \{ max-height: 60dvh; \}\n\}/, "the phone sheet caps at 60dvh");
	assert.doesNotMatch(desktop, /pointer-events: none|\.session-pinned > h2 > button > span/, "at 1440px the bar is a real toggle with its ▾, never a bare heading");
	assert.match(desktop, /\.session-pinned \{ padding: 0 40px; \}/, "the wide layout keeps its 40px inset around a one-line bar");
	assert.match(phone ?? "", /\.decision-card \{ display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-wrap: anywhere; \}/, "long text wraps inside the card at 390px");
	assert.match(phone ?? "", /\.decision-card-options \{ display: grid; grid-template-columns: minmax\(0,1fr\);[^}]*\}/, "one option per row at 390px");
	assert.match(desktop, /\.session-pinned > \* \{ max-width: 780px; \}/, "and the transcript's 780px column at 1440px");
	assert.match(desktop, /\.decision-card-options \{ grid-template-columns: repeat\(2,minmax\(0,1fr\)\); \}/, "two options per row from 900px up");
	assert.match(phone ?? "", /\.start-session \{ display: flex; flex-wrap: wrap;[^}]*min-width: 0; \}/, "Start session wraps at 390px");
	assert.match(phone ?? "", /\.start-session-line \{ flex: 1 1 220px; min-width: 0;[^}]*overflow-wrap: anywhere; \}/, "a long reason wraps instead of widening the page, and sits beside the button at 1440px");
	assert.match(phone ?? "", /\.overview-services-line \{[^}]*overflow-wrap: anywhere; \}/);
});

/** The Sessions screen mounted in a real DOM with a localStorage the test owns; `mount` again re-renders in place. */
async function pinnedStage(t: TestContext, store: Map<string, string>, refuseWrites = false) {
	const built = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export {act}; export const mount=(root,data)=>render(h(Sessions,{data}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	const { act, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { act: (run: () => void) => Promise<void>; mount: (root: Element, data: unknown) => void; unmount: (root: Element) => void };
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { if (refuseWrites) throw new Error("QuotaExceededError"); store.set(key, value); } } });
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => { await act(() => unmount(root)); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const home = createScratchHome(); t.after(() => home.cleanup());
	const data = (ids: string[]) => ({ ...sessionsView({ home: home.path, stateDir: join(home.path, LAYOUT.state) }, "you", null, { transcript: true })!, entries: [], open_asks: ids.map(id => detail(id)) });
	const bar = () => root.querySelector(".session-pinned > h2 > button")!;
	return {
		show: (ids: string[]) => act(() => mount(root, data(ids))),
		remount: async (ids: string[]) => { await act(() => unmount(root)); await act(() => mount(root, data(ids))); },
		click: () => act(() => { bar().dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); }),
		bar,
		expanded: () => bar().getAttribute("aria-expanded"),
		cls: () => root.querySelector(".session-pinned")!.getAttribute("class"),
	};
}

test("pinned decisions: one toggle at every width, a remembered choice, and opening by itself only for a new ask id", async (t) => {
	const store = new Map<string, string>();
	const s = await pinnedStage(t, store);

	// First visit: the one-line bar, collapsed; the ids on screen are the baseline, nothing written yet.
	await s.show(["ask-a", "ask-b"]);
	assert.equal(s.expanded(), "false");
	assert.equal(s.cls(), "session-pinned", "collapsed: CSS hides every card at every width");
	assert.equal(s.bar().textContent, "2 decisions waiting ▾");
	assert.equal(s.bar().getAttribute("type"), "button", "a real button, so it is focusable and Enter/Space toggle it");
	assert.equal(s.bar().closest("section")!.getAttribute("aria-label"), "Open decisions");
	assert.deepEqual([...store.keys()], [], "nothing is remembered before the operator chooses");

	// The toggle (no width check anywhere: the same button at 390px and 1440px) opens, and the choice is remembered.
	await s.click();
	assert.equal(s.expanded(), "true");
	assert.equal(s.cls(), "session-pinned session-pinned-open");
	assert.equal(store.get("cp-sessions-pinned-open"), "1");
	await s.remount(["ask-a", "ask-b"]);
	assert.equal(s.expanded(), "true", "an open choice survives a reload");
	await s.click();
	assert.equal(store.get("cp-sessions-pinned-open"), "0");
	await s.remount(["ask-a", "ask-b"]);
	assert.equal(s.expanded(), "false", "and so does a collapsed one");

	// The count changing alone never opens it.
	await s.show(["ask-a"]);
	assert.equal(s.expanded(), "false", "an answered ask leaving does not open the bar");
	assert.equal(s.bar().textContent, "1 decision waiting ▾");
	assert.equal(store.get("cp-sessions-pinned-seen"), '["ask-a"]');

	// A new ask id opens it, even when the count is unchanged.
	await s.show(["ask-c"]);
	assert.equal(s.expanded(), "true", "same count, new id: opens");
	assert.equal(store.get("cp-sessions-pinned-open"), "0", "opening by itself is not the operator's choice");
	await s.click();
	await s.show(["ask-c", "ask-d"]);
	assert.equal(s.expanded(), "true", "a second ask arriving opens it again");
	await s.click();
	await s.show(["ask-c", "ask-d"]);
	assert.equal(s.expanded(), "false", "a refresh with the same ids keeps it collapsed");

	// Across a reload: an ask that arrived while the page was away still opens it; a known set does not.
	await s.remount(["ask-c", "ask-d"]);
	assert.equal(s.expanded(), "false");
	await s.remount(["ask-c", "ask-d", "ask-e"]);
	assert.equal(s.expanded(), "true", "an unseen id at mount opens the bar");
});

test("pinned decisions: a localStorage that refuses the write warns and the toggle still works for this view", async (t) => {
	const warnings: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args); };
	t.after(() => { console.warn = original; });
	const s = await pinnedStage(t, new Map(), true);
	await s.show(["ask-a"]);
	await s.click();
	assert.equal(s.expanded(), "true", "the click opens it regardless");
	await s.show(["ask-b"]);
	assert.equal(s.expanded(), "true");
	await s.click();
	assert.equal(s.expanded(), "false", "and collapses it");
	await s.show(["ask-b", "ask-c"]);
	assert.equal(s.expanded(), "true", "new ids still open it from memory");
	assert.deepEqual(warnings, [["decisions bar not persisted: QuotaExceededError"], ["seen decisions not persisted: QuotaExceededError"], ["decisions bar not persisted: QuotaExceededError"], ["seen decisions not persisted: QuotaExceededError"]]);
});
