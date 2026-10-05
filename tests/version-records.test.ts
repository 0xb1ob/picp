/**
 * cp-kz20: the records the version badge reads carry the commit their process loaded — additive and optional,
 * so a record written before this change still parses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isPidAlive } from "../src/fleet.ts";
import { attachParentHost, currentHost, ParentHostClient, parentHostPaths } from "../src/parent-host.ts";
import { acquireParentLock, parentLockPath, parseParentLock, readParentLock } from "../src/parent-lock.ts";
import { headCommit } from "../src/viewer/loaded-commit.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "fixtures/fake-parent.mjs");
const SHA = "a".repeat(40);

test("parent.lock: a valid commit round-trips; a malformed one and a pre-cp-kz20 lock without one still parse", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const acquired = acquireParentLock({ home: home.path, commit: SHA });
	assert.ok(acquired.ok);
	const read = readParentLock(home.path);
	assert.equal(read.state === "held" ? read.record.commit : undefined, SHA);
	assert.match(readFileSync(parentLockPath(home.path), "utf8"), new RegExp(`"commit": "${SHA}"`));
	const legacy = { pid: 7, started_at: "2026-10-01T00:00:00Z", home: "/h" };
	assert.ok(parseParentLock(JSON.stringify(legacy)), "a lock without a commit is still a lock");
	assert.equal(parseParentLock(JSON.stringify(legacy))?.commit, undefined);
	assert.equal(parseParentLock(JSON.stringify({ ...legacy, commit: "not-a-sha" }))?.commit, undefined);
	assert.equal(parseParentLock(JSON.stringify({ ...legacy, commit: SHA }))?.commit, SHA);
});

test("parent-host.<gen>.json: the host writes the commit it loaded", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const paths = parentHostPaths(home.path, "multi");
	const env = { PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_PARENT_PI_BIN: FAKE_PARENT };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(async () => {
		const { record } = currentHost(paths);
		if (record && isPidAlive(record.pid)) {
			const client = await ParentHostClient.connect(record, 5_000).catch(() => undefined);
			await client?.request("stop").catch(() => undefined);
			if (client) await client.closed;
			if (isPidAlive(record.pid)) process.kill(record.pid, "SIGKILL");
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		home.cleanup();
	});
	const client = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	client.disconnect();
	const head = await headCommit(REPO_ROOT);
	assert.ok(head, "this checkout's HEAD is readable");
	assert.equal(currentHost(paths).record?.commit, head.sha);
});
