/**
 * cp-s560 W2b: the read-only workbench's dashboard view. The viewer re-derives the mandate spend rule
 * without importing it (it must stay dependency-free), so these tests pin it to the real function on
 * the same home: `mandateSpend(m, withReviewerSpend(liveUsageJobs))`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, SCHEMA_VERSION, type Usage } from "../src/contracts.ts";
import { FleetStore, isPidAlive } from "../src/fleet.ts";
import { MandateStore, mandateSpend } from "../src/mandate.ts";
import { liveUsageJobs } from "../src/mandate-usage.ts";
import type { RunRegistry } from "../src/runs.ts";
import { pidAlive } from "../src/viewer/overview-health.ts";
import { dashboard } from "../src/viewer/fleet-view.ts";
import { runGit } from "../src/viewer/git-read.ts";
import { createViewer } from "../src/viewer/server.ts";
import { createScratchHome, git, REPO_ROOT, readRunStatus, type ScratchHome } from "./harness/index.ts";
import { withZombie } from "./harness/zombie.ts";
import { grantFor } from "../src/viewer/overview-jobs.ts";

const LATER = isoTimestamp(new Date(Date.now() + 86_400_000));
test("tv8: viewer active grant choice uses named/earliest/id precedence and retains inactive fallback", () => {
	const base = { projects: ["alpha"], status: "active", expiry: LATER, issued_at: "2026-09-01T00:00:00Z" };
	const broad = { ...base, id: "md-000001", issued_at: "2026-08-01T00:00:00Z" };
	const named = { ...base, id: "md-a994c5", job_ids: ["cp-target"] };
	const tied = { ...named, id: "md-b994c5" };
	const later = { ...named, id: "md-000000", issued_at: "2026-09-02T00:00:00Z" };
	const job = { id: "cp-target", labels: ["project:alpha", "kind:ship"] };
	for (const order of [[broad, named, tied, later], [later, tied, named, broad], [tied, broad, later, named]]) assert.equal(grantFor(job, order, Date.now())?.id, named.id);
	assert.equal(grantFor(job, [broad, { ...named, job_ids: ["cp-other"] }], Date.now())?.id, broad.id);
	assert.equal(grantFor(job, [broad, { ...named, exclusions: { job_kinds: ["ship"] } }], Date.now())?.id, broad.id);
	for (const order of [[broad, named], [named, broad]]) {
		const paused = order.map((m) => ({ ...m, status: "paused" }));
		assert.equal(grantFor(job, paused, Date.now())?.id, paused.at(-1)?.id);
	}
});

const usage = (cost_usd: number, total_tokens: number, cache_read = 0): Usage => ({ ...EMPTY_USAGE, cost_usd, total_tokens, cache_read });

function record(job_id: string, over: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id,
		project: "alpha",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "held",
		worker: { pid: 4242, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m", started_at: "2026-09-01T00:00:00Z" },
		worktree: `/wt/${job_id}`,
		branch: job_id,
		dispatched_at: "2026-09-01T00:00:00Z",
		usage: EMPTY_USAGE,
		reported_at: "2026-09-01T00:02:00Z",
		...over,
	};
}

function runStatus(home: string, dir: string, jobId: string, u: Usage): void {
	mkdirSync(join(home, LAYOUT.state, "runs", dir), { recursive: true });
	const status = { schema_version: SCHEMA_VERSION, job_id: jobId, phase: "working", turns: 1, tool_calls: 1, usage: u, started_at: "2026-09-01T00:00:00Z", last_activity_at: "2026-09-01T00:01:00Z", event_count: 1, reported: false };
	writeFileSync(join(home, LAYOUT.state, "runs", dir, "status.json"), JSON.stringify(status));
}

const PR = "https://github.com/acme/repo/pull/7";

async function dashboardHome(t: { after(fn: () => void): void }): Promise<{ home: ScratchHome; mandates: MandateStore }> {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-a1", { phase: "waiting", usage: usage(0.1, 100), receipts: [{ kind: "pr", status: "open", title: "x", url: "javascript:alert(1)" }] }));
	await fleet.add(record("cp-a2", { receipts: [{ kind: "pr", status: "open", title: "x", url: PR }], usage: usage(1, 1000, 200), dispatched_at: "2026-09-01T00:00:01Z" }));
	await fleet.add(record("cp-a3", { phase: "done", closed_at: "2026-09-02T00:00:00Z", usage: usage(0.5, 50) }));
	await fleet.add(record("cp-b1", { project: "beta", kind: "research", usage: usage(0.25, 40) }));
	await fleet.add(record("cp-b2", { project: "beta", receipts: [{ kind: "pr", status: "open", title: "x", url: "https://evil.example/acme/repo/pull/1" }] }));
	runStatus(home.path, "cp-a1", "cp-a1", usage(2, 3000, 1000));
	runStatus(home.path, "cp-a2/review-1", "cp-a2", usage(0.75, 500, 100));
	runStatus(home.path, "cp-b1/gate-1", "cp-b1", usage(0.5, 90));
	mkdirSync(join(home.path, ".pi-command-post"), { recursive: true });
	writeFileSync(join(home.path, ".pi-command-post", "jobs.json"), JSON.stringify({ jobs: [{ id: "cp-a1", title: "first job", status: "in_progress" }] }));
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "projects.json"), JSON.stringify({ projects: [{ name: "gamma" }, { name: "../bad" }] }));
	const mandates = new MandateStore(home.path);
	const base = { objective: "ship alpha", expiry: LATER, spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5 };
	mandates.issue({ ...base, projects: ["alpha"], job_ids: ["cp-a1", "cp-a2"] });
	mandates.pause(mandates.issue({ ...base, projects: ["beta", "alpha"], at: isoTimestamp(new Date(Date.now() + 1000)) }).id);
	return { home, mandates };
}

test("dashboard: grouped by project, live usage over fleet usage, reviewer spend, and only GitHub PR urls", async (t) => {
	const { home } = await dashboardHome(t);
	const view = dashboard({ home: home.path, stateDir: join(home.path, LAYOUT.state) });
	assert.deepEqual(view.projects.map((p) => p.name), ["alpha", "beta", "gamma"]);
	const alpha = view.projects[0]?.jobs ?? [];
	assert.deepEqual(alpha.map((j) => j.job_id), ["cp-a1", "cp-a2", "cp-a3"], "active in dispatch order, then finished");
	const a1 = alpha.find((j) => j.job_id === "cp-a1");
	assert.equal(a1?.cost_usd, 2, "the run's live usage wins over the stale fleet usage");
	assert.equal(a1?.tokens, 2000);
	assert.equal(a1?.title, "first job");
	assert.equal(a1?.pr_url, undefined, "a javascript: url never reaches the page");
	assert.equal(alpha.find((j) => j.job_id === "cp-a2")?.pr_url, PR);
	assert.equal(alpha.find((j) => j.job_id === "cp-a2")?.reviewer_cost_usd, 0.75);
	assert.equal(view.projects[1]?.jobs.find((j) => j.job_id === "cp-b2")?.pr_url, undefined, "a non-GitHub url is dropped");
	assert.deepEqual(view.projects[2]?.jobs, []);
});

test("dashboard: every mandate's spend equals mandateSpend over withReviewerSpend(liveUsageJobs) on the same home", async (t) => {
	const { home, mandates } = await dashboardHome(t);
	const runs = { get: (id: string) => ({ status: readRunStatus(home.path, id) }) };
	const jobs = mandates.withReviewerSpend(
		liveUsageJobs(new FleetStore({ home: home.path }), { get: (id: string) => { try { return runs.get(id); } catch { return undefined; } } } as unknown as RunRegistry),
	);
	const view = dashboard({ home: home.path, stateDir: join(home.path, LAYOUT.state) });
	const all = mandates.list();
	assert.equal(all.length, 2);
	assert.deepEqual(view.mandates.map((m) => m.status), ["active", "paused"]);
	for (const m of all) assert.deepEqual(view.mandates.find((v) => v.id === m.id)?.spend, mandateSpend(m, jobs), m.id);
	assert.ok((view.mandates[0]?.spend.usd ?? 0) > 2, "the fixture exercises live and reviewer spend");
});

test("dashboard: a baselined grant's spend equals mandateSpend and shows only what accrued after issue", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-h1", { phase: "done", usage: usage(1, 1000) }));
	await fleet.add(record("cp-h2", { usage: usage(0.5, 500) }));
	runStatus(home.path, "cp-h2/review-1", "cp-h2", usage(0.25, 100));
	const mandates = new MandateStore(home.path);
	const runs = { get: (id: string) => { try { return { status: readRunStatus(home.path, id) }; } catch { return undefined; } } } as unknown as RunRegistry;
	const live = () => liveUsageJobs(new FleetStore({ home: home.path }), runs);
	const grant = mandates.issue({ objective: "alpha", expiry: LATER, spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 5, projects: ["alpha"] }, live());
	assert.equal(grant.usage_baseline?.length, 2);

	runStatus(home.path, "cp-h2", "cp-h2", usage(1.5, 1500));
	runStatus(home.path, "cp-h2/review-2", "cp-h2", usage(0.25, 100));
	await fleet.add(record("cp-n1", { usage: usage(0.5, 500) }));
	const view = dashboard({ home: home.path, stateDir: join(home.path, LAYOUT.state) });
	const spend = view.mandates.find((m) => m.id === grant.id)?.spend;
	assert.deepEqual(spend, mandateSpend(mandates.require(grant.id), mandates.withReviewerSpend(live())));
	assert.deepEqual(spend, { usd: 1.75, tokens: 1600, jobs: 2, inFlight: 0 });
});

test("schedlater S3: spend splits by schedule_id — a schedule grant counts only its schedule's records, a project-wide grant none of them; the dashboard mirror agrees", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-s1", { phase: "waiting", usage: usage(1, 1000), schedule_id: "sch-aaa111" }));
	await fleet.add(record("cp-s2", { usage: usage(2, 2000), schedule_id: "sch-bbb222" }));
	await fleet.add(record("cp-u1", { usage: usage(4, 4000) }));
	runStatus(home.path, "cp-s1/review-1", "cp-s1", usage(0.5, 100));
	const mandates = new MandateStore(home.path);
	const base = { objective: "alpha", expiry: LATER, spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5, projects: ["alpha"] };
	const ours = mandates.issue({ ...base, schedule_grant: true });
	const theirs = mandates.issue({ ...base, schedule_grant: true });
	const wide = mandates.issue(base);
	const job = { title: "nightly", kind: "ship", delivery: "pr" };
	const saved = (id: string, mandate_id: string) => ({ id, name: id, project: "alpha", mandate_id, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job, enabled: true, created_at: "2026-09-01T00:00:00Z" });
	writeFileSync(join(home.path, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [saved("sch-aaa111", ours.id), saved("sch-bbb222", theirs.id)] }));
	const runs = { get: (id: string) => { try { return { status: readRunStatus(home.path, id) }; } catch { return undefined; } } } as unknown as RunRegistry;
	const jobs = mandates.withReviewerSpend(liveUsageJobs(fleet, runs));
	assert.deepEqual(mandateSpend(mandates.require(ours.id), jobs), { usd: 1.5, tokens: 1100, jobs: 1, inFlight: 1 }, "its schedule's run plus its reviewer");
	assert.deepEqual(mandateSpend(mandates.require(theirs.id), jobs), { usd: 2, tokens: 2000, jobs: 1, inFlight: 0 });
	assert.deepEqual(mandateSpend(mandates.require(wide.id), jobs), { usd: 4, tokens: 4000, jobs: 1, inFlight: 0 }, "no scheduled record");
	const view = dashboard({ home: home.path, stateDir: join(home.path, LAYOUT.state) });
	for (const m of mandates.list()) assert.deepEqual(view.mandates.find((v) => v.id === m.id)?.spend, mandateSpend(m, jobs), m.id);
});

function get(port: number, path: string, method = "GET", host = `127.0.0.1:${port}`): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("server: /api/dashboard and /api/awaiting are JSON under a deny-all CSP; every workbench route is GET-only and host-bound", async (t) => {
	const { home } = await dashboardHome(t);
	const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	for (const path of ["/api/dashboard", "/api/awaiting", "/api/version"]) {
		const reply = await get(options.port, path);
		assert.equal(reply.status, 200, path);
		assert.match(String(reply.headers["content-type"]), /application\/json/);
		assert.match(String(reply.headers["content-security-policy"]), /default-src 'none'/);
		JSON.parse(reply.body);
	}
	for (const path of ["/api/dashboard", "/api/awaiting", "/api/job", "/api/diff", "/api/roots", "/api/files", "/api/git", "/api/version"]) {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await get(options.port, path, method)).status, 405, `${method} ${path}`);
		assert.equal((await get(options.port, path, "GET", "evil.example")).status, 421, path);
	}
});

const VIEWER = join(REPO_ROOT, "src", "viewer");
const standalone = () => readdirSync(VIEWER).filter((name) => name.endsWith(".ts") && name !== "operator.ts" && name !== "doctor-check.ts");

test("viewer request/projection modules stay dependency-free and read-only; only the startup builder writes assets, push-subscriptions.ts writes device subscriptions, control-audit.ts appends the dashboard audit journal, uploads.ts stores composer images, threads-api.ts appends thread done lines", () => {
	const writers = new Set(["build.ts", "push-subscriptions.ts", "control-audit.ts", "uploads.ts"]);
	for (const name of standalone()) {
		const text = readFileSync(join(VIEWER, name), "utf8");
		for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
			if (match[1]) continue;
			if (name === "build.ts" && match[2] === "esbuild") continue;
			assert.match(match[2] ?? "", /^node:|^\.\/|^\.\.\/home\.ts$|^\.\.\/grant-order\.ts$/, `${name} imports ${match[2]}`);
			if (match[2] === "../grant-order.ts") assert.equal(name, "overview-jobs.ts", "only the shared dependency-free comparator crosses the viewer boundary");
			if (name === "push-subscriptions.ts") assert.match(match[2] ?? "", /^node:|^\.\/push-files\.ts$/, `${name} imports ${match[2]}`);
			if (name === "control-audit.ts") assert.match(match[2] ?? "", /^node:|^\.\/control-files\.ts$/, `${name} imports ${match[2]}`);
		}
		for (const match of text.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)) {
			assert.match(match[1] ?? "", /^node:|^\.\/|^\.\.\/home\.ts$/, `${name} dynamically imports ${match[1]}`);
		}
		if (!writers.has(name)) assert.doesNotMatch(text, /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream|\bwriteSync\(|\b(?:writeFile|appendFile|mkdir|rename|unlink)\s*\(/, name);
		// The dashboard-control writer is imported by the three write routes (control, image upload, thread done) and nothing else in the viewer.
		if (name !== "control-api.ts" && name !== "operator-upload-api.ts" && name !== "threads-api.ts") assert.doesNotMatch(text, /from "\.\/control-audit\.ts"/, `${name} imports the audit writer`);
		// The image store is written only through uploads.ts, and only the upload route stores (the message route and the GET only read).
		if (name !== "operator-upload-api.ts" && name !== "uploads.ts") assert.doesNotMatch(text, /\bwriteUpload\b/, `${name} stores an upload`);
		if (name === "control-api.ts" || name === "control-files.ts") assert.doesNotMatch(text, /parent-host|OperatorAsks|operator-asks/, `${name} reaches the parent or the ask journal`);
	}
	assert.doesNotMatch(readFileSync(join(VIEWER, "push-subscriptions.ts"), "utf8"), /appendFileSync|createWriteStream|unlinkSync|\bappendFile\s*\(/);
	const audit = readFileSync(join(VIEWER, "control-audit.ts"), "utf8");
	assert.doesNotMatch(audit, /writeFileSync|renameSync|rmSync|unlinkSync|truncate/, "the audit writer only appends");
	assert.match(audit, /openSync\(file, "a", 0o600\)/, "and opens for append, owner-only");
	assert.match(readFileSync(join(VIEWER, "control-api.ts"), "utf8"), /from "\.\/control-audit\.ts"/);
	const uploads = readFileSync(join(VIEWER, "uploads.ts"), "utf8");
	assert.doesNotMatch(uploads, /from "\.\/(?!control-files)[^"]*"/, "the image store imports nothing of the viewer but control-files");
	assert.match(uploads, /O_EXCL/, "an upload is created, never overwritten");
});

/**
 * cp-hvbj: the Overview parent chip asks the OS about the pid `state/parent.lock` records. The
 * viewer re-derives that probe (see the dependency-free rule above), so this pins it to the real
 * `isPidAlive` `/doctor` and the lock's own reclaim path use — on a real zombie, a live pid and a
 * pid that is gone.
 */
