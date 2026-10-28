/**
 * Behavior 22 (P22): the dashboard's reports and stats through a real `bin/cp-view` — `/api/reports`, the boards it
 * serves read-only under `/boards/`, `/api/stats` over a seeded home, and the served Reports and Stats screens.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { STALE_WAKEUP_HEADLINE, WAKEUP_CUSTOM_TYPES } from "../../src/wakeups.ts";
import { startViewer, until } from "../harness/dashboard.ts";
import { createScratchHome } from "../harness/index.ts";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: any };
const NOW = "2026-10-08T12:00:00Z";
const T = (hhmm: string, day = "2026-10-08") => `${day}T${hhmm}:00Z`;

function get(port: number, path: string, init: { method?: string; host?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: init.host ?? `127.0.0.1:${port}` } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const body = Buffer.concat(chunks);
				let json: unknown = {};
				try { json = JSON.parse(body.toString("utf8")); } catch { /* not JSON */ }
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

/** Boards as the board skill publishes them: valid ones, a torn one, and four that resolve outside the boards dir. */
function seedBoards(home: string) {
	const outside = mkdtempSync(join(tmpdir(), "cp-boards-out-"));
	const boards = join(home, LAYOUT.state, "boards");
	const make = (slug: string, meta: unknown): string => {
		const site = join(boards, slug, "site");
		mkdirSync(join(site, "img"), { recursive: true });
		writeFileSync(join(boards, slug, "board.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
		return site;
	};
	const site = make("alpha", { title: "Alpha report", description: "the first", job_ids: ["cp-1", 7, null], created_at: "2026-09-01T00:00:00Z" });
	writeFileSync(join(site, "index.html"), '<link rel="stylesheet" href="/boards/board.css"><h1>Alpha</h1>');
	writeFileSync(join(site, "img", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(site, ".hidden"), "no");
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(join(outside, "secret.txt"), join(site, "out.txt"));
	symlinkSync(join(site, "index.html"), join(site, "in.html"));
	writeFileSync(join(make("beta", { title: "Beta report", description: "the second", job_ids: ["cp-2"], created_at: "2026-09-03T00:00:00Z" }), "index.html"), "beta");
	make("broken", "{not json");
	make("untimed", { title: "No timestamp" });
	make("untitled", { title: "", created_at: "2026-09-02T00:00:00Z" });
	make("Upper", { title: "Upper", created_at: "2026-09-02T00:00:00Z" });
	const escape = make("escape", { title: "Escape", created_at: "2026-09-02T00:00:00Z" });
	rmSync(escape, { recursive: true });
	mkdirSync(join(outside, "elsewhere"));
	writeFileSync(join(outside, "elsewhere", "index.html"), "elsewhere");
	symlinkSync(join(outside, "elsewhere"), escape);
	mkdirSync(join(outside, "linked"));
	writeFileSync(join(outside, "linked", "board.json"), JSON.stringify({ title: "Linked", created_at: "2026-09-04T00:00:00Z" }));
	symlinkSync(join(outside, "linked"), join(boards, "linked"));
	const jsonout = make("jsonout", {});
	writeFileSync(join(jsonout, "index.html"), "jsonout");
	rmSync(join(boards, "jsonout", "board.json"));
	writeFileSync(join(outside, "elsewhere.json"), JSON.stringify({ title: "Out", created_at: "2026-09-05T00:00:00Z" }));
	symlinkSync(join(outside, "elsewhere.json"), join(boards, "jsonout", "board.json"));
	return { outside, make };
}

async function boardsRig(t: TestContext) {
	const scratch = createScratchHome();
	const seeded = seedBoards(scratch.path);
	t.after(() => { scratch.cleanup(); rmSync(seeded.outside, { recursive: true, force: true }); });
	const viewer = await startViewer(t, { home: scratch.path, at: NOW });
	return { home: scratch.path, viewer, make: seeded.make, get: (path: string, host?: string) => get(viewer.port, path, host ? { host } : {}) };
}

test("P22-reports-api: /api/reports lists valid boards newest first, one revision per job set, and /boards/ opens it", async (t) => {
	const s = await boardsRig(t);
	const first = await s.get("/api/reports");
	assert.equal(first.status, 200);
	assert.match(first.json.generated_at, /^2026-10-08T12:0\d:\d\d\.\d{3}Z$/, "stamped by the viewer's clock");
	assert.deepEqual(first.json.reports.map((r: { slug: string }) => r.slug), ["beta", "alpha"], "newest first; torn, untitled, untimed, bad-slug and outside boards skipped");
	assert.deepEqual(first.json.reports.map((r: { href: string }) => r.href), ["/boards/beta/", "/boards/alpha/"]);
	assert.deepEqual([first.json.reports[1].title, first.json.reports[1].description, first.json.reports[1].job_ids], ["Alpha report", "the first", ["cp-1"]], "job_ids keeps its strings");
	s.make("beta-rev2", { title: "Beta report v2", description: "revised", job_ids: ["cp-2"], created_at: "2026-09-03T12:00:00Z" });
	s.make("loose-a", { title: "Loose", job_ids: [], created_at: "2026-09-02T00:00:00Z" });
	s.make("loose-b", { title: "Loose too", job_ids: [], created_at: "2026-09-02T01:00:00Z" });
	const later = await until(() => s.get("/api/reports"), (reply) => reply.json.reports.length === 4, "the new boards");
	assert.deepEqual(later.json.reports.map((r: { slug: string }) => r.slug), ["beta-rev2", "loose-b", "loose-a", "alpha"]);
	assert.deepEqual(later.json.reports.find((r: { slug: string }) => r.slug === "loose-a").description, "", "a missing description is empty");
	const index = await s.get("/boards/");
	assert.deepEqual([index.status, index.headers.location], [302, "/#reports"]);
	const empty = createScratchHome();
	t.after(() => empty.cleanup());
	const bare = await startViewer(t, { home: empty.path });
	assert.deepEqual((await get(bare.port, "/api/reports")).json.reports, []);
	assert.deepEqual((await get(bare.port, "/api/sessions")).json.boards, []);
});

test("P22-boards-serve: a board is served read-only from its own site/ under a strict CSP; everything else 404s", async (t) => {
	const s = await boardsRig(t);
	const index = await s.get("/boards/alpha/");
	assert.equal(index.status, 200); assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
	const csp = String(index.headers["content-security-policy"]);
	assert.match(csp, /default-src 'self'/);
	assert.match(csp, /style-src 'self' 'unsafe-inline'/, "inline <style> blocks and style attributes render");
	assert.equal(csp.match(/script-src [^;]*/)?.[0], "script-src 'none'", "scripts stay blocked, inline included");
	assert.match(csp, /object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
	assert.match(index.body.toString(), /<h1>Alpha<\/h1>/);
	const png = await s.get("/boards/alpha/img/a.png");
	assert.equal(png.headers["content-type"], "image/png"); assert.deepEqual([...png.body], [0x89, 0x50, 0x4e, 0x47]);
	assert.equal((await s.get("/boards/alpha/in.html")).status, 200, "a symlink that stays inside site/ is fine");
	assert.equal((await s.get("/boards/q3-report-")).status, 404, "a valid slug with no board");
	const css = await s.get("/boards/board.css");
	assert.equal(css.status, 200); assert.match(String(css.headers["content-type"]), /text\/css/);
	assert.doesNotMatch(css.body.toString(), /https?:\/\/|@import|url\(/, "the built-in stylesheet loads nothing external");
	const redirect = await s.get("/boards/alpha");
	assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, "/boards/alpha/");
	const refused = ["/boards/nope/", "/boards/broken/", "/boards/Upper/", "/boards/-a/", "/boards/a_b/", "/boards/a.b/", `/boards/${"x".repeat(65)}/`, "/boards/%C3%A9/",
		"/boards/alpha/out.txt", "/boards/alpha/..%2Fboard.json", "/boards/alpha/%2e%2e/board.json", "/boards/alpha/img/..%2f..%2fboard.json", "/boards/alpha/.hidden",
		"/boards/alpha/img", "/boards/alpha/img/", "/boards/alpha/%E0%A4%A", "/boards/alpha/a%00.png", "/boards/alpha/missing.html", "/boards/escape/", "/boards/jsonout/",
		"/boards/jsonout", "/boards/linked/", "/boards/untimed/", "/boards/..%2Falpha/"];
	for (const path of refused) {
		const reply = await s.get(path);
		assert.equal(reply.status, 404, path); assert.match(String(reply.headers["content-security-policy"]), /default-src 'self'/, path);
	}
	assert.equal((await s.get("/boards/alpha/", "evil.example")).status, 200, "same Host policy as the viewer: off by default");
	for (let i = 0; i < 2; i += 1) assert.deepEqual((await s.get("/api/sessions")).json.boards.map((b: { slug: string; title: string; created_at: string }) => [b.slug, b.title, b.created_at]), [["beta", "Beta report", "2026-09-03T00:00:00Z"], ["alpha", "Alpha report", "2026-09-01T00:00:00Z"]]);
	const skipped = s.viewer.output().split("\n").filter((line) => /skipped: .* resolves outside/.test(line));
	assert.deepEqual(skipped.map((line) => line.replace(/^.*board (\S+) skipped: (\S+) resolves outside.*$/, "$1 $2")).sort(), ["escape site/", "jsonout board.json"], "one line per skipped board across every request");
	writeFileSync(join(s.make("a".repeat(63) + "9", { title: "Longest slug", created_at: "2026-09-02T00:00:00Z" }), "index.html"), "long");
	assert.equal((await s.get(`/boards/${"a".repeat(63)}9/`)).status, 200, "64 characters is the longest slug");
});

test("P22-reports-screen: Reports lists each board's link, description and job, with no copy box, or says none yet", async (t) => {
	const s = await boardsRig(t);
	const tab = await s.viewer.open("#reports");
	const grid = await tab.find(".reports-grid");
	const html = grid.outerHTML;
	assert.match(html, /^<div class="reports-grid"><article class="job-row"/, "cards sit in the grid container desktop lays out");
	assert.match(html, /href="\/boards\/alpha\/"/); assert.match(html, /href="\/boards\/alpha\/"[^>]*target="_blank"|target="_blank"[^>]*href="\/boards\/alpha\/"/);
	assert.match(html, /the first/);
	assert.match(html, /href="#job\/cp-1"/);
	assert.doesNotMatch(html, /overview-reply|<code[^>]*>[^<]*\/boards\/alpha\/<\/code>|Copy/, "no copy-URL box: the title already links");
	assert.doesNotMatch(html, /<script|style=|onclick=/i);
	const empty = createScratchHome();
	t.after(() => empty.cleanup());
	const bare = await startViewer(t, { home: empty.path });
	assert.match(await (await bare.open("#reports")).waitText(/No published reports yet/), /No published reports yet/);
});

/** Five closed jobs (one failed, one with no created_at, one the day before), their runs, a mandate and decisions. */
function seedStats(home: string) {
	const put = (file: string, value: unknown) => { const path = join(home, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
	const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const usage = (cost: number, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cache_read: cacheRead, cache_write: cacheWrite, total_tokens: input + output + cacheRead + cacheWrite, cost_usd: cost });
	const ids = ["cp-m", "cp-c", "cp-f", "cp-nocreated", "cp-prior"];
	const created: Record<string, string | undefined> = { "cp-m": T("09:00"), "cp-c": T("10:00"), "cp-f": T("08:00"), "cp-nocreated": undefined, "cp-prior": T("05:00", "2026-10-07") };
	const closedAt: Record<string, string> = { "cp-m": T("10:00"), "cp-c": T("11:00"), "cp-f": T("10:30"), "cp-nocreated": T("10:30"), "cp-prior": T("06:00", "2026-10-07") };
	put(".pi-command-post/jobs.json", { jobs: ids.map((id) => ({ id, title: id, status: "closed", labels: ["project:demo", "kind:ship"], ...(created[id] ? { created_at: created[id] } : {}), closed_at: closedAt[id] })) });
	put(LAYOUT.fleetFile, { jobs: ids.map((id) => ({ job_id: id, project: "demo", kind: "ship", phase: id === "cp-f" ? "failed" : "done", dispatched_at: closedAt[id], closed_at: closedAt[id], ...(id === "cp-m" ? { mandate_id: "md-a" } : {}), ...(id === "cp-f" ? { failure: { class: "x", message: "boom", at: closedAt[id] } } : {}) })) });
	put(join(LAYOUT.runs, "cp-m/merge.json"), { job_id: "cp-m", merged_at: T("10:00"), pr_url: "https://github.com/o/r/pull/1", merge_commit_sha: "c".repeat(40) });
	const status = (id: string, model: string, u: unknown) => put(join(LAYOUT.runs, id, "status.json"), { model, usage: u });
	status("cp-m", "prov/worker-model", usage(1.5, 100, 50, 10, 10));
	status("cp-c", "prov/worker-model", usage(2, 20, 10));
	status("cp-f", "prov/worker-model", usage(9, 900, 900));
	status("cp-nocreated", "prov/other", usage(1, 5, 5));
	status("cp-prior", "prov/worker-model", usage(1, 1, 1));
	put(join(LAYOUT.runs, "cp-m/gate-1/status.json"), { model: "x/rev", usage: usage(0.5, 10, 5), started_at: T("09:52"), exited_at: T("09:55") });
	put(join(LAYOUT.runs, "cp-m/events.jsonl"), lines([
		{ source: "cp", ts: T("09:10"), type: "spawned", payload: {} },
		{ source: "pi", ts: T("09:30"), type: "message_end", payload: { message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 10 } } } },
		{ source: "cp", ts: T("09:50"), type: "envelope_received", payload: {} },
		{ source: "cp", ts: T("09:51"), type: "ci_observed", payload: { event: "ci_failed" } },
		{ source: "cp", ts: T("09:55"), type: "ci_observed", payload: { event: "ci_green" } },
	]));
	put(join(LAYOUT.runs, "cp-c/events.jsonl"), lines([
		{ source: "cp", ts: T("10:05"), type: "spawned", payload: {} },
		{ source: "cp", ts: T("10:20"), type: "ci_observed", payload: { event: "ci_green" } },
		{ source: "cp", ts: T("10:50"), type: "process_exit", payload: {} },
	]));
	put(join(LAYOUT.mandates, "md-a.json"), { id: "md-a", status: "active", issued_at: T("00:00", "2026-10-01"), expiry: "2099-01-01T00:00:00Z", projects: ["demo"], objective: "Goal A", job_ids: ["cp-m"], spend_cap: { usd: 20, tokens: 1000 } });
	const answered = (id: string, answered_at: string, rule?: string) => ({ id, status: "answered", question: `Q ${id}`, created_at: T("07:00"), answered_at, answer: "yes", answered_by: "operator-delegated", job_ids: ["cp-m"], options: [{ id: "yes", label: "Yes" }], ...(rule ? { delegation_rule: rule } : {}) });
	put(LAYOUT.escalationsFile, { items: [answered("es-a", T("08:00")), answered("es-b", T("08:30"), "standing order"), answered("es-old", T("08:00", "2026-09-01"))] });
	put(join(LAYOUT.state, "operator/asks.jsonl"), [
		{ type: "open", id: "ask-ab", project: "demo", created_at: T("07:00"), question: "Q?", options: [{ label: "Keep", consequence: "x" }], recommendation: "Keep" },
		{ type: "answer", id: "ask-ab", answer: "Keep", answered_at: T("09:00") },
	].map((e) => JSON.stringify(e)).join("\n") + "\n");
	return { put };
}

async function statsRig(t: TestContext, seed: (home: string, put: (file: string, value: unknown) => void) => void = () => {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const { put } = seedStats(scratch.path);
	seed(scratch.path, put);
	const viewer = await startViewer(t, { home: scratch.path, at: NOW, env: { TZ: "UTC" } });
	const stats = async (query = "range=24h") => {
		const reply = await get(viewer.port, `/api/stats?${query}`);
		assert.equal(reply.status, 200, reply.body.toString());
		return reply.json;
	};
	return { home: scratch.path, viewer, put, stats };
}

test("P22-stats-api: jobs, spend, tokens, phases, decisions and mandates follow their definitions over a window", async (t) => {
	const s = await statsRig(t);
	const day = await s.stats();
	assert.equal(day.availability, "ok");
	assert.deepEqual([day.jobs_finished.merged, day.jobs_finished.closed], [1, 2], "failed cp-f is in neither; cp-prior is outside the window");
	assert.equal(day.kpis.merge_rate, 1 / 3);
	assert.equal(day.kpis.median_wall_clock_seconds, 3600, "finish - ledger created_at; cp-nocreated has no created_at and is skipped");
	assert.equal(day.kpis.median_queue_wait_seconds, 450, "median of 600s (cp-m) and 300s (cp-c)");
	assert.equal(day.kpis.ci_green_first_try, 0.5, "cp-m failed first; cp-c green first; cp-nocreated has no CI event");
	assert.deepEqual(day.phases, { queued_seconds: 450, working_seconds: 2550, held_seconds: 420, review_seconds: 180 });
	assert.deepEqual([day.range.key, day.range.bucket_seconds, day.jobs_finished.buckets.length], ["24h", 3600, 25], "hour-aligned, the current hour included");
	const bucket = (iso: string) => day.jobs_finished.buckets.find((b: { start: string }) => b.start === iso);
	assert.deepEqual([bucket("2026-10-08T10:00:00.000Z").merged, bucket("2026-10-08T10:00:00.000Z").closed, bucket("2026-10-08T11:00:00.000Z").merged, bucket("2026-10-08T11:00:00.000Z").closed], [1, 1, 0, 1]);
	assert.equal(day.kpis.spend_usd, 5, "cp-m 1.5+0.5, cp-c 2, cp-nocreated 1");
	assert.deepEqual(day.spend_by_model, [{ model: "worker-model", usd: 3.5 }, { model: "other", usd: 1 }, { model: "rev", usd: 0.5 }]);
	assert.deepEqual([day.kpis.tokens_input, day.kpis.tokens_output, day.kpis.tokens], [135, 70, 205]);
	const row = day.mandates.find((m: { id: string }) => m.id === "md-a");
	assert.deepEqual([row.tokens, row.jobs, row.spend_usd, row.spend_cap_usd, row.token_cap, row.status, row.objective, row.time_left_seconds > 0], [175, 1, 2, 20, 1000, "active", "Goal A", true], "(total - cache_read) worker + reviewer");
	assert.deepEqual(day.mandates[1], { id: "unassigned", objective: "No covering live grant", status: null, jobs: 2, spend_usd: null, spend_cap_usd: null, tokens: null, token_cap: null, time_left_seconds: null });
	assert.ok(day.warnings.some((w: { message: string }) => /hourly token series sums 150/.test(w.message)), "event sum vs status totals gap is named"); assert.ok(!day.warnings.some((w: { message: string }) => /exceed|not read/.test(w.message)), "no run log is over a bound");
	const hour = day.tokens_by_model.buckets.find((b: { start: string }) => b.start === "2026-10-08T09:00:00.000Z");
	assert.deepEqual([hour.tokens, day.tokens_by_model.models, day.tokens_by_model.buckets.filter((b: { tokens: object }) => Object.keys(b.tokens).length).length], [{ "worker-model": 150 }, ["worker-model"], 1]);
	assert.deepEqual([day.decisions, day.kpis.decisions], [{ for_you: 2, by_you: 1, worth: 1 }, 3]);
	assert.deepEqual((await s.stats("range=24h&project=other")).decisions, { for_you: 0, by_you: 0, worth: 0 });
	assert.equal(day.kpis.spend_delta_pct, 400, "5 now vs 1 (cp-prior) in the 24h before");
	assert.equal((await s.stats("range=7d")).kpis.spend_delta_pct, null, "a prior of 0 is null, not 0% or Infinity");
	const none = await s.stats("range=custom&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z");
	assert.deepEqual([none.jobs_finished.merged, none.jobs_finished.closed, none.kpis.spend_usd, none.kpis.merge_rate, none.kpis.median_wall_clock_seconds, none.kpis.median_queue_wait_seconds, none.kpis.ci_green_first_try, none.kpis.tokens, none.mandates], [0, 0, null, null, null, null, null, null, []]);
	assert.deepEqual(none.phases, { queued_seconds: null, working_seconds: null, held_seconds: null, review_seconds: null });
});

test("P22-stats-http: /api/stats refuses a bad query with 400 and only GET; it and its stream write nothing", async (t) => {
	const s = await statsRig(t);
	const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== "clock-offset-ms").map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);
	const before = snapshot(join(s.home, ".pi-command-post"));
	const refused = async (query: string) => { const reply = await get(s.viewer.port, `/api/stats?${query}`); assert.equal(reply.status, 400, query); return reply.json.error as string; };
	assert.equal(await refused("range=custom&from=2026-08-31T00:00:00Z&to=2026-10-02T00:00:00Z"), "custom range is limited to 31 days");
	assert.equal((await s.stats("range=custom&from=2026-09-01T00:00:00Z&to=2026-10-02T00:00:00Z")).range.key, "custom", "exactly 31 days");
	assert.equal(await refused("range=custom&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z"), "from must be before to");
	for (const query of ["range=custom&from=2026-10-01", "range=custom", "range=30d", "range=bogus", "project=../x", "mandate=nope", "tz=Mars/Base"]) await refused(query);
	const blank = await s.stats("range=7d&project=&mandate=");
	assert.deepEqual([blank.range.key, blank.filters.project, blank.filters.mandate, blank.range.tz], ["7d", null, null, "UTC"]);
	assert.equal(Date.parse(blank.range.to) - Date.parse(blank.range.from), 7 * 86_400_000);
	assert.equal((await get(s.viewer.port, "/api/stats", { method: "POST" })).status, 405);
	const stream = await new Promise<number>((resolve) => { const req = request({ host: "127.0.0.1", port: s.viewer.port, path: "/api/stream?view=stats" }, (res) => { resolve(res.statusCode ?? 0); req.destroy(); }); req.on("error", () => {}); req.end(); });
	assert.equal(stream, 200);
	assert.deepEqual(snapshot(join(s.home, ".pi-command-post")), before);
});

test("P22-stats-zones: day buckets follow the requested IANA zone across 23 h and 25 h days; none sent is UTC", async (t) => {
	const s = await statsRig(t);
	const days = async (from: string, to: string, tz?: string) => (await s.stats(`range=custom&from=${from}&to=${to}${tz ? `&tz=${tz}` : ""}`)).jobs_finished.buckets as Array<{ start: string; end: string }>;
	const hours = (buckets: Array<{ start: string; end: string }>) => buckets.map((b) => (Date.parse(b.end) - Date.parse(b.start)) / 3_600_000);
	const spring = await days("2026-03-22T12:00:00Z", "2026-03-31T12:00:00Z", "Europe/Berlin");
	assert.deepEqual(spring.slice(5).map((b) => b.start), ["2026-03-26T23:00:00.000Z", "2026-03-27T23:00:00.000Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", "2026-03-30T22:00:00.000Z"]);
	assert.deepEqual(hours(spring).slice(5), [24, 24, 23, 24, 24], "spring forward: Mar 29 is 23h");
	assert.deepEqual(hours(await days("2026-10-20T12:00:00Z", "2026-10-26T12:00:00Z", "Europe/Berlin")).slice(4), [24, 25, 24], "fall back: Oct 25 is 25h");
	assert.equal((await days("2026-10-03T05:00:00Z", "2026-10-09T05:00:00Z", "America/Los_Angeles"))[0]!.start, "2026-10-02T07:00:00.000Z");
	assert.deepEqual((await days("2026-10-03T05:00:00Z", "2026-10-10T05:00:00Z")).slice(5).map((b) => b.start), ["2026-10-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"]);
	assert.equal((await s.stats("range=7d")).range.tz, "UTC");
	const berlin = await s.stats("range=7d&tz=Europe/Berlin");
	assert.equal(berlin.range.tz, "Europe/Berlin");
	assert.ok(berlin.jobs_finished.buckets.every((b: { start: string }) => /T(22|23):00:00\.000Z$/.test(b.start)), "buckets start at Berlin midnight");
	assert.equal(berlin.jobs_finished.merged, 1, "same jobs, different bucket edges");
});

test("P22-stats-sources: reviewer runs count, ancient jobs change nothing, and an unreadable or missing source is null", async (t) => {
	const u = (cost: number) => ({ cost_usd: cost, input: 1, output: 1, total_tokens: 2 });
	const s = await statsRig(t, (_home, put) => {
		for (const [dir, cost] of [["gate-2", 0.25], ["review-1", 0.5], ["quality-completeness", 1]] as const) put(join(LAYOUT.runs, "cp-c", dir, "status.json"), { model: "x/rev", usage: u(cost) });
		put(join(LAYOUT.runs, "cp-c", "notes-1", "status.json"), { model: "x/rev", usage: u(100) });
	});
	const day = await s.stats();
	assert.deepEqual([day.kpis.spend_usd, day.kpis.tokens, day.spend_by_model.find((m: { model: string }) => m.model === "rev").usd], [6.75, 211, 2.25], "gate-, review- and quality- count; notes-1 is ignored");
	const figures = (body: Record<string, unknown>) => JSON.stringify({ ...body, generated_at: 0, range: 0, mandates: (body.mandates as object[]).map((m) => ({ ...m, time_left_seconds: 0 })) });
	const before = figures(day);
	const ledger = JSON.parse(readFileSync(join(s.home, ".pi-command-post/jobs.json"), "utf8"));
	ledger.jobs.push({ id: "cp-ancient", title: "old", status: "closed", labels: ["project:demo"], created_at: "2025-01-01T00:00:00Z", closed_at: "2025-01-02T00:00:00Z" });
	s.put(".pi-command-post/jobs.json", ledger);
	const fleet = JSON.parse(readFileSync(join(s.home, LAYOUT.fleetFile), "utf8"));
	fleet.jobs.push({ job_id: "cp-ancient", project: "demo", phase: "done", closed_at: "2025-01-02T00:00:00Z" });
	s.put(LAYOUT.fleetFile, fleet);
	s.put(join(LAYOUT.runs, "cp-ancient/status.json"), { model: "x/y", usage: { cost_usd: 999, input: 9, output: 9, total_tokens: 18 } });
	assert.equal(figures(await s.stats()), before, "a job finished long before the window changes no figure");
	s.put(".pi-command-post/jobs.json", "{not json");
	const torn = await s.stats();
	assert.deepEqual([torn.availability, torn.jobs_finished.merged, torn.jobs_finished.buckets], ["unavailable", null, []]);
	assert.ok(torn.warnings.some((w: { message: string }) => /unreadable/.test(w.message)));
	const empty = createScratchHome();
	t.after(() => empty.cleanup());
	const bare = await startViewer(t, { home: empty.path, at: NOW });
	const missing = (await get(bare.port, "/api/stats")).json;
	assert.deepEqual([missing.availability, missing.kpis.spend_usd, missing.parent], ["missing", null, null], "no source is unknown, not zero");
	assert.equal((await (await bare.open("#stats")).find(".stats-parent .stats-none")).textContent, "-", "no parent session is a dash");
});

test("P22-stats-bounds: an over-size or over-budget run log is left out of log figures and named; status figures stay", async (t) => {
	const MiB = 1024 * 1024;
	const big = await statsRig(t, (home) => { for (const id of ["cp-m", "cp-c"]) truncateSync(join(home, LAYOUT.runs, id, "events.jsonl"), 17 * MiB); });
	const small = await big.stats();
	assert.ok(small.warnings.some((w: { message: string }) => /2 run log\(s\) exceed 16 MiB/.test(w.message)), "cp-m and cp-c logs are over the per-file bound");
	assert.deepEqual([small.phases.queued_seconds, small.kpis.ci_green_first_try, small.tokens_by_model.models], [null, null, []]); assert.equal(small.jobs_finished.closed, 2);
	const extra = Array.from({ length: 9 }, (_, i) => `cp-x${i}`);
	const wide = await statsRig(t, (home, put) => {
		const ledger = JSON.parse(readFileSync(join(home, ".pi-command-post/jobs.json"), "utf8"));
		const fleet = JSON.parse(readFileSync(join(home, LAYOUT.fleetFile), "utf8"));
		for (const id of extra) {
			ledger.jobs.push({ id, title: id, status: "closed", labels: ["project:demo", "kind:ship"], closed_at: T("11:30") });
			fleet.jobs.push({ job_id: id, project: "demo", kind: "ship", phase: "done", closed_at: T("11:30") });
			put(join(LAYOUT.runs, id, "events.jsonl"), "");
			truncateSync(join(home, LAYOUT.runs, id, "events.jsonl"), 15 * MiB); // sparse: no disk, a real size
		}
		put(".pi-command-post/jobs.json", ledger);
		put(LAYOUT.fleetFile, fleet);
	});
	const tight = await wide.stats();
	assert.ok(tight.warnings.some((w: { message: string }) => /not read \(128 MiB scan budget\)/.test(w.message)));
	for (const day of [small, tight]) assert.deepEqual([day.kpis.spend_usd, day.kpis.tokens, day.kpis.median_wall_clock_seconds, day.jobs_finished.merged], [5, 205, 3600, 1]);
});

test("P22-stats-parent: the Parent panel reads the live parent file and its archives; every wake type and a stale wake count", async (t) => {
	const msg = (ts: string, role: string, content: unknown, cost?: number) => ({ type: "message", timestamp: ts, message: { role, content, ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }) } });
	const wake = (ts: string, customType: string, content: string) => ({ type: "custom_message", timestamp: ts, customType, content, display: true });
	const tool = [{ type: "toolCall", id: "c1", name: "cp_next", arguments: {} }], think = [{ type: "thinking", thinking: "nothing to do" }];
	const at = (hms: string, day = "2026-10-08") => `${day}T${hms}Z`;
	const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
	const s = await statsRig(t, (home, put) => {
		// Five answered turns: acted, text-only, a repeated cp-ci, a stale wake that called a tool, a thinking-only nudge.
		put(join(LAYOUT.sessions, "cp-parent.jsonl"), jsonl([
			msg(at("10:00:00"), "user", "status?"), msg(at("10:00:30"), "assistant", tool, 1), msg(at("10:00:31"), "toolResult", "ok"),
			wake(at("10:10:00"), WAKEUP_CUSTOM_TYPES.ci, "CI green for cp-x"), msg(at("10:11:00"), "assistant", [{ type: "text", text: "noted" }], 0.5),
			wake(at("10:20:00"), WAKEUP_CUSTOM_TYPES.ci, "CI green for cp-x"), msg(at("10:20:10"), "assistant", tool, 0.25),
			wake(at("10:30:00"), WAKEUP_CUSTOM_TYPES.verdict, `${STALE_WAKEUP_HEADLINE}\nold verdict`), msg(at("10:30:05"), "assistant", tool, 0.25),
			wake(at("10:40:00"), "cp-wakeup-nudge", "1 fleet notice(s) arrived"), msg(at("10:40:20"), "assistant", think, 0.5),
			wake(at("11:00:00"), WAKEUP_CUSTOM_TYPES.ci, "CI red for cp-y"),
		]));
		put(join(LAYOUT.sessions, "cp-parent-1760000000000-abcdef12.jsonl"), jsonl([msg(at("09:00:00", "2026-09-18"), "user", "old"), msg(at("09:01:40", "2026-09-18"), "assistant", tool, 1)]));
		put(join(LAYOUT.sessions, "2026-10-08T00-00-00_worker.jsonl"), jsonl([msg(at("10:00:00"), "user", "brief"), msg(at("10:00:01"), "assistant", think, 50)]));
		utimesSync(join(home, LAYOUT.sessions, "cp-parent-1760000000000-abcdef12.jsonl"), new Date(at("09:02:00", "2026-09-18")), new Date(at("09:02:00", "2026-09-18")));
		utimesSync(join(home, LAYOUT.sessions, "cp-parent.jsonl"), new Date(at("11:00:00")), new Date(at("11:00:00")));
	});
	assert.deepEqual((await s.stats()).parent, [
		{ days: 7, turns: 5, wasted_turns: 3, reply_p50_seconds: 20, reply_p90_seconds: 60, spend_usd: 2.5, wasted_usd: 1 },
		{ days: 30, turns: 6, wasted_turns: 3, reply_p50_seconds: 20, reply_p90_seconds: 100, spend_usd: 3.5, wasted_usd: 1 },
	]);
	const repeated = Object.values(WAKEUP_CUSTOM_TYPES).map((type, i) => [wake(at(`0${i % 10}:00:00`), type, "the same fact"), msg(at(`0${i % 10}:00:05`), "assistant", tool, 1), wake(at(`0${i % 10}:30:00`), type, "the same fact"), msg(at(`0${i % 10}:30:05`), "assistant", tool, 1)]);
	for (const [i, records] of repeated.entries()) {
		const one = await statsRig(t, (_home, put) => put(join(LAYOUT.sessions, "cp-parent.jsonl"), jsonl(records)));
		assert.equal((await one.stats()).parent[0].wasted_turns, 1, `a repeated ${Object.values(WAKEUP_CUSTOM_TYPES)[i]} wake is wasted`);
	}
});

