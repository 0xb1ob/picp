import type { FilesResponse } from "./api-types.ts";
import { listOrRead, roots } from "./explorer.ts";
import { jobDetail, readMandates } from "./fleet-view.ts";
import type { ViewerState } from "./sessions.ts";

export function filesView(state: ViewerState, rootId: string | null, path: string, now=Date.now()): FilesResponse | undefined {
 const mandates=readMandates(state);
 const available=roots(state).map(root=>{
  const job=root.job_id ? jobDetail(state,root.job_id) : undefined;
  return {...root,phase:job?.phase === "waiting" ? job.run_phase ?? "waiting" : job?.phase ?? null,head:job?.head ?? null,pr_url:job?.pr_url ?? null,paused:mandates.some(m=>m.status === "paused" && Array.isArray(m.projects) && m.projects.includes(root.project))};
 });
 const selected=rootId ?? available[0]?.id ?? null;
 if (rootId && !available.some(root=>root.id===rootId)) return undefined;
 const listing=selected ? listOrRead(state,selected,path) : null;
 if (selected && !listing) return undefined;
 return {generated_at:new Date(now).toISOString(),roots:available,selected,path,listing:listing ?? null};
}
