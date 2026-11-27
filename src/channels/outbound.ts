/**
 * Outbound, the push sweep's shape: new turn bindings become cards and replies in the request's thread, receipts and
 * mirrors become edits, and writes go out in order, one per second per channel, 429s waiting their Retry-After.
 */
import { readFileSync } from "node:fs";
import { isoTimestamp } from "../contracts.ts";
import type { OperatorAsk } from "../operator-asks.ts";
import { readTurnBindings, turnBindingsEnd, type TurnBindingRecord } from "../operator-turn-binding.ts";
import { pushBackoffSeconds } from "../push/deliveries.ts";
import { controlInboxFile, controlJournalFile } from "../viewer/control-files.ts";
import type { SlackConfig, SlackTokens } from "./config.ts";
import { chatAnswerable, type Receipt, renderAmbiguous, renderCard, renderClosed, renderNotice, renderReceipt, renderReply, renderTooLong, renderWhich, safeText, type SlackMessage } from "./render.ts";
import type { SlackApi } from "./slack-api.ts";
import { type ChannelStore, type Outbox, OUTBOX_MAX_ATTEMPTS, type OutboxItem, type RequestLine } from "./store.ts";

/** At most one Slack write per channel per this long. */
export const CHANNEL_WRITE_GAP_MS = 1_000;
const FINAL_RECEIPTS = ["delivered", "dropped", "refused"];

export interface GatewayContext {
	stateDir: string;
	/** Prefixes scrubbed to `<home>` in everything posted: the CP home and its runtime root. */
	homes: string[];
	config: SlackConfig;
	tokens: SlackTokens;
	api: SlackApi;
	store: ChannelStore;
	asks(): OperatorAsk[];
	kindOf(escalationId: string): string | undefined;
	/** The dashboard origin links point at, or null (the templates then say to open the dashboard). */
	origin(): string | null;
	now(): Date;
	log(line: string): void;
}

export type NewItem = Pick<OutboxItem, "key" | "kind" | "dc_id" | "channel" | "thread_ts"> & Partial<Pick<OutboxItem, "ask_id" | "ask_ids" | "text" | "receipt">>;

/** The latest bridge outcome per dashboard id (state and reason), for the ids asked about. */
function dashboardOutcomes(stateDir: string, ids: ReadonlySet<string>): Map<string, { state: string; reason: string | null }> {
	const out = new Map<string, { state: string; reason: string | null }>();
	if (ids.size === 0) return out;
	let text = "";
	try { text = readFileSync(controlJournalFile(stateDir), "utf8"); } catch { return out; }
	for (const row of text.split("\n")) {
		if (!row.includes("\"outcome\"")) continue;
		try {
			const line = JSON.parse(row) as { type?: unknown; by?: unknown; id?: unknown; state?: unknown; reason?: unknown };
			if (line.type === "outcome" && typeof line.id === "string" && ids.has(line.id) && typeof line.state === "string") out.set(line.id, { state: line.state, reason: typeof line.reason === "string" ? line.reason : null });
		} catch { /* torn */ }
	}
	return out;
}

/** The offline inbox's end lines (`delivered` / `dropped` with its reason) per id. */
function inboxOutcomes(stateDir: string, ids: ReadonlySet<string>): Map<string, { state: string; reason: string | null }> {
	const out = new Map<string, { state: string; reason: string | null }>();
	if (ids.size === 0) return out;
	let text = "";
	try { text = readFileSync(controlInboxFile(stateDir), "utf8"); } catch { return out; }
	for (const row of text.split("\n")) {
		try {
			const line = JSON.parse(row) as { type?: unknown; id?: unknown; reason?: unknown };
			if (typeof line.id === "string" && ids.has(line.id) && (line.type === "delivered" || line.type === "dropped")) out.set(line.id, { state: line.type, reason: typeof line.reason === "string" ? line.reason : null });
		} catch { /* torn */ }
	}
	return out;
}

