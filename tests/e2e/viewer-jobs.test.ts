/**
 * Behavior 18 (P18): the dashboard's Jobs, Board and Job detail data through `bin/cp-view` on a scratch home, over real
 * HTTP. Rendered-UI scenarios wait for #555's tests/harness/dashboard.ts rather than a second linkedom harness.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type TestContext, test } from "node:test";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import type { BoardResponse, JobResponse, JobsResponse, JobTranscriptResponse, OverviewResponse } from "../../src/viewer/api-types.ts";
import { createScratchHome, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { json, MERGE, mergedCalls, run as ciRun, SKIP, startStack } from "./landing-helpers.ts";

process.env.TZ = "UTC";
const CLOCK = pathToFileURL(resolve(import.meta.dirname, "../harness/process-clock.ts")).href;
const HOUR = 3_600_000;
const http = globalThis.fetch.bind(globalThis);
/** The viewer's clock reads noon UTC today (tests/harness/process-clock.ts), so "today" never straddles midnight. */
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
/** ISO time `minutes` before the viewer's noon. */
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();

const freePort = (): Promise<number> => new Promise((done) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as { port: number };
		probe.close(() => done(port));
	});
});

/** A scratch home's files: `put` writes JSON (or a string) under the home; `run` names a run file. */
function seed(home: string) {
	const put = (file: string, value: unknown) => {
		const path = join(home, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, typeof value === "string" ? value : JSON.stringify(value));
		renameSync(`${path}.tmp`, path);
	};
	return {
		put,
		run: (id: string, file: string) => join(LAYOUT.runs, id, file),
		ledger: (jobs: object[]) => put(".pi-command-post/jobs.json", { jobs }),
		fleet: (jobs: object[]) => put(LAYOUT.fleetFile, { jobs }),
		grant: (id: string, status: string, extra: object = {}) => put(join(LAYOUT.mandates, `${id}.json`), {
			id, status, issued_at: iso(180), expiry: "2099-01-01T00:00:00Z", projects: ["demo"], objective: `${id} objective`, spend_cap: { usd: 20, tokens: 10000 }, ...extra,
		}),
		events: (id: string, list: object[]) => put(join(LAYOUT.runs, id, "events.jsonl"), list.map((e) => JSON.stringify({ source: "cp", job_id: id, ts: iso(30), ...e })).join("\n") + "\n"),
	};
}
type Seed = ReturnType<typeof seed>;

/**
 * `bin/cp-view` on a fresh scratch home seeded by `prepare`, its clock at NOON until `clock(ms)` moves it on;
 * given a path instead, it serves that live home on real time and leaves its cleanup to the owner.
 */
