/**
 * cp-hidetools: tool calls are hidden by default in every view's transcript, one
 * remembered toggle (localStorage, shared by all views) shows them, a run of
 * consecutive hidden calls collapses to one faint line that opens that run alone,
 * and messages, notices and cards are never hidden.
 *
 * cp-chat-polish: a cp-bridge notice starts collapsed to its first line, its `paths:` block a list of
 * links; the operator's and the assistant's messages are never collapsed.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { join } from "node:path";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import type { SessionEntry } from "../src/viewer/api-types.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export {act}; export const mount=(root,data,control)=>render(h(Sessions,{data,control}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (run: () => void | Promise<void>) => Promise<void>;
	mount: (root: Element, data: unknown, control?: unknown) => void;
	unmount: (root: Element) => void;
};

const TRANSCRIPT = { transcript: true } as const;
const KEY = "cp-sessions-tool-calls";
const at = "2026-09-27T08:24:05Z";
const entry = (id: string, kind: SessionEntry["kind"], over: Partial<SessionEntry> = {}): SessionEntry => ({ id, at, kind, who: "assistant", text: id, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });

/** A Full transcript built from the given entries, over a scratch home. */
function fullTranscript(t: TestContext, entries: SessionEntry[]) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const data = sessionsView({ home: home.path, stateDir: join(home.path, LAYOUT.state) }, "you", null, TRANSCRIPT)!;
	data.entries = entries;
	return data;
}

/** The screen mounted in a real DOM, with a localStorage the test owns. */
function stage(t: TestContext, refuseWrites = false) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { if (refuseWrites) throw new Error("QuotaExceededError"); store.set(key, value); } } });
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(async () => { await act(() => unmount(root)); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	return {
		root, store,
		click: (node: Element | null) => act(() => { node!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); }),
		toggle: () => root.querySelector(".session-tools-toggle")!,
		lines: () => [...root.querySelectorAll(".session-tools")].map(line => line.textContent),
		tools: () => [...root.querySelectorAll(".session-tool")].map(tool => tool.textContent!),
	};
}

test("tool calls hide by default, the toggle remembers next time, and a run opens alone", async (t) => {
	const data = fullTranscript(t, [
		entry("m1", "say", { who: "Operator", text: "MESSAGE-ONE" }),
		entry("t1", "tool", { name: "read", text: "TOOL-ONE", summary: "Read 42 lines" }),
		entry("t2", "tool", { name: "bash", text: "TOOL-TWO", summary: "Ran npm test" }),
		entry("t3", "tool", { name: "read", text: "TOOL-THREE", summary: "Read 8 lines" }),
		entry("m2", "say", { text: "MESSAGE-TWO" }),
		entry("t4", "tool", { name: "read", text: "TOOL-FOUR", summary: "Read 2 lines" }),
		entry("s1", "system", { who: "cp-bridge", tag: "bridge", text: "SYSTEM-NOTICE" }),
		entry("ask-aa", "ask", { who: "Operator → you", tag: "awaiting you", text: "CARD-QUESTION", ask_id: "ask-aa", ask: { id: "ask-aa", question: "CARD-QUESTION", recommendation: "Keep", state: "open", answer: null, answered_at: null, reason: null, options: [{ label: "Keep", consequence: "Paused", reply: "ask-aa: Keep" }] } }),
	]);
	const { root, store, click, toggle, lines, tools } = stage(t);

	await act(() => mount(root, data));

	// Hidden by default: no tool entry renders, each run is one faint line with its count.
	assert.deepEqual(tools(), [], "no tool call renders before the toggle");
	assert.deepEqual(lines(), ["· 3 tool calls ·", "· 1 tool call ·"], "consecutive calls collapse into one line carrying the hidden count");
	assert.equal(toggle().textContent, "Show tool calls (4)", "the toggle counts everything the transcript hides");
	assert.equal(toggle().getAttribute("aria-pressed"), "false");

	// Messages, notices and cards are never hidden.
	for (const text of ["MESSAGE-ONE", "MESSAGE-TWO", "SYSTEM-NOTICE"]) assert.match(root.textContent!, new RegExp(text));
	assert.match(root.textContent!, /CARD-QUESTION/, "an open decision card survives the collapse");

	// One run opens alone; the toggle keeps counting what is still hidden.
	await click(root.querySelectorAll(".session-tools")[0]!);
	assert.deepEqual(tools().map(text => /TOOL-\w+/.exec(text)?.[0]), ["TOOL-ONE", "TOOL-TWO", "TOOL-THREE"], "only the clicked run expands");
	assert.deepEqual(lines(), ["· 3 tool calls ·", "· 1 tool call ·"], "the line stays as that run's collapse handle, and the other run is untouched");
	assert.equal(toggle().textContent, "Show tool calls (1)");
	await click(root.querySelectorAll(".session-tools")[0]!);
	assert.deepEqual(tools(), [], "clicking the line again collapses that run");

	// The toggle shows everything, remembers it, and a remount (another view) reads it back.
	await click(toggle());
	assert.equal(tools().length, 4, "every tool call renders once the toggle is on");
	assert.deepEqual(lines(), [], "no collapse lines while tool calls are shown");
	assert.equal(toggle().textContent, "Hide tool calls");
	assert.equal(store.get(KEY), "1", "one key is written when the operator toggles");
	await act(() => unmount(root));
	await act(() => mount(root, data));
	assert.equal(tools().length, 4, "the shown choice survives a remount");

	// Off again is remembered too.
	await click(toggle());
	assert.deepEqual(tools(), []);
	assert.equal(toggle().textContent, "Show tool calls (4)");
	assert.equal(store.get(KEY), "0");
	await act(() => unmount(root));
	await act(() => mount(root, data));
	assert.deepEqual(tools(), [], "the hidden choice survives a remount");
});

