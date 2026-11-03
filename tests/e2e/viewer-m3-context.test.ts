/**
 * M3 slice 3 (cp-zm9f): the operator chat's context (desktop inspector, phone sheet) and the phone's Conversations
 * drawer, through `bin/cp-view` on a scratch home and the served app in its linkedom tab (DOM, classes, keyboard events
 * and served CSS; no layout — the browser fixture's `m3-context` screenshots are the layout evidence).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
const QUESTION = "Merge PR 315 now, or hold it for another review?";

/** A chat, one open ask and two live workers in two projects (one with a recorded cost, one without). */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), JSON.stringify(value));
	};
	const chat = join(home, "pi-sessions", "chat.jsonl");
	mkdirSync(dirname(chat), { recursive: true });
	writeFileSync(chat, `${JSON.stringify({ type: "message", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "picp", question: QUESTION, recommendation: "Merge now",
		options: [{ label: "Merge now", consequence: "Lands on green CI" }, { label: "Hold", consequence: "Waits for a review" }] });
	put(LAYOUT.fleetFile, { jobs: [
		{ job_id: "cp-live", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-other", project: "atlas", kind: "ship", phase: "held", dispatched_at: iso(60) },
	] });
	put(join(LAYOUT.runs, "cp-live/status.json"), { phase: "working", model: "fixture-model", usage: { cost_usd: 1.25 } });
	put(join(LAYOUT.runs, "cp-other/status.json"), { phase: "idle" });
}
const start = async (t: Context) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	await operatorSession(t, d.stateDir);
	return d;
};
const escape = (tab: Tab) => tab.key(tab.document.body as unknown as Element, "Escape").defaultPrevented;
const texts = (tab: Tab, selector: string) => tab.$$(selector).map((el) => el.textContent);
/** M1: the selection lives in the hash; the chat's select offers only projects its entries name (none here). */
async function pick(tab: Tab, project: string) {
	tab.go(`${CHAT}&project=${project}`);
	await until(() => tab.$(".session-filter select")?.querySelector("option[selected]")?.getAttribute("value"), (value) => value === project, `the ${project} selection`);
}

test("M3-context-inspector: Context opens the desktop inspector with the open ask and the selection's live workers; Answer, a job and Escape keep the chat", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	const field = await tab.find(".operator-composer textarea") as unknown as HTMLElement & { value: string };
	tab.type(field as unknown as Element, "KEEP-DRAFT");
	const toggle = await tab.find(".session-filter > .workspace-context-open", (b) => b.getAttribute("aria-label") === "Context, 1 asked you");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), tab.$(".workspace-context"), tab.$(".session-pinned-open")], ["false", null, null], "closed until asked");
	assert.equal(toggle.querySelector(".workspace-badge.workspace-badge-ask")?.textContent, "1", "an open ask paints the count");

	tab.click(toggle);
	const panel = await tab.find(".sessions > aside.workspace-context");
	assert.equal(tab.$("dialog.workspace-context"), null, "desktop: a panel beside the chat, not a modal");
	assert.deepEqual(texts(tab, "aside.workspace-context h3"), ["Asked you · 1", "In flight · 2"]);
	assert.match(tab.$(".workspace-context-ask")!.textContent!, new RegExp(`picp${QUESTION.replace(/[?]/g, "\\?")}Suggested: Merge now`), "the real ask");
	const cards = tab.$$(".workspace-context-job");
	assert.deepEqual(cards.map((c) => c.querySelector("code")!.textContent), ["cp-live", "cp-other"]);
	assert.match(cards[0]!.textContent!, /Cost\$1\.25/, "a recorded cost");
	assert.match(cards[1]!.textContent!, /Costnot recorded/, "a missing fact reads as not recorded, never zero");
	assert.equal(cards[1]!.querySelector("a")!.getAttribute("href"), "#sessions?view=workers&id=cp-other", "the worker's existing session link");
	assert.match(panel.textContent!, /not recorded per conversation/, "no invented chat associations or totals");
	assert.doesNotMatch(tab.text(), /New thread|Started from chat|Today on/, "no threads");

	await pick(tab, "atlas");
	assert.deepEqual([texts(tab, "aside.workspace-context h3"), tab.$(".workspace-context-head > span")!.textContent], [["Asked you · 1", "In flight · 1"], "atlas"], "M1 narrows in-flight; asks stay whole like the pinned block");
	tab.click(tab.$(".workspace-context-ask > button")!);
	await tab.find(".session-pinned-open");
	assert.ok(tab.$("aside.workspace-context"), "Answer opens the pinned decisions and keeps the inspector");

	tab.click(tab.$$(".workspace-context-links > button").find((b) => b.textContent === "Open job")!);
	await tab.find(".sessions > section.workspace-job[aria-label='Job cp-other']");
	assert.equal(tab.$("aside.workspace-context"), null, "the job takes the inspector's column");
	assert.equal(escape(tab), true);
	await tab.find(".sessions > aside.workspace-context");
	assert.ok(focused() === toggle, "closing the job returns to the inspector and its toggle");
	assert.equal(escape(tab), true);
	await until(() => tab.$(".workspace-context"), (el) => el === null, "Escape to close the inspector");
	assert.deepEqual([focused() === toggle, field.value, tab.window.location.hash, escape(tab)], [true, "KEEP-DRAFT", `${CHAT}&project=atlas`, false], "focus, draft and filter kept");
	tab.click(toggle);
	tab.click((await tab.find(".workspace-context-jobs")));
	await tab.find("dialog.workspace-jobs[open]");
	assert.ok(tab.$("aside.workspace-context"), "All jobs opens the Jobs drawer over the inspector");
	// Negative control: with no open ask left, nothing amber remains (no badge, no asked class, no ask card).
	const asks = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl"));
	for (const ask of asks.open()) asks.withdraw(ask.id, "fixture");
	tab.refresh();
	await tab.find(".workspace-context-open", (b) => b.getAttribute("aria-label") === "Context");
	assert.deepEqual([tab.$(".workspace-badge"), tab.$(".workspace-context-asked"), tab.$(".workspace-context-ask"), texts(tab, "aside.workspace-context h3")[0]],
		[null, null, null, "Asked you · 0"], "no open ask: no badge and no amber class");
});

test("M3-context-phone: the context sheet and the Conversations drawer are modal, close on Escape back to their button, keep the selection and drop on leaving", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	tab.type(await tab.find(".operator-composer textarea"), "KEEP-DRAFT");
	const button = await tab.find(".workspace-context-open");
	tab.click(button);
	await tab.find("dialog.workspace-context-sheet[open] .workspace-context-ask");
	assert.deepEqual([tab.$("aside.workspace-context"), texts(tab, "dialog.workspace-context h3")], [null, ["Asked you · 1", "In flight · 2"]], "phone: the same content in a sheet");
	assert.equal(escape(tab), true);
	await until(() => tab.$("dialog.workspace-context"), (el) => el === null, "Escape to close the sheet");
	assert.ok(focused() === button);
	tab.click(button);
	tab.click(await tab.find("dialog.workspace-context .workspace-context-jobs"));
	await tab.find("dialog.workspace-jobs[open]");
	assert.equal(tab.$("dialog.workspace-context"), null, "All jobs replaces the sheet");
	assert.equal(escape(tab), true);
	await until(() => tab.$("dialog.workspace-jobs"), (el) => el === null, "Escape to close the drawer");
	assert.ok(focused() === button, "focus returns to the sheet's opener");

	await pick(tab, "atlas");
	const conversations = await tab.find(".session-bar .workspace-sessions-open");
	tab.click(conversations);
	await tab.find("dialog.workspace-sessions[open]");
	assert.deepEqual(texts(tab, ".workspace-sessions .session-choice strong"), ["Operator", "CP parent", "cp-live", "cp-other"], "current session, then the Fleet");
	assert.deepEqual(texts(tab, ".workspace-sessions-list h2"), ["Fleet · 2 live"]);
	assert.equal(tab.$('.workspace-sessions .session-choice[aria-current="page"]')!.getAttribute("href"), "#sessions?view=you&project=atlas", "the current session keeps the selection");
	assert.doesNotMatch(tab.$("dialog.workspace-sessions")!.textContent!, /New thread/, "no threads");
	assert.equal(escape(tab), true);
	await until(() => tab.$("dialog.workspace-sessions"), (el) => el === null, "Escape to close Conversations");
	assert.ok(focused() === conversations);
	tab.click(conversations);
	const worker = await tab.find(".workspace-sessions .session-choice", (a) => a.textContent!.includes("cp-live"));
	tab.click(worker);
	await until(() => tab.$("dialog.workspace-sessions"), (el) => el === null, "a followed link closes the drawer");

	tab.click(button);
	await tab.find("dialog.workspace-context[open]");
	// The operator starts a new session file while the sheet is open: the refreshed chat drops it (same mount, no route).
	const next = join(d.home, "pi-sessions", "next.jsonl");
	writeFileSync(next, "");
	appendFileSync(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: iso(1), session_file: next })}\n`);
	tab.refresh();
	await until(() => tab.$("dialog"), (el) => el === null, "a new session file to drop the sheet");
	tab.click(button);
	await tab.find("dialog.workspace-context[open]");
	tab.go(worker.getAttribute("href")!);
	await until(() => tab.$(".workspace-context-open"), (el) => el === null, "the worker's session");
	assert.deepEqual([tab.$("dialog"), tab.$(".workspace-sessions-open")], [null, null], "no chat surface outside the operator chat");
	tab.go(`${CHAT}&project=atlas`);
	await tab.find(".workspace-context-open");
	await new Promise((done) => setTimeout(done, 50));
	assert.equal(tab.$("dialog"), null, "back in the chat no surface is left from before");
	assert.equal((tab.$(".operator-composer textarea") as unknown as { value: string }).value, "KEEP-DRAFT", "the draft survives");
});

