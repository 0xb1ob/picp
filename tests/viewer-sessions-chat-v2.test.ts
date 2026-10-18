/**
 * Sessions chat v2, PR 1: browser-local day separators that never sort, invent or duplicate a day, and the light theme
 * scoped to the Sessions shell (`shell-sessions`) so every other screen keeps the dark palette.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { REPO_ROOT } from "./harness/index.ts";
import type { SessionEntry, SessionsResponse } from "../src/viewer/api-types.ts";
import type { ThreadsView } from "../viewer-app/threads.ts";
import { dayKey, dayLabel, dayStarts, lastDay } from "../viewer-app/session-rows.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Shell} from "./viewer-app/components/Shell.tsx"; export {act}; export const html=(data,threads)=>renderToString(h(Sessions,{data,threads})); export const shell=screen=>renderToString(h(Shell,{current:{screen,section:null},awaiting:0,status:"live",updatedAt:null},"Content")); export const mount=(root,data,threads)=>render(h(Sessions,{data,threads}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, html, shell, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (run: () => void | Promise<void>) => Promise<void>;
	html: (data: SessionsResponse, threads?: ThreadsView) => string;
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
