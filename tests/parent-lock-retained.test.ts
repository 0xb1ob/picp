/** Helper-only lock contracts retained beside the S27 public startup and shutdown scenarios. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { FLEET_MUTATING_TOOLS, LAYOUT, SCHEMA_VERSION, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import { join } from "node:path";
import { acquireParentLock, formatParentLock, parentLockPath, parseParentLock, readParentLock, releaseParentLock } from "../src/parent-lock.ts";
import { commandPostSource, createScratchHome } from "./harness/index.ts";
/** A pid that cannot be alive (see tests/fleet-retained.test.ts's DEAD_PID). */
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
