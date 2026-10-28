/**
 * Behavior 19 (P19c): the Sessions transcript's tool calls and notices, and the operator composer, as
 * `bin/cp-view` serves them on a scratch home: real HTTP and the served app in its linkedom tab (DOM, text and
 * served CSS only, no layout or pixels).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { controlConfigFile, controlJournalFile } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { composerHref } from "../../viewer-app/routes.ts";
import { time } from "../../viewer-app/format.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../../src/dashboard-control.ts";
import { type Context, type Json, jsonl, pick, viewer, write } from "../harness/conversations.ts";
import { openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";
import { syntheticPng } from "../harness/images.ts";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, SCHEMA_VERSION, type Usage } from "../../src/contracts.ts";
import { FleetStore, isPidAlive } from "../../src/fleet.ts";
import { MandateStore, mandateSpend } from "../../src/mandate.ts";
import { liveUsageJobs } from "../../src/mandate-usage.ts";
import type { RunRegistry } from "../../src/runs.ts";
import { git, readRunStatus } from "../harness/index.ts";
import { withZombie } from "../harness/zombie.ts";

const AT = "2026-10-06T08:00:00Z";
const msg = (message: unknown) => ({ type: "message", timestamp: AT, message });
const parentCall = (id: string, args: unknown, result: string) => [
	msg({ role: "assistant", content: [{ type: "toolCall", id, name: "cp_parent", arguments: args }] }),
	msg({ role: "toolResult", toolCallId: id, toolName: "cp_parent", content: [{ type: "text", text: result }] }),
];

// ---- composer attachments ------------------------------------------------------------------------------------------

const OPERATOR = "#sessions?view=you&transcript=1";
const PNG = syntheticPng();
/** The operator session's own dashboard-control server, its bridge taking images; pi's injected messages recorded. */
async function imageSession(t: Context, stateDir: string, uploadRoot: string) {
	const injected: Array<{ text: string; images?: InlineImage[] }> = [];
	const ports: ControlPorts = {
		inject: (text, _deliverAs, images) => { injected.push({ text, ...(images ? { images } : {}) }); },
		abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => join(stateDir, "operator-session.jsonl"),
		prepareImage: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }),
	};
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {}, uploadRoot }) as DashboardControl;
	assert.equal(control.state, "listening", JSON.stringify(control));
	t.after(() => control.stop());
	return injected;
}
const file = (name: string, type: string, body: Buffer | string = PNG) => new File([typeof body === "string" ? body : Uint8Array.from(body)], name, { type });
/** Picks `files` in the composer's hidden file input, as the browser's picker hands them over. */
function choose(tab: Tab, files: File[]) {
	const input = tab.$("input[type=file]")!;
	Object.defineProperty(input, "files", { configurable: true, value: files });
	input.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
}
/** A paste (clipboardData) or drop (dataTransfer); preact names it lowercase only where linkedom has `on<type>`. */
function transfer(tab: Tab, target: Element, type: "paste" | "drop", data: { files: File[]; types: string[] }) {
	const event = new tab.window.Event(`on${type}` in target ? type : `${type[0]!.toUpperCase()}${type.slice(1)}`, { bubbles: true, cancelable: true });
	Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: data });
	target.dispatchEvent(event);
	return event as Event;
}
const texts = (tab: Tab, selector: string) => tab.$$(selector).map((el) => el.textContent);
const thumbIds = (tab: Tab) => tab.$$(".operator-composer-thumb").map((el) => el.getAttribute("src")!.replace("/api/operator/uploads/", ""));
const sendDisabled = (tab: Tab) => tab.$(".operator-composer-send")!.hasAttribute("disabled");
const gone = (tab: Tab, selector: string) => until(() => tab.$(selector), (el) => el === null, `${selector} gone`);
const count = (tab: Tab, selector: string, n: number) => until(() => tab.$$(selector).length, (m) => m === n, `${n} × ${selector}`);
/** The `n`th message the tab posted, once the viewer has answered it. */
const posted = async (tab: Tab, n: number) => JSON.parse((await until(() => tab.requests.filter((r) => r.path === "/api/operator/message"), (rows) => rows.length >= n, `message ${n}`))[n - 1]!.body!) as Json;

test("P19-composer-images: the composer attaches, uploads one at a time, thumbnails, removes, refuses and sends the ids; paste and drop attach", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const offline = await d.open(OPERATOR);
	await offline.find(".operator-composer", (s) => /Operator session offline/.test(s.textContent ?? ""));
	assert.equal(offline.$(".operator-composer-attach") === null, true, "no running session: no paperclip");
	offline.close();
	const injected = await imageSession(t, d.stateDir, d.root);
	const tab = await d.open(OPERATOR, /^\/api\/operator\/upload$/);
	const attach = await tab.find(".operator-composer-attach", (b) => !b.hasAttribute("disabled"));
	assert.equal(attach.getAttribute("title"), "Attach files or images (or paste/drop)");
	const input = tab.$("input[type=file]")!;
	assert.deepEqual([input.getAttribute("accept"), input.hasAttribute("multiple")], ["image/*,.txt,.md,.html,.json", true]);
	const uploads = () => tab.started.filter((r) => r === "POST /api/operator/upload").length;
	choose(tab, [file("a.png", "image/png"), file("b.png", "image/png")]);
	await until(uploads, (n) => n === 1, "the first upload");
	assert.deepEqual(texts(tab, ".operator-composer-attachment-state"), ["Uploading…", "Uploading…"]);
	assert.equal(uploads(), 1, "one upload at a time");
	assert.equal(sendDisabled(tab), true, "send waits for the uploads");
	tab.release();
	await count(tab, ".operator-composer-thumb", 2);
	assert.deepEqual(tab.requests.filter((r) => r.path === "/api/operator/upload").map((r) => r.headers["x-cp-upload-name"]), ["a.png", "b.png"], "in order");
	const [, second] = thumbIds(tab);
	assert.ok(thumbIds(tab).every((id) => /^im-\S+\.png$/.test(id)), "thumbnails from /api/operator/uploads/<id>");
	assert.equal(sendDisabled(tab), false, "images alone can be sent");
	tab.click(tab.$$(".operator-composer-thumb-remove")[0]!);
	await count(tab, ".operator-composer-thumb", 1);
	tab.click(tab.$(".operator-composer-send")!);
	const first = await posted(tab, 1);
	assert.deepEqual([first.kind, first.text, first.images], ["message", "", [second]]);
	await until(() => injected.length, (n) => n === 1, "the delivered message");
	assert.equal(injected[0]!.images?.length, 1, "the bridge took the one image");
	await gone(tab, ".operator-composer-attachments");

	choose(tab, [file("photo.heic", ""), file("x.HEIF", "image/heif"), file("doc.pdf", "application/pdf"), file("huge.png", "image/png", Buffer.alloc(11 * 1024 * 1024)), file("bad.png", "image/png", "not a png")]);
	await until(() => texts(tab, ".operator-composer-attachment-failed"), (s) => s.length === 5, "five refusals");
	assert.deepEqual(texts(tab, ".operator-composer-attachment-failed"), [
		"HEIC/HEIF is not supported; share the photo as JPEG",
		"HEIC/HEIF is not supported; share the photo as JPEG",
		"doc.pdf is not a PNG, JPEG, WebP or GIF image or a .txt, .md, .html or .json file",
		"huge.png is larger than 10 MiB",
		"not a PNG, JPEG, WebP or GIF image",
	]);
	assert.equal(sendDisabled(tab), true, "a failed image blocks sending until removed");
	for (const button of tab.$$(".operator-composer-thumb-remove")) tab.click(button);
	await gone(tab, ".operator-composer-attachments");
	choose(tab, Array.from({ length: 9 }, (_, i) => file(`p${i}.png`, "image/png")));
	await count(tab, ".operator-composer-thumb", 8);
	assert.deepEqual(texts(tab, ".operator-composer-attachment-failed"), ["At most 8 attachments per message"]);
	for (const button of tab.$$(".operator-composer-thumb-remove")) tab.click(button);
	await gone(tab, ".operator-composer-attachments");

	const field = tab.$("textarea")!;
	assert.equal(transfer(tab, field, "paste", { files: [file("pasted.png", "image/png")], types: ["Files"] }).defaultPrevented, true);
	assert.equal(transfer(tab, field, "paste", { files: [file("mixed.png", "image/png")], types: ["text/plain", "Files"] }).defaultPrevented, false, "the pasted text is not swallowed");
	assert.equal(transfer(tab, field, "paste", { files: [], types: ["text/plain"] }).defaultPrevented, false);
	await count(tab, ".operator-composer-thumb", 2);
	const pasted = thumbIds(tab);
	tab.type(field, "two pasted");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	const second2 = await posted(tab, 2);
	assert.deepEqual([second2.text, second2.images], ["two pasted", pasted]);

	choose(tab, [file(`${"a".repeat(110)}.md`, "", Buffer.alloc(2048, "x"))]);
	const name = await tab.find(".operator-composer-file-name", (el) => /\.md2 KiB$/.test(el.textContent ?? ""));
	assert.equal(name.querySelector("img") === null, true, "a text file shows its name, never a thumbnail");
	await until(() => sendDisabled(tab), (off) => !off, "a text file alone can be sent");
	tab.click(tab.$(".operator-composer-thumb-remove")!);
	await gone(tab, ".operator-composer-file-name");
	assert.equal(transfer(tab, tab.$(".operator-composer")!, "drop", { files: [file("dropped.md", "text/markdown", "# dropped\n")], types: ["Files"] }).defaultPrevented, true);
	assert.equal(transfer(tab, field, "paste", { files: [file("pasted.md", "", "# pasted\n")], types: ["Files"] }).defaultPrevented, true);
	await count(tab, ".operator-composer-file-name", 2);
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	const third = await posted(tab, 3);
	assert.deepEqual([third.text, third.images, (third.files as string[]).map((id) => /^tx-\S+\.md$/.test(id))], ["", undefined, [true, true]]);
	choose(tab, [file("huge.json", "application/json", Buffer.alloc(4 * 1024 * 1024 + 1))]);
	assert.match((await tab.find(".operator-composer-attachment-failed")).textContent ?? "", /larger than 4 MiB/);
	assert.equal(sendDisabled(tab), true);
});

