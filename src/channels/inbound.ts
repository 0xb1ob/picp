/**
 * Inbound: one Socket Mode envelope at a time, allowlisted on every event and tap, routed into the operator session
 * as a labelled user message or a card answer. It never answers a card or writes asks.jsonl (docs/contracts.md).
 */
import { appendInboxLine } from "../viewer/control-audit.ts";
import { CHANNEL_PROVENANCE_VERSION, type ChannelOrigin, type ControlRecord, INBOX_MAX_HELD, readControlRecord } from "../viewer/control-files.ts";
import { heldId, operatorSession, readInbox } from "../viewer/control-inbox.ts";
import type { ChannelOutbound, GatewayContext } from "./outbound.ts";
import type { Receipt } from "./render.ts";
import { chatAnswerable } from "./render.ts";
import type { JournalLine } from "./store.ts";

/** Slack text a request may carry, in code points. */
export const CHANNEL_TEXT_MAX = 4_000;
const TS_RE = /^\d{10}\.\d{6}$/;
const ACTION_RE = /^(ask-[a-f0-9]+):(\d)$/;

type Reply = { ok: true; result: unknown } | { ok: false; status: number; error: string };
export interface InboundPorts {
	ctx: GatewayContext;
	outbound: ChannelOutbound;
	control(record: ControlRecord, op: string, args: Record<string, unknown>): Promise<Reply>;
}

type Where = { team: string; channel: string; user: string; root: string };
type Request = Where & ({ kind: "message"; text: string } | { kind: "answer"; askId: string; label: string }) & { parent?: string };

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The allowlist, applied to every event and every tap: a reason when it refuses. */
function refusal(ctx: GatewayContext, team: string | undefined, user: string | undefined, channel: string | undefined, shared: unknown): string | undefined {
	const slack = ctx.config;
	if (team !== slack.team_id) return "team not allowed";
	if (!user || !slack.user_ids.includes(user)) return "user not allowed";
	if (!channel || !(channel.startsWith("D") || slack.channel_ids.includes(channel))) return "channel not allowed";
	if (shared === true) return "shared channel";
	return undefined;
}

export async function handleEnvelope(type: string, payload: unknown, ports: InboundPorts): Promise<void> {
	if (type === "events_api") return onEvent(payload as Record<string, any>, ports);
	if (type === "interactive") return onAction(payload as Record<string, any>, ports);
}

function journal(ports: InboundPorts, line: JournalLine): void {
	try { ports.ctx.store.journal(line); } catch (error) { ports.ctx.log(`channel journal unwritable: ${(error as Error).message}`); }
}

function refuse(ports: InboundPorts, reason: string, via: "event" | "action", who: { team?: string; user?: string; channel?: string }): void {
	journal(ports, { type: "refused", at: ports.ctx.now().toISOString(), reason, via, ...(who.team ? { team: who.team.slice(0, 32) } : {}), ...(who.user ? { user: who.user.slice(0, 32) } : {}), ...(who.channel ? { channel: who.channel.slice(0, 32) } : {}) });
}

async function onEvent(payload: Record<string, any>, ports: InboundPorts): Promise<void> {
	const event = payload?.event as Record<string, any> | undefined;
	if (!event || (event.type !== "app_mention" && event.type !== "message")) return;
	if (event.type === "message" && event.channel_type !== "im") return;
	const bot = str(payload.authorizations?.[0]?.user_id);
	if (bot && event.user === bot) return; // the gateway's own post, echoed back
	if (event.subtype === "message_changed" || event.subtype === "message_deleted") return; // an edit, nobody's new line
	const team = str(payload.team_id) ?? str(event.team);
	const user = str(event.user);
	const channel = str(event.channel);
	if (event.bot_id !== undefined || event.subtype !== undefined || !user) return refuse(ports, "bot or system message", "event", { team, user, channel });
	const why = refusal(ports.ctx, team, user, channel, payload.is_ext_shared_channel ?? event.is_ext_shared_channel);
	if (why) return refuse(ports, why, "event", { team, user, channel });
	const root = str(event.thread_ts) ?? str(event.ts);
	if (!root || !TS_RE.test(root)) return ports.ctx.log("event without a usable ts ignored");
	const text = String(event.text ?? "").replace(/^(?:\s*<@[UW][A-Z0-9]+>)+/, "").trim();
	if (!text) return;
	const where: Where = { team: team!, channel: channel!, user, root };
	if ([...text].length > CHANNEL_TEXT_MAX) {
		const key = `too_long:${channel}:${str(event.ts) ?? root}`;
		await ports.outbound.enqueue([{ key, kind: "too_long", dc_id: null, channel: channel!, thread_ts: root }]);
		return ports.outbound.deliverNow(key);
	}
	const prior = ports.ctx.store.requests().filter((line) => line.team === team && line.channel === channel && line.thread_ts === root);
	if (prior.length === 0) return submit(ports, { ...where, kind: "message", text });
	const cards = ports.outbound.openCards(new Set(prior.map((line) => line.dc_id)));
	const at = ports.ctx.now().toISOString();
	if (cards.length === 1) {
		journal(ports, { type: "routed", at, kind: "answer", ask_id: cards[0]!.id });
		return submit(ports, { ...where, kind: "message", text: `${cards[0]!.id}: ${text}`, parent: prior[0]!.dc_id });
	}
	if (cards.length >= 2) {
		journal(ports, { type: "routed", at, kind: "which" });
		const key = `which:${channel}:${str(event.ts) ?? root}`;
		await ports.outbound.enqueue([{ key, kind: "which", dc_id: prior[0]!.dc_id, channel: channel!, thread_ts: root, ask_ids: cards.slice(0, 10).map((ask) => ask.id) }]);
		return ports.outbound.deliverNow(key);
	}
	journal(ports, { type: "routed", at, kind: "message", dc_id: prior[0]!.dc_id });
	return submit(ports, { ...where, kind: "message", text, parent: prior[0]!.dc_id });
}