test("the viewer's pid probe agrees with fleet's isPidAlive: a zombie lock holder is down, not alive", async (t) => {
	await withZombie(t, (zombie, holder) => {
		for (const pid of [zombie, holder, process.pid, 0, -1, 2 ** 30]) assert.equal(pidAlive(pid), isPidAlive(pid), `pid ${pid}`);
		assert.equal(pidAlive(zombie), false, "a kill-0-only check would call a zombie alive");
		assert.equal(pidAlive(holder), true);
	});
});

/** `projects/demo` with a base and a head commit, plus held jobs whose envelopes name (or omit) the shas. */
async function diffHome(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const repo = join(home.path, LAYOUT.projects, "demo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main", "--quiet");
	for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "base", "--quiet");
	const base = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "a.txt"), "one\ntwo from head\n");
	git(repo, "commit", "-am", "head", "--quiet");
	const head = git(repo, "rev-parse", "HEAD");
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(record("cp-h1", { project: "demo", worktree: "/nonexistent/cp-h1", receipts: [{ kind: "pr", status: "open", title: "x", url: PR }] }));
	await fleet.add(record("cp-h2", { project: "demo" }));
	const envelope = (id: string, env: object) => {
		mkdirSync(join(home.path, LAYOUT.state, "runs", id), { recursive: true });
		writeFileSync(join(home.path, LAYOUT.state, "runs", id, "envelope.json"), JSON.stringify({ schema_version: 1, job_id: id, attempt: 1, envelope: env }));
	};
	envelope("cp-h1", { head_sha: head, base_sha: base, branch: "cp-h1", status: "done", summary: "landed" });
	envelope("cp-h2", { head_sha: head, branch: "cp-h2", status: "done", summary: "no base" });
	writeFileSync(join(home.path, LAYOUT.state, "runs", "cp-h1", "review-1.json"), JSON.stringify({ attempt: 1, verdict: "revise", head_sha: base }));
	writeFileSync(join(home.path, LAYOUT.state, "runs", "cp-h1", "review-2.json"), JSON.stringify({ attempt: 2, verdict: "pass", head_sha: head }));
	writeFileSync(join(home.path, LAYOUT.state, "ci-watch.json"), JSON.stringify({ jobs: [{ job_id: "cp-h1", head_sha: head, last_ci: "green" }] }));
	return { home, repo, base, head };
}

