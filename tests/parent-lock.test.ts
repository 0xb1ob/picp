/**
 * cp-epy2 §4.2 item 2 acceptance: one parent process per home, enforced.
 *
 * The lock is load-bearing rather than belt-and-braces, so every test here is
 * about a refusal: a second live parent, a lock this build cannot read, a home
 * it cannot write. The one thing it may do on its own is take over a lock
 * whose holder is *provably* gone — and even that is reported, not silent.
 *
 * The last test in the file is the one the whole thing exists for: a refused
 * parent must not reconcile, because reconcile is `fleet.json`'s whole-array
 * read-modify-write and cp-ga6j showed two parents doing it erase live jobs.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	FLEET_MUTATING_TOOLS,
	type FleetRecord,
	isoTimestamp,
	LAYOUT,
	SCHEMA_VERSION,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import {
	acquireParentLock,
	formatParentLock,
	parentLockPath,
	parseParentLock,
	readParentLock,
	releaseParentLock,
} from "../src/parent-lock.ts";
import {
	COMMAND_POST_EXTENSION,
	commandPostSource,
	createAgentDir,
	createScratchHome,
	MockProvider,
	readFleet,
	REPO_ROOT,
	startPiChild,
	startRpc,
	waitFor,
} from "./harness/index.ts";

/** A pid that cannot be alive (see tests/fleet.test.ts's DEAD_PID). */
const DEAD_PID = 2 ** 22;

function home(t: { after(fn: () => void): void }) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	mkdirSync(join(scratch.path, LAYOUT.state), { recursive: true });
	return scratch;
}

function lockFile(homePath: string): string {
	return parentLockPath(homePath);
}

function record(jobId: string): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: "/worktrees/demo",
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		worker: {
			pid: DEAD_PID,
			session_id: "sess",
			session_file: "/sessions/gone.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: isoTimestamp(),
		},
	} as FleetRecord;
}

// ---------------------------------------------------------------------------
// taking the home
// ---------------------------------------------------------------------------

test("the first parent takes the home; a second live one is refused by pid", (t) => {
	const scratch = home(t);
	const first = acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => true });
	assert.equal(first.ok, true);
	assert.ok(first.ok && !first.lock.reclaimed);
	assert.match(formatParentLock(first), /held by pid 1001/);

	const written = parseParentLock(readFileSync(lockFile(scratch.path), "utf8"));
	assert.equal(written?.pid, 1001);
	assert.equal(written?.home, scratch.path);
	assert.equal(written?.schema_version, SCHEMA_VERSION);

	const second = acquireParentLock({ home: scratch.path, pid: 1002, isPidAlive: () => true });
	assert.equal(second.ok, false);
	assert.ok(second.ok === false && second.reason.includes("pid 1001"), second.ok === false ? second.reason : "");
	assert.ok(second.ok === false && second.holder?.pid === 1001);
	assert.match(formatParentLock(second), /refused/);

	// The refusal changed nothing: the first parent still holds the home.
	assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, 1001);

	// Released by its holder, the home is free again.
	assert.equal(releaseParentLock({ home: scratch.path, pid: 1001 }), true);
	assert.equal(readParentLock(scratch.path).state, "absent");
	const third = acquireParentLock({ home: scratch.path, pid: 1002, isPidAlive: () => true });
	assert.equal(third.ok, true);
	assert.ok(third.ok && third.lock.record.pid === 1002);
});

test("only the holder releases: a reclaimed parent cannot delete its successor's lock", (t) => {
	const scratch = home(t);
	assert.equal(acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => true }).ok, true);
	assert.equal(releaseParentLock({ home: scratch.path, pid: 9999 }), false, "a non-holder must not release");
	assert.equal(readParentLock(scratch.path).state, "held");
	// And releasing an absent lock is a no-op, never a throw.
	assert.equal(releaseParentLock({ home: scratch.path, pid: 1001 }), true);
	assert.equal(releaseParentLock({ home: scratch.path, pid: 1001 }), false);
});

test("a second session_start in the SAME process is not a second parent", (t) => {
	const scratch = home(t);
	const first = acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => true });
	assert.ok(first.ok);
	const again = acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => true });
	assert.equal(again.ok, true);
	assert.ok(again.ok && again.lock.reentrant, "the holder must not deadlock itself");
	assert.match(formatParentLock(again), /already held by this process/);
});

