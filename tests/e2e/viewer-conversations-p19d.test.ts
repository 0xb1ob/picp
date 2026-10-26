/**
 * Behavior 19 (P19d): the Sessions transcript's queued-message bubbles and its chat v2 rows, chats, quick replies and
 * header, as `bin/cp-view` serves them on a scratch home: real HTTP, the operator session's own dashboard-control
 * server and the served app in its linkedom tab (DOM, text and served CSS only, no layout or pixels).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInContext } from "node:vm";
import { controlConfigFile, controlInboxFile, controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../../src/dashboard-control.ts";
import { type Context, type Json, jsonl, pick, viewer, write } from "../harness/conversations.ts";
import { openTab, type Tab, until } from "../harness/dashboard.ts";

const OPERATOR = "#sessions?view=you&transcript=1";
const PENDING = "cp-operator-pending-sends";
const at = (hm: string) => `2026-10-04T${hm}:00Z`;
const line = (hm: string, message: unknown) => ({ type: "message", timestamp: at(hm), message });
const said = (hm: string, text: string) => line(hm, { role: "assistant", content: [{ type: "text", text }] });
const own = (hm: string, text: string) => line(hm, { role: "user", content: [{ type: "text", text }] });
/** Lets the tab's queued renders and any request a handler would start run. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((done) => setImmediate(done)); };
const texts = (tab: Tab, selector: string) => tab.$$(selector).map((el) => el.textContent);
const bubbles = (tab: Tab) => texts(tab, ".session-pending .md");
const bubblesAre = (tab: Tab, want: string[], what: string) => until(() => bubbles(tab), (now) => JSON.stringify(now) === JSON.stringify(want), what);
const messages = (tab: Tab) => tab.started.filter((r) => r === "POST /api/operator/message").length;
const field = (tab: Tab) => tab.$("textarea.operator-composer-input, .operator-composer textarea") as unknown as HTMLTextAreaElement;
/** The `n`th message the tab posted, once the viewer has answered it. */
const posted = async (tab: Tab, n: number) => JSON.parse((await until(() => tab.requests.filter((r) => r.path === "/api/operator/message"), (rows) => rows.length >= n, `message ${n}`))[n - 1]!.body!) as Json;
const stored = (tab: Tab) => JSON.parse(tab.storage.get(PENDING) ?? "null") as { items: Json[]; dismissed: string[] };
/** A pending send as the composer stores it in the browser. */
const pending = (id: string, text: string, extra: Json = {}) => ({ key: id, id, at: at("14:00"), state: "queued", reason: null, ask_id: null, body: { kind: "message", text }, ...extra });
const dc = (n: string) => `dc-20261004140000-0000000${n}`;
/** The minified stylesheet the served page links. */
const servedCss = async (d: { get(path: string): Promise<{ text: string }> }) => (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
/** Every declaration the served CSS gives `selector` in `sheet`, in order. */
const cssRules = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");

/** A viewer whose recorded operator transcript is `rows`, its file also the running session's; `seed` adds state. */
async function home(t: Context, rows: unknown[], seed?: (stateDir: string, file: string) => void) {
	let file = "";
	const d = await viewer(t, { seed: (stateDir, dir) => {
		file = join(dir, "pi-sessions", "chat.jsonl");
		write(file, jsonl(rows));
		write(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at: at("13:00"), session_file: file }]));
		seed?.(stateDir, file);
	} });
	return { ...d, file, rows, append: (...more: unknown[]) => { rows.push(...more); write(file, jsonl(rows)); } };
}
type Home = Awaited<ReturnType<typeof home>>;
/**
 * The operator session's dashboard-control server on `d`'s transcript and upload root; `idle()` says whether it is.
 * A send waits `wait` ms for its transcript sighting (`control.observe`) before it answers queued.
 */
async function session(t: Context, d: Home, idle: () => boolean, wait = 20) {
	const injected: string[] = [];
	const ports: ControlPorts = {
		inject: (text) => { injected.push(text); }, abort: () => {}, isIdle: idle, hasPendingMessages: () => false, sessionFile: () => d.file,
		prepareImage: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }),
	};
	const control = await startDashboardControl({ stateDir: d.stateDir, ports, deliveredWaitMs: wait, log: () => {}, uploadRoot: d.root }) as DashboardControl;
	assert.equal(control.state, "listening", JSON.stringify(control));
	t.after(() => control.stop());
	return { injected, control };
}
/** Types `text` in the composer and sends it with the button. */
async function compose(tab: Tab, text: string) {
	tab.type(await tab.find(".operator-composer textarea"), text);
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
}

// ---- queued messages: the composer's pending sends between the transcript and the box ----------------------------

test("P19-queued-bubbles: stored sends follow the newest entry in FIFO order with state, time and attachment chips; a failure offers Send again; the transcript wins", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "streaming response")]);
	await session(t, d, () => false);
	const items = [
		pending(dc("a"), "queued one", { body: { kind: "message", text: "queued one", images: ["im-fixture.png"], files: ["future-file.json"] } }),
		pending(dc("b"), "queued two", { state: "held" }),
		pending(dc("c"), "queued three", { state: "failed", reason: "connection refused" }),
	];
	const tab = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items, dismissed: [] })]]));
	await tab.find(".session-pending-failed .session-pending-again", (b) => !b.hasAttribute("disabled"));
	const shown = tab.$$(".session-pending");
	assert.deepEqual(bubbles(tab), ["queued one", "queued two", "queued three"], "each send stays visible, not just the last delivery line");
	assert.ok(shown.every((b) => b.classList.contains("session-own")), "own bubbles");
	assert.deepEqual(shown.map((b) => b.querySelector(".session-pending-badge")?.textContent), ["Queued · 1 of 2", "Queued · 2 of 2", "Failed"]);
	assert.equal(shown[0]!.querySelector("time")?.getAttribute("datetime"), at("14:00"));
	assert.deepEqual([...shown[0]!.querySelectorAll(".session-pending-attachments li")].map((li) => li.textContent), ["Image · im-fixture.png", "File · future-file.json"]);
	assert.equal(shown[1]!.querySelector(".session-pending-detail")?.textContent, "Held until an operator session attaches");
	assert.match(shown[2]!.textContent!, /Failed: connection refused.*Send again.*Discard/);
	assert.ok(tab.$(".session-pending-live[aria-live=polite]"), "a polite live region reads the queue");
	assert.equal(tab.$(".session-entries")?.lastElementChild, shown[2], "the queue sits after the newest transcript entry");
	assert.match(shown[0]!.previousElementSibling?.textContent ?? "", /streaming response/);
	d.append(own("14:01", `queued one\n\n[cp-dashboard ${dc("a")} — from the dashboard]`));
	tab.refresh();
	assert.deepEqual(await bubblesAre(tab, ["queued two", "queued three"], "the arrived send promoted"), ["queued two", "queued three"], "the transcript entry replaces its bubble");
	assert.equal(texts(tab, ".session-bubble .md").filter((s) => s === "queued one").length, 1, "one bubble, never a duplicate");
	assert.ok((await until(() => stored(tab).dismissed, (ids) => ids.includes(dc("a")), "the promoted id dismissed")).includes(dc("a")));
});

