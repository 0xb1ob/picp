import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleControl } from "../src/schedule-control.ts";
import { openScheduleRunStore, SCHEDULE_RUNS_ACTIVE } from "../src/schedule-runs.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { readScheduleControl, type ScheduleControlFields, type ScheduleControlOp } from "../src/viewer/control-files.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

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

