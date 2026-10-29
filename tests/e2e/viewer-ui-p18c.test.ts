/**
 * Behavior 18 (P18c): Job detail, Jobs, Board, Map and the shell's header and ⋮ menu as served by `bin/cp-view` and run
 * in a linkedom tab: DOM, text and the served stylesheet's rules, never pixels or measured layout.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../../src/dashboard-control.ts";
import { dashboard, openTab, type Tab, until } from "../harness/dashboard.ts";

const DAY = new Date().toISOString().slice(0, 10);
const NOON = `${DAY}T12:00:00.000Z`;
/** ISO time `minutes` before the viewer's noon. */
const iso = (minutes: number) => new Date(Date.parse(NOON) - minutes * 60_000).toISOString();
const [A, B, C] = ["a", "b", "c"].map((x) => x.repeat(40)) as [string, string, string];

type Put = (file: string, value: unknown) => void;
const putter = (home: string): Put => (file, value) => {
	const path = join(home, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, typeof value === "string" ? value : JSON.stringify(value));
	renameSync(`${path}.tmp`, path);
};
const run = (id: string, file: string) => join(LAYOUT.runs, id, file);
const ledger = (put: Put, jobs: object[]) => put(".pi-command-post/jobs.json", { jobs });
const fleet = (put: Put, jobs: object[]) => put(LAYOUT.fleetFile, { jobs });
const grant = (put: Put, id: string, status: string, project: string, extra: object = {}) => put(join(LAYOUT.mandates, `${id}.json`), {
	id, status, projects: [project], issued_at: "2020-01-01T00:00:00Z", expiry: "2099-01-01T00:00:00Z", objective: `Goal ${id}`,
	spend_cap: { usd: 100, tokens: 10000 }, job_cap: 12, dispatch_parallelism: 4, ask_on: ["risk:high"], ...extra,
});
const events = (put: Put, id: string, list: object[]) => put(run(id, "events.jsonl"), list.map((e) => JSON.stringify({ source: "cp", job_id: id, ts: iso(30), ...e })).join("\n") + "\n");

