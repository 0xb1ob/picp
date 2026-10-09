import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { join } from "node:path";
import { test } from "node:test";
import { jobsView, boardView } from "../src/viewer/jobs-view.ts";
import type { JobResponse, ViewerJob } from "../src/viewer/api-types.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("Jobs, detail and Board render empty, failed and awaiting states; board filters preserve inactive work",async t=>{
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const buildResult=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; import {Board,visibleBoard} from "./viewer-app/screens/Board.tsx"; export {visibleBoard}; export const screen=(name,data)=>render(h({Jobs,JobDetail,Board}[name],{data}));',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {screen,visibleBoard}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);
 const list=jobsView(state); const board=boardView(state);
 assert.match(screen("Jobs",list),/Nothing in flight/); assert.match(screen("Board",board),/Nothing here/);
 const job:ViewerJob={id:"cp-render",project:"demo",title:"<script>unsafe()</script>",phase:"failed",model:"recorded-model",script_path:null,elapsed_seconds:7200,limit_seconds:7200,head:"a".repeat(40),ci:"red",review:"revise",review_attempts:5,routing:"explicit",note:null,ledger_status:"in_progress",ledger_disagrees:true,mandate_id:"md-active",cost_usd:3,pr_url:null,pr_status:null,finished_at:list.generated_at,finished_today:true,merge_sha:null,failure:"wall clock limit",summary:null,blockers:[]};
 list.jobs=[job]; list.projects=[{name:"demo",paused:false}];
 assert.match(screen("Jobs",list),/ledger in_progress/); assert.match(screen("Jobs",list),/wall clock limit/);
 const detail:JobResponse={generated_at:list.generated_at,awaiting_count:1,job,timeline:[],timeline_truncated:false,files_href:null,artifact_href:null,artifact_name:null,run_href:"/api/job/cp-render/events",reports:[],asks:[{id:"ask-a",project:"demo",question:"Continue?",created_at:list.generated_at,options:[{label:"Keep",consequence:"Paused",reply:"ask-a: Keep"}],recommendation:"Keep",source_escalation:null,job_ids:[job.id],context:null,evidence_paths:[]}],questions:[],warnings:[]};
 const html=screen("JobDetail",detail); assert.match(html,/Awaiting you/);assert.match(html,/ask-a: Keep/);assert.match(html,/No recorded events/);assert.match(html,/CI red/);assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/<script>|style=|onclick=/i);
 const failureLink=[...parseHTML(html).document.querySelectorAll("a")].find(a=>a.textContent === "Ask about this failure");
 assert.ok(failureLink,"failed jobs offer an editable recovery question");
 const query=new URLSearchParams(failureLink.getAttribute("href")!.split("?")[1]);
 assert.equal(query.get("view"),"you"); assert.equal(query.get("transcript"),"1");
 assert.equal(query.get("draft"),"Explain why picp job cp-render failed and the available recovery options.");
 for (const phase of ["working","held","done","waiting","idle"] as const) {
  assert.doesNotMatch(screen("JobDetail",{...detail,job:{...job,phase}}),/Ask about this failure/,`${phase} has no failure action`);
 }
 assert.match(screen("JobDetail",{...detail,job:{...job,failure:null}}),/Ask about this failure/,"failed phase is sufficient without a failure headline");
 assert.doesNotMatch(html,/Open report/);
 detail.reports=["alpha","beta"].map(slug=>({slug,title:`${slug} <script> ${"Long report title".repeat(20)}`,description:"",created_at:list.generated_at,job_ids:[job.id],href:`/boards/${slug}/`}));
 detail.files_href="/#files?root=project%3Ademo&path=";
 const reportsHtml=screen("JobDetail",detail); const reportsDoc=parseHTML(reportsHtml).document;
 const reportLinks=[...reportsDoc.querySelectorAll(".job-detail-main .job-report-links a")];
 assert.deepEqual(reportLinks.map(a=>a.getAttribute("href")),["/boards/alpha/","/boards/beta/"]);
 for(const a of reportLinks) { assert.match(a.textContent!,/^Open report ·/); assert.equal(a.getAttribute("target"),"_blank"); assert.equal(a.getAttribute("rel"),"noopener noreferrer"); }
 assert.ok(reportsDoc.querySelector('.job-detail-side .job-links a[href="/#files?root=project%3Ademo&path="]'));
 assert.doesNotMatch(reportsHtml,/<script>|style=|onclick=/i);
 board.jobs=[job,{...job,id:"cp-inactive",mandate_id:"md-paused"}];
 board.lanes=[{id:"md-active",status:"active",active:true,objective:"Active",expiry:null,ask_on:[],spend:null,cap:null,note:null},{id:"md-paused",status:"paused",active:false,objective:"Paused",expiry:null,ask_on:[],spend:null,cap:null,note:null}];
 assert.deepEqual(visibleBoard(board,"all").jobs.map((j:ViewerJob)=>j.id),["cp-render","cp-inactive"]);
 assert.deepEqual(visibleBoard(board,"md-paused").jobs.map((j:ViewerJob)=>j.id),["cp-inactive"]);
 const rendered=screen("Board",board);assert.match(rendered,/All mandates/);assert.match(rendered,/aria-haspopup="listbox"/);assert.doesNotMatch(rendered,/role="listbox"/,"closed by default");assert.match(rendered,/href="#job\/cp-render"/);assert.doesNotMatch(rendered,/<script>|style=|onclick=/i);
 assert.match(rendered,/<h1 title="Jobs">Jobs<\/h1>/);assert.doesNotMatch(rendered,/>Mandates</);
 // All mandates includes inactive landed jobs, so the default count matches Overview and Jobs.
 board.jobs=[...board.jobs,{...job,id:"cp-landed",phase:"done",mandate_id:"md-paused"}];
 const grid=screen("Board",board);
 assert.match(grid,/Landed today<span>1<\/span>/); assert.match(grid,/Failed<span>2<\/span>/,"All mandates retains inactive jobs");
 // A waiting or idle job is not a Working job: it counts under Waiting only.
 board.jobs=[{...job,id:"cp-wait",phase:"waiting"},{...job,id:"cp-idle",phase:"idle"},{...job,id:"cp-run",phase:"working"}];
 const waitGrid=screen("Board",board);
 assert.match(waitGrid,/Working<span>1<\/span>/); assert.match(waitGrid,/Waiting<span>2<\/span>/); assert.match(waitGrid,/needs a person, or the worker is idle/);
 assert.match(screen("Jobs",list),/Done today<span>1<\/span>/);
 // Audit P4 #23: one Jobs item with a List | Board | Map toggle on each view, the current one marked, on every width.
 for (const [name,data,current] of [["Jobs",list,"#jobs"],["Board",board,"#board"]] as const) {
  const views=/<nav class="board-view jobs-views" aria-label="Jobs view">(.*?)<\/nav>/.exec(screen(name,data))?.[1] ?? "";
  assert.deepEqual([...views.matchAll(/href="(#\w+)"/g)].map(m=>m[1]),["#jobs","#board","#map"],name);
  assert.deepEqual([...views.matchAll(/href="(#\w+)" aria-current="page"/g)].map(m=>m[1]),[current],name);
 }
 assert.doesNotMatch(screen("Board",board),/board-view board-phone/,"the toggle is no longer phone-only");
});

