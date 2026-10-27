/**
 * Behavior 17 (P17a): the dashboard's Decisions page — Awaiting, Being handled, Answers and the Decided log — as
 * `bin/cp-view` serves it on a scratch home: its HTTP routes, and the served app run in a tab (tests/harness/dashboard)
 * whose clicks reach the viewer and, for a decision card, the operator session's own dashboard-control server.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../../src/dashboard-control.ts";
import { RESTART_UNSUPPORTED } from "../../src/dashboard-restart.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { deviceNotificationsFile } from "../../src/viewer/device-notification-files.ts";
import { DEVICE_TRUST } from "../../src/viewer/api-types.ts";
import { appendAnswerLine } from "../../src/viewer/control-audit.ts";
import { controlConfigFile, controlInboxFile, controlJournalFile, controlRecordFile, controlSocketFile, operatorAnswersFile } from "../../src/viewer/control-files.ts";
import { devicesFile } from "../../src/viewer/device-files.ts";
import { viewerConfigFile } from "../../src/viewer/host-config.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { pushConfigFile, pushDataDir } from "../../src/viewer/push-files.ts";
import { dashboard, openTab, operatorSession, type Reply, type Tab, until } from "../harness/dashboard.ts";
import { call } from "../harness/remote.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, MockProvider, startPiChild } from "../harness/index.ts";

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

test("P17-ask-context: a cp_parent ask's context reaches Awaiting whole up to 2,000 characters; a longer one is refused and writes nothing", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const provider = await MockProvider.start();
	const ask = (id: string, context: string) => ({ id, name: "cp_parent", args: { action: "ask", ask: { project: "demo-app", question: `Context ${id}?`, options: [{ label: "A", consequence: "does a" }], recommendation: "A", context } } });
	const model = provider.addScript("p17-ask-context", [{ kind: "tool_calls", calls: [ask("fits", "x".repeat(2000)), ask("over", "y".repeat(2001))] }, { kind: "text", text: "Asked." }]);
	const agentDir = createAgentDir({ provider });
	const pi = startPiChild({ cwd: d.home, model, env: { ...agentDir.env, PI_HOME: d.home, CP_HOME: d.home, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	t.after(async () => { await pi.close(); agentDir.cleanup(); await provider.stop(); });
	await pi.prompt("Ask me both.");
	await pi.waitFor((r) => r.type === "agent_settled", 60_000);
	const ends = new Map(pi.records().filter((r) => r.type === "tool_execution_end").map((r) => [(r as Json).toolCallId, (r as Json).isError === true]));
	assert.deepEqual([ends.get("fits"), ends.get("over")], [false, true], "context is capped at 2,000 characters");
	const items = ((await d.get("/api/awaiting")).body as Json).items as Json[];
	assert.deepEqual(items.map((i) => [i.question, i.context?.length]), [["Context fits?", 2000]], "the refused ask writes nothing");
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
	// The refusal must be the tailnet rule itself: a bad token or Origin is a 403 too (#555 review).
	for (const reply of [await d.get("/api/answers/control"), await d.get("/api/answers/ack", post(d.origin, "x", { id: A }))]) {
		assert.deepEqual([reply.status, /served only under --require-tailnet$/.test(String(reply.body.error))], [403, true], String(reply.body.error));
	}
	assert.equal(existsSync(controlJournalFile(d.stateDir)), false);
	assert.equal(existsSync(operatorAnswersFile(d.stateDir)), false);
	appendAnswerLine(d.stateDir, posted(A, "2026-07-01T00:00:00Z"));
	const tab = await d.open("#answers");
	assert.ok(await tab.find(".answers-control", (el) => /^Acknowledge unavailable: answer acknowledgement is served only under --require-tailnet/.test(el.textContent ?? "")));
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
	assert.ok(await tab.find(".answers-control", (el) => el.textContent === "Checking…"));
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
	assert.equal(await until(() => tab.$(`button[aria-label="Acknowledge ${A}"]`), (b) => b === null, "the acked card hides"), null);
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
	await tab.find(".decision-card-failed", (p) => p.textContent === `Failed: ${last.id} is answered; nothing to answer` && p.getAttribute("role") === "alert");
	assert.equal(tab.requests.filter((r) => r.method === "POST").at(-1)?.status, 409, "the stale card's refusal");

	// A session that died leaving its record behind (its pid alive, its socket gone): disabled, saying so.
	const record = readFileSync(controlRecordFile(d.stateDir), "utf8");
	session.control.stop();
	writeFileSync(controlRecordFile(d.stateDir), record);
	const dead = asks.open({ project: "demo", question: "Retry the deploy?", options: [{ label: "Yes", consequence: "Retries" }], recommendation: "Yes" });
	tab = await tab.reopen();
	el = await tab.find(`article[aria-labelledby="question-${dead.id}"]`);
	await tab.find(".decision-card-disabled", (s) => /^Session not running: .* refused the connection/.test(s.textContent ?? ""));
	assert.ok(buttons(el).every((b) => b.hasAttribute("disabled")), "a dead session's card stays visible, disabled");
});

const MESSAGE = "/api/operator/message", QUEUE = "/api/operator/queue", START = "/api/operator/start";
const ORIGIN = "https://cp.example.ts.net";
const DC = /^dc-\d{14}-[0-9a-f]{8}$/;
const TMUX = { via: "tmux" }, HERDR = { via: "herdr" };
const pushConfig = (stateDir: string) => write(pushConfigFile(pushDataDir(stateDir)), { origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" });
const seedAsks = (stateDir: string) => write(join(stateDir, "operator", "asks.jsonl"), jsonl([ask("ask-abcd", { question: "Raise cap?" }), ask("ask-bbbb", { question: "Merge?", options: [{ label: "Yes", consequence: "Merges" }] }), { type: "answer", id: "ask-bbbb", answer: "Yes", answered_at: AT }]));
const record = (stateDir: string, pid: number, socket = controlSocketFile(stateDir)) => write(controlRecordFile(stateDir), { version: 1, pid, socket, token: "a".repeat(64), csrf: "a".repeat(64), started_at: "2026-09-27T08:00:00Z" });

/** A viewer whose clock `fresh()` moves 2 minutes on: a new rate window and a new one-start-per-60-s slot. */
function windows(d: { pin(iso: string): void }) {
	let clock = Date.now();
	return () => d.pin(new Date((clock += 120_000)).toISOString());
}

/** A dashboard with the open asks seeded and an operator session (its real control server) running. */
async function live(t: TestContext, { isIdle, ...options }: NonNullable<Parameters<typeof dashboard>[1]> & { isIdle?: () => boolean } = {}) {
	const d = await dashboard(t, options);
	seedAsks(d.stateDir);
	const session = await operatorSession(t, d.stateDir, isIdle);
	const token = String((await d.get("/api/operator/control")).body.token);
	const send = (tok: string | null, body: unknown, extra?: Record<string, string>) => d.get(MESSAGE, post(d.origin, tok, body, extra));
	return { ...d, ...session, token, send, fresh: windows(d), journal: () => lines(controlJournalFile(d.stateDir)) };
}

/** Asserts one refusal: its status and reason, and exactly one viewer `refused` line naming the client address. */
const refusal = (stateDir: string) => async (reply: Promise<Reply>, code: number, reason: RegExp, fields: Json = {}) => {
	const before = lines(controlJournalFile(stateDir)).length;
	const out = await reply;
	assert.equal(out.status, code, JSON.stringify(out.body));
	assert.match(String(out.body.error), reason);
	const after = lines(controlJournalFile(stateDir));
	assert.equal(after.length, before + 1, `one audit line for ${code} ${reason}`);
	const line = after.at(-1)!;
	assert.deepEqual(pick(line, ["type", "by", "status", "peer"]), { type: "refused", by: "viewer", status: code, peer: "127.0.0.1" });
	for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
	return out;
};

