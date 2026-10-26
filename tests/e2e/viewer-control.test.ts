/**
 * Behavior 17 (P17a): the dashboard's Decisions page — Awaiting, Being handled, Answers and the Decided log — as
 * `bin/cp-view` serves it on a scratch home: its HTTP routes, and the served app run in a tab (tests/harness/dashboard)
 * whose clicks reach the viewer and, for a decision card, the operator session's own dashboard-control server.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { appendAnswerLine } from "../../src/viewer/control-audit.ts";
import { controlConfigFile, controlInboxFile, controlJournalFile, operatorAnswersFile } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { dashboard, operatorSession, type Reply, type Tab, until } from "../harness/dashboard.ts";

type Json = Record<string, any>;
const UTC = { TZ: "UTC" };
const write = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const pick = (row: Json, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));

const AT = "2026-09-26T11:00:00Z";
const ask = (id: string, extra: Json = {}) => ({ type: "open", id, created_at: AT, project: "demo", question: "Keep paused?", options: [{ label: "Keep", consequence: "Work stays paused" }], recommendation: "Keep", source_escalation: "es-open", job_ids: ["cp-demo"], ...extra });
const escalation = (id: string, extra: Json = {}) => ({ id, created_at: AT, question: "Proceed?", status: "answered", answered_at: AT, answered_by: "operator-delegated", answer: "yes", kind: "plan_approval", job_ids: ["cp-demo"], options: [{ id: "yes", label: "Proceed" }], ...extra });

test("P17-awaiting: /api/awaiting folds open asks with their provenance, caps, context, jobs and evidence; unreadable sources stay distinguishable", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t, { at: "2026-09-26T12:00:00Z", env: UTC });
	const put = (file: string, value: unknown) => write(join(d.stateDir, file), value);
	const awaiting = async (at = "2026-09-26T12:00:00Z") => (d.pin(at), (await d.get("/api/awaiting")).body as Json);
	const decided = async () => (d.pin("2026-09-26T12:00:00Z"), (await d.get("/api/decided")).body as Json);

	assert.equal((await awaiting()).availability.asks, "missing");
	put("operator/asks.jsonl", `${JSON.stringify(ask("ask-aa"))}\n{"type":`);
	assert.equal((await awaiting()).awaiting_count, 1, "a partial final line does not hide complete records");
	put("operator/asks.jsonl", "bad\n");
	assert.equal((await awaiting()).awaiting_count, null);
	assert.equal((await decided()).decided_today.count, null);
	put("escalations.json", "{bad");
	assert.equal((await decided()).availability.escalations, "unavailable");
	assert.deepEqual((await decided()).items, []);

	const journal = jsonl([ask("ask-aa"), ask("ask-bb"), { type: "answer", id: "ask-bb", answer: "Keep", answered_at: AT }, ask("ask-cc"), { type: "withdraw", id: "ask-cc", reason: "obsolete" }]);
	put("operator/asks.jsonl", journal);
	put("escalations.json", { items: [escalation("es-open", { status: "open", mandate_clause: "spend cap is not delegated" }), escalation("es-parent", { status: "open" }), escalation("es-gone", { status: "withdrawn" })] });
	let data = await awaiting();
	assert.equal(data.awaiting_count, 1);
	assert.deepEqual(data.items.map((a: Json) => a.id), ["ask-aa"]);
	assert.deepEqual([data.items[0].options[0].reply, data.items[0].reason, data.items[0].source_created_at, data.items[0].spend], ["ask-aa: Keep", "spend cap is not delegated", AT, null]);
	assert.deepEqual(data.parent_questions.map((q: Json) => [q.id, Math.floor(q.age_seconds)]), [["es-parent", 3600]], "the viewer's pinned clock");
	assert.equal(readFileSync(join(d.stateDir, "operator/asks.jsonl"), "utf8"), journal, "reads never rewrite the journal");

	put("operator/asks.jsonl", jsonl([ask("ask-aa")]));
	put("escalations.json", { items: [escalation("es-open", { status: "open", mandate_id: "md-demo" })] });
	put("mandates/md-demo.json", { id: "md-demo", status: "paused", issued_at: AT, expiry: "2026-09-27T11:00:00Z", projects: ["demo"], spend_cap: { usd: 20, tokens: 1000 } });
	put("fleet.json", { jobs: [{ job_id: "cp-demo", project: "demo", phase: "held", usage: { cost_usd: 3, total_tokens: 100 } }] });
	let item = (await awaiting()).items[0];
	assert.deepEqual([item.mandate_id, item.mandate_status, item.spend_cap, item.spend], ["md-demo", "paused", 20, 3]);
	put("fleet.json", "{bad");
	item = (await awaiting()).items[0];
	assert.deepEqual([item.spend, item.spend_cap], [null, 20], "a corrupt fleet is no spend, never zero");

	// The decision card's context: written by the product's own ask journal, with evidence in and outside the home.
	rmSync(join(d.stateDir, "operator/asks.jsonl"));
	const card = "2026-09-27T08:20:00Z";
	const asks = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl"));
	const context = "The parent paused cp-demo at the spend cap.\n\n- Keep: nothing more is spent\n- Raise: $5 more, finishes today\n\nRisk: low.";
	const first = asks.open({ project: "demo", question: "Raise the cap?", options: [{ label: "Keep", consequence: "Work stays paused" }, { label: "Raise", consequence: "Spends $5 more" }], recommendation: "Keep", source_escalation: "es-cap", job_ids: ["cp-demo"], evidence_paths: [join(d.stateDir, "runs", "cp-demo", "artifact.md"), "README.md", "/nowhere/else.md", "runs/cp-demo/notes.md", join(d.stateDir, "runs", "cp-ghost", "artifact.md")], context });
	const second = asks.open({ project: "demo", question: "Second question", options: [{ label: "Yes", consequence: "Proceeds" }], recommendation: "Yes" });
	asks.answer(asks.open({ project: "demo", question: "Settled", options: [{ label: "Yes", consequence: "Proceeds" }], recommendation: "Yes" }).id, "Yes");
	seedCard(d.stateDir, d.home, card);
	const items = (await awaiting("2026-09-27T09:00:00Z")).items as Json[];
	assert.deepEqual(items.map((a) => a.id), [first.id, second.id], "open asks only, journal order");
	const [one, two] = items;
	assert.deepEqual([one!.context, two!.context, one!.mandate_objective], [context, null, "Ship the demo dashboard"]);
	assert.deepEqual(one!.jobs, [{ id: "cp-demo", title: "Demo dashboard job", phase: "held", model: "anthropic/claude-demo", cost_usd: 1.5, pr_url: "https://github.com/acme/repo/pull/7", ci: null, review: null }]);
	assert.deepEqual(one!.escalation, { id: "es-cap", kind: "budget_exhausted", question: "cp-demo hit its cap: raise or drop?", recommended: "Drop the job", differs: true });
	const file = (path: string) => `#files?${new URLSearchParams({ root: "project:demo", path })}`;
	assert.deepEqual(one!.evidence.map((e: Json) => [e.href, e.read]), [["#job/cp-demo", null], [file("README.md"), null], [null, null], [file("runs/cp-demo/notes.md"), null], [null, null]], "a project path with a runs/ segment is a file, an unknown run is plain");
	const written = readFileSync(join(d.stateDir, "operator", "asks.jsonl"), "utf8");
	const tooLong = { project: "demo", question: "Q", options: [{ label: "A", consequence: "B" }], recommendation: "A", context: "x".repeat(2001) };
	assert.throws(() => asks.open(tooLong), /invalid operator ask/, "context is capped at 2,000 characters");
	assert.equal(readFileSync(join(d.stateDir, "operator", "asks.jsonl"), "utf8"), written, "a refused ask writes nothing");

	// The operator transcript: 320 lines after the ask call put the first ask's card outside the 300-entry window.
	const transcript = join(d.home, "operator-session.jsonl");
	const message = (m: unknown) => JSON.stringify({ type: "message", timestamp: card, message: m });
	write(transcript, [message({ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "cp_parent", arguments: { action: "ask" } }] }), message({ role: "toolResult", toolCallId: "call-a", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id: first.id }) }] }), ...Array.from({ length: 320 }, (_, i) => message({ role: "user", content: [{ type: "text", text: `line ${i}` }] }))].join("\n") + "\n");
	write(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: card, session_file: transcript })}\n`);
	const full = (await d.get("/api/sessions?view=you&transcript=1")).body as Json;
	assert.equal(full.truncated, true);
	assert.deepEqual(full.open_asks.map((a: Json) => a.id), [first.id, second.id], "the pinned list is every open ask, window or not");
	assert.equal(full.open_asks[0].escalation.differs, true);
	assert.equal(((await d.get("/api/sessions?view=you")).body as Json).open_asks, undefined, "the Decisions view pins nothing");

	// N11: a stored "label: rationale" recommendation matches its option; a real mismatch still differs.
	const recs = ["approve: read the plan first", "Approve. The plan is sound.", "ok", "drop: the plan is stale", "approved"];
	put("operator/asks.jsonl", jsonl(recs.map((recommendation, n) => ({ type: "open", id: `ask-a${n}`, project: "demo", question: "Approve the plan?", created_at: card, options: [{ label: "approve", consequence: "Proceeds" }, { label: "drop", consequence: "Closes" }], recommendation, source_escalation: "es-plan" }))));
	put("escalations.json", { items: [{ id: "es-plan", created_at: card, question: "Approve the plan?", status: "open", kind: "plan_approval", job_ids: [], recommended: "ok", options: [{ id: "ok", label: "approve" }, { id: "no", label: "drop" }] }] });
	const differs = (await awaiting("2026-09-27T09:00:00Z")).items.map((i: Json) => [i.recommendation, i.escalation?.differs]);
	assert.deepEqual(differs, [[recs[0], false], [recs[1], false], [recs[2], false], [recs[3], true], [recs[4], true]]);
});

test("P17-decided: /api/decided keeps delegated and your answers with their basis, worth and quote, and counts only today's", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t, { at: "2026-09-26T12:00:00Z", env: UTC });
	const put = (file: string, value: unknown) => write(join(d.stateDir, file), value);
	const decided = async () => (d.pin("2026-09-26T12:00:00Z"), (await d.get("/api/decided")).body as Json);
	put("operator/asks.jsonl", jsonl([{ ...ask("ask-aa"), source_escalation: "es-risk" }, { type: "answer", id: "ask-aa", answer: "Keep", answered_at: AT }]));
	put("escalations.json", { items: [
		escalation("es-risk", { kind: "risk_high_irreversible", delegation_rule: "Evidence clears risk", basis: { operator_quote: "Proceed after checking the risk." } }),
		escalation("es-scope", { kind: "scope_expansion" }), escalation("es-override", { answer: "Accept anyway", options: [{ id: "override", label: "Accept anyway" }] }),
		escalation("es-old", { answered_at: "2026-09-25T23:59:59Z" }), escalation("es-boundary", { answered_at: "2026-09-26T00:00:00Z" }),
		escalation("es-prose", { question: "risk scope override words are not metadata" }),
		escalation("es-human", { answered_by: "operator-quote" }), escalation("es-mandate", { answered_by: "mandate:md-demo" }), escalation("es-withdrawn", { status: "withdrawn" }),
	] });
	let data = await decided();
	const row = (id: string) => (data.items as Json[]).find((item) => item.id === id)!;
	assert.deepEqual([data.items.length, data.decided_today.count, data.decided_today.worth_count], [7, 5, 5], "other authorities are excluded; midnight UTC is today");
	assert.equal(((await d.get("/api/awaiting")).body as Json).decided_today.count, 5);
	assert.deepEqual([row("es-risk").quote, row("es-risk").rule, row("es-risk").answer, row("es-scope").quote, row("es-scope").kind], ["Proceed after checking the risk.", "Evidence clears risk", "Proceed", null, "scope_expansion"]);
	assert.deepEqual([data.items.at(-1).id, data.items.at(-1).today], ["es-old", false]);
	for (const id of ["es-risk", "es-scope", "es-override", "es-prose"]) assert.deepEqual(row(id).worth, ["judgement"], `${id}: prose never sets worth`);
	assert.deepEqual([row("ask-aa").worth, row("ask-aa").basis, row("ask-aa").source, row("ask-aa").rule], [[], { kind: "words", ref: "ask-aa" }, "you", null]);

	write(join(d.home, LAYOUT.data, "standing-orders.md"), "If I said to work on something, do it.\n\"do the listed work\"\n");
	const rule = (id: string, delegation_rule: string, answered_at = AT) => escalation(id, { delegation_rule, answered_at });
	put("escalations.json", { items: [rule("es-asks", "see ask-0123456789ab and ask-abcdefabcdef"), rule("es-stand", "per standing delegation for this"), rule("es-quote", "please \"do the listed work\" today"), rule("es-verb", "verbatim on 2026-10-04: \"ship the ten\""), rule("es-long", `standing ${"x".repeat(90)}`), rule("es-judge", "operator: approve on my behalf"), rule("es-yday", "operator: approve on my behalf", "2026-09-25T11:00:00Z")] });
	data = await decided();
	assert.deepEqual(["es-asks", "es-stand", "es-quote", "es-verb", "es-judge", "ask-aa"].map((id) => row(id).basis), [
		{ kind: "words", ref: "ask-0123456789ab · ask-abcdefabcdef" }, { kind: "standing", ref: "per standing delegation for this" }, { kind: "standing", ref: "do the listed work" },
		{ kind: "words", ref: "Oct 4 · “ship the ten”" }, { kind: "judgement", ref: null }, { kind: "words", ref: "ask-aa" },
	]);
	assert.deepEqual([row("es-long").basis.kind, row("es-long").basis.ref.length, row("es-judge").worth, row("es-asks").worth, data.decided_today.worth_count], ["standing", 80, ["judgement"], [], 1], "worth counts only today's judgement");
	write(join(d.home, LAYOUT.data, "standing-orders.md"), "no matching quote here");
	data = await decided();
	assert.deepEqual(row("es-quote").basis, { kind: "words", ref: "“do the listed work”" }, "a quote absent from standing orders is your words");
});

test("P17-decisions-page: the served Decisions page stacks Awaiting, Answers, Being handled and the Decided log, truthfully in every state", { timeout: 180_000 }, async (t) => {
	const NOW = "2026-09-26T12:00:00Z";
	const d = await dashboard(t, { at: NOW, env: UTC });
	const put = (file: string, value: unknown) => write(join(d.stateDir, file), value);
	const open = async () => { d.pin(NOW); const tab = await d.open("#decisions"); await tab.find("#decided"); await tab.find("#awaiting"); return tab; };
	const inside = (tab: Tab, id: string) => tab.$(`#${id}`)!.textContent ?? "";

	let tab = await open();
	await tab.waitText(/Nothing needs you/);
	assert.equal(tab.$$("h1").length, 1, "one page title");
	assert.equal(tab.$("h1")?.getAttribute("title"), "Decisions");
	assert.match(inside(tab, "awaiting"), /0 decided today · 0 for you, 0 by you/);
	assert.equal(tab.text().match(/decided today/gi)?.length, 1);
	assert.doesNotMatch(inside(tab, "awaiting"), /What comes here|worth a look|Handled without you/i);
	assert.match(inside(tab, "decided"), /Nothing here for this filter/);
	assert.doesNotMatch(tab.text(), /Being handled|Always asks you about/);
	assert.ok(tab.root.innerHTML.indexOf('id="awaiting"') < tab.root.innerHTML.indexOf('id="decided"'), "Awaiting sits above the Decided log");
	assert.equal(tab.$("#answers"), null, "no answers journal: no Answers section");
	assert.ok(tab.$(".decisions-log #decided"));
	assert.match(tab.$(".decisions-log-aside")?.textContent ?? "", /own judgement/);
	assert.equal(tab.$(".shell-count"), null, "no badge at zero");

	put("operator/asks.jsonl", "bad\n");
	put("escalations.json", "{bad");
	tab = await tab.reopen();
	await tab.waitText(/Questions unavailable/);
	assert.doesNotMatch(tab.text(), /Nothing needs you|Nothing here for this filter/);
	assert.match(inside(tab, "decided"), /Decisions unavailable/);
	assert.match(inside(tab, "decided"), /Today · counts unavailable/);
	assert.match(tab.text(), /Being handled · -/);
	assert.match(tab.text(), /Parent questions unavailable/);

	// Three open asks (one hostile, tied to an open escalation), two parent questions, today's delegated decision
	// with three mission-end closes, an older answer of yours and one posted answer.
	const ago = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString().replace(".000Z", "Z");
	const today = (id: string, extra: Json = {}) => escalation(id, { answered_at: ago(600), job_ids: [], ...extra });
	put("operator/asks.jsonl", jsonl([
		ask("ask-aa", { question: "<script>Raise cap?</script>", created_at: "2026-09-26T10:00:00Z" }), { ...ask("ask-bb"), source_escalation: undefined }, { ...ask("ask-cc"), source_escalation: undefined },
		{ ...ask("ask-dd", { question: "Older human answer", created_at: "2026-09-25T09:00:00Z" }), source_escalation: undefined }, { type: "answer", id: "ask-dd", answer: "Keep", answered_at: "2026-09-25T10:00:00Z" },
	]));
	put("escalations.json", { items: [
		escalation("es-open", { status: "open", mandate_clause: "Not delegated", answered_at: undefined }),
		escalation("es-a", { status: "open", kind: "mission_end", question: "Close md-x?", created_at: ago(3470), job_ids: ["cp-a"] }), escalation("es-b", { status: "open", kind: "mission_end", question: "q", created_at: ago(60), job_ids: [] }),
		today("es-risk", { kind: "risk_high_irreversible", question: "cp-demo: Risk?", job_ids: ["cp-demo"], delegation_rule: "Evidence clears it", basis: { operator_quote: "Remove it with a normal revert commit." } }),
		...["md-aaaa", "md-bbbb", "md-cccc"].map((id) => today(`es-${id}`, { kind: "mission_end", question: `${id}: every job it names is closed`, delegation_rule: "see ask-0123456789ab" })),
	] });
	appendAnswerLine(d.stateDir, { type: "posted", by: "bridge", id: "ans-aaaaaaaaaaaa", at: ago(30), project: "demo", question: "What?", answer: "Because.", evidence_paths: [], job_id: null } as never);
	tab = await tab.reopen();
	await tab.find(".decided-row");
	const awaitingHtml = tab.$("#awaiting")!.innerHTML;
	assert.match(awaitingHtml, /&lt;script&gt;Raise cap\?&lt;\/script&gt;/, "a hostile question is text");
	assert.doesNotMatch(awaitingHtml, /<script>|style=|onclick=|ask-aa: Keep|Copy a reply|\/classic/i);
	assert.match(inside(tab, "awaiting"), /Where it came from/);
	assert.match(inside(tab, "awaiting"), /Not delegated/);
	assert.ok(tab.$('#awaiting a[href="#sessions?view=parent"]'));
	const html = tab.root.innerHTML;
	const order = ['id="awaiting"', 'id="answers"', "Being handled", 'id="decided"'].map((needle) => html.indexOf(needle));
	assert.deepEqual(order.toSorted((a, b) => a - b), order, "Awaiting, Answers, Being handled, then the Decided log");
	assert.ok(order.every((at) => at >= 0));
	assert.equal(tab.$("details.decisions-handled.decisions-handled-overdue")?.hasAttribute("open"), false, "collapsed, amber past 10 minutes");
	assert.equal(tab.$("details.decisions-handled > summary")?.textContent, "Being handled · 2 (oldest 57m)");
	assert.match(tab.text(), /Close md-x\?/);
	for (const label of ["Desktop primary", "Primary"]) {
		const links = tab.$$(`nav[aria-label="${label}"] a`);
		assert.deepEqual(links.filter((a) => a.querySelector(".shell-count")).map((a) => [a.getAttribute("href"), a.querySelector(".shell-count")!.textContent]), [["#decisions", "3"]], label);
		assert.deepEqual(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href")), ["#decisions"], label);
	}

	// The Decided log: today on the for-you tab, the closes folded, the job id leading once, the quote clamped.
	const button = (label: string) => tab.$$("#decided button").find((b) => b.textContent === label)!;
	const tabNamed = (name: string) => tab.$$("#decided [role=tab]").find((b) => b.textContent?.startsWith(name))!;
	const decidedText = () => inside(tab, "decided");
	assert.equal(tab.$(".decided-toolbar .decided-summary")?.textContent, "Today · 4 decided for you · 0 answered by you");
	assert.ok(tab.$('.decided-toolbar [role="tablist"]') && tab.$('.decided-toolbar [aria-label="Range"]') && tab.$(".decided-toolbar .decided-worth"));
	assert.match(decidedText(), /Decided for you 4/);
	assert.match(decidedText(), /3 mandate closes/);
	assert.doesNotMatch(decidedText(), /md-aaaa|md-bbbb|md-cccc|Older human answer/);
	const risk = tab.$$(".decided-row").find((row) => row.querySelector(".decided-question")?.getAttribute("title") === "cp-demo: Risk?")!;
	assert.equal(risk.querySelector(".decided-question")?.textContent, "Risk?");
	assert.equal(risk.querySelector(".decided-question")?.getAttribute("title"), "cp-demo: Risk?");
	assert.equal(risk.textContent!.match(/cp-demo/g)?.length, 1, "the job id leads the row once");
	assert.equal(risk.querySelector(".decided-answer span")?.textContent, "“Remove it with a normal revert commit.”");
	assert.match(risk.innerHTML, /<a href="#job\/cp-demo"><span class="decision-phone">evidence/);
	assert.equal(risk.querySelector(".decided-quote")?.getAttribute("aria-expanded"), "false");
	tab.click(risk.querySelector(".decided-quote")!);
	await tab.find(".decided-quote", (q) => q.getAttribute("aria-expanded") === "true");
	tab.click(button("show"));
	await tab.waitText(/md-aaaa/);
	assert.match(decidedText(), /md-bbbb.*md-cccc|md-cccc.*md-bbbb/s);
	assert.doesNotMatch(decidedText(), /mandate closes/);

	tab.click(button("All"));
	await tab.find("#decided button", (b) => b.textContent === "All" && b.getAttribute("aria-pressed") === "true");
	assert.equal(tab.$(".decided-summary")?.textContent, "All time · 4 decided for you · 1 answered by you");
	assert.doesNotMatch(decidedText(), /Older human answer/, "All stays on the for-you tab");
	assert.deepEqual([tabNamed("Decided for you").getAttribute("aria-selected"), tabNamed("Decided for you").getAttribute("tabIndex"), tabNamed("Answered by you").getAttribute("tabIndex")], ["true", "0", "-1"]);
	assert.equal(tabNamed("Decided for you").getAttribute("aria-controls"), tab.$("#decided [role=tabpanel]")?.id);
	tab.key(tabNamed("Decided for you"), "ArrowRight");
	await tab.find("#decided [role=tab]", (b) => b.textContent!.startsWith("Answered by you") && b.getAttribute("aria-selected") === "true");
	assert.equal(tabNamed("Answered by you").getAttribute("tabIndex"), "0");
	assert.match(decidedText(), /Older human answer/);
	assert.match(decidedText(), /your reply/);
	assert.match(decidedText(), /answered by you/);
	tab.click(tab.$$("#decided button").find((b) => b.textContent?.startsWith("Worth a look only"))!);
	await tab.find("#decided button", (b) => b.textContent!.startsWith("Worth a look only") && b.getAttribute("aria-pressed") === "true");
	assert.match(decidedText(), /Older human answer/, "worth applies only to the for-you tab");
	tab.key(tabNamed("Answered by you"), "ArrowLeft");
	await tab.find("#decided [role=tab]", (b) => b.textContent!.startsWith("Decided for you") && b.getAttribute("aria-selected") === "true");
	assert.doesNotMatch(decidedText(), /Older human answer/);
	assert.match(decidedText(), /Risk\?/);
	assert.doesNotMatch(decidedText(), /md-aaaa/, "worth hides the closes resting on your words");

	// Six rows resting on your words: no worth, five shown, a fold for the sixth that re-closes on a view change.
	const words = (n: number, extra: Json = {}) => today(`es-r${n}`, { question: `Q${n}?`, delegation_rule: "see ask-0123456789ab", ...extra });
	put("operator/asks.jsonl", "");
	put("escalations.json", { items: Array.from({ length: 6 }, (_, n) => words(n)) });
	write(operatorAnswersFile(d.stateDir), "");
	tab = await tab.reopen();
	await tab.find(".decided-row");
	assert.equal(tab.$$(".decided-row").length, 5);
	assert.match(tab.$(".decided-evidence-jobless a")?.getAttribute("href") ?? "", /#sessions\?view=parent/, "a jobless row's evidence is the parent transcript");
	tab.click(button("1 more decided for you today"));
	await tab.find(".decided-row", () => tab.$$(".decided-row").length === 6);
	tab.click(tabNamed("Answered by you"));
	await tab.find("#decided [role=tab]", (b) => b.textContent!.startsWith("Answered by you") && b.getAttribute("aria-selected") === "true");
	tab.click(tabNamed("Decided for you"));
	await tab.find(".decided-row");
	assert.equal(tab.$$(".decided-row").length, 5, "the fold re-closes after a view change");
	tab.click(tab.$$("#decided button").find((b) => b.textContent?.startsWith("Worth a look only"))!);
	await tab.waitText(/own judgement appear here/);
	assert.match(decidedText(), /rests on your words or a standing order/);
	assert.doesNotMatch(decidedText(), /Nothing here for this filter/);

	// Only a leading "<id>: " prefix is stripped; one mission-end close alone stays a row; Space toggles a quote.
	const solo = words(2, { kind: "mission_end", question: "md-solo: every job it names is closed" });
	put("escalations.json", { items: [words(0, { question: "Close cp-demo? cp-demo is idle", job_ids: ["cp-demo"], basis: { operator_quote: "yes" } }), words(1, { question: "cp-demo: Close cp-demo?", job_ids: ["cp-demo"], basis: { operator_quote: "yes" } }), solo] });
	tab = await tab.reopen();
	await tab.find(".decided-question");
	assert.deepEqual(tab.$$(".decided-question").map((q) => q.textContent), ["Close cp-demo? cp-demo is idle", "Close cp-demo?", "md-solo: every job it names is closed"]);
	assert.doesNotMatch(decidedText(), /mandate closes/, "one close alone is not folded");
	const space = tab.key(tab.$(".decided-quote")!, " ");
	assert.equal(space.defaultPrevented, true);
	await tab.find(".decided-quote", (q) => q.getAttribute("aria-expanded") === "true");
});

/** The decision card's surroundings: its escalation, mandate, fleet job with a PR, ledger title and project files. */
function seedCard(stateDir: string, home: string, at: string) {
	write(join(stateDir, "escalations.json"), { items: [{ id: "es-cap", created_at: at, question: "cp-demo hit its cap: raise or drop?", status: "open", kind: "budget_exhausted", job_ids: ["cp-demo"], mandate_id: "md-abcd", mandate_clause: "the USD cap is never the parent's", recommended: "drop", options: [{ id: "drop", label: "Drop the job" }, { id: "raise", label: "Raise" }] }] });
	write(join(stateDir, "mandates", "md-abcd.json"), { id: "md-abcd", status: "active", issued_at: "2026-09-27T00:00:00Z", expiry: "2026-09-28T00:00:00Z", projects: ["demo"], spend_cap: { usd: 10 }, objective: "Ship the demo dashboard" });
	write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-demo", project: "demo", phase: "held", kind: "ship", delivery: "pr", dispatched_at: at, worker: { model: "anthropic/claude-demo" }, usage: { cost_usd: 1.5, total_tokens: 100 }, receipts: [{ kind: "pr", url: "https://github.com/acme/repo/pull/7", status: "open" }] }] });
	write(join(home, ".pi-command-post", "jobs.json"), { jobs: [{ id: "cp-demo", status: "in_progress", title: "Demo dashboard job", labels: ["project:demo"] }] });
	write(join(home, LAYOUT.projects, "demo", "README.md"), "# demo\n");
	write(join(home, LAYOUT.projects, "demo", "runs", "cp-demo", "notes.md"), "# notes\n");
}

