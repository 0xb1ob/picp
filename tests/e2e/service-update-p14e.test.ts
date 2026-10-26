/**
 * Behavior 15 (P14e): cp-daemon's update oneshot as cp-daemon runs it — `node <app>/src/service/update.ts` in a scratch
 * checkout with a bare origin, its clock 50 times fast. The parent host and cp-daemon's control socket are one logging
 * stand-in process answering from a plan file; npm is a stub; git, the fleet, run status and drain.json are real.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, layoutForHome, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { PARENT_CONTROL_BUSY, PARENT_UNSETTLED } from "../../src/parent-diagnostics.ts";
import { parentHostPaths } from "../../src/parent-host.ts";
import { initialStatus } from "../../src/run-artifacts.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { whichAll } from "../../src/doctor.ts";
import type { UpdateState } from "../../src/service/update.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { until } from "../harness/dashboard.ts";
import { advanceBase, createScratchRepo } from "../harness/scratch-repo.ts";

const SCALE = 50;
const T0 = Date.parse("2026-09-28T10:00:00Z");
const FAR = "f".repeat(40);

/** The parent host and cp-daemon's control socket: `host <op>` / `daemon <op>` to calls.log, answers from plan.json. */
const STANDIN = `const fs = require("node:fs"); const net = require("node:net"); const e = process.env;
const log = (line) => fs.appendFileSync(e.SM + "/calls.log", line + "\\n");
const plan = () => JSON.parse(fs.readFileSync(e.SM + "/plan.json", "utf8"));
const save = (p) => fs.writeFileSync(e.SM + "/plan.json", JSON.stringify(p));
const next = (p, key) => { const list = p[key] ?? []; const value = list.length > 1 ? list.shift() : list[0]; save(p); return value; };
const serve = (path, handle) => { fs.rmSync(path, { force: true }); net.createServer((s) => { let buf = ""; s.on("data", (c) => { buf += c;
  let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  Promise.resolve().then(() => handle(m)).then((r) => r !== undefined && s.write(JSON.stringify({ id: m.id, ...r }) + "\\n"), (err) => s.write(JSON.stringify({ id: m.id, ok: false, error: err.message }) + "\\n")); } }); }).listen(path); };
serve(e.HOST_SOCK, (m) => { const p = plan(); const shown = (m.args ?? []).filter((a) => !(a && typeof a === "object" && "reason" in a));
  if (shown.length < (m.args ?? []).length) fs.appendFileSync(e.SM + "/causes.log", JSON.stringify(m.args.at(-1)) + "\\n");
  if (["drain", "drainCancel", "stop"].includes(m.op)) log("host " + m.op + (shown.length ? " " + JSON.stringify(shown) : ""));
  if ((p.failing ?? []).includes("host " + m.op)) throw new Error(m.op + " refused");
  if (m.op === "hello") return { ok: true, result: { pid: process.pid, parent: process.pid } };
  if (m.op === "status") return { ok: true, result: p.statusPid === undefined ? { alive: true, pid: process.pid } : { alive: p.statusPid > 0, pid: p.statusPid } };
  if (m.op === "drain") { if (p.drainThrow) throw new Error(p.drainThrow); const state = next(p, "drainStates") ?? "drained";
    if (state !== "gone") fs.writeFileSync(e.DRAIN, JSON.stringify({ started_at: new Date().toISOString(), state, jobs: [] }));
    return { ok: true, result: { text: p.drainText ?? "DRAIN: drain", level: "info" } }; }
  if (m.op === "drainCancel") { fs.rmSync(e.DRAIN, { force: true }); return { ok: true, result: { text: "cancelled" } }; }
  if (m.op === "doctor") { const answer = next(p, "doctor") ?? "ok"; if (p.onDoctor) { const { files = [], patch = {} } = p.onDoctor;
      for (const f of files) fs.writeFileSync(f.path, f.text); save({ ...plan(), onDoctor: undefined, ...patch }); }
    if (answer === "viewerdown") save({ ...plan(), viewerDown: true });
    if (answer === "hang") return undefined; if (answer === "unsettled" || answer === "viewerdown") throw new Error(e.UNSETTLED);
    if (answer.startsWith("down:")) throw new Error(answer.slice(5));
    return { ok: true, result: answer.startsWith("error:") ? { level: "error", text: answer.slice(6) } : { level: "info", text: "DOCTOR ok" } }; }
  return { ok: true, result: {} }; });
serve(e.DAEMON_SOCK, (m) => { log("daemon " + m.op); return (plan().failing ?? []).includes("daemon " + m.op) ? { ok: false, error: "refused" } : { ok: true }; });
fs.writeFileSync(e.SM + "/ready", "");
`;

