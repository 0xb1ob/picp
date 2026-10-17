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
import { policyFromLegacy, type NativeSchedulePolicy } from "../src/viewer/schedule-policy.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";
import { schedulePolicyView } from "../src/viewer/schedule-policy-view.ts";
import { effectivePolicyBounds } from "../src/schedule-policy.ts";

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function bench(t: import("node:test").TestContext) {
 const home = createScratchHome(); t.after(()=>home.cleanup());
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const now = new Date(stamp());
 const runs = openScheduleRunStore(home.path);
 const mandates = new MandateStore(home.path,{runs,now:()=>now});
 const defaults = structuredClone(loadMandateDefaults(home.path));
 const scheduler = new Scheduler({home:home.path,ledger:()=>ledger,mandates,runs,usageJobs:()=>[],cloneOf:()=>home.path,now:()=>now,mintContext:()=>({defaults,ceiling:defaults.token_ceiling!})});
 const native = {action:{saved_by:"operator-quote" as const,provenance:{channel:"cp_schedule" as const,tool_call_id:"call-add",quote_sha:"abcdef123456"}},limits:{}};
 const schedule = await scheduler.add({name:"nightly",project:"demo",native,manual:true,title:"Nightly report",kind:"research",delivery:"answer"});
 const stateDir = dirname(scheduler.file);
 const control = new ScheduleControl({stateDir,scheduler,now:()=>now,log:()=>{}});
 let n=0;
 const request = async(op:ScheduleControlOp,fields:ScheduleControlFields={})=>{
  const id=`sc-${now.toISOString().replace(/[-:T]/g,"").slice(0,14)}-${String(++n).padStart(8,"0")}`;
  assert.equal(appendScheduleControlLine(stateDir,{type:"request",by:"viewer",id,at:now.toISOString(),peer:"127.0.0.1",op,schedule_id:schedule.id,...fields}).ok,true);
  const events=await control.pass();
  return {events,receipt:readScheduleControl(stateDir).requests.find(r=>r.id===id)!};
 };
 return {home,ledger,runs,mandates,scheduler,schedule,stateDir,request,defaults};
}

test("authenticated adopt is atomic, refuses an open job, and routes spending to the run with no grant",async(t)=>{
 const b=await bench(t);
 assert.equal(SCHEDULE_RUNS_ACTIVE,true);
 await assert.rejects(b.scheduler.activatePolicy(b.schedule.id,{saved_by:"dashboard",provenance:{channel:"dashboard",request_id:"sc-fake"}},1),/unauthenticated/);
 const open=await b.scheduler.fireNow(b.schedule.id,"sc-open");
 const refused=await b.request("adopt",{revision:1});
 assert.equal(refused.receipt.state,"refused");assert.match(refused.receipt.reason!,/open legacy\/run job/);
 assert.equal(b.runs.policyRecord(b.schedule.id)?.revisions.length,1);
 await b.ledger.close(open.job_id!,"completed");await b.runs.closeRun(open.run_id!,"completed",stamp());
 const adopted=await b.request("adopt",{revision:1});
 assert.equal(adopted.receipt.state,"done",adopted.receipt.reason!);
 const record=b.runs.policyRecord(b.schedule.id)!;
 assert.equal(record.revisions.length,2);assert.equal(record.active_revision,2);
 const started=await b.request("run_now",{revision:2});
 const event=started.events[0]!;
 assert.equal(started.receipt.state,"done");assert.ok(event.run_id);
 await b.mandates.assertDispatchAllowed({jobId:event.job_id!,project:"demo",kind:"research"});
 assert.equal(b.runs.run(event.run_id!)?.authority_log.at(-1)?.use,"dispatch");
 assert.deepEqual(b.mandates.list(),[],"no grant audit or synthetic grant");
 const off=await b.request("deactivate");assert.equal(off.receipt.state,"refused");assert.match(off.receipt.reason!,/open run/);
});

test("save binds revisions and frozen runs; a legacy draft is refused; deactivate preserves history and starts nothing",async(t)=>{
 const b=await bench(t);
 const started=await b.request("run_now",{revision:1}), event=started.events[0]!;
 const draft=structuredClone(b.runs.activePolicy(b.schedule.id)!) as NativeSchedulePolicy;
 draft.recipe.title="Next recipe";draft.limits.tokens=2_000_000;
 const saved=await b.request("save_policy",{revision:1,policy:draft});assert.equal(saved.receipt.state,"done",saved.receipt.reason!);
 assert.equal(b.runs.activePolicy(b.schedule.id)?.recipe.title,"Next recipe");
 assert.equal(b.runs.run(event.run_id!)?.policy.recipe.title,"Nightly report");
 assert.equal(b.scheduler.list()[0]?.job.title,"Nightly report","open run keeps frozen expansion recipe");
 const stale=await b.request("save_policy",{revision:1,policy:draft});assert.equal(stale.receipt.state,"refused");assert.match(stale.receipt.reason!,/Schedule changed/);
 // PR4: a legacy grant-shaped revision is read-only; nothing saves or adopts one again.
 const legacy=policyFromLegacy({...b.schedule,mandate_id:"md-123456"},{seed_mandate_id:"md-123456",channel:"operator_chat",objective:"Nightly report",expiry_hours:1,spend_usd:10,spend_tokens:1000,job_cap:3,allowed_actions:["plan"],ask_on:["merge","risk:high"],approval:{operator_quote:"Run the nightly report",decided_by:"operator-quote",approved_at:stamp()}});
 await assert.rejects(b.scheduler.savePolicy(b.schedule.id,legacy,{saved_by:"operator-quote",provenance:{channel:"cp_schedule",tool_call_id:"tool",quote_sha:"123456abcdef"}},2),/only a native policy revision is saved or adopted/);
 await b.ledger.close(event.job_id!,"completed");await b.runs.closeRun(event.run_id!,"completed",stamp());
 assert.equal(b.scheduler.list()[0]?.job.title,"Next recipe");
 const staleRun=await b.request("run_now",{revision:1});assert.equal(staleRun.receipt.state,"refused");assert.match(staleRun.receipt.reason!,/Schedule changed/);
 const off=await b.request("deactivate");assert.equal(off.receipt.state,"done",off.receipt.reason!);
 assert.equal(b.runs.policyRecord(b.schedule.id)?.revisions.length,3);
 const after=await b.request("run_now",{revision:0});assert.equal(after.receipt.state,"refused");assert.match(after.receipt.reason!,/no active native policy/);
 assert.deepEqual(b.mandates.list(),[],"no fallback grant is minted");
 assert.deepEqual(await b.ledger.list(),[]);
});