const A = "ans-aaaaaaaaaaaa";
const B = "ans-bbbbbbbbbbbb";
const C = "ans-cccccccccccc";
const posted = (id: string, at: string, extra: Json = {}) => ({ type: "posted", by: "bridge", id, at, project: "demo", question: `question ${id}`, answer: `short ${id}\n\nlong ${id}`, evidence_paths: [], job_id: null, ...extra }) as never;
const lines = (file: string): Json[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const post = (origin: string, token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});

test("P17-answers-ack: POST /api/answers/ack refuses in order, journals each refusal once, and 202s only with its acked line", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t);
	const journal = operatorAnswersFile(d.stateDir);
	const audit = controlJournalFile(d.stateDir);
	appendAnswerLine(d.stateDir, posted(A, "2026-07-01T00:00:00Z"));
	appendAnswerLine(d.stateDir, { type: "acked", by: "viewer", id: B, at: "2026-07-01T00:00:01Z", peer: null });
	appendAnswerLine(d.stateDir, posted(B, "2026-07-01T00:00:02Z"));
	appendAnswerLine(d.stateDir, { type: "acked", by: "viewer", id: B, at: "2026-07-01T00:00:03Z", peer: null });
	const status = await d.get("/api/answers/control");
	assert.deepEqual([status.status, status.body.enabled, status.body.reason], [200, true, null]);
	const token = String(status.body.token);
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(lines(journal).length, 4, "the status route never writes");
	const acks = () => lines(journal).filter((l) => l.type === "acked").length;
	const ack = (tok: string | null, body: unknown, extra?: Record<string, string>) => d.get("/api/answers/ack", post(d.origin, tok, body, extra));
	const refused = async (reply: Promise<Reply>, code: number, reason: RegExp, fields: Json = {}) => {
		const before = lines(audit).length;
		const out = await reply;
		assert.equal(out.status, code, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${code} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual([line.type, line.by, line.kind, line.status, line.peer], ["refused", "viewer", "answer_ack", code, "127.0.0.1"]);
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(acks(), 2, "no refusal writes an acked line");
	};
	assert.equal((await d.get("/api/answers/ack")).status, 405);
	assert.equal(existsSync(audit), false, "405 is not journaled");
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	await refused(ack(token, { id: A }), 403, /dashboard control is off/);
	rmSync(controlConfigFile(d.stateDir));
	await refused(ack(token, { id: A }, { origin: "https://evil.example" }), 403, /Origin must be/);
	await refused(ack(token, { id: A }, { "sec-fetch-site": "cross-site" }), 403, /cross-site/);
	await refused(ack(token, { id: A }, { "content-type": "text/plain" }), 415, /application\/json/);
	await refused(ack(token, { id: A, pad: "z".repeat(21 * 1024) }), 413, /20480 bytes/);
	await refused(ack(token, "{not json"), 400, /not JSON/);
	await refused(ack(token, { id: "ans-../x" }), 400, /body must be/, { answer_id: undefined });
	await refused(ack(token, { id: A, extra: 1 }), 400, /body must be/, { answer_id: A });
	await refused(ack(null, { id: A }), 403, /control token missing or stale/, { answer_id: A });
	await refused(ack("f".repeat(64), { id: A }), 403, /control token missing or stale/);
	await refused(ack(token, { id: C }), 404, /no answer ans-cccccccccccc/);
	await refused(ack(token, { id: B }), 409, /already acknowledged at 2026-07-01T00:00:03Z/);

	const sent = await ack(token, { id: A });
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.deepEqual([sent.body.id, sent.body.state], [A, "acked"]);
	assert.deepEqual(lines(journal).filter((l) => l.type === "acked").at(-1), { type: "acked", by: "viewer", id: A, at: sent.body.acked_at, peer: "127.0.0.1" });
	assert.equal(lines(journal).length, 5, "append-only: the posted lines stay");
	const after = (await d.get("/api/decisions")).body.answers as Json;
	assert.deepEqual([after.open_count, after.history.map((a: Json) => a.id), after.history[0].acked_at], [0, [A, B], sent.body.acked_at]);
	assert.equal((await ack(token, { id: A })).status, 409);
	for (const file of ["operator/asks.jsonl", "escalations.json", "push-deliveries.json", "operator/inbox.jsonl"]) assert.equal(existsSync(join(d.stateDir, file)), false, file);
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	const off = await d.get("/api/answers/control");
	assert.deepEqual([off.body.enabled, off.body.token], [false, null], "off: no token");
	assert.match(String(off.body.reason), /^Dashboard control is off/);
	rmSync(controlConfigFile(d.stateDir));
	// A fresh 60 s window: 20 requests are answered on their merits, the 21st is 429.
	d.pin(new Date(Date.now() + 120_000).toISOString());
	const codes: number[] = [];
	for (let i = 0; i < 21; i++) codes.push((await ack(null, "{")).status);
	assert.deepEqual(codes, [...Array(20).fill(400), 429], "20 requests per 60 s");
	assert.equal(lines(audit).at(-1)!.status, 429);
});

