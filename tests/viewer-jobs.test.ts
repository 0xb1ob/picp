import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createViewer } from "../src/viewer/server.ts";
import { jobsView, jobView, boardView, jobEvents } from "../src/viewer/jobs-view.ts";
import type { JobsResponse, JobResponse, BoardResponse } from "../src/viewer/api-types.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

process.env.TZ = "UTC";
test("jobs, detail and board join the ledger with observed phases without writing state", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const put = (file:string,value:unknown) => { const path=join(home.path,file); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,typeof value === "string" ? value : JSON.stringify(value)); };
 const at = new Date().toISOString(); const head = "a".repeat(40);
 const entries = ["queued","working","launching","held","done","failed","old"].map(id => ({id:`cp-${id}`,title:`Title ${id}`,status:id === "done" || id === "old" ? "closed" : "open",labels:["project:demo","kind:ship"],blocked_by:id === "queued" ? ["cp-working"] : [],closed_at:id === "old" ? "2020-01-01T00:00:00Z" : at}));
 put(".pi-command-post/jobs.json",{jobs:entries});
 put(LAYOUT.fleetFile,{jobs:entries.filter(j => j.id !== "cp-queued").map(j => ({job_id:j.id,project:"demo",kind:"ship",phase:j.id === "cp-working" || j.id === "cp-launching" ? "waiting" : j.id === "cp-old" ? "done" : j.id.slice(3),dispatched_at:at,closed_at:j.id === "cp-old" ? "2020-01-01T00:00:00Z" : at}))});
 put(join(LAYOUT.runs, "cp-working/status.json"),{phase:"working",started_at:at});
 put(join(LAYOUT.runs, "cp-launching/status.json"),{phase:"starting",started_at:at});
 put(join(LAYOUT.projects, "demo/report ?&.md"),"Recorded artifact");
 put(join(LAYOUT.runs, "cp-held/envelope.json"),{envelope:{head_sha:head,summary:`\n  ${"x".repeat(100)}\nsecond line`,artifact_path:join(home.path, LAYOUT.projects, "demo/report ?&.md")}});
 put(LAYOUT.ciWatchFile,{jobs:[{job_id:"cp-held",head_sha:head,last_ci:"red"}]});
 put(join(LAYOUT.runs, "cp-held/review-1.json"),{head_sha:"b".repeat(40),verdict:"pass",diff_stat:{truncated:false}});
 put(join(LAYOUT.runs, "cp-held/events.jsonl"),JSON.stringify({source:"cp",job_id:"cp-held",ts:at,type:"spawned",payload:{model:"test-model",secret:"not-for-the-api"}})+"\n"+JSON.stringify({source:"pi",ts:at,type:"message_update",payload:{text:"private prompt"}})+"\n");
 put(join(LAYOUT.mandates, "md-active.json"),{id:"md-active",status:"active",issued_at:at,expiry:"2099-01-01T00:00:00Z",projects:["demo"],objective:"Active goal",job_ids:["cp-working","cp-held","cp-queued","cp-launching"],spend_cap:{usd:20,tokens:10000}});
 put(join(LAYOUT.mandates, "md-paused.json"),{id:"md-paused",status:"paused",issued_at:at,expiry:"2099-01-01T00:00:00Z",projects:["demo"],objective:"Paused goal",job_ids:["cp-failed","cp-done"],spend_cap:{usd:20,tokens:10000}});
 const snapshot = (dir:string):unknown => readdirSync(dir,{withFileTypes:true}).map(e => [e.name,e.isDirectory()?snapshot(join(dir,e.name)):readFileSync(join(dir,e.name)).toString("base64")]);
 const before=snapshot(home.path);
 const options={home:home.path,stateDir:join(home.path, LAYOUT.state),host:"127.0.0.1",port:0};
 const server=createViewer(options); await new Promise<void>(r=>server.listen(0,options.host,r)); options.port=(server.address() as AddressInfo).port; t.after(()=>server.close());
 const get=(path:string)=>fetch(`http://127.0.0.1:${options.port}${path}`);
 const response=await get("/api/jobs"); assert.equal(response.status,200);
 const data=await response.json() as JobsResponse;
 assert.deepEqual(data.jobs.map(j=>[j.id,j.phase]).sort(),[["cp-done","done"],["cp-failed","failed"],["cp-held","held"],["cp-launching","launching"],["cp-old","done"],["cp-queued","queued"],["cp-working","working"]]);
 assert.equal(data.jobs.find(j=>j.id==="cp-old")?.finished_today,false);
 assert.equal(data.jobs.find(j=>j.id==="cp-held")?.summary,`${"x".repeat(79)}…`,"first non-empty line, 80 chars");
 assert.equal(data.jobs.find(j=>j.id==="cp-working")?.summary,null);
 assert.equal(data.jobs.find(j=>j.id==="cp-held")?.review,null);
 const detail=await (await get("/api/job/cp-held")).json() as JobResponse;
 assert.equal(detail.job.ci,"red"); assert.equal(detail.timeline[0]?.label,"Spawned");
 assert.doesNotMatch(JSON.stringify(detail),/not-for-the-api|private prompt/);
 assert.equal(detail.files_href,"/#files?root=project%3Ademo&path=");
 assert.equal(detail.artifact_href,"/#files?root=project%3Ademo&path=report+%3F%26.md");
 const log=await get("/api/job/cp-held/events"); assert.equal(log.status,200); assert.match(log.headers.get("content-type") ?? "",/text\/plain/); assert.match(await log.text(),/spawned/);
 assert.equal((await get("/api/job/cp-queued/events")).status,404);
 assert.equal((await get("/api/job/cp-queued")).status,200);
 for(const id of ["cp-missing","%2e%2e%2fsecret","%E0"]) assert.equal((await get(`/api/job/${id}`)).status,404);
 const board=await (await get("/api/board")).json() as BoardResponse;
 assert.deepEqual(board.columns.map(c=>c.key),["queued","launching","working","waiting","held","done","failed"]);
 assert.equal(board.lanes.find(l=>l.id==="md-paused")?.active,false);
 assert.equal(board.jobs.some(j=>j.id==="cp-old"),false);
 assert.equal((await get("/api/stream?view=jobs").then(r=>{r.body?.cancel();return r.status;})),200);
 assert.deepEqual(snapshot(home.path),before);
});

