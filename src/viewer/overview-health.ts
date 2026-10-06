import { fileCache } from "./file-cache.ts";
import { join } from "node:path";
import type { OverviewResponse, QuotaObservation, ViewerRoutingFacts } from "./api-types.ts";
import { isSafeId, obj, parentRow, readObject, readStatus, str, type Json, type ViewerState } from "./sessions.ts";
import { nonnegative, parseObject, strings, timestamp } from "./overview-read.ts";
import { readLines } from "./tail.ts";
import { readFileSync } from "node:fs";

/**
 * Is the pid `state/parent.lock` records still a process? The viewer re-derives this instead of
 * importing `src/fleet.ts`, which a workbench module may not do (tests/viewer-workbench.test.ts);
 * that test pins this to `isPidAlive`, the helper `/doctor` and the lock's own reclaim path use.
 * `EPERM` is not alive: the pid was reused by another user's process, never our own parent.
 * A single-thread zombie is gone too — `kill(pid, 0)` still finds it. (cp-hvbj)
 */
export function pidAlive(pid: number): boolean {
 if (!Number.isInteger(pid) || pid <= 0) return false;
 try {
  process.kill(pid, 0);
 } catch {
  return false;
 }
 try {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return !(/^State:\s+Z/m.test(status) && /^Threads:\s+1$/m.test(status));
 } catch {
  return true; // no procfs: kill(pid, 0) is all there is
 }
}

const cachedEvents = fileCache((path: string) => readLines(path, 0, 256 * 1024).lines
 .map(l => parseObject(l.text)).filter((e): e is Json => !!e && e.source === "cp" && ["spawned","routing_resolved"].includes(String(e.type)) && timestamp(e.ts) && !!obj(e.payload)),
 events => Buffer.byteLength(JSON.stringify(events)));
export function recordedEvents(state: ViewerState, id: string): Json[] {
 if (!isSafeId(id)) return [];
 try { return cachedEvents(join(state.stateDir, "runs", id, "events.jsonl")); } catch { return []; }
}
export function routingEvents(state: ViewerState, id: string): Json[] {
 return recordedEvents(state,id).filter(e => e.type === "routing_resolved");
}
export function routingFacts(state: ViewerState, job: Json): ViewerRoutingFacts | null {
 const event = [...routingEvents(state, String(job.job_id))].sort((a,b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
 const routing = obj(event?.payload) ?? obj(job.routing);
 if (!routing) return null;
 const provenance = obj(routing.provenance);
 const facts = {scope:str(routing.scope) ?? null, risk:str(routing.risk) ?? null,
  provenance:{scope:str(provenance?.scope) ?? null, risk:str(provenance?.risk) ?? null},
  rule:str(routing.rule) ?? null, reasons:strings(routing.reasons)};
 return facts.scope || facts.risk || facts.rule || facts.reasons.some(Boolean) ? facts : null;
}
export function routingText(state: ViewerState, job: Json): string | null {
 const facts = routingFacts(state,job);
 if (!facts) return null;
 const axis = (key: "scope" | "risk") => facts[key] ? `${key}:${facts[key]}${facts.provenance[key] ? ` (${facts.provenance[key]})` : ""}` : null;
 return [axis("scope"), axis("risk"), facts.rule, ...facts.reasons].filter(Boolean).join(" · ") || null;
}
export function quota(state: ViewerState, jobs: Json[]): QuotaObservation | null {
 const candidates = [...jobs].filter(j => isSafeId(String(j.job_id))).sort((a,b) => (str(b.dispatched_at) ?? "").localeCompare(str(a.dispatched_at) ?? "")).slice(0,20);
 let latest: QuotaObservation | null = null;
 for (const job of candidates) for (const event of routingEvents(state, String(job.job_id))) {
  const payload = obj(event.payload); const value = obj(payload?.quota);
  if (!Array.isArray(value?.providers)) continue;
  const capacity = obj(payload?.capacity);
  const scores = capacity?.source === "admin" && Array.isArray(capacity.scores) ? capacity.scores.map(obj) : [];
  const pct = (v: unknown) => { const n = nonnegative(v); return n !== null && n <= 100 ? n : null; };
  const providers = value.providers.flatMap(v => {
   const p = obj(v);
   if (!p || !str(p.provider) || typeof p.tight !== "boolean") return [];
   return [{provider:String(p.provider), five_hour:pct(p.five_hour), seven_day:pct(p.seven_day), tight:p.tight, free_slots:nonnegative(scores.find(s => s?.provider === p.provider)?.score)}];
  });
  if (providers.length && (!latest || String(event.ts) > latest.observed_at)) latest = {observed_at:String(event.ts), source_job_id:String(job.job_id), historical:true, providers};
 }
 return latest;
}
export function health(state: ViewerState, jobs: Json[], now: number, available: boolean, isAlive: (pid: number) => boolean = pidAlive): OverviewResponse["fleet"] {
 const parent = parentRow(state, now);
 const lock = readObject(join(state.stateDir,"parent.lock"));
 const pid = nonnegative(lock?.pid);
 const startedAt = lock?.started_at;
 const holder = pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null;
 // The lock file is a record, not a fact: a crashed parent leaves it behind (cp-hvbj).
 const alive = holder !== null && isAlive(holder);
 const stale = !alive && holder !== null && timestamp(startedAt) ? startedAt : null;
 let live = 0, working = 0, idle_held = 0, unknown = 0;
 for (const job of jobs.filter(j => ["waiting","held","launching"].includes(String(j.phase)))) {
  const status = readStatus(state, String(job.job_id));
  if (!status || !["starting","working","idle","exited"].includes(str(status.phase) ?? "")) { unknown++; continue; }
  if (status.exited_at || obj(job.worker)?.exited_at || status.phase === "exited") continue;
  live++; if (status.phase === "working" || status.phase === "starting") working++;
  if (status.phase === "idle" && job.phase === "held") idle_held++;
 }
 return {
  parent:{model:str(readObject(join(state.stateDir,"sessions","cp-parent-control.json"))?.model) ?? null, pid:holder, alive, stale_since:stale, activity:parent.last_activity ? parent.live ? "recent" : "idle" : "unknown", context_tokens:nonnegative(parent.context_tokens), compact_at_tokens:parent.compact_at_tokens ?? null,
   last_turn_cost_usd:nonnegative(parent.last_turn_cost_usd), last_activity:parent.last_activity ?? null, last_compact_at:timestamp(parent.last_compact_at) ? parent.last_compact_at : null},
  workers:{live:available ? live : null, working:available ? working : null, idle_held:available ? idle_held : null, unknown}, operator:{running:false, pid:null, since:null, held:null},
 };
}