type Plan = { statusPid?: number; drainStates?: string[]; drainThrow?: string; drainText?: string; doctor?: string[]; failing?: string[]; viewerDown?: boolean; onDoctor?: { files?: Array<{ path: string; text: string }>; patch?: Plan } };

/** A cp-daemon home whose app is a scratch checkout of this tree's src/ with a bare origin, and its stand-ins. */
async function bench(t: TestContext, config: unknown = { enabled: true, interval_min: 15, quiet_min: 0 }) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const ignore = ".pi-command-post/\nsrc/\nnode_modules\npackage.json\n";
	const repo = createScratchRepo({ files: { ".gitignore": ignore, "package-lock.json": "{\"v\":1}\n", "README.md": "app\n" } });
	t.after(() => repo.cleanup());
	cpSync(join(REPO_ROOT, "src"), join(repo.path, "src"), { recursive: true });
	cpSync(join(REPO_ROOT, "package.json"), join(repo.path, "package.json"));
	symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.path, "node_modules"));
	const stateDir = join(home, layoutForHome("multi", home).state);
	const dataDir = join(home, layoutForHome("multi", home).data);
	const sm = join(home, "sm");
	const bin = join(home, "bin");
	for (const dir of [stateDir, dataDir, sm, bin]) mkdirSync(dir, { recursive: true });
	if (config !== null) writeFileSync(join(dataDir, "update.json"), typeof config === "string" ? config : JSON.stringify(config));
	writeFileSync(daemonPaths(home).config, "{}");
	symlinkSync(realpathSync(whichAll("git")[0]!), join(bin, "git"));
	writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${sm}/calls.log"\ngrep -q '"npm $*"' "${sm}/plan.json" && exit 1\nexit 0\n`, { mode: 0o755 });
	const plan = (p: Plan) => writeFileSync(join(sm, "plan.json"), JSON.stringify(p));
	plan({});
	// The stand-in: the host record and cp-daemon's state name its two sockets.
	const hostPaths = parentHostPaths(home, "multi");
	const daemon = daemonPaths(home);
	writeFileSync(join(sm, "standin.cjs"), STANDIN);
	const env = { SM: sm, HOST_SOCK: join(sm, "host.sock"), DAEMON_SOCK: join(sm, "daemon.sock"), DRAIN: join(stateDir, "drain.json"), UNSETTLED: PARENT_UNSETTLED };
	const standin = spawn(process.execPath, [join(sm, "standin.cjs")], { env, stdio: "ignore" });
	t.after(() => standin.kill());
	await until(() => existsSync(join(sm, "ready")), Boolean, "the stand-in's sockets");
	writeFileSync(hostPaths.record(1), JSON.stringify({ version: 1, pid: standin.pid, socket: env.HOST_SOCK, token: "t", started_at: isoTimestamp() }));
	writeFileSync(daemon.state, JSON.stringify({ state: "running", socket: env.DAEMON_SOCK, token: "t", pid: standin.pid }));
	// The viewer: /api/identity names this home unless the plan says it is down.
	const viewer = createServer((_req, res) => {
		const down = (JSON.parse(readFileSync(join(sm, "plan.json"), "utf8")) as Plan).viewerDown;
		res.statusCode = down ? 503 : 200;
		res.end(JSON.stringify({ home }));
	});
	await new Promise<void>((done) => viewer.listen(0, "127.0.0.1", done));
	t.after(() => viewer.close());
	let clock = T0;
	const out: string[] = [];
	/** One update run `advanceMin` minutes after the last one ended; the record it left (undefined when it wrote none). */
	const run = async (advanceMin = 20, opts: { dry?: boolean; env?: Record<string, string> } = {}): Promise<UpdateState | undefined> => {
		clock += advanceMin * 60_000;
		const before = existsSync(join(stateDir, "update.json")) ? readFileSync(join(stateDir, "update.json"), "utf8") : undefined;
		const zero = Math.round((clock - Date.now() * SCALE) / (1 - SCALE));
		const script = join(repo.path, "src/service/update.ts");
		const child = spawn(process.execPath, ["--import", join(REPO_ROOT, "tests/harness/time-scale.ts"), script, ...(opts.dry ? ["--dry-run"] : [])], {
			cwd: home,
			env: { HOME: home, CP_HOME: home, PATH: bin, CP_DAEMON_JOB: "update", CP_VIEWER_HOST: "127.0.0.1", CP_VIEWER_PORT: String((viewer.address() as AddressInfo).port),
				CP_TEST_TIME_SCALE: String(SCALE), CP_TEST_TIME_ZERO: String(zero), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...opts.env },
		});
		let text = "";
		child.stderr.on("data", (chunk) => (text += String(chunk)));
		const code = await new Promise<number | null>((done) => child.once("exit", done));
		clock = Math.round(zero + (Date.now() - zero) * SCALE);
		out.push(text);
		if (code !== 0) throw new Error(text);
		const after = existsSync(join(stateDir, "update.json")) ? readFileSync(join(stateDir, "update.json"), "utf8") : undefined;
		return after === before ? undefined : (JSON.parse(after!) as UpdateState);
	};
	const lines = (file: string) => (existsSync(join(sm, file)) ? readFileSync(join(sm, file), "utf8").split("\n").filter(Boolean) : []);
	const calls = () => lines("calls.log");
	const hostCalls = () => calls().filter((call) => call.startsWith("host "));
	const reset = () => writeFileSync(join(sm, "calls.log"), "");
	const causes = () => lines("causes.log").map((line) => JSON.parse(line) as unknown);
	const state = (value: Partial<UpdateState>) => writeFileSync(join(stateDir, "update.json"), JSON.stringify({ schema_version: 1, fetch_failures: 0, ...value }));
	/** A fleet job whose live worker is the stand-in in run phase `phase`; a live script job for "script". */
	const job = async (jobId: string, phase: string) => {
		const base = { job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: phase === "idle" ? "held" : "waiting", worktree: `/nonexistent/${jobId}`, branch: jobId, dispatched_at: isoTimestamp(), usage: { ...EMPTY_USAGE }, ...(phase === "idle" ? { reported_at: isoTimestamp() } : {}) };
		const record = phase === "script"
			? { ...base, executor: "script", script_path: "scripts/check.sh", script_process: { pid: standin.pid, started_at: isoTimestamp() } }
			: { ...base, worker: { pid: standin.pid, session_id: `s-${jobId}`, session_file: `/nonexistent/${jobId}.jsonl`, profile: "implementer", role: "implementer", model: "m/x", started_at: isoTimestamp() } };
		if (phase !== "script") {
			mkdirSync(join(home, paths.statusFile(jobId), ".."), { recursive: true });
			writeFileSync(join(home, paths.statusFile(jobId)), JSON.stringify({ ...initialStatus(jobId, {}, isoTimestamp()), phase, usage: EMPTY_USAGE }));
		}
		await new FleetStore({ home }).add(record as unknown as FleetRecord);
	};
	return { home, repo, stateDir, dataDir, sm, run, plan, calls, hostCalls, reset, causes, state, job, out, now: () => clock };
}
type Bench = Awaited<ReturnType<typeof bench>>;
/** fleet.json and run status naming `jobId` mid-turn under this (live) process: what a reopened parent dispatched. */
async function busyFleet(t: TestContext, jobId: string) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const statusRel = paths.statusFile(jobId);
	const status = JSON.stringify({ ...initialStatus(jobId, {}, isoTimestamp()), phase: "working", usage: EMPTY_USAGE });
	await new FleetStore({ home: scratch.path }).add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "waiting", worktree: `/nonexistent/${jobId}`, branch: jobId,
		dispatched_at: isoTimestamp(), usage: { ...EMPTY_USAGE }, worker: { pid: process.pid, session_id: "s", session_file: "/s.jsonl", profile: "implementer", role: "implementer", model: "m/x", started_at: isoTimestamp() } } as unknown as FleetRecord);
	return { fleet: readFileSync(join(scratch.path, layoutForHome("multi", scratch.path).state, "fleet.json"), "utf8"), statusRel, status };
}
const last = (b: Bench) => b.out.at(-1) ?? "";

