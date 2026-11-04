/**
 * Full match S10a: the source identity of a dashboard send the main session relays (cp_parent send) or asks about
 * (cp_parent ask). Resolved only from the operator owner's own delivery record, `state/operator/dashboard.jsonl`;
 * never from text, a selected or "last active" thread, or the latest bound send. An origin grants nothing.
 */
import { type Static, Type } from "typebox";
import { THREAD_ID_SOURCE } from "./contracts/thread-limits.ts";
import { DASHBOARD_ID_RE } from "./viewer/control-files.ts";
import { readQueueJournal } from "./viewer/control-queue.ts";

const SendId = Type.String({ pattern: DASHBOARD_ID_RE.source });
const ThreadId = Type.Union([Type.String({ pattern: `^${THREAD_ID_SOURCE}$` }), Type.Null()]);
/** An ask's `source`, written once when it opens; a line without one is untagged. */
export const AskSourceSchema = Type.Object({ send_id: SendId, thread_id: ThreadId }, { additionalProperties: false });
export type AskSource = Static<typeof AskSourceSchema>;
/** A parent send's `origin`, written once at enqueue; retries, replays and settles never rewrite it. */
export const ParentSendOriginSchema = Type.Object({ source_send_id: SendId, thread_id: ThreadId }, { additionalProperties: false });
export type ParentSendOrigin = Static<typeof ParentSendOriginSchema>;

const NOTHING = "; nothing was sent or recorded";
export const ORIGINS_UNSUPPORTED = `source_send_id is unsupported: this parent host predates thread origins; reload the operator session (the parent restarts on install), or send without source_send_id${NOTHING}`;

/** The delivered dashboard send `id` and its request line's thread (null: No thread); anything else throws. */
export function resolveSendSource(stateDir: string, id: unknown): AskSource {
	if (typeof id !== "string" || !DASHBOARD_ID_RE.test(id)) throw new Error(`source_send_id must be a dashboard send id (dc-<14 digits>-<8 hex>)${NOTHING}`);
	const journal = readQueueJournal(stateDir);
	if (journal.error) throw new Error(`source_send_id ${id}: the dashboard journal is unreadable (${journal.error})${NOTHING}`);
	const send = journal.messages.get(id);
	if (send?.state !== "delivered") throw new Error(`source_send_id ${id} is not a dashboard message this operator session delivered${NOTHING}`);
	return { send_id: id, thread_id: send.thread_id ?? null };
}

/** cp_parent's `source_send_id` parameter (send and ask). */
export const SourceSendParam = {
	source_send_id: Type.Optional(Type.String({ description: "send or ask: the dc-… id from the [cp-dashboard dc-… — from the dashboard] marker of the human message you relay or ask about; omit for chat-typed messages" })),
};

/** The parent send's origin from `source_send_id`, resolved before anything is sent; undefined when not given. */
export function sendOrigin(stateDir: string, sourceSendId: string | undefined): ParentSendOrigin | undefined {
	if (sourceSendId === undefined) return undefined;
	const source = resolveSendSource(stateDir, sourceSendId);
	return { source_send_id: source.send_id, thread_id: source.thread_id };
}

/** One parent-host send; an origin goes by `sendFrom`, which a host from before S10a refuses as an unknown op. */
export async function requestSend(client: { request(op: string, ...args: unknown[]): Promise<unknown> }, text: string, delegation: object, origin: ParentSendOrigin | undefined): Promise<unknown> {
	if (!origin) return client.request("send", text, undefined, delegation);
	try {
		return await client.request("sendFrom", text, undefined, delegation, origin);
	} catch (error) {
		throw /unknown parent host op sendFrom/.test((error as Error).message) ? new Error(ORIGINS_UNSUPPORTED) : error;
	}
}