test("desktop layout: Jobs rows carry the column cells, detail splits summary from facts, the phone cap lifts at >=900px",async()=>{
 const buildResult=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; export const screen=(name,data)=>render(h({Jobs,JobDetail}[name],{data}));',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {screen}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);
 const job:ViewerJob={id:"cp-wide",project:"demo",title:"A long title ".repeat(20),phase:"working",model:"wide-model",script_path:null,elapsed_seconds:600,limit_seconds:7200,head:"b".repeat(40),ci:"green",review:null,review_attempts:0,routing:"explicit",note:null,ledger_status:null,ledger_disagrees:false,mandate_id:null,cost_usd:1.5,pr_url:null,pr_status:null,finished_at:null,finished_today:false,merge_sha:null,failure:null,summary:null,blockers:[]};
 const jobs=screen("Jobs",{generated_at:"2026-09-27T00:00:00Z",awaiting_count:0,jobs:[job],projects:[],warnings:[]});
 const document = parseHTML(jobs).document;
 assert.deepEqual([...document.querySelectorAll(".jobs-columns-flight > span")].map(e=>e.textContent),["Job","Title","Wall clock","Context","Review","CI","Model","Cost"]);
 assert.equal(document.querySelector(".job-row-id code")?.getAttribute("title"),"cp-wide","the full id rides on the id title");
 assert.ok(document.querySelector(".job-row-link > .job-title + .job-row-heading"),"title precedes the id inside the one job link");
 assert.equal(document.querySelectorAll(".jobs-toolbar > p").length,0,"the held hint lives on the In flight header only");
 assert.match(document.querySelector(".jobs-group > header")!.textContent,/held = waiting on CI or review/);
 const signals = document.querySelector(".job-signals")!;
 assert.deepEqual([...signals.children].map(e=>e.className),["job-clock","job-context","job-review","job-ci job-ci-green","job-model","job-cost"]);
 assert.match(signals.textContent,/10m \/ 2h 0m.*context n\/a.*review not started.*CI green.*wide-model.*\$1\.50/);
 assert.ok(document.querySelector(".jobs-toolbar .jobs-views")); assert.ok(document.querySelector(".jobs-toolbar .jobs-segments"));
 assert.ok(document.querySelector(".jobs-group > header")!.compareDocumentPosition(document.querySelector(".jobs-columns-flight")!) & 4,"flight headers follow their section heading");
 // D15: every flight row has truthful review and CI signals before a first head or PR.
 const bare:ViewerJob={...job,id:"cp-bare",model:"anthropic/claude-opus-5-5",head:null,ci:null,routing:"scope:M (inferred) · risk:high (explicit)",mandate_id:"md-8c47f5"};
 const rows=screen("Jobs",{generated_at:"2026-09-27T00:00:00Z",awaiting_count:0,jobs:[bare],projects:[],warnings:[]});
 assert.doesNotMatch(rows,/job-route|scope:M|md-8c47f5|Routing not recorded|Phases:/); assert.doesNotMatch(rows,/CI -|review -|>anthropic\//);
 assert.match(rows,/<code title="anthropic\/claude-opus-5-5">claude-opus-5-5<\/code>/);
 const prehead = parseHTML(rows).document;
 assert.equal(prehead.querySelector(".job-review")?.textContent,"review not started");
 assert.equal(prehead.querySelector(".job-ci")?.textContent,"no CI yet");
 assert.equal(prehead.querySelector(".job-cost")?.textContent,"$1.50");
 assert.equal(prehead.querySelector(".job-context")?.textContent,"context n/a");
 assert.equal(prehead.querySelector(".job-clock progress")?.getAttribute("value"),String(600/7200*100));
 const finished = [
  {...job,id:"cp-merged",phase:"done",finished_today:true,finished_at:"2026-09-27T09:45:00Z",pr_url:"https://github.com/acme/repo/pull/42",pr_status:"merged",merge_sha:"c".repeat(40)},
  {...job,id:"cp-no-pr",phase:"done",finished_today:true,finished_at:"2026-09-27T09:40:00Z",head:null,model:null,cost_usd:null},
  {...job,id:"cp-unmerged",phase:"done",finished_today:true,finished_at:"2026-09-27T09:35:00Z",pr_url:"https://github.com/acme/repo/pull/43",pr_status:"closed"},
  {...job,id:"cp-failed",phase:"failed",finished_today:true,finished_at:"2026-09-27T09:30:00Z",failure:"provider unavailable"}
 ];
 const doneDoc=parseHTML(screen("Jobs",{generated_at:"2026-09-27T10:00:00Z",awaiting_count:0,jobs:finished,projects:[],warnings:[]})).document;
 assert.deepEqual([...doneDoc.querySelectorAll(".jobs-columns-done > span")].map(e=>e.textContent),["Job","Title","Outcome","Commit","Model","Done","Cost"]);
 const doneRows=[...doneDoc.querySelectorAll(".job-row-done")];
 assert.deepEqual(doneRows.map(e=>e.querySelector(".job-outcome")!.textContent.trim()),["#42 ↗ merged","closed · no PR","#43 ↗ PR closed","failed"]);
 assert.equal(doneRows[0]!.querySelector(".job-outcome a")?.getAttribute("href"),"https://github.com/acme/repo/pull/42");
 assert.equal(doneRows[0]!.querySelector(".job-commit")?.textContent,"ccccccc");
 assert.equal(doneRows[0]!.querySelector(".job-commit")?.getAttribute("title"),"c".repeat(40));
 assert.deepEqual([...doneRows[0]!.querySelector(".job-finished")!.children].map(e=>e.className),["job-outcome","job-commit","job-model","job-finished-at","job-cost"]);
 assert.ok(doneRows[0]!.querySelector(".job-finished-at")?.textContent); assert.equal(doneRows[0]!.querySelector(".job-cost")?.textContent,"$1.50");
 assert.equal(doneRows[1]!.querySelector(".job-commit")?.textContent,"no commits"); assert.equal(doneRows[1]!.querySelector(".job-cost")?.textContent,"-");
 assert.equal(doneRows[2]!.querySelector(".job-commit")?.textContent,"bbbbbbb");
 assert.equal(doneRows[3]!.querySelector(".job-note")?.textContent,"provider unavailable");
 assert.equal(doneDoc.querySelectorAll(".job-context, .ctx-chip, .job-ci, .job-review").length,0,"finished tables have no flight cells");
 assert.equal(doneDoc.querySelectorAll("a a").length,0,"the PR link is separate from the job link");
 const detail=screen("JobDetail",{generated_at:"2026-09-27T00:00:00Z",awaiting_count:0,job:{...job,summary:"Recorded summary"},timeline:[],timeline_truncated:false,files_href:null,artifact_href:null,artifact_name:null,run_href:null,reports:[],asks:[],questions:[],warnings:[]});
 assert.match(detail,/<div class="job-detail"><header class="job-detail-heading">/);
 const detailDoc=parseHTML(detail).document;
 assert.equal(detailDoc.querySelector(".job-detail-body > .job-detail-main > .job-summary")?.textContent,"Recorded summary");
 assert.ok(detailDoc.querySelector(".job-detail-body > .job-detail-side > .job-facts"));
 assert.equal(detailDoc.querySelector(".job-detail-side .job-summary"),null,"summary stays separate from facts");
 assert.match(detail,/<\/div><div class="job-detail-side"><dl class="job-facts">.*<dt>CI<\/dt>.*<dt>Review<\/dt>.*<\/dl><div class="job-links">.*<\/div><\/div><section class="job-timeline">/);
 const desktop=(file:string)=>readFileSync(join(REPO_ROOT,"viewer-app/screens",file),"utf8").split("@media (min-width: 900px) {")[1] ?? "";
 assert.match(readFileSync(join(REPO_ROOT,"viewer-app/screens/jobs.css"),"utf8"),/^\.jobs-screen, \.job-detail \{ max-width: 358px;/, "the phone layout keeps its 358px column");
 assert.match(desktop("jobs.css"),/\.jobs-screen, \.job-detail \{ max-width: none;/);
 assert.match(desktop("jobs.css"),/\.reports-grid \{ display: grid;/);
 assert.match(desktop("job-detail.css"),/\.job-detail-body \{ display: grid;/);
});

test("Done today groups newest first, shows five rows, and finished rows have no context chip", async () => {
 const buildResult=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; export const screen=(data)=>render(h(Jobs,{data}));',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {screen}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);
 const ctx={tokens:10,window:100,percent:10,level:"ok" as const,reason:null,model:"m",thinking:null,last_compact_at:null};
 const job=(over:Partial<ViewerJob>):ViewerJob=>({id:"cp",project:"demo",title:"t",phase:"done",model:"m",script_path:null,elapsed_seconds:1,limit_seconds:null,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null,ledger_status:"closed",ledger_disagrees:false,mandate_id:null,cost_usd:1,pr_url:null,pr_status:null,finished_at:"2026-09-27T00:00:00Z",finished_today:true,merge_sha:null,failure:null,summary:null,blockers:[],context:ctx,...over});
 const demo=["03:00:00","02:50:00","02:40:00","02:30:00","02:20:00","02:10:00"].map((at,i)=>job({id:`cp-d${i}`,finished_at:`2026-09-27T${at}Z`,...(i===0?{pr_status:"merged",merge_sha:"a".repeat(40),cost_usd:2}:{})}));
 const beta=job({id:"cp-beta",project:"beta",finished_at:"2026-09-27T02:55:00Z"});
 const live=job({id:"cp-live",phase:"working",finished_today:false,finished_at:null,context:ctx});
 const waiting=job({id:"cp-wait",phase:"waiting",finished_today:false,finished_at:null,context:null});
 const html=screen({generated_at:"2026-09-27T04:00:00Z",awaiting_count:0,jobs:[beta,...demo,live,waiting],projects:[{name:"alpha",paused:true},{name:"beta",paused:false},{name:"delta",paused:false},{name:"demo",paused:false},{name:"gamma",paused:false}],warnings:[]});
 const done=html.split(">Done today ·")[1]!;
 assert.deepEqual([...parseHTML(html).document.querySelectorAll(".jobs-project h3 > :not(.jobs-project-cost)")].map(e=>e.textContent),["demo"," · 1 merged · 5 closed without PR","beta"," · 0 merged · 1 closed without PR"],"groups follow the newest job, with counts");
 assert.deepEqual([...parseHTML(html).document.querySelectorAll(".jobs-project-cost")].map(e=>e.textContent),["$7.00","$1.00"],"project cost is the bare amount, no middot");
 assert.match(parseHTML(html).document.querySelector(".jobs-group:last-of-type > header")!.textContent,/newest first/);
 assert.ok(parseHTML(html).document.querySelector(".jobs-done-foot .jobs-more"),"show-more sits in the done foot");
 assert.match(parseHTML(html).document.querySelector(".jobs-done-foot")!.textContent,/Show 1 more from demo.*Nothing done today in alpha/);
 assert.deepEqual([...parseHTML(html).document.querySelectorAll(".jobs-project h3 strong")].map(e=>e.textContent),["demo","beta"]);
 assert.match(done,/cp-d0[\s\S]*cp-d4/); assert.doesNotMatch(done.split("Show 1 more from demo")[0]!,/cp-d5/);
 assert.match(done,/Show 1 more from demo/);
 assert.match(done,/Nothing done today in alpha \(paused\), delta or gamma\./);
 assert.doesNotMatch(done,/ctx-chip|job-row-ctx/,"finished rows have no context chip");
 assert.match(html.split(">Done today ·")[0]!,/ctx-chip/);
 assert.match(html,/job-phase">no run status</); assert.doesNotMatch(html,/job-phase">waiting</);
 assert.match(readFileSync(join(REPO_ROOT,"viewer-app/screens/jobs.css"),"utf8"),/\.jobs-segments \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/);
});

test("Board shares status columns and mandate filters, complete flight facts, and four newest landed cards", async t => {
 const buildResult=await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {Board} from "./viewer-app/screens/Board.tsx"; export {act}; export const mount=(root,data)=>render(h(Board,{data}),root); export const unmount=root=>render(null,root);',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {mount,unmount,act}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);
 const {parseHTML}=await import("linkedom");
 const {window,document}=parseHTML("<html><body><div id='root'></div></body></html>");
 const original=Object.getOwnPropertyDescriptor(globalThis,"document");
 Object.defineProperty(globalThis,"document",{configurable:true,value:document});
 const root=document.getElementById("root")!;
 const data=boardView({home:"/nonexistent",stateDir:"/nonexistent"});
 const job:ViewerJob={id:"cp-prehead",project:"picp",title:"A long title ".repeat(20),phase:"working",model:"anthropic/claude-opus-5-5",script_path:null,elapsed_seconds:600,limit_seconds:7200,head:null,ci:null,review:null,review_attempts:0,routing:null,note:null,ledger_status:"in_progress",ledger_disagrees:false,mandate_id:"md-active",cost_usd:1.5,pr_url:null,pr_status:null,finished_at:null,finished_today:false,merge_sha:null,failure:null,summary:null,blockers:[],context:{tokens:10,window:100,percent:10,level:"ok",reason:null,model:"m",thinking:null,last_compact_at:null}};
 data.lanes=[{id:"md-active",status:"active",active:true,objective:"Long objective ".repeat(20),expiry:null,ask_on:[],spend:null,cap:null,note:null},{id:"md-paused",status:"paused",active:false,objective:"Paused work",expiry:null,ask_on:[],spend:null,cap:null,note:"Budget paused"}];
 const landed=Array.from({length:6},(_,i)=>({...job,id:`cp-landed-${i}`,phase:"done" as const,finished_today:true,finished_at:`2026-10-06T0${i}:00:00Z`,pr_url:i===5 ? "https://github.com/0xb1ob/picp/pull/1" : null,pr_status:i===5 ? "merged" : null,merge_sha:i===5 ? "a".repeat(40) : null,mandate_id:i===5 ? "md-paused" : "md-active"}));
 data.jobs=[job,{...job,id:"cp-paused",mandate_id:"md-history",board_lane_id:"md-paused",context:null,blockers:[job.id]},...landed];
 t.after(()=>{unmount(root);if(original) Object.defineProperty(globalThis,"document",original); else Reflect.deleteProperty(globalThis,"document");});
 await act(()=>mount(root,data));
 assert.equal(root.querySelector("h1")?.textContent,"Jobs");
 assert.equal(root.querySelectorAll('[aria-label="Board columns"]').length,1,"one renderer for both widths");
 assert.equal(root.querySelectorAll('.board-trigger[aria-haspopup="listbox"]').length,1,"one shared picker");
 assert.equal(root.querySelector('[role="listbox"]'),null,"closed until opened");
 assert.ok(root.querySelector('a[href="#job/cp-paused"]'),"All mandates retains flight jobs on inactive grants");
 const flight=root.querySelector('a[href="#job/cp-prehead"]')!;
 assert.match(flight.textContent ?? "",/working · 10m \/ 2h 0m · \$1\.50/);
 assert.match(flight.textContent ?? "",/blocks cp-paused/);
 const done=()=>root.querySelector('[aria-label="Landed today"]')!;
 assert.deepEqual([...done().querySelectorAll(".board-card-heading code")].map(e=>e.textContent),["cp-landed-5","cp-landed-4","cp-landed-3","cp-landed-2"]);
 assert.match(done().textContent ?? "",/Landed today6.*#1 · merged · \d\d:\d\d · \$1\.50.*Show 2 more in the list/);
 assert.equal(done().querySelector(".board-more")?.getAttribute("href"),"#jobs");
 assert.equal(done().querySelectorAll(".ctx-chip").length,0,"finished cards have no live context");
 assert.ok(root.querySelector('[aria-label="Waiting · 0"]'),"Waiting folds rather than vanishing");
 assert.doesNotMatch(root.textContent ?? "",/Empty now/);
 const trigger=root.querySelector(".board-trigger")!;
 const click=(el:Element)=>act(()=>el.dispatchEvent(new window.Event("click",{bubbles:true})));
 await click(trigger);
 assert.equal(trigger.getAttribute("aria-expanded"),"true");
 const list=root.querySelector('[role="listbox"]')!;
 assert.match(list.textContent ?? "",/All mandates8 jobs.*Active · 1.*Other.*md-paused.*Paused work · paused/);
 assert.equal(list.querySelector('[aria-selected="true"] .board-check')?.textContent,"✓","the selected row, All mandates here, carries the check");
 assert.equal(root.querySelector("#board-opt-md-paused .board-option-count")?.textContent,"1 working");
 assert.match(root.querySelector(".board-status")?.textContent ?? "",/stranded dependencies/);
 assert.ok(root.querySelector('input[aria-label="Filter mandates"]'));
 assert.equal(root.querySelector('[role="switch"]'),null,"no revoked mandates, no switch");
 data.hidden_mandates=[{id:"md-gone",status:"revoked",objective:"Gone"}];
 await act(()=>mount(root,data));
 assert.equal(root.querySelector('[role="switch"]')?.textContent,"Include 1 revoked mandates");
 assert.equal(root.querySelector('[role="switch"]')?.getAttribute("aria-checked"),"false");
 assert.doesNotMatch(root.querySelector('[role="listbox"]')!.textContent ?? "",/md-gone/);
 await click(root.querySelector('[role="switch"]')!);
 assert.match(root.querySelector('[role="listbox"]')!.textContent ?? "",/md-gone/);
 const filter=root.querySelector('input[aria-label="Filter mandates"]') as HTMLInputElement;
 filter.value="paused";
 await act(()=>filter.dispatchEvent(new window.Event("input",{bubbles:true})));
 const options=[...root.querySelectorAll('[role="option"]')];
 assert.deepEqual(options.map(o=>o.id),["board-opt-md-paused"]);
 await click(options[0]!);
 assert.equal(root.querySelector('[role="listbox"]'),null,"picking closes the picker");
 assert.match(root.querySelector(".board-trigger")!.textContent ?? "",/md-paused/);
 assert.equal(root.querySelector('a[href="#job/cp-prehead"]'),null);
 assert.ok(root.querySelector('a[href="#job/cp-paused"]'));
 assert.equal(done().querySelectorAll(".board-card").length,1);
 assert.equal(done().querySelector(".board-more"),null,"no overflow link for a small filtered set");
 assert.match(root.textContent ?? "",/Budget paused/);
 assert.match(done().textContent ?? "",/#1 · merged/);
 await click(root.querySelector(".board-trigger")!);
 await click(root.querySelector("#board-opt-all")!);
 assert.equal(done().querySelectorAll(".board-card").length,4,"All mandates restores the preview");
});


test("Jobs detail link keeps the 44px base target for phone; desktop link spans only the job and title columns in the compact approved rows", () => {
 const css=readFileSync(join(REPO_ROOT,"viewer-app/screens/jobs.css"),"utf8");
 assert.match(css,/\.job-row-link \{[^}]*min-height: 44px/,"phone base target");
 assert.match(css,/\.jobs-screen \.job-row-done \.job-cost \{ position: absolute;/,"absolute cost rides the title row on done rows only");
 assert.doesNotMatch(css,/\.jobs-screen \.job-cost \{ position: absolute/);
 const desktop=css.split("@media (min-width: 900px) {")[1]!.split("/* Narrow desktop")[0]!;
 assert.match(desktop,/\.job-row-link \{[^}]*grid-area: 1 \/ 1 \/ 2 \/ 3;[^}]*display: grid;[^}]*min-height: 0;/);
 assert.match(desktop,/\.jobs-columns-flight, \.job-row-flight \{ grid-template-columns: 220px minmax\(0,1fr\) 104px 140px 120px 92px 88px 56px;/);
 assert.doesNotMatch(desktop,/\.job-row-link\s*(?:,|\{)[^}]*display: contents/);
});
