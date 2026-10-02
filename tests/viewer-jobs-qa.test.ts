import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { jobsView, jobView, boardView } from "../src/viewer/jobs-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const at="2026-09-26T18:00:00Z", now=Date.parse("2026-09-26T20:00:00Z");
function fixture(t:{after(fn:()=>void):void}) {
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));};
 const grant=(id:string,status:string,extra={})=>put(`${LAYOUT.mandates}/${id}.json`,{id,status,issued_at:"2026-09-26T17:00:00Z",expiry:"2026-09-27T00:00:00Z",projects:["demo"],objective:`${id} objective`,spend_cap:{usd:10,tokens:1000},...extra});
 const entries=[{job_id:"cp-recorded",mandate_id:"md-original",project:"demo",phase:"held",dispatched_at:at},{job_id:"cp-run",project:"demo",phase:"held",dispatched_at:at},{job_id:"cp-legacy",project:"demo",phase:"held",dispatched_at:at},{job_id:"cp-uncovered",project:"other",phase:"held",dispatched_at:at},{job_id:"cp-paused",mandate_id:"md-paused",project:"demo",phase:"held",dispatched_at:at}];
 put(LAYOUT.fleetFile,{jobs:entries});
 put(join(LAYOUT.runs, "cp-run/events.jsonl"),JSON.stringify({source:"cp",type:"spawned",ts:at,job_id:"cp-run",payload:{mandate_id:"md-original"}})+"\n");
 grant("md-original","active",{job_ids:["cp-recorded","cp-run","cp-legacy"]});
 grant("md-paused","paused",{job_ids:["cp-paused"]});
 grant("md-new","active",{issued_at:"2026-09-26T19:00:00Z",job_ids:["cp-recorded","cp-run","cp-legacy"]});
 grant("md-revoked","revoked",{issued_at:"2026-09-26T19:30:00Z"});
 grant("md-expired","expired",{projects:["other"],expiry:"2026-09-26T19:00:00Z"});
 grant("md-empty","active",{job_ids:["cp-nobody"]});
 put(LAYOUT.escalationsFile,{items:[{id:"es-open",status:"open",kind:"final_fix",question:"Final-fix approval open",created_at:at,job_ids:["cp-recorded"]}]});
 return {state,put,grant};
}
test("dispatch provenance beats later grants and uncovered jobs remain on the board",t=>{
 const {state}=fixture(t);const list=jobsView(state,now);
 for(const id of ["cp-recorded","cp-run","cp-legacy"]) assert.equal(list.jobs.find(j=>j.id===id)?.mandate_id,"md-original",id);
 assert.equal(jobView(state,"cp-recorded",now)?.job.mandate_id,"md-original");
 assert.equal(list.jobs.find(j=>j.id==="cp-uncovered")?.mandate_id,null);
 const board=boardView(state,now);assert.equal(board.jobs.length,5);
 assert.deepEqual(board.lanes.map(l=>l.id),["md-original","unassigned","md-paused"]);
});

test("legacy job-scoped grants retain dispatch history after expiry or revocation",t=>{
 const {state,put,grant}=fixture(t);
 put(LAYOUT.fleetFile,{jobs:[
  {job_id:"cp-iu4n",project:"demo",phase:"held",dispatched_at:"2026-09-26T17:56:39Z"},
  {job_id:"cp-expired",project:"demo",phase:"held",dispatched_at:at},
  {job_id:"cp-before",project:"demo",phase:"held",dispatched_at:at},
  {job_id:"cp-queued",project:"demo",phase:"queued"},
 ]});
 grant("md-33e95b","revoked",{issued_at:"2026-09-26T17:56:20Z",job_ids:["cp-iu4n"],revoked_at:"2026-09-26T19:53:16Z"});
 grant("md-ba09b7","revoked",{issued_at:"2026-09-26T17:58:45Z",job_ids:["cp-iu4n"],revoked_at:"2026-09-26T17:59:05Z"});
 grant("md-history","expired",{job_ids:["cp-expired","cp-queued"],expiry:"2026-09-26T19:00:00Z"});
 grant("md-before","revoked",{job_ids:["cp-before"],revoked_at:"2026-09-26T17:30:00Z"});
 const list=jobsView(state,now);
 assert.equal(list.jobs.find(j=>j.id==="cp-iu4n")?.mandate_id,"md-33e95b");
 assert.equal(jobView(state,"cp-iu4n",now)?.job.mandate_id,"md-33e95b");
 assert.equal(list.jobs.find(j=>j.id==="cp-expired")?.mandate_id,"md-history");
 for(const id of ["cp-before","cp-queued"]) assert.equal(list.jobs.find(j=>j.id===id)?.mandate_id,null);
 const board=boardView(state,now);assert.equal(board.jobs.length,4);
 assert.equal(board.jobs.find(j=>j.id==="cp-iu4n")?.mandate_id,"md-33e95b");
 assert.ok(board.jobs.every(j=>j.board_lane_id==="unassigned"));
 assert.deepEqual(board.lanes.map(l=>l.id),["unassigned"]);
});