/** The seeded stats home plus a parent session and a mandate objective that a spreadsheet would run as a formula. */
async function statsScreen(t: TestContext) {
	const turn = (ts: string, reply: string, cost: number, content: unknown) => [
		{ type: "message", timestamp: ts, message: { role: "user", content: "status?" } },
		{ type: "message", timestamp: reply, message: { role: "assistant", content, usage: { cost: { total: cost } } } },
	];
	return statsRig(t, (home, put) => {
		const md = JSON.parse(readFileSync(join(home, LAYOUT.mandates, "md-a.json"), "utf8"));
		put(join(LAYOUT.mandates, "md-a.json"), { ...md, objective: '=Ship, "it"' });
		const records = [...turn("2026-10-08T10:00:00Z", "2026-10-08T10:00:42Z", 1.5, [{ type: "toolCall", id: "c", name: "cp_next", arguments: {} }]), ...turn("2026-10-08T10:10:00Z", "2026-10-08T10:12:30Z", 0.5, [{ type: "thinking", thinking: "idle" }]), ...turn("2026-10-08T10:20:00Z", "2026-10-08T10:20:42Z", 0, [{ type: "toolCall", id: "d", name: "cp_next", arguments: {} }]), ...turn("2026-10-08T10:30:00Z", "2026-10-08T10:30:42Z", 0, [{ type: "toolCall", id: "e", name: "cp_next", arguments: {} }])];
		put(join(LAYOUT.sessions, "cp-parent.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	});
}

test("P22-stats-screen: Stats shows six KPIs, four tables, the Parent panel, CSV export and token-only styles", async (t) => {
	const s = await statsScreen(t);
	const tab = await s.viewer.open("#stats?range=24h");
	await until(() => tab.$$(".stats-kpi").length, (n) => n === 6, "six KPIs");
	const html = tab.root.innerHTML;
	assert.deepEqual(tab.$$(".stats-kpi h2").map((h) => h.textContent), ["Jobs finished", "Spend", "Tokens", "Merge rate", "Median wall clock", "Decisions"]);
	assert.match(tab.text(), /CI green first try 50%/, "CI first try is the Merge rate subline");
	assert.match(tab.text(), /Held is normal: waiting on CI or review/);
	assert.match(html, /<code>Unassigned<\/code>/);
	assert.match(tab.text(), /No covering live grant/);
	assert.equal(tab.$$('button[aria-pressed="false"]').filter((b) => b.textContent === "Table").length, 4);
	assert.match(tab.text(), /Spend includes reviewers/);
	assert.doesNotMatch(tab.text(), /Nothing finished|sample|NaN|Infinity/i);
	assert.doesNotMatch(html, /type="datetime-local"|style=|amber|coral|="#[\da-f]{3,8}"/i);
	const cells = (days: number, page = tab) => {
		const block = page.$$(".stats-parent h3").find((h) => h.textContent === `${days} days`)!.nextElementSibling!;
		return [...block.querySelectorAll("dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling!.textContent}`);
	};
	assert.deepEqual(cells(7), ["Turns=4", "Reply p50=42s", "Reply p90=2m 30s", "Wasted turns=25% · 1 of 4", "Wasted $=25% · $0.50 of $2.00"]);
	assert.deepEqual(cells(30), cells(7), "every turn is inside both windows");
	assert.match(tab.$(".stats-parent h2")!.getAttribute("title")!, /Wasted turns = wasted \/ all answered turns; wasted \$ = recorded cost of wasted turns \/ recorded cost of all turns/);
	// Two turns 18 days ago, answered after 600 s and 4000 s: the 7-day window has none, so every figure is a dash.
	const slow = await statsRig(t, (_home, put) => put(join(LAYOUT.sessions, "cp-parent.jsonl"), [["10:00:00", "10:10:00"], ["11:00:00", "12:06:40"]]
		.flatMap(([asked, replied]) => [{ type: "message", timestamp: `2026-09-20T${asked}Z`, message: { role: "user", content: "status?" } },
			{ type: "message", timestamp: `2026-09-20T${replied}Z`, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "cp_next", arguments: {} }], usage: { cost: { total: 1 } } } }])
		.map((r) => JSON.stringify(r)).join("\n") + "\n"));
	const late = await slow.viewer.open("#stats?range=24h");
	await until(() => late.$$(".stats-parent h3").length, (n) => n === 2, "the Parent panel");
	assert.deepEqual(cells(7, late), ["Turns=0", "Reply p50=-", "Reply p90=-", "Wasted turns=-", "Wasted $=-"], "no turns is a dash, never 0%");
	assert.deepEqual(cells(30, late).slice(0, 3), ["Turns=2", "Reply p50=10m", "Reply p90=1h 6m"], "10 minutes and over drop the seconds");
	let csv = "";
	(tab.globals.URL as { createObjectURL: unknown }).createObjectURL = (blob: Blob) => { void blob.text().then((text) => { csv = text; }); return "blob:stats"; };
	(tab.globals.URL as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
	tab.click(tab.$$("button").find((b) => b.textContent === "Export CSV")!);
	const lines = (await until(() => csv, Boolean, "the exported CSV")).split("\n");
	assert.equal(lines[0], "mandate,objective,status,jobs,spend_usd,spend_cap_usd,tokens,token_cap,time_left_seconds");
	assert.match(lines[1]!, /^md-a,"'=Ship, ""it""",active,1,2,20,175,1000,\d+$/, "a formula start is quoted and prefixed");
	assert.equal(lines[2], "unassigned,No covering live grant,,2,,,,,", "missing values are empty, not 0");
	const page = await get(s.viewer.port, "/");
	const css = (await get(s.viewer.port, /<link rel="stylesheet" href="([^"]+)"/.exec(page.body.toString())![1]!)).body.toString();
	const stats = css.slice(css.indexOf(".stats-"));
	for (const token of ["blue", "green", "muted", "dim"]) assert.match(stats, new RegExp(`\\.stats-fill-${token}\\s*\\{\\s*fill:\\s*var\\(--${token}\\)`));
	assert.doesNotMatch(stats.slice(0, stats.lastIndexOf(".stats-") + 400), /font-family|--amber|--coral|#[\da-f]{3,8}\b/i, "charts paint with tokens only");
});

test("P22-stats-filters: filters rewrite only the hash, the zone goes to the API, Custom shows From/To, and unknown is a dash", async (t) => {
	const s = await statsScreen(t);
	const was = process.env.TZ;
	process.env.TZ = "Asia/Ho_Chi_Minh";
	t.after(() => { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; });
	const tab = await s.viewer.open("#stats?range=24h");
	await until(() => tab.$$(".stats-kpi").length, (n) => n === 6, "six KPIs");
	const zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone!);
	assert.ok(tab.requests.some((r) => r.path === `/api/stats?range=24h&tz=${zone}`), "the browser zone rides on the API query");
	assert.match(tab.$(".stats-caption")!.textContent!, /^Oct 7, 19:0\d – Oct 8, 19:0\d · compared with the 24h before$/, "browser-local, no zone suffix");
	tab.click(tab.$$(".stats-segments button").find((b) => b.textContent === "7d")!);
	assert.equal(tab.window.location.hash, "#stats?range=7d");
	const select = tab.$(".stats-pill select")!;
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === "demo");
	select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
	assert.equal(tab.window.location.hash, "#stats?range=24h&project=demo", "the hash keeps the mounted filters and never a tz");
	tab.go("#stats?range=7d&tz=UTC");
	assert.ok((await until(() => tab.requests.map((r) => r.path), (paths) => paths.includes("/api/stats?range=7d&tz=UTC"), "an explicit tz kept")).length);
	tab.go("#stats?range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z");
	assert.match(await tab.waitText(/Nothing finished in this range/), /Nothing finished in this range/);
	assert.equal(tab.$$('input[type="datetime-local"]').length, 2);
	assert.match(tab.$(".stats-caption")!.textContent!, /^Jan 1, 07:00 – Jan 2, 07:00 · compared with/);
	assert.equal(tab.$$(".stats-kpi strong")[0]!.textContent, "0", "nothing finished is a known zero");
	assert.equal(tab.$$(".stats-kpi strong")[1]!.textContent, "-", "missing spend is a dash, never 0");
	s.put(".pi-command-post/jobs.json", "{not json");
	tab.go("#stats?range=24h");
	assert.equal(await until(() => tab.$$(".stats-kpi strong")[0]?.textContent, (v) => v === "-", "the dash"), "-", "Jobs finished is a dash on an unreadable ledger");
});

test("P22-stats-flow: a refused Custom range is corrected in place, and an older answer never overwrites a newer one", async (t) => {
	const s = await statsScreen(t);
	const tab = await s.viewer.open("#stats?range=custom");
	const alert = () => tab.$(".overview-error")?.textContent ?? "";
	assert.match(await until(alert, (text) => /refused \(400\)/.test(text), "the refusal"), /^This range was refused \(400\): Custom needs From before To/);
	assert.equal(tab.$$(".stats-kpi").length, 0);
	const from = tab.$(".stats-from input")!, to = tab.$(".stats-to input")!;
	assert.ok(tab.$(".stats-pill select") && tab.$(".stats-segments"), "controls remain beside the error");
	let focused: unknown = null;
	tab.window.HTMLElement.prototype.focus = function (this: unknown) { focused = this; };
	(from as unknown as { focus(): void }).focus();
	tab.go("#stats?range=custom&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T12%3A00%3A00.000Z");
	await until(() => tab.$$(".stats-kpi").length, (n) => n === 6, "data for the corrected range");
	assert.equal(alert(), "");
	const spend = () => tab.$$(".stats-kpi").find((k) => k.querySelector("h2")?.textContent === "Spend")?.querySelector("strong")?.textContent;
	assert.equal(spend(), "$6.00");
	assert.ok(tab.$(".stats-from input") === from && tab.$(".stats-to input") === to && focused === from, "same inputs, focus kept");
	const real = tab.globals.fetch as (input: string, init?: RequestInit) => Promise<Response>;
	let letOld = () => {};
	const old = new Promise<void>((go) => (letOld = go));
	let oldAsked = false, oldSettled = false;
	tab.globals.fetch = async (input: string, init?: RequestInit) => {
		if (!String(input).includes("to=2026-10-08T10%3A15")) return real(input, init);
		oldAsked = true;
		await old;
		return real(input, init).finally(() => { oldSettled = true; });
	};
	tab.go("#stats?range=custom&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T10%3A15%3A00.000Z");
	await until(() => oldAsked, Boolean, "the older query asked");
	tab.go("#stats?range=custom&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T10%3A45%3A00.000Z");
	await until(spend, (v) => v === "$4.00", "the newer query's spend");
	letOld();
	await until(() => oldSettled, Boolean, "the older answer");
	await new Promise((done) => setImmediate(done));
	assert.equal(spend(), "$4.00", "the older query's $3.00 never lands");
	assert.ok(tab.$(".stats-from input") === from, "the From input is the same element, never remounted");
});
