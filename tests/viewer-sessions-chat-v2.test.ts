/**
 * Sessions chat v2: browser-local day separators that never sort, invent or duplicate a day; the light theme scoped
 * to the Sessions shell (`shell-sessions`); steps rows and the Job transcript link (PR 2); Chats and threads (PR 3).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import type { AwaitingDetail, ControlStatusResponse, JobResponse, SessionEntry, SessionsResponse, ThreadsResponse, ThreadView } from "../src/viewer/api-types.ts";
import { threadAria, type ThreadsView, waitingCount, waitingLabel } from "../viewer-app/threads.ts";
import type { ControlBody, ControlView } from "../viewer-app/control.ts";
import { dayKey, dayLabel, dayStarts, lastDay, replyAsk, rows } from "../viewer-app/session-rows.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; import {QuickReplies} from "./viewer-app/components/QuickReplies.tsx"; export {act}; export const html=(data,threads,control)=>renderToString(h(Sessions,{data,threads,control})); export const shell=screen=>renderToString(h(Shell,{current:{screen,section:null},awaiting:0,status:"live",updatedAt:null},"Content")); export const mount=(root,data,threads)=>render(h(Sessions,{data,threads}),root); export const replies=(root,ask,control)=>render(h(QuickReplies,{ask,control}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, html, shell, mount, replies, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (run: () => void | Promise<void>) => Promise<void>;
	html: (data: SessionsResponse, threads?: ThreadsView, control?: ControlView) => string;
	shell: (screen: string) => string;
	mount: (root: Element, data: SessionsResponse, threads?: ThreadsView) => void;
	replies: (root: Element, ask: AwaitingDetail, control: ControlView) => void;
	unmount: (root: Element) => void;
};

/** Local wall-clock instants, so the separators follow the test machine's own zone like a browser's. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const entry = (id: string, kind: SessionEntry["kind"], at: string, over: Partial<SessionEntry> = {}): SessionEntry => ({ id, at, kind, who: "Assistant", text: id, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const view = (entries: SessionEntry[]): SessionsResponse => ({ generated_at: "", selected: "you", session_id: null, parent: { id: "cp-parent", live: false }, workers: [], entries, title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false, transcript: true } as unknown as SessionsResponse);
/** The transcript in order: a day pill's label, a bubble's text, or `tools` for a collapsed run. */
const sequence = (root: { querySelectorAll(s: string): Iterable<Element> }) => [...root.querySelectorAll(".session-entries .session-day, .session-entries .session-bubble .md, .session-entries .session-tool-run")].map(el => el.classList.contains("session-day") ? `day:${el.textContent}` : el.classList.contains("session-tool-run") ? "tools" : el.textContent);

test("day helpers: local calendar keys; unparseable or missing times never open a day; a list continues from the day above", () => {
	assert.equal(dayKey(local(15, 23, 59)), "2026-10-15");
	assert.equal(dayKey(local(16, 0, 1)), "2026-10-16", "one minute past local midnight is the next day");
	for (const bad of ["", "not a time", null, undefined]) assert.equal(dayKey(bad), null);
	assert.equal(dayLabel(local(15, 9), new Date(2026, 0, 1)), "Thu, Oct 15");
	assert.equal(dayLabel(local(15, 9), new Date(2027, 0, 1)), "Thu, Oct 15, 2026", "another year names it");
	const entries = [entry("a", "say", local(15, 23, 58)), entry("b", "say", "garbage"), entry("c", "say", local(15, 23, 59)), entry("d", "say", local(16, 0, 1))];
	assert.deepEqual([...dayStarts(entries).keys()], ["a", "d"]);
	assert.deepEqual([...dayStarts(entries, "2026-10-15").keys()], ["d"], "the day already shown above opens nothing");
	assert.equal(lastDay(entries), "2026-10-16");
	assert.equal(lastDay([entry("x", "say", "")]), null);
});