test("a long tool call keeps its head and show-all once shown", async (t) => {
	const long = "x".repeat(1300) + "-TAIL-MARKER";
	const data = fullTranscript(t, [entry("t1", "tool", { name: "read", text: long, summary: "Read 42 lines" })]);
	const { root, click, toggle, tools } = stage(t);

	await act(() => mount(root, data));
	assert.deepEqual(tools(), [], "the long tool call is hidden like any other");
	assert.equal(toggle().textContent, "Show tool calls (1)");

	await click(toggle());
	assert.equal(tools().length, 1, "the toggle shows it");
	assert.match(root.textContent!, /show all/, "its tail stays behind one show-all link");
	assert.match(root.textContent!, /-TAIL-MARKER/);
	assert.doesNotMatch(root.innerHTML, /x{1300}/, "the head is the truncation point, never the whole text");
});

test("a localStorage that refuses the write warns instead of swallowing it, and the choice still holds for this view", async (t) => {
	const data = fullTranscript(t, [entry("t1", "tool", { name: "read", text: "TOOL-ONE", summary: "Read 42 lines" })]);
	const { root, click, toggle, tools } = stage(t, true);
	const warnings: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args); };
	t.after(() => { console.warn = original; });
	await act(() => mount(root, data));
	await click(toggle());
	assert.equal(tools().length, 1, "the toggle still shows the calls for this view");
	assert.deepEqual(warnings, [["tool-call toggle not persisted: QuotaExceededError"]]);
});

test("layout: the tool-calls toggle and a collapsed bridge notice hold at 390px, and the desktop block does not override them", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/sessions.css"), "utf8");
	const desktop = css.split("@media (min-width: 900px) {")[1] ?? "";
	assert.match(css, /\.session-tools-toggle \{ display: flex;[^}]*min-height: 44px;[^}]*white-space: nowrap;[^}]*\}/, "a 44px touch target that never wraps at 390px");
	assert.match(css, /\.session-system \.session-notice-line \{[^}]*min-height: 44px;[^}]*\}/, "the collapsed notice (bridge or system) is a 44px touch target at 390px");
	assert.match(css, /\.session-system \.session-notice-line > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;[^}]*\}/, "a long first line ellipsizes instead of wrapping the row");
	assert.match(css, /\.session-notice-paths a, \.session-notice-paths code \{ min-width: 0; overflow-wrap: anywhere; \}/, "long paths wrap inside the expanded body");
	assert.doesNotMatch(desktop, /\.session-tools-toggle|\.session-bridge|\.session-notice-line|\.session-notice-paths/, "the desktop block leaves the phone rules in place at 1440px");
	assert.doesNotMatch(css, /\.session-tools-toggle[^{]*\{[^}]*display:\s*none/, "the heading toggle is not hidden at 1440");
	assert.match(css, /\.session-heading \{[^}]*overflow: visible/, "the heading row does not clip the toggle");
});

test("mobile top bar: the ⋯ sheet's tool toggle is the same remembered choice; pinned decisions collapse to one bar and close after a click", async (t) => {
	const data = fullTranscript(t, [entry("m1", "say", { who: "Operator", text: "MESSAGE-ONE" }), entry("t1", "tool", { name: "read", text: "TOOL-ONE", summary: "Read 42 lines" })]);
	const option = { label: "Keep", consequence: "Paused", reply: "ask-aa: Keep" };
	data.open_asks = [{ id: "ask-aa", project: "demo", question: "PINNED-QUESTION", created_at: at, recommendation: "Keep", source_escalation: null, job_ids: [], context: null, evidence_paths: [], options: [option], reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null, mandate_objective: null, jobs: [], escalation: null, evidence: [] }];
	const sent: unknown[] = [];
	const control = { status: { generated_at: at, enabled: true, running: true, reason: null, token: "t".repeat(64), busy: true, pending: false, session_file: "op.jsonl", recent: [] }, delivery: null, send: (body: unknown) => { sent.push(body); } };
	const { root, store, click, tools } = stage(t);
	await act(() => mount(root, data, control));

	const sheetToggle = () => root.querySelector(".session-bar-more .session-bar-sheet button[aria-pressed]")!;
	assert.equal(sheetToggle().textContent, "Show tool calls (1)");
	await click(sheetToggle());
	assert.equal(tools().length, 1, "the sheet's toggle shows tool calls");
	assert.equal(store.get(KEY), "1", "and remembers it like the heading toggle");
	assert.equal(root.querySelector(".session-tools-toggle")!.textContent, "Hide tool calls", "one state behind both toggles");

	const pinned = () => root.querySelector(".session-pinned")!;
	const bar = () => root.querySelector(".session-pinned h2 button")!;
	assert.equal(pinned().getAttribute("class"), "session-pinned", "collapsed by default");
	assert.equal(bar().textContent, "1 decision waiting ▾");
	await click(bar());
	assert.equal(pinned().getAttribute("class"), "session-pinned session-pinned-open", "tapped open into the sheet");
	assert.equal(bar().getAttribute("aria-expanded"), "true");
	await click(root.querySelector(".session-pinned .decision-card-option"));
	assert.deepEqual(sent, [{ kind: "answer", ask_id: "ask-aa", label: "Keep" }], "the card's button still answers, once");
	assert.equal(pinned().getAttribute("class"), "session-pinned", "and the sheet collapses after the click");
});

