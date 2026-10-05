import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobsView, boardView } from "../src/viewer/jobs-view.ts";
import type { JobResponse, ViewerJob } from "../src/viewer/api-types.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("Jobs, detail and Board render empty, failed and awaiting states; board filters exclude inactive lanes",async t=>{
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const buildResult=await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; import {JobDetail} from "./viewer-app/screens/JobDetail.tsx"; import {Board,visibleBoard} from "./viewer-app/screens/Board.tsx"; export {visibleBoard}; export const screen=(name,data)=>render(h({Jobs,JobDetail,Board}[name],{data}));',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {screen,visibleBoard}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles![0]!.contents).toString("base64")}`);
 const list=jobsView(state); const board=boardView(state);
 assert.match(screen("Jobs",list),/Nothing in flight/); assert.match(screen("Board",board),/Nothing here/);
 const job:ViewerJob={id:"cp-render",project:"demo",title:"<script>unsafe()</script>",phase:"failed",model:"recorded-model",script_path:null,elapsed_seconds:7200,limit_seconds:7200,head:"a".repeat(40),ci:"red",review:"revise",review_attempts:5,routing:"explicit",note:null,ledger_status:"in_progress",ledger_disagrees:true,mandate_id:"md-active",cost_usd:3,pr_url:null,pr_status:null,finished_at:list.generated_at,finished_today:true,merge_sha:null,failure:"wall clock limit",summary:null,blockers:[]};
 list.jobs=[job]; list.projects=[{name:"demo",paused:false}];
 assert.match(screen("Jobs",list),/ledger in_progress/); assert.match(screen("Jobs",list),/wall clock limit/);
 const detail:JobResponse={generated_at:list.generated_at,awaiting_count:1,job,timeline:[],timeline_truncated:false,files_href:null,artifact_href:null,artifact_name:null,run_href:"/api/job/cp-render/events",asks:[{id:"ask-a",project:"demo",question:"Continue?",created_at:list.generated_at,options:[{label:"Keep",consequence:"Paused",reply:"ask-a: Keep"}],recommendation:"Keep",source_escalation:null,job_ids:[job.id],context:null,evidence_paths:[]}],questions:[],warnings:[]};
 const html=screen("JobDetail",detail); assert.match(html,/Awaiting you/);assert.match(html,/ask-a: Keep/);assert.match(html,/No recorded events/);assert.match(html,/CI red/);assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/<script>|style=|onclick=/i);
 board.jobs=[job,{...job,id:"cp-inactive",mandate_id:"md-paused"}];
 board.lanes=[{id:"md-active",status:"active",active:true,objective:"Active",expiry:null,ask_on:[],spend:null,cap:null,note:null},{id:"md-paused",status:"paused",active:false,objective:"Paused",expiry:null,ask_on:[],spend:null,cap:null,note:null}];
 assert.deepEqual(visibleBoard(board,false,"all").jobs.map((j:ViewerJob)=>j.id),["cp-render"]);
 assert.deepEqual(visibleBoard(board,true,"md-paused").jobs.map((j:ViewerJob)=>j.id),["cp-inactive"]);
 const rendered=screen("Board",board);assert.match(rendered,/By mandate/);assert.match(rendered,/Paused &amp; closed/);assert.match(rendered,/href="#job\/cp-render"/);assert.doesNotMatch(rendered,/<script>|style=|onclick=/i);
 // The Mandates page is gone; its name must not survive as the phone heading either (cp-hvbj).
 assert.match(rendered,/board-desktop">Board<\/span><span class="board-phone">Board</);assert.doesNotMatch(rendered,/>Mandates</);
 // Audit P2 #12: the desktop Landed today count covers every lane, a hidden paused one included; Jobs says "Finished today".
 board.jobs=[...board.jobs,{...job,id:"cp-landed",phase:"done",mandate_id:"md-paused"}];
 const grid=screen("Board",board).split('board-desktop board-grid-head')[1]!.split('board-desktop board-lanes')[0]!;
 assert.match(grid,/Landed today<span>1<\/span>/); assert.match(grid,/Failed<span>1<\/span>/,"other columns still count the shown lanes");
 // A waiting or idle job is not a Working job: it counts under Waiting only.
 board.jobs=[{...job,id:"cp-wait",phase:"waiting"},{...job,id:"cp-idle",phase:"idle"},{...job,id:"cp-run",phase:"working"}];
 const waitGrid=screen("Board",board).split('board-desktop board-grid-head')[1]!.split('board-desktop board-lanes')[0]!;
 assert.match(waitGrid,/Working<span>1<\/span>/); assert.match(waitGrid,/Waiting<span>2<\/span>/); assert.match(waitGrid,/needs a person, or the worker is idle/);
 assert.match(screen("Jobs",list),/Finished today<span>1<\/span>/);
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
 assert.match(jobs,/class="jobs-columns" aria-hidden="true"><span>job<\/span><span>title<\/span><span>phase<\/span><span>model<\/span><span>ctx<\/span><span>CI<\/span><span>cost<\/span><span>time<\/span>/);
 assert.match(jobs,/<span class="job-cols"><code title="wide-model">wide-model<\/code><span class="job-ctx">-<\/span><span class="job-ci job-ci-green">.*?<\/span><span>\$1\.50<\/span><span>ran 10m<\/span><\/span>/);
 // Audit P1 #4/#5: no routing line in list rows, the model without its provider prefix, no CI/review dashes before a PR or head.
 const bare:ViewerJob={...job,id:"cp-bare",model:"anthropic/claude-opus-5-5",head:null,ci:null,routing:"scope:M (inferred) · risk:high (explicit)",mandate_id:"md-8c47f5"};
 const rows=screen("Jobs",{generated_at:"2026-09-27T00:00:00Z",awaiting_count:0,jobs:[bare],projects:[],warnings:[]});
 assert.doesNotMatch(rows,/job-route|scope:M|md-8c47f5|Routing not recorded/); assert.doesNotMatch(rows,/CI -|review -|>anthropic\//);
 assert.match(rows,/<code title="anthropic\/claude-opus-5-5">claude-opus-5-5<\/code>/); assert.match(rows,/<span class="job-ci"><\/span><span>\$1\.50/,"an empty CI cell keeps the desktop columns aligned");
 assert.match(jobs,/review not started/,"a row with a head and no review yet says so");
 const detail=screen("JobDetail",{generated_at:"2026-09-27T00:00:00Z",awaiting_count:0,job,timeline:[],timeline_truncated:false,files_href:null,artifact_href:null,artifact_name:null,run_href:null,asks:[],questions:[],warnings:[]});
 assert.match(detail,/<div class="job-detail"><div class="job-detail-main"><header/);
 assert.match(detail,/<\/div><div class="job-detail-side"><dl class="job-facts">.*<dt>CI<\/dt>.*<dt>Review<\/dt>.*<\/dl><div class="job-links">.*<\/div><\/div><section class="job-timeline">/);
 const desktop=(file:string)=>readFileSync(join(REPO_ROOT,"viewer-app/screens",file),"utf8").split("@media (min-width: 900px) {")[1] ?? "";
 assert.match(readFileSync(join(REPO_ROOT,"viewer-app/screens/jobs.css"),"utf8"),/^\.jobs-screen, \.job-detail \{ max-width: 358px;/, "the phone layout keeps its 358px column");
 assert.match(desktop("jobs.css"),/\.jobs-screen, \.job-detail \{ max-width: none;/);
 assert.match(desktop("jobs.css"),/\.reports-grid \{ display: grid;/);
 assert.match(desktop("job-detail.css"),/\.job-detail \{ display: grid;/);
});
