/** The dashboard's "send test notification" (#328): one labelled push to one subscription, rate-limited and journaled. */

import { isoTimestamp } from "../contracts.ts";
import type { PushTestResponse } from "../viewer/api-types.ts";
import { lastAcceptedAt, type StoredSubscription } from "../viewer/push-files.ts";
import { PUSH_TEST_INTERVAL_MS, PushTestJournal } from "./deliveries.ts";
import { readVapidKeys } from "./keys.ts";
import { sendOne } from "./sweep.ts";
import { type PushFetch, vapidAuthorization } from "./webpush.ts";

const TEST_PAYLOAD = JSON.stringify({ project: "command post", kind: "test notification", headline: "Sent from Settings; nothing to do" });

export type PushTestRun = { ok: true; reply: PushTestResponse } | { ok: false; status: number; error: string; retry_after?: number };

/** Throws only when the journal or signing key cannot be read; the caller answers 500. */
export async function runPushTest(input: { stateDir: string; dataDir: string; target: StoredSubscription; fetch?: PushFetch; now: Date }): Promise<PushTestRun> {
	const { stateDir, dataDir, target, now } = input;
	const journal = new PushTestJournal(stateDir);
	return journal.locked(async () => {
		const previous = journal.read().filter((test) => test.subscription === target.id).at(-1);
		const wait = Math.ceil(((previous ? Date.parse(previous.at) : 0) + PUSH_TEST_INTERVAL_MS - now.getTime()) / 1000);
		if (wait > 0) return { ok: false, status: 429, error: `one test a minute per device; try again in ${wait} s`, retry_after: wait };
		const keys = readVapidKeys(dataDir);
		if (!keys) return { ok: false, status: 409, error: "the push signing key is missing on this home; see /doctor" };
		const outcome = await sendOne(target, TEST_PAYLOAD, (endpoint) => vapidAuthorization({ endpoint, keys, now }), input.fetch);
		const reason = outcome.kind === "delivered" ? undefined : outcome.kind === "gone" ? `HTTP ${outcome.status}: the push service no longer knows this subscription` : outcome.reason;
		const reply: PushTestResponse = { at: isoTimestamp(now), result: outcome.kind === "delivered" ? "accepted" : outcome.kind, ...(reason ? { reason } : {}), last_accepted_at: lastAcceptedAt(stateDir, target.id) };
		journal.append({ subscription: target.id, at: reply.at, result: reply.result, ...(reason ? { reason } : {}) });
		return { ok: true, reply };
	});
}
