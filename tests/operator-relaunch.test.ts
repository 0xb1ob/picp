/**
 * Restart session (cp-aqxl), src/operator-relaunch.ts: the pid-bound 0600 marker, the resume argv, the pending
 * `cp_parent send` read, the blocker lines, the bridge's ports, and the launcher loop's cap and signal stop.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { layoutForHome } from "../src/contracts.ts";
import { pendingParentSends, RELAUNCH_ENV, relaunchArgs, relaunchFileFor, relaunchPorts, restartBlockers, superviseOperatorPi, takeRelaunchMarker, writeRelaunchMarker } from "../src/operator-relaunch.ts";
import { createScratchHome } from "./harness/index.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home.path;
}
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const SESSION = "/home/u/.pi/agent/sessions/x/2026-01-01T00-00-00-000Z_0123abcd.jsonl";
const ID = "dc-20260101000000-0123abcd";

test("marker: written 0600 through a tmp file; taken (and removed) only for the matching pid; another pid, malformed or a relative path is left alone", (t) => {
	const file = relaunchFileFor(scratch(t), "multi");
	assert.match(file, /\/operator\/relaunch\.json$/);
	assert.deepEqual(writeRelaunchMarker(file, { id: ID, pid: 4242, session_file: SESSION, at: "2026-01-01T00:00:00.000Z" }), { ok: true });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no tmp file left behind");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, id: ID, pid: 4242, session_file: SESSION, at: "2026-01-01T00:00:00.000Z" });

	assert.equal(takeRelaunchMarker(file, 4243), undefined, "another pid");
	assert.equal(existsSync(file), true, "is left in place");
	assert.deepEqual(takeRelaunchMarker(file, 4242), { id: ID, session_file: SESSION });
	assert.equal(existsSync(file), false, "taken: removed");
	assert.equal(takeRelaunchMarker(file, 4242), undefined, "absent");

	for (const bad of ["not json", JSON.stringify({ version: 2, id: ID, pid: 1, session_file: SESSION }), JSON.stringify({ version: 1, id: ID, pid: 1, session_file: "relative.jsonl" }), JSON.stringify({ version: 1, id: ID, pid: 1, session_file: "/etc/passwd" })]) {
		put(file, bad);
		assert.equal(takeRelaunchMarker(file, 1), undefined, bad);
		assert.equal(existsSync(file), true, `${bad}: left alone`);
	}
	put(join(dirname(file), "blocked"), "");
	assert.equal(writeRelaunchMarker(join(dirname(file), "blocked", "relaunch.json"), { id: ID, pid: 1, session_file: SESSION, at: "x" }).ok, false, "an unwritable path says so");
});

test("relaunchArgs: the exact session file, or -c when it is gone", () => {
	assert.deepEqual(relaunchArgs({ session_file: SESSION }, () => true), ["--session", SESSION]);
	assert.deepEqual(relaunchArgs({ session_file: SESSION }, () => false), ["-c"]);
});

test("pendingParentSends: unobserved and queued < 24 h counts; observed or older does not; invalid JSON is an error, never none", (t) => {
	const home = scratch(t);
	const file = join(home, layoutForHome("multi", home).sessions, "cp-parent.sends.json");
	const now = new Date("2026-01-02T12:00:00Z");
	const entry = (id: string, queued_at: string, extra: object = {}) => ({ schema_version: 1, id, text: "x", queued_at, state: "settled", attempts: 1, ...extra });
	assert.deepEqual(pendingParentSends(home, "multi", now), { ids: [], error: null }, "no outbox: nothing pending");
	put(file, JSON.stringify({ schema_version: 1, updated_at: "2026-01-02T12:00:00Z", entries: [
		entry("ps-20260102110000-0123abcd", "2026-01-02T11:00:00Z", { state: "injected" }),
		entry("ps-20260102100000-0123abce", "2026-01-02T10:00:00Z", { owner_observed_at: "2026-01-02T10:05:00Z" }),
		entry("ps-20260101000000-0123abcf", "2026-01-01T00:00:00Z"),
	] }));
	assert.deepEqual(pendingParentSends(home, "multi", now), { ids: ["ps-20260102110000-0123abcd"], error: null });
	put(file, "{not json");
	const broken = pendingParentSends(home, "multi", now);
	assert.deepEqual(broken.ids, []);
	assert.match(String(broken.error), /not valid JSON/);
});

test("restartBlockers: one line per blocker, in a fixed order; none is empty", () => {
	assert.deepEqual(restartBlockers({ idle: true, pendingMessages: false, openRequests: 0, unrecordedAsks: [], parentSends: { ids: [], error: null } }), []);
	assert.deepEqual(restartBlockers({ idle: false, pendingMessages: true, openRequests: 2, unrecordedAsks: ["ask-abcd"], parentSends: { ids: ["ps-20260101000000-0123abcd"], error: "boom" } }), [
		"the session is busy with a turn",
		"messages are queued for the session",
		"2 dashboard request(s) injected but not seen by the session yet",
		"ask ask-abcd answered from the dashboard but not recorded yet",
		"cp_parent send ps-20260101000000-0123abcd pending",
		"parent send outbox unreadable: boom",
	]);
});

test("relaunchPorts: the relaunch file only when absolute; shutdown goes through whenIdle to ctx.shutdown", (t) => {
	const home = scratch(t);
	let shutdowns = 0;
	const deferred: Array<() => void> = [];
	const ports = relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => ({ shutdown: () => { shutdowns += 1; } }), whenIdle: (fn) => deferred.push(fn), env: { [RELAUNCH_ENV]: "/abs/relaunch.json" } });
	assert.equal(ports.relaunchFile(), "/abs/relaunch.json");
	assert.equal(relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => undefined, whenIdle: (fn) => fn(), env: { [RELAUNCH_ENV]: "rel/relaunch.json" } }).relaunchFile(), undefined, "relative: unsupported");
	assert.equal(relaunchPorts({ target: () => ({ home, mode: "multi" }), ctx: () => undefined, whenIdle: (fn) => fn(), env: {} }).relaunchFile(), undefined, "plain pi: unsupported");
	ports.shutdown();
	assert.equal(shutdowns, 0, "deferred while compaction runs");
	deferred.shift()!();
	assert.equal(shutdowns, 1);
	assert.deepEqual(ports.parentSends(), { ids: [], error: null });
});

/** A child that exits on the next tick with `code`, having run `before` (the marker the bridge would write). */
function fakeChild(pid: number, code: number, before: () => void = () => {}): ChildProcess {
	const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: () => true });
	setImmediate(() => { before(); child.emit("exit", code, null); });
	return child as unknown as ChildProcess;
}

