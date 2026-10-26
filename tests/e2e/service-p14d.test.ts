/**
 * Behavior 15 (P14d): cp-daemon's health oneshot as cp-daemon runs it — `node src/service/health.ts` on a scratch home,
 * with stub git, gh, pi and npm as its only PATH and its clock set per run by the time-scale preload (nearly frozen).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { layoutForHome } from "../../src/contracts.ts";
import type { BridgeRelay } from "../../src/cp-bridge.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { OperatorRelayAcks, OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { initPush } from "../../src/push/keys.ts";
import { atomicWrite, daemonPaths } from "../../src/service/daemon-files.ts";
import { tunnelConfigFile } from "../../src/service/daemon-tunnel-files.ts";
import { type HealthRecord, readHealth } from "../../src/service/health.ts";
import { startDeviceControl } from "../../src/viewer/device-control.ts";
import type { DeviceRoutes } from "../../src/viewer/devices-api.ts";
import { pushDeliveriesFile, subscriptionFile, subscriptionId } from "../../src/viewer/push-files.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { testDevice } from "../harness/push.ts";

const SCALE = 0.001;
const T0 = Date.parse("2026-09-28T10:00:00Z");
const MIN = 60_000;

/** A scratch home for the health oneshot; each stub answers from answers/<tool> <args>.out|.status, else <tool>.out. */
function healthHome(t: TestContext) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const stateDir = join(home, layoutForHome("multi", home).state);
	const bin = join(home, "bin");
	const answers = join(home, "answers");
	mkdirSync(bin);
	mkdirSync(answers);
	mkdirSync(stateDir, { recursive: true });
	for (const tool of ["git", "gh", "pi", "npm"]) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${home}/calls.log"\nf="${answers}/${tool} $*"\n[ -f "$f.out" ] || [ -f "$f.status" ] || f="${answers}/${tool}"
