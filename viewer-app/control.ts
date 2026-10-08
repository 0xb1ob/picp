import type { ControlSendResponse, ControlStatusResponse, OperatorStartResponse, OperatorUploadResponse } from "../src/viewer/api-types.ts";
import type { Restarting } from "./restart-control.ts";

/** Dashboard control (cp-dashboard-operator-control): what the Full transcript's composer and decision cards can say and do. */
export const CONTROL_STATUS_URL = "/api/operator/control";
export const CONTROL_MESSAGE_URL = "/api/operator/message";
export const OPERATOR_START_URL = "/api/operator/start";
export const CONTROL_TEXT_MAX = 16_000;
/** How long Start session waits for the new session to serve dashboard control. */
export const START_WAIT_MS = 60_000;
export type Launcher = "herdr" | "tmux";
/** Where to find the started session, per mode: the text, then the part shown as code. */
export const START_HINTS: Record<Launcher, [string, string]> = {herdr: ["open herdr → workspace", "cp-operator"], tmux: ["attach from a terminal:", "tmux attach -t cp-operator"]};
/** Image attachments: the server's limits (src/viewer/uploads.ts, which the browser bundle never imports) as client pre-checks. */
export const OPERATOR_UPLOAD_URL = "/api/operator/upload";
export const uploadUrl = (id: string): string => `/api/operator/uploads/${encodeURIComponent(id)}`;
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_PER_MESSAGE = 8;
export const TEXT_UPLOAD_MAX_BYTES = 1024 * 1024;
export const isTextFile = (file: {name: string}): boolean => /\.(txt|md|html|json)$/i.test(file.name);
export const attachmentSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export type ControlBody = {kind: "message"; text: string; deliver?: "followUp" | "steer"; images?: string[]; files?: string[]; thread?: string} | {kind: "answer"; ask_id: string; label: string; thread?: string} | {kind: "abort"};
export type ControlStatus = ControlStatusResponse | {error: string};
export interface Delivery { id: string | null; state: "sending" | "queued" | "delivered" | "held" | "failed"; reason: string | null; ask_id: string | null }
/** Start session: offline → starting (polling the status) → running, or failed with the reason. */
export interface Starting { state: "starting" | "running" | "failed"; reason: string | null; via?: Launcher }
/** `send`'s `ask_id` ties a free-text reply to its decision card; an answer body carries its own. `upload` only while the session takes images. */
export interface ControlView { status: ControlStatus | null; delivery: Delivery | null; send(body: ControlBody, ask_id?: string): void; starting?: Starting | null; start?(via: Launcher, resume?: boolean): void; restarting?: Restarting | null; restart?(): void; upload?(file: File): Promise<OperatorUploadResponse | {error: string}> }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function failure(response: Response): Promise<string> {
 try { const body = await response.json() as {error?: unknown}; if (typeof body.error === "string") return body.error; } catch { /* no JSON body: the status says enough */ }
 return `HTTP ${response.status}`;
}

export async function readControl(fetch: Fetch, signal?: AbortSignal): Promise<ControlStatus> {
 try {
  const response = await fetch(CONTROL_STATUS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as ControlStatusResponse : {error: await failure(response)};
 } catch {
  return {error: "Dashboard control status unavailable"};
 }
}

export async function sendControl(fetch: Fetch, token: string, body: ControlBody): Promise<ControlSendResponse | {error: string; status: number}> {
 let response: Response;
 try {
  response = await fetch(CONTROL_MESSAGE_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify(body)});
 } catch {
  return {error: "Could not reach this home", status: 0};
 }
 if (response.status === 202) return await response.json() as ControlSendResponse;
 return {error: await failure(response), status: response.status};
}

/** The page may send: control on, and either a session serving it (its token) or none (held, the inbox token). */
export const controlReady = (status: ControlStatus | null | undefined): status is ControlStatusResponse =>
 !!status && !("error" in status) && status.enabled && ((status.running && !!status.token) || (status.offline && !!status.inbox_token));

/** The token a send carries: the session's CSRF token, or this viewer's inbox token while offline. */
export const controlToken = (status: ControlStatusResponse): string => status.token ?? status.inbox_token ?? "";

/** Attachments: a running session whose bridge takes images (`images: true`); never while offline, nothing is held. */
export const controlImages = (status: ControlStatus | null | undefined): boolean =>
 controlReady(status) && status.running && !!status.token && status.images === true;
export const controlFiles = (status: ControlStatus | null | undefined): boolean =>
 controlReady(status) && status.running && !!status.token && status.files === true;

