/**
 * M3 slice 2 (cp-zm9f): the operator chat's Jobs drawer and the job beside it, through `bin/cp-view` on a scratch home
 * and the served app in its linkedom tab (DOM, classes, keyboard events and served CSS; no layout — the browser
 * fixture's `m3-jobs` screenshots are the layout evidence).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import type { Context } from "../harness/conversations.ts";
import { browserShims, dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const LONG = "Repair the queue so that a very long job title keeps wrapping inside its drawer row instead of clipping";
const DRAWER = "dialog.workspace-jobs";

/** A chat, two projects, one job per Jobs group (a parked one with its P2 review), and today's merge. */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	const chat = join(home, "pi-sessions", "chat.jsonl");
	mkdirSync(dirname(chat), { recursive: true });
	writeFileSync(chat, `${JSON.stringify({ type: "message", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	const job = (id: string, project: string, status: string, title = `Title ${id}`, extra: object = {}) =>
		({ id, title, status, labels: [`project:${project}`, "kind:ship"], blocked_by: [], ...extra });
	put(".pi-command-post/jobs.json", { jobs: [job("cp-live", "picp", "in_progress", LONG), job("cp-other", "atlas", "in_progress"), job("cp-park", "picp", "in_progress"),
		job("cp-merged", "picp", "closed", undefined, { closed_at: iso(30) })] });
	put(LAYOUT.fleetFile, { jobs: [
		{ job_id: "cp-live", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-other", project: "atlas", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-park", project: "picp", kind: "ship", delivery: "pr", phase: "awaiting_merge", branch: "cp-park", dispatched_at: iso(300), reported_at: iso(120),
			awaiting_merge: { cycle: 1, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: "b".repeat(40), base: "main", handed_at: iso(120), released_at: iso(120), frozen_seconds: 600, frozen_usage: {} } },
		{ job_id: "cp-merged", project: "picp", kind: "ship", phase: "done", dispatched_at: iso(90), closed_at: iso(30) },
	] });
	put(join(LAYOUT.runs, "cp-park/review-1.json"), { schema_version: 1, job_id: "cp-park", attempt: 1, verdict: "pass", cause: "ok", reasons: ["GUIDE-NOTE"], model: "rev/model-1",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, decided_at: iso(150), head_sha: "b".repeat(40), diff_stat: { files: 3, truncated: false } });
	put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", pr_url: "https://github.com/o/r/pull/2", merge_commit_sha: "c".repeat(40), merged_at: iso(30) });
}

/** A browser's Ctrl/Cmd+`key` on the window; returns whether the page claimed it. */
function chord(tab: Tab, key: string, modifier: "ctrlKey" | "metaKey" = "metaKey") {
	const event = new tab.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, [modifier]: true });
	tab.window.dispatchEvent(event);
	return event.defaultPrevented;
}
const escape = (tab: Tab) => tab.key(tab.document.body as unknown as Element, "Escape").defaultPrevented;
const headings = (tab: Tab) => tab.$$(`${DRAWER} h3`).map((h) => h.textContent);
const reads = (tab: Tab) => tab.requests.filter((r) => r.path === "/api/jobs").length;
const settle = () => new Promise((done) => setTimeout(done, 50));
/** `lines`, when given, replace the chat's pi transcript. */
const start = async (t: Context, lines?: object[]) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir, home) => {
		seed(stateDir, home);
		if (lines) writeFileSync(join(home, "pi-sessions", "chat.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	} });
	await operatorSession(t, d.stateDir);
	return d;
};

test("M3-jobs-drawer: chat Cmd+J opens the Jobs drawer; segments and the M1 filter narrow it; Escape returns focus with the draft kept", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	const field = await tab.find(".operator-composer textarea") as unknown as HTMLElement & { value: string };
	tab.type(field as unknown as Element, "KEEP-DRAFT");
	field.focus();
	const trigger = await tab.find(".session-filter > .workspace-jobs-open");
	assert.deepEqual([trigger.textContent, trigger.getAttribute("aria-expanded"), tab.$(DRAWER), reads(tab)], ["Jobs⌘J", "false", null, 0], "closed: one trigger, nothing read");

	for (const modifier of ["metaKey", "ctrlKey"] as const) {
		assert.equal(chord(tab, "j", modifier), true, `${modifier}+J is the chat's`);
		await tab.find(`${DRAWER}[open] .workspace-jobs-row`);
		assert.deepEqual(headings(tab), ["In flight · 2", "With the team · 1", "Done today · 1"], "every group, newest done first");
		assert.equal(tab.$$(DRAWER).length, 1);
		assert.equal(chord(tab, "J", modifier), true, "the same chord closes it");
		await until(() => tab.$(DRAWER), (el) => el === null, "the drawer to close");
		assert.ok(focused() === field, "focus is back in the composer");
	}
	chord(tab, "j");
	await tab.find(`${DRAWER}[open] .workspace-jobs-row`);
	const rows = tab.$$(".workspace-jobs-row");
	assert.equal(rows[0]!.querySelector("b")!.textContent, LONG, "a long title is the row's whole title, wrapped by CSS");
	assert.match(rows.at(-1)!.textContent!, /cp-merged · picp.*merged #2/, "id, project and its merge");
	tab.click(tab.$$(`${DRAWER} .jobs-segments button`).find((b) => b.textContent!.startsWith("In flight"))!);
	await settle();
	assert.deepEqual(headings(tab), ["In flight · 2"]);
	tab.click(tab.$$(`${DRAWER} .jobs-segments button`).find((b) => b.textContent!.startsWith("All"))!);

	const select = tab.$(`${DRAWER} select[aria-label="Filter by project"]`)!;
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "atlas");
	select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	tab.go(tab.window.location.hash);
	await until(() => headings(tab), (h) => h.length === 1, "the atlas selection");
	assert.deepEqual([headings(tab), tab.window.location.hash], [["In flight · 1"], `${CHAT}&project=atlas`], "M1: the hash carries the chat's selection");
	assert.equal(tab.$(`${DRAWER} .workspace-full`)!.getAttribute("href"), "#jobs?project=atlas", "Full page keeps the selection");
	assert.equal((tab.$('.session-filter select[aria-label="Filter by project"]') as unknown as { value: string }).value, "atlas", "one selection for chat and drawer");
	assert.equal(reads(tab), 3, "one read per opening; the selection never refetches");

	assert.equal(escape(tab), true);
	await until(() => tab.$(DRAWER), (el) => el === null, "Escape to close the drawer");
	assert.deepEqual([focused() === field, field.value, tab.window.location.hash], [true, "KEEP-DRAFT", `${CHAT}&project=atlas`], "focus, draft and filter kept");
	assert.equal(escape(tab), false, "with nothing open Escape is not the chat's");
	tab.click(trigger);
	(await tab.find(`${DRAWER}[open]`)).dispatchEvent(new tab.window.Event("cancel", { cancelable: true }));
	await until(() => tab.$(DRAWER), (el) => el === null, "the dialog's cancel to close it");
	assert.ok(focused() === trigger, "the button gets its own focus back");
});