[ -f "$f.out" ] && /bin/cat "$f.out"\nexit "$(/bin/cat "$f.status" 2>/dev/null || echo 0)"\n`, { mode: 0o755 });
	}
	const answer = (name: string, text: string) => writeFileSync(join(answers, name), text);
	answer("pi.out", "pi 1.4.0\n");
	answer("gh.out", "[]\n");
	/** One health run whose clock reads `at` (ms); its stderr and the record it wrote. */
	const run = async (at: number, env: Record<string, string> = {}) => {
		const zero = Math.round((at - Date.now() * SCALE) / (1 - SCALE));
		const child = spawn(process.execPath, ["--import", join(REPO_ROOT, "tests/harness/time-scale.ts"), join(REPO_ROOT, "src/service/health.ts")], {
			env: { HOME: join(home, "user"), PATH: bin, CP_HOME: home, CP_TEST_TIME_SCALE: String(SCALE), CP_TEST_TIME_ZERO: String(zero), ...env },
		});
		let out = "";
		child.stderr.on("data", (chunk) => (out += String(chunk)));
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 0, out);
		return { out, record: readHealth(stateDir) as HealthRecord };
	};
	const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n") : []);
	return { home, stateDir, answer, run, calls };
}

/** One check's `status key` after a run: the dashboard's view of it. */
const state = (record: HealthRecord, name: keyof HealthRecord["checks"]) => {
	const check = record.checks[name];
	return check ? `${check.status}${check.key ? ` ${check.key}` : ""}` : "none";
};

/** A listener that answers /api/identity for `home`, as the viewer does; a closed port when `home` is undefined. */
async function identity(t: TestContext, home?: string): Promise<string> {
	const server = createServer((_req, res) => res.end(JSON.stringify({ home })));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = String((server.address() as AddressInfo).port);
	if (home === undefined) await new Promise((resolve) => server.close(resolve));
	else t.after(() => server.close());
	return port;
}

test("P14-health: the health oneshot records each check's failure and recovery, counts parent and viewer after two, and keys update failures", { timeout: 300_000 }, async (t) => {
	const h = healthHome(t);
	const down = await identity(t);
	const p = healthHome(t);
	const up = await identity(t, p.home);
	const viewer = (port: string) => ({ CP_VIEWER_HOST: "127.0.0.1", CP_VIEWER_PORT: port });
	// Push is set up with a device subscribed: the watchdog still never pushes.
	const dataDir = join(h.home, layoutForHome("multi", h.home).data);
	initPush({ dataDir, origin: "https://cp.example.com" });
	const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
	const id = subscriptionId(endpoint);
	mkdirSync(join(dataDir, "push", "subscriptions"), { recursive: true });
	writeFileSync(subscriptionFile(dataDir, id), JSON.stringify({ schema_version: 1, id, endpoint, keys: testDevice(endpoint).keys, created_at: "2026-09-27T00:00:00Z" }));

	// gh fails twice and recovers (an hour apart: it is checked hourly); the record holds what the dashboard reads.
	const gh = [];
	const outs: string[] = [];
	for (const [n, status] of [[0, "0"], [1, "1"], [2, "1"], [3, "0"]] as const) {
		h.answer("gh auth status --active.status", status);
		h.answer("gh api user --jq .login.status", status);
		const { record, out } = await h.run(T0 + n * 61 * MIN, viewer(up));
		gh.push(state(record, "gh"));
		outs.push(out);
	}
	assert.deepEqual(gh, ["ok", "fail failed", "fail failed", "ok"]);
	const failed = (await h.run(T0 + 4 * 61 * MIN, { ...viewer(up), PATH: "" })).record;
	assert.deepEqual(Object.keys(failed.checks.gh!).sort(), ["checked_at", "detail", "fails", "key", "since", "status"]);
	assert.deepEqual(Object.keys(failed).filter((key) => !["schema_version", "last_run_at", "checks", "warn_checked_at"].includes(key)), [], "no push state");
	assert.equal(failed.schema_version, 1);
	assert.equal(existsSync(pushDeliveriesFile(h.stateDir)), false, "the push ledger is never written");
	assert.doesNotMatch(outs.join(""), /push/);
	// gh: the active account decides; a gh without --active falls back to gh api user.
	h.answer("gh auth status --active.status", "1");
	h.answer("gh api user --jq .login.status", "0");
	assert.equal(state((await h.run(T0 + 6 * 61 * MIN, viewer(up))).record, "gh"), "ok");
	assert.ok(h.calls().includes("gh api user --jq .login"), "the fallback ran");

	// A fresh home with no parent host: one failed run is a blip, a skipped run (mid-update) neither resets nor counts.
	const parent: string[] = [];
	const update = join(p.stateDir, "update.json");
	let at = T0 + 7 * 61 * MIN;
	const step = async (env: Record<string, string>) => (await p.run((at += 5 * MIN), env)).record;
	for (const phase of [undefined, "draining", undefined]) {
		if (phase) writeFileSync(update, JSON.stringify({ phase }));
		else writeFileSync(update, JSON.stringify({ phase: "idle" }));
		const record = await step(viewer(down));
		parent.push(state(record, "parent"));
	}
	assert.deepEqual(parent, ["ok", "ok", "fail down"]);
	assert.equal(readHealth(p.stateDir)!.checks.parent!.detail, "no parent host is running");
	assert.match(readHealth(p.stateDir)!.checks.viewer!.detail, /did not answer: /, "a refused viewer");
	// Mid-update suppresses parent and viewer; a rollback held back by live workers is watched; one in flight is not.
	writeFileSync(update, JSON.stringify({ phase: "draining" }));
	assert.match((await p.run((at += 5 * MIN), viewer(down))).out, /parent: skipped \(update phase draining\)\n.*viewer: skipped \(update phase draining\)/);
	writeFileSync(update, JSON.stringify({ phase: "rolling_back", last_result: "rollback_failed", held: true }));
	assert.doesNotMatch((await p.run((at += 5 * MIN), viewer(down))).out, /parent: skipped|viewer: skipped/);
	writeFileSync(update, JSON.stringify({ phase: "rolling_back", last_result: "rollback_failed" }));
	assert.match((await p.run((at += 5 * MIN), viewer(down))).out, /parent: skipped \(update phase rolling_back\)/);
	// A viewer blip that recovers never counts.
	writeFileSync(update, JSON.stringify({ phase: "idle" }));
	const viewers = [];
	for (const port of [up, down, up]) viewers.push(state(await step(viewer(port)), "viewer"));
	assert.deepEqual(viewers, ["ok", "ok", "ok"]);

	// The supervisor: no runtime record is no check; a restart is fine; a crash loop fails with its result.
	assert.equal(readHealth(p.stateDir)!.checks.supervisor, undefined, "no cp-daemon: nothing to watch");
	const runtime = daemonPaths(p.home).runtime;
	mkdirSync(daemonPaths(p.home).stateDir, { recursive: true });
	writeFileSync(runtime, JSON.stringify({ units: { parent: { state: "restarting" } } }));
	assert.equal(state(await step(viewer(up)), "supervisor"), "ok", "a restart is not a crash loop");
	writeFileSync(runtime, JSON.stringify({ units: { parent: { state: "failed", result: "start-limit-hit" } } }));
	const looping = (await step(viewer(up))).checks.supervisor!;
	assert.deepEqual([looping.key, looping.detail], ["start-limit-hit", "cp-daemon's parent supervisor is failed (start-limit-hit); cp-daemon log"]);

	// update: each distinct failure is its own key; a skip or two fetch failures change nothing; the third fails.
	const updates: string[] = [];
	for (const value of [
		{ last_result: "failed", to: "aaaa" }, { last_result: "failed", to: "aaaa" }, { last_result: "drain_timeout", to: "aaaa" },
		{ last_result: "rolled_back", to: "bbbb" }, { last_result: "skipped_busy", to: "bbbb" }, { last_result: "fetch_failed", fetch_failures: 2 },
		{ last_result: "up_to_date" }, { last_result: "fetch_failed", fetch_failures: 3 },
		// N7: one drain_timeout episode keeps one key while origin/main moves; a new episode is a new key.
		{ last_result: "drain_timeout", to: "aaaa", since: "2026-10-06T12:26:40Z" }, { last_result: "drain_timeout", to: "bbbb", since: "2026-10-06T12:26:40Z" },
		{ last_result: "up_to_date", since: "2026-10-06T14:16:43Z" }, { last_result: "drain_timeout", to: "bbbb", since: "2026-10-06T15:00:00Z" },
		{ last_result: "failed", to: "cccc", since: "2026-10-06T16:00:00Z" }, { last_result: "failed", to: "dddd", since: "2026-10-06T16:00:00Z" },
	]) {
		writeFileSync(update, JSON.stringify({ phase: "idle", ...value }));
		updates.push(state(await step(viewer(up)), "update"));
	}
	assert.deepEqual(updates.slice(0, 8), ["fail failed:aaaa", "fail failed:aaaa", "fail drain_timeout:aaaa", "fail rolled_back:bbbb", "fail rolled_back:bbbb", "fail rolled_back:bbbb", "ok", "fail fetch_failed:"]);
	assert.deepEqual(updates.slice(8), ["fail drain_timeout:2026-10-06T12:26:40Z", "fail drain_timeout:2026-10-06T12:26:40Z", "ok", "fail drain_timeout:2026-10-06T15:00:00Z", "fail failed:cccc", "fail failed:dddd"]);
});

test("P14-health-relay: the relay check fails a relay or an escalation the main session has not seen, and an unreadable outbox", { timeout: 300_000 }, async (t) => {
	const h = healthHome(t);
	const outboxFile = operatorRelayOutboxFile(h.stateDir);
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(h.stateDir));
	mkdirSync(join(h.stateDir, "operator"), { recursive: true });
	const relay = (text: string): BridgeRelay => ({ kind: "wake", jobId: "cp-demo1", stale: false, text, receipt: { level: null, reached: [] }, paths: [] });
	const enqueue = (text: string) => new OperatorRelayOutbox(outboxFile, () => new Date(T0)).enqueue(relay(text), "1.1");
	const relayAt = async (seconds: number) => (await h.run(T0 + seconds * 1000)).record.checks.relay;

	// Unacked 599 s is ok, 600 s fails under relay:<id>, dated from queue time; acking it recovers.
	assert.equal(await relayAt(0), undefined, "no outbox: no signal");
	const id = enqueue("[demo] cp-1: wake");
	assert.equal((await relayAt(599))?.status, "ok");
	const { record, out } = await h.run(T0 + 600_000);
	assert.equal(state(record, "relay"), `fail relay:${id}`);
	assert.match(record.checks.relay!.detail, new RegExp(`^1 relay\\(s\\) unseen by the main session, oldest ${id} 10 min \\(wake\\)`));
	assert.equal(Date.parse(record.checks.relay!.since), T0, "since is the relay's queued_at, not the run that saw it");
	assert.match(out, new RegExp(`^health: failing: .*relay \\[relay:${id}\\] 1 relay\\(s\\) unseen by the main session`, "m"));
	assert.equal((await relayAt(630))?.key, `relay:${id}`, "one key while unseen");
	acks.append([{ type: "ack", id, at: "2026-09-28T10:11:00Z" }]);
	const acked = await h.run(T0 + 660_000);
	assert.equal(state(acked.record, "relay"), "ok");
	assert.doesNotMatch(acked.out, /relay \[/);

	// A relay older than any consumer line names the relaunch; a newer consumer does not; a discard closes it.
	const old = enqueue("old");
	assert.match((await relayAt(700))!.detail, /no ack-capable operator session; relaunch it \(dashboard: Restart session\)$/);
	acks.append([{ type: "consumer", owner: "o1", pid: 4_194_305, at: "2026-09-28T10:05:00Z", protocol: 1 }]);
	assert.doesNotMatch((await relayAt(700))!.detail, /relaunch/, "a session started after the relay is ack-capable");
	acks.append([{ type: "discard", id: old, reason: "superseded: answered", at: "2026-09-28T10:06:00Z" }]);
	assert.equal(state((await h.run(T0 + 700_000)).record, "relay"), "ok", "discarded is closed");

	// An open escalation unseen for 1200 s fails escalation:<id>; an open ask or an ack of it accounts for it.
	const es = await new EscalationStore({ home: h.home }).raise({ job_ids: ["cp-demo1"], kind: "plan_approval", question: "approve?", options: [{ id: "ok", label: "ok", consequence: "go", cost: "none" }], recommended: "ok", at: "2026-09-28T10:00:00Z" });
	assert.equal((await relayAt(1199))?.status, "ok");
	const unseen = (await relayAt(1200))!;
	assert.deepEqual([unseen.key, /open 20 min and unseen by the main session/.test(unseen.detail)], [`escalation:${es.id}`, true]);
	const asks = join(h.stateDir, "operator", "asks.jsonl");
	new OperatorAsks(asks).open({ project: "demo", question: "approve?", options: [{ label: "ok", consequence: "go" }], recommendation: "ok", source_escalation: es.id });
	assert.equal((await relayAt(1200))?.status, "ok", "an open ask represents it");
	rmSync(asks);
	acks.append([{ type: "ack", id: `esc:${es.id}#2`, at: "2026-09-28T10:20:00Z" }]);
	assert.equal((await relayAt(1200))?.status, "ok", "an ack of any refresh accounts for it");

	// An unreadable outbox fails as unreadable, never as empty.
	writeFileSync(outboxFile, "{not json");
	const bad = (await relayAt(1300))!;
	assert.deepEqual([bad.status, bad.key, bad.detail.includes(outboxFile)], ["fail", "unreadable", true]);
});

