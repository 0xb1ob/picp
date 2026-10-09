import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleControl } from "../src/schedule-control.ts";
import { openScheduleRunStore, SCHEDULE_RUNS_ACTIVE } from "../src/schedule-runs.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { readScheduleControl, type ScheduleControlFields, type ScheduleControlOp } from "../src/viewer/control-files.ts";
import { policyFromLegacy } from "../src/viewer/schedule-policy.ts";
import { readSchedulesOrEmpty } from "../src/schedule-expand.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";
import { schedulePolicyView } from "../src/viewer/schedule-policy-view.ts";
import { effectivePolicyBounds } from "../src/schedule-policy.ts";

async function bench(t: import("node:test").TestContext, skill?: "cp-org-pr-review") {
 const home = createScratchHome(); t.after(()=>home.cleanup());
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const now = new Date(new Date().toISOString().replace(/\.\d{3}Z$/,"Z"));
 const runs = openScheduleRunStore(home.path);
 const mandates = new MandateStore(home.path,{runs,now:()=>now});
 const seed = mandates.issue({projects:["demo"],objective:"nightly",expiry:new Date(now.getTime()+24*3_600_000).toISOString().replace(/\.\d{3}Z$/,"Z"),spend_cap:{usd:100,tokens:1_000_000},job_cap:8,schedule_grant:true});
 const defaults = structuredClone(loadMandateDefaults(home.path));
 const scheduler = new Scheduler({home:home.path,ledger:()=>ledger,mandates,runs,usageJobs:()=>[],cloneOf:()=>home.path,now:()=>now,mintContext:()=>({defaults,ceiling:defaults.token_ceiling!})});
 const schedule = await scheduler.add({name:"nightly",project:"demo",mandate_id:seed.id,manual:true,title:"Nightly report",kind:"research",delivery:skill ? "local" : "answer",...(skill ? {skill,description:"org: example\nmax_reviewers: 3"} : {})});
 const stateDir = dirname(scheduler.file);
 const control = new ScheduleControl({stateDir,scheduler,now:()=>now,log:()=>{}});
 let n=0;
 const request = async(op:ScheduleControlOp,fields:ScheduleControlFields={})=>{
  const id=`sc-${now.toISOString().replace(/[-:T]/g,"").slice(0,14)}-${String(++n).padStart(8,"0")}`;
  assert.equal(appendScheduleControlLine(stateDir,{type:"request",by:"viewer",id,at:now.toISOString(),peer:"127.0.0.1",op,schedule_id:schedule.id,...fields}).ok,true);
  const events=await control.pass();
  return {events,receipt:readScheduleControl(stateDir).requests.find(r=>r.id===id)!};
 };
 return {home,ledger,runs,mandates,seed,scheduler,schedule,stateDir,request,defaults};
}

test("authenticated adopt is atomic, refuses an open legacy job, retires pointer and routes spending to the run",async(t)=>{
 const b=await bench(t);
 assert.equal(SCHEDULE_RUNS_ACTIVE,true);
 await assert.rejects(b.scheduler.activatePolicy(b.schedule.id,{saved_by:"dashboard",provenance:{channel:"dashboard",request_id:"sc-fake"}},0),/unauthenticated/);
 const legacy=await b.scheduler.fireNow(b.schedule.id,"sc-legacy");
 const refused=await b.request("adopt",{revision:0});
 assert.equal(refused.receipt.state,"refused");assert.match(refused.receipt.reason!,/open legacy/);
 assert.equal(b.runs.policyRecord(b.schedule.id),undefined);
 await b.ledger.close(legacy.job_id!,"completed");
 const pointer=b.scheduler.list()[0]!.mandate_id;
 const adopted=await b.request("adopt",{revision:0});
 assert.equal(adopted.receipt.state,"done");
 const record=b.runs.policyRecord(b.schedule.id)!;
 assert.equal(record.revisions.length,1);assert.equal(record.active_revision,1);
 assert.equal(b.mandates.get(pointer)?.revoked_by?.by,"system");
 const before=JSON.stringify(b.mandates.list());
 const started=await b.request("run_now",{revision:1});
 const event=started.events[0]!;
 assert.equal(started.receipt.state,"done");assert.ok(event.run_id);
 assert.equal(JSON.stringify(b.mandates.list()),before);
 await b.mandates.assertDispatchAllowed({jobId:event.job_id!,project:"demo",kind:"research"});
 assert.equal(b.runs.run(event.run_id!)?.authority_log.at(-1)?.use,"dispatch");
 assert.equal(JSON.stringify(b.mandates.list()),before,"no grant audit or synthetic grant");
 const off=await b.request("deactivate");assert.equal(off.receipt.state,"refused");assert.match(off.receipt.reason!,/open run/);
});

