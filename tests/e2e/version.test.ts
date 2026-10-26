/**
 * Behavior 15 (P14): the version view through its consumers — `bin/cp-view`'s `GET /api/version` and `/api/job/<id>`,
 * the cp-bridge footer and `/cp-version` — against a scratch checkout that shares this one's objects, so HEAD is the
 * commit every process here loaded. The viewer runs on the process clock (tests/harness/process-clock.ts).
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type TestContext, test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { JobResponse, VersionResponse } from "../../src/viewer/api-types.ts";
import {
	buildPiArgs, COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, type RpcRecord, type ScriptStep, startPiChild,
	startRpc,
} from "../harness/index.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { call } from "../harness/remote.ts";

const CLOCK = pathToFileURL(resolve(import.meta.dirname, "../harness/process-clock.ts")).href;
const HEAD = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const H7 = HEAD.slice(0, 7);
const OLD = "1".repeat(40);
const SECRET = "f".repeat(64);
const MINUTE = 60_000;
const IDENTITY = { GIT_AUTHOR_NAME: "p14", GIT_AUTHOR_EMAIL: "p14@example.test", GIT_COMMITTER_NAME: "p14", GIT_COMMITTER_EMAIL: "p14@example.test" };

/** A checkout borrowing this repo's objects: HEAD and origin/main at this HEAD; `upstream()` adds commits on top. */
function checkout(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14-repo-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
	git("init", "-q", "-b", "main");
	const common = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
	writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${resolve(REPO_ROOT, common, "objects")}\n`);
	git("update-ref", "refs/heads/main", HEAD);
	git("update-ref", "refs/remotes/origin/main", HEAD);
	return {
		dir, git,
		/** `count` commits on top of `from`; returns the last. */
		upstream: (count: number, from = HEAD) => {
			let at = from;
			for (let n = 0; n < count; n += 1) at = git("commit-tree", `${HEAD}^{tree}`, "-p", at, "-m", `upstream ${n}`);
			return at;
		},
	};
}

const freePort = (): Promise<number> => new Promise((done) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as { port: number };
		probe.close(() => done(port));
	});
});

/** A scratch home's state files, with timestamps on a clock the test can move. */
function stateOf(home: string) {
	const stateDir = join(home, LAYOUT.state);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	let offset = 0;
	const clockFile = join(home, "clock-offset-ms");
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(`${file}.tmp`, typeof value === "string" ? value : JSON.stringify(value));
		renameSync(`${file}.tmp`, file);
	};
	put(clockFile, "0");
	return {
		stateDir, clockFile,
		write: (file: string, value: unknown) => put(join(stateDir, file), value),
		remove: (...files: string[]) => { for (const file of files) rmSync(join(stateDir, file), { force: true }); },
		put: (file: string, value: unknown) => put(join(home, file), value),
		/** ISO time `minutes` ago on the moved clock. */
		iso: (minutes: number) => new Date(Date.now() + offset - minutes * MINUTE).toISOString(),
		/** Moves the clock on, past the viewer's 10 s git cache. */
		advance: (ms = 10_000) => { offset += ms; put(clockFile, String(offset)); },
	};
}

/** `bin/cp-view` on a scratch home comparing against `repo`; `get` reads a JSON path. */
async function viewer(t: TestContext, repo: string) {
	const home = createScratchHome();
	const state = stateOf(home.path);
	const port = await freePort();
	const view: ChildProcess = spawn(join(REPO_ROOT, "bin/cp-view"), ["--home", home.path, "--host", "127.0.0.1", "--port", String(port)], {
		env: { PATH: process.env.PATH ?? "", HOME: home.path, CP_HOME: home.path, CP_VERSION_REPO: repo, CP_TEST_CLOCK_FILE: state.clockFile, NODE_OPTIONS: `--import ${CLOCK}` },
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
	for (const end = Date.now() + 60_000; ; await new Promise((done) => setTimeout(done, 100))) {
		if ((await call(port, "/healthz").catch(() => ({ status: 0 }))).status === 200) break;
		if (Date.now() > end) throw new Error(`cp-view never answered on ${port}\n${output}`);
	}
	const get = async <T>(path: string) => {
		const reply = await call(port, path);
		assert.equal(reply.status, 200, reply.text);
		return { body: reply.body as unknown as T, text: reply.text };
	};
	return { home: home.path, ...state, get, version: async () => (await get<VersionResponse>("/api/version")).body };
}

const deadPid = () => spawnSync("true").pid;

test("P14-version-badge: /api/version reads each process's record and the updater's run against the checkout, never a token", { timeout: 300_000 }, async (t) => {
	const repo = checkout(t);
	const v = await viewer(t, repo.dir);
	const alive = process.pid;
	let lastRun = "";
	const current = () => {
		lastRun = v.iso(2);
		v.write("update.json", { last_result: "up_to_date", last_run_at: lastRun, since: v.iso(60) });
		v.write("parent-host.1.json", { version: 1, pid: deadPid(), socket: "/s1", token: SECRET, started_at: v.iso(90) });
		v.write("parent-host.2.json", { version: 1, pid: alive, socket: "/tmp/host.sock", token: SECRET, started_at: v.iso(30), commit: HEAD });
		v.write("parent.lock", { schema_version: 1, pid: alive, started_at: v.iso(30), home: v.home, commit: HEAD });
		v.write("operator/dashboard.json", { version: 1, pid: alive, socket: "/tmp/dash.sock", token: SECRET, csrf: SECRET, started_at: v.iso(20), commit: HEAD });
	};

	// Green: every process on HEAD, a fresh up_to_date run; the highest host generation is read, and no secret leaks.
	current();
	const green = await v.get<VersionResponse>("/api/version");
	assert.deepEqual(Object.keys(green.body).sort(), ["bundle", "deployed", "generated_at", "overall", "processes", "upstream"]);
	assert.equal(green.body.deployed?.sha, HEAD);
	assert.deepEqual([green.body.upstream.state, green.body.upstream.behind, green.body.upstream.ahead], ["current", 0, 0]);
	assert.equal(green.body.upstream.checked_at, lastRun, "a fresh fetching run proves the comparison");
	assert.deepEqual(green.body.processes.map((p) => [p.role, p.state]), [["viewer", "current"], ["host", "current"], ["parent", "current"], ["operator", "current"]]);
	assert.deepEqual([green.body.overall.level, green.body.overall.label], ["ok", `latest · ${H7}`]);
	for (const leak of [SECRET, "/tmp/host.sock", "/tmp/dash.sock", "token", "csrf", "socket"]) assert.ok(!green.text.includes(leak), leak);

	// origin/main moves two on: the git read is cached for 10 s, then the badge is amber with the updater's reason.
	repo.git("update-ref", "refs/remotes/origin/main", repo.upstream(2));
	v.write("update.json", { last_result: "skipped_busy", last_run_at: v.iso(1) });
	assert.equal((await v.version()).upstream.behind, 0, "reused for 10 s");
	v.advance();
	const busy = await v.version();
	assert.deepEqual([busy.upstream.state, busy.upstream.behind, busy.upstream.ahead], ["behind", 2, 0]);
	assert.deepEqual([busy.overall.level, busy.overall.label], ["warn", "2 behind (skipped_busy)"]);

	// One behind: the updater's phase or last result as a clocked sentence (pill) and in full (headline).
	repo.git("update-ref", "refs/remotes/origin/main", repo.upstream(1));
	v.advance();
	v.put(join(LAYOUT.data, "update.json"), { enabled: true, interval_min: 5, quiet_min: 20 });
	const to = "a".repeat(40);
	const clock = (iso: string, minutes: number) => `${new Date(Date.parse(iso) + minutes * MINUTE).toISOString().slice(11, 16)}Z`;
	const pair = async () => { const { label, headline } = (await v.version()).overall; return [label, headline]; };
	const seen = v.iso(9);
	v.write("update.json", { phase: "idle", last_result: "skipped_settling", last_run_at: v.iso(1), to, first_seen_sha: to, first_seen_at: seen });
	assert.deepEqual(await pair(), [`1 behind (waits until ${clock(seen, 20)})`, `1 behind (update to aaaaaaa waits for quiet origin/main until ${clock(seen, 20)})`], "first_seen_at + quiet_min");
	v.write("update.json", { phase: "draining", last_result: "skipped_settling", last_run_at: v.iso(6), to });
	assert.deepEqual(await pair(), ["1 behind (draining ≤ 11 min)", "1 behind (draining for update to aaaaaaa; gives up after 11 min)"], "phase beats the prior result");
	const ran = v.iso(2);
	v.write("update.json", { phase: "idle", last_result: "drain_timeout", last_run_at: ran, to });
	assert.deepEqual(await pair(), [`1 behind · drain timeout · retry ${clock(ran, 20)}`, `1 behind · drain timed out — retries ${clock(ran, 20)}; cp_parent drain_cancel reopens dispatch`], "4× interval_min");
	v.write("update.json", { phase: "idle", last_result: "skipped_dirty", last_run_at: v.iso(1) });
	assert.deepEqual(await pair(), ["1 behind (local changes)", "1 behind (skipped: local changes in the checkout (git status) — commit, stash or remove them)"]);
	const applied = v.iso(4);
	v.write("update.json", { phase: "idle", last_result: "updated", last_run_at: v.iso(1), to, updated_at: applied });
	const done = await v.version();
	assert.equal(done.upstream.updater?.progress, `applied aaaaaaa ${clock(applied, 0)} · parent restarted`);
	assert.deepEqual([done.overall.label, done.overall.headline], ["1 behind", "1 behind"], "an applied update adds nothing to the label");
	v.write("update.json", { phase: "idle", last_result: "skipped_settling", last_run_at: v.iso(1) });
	assert.deepEqual(await pair(), ["1 behind (skipped_settling)", "1 behind (skipped_settling)"], "no first_seen_at: no invented clock");

	// HEAD ahead of origin/main is neutral; host and parent records on another commit are amber with their restart.
	const ahead = Number(repo.git("rev-list", "--count", `${HEAD}^..${HEAD}`));
	repo.git("update-ref", "refs/remotes/origin/main", `${HEAD}^`);
	v.advance();
	v.write("update.json", { last_result: "up_to_date", last_run_at: v.iso(1) });
	v.write("parent-host.2.json", { version: 1, pid: alive, socket: "/s", token: SECRET, started_at: v.iso(30), commit: OLD });
	v.write("parent.lock", { schema_version: 1, pid: alive, started_at: v.iso(30), home: v.home, commit: OLD });
	const stale = await v.version();
	assert.deepEqual([stale.upstream.state, stale.upstream.ahead], ["ahead", ahead]);
	const host = stale.processes.find((p) => p.role === "host");
	assert.deepEqual([host?.state, host?.why], ["stale", `on 1111111, checkout at ${H7}`]);
	assert.match(host?.fix ?? "", /restart the parent host/);
	assert.deepEqual([stale.overall.level, stale.overall.label], ["warn", "host stale · parent stale"], "ahead itself never warns");

	// Red: a stale operator session, a failed update (detail capped, no fetch proven), a fetch failing three times.
	repo.git("update-ref", "refs/remotes/origin/main", HEAD);
	v.advance();
	current();
	v.write("operator/dashboard.json", { version: 1, pid: alive, socket: "/s", token: SECRET, csrf: SECRET, started_at: v.iso(20), commit: OLD });
	const session = await v.version();
	assert.deepEqual([session.overall.level, session.overall.label], ["alert", "session stale — restart"]);
	assert.match(session.processes.find((p) => p.role === "operator")?.fix ?? "", /Restart session/);
	current();
	v.write("update.json", { last_result: "rolled_back", last_run_at: v.iso(1), detail: "x".repeat(500), fetch_failures: 0 });
	const rolled = await v.version();
	assert.deepEqual([rolled.overall.level, rolled.overall.label], ["alert", "update rolled_back"]);
	assert.equal(rolled.upstream.updater?.detail?.length, 160, "detail is capped");
	assert.equal(rolled.upstream.checked_at, null, "a rollback proves no fetch");
	v.write("update.json", { last_result: "fetch_failed", last_run_at: v.iso(1), fetch_failures: 3 });
	assert.deepEqual([(await v.version()).overall.level, (await v.version()).overall.label], ["alert", "fetch failing ×3"]);

	// Grey: no update run and legacy records without a commit are unknown, never green; a dead pid is down.
	v.remove("update.json", "parent-host.2.json", "operator/dashboard.json");
	v.write("parent-host.1.json", { version: 1, pid: alive, socket: "/s", token: SECRET, started_at: v.iso(30) });
	v.write("parent.lock", { schema_version: 1, pid: deadPid(), started_at: v.iso(30), home: v.home });
	const grey = await v.version();
	assert.deepEqual([grey.upstream.updater, grey.upstream.checked_at], [null, null]);
	assert.deepEqual(grey.processes.map((p) => [p.role, p.state]), [["viewer", "current"], ["host", "unknown"], ["parent", "down"], ["operator", "down"]]);
	assert.equal(grey.overall.level, "unknown");
	assert.match(grey.overall.label, /upstream unchecked$/);
	v.write("update.json", { last_result: "up_to_date", last_run_at: v.iso(1) });
	assert.match((await v.version()).overall.label, /host unknown$/, "a fresh fetch alone leaves the legacy host unknown");
	v.write("update.json", { last_result: "updated", last_run_at: v.iso(1), updated_at: v.iso(10) });
	assert.equal((await v.version()).processes.find((p) => p.role === "host")?.state, "stale", "started before the last update");
	v.write("update.json", { last_result: "up_to_date", last_run_at: v.iso(31) });
	assert.equal((await v.version()).upstream.checked_at, null, "an old fetch proves nothing");

	// No origin/main: upstream unknown with git's reason, never a failed request.
	repo.git("update-ref", "-d", "refs/remotes/origin/main");
	v.advance();
	const blind = await v.version();
	assert.equal(blind.upstream.state, "unknown");
	assert.match(blind.upstream.reason ?? "", /^no comparison with origin\/main/);
	assert.deepEqual([blind.overall.level, blind.overall.label.endsWith("upstream unknown")], ["unknown", true]);
});

test("P14-version-running: /api/job/<id> keeps the checkout's ancestry and each process's started-on commit apart", { timeout: 300_000 }, async (t) => {
	const repo = checkout(t);
	const v = await viewer(t, repo.dir);
	const base = `${HEAD}^`;
	const alive = process.pid;
	v.write("parent-host.1.json", { pid: alive, started_at: v.iso(30), commit: repo.git("rev-parse", base) });
	v.write("parent.lock", { pid: alive, started_at: v.iso(30), commit: OLD });
	v.write("operator/dashboard.json", { pid: deadPid(), started_at: v.iso(20), commit: HEAD });
	const mergedAt = v.iso(5);
	v.put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-merged", project: "demo", kind: "ship", phase: "done", dispatched_at: v.iso(60), closed_at: mergedAt }] });
	const merge = (sha: string) => v.put(join(LAYOUT.runs, "cp-merged/merge.json"), { job_id: "cp-merged", merged_at: mergedAt, pr_url: "https://github.com/acme/demo/pull/7", merge_commit_sha: sha });
	const running = async () => (await v.get<JobResponse>("/api/job/cp-merged")).body.running!;

	// A merge this checkout lacks entirely is unknown, never "not running"; one only upstream has is not included.
	merge("e".repeat(40));
	const other = await running();
	assert.deepEqual([other.checkout, other.since, other.processes.map((p) => p.state)], ["unknown", null, ["unknown", "unknown", "unknown", "down"]]);
	assert.match(other.why, /eeeeeee is not in this home's checkout/);
	merge(repo.upstream(1));
	assert.equal((await running()).checkout, "not_included");

	// HEAD's own merge: in the checkout since the update that brought it in, and per process by its started-on commit.
	merge(HEAD);
	const brought = v.iso(3);
	v.write("update.json", { last_result: "updated", updated_at: brought, from: repo.git("rev-parse", base), to: HEAD });
	const here = await running();
	assert.deepEqual([here.checkout, here.since], ["included", brought], "the recorded update brought it in");
	assert.deepEqual(here.processes.map((p) => [p.role, p.state]), [["viewer", "loaded"], ["host", "not_loaded"], ["parent", "unknown"], ["operator", "down"]]);
	assert.ok(here.processes[0]?.since, "the viewer started after the merge");
	assert.deepEqual(here.processes.slice(1).map((p) => p.since), [null, null, null]);
	// An update recorded before the merge cannot have brought it in (at the merge time it can); one whose `from`
	// already had it dates nothing.
	v.write("update.json", { last_result: "updated", updated_at: v.iso(10), from: repo.git("rev-parse", base), to: HEAD });
	assert.equal((await running()).since, null);
	v.write("update.json", { last_result: "updated", updated_at: mergedAt, from: repo.git("rev-parse", base), to: HEAD });
	assert.equal((await running()).since, mergedAt, "equal to the merge time is possible");
	v.write("update.json", { last_result: "updated", updated_at: v.iso(3), from: HEAD, to: HEAD });
	assert.equal((await running()).since, null);
});

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** A pi session on `home` with one extension; `script` drives its model. */
async function session(t: TestContext, home: string, extension: string, env: Record<string, string>, script: ScriptStep[]) {
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(() => { void provider.stop(); agentDir.cleanup(); });
	const model = provider.addScript("p14-version", script, { onExhausted: "repeat" });
	agentDir.writeModels(provider);
	return startPiChild({ cwd: home, model, env: { ...agentDir.env, CP_HOME: home, CP_MODE: "multi", ...env }, extensions: [extension] });
}

const notices = (records: readonly RpcRecord[]) =>
	records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));

test("P14-version-live: a hosted parent and its host record the commit they loaded; the footer and /cp-version compare it", { timeout: 300_000 }, async (t) => {
	const repo = checkout(t);
	const home = createScratchHome();
	t.after(() => teardownHome(home));
	const state = stateOf(home.path);
	state.write("update.json", { last_result: "up_to_date", last_run_at: state.iso(1) });
	const start = { id: "start", name: "cp_parent", args: { action: "start", home: home.path } };
	const bridge = await session(t, home.path, CP_BRIDGE_EXTENSION, { CP_VERSION_REPO: repo.dir }, [{ kind: "tool_calls", calls: [start] }, { kind: "text", text: "Started." }]);
	const footer = () => bridge.records().filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "cp-version")
		.map((r) => stripAnsi(String(r.statusText ?? "")));
	try {
		await bridge.prompt("Start the parent.");
		await bridge.waitForSettled(90_000);
		const lock = JSON.parse(readFileSync(join(state.stateDir, "parent.lock"), "utf8"));
		const hosts = readdirSync(state.stateDir).filter((name) => /^parent-host\.\d+\.json$/.test(name)).sort();
		assert.equal(lock.commit, HEAD, "the parent's lock carries the commit it loaded");
		assert.equal(JSON.parse(readFileSync(join(state.stateDir, hosts.at(-1)!), "utf8")).commit, HEAD, "and so does its host's record");

		// The footer: every layer on HEAD is green; once the checkout moves past this session, the session is stale.
		await bridge.waitFor(() => footer().includes(`version: latest · ${H7}`), 60_000);
		const moved = repo.upstream(1);
		repo.git("update-ref", "refs/heads/main", moved);
		repo.git("update-ref", "refs/remotes/origin/main", moved);
		await new Promise((resolve) => setTimeout(resolve, 10_500));
		state.write("update.json", { last_result: "up_to_date", last_run_at: state.iso(0) });
		const stale = `this session stale (on ${H7}, checkout at ${moved.slice(0, 7)}) — restart`;
		// Within one 10 s tick of the update.json change, well before the 60 s periodic refresh.
		await bridge.waitFor(() => footer().some((line) => line.includes(stale)), 25_000);
	} finally {
		await bridge.close();
	}
	const last = bridge.records().filter((r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "cp-version").at(-1);
	assert.equal(last?.statusText, undefined, "the line is cleared when the session stops");

	// /cp-version on a parent session of its own: this checkout against the moved one, upstream unchecked without a run.
	const other = createScratchHome();
	t.after(() => teardownHome(other));
	const parent = await session(t, other.path, COMMAND_POST_EXTENSION, { CP_VERSION_REPO: repo.dir }, [{ kind: "text", text: "noted" }]);
	try {
		await parent.prompt("/cp-version");
		await parent.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).includes("deployed"), 60_000);
		const line = notices(parent.records()).find((text) => text.includes("deployed")) ?? "";
		assert.match(line, new RegExp(`commit ${H7} · deployed ${repo.git("rev-parse", "--short=7", "HEAD")} \\(stale — rotate at a quiet point \\(cp_parent rotate\\)\\) · upstream current \\(unchecked\\)`));
	} finally {
		await parent.close();
	}
});

test("P14-version-lock: a live holder's lock without a commit, or with a malformed one, is still a lock", { timeout: 300_000 }, async (t) => {
	for (const commit of [undefined, "not-a-sha"]) {
		const home = createScratchHome();
		t.after(() => teardownHome(home));
		const state = stateOf(home.path);
		const since = state.iso(5).replace(/\.\d+Z$/, "Z");
		state.write("parent.lock", { schema_version: 1, pid: process.pid, started_at: since, home: home.path, ...(commit ? { commit } : {}) });
		const parent = await session(t, home.path, COMMAND_POST_EXTENSION, {}, [{ kind: "text", text: "noted" }]);
		try {
			await parent.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).includes("parent lock: "), 60_000);
			assert.match(notices(parent.records()).join("\n"), new RegExp(`pi-command-post: parent lock: refused — .*pid ${process.pid}`), String(commit));
		} finally {
			await parent.close();
		}
	}
});

test("P14-version-print: a print-mode cp-bridge session has no UI, so the version line writes nothing anywhere", { timeout: 120_000 }, async (t) => {
	const repo = checkout(t);
	const home = createScratchHome();
	t.after(() => teardownHome(home));
	const state = stateOf(home.path);
	state.write("update.json", { last_result: "up_to_date", last_run_at: state.iso(1) });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(() => { void provider.stop(); agentDir.cleanup(); });
	// The model holds the turn 8 s, past the line's first refresh, so a line written without a UI would show.
	const model = provider.addScript("p14-print", [{ kind: "hang", ms: 8_000 }], { onExhausted: "repeat" });
	agentDir.writeModels(provider);
	const env = { ...agentDir.env, CP_HOME: home.path, CP_MODE: "multi", CP_VERSION_REPO: repo.dir };
	const print = startRpc({ cwd: home.path, mode: "json", env, args: buildPiArgs({ cwd: home.path, model, extensions: [CP_BRIDGE_EXTENSION], extraArgs: ["--print", "status?"] }) });
	t.after(() => print.close().then(() => undefined));
	print.endInput();
	await print.waitFor((r) => r.type === "agent_end", 60_000);
	assert.equal(await print.close(), 0, print.stderr());
	assert.deepEqual(print.records().filter((r) => r.type === "extension_ui_request" && r.statusKey === "cp-version"), []);
	assert.doesNotMatch(print.stderr(), /version: /, "no version line on stderr either");
	assert.doesNotMatch(JSON.stringify(print.records()), /version: (latest|unknown)/, "nor in the event stream");
});
