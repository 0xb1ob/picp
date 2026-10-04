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

/** cp-6fyl A5: an open but silent host socket is probed every 60 s with a 5 s `hello`. */
export const HOST_PROBE_MS = 60_000;
export const HOST_PROBE_TIMEOUT_MS = 5_000;

/**
 * True when the host answers `hello` within `timeoutMs` and is still the home's current host
 * (`currentPid()`). False on a timeout, an error or a superseded generation: the caller disconnects
 * and lets `reattachLoop` find the current host.
 */
export async function probeHost(client: { request(op: string): Promise<unknown>; hostPid: number }, currentPid: () => number | undefined, timeoutMs = HOST_PROBE_TIMEOUT_MS): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<false>((done) => { timer = setTimeout(() => done(false), timeoutMs); });
	try {
		const answered = await Promise.race([client.request("hello").then(() => true, () => false), expired]);
		if (!answered) return false;
		try {
			return currentPid() === client.hostPid;
		} catch {
			return true; // an unreadable record is not proof the host was replaced
		}
	} finally {
		clearTimeout(timer);
	}
}
