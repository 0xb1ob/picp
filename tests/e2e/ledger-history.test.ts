/**
 * P2 job history: cp_job history, /cp-jobs history, the operator's cp_parent jobs and GET /api/jobs/history answer one
 * bounded query the same way (ids, order, dates, literal text, pages), with no parent running for the operator read.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { readParentLock } from "../../src/parent-lock.ts";
import { startViewer } from "../harness/dashboard.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc } from "../harness/index.ts";
import { bench, details, type End, type Ends, failed, job, ok, text } from "./project-tracker-helpers.ts";

const writeFile = (file: string, body: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const closed = (id: string, closedAt: string, extra: Record<string, unknown> = {}) => ({
	id, title: `LH ${id}`, status: "closed", labels: ["project:demo-app", "delivery:pr", "kind:ship"], blocked_by: [], comments: [],
	created_at: "2026-02-01T00:00:00Z", updated_at: closedAt, closed_at: closedAt, close_reason: `landed ${id}`, ...extra,
});
/** 28 closed jobs: three on Mar 2 that match "needle" only in a close reason, a comment or an accepted headline. */
function seed(home: string): void {
	const rows: Array<Record<string, unknown>> = Array.from({ length: 24 }, (_, n) => closed(`cp-lh${String(n).padStart(3, "0")}`, at("2026-03-01", n)));
	rows.push(
		closed("cp-lhnote", at("2026-03-02", 5), { comments: [{ at: at("2026-03-02", 5), author: "parent", text: "a NEEDLE in a comment" }] }),
		closed("cp-lhhead", at("2026-03-02", 6), { labels: ["project:other-app", "delivery:pr", "kind:ship"] }),
		closed("cp-lhdrop", at("2026-03-02", 7), { close_reason: "dropped: needle superseded" }),
		// Updated after its close: the history order and closed_at window still read the close.
		closed("cp-lhupd", "2026-01-15T00:00:00Z", { updated_at: "2026-03-05T00:00:00Z" }),
		{ ...closed("cp-lhopen", at("2026-03-03", 1)), status: "open", title: "LH reopened needle", closed_at: undefined, close_reason: undefined },
	);
	writeFile(join(home, LAYOUT.jobsFile), JSON.stringify({ schema_version: 1, prefix: "cp", jobs: rows }));
}
async function report(home: string, jobId: string, summary: string): Promise<void> {
	await new FleetStore({ home }).add({
		job_id: jobId, project: "other-app", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "done", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE, branch: jobId, worktree: home, receipts: [],
		worker: { pid: 1, session_id: "fixture", session_file: join(home, "worker.jsonl"), profile: "implementer", role: "implementer", model: "mock/worker", started_at: isoTimestamp() },
	});
	writeFile(join(home, paths.envelopeFile(jobId)), JSON.stringify({ envelope: { status: "done", summary } }));
	writeFile(join(home, paths.artifactFile(jobId)), "LH-BODY-SENTINEL needle\n");
}

const PAGE1 = ["cp-lhdrop", "cp-lhhead", "cp-lhnote", ...Array.from({ length: 17 }, (_, n) => `cp-lh${String(23 - n).padStart(3, "0")}`)];
const PAGE2 = [...Array.from({ length: 7 }, (_, n) => `cp-lh${String(6 - n).padStart(3, "0")}`), "cp-lhupd"];
const NEEDLE = ["cp-lhdrop", "cp-lhhead", "cp-lhnote"];
const WINDOW = ["cp-lh018", "cp-lh017", "cp-lh016", "cp-lh015", "cp-lh014"];
const QUERIES: Array<[string, Record<string, unknown>, string]> = [
	["page1", {}, ""], ["page2", { offset: 20 }, "--offset 20"], ["needle", { q: "NeEdLe" }, "--q NeEdLe"],
	["window", { since: "2026-03-01", until: "2026-03-02", limit: 5, offset: 5 }, "--since 2026-03-01 --until 2026-03-02 --limit 5 --offset 5"],
	["updated", { date_field: "updated_at", since: "2026-03-04" }, "--date-field updated_at --since 2026-03-04"],
	["project", { project: "other-app" }, "--project other-app"],
];
const WANT: Record<string, { ids: string[]; total: number; next: number | null }> = {
	page1: { ids: PAGE1, total: 28, next: 20 }, page2: { ids: PAGE2, total: 28, next: null }, needle: { ids: NEEDLE, total: 3, next: null },
	window: { ids: WINDOW, total: 24, next: 10 }, updated: { ids: ["cp-lhupd"], total: 1, next: null }, project: { ids: ["cp-lhhead"], total: 1, next: null },
};
const idsOf = (out: string) => [...out.matchAll(/^(cp-[a-z0-9]+) {2}/gm)].map((m) => m[1]);