test("superviseOperatorPi: relaunches on its own child's marker within the cap (the window slides), passes the env handshake, and never after a launcher signal", async (t) => {
	const file = relaunchFileFor(scratch(t), "multi");
	const marker = (pid: number) => () => { writeRelaunchMarker(file, { id: ID, pid, session_file: SESSION, at: "x" }); };
	const steps = [1, 1, 10, 1, 1].map((minutes) => minutes * 60_000);
	let clock = 0;
	let pid = 100;
	const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
	const lines: string[] = [];
	const code = await superviseOperatorPi({
		spawnPi: (args, env) => { spawned.push({ args, env }); clock += steps[spawned.length - 1] ?? 0; pid += 1; return fakeChild(pid, 0, marker(pid)); },
		firstArgs: ["--model", "m"], relaunchFile: file, limit: { count: 2, windowMs: 10 * 60_000 }, now: () => clock, log: (line) => lines.push(line),
	});
	assert.equal(code, 0);
	// Exits at 1, 2 min relaunch (2 in the window); at 12 both have aged out, so it relaunches; at 13 again; at 14 the cap (12, 13) stops it.
	assert.equal(spawned.length, 5);
	assert.deepEqual(spawned[0]!.args, ["--model", "m"]);
	assert.ok(spawned.slice(1).every((run) => run.args[0] === "-c" || run.args[0] === "--session"));
	assert.ok(spawned.every((run) => run.env[RELAUNCH_ENV] === file), "every pi learns where the marker goes");
	assert.match(lines.at(-1)!, /^cp-operator: not restarting: 2 restarts within 10 min/);

	let signalled = false;
	const once = await superviseOperatorPi({ spawnPi: () => fakeChild(500, 143, () => { marker(500)(); signalled = true; }), firstArgs: [], relaunchFile: file, log: () => {}, stopped: () => signalled });
	assert.equal(once, 143, "signalled launcher: the marker is ignored and the code returned");
	const noFile = await superviseOperatorPi({ spawnPi: (_args, env) => { assert.equal(env[RELAUNCH_ENV], undefined); return fakeChild(501, 5); }, firstArgs: [], log: () => {} });
	assert.equal(noFile, 5, "no relaunch file: no handshake, one run");
});