test("a dead holder's lock is reclaimed, and the reclaim is reported", (t) => {
	const scratch = home(t);
	assert.equal(acquireParentLock({ home: scratch.path, pid: DEAD_PID, isPidAlive: () => false }).ok, true);
	const probed: number[] = [];
	const next = acquireParentLock({
		home: scratch.path,
		pid: 1002,
		isPidAlive: (pid) => {
			probed.push(pid);
			return false;
		},
	});
	assert.equal(next.ok, true);
	assert.deepEqual(probed, [DEAD_PID], "the pid is probed, not assumed");
	assert.ok(next.ok && next.lock.reclaimed?.pid === DEAD_PID);
	assert.match(formatParentLock(next), /reclaimed from pid/);
	assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, 1002);

	// A live pid is never reclaimed, however old the lock looks: nothing is
	// inferred from age (the same rule that removed `stalled` from /status).
	const refused = acquireParentLock({ home: scratch.path, pid: 1003, isPidAlive: () => true });
	assert.equal(refused.ok, false);
});

// ---------------------------------------------------------------------------
// fail closed
// ---------------------------------------------------------------------------

test("an unreadable lock is refused, never assumed free", (t) => {
	const scratch = home(t);
	for (const junk of ["", "not json", '{"pid":"nope","started_at":"2026-09-02T00:00:00Z","home":"/x"}', "{}", '{"pid":7}']) {
		writeFileSync(lockFile(scratch.path), junk);
		const read = readParentLock(scratch.path);
		assert.equal(read.state, "unreadable", `treated as a lock: ${JSON.stringify(junk)}`);
		const result = acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => false });
		assert.equal(result.ok, false, `acquired over an unreadable lock: ${JSON.stringify(junk)}`);
		assert.ok(result.ok === false && /refusing to assume this home is free/.test(result.reason));
		// The file is left exactly as found: an operator decides, not this code.
		assert.equal(readFileSync(lockFile(scratch.path), "utf8"), junk);
	}
});

test(
	"a lock file that cannot be created at all is a refusal (nothing is proven)",
	// root ignores the mode bits, so the fixture would prove nothing there.
	{ skip: process.getuid?.() === 0 ? "running as root" : false },
	(t) => {
		const scratch = home(t);
		const stateDir = join(scratch.path, LAYOUT.state);
		const mode = statSync(stateDir).mode;
		chmodSync(stateDir, 0o500);
		try {
			const result = acquireParentLock({ home: scratch.path, pid: 1001, isPidAlive: () => false });
			assert.equal(result.ok, false);
			assert.ok(result.ok === false && result.reason.includes("cannot take the parent lock"));
		} finally {
			// Restored here, not in an after hook: `home(t)` registered its own
			// cleanup first, and after hooks run in registration order.
			chmodSync(stateDir, mode);
		}
	},
);

test("parseParentLock is strict about the shape it accepts", () => {
	assert.equal(parseParentLock("[]"), undefined);
	assert.equal(parseParentLock("null"), undefined);
	assert.equal(parseParentLock('{"pid":0,"started_at":"2026-09-02T00:00:00Z","home":"/x"}'), undefined);
	assert.equal(parseParentLock('{"pid":7,"started_at":"nope","home":"/x"}'), undefined);
	assert.equal(parseParentLock('{"pid":7,"started_at":"2026-09-02T00:00:00Z","home":""}'), undefined);
	const good = parseParentLock('{"pid":7,"started_at":"2026-09-02T00:00:00Z","home":"/x","session_id":"s"}');
	assert.deepEqual(good, { schema_version: SCHEMA_VERSION, pid: 7, started_at: "2026-09-02T00:00:00Z", home: "/x", session_id: "s" });
});

// ---------------------------------------------------------------------------
// the invariant: a refused parent does not touch fleet state
// ---------------------------------------------------------------------------

test(
	"session_start with a foreign LIVE lock notifies and does not reconcile",
	{ timeout: 60_000 },
	async (t) => {
		const scratch = home(t);
		const store = new FleetStore({ home: scratch.path });
		// A job whose worker is dead: an unrefused parent WOULD move this to
		// `failed` at session_start (tests/fleet.test.ts pins that behaviour), so
		// "still waiting" is proof that reconcile never ran.
		await store.add(record("cp-untouched"));
		const fleetFile = join(scratch.path, LAYOUT.fleetFile);
		const before = readFileSync(fleetFile, "utf8");
		const beforeMtime = statSync(fleetFile).mtimeMs;

		// The test runner itself is the holder: a real, live, foreign pid.
		writeFileSync(
			lockFile(scratch.path),
			`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: process.pid, started_at: isoTimestamp(), home: scratch.path })}\n`,
		);

		const rpc = startRpc({
			cwd: REPO_ROOT,
			args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
			env: { CP_HOME: scratch.path },
		});
		t.after(async () => {
			await rpc.close();
		});

		const notify = await rpc.waitFor(
			(rec) =>
				rec.type === "extension_ui_request" &&
				rec.method === "notify" &&
				typeof rec.message === "string" &&
				rec.message.includes("parent lock"),
			45_000,
		);
		assert.match(String(notify.message), /refused/);
		assert.match(String(notify.message), new RegExp(`pid ${process.pid}`));

		// Nothing moved: the phase, the bytes and the mtime are all as they were.
		assert.equal(readFleet(scratch.path).jobs[0]?.phase, "waiting");
		assert.equal(readFileSync(fleetFile, "utf8"), before);
		assert.equal(statSync(fleetFile).mtimeMs, beforeMtime);
		// And the refused session did not steal the lock on its way past.
		assert.equal(readParentLock(scratch.path).state === "held" && readParentLock(scratch.path).path, lockFile(scratch.path));
		assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, process.pid);
	},
);