/** One operator session (cp-bridge only, no parent) playing `calls` against `home`; returns each call's end. */
async function operator(t: TestContext, home: string, name: string, calls: Array<{ id: string; args: Record<string, unknown> }>): Promise<Ends> {
	const provider = await MockProvider.start();
	const model = provider.addScript(name, [...calls.map((c) => ({ kind: "tool_calls" as const, calls: [{ id: c.id, name: "cp_parent", args: c.args }] })), { kind: "text", text: "read" }]);
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: home, env: { ...agent.env, PI_HOME: home, CP_HOME: home }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); });
	rpc.send({ type: "prompt", id: name, message: "Read the job history." });
	await rpc.waitFor((r) => r.type === "agent_settled", 120_000);
	return new Map(rpc.records().filter((r) => r.type === "tool_execution_end").map((r) => [String(r.toolCallId), r as End]));
}

test("P2 job history: tool, slash command, operator bridge and HTTP agree on ids, order, dates, text and pages", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "lh-parity");
	seed(s.home);
	await report(s.home, "cp-lhhead", "Shipped the NEEDLE headline");
	const { ends, notes } = await s.run([
		{ prompt: "Query the history.", calls: [
			...QUERIES.map(([id, args]) => job(`t-${id}`, { action: "history", ...args })),
			job("t-list", { action: "list" }), job("t-list-q", { action: "list", q: "needle" }),
			job("t-bad-date", { action: "history", since: "2026-02-30" }), job("t-reversed", { action: "history", since: "2026-03-02", until: "2026-03-01" }),
			job("t-ready-q", { action: "ready", q: "needle" }),
		] },
		...QUERIES.map(([, , flags]) => ({ prompt: `/cp-jobs history ${flags}`.trim(), until: /^history: / })),
	]);
	const slash = notes.filter((note) => note.startsWith("history: "));
	assert.equal(slash.length, QUERIES.length, notes.join("\n---\n"));
	assert.equal(readParentLock(s.home).state, "absent", "the parent closed before the operator reads");
	const fleetBefore = readFileSync(join(s.home, LAYOUT.state, "fleet.json"), "utf8");
	const bridge = await operator(t, s.home, "lh-bridge", [
		...QUERIES.map(([id, args]) => ({ id: `b-${id}`, args: { action: "jobs", jobs: { mode: "history", ...args } } })),
		{ id: "b-show", args: { action: "jobs", jobs: { mode: "show", job_id: "cp-lhnote" } } },
		{ id: "b-list", args: { action: "jobs", jobs: { mode: "list", q: "needle" } } },
		{ id: "b-bad", args: { action: "jobs", jobs: { mode: "history", until: "2026-13-01" } } },
	]);
	assert.equal(readParentLock(s.home).state, "absent", "cp_parent jobs never starts a parent");
	assert.equal(readFileSync(join(s.home, LAYOUT.state, "fleet.json"), "utf8"), fleetBefore, "cp_parent jobs writes no fleet state");
	const viewer = await startViewer(t, { home: s.home });

	for (const [index, [id, args]] of QUERIES.entries()) {
		const want = WANT[id]!;
		const tool = ok(ends, `t-${id}`);
		assert.deepEqual(details<{ ids: string[] }>(ends, `t-${id}`).ids, want.ids, `cp_job ${id}`);
		assert.deepEqual(idsOf(tool), want.ids, `cp_job text ${id}`);
		assert.equal(slash[index], tool, `/cp-jobs ${id} prints what cp_job returns`);
		assert.notEqual(bridge.get(`b-${id}`)?.isError, true, JSON.stringify(bridge.get(`b-${id}`)));
		assert.equal(text(bridge, `b-${id}`), tool, `cp_parent jobs ${id} returns what cp_job returns`);
		const query = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]));
		const http = await viewer.get(`/api/jobs/history?${query}`);
		assert.equal(http.status, 200, JSON.stringify(http.body));
		const body = http.body as { rows: Array<{ id: string; headline: string | null }>; total: number; next_offset: number | null; warnings: unknown[] };
		assert.deepEqual(body.rows.map((r) => r.id), want.ids, `HTTP ${id}`);
		assert.deepEqual([body.total, body.next_offset, body.warnings], [want.total, want.next, []], `HTTP paging ${id}`);
		assert.match(tool, new RegExp(`^history: .* of ${want.total}${want.next === null ? "$" : `; next offset ${want.next}$`}`, "m"), id);
	}
	assert.match(ok(ends, "t-needle"), /cp-lhdrop .* DROPPED dropped: needle superseded\n[^]*report DONE: Shipped the NEEDLE headline/);
	const headed = (await viewer.get("/api/jobs/history?q=needle")).body as { rows: Array<{ id: string; headline: string | null; dropped: boolean }> };
	assert.deepEqual(headed.rows.map((r) => [r.id, r.headline, r.dropped]), [["cp-lhdrop", null, true], ["cp-lhhead", "Shipped the NEEDLE headline", false], ["cp-lhnote", null, false]]);
	for (const surface of [JSON.stringify([...ends.values()]), JSON.stringify([...bridge.values()]), JSON.stringify(headed), notes.join("\n")]) {
		assert.ok(!surface.includes("LH-BODY-SENTINEL"), "never a report body");
	}
	assert.match(text(bridge, "b-show"), /cp-lhnote {2}closed[^]*comment: .*a NEEDLE in a comment/);
	assert.deepEqual(details<{ ids: string[] }>(bridge, "b-list").ids, ["cp-lhopen"], "list with q reads open jobs; a reopened job is no close");

	// Compatibility: a list with no query keys keeps its old unbounded shape; q makes it a paged query.
	assert.deepEqual(details<{ jobs: Array<{ id: string }> }>(ends, "t-list").jobs.map((j) => j.id), ["cp-lhopen"]);
	assert.equal("total" in details(ends, "t-list"), false, "plain cp_job list is unchanged");
	assert.match(ok(ends, "t-list-q"), /^list: 1-1 of 1\ncp-lhopen {2}open since/);
	failed(ends, "t-bad-date", /since.*2026-02-30/);
	failed(ends, "t-reversed", /since .*before.*until|until.*after.*since|reversed|empty range/i);
	failed(ends, "t-ready-q", /history\/list only/);
	assert.equal(bridge.get("b-bad")?.isError, true, "a bad bridge date refuses");
	assert.match(text(bridge, "b-bad") || JSON.stringify(bridge.get("b-bad")), /until.*2026-13-01/);
	for (const bad of ["since=2026-02-30", "since=2026-03-02&until=2026-03-01", "date_field=title", "limit=101", "offset=-1"]) {
		assert.equal((await viewer.get(`/api/jobs/history?${bad}`)).status, 400, bad);
	}
	const jobs = await viewer.get("/api/jobs");
	assert.equal(jobs.status, 200);
	assert.equal("next_offset" in (jobs.body as object), false, "/api/jobs keeps its own response");

	// The served Jobs screen links its older rows to History, which pages and filters through the hash.
	const tab = await viewer.open("#jobs");
	assert.equal((await tab.find(".jobs-history-link")).getAttribute("href"), "#jobs?view=history");
	tab.go("#jobs?view=history");
	await tab.find(".jobs-history-row a[href='#job/cp-lhdrop']");
	assert.equal(tab.$$(".jobs-history-row").length, 20);
	assert.equal(tab.$(".jobs-history-pages a")?.getAttribute("href"), "#jobs?view=history&offset=20");
	assert.match(tab.text(), /Dropped · dropped: needle superseded[^]*Report done: Shipped the NEEDLE headline/);
	tab.go("#jobs?view=history&q=needle");
	await tab.waitText(/1–3 of 3/);
	tab.go("#jobs?view=history&since=2026-02-30");
	await tab.waitText(/This search was refused/);
	// No layout engine here: the served stylesheet pins wrapping, so long text holds at 390 px and 1440 px alike.
	const page = (await viewer.get("/")).text;
	const css = (await viewer.get(/href="(\/assets\/viewer\/[^"]+\.css)"/.exec(page)![1]!)).text.replace(/\s+/g, "");
	for (const rule of [/\.jobs-history-filters\{display:flex;flex-wrap:wrap/, /\.jobs-history-field\{[^}]*min-width:0;flex:11140px/,
		/\.jobs-history-row\{[^}]*min-width:0;overflow-wrap:anywhere/, /\.jobs-history-title\{display:flex;flex-wrap:wrap/, /\.jobs-history-pagesa\{[^}]*min-height:44px/]) {
		assert.match(css, rule);
	}
});

