/**
 * Behavior 19 (P19b): shell search, the Sessions transcript's rollups, chips, links and empty states, and the Files
 * screen, as `bin/cp-view` serves them on a scratch home: real HTTP and the served app in its linkedom tab (DOM, text
 * and served CSS only, no layout or pixels).
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { type Context, type Json, jsonl, viewer, write } from "../harness/conversations.ts";
import { type Tab, until } from "../harness/dashboard.ts";

const ledgerFile = (stateDir: string) => join(dirname(stateDir), "jobs.json");
const say = (timestamp: string, m: unknown) => JSON.stringify({ type: "message", timestamp, message: m });
const bridgeNote = (timestamp: string, content: string) => JSON.stringify({ type: "custom_message", timestamp, customType: "cp-bridge", display: true, content });
/** Records `file` as the operator session's pi transcript, as cp-bridge does. */
const record = (stateDir: string, at: string, file: string) => write(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at, session_file: file }]));
/** Lets the tab's queued renders (preact's microtask debounce) run. */
const settle = () => new Promise<void>((done) => setImmediate(done));
/**
 * Linkedom has no dialog or focus, and calls a bubbled listener with the target as `this`: the tab gets showModal/close,
 * a tracked activeElement and listeners bound to their own element; the app's code is unchanged. Restored after `t`.
 */
function browserShims(t: Context, tab: Tab) {
	const target = tab.window.EventTarget.prototype, element = tab.window.HTMLElement.prototype;
	const saved = [target, element].map((proto) => [proto, Object.getOwnPropertyDescriptors(proto)] as const);
	t.after(() => { for (const [proto, descriptors] of saved) Object.defineProperties(proto, descriptors); });
	const bound = new WeakMap<object, WeakMap<object, EventListener>>();
	const add = target.addEventListener, remove = target.removeEventListener;
	target.addEventListener = function (this: EventTarget, type: string, listener: EventListener, options?: unknown) {
		let own = bound.get(this);
		if (!own) bound.set(this, own = new WeakMap());
		if (!own.has(listener)) own.set(listener, listener.bind(this));
		add.call(this, type, own.get(listener)!, options);
	};
	target.removeEventListener = function (this: EventTarget, type: string, listener: EventListener, options?: unknown) {
		remove.call(this, type, bound.get(this)?.get(listener) ?? listener, options);
	};
	let focused: Element | null = tab.document.body;
	Object.defineProperty(tab.document, "activeElement", { configurable: true, get: () => focused });
	Object.assign(element, {
		focus(this: Element) { focused = this; },
		showModal(this: Element) { this.setAttribute("open", ""); },
		close(this: Element) { this.removeAttribute("open"); },
	});
	return () => focused;
}

// ---- search --------------------------------------------------------------------------------------------------------

