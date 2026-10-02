import type { BridgeRelay } from "./cp-bridge.ts";

const ESCALATION_ID = /\bes-[a-z0-9]{4,16}\b/g;

/**
 * Operator-side relay gate. Relays that arrive while the operator's own turn runs are held
 * and delivered on settle, rechecked then: an escalation answered meanwhile, or one whose id
 * the operator already read in a send reply, is dropped.
 */
export class OperatorRelayQueue {
	#running = false;
	readonly #queued: BridgeRelay[] = [];
	readonly #replied = new Set<string>();

	readonly #deliver: (relay: BridgeRelay) => void;
	readonly #recheck: (relay: BridgeRelay) => BridgeRelay | undefined;

	constructor(deliver: (relay: BridgeRelay) => void, recheck: (relay: BridgeRelay) => BridgeRelay | undefined) {
		this.#deliver = deliver;
		this.#recheck = recheck;
	}

	/** Record the escalation ids named in a send reply the operator already has. */
	replied(text: string | undefined): void {
		for (const match of text?.matchAll(ESCALATION_ID) ?? []) this.#replied.add(match[0]);
	}

	started(): void { this.#running = true; }

	push(relay: BridgeRelay): void {
		if (this.#running) this.#queued.push(relay);
		else this.#flush([relay]);
	}

	settled(): void {
		this.#running = false;
		this.#flush(this.#queued.splice(0));
	}

	#flush(relays: BridgeRelay[]): void {
		// A send reply settles after the escalations raised in its turn: read it first.
		for (const relay of relays) if (relay.kind === "send") this.replied(relay.text);
		for (const relay of relays) {
			if (relay.escalationId && this.#replied.has(relay.escalationId)) continue;
			const current = this.#recheck(relay);
			if (current) this.#deliver(current);
		}
	}
}