/** Opens the operator transcript in a tab whose own `localStorage` is `storage`, set before the screen mounts. */
async function tabWith(t: Context, d: Home, storage: unknown) {
	const tab = await openTab(t, d.port, "#settings");
	tab.globals.localStorage = storage;
	Object.defineProperty(tab.window, "localStorage", { configurable: true, value: storage });
	tab.go(OPERATOR);
	return tab;
}
const warning = (tab: Tab) => tab.$(".session-warning[aria-live=polite]");

test("P19-queued-recovery: invalid stored sends are skipped under a live warning, valid ones kept in order; unreadable or missing storage warns while the journal recovers; a refused write keeps this view", { timeout: 180_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")], (stateDir) => write(controlInboxFile(stateDir), jsonl([{ type: "held", id: dc("d"), at: at("14:00"), text: "already discarded" }])));
	const failed = pending(dc("3"), "retry this file", { state: "failed", reason: "original failure", body: { kind: "message", text: "retry this file", images: ["im-fixture.png"], files: ["tx-fixture.md"] } });
	const items = [null, pending(dc("1"), "queued one", { ask_id: "ask-fixture" }), pending(dc("2"), "bad time", { at: "invalid" }), failed,
		pending(dc("4"), "bad attachment", { body: { kind: "message", text: "invalid", files: [42] } }), pending(dc("5"), "queued two", { state: "held" }),
		pending(dc("6"), "bad reason", { reason: { message: "invalid" } }), pending(dc("7"), "bad ask", { ask_id: 42 }), pending(dc("8"), "no ask id")];
	delete (items.at(-1) as Json).ask_id; // an older record that omitted the optional ask id still recovers
	let tab = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items, dismissed: [dc("d"), 42] })]]));
	assert.deepEqual(await bubblesAre(tab, ["queued one", "retry this file", "queued two", "no ask id"], "the valid stored sends"), ["queued one", "retry this file", "queued two", "no ask id"], "valid sends in FIFO order; a dismissed journal send stays gone");
	const failure = tab.$(".session-pending-failed")!;
	assert.match(failure.textContent!, /original failure.*Send again.*Discard/);
	assert.deepEqual([...failure.querySelectorAll(".session-pending-attachments li")].map((li) => li.textContent), ["Image · im-fixture.png", "File · tx-fixture.md"]);
	assert.match(warning(tab)?.textContent ?? "", /recovery incomplete: 6 invalid stored entries skipped/i);
	assert.equal(warning(tab)?.getAttribute("role"), "status");
	assert.equal(messages(tab), 0, "recovery never retries a failed send on its own");
	tab.click([...failure.querySelectorAll(".session-pending-actions button")].at(-1)!);
	const kept = ["queued one", "queued two", "no ask id"];
	assert.deepEqual(await bubblesAre(tab, kept, "the discarded failure"), kept);
	assert.ok(warning(tab), "the warning survives pending-state updates");
	assert.deepEqual(stored(tab).items.map((item) => item.ask_id ?? null), ["ask-fixture", null, null], "a valid ask id is kept");
	tab = await tab.reopen();
	assert.deepEqual(await bubblesAre(tab, kept, "the reloaded queue"), kept, "valid sends and dismissals persist after a successful write");
	assert.deepEqual(stored(tab).dismissed, [dc("d"), dc("3")]);

	write(controlInboxFile(d.stateDir), jsonl([{ type: "held", id: dc("d"), at: at("14:00"), text: "already discarded" }, { type: "held", id: dc("e"), at: at("14:01"), text: "from journal" }]));
	const denied = new (class extends Map<string, string> { override get(key: string) { if (key === PENDING) throw new Error("access denied"); return super.get(key); } })();
	for (const mode of ["invalid JSON", "read denied", "missing"] as const) {
		const broken = mode === "missing" ? await tabWith(t, d, undefined) : await openTab(t, d.port, OPERATOR, mode === "read denied" ? denied : new Map([[PENDING, "{broken"]]));
		assert.deepEqual(await bubblesAre(broken, ["already discarded", "from journal"], `${mode}: the journal's sends`), ["already discarded", "from journal"], mode);
		assert.match(warning(broken)?.textContent ?? "", /could not be recovered from browser storage/i, mode);
		assert.equal(messages(broken), 0, mode);
		broken.close();
	}

	write(controlInboxFile(d.stateDir), jsonl([{ type: "delivered", id: dc("d"), at: at("14:02") }, { type: "delivered", id: dc("e"), at: at("14:02") }]));
	const live = await session(t, d, () => false);
	let page: Tab | undefined; // a quota error from the page's own realm, as a browser raises it
	const refused = new (class extends Map<string, string> { override set(key: string, value: string) {
		if (key === PENDING && page) throw new (runInContext("Error", page.globals) as ErrorConstructor)("quota exceeded");
		return super.set(key, value);
	} })([[PENDING, JSON.stringify({ items: [pending(dc("f"), "queued old", { at: "2000-01-01T00:00:00Z", state: "failed", reason: "keep this failure" })], dismissed: [] })]]);
	const refusing = page = await openTab(t, d.port, OPERATOR, refused);
	await refusing.find(".operator-composer-send");
	live.control.stop(); // the next session's new token refuses this tab's send, failing it
	await session(t, d, () => false);
	await compose(refusing, "new message");
	assert.deepEqual(await bubblesAre(refusing, ["queued old", "new message"], "the new send"), ["queued old", "new message"]);
	assert.match(warning(refusing)?.textContent ?? "", /not persisted: quota exceeded\. Kept in this view only/i);
	assert.equal(await until(() => refusing.$$(".session-pending-failed").length, (n) => n === 2, "the refused send failed"), 2, "the recovered failure and the new one, in this view");
	assert.deepEqual(bubbles(refusing), ["queued old", "new message"]);
	assert.equal(Object.hasOwn(await posted(refusing, 1), "ask_id"), false, "an ordinary POST carries no ask");
	assert.match(warning(refusing)?.textContent ?? "", /not persisted/);
});