test("P19-search: the shell's search lists pages, in-flight and landed jobs from /api/overview, filters, and moves by keyboard", { timeout: 120_000 }, async (t) => {
	const merged = new Date().toISOString();
	const d = await viewer(t, { seed: (stateDir) => {
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-search", project: "demo", phase: "held" }, { job_id: "cp-wait", project: "demo", phase: "waiting" }, { job_id: "cp-landed", project: "demo", phase: "done", closed_at: merged }] });
		const job = (id: string, title: string, status: string) => ({ id, title, status, labels: ["project:demo", "kind:ship"] });
		write(ledgerFile(stateDir), { jobs: [job("cp-search", "Repair <script>queue</script>", "in_progress"), job("cp-wait", "Parked work", "in_progress"), job("cp-landed", "Landed work", "closed")] });
		write(join(stateDir, "runs/cp-landed/merge.json"), { job_id: "cp-landed", pr_url: "https://github.com/acme/repo/pull/80", merge_commit_sha: "a".repeat(40), merged_at: merged });
	} });
	const tab = await d.open("#jobs", /^\/api\/overview$/);
	const focused = browserShims(t, tab);
	const overview = () => tab.requests.filter((r) => r.path === "/api/overview").length;
	const results = () => tab.$$("dialog a");
	const query = async (value: string) => { tab.type(tab.$("dialog input")!, value); await settle(); };
	const hrefs = () => results().map((a) => a.getAttribute("href"));
	let trigger = await tab.find(".shell-search");
	assert.equal(tab.$("dialog"), null, "closed search does not render");
	tab.click(trigger);
	await tab.find("dialog[open]");
	assert.equal(focused(), tab.$("dialog input"), "header search opens a modal dialog with its input focused");
	assert.match(tab.$("dialog")!.textContent!, /Loading/);
	tab.go("#decisions");
	await until(() => tab.$("dialog"), (open) => open === null, "leaving the page to unmount the held search");
	const stale = await tab.find(".shell-search");
	tab.go("#jobs");
	trigger = (await until(() => tab.$(".shell-search"), (el) => !!el && el !== stale, "the Jobs shell to mount again"))!;
	tab.click(trigger);
	await tab.find("dialog[open]");
	tab.click(tab.$('dialog button[aria-label="Close search"]')!);
	await until(() => tab.$("dialog"), (open) => open === null, "the held search to close");
	tab.click(tab.$(".shell-desktop-search")!);
	(await tab.find("dialog[open]")).dispatchEvent(new tab.window.Event("cancel", { cancelable: true }));
	await until(() => tab.$("dialog"), (open) => open === null, "the held search to cancel");
	tab.click(trigger);
	await tab.find("dialog[open]");
	tab.release();
	await settle();
	assert.match(tab.$("dialog")!.textContent!, /Loading/, "late data from a closed dialog cannot appear in a new search");
	assert.doesNotMatch(tab.$("dialog")!.textContent!, /unavailable/, "nor can a closed dialog's aborted read");
	await tab.waitText(/Recently landed/);
	assert.equal(overview(), 1, "close, cancel and unmount abort their held reads: only the open dialog's read is sent");
	assert.equal(results().length, 15, "audit P4 #28: 12 pages, two in-flight jobs and one landed");
	assert.deepEqual(tab.$$("dialog h2").map((h) => h.textContent), ["Go to", "In flight", "Recently landed"]);
	assert.deepEqual(tab.$$(".search-shortcuts .search-items a").map((a) => a.getAttribute("href")), ["#overview", "#decisions", "#jobs", "#board", "#map", "#sessions", "#stats", "#reports", "#schedules", "#files", "#settings", "#more"], "design shortcut order retains every destination, including More");
	assert.deepEqual([tab.$("dialog input")!.getAttribute("placeholder"), tab.$("dialog input")!.getAttribute("aria-label")], ["Job ID, title or page", "Search job IDs, titles and pages"]);
	for (const [id, phase] of [["cp-search", "held"], ["cp-wait", "waiting"], ["cp-landed", "done"]]) {
		const hit = results().find((a) => a.getAttribute("href") === `#job/${id}`)!;
		assert.deepEqual([!!hit.querySelector(`.job-dot-${phase}[aria-hidden="true"]`), hit.querySelector("svg")], [true, null], `${id} uses its phase dot, never a navigation icon`);
	}
	assert.ok(tab.$(".search-shortcuts a svg"), "page shortcuts retain their navigation icons");
	const meta = (id: string) => results().find((a) => a.getAttribute("href") === `#job/${id}`)!.textContent!;
	assert.deepEqual([meta("cp-search"), meta("cp-wait"), meta("cp-landed")].map((text) => /cp-\w+ · .*/.exec(text)?.[0]), ["cp-search · held", "cp-wait · no run status", "cp-landed · #80 merged"]);
	assert.deepEqual([tab.$(".search-hint")!.getAttribute("aria-hidden"), tab.$(".search-hint")!.textContent], ["true", "↑ ↓ move · ↵ open · esc close"]);
	assert.ok(meta("cp-search").includes("Repair <script>queue</script>") && !tab.$("dialog script"), "job titles render as text");

	await query("  QUEUE  ");
	assert.deepEqual(hrefs(), ["#job/cp-search"]);
	await query("CP-LANDED");
	assert.deepEqual(hrefs(), ["#job/cp-landed"]);
	for (const unsupported of ["md-live", "#80", "awaiting", "decided"]) { await query(unsupported); assert.equal(results().length, 0, `no hit for ${unsupported}`); }
	for (const page of ["files", "decisions", "sessions"]) { await query(page); assert.deepEqual(hrefs(), [`#${page}`]); }
	await query("no match");
	assert.match(tab.$("dialog")!.textContent!, /No results/);
	await query("");
	tab.key(tab.$("dialog input")!, "ArrowDown");
	assert.equal(focused(), results()[0]);
	tab.key(focused()!, "ArrowDown");
	assert.equal(focused(), results()[1]);
	tab.key(focused()!, "ArrowUp");
	assert.equal(focused(), results()[0], "arrows move through the results");
	tab.click(tab.$('dialog button[aria-label="Close search"]')!);
	await until(() => tab.$("dialog"), (dialog) => dialog === null, "the dialog to close");
	assert.equal(focused(), trigger, "closing returns focus to its opener");

	const desktop = tab.$(".shell-desktop-search")!;
	tab.click(desktop);
	const dialog = await tab.find("dialog[open]");
	dialog.dispatchEvent(new tab.window.Event("cancel", { cancelable: true }));
	await until(() => tab.$("dialog"), (open) => open === null, "Escape's cancel to close");
	assert.equal(focused(), desktop, "the desktop trigger gets its own focus back");
	for (const modifier of ["ctrlKey", "metaKey"]) {
		const shortcut = new tab.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(shortcut, { key: "k", [modifier]: true });
		tab.window.dispatchEvent(shortcut);
		await tab.find("dialog[open]");
		await tab.waitText(/Recently landed/);
		await query("jobs");
		let followed: string | null = null;
		const first = tab.$("dialog a")!;
		first.addEventListener("click", () => { followed = first.getAttribute("href"); });
		tab.key(tab.$("dialog input")!, "Enter");
		await until(() => tab.$("dialog"), (open) => open === null, `${modifier}+K's Enter to open the first hit`);
		assert.equal(followed, "#jobs", `${modifier}+K, then Enter clicks the first hit and closes`);
	}

	write(join(d.stateDir, "fleet.json"), "{broken");
	tab.click(trigger);
	await tab.waitText(/In-flight jobs unavailable/);
	assert.equal(results().length, 12, "navigation remains usable when the fleet is unreadable");
	for (const screen of ["#board", "#map", "#decisions", "#files", "#job/cp-search"]) {
		tab.go(screen);
		assert.ok(await tab.find(".shell-search"), `search remains available on ${screen}`);
	}
});