/** Why the next attachment is refused, or null. HEIC is named, since iPhones make it. */
export function attachRefusal(file: {name: string; type: string; size: number}, count: number): string | null {
 if (count >= UPLOAD_MAX_PER_MESSAGE) return `At most ${UPLOAD_MAX_PER_MESSAGE} attachments per message`;
 if (isTextFile(file)) return file.size > TEXT_UPLOAD_MAX_BYTES ? `${file.name} is larger than 1 MiB` : null;
 if (/^image\/hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) return "HEIC/HEIF is not supported; share the photo as JPEG";
 if (!UPLOAD_TYPES.includes(file.type)) return `${file.name || "This file"} is not a PNG, JPEG, WebP or GIF image or a .txt, .md, .html or .json file`;
 if (file.size > UPLOAD_MAX_BYTES) return `${file.name || "This image"} is larger than 10 MiB`;
 return null;
}

/** `POST /api/operator/upload`: the file's bytes with its own type and the session's token; the stored id, or the refusal. */
export async function uploadImage(fetch: Fetch, token: string, file: File): Promise<OperatorUploadResponse | {error: string}> {
 let response: Response;
 try {
  response = await fetch(OPERATOR_UPLOAD_URL, {method: "POST", headers: {"content-type": isTextFile(file) ? "application/octet-stream" : file.type, "x-cp-control-token": token, "x-cp-upload-name": encodeURIComponent(file.name)}, body: file});
 } catch {
  return {error: "Could not reach this home"};
 }
 if (response.status === 201) return await response.json() as OperatorUploadResponse;
 return {error: await failure(response)};
}

/** Offline, and Start session can work here. */
export const canStart = (status: ControlStatus | null | undefined): status is ControlStatusResponse =>
 !!status && !("error" in status) && status.enabled && status.offline && !!status.inbox_token && !status.start_unavailable;

/** The launchers Start session offers, herdr first; none when it cannot start. */
export const startLaunchers = (status: ControlStatus | null | undefined): Launcher[] =>
 canStart(status) ? (["herdr", "tmux"] as const).filter(via => status.launchers?.[via]) : [];

/** The launchers Resume last session offers (`cp-operator -c`: pi continues this home's last session, or starts fresh when none). */
export const resumeLaunchers = (status: ControlStatus | null | undefined): Launcher[] =>
 canStart(status) ? (["herdr", "tmux"] as const).filter(via => status.resume?.[via]) : [];

/** The one line the composer shows about the session. */
export function controlLine(status: ControlStatus | null | undefined): string {
 if (!status) return "Checking dashboard control";
 if ("error" in status) return `Not available: ${status.error}`;
 if (!status.enabled) return status.reason ?? "Dashboard control is off";
 if (status.offline) return `Operator session offline${status.held ? ` · ${status.held} held` : ""} — a message waits here until a session attaches`;
 if (!status.running || !status.token) return status.reason ?? "Session not running";
 return status.busy ? "Session busy — send after this turn, steer, or abort" : "Ready";
}

/** The mobile top bar's tiny status chip: busy, idle or not running, then the last send's delivery state. */
export function controlChip(status: ControlStatus | null | undefined, delivery: Delivery | null): string {
 const state = !status ? "checking" : "error" in status ? "unavailable" : !status.enabled ? "off" : status.offline ? "offline" : controlReady(status) ? (status.busy ? "busy" : "idle") : "not running";
 return delivery ? `${state} · ${delivery.state}` : state;
}

/** `POST /api/operator/start` `{"via": …}` (plus `"resume": true`) with the inbox token; the reply's state, or the refusal as an error. */
export async function startOperator(fetch: Fetch, token: string, via: Launcher, resume = false): Promise<OperatorStartResponse | {error: string}> {
 try {
  const response = await fetch(OPERATOR_START_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify(resume ? {via, resume: true} : {via})});
  const body = await response.json().catch(() => ({})) as Partial<OperatorStartResponse> & {error?: unknown};
  if (body.state === "starting" || body.state === "already_running" || body.state === "unavailable") return {state: body.state, ...(typeof body.reason === "string" ? {reason: body.reason} : typeof body.error === "string" ? {reason: body.error} : {})};
  return {error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`};
 } catch {
  return {error: "Could not reach this home"};
 }
}

/** Start session's one line: why it cannot, what it is doing, or how it went. */
export function startLine(status: ControlStatus | null | undefined, starting: Starting | null | undefined): string {
 if (starting?.state === "starting") return "Starting the operator session… the composer opens when it serves the dashboard";
 if (starting?.state === "running") return "Operator session running";
 if (starting?.state === "failed") return `Start failed: ${starting.reason ?? "unknown"}`;
 if (status && !("error" in status) && status.offline && status.start_unavailable) return `Start session unavailable: ${status.start_unavailable}`;
 return "Starting a session spends model tokens";
}

/** The delivery line: Sending, Queued, Delivered, or Failed with the reason; a delivered send's own reason (an unfiled thread) follows it. */
export function deliveryLine(delivery: Delivery | null): string {
 if (!delivery) return "";
 if (delivery.state === "failed") return `Failed: ${delivery.reason ?? "unknown"}`;
 const label = {sending: "Sending", queued: "Queued", delivered: "Delivered to the session", held: "Held until an operator session attaches"}[delivery.state];
 return [label, delivery.id, delivery.reason].filter(Boolean).join(" · ");
}
