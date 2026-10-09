import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createViewer } from "../src/viewer/server.ts";
import { statsView } from "../src/viewer/stats-view.ts";
import { bucketEdges, deltaPct, median, parseStatsQuery } from "../src/viewer/stats-series.ts";
import type { StatsResponse } from "../src/viewer/api-types.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const T = (hhmm: string, day = "2026-10-08") => `${day}T${hhmm}:00Z`;
const SHA = "c".repeat(40);

function fixture() {
 const home = createScratchHome();
 const put = (file: string, value: unknown) => { const path = join(home.path, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
 const lines = (events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n") + "\n";
 const usage = (cost: number, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cache_read: cacheRead, cache_write: cacheWrite, total_tokens: input + output + cacheRead + cacheWrite, cost_usd: cost });
 const ids = ["cp-m", "cp-c", "cp-f", "cp-nocreated", "cp-prior"];
 const created: Record<string, string | undefined> = { "cp-m": T("09:00"), "cp-c": T("10:00"), "cp-f": T("08:00"), "cp-nocreated": undefined, "cp-prior": T("05:00", "2026-10-07") };
 const closedAt: Record<string, string> = { "cp-m": T("10:00"), "cp-c": T("11:00"), "cp-f": T("10:30"), "cp-nocreated": T("10:30"), "cp-prior": T("06:00", "2026-10-07") };
 put("jobs.json".replace(/^/, ".pi-command-post/"), { jobs: ids.map(id => ({ id, title: id, status: "closed", labels: ["project:demo", "kind:ship"], ...(created[id] ? { created_at: created[id] } : {}), closed_at: closedAt[id] })) });
 put(LAYOUT.fleetFile, { jobs: ids.map(id => ({ job_id: id, project: "demo", kind: "ship", phase: id === "cp-f" ? "failed" : "done", dispatched_at: closedAt[id], closed_at: closedAt[id], ...(id === "cp-m" ? { mandate_id: "md-a" } : {}), ...(id === "cp-f" ? { failure: { class: "x", message: "boom", at: closedAt[id] } } : {}) })) });
 put(join(LAYOUT.runs, "cp-m/merge.json"), { job_id: "cp-m", merged_at: T("10:00"), pr_url: "https://github.com/o/r/pull/1", merge_commit_sha: SHA });
 const status = (id: string, model: string, u: unknown) => put(join(LAYOUT.runs, id, "status.json"), { model, usage: u });
 status("cp-m", "prov/worker-model", usage(1.5, 100, 50, 10, 10));
 status("cp-c", "prov/worker-model", usage(2, 20, 10));
 status("cp-f", "prov/worker-model", usage(9, 900, 900));
 status("cp-nocreated", "prov/other", usage(1, 5, 5));
 status("cp-prior", "prov/worker-model", usage(1, 1, 1));
 put(join(LAYOUT.runs, "cp-m/gate-1/status.json"), { model: "x/rev", usage: usage(0.5, 10, 5), started_at: T("09:52"), exited_at: T("09:55") });
 put(join(LAYOUT.runs, "cp-m/events.jsonl"), lines([
  { source: "cp", ts: T("09:10"), type: "spawned", payload: {} },
  { source: "pi", ts: T("09:30"), type: "message_end", payload: { message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 10 } } } },
  { source: "cp", ts: T("09:50"), type: "envelope_received", payload: {} },
  { source: "cp", ts: T("09:51"), type: "ci_observed", payload: { event: "ci_failed" } },
  { source: "cp", ts: T("09:55"), type: "ci_observed", payload: { event: "ci_green" } },
 ]));
 put(join(LAYOUT.runs, "cp-c/events.jsonl"), lines([
  { source: "cp", ts: T("10:05"), type: "spawned", payload: {} },
  { source: "cp", ts: T("10:20"), type: "ci_observed", payload: { event: "ci_green" } },
  { source: "cp", ts: T("10:50"), type: "process_exit", payload: {} },
 ]));
 put(join(LAYOUT.mandates, "md-a.json"), { id: "md-a", status: "active", issued_at: T("00:00", "2026-10-01"), expiry: "2099-01-01T00:00:00Z", projects: ["demo"], objective: "Goal A", job_ids: ["cp-m"], spend_cap: { usd: 20, tokens: 1000 } });
 const answered = (id: string, answered_at: string, rule?: string) => ({ id, status: "answered", question: `Q ${id}`, created_at: T("07:00"), answered_at, answer: "yes", answered_by: "operator-delegated", job_ids: ["cp-m"], options: [{ id: "yes", label: "Yes" }], ...(rule ? { delegation_rule: rule } : {}) });
 put(LAYOUT.escalationsFile, { items: [answered("es-a", T("08:00")), answered("es-b", T("08:30"), "standing order"), answered("es-old", T("08:00", "2026-09-01"))] });
 put(join(LAYOUT.state, "operator/asks.jsonl"), [
  { type: "open", id: "ask-ab", project: "demo", created_at: T("07:00"), question: "Q?", options: [{ label: "Keep", consequence: "x" }], recommendation: "Keep" },
  { type: "answer", id: "ask-ab", answer: "Keep", answered_at: T("09:00") },
 ].map(e => JSON.stringify(e)).join("\n") + "\n");
 const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
 const get = (query = "range=24h", now = NOW) => { const out = statsView(state, new URLSearchParams(query), now); assert.equal(out.status, 200); return out.body as StatsResponse; };
 return { home, state, put, get };
}

