import type { DevicesResponse, PairCodeResponse } from "../src/viewer/api-types.ts";

/** Remote dashboard PR 3: the Devices client. One request per click; the pairing link is returned, never stored. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type DeviceLevel = PairCodeResponse["level"];
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** The store's fixed refusal reasons, in words; any other refusal is shown as the server wrote it. */
const REASONS: Record<string, string> = {
 too_many_codes: "Three pairing links are already live; use one or wait five minutes for one to expire",
 store_invalid: "The device list is unreadable on this home; nothing was changed",
 write_failed: "The device list could not be written; nothing was changed",
 audit_failed: "The audit line could not be written, so nothing was changed",
 not_found: "No such device",
};

async function call<T>(fetcher: Fetcher, url: string, init?: RequestInit): Promise<Result<T>> {
 let response: Response;
 try { response = await fetcher(url, init); } catch { return {ok: false, status: 0, error: "Could not reach this home"}; }
 let body: unknown = null;
 try { body = await response.json(); } catch { /* no JSON body: the status says enough */ }
 if (response.ok && body !== null && typeof body === "object") return {ok: true, value: body as T};
 const reason = body !== null && typeof body === "object" && typeof (body as {error?: unknown}).error === "string" ? (body as {error: string}).error : `HTTP ${response.status}`;
 return {ok: false, status: response.status, error: REASONS[reason] ?? reason};
}

const post = (token: string, body: unknown): RequestInit => ({method: "POST", headers: {"content-type": "application/json", "x-cp-control-token": token}, body: JSON.stringify(body)});

export const readDevices = (fetcher: Fetcher, signal?: AbortSignal) => call<DevicesResponse>(fetcher, "/api/devices", signal ? {signal} : undefined);
export const createPairing = (fetcher: Fetcher, token: string, level: DeviceLevel) => call<PairCodeResponse>(fetcher, "/api/pair/create", post(token, {level}));
export const revokeDevice = (fetcher: Fetcher, token: string, id: string) => call<{id: string; revoked_at: string; audit_error: string | null; cleanup_error: string | null}>(fetcher, "/api/devices/revoke", post(token, {id}));