/** What a status message should say now, from the bridge's journal and the inbox; undefined keeps the current one. */
function receiptFrom(current: Receipt, journal?: { state: string; reason: string | null }, inbox?: { state: string; reason: string | null }): Receipt | undefined {
	if (inbox?.state === "dropped") return { state: "dropped", reason: inbox.reason ?? "dropped by the operator session" };
	if (journal?.state === "delivered" || inbox?.state === "delivered") return { state: "delivered" };
	if (journal?.state === "dropped") return { state: "dropped", reason: journal.reason ?? "dropped by the operator session" };
	if (journal?.state === "cancelled") return { state: "dropped", reason: "cancelled from the dashboard" };
	if (journal?.state === "failed" || journal?.state === "refused") return { state: "refused", reason: journal.reason ?? journal.state };
	if (journal?.state === "queued" && current.state === "queued") return { state: "behind" };
	return undefined;
}

export class ChannelOutbound {
	readonly #ctx: GatewayContext;
	readonly #lastWrite = new Map<string, number>();
	constructor(ctx: GatewayContext) { this.#ctx = ctx; }

	#link(path: "awaiting" | "transcript"): string | null {
		const origin = this.#ctx.origin();
		return origin ? `${origin}/#${path === "awaiting" ? "awaiting" : "sessions?view=you&transcript=1"}` : null;
	}

