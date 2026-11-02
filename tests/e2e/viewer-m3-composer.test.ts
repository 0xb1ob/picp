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
import type { Context } from "../harness/conversations.ts";
import { browserShims, dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

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
	await until(() => tab.$("dialog.workspace-jobs"), (el) => el === null, "Escape to close the drawer");
	assert.ok(focused() === field(tab), "focus returns to the composer");

	await type(tab, "/st");
	assert.equal(await press(tab, "Tab"), true);
	assert.deepEqual([field(tab).value, tab.$('[role="listbox"]'), sends(tab)], [STATUS, null, 0], "/status writes its question, unsent");
	await type(tab, `${STATUS} On picp only.`);
	assert.equal(field(tab).value, `${STATUS} On picp only.`, "the draft stays editable");

	await type(tab, "/s");
	assert.equal(await press(tab, "Escape"), true);
	assert.deepEqual([tab.$('[role="listbox"]'), field(tab).value, sends(tab)], [null, "/s", 0], "Escape closes the list and sends nothing");
	await type(tab, "/j");
	assert.equal(await press(tab, "Enter", true), false, "an IME Enter is the composition's");
	assert.deepEqual([tab.$("dialog.workspace-jobs"), field(tab).value, sends(tab)], [null, "/j", 0]);
	await type(tab, "please @te");
	await until(() => options(tab), (o) => o.length === 1, "the @te list");
	assert.deepEqual([tab.$('[role="listbox"]')!.getAttribute("aria-label"), options(tab)], ["Installed skills", ["@teachExplain step by step"]], "skills keep the @ list");
	await type(tab, "1/jobs");
	assert.equal(tab.$('[role="listbox"]'), null, "only a whole `/word` draft is a command");
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
	assert.equal(tab.$(".evidence-chip"), null, "no reference is invented without the ledger's project");
	assert.equal(tab.key(slash, "Escape").defaultPrevented, true);
	await until(() => tab.$("#operator-composer-command-menu"), (el) => el === null, "Escape to close the menu");
	assert.deepEqual([focused() === slash, field(tab).value, sends(tab)], [true, "KEEP-DRAFT", 0], "Escape keeps the draft and sends nothing");

	tab.click(slash);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("/status")));
	await until(() => field(tab).value, (v) => v === `KEEP-DRAFT\n${STATUS}`, "/status below the kept text");
	assert.deepEqual([tab.$("#operator-composer-command-menu"), focused() === field(tab), sends(tab)], [null, true, 0]);

	tab.go(`${CHAT}&project=atlas`);
	await tab.find(".session-filter select option[selected][value=atlas]");
	tab.click(slash);
	await tab.find("#operator-composer-command-menu button code", (c) => c.textContent === "cp-other");
	assert.deepEqual(tab.$$("#operator-composer-command-menu button code").map((c) => c.textContent), ["/status", "/jobs", "cp-other"], "M1 narrows the jobs");
	tab.click(tab.$$("#operator-composer-command-menu button").find((b) => b.textContent!.startsWith("cp-other"))!);
	const chip = await tab.find(".evidence-chip summary");
	assert.match(chip.textContent!, /cp-other/);
	assert.deepEqual(JSON.parse([...storage].find(([k]) => k.startsWith("cp-composer-ref:"))![1]), { kind: "job", project: "atlas", job_id: "cp-other" }, "the job page's own reference");
	assert.deepEqual([tab.$("#operator-composer-command-menu"), field(tab).value, sends(tab)], [null, `KEEP-DRAFT\n${STATUS}`, 0], "attached, unsent, text kept");
	tab.click(tab.$(".evidence-chip-remove")!);
	await until(() => tab.$(".evidence-chip"), (el) => el === null, "Remove drops the reference");
	assert.equal(field(tab).value, `KEEP-DRAFT\n${STATUS}`, "and keeps the text");

	tab.click(slash);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("/jobs")));
	await tab.find("dialog.workspace-jobs[open]");
	assert.equal(tab.$("#operator-composer-command-menu"), null, "/jobs opens the same drawer as Cmd+J");

	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (selector: string) => [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	assert.match(rule(".operator-composer-command-menu button"), /min-height:44px/, "44 px touch options");
	assert.match(rule(".operator-composer-slash"), /width:44px;height:44px/, "a 44 px phone target");
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
	tab.click(toggle);
	await tab.find(".sessions > aside.workspace-context");
	await cross(false);
	await until(() => tab.$(".workspace-context"), (el) => el === null, "crossing 900 px closes the inspector");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), escapeBody(tab)], ["false", false], "not expanded, and Escape is not eaten");

	tab.click(toggle);
	await tab.find("dialog.workspace-context-sheet[open]");
	await cross(true);
	await until(() => tab.$(".workspace-context"), (el) => el === null, "crossing back closes the sheet");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), focused() === toggle, escapeBody(tab)], ["false", true, false], "focus back on Context");
	assert.equal(listeners.size, 0, "a closed panel stops listening");
});