// ---- composer keys, drafts, footer and skills ---------------------------------------------------------------------

/** A keydown on the composer field with a browser's modifier and IME fields, once the last input has rendered. */
async function press(tab: Tab, field: Element, key = "Enter", init: { shiftKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
	await settle();
	const event = new tab.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: key }, shiftKey: { value: !!init.shiftKey }, ctrlKey: { value: !!init.ctrlKey }, isComposing: { value: !!init.isComposing }, keyCode: { value: init.keyCode ?? 0 } });
	field.dispatchEvent(event);
}
/** Types `value` with the caret at `caret` (default: its end), as a browser reports `selectionStart`. */
function typeAt(tab: Tab, field: Element, value: string, caret = value.length) {
	Object.defineProperty(field, "selectionStart", { configurable: true, writable: true, value: caret });
	tab.type(field, value);
}
const field = (tab: Tab) => tab.$("textarea") as unknown as HTMLTextAreaElement;
const cleared = (tab: Tab) => until(() => field(tab).value, (v) => v === "", "the composer cleared");
const messages = (tab: Tab) => tab.started.filter((r) => r === "POST /api/operator/message").length;
/** Lets the tab's queued renders and any request a handler would start run. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((done) => setImmediate(done)); };

test("P19-composer-keys: Enter sends (a follow-up while busy), Ctrl+Enter too; Shift+Enter, IME, blank and in-flight Enter never send; steer and a two-tap abort", { timeout: 180_000 }, async (t) => {
	let busy = true;
	const d = await viewer(t);
	await operatorSession(t, d.stateDir, () => !busy);
	let tab = await d.open(OPERATOR);
	await tab.find(".operator-composer-send", (b) => b.getAttribute("aria-label") === "Send after this turn");
	const placeholder = field(tab).getAttribute("placeholder")!;
	assert.deepEqual([placeholder, field(tab).getAttribute("title"), field(tab).getAttribute("rows")], ["Message Operator…", "Enter sends · Shift+Enter for a new line", "1"]);
	assert.ok(placeholder.length <= 26, "the placeholder fits the one-row box at 390px");
	const sent = async (n: number) => pick(await posted(tab, n), ["kind", "text", "deliver"]);
	tab.type(field(tab), "ship it");
	await press(tab, field(tab));
	assert.deepEqual(await sent(1), { kind: "message", text: "ship it", deliver: "followUp" }, "Enter while busy follows up after this turn");
	await cleared(tab);
	tab.type(field(tab), "line one");
	await press(tab, field(tab), "Enter", { shiftKey: true });
	await press(tab, field(tab), "Enter", { isComposing: true });
	await press(tab, field(tab), "Enter", { keyCode: 229 });
	tab.type(field(tab), "   ");
	await press(tab, field(tab));
	tab.type(field(tab), "after");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	assert.deepEqual(await sent(2), { kind: "message", text: "after", deliver: "followUp" }, "the send button follows up; no Shift+Enter, IME or blank Enter sent first");
	await cleared(tab);
	tab.type(field(tab), "now");
	tab.click(await tab.find(".operator-composer-menu button", (b) => b.textContent === "Steer now" && !b.hasAttribute("disabled")));
	assert.deepEqual(await sent(3), { kind: "message", text: "now", deliver: "steer" });
	tab.click(await tab.find(".operator-composer-abort", (b) => !b.hasAttribute("disabled")));
	await tab.find(".operator-composer-abort", (b) => b.textContent === "Tap again to abort");
	assert.equal(messages(tab), 3, "the first abort tap only arms it");
	tab.click(tab.$(".operator-composer-abort")!);
	assert.deepEqual(await sent(4), { kind: "abort", text: undefined, deliver: undefined }, "the confirm tap aborts");
	assert.ok(await tab.find(".operator-composer-abort", (b) => b.textContent === "Abort turn"), "and disarms again");

	busy = false;
	tab = await tab.reopen();
	await tab.find(".operator-composer-send", (b) => b.getAttribute("aria-label") === "Send");
	assert.equal(tab.$(".operator-composer-more") === null, true, "idle: no steer or abort menu");
	tab.type(field(tab), "hello");
	await press(tab, field(tab));
	assert.deepEqual(await sent(1), { kind: "message", text: "hello", deliver: undefined }, "Enter while idle is a plain send");
	await cleared(tab);
	tab.type(field(tab), "hello again");
	await press(tab, field(tab), "Enter", { ctrlKey: true });
	assert.deepEqual(await sent(2), { kind: "message", text: "hello again", deliver: undefined }, "Ctrl+Enter sends like Enter");
	await cleared(tab);
	tab.type(field(tab), "plain");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	assert.deepEqual(await sent(3), { kind: "message", text: "plain", deliver: undefined }, "the send button while idle is a plain send");

	const held = await d.open(OPERATOR, /^\/api\/operator\/message$/);
	held.type(await held.find("textarea"), "again");
	await press(held, field(held));
	await until(() => messages(held), (n) => n === 1, "the held send");
	held.type(field(held), "again");
	await press(held, field(held));
	await settle();
	assert.equal(messages(held), 1, "a send in flight is left alone");
	held.release();
});

test("P19-composer-draft: a draft link fills the composer, clipped to the text cap, and never reaches the API; it sends only when asked, online or offline", { timeout: 180_000 }, async (t) => {
	const draft = "Explain why picp job cp-render failed and the available recovery options.";
	for (const offline of [false, true]) {
		const d = await viewer(t);
		if (!offline) await operatorSession(t, d.stateDir);
		const tab = await openTab(t, d.port, composerHref(draft));
		const box = await tab.find("textarea", (f) => (f as HTMLTextAreaElement).value === draft);
		assert.equal(box.hasAttribute("disabled"), false);
		assert.ok(tab.requests.some((r) => r.path === "/api/sessions?view=you&transcript=1"));
		assert.deepEqual(tab.requests.filter((r) => r.path.includes("draft")), [], "the draft never reaches the read API");
		assert.equal(messages(tab), 0, "opening the link never sends");
		tab.type(box, `${draft} Include the recorded cause.`);
		await settle();
		assert.equal(messages(tab), 0, "editing never sends");
		tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
		const body = await posted(tab, 1);
		assert.deepEqual([pick(body, ["kind", "text"]), "thread" in body], [{ kind: "message", text: `${draft} Include the recorded cause.` }, false], offline ? "offline" : "online");
		if (offline) continue;
		const schedule = await tab.reopen(composerHref("Add a schedule (cp_schedule add): name …"));
		assert.ok(await schedule.find("textarea", (f) => (f as HTMLTextAreaElement).value === "Add a schedule (cp_schedule add): name …"), "the Schedules page's Add schedule… draft");
		const long = await schedule.reopen(composerHref("x".repeat(16_500)));
		assert.equal((await long.find("textarea", (f) => (f as HTMLTextAreaElement).value.length > 0) as HTMLTextAreaElement).value.length, 16_000);
	}
});

test("P19-composer-footer: attach and a closed Options naming the session file share the footer; off or with no file, no Options", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const session = await operatorSession(t, d.stateDir);
	let tab = await d.open(OPERATOR);
	const options = await tab.find(".operator-composer-box > .operator-composer-footer > details.operator-composer-options");
	assert.equal(options.hasAttribute("open"), false);
	assert.equal(options.querySelector("summary")?.getAttribute("aria-label"), "Message options");
	assert.match(options.querySelector("summary")?.textContent ?? "", /^Options ▾/);
	assert.match(options.textContent ?? "", /operator-session\.jsonl/);
	assert.deepEqual([tab.$(".operator-composer-state")?.textContent, tab.$(".operator-composer-state code") === null, field(tab).getAttribute("placeholder")], ["Ready", true, "Message Operator…"]);
	assert.equal(tab.$('select[aria-label="Thread"]') === null && tab.$(".thread-pill") === null, true, "no thread picker (#588)");
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	tab = await tab.reopen();
	await tab.waitText(/Dashboard control is off/);
	assert.equal(tab.$(".operator-composer-options") === null, true);
	rmSync(controlConfigFile(d.stateDir));
	session.control.stop();
	await operatorSession(t, d.stateDir, () => true, { sessionFile: () => undefined });
	tab = await tab.reopen();
	await tab.find(".operator-composer-state", (s) => s.textContent === "Ready");
	assert.equal(tab.$(".operator-composer-options") === null, true, "no empty Options without a destination file");
});

test("P19-composer-skills: @ lists the installed skills once; arrows, Enter and Tab insert, Escape closes; unknown tokens hint; no list without a served control", { timeout: 180_000 }, async (t) => {
	const catalogue: Array<[string, string]> = [["teach", "Explain step by step"], ["test-driven-development", "Red, green, refactor"], ["write-tests", "Cover the change"], ...Array.from({ length: 12 }, (_, i): [string, string] => [`s${i}`, `skill ${i}`])];
	const seed = (_stateDir: string, home: string) => { for (const [name, description] of catalogue) write(join(home, "skills", name, "SKILL.md"), `---\ndescription: ${description}\n---\n\n# Body\n`); };
	const d = await viewer(t, { seed });
	const offline = await d.open(OPERATOR);
	typeAt(offline, await offline.find("textarea"), "@te");
	const held = await until(() => texts(offline, '[role="listbox"] [role="option"]'), (o) => o.length === 3, "the held composer's @te list");
	assert.equal(held.length, 3, "offline but held (controlReady): the catalogue lists");
	offline.close();
	await operatorSession(t, d.stateDir);
	const tab = await d.open(OPERATOR);
	const options = () => texts(tab, '[role="listbox"] [role="option"]');
	const hints = () => texts(tab, ".operator-composer-hint");
	const reads = () => tab.started.filter((r) => r === "GET /api/skills").length;
	typeAt(tab, await tab.find("textarea"), "please @te");
	await until(options, (o) => o.length === 3, "the @te list");
	assert.deepEqual(options(), ["@teachExplain step by step", "@test-driven-developmentRed, green, refactor", "@write-testsCover the change"], "prefix matches first, then substring");
	assert.equal(reads(), 1, "the first @ fetches the catalogue");
	assert.deepEqual([field(tab).getAttribute("aria-expanded"), field(tab).getAttribute("aria-controls"), tab.$('[role="option"]')!.getAttribute("aria-selected")], ["true", "operator-composer-skills", "true"]);
	assert.deepEqual(hints(), [], "the token being completed is not hinted while names are offered");
	await press(tab, field(tab), "ArrowDown");
	assert.ok(await tab.find('[role="option"][aria-selected="true"]', (o) => /^@test-driven-development/.test(o.textContent ?? "")), "ArrowDown moves the highlight");
	await press(tab, field(tab));
	assert.equal(await until(() => field(tab).value, (v) => v.endsWith(" "), "the insert"), "please @test-driven-development ", "Enter inserts @name and a space");
	assert.equal(tab.$('[role="listbox"]') === null, true, "the list closes after the insert");
	assert.deepEqual(texts(tab, ".operator-composer-mentions li"), ["@test-driven-development"]);
	assert.equal(messages(tab), 0, "Enter with the list open never sends");
	await press(tab, field(tab));
	assert.deepEqual(pick(await posted(tab, 1), ["kind", "text"]), { kind: "message", text: "please @test-driven-development" });
	await cleared(tab);
	typeAt(tab, field(tab), "@wr");
	await until(options, (o) => o.length === 1, "the @wr list");
	await press(tab, field(tab), "Tab");
	assert.equal(await until(() => field(tab).value, (v) => v.endsWith(" "), "the Tab insert"), "@write-tests ", "Tab inserts too");
	typeAt(tab, field(tab), "@te");
	await until(options, (o) => o.length === 3, "the @te list again");
	await press(tab, field(tab), "Escape");
	await gone(tab, '[role="listbox"]');
	await press(tab, field(tab));
	assert.deepEqual(pick(await posted(tab, 2), ["kind", "text"]), { kind: "message", text: "@te" }, "Enter sends once the list is closed");
	await cleared(tab);
	typeAt(tab, field(tab), "ask @nope about it");
	assert.deepEqual(await until(hints, (h) => h.length === 1, "the unknown hint"), ["@nope is not an installed skill — sent as plain text"]);
	assert.equal(tab.$(".operator-composer-send")!.hasAttribute("disabled"), false, "an unknown token never blocks Send");
	for (const [text, caret] of [["mail a@b.com"], ["hi @te ", 7], ["@Te"]] as Array<[string, number?]>) {
		typeAt(tab, field(tab), text, caret);
		await settle();
		assert.equal(tab.$('[role="listbox"]') === null, true, `${text}: an email, a finished token or a capital opens no list`);
		if (text === "mail a@b.com") assert.deepEqual(hints(), [], "an email is never hinted");
	}
	typeAt(tab, field(tab), "hi @te there", 6);
	assert.equal((await until(options, (o) => o.length > 0, "the caret's mention")).length, 3, "the caret decides, not the end of the text");
	typeAt(tab, field(tab), "@");
	assert.equal((await until(options, (o) => o.length > 3, "every skill")).length, 8, "at most 8 names");
	typeAt(tab, field(tab), "use @teach and @nope, mail a@b.com, @teach again", 0);
	await until(hints, (h) => h.length === 1, "the mention hints");
	assert.deepEqual([texts(tab, ".operator-composer-mentions li"), hints()], [["@teach"], ["@nope is not an installed skill — sent as plain text"]]);
	assert.equal(reads(), 1, "the catalogue is fetched once");

	const refused = await viewer(t, { requireTailnet: false, seed });
	await operatorSession(t, refused.stateDir);
	assert.deepEqual([(await refused.get("/api/skills")).status, (await refused.get("/api/operator/control")).status], [403, 403], "without --require-tailnet neither the catalogue nor control is served");
	const plain = await refused.open(OPERATOR);
	await until(() => plain.requests.filter((r) => r.path.startsWith("/api/sessions")).length, (n) => n > 0, "the transcript read");
	await settle();
	assert.equal(plain.$("textarea") === null, true, "so no composer can hint a refused catalogue");
});

// ---- the transcript as a chat ---------------------------------------------------------------------------------------

const at = (hm: string) => `2026-10-04T${hm}:00Z`;
const line = (hm: string, message: unknown) => ({ type: "message", timestamp: at(hm), message });
const image = (n: number, ext: string) => `im-2026100${n}-${"0123456789abcdef".repeat(2).slice(n, n + 24)}.${ext}`;
const TX = "tx-20261004-0123456789abcdef01234567.html", LONG_NAME = `${"a".repeat(100)}.html`;
/** The minified stylesheet the served page links. */
const servedCss = async (d: { get(path: string): Promise<{ text: string }> }) => (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
/** A viewer whose recorded operator transcript is `rows`; `seed` adds state (asks, upload audit lines). */
const chat = (t: Context, rows: unknown[], seed?: (stateDir: string) => void) => viewer(t, { seed: (stateDir, home) => {
	const file = join(home, "pi-sessions", "chat.jsonl");
	write(file, jsonl(rows));
	write(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at: at("13:00"), session_file: file }]));
	seed?.(stateDir);
} });
const dashboardSay = (hm: string, id: string, text: string, tail = "") => line(hm, { role: "user", content: [{ type: "text", text: `${text}\n[cp-dashboard ${id} — from the dashboard${tail}]` }] });

