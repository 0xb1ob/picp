import { isAbsolute, join, relative, sep } from "node:path";
import type { Ask, AwaitingDetail, AwaitingResponse, DecidedResponse, DecisionScreenResponse, DecisionsResponse } from "./api-types.ts";
import { listBoards } from "./boards.ts";
import { listOrRead, roots, resolveRootId } from "./explorer.ts";
import { dashboard } from "./fleet-view.ts";
import { jobArtifact, jobsView } from "./jobs-view.ts";
import { decisions } from "./overview-decisions.ts";
import { nonnegative, objectList, text, timestamp } from "./overview-read.ts";
import { fleetJobs, isSafeId, obj, readLedger, readObject, type ViewerState } from "./sessions.ts";

function screen(data: ReturnType<typeof decisions>, now: number): DecisionScreenResponse {
 const complete = data.askSource.availability !== "unavailable" && data.escalations.availability !== "unavailable";
 const today = data.decision_items.filter(d => d.today && d.source === "operator-delegated");
 return {
  generated_at:new Date(now).toISOString(),
  availability:{asks:data.askSource.availability, escalations:data.escalations.availability},
  awaiting_count:data.awaiting.count, parent_questions:data.parent_questions,
  decided_today:{count:complete ? today.length : null, worth_count:complete ? today.filter(d => d.worth.length).length : null},
 };
}
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The job a run path names, only when it is really under this home's state/runs and the viewer lists that job. */
function runUnderState(state: ViewerState, path: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const rel = relative(join(state.stateDir, "runs"), path);
	const id = rel.split(sep)[0];
	if (!id || rel.startsWith("..") || isAbsolute(rel) || !isSafeId(id)) return undefined;
	return fleetJobs(state).some((job) => job.job_id === id) || readLedger(state).has(id) ? id : undefined;
}

/** One evidence path as a viewer link: a report, a job's run (its artifact to read), or a file under a Files root. */
export function evidenceLink(state: ViewerState, path: string, project: string, boards: () => string[]): AwaitingDetail["evidence"][number] {
 const board = /(?:^|\/)boards\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/|$)/.exec(path)?.[1];
 if (board && boards().includes(board)) return {path, href:"#reports", read:`/boards/${board}/`};
 const run = runUnderState(state, path);
 if (run) return {path, href:`#job/${encodeURIComponent(run)}`, read:jobArtifact(state,run)?.href ?? null};
 for (const root of roots(state)) {
  const real = isAbsolute(path) ? resolveRootId(state,root.id) : undefined;
  const rel = real ? relative(real,path) : !isAbsolute(path) && root.id === `project:${project}` ? path : null;
  if (rel === null || rel.startsWith("..") || isAbsolute(rel) || !listOrRead(state,root.id,rel)) continue;
  return {path, href:`#files?${new URLSearchParams({root:root.id,path:rel})}`, read:null};
 }
 return {path, href:null, read:null};
}

/** Each open ask with what it takes to decide it: mandate, jobs, the parent's own escalation, evidence as links. */
export function askDetails(state: ViewerState, asks: Ask[], now = Date.now(), data = decisions(state,now)): AwaitingDetail[] {
 if (!asks.length) return [];
 const mandates = dashboard(state,now).mandates;
 const fleet = objectList(join(state.stateDir,"fleet.json"),"jobs", j => typeof j.job_id === "string" && isSafeId(j.job_id) && text(j.project));
 const jobs = asks.some(a => a.job_ids.length) ? jobsView(state,now).jobs : [];
 let slugs: string[] | undefined;
 const boards = () => slugs ??= listBoards(state).map(b => b.slug);
 return asks.map(ask => {
  const source = data.escalations.value.find(e => e.id === ask.source_escalation);
  const mandateId = text(source?.mandate_id) && /^md-[a-z0-9]{4,16}$/.test(source.mandate_id) ? source.mandate_id : null;
  const mandate = mandates.find(m => m.id === mandateId);
  const recorded = mandateId ? readObject(join(state.stateDir,"mandates",`${mandateId}.json`)) : undefined;
  const options = (Array.isArray(source?.options) ? source.options : []).map(obj);
  const recommended = text(source?.recommended) ? options.find(o => o?.id === source.recommended)?.label ?? source.recommended : null;
  return {...ask, reason:text(source?.mandate_clause) && source.mandate_clause !== "no mandate" ? source.mandate_clause : text(source?.kind) ? source.kind.replaceAll("_"," ") : null,
   source_created_at:timestamp(source?.created_at) ? source.created_at : null, mandate_id:mandateId,
   mandate_status:mandate ? mandate.expired_by_clock ? "expired" : mandate.status : null, spend:fleet.availability === "ok" ? mandate?.spend.usd ?? null : null, spend_cap:nonnegative(obj(recorded?.spend_cap)?.usd),
   mandate_objective:text(recorded?.objective) ? recorded.objective : mandate?.objective || null,
   jobs:ask.job_ids.map(id => { const j = jobs.find(job => job.id === id); return {id, title:j?.title ?? null, phase:j?.phase ?? null, model:j?.model ?? null, cost_usd:j?.cost_usd ?? null, pr_url:j?.pr_url ?? null, ci:j?.ci ?? null, review:j?.review ?? null}; }),
   escalation:source ? {id:String(source.id), kind:text(source.kind) ? source.kind : null, question:String(source.question), recommended:typeof recommended === "string" ? recommended : null,
    differs:text(source.recommended) && !same(source.recommended,ask.recommendation) && !same(recommended,ask.recommendation)} : null,
   evidence:ask.evidence_paths.map(path => evidenceLink(state,path,ask.project,boards))};
 });
}
export function awaitingScreen(state: ViewerState, now = Date.now()): AwaitingResponse {
 const data = decisions(state,now);
 return {...screen(data,now), items:askDetails(state,data.awaiting.items,now,data)};
}
export function decidedScreen(state: ViewerState, now = Date.now()): DecidedResponse {
 const data = decisions(state,now);
 return {...screen(data,now), items:data.decision_items};
}
export function decisionsScreen(state: ViewerState, now = Date.now()): DecisionsResponse {
 const data = decisions(state,now);
 return {...screen(data,now), items:askDetails(state,data.awaiting.items,now,data), decided:data.decision_items};
}
