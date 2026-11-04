/**
 * M3 slice 4 (cp-zm9f): the operator composer's `/` commands and job references, and the context panel across 900 px,
 * through `bin/cp-view` on a scratch home and the served app in its linkedom tab (DOM, classes, keyboard events and
 * served CSS; no layout — the browser fixture's `m3-composer` screenshots are the layout evidence).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { type Context, viewer } from "../harness/conversations.ts";
import { browserShims, dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";
import { syntheticPng } from "../harness/images.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const STATUS = "What is running and what needs me?";

/** A chat with one open ask, two ledger jobs in two projects, a fleet-only job (no ledger project) and one skill. */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	put("pi-sessions/chat.jsonl", `${JSON.stringify({ type: "message", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: join(home, "pi-sessions", "chat.jsonl") })}\n`);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "picp", question: "Merge PR 315 now?", recommendation: "Merge now",
		options: [{ label: "Merge now", consequence: "Lands on green CI" }, { label: "Hold", consequence: "Waits for a review" }] });
	const job = (id: string, project: string) => ({ id, title: `Title ${id}`, status: "in_progress", labels: [`project:${project}`, "kind:ship"], blocked_by: [] });
	put(".pi-command-post/jobs.json", { jobs: [job("cp-live", "picp"), job("cp-other", "atlas")] });
	put(LAYOUT.fleetFile, { jobs: ["cp-live:picp", "cp-other:atlas", "cp-orphan:picp"].map((pair) => {
		const [job_id, project] = pair.split(":");
		return { job_id, project, kind: "ship", phase: "held", dispatched_at: iso(60) };
	}) });
	put("skills/teach/SKILL.md", "---\ndescription: Explain step by step\n---\n\n# Body\n");
}
const start = async (t: Context, online = true) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	if (online) await operatorSession(t, d.stateDir);
	return d;
};
/** Renders and their effects (after paint: the tab's 16 ms frame) have run. */
const settle = () => new Promise((done) => setTimeout(done, 50));
const field = (tab: Tab) => tab.$(".operator-composer textarea") as unknown as HTMLTextAreaElement;
const options = (tab: Tab) => tab.$$('[role="listbox"] [role="option"]').map((o) => o.textContent);
const sends = (tab: Tab) => tab.started.filter((r) => r === "POST /api/operator/message").length;
/** Matching node count: assertions compare numbers, as inspecting a failed linkedom node walks the whole DOM. */
const n = (tab: Tab, selector: string) => tab.$$(selector).length;
/** Types into the composer with the caret at the end, as a browser reports `selectionStart`. */
async function type(tab: Tab, value: string) {
	Object.defineProperty(field(tab), "selectionStart", { configurable: true, writable: true, value: value.length });
	tab.type(field(tab) as unknown as Element, value);
	await settle();
}
/** A keydown on the composer field with the browser's IME flag. */
async function press(tab: Tab, key: string, isComposing = false) {
	const event = new tab.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing }, keyCode: { value: isComposing ? 229 : 0 } });
	(field(tab) as unknown as Element).dispatchEvent(event);
	await settle();
	return event.defaultPrevented;
}
const escapeBody = (tab: Tab) => tab.key(tab.document.body as unknown as Element, "Escape").defaultPrevented;