test("P19-transcript-chat: own bubbles right, the session's left, grouped under one header; markdown is elements, never HTML; notices and ask cards are not bubbles", { timeout: 120_000 }, async (t) => {
	let askId = "";
	const markdown = "Summary:\n- **one**\n- two\n  more of two\n  - nested\n1. first\n\n```\nnpm test -- a-very-long-command-line\n  indented\n```\n\n| job | CI |\n| --- | :-: |\n| cp-a | `green` |\n\n## Title\n> quoted\n> twice\n\n| not a table |\nplain\n\none\ntwo\n\n<script>alert(1)</script>";
	const d = await chat(t, [
		line("14:00", { role: "user", content: [{ type: "text", text: "first own" }] }),
		line("14:01", { role: "user", content: [{ type: "text", text: "second own" }] }),
		line("14:01", { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a" } }] }),
		line("14:01", { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "a\nb" }] }),
		line("14:02", { role: "assistant", content: [{ type: "text", text: markdown }] }),
		line("14:03", { role: "assistant", content: [{ type: "text", text: "grouped reply\n\n```\nunclosed" }] }),
		line("14:30", { role: "assistant", content: [{ type: "text", text: "after a long gap" }] }),
		dashboardSay("14:31", "dc-20261004143100-0123abcd", "from the dashboard"),
		{ type: "compaction", timestamp: at("14:32"), tokensBefore: 182000 },
		...parentCall("ask-call", { action: "ask" }, "ASK").map((row) => ({ ...row, timestamp: at("14:33") })),
	], (stateDir) => { askId = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "CARD", recommendation: "Keep", options: [{ label: "Keep", consequence: "Keep it" }] }).id; });
	const file = join(d.home, "pi-sessions", "chat.jsonl");
	write(file, readFileSync(file, "utf8").replace('"ASK"', JSON.stringify(JSON.stringify({ id: askId }))));
	const tab = await d.open(OPERATOR);
	await tab.find(".session-ask");
	const bubbles = tab.$$(".session-bubble");
	assert.deepEqual(bubbles.map((b) => b.getAttribute("class")), [
		"session-message session-say session-bubble session-own",
		"session-message session-say session-bubble session-own session-grouped",
		"session-message session-say session-bubble session-other",
		"session-message session-say session-bubble session-other session-grouped",
		"session-message session-say session-bubble session-other",
		"session-message session-say session-bubble session-own",
	], "a tool run never splits a group; a 27-minute gap and a change of author do");
	const hm = (s: string) => time(at(s));
	assert.deepEqual(bubbles.map((b) => b.querySelector(".session-who")?.textContent ?? null), [`You${hm("14:00")}`, `You${hm("14:01")}`, `OPOperator${hm("14:02")}`, null, `OPOperator${hm("14:30")}`, `Youdashboard${hm("14:31")}`], "own pills keep their time; the session's header shows once per group");
	assert.deepEqual(bubbles.map((b) => b.querySelector(".session-who") === null ? null : b.firstElementChild!.classList.contains("session-who") ? "above" : "below"), ["below", "below", "above", null, "above", "below"], "own time below the pill, the session's header above");
	assert.equal(bubbles[0]!.querySelector(".session-who-name")?.textContent, "You");
	assert.ok(bubbles[2]!.querySelector(".session-avatar.session-avatar-bot"), "the Operator wears the identity avatar");
	const html = tab.root.innerHTML, days = tab.$$(".session-day").map((s) => [s.textContent, html.indexOf(s.outerHTML)] as const);
	assert.deepEqual(days.filter(([, i]) => i < html.indexOf(bubbles[5]!.outerHTML)).map(([day]) => day), ["Sun, Oct 4"], "one day separator above the first message of 4 Oct");
	const md = bubbles[2]!;
	assert.deepEqual([...md.querySelectorAll("ul > li > strong")].map((s) => s.textContent), ["one"]);
	assert.deepEqual([...md.querySelectorAll("ul ul > li")].map((li) => li.textContent), ["nested"], "an indented item nests under the item above");
	assert.deepEqual([...md.querySelectorAll("ol > li")].map((li) => li.textContent), ["first"]);
	assert.equal(md.querySelector("pre.md-code > code")?.textContent, "npm test -- a-very-long-command-line\n  indented", "a fence keeps its indentation");
	assert.deepEqual([...md.querySelectorAll(".md-table th, .md-table td")].map((c) => c.textContent), ["job", "CI", "cp-a", "green"], "one table, its rule row aligned");
	assert.equal(md.querySelector(".md-table td code")?.textContent, "green");
	assert.deepEqual([md.querySelector(".md-heading strong")?.textContent, md.querySelector("blockquote")?.textContent], ["Title", "quoted\ntwice"]);
	assert.ok([...md.querySelectorAll("p")].some((p) => p.textContent === "| not a table |\nplain"), "a pipe line without a rule stays text");
	assert.ok([...md.querySelectorAll("p")].some((p) => p.textContent === "one\ntwo"), "a paragraph keeps its line break");
	assert.ok([...md.querySelectorAll("p")].some((p) => p.textContent === "<script>alert(1)</script>"), "HTML stays literal text");
	assert.equal(tab.root.querySelector("script") === null, true);
	assert.equal(bubbles[3]!.querySelector("pre.md-code > code")?.textContent, "unclosed", "an unclosed fence runs to the end");
	assert.equal(tab.$(".session-system")?.getAttribute("class"), "session-message session-notice session-system", "compaction is a compact system row");
	assert.match(tab.$(".session-system")?.textContent ?? "", /Context compacted \(182000 tokens before\)/);
	assert.ok(tab.$("article.session-message.session-notice:not(.session-system) .session-ask"), "the ask card keeps its card");
	assert.match(bubbles[5]!.textContent!, /dashboard dc-20261004143100-0123abcd/, "a dashboard message keeps its id");
});

