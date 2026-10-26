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
import { advanceBase, createScratchRepo } from "../harness/scratch-repo.ts";

const SCALE = 50;
const T0 = Date.parse("2026-09-28T10:00:00Z");
const FAR = "f".repeat(40);

/** The parent host and cp-daemon's control socket: `host <op> <args>` / `daemon <op>` to calls.log, answers from plan.json. */
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
  if (m.op === "status") return { ok: true, result: { alive: true, pid: process.pid } };
  if (m.op === "drain") { if (p.drainThrow) throw new Error(p.drainThrow); const state = next(p, "drainStates") ?? "drained";
    if (state !== "gone") fs.writeFileSync(e.DRAIN, JSON.stringify({ started_at: new Date().toISOString(), state, jobs: [] }));
    return { ok: true, result: { text: p.drainText ?? "DRAIN: drain", level: "info" } }; }
  if (m.op === "drainCancel") { fs.rmSync(e.DRAIN, { force: true }); return { ok: true, result: { text: "cancelled" } }; }
  if (m.op === "doctor") { const answer = next(p, "doctor") ?? "ok"; if (p.onDoctor) { const { files = [], patch = {} } = p.onDoctor;
      for (const f of files) fs.writeFileSync(f.path, f.text); save({ ...plan(), onDoctor: undefined, ...patch }); }
    if (answer === "hang") return undefined; if (answer === "unsettled") throw new Error(e.UNSETTLED);
    if (answer.startsWith("down:")) throw new Error(answer.slice(5));
    return { ok: true, result: answer.startsWith("error:") ? { level: "error", text: answer.slice(6) } : { level: "info", text: "DOCTOR ok" } }; }
  return { ok: true, result: {} }; });
serve(e.DAEMON_SOCK, (m) => { log("daemon " + m.op); return (plan().failing ?? []).includes("daemon " + m.op) ? { ok: false, error: "refused" } : { ok: true }; });
fs.writeFileSync(e.SM + "/ready", "");
`;

type Plan = { drainStates?: string[]; drainThrow?: string; drainText?: string; doctor?: string[]; failing?: string[]; viewerDown?: boolean; onDoctor?: { files?: Array<{ path: string; text: string }>; patch?: Plan } };

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
	while (!existsSync(join(sm, "ready"))) await new Promise((done) => setTimeout(done, 20));
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
	// shortcut: the failure's `daemon health` is not awaited and the oneshot exits first, so it is filtered out here.
	const calls = () => lines("calls.log").filter((call) => call !== "daemon health");
	const hostCalls = () => calls().filter((call) => call.startsWith("host "));
	const reset = () => writeFileSync(join(sm, "calls.log"), "");
	const causes = () => lines("causes.log").map((line) => JSON.parse(line) as unknown);
	const state = (value: Partial<UpdateState>) => writeFileSync(join(stateDir, "update.json"), JSON.stringify({ schema_version: 1, fetch_failures: 0, ...value }));
	/** A fleet job whose worker is the stand-in (alive) with run phase `phase`, or a live script job when `phase` is "script". */
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

test("P14e-update-forward: ff to origin/main, npm ci only on a lockfile change, cp-daemon reloaded → updated; the drain names the target", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const from = b.repo.head();
	const to = advanceBase(b.repo, "feature.txt", "feature\n");
	const state = await b.run();
	assert.equal(state?.last_result, "updated", last(b));
	assert.deepEqual([b.repo.head(), b.repo.head("origin/main")], [to, to]);
	assert.deepEqual({ from: state?.from, to: state?.to, phase: state?.phase, lock: state?.lock }, { from, to, phase: "idle", lock: false });
	assert.deepEqual(b.calls(), ["host drain [600]", "host stop [{}]", "daemon hold", "daemon reload"], "no npm ci, no watchdog");
	assert.deepEqual(b.causes(), [{ reason: "auto-update", target_sha: to }]);
	b.reset();
	advanceBase(b.repo, "package-lock.json", "{\"v\":2}\n");
	const locked = await b.run();
	assert.deepEqual([locked?.last_result, locked?.lock], ["updated", true], last(b));
	assert.deepEqual(b.calls().filter((call) => !call.startsWith("host")), ["daemon hold", "npm ci", "daemon reload"], "npm ci with the host stopped and the viewer held");
});

test("P14e-update-skips: dirty, ahead, branch, busy and script skips move nothing; an idle held worker does not block; 4x busy drains anyway", { timeout: 300_000 }, async (t) => {
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

test("P14e-update-config: off, absent and invalid config, the interval, a legacy service, fetch failures and a dry run", { timeout: 300_000 }, async (t) => {
	const results = [];
	for (const config of [{ enabled: false }, null, "{\"enabled\": \"yes\"}", { enabled: true, quiet_min: -5 }]) {
		const b = await bench(t, config);
		results.push((await b.run())?.last_result);
	}
	assert.deepEqual(results, ["skipped_disabled", "skipped_disabled", "config_invalid", "config_invalid"]);
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
	assert.deepEqual(legacy.calls(), [], "no host, git merge or npm");
	assert.equal((await legacy.run(20, { env: { CP_DAEMON_JOB: "" } }))?.since, migrate?.since, "one distinct result, one notice key");
	// --dry-run probes, records nothing, drains nothing, needs no CP_DAEMON_JOB.
	await b.run(0, { dry: true, env: { CP_DAEMON_JOB: "" } });
	assert.match(last(b), /dry-run: would drain, then update/);
	assert.deepEqual([b.repo.head(), b.calls()], [head, []]);
	// fetch_failed counts runs in a row; the watchdog runs at the third; a good fetch resets the count.
	b.repo.git("remote", "set-url", "origin", join(b.repo.path, "missing.git"));
	const failures = [];
	for (let i = 0; i < 3; i++) {
		b.reset();
		const state = await b.run();
		failures.push([state?.last_result, state?.fetch_failures]);
	}
	assert.deepEqual(failures, [["fetch_failed", 1], ["fetch_failed", 2], ["fetch_failed", 3]]);
	b.repo.git("remote", "set-url", "origin", b.repo.remote!);
	const ok = await b.run();
	assert.deepEqual([ok?.last_result, ok?.fetch_failures], ["updated", 0], last(b));
});

test("P14e-update-rollback: a doctor error rolls back to from and never retries the sha; a failed rollback is sticky and keeps the prior bad_sha", { timeout: 300_000 }, async (t) => {
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
