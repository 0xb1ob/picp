/**
 * cp-wfw3: the session transcript as a chat. The prompting side's bubbles sit on the right, the session's on the
 * left; consecutive messages from one author group under one header (who and time); markdown renders as elements,
 * never HTML, with code blocks and tables scrolling inside the bubble; system and bridge entries stay compact
 * one-liners and an opened relay past six lines shows "Show more"; ask cards keep their card; the transcript stays
 * pinned to the bottom unless the reader scrolled up, when a "Jump to latest" pill brings it back.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { join } from "node:path";
import { REPO_ROOT } from "./harness/index.ts";
import type { SessionEntry, SessionsResponse } from "../src/viewer/api-types.ts";
import { time } from "../viewer-app/format.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export {blocks} from "./viewer-app/components/Markdown.tsx"; export {act}; export const html=data=>renderToString(h(Sessions,{data})); export const mount=(root,data)=>render(h(Sessions,{data}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, blocks, html, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	blocks: (text: string) => unknown[];
	act: (run: () => void | Promise<void>) => Promise<void>;
	html: (data: SessionsResponse) => string;
	mount: (root: Element, data: SessionsResponse) => void;
	unmount: (root: Element) => void;
};

const entry = (id: string, kind: SessionEntry["kind"], over: Partial<SessionEntry> = {}): SessionEntry => ({ id, at: "2026-10-04T14:00:00Z", kind, who: "Assistant", text: id, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const view = (entries: SessionEntry[]): SessionsResponse => ({ generated_at: "", selected: "you", session_id: null, parent: { id: "cp-parent", live: false }, workers: [], entries, title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false, transcript: true } as unknown as SessionsResponse);

test("markdown blocks: paragraphs keep their line breaks; lists, code, tables, quotes and headings are blocks; nothing is HTML", () => {
	assert.deepEqual(blocks("one\ntwo\n\nthree"), [{ kind: "p", text: "one\ntwo" }, { kind: "p", text: "three" }]);
	assert.deepEqual(blocks("Summary:\n- a\n- **b**\n  more of b\n1. first"), [{ kind: "p", text: "Summary:" }, { kind: "list", ordered: false, items: ["a", "**b**\nmore of b"] }, { kind: "list", ordered: true, items: ["first"] }]);
	assert.deepEqual(blocks("```ts\nconst x = 1;\n  indented\n```\nafter"), [{ kind: "code", text: "const x = 1;\n  indented" }, { kind: "p", text: "after" }]);
	assert.deepEqual(blocks("| a | b |\n| --- | :-: |\n| 1 | `2` |"), [{ kind: "table", head: ["a", "b"], rows: [["1", "`2`"]] }]);
	assert.deepEqual(blocks("## Title\n> quoted\n> twice"), [{ kind: "heading", text: "Title" }, { kind: "quote", text: "quoted\ntwice" }]);
	assert.deepEqual(blocks("| not a table |\nplain"), [{ kind: "p", text: "| not a table |\nplain" }], "a pipe line without a rule under it stays text");
	assert.deepEqual(blocks("```\nunclosed"), [{ kind: "code", text: "unclosed" }], "an unclosed fence runs to the end");
});

test("bubbles: own on the right, the session on the left, grouped under one header; cards and notices are not bubbles", () => {
	const rendered = html(view([
		entry("u1", "say", { who: "Operator", text: "first own" }),
		entry("u2", "say", { who: "Operator", text: "second own", at: "2026-10-04T14:01:00Z" }),
		entry("t1", "tool", { name: "read", summary: "Read 2 lines" }),
		entry("a1", "say", { text: "Summary:\n- **one**\n- two\n\n```\nnpm test -- a-very-long-command-line\n```\n\n| job | CI |\n| --- | --- |\n| cp-a | green |\n\n<script>alert(1)</script>", at: "2026-10-04T14:02:00Z" }),
		entry("a2", "say", { text: "grouped reply", at: "2026-10-04T14:03:00Z" }),
		entry("a3", "say", { text: "after a long gap", at: "2026-10-04T14:30:00Z" }),
		entry("d1", "via", { who: "Operator (dashboard)", tag: "dashboard", text: "from the dashboard", dashboard_id: "dc-1" }),
		entry("c1", "system", { who: "compaction", tag: "system", text: "Context compacted (182000 tokens before)" }),
		entry("ask-a1", "ask", { who: "Operator → you", tag: "awaiting you", text: "CARD", ask_id: "ask-a1", ask: { id: "ask-a1", question: "CARD", recommendation: "Keep", state: "open", answer: null, answered_at: null, reason: null, options: [] } }),
	]));
	const { document } = parseHTML(`<div id="r">${rendered}</div>`);
	const bubbles = [...document.querySelectorAll(".session-bubble")];
	assert.deepEqual(bubbles.map(b => b.getAttribute("class")), [
		"session-message session-say session-bubble session-own",
		"session-message session-say session-bubble session-own session-grouped",
		"session-message session-say session-bubble session-other",
		"session-message session-say session-bubble session-other session-grouped",
		"session-message session-say session-bubble session-other",
		"session-message session-say session-bubble session-own",
	], "a hidden tool run never splits a group; a 27-minute gap and a change of author do");
	const hm = (at: string) => time(`2026-10-04T${at}:00Z`);
	assert.deepEqual(bubbles.map(b => b.querySelector(".session-who")?.textContent ?? null), [`Operator${hm("14:00")}`, null, `Assistant${hm("14:02")}`, null, `Assistant${hm("14:30")}`, `Operator (dashboard)dashboard${hm("14:00")}`], "one header per group, its time once");
	const md = bubbles[2]!;
	assert.equal(md.querySelectorAll("ul > li").length, 2);
	assert.equal(md.querySelector("li strong")?.textContent, "one");
	assert.equal(md.querySelector("pre.md-code > code")?.textContent, "npm test -- a-very-long-command-line");
	assert.deepEqual([...md.querySelectorAll(".md-table th, .md-table td")].map(c => c.textContent), ["job", "CI", "cp-a", "green"]);
	assert.match(rendered, /&lt;script>alert\(1\)&lt;\/script>/); assert.doesNotMatch(rendered, /<script>/);
	assert.equal(document.querySelector(".session-system")?.getAttribute("class"), "session-message session-notice session-system", "compaction is a compact system row, not a bubble");
	assert.ok(document.querySelector("article.session-message.session-notice:not(.session-system) .session-ask"), "the ask card keeps its card");
	assert.match(bubbles[5]!.textContent!, /dashboard dc-1/, "a dashboard message keeps its id");
});

/** The screen mounted in a real DOM; scroll metrics are the test's own (linkedom lays nothing out). */
function stage(t: TestContext) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const metrics = { scrollHeight: 1000, clientHeight: 400 };
	const tops = new WeakMap<object, number>();
	const proto = window.HTMLElement.prototype as object;
	const saved = ["scrollHeight", "clientHeight", "scrollTop"].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
	Object.defineProperties(proto, {
		scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
		clientHeight: { configurable: true, get: () => metrics.clientHeight },
		scrollTop: { configurable: true, get(this: object) { return tops.get(this) ?? 0; }, set(this: object, value: number) { tops.set(this, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); } },
	});
	const observers: (() => void)[] = [];
	class Observer { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} }
	const originals = ["window", "document", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document], ["ResizeObserver", Observer]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => {
		await act(() => unmount(root));
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(proto, key, descriptor); else Reflect.deleteProperty(proto, key); }
		for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	});
	const scroller = () => root.querySelector(".session-transcript") as unknown as { scrollTop: number; dispatchEvent(e: Event): boolean };
	return {
		root, metrics, scroller,
		click: (node: Element | null) => act(() => { node!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); }),
		scrollTo: (top: number) => act(() => { scroller().scrollTop = top; scroller().dispatchEvent(new window.Event("scroll")); }),
		pill: () => root.querySelector(".session-new"),
		/** The entries grew with no new entry (a font swap, an opened notice): what a ResizeObserver reports. */
		grow: (height: number) => act(() => { metrics.scrollHeight = height; for (const callback of observers) callback(); }),
	};
}

