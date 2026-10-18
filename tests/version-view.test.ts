/**
 * cp-kz20: the version view behind `GET /api/version`, the cp-bridge footer line and `/cp-version`.
 * A scratch repo with a seeded bare origin sets behind/ahead; state files are synthetic, per test.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startVersionLine } from "../extensions/cp-bridge/version-line.ts";
import { LAYOUT } from "../src/contracts.ts";
import type { JobResponse, VersionResponse } from "../src/viewer/api-types.ts";
import type { GitRunner } from "../src/viewer/loaded-commit.ts";
import { runGit } from "../src/viewer/git-read.ts";
import { createViewer } from "../src/viewer/server.ts";
import { DRAIN_TIMEOUT_RETRY_FACTOR, DRAIN_WAIT_MS, QUIET_MIN_DEFAULT, readUpdateConfig } from "../src/service/update.ts";
import { formatTerminal, GIT_CACHE_MS, gitFacts, readRunning, readVersion, UPDATER } from "../src/viewer/version-view.ts";
import { badgeView } from "../viewer-app/use-version.ts";
import { advanceBase, createScratchHome, createScratchRepo } from "./harness/index.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ALIVE = new Set([101, 102, 103]);
const OLD = "1".repeat(40);
const SECRET = "f".repeat(64);

function fixture(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	const repo = createScratchRepo();
	t.after(() => { home.cleanup(); repo.cleanup(); });
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	const write = (file: string, value: unknown) => writeFileSync(join(stateDir, file), JSON.stringify(value));
	const read = (extra: Partial<Parameters<typeof readVersion>[0]> = {}) => readVersion({
		home: home.path, stateDir, repo: repo.path, now: () => NOW, alive: (pid) => ALIVE.has(pid),
		self: { pid: 100, started_at: iso(5), commit: repo.head() }, script: "/assets/viewer/app-abc.js", ...extra,
	});
	return { home, repo, stateDir, write, read };
}

/** Every process on HEAD, a fresh up_to_date run: the green baseline each test bends. */
function current(f: ReturnType<typeof fixture>) {
	const head = f.repo.head();
	f.write("update.json", { last_result: "up_to_date", last_run_at: iso(2), since: iso(60) });
	f.write("parent-host.1.json", { version: 1, pid: 999, socket: "/s1", token: SECRET, started_at: iso(90) });
	f.write("parent-host.2.json", { version: 1, pid: 101, socket: "/tmp/host.sock", token: SECRET, started_at: iso(30), commit: head });
	f.write("parent.lock", { schema_version: 1, pid: 102, started_at: iso(30), home: f.home.path, commit: head });
	f.write("operator/dashboard.json", { version: 1, pid: 103, socket: "/tmp/dash.sock", token: SECRET, csrf: SECRET, started_at: iso(20), commit: head });
}

test("green: every process on HEAD, HEAD at a freshly fetched origin/main → ok, latest", async (t) => {
	const f = fixture(t);
	current(f);
	const view = await f.read();
	assert.equal(view.deployed?.sha, f.repo.head());
	assert.deepEqual([view.upstream.state, view.upstream.behind, view.upstream.ahead], ["current", 0, 0]);
	assert.equal(view.upstream.checked_at, iso(2));
	assert.deepEqual(view.processes.map((p) => [p.role, p.state]), [["viewer", "current"], ["host", "current"], ["parent", "current"], ["operator", "current"]]);
	assert.equal(view.overall.level, "ok");
	assert.match(view.overall.label, /^latest · [0-9a-f]{7}$/);
	assert.equal(view.bundle.script, "/assets/viewer/app-abc.js");
	assert.ok(!JSON.stringify(view).includes(SECRET), "no token or csrf");
	assert.ok(!JSON.stringify(view).includes(".sock"), "no socket path");
});

test("amber: origin/main moved on and the updater skipped while busy → warn, N behind (skipped_busy)", async (t) => {
	const f = fixture(t);
	current(f);
	advanceBase(f.repo, "a.txt", "a");
	advanceBase(f.repo, "b.txt", "b");
	f.repo.git("fetch", "--quiet", "origin");
	f.write("update.json", { last_result: "skipped_busy", last_run_at: iso(1) });
	const view = await f.read();
	assert.deepEqual([view.upstream.state, view.upstream.behind, view.upstream.ahead], ["behind", 2, 0]);
	assert.deepEqual([view.overall.level, view.overall.label], ["warn", "2 behind (skipped_busy)"]);
});

