/**
 * Behavior 15 (P14): the parent supervisor cp-parent.service runs, `node src/service/supervise.ts`, on scratch homes
 * with the fake parent as pi. Holds, losses and stops are real: a stop through the host, a SIGKILL, state files.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { attachParentHost, currentHost, ParentHostClient, parentHostPaths, readStopMarker } from "../../src/parent-host.ts";
import { createScratchHome, REPO_ROOT, type ScratchHome } from "../harness/index.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import "../harness/fake-parent-tracker.ts";

const SUPERVISE = join(REPO_ROOT, "src/service/supervise.ts");
const FAKE_PARENT = join(REPO_ROOT, "tests/fixtures/fake-parent.mjs");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const POLL = "waiting without spawning (polling every 10s for a newer generation)";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(what: string, check: () => boolean, log: () => string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${log()}`);
		await sleep(50);
	}
}

/** A scratch home and the files its supervisors read; every host it gets is stopped at teardown. */
function home(t: TestContext) {
	const h = createScratchHome();
	t.after(() => teardownHome(h));
	const paths = parentHostPaths(h.path, "multi");
	const put = (rel: string, value: unknown) => {
		mkdirSync(dirname(join(h.path, rel)), { recursive: true });
		writeFileSync(join(h.path, rel), typeof value === "string" ? value : JSON.stringify(value));
	};
	const host = () => currentHost(paths);
	return { h, paths, put, host, argv: join(h.path, "fake-parent.argv") };
}