test("P17-control-send: with no config file a send and a click reach the session once, journaled by the bridge; ?sends=0 is the lean read", { timeout: 120_000 }, async (t) => {
	const s = await live(t);
	assert.equal(existsSync(controlConfigFile(s.stateDir)), false);
	const status = await s.get("/api/operator/control");
	assert.deepEqual([status.status, status.body.enabled, status.body.running], [200, true, true]);
	assert.match(s.token, /^[0-9a-f]{64}$/, "the page fetches this session's CSRF token itself");
	assert.equal(existsSync(controlJournalFile(s.stateDir)), false, "the status route never writes");
	const sent = await s.send(s.token, { kind: "message", text: "hello" });
	assert.deepEqual([sent.status, sent.body.deliver], [202, "prompt"]);
	assert.match(String(sent.body.id), DC);
	assert.equal(s.injected.length, 1);
	assert.match(s.injected[0]![0], /^hello\n\n\[cp-dashboard dc-\d{14}-[0-9a-f]{8} — from the dashboard\]$/);
	assert.equal((await s.send(s.token, { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).status, 202);
	assert.match(s.injected[1]![0], /^ask-abcd: Keep\n\n\[cp-dashboard dc-.* — from the dashboard; ask=ask-abcd\]$/, "a click sends the verbatim label");
	assert.equal((await s.send(s.token, { kind: "answer", ask_id: "ask-bbbb", label: "Yes" })).status, 409, "an answered ask cannot be clicked");
	assert.equal(s.journal().filter((l) => l.by === "viewer").length, 0, "accepted sends and bridge refusals are the bridge's lines");
	assert.deepEqual(s.journal().filter((l) => l.type === "request").map((l) => [l.kind, l.peer]), [["message", "127.0.0.1"], ["answer", "127.0.0.1"], ["answer", "127.0.0.1"]], "the client address, never an identity");
	assert.equal((await s.send(s.token, { kind: "message", text: "y".repeat(16_000) })).status, 202, "16,000 characters fit the 20 KiB body");
	const full = (await s.get("/api/operator/control")).body, lean = (await s.get("/api/operator/control?sends=0")).body;
	assert.ok("sends" in full && "sends_error" in full, "the default read carries the composer's journal");
	assert.equal("sends" in lean || "sends_error" in lean, false);
	for (const key of ["token", "running", "recent"]) assert.deepEqual(lean[key], full[key], key);
	// x-cp-delta-base: a held version gets a keyed delta and its base echoed; an unknown base gets the full body.
	const version = String((await s.get("/api/operator/control?sends=0")).headers["x-cp-version"]);
	const delta = await s.get("/api/operator/control?sends=0", { headers: { "x-cp-delta-base": version } });
	assert.deepEqual([delta.status, delta.headers["x-cp-delta-base"], "token" in delta.body], [200, version, false], delta.text);
	const unknown = await s.get("/api/operator/control?sends=0", { headers: { "x-cp-delta-base": "v-gone" } });
	assert.deepEqual([unknown.headers["x-cp-delta-base"], unknown.body.token], [undefined, lean.token]);
});

test("P17-control-refusals: refusals come in order, each journaled once by the viewer; reads never write", { timeout: 180_000 }, async (t) => {
	const s = await live(t);
	pushConfig(s.stateDir);
	const refused = refusal(s.stateDir);
	await refused(s.send(s.token, { kind: "message", text: "x" }, { origin: "https://evil.example" }), 403, /^Origin must be https:\/\/cp\.example\.ts\.net$/);
	await refused(s.send(s.token, { kind: "message", text: "x" }, { "sec-fetch-site": "cross-site" }), 403, /cross-site/);
	await refused(s.send(s.token, "hello", { "content-type": "text/plain" }), 415, /application\/json/);
	await refused(s.send(s.token, { kind: "message", text: "z".repeat(21 * 1024) }), 413, /20480 bytes/, { text: null });
	assert.equal(typeof s.journal().at(-1)!.bytes, "number", "an oversized body records its size, never its bytes");
	await refused(s.send(s.token, { kind: "message", text: "q".repeat(16_001) }), 400, /longer than 16000/, { kind: "message" });
	await refused(s.send(s.token, "{not json"), 400, /not JSON/, { text: null });
	await refused(s.send(s.token, { kind: "shell", text: "rm" }), 400, /kind must be/);
	await refused(s.send(null, { kind: "message", text: "no token" }), 403, /control token missing or stale/, { kind: "message", text: "no token" });
	await refused(s.send("f".repeat(64), { kind: "answer", ask_id: "ask-abcd", label: "Keep" }), 403, /reload the transcript/, { kind: "answer", ask_id: "ask-abcd", text: "Keep" });
	assert.equal(s.injected.length, 0, "no refusal reached the session");

	// 20 per 60 s per client address, refusals included; only the first 429 of a window is journaled.
	s.fresh();
	for (let i = 0; i < 20; i++) await s.send(null, { kind: "message", text: `n${i}` });
	const limited = await refused(s.send(s.token, { kind: "message", text: "21st" }), 429, /too many dashboard requests: 20 per 60 s/);
	assert.ok(Number(limited.headers["retry-after"]) >= 1);
	const count = s.journal().length;
	assert.equal((await s.send(s.token, { kind: "message", text: "22nd" })).status, 429);
	assert.equal(s.journal().length, count, "repeated 429s in one window add no line");
	s.fresh();
	write(controlConfigFile(s.stateDir), '{"enabled": false}');
	await refused(s.send(s.token, { kind: "message", text: "x" }), 403, /dashboard control is off/);
	const off = (await s.get("/api/operator/control")).body;
	assert.deepEqual([off.enabled, off.token], [false, null], "off: the status carries no token");
	write(controlConfigFile(s.stateDir), '{"enabled": "maybe"}');
	await refused(s.send(s.token, { kind: "message", text: "x" }), 503, /config is invalid/);
	rmSync(controlConfigFile(s.stateDir));

	const before = readFileSync(controlJournalFile(s.stateDir), "utf8");
	for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await s.get(MESSAGE, { method })).status, 405, method);
	for (const path of ["/api/operator/control", "/api/sessions", "/api/overview", "/api/awaiting"]) assert.equal((await s.get(path, post(s.origin, null, {}))).status, 405, `POST ${path}`);
	for (let i = 0; i < 3; i++) await s.get("/api/sessions?view=you&transcript=1");
	assert.equal(readFileSync(controlJournalFile(s.stateDir), "utf8"), before, "405s, status and transcript reads leave the journal byte-identical");

	const plain = await dashboard(t, { requireTailnet: false });
	const guarded = [await plain.get(MESSAGE, post(plain.origin, "a".repeat(64), { kind: "message", text: "x" })), await plain.get("/api/operator/control")];
	for (const reply of guarded) assert.deepEqual([reply.status, /--require-tailnet/.test(String(reply.body.error))], [403, true]);
	assert.equal(guarded[1]!.body.sends, undefined, "sent text stays behind the same tailnet guard");
	assert.equal(existsSync(controlJournalFile(plain.stateDir)), false, "a refusal before the --require-tailnet guard is stderr-only");

	// A stand-in session socket: the status and transcript reads send it `status` frames and nothing else.
	const quiet = await dashboard(t);
	const frames: Json[] = [];
	const socket = controlSocketFile(quiet.stateDir);
	mkdirSync(dirname(socket), { recursive: true });
	const fake = createServer((c) => c.on("data", (chunk) => {
		for (const line of String(chunk).split("\n").filter(Boolean)) { frames.push(JSON.parse(line)); c.write(`${JSON.stringify({ v: 1, id: 1, ok: true, result: { busy: false, pending: false, session_file: "op.jsonl", recent: [] } })}\n`); }
	}));
	await new Promise<void>((done) => fake.listen(socket, done));
	t.after(() => fake.close());
	write(controlRecordFile(quiet.stateDir), { version: 1, pid: process.pid, socket, token: "b".repeat(64), csrf: "c".repeat(64), started_at: "2026-09-27T08:00:00Z" });
	for (let i = 0; i < 3; i++) {
		assert.equal((await quiet.get("/api/operator/control")).body.token, "c".repeat(64));
		await quiet.get("/api/sessions?view=you&transcript=1");
	}
	assert.deepEqual([...new Set(frames.map((f) => f.op))], ["status"]);
	assert.equal(existsSync(controlJournalFile(quiet.stateDir)), false);
	mkdirSync(controlJournalFile(quiet.stateDir), { recursive: true }); // a directory where the journal should be
	write(controlConfigFile(quiet.stateDir), '{"enabled": false}');
	const unwritten = await quiet.get(MESSAGE, post(quiet.origin, "a".repeat(64), { kind: "message", text: "x" }));
	assert.equal(unwritten.status, 403, "an unwritable journal never hides a refusal");
	assert.match(String(unwritten.body.audit), /^unwritten: /);
});