test("rendered separators: in source order, across local midnight, splitting a tool run and a bubble group; an undated bubble gets neither a separator nor a time", () => {
	const rendered = html(view([
		entry("a1", "say", local(15, 23, 50), { text: "before midnight" }),
		entry("t1", "tool", local(15, 23, 58), { name: "bash" }),
		entry("t2", "tool", local(16, 0, 0), { name: "bash" }),
		entry("a2", "say", local(16, 0, 2), { text: "after midnight" }),
		entry("a3", "say", "not a time", { text: "undated" }),
		entry("a4", "say", local(15, 9), { text: "out of order stays put" }),
	]));
	const { document } = parseHTML(`<div>${rendered}</div>`);
	assert.deepEqual(sequence(document), ["day:Thu, Oct 15", "before midnight", "tools", "day:Fri, Oct 16", "tools", "after midnight", "undated", "day:Thu, Oct 15", "out of order stays put"]);
	const bubbles = [...document.querySelectorAll(".session-bubble")];
	assert.equal(bubbles[1]!.querySelector(".session-who")?.textContent?.includes("Operator"), true, "a new day opens a new group even within five minutes");
	assert.equal(bubbles[2]!.querySelector("time"), null, "no time is invented for an unparseable stamp");
	assert.deepEqual([...document.querySelectorAll(".session-day time")].map(t => t.getAttribute("datetime")), ["2026-10-15", "2026-10-16", "2026-10-15"]);
});

test("pending sends: one queued past local midnight opens its own day pill; a same-day send and a dated tail add none", () => {
	// #318 review low: the pending tail rendered no separators, so a send queued at 00:05 sat under the previous day.
	const send = (key: string, at: string) => ({ key, id: `dc-${key}`, at, state: "queued", reason: null, ask_id: null, body: { kind: "message", text: `queued ${key}` } });
	const control = (...pending: ReturnType<typeof send>[]) => ({ status: null, delivery: null, pending, send() {}, retry() {}, discard() {} }) as unknown as ControlView;
	const data = view([entry("a1", "say", local(15, 23, 50), { text: "before midnight" })]);
	const days = (c: ControlView) => [...parseHTML(`<div>${html(data, undefined, c)}</div>`).document.querySelectorAll(".session-entries .session-day, .session-entries .session-pending")]
		.map(el => el.classList.contains("session-day") ? `day:${el.textContent}` : "pending");
	assert.deepEqual(days(control(send("s1", local(15, 23, 55)), send("s2", local(16, 0, 5)), send("s3", local(16, 0, 6)))), ["day:Thu, Oct 15", "pending", "day:Fri, Oct 16", "pending", "pending"]);
	assert.deepEqual(days(control(send("s4", local(15, 23, 59)))), ["day:Thu, Oct 15", "pending"]);
});

test("grouped own bubbles in a worker view name the author once; the session side already did", () => {
	// #318 review low: consecutive parent briefs in a worker transcript repeated "Parent" above each bubble of the group.
	const briefs = [entry("p1", "say", local(15, 9), { who: "Parent", text: "brief one" }), entry("p2", "say", local(15, 9, 1), { who: "Parent", text: "brief two" }), entry("w1", "say", local(15, 9, 2), { who: "Worker", text: "on it" }), entry("w2", "say", local(15, 9, 3), { who: "Worker", text: "done" })];
	const { document } = parseHTML(`<div>${html({ ...view(briefs), selected: "workers" })}</div>`);
	const names = [...document.querySelectorAll(".session-bubble")].map(b => [...b.querySelectorAll(".session-who > span:not(.session-avatar)")].map(s => s.textContent).join(","));
	assert.deepEqual(names, ["Parent", "", "Worker", ""]);
	assert.equal(document.querySelectorAll(".session-own .session-who time").length, 2, "each own bubble keeps its time");
});

/** A DOM to click the thread's `Show earlier` band in; the screen's scroll hooks need only stubs here. */
function stage(t: TestContext) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	class Observer { observe() {} disconnect() {} }
	const originals = ["window", "document", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document], ["ResizeObserver", Observer]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => {
		await act(() => unmount(root));
		for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	});
	return { root, click: (node: Element | null) => act(() => { node!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); }) };
}

