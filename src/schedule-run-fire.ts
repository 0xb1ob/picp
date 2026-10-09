/** The dormant fire branch: only an injected active store can reach it in P2b. */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { isoTimestamp } from "./contracts.ts";
import { effectivePolicyBounds } from "./schedule-policy.ts";
import { refused, type MintContext, type Refusal } from "./schedule-grant.ts";
import { verifiedRunNowClick } from "./schedule-control.ts";
import type { Ledger } from "./ledger.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import type { SchedulePolicy } from "./viewer/schedule-policy.ts";
import type { Schedule } from "./viewer/schedule-core.ts";
import type { FireTrigger } from "./scheduler.ts";

export async function startRun(input: {runs:ScheduleRunStore; ledger:Ledger; schedule:Schedule; policy:SchedulePolicy; context:MintContext; title:string; now:Date; slot:Date; missed:boolean; missedAt:Date; manual?:FireTrigger; controlPid?:number}): Promise<{job_id:string; run_id:string; reason:string} | Refusal> {
 const {runs,ledger,schedule,policy,now,manual} = input;
 if (runs.openRun(schedule.id)) return {refusal:`schedule ${schedule.id} already has open run ${runs.openRun(schedule.id)!.id}`};
 if (schedule.job.delivery === "pipeline") return {refusal:"pipeline schedules remain legacy"};
 const channel = manual?.via ?? "slot";
 if (!policy.permitted_start_channels[channel]) return {refusal:`schedule ${schedule.id}: ${channel} start is not permitted`};
 const recipe = policy.recipe;
 if ((["title", "kind", "delivery", "description", "script_path"] as const).some((key) => schedule.job[key] !== recipe[key]) || (schedule.job.skill ?? null) !== recipe.skill) return {refusal:`schedule ${schedule.id}: saved policy recipe differs from the schedule`};
 const bounds = effectivePolicyBounds(policy,input.context,schedule.project,schedule.job.kind,now);
 if (refused(bounds)) return bounds;
 const stamp = isoTimestamp(now), id = `run-${stamp.replace(/[^0-9]/g,"")}-${randomBytes(3).toString("hex")}`;
 const snapshot = {...structuredClone(policy),limits:bounds.limits,exclusions:bounds.exclusions};
 const preapproval = manual?.via === "dashboard" && policy.effects.includes("org_review_approve") && policy.effect_channels.org_review_approve?.includes("dashboard") && verifiedRunNowClick(dirname(runs.runsFile),manual.request_id,schedule.id,input.controlPid ?? process.pid)
  ? {operator_quote:policy.approval.operator_quote,decided_by:policy.approval.decided_by,scope:"mandate_jobs" as const,granted_at:stamp,...(policy.approval.delegation_rule ? {delegation_rule:policy.approval.delegation_rule} : {}),...(policy.approval.send_id ? {send_id:policy.approval.send_id} : {})} : undefined;
 await runs.createRun({schema_version:1,id,schedule_id:schedule.id,policy_revision:policy.revision,policy:snapshot,trigger:{via:manual?.via ?? (schedule.trigger.type === "watch" ? "watch" : "slot"),at:stamp,slot:isoTimestamp(input.slot),missed:input.missed,...(manual?.via === "dashboard" ? {request_id:manual.request_id} : manual ? {tool_call_id:manual.tool_call_id,quote_sha:manual.source_sha} : {})},anchor_job_id:null,members:[],phase:"accepted",outcome:null,started_at:stamp,deadline_at:isoTimestamp(new Date(now.getTime()+snapshot.limits.run_hours*3_600_000)),risk_preapproved:[],authority_log:[],cap_notices:[],...(preapproval ? {risk_preapproval:preapproval} : {})});
 const created = await ledger.create({title:input.title,project:schedule.project,kind:schedule.job.kind,delivery:schedule.job.delivery,labels:[`schedule:${schedule.id}`],...(schedule.job.description ? {description:schedule.job.description} : {}),...(schedule.job.script_path !== undefined ? {scriptPath:schedule.job.script_path} : {})});
 const under = `for ${schedule.id} (${schedule.name}) under run ${id} (policy rev ${policy.revision})`;
 const marker = manual?.via === "cp_schedule" ? `run-now quote sha ${manual.source_sha}` : undefined;
 const notes = manual?.via === "dashboard" ? `run now from the dashboard (${manual.request_id}) ${under}${manual.peer ? `; peer ${manual.peer}` : ""}` : manual ? `run now via cp_schedule (${manual.tool_call_id}) ${under}; authorized by ${manual.decided_by}; ${marker}` : `scheduled ${under}${input.missed ? `; missed ${isoTimestamp(input.missedAt)}` : ""}`;
 await ledger.update(created.id,{notes,...(schedule.job.skill ? {status:"deferred"} : {})});
 await runs.attachAnchor(id,{job_id:created.id,role:null,admitted_at:created.created_at});
 await runs.setPhase(id,"running");
 let warning = "";
 if (manual?.via === "cp_schedule") try { await ledger.comment(created.id,`${marker}: ${manual.operator_quote}`); } catch(error) { warning = `; warning: quote comment not written (${(error as Error).message}); the notes retain ${marker}`; }
 return {job_id:created.id,run_id:id,reason:`created ${created.id} under run ${id}; no grant minted${warning}`};
}