test(
	"session_start with a STALE lock reclaims it, reconciles, and releases it on shutdown",
	{ timeout: 60_000 },
	async (t) => {
		const scratch = home(t);
		const store = new FleetStore({ home: scratch.path });
		await store.add(record("cp-stale-start"));
		writeFileSync(
			lockFile(scratch.path),
			`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: DEAD_PID, started_at: isoTimestamp(), home: scratch.path })}\n`,
		);

		const rpc = startRpc({
			cwd: REPO_ROOT,
			args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
			env: { CP_HOME: scratch.path },
		});

		// The reclaim is announced, and then the session behaves like any other:
		// it reconciles the dead worker it inherited.
		await rpc.waitFor(
			(rec) =>
				rec.type === "extension_ui_request" &&
				rec.method === "notify" &&
				typeof rec.message === "string" &&
				rec.message.includes("reclaimed from pid"),
			45_000,
		);
		const reconciled = await waitFor(
			() => readFleet(scratch.path).jobs[0] as FleetRecord,
			(job) => job.phase === "failed",
			{ what: "reconciled phase on disk after a reclaimed lock" },
		);
		assert.equal(reconciled.failure?.class, "crash");

		// The lock is this session's while it lives, and gone once it exits.
		assert.notEqual(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, DEAD_PID);
		// H7: end stdin, then wait on session_shutdown's release (close()'s 5 s grace SIGKILLed pi first).
		rpc.endInput();
		await waitFor(
			() => readParentLock(scratch.path).state,
			(state) => state === "absent",
			{ what: "the parent lock released on session_shutdown" },
		);
		await rpc.close();
	},
);

// ---------------------------------------------------------------------------
// cp-yu5k review, gap 1: two parents reclaiming one stale lock
// ---------------------------------------------------------------------------

test("a reclaim never deletes a live holder's lock: the second reclaimer refuses", (t) => {
	const scratch = home(t);
	// One stale record, and two parents that both read it.
	writeFileSync(
		lockFile(scratch.path),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: DEAD_PID, started_at: "2026-09-02T00:00:00Z", home: scratch.path })}\n`,
	);

	// Parent B moves first, in the window between A classifying the lock as
	// stale and A removing it — the exact interleaving the read-then-unlink
	// shape exposes. Without the confirm-before-unlink, A would delete B's
	// fresh lock and both would believe they hold the home.
	let raced = false;
	const a = acquireParentLock({
		home: scratch.path,
		pid: 1001,
		isPidAlive: (pid) => pid !== DEAD_PID,
		onBeforeReclaim: () => {
			if (raced) return;
			raced = true;
			const b = acquireParentLock({ home: scratch.path, pid: 1002, isPidAlive: (pid) => pid !== DEAD_PID });
			assert.ok(b.ok, "the first reclaimer to act must win the home");
			assert.ok(b.ok && b.lock.reclaimed?.pid === DEAD_PID);
		},
	});

	assert.equal(a.ok, false, "the second reclaimer must refuse, not steal");
	assert.ok(a.ok === false && a.reason.includes("reclaimed by pid 1002"), a.ok === false ? a.reason : "");
	assert.ok(a.ok === false && a.reason.includes("refusing rather than deleting a live holder's lock"));
	// Exactly one holder, and it is the parent that actually took it.
	assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, 1002);
});

test("a stale lock cleared by somebody else is arbitrated by the O_EXCL create", (t) => {
	const scratch = home(t);
	writeFileSync(
		lockFile(scratch.path),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: DEAD_PID, started_at: "2026-09-02T00:00:00Z", home: scratch.path })}\n`,
	);
	// An operator's `rm` (or another reclaim that has not created yet) lands in
	// the same window: there is nothing to unlink, so the create decides.
	const result = acquireParentLock({
		home: scratch.path,
		pid: 1001,
		isPidAlive: () => false,
		onBeforeReclaim: () => rmSync(lockFile(scratch.path), { force: true }),
	});
	assert.equal(result.ok, true);
	assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, 1001);

	// And when the file turns unreadable under the reclaim, it is left alone.
	writeFileSync(lockFile(scratch.path), `${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: DEAD_PID, started_at: "2026-09-02T00:00:00Z", home: scratch.path })}\n`);
	const junked = acquireParentLock({
		home: scratch.path,
		pid: 1003,
		isPidAlive: () => false,
		onBeforeReclaim: () => writeFileSync(lockFile(scratch.path), "corrupt\n"),
	});
	assert.equal(junked.ok, false);
	assert.ok(junked.ok === false && junked.reason.includes("refusing to remove it while reclaiming"));
	assert.equal(readFileSync(lockFile(scratch.path), "utf8"), "corrupt\n");
});