test("the transcript stays pinned to the bottom unless scrolled up; the pill jumps back and re-pins", async (t) => {
	const s = stage(t);
	const entries = [entry("a1", "say"), entry("a2", "say")];
	await act(() => mount(s.root, view(entries)));
	assert.equal(s.scroller().scrollTop, 600, "opens at the newest entry");
	assert.equal(s.pill(), null);
	await s.grow(1100);
	assert.equal(s.scroller().scrollTop, 700, "late layout (fonts, an opened notice) keeps a pinned transcript at the bottom");

	await s.scrollTo(200);
	assert.equal(s.pill()?.textContent, "Jump to latest", "scrolled up: the pill offers the way back");
	s.metrics.scrollHeight = 1200;
	await act(() => mount(s.root, view([...entries, entry("a3", "say")])));
	assert.equal(s.scroller().scrollTop, 200, "a new entry never yanks a reader who scrolled up");
	await s.grow(1250);
	assert.equal(s.scroller().scrollTop, 200, "nor does late layout");
	s.metrics.scrollHeight = 1200;

	await s.click(s.pill());
	assert.equal(s.scroller().scrollTop, 800, "the pill jumps to the latest");
	assert.equal(s.pill(), null, "and goes away");
	s.metrics.scrollHeight = 1400;
	await act(() => mount(s.root, view([...entries, entry("a3", "say"), entry("a4", "say")])));
	assert.equal(s.scroller().scrollTop, 1000, "pinned again: the next entry scrolls into view");
});