test("P19-transcript-media: a dashboard bubble's upload ids are thumbnails that open and close, a gone one reads image expired; text files are chips to plain-text views; fences stay code", { timeout: 120_000 }, async (t) => {
	const ids = [image(4, "png"), image(5, "jpg")];
	const d = await chat(t, [
		dashboardSay("14:00", "dc-20261004140000-0123abcd", "look", `; images=${ids.join(",")}`),
		line("14:01", { role: "assistant", content: [{ type: "text", text: "no images here" }] }),
		dashboardSay("14:02", "dc-20261004140200-4567abcd", "File: report.html\n~~~~~text\n<script>alert(1)</script>\n```\n~~~~\n~~~~~", `; files=${TX}`),
	], (stateDir) => write(controlJournalFile(stateDir), jsonl([{ type: "upload", id: TX, name: LONG_NAME, bytes: 1025 }])));
	const tab = await d.open(OPERATOR);
	const bubble = await tab.find(".session-bubble", (b) => b.querySelector("img.session-image") !== null);
	assert.deepEqual([...bubble.querySelectorAll("img.session-image")].map((i) => i.getAttribute("src")), ids.map((id) => `/api/operator/uploads/${id}`), "same-origin upload route, so img-src 'self' holds");
	assert.equal(tab.$$(".session-images").length, 1, "only the bubble with images gets a strip");
	tab.click(bubble.querySelector(".session-image-toggle")!);
	await until(() => bubble.querySelector(".session-images > li")?.getAttribute("class"), (c) => c === "session-image-open", "the opened image");
	assert.equal(bubble.querySelector(".session-image-toggle")!.getAttribute("aria-expanded"), "true");
	tab.click(bubble.querySelector(".session-image-toggle")!);
	await until(() => bubble.querySelector(".session-image-open"), (o) => o === null, "a second tap closes it");
	assert.equal((await d.get(`/api/operator/uploads/${ids[1]}`)).status, 404, "the second upload is gone from the store");
	bubble.querySelectorAll("img.session-image")[1]!.dispatchEvent(new tab.window.Event("error"));
	assert.deepEqual(await until(() => [...bubble.querySelectorAll(".session-images > li")].map((li) => li.textContent), (l) => l[1] === "image expired", "image expired"), ["", "image expired"], "the gone file reads image expired; the other stays");
	assert.equal(bubble.querySelectorAll("img.session-image").length, 1);
	assert.doesNotMatch(bubble.outerHTML, /style=/, "no inline styles (CSP style-src-attr 'none')");
	const link = await tab.find(".session-file-link");
	assert.deepEqual([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")], [`/api/operator/uploads/${TX}`, "_blank", "noopener noreferrer"]);
	assert.deepEqual([link.querySelector("span")?.textContent, link.querySelector("small")?.textContent], [LONG_NAME, "2 KiB"], "the audit line's name and size");
	assert.equal(link.closest(".session-bubble")!.querySelector("pre code")?.textContent, "<script>alert(1)</script>\n```\n~~~~", "a longer fence holds shorter ones as code");
	assert.equal(tab.root.querySelector("script") === null, true);
	const css = await servedCss(d);
	assert.match(css, /\.session-images\{[^}]*flex-wrap:wrap/, "tiles wrap inside the bubble at 390 px");
	assert.match(css, /\.session-image\{[^}]*width:96px;height:96px;object-fit:cover/);
	assert.match(css, /\.session-image-open \.session-image\{[^}]*max-width:100%/, "an opened image never passes the bubble");
	assert.match(css, /\.session-files\{[^}]*flex-wrap:wrap/);
	assert.match(css, /\.session-file-link\{[^}]*min-height:44px;[^}]*overflow-wrap:anywhere/);
});

test("P19-transcript-scroll: the transcript stays pinned to the bottom unless scrolled up; the pill jumps back and re-pins; an opened relay shows six lines behind Show more", { timeout: 120_000 }, async (t) => {
	const relay = ["HELD PR LANDED", ...Array.from({ length: 10 }, (_, i) => `RELAY-${i + 1}`)].join("\n");
	const rows: unknown[] = [
		{ type: "custom_message", timestamp: at("14:00"), customType: "cp-bridge", display: true, content: relay },
		{ type: "custom_message", timestamp: at("14:00"), customType: "cp-bridge", display: true, content: "short\nRELAY-SHORT" },
		line("14:01", { role: "assistant", content: [{ type: "text", text: "a1" }] }),
	];
	const d = await chat(t, rows);
	const file = join(d.home, "pi-sessions", "chat.jsonl");
	const tab = await d.open("#settings");
	// Linkedom lays nothing out: the transcript's scroll metrics and layout observer are the test's own.
	const metrics = { scrollHeight: 1000, clientHeight: 400 }, tops = new WeakMap<object, number>(), observers: Array<() => void> = [];
	const proto = tab.window.HTMLElement.prototype as object;
	const saved = ["scrollHeight", "clientHeight", "scrollTop"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
	t.after(() => { for (const [key, was] of saved) { if (was) Object.defineProperty(proto, key, was); else Reflect.deleteProperty(proto, key); } });
	Object.defineProperties(proto, {
		scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
		clientHeight: { configurable: true, get: () => metrics.clientHeight },
		scrollTop: { configurable: true, get(this: object) { return tops.get(this) ?? 0; }, set(this: object, value: number) { tops.set(this, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); } },
	});
	tab.globals.ResizeObserver = class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} };
	tab.go(OPERATOR);
	const scroller = () => tab.$(".session-transcript") as unknown as { scrollTop: number; dispatchEvent(e: Event): boolean };
	const pill = () => tab.$(".session-new");
	const grow = async (height: number) => { metrics.scrollHeight = height; for (const callback of observers) callback(); await settle(); };
	const more = async (text: string, height: number) => {
		metrics.scrollHeight = height;
		rows.push(line("14:02", { role: "assistant", content: [{ type: "text", text }] }));
		write(file, jsonl(rows));
		tab.refresh();
		await tab.waitText(new RegExp(text));
		await settle();
	};
	await tab.waitText(/a1/);
	assert.equal(await until(() => scroller().scrollTop, (top) => top === 600, "the open at the newest"), 600, "opens at the newest entry");
	assert.equal(pill() === null, true);
	await grow(1100);
	assert.equal(await until(() => scroller().scrollTop, (top) => top === 700, "the re-pin after late layout"), 700, "late layout keeps a pinned transcript at the bottom");
	scroller().scrollTop = 200;
	scroller().dispatchEvent(new tab.window.Event("scroll"));
	assert.equal((await tab.find(".session-new")).textContent, "Jump to latest", "scrolled up: the pill offers the way back");
	await more("a3", 1200);
	assert.equal(scroller().scrollTop, 200, "a new entry never yanks a reader who scrolled up");
	await grow(1250);
	assert.equal(scroller().scrollTop, 200, "nor does late layout");
	metrics.scrollHeight = 1200;
	tab.click(pill()!);
	await settle();
	assert.equal(await until(() => scroller().scrollTop, (top) => top === 800, "the pill's jump"), 800, "the pill jumps to the latest");
	assert.equal(pill() === null, true, "and goes away");
	await more("a4", 1400);
	const repinned = () => [tab.$$(".session-bubble").some((b) => b.textContent?.includes("a4")), scroller().scrollTop] as const;
	assert.deepEqual(await until(repinned, ([shown, top]) => shown && top === 1000, "a4 rendered and the re-pin"), [true, 1000], "pinned again: the next entry scrolls into view");

	const [long, short] = tab.$$(".session-bridge");
	tab.click(long!.querySelector(".session-notice-line")!);
	assert.equal((await tab.find(".session-notice-rest p")).textContent, "RELAY-1\nRELAY-2\nRELAY-3\nRELAY-4\nRELAY-5\nRELAY-6");
	assert.equal(long!.querySelector(".session-notice-more")!.textContent, "Show more (4 lines)");
	tab.click(long!.querySelector(".session-notice-more")!);
	assert.match(await until(() => long!.querySelector(".session-notice-rest p")!.textContent!, (s) => s.includes("RELAY-10"), "the rest"), /RELAY-6\nRELAY-7\nRELAY-8\nRELAY-9\nRELAY-10$/);
	assert.equal(long!.querySelector(".session-notice-more") === null, true);
	tab.click(short!.querySelector(".session-notice-line")!);
	await until(() => short!.querySelector(".session-notice-rest"), Boolean, "the short relay opened");
	assert.equal(short!.querySelector(".session-notice-more") === null, true, "nothing to hide, no Show more");
});

