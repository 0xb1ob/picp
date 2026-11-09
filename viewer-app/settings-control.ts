import type { SettingField, SettingKey, SettingValue } from "../src/contracts.ts";
import type { SettingsResponse, SettingsWriteResponse } from "../src/viewer/api-types.ts";
import { type ControlStatus, failure } from "./control.ts";

/** Settings page (cp-settings-minimal): GET the snapshot, POST apply/restore through the owner-file settings API (PR 171). */
export const SETTINGS_URL = "/api/settings";
export const SETTINGS_APPLY_URL = "/api/settings/apply";
export const SETTINGS_RESTORE_URL = "/api/settings/restore";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SettingsStatus = SettingsResponse | {error: string};
export type RestoreSelector = {keys: SettingKey[]} | {section: string};
export type Cli = "pi" | "claude";
/** A CLI's picker choices: claude keeps the models its rule matches and its efforts; null `models` is no list yet. */
export interface CliChoices { cli: Cli | null; models: string[] | null | undefined; efforts: string[]; native: RegExp | null }

/** The choices for `cli` from the session's `drivers`; an older session gets `fallback` levels, unfiltered. */
export function cliChoices(status: SettingsResponse, cli: Cli | null, fallback: readonly string[]): CliChoices {
 const drivers = status.drivers;
 if (!drivers) return {cli, models: status.available_models, efforts: [...fallback], native: null};
 const native = new RegExp(drivers.claude_model);
 if (cli !== "claude") return {cli, models: status.available_models, efforts: drivers.efforts.pi, native};
 return {cli, models: status.available_models?.filter(model => native.test(model)) ?? status.available_models, efforts: drivers.efforts.claude, native};
}

/** Why a model/effort pair cannot run on the Claude CLI (the driver's own rule), or null; pi takes any pair. */
export function cliError(choices: CliChoices, model: string | null | undefined, thinking: string | null | undefined): string | null {
 if (choices.cli !== "claude" || !choices.native) return null;
 if (model && !choices.native.test(model)) return `The Claude CLI runs only an anthropic/claude-… model, not ${model}: pick one`;
 if (thinking && !choices.efforts.includes(thinking)) return `Effort ${thinking} has no Claude equivalent: pick ${choices.efforts.join(", ")}`;
 return null;
}

/** A write's outcome: the owner transaction's answer with its HTTP status, or why it never reached one. */
export type SettingsWriteResult = {status: number; body: SettingsWriteResponse} | {status: number; error: string};
export type Drafts = Partial<Record<SettingKey, SettingValue>>;
export interface SettingsView {
 status: SettingsStatus | null;
 token: string | null;
 busy: boolean;
 /** The last write's outcome line, `errors` per key/row on a 400, and `stale` after a 412 (the drafts stay). */
 notice: {kind: "ok" | "error" | "stale"; text: string; errors: string[]} | null;
 /** The operator session's control status, for the parent restart offer. */
 control: ControlStatus | null;
 /** True once a saved Parent CLI change waits for a parent restart. */
 restart: boolean;
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
/** Why a drafted number breaks its catalog bounds (an invalid parent threshold would disable compaction), or null. */
export function fieldError(field: SettingField, value: SettingValue | undefined): string | null {
 if (field.type !== "integer" && field.type !== "number" && field.type !== "nullable_number") return null;
 if (value === null || value === undefined) return field.type === "nullable_number" ? null : "A value is required";
 if (typeof value !== "number" || !Number.isFinite(value)) return "Not a number";
 if (field.type === "integer" && !Number.isInteger(value)) return "Must be a whole number";
 if (field.minimum !== undefined && value < field.minimum) return `Must be at least ${field.minimum}`;
 if (field.exclusive_minimum !== undefined && value <= field.exclusive_minimum) return `Must be more than ${field.exclusive_minimum}`;
 if (field.maximum !== undefined && value > field.maximum) return `Must be at most ${field.maximum}`;
 return null;
}