test("detail projects real CI/review events, joins escalation-backed asks, and reports corrupt sources",t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));};
 const at="2026-09-26T12:00:00Z";const now=Date.parse(at);
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-a",project:"demo",phase:"failed",failure:{class:"wall_clock",message:"Wall clock limit",at}}]});
 put(join(LAYOUT.runs, "cp-a/status.json"),{started_at:"2026-09-26T10:00:00Z"});
 put(join(LAYOUT.runs, "cp-a/events.jsonl"),[
  {source:"cp",ts:at,type:"ci_observed",payload:{event:"ci_failed",reason:"Test failure"}},
  {source:"cp",ts:at,type:"review_decided",payload:{attempt:5,verdict:"revise"}},
 ].map(event=>JSON.stringify(event)).join("\n")+"\n{\"partial\":");
 put(LAYOUT.escalationsFile,{items:[{id:"es-a",status:"open",question:"Continue?",created_at:at,job_ids:["cp-a"]}]});
 put(join(LAYOUT.state, "operator/asks.jsonl"),JSON.stringify({type:"open",id:"ask-ab",project:"demo",created_at:at,question:"Continue?",options:[{label:"Keep",consequence:"Paused"}],recommendation:"Keep",source_escalation:"es-a"})+"\n");
 const data=jobView(state,"cp-a",now)!;
 assert.equal(data.job.finished_today,true);assert.equal(data.job.failure,"Wall clock limit");
 assert.equal(jobView(state,"cp-a",now+600000)?.job.elapsed_seconds,7200);
 assert.deepEqual(data.timeline.map(e=>[e.label,e.tone]),[["CI red","red"],["Review 5 · changes requested","neutral"]]);
 assert.equal(data.asks[0]?.id,"ask-ab");assert.deepEqual(data.questions,[]);
 assert.equal(jobEvents(state,"../bad"),undefined);
 put(".pi-command-post/jobs.json","{bad");put(join(LAYOUT.mandates, "md-bad.json"),"{bad");
 assert.ok(jobsView(state,now).warnings.some(w=>w.section==="ledger"));assert.equal(boardView(state,now).stranded_count,null);
});