test("#325: the updater's phase and result read as a clocked sentence from state/update.json", async (t) => {
	const f = fixture(t);
	current(f);
	advanceBase(f.repo, "a.txt", "a");
	f.repo.git("fetch", "--quiet", "origin");
	const to = "a".repeat(40);
	const data = join(dirname(f.stateDir), "data");
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "update.json"), JSON.stringify({ enabled: true, interval_min: 5, quiet_min: 20 }));
	f.write("update.json", { phase: "idle", last_result: "skipped_settling", last_run_at: iso(1), to, first_seen_sha: to, first_seen_at: "2026-10-01T11:51:00Z" });
	// `label` is the pill (and footer): short, never the whole sentence; `headline` carries the sentence for the popover.
	const pair = async () => { const { label, headline } = (await f.read()).overall; return [label, headline]; };
	assert.deepEqual(await pair(), ["1 behind (waits until 12:11Z)", "1 behind (update to aaaaaaa waits for quiet origin/main until 12:11Z)"], "first_seen_at + quiet_min");
	f.write("update.json", { phase: "draining", last_result: "skipped_settling", last_run_at: iso(6), to });
	assert.deepEqual(await pair(), ["1 behind (draining ≤ 11 min)", "1 behind (draining for update to aaaaaaa; gives up after 11 min)"], "phase beats the prior result");
	f.write("update.json", { phase: "idle", last_result: "drain_timeout", last_run_at: "2026-10-01T11:58:00Z", to });
	assert.deepEqual(await pair(), ["1 behind · drain timeout · retry 12:18Z", "1 behind · drain timed out — retries 12:18Z; cp_parent drain_cancel reopens dispatch"], "4× interval_min");
	f.write("update.json", { phase: "idle", last_result: "skipped_dirty", last_run_at: iso(1) });
	assert.deepEqual(await pair(), ["1 behind (local changes)", "1 behind (skipped: local changes in the checkout (git status) — commit, stash or remove them)"]);
	f.write("update.json", { phase: "idle", last_result: "updated", last_run_at: iso(1), to, updated_at: "2026-10-01T11:56:00Z" });
	const applied = await f.read();
	assert.equal(applied.upstream.updater?.progress, "applied aaaaaaa 11:56Z · parent restarted");
	assert.deepEqual([applied.overall.label, applied.overall.headline], ["1 behind", "1 behind"], "an applied update adds nothing to the badge label");
	// No first_seen_at recorded: no invented clock, the bare result stays.
	f.write("update.json", { phase: "idle", last_result: "skipped_settling", last_run_at: iso(1) });
	assert.deepEqual(await pair(), ["1 behind (skipped_settling)", "1 behind (skipped_settling)"]);
});

test("#325: the sentence's drain wait, retry factor and defaults match the updater's own constants", (t) => {
	// Mirrored, not imported (the updater imports the viewer server); this fails when either side drifts.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const config = readUpdateConfig(join(home.path, "no-data"));
	assert.ok(typeof config !== "string");
	assert.deepEqual(UPDATER, { drainWaitMin: DRAIN_WAIT_MS / 60_000, retryFactor: DRAIN_TIMEOUT_RETRY_FACTOR, intervalMin: config.interval_min, quietMin: QUIET_MIN_DEFAULT });
});

test("ahead and diverged are neutral; a stale host is amber with its restart", async (t) => {
	const f = fixture(t);
	current(f);
	const before = f.repo.head();
	f.repo.write("local.txt", "x");
	f.repo.commitAll("local");
	f.write("operator/dashboard.json", { version: 1, pid: 103, socket: "/s", token: SECRET, csrf: SECRET, started_at: iso(1), commit: f.repo.head() });
	const ahead = await f.read({ self: { pid: 100, started_at: iso(1), commit: f.repo.head() } });
	assert.deepEqual([ahead.upstream.state, ahead.upstream.ahead], ["ahead", 1]);
	const host = ahead.processes.find((p) => p.role === "host");
	assert.equal(host?.state, "stale");
	assert.match(host?.why ?? "", new RegExp(`on ${before.slice(0, 7)}, checkout at ${f.repo.head().slice(0, 7)}`));
	assert.match(host?.fix ?? "", /restart the parent host/);
	assert.equal(ahead.overall.level, "warn", "host and parent stale; ahead itself never warns");
	assert.match(ahead.overall.label, /^host stale · parent stale$/);
});

