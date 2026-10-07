/** cp-xmw2 S5: operator threads in the Full transcript — the filter, chips, sidebar, composer picker and Mark done. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import type { AwaitingDetail, ControlStatusResponse, SessionEntry, ThreadsResponse, ThreadView } from "../src/viewer/api-types.ts";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { assignThreads } from "../src/viewer/thread-turns.ts";
import { LAYOUT } from "../src/contracts.ts";
import { type ControlBody, type ControlView, deliveryLine } from "../viewer-app/control.ts";
import { normalizeTag, readThreads, sendThreadDone, threadFilter, type ThreadsView, visibleEntries } from "../viewer-app/threads.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const built = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import ssr from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {OperatorComposer} from "./viewer-app/components/OperatorComposer.tsx"; export {act}; export const screen=(data,control,threads)=>ssr(h(Sessions,{data,control,threads})); export const mount=(root,control,thread)=>render(h(OperatorComposer,{control,thread}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const { act, screen, mount, unmount } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; screen: (data: unknown, control?: ControlView, threads?: ThreadsView) => string;
	mount: (root: unknown, control: ControlView, thread?: ThreadsView) => void; unmount: (root: unknown) => void;
};

const B = "th-0123456789ab", O = "th-aaaaaaaaaaaa", D = "th-dddddddddddd";
const thread = (id: string, tag: string, state: ThreadView["state"], waiting: ThreadView["waiting"] = { asks: 0, answers: 0 }): ThreadView => ({ id, tag, state, waiting, counts: { messages: 1, asks: 0, answers: 0 }, opened_at: "2026-10-06T08:00:00Z", last_at: "2026-10-06T08:00:00Z", done_at: state === "done" ? "2026-10-06T09:00:00Z" : null });
const list = (over: Partial<ThreadsResponse> = {}): ThreadsResponse => ({ generated_at: "2026-10-06T09:00:00Z", availability: "ok", enabled: true, reason: null, token: "k".repeat(64), threads: [thread(B, "billing-bug", "waiting", { asks: 1, answers: 1 }), thread(O, "ops", "open"), thread(D, "old", "done")], total: 3, warning: null, ...over });
const threads = (over: Partial<ThreadsView> = {}): ThreadsView => ({ status: list(), selected: null, select: () => {}, done: () => {}, sending: null, failed: null, ...over });
const entry = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ id, at: "2026-10-06T08:00:00Z", kind: "say", who: "Assistant", text: `text ${id}`, name: null, send_id: null, tag: null, failed: false, trace: [], ...extra });
const status: ControlStatusResponse = { generated_at: "2026-10-06T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false } };
const detail = (id: string): AwaitingDetail => ({ id, project: "demo", question: `Question ${id}`, created_at: "2026-10-06T08:20:00Z", recommendation: "Keep", source_escalation: null, job_ids: [], context: null, evidence_paths: [], options: [{ label: "Keep", consequence: "Paused", reply: `${id}: Keep` }], reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null, mandate_objective: null, jobs: [], escalation: null, evidence: [] });

test("visibleEntries: All is unchanged; shared entries only inside the thread's own span; none and an empty thread show nothing", () => {
	const entries = [
		entry("shared-before", { kind: "system", shared: true }),
		entry("other-before", { thread: O }),
		entry("own-first", { thread: B }),
		entry("shared-inside", { kind: "system", shared: true }),
		entry("other-inside", { thread: O }),
		entry("loose-inside"),
		entry("own-last", { thread: B }),
		entry("shared-after", { kind: "system", shared: true }),
	];
	const ids = (filter: string | null) => visibleEntries(entries, filter).map(e => e.id);
	assert.deepEqual(ids(null), entries.map(e => e.id), "All");
	assert.deepEqual(ids(threadFilter(list(), null)), entries.map(e => e.id));
	assert.deepEqual(ids(B), ["own-first", "shared-inside", "own-last"]);
	assert.deepEqual(ids(threadFilter(list(), "billing-bug")), ["own-first", "shared-inside", "own-last"]);
	assert.deepEqual(ids(O), ["other-before", "shared-inside", "other-inside"], "shared outside this thread's span stays out; the other thread's own entries do not leak in");
	assert.equal(threadFilter(list(), "brand-new"), "none");
	assert.deepEqual(ids("none"), []);
	assert.deepEqual(ids(threadFilter(list(), "brand-new")), []);
	assert.deepEqual(ids("th-0123456789ac"), [], "a thread with no own entries");
	assert.equal(threadFilter({ error: "HTTP 403" }, "billing-bug"), null, "no list: nothing is filtered");
	assert.equal(threadFilter(list({ availability: "unavailable", threads: [] }), "billing-bug"), null);
	assert.equal(threadFilter(list({ availability: "missing", threads: [] }), "billing-bug"), "none", "a missing journal is an empty list");
	assert.equal(normalizeTag("  Billing   Bug "), "billing-bug");
	assert.equal(normalizeTag("-x"), null);
	assert.equal(normalizeTag("a".repeat(33)), null);
});

test("Sessions: chips with aria-pressed and All by default, the sidebar section, the filter, and every open ask still pinned", async t => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const full = sessionsView({ home: home.path, stateDir: join(home.path, LAYOUT.state) }, "you", null, { transcript: true })!;
	full.entries = [entry("e-bill", { text: "about billing", thread: B }), entry("e-ops", { text: "about ops", thread: O }), entry("e-relay", { kind: "system", who: "cp-bridge", text: "relay line", tag: "bridge", shared: true }), entry("e-ops-tail", { text: "ops tail", thread: O }), entry("e-after", { kind: "system", who: "cp-bridge", text: "after relay", tag: "bridge", shared: true })];
	full.open_asks = [detail("ask-aaaa"), detail("ask-bbbb")];
	const control: ControlView = { status, delivery: null, send: () => {} };

	const html = screen(full, control, threads()), all = parseHTML(`<body>${html}</body>`).document;
	const chips = [...all.querySelectorAll("nav.session-threads[aria-label=Threads] button")].map(b => [b.textContent, b.getAttribute("aria-pressed")]);
	assert.deepEqual(chips, [["All", "true"], ["billing-bug · 2", "false"], ["ops", "false"]], "All first and pressed; done threads are not chips");
	assert.equal(all.querySelector('nav.session-threads button[aria-pressed="false"]')?.getAttribute("aria-label"), "billing-bug: waiting, 1 open ask(s), 1 unacknowledged answer(s)");
	const nav = all.querySelector("nav.session-threads")!;
	assert.deepEqual([nav.previousElementSibling?.getAttribute("class"), nav.nextElementSibling?.getAttribute("class")], ["session-pinned", "operator-composer"], "chips sit between the pinned decisions and the composer");
	const sidebar = all.querySelector('.session-sidebar section[aria-label="Threads"]');
	assert.ok(sidebar, "a Threads section in the sidebar");
	assert.equal(sidebar!.previousElementSibling?.querySelector("h2")?.textContent, "Operator ↔ you");
	assert.deepEqual([...sidebar!.querySelectorAll(":scope > button, :scope > .session-thread-row > button")].map(b => b.textContent), ["All", "billing-bug · 2waiting", "opsopen"]);
	assert.match(sidebar!.querySelector("details > summary")?.textContent ?? "", /^Done \(1\)$/);
	assert.match(html, /about billing/); assert.match(html, /about ops/);
	assert.doesNotMatch(screen({ ...full, transcript: false }, control, threads()), /session-threads|<h2>Threads/, "Decisions view: no threads");

	const filtered = screen(full, control, threads({ selected: "ops" }));
	assert.match(filtered, /about ops/); assert.match(filtered, /ops tail/); assert.match(filtered, /relay line/, "a shared entry between this thread's own entries is shown");
	assert.doesNotMatch(filtered, /after relay/, "a shared entry after the last own entry stays out");
	assert.doesNotMatch(filtered, /about billing/);
	assert.match(filtered, /2 decisions waiting/, "the pinned section is never filtered");
	assert.match(filtered, /Question ask-aaaa[\s\S]*Question ask-bbbb/);
	const fresh = screen(full, control, threads({ selected: "brand-new" }));
	assert.match(fresh, /No messages in brand-new yet/);
	assert.doesNotMatch(fresh, /about ops|about billing|relay line|after relay/);
	assert.match(fresh, /<button type="button" class="session-thread-chip" aria-pressed="true">brand-new<\/button>/, "a new tag shows as the pressed chip");
	assert.doesNotMatch(screen(full, control, threads({ status: { error: "threads are served only under --require-tailnet" } })), /session-threads|aria-label="Thread"/, "no list: no chips, no picker");
});

test("Mark done is disabled while waiting, with the reason as its title; enabled on an open thread; a refusal is an alert", async t => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const full = { ...sessionsView({ home: home.path, stateDir: join(home.path, LAYOUT.state) }, "you", null, { transcript: true })!, entries: [] };
	const doneButtons = (view: ThreadsView) => [...parseHTML(`<body>${screen(full, undefined, view)}</body>`).document.querySelectorAll("button.session-thread-done")];
	const waiting = doneButtons(threads({ selected: "billing-bug" }));
	assert.equal(waiting.length, 2, "one on the chip row, one in the sidebar");
	for (const button of waiting) {
		assert.equal(button.hasAttribute("disabled"), true);
		assert.equal(button.getAttribute("title"), "Answer or acknowledge first: 1 open ask(s), 1 unacknowledged answer(s)");
	}
	for (const button of doneButtons(threads({ selected: "ops" }))) assert.equal(button.hasAttribute("disabled"), false);
	for (const button of doneButtons(threads({ selected: "ops", status: list({ enabled: false, token: null, reason: "Dashboard control is off: opt-out" }) }))) assert.equal(button.getAttribute("title"), "Dashboard control is off: opt-out");
	assert.equal(doneButtons(threads()).length, 0, "nothing selected, no Mark done");
	assert.match(screen(full, undefined, threads({ selected: "ops", failed: { id: O, reason: "answer or acknowledge first" } })), /role="alert">Not done: answer or acknowledge first/);
});

test("composer picker: a selected tag rides the send; New thread… normalizes and refuses a bad tag", async t => {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const originals = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.defineProperty(globalThis, "window", { configurable: true, value: window });
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const root = document.getElementById("root")!;
	const sends: ControlBody[] = [], picked: Array<string | null> = [];
	const control: ControlView = { status, delivery: null, send: body => { sends.push(body); } };
	const fire = async (el: Element, type: string) => act(() => el.dispatchEvent(new window.Event(type, { bubbles: true })));
	const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; await fire(el, "input"); };
	const sendButton = () => root.querySelector("button.operator-composer-send")!;

	await act(() => mount(root, control, threads({ selected: "ops", select: tag => { picked.push(tag); } })));
	const select = root.querySelector('select[aria-label="Thread"]') as HTMLSelectElement;
	assert.deepEqual([...select.querySelectorAll(":scope > option")].map(o => o.textContent), ["No thread", "billing-bug · 2", "ops", "New thread…"]);
	assert.deepEqual([...select.querySelectorAll("optgroup[label=Done] option")].map(o => o.textContent), ["old"]);
	assert.ok(root.innerHTML.indexOf("operator-composer-thread") < root.innerHTML.indexOf("operator-composer-row"), "the picker sits above the text row");
	await typeInto(root.querySelector("textarea")!, "hello");
	await fire(sendButton(), "click");
	assert.deepEqual(sends, [{ kind: "message", text: "hello", thread: "ops" }]);
	await act(() => unmount(root));

	await act(() => mount(root, control, threads({ select: tag => { picked.push(tag); } })));
	await typeInto(root.querySelector("textarea")!, "plain");
	await fire(sendButton(), "click");
	assert.deepEqual(sends.at(-1), { kind: "message", text: "plain" }, "No thread: no thread key");
	const picker = root.querySelector('select[aria-label="Thread"]') as HTMLSelectElement;
	for (const option of picker.querySelectorAll("option")) option.toggleAttribute("selected", option.textContent === "New thread…");
	Object.defineProperty(picker, "value", { configurable: true, value: "+new" });
	await fire(picker, "change");
	const input = () => root.querySelector('input[aria-label="New thread tag"]') as HTMLInputElement;
	assert.equal(input().getAttribute("maxlength") ?? input().getAttribute("maxLength"), "32");
	const use = () => [...root.querySelectorAll(".operator-composer-thread button")].find(b => b.textContent === "Use")!;
	await typeInto(input(), "-x");
	assert.equal(use().hasAttribute("disabled"), true);
	assert.match(root.querySelector('.operator-composer-thread [role="alert"]')?.textContent ?? "", /1-32 of a-z 0-9 -, starting with a letter or digit/);
	await typeInto(input(), "  Billing   Fix ");
	assert.equal(use().hasAttribute("disabled"), false);
	await fire(use(), "click");
	assert.deepEqual(picked, ["billing-fix"], "the tag is normalized the server's way");
	await act(() => unmount(root));
	await act(() => mount(root, control, threads({ status: list({ availability: "unavailable", threads: [], warning: "x" }) })));
	assert.equal(root.querySelector('select[aria-label="Thread"]'), null, "an unreadable list hides the picker");
	await act(() => unmount(root));
});

test("sendThreadDone maps 202 and 409; readThreads maps a 403; deliveryLine shows an unrecorded thread; CSS rules", async () => {
	const calls: Array<[string, RequestInit | undefined]> = [];
	const accepted = async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ id: O, state: "done", done_at: "2026-10-06T09:00:00Z" }), { status: 202 }); };
	assert.deepEqual(await sendThreadDone(accepted, "k", O), { id: O, state: "done", done_at: "2026-10-06T09:00:00Z" });
	assert.equal(calls[0]![0], "/api/threads/done");
	assert.deepEqual(calls[0]![1]?.headers, { "content-type": "application/json", "x-cp-control-token": "k" });
	assert.equal(calls[0]![1]?.body, `{"id":"${O}"}`);
	const waiting = async () => new Response(JSON.stringify({ error: "answer or acknowledge first: 1 open ask(s), 0 unacknowledged answer(s) in ops" }), { status: 409 });
	assert.deepEqual(await sendThreadDone(waiting, "k", O), { error: "answer or acknowledge first: 1 open ask(s), 0 unacknowledged answer(s) in ops", status: 409 });
	assert.deepEqual(await readThreads(async () => new Response(JSON.stringify({ error: "threads are served only under --require-tailnet" }), { status: 403 })), { error: "threads are served only under --require-tailnet" });

	const line = deliveryLine({ id: "dc-20261006080000-89abcdef", state: "delivered", reason: "thread not recorded: EACCES", ask_id: null });
	assert.equal(line, "Delivered to the session · dc-20261006080000-89abcdef · thread not recorded: EACCES");
	assert.equal(deliveryLine({ id: "dc-1", state: "queued", reason: null, ask_id: null }), "Queued · dc-1");

	const css = readFileSync(join(REPO_ROOT, "viewer-app/screens/sessions.css"), "utf8"), desktop = css.indexOf("@media (min-width: 900px)");
	assert.match(css.slice(desktop), /\.session-threads \{ display: none; \}/, "no chips at 900 px and up");
	assert.doesNotMatch(css.slice(0, desktop), /\.session-threads \{[^}]*display: none/);
	assert.match(css, /\.session-thread-chip \{[^}]*min-height: 44px/);
	assert.match(css, /\.session-threads \{[^}]*overflow-x: auto/);
	const control = readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8"), phone = control.lastIndexOf("@media (max-width: 899px)");
	assert.match(control.slice(phone), /\.operator-composer-thread select, \.operator-composer-thread input \{ font-size: 16px; \}/, "16 px fields on the phone");
});

test("a composer send whose thread was not recorded shows the reason as an alert, never hidden on the phone", async t => {
	const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
	const root = document.getElementById("root")!;
	await act(() => mount(root, { status, delivery: { id: "dc-20261006080000-89abcdef", state: "delivered", reason: "thread not recorded: EACCES", ask_id: null }, send: () => {} }));
	const p = root.querySelector(".operator-composer-delivery")!;
	assert.equal(p.getAttribute("role"), "alert");
	assert.equal(p.classList.contains("operator-composer-failed"), true);
	assert.match(p.textContent ?? "", /thread not recorded: EACCES/);
	await act(() => unmount(root));
});

test("bound job notices and main replies obey #155's span filter; empty threads stay empty and All is unchanged", t => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const notice = (id: string, job: string) => entry(id, { kind: "system", who: "cp-bridge", text: `notice ${id}`, bridge: { kind: "cp-ci", job, id: null, receipt: null } });
	const entries = [notice("before", "cp-unbound"), notice("owned", "cp-one"), entry("reply", { text: "long reply " + "word ".repeat(500) }), entry("compact", { kind: "system", who: "compaction", text: "Context compacted" }), notice("owned-again", "cp-one"), entry("tail"), notice("after", "cp-unbound")];
	assignThreads(entries, new Map([["cp-one", B]]));
	assert.equal(visibleEntries(entries, null), entries, "All retains the same entries and order");
	assert.deepEqual(visibleEntries(entries, B).map(e => e.id), ["owned", "reply", "compact", "owned-again", "tail"]);
	assert.deepEqual(visibleEntries(entries, O), [], "no own entries");
	assert.deepEqual(visibleEntries(entries, "none"), []);
	const full = { ...sessionsView({ home: home.path, stateDir: join(home.path, LAYOUT.state) }, "you", null, { transcript: true })!, entries };
	const owned = screen(full, undefined, threads({ selected: "billing-bug" }));
	assert.match(owned, /notice owned/);
	assert.ok(owned.includes("long reply " + "word ".repeat(500)));
	assert.match(owned, /Context compacted/);
	assert.doesNotMatch(owned, /notice before|notice after/);
	assert.doesNotMatch(screen(full, undefined, threads({ selected: "ops" })), /notice owned|long reply|Context compacted/);
	assert.match(screen(full, undefined, threads({ selected: "brand-new" })), /No messages in brand-new yet/);
});
