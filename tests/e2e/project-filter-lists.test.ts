/**
 * M1 PR2: the project filter on Overview, Decisions, Jobs and Reports: `bin/cp-view` on a scratch home over HTTP
 * and the served app in a linkedom tab (tests/harness/dashboard.ts). The selection lives in the hash, never the API.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { DecisionsResponse, OverviewResponse, ReportsResponse } from "../../src/viewer/api-types.ts";
import { dashboard, type Tab, until } from "../harness/dashboard.ts";
import type { Context } from "../harness/conversations.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const HEAD = "b".repeat(40);
const FILTER = 'select[aria-label="Filter by project"]';

/** Two projects across every list, an untagged ledger job, M2 and legacy boards, and a job report. */
function seed(home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	const job = (id: string, project: string | null, status: string, extra: object = {}) =>
		({ id, title: `Title ${id}`, status, labels: [...(project ? [`project:${project}`] : []), "kind:ship"], blocked_by: [], ...extra });
	put(".pi-command-post/jobs.json", { jobs: [job("cp-pa", "picp", "in_progress"), job("cp-at", "atlas", "in_progress"), job("cp-delta", "picp", "in_progress"),
		job("cp-fail", "atlas", "in_progress"), job("cp-merged", "picp", "closed", { closed_at: iso(30) }), job("cp-wait", "atlas", "open", { blocked_by: ["cp-pa"] }),
		job("cp-loose", null, "open"), job("cp-shut", "picp", "closed", { closed_at: iso(25) })] });
	put(LAYOUT.fleetFile, { jobs: [
		{ job_id: "cp-pa", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-at", project: "atlas", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-delta", project: "picp", kind: "ship", delivery: "pr", phase: "awaiting_merge", branch: "cp-delta", dispatched_at: iso(300), reported_at: iso(120),
			awaiting_merge: { cycle: 1, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-delta", head_sha: HEAD, base: "main", handed_at: iso(120), released_at: iso(120), frozen_seconds: 600, frozen_usage: {} } },
		{ job_id: "cp-fail", project: "atlas", kind: "ship", phase: "failed", dispatched_at: iso(90), failure: { class: "crash", message: "worker died", at: iso(80) } },
		{ job_id: "cp-merged", project: "picp", kind: "ship", phase: "done", dispatched_at: iso(90), closed_at: iso(30) },
	] });
	put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", pr_url: "https://github.com/o/r/pull/2", merge_commit_sha: "c".repeat(40), merged_at: iso(30) });
	const ask = (id: string, project: string) => ({ type: "open", id, created_at: iso(20), project, question: `Merge ${project}?`, options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep" });
	put(join(LAYOUT.state, "operator/asks.jsonl"), `${[ask("ask-b2", "picp"), ask("ask-a1", "atlas")].map((a) => JSON.stringify(a)).join("\n")}\n`);
	const answered = (id: string, job_ids: string[]) => ({ id, status: "answered", question: `Ship ${id}?`, created_at: iso(40), answered_at: iso(10), answered_by: "operator-delegated", answer: "yes", options: [{ id: "yes", label: "Ship it" }], job_ids });
	put(LAYOUT.escalationsFile, { items: [{ id: "es-q", status: "open", question: "Widen cp-pa?", created_at: iso(15), kind: "scope_expansion", job_ids: ["cp-pa"] }, answered("es-d", ["cp-at"]), answered("es-n", []),
		{ ...answered("es-s", []), answered_by: "schedule-run:run-1", basis: { run: "run-1" } }] });
	put(join(LAYOUT.state, "next-snapshot.json"), { schema_version: 2, at: iso(5), project: null, empty_since: null, items: [{ kind: "job", id: "cp-wait", project: "atlas", title: "Title cp-wait", verdict: "blocked", reason: "waits on cp-pa" }], unavailable: [] });
	const board = (slug: string, meta: object) => put(join(LAYOUT.state, "boards", slug, "board.json"), { title: `Board ${slug}`, description: slug, ...meta });
	board("chat-atlas", { created_at: iso(10), job_ids: [], project: "atlas", source: "chat:es-d" });
	board("legacy-pa", { created_at: iso(20), job_ids: ["cp-pa"] });
	board("legacy-multi", { created_at: iso(21), job_ids: ["cp-pa", "cp-at"] });
	board("legacy-lost", { created_at: iso(22), job_ids: ["cp-gone"] });
	board("explicit-pi", { created_at: iso(23), job_ids: ["cp-at"], project: "picp", source: "schedule:nightly" });
	board("none-chat", { created_at: iso(24), job_ids: [], project: null, source: "chat:es-n" });
	put(join(LAYOUT.state, "artifacts/cp-at/report.md"), "# Atlas findings\n");
}

/** Picks `value` in the filter as a browser would, then lets the route see the hash the app wrote. */
async function choose(tab: Tab, value: string) {
	const select = await tab.find(FILTER);
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === value);
	select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	tab.go(tab.window.location.hash);
	await new Promise((done) => setTimeout(done, 50));
}
const chosen = (tab: Tab) => (tab.$(FILTER) as unknown as { value: string } | null)?.value;
const reads = (tab: Tab, prefix: string) => tab.requests.filter((r) => r.path.startsWith(prefix)).map((r) => r.path);
const start = (t: Context) => dashboard(t, { at: iso(0), seed: (_state, home) => seed(home) });

test("M1-lists-api: reports carry M2 project/source with a legacy fallback; decisions and overview rows carry projects", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const reports = (await d.get("/api/reports")).body as unknown as ReportsResponse;
	const bySlug = Object.fromEntries(reports.reports.map((r) => [r.slug, r]));
	assert.deepEqual([bySlug["chat-atlas"]?.project, bySlug["chat-atlas"]?.source, bySlug["chat-atlas"]?.projects], ["atlas", "chat:es-d", ["atlas"]], "a jobless M2 board keeps its metadata");
	assert.deepEqual(bySlug["explicit-pi"]?.projects, ["picp"], "an explicit project wins over the job ids' atlas");
	assert.deepEqual([bySlug["legacy-pa"]?.projects, bySlug["legacy-multi"]?.projects, bySlug["legacy-lost"]?.projects, bySlug["none-chat"]?.projects],
		[["picp"], ["picp", "atlas"], [], []], "legacy boards resolve their job ids; unresolved or null is untagged");
	assert.equal(bySlug["legacy-pa"]?.href, "/boards/legacy-pa/");
	assert.deepEqual(reports.job_reports?.map((r) => [r.job_id, r.projects]), [["cp-at", ["atlas"]]]);
	const decisions = (await d.get("/api/decisions")).body as unknown as DecisionsResponse;
	assert.deepEqual(decisions.parent_questions.map((q) => [q.id, q.projects]), [["es-q", ["picp"]]]);
	assert.deepEqual(decisions.decided.map((x) => [x.id, x.source, x.projects]).sort(), [["es-d", "operator-delegated", ["atlas"]], ["es-n", "operator-delegated", []], ["es-s", "schedule-run", []]]);
	assert.equal(decisions.decided_today.count, 2, "the server counts delegated decisions only");
	const overview = (await d.get("/api/overview")).body as unknown as OverviewResponse;
	assert.deepEqual([overview.shipped_today.map((j) => [j.id, j.project]), overview.blocked.items.map((j) => [j.id, j.project])], [[["cp-merged", "picp"]], [["cp-wait", "atlas"]]]);
});

test("M1-lists-reports-decisions: Reports and Decisions narrow their lists and counts; Handoffs keeps its own filter", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const tab = await d.open("#reports?project=picp");
	await tab.waitText(/Board legacy-pa/);
	const text = () => tab.$(".jobs-screen")?.textContent ?? "";
	assert.equal(chosen(tab), "picp");
	assert.match(text(), /Published · 3/);
	for (const slug of ["legacy-pa", "legacy-multi", "explicit-pi"]) assert.ok(text().includes(`Board ${slug}`), slug);
	for (const slug of ["chat-atlas", "legacy-lost", "none-chat"]) assert.ok(!text().includes(`Board ${slug}`), slug);
	assert.match(text(), /Job reports · 0[\s\S]*No job reports for picp/);
	assert.equal(tab.$('a[href="/boards/explicit-pi/"]')?.getAttribute("target"), "_blank", "links stay valid");
	await choose(tab, "atlas");
	assert.equal(tab.window.location.hash, "#reports?project=atlas");
	await until(text, (s) => s.includes("Board chat-atlas") && !s.includes("Board explicit-pi"), "the atlas reports");
	assert.match(text(), /Published · 2[\s\S]*Board legacy-multi[\s\S]*Job reports · 1[\s\S]*Atlas findings/);
	await choose(tab, "/untagged");
	await until(text, (s) => s.includes("Board legacy-lost") && s.includes("Board none-chat") && !s.includes("Board legacy-multi"), "untagged reports");
	await choose(tab, "");
	assert.equal(tab.window.location.hash, "#reports");
	await until(text, (s) => s.includes("Published · 6"), "All");
	assert.deepEqual(reads(tab, "/api/reports"), ["/api/reports"], "the selection never reaches the API or remounts the screen");
	tab.go("#reports?view=handoffs&project=picp");
	await tab.waitText(/Back to reports/);
	await until(() => reads(tab, "/api/handoffs"), (r) => r.includes("/api/handoffs?project=picp"), "Handoffs reads its own project filter");
	assert.equal(tab.$(FILTER), null, "and shows no list filter");

	const decisions = await d.open("#decisions?project=atlas");
	await decisions.find(".awaiting-card");
	const page = () => decisions.$(".decisions")?.textContent ?? "";
	assert.deepEqual(decisions.$$(".awaiting-card").map((c) => c.textContent?.includes("ask-a1")), [true], "only the atlas ask, its id intact");
	assert.match(page(), /1 of 1/);
	assert.match(page(), /Decided for you 1/);
	assert.ok(!page().includes("Being handled"), "the picp parent question is hidden");
	assert.equal(decisions.$(".shell-count")?.textContent, "2", "the Decisions badge stays global");
	await choose(decisions, "picp");
	await until(page, (s) => s.includes("Being handled") && s.includes("Decided for you 0"), "the picp decisions");
	assert.ok(decisions.$$(".awaiting-card").every((c) => c.textContent?.includes("ask-b2")));
	await choose(decisions, "/untagged");
	// es-n (delegated) and es-s (schedule run) are untagged: the log lists both, decided_today counts es-n as the API does.
	await until(page, (s) => s.includes("Decided for you 2") && s.includes("1 decided today · 1 for you, 0 by you"), "untagged decisions");
});

test("M1-lists-overview-jobs: Overview and Jobs filter before counts, keep global health, phase tabs and job links", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const overview = await d.open("#overview");
	await overview.waitText(/In flight · 2/);
	const health = overview.$('[aria-label="Health"]')?.textContent;
	assert.match(overview.text(), /closed without PR/, "All keeps the global closed count");
	overview.go("#overview?project=atlas");
	await overview.waitText(/In flight · 1/);
	const ov = () => overview.$(".overview")?.textContent ?? "";
	assert.equal(chosen(overview), "atlas");
	const options = [...(overview.$(FILTER)?.querySelectorAll("option") ?? [])].map((o) => o.textContent);
	assert.deepEqual(options, ["All", "Untagged", "atlas", "picp"], "every Landed/Blocked row names a real project, never \"undefined\"");
	assert.match(ov(), /Needs you · 1/);
	assert.match(ov(), /Blocked & failed · 2/);
	assert.match(ov(), /Landed today · 0 merged/);
	assert.ok(!ov().includes("closed without PR"), "a global closed count is never shown as the project's");
	assert.ok(ov().includes("Title cp-wait") && !ov().includes("Title cp-pa") && !ov().includes("Merge picp?"));
	assert.equal(overview.$('[aria-label="Health"]')?.textContent, health, "health stays global");
	assert.deepEqual(reads(overview, "/api/overview"), ["/api/overview"], "one read for both selections");

	const jobs = await d.open("#jobs?project=picp");
	await jobs.find('a[href="#job/cp-pa"]');
	const list = () => jobs.$(".jobs-screen")?.textContent ?? "";
	assert.ok(!list().includes("cp-at") && !list().includes("cp-loose"));
	assert.match(list(), /In flight1/);
	jobs.click(jobs.$$(".jobs-segments button").find((b) => b.textContent?.startsWith("In flight"))!);
	await choose(jobs, "atlas");
	assert.equal(jobs.window.location.hash, "#jobs?project=atlas");
	await jobs.find('a[href="#job/cp-at"]');
	assert.equal(jobs.$$(".jobs-segments button").find((b) => b.getAttribute("aria-pressed") === "true")?.textContent, "In flight1", "the phase tab composes with the selection");
	await choose(jobs, "/untagged");
	jobs.click(jobs.$$(".jobs-segments button").find((b) => b.textContent?.startsWith("All"))!);
	await jobs.find('a[href="#job/cp-loose"]');
	assert.ok(!list().includes("cp-pa"), "Untagged is the Unassigned bucket only");
	assert.deepEqual(reads(jobs, "/api/jobs"), ["/api/jobs"]);
	await choose(jobs, "picp");
	const guide = await jobs.find("a.job-guide-link");
	jobs.go(guide.getAttribute("href")!);
	await jobs.find('[aria-label="Review guide"]');
	assert.ok(await jobs.find(".evidence-ask", (a) => /Ask about this job/.test(a.textContent ?? "")), "the P1 action survives the filtered list");
	jobs.go("#jobs?project=atlas");
	await jobs.find('a[href="#job/cp-at"]');
	assert.equal(chosen(jobs), "atlas", "back to a filtered list restores its selection");
	jobs.go("#jobs?view=history&project=picp");
	await until(() => reads(jobs, "/api/jobs/history"), (r) => r.includes("/api/jobs/history?project=picp"), "History keeps its own filter");
	const stats = await d.open("#stats?project=picp");
	await until(() => reads(stats, "/api/stats"), (r) => r.some((p) => p.includes("project=picp")), "Stats keeps its own server filter");
	for (const hash of ["#board", "#map", "#settings", "#files"]) {
		const other = await d.open(hash);
		await new Promise((done) => setTimeout(done, 300));
		assert.equal(other.$(FILTER), null, `${hash} has no project filter`);
	}
});
