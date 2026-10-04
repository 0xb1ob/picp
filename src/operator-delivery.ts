/**
 * Operator relay consumer (cp-6fyl PR1): the operator session's half of the
 * relay outbox (`src/operator-outbox.ts`). One synchronous pass, `deliverDue`,
 * runs on a socket poke, the 15 s tick, `session_start`/reattach and
 * `agent_settled`, never while the operator's own turn runs. Per pass:
 * fold the outbox and the acks, recheck each pending entry (deliver, discard
 * with a reason, or stale), append every `emit`/`discard` in one write, then
 * hand pi at most two messages — one `send` outcome alone (it keeps
 * `details.send_id`) and every other relay coalesced — each carrying
 * `details.relay_ids`. A throwing hand-off appends `emit_failed`: due again.
 *
 * An id is due while neither acked nor discarded, unless this process emitted
 * it into the current session (its reservation): a new owner or session
 * re-emits, and so does an idle settle with nothing pending in pi (proof pi no
 * longer holds it). Nothing is retired silently: every discard is a line with
 * a reason and a `retired:` note on the next message and the status line.
 */
import type { BridgeRelay } from "./cp-bridge.ts";
import { formatBridgeRelay } from "./cp-bridge.ts";
import { EscalationStore } from "./escalation.ts";
import { type AckLine, OPERATOR_RELAY_OWNER, OPERATOR_RELAY_PROTOCOL, type OperatorRelayAcks, type OperatorRelayEntry, type OperatorRelayOutbox, pendingRelays, relayIdsOfMessage } from "./operator-outbox.ts";
import { ParentSendOutbox, receiptOf } from "./parent-outbox.ts";

/** Wakes, errors and relaunch notices older than this arrive headline-only under `stale — do not act`. */
export const RELAY_STALE_SECONDS = 3_600;
export const RELAY_COALESCE_MAX = 20;
export const RELAY_COALESCE_MAX_CHARS = 24_000;
export const RELAY_TICK_MS = 15_000;
const ESCALATION_ID = /\bes-[a-z0-9]{4,16}\b/g;
const HEADLINE_MAX = 200;

export type RelayVerdict = { deliver: BridgeRelay } | { discard: string };

export interface RelayMessage {
	content: string;
	details: { relay_ids: string[]; send_id?: string };
	/** The relays in this message, for the caller's own bookkeeping (the backstop ledger). */
	relays: BridgeRelay[];
}

export interface RelayConsumerPorts {
	outbox(): OperatorRelayOutbox;
	acks(): OperatorRelayAcks;
	sessionFile(): string | undefined;
	recheck(relay: BridgeRelay): RelayVerdict;
	send(message: RelayMessage): void;
	status(line: string): void;
	now?(): Date;
	owner?: string;
}

interface Due { id: string; relay: BridgeRelay; queuedAt: string; overdue: boolean; direct: boolean }

/** Recheck at delivery: an escalation no longer open, or a send outcome a tool result already returned, is retired. */
export function recheckRelay(home: string, sendsFile: string, relay: BridgeRelay): RelayVerdict {
	if (relay.kind === "send" && relay.sendId) {
		try {
			const entry = new ParentSendOutbox({ file: sendsFile }).get(relay.sendId);
			if (entry && receiptOf(entry).level === "owner_observed") return { discard: "returned in tool result" };
		} catch {
			// An unreadable sends file never hides an outcome: deliver it.
		}
	}
	if (!relay.escalationId) return { deliver: relay };
	try {
		const current = new EscalationStore({ home }).get(relay.escalationId);
		return current && current.status !== "open" ? { discard: `superseded: ${current.status}` } : { deliver: relay };
	} catch (error) {
		return { deliver: { kind: "error", stale: false, text: `Could not verify escalation ${relay.escalationId}: ${(error as Error).message}`, receipt: relay.receipt, paths: [] } };
	}
}

export class OperatorRelayConsumer {
	readonly #ports: RelayConsumerPorts;
	readonly #owner: string;
	#running = false;
	readonly #replied = new Set<string>();
	/** Backstop and legacy-host relays: delivered through this path, never written to the host's outbox. */
	readonly #direct = new Map<string, { relay: BridgeRelay; overdue: boolean; at: string }>();
	readonly #directSeen = new Set<string>();
	readonly #ackedHere = new Set<string>();
	#retired: string[] = [];