test("P14e-update-forward: ff, npm ci on a lockfile change, reload", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const from = b.repo.head();
	const to = advanceBase(b.repo, "feature.txt", "feature\n");
	const state = await b.run();
	assert.equal(state?.last_result, "updated", last(b));
	assert.deepEqual([b.repo.head(), b.repo.head("origin/main")], [to, to]);
	assert.deepEqual({ from: state?.from, to: state?.to, phase: state?.phase, lock: state?.lock }, { from, to, phase: "idle", lock: false });
	assert.deepEqual(b.calls(), ["host drain [600]", "host stop [{}]", "daemon hold", "daemon reload"], "no npm ci");
	assert.deepEqual(b.causes(), [{ reason: "auto-update", target_sha: to }]);
	b.reset();
	advanceBase(b.repo, "package-lock.json", "{\"v\":2}\n");
	const locked = await b.run();
	assert.deepEqual([locked?.last_result, locked?.lock], ["updated", true], last(b));
	assert.deepEqual(b.calls().filter((call) => !call.startsWith("host")), ["daemon hold", "npm ci", "daemon reload"], "npm ci with the host stopped and the viewer held");
});

test("P14e-update-skips: dirty, ahead, branch, busy and script", { timeout: 300_000 }, async (t) => {
	const skips = [];
	for (const cause of ["dirty", "ahead", "branch", "busy"] as const) {
		const b = await bench(t);
		advanceBase(b.repo, "new.txt", "new\n");
		if (cause === "dirty") b.repo.write("README.md", "edited\n");
		if (cause === "ahead") {
			b.repo.write("local.txt", "local\n");
			b.repo.commitAll("local");
		}
		if (cause === "branch") b.repo.git("checkout", "--quiet", "-b", "feature");
		if (cause === "busy") await b.job("cp-live", "working");
		const head = b.repo.head();
		const state = await b.run();
		skips.push([state?.last_result, state?.phase, b.hostCalls(), b.repo.head() === head]);
	}
	assert.deepEqual(skips, ["dirty", "ahead", "branch", "busy"].map((cause) => [`skipped_${cause}`, "idle", [], true]), "recorded, nothing drained, unmoved");

	const held = await bench(t);
	await held.job("cp-held", "idle");
	const to = advanceBase(held.repo, "held.txt", "held\n");
	assert.equal((await held.run())?.last_result, "updated", last(held));
	assert.deepEqual([held.repo.head(), held.hostCalls()[0]], [to, "host drain [600]"]);

	// A mid-turn fleet: skipped_busy keeping its first since, then drained anyway after 4x interval_min.
	for (const outcome of ["drained", "draining"] as const) {
		const b = await bench(t);
		await b.job("cp-a", "working");
		b.plan({ drainStates: [outcome] });
		const head = b.repo.head();
		const target = advanceBase(b.repo, "busy.txt", "busy\n");
		const first = await b.run();
		assert.match(`${first?.last_result} ${first?.detail}`, /^skipped_busy mid-turn worker\(s\): cp-a/);
		const since = [];
		for (let i = 0; i < 2; i++) since.push((await b.run(20))?.since);
		assert.deepEqual([since, b.hostCalls()], [[first?.since, first?.since], []], "under 4x interval_min: nothing drained");
		const forced = await b.run(20);
		if (outcome === "drained") assert.deepEqual([forced?.last_result, b.repo.head(), b.hostCalls()[0]], ["updated", target, "host drain [600]"], last(b));
		else assert.deepEqual([forced?.last_result, b.hostCalls(), b.repo.head()], ["drain_timeout", ["host drain [600]", "host drainCancel"], head], "nothing stopped");
	}
	const script = await bench(t);
	await script.job("cp-script", "script");
	const head = script.repo.head();
	advanceBase(script.repo, "script.txt", "script\n");
	const scripted = [];
	for (let i = 0; i < 6; i++) scripted.push((await script.run(20))?.detail?.startsWith("live script job(s): cp-script"));
	assert.deepEqual([scripted, script.hostCalls(), script.repo.head()], [[true, true, true, true, true, true], [], head], "a live script is never forced");
});

