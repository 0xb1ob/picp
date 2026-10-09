import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { DecisionBasisSchema, validate, LAYOUT, isoTimestamp } from "../src/contracts.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { decide } from "../src/decide.ts";
import { autoDecideCheckpoint } from "../src/mandate-autodecide.ts";
import { MandateStore } from "../src/mandate.ts";
import { checkpointAuthority, scheduleRunVerdict, ScheduleAuthorityError } from "../src/schedule-authority.ts";
import { ScheduleRunStore } from "../src/schedule-runs.ts";
import { policyFromLegacy } from "../src/viewer/schedule-policy.ts";
import type { ScheduleRun } from "../src/viewer/schedule-run-core.ts";
import { createScratchHome } from "./harness/index.ts";
import { createScratchLedger } from "./harness/index.ts";
import { FleetStore } from "../src/fleet.ts";
import { EscalationStore } from "../src/escalation.ts";
import { cpNext, formatNext } from "../src/next.ts";
import { EMPTY_USAGE, ESCALATION_NO_MANDATE } from "../src/contracts.ts";
import { observeRunUsage, runAuthority, runRiskPreapproval } from "../src/schedule-authority.ts";
import { decisions } from "../src/viewer/overview-decisions.ts";

const now = isoTimestamp(), at = isoTimestamp(new Date(Date.now()-600_000));
async function fixture(orgReview = false) {
 const home = createScratchHome();
 const runs = new ScheduleRunStore({home:home.path});
 const approval = {operator_quote:"approve these run jobs",decided_by:"operator-delegated" as const,scope:"mandate_jobs" as const,granted_at:at};
 const policy = policyFromLegacy({id:"sch-123456", name:"Nightly work", project:"demo", mandate_id:"md-123456", enabled:true, created_at:at, trigger:{type:"manual"}, job:orgReview ? {title:"Nightly work",kind:"research",delivery:"local",skill:"cp-org-pr-review",description:"org: demo\nmax_reviewers: 1"} : {title:"Nightly work", kind:"ship", delivery:"pr"}}, {
  seed_mandate_id:"md-123456", channel:"operator_chat", objective:"Nightly work", expiry_hours:1, spend_usd:10, spend_tokens:1000, job_cap:orgReview ? 8 : 3,
  allowed_actions:["implement", "review", "repair"], ask_on:["merge", "risk:high"], approval:{operator_quote:"Run nightly work", decided_by:"operator-quote", approved_at:at}
 }, orgReview ? {id:"md-123456",schedule_grant:true,risk_preapproval:approval} : undefined);
 await runs.savePolicyRevision(policy);
 const run:ScheduleRun = {schema_version:1,id:"run-20260701060000-abcdef",schedule_id:policy.schedule_id,policy_revision:1,policy,trigger:{via:"slot",at},anchor_job_id:"cp-member",members:[{job_id:"cp-member",role:null,admitted_at:at}],phase:"running",outcome:null,started_at:at,deadline_at:isoTimestamp(new Date(Date.now()+3_600_000)),risk_preapproved:[],authority_log:[],cap_notices:[]};
 if (orgReview) {run.trigger={via:"dashboard",at,request_id:"sc-approval"};run.risk_preapproval=approval;}
 await runs.createRun(run);
 const mandates = new MandateStore(home.path,{runs,now:()=>new Date(now)});
 mandates.issue({projects:["demo"],objective:"Other work",expiry:isoTimestamp(new Date(Date.now()+86_400_000)),spend_cap:{usd:20,tokens:2000},job_cap:4,allowed_actions:["implement","review","repair"],ask_on:["merge","risk:high"]});
 return {home,runs,run,mandates};
}