test("M3-composer-typed: a `/` draft offers /status and /jobs only; Enter/Tab run them without sending, Escape and IME never send, @ skills stay", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	await tab.find(".operator-composer textarea");
	await type(tab, "/");
	assert.deepEqual([tab.$('[role="listbox"]')!.getAttribute("aria-label"), options(tab)], ["Commands", [`/status${STATUS}`, "/jobsOpen the jobs drawer"]]);
	assert.doesNotMatch(tab.text(), /\/stop|\/thread|New thread/, "no revoke or thread commands");

	await type(tab, "/j");
	assert.deepEqual(options(tab), ["/jobsOpen the jobs drawer"]);
	assert.equal(await press(tab, "Enter"), true);
	await tab.find("dialog.workspace-jobs[open]");
	assert.deepEqual([field(tab).value, sends(tab)], ["", 0], "/jobs is navigation: the slash leaves the draft, nothing is sent");
	assert.equal(escapeBody(tab), true);
	await until(() => n(tab, "dialog.workspace-jobs"), (c) => c === 0, "Escape to close the drawer");
	assert.ok(focused() === field(tab), "focus returns to the composer");

	await type(tab, "/st");
	assert.equal(await press(tab, "Tab"), true);
	assert.deepEqual([field(tab).value, n(tab, '[role="listbox"]'), sends(tab)], [STATUS, 0, 0], "/status writes its question, unsent");
	await type(tab, `${STATUS} On picp only.`);
	assert.equal(field(tab).value, `${STATUS} On picp only.`, "the draft stays editable");

	await type(tab, "/s");
	assert.equal(await press(tab, "Escape"), true);
	assert.deepEqual([n(tab, '[role="listbox"]'), field(tab).value, sends(tab)], [0, "/s", 0], "Escape closes the list and sends nothing");
	await type(tab, "/j");
	assert.equal(await press(tab, "Enter", true), false, "an IME Enter is the composition's");
	assert.deepEqual([n(tab, "dialog.workspace-jobs"), field(tab).value, sends(tab)], [0, "/j", 0]);
	await type(tab, "please @te");
	await until(() => options(tab), (o) => o.length === 1, "the @te list");
	assert.deepEqual([tab.$('[role="listbox"]')!.getAttribute("aria-label"), options(tab)], ["Installed skills", ["@teachExplain step by step"]], "skills keep the @ list");
	await type(tab, "1/jobs");
	assert.equal(n(tab, '[role="listbox"]'), 0, "only a whole `/word` draft is a command");
	// Full match S1: the inspector is open by default, so Escape with nothing else open is the chat's; an IME one is not.
	assert.deepEqual([await press(tab, "Escape", true), !!tab.$("aside.workspace-context")], [false, true], "an IME Escape keeps the inspector");
	const footer = [...tab.document.querySelectorAll(".operator-composer-attach, .operator-composer-slash")] as unknown as Element[];
	assert.deepEqual(footer.map((el) => el.className), ["operator-composer-attach", "operator-composer-slash"], "the paperclip stays first");
});

