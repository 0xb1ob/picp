import type { ScheduleControlRequestView, ScheduleControlSendResponse, ScheduleControlStatusResponse, SchedulePolicyResponse } from "../src/viewer/api-types.ts";
import type { SchedulePolicy } from "../src/viewer/schedule-policy.ts";

/** Schedules page controls (cp-hhuf P6): enable, disable, run now and remove, journaled for the parent to apply. */
export const SCHEDULE_CONTROL_STATUS_URL = "/api/schedules/control";
export const SCHEDULE_CONTROL_URL = "/api/schedules/request";
export type ScheduleOp = ScheduleControlRequestView["op"];
export type ScheduleControlStatus = ScheduleControlStatusResponse | {error: string};
export interface ScheduleControlView {
 status: ScheduleControlStatus | null;
 sending: {schedule_id: string; op: ScheduleOp} | null;
 failed: {schedule_id: string; reason: string} | null;
 /** `extra` carries the revision a revision-bound op expects, and the draft of `save_policy`. */
 request(op: ScheduleOp, scheduleId: string, extra?: ScheduleRequestExtra): void;
 /** Ids of requests this browser already sent (kept across reloads); never resent. */
 receipts?: string[];
}
export interface ScheduleRequestExtra {revision?: number; policy?: SchedulePolicy}
export type ScheduleRequestBody = {op: ScheduleOp; schedule_id: string; client_id?: string} & ScheduleRequestExtra;
/** `sk-<14 digits>-<8 hex>`: one id per click, so a repeated POST is answered with the first receipt. */
export function scheduleClientId(now = new Date(), random: () => number = Math.random): string {
 return `sk-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.floor(random() * 0x100000000).toString(16).padStart(8, "0")}`;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Add schedule… prefills the composer with this: a schedule needs its own grant, issued only on the operator's words. */
export const ADD_SCHEDULE_DRAFT = "Add a schedule (cp_schedule add): name \"…\", project \"…\", cron \"0 9 * * *\" tz \"UTC\" (or a watch script), kind research, delivery answer, title \"…\", description \"…\". Issue its own schedule grant first (cp_mandate issue with schedule_grant:true).";

async function failure(response: Response): Promise<string> {
 try { const body = await response.json() as {error?: unknown}; if (typeof body.error === "string") return body.error; } catch { /* no JSON body: the status says enough */ }
 return `HTTP ${response.status}`;
}

export async function readScheduleControl(fetch: Fetch, signal?: AbortSignal): Promise<ScheduleControlStatus> {
 try {
  const response = await fetch(SCHEDULE_CONTROL_STATUS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as ScheduleControlStatusResponse : {error: await failure(response)};
 } catch {
  return {error: "Schedule controls status unavailable"};
 }
}

export async function sendScheduleControl(fetch: Fetch, token: string, body: ScheduleRequestBody): Promise<ScheduleControlSendResponse | {error: string; status: number}> {
 let response: Response;
 try {
  const wire = {op: body.op, schedule_id: body.schedule_id, ...(body.revision !== undefined ? {revision: body.revision} : {}), ...(body.policy ? {policy: body.policy} : {}), ...(body.client_id ? {client_id: body.client_id} : {})};
  response = await fetch(SCHEDULE_CONTROL_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify(wire)});
 } catch {
  return {error: "Could not reach this home", status: 0};
 }
 if (response.status === 202) return await response.json() as ScheduleControlSendResponse;
 return {error: await failure(response), status: response.status};
}

/** A status the route answered (it carries its own `error` for an unreadable journal), not a fetch failure. */
const answered = (status: ScheduleControlStatus | null | undefined): status is ScheduleControlStatusResponse => status != null && "enabled" in status;

/** The page may send: control on, the token served, and a parent holding the home. */
export const scheduleControlReady = (status: ScheduleControlStatus | null | undefined): status is ScheduleControlStatusResponse =>
 answered(status) && status.error === null && status.enabled && status.token !== null && status.parent.running;

/** The one line the page shows about its controls. */
export function scheduleControlLine(status: ScheduleControlStatus | null | undefined): string {
 if (!status) return "Checking schedule controls";
 if (!answered(status) || status.error) return `Controls not available: ${status.error}`;
 if (!status.enabled) return status.reason ?? "Dashboard control is off";
 if (!status.parent.running) return status.reason ?? `Parent not running: ${status.parent.reason}`;
 return "Controls ready: the parent applies each request within seconds, under the schedule's own grant";
}

/** The newest request for one schedule. */
export const latestRequest = (status: ScheduleControlStatus | null | undefined, scheduleId: string): ScheduleControlRequestView | undefined =>
 answered(status) ? [...status.requests].reverse().find(r => r.schedule_id === scheduleId) : undefined;

const OP_LABEL: Record<ScheduleOp, string> = {enable: "Enable", disable: "Disable", run_now: "Run now", remove: "Remove", save_policy: "Save settings", adopt: "Adopt", deactivate: "Deactivate"};

/** A done run_now that created a job: the page links "view run" to it. Accepted only: the run has not finished. */
export const acceptedRunJob = (request: ScheduleControlRequestView): string | null => request.op === "run_now" && request.state === "done" ? request.job_id : null;

/** One request's state as the page says it. */
export function requestLine(request: ScheduleControlRequestView): string {
 const op = OP_LABEL[request.op];
 switch (request.state) {
  case "queued": return `Request queued · ${request.op} · ${request.id}`;
  case "applying": return request.op === "run_now" ? "Starting run…" : `Applying · ${op} · ${request.id}`;
  case "done":
   if (request.op === "run_now") return request.job_id ? `Run accepted · ${request.job_id} · view run` : "Run accepted";
   if (request.op === "deactivate") return "Back on per-fire grants";
   if (request.op === "save_policy" || request.op === "adopt") return request.reason ?? "Settings saved (applies to the next run)";
   return `Done · ${op}${request.job_id ? ` → ${request.job_id}` : ""}`;
  case "refused": return `Refused: ${request.reason ?? "unknown"}`;
  case "expired": return `Expired: ${request.reason ?? "not applied"}`;
  case "interrupted": return `Interrupted: ${request.reason ?? "check the schedule"}`;
 }
}

export const SCHEDULE_POLICY_URL = "/api/schedules/policy";
/** `GET /api/schedules/policy`: pure read; a failure is a named error, never "ready". */
export async function readSchedulePolicy(fetch: Fetch, scheduleId: string, signal?: AbortSignal): Promise<SchedulePolicyResponse | {error: string}> {
 try {
  const response = await fetch(`${SCHEDULE_POLICY_URL}?schedule_id=${encodeURIComponent(scheduleId)}`, signal ? {signal} : {});
  return response.ok ? await response.json() as SchedulePolicyResponse : {error: await failure(response)};
 } catch {
  return {error: "Schedule policy unavailable"};
 }
}

/** The readiness line: from the server's `blocking` list; unknown is never "Ready". */
export function readinessLine(policy: SchedulePolicyResponse | {error: string} | null | undefined): string {
 if (!policy) return "Checking readiness";
 if ("error" in policy) return `Blocked: ${policy.error}`;
 return policy.blocking.length ? `Blocked: ${policy.blocking.join("; ")}` : "Ready";
}
