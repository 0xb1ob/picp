/**
 * Web Push (Pier 1.1): host the push sweep while this session holds the parent lock. The policy is
 * src/push/sweep.ts; this only runs it on a timer, never overlapping, and never lets it throw into the parent.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LAYOUT } from "../../src/contracts.ts";
import { escalationProjects, homeMandateProjects, homeProjectResolver } from "../../src/project-report.ts";
import { runPushSweep } from "../../src/push/sweep.ts";
import type { ExtensionDeps } from "./shared.ts";

/** At most this long between an ask landing on disk and its push leaving. */
export const PUSH_TICK_MS = 15_000;

const log = (line: string): void => {
	process.stderr.write(`pi-command-post: ${line}\n`);
};

export function registerPushTick(pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean): void {
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) return; // non-overlapping: a slow push service never stacks sweeps
		running = true;
		try {
			const post = deps.commandPost();
			await runPushSweep({
				stateDir: join(post.home, LAYOUT.state),
				dataDir: join(post.home, LAYOUT.data),
				openEscalations: () => post.escalations.open(),
				openAwaiting: () => post.awaiting.list("open"),
				pendingFinalFix: () => post.finalFixCheckpoints.listPending(),
				projectsOf: (candidate) =>
					escalationProjects(
						{ job_ids: candidate.job_ids, ...(candidate.mandate_id ? { mandate_id: candidate.mandate_id } : {}) },
						homeProjectResolver(post.home),
						homeMandateProjects(post.home),
					),
				log,
			});
		} catch (error) {
			log(`push tick failed: ${(error as Error).message}`);
		} finally {
			running = false;
		}
	};
	// Registered after the session hooks, so the lock is already decided when this runs.
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), PUSH_TICK_MS);
		timer.unref();
		setTimeout(() => void tick(), 0).unref(); // catch-up pass, after startup returns
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
