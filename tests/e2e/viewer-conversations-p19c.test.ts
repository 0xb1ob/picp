/**
 * Behavior 19 (P19c): the Sessions transcript's threads, the operator composer and the workbench, as `bin/cp-view`
 * serves them on a scratch home: real HTTP and the served app in its linkedom tab (DOM, text and served CSS only,
 * no layout or pixels).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { operatorThreadsFile } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { INBOX_REPLAY_PREFIX } from "../../src/viewer/thread-turns.ts";
import { type ControlPorts, type DashboardControl, type InlineImage, startDashboardControl } from "../../src/dashboard-control.ts";
import { type Context, type Json, jsonl, viewer, write } from "../harness/conversations.ts";
import { type Tab, until } from "../harness/dashboard.ts";
import { syntheticPng } from "../harness/images.ts";

const AT = "2026-10-06T08:00:00Z";
const DC = "dc-20261006080000-89abcdef";
const msg = (message: unknown) => ({ type: "message", timestamp: AT, message });
const user = (text: string) => msg({ role: "user", content: [{ type: "text", text }] });
const said = (text: string) => msg({ role: "assistant", content: [{ type: "text", text }] });
const parentCall = (id: string, args: unknown, result: string) => [
	msg({ role: "assistant", content: [{ type: "toolCall", id, name: "cp_parent", arguments: args }] }),
	msg({ role: "toolResult", toolCallId: id, toolName: "cp_parent", content: [{ type: "text", text: result }] }),
];
const notice = (job: string, text: string) => ({ type: "custom_message", timestamp: AT, customType: "cp-bridge", content: `[cp-bridge cp-ci job=${job}]\n${text}` });
const compaction = { type: "compaction", timestamp: AT, tokensBefore: 123 };
const REPLAY = `${INBOX_REPLAY_PREFIX}1 message(s) typed while this session was offline]`;
/** The operator's turns: a dashboard message, a posted answer, a relay, a TUI ask and a duplicate answer. */
const TURNS = [
	user(`billing?\n\n[cp-dashboard ${DC} — from the dashboard; thread=billing]`),
	said("looking"),
	...parentCall("call-ans", { action: "answer", job_id: "cp-x" }, "answer: ans-a1b2c3d4e5f6 posted to the dashboard (bookkeeping only; no push)"),
	notice("cp-x", "CI green"),
	said("CI received"),
	compaction,
	user("from the TUI"),
	...parentCall("call-ask", { action: "ask", ask: {} }, JSON.stringify({ id: "ask-abcd", state: "open" })),
	said("asked"),
	...parentCall("call-dup", { action: "answer", job_id: "cp-x" }, "answer: cp-x already posted as ans-0000000000ff; nothing written"),
];
const open = (id: string, tag: string) => ({ type: "open", by: "viewer", id, at: AT, tag, peer: null });
const bind = (thread: string, kind: string, id: string) => ({ type: "bind", by: "bridge", at: AT, thread, ref: { kind, id }, peer: null });
const label = (e: Json) => `${e.kind}:${e.answer_id ?? e.ask_id ?? e.text.split("\n")[0]}=${e.shared ? "shared" : (e.thread ?? "-")}`;

/** A viewer whose operator session is `rows`, its ask-abcd open; `threads` rewrites the threads journal. */
async function threadViewer(t: Context, rows: unknown[]) {
	let stateDir = "";
	const d = await viewer(t, { at: AT, seed: (dir, home) => {
		stateDir = dir;
		const file = join(home, "session.jsonl");
		write(file, jsonl(rows));
		write(operatorSessionsFile(join(dir, "sessions")), jsonl([{ at: AT, session_file: file }]));
		write(join(dir, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: AT, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }]));
	} });
	const full = async () => (await d.get("/api/sessions?view=you&transcript=1")).body as { entries: Json[]; warnings: string[] };
	return { d, stateDir, full, threads: (lines: unknown[]) => write(operatorThreadsFile(stateDir), jsonl(lines)) };
}

// ---- thread turns ---------------------------------------------------------------------------------------------------