test("P14e-update-config: config, interval, legacy, fetch and dry run", { timeout: 300_000 }, async (t) => {
	const results = [];
	for (const config of [{ enabled: false }, null, "{\"enabled\": \"yes\"}", { enabled: true, quiet_min: -5 }, { enabled: true, quiet_min: "10" }, { enabled: true, quiet_min: null }, { enabled: true, quiet_min: 3 }]) {
		const b = await bench(t, config);
		const state = await b.run();
		results.push(`${state?.last_result}${/"quiet_min": N >= 0/.test(state?.detail ?? "") ? " quiet_min" : ""}${b.calls().includes("daemon health") ? " health" : ""}`);
	}
	assert.deepEqual(results, ["skipped_disabled", "skipped_disabled", "config_invalid quiet_min health", "config_invalid quiet_min health", "config_invalid quiet_min health", "config_invalid quiet_min health", "up_to_date"], "only a failure asks cp-daemon for its health run");
	const b = await bench(t);
	assert.equal((await b.run())?.last_result, "up_to_date");
	assert.equal(await b.run(5), undefined, "under interval_min: silent, nothing recorded");
	assert.equal((await b.run(15))?.last_result, "up_to_date");
	// Not cp-daemon's job: refused when data/daemon.json exists; a legacy home without it records migration_required.
	const head = b.repo.head();
	advanceBase(b.repo, "n.txt", "n\n");
	b.reset();
	const refused = await b.run(20, { env: { CP_DAEMON_JOB: "", INVOCATION_ID: "legacy" } }).catch((error: Error) => error.message);
	assert.match(String(refused), /refused: cp-update runs from cp-daemon \(it serializes runs\); by hand, use --dry-run/);
	const legacy = await bench(t);
	rmSync(daemonPaths(legacy.home).config);
	legacy.state({ phase: "rolling_back", from: legacy.repo.head(), to: FAR, lock: false });
	const migrate = await legacy.run(20, { env: { CP_DAEMON_JOB: "", INVOCATION_ID: "legacy" } });
	assert.deepEqual([migrate?.last_result, migrate?.phase], ["migration_required", "rolling_back"], "an interrupted phase is kept for cp-daemon's first run");
	assert.match(migrate?.detail ?? "", /rerun cp-install to move it to cp-daemon \(auto-update never reruns it\)/);
	assert.deepEqual(legacy.calls(), ["daemon health"], "no host, git merge or npm: only the watchdog request");
	assert.equal((await legacy.run(20, { env: { CP_DAEMON_JOB: "" } }))?.since, migrate?.since, "one distinct result, one notice key");
	// --dry-run probes, records nothing, drains nothing, needs no CP_DAEMON_JOB.
	await b.run(0, { dry: true, env: { CP_DAEMON_JOB: "" } });
	assert.match(last(b), /dry-run: would drain, then update/);
	assert.deepEqual([b.repo.head(), b.calls()], [head, []]);
	// fetch_failed counts runs in a row; a good fetch resets the count.
	b.repo.git("remote", "set-url", "origin", join(b.repo.path, "missing.git"));
	const failures = [];
	for (let i = 0; i < 3; i++) {
		b.reset();
		const state = await b.run();
		failures.push([state?.last_result, state?.fetch_failures, b.calls()]);
	}
	assert.deepEqual(failures, [["fetch_failed", 1, []], ["fetch_failed", 2, []], ["fetch_failed", 3, ["daemon health"]]], "the watchdog only at the third failure");
	b.repo.git("remote", "set-url", "origin", b.repo.remote!);
	const ok = await b.run();
	assert.deepEqual([ok?.last_result, ok?.fetch_failures], ["updated", 0], last(b));
});