test("held job: /api/job carries PR, shas, CI and review; /api/diff serves base...head from the project clone", async (t) => {
	const { home, base, head } = await diffHome(t);
	const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const job = JSON.parse((await get(options.port, "/api/job?id=cp-h1")).body);
	assert.equal(job.pr_url, PR);
	assert.equal(job.head, head);
	assert.equal(job.base, base);
	assert.equal(job.ci.last_ci, "green");
	assert.deepEqual(job.review, { attempt: 2, verdict: "pass", head_sha: head });
	assert.equal(job.worktree_live, false);
	const diff = JSON.parse((await get(options.port, "/api/diff?id=cp-h1")).body);
	assert.equal(diff.available, true);
	assert.equal(diff.root, "project:demo");
	assert.equal(diff.truncated, false);
	assert.match(diff.text, /^\+two from head$/m);
	assert.deepEqual(JSON.parse((await get(options.port, "/api/diff?id=cp-h2")).body), { available: false, reason: "no head/base sha recorded" });
	for (const path of ["/api/diff?id=../x", "/api/job?id=../x", "/api/job?id=cp-nope", "/api/diff?id=cp-nope"]) assert.equal((await get(options.port, path)).status, 404, path);
});

test("git-read: refuses non-allowlisted subcommands and --output without spawning, caps output, never locks the index", async (t) => {
	const { repo } = await diffHome(t);
	const out = join(repo, "..", "leak.txt");
	assert.deepEqual(await runGit(repo, ["diff", `--output=${out}`]), { ok: false, stdout: "", truncated: false, reason: "refused" });
	assert.equal((await runGit(repo, ["config", "x"])).reason, "refused");
	assert.equal((await runGit(repo, ["log", "--ext-diff"])).reason, "refused");
	assert.equal(existsSync(out), false);
	const capped = await runGit(repo, ["log", "--format=%H"], { maxBytes: 1 });
	assert.deepEqual([capped.ok, capped.truncated, capped.stdout.length], [true, true, 1]);
	const index = join(repo, ".git", "index");
	const before = statSync(index).mtimeMs;
	writeFileSync(join(repo, "a.txt"), "dirty\n"); // a stat change git status would otherwise refresh into the index
	assert.equal((await runGit(repo, ["status", "--porcelain=v1"])).stdout.trim(), "M a.txt");
	assert.equal(existsSync(join(repo, ".git", "index.lock")), false);
	assert.equal(statSync(index).mtimeMs, before);
	assert.equal((await runGit(repo, ["show", "no-such-ref"])).ok, false);
});