test("M3-jobs-pane: a picked job opens beside the chat with its P2 review guide and P1 Ask; Escape closes it; Full page is the route", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	tab.type(await tab.find(".operator-composer textarea"), "KEEP-DRAFT");
	const trigger = await tab.find(".workspace-jobs-open");
	tab.click(trigger);
	tab.click(await tab.find(".workspace-jobs-row", (b) => b.textContent!.includes("cp-park")));
	const pane = await tab.find(".sessions > section.workspace-job");
	await tab.find(".workspace-job .review-guide");
	assert.equal(tab.$(DRAWER), null, "picking closes the drawer");
	assert.deepEqual([pane.getAttribute("aria-label"), tab.$(".workspace-job .job-detail-embedded h2.job-detail-title")!.textContent], ["Job cp-park", "Title cp-park"]);
	assert.equal(tab.$$(".workspace-job .page-header").length, 0, "the chat keeps the one page header");
	assert.match(tab.$(".workspace-job .review-guide")!.textContent!, /GUIDE-NOTE/, "P2: the recorded review reads in the pane");
	assert.equal(tab.$(".workspace-job .workspace-full")!.getAttribute("href"), "#job/cp-park", "the full route stays one tap away");
	assert.ok(focused() === tab.$('.workspace-job button[aria-label="Close job"]'), "focus moves into the pane");
	assert.ok(tab.$(".session-transcript") && tab.$(".operator-composer textarea"), "the chat stays mounted beside it");

	assert.equal(escape(tab), true);
	await until(() => tab.$(".workspace-job"), (el) => el === null, "Escape to close the pane");
	assert.ok(focused() === trigger, "focus returns to the opener");

	tab.click(trigger);
	tab.click(await tab.find(".workspace-jobs-row", (b) => b.textContent!.includes("cp-park")));
	const ask = await tab.find(".workspace-job a.evidence-ask", (a) => a.textContent === "Ask about this job");
	const ref = JSON.parse(new URLSearchParams(ask.getAttribute("href")!.split("?")[1]).get("ref")!);
	assert.deepEqual(ref, { kind: "job", project: "picp", job_id: "cp-park" }, "P1: the job's own reference");
	tab.go(ask.getAttribute("href")!);
	await tab.find(".evidence-chip");
	assert.equal((tab.$(".operator-composer textarea") as unknown as { value: string }).value, "KEEP-DRAFT", "the reference joins the kept draft");
});

