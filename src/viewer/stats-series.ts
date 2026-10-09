/**
 * Pure helpers for `GET /api/stats` (S8a): query parsing, bucket edges, medians, finished-job
 * classification and the events.jsonl walk. No file or HTTP access; `stats-view.ts` reads and joins.
 */
import { obj, str, type Json } from "./sessions.ts";
import { timestamp } from "./overview-read.ts";

export const DAY_MS = 86_400_000;
export const MAX_CUSTOM_SPAN_MS = 31 * DAY_MS;
export type RangeKey = "1h" | "24h" | "7d" | "custom";
const PRESET_MS: Record<string, number> = { "1h": 3_600_000, "24h": DAY_MS, "7d": 7 * DAY_MS };

export interface StatsQuery { key: RangeKey; from: number; to: number; project: string | null; mandate: string | null }

/** `range=1h|24h|7d|custom` (default 24h, ending at `now`); custom needs UTC ISO `from` < `to`, span <= 31 days. */
export function parseStatsQuery(params: URLSearchParams, now: number): StatsQuery | { error: string } {
 const key = params.get("range") || "24h";
 const project = params.get("project") || null; const mandate = params.get("mandate") || null;
 if (project !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(project)) return { error: "invalid project filter" };
 if (mandate !== null && !/^(?:md-[A-Za-z0-9_-]+|unassigned)$/.test(mandate)) return { error: "invalid mandate filter" };
 if (key !== "custom") {
  const span = Object.hasOwn(PRESET_MS, key) ? PRESET_MS[key] : undefined;
  return span === undefined ? { error: "range must be 1h, 24h, 7d or custom" } : { key: key as RangeKey, from: now - span, to: now, project, mandate };
 }
 const from = params.get("from"); const to = params.get("to");
 if (!timestamp(from) || !timestamp(to)) return { error: "custom range needs from and to as UTC ISO instants (YYYY-MM-DDTHH:MM:SSZ)" };
 const a = Date.parse(from); const b = Date.parse(to);
 if (a >= b) return { error: "from must be before to" };
 if (b - a > MAX_CUSTOM_SPAN_MS) return { error: "custom range is limited to 31 days" };
 return { key: "custom", from: a, to: b, project, mandate };
}

/** 5 minutes for 1h, hours up to 48h, UTC days beyond. ponytail: UTC-aligned days, not browser-local ones; the API has no zone input. */
export function bucketStep(q: Pick<StatsQuery, "key" | "from" | "to">): number {
 return q.key === "1h" ? 300_000 : q.to - q.from <= 2 * DAY_MS ? 3_600_000 : DAY_MS;
}
/** Epoch-aligned edges covering [from, to). */
export function bucketEdges(from: number, to: number, step: number): { start: number; end: number }[] {
 const out: { start: number; end: number }[] = [];
 for (let start = Math.floor(from / step) * step; start < to; start += step) out.push({ start, end: start + step });
 return out;
}

export function median(values: readonly number[]): number | null {
 if (!values.length) return null;
 const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1;
 return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Merged = merge receipt; closed without PR = done and not merged; failed (and anything unfinished) is neither. */
export function classifyFinished(job: { phase: string; merge_sha: string | null }): "merged" | "closed" | null {
 if (job.phase === "failed") return null;
 if (job.merge_sha) return "merged";
 return job.phase === "done" ? "closed" : null;
}

/** Percent change, whole number; a prior of 0 or null (or an unknown current) is null, never 0% or Infinity. */
export function deltaPct(current: number | null, prior: number | null): number | null {
 return current === null || prior === null || prior === 0 ? null : Math.round(((current - prior) / prior) * 100);
}

export interface EventFacts {
 spawned?: number; envelope?: number; exit?: number; ci?: "ci_green" | "ci_failed";
 usage: { at: number; model: string; tokens: number }[];
}
/** One pass over an events.jsonl: first spawned/envelope/exit/CI observation, and assistant `message_end` input+output. */
export function walkEvents(text: string, fallbackModel: string): EventFacts {
 const facts: EventFacts = { usage: [] };
 for (const line of text.split("\n")) {
  if (!/"message_end"|"spawned"|"envelope_received"|"process_exit"|"ci_observed"/.test(line)) continue;
  let event: Json | undefined; try { event = obj(JSON.parse(line)); } catch { continue; }
  if (!event || !timestamp(event.ts)) continue;
  const at = Date.parse(event.ts); const payload = obj(event.payload);
  if (event.source === "pi" && event.type === "message_end") {
   const message = obj(payload?.message); const usage = obj(message?.usage);
   if (message?.role !== "assistant" || !usage) continue;
   const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
   facts.usage.push({ at, model: str(message.model) ?? fallbackModel, tokens: n(usage.input) + n(usage.output) });
  } else if (event.source === "cp") {
   if (event.type === "spawned") facts.spawned ??= at;
   else if (event.type === "envelope_received") facts.envelope ??= at;
   else if (event.type === "process_exit") facts.exit ??= at;
   else if (event.type === "ci_observed" && !facts.ci && (payload?.event === "ci_green" || payload?.event === "ci_failed")) facts.ci = payload.event;
  }
 }
 return facts;
}