test("merged, closed without PR and failed are classified; wall clock, queue wait, CI and merge rate follow the definitions", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 const s = get();
 assert.equal(s.availability, "ok");
 assert.deepEqual([s.jobs_finished.merged, s.jobs_finished.closed], [1, 2], "failed cp-f is in neither; cp-prior is outside the window");
 assert.equal(s.kpis.merge_rate, 1 / 3);
 assert.equal(s.kpis.median_wall_clock_seconds, 3600, "finish - ledger created_at; cp-nocreated has no created_at and is skipped, not zeroed");
 assert.equal(s.kpis.median_queue_wait_seconds, 450, "median of 600s (cp-m) and 300s (cp-c)");
 assert.equal(s.kpis.ci_green_first_try, 0.5, "cp-m failed first; cp-c green first; cp-nocreated has no CI event so is not in the denominator");
 assert.deepEqual(s.phases, { queued_seconds: 450, working_seconds: 2550, held_seconds: 420, review_seconds: 180 });
 assert.equal(s.range.key, "24h"); assert.equal(s.range.bucket_seconds, 3600); assert.equal(s.jobs_finished.buckets.length, 24);
 const bucket = (iso: string) => s.jobs_finished.buckets.find(b => b.start === iso)!;
 assert.deepEqual([bucket("2026-10-08T10:00:00.000Z").merged, bucket("2026-10-08T10:00:00.000Z").closed], [1, 1], "cp-m merged 10:00, cp-nocreated closed 10:30");
 assert.deepEqual([bucket("2026-10-08T11:00:00.000Z").merged, bucket("2026-10-08T11:00:00.000Z").closed], [0, 1]);
});

test("spend is worker plus reviewer, model rows sum to it, the token KPI is input+output and the mandate row uses mandateTokens", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 const s = get();
 assert.equal(s.kpis.spend_usd, 5, "cp-m 1.5+0.5, cp-c 2, cp-nocreated 1");
 assert.deepEqual(s.spend_by_model, [{ model: "worker-model", usd: 3.5 }, { model: "other", usd: 1 }, { model: "rev", usd: 0.5 }]);
 assert.equal(s.spend_by_model.reduce((a, m) => a + m.usd, 0), s.kpis.spend_usd);
 assert.deepEqual([s.kpis.tokens_input, s.kpis.tokens_output, s.kpis.tokens], [100 + 10 + 20 + 5, 50 + 5 + 10 + 5, 205]);
 const row = s.mandates.find(m => m.id === "md-a")!;
 assert.equal(row.tokens, 170 - 10 + 15, "(total - cache_read) worker + reviewer: not input+output");
 assert.notEqual(row.tokens, 165);
 assert.deepEqual([row.jobs, row.spend_usd, row.spend_cap_usd, row.token_cap, row.status, row.objective], [1, 2, 20, 1000, "active", "Goal A"]);
 assert.ok(row.time_left_seconds! > 0);
 assert.deepEqual(s.mandates.map(m => m.id), ["md-a", "unassigned"]);
 assert.deepEqual(s.mandates[1], { id: "unassigned", objective: "No covering live grant", status: null, jobs: 2, spend_usd: null, spend_cap_usd: null, tokens: null, token_cap: null, time_left_seconds: null });
 assert.ok(s.warnings.some(w => /hourly token series sums 150/.test(w.message)), "event sum vs status totals gap is named, not hidden");
});

test("message_end timestamps land in their hour bucket for the finished jobs only", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 const s = get();
 const hour = s.tokens_by_model.buckets.find(b => b.start === "2026-10-08T09:00:00.000Z")!;
 assert.deepEqual(hour.tokens, { "worker-model": 150 });
 assert.deepEqual(s.tokens_by_model.models, ["worker-model"]);
 assert.equal(s.tokens_by_model.buckets.filter(b => Object.keys(b.tokens).length).length, 1);
});

test("prior period: an equal window ending at from; a prior of 0 is null, not 0% or Infinity", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 assert.equal(get().kpis.spend_delta_pct, 400, "5 now vs 1 (cp-prior) in the 24h before");
 assert.equal(get("range=7d").kpis.spend_delta_pct, null, "nothing finished in the prior 7d");
 assert.equal(deltaPct(5, 0), null); assert.equal(deltaPct(null, 3), null); assert.equal(deltaPct(3, null), null); assert.equal(deltaPct(6, 4), 50);
});