test("audit P2 #10/#11: a held job's stale failure is not shown, and a lane whose named jobs all closed is closed",t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 const at="2026-09-26T12:00:00Z";const now=Date.parse(at)+60_000;
 put(".pi-command-post/jobs.json",{jobs:[
  {id:"cp-held",title:"Held",status:"in_progress",labels:["project:demo","kind:ship"]},
  {id:"cp-shut",title:"Shut",status:"closed",closed_at:at,labels:["project:demo","kind:ship"]},
  {id:"cp-live",title:"Live",status:"in_progress",labels:["project:demo","kind:ship"]}]});
 const failure={class:"model_call_failed",message:"503 upstream",at};
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-held",project:"demo",kind:"ship",phase:"held",dispatched_at:at,failure},{job_id:"cp-shut",project:"demo",kind:"ship",phase:"done",dispatched_at:at,closed_at:at,failure},{job_id:"cp-live",project:"demo",kind:"ship",phase:"held",dispatched_at:at}]});
 put(join(LAYOUT.runs,"cp-held/status.json"),{phase:"idle",started_at:at,failure});
 for(const [id,jobs] of [["md-done",["cp-shut"]],["md-open",["cp-live","cp-held"]]] as const) put(join(LAYOUT.mandates,`${id}.json`),{id,status:"active",issued_at:at,expiry:"2099-01-01T00:00:00Z",projects:["demo"],objective:id,job_ids:jobs,spend_cap:{usd:20,tokens:10000}});
 const jobs=jobsView(state,now).jobs;
 assert.equal(jobs.find(j=>j.id==="cp-held")?.failure,null,"a held job's old failure is history");
 assert.equal(jobs.find(j=>j.id==="cp-shut")?.failure,null,"a landed job's old failure is history");
 assert.equal(jobView(state,"cp-held",now)?.job.failure,null);
 const board=boardView(state,now);
 assert.deepEqual(board.lanes.map(l=>[l.id,l.status,l.active]),[["md-open","active",true],["md-done","closed",false]],"the Map's completion rule: closed, sorted below active");
 assert.equal(board.jobs.find(j=>j.id==="cp-shut")?.board_lane_id,"md-done","a closed lane keeps its landed job");
 put(LAYOUT.fleetFile,{jobs:[{job_id:"cp-held",project:"demo",kind:"ship",phase:"failed",dispatched_at:at,failure}]});
 assert.equal(jobsView(state,now).jobs.find(j=>j.id==="cp-held")?.failure,"503 upstream","a failed job still shows its failure");
});

test("a merged job's CI fact follows its recorded CI event once ci-watch has pruned the row, and stays unset with no run",t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));};
 const at="2026-09-26T12:00:00Z";const head="c".repeat(40);
 put(".pi-command-post/jobs.json",{jobs:["cp-green","cp-none","cp-stale"].map(id=>({id,title:id,status:"closed",closed_at:at,labels:["project:demo","kind:ship"]}))});
 put(LAYOUT.fleetFile,{jobs:["cp-green","cp-none","cp-stale"].map(id=>({job_id:id,project:"demo",kind:"ship",phase:"done",dispatched_at:at,closed_at:at}))});
 for(const id of ["cp-green","cp-none","cp-stale"]) put(join(LAYOUT.runs,`${id}/envelope.json`),{envelope:{head_sha:head}});
 const ev=(id:string,event:string,sha:string)=>JSON.stringify({source:"cp",job_id:id,ts:at,type:"ci_observed",payload:{event,head_sha:sha}})+"\n";
 put(join(LAYOUT.runs,"cp-green/events.jsonl"),ev("cp-green","ci_green",head)+ev("cp-green","pr_merged",head));
 put(join(LAYOUT.runs,"cp-none/events.jsonl"),ev("cp-none","pr_merged",head));
 put(join(LAYOUT.runs,"cp-stale/events.jsonl"),ev("cp-stale","ci_green","d".repeat(40)));
 assert.equal(jobView(state,"cp-green")?.job.ci,"green");
 assert.equal(jobView(state,"cp-none")?.job.ci,null,"no CI run recorded: still not run yet");
 assert.equal(jobView(state,"cp-stale")?.job.ci,null,"a green run on another head is not this head's CI");
});

