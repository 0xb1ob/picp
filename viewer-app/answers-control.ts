import type { AnswerAckResponse, AnswersControlStatusResponse } from "../src/viewer/api-types.ts";

/** Answers to acknowledge (cp-mxk4): one tick appends an `acked` line; it reaches no session and no parent. */
export const ANSWERS_CONTROL_STATUS_URL = "/api/answers/control";
export const ANSWER_ACK_URL = "/api/answers/ack";
export type AnswersControlStatus = AnswersControlStatusResponse | {error: string};
export interface AnswersControlView {
 status: AnswersControlStatus | null;
 /** The id being acknowledged now. */
 sending: string | null;
 failed: {id: string; reason: string} | null;
 /** Ids acknowledged in this tab: hidden at once, before the next refresh drops them. */
 acked: readonly string[];
 ack(id: string): void;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function failure(response: Response): Promise<string> {
 try { const body = await response.json() as {error?: unknown}; if (typeof body.error === "string") return body.error; } catch { /* no JSON body: the status says enough */ }
 return `HTTP ${response.status}`;
}

export async function readAnswersControl(fetch: Fetch, signal?: AbortSignal): Promise<AnswersControlStatus> {
 try {
  const response = await fetch(ANSWERS_CONTROL_STATUS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as AnswersControlStatusResponse : {error: await failure(response)};
 } catch {
  return {error: "Acknowledge status unavailable"};
 }
}

export async function sendAnswerAck(fetch: Fetch, token: string, id: string): Promise<AnswerAckResponse | {error: string; status: number}> {
 let response: Response;
 try {
  response = await fetch(ANSWER_ACK_URL, {method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify({id})});
 } catch {
  return {error: "Could not reach this home", status: 0};
 }
 if (response.status === 202) return await response.json() as AnswerAckResponse;
 return {error: await failure(response), status: response.status};
}

const answered = (status: AnswersControlStatus | null | undefined): status is AnswersControlStatusResponse => status != null && "enabled" in status;

/** The page may acknowledge: control on and the token served. */
export const answersControlReady = (status: AnswersControlStatus | null | undefined): status is AnswersControlStatusResponse =>
 answered(status) && status.enabled && status.token !== null;

/** The one line the section shows about its tick. */
export function answersControlLine(status: AnswersControlStatus | null | undefined): string {
 if (!status) return "Checking…";
 if (!answered(status)) return `Acknowledge unavailable: ${status.error}`;
 if (!status.enabled) return status.reason ?? "Dashboard control is off";
 return "Tick ✓ to acknowledge: it only clears this list; nothing is sent";
}
