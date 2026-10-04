/**
 * Direct escalation relay (unload-parent PR1). An escalation raised by code (`raiseRiskHigh`,
 * `raiseForGate`, `raiseMissionEnd`, …) has no `cp_escalate` bridge relay, so it waited out the
 * operator session's 600 s backstop. The parent host, which already owns `relay-outbox.json`,
 * enqueues it under its stable `esc:<id>` after a short grace (the parent's own relay wins the
 * same id inside it). Delivery, ack and the open-at-delivery recheck are the existing outbox
 * path; the 600 s backstop stays for anything never delivered.
 *
 * Notification only, and read-only here: no ledger or store write. The operator consumer notes
 * "bridge" in the ledger on delivery, so the backstop skips what this relayed.
 */
import type { BridgeRelay } from "./cp-bridge.ts";
import type { Escalation } from "./contracts.ts";
import { dueEscalations, escalationRelay } from "./escalation-backstop.ts";
import type { OperatorAsk } from "./operator-asks.ts";

export const ESCALATION_RELAY_GRACE_SECONDS = 10;

/** Is any outbox entry (`esc:<id>` or `esc:<id>#n`, pending or closed) already this escalation's? */
const inOutbox = (outboxIds: Iterable<string>, id: string): boolean => {
	for (const entry of outboxIds) if (entry === `esc:${id}` || entry.startsWith(`esc:${id}#`)) return true;
	return false;
};

/** Open, past the grace, no open ask, not in the ledger — and nothing of it in the outbox yet. */
export function dueDirect(input: {
	open: readonly Escalation[];
	asks: readonly OperatorAsk[];
	ledger: ReadonlySet<string>;
	outboxIds: Iterable<string>;
	now: Date;
	graceSeconds?: number;
}): Escalation[] {
	const ids = [...input.outboxIds];
	return dueEscalations({ open: input.open, asks: input.asks, relayed: input.ledger, now: input.now, afterSeconds: input.graceSeconds ?? ESCALATION_RELAY_GRACE_SECONDS })
		.filter((item) => !inOutbox(ids, item.id));
}

export function directRelay(home: string, escalation: Escalation): BridgeRelay {
	return escalationRelay(home, escalation, `${escalation.id} (${escalation.kind}) — ${escalation.question}`);
}

export interface EscalationRelayWatchPorts {
	home: string;
	open(): Escalation[];
	asks(): OperatorAsk[];
	ledgerIds(): Set<string>;
	outboxIds(): string[];
	/** The host's relay publish: outbox enqueue, then subscriber frames. */
	publish(relay: BridgeRelay): void;
	/** Ids already published by this process: stops a failing outbox write from re-framing every tick. */
	sent: Set<string>;
	now?(): Date;
	graceSeconds?: number;
}

/** One pass; returns the ids published. Store, ledger and outbox read errors propagate to the caller's log line. */
export function runEscalationRelayWatch(ports: EscalationRelayWatchPorts): string[] {
	const due = dueDirect({
		open: ports.open(), asks: ports.asks(), ledger: ports.ledgerIds(), outboxIds: ports.outboxIds(), now: ports.now?.() ?? new Date(),
		...(ports.graceSeconds !== undefined ? { graceSeconds: ports.graceSeconds } : {}),
	}).filter((item) => !ports.sent.has(item.id));
	for (const escalation of due) {
		ports.sent.add(escalation.id);
		ports.publish(directRelay(ports.home, escalation));
	}
	return due.map((item) => item.id);
}
