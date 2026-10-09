/** Read-only policy preview. Live narrowing mirrors effectivePolicyBounds; parity is pinned by HTTP tests. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { policyFromLegacy, schedulePolicyErrors, type SchedulePolicy } from "./schedule-policy.ts";
import { readSchedulePolicies } from "./schedule-run-core.ts";
import { readScheduleFile } from "./schedule-core.ts";
import type { SchedulePolicyResponse } from "./api-types.ts";

export function schedulePolicyView(stateDir: string, id: string): SchedulePolicyResponse {
 const schedule = readScheduleFile(join(stateDir,"schedules.json")).find(s=>s.id === id);
 if (!schedule) throw new Error(`no schedule ${id}`);
 const record = readSchedulePolicies(join(stateDir,"schedule-policies.json")).find(p=>p.schedule_id === id);
 const seedFile = schedule.grant_template ? join(stateDir,"mandates",`${schedule.grant_template.seed_mandate_id}.json`) : null;
 let seed;
 try { seed = seedFile && existsSync(seedFile) ? JSON.parse(readFileSync(seedFile,"utf8")) : undefined; }
 catch (error) { throw new Error(`legacy seed unreadable: ${(error as Error).message}`); }
 const legacy = schedule.grant_template ? policyFromLegacy(schedule,schedule.grant_template,seed) : null;
 const policy = record?.revisions.at(-1) ?? null;
 const selected = policy ?? legacy;
 const blocking:string[] = [];
 let effective:SchedulePolicyResponse["effective"] = null;
 if (!selected) blocking.push("no saved policy or legacy template; needs setup");
 else {
  blocking.push(...schedulePolicyErrors(selected));
  if (selected.recipe.delivery === "pipeline") blocking.push("pipeline schedules remain on per-fire grants");
  try {
   const dataDir = join(dirname(stateDir),"data");
   const defaultsFile = join(dataDir,"mandate-defaults.json"), projectsFile = join(dataDir,"projects.json");
   const defaults = existsSync(defaultsFile) ? JSON.parse(readFileSync(defaultsFile,"utf8")) : {token_ceiling:100_000_000,exclude_paths:[".github/workflows/","secrets/","**/.env*"]};
   const projects = existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile,"utf8")).projects : [];
   if (!Array.isArray(projects)) throw new Error("projects.json must hold projects");
   const project = projects.find((p: {name:string})=>p.name === schedule.project);
   if (!project) throw new Error(`project ${schedule.project} is not registered`);
   const ceiling = defaults.token_ceiling ?? 100_000_000;
   const homePaths = defaults.exclude_paths, projectPaths = project?.mandate?.exclude_paths ?? [];
   if (!Number.isSafeInteger(ceiling) || ceiling < 1 || !Array.isArray(homePaths) || !homePaths.every((p:unknown)=>typeof p === "string") || !Array.isArray(projectPaths) || !projectPaths.every((p:unknown)=>typeof p === "string")) throw new Error("invalid live policy bounds");
   const paths = [...new Set<string>([...(selected.exclusions.paths ?? []),...homePaths,...projectPaths])];
   if (paths.length > 32) blocking.push("live exclusions exceed 32 paths; none is dropped");
   if (selected.exclusions.job_kinds?.includes(selected.recipe.kind)) blocking.push(`policy excludes ${selected.recipe.kind} jobs`);
   const notes:string[] = [];
   if (selected.limits.tokens > ceiling) notes.push(`token cap clamped to the home's token_ceiling ${ceiling} (template ${selected.limits.tokens})`);
   const added = paths.filter(p=>!selected.exclusions.paths?.includes(p));
   if (added.length) notes.push(`exclusions add the live exclude_paths ${added.join(", ")}`);
   effective = {limits:{...selected.limits,tokens:Math.min(selected.limits.tokens,ceiling)},exclusions:{...selected.exclusions,paths},notes};
  } catch (error) { blocking.push(`live policy bounds unreadable: ${(error as Error).message}`); }
 }
 return {policy,active_revision:record?.active_revision ?? null,legacy,effective,blocking};
}