async function viewer(t: TestContext, prepare: ((s: Seed, home: string) => void) | string, env: Record<string, string> = {}) {
	const live = typeof prepare === "string";
	const home = live ? { path: prepare, cleanup: () => {} } : createScratchHome();
	const s = seed(home.path);
	if (!live) prepare(s, home.path);
	const clockFile = join(home.path, "clock-offset-ms");
	const clock = (ms = 0) => writeFileSync(clockFile, String(live ? ms : NOON + ms - Date.now()));
	clock();
	const port = await freePort();
	const view: ChildProcess = spawn(join(REPO_ROOT, "bin/cp-view"), ["--home", home.path, "--host", "127.0.0.1", "--port", String(port)], {
		env: { PATH: process.env.PATH ?? "", HOME: home.path, CP_HOME: home.path, TZ: "UTC", CP_TEST_CLOCK_FILE: clockFile, NODE_OPTIONS: `--import ${CLOCK}`, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	view.stdout!.on("data", (chunk) => (output += chunk));
	view.stderr!.on("data", (chunk) => (output += chunk));
	const exited = new Promise<void>((done) => view.once("exit", () => done()));
	t.after(async () => {
		if (view.exitCode === null) view.kill("SIGTERM");
		await exited;
		home.cleanup();
	});
	const base = `http://127.0.0.1:${port}`;
	for (const end = Date.now() + 60_000; ; await new Promise((done) => setTimeout(done, 100))) {
		if ((await http(`${base}/healthz`).then((r) => r.status, () => 0)) === 200) break;
		if (Date.now() > end) throw new Error(`cp-view never answered on ${port}\n${output}`);
	}
	const get = (path: string, init?: RequestInit) => http(`${base}${path}`, init);
	const json = async <T>(path: string): Promise<T> => {
		const reply = await get(path);
		assert.equal(reply.status, 200, `${path}: ${reply.status}`);
		return await reply.json() as T;
	};
	return { home: home.path, base, get, json, clock, ...s };
}

/** Every file under `dir`, as names and base64 bytes: the viewer must leave a home exactly as it found it. */
const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);
const pick = <T extends { id: string }>(rows: T[], id: string): T => {
	const row = rows.find((r) => r.id === id);
	assert.ok(row, `no row ${id} in ${rows.map((r) => r.id).join(",")}`);
	return row;
};

test("P18-jobs-api: /api/jobs, /api/job/<id>, its run log and /api/board join the ledger with observed phases and write nothing", { timeout: 120_000 }, async (t) => {
	const head = "a".repeat(40);
	let home = "";
	const v = await viewer(t, (s, dir) => {
		home = dir;
		const entries = ["queued", "working", "launching", "held", "done", "failed", "old"].map((id) => ({
			id: `cp-${id}`, title: `Title ${id}`, status: id === "done" || id === "old" ? "closed" : "open", labels: ["project:demo", "kind:ship"],
			blocked_by: id === "queued" ? ["cp-working"] : [], closed_at: id === "old" ? "2020-01-01T00:00:00Z" : iso(5),
		}));
		s.ledger(entries);
		s.fleet(entries.filter((j) => j.id !== "cp-queued").map((j) => ({
			job_id: j.id, project: "demo", kind: "ship", phase: j.id === "cp-working" || j.id === "cp-launching" ? "waiting" : j.id === "cp-old" ? "done" : j.id.slice(3),
			dispatched_at: iso(60), closed_at: j.id === "cp-old" ? "2020-01-01T00:00:00Z" : iso(5),
		})));
		s.put(s.run("cp-working", "status.json"), { phase: "working", started_at: iso(60) });
		s.put(s.run("cp-launching", "status.json"), { phase: "starting", started_at: iso(60) });
		s.put(join(LAYOUT.projects, "demo/report ?&.md"), "Recorded artifact");
		s.put(s.run("cp-held", "envelope.json"), { envelope: { head_sha: head, summary: `\n  ${"x".repeat(100)}\nsecond line`, artifact_path: join(dir, LAYOUT.projects, "demo/report ?&.md") } });
		s.put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-held", head_sha: head, last_ci: "red" }] });
		s.put(s.run("cp-held", "review-1.json"), { head_sha: "b".repeat(40), verdict: "pass", diff_stat: { truncated: false } });
		s.put(s.run("cp-held", "events.jsonl"), [
			{ source: "cp", job_id: "cp-held", ts: iso(30), type: "spawned", payload: { model: "test-model", secret: "not-for-the-api" } },
			{ source: "pi", ts: iso(29), type: "message_update", payload: { text: "private prompt" } },
		].map((e) => JSON.stringify(e)).join("\n") + "\n");
		s.grant("md-active", "active", { objective: "Active goal", job_ids: ["cp-working", "cp-held", "cp-queued", "cp-launching"] });
		s.grant("md-paused", "paused", { objective: "Paused goal", job_ids: ["cp-failed", "cp-done"] });
	});
	const before = snapshot(home);
	const data = await v.json<JobsResponse>("/api/jobs");
	assert.deepEqual(data.jobs.map((j) => [j.id, j.phase]).sort(), [["cp-done", "done"], ["cp-failed", "failed"], ["cp-held", "held"], ["cp-launching", "launching"], ["cp-old", "done"], ["cp-queued", "queued"], ["cp-working", "working"]]);
	assert.equal(pick(data.jobs, "cp-old").finished_today, false);
	assert.equal(pick(data.jobs, "cp-held").summary, `${"x".repeat(79)}…`, "first non-empty line, 80 chars");
	assert.equal(pick(data.jobs, "cp-working").summary, null);
	assert.equal(pick(data.jobs, "cp-held").review, null, "a review on another head is not this head's review");
	const detail = await v.json<JobResponse>("/api/job/cp-held");
	assert.equal(detail.job.ci, "red");
	assert.equal(detail.timeline[0]?.label, "Spawned");
	assert.doesNotMatch(JSON.stringify(detail), /not-for-the-api|private prompt/);
	assert.equal(detail.files_href, "/#files?root=project%3Ademo&path=");
	assert.equal(detail.artifact_href, "/#files?root=project%3Ademo&path=report+%3F%26.md");
	const log = await v.get("/api/job/cp-held/events");
	assert.equal(log.status, 200);
	assert.match(log.headers.get("content-type") ?? "", /text\/plain/);
	assert.match(await log.text(), /spawned/);
	assert.equal((await v.get("/api/job/cp-queued/events")).status, 404, "a job with no run has no run log");
	assert.equal((await v.get("/api/job/cp-queued")).status, 200, "a ledger-only job still has a detail page");
	for (const id of ["cp-missing", "%2e%2e%2fsecret", "%E0"]) assert.equal((await v.get(`/api/job/${id}`)).status, 404, id);
	const board = await v.json<BoardResponse>("/api/board");
	assert.deepEqual(board.columns.map((c) => c.key), ["queued", "launching", "working", "waiting", "held", "awaiting_merge", "done", "failed"]);
	assert.equal(board.lanes.find((l) => l.id === "md-paused")?.active, false);
	assert.equal(board.jobs.some((j) => j.id === "cp-old"), false, "an old landed job is not on the board");
	const stream = await v.get("/api/stream?view=jobs");
	assert.equal(stream.status, 200);
	await stream.body?.cancel();
	assert.deepEqual(snapshot(home), before, "the viewer wrote nothing under the home");
});

test("P18-job-facts: Job detail's facts — CI, review, failure, asks, receipts, skills, routing, reports, summary — read only what was recorded", { timeout: 120_000 }, async (t) => {
	const head = "c".repeat(40), sha = "e".repeat(40);
	const mr = "https://gitlab.com/group/sub/repo/-/merge_requests/7", open = "https://git.example.test/code/team/app/-/merge_requests/3";
	const routing = { scope: "S", risk: "low", provenance: { scope: "explicit", risk: "defaulted" }, rule: "fleet rule", reasons: ["fleet reason"] };
	const closed = ["cp-green", "cp-none", "cp-stale", "cp-gl", "cp-cred", "cp-http", "cp-pass", "cp-equiv", "cp-bare", "cp-events", "cp-fleet", "cp-partial", "cp-empty", "cp-report", "cp-long", "cp-fit"];
	const v = await viewer(t, (s, dir) => {
		s.ledger([
			...closed.map((id) => ({ id, title: id, status: "closed", closed_at: iso(5), labels: ["project:demo", "kind:ship"] })),
			...["cp-open", "cp-gh", "cp-skilled", "cp-plain", "cp-noreport"].map((id) => ({ id, title: id, status: "open", labels: ["project:demo", "kind:ship"] })),
			{ id: "cp-tone", title: "Tone", status: "in_progress", labels: ["project:demo"] },
		]);
		const done = (job_id: string, over: object = {}) => ({ job_id, project: "demo", kind: "ship", phase: "done", dispatched_at: iso(60), closed_at: iso(5), ...over });
		const held = (job_id: string, over: object = {}) => ({ job_id, project: "demo", kind: "ship", phase: "held", dispatched_at: iso(60), ...over });
		const receipt = (url: string) => [{ kind: "pr", status: "open", title: "MR", url }];
		s.fleet([
			{ job_id: "cp-a", project: "demo", phase: "failed", failure: { class: "wall_clock", message: "Wall clock limit", at: iso(60) } },
			...["cp-green", "cp-none", "cp-stale", "cp-pass", "cp-equiv", "cp-bare", "cp-long", "cp-fit"].map((id) => done(id)),
			done("cp-gl", { receipts: receipt(mr) }), held("cp-open", { receipts: receipt(open) }),
			held("cp-cred", { receipts: receipt("https://user:token@gitlab.com/g/r/-/merge_requests/1") }),
			held("cp-http", { receipts: receipt("http://gitlab.com/g/r/-/merge_requests/1") }), held("cp-gh", { receipts: receipt("https://github.com/acme/repo/pull/9") }),
			held("cp-skilled", { skills: [{ name: "tdd-x", dir: "/skills/tdd-x" }, { name: "lint-y", dir: "/skills/lint-y" }] }), held("cp-plain"),
			...["cp-events", "cp-fleet", "cp-partial", "cp-empty"].map((id) => done(id, { routing: id === "cp-empty" ? {} : id === "cp-partial" ? { risk: "high", provenance: { risk: "inferred" } } : routing })),
		]);
		// cp-a: two hours of wall clock up to its failure, real CI and review events, a torn last line, an escalation-backed ask.
		s.put(s.run("cp-a", "status.json"), { started_at: iso(180) });
		s.put(s.run("cp-a", "events.jsonl"), [
			{ source: "cp", ts: iso(60), type: "ci_observed", payload: { event: "ci_failed", reason: "Test failure" } },
			{ source: "cp", ts: iso(60), type: "review_decided", payload: { attempt: 5, verdict: "revise" } },
		].map((e) => JSON.stringify(e)).join("\n") + "\n{\"partial\":");
		s.put(LAYOUT.escalationsFile, { items: [{ id: "es-a", status: "open", question: "Continue?", created_at: iso(60), job_ids: ["cp-a"] }] });
		s.put(join(LAYOUT.state, "operator/asks.jsonl"), JSON.stringify({ type: "open", id: "ask-ab", project: "demo", created_at: iso(60), question: "Continue?", options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep", source_escalation: "es-a" }) + "\n");
		// CI facts after ci-watch pruned the row: green on this head, merged with no run, green on another head.
		for (const id of ["cp-green", "cp-none", "cp-stale", "cp-gl", "cp-pass", "cp-equiv", "cp-bare"]) s.put(s.run(id, "envelope.json"), { envelope: { head_sha: head } });
		const ci = (event: string, at = head) => ({ type: "ci_observed", payload: { event, head_sha: at } });
		s.events("cp-green", [ci("ci_green"), ci("pr_merged")]);
		s.events("cp-none", [ci("pr_merged")]);
		s.events("cp-stale", [ci("ci_green", "d".repeat(40))]);
		s.put(s.run("cp-gl", "merge.json"), { job_id: "cp-gl", pr_url: mr, merge_commit_sha: sha, head_sha: head, merged_at: iso(5), forge: { provider: "gitlab" } });
		s.put(s.run("cp-cred", "merge.json"), { job_id: "cp-cred", pr_url: "https://user:token@gitlab.com/g/r/-/merge_requests/1", merge_commit_sha: sha, merged_at: iso(5) });
		s.put(s.run("cp-pass", "review-1.json"), { head_sha: head, verdict: "pass", decided_at: iso(10), diff_stat: { truncated: false } });
		s.put(s.run("cp-equiv", `review-equivalent-${head}.json`), { head_sha: head, verdict: "pass", decided_at: iso(10), diff_stat: { truncated: false } });
		s.events("cp-tone", [{ type: "failure", payload: { reason: "Provider/model 503" } }, { type: "ci_observed", payload: { event: "ci_failed", reason: "Test failure" } }, { type: "ci_observed", payload: { event: "ci_green" } }]);
		const selected = { scope: "L", risk: "low", provenance: { scope: "inferred", risk: "explicit", secret: "private" }, rule: "latest rule", reasons: ["latest reason", 123], secret: "not-for-the-api" };
		s.put(s.run("cp-events", "events.jsonl"), [[iso(30), selected], [iso(90), routing]].map(([ts, payload]) => JSON.stringify({ source: "cp", job_id: "cp-events", ts, type: "routing_resolved", payload })).join("\n") + "\n");
		const board = (slug: string, job_ids: string[], created_at: string) => s.put(join(LAYOUT.state, "boards", slug, "board.json"), { title: slug, job_ids, created_at });
		for (const [slug, ids, at] of [["old", ["cp-report"], 500], ["new", ["cp-report"], 400], ["shared", ["cp-report", "cp-other"], 300], ["unrelated", ["cp-report-extra"], 200], ["unassigned", [], 100]] as const) {
			board(slug, [...ids], iso(at));
			mkdirSync(join(dir, LAYOUT.state, "boards", slug, "site"), { recursive: true });
		}
		s.put(s.run("cp-long", "envelope.json"), { envelope: { summary: `\n${"y".repeat(700)}\nsecond` } });
		s.put(s.run("cp-fit", "envelope.json"), { envelope: { summary: "z".repeat(600) } });
	});
	const job = async (id: string) => (await v.json<JobResponse>(`/api/job/${id}`)).job;
	const a = await v.json<JobResponse>("/api/job/cp-a");
	assert.deepEqual([a.job.finished_today, a.job.failure, a.job.elapsed_seconds], [true, "Wall clock limit", 7200]);
	assert.deepEqual(a.timeline.map((e) => [e.label, e.tone]), [["CI red", "red"], ["Review 5 · changes requested", "neutral"]], "the torn last line is skipped");
	assert.equal(a.asks[0]?.id, "ask-ab", "the escalation's ask joins the job");
	assert.deepEqual(a.questions, []);
	assert.equal((await v.get("/api/job/..%2Fbad/events")).status, 404);
	v.clock(10 * 60_000);
	assert.equal((await job("cp-a")).elapsed_seconds, 7200, "a failed job's clock stops at its failure");
	v.clock();
	assert.equal((await job("cp-green")).ci, "green");
	assert.equal((await job("cp-none")).ci, null, "no CI run recorded: still not run yet");
	assert.equal((await job("cp-stale")).ci, null, "a green run on another head is not this head's CI");
	const rows = (await v.json<JobsResponse>("/api/jobs")).jobs;
	const gl = pick(rows, "cp-gl");
	assert.deepEqual([gl.pr_url, gl.pr_status, gl.merge_sha, gl.head], [mr, "merged", sha, head]);
	assert.equal((await job("cp-gl")).pr_url, mr);
	assert.deepEqual([pick(rows, "cp-open").pr_url, pick(rows, "cp-open").pr_status], [open, "open"], "a custom-host MR link shows before it merges");
	for (const id of ["cp-cred", "cp-http"]) assert.deepEqual([pick(rows, id).pr_url, pick(rows, id).pr_status, pick(rows, id).merge_sha], [null, null, null], id);
	assert.equal(pick(rows, "cp-gh").pr_url, "https://github.com/acme/repo/pull/9", "GitHub links are unchanged");
	assert.doesNotMatch(JSON.stringify(rows), /token@/);
	assert.deepEqual((await job("cp-skilled")).skills, ["tdd-x", "lint-y"], "names only, never a dir");
	assert.equal("skills" in await job("cp-plain"), false);
	for (const [id, review, attempts] of [["cp-pass", "pass", 1], ["cp-equiv", "pass", 0], ["cp-bare", null, 0]] as const) {
		const row = await job(id);
		assert.deepEqual([row.review, row.review_attempts], [review, attempts], id);
	}
	const tone = await v.json<JobResponse>("/api/job/cp-tone");
	assert.deepEqual(tone.timeline.map((e) => [e.label, e.tone]), [["Failed", "neutral"], ["CI red", "red"], ["CI green", "green"]], "provider failures are neutral; only ci_failed is red");
	assert.deepEqual(pick(rows, "cp-events").routing_facts, { scope: "L", risk: "low", provenance: { scope: "inferred", risk: "explicit" }, rule: "latest rule", reasons: ["latest reason"] });
	assert.equal(pick(rows, "cp-events").routing, "scope:L (inferred) · risk:low (explicit) · latest rule · latest reason");
	assert.deepEqual(pick(rows, "cp-fleet").routing_facts, routing);
	assert.deepEqual(pick(rows, "cp-partial").routing_facts, { scope: null, risk: "high", provenance: { scope: null, risk: "inferred" }, rule: null, reasons: [] });
	assert.deepEqual([pick(rows, "cp-empty").routing_facts, pick(rows, "cp-empty").routing], [null, null]);
	assert.doesNotMatch(JSON.stringify(rows), /not-for-the-api|private/);
	assert.deepEqual((await v.json<JobResponse>("/api/job/cp-report")).reports.map((r) => [r.slug, r.href]), [["shared", "/boards/shared/"], ["new", "/boards/new/"]]);
	assert.deepEqual((await v.json<JobResponse>("/api/job/cp-noreport")).reports, []);
	assert.equal((await v.get("/api/job/cp-missing")).status, 404);
	const long = (await job("cp-long")).summary!;
	assert.deepEqual([long.length, long], [600, `${"y".repeat(599)}…`]);
	assert.equal((await job("cp-fit")).summary, "z".repeat(600), "exactly 600 is not cut");
	assert.equal(pick(rows, "cp-long").summary, `${"y".repeat(79)}…`, "the list keeps 80");
	// A live job exposes the same routing fields as a finished one.
	v.fleet([{ job_id: "cp-live", project: "demo", phase: "held", routing }]);
	const live = pick((await v.json<JobsResponse>("/api/jobs")).jobs, "cp-live");
	assert.equal(live.routing, "scope:S (explicit) · risk:low (defaulted) · fleet rule · fleet reason");
	assert.deepEqual(live.routing_facts, routing);
	// Corrupt sources are named, never silently empty.
	const broken = await viewer(t, (s) => {
		s.put(".pi-command-post/jobs.json", "{bad");
		s.put(join(LAYOUT.mandates, "md-bad.json"), "{bad");
	});
	assert.ok((await broken.json<JobsResponse>("/api/jobs")).warnings.some((w) => w.section === "ledger"));
	assert.equal((await broken.json<BoardResponse>("/api/board")).stranded_count, null);
});

/** The QA mandate fixture (cp-6fis): dispatch-recorded, run-recorded and legacy grants, one paused, one uncovered job. */
function qaFixture(s: Seed) {
	const at = iso(120);
	s.fleet([
		{ job_id: "cp-recorded", mandate_id: "md-original", project: "demo", phase: "held", dispatched_at: at }, { job_id: "cp-run", project: "demo", phase: "held", dispatched_at: at },
		{ job_id: "cp-legacy", project: "demo", phase: "held", dispatched_at: at }, { job_id: "cp-uncovered", project: "other", phase: "held", dispatched_at: at },
		{ job_id: "cp-paused", mandate_id: "md-paused", project: "demo", phase: "held", dispatched_at: at },
	]);
	s.events("cp-run", [{ type: "spawned", ts: at, payload: { mandate_id: "md-original" } }]);
	const grant = (id: string, status: string, extra: object = {}) => s.grant(id, status, { expiry: iso(-240), spend_cap: { usd: 10, tokens: 1000 }, ...extra });
	grant("md-original", "active", { job_ids: ["cp-recorded", "cp-run", "cp-legacy"] });
	grant("md-paused", "paused", { job_ids: ["cp-paused"] });
	grant("md-new", "active", { issued_at: iso(60), job_ids: ["cp-recorded", "cp-run", "cp-legacy"] });
	grant("md-revoked", "revoked", { issued_at: iso(30) });
	grant("md-expired", "expired", { projects: ["other"], expiry: iso(60) });
	grant("md-empty", "active", { job_ids: ["cp-nobody"] });
	s.put(LAYOUT.escalationsFile, { items: [{ id: "es-open", status: "open", kind: "final_fix", question: "Final-fix approval open", created_at: at, job_ids: ["cp-recorded"] }] });
	return grant;
}

test("P18-lanes: a job's grant is its dispatch provenance, and Board lanes close, hide and keep work by the Map's rules", { timeout: 180_000 }, async (t) => {
	const mandate = async (v: Awaited<ReturnType<typeof viewer>>, id: string) => (await v.json<JobResponse>(`/api/job/${id}`)).job.mandate_id;
	// Dispatch provenance beats later grants; an uncovered job stays on the board.
	const qa = await viewer(t, (s) => void qaFixture(s));
	const list = (await qa.json<JobsResponse>("/api/jobs")).jobs;
	for (const id of ["cp-recorded", "cp-run", "cp-legacy"]) assert.equal(pick(list, id).mandate_id, "md-original", id);
	assert.equal(await mandate(qa, "cp-recorded"), "md-original");
	assert.equal(pick(list, "cp-uncovered").mandate_id, null);
	const qaBoard = await qa.json<BoardResponse>("/api/board");
	assert.equal(qaBoard.jobs.length, 5);
	assert.deepEqual(qaBoard.lanes.map((l) => l.id), ["md-original", "unassigned", "md-paused"]);
	// Legacy job-scoped grants keep their dispatch history after expiry or revocation.
	const legacy = await viewer(t, (s) => {
		const grant = qaFixture(s);
		s.fleet([
			{ job_id: "cp-iu4n", project: "demo", phase: "held", dispatched_at: iso(123.35) }, { job_id: "cp-expired", project: "demo", phase: "held", dispatched_at: iso(120) },
			{ job_id: "cp-before", project: "demo", phase: "held", dispatched_at: iso(120) }, { job_id: "cp-queued", project: "demo", phase: "queued" },
		]);
		grant("md-33e95b", "revoked", { issued_at: iso(123.67), job_ids: ["cp-iu4n"], revoked_at: iso(6.73) });
		grant("md-ba09b7", "revoked", { issued_at: iso(121.25), job_ids: ["cp-iu4n"], revoked_at: iso(120.92) });
		grant("md-history", "expired", { job_ids: ["cp-expired", "cp-queued"], expiry: iso(60) });
		grant("md-before", "revoked", { job_ids: ["cp-before"], revoked_at: iso(150) });
	});
	const legacyJobs = (await legacy.json<JobsResponse>("/api/jobs")).jobs;
	assert.equal(pick(legacyJobs, "cp-iu4n").mandate_id, "md-33e95b");
	assert.equal(await mandate(legacy, "cp-iu4n"), "md-33e95b");
	assert.equal(pick(legacyJobs, "cp-expired").mandate_id, "md-history");
	for (const id of ["cp-before", "cp-queued"]) assert.equal(pick(legacyJobs, id).mandate_id, null, id);
	const legacyBoard = await legacy.json<BoardResponse>("/api/board");
	assert.equal(legacyBoard.jobs.length, 4);
	assert.equal(pick(legacyBoard.jobs, "cp-iu4n").mandate_id, "md-33e95b");
	assert.ok(legacyBoard.jobs.every((j) => j.board_lane_id === "unassigned"));
	assert.deepEqual(legacyBoard.lanes.map((l) => l.id), ["unassigned"]);
	// Missing and historical recorded grants stay attached without hiding jobs.
	const history = await viewer(t, (s) => {
		const grant = qaFixture(s);
		grant("md-broad", "active");
		grant("md-old", "revoked", { revoked_at: iso(25 * 60) });
		grant("md-closed", "revoked", { revoked_at: iso(60) });
		s.fleet([
			{ job_id: "cp-missing", project: "demo", phase: "held", mandate_id: "md-missing", dispatched_at: iso(120) }, { job_id: "cp-status", project: "demo", phase: "held", dispatched_at: iso(120) },
			{ job_id: "cp-old", project: "demo", phase: "held", mandate_id: "md-old", dispatched_at: iso(120) },
			{ job_id: "cp-closed", project: "demo", phase: "done", mandate_id: "md-closed", dispatched_at: iso(120), closed_at: iso(60) },
			{ job_id: "cp-revoked", project: "demo", phase: "held", mandate_id: "md-closed", dispatched_at: iso(120) },
		]);
		s.put(s.run("cp-status", "status.json"), { mandate_id: "md-original" });
	});
	const historyJobs = (await history.json<JobsResponse>("/api/jobs")).jobs;
	assert.equal(pick(historyJobs, "cp-missing").mandate_id, "md-missing");
	assert.equal(pick(historyJobs, "cp-status").mandate_id, "md-original");
	assert.equal(await mandate(history, "cp-old"), "md-old");
	const historyBoard = await history.json<BoardResponse>("/api/board");
	assert.equal(historyBoard.jobs.length, 5);
	for (const id of ["cp-old", "cp-missing", "cp-revoked"]) assert.equal(pick(historyBoard.jobs, id).board_lane_id, "unassigned", id);
	assert.equal(pick(historyBoard.jobs, "cp-closed").board_lane_id, "md-closed");
	assert.deepEqual(historyBoard.lanes.map((l) => l.id), ["md-original", "unassigned", "md-closed"]);
	assert.deepEqual(historyBoard.hidden_mandates.map((m) => m.id).sort(), ["md-old", "md-revoked"], "revoked non-lanes are offered; the revoked-today md-closed lane is not");
	assert.equal(historyBoard.hidden_mandates[0]?.status, "revoked");
	assert.equal(historyBoard.revoked_hidden, 2);
	// A grant closed by its mission end (answered close, revoked today) is a closed lane, not a revoked one.
	const ended = await viewer(t, (s) => {
		const grant = qaFixture(s);
		grant("md-auto", "revoked", { job_ids: ["cp-auto"], revoked_at: iso(60) });
		s.fleet([{ job_id: "cp-auto", project: "demo", phase: "held", mandate_id: "md-auto", dispatched_at: iso(120) }]);
		s.put(LAYOUT.escalationsFile, { items: [{ id: "es-auto", mandate_id: "md-auto", kind: "mission_end", status: "answered", answer: "close", answered_by: "mandate:md-auto", answered_at: iso(60), options: [{ id: "close", label: "close the mandate" }] }] });
	});
	const endedBoard = await ended.json<BoardResponse>("/api/board");
	assert.deepEqual(endedBoard.lanes.map((l) => [l.id, l.status]), [["md-auto", "closed"]]);
	assert.equal(pick(endedBoard.jobs, "cp-auto").board_lane_id, "md-auto");
	// Audit P2 #10/#11: a held or landed job's old failure is history; a lane whose named jobs all closed is closed.
	const failure = { class: "model_call_failed", message: "503 upstream", at: iso(1) };
	const audit = await viewer(t, (s) => {
		s.ledger([
			{ id: "cp-held", title: "Held", status: "in_progress", labels: ["project:demo", "kind:ship"] },
			{ id: "cp-shut", title: "Shut", status: "closed", closed_at: iso(1), labels: ["project:demo", "kind:ship"] },
			{ id: "cp-live", title: "Live", status: "in_progress", labels: ["project:demo", "kind:ship"] },
		]);
		s.fleet([
			{ job_id: "cp-held", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(1), failure },
			{ job_id: "cp-shut", project: "demo", kind: "ship", phase: "done", dispatched_at: iso(1), closed_at: iso(1), failure },
			{ job_id: "cp-live", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(1) },
		]);
		s.put(s.run("cp-held", "status.json"), { phase: "idle", started_at: iso(1), failure });
		s.grant("md-done", "active", { issued_at: iso(1), objective: "md-done", job_ids: ["cp-shut"] });
		s.grant("md-open", "active", { issued_at: iso(1), objective: "md-open", job_ids: ["cp-live", "cp-held"] });
	});
	const auditJobs = (await audit.json<JobsResponse>("/api/jobs")).jobs;
	assert.equal(pick(auditJobs, "cp-held").failure, null, "a held job's old failure is history");
	assert.equal(pick(auditJobs, "cp-shut").failure, null, "a landed job's old failure is history");
	assert.equal((await audit.json<JobResponse>("/api/job/cp-held")).job.failure, null);
	const auditBoard = await audit.json<BoardResponse>("/api/board");
	assert.deepEqual(auditBoard.lanes.map((l) => [l.id, l.status, l.active]), [["md-open", "active", true], ["md-done", "closed", false]], "closed, sorted below active");
	assert.equal(pick(auditBoard.jobs, "cp-shut").board_lane_id, "md-done", "a closed lane keeps its landed job");
	audit.grant("md-gone", "revoked", { issued_at: iso(1), revoked_at: iso(6 * 24 * 60), objective: "Old work", spend_cap: { usd: 1 } });
	const withGone = await audit.json<BoardResponse>("/api/board");
	assert.deepEqual(withGone.hidden_mandates, [{ id: "md-gone", status: "revoked", objective: "Old work" }], "a revoked non-lane is offered; lanes are not");
	assert.equal(withGone.revoked_hidden, 1);
	audit.fleet([{ job_id: "cp-held", project: "demo", kind: "ship", phase: "failed", dispatched_at: iso(1), failure }]);
	assert.equal(pick((await audit.json<JobsResponse>("/api/jobs")).jobs, "cp-held").failure, "503 upstream", "a failed job still shows its failure");
});

test("P18-transcript: /api/job/<id>/transcript reads only a recorded session under state/sessions, windowed, and detail keeps stored text", { timeout: 120_000 }, async (t) => {
	const line = (role: string, content: unknown, i: number) => JSON.stringify({ type: "message", timestamp: iso(60 - i / 60), message: { role, content } });
	const ids = ["cp-done", "cp-small", "cp-gone", "cp-outside", "cp-script"];
	const v = await viewer(t, (s, dir) => {
		const session = (name: string) => join(dir, LAYOUT.state, "sessions", `${name}.jsonl`);
		s.put(join(LAYOUT.state, "sessions/cp-done.jsonl"), [line("user", "The brief", 0), ...Array.from({ length: 400 }, (_, i) => line("assistant", [{ type: "text", text: `step ${i}` }], i + 1))].join("\n") + "\n");
		s.put(join(LAYOUT.state, "sessions/cp-small.jsonl"), [line("user", "Small brief", 0), line("assistant", [{ type: "text", text: "hello" }], 1)].join("\n") + "\n");
		s.put("outside.jsonl", line("user", "secret", 0) + "\n");
		s.ledger([...ids, "cp-ledger-only"].map((id) => ({ id, title: id, status: "closed", closed_at: iso(5), labels: ["project:demo", "kind:ship"], ...(id === "cp-done" ? { description: "Why this  job exists\nSecond line" } : {}) })));
		s.fleet(ids.map((job_id) => ({ job_id, project: "demo", kind: "ship", phase: "done", dispatched_at: iso(60), closed_at: iso(5), ...(job_id === "cp-script" ? { executor: "script" } : {}) })));
		for (const [id, file] of [["cp-done", session("cp-done")], ["cp-small", session("cp-small")], ["cp-gone", session("missing")], ["cp-outside", join(dir, "outside.jsonl")]] as const) s.put(s.run(id, "status.json"), { session_file: file });
		s.grant("md-a", "active", { objective: "Goal  A\nline two", job_ids: ["cp-done"], spend_cap: { usd: 20, tokens: 10000 } });
	});
	const body = (id: string) => v.json<JobTranscriptResponse>(`/api/job/${id}/transcript`);
	const small = await body("cp-small");
	assert.deepEqual(small.entries.map((e) => [e.who, e.text]), [["Parent", "Small brief"], ["Worker", "hello"]]);
	assert.deepEqual([small.warning, small.truncated, small.from, small.to], [null, false, small.entries[0]!.at, small.entries[1]!.at]);
	const big = await body("cp-done");
	assert.equal(big.entries.length, 301, "window 300 plus the brief the window cut");
	assert.deepEqual([big.entries[0]!.who, big.entries[0]!.text, big.entries.at(-1)!.text, big.truncated], ["Parent", "The brief", "step 399", true]);
	for (const id of ["cp-gone", "cp-outside", "cp-script", "cp-ledger-only"]) {
		const reply = await body(id);
		assert.deepEqual([reply.entries, reply.warning], [[], "No worker session recorded"], id);
	}
	assert.doesNotMatch(JSON.stringify(await body("cp-outside")), /secret/, "a session file outside state/sessions is never read");
	for (const id of ["cp-missing", "%2e%2e%2fsecret"]) assert.equal((await v.get(`/api/job/${id}/transcript`)).status, 404, id);
	assert.equal((await v.get("/api/job/cp-done/transcript", { method: "POST" })).status, 405);
	const detail = await v.json<JobResponse>("/api/job/cp-done");
	assert.equal(detail.description, "Why this  job exists\nSecond line", "stored spaces and line breaks reach the API untouched");
	assert.deepEqual([detail.mandate?.id, detail.mandate?.objective, detail.mandate?.cap_usd], ["md-a", "Goal  A\nline two", 20]);
	assert.equal((await v.json<JobResponse>("/api/job/cp-small")).mandate, null);
});

test("P18-parked: a human_handoff PR parks through cp_integrate, shows With the team, resumes through cp_send and lands by the watch", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("P18 parked handoff", 181);
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	const v = await viewer(t, s.home);
	const overview = () => v.json<OverviewResponse>("/api/overview");
	const row = async () => pick((await v.json<JobsResponse>("/api/jobs")).jobs, live.jobId);
	const events = (type: string) => readRunEvents(s.home, live.jobId).filter((event) => event.source === "cp" && event.type === type);
	// Control: before the handoff a held PR is In flight, never With the team.
	assert.deepEqual([(await overview()).with_team, (await overview()).in_flight.some((j) => j.id === live.jobId)], [[], true]);

	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp());
	s.setGh({ integration: true, runs: [ciRun(181, live.head, "completed", "success")] });
	await s.tick(live.jobId);
	const parked = await s.post.integrate({ jobId: live.jobId });
	assert.equal(parked.next, "wait", parked.reason);
	const record = s.post.fleet.require(live.jobId);
	assert.deepEqual([record.phase, record.lease_id, record.checkpoint_ref, record.awaiting_merge?.cycle], ["awaiting_merge", undefined, undefined, 1]);
	assert.equal(existsSync(join(s.home, paths.parkIntentFile(live.jobId))), false, "the park intent is spent");
	assert.equal(events("awaiting_merge_parked").length, 1);
	// The ci-watch row is gone once parked; the head's green comes from the journaled ci_observed event.
	rmSync(join(s.home, LAYOUT.ciWatchFile), { force: true });
	const team = (await overview()).with_team;
	assert.deepEqual(team.map((j) => [j.id, j.head, j.ci, j.frozen_seconds]), [[live.jobId, live.head, "green", record.awaiting_merge!.frozen_seconds]]);
	assert.equal((await overview()).in_flight.some((j) => j.id === live.jobId), false);
	const job = await row();
	assert.deepEqual([job.phase, job.head, job.ci, job.handed_at, job.elapsed_seconds], ["awaiting_merge", live.head, "green", record.awaiting_merge!.handed_at, record.awaiting_merge!.frozen_seconds]);
	v.clock(HOUR);
	const later = (await overview()).with_team[0]!;
	assert.deepEqual([later.frozen_seconds, (await row()).elapsed_seconds], [team[0]!.frozen_seconds, job.elapsed_seconds], "execution time is frozen");
	assert.ok(later.age_seconds >= team[0]!.age_seconds + 3_600, "team age keeps growing");
	v.clock();

	// A parked job is not this process's to tear down, revive or re-dispatch: cp_send is the one way back.
	const torn = await s.post.tearDown(live.jobId, { force: true } as never);
	assert.deepEqual([torn.torn_down, torn.failure?.code], [false, "job_parked"]);
	await assert.rejects(s.post.revive(live.jobId), /not_revivable_phase/);
	await assert.rejects(s.post.dispatch({ jobId: live.jobId, task: "again", model: record.worker.model, fetch: false }), /cp_send .*resumes/);
	assert.deepEqual(mergedCalls(s.ghCalls()), [], "a handoff never merges");

	// The team requests changes: one pending mark and one wake for the cycle; the job is CP work again.
	const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
	const author = { login: "ann", __typename: "User" };
	const pr = (over: object) => ({ url: live.prUrl, number: 181, state: "OPEN", headRefOid: live.head, headRefName: live.jobId, baseRefName: "main", mergedAt: null, mergeCommit: null, latestOpinionatedReviews: { nodes: [] }, comments: page, reviews: page, ...over });
	const answer = (over: object) => s.setGh({ integration: true, runs: [ciRun(181, live.head, "completed", "success")], routes: [
		{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] },
		{ match: "api graphql", replies: [json({ data: { rateLimit: { remaining: 5000 }, p0: { pullRequest: pr(over), stacked: { nodes: [] } } } })] },
	] });
	const after = isoTimestamp(new Date(Date.parse(record.awaiting_merge!.handed_at) + 1_000));
	await waitFor(() => Date.now(), (now) => now > Date.parse(after) + 1_000, { timeoutMs: 5_000, what: "a review time after the handoff, in the past" });
	answer({ reviews: { pageInfo: { hasNextPage: false, endCursor: "R1" }, nodes: [{ id: "PRR_1", state: "CHANGES_REQUESTED", body: "", createdAt: after, author, comments: { totalCount: 0 } }] } });
	const swept = await s.post.awaitingMerge.sweep();
	assert.deepEqual(swept.outcomes.map((o) => o.applied), ["changes_requested"], JSON.stringify(swept));
	assert.deepEqual((await s.post.awaitingMerge.sweep()).outcomes.map((o) => o.applied), ["none"], "the same review is applied once");
	assert.equal(s.post.fleet.require(live.jobId).awaiting_merge?.pending?.kind, "changes_requested");
	const box = s.post.durableWakeups.read();
	assert.equal([...box.pending, ...box.delivered].filter((w) => w.id.startsWith(`awaiting-merge:pending:${live.jobId}:1:`)).length, 1);
	const flight = (await overview()).in_flight.find((j) => j.id === live.jobId);
	assert.deepEqual([flight?.phase, flight?.parked_pending, (await overview()).with_team], ["held", "changes_requested", []]);

	// A real parent: the status block and cp_next name the pending parked job; its startup reconcile leaves it parked.
	await s.parent("Show the status block and what is next.", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: { width: 200 } }, { name: "cp_next", args: {} }] },
		{ kind: "text", text: "Shown." },
	], async (ends) => {
		const text = (name: string) => JSON.stringify(ends.find((e) => (e as { toolName: string }).toolName === name));
		assert.match(text("cp_status_block"), new RegExp(`In progress:.*${live.jobId}`));
		assert.match(text("cp_next"), new RegExp(`${live.jobId} \\(changes_requested\\) — cp_send ${live.jobId} resumes it`));
	});
	assert.equal(s.post.fleet.require(live.jobId).phase, "awaiting_merge");

	// Negative control for resume: with the session gone the send is refused and the job stays parked.
	const session = record.worker.session_file;
	renameSync(session, `${session}.away`);
	await assert.rejects(s.post.send({ jobId: live.jobId, message: "address the team's review" }), /session/);
	assert.equal(s.post.fleet.require(live.jobId).phase, "awaiting_merge");
	renameSync(`${session}.away`, session);
	const resumed = await s.post.send({ jobId: live.jobId, message: "address the team's review" });
	assert.equal(resumed.receipt, "delivered");
	const back = s.post.fleet.require(live.jobId);
	assert.deepEqual([back.awaiting_merge, typeof back.lease_id, events("awaiting_merge_resumed").length], [undefined, "string", 1]);
	await waitFor(() => JSON.stringify(s.provider.requests(`landing-${live.jobId}`).map((r) => r.body.messages)), (body) => /\[resumed from awaiting_merge\][^"]*address the team's review/.test(body), { timeoutMs: 60_000, what: "the note-led message reaches the resumed worker" });
	await waitFor(() => s.post.fleet.require(live.jobId), (r) => r.phase === "held" && !!r.reported_at && (r.supersessions ?? 0) >= 1, { timeoutMs: 90_000, what: "the resumed worker re-reports" });

	// It parks again for a second cycle, and the human merge seen by the watch lands it without a CP merge.
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "wait");
	assert.equal(s.post.fleet.require(live.jobId).awaiting_merge?.cycle, 2);
	answer({ state: "MERGED", mergedAt: isoTimestamp(), mergeCommit: { oid: MERGE } });
	assert.deepEqual((await s.post.awaitingMerge.sweep()).outcomes.map((o) => o.applied), ["merged"]);
	assert.equal(s.post.fleet.require(live.jobId).phase, "done");
	assert.equal(s.post.ledger().read().jobs.find((j) => j.id === live.jobId)?.status, "closed");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	assert.equal((await row()).phase, "done");
});
