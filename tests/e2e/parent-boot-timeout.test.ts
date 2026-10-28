/**
 * Issue 537 fix 3: the parent's cold-start `get_state` budget scales with its session file, through a real detached
 * parent host and the fake pi parent (FAKE_PARENT_BOOT_DELAY_MS delays only the first get_state). The configured
 * request timeout is the base, so a 5 s base stands in for production's 30 s.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import "../harness/fake-parent-tracker.ts";
import { teardownHome } from "../harness/parent-hosts.ts";
import { attachParentHost, parentHostPaths } from "../../src/parent-host.ts";
import { createScratchHome } from "../harness/index.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "..", "fixtures", "fake-parent.mjs");
const BASE_MS = 5_000;
const DELAY_MS = 8_000;

async function bootWith(t: import("node:test").TestContext, sessionBytes: number) {
	const home = createScratchHome();
	const previous = process.env.FAKE_PARENT_BOOT_DELAY_MS;
	process.env.FAKE_PARENT_BOOT_DELAY_MS = String(DELAY_MS);
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	if (previous === undefined) delete process.env.FAKE_PARENT_BOOT_DELAY_MS; else process.env.FAKE_PARENT_BOOT_DELAY_MS = previous;
	t.after(() => teardownHome(home, () => host.disconnect()));
	const sessionFile = join(home.path, "boot", "cp-parent.jsonl");
	mkdirSync(join(sessionFile, ".."), { recursive: true });
	const line = `${JSON.stringify({ type: "session", pad: "x".repeat(1000) })}\n`;
	writeFileSync(sessionFile, line.repeat(Math.ceil(sessionBytes / line.length)));
	const started = host.request("start", { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT,
		requestTimeoutMs: BASE_MS, sessionFile });
	return { started, log: () => readFileSync(parentHostPaths(home.path, "multi").log, "utf8") };
}

test("P537-boot-large: a 2 MiB session gets a longer get_state budget and the boot phase is logged", { timeout: 60_000 }, async (t) => {
	const { started, log } = await bootWith(t, 2 * 1024 * 1024);
	const result = await started as { pid?: number };
	assert.ok(result.pid, "the parent started past the base budget");
	assert.match(log(), /parent boot: get_state answered in \d+ms \(session 2\.0 MiB, budget 35\d{3}ms\)/);
});

test("P537-boot-small: a 10 KiB session keeps the base budget and its timeout names get_state, size and budget", { timeout: 60_000 }, async (t) => {
	const { started, log } = await bootWith(t, 10 * 1024);
	await assert.rejects(started, /parent boot: get_state failed \(session 0\.0 MiB, budget 51\d{2}ms\): timeout after 51\d{2}ms/);
	assert.match(log(), /parent boot: get_state failed after \d+ms \(session 0\.0 MiB, budget 51\d{2}ms\)/);
});