test("P17-control-origin: with no HTTPS origin only the bind's own origin writes; a proxy's own Host passes until strict_host", { timeout: 120_000 }, async (t) => {
	const s = await live(t);
	const at = (origin: string, host?: string, extra: Record<string, string> = {}, tok = s.token) => s.send(tok, { kind: "message", text: "x" }, { origin, ...(host ? { host } : {}), ...extra });
	assert.equal((await at(s.origin)).status, 202);
	assert.equal((await s.send(s.token, { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).status, 202, "and a click");
	for (const foreign of ["https://evil.example", `http://127.0.0.1:${s.port + 1}`, "null", ""]) {
		const out = await at(foreign);
		assert.equal(out.status, 403, foreign);
		assert.match(String(out.body.error), new RegExp(`^Origin must be http://127\\.0\\.0\\.1:${s.port} \\(no HTTPS origin is configured`));
	}
	assert.equal((await at(s.origin, undefined, { "sec-fetch-site": "cross-site" })).status, 403, "Sec-Fetch-Site still guards");
	assert.equal(s.injected.length, 2);
	const sub = await s.get("/api/push/subscription", { method: "POST", body: "{}", headers: { origin: s.origin, "content-type": "application/json" } });
	assert.equal(sub.status, 409, "push still needs push:init (HTTPS)");

	s.fresh();
	pushConfig(s.stateDir);
	const PROXY = "8766--dev--box.coder.example";
	for (const [host, origin] of [[undefined, s.origin], [undefined, ORIGIN], [PROXY, `https://${PROXY}`], [`${PROXY}:443`, `https://${PROXY}`], [PROXY, `http://${PROXY}`], [undefined, `https://127.0.0.1:${s.port}`]] as const) {
		assert.equal((await at(origin, host)).status, 202, `${host ?? "bind"} ${origin}`);
	}
	for (const origin of ["https://evil.example", `https://${PROXY}:8443`, `https://x.${PROXY}`, "null", ""]) assert.equal((await at(origin, PROXY)).status, 403, origin);
	assert.equal((await at(`https://${PROXY}`, PROXY, { "sec-fetch-site": "cross-site" })).status, 403, "Sec-Fetch-Site still guards");
	assert.equal((await at(`https://${PROXY}`, PROXY, {}, "0".repeat(64))).status, 403, "the CSRF token still guards");
	assert.equal(s.injected.length, 8);
	s.fresh();
	write(viewerConfigFile(s.stateDir), { strict_host: true });
	assert.equal((await at(`https://${PROXY}`, PROXY)).status, 421, "strict: the proxied name is refused before the route");
	const strict = await at(`https://127.0.0.1:${s.port}`);
	assert.equal(strict.status, 403, "strict: the configured list only, not Host-derived");
	assert.match(String(strict.body.error), /^Origin must be https:\/\/cp\.example\.ts\.net$/);
	assert.deepEqual([(await at(ORIGIN)).status, (await at(s.origin)).status], [202, 202], "strict: the configured origin and the loopback bind's own");
});

test("P17-control-offline: with no session sends and clicks are held under the inbox token, 20 at most; abort is 409; a dead pid is offline, a dead socket 503", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t);
	seedAsks(d.stateDir);
	const status = await d.get("/api/operator/control");
	assert.deepEqual(pick(status.body, ["enabled", "running", "token", "offline", "held"]), { enabled: true, running: false, token: null, offline: true, held: 0 });
	assert.match(String(status.body.reason), /^Operator session offline: no dashboard control record at .*dashboard\.json$/);
	const inbox = String(status.body.inbox_token);
	assert.match(inbox, /^[0-9a-f]{64}$/);
	assert.equal(existsSync(controlJournalFile(d.stateDir)), false, "the status route never writes");
	const send = (tok: string, body: unknown) => d.get(MESSAGE, post(d.origin, tok, body));
	const stale = await send("a".repeat(64), { kind: "message", text: "x" });
	assert.deepEqual([stale.status, lines(controlJournalFile(d.stateDir)).at(-1)!.status], [403, 403], "journaled by the viewer");
	assert.match(String(stale.body.error), /inbox token missing or stale/);
	const held = await send(inbox, { kind: "message", text: "  deploy when green  " });
	assert.deepEqual([held.status, held.body.state], [202, "held"]);
	assert.match(String(held.body.id), DC);
	assert.equal((await send(inbox, { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).status, 202);
	assert.deepEqual(lines(controlInboxFile(d.stateDir)).map((l) => [l.type, l.text, l.ask_id]), [["held", "deploy when green", null], ["held", "ask-abcd: Keep", "ask-abcd"]]);
	assert.equal((statSync(controlInboxFile(d.stateDir)).mode & 0o777).toString(8), "600");
	const abort = await send(inbox, { kind: "abort" });
	assert.equal(abort.status, 409);
	assert.match(String(abort.body.error), /nothing to abort; the operator session is offline/);
	assert.equal((await d.get("/api/operator/control")).body.held, 2);
	appendFileSync(controlInboxFile(d.stateDir), jsonl(Array.from({ length: 18 }, (_, i) => ({ type: "held", id: `dc-20260928000000-${String(i + 2).padStart(8, "0")}`, at: "2026-09-28T00:00:00Z", text: `m${i}`, ask_id: null }))));
	const full = await send(inbox, { kind: "message", text: "21st" });
	assert.equal(full.status, 409);
	assert.match(String(full.body.error), /already holds 20 messages/);
	record(d.stateDir, 2 ** 22 + 7);
	assert.equal((await d.get("/api/operator/control")).body.offline, true, "a record whose pid is gone is offline");
	record(d.stateDir, process.pid);
	const gone = await send("a".repeat(64), { kind: "message", text: "x" });
	assert.equal(gone.status, 503);
	assert.match(String(gone.body.error), /session not running: .* refused the connection \((ECONNREFUSED|ENOENT)\)/);
	assert.equal(lines(controlJournalFile(d.stateDir)).at(-1)!.status, 503);
});

test("P17-control-queue: busy sends wait editable until handed over; the queue survives restart; a lost claim or a 24 h wait fails and nothing is resent", { timeout: 180_000 }, async (t) => {
	let busy = false;
	const s = await live(t, { isIdle: () => !busy });
	const journal = controlJournalFile(s.stateDir);
	const sends = async () => (await s.get("/api/operator/control")).body.sends as Json[];
	const client_id = "dc-20261004140000-00000009";
	const accepted = await s.send(s.token, { kind: "message", text: "keep the queued text", thread: "layout", client_id });
	assert.equal(accepted.body.id, client_id, "the transcript marker can match before the POST acknowledgement");
	assert.equal((await s.send(s.token, { kind: "message", text: "duplicate", client_id })).status, 409);
	assert.equal((await s.send(s.token, { kind: "message", text: "invalid", client_id: "not-an-id" })).status, 400);
	assert.deepEqual((await sends()).map((x) => [x.id, x.body]), [[client_id, { kind: "message", text: "keep the queued text", thread: "layout" }]]);

	busy = true;
	const first = await s.send(s.token, { kind: "message", text: "first draft" });
	const second = await s.send(s.token, { kind: "message", text: "drop me" });
	assert.deepEqual([first.status, first.body.state, first.body.editable], [202, "queued", true]);
	assert.equal(s.injected.length, 1, "the dashboard holds them; pi is not given a followUp");
	const id = String(first.body.id);
	const mine = async () => (await sends()).filter((x) => x.id === id || x.id === second.body.id);
	assert.deepEqual((await mine()).map((x) => [x.body.text, x.editable]), [["first draft", true], ["drop me", true]]);
	const queue = (tok: string | null, body: unknown) => s.get(QUEUE, post(s.origin, tok, body));
	assert.equal((await queue(null, { op: "edit", id, text: "x" })).status, 403, "the session's CSRF token is required");
	assert.equal((await queue(s.token, { op: "edit", id })).status, 400);
	assert.equal((await queue(s.token, { op: "cancel", id, extra: 1 })).status, 400);
	assert.equal((await queue(s.token, { op: "cancel", id: "dc-20261004140000-0000000f" })).status, 404);
	const edited = await queue(s.token, { op: "edit", id, text: "final words" });
	assert.deepEqual([edited.status, edited.body.state, edited.body.text], [200, "queued", "final words"]);
	const cancelled = await queue(s.token, { op: "cancel", id: second.body.id });
	assert.deepEqual([cancelled.status, cancelled.body.state], [200, "cancelled"]);
	assert.deepEqual((await mine()).map((x) => [x.body.text, x.state, x.editable ?? false]), [["final words", "queued", true], ["drop me", "dropped", false]]);
	busy = false;
	s.control.settled();
	assert.match(s.injected.at(-1)![0], /^final words\n\n\[cp-dashboard /, "the saved text is what the session gets");
	const late = await queue(s.token, { op: "edit", id, text: "too late" });
	assert.deepEqual([late.status, late.body.state, late.body.text], [409, "sent", "final words"], "already sent, with the authoritative text");
	assert.match(String(late.body.error), /already sent/);
	assert.equal((await sends()).find((x) => x.id === id)?.editable, undefined, "no Edit once handed over");
	assert.equal(lines(journal).filter((l) => l.type === "refused" && l.kind === "queue").length, 5, "each refusal journaled once by the viewer");
	assert.deepEqual(lines(journal).filter((l) => l.id === id).map((l) => (l.type === "outcome" ? l.state : l.type)), ["request", "queued", "edited", "injected"]);

	// cp-y43c addendum 2: a claim the transcript never confirmed, a crash after a claim, and a 24 h wait.
	s.control.observe({ role: "user", content: s.injected.at(-1)![0] }); // the transcript shows "final words"
	busy = true;
	const claimed = await s.send(s.token, { kind: "message", text: "claimed, never seen" });
	busy = false;
	s.control.settled();
	assert.match(s.injected.at(-1)![0], /^claimed, never seen/, "handed to pi; the transcript never shows it");
	s.control.stop();
	const crashed = "dc-20261009120000-0000c0de", stale = "dc-20261009120000-00005a1e";
	const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
	appendFileSync(journal, jsonl([
		{ type: "request", by: "bridge", id: crashed, at: hoursAgo(1), kind: "message", text: "crash window", ask_id: null, deliver: "followUp", peer: null, session_started_at: hoursAgo(2), session_file: join(s.stateDir, "operator-session.jsonl") },
		{ type: "outcome", by: "bridge", id: crashed, at: hoursAgo(1), peer: null, state: "queued", reason: null },
		{ type: "outcome", by: "bridge", id: crashed, at: hoursAgo(1), peer: null, state: "injected", reason: null },
		{ type: "request", by: "bridge", id: stale, at: hoursAgo(25), kind: "message", text: "held too long", ask_id: null, deliver: "followUp", peer: null },
		{ type: "outcome", by: "bridge", id: stale, at: hoursAgo(25), peer: null, state: "queued", reason: null },
	]));
	const next = await operatorSession(t, s.stateDir);
	assert.equal(next.injected.length, 0, "the restarted bridge resends nothing: not the claimed, the crashed or the expired one");
	const row = (rows: Json[], key: unknown) => rows.find((x) => x.id === key)!;
	const after = await sends();
	assert.deepEqual([row(after, claimed.body.id).state, row(after, claimed.body.id).body.text], ["failed", "claimed, never seen"]);
	assert.match(row(after, claimed.body.id).reason, /^Not confirmed: target operator session ended\./);
	assert.deepEqual([row(after, crashed).state, row(after, crashed).body.text], ["failed", "crash window"]);
	assert.match(row(after, crashed).reason, /^Not confirmed: /);
	assert.deepEqual([row(after, stale).state, row(after, stale).body.text], ["failed", "held too long"]);
	assert.match(row(after, stale).reason, /^Not sent: queued longer than 24 h\. It was never given to the session\.$/);
	assert.ok(after.every((x) => !x.editable), "a failure is never editable");
	assert.equal(lines(journal).filter((l) => l.type === "outcome" && l.state === "injected" && (l.id === claimed.body.id || l.id === crashed)).length, 2, "one claim each; the expired one never reached pi");
	next.control.stop();

	// No session at all: the journal and the inbox still reconstruct the queue and its failures.
	const image = "im-20261004-0123456789abcdef01234567.png", attached = "dc-20261004140000-00000001", offline = "dc-20261004140100-00000002";
	appendFileSync(journal, jsonl([
		{ type: "request", by: "bridge", id: attached, at: "2026-10-04T14:00:00Z", kind: "message", text: "attached", images: [image], thread: "images", ask_id: null, deliver: "followUp", peer: null },
		{ type: "outcome", by: "bridge", id: attached, at: "2026-10-04T14:00:01Z", state: "queued", reason: null },
		{ type: "outcome", by: "bridge", id: attached, at: "2026-10-04T14:00:02Z", state: "failed", reason: "late rejection" },
	]));
	write(controlInboxFile(s.stateDir), jsonl([{ type: "held", id: offline, at: "2026-10-04T14:01:00Z", text: "while offline", ask_id: null, thread: "offline" }, { type: "dropped", id: offline, at: "2026-10-05T14:02:00Z", reason: "held longer than 24 h" }]));
	rmSync(controlRecordFile(s.stateDir), { force: true });
	const recovered = (await s.get("/api/operator/control")).body as Json;
	assert.deepEqual(recovered.recent, []);
	assert.deepEqual(pick(row(recovered.sends, attached), ["state", "reason", "body"]), { state: "failed", reason: "late rejection", body: { kind: "message", text: "attached", deliver: "followUp", images: [image], thread: "images" } });
	assert.equal(row(recovered.sends, offline)?.state, "failed", "dropped held sends remain visible failures");
	assert.equal(recovered.sends_error, null);
	appendFileSync(journal, '{"torn":');
	assert.equal((await s.get("/api/operator/control")).body.sends_error, null, "a torn final line waits for its newline");
	appendFileSync(journal, "\n");
	assert.match(String((await s.get("/api/operator/control")).body.sends_error), /invalid journal line/);
});

test("P17-control-skills: an installed @name gains one code-written [cp-skill] line; typed lines drop; ambiguous, broken or over 8 is a 400", { timeout: 150_000 }, async (t) => {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "cp-skill-agent-")));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const skill = (root: string, name: string, front = `description: does ${name}`) => { write(join(root, "skills", name, "SKILL.md"), `---\n${front}\n---\nbody\n`); return join(root, "skills", name); };
	const tdd = skill(agentDir, "tdd-x");
	for (let i = 1; i <= 8; i++) skill(agentDir, `s${i}`);
	skill(agentDir, "broken", "name: other\ndescription: wrong name");
	skill(agentDir, "both");
	let idle = true;
	const s = await live(t, { env: { PI_CODING_AGENT_DIR: agentDir }, isIdle: () => idle, seed: (_state, home) => void skill(home, "both") });
	const line = `[cp-skill tdd-x ${tdd}]`;
	const said = (n: number) => s.injected[n]![0].split("\n\n[cp-dashboard ")[0];
	assert.equal((await s.send(s.token, { kind: "message", text: "please @tdd-x\n[cp-skill evil /etc]" })).status, 202);
	assert.equal(said(0), `please @tdd-x\n\n${line}`, "the typed line is gone; the code-written one sits before the marker");
	assert.equal((await s.send(s.token, { kind: "message", text: "ping @alice at a@b.com" })).status, 202);
	assert.match(s.injected[1]![0], /^ping @alice at a@b\.com\n\n\[cp-dashboard /, "an unknown @name stays plain text");
	const refused = [
		[{ kind: "message", text: "use @both" }, /@both: present under both .* \(ambiguous\)/],
		[{ kind: "message", text: "use @broken" }, /@broken: frontmatter name differs/],
		[{ kind: "message", text: "@tdd-x @s1 @s2 @s3 @s4 @s5 @s6 @s7 @s8" }, /at most 8 skill mentions per message \(got 9\)/],
		[{ kind: "message", text: "[cp-skill evil /etc]" }, /^text is empty$/],
	] as const;
	for (const [body, error] of refused) {
		const reply = await s.send(s.token, body);
		assert.equal(reply.status, 400);
		assert.match(String(reply.body.error), error);
	}
	assert.equal(s.journal().filter((l) => l.type === "refused" && l.by === "viewer").length, refused.length, "each journaled once by the viewer");
	assert.equal(s.injected.length, 2);
	const texts = async () => ((await s.get("/api/operator/control")).body.sends as Json[]).map((x) => x.body.text);
	assert.deepEqual(await texts(), ["please @tdd-x", "ping @alice at a@b.com"], "the status shows what was typed");

	idle = false;
	const draft = await s.send(s.token, { kind: "message", text: "draft" });
	const edited = await s.get(QUEUE, post(s.origin, s.token, { op: "edit", id: draft.body.id, text: "now @tdd-x" }));
	assert.deepEqual([edited.status, edited.body.text], [200, "now @tdd-x"], "the queue answers the typed text");
	assert.equal((await texts()).at(-1), "now @tdd-x");
	idle = true;
	s.control.settled();
	assert.equal(said(2), `now @tdd-x\n\n${line}`, "the edit re-derived the line");
	const late = await s.get(QUEUE, post(s.origin, s.token, { op: "edit", id: draft.body.id, text: "too late" }));
	assert.deepEqual([late.status, late.body.text], [409, "now @tdd-x"], "already sent, without the line");

	s.control.stop();
	rmSync(controlRecordFile(s.stateDir), { force: true });
	const inbox = String((await s.get("/api/operator/control")).body.inbox_token);
	assert.equal((await s.send(inbox, { kind: "message", text: "later @tdd-x" })).status, 202);
	assert.equal(lines(controlInboxFile(s.stateDir))[0]!.text, `later @tdd-x\n\n${line}`, "the inbox holds the line for the next session");
});

/** A `node` script standing in for tmux or herdr: each call is a calls.jsonl line; replies.json scripts its answer. */
const FAKE_TOOL = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const self = process.argv[1], dir = path.dirname(self), name = path.basename(self), argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ self, name, argv, env: name === "tmux" ? process.env : undefined }) + "\\n");
const file = path.join(dir, "replies.json");
const reply = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {})[[name, ...argv.slice(0, 2)].join(" ")] ?? {};
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
if (reply.sleep) setTimeout(() => process.exit(reply.status ?? 0), reply.sleep);
else process.exit(reply.status ?? 0);
`;

/** A user whose PATH holds only node, dirname and the fake `tools`, with a hostile-path `~/.local/bin/cp-operator`. */
function toolbox(t: TestContext, tools: readonly string[], { wrapper = true, role = "viewer" as string | null } = {}) {
	const user = mkdtempSync(join(tmpdir(), "cp herdr'$(false)-"));
	t.after(() => rmSync(user, { recursive: true, force: true }));
	const bin = join(user, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "node"));
	symlinkSync(["/usr/bin/dirname", "/bin/dirname"].find((file) => existsSync(file))!, join(bin, "dirname"));
	for (const tool of tools) { writeFileSync(join(bin, tool), FAKE_TOOL); chmodSync(join(bin, tool), 0o755); }
	const wrapperPath = join(user, ".local", "bin", "cp-operator");
	if (wrapper) write(wrapperPath, "#!/bin/sh\n");
	return {
		bin, wrapper: wrapperPath,
		env: { PATH: bin, HOME: user, MARK: "kept", ...(role ? { CP_DAEMON_ROLE: role } : {}) },
		reply: (replies: Json) => write(join(bin, "replies.json"), replies),
		calls: () => lines(join(bin, "calls.jsonl")),
	};
}

/** Asserts a refused start: its status and reason, journaled as a `refused` line of kind `start`. */
const startRefusal = (stateDir: string) => async (reply: Promise<Reply>, code: number, reason: RegExp) => {
	const out = await reply;
	assert.equal(out.status, code, JSON.stringify(out.body));
	assert.match(String(out.body.error), reason);
	assert.deepEqual(pick(lines(controlJournalFile(stateDir)).at(-1)!, ["type", "kind", "status"]), { type: "refused", kind: "start", status: code });
	return out;
};

/** Asserts every start answers 503 unavailable for `why`, journals it, and runs nothing. */
async function unavailable(t: TestContext, box: ReturnType<typeof toolbox>, why: RegExp, d?: Awaited<ReturnType<typeof dashboard>>) {
	const view = d ?? await dashboard(t, { env: box.env });
	const status = (await view.get("/api/operator/control")).body;
	assert.deepEqual([status.launchers, status.resume], [{ tmux: false, herdr: false }, { tmux: false, herdr: false }]);
	assert.match(String(status.start_unavailable), new RegExp(`${why.source.replace(/\$$/, "")}.*; herdr is not on PATH$`));
	const before = box.calls().length;
	for (const [body, reason] of [[TMUX, why], [{ ...TMUX, resume: true }, why], [HERDR, /^herdr is not on PATH$/]] as const) {
		const out = await view.get(START, post(view.origin, String(status.inbox_token), body));
		assert.deepEqual([out.status, out.body.state, out.body.via], [503, "unavailable", body.via], JSON.stringify(out.body));
		assert.match(String(out.body.reason), reason);
		assert.deepEqual(pick(lines(controlJournalFile(view.stateDir)).at(-1)!, ["type", "state", "via"]), { type: "start", state: "unavailable", via: body.via });
	}
	assert.equal(box.calls().length, before, "nothing ran");
}

test("P17-start-tmux: Start session refuses in order, then runs one fixed tmux argv with the viewer's env minus CP_DAEMON_*, once per 60 s; unavailable runs nothing", { timeout: 240_000 }, async (t) => {
	const box = toolbox(t, ["tmux"]);
	const d = await dashboard(t, { env: box.env });
	const fresh = windows(d);
	const status = (await d.get("/api/operator/control")).body;
	assert.deepEqual([status.launchers, status.resume, status.start_unavailable], [{ tmux: true, herdr: false }, { tmux: true, herdr: false }, null], "no herdr: only tmux is offered");
	const inbox = String(status.inbox_token);
	const start = (body: unknown, extra?: Record<string, string>, tok = inbox) => d.get(START, post(d.origin, tok, typeof body === "string" ? body : JSON.stringify(body), extra));
	const refused = startRefusal(d.stateDir);
	assert.equal((await d.get(START)).status, 405, "GET");
	await refused(start(TMUX, { origin: "https://evil.example" }), 403, /Origin must be/);
	await refused(start(TMUX, { "sec-fetch-site": "cross-site" }), 403, /cross-site/);
	await refused(start(TMUX, { "content-type": "text/plain" }), 415, /application\/json/);
	await refused(start("{nope"), 400, /not JSON/);
	for (const body of [{}, { via: "screen" }, { via: "TMUX" }, { via: ["tmux"] }, { via: "tmux", unit: "evil.service" }, { argv: ["rm", "-rf"] }, ["tmux"], "tmux", null]) {
		assert.ok(await refused(start(JSON.stringify(body)), 400, /body must be \{"via": "herdr"\} or \{"via": "tmux"\}/));
	}
	await refused(start(TMUX, {}, "b".repeat(64)), 403, /inbox token missing or stale/);
	fresh();
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	await refused(start(TMUX), 403, /dashboard control is off/);
	rmSync(controlConfigFile(d.stateDir));
	record(d.stateDir, process.pid);
	for (const body of [TMUX, HERDR]) {
		const already = await refused(start(body), 409, /already running \(pid \d+\)/);
		assert.deepEqual([already.body.state, already.body.via, lines(controlJournalFile(d.stateDir)).at(-1)!.via], ["already_running", body.via, body.via]);
	}
	rmSync(controlRecordFile(d.stateDir));
	assert.deepEqual(box.calls(), [], "no refusal reached tmux");

	const started = await start(TMUX, { "x-unit": "evil.service" });
	assert.deepEqual([started.status, started.body], [202, { state: "starting", via: "tmux" }]);
	const [ran] = box.calls();
	assert.deepEqual([ran!.self, ran!.argv], [join(box.bin, "tmux"), ["new-session", "-d", "-s", "cp-operator", box.wrapper]], "the absolute tmux, the fixed argv, nothing from the request");
	assert.deepEqual([ran!.env.CP_DAEMON_ROLE, ran!.env.MARK, ran!.env.HOME], [undefined, "kept", box.env.HOME], "the viewer's env minus CP_DAEMON_*");
	assert.deepEqual(pick(lines(controlJournalFile(d.stateDir)).at(-1)!, ["type", "state", "via"]), { type: "start", state: "starting", via: "tmux" }, "one audit line per start");
	await refused(start(TMUX), 429, /one start per 60 s/);
	assert.equal(box.calls().length, 1);

	fresh();
	box.reply({ "tmux new-session -d": { status: 1, stderr: "duplicate session: cp-operator" } });
	const duplicate = await refused(start(TMUX), 409, /tmux session cp-operator already runs: tmux attach -t cp-operator/);
	assert.deepEqual([duplicate.body.state, duplicate.body.via], ["already_running", "tmux"]);
	fresh();
	box.reply({ "tmux new-session -d": { status: 1, stderr: "no server running on /tmp/tmux-1000/default\nmore" } });
	const failed = await start(TMUX);
	assert.deepEqual([failed.status, failed.body.state, failed.body.reason], [503, "unavailable", `${join(box.bin, "tmux")} new-session -d exited 1: no server running on /tmp/tmux-1000/default`]);

	fresh();
	box.reply({});
	for (const body of [{ via: "tmux", resume: false }, { via: "tmux", resume: "true" }, { via: "tmux", resume: true, argv: ["-c"] }, { resume: true }]) assert.equal((await start(body)).status, 400, JSON.stringify(body));
	const resumed = await start({ via: "tmux", resume: true });
	assert.deepEqual([resumed.status, resumed.body], [202, { state: "starting", via: "tmux", resume: true }]);
	assert.deepEqual(box.calls().at(-1)!.argv, ["new-session", "-d", "-s", "cp-operator", box.wrapper, "-c"], "the wrapper with the fixed -c");
	assert.deepEqual(pick(lines(controlJournalFile(d.stateDir)).at(-1)!, ["type", "state", "via", "resume"]), { type: "start", state: "starting", via: "tmux", resume: true });
	fresh();
	for (let i = 0; i < 20; i++) await start(TMUX, {}, "b".repeat(64));
	await refused(start(TMUX), 429, /too many dashboard requests/);

	fresh();
	rmSync(box.wrapper);
	await unavailable(t, box, new RegExp(`^${box.wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not installed: rerun cp-install$`), d);
	rmSync(join(box.bin, "tmux"));
	await unavailable(t, box, /^tmux is not on PATH: install tmux/, d);
	await unavailable(t, toolbox(t, ["tmux"], { role: null }), /^Start in tmux needs the cp-daemon-run dashboard: rerun cp-install$/);
	await unavailable(t, toolbox(t, ["tmux"], { role: "health" }), /^Start in tmux needs the cp-daemon-run dashboard/);
});

test("P17-start-herdr: Start in herdr checks the server, creates the workspace and types one quoted command; down is unavailable; failed or hung calls end", { timeout: 240_000 }, async (t) => {
	const box = toolbox(t, ["herdr"], { role: null });
	const created = { stdout: JSON.stringify({ result: { workspace: { workspace_id: "w_7" }, root_pane: { pane_id: "p_7" } } }) };
	const up = { "herdr status server": { stdout: JSON.stringify({ status: "running", running: true }) }, "herdr workspace create": created };
	box.reply(up);
	const d = await dashboard(t, { env: box.env });
	const fresh = windows(d);
	const herdr = box.calls;
	const status = (await d.get("/api/operator/control")).body;
	assert.deepEqual([status.launchers, status.start_unavailable], [{ tmux: false, herdr: true }, null], "herdr binary and server: offered");
	await d.get("/api/operator/control");
	assert.equal(herdr().length, 1, "the server check is cached");
	const inbox = String(status.inbox_token);
	const start = (body: unknown, extra?: Record<string, string>) => d.get(START, post(d.origin, inbox, body, extra));

	box.reply({ "herdr status server": { stdout: JSON.stringify({ status: "stopped", running: false }) } });
	fresh();
	const down = (await d.get("/api/operator/control")).body;
	assert.deepEqual(down.launchers, { tmux: false, herdr: false }, "a check older than 30 s is redone");
	assert.match(String(down.start_unavailable), /herdr server not running/);
	const refused = await start(HERDR);
	assert.deepEqual([refused.status, refused.body], [503, { state: "unavailable", via: "herdr", reason: "herdr server not running" }]);
	assert.ok(!herdr().some((c) => c.argv[0] === "workspace"), "server down: no workspace");

	box.reply(up);
	const from = herdr().length;
	const started = await start(HERDR, { "x-cwd": "/etc", "x-label": "evil" });
	assert.deepEqual([started.status, started.body], [202, { state: "starting", via: "herdr" }]);
	const quoted = `'${box.wrapper.replace(/'/g, "'\\''")}'`;
	assert.deepEqual(herdr().slice(from).map((c) => [c.self, ...c.argv]), [
		[join(box.bin, "herdr"), "status", "server", "--json"],
		[join(box.bin, "herdr"), "workspace", "create", "--cwd", d.home, "--label", "cp-operator", "--env", `CP_HOME=${d.home}`, "--no-focus"],
		[join(box.bin, "herdr"), "pane", "run", "p_7", quoted],
	], "the fixed argv; the pane id parsed from the workspace JSON; nothing from the request");
	assert.deepEqual(pick(lines(controlJournalFile(d.stateDir)).at(-1)!, ["type", "state", "via"]), { type: "start", state: "starting", via: "herdr" });
	const words = (command: string) => execFileSync("/bin/sh", ["-c", `for w in ${command}; do printf '%s\\n' "$w"; done`], { encoding: "utf8" }).trimEnd().split("\n");
	assert.deepEqual(words(herdr().at(-1)!.argv[3]), [box.wrapper], "one argv element; the pane's shell splits it back into the exact word");

	fresh();
	const resumed = await start({ via: "herdr", resume: true });
	assert.deepEqual([resumed.status, resumed.body], [202, { state: "starting", via: "herdr", resume: true }]);
	assert.deepEqual(herdr().at(-1)!.argv, ["pane", "run", "p_7", `${quoted} '-c'`], "the wrapper with the fixed -c, one quoted command");
	assert.deepEqual(words(herdr().at(-1)!.argv[3]), [box.wrapper, "-c"]);

	fresh();
	box.reply({ ...up, "herdr pane run": { status: 1, stderr: "pane p_7 is gone" } });
	const failed = await start(HERDR);
	assert.deepEqual([failed.status, failed.body.state], [503, "unavailable"]);
	assert.match(String(failed.body.reason), /herdr pane run exited 1: pane p_7 is gone/);
	assert.deepEqual(herdr().at(-1)!.argv, ["workspace", "close", "w_7"], "a failed pane run closes the workspace it created");
	const closed = () => herdr().at(-1)!.argv.join(" ") === "workspace close w_7";
	const control = () => d.get("/api/operator/control").then((r) => (r.body.launchers as Json).herdr === false);
	for (const [hang, check] of [["herdr pane run", () => start(HERDR).then((r) => r.status === 503 && closed())], ["herdr workspace create", () => start(HERDR).then((r) => r.status === 503)], ["herdr status server", control]] as const) {
		fresh();
		box.reply({ ...up, [hang]: { sleep: 60_000 } });
		const at = Date.now();
		assert.deepEqual([await check(), Date.now() - at < 30_000], [true, true], `${hang} past 10 s is killed`);
	}
});

