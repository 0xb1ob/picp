import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { MandateStore } from "../src/mandate.ts";
import { loadMandateDefaults } from "../src/mandate-defaults.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleRunStore, SCHEDULE_RUNS_ACTIVE, reconcileRun } from "../src/schedule-runs.ts";
import { policyFromLegacy } from "../src/viewer/schedule-policy.ts";
import { ScheduleRunner } from "../src/schedule-runner.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

for (const activated of [false,true]) test(`dormant cutover: ${activated ? "injected active policy records a run without minting" : "absent policy preserves the legacy fire"}`,async(t)=>{
 const home = createScratchHome();t.after(()=>home.cleanup());
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const now = new Date("2026-07-01T06:00:00Z");
 const runs = new ScheduleRunStore({home:home.path,active:activated});
 const mandates = new MandateStore(home.path,{runs,now:()=>now});
 const seed = mandates.issue({projects:["demo"],objective:"nightly",expiry:"2026-12-31T00:00:00Z",spend_cap:{usd:100,tokens:1_000_000},job_cap:5,at:"2026-06-01T00:00:00Z",schedule_grant:true});
 const scheduler = new Scheduler({home:home.path,ledger:()=>ledger,mandates,runs,usageJobs:()=>[],cloneOf:()=>home.path,now:()=>now,mintContext:()=>({defaults:loadMandateDefaults(home.path),ceiling:100_000_000})});
 const schedule = await scheduler.add({name:"nightly",project:"demo",mandate_id:seed.id,manual:true,title:"Nightly report",kind:"research",delivery:"answer"});
 if (activated) {
  await runs.savePolicyRevision(policyFromLegacy(schedule,schedule.grant_template!));
  await runs.activatePolicy(schedule.id,1,now.toISOString().replace(".000Z","Z"),{channel:"dashboard",request_id:"sc-test"});
 }
 const before = JSON.stringify(mandates.list());
 const event = await scheduler.fireNow(schedule.id,"sc-test");
 assert.equal(SCHEDULE_RUNS_ACTIVE,false);
 assert.equal(event.outcome,"fired");
 if (activated) {
  assert.equal(JSON.stringify(mandates.list()),before);
  assert.equal(runs.runOfJob(event.job_id!)?.id,event.run_id);
  assert.match(event.reason,/under run .*; no grant minted/);
  assert.match((await ledger.show(event.job_id!)).notes ?? "",/run now from the dashboard \(sc-test\) for .* under run/);
  assert.equal(runs.runs().length,1);
  const runner = new ScheduleRunner({runs,ledger:()=>ledger,fleetJobs:()=>[],schedules:()=>scheduler.list(),now:()=>now,log:()=>{},dispatch:async()=>{},tearDown:async()=>({torn_down:true}),recorded:async()=>{throw new Error("unexpected intake");},wake:()=>{}});
  await ledger.close(event.job_id!,"completed");await runner.retryPending();
  assert.equal(runs.run(event.run_id!)?.outcome,"completed");
  const second = await scheduler.fireNow(schedule.id,"sc-second");
  await ledger.drop(second.job_id!,"cap refusal");await runner.retryPending();
  assert.equal(runs.run(second.run_id!)?.outcome,"partial");
  const attach = runs.attachAnchor.bind(runs);
  runs.attachAnchor = async()=>{throw new Error("injected crash before anchor attachment");};
  await assert.rejects(scheduler.fireNow(schedule.id,"sc-crash"),/injected crash/);
  runs.attachAnchor = attach;
  const orphan = runs.openRun(schedule.id)!;
  assert.equal(orphan.anchor_job_id,null);assert.equal(orphan.phase,"accepted");
  const recovered = reconcileRun(orphan,ledger.read().jobs);
  runs.editRun(orphan.id,row=>Object.assign(row,recovered));
  assert.equal(runs.run(orphan.id)?.phase,"running");assert.ok(runs.runOfJob(recovered.anchor_job_id!));
  await ledger.close(recovered.anchor_job_id!,"completed after recovery");await runner.retryPending();
  assert.equal(runs.run(orphan.id)?.outcome,"completed");
  assert.equal(JSON.stringify(mandates.list()),before);
 } else {
  assert.notEqual(event.mandate_id,seed.id);
  assert.equal(event.run_id,undefined);
  assert.equal(existsSync(runs.runsFile),false);
  assert.equal(existsSync(runs.policiesFile),false);
 }
});
