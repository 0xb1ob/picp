import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { cleanupTrackedFakeParents, isFakeParentAlive } from "./harness/fake-parent-tracker.ts";
import { withZombie } from "./harness/zombie.ts";

test("fake-parent aliveness treats an unreaped zombie as dead", async (t) => {
	await withZombie(t, (zombie, holder) => {
		assert.equal(isFakeParentAlive(zombie), false);
		assert.equal(isFakeParentAlive(holder), true);
	});
});

test("cleanup skips mismatched start times and non-fixture commands", { skip: process.platform !== "linux" }, async (t) => {
	const parent = spawn(process.execPath, [resolve(import.meta.dirname, "fixtures/fake-parent.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
	const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(async () => {
		for (const child of [parent, unrelated]) {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, "close");
				child.kill("SIGKILL");
				await closed;
			}
		}
	});
	parent.stdin.write('{"type":"get_state"}\n');
	await once(parent.stdout, "data");
	const file = process.env.FAKE_PARENT_PID_FILE!;
	const original = readFileSync(file, "utf8");
	const record = JSON.parse(original.trim()) as { pid: number; startTime: string };
	assert.equal(record.pid, parent.pid);
	assert.match(record.startTime, /^\d+$/);
	const stat = readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
	const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
	writeFileSync(file, `${JSON.stringify({ ...record, startTime: "0" })}\n${JSON.stringify({ pid: unrelated.pid, startTime })}\n`);
	await cleanupTrackedFakeParents();
	assert.equal(isFakeParentAlive(parent.pid!), true, "a different start time must not be signalled");
	assert.equal(isFakeParentAlive(unrelated.pid!), true, "a non-fixture command must not be signalled");
	writeFileSync(file, original);
	const exited = once(parent, "exit");
	await cleanupTrackedFakeParents();
	await exited;
	assert.equal(isFakeParentAlive(parent.pid!), false, "a matching fixture must be terminated");
});