const OPERATOR = "#sessions?view=you&transcript=1", RESTART = "/api/operator/restart";
const XSS = "<img src=x onerror=alert(1)>";
const choice = (question: string, labels: string[]) => ({ project: "demo", question, options: labels.map((label) => ({ label, consequence: `${label} it` })), recommendation: labels[0]! });
const posts = (tab: Tab, path: string) => tab.requests.filter((r) => r.method === "POST" && r.path === path);
const bar = (tab: Tab, ok: (b: Element) => boolean = () => true) => tab.find(".session-pinned h2 button", ok);

test("P17-composer: open asks pin above the composer behind one remembered toggle; it sends, steers and aborts; off or gone, it says why", { timeout: 180_000 }, async (t) => {
	let busy = false;
	const d = await dashboard(t);
	const asks = new OperatorAsks(join(d.stateDir, "operator", "asks.jsonl"));
	const first = asks.open(choice("Keep paused?", ["Keep", "Raise"]));
	const merge = asks.open(choice("Merge now?", ["Yes", "No"]));
	const gone = asks.open(choice("Old?", ["Drop"]));
	asks.withdraw(gone.id, "No longer needed");
	// The transcript's cp_parent ask calls place the first ask's card and the withdrawn one inline, as history.
	const transcript = join(d.home, "operator-transcript.jsonl"), line = (m: unknown) => JSON.stringify({ type: "message", timestamp: AT, message: m });
	write(transcript, [first.id, gone.id].flatMap((id) => [line({ role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "cp_parent", arguments: { action: "ask" } }] }), line({ role: "toolResult", toolCallId: `call-${id}`, toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id }) }] })]).join("\n") + "\n");
	write(operatorSessionsFile(join(d.stateDir, "sessions")), `${JSON.stringify({ at: AT, session_file: transcript })}\n`);
	const session = await operatorSession(t, d.stateDir, () => !busy);
	let tab = await d.open(OPERATOR);
	const toggle = await bar(tab);
	assert.deepEqual([toggle.textContent, toggle.getAttribute("aria-expanded"), toggle.closest("section")!.getAttribute("aria-label")], ["2 decisions waiting ▾", "false", "Open decisions"]);
	const html = tab.root.innerHTML;
	assert.ok(html.indexOf("session-pinned") < html.indexOf("operator-composer"), "the pinned block sits directly above the composer");
	assert.deepEqual(tab.$$(".session-ask-pointer, .session-ask-settled").map((p) => p.textContent), ["open, answer below", "Withdrawn: No longer needed", "open, answer below"], "inline cards are history");
	assert.equal(tab.$$(".session-pinned button.decision-card-option").length, 4, "one button per option, per card");
	assert.deepEqual([tab.$(".session-pinned .decision-card-recommended .overview-rec-badge")?.textContent, tab.$(".session-pinned a.glossary-link")?.getAttribute("href")], ["recommended", "https://github.com/0xb1ob/picp#words-you-will-see"]);
	assert.equal(tab.storage.get("cp-sessions-pinned-open"), undefined, "nothing remembered before the operator chooses");
	tab.click(toggle);
	await bar(tab, (b) => b.getAttribute("aria-expanded") === "true");
	assert.equal(tab.storage.get("cp-sessions-pinned-open"), "1");
	tab = await tab.reopen();
	tab.click(await bar(tab, (b) => b.getAttribute("aria-expanded") === "true"));
	await until(() => tab.storage.get("cp-sessions-pinned-open"), (v) => v === "0", "the collapsed choice");
	asks.answer(first.id, "Keep");
	tab.refresh();
	assert.equal((await bar(tab, (b) => b.textContent === "1 decision waiting ▾")).getAttribute("aria-expanded"), "false", "an ask leaving never opens it");
	assert.match((await tab.find(".session-ask-settled", (p) => /^Answered/.test(p.textContent ?? ""))).textContent ?? "", /^Answered: Keep · /);
	const replies = await tab.find(".session-entries > .session-replies");
	assert.deepEqual([replies.querySelector(".session-replies-to")?.textContent, ...[...replies.querySelectorAll("button.session-reply")].map((b) => b.textContent)], [`Options from ${merge.id}: Merge now?`, "Yes", "No"], "the one carded open ask's quick replies");
	const sheet = (await tab.find("details.session-bar-more .session-bar-file")).closest(".session-bar-sheet")!;
	assert.deepEqual([sheet.parentElement?.querySelector("summary")?.getAttribute("aria-label"), sheet.querySelector('.session-bar-views a[aria-current="page"]')?.textContent, [...sheet.querySelectorAll("button")].some((b) => b.textContent === "Search"), sheet.querySelector(".session-bar-state .session-dot")?.getAttribute("class")], ["More", "Operator ↔ you", true, "session-dot session-dot-idle"], "the ⋯ sheet");
	assert.match(sheet.querySelector(".session-bar-file")?.textContent ?? "", /^Delivers to \S+\.jsonl$/);
	assert.deepEqual([[404, 401, 403].includes(tab.requests.find((r) => r.path === "/api/devices/notices")?.status ?? 0), tab.$(".device-notices")?.outerHTML], [true, undefined], "off: no notices");
	asks.open(choice("Tag it?", ["Yes"]));
	tab.refresh();
	const opened = await bar(tab, (b) => b.textContent === "2 decisions waiting ▾" && b.getAttribute("aria-expanded") === "true");
	assert.equal(tab.storage.get("cp-sessions-pinned-open"), "0", "a new ask id opened it by itself; that is not the operator's choice");
	tab.click(opened);
	await bar(tab, (b) => b.getAttribute("aria-expanded") === "false");
	asks.open(choice("Ship it?", ["Yes"]));
	tab = await tab.reopen();
	await bar(tab, (b) => b.textContent === "3 decisions waiting ▾" && b.getAttribute("aria-expanded") === "true");
	// A browser whose storage refuses writes: the bar still toggles for this view and the refusal is a warning.
	const warn = t.mock.method(console, "warn", () => {});
	const refusing = new (class extends Map<string, string> { override set(): this { throw new Error("QuotaExceededError"); } })();
	const strict = await openTab(t, d.port, OPERATOR, refusing);
	strict.click(await bar(strict, (b) => b.getAttribute("aria-expanded") === "false"));
	assert.ok(await bar(strict, (b) => b.getAttribute("aria-expanded") === "true"), "the toggle still works");
	assert.ok(warn.mock.calls.some((c) => c.arguments[0] === "decisions bar not persisted: QuotaExceededError"), "the refused write warns");
	strict.close();
	warn.mock.restore();
	const held = await d.open(OPERATOR, /^\/api\/operator\/message$/);
	held.click(await held.find(".session-pinned button.decision-card-option", (b) => !b.hasAttribute("disabled")));
	assert.equal((await held.find(".decision-card-delivery")).textContent, "Sending — the card closes when the session records the answer");
	held.release();
	await until(() => posts(held, MESSAGE), (rows) => rows.length === 1, "the held answer");
	held.close();

	const field = await tab.find("textarea");
	assert.deepEqual([field.getAttribute("aria-label"), field.getAttribute("placeholder")], ["Message to the operator session", "Message Operator…"]);
	assert.match(field.outerHTML, /maxlength="16000"/i);
	assert.equal(tab.$(".operator-composer-more")?.outerHTML, undefined, "no steer or abort while idle");
	assert.equal(tab.$(".operator-composer-options p")?.textContent, "Delivers to the running session operator-session.jsonl");
	assert.deepEqual([tab.$(".operator-composer-send")!.getAttribute("aria-label"), tab.$(".operator-composer-send")!.hasAttribute("disabled")], ["Send", true]);
	tab.type(field, "hello from the tab");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	await tab.find(".session-pending-live", (p) => /^Message at \d\d:\d\d: (delivered|queued)/.test(p.textContent ?? ""));
	const token = String((await d.get("/api/operator/control")).body.token);
	assert.deepEqual(posts(tab, MESSAGE).map((r) => [pick(JSON.parse(r.body!), ["kind", "text", "deliver"]), r.headers["x-cp-control-token"], r.status]), [[{ kind: "message", text: "hello from the tab", deliver: undefined }, token, 202]]);
	assert.match(session.injected.at(-1)![0], /^hello from the tab\n\n\[cp-dashboard /);

	busy = true;
	tab = await tab.reopen();
	assert.ok(await tab.find(".operator-composer-send", (b) => b.getAttribute("aria-label") === "Send after this turn"), "busy: follow-up");
	await tab.waitText(/Session busy — send after this turn, steer, or abort/);
	assert.equal(tab.$("header.session-bar .session-bar-state .session-dot")?.getAttribute("class"), "session-dot session-dot-working", "busy: the bar's dot");
	assert.deepEqual(tab.$$(".operator-composer-menu button").map((b) => b.textContent), ["Steer now", "Abort turn"]);
	tab.type(tab.$("textarea")!, "steer this way");
	tab.click(await tab.find(".operator-composer-menu button", (b) => b.textContent === "Steer now" && !b.hasAttribute("disabled")));
	await until(() => session.injected.at(-1), (row) => row?.[1] === "steer", "the steer");
	assert.match(session.injected.at(-1)![0], /^steer this way\n\n/);
	tab.click(await tab.find(".operator-composer-abort", (b) => !b.hasAttribute("disabled")));
	tab.click(await tab.find(".operator-composer-abort", (b) => b.textContent === "Tap again to abort" && !b.hasAttribute("disabled")));
	await until(() => posts(tab, MESSAGE).map((r) => JSON.parse(r.body!).kind), (kinds) => kinds.at(-1) === "abort", "the abort, after its second tap");

	busy = false;
	write(controlConfigFile(d.stateDir), '{"enabled": false}');
	tab = await tab.reopen();
	assert.ok(await tab.waitText(/Dashboard control is off/), "off: the reason");
	assert.equal(tab.$("textarea")?.outerHTML, undefined);
	assert.ok(tab.$$(".session-pinned button.decision-card-option").every((b) => b.hasAttribute("disabled")), "the cards stay, disabled");
	rmSync(controlConfigFile(d.stateDir));
	for (const hash of ["#sessions?view=parent", "#sessions?view=workers"]) {
		tab = await tab.reopen(hash);
		await tab.find("header.session-bar");
		assert.equal(tab.$(".operator-composer")?.outerHTML, undefined, `${hash}: no composer`);
	}
	tab = await tab.reopen(OPERATOR);
	const live = await tab.find("textarea");
	// A new session rotates the CSRF token under the open tab: its next send fails with the server's reason.
	session.control.stop();
	const next = await operatorSession(t, d.stateDir);
	const from = tab.requests.length, reads = () => tab.requests.slice(from).filter((r) => r.method === "GET" && r.path === "/api/operator/control" && r.read).length;
	tab.type(live, "after a new session");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	assert.ok(await tab.find(".session-pending-failed .session-pending-detail", (p) => p.textContent === "Failed: control token missing or stale; reload the transcript"), "stale 403");
	// The failed send re-reads the status (it learns the new token). Killing the session before the app has taken that
	// reply in flips the composer away or leaves the old token. The token has no DOM effect, so wait on `read`.
	await until(reads, (n) => n > 0, "the status re-read after the stale send");
	const record = readFileSync(controlRecordFile(d.stateDir), "utf8");
	next.control.stop();
	writeFileSync(controlRecordFile(d.stateDir), record);
	tab.type(await tab.find("textarea"), "into a dead socket");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	const failure = await tab.find(".session-pending-failed .session-pending-detail", (p) => /^Failed: session not running: /.test(p.textContent ?? ""));
	assert.ok(failure.closest(".session-pending-failed")!.querySelector(".session-pending-again"), "a failed send offers Send again");
});