	/** The ledger; created on first use with the bindings already on disk as its baseline. */
	#outbox(): Outbox {
		const read = this.#ctx.store.readOutbox();
		if (read) return read;
		const outbox: Outbox = { schema_version: 1, baseline_at: isoTimestamp(this.#ctx.now()), bindings_offset: turnBindingsEnd(this.#ctx.stateDir), items: [] };
		this.#ctx.store.writeOutbox(outbox);
		return outbox;
	}

	#add(outbox: Outbox, item: NewItem): void {
		if (outbox.items.some((existing) => existing.key === item.key)) return;
		outbox.items.push({ ...item, state: "pending", rev: 1, done_rev: 0, attempts: 0, created_at: isoTimestamp(this.#ctx.now()) });
	}

	/** Queue new Slack messages (a key already in the ledger is kept as is). */
	enqueue(items: readonly NewItem[]): Promise<void> {
		return this.#ctx.store.locked(async () => {
			const outbox = this.#outbox();
			for (const item of items) this.#add(outbox, item);
			this.#ctx.store.writeOutbox(outbox);
		});
	}

	/** A status message's new receipt: the next write edits it. */
	setReceipt(dcId: string, receipt: Receipt): Promise<void> {
		return this.#ctx.store.locked(async () => {
			const outbox = this.#outbox();
			const item = outbox.items.find((each) => each.key === `status:${dcId}`);
			if (!item || (item.receipt && item.receipt.state === receipt.state && item.receipt.reason === receipt.reason)) return;
			this.#revise(item, { receipt });
			this.#ctx.store.writeOutbox(outbox);
		});
	}

	#revise(item: OutboxItem, change: Partial<OutboxItem>): void {
		Object.assign(item, change);
		item.rev += 1;
		item.attempts = 0;
		if (item.state !== "failed") item.state = "pending";
		delete item.next_attempt_at;
		delete item.settled_at;
	}

	/** Answerable cards still open in the threads of `dcIds`, oldest first. */
	openCards(dcIds: ReadonlySet<string>): OperatorAsk[] {
		const outbox = this.#ctx.store.readOutbox();
		if (!outbox) return [];
		const asks = new Map(this.#ctx.asks().map((ask) => [ask.id, ask]));
		return outbox.items
			.filter((item) => item.kind === "card" && item.state !== "failed" && item.dc_id !== null && dcIds.has(item.dc_id) && item.ask_id)
			.map((item) => asks.get(item.ask_id!))
			.filter((ask): ask is OperatorAsk => ask !== undefined && ask.state === "open" && chatAnswerable(ask, this.#ctx.kindOf));
	}

	/** The card item for `askId`, if one was queued. */
	card(askId: string): OutboxItem | undefined {
		return this.#ctx.store.readOutbox()?.items.find((item) => item.kind === "card" && item.ask_id === askId);
	}

	#render(item: OutboxItem, asks: Map<string, OperatorAsk>): SlackMessage | undefined {
		const homes = this.#ctx.homes;
		switch (item.kind) {
			case "status": return renderReceipt(item.receipt ?? { state: "queued" }, homes);
			case "too_long": return renderTooLong();
			case "notice": return item.ask_id ? renderNotice(item.text, this.#link("awaiting")) : renderAmbiguous(this.#link("transcript"));
			case "reply": return renderReply(item.text ?? "", this.#link("transcript"), homes);
			case "which": return renderWhich((item.ask_ids ?? []).map((id) => asks.get(id)).filter((ask): ask is OperatorAsk => ask !== undefined), homes);
			case "card": {
				const ask = item.ask_id ? asks.get(item.ask_id) : undefined;
				if (!ask) return undefined;
				if (item.mirror === "withdrawn") return renderClosed(ask, "withdrawn", homes);
				if (item.mirror === "answered") return renderClosed(ask, { answered: ask.answer ?? "" }, homes);
				return renderCard(ask, this.#link("awaiting"), homes);
			}
		}
		return undefined;
	}

	/** One write of `item`'s current version: a post, or an edit once it has a ts. Mutates the item; never throws. */
	async #write(item: OutboxItem, asks: Map<string, OperatorAsk>): Promise<void> {
		const { api, tokens, log, store } = this.#ctx;
		const at = isoTimestamp(this.#ctx.now());
		const settle = (state: OutboxItem["state"]) => {
			item.state = state;
			item.settled_at = at;
			delete item.next_attempt_at;
		};
		const message = this.#render(item, asks);
		if (!message) {
			item.last_error = "its ask is no longer in asks.jsonl";
			return settle("failed");
		}
		const rev = item.rev;
		this.#lastWrite.set(item.channel, Date.now());
		const result = item.ts ? await api.update(tokens.bot, { channel: item.channel, ts: item.ts, ...message }) : await api.postMessage(tokens.bot, { channel: item.channel, thread_ts: item.thread_ts, ...message });
		this.#lastWrite.set(item.channel, Date.now());
		item.attempts += 1;
		if (result.kind === "ok") {
			if (!item.ts && typeof result.data.ts === "string") item.ts = result.data.ts;
			item.done_rev = rev;
			delete item.last_error;
			if (item.done_rev >= item.rev) settle("posted");
			return;
		}
		item.last_error = result.reason.slice(0, 300);
		if (result.kind === "retry" && item.attempts < OUTBOX_MAX_ATTEMPTS) {
			// Slack's Retry-After is the instruction on a 429; any other fault backs off like a push.
			const waitS = result.afterS ?? pushBackoffSeconds(item.attempts);
			// Rounded up to the record's whole second: never earlier than Slack asked.
			item.next_attempt_at = isoTimestamp(new Date(Math.ceil((this.#ctx.now().getTime() + waitS * 1000) / 1000) * 1000));
			log(`slack ${item.kind} ${item.key}: ${result.reason}; retry ${item.attempts}/${OUTBOX_MAX_ATTEMPTS} in ${waitS}s`);
			return;
		}
		settle("failed");
		log(`slack ${item.kind} ${item.key}: ${result.reason}; failed after ${item.attempts} attempt(s)`);
		try { store.journal({ type: "delivery", at, key: item.key, state: "failed", error: item.last_error }); } catch (error) { log(`channel journal unwritable: ${(error as Error).message}`); }
	}

	#due(item: OutboxItem, now: number): boolean {
		return item.state === "pending" && (!item.next_attempt_at || Date.parse(item.next_attempt_at) <= now);
	}

	#gap(channel: string): number {
		return Math.max(0, (this.#lastWrite.get(channel) ?? 0) + CHANNEL_WRITE_GAP_MS - Date.now());
	}

	/** Deliver one item now (the status post that precedes a send), waiting out its channel's gap; one attempt. */
	deliverNow(key: string): Promise<void> {
		return this.#ctx.store.locked(async () => {
			const outbox = this.#outbox();
			const item = outbox.items.find((each) => each.key === key);
			if (!item || !this.#due(item, this.#ctx.now().getTime())) return;
			const gap = this.#gap(item.channel);
			if (gap > 0) await new Promise((done) => setTimeout(done, gap));
			await this.#write(item, new Map(this.#ctx.asks().map((ask) => [ask.id, ask])));
			this.#ctx.store.writeOutbox(outbox);
		});
	}

	/** One chat request's turn: its cards or notices, then the reply. A turn that consumed more ids gets only a link. */
	#fromBinding(outbox: Outbox, record: TurnBindingRecord, byId: Map<string, RequestLine>, asks: Map<string, OperatorAsk>): void {
		const requests = record.channel_dc_ids.map((id) => byId.get(id)).filter((line): line is RequestLine => line !== undefined);
		if (requests.length === 0) return;
		const threads = new Map(requests.map((request) => [`${request.channel} ${request.thread_ts}`, request]));
		// Any second request, dashboard or chat, even in the same thread: the reply may be about another request.
		if (requests.length > 1 || record.dc_ids.length > 1) {
			for (const request of threads.values()) this.#add(outbox, { key: `ambiguous:${record.at}:${request.dc_id}`, kind: "notice", dc_id: request.dc_id, channel: request.channel, thread_ts: request.thread_ts });
			return;
		}
		const request = requests[0]!;
		const where = { dc_id: request.dc_id, channel: request.channel, thread_ts: request.thread_ts };
		for (const askId of record.ask_ids) {
			const ask = asks.get(askId);
			if (!ask) continue;
			if (chatAnswerable(ask, this.#ctx.kindOf)) this.#add(outbox, { key: `card:${askId}`, kind: "card", ask_id: askId, ...where });
			else {
				const question = safeText(ask.question, this.#ctx.homes);
				this.#add(outbox, { key: `notice:${askId}`, kind: "notice", ask_id: askId, ...where, ...(question !== undefined ? { text: question.slice(0, 2_000) } : {}) });
			}
		}
		const source = record.answer?.delivery === "report" ? record.answer.text : record.reply?.text;
		if (record.outcome !== "completed" || !source?.trim()) return this.#ctx.log(`turn ${record.at} for ${request.dc_id}: no reply posted (${record.outcome}${source?.trim() ? "" : ", no reply text"})`);
		this.#add(outbox, { key: `reply:${record.at}:${request.dc_id}`, kind: "reply", ...where, text: source.slice(0, 16_000) });
	}

	/** One pass: bindings, receipts, mirror, then due writes. Never throws for a Slack outage. */
	sweep(): Promise<{ written: number; pending: number }> {
		return this.#ctx.store.locked(async () => {
			const { stateDir, store } = this.#ctx;
			const outbox = this.#outbox();
			const before = JSON.stringify(outbox);
			const asks = new Map(this.#ctx.asks().map((ask) => [ask.id, ask]));
			const bindings = readTurnBindings(stateDir, outbox.bindings_offset);
			if (bindings.records.length) {
				const byId = new Map(store.requests().map((line) => [line.dc_id, line]));
				for (const record of bindings.records) this.#fromBinding(outbox, record, byId, asks);
			}
			outbox.bindings_offset = bindings.offset;
			const waiting = outbox.items.filter((item) => item.kind === "status" && item.dc_id && !FINAL_RECEIPTS.includes(item.receipt?.state ?? "queued"));
			const ids = new Set(waiting.map((item) => item.dc_id!));
			const journal = dashboardOutcomes(stateDir, ids);
			const inbox = inboxOutcomes(stateDir, ids);
			for (const item of waiting) {
				const next = receiptFrom(item.receipt ?? { state: "queued" }, journal.get(item.dc_id!), inbox.get(item.dc_id!));
				if (next) this.#revise(item, { receipt: next });
			}
			for (const item of outbox.items) {
				if (item.kind !== "card" || item.mirror || !item.ask_id || item.state === "failed") continue;
				const state = asks.get(item.ask_id)?.state;
				if (state === "answered" || state === "withdrawn") this.#revise(item, { mirror: state });
			}
			// Durable before any network call: a binding read, a receipt or a mirror is never lost to a hung Slack.
			if (JSON.stringify(outbox) !== before) store.writeOutbox(outbox);
			const now = this.#ctx.now().getTime();
			const pending = outbox.items.filter((item) => item.state === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
			// In order per channel: a write waiting out a retry holds the later ones (a reply never lands above its card).
			const held = new Set<string>();
			let written = 0;
			for (const item of pending) {
				if (held.has(item.channel)) continue;
				held.add(item.channel);
				if (!this.#due(item, now) || this.#gap(item.channel) > 0) continue;
				await this.#write(item, asks);
				written += 1;
				store.writeOutbox(outbox);
			}
			return { written, pending: outbox.items.filter((item) => item.state === "pending").length };
		});
	}
}
