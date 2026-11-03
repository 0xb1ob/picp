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

const CONTEXT = "CI is green on PR 315's head.\nOne review attempt is recorded.";
/**
 * A chat carding one open ask (with recorded context), and two live workers in two projects: cp-live-t7ah with a
 * ledger title, a wall-clock limit and a recorded cost; cp-other with none of them, nor a dispatch time.
 */
function seed(stateDir: string, home: string, context: string | null = CONTEXT) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), JSON.stringify(value));
	};
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	const { id } = new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "picp", question: QUESTION, recommendation: "Merge now", ...(context ? { context } : {}),
		options: [{ label: "Merge now", consequence: "Lands on green CI" }, { label: "Hold", consequence: "Waits for a review" }] });
	const chat = join(home, "pi-sessions", "chat.jsonl");
	const say = (message: unknown) => JSON.stringify({ type: "message", timestamp: iso(10), message });
	mkdirSync(dirname(chat), { recursive: true });
	writeFileSync(chat, `${[say({ role: "assistant", content: [{ type: "toolCall", id: "call-ask", name: "cp_parent", arguments: { action: "ask" } }] }),
		say({ role: "toolResult", toolCallId: "call-ask", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id }) }] }),
		say({ role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] })].join("\n")}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	put(LAYOUT.fleetFile, { jobs: [
		{ job_id: "cp-live-t7ah", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60), bounds: { wall_clock_seconds: 7200 } },
		{ job_id: "cp-other", project: "atlas", kind: "ship", phase: "held" },
	] });
	put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-live-t7ah", title: "Ship the transcript slice", status: "in_progress", labels: ["project:picp", "kind:ship"] }] });
	put(join(LAYOUT.runs, "cp-live-t7ah/status.json"), { phase: "working", model: "fixture-model", usage: { cost_usd: 1.25 } });
	put(join(LAYOUT.runs, "cp-other/status.json"), { phase: "idle" });
}
const start = async (t: Context, context: string | null = CONTEXT) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir: string, home: string) => seed(stateDir, home, context) });
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
	// Full match S1: the current chat opens its inspector by default from 900 px (negative control: the old
	// closed-until-asked default fails here); the phone test pins that 899 px never pops a sheet.
	const panel = tab.$(".sessions > aside.workspace-context")!;
	assert.deepEqual([toggle.getAttribute("aria-expanded"), !!panel, !!tab.$(".session-pinned-open"), toggle.querySelector("svg") !== null], ["true", true, false, true], "open by default, an icon toggle");
	assert.equal(toggle.querySelector(".workspace-badge.workspace-badge-ask")?.textContent, "1", "an open ask paints the count");
	assert.equal(tab.$("dialog.workspace-context"), null, "desktop: a panel beside the chat, not a modal");
	assert.deepEqual(texts(tab, "aside.workspace-context h3"), ["Asked you · 1", "In flight · 2"]);
	// Full match S2 (frame 1): the recorded context, the exact options with consequences, the suggested one marked.
	const ask = tab.$(".workspace-context-ask")!;
	const context = [...ask.querySelectorAll("details.workspace-context-why[open] li")].map((li) => li.textContent).join("\n");
	assert.deepEqual([/^Operator asked · \d\d:\d\d · picp$/.test(ask.querySelector("small")!.textContent!), ask.querySelector("b")!.textContent, ask.querySelector("details > summary")?.textContent, context,
		tab.$$(".workspace-context-option").map((o) => [o.querySelector("b")!.textContent, o.querySelector("small")!.textContent, o.classList.contains("workspace-context-option-suggested")]),
		ask.querySelector(".workspace-context-chat")?.textContent], [true, QUESTION, "Context", CONTEXT,
		[["Merge now · suggested", "Lands on green CI", true], ["Hold", "Waits for a review", false]], "Answer in chat instead →"], "the real ask; its context one bullet a line");
	await tab.find(".workspace-context-job-title", (b) => b.textContent === "Ship the transcript slice");
	// The worker list's own order: cp-other (no dispatch time) first.
	const [other, live] = tab.$$(".workspace-context-job");
	assert.deepEqual([other, live].map((c) => [c!.querySelector("code")!.textContent, c!.querySelector("code")!.getAttribute("title")]), [["other", "cp-other"], ["t7ah", "cp-live-t7ah"]],
		"a compact suffix, the full id in its title");
	// Frame 1 order: glyph, short id, status on the right, then the title. Negative control: the old title-first head.
	assert.deepEqual([...live!.children].slice(0, 2).map((c) => c.className).concat([...live!.firstElementChild!.children].map((c) => c.className || c.tagName)),
		["workspace-context-job-head", "workspace-context-job-title", "workspace-context-job-glyph", "CODE", "workspace-context-job-status"], "head row, then the title");
	// Joined to /api/jobs by exact id. Negative control: a missing elapsed substituted with 0 reads "0m / …".
	const facts = (card: Element) => [...card.querySelectorAll("dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling!.textContent}`);
	assert.deepEqual([live!.querySelector(".workspace-context-job-title")!.textContent, facts(live!).slice(0, 1), !!live!.querySelector("progress")],
		["Ship the transcript slice", ["Wall clock=1h 0m / 2h 0m"], true], "title and wall clock with its bar");
	assert.match(live!.textContent!, /Cost\$1\.25/, "a recorded cost");
	assert.deepEqual([other!.querySelector(".workspace-context-job-title")!.textContent, facts(other!).filter((f) => /^(Wall clock|Cost)=/.test(f)), !!other!.querySelector("progress")],
		["Title not recorded", ["Wall clock=not recorded", "Cost=not recorded"], false], "a missing fact reads as not recorded, never zero");
	assert.equal(other!.querySelector("a")!.getAttribute("href"), "#sessions?view=workers&id=cp-other", "the worker's existing session link");
	assert.match(panel.textContent!, /not recorded per conversation/, "no invented chat associations or totals");
	assert.doesNotMatch(tab.text(), /New thread|Started from chat|Today on/, "no threads");

	await pick(tab, "atlas");
	assert.deepEqual([texts(tab, "aside.workspace-context h3"), tab.$(".workspace-context-head > span")!.textContent], [["Asked you · 1", "In flight · 1"], "atlas"], "M1 narrows in-flight; asks stay whole like the pinned block");
	tab.click(tab.$(".workspace-context-ask > .workspace-context-chat")!);
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
	// The user's close holds across a selection change and a new session file in the same chat (the dismissed ref; without
	// it the new file re-applies the default); leaving and coming back opens it again.
	await pick(tab, "picp");
	assert.equal(tab.$(".workspace-context"), null, "a closed inspector stays closed in the chat");
	const next = join(d.home, "pi-sessions", "next.jsonl");
	writeFileSync(next, `${JSON.stringify({ type: "message", timestamp: iso(1), message: { role: "assistant", content: [{ type: "text", text: "NEXT-FILE" }] } })}\n`);
	appendFileSync(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: iso(1), session_file: next })}\n`);
	tab.refresh();
	await tab.waitText(/NEXT-FILE/);
	await new Promise((done) => setTimeout(done, 50));
	// Booleans, not Elements: a failing deepEqual on a linkedom node inspects the whole DOM and runs out of memory.
	assert.deepEqual([!!tab.$(".workspace-context"), toggle.getAttribute("aria-expanded")], [false, "false"], "a new session file keeps the user's close");
	tab.go("#jobs");
	await until(() => tab.$(".workspace-context-open"), (el) => el === null, "leaving the chat");
	tab.go(`${CHAT}&project=atlas`);
	await tab.find(".sessions > aside.workspace-context");
	tab.click((await tab.find(".workspace-context-jobs")));
	await tab.find("dialog.workspace-jobs[open]");
	assert.ok(tab.$("aside.workspace-context"), "All jobs opens the Jobs drawer over the inspector");
	// M3 fidelity D: the design's ask fill (frames 1/7) is the open-ask card's own role, painted on nothing else.
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const askFill = [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => /var\(--ask-card\)/.test(m[2]!)).map((m) => m[1]!);
	assert.deepEqual([askFill, tab.$$(".workspace-context-ask").length], [[".workspace-context-ask"], 1], "one open ask: one ask-filled card");
	// Negative control: with no open ask left, nothing amber remains (no badge, no asked class, no ask card).
	const asks = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl"));
	for (const ask of asks.open()) asks.withdraw(ask.id, "fixture");
	tab.refresh();
	await tab.find(".workspace-context-open", (b) => b.getAttribute("aria-label") === "Context");
	assert.deepEqual([tab.$(".workspace-badge"), tab.$(".workspace-context-asked"), tab.$(".workspace-context-ask"), texts(tab, "aside.workspace-context h3")[0]],
		[null, null, null, "Asked you · 0"], "no open ask: no badge and no amber class");
	assert.equal(askFill.flatMap((selector) => tab.$$(selector)).length, 0, "the inspector stays open and nothing wears the ask fill");
});

test("M3-context-answer: the context card's options and the inline chips share one pending answer; one request, never two", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	const option = await tab.find(".workspace-context-option", (o) => o.textContent!.startsWith("Merge now") && !o.hasAttribute("disabled"));
	const chip = await tab.find(".session-entries > .session-replies .session-reply", (b) => b.textContent === "Hold" && !b.hasAttribute("disabled"));
	// Both clicks land before a re-render (linkedom fires a disabled button's listener too): only the shared
	// in-flight guard refuses the second. Negative control: removing that guard posts two answers here.
	tab.click(option);
	tab.click(chip);
	const answers = () => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message" && /"kind":"answer"/.test(r.body ?? ""));
	await until(() => answers().length, (n) => n > 0, "the answer request");
	await new Promise((done) => setTimeout(done, 200));
	const held = (selector: string) => tab.$$(selector).length > 0 && tab.$$(selector).every((b) => b.hasAttribute("disabled"));
	assert.deepEqual([answers().map((r) => JSON.parse(r.body!).label), held(".workspace-context-option"), held(".session-entries .session-reply")],
		[["Merge now"], true, true], "one answer, both surfaces held");
	assert.match(tab.$(".workspace-context-ask [role=status]")?.textContent ?? "", /the options close when the session records/, "the card says it is on its way");
});

test("M3-context-history: a context-less ask reads not recorded; on an older session file its options refuse, like the chips", { timeout: 180_000 }, async (t) => {
	const d = await start(t, null);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	await tab.find(".workspace-context-option", (o) => !o.hasAttribute("disabled"));
	assert.deepEqual([tab.$(".workspace-context-ask > .workspace-context-why")?.textContent, !!tab.$(".workspace-context-ask details"), !!tab.$(".workspace-context-history")],
		["Context not recorded", false, false], "no recorded context: said so, no disclosure; the current file answers");
	const next = join(d.home, "pi-sessions", "next.jsonl");
	writeFileSync(next, `${JSON.stringify({ type: "message", timestamp: iso(1), message: { role: "assistant", content: [{ type: "text", text: "NEXT-FILE" }] } })}\n`);
	appendFileSync(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: iso(1), session_file: next })}\n`);
	tab.go(`${CHAT}&session=chat.jsonl`);
	await tab.waitText(/Historical transcript/);
	if (!tab.$("aside.workspace-context")) tab.click(await tab.find(".workspace-context-open"));
	const option = await tab.find(".workspace-context-option");
	// replyTo's rule on the card: an older file never answers the live ask. Negative control: dropping `!current`.
	tab.click(option);
	await new Promise((done) => setTimeout(done, 200));
	assert.deepEqual([tab.$$(".workspace-context-option").every((o) => o.hasAttribute("disabled")), !!tab.$(".session-replies .session-reply"),
		tab.$(".workspace-context-history")?.textContent, tab.requests.filter((r) => r.method === "POST" && /"kind":"answer"/.test(r.body ?? "")).length],
		[true, false, "Open now; answer from the latest transcript, not this older file.", 0], "history: options and chips refuse, no answer sent");
});