test("P19-queued-fifo: quick sends stay visible while their POSTs serialize; a delivered send waits after the newest entry until its transcript entry replaces it", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	const live = await session(t, d, () => true, 60_000);
	const tab = await openTab(t, d.port, OPERATOR, new Map(), /^\/api\/operator\/message$/);
	await compose(tab, "first");
	await compose(tab, "second");
	assert.deepEqual(await bubblesAre(tab, ["first", "second"], "both sends"), ["first", "second"]);
	assert.equal(messages(tab), 1, "one in-flight POST");
	assert.equal(field(tab).hasAttribute("disabled"), false, "another composer send is allowed");
	tab.release();
	await until(() => live.injected.length, (n) => n === 1, "the first handed to the session");
	await settle();
	assert.equal(messages(tab), 1, "the second waits for the first's answer");
	live.control.observe({ role: "user", content: live.injected[0] });
	await until(() => live.injected.length, (n) => n === 2, "the second POST after the first answered");
	live.control.observe({ role: "user", content: live.injected[1] });
	const first = await tab.find(".session-pending", (b) => /Delivered · waiting for transcript/.test(b.textContent ?? ""));
	assert.equal(first.querySelector(".md")?.textContent, "first", "delivered stays visible until its entry arrives");
	d.append(said("14:01", "next streamed response"));
	tab.refresh();
	await tab.waitText(/next streamed response/);
	assert.deepEqual(bubbles(tab), ["first", "second"]);
	const before = tab.$(".session-pending")!.previousElementSibling;
	assert.match((before?.classList.contains("session-day") ? before.previousElementSibling : before)?.textContent ?? "", /next streamed response/, "pending sends move after the latest response");
	d.append(own("14:02", live.injected[0]!));
	tab.refresh();
	assert.deepEqual(await bubblesAre(tab, ["second"], "the first promoted"), ["second"]);
	assert.equal(texts(tab, ".md").filter((s) => s === "first").length, 1, "one real bubble, no duplicate render");
	const again = await tab.reopen();
	assert.deepEqual(await bubblesAre(again, ["second"], "the reloaded queue"), ["second"], "the unseen second persists; the promoted first stays gone");
});

test("P19-queued-ack: a transcript entry that lands before the POST's answer removes the sending bubble, and the late answer never resurrects it", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	const live = await session(t, d, () => true, 60_000);
	const tab = await openTab(t, d.port, OPERATOR);
	await compose(tab, "arrives first");
	await until(() => live.injected.length, (n) => n === 1, "the send handed over");
	assert.match(live.injected[0]!, /\[cp-dashboard dc-\d{14}-[a-f0-9]{8}/, "the client's correlation id reaches the session");
	d.append(own("14:00", live.injected[0]!));
	tab.refresh();
	assert.deepEqual(await bubblesAre(tab, [], "the entry replaced the sending bubble"), []);
	assert.equal(tab.requests.filter((r) => r.path === "/api/operator/message").length, 0, "the POST has not answered yet");
	live.control.observe({ role: "user", content: live.injected[0] });
	await posted(tab, 1);
	await settle();
	assert.deepEqual(bubbles(tab), [], "the late answer never brings the bubble back");
	assert.equal(texts(tab, ".md").filter((s) => s === "arrives first").length, 1);
	assert.deepEqual(bubbles(await tab.reopen()), []);
});

/** Appends journal rows for one composer send to `d`'s control journal: its request, then each outcome in order. */
function journal(d: Home, id: string, at: string, text: string, request: Json, ...outcomes: Array<string | Json>) {
	const rows = [{ type: "request", by: "bridge", id, at, kind: "message", text, ask_id: null, peer: null, deliver: "followUp", session_file: d.file, ...request },
		...outcomes.map((o) => typeof o === "string" ? { type: "outcome", by: "bridge", id, at, state: o, reason: null } : { id, at, ...o })];
	mkdirSync(join(d.stateDir, "operator"), { recursive: true });
	writeFileSync(controlJournalFile(d.stateDir), jsonl(rows), { flag: "a" });
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const started = (d: Home) => (readControlRecord(d.stateDir) as { record: { started_at: string } }).record.started_at;

test("P19-queued-journal: a reload rebuilds the queue from the journal, shows a late failure, discards only its own, and an inbox replay promotes a held send", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	await session(t, d, () => false);
	const since = { session_started_at: started(d) };
	journal(d, dc("1"), ago(60_000), "queued one", since, "injected", "queued");
	journal(d, dc("2"), ago(50_000), "queued two", since, "injected", "queued");
	journal(d, dc("9"), ago(70_000), "gone", since, "injected", "delivered");
	let tab = await openTab(t, d.port, OPERATOR);
	assert.deepEqual(await bubblesAre(tab, ["queued one", "queued two"], "the journal's queue"), ["queued one", "queued two"], "settled journal history is not a new pending bubble");
	tab = await tab.reopen();
	assert.deepEqual(await bubblesAre(tab, ["queued one", "queued two"], "the reloaded queue"), ["queued one", "queued two"]);
	journal(d, dc("1"), ago(40_000), "queued one", since, { type: "outcome", by: "bridge", state: "failed", reason: "late inject failure" });
	tab = await tab.reopen();
	assert.match((await tab.find(".session-pending-failed")).textContent!, /late inject failure/);
	tab.click([...tab.$(".session-pending-failed")!.querySelectorAll(".session-pending-actions button")].at(-1)!);
	assert.deepEqual(await bubblesAre(tab, ["queued two"], "the discarded failure"), ["queued two"]);
	tab = await tab.reopen();
	assert.deepEqual(await bubblesAre(tab, ["queued two"], "the reload after a discard"), ["queued two"], "a discarded journal failure stays dismissed");
	d.append(own("14:01", `[cp-dashboard inbox — 1 message(s)]\n- 14:00 (${dc("2")}): queued two`));
	tab.refresh();
	assert.deepEqual(await bubblesAre(tab, [], "the inbox replay"), [], "an actual inbox replay promotes a held send too");
});

test("P19-queued-retry: Send again re-posts a failed send with its image and file ids under a fresh correlation id; the ids survive reload", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	await session(t, d, () => false);
	const IMAGE = "im-20261004-0123456789abcdef01234567.png", FILE = "tx-20261004-0123456789abcdef01234567.md";
	const failed = pending(dc("a"), "try attachment", { state: "failed", reason: "socket refused", body: { kind: "message", text: "try attachment", images: [IMAGE], files: [FILE] } });
	let tab = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items: [failed], dismissed: [] })]]));
	tab.click(await tab.find(".session-pending-again", (b) => !b.hasAttribute("disabled")));
	const { client_id: retried, ...retry } = await posted(tab, 1);
	assert.deepEqual(retry, { kind: "message", text: "try attachment", images: [IMAGE], files: [FILE] }, "the retry keeps its attachment ids");
	assert.notEqual(retried, dc("a"), "a retry is a fresh correlation id");
	await settle();
	tab = await tab.reopen();
	assert.deepEqual(await until(() => stored(tab).items.at(-1)?.body.files, (files) => Array.isArray(files), "the stored retry"), [FILE], "the retried file ids survive reload");
	assert.deepEqual(stored(tab).items.at(-1)?.body.images, [IMAGE]);
});