test("M3-composer-menu: the touch `/` menu runs commands and attaches a selection's job as the P1 reference; Escape and removal keep the draft", { timeout: 180_000 }, async (t) => {
	const d = await start(t, false);
	const storage = new Map<string, string>();
	const tab = await openTab(t, d.port, CHAT, storage);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	await tab.find(".operator-composer textarea");
	await type(tab, "KEEP-DRAFT");
	const slash = await tab.find(".operator-composer-footer > .operator-composer-commands > .operator-composer-slash");
	tab.click(slash);
	const menu = await tab.find("#operator-composer-command-menu");
	await tab.find("#operator-composer-command-menu button code", (c) => c.textContent === "cp-orphan");
	assert.deepEqual([slash.getAttribute("aria-expanded"), menu.querySelectorAll("h3").length, [...menu.querySelectorAll("button code")].map((c) => c.textContent)],
		["true", 2, ["/status", "/jobs", "cp-live", "cp-other", "cp-orphan"]], "offline: commands, then the in-flight jobs");
	assert.doesNotMatch(menu.textContent!, /\/stop|\/thread/);
	tab.click([...menu.querySelectorAll("button")].find((b) => b.textContent!.startsWith("cp-orphan"))!);
	await tab.find("#operator-composer-command-menu p[role=status]", (p) => /cp-orphan has no recorded project to reference/.test(p.textContent!));
	assert.equal(n(tab, ".evidence-chip"), 0, "no reference is invented without the ledger's project");
	assert.equal(tab.key(slash, "Escape").defaultPrevented, true);
	await until(() => n(tab, "#operator-composer-command-menu"), (c) => c === 0, "Escape to close the menu");
	assert.deepEqual([focused() === slash, field(tab).value, sends(tab)], [true, "KEEP-DRAFT", 0], "Escape keeps the draft and sends nothing");

	tab.click(slash);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("/status")));
	await until(() => field(tab).value, (v) => v === `KEEP-DRAFT\n${STATUS}`, "/status below the kept text");
	assert.deepEqual([n(tab, "#operator-composer-command-menu"), focused() === field(tab), sends(tab)], [0, true, 0]);

	tab.go(`${CHAT}&project=atlas`);
	await tab.find(".session-filter select option[selected][value=atlas]");
	tab.click(slash);
	await tab.find("#operator-composer-command-menu button code", (c) => c.textContent === "cp-other");
	assert.deepEqual(tab.$$("#operator-composer-command-menu button code").map((c) => c.textContent), ["/status", "/jobs", "cp-other"], "M1 narrows the jobs");
	tab.click(tab.$$("#operator-composer-command-menu button").find((b) => b.textContent!.startsWith("cp-other"))!);
	const chip = await tab.find(".evidence-chip summary");
	assert.match(chip.textContent!, /cp-other/);
	assert.deepEqual(JSON.parse([...storage].find(([k]) => k.startsWith("cp-composer-ref:"))![1]), { kind: "job", project: "atlas", job_id: "cp-other" }, "the job page's own reference");
	assert.deepEqual([n(tab, "#operator-composer-command-menu"), field(tab).value, sends(tab)], [0, `KEEP-DRAFT\n${STATUS}`, 0], "attached, unsent, text kept");
	tab.click(tab.$(".evidence-chip-remove")!);
	await until(() => n(tab, ".evidence-chip"), (c) => c === 0, "Remove drops the reference");
	assert.equal(field(tab).value, `KEEP-DRAFT\n${STATUS}`, "and keeps the text");

	tab.click(slash);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("/jobs")));
	await tab.find("dialog.workspace-jobs[open]");
	assert.equal(n(tab, "#operator-composer-command-menu"), 0, "/jobs opens the same drawer as Cmd+J");

	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (selector: string) => [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	assert.match(rule(".operator-composer-command-menu button"), /min-height:44px/, "44 px touch options");
	assert.match(rule(".operator-composer-slash"), /width:44px;height:44px/, "a 44 px phone target");
	// M3 fidelity D (design frames 1, 4, 10): the composer and `/` menu in the transcript's column, on the raised surface.
	// Negative control: restoring the surface/padding 4 menu fails the first assertion.
	const raised = rule(".operator-composer-command-menu");
	assert.match(raised, /max-height:45dvh;.*padding:6px;background:var\(--raised\);border:1px solid var\(--border\);border-radius:12px;/, "raised, padding 6");
	assert.match(raised, /left:14px;right:14px;.*;left:max\(28px,calc\(\(100% - 664px\) ?\/ ?2\)\);right:auto;width:min\(534px,calc\(100% - 56px\)\)$/,
		"phone: 14 px from each side; desktop: the box's left edge, at most 534 px");
	// Full match S1 (design frame 6): the phone composer's sides are 10 px, inside the transcript's 14 px.
	assert.match(rule(".operator-composer"), /padding-left:10px;padding-right:10px;padding:12px max\(28px,calc\(\(100% - 664px\) ?\/ ?2\)\) 16px$/,
		"10 px phone sides; from 900 px the 720 px column's 28 px sides");
	assert.match(rule(".operator-composer-box"), /gap:12px;padding:14px 12px 10px 16px;background:var\(--surface\)/, "the design box's 14/12/10/16 padding");
	// Full match S1 (frames 6, 10): below 900 px the field takes the card's whole top row and the controls a row below.
	// Negative control: restoring the single phone row (row box, `display:contents` footer, `order`) fails this.
	assert.match(rule(".operator-composer-box"), /;flex-direction:column;align-items:stretch;[^;]*;padding:8px 6px 6px 14px;.*border-radius:18px;flex-direction:column;/,
		"phone: a rounded card stacking the field over its footer");
	assert.match(rule(".operator-composer-footer"), /^display:contents;display:flex;align-items:center;/, "phone: the footer is its own row");
	assert.doesNotMatch(css, /\.operator-composer-field\{order:/, "the field is never reordered into the buttons' row");
});

