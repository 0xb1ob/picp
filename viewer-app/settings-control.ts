import type { SettingField, SettingKey, SettingValue } from "../src/contracts.ts";
import type {
 BoardsListenerState, SettingsModelsResponse, SettingsResponse, SettingsWriteResponse,
} from "../src/viewer/api-types.ts";
import { type ControlStatus, failure } from "./control.ts";

/** Settings page (cp-settings-minimal): GET the snapshot, POST apply/restore through the owner-file settings API (PR 171). */
export const SETTINGS_URL = "/api/settings";
export const SETTINGS_MODELS_URL = "/api/settings/models";
export const SETTINGS_APPLY_URL = "/api/settings/apply";
export const SETTINGS_RESTORE_URL = "/api/settings/restore";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SettingsStatus = SettingsResponse | {error: string};
export type ModelsStatus = SettingsModelsResponse | {error: string};
export type RestoreSelector = {keys: SettingKey[]} | {section: string};
/** "codex" is a per-rule choice only: no session or Workers CLI field offers it. */
export type Cli = "pi" | "claude" | "codex";
/** A CLI's picker choices: claude and codex keep the models their rule matches and their efforts; null `models` is no list yet. */
export interface CliChoices { cli: Cli | null; models: string[] | null | undefined; efforts: string[]; native: RegExp | null }

/** The choices for `cli` from the session's `drivers` and the models read; an older session gets `fallback` levels. */
export function cliChoices(status: SettingsResponse, cli: Cli | null, fallback: readonly string[], list: SettingsModelsResponse | null): CliChoices {
 const drivers = status.drivers;
 if (!drivers) return {cli, models: list?.pi.models ?? null, efforts: [...fallback], native: null};
 if (cli === "codex") {
  if (!drivers.codex_model) return {cli, models: null, efforts: [], native: null};
  const codex = new RegExp(drivers.codex_model);
  return {cli, models: list?.pi.models?.filter(model => codex.test(model)) ?? null, efforts: drivers.efforts.codex ?? [], native: codex};
 }
 const native = new RegExp(drivers.claude_model);
 if (cli !== "claude") return {cli, models: list?.pi.models ?? null, efforts: drivers.efforts.pi, native};
 return {cli, models: list?.claude.models ?? null, efforts: drivers.efforts.claude, native};
}

/** Why a model/effort pair cannot run on the Claude or Codex CLI (the driver's own rule), or null; pi takes any pair. */
export function cliError(choices: CliChoices, model: string | null | undefined, thinking: string | null | undefined): string | null {
 if (choices.cli === "codex") {
  if (!choices.native) return "This operator session offers no Codex CLI choices: pick pi";
  if (model && !choices.native.test(model)) return `The Codex CLI runs only an openai/gpt-… model, not ${model}: pick one`;
  if (thinking && !choices.efforts.includes(thinking)) return `Effort ${thinking} has no Codex equivalent: pick ${choices.efforts.join(", ")}`;
  return null;
 }
 if (choices.cli !== "claude" || !choices.native) return null;
 if (model && !choices.native.test(model)) return `The Claude CLI runs only an anthropic/claude-… model, not ${model}: pick one`;
 if (thinking && !choices.efforts.includes(thinking)) return `Effort ${thinking} has no Claude equivalent: pick ${choices.efforts.join(", ")}`;
 return null;
}

/** The Codex switch a rubric role falls under (`codexRowClass`), or null from an older session or a role with none. */
export const codexSwitchOf = (status: SettingsResponse, role: string): string | null => status.drivers?.codex_class?.[role] ?? null;

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
 /** True once a saved Operator CLI change waits for Restart session. */
 operatorRestart: boolean;
 save(changes: Drafts): Promise<boolean>;
 restore(selector: RestoreSelector): Promise<boolean>;
 /** `/api/settings/models`, read apart from the page: null until its first answer. */
 models: ModelsStatus | null;
 /** Starts a fresh `pi --list-models` run; the pickers fill in when it lands. */
 refreshModels(): void;
}