test("a merged job's Review fact reads its recorded review files; no review stays not started",t=>{
 const home=createScratchHome();t.after(()=>home.cleanup());const state={home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 const at="2026-09-26T12:00:00Z";const head="c".repeat(40);const ids=["cp-pass","cp-equiv","cp-bare"];
 put(".pi-command-post/jobs.json",{jobs:ids.map(id=>({id,title:id,status:"closed",closed_at:at,labels:["project:demo","kind:ship"]}))});
 put(LAYOUT.fleetFile,{jobs:ids.map(id=>({job_id:id,project:"demo",kind:"ship",phase:"done",dispatched_at:at,closed_at:at}))});
 for(const id of ids) put(join(LAYOUT.runs,`${id}/envelope.json`),{envelope:{head_sha:head}});
 put(join(LAYOUT.runs,"cp-pass/review-1.json"),{head_sha:head,verdict:"pass",decided_at:at,diff_stat:{truncated:false}});
 put(join(LAYOUT.runs,"cp-equiv/review-equivalent-"+head+".json"),{head_sha:head,verdict:"pass",decided_at:at,diff_stat:{truncated:false}});
 const job=(id:string)=>jobView(state,id)!.job;
 assert.deepEqual([job("cp-pass").review,job("cp-pass").review_attempts],["pass",1]);
 assert.deepEqual([job("cp-equiv").review,job("cp-equiv").review_attempts],["pass",0]);
 assert.deepEqual([job("cp-bare").review,job("cp-bare").review_attempts],[null,0]);
});

test("provider failures are neutral; only a recorded ci_failed observation is red", t => {
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const state={home:home.path,stateDir:join(home.path,LAYOUT.state)}, at="2026-09-26T12:00:00Z";
 mkdirSync(join(state.stateDir,"runs/cp-tone"),{recursive:true});
 writeFileSync(join(home.path,".pi-command-post/jobs.json"),JSON.stringify({jobs:[{id:"cp-tone",title:"Tone",status:"in_progress",labels:["project:demo"]}]}));
 const events = [
  {type:"failure",payload:{reason:"Provider/model 503"}},
  {type:"ci_observed",payload:{event:"ci_failed",reason:"Test failure"}},
  {type:"ci_observed",payload:{event:"ci_green"}},
 ].map(event=>JSON.stringify({source:"cp",job_id:"cp-tone",ts:at,...event})).join("\n")+"\n";
 writeFileSync(join(state.stateDir,"runs/cp-tone/events.jsonl"),events);
 assert.deepEqual(jobView(state,"cp-tone",Date.parse(at))?.timeline.map(e=>[e.label,e.tone]),[["Failed","neutral"],["CI red","red"],["CI green","green"]]);
});


test("structured routing and legacy text share the latest recorded selection, with a fleet fallback", t => {
 const home=createScratchHome(); t.after(()=>home.cleanup());
 const state={home:home.path,stateDir:join(home.path,LAYOUT.state)}, at="2026-09-26T12:00:00Z";
 const put=(file:string,value:unknown)=>{const path=join(home.path,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));};
 const fallback={scope:"S",risk:"low",provenance:{scope:"explicit",risk:"defaulted"},rule:"fleet rule",reasons:["fleet reason"]};
 const ids=["cp-events","cp-fleet","cp-partial","cp-empty"];
 put(".pi-command-post/jobs.json",{jobs:ids.map(id=>({id,title:id,status:"closed",labels:["project:demo"]}))});
 put(LAYOUT.fleetFile,{jobs:ids.map(job_id=>({job_id,project:"demo",phase:"done",routing:job_id==="cp-empty"?{}:job_id==="cp-partial"?{risk:"high",provenance:{risk:"inferred"}}:fallback}))});
 const event=(ts:string,payload:unknown)=>JSON.stringify({source:"cp",job_id:"cp-events",ts,type:"routing_resolved",payload});
 const selected={scope:"L",risk:"low",provenance:{scope:"inferred",risk:"explicit",secret:"private"},rule:"latest rule",reasons:["latest reason",123],secret:"not-for-the-api"};
 put(join(LAYOUT.runs,"cp-events/events.jsonl"),event(at,selected)+"\n"+event("2026-09-26T11:00:00Z",fallback)+"\n");
 const rows=jobsView(state,Date.parse(at)).jobs;
 assert.deepEqual(rows.find(j=>j.id==="cp-events")?.routing_facts,{scope:"L",risk:"low",provenance:{scope:"inferred",risk:"explicit"},rule:"latest rule",reasons:["latest reason"]});
 assert.equal(rows.find(j=>j.id==="cp-events")?.routing,"scope:L (inferred) · risk:low (explicit) · latest rule · latest reason");
 assert.deepEqual(rows.find(j=>j.id==="cp-fleet")?.routing_facts,fallback);
 assert.deepEqual(rows.find(j=>j.id==="cp-partial")?.routing_facts,{scope:null,risk:"high",provenance:{scope:null,risk:"inferred"},rule:null,reasons:[]});
 assert.equal(rows.find(j=>j.id==="cp-empty")?.routing_facts,null);
 assert.equal(rows.find(j=>j.id==="cp-empty")?.routing,null);
 assert.doesNotMatch(JSON.stringify(rows), /not-for-the-api|private/);
 const live={job_id:"cp-live",project:"demo",phase:"held",routing:fallback};
 put(LAYOUT.fleetFile,{jobs:[live]});
 const row=jobsView(state,Date.parse(at)).jobs.find(j=>j.id==="cp-live")!;
 assert.equal(row.routing,"scope:S (explicit) · risk:low (defaulted) · fleet rule · fleet reason");
 assert.deepEqual(row.routing_facts,fallback,"live and finished jobs expose the same structured fields");
});