test("P17-composer-start: offline the composer holds a message and offers each launcher; Start in tmux opens the composer once a session serves", { timeout: 180_000 }, async (t) => {
	const box = toolbox(t, ["tmux", "herdr"]);
	box.reply({ "herdr status server": { stdout: JSON.stringify({ status: "running", running: true }) } });
	const d = await dashboard(t, { env: box.env });
	let tab = await d.open(OPERATOR);
	await tab.find(".operator-composer", (s) => /Operator session offline/.test(s.textContent ?? ""));
	assert.deepEqual(tab.$$(".start-session-button").map((b) => b.textContent), ["Start in herdr", "Start in tmux", "Resume last session in herdr", "Resume last session in tmux"]);
	for (const said of [/open herdr → workspace cp-operator/, /attach from a terminal: tmux attach -t cp-operator/, /Resume continues this home's most recent operator session \(cp-operator -c\); with none, it starts a fresh one/]) assert.match(tab.text(), said);
	assert.deepEqual([tab.$(".operator-composer-more")?.outerHTML, tab.$(".operator-restart")?.outerHTML], [undefined, undefined], "offline: no steer, abort or restart");
	tab.type(await tab.find("textarea"), "deploy when green");
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	await tab.find(".session-pending-detail", (p) => p.textContent === "Held until an operator session attaches");
	const inbox = String((await d.get("/api/operator/control")).body.inbox_token);
	assert.deepEqual(posts(tab, MESSAGE).map((r) => [r.headers["x-cp-control-token"], r.status]), [[inbox, 202]], "held with the inbox token");
	assert.deepEqual(lines(controlInboxFile(d.stateDir)).map((l) => [l.type, l.text]), [["held", "deploy when green"]]);
	tab = await tab.reopen();
	assert.ok(await tab.waitText(/Operator session offline · 1 held — a message waits here until a session attaches/));
	const overview = await d.open("#overview");
	await overview.find(".overview-services .start-session-button");
	assert.equal(overview.$$(".overview-chip strong").find((s) => /^offline/.test(s.textContent ?? ""))?.textContent, "offline · 1 held");
	assert.deepEqual(overview.$$(".overview-services .start-session-button").map((b) => b.textContent), ["Start in herdr", "Start in tmux", "Resume last session in herdr", "Resume last session in tmux"]);
	overview.close();

	tab.click(await tab.find(".start-session-button", (b) => b.textContent === "Start in tmux"));
	await tab.find(".start-session-button", (b) => b.textContent === "Starting…" && b.hasAttribute("disabled"));
	await tab.waitText(/Starting the operator session… the composer opens when it serves the dashboard/);
	assert.ok(tab.$("textarea")!.hasAttribute("disabled"), "the composer waits for the live session");
	const started = await until(() => posts(tab, START), (rows) => rows.length > 0, "the start POST");
	assert.deepEqual(started.map((r) => [r.body, r.headers["x-cp-control-token"], r.status]), [['{"via":"tmux"}', inbox, 202]]);
	assert.deepEqual(box.calls().filter((c) => c.name === "tmux").map((c) => c.argv), [["new-session", "-d", "-s", "cp-operator", box.wrapper]]);
	// No session serves within the tab's 60 s: Start fails, saying where to look; past the viewer's window it reruns.
	tab.shift(61_000);
	assert.match((await tab.find(".start-session-failed")).textContent ?? "", /^Start failed: no session served the dashboard within 60 s; attach from a terminal: tmux attach -t cp-operator to see why$/);
	// Inside the viewer's 60 s window a click is a 429, a failed tmux a 503; a duplicate session keeps waiting.
	const again = async () => tab.click(await tab.find(".start-session-button", (b) => b.textContent === "Start in tmux"));
	const assertFailed = async (said: RegExp) => assert.match((await tab.find(".start-session-failed", (p) => said.test(p.textContent ?? ""))).textContent ?? "", said);
	const later = (s: number) => d.pin(new Date(Date.now() + s * 1000).toISOString());
	await again();
	await assertFailed(/^Start failed: one start per 60 s; retry in \d+ s$/);
	later(61);
	box.reply({ "tmux new-session -d": { status: 1, stderr: "no server running on /tmp/tmux-1000/default\nmore" } });
	await again();
	await assertFailed(/^Start failed: .*new-session -d exited 1: no server running on \/tmp\/tmux-1000\/default$/);
	later(122);
	box.reply({ "tmux new-session -d": { status: 1, stderr: "duplicate session: cp-operator" } });
	const seen = tab.requests.length, sent = posts(tab, START).length;
	await again();
	// The status is the new POST's own; `.at(-1)` before its reply lands reads the previous click's 503.
	await until(() => posts(tab, START).length, (n) => n > sent, "the duplicate start's reply");
	await until(() => tab.requests.slice(seen).filter((r) => r.method === "GET" && r.path.startsWith("/api/operator/control")).length, (n) => n >= 2, "the re-read");
	assert.deepEqual([posts(tab, START).at(-1)!.status, tab.$(".start-session-line")?.textContent], [409, "Starting the operator session… the composer opens when it serves the dashboard"]);
	tab.shift(61_000);
	await assertFailed(/^Start failed: no session served the dashboard within 60 s/);
	later(183);
	box.reply({});
	tab.click(await tab.find(".start-session-button", (b) => b.textContent === "Start in tmux"));
	await tab.find(".start-session-button", (b) => b.textContent === "Starting…");
	await operatorSession(t, d.stateDir);
	assert.ok(await tab.find("textarea", (f) => !f.hasAttribute("disabled"), 30_000), "running opens the composer");
	assert.equal(tab.$(".start-session-button")?.outerHTML, undefined, "running: no Start session");

	// The Overview alarm: a check failing 16 min and a relay unseen 11 min raise a line each; 14 min failing does not.
	const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
	const none = await dashboard(t, { env: toolbox(t, [], { role: null }).env, seed: (stateDir) => {
		write(join(stateDir, "health.json"), { schema_version: 1, last_run_at: ago(1), checks: { disk: { status: "fail", detail: "3 GiB", since: ago(16) }, gh: { status: "fail", detail: "401", since: ago(14) } } });
		write(join(stateDir, "operator", "relay-outbox.json"), { schema_version: 1, updated_at: ago(1), entries: [{ id: "wake:a", relay: { kind: "wake", stale: false, text: "x", receipt: { level: null, reached: [] }, paths: [] }, queued_at: ago(11), producer: "1.1" }] });
	} });
	const alarm = await (await none.open("#overview")).find(".overview-alarm");
	assert.deepEqual([...alarm.querySelectorAll("p")].map((p) => p.textContent), ["1 parent message not seen by the main session, oldest 11m (wake wake:a)", "health check disk failing 16m: 3 GiB"]);
	const bare = await none.open(OPERATOR);
	const only = await bare.find(".start-session-button");
	assert.deepEqual([bare.$$(".start-session-button").length, only.textContent, only.hasAttribute("disabled")], [1, "Start session", true]);
	assert.match(bare.text(), /Start session unavailable: .*herdr is not on PATH/);
});

test("P17-restart: Restart session says why it cannot, confirms, posts {restart:true}, shows a refusal and follows the status to restarted", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const plain = await operatorSession(t, d.stateDir);
	let tab = await d.open(OPERATOR);
	const button = ".session-bar-restart .operator-restart-button", line = ".session-bar-restart .operator-restart-line";
	const composer = (off: boolean) => tab.find("textarea", (f) => f.hasAttribute("disabled") === off);
	await tab.find(button, (b) => b.hasAttribute("disabled") && b.getAttribute("title") === RESTART_UNSUPPORTED);
	assert.equal(tab.$(line)?.textContent, RESTART_UNSUPPORTED, "a session cp-operator cannot relaunch: the manual way");
	plain.control.stop();
	const file = join(d.stateDir, "operator-session.jsonl");
	let idle = false, shutdowns = 0;
	const ports: ControlPorts = { inject: () => {}, abort: () => {}, isIdle: () => idle, hasPendingMessages: () => false, sessionFile: () => file, shutdown: () => void (shutdowns += 1), relaunchFile: () => join(d.stateDir, "operator", "relaunch.json"), parentSends: () => ({ ids: [], error: null }) };
	const restartable = () => startDashboardControl({ stateDir: d.stateDir, ports, log: () => {} }) as Promise<DashboardControl>;
	let control = await restartable();
	t.after(() => control.stop());
	tab = await tab.reopen();
	assert.ok(await tab.find(button, (b) => b.hasAttribute("disabled") && b.getAttribute("title") === "not now: the session is busy with a turn"));

	idle = true;
	tab = await tab.reopen();
	tab.click(await tab.find(button, (b) => !b.hasAttribute("disabled") && b.textContent === "Restart session"));
	assert.equal(tab.$(line)?.textContent, "Restart stops this session and resumes the same session file in its terminal");
	const confirm = await tab.find(".session-bar-restart .operator-restart-confirm");
	assert.equal(confirm.textContent, "Tap again to restart · resumes operator-session.jsonl");
	assert.equal(posts(tab, RESTART).length, 0, "one tap opens the confirm; nothing is sent yet");
	idle = false;
	tab.click(confirm);
	assert.ok(await tab.find(line, (p) => p.textContent === "Refused: not now: the session is busy with a turn" && p.getAttribute("role") === "alert"));
	assert.ok(await composer(false), "refused: free");

	idle = true;
	tab = await tab.reopen();
	tab.click(await tab.find(button, (b) => !b.hasAttribute("disabled")));
	tab.click(await tab.find(".session-bar-restart .operator-restart-confirm"));
	await until(() => shutdowns, (n) => n === 1, "the session asked to stop");
	const [sent] = posts(tab, RESTART);
	assert.deepEqual([sent!.body, sent!.headers["x-cp-control-token"], sent!.status], ['{"restart":true}', String((await d.get("/api/operator/control")).body.token), 202]);
	const from = tab.requests.length;
	await tab.find(line, (p) => p.textContent === "Stopping the session… it stops once its turn and compaction are done", 30_000);
	assert.ok(await composer(true), "stopping: held");
	control.stop();
	await tab.find(line, (p) => p.textContent === "Relaunching · resumes operator-session.jsonl", 30_000);
	assert.ok(await composer(true), "relaunching: held");
	assert.equal(tab.$(button)?.textContent, "Restarting…");
	control = await restartable();
	await tab.find(line, (p) => p.textContent === "Operator session restarted · operator-session.jsonl", 30_000);
	assert.ok(await composer(false), "restarted: free");
	// The bar's Restart runs on the shell's lean control, so its 2 s poll reads ?sends=0 to relaunching and restarted;
	// the composer's own control re-reads the full status as the restart moves, so its queued sends survive.
	const reads = tab.requests.slice(from).filter((r) => r.method === "GET" && r.path.startsWith("/api/operator/control")).map((r) => r.path);
	assert.ok(reads.filter((p) => p.endsWith("?sends=0")).length >= 2 && reads.includes("/api/operator/control"), `each owner's sends: ${reads}`);
	const based = tab.requests.slice(from).filter((r) => r.path.startsWith("/api/operator/control") && r.headers["x-cp-delta-base"]);
	assert.ok(based.length > 0 && based.every((r) => r.status === 200), "re-reads name their held version and still land restarted");
	// A session that never comes back fails once the tab's clock passes the 90 s wait, saying where to look.
	d.pin(new Date(Date.now() + 61_000).toISOString());
	tab = await tab.reopen();
	tab.click(await tab.find(button, (b) => !b.hasAttribute("disabled")));
	tab.click(await tab.find(".session-bar-restart .operator-restart-confirm"));
	await until(() => shutdowns, (n) => n === 2, "the second stop");
	control.stop();
	await tab.find(line, (p) => p.textContent === "Relaunching · resumes operator-session.jsonl", 30_000);
	tab.shift(91_000);
	assert.match((await tab.find(line, (p) => /^Failed: /.test(p.textContent ?? ""))).textContent ?? "", /^Failed: the session has not come back within 90 s; check the operator terminal/);
	assert.ok(await composer(false), "failed: free");
});

/** A dashboard whose home runs the quick tunnel: cp-view owns the device store and serves the remote listener. */
async function tunnelled(t: TestContext) {
	const remote = await new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
	const d = await dashboard(t, { seed: (stateDir, home) => {
		write(tunnelConfigFile(join(home, LAYOUT.data)), { schema_version: 1, enabled: true, mode: "quick", port: remote, binary: "/opt/cf/cloudflared", revision: 1 });
		write(tunnelRuntimeFile(stateDir), { schema_version: 1, origin: TUNNEL, generation: 1, revision: 1, state: "running", mode: "quick", port: remote, updated_at: new Date().toISOString() });
	} });
	await until(() => call(remote, "/pair").then((r) => r.status, () => 0), (status) => status === 200, "the remote listener");
	let peer = 0;
	const claim = (link: string, name: string, level = "view") => call(remote, "/api/pair/claim", { method: "POST", headers: { origin: TUNNEL, "content-type": "application/json", "cf-connecting-ip": `198.51.100.${(peer += 1)}` }, body: JSON.stringify({ code: link.split("#")[1], name, level }) });
	const create = async (level = "view") => d.get("/api/pair/create", post(d.origin, String((await d.get("/api/devices")).body.token), { level }));
	/** Pairs `name` through Add device and the public claim; returns its device cookie. */
	const pair = async (name: string, level = "view") => {
		const made = await create(level);
		assert.equal(made.status, 201, JSON.stringify(made.body));
		const claimed = await claim(String(made.body.link), name, level);
		assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
		return String(claimed.headers["set-cookie"]).split(";")[0]!;
	};
	return { ...d, remote, claim, create, pair, store: devicesFile(join(d.home, LAYOUT.data)) };
}
const TUNNEL = "https://amber-otter.trycloudflare.com";
const devicesSection = 'section[aria-label="Devices"]';

test("P17-devices: Settings → Devices lists, adds a one-time link with a QR that expires, revokes after a confirm, and says when it cannot", { timeout: 180_000 }, async (t) => {
	const d = await tunnelled(t);
	let tab = await d.open("#settings");
	await tab.find(devicesSection, (s) => (s.textContent ?? "").includes(DEVICE_TRUST));
	assert.ok((await tab.waitText(/Settings unavailable: /)).includes(DEVICE_TRUST), "Devices stands beside unavailable Settings");
	const select = await tab.find(".devices-add select");
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "view");
	select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	tab.click(await tab.find(".devices-add button", (b) => b.textContent === "Add device" && !b.hasAttribute("disabled")));
	const link = (await tab.find(".devices-link")).textContent!;
	assert.match(link, /^https:\/\/amber-otter\.trycloudflare\.com\/pair#[A-Za-z0-9_-]{43}$/);
	assert.match(tab.$(".devices-pairing")!.innerHTML, /<svg [^>]*class="devices-qr"[^>]*>.*<path [^>]*d="M\d/, "a drawn QR");
	const token = String((await d.get("/api/devices")).body.token);
	assert.deepEqual(posts(tab, "/api/pair/create").map((r) => [JSON.parse(r.body!), r.headers["x-cp-control-token"], r.status]), [[{ level: "view" }, token, 201]]);
	assert.ok(![...tab.storage.values()].some((v) => v.includes(link.split("#")[1]!)), "no pairing secret in browser storage");
	tab.click(await tab.find("button", (b) => b.textContent === "Hide link"));
	await until(() => tab.$(".devices-link"), (el) => el === null, "the hidden link");

	assert.equal((await d.claim(link, XSS)).status, 200);
	tab = await tab.reopen();
	const row = await tab.find(".devices-row", (r) => (r.textContent ?? "").includes(XSS));
	assert.equal(tab.$$(`${devicesSection} img`).length, 0, "names are text");
	assert.match(row.textContent ?? "", /View only/);
	assert.match(row.textContent ?? "", /Paired .* via this machine's dashboard · last used /);
	tab.decline();
	tab.click(await tab.find(".devices-row button", (b) => b.textContent === "Revoke"));
	await until(() => tab.confirms.length, (n) => n === 1, "the confirm");
	assert.equal(tab.confirms[0], `Revoke ${XSS}? Its next request is refused and it must pair again.`);
	assert.equal(posts(tab, "/api/devices/revoke").length, 0, "a declined confirm sends nothing");
	tab = await tab.reopen();
	tab.click(await tab.find(".devices-row button", (b) => b.textContent === "Revoke"));
	await tab.waitText(new RegExp(`Revoked ${XSS.replace(/[()]/g, "\\$&")}`));
	assert.deepEqual(posts(tab, "/api/devices/revoke").map((r) => [Object.keys(JSON.parse(r.body!)), r.headers["x-cp-control-token"], r.status]), [[["id"], token, 200]]);
	assert.ok(await tab.find(".devices-row", (r) => /revoked /.test(r.textContent ?? "")));
	assert.deepEqual(tab.$$(`${devicesSection} button`).map((b) => b.textContent), ["Add device"], "a revoked device has no Revoke");

	// A link whose 5 minutes end a second from now (the viewer's clock pinned back) clears itself and says so.
	d.pin(new Date(Date.now() - 299_000).toISOString());
	tab.click(await tab.find(".devices-add button", (b) => b.textContent === "Add device" && !b.hasAttribute("disabled")));
	await tab.find(".devices-link");
	assert.ok(await tab.waitText(/The pairing link expired; add the device again for a new one/));
	assert.equal(tab.$(".devices-link")?.outerHTML, undefined, "cleared at expiry");
	d.pin(new Date(Date.now() + 1_000).toISOString());
	for (let i = 0; i < 3; i++) assert.equal((await d.create()).status, 201);
	tab.click(await tab.find(".devices-add button", (b) => b.textContent === "Add device" && !b.hasAttribute("disabled")));
	assert.ok(await tab.waitText(/Three pairing links are already live/));

	write(tunnelRuntimeFile(d.stateDir), { schema_version: 1, origin: null, generation: 1, revision: 1, state: "stopped", mode: "quick", port: d.remote, updated_at: new Date().toISOString() });
	await until(async () => (await d.get("/api/devices")).body.origin, (origin) => origin === null, "the stopped tunnel");
	tab = await tab.reopen();
	await tab.waitText(/The remote dashboard is not running; paired devices sign in again once cp-tunnel up runs/);
	assert.ok(tab.$(".devices-add button")!.hasAttribute("disabled"), "not running: Add device is disabled");
	writeFileSync(d.store, "{not json");
	tab = await tab.reopen();
	assert.ok(await tab.find('[role="alert"]', (a) => /Devices unavailable: The device list is unreadable on this home/.test(a.textContent ?? "")));
	const off = await (await dashboard(t)).open("#settings");
	assert.ok(await off.find(devicesSection, (s) => /remote dashboard is off on this home.*cp-tunnel up/.test(s.textContent ?? "") && (s.textContent ?? "").includes(DEVICE_TRUST)));
});

test("P17-devices-remote: over the tunnel Full control lists and revokes but never adds; View only just lists", { timeout: 180_000 }, async (t) => {
	const d = await tunnelled(t);
	const full = await d.pair("Laptop", "full"), view = await d.pair("Tablet", "view");
	const asFull = await openTab(t, d.remote, "#settings", new Map(), undefined, { cookie: full });
	await asFull.find(devicesSection, (s) => /a remote device can never add one/.test(s.textContent ?? ""));
	await until(() => asFull.$$(`${devicesSection} button`).map((b) => b.textContent), (labels) => labels.length === 2, "both rows");
	assert.deepEqual(asFull.$$(`${devicesSection} button`).map((b) => b.textContent), ["Revoke", "Revoke"]);
	assert.equal(asFull.$(".devices-add")?.outerHTML, undefined);
	const asView = await openTab(t, d.remote, "#settings", new Map(), undefined, { cookie: view });
	assert.ok(await asView.find(devicesSection, (s) => /View only: you can see devices but not change them/.test(s.textContent ?? "") && (s.textContent ?? "").includes(DEVICE_TRUST)));
	await asView.find(".devices-row", (r) => /Laptop/.test(r.textContent ?? ""));
	assert.deepEqual(asView.$$(`${devicesSection} button`).map((b) => b.textContent), [], "no write buttons");
});

test("P17-device-notices: a pairing raises a notice above every screen; dismissed stays so; past three it folds; unreadable says so", { timeout: 180_000 }, async (t) => {
	const d = await tunnelled(t);
	let tab = await d.open("#overview");
	await tab.find(".shell-main");
	assert.equal(tab.$(".device-notices")?.outerHTML, undefined, "no pairing: nothing");
	await d.pair(XSS, "full");
	tab = await tab.reopen();
	const notice = await tab.find('section.device-notices[role="status"][aria-label="New device paired"]');
	assert.match(notice.textContent ?? "", new RegExp(`New device paired: ${XSS.replace(/[()]/g, "\\$&")} · Full control · `));
	assert.equal(notice.querySelectorAll("img").length, 0, "names are text");
	assert.ok(notice.querySelector("time[datetime]"));
	assert.match(notice.textContent ?? "", /push: 1 pending/);
	const event = JSON.parse(readFileSync(d.store, "utf8")).events[0];
	writeFileSync(deviceNotificationsFile(d.stateDir), JSON.stringify({ schema_version: 1, items: [{ pairing_id: event.id, device_id: event.recipients[0], state: "delivered", attempts: 1, delivered: 1, updated_at: event.at }], unusable: [] }));
	tab.refresh();
	assert.ok(await tab.find(".device-notices", (s) => /push: 1 delivered to push service/.test(s.textContent ?? "")), "a delivered recipient");
	assert.equal(notice.querySelector('a[href="#settings"]')?.textContent, "Devices");
	tab = await tab.reopen("#board");
	const dismiss = await tab.find(".device-notices button", (b) => b.textContent === "Dismiss");
	assert.ok(dismiss.closest(".shell-main"), "#board shows it too");
	tab.click(dismiss);
	await until(() => tab.$(".device-notices"), (el) => el === null, "the dismissed notice");
	tab = await tab.reopen("#overview");
	await tab.find(".shell-main");
	assert.equal(tab.$(".device-notices")?.outerHTML, undefined, "dismissed on this browser");
	for (const name of ["A", "B", "C", "D", "E"]) await d.pair(`Phone ${name}`);
	tab = await tab.reopen();
	await tab.find(".device-notices", (s) => /\+2 more/.test(s.textContent ?? ""));
	assert.equal(tab.$$(".device-notice").length, 3);
	writeFileSync(deviceNotificationsFile(d.stateDir), "{not json");
	tab.refresh();
	assert.match((await tab.find(".device-notices", (s) => /push status unavailable/.test(s.textContent ?? ""))).textContent ?? "", /push status unavailable: the pairing-alert delivery ledger is unreadable/);
	writeFileSync(d.store, "{not json");
	tab.refresh();
	assert.match((await tab.find(".device-notices", (s) => /showing the last read/.test(s.textContent ?? ""))).textContent ?? "", /Pairing notices unavailable \(HTTP 503\); showing the last read/);
	assert.equal(tab.$$(".device-notice").length, 3, "an offline tab keeps its unread notices");
	tab = await tab.reopen();
	assert.ok(await tab.waitText(/Pairing notices unavailable \(HTTP 503\)/));
});

/** The served stylesheet's rules, each with its enclosing @media query ("" outside one). */
function cssRules(css: string): Array<{ media: string; selector: string; body: string }> {
	const out: Array<{ media: string; selector: string; body: string }> = [];
	let media = "";
	for (const m of css.matchAll(/(@media[^{]*)\{|([^{}@]+)\{([^}]*)\}|\}/g)) {
		if (m[1]) media = m[1];
		else if (m[2] !== undefined) out.push({ media, selector: m[2], body: m[3]! });
		else media = "";
	}
	return out;
}

test("P17-layout: the served stylesheet wraps the control blocks at 390 px and widens them at 1440 px", { timeout: 120_000 }, async (t) => {
	const d = await dashboard(t);
	const href = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+\.css)"/.exec((await d.get("/")).text)!;
	const all = cssRules((await d.get(href[1] ?? href[2]!)).text);
	const rule = (selector: string, media = "") => all.filter((r) => r.selector === selector && r.media === media).map((r) => r.body).join(";");
	const WIDE = "@media(min-width:900px)";
	for (const [selector, media, want] of [
		[".session-pinned", "", /display:flex;.*max-height:45vh;overflow-y:auto;padding:0 16px/],
		[".session-pinned:not(.session-pinned-open)>:not(h2)", "", /^display:none$/],
		[".session-pinned-open>h2", "", /position:sticky/],
		[".session-pinned-open", "@media(max-width:899px)", /max-height:60dvh/],
		[".session-pinned", WIDE, /padding:0 40px/],
		[".session-pinned>*", WIDE, /max-width:none/],
		[".decision-card", "", /^display:flex;flex-direction:column;gap:12px;min-width:0;overflow-wrap:anywhere$/],
		[".decision-card-options", "", /display:grid;grid-template-columns:minmax\(0,1fr\)/],
		[".decision-card-options", WIDE, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/],
		[".start-session", "", /display:flex;flex-wrap:wrap;.*min-width:0/],
		[".start-session-line", "", /flex:1 1 220px;min-width:0;.*overflow-wrap:anywhere/],
		[".overview-services-line", "", /overflow-wrap:anywhere/],
		[".operator-restart", "", /flex-wrap:wrap;.*min-width:0/],
		[".operator-restart-button", "", /max-width:100%;.*overflow-wrap:anywhere/],
		[".operator-restart-line", "", /overflow-wrap:anywhere/],
		[".device-notices", "", /flex-wrap:wrap/], [".device-notices", "", /min-width:0/], [".device-notices", "", /max-width:100%/],
		[".device-notices", "", /overflow-wrap:anywhere/], [".device-notice", "", /overflow-wrap:anywhere/], [".device-notices-error", "", /overflow-wrap:anywhere/],
		[".device-notices-list", "", /flex:1 1 320px/],
		[".devices-row", "", /flex-wrap:wrap;.*min-width:0|min-width:0;.*flex-wrap:wrap/], [".devices-pairing", "", /flex-wrap:wrap/], [".devices-name", "", /flex-wrap:wrap/],
		[".devices-qr", "", /max-width:100%/], [".devices-row button,.devices-pairing button", "", /min-height:44px/],
	] as const) assert.match(rule(selector, media), want, `${media || "every width"} ${selector}`);
	assert.match(rule(".devices-qr-dark"), /fill:var\(--qr-dark\)/, "QR colours are tokens");
	const narrow = all.filter((r) => /^\.(operator-restart-(button|line)|device-notice)/.test(r.selector));
	assert.deepEqual(narrow.filter((r) => /white-space:nowrap|(^|[^-])width:\d/.test(r.body)).map((r) => r.selector), [], "no fixed width or nowrap: long names break");
	assert.deepEqual(all.filter((r) => r.media === WIDE && /\.session-pinned/.test(r.selector) && /pointer-events:none|>h2>button>span/.test(r.selector + r.body)).length, 0, "at 1440 px the bar is a real toggle");
});