export async function readSettings(fetch: Fetch, signal?: AbortSignal): Promise<SettingsStatus> {
 try {
  const response = await fetch(SETTINGS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as SettingsResponse : {error: await failure(response)};
 } catch {
  return {error: "Settings unavailable"};
 }
}

export async function readModels(fetch: Fetch, refresh: boolean, signal?: AbortSignal): Promise<ModelsStatus> {
 try {
  const response = await fetch(refresh ? `${SETTINGS_MODELS_URL}?refresh=1` : SETTINGS_MODELS_URL, signal ? {signal} : {});
  return response.ok ? await response.json() as SettingsModelsResponse : {error: await failure(response)};
 } catch {
  return {error: "could not reach this home"};
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
/** Why a drafted number breaks its catalog bounds (an invalid parent threshold would disable compaction), or null.
 * An emptied bind address is flagged too: it has no off value, so Save stays blocked until one is typed. */
export function fieldError(field: SettingField, value: SettingValue | undefined): string | null {
 if (field.type === "ip") return value === "" ? "A bind address is required: 127.0.0.1 keeps it on this machine" : null;
 if (!["integer", "number", "nullable_number", "port"].includes(field.type)) return null;
 const optional = field.type === "nullable_number" || field.type === "port";
 if (value === null || value === undefined) return optional ? null : "A value is required";
 if (field.type === "port" && !Number.isInteger(value)) return "Must be a whole number";
 if (typeof value !== "number" || !Number.isFinite(value)) return "Not a number";
 if (field.type === "integer" && !Number.isInteger(value)) return "Must be a whole number";
 if (field.minimum !== undefined && value < field.minimum) return `Must be at least ${field.minimum}`;
 if (field.exclusive_minimum !== undefined && value <= field.exclusive_minimum) return `Must be more than ${field.exclusive_minimum}`;
 if (field.maximum !== undefined && value > field.maximum) return `Must be at most ${field.maximum}`;
 return null;
}

const inV4 = (parts: number[], base: number[], bits: number): boolean => {
 const value = (list: number[]) => list.reduce((sum, part) => sum * 256 + part, 0);
 const shift = 2 ** (32 - bits);
 return Math.floor(value(parts) / shift) === Math.floor(value(base) / shift);
};
const V4_PRIVATE: Array<[number[], number]> = [
 [[10, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16], [[100, 64, 0, 0], 10], [[169, 254, 0, 0], 16],
];

/** Who a boards bind reaches, by address alone: this machine, a private network or tailnet, every interface, or all. */
export function bindExposure(host: string): "loopback" | "private" | "wildcard" | "public" {
 const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
 if (v4) {
  const parts = v4.slice(1).map(Number);
  if (parts.every(part => part === 0)) return "wildcard";
  if (parts[0] === 127) return "loopback";
  return V4_PRIVATE.some(([base, bits]) => inV4(parts, base, bits)) ? "private" : "public";
 }
 const v6 = host.trim().toLowerCase();
 const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
 if (mapped) return bindExposure(mapped[1] as string);
 if (!v6.includes(":")) return "public";
 if (/^[0:]+$/.test(v6)) return "wildcard";
 if (/^[0:]*:0*1$/.test(v6)) return "loopback";
 // fc00::/7 (ULA, Tailscale's fd7a:115c:a1e0::/48) and fe80::/10 (link-local): a full first group only.
 return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6) ? "private" : "public";
}

/** One line for the boards listener's state as this viewer reports it. */
export function boardsText(state: BoardsListenerState): string {
 const host = state.host?.includes(":") ? `[${state.host}]` : state.host;
 const index = `index ${state.index ? "on" : "off"}`;
 if (state.state === "listening") return `Boards listener on ${host}:${state.port}, ${index}`;
 if (state.state === "off") return "Boards listener off";
 return `Boards listener failed: ${state.error ?? "unknown error"}; it is off until fixed`;
}
