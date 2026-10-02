/**
 * Parent hosts a test left running in its scratch home (pi-command-post-testleak-44z).
 *
 * `attachParentHost` spawns `src/parent-host.ts <home> <mode> <gen>` detached, and a
 * session's shutdown only disconnects from it — by design the host outlives its
 * operator. A test that starts one through a pi child has no host record teardown of
 * its own, so the host outlived the run. These helpers find hosts by the home in
 * their argv and kill only those: never the real home, never the live parent.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScratchHome } from "./state.ts";

/** Live (non-zombie) pids running `parent-host.ts` for exactly `home`. Linux /proc only; elsewhere none are seen. */
export function parentHostPids(home: string): number[] {
	const target = resolve(home);
	let entries: string[];
	try { entries = readdirSync("/proc"); } catch { return []; } // ponytail: /proc only; add a `ps` fallback if tests run off Linux
	return entries.filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
		try {
			const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			const at = argv.findIndex((arg) => arg.endsWith("parent-host.ts"));
			if (at < 0 || argv[at + 1] !== target) return false;
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return !stat.slice(stat.lastIndexOf(")") + 1).trimStart().startsWith("Z ");
		} catch { return false; } // exited while scanning
	});
}

/** SIGKILL each host's process group (a detached host leads its own); best effort, never throws. */
export function killParentHosts(home: string): number[] {
	const pids = parentHostPids(home);
	for (const pid of pids) {
		try { process.kill(-pid, "SIGKILL"); } catch {
			try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
		}
	}
	return pids;
}

/** Kill every host left for `home`, then fail the test if any is still running after `ms`. */
export async function stopParentHosts(home: string, ms = 5_000): Promise<void> {
	killParentHosts(home);
	const deadline = Date.now() + ms;
	while (parentHostPids(home).length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	assert.deepEqual(parentHostPids(home), [], `parent-host processes survived for ${home}`);
}

/**
 * Teardown that cannot skip itself: run every step even when one throws, then stop the
 * home's hosts and remove it. The first failure is rethrown only after all of that ran.
 */
export async function teardownHome(home: ScratchHome, ...steps: Array<() => unknown>): Promise<void> {
	const failures: unknown[] = [];
	for (const step of [...steps, () => stopParentHosts(home.path)]) {
		try { await step(); } catch (error) { failures.push(error); }
	}
	home.cleanup(); // never throws
	if (failures.length) throw failures[0];
}