test("P19-queued-scroll: a new pending bubble follows the bottom; a reader who scrolled up stays put; Jump to latest includes pending sends", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	const tab = await openTab(t, d.port, "#settings");
	// Linkedom lays nothing out: the transcript's scroll metrics are the test's own.
	const metrics = { scrollHeight: 1000, clientHeight: 400 }, tops = new WeakMap<object, number>();
	const proto = tab.window.HTMLElement.prototype as object;
	const saved = ["scrollHeight", "clientHeight", "scrollTop"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
	t.after(() => { for (const [key, was] of saved) { if (was) Object.defineProperty(proto, key, was); else Reflect.deleteProperty(proto, key); } });
	Object.defineProperties(proto, {
		scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
		clientHeight: { configurable: true, get: () => metrics.clientHeight },
		scrollTop: { configurable: true, get(this: object) { return tops.get(this) ?? 0; }, set(this: object, value: number) { tops.set(this, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); } },
	});
	tab.go(OPERATOR);
	const scroller = () => tab.$(".session-transcript") as unknown as { scrollTop: number; dispatchEvent(e: Event): boolean };
	const top = (want: number, what: string) => until(() => scroller().scrollTop, (now) => now === want, what);
	await tab.waitText(/response/);
	assert.equal(await top(600, "the open at the newest"), 600);
	metrics.scrollHeight = 1100;
	await compose(tab, "new pending");
	await bubblesAre(tab, ["new pending"], "the pending bubble");
	assert.equal(await top(700, "the follow"), 700, "adding a pending bubble follows the bottom");
	scroller().scrollTop = 200;
	scroller().dispatchEvent(new tab.window.Event("scroll"));
	metrics.scrollHeight = 1200;
	d.append(said("14:01", "streaming later"));
	tab.refresh();
	await tab.waitText(/streaming later/);
	await settle();
	assert.equal(scroller().scrollTop, 200, "a streaming response and pending status do not yank a scrolled reader");
	tab.click(await tab.find(".session-new"));
	assert.equal(await top(800, "the jump"), 800, "Jump to latest includes pending sends");
	metrics.scrollHeight = 1300;
	d.append(said("14:02", "another response"));
	tab.refresh();
	await tab.waitText(/another response/);
	assert.equal(await top(900, "the re-pin"), 900, "following stays pinned as pending bubbles move below new entries");
});


test("P19-queued-lost: a lost or expired send is a failed bubble with its text; only Send again sends it, as a new message; a cancelled one stays gone", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	await session(t, d, () => false);
	const since = { session_started_at: started(d) }, day = 86_400_000;
	journal(d, dc("1"), ago(3_600_000), "claimed, never seen", { session_started_at: ago(30 * day) }, "injected", "queued");
	journal(d, dc("2"), ago(6 * day), "held too long", { session_started_at: ago(30 * day), session_file: undefined }, "queued");
	journal(d, dc("3"), ago(3_000_000), "cancelled text", since, "queued", "cancelled");
	journal(d, dc("4"), ago(2_000_000), "queued live", since, "injected", "queued");
	const items = [pending(dc("1"), "claimed, never seen"), pending(dc("3"), "cancelled text"), pending(dc("4"), "queued live")];
	let tab = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items, dismissed: [] })]]));
	const shown = ["claimed, never seen", "queued live", "held too long"];
	assert.deepEqual(await bubblesAre(tab, shown, "the stored and journal sends"), shown, "the original text stays visible; a cancelled send does not come back");
	const failed = tab.$$(".session-pending-failed").map((b) => b.textContent);
	assert.match(failed[0]!, /Failed: Not confirmed: target operator session ended.*Send again.*Discard/);
	assert.match(failed[1]!, /Failed: Not sent: queued longer than 24 h.*Send again.*Discard/);
	assert.equal(messages(tab), 0, "a loss is never resent on its own");
	tab = await openTab(t, d.port, OPERATOR);
	const fresh = ["held too long", "claimed, never seen", "queued live"];
	assert.deepEqual(await bubblesAre(tab, fresh, "a fresh browser"), fresh, "a fresh browser still shows the failures from the journal, in journal time");
	tab.click(await tab.find(".session-pending-again", (b) => b.closest(".session-pending")?.querySelector(".md")?.textContent === "claimed, never seen"));
	const { client_id, ...body } = await posted(tab, 1);
	assert.deepEqual(body, { kind: "message", text: "claimed, never seen", deliver: "followUp" });
	assert.notEqual(client_id, dc("1"), "a new message, not the lost one");
	const after = ["held too long", "queued live", "claimed, never seen"];
	assert.deepEqual(await bubblesAre(tab, after, "the new queued send"), after, "the lost bubble gives way to the new queued send");
	tab = await tab.reopen();
	assert.deepEqual(await bubblesAre(tab, after, "the reload"), after, "the lost id stays dismissed; it is never sent twice");
	assert.equal(messages(tab), 0);
});

