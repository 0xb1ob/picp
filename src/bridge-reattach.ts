/**
 * The operator session's reattach loop (cp-bridge-auto-reattach). When the host connection closes
 * (cp-daemon reload, host restart) `schedule` retries `attempt` after 1 s, doubling up to 30 s, for
 * as long as the session lives. At most one loop runs; `cancel` stops it for good, and an attempt
 * already in flight cannot reschedule. `attempt` must only read — it never starts a host or parent.
 */
export const REATTACH_FIRST_MS = 1_000;
export const REATTACH_MAX_MS = 30_000;

export interface Reattach {
	/** Start the loop unless one is already running. */
	schedule(): void;
	cancel(): void;
}

export function reattachLoop(attempt: () => Promise<void>, firstMs = REATTACH_FIRST_MS, maxMs = REATTACH_MAX_MS): Reattach {
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	let again = false; // a close landed while an attempt was still finishing
	let epoch = 0;
	const schedule = (): void => {
		if (running) { again = true; return; }
		running = true;
		const mine = ++epoch;
		const step = (delay: number): void => {
			timer = setTimeout(() => {
				timer = undefined;
				attempt().then(
					() => {
						if (mine !== epoch) return;
						running = false;
						if (again) { again = false; schedule(); }
					},
					() => { if (mine === epoch) step(Math.min(delay * 2, maxMs)); },
				);
			}, delay);
			timer.unref();
		};
		step(firstMs);
	};
	return {
		schedule,
		cancel() {
			epoch++;
			running = false;
			again = false;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