test("thread bands: a collapsed earlier band leaves the thread its own day pill; opened on the same day, the pill is not repeated", async t => {
	const thread = { id: "th-1", tag: "alpha", state: "open", waiting: { asks: 0, answers: 0 }, counts: { messages: 1, asks: 0, answers: 0, jobs_working: 0 }, opened_at: local(15, 9), last_at: local(15, 11), done_at: null };
	const threads = { status: { generated_at: "", availability: "ok", enabled: true, reason: null, token: "t", threads: [thread], total: 1, warning: null }, selected: "alpha", select() {}, done() {}, sending: null, failed: null } as unknown as ThreadsView;
	const data = view([entry("o1", "say", local(15, 8), { text: "other thread" }), entry("m1", "say", local(15, 10), { text: "mine", thread: "th-1" }), entry("o2", "say", local(16, 9), { text: "next day elsewhere" })]);
	const s = stage(t);
	await act(() => mount(s.root, data, threads));
	assert.deepEqual(sequence(s.root), ["day:Thu, Oct 15", "mine"], "the collapsed bands show no pill of their own");
	await s.click(s.root.querySelector(".session-edge-toggle"));
	assert.deepEqual(sequence(s.root), ["day:Thu, Oct 15", "other thread", "mine"], "the thread continues the opened band's day");
	await s.click(s.root.querySelector(".session-edge-toggle"));
	assert.deepEqual(sequence(s.root), ["day:Thu, Oct 15", "other thread", "mine", "day:Fri, Oct 16", "next day elsewhere"]);
});

test("theme scope: only the Sessions route's shell carries shell-sessions, so the light palette never reaches another screen", () => {
	assert.match(shell("sessions"), /^<div class="shell shell-sessions">/);
	for (const screen of ["overview", "decisions", "jobs", "job", "files"]) assert.match(shell(screen), /^<div class="shell">/, screen);
});

test("rows: a run of steps is contiguous tool calls plus at most the one parsed wake notice right above them", () => {
	const at = local(15, 9);
	const wake = (id: string, over: Partial<SessionEntry> = {}) => entry(id, "system", at, { bridge: { kind: "wake", job: "cp-a", id: null, receipt: null }, ...over });
	const tool = (id: string, over: Partial<SessionEntry> = {}) => entry(id, "tool", at, { name: "bash", ...over });
	const shape = (list: SessionEntry[], days = new Map<string, string>(), order?: Map<string, number>) =>
		rows(list, days, order).map(row => row.kind === "entry" ? row.entry.id : `${row.key}[${row.notice ? `${row.notice.id}+` : ""}${row.entries.map(e => e.id).join(",")}]`);
	assert.deepEqual(shape([wake("w1"), wake("w2"), tool("t1"), tool("t2"), entry("s", "say", at), tool("t3")]), ["w1", "w2[w2+t1,t2]", "s", "t3[t3]"], "only the nearest notice joins; a message ends the run");
	assert.deepEqual(shape([entry("x", "system", at), tool("t1"), wake("w1"), entry("ask", "ask", at), tool("t2"), tool("t3")]), ["x", "t1[t1]", "w1", "ask", "t2[t2,t3]"], "an unparsed system entry or an ask card never joins");
	assert.deepEqual(shape([tool("t1"), wake("w1"), tool("t2")]), ["t1[t1]", "w1[w1+t2]"], "a notice ends a run and opens the next");
	assert.deepEqual(shape([wake("w1"), tool("t1"), tool("t2")], new Map([["t2", "Fri"]])), ["w1[w1+t1]", "t2[t2]"], "a new local day splits the run");
	assert.deepEqual(shape([wake("w1"), tool("t1", { thread: "th-1" }), tool("t2", { thread: "th-1" }), tool("t3")]), ["w1", "t1[t1,t2]", "t3[t3]"], "so does another thread");
	const list = [wake("w1"), tool("t1"), tool("t3")];
	assert.deepEqual(shape(list, new Map(), new Map([["w1", 0], ["t1", 1], ["t3", 3]])), ["w1[w1+t1]", "t3[t3]"], "and a gap the thread filter opened in source order");
	assert.deepEqual(shape(list, new Map(), new Map([["w1", 4], ["t1", 5], ["t3", 6]])), ["w1[w1+t1,t3]"]);
});

