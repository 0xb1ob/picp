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
	mkdirSync(join(dirname(stateDir), "data"), { recursive: true });
	writeFileSync(join(dirname(stateDir), "data", "projects.json"), JSON.stringify({ projects: [{ name: "picp" }, { name: "atlas" }] }));
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
/** M1: the selection lives in the hash; the sidebar's registered-project row marks it current. */
async function pick(tab: Tab, project: string) {
	tab.go(`${CHAT}&project=${project}`);
	await until(() => tab.$('.session-sidebar .project-row[aria-current="page"]')?.textContent, (name) => name === `#${project}`, `the ${project} selection`);
}

// Scenario: the desktop inspector carries the open ask and the selection's live workers
//   Given a chat with one open ask and two live workers   When the operator chat opens from 900 px
//   Then the inspector shows the ask (no answer-in-chat hop) and in-flight jobs; a job and Escape keep the chat
test("M3-context-inspector: Context opens the desktop inspector with the open ask and the selection's live workers; a job and Escape keep the chat", { timeout: 180_000 }, async (t) => {
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
		!!ask.querySelector(".workspace-context-chat")], [true, QUESTION, "Context", CONTEXT,
		[["Merge now · suggested", "Lands on green CI", true], ["Hold", "Waits for a review", false]], false], "the real ask; its context one bullet a line; no answer-in-chat hop");
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
	assert.doesNotMatch(tab.text(), /Started from chat|Today on/, "no thread joins to show");

	await pick(tab, "atlas");
	assert.deepEqual([texts(tab, "aside.workspace-context h3"), tab.$(".workspace-context-head > span")!.textContent], [["Asked you · 1", "In flight · 1"], "atlas"], "M1 narrows in-flight; asks stay whole");

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

// Scenario: the context card sends one answer, never two
//   Given an open ask in the desktop inspector   When two of its options are clicked before a re-render
//   Then one answer request posts, every option is held and the card says the answer is on its way
test("M3-context-answer: two clicks on the context card's options before a re-render send one answer, never two", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	const option = (label: string) => tab.find(".workspace-context-option", (o) => o.textContent!.startsWith(label) && !o.hasAttribute("disabled"));
	const [merge, hold] = [await option("Merge now"), await option("Hold")];
	// Both clicks land before a re-render (linkedom fires a disabled button's listener too): only the shared
	// in-flight guard refuses the second. Negative control: removing that guard posts two answers here.
	tab.click(merge);
	tab.click(hold);
	const answers = () => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message" && /"kind":"answer"/.test(r.body ?? ""));
	await until(() => answers().length, (n) => n > 0, "the answer request");
	await new Promise((done) => setTimeout(done, 200));
	const held = tab.$$(".workspace-context-option").every((b) => b.hasAttribute("disabled"));
	assert.deepEqual([answers().map((r) => JSON.parse(r.body!).label), held], [["Merge now"], true], "one answer, every option held");
	assert.match(tab.$(".workspace-context-ask [role=status]")?.textContent ?? "", /the options close when the session records/, "the card says it is on its way");
});