test("red: the operator session is stale, or the update failed, or the fetch keeps failing", async (t) => {
	const f = fixture(t);
	current(f);
	f.write("operator/dashboard.json", { version: 1, pid: 103, socket: "/s", token: SECRET, csrf: SECRET, started_at: iso(20), commit: OLD });
	const stale = await f.read();
	assert.deepEqual([stale.overall.level, stale.overall.label], ["alert", "session stale — restart"]);
	assert.match(stale.processes.find((p) => p.role === "operator")?.fix ?? "", /Restart session/);
	current(f);
	f.write("update.json", { last_result: "rolled_back", last_run_at: iso(1), detail: "x".repeat(500), fetch_failures: 0 });
	const rolled = await f.read();
	assert.deepEqual([rolled.overall.level, rolled.overall.label], ["alert", "update rolled_back"]);
	assert.equal(rolled.upstream.updater?.detail?.length, 160, "detail is capped");
	assert.equal(rolled.upstream.checked_at, null, "a rollback proves no fetch");
	f.write("update.json", { last_result: "fetch_failed", last_run_at: iso(1), fetch_failures: 3 });
	assert.equal((await f.read()).overall.level, "alert");
});

test("grey: no update.json and legacy records without a commit → unknown, never green; dead pids are down, not unknown", async (t) => {
	const f = fixture(t);
	f.write("parent-host.1.json", { version: 1, pid: 101, socket: "/s", token: SECRET, started_at: iso(30) });
	f.write("parent.lock", { schema_version: 1, pid: 555, started_at: iso(30), home: f.home.path });
	const view = await f.read();
	assert.equal(view.upstream.updater, null);
	assert.equal(view.upstream.checked_at, null);
	assert.deepEqual(view.processes.map((p) => [p.role, p.state]), [["viewer", "current"], ["host", "unknown"], ["parent", "down"], ["operator", "down"]]);
	assert.equal(view.overall.level, "unknown");
	assert.match(view.overall.label, /upstream unchecked$/);
	// A fresh fetch alone still leaves the legacy host unknown.
	f.write("update.json", { last_result: "up_to_date", last_run_at: iso(1) });
	assert.match((await f.read()).overall.label, /host unknown$/);
	// A legacy record that started before the last applied update is stale.
	f.write("update.json", { last_result: "updated", last_run_at: iso(1), updated_at: iso(10) });
	assert.equal((await f.read()).processes.find((p) => p.role === "host")?.state, "stale");
	// An old fetch proves nothing.
	f.write("update.json", { last_result: "up_to_date", last_run_at: iso(31) });
	assert.equal((await f.read()).upstream.checked_at, null);
});

test("no origin/main: upstream unknown with git's reason, never a throw", async (t) => {
	const f = fixture(t);
	current(f);
	f.repo.git("update-ref", "-d", "refs/remotes/origin/main");
	const view = await f.read();
	assert.equal(view.upstream.state, "unknown");
	assert.match(view.upstream.reason ?? "", /^no comparison with origin\/main/);
	assert.deepEqual([view.overall.level, view.overall.label.endsWith("upstream unknown")], ["unknown", true]);
});

test("the git read is cached per repository for 10 s on the injected clock", async (t) => {
	const f = fixture(t);
	let calls = 0;
	const git: GitRunner = (cwd, args, opts) => { calls += 1; return runGit(cwd, args, opts); };
	const repo = `${f.repo.path}/.`; // a key no other test shares
	await gitFacts(repo, NOW, git);
	assert.equal(calls, 2, "HEAD and the counts");
	await gitFacts(repo, NOW + GIT_CACHE_MS - 1, git);
	await Promise.all([gitFacts(repo, NOW + 5_000, git), gitFacts(repo, NOW + 9_000, git)]);
	assert.equal(calls, 2, "reused for 10 s");
	await gitFacts(repo, NOW + GIT_CACHE_MS, git);
	assert.equal(calls, 4, "re-read after 10 s");
});

