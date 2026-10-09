/**
 * `GET /api/stats` (S8a): a read-only projection of the ledger, fleet, run status, run events, mandates and
 * decisions. Definitions are in docs/viewer-app.md (Stats). Nothing is written and no rollup exists: the
 * only scan is each finished job's events.jsonl, each file bounded at 16 MiB and the whole request at 128 MiB.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceAvailability, StatsMandateRow, StatsResponse, ViewerJob } from "./api-types.ts";
import { jobEventsFile, jobsView } from "./jobs-view.ts";
import { readMandates } from "./fleet-view.ts";
import { decisions } from "./overview-decisions.ts";
import { objectList, timestamp } from "./overview-read.ts";
import { fleetJobs, isSafeId, num, obj, readObject, readStatus, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";
import { bucketEdges, bucketStep, classifyFinished, deltaPct, median, parseStatsQuery, walkEvents, type EventFacts } from "./stats-series.ts";

const REVIEWER_RUN_DIR = /^(?:gate|review|quality)-[a-z0-9_-]+$/;
/** Per-file and per-request read bounds for events.jsonl; the parameter exists so tests can use small ones. */
export interface ScanLimits { file: number; budget: number }
const DEFAULT_LIMITS: ScanLimits = { file: 16 * 1024 * 1024, budget: 128 * 1024 * 1024 };
const shortModel = (model: string): string => model.split("/").pop() || model;
const iso = (ms: number): string => new Date(ms).toISOString();

interface U { input: number; output: number; cache: number; total: number; cost: number }
function usage(value: unknown): U | undefined {
 const u = obj(value);
 return u ? { input: num(u.input) ?? 0, output: num(u.output) ?? 0, cache: num(u.cache_read) ?? 0, total: num(u.total_tokens) ?? 0, cost: num(u.cost_usd) ?? 0 } : undefined;
}
interface Reviewer { model: string; usage: U | undefined; started?: number; exited?: number; events: string }
interface Facts {
 job: ViewerJob; kind: "merged" | "closed"; finish: number; created?: number; model: string; worker: U | undefined; reviewers: Reviewer[];
 cost: number | null; input: number | null; output: number | null; mandateTokens: number | null;
}
const sum = (values: readonly (number | null)[]): number | null => {
 const known = values.filter((v): v is number => v !== null);
 return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const at = (value: unknown): number | undefined => timestamp(value) ? Date.parse(value) : undefined;

function reviewers(state: ViewerState, id: string): Reviewer[] {
 const dir = join(state.stateDir, "runs", id);
 try {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && REVIEWER_RUN_DIR.test(e.name)).map(e => {
   const status = readObject(join(dir, e.name, "status.json"));
   return { model: str(status?.model) ?? "unknown", usage: usage(status?.usage), started: at(status?.started_at), exited: at(status?.exited_at), events: join(dir, e.name, "events.jsonl") };
  });
 } catch { return []; }
}

function factsFor(state: ViewerState, job: ViewerJob, created: Map<string, number>, fleet: Map<string, Json>): Facts | null {
 const kind = classifyFinished(job); const finish = at(job.finished_at);
 if (!kind || finish === undefined) return null;
 const status = readStatus(state, job.id); const entry = fleet.get(job.id);
 const live = usage(status?.usage); const saved = usage(entry?.usage);
 const worker = live && live.total > (saved?.total ?? 0) ? live : saved ?? live;
 const rv = reviewers(state, job.id);
 const known = [worker, ...rv.map(r => r.usage)].filter((u): u is U => u !== undefined);
 const pick = (f: (u: U) => number): number | null => known.length ? known.reduce((a, u) => a + f(u), 0) : null;
 return { job, kind, finish, created: created.get(job.id), model: str(status?.model) ?? str(obj(entry?.worker)?.model) ?? job.model ?? "unknown", worker, reviewers: rv,
  cost: pick(u => u.cost), input: pick(u => u.input), output: pick(u => u.output), mandateTokens: pick(u => Math.max(0, u.total - u.cache)) };
}

/** Bounded, uncached read of one events file; null (with a counted reason) when over the bounds. */
function eventScanner(limits: ScanLimits) {
 let budget = limits.budget; const counts = { oversize: 0, skipped: 0 };
 const read = (file: string | undefined, inspect = false): string | undefined => {
  if (!file) return undefined;
  try {
   if (inspect && !lstatSync(file).isFile()) return undefined;
   const size = statSync(file).size;
   if (size > limits.file) { counts.oversize++; return undefined; }
   if (size > budget) { counts.skipped++; return undefined; }
   budget -= size; return readFileSync(file, "utf8");
  } catch { return undefined; }
 };
 return { read, counts };
}

