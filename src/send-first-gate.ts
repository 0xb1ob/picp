/**
 * Send-first wake hold (unload-parent PR3): an operator send that landed in
 * the parent's context is answered before bulk fleet wake-ups pile on top of
 * it. While a landed send is unanswered, every wake-up except `answered` is
 * held in memory and released when the send is answered (a clean `turn_end`),
 * when the run settles, or after `SEND_FIRST_HOLD_MS` — whichever comes first.
 *
 * Holding never acks anything: a durable wake-up's arrival is still confirmed
 * only when the released message reaches the parent (`message_start` /
 * `context`), and the outbox re-sends one that never arrives. Pure state; the
 * caller (extensions/command-post/wakeup-surfaces.ts) owns the transport.
 */
import { cleanSegmentEnd } from "./bridge-segments.ts";
import { sendIdsInText } from "./parent-outbox.ts";

/**
 * ponytail: 90 s, under the 120 s durable re-send (`DURABLE_WAKEUP_RETRY_SECONDS`),
 * so a held copy goes out before its outbox retry would add a second one.
 */
export const SEND_FIRST_HOLD_MS = 90_000;

export class SendFirstGate<Wake> {
	readonly #now: () => number;
	readonly #unanswered = new Set<string>();
	#held: Wake[] = [];
	#since = 0;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** A message reached the parent: a user message's `[cp-send …]` markers are landed, unanswered sends. */
	userMessage(role: unknown, text: string): void {
		if (role !== "user") return;
		for (const id of sendIdsInText(text)) this.#unanswered.add(id);
	}

	/** A clean `turn_end` (the bridge's segment end) answered every send that landed before it. */
	turnEnd(event: { type: string; [key: string]: unknown }): void {
		if (cleanSegmentEnd(event)) this.#unanswered.clear();
	}

	/** The run settled: whatever it did not answer, the bridge has already settled or failed. */
	settled(): void {
		this.#unanswered.clear();
	}

	/** `send` now, or `hold` (kept until `flush`). `answered` always goes. */
	offer(kind: string, wake: Wake): "send" | "hold" {
		if (kind === "answered" || this.#unanswered.size === 0) return "send";
		if (this.#held.length === 0) this.#since = this.#now();
		this.#held.push(wake);
		return "hold";
	}

	/** The held wakes to send now: all of them once nothing is unanswered or the oldest waited the hold. */
	flush(): Wake[] {
		if (this.#held.length === 0) return [];
		if (this.#unanswered.size > 0 && this.#now() - this.#since < SEND_FIRST_HOLD_MS) return [];
		const released = this.#held;
		this.#held = [];
		return released;
	}

	get unanswered(): number {
		return this.#unanswered.size;
	}
}
