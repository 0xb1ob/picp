import type { OperatorRestartResponse } from "../src/viewer/api-types.ts";
import type { ControlStatus } from "./control.ts";

/** Restart session (cp-aqxl): the session stops itself after its checks; its cp-operator relaunches the same session file. */
export const OPERATOR_RESTART_URL = "/api/operator/restart";
/** How long the page waits for the relaunched session to serve the dashboard. */
export const RESTART_WAIT_MS = 90_000;
export const RESTART_LOOK = "check the operator terminal (herdr workspace cp-operator / tmux attach -t cp-operator), or use Resume last session";
/** Restarting (the POST) → stopping (same session still serves) → relaunching (offline) → restarted (a new session); or refused / failed. */
export interface Restarting { state: "restarting" | "stopping" | "relaunching" | "restarted" | "refused" | "failed"; reason: string | null; started_at: string | null; session_file: string | null }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The page is waiting on the restart: the POST, or the poll after its 202. */
export const restartInFlight = (restarting: Restarting | null | undefined): boolean =>
 restarting?.state === "restarting" || restarting?.state === "stopping" || restarting?.state === "relaunching";

/** `POST /api/operator/restart` `{"restart": true}` with the session's CSRF token: the 202, or the refusal with its status. */
export async function restartOperator(fetch: Fetch, token: string): Promise<OperatorRestartResponse | {error: string; status: number}> {
 try {
  const response = await fetch(OPERATOR_RESTART_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify({restart: true})});
  const body = await response.json().catch(() => ({})) as Partial<OperatorRestartResponse> & {error?: unknown};
  if (response.status === 202 && body.state === "restarting" && typeof body.id === "string") return {state: "restarting", id: body.id, session_file: typeof body.session_file === "string" ? body.session_file : null};
  return {error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`, status: response.status};
 } catch {
  return {error: "Could not reach this home", status: 0};
 }
}

/** Why Restart session cannot be used now, or null when it can. */
export function restartDisabled(status: ControlStatus | null | undefined): string | null {
 if (!status || "error" in status || !status.enabled || !status.running || !status.token) return "no operator session is running";
 const restart = status.restart;
 if (!restart) return "this dashboard did not report whether the session can restart; reload the page";
 if (!restart.supported) return restart.reason ?? "this session cannot restart from the dashboard";
 if (restart.blockers.length) return `not now: ${restart.blockers.join("; ")}`;
 return null;
}

/** Restart session's one line: how the restart goes, or why it cannot, or what it does. */
export function restartLine(status: ControlStatus | null | undefined, restarting: Restarting | null | undefined): string {
 const file = restarting?.session_file ?? "the same session";
 if (restarting?.state === "restarting") return "Restarting…";
 if (restarting?.state === "stopping") return "Stopping the session… it stops once its turn and compaction are done";
 if (restarting?.state === "relaunching") return `Relaunching · resumes ${file}`;
 if (restarting?.state === "restarted") return `Operator session restarted · ${file}`;
 if (restarting?.state === "refused") return `Refused: ${restarting.reason ?? "unknown"}`;
 if (restarting?.state === "failed") return `Failed: ${restarting.reason ?? "unknown"}`;
 return restartDisabled(status) ?? "Restart stops this session and resumes the same session file in its terminal";
}
