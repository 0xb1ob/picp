import type { ScheduleControlRequestView, ScheduleControlSendResponse, ScheduleControlStatusResponse } from "../src/viewer/api-types.ts";

/** Schedules page controls (cp-hhuf P6): enable, disable, run now and remove, journaled for the parent to apply. */
export const SCHEDULE_CONTROL_STATUS_URL = "/api/schedules/control";
export const SCHEDULE_CONTROL_URL = "/api/schedules/request";
export type ScheduleOp = ScheduleControlRequestView["op"];
export type ScheduleControlStatus = ScheduleControlStatusResponse | {error: string};
export interface ScheduleControlView {
 status: ScheduleControlStatus | null;
 sending: {schedule_id: string; op: ScheduleOp} | null;
 failed: {schedule_id: string; reason: string} | null;
 request(op: ScheduleOp, scheduleId: string): void;
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

export async function sendScheduleControl(fetch: Fetch, token: string, body: {op: ScheduleOp; schedule_id: string}): Promise<ScheduleControlSendResponse | {error: string; status: number}> {
 let response: Response;
 try {
  response = await fetch(SCHEDULE_CONTROL_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify({op: body.op, schedule_id: body.schedule_id})});
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

/** One request's state as the page says it. */
export function requestLine(request: ScheduleControlRequestView): string {
 const op = OP_LABEL[request.op];
 switch (request.state) {
  case "queued": return `Queued · ${op} · ${request.id} — the parent applies it within seconds`;
  case "applying": return `Applying · ${op} · ${request.id}`;
  case "done": return request.op === "run_now" ? `Run accepted${request.job_id ? ` · ${request.job_id}` : ""}` : `Done · ${op}${request.job_id ? ` → ${request.job_id}` : ""}`;
  case "refused": return `Refused: ${request.reason ?? "unknown"}`;
  case "expired": return `Expired: ${request.reason ?? "not applied"}`;
  case "interrupted": return `Interrupted: ${request.reason ?? "check the schedule"}`;
 }
}