test("P17-answers-tailnet: without --require-tailnet both answer routes are 403, nothing is journaled, and the tick says why", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t, { requireTailnet: false });
	assert.equal((await d.get("/api/answers/control")).status, 403);
	assert.equal((await d.get("/api/answers/ack", post(d.origin, "x", { id: A }))).status, 403);
	assert.equal(existsSync(controlJournalFile(d.stateDir)), false);
	assert.equal(existsSync(operatorAnswersFile(d.stateDir)), false);
	appendAnswerLine(d.stateDir, posted(A, "2026-07-01T00:00:00Z"));
	const tab = await d.open("#answers");
	await tab.find(".answers-control", (el) => /^Acknowledge unavailable: answer acknowledgement is served only under --require-tailnet/.test(el.textContent ?? ""));
	assert.equal(tab.$(`button[aria-label="Acknowledge ${A}"]`)?.hasAttribute("disabled"), true);
	assert.equal(tab.$("h1")?.getAttribute("title"), "Decisions", "#answers is a section of the Decisions page");
	assert.equal(lines(operatorAnswersFile(d.stateDir)).length, 1, "nothing acked");
});

test("P17-answers: posted answers project their evidence and render as text; a tick acknowledges over HTTP and the card moves to history", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const answers = async () => (await d.get("/api/decisions")).body.answers as Json;
	assert.deepEqual(await answers(), { availability: "missing", open: [], open_count: 0, history: [], history_total: 0, warning: null });
	write(join(d.stateDir, "boards", "alpha", "board.json"), { title: "Alpha", created_at: "2026-09-01T00:00:00Z" });
	write(join(d.stateDir, "boards", "alpha", "site", "index.html"), "<h1>Alpha</h1>");
	const long = `${"word ".repeat(100)}end\nsecond line\n\nsecond paragraph`;
	const run = `run-20260701060000-${"a".repeat(6)}`;
	appendAnswerLine(d.stateDir, posted(A, "2026-07-01T00:00:00Z", { question: `<script>alert(1)</script>${"q ".repeat(400)}`, answer: long, evidence_paths: [`${d.stateDir}/boards/alpha/index.html`, "/nowhere/else.md"], job_id: "cp-demo" }));
	appendAnswerLine(d.stateDir, posted(B, "2026-07-01T00:00:01Z", { answer: "javascript:alert(1) and https://example.com/a and [x](https://example.org/b)\n\nlong" }));
	appendAnswerLine(d.stateDir, posted(C, "2026-07-01T00:00:02Z", { by: "schedule", source: { kind: "schedule", schedule_id: "sch-123456", run_id: run, source_key: `${run}:closed`, outcome: "partial" } }));
	writeFileSync(operatorAnswersFile(d.stateDir), `${readFileSync(operatorAnswersFile(d.stateDir), "utf8")}not json\n`);
	const view = await answers();
	assert.equal(view.availability, "ok");
	assert.match(String(view.warning), /^1 unreadable line\(s\)/);
	assert.deepEqual(view.open.map((o: Json) => o.id), [C, B, A], "open is newest first");
	const item = view.open.find((o: Json) => o.id === A);
	assert.deepEqual([item.short.length, item.short.endsWith("…"), item.short.includes("second"), item.answer], [281, true, false, long], "short is the first paragraph, clipped");
	assert.deepEqual(item.evidence, [{ path: `${d.stateDir}/boards/alpha/index.html`, href: "#reports", read: "/boards/alpha/" }, { path: "/nowhere/else.md", href: null, read: null }]);
	assert.deepEqual([item.job, item.schedule], [{ id: "cp-demo", href: "#job/cp-demo", read: null }, undefined]);
	assert.deepEqual(view.open.find((o: Json) => o.id === C).schedule, { schedule_id: "sch-123456", run_id: run, outcome: "partial" });
	// Once the job's envelope names a readable artifact, the answer links it as a Files path.
	seedCard(d.stateDir, d.home, "2026-07-01T00:00:00Z");
	write(join(d.stateDir, "runs", "cp-demo", "envelope.json"), { envelope: { artifact_path: join(d.home, LAYOUT.projects, "demo", "README.md") } });
	const artifact = `/#files?${new URLSearchParams({ root: "project:demo", path: "README.md" })}`;
	assert.equal((await answers()).open.find((o: Json) => o.id === A).job.read, artifact);

	// Until the control status answers, the tick reads Checking… and stays disabled.
	const tab = await d.open("#answers", /^\/api\/answers\/control$/);
	await tab.find(".answers-control", (el) => el.textContent === "Checking…");
	assert.equal(tab.$(`button[aria-label="Acknowledge ${A}"]`)?.hasAttribute("disabled"), true);
	tab.release();
	const section = tab.$("#answers")!;
	assert.equal(section.querySelectorAll("script, [style], [onclick]").length, 0, "no markup, no inline style");
	const question = tab.$$(".answers-question").find((q) => q.getAttribute("title")?.startsWith("<script>"))!;
	assert.match(question.textContent ?? "", /^<script>alert/, "the whole question is text and the title; the clamp is CSS");
	assert.equal(tab.$("details.answers-full")?.hasAttribute("open"), false, "the full answer sits in a closed details");
	assert.deepEqual(tab.$$(".answers-text a").map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]), [["https://example.com/a", "_blank", "noopener noreferrer"], ["https://example.org/b", "_blank", "noopener noreferrer"]], "javascript: stays text");
	assert.equal(tab.$(".answers-header")?.textContent, "Answers to acknowledge3");
	const evidence = tab.$$(".answers-evidence li");
	assert.ok(evidence.some((li) => li.querySelector('a[href="#reports"]') && li.querySelector('a[href="/boards/alpha/"]')));
	assert.ok(evidence.some((li) => li.textContent === "/nowhere/else.md" && !li.querySelector("a")), "an unknown path is plain");
	assert.deepEqual(tab.$$(".answers-meta a").map((a) => a.getAttribute("href")).filter((h) => !h?.startsWith("#schedules")), ["#job/cp-demo", artifact]);
	const schedule = tab.$$(".answers-schedule");
	assert.equal(schedule.length, 1, "a bridge answer shows no schedule");
	assert.match(schedule[0]!.textContent ?? "", new RegExp(`Schedule result · ${run} · partial`));
	assert.equal(schedule[0]!.querySelector("a")?.getAttribute("href"), "#schedules");
	assert.match(tab.$('[role="alert"].answers-warning')?.textContent ?? "", /1 unreadable line/);
	await tab.find(".answers-control", (el) => /^Tick ✓ to acknowledge/.test(el.textContent ?? ""));

	const tick = (id: string) => tab.find(`button[aria-label="Acknowledge ${id}"]`, (b) => !b.hasAttribute("disabled"));
	tab.click(await tick(A));
	await until(() => tab.$(`button[aria-label="Acknowledge ${A}"]`), (b) => b === null, "the acked card hides");
	const ackPost = tab.requests.find((r) => r.path === "/api/answers/ack")!;
	assert.deepEqual([ackPost.method, ackPost.body, ackPost.status, ackPost.headers["x-cp-control-token"]?.length], ["POST", `{"id":"${A}"}`, 202, 64]);
	assert.match(readFileSync(operatorAnswersFile(d.stateDir), "utf8"), new RegExp(`"type":"acked","by":"viewer","id":"${A}"`));

	// Acknowledged elsewhere: the tick fails with the server's reason; a fresh load shows both in read-only history.
	await d.get("/api/answers/ack", post(d.origin, String((await d.get("/api/answers/control")).body.token), { id: B }));
	tab.click(await tick(B));
	await tab.find(".answers-failed", (el) => /Failed: .*already acknowledged/.test(el.textContent ?? ""));
	const fresh = await tab.reopen();
	await fresh.find(".answers-history summary", (s) => /Acknowledged · 2/.test(s.textContent ?? ""));
	assert.equal(fresh.$$(".answers-history button").length, 0, "history is read-only");
	write(controlConfigFile(d.stateDir), '{"enabled": false, "reason": "opt-out"}');
	const off = await fresh.reopen();
	await off.find("button.answers-ack", (b) => b.hasAttribute("disabled"));
	assert.match(off.$(".answers-control")?.textContent ?? "", /^Dashboard control is off/);
	assert.equal((await answers()).open_count, 1, "control off: the list still renders, read-only");
	assert.ok(off.$('button[aria-label="Acknowledge ans-cccccccccccc"]'), "the open card stays listed");

	rmSync(operatorAnswersFile(d.stateDir));
	mkdirSync(operatorAnswersFile(d.stateDir));
	assert.deepEqual(await answers(), { availability: "unavailable", open: [], open_count: null, history: [], history_total: null, warning: "Answers unavailable" });
	const broken = await off.reopen();
	await broken.waitText(/Answers unavailable/);
	assert.doesNotMatch(broken.text(), /No answers waiting/, "an unreadable journal never claims an empty queue");
});