test("P14-health-viewer: a remote-only viewer (no tailnet, cp-tunnel on) is healthy only on this home's live owner socket", { timeout: 300_000 }, async (t) => {
	const h = healthHome(t);
	const other = healthHome(t);
	const paths = daemonPaths(h.home);
	mkdirSync(paths.dataDir, { recursive: true });
	const enable = (enabled: boolean) => atomicWrite(tunnelConfigFile(paths.dataDir), { schema_version: 1, enabled, mode: "quick", port: 8767, binary: "/opt/cf/cloudflared", revision: 1 });
	const viewer = async () => (await h.run(T0)).record.checks.viewer!.detail;
	enable(true);
	// Two runs make the failure count; each detail is the last run's.
	await h.run(T0);
	assert.match(await viewer(), /^remote-only viewer \(no local listener\): no device control record/);
	const routes = { store: {} as DeviceRoutes["store"], binding: () => null };
	const elsewhere = await startDeviceControl(daemonPaths(other.home).stateDir, routes, () => undefined);
	t.after(() => "stop" in elsewhere && elsewhere.stop());
	assert.match(await viewer(), /no device control record/, "another home's viewer never answers for this one");
	const mine = await startDeviceControl(paths.stateDir, routes, () => undefined);
	t.after(() => "stop" in mine && mine.stop());
	assert.equal(state((await h.run(T0)).record, "viewer"), "ok", "the owner socket's status is the readiness probe");
	if ("stop" in mine) mine.stop();
	await h.run(T0);
	assert.match(await viewer(), /^remote-only viewer/, "a stopped viewer fails");
	enable(false);
	assert.match(await viewer(), /gave no address and --require-tailnet is set/, "a disabled tunnel is not remote-only");
});