/** A viewer at noon (UTC) over a home `seed` wrote, and a tab on it: `wide` is a desktop tab. */
async function served(t: TestContext, seed: (put: Put, home: string) => void, options: { at?: string; env?: Record<string, string>; tailnet?: boolean } = {}) {
	const d = await dashboard(t, { requireTailnet: options.tailnet ?? false, at: options.at ?? NOON, env: { TZ: "UTC", ...options.env }, seed: (_state, home) => seed(putter(home), home) });
	const open = async (hash: string, wide = false, ready?: string, hold?: RegExp) => {
		const tab = await openTab(t, d.port, hash, new Map(), hold, {}, wide);
		if (ready) await tab.find(ready);
		return tab;
	};
	const css = cssRules((await d.get((/href="(\/assets\/viewer\/[^"]+\.css)"/.exec((await d.get("/")).text))![1]!)).text);
	/** The served declarations of every rule whose selector matches, inside `media` ("" outside any @media). */
	const rule = (selector: RegExp | string, media = "") => css.filter((r) => (typeof selector === "string" ? r.selector === selector : selector.test(r.selector)) && r.media === media).map((r) => r.body).join(";");
	return { ...d, put: putter(d.home), open, css, rule };
}

/** The served stylesheet's rules, each with its enclosing @media query ("" outside one). */
function cssRules(css: string): Array<{ media: string; selector: string; body: string }> {
	const out: Array<{ media: string; selector: string; body: string }> = [];
	let media = "";
	for (const m of css.matchAll(/(@media[^{]*)\{|([^{}@]+)\{([^}]*)\}|\}/g)) {
		if (m[1]) media = m[1];
		else if (m[2] !== undefined) out.push({ media, selector: m[2].trim(), body: m[3]! });
		else media = "";
	}
	return out;
}
const WIDE = "@media(min-width:900px)", PHONE = "@media(max-width:899px)";
const texts = (els: Element[]) => els.map((e) => e.textContent);

test("P18-job-detail-ui: Job detail's hero, facts, tabs, timeline, asks, failure action and deploy row on a phone and a desktop tab", { timeout: 180_000 }, async (t) => {
	const merged = (id: string) => ({ job_id: id, project: "demo", kind: "ship", phase: "done", dispatched_at: iso(60), closed_at: iso(5) });
	const receipt = (id: string, sha = B) => [run(id, "merge.json"), { job_id: id, pr_url: "https://github.com/acme/widgets/pull/12", merge_commit_sha: sha, head_sha: A, merged_at: iso(5) }] as const;
	const deploys: Array<[string, object]> = [
		["cp-l-none", { coverage: "none" }], ["cp-l-cap", { coverage: "none", reason: "cannot enroll: job cap 1 reached" }],
		["cp-l-enrolled", { coverage: "enrolled", mandate_id: "md-a" }], ["cp-l-wide", { coverage: "project_wide", mandate_id: "md-w" }],
		["cp-l-deploying", { deploy_job_id: "cp-d-working" }], ["cp-l-deployed", { deploy_job_id: "cp-d-done" }],
		["cp-l-rolled", { deploy_job_id: "cp-d-rolled" }], ["cp-l-blocked", { deploy_job_id: "cp-d-blocked" }],
		["cp-l-failed", { deploy_job_id: "cp-d-failed" }], ["cp-l-skipped", { status: "skipped", reason: "merged into release, not the deploy branch main" }],
	];
	const long = "A long job title ".repeat(12).trim();
	const v = await served(t, (put, home) => {
		mkdirSync(join(home, LAYOUT.projects, "demo"), { recursive: true });
		const open = (id: string, title: string, status = "in_progress", extra: object = {}) => ({ id, title, status, labels: ["project:demo", "kind:ship"], ...extra });
		ledger(put, [
			open("cp-queued", "Queued title", "open"), open("cp-merged", "Landed", "closed", { closed_at: iso(5) }), open("cp-held", "A long fixture title"),
			open("cp-failed", "Failed job", "in_progress", { description: "Why this job\n  exists" }), open("cp-plain", "Plain"), open("cp-partial", "Partial"),
			open("cp-equiv", "Equivalent", "closed", { closed_at: iso(5) }), open("cp-long", long), open("cp-nohead", "No headline"),
			...deploys.map(([id]) => open(id, id, "closed", { closed_at: iso(5) })),
		]);
		const routing = { scope: "M", risk: "low", provenance: { scope: "inferred", risk: "explicit" }, rule: "recorded rule", reasons: ["Recorded explanation", "Additional reason"] };
		fleet(put, [
			{ ...merged("cp-merged"), worker: { model: "anthropic/claude-fixture" }, usage: { cost_usd: 1.25 }, skills: [{ name: "tdd-x", dir: "/s/tdd-x" }, { name: "lint-y", dir: "/s/lint-y" }], routing },
			{ job_id: "cp-held", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(60), worker: { model: "anthropic/claude-fixture" }, receipts: [{ kind: "pr", status: "open", url: "https://github.com/acme/widgets/pull/12" }] },
			{ job_id: "cp-failed", project: "demo", kind: "ship", phase: "failed", dispatched_at: iso(60), usage: { cost_usd: 1.5 }, failure: { class: "wall_clock", message: "wall clock limit", at: iso(30) } },
			{ job_id: "cp-plain", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(60) },
			{ job_id: "cp-nohead", project: "demo", kind: "ship", phase: "failed", dispatched_at: iso(60) },
			{ job_id: "cp-partial", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(60), routing: { risk: "low" } },
			merged("cp-equiv"),
			...deploys.map(([id]) => merged(id)),
			{ job_id: "cp-d-working", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(10) },
			{ ...merged("cp-d-done"), closed_at: iso(30) }, merged("cp-d-rolled"), merged("cp-d-blocked"),
			{ job_id: "cp-d-failed", project: "demo", kind: "ship", phase: "failed", dispatched_at: iso(10), failure: { message: "worker died", at: iso(5) } },
		]);
		for (const id of ["cp-merged", "cp-held", "cp-equiv"]) put(run(id, "envelope.json"), { envelope: { head_sha: A, summary: id === "cp-held" ? "Short" : undefined } });
		put(...receipt("cp-merged"));
		events(put, "cp-merged", [{ type: "ci_observed", payload: { event: "ci_green", head_sha: A } }]);
		put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-held", head_sha: A, last_ci: "green" }] });
		for (const id of ["cp-merged", "cp-held"]) put(run(id, "review-1.json"), { head_sha: A, verdict: "pass", decided_at: iso(10), diff_stat: { truncated: false } });
		put(run("cp-equiv", `review-equivalent-${A}.json`), { head_sha: A, verdict: "pass", decided_at: iso(10), diff_stat: { truncated: false } });
		grant(put, "md-active", "active", "demo", { job_ids: ["cp-merged"] });
		grant(put, "md-a", "active", "demo", { objective: "Ship it", spend_cap: { usd: 20, tokens: 10000 }, job_ids: ["cp-failed"] });
		put(LAYOUT.escalationsFile, { items: [{ id: "es-f", status: "open", question: "Keep?", created_at: iso(60), job_ids: ["cp-failed"] }] });
		put(join(LAYOUT.state, "operator/asks.jsonl"), JSON.stringify({ type: "open", id: "ask-f", project: "demo", created_at: iso(60), question: "Keep?", options: [{ label: "Keep", consequence: "c" }], recommendation: "Keep", source_escalation: "es-f" }) + "\n");
		for (const [id, extra] of deploys) {
			put(...receipt(id));
			put(run(id, "after-merge.json"), { job_id: id, merge_commit_sha: B, status: "created", base_branch: "main", deploy_job_id: "cp-deploy", ...extra });
		}
		put(run("cp-d-done", "envelope.json"), { envelope: { status: "done" } });
		put(run("cp-d-rolled", "envelope.json"), { envelope: { status: "blocked", blockers: ["rolled back: health check failed"] } });
		put(run("cp-d-blocked", "envelope.json"), { envelope: { status: "blocked", blockers: ["needs the operator to open port 22"] } });
	});

	// A queued ledger-only job reads in words, never a dash.
	const queued = await v.open("#job/cp-queued", false, ".job-facts");
	const fact = (tab: Tab, name: string) => tab.$(`.job-fact-${name} dd`)?.textContent;
	assert.deepEqual(tab_facts(queued), ["Wall clock:not recorded", "Cost:not recorded", "Model:not recorded", "Head:no commits yet", "Context:none", "Routing:Not recorded", "Skills:none", "Mandate:none", "PR:none yet", "CI:not run yet", "Review:not started · 0 / 5"]);
	assert.equal(queued.$$("dd").filter((dd) => /^-/.test(dd.textContent ?? "")).length, 0, "no dash-only fact");
	assert.ok(queued.$(".job-summary-row") === null, "no summary, no summary row");
	assert.equal(queued.root.querySelectorAll("script, [style], [onclick]").length, 0, "no inline script, style or handler");

	// A merged job: the PR link, the short merge sha, two copy buttons, the full head and merge shas, model and provider.
	const landed = await v.open("#job/cp-merged", false, ".job-facts");
	assert.equal(landed.$(".job-fact-pr a")?.textContent, "#12 ↗");
	assert.equal(landed.$(".job-fact-pr .job-sha > code")?.textContent, B.slice(0, 7));
	assert.deepEqual(landed.$$(".job-detail-side .job-sha > code").map((c) => c.getAttribute("title")), [A, B], "the full head and merge shas ride on the titles");
	assert.equal(landed.$$('.job-detail-side [aria-label="Copy reply for the operator chat"]').length, 2);
	assert.deepEqual([landed.$(".job-fact-model code")?.textContent, landed.$(".job-fact-model .job-provider")?.textContent], ["claude-fixture", "anthropic"]);
	assert.equal(fact(landed, "cost"), "$1.25");
	assert.equal(landed.$('.job-fact-mandate a[href="#map"]')?.textContent, "md-active →");
	assert.equal(fact(landed, "skills"), "@tdd-x @lint-y");
	const routing = landed.$(".job-fact-routing")!;
	assert.deepEqual(texts([...routing.querySelectorAll(".job-routing-pill")]), ["scope:M · inferred", "risk:low · explicit", "recorded rule"]);
	assert.deepEqual(texts([...routing.querySelectorAll("p")]), ["Recorded explanation · Additional reason"], "one explanation line");
	assert.doesNotMatch(landed.text(), /scope:M \(inferred\)/, "the routing text is not repeated beside its pills");
	assert.ok(landed.$(".job-fact-deploy") === null, "no after-merge record, no Deploy row");
	assert.equal(landed.text().includes("Ask about this failure"), false, "only failed jobs offer it");
	assert.equal(landed.$('.job-header, .job-detail-heading > .page-header a.page-header-back')?.getAttribute("href"), "#jobs");
	assert.deepEqual([...landed.$(".job-detail-heading > .page-header")!.children].slice(0, 3).map((e) => [e.tagName, e.textContent]), [["A", "Jobs"], ["H1", "Landed"], ["CODE", "cp-merged"]]);
	// Timeline: SHA40 abbreviated, the full value as title and copy text; a landed job has no pending stage.
	landed.click(landed.$$('[role="tab"]').find((b) => b.textContent === "Timeline")!);
	await landed.find(".job-timeline .job-sha");
	assert.deepEqual(landed.$$(".job-timeline .job-sha > code").map((e) => [e.textContent, e.getAttribute("title")]), [[A.slice(0, 7), A], [B.slice(0, 7), B]]);
	assert.deepEqual(texts(landed.$$(".job-timeline .overview-reply code")), [A, B]);
	assert.equal(landed.$('.job-links a[href="/api/job/cp-merged/events"]')?.textContent, "Run log");
	assert.ok(landed.$(".job-event-pending") === null, "a finished job has no speculative pending stage");
	assert.doesNotMatch(landed.text(), /events\.jsonl|not yet/);
	assert.equal(fact(await v.open("#job/cp-plain", false, ".job-facts"), "skills"), "none");
	assert.match((await v.open("#job/cp-nohead", false, ".job-facts")).text(), /Ask about this failure/, "a failed phase is enough without a headline");
	const partial = await v.open("#job/cp-partial", false, ".job-facts");
	assert.deepEqual(texts(partial.$$(".job-routing-pill")), ["risk:low"], "a partial record shows only what it holds");
	const equiv = await v.open("#job/cp-equiv", false, ".job-facts");
	assert.equal(equiv.$(".job-badge-review")?.textContent, "review 0 / 5 · pass (equivalent)", "an equivalent pass is not not-started");

	// The hero spans the body: title row, then phase, PR, CI and review badges, then the held hint; facts in their order.
	const held = await v.open("#job/cp-held", false, ".job-facts");
	const hero = held.$(".job-detail > .job-detail-heading")!;
	assert.deepEqual([...hero.children].map((e) => e.className || e.tagName), ["page-header page-header-stack", "job-badges", "P"]);
	assert.deepEqual(texts([...hero.querySelector(".job-badges")!.children]), ["held", "#12 open ↗", "CI green aaaaaaa", "review 1 / 5 · pass"]);
	assert.equal(hero.querySelector(".job-badges a")?.getAttribute("href"), "https://github.com/acme/widgets/pull/12");
	assert.deepEqual([...held.$(".job-detail-body")!.children].map((e) => e.className), ["job-detail-main", "job-detail-side"], "the tab content and the facts rail");
	assert.deepEqual(texts(held.$$(".job-facts dt")), ["Wall clock", "Cost", "Model", "Head", "Context", "Routing", "Skills", "Mandate", "PR", "CI", "Review"]);
	assert.equal(held.$(".job-detail-top > .job-summary-row > p.job-summary.job-summary-clamp")?.textContent, "Short");
	assert.ok(held.$(".job-summary-more") === null, "more shows only on a measured overflow");
	assert.ok(held.$(".job-detail-side .job-summary") === null, "the summary stays out of the facts");

	// A phone opens on Details with three tabs; a desktop tab opens on Transcript beside the facts rail, Timeline its own tab.
	const tabs = (tab: Tab) => tab.$$('[role="tab"]').map((e) => [e.textContent, e.getAttribute("aria-selected")]);
	assert.deepEqual(tabs(held), [["Details", "true"], ["Transcript", "false"], ["Timeline", "false"]]);
	assert.equal(held.$(".job-detail")?.getAttribute("data-tab"), "details");
	const desk = await v.open("#job/cp-held", true, ".job-facts");
	assert.deepEqual(tabs(desk), [["Transcript", "true"], ["Timeline", "false"]]);
	assert.equal(desk.$(".job-detail")?.getAttribute("data-tab"), "transcript");
	assert.ok(desk.$(".job-detail-side .job-facts"), "facts stay on the rail");
	assert.ok(desk.$(".job-timeline") === null, "Timeline is its own tab");
	assert.deepEqual([...desk.$(".job-detail-side")!.children].map((e) => e.className), ["job-facts", "job-links"]);
	assert.deepEqual(texts(desk.$$(".job-facts dt")).slice(-2), ["CI", "Review"]);

	// Asks, the failure headline and the description and mandate snippet sit outside the tabs; Ask lives in the rail.
	for (const [hash, wide, tab] of [["#job/cp-failed", false, "details"], ["#job/cp-failed", true, "transcript"], ["#job/cp-failed?tab=transcript", false, "transcript"]] as const) {
		const failed = await v.open(hash, wide, ".job-facts");
		const ask = failed.$$("a").find((a) => a.textContent === "Ask about this failure");
		assert.deepEqual([failed.$(".job-detail")?.getAttribute("data-tab"), !!ask?.closest(".job-detail-side"), failed.$(".job-detail-top .job-failure")?.textContent, !!failed.$(".job-detail-top + .job-tabs")],
			[tab, true, "wall clock limit", true], `${hash} ${wide ? "desktop" : "phone"}`);
		if (tab !== "details" || wide) continue;
		assert.match(failed.$(".job-detail-top")!.textContent!, /Awaiting you.*Keep\?.*wall clock limit/);
		const query = new URLSearchParams(ask!.getAttribute("href")!.split("?")[1]);
		assert.deepEqual([query.get("view"), query.get("transcript"), query.get("draft")], ["you", "1", "Explain why picp job cp-failed failed and the available recovery options."]);
		assert.equal(failed.$(".job-card p")?.textContent, "Why this job\n  exists", "the description keeps its stored spaces and line breaks");
		assert.match(failed.$(".job-mandate-snippet")!.textContent!, /md-a.*active.*Ship it.*\$1\.50 \/ \$20\.00.*1 job/);
	}
	assert.ok(queued.$(".job-card, .job-mandate-snippet") === null, "omitted when not recorded");

	// The page's one <h1> is the job's title, whole in its title attribute; its id follows muted.
	const titled = await v.open("#job/cp-long", false, ".job-facts");
	assert.deepEqual(titled.$$("h1").map((h) => h.getAttribute("title")), [long]);
	assert.equal(titled.$(".job-detail-heading > .page-header > .page-header-detail")?.textContent, "cp-long");

	// Deploy row: status phrase and job link first, the long detail on a muted line with the full text as its title.
	const deployRow = async (id: string) => {
		const tab = await v.open(`#job/${id}`, false, ".job-fact-deploy dd");
		const line = tab.$(".job-deploy-detail");
		assert.equal(line?.getAttribute("title") ?? null, line?.textContent ?? null, "the tooltip carries the full detail");
		return { tab, lines: [tab.$(".job-deploy-status")!.textContent, line?.textContent ?? null] };
	};
	const first = await deployRow("cp-l-none");
	assert.ok(first.tab.$(".job-fact-running + .job-fact-deploy"), "Deploy sits right after Running here");
	assert.equal(first.tab.$('.job-deploy-status a[href="#job/cp-deploy"] code')?.textContent, "cp-deploy");
	assert.deepEqual(first.lines, ["deploy queued · cp-deploy", "no covering grant — dispatch needs a grant"]);
	assert.deepEqual((await deployRow("cp-l-cap")).lines, ["deploy queued · cp-deploy", "no covering grant — dispatch needs a grant (cannot enroll: job cap 1 reached)"]);
	assert.deepEqual((await deployRow("cp-l-enrolled")).lines, ["deploy queued · cp-deploy", "enrolled in md-a"]);
	assert.deepEqual((await deployRow("cp-l-wide")).lines, ["deploy queued · cp-deploy", "covered by project-wide md-w"]);
	assert.deepEqual((await deployRow("cp-l-deploying")).lines, ["deploying · cp-d-working", "merged bbbbbbb"]);
	const [deployed, health] = (await deployRow("cp-l-deployed")).lines;
	assert.deepEqual([deployed, /^merged bbbbbbb · health-checked .+/.test(health ?? "")], ["deployed · in use · cp-d-done", true]);
	assert.deepEqual((await deployRow("cp-l-rolled")).lines, ["deploy blocked: rolled back · cp-d-rolled", "rolled back: health check failed"]);
	assert.deepEqual((await deployRow("cp-l-blocked")).lines, ["deploy blocked · cp-d-blocked", "needs the operator to open port 22"]);
	assert.deepEqual((await deployRow("cp-l-failed")).lines, ["deploy failed · cp-d-failed", "worker died"]);
	assert.deepEqual((await deployRow("cp-l-skipped")).lines, ["no deploy", "merged into release, not the deploy branch main"]);

	// The served stylesheet: 44px SHA copy targets, kept spaces, phone-only 44px rows, a rail shown on Details, a clamped detail.
	assert.match(v.rule(".job-sha .overview-reply button"), /min-width:44px;min-height:44px;.*padding:15px;.*border:0;background:transparent/);
	assert.match(v.rule(".job-card p,.job-mandate-objective"), /^white-space:pre-wrap$/);
	assert.match(v.rule(".jt-jump"), /margin-left:auto/);
	assert.match(v.rule(".jt-review>summary,.jt-trailing>summary", PHONE), /min-height:44px/, "44px summary targets are phone-only");
	assert.match(v.rule(".jt-review>summary,.jt-trailing>summary"), /min-height:32px/);
	assert.match(v.rule(".tool-run-solid>.session-tools", PHONE), /min-height:44px/, "shared tool row: 44px on phone only");
	assert.match(v.rule(".job-detail-side"), /display:none;/, "phone: the rail is hidden by default");
	assert.match(v.rule(".job-detail[data-tab=details] .job-detail-side"), /^display:flex$/, "phone: shown on the Details tab");
	assert.match(v.rule(".job-deploy-detail"), /-webkit-line-clamp:2;/, "long detail is clamped to two lines");
	assert.match(v.rule(".job-detail-body", WIDE), /^display:grid;/, "the desktop body is a grid");
});

test("P18-jobs-render: Jobs, a failed job's detail and Board render empty, failed, flight, done-today and mandate-filter states", { timeout: 180_000 }, async (t) => {
	const empty = await served(t, () => {});
	assert.match((await empty.open("#jobs", false, ".jobs-screen")).text(), /Nothing in flight/);
	const blank = await empty.open("#board", false, ".jobs-views");
	assert.match(blank.text(), /Nothing here/);
	blank.click(blank.$(".board-trigger")!);
	await blank.find('[role="listbox"]');
	assert.ok(blank.$('[role="switch"]') === null, "no revoked mandates, no switch");

	const flight = (id: string, project: string, over: object = {}) => ({ job_id: id, project, kind: "ship", phase: "waiting", dispatched_at: iso(10), bounds: { wall_clock_seconds: 7200 }, usage: { cost_usd: 1.5 }, worker: { model: "anthropic/claude-opus-5-5" }, ...over });
	const done = (id: string, project: string, minutes: number) => ({ job_id: id, project, kind: "ship", phase: "done", dispatched_at: iso(minutes + 30), closed_at: iso(minutes), usage: { cost_usd: 1 }, mandate_id: "md-active" });
	const longTitle = "A long title ".repeat(20).trim();
	const v = await served(t, (put) => {
		const row = (id: string, title: string, project = "demo", status = "in_progress") => ({ id, title, status, labels: [`project:${project}`, "kind:ship"] });
		ledger(put, [
			row("cp-render", "<script>unsafe()</script>"), row("cp-wide", longTitle), row("cp-bare", "Bare"), row("cp-wait", "Wait"), { ...row("cp-paused", "Paused", "alpha"), blocked_by: ["cp-render", "cp-gone"] },
			...[0, 1, 2, 3, 4, 5].map((i) => row(`cp-d${i}`, `Done ${i}`, "demo", "closed")), row("cp-beta", "Beta", "beta", "closed"),
			row("cp-prclosed", "PR closed", "beta", "closed"), { ...row("cp-ledger-only", "Ledger only", "beta", "closed"), closed_at: iso(64) },
			row("cp-gamma", "Gamma", "gamma", "open"), row("cp-delta", "Delta", "delta", "open"),
		]);
		fleet(put, [
			{ ...flight("cp-render", "demo"), phase: "failed", dispatched_at: iso(130), usage: { cost_usd: 3 }, failure: { message: "wall clock limit", at: iso(10) } },
			flight("cp-wide", "demo", { mandate_id: "md-active" }), flight("cp-bare", "demo", { mandate_id: "md-active" }), flight("cp-wait", "demo", { mandate_id: "md-active" }),
			flight("cp-paused", "alpha", { mandate_id: "md-paused" }),
			...[0, 1, 2, 3, 4, 5].map((i) => done(`cp-d${i}`, "demo", 60 + i * 10)), done("cp-beta", "beta", 65),
			{ ...done("cp-prclosed", "beta", 62), receipts: [{ kind: "pr", url: "https://github.com/acme/repo/pull/43", status: "closed" }] },
		]);
		for (const id of ["cp-wide", "cp-bare", "cp-paused"]) put(run(id, "status.json"), { job_id: id, phase: "working", started_at: iso(10) });
		put(run("cp-wide", "envelope.json"), { envelope: { head_sha: B } });
		put(join(dirname(LAYOUT.state), "projects", "demo", "clone.json"), {});
		put(run("cp-render", "envelope.json"), { envelope: { head_sha: A } });
		put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-wide", head_sha: B, last_ci: "green" }, { job_id: "cp-render", head_sha: A, last_ci: "red" }] });
		put(...[run("cp-d0", "merge.json"), { job_id: "cp-d0", pr_url: "https://github.com/acme/repo/pull/42", merge_commit_sha: C, head_sha: A, merged_at: iso(60) }] as const);
		grant(put, "md-active", "active", "demo", { projects: ["demo", "beta"], objective: "Long objective ".repeat(20).trim() });
		grant(put, "md-paused", "paused", "alpha", { objective: "Paused work", pause_reason: "Budget paused" });
		grant(put, "md-gone", "revoked", "omega", { objective: "Gone", revoked_at: "2020-01-02T00:00:00Z" });
		put(join(LAYOUT.state, "operator/asks.jsonl"), JSON.stringify({ type: "open", id: "ask-a", project: "demo", created_at: iso(60), question: "Continue?", options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep", job_ids: ["cp-render"] }) + "\n");
		for (const [slug, ids] of [["alpha", ["cp-render"]], ["beta", ["cp-render", "cp-wide"]]] as const) {
			put(join(LAYOUT.state, "boards", slug, "board.json"), { title: `${slug} <script> ${"Long report title".repeat(20)}`, created_at: iso(30), job_ids: ids });
			put(join(LAYOUT.state, "boards", slug, "index.html"), "<p>report</p>");
		}
	});

	// Jobs: a failed row names its ledger disagreement and failure; flight rows carry the column cells.
	const jobs = await v.open("#jobs", true, ".job-row-done");
	const failedRow = jobs.$('.job-row a[href="#job/cp-render"]')!.closest(".job-row")!;
	assert.equal(failedRow.querySelector(".job-ledger")?.textContent, "ledger in_progress");
	assert.equal(failedRow.querySelector(".job-note")?.textContent, "wall clock limit");
	assert.deepEqual(texts(jobs.$$(".jobs-columns-flight > span")), ["Job", "Title", "Wall clock", "Context", "Review", "CI", "Model", "Cost"]);
	const wide = jobs.$('a[href="#job/cp-wide"]')!.closest(".job-row")!;
	assert.equal(wide.querySelector(".job-row-id code")?.getAttribute("title"), "cp-wide", "the full id rides on the id title");
	assert.ok(wide.querySelector(".job-row-link > .job-title + .job-row-heading"), "title precedes the id inside the one job link");
	assert.deepEqual([...wide.querySelector(".job-signals")!.children].map((e) => e.className), ["job-clock", "job-context", "job-review", "job-ci job-ci-green", "job-model", "job-cost"]);
	assert.match(wide.querySelector(".job-signals")!.textContent!, /10m \/ 2h 0m.*context n\/a.*review not started.*CI green.*claude-opus-5-5.*\$1\.50/);
	assert.equal(Math.round(Number(wide.querySelector(".job-clock progress")?.getAttribute("value"))), Math.round(600 / 7200 * 100), "elapsed / limit");
	const bare = jobs.$('a[href="#job/cp-bare"]')!.closest(".job-row")!;
	assert.deepEqual([bare.querySelector(".job-review")?.textContent, bare.querySelector(".job-ci")?.textContent, bare.querySelector(".job-cost")?.textContent], ["review not started", "no CI yet", "$1.50"]);
	assert.equal(bare.querySelector(".job-model code")?.getAttribute("title"), "anthropic/claude-opus-5-5");
	assert.equal(bare.querySelector(".job-model code")?.textContent, "claude-opus-5-5");
	assert.doesNotMatch(jobs.$(".jobs-group")!.innerHTML, /job-route|scope:M|md-active|Routing not recorded|Phases:|CI -|review -/);
	assert.equal(jobs.$('a[href="#job/cp-wait"]')!.closest(".job-row")!.querySelector(".job-phase")?.firstChild?.textContent, "no run status");
	assert.equal(jobs.$$(".jobs-toolbar > p").length, 0, "the held hint lives on the In flight header only");
	assert.match(jobs.$(".jobs-group > header")!.textContent!, /held = waiting on CI or review/);
	assert.ok(jobs.$(".jobs-toolbar .jobs-views") && jobs.$(".jobs-toolbar .jobs-segments"));
	assert.ok(jobs.$(".jobs-group > header")!.compareDocumentPosition(jobs.$(".jobs-columns-flight")!) & 4, "flight headers follow their section heading");
	// Done today: groups by newest job with counts and bare cost, five rows and a show-more foot, no flight cells.
	assert.deepEqual(texts(jobs.$$(".jobs-columns-done > span")).slice(0, 7), ["Job", "Title", "Outcome", "Commit", "Model", "Done", "Cost"]);
	assert.deepEqual(texts(jobs.$$(".jobs-project h3 > :not(.jobs-project-cost)")), ["demo", " · 1 merged · 5 closed without PR", "beta", " · 0 merged · 3 closed without PR"]);
	assert.deepEqual(texts(jobs.$$(".jobs-project-cost")), ["$9.00", "$2.00"], "project cost is the bare amount, no middot");
	const beta = [...jobs.$$(".jobs-project")[1]!.querySelectorAll(".job-row-done")];
	assert.deepEqual(beta.map((r) => [r.querySelector(".job-outcome")!.textContent!.trim(), r.querySelector(".job-commit")?.textContent, r.querySelector(".job-cost")?.textContent]),
		[["#43 ↗ PR closed", "no commits", "$1.00"], ["closed · no PR", "no commits", "-"], ["closed · no PR", "no commits", "$1.00"]], "a closed PR; a ledger-only job has no cost");
	const doneRows = jobs.$$(".jobs-project:first-of-type .job-row-done");
	assert.deepEqual(doneRows.map((r) => r.querySelector("code[title^='cp-']")?.textContent), ["cp-render", "cp-d0", "cp-d1", "cp-d2", "cp-d3"], "newest first, five rows");
	assert.deepEqual([doneRows[0]!.querySelector(".job-outcome")!.textContent!.trim(), doneRows[0]!.querySelector(".job-note")?.textContent], ["failed", "wall clock limit"]);
	assert.equal(doneRows[1]!.querySelector(".job-outcome")!.textContent!.trim(), "#42 ↗ merged");
	assert.equal(doneRows[1]!.querySelector(".job-outcome a")?.getAttribute("href"), "https://github.com/acme/repo/pull/42");
	assert.deepEqual([doneRows[1]!.querySelector(".job-commit")?.textContent, doneRows[1]!.querySelector(".job-commit")?.getAttribute("title")], ["ccccccc", C]);
	assert.deepEqual([...doneRows[1]!.querySelector(".job-finished")!.children].map((e) => e.className), ["job-outcome", "job-commit", "job-model", "job-finished-at", "job-cost"]);
	assert.deepEqual([doneRows[2]!.querySelector(".job-outcome")!.textContent!.trim(), doneRows[2]!.querySelector(".job-commit")?.textContent], ["closed · no PR", "no commits"]);
	const doneSection = jobs.$$(".jobs-group").at(-1)!;
	assert.match(doneSection.querySelector("header")!.textContent!, /newest first/);
	assert.equal(doneSection.querySelectorAll(".job-context, .ctx-chip, .job-ci, .job-review").length, 0, "finished rows have no flight cells");
	assert.ok(jobs.$$(".jobs-group")[0]!.querySelector(".job-context"), "live rows keep the context cell");
	assert.equal(jobs.$$("a a").length, 0, "the PR link is separate from the job link");
	assert.match(jobs.$(".jobs-done-foot")!.textContent!, /Show 2 more from demo.*Nothing done today in alpha \(paused\), delta or gamma\./);
	assert.match(jobs.$("[aria-label='Filter jobs']")!.textContent!, /Done today10/);
	assert.ok(jobs.$('a[href="#job/cp-d5"]') === null, "the sixth demo row waits behind show-more");
	jobs.click(jobs.$(".jobs-more")!);
	await jobs.find('a[href="#job/cp-d5"]');
	// One Jobs item with a List | Board | Map toggle on each view, the current one marked.
	const toggle = (tab: Tab) => tab.$$('nav.jobs-views[aria-label="Jobs view"] a').map((a) => [a.getAttribute("href"), a.getAttribute("aria-current")]);
	assert.deepEqual(toggle(jobs), [["#jobs", "page"], ["#board", null], ["#map", null]]);

	// A failed job's detail: Awaiting you, its CI, the escaped title, report links outside the tabs, no inline script.
	const detail = await v.open("#job/cp-render", false, ".job-facts");
	assert.match(detail.text(), /Awaiting you.*Continue\?.*Keep/);
	assert.match(detail.$(".job-badges")!.textContent!, /CI red/);
	assert.equal(detail.$("h1")?.textContent, "<script>unsafe()</script>");
	assert.equal(detail.root.querySelectorAll("script, [style], [onclick]").length, 0);
	const reports = detail.$$(".job-detail-top .job-report-links a");
	assert.deepEqual(reports.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), /^Web report ·/.test(a.textContent!)]),
		[["/boards/alpha/", "_blank", "noopener noreferrer", true], ["/boards/beta/", "_blank", "noopener noreferrer", true]]);
	assert.ok(detail.$('.job-detail-side .job-links a[href="/#files?root=project%3Ademo&path="]'), "the job's project files");
	assert.doesNotMatch((await v.open("#job/cp-bare", false, ".job-facts")).text(), /Web report|Ask about this failure/, "no reports, not failed");

	// Board: one picker, closed; All mandates keeps inactive-grant work; four newest landed cards; folds empty Waiting.
	const board = await v.open("#board", true, ".board-trigger");
	assert.deepEqual(toggle(board), [["#jobs", null], ["#board", "page"], ["#map", null]]);
	assert.equal(board.$("h1")?.getAttribute("title"), "Jobs");
	assert.doesNotMatch(board.text(), /^Mandates$/m);
	assert.equal(board.$$('[aria-label="Board columns"]').length, 1, "one renderer for both widths");
	assert.equal(board.$$('.board-trigger[aria-haspopup="listbox"]').length, 1);
	assert.ok(board.$('[role="listbox"]') === null, "closed until opened");
	assert.equal(board.root.querySelectorAll("script, [style], [onclick]").length, 0);
	assert.ok(board.$('a[href="#job/cp-paused"]'), "All mandates retains flight jobs on inactive grants");
	assert.match(board.$('a[href="#job/cp-wide"]')!.textContent!, /working · 10m \/ 2h 0m · \$1\.50/);
	const landed = () => board.$('[aria-label="Landed today"]')!;
	assert.deepEqual(texts([...landed().querySelectorAll(".board-card-heading code")]), ["cp-d0", "cp-prclosed", "cp-ledger-only", "cp-beta"]);
	assert.match(landed().textContent!, /#42 · merged · \d\d:\d\d · \$1\.00.*#43 · closed.*Show 5 more in the list/);
	assert.equal(landed().querySelector(".board-more")?.getAttribute("href"), "#jobs");
	assert.equal(landed().querySelectorAll(".ctx-chip").length, 0, "finished cards have no live context");
	assert.match(board.text(), /Failed1/);
	assert.match(board.$('a[href="#job/cp-paused"]')!.closest(".board-card")!.textContent!, /blocked by cp-renderblocked by cp-gone/);
	assert.match(board.$(".board-status")!.textContent!, /^1 stranded dependencies/);
	board.click(board.$(".board-trigger")!);
	const list = await board.find('[role="listbox"]');
	assert.equal(board.$(".board-trigger")?.getAttribute("aria-expanded"), "true");
	assert.match(list.textContent!, /All mandates\d+ jobs.*Active · 1.*Other.*md-paused.*Paused work · paused/);
	assert.equal(list.querySelector('[aria-selected="true"] .board-check')?.textContent, "✓");
	assert.equal(board.$("#board-opt-md-paused .board-option-count")?.textContent, "1 working");
	assert.ok(board.$('input[aria-label="Filter mandates"]'));
	assert.equal(board.$('[role="switch"]')?.textContent, "Include 1 revoked mandates");
	assert.equal(board.$('[role="switch"]')?.getAttribute("aria-checked"), "false");
	assert.doesNotMatch(list.textContent!, /md-gone/);
	board.click(board.$('[role="switch"]')!);
	await until(() => board.$('[role="listbox"]')?.textContent ?? "", (s) => /md-gone/.test(s), "the revoked mandate listed");
	board.click(board.$("#board-opt-md-gone")!);
	await until(() => board.text(), (s) => /Nothing here/.test(s), "a revoked mandate has no live lane, so no jobs");
	board.click(board.$(".board-trigger")!);
	const filter = await board.find('input[aria-label="Filter mandates"]') as HTMLInputElement;
	filter.value = "paused";
	filter.dispatchEvent(new board.window.Event("input", { bubbles: true }));
	await until(() => board.$$('[role="option"]').map((o) => o.id), (ids) => ids.join() === "board-opt-md-paused", "the filter narrows the options");
	board.click(board.$("#board-opt-md-paused")!);
	await until(() => board.$('[role="listbox"]'), (open) => open === null, "picking closes the picker");
	assert.match(board.$(".board-trigger")!.textContent!, /md-paused/);
	assert.ok(board.$('a[href="#job/cp-wide"]') === null);
	assert.ok(board.$('a[href="#job/cp-paused"]'));
	assert.match(board.text(), /Budget paused/);
	assert.deepEqual([!!board.$('[aria-label="Waiting · 0"]'), /Empty now/.test(board.text()), board.$(".board-more") === null], [true, false, true], "Waiting folds; no overflow link");
	board.click(board.$(".board-trigger")!);
	board.click(await board.find("#board-opt-all"));
	await until(() => board.$('[aria-label="Landed today"]')?.querySelectorAll(".board-card").length, (n) => n === 4, "All mandates restores the preview");
	// Working counts working runs only: a waiting or an idle job counts under Waiting. Only a failed job offers Ask:
	// working, done, idle, waiting and held details have none (cp-wide idles, then cp-wait turns held).
	const counts = (tab: Tab) => ["Working", "Waiting"].map((name) => tab.$(`section[aria-label="${name}"] h2 > span:last-child`)?.textContent);
	assert.deepEqual(counts(board), ["3", "1"]);
	assert.equal(board.$('section[aria-label="Waiting"] h2')?.getAttribute("title"), "needs a person, or the worker is idle");
	v.put(run("cp-wide", "status.json"), { job_id: "cp-wide", phase: "idle", started_at: iso(10) });
	const idled = async () => { const tab = await v.open("#board", true, ".board-trigger"); const seen = counts(tab); tab.close(); return seen; };
	assert.deepEqual(await until(idled, (c) => c[0] === "2", "cp-wide idles"), ["2", "2"], "waiting and idle count under Waiting only");
	const phaseOf = async (id: string) => {
		const tab = await v.open(`#job/${id}`, false, ".job-facts");
		const seen = [tab.$(".job-badges > :first-child")?.textContent, tab.text().includes("Ask about this failure")];
		tab.close();
		return seen;
	};
	for (const [id, phase] of [["cp-bare", "working"], ["cp-d1", "done"], ["cp-wide", "idle"], ["cp-wait", "waiting"]]) assert.deepEqual(await phaseOf(id!), [phase, false], `${phase} has no failure action`);
	const flown = JSON.parse(readFileSync(join(v.home, LAYOUT.fleetFile), "utf8")) as { jobs: Array<{ job_id: string }> };
	fleet(v.put, flown.jobs.map((j) => (j.job_id === "cp-wait" ? { ...j, phase: "held" } : j)));
	assert.deepEqual(await until(() => phaseOf("cp-wait"), (p) => p[0] === "held", "cp-wait turns held"), ["held", false], "held has no failure action");

	// Served CSS: the phone gutter, wrapped-never segments, the 44px phone link, and the desktop subgrid row.
	assert.equal(v.css.filter((r) => /\.jobs-screen\b/.test(r.selector) && r.media === "" && /max-width|margin/.test(r.body) && !/ /.test(r.selector.replace(".jobs-screen", ""))).length, 0, "no capped phone column");
	assert.match(v.rule(".jobs-segments"), /flex-wrap:nowrap;.*overflow-x:auto/);
	assert.match(v.rule(".job-row-link"), /min-height:44px/, "phone base target");
	assert.match(v.rule(".jobs-screen .job-row-done .job-cost", PHONE), /^position:absolute;/, "the absolute cost rides done rows only");
	assert.equal(v.css.filter((r) => r.selector === ".jobs-screen .job-cost").length, 0);
	assert.match(v.rule(".job-row-link", WIDE), /grid-area:1 \/ 1 \/ 2 \/ 3;.*display:grid;.*min-height:0/);
	assert.match(v.rule(".jobs-columns-flight,.job-row-flight", WIDE), /grid-template-columns:220px minmax\(0,1fr\) 104px 140px 120px 92px 88px 56px/);
	assert.doesNotMatch(v.rule(/\.job-row-link/, WIDE), /display:contents/);
	assert.match(v.rule(".reports-grid", WIDE), /^display:grid;/);
});

const mapTitle = "[c-parent-host] host the parent RPC pipe outside the operator process without losing tool results";
const mapObjective = "Land the hygiene-ranking items, one reviewed PR per item. Preserve recorded decisions and operator ownership while making long real-world titles readable on both phone and desktop screens.";
const task = (id: string, project: string, extra: object = {}) => ({ id, title: mapTitle, status: "in_progress", labels: [`project:${project}`, "kind:ship"], ...extra });
const today = (hour: string) => `${DAY}T${hour}:00:00.000Z`;
type Box = { id: string; x: number; y: number; w: number; h: number };
/** The served graph's job cards and edge polylines, read back from the SVG the tab rendered. */
function graph(tab: Tab) {
	const num = (el: Element, name: string) => Number(el.getAttribute(name));
	const boxes: Box[] = tab.$$(".map-graph foreignObject").filter((f) => f.querySelector("button.map-node:not(.map-mandate-node)"))
		.map((f) => ({ id: f.querySelector("button")!.getAttribute("title")!.split(":")[0]!, x: num(f, "x"), y: num(f, "y"), w: num(f, "width"), h: num(f, "height") }));
	const edges = tab.$$(".map-graph .map-edge").map((g) => ({ title: g.querySelector("title")!.textContent!, points: [...g.querySelector("path")!.getAttribute("d")!.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const) }));
	return { boxes, edges, box: (id: string) => boxes.find((b) => b.id === id)!, svg: tab.$(".map-graph > svg")! };
}
/** Whether segment a→b passes through `node`'s interior; routing is orthogonal. */
function crosses(a: readonly number[], b: readonly number[], node: Box): boolean {
	if (a[0] === b[0]) return a[0]! > node.x && a[0]! < node.x + node.w && Math.max(a[1]!, b[1]!) > node.y && Math.min(a[1]!, b[1]!) < node.y + node.h;
	assert.equal(a[1], b[1], "routing uses orthogonal segments");
	return a[1]! > node.y && a[1]! < node.y + node.h && Math.max(a[0]!, b[0]!) > node.x && Math.min(a[0]!, b[0]!) < node.x + node.w;
}
function routedClear(tab: Tab) {
	const { boxes, edges } = graph(tab);
	for (const edge of edges) for (let i = 1; i < edge.points.length; i++) for (const node of boxes) assert.equal(crosses(edge.points[i - 1]!, edge.points[i]!, node), false, `${edge.title} crosses ${node.id}`);
	for (const a of boxes) for (const b of boxes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
}
/** A #map tab whose graph pane reports `resize(width)` through a stub ResizeObserver, installed before it mounts. */
async function measuredMap(v: Awaited<ReturnType<typeof served>>) {
	const tab = await v.open("#map", true, undefined, /^\/api\/map/);
	let measure = () => {};
	const observer = { disconnected: false };
	tab.globals.ResizeObserver = class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() { observer.disconnected = true; } };
	tab.release();
	await tab.find(".map-graph > svg");
	const resize = async (width: number, expect: number) => {
		Object.defineProperty(tab.$(".map-graph")!, "clientWidth", { configurable: true, value: width });
		measure();
		await until(() => tab.$(".map-graph > svg")?.getAttribute("width"), (w) => w === String(expect), `the graph at pane ${width}`);
	};
	return { tab, resize, observer };
}

test("P18-map-render: Map renders lanes, history, legend, selection, done folds, labels and nav from the recorded home", { timeout: 180_000 }, async (t) => {
	const zone = process.env.TZ;
	// The day boundary is the browser's own zone: 09:00Z is today and 05:00Z yesterday in Los Angeles.
	process.env.TZ = "America/Los_Angeles";
	t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
	const P = "pi-command-post-system";
	const v = await served(t, (put) => {
		const live = ["cp-job-0", "cp-job-1", "cp-job-2", "cp-job-3", "cp-job-4", "cp-job-5", "cp-more-done-0", "cp-more-done-1", "cp-more-done-2", "cp-more-done-3"];
		ledger(put, [
			task("cp-job-0", P, { status: "closed", closed_at: iso(120) }), task("cp-job-1", P), task("cp-job-2", P, { blocked_by: ["cp-job-0", "cp-job-1", "cp-more-done-3"] }),
			task("cp-job-3", P), task("cp-job-4", P), task("cp-job-5", P, { blocked_by: ["cp-job-1"] }),
			...[0, 1, 2, 3].map((i) => task(`cp-more-done-${i}`, P, { status: "closed", closed_at: iso(100) })),
			task("cp-second", P), task("cp-closed-a", P, { status: "closed", closed_at: iso(57) }), task("cp-recent", "aaa-old"), task("cp-history", "aaa-old"),
		]);
		fleet(put, [
			{ job_id: "cp-job-1", project: P, kind: "ship", phase: "held", dispatched_at: iso(60) },
			{ job_id: "cp-job-2", project: P, kind: "ship", phase: "waiting", dispatched_at: iso(60), receipts: [{ kind: "pr", status: "open", url: "https://github.com/acme/repo/pull/265" }] },
			{ job_id: "cp-job-3", project: P, kind: "ship", phase: "waiting", dispatched_at: iso(60) },
			{ job_id: "cp-second", project: P, kind: "ship", phase: "held", dispatched_at: iso(60), receipts: [{ kind: "pr", status: "merged", url: "https://github.com/acme/repo/pull/266" }] },
		]);
		put(run("cp-job-2", "status.json"), { job_id: "cp-job-2", phase: "working", started_at: iso(60) });
		put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-job-2", last_ci: "running" }] });
		const g = (id: string, status: string, project: string, ids: string[], extra: object = {}) => grant(put, id, status, project, { objective: mapObjective, job_ids: ids, ...extra });
		g("md-old", "expired", "aaa-old", ["cp-none"], { expiry: "2020-06-01T00:00:00Z" });
		g("md-paused", "paused", "aaa-paused", []);
		g("md-live", "active", P, live);
		g("md-second", "active", P, ["cp-second"]);
		g("md-closed", "active", P, ["cp-closed-a"]);
		g("md-revoked", "revoked", "aaa-old", ["cp-recent"], { revoked_at: today("09") });
		g("md-history", "revoked", "aaa-old", ["cp-history"], { revoked_at: today("05") });
		put(LAYOUT.escalationsFile, { items: [["md-revoked", "09"], ["md-history", "05"]].map(([id, hour]) => ({ id: `es-${id}`, kind: "mission_end", status: "answered", mandate_id: id,
			answer: "close", answered_at: today(hour!), created_at: today(hour!), question: "Close?", options: [{ id: "close", label: "Close" }] })) });
	});
	const map = await v.open("#map", true, ".map-graph > svg");
	const has = (id: string) => map.text().includes(id);
	// Today's revoked mission closure shows; yesterday's (in the browser's day) waits behind the history toggle.
	for (const id of ["md-revoked", "cp-recent", "md-paused", "md-closed"]) assert.ok(has(id), id);
	assert.ok(map.$('.map-mandate-node[aria-label^="md-paused:"]') && map.$('.map-mandate-node[aria-label^="md-closed:"]'));
	assert.deepEqual(["md-history", "md-old", "cp-history"].filter(has), [], "older history is hidden");
	assert.match(map.text(), /Show 2 expired or revoked mandates/);
	const toggle = map.$(".mandate-history-toggle input") as unknown as { checked: boolean } & Element;
	const flip = (on: boolean) => { toggle.checked = on; toggle.dispatchEvent(new map.window.Event("change", { bubbles: true })); };
	flip(true);
	await map.waitText(/md-history/);
	for (const id of ["md-history", "md-old", "md-revoked", "md-paused", "md-closed", "cp-recent", "cp-history"]) assert.ok(has(id), id);
	assert.match(map.$('.map-mandate-node[aria-label^="md-closed:"] small')!.textContent!, /^closed /, "a closure today names its time");
	map.click(map.$('.map-graph button[title^="cp-history:"]')!);
	await map.waitText(/job · cp-history/);
	flip(false);
	await until(() => map.text(), (s) => !/md-history|md-old|cp-history/.test(s), "history hidden again");
	assert.ok(has("md-revoked") && has("cp-recent"));
	// The full legend toggles open and shut.
	const legend = map.$('[aria-label="Show full legend"]')!;
	map.click(legend);
	const full = await map.find(".map-full-legend");
	assert.equal(legend.getAttribute("aria-pressed"), "true");
	for (const label of ["working", "not dispatched", "held", "failed", "launching", "done", "blocked by · open", "stranded", "blocked by · satisfied", "dependency removed", "pipeline", "waits on PR · CI red", "superseded by", "repairs"]) assert.ok(full.textContent!.includes(label), label);
	map.click(legend);
	await until(() => map.$(".map-full-legend"), (el) => el === null, "the legend closes");
	assert.equal(legend.getAttribute("aria-pressed"), "false");
	// Nothing is selected or dimmed until a pick; a pick dims the rest and shows the job's PR and CI.
	assert.match(map.text(), /Select a job or mandate.*Nothing is dimmed until you pick one/);
	assert.equal(map.$$(".map-node-dim").length, 0);
	assert.doesNotMatch(map.text(), /job · cp-job-/);
	map.click(map.$('.map-graph button[title^="cp-job-2:"]')!);
	await map.waitText(/job · cp-job-2/);
	assert.equal(map.$(".map-selection h2")?.textContent, mapTitle);
	assert.ok(map.$(".map-node-dim"));
	assert.equal(map.$(".map-selection .map-pr")?.textContent, "#265 · CI running");
	assert.doesNotMatch(map.root.innerHTML, />https:\/\/github/);
	map.click(map.$('.map-graph button[title^="cp-second:"]')!);
	await map.waitText(/job · cp-second/);
	assert.equal(map.$(".map-selection .map-pr")?.textContent, "#266 · merged");
	map.click(map.$('[aria-label="Clear selection"]')!);
	await map.waitText(/Select a job or mandate/);
	// Done jobs past the first fold behind a native, enabled button; the phone disclosure keeps every link.
	const more = map.$(".map-more-done")!;
	assert.deepEqual([more.textContent, more.tagName, more.hasAttribute("disabled"), more.getAttribute("aria-disabled"), more.getAttribute("aria-expanded")], ["+4 more done", "BUTTON", false, null, "false"]);
	assert.ok(Number(more.getAttribute("tabindex") ?? 0) >= 0, "the enabled native button stays in the tab order");
	const hiddenEdge = () => graph(map).edges.find((e) => e.title === "cp-job-2 blocked by cp-more-done-3 · satisfied");
	assert.equal(hiddenEdge(), undefined, "an edge with a collapsed endpoint is hidden");
	assert.equal(map.$$('.map-graph button[title^="cp-more-done-"]').length, 0);
	assert.equal(map.$$('.map-done-details a[href^="#job/cp-more-done-"]').length, 4, "the phone disclosure keeps every finished link");
	map.click(more);
	await until(() => map.$$('.map-graph button[title^="cp-more-done-"]').length, (n) => n === 4, "expansion shows the done jobs");
	assert.equal(map.$(".map-more-done")?.getAttribute("aria-expanded"), "true");
	assert.ok(hiddenEdge()?.points.length, "expansion restores the hidden endpoint's edge path");
	assert.ok(map.$$(".map-graph .map-edge").find((g) => g.querySelector("title")?.textContent === "cp-job-2 blocked by cp-more-done-3 · satisfied")?.querySelector("polygon"), "with its arrow");
	routedClear(map);
	map.click(map.$('.map-graph button[title^="cp-more-done-3:"]')!);
	await map.waitText(/job · cp-more-done-3/);
	map.click(map.$(".map-more-done")!);
	await until(() => map.text(), (s) => /Select a job or mandate/.test(s), "collapsing a selected done job clears the selection");
	assert.equal(hiddenEdge(), undefined, "collapsing hides that edge again");
	assert.equal(map.$$(".map-node-dim").length, 0);

	// Labels and controls: clamped text with the full accessible name; compact 58px cards; one stack per mandate.
	assert.equal(map.$("h1")?.textContent, "Jobs");
	const header = map.$(".map-heading")!;
	assert.ok(header.querySelector('nav[aria-label="Jobs view"]') && header.querySelector(".mandate-history-toggle"));
	assert.deepEqual(texts([...header.querySelectorAll(".map-legend-summary .map-legend-chip")]), ["← blocked by · open", "← satisfied"]);
	const mandate = map.$('.map-mandate-node[aria-label^="md-live:"]')!;
	assert.deepEqual([mandate.getAttribute("title"), mandate.querySelector(".map-label")?.textContent, mandate.getAttribute("aria-label")], [mapObjective, mapObjective, `md-live: ${mapObjective}`]);
	for (const id of ["cp-job-0", "cp-job-1", "cp-job-2", "cp-job-3", "cp-job-4", "cp-job-5"]) {
		const node = map.$(`.map-graph button[title="${id}: ${mapTitle}"]`)!;
		assert.deepEqual([node.querySelector(".map-label")?.textContent, node.getAttribute("aria-label"), node.closest("foreignObject")?.getAttribute("height")], [mapTitle, `${id}: ${mapTitle}`, "58"], id);
		const link = map.$(`.map-mobile-lanes a[href="#job/${id}"]`)!;
		assert.deepEqual([link.querySelector(".map-label")?.textContent, link.getAttribute("aria-label")], [mapTitle, `${id}: ${mapTitle}`], id);
	}
	assert.equal(map.$(".map-status")?.textContent, "✓No stranded dependencies");
	const { boxes, box, svg, edges } = graph(map);
	const stack = boxes.filter((b) => b.id.startsWith("cp-job-"));
	assert.deepEqual([new Set(stack.map((b) => b.x)).size, new Set(stack.map((b) => b.y)).size], [1, 6], "each mandate owns one vertical job stack");
	assert.deepEqual([box("cp-job-0").x, box("cp-second").x], [12, 276], "mandates form separate columns");
	assert.deepEqual(texts(map.$$(".map-graph .map-column .map-project-heading")), [P, "aaa-old", "aaa-paused"], "active projects first");
	assert.equal(map.$$(".map-graph .map-column").length, 5, "md-live, md-second, md-closed, md-revoked (closed today) and md-paused");
	assert.equal(svg.getAttribute("width"), "840");
	assert.equal(map.$$(".map-graph .ctx-chip, .map-mobile-job .ctx-chip").length, 0, "tiles omit context bars");
	assert.ok(edges.some((e) => e.title === "cp-job-2 blocked by cp-job-0 · satisfied"));
	const labels = map.$$(".map-graph .map-edge-label");
	assert.deepEqual(labels.map((l) => l.textContent!.split(" blocked by")[0]).sort(), ["cp-job-2", "cp-job-5"], "several blockers share one label per job");
	assert.match(labels.find((l) => l.textContent!.startsWith("cp-job-2"))!.getAttribute("title")!, /cp-job-2 blocked by cp-job-1 · open/);
	// Adjacent cards connect vertically on their facing boundaries; a skipped label clears the done control by 8px.
	const adjacent = edges.find((e) => e.title === "cp-job-2 blocked by cp-job-1 · open")!.points;
	assert.deepEqual([adjacent.length, adjacent[0], adjacent[1]![0], adjacent[1]![1] - 7], [2, [24, box("cp-job-2").y], 24, box("cp-job-1").y + 58], "the arrow tip meets the blocker's bottom");
	const label = labels.find((l) => l.textContent!.startsWith("cp-job-5"))!.closest("foreignObject")!;
	const footer = map.$(".map-more-done")!.closest("foreignObject")!;
	const top = (el: Element) => Number(el.getAttribute("y")), bottom = (el: Element) => top(el) + Number(el.getAttribute("height"));
	assert.ok(top(label) >= box("cp-job-5").y + 58, "the skipped dependency label sits below the last shown job");
	assert.ok(top(footer) >= bottom(label) + 8, "an 8px gap before the collapse control");
	assert.equal(footer.getAttribute("height"), "44");
	routedClear(map);
	assert.match(map.text(), /no run status/);
	assert.doesNotMatch(map.root.innerHTML, />waiting</);
	for (const phase of ["working", "not dispatched", "held", "done"]) assert.ok(map.$$(".map-graph small").some((s) => s.textContent === phase), phase);
	assert.ok(map.$(".map-selection-empty svg"));

	// Map is a Jobs view: List | Board | Map, Map current; the sidebar has eight links, the tab bar five, Jobs lit in both.
	assert.deepEqual(map.$$('nav[aria-label="Jobs view"] a').map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("aria-current")]), [["#jobs", "List", null], ["#board", "Board", null], ["#map", "Map", "page"]]);
	const nav = (label: string) => map.document.querySelectorAll(`nav[aria-label="${label}"] a`) as unknown as Element[];
	assert.deepEqual([...nav("Desktop primary")].map((a) => a.getAttribute("href")), ["#overview", "#decisions", "#jobs", "#sessions", "#stats", "#reports", "#settings", "#more"]);
	assert.deepEqual([...nav("Primary")].map((a) => a.getAttribute("href")), ["#overview", "#decisions", "#jobs", "#sessions", "#more"]);
	for (const label of ["Desktop primary", "Primary"]) assert.deepEqual([...nav(label)].filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href")), ["#jobs"], label);
	assert.equal(map.root.querySelectorAll("script, [style], [onclick]").length, 0);

	// An empty home, then a failed job stranded on a missing blocker; closed, it no longer counts; unreadable grants say so.
	assert.match((await (await served(t, () => {})).open("#map", true, ".map-screen")).text(), /No jobs recorded/);
	const s = await served(t, (put) => {
		ledger(put, [{ ...task("cp-failed", "demo", { blocked_by: ["cp-gone", "cp-right"] }), title: "<script>bad</script>" }, task("cp-right", "demo")]);
		fleet(put, [{ job_id: "cp-failed", project: "demo", kind: "ship", phase: "failed", dispatched_at: iso(60) }]);
		grant(put, "md-a", "active", "demo");
	});
	const stranded = await s.open("#map", true, ".map-graph > svg");
	assert.match(stranded.$(".map-stranded h2")?.textContent ?? "", /^1 stranded dependency$/);
	assert.equal(stranded.$('.map-graph button[title^="cp-failed:"] > span > small')?.textContent, "failed", "a stranded job keeps its recorded phase");
	assert.ok(stranded.$('.map-graph[aria-label="Mandate and job graph"]') && stranded.$('[aria-label="Selection"]'));
	assert.ok(stranded.$('.map-graph button[title="cp-failed: <script>bad</script>"]'), "the title is text, never markup");
	assert.equal(stranded.root.querySelectorAll("script, [style], [onclick]").length, 0);
	assert.ok(graph(stranded).edges.some((e) => e.title === "cp-failed blocked by cp-right · open"), "the edge keeps its endpoints and kind");
	s.put(".pi-command-post/jobs.json", { jobs: [{ ...task("cp-failed", "demo", { blocked_by: ["cp-gone"] }), status: "closed", closed_at: iso(5) }, task("cp-right", "demo")] });
	stranded.refresh();
	assert.ok(await stranded.find(".map-health-status"), "a closed stranded job no longer counts");
	s.put(join(LAYOUT.mandates, "md-bad.json"), { id: "md-bad", status: "nonsense" });
	stranded.refresh();
	await stranded.waitText(/Dependency status unavailable/);
	assert.doesNotMatch(stranded.text(), /No stranded dependencies/);
});

test("P18-map-edges: dependencies route around cards at every pane width; cycles, self-links and hundreds of jobs stay reachable", { timeout: 240_000 }, async (t) => {
	const cycle = Array.from({ length: 227 }, (_, i) => `cp-cycle-${String(i).padStart(3, "0")}`);
	const v = await served(t, (put) => {
		ledger(put, [
			...cycle.map((id, i) => ({ ...task(id, "cycle", { blocked_by: [cycle[(i + cycle.length - 1) % cycle.length]!] }), title: `${mapTitle} ${i}` })),
			task("cp-self", "cycle", { blocked_by: ["cp-self"] }), task("cp-descendant", "cycle", { blocked_by: [cycle[0]!] }),
			task("cp-closed-x", "cycle", { status: "closed", closed_at: iso(30) }),
		]);
		grant(put, "md-live", "active", "cycle", { job_ids: [...cycle, "cp-self", "cp-descendant"] });
		grant(put, "md-closed", "active", "cycle", { job_ids: ["cp-closed-x"] });
	});
	const { tab, resize, observer } = await measuredMap(v);
	const first = tab.$(".map-graph > svg")!.innerHTML;
	for (const pane of [360, 520, 680, 840]) {
		await resize(pane, Math.max(pane, 516));
		const { boxes, svg } = graph(tab);
		const stack = boxes.filter((b) => b.id !== "cp-closed-x");
		assert.equal(stack.length, 229, `${pane}: every node keeps a position`);
		assert.equal(new Set(stack.map((b) => b.x)).size, 1, "one vertical stack");
		for (const b of boxes) assert.ok(b.x + b.w <= Number(svg.getAttribute("width")) && b.y + b.h <= Number(svg.getAttribute("height")), `${b.id} inside the canvas at ${pane}`);
		routedClear(tab);
	}
	assert.equal(tab.$(".map-graph > svg")!.innerHTML, first, "the same pane gives the same layout");
	for (const [i, id] of cycle.entries()) {
		const node = tab.$(`.map-graph button[title^="${id}:"]`)!;
		assert.deepEqual([node.getAttribute("title"), node.getAttribute("aria-pressed")], [`${id}: ${mapTitle} ${i}`, "false"]);
	}
	assert.equal(tab.$$(".map-node-dim").length, 0);
	assert.equal(tab.$$('.map-mobile-lanes a[href^="#job/cp-cycle-"]').length, 227, "phone keeps every job link");
	tab.go("#jobs");
	assert.ok(await until(() => observer.disconnected, Boolean, "the graph releases its resize observer"));

	// Twelve mandate columns overflow the pane and scroll; history adds its jobs back.
	const w = await served(t, (put) => {
		const columns = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, "0"));
		ledger(put, [...columns.map((i) => task(`cp-column-${i}`, "wide", i === "05" ? { blocked_by: ["cp-column-00"] } : {})), task("cp-history", "aaa-old", { status: "closed", closed_at: "2020-05-01T00:00:00Z" })]);
		for (const i of columns) grant(put, `md-column-${i}`, "active", "wide", { job_ids: [`cp-column-${i}`] });
		grant(put, "md-old", "expired", "aaa-old", { job_ids: ["cp-history"], expiry: "2020-06-01T00:00:00Z" });
	});
	const wide = await measuredMap(w);
	await wide.resize(520, 12 * 264 - 12);
	assert.equal(graph(wide.tab).box("cp-column-11").x, 12 + 11 * 264);
	assert.equal(graph(wide.tab).box("cp-history"), undefined);
	assert.ok(graph(wide.tab).edges.some((e) => e.title === "cp-column-05 blocked by cp-column-00 · open"), "a cross-column edge");
	routedClear(wide.tab);
	const toggle = wide.tab.$(".mandate-history-toggle input") as unknown as { checked: boolean } & Element;
	toggle.checked = true;
	toggle.dispatchEvent(new wide.tab.window.Event("change", { bubbles: true }));
	await until(() => graph(wide.tab).box("cp-history"), Boolean, "history shows its job");
	assert.equal(graph(wide.tab).boxes.length, 13, "every selected job keeps a position");
});