test("A1: run basis uses the store identity and closed variants", () => {
 const basis = {run:"run-20260701060000-abcdef",clause:"schedule-run run-20260701060000-abcdef (policy rev 1)"};
 assert.equal(validate(DecisionBasisSchema,basis).ok,true);
 for (const invalid of [{...basis,mandate:"md-123456"},{...basis,operator_quote:"yes"},{...basis,run:"md-123456"},{...basis,run:"run-invalid"},{...basis,extra:true}]) assert.equal(validate(DecisionBasisSchema,invalid).ok,false);
 assert.equal(validate(DecisionBasisSchema,{mandate:"md-123456",clause:"unchanged"}).ok,true);
 assert.equal(validate(DecisionBasisSchema,{operator_quote:"unchanged"}).ok,true);
});

test("A1: run decide and autodecide persist run attribution and isolate the mandate journal", async(t) => {
 const {home,runs,run,mandates} = await fixture(); t.after(()=>home.cleanup());
 const grantFile = `${home.path}/${LAYOUT.mandates}/${mandates.list()[0]!.id}.json`;
 const before = readFileSync(grantFile,"utf8");
 const ship = new CheckpointStore(home.path), diff = new CheckpointStore(home.path,{kind:"diff"}), merge = new CheckpointStore(home.path,{kind:"merge"});
 ship.request({jobId:"cp-member",question:"Approve work"});
 const bundle = {
  items:[],ship,diff,merge,mandates,lookupJob:(jobId:string)=>({jobId,project:"demo",jobKind:"ship" as const,risk:"low" as const}),usageJobs:()=>[],operatorTexts:[],answerDeclared:async()=>{}
 };
 await assert.rejects(decide({target:"cp-member",decision:"approve",basis:{run:"run-20260701060000-000000",clause:"wrong run"}},bundle),/does not name this job/);
 await assert.rejects(decide({target:"cp-member",decision:"approve",basis:{mandate:mandates.list()[0]!.id,clause:"wrong authority"}},bundle),/require a run basis/);
 await assert.rejects(decide({target:"cp-member",decision:"approve",basis:{run:run.id,mandate:mandates.list()[0]!.id,clause:"mixed"}},bundle),/invalid decision basis/);
 assert.deepEqual(runs.run(run.id)?.authority_log,[]);
 const result = await decide({target:"cp-member",kind:"ship",decision:"approve",basis:{run:run.id,clause:"requested"}},bundle);
 const clause = `schedule-run ${run.id} (policy rev 1)`;
 assert.deepEqual(result.basis,{run:run.id,clause});
 assert.equal(result.decided_by,`schedule-run:${run.id}`);
 assert.deepEqual(ship.get("cp-member")?.basis,result.basis);
 const pending = diff.request({jobId:"cp-member",question:"Review work"});
 const auto = autoDecideCheckpoint(diff,pending,{kind:"diff",jobId:"cp-member",project:"demo",jobKind:"ship",risk:"low",now},mandates);
 assert.equal(auto.decided_by,`schedule-run:${run.id}`);
 assert.deepEqual(auto.basis,{run:run.id,clause});
 assert.deepEqual(runs.run(run.id)?.authority_log.map(row=>row.use),["implement","review"]);
 assert.equal(readFileSync(grantFile,"utf8"),before);
 assert.equal(checkpointAuthority(mandates.runContext(),{kind:"merge",jobId:"cp-member",project:"demo",now},mandates.list()).permitted,false);
});

test("run dispatch and advice never spend or mutate a pointer grant; caps refuse reviewer and repair",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 const before = JSON.stringify(mandates.list());
 const job = {jobId:"cp-member",project:"demo",kind:"ship" as const,risk:"low" as const};
 assert.equal(mandates.selection("dispatch",job),undefined);
 assert.equal(mandates.wouldAskRiskHigh(job,"high"),true);
 assert.deepEqual(runs.run(run.id)?.authority_log,[]);
 assert.equal((await mandates.assertDispatchAllowed(job)).run?.id,run.id);
 assert.equal((await mandates.assertDispatchAllowed({...job,promotion:true})).run?.id,run.id);
 const spent = [{job_id:job.jobId,project:"demo",kind:"ship" as const,phase:"held" as const,usage:{cost_usd:10,total_tokens:1}}];
 for (const use of ["review","repair"] as const) assert.throws(()=>mandates.assertPermitted(use,job,spent),e=>e instanceof ScheduleAuthorityError && e.code === "run_usd_cap");
 assert.equal(JSON.stringify(mandates.list()),before);
 assert.deepEqual(runs.run(run.id)?.authority_log.map(r=>r.use),["dispatch","promote","review","repair"]);
});