test("P19-queued-edit: a held message edits inline (Esc keeps it, Enter saves), cancels, and a save that lost the race shows the sent text with no Edit; the actions share one 44 px phone rule", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	let idle = false;
	const live = await session(t, d, () => idle);
	const tab = await openTab(t, d.port, OPERATOR);
	await compose(tab, "draft one");
	await until(() => tab.$$(".session-pending-edit").length, (n) => n === 1, "the first held");
	await compose(tab, "draft two");
	assert.equal(await until(() => tab.$$(".session-pending-edit").length, (n) => n === 2, "both held"), 2, "Edit and Cancel send on each held message");
	assert.deepEqual(tab.$$(".session-pending-actions > button").slice(0, 2).map((b) => b.textContent), ["Edit", "Cancel send"]);
	const editor = () => tab.$("[aria-label='Edit queued message']") as unknown as HTMLTextAreaElement | null;
	const key = async (k: string) => { await settle(); const e = new tab.window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(e, "key", { value: k }); editor()!.dispatchEvent(e); };
	const sent = () => tab.started.filter((r) => r.startsWith("POST")).length;
	tab.click(tab.$$(".session-pending-edit")[0]!);
	assert.equal((await until(editor, Boolean, "the editor"))!.value, "draft one", "prefilled with the exact text");
	assert.deepEqual(tab.$$(".session-pending button").map((b) => [b.textContent, b.parentElement?.className]).slice(0, 2), [["Save", "session-pending-actions"], ["Cancel", "session-pending-actions"]]);
	tab.type(editor() as unknown as Element, "thrown away");
	await key("Escape");
	await until(editor, (e) => e === null, "the editor closed");
	assert.deepEqual(bubbles(tab), ["draft one", "draft two"], "Esc keeps the original");
	assert.equal(sent(), 2, "Esc posts nothing");
	tab.click(tab.$$(".session-pending-edit")[0]!);
	tab.type(await until(editor, Boolean, "the editor") as unknown as Element, "draft one, revised");
	await key("Enter");
	assert.deepEqual(await bubblesAre(tab, ["draft one, revised", "draft two"], "the saved edit"), ["draft one, revised", "draft two"]);
	tab.refresh();
	await settle();
	assert.deepEqual(bubbles(tab), ["draft one, revised", "draft two"], "a status read after the save cannot revert it");
	tab.click(tab.$$(".session-pending-cancel")[0]!);
	assert.deepEqual(await bubblesAre(tab, ["draft two"], "the cancelled send"), ["draft two"]);
	tab.click(tab.$(".session-pending-edit")!);
	tab.type(await until(editor, Boolean, "the editor") as unknown as Element, "draft two, revised");
	idle = true;
	live.control.settled();
	await until(() => live.injected.length, (n) => n === 1, "draft two handed over");
	tab.click(tab.$(".session-pending-save")!);
	const raced = await tab.find(".session-pending", (b) => /Already sent.*not applied/.test(b.textContent ?? ""));
	assert.equal(raced.querySelector(".md")?.textContent, "draft two", "the authoritative delivered text");
	assert.equal(raced.querySelector(".session-pending-edit"), null, "no Edit once sent");
	assert.equal(editor(), null);
	assert.ok(!bubbles(await tab.reopen()).includes("draft one, revised"), "a cancelled message stays gone");
	const css = await servedCss(d);
	const media = [...css.matchAll(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)];
	const base = media.reduce((sheet, m) => sheet.replace(m[0], ""), css);
	assert.match(cssRules(base, ".session-pending-actions>button"), /min-height:44px/, "the base (phone) rule: every width below 900 px");
	assert.equal(media.filter((m) => m[1]!.includes("session-pending")).length, 0, "no media block resizes them");
});

test("P19-queued-evidence: a Not confirmed failure links to its own recorded session, else says it cannot be checked here; Not sent gets neither; nothing is posted", { timeout: 120_000 }, async (t) => {
	const listed = (stateDir: string) => join(stateDir, "sessions", "A.jsonl");
	const d = await home(t, [said("13:59", "response")]);
	const window = Array.from({ length: 40 }, (_, i) => line("14:00", { role: "assistant", content: [{ type: "text", text: `A${i} ${"x".repeat(110_000)}` }] }));
	write(listed(d.stateDir), jsonl(window.map((row) => ({ ...row, timestamp: ago(60_000) }))));
	write(operatorSessionsFile(join(d.stateDir, "sessions")), jsonl([{ at: ago(172_800_000), session_file: listed(d.stateDir) }, { at: ago(86_400_000), session_file: d.file }]));
	await session(t, d, () => false);
	const shut = { type: "outcome", by: "bridge", state: "dropped", reason: "session shut down" }, since = started(d);
	journal(d, dc("a"), ago(3_600_000), "lost a", { session_started_at: since, session_file: listed(d.stateDir) }, "queued", "injected", shut);
	journal(d, dc("b"), ago(3_500_000), "lost b", { session_started_at: since, session_file: join(d.home, "gone.jsonl") }, "queued", "injected", shut);
	journal(d, dc("c"), ago(3_400_000), "lost c", { session_started_at: since, session_file: listed(d.stateDir) }, "queued", shut);
	const evidence = (tab: Tab) => tab.$$(".session-pending").map((b) => [b.querySelector(".md")?.textContent, b.querySelector(".session-pending-evidence")?.getAttribute("href") ?? null, /cannot be checked/.test(b.textContent!)]);
	let tab = await openTab(t, d.port, OPERATOR);
	assert.deepEqual(await until(() => evidence(tab), (rows) => rows.length === 3, "three lost sends"), [["lost a", "#sessions?view=you&transcript=1&session=A.jsonl", false], ["lost b", null, true], ["lost c", null, false]],
		"the recorded target while viewing the current session; an unlisted one cannot be checked; Not sent gets neither");
	assert.match(tab.$$(".session-pending")[1]!.textContent!, /Its session is not available here;/, "an unlisted session file is unavailable, not unrecorded");
	tab = await tab.reopen(`${OPERATOR}&session=A.jsonl`);
	assert.deepEqual(await until(() => evidence(tab)[0], (row) => row?.[0] === "lost a" && row[2] === true, "the self view"), ["lost a", null, true], "viewing its own session, older than the loaded window: no self-link, says so");
	assert.equal(tab.started.filter((r) => r.startsWith("POST")).length, 0, "no link or render ever posts a request");
});

test("P19-queued-stuck: a delivered send clears once the truncated window or the 60 s status grace passes it; one inside both keeps a Dismiss that persists; queued stays", { timeout: 120_000 }, async (t) => {
	const window = Array.from({ length: 40 }, (_, i) => ({ type: "message", timestamp: ago(3_600_000), message: { role: "assistant", content: [{ type: "text", text: `window ${i} ${"x".repeat(110_000)}` }] } }));
	const d = await home(t, window);
	const live = await session(t, d, () => true, 60_000);
	const items = [pending(dc("1"), "queued stuck", { at: ago(7_200_000), state: "delivered" }), pending(dc("2"), "queued waiting", { at: ago(7_200_000) }),
		pending(dc("3"), "queued fresh", { at: ago(5_000), state: "delivered" })];
	let tab = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items, dismissed: [] })]]));
	const kept = ["queued waiting", "queued fresh"];
	assert.deepEqual(await bubblesAre(tab, kept, "the stuck send cleared"), kept, "older than the truncated window clears without a storage edit; queued stays");
	assert.ok((await until(() => stored(tab).dismissed, (ids) => ids.includes(dc("1")), "the stuck id dismissed")).includes(dc("1")), "dismissed so no status read resurrects it");
	const dismiss = tab.$$(".session-pending-dismiss");
	assert.deepEqual(dismiss.map((b) => [b.textContent, b.parentElement?.className]), [["Dismiss", "session-pending-actions"]], "only the delivered bubble gets Dismiss, in the shared 44 px row");
	assert.match(dismiss[0]!.closest(".session-pending")!.textContent!, /Delivered · waiting for transcript/);
	tab.click(dismiss[0]!);
	assert.deepEqual(await bubblesAre(tab, ["queued waiting"], "the dismissed bubble"), ["queued waiting"]);
	tab = await tab.reopen();
	assert.deepEqual(await bubblesAre(tab, ["queued waiting"], "the reload"), ["queued waiting"], "a dismissed bubble stays gone after reload");
	await compose(tab, "queued late");
	await until(() => live.injected.length, (n) => n === 1, "the send handed over");
	live.control.observe({ role: "user", content: live.injected[0] });
	await tab.find(".session-pending", (b) => /Delivered/.test(b.textContent ?? ""));
	tab.refresh();
	await settle();
	assert.deepEqual(bubbles(tab), ["queued waiting", "queued late"], "inside the window and the 60 s grace, a delivered send waits for its entry");
	d.tick(); // the viewer's clock, which stamps the status, passes the grace from delivery
	tab.refresh();
	assert.deepEqual(await bubblesAre(tab, ["queued waiting"], "the grace passed"), ["queued waiting"], "delivered for longer than the grace clears; queued never clears by age");
});

