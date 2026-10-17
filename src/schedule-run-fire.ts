/** Operator activation of saved policies, serialized by Scheduler; native runs start through src/schedule-native.ts. */
import { isoTimestamp } from "./contracts.ts";
import { effectivePolicyBounds } from "./schedule-policy.ts";
import { refused, type MintContext } from "./schedule-grant.ts";
import type { Ledger } from "./ledger.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import { isNativePolicy, nativePolicyDraft, schedulePolicyErrors, type SchedulePolicy } from "./viewer/schedule-policy.ts";
import type { Schedule } from "./viewer/schedule-core.ts";

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
export async function changePolicy(input: {op:"save"|"adopt"|"deactivate"; schedule:Schedule; runs:ScheduleRunStore; ledger:Ledger; mandates:import("./mandate.ts").MandateStore; context?:MintContext; action:PolicyAction; now:Date; base?:number; draft?:SchedulePolicy; validate:(schedule:Schedule)=>void}): Promise<import("./viewer/schedule-run-core.ts").PolicyRecord> {
 const {schedule,runs,action,now} = input;
 const record = runs.policyRecord(schedule.id);
 const latest = record?.revisions.at(-1);
 if (input.op !== "deactivate" && input.base !== (latest?.revision ?? 0)) throw new Error("Schedule changed; review updated settings");
 if (input.op === "deactivate" && runs.openRun(schedule.id)) throw new Error(`schedule ${schedule.id} has an open run; deactivate once it closes`);
 if ((input.op === "adopt" || (input.op === "save" && record?.active_revision == null)) && (runs.openRun(schedule.id) || (await input.ledger.list({labels:[`schedule:${schedule.id}`]})).length)) throw new Error(`schedule ${schedule.id} has an open legacy/run job; adopt once every job closes`);
 const used = action.provenance.quote_sha;
 if (used && record?.revisions.some(p=>p.provenance.quote_sha === used)) throw new Error("the operator message behind this quote was already used for this schedule");
 const given = input.draft ?? latest;
 // The editor opens a legacy schedule on its read-only snapshot: the operator's save re-expresses it, narrowest, natively.
 const draft = input.op === "save" && given && !isNativePolicy(given) ? nativePolicyDraft({schedule_id:given.schedule_id,project:given.project,recipe:given.recipe,recipe_config:given.recipe_config,trigger:given.trigger,limits:given.limits,model_policy:given.model_policy,exclusions:given.exclusions}, {revision:given.revision,saved_at:given.saved_at,saved_by:given.saved_by,provenance:given.provenance}) : given;
 if (!draft) throw new Error(`schedule ${schedule.id} has no saved policy; save a native one`);
 // Legacy grant-shaped revisions stay readable for audit and open runs, but none is adopted again.
 if (input.op !== "deactivate" && !isNativePolicy(draft)) throw new Error("only a native policy revision is saved or adopted; a legacy grant-shaped revision is read-only");
 const errors = schedulePolicyErrors(draft);
 if (errors.length) throw new Error(`invalid schedule policy: ${errors.join("; ")}`);
 if (draft.schedule_id !== schedule.id || draft.project !== schedule.project) throw new Error("policy must name this schedule and project");
 const policy:SchedulePolicy = {...structuredClone(draft),revision:(latest?.revision ?? 0)+1,saved_at:isoTimestamp(now),saved_by:action.saved_by,provenance:structuredClone(action.provenance)};
 // Deactivation removes authority: no new run starts until a native revision is adopted; open runs drain.
 if (input.op === "deactivate") return runs.deactivatePolicy(schedule.id,policy);
 if (!input.context) throw new Error("live policy bounds are not wired");
 input.validate(policySchedule(schedule,policy));
 const bounds = effectivePolicyBounds(policy,input.context,schedule.project,policy.recipe.kind,now);
 if (refused(bounds)) throw new Error(bounds.refusal);
 // Persist narrowed bounds, with provenance; a later ceiling increase cannot widen this save.
 policy.limits = bounds.limits; policy.exclusions = bounds.exclusions;
 return runs.savePolicyRevision(policy,{at:isoTimestamp(now),provenance:action.provenance});
}
