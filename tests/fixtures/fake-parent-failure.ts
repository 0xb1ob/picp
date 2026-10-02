import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { isFakeParentAlive } from "../harness/fake-parent-tracker.ts";

const fakeParent = resolve(import.meta.dirname, "fake-parent.mjs");
process.env.FAKE_PARENT_WORKER_PID_FILE = join(tmpdir(), `fake-parent-worker-${process.pid}`);
let failedTestPids: number[] = [];

test("a failing subtest is cleaned up before the next test", async (t) => {
	await t.test("intentional failure with a live fake-parent", async () => {
		spawn(process.execPath, [fakeParent], { stdio: ["pipe", "ignore", "ignore"] });
		const pidFile = process.env.FAKE_PARENT_PID_FILE;
		for (let attempt = 0; attempt < 100; attempt++) {
			if (pidFile && existsSync(pidFile)) {
				failedTestPids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).pid);
				if (failedTestPids.length >= 2) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(failedTestPids.length >= 2, `expected parent and descendant pids, got ${failedTestPids}`);
		assert.fail("intentional subtest failure exercises the afterEach cleanup hook");
	});
});

test("afterEach removed the failed subtest's fake-parent processes", () => {
	assert.ok(failedTestPids.length >= 2, "the failed subtest did not capture parent and descendant pids");
	const survivors = failedTestPids.filter(isFakeParentAlive);
	assert.deepEqual(survivors, [], `fake-parent pids survived into the next test: ${survivors.join(", ")}`);
});