export function statsView(state: ViewerState, params: URLSearchParams, now: number, limits: ScanLimits = DEFAULT_LIMITS): { status: 200; body: StatsResponse } | { status: 400; body: { error: string } } {
 const q = parseStatsQuery(params, now);
 if ("error" in q) return { status: 400, body: { error: q.error } };
 const warnings: StatsResponse["warnings"] = [];
 const data = jobsView(state, now);
 warnings.push(...data.warnings);
 const root = runtimeRoot(state.home);
 const ledger = objectList(join(root, "jobs.json"), "jobs", j => typeof j.id === "string" && isSafeId(j.id));
 const fleetSource = objectList(join(state.stateDir, "fleet.json"), "jobs", j => typeof j.job_id === "string" && isSafeId(j.job_id));
 const availability: SourceAvailability = ledger.availability === "unavailable" || fleetSource.availability === "unavailable" ? "unavailable" : ledger.availability === "missing" && fleetSource.availability === "missing" ? "missing" : "ok";
 if (availability === "unavailable") warnings.push({ section: "stats", message: "The job ledger or fleet is unreadable; job figures are unknown, not zero." });
 const created = new Map<string, number>();
 for (const j of ledger.value) { const t = at(j.created_at); if (t !== undefined) created.set(String(j.id), t); }
 const fleet = new Map(fleetJobs(state).map(j => [String(j.job_id), j] as const));
 const jobs = availability === "unavailable" ? [] : data.jobs;

 const span = q.to - q.from;
 const matches = (j: ViewerJob) => (!q.project || j.project === q.project) && (!q.mandate || (j.mandate_id ?? "unassigned") === q.mandate);
 // Filter on the cheap finished_at first; status and reviewer dirs are read only for jobs inside the window.
 const finishedIn = (from: number, to: number): Facts[] => jobs.filter(matches).filter(j => { const t = at(j.finished_at); return t !== undefined && t >= from && t < to && classifyFinished(j) !== null; }).flatMap(j => { const f = factsFor(state, j, created, fleet); return f ? [f] : []; });
 const current = finishedIn(q.from, q.to);
 const prior = finishedIn(q.from - span, q.from);

 // Events: bucketed token series, phase endpoints and the first-try CI observation, current window only.
 const step = bucketStep(q); const edges = bucketEdges(q.from, q.to, step, q.tz);
 const series = edges.map(e => ({ start: iso(e.start), end: iso(e.end), merged: 0, closed: 0, tokens: {} as Record<string, number> }));
 const slot = (t: number) => { if (!(t >= q.from && t < q.to)) return undefined; const i = edges.findIndex(e => t >= e.start && t < e.end); return i < 0 ? undefined : series[i]; };
 for (const f of current) { const b = slot(f.finish); if (b) b[f.kind]++; }
 const scan = eventScanner(limits);
 const queued: number[] = []; const working: number[] = []; const review: number[] = []; const held: number[] = []; const wall: number[] = [];
 const waits: number[] = []; let ciSeen = 0; let ciGreen = 0; let eventTokens = 0;
 const addUsage = (facts: EventFacts) => { for (const u of facts.usage) { eventTokens += u.tokens; const b = slot(u.at); if (b) { const m = shortModel(u.model); b.tokens[m] = (b.tokens[m] ?? 0) + u.tokens; } } };
 for (const f of current) {
  if (f.created !== undefined) wall.push(Math.max(0, f.finish - f.created) / 1000);
  const wf = walkEvents(scan.read(jobEventsFile(state, f.job.id)) ?? "", f.model); addUsage(wf);
  if (wf.ci) { ciSeen++; if (wf.ci === "ci_green") ciGreen++; }
  const spent = f.reviewers.filter(r => r.started !== undefined && r.exited !== undefined);
  for (const r of f.reviewers) addUsage(walkEvents(scan.read(r.events, true) ?? "", r.model));
  const reviewMs = wf.spawned === undefined || !spent.length ? null : spent.reduce((a, r) => a + Math.max(0, Math.min(r.exited!, f.finish) - Math.max(r.started!, wf.spawned!)), 0);
  if (f.created !== undefined && wf.spawned !== undefined) { const w = Math.max(0, wf.spawned - f.created) / 1000; queued.push(w); waits.push(w); }
  const end = wf.envelope ?? wf.exit;
  if (wf.spawned !== undefined && end !== undefined) working.push(Math.max(0, end - wf.spawned) / 1000);
  if (reviewMs !== null) review.push(reviewMs / 1000);
  if (wf.envelope !== undefined) held.push(Math.max(0, f.finish - wf.envelope - (reviewMs ?? 0)) / 1000);
 }
 if (scan.counts.oversize) warnings.push({ section: "stats", message: `${scan.counts.oversize} run log(s) exceed 16 MiB and are left out of the phase, CI and hourly token figures.` });
 if (scan.counts.skipped) warnings.push({ section: "stats", message: `${scan.counts.skipped} run log(s) were not read (128 MiB scan budget); narrow the range or filters.` });

 const spend = sum(current.map(f => f.cost)); const tokensIn = sum(current.map(f => f.input)); const tokensOut = sum(current.map(f => f.output));
 const tokens = tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0);
 const noUsage = current.filter(f => f.cost === null).length;
 if (noUsage) warnings.push({ section: "stats", message: `${noUsage} finished job(s) have no recorded usage; spend and tokens leave them out.` });
 if (tokens !== null && !scan.counts.oversize && !scan.counts.skipped && eventTokens !== tokens) warnings.push({ section: "stats", message: `The hourly token series sums ${eventTokens} from run events; the Tokens total uses recorded run status (${tokens}).` });
 const spendByModel = new Map<string, number>();
 for (const f of current) {
  const add = (model: string, usd: number | undefined) => { if (usd !== undefined) spendByModel.set(shortModel(model), (spendByModel.get(shortModel(model)) ?? 0) + usd); };
  add(f.model, f.worker?.cost); for (const r of f.reviewers) add(r.model, r.usage?.cost);
 }
 const totals = new Map<string, number>(); for (const b of series) for (const [m, n] of Object.entries(b.tokens)) totals.set(m, (totals.get(m) ?? 0) + n);

 // Decisions answered inside the window; a project/mandate filter keeps only those linked to a matching job.
 const d = decisions(state, now); const byId = new Map(jobs.map(j => [j.id, j] as const));
 const decisionsKnown = d.escalations.availability !== "unavailable" && d.askHistory.availability !== "unavailable";
 const items = d.decision_items.filter(i => {
  const t = Date.parse(i.answered_at); if (!(t >= q.from && t < q.to)) return false;
  if (!q.project && !q.mandate) return true;
  const linked = i.job_ids.map(id => byId.get(id)).filter((j): j is ViewerJob => j !== undefined);
  return (!q.project || i.project === q.project || linked.some(j => j.project === q.project)) && (!q.mandate || linked.some(j => (j.mandate_id ?? "unassigned") === q.mandate));
 });
 const forYou = d.escalations.availability === "unavailable" ? null : items.filter(i => i.source === "operator-delegated");
 const byYou = d.askHistory.availability === "unavailable" ? null : items.filter(i => i.source === "you");
 if (!decisionsKnown) warnings.push({ section: "stats", message: "Decisions are unreadable; decision counts are unknown, not zero." });

 // Mandate rows: one per grant covering a finished job, plus Unassigned.
 const grants = readMandates(state); const rows = new Map<string, Facts[]>();
 for (const f of current) { const id = f.job.mandate_id ?? "unassigned"; rows.set(id, [...(rows.get(id) ?? []), f]); }
 const rank = (r: StatsMandateRow) => r.id === "unassigned" ? 3 : r.status === "active" ? 0 : r.status === "paused" ? 1 : 2;
 const mandateRows: StatsMandateRow[] = [...rows].map(([id, set]) => {
  const g = grants.find(m => m.id === id); const cap = obj(g?.spend_cap);
  if (id === "unassigned" || !g) return { id, objective: id === "unassigned" ? "No covering live grant" : null, status: id === "unassigned" ? null : "unknown", jobs: set.length, spend_usd: null, spend_cap_usd: null, tokens: null, token_cap: null, time_left_seconds: null };
  const expiry = at(g.expiry); const live = g.status === "active" || g.status === "paused";
  const expired = expiry !== undefined && expiry <= now;
  return { id, objective: str(g.objective) ?? null, status: live && expired ? "expired" : String(g.status), jobs: set.length, spend_usd: sum(set.map(f => f.cost)), spend_cap_usd: num(cap?.usd) ?? null,
   tokens: sum(set.map(f => f.mandateTokens)), token_cap: num(cap?.tokens) ?? null, time_left_seconds: expiry !== undefined && !expired ? Math.round((expiry - now) / 1000) : null };
 }).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

 const merged = current.filter(f => f.kind === "merged").length; const closed = current.length - merged;
 const unavailable = availability === "unavailable";
 const body: StatsResponse = {
  generated_at: iso(now), range: { from: iso(q.from), to: iso(q.to), key: q.key, bucket_seconds: step / 1000, tz: q.tz }, availability, warnings,
  filters: { projects: data.projects.map(p => p.name), mandates: grants.map(m => ({ id: String(m.id), objective: (str(m.objective) ?? "").slice(0, 200) })), project: q.project, mandate: q.mandate },
  kpis: { spend_usd: spend, spend_delta_pct: deltaPct(spend, sum(prior.map(f => f.cost))), merge_rate: current.length ? merged / current.length : null,
   ci_green_first_try: ciSeen ? ciGreen / ciSeen : null, median_queue_wait_seconds: median(waits), median_wall_clock_seconds: median(wall),
   decisions: forYou && byYou ? forYou.length + byYou.length : null, tokens, tokens_input: tokensIn, tokens_output: tokensOut },
  jobs_finished: unavailable ? { merged: null, closed: null, buckets: [] } : { merged, closed, buckets: series.map(({ start, end, merged: m, closed: c }) => ({ start, end, merged: m, closed: c })) },
  phases: { queued_seconds: median(queued), working_seconds: median(working), held_seconds: median(held), review_seconds: median(review) },
  tokens_by_model: { models: [...totals].sort((a, b) => b[1] - a[1]).map(([m]) => m), buckets: series.map(({ start, end, tokens: t }) => ({ start, end, tokens: t })) },
  spend_by_model: [...spendByModel].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
  decisions: { for_you: forYou?.length ?? null, by_you: byYou?.length ?? null, worth: forYou ? forYou.filter(i => i.worth.length > 0).length : null },
  mandates: mandateRows,
 };
 return { status: 200, body };
}