// ---- Sessions: relay rollups and PR chips --------------------------------------------------------------------------

const local = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
const AT = local(15, 9);
const PR = "https://github.com/o/picp/pull/355", PR2 = "https://github.com/o/picp/pull/356";
const wake = (job: string | null, text: string, at = AT) => bridgeNote(at, `[cp-bridge wake${job ? ` job=${job}` : ""}]\n${text}`);
const relay = (text: string, at = AT) => say(at, { role: "assistant", content: [{ type: "text", text }] });
const operator = (text: string, at = AT) => say(at, { role: "user", content: [{ type: "text", text }] });
const bash = (id: string) => [
	say(AT, { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] }),
	say(AT, { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }] }),
];

/** A viewer whose recorded operator transcript is `lines`; cp-a (project picp) holds #355 and #356 as its PR receipts. */
async function transcript(t: Context, lines: string[], seed?: (stateDir: string) => void) {
	return viewer(t, { seed: (stateDir, home) => {
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-a", project: "picp", phase: "held", receipts: [{ kind: "pr", url: PR }, { kind: "pr", url: PR2 }] }] });
		const file = join(home, "pi-sessions", "session.jsonl");
		write(file, `${lines.join("\n")}\n`);
		record(stateDir, AT, file);
		seed?.(stateDir);
	} });
}
const FULL = "#sessions?view=you&transcript=1";
/** The minified stylesheet the served page links. */
const servedCss = async (d: { get(path: string): Promise<{ text: string }> }) => (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;

test("P19-rollup-fold: relay turns about one PR or job fold; another subject, an operator message, a day or no subject never do", { timeout: 120_000 }, async (t) => {
	const d = await transcript(t, [
		wake("cp-b", "A woke 1"), ...bash("call-a"), relay("A relay 1"), wake("cp-b", "A woke 2"), relay("A relay 2"),
		operator("break one"),
		wake("cp-b", "C1 woke"), relay("C relay 1"), wake("cp-c", "C2 woke"), relay("C relay 2"), wake("cp-b", "C3 woke"), relay("C relay 3"),
		wake("cp-d", "D woke 1"), relay("D relay 1"), operator("ok"), wake("cp-d", "D woke 2"), relay("D relay 2"),
		wake(null, "H woke 1"), relay("H relay 1"), wake(null, "H woke 2"), relay("H relay 2"),
		operator("break two"),
		wake("cp-a", "I woke 1"), relay(`I relay 1: ${PR} and ${PR2}`), wake("cp-a", "I woke 2"), relay(`I relay 2: ${PR2}, ${PR}`),
		operator("break three"),
		wake("cp-e", "E woke 1", local(15, 23)), relay("E relay 1", local(15, 23)), wake("cp-e", "E woke 2", local(16, 1)), relay("E relay 2", local(16, 1)),
		wake("cp-f", "F woke"), relay("F single turn", local(16, 2)),
		wake("cp-g", "G woke 1", local(16, 22)), relay("G relay 1", local(16, 22)), wake("cp-g", "G woke 2", local(16, 23)), relay("G relay 2", local(17, 0)),
	]);
	const tab = await d.open(FULL);
	await tab.waitText(/G relay 2/);
	const cards = tab.$$(".session-rollup").map((card) => card.textContent ?? "");
	assert.equal(cards.length, 2, "only the cp-b pair and the cp-a pair fold");
	assert.ok(cards[0]!.includes("A relay 2") && !cards[0]!.includes("A relay 1"), "(a) a wake with steps heads its turn: the latest relay shows");
	assert.match(tab.$$(".session-rollup-meta")[0]!.textContent ?? "", /cp-b·1 earlier/, "(a) the turn with steps is the one earlier");
	assert.ok(cards[1]!.includes("I relay 2") && !cards[1]!.includes("I relay 1"), "(i) two PRs named: the job key folds");
	const folded = cards.join("\n");
	for (const alone of ["C relay", "D relay", "H relay", "E relay", "F single turn"]) assert.ok(!folded.includes(alone) && tab.text().includes(alone), `(c, d, h, e, f) ${alone} stays its own row`);
	assert.ok(!folded.includes("G relay") && tab.text().includes("G relay 1"), "(e) a day starting at the later turn's relay, not its wake, folds nothing");
});

const turns = [wake("cp-a", "first woke"), relay(`first update on ${PR}`), wake("cp-a", "second woke"), relay(`second update on ${PR}`), wake(null, "HELD PR LANDED"), relay(`latest update: ${PR} merged`)];

test("P19-rollup-card: one card shows the latest relay and its chip under one meta line; a toggle opens the rest; Tools on folds nothing", { timeout: 120_000 }, async (t) => {
	const d = await transcript(t, turns);
	const tab = await d.open(FULL);
	const card = await tab.find(".session-rollup");
	assert.equal(tab.$$(".session-rollup").length, 1, "(j) one card");
	assert.match(card.textContent!, /latest update/);
	assert.doesNotMatch(card.textContent!, /first update|second update|HELD PR LANDED/, "earlier turns and the latest notice are hidden");
	assert.equal(card.querySelector(".session-rollup-head"), null, "(b) the latest relay chips #355, so the card has no header chip");
	assert.deepEqual([card.querySelectorAll("a.pr-chip").length, !!card.querySelector(".session-bubble a.pr-chip")], [1, true], "(b) the inline chip shows once");
	const meta = card.querySelectorAll(".session-rollup-meta");
	const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(AT));
	assert.deepEqual([meta.length, meta[0]!.textContent], [1, `${time}·cp-a·2 earlier · 1 notice ▸`], "(a) time · job · earlier · notice");
	assert.match(meta[0]!.querySelector("a.session-rollup-job")?.getAttribute("href") ?? "", /cp-a/, "the job links its transcript");
	assert.equal(card.querySelectorAll(".session-bridge").length, 0, "(a) no notice row of its own");
	const toggle = meta[0]!.querySelector("button.session-rollup-toggle")!;
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	tab.click(toggle);
	await until(() => tab.$("button.session-rollup-toggle")?.getAttribute("aria-expanded"), (open) => open === "true", "the toggle to open");
	const text = tab.$(".session-rollup")!.textContent!;
	const at = (word: string) => text.indexOf(word);
	assert.ok(at("first update") >= 0 && at("first update") < at("second update") && at("second update") < at("HELD PR LANDED") && at("HELD PR LANDED") < at("latest update"), "(e) one tap opens earlier turns and the latest notice above the latest relay, in order");

	tab.storage.set("cp-sessions-tool-calls", "1");
	const tools = await tab.reopen();
	await tools.waitText(/first update/);
	assert.equal(tools.$$(".session-rollup").length, 0, "(k) Tools on forms no rollup");
});