test("M3-context-css: phone sheet and 317 px drawer; inspector over the chat from 900 px, a 340 px column from 1280 px", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	const split = css.indexOf("@media(min-width:900px){.workspace-jobs-open>kbd"), wide = css.indexOf("@media(min-width:1280px){.sessions:has(>.workspace-job)");
	assert.ok(split > 0 && wide > split, "the 900 px switch, then 1280 px");
	const [phone, desktop, beside] = [css.slice(0, split), css.slice(split, wide), css.slice(wide)];
	assert.match(rule(phone, ".workspace-context"), /display:none/, "phone: no inspector");
	assert.match(rule(phone, ".workspace-context-sheet"), /border-radius:18px 18px 0 0/, "phone: a bottom sheet with the design's 18 px radius");
	assert.match(rule(phone, ".workspace-sessions"), /width:min\(317px,calc\(100% - 44px\)\)/, "phone: the design's 317 px left drawer");
	const row = css.indexOf(".session-choice{display:grid"), depth = (at: number) => css.slice(0, at).split("{").length - css.slice(0, at).split("}").length;
	assert.deepEqual([row > 0, depth(row)], [true, 0], "chat rows styled outside the desktop sidebar's media query");
	assert.match(rule(desktop, "aside.workspace-context"), /position:absolute;.*width:min\(340px,100%\)/, "under 1280 px the inspector covers the chat's edge");
	assert.match(rule(beside, ".sessions:has(>aside.workspace-context)"), /grid-template-columns:261px minmax\(0,1fr\) 340px/, "from 1280 px a 340 px column");
});
