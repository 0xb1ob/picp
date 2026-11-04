/**
 * M3 slice 2 (cp-zm9f): the operator chat's Jobs drawer and the job beside it, through `bin/cp-view` on a scratch home
 * and the served app in its linkedom tab (DOM, classes, keyboard events and served CSS; no layout — the browser
 * fixture's `m3-jobs` screenshots are the layout evidence).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Full match S3: done-today extras for Show more, newest first (the third has a long id); a queued and an old job. */
const EXTRA = Array.from({ length: 7 }, (_, i) => i === 2 ? "cp-done-with-a-very-long-identifier-that-keeps-going-q3x9" : `cp-done-${i}`);
/** A chat, two projects, one job per Jobs group (a parked one with its P2 review), today's merge; `extra` adds more. */
function seed(stateDir: string, home: string, extra = false) {
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
	const extras = extra ? EXTRA : [];
	put(".pi-command-post/jobs.json", { jobs: [job("cp-live", "picp", "in_progress", LONG), job("cp-other", "picp-lab", "in_progress"), job("cp-park", "picp", "in_progress"),
		job("cp-merged", "picp", "closed", undefined, { closed_at: iso(30) }), ...extras.map((id, i) => job(id, "picp", "closed", undefined, { closed_at: iso(40 + i) })),
		...(extra ? [job("cp-queued", "picp", "open"), job("cp-old-r2d2", "picp-old", "closed", undefined, { closed_at: iso(1800) })] : [])] });
	put(LAYOUT.fleetFile, { jobs: [
		{ job_id: "cp-live", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-other", project: "picp-lab", kind: "ship", phase: "waiting", dispatched_at: iso(60) },
		{ job_id: "cp-park", project: "picp", kind: "ship", delivery: "pr", phase: "awaiting_merge", branch: "cp-park", dispatched_at: iso(300), reported_at: iso(120),
			awaiting_merge: { cycle: 1, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: "b".repeat(40), base: "main", handed_at: iso(120), released_at: iso(120), frozen_seconds: 600, frozen_usage: {} } },
		{ job_id: "cp-merged", project: "picp", kind: "ship", phase: "done", dispatched_at: iso(90), closed_at: iso(30) },
		...extras.map((job_id, i) => ({ job_id, project: "picp", kind: "ship", phase: "done", dispatched_at: iso(100 + i), closed_at: iso(40 + i) })),
		...(extra ? [{ job_id: "cp-old-r2d2", project: "picp-old", kind: "ship", phase: "done", dispatched_at: iso(1900), closed_at: iso(1800) }] : []),
	] });
	put(join(LAYOUT.runs, "cp-park/review-1.json"), { schema_version: 1, job_id: "cp-park", attempt: 1, verdict: "pass", cause: "ok", reasons: ["GUIDE-NOTE"], model: "rev/model-1",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, decided_at: iso(150), head_sha: "b".repeat(40), diff_stat: { files: 3, truncated: false } });
	put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", pr_url: "https://github.com/o/r/pull/2", merge_commit_sha: "c".repeat(40), merged_at: iso(30) });
	// Full match S4: cp-other's run is working; cp-park has a worker session for its Log and a report.md.
	put(join(LAYOUT.runs, "cp-other/status.json"), { phase: "working", started_at: iso(60) });
	const worker = join(stateDir, "sessions", "cp-park.jsonl"), at = (minutes: number, message: object) => JSON.stringify({ type: "message", timestamp: iso(minutes), message });
	put(join(LAYOUT.runs, "cp-park/status.json"), { session_file: worker });
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(worker, `${[at(200, { role: "user", content: [{ type: "text", text: "LOG-BRIEF fix the route" }] }),
		at(199, { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/route.ts" } }] }),
		at(199, { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "LOG-READ 212 lines" }] }),
		at(198, { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } }] }),
		at(198, { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "PASS tests/route.test.ts" }] }),
		at(197, { role: "assistant", content: [{ type: "text", text: "LOG-SAY the route is fixed" }] })].join("\n")}\n`);
	put(join(LAYOUT.state, "artifacts/cp-park/report.md"), "# Park report\n\nREPORT-BODY\n");
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
const start = async (t: Context, lines?: object[], extra = false) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir, home) => {
		seed(stateDir, home, extra);
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
	// Full match S2: the chat's context reads /api/jobs once (exact-id join); the closed drawer reads nothing more.
	assert.deepEqual([trigger.textContent, trigger.getAttribute("aria-expanded"), tab.$(DRAWER), await until(() => reads(tab), (n) => n > 0, "the context read")], ["Jobs⌘J", "false", null, 1], "closed: one trigger, one context read");
	assert.deepEqual([trigger.closest("header.session-heading") !== null, trigger.getAttribute("title")], [true, "Jobs (Ctrl/⌘ J)"], "Full match S1: Jobs ⌘J sits in the compact header");

	for (const modifier of ["metaKey", "ctrlKey"] as const) {
		assert.equal(chord(tab, "j", modifier), true, `${modifier}+J is the chat's`);
		await tab.find(`${DRAWER}[open] .workspace-jobs-row`);
		assert.equal(trigger.getAttribute("aria-expanded"), "true", `${modifier}+J opens the drawer from the header's opener`);
		assert.deepEqual(headings(tab), ["In flight · 2", "With the team · 1", "Done today · 1"], "every group, newest done first");
		assert.equal(tab.$$(DRAWER).length, 1);
		assert.equal(chord(tab, "J", modifier), true, "the same chord closes it");
		await until(() => tab.$(DRAWER), (el) => el === null, "the drawer to close");
		assert.ok(focused() === field, "focus is back in the composer");
	}
	chord(tab, "j");
	await tab.find(`${DRAWER}[open] .workspace-jobs-row`);
	const rows = tab.$$(".workspace-jobs-row");
	// Full match S3: "wrapped by CSS" became one ellipsised line (frames 3/9); the full title stays in `title`.
	assert.deepEqual([rows[0]!.querySelector("b")!.textContent, rows[0]!.querySelector("b")!.getAttribute("title")], [LONG, LONG], "a long title is the row's whole title");
	assert.match(rows.at(-1)!.textContent!, /cp-merged · picp.*Merged #2/, "id, project and its merge (S3: capitalised as in frames 3/9)");
	// Full match S3: the segments "All / In flight / Done today" became the design's "Today / In flight / All" (frame 9).
	tab.click(tab.$$(`${DRAWER} .jobs-segments button`).find((b) => b.textContent!.startsWith("In flight"))!);
	await settle();
	assert.deepEqual(headings(tab), ["In flight · 2"]);
	tab.click(tab.$$(`${DRAWER} .jobs-segments button`).find((b) => b.textContent!.startsWith("Today"))!);

	const select = tab.$(`${DRAWER} select[aria-label="Filter by project"]`)!;
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "picp-lab");
	select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	tab.go(tab.window.location.hash);
	await until(() => headings(tab), (h) => h.length === 1, "the picp-lab selection");
	assert.deepEqual([headings(tab), tab.window.location.hash], [["In flight · 1"], `${CHAT}&project=picp-lab`], "M1: the hash carries the chat's selection");
	assert.equal(tab.$(`${DRAWER} .workspace-full`)!.getAttribute("href"), "#jobs?project=picp-lab", "Full page keeps the selection");
	assert.equal((tab.$('.session-filter select[aria-label="Filter by project"]') as unknown as { value: string }).value, "picp-lab", "one selection for chat and drawer");
	assert.equal(reads(tab), 4, "one read per opening plus the context's one; the selection never refetches");

	assert.equal(escape(tab), true);
	await until(() => tab.$(DRAWER), (el) => el === null, "Escape to close the drawer");
	assert.deepEqual([focused() === field, field.value, tab.window.location.hash], [true, "KEEP-DRAFT", `${CHAT}&project=picp-lab`], "focus, draft and filter kept");
	assert.equal(escape(tab), true, "Full match S1: Escape next closes the inspector the chat opened by default");
	await until(() => tab.$(".workspace-context"), (el) => el === null, "Escape to close the inspector");
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

test("M3-jobs-reply-log: a reply's job link opens Log in the pane and keeps Chat; modified clicks and the direct URL keep the route", { timeout: 180_000 }, async (t) => {
	const d = await start(t, REPLIES);
	const filtered = `${CHAT}&untagged=1`;
	const tab = await openTab(t, d.port, filtered, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	const field = await tab.find(".operator-composer textarea") as unknown as HTMLElement & { value: string };
	tab.type(field as unknown as Element, "KEEP-DRAFT");
	// Full match S2: the pill shows a compact suffix; the full id is its toggle's title.
	const run = (job: string) => tab.$$(".session-steps").find((r) => r.querySelector(".session-tools")?.getAttribute("title") === job)!;
	const stepsLink = async (job: string) => {
		if (!run(job).querySelector(".session-steps-link")) tab.click(run(job).querySelector(".session-tools")!);
		return tab.find(".session-steps-link", (a) => a.getAttribute("href") === `#job/${job}?tab=transcript`);
	};
	const pane = (job: string) => tab.find(`.sessions > section.workspace-job[aria-label='Job ${job}']`);
	// Full match S4: a reply's link opens the Log view; a drawer pick keeps the embedded job page's Details.
	const tabOf = () => tab.find(".workspace-job .workspace-log").then((el) => el.getAttribute("data-view") === "details" ? tab.$(".workspace-job .job-detail-embedded")?.getAttribute("data-tab") : el.getAttribute("data-view"));
	const closed = () => until(() => tab.$(".workspace-job"), (el) => el === null, "the pane to close");

	const park = await stepsLink("cp-park");
	const transcript = tab.$(".session-transcript") as Element & { scrollTop: number };
	transcript.scrollTop = 120;
	const followed = activate(tab, park);
	await settle();
	assert.deepEqual([followed, !!tab.$(".sessions"), tab.window.location.hash], [false, true, filtered], "an unmodified primary click is the chat's: .sessions and the route stay");
	await pane("cp-park");
	assert.deepEqual([await tabOf(), tab.$(".session-transcript") === transcript], ["log", true], "the job's Log opens beside the same chat");
	assert.ok(focused() === tab.$('.workspace-job button[aria-label="Close job"]'), "focus moves into the pane");
	assert.equal(escape(tab), true);
	await closed();
	assert.deepEqual([focused() === park, field.value, tab.window.location.hash, tab.$(".session-transcript") === transcript, transcript.scrollTop], [true, "KEEP-DRAFT", filtered, true, 120],
		"closing returns focus to the link with draft, filter and scroll kept");

	const rollup = await tab.find("a.session-rollup-job");
	assert.equal(activate(tab, rollup), false);
	await pane("cp-live");
	assert.deepEqual([await tabOf(), !!tab.$(".sessions")], ["log", true], "the rollup's job link opens the same pane");
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

test("M3-jobs-log (full match S4): a reply's link opens Log with Report, Files and Details; the Ask footer drafts P1, never sends", { timeout: 180_000 }, async (t) => {
	const d = await start(t, REPLIES);
	const filtered = `${CHAT}&untagged=1`;
	const tab = await openTab(t, d.port, filtered, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	const field = await tab.find(".operator-composer textarea") as unknown as HTMLElement & { value: string };
	tab.type(field as unknown as Element, "KEEP-DRAFT");
	tab.click(tab.$$(".session-steps .session-tools").find((b) => b.getAttribute("title") === "cp-park")!);
	const link = await tab.find(".session-steps-link", (a) => a.getAttribute("href") === "#job/cp-park?tab=transcript");
	const texts = (selector: string) => tab.$$(`.workspace-job ${selector}`).map((e) => e.textContent);
	const view = (name: string) => tab.click(tab.$$(".workspace-log-tabs [role=tab]").find((b) => b.textContent === name)!);
	assert.equal(activate(tab, link), false, "an unmodified click on the reply's link is the chat's");
	const rows = await until(() => texts(".workspace-log-row"), (r) => r.length > 0, "the Log");
	assert.deepEqual(rows, ["Parent · LOG-BRIEF fix the route", "read(src/route.ts)└ LOG-READ 212 lines", "bash(npm test)└ PASS tests/route.test.ts", "• LOG-SAY the route is fixed"],
		"the worker's entries in order: tool, target and output, then the worker's own line");
	assert.deepEqual([texts(".workspace-job-name > *"), texts(".workspace-job-phase"), texts(".workspace-log-who p"), texts(".workspace-log-tabs [role=tab]")],
		[["Title cp-park", "cp-park"], ["With the team"], ["role not recorded · model not recorded · thinking not recorded", "worktree not recorded"], ["Log", "Report", "Files", "Details"]],
		"title, id and phase; unrecorded worker facts say so; Log, Report, Files and Details, no Diff before S7");
	assert.equal(tab.$$(".workspace-job textarea, .workspace-job form").length, 0, "the log has no composer of its own");

	view("Report");
	await tab.find(".workspace-log-report");
	assert.match(tab.$(".workspace-log-report")!.textContent!, /REPORT-BODY/, "the report reads through the report page's own endpoint");
	rmSync(join(d.home, LAYOUT.state, "artifacts/cp-park/report.md"));
	view("Files");
	assert.deepEqual(await until(() => texts(".workspace-log-files > *"), (f) => f.length > 0, "the Files view"), ["Files unavailable", "Run log unavailable"],
		"the job page's file pointers, each missing one unavailable");
	view("Report");
	assert.equal(await until(() => tab.$(".workspace-job [role=status]")?.textContent, (s) => !!s && s !== "Loading", "the report re-read"),
		"Report unavailable · report.md could not be read", "a report that no longer reads is unavailable, never an empty page");
	view("Details");
	await tab.find(".workspace-job .review-guide");
	assert.deepEqual([/GUIDE-NOTE/.test(tab.$(".workspace-job .review-guide")!.textContent!), texts(".job-tab").includes("Timeline")], [true, true], "P2 guide and Timeline kept");
	view("Log");
	await tab.find(".workspace-log-row");

	assert.equal(escape(tab), true);
	await until(() => tab.$(".workspace-job"), (el) => el === null, "Escape to close the pane");
	assert.deepEqual([focused() === link, field.value, tab.window.location.hash], [true, "KEEP-DRAFT", filtered], "focus back on the link; draft and filter kept");

	// Plan S4: an unknown report reads unavailable and close still works.
	const rollup = await tab.find("a.session-rollup-job");
	assert.equal(activate(tab, rollup), false);
	await tab.find(".sessions > section.workspace-job[aria-label='Job cp-live'] .workspace-log");
	view("Report");
	assert.equal((await tab.find(".workspace-job [role=status]", (s) => s.textContent !== "Loading")).textContent, "Report unavailable · no report.md recorded", "no report.md: unavailable");
	tab.click(tab.$('.workspace-job button[aria-label="Close job"]')!);
	await until(() => tab.$(".workspace-job"), (el) => el === null, "close still works");
	assert.ok(focused() === rollup, "focus returns to the rollup link");

	activate(tab, link);
	const ask = await tab.find(".workspace-log-ask a.evidence-ask");
	const writes = () => tab.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").map((r) => r.path);
	const before = writes();
	assert.deepEqual([ask.textContent, JSON.parse(new URLSearchParams(ask.getAttribute("href")!.split("?")[1]).get("ref")!)], ["Ask about this job…", { kind: "job", project: "picp", job_id: "cp-park" }],
		"P1: the footer carries this job's own reference");
	assert.equal(activate(tab, ask), true, "the footer is a link into operator Chat");
	await tab.find(".evidence-chip");
	await settle();
	assert.deepEqual([(tab.$(".operator-composer textarea") as unknown as { value: string }).value, writes()], ["KEEP-DRAFT", before],
		"the reference joins the kept draft; nothing is sent");
});

test("M3-jobs-query (full match S3): Today/In flight, project and query narrow counts and rows; Show more keeps focus; a pick keeps Details, links and P2", { timeout: 180_000 }, async (t) => {
	const d = await start(t, undefined, true);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	const focused = browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	tab.click(await tab.find(".workspace-jobs-open"));
	await tab.find(`${DRAWER}[open] .workspace-jobs-row`);
	const segments = () => tab.$$(`${DRAWER} .jobs-segments button`).map((b) => b.textContent);
	const ids = (group: string) => tab.$$(`${DRAWER} section[aria-label="${group}"] .workspace-jobs-row`).map((b) => b.getAttribute("data-job"));
	const head = tab.$(`${DRAWER} header.workspace-jobs-head`)!, pill = head.querySelector(".workspace-jobs-bar > details.workspace-jobs-project")!;
	// Full match S3: the bar's native select became frame 3/9's "● picp ▾" pill around the same M1 select.
	assert.deepEqual([pill?.querySelector("summary")?.textContent ?? null, !!pill?.querySelector('select[aria-label="Filter by project"]'), !!head.querySelector(".workspace-jobs-bar > label.project-filter"),
		!!head.querySelector(".workspace-jobs-bar > .jobs-segments"), head.querySelector('input[type="search"]')!.parentElement!.parentElement === head], ["All projects▾", true, false, true, true],
		"one toolbar: the project pill, Today/In flight/All, and the query on its own row");
	pill.setAttribute("open", "");
	assert.deepEqual([tab.key(pill.querySelector("summary")!, "Escape").defaultPrevented, pill.hasAttribute("open"), !!tab.$(`${DRAWER}[open]`)], [true, false, true],
		"Escape closes the pill's popover first and keeps the drawer");
	pill.setAttribute("open", "");
	tab.$(`${DRAWER} .workspace-jobs-cols`)!.dispatchEvent(new tab.window.Event("pointerdown", { bubbles: true }));
	assert.equal(pill.hasAttribute("open"), false, "a tap outside the pill closes it");
	assert.deepEqual(tab.$$(`${DRAWER} .workspace-jobs-cols span`).map((s) => s.textContent), ["Job", "Title / context", "Status", "Done", "Cost"], "desktop column headings");
	assert.deepEqual([segments(), headings(tab)], [["Today12", "In flight2", "All"], ["In flight · 2", "With the team · 1", "Queued · 1", "Done today · 8"]], "every real group, team and queued included");
	const queued = tab.$$(".workspace-jobs-row").find((b) => b.getAttribute("data-job") === "cp-queued")!;
	assert.deepEqual(["cost", "done", "meta"].map((c) => queued.querySelector(`.workspace-jobs-${c}`)!.textContent), ["not recorded", "not recorded", "queued · cost not recorded"],
		"an unrecorded cost or time says so, never $0 or 0m");
	// Full match S3: lowercase neutral labels became capitalised ones; only Merged takes a colour (blue).
	const status = (id: string) => { const s = tab.$(`${DRAWER} [data-job="${id}"] .workspace-jobs-status`)!, tone = ["merged", "working"].find((k) => s.classList.contains(`workspace-jobs-status-${k}`));
		return `${s.textContent}/${tone ?? "neutral"}`; };
	// Full match S4 (S3 review 4): cp-other's run is working, so the list pins the neutral Working label too.
	assert.deepEqual(["cp-merged", "cp-done-0", "cp-park", "cp-queued", "cp-live", "cp-other"].map(status),
		["Merged #2/merged", "Done/neutral", "With the team/neutral", "Queued/neutral", "Held/neutral", "Working/neutral"], "capitalised statuses; only Merged takes a colour here");

	// Show more: five rows, then the rest; focus lands on the first revealed row instead of the vanished button.
	assert.deepEqual(ids("Done today"), ["cp-merged", ...EXTRA.slice(0, 4)], "five rows, newest first");
	const more = tab.$(`${DRAWER} section[aria-label="Done today"] .workspace-jobs-more`)!;
	assert.equal(more.textContent, "Show 3 more");
	tab.click(more);
	await until(() => ids("Done today").length, (n) => n === 8, "the rest of Done today");
	assert.deepEqual([!!tab.$(`${DRAWER} .workspace-jobs-more`), focused()?.getAttribute("data-job")], [false, EXTRA[4]], "Show more keeps focus on the next row");
	const long = tab.$$(".workspace-jobs-row").find((b) => b.getAttribute("data-job") === EXTRA[2])!;
	assert.deepEqual([long.querySelector(".workspace-jobs-id code")!.getAttribute("title"), long.querySelector(".workspace-jobs-job code")!.textContent], [EXTRA[2], "q3x9"],
		"a long id: whole in its title, the suffix in the Job cell");

	// The query matches recorded id, title or project, case-insensitively, before every count.
	const query = tab.$(`${DRAWER} input[type="search"]`)!;
	for (const [text, want, rows] of [["PICP-LAB", ["Today1", "In flight1", "All"], ["cp-other"]], ["title cp-park", ["Today1", "In flight0", "All"], ["cp-park"]],
		["done-5", ["Today1", "In flight0", "All"], ["cp-done-5"]]] as const) {
		tab.type(query, text);
		await until(() => segments().join(), (s) => s === want.join(), `the query ${text}`);
		assert.deepEqual(tab.$$(".workspace-jobs-row").map((b) => b.getAttribute("data-job")), rows, `${text} matches its recorded job`);
	}
	const pick = (label: string) => tab.click(tab.$$(`${DRAWER} .jobs-segments button`).find((b) => b.textContent!.startsWith(label))!);
	const shown = () => tab.$(`${DRAWER} [role=status]`)?.textContent ?? headings(tab).join();
	pick("In flight");
	tab.type(query, "park");
	await until(shown, (s) => s === "No in-flight jobs match “park”", "In flight hides the parked job");
	tab.type(query, "");
	// Review 1: Today with only a yesterday job said "Nothing in flight"; each filter now names its own empty state.
	const old = tab.$(`${DRAWER} select[aria-label="Filter by project"]`)!;
	for (const option of old.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "picp-old");
	old.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	tab.go(tab.window.location.hash);
	await until(shown, (s) => s === "Nothing in flight", "picp-old: nothing in flight");
	pick("Today");
	await until(shown, (s) => s === "Nothing today", "picp-old: nothing today");
	// Frame 9's All: no day filter over the same recorded jobs, so yesterday's job is listed under Done.
	pick("All");
	await until(shown, (s) => s === "Done · 1", "picp-old: All lists yesterday's job");
	assert.equal(tab.$(`${DRAWER} .workspace-jobs-scope`)!.textContent, "picp-old · all days");
	tab.go(CHAT);
	pick("Today");
	await until(() => headings(tab).length, (n) => n === 4, "back to every project today");

	// A pick from the query keeps the pane's Details default, its P2 review guide and the direct links.
	tab.click(await tab.find(".workspace-jobs-row", (b) => b.getAttribute("data-job") === "cp-park"));
	await tab.find(".workspace-job .review-guide");
	assert.deepEqual([tab.$(".workspace-job .job-detail-embedded")!.getAttribute("data-tab"), tab.$(".workspace-job .workspace-full")!.getAttribute("href")], ["details", "#job/cp-park"]);
	assert.match(tab.$(".workspace-job .review-guide")!.textContent!, /GUIDE-NOTE/, "P2 retained");
	assert.equal(escape(tab), true);
	await until(() => tab.$(".workspace-job"), (el) => el === null, "Escape to close the pane");
	tab.click(tab.$(".workspace-jobs-open")!);
	await tab.find(`${DRAWER}[open]`);
	assert.deepEqual([(tab.$(`${DRAWER} input[type="search"]`) as unknown as { value: string }).value, tab.$(`${DRAWER} .workspace-full`)!.getAttribute("href")], ["", "#jobs"],
		"a reopened drawer starts unfiltered; Full page keeps its route");
	tab.go("#job/cp-park");
	await tab.find(".job-detail .review-guide");
	assert.equal(tab.$(".sessions"), null, "the direct job URL is still the full route");
});

test("M3-jobs-css: phone bottom sheet from y96 and full-screen job; desktop 861 px surface drawer, job over the chat, a 521 px pane from 1280 px", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	const split = css.indexOf("@media(min-width:900px){.workspace-jobs-open>kbd"), wide = css.indexOf("@media(min-width:1280px){.sessions:has(>.workspace-job)");
	assert.ok(split > 0 && wide > split, "the 900 px switch, then 1280 px");
	const [phone, desktop, beside] = [css.slice(0, split), css.slice(split, wide), css.slice(wide)];
	assert.match(rule(phone, ".workspace-jobs"), /border-radius:18px 18px 0 0/, "phone: a bottom sheet with the design's 18 px radius");
	assert.match(rule(phone, ".workspace-jobs"), /height:calc\(100dvh - 96px\)/, "phone: the sheet starts at y96, as Context's does");
	assert.match(rule(phone, ".workspace-job"), /position:fixed;inset:0/, "phone: the job is full screen");
	// Full match S3: titles were `overflow-wrap:anywhere` (wrapped); every long value is now one clipped line in its cell.
	for (const cell of [".workspace-jobs-title>b", ".workspace-jobs-title>span", ".workspace-jobs-status"]) assert.match(rule(phone, cell), /overflow:hidden;text-overflow:ellipsis/, `${cell} clips at 390 px`);
	assert.match(rule(phone, ".workspace-jobs-title"), /min-width:0/, "the title column can shrink below its text");
	assert.match(rule(phone, ".workspace-jobs-list>p"), /overflow-wrap:anywhere/, "a long query echoed in the empty state wraps");
	assert.match(rule(phone, ".workspace-close"), /width:44px;height:44px/, "44 px close");
	// Full match S3: 860 px became frame 3's 861 (left border at x579), its height clear of S5's status footer.
	assert.match(rule(desktop, ".workspace-jobs"), /width:min\(861px,100%\);height:calc\(100% - var\(--workspace-status, ?0px\)\)/, "desktop: the 861 px drawer");
	assert.match(rule(desktop, ".workspace-jobs"), /background:var\(--surface\)/, "desktop: the drawer is the design's raised surface");
	assert.match(rule(desktop, ".workspace-jobs-job>code"), /overflow:hidden;text-overflow:ellipsis/, "desktop: a long id clips in the Job cell");
	assert.match(rule(desktop, ".workspace-job"), /grid-column:2/, "under 1280 px the job covers the chat column");
	assert.match(rule(beside, ".sessions:has(>.workspace-job)"), /grid-template-columns:261px minmax\(0,1fr\) 521px/, "from 1280 px a 521 px pane, border included");
	// Only an unboxed reply's code block takes the surface: ask cards and pending sends sit on it,
	// so theirs keep the page fill.
	assert.deepEqual([rule(css, ".sessions .md .md-code"), /background:var\(--background\)/.test(rule(css, ".md .md-code"))], ["", true],
		"ask and pending code blocks keep the page fill: no unscoped surface rule");
	assert.match(rule(css, ".sessions .session-other .md .md-code"), /background:var\(--surface\)/, "a reply's code block stays a visible box");
});