test("formatTerminal: this session's own loaded commit decides the operator layer", async (t) => {
	const f = fixture(t);
	current(f);
	const view = await f.read();
	assert.deepEqual(formatTerminal(view, f.repo.head()), { level: "ok", text: `version: latest · ${f.repo.head().slice(0, 7)}` });
	const stale = formatTerminal(view, OLD);
	assert.equal(stale.level, "alert");
	assert.equal(stale.text, `version: this session stale (on 1111111, checkout at ${f.repo.head().slice(0, 7)}) — restart`);
	assert.equal(formatTerminal(view, null).level, "unknown");
});

test("version line: refresh = readVersion then formatTerminal into setStatus; nothing without a UI; cleared on stop", async () => {
	const statuses: Array<[string, string | undefined]> = [];
	const view = { deployed: { sha: OLD, at: iso(1) }, upstream: { state: "current", behind: 0, ahead: 0, reason: null, checked_at: iso(1), updater: null }, processes: [], bundle: { script: null }, overall: { level: "ok", label: "x", headline: "x" }, generated_at: iso(0) } as VersionResponse;
	let reads = 0;
	let hasUI = true;
	// No `theme`, like the bridge tests' doubles: the line is written plain, never a throw.
	const ctx = () => ({ hasUI, ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) } }) as never;
	const line = startVersionLine({ home: () => "/nonexistent-home", ctx, read: async () => { reads += 1; return view; }, own: async () => OLD, tickMs: 60_000 });
	await line.refresh();
	assert.equal(reads, 1, "single-flight: the start refresh and this one share a read");
	assert.deepEqual(statuses.at(-1), ["cp-version", "version: latest · 1111111"]);
	hasUI = false;
	await line.refresh();
	assert.equal(statuses.length, 1, "no UI: nothing written");
	hasUI = true;
	line.stop();
	assert.deepEqual(statuses.at(-1), ["cp-version", undefined]);
	await line.refresh();
	assert.equal(reads, 2, "stopped: no further reads");
});

test("badge: an outdated page lifts ok/unknown to amber with a reload; alert stays red; loading and errors are grey", async (t) => {
	const f = fixture(t);
	current(f);
	const view = await f.read();
	assert.deepEqual(badgeView({ view, error: null }, "/assets/viewer/app-abc.js"), { level: "ok", short: "✓", label: view.overall.label, headline: view.overall.headline, pageStale: false });
	const old = badgeView({ view, error: null }, "/assets/viewer/app-old.js");
	assert.deepEqual([old.level, old.pageStale, old.label.startsWith("page outdated — reload")], ["warn", true, true]);
	const red = { ...view, overall: { level: "alert" as const, label: "update failed", headline: "update failed" } };
	assert.equal(badgeView({ view: red, error: null }, "/assets/viewer/app-old.js").level, "alert");
	assert.deepEqual(badgeView({ view: null, error: "HTTP 500" }, null), { level: "unknown", short: "?", label: "version unavailable (HTTP 500)", headline: "version unavailable (HTTP 500)", pageStale: false });
});