// ---------------------------------------------------------------------------
// cp-yu5k review, gap 2: a refused session may look, but may not move the fleet
// ---------------------------------------------------------------------------

test(
	"a refused session's cp_dispatch is blocked, and state/fleet.json is untouched",
	{ timeout: 120_000 },
	async (t) => {
		const scratch = home(t);
		const store = new FleetStore({ home: scratch.path });
		await store.add(record("cp-lockgate"));
		const fleetFile = join(scratch.path, LAYOUT.fleetFile);
		const before = readFileSync(fleetFile, "utf8");
		const beforeMtime = statSync(fleetFile).mtimeMs;

		// The test runner holds the home: a real, live, foreign pid.
		writeFileSync(
			lockFile(scratch.path),
			`${JSON.stringify({ schema_version: SCHEMA_VERSION, pid: process.pid, started_at: isoTimestamp(), home: scratch.path })}\n`,
		);

		const provider = await MockProvider.start();
		// Two calls: a fleet mutator, which must be refused, and a read-only
		// surface, which must still work — a refused parent's one useful act is
		// to tell the operator who holds the home.
		const model = provider.addScript("lock-gate", [
			{
				kind: "tool_calls",
				calls: [
					{ name: "cp_dispatch", args: { project: "demo", job_id: "cp-lockgate2", task: "do a thing" } },
					{ name: "cp_check", args: { project: "demo", job_id: "cp-lockgate2" } },
				],
			},
			{ kind: "text", text: "acknowledged" },
		]);
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: scratch.path,
			model,
			env: { ...agentDir.env, CP_HOME: scratch.path },
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
		});

		await child.prompt("dispatch cp-lockgate2, then check it");
		await child.waitForSettled(90_000);

		const dispatches = child
			.eventsOfType("tool_execution_end")
			.filter((rec) => rec.toolName === "cp_dispatch");
		assert.equal(dispatches.length, 1, `expected one cp_dispatch attempt, got ${dispatches.length}`);
		const refusal = JSON.stringify((dispatches[0] as { result?: unknown }).result ?? {});
		assert.match(refusal, /needs this home's parent lock/);
		assert.match(refusal, new RegExp(`pid ${process.pid} holds it`));
		assert.match(refusal, /One parent per home is a contract/);

		// The read-only surface was NOT gated: looking is always allowed.
		const checks = child.eventsOfType("tool_execution_end").filter((rec) => rec.toolName === "cp_check");
		assert.equal(checks.length, 1, "a refused session must still be able to look at the home");

		// The fleet is exactly as it was: no new record, no rewritten array, and
		// not even a touched mtime.
		assert.equal(readFileSync(fleetFile, "utf8"), before);
		assert.equal(statSync(fleetFile).mtimeMs, beforeMtime);
		assert.deepEqual(
			readFleet(scratch.path).jobs.map((job) => job.job_id),
			["cp-lockgate"],
		);
		// And the lock still belongs to the process that held it all along.
		assert.equal(parseParentLock(readFileSync(lockFile(scratch.path), "utf8"))?.pid, process.pid);
	},
);

test("every fleet-mutating tool is registered, and no read-only surface is gated", () => {
	// The gate is a list, so the list is the thing that rots. Both halves are
	// pinned: a new fleet tool that forgets the gate, and a read-only surface
	// that quietly acquires one.
	const extension = commandPostSource();
	for (const tool of FLEET_MUTATING_TOOLS) {
		assert.ok(extension.includes(`name: "${tool}"`), `${tool} is gated but not registered`);
	}
	for (const readOnly of ["cp_check", "cp_status_block", "cp_artifact", "cp_awaiting", "cp_memory", "cp_project", "cp_mandate"]) {
		assert.ok(!FLEET_MUTATING_TOOLS.includes(readOnly), `${readOnly} is read-only and must not need the lock`);
	}
	// Every gated tool is also parent-only: a worker could never hold one.
	for (const tool of FLEET_MUTATING_TOOLS) {
		assert.ok(WORKER_FORBIDDEN_TOOLS.includes(tool), `${tool} is gated for the parent but allowed to a worker`);
	}
});