test("App: the explicit Job transcript link opens a done job's Transcript on a phone; a plain Job link keeps Details", async t => {
	// Back/Forward between the two hashes of one job remounts the route (its key includes the query), so each lands on its
	// own tab; the API read is the job id alone. Phone width comes from matchMedia, which JobDetail reads at mount.
	const built = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {App} from "./viewer-app/app.tsx"; export {act}; export const mount=root=>render(h(App,{}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
	const app = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { act: typeof act; mount: (root: Element) => void; unmount: (root: Element) => void };
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const location = { hash: "#job/cp-done?tab=transcript" };
	const job = { id: "cp-done", project: "demo", title: "Done job", phase: "done", model: null, script_path: null, elapsed_seconds: null, limit_seconds: null, head: null, ci: null, review: null, review_attempts: 0, routing: null, note: null, ledger_status: "closed", ledger_disagrees: false, mandate_id: null, cost_usd: null, pr_url: null, pr_status: null, finished_at: null, finished_today: false, merge_sha: null, failure: null, summary: null, blockers: [], context: null };
	const data = { generated_at: "2026-10-15T16:00:00Z", awaiting_count: 0, job, description: null, mandate: null, timeline: [], timeline_truncated: false, files_href: null, artifact_href: null, artifact_name: null, run_href: null, reports: [], asks: [], questions: [], warnings: [] } as unknown as JobResponse;
	const requests: string[] = [];
	const globals = { window, document, location, EventSource: class extends EventTarget { close() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		fetch: async (url: string) => { requests.push(url); return new Response(JSON.stringify(url === "/api/job/cp-done" ? data : { error: "not in fixture" }), { status: url === "/api/job/cp-done" ? 200 : 503 }); } };
	const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => { await app.act(() => app.unmount(root)); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const settle = () => app.act(async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); });
	const go = async (hash: string) => { location.hash = hash; await app.act(() => { window.dispatchEvent(new window.Event("hashchange")); }); await settle(); };
	const tab = () => root.querySelector(".job-detail")?.getAttribute("data-tab");
	await app.act(() => app.mount(root));
	await settle();
	assert.equal(tab(), "transcript", "the explicit link opens Transcript, not the phone's default Details");
	await go("#job/cp-done");
	assert.equal(tab(), "details", "an ordinary Job link keeps the phone default");
	await go("#job/cp-done?tab=transcript");
	assert.equal(tab(), "transcript", "Forward to the explicit link lands on Transcript again");
	assert.deepEqual([...new Set(requests.filter(url => url.startsWith("/api/job/cp-done") && !url.includes("/transcript")))], ["/api/job/cp-done"], "the job read never carries the tab");
});

const chats = (rendered: string) => parseHTML(`<div>${rendered}</div>`).document.querySelector(".session-sidebar")!;
const operatorLine = (data: SessionsResponse) => {
	const row = chats(html(data)).querySelector('section[aria-label="Operator"] .session-choice')!;
	return [row.querySelector("small")!.textContent, row.querySelector("time")?.getAttribute("datetime") ?? null];
};

test("Chats: the Operator preview is the newest loaded message of the latest file; history and other tiers never borrow it", () => {
	// PR 3: the preview reads the unfiltered transcript, so it must not show another tier's text, an older file's last
	// line as if it were current, or a tool call. Decisions and the parent tier keep the model line.
	const at = local(15, 9), later = local(15, 10);
	const entries = [entry("a", "say", at, { text: "**Reply** with `code`\n\nand more" }), entry("t", "tool", later, { name: "bash", text: "ls" })];
	const files = { operator_sessions: [{ id: "new.jsonl", at }, { id: "old.jsonl", at }], operator_session: "new.jsonl", operator_context: { model: "m-op" } } as Partial<SessionsResponse>;
	assert.deepEqual(operatorLine({ ...view(entries), ...files }), ["Reply with code and more", at], "markdown marks dropped, tools skipped");
	assert.deepEqual(operatorLine({ ...view([...entries, entry("y", "via", later, { who: "Operator", text: "ship it" })]), ...files }), ["You: ship it", later]);
	assert.deepEqual(operatorLine({ ...view(entries), ...files, operator_session: "old.jsonl" }), ["Historical transcript", null]);
	assert.deepEqual(operatorLine({ ...view(entries), ...files, transcript: false }), ["m-op", null], "Decisions view");
	assert.deepEqual(operatorLine({ ...view(entries), ...files, selected: "parent" }), ["m-op", null], "another tier");
	assert.deepEqual(operatorLine({ ...view([]), ...files }), ["m-op", null], "nothing loaded yet");
});

test("Chats: `Waiting N` is open asks plus unacknowledged answers; unknown is `Waiting ?`, never 0; Fleet live is not threads' working", () => {
	const thread = (tag: string, state: ThreadView["state"], waiting: ThreadView["waiting"], working: number | null = 0): ThreadView => ({ id: `th-${tag}`, tag, state, waiting, counts: { messages: 3, asks: 0, answers: 0, jobs_working: working }, opened_at: local(15, 9), last_at: local(15, 9), done_at: null });
	const waiting = thread("billing", "waiting", { asks: 1, answers: 2 }), quiet = thread("ops", "open", { asks: 0, answers: 0 }), blind = thread("blind", "open", null), shut = thread("old", "done", null);
	assert.deepEqual([waiting, quiet, blind, shut].map(t => [waitingCount(t), waitingLabel(t)]), [[3, "Waiting 3"], [0, null], [null, "Waiting ?"], [null, null]], "counts.messages (3) is never shown");
	assert.equal(threadAria(blind), "blind: open, waiting unknown");
	assert.equal(threadAria(shut), "old: done", "a done thread hides its badge, so its label names no unknown count either");
	const status = { generated_at: "", availability: "ok", enabled: true, reason: null, token: "t", threads: [waiting, quiet, blind, shut], total: 4, warning: null } as ThreadsResponse;
	const threads = { status, selected: null, select() {}, done() {}, sending: null, failed: null } as unknown as ThreadsView;
	const heldIdle = { id: "cp-idle", kind: "worker", job_id: "cp-idle", phase: "held", run_phase: "idle", model: "m", live: false };
	const side = chats(html({ ...view([]), workers: [heldIdle] } as unknown as SessionsResponse, threads));
	assert.deepEqual([...side.querySelectorAll(".session-thread-waiting")].map(b => [b.textContent, b.className]), [["Waiting 3", "session-thread-waiting"], ["Waiting ?", "session-thread-waiting session-thread-waiting-unknown"]]);
	assert.equal(side.querySelector(".session-thread-working"), null, "no thread job is working");
	assert.match(side.querySelector("section:last-child h2")?.textContent ?? "", /^Fleet · 1 live$/, "a held-idle worker still counts as live");
	assert.equal(side.querySelector(".session-choice-nested strong")?.getAttribute("title"), "cp-idle", "workers nest under CP parent, full id in the title");
});

test("Chats: + in the title row opens New thread and closing it selects nothing; a selected new tag shows as a pressed row", async t => {
	const picked: (string | null)[] = [];
	const status = { generated_at: "", availability: "ok", enabled: true, reason: null, token: "t", threads: [], total: 0, warning: null } as unknown as ThreadsResponse;
	const threads = (selected: string | null) => ({ status, selected, select: (tag: string | null) => { picked.push(tag); }, done() {}, sending: null, failed: null }) as unknown as ThreadsView;
	const s = stage(t);
	await act(() => mount(s.root, view([]), threads(null)));
	await s.click(s.root.querySelector(".sessions > .session-chats-new"));
	assert.ok(s.root.querySelector('[role="dialog"]'), "the dialog opens from the Chats title");
	await s.click(s.root.querySelector(".new-thread-close"));
	assert.deepEqual([s.root.querySelector('[role="dialog"]'), picked], [null, []]);
	await act(() => mount(s.root, view([]), threads("fresh")));
	assert.equal(s.root.querySelector('.session-sidebar .session-thread-choice[aria-pressed="true"]')?.getAttribute("aria-label"), "fresh: new, no messages yet");
});

test("phone ⋯ sheet: streams, thread chips with + New, and Search are all reachable; the # filter sits under the name", async t => {
	// PR 5 moved the thread strip, streams and Search into the top bar's sheet. Closing on a chip and on Escape runs in
	// Chrome (sessions-chat-v2-browser.ts --stage pr5): linkedom's details has no reflected `open`.
	const picked: (string | null)[] = [];
	const thread = { id: "th-1", tag: "alpha", state: "open", waiting: { asks: 0, answers: 0 }, counts: { messages: 1, asks: 0, answers: 0, jobs_working: 0 }, opened_at: local(15, 9), last_at: local(15, 11), done_at: null };
	const status = { generated_at: "", availability: "ok", enabled: true, reason: null, token: "t", threads: [thread], total: 1, warning: null } as unknown as ThreadsResponse;
	const threads = { status, selected: null, select: (tag: string | null) => { picked.push(tag); }, done() {}, sending: null, failed: null } as unknown as ThreadsView;
	const s = stage(t);
	await act(() => mount(s.root, view([entry("m1", "say", local(15, 10))]), threads));
	const sheet = s.root.querySelector(".session-bar-more")! as HTMLDetailsElement;
	assert.deepEqual([...sheet.querySelectorAll(".session-bar-views > a")].map(a => a.textContent), ["Operator ↔ you", "CP parent", "Workers"]);
	assert.deepEqual([...sheet.querySelectorAll(".session-bar-threads button")].map(b => b.textContent), ["+ New", "All messages", "alpha"]);
	assert.ok([...sheet.querySelectorAll("button")].some(b => b.textContent === "Search"), "Search stays one tap into the sheet");
	assert.equal(s.root.querySelector(".session-bar-sub select")?.getAttribute("aria-label"), "Show thread", "the # filter under the name");
	await s.click(sheet.querySelector(".session-bar-threads .session-thread-new"));
	await s.click(s.root.querySelector(".new-thread-close"));
	assert.deepEqual([s.root.querySelector('[role="dialog"]'), picked], [null, []], "+ New from the sheet, then Cancel, selects nothing");
});

test("steps rows: one name column per card, the widest name up to 14ch, so every summary starts at one x", () => {
	// #320 amendment: a per-row fit-content column started each summary at its own x; the card is now one grid that
	// every row (entry, details, summary) subgrids. The browser capture fails on a clipped name or a misaligned summary.
	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/sessions.css"), "utf8");
	assert.match(css, /\.session-steps-rows \{ display: grid; grid-template-columns: 16px fit-content\(14ch\) minmax\(0,1fr\) auto;/);
	assert.match(css, /\.session-steps-rows > \.session-entry, \.session-steps-rows > \.session-entry > \.session-tool, \.session-steps-rows \.session-tool > summary \{ display: grid; grid-template-columns: subgrid; \}/);
	assert.match(css, /\.session-tool summary > code:nth-child\(2\) \{[^}]*overflow: hidden; text-overflow: ellipsis;/, "a longer name ellipsizes");
});

const option = (label: string, consequence: string) => ({ label, consequence, reply: `${label} reply` });
const awaiting = (id: string): AwaitingDetail => ({ id, project: "picp", question: `Question ${id}`, created_at: local(15, 8), options: [option("Keep", "Paused until Monday"), option("Raise", "Spends more")], recommendation: "Keep",
	source_escalation: null, job_ids: [], context: null, evidence_paths: [], reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null,
	mandate_objective: null, jobs: [], escalation: null, evidence: [] } as unknown as AwaitingDetail);
const card = (id: string, state: "open" | "answered", thread?: string) => entry(`c-${id}`, "ask", local(15, 8), { who: "Operator → you", thread, ask: { id, question: `Question ${id}`, options: [], recommendation: "Keep", state, answer: null, answered_at: null, reason: null } });
const status = (over: Partial<ControlStatusResponse> = {}) => ({ generated_at: "", enabled: true, running: true, reason: null, token: "t", busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, ...over }) as ControlStatusResponse;

test("quick replies: only one open ask carded in this transcript (and thread) is answerable; zero, two or unbound asks offer none", () => {
	const [a, b] = [awaiting("ask-aaaa"), awaiting("ask-bbbb")];
	assert.equal(replyAsk([card("ask-aaaa", "open")], [a], null), a);
	assert.equal(replyAsk([], [a], null), null, "an open ask with no card here is not attributable");
	assert.equal(replyAsk([card("ask-aaaa", "open"), card("ask-bbbb", "open")], [a, b], null), null, "two candidates: no guess");
	assert.equal(replyAsk([card("ask-aaaa", "answered")], [a], null), null, "the card's journal state decides, not the list");
	assert.equal(replyAsk([card("ask-aaaa", "open"), card("ask-bbbb", "open", "th-1")], [a, b], "th-1"), b, "a thread narrows to its own card");
	assert.equal(replyAsk([card("ask-aaaa", "open")], [a], "th-1"), null, "an unbound ask never shows inside a thread");
	assert.equal(replyAsk([card("ask-aaaa", "open")], [a], "none"), null);
	assert.equal(replyAsk([card("ask-aaaa", "open")], [], null), null, "no open ask: no chips");
});

test("quick replies render only on the latest operator transcript, never in history or another tier", () => {
	const data = { ...view([card("ask-aaaa", "open"), entry("r1", "say", local(15, 9), { text: "Which way?" })]), open_asks: [awaiting("ask-aaaa")] } as SessionsResponse;
	const control: ControlView = { status: status(), delivery: null, send() {} };
	const { document } = parseHTML(`<div>${html(data, undefined, control)}</div>`);
	const chips = document.querySelector(".session-entries > .session-replies")!;
	assert.equal(chips.previousElementSibling?.textContent?.includes("Which way?"), true, "after the newest operator-session message");
	assert.deepEqual([...chips.querySelectorAll("button")].map(b => [b.textContent, b.getAttribute("title")]), [["Keep", "Paused until Monday"], ["Raise", "Spends more"]], "verbatim labels and consequences");
	assert.equal(chips.querySelector(".session-reply-recommended")?.textContent, "Keep");
	const history = { ...data, operator_sessions: [{ id: "new.jsonl", at: local(16, 9) }, { id: "op.jsonl", at: local(15, 9) }], operator_session: "op.jsonl" };
	assert.doesNotMatch(html(history, undefined, control), /session-replies/, "an older file never answers the live ask");
	assert.doesNotMatch(html({ ...data, selected: "parent" }, undefined, control), /session-replies/);
});

test("quick replies send the exact typed answer once; a sent answer holds the chips until the journal closes the ask; a failure re-enables", async t => {
	const s = stage(t), sends: ControlBody[] = [], ask = awaiting("ask-aaaa");
	const control = (delivery: ControlView["delivery"] = null): ControlView => ({ status: status(), delivery, send: body => { sends.push(body); } });
	await act(() => replies(s.root, ask, control()));
	await s.click(s.root.querySelector(".session-reply"));
	assert.deepEqual(sends, [{ kind: "answer", ask_id: "ask-aaaa", label: "Keep" }]);
	await act(() => replies(s.root, ask, control({ id: "dc-1", state: "queued", reason: null, ask_id: "ask-aaaa" })));
	assert.ok([...s.root.querySelectorAll("button")].every(b => (b as HTMLButtonElement).disabled), "no second answer while the first is on its way");
	assert.match(s.root.querySelector("[role=status]")!.textContent!, /^Queued · dc-1 — the options close when the session records the answer$/);
	await act(() => replies(s.root, ask, control({ id: null, state: "failed", reason: "token expired", ask_id: "ask-aaaa" })));
	assert.equal(s.root.querySelector("[role=alert]")?.textContent, "Failed: token expired");
	await s.click(s.root.querySelectorAll(".session-reply")[1]!);
	assert.deepEqual(sends.at(-1), { kind: "answer", ask_id: "ask-aaaa", label: "Raise" }, "retry is one click");
	await act(() => replies(s.root, ask, { status: status({ enabled: false, reason: "Dashboard control is off" }), delivery: null, send: () => assert.fail("disabled") }));
	assert.ok([...s.root.querySelectorAll("button")].every(b => (b as HTMLButtonElement).disabled));
	assert.equal(s.root.querySelector(".session-replies-state")?.textContent, "Dashboard control is off");
});

test("quick replies: a chip click holds them through a later composer send, a reload and a queued card reply, until the ask closes", async t => {
	// #342 review (a): the chips read only the latest `delivery`, so a composer send that replaced it re-enabled them and
	// a second chip could answer the same ask twice. Recorded (status.recent) and pending answers hold them as well.
	const s = stage(t), sends: ControlBody[] = [], ask = awaiting("ask-aaaa");
	const control = (over: Partial<ControlView> = {}): ControlView => ({ status: status(), delivery: null, send: body => { sends.push(body); }, ...over });
	const held = () => [...s.root.querySelectorAll(".session-reply")].every(b => (b as HTMLButtonElement).disabled);
	await act(() => replies(s.root, ask, control()));
	await s.click(s.root.querySelector(".session-reply"));
	await act(() => replies(s.root, ask, control({ delivery: { id: "dc-2", state: "queued", reason: null, ask_id: null } })));
	assert.ok(held(), "the composer's send replaced `delivery`; the chips stay disabled");
	assert.match(s.root.querySelector(".session-replies [role=status]")!.textContent!, /^An answer is on its way/);
	assert.deepEqual(sends, [{ kind: "answer", ask_id: "ask-aaaa", label: "Keep" }]);
	await act(() => unmount(s.root));
	await act(() => replies(s.root, ask, control({ status: status({ recent: [{ id: "dc-1", kind: "answer", state: "delivered", at: local(15, 9), reason: null, ask_id: "ask-aaaa" }] }) })));
	assert.ok(held(), "after a reload, the recorded answer holds them");
	await act(() => unmount(s.root));
	const queued = { key: "k", id: "dc-3", at: local(15, 9), state: "queued", reason: null, ask_id: "ask-aaaa", body: { kind: "message", text: "other" } } as NonNullable<ControlView["pending"]>[number];
	await act(() => replies(s.root, ask, control({ pending: [queued] })));
	assert.ok(held(), "a queued free-text reply to the same card holds them");
	await act(() => replies(s.root, ask, control({ pending: [{ ...queued, state: "failed" }] })));
	assert.ok(!held(), "a failed one does not");
	const closed = { ...view([card("ask-aaaa", "answered")]), open_asks: [ask] } as SessionsResponse;
	assert.doesNotMatch(html(closed, undefined, control()), /session-replies/, "the journal closing the ask removes them");
});

test("quick replies: a chip answer that fails after a composer send replaced `delivery` re-enables the chips", async t => {
	// Regression: `mine` was null after the composer send, so `clicked` never reset and the chips stayed disabled.
	const s = stage(t), ask = awaiting("ask-aaaa");
	const control = (over: Partial<ControlView> = {}): ControlView => ({ status: status(), delivery: null, send() {}, ...over });
	const held = () => [...s.root.querySelectorAll(".session-reply")].every(b => (b as HTMLButtonElement).disabled);
	await act(() => replies(s.root, ask, control()));
	await s.click(s.root.querySelector(".session-reply"));
	const sent = { id: "dc-2", state: "queued", reason: null, ask_id: null } as const;
	await act(() => replies(s.root, ask, control({ delivery: sent })));
	assert.ok(held());
	const failed = { key: "k", id: null, at: local(15, 9), state: "failed", reason: "x", ask_id: "ask-aaaa", body: { kind: "message", text: "other" } } as NonNullable<ControlView["pending"]>[number];
	await act(() => replies(s.root, ask, control({ delivery: { ...sent, state: "delivered" }, pending: [failed] })));
	assert.ok(!held(), "the failed answer re-enables them");
});

test("header: Operator with the recorded state and model; missing busy is unknown, history and an unreadable status say so", () => {
	const data = { ...view([]), operator_context: { model: "fixture-model" } } as SessionsResponse;
	const state = (control?: ControlView, over: Partial<SessionsResponse> = {}) => /<span class="session-heading-state">[\s\S]*?<\/span><span>([^<]*)<\/span>/.exec(html({ ...data, ...over }, undefined, control))?.[1];
	const live = (over: Partial<ControlStatusResponse>) => ({ status: status(over), delivery: null, send() {} }) as ControlView;
	assert.match(html(data, undefined, live({})), /<strong>Operator<\/strong>/);
	assert.equal(state(live({})), "Idle · fixture-model");
	assert.equal(state(live({ busy: true })), "Working · fixture-model");
	assert.equal(state(live({ busy: undefined })), "Status unknown · fixture-model", "no busy field is never Idle");
	assert.equal(state({ status: { error: "HTTP 500" }, delivery: null, send() {} } as unknown as ControlView), "Status unavailable · fixture-model");
	assert.equal(state(undefined), "Checking status · fixture-model");
	assert.equal(state(live({}), { operator_sessions: [{ id: "new.jsonl", at: local(16, 9) }, { id: "op.jsonl", at: local(15, 9) }], operator_session: "op.jsonl" }), "Historical transcript");
});

test("header: avatar, name, state, the # All messages pill and ⋮; the file picker and Tools N live in the ⋮ menu", () => {
	// Amendment 2: the heading row was a wide native select plus the file picker and Tools N; both moved into ⋮.
	const data = { ...view([entry("t1", "tool", local(16, 9), { name: "read", summary: "Read 1 line" })]), operator_sessions: [{ id: "new.jsonl", at: local(16, 9) }, { id: "op.jsonl", at: local(15, 9) }], operator_session: "new.jsonl" } as SessionsResponse;
	const threads = { status: { generated_at: "", availability: "ok", enabled: true, reason: null, token: "t", threads: [], total: 0, warning: null }, selected: null, select() {}, done() {}, sending: null, failed: null } as unknown as ThreadsView;
	const doc = parseHTML(`<body>${html(data, threads, { status: status({}), delivery: null, send() {} } as ControlView)}</body>`).document;
	const heading = doc.querySelector(".session-heading")!;
	assert.equal(heading.querySelector(".session-thread-filter.thread-pill .thread-pill-label")?.textContent, "All messages");
	assert.equal(heading.querySelector(".session-file-picker, .session-tools-toggle"), null, "the heading carries no file picker or Tools N");
	const menu = doc.querySelector(".shell-more .session-menu")!;
	assert.equal(menu.querySelector("select")?.getAttribute("aria-label"), "Operator session file");
	assert.equal(menu.querySelector(".session-tools-toggle")?.textContent, "Tools 1");
});
