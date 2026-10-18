/**
 * Sessions chat v2, PR 1: browser-local day separators that never sort, invent or duplicate a day, and the light theme
 * scoped to the Sessions shell (`shell-sessions`) so every other screen keeps the dark palette.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import type { JobResponse, SessionEntry, SessionsResponse } from "../src/viewer/api-types.ts";
import type { ThreadsView } from "../viewer-app/threads.ts";
import type { ControlView } from "../viewer-app/control.ts";
import { dayKey, dayLabel, dayStarts, lastDay, rows } from "../viewer-app/session-rows.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; export {act}; export const html=(data,threads,control)=>renderToString(h(Sessions,{data,threads,control})); export const shell=screen=>renderToString(h(Shell,{current:{screen,section:null},awaiting:0,status:"live",updatedAt:null},"Content")); export const mount=(root,data,threads)=>render(h(Sessions,{data,threads}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, html, shell, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (run: () => void | Promise<void>) => Promise<void>;
	html: (data: SessionsResponse, threads?: ThreadsView, control?: ControlView) => string;
	shell: (screen: string) => string;
	mount: (root: Element, data: SessionsResponse, threads?: ThreadsView) => void;
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
