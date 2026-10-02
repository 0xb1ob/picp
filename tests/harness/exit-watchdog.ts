/**
 * A test file whose tests all finished but whose process cannot exit fails
 * loudly instead of hanging `node --test` forever.
 *
 * Without `--test-force-exit`, one leaked handle (a child worker, a socket, a
 * ref'd timer) keeps the file's process alive and the whole run waits without
 * a word. This arms an unref'd timer once the file's root `after` runs: a clean
 * file exits long before it fires; a leaking one reports what is holding it
 * open, kills leaked children (so no orphan `pi` survives the run), and exits 1.
 *
 * Registered at harness import, so this root `after` runs before any root-level
 * `after` a test file adds: such a hook must finish inside the 15s too.
 * No effect under `--test-force-exit`, which exits before the timer can fire.
 */
import { after } from "node:test";

export const EXIT_WATCHDOG_MS = 15_000;

type Handle = { constructor?: { name?: string }; pid?: number; spawnargs?: string[]; kill?: (signal: string) => void };

after(() => {
	const timer = setTimeout(() => {
		// SAFETY: `_getActiveHandles` is undocumented but stable in Node 24; this is diagnostics only.
		const handles = (process as unknown as { _getActiveHandles(): Handle[] })._getActiveHandles();
		const children = handles.filter((handle) => handle.constructor?.name === "ChildProcess");
		const described = children.map((child) => `pid ${child.pid}: ${(child.spawnargs ?? []).slice(0, 4).join(" ")}`);
		process.stderr.write(
			`exit watchdog: tests finished but the process could not exit within ${EXIT_WATCHDOG_MS}ms. ` +
				`Active resources: ${JSON.stringify(process.getActiveResourcesInfo())}` +
				`${described.length > 0 ? `\nleaked child processes (killed):\n  ${described.join("\n  ")}` : ""}\n`,
		);
		// ponytail: direct children only; a worker's own bash descendants survive. Process-group kill is the upgrade.
		for (const child of children) child.kill?.("SIGKILL");
		process.exit(1);
	}, EXIT_WATCHDOG_MS);
	timer.unref();
});