test("P14-health-drift: an unqualified newer pi is a host.pi.drift warning in the log, hourly, never a failed check", { timeout: 300_000 }, async (t) => {
	const h = healthHome(t);
	h.answer("pi.out", "pi 1.9.9\n");
	h.answer("npm.out", `${JSON.stringify({ "1.9.9": new Date(T0 - 20 * 86_400_000).toISOString() })}\n`);
	const probes = () => h.calls().filter((line) => line === "pi --version").length;
	const first = await h.run(T0 + 30 * MIN);
	assert.match(first.out, /^health: warn host\.pi\.drift: .*qualify pi 1\.9\.9/m);
	assert.deepEqual(Object.keys(first.record.checks).filter((name) => /drift|pi/.test(name) && name !== "parent"), [], "no drift check");
	assert.equal(first.record.checks.gh?.status, "ok", "the same gh answers the login check");
	const once = probes();
	assert.ok(once > 0, "the stub pi ran");
	assert.doesNotMatch((await h.run(T0 + 50 * MIN)).out, /host\.pi\.drift/);
	assert.equal(probes(), once, "within the hour: no second probe");
	// An hour on, probed again: an open qualify PR silences it, and so does an unreadable gh.
	h.answer("gh.out", `${JSON.stringify([{ title: "qualify pi 1.9.9", url: "u" }])}\n`);
	assert.doesNotMatch((await h.run(T0 + 91 * MIN)).out, /host\.pi\.drift/);
	assert.ok(probes() > once, "an hour later: probed again");
	h.answer("gh.status", "1");
	assert.doesNotMatch((await h.run(T0 + 152 * MIN)).out, /host\.pi\.drift/);
	assert.equal(probes(), once + 2);
});
