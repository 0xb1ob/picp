import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { overview } from "../src/viewer/overview-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { dirname, join } from "node:path";
import { LAYOUT } from "../src/contracts.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

test("Overview CSS constrains long one-line cells", () => {
 const css = readFileSync(join(REPO_ROOT,"viewer-app/screens/overview.css"),"utf8");
 for (const selector of [".overview-line-text",".overview-chip strong"]) {
  const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
  for (const declaration of ["white-space: nowrap", "overflow: hidden", "text-overflow: ellipsis", "min-width: 0"]) assert.ok(rule.includes(declaration), `${selector}: ${declaration}`);
 }
 // Audit P3: four health chips hold at 390px as a 2×2 grid and at 1440px as one row; long values ellipsize (above).
 const [phone, desktop = ""] = css.split("@media (min-width: 900px) {");
 assert.match(phone ?? "", /\.overview-health \{ display: grid; grid-template-columns: repeat\(2,minmax\(0,1fr\)\);/);
 assert.match(desktop, /\.overview-health \{ display: flex; flex: 1 1 auto; min-width: 0; gap: 0; \}/);
 // Measured Title 0/32/118/192px at 1200/1280/1366/1440 with the old tracks. Content width = viewport - 208px rail - 64px gutters: Title must be the widest track at the breakpoint and fit a ~45 character title (7px each) at 1440.
 const wide = css.match(/@media \(min-width: (\d+)px\) \{\s*\.overview-flight, \.overview-flight-columns \{ grid-template-columns: ([^;]+); column-gap: (\d+)px/);
 assert.ok(wide, "wide flight grid");
 const tracks = wide[2]!.trim().split(" "); const fixed = [...wide[2]!.matchAll(/(\d+)px/g)].map(m => +m[1]!);
 const title = +wide[1]! - 208 - 64 - fixed.reduce((a, b) => a + b, 0) - 7 * +wide[3]!;
 assert.ok(tracks.length === 8 && title >= 240 && title >= 1.5 * fixed[0]!, `Title ${title}px must be >= 240px and clearly wider than Job ${fixed[0]}px at ${wide[1]}px`);
 const title1440 = 1440 - 208 - 64 - fixed.reduce((a, b) => a + b, 0) - 7 * +wide[3]!; assert.ok(title1440 >= 45 * 7, `Title ${title1440}px at 1440 must fit 45 characters`); assert.ok(+wide[1]! <= 1200, "the 1200px required check shows the 8 columns and headers");
});

test("times format in the browser's own zone, never a server zone", async t => {
 const {time,observedTime,clock} = await import("../viewer-app/format.ts");
 const zone = process.env.TZ; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
 const at = "2026-09-26T05:41:07Z";
 process.env.TZ = "Asia/Bangkok";
 assert.equal(time(at),"12:41"); assert.equal(time(at,true),"12:41:07"); assert.match(observedTime(at),/26 Sept? 2026, 12:41/);
 assert.match(clock(new Date(at)),/^12:41 \S+/);
 process.env.TZ = "America/Los_Angeles";
 assert.equal(time(at),"22:41"); assert.match(clock(new Date(at)),/^22:41 \S+/);
});

test("Overview is executive: health strip, awaiting, blocked, in flight and shipped, with escaped text", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; import {More} from "./viewer-app/screens/More.tsx"; export const screen=(data,more=false)=>render(h(more?More:Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 const empty = screen(data);
 assert.match(empty, /Nothing needs you/); assert.match(empty, /parent<\/span><strong title="down">down/); assert.doesNotMatch(empty, /quota|not observed/, "no quota chip while quota is null");
 assert.match(empty, /0 live \/ - slots/); assert.match(empty, /Nothing in flight/); assert.match(empty, /Landed today · 0 merged</); assert.doesNotMatch(empty, /Shipped today|closed without PR/);
 assert.doesNotMatch(empty, /Blocked|Decided for you|being handled|Fleet health|Mandates|UTC|\/classic/);
 assert.match(empty, /operator<\/span><strong title="offline">offline</); assert.match(empty, /overview-dot-idle"><\/span>main CI<\/span><strong title="no red latch">no red latch</, "no latch is neutral, not a green dot"); assert.doesNotMatch(empty, /main CI<\/span><strong[^>]*>green/, "no latch is never claimed green");
 const more = screen(data,true); assert.doesNotMatch(more,/aria-disabled="true"|#mandates/);
 // Audit P4 #25: More holds Schedules, Files (and Reports, phone only) plus Notifications; Board and Map are Jobs views.
 for (const screen of ["stats","reports","schedules","files"]) assert.ok(more.includes(`href="#${screen}"`),screen);
 assert.match(more,/class="more-phone" href="#stats"|href="#stats" class="more-phone"/);
 for (const screen of ["awaiting","decided","board","map"]) assert.ok(!more.includes(`href="#${screen}"`),screen);
 assert.match(more,/class="more-phone" href="#reports"|href="#reports" class="more-phone"/);
 assert.match(more,/class="more-phone" href="#settings"|href="#settings" class="more-phone"/);
 data.availability.asks = "unavailable"; data.awaiting.count = null;
 assert.doesNotMatch(screen(data),/Nothing needs you/); assert.match(screen(data),/Questions unavailable/);
 data.availability.asks = "ok"; data.awaiting.count = 4;
 data.awaiting.items = ["ask-ab","ask-cd","ask-ef","ask-gh"].map(id => ({id,project:"demo",question:'<script>bad()</script>' + "long".repeat(100),created_at:data.generated_at,options:[{label:"Keep",consequence:"Paused",reply:`${id}: Keep`}],recommendation:"Keep",source_escalation:null,job_ids:[],context:null,evidence_paths:[]}));
 data.in_flight = [{id:"cp-render",project:"demo",title:"Long title ".repeat(30),phase:"held",model:"recorded-model",script_path:null,elapsed_seconds:400,limit_seconds:100,head:"a".repeat(40),ci:"failed",review:"revise",review_attempts:2,routing:"scope:M",note:null,pr_url:"https://github.com/acme/repo/pull/7"}];
 data.blocked.items = [{id:"cp-wait",title:"Blocked title",blockers:[{id:"cp-render",phase:"held",grant_status:"paused",mandate_id:"md-a",stranded:true}]}];
 data.shipped_today = [{id:"cp-merged",title:"Merged title",merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:"https://github.com/acme/repo/pull/1",cost_usd:1.5}]; data.closed_today = 4;
 data.quota = {observed_at:data.generated_at,source_job_id:"cp-render",historical:true,providers:[{provider:"anthropic",five_hour:50,seven_day:90,tight:true,free_slots:2},{provider:"openai",five_hour:5,seven_day:9,tight:false,free_slots:4}]};
 data.fleet.parent.pid = 4242; data.fleet.parent.alive = true; data.fleet.workers.live = 1;
 data.mandates.items = [{id:"md-a",status:"active",projects:["demo"],objective:"o",expiry:data.generated_at,pause_reason:null,ask_on:[],spend_cap:{usd:1,tokens:1},job_cap:1,dispatch_parallelism:3,spend:null}];
 data.mandates.paused_projects = ["other"];
 const html = screen(data);
 assert.match(html,/Needs you · 4/); assert.doesNotMatch(html,/Awaiting you/,"audit P3 #22: Needs you on the Overview"); assert.equal((html.match(/href="#awaiting" class="overview-line"/g) ?? []).length,3,"at most three awaiting lines");
 assert.match(html,/&lt;script>/); assert.doesNotMatch(html,/<script>|style=|onclick=/i); assert.doesNotMatch(html,/Keep|Nothing needs you/);
 assert.match(html,/parent<\/span><strong title="alive">alive/); assert.match(html,/1 live \/ 3 slots/); assert.match(html,/tight: anthropic</);
 assert.match(html,/Blocked &amp; failed · 1/); assert.match(html,/href="#job\/cp-wait"/); assert.match(html,/Blocked title/); assert.match(html,/blocked by .*cp-render.*paused/);
 assert.match(html,/href="#job\/cp-render"/); assert.match(html,/href="https:\/\/github.com\/acme\/repo\/pull\/7"[^>]*>#7</); assert.ok(html.includes(`title="${data.in_flight[0]!.title}"`));
 assert.match(html,/Landed today · 1 merged · 4 closed without PR · <span title="merged jobs only, worker plus reviewer">\$1\.50/); assert.match(html,/#1 ↗<\/a><span class="overview-meta overview-merge" title="b{40}"><span class="overview-merge-word">merged <\/span><code>bbbbbbb<\/code>/);
 assert.match(html,/CI red</,"audit P3 #21: a held row says why it is held"); assert.doesNotMatch(html,/overview-project/,"one project: no tag");
 assert.match(html,/other · paused/);
 data.availability.fleet = "unavailable"; assert.match(screen(data),/Jobs unavailable/); assert.match(screen(data,true),/- live worktrees/);
 // A pid a crashed parent left behind is down, and the chip says when the lock went stale (cp-hvbj).
 data.fleet.parent.alive = false; data.fleet.parent.stale_since = "2026-09-26T05:41:07Z";
 assert.match(screen(data), /parent<\/span><strong title="down \(stale lock since [^"]+\)">down \(stale lock since/);
});

test("audit P3: Blocked & failed, the operator and main CI chips, project tags, held facts and a capped Landed today", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=(data)=>render(h(Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 const flight = {title:"t",model:null,script_path:null,elapsed_seconds:1,limit_seconds:null,head:"a".repeat(40),review:null,review_attempts:0,routing:null,note:null};
 data.failed = [{id:"cp-dead",project:"demo",title:"Died title",failure:"provider 503: overloaded"}];
 data.in_flight = [{...flight,id:"cp-ci",project:"demo",phase:"held",ci:"in_progress"}, {...flight,id:"cp-rev",project:"other",phase:"held",ci:"unknown",review:"pass",review_attempts:1}, {...flight,id:"cp-w",project:"other",phase:"working",ci:null}];
 data.shipped_today = Array.from({length:7},(_,i) => ({id:`cp-m${i}`,title:`M${i}`,merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:`https://github.com/acme/repo/pull/${i}`,cost_usd:i === 6 ? null : 1}));
 data.fleet.operator = {running:true,pid:7,since:null,held:0};
 data.parent_questions = [{id:"es-a",question:"q",kind:"mission_end",created_at:data.generated_at,job_ids:[],age_seconds:599}];
 assert.match(screen(data),/operator<\/span><strong title="running">running</,"under 10 minutes the chip stays plain");
 data.parent_questions.push({id:"es-b",question:"q",kind:"mission_end",created_at:data.generated_at,job_ids:[],age_seconds:3470});
 data.main_ci = {availability:"ok",red:[{project:"demo",red_since_sha:"c".repeat(40),red_since_at:"2026-09-26T05:41:07Z",workflow:"ci",failing:"AssertionError: x"}]};
 const html = screen(data);
 assert.match(html,/Blocked &amp; failed · 1/); assert.match(html,/href="#job\/cp-dead"/); assert.match(html,/Died title/); assert.match(html,/overview-failed">failed<\/span> · <span title="provider 503: overloaded">provider 503: overloaded/);
 assert.match(html,/href="#decided" class="overview-chip"><span class="overview-meta"><span class="overview-dot overview-dot-tight"><\/span>operator<\/span><strong title="running · 2 unanswered, oldest 57m">/,"amber once one question waited 10 minutes");
 assert.match(html,/overview-dot-ci-red"><\/span>main CI<\/span><strong title="red since ccccccc [^\n"]+\ndemo: AssertionError: x on c{40}">red since ccccccc /);
 assert.equal((html.match(/class="overview-project"/g) ?? []).length,3,"two projects in flight: every row tagged");
 assert.match(html,/CI running</); assert.match(html,/review 1\/5 pass</); assert.match(html,/overview-dot-working/); assert.match(html,/0m \/ -</);
 assert.match(html,/Landed today · 7 merged · <span title="[^"]+">\$6\.00/,"total over every merged row with a known cost");
 assert.equal((html.match(/↗/g) ?? []).length,5,"five landed rows");
 assert.match(html,/href="#jobs" class="overview-more">2 more merged in Jobs →</);
 data.main_ci = {availability:"ok",red:[...data.main_ci.red,{project:"beta",red_since_sha:"d".repeat(7),red_since_at:"2026-09-26T05:41:07Z",workflow:null,failing:null}]};
 assert.match(screen(data),/<strong title="demo red since ccccccc [^,]+, beta red since ddddddd /,"per project once more than one is red");
 data.main_ci = {availability:"unavailable",red:[]}; assert.match(screen(data),/main CI<\/span><strong title="unreadable">unreadable</);
 data.fleet.operator = {running:false,pid:null,since:null,held:2}; assert.match(screen(data),/overview-dot-down"><\/span>operator<\/span><strong title="offline · 2 unanswered, oldest 57m · 2 held">/);
});

test("audit P3 #20 #21 end to end: recorded ci-watch values reach the held fact, and a merge past the dashboard's finished cap keeps its cost", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=(data)=>render(h(Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const put = (file: string, value: unknown) => { const path = join(home.path, file); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify(value)); };
 const head = "a".repeat(40); const at = new Date().toISOString();
 // What ci-watch records (`ciStateOf` → merge-ask's `ci`), plus a legacy `red` its schema would also accept.
 const cases: [string, string][] = [["failed","CI red"],["red","CI red"],["in_progress","CI running"],["green","CI green"],["unreviewed","CI green"],["unknown","held"]];
 const merged = Array.from({length:12},(_,i) => `cp-m${i}`);
 put(LAYOUT.fleetFile, {jobs:[
  ...cases.map(([ci]) => ({job_id:`cp-${ci.replace("_","-")}`,project:"demo",phase:"held",dispatched_at:at})),
  ...merged.map((id,i) => ({job_id:id,project:"demo",phase:"done",dispatched_at:at,closed_at:new Date(Date.now() - i * 1000).toISOString(),usage:{input:0,output:0,cache_read:0,cache_write:0,total_tokens:1,cost_usd:0.5}}))]});
 put(join(LAYOUT.state, "ci-watch.json"), {jobs:cases.map(([ci]) => ({job_id:`cp-${ci.replace("_","-")}`,head_sha:head,last_ci:ci}))});
 for (const id of merged) put(join(LAYOUT.runs, id, "merge.json"), {job_id:id,pr_url:"https://github.com/acme/repo/pull/9",merge_commit_sha:"b".repeat(40),merged_at:at});
 const data = overview({home:home.path,stateDir:join(home.path, LAYOUT.state)});
 assert.deepEqual(data.in_flight.map(j => j.ci), cases.map(([ci]) => ci), "flights() passes the recorded value through");
 const html = screen(data);
 const {parseHTML} = await import("linkedom"); const document = parseHTML(html).document;
 for (const [ci, fact] of cases) assert.equal(document.querySelector(`[aria-label="cp-${ci.replace("_","-")}"] .overview-flight-extra .overview-meta`)?.textContent,fact,ci);
 assert.deepEqual(data.shipped_today.map(j => j.cost_usd), merged.map(() => 0.5), "all 12 merged rows keep their cost past FINISHED_SHOWN (10)");
 assert.match(html, /Landed today · 12 merged · <span title="[^"]+">\$6\.00/);
 assert.match(html, /#\d+ ↗.*merged <\/span><code>[0-9a-f]{7}/);
});

test("stamp, shortSha, prNumber and phaseText", async t => {
 const {stamp, shortSha, prNumber, phaseText} = await import("../viewer-app/format.ts");
 const zone = process.env.TZ; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
 process.env.TZ = "Asia/Bangkok";
 const at = "2026-09-26T05:41:07Z";
 assert.match(stamp(at), /^12:41 \S+$/);
 assert.match(stamp(at, true), /^12:41:07 \S+$/);
 assert.equal(shortSha(null), null);
 assert.equal(shortSha("a".repeat(40)), "aaaaaaa");
 assert.equal(prNumber(null), null);
 assert.equal(prNumber("https://github.com/acme/repo/pull/265"), "#265");
 assert.equal(phaseText("waiting"), "no run status");
 assert.equal(phaseText("working"), "working");
});


test("S7 Overview has a calm empty strip, complete flight cells and five projected landed rows", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; export const screen=data=>render(h(Overview,{data}));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
 const {screen} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
 const {parseHTML} = await import("linkedom");
 const data = overview({home:home.path,stateDir:join(home.path,LAYOUT.state)});
 data.decided_today = {...data.decided_today,count:3,by_you:2};
 data.mandates.paused_projects = ["fixture-paused"];
 const flight = {id:"cp-prehead",project:"picp",title:"Long job ".repeat(50),phase:"working",model:"provider/recorded-model",script_path:null,elapsed_seconds:120,limit_seconds:600,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null,pr_url:null,cost_usd:0.25};
 data.in_flight = [flight,{...flight,id:"cp-held",project:"fixture-lab",phase:"held",head:"a".repeat(40),ci:"green",review:"pass",review_attempts:1,elapsed_seconds:900,context:{tokens:25,window:100,percent:25,level:"ok",model:"recorded-model",reason:null,last_compact_at:null,thinking:null},pr_url:"https://github.com/acme/repo/pull/8"},{...flight,id:"cp-unknown",elapsed_seconds:null,limit_seconds:null,cost_usd:null}];
 data.shipped_today = Array.from({length:7},(_,i)=>({id:`cp-landed-${i}`,title:`Landed ${i}`,merged_at:data.generated_at,merge_sha:"b".repeat(40),pr_url:`https://github.com/acme/repo/pull/${i+1}`,cost_usd:0.5}));
 const doc = () => parseHTML(screen(data)).document;
 let document = doc();
 const clear = document.querySelector("#awaiting.overview-clear")!;
 assert.ok(clear,"available empty questions use a single calm strip");
 assert.match(clear.textContent!,/Nothing needs you.*5 decided today · 3 for you, 2 by you/);
 assert.equal(clear.querySelector("a")?.getAttribute("href"),"#decided"); assert.equal(clear.querySelector("h2"),null);
 assert.equal(document.querySelector(".overview-paused-pill")?.textContent,"fixture-paused · paused"); assert.ok(document.querySelector(".page-header-context .overview-paused-pill"),"paused pills live in the title row"); assert.equal(document.querySelector(".overview-subtitle"),null);
 assert.equal(document.querySelector(".overview-health")?.parentElement,document.querySelector(".overview-services")?.parentElement,"health and service line share compact spacing");
 assert.deepEqual([...document.querySelectorAll(".overview-flight-columns > span")].map(e=>e.textContent),["Job","Title","Wall clock","Context","Review","CI","Model","Cost"]); assert.match(document.querySelector(".overview-held-hint")!.textContent!,/held = waiting on CI or review, normal for hours/);
 assert.deepEqual([...document.querySelectorAll(".overview-landed-columns > span")].map(e=>e.textContent),["Job","Title","PR","Commit","Cost"]);
 const rows = [...document.querySelectorAll(".overview-flight")]; assert.equal(rows.length,3);
 for (const row of rows) for (const cell of [".overview-job-id",".overview-flight-title",".overview-clock",".overview-context",".overview-review",".overview-ci",".overview-model",".overview-cost"]) assert.ok(row.querySelector(cell),cell);
 assert.equal(rows[0]!.querySelector("progress")?.getAttribute("value"),"20");
 assert.match(rows[0]!.querySelector(".overview-clock")!.textContent!,/2m \/ 10m/); assert.match(rows[0]!.querySelector(".overview-context")!.textContent!,/context n\/a/); assert.equal(rows[1]!.querySelector(".overview-context .ctx-prefix")?.textContent,"ctx ");
 assert.equal(rows[0]!.querySelector(".overview-line-text")?.getAttribute("title"),flight.title);
 assert.match(rows[0]!.querySelector(".overview-review")!.textContent!,/review not started/); assert.match(rows[0]!.querySelector(".overview-ci")!.textContent!,/no CI yet/);
 assert.equal(rows[0]!.querySelector(".overview-model code")?.textContent,"recorded-model"); assert.equal(rows[0]!.querySelector(".overview-cost")?.textContent,"$0.25");
 assert.equal(rows[1]!.querySelector('progress[aria-label="Wall clock"]')?.getAttribute("value"),"100","overdue wall clock is bounded");
 assert.equal(rows[1]!.querySelector('progress[aria-label="Context window used"]')?.getAttribute("value"),"25");
 assert.match(rows[1]!.textContent!,/review 1\/5 pass/); assert.match(rows[1]!.querySelector(".overview-ci")!.textContent!,/CI green aaaaaaa/);
 assert.equal(rows[2]!.querySelector("progress"),null,"unknown elapsed/limit never fabricates a bar"); assert.equal(rows[2]!.querySelector(".overview-cost")?.textContent,"-");
 const landed = [...document.querySelectorAll(".overview-landed")];
 assert.deepEqual(landed.map(row=>row.querySelector(".overview-job-id code")?.textContent),data.shipped_today.slice(0,5).map(j=>j.id));
 for (const row of landed) { assert.ok(row.querySelector(".overview-dot-done")); assert.equal(row.querySelector(".overview-merge code")?.textContent,"bbbbbbb"); assert.equal(row.querySelector(".overview-merge")?.getAttribute("title"),"b".repeat(40)); assert.equal(row.querySelector(".overview-cost")?.textContent,"$0.50"); }
 assert.equal(landed[0]!.querySelector(".overview-landed-pr")?.getAttribute("href"),data.shipped_today[0]!.pr_url);
 assert.match(document.querySelector(".overview")!.textContent!,/Landed today · 7 merged · \$3\.50/); assert.match(document.querySelector(".overview")!.textContent!,/2 more merged in Jobs →/); assert.equal(document.querySelector(".overview-block h2 span[title]")?.getAttribute("title"),"merged jobs only, worker plus reviewer");
 data.availability.asks="unavailable";data.awaiting.count=null;document=doc();assert.equal(document.querySelector(".overview-clear"),null);assert.match(document.querySelector(".overview")!.textContent!,/Questions unavailable/);
 data.availability.asks="ok";data.awaiting.count=1;data.awaiting.items=[{id:"ask-ab",project:"picp",question:"Continue?",created_at:data.generated_at,options:[],recommendation:"Continue",source_escalation:null,job_ids:[],context:null,evidence_paths:[]}];
 document=doc();assert.equal(document.querySelector(".overview-clear"),null);assert.match(document.querySelector("#awaiting")!.textContent!,/Needs you · 1.*Continue\?/);assert.ok(document.querySelector(".overview-square-attention"));
});
