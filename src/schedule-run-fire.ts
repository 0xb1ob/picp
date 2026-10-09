/** Policy-backed fire and operator activation, serialized by Scheduler. */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { isoTimestamp } from "./contracts.ts";
import { effectivePolicyBounds } from "./schedule-policy.ts";
import { refused, type MintContext, type Refusal } from "./schedule-grant.ts";
import { verifiedRunNowClick } from "./schedule-control.ts";
import type { Ledger } from "./ledger.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import { policyFromLegacy, schedulePolicyErrors, type SchedulePolicy } from "./viewer/schedule-policy.ts";
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
 const preapproval = manual?.via === "dashboard" && policy.effects.includes("org_review_approve") && policy.effect_channels.org_review_approve?.includes("dashboard") && verifiedRunNowClick(dirname(runs.runsFile),manual.request_id,schedule.id,input.controlPid ?? process.pid).ok
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


export interface PolicyAction {
 provenance: SchedulePolicy["provenance"];
 saved_by: SchedulePolicy["saved_by"];
}
/** A saved recipe is used only by run fires; v1 remains the rollback recipe. */
export function policySchedule(schedule: Schedule, policy: SchedulePolicy | undefined): Schedule {
 if (!policy) return schedule;
 const {skill, ...recipe} = policy.recipe;
 return {...schedule, project:policy.project, trigger:policy.trigger, job:{...recipe,...(skill ? {skill} : {})}};
}

/** Called inside Scheduler's lane after authenticated control/tool admission. */
export async function changePolicy(input: {op:"save"|"adopt"|"deactivate"; schedule:Schedule; runs:ScheduleRunStore; ledger:Ledger; mandates:import("./mandate.ts").MandateStore; context:MintContext; action:PolicyAction; now:Date; base?:number; draft?:SchedulePolicy; validate:(schedule:Schedule)=>void}): Promise<import("./viewer/schedule-run-core.ts").PolicyRecord> {
 const {schedule,runs,action,now} = input;
 const record = runs.policyRecord(schedule.id);
 const latest = record?.revisions.at(-1);
 if (schedule.job.delivery === "pipeline") throw new Error("pipeline schedules remain on per-fire grants");
 if (input.op !== "deactivate" && input.base !== (latest?.revision ?? 0)) throw new Error("Schedule changed; review updated settings");
 if (input.op === "deactivate" && runs.openRun(schedule.id)) throw new Error(`schedule ${schedule.id} has an open run; deactivate once it closes`);
 if ((input.op === "adopt" || (input.op === "save" && record?.active_revision == null)) && (runs.openRun(schedule.id) || (await input.ledger.list({labels:[`schedule:${schedule.id}`]})).length)) throw new Error(`schedule ${schedule.id} has an open legacy/run job; adopt once every job closes`);
 const used = action.provenance.quote_sha;
 if (used && record?.revisions.some(p=>p.provenance.quote_sha === used)) throw new Error("the operator message behind this quote was already used for this schedule");
 const seed = schedule.grant_template ? input.mandates.get(schedule.grant_template.seed_mandate_id) : undefined;
 const legacy = schedule.grant_template ? policyFromLegacy(schedule,schedule.grant_template,seed) : undefined;
 const baseline = latest ?? legacy;
 if (!baseline) throw new Error(`schedule ${schedule.id} has no saved policy or legacy template`);
 const draft = input.draft ?? baseline;
 const errors = schedulePolicyErrors(draft);
 if (errors.length) throw new Error(`invalid schedule policy: ${errors.join("; ")}`);
 if (draft.schedule_id !== schedule.id || draft.project !== schedule.project) throw new Error("policy must name this schedule and project");
 if (draft.recipe.delivery === "pipeline") throw new Error("pipeline schedules remain on per-fire grants");
 if (draft.effects.includes("org_review_approve") && !baseline.effects.includes("org_review_approve")) throw new Error("org-review approval requires the existing dashboard-only seed clearance");
 const policy:SchedulePolicy = {...structuredClone(draft),revision:(latest?.revision ?? 0)+1,saved_at:isoTimestamp(now),saved_by:action.saved_by,provenance:structuredClone(action.provenance),approval:structuredClone(baseline.approval)};
 input.validate(policySchedule(schedule,policy));
 const bounds = effectivePolicyBounds(policy,input.context,schedule.project,policy.recipe.kind,now);
 if (refused(bounds)) throw new Error(bounds.refusal);
 // Persist narrowed bounds, with provenance; a later ceiling increase cannot widen this save.
 policy.limits = bounds.limits; policy.exclusions = bounds.exclusions;
 if (input.op === "deactivate") return runs.deactivatePolicy(schedule.id,policy);
 return runs.savePolicyRevision(policy,{at:isoTimestamp(now),provenance:action.provenance});
}