// ---- chat v2: day separators, the Sessions theme scope, steps rows, Chats, quick replies and the header ----------

/** Local wall-clock instants, so the separators follow the machine's own zone like the tab's browser clock. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const stamped = (timestamp: string, message: unknown) => ({ type: "message", timestamp, message });
const reply = (timestamp: string, text: string) => stamped(timestamp, { role: "assistant", content: [{ type: "text", text }] });
const toolPair = (timestamp: string, id: string, name = "bash") => [
	stamped(timestamp, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { command: id } }] }),
	stamped(timestamp, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: `ran ${id}` }] }),
];
/** The transcript in order: a day pill's label, a bubble's text, `tools` for a run, `pending` for a queued send. */
const sequence = (tab: Tab) => tab.$$(".session-entries .session-day, .session-entries .session-bubble .md, .session-entries .session-tool-run, .session-entries .session-pending")
	.map((el) => el.classList.contains("session-day") ? `day:${el.textContent}` : el.classList.contains("session-tool-run") ? "tools" : el.classList.contains("session-pending") ? "pending" : el.textContent);

test("P19-chat-days: local-day pills in source order split a tool run and a bubble group; an undated bubble gets neither; a pending send past midnight opens its own day", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [reply(local(15, 23, 50), "before midnight"), ...toolPair(local(15, 23, 58), "t1"), ...toolPair(local(16, 0, 0), "t2"),
		reply(local(16, 0, 2), "after midnight"), reply("not a time", "undated"), reply(local(15, 9), "out of order stays put")]);
	const tab = await openTab(t, d.port, OPERATOR);
	await tab.waitText(/out of order stays put/);
	assert.deepEqual(sequence(tab), ["day:Thu, Oct 15", "before midnight", "tools", "day:Fri, Oct 16", "tools", "after midnight", "undated", "day:Thu, Oct 15", "out of order stays put"]);
	const shown = tab.$$(".session-bubble");
	assert.equal(shown[1]!.querySelector(".session-who")?.textContent?.includes("Operator"), true, "a new day opens a new group even within five minutes");
	assert.equal(shown[2]!.querySelector("time"), null, "no time is invented for an unparseable stamp");
	assert.deepEqual(tab.$$(".session-day time").map((el) => el.getAttribute("datetime")), ["2026-10-15", "2026-10-16", "2026-10-15"]);

	const queued = await home(t, [reply(local(15, 23, 50), "before midnight")]);
	const days = async (...sends: Array<[string, string]>) => {
		const items = sends.map(([key, when]) => pending(dc(key), `queued ${key}`, { at: when }));
		const view = await openTab(t, queued.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items, dismissed: [] })]]));
		await until(() => view.$$(".session-pending").length, (n) => n === sends.length, "the pending sends");
		const out = sequence(view).filter((s) => s === "pending" || s.startsWith("day:"));
		view.close();
		return out;
	};
	assert.deepEqual(await days(["1", local(15, 23, 55)], ["2", local(16, 0, 5)], ["3", local(16, 0, 6)]), ["day:Thu, Oct 15", "pending", "day:Fri, Oct 16", "pending", "pending"], "one queued past local midnight opens its own day pill");
	assert.deepEqual(await days(["4", local(15, 23, 59)]), ["day:Thu, Oct 15", "pending"], "a same-day send adds none");
});

test("P19-chat-worker-names: grouped own bubbles in a worker view name the author once and keep their times", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "operator")], (stateDir, file) => {
		const worker = join(stateDir, "sessions", "worker.jsonl");
		write(worker, jsonl([stamped(local(15, 9), { role: "user", content: [{ type: "text", text: "brief one" }] }), stamped(local(15, 9, 1), { role: "user", content: [{ type: "text", text: "brief two" }] }),
			reply(local(15, 9, 2), "on it"), reply(local(15, 9, 3), "done")]));
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-w", project: "demo", phase: "held", worker: { session_file: worker } }] });
		void file;
	});
	const tab = await openTab(t, d.port, "#sessions?view=workers&id=cp-w");
	await tab.waitText(/done/);
	assert.deepEqual(tab.$$(".session-bubble").map((b) => [...b.querySelectorAll(".session-who > span:not(.session-avatar)")].map((s) => s.textContent).join(",")), ["Parent", "", "Worker", ""]);
	assert.equal(tab.$$(".session-own .session-who time").length, 2, "each own bubble keeps its time");
});

test("P19-chat-theme: only the Sessions route's shell carries shell-sessions, so the light palette never reaches another screen", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [said("13:59", "response")]);
	const tab = await openTab(t, d.port, OPERATOR);
	assert.equal((await tab.find(".shell")).getAttribute("class"), "shell shell-sessions");
	for (const screen of ["overview", "decisions", "jobs", "files"]) {
		tab.go(`#${screen}`);
		assert.equal(await until(() => tab.$(".shell")?.getAttribute("class"), (c) => c === "shell", screen), "shell", screen);
	}
});

