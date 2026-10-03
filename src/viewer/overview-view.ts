import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { OverviewResponse } from "./api-types.ts";
import { dashboard } from "./fleet-view.ts";
import { roots } from "./explorer.ts";
import { isSafeId, obj, readObject, runtimeRoot, str, type Json, type ViewerState } from "./sessions.ts";
import { decisions } from "./overview-decisions.ts";
import { blocked, closedToday, failedJobs, flights, shipped } from "./overview-jobs.ts";
import { health, quota } from "./overview-health.ts";
import { LEDGER_STATUSES, nonnegative, objectList, parseObject, readBounded, source, strings, text, timestamp } from "./overview-read.ts";
import { operatorSession, readInbox } from "./control-inbox.ts";

export function overview(state: ViewerState, now = Date.now(), isAlive?: (pid: number) => boolean): OverviewResponse {
 const decision = decisions(state, now);
 const fleet = objectList(join(state.stateDir,"fleet.json"),"jobs", j => typeof j.job_id === "string" && isSafeId(j.job_id) && text(j.project) && ["waiting","held","done","failed","launching"].includes(String(j.phase)));
 const ledger = objectList(join(runtimeRoot(state.home),"jobs.json"),"jobs", j => typeof j.id === "string" && isSafeId(j.id) && LEDGER_STATUSES.includes(String(j.status)) && (j.blocked_by === undefined || (Array.isArray(j.blocked_by) && j.blocked_by.every(id => typeof id === "string" && isSafeId(id)))));
 const grants = source<Json[]>(() => readdirSync(join(state.stateDir,"mandates")).filter(n => /^md-[A-Za-z0-9_-]+\.json$/.test(n)).map(name => {
  const grant = parseObject(readBounded(join(state.stateDir,"mandates",name)));
  if (!grant || !text(grant.id) || !["active","paused","revoked","expired"].includes(String(grant.status)) || !timestamp(grant.expiry) || !timestamp(grant.issued_at) || !Array.isArray(grant.projects) || !grant.projects.every(text) || !obj(grant.spend_cap)) throw new Error("invalid mandate");
  return grant;
 }).sort((a,b) => String(a.issued_at).localeCompare(String(b.issued_at))), []);
 const availability = {asks:decision.askSource.availability, escalations:decision.escalations.availability, fleet:fleet.availability, ledger:ledger.availability, mandates:grants.availability};
 // One dashboard read for the whole page: accounting, in-flight rows and Landed today's costs (every finished row, as the Jobs list).
 const board = dashboard(state,now,Infinity); const accounting = board.mandates; const rows = board.projects.flatMap(p => p.jobs);
 const items = grants.value.filter(m => m.status === "active" || m.status === "paused").map(m => {
  const row = accounting.find(a => a.id === m.id);
  return {id:String(m.id), status:Date.parse(String(m.expiry)) <= now ? "expired" : String(m.status), projects:strings(m.projects), objective:str(m.objective) ?? "", expiry:String(m.expiry), pause_reason:str(m.pause_reason) ?? null,
   ask_on:strings(m.ask_on).filter(a => ["plan_approval","merge","risk:high"].includes(a)), spend_cap:{usd:nonnegative(obj(m.spend_cap)?.usd),tokens:nonnegative(obj(m.spend_cap)?.tokens)}, job_cap:nonnegative(m.job_cap), dispatch_parallelism:nonnegative(m.dispatch_parallelism),
   spend:fleet.availability === "unavailable" ? null : row?.spend ?? null};
 });
 const count = (predicate: (m: Json) => boolean) => grants.availability === "unavailable" ? null : grants.value.filter(predicate).length;
 const accessible = roots(state);
 return {
  generated_at:new Date(now).toISOString(), availability,
  awaiting:decision.awaiting, parent_questions:decision.parent_questions, decided_today:decision.decided_today,
  all_questions_delegated:decision.all_questions_delegated,
  in_flight:flights(state,fleet.value,decision.escalations.value,now,rows), shipped_today:shipped(state,fleet.value,ledger.value,now,rows),
  closed_today:fleet.availability === "unavailable" || ledger.availability === "unavailable" ? null : closedToday(state,fleet.value,ledger.value,now),
  blocked:blocked(ledger.value,grants.value,fleet.value,now,ledger.availability !== "unavailable" && grants.availability !== "unavailable"),
  failed:failedJobs(state,fleet.value,ledger.value), main_ci:mainCi(state),
  mandates:{active_count:count(m => m.status === "active" && Date.parse(String(m.expiry)) > now), paused_count:count(m => m.status === "paused"), paused_projects:[...new Set(grants.value.filter(m => m.status === "paused").flatMap(m => strings(m.projects)))], revoked_hidden_count:count(m => m.status === "revoked"), items},
  fleet:{...health(state,fleet.value,now,fleet.availability !== "unavailable",isAlive), operator:operatorHealth(state,isAlive)}, services:services(state), quota:quota(state,fleet.value),
  navigation:{project_count:accessible.filter(r => r.kind === "project").length, worktree_count:accessible.filter(r => r.kind === "worktree").length},
  warnings:Object.entries(availability).filter(([,v]) => v === "unavailable").map(([section]) => ({section,message:"Recorded data is unavailable or malformed."})),
 };
}
/** cp-daemon P3: the operator session's record probed, plus the inbox messages held for it. */
function operatorHealth(state: ViewerState, isAlive?: (pid: number) => boolean): OverviewResponse["fleet"]["operator"] {
 const session = operatorSession(state.stateDir, isAlive);
 const inbox = readInbox(state.stateDir);
 return {running:session.running, pid:session.pid, since:session.since, held:inbox.error ? null : inbox.held.length};
}
/** The watchdog's own record (`state/health.json`, cp-health.service); read leniently, null when it never ran. */
function services(state: ViewerState): OverviewResponse["services"] {
 const record = readObject(join(state.stateDir,"health.json"));
 const checks = obj(record?.checks);
 if (!record || !timestamp(record.last_run_at) || !checks) return {health:null};
 const failing = Object.entries(checks).flatMap(([check,value]) => { const row = obj(value); return row?.status === "fail" ? [{check, detail:str(row.detail) ?? ""}] : []; });
 return {health:{last_run_at:String(record.last_run_at), failing}};
}
/**
 * Audit P3 #19: `state/main-ci.json` (src/main-ci.ts `MainCiStore`), re-derived here because viewer modules import
 * nothing outside `src/viewer/` (tests/viewer-workbench.test.ts). One row per project whose main is latched red; a
 * malformed row makes the whole file unavailable, the way the store's own schema read does, never a silent no-latch.
 */
function mainCi(state: ViewerState): OverviewResponse["main_ci"] {
 const rows = objectList(join(state.stateDir,"main-ci.json"),"projects", r => text(r.project) && typeof r.red_since_sha === "string" && /^[0-9a-f]{7,64}$/.test(r.red_since_sha) && timestamp(r.red_since_at));
 return {availability:rows.availability, red:rows.value.map(r => ({project:String(r.project), red_since_sha:String(r.red_since_sha), red_since_at:String(r.red_since_at), workflow:str(r.workflow) ?? null, failing:str(r.failing) ?? null}))};
}