test("M3-jobs-scope: Cmd+J belongs to the operator chat only; elsewhere it is untouched and Cmd+K still searches; back in chat one drawer", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	for (const hash of ["#jobs", "#overview", "#sessions?view=parent", "#job/cp-park"]) {
		tab.go(hash);
		await until(() => tab.$(".workspace-jobs-open"), (el) => el === null, `${hash} without the chat`);
		await settle();
		assert.equal(chord(tab, "j"), false, `${hash}: J is not prevented`);
		await settle();
		assert.equal(tab.$(DRAWER), null, `${hash}: no drawer`);
	}
	assert.equal(chord(tab, "k"), true, "K still opens search");
	const search = await tab.find("dialog[open]");
	assert.ok(!search.matches(DRAWER));
	search.dispatchEvent(new tab.window.Event("cancel", { cancelable: true }));
	await until(() => tab.$("dialog"), (el) => el === null, "search to close");

	tab.go(CHAT);
	await tab.find(".workspace-jobs-open");
	await settle();
	assert.equal(chord(tab, "j"), true);
	await tab.find(`${DRAWER}[open]`);
	assert.equal(tab.$$(DRAWER).length, 1, "one drawer after a remount");
	assert.equal(chord(tab, "j"), true);
	await until(() => tab.$(DRAWER), (el) => el === null, "one listener: the second press closes it");
	tab.click(tab.$(".workspace-jobs-open")!);
	await tab.find(`${DRAWER}[open]`);
	assert.equal(chord(tab, "k"), true, "K opens search over the drawer");
	await until(() => tab.$$("dialog[open]").length, (n) => n === 2, "search on top");
	assert.equal(escape(tab), false, "Escape belongs to the search first");
	assert.ok(tab.$(DRAWER), "the drawer stays under it");
});

const message = (minutes: number, m: object) => ({ type: "message", timestamp: iso(minutes), message: m });
const wake = (minutes: number, job: string, text: string) => ({ type: "custom_message", timestamp: iso(minutes), customType: "cp-bridge", display: true, content: `[cp-bridge wake job=${job}]\n${text}` });
const relay = (minutes: number, text: string) => message(minutes, { role: "assistant", content: [{ type: "text", text }] });
const operator = (minutes: number, text: string) => message(minutes, { role: "user", content: [{ type: "text", text }] });
const bash = (minutes: number, id: string) => [message(minutes, { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] }),
	message(minutes, { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }] })];