test("missing and historical recorded grants stay attached without hiding jobs",t=>{
 const {state,put,grant}=fixture(t);
 grant("md-broad","active");
 grant("md-old","revoked",{revoked_at:"2026-09-25T19:00:00Z"});
 grant("md-closed","revoked",{revoked_at:"2026-09-26T19:00:00Z"});
 put(LAYOUT.fleetFile,{jobs:[
  {job_id:"cp-missing",project:"demo",phase:"held",mandate_id:"md-missing",dispatched_at:at},
  {job_id:"cp-status",project:"demo",phase:"held",dispatched_at:at},
  {job_id:"cp-old",project:"demo",phase:"held",mandate_id:"md-old",dispatched_at:at},
  {job_id:"cp-closed",project:"demo",phase:"done",mandate_id:"md-closed",dispatched_at:at,closed_at:"2026-09-26T19:00:00Z"},
  {job_id:"cp-revoked",project:"demo",phase:"held",mandate_id:"md-closed",dispatched_at:at},
 ]});
 put(join(LAYOUT.runs, "cp-status/status.json"),{mandate_id:"md-original"});
 const list=jobsView(state,now);
 assert.equal(list.jobs.find(j=>j.id==="cp-missing")?.mandate_id,"md-missing");
 assert.equal(list.jobs.find(j=>j.id==="cp-status")?.mandate_id,"md-original");
 assert.equal(jobView(state,"cp-old",now)?.job.mandate_id,"md-old");
 const board=boardView(state,now);
 assert.equal(board.jobs.length,5);
 for(const id of ["cp-old","cp-missing","cp-revoked"]) assert.equal(board.jobs.find(j=>j.id===id)?.board_lane_id,"unassigned");
 assert.equal(board.jobs.find(j=>j.id==="cp-closed")?.board_lane_id,"md-closed");
 assert.deepEqual(board.lanes.map(l=>l.id),["md-original","unassigned","md-closed"]);
});

test("a grant closed by its mission end (answered close, revoked today) is a closed lane, not a revoked one",t=>{
 const {state,put,grant}=fixture(t);
 grant("md-auto","revoked",{job_ids:["cp-auto"],revoked_at:"2026-09-26T19:00:00Z"});
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-auto",project:"demo",phase:"held",mandate_id:"md-auto",dispatched_at:at}]});
 put(LAYOUT.escalationsFile,{items:[{id:"es-auto",mandate_id:"md-auto",kind:"mission_end",status:"answered",answer:"close",answered_by:"mandate:md-auto",answered_at:"2026-09-26T19:00:00Z",options:[{id:"close",label:"close the mandate"}]}]});
 const board=boardView(state,now);
 assert.deepEqual(board.lanes.map(l=>[l.id,l.status]),[["md-auto","closed"]]);
 assert.equal(board.jobs.find(j=>j.id==="cp-auto")?.board_lane_id,"md-auto");
});

test("QA rendering: recorded grant, nonempty active lanes by default, escalation note and CI glyphs",async t=>{
 const {state,put}=fixture(t);
 const head="a".repeat(40);
 for(const id of ["cp-recorded","cp-run","cp-legacy"]) put(`${LAYOUT.runs}/${id}/envelope.json`,{envelope:{head_sha:head}});
 put(LAYOUT.ciWatchFile,{jobs:[{job_id:"cp-recorded",head_sha:head,last_ci:"failed"},{job_id:"cp-run",head_sha:head,last_ci:"green"},{job_id:"cp-legacy",head_sha:head,last_ci:"in_progress"}]});
 const list=jobsView(state,now);list.jobs[0]!.pr_url="https://github.com/acme/repo/pull/99";
 const built=await build({stdin:{contents:'import {h} from "preact";import render from "preact-render-to-string";import {Jobs} from "./viewer-app/screens/Jobs.tsx";import {Board,visibleBoard} from "./viewer-app/screens/Board.tsx";import {JobDetail} from "./viewer-app/screens/JobDetail.tsx";export {visibleBoard};export const screen=(name,data)=>render(h({Jobs,Board,JobDetail}[name],{data}));',loader:"tsx",resolveDir:REPO_ROOT},bundle:true,write:false,platform:"node",format:"esm",jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
 const {screen,visibleBoard}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
 // Audit P1 #4 (cp-6fis): the routing/mandate line left the list rows; Job detail below still shows the recorded grant.
 const html=screen("Jobs",list);assert.doesNotMatch(html,/md-original|md-revoked|github.com/);assert.match(html,/Final-fix approval open/);
 const {document}=parseHTML(html);
 assert.equal(document.querySelector(".job-note")?.getAttribute("title"),list.jobs.find(j=>j.id==="cp-recorded")!.note);
 for(const color of ["red","green","running"]) {const glyph=document.querySelector(`.job-ci-${color} > .job-ci-dot`);assert.ok(glyph,color);assert.match(glyph.parentElement!.textContent!,new RegExp(`CI ${color}`));}
 assert.equal(document.querySelectorAll(".job-note").length,1);
 assert.equal(document.querySelectorAll(".job-pr").length,0);
 const detailData=jobView(state,"cp-recorded",now)!;detailData.job.pr_url="https://github.com/acme/repo/pull/99";
 const detail=screen("JobDetail",detailData);assert.match(detail,/job-ci-red/);assert.match(detail,/md-original/);assert.match(detail,/https:\/\/github.com\/acme\/repo\/pull\/99/);
 const board=boardView(state,now);board.lanes[0]!.objective="Land the remaining dashboard vertical slices with exact typography, readable provenance, durable test evidence, and one reviewed pull request per bead.";
 const rendered=screen("Board",board);const dom=parseHTML(rendered).document;
 assert.equal(dom.querySelector(".board-note")?.getAttribute("title"),board.jobs.find(j=>j.id==="cp-recorded")!.note);
 assert.equal(dom.querySelector(".board-lane > header > p")?.getAttribute("title"),board.lanes[0]!.objective);
 assert.equal(dom.querySelector('input[type="checkbox"]')?.hasAttribute("checked"),false);
 assert.equal(dom.querySelectorAll(".board-lane").length,2);assert.doesNotMatch(dom.querySelector(".board-lanes")!.textContent!,/md-empty|md-expired|md-paused/);
 assert.deepEqual(visibleBoard(board,true,"all").lanes.map((l:{id:string})=>l.id),["md-original","unassigned","md-paused"]);
 assert.match(rendered,/job-ci-red/);
});