test("P19-transcript-css: phone pills reach 84% and cards the column; desktop one 820 px column, 670 px cards, 72% pills; code and tables scroll inside; one light palette on Sessions and Report", { timeout: 120_000 }, async (t) => {
	const css = await servedCss(await viewer(t));
	const wide = css.indexOf(".session-entries{max-width:820px"), split = css.lastIndexOf("@media(min-width:900px)", wide);
	assert.ok(split > 0 && wide > split, "the 820 px column is desktop only");
	const [phone, desktop] = [css.slice(0, split), css.slice(split)];
	/** Every declaration the served CSS gives `selector` in `sheet`, in order. */
	const rules = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	assert.match(rules(phone, ".session-bubble>.session-body"), /max-width:100%;.*overflow-wrap:anywhere/);
	assert.match(rules(phone, ".session-own>.session-body"), /^max-width:84%;padding:9px 14px;background:var\(--session-you\);color:var\(--session-you-text\)/);
	assert.match(rules(phone, ".session-other>.session-body"), /^padding:10px 14px;background:var\(--raised\);border:1px solid var\(--divider\);border-radius:4px 18px 18px/);
	assert.match(rules(phone, ".md .md-code"), /max-width:100%;.*overflow-x:auto;.*white-space:pre/, "a long code line scrolls inside the bubble");
	assert.match(rules(phone, ".md-table"), /^max-width:100%;overflow-x:auto/, "a wide table scrolls inside the bubble");
	assert.match(rules(phone, ".sessions .md-table tbody tr:last-child td"), /border-bottom:0/, "Sessions tables have no rule under the last row");
	assert.match(rules(phone, ".session-message.session-system"), /display:flex;.*background:none;border:0/, "system rows are never cards");
	assert.match(rules(phone, ".session-message.session-other"), /padding-left:34px/, "chat v2: the phone avatar gutter is 26 px plus an 8 px gap");
	assert.match(rules(phone, ".session-other>.session-who>.session-avatar"), /position:absolute/, "the avatar sits in that gutter");
	assert.match(rules(phone, ".session-avatar"), /^display:flex/, "the phone avatar is visible, not hidden below 900 px");
	assert.match(rules(desktop, ".session-entries"), /^max-width:820px;margin:0 auto;padding:0 32px/);
	assert.match(rules(desktop, ".session-other>.session-body"), /max-width:670px/);
	assert.match(rules(desktop, ".session-own>.session-body"), /max-width:72%/);
	assert.match(rules(phone, ".session-transcript"), /flex:1;min-height:0;overflow-y:auto/, "the transcript is the one scroller");
	assert.match(rules(css, ".operator-composer"), /flex-shrink:0/, "the composer keeps its height at the bottom of the panel");
	const light = /@media\(prefers-color-scheme:light\)\{\.shell-sessions,\.shell-report\{([^}]*)\}\}/.exec(css)?.[1] ?? "";
	assert.match(light, /color-scheme:light;color:var\(--text\)/, "native controls and inherited text follow");
	for (const pair of ["--background: #f4f2ed;", "--nav: #ebe8e1;", "--raised: #ffffff;", "--text: #1d1c1a;", "--dim: #6b675f;", "--session-you: #2d5aa8;", "--session-code-mix: 5%"]) assert.ok(light.includes(pair), `measured light token: ${pair}`);
	assert.equal(css.match(/prefers-color-scheme/g)?.length, 1, "one light block in every served stylesheet");
});

// ---- tool calls and bridge notices in the transcript ----------------------------------------------------------------

const TOOLS_KEY = "cp-sessions-tool-calls";
/** One recorded tool call and its result; the result's first line is its summary. */
const toolRun = (id: string, name: string, result: string, hm = "14:00") => [
	line(hm, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { id } }] }),
	line(hm, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result }] }),
];
const toolTexts = (tab: Tab) => tab.$$(".session-tool").map((tool) => tool.textContent ?? "");
const pills = (tab: Tab) => texts(tab, ".session-tools");
/** Every declaration the served CSS gives `selector` in `sheet`, in order. */
const cssRules = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");

test("P19-tools-toggle: tool calls hide by default, a run is one pill that opens alone, the toggle shows all and is remembered; messages, notices and cards stay", { timeout: 120_000 }, async (t) => {
	let askId = "";
	const d = await chat(t, [
		line("14:00", { role: "user", content: [{ type: "text", text: "MESSAGE-ONE" }] }),
		...toolRun("t1", "read", "Read 42 lines\nTOOL-ONE"), ...toolRun("t2", "bash", "Ran npm test\nTOOL-TWO"), ...toolRun("t3", "read", "Read 8 lines\nTOOL-THREE"),
		line("14:01", { role: "assistant", content: [{ type: "text", text: "MESSAGE-TWO" }] }),
		...toolRun("t4", "read", "Read 2 lines\nTOOL-FOUR", "14:01"),
		{ type: "custom_message", timestamp: at("14:02"), customType: "cp-bridge", display: true, content: "SYSTEM-NOTICE" },
		...parentCall("ask-call", { action: "ask" }, "ASK").map((row) => ({ ...row, timestamp: at("14:03") })),
	], (stateDir) => { askId = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "CARD-QUESTION", recommendation: "Keep", options: [{ label: "Keep", consequence: "Keep it" }] }).id; });
	const file = join(d.home, "pi-sessions", "chat.jsonl");
	write(file, readFileSync(file, "utf8").replace('"ASK"', JSON.stringify(JSON.stringify({ id: askId }))));
	let tab = await d.open(OPERATOR);
	const toggle = () => tab.$(".session-tools-toggle")!;
	await tab.find(".session-tools-toggle");
	assert.deepEqual(toolTexts(tab), [], "no tool call renders before the toggle");
	assert.deepEqual(pills(tab), ["≡ 3 steps · Read 42 lines ▸", "≡ 1 step · Read 2 lines ▸", "≡ 1 step · Completed ▸"], "consecutive calls collapse into one pill with the hidden count");
	assert.deepEqual([toggle().textContent, toggle().getAttribute("aria-pressed")], ["Tools 5", "false"], "the toggle counts everything hidden");
	for (const text of ["MESSAGE-ONE", "MESSAGE-TWO", "SYSTEM-NOTICE", "CARD-QUESTION"]) assert.match(tab.text(), new RegExp(text), `${text} is never hidden`);
	tab.click(tab.$$(".session-tools")[0]!);
	await until(() => toolTexts(tab).length, (n) => n === 3, "the first run open");
	assert.deepEqual(toolTexts(tab).map((text) => /TOOL-\w+/.exec(text)?.[0]), ["TOOL-ONE", "TOOL-TWO", "TOOL-THREE"], "only the clicked run expands");
	assert.deepEqual(pills(tab).slice(0, 2), ["≡ 3 steps ▾", "≡ 1 step · Read 2 lines ▸"], "open, the pill drops its preview; the other run is untouched");
	assert.equal(tab.$$(".session-steps-open .session-steps-rows .session-tool").length, 3, "the opened run's rows sit in one card");
	assert.equal(toggle().textContent, "Tools 5", "the count is every tool call, open or not");
	tab.click(tab.$$(".session-tools")[0]!);
	await until(() => toolTexts(tab).length, (n) => n === 0, "the run collapsed again");
	tab.click(toggle());
	assert.equal((await until(() => toolTexts(tab), (all) => all.length === 5, "every call shown")).length, 5);
	assert.deepEqual([pills(tab), toggle().textContent, tab.storage.get(TOOLS_KEY)], [[], "Tools 5", "1"], "no pills while shown; one key written");
	tab = await tab.reopen();
	assert.equal((await until(() => toolTexts(tab), (all) => all.length === 5, "shown after a reload")).length, 5, "the shown choice survives a reload");
	tab.click(await tab.find(".session-tools-toggle"));
	await until(() => toolTexts(tab).length, (n) => n === 0, "hidden again");
	assert.equal(tab.storage.get(TOOLS_KEY), "0");
	tab = await tab.reopen();
	await tab.find(".session-tools");
	assert.deepEqual(toolTexts(tab), [], "the hidden choice survives a reload");

	const long = await chat(t, toolRun("t1", "read", `Read 42 lines\n${"x".repeat(1300)}-TAIL-MARKER`));
	const tail = await openTab(t, long.port, OPERATOR, new Map([[TOOLS_KEY, "1"]]));
	assert.match((await tail.waitText(/show all/), tail.text()), /show all/, "show all is on screen");
	assert.match(tail.text(), /-TAIL-MARKER/, "a long call keeps its tail behind show all");
	assert.doesNotMatch(tail.root.innerHTML, /x{1300}/, "the head is the truncation point");

	const refusing = await long.open("#settings");
	const warnings: unknown[][] = [], warn = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args);
	t.after(() => { console.warn = warn; });
	const refused = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem() {} };
	refusing.globals.localStorage = refused;
	Object.defineProperty(refusing.window, "localStorage", { configurable: true, value: refused });
	refusing.go(OPERATOR);
	refusing.click(await refusing.find(".session-tools-toggle"));
	assert.equal((await until(() => toolTexts(refusing), (all) => all.length === 1, "shown without storage")).length, 1, "the choice holds for this view");
	console.warn = warn;
	assert.deepEqual(warnings, [["tool-call toggle not persisted: QuotaExceededError"]], "a refused write warns");
});

