/**
 * Retained from tests/settings-lock.test.ts (P16b): `acquireSettingsLock`'s `onBeforeReclaim` and `pid` options stage a
 * competing reclaim and a reclaimed holder in one process; no e2e entry point can interleave two settings writes there.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