test("M3-composer-attachments: an attached image and the draft survive /status and a job reference; a closed menu's late lookup attaches nothing", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t, { at: new Date(NOON).toISOString(), seed });
	await operatorSession(t, d.stateDir, () => true, { prepareImage: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }) });
	const tab = await openTab(t, d.port, CHAT, new Map(), /^\/api\/job\//);
	browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	await tab.find(".operator-composer-attach", (b) => !b.hasAttribute("disabled"));
	await type(tab, "KEEP");
	const input = tab.$("input[type=file]")!;
	Object.defineProperty(input, "files", { configurable: true, value: [new File([Uint8Array.from(syntheticPng())], "a.png", { type: "image/png" })] });
	input.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	const thumbs = () => tab.$$(".operator-composer-thumb").map((el) => el.getAttribute("src"));
	const [image] = await until(thumbs, (s) => s.length === 1, "the uploaded thumbnail");
	const slash = tab.$(".operator-composer-slash")!;
	const job = (id: string) => tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith(id));

	tab.click(slash);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("/status")));
	await until(() => field(tab).value, (v) => v === `KEEP\n${STATUS}`, "/status below the kept text");
	assert.deepEqual([thumbs(), sends(tab)], [[image], 0], "/status keeps the attachment and sends nothing");

	// A double tap starts one lookup; Escape closes the menu before it answers, so the late answer attaches no chip.
	tab.click(slash);
	tab.click(await job("cp-live"));
	tab.click(await job("cp-live"));
	await settle();
	assert.equal(tab.started.filter((r) => r === "GET /api/job/cp-live").length, 1, "a double tap reads the job once");
	tab.key(slash, "Escape");
	await until(() => n(tab, "#operator-composer-command-menu"), (c) => c === 0, "Escape before the lookup answers", 5_000);
	tab.release();
	await until(() => tab.requests.some((r) => r.path === "/api/job/cp-live" && r.read), (read) => read, "the late lookup", 5_000);
	await settle();
	assert.equal(n(tab, ".evidence-chip"), 0, "a closed menu's late lookup attaches nothing");

	tab.click(slash);
	tab.click(await job("cp-live"));
	await tab.find(".evidence-chip summary", (s) => /cp-live/.test(s.textContent!));
	assert.deepEqual([tab.$$(".evidence-chip").length, thumbs(), field(tab).value, sends(tab)], [1, [image], `KEEP\n${STATUS}`, 0],
		"one chip; the attachment and draft survive the reference, unsent");
});

test("M3-composer-viewport: crossing 900 px with the context open closes it, so nothing hidden stays expanded or owns Escape", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	let wide = true;
	const listeners = new Set<() => void>();
	tab.globals.matchMedia = (query: string) => ({ get matches() { return wide && /min-width/.test(query); },
		addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
	const cross = async (next: boolean) => { wide = next; for (const fn of [...listeners]) fn(); await settle(); };
	await tab.waitText(/REPLY-CARD/);
	await tab.find(".operator-composer textarea");
	await settle();
	const toggle = await tab.find(".workspace-context-open");
	// Full match S1: from 900 px the chat opens its inspector by default, so no click is needed here.
	await tab.find(".sessions > aside.workspace-context");
	await cross(false);
	await until(() => n(tab, ".workspace-context"), (c) => c === 0, "crossing 900 px closes the inspector");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), escapeBody(tab)], ["false", false], "not expanded, and Escape is not eaten");

	tab.click(toggle);
	await tab.find("dialog.workspace-context-sheet[open]");
	await cross(true);
	await until(() => n(tab, ".workspace-context"), (c) => c === 0, "crossing back closes the sheet");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), focused() === toggle, escapeBody(tab)], ["false", true, false], "focus back on Context");
	// Full match S5: the status footer watches the 900 px boundary while the chat is mounted; a leaked panel watch is 2.
	assert.equal(listeners.size, 1, "a closed panel stops listening");
});