test("P19-chat-steps: a run of steps takes the one wake notice above it and links its job transcript; the link opens Transcript on a phone, a plain Job link Details; one name column per card", { timeout: 120_000 }, async (t) => {
	const at9 = local(15, 9);
	const d = await home(t, [{ type: "custom_message", timestamp: at9, customType: "cp-bridge", content: "[cp-bridge wake job=cp-done]\nAn earlier wake.", display: true },
		{ type: "custom_message", timestamp: at9, customType: "cp-bridge", content: "[cp-bridge wake job=cp-done]\nWoke for CI.", display: true },
		...toolPair(at9, "t1"), ...toolPair(at9, "t2"), reply(at9, "a message ends the run"), ...toolPair(at9, "t3")], (stateDir) => {
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-done", project: "demo", phase: "done" }] });
	});
	const tab = await openTab(t, d.port, OPERATOR);
	await tab.waitText(/a message ends the run/);
	const runs = tab.$$(".session-steps");
	assert.deepEqual(runs.map((r) => r.querySelector(".session-steps-face")?.textContent?.replace(/[▸▾]/g, "").trim()), ["≡ 3 steps · cp-done", "≡ 1 step · ran t3"], "the notice joins its run; a message ends it");
	assert.match(runs[0]!.querySelector(".session-steps-card")?.textContent ?? "", /Woke for CI/, "only the nearest notice joins");
	assert.doesNotMatch(runs[0]!.querySelector(".session-steps-card")?.textContent ?? "", /An earlier wake/, "never the notice above it");
	tab.click(runs[0]!.querySelector(".session-tools")!);
	const link = await tab.find(".session-steps-link");
	assert.equal(link.getAttribute("href"), "#job/cp-done?tab=transcript");
	tab.go("#job/cp-done?tab=transcript");
	const pane = () => tab.$(".job-detail")?.getAttribute("data-tab");
	assert.equal(await until(pane, (p) => !!p, "the job page"), "transcript", "the explicit link opens Transcript, not the phone's default Details");
	tab.go("#job/cp-done");
	assert.equal(await until(pane, (p) => p === "details", "Details"), "details", "an ordinary Job link keeps the phone default");
	tab.go("#job/cp-done?tab=transcript");
	assert.equal(await until(pane, (p) => p === "transcript", "Transcript again"), "transcript", "Forward to the explicit link lands on Transcript again");
	assert.deepEqual([...new Set(tab.requests.filter((r) => r.path.startsWith("/api/job/cp-done") && !r.path.includes("/transcript")).map((r) => r.path))], ["/api/job/cp-done"], "the job read never carries the tab");
	const css = await servedCss(d);
	assert.match(cssRules(css, ".session-steps-rows"), /display:grid;grid-template-columns:16px fit-content\(14ch\) minmax\(0,1fr\) auto/);
	assert.match(cssRules(css, ".session-steps-rows .session-tool summary,.session-steps-rows>.session-entry,.session-steps-rows>.session-entry>.session-tool") + cssRules(css, ".session-steps-rows>.session-entry,.session-steps-rows>.session-entry>.session-tool,.session-steps-rows .session-tool>summary"), /grid-template-columns:subgrid/);
	assert.match(cssRules(css, ".session-steps-rows .session-tool summary>code:nth-child(2)") + cssRules(css, ".session-tool summary>code:nth-child(2)"), /overflow:hidden;.*text-overflow:ellipsis/, "a longer name ellipsizes");
});

test("P19-chat-chats: the Operator preview is the newest loaded message of the latest file; history, Decisions and other tiers never borrow it; the ⋯ sheet lists every stream", { timeout: 120_000 }, async (t) => {
	const at9 = local(15, 9), at10 = local(15, 10);
	const d = await home(t, [reply(at9, "**Reply** with `code`\n\nand more"), ...toolPair(at10, "t1")], (stateDir) => {
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-idle", project: "demo", phase: "held" }] });
		write(join(stateDir, "runs", "cp-idle", "status.json"), { phase: "idle", model: "m" });
	});
	const older = join(d.home, "pi-sessions", "old.jsonl");
	write(older, jsonl([reply(at9, "older file")]));
	write(operatorSessionsFile(join(d.stateDir, "sessions")), jsonl([{ at: ago(172_800_000), session_file: older }, { at: ago(86_400_000), session_file: d.file }]));
	const operator = (tab: Tab) => {
		const row = tab.$('section[aria-label="Operator"] .session-choice');
		return row && [row.querySelector("small")!.textContent, row.querySelector("time")?.getAttribute("datetime") ?? null];
	};
	let tab = await openTab(t, d.port, OPERATOR);
	assert.deepEqual(await until(() => operator(tab), (row) => row?.[0] !== undefined && row[1] !== null, "the preview"), ["Reply with code and more", at9], "markdown marks dropped, tools skipped");
	const sheet = tab.$(".session-bar-more")!;
	assert.deepEqual([...sheet.querySelectorAll(".session-bar-views > a")].slice(0, 3).map((a) => a.textContent), ["Operator ↔ you", "CP parent", "Workers"]);
	assert.ok([...sheet.querySelectorAll("button")].some((b) => b.textContent === "Search"), "Search stays one tap into the sheet");
	assert.match(tab.$(".session-sidebar section:last-child h2")?.textContent ?? "", /^Fleet · 1 live$/, "a held-idle worker still counts as live");
	assert.equal(tab.$(".session-choice-nested strong")?.getAttribute("title"), "cp-idle", "workers nest under CP parent, full id in the title");
	d.append(stamped(local(15, 11), { role: "user", content: [{ type: "text", text: "ship it" }] }));
	tab.refresh();
	assert.deepEqual(await until(() => operator(tab), (row) => row?.[0] === "You: ship it", "the own preview"), ["You: ship it", local(15, 11)]);
	for (const [hash, want] of [[`${OPERATOR}&session=old.jsonl`, /^Historical transcript$/], ["#sessions?view=you&transcript=0", /^(?!You: |Reply)/], ["#sessions?view=parent", /^(?!You: |Reply)/]] as const) {
		tab = await tab.reopen(hash);
		const row = await until(() => operator(tab), (r) => r !== null && !!r[0], hash);
		assert.match(row![0]!, want, hash);
		assert.equal(row![1], null, `${hash}: no borrowed time`);
	}
});

test("P19-chat-replies: the one open ask carded in this transcript gets quick replies after the newest message; two candidates, history, another tier or an answered card get none", { timeout: 120_000 }, async (t) => {
	const ids: string[] = [];
	let asks!: OperatorAsks;
	const ask = (question: string) => ids.push(asks.open({ project: "picp", question, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused until Monday" }, { label: "Raise", consequence: "Spends more" }] }).id);
	const d = await home(t, [], (stateDir) => { asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")); ask("Which way?"); });
	d.append(stamped(local(15, 8), { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "cp_parent", arguments: { action: "ask" } }] }),
		stamped(local(15, 8), { role: "toolResult", toolCallId: "call-1", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id: ids[0] }) }] }),
		reply(local(15, 9), "Pick one"));
	const chips = (tab: Tab) => tab.$(".session-entries > .session-replies");
	let tab = await openTab(t, d.port, OPERATOR);
	const replies = await tab.find(".session-entries > .session-replies");
	assert.match(replies.previousElementSibling?.textContent ?? "", /Pick one/, "after the newest operator-session message");
	assert.deepEqual([...replies.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("title")]), [["Keep", "Paused until Monday"], ["Raise", "Spends more"]], "verbatim labels and consequences");
	assert.equal(replies.querySelector(".session-reply-recommended")?.textContent, "Keep");
	ask("Other?");
	tab = await tab.reopen();
	await tab.waitText(/Other\?/);
	await settle();
	assert.equal(chips(tab), null, "two candidates: no guess");
	asks.answer(ids[1]!, "Keep");
	const older = join(d.home, "pi-sessions", "old.jsonl");
	write(older, jsonl(d.rows));
	write(operatorSessionsFile(join(d.stateDir, "sessions")), jsonl([{ at: ago(172_800_000), session_file: older }, { at: ago(86_400_000), session_file: d.file }]));
	for (const hash of [`${OPERATOR}&session=old.jsonl`, "#sessions?view=parent"]) {
		tab = await tab.reopen(hash);
		await tab.find(".session-entries");
		await settle();
		assert.equal(chips(tab), null, `${hash}: an older file or another tier never answers the live ask`);
	}
	asks.answer(ids[0]!, "Keep");
	tab = await tab.reopen(OPERATOR);
	await tab.find(".session-ask-settled");
	assert.equal(chips(tab), null, "the card's journal state decides: an answered ask offers none");
});

