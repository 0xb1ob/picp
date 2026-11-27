/**
 * Operator turn binding: per settled turn that consumed a dc- id, one 0600 line in `state/operator/turn-bindings.jsonl`
 * with the ids it consumed and produced, any answer report and the reply pointer (text kept for chat turns only).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { durableAppend } from "./json-store.ts";
import { DASHBOARD_ID_RE, INBOX_REPLAY_PREFIX, parseDashboardText } from "./viewer/control-files.ts";

export const turnBindingsFile = (stateDir: string): string => join(stateDir, "operator", "turn-bindings.jsonl");
/** Code points of reply text a record keeps. */
export const TURN_REPLY_MAX = 4_000;
const READ_MAX_BYTES = 4 * 1024 * 1024;

export interface TurnBindingRecord {
	v: 1;
	at: string;
	session_file: string | null;
	dc_ids: string[];
	/** The subset whose marker carried `; channel` (a chat request). */
	channel_dc_ids: string[];
	ask_ids: string[];
	send_ids: string[];
	answer: { state: string | null; delivery: string; id: string | null; url: string | null; text: string } | null;
	/** The last assistant text block: its timestamp and index (the header guard's key); text for channel turns. */
	reply: { ts: number | null; block: number; text?: string; truncated?: true } | null;
	outcome: "completed" | "aborted" | "error";
}