test("decisions are counted by answered_at inside the range; worth is the judgement basis", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 const s = get();
 assert.deepEqual(s.decisions, { for_you: 2, by_you: 1, worth: 1 });
 assert.equal(s.kpis.decisions, 3);
 assert.deepEqual(get("range=24h&project=other").decisions, { for_you: 0, by_you: 0, worth: 0 });
});

test("an empty window is null and zero-count, never a fabricated figure; a missing source is null", t => {
 const { home, get } = fixture(); t.after(() => home.cleanup());
 const s = get("range=custom&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z");
 assert.deepEqual([s.jobs_finished.merged, s.jobs_finished.closed], [0, 0]);
 assert.deepEqual([s.kpis.spend_usd, s.kpis.merge_rate, s.kpis.median_wall_clock_seconds, s.kpis.median_queue_wait_seconds, s.kpis.ci_green_first_try, s.kpis.tokens], [null, null, null, null, null, null]);
 assert.deepEqual(s.phases, { queued_seconds: null, working_seconds: null, held_seconds: null, review_seconds: null });
 assert.deepEqual(s.mandates, []);
 const bare = createScratchHome(); t.after(() => bare.cleanup());
 const out = statsView({ home: bare.path, stateDir: join(bare.path, LAYOUT.state) }, new URLSearchParams(), NOW);
 assert.equal(out.status, 200); assert.equal((out.body as StatsResponse).availability, "missing"); assert.equal((out.body as StatsResponse).kpis.spend_usd, null);
});

test("an unreadable ledger is flagged and job figures are null, not zero", t => {
 const { home, put, get } = fixture(); t.after(() => home.cleanup());
 put(".pi-command-post/jobs.json", "{not json");
 const s = get();
 assert.equal(s.availability, "unavailable"); assert.equal(s.jobs_finished.merged, null); assert.deepEqual(s.jobs_finished.buckets, []);
 assert.ok(s.warnings.some(w => /unreadable/.test(w.message)));
});

test("query validation: custom needs from < to and at most 31 days; unknown ranges and filters are refused", () => {
 const q = (s: string) => parseStatsQuery(new URLSearchParams(s), NOW);
 assert.deepEqual(q("range=custom&from=2026-08-31T00:00:00Z&to=2026-10-02T00:00:00Z"), { error: "custom range is limited to 31 days" }, "32 days");
 assert.ok(!("error" in q("range=custom&from=2026-09-01T00:00:00Z&to=2026-10-02T00:00:00Z")), "exactly 31 days");
 assert.deepEqual(q("range=custom&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z"), { error: "from must be before to" });
 assert.ok("error" in q("range=custom&from=2026-10-01"));
 assert.ok("error" in q("range=custom"));
 assert.ok("error" in q("range=30d"));
 assert.ok("error" in q("project=../x"));
 assert.ok("error" in q("mandate=nope"));
 assert.deepEqual(q("range=7d&project=&mandate="), { key: "7d", from: NOW - 7 * 86_400_000, to: NOW, project: null, mandate: null });
 assert.equal(bucketEdges(Date.parse("2026-10-08T10:30:00Z"), Date.parse("2026-10-08T12:30:00Z"), 3_600_000).length, 3);
 assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null);
});

test("GET /api/stats serves 200 and 400, /api/stream accepts stats, and nothing is written", async t => {
 const { home, state } = fixture(); t.after(() => home.cleanup());
 const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);
 const before = snapshot(home.path);
 const options = { ...state, host: "127.0.0.1", port: 0 };
 const server = createViewer(options); await new Promise<void>(r => server.listen(0, options.host, r)); options.port = (server.address() as AddressInfo).port; t.after(() => server.close());
 const base = `http://127.0.0.1:${options.port}`;
 const ok = await fetch(`${base}/api/stats?range=24h`); assert.equal(ok.status, 200);
 assert.equal(((await ok.json()) as StatsResponse).range.key, "24h");
 const bad = await fetch(`${base}/api/stats?range=custom&from=2026-01-01T00:00:00Z&to=2026-02-05T00:00:00Z`);
 assert.equal(bad.status, 400); assert.match(((await bad.json()) as { error: string }).error, /31 days/);
 assert.equal((await fetch(`${base}/api/stats?range=bogus`)).status, 400);
 assert.equal((await fetch(`${base}/api/stats`, { method: "POST" })).status, 405);
 assert.equal(await fetch(`${base}/api/stream?view=stats`).then(r => { r.body?.cancel(); return r.status; }), 200);
 assert.deepEqual(snapshot(home.path), before);
});