test("P2 job history: a missing or corrupt ledger and an unreadable envelope are named, never an empty match", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const viewer = await startViewer(t, { home: home.path });
	const missing = await operator(t, home.path, "lh-missing", [{ id: "m", args: { action: "jobs", jobs: { mode: "history" } } }]);
	assert.match(text(missing, "m"), /^history: none of 0\nno rows \(sources limited, see below\)\nsource warning: ledger: no ledger file yet/);
	assert.match(JSON.stringify((await viewer.get("/api/jobs/history")).body), /"section":"ledger","message":"no ledger file yet/);
	assert.equal(existsSync(join(home.path, LAYOUT.jobsFile)), false, "a read creates no ledger");

	writeFile(join(home.path, LAYOUT.jobsFile), "{ not json");
	const corrupt = await operator(t, home.path, "lh-corrupt", [{ id: "c", args: { action: "jobs", jobs: { mode: "history", q: "x" } } }]);
	assert.match(text(corrupt, "c"), /no rows \(sources limited, see below\)\nsource warning: ledger: unavailable/);
	assert.match(JSON.stringify((await viewer.get("/api/jobs/history?q=x")).body), /"section":"ledger","message":"unavailable/);

	seed(home.path);
	await report(home.path, "cp-lhhead", "headline");
	writeFile(join(home.path, paths.envelopeFile("cp-lhhead")), '{"envelope": {"status": "done", "summ');
	const torn = await operator(t, home.path, "lh-torn", [{ id: "e", args: { action: "jobs", jobs: { mode: "history", q: "zzz-no-such" } } }]);
	assert.match(text(torn, "e"), /^history: none of 0\nno rows \(sources limited, see below\)\nsource warning: envelopes: 1 reported envelope/);
	const http = (await viewer.get("/api/jobs/history?project=other-app")).body as { rows: Array<{ id: string; headline: string | null }>; warnings: Array<{ section: string }> };
	assert.deepEqual([http.rows.map((r) => [r.id, r.headline]), http.warnings.map((w) => w.section)], [[["cp-lhhead", null]], ["envelopes"]]);
	const none = (await viewer.get("/api/jobs/history?q=zzz-no-such&project=demo-app")).body as { total: number; warnings: unknown[] };
	assert.deepEqual([none.total, none.warnings], [0, []], "no match on healthy sources carries no warning");
});
