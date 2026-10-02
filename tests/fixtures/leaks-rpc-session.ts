/**
 * Fixture for tests/test-runner-bounds.test.ts. Deliberately NOT named
 * `*.test.ts`: the suite glob must not pick it up, because it is designed to
 * fail.
 *
 * This is the exact shape that wedged two workers for ~40 minutes
 * (cp-widget-test-hangs): a scratch home whose cleanup hook is registered
 * *before* the hook that closes the pi child writing into it, and a cleanup
 * that throws — as the observed `syscall: 'rm'` error against
 * `/var/folders/.../T/cp-home-*` shows it did.
 *
 * node:test runs `t.after` hooks in registration order and stops at the first
 * one that throws, so `rpc.close()` below never runs. Every test in the file
 * still prints a tick; the process then holds a live child on its event loop
 * and never exits. `--test-timeout` does not bound that — it bounds a test that
 * hangs *inside* a test, not a process that outlives its tests.
 *
 * The harness must therefore make this file terminate anyway.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_POST_EXTENSION, REPO_ROOT } from "../harness/pi-child.ts";
import { startRpc } from "../harness/rpc.ts";
import { createScratchHome } from "../harness/state.ts";

test("leaks an rpc session behind a throwing cleanup hook", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => {
		home.cleanup();
		// Stand-in for the real ENOTEMPTY: the live child is still writing here.
		throw Object.assign(new Error("rm failed"), { syscall: "rm", path: home.path });
	});

	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	// Never runs: the hook above throws first. That is the point of the fixture.
	t.after(async () => {
		await rpc.close();
	});

	const widget = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget");
	assert.ok(widget);
});