test("P17-answers-quiet: an empty, history-only or just-cleared queue collapses to one quiet line; a warning or an unrendered pending answer never does", { timeout: 240_000 }, async (t) => {
	const NOW = "2026-07-02T00:00:00Z";
	const d = await dashboard(t, { at: NOW });
	const journal = operatorAnswersFile(d.stateDir);
	const summary = (tab: Tab) => tab.$(".answers-quiet > summary")?.textContent ?? null;
	write(journal, "");
	let tab = await d.open("#answers");
	await tab.find(".answers-quiet");
	assert.equal(summary(tab), "No answers waiting · 0 acknowledged");
	assert.equal(tab.$(".answers-quiet")!.hasAttribute("open"), false, "collapsed");
	assert.deepEqual([tab.$(".answers-header"), tab.$(".answers-control"), tab.$(".answers-empty")?.textContent], [null, null, "No acknowledged answers yet"]);

	write(journal, "not json\n");
	tab = await tab.reopen();
	await tab.find('[role="alert"].answers-warning');
	assert.equal(tab.$(".answers-quiet"), null);
	assert.doesNotMatch(tab.text(), /No answers waiting/, "partial data cannot claim an empty queue");

	write(journal, "");
	appendAnswerLine(d.stateDir, posted(A, "2026-07-01T00:00:00Z"));
	appendAnswerLine(d.stateDir, { type: "acked", by: "viewer", id: A, at: "2026-07-01T00:00:01Z", peer: null });
	tab = await tab.reopen();
	await tab.find(".answers-quiet");
	assert.equal(summary(tab), "No answers waiting · 1 acknowledged");
	assert.ok(tab.$(".answers-quiet > article .answers-text"), "history is one disclosure away");
	assert.equal(tab.$$(".answers-quiet button").length, 0);

	// The last tick compacts the section at once, before any refresh.
	appendAnswerLine(d.stateDir, posted(B, "2026-07-01T00:00:02Z"));
	tab = await tab.reopen();
	tab.click(await tab.find(`button[aria-label="Acknowledge ${B}"]`, (b) => !b.hasAttribute("disabled")));
	await tab.find(".answers-quiet");
	assert.equal(summary(tab), "No answers waiting · 1 acknowledged");

	// 101 pending: the viewer sends a window of 100. Acking all of it leaves the 101st counted, never "No answers waiting".
	write(journal, jsonl(Array.from({ length: 101 }, (_, n) => posted(`ans-${n.toString(16).padStart(12, "0")}`, new Date(Date.parse("2026-07-01T00:00:00Z") + n * 1000).toISOString().replace(".000Z", "Z")))));
	tab = await tab.reopen();
	await tab.find(".answers-ack", (b) => !b.hasAttribute("disabled"));
	const count = () => tab.$(".answers-count")?.textContent;
	assert.deepEqual([count(), tab.$$(".answers-ack").length], ["101", 100]);
	let clock = Date.parse(NOW);
	for (let n = 0; n < 100; n++) {
		if (n % 10 === 0) d.pin(new Date((clock += 61_000)).toISOString()); // stay under 20 acks per 60 s
		const tick = (await tab.find(".answers-ack", (b) => !b.hasAttribute("disabled")));
		const label = tick.getAttribute("aria-label")!;
		tab.click(tick);
		await until(() => tab.$(`button[aria-label="${label}"]`), (b) => b === null, `${label} hides`);
		if (n === 0) assert.equal(count(), "100", "one tick of 101");
	}
	assert.equal(count(), "1");
	assert.equal(tab.$(".answers-quiet"), null);
	assert.doesNotMatch(tab.text(), /No answers waiting/, "acking the rendered window cannot hide the unrendered answer");
	assert.equal(lines(journal).filter((l) => l.type === "acked").length, 100);
});