/** One `node src/service/supervise.ts` on `home` with its own env; stderr lines are its log. */
function supervisor(t: TestContext, home: ScratchHome, env: Record<string, string> = {}) {
	const base: Record<string, string | undefined> = { ...process.env, CP_HOME: home.path, CP_MODE: "multi", PI_HOME: home.path, CP_PARENT_PI_BIN: FAKE_PARENT,
		FAKE_PARENT_ARGV: join(home.path, "fake-parent.argv") };
	delete base.CP_PARENT_MODEL;
	const child = spawn(process.execPath, [SUPERVISE], { env: { ...base, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	let err = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
	const exit = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	const lines = () => err.split("\n").filter(Boolean);
	const saw = (text: string) => lines().filter((line) => line.includes(text)).length;
	return { child, exit, lines, saw, log: () => err };
}

const drain = (state: string, over: Record<string, unknown> = {}) =>
	({ state, started_at: new Date(Date.now() - 3_600_000).toISOString(), deadline: new Date().toISOString(), timeout_s: 600, finished_at: new Date().toISOString(), jobs: [], ...over });
const old = () => new Date(Date.now() - 16 * 60_000).toISOString();

test("P14-supervise: attach-first parent supervisor — model choice, stop and drain holds, newer generations, exits", { timeout: 300_000 }, async (t) => {
	// A live foreign parent lock: retried every 60 s and logged once (checked last, past one retry); SIGTERM exits 0.
	const foreign = home(t);
	foreign.put(`${LAYOUT.state}/parent.lock`, { schema_version: 1, pid: process.pid, started_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), home: foreign.h.path });
	const blocked = supervisor(t, foreign.h, { CP_PARENT_MODEL: "env/m" });
	const blockedSince = Date.now();
	await until("the foreign-lock line", () => blocked.saw("already holds") > 0, blocked.log);
	assert.match(blocked.lines()[0]!, /^supervise: a parent already holds .*parent\.lock \(pid \d+\) .*; retrying every 60s$/);

	// Any other attach failure (an unreadable lock) exits 1 at once.
	const broken = home(t);
	broken.put(`${LAYOUT.state}/parent.lock`, "{not json");
	const refused = supervisor(t, broken.h, { CP_PARENT_MODEL: "env/m" });
	assert.equal(await refused.exit, 1);
	assert.match(refused.log(), /supervise: attach failed: parent lock unreadable/);

	// No model anywhere: exit 78 (no crash loop) and no parent started.
	const x = home(t);
	const none = supervisor(t, x.h);
	assert.equal(await none.exit, 78, none.log());
	assert.match(none.log(), /no parent model \(no CP_PARENT_MODEL, no data\/parent\.json model, no saved model\).*not restarting/);
	assert.equal(existsSync(x.argv), false, "no parent was started");

	// data/parent.json alone (no env, no saved model) is a model: the supervisor starts a parent instead of exiting 78.
	const filed = home(t);
	filed.put(`${LAYOUT.data}/parent.json`, { model: "file/m" });
	const fromFile = supervisor(t, filed.h);
	await until("the file-model start", () => fromFile.saw("started parent") > 0, fromFile.log);
	assert.match(fromFile.log(), /started parent pid \d+ \(file\/m\)/, "a data/parent.json model avoids exit 78");
	// data/parent.json's model beats CP_PARENT_MODEL, never as modelExplicit: the file model reaches the parent.
	const both = home(t);
	both.put(`${LAYOUT.data}/parent.json`, { model: "file/m" });
	const fileWins = supervisor(t, both.h, { CP_PARENT_MODEL: "env/m" });
	await until("the file-over-env start", () => fileWins.saw("started parent") > 0, fileWins.log);
	assert.match(fileWins.log(), /started parent pid \d+ \(file\/m\)/);
	assert.match(readFileSync(both.argv, "utf8").trim().split("\n").at(-1)!, /file\/m/, "never modelExplicit");

	// The saved model is the fallback; a second supervisor attaches to the running parent and adds no generation.
	x.put(`${LAYOUT.sessions}/cp-parent-control.json`, { model: "saved/m" });
	const s1 = supervisor(t, x.h);
	await until("s1's start", () => s1.saw("started parent") > 0, s1.log);
	assert.match(s1.log(), /supervise: host pid \d+: started parent pid \d+ \(saved\/m\)/);
	const s2 = supervisor(t, x.h, { CP_PARENT_MODEL: "env/m" });
	await until("s2's attach", () => s2.saw("attached to host pid") > 0, s2.log);
	assert.match(s2.log(), /supervise: attached to host pid \d+, parent pid \d+\n/);
	assert.doesNotMatch(s2.log(), /env\/m/, "an attach claims no model");
	assert.equal(x.host().gen, 1, "attach first: no second generation");

	// An operator stop holds both on generation 1 without spawning, logged once across polls.
	const client = await ParentHostClient.connect(x.host().record!);
	await client.request("stop");
	await client.closed;
	assert.equal(readStopMarker(x.paths)?.gen, 1);
	for (const s of [s1, s2]) await until("the stop hold", () => s.saw(`an operator stop closed generation 1: ${POLL}`) > 0, s.log);
	await sleep(11_000);
	assert.equal(x.host().gen, 1, "nothing respawned over a stop");
	for (const s of [s1, s2]) assert.equal(s.saw("waiting without spawning"), 1, s.log());

	// A fresh supervisor (an update's reload, a reboot) honours the stop too: it waits and spawns nothing.
	const s3 = supervisor(t, x.h, { CP_PARENT_MODEL: "env/m" });
	await until("s3's stop hold", () => s3.saw(`an operator stop closed generation 1: ${POLL}`) > 0, s3.log);
	await sleep(11_000);
	assert.equal(x.host().gen, 1, "a fresh supervisor never respawns over a stop");
	assert.equal(s3.saw("started parent"), 0, s3.log());
	// The operator's cp_parent start makes generation 2; every held supervisor joins it.
	const started = await attachParentHost({ home: x.h.path, mode: "multi" });
	await started.request("start", { home: x.h.path, mode: "multi", model: "file/m", piBin: FAKE_PARENT });
	started.disconnect();
	for (const s of [s1, s2, s3]) await until("the newer generation", () => s.saw("attached to newer host generation 2") > 0, s.log, 20_000);
	assert.equal(s3.saw("started parent"), 0, "the operator's start owns generation 2's parent");

	// Host lost under a drain: draining, an update in flight, a fresh drain for another target keep waiting...
	x.put(`${LAYOUT.state}/drain.json`, drain("draining", { finished_at: old() }));
	process.kill(x.host().record!.pid, "SIGKILL");
	for (const s of [s1, s2, s3]) await until("the drain hold", () => s.saw(`state/drain.json is present: ${POLL}`) > 0, s.log);
	x.put(`${LAYOUT.state}/update.json`, { phase: "running" });
	x.put(`${LAYOUT.state}/drain.json`, drain("drained", { finished_at: old(), cause: { reason: "auto-update", target_sha: HEAD.slice(0, 12) } }));
	await sleep(10_500);
	x.put(`${LAYOUT.state}/update.json`, { phase: "idle" });
	x.put(`${LAYOUT.state}/drain.json`, drain("drained", { cause: { reason: "auto-update", target_sha: "0123456789ab" } }));
	await sleep(10_500);
	for (const s of [s1, s2, s3]) assert.equal(s.saw("stopped holding"), 0, s.log());
	// ...and a drained record whose target is the checkout HEAD, with no update run, stops holding: exit 1, no respawn.
	x.put(`${LAYOUT.state}/drain.json`, drain("drained", { cause: { reason: "auto-update", target_sha: HEAD.slice(0, 12) } }));
	for (const s of [s1, s2, s3]) {
		const exited = await Promise.race([s.exit, sleep(15_000).then(() => "still waiting")]);
		assert.equal(exited, 1, `a drain spent on HEAD holds nothing\n${s.log()}`);
	}
	assert.match(s1.log(), new RegExp(`stopped holding the supervisor: the drained drain's auto-update target ${HEAD.slice(0, 12)} is the checkout HEAD and no update run is in flight`));
	assert.match(s1.log(), /host generation 2 is gone; exiting 1 so cp-daemon restarts the supervisor/);
	assert.equal(x.host().gen, 2, "the supervisor never respawns; systemd restarts it");

	// A timed-out drain over 15 min old stops holding at once; CP_PARENT_MODEL beats the saved model.
	const s4 = supervisor(t, x.h, { CP_PARENT_MODEL: "env/m" });
	await until("s4's start", () => s4.saw("started parent") > 0, s4.log);
	assert.match(s4.log(), /started parent pid \d+ \(env\/m\)/);
	x.put(`${LAYOUT.state}/drain.json`, drain("timeout", { finished_at: old() }));
	process.kill(x.host().record!.pid, "SIGKILL");
	const exited = await Promise.race([s4.exit, sleep(15_000).then(() => "still waiting")]);
	assert.equal(exited, 1, `an old timed-out drain holds nothing\n${s4.log()}`);
	assert.match(s4.log(), /the timeout drain finished .* \(over 15 min ago\) and no update run is in flight/);
	assert.equal(s4.saw("waiting without spawning"), 0);

	// SIGTERM disconnects and exits 0, the host and parent stay up; with no hold a lost host exits 1.
	rmSync(join(x.h.path, LAYOUT.state, "drain.json"));
	const s5 = supervisor(t, x.h, { CP_PARENT_MODEL: "env/m" });
	await until("s5's start", () => s5.saw("started parent") > 0, s5.log);
	s5.child.kill("SIGTERM");
	assert.equal(await s5.exit, 0);
	const live = x.host();
	assert.ok(isPidAlive(live.record!.pid), "the host outlives its supervisor");
	const s6 = supervisor(t, x.h);
	await until("s6's attach", () => s6.saw("attached to host pid") > 0, s6.log);
	process.kill(live.record!.pid, "SIGKILL");
	assert.equal(await s6.exit, 1);
	assert.match(s6.log(), new RegExp(`lost host generation ${live.gen} .*\\n.*host generation ${live.gen} is gone; exiting 1`));

	await sleep(Math.max(0, blockedSince + 62_000 - Date.now()));
	assert.equal(blocked.saw("already holds"), 1, "logged once across retries");
	blocked.child.kill("SIGTERM");
	assert.equal(await blocked.exit, 0);
});

test("P14-supervise-update-stop: an updater's stop or a pre-537 marker never holds a fresh supervisor", { timeout: 300_000 }, async (t) => {
	// Issue 537 revise: the updater's own host stop writes the stop marker too. The reload's fresh supervisor must
	// respawn the parent over it; only `by: "operator"` holds startup. A marker without `by` (an old host) never does.
	const u = home(t);
	u.put(`${LAYOUT.data}/parent.json`, { model: "file/m" });
	const old = supervisor(t, u.h);
	await until("the first start", () => old.saw("started parent") > 0, old.log);
	const client = await ParentHostClient.connect(u.host().record!);
	await client.request("stop", { by: "update" });
	await client.closed;
	assert.deepEqual([readStopMarker(u.paths)?.gen, readStopMarker(u.paths)?.by], [1, "update"]);
	await until("the old supervisor's hold through the update window", () => old.saw(`generation 1: ${POLL}`) > 0, old.log);
	old.child.kill("SIGTERM");
	assert.equal(await old.exit, 0);
	const fresh = supervisor(t, u.h);
	await until("the respawn after the update", () => fresh.saw("started parent") > 0, fresh.log);
	assert.equal(u.host().gen, 2, "the reload's supervisor respawned the parent");
	assert.equal(fresh.saw("waiting without spawning"), 0, fresh.log());

	// The transition update runs the old update.ts against an old host: its marker has no `by`.
	const second = await ParentHostClient.connect(u.host().record!);
	await second.request("stop");
	await second.closed;
	assert.equal(readStopMarker(u.paths)?.by, "operator", "a stop with no option is the operator's");
	u.put(`${LAYOUT.state}/parent-host.stopped.json`, { gen: 2, at: new Date().toISOString() });
	await until("the held supervisor", () => fresh.saw(`generation 2: ${POLL}`) > 0, fresh.log);
	fresh.child.kill("SIGTERM");
	assert.equal(await fresh.exit, 0);
	const after = supervisor(t, u.h);
	await until("the respawn over a pre-537 marker", () => after.saw("started parent") > 0, after.log);
	assert.equal(u.host().gen, 3);
});