/** A cp-bridge wake as cp-bridge relays it, its `paths:` block naming this home's run and an unlisted artifact. */
const wakeNotice = (stateDir: string, hm = "14:00") => ({ type: "custom_message", timestamp: at(hm), customType: "cp-bridge", display: true, content: [
	"[cp-bridge wake job=cp-xrhq receipt=owner_observed]",
	"[pi-command-post-system] Mobile chat layout and the no-zoom addendum landed: https://github.com/0xb1ob/pi-command-post/pull/357.",
	"Web-search implementation cp-yxgl remains pending your approval.",
	"paths:",
	`- ${stateDir}/runs/cp-xrhq/artifact.md`,
	`- ${stateDir}/runs/cp-xrhq`,
	`- ${stateDir}/artifacts/cp-xrhq/report.md`,
].join("\n") });
/** A viewer whose transcript is `rows(stateDir)`, with cp-xrhq listed in the fleet so its run paths link. */
const bridged = (t: Context, rows: (stateDir: string) => unknown[]) => viewer(t, { seed: (stateDir, home) => {
	write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-xrhq", project: "picp", phase: "held" }] });
	const file = join(home, "pi-sessions", "chat.jsonl");
	write(file, jsonl(rows(stateDir)));
	write(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at: at("13:00"), session_file: file }]));
} });

test("P19-bridge-notice: a wake is one collapsed row (chip once, job linked, toggle inline) that opens its body and paths in place; own and assistant words never collapse", { timeout: 120_000 }, async (t) => {
	const d = await bridged(t, (stateDir) => [
		line("13:59", { role: "user", content: [{ type: "text", text: "operator words\nsecond operator line" }] }),
		wakeNotice(stateDir),
		line("14:01", { role: "assistant", content: [{ type: "text", text: "assistant words\nsecond assistant line" }] }),
	]);
	let tab = await d.open(OPERATOR);
	const toggle = () => tab.$(".session-notice-line")!;
	const row = await tab.find(".session-bridge-line");
	assert.deepEqual([row.textContent, toggle().getAttribute("aria-expanded"), toggle().getAttribute("aria-label")], ["bridgewoke cp-xrhq· owner observednotice ▸", "false", "Show notice"], "one row: chip, verb, job, receipt, toggle");
	assert.equal(tab.$$(".session-bridge-chip").length, 1);
	assert.equal(row.textContent!.match(/bridge/g)?.length, 1, "the word bridge appears once: the chip");
	assert.equal(tab.$(".session-bridge .session-who") === null, true, "no separate who/tag line");
	assert.equal(row.querySelector(".session-bridge-what a")?.getAttribute("href"), "#job/cp-xrhq", "the job opens Job detail");
	assert.equal(row.querySelector("button.session-notice-line")?.textContent, "notice ▸", "the toggle sits inside the row");
	assert.doesNotMatch(tab.root.innerHTML, /Mobile chat layout|pull\/357/, "the body stays hidden");
	assert.equal(tab.$$(".session-notice-line").length, 1, "only the bridge notice carries an expander");
	assert.match(tab.text(), /operator words\nsecond operator line/, "the operator's own words are all on screen");
	assert.match(tab.text(), /assistant words\nsecond assistant line/, "so is every assistant reply");
	tab.click(toggle());
	await tab.waitText(/Mobile chat layout/);
	assert.equal(toggle().getAttribute("aria-expanded"), "true");
	assert.equal(row.nextElementSibling?.getAttribute("class"), "session-notice-rest", "the body opens directly below the row");
	const state = d.stateDir;
	assert.deepEqual(tab.$$(".session-notice-paths a").map((a) => [a.getAttribute("href"), a.textContent]), [["#job/cp-xrhq", `${state}/runs/cp-xrhq/artifact.md`], ["#job/cp-xrhq", `${state}/runs/cp-xrhq`]], "the paths: block is a list of links");
	assert.ok(tab.text().includes(`${state}/artifacts/cp-xrhq/report.md`), "a path with no viewer target keeps its text");
	assert.doesNotMatch(tab.text(), /paths:|^- \//m, "the raw block is replaced by the list");
	tab.click(toggle());
	await until(() => toggle().getAttribute("aria-expanded"), (v) => v === "false", "collapsed again");
	tab.click(toggle());
	tab = await tab.reopen();
	assert.equal((await tab.find(".session-notice-line")).getAttribute("aria-expanded"), "false", "a fresh view starts collapsed: nothing is remembered");
});

test("P19-bridge-steps: a wake and the calls after it are one run of steps; notice and tools open apart; Tools on opens every run; a lone run and a bare notice keep their shapes", { timeout: 120_000 }, async (t) => {
	const rows = (stateDir: string) => [
		line("13:59", { role: "assistant", content: [{ type: "text", text: "MESSAGE-ONE" }] }),
		wakeNotice(stateDir),
		line("14:00", { role: "assistant", content: [{ type: "thinking", thinking: "Checking the head\nTHINK-ONE" }] }),
		...toolRun("t2", "bash", "Ran git log\nTOOL-TWO"),
		line("14:01", { role: "assistant", content: [{ type: "text", text: "MESSAGE-TWO" }] }),
	];
	const d = await bridged(t, rows);
	const tab = await d.open(OPERATOR);
	const notice = () => tab.$(".session-steps .session-notice-line")!;
	await tab.find(".session-steps");
	assert.deepEqual(pills(tab), ["≡ 3 steps · cp-xrhq ▸"], "one pill: the wake plus two calls, named by the recorded job");
	assert.equal(tab.$$(".session-bridge").length, 1, "the notice is not repeated outside its run");
	tab.click(notice());
	await tab.waitText(/Mobile chat layout/);
	assert.deepEqual([notice().getAttribute("aria-expanded"), toolTexts(tab)], ["true", []], "the notice opens while the tools stay hidden");
	tab.click(tab.$(".session-steps > .session-tools")!);
	await until(() => toolTexts(tab).length, (n) => n === 2, "the tools open");
	assert.deepEqual(toolTexts(tab).map((text) => /THINK-ONE|TOOL-TWO/.exec(text)?.[0] ?? text), ["THINK-ONE", "TOOL-TWO"]);
	assert.deepEqual(tab.$$(".session-steps-rows .session-tool > summary > code:nth-child(2)").map((name) => name.textContent), ["think", "bash"], "thinking fits the name column as think");
	assert.equal(notice().getAttribute("aria-expanded"), "true", "opening the tools leaves the notice as it was");
	const card = tab.$(".session-steps-card")!;
	assert.deepEqual([...card.children].map((child) => child.getAttribute("class")), ["session-message session-notice session-system session-bridge", "session-steps-rows", "session-steps-link"]);
	assert.equal(card.querySelector(".session-steps-link")?.getAttribute("href"), "#job/cp-xrhq?tab=transcript");
	const state = d.stateDir;
	assert.deepEqual([...card.querySelectorAll(".session-notice-chips a, .session-notice-chips code")].map((chip) => [chip.textContent, chip.getAttribute("title")]), [["artifact.md", `${state}/runs/cp-xrhq/artifact.md`], ["cp-xrhq", `${state}/runs/cp-xrhq`], ["report.md", `${state}/artifacts/cp-xrhq/report.md`]], "chips name the file; the path stays in the title");
	const file = join(d.home, "pi-sessions", "chat.jsonl"), next = rows(state);
	next.splice(5, 0, ...toolRun("t3", "read", "Read 1 line\nTOOL-THREE"));
	write(file, jsonl(next));
	tab.refresh();
	assert.deepEqual(await until(() => pills(tab), (p) => p[0] === "≡ 4 steps · cp-xrhq ▾", "the streamed call"), ["≡ 4 steps · cp-xrhq ▾"], "a streamed call joins the open run");
	assert.deepEqual([toolTexts(tab).length, notice().getAttribute("aria-expanded")], [3, "true"]);

	const lone = await bridged(t, (stateDir) => [...toolRun("t0", "read", "ORPHAN"), line("14:01", { role: "assistant", content: [{ type: "text", text: "MESSAGE-ONE" }] }), wakeNotice(stateDir, "14:02")]);
	const shapes = await lone.open(OPERATOR);
	await shapes.find(".session-tools");
	assert.deepEqual(pills(shapes), ["≡ 1 step · ORPHAN ▸"], "a tool run with no wake notice is a run of its own, no job named");
	assert.deepEqual([shapes.$$(".session-steps .session-bridge").length, shapes.$$(".session-bridge").length], [0, 1], "a notice no calls follow stays a standalone row");
	shapes.click(shapes.$(".session-tools-toggle")!);
	await until(() => toolTexts(shapes).length, (n) => n === 1, "Tools on");
	assert.deepEqual([pills(shapes), shapes.$$(".session-steps-open .session-steps-card").length, shapes.$(".session-steps-link") === null], [[], 1, true], "no pills; the run's card; no job link without a recorded job");
});

test("P19-tools-sheet: the ⋯ sheet's tool toggle is the same remembered choice; pinned decisions collapse to one bar and close after a click; the 390 px toggle and notice rules hold at 1440", { timeout: 120_000 }, async (t) => {
	let askId = "";
	const d = await chat(t, [line("14:00", { role: "user", content: [{ type: "text", text: "MESSAGE-ONE" }] }), ...toolRun("t1", "read", "Read 42 lines\nTOOL-ONE")], (stateDir) => {
		askId = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "PINNED-QUESTION", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }).id;
	});
	await operatorSession(t, d.stateDir);
	const tab = await d.open(OPERATOR);
	const sheet = await tab.find(".session-bar-more .session-bar-sheet button[aria-pressed]", (b) => /tool calls/.test(b.textContent ?? ""));
	assert.equal(sheet.textContent, "Show tool calls (1)");
	tab.click(sheet);
	await until(() => toolTexts(tab).length, (n) => n === 1, "the sheet's toggle shows tool calls");
	assert.deepEqual([tab.storage.get(TOOLS_KEY), tab.$(".session-tools-toggle")?.textContent], ["1", "Tools 1"], "remembered like the heading toggle: one state behind both");
	const pinned = () => tab.$(".session-pinned")!, bar = () => tab.$(".session-pinned h2 button")!;
	assert.deepEqual([pinned().getAttribute("class"), bar().textContent], ["session-pinned", "1 decision waiting ▾"], "pinned decisions collapse to one bar");
	tab.click(bar());
	assert.equal((await tab.find(".session-pinned.session-pinned-open")).getAttribute("class"), "session-pinned session-pinned-open", "tapped open into the sheet");
	assert.equal(bar().getAttribute("aria-expanded"), "true");
	tab.click(await tab.find(".session-pinned .decision-card-option", (b) => !b.hasAttribute("disabled")));
	assert.deepEqual(pick(await posted(tab, 1), ["kind", "ask_id", "label"]), { kind: "answer", ask_id: askId, label: "Keep" }, "the card's button answers, once");
	assert.equal(await until(() => pinned().getAttribute("class"), (c) => c === "session-pinned", "the sheet collapsed"), "session-pinned", "and the sheet collapses after the click");
	const css = await servedCss(d);
	const wide = css.indexOf(".session-entries{max-width:820px"), desktop = css.slice(css.lastIndexOf("@media(min-width:900px)", wide), css.indexOf("}}", wide) + 2);
	assert.match(cssRules(css, ".session-tools-toggle"), /^display:flex;.*min-height:44px;.*white-space:nowrap/, "a 44px touch target that never wraps at 390px");
	assert.match(cssRules(css, ".session-system .session-notice-line"), /min-height:44px/, "the collapsed notice is a 44px target");
	assert.match(cssRules(css, ".session-system .session-notice-line>span"), /text-overflow:ellipsis;.*white-space:nowrap/, "a long first line ellipsizes");
	assert.match(cssRules(css, ".session-notice-paths a,.session-notice-paths code"), /^min-width:0;overflow-wrap:anywhere/, "long paths wrap inside the body");
	assert.doesNotMatch(desktop, /\.session-tools-toggle|\.session-bridge|\.session-notice-line|\.session-notice-paths/, "the desktop block leaves the phone rules at 1440px");
	assert.doesNotMatch(css, /\.session-tools-toggle[^{]*\{[^}]*display:none/, "the heading toggle is never hidden");
	assert.match(cssRules(css, ".session-heading"), /overflow:visible/, "the heading row does not clip the toggle");
});

