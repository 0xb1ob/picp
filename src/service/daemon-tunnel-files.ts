/**
 * Remote dashboard PR 2: the tunnel's node-only file layout, shared by the daemon inner, the pairing-alert sender and
 * the parent's push sweep (none of which may import the viewer's modules here):
 *
 *   data/tunnel.json            the desired tunnel config (written by cp-tunnel; its presence enables the remote feature)
 *   state/tunnel-runtime.json   the runtime the cloudflared controller publishes; this file reads its origin binding
 *
 * Imports only `node:*`. Readers fail closed: an unreadable or malformed runtime is a named refusal, never "no tunnel".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const tunnelConfigFile = (dataDir: string): string => join(dataDir, "tunnel.json");
export const tunnelRuntimeFile = (stateDir: string): string => join(stateDir, "tunnel-runtime.json");
/** `data/devices.json` (src/viewer/device-files.ts `devicesFile`, pinned equal by tests/daemon-tunnel-files.test.ts). */
const devicesFile = (dataDir: string): string => join(dataDir, "devices.json");

/** Whether this home uses the remote feature at all: paired devices (pending alerts outlive `down`) or a tunnel config. */
export const remoteFeatureConfigured = (dataDir: string): boolean => existsSync(devicesFile(dataDir)) || existsSync(tunnelConfigFile(dataDir));

/** The origin a session was paired on and the quick-tunnel generation it belongs to: a new generation ends older sessions. */
export type TunnelBinding = { origin: string; generation: number };
export type TunnelBindingRead = { ok: true; binding: TunnelBinding | null } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type RuntimeJson = { ok: true; raw: Record<string, unknown> | null; binding: TunnelBinding | null } | { ok: false; reason: string };

/** The runtime file and its binding part, validated once for both readers below. */
function readRuntimeJson(file: string): RuntimeJson {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, raw: null, binding: null };
		return { ok: false, reason: `${file}: ${code ?? "not JSON"}` };
	}
	if (!isObject(raw) || raw.schema_version !== 1) return { ok: false, reason: `${file}: schema_version is not 1` };
	if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0) return { ok: false, reason: `${file}: generation` };
	if (raw.origin === null) return { ok: true, raw, binding: null };
	if (typeof raw.origin !== "string" || !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(raw.origin)) return { ok: false, reason: `${file}: origin` };
	return { ok: true, raw, binding: { origin: raw.origin, generation: raw.generation as number } };
}

/**
 * The last published binding, whatever the tunnel's state now: a stopped tunnel's sessions stay bound to its last
 * generation, so `down` then a new quick `up` still invalidates them. No runtime file is `null` (nothing published yet).
 */
export function readTunnelBinding(stateDir: string): TunnelBindingRead {
	const read = readRuntimeJson(tunnelRuntimeFile(stateDir));
	return read.ok ? { ok: true, binding: read.binding } : read;
}

// ---------------------------------------------------------------------------
// PR 2c: the desired config (cp-tunnel writes it) and the full runtime the controller (`daemon-tunnel.ts`) publishes
// ---------------------------------------------------------------------------

export type TunnelMode = "quick" | "named";
/** `data/tunnel.json`. No credential: a named tunnel's token is the 0600 file `token_file` names. */
export interface TunnelConfig {
	schema_version: 1;
	enabled: boolean;
	mode: TunnelMode;
	/** The remote listener's loopback port, 1024–65535. */
	port: number;
	/** The absolute cloudflared the controller runs. */
	binary: string;
	/** Named mode: the stable public hostname and the absolute token file. */
	hostname?: string;
	token_file?: string;
	/** Bumped on every change: the runtime answers the revision it applied. */
	revision: number;
}
export type TunnelConfigRead = { ok: true; config: TunnelConfig | null } | { ok: false; reason: string };

export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const absolutePath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !/[\0-\x1f\x7f]/.test(value);
const validPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535;

/** Strict: the first bad field is named; absent is `null` (no tunnel configured). */
export function readTunnelConfig(dataDir: string): TunnelConfigRead {
	const file = tunnelConfigFile(dataDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, config: null };
		return { ok: false, reason: `${file}: ${code ?? "not JSON"}` };
	}
	const bad = (field: string): TunnelConfigRead => ({ ok: false, reason: `${file}: ${field}` });
	if (!isObject(raw) || raw.schema_version !== 1) return bad("schema_version is not 1");
	if (typeof raw.enabled !== "boolean") return bad("enabled");
	if (raw.mode !== "quick" && raw.mode !== "named") return bad("mode");
	if (!validPort(raw.port)) return bad("port");
	if (!absolutePath(raw.binary)) return bad("binary");
	if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return bad("revision");
	const named = raw.mode === "named";
	if (named ? typeof raw.hostname !== "string" || !HOSTNAME_RE.test(raw.hostname) : raw.hostname !== undefined) return bad("hostname");
	if (named ? !absolutePath(raw.token_file) : raw.token_file !== undefined) return bad("token_file");
	return {
		ok: true,
		config: { schema_version: 1, enabled: raw.enabled, mode: raw.mode, port: raw.port as number, binary: raw.binary, revision: raw.revision as number, ...(named ? { hostname: raw.hostname as string, token_file: raw.token_file as string } : {}) },
	};
}

/** `running`: the child registered a tunnel connection on the published origin. */
export type TunnelState = "starting" | "running" | "restarting" | "stopped" | "failed";
/** `state/tunnel-runtime.json`: nonsecret; `origin`/`generation` are the last published binding (`readTunnelBinding`). */
export interface TunnelRuntime {
	schema_version: 1;
	origin: string | null;
	generation: number;
	/** The config revision this state answers (`null` before any). */
	revision: number | null;
	state: TunnelState;
	mode?: TunnelMode;
	port?: number;
	/** The owned child while it lives: its pid and exact command line, the identity checked before any signal. */
	pid?: number;
	binary?: string;
	argv?: string[];
	started_at?: string;
	detail?: string;
	updated_at: string;
}
export type TunnelRuntimeRead = { ok: true; runtime: TunnelRuntime | null } | { ok: false; reason: string };

const STATES: readonly string[] = ["starting", "running", "restarting", "stopped", "failed"];

/** The whole runtime record, for the controller's recovery, the viewer and cp-tunnel. Malformed is refused. */
export function readTunnelRuntime(stateDir: string): TunnelRuntimeRead {
	const file = tunnelRuntimeFile(stateDir);
	const read = readRuntimeJson(file);
	if (!read.ok) return read;
	const raw = read.raw;
	if (raw === null) return { ok: true, runtime: null };
	const bad = (field: string): TunnelRuntimeRead => ({ ok: false, reason: `${file}: ${field}` });
	if (raw.revision !== null && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1)) return bad("revision");
	if (typeof raw.state !== "string" || !STATES.includes(raw.state)) return bad("state");
	if (raw.mode !== undefined && raw.mode !== "quick" && raw.mode !== "named") return bad("mode");
	if (raw.port !== undefined && !validPort(raw.port)) return bad("port");
	if (raw.pid !== undefined && (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1)) return bad("pid");
	if (raw.pid !== undefined && (!absolutePath(raw.binary) || !Array.isArray(raw.argv) || !raw.argv.every((arg) => typeof arg === "string"))) return bad("pid without binary and argv");
	if (typeof raw.updated_at !== "string") return bad("updated_at");
	return { ok: true, runtime: raw as unknown as TunnelRuntime };
}
