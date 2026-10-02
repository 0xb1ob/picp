/**
 * cp-daemon v1 P4: the auto-updater (src/service/update.ts) and its /doctor line. The checkout is a real
 * scratch git repo with a bare origin; the host, cp-daemon's control socket, npm and the verify are fakes. Nothing is started.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { layoutForHome } from "../src/contracts.ts";
import type { DrainRecord } from "../src/drain.ts";
import { serviceFindings } from "../src/service/status.ts";
import { readUpdateState, runUpdate, type UpdateState, updateStateFile } from "../src/service/update.ts";
import { advanceBase, createScratchRepo } from "./harness/scratch-repo.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "cp test", GIT_AUTHOR_EMAIL: "cp@test.invalid", GIT_COMMITTER_NAME: "cp test", GIT_COMMITTER_EMAIL: "cp@test.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function bench(t: import("node:test").TestContext, config: unknown = { enabled: true, interval_min: 15 }) {
	const repo = createScratchRepo({ files: { ".gitignore": ".pi-command-post/\n", "package-lock.json": "{\"v\":1}\n", "README.md": "app\n" } });
	t.after(() => repo.cleanup());
	const layout = layoutForHome("multi", repo.path);
	const stateDir = join(repo.path, layout.state);
	const dataDir = join(repo.path, layout.data);
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	if (config !== null) writeFileSync(join(dataDir, "update.json"), typeof config === "string" ? config : JSON.stringify(config));
	let clock = Date.parse("2026-09-28T10:00:00Z");
	const calls: string[] = [];
	const lines: string[] = [];
	const fake = { busy: [] as string[], working: [] as string[], scripts: [] as string[], drains: [] as Array<DrainRecord["state"] | undefined>, verify: [] as Array<string | undefined | (() => string | undefined)>, failing: new Set<string>() };
	// cp-daemon's control socket: each op is recorded as `daemon <op>`; a failing one answers like daemonControl.
	const daemonCall = (op: string): string | undefined => {
		calls.push(`daemon ${op}`);
		return fake.failing.has(`daemon ${op}`) ? `cp-daemon ${op}: refused` : undefined;
	};
	const ports = {
		run: (command: string, args: readonly string[], cwd?: string) => {
			if (command === "git") {
				const out = spawnSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
				return { status: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
			}
			const line = [command, ...args].join(" ");
			calls.push(line);
			return { status: fake.failing.has(line) ? 1 : 0, stdout: "", stderr: fake.failing.has(line) ? "refused" : "" };
		},
		host: async (op: string, ...args: unknown[]) => {
			calls.push(`host ${op}${args.length ? ` ${JSON.stringify(args)}` : ""}`);
			if (fake.failing.has(`host ${op}`)) throw new Error(`${op} refused`);
			return { text: `DRAIN: ${op}`, level: "info" };
		},
		drain: () => (fake.drains.length > 1 ? fake.drains.shift() : fake.drains[0] ?? "drained"),
		busy: () => fake.busy,
		activity: () => ({ working: fake.working, scripts: fake.scripts }),
		verify: async () => {
			const next = fake.verify.shift();
			return typeof next === "function" ? next() : next;
		},
		daemon: {
			hold: async () => daemonCall("hold"),
			reload: async () => daemonCall("reload"),
			health: async () => void daemonCall("health"),
		},
		now: () => new Date(clock),
		sleep: async (ms: number) => void (clock += ms),
		log: (line: string) => lines.push(line),
	};
	const run = async (advanceMin = 20, dryRun = false): Promise<UpdateState | undefined> => {
		clock += advanceMin * 60_000;
		return runUpdate({ app: repo.path, stateDir, dataDir, env: { CP_DAEMON_JOB: "update" }, dryRun }, ports);
	};
	const hostCalls = () => calls.filter((call) => call.startsWith("host "));
	return { repo, stateDir, dataDir, calls, lines, fake, run, hostCalls, now: () => clock };
}

test("skipped dirty/ahead/branch/busy: recorded, nothing drained, the checkout unmoved", async (t) => {
	for (const cause of ["dirty", "ahead", "branch", "busy"] as const) {
		const b = bench(t);
		advanceBase(b.repo, "new.txt", "new\n");
		if (cause === "dirty") b.repo.write("README.md", "edited\n");
		if (cause === "ahead") {
			b.repo.write("local.txt", "local\n");
			b.repo.commitAll("local");
		}
		if (cause === "branch") b.repo.git("checkout", "--quiet", "-b", "feature");
		if (cause === "busy") b.fake.working = ["cp-live"];
		const head = b.repo.head();
		const state = await b.run();
		assert.equal(state?.last_result, `skipped_${cause}`, cause);
		assert.equal(state?.phase, "idle");
		assert.deepEqual(b.hostCalls(), [], `${cause}: no drain request`);
		assert.equal(b.repo.head(), head, `${cause}: the checkout never moves`);
		assert.ok(!b.calls.includes("daemon health"), "a skip is not a failure");
		assert.deepEqual(readUpdateState(b.stateDir), state);
	}
});

test("an idle held worker does not block: drained at once, updated (cp-ccm0)", async (t) => {
	const b = bench(t);
	b.fake.busy = ["cp-held"];
	const to = advanceBase(b.repo, "held.txt", "held\n");
	const state = await b.run();
	assert.equal(state?.last_result, "updated", b.lines.join("\n"));
	assert.equal(b.repo.head(), to);
	assert.equal(b.hostCalls()[0], "host drain [600]");
});

test("a mid-turn fleet is drained anyway after 4x interval_min busy (cp-ccm0)", async (t) => {
	for (const outcome of ["drained", "draining"] as const) {
		const b = bench(t);
		b.fake.working = ["cp-a"];
		b.fake.drains = [outcome];
		const head = b.repo.head();
		const to = advanceBase(b.repo, "busy.txt", "busy\n");
		const first = await b.run();
		assert.equal(first?.last_result, "skipped_busy");
		assert.match(first?.detail ?? "", /mid-turn worker\(s\): cp-a/);
		for (let i = 0; i < 2; i++) {
			const again = await b.run(20);
			assert.equal(again?.last_result, "skipped_busy");
			assert.equal(again?.since, first?.since, "since keeps the first skip");
		}
		assert.deepEqual(b.hostCalls(), [], "under 4x interval_min: nothing drained");
		const forced = await b.run(20);
		if (outcome === "drained") {
			assert.equal(forced?.last_result, "updated", b.lines.join("\n"));
			assert.equal(b.repo.head(), to);
			assert.equal(b.hostCalls()[0], "host drain [600]");
		} else {
			assert.equal(forced?.last_result, "drain_timeout");
			assert.deepEqual(b.hostCalls(), ["host drain [600]", "host drainCancel"], "nothing stopped");
			assert.equal(b.repo.head(), head);
		}
	}
});

test("a live script is never forced (cp-ccm0)", async (t) => {
	const b = bench(t);
	b.fake.scripts = ["cp-script"];
	const head = b.repo.head();
	advanceBase(b.repo, "script.txt", "script\n");
	for (let i = 0; i < 8; i++) {
		const state = await b.run(20);
		assert.equal(state?.last_result, "skipped_busy");
		assert.match(state?.detail ?? "", /live script job\(s\): cp-script/);
	}
	assert.deepEqual(b.hostCalls(), []);
	assert.equal(b.repo.head(), head);
});

test("disabled, absent, invalid config and the schedule: off records skipped_disabled, invalid is a failure, a recent run is silent", async (t) => {
	const off = bench(t, { enabled: false });
	assert.equal((await off.run())?.last_result, "skipped_disabled");
	const absent = bench(t, null);
	assert.equal((await absent.run())?.last_result, "skipped_disabled");
	const invalid = bench(t, "{\"enabled\": \"yes\"}");
	assert.equal((await invalid.run())?.last_result, "config_invalid");
	assert.ok(invalid.calls.includes("daemon health"), "every failure asks cp-daemon for a watchdog run");
	const b = bench(t);
	assert.equal((await b.run())?.last_result, "up_to_date");
	assert.equal(await b.run(5), undefined, "under interval_min: silent, nothing recorded");
	assert.equal((await b.run(15))?.last_result, "up_to_date");
	writeFileSync(join(b.dataDir, "daemon.json"), "{}");
	await assert.rejects(runUpdate({ app: b.repo.path, stateDir: b.stateDir, dataDir: b.dataDir, env: {} }, {} as never), /refused: cp-update runs from cp-daemon \(it serializes runs\); by hand, use --dry-run/);
	await assert.rejects(runUpdate({ app: b.repo.path, stateDir: b.stateDir, dataDir: b.dataDir, env: { INVOCATION_ID: "legacy" } }, {} as never), /refused/, "systemd's INVOCATION_ID no longer admits a run");
});

test("a legacy cp-update.service (no data/daemon.json, not cp-daemon's job) records migration_required, keeps the phase and touches nothing", async (t) => {
	const b = bench(t);
	const head = b.repo.head();
	advanceBase(b.repo, "n.txt", "n\n");
	writeFileSync(updateStateFile(b.stateDir), JSON.stringify({ schema_version: 1, phase: "rolling_back", from: head, to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	// Only log, now and daemon.health: any other port (host, git, npm, verify) would throw.
	const ports = { log: (line: string) => b.lines.push(line), now: () => new Date(b.now()), daemon: { health: async () => void b.calls.push("daemon health") } } as unknown as Parameters<typeof runUpdate>[1];
	const run = () => runUpdate({ app: b.repo.path, stateDir: b.stateDir, dataDir: b.dataDir, env: { INVOCATION_ID: "legacy" } }, ports);
	const state = await run();
	assert.equal(state?.last_result, "migration_required");
	assert.equal(state?.phase, "rolling_back", "an interrupted phase is kept for cp-daemon's first run");
	assert.match(state?.detail ?? "", /rerun cp-install to move it to cp-daemon \(auto-update never reruns it\)/);
	assert.equal(b.repo.head(), head, "the checkout never moves");
	assert.deepEqual(b.calls, ["daemon health"], "no host, git merge or npm: only the watchdog notice");
	const again = await run();
	assert.equal(again?.since, state?.since, "one distinct result, one notice key");
});

test("ff to origin/main, npm ci only on a lockfile change, both units restarted → updated", async (t) => {
	const b = bench(t);
	const from = b.repo.head();
	const to = advanceBase(b.repo, "feature.txt", "feature\n");
	const state = await b.run();
	assert.equal(state?.last_result, "updated", b.lines.join("\n"));
	assert.equal(b.repo.head(), b.repo.head("origin/main"));
	assert.equal(b.repo.head(), to);
	assert.deepEqual({ from: state?.from, to: state?.to, phase: state?.phase, lock: state?.lock }, { from, to, phase: "idle", lock: false });
	assert.deepEqual(b.calls, ["host drain [600]", "host stop [{}]", "daemon hold", "daemon reload"], "no npm ci, no watchdog");

	b.calls.length = 0;
	advanceBase(b.repo, "package-lock.json", "{\"v\":2}\n");
	const locked = await b.run();
	assert.equal(locked?.last_result, "updated");
	assert.equal(locked?.lock, true);
	assert.deepEqual(b.calls.filter((call) => !call.startsWith("host")), ["daemon hold", "npm ci", "daemon reload"], "npm ci with the host stopped and the viewer held");
});

test("a doctor error after the update: reset --keep to from, bad_sha recorded, the watchdog started, the sha never retried", async (t) => {
	const b = bench(t);
	const from = b.repo.head();
	const bad = advanceBase(b.repo, "package-lock.json", "{\"v\":2}\n");
	b.fake.verify = ["the parent's /doctor reports an error: DOCTOR broken"];
	const state = await b.run();
	assert.equal(state?.last_result, "rolled_back", b.lines.join("\n"));
	assert.equal(state?.bad_sha, bad);
	assert.equal(state?.to, bad);
	assert.equal(b.repo.head(), from, "back at the previous commit");
	assert.equal(b.repo.isClean(), true);
	assert.match(state?.detail ?? "", /DOCTOR broken/);
	assert.equal(b.calls.filter((call) => call === "npm ci").length, 2, "npm ci forward and back");
	assert.ok(b.calls.includes("daemon health"));
	b.calls.length = 0;
	assert.equal((await b.run())?.last_result, "skipped_bad_sha");
	assert.deepEqual(b.hostCalls(), [], "a rolled-back sha is never retried");
	const fixed = advanceBase(b.repo, "fix.txt", "fix\n");
	assert.equal((await b.run())?.last_result, "updated");
	assert.equal(b.repo.head(), fixed, "a newer commit is taken");
});

test("a failed rollback is sticky until a human removes state/update.json; /doctor warns", async (t) => {
	const b = bench(t);
	advanceBase(b.repo, "x.txt", "x\n");
	b.fake.verify = ["doctor error", "still broken"];
	assert.equal((await b.run())?.last_result, "rollback_failed");
	advanceBase(b.repo, "y.txt", "y\n");
	b.calls.length = 0;
	assert.equal(await b.run(), undefined);
	assert.deepEqual(b.calls, [], "nothing runs while rollback_failed stands");
	const finding = serviceFindings(() => ({ status: 1, stdout: "", stderr: "" }), b.repo.path, { HOME: b.repo.path }, b.stateDir, b.now()).find((entry) => entry.check === "service.update");
	assert.equal(finding?.severity, "warn");
	assert.match(finding?.fix ?? "", /remove .*update\.json/);
});

test("a crash mid-phase: after the merge → rollback; before the merge → restart both units, failed; mid-drain → cancel", async (t) => {
	const after = bench(t);
	const from = after.repo.head();
	const to = advanceBase(after.repo, "a.txt", "a\n");
	after.repo.git("fetch", "--quiet", "origin");
	after.repo.git("merge", "--ff-only", "--quiet", to);
	writeFileSync(updateStateFile(after.stateDir), JSON.stringify({ schema_version: 1, phase: "verifying", from, to, lock: false, fetch_failures: 0 }));
	const state = await after.run();
	assert.equal(state?.last_result, "rolled_back");
	assert.equal(after.repo.head(), from);
	assert.equal(state?.bad_sha, to);

	const before = bench(t);
	const head = before.repo.head();
	writeFileSync(updateStateFile(before.stateDir), JSON.stringify({ schema_version: 1, phase: "updating", from: head, to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	const failed = await before.run();
	assert.equal(failed?.last_result, "failed");
	assert.equal(before.repo.head(), head);
	assert.ok(before.calls.includes("daemon reload"));
	assert.match(failed?.detail ?? "", /nothing merged; cp-daemon reloaded/);

	const drain = bench(t);
	writeFileSync(updateStateFile(drain.stateDir), JSON.stringify({ schema_version: 1, phase: "draining", from: drain.repo.head(), to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	drain.fake.drains = ["draining"];
	assert.equal((await drain.run())?.last_result, "failed");
	assert.deepEqual(drain.calls, ["host drainCancel", "daemon health"], "nothing stopped, the drain withdrawn");
});

test("a crash after the drain reached drained but before `updating`: the drained parent is restarted, dispatch is not left latched", async (t) => {
	const b = bench(t);
	const head = b.repo.head();
	advanceBase(b.repo, "late.txt", "late\n");
	// The crash window: host drain answered, drain.json says drained, the updater died before save(updating).
	writeFileSync(updateStateFile(b.stateDir), JSON.stringify({ schema_version: 1, phase: "draining", from: head, to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	b.fake.drains = ["drained"];
	const state = await b.run();
	assert.equal(state?.last_result, "failed");
	assert.equal(state?.phase, "idle");
	assert.match(state?.detail ?? "", /drained parent was restarted, dispatch reopens/);
	assert.deepEqual(b.calls, ["host stop [{}]", "daemon hold", "daemon reload", "daemon health"], "cancel refuses drained, so the parent restart is what clears it");
	assert.equal(b.repo.head(), head, "nothing merged");

	// The same window with a host stop that fails: the units still restart, and both errors are reported.
	const c = bench(t);
	writeFileSync(updateStateFile(c.stateDir), JSON.stringify({ schema_version: 1, phase: "draining", from: c.repo.head(), to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	c.fake.drains = ["drained"];
	c.fake.failing.add("host stop");
	c.fake.failing.add("daemon reload");
	const stuck = await c.run();
	assert.equal(stuck?.last_result, "failed");
	assert.ok(c.calls.includes("daemon reload"), "a failed stop never skips the restart");
	assert.match(stuck?.detail ?? "", /host stop failed: stop refused; cp-daemon reload: refused \(the drain may stay latched/);
	c.fake.failing.delete("daemon reload");
	c.calls.length = 0;
	writeFileSync(updateStateFile(c.stateDir), JSON.stringify({ schema_version: 1, phase: "draining", from: c.repo.head(), to: "f".repeat(40), lock: false, fetch_failures: 0 }));
	const restarted = await c.run();
	assert.deepEqual(c.calls.slice(0, 2), ["host stop [{}]", "daemon reload"], "stop failed (no hold asked), restart still ran");
	assert.match(restarted?.detail ?? "", /^a run was interrupted after the fleet drained; nothing merged; host stop failed: stop refused \(the drain may stay latched/);
});

test("rollback after a restarted parent reopened dispatch: it drains first and never stops the fleet under a live worker", async (t) => {
	const b = bench(t);
	const from = b.repo.head();
	const bad = advanceBase(b.repo, "bad.txt", "bad\n");
	// Verify fails; meanwhile the new parent's startup cleared the drain and dispatched cp-new, which will not settle.
	b.fake.verify = [() => {
		b.fake.busy = ["cp-new"];
		b.fake.drains = ["draining"];
		return "the parent's /doctor reports an error: DOCTOR broken";
	}];
	const held = await b.run();
	assert.equal(held?.last_result, "rollback_failed", b.lines.join("\n"));
	assert.equal(held?.phase, "rolling_back", "kept for a retry, not sticky");
	assert.equal(held?.held, true, "no run in flight: cp-health keeps watching (tests/service-health.test.ts)");
	assert.equal(b.hostCalls().filter((call) => call === "host stop [{}]").length, 1, "only the forward stop: the rollback stopped nothing");
	assert.deepEqual(b.hostCalls().slice(-2), ["host drain [600]", "host drainCancel"], "the rollback drained, timed out, cancelled");
	assert.equal(b.repo.head(), bad, "no reset under a live worker");
	assert.ok(b.calls.includes("daemon health"));
	const doctor = serviceFindings(() => ({ status: 1, stdout: "", stderr: "" }), b.repo.path, { HOME: b.repo.path }, b.stateDir, b.now()).find((entry) => entry.check === "service.update");
	assert.match(doctor?.fix ?? "", /held the rollback back/);

	b.calls.length = 0;
	assert.equal(await b.run(30), undefined, "under 4x interval_min: it waits like a drain timeout");
	assert.deepEqual(b.calls, []);
	b.fake.busy = [];
	b.fake.drains = ["drained"];
	const done = await b.run(31);
	assert.equal(done?.last_result, "rolled_back");
	assert.equal(done?.held, undefined, "a finished rollback clears held");
	assert.equal(done?.bad_sha, bad);
	assert.equal(b.repo.head(), from);
	assert.deepEqual(b.hostCalls(), ["host drain [600]", "host stop [{}]"], "drained, then stopped");

	// No host to drain (it is down) but the fleet still names a live worker: held too.
	const c = bench(t);
	advanceBase(c.repo, "c.txt", "c\n");
	c.fake.verify = [() => {
		c.fake.busy = ["cp-orphan"];
		c.fake.failing.add("host drain");
		return "not healthy within 120s";
	}];
	const orphan = await c.run();
	assert.equal(orphan?.last_result, "rollback_failed");
	assert.equal(orphan?.phase, "rolling_back");
	assert.match(orphan?.detail ?? "", /live worker\(s\) cp-orphan/);
});

test("a drain timeout: drainCancel, nothing stopped, drain_timeout pushed via the watchdog, then 4x the interval", async (t) => {
	const b = bench(t);
	const head = b.repo.head();
	advanceBase(b.repo, "slow.txt", "slow\n");
	b.fake.drains = ["draining", "draining", "timeout"];
	const state = await b.run();
	assert.equal(state?.last_result, "drain_timeout");
	assert.deepEqual(b.hostCalls(), ["host drain [600]", "host drainCancel"], "no stop");
	assert.equal(b.repo.head(), head);
	assert.ok(b.calls.includes("daemon health"));
	b.fake.drains = ["drained"];
	assert.equal(await b.run(30), undefined, "under 4x interval_min after a drain timeout: silent");
	assert.equal((await b.run(31))?.last_result, "updated");

	const stuck = bench(t);
	advanceBase(stuck.repo, "s.txt", "s\n");
	stuck.fake.drains = ["draining"];
	assert.equal((await stuck.run())?.last_result, "drain_timeout", "still draining at 660 s: cancelled too");
	assert.deepEqual(stuck.hostCalls(), ["host drain [600]", "host drainCancel"]);
});

test("fetch_failed counts runs in a row and a successful fetch resets it", async (t) => {
	const b = bench(t);
	b.repo.git("remote", "set-url", "origin", join(b.repo.path, "missing.git"));
	for (const count of [1, 2, 3]) {
		const state = await b.run();
		assert.equal(state?.last_result, "fetch_failed");
		assert.equal(state?.fetch_failures, count);
		assert.equal(b.calls.includes("daemon health"), count === 3, "the watchdog runs only at the third failure in a row (docs/service.md)");
	}
	b.repo.git("remote", "set-url", "origin", b.repo.remote!);
	const ok = await b.run();
	assert.equal(ok?.last_result, "up_to_date");
	assert.equal(ok?.fetch_failures, 0);
});

test("dry-run: probes, records nothing, drains nothing", async (t) => {
	const b = bench(t);
	advanceBase(b.repo, "d.txt", "d\n");
	const head = b.repo.head();
	const gitOnly = (command: string, args: readonly string[], cwd?: string) => {
		const out = spawnSync(command, [...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
		return { status: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
	};
	const ports = { run: gitOnly, busy: () => [], activity: () => ({ working: [], scripts: [] }), now: () => new Date(), log: (line: string) => b.lines.push(line) } as unknown as Parameters<typeof runUpdate>[1];
	assert.equal(await runUpdate({ app: b.repo.path, stateDir: b.stateDir, dataDir: b.dataDir, env: {}, dryRun: true }, ports), undefined, "no CP_DAEMON_JOB needed; no host, daemon or npm port is touched");
	assert.match(b.lines.at(-1) ?? "", /^dry-run: would drain, then update/);
	assert.equal(readUpdateState(b.stateDir), undefined);
	assert.equal(b.repo.head(), head);
});
