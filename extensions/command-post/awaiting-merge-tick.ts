/**
 * awaiting_merge PR6: host the one home-wide parked-PR sweep (src/awaiting-merge-watch.ts) while this session holds
 * the parent lock, at the CI watch's cadence. One timer for every parked PR, never one per job; never overlapping.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ciWatchIntervalMs } from "../../src/ci-watch.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerAwaitingMergeTick(pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean): void {
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			// The sweep journals its own errors as durable wake-ups and never throws.
			await deps.commandPost().awaitingMerge.sweep();
		} catch (error) {
			process.stderr.write(`pi-command-post: awaiting-merge tick failed: ${(error as Error).message}\n`);
		} finally {
			running = false;
		}
	};
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), ciWatchIntervalMs());
		timer.unref();
		setTimeout(() => void tick(), 0).unref(); // catch-up pass, after startup returns
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
