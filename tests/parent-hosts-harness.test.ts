import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScratchHome } from "./harness/index.ts";
import { parentHostPids, teardownHome } from "./harness/parent-hosts.ts";

/** A detached stand-in with src/parent-host.ts's argv shape (`parent-host.ts <home> multi <gen>`), plus its bin dir. */
function fakeHosts() {
	const bin = mkdtempSync(join(tmpdir(), "cp-host-bin-"));
	const script = join(bin, "parent-host.ts");
	writeFileSync(script, "setInterval(() => {}, 1000);\n");
	const start = (home: string) => {
		const child = spawn(process.execPath, [script, home, "multi", "1"], { detached: true, stdio: "ignore" });
		child.unref();
		return child.pid!;
	};
	return { start, remove: () => rmSync(bin, { recursive: true, force: true }) };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
}

// testleak-44z: a detached host named after a scratch home dies with that home, and only that one.
test("scratch home cleanup kills a detached parent-host for that home and no other", { timeout: 30_000 }, async (t) => {
	const hosts = fakeHosts();
	const home = createScratchHome();
	const other = createScratchHome();
	// Registered before any assertion: a failure below still stops both hosts.
	t.after(async () => {
		try { await teardownHome(home); } finally {
			try { await teardownHome(other); } finally { hosts.remove(); }
		}
	});
	const pid = hosts.start(home.path);
	const otherPid = hosts.start(other.path);
	await until(() => parentHostPids(home.path).length > 0 && parentHostPids(other.path).length > 0);
	assert.deepEqual(parentHostPids(home.path), [pid]);
	home.cleanup();
	await until(() => parentHostPids(home.path).length === 0, 5_000);
	assert.deepEqual(parentHostPids(home.path), [], "cleanup killed the home's host");
	assert.deepEqual(parentHostPids(other.path), [otherPid], "another home's host is untouched");
});

test("teardownHome runs every step, stops the host and removes the home when a step throws", { timeout: 30_000 }, async (t) => {
	const hosts = fakeHosts();
	const home = createScratchHome();
	t.after(async () => {
		try { await teardownHome(home); } finally { hosts.remove(); }
	});
	hosts.start(home.path);
	await until(() => parentHostPids(home.path).length > 0);
	assert.equal(parentHostPids(home.path).length, 1);
	const ran: string[] = [];
	await assert.rejects(teardownHome(home,
		() => { ran.push("close"); throw new Error("child.close failed"); },
		async () => { ran.push("stop"); throw new Error("provider.stop failed"); },
		() => void ran.push("last"),
	), /child\.close failed/, "the first failure is rethrown");
	assert.deepEqual(ran, ["close", "stop", "last"], "a failing step never skips the next");
	assert.deepEqual(parentHostPids(home.path), [], "the host was stopped anyway");
	assert.equal(existsSync(home.path), false, "the home was removed anyway");
});