/** A cp-bridge wake as it reaches the transcript (src/cp-bridge.ts formatBridgeRelay), paths: block and all. */
const BRIDGE_TEXT = [
	"[cp-bridge wake job=cp-xrhq receipt=owner_observed]",
	"[pi-command-post-system] Mobile chat layout and the no-zoom addendum landed: https://github.com/0xb1ob/pi-command-post/pull/357.",
	"es-8d692d: \"md-9fd9d1: every named job is closed\" Recommend close.",
	"Web-search implementation cp-yxgl remains pending your approval.",
	"paths:",
	"- /home/ubuntu/workspace/pi-command-post/.pi-command-post/state/runs/cp-xrhq/artifact.md",
	"- /home/ubuntu/workspace/pi-command-post/.pi-command-post/state/runs/cp-xrhq",
	"- /home/ubuntu/workspace/pi-command-post/.pi-command-post/state/artifacts/cp-xrhq/report.md",
].join("\n");
const bridgeEntry = (): SessionEntry => entry("s1", "system", {
	who: "cp-bridge", tag: "bridge", text: BRIDGE_TEXT.split("\n").slice(1).join("\n"),
	bridge: { kind: "wake", job: "cp-xrhq", id: null, receipt: "owner_observed" },
	paths: [
		{ path: "/h/state/runs/cp-xrhq/artifact.md", href: "#job/cp-xrhq", read: null },
		{ path: "/h/state/runs/cp-xrhq", href: "#job/cp-xrhq", read: null },
		{ path: "/h/state/artifacts/cp-xrhq/report.md", href: null, read: null },
	],
});

test("a cp-bridge notice starts collapsed to its first line and opens its paths in place", async (t) => {
	const data = fullTranscript(t, [bridgeEntry()]);
	const { root, click } = stage(t);
	await act(() => mount(root, data));
	const line = () => root.querySelector(".session-notice-line")!;

	assert.equal(line().getAttribute("aria-expanded"), "false", "collapsed until tapped: nothing is remembered");
	assert.equal(root.querySelector(".session-bridge-line")!.textContent, "bridge woke cp-xrhq · owner observed", "one line: verb, job, receipt words");
	assert.equal(line().textContent, "Show notice");
	assert.doesNotMatch(root.innerHTML, /Mobile chat layout|pull\/357/, "the body and the repeated relay lines stay hidden");

	await click(line());
	assert.equal(line().getAttribute("aria-expanded"), "true");
	assert.match(root.innerHTML, /Mobile chat layout/, "the body opens in place");
	assert.deepEqual([...root.querySelectorAll(".session-notice-paths a")].map(a => [a.getAttribute("href"), a.textContent]), [["#job/cp-xrhq", "/h/state/runs/cp-xrhq/artifact.md"], ["#job/cp-xrhq", "/h/state/runs/cp-xrhq"]], "the paths: block is a compact list of links");
	assert.match(root.textContent!, /\/h\/state\/artifacts\/cp-xrhq\/report\.md/, "a path with no viewer target keeps its text, never a dead link");
	assert.doesNotMatch(root.textContent!, /paths:|^- \/h\/state/m, "the raw block is replaced by the list, not repeated");

	await click(line());
	assert.equal(line().getAttribute("aria-expanded"), "false", "and it collapses again");

	await act(() => unmount(root));
	await act(() => mount(root, data));
	assert.equal(line().getAttribute("aria-expanded"), "false", "a fresh view starts collapsed: nothing about it is remembered");
});

test("the operator's own messages and the assistant's replies are never collapsed", async (t) => {
	const data = fullTranscript(t, [
		entry("m1", "say", { who: "Operator", text: "operator words\nsecond operator line" }),
		bridgeEntry(),
		entry("m2", "say", { who: "Assistant", text: "assistant words\nsecond assistant line" }),
	]);
	const { root } = stage(t);
	await act(() => mount(root, data));

	assert.equal(root.querySelectorAll(".session-notice-line").length, 1, "only the bridge notice carries an expander");
	assert.match(root.textContent!, /operator words\nsecond operator line/, "the operator's own words are all on screen");
	assert.match(root.textContent!, /assistant words\nsecond assistant line/, "so is every assistant reply");
});