// Scenario: the sidebar card is the one place in the chat to answer an open ask
//   Given an open ask carded in the operator chat   When the chat opens on a phone and from 900 px
//   Then the main chat view renders no decisions panel and no option chips; the sidebar card shows the ask and context
//   When its "Hold" option is clicked   Then the session receives the dashboard message "<ask-id>: Hold"
test("M3-context-sole-answer: an open ask renders no decisions panel or option chips in the chat; the sidebar card shows it and its answer reaches the session", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir: string, home: string) => seed(stateDir, home) });
	const session = await operatorSession(t, d.stateDir);
	const [ask] = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl")).open();
	// Chips were buttons labelled with the ask's options under its bubble; negative control: restoring them fails here.
	const panel = (tab: Tab) => [tab.$$(".session-panel .session-pinned, .session-panel .decision-card").length, /decisions? waiting/.test(tab.$(".session-panel")!.textContent!),
		tab.$$(".session-panel button").filter((b) => ["Merge now", "Hold"].includes(b.textContent!)).length, tab.$$(".session-panel .session-ask-pointer").length];
	const phone = await openTab(t, d.port, CHAT);
	await phone.waitText(/REPLY-CARD/);
	assert.deepEqual(panel(phone), [0, false, 0, 1], "phone: the one-line ask bubble, no decisions panel, no option chips");
	phone.close();
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	assert.deepEqual(panel(tab), [0, false, 0, 1], "desktop: the one-line ask bubble, no decisions panel, no option chips");
	const card = await tab.find("aside.workspace-context .workspace-context-ask");
	assert.deepEqual([card.querySelector("b")!.textContent, texts(tab, ".workspace-context-option > b"), !!card.querySelector("details.workspace-context-why[open]")],
		[QUESTION, ["Merge now · suggested", "Hold"], true], "the sidebar card: the question, its options with the suggested one, the context");
	tab.click(await tab.find(".workspace-context-option", (o) => o.textContent!.startsWith("Hold") && !o.hasAttribute("disabled")));
	const [text] = (await until(() => session.injected, (rows) => rows.length > 0, "the injected answer")).at(-1)!;
	assert.match(text, new RegExp(`^${ask!.id}: Hold\\n\\n\\[cp-dashboard dc-.* — from the dashboard; ask=${ask!.id}\\]$`), "the same ask-id: label dashboard message");
});

const ctrlEnter = (tab: Tab, el: Element) => {
	const event = new (tab.globals.Event as typeof Event)("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: "Enter" }, ctrlKey: { value: true } });
	el.dispatchEvent(event);
};
const replies = (tab: Tab) => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message" && /"kind":"message"/.test(r.body ?? ""));
const held = (tab: Tab) => tab.$$(".workspace-context-option, .workspace-context-other").every((b) => b.hasAttribute("disabled"));

// Scenario: the sidebar card's "Other answer…" sends a typed reply tied to its ask, from a centered modal
//   Given an open ask in the desktop inspector   When "Other answer…" opens the modal and only blanks are typed
//   Then Send is refused; Escape with text asks first and a declined confirm keeps the modal and the inspector
//   When Ctrl+Enter sends a two-line reply   Then one message posts "<ask-id>: <text>", the modal closes, the card locks
test("M3-context-other: Other answer opens a modal; blanks never send, Escape confirms, Ctrl+Enter sends the reply and locks the card", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir: string, home: string) => seed(stateDir, home) });
	const session = await operatorSession(t, d.stateDir);
	const [ask] = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl")).open();
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	tab.click(await tab.find("aside.workspace-context .workspace-context-other", (b) => !b.hasAttribute("disabled")));
	const modal = await tab.find("dialog.ask-other[open]");
	const field = modal.querySelector("textarea")!, send = () => modal.querySelector(".ask-other-send")!;
	assert.deepEqual([modal.querySelector("h2")!.textContent, focused() === field, tab.$$(".workspace-context-option").length], [QUESTION, true, 2],
		"the ask's question heads a modal, its textarea focused; the options are unchanged");
	tab.type(field, "  \n ");
	await new Promise((done) => setTimeout(done, 50));
	ctrlEnter(tab, field);
	tab.click(send());
	await new Promise((done) => setTimeout(done, 200));
	assert.deepEqual([send().hasAttribute("disabled"), replies(tab).length], [true, 0], "a blank reply cannot be sent");
	tab.type(field, "Hold until Friday\nthen merge");
	await until(() => send().hasAttribute("disabled"), (off) => !off, "Send enabled by the text");
	tab.decline();
	assert.equal(tab.key(field, "Escape").defaultPrevented, true);
	// Negative control: an Escape that reached the chat's own handler would close the inspector behind the modal.
	assert.deepEqual([tab.confirms, !!tab.$("dialog.ask-other[open]"), !!tab.$("aside.workspace-context")], [["Discard this answer?"], true, true],
		"Escape with text asks first; declined, the modal and the inspector stay");
	ctrlEnter(tab, field);
	await until(() => replies(tab).length, (n) => n > 0, "the reply request");
	await until(() => tab.$("dialog.ask-other"), (el) => el === null, "the modal to close on send");
	assert.deepEqual(replies(tab).map((r) => JSON.parse(r.body!).text), [`${ask!.id}: Hold until Friday\nthen merge`], "one reply, tied to its ask");
	await new Promise((done) => setTimeout(done, 200));
	assert.equal(held(tab), true, "the options and Other answer… lock as an option click does");
	const [text] = (await until(() => session.injected, (rows) => rows.length > 0, "the injected reply")).at(-1)!;
	assert.match(text, new RegExp(`^${ask!.id}: Hold until Friday\\nthen merge\\n\\n\\[cp-dashboard dc-.* — from the dashboard\\]$`));
});