async function onAction(payload: Record<string, any>, ports: InboundPorts): Promise<void> {
	if (payload?.type !== "block_actions") return;
	const team = str(payload.team?.id);
	const user = str(payload.user?.id);
	const channel = str(payload.channel?.id) ?? str(payload.container?.channel_id);
	const why = refusal(ports.ctx, team, user, channel, payload.is_ext_shared_channel);
	if (why) return refuse(ports, why, "action", { team, user, channel });
	const match = ACTION_RE.exec(str(payload.actions?.[0]?.value) ?? "");
	const card = match ? ports.outbound.card(match[1]!) : undefined;
	if (!match || !card || card.channel !== channel || !card.dc_id) return refuse(ports, "not a card this gateway posted", "action", { team, user, channel });
	const ask = ports.ctx.asks().find((each) => each.id === match[1]);
	const label = ask?.options[Number(match[2])]?.label;
	if (!ask || ask.state !== "open" || !label || !chatAnswerable(ask, ports.ctx.kindOf)) return refuse(ports, "the card is closed or answered only on the dashboard", "action", { team, user, channel });
	journal(ports, { type: "routed", at: ports.ctx.now().toISOString(), kind: "answer", ask_id: ask.id });
	return submit(ports, { team: team!, channel: channel!, user: user!, root: card.thread_ts, kind: "answer", askId: ask.id, label, parent: card.dc_id });
}

/** Mint, journal, post "Got it. Queued.", then hand to the session (or the inbox); the receipt edits the status. */
async function submit(ports: InboundPorts, request: Request): Promise<void> {
	const { ctx, outbound } = ports;
	const now = ctx.now();
	const id = heldId(now);
	const chars = request.kind === "message" ? [...request.text].length : [...request.label].length;
	journal(ports, { type: "request", dc_id: id, at: now.toISOString(), team: request.team, channel: request.channel, thread_ts: request.root, user: request.user, kind: request.kind, chars, ...(request.parent ? { parent: request.parent } : {}), ...(request.kind === "answer" ? { ask_id: request.askId } : {}) });
	await outbound.enqueue([{ key: `status:${id}`, kind: "status", dc_id: id, channel: request.channel, thread_ts: request.root, receipt: { state: "queued" } }]);
	await outbound.deliverNow(`status:${id}`);
	const receipt = await deliver(ports, id, request);
	if (receipt.state !== "queued") await outbound.setReceipt(id, receipt);
}

async function deliver(ports: InboundPorts, id: string, request: Request): Promise<Receipt> {
	const { stateDir } = ports.ctx;
	const origin: ChannelOrigin = { kind: "slack", team: request.team, channel: request.channel, user: request.user, thread_ts: request.root };
	const record = readControlRecord(stateDir);
	if (operatorSession(stateDir).running && record.state === "ok") {
		const status = await ports.control(record.record, "status", {});
		if (!status.ok) return { state: "refused", reason: "the operator session did not answer; check the dashboard" };
		const version = (status.result as { channel_provenance?: unknown } | null)?.channel_provenance;
		if (!(typeof version === "number" && version >= CHANNEL_PROVENANCE_VERSION)) return { state: "refused", reason: "the operator session predates chat channels; restart it" };
		const args = request.kind === "message" ? { kind: "message", text: request.text, client_id: id, channel: origin } : { kind: "answer", ask_id: request.askId, label: request.label, client_id: id, channel: origin };
		const reply = await ports.control(record.record, "send", args);
		if (!reply.ok) return { state: "refused", reason: reply.status === 503 || reply.status === 504 ? "the operator session did not answer; check the dashboard" : reply.error };
		const state = (reply.result as { state?: unknown } | null)?.state;
		return state === "delivered" ? { state: "delivered" } : { state: "behind" };
	}
	// A chat message never wakes a session: it waits in the offline inbox like a dashboard one.
	if (request.kind === "answer") return { state: "refused", reason: "the operator is offline; answer on the dashboard" };
	const inbox = readInbox(stateDir);
	if (inbox.error) return { state: "refused", reason: "the offline inbox is unreadable" };
	if (inbox.held.length >= INBOX_MAX_HELD) return { state: "refused", reason: "the offline inbox is full" };
	const written = appendInboxLine(stateDir, { type: "held", id, at: ports.ctx.now().toISOString(), text: request.text, ask_id: null, channel: origin });
	return written.ok ? { state: "held" } : { state: "refused", reason: "the offline inbox is unwritable" };
}
