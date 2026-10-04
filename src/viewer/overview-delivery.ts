import { join } from "node:path";
import type { OverviewResponse } from "./api-types.ts";
import { obj, type ViewerState } from "./sessions.ts";
import { parseObject, readBounded, source, text, timestamp } from "./overview-read.ts";

/** cp-6fyl PR2: an unacked relay this old raises the Overview alarm (the cp-health `relay` check's 600 s, and the backstop's). */
export const RELAY_ALARM_SECONDS = 600;

/**
 * Has the operator session seen what the parent sent? Re-derived here because viewer modules import nothing outside
 * `src/viewer/` (tests/viewer-workbench.test.ts) from the host's `state/operator/relay-outbox.json` and the operator's
 * `relay-acks.jsonl` (src/operator-outbox.ts). Strict like the asks journal: a malformed file is `unavailable` (unseen
 * null), never 0; a torn last ack line is skipped, a missing outbox is `missing` (nothing relayed, or an old host).
 */
export function delivery(state: ViewerState, now: number): OverviewResponse["delivery"] {
 const outbox = source(() => {
  const entries = parseObject(readBounded(join(state.stateDir, "operator", "relay-outbox.json")))?.entries;
  if (!Array.isArray(entries)) throw new Error("invalid outbox");
  return entries.map(value => {
   const entry = obj(value); const relay = obj(entry?.relay);
   if (!entry || !relay || !text(entry.id) || !timestamp(entry.queued_at) || !text(relay.kind)) throw new Error("invalid outbox entry");
   return {id: entry.id, kind: relay.kind, queued_at: entry.queued_at};
  });
 }, []);
 const acks = source(() => {
  const data = readBounded(join(state.stateDir, "operator", "relay-acks.jsonl"));
  const complete = data.slice(0, data.lastIndexOf("\n") + 1).split("\n"); complete.pop();
  const closed = new Set<string>(); let consumer: string | null = null;
  for (const line of complete) {
   if (!line) continue;
   const event = parseObject(line);
   if (!event || !timestamp(event.at)) throw new Error("invalid ack line");
   if ((event.type === "ack" || event.type === "discard") && text(event.id)) closed.add(event.id);
   else if (event.type === "consumer" && (consumer === null || event.at > consumer)) consumer = event.at;
  }
  return {closed, consumer};
 }, {closed: new Set<string>(), consumer: null as string | null});
 const none = {unseen: null, oldest_id: null, oldest_kind: null, oldest_age_seconds: null, consumer_seen_at: null, alarm: false};
 if (outbox.availability === "unavailable" || acks.availability === "unavailable") return {availability: "unavailable", ...none};
 if (outbox.availability === "missing") return {availability: "missing", ...none, unseen: 0};
 const pending = outbox.value.filter(entry => !acks.value.closed.has(entry.id)).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
 const oldest = pending[0];
 const age = oldest ? Math.max(0, Math.floor((now - Date.parse(oldest.queued_at)) / 1000)) : null;
 return {availability: "ok", unseen: pending.length, oldest_id: oldest?.id ?? null, oldest_kind: oldest?.kind ?? null, oldest_age_seconds: age, consumer_seen_at: acks.value.consumer, alarm: age !== null && age >= RELAY_ALARM_SECONDS};
}
