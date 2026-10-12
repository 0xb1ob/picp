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

/**
 * The last published binding, whatever the tunnel's state now: a stopped tunnel's sessions stay bound to its last
 * generation, so `down` then a new quick `up` still invalidates them. No runtime file is `null` (nothing published yet).
 */
export function readTunnelBinding(stateDir: string): TunnelBindingRead {
	const file = tunnelRuntimeFile(stateDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, binding: null };
		return { ok: false, reason: `${file}: ${code ?? "not JSON"}` };
	}
	if (!isObject(raw) || raw.schema_version !== 1) return { ok: false, reason: `${file}: schema_version is not 1` };
	if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0) return { ok: false, reason: `${file}: generation` };
	if (raw.origin === null) return { ok: true, binding: null };
	if (typeof raw.origin !== "string" || !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(raw.origin)) return { ok: false, reason: `${file}: origin` };
	return { ok: true, binding: { origin: raw.origin, generation: raw.generation as number } };
}
