import type { SettingField, SettingKey, SettingValue } from "../src/contracts.ts";
import type { SettingsResponse, SettingsWriteResponse } from "../src/viewer/api-types.ts";
import { failure } from "./control.ts";

/** Settings page (cp-settings-minimal): GET the snapshot, POST apply/restore through the #171 owner-file API. */
export const SETTINGS_URL = "/api/settings";
export const SETTINGS_APPLY_URL = "/api/settings/apply";
export const SETTINGS_RESTORE_URL = "/api/settings/restore";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SettingsStatus = SettingsResponse | {error: string};
export type RestoreSelector = {keys: SettingKey[]} | {section: string};
/** A write's outcome: the owner transaction's answer with its HTTP status, or why it never reached one. */
export type SettingsWriteResult = {status: number; body: SettingsWriteResponse} | {status: number; error: string};
export type Drafts = Partial<Record<SettingKey, SettingValue>>;
export interface SettingsView {
 status: SettingsStatus | null;
 token: string | null;
 busy: boolean;
 /** The last write's outcome line, `errors` per key/row on a 400, and `stale` after a 412 (the drafts stay). */
 notice: {kind: "ok" | "error" | "stale"; text: string; errors: string[]} | null;
 save(changes: Drafts): Promise<boolean>;
 restore(selector: RestoreSelector): Promise<boolean>;
}

export async function readSettings(fetch: Fetch, signal?: AbortSignal): Promise<SettingsStatus> {
 try {
  const response = await fetch(SETTINGS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as SettingsResponse : {error: await failure(response)};
 } catch {
  return {error: "Settings unavailable"};
 }
}

/** 16 random base64url characters: the server takes 8-64 of [A-Za-z0-9_-]. */
export const requestId = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, "-").replace(/\//g, "_");

export async function writeSettings(fetch: Fetch, token: string, revision: string, body: {changes: Drafts} | RestoreSelector): Promise<SettingsWriteResult> {
 const url = "changes" in body ? SETTINGS_APPLY_URL : SETTINGS_RESTORE_URL;
 let response: Response;
 try {
  response = await fetch(url, {method: "POST", headers: {"content-type": "application/json", "if-match": `"${revision}"`, "x-cp-control-token": token}, body: JSON.stringify({...body, request_id: requestId()})});
 } catch {
  return {status: 0, error: "Could not reach this home"};
 }
 try {
  const json = await response.json() as SettingsWriteResponse & {error?: string};
  return typeof json.state === "string" ? {status: response.status, body: json} : {status: response.status, error: json.error ?? `HTTP ${response.status}`};
 } catch {
  return {status: response.status, error: `HTTP ${response.status}`};
 }
}

/** The value a key shows: the draft, else the snapshot's. */
export const valueOf = (status: SettingsResponse, drafts: Drafts, key: SettingKey): SettingValue | undefined =>
 key in drafts ? drafts[key] : status.snapshot?.fields.find(field => field.key === key)?.value;
export const fieldOf = (status: SettingsResponse, key: SettingKey): SettingField | undefined => status.catalog?.find(field => field.key === key);
