/**
 * cp-daemon v1 P3: the health watchdog (src/service/health.ts) and its /doctor line. Probes are fakes or run
 * against a scratch home; no unit is started, nothing is installed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { initPush } from "../src/push/keys.ts";
import type { PushFetch } from "../src/push/webpush.ts";
import { directPush, HEALTH_CHECKS, type HealthCheck, type HealthProbes, healthFile, hostProbes, type Observation, readHealth, runHealth } from "../src/service/health.ts";
import { validateDoctorReport } from "../src/contracts.ts";
import { legacyManagedHome } from "../src/home.ts";
import { serviceFindings } from "../src/service/status.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import { HEALTH_TIMER, HEALTH_UNIT, installTargets, OPERATOR_UNIT, PARENT_UNIT, UPDATE_TIMER, UPDATE_UNIT, VIEW_UNIT } from "../src/service/units.ts";
import { updateStateFile } from "../src/service/update.ts";
import { operatorWrapperPath } from "../src/viewer/launchers.ts";
import { pushDeliveriesFile, subscriptionFile, subscriptionId } from "../src/viewer/push-files.ts";
import { createScratchHome } from "./harness/index.ts";
import { testDevice } from "./harness/push.ts";

const OK: Observation = { ok: true };
const allOk = (): Record<HealthCheck, Observation> => Object.fromEntries(HEALTH_CHECKS.map((name) => [name, OK])) as Record<HealthCheck, Observation>;

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	let seen = allOk();
	let clock = Date.parse("2026-09-28T10:00:00Z");
	const pushed: Array<{ kind: string; headline: string }> = [];
	let deliver = true;
	const lines: string[] = [];
	const probes = Object.fromEntries(HEALTH_CHECKS.map((name) => [name, () => seen[name]])) as unknown as HealthProbes;
	const run = async (next: Partial<Record<HealthCheck, Observation>> = {}) => {
		seen = { ...allOk(), ...next };
		clock += 5 * 60_000;
		return runHealth({ stateDir, probes, now: () => new Date(clock), log: (line) => lines.push(line), push: async (payload) => {
			pushed.push(JSON.parse(payload));
			return deliver ? { ok: true, reason: "1/1 device(s)" } : { ok: false, reason: "HTTP 503" };
		} });
	};
	return { home: home.path, stateDir, run, pushed, lines, failPushes: (value: boolean) => { deliver = !value; } };
}

test("one push per transition: ok→fail once, staying failed nothing, fail→ok once as recovered", async (t) => {
	const b = bench(t);
	await b.run();
	assert.equal(b.pushed.length, 0, "a healthy first run pushes nothing");
	const low: Observation = { ok: false, key: "low", detail: "3.1 GiB free (4 %) under /h" };
	await b.run({ disk: low });
	assert.deepEqual(b.pushed, [{ project: "command-post", kind: "health: disk low", headline: "3.1 GiB free (4 %) under /h" }]);
	await b.run({ disk: low });
	await b.run({ disk: low });
	assert.equal(b.pushed.length, 1, "still failing: nothing more");
	await b.run();
	assert.deepEqual(b.pushed.at(-1), { project: "command-post", kind: "health: disk recovered", headline: "disk ok again" });
	await b.run();
	assert.equal(b.pushed.length, 2);
	const record = readHealth(b.stateDir)!;
	assert.equal(record.schema_version, 1);
	assert.deepEqual({ status: record.checks.disk!.status, notified_state: record.checks.disk!.notified_state, notified_key: record.checks.disk!.notified_key }, { status: "ok", notified_state: "ok", notified_key: null });
});

test("parent and viewer count only after 2 consecutive failures; a skipped run (mid-update) changes nothing", async (t) => {
	const b = bench(t);
	const down: Observation = { ok: false, key: "down", detail: "no parent host is running" };
	await b.run({ parent: down });
	assert.equal(b.pushed.length, 0, "one failed run is a blip");
	assert.equal(readHealth(b.stateDir)!.checks.parent!.status, "ok");
	await b.run({ parent: { skip: "update phase draining" } });
	await b.run({ parent: down });
	assert.deepEqual(b.pushed.map((p) => p.kind), ["health: parent down"], "the skip neither reset nor counted");
	await b.run({ viewer: { ok: false, key: "down", detail: "x" } });
	await b.run();
	assert.deepEqual(b.pushed.map((p) => p.kind), ["health: parent down", "health: parent recovered"], "a viewer blip that recovered never pushed");
});

test("hostProbes on a scratch home: no host is parent down; mid-update suppresses parent and viewer; each distinct update failure pushes once, recovered once", async (t) => {
	const b = bench(t);
	const probes = hostProbes({ home: b.home, run: () => ({ status: 0, stdout: "ActiveState=active\nResult=success\n" }), fetch: async () => { throw new Error("refused"); }, env: { CP_VIEWER_HOST: "127.0.0.1", CP_VIEWER_PORT: "9" } });
	assert.deepEqual(await probes.parent(undefined), { ok: false, key: "down", detail: "no parent host is running" });
	assert.match(JSON.stringify(await probes.viewer(undefined)), /did not answer: refused/);
	const updateFile = join(b.stateDir, "update.json");
	writeFileSync(updateFile, JSON.stringify({ phase: "draining" }));
	assert.deepEqual(await probes.parent(undefined), { skip: "update phase draining" });
	assert.deepEqual(await probes.viewer(undefined), { skip: "update phase draining" });
	assert.deepEqual(await probes.supervisor(undefined), { skip: "no cp-daemon runtime record (state/daemon-runtime.json)" }, "no cp-daemon: nothing to watch");
	const runtime = daemonPaths(b.home).runtime;
	mkdirSync(daemonPaths(b.home).stateDir, { recursive: true });
	writeFileSync(runtime, JSON.stringify({ units: { parent: { state: "restarting" } } }));
	assert.deepEqual(await probes.supervisor(undefined), { ok: true }, "a restart is not a crash loop");
	// A rollback live workers held back (cp-update's `held`) has no run in flight: parent and viewer stay watched.
	writeFileSync(updateFile, JSON.stringify({ phase: "rolling_back", last_result: "rollback_failed", held: true }));
	assert.deepEqual(await probes.parent(undefined), { ok: false, key: "down", detail: "no parent host is running" });
	assert.match(JSON.stringify(await probes.viewer(undefined)), /did not answer: refused/);
	writeFileSync(updateFile, JSON.stringify({ phase: "rolling_back", last_result: "rollback_failed" }));
	assert.deepEqual(await probes.parent(undefined), { skip: "update phase rolling_back" }, "a rollback run in flight still suppresses");
	writeFileSync(runtime, JSON.stringify({ units: { parent: { state: "failed", result: "start-limit-hit" } } }));
	const looping = await probes.supervisor(undefined) as { key: string; detail: string };
	assert.equal(looping.key, "start-limit-hit");
	assert.match(looping.detail, /cp-daemon's parent supervisor is failed \(start-limit-hit\); cp-daemon log/);
	// gh: an invalid inactive account makes plain `gh auth status` exit 1; only the active account counts.
	const gh = (answers: Record<string, number>) => hostProbes({ home: b.home, run: (command, args) => ({ status: command === "gh" ? answers[args.join(" ")] ?? 1 : 0, stdout: "" }) }).gh(undefined);
	assert.deepEqual(await gh({ "auth status --hostname github.com": 1, "auth status": 1, "auth status --active": 0 }), { ok: true }, "stale inactive account, valid active one: ok");
	assert.deepEqual(await gh({ "api user --jq .login": 0 }), { ok: true }, "a gh without --active falls back to gh api user");
	assert.equal((await gh({}) as { ok: boolean }).ok, false, "no active login: fail");

	const update = async (value: Record<string, unknown>) => {
		writeFileSync(updateFile, JSON.stringify({ phase: "idle", ...value }));
		await b.run({ update: await probes.update(undefined) });
	};
	await update({ last_result: "failed", to: "aaaa" });
	await update({ last_result: "failed", to: "aaaa" });
	await update({ last_result: "drain_timeout", to: "aaaa" });
	await update({ last_result: "rolled_back", to: "bbbb" });
	await update({ last_result: "skipped_busy", to: "bbbb" });
	await update({ last_result: "fetch_failed", fetch_failures: 2 });
	assert.deepEqual(b.pushed.map((p) => p.kind), ["health: update failed", "health: update failed", "health: update failed"], "failed, drain_timeout, rolled_back: each once; a skip or two fetch failures add nothing");
	await update({ last_result: "up_to_date" });
	assert.equal(b.pushed.at(-1)!.kind, "health: update recovered");
	await update({ last_result: "fetch_failed", fetch_failures: 3 });
	assert.equal(b.pushed.at(-1)!.kind, "health: update failed", "the third fetch failure in a row pushes");
	assert.equal(b.pushed.length, 5);
});

test("a push that fails is retried on the next 3 runs, then logged and given up", async (t) => {
	const b = bench(t);
	b.failPushes(true);
	const broken: Observation = { ok: false, key: "failed", detail: "gh auth status fails" };
	for (let run = 0; run < 6; run++) await b.run({ gh: broken });
	assert.equal(b.pushed.length, 4, "the first try and 3 retries");
	assert.ok(b.lines.some((line) => /gh: push fail given up after 4 attempts/.test(line)), b.lines.join("\n"));
	assert.equal(readHealth(b.stateDir)!.checks.gh!.notified_key, "failed");
});

test("directPush sends to subscribed devices and never writes the push ledger or deletes a subscription, even on 410", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const dataDir = join(home.path, LAYOUT.data);
	mkdirSync(stateDir, { recursive: true });
	assert.deepEqual(await directPush(dataDir)("{}"), { ok: false, reason: "push is not set up (no data/push/config.json)" });
	initPush({ dataDir, origin: "https://cp.example.com" });
	const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
	const device = testDevice(endpoint);
	const id = subscriptionId(endpoint);
	mkdirSync(join(dataDir, "push", "subscriptions"), { recursive: true });
	writeFileSync(subscriptionFile(dataDir, id), JSON.stringify({ schema_version: 1, id, endpoint, keys: device.keys, created_at: "2026-09-27T00:00:00Z" }));
	let status = 201;
	const bodies: Buffer[] = [];
	const fetch: PushFetch = async (_url, init) => { bodies.push(Buffer.from(init.body)); return { status, text: async () => "" }; };
	const payload = JSON.stringify({ project: "command-post", kind: "health: disk low", headline: "x" });
	assert.equal((await directPush(dataDir, fetch)(payload)).ok, true);
	assert.equal(device.decrypt(bodies[0]!), payload);
	status = 410;
	assert.equal((await directPush(dataDir, fetch)(payload)).ok, false);
	assert.ok(existsSync(subscriptionFile(dataDir, id)), "a gone device is the sweep's to delete, never the watchdog's");
	assert.equal(existsSync(pushDeliveriesFile(stateDir)), false, "the ledger is the parent sweep's alone");
	assert.deepEqual(readdirSync(stateDir), [], "directPush writes nothing");
});

test("doctor: leftover legacy units warn (service.legacy_units, never an error); service.health reports the last run, what fails, and a stale watchdog", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	const env = { HOME: join(home.path, "user") };
	const { unitDir } = installTargets(env);
	mkdirSync(unitDir, { recursive: true });
	for (const name of [PARENT_UNIT, VIEW_UNIT, HEALTH_UNIT, HEALTH_TIMER, OPERATOR_UNIT]) writeFileSync(join(unitDir, name), `ExecStart="${process.execPath}" x\n`);
	const run = () => ({ status: 0, stdout: "", stderr: "" });
	const now = Date.parse("2026-09-28T10:10:00Z");
	const find = (check: string) => serviceFindings(run, home.path, env, stateDir, now).find((finding) => finding.check === check);
	assert.equal(find("service.legacy_units")!.severity, "warn");
	assert.equal(find("service.legacy_units")!.what, `4 legacy unit(s) in ${unitDir}`, "a short summary");
	assert.equal(find("service.legacy_units")!.detail, `${PARENT_UNIT}, ${VIEW_UNIT}, ${HEALTH_UNIT}, ${HEALTH_TIMER}`, "the list is in detail");
	assert.match(String(find("service.legacy_units")!.fix), /rerun cp-install/);
	assert.equal(find("service.daemon"), undefined, "no data/daemon.json: no daemon line");
	assert.equal(find("service.node")!.severity, "ok");
	assert.equal(find("service.health")!.severity, "warn", "timer installed, never ran");
	writeFileSync(healthFile(stateDir), JSON.stringify({ schema_version: 1, last_run_at: "2026-09-28T10:05:00Z", checks: {} }));
	assert.deepEqual(find("service.health"), { check: "service.health", severity: "ok", what: "health last ran 5 min ago: all ok" });
	writeFileSync(healthFile(stateDir), JSON.stringify({ schema_version: 1, last_run_at: "2026-09-28T10:05:00Z", checks: { disk: { status: "fail", detail: "3 GiB free" } } }));
	assert.match(find("service.health")!.what, /failing: disk \(3 GiB free\)/);
	writeFileSync(healthFile(stateDir), JSON.stringify({ schema_version: 1, last_run_at: "2026-09-28T09:00:00Z", checks: {} }));
	assert.match(String(find("service.health")!.fix), /not running every 5 min: cp-daemon status/);
	assert.equal(serviceFindings(run, home.path, { HOME: join(home.path, "nobody") }, join(home.path, "empty"), now).find((finding) => finding.check === "service.health"), undefined, "nothing installed, never ran: no line");
});

test("doctor: service.launchers says tmux (cp-daemon installed, tmux on PATH, the wrapper), herdr binary and herdr server yes/no; herdr is probed only when on PATH", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const bin = join(home.path, "bin");
	mkdirSync(bin, { recursive: true });
	const env = { HOME: join(home.path, "user"), PATH: bin };
	const { unitDir } = installTargets(env);
	mkdirSync(unitDir, { recursive: true });
	writeFileSync(join(unitDir, PARENT_UNIT), `ExecStart="${process.execPath}" x\n`);
	const calls: string[] = [];
	let server = "{\"running\":true}";
	const run = (command: string, args: readonly string[]) => { calls.push([command, ...args].join(" ")); return { status: 0, stdout: command.endsWith("herdr") ? server : "", stderr: "" }; };
	const what = () => serviceFindings(run, home.path, env).find((finding) => finding.check === "service.launchers")?.what;
	assert.equal(what(), "tmux no, herdr binary no, herdr server running no");
	assert.ok(!calls.some((call) => call.includes("herdr")), "no herdr on PATH: never run");
	writeFileSync(join(bin, "tmux"), "");
	mkdirSync(dirname(operatorWrapperPath(env)), { recursive: true });
	writeFileSync(operatorWrapperPath(env), "#!/bin/sh\n");
	writeFileSync(join(unitDir, OPERATOR_UNIT), `ExecStart="${process.execPath}" x\n`);
	assert.equal(what(), "tmux no, herdr binary no, herdr server running no", "tmux and the wrapper, but no cp-daemon (a cp-operator.service is no launcher now): no");
	mkdirSync(dirname(daemonPaths(home.path).config), { recursive: true });
	writeFileSync(daemonPaths(home.path).config, "{}");
	writeFileSync(join(bin, "herdr"), "");
	assert.equal(what(), "tmux yes, herdr binary yes, herdr server running yes");
	assert.ok(calls.includes(`${join(bin, "herdr")} status server --json`), "the absolute herdr, fixed argv");
	server = "{\"running\":false}";
	assert.equal(what(), "tmux yes, herdr binary yes, herdr server running no");
	rmSync(operatorWrapperPath(env));
	assert.match(String(what()), /^tmux no,/, "no wrapper: no tmux");
});

test("doctor: service.launchers resolves tmux on the viewer PATH from data/daemon.json, not the caller PATH", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const callerBin = join(home.path, "caller");
	const viewerBin = join(home.path, "viewer");
	for (const dir of [callerBin, viewerBin]) mkdirSync(dir, { recursive: true });
	const env = { HOME: join(home.path, "user"), PATH: callerBin };
	mkdirSync(dirname(operatorWrapperPath(env)), { recursive: true });
	writeFileSync(operatorWrapperPath(env), "#!/bin/sh\n");
	mkdirSync(dirname(daemonPaths(home.path).config), { recursive: true });
	const config = { schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app: home.path, home: home.path, path: viewerBin, port: 4000 };
	writeFileSync(daemonPaths(home.path).config, JSON.stringify(config));
	const run = () => ({ status: 0, stdout: "", stderr: "" });
	const what = () => serviceFindings(run, home.path, env).find((finding) => finding.check === "service.launchers")?.what;
	writeFileSync(join(callerBin, "tmux"), "");
	assert.match(String(what()), /^tmux no,/, "tmux only on the caller PATH: the viewer cannot launch it");
	writeFileSync(join(viewerBin, "tmux"), "");
	rmSync(join(callerBin, "tmux"));
	assert.match(String(what()), /^tmux yes,/, "tmux only on the viewer PATH: yes");
});

test("doctor: every service finding, fed maximal inputs (long paths, all 7 units failed, long errors), passes the doctor report schema", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const deep = join(home.path, ...Array.from({ length: 6 }, (_, i) => `${"d".repeat(60)}${i}`));
	const stateDir = join(deep, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	const env = { HOME: join(deep, "user"), PI_HOME: join(deep, "pi") };
	mkdirSync(join(legacyManagedHome(env), ".pi-command-post"), { recursive: true });
	const { unitDir } = installTargets(env);
	mkdirSync(unitDir, { recursive: true });
	const units = [PARENT_UNIT, VIEW_UNIT, HEALTH_UNIT, HEALTH_TIMER, UPDATE_UNIT, UPDATE_TIMER, OPERATOR_UNIT];
	for (const name of units) writeFileSync(join(unitDir, name), `ExecStart="${join(deep, "gone", "node")}" x\n`);
	const paths = daemonPaths(deep);
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.stateDir, { recursive: true });
	const config = JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "systemd", node: join(deep, "gone", "node"), app: deep, home: deep, path: "/bin", port: 7300 });
	writeFileSync(paths.runtime, JSON.stringify({ units: { parent: { state: "failed", result: "start-limit-hit" }, viewer: { state: "failed" } } }));
	const now = Date.parse("2026-09-28T10:10:00Z");
	const long = "x".repeat(300);
	writeFileSync(healthFile(stateDir), JSON.stringify({ schema_version: 1, last_run_at: "2026-09-28T09:00:00Z", checks: Object.fromEntries(HEALTH_CHECKS.map((name) => [name, { status: "fail", detail: long }])) }));
	const updates: unknown[] = [
		{ schema_version: 1, phase: "rolling_back", last_result: "rollback_failed", last_run_at: "2026-09-28T09:00:00Z", to: "a".repeat(40), detail: long },
		{ schema_version: 1, phase: "idle", last_result: "rollback_failed", detail: long },
		{ schema_version: 1, phase: "idle", last_result: "failed", to: "b".repeat(40), detail: long },
		{ schema_version: 1, phase: "idle", last_result: "skipped_busy", since: "2026-09-20T00:00:00Z", behind: 99, detail: long },
		"{not json",
	];
	const seen = new Set<string>();
	for (const run of [() => ({ status: 0, stdout: "active", stderr: "" }), () => ({ status: 1, stdout: "", stderr: "no user manager" })]) {
		for (const daemon of [false, true]) {
			if (daemon) writeFileSync(paths.config, config);
			for (const update of updates) {
				writeFileSync(updateStateFile(stateDir), typeof update === "string" ? update : JSON.stringify(update));
				const findings = serviceFindings(run, deep, env, stateDir, now);
				for (const finding of findings) seen.add(finding.check);
				const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
				const result = validateDoctorReport({ schema_version: 1, generated_at: "2026-09-28T10:10:00Z", home: home.path, package_root: home.path, counts: { ok: count("ok"), warn: count("warn"), error: count("error") }, ok: count("error") === 0, findings });
				assert.ok(result.ok, `${JSON.stringify(update).slice(0, 80)}: ${result.ok ? "" : result.errors.join("; ")}`);
			}
			rmSync(paths.config, { force: true });
		}
	}
	assert.deepEqual([...seen].sort(), ["service.daemon", "service.health", "service.launchers", "service.legacy_home", "service.legacy_units", "service.node", "service.update"], "every service check was exercised");
});