type Message = { role?: unknown; content?: unknown; timestamp?: unknown; stopReason?: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content
	: Array.isArray(content) ? content.map((part) => ((part as { type?: unknown })?.type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n") : "";
const REPLAY_COUNT = /^\[cp-dashboard inbox — (\d+) message\(s\) /;
const REPLAY_HEAD = /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \((dc-\d{14}-[0-9a-f]{8})\): /gm;
const REPLAY_DROPPED = "\n- dropped, held longer than 24 h: ";
const channelTail = (id: string): RegExp => new RegExp(`\\n\\[cp-channel — through slack, not this terminal: sent by [UW][A-Z0-9]{2,20} in [CDG][A-Z0-9]{2,20}\\]\\n\\[cp-dashboard ${id} — from the dashboard(?:; ask=ask-[a-f0-9]+)?(?:; remote)?; channel\\]$`);

/**
 * An inbox replay's ids. An entry is a chat request only when it ends in the bridge's channel tail naming its own id,
 * and only while the entries found match the bridge's own header count: typed text cannot add an entry or a channel id.
 */
function replayIds(text: string): { ids: string[]; channel: string[] } {
	const cut = text.indexOf(REPLAY_DROPPED);
	const entries = cut < 0 ? text : text.slice(0, cut);
	const heads = [...entries.matchAll(REPLAY_HEAD)];
	const ids = heads.map((head) => head[1]!);
	if (heads.length !== Number(REPLAY_COUNT.exec(text)?.[1])) return { ids, channel: [] };
	const channel = heads.filter((head, i) => {
		const body = entries.slice(head.index + head[0].length, heads[i + 1]?.index ?? entries.length).replace(/\n$/, "");
		return channelTail(head[1]!).test(body);
	});
	return { ids, channel: channel.map((head) => head[1]!) };
}

/** Fed from the bridge's own turn events; `settled` writes one record and starts the next turn clean. */
export class OperatorTurnBinding {
	#dc = new Set<string>();
	#channel = new Set<string>();
	#asks = new Set<string>();
	#sends = new Set<string>();
	#answer: TurnBindingRecord["answer"] = null;
	#reply: { ts: number | null; block: number; text: string } | null = null;
	#outcome: TurnBindingRecord["outcome"] = "completed";

	/** `message_start`: the end-anchored marker the bridge appended, or every id of its own offline-inbox replay. */
	userMessage(message: unknown): void {
		const m = message as Message | null;
		if (m?.role !== "user") return;
		const text = textOf(m.content);
		if (text.startsWith(INBOX_REPLAY_PREFIX)) {
			const { ids, channel } = replayIds(text);
			for (const id of ids) this.#dc.add(id);
			for (const id of channel) this.#channel.add(id);
			return;
		}
		const parsed = parseDashboardText(text);
		if (!parsed || !DASHBOARD_ID_RE.test(parsed.id)) return;
		this.#dc.add(parsed.id);
		if (parsed.channel) this.#channel.add(parsed.id);
	}

	/** `tool_execution_end` of a successful `cp_parent`: an opened ask, a parent send's id, an answer report. */
	toolEnded(event: { toolName?: string; isError?: boolean; result?: { details?: Record<string, unknown> } }): void {
		const details = event?.result?.details;
		if (event?.toolName !== "cp_parent" || event.isError || !details || typeof details !== "object") return;
		if (details.state === "open" && typeof details.id === "string" && /^ask-[a-f0-9]+$/.test(details.id)) this.#asks.add(details.id);
		if (typeof details.send_id === "string" && /^ps-/.test(details.send_id)) this.#sends.add(details.send_id);
		if (typeof details.delivery === "string" && typeof details.text === "string") {
			const str = (value: unknown) => (typeof value === "string" ? value : null);
			this.#answer = { state: str(details.state), delivery: details.delivery, id: str(details.id), url: str(details.url), text: details.text };
		}
	}

	/** A card the ask guard opened itself (no tool call behind it). */
	askOpened(id: string): void { this.#asks.add(id); }

	/** `agent_end`: the last assistant message's last non-empty text block; the latest one before the settle wins. */
	agentEnd(messages: unknown): void {
		const list = (Array.isArray(messages) ? messages : []) as Message[];
		const last = list.findLast((m) => m?.role === "assistant");
		if (!last) return;
		this.#outcome = last.stopReason === "aborted" ? "aborted" : last.stopReason === "error" ? "error" : "completed";
		const blocks = Array.isArray(last.content) ? (last.content as Array<{ type?: unknown; text?: unknown }>) : [];
		const block = blocks.findLastIndex((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
		this.#reply = block < 0 ? null : { ts: typeof last.timestamp === "number" ? last.timestamp : null, block, text: String(blocks[block]!.text) };
	}

	/** `agent_settled`: one record when the turn consumed a dashboard id, then a clean slate. */
	settled(stateDir: string, sessionFile: string | null, now = new Date()): TurnBindingRecord | undefined {
		try {
			if (this.#dc.size === 0) return undefined;
			const channel = this.#channel.size > 0;
			const points = this.#reply ? [...this.#reply.text] : [];
			const reply = this.#reply ? { ts: this.#reply.ts, block: this.#reply.block, ...(channel ? { text: points.slice(0, TURN_REPLY_MAX).join("") } : {}), ...(channel && points.length > TURN_REPLY_MAX ? { truncated: true as const } : {}) } : null;
			const record: TurnBindingRecord = { v: 1, at: now.toISOString(), session_file: sessionFile, dc_ids: [...this.#dc], channel_dc_ids: [...this.#channel], ask_ids: [...this.#asks], send_ids: [...this.#sends], answer: this.#answer, reply, outcome: this.#outcome };
			durableAppend(turnBindingsFile(stateDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
			return record;
		} finally {
			this.#dc.clear();
			this.#channel.clear();
			this.#asks.clear();
			this.#sends.clear();
			this.#answer = null;
			this.#reply = null;
			this.#outcome = "completed";
		}
	}
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const wellFormed = (r: TurnBindingRecord): boolean =>
	r?.v === 1 && typeof r.at === "string" && strings(r.dc_ids) && strings(r.channel_dc_ids) && strings(r.ask_ids) && strings(r.send_ids);

/**
 * Complete records from byte `fromOffset` on, and the offset after the last complete line. A torn last line waits; a
 * malformed one is skipped; a file shorter than the offset (replaced) reads from the start.
 */
export function readTurnBindings(stateDir: string, fromOffset: number): { records: TurnBindingRecord[]; offset: number } {
	const file = turnBindingsFile(stateDir);
	let size: number;
	try { size = statSync(file).size; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], offset: 0 };
		throw error;
	}
	const start = fromOffset > size ? 0 : fromOffset;
	if (size === start) return { records: [], offset: start };
	const buf = Buffer.alloc(Math.min(size - start, READ_MAX_BYTES));
	const fd = openSync(file, "r");
	try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
	const end = buf.lastIndexOf(0x0a) + 1;
	const records: TurnBindingRecord[] = [];
	for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as TurnBindingRecord;
			if (wellFormed(record)) records.push(record);
		} catch { /* a malformed line is skipped, never guessed */ }
	}
	return { records, offset: start + end };
}

/** The byte size of the bindings file: where a fresh reader starts (nothing before it is replayed). */
export function turnBindingsEnd(stateDir: string): number {
	try { return statSync(turnBindingsFile(stateDir)).size; } catch { return 0; }
}