test("an opened bridge relay shows six lines, the rest behind Show more; a short one shows all", async (t) => {
	const s = stage(t);
	const relay = ["[cp-bridge wake job=cp-a]", ...Array.from({ length: 10 }, (_, i) => `RELAY-${i + 1}`)].join("\n");
	await act(() => mount(s.root, view([entry("b1", "system", { who: "cp-bridge", tag: "bridge", text: relay }), entry("b2", "system", { who: "cp-bridge", tag: "bridge", text: "short\nRELAY-SHORT" })])));
	const [long, short] = [...s.root.querySelectorAll(".session-bridge")];
	await s.click(long!.querySelector(".session-notice-line"));
	assert.equal(long!.querySelector(".session-notice-rest p")!.textContent, "RELAY-1\nRELAY-2\nRELAY-3\nRELAY-4\nRELAY-5\nRELAY-6");
	assert.equal(long!.querySelector(".session-notice-more")!.textContent, "Show more (4 lines)");
	await s.click(long!.querySelector(".session-notice-more"));
	assert.match(long!.querySelector(".session-notice-rest p")!.textContent!, /RELAY-6\nRELAY-7\nRELAY-8\nRELAY-9\nRELAY-10$/);
	assert.equal(long!.querySelector(".session-notice-more"), null);
	await s.click(short!.querySelector(".session-notice-line"));
	assert.equal(short!.querySelector(".session-notice-more"), null, "nothing to hide, no Show more");
});

test("layout: bubbles cap at 85% on a phone and 75% on desktop; code and tables scroll inside; only the transcript scrolls above a fixed composer", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/sessions.css"), "utf8");
	const [phone, desktop = ""] = css.split("@media (min-width: 900px) {");
	assert.match(phone!, /\.session-bubble > \.session-body \{[^}]*max-width: 85%;[^}]*overflow-wrap: anywhere;/);
	assert.match(phone!, /\.md \.md-code \{[^}]*max-width: 100%;[^}]*overflow-x: auto;[^}]*white-space: pre;/, "a long code line scrolls inside the bubble");
	assert.match(phone!, /\.md-table \{ max-width: 100%; overflow-x: auto;/, "a wide table scrolls inside the bubble");
	assert.match(phone!, /\.session-message\.session-system \{ display: flex;[^}]*background: none; border: 0;/, "system rows are never cards");
	assert.match(desktop, /\.session-bubble > \.session-who, \.session-bubble > \.session-body \{ max-width: 75%; \}/);
	assert.match(phone!, /\.session-transcript \{ flex: 1; min-height: 0; overflow-y: auto;/, "the transcript is the one scroller");
	assert.match(readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8"), /\.operator-composer \{[^}]*flex-shrink: 0; \}/, "the composer keeps its height at the bottom of the panel");
});