test("P19-chat-replies-send: a chip sends the exact answer once and holds through a composer send, a reload and a queued card reply until the ask closes; a failure re-enables; control off disables", { timeout: 180_000 }, async (t) => {
	let asks!: OperatorAsks, id = "";
	const d = await home(t, [], (stateDir) => {
		asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl"));
		id = asks.open({ project: "picp", question: "Which way?", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused until Monday" }, { label: "Raise", consequence: "Spends more" }] }).id;
	});
	d.append(stamped(local(15, 8), { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "cp_parent", arguments: { action: "ask" } }] }),
		stamped(local(15, 8), { role: "toolResult", toolCallId: "call-1", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id }) }] }));
	const first = await session(t, d, () => false);
	let tab = await openTab(t, d.port, OPERATOR);
	const held = (view: Tab) => view.$$(".session-reply").length > 0 && view.$$(".session-reply").every((b) => b.hasAttribute("disabled"));
	await tab.find(".session-reply", (b) => !b.hasAttribute("disabled"));
	first.control.stop(); // the next session's new token refuses this tab's answer
	const live = await session(t, d, () => false);
	tab.click(tab.$(".session-reply")!);
	assert.deepEqual(pick(await posted(tab, 1), ["kind", "ask_id", "label"]), { kind: "answer", ask_id: id, label: "Keep" });
	assert.match((await tab.find(".session-replies [role=alert]")).textContent!, /^Failed: /);
	assert.equal(held(tab), false, "a failure re-enables the chips");
	tab = await tab.reopen();
	tab.click(await tab.find(".session-reply", (b) => b.textContent === "Raise" && !b.hasAttribute("disabled")));
	assert.deepEqual(pick(await posted(tab, 1), ["kind", "ask_id", "label"]), { kind: "answer", ask_id: id, label: "Raise" }, "retry is one click");
	assert.ok(await until(() => held(tab), Boolean, "held after the answer"), "no second answer while the first is on its way");
	assert.match(tab.$(".session-replies [role=status]")?.textContent ?? "", /the options close when the session records the answer$/);
	await compose(tab, "other");
	await posted(tab, 2);
	await settle();
	assert.ok(held(tab), "the composer's send replaced the delivery; the chips stay disabled");
	assert.equal(live.injected.filter((text) => text.includes("Raise")).length, 1, "the answer was sent once");
	tab = await tab.reopen();
	await tab.find(".session-reply");
	assert.match(await until(() => tab.$(".session-replies [role=status]")?.textContent ?? "", (s) => /^An answer/.test(s), "the recorded answer"), /^An answer is on its way/);
	assert.ok(held(tab), "after a reload, the recorded answer holds them");
	asks.answer(id, "Raise");
	tab.refresh();
	assert.equal(await until(() => tab.$(".session-entries > .session-replies"), (r) => r === null, "the closed ask"), null, "the journal closing the ask removes them");

	const other = asks.open({ project: "picp", question: "Again?", recommendation: "Keep", options: [{ label: "Keep", consequence: "x" }] }).id;
	d.append(stamped(local(15, 9), { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "cp_parent", arguments: { action: "ask" } }] }),
		stamped(local(15, 9), { role: "toolResult", toolCallId: "call-2", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id: other }) }] }));
	const queued = pending(dc("f"), "free text", { ask_id: other, at: ago(1_000) });
	const ready = (view: Tab) => until(() => texts(view, ".session-replies-state").join("|"), (s) => !/Checking/.test(s), "the control status");
	let reader = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items: [queued], dismissed: [] })]]));
	await reader.find(".session-reply");
	await ready(reader);
	assert.ok(held(reader), "a queued free-text reply to the same card holds them");
	reader = await openTab(t, d.port, OPERATOR, new Map([[PENDING, JSON.stringify({ items: [{ ...queued, state: "failed", reason: "x" }], dismissed: [] })]]));
	await reader.find(".session-pending-failed");
	await ready(reader);
	assert.equal(held(reader), false, "a failed one does not");
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	reader = await reader.reopen();
	assert.match((await reader.find(".session-replies-state")).textContent ?? "", /^Dashboard control is off/);
	assert.ok(held(reader));
});

test("P19-chat-header: Operator with the recorded state and model; checking, working and idle; history says so", { timeout: 120_000 }, async (t) => {
	const d = await home(t, [{ type: "model_change", timestamp: local(15, 8), provider: "fixture", modelId: "fixture-model" }, reply(local(15, 9), "hello")]);
	let busy = false;
	await session(t, d, () => !busy);
	const state = (tab: Tab) => tab.$(".session-heading-state > span:not(.session-dot)")?.textContent ?? null;
	const checking = await openTab(t, d.port, OPERATOR, new Map(), /^\/api\/operator\/control$/);
	assert.match(await until(() => state(checking), (s) => !!s, "the state line") ?? "", /^Checking status · .*fixture-model/, "before the status read");
	assert.equal(checking.$(".session-heading strong")?.textContent, "Operator");
	checking.release();
	assert.match(await until(() => state(checking), (s) => /^Idle/.test(s ?? ""), "idle") ?? "", /^Idle · .*fixture-model/);
	busy = true;
	const working = await checking.reopen();
	assert.match(await until(() => state(working), (s) => /^Working/.test(s ?? ""), "working") ?? "", /^Working · .*fixture-model/);
	const older = join(d.home, "pi-sessions", "old.jsonl");
	write(older, jsonl([reply(local(15, 9), "older")]));
	write(operatorSessionsFile(join(d.stateDir, "sessions")), jsonl([{ at: ago(172_800_000), session_file: older }, { at: ago(86_400_000), session_file: d.file }]));
	const history = await working.reopen(`${OPERATOR}&session=old.jsonl`);
	assert.equal(await until(() => state(history), (s) => s === "Historical transcript", "history"), "Historical transcript");
});