test("P19-thread-turns: a bound dashboard opener files its turn, an own ref wins, relays and inbox replays stay shared", { timeout: 120_000 }, async (t) => {
	const rows = [said("pre"), ...TURNS, user(`${REPLAY}\n- x (${DC}): hi`), said("after replay"), user("unbound"), said("plain reply")];
	const { stateDir, full, threads } = await threadViewer(t, rows);
	const missing = await full();
	assert.deepEqual(missing.warnings, []);
	assert.ok(missing.entries.every((e) => e.thread === undefined), "no journal, no refs: every entry is unthreaded");
	assert.deepEqual(missing.entries.filter((e) => e.shared).map((e) => e.kind), ["system", "system", "say"]);
	mkdirSync(operatorThreadsFile(stateDir), { recursive: true }); // a directory: unreadable
	const unreadable = await full();
	assert.equal(unreadable.warnings.length, 1);
	assert.match(unreadable.warnings[0]!, /^threads unavailable: .*threads\.jsonl/);
	assert.ok(unreadable.entries.every((e) => e.thread === undefined));
	assert.equal(unreadable.entries.length, missing.entries.length, "the transcript itself still renders");
	rmSync(operatorThreadsFile(stateDir), { recursive: true });
	const journal = [open("th-aaaaaaaaaaaa", "billing"), open("th-cccccccccccc", "caps"), bind("th-aaaaaaaaaaaa", "dashboard", DC), bind("th-cccccccccccc", "ask", "ask-abcd"), bind("th-aaaaaaaaaaaa", "answer", "ans-0000000000ff"), bind("th-cccccccccccc", "answer", "ans-0000000000ff")];
	threads(journal);
	const filed = await full();
	assert.deepEqual(filed.warnings, []);
	assert.deepEqual(filed.entries.map(label), [
		"say:pre=-",
		"via:billing?=th-aaaaaaaaaaaa",
		"say:looking=th-aaaaaaaaaaaa",
		"tool:ans-a1b2c3d4e5f6=th-aaaaaaaaaaaa",
		"system:CI green=shared",
		"say:CI received=-",
		"system:Context compacted (123 tokens before)=shared",
		"say:from the TUI=th-cccccccccccc",
		"tool:ask-abcd=th-cccccccccccc",
		"ask:ask-abcd=th-cccccccccccc",
		"say:asked=th-cccccccccccc",
		"tool:ans-0000000000ff=th-cccccccccccc",
		`say:${REPLAY}=shared`,
		"say:after replay=-",
		"say:unbound=-",
		"say:plain reply=-",
	]);
	threads([...journal, open("th-bbbbbbbbbbbb", "answers"), bind("th-bbbbbbbbbbbb", "answer", "ans-a1b2c3d4e5f6")]);
	const own = (await full()).entries.map(label);
	assert.deepEqual(own.slice(1, 4), ["via:billing?=th-aaaaaaaaaaaa", "say:looking=th-aaaaaaaaaaaa", "tool:ans-a1b2c3d4e5f6=th-bbbbbbbbbbbb"]);
});

test("P19-thread-jobs: bound job notices open their own turn; unbound notices, compactions and replays stay shared", { timeout: 120_000 }, async (t) => {
	const replay = user(`${REPLAY}\n- later\n[cp-dashboard ${DC} — from the dashboard; thread=billing]`);
	const rows = [...TURNS, notice("cp-y", "other job"), said("other reply"), notice("cp-unbound", "unbound"), said("loose"), compaction, said("after"), replay];
	const { full, threads } = await threadViewer(t, rows);
	threads([open("th-bbbbbbbbbbbb", "billing"), bind("th-bbbbbbbbbbbb", "job", "cp-x"), open("th-dddddddddddd", "other"), bind("th-dddddddddddd", "job", "cp-y")]);
	const { entries, warnings } = await full();
	assert.deepEqual(warnings, []);
	assert.deepEqual(entries.slice(3, 5).map(label), ["system:CI green=th-bbbbbbbbbbbb", "say:CI received=th-bbbbbbbbbbbb"]);
	assert.deepEqual(entries.slice(-8).map(label), [
		"tool:ans-0000000000ff=-",
		"system:other job=th-dddddddddddd",
		"say:other reply=th-dddddddddddd",
		"system:unbound=shared",
		"say:loose=-",
		"system:Context compacted (123 tokens before)=shared",
		"say:after=-",
		`say:${REPLAY}=shared`,
	]);
	assert.equal(entries.at(-1)!.who, "Operator");
});

test("P19-thread-refs: job binds and dashboard, ask or answer binds with the same id never cross-file entries or replies", { timeout: 120_000 }, async (t) => {
	const refs = [{ kind: "dashboard", id: DC }, { kind: "ask", id: "ask-abcd" }, { kind: "answer", id: "ans-a1b2c3d4e5f6" }];
	const jobThread = "th-bbbbbbbbbbbb", legacyThread = "th-aaaaaaaaaaaa";
	const replies = refs.flatMap((ref) => [notice(ref.id, `notice ${ref.kind}`), said(`reply ${ref.kind}`)]);
	const { full, threads } = await threadViewer(t, [...TURNS, ...replies, notice("ans-0000000000ff", "unbound job"), said("unbound reply")]);
	const journal = [open(jobThread, "jobs"), open(legacyThread, "legacy"), ...refs.map((ref) => bind(jobThread, "job", ref.id))];
	threads(journal);
	const legacy = (e: Json) => e.dashboard_id || e.ask_id || e.answer_id === refs[2]!.id || e.text === "looking" || e.text === "asked";
	const onlyJobs = await full();
	assert.ok(onlyJobs.entries.filter(legacy).every((e) => e.thread === undefined), "job-only binds must not own matching legacy entries or their turns");
	threads([...journal, ...refs.map((ref) => bind(legacyThread, ref.kind, ref.id)), bind(legacyThread, "answer", "ans-0000000000ff")]);
	const both = await full();
	assert.deepEqual(both.warnings, []);
	assert.equal(both.entries.find((e) => e.bridge?.job === "ans-0000000000ff")!.shared, true, "an answer binding cannot open a job turn");
	assert.equal(both.entries.find((e) => e.text === "unbound reply")!.thread, undefined);
	assert.ok(both.entries.filter(legacy).every((e) => e.thread === legacyThread));
	assert.deepEqual(refs.map((ref) => [both.entries.find((e) => e.bridge?.job === ref.id)!, both.entries.find((e) => e.text === `reply ${ref.kind}`)!].map(label)), [
		[`system:notice dashboard=${jobThread}`, `say:reply dashboard=${jobThread}`],
		[`system:notice ask=${jobThread}`, `say:reply ask=${jobThread}`],
		[`system:notice answer=${jobThread}`, `say:reply answer=${jobThread}`],
	]);
});

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
	assert.equal(offline.$(".operator-composer-attach"), null, "no running session: no paperclip");
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
	assert.equal(name.querySelector("img"), null, "a text file shows its name, never a thumbnail");
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