test("P17-decision-card: an Awaiting card answers through the operator session's control; down, it stays visible and disabled with the reason", { timeout: 180_000 }, async (t) => {
	const NOW = "2026-09-27T12:00:00Z";
	const d = await dashboard(t, { at: NOW, env: UTC });
	const asks = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl"));
	const context = "- Keep: nothing more is spent\n- Raise: $5 more, finishes today\n\nRisk: low.";
	const first = asks.open({ project: "demo", question: "Raise the cap?", options: [{ label: "Keep", consequence: "Work stays paused" }, { label: "Raise", consequence: "Spends $5 more" }], recommendation: "Keep", source_escalation: "es-cap", job_ids: ["cp-demo"], evidence_paths: ["README.md", "/nowhere/else.md"], context });
	seedCard(d.stateDir, d.home, NOW);
	const card = (tab: Tab) => tab.find(`article[aria-labelledby="question-${first.id}"]`);
	const buttons = (el: Element) => [...el.querySelectorAll("button.decision-card-option")];

	let tab = await d.open("#decisions", /^\/api\/operator\/control$/);
	let el = await card(tab);
	await tab.find(".decision-card-disabled", (s) => s.textContent === "Checking dashboard control");
	assert.ok(buttons(el).every((b) => b.hasAttribute("disabled")), "no control status yet: checking, disabled");
	tab.release();
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	tab = await tab.reopen();
	el = await card(tab);
	await tab.find(".decision-card-disabled", (s) => /Dashboard control is off/.test(s.textContent ?? ""));
	assert.ok(buttons(el).length === 2 && buttons(el).every((b) => b.hasAttribute("disabled")), "control off: buttons stay visible, disabled");
	assert.doesNotMatch(tab.text(), /Copy reply|Copy a reply/);

	// No session yet: a send is held in the dashboard inbox for the next session, never dropped.
	rmSync(controlConfigFile(d.stateDir));
	tab = await tab.reopen();
	el = await card(tab);
	tab.type(el.querySelector("input")!, "hold this for later");
	tab.click(await tab.find(".decision-card-other button", (b) => b.textContent === "Send" && !b.hasAttribute("disabled")));
	await until(() => lines(controlInboxFile(d.stateDir)), (rows) => rows.length === 1, "the held send");
	assert.deepEqual(pick(lines(controlInboxFile(d.stateDir))[0]!, ["type", "text", "ask_id"]), { type: "held", text: `${first.id}: hold this for later`, ask_id: null });

	// The control: the session's own server. Context, the job with its PR and project files ride on the card.
	const session = await operatorSession(t, d.stateDir);
	tab = await tab.reopen();
	el = await card(tab);
	await tab.find("button.decision-card-option", (b) => !b.hasAttribute("disabled"));
	const html = el.innerHTML;
	assert.equal(el.querySelector(".decision-card-recommended strong")?.textContent, "Keep");
	assert.match(el.querySelector(".decision-card-recommended .overview-rec-badge")?.textContent ?? "", /recommended/);
	assert.match(html, /<li>Keep: nothing more is spent<\/li><li>Raise: \$5 more, finishes today<\/li>/, "context bullets");
	assert.match(html, /<p>Risk: low\.<\/p>/, "context paragraphs");
	assert.equal(el.textContent?.match(/automatic default: Drop the job/g)?.length, 2, "the escalation's own default, in the note and the context");
	assert.doesNotMatch(html, /parent recommends/);
	assert.match(el.textContent ?? "", /Ship the demo dashboard/);
	assert.match(html, /href="#job\/cp-demo"><code>cp-demo<\/code><\/a><span>Demo dashboard job<\/span><small>held · anthropic\/claude-demo · \$1\.50<\/small><a href="https:\/\/github\.com\/acme\/repo\/pull\/7">/);
	assert.ok(el.querySelector('a[href="#files?root=project%3Ademo&path=README.md"]'));
	assert.match(html, /<code>\/nowhere\/else\.md<\/code>/, "an unresolvable path stays plain text");

	tab.click(buttons(el).find((b) => b.textContent?.startsWith("Raise"))!);
	await until(() => tab.requests.filter((r) => r.method === "POST"), (posts) => posts.length === 1, "the answer post");
	const sent = tab.requests.filter((r) => r.method === "POST").map((r) => [r.path, JSON.parse(r.body!), r.status]);
	assert.deepEqual(sent, [["/api/operator/message", { kind: "answer", ask_id: first.id, label: "Raise" }, 202]]);
	assert.ok(session.injected.some(([text]) => text.includes(first.id) && text.includes("Raise")), "the answer reached the session");
	await tab.find(".decision-card-delivery", (p) => /Sent, queued — the card closes when the session records the answer/.test(p.textContent ?? ""));
	assert.ok([...(await card(tab)).querySelectorAll("button, input")].every((b) => b.hasAttribute("disabled")), "one answer per card until the session records it");

	// The session records the answer; an Other answer on the next card reaches the running session as `<ask>: text`.
	asks.answer(first.id, "Raise");
	const next = asks.open({ project: "demo", question: "Merge now?", options: [{ label: "Yes", consequence: "Merges" }], recommendation: "Yes" });
	tab = await tab.reopen();
	el = await tab.find(`article[aria-labelledby="question-${next.id}"]`);
	tab.type(el.querySelector("input")!, "approve with changes: cap at $3");
	tab.click(await tab.find(".decision-card-other button", (b) => b.textContent === "Send" && !b.hasAttribute("disabled")));
	await until(() => tab.requests.filter((r) => r.method === "POST"), (posts) => posts.length === 1, "the other-answer post");
	assert.deepEqual(pick(tab.requests.find((r) => r.method === "POST")!, ["path", "body", "status"]), { path: "/api/operator/message", body: JSON.stringify({ kind: "message", text: `${next.id}: approve with changes: cap at $3` }), status: 202 });
	assert.ok(session.injected.some(([text]) => text.includes(`${next.id}: approve with changes: cap at $3`)), "delivered to the running session");
	assert.equal(lines(controlInboxFile(d.stateDir)).filter((l) => l.type === "held").length, 1, "a running session's send is never held");

	// A stale card answering a settled ask is refused and says so.
	asks.answer(next.id, "approve with changes");
	const last = asks.open({ project: "demo", question: "Tag the release?", options: [{ label: "Yes", consequence: "Tags" }], recommendation: "Yes" });
	tab = await tab.reopen();
	await tab.find(`article[aria-labelledby="question-${last.id}"]`);
	asks.answer(last.id, "Yes");
	tab.click(await tab.find("button.decision-card-option", (b) => !b.hasAttribute("disabled")));
	await tab.find(".decision-card-failed", (p) => /^Failed: /.test(p.textContent ?? "") && p.getAttribute("role") === "alert");
});