// ---- the workbench: dashboard spend, the server's routes, a held job's diff, git reads, grants and the parent probe

const LATER = isoTimestamp(new Date(Date.now() + 86_400_000));
const PR = "https://github.com/acme/repo/pull/7";
const usage = (cost_usd: number, total_tokens: number, cache_read = 0): Usage => ({ ...EMPTY_USAGE, cost_usd, total_tokens, cache_read });
const record = (job_id: string, over: Partial<FleetRecord> = {}): FleetRecord => ({
	job_id, project: "alpha", kind: "ship", delivery: "pr", origin: "terminal", phase: "held", worktree: `/wt/${job_id}`, branch: job_id,
	worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m", started_at: "2026-09-01T00:00:00Z" },
	dispatched_at: "2026-09-01T00:00:00Z", usage: EMPTY_USAGE, reported_at: "2026-09-01T00:02:00Z", ...over,
});
const fleetOf = (stateDir: string, jobs: FleetRecord[]) => write(join(stateDir, "fleet.json"), { schema_version: SCHEMA_VERSION, updated_at: "2026-09-01T00:00:00Z", jobs });
const runStatus = (stateDir: string, dir: string, job_id: string, u: Usage) => write(join(stateDir, "runs", dir, "status.json"), {
	schema_version: SCHEMA_VERSION, job_id, phase: "working", turns: 1, tool_calls: 1, usage: u, started_at: "2026-09-01T00:00:00Z",
	last_activity_at: "2026-09-01T00:01:00Z", event_count: 1, reported: false,
});
const liveJobs = (home: string) => liveUsageJobs(new FleetStore({ home }), { get: (id: string) => { try { return { status: readRunStatus(home, id) }; } catch { return undefined; } } } as unknown as RunRegistry);
/** Each grant's spend as mandate.ts computes it on this home: the oracle the viewer's own mirror must equal. */
const spendOf = (home: string) => { const store = new MandateStore(home), jobs = store.withReviewerSpend(liveJobs(home)); return new Map(store.list().map((m) => [m.id, mandateSpend(m, jobs)])); };
const grantsOf = async (d: { get(path: string): Promise<{ body: Json }> }) => ((await d.get("/api/dashboard")).body as Json).mandates as Json[];

test("P19-workbench-dashboard: /api/dashboard groups by project, prefers live usage, adds reviewer spend, keeps only GitHub PR urls; every grant's spend is mandateSpend's", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed: (stateDir, home) => {
		fleetOf(stateDir, [
			record("cp-a1", { phase: "waiting", usage: usage(0.1, 100), receipts: [{ kind: "pr", status: "open", title: "x", url: "javascript:alert(1)" }] }),
			record("cp-a2", { receipts: [{ kind: "pr", status: "open", title: "x", url: PR }], usage: usage(1, 1000, 200), dispatched_at: "2026-09-01T00:00:01Z" }),
			record("cp-a3", { phase: "done", closed_at: "2026-09-02T00:00:00Z", usage: usage(0.5, 50) }),
			record("cp-b1", { project: "beta", kind: "research", usage: usage(0.25, 40) }),
			record("cp-b2", { project: "beta", receipts: [{ kind: "pr", status: "open", title: "x", url: "https://evil.example/acme/repo/pull/1" }] }),
		]);
		runStatus(stateDir, "cp-a1", "cp-a1", usage(2, 3000, 1000));
		runStatus(stateDir, "cp-a2/review-1", "cp-a2", usage(0.75, 500, 100));
		runStatus(stateDir, "cp-b1/gate-1", "cp-b1", usage(0.5, 90));
		write(join(home, ".pi-command-post", "jobs.json"), { schema_version: 1, prefix: "cp", jobs: [{ id: "cp-a1", title: "first job", status: "in_progress", labels: ["project:alpha", "kind:ship", "delivery:pr"], blocked_by: [], comments: [], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }] });
		write(join(home, LAYOUT.data, "projects.json"), { projects: [{ name: "gamma" }, { name: "../bad" }] });
		const store = new MandateStore(home), base = { objective: "ship alpha", expiry: LATER, spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5 };
		store.issue({ ...base, projects: ["alpha"], job_ids: ["cp-a1", "cp-a2"] });
		store.pause(store.issue({ ...base, projects: ["beta", "alpha"], at: isoTimestamp(new Date(Date.now() + 1000)) }).id);
	} });
	const view = (await d.get("/api/dashboard")).body as Json;
	const projects = view.projects as Json[], alpha = projects[0]!.jobs as Json[], job = (id: string) => alpha.find((j) => j.job_id === id)!;
	assert.deepEqual(projects.map((p) => p.name), ["alpha", "beta", "gamma"], "grouped by project, the unsafe name dropped");
	assert.deepEqual(alpha.map((j) => j.job_id), ["cp-a1", "cp-a2", "cp-a3"], "active in dispatch order, then finished");
	assert.deepEqual([job("cp-a1").cost_usd, job("cp-a1").tokens, job("cp-a1").title], [2, 2000, "first job"], "the run's live usage wins over the stale fleet usage");
	assert.equal(job("cp-a1").pr_url, undefined, "a javascript: url never reaches the page");
	assert.deepEqual([job("cp-a2").pr_url, job("cp-a2").reviewer_cost_usd], [PR, 0.75], "a GitHub PR url and the reviewer's spend");
	assert.equal((projects[1]!.jobs as Json[]).find((j) => j.job_id === "cp-b2")!.pr_url, undefined, "a non-GitHub url is dropped");
	assert.deepEqual(projects[2]!.jobs, []);
	const grants = view.mandates as Json[], oracle = spendOf(d.home);
	assert.deepEqual([oracle.size, grants.map((m) => m.status)], [2, ["active", "paused"]]);
	for (const [id, spend] of oracle) assert.deepEqual(grants.find((m) => m.id === id)?.spend, spend, id);
	assert.ok((grants[0]!.spend as Json).usd > 2, "the fixture exercises live and reviewer spend");
});