test("P19-rollup-chips: the header chip stays when the latest relay names no PR; a notice chips a PR like the turn card; quick replies keep their anchor", { timeout: 120_000 }, async (t) => {
	const head = "e".repeat(40);
	const quiet = await transcript(t, [wake("cp-a", "first woke"), relay("first update"), wake("cp-a", "second woke"), relay("second update")]);
	const tab = await quiet.open(FULL);
	assert.match((await tab.find(".session-rollup .session-rollup-head a.pr-chip")).textContent ?? "", /#355/, "(b) the header chip when the body has none");
	assert.equal(tab.$$(".session-rollup a.pr-chip").length, 1);
	const lone = await transcript(t, [wake("cp-a", "first woke"), relay("first update")]);
	const single = await lone.open(FULL);
	await single.waitText(/first update/);
	assert.equal(single.$$(".session-rollup, .session-rollup-meta").length, 0, "(c) a lone turn: no card, no meta line");

	// Operator report: a notice's chip read "#381draftCI greenreview pass" as bare underlined text with a stray bar,
	// because the chip's pill rule was scoped to Markdown bubbles only.
	const chipped = await transcript(t, [wake("cp-a", `CI GREEN — cp-a: review attempt 2 started on ${PR}`), relay(`turn card: ${PR}`)], (stateDir) => {
		write(join(stateDir, "runs/cp-a/envelope.json"), { envelope: { head_sha: head } });
		write(join(stateDir, "ci-watch.json"), { jobs: [{ job_id: "cp-a", head_sha: head, last_ci: "green" }] });
		write(join(stateDir, "runs/cp-a/review-1.json"), { verdict: "pass", head_sha: head, diff_stat: { truncated: false } });
	});
	const chips = await chipped.open(FULL);
	const notice = await chips.find(".session-bridge a.pr-chip"), card = await chips.find(".session-bubble a.pr-chip");
	const parts = (a: Element) => [...a.children].map((c) => [c.className, c.textContent]);
	assert.deepEqual(parts(notice), [["pr-chip-dot", ""], ["pr-chip-num", "#355"], ["pr-chip-state", "draft"], ["pr-chip-ci pr-chip-ci-green", "CI green"], ["pr-chip-review pr-chip-review-pass", "review pass"]], "(a) the notice's chip");
	assert.deepEqual([notice.className, parts(notice)], [card.className, parts(card)], "(a) the turn card's chip, class for class");
	assert.equal(notice.textContent, "#355 draft CI green review pass", "(b) separated, never #355draft");
	const rule = /(?:^|\})([^{}]*a\.pr-chip)\{display:inline-flex[;}]/.exec(await servedCss(chipped))?.[1];
	assert.ok(rule && notice.matches(rule) && card.matches(rule), `(a) the served pill rule reaches the notice row: ${rule}`);

	const asked = await transcript(t, turns, (stateDir) => write(join(stateDir, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-aaaa", project: "picp", question: "Merge?", created_at: local(15, 8), recommendation: "Merge", options: [{ label: "Merge", consequence: "Lands" }] }])));
	const replies = await asked.open(FULL);
	const anchor = await replies.find(".session-entries > .session-replies");
	assert.equal(replies.$$(".session-rollup").length, 1, "(l) the turns before the anchor's still fold");
	assert.match(anchor.previousElementSibling?.textContent ?? "", /latest update/, "(g) replies follow the anchor's own turn");
	assert.doesNotMatch(replies.$(".session-rollup")!.textContent!, /latest update/, "(g) the anchor's turn stays out of the card");
});

// ---- Sessions and Files: empty, awaiting, failed and confined states --------------------------------------------

test("P19-sessions-render: the operator helper, project and bridge chips, the ⋮ file picker and worker run phases", { timeout: 120_000 }, async (t) => {
	const stamped = "2026-09-27T08:24:05Z";
	const d = await viewer(t, { seed: (stateDir, home) => {
		const job = (job_id: string, phase: string) => ({ job_id, project: "picp", phase });
		write(join(stateDir, "fleet.json"), { jobs: [job("cp-run", "waiting"), job("cp-idle", "held"), job("cp-gone", "failed"), job("cp-new", "waiting")] });
		for (const [id, phase] of [["cp-run", "working"], ["cp-idle", "idle"], ["cp-gone", "exited"]] as const) write(join(stateDir, "runs", id, "status.json"), { phase, model: "m" });
		write(join(stateDir, "runs/cp-new/status.json"), { model: "m" });
		write(join(home, LAYOUT.projects, "picp", "README.md"), "x\n");
	} });
	const empty = await d.open("#sessions?view=you&transcript=0");
	const text = await empty.waitText(/Trace a decision/);
	assert.match(text, /No recorded entries/);
	assert.match(text, /Operator ↔ you/);
	for (const view of ["view=parent", "view=workers&id=cp-run"]) {
		const other = await d.open(`#sessions?${view}`);
		await other.find(".session-entries, .session-empty");
		assert.doesNotMatch(other.text(), /Trace a decision|entry for entry/, `no operator helper on ${view}`);
	}

	const css = await servedCss(d), desktop = css.search(/\.session-heading\{[^}]*min-height:48px;[^}]*padding:0 84px 0 16px/);
	assert.ok(desktop > 0 && css.slice(css.lastIndexOf("@media", desktop)).startsWith("@media(min-width:900px)"), "the heading's 84px clearance is desktop only");
	assert.match(css.slice(0, desktop), /\.session-heading\{display:none;padding:0 16px 12px[;}]/, "audit P2 #15: the phone heading keeps its own 16px padding");
	assert.match(css, /\.sessions \.page-header-end>\.shell-live\{font-size:0\}/, "only the status dot sits in the 84px, never a word over Tools N");
	assert.doesNotMatch(css, /\.session-heading\{[^}]*136px/, "the corner clock is gone, so the heading no longer dodges it");
	assert.doesNotMatch(css, /\.session-tools-toggle[^{]*\{[^}]*display:none/, "the tool-call toggle is never display:none, including at 1440");

	const file = join(d.home, "pi-sessions", "newest.jsonl");
	write(file, `${[say(stamped, { role: "assistant", content: [{ type: "text", text: "[picp] landed" }] }), bridgeNote(stamped, "[cp-bridge wake job=cp-x receipt=owner_observed]\nMobile chat landed.\nSecond line."),
		say(stamped, { role: "assistant", content: [], errorMessage: "Delivery failed" }), say("", { role: "assistant", content: [{ type: "text", text: "untimed reply" }] })].join("\n")}\n`);
	record(d.stateDir, stamped, file);
	const full = await d.open("#sessions?view=you&transcript=1");
	assert.equal((await full.find(".session-project")).textContent, "picp", "a [project] prefix becomes the project chip");
	assert.ok(full.$$(".session-message").some((m) => m.textContent?.includes("landed") && !m.textContent.includes("[picp]")), "and leaves the text");
	assert.equal(full.$(".session-bridge-chip")?.textContent, "bridge");
	assert.deepEqual([full.$(".session-bridge-what")?.textContent, full.$(".session-bridge-what a")?.getAttribute("href"), full.$(".session-bridge-receipt")?.textContent], ["woke cp-x", "#job/cp-x", "· owner observed"]);
	assert.ok(full.$$(".session-message").some((m) => m.textContent?.includes("Delivery failed")), "a failed entry renders its error");
	assert.match(full.text(), /untimed reply/, "an untimestamped transcript entry still renders");
	const line = full.$("button.session-notice-line")!;
	assert.deepEqual([line.getAttribute("aria-expanded"), line.getAttribute("aria-label")], ["false", "Show notice"]);
	assert.doesNotMatch(full.text(), /Second line/, "a collapsed notice shows its first line only");
	assert.equal(full.$(".sessions > .page-header > h1")?.textContent, "Chats", "the desktop title row stays inside the direct-child screen");
	assert.equal(full.$('.session-choice[aria-current="page"] strong')?.textContent, "Operator");
	assert.equal(full.$(".shell-more .session-menu label")?.firstChild?.textContent, "Transcript", "amendment 2: the file picker sits in the ⋮ menu");
	assert.equal(full.$('.session-heading select[aria-label="Operator session file"]'), null, "the heading keeps only the filter pill");
	assert.doesNotMatch(full.$(".session-heading")?.textContent ?? "", /entry for entry|Full transcript/);

	const fleet = await d.open("#sessions?view=workers&id=cp-run");
	await fleet.waitText(/Fleet · 2 live/);
	assert.ok(fleet.$(".session-dot-working") && fleet.$(".session-dot-held") && !fleet.$(".session-dot-waiting"), "audit P2 #14: held-idle is live; a running worker shows its run phase");
	assert.ok(fleet.$$("small.session-model").some((s) => s.textContent === "m · working"), "S8: the short model with the observed run phase");
	assert.doesNotMatch(fleet.text(), /waiting · m/);
	assert.deepEqual(fleet.$$("nav.session-bar-views .session-bar-worker small").map((s) => s.textContent), ["working", "idle", "no run status", "exited"], "an unknown run phase reads 'no run status', never 'waiting'");
});

test("P19-render-states: an awaiting ask's markup is text, its untimestamped trace hidden; Files' empty, escaped, oversized and binary states", { timeout: 120_000 }, async (t) => {
	const decided = { kind: "policy", status: "answered", answer: "approve", answered_by: "operator-delegated", answered_at: "2026-09-26T10:05:00Z" };
	const d = await viewer(t, { seed: (stateDir) => {
		write(join(stateDir, "escalations.json"), { items: [{ id: "es-abcd", question: "Recorded question", created_at: "2026-09-26T09:59:00Z", ...decided }] });
		const ask = (id: string, question: string) => ({ type: "open", id, project: "demo", question, created_at: "2026-09-26T10:00:00Z", recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] });
		write(join(stateDir, "operator/asks.jsonl"), jsonl([ask("ask-ab", "<script>question</script>"), ask("ask-cd", "Second question")]));
	} });
	const asks = await d.open("#sessions?view=you&transcript=0");
	const text = await asks.waitText(/parent asked/);
	assert.match(text, /awaiting you/);
	assert.ok(text.includes("<script>question</script>") && !asks.$(".sessions script, .sessions [style], .sessions [onclick]"), "a question's markup is text");
	assert.equal(text.match(/parent asked/g)?.length, 1, "the decision's timestamped trace step shows");
	write(join(d.stateDir, "escalations.json"), { items: [{ id: "es-abcd", question: "Recorded question", created_at: "2026-09-26T09:59:00Z", ...decided }, { id: "es-cdef", question: "Untimed question", ...decided }] });
	const untimed = await (await d.open("#sessions?view=you&transcript=0")).waitText(/escalations unavailable/);
	assert.doesNotMatch(untimed, /Untimed question|parent asked/, "an escalation without created_at is refused, so no untimestamped trace step renders");

	const files = await d.open("#files");
	await files.waitText(/No projects/);
	assert.match(files.text(), /Live worktrees · 0/);
	assert.match(files.text(), /No live worktrees/);
	const repo = join(d.home, LAYOUT.projects, "demo");
	write(join(repo, "unsafe.html"), "<script>unsafe</script>");
	write(join(repo, "big.txt"), "x".repeat(600_000));
	write(join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
	const file = async (path: string) => { const tab = await d.open(`#files?root=project%3Ademo&path=${path}`); await tab.find(".file-text, section[aria-labelledby=file-listing] .files-empty"); return tab; };
	const unsafe = await file("unsafe.html");
	assert.equal(unsafe.$(".file-text")?.textContent, "<script>unsafe</script>", "file text renders as text");
	assert.equal(unsafe.$("main script, .file-text script"), null);
	assert.ok(unsafe.$('a[href^="#files?root=project%3Ademo"]'), "the listing heading links back to its root");
	assert.equal(unsafe.$('a[href*="/api/git"], a[href*="/classic"], .file-git'), null, "no raw-JSON git link and no classic view");
	assert.match((await file("big.txt")).text(), /File exceeds the 512 KiB cap/);
	assert.match((await file("bin.dat")).text(), /Binary file · 3 bytes/);
});

// ---- copy reply ----------------------------------------------------------------------------------------------------

test("P19-copy-reply: a job's awaiting ask copies its exact reply, falls back to manual selection, and disables while copying", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed: (stateDir) => {
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-copy", project: "demo", phase: "held" }] });
		write(ledgerFile(stateDir), { jobs: [{ id: "cp-copy", title: "Copy work", status: "in_progress", labels: ["project:demo", "kind:ship"] }] });
		write(join(stateDir, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-aa", project: "demo", question: "Raise cap?", created_at: new Date().toISOString(), recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }], job_ids: ["cp-copy"] }]));
	} });
	const tab = await d.open("#job/cp-copy");
	const button = () => tab.$('button[aria-label="Copy reply for the operator chat"]')!;
	const status = () => tab.$(".overview-copy-status")!.textContent;
	const navigator = tab.navigator;
	await tab.find('button[aria-label="Copy reply for the operator chat"]');
	assert.equal(tab.$(".overview-reply code")?.textContent, "ask-aa: Keep");

	const copied: string[] = [];
	navigator.clipboard = { writeText: async (text: string) => void copied.push(text) };
	const clicked = Date.now();
	tab.click(button());
	await tab.waitText(/Copied/);
	assert.deepEqual(copied, ["ask-aa: Keep"], "success writes the exact reply");
	await until(() => button().textContent, (label) => label === "Copy", "the feedback timer to reset");
	const held = Date.now() - clicked; // a lower bound on the feedback, not a wait: a slow runner only lengthens it
	assert.ok(held >= 1_500, "the feedback holds while its 1600 ms timer runs");

	const focused = browserShims(t, tab);
	for (const clipboard of [{ writeText: async () => { throw new Error("denied"); } }, undefined]) {
		let selected: unknown = null;
		const range = { selectNodeContents: (node: unknown) => { selected = node; } };
		Object.assign(tab.document, { createRange: () => range });
		Object.assign(tab.window, { getSelection: () => ({ removeAllRanges() {}, addRange(value: unknown) { assert.equal(value, range); } }) });
		navigator.clipboard = clipboard;
		tab.click(button());
		await until(status, (text) => /Clipboard unavailable/.test(text ?? ""), "the manual-copy fallback");
		const code = tab.$(".overview-reply code");
		assert.deepEqual([selected, focused()], [code, code], `${clipboard ? "a denial" : "no clipboard API (plain HTTP)"} selects and focuses the reply`);
		assert.doesNotMatch(button().textContent!, /Copied/, "never claims success");
	}

	let resolve!: () => void;
	navigator.clipboard = { writeText: () => new Promise<void>((done) => { resolve = done; }) };
	tab.click(button());
	await settle();
	assert.equal(button().hasAttribute("disabled"), true, "copying disables the button");
	resolve();
});

// ---- skills and links in the operator transcript ------------------------------------------------------------------

test("P19-skills: a dashboard message's [cp-skill] lines become chips and leave its text; any other message keeps them", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-27T08:20:00Z";
	const user = (text: string) => say(at, { role: "user", content: [{ type: "text", text }] });
	const d = await viewer(t, { seed: (stateDir, home) => {
		const file = join(home, "pi-sessions", "session.jsonl");
		write(file, `${[
			user("dispatch with @tdd-x and @lint-y\n\n[cp-skill tdd-x /skills/tdd-x]\n[cp-skill lint-y /skills/lint-y]\n\n[cp-dashboard dc-20260927082500-0123abcd — from the dashboard]"),
			user("plain dashboard words\n\n[cp-dashboard dc-20260927082600-4567cdef — from the dashboard]"),
			user("from the CLI\n\n[cp-skill tdd-x /skills/tdd-x]"),
		].join("\n")}\n`);
		record(stateDir, at, file);
	} });
	const [skilled, plain, cli] = ((await d.get("/api/sessions?view=you&transcript=1")).body as Json).entries as [Json, Json, Json];
	assert.deepEqual([skilled.tag, skilled.text, skilled.skills], ["dashboard", "dispatch with @tdd-x and @lint-y", ["tdd-x", "lint-y"]]);
	assert.deepEqual([plain.text, plain.skills], ["plain dashboard words", undefined], "no lines, no skills key");
	assert.equal(cli.skills, undefined);
	assert.match(cli.text, /\[cp-skill tdd-x \/skills\/tdd-x\]/, "only dashboard-tagged messages get chips");
});

test("P19-links: transcript URLs, .pi-command-post paths and #N refs render as links only where the server resolved them", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-27T08:20:00Z", pr = "https://github.com/o/r/pull/355";
	let artifact = "";
	const d = await viewer(t, { seed: (stateDir, home) => {
		write(join(dirname(stateDir), "data", "projects.json"), { projects: [{ name: "picp", clone_url: "https://github.com/o/r.git" }] });
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-a", project: "picp", phase: "held", receipts: [{ kind: "pr", url: pr }] }] });
		write(artifact = join(stateDir, "runs/cp-a/artifact.md"), "# report\n");
		const file = join(home, "pi-sessions", "session.jsonl"), gone = join(dirname(stateDir), "gone.md");
		write(file, `${[
			relay(`Done: http://x.io/pr/7. a https://x.io/b, c; https://x.io/d: (see https://x.io/p) https://en.wikipedia.org/wiki/Foo_(bar). [the PR](https://github.com/o/r/pull/9) landed`, at),
			relay("unsafe: javascript:alert(1) [x](javascript:alert(1)) data:text/html,hi [y](data:text/html,hi) ftp://x.io/a https:// <b>x</b> src/viewer/a.ts /etc/passwd", at),
			relay(`wrote \`${artifact}\`. and ${gone}`, at),
			wake("cp-a", "PR #355 (and #12), not #0, x#9, https://x.io/a#3, &#39; or ##7\nsecond line", at),
			relay("see #355", at),
			bridgeNote(at, "PR https://github.com/o/r/pull/9 landed\nsecond line"),
		].join("\n")}\n`);
		record(stateDir, at, file);
	} });
	const tab = await d.open("#sessions?view=you&transcript=1");
	await tab.waitText(/see #355/);
	const anchors = (text: RegExp) => tab.$$(".session-message").find((m) => text.test(m.textContent ?? ""))!.querySelectorAll("a");
	const links = (text: RegExp) => [...anchors(text)].map((a) => [a.textContent, a.getAttribute("href")]);
	assert.deepEqual(links(/Done:/), [["http://x.io/pr/7", "http://x.io/pr/7"], ["https://x.io/b", "https://x.io/b"], ["https://x.io/d", "https://x.io/d"], ["https://x.io/p", "https://x.io/p"],
		["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"], ["the PR", "https://github.com/o/r/pull/9"]], "trailing punctuation and wrapping parens stay outside; a balanced paren and a markdown label stay in");
	assert.ok([...anchors(/Done:/)].every((a) => a.getAttribute("target") === "_blank" && a.getAttribute("rel") === "noopener noreferrer"), "external links open apart");
	assert.match(tab.text(), /http:\/\/x\.io\/pr\/7\. a /);
	assert.deepEqual(links(/unsafe:/), [], "unsafe schemes, a bare scheme and paths outside .pi-command-post stay plain text");
	assert.ok(tab.text().includes("<b>x</b>") && !tab.$(".session-message b"), "markup stays text");
	const local = links(/wrote/);
	assert.equal(local.length, 1, "an unresolved path stays text");
	assert.equal(local[0]![0], artifact);
	assert.match(String(local[0]![1]), /^#/, "a resolved path goes to the viewer");
	assert.equal(anchors(/wrote/)[0]!.parentElement?.tagName, "CODE", "a code span keeps its link inside");
	tab.click(tab.$("button.session-notice-line")!);
	await tab.find(".session-bridge p a");
	assert.deepEqual(links(/#12/).filter(([text]) => text?.startsWith("#")), [["#355 draft", pr], ["#12", "https://github.com/o/r/issues/12"]], "#N refs resolve through the job's repo (#355 as its PR chip); anchors, entities and ## never do");
	const plain = () => tab.$$(".session-bridge").find((n) => /landed/.test(n.textContent ?? ""))!;
	assert.equal(plain().querySelector("a[target=_blank]"), null, "collapsed, a plain notice's first line is the button's label");
	tab.click(plain().querySelector("button.session-notice-line")!);
	await until(() => plain().querySelector("p a"), Boolean, "the opened notice's link");
	assert.deepEqual([plain().querySelector("p a")!.getAttribute("href"), plain().querySelector("p a")!.getAttribute("rel")], ["https://github.com/o/r/pull/9", "noopener noreferrer"], "open, its first line is text, so its URL is a link");
	const toggle = plain().querySelector(".session-notice-line")!;
	assert.deepEqual([toggle.tagName, toggle.getAttribute("aria-expanded"), toggle.textContent], ["BUTTON", "true", "1 more line"], "the toggle stays a button, showing only its count");
	assert.deepEqual(links(/see #355$/), [], "no resolved repo, no #N link");
});

test("P19-route: #sessions opens the Full transcript; transcript=0 is Decisions; a refused default falls back silently; a draft stays in the hash", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const requested = async (v: { open(hash: string): Promise<Tab> }, hash: string, count = 1) => {
		const tab = await v.open(hash);
		await until(() => tab.requests.filter((r) => r.path.startsWith("/api/sessions")).length, (n) => n >= count, `${hash}'s data requests`);
		await settle();
		return { tab, paths: tab.requests.filter((r) => r.path.startsWith("/api/sessions")).map((r) => r.path) };
	};
	for (const hash of ["#sessions", "#sessions?view=you", "#sessions?view=you&transcript=1"]) assert.deepEqual((await requested(d, hash)).paths, ["/api/sessions?view=you&transcript=1"], `${hash} asks for the Full transcript`);
	assert.deepEqual((await requested(d, "#sessions?view=you&transcript=0")).paths, ["/api/sessions?view=you&transcript=0"], "an explicit transcript=0 asks for Decisions");
	assert.deepEqual((await requested(d, "#sessions?view=parent")).paths, ["/api/sessions?view=parent"], "other tiers are untouched");
	const draft = await requested(d, `#sessions?${new URLSearchParams({ view: "you", transcript: "1", draft: "a b?c" })}`);
	assert.deepEqual(draft.paths, ["/api/sessions?view=you&transcript=1"], "cp-hhuf P6: the composer's draft never reaches the API");

	const plain = await viewer(t, { requireTailnet: false });
	const fallback = await requested(plain, "#sessions", 2);
	assert.deepEqual(fallback.paths, ["/api/sessions?view=you&transcript=1", "/api/sessions?view=you&transcript=0"], "one refused default, then Decisions");
	assert.deepEqual(fallback.tab.requests.filter((r) => r.path.startsWith("/api/sessions")).map((r) => r.status), [403, 200]);
	assert.doesNotMatch(fallback.tab.text(), /Refresh failed/, "the fallback is silent");
	assert.equal(fallback.tab.$$('a[href*="transcript="], .session-views').length, 0, "audit P4 #27: no Decisions | Full transcript toggle");
});
