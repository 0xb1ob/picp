import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { REPO_ROOT } from "./harness/index.ts";
import type { StatsResponse } from "../src/viewer/api-types.ts";

async function load() {
 const built = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Stats, exportCsv} from "./viewer-app/screens/Stats.tsx"; export const draw=(data,query)=>render(h(Stats,{data,query})); export {exportCsv};',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 return await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as {draw:(d:StatsResponse,q:string)=>string; exportCsv:(r:StatsResponse["mandates"])=>string};
}
const at = "2026-01-02T00:00:00.000Z";
const data = (over: Partial<StatsResponse> = {}): StatsResponse => ({
 generated_at: at, range: {from:"2026-01-01T00:00:00.000Z",to:at,key:"24h",bucket_seconds:3600,tz:"UTC"}, availability: "ok" as StatsResponse["availability"], warnings: [],
 filters: {projects:["demo"],mandates:[{id:"m1",objective:"Ship it"}],project:null,mandate:null},
 kpis: {spend_usd:1.5,spend_delta_pct:null,merge_rate:0.5,ci_green_first_try:null,median_queue_wait_seconds:60,median_wall_clock_seconds:null,decisions:3,tokens:2000,tokens_input:1500,tokens_output:500},
 jobs_finished: {merged:1,closed:1,buckets:[{start:"2026-01-01T00:00:00.000Z",end:"2026-01-01T01:00:00.000Z",merged:1,closed:1}]},
 phases: {queued_seconds:10,working_seconds:null,held_seconds:5,review_seconds:3},
 tokens_by_model: {models:["a"],buckets:[{start:"2026-01-01T00:00:00.000Z",end:"2026-01-01T01:00:00.000Z",tokens:{a:5}}]},
 spend_by_model: [{model:"a",usd:1.5}], decisions: {for_you:1,by_you:2,worth:0},
 mandates: [{id:"m1",objective:'=Ship, "it"',status:"active",jobs:2,spend_usd:null,spend_cap_usd:5,tokens:null,token_cap:null,time_left_seconds:null}],
 ...over,
});

test("Stats renders six KPIs, four chart tables, CSV, the spend note and no sample data", async () => {
 const {draw} = await load();
 const html = draw(data(),"range=24h");
 assert.deepEqual([...html.matchAll(/<article class="stats-kpi"[^>]*><h2>([^<]+)<\/h2>/g)].map(m => m[1]),["Jobs finished","Spend","Tokens","Merge rate","Median wall clock","Decisions"]);
 assert.match(html,/CI green first try -/,"CI first try is the Merge rate subline, null is a dash");
 assert.match(html,/Held is normal: waiting on CI or review/);
 assert.match(html,/Unassigned|Backlog|=Ship/);
 assert.equal((html.match(/aria-pressed="false">Table</g) ?? []).length,4);
 assert.match(html,/Export CSV/); assert.match(html,/Spend includes reviewers/);
 assert.doesNotMatch(html,/Nothing finished/); assert.doesNotMatch(html,/sample|NaN|Infinity/i);
 assert.doesNotMatch(html,/amber|coral/);
 assert.match(html,/<strong>-<\/strong>/,"a missing KPI is a dash, never 0");
 assert.doesNotMatch(html,/type="datetime-local"/);
});

test("From/To appear only for Custom; an empty range says so", async () => {
 const {draw} = await load();
 const custom = draw(data(),"range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z");
 assert.equal((custom.match(/type="datetime-local"/g) ?? []).length,2);
 assert.match(draw(data({jobs_finished:{merged:0,closed:0,buckets:[]}}),"range=7d"),/Nothing finished in this range/);
});

test("the range caption shows two distinct instants and the prior window", async () => {
 const {draw} = await load();
 const html = draw(data({range:{from:"2026-01-01T00:00:00.000Z",to:"2026-01-02T00:00:00.000Z",key:"24h",bucket_seconds:3600,tz:"UTC"}}),"range=24h");
 const cap = /class="stats-caption">([^<]+)</.exec(html)![1]!.replace(/&#x2F;|&amp;/g,"");
 const [from,rest] = cap.split(" – "); assert.ok(from && rest && !rest.startsWith(from), cap);
 assert.match(cap,/ · compared with the 24h before$/);
});

test("CSV export escapes quotes and formula starts and leaves missing values empty", async () => {
 const {exportCsv} = await load();
 const lines = exportCsv(data().mandates).split("\n");
 assert.equal(lines[1],`m1,"'=Ship, ""it""",active,2,,5,,,`);
});

test("Stats CSS paints charts with tokens only and sets no font", () => {
 const css = readFileSync(join(REPO_ROOT,"viewer-app/screens/stats.css"),"utf8"); const tsx = readFileSync(join(REPO_ROOT,"viewer-app/screens/Stats.tsx"),"utf8");
 assert.doesNotMatch(css,/font-family|--amber|--coral|#[\da-f]{3,8}\b/i); assert.doesNotMatch(tsx,/--amber|--coral|#[\da-f]{6}\b|style=/i);
 for (const t of ["blue","green","muted","dim"]) assert.match(css,new RegExp(`\\.stats-fill-${t} \\{ fill: var\\(--${t}\\)`));
});