test("run members fail closed for missing and corrupt policies",async(t)=>{
 const {home,runs,mandates} = await fixture();t.after(()=>home.cleanup());
 writeFileSync(runs.policiesFile,JSON.stringify({schema_version:1,policies:[]}));
 assert.throws(()=>scheduleRunVerdict(mandates.runContext(),"dispatch",{jobId:"cp-member",project:"demo"},[],now),e=>e instanceof ScheduleAuthorityError && e.code === "policy_missing");
 writeFileSync(runs.policiesFile,"{");
 assert.throws(()=>scheduleRunVerdict(mandates.runContext(),"dispatch",{jobId:"cp-member",project:"demo"},[],now),e=>e instanceof ScheduleAuthorityError && e.code === "policy_corrupt");
});


test("missing policy after interrupted child admission refuses without touching grants",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 await runs.activatePolicy(run.schedule_id,1,at,{channel:"dashboard",request_id:"sc-test"});
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const job = await ledger.create({title:"interrupted child",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 const grantFile = `${home.path}/${LAYOUT.mandates}/${mandates.list()[0]!.id}.json`;
 const before = readFileSync(grantFile,"utf8");
 writeFileSync(runs.policiesFile,JSON.stringify({schema_version:1,policies:[]}));
 await assert.rejects(mandates.assertDispatchAllowed({jobId:job.id,project:"demo",kind:"ship"}),e=>e instanceof ScheduleAuthorityError && e.code==="policy_missing" && e.runId===run.id);
 assert.equal(readFileSync(grantFile,"utf8"),before);
 assert.equal(runs.runOfJob(job.id),undefined);
});


test("post-activation non-members fail closed; legacy jobs remain under mandates",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 await runs.activatePolicy(run.schedule_id,1,at,{channel:"dashboard",request_id:"sc-test"});
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const job = await ledger.create({title:"not admitted",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 assert.throws(()=>mandates.selection("dispatch",{jobId:job.id,project:"demo",kind:"ship"}),e=>e instanceof ScheduleAuthorityError && e.code === "not_member");
 await assert.rejects(mandates.assertDispatchAllowed({jobId:job.id,project:"demo",kind:"ship"}),e=>e instanceof ScheduleAuthorityError && e.code === "not_member");
 assert.deepEqual(runAuthority({...mandates.runContext(),ledgerJob:()=>({...job,created_at:isoTimestamp(new Date(Date.parse(at)-1000))})},job.id),{source:"mandate"});
});

test("run queue advice and 80 percent/cap notices write only run notices",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const job = await ledger.create({title:"run child",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 await runs.admitMember(run.id,{job_id:job.id,role:null,admitted_at:job.created_at});
 const before = JSON.stringify(mandates.list()), audit = JSON.stringify(runs.run(run.id)?.authority_log);
 const view = await cpNext({ledger,mandates,fleet:new FleetStore({home:home.path}),escalations:new EscalationStore({home:home.path}),now:()=>new Date(now)},"demo");
 assert.equal(view.run?.id,run.id);assert.equal(view.action.job_id,job.id);assert.equal(view.action.kind,"dispatch");assert.match(formatNext(view),new RegExp(`run ${run.id}`));
 assert.equal(JSON.stringify(runs.run(run.id)?.authority_log),audit);
 const waiting = await ledger.create({title:"another run child",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 await runs.admitMember(run.id,{job_id:waiting.id,role:null,admitted_at:waiting.created_at});
 const queued = await cpNext({ledger,mandates,fleet:new FleetStore({home:home.path}),escalations:new EscalationStore({home:home.path}),queued:()=>["cp-member",job.id],now:()=>new Date(now)},"demo");
 assert.equal(queued.action.kind,"wait");assert.match(queued.action.reason,/parallelism/);
 assert.equal(JSON.stringify(runs.run(run.id)?.authority_log),audit);
 const notices: string[] = [];
 const ctx = {...mandates.runContext(),jobs:()=>[{job_id:job.id,project:"demo",usage:EMPTY_USAGE}],journal:(input:{content:string})=>{notices.push(input.content);}};
 observeRunUsage(ctx,job.id,EMPTY_USAGE,{...EMPTY_USAGE,cost_usd:8});
 observeRunUsage(ctx,job.id,{...EMPTY_USAGE,cost_usd:8},{...EMPTY_USAGE,cost_usd:10});
 observeRunUsage(ctx,job.id,EMPTY_USAGE,{...EMPTY_USAGE,cost_usd:10});
 assert.equal(notices.length,2);
 for (const note of notices) {assert.match(note,/SCHEDULE RUN CAP.*no new admission; in-flight work continues; the run closes partial/);assert.doesNotMatch(note,/raise/i);}
 assert.equal(JSON.stringify(mandates.list()),before);
});

test("run exclusions, risk, deadline, parallelism and token caps audit their refusal codes",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 const job = {jobId:"cp-member",project:"demo",kind:"ship" as const,risk:"low" as const};
 const ctx = mandates.runContext();
 for (const [code,prepare,use,jobs] of [
  ["kind_excluded",()=>runs.editRun(run.id,r=>{r.policy.exclusions={job_kinds:["ship"]};}),"review",[]],
  ["path_excluded",()=>runs.editRun(run.id,r=>{r.policy.exclusions={paths:["secret"]};}),"review",[]],
  ["subsystem_excluded",()=>runs.editRun(run.id,r=>{r.policy.exclusions={subsystems:["billing"]};}),"review",[]],
  ["parallelism_full",()=>runs.editRun(run.id,r=>{r.policy.exclusions={};}),"dispatch",[{job_id:job.jobId,project:"demo",kind:"ship",phase:"waiting"}]],
  ["run_token_cap",()=>{},"review",[{job_id:job.jobId,project:"demo",usage:{cost_usd:0,total_tokens:1000}}]],
  ["deadline_passed",()=>runs.editRun(run.id,r=>{r.deadline_at=isoTimestamp(new Date(Date.parse(now)-1000));}),"dispatch",[]]
 ] as const) {
  prepare();assert.throws(()=>scheduleRunVerdict(ctx,use,{...job,pathHints:["secret"],subsystem:"billing"},jobs,now),e=>e instanceof ScheduleAuthorityError && e.code===code);
 }
 assert.deepEqual(runs.run(run.id)?.authority_log.map(r=>r.code),["kind_excluded","path_excluded","subsystem_excluded","parallelism_full","run_token_cap","deadline_passed"]);
 const record = {...run,risk_preapproval:{operator_quote:"approve",decided_by:"operator-quote" as const,scope:"mandate_jobs" as const,granted_at:at}};
 assert.equal(runRiskPreapproval(record,job),true);assert.equal(runRiskPreapproval(record,{...job,script:true}),false);
 assert.equal(runRiskPreapproval(record,{...job,jobId:"cp-outside"}),false);
});

test("A1 viewer readers retain run basis and source",async(t)=>{
 const {home,run} = await fixture();t.after(()=>home.cleanup());
 writeFileSync(`${home.path}/${LAYOUT.escalationsFile}`,JSON.stringify({items:[{id:"es-run",status:"answered",question:"Approve work",created_at:at,answered_at:now,answered_by:`schedule-run:${run.id}`,answer:"approve",job_ids:["cp-member"],basis:{run:run.id,clause:`schedule-run ${run.id} (policy rev 1)`}}]}));
 const result = decisions({home:home.path,stateDir:`${home.path}/${LAYOUT.state}`},Date.parse(now));
 assert.deepEqual(result.decision_items[0]?.basis,{kind:"run",ref:run.id});assert.equal(result.decision_items[0]?.source,"schedule-run");
});


test("run high-risk asks once without mandate attribution; scripts never use standing approval",async(t)=>{
 const {home,runs,run,mandates} = await fixture(true);t.after(()=>home.cleanup());
 const job = {jobId:"cp-member",project:"demo",kind:"ship" as const,risk:"high" as const,script:true};
 const before = JSON.stringify(mandates.list());
 for(let i=0;i<2;i++) await assert.rejects(mandates.assertDispatchAllowed(job),e=>e instanceof ScheduleAuthorityError && e.code==="risk_high");
 const escalations = new EscalationStore({home:home.path}).list({jobId:job.jobId,kind:"risk_high_irreversible"});
 assert.equal(escalations.length,1);assert.match(escalations[0]!.question,new RegExp(run.id));assert.equal(escalations[0]!.mandate_id,ESCALATION_NO_MANDATE);
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const dangerous = await ledger.create({title:"dangerous review",description:"force push the branch",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`,"risk:high"]});
 await runs.admitMember(run.id,{job_id:dangerous.id,role:null,admitted_at:dangerous.created_at});
 await assert.rejects(mandates.assertDispatchAllowed({jobId:dangerous.id,project:"demo",kind:"ship",risk:"high"}),e=>e instanceof ScheduleAuthorityError && e.code==="hard_stop");
 const store = new EscalationStore({home:home.path});
 const fresh = store.list({jobId:dangerous.id,kind:"risk_high_irreversible",status:"open"})[0]!;
 await store.answer(fresh.id,{answer:"approve",by:"operator-quote",basis:{operator_quote:`approve ${fresh.id} for this job`}});
 assert.equal((await mandates.assertDispatchAllowed({jobId:dangerous.id,project:"demo",kind:"ship",risk:"high"})).run?.id,run.id);
 assert.equal(JSON.stringify(mandates.list()),before);
 const auditBefore = JSON.stringify(runs.run(run.id)?.authority_log);
 assert.throws(()=>scheduleRunVerdict(mandates.runContext(),"dispatch",{...job,advice:true},[],now),ScheduleAuthorityError);
 assert.equal(JSON.stringify(runs.run(run.id)?.authority_log),auditBefore);
});


test("activated child admission is idempotent, heals a missed admission and refuses the run cap",async(t)=>{
 const {home,runs,run,mandates} = await fixture();t.after(()=>home.cleanup());
 const {admitScheduledMember} = await import("../src/schedule-expand.ts");
 await runs.activatePolicy(run.schedule_id,1,at,{channel:"dashboard",request_id:"sc-test"});
 const ledger = createScratchLedger({home:home.path,knownProjects:["demo"]}).ledger;
 const before = JSON.stringify(mandates.list());
 const child = await ledger.create({title:"child",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 await assert.rejects(mandates.assertDispatchAllowed({jobId:child.id,project:"demo",kind:"ship"}),e=>e instanceof ScheduleAuthorityError && e.code==="not_member");
 await admitScheduledMember(runs,child);await admitScheduledMember(runs,child);
 assert.equal(runs.run(run.id)?.members.length,2);
 const other = await ledger.create({title:"other",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 await admitScheduledMember(runs,other);
 const over = await ledger.create({title:"over cap",project:"demo",kind:"ship",delivery:"pr",labels:[`schedule:${run.schedule_id}`]});
 await assert.rejects(admitScheduledMember(runs,over),new RegExp(`${run.id}: limits.child_jobs`));
 assert.equal(runs.runOfJob(over.id),undefined);assert.equal(JSON.stringify(mandates.list()),before);
});