	constructor(ports: RelayConsumerPorts) {
		this.#ports = ports;
		this.#owner = ports.owner ?? OPERATOR_RELAY_OWNER;
	}

	#now(): Date {
		return this.#ports.now?.() ?? new Date();
	}

	started(): void {
		this.#running = true;
	}

	/** `idle && !pending`: pi holds nothing, so this session's own unacked emits are due again. */
	settled(state: { idle: boolean; pending: boolean } = { idle: false, pending: true }): void {
		this.#running = false;
		this.deliverDue(state.idle && !state.pending);
	}

	poke(): void {
		this.deliverDue();
	}

	/** A new process or session: record the consumer, compact an oversized journal, deliver. */
	sessionStarted(): void {
		try {
			const acks = this.#ports.acks();
			acks.append([{ type: "consumer", owner: this.#owner, pid: process.pid, ...this.#session(), at: this.#now().toISOString(), protocol: OPERATOR_RELAY_PROTOCOL }]);
			let keep = new Set<string>();
			try { keep = new Set(this.#ports.outbox().read().entries.map((entry) => entry.id)); } catch { /* an unreadable outbox compacts nothing */ }
			if (keep.size > 0) acks.compact(keep);
		} catch (error) {
			this.#ports.status(`cp-relays: journal write failed (${(error as Error).message})`);
		}
		this.deliverDue();
	}

	/** `message_start` / `context`: every relay id this message carries is now in context. */
	ack(message: unknown): void {
		const ids = relayIdsOfMessage(message).filter((id) => !this.#ackedHere.has(id));
		if (ids.length === 0) return;
		const at = this.#now().toISOString();
		try {
			this.#ports.acks().append(ids.map((id) => ({ type: "ack" as const, id, at })));
			for (const id of ids) {
				this.#ackedHere.add(id);
				this.#direct.delete(id);
			}
		} catch (error) {
			this.#ports.status(`cp-relays: ack write failed (${(error as Error).message}); those relays may arrive again`);
		}
	}

	/** Escalation ids named in a send reply the operator already has. */
	replied(text: string | undefined): void {
		for (const match of text?.matchAll(ESCALATION_ID) ?? []) this.#replied.add(match[0]);
	}

	/** A relay that is not in the host's outbox (backstop `overdue`, or a frame from an older host): same path, same acks. */
	direct(relay: BridgeRelay, id: string, overdue = false): void {
		if (this.#directSeen.has(id)) return;
		this.#directSeen.add(id);
		this.#direct.set(id, { relay, overdue, at: this.#now().toISOString() });
		this.deliverDue();
	}

	#session(): { session?: string } {
		const session = this.#ports.sessionFile();
		return session ? { session } : {};
	}

	deliverDue(reclaim = false): void {
		if (this.#running) return;
		let fold;
		try {
			fold = this.#ports.acks().fold();
		} catch (error) {
			return this.#ports.status(`cp-relays: acks unreadable (${(error as Error).message}); nothing delivered`);
		}
		const { session } = this.#session();
		const due = new Map<string, Due>();
		let entries: OperatorRelayEntry[] = [];
		try {
			entries = pendingRelays(this.#ports.outbox().read(), fold);
		} catch (error) {
			this.#ports.status(`cp-relays: outbox unreadable (${(error as Error).message})`);
		}
		for (const entry of entries) {
			const emit = fold.emits.get(entry.id);
			if (!reclaim && emit && emit.owner === this.#owner && emit.session === session) continue;
			due.set(entry.id, { id: entry.id, relay: entry.relay, queuedAt: entry.queued_at, overdue: false, direct: false });
		}
		for (const [id, item] of this.#direct) {
			if (fold.acked.has(id) || fold.discarded.has(id)) this.#direct.delete(id);
			else due.set(id, { id, relay: item.relay, queuedAt: item.at, overdue: item.overdue, direct: true });
		}
		if (due.size === 0) return;
		// A send reply settles after the escalations raised in its turn: read it first.
		for (const item of due.values()) if (item.relay.kind === "send") this.replied(item.relay.text);
		const at = this.#now();
		const lines: AckLine[] = [];
		const deliver: Due[] = [];
		const stale: Due[] = [];
		for (const item of due.values()) {
			const verdict: RelayVerdict = item.relay.escalationId && this.#replied.has(item.relay.escalationId) && !item.overdue
				? { discard: "named in send reply" }
				: this.#ports.recheck(item.relay);
			if ("discard" in verdict) {
				lines.push({ type: "discard", id: item.id, reason: verdict.discard, at: at.toISOString() });
				this.#retired.push(`${item.id} (${verdict.discard})`);
				this.#direct.delete(item.id);
				continue;
			}
			const old = ["wake", "error", "relaunch"].includes(item.relay.kind) && at.getTime() - Date.parse(item.queuedAt) > RELAY_STALE_SECONDS * 1_000;
			(old ? stale : deliver).push({ ...item, relay: verdict.deliver });
		}
		const messages = this.#messages(deliver, stale);
		for (const message of messages) for (const id of message.details.relay_ids) lines.push({ type: "emit", id, owner: this.#owner, ...(session ? { session } : {}), at: at.toISOString() });
		try {
			this.#ports.acks().append(lines);
		} catch (error) {
			return this.#ports.status(`cp-relays: journal write failed (${(error as Error).message}); nothing delivered`);
		}
		for (const message of messages) {
			try {
				this.#ports.send(message);
				for (const id of message.details.relay_ids) this.#direct.delete(id);
			} catch (error) {
				try {
					this.#ports.acks().append(message.details.relay_ids.map((id) => ({ type: "emit_failed" as const, id, owner: this.#owner, at: at.toISOString() })));
				} catch { /* left reserved: the next session or idle settle re-emits it */ }
				this.#ports.status(`cp-relays: delivery failed (${(error as Error).message}); due again`);
			}
		}
		const retired = messages.length > 0 ? this.#retired.splice(0) : this.#retired;
		if (retired.length > 0 || messages.length > 0) {
			const count = messages.reduce((sum, message) => sum + message.details.relay_ids.length, 0);
			this.#ports.status(`cp-relays: ${count} delivered${retired.length > 0 ? `, ${retired.length} retired (${retired.join(", ")})` : ""}`);
		}
	}

	/** One `send` outcome alone, then the rest coalesced (capped; the remainder goes on the next pass). */
	#messages(deliver: Due[], stale: Due[]): RelayMessage[] {
		const out: RelayMessage[] = [];
		const send = deliver.find((item) => item.relay.kind === "send");
		const retiredLine = this.#retired.length > 0 ? `\n\nretired: ${this.#retired.join("; ")}` : "";
		if (send) out.push({ content: formatBridgeRelay(send.relay), details: { relay_ids: [send.id], ...(send.relay.sendId ? { send_id: send.relay.sendId } : {}) }, relays: [send.relay] });
		const rest: Due[] = [];
		let chars = 0;
		for (const item of [...deliver.filter((each) => each.relay.kind !== "send"), ...stale]) {
			const size = stale.includes(item) ? HEADLINE_MAX : formatBridgeRelay(item.relay).length;
			if (rest.length > 0 && (rest.length >= RELAY_COALESCE_MAX || chars + size > RELAY_COALESCE_MAX_CHARS)) break;
			rest.push(item);
			chars += size;
		}
		const fresh = rest.filter((item) => !stale.includes(item));
		const old = rest.filter((item) => stale.includes(item));
		if (rest.length > 0) {
			const body = fresh.map((item) => formatBridgeRelay(item.relay)).join("\n\n---\n\n");
			const staleBody = old.length > 0
				? `stale — do not act (older than ${RELAY_STALE_SECONDS / 60} min; headlines only):\n${old.map((item) => `- [${item.relay.kind}${item.relay.jobId ? ` job=${item.relay.jobId}` : ""}] ${headline(item.relay.text)}`).join("\n")}`
				: "";
			out.push({ content: `${[body, staleBody].filter(Boolean).join("\n\n")}${retiredLine}`, details: { relay_ids: rest.map((item) => item.id) }, relays: fresh.map((item) => item.relay) });
		} else if (out[0] && retiredLine) out[0].content += retiredLine;
		return out;
	}
}

function headline(text: string): string {
	const first = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
	return first.length > HEADLINE_MAX ? `${first.slice(0, HEADLINE_MAX - 1)}…` : first;
}