test("save binds revisions and frozen runs; deactivate preserves history and restores the original legacy recipe",async(t)=>{
 const b=await bench(t);await b.request("adopt",{revision:0});
 const started=await b.request("run_now",{revision:1}), event=started.events[0]!;
 const draft=structuredClone(b.runs.activePolicy(b.schedule.id)!);
 draft.recipe.title="Next recipe";draft.limits.tokens=2_000_000;
 draft.approval.operator_quote="forged approval";
 const saved=await b.request("save_policy",{revision:1,policy:draft});assert.equal(saved.receipt.state,"done");
 assert.equal(b.runs.activePolicy(b.schedule.id)?.recipe.title,"Next recipe");
 assert.notEqual(b.runs.activePolicy(b.schedule.id)?.approval.operator_quote,"forged approval");
 assert.equal(b.runs.run(event.run_id!)?.policy.recipe.title,"Nightly report");
 assert.equal(b.scheduler.list()[0]?.job.title,"Nightly report","open run keeps frozen expansion recipe");
 const stale=await b.request("save_policy",{revision:1,policy:draft});assert.equal(stale.receipt.state,"refused");assert.match(stale.receipt.reason!,/Schedule changed/);
 await b.ledger.close(event.job_id!,"completed");await b.runs.closeRun(event.run_id!,"completed",new Date().toISOString().replace(/\.\d{3}Z$/,"Z"));
 assert.equal(b.scheduler.list()[0]?.job.title,"Next recipe");
 const staleRun=await b.request("run_now",{revision:1});assert.equal(staleRun.receipt.state,"refused");assert.match(staleRun.receipt.reason!,/Schedule changed/);
 const missing=await b.request("run_now");assert.equal(missing.receipt.state,"refused");
 const off=await b.request("deactivate");assert.equal(off.receipt.state,"done");
 assert.equal(b.runs.policyRecord(b.schedule.id)?.revisions.length,3);
 const before=b.mandates.list().length;
 const legacy=await b.request("run_now",{revision:0});assert.equal(legacy.receipt.state,"done");assert.equal(legacy.events[0]?.run_id,undefined);
 assert.equal(b.mandates.list().length,before+1);
 assert.match((await b.ledger.show(legacy.events[0]!.job_id!)).title,/Nightly report/);
 await b.mandates.assertDispatchAllowed({jobId:legacy.events[0]!.job_id!,project:"demo",kind:"research"});
});

test("save refuses invalid authority and live bounds without changing policy bytes",async(t)=>{
 const b=await bench(t);await b.request("adopt",{revision:0});
 const before=readFileSync(b.runs.policiesFile,"utf8");
 const policy=structuredClone(b.runs.activePolicy(b.schedule.id)!);
 policy.effects.push("org_review_approve");
 await assert.rejects(b.scheduler.savePolicy(b.schedule.id,policy,{saved_by:"operator-quote",provenance:{channel:"cp_schedule",tool_call_id:"tool",quote_sha:"123456abcdef"}},1),/invalid schedule policy/);
 b.defaults.exclude_paths=Array.from({length:33},(_,i)=>`excluded-${i}`);
 const refused=await b.request("save_policy",{revision:1,policy:b.runs.activePolicy(b.schedule.id)!});
 assert.equal(refused.receipt.state,"refused");assert.match(refused.receipt.reason!,/over the 32/);
 assert.equal(readFileSync(b.runs.policiesFile,"utf8"),before);
});

test("unverified org-review click never carries saved clearance and expansion reads the run snapshot",async(t)=>{
 const b=await bench(t,"cp-org-pr-review");
 const policy=policyFromLegacy(b.schedule,b.schedule.grant_template!);
 policy.effects.push("org_review_approve");policy.effect_channels={org_review_approve:["dashboard"]};
 await b.runs.savePolicyRevision(policy,{at:new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),provenance:{channel:"dashboard"}});
 const event=await b.scheduler.fireNow(b.schedule.id,{via:"dashboard",request_id:"sc-unverified",peer:null,revision:1});
 assert.ok(event.run_id,event.reason);
 assert.equal(b.runs.run(event.run_id!)?.risk_preapproval,undefined);
 const updated=structuredClone(policy);updated.revision=2;updated.recipe.description="org: example\nmax_reviewers: 1";updated.recipe_config!.max_reviewers=1;
 await b.runs.savePolicyRevision(updated,{at:new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),provenance:{channel:"dashboard"}});
 assert.equal(readSchedulesOrEmpty(b.home.path)[0]?.job.description,policy.recipe.description,"open run's fanout stays frozen");
 writeFileSync(b.runs.policiesFile,"{");
 await assert.rejects(b.mandates.assertDispatchAllowed({jobId:event.job_id!,project:"demo",kind:"research"}),/policy unreadable/);
});


test("read-only policy preview matches live narrowing and reports malformed/overfull bounds",async(t)=>{
 const b=await bench(t);await b.request("adopt",{revision:0});
 const defaults={...b.defaults,token_ceiling:500_000,exclude_paths:["home-private"]}, projectOverride={exclude_paths:["project-private"]};
 const data=join(dirname(b.stateDir),"data");mkdirSync(data,{recursive:true});
 writeFileSync(join(data,"mandate-defaults.json"),JSON.stringify(defaults));writeFileSync(join(data,"projects.json"),JSON.stringify({projects:[{name:"demo",mandate:projectOverride}]}));
 const policy=b.runs.activePolicy(b.schedule.id)!;
 const before=readFileSync(b.runs.policiesFile,"utf8");
 assert.deepEqual(schedulePolicyView(b.stateDir,b.schedule.id).effective,effectivePolicyBounds(policy,{defaults,ceiling:defaults.token_ceiling,projectOverride},"demo","research",new Date()));
 assert.equal(readFileSync(b.runs.policiesFile,"utf8"),before);
 writeFileSync(join(data,"mandate-defaults.json"),"{");assert.match(schedulePolicyView(b.stateDir,b.schedule.id).blocking.join(";"),/unreadable/);
 writeFileSync(join(data,"mandate-defaults.json"),JSON.stringify({...defaults,exclude_paths:Array.from({length:33},(_,i)=>`path-${i}`)}));assert.match(schedulePolicyView(b.stateDir,b.schedule.id).blocking.join(";"),/32/);
});