test("P19-workbench-spend: a baselined grant shows only what accrued after issue; a schedule grant counts its schedule's records, a project-wide grant none", { timeout: 120_000 }, async (t) => {
	let baselined = "";
	const d = await viewer(t, { seed: (stateDir, home) => {
		fleetOf(stateDir, [record("cp-h1", { phase: "done", usage: usage(1, 1000) }), record("cp-h2", { usage: usage(0.5, 500) })]);
		runStatus(stateDir, "cp-h2/review-1", "cp-h2", usage(0.25, 100));
		const grant = new MandateStore(home).issue({ objective: "alpha", expiry: LATER, spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5, projects: ["alpha"] }, liveJobs(home));
		assert.equal(grant.usage_baseline?.length, 2);
		baselined = grant.id;
		runStatus(stateDir, "cp-h2", "cp-h2", usage(1.5, 1500));
		runStatus(stateDir, "cp-h2/review-2", "cp-h2", usage(0.25, 100));
		fleetOf(stateDir, [record("cp-h1", { phase: "done", usage: usage(1, 1000) }), record("cp-h2", { usage: usage(0.5, 500) }), record("cp-n1", { usage: usage(0.5, 500) })]);
	} });
	const spend = (await grantsOf(d)).find((m) => m.id === baselined)?.spend;
	assert.deepEqual(spend, { usd: 1.75, tokens: 1600, jobs: 2, inFlight: 0 }, "only the spend after issue");
	assert.deepEqual(spend, spendOf(d.home).get(baselined), "and mandateSpend agrees");

	const ids: string[] = [];
	const s = await viewer(t, { seed: (stateDir, home) => {
		fleetOf(stateDir, [record("cp-s1", { phase: "waiting", usage: usage(1, 1000), schedule_id: "sch-aaa111" }), record("cp-s2", { usage: usage(2, 2000), schedule_id: "sch-bbb222" }), record("cp-u1", { usage: usage(4, 4000) })]);
		runStatus(stateDir, "cp-s1/review-1", "cp-s1", usage(0.5, 100));
		const store = new MandateStore(home), base = { objective: "alpha", expiry: LATER, spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5, projects: ["alpha"] };
		ids.push(store.issue({ ...base, schedule_grant: true }).id, store.issue({ ...base, schedule_grant: true }).id, store.issue(base).id);
		const saved = (id: string, mandate_id: string) => ({ id, name: id, project: "alpha", mandate_id, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job: { title: "nightly", kind: "ship", delivery: "pr" }, enabled: true, created_at: "2026-09-01T00:00:00Z" });
		write(join(stateDir, "schedules.json"), { schema_version: 1, schedules: [saved("sch-aaa111", ids[0]!), saved("sch-bbb222", ids[1]!)] });
	} });
	const grants = await grantsOf(s), oracle = spendOf(s.home);
	assert.deepEqual(ids.map((id) => grants.find((m) => m.id === id)?.spend), [
		{ usd: 1.5, tokens: 1100, jobs: 1, inFlight: 1 }, { usd: 2, tokens: 2000, jobs: 1, inFlight: 0 }, { usd: 4, tokens: 4000, jobs: 1, inFlight: 0 },
	], "its schedule's run plus its reviewer; the other schedule's; the project-wide grant counts no scheduled record");
	for (const id of ids) assert.deepEqual(grants.find((m) => m.id === id)?.spend, oracle.get(id), id);
});

test("P19-workbench-server: /api/dashboard, /api/awaiting and /api/version are JSON under a deny-all CSP; every workbench route is GET-only and host-bound", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { requireTailnet: false });
	for (const path of ["/api/dashboard", "/api/awaiting", "/api/version"]) {
		const reply = await d.send(path);
		assert.deepEqual([reply.status, typeof JSON.parse(reply.raw.toString("utf8"))], [200, "object"], path);
		assert.match(String(reply.headers["content-type"]), /application\/json/, path);
		assert.match(String(reply.headers["content-security-policy"]), /default-src 'none'/, path);
	}
	for (const path of ["/api/dashboard", "/api/awaiting", "/api/job", "/api/diff", "/api/roots", "/api/files", "/api/git", "/api/version"]) {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await d.send(path, { method })).status, 405, `${method} ${path}`);
		assert.notEqual((await d.send(path, { headers: { host: "evil.example" } })).status, 421, `${path}: the Host check is off by default`);
	}
});

test("P19-workbench-diff: /api/job carries PR, shas, CI and review; /api/diff serves base...head; /api/git status never locks the index", { timeout: 120_000 }, async (t) => {
	let base = "", head = "", repo = "";
	const d = await viewer(t, { seed: (stateDir, home) => {
		repo = join(home, LAYOUT.projects, "demo");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-b", "main", "--quiet");
		for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "base", "--quiet");
		base = git(repo, "rev-parse", "HEAD");
		writeFileSync(join(repo, "a.txt"), "one\ntwo from head\n");
		git(repo, "commit", "-am", "head", "--quiet");
		head = git(repo, "rev-parse", "HEAD");
		fleetOf(stateDir, [record("cp-h1", { project: "demo", worktree: "/nonexistent/cp-h1", receipts: [{ kind: "pr", status: "open", title: "x", url: PR }] }), record("cp-h2", { project: "demo" })]);
		const envelope = (id: string, env: object) => write(join(stateDir, "runs", id, "envelope.json"), { schema_version: 1, job_id: id, attempt: 1, envelope: env });
		envelope("cp-h1", { head_sha: head, base_sha: base, branch: "cp-h1", status: "done", summary: "landed" });
		envelope("cp-h2", { head_sha: head, branch: "cp-h2", status: "done", summary: "no base" });
		write(join(stateDir, "runs", "cp-h1", "review-1.json"), { attempt: 1, verdict: "revise", head_sha: base });
		write(join(stateDir, "runs", "cp-h1", "review-2.json"), { attempt: 2, verdict: "pass", head_sha: head });
		write(join(stateDir, "ci-watch.json"), { jobs: [{ job_id: "cp-h1", head_sha: head, last_ci: "green" }] });
	} });
	const job = (await d.get("/api/job?id=cp-h1")).body as Json;
	assert.deepEqual([job.pr_url, job.head, job.base, job.ci.last_ci, job.worktree_live], [PR, head, base, "green", false], "PR, shas, CI and no live worktree");
	assert.deepEqual(job.review, { attempt: 2, verdict: "pass", head_sha: head }, "the latest review");
	const diff = (await d.get("/api/diff?id=cp-h1")).body as Json;
	assert.deepEqual([diff.available, diff.root, diff.truncated], [true, "project:demo", false]);
	assert.match(diff.text, /^\+two from head$/m, "base...head from the project clone");
	assert.deepEqual((await d.get("/api/diff?id=cp-h2")).body, { available: false, reason: "no head/base sha recorded" });
	for (const path of ["/api/diff?id=../x", "/api/job?id=../x", "/api/job?id=cp-nope", "/api/diff?id=cp-nope"]) assert.equal((await d.get(path)).status, 404, path);
	const index = join(repo, ".git", "index"), before = statSync(index).mtimeMs;
	writeFileSync(join(repo, "a.txt"), "dirty\n");
	const status = (await d.get("/api/git?root=project:demo&view=status")).body as Json;
	assert.deepEqual([status.ok, (status.lines as string[]).map((l) => l.trim())], [true, ["## main", "M a.txt"]], "the branch and the dirty file");
	assert.deepEqual([existsSync(join(repo, ".git", "index.lock")), statSync(index).mtimeMs], [false, before], "no index lock, no index refresh");
	assert.equal(((await d.get(`/api/git?root=project:demo&view=show&sha=${"f".repeat(40)}`)).body as Json).ok, false, "a missing commit fails");
});

test("P19-workbench-grants: a job's grant is the named, earliest-issued, lowest-id one; else the project-wide one; with none active, the last matching", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed: (stateDir, home) => {
		const grant = (id: string, issued_at: string, over: Json = {}) => write(join(stateDir, "mandates", `${id}.json`), { id, status: "active", expiry: LATER, issued_at, projects: ["alpha"], objective: "x", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5, ...over });
		grant("md-000001", "2026-08-01T00:00:00Z");
		for (const id of ["md-a994c5", "md-b994c5"]) grant(id, "2026-09-01T00:00:00Z", { job_ids: ["cp-target"] });
		grant("md-000000", "2026-09-02T00:00:00Z", { job_ids: ["cp-target"] });
		grant("md-e00001", "2026-09-01T00:00:00Z", { job_ids: ["cp-excl"], exclusions: { job_kinds: ["ship"] } });
		grant("md-p00001", "2026-08-01T00:00:00Z", { status: "paused", projects: ["beta"] });
		grant("md-p00002", "2026-09-01T00:00:00Z", { status: "paused", projects: ["beta"] });
		const job = (id: string, project: string) => ({ id, title: id, status: "open", labels: [`project:${project}`, "kind:ship"], blocked_by: [], comments: [], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" });
		write(join(home, ".pi-command-post", "jobs.json"), { schema_version: 1, prefix: "cp", jobs: [job("cp-target", "alpha"), job("cp-plain", "alpha"), job("cp-excl", "alpha"), job("cp-beta", "beta")] });
	} });
	const nodes = ((await d.get("/api/map")).body as Json).nodes as Json[];
	const grantOf = (id: string) => nodes.find((n) => n.id === id)?.mandate_id;
	assert.equal(grantOf("cp-target"), "md-a994c5", "named beats project-wide, earliest issued beats later, the lower id breaks the tie");
	assert.equal(grantOf("cp-plain"), "md-000001", "a grant naming other jobs leaves the project-wide one");
	assert.equal(grantOf("cp-excl"), "md-000001", "a named grant excluding the job's kind leaves the project-wide one");
	assert.equal(grantOf("cp-beta"), "md-p00002", "with no active grant, the last-issued matching grant is kept");
});

test("P19-workbench-parent: the schedule controls' parent probe calls a zombie lock holder down, a live pid running, as isPidAlive does", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const parent = async (pid: number) => { write(join(d.stateDir, "parent.lock"), { pid }); return ((await d.get("/api/schedules/control")).body as Json).parent as Json; };
	const kill = t.mock.method(process, "kill", () => true); // a regressed guard must never signal a process group
	for (const pid of [0, -1]) {
		assert.deepEqual(await parent(pid), { running: false, pid: null, reason: "parent lock names no pid" }, `pid ${pid}`);
		assert.equal(isPidAlive(pid), false, `pid ${pid}: isPidAlive agrees`);
	}
	assert.equal(kill.mock.callCount(), 0, "pid 0 and -1 are refused before any signal"); kill.mock.restore();
	await withZombie(t, async (zombie, holder) => {
		for (const pid of [zombie, holder, process.pid, 2 ** 30]) assert.equal((await parent(pid)).running, isPidAlive(pid), `pid ${pid}`);
		assert.deepEqual(await parent(zombie), { running: false, pid: zombie, reason: `the recorded parent pid ${zombie} is not running` }, "a kill-0-only check would call a zombie alive");
		assert.equal((await parent(holder)).running, true);
	});
});