test("M3-context-phone: the context sheet and the Conversations drawer are modal, close on Escape back to their button, keep the selection and drop on leaving", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	tab.type(await tab.find(".operator-composer textarea"), "KEEP-DRAFT");
	const button = await tab.find(".workspace-context-open");
	assert.deepEqual([button.getAttribute("aria-expanded"), !!tab.$(".workspace-context")], ["false", false], "899 px and below: no sheet pops on load");
	// Full match S1 strip: cp-other is live (held, idle) but not working, so only cp-live-t7ah counts.
	// Negative control: counting every live worker again reads "2 working" here.
	// S2 (C1): its compact id and recorded elapsed (frame 6); control: dropping the /api/jobs join leaves "· t7ah".
	assert.deepEqual(await until(() => texts(tab, ".session-strip-count, .session-strip-job"), (s) => s[1] !== "· t7ah", "the elapsed join"),
		["1 working", "· t7ah · 1h 0m"], "an idle worker is not called working");
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
	assert.deepEqual(texts(tab, ".workspace-sessions .session-choice strong"), ["Operator", "CP parent", "cp-other", "cp-live-t7ah"], "current session, then the Fleet");
	assert.deepEqual([!!tab.$(".workspace-sessions-head h2"), !!tab.$(".workspace-sessions-head .shell-rail-search"), tab.$$('.workspace-sessions nav[aria-label="Drawer primary"] a').map((a) => a.getAttribute("href"))],
		[false, true, ["#sessions", "#jobs", "#more"]], "Full match S1: the rail's chrome replaces the Conversations title row");
	assert.deepEqual(texts(tab, ".workspace-sessions-list h2"), ["Fleet · 2 live"]);
	assert.equal(tab.$('.workspace-sessions .session-choice[aria-current="page"]')!.getAttribute("href"), "#sessions?view=you&project=atlas", "the current session keeps the selection");
	assert.doesNotMatch(tab.$("dialog.workspace-sessions")!.textContent!, /New thread/, "no threads");
	assert.equal(escape(tab), true);
	await until(() => tab.$("dialog.workspace-sessions"), (el) => el === null, "Escape to close Conversations");
	assert.ok(focused() === conversations);
	tab.click(conversations);
	const worker = await tab.find(".workspace-sessions .session-choice", (a) => a.textContent!.includes("cp-live-t7ah"));
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