test("P14e-update-rollback: rolled back, sticky, held", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const from = b.repo.head();
	const bad = advanceBase(b.repo, "package-lock.json", "{\"v\":2}\n");
	b.plan({ doctor: ["error:DOCTOR broken", "ok"] });
	const state = await b.run();
	assert.deepEqual([state?.last_result, state?.bad_sha, state?.to, b.repo.head()], ["rolled_back", bad, bad, from], last(b));
	assert.equal(b.repo.git("status", "--porcelain").trim(), "", "reset --keep leaves the checkout clean");
	assert.match(state?.detail ?? "", /DOCTOR broken/);
	assert.equal(b.calls().filter((call) => call === "npm ci").length, 2, "npm ci forward and back");
	assert.deepEqual(b.causes(), [{ reason: "auto-update", target_sha: bad }, { reason: "auto-update", target_sha: from }], "the rollback's drain names from");
	assert.equal(b.calls().at(-1), "daemon health", "the exited run asked cp-daemon for its health run");
	b.reset();
	assert.deepEqual([(await b.run())?.last_result, b.hostCalls()], ["skipped_bad_sha", []], "a rolled-back sha is never retried");
	const fixed = advanceBase(b.repo, "fix.txt", "fix\n");
	assert.deepEqual([(await b.run())?.last_result, b.repo.head()], ["updated", fixed], "a newer commit is taken");

	// Both verifies fail: rollback_failed keeps the prior bad_sha and stays until a human removes state/update.json.
	const s = await bench(t);
	s.state({ phase: "idle", bad_sha: "a".repeat(40) });
	advanceBase(s.repo, "x.txt", "x\n");
	s.plan({ doctor: ["error:doctor error", "error:still broken"] });
	const sticky = await s.run();
	assert.deepEqual([sticky?.last_result, sticky?.bad_sha], ["rollback_failed", "a".repeat(40)], last(s));
	advanceBase(s.repo, "y.txt", "y\n");
	s.reset();
	assert.equal(await s.run(), undefined);
	assert.deepEqual(s.calls(), [], "nothing runs while rollback_failed stands");
	assert.match(last(s), /rollback_failed stays until a human looks: check .*, then remove .*update\.json to resume/);

	// A restarted parent reopened dispatch: the rollback drains first and never stops the fleet under a live worker.
	const r = await bench(t);
	const rFrom = r.repo.head();
	const rBad = advanceBase(r.repo, "bad.txt", "bad\n");
	const fleet = await busyFleet(t, "cp-new");
	r.plan({ drainStates: ["drained", "draining"], doctor: ["error:DOCTOR broken"], onDoctor: { files: [{ path: join(r.stateDir, "fleet.json"), text: fleet.fleet }, { path: join(r.home, fleet.statusRel), text: fleet.status }] } });
	const held = await r.run();
	assert.deepEqual([held?.last_result, held?.phase, held?.held, held?.bad_sha, r.repo.head()], ["rollback_failed", "rolling_back", true, undefined, rBad], last(r));
	assert.equal(r.hostCalls().filter((call) => call === "host stop [{}]").length, 1, "only the forward stop: the rollback stopped nothing");
	assert.deepEqual(r.hostCalls().slice(-2), ["host drain [600]", "host drainCancel"], "the rollback drained, timed out, cancelled");
	r.reset();
	assert.deepEqual([await r.run(30), r.calls()], [undefined, []], "under 4x interval_min: it waits like a drain timeout");
	rmSync(join(r.stateDir, "fleet.json"));
	r.plan({ drainStates: ["drained"] });
	const done = await r.run(31);
	assert.deepEqual([done?.last_result, done?.held, done?.bad_sha, r.repo.head(), r.hostCalls()], ["rolled_back", undefined, rBad, rFrom, ["host drain [600]", "host stop [{}]"]], last(r));

	// No host to drain, yet the fleet names a live worker: held too.
	const c = await bench(t);
	advanceBase(c.repo, "c.txt", "c\n");
	const orphan = await busyFleet(t, "cp-orphan");
	c.plan({ doctor: ["down:gone"], onDoctor: { files: [{ path: join(c.stateDir, "fleet.json"), text: orphan.fleet }], patch: { failing: ["host drain"] } } });
	const left = await c.run();
	assert.deepEqual([left?.last_result, left?.phase], ["rollback_failed", "rolling_back"], last(c));
	assert.match(left?.detail ?? "", /live worker\(s\) cp-orphan/);
});