// Scenario: a failed reply from the phone sheet re-enables the card and keeps the typed text
//   Given the context sheet on a phone and a session whose handoff fails   When the modal opens over the sheet
//   Then the textarea has focus and an empty Escape closes only the modal, focus back on its button
//   When a reply is sent and fails   Then the card shows the failure, re-enables, and the modal reopens with the text
test("M3-context-other-failed: over the phone sheet the modal stacks; a failed reply re-enables the card and keeps its text", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir: string, home: string) => seed(stateDir, home) });
	await operatorSession(t, d.stateDir, () => true, { inject: () => { throw new Error("FIXTURE-HANDOFF-DOWN"); } });
	const tab = await openTab(t, d.port, CHAT);
	const focused = browserShims(t, tab);
	tab.click(await tab.find(".workspace-context-open"));
	const other = await tab.find("dialog.workspace-context-sheet[open] .workspace-context-other", (b) => !b.hasAttribute("disabled")) as unknown as HTMLElement;
	other.focus();
	tab.click(other);
	const modal = await tab.find("dialog.workspace-context-sheet[open] dialog.ask-other[open]");
	assert.ok(focused() === modal.querySelector("textarea"), "the modal over the sheet takes focus");
	tab.key(modal.querySelector("textarea")!, "Escape");
	await until(() => tab.$("dialog.ask-other"), (el) => el === null, "an empty Escape to close the modal");
	assert.deepEqual([!!tab.$("dialog.workspace-context-sheet[open]"), focused() === other, tab.confirms], [true, true, []], "only the modal closed; nothing to confirm");
	tab.click(other);
	tab.type((await tab.find("dialog.ask-other[open] textarea")), "KEEP-THIS-REPLY");
	tab.click(await tab.find("dialog.ask-other .ask-other-send", (b) => !b.hasAttribute("disabled")));
	await until(() => tab.$(".workspace-context-ask [role=alert]")?.textContent ?? "", (s) => /FIXTURE-HANDOFF-DOWN/.test(s), "the failure line");
	await until(() => held(tab), (h) => !h, "the card to re-enable");
	assert.equal(replies(tab).length, 1);
	tab.click(other);
	const reopened = await tab.find("dialog.ask-other[open] textarea") as unknown as { value: string };
	assert.equal(reopened.value, "KEEP-THIS-REPLY", "the typed text survives the failure");
});

test("M3-context-history: a context-less ask reads not recorded; on an older session file its options refuse", { timeout: 180_000 }, async (t) => {
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
	// An older file never answers the live ask. Negative control: dropping `!current`.
	tab.click(option);
	await new Promise((done) => setTimeout(done, 200));
	assert.deepEqual([tab.$$(".workspace-context-option").every((o) => o.hasAttribute("disabled")),
		tab.$(".workspace-context-history")?.textContent, tab.requests.filter((r) => r.method === "POST" && /"kind":"answer"/.test(r.body ?? "")).length],
		[true, "Open now; answer from the latest transcript, not this older file.", 0], "history: the options refuse, no answer sent");
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
	// The drawer carries the sidebar's project rows, atlas current; negative control: the retired thread rail.
	assert.deepEqual([texts(tab, ".workspace-sessions .project-row"), tab.$('.workspace-sessions .project-row[aria-current="page"]')?.textContent, /New thread/.test(tab.$("dialog.workspace-sessions")!.textContent!)],
		[["#All projects", "#atlas"], "#atlas", false], "the drawer carries the project rows: no session project, the selection kept");
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
	await until(() => (tab.$(".operator-composer textarea") as unknown as { value: string } | null)?.value, (v) => v === "KEEP-DRAFT", "the draft restored");
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