test("#324: merged vs running here — checkout ancestry and each process's started-on commit stay separate", async (t) => {
	const f = fixture(t);
	const base = f.repo.head();
	f.repo.write("fix.txt", "fix");
	const merged = f.repo.commitAll("the merged fix");
	const opts = { home: f.home.path, stateDir: f.stateDir, repo: f.repo.path, now: () => NOW, alive: (pid: number) => ALIVE.has(pid), self: { pid: 100, started_at: iso(5), commit: merged } };
	f.write("parent-host.1.json", { pid: 101, started_at: iso(30), commit: base });
	f.write("parent.lock", { pid: 102, started_at: iso(30), commit: OLD });
	f.write("operator/dashboard.json", { pid: 999, started_at: iso(20), commit: merged });
	f.write("update.json", { last_result: "updated", updated_at: iso(10), from: base, to: merged });
	const running = await readRunning(merged, opts);
	assert.deepEqual([running.checkout, running.since], ["included", iso(10)], "the recorded update brought it in");
	assert.deepEqual(running.processes.map((p) => [p.role, p.state, p.since]), [
		["viewer", "loaded", iso(5)], ["host", "not_loaded", null], ["parent", "unknown", null], ["operator", "down", null],
	]);
	// Ancestry alone never dates adoption: an update whose `from` already had the merge leaves the time unknown.
	f.write("update.json", { last_result: "updated", updated_at: iso(10), from: merged, to: merged });
	assert.deepEqual([(await readRunning(merged, opts)).since, (await readRunning(base, opts)).since], [null, null]);
	// Amendment 1: a recorded time before the merge itself is impossible and never shown, for checkout or process.
	f.write("update.json", { last_result: "updated", updated_at: iso(10), from: base, to: merged });
	const early = await readRunning(merged, opts, iso(7));
	assert.deepEqual([early.since, early.processes[0]?.since], [null, iso(5)]);
	assert.deepEqual((await readRunning(merged, opts, iso(4))).processes.map((p) => p.since), [null, null, null, null]);
	assert.equal((await readRunning(merged, opts, iso(10))).since, iso(10), "equal to the merge time is possible");
	const upstream = advanceBase(f.repo, "later.txt", "later");
	f.repo.git("fetch", "--quiet", "origin");
	assert.equal((await readRunning(upstream, opts)).checkout, "not_included");
	const other = await readRunning("e".repeat(40), opts);
	assert.deepEqual([other.checkout, other.since, other.processes.map((p) => p.state)], ["unknown", null, ["unknown", "unknown", "unknown", "down"]]);
	assert.match(other.why, /not in this home's checkout/);
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("GET /api/version: a VersionResponse with no token, csrf or socket from the records it read", async (t) => {
	const f = fixture(t);
	current(f);
	const options = { home: f.home.path, stateDir: f.stateDir, host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const reply = await get(options.port, "/api/version");
	assert.equal(reply.status, 200);
	const view = JSON.parse(reply.body) as VersionResponse;
	assert.deepEqual(Object.keys(view).sort(), ["bundle", "deployed", "generated_at", "overall", "processes", "upstream"]);
	assert.deepEqual(view.processes.map((p) => p.role), ["viewer", "host", "parent", "operator"]);
	for (const leak of [SECRET, "/tmp/host.sock", "/tmp/dash.sock", "token", "csrf", "socket"]) assert.ok(!reply.body.includes(leak), leak);
});

test("#324 GET /api/job/<id>: a merged job carries `running`; a merge this checkout lacks is unknown, never not-running", async (t) => {
	const f = fixture(t);
	current(f);
	const put = (file: string, value: unknown) => { mkdirSync(dirname(join(f.home.path, file)), { recursive: true }); writeFileSync(join(f.home.path, file), JSON.stringify(value)); };
	put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-merged", project: "demo", kind: "ship", phase: "done", dispatched_at: iso(60), closed_at: iso(5) }] });
	put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", merged_at: iso(5), pr_url: "https://github.com/acme/demo/pull/7", merge_commit_sha: "e".repeat(40) });
	const options = { home: f.home.path, stateDir: f.stateDir, host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const reply = await get(options.port, "/api/job/cp-merged");
	assert.equal(reply.status, 200);
	const running = (JSON.parse(reply.body) as JobResponse).running;
	assert.equal(running?.checkout, "unknown");
	assert.match(running?.why ?? "", /eeeeeee is not in this home's checkout/);
	// Amendment 1: an update recorded before the receipt's merged_at cannot have brought the merge in; never shown.
	const base = f.repo.head();
	f.repo.write("fix.txt", "fix");
	const merged = f.repo.commitAll("the merged fix");
	const prior = process.env.CP_VERSION_REPO;
	process.env.CP_VERSION_REPO = f.repo.path;
	t.after(() => { if (prior === undefined) delete process.env.CP_VERSION_REPO; else process.env.CP_VERSION_REPO = prior; });
	put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", merged_at: iso(5), pr_url: "https://github.com/acme/demo/pull/7", merge_commit_sha: merged });
	const since = async (updatedAt: string) => {
		f.write("update.json", { last_result: "updated", updated_at: updatedAt, from: base, to: merged });
		const view = JSON.parse((await get(options.port, "/api/job/cp-merged")).body) as JobResponse;
		assert.equal(view.running?.checkout, "included");
		const shown = view.running?.since ?? null;
		assert.ok(shown === null || Date.parse(shown) >= Date.parse(view.job.finished_at!), `${shown} precedes the merge`);
		return shown;
	};
	assert.equal(await since(iso(10)), null);
	assert.equal(await since(iso(3)), iso(3));
});