test("save refuses invalid authority and live bounds without changing policy bytes",async(t)=>{
 const b=await bench(t);
 const before=readFileSync(b.runs.policiesFile,"utf8");
 const policy=structuredClone(b.runs.activePolicy(b.schedule.id)!);
 policy.effects.push("org_review_approve");
 await assert.rejects(b.scheduler.savePolicy(b.schedule.id,policy,{saved_by:"operator-quote",provenance:{channel:"cp_schedule",tool_call_id:"tool",quote_sha:"123456abcdef"}},1),/invalid schedule policy/);
 b.defaults.exclude_paths=Array.from({length:33},(_,i)=>`excluded-${i}`);
 const refused=await b.request("save_policy",{revision:1,policy:b.runs.activePolicy(b.schedule.id)!});
 assert.equal(refused.receipt.state,"refused");assert.match(refused.receipt.reason!,/over the 32/);
 assert.equal(readFileSync(b.runs.policiesFile,"utf8"),before);
});

test("read-only policy preview matches live narrowing and reports malformed/overfull bounds",async(t)=>{
 const b=await bench(t);
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

test("deactivation drains authority even when bounds forbid new runs, preserving authentication and audit",async(t)=>{
 const b=await bench(t);
 const started=await b.request("run_now",{revision:1}), event=started.events[0]!;
 const policy=structuredClone(b.runs.activePolicy(b.schedule.id)!);
 policy.revision=2;policy.exclusions.job_kinds=["research"];
 await b.runs.savePolicyRevision(policy,{at:policy.saved_at,provenance:{channel:"dashboard"}});
 const blocked=await b.request("run_now",{revision:2});assert.equal(blocked.receipt.state,"refused");
 const open=await b.request("deactivate");assert.equal(open.receipt.state,"refused");assert.match(open.receipt.reason!,/open run/);
 await b.ledger.close(event.job_id!,"completed");await b.runs.closeRun(event.run_id!,"completed",policy.saved_at);
 const excluded=await b.request("run_now",{revision:2});assert.equal(excluded.receipt.state,"refused");assert.match(excluded.receipt.reason!,/excludes research/);
 await assert.rejects(b.scheduler.deactivatePolicy(b.schedule.id,{saved_by:"dashboard",provenance:{channel:"dashboard",request_id:"sc-fake"}}),/unauthenticated/);
 const off=await b.request("deactivate");assert.equal(off.receipt.state,"done",off.receipt.reason!);
 const record=b.runs.policyRecord(b.schedule.id)!;
 assert.equal(record.active_revision,null);assert.equal(record.revisions.length,3);
 assert.equal(record.revisions.at(-1)?.provenance.request_id,off.receipt.id);
 assert.deepEqual(record.revisions.at(-1)?.exclusions,policy.exclusions);
 assert.deepEqual(b.mandates.list(),[]);assert.equal(b.runs.run(event.run_id!)?.phase,"closed");
});

test("authenticated deactivation does not need a readable live admission context",async(t)=>{
 const b=await bench(t);
 const scheduler=new Scheduler({home:b.home.path,ledger:()=>b.ledger,mandates:b.mandates,runs:b.runs,usageJobs:()=>[],cloneOf:()=>b.home.path,mintContext:()=>{throw new Error("live bounds unreadable");}});
 const control=new ScheduleControl({stateDir:b.stateDir,scheduler,log:()=>{}}), id="sc-20261009090000-abcdef12";
 appendScheduleControlLine(b.stateDir,{type:"request",by:"viewer",id,at:new Date().toISOString(),peer:"127.0.0.1",op:"deactivate",schedule_id:b.schedule.id});
 await control.pass();
 const receipt=readScheduleControl(b.stateDir).requests.find(r=>r.id===id)!;
 assert.equal(receipt.state,"done",receipt.reason!);assert.equal(b.runs.activePolicy(b.schedule.id),undefined);
 assert.equal(b.runs.policyRecord(b.schedule.id)?.revisions.at(-1)?.provenance.request_id,id);
});
