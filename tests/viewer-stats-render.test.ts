import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { REPO_ROOT } from "./harness/index.ts";
import type { StatsResponse } from "../src/viewer/api-types.ts";

async function load() {
 const built = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Stats, exportCsv, statsApiUrl} from "./viewer-app/screens/Stats.tsx"; export const draw=(data,query)=>render(h(Stats,{data,query})); export {exportCsv, statsApiUrl};',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 return await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as {draw:(d:StatsResponse,q:string)=>string; exportCsv:(r:StatsResponse["mandates"])=>string; statsApiUrl:(q:string,tz:string|undefined)=>string};
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
 mandates: [{id:"unassigned",objective:null,status:null,jobs:1,spend_usd:null,spend_cap_usd:null,tokens:null,token_cap:null,time_left_seconds:null},{id:"m1",objective:'=Ship, "it"',status:"active",jobs:2,spend_usd:null,spend_cap_usd:5,tokens:null,token_cap:null,time_left_seconds:null}],
 ...over,
});

test("Stats renders six KPIs, four chart tables, CSV, the spend note and no sample data", async () => {
 const {draw} = await load();
 const html = draw(data(),"range=24h");
 assert.deepEqual([...html.matchAll(/<article class="stats-kpi"[^>]*><h2>([^<]+)<\/h2>/g)].map(m => m[1]),["Jobs finished","Spend","Tokens","Merge rate","Median wall clock","Decisions"]);
 assert.match(html,/CI green first try -/,"CI first try is the Merge rate subline, null is a dash");
 assert.match(html,/Held is normal: waiting on CI or review/);
 assert.match(html,/<code>Unassigned<\/code>/); assert.match(html,/No covering live grant/);
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

test("the range caption is browser-local, has two distinct instants, no zone suffix and the prior window", async () => {
 const {draw} = await load();
 const was = process.env.TZ;
 try {
  process.env.TZ = "Asia/Ho_Chi_Minh";
  const html = draw(data({range:{from:"2026-01-01T00:00:00.000Z",to:"2026-01-02T00:00:00.000Z",key:"24h",bucket_seconds:3600,tz:"UTC"}}),"range=24h");
  const cap = /class="stats-caption">([^<]+)</.exec(html)![1]!;
  assert.equal(cap,"Jan 1, 07:00 – Jan 2, 07:00 · compared with the 24h before");
  assert.doesNotMatch(cap,/UTC|GMT/);
 } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test("Jobs finished is a dash when either side is unknown, never missing-as-zero", async () => {
 const {draw} = await load();
 const value = (merged: number | null, closed: number | null) => /<h2>Jobs finished<\/h2><strong>([^<]*)<\/strong>/.exec(draw(data({jobs_finished:{merged,closed,buckets:[]}}),"range=24h"))![1];
 assert.equal(value(null,5),"-"); assert.equal(value(4,null),"-"); assert.equal(value(null,null),"-"); assert.equal(value(4,5),"9");
});

test("CSV export escapes quotes and formula starts and leaves missing values empty", async () => {
 const {exportCsv} = await load();
 const lines = exportCsv(data().mandates).split("\n");
 assert.equal(lines[2],`m1,"'=Ship, ""it""",active,2,,5,,,`);
});

test("Stats CSS paints charts with tokens only and sets no font", () => {
 const css = readFileSync(join(REPO_ROOT,"viewer-app/screens/stats.css"),"utf8"); const tsx = readFileSync(join(REPO_ROOT,"viewer-app/screens/Stats.tsx"),"utf8");
 assert.doesNotMatch(css,/font-family|--amber|--coral|#[\da-f]{3,8}\b/i); assert.doesNotMatch(tsx,/--amber|--coral|#[\da-f]{6}\b|style=/i);
 for (const t of ["blue","green","muted","dim"]) assert.match(css,new RegExp(`\\.stats-fill-${t} \\{ fill: var\\(--${t}\\)`));
});

test("statsApiUrl adds the browser zone to the API query only and keeps an explicit tz", async () => {
 const {statsApiUrl} = await load();
 assert.equal(statsApiUrl("range=7d&project=demo","Asia/Ho_Chi_Minh"),"/api/stats?range=7d&project=demo&tz=Asia%2FHo_Chi_Minh");
 assert.equal(statsApiUrl("range=7d&tz=UTC","Asia/Ho_Chi_Minh"),"/api/stats?range=7d&tz=UTC");
 assert.equal(statsApiUrl("","").toString(),"/api/stats?");
});

test("filter changes rewrite only the hash (no tz) and a new URL refetches /api/stats", async t => {
 const {parseHTML} = await import("linkedom");
 const {draw: _d, ...api} = await load();
 const built = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Stats} from "./viewer-app/screens/Stats.tsx"; import {useScreenData} from "./viewer-app/use-screen-data.ts"; export {act}; const Probe=({url})=>{useScreenData(url,"/api/stream?view=stats"); return null;}; export const mountStats=(root,data,query)=>render(h(Stats,{data,query}),root); export const mountProbe=(root,url)=>render(h(Probe,{url}),root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const m = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as {act:(f:()=>unknown)=>Promise<void>; mountStats:(r:unknown,d:StatsResponse,q:string)=>void; mountProbe:(r:unknown,u:string)=>void};
 void api;
 const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const fetched: string[] = [];
 const saved = ["window","document","fetch","location","EventSource"].map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 const set = (k: string, value: unknown) => Object.defineProperty(globalThis,k,{configurable:true,writable:true,value});
 set("window",window); set("document",document); set("location",{hash:""});
 set("EventSource",class { addEventListener() {} removeEventListener() {} close() {} });
 set("fetch",(url: string) => { fetched.push(url); return new Promise<Response>(() => {}); });
 t.after(() => { for (const [k,d] of saved) { if (d) Object.defineProperty(globalThis,k,d); else Reflect.deleteProperty(globalThis,k); } });
 const root = document.getElementById("root")!;
 // The hook keys its resource on the URL: a changed filter URL fetches the new query.
 await m.act(() => m.mountProbe(root,"/api/stats?range=24h&tz=UTC"));
 await m.act(() => m.mountProbe(root,"/api/stats?range=7d&tz=UTC"));
 assert.deepEqual(fetched,["/api/stats?range=24h&tz=UTC","/api/stats?range=7d&tz=UTC"]);
 // The screen's controls write the hash with the filter and never a tz.
 await m.act(() => m.mountStats(root,data(),"range=24h"));
 const click = (el: Element) => m.act(() => { el.dispatchEvent(new window.Event("click",{bubbles:true})); });
 await click([...root.querySelectorAll(".stats-segments button")].find(b => b.textContent === "7d")!);
 assert.equal((globalThis as {location:{hash:string}}).location.hash,"#stats?range=7d");
 const select = root.querySelector(".stats-pill select")! as HTMLSelectElement;
 await m.act(() => { for (const o of select.querySelectorAll("option")) { if (o.getAttribute("value") === "demo") o.setAttribute("selected",""); else o.removeAttribute("selected"); } select.dispatchEvent(new window.Event("change",{bubbles:true})); });
 assert.equal((globalThis as {location:{hash:string}}).location.hash,"#stats?range=24h&project=demo");
 assert.doesNotMatch((globalThis as {location:{hash:string}}).location.hash,/tz=/);
});

test("Stats user flow: refused Custom range -> corrected in place -> data; filters stay mounted; stale response cannot win", async t => {
 const {parseHTML} = await import("linkedom");
 const built = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {StatsPage} from "./viewer-app/app.tsx"; export {act}; export const mount=(root,query)=>render(h(StatsPage,{current:{screen:"stats",section:null,query}}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const m = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as {act:(f:()=>unknown)=>Promise<void>; mount:(r:unknown,q:string)=>void; unmount:(r:unknown)=>void};
 const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
 const asked: {url:string; resolve:(r:Response)=>void}[] = [];
 const saved = ["window","document","fetch","location","EventSource"].map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 const set = (k: string, value: unknown) => Object.defineProperty(globalThis,k,{configurable:true,writable:true,value});
 set("window",window); set("document",document); set("location",{hash:"#stats"});
 set("EventSource",class { addEventListener() {} removeEventListener() {} close() {} });
 set("fetch",(url: string, init?: {signal?:AbortSignal}) => !url.startsWith("/api/stats") ? new Promise<Response>(() => {}) : new Promise<Response>(resolve => { asked.push({url,resolve}); init?.signal?.addEventListener("abort",() => {}); }));
 let focused: Element | null = document.body;
 Object.defineProperty(document,"activeElement",{configurable:true,get:() => focused});
 window.HTMLElement.prototype.focus = function() { focused = this; };
 t.after(async () => { await m.act(() => m.unmount(document.getElementById("root"))); for (const [k,d] of saved) { if (d) Object.defineProperty(globalThis,k,d); else Reflect.deleteProperty(globalThis,k); } });
 const root = document.getElementById("root")!;
 const settle = () => m.act(async () => { await new Promise<void>(r => setImmediate(r)); });
 const answer = async (i: number, r: Response) => { await m.act(async () => { asked[i]!.resolve(r); await new Promise<void>(res => setImmediate(res)); }); };
 const kpis = () => root.querySelectorAll(".stats-kpi").length;
 const alert = () => root.querySelector("[role=alert]")?.textContent ?? "";

 // 1. Custom with no bounds: the API refuses it; the row stays editable beside the error.
 await m.act(() => m.mount(root,"range=custom")); await settle();
 assert.match(asked[0]!.url,/^\/api\/stats\?range=custom&tz=/);
 await answer(0,new Response(JSON.stringify({error:"custom needs from and to"}),{status:400}));
 assert.match(alert(),/refused \(400\)/); assert.equal(kpis(),0);
 const from = root.querySelector(".stats-from input")!, to = root.querySelector(".stats-to input")!;
 assert.ok(from && to && root.querySelector(".stats-pill select") && root.querySelector(".stats-segments"),"controls remain beside the error");
 (from as HTMLElement).focus();

 // 2. The user corrects From/To in place: same inputs, focus kept, a new request, then data and no error.
 await m.act(() => m.mount(root,"range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z")); await settle();
 assert.equal(asked.length,2); assert.match(asked[1]!.url,/from=2026-01-01T00%3A00%3A00\.000Z&to=2026-01-02T00%3A00%3A00\.000Z&tz=/);
 assert.equal(alert(),"","the refused snapshot is gone as soon as the new query is asked");
 assert.equal(root.querySelector(".stats-from input"),from,"From input is the same node"); assert.equal(root.querySelector(".stats-to input"),to); assert.equal(focused,from,"focus survives the refetch");
 await answer(1,Response.json(data({kpis:{...data().kpis,spend_usd:11}})));
 assert.equal(kpis(),6); assert.match(root.textContent!,/\$11\.00/); assert.equal(alert(),"");
 assert.equal(root.querySelector(".stats-from input"),from);

 // 3. Two quick edits: the older request answers last and must not overwrite the newer query's data.
 await m.act(() => m.mount(root,"range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-03T00%3A00%3A00.000Z")); await settle();
 await m.act(() => m.mount(root,"range=custom&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-04T00%3A00%3A00.000Z")); await settle();
 assert.equal(asked.length,4);
 await answer(3,Response.json(data({kpis:{...data().kpis,spend_usd:33}})));
 await answer(2,Response.json(data({kpis:{...data().kpis,spend_usd:22}})));
 assert.match(root.textContent!,/\$33\.00/); assert.doesNotMatch(root.textContent!,/\$22\.00/);
 assert.equal(root.querySelector(".stats-from input"),from);
});