/** A run of steps for cp-park, two folded cp-live turns (a rollup), then a run naming a job no record has. */
const REPLIES = [wake(19, "cp-park", "PARK woke"), ...bash(19, "c1"), relay(19, "PARK relay"), operator(18, "break one"),
	wake(17, "cp-live", "LIVE woke 1"), relay(17, "LIVE relay 1"), wake(16, "cp-live", "LIVE woke 2"), relay(16, "LIVE relay 2"), operator(15, "break two"),
	wake(14, "cp-gone", "GONE woke"), ...bash(14, "c2"), relay(10, "REPLY-CARD")];
/** A browser's click: the page's handler first, then, unless it prevented it, the link's own href is followed. */
function activate(tab: Tab, link: Element) {
	const followed = tab.click(link);
	if (followed) tab.go(link.getAttribute("href")!);
	return followed;
}

test("M3-jobs-reply-log: a reply's job link opens Transcript in the pane and keeps Chat; modified clicks and the direct URL keep the route", { timeout: 180_000 }, async (t) => {
	const d = await start(t, REPLIES);
	const filtered = `${CHAT}&untagged=1`;
	const tab = await openTab(t, d.port, filtered, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	const field = await tab.find(".operator-composer textarea") as unknown as HTMLElement & { value: string };
	tab.type(field as unknown as Element, "KEEP-DRAFT");
	const run = (job: string) => tab.$$(".session-steps").find((r) => r.querySelector(".session-steps-face")?.textContent?.includes(job))!;
	const stepsLink = async (job: string) => {
		if (!run(job).querySelector(".session-steps-link")) tab.click(run(job).querySelector(".session-tools")!);
		return tab.find(".session-steps-link", (a) => a.getAttribute("href") === `#job/${job}?tab=transcript`);
	};
	const pane = (job: string) => tab.find(`.sessions > section.workspace-job[aria-label='Job ${job}']`);
	const tabOf = () => tab.find(".workspace-job .job-detail-embedded").then((el) => el.getAttribute("data-tab"));
	const closed = () => until(() => tab.$(".workspace-job"), (el) => el === null, "the pane to close");

	const park = await stepsLink("cp-park");
	const transcript = tab.$(".session-transcript") as Element & { scrollTop: number };
	transcript.scrollTop = 120;
	const followed = activate(tab, park);
	await settle();
	assert.deepEqual([followed, !!tab.$(".sessions"), tab.window.location.hash], [false, true, filtered], "an unmodified primary click is the chat's: .sessions and the route stay");
	await pane("cp-park");
	assert.deepEqual([await tabOf(), tab.$(".session-transcript") === transcript], ["transcript", true], "the existing Job Transcript opens beside the same chat");
	assert.ok(focused() === tab.$('.workspace-job button[aria-label="Close job"]'), "focus moves into the pane");
	assert.equal(escape(tab), true);
	await closed();
	assert.deepEqual([focused() === park, field.value, tab.window.location.hash, tab.$(".session-transcript") === transcript, transcript.scrollTop], [true, "KEEP-DRAFT", filtered, true, 120],
		"closing returns focus to the link with draft, filter and scroll kept");

	const rollup = await tab.find("a.session-rollup-job");
	assert.equal(activate(tab, rollup), false);
	await pane("cp-live");
	assert.deepEqual([await tabOf(), !!tab.$(".sessions")], ["transcript", true], "the rollup's job link opens the same pane");
	tab.click(tab.$('.workspace-job button[aria-label="Close job"]')!);
	await closed();
	assert.ok(focused() === rollup);

	tab.go(CHAT); // All projects: the drawer lists cp-park again
	tab.click(tab.$(".workspace-jobs-open")!);
	tab.click(await tab.find(".workspace-jobs-row", (b) => b.textContent!.includes("cp-park")));
	await pane("cp-park");
	assert.equal(await tabOf(), "details", "a drawer pick keeps the pane's Details default");
	assert.equal(escape(tab), true);
	await closed();

	const gone = await stepsLink("cp-gone");
	assert.equal(activate(tab, gone), false);
	await pane("cp-gone");
	await tab.find(".workspace-job [role=alert]");
	assert.equal(tab.$(".workspace-job [role=status]")?.textContent, "Job unavailable", "the existing unavailable state, in the pane");
	tab.click(tab.$('.workspace-job button[aria-label="Close job"]')!);
	await closed();
	assert.ok(focused() === gone, "its close action still works");

	for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
		const event = new tab.window.Event("click", { bubbles: true, cancelable: true });
		Object.assign(event, modifier);
		park.dispatchEvent(event);
		await settle();
		assert.deepEqual([event.defaultPrevented, tab.$(".workspace-job")], [false, null], `${JSON.stringify(modifier)} keeps the link's href`);
	}

	activate(tab, park);
	await pane("cp-park");
	// The operator starts a new session file while the pane is open: the refreshed chat drops it.
	const next = join(d.home, "pi-sessions", "next.jsonl");
	writeFileSync(next, "");
	appendFileSync(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: iso(1), session_file: next })}\n`);
	tab.refresh();
	await closed();

	// Direct-link compatibility (retained): a fresh transcript URL still opens the full job route.
	tab.go("#job/cp-park?tab=transcript");
	assert.equal(await until(() => tab.$(".job-detail")?.getAttribute("data-tab"), (tabName) => !!tabName, "the job page"), "transcript");
	assert.deepEqual([tab.$(".sessions"), tab.$(".job-detail-embedded")], [null, null], "the full route, not the pane");
});

test("M3-jobs-css: phone bottom sheet from y96 and full-screen job; desktop 860 px surface drawer, job over the chat, a 521 px pane from 1280 px", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	const split = css.indexOf("@media(min-width:900px){.workspace-jobs-open>kbd"), wide = css.indexOf("@media(min-width:1280px){.sessions:has(>.workspace-job)");
	assert.ok(split > 0 && wide > split, "the 900 px switch, then 1280 px");
	const [phone, desktop, beside] = [css.slice(0, split), css.slice(split, wide), css.slice(wide)];
	assert.match(rule(phone, ".workspace-jobs"), /border-radius:18px 18px 0 0/, "phone: a bottom sheet with the design's 18 px radius");
	assert.match(rule(phone, ".workspace-jobs"), /height:calc\(100dvh - 96px\)/, "phone: the sheet starts at y96, as Context's does");
	assert.match(rule(phone, ".workspace-job"), /position:fixed;inset:0/, "phone: the job is full screen");
	assert.match(rule(phone, ".workspace-jobs-title>b"), /overflow-wrap:anywhere/, "long titles wrap at 390 px");
	assert.match(rule(phone, ".workspace-close"), /width:44px;height:44px/, "44 px close");
	assert.match(rule(desktop, ".workspace-jobs"), /width:min\(860px,100%\)/, "desktop: the 860 px drawer");
	assert.match(rule(desktop, ".workspace-jobs"), /background:var\(--surface\)/, "desktop: the drawer is the design's raised surface");
	assert.match(rule(desktop, ".workspace-job"), /grid-column:2/, "under 1280 px the job covers the chat column");
	assert.match(rule(beside, ".sessions:has(>.workspace-job)"), /grid-template-columns:261px minmax\(0,1fr\) 521px/, "from 1280 px a 521 px pane, border included");
	// Only an unboxed reply's code block takes the surface: ask cards and pending sends sit on it, so theirs keep the page fill.
	assert.deepEqual([rule(css, ".sessions .md .md-code"), /background:var\(--background\)/.test(rule(css, ".md .md-code"))], ["", true],
		"ask and pending code blocks keep the page fill: no unscoped surface rule");
	assert.match(rule(css, ".sessions .session-other .md .md-code"), /background:var\(--surface\)/, "a reply's code block stays a visible box");
});