test("P18-shell-menu: the ⋮ menu, page header and phone header across screens; Restart session confirms inside the menu", { timeout: 240_000 }, async (t) => {
	const v = await served(t, (put) => {
		ledger(put, [{ id: "cp-one", title: "One", status: "in_progress", labels: ["project:demo", "kind:ship"] }]);
		fleet(put, [{ job_id: "cp-one", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(10) }]);
	}, { tailnet: true });
	const tab = await v.open("#overview", true, ".overview-heading h1", /^\/api\/sessions/);
	const menus = () => tab.$$(".shell-main details.shell-more");
	// One header row per page: the <h1>, then live status, then ⋮ as its last item; a short updated time.
	assert.deepEqual(texts(tab.$$("h1")), ["Overview"]);
	assert.ok(tab.$(".overview-heading .page-header:not(.page-header-fallback) h1 + .page-header-end > .shell-live + .shell-more:last-child"), "title, then status, then ⋮");
	assert.ok(tab.$(".page-header-fallback") === null, "no second header");
	assert.equal(menus().length, 1, "no second ⋮");
	const clock = await tab.find(".overview-heading .page-header-end time");
	assert.match(clock.textContent!, /^updated \d\d:\d\d$/, "no seconds, no zone");
	assert.match(clock.getAttribute("title")!, /^Updated \d\d:\d\d:\d\d/, "the full time is its title");
	assert.ok(!Number.isNaN(Date.parse(clock.getAttribute("datetime")!)));
	assert.equal(tab.$(".shell-desktop-search kbd")?.textContent, "⌘K");
	const summary = menus()[0]!.querySelector("summary")!;
	assert.deepEqual([summary.getAttribute("aria-label"), summary.getAttribute("title")], ["More actions", "More actions"]);
	assert.deepEqual([tab.$(".shell-more-dot") === null, tab.$(".shell-more-panel") === null], [true, true], "closed: no panel, no dot");
	// Open: Refresh, Copy link, Notifications with icons, the Viewer footer, a scrim; no session, no Restart row.
	const details = menus()[0]! as Element & { open: boolean };
	const open = async () => { details.open = true; details.dispatchEvent(new tab.window.Event("toggle")); await tab.find(".shell-more-panel"); };
	await open();
	const panel = tab.$(".shell-more-panel")!.textContent!;
	const at = ["Refresh now", "Copy link to this view", "Notifications", "Viewer"].map((s) => panel.indexOf(s));
	assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!)), panel);
	assert.equal(tab.$$(".shell-more-row > svg").length, 3, "Refresh, Copy and Notifications each have an icon");
	assert.ok(tab.$(".shell-more-footer .shell-more-version"), "Viewer sits in the divided footer");
	assert.ok(tab.$('.shell-more-scrim[aria-hidden="true"]'), "the phone background dims while open");
	assert.doesNotMatch(panel, /Restart session/, "no running session: no Restart row");
	// Enter leaves it open; Esc closes and restores focus to the opener; an outside or scrim tap closes; inside does not.
	tab.key(tab.root, "Enter");
	assert.equal(details.open, true, "other keys leave it open");
	let focused = false;
	(summary as unknown as { focus: () => void }).focus = () => { focused = true; };
	tab.key(tab.root, "Escape");
	assert.deepEqual([details.open, focused], [false, true], "Esc closes and refocuses the summary");
	await open();
	tab.document.body.dispatchEvent(new tab.window.Event("pointerdown", { bubbles: true }));
	assert.equal(details.open, false, "an outside tap closes");
	await open();
	tab.$(".shell-more-scrim")!.dispatchEvent(new tab.window.Event("pointerdown", { bubbles: true }));
	assert.equal(details.open, false, "a scrim tap closes");
	await open();
	tab.$(".shell-more-row")!.dispatchEvent(new tab.window.Event("pointerdown", { bubbles: true }));
	assert.equal(details.open, true, "a tap inside keeps it open");
	// Opening search re-renders only the shell: no fallback header appears and there is still one ⋮.
	const proto = tab.window.HTMLElement.prototype as { showModal?: () => void; close?: () => void };
	proto.showModal ??= function (this: Element) { this.setAttribute("open", ""); };
	proto.close ??= function (this: Element) { this.removeAttribute("open"); };
	tab.click(tab.$(".shell-search")!);
	await tab.find("dialog");
	assert.deepEqual([tab.$(".page-header-fallback") === null, menus().length], [true, 1], "search mounts no second header");

	// A screen with no header of its own (Sessions while it loads) brings back the shell's fallback row, with no <h1>.
	tab.go("#sessions?view=you");
	const fallback = await tab.find(".shell-main > .page-header.page-header-fallback");
	assert.equal(fallback.querySelector("p")?.textContent, "Sessions");
	assert.ok(fallback.querySelector(".page-header-end > .shell-live > span") && fallback.querySelector(".page-header-end > .shell-more:last-child"), "the live dot and ⋮ stay");
	assert.deepEqual([tab.$$("h1").length, menus().length], [0, 1], "the fallback returns when the screen drops its header");
	tab.release();
	// A job 404 keeps its recovery <h1>; a worker 404 draws its own row: <h1> Sessions, the id muted, an <h2> recovery.
	const missing = await v.open("#job/cp-doesnotexist", true, ".not-found");
	assert.deepEqual(texts(missing.$$("h1")), ["No job cp-doesnotexist"]);
	assert.deepEqual([missing.$(".page-header-fallback > p")?.textContent, missing.$(".page-header-fallback > .page-header-detail")?.textContent], ["Jobs", "cp-doesnotexist"]);
	const worker = await v.open("#sessions?view=workers&id=cp-doesnotexist", true, ".not-found-recovery > h2");
	assert.deepEqual(await until(() => [texts(worker.$$("h1")), worker.$(".page-header-fallback") === null, worker.$(".not-found-heading .page-header-back")?.textContent], (s) => s[1] === true, "the screen's header replaces the fallback"), [["Sessions"], true, "← Sessions"]);
	assert.deepEqual([worker.$(".not-found-heading > .page-header > .page-header-detail")?.textContent, worker.$(".not-found-recovery > h2")?.textContent], ["cp-doesnotexist", "No worker session cp-doesnotexist"]);
	// A context pill only when the page gives one.
	assert.equal((await v.open("#settings", true, ".settings-heading h1")).$(".page-header > h1 + .page-header-context")?.textContent, "This machine");
	assert.ok((await v.open("#jobs", true, ".jobs-heading h1")).$(".page-header-context") === null, "no context, no pill");

	// Phone header: More's views back out to More with the data time and search, no live status; Jobs views and
	// Decisions keep the live status; a job shows the time only.
	const phoneHeader = async (hash: string) => {
		const phone = await v.open(hash, false);
		await phone.find(".shell-header time.shell-clock");
		const header = phone.$(".shell-header")!;
		const search = header.querySelector("button.shell-search")!;
		assert.deepEqual([header.querySelectorAll("time.shell-clock").length, search.getAttribute("aria-haspopup"), /Search/.test(search.getAttribute("aria-label")!), search.hasAttribute("disabled"), search.getAttribute("aria-disabled")],
			[1, "dialog", true, false, null], hash);
		assert.ok(phone.$(".shell-corner") === null, hash);
		assert.ok(header.querySelector(".shell-header-right > .shell-search + details.shell-more:last-child"), `${hash}: ⋮ at the far right, after Search`);
		return header;
	};
	for (const hash of ["#files", "#schedules", "#reports"]) {
		const header = await phoneHeader(hash);
		assert.ok(header.querySelector('a[href="#more"][aria-label="Back to More"]'), hash);
		assert.match(header.textContent!, /command-post/);
		assert.ok(header.querySelector(".shell-live, .shell-badge") === null, `${hash}: the dashboard acts, no read-only badge, no live status`);
		assert.doesNotMatch(header.textContent!, /read-only/);
		assert.match(header.querySelector("time.shell-clock")!.textContent!, /^\d\d:\d\d\b/, "the data time sits in the phone header");
	}
	for (const hash of ["#map", "#board", "#decisions"]) {
		const header = await phoneHeader(hash);
		assert.deepEqual([!!header.querySelector('[aria-label="Back to More"]'), !!header.querySelector(".shell-live")], [false, true], hash);
	}
	assert.ok((await phoneHeader("#job/cp-one")).querySelector(".shell-live") === null, "a job's header has no live status");
	// The phone clock: stale until the stream opens, live (HH:MM, the full stamp its title), stale on loss, offline hidden.
	const phone = await v.open("#overview", false, ".overview-heading h1");
	const live = () => phone.$(".shell-header .shell-live")!.textContent!;
	assert.ok(await until(live, (s) => /^stale · \d\d:\d\d$/.test(s), "stale before the stream opens"));
	phone.signal("open");
	assert.ok(await until(live, (s) => /^\d\d:\d\d$/.test(s), "live: dot and HH:MM only"));
	assert.match(phone.$(".shell-header .shell-live time")!.getAttribute("title")!, /\d\d:\d\d:\d\d/);
	phone.signal("error");
	assert.ok(await until(live, (s) => /^stale · \d\d:\d\d$/.test(s), "stale after a lost stream"));
	Object.defineProperty(phone.document, "hidden", { configurable: true, value: true });
	phone.document.dispatchEvent(new phone.window.Event("visibilitychange"));
	assert.ok(await until(live, (s) => /^offline · \d\d:\d\d$/.test(s), "offline while hidden"));

	// A running session puts Restart session in the menu: one tap asks to confirm, the second posts; a dot while it runs.
	let shutdowns = 0;
	const file = join(v.stateDir, "operator-session.jsonl");
	writeFileSync(file, "", { flag: "a" });
	const ports: ControlPorts = { inject: () => {}, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => file, shutdown: () => void (shutdowns += 1),
		relaunchFile: () => join(v.stateDir, "operator", "relaunch.json"), parentSends: () => ({ ids: [], error: null }) };
	const control = await startDashboardControl({ stateDir: v.stateDir, ports, log: () => {} }) as DashboardControl;
	t.after(() => control.stop());
	const session = await v.open("#overview", true, ".overview-heading h1");
	const menu = session.$(".shell-main details.shell-more")! as Element & { open: boolean };
	assert.equal(session.$$(".operator-restart-button").length, 0, "Restart session no longer renders inline on Overview");
	menu.open = true;
	menu.dispatchEvent(new session.window.Event("toggle"));
	const restart = await session.find(".shell-more-panel .operator-restart-button", (b) => !b.hasAttribute("disabled") && b.textContent === "Restart session");
	session.click(restart);
	const confirm = await session.find(".shell-more-panel .operator-restart-confirm");
	assert.match(confirm.textContent!, /^Tap again to restart/);
	const posts = () => session.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/restart");
	assert.equal(posts().length, 0, "one tap sends nothing");
	session.click(confirm);
	await until(() => shutdowns, (n) => n === 1, "the second tap restarts");
	assert.deepEqual([posts().length, posts()[0]!.body], [1, '{"restart":true}']);
	assert.ok(await session.find('.shell-more-dot[aria-label="Restart in progress"]'), "a dot while the restart runs");
	control.stop();
	const next = await startDashboardControl({ stateDir: v.stateDir, ports, log: () => {} }) as DashboardControl;
	t.after(() => next.stop());
	assert.ok(await until(() => session.$(".shell-more-dot"), (dot) => dot === null, "restarted: the dot clears") === null);
	// Restart clean (its own viewer: the first restart holds this one's 60 s window): a second two-tap button that posts
	// `fresh` and says it starts a new session on the newest handoff.
	const cleanViewer = await served(t, () => {}, { tailnet: true });
	const cleanCalls: string[] = [];
	const cleanControl = await startDashboardControl({ stateDir: cleanViewer.stateDir, ports: { ...ports, shutdown: () => void cleanCalls.push("shutdown"),
		relaunchFile: () => join(cleanViewer.stateDir, "operator", "relaunch.json") }, log: () => {} }) as DashboardControl;
	t.after(() => cleanControl.stop());
	const cleanTab = await cleanViewer.open("#overview", true, ".overview-heading h1");
	const cleanMenu = cleanTab.$(".shell-main details.shell-more")! as Element & { open: boolean };
	cleanMenu.open = true;
	cleanMenu.dispatchEvent(new cleanTab.window.Event("toggle"));
	cleanTab.click(await cleanTab.find(".shell-more-panel .operator-restart-clean", (b) => !b.hasAttribute("disabled") && b.textContent === "Restart clean"));
	const cleanConfirm = await cleanTab.find(".shell-more-panel .operator-restart-confirm");
	assert.equal(cleanConfirm.textContent, "Tap again to restart clean · starts a new session on the newest handoff");
	const cleanPosts = () => cleanTab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/restart");
	assert.equal(cleanPosts().length, 0, "one tap sends nothing");
	cleanTab.click(cleanConfirm);
	await until(() => cleanCalls.length, (n) => n === 1, "the second tap restarts clean");
	assert.deepEqual([cleanPosts().length, cleanPosts()[0]!.body], [1, '{"restart":true,"fresh":true}']);
	assert.equal(JSON.parse(readFileSync(join(cleanViewer.stateDir, "operator", "relaunch.json"), "utf8")).fresh, true);
	cleanControl.stop();

	// A version alert puts the dot on ⋮ with no session, and Restart stays hidden.
	const alert = await served(t, (put) => put(join(LAYOUT.state, "update.json"), { schema_version: 1, phase: "idle", last_result: "failed", last_run_at: iso(5), fetch_failures: 0 }));
	const alerted = await alert.open("#overview", true, ".overview-heading h1");
	assert.ok(await alerted.find('.shell-main .shell-more-dot[aria-label="Version alert"]'), "a version alert dots the menu");
	assert.doesNotMatch(alerted.text(), /Restart session/);

	// Served CSS: a 44px ⋮ and an in-viewport themed panel; a hairline 48px desktop row, contents-only below 900px.
	assert.match(v.rule(".shell-more>summary"), /^width:44px;height:44px;/);
	assert.match(v.rule(".shell-more-panel"), /max-width:calc\(100vw - 16px\);.*background:var\(--surface\)/);
	assert.equal(v.css.filter((r) => /\.shell-more(?![\w-])/.test(r.selector) && /overflow:hidden/.test(r.body)).length, 0, "no rule can clip the open panel");
	assert.equal(details.className, "shell-more", "the menu shares no class with the More screen's list");
	assert.equal(v.rule(".page-header"), "display:contents", "below 900 px the screen's own <h1> layout is unchanged");
	assert.equal(v.rule(".page-header-back,.page-header-detail,.page-header-end,.page-header-fallback"), "display:none");
	assert.equal(v.css.filter((r) => r.selector.includes(".shell-main:has(>.page-header-fallback)") && r.media !== WIDE).length, 0, "the fallback column is desktop-only");
	const row = v.rule(".page-header", WIDE);
	assert.match(row, /height:48px;.*border-bottom:1px solid var\(--border\)/);
	assert.doesNotMatch(row, /background|position|z-index|margin/, "on the page surface, in flow");
	assert.match(v.rule(".shell .page-header>:is(h1,p)", WIDE), /font-size:20px;font-weight:600;.*text-overflow:ellipsis/);
	assert.equal(v.rule(".shell-main", WIDE), "min-width:0;padding:0 32px 48px");
	assert.equal(v.rule(".shell-main:has(.page-header:not(.page-header-fallback))>.page-header-fallback", WIDE), "display:none");
	assert.match(v.rule(".shell", WIDE), /--page-header-gap: 24px/);
	assert.equal(v.rule(".page-header-fallback", WIDE), "margin-bottom:var(--page-header-gap)");
	assert.equal(v.css.filter((r) => /margin-right:248px|z-index:4$/.test(r.body) || /shell-page-bar|session-title|job-crumb|not-found-crumb/.test(r.selector)).length, 0, "no overlay hacks left");
	assert.match(v.rule(".shell-sidebar", WIDE), /width:208px;/);
	assert.match(v.rule(".page-header-context"), /height:24px;.*border-radius:999px/);
});

function tab_facts(tab: Tab): string[] {
	return tab.$$(".job-facts > div").map((row) => `${row.querySelector("dt")?.textContent}:${row.querySelector("dd")?.textContent}`);
}
