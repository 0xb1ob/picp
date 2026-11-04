/**
 * Full match S10b: a job's origin at parent intake. The parent names the `ps-…` id from the `[cp-send ps-… — delivery
 * id]` marker of the send it is handling; the origin is that outbox entry's S10a `origin`, nothing else. Never inferred
 * from text, the latest send, a selected thread or another job. An origin grants no mandate, decision, risk or merge.
 */
import { join } from "node:path";
import { type JobOrigin, LAYOUT } from "./contracts.ts";
import { PARENT_SEND_ID_PATTERN, ParentSendOutbox, parentSendFile } from "./parent-outbox.ts";

const NOTHING = "; nothing was created";

/** cp_job create and cp_pipeline start's `source_send_id` parameter. */
export const SOURCE_SEND_DESCRIPTION = "create/start: the ps-… id from the [cp-send ps-… — delivery id] marker of the operator send that asked for this job; omit when no send did";

/** The origin of the send `sendId` as the outbox recorded it; undefined when none was given or the send had none. */
export function resolveJobOrigin(home: string, sendId: unknown): JobOrigin | undefined {
	if (sendId === undefined) return undefined;
	if (typeof sendId !== "string" || !new RegExp(PARENT_SEND_ID_PATTERN).test(sendId)) throw new Error(`source_send_id must be a parent send id (ps-<14 digits>-<8 hex>)${NOTHING}`);
	const outbox = new ParentSendOutbox({ file: parentSendFile(join(home, LAYOUT.sessions, "cp-parent.jsonl")) });
	let entry;
	try {
		entry = outbox.get(sendId);
	} catch (error) {
		throw new Error(`source_send_id ${sendId}: the parent send outbox is unreadable (${(error as Error).message})${NOTHING}`);
	}
	if (!entry) throw new Error(`source_send_id ${sendId} is not a send the operator made to this parent${NOTHING}`);
	// Injected counts: the parent holds the marker once written, and landing is recorded asynchronously.
	if (!entry.landed_at && entry.state !== "injected") throw new Error(`source_send_id ${sendId} was never delivered to the parent${NOTHING}`);
	return entry.origin ? { source_send_id: entry.origin.source_send_id, thread_id: entry.origin.thread_id } : undefined;
}
