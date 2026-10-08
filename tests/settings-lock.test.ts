/**
 * cp-7bsr PR2: `state/settings.lock` (src/settings-lock.ts). O_EXCL acquire, a live holder refuses,
 * an unreadable lock refuses naming the path, a dead holder is reclaimed once, a competing reclaim wins
 * over the loser, and only the nonce holder releases.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import { acquireSettingsLock, settingsLockPath } from "../src/settings-lock.ts";
import { createScratchHome } from "./harness/index.ts";

function home(t: TestContext): string {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	return scratch.path;
}

const plant = (path: string, record: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record));
};

test("acquire: O_EXCL create at 0600; a second acquire while held is busy; release frees it", (t) => {
	const dir = home(t);
	const first = acquireSettingsLock(dir);
	assert.ok(first.ok);
	const path = settingsLockPath(dir);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
	const second = acquireSettingsLock(dir);
	assert.equal(second.ok, false);
	assert.match((second as { reason: string }).reason, /another settings write holds/);
	assert.equal(first.release(), true);
	assert.equal(existsSync(path), false);
	const third = acquireSettingsLock(dir);
	assert.ok(third.ok);
	third.release();
});

test("acquire: an unreadable or garbage lock refuses, naming the path; nothing is removed", (t) => {
	const dir = home(t);
	const path = settingsLockPath(dir);
	for (const garbage of ["", "{nope", JSON.stringify({ pid: "x" })]) {
		plant(path, garbage);
		const result = acquireSettingsLock(dir);
		assert.equal(result.ok, false);
		assert.ok((result as { reason: string }).reason.includes(path), (result as { reason: string }).reason);
		assert.equal(readFileSync(path, "utf8"), garbage);
	}
});

test("acquire: a dead holder is reclaimed once and reported", (t) => {
	const dir = home(t);
	const path = settingsLockPath(dir);
	const stale = { schema_version: 1, pid: 999_999, started_at: "2026-01-01T00:00:00Z", nonce: "dead" };
	plant(path, stale);
	const result = acquireSettingsLock(dir, { isPidAlive: () => false });
	assert.ok(result.ok);
	assert.deepEqual(result.reclaimed, stale);
	assert.notEqual(JSON.parse(readFileSync(path, "utf8")).nonce, "dead");
	assert.ok(result.release());
});

test("acquire: a competing reclaim in onBeforeReclaim wins; the loser refuses and leaves the winner's lock", (t) => {
	const dir = home(t);
	const path = settingsLockPath(dir);
	plant(path, { schema_version: 1, pid: 999_999, started_at: "2026-01-01T00:00:00Z", nonce: "dead" });
	let winner: ReturnType<typeof acquireSettingsLock> | undefined;
	const loser = acquireSettingsLock(dir, {
		isPidAlive: (pid) => pid !== 999_999,
		onBeforeReclaim: () => { winner = acquireSettingsLock(dir, { isPidAlive: () => false }); },
	});
	assert.ok(winner?.ok, "the competing reclaim took the lock");
	assert.equal(loser.ok, false);
	assert.match((loser as { reason: string }).reason, /changed while it was being reclaimed/);
	assert.ok(existsSync(path));
	assert.ok(winner.ok && winner.release());
});

test("release: only by nonce — a reclaimed holder cannot delete its successor's lock", (t) => {
	const dir = home(t);
	const path = settingsLockPath(dir);
	const old = acquireSettingsLock(dir, { pid: 999_998 });
	assert.ok(old.ok);
	const successor = acquireSettingsLock(dir, { isPidAlive: () => false });
	assert.ok(successor.ok, "the dead holder's lock was reclaimed");
	assert.equal(old.release(), false, "the old holder's release is a no-op");
	assert.ok(existsSync(path));
	assert.equal(successor.release(), true);
	assert.equal(existsSync(path), false);
});