test("P14e-update-recovery: a run interrupted mid-phase", { timeout: 300_000 }, async (t) => {
	const after = await bench(t);
	const from = after.repo.head();
	const to = advanceBase(after.repo, "a.txt", "a\n");
	after.repo.git("fetch", "--quiet", "origin");
	after.repo.git("merge", "--ff-only", "--quiet", to);
	after.state({ phase: "verifying", from, to, lock: false });
	const rolled = await after.run();
	assert.deepEqual([rolled?.last_result, after.repo.head(), rolled?.bad_sha], ["rolled_back", from, to], last(after));
	assert.deepEqual(after.causes(), [{ reason: "auto-update", target_sha: from }]);

	const before = await bench(t);
	const head = before.repo.head();
	before.state({ phase: "updating", from: head, to: FAR, lock: false });
	const failed = await before.run();
	assert.deepEqual([failed?.last_result, before.repo.head(), before.calls().includes("daemon reload")], ["failed", head, true]);
	assert.match(failed?.detail ?? "", /nothing merged; cp-daemon reloaded/);
	const drain = await bench(t);
	drain.state({ phase: "draining", from: drain.repo.head(), to: FAR, lock: false });
	writeFileSync(join(drain.stateDir, "drain.json"), JSON.stringify({ started_at: isoTimestamp(), state: "draining", jobs: [] }));
	assert.deepEqual([(await drain.run())?.last_result, drain.calls()], ["failed", ["host drainCancel", "daemon health"]], "nothing stopped, the drain withdrawn");

	// Drained, then the updater died before `updating`: cancel refuses drained, so the parent restart clears it.
	const late = await bench(t, { enabled: true, interval_min: 5, quiet_min: 10 });
	const lateHead = late.repo.head();
	advanceBase(late.repo, "late.txt", "late\n");
	late.state({ phase: "draining", from: lateHead, to: FAR, lock: false });
	writeFileSync(join(late.stateDir, "drain.json"), JSON.stringify({ started_at: isoTimestamp(), state: "drained", jobs: [] }));
	const restarted = await late.run(5);
	assert.deepEqual([restarted?.last_result, restarted?.phase, late.calls(), late.repo.head()], ["failed", "idle", ["host stop [{}]", "daemon hold", "daemon reload", "daemon health"], lateHead], "no quiet wait");
	assert.match(restarted?.detail ?? "", /drained parent was restarted, dispatch reopens/);
	// The same window with a host stop that fails: the units still restart, and both errors are reported.
	const stuck = await bench(t);
	const window = () => {
		stuck.state({ phase: "draining", from: stuck.repo.head(), to: FAR, lock: false });
		writeFileSync(join(stuck.stateDir, "drain.json"), JSON.stringify({ started_at: isoTimestamp(), state: "drained", jobs: [] }));
	};
	window();
	stuck.plan({ failing: ["host stop", "daemon reload"] });
	const both = await stuck.run();
	assert.ok(stuck.calls().includes("daemon reload"), "a failed stop never skips the restart");
	assert.match(both?.detail ?? "", /host stop failed: stop refused; cp-daemon reload: refused \(the drain may stay latched/);
	window();
	stuck.reset();
	stuck.plan({ failing: ["host stop"] });
	const once = await stuck.run();
	assert.deepEqual(stuck.calls().slice(0, 2), ["host stop [{}]", "daemon reload"], "stop failed (no hold asked), restart still ran");
	assert.match(once?.detail ?? "", /^a run was interrupted after the fleet drained; nothing merged; host stop failed: stop refused \(the drain may stay latched/);
});

test("P14e-update-drain: timeout, parent control, gone, other errors", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const head = b.repo.head();
	advanceBase(b.repo, "slow.txt", "slow\n");
	b.plan({ drainStates: ["draining", "drained"] });
	const timeout = await b.run();
	assert.deepEqual([timeout?.last_result, b.hostCalls(), b.repo.head()], ["drain_timeout", ["host drain [600]", "host drainCancel"], head], "still draining at 660 s: cancelled, no stop");
	assert.equal(b.calls().at(-1), "daemon health", "the exited run asked cp-daemon for its health run");
	assert.equal(await b.run(30), undefined, "under 4x interval_min after a drain timeout: silent");
	assert.equal((await b.run(31))?.last_result, "updated", last(b));

	for (const message of [PARENT_CONTROL_BUSY, `parent diagnostic /cp-drain failed: ${PARENT_CONTROL_BUSY}`]) {
		const busy = await bench(t);
		const busyHead = busy.repo.head();
		advanceBase(busy.repo, "busy.txt", "busy\n");
		busy.plan({ drainThrow: message });
		const state = await busy.run();
		assert.deepEqual([state?.last_result, state?.phase, busy.hostCalls(), busy.repo.head()], ["skipped_busy", "idle", ["host drain [600]", "host drainCancel"], busyHead], message);
		assert.ok(state?.detail?.includes(PARENT_CONTROL_BUSY) && !busy.calls().some((call) => call.startsWith("daemon ")), "best-effort cancel; nothing held or reloaded");
		busy.plan({});
		assert.equal((await busy.run())?.last_result, "updated", "the next interval retries");
	}
	const others = [];
	for (const message of ["parent diagnostic /cp-drain failed: something else", `${PARENT_CONTROL_BUSY} (and more)`, "parent diagnostic /cp-drain is not registered; reload the command-post parent extension"]) {
		const other = await bench(t);
		advanceBase(other.repo, "other.txt", "other\n");
		other.plan({ drainThrow: message });
		const state = await other.run();
		others.push([state?.last_result, state?.detail === `drain failed: ${message}; nothing was stopped`]);
	}
	assert.deepEqual(others, [["failed", true], ["failed", true], ["failed", true]], "an unrelated error is never swallowed");

	const gone = await bench(t);
	const goneHead = gone.repo.head();
	advanceBase(gone.repo, "gone.txt", "gone\n");
	gone.plan({ drainStates: ["gone"], drainText: `DRAIN: failed: ${PARENT_CONTROL_BUSY}` });
	const lost = await gone.run();
	assert.deepEqual([lost?.last_result, gone.hostCalls(), gone.repo.head()], ["drain_timeout", ["host drain [600]", "host drainCancel"], goneHead]);
	assert.ok(lost?.detail?.includes(`the drain answered: DRAIN: failed: ${PARENT_CONTROL_BUSY}`), lost?.detail);
	gone.plan({});
	assert.equal(await gone.run(30), undefined, "retried like a drain timeout: silent under 4x interval_min");
	assert.equal((await gone.run(31))?.last_result, "updated");
});

test("P14e-update-verify: busy, deferred, down", { timeout: 300_000 }, async (t) => {
	const verify = async (plan: Plan) => {
		const b = await bench(t);
		const from = b.repo.head();
		const to = advanceBase(b.repo, "v.txt", "v\n");
		b.plan(plan);
		const started = b.now() + 20 * 60_000;
		const state = await b.run();
		return { state, b, elapsed: b.now() - started, moved: b.repo.head() === to ? "to" : b.repo.head() === from ? "from" : "?" };
	};
	// Unsettled past 120 s, then a passing doctor: healthy, no note.
	const late = await verify({ doctor: [...Array(70).fill("unsettled"), "ok"] });
	assert.deepEqual([late.state?.last_result, late.moved, /deferred/.test(late.state?.detail ?? "")], ["updated", "to", false], last(late.b));
	assert.ok(late.elapsed > 120_000, `verified past the base 120 s: ${late.elapsed}`);
	// Busy for the whole window (unsettled, or a doctor queued behind a live parent): accepted with the deferred note.
	for (const doctor of ["unsettled", "hang"]) {
		const busy = await verify({ doctor: [doctor] });
		assert.deepEqual([busy.state?.last_result, busy.moved], ["updated", "to"], last(busy.b));
		assert.match(busy.state?.detail ?? "", /; doctor deferred: parent busy 420s$/);
	}
	// The rollback verify deferred is not a failure: rolled_back, bad_sha stamped, the note in the detail.
	const back = await verify({ doctor: ["error:DOCTOR broken", "unsettled"] });
	assert.deepEqual([back.state?.last_result, back.moved, back.state?.bad_sha === back.state?.to], ["rolled_back", "from", true], last(back.b));
	assert.match(back.state?.detail ?? "", /; doctor deferred: parent busy 420s$/);
	// Busy with the viewer down, an absent parent, busy then down: not healthy within the base 120 s, then rolled back.
	const failures = [];
	for (const [plan, why] of ([[{ doctor: ["unsettled"], viewerDown: true }, "viewer: .* answered 503"], [{ doctor: ["down:parent is not running; call cp_parent start"] }, "parent is not running"],
		[{ doctor: [...Array(5).fill("unsettled"), "down:parent is not running; call cp_parent start"] }, "parent is not running"],
		[{ doctor: [`down:${PARENT_UNSETTLED} (x)`] }, "parent must .*send \\(x\\)"], [{ doctor: ["hang"], statusPid: 1 }, "doctor"], [{ doctor: ["hang"], statusPid: 0 }, "doctor"],
		[{ doctor: [...Array(120).fill("unsettled"), "viewerdown", "unsettled"] }, "viewer: .* answered 503"]] satisfies Array<[Plan, string]>)) {
		const run = await verify(plan);
		failures.push([run.state?.last_result, new RegExp(`not healthy within 120s: ${why}`).test(run.state?.detail ?? "")]);
	}
	assert.deepEqual(failures, Array(7).fill(["rollback_failed", true]), "the rollback's verify fails alike");
});

test("P14e-update-quiet: the quiet period", { timeout: 300_000 }, async (t) => {
	const b = await bench(t, { enabled: true, interval_min: 5, quiet_min: 10 });
	const first = advanceBase(b.repo, "a.txt", "a\n");
	const head = b.repo.head();
	const a = await b.run(5);
	assert.deepEqual([a?.last_result, a?.first_seen_sha, a?.first_seen_at], ["skipped_settling", first, a?.last_run_at]);
	assert.match(a?.detail ?? "", new RegExp(`origin/main ${first.slice(0, 12)} first seen ${a?.first_seen_at}; waiting for 10 min.*eligible `));
	assert.equal((await b.run(5))?.first_seen_at, a?.first_seen_at, "the same tip keeps its first-seen clock");
	const second = advanceBase(b.repo, "b.txt", "b\n");
	const moved = await b.run(5);
	assert.deepEqual([moved?.last_result, moved?.first_seen_sha, moved?.first_seen_at], ["skipped_settling", second, moved?.last_run_at], "a merge restarts the clock");
	assert.equal((await b.run(5))?.last_result, "skipped_settling", "5 of 10 quiet minutes");
	assert.deepEqual([b.repo.head(), b.hostCalls()], [head, []], "nothing drained while settling");
	assert.deepEqual([(await b.run(5))?.last_result, b.repo.head(), b.causes()], ["updated", second, [{ reason: "auto-update", target_sha: second }]], last(b));

	const zero = await bench(t, { enabled: true, interval_min: 5, quiet_min: 0 });
	advanceBase(zero.repo, "z.txt", "z\n");
	const state = await zero.run(5);
	assert.deepEqual([state?.last_result, state?.first_seen_sha], ["updated", undefined]);
	const absent = await bench(t, { enabled: true, interval_min: 5 });
	advanceBase(absent.repo, "d.txt", "d\n");
	const settled = [];
	for (let i = 0; i < 3; i++) settled.push((await absent.run(5))?.last_result);
	assert.deepEqual(settled, ["skipped_settling", "skipped_settling", "updated"], "10 minutes after first seen");
	// A rollback is never held by the quiet period.
	const r = await bench(t, { enabled: true, interval_min: 5, quiet_min: 10 });
	const from = r.repo.head();
	const to = advanceBase(r.repo, "r.txt", "r\n");
	r.repo.git("fetch", "--quiet", "origin");
	r.repo.git("merge", "--ff-only", "--quiet", to);
	r.state({ phase: "verifying", from, to, lock: false });
	assert.deepEqual([(await r.run(5))?.last_result, r.repo.head()], ["rolled_back", from]);
});
