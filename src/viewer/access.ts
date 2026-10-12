/**
 * Remote dashboard PR 1: who a request speaks for. The local listener keeps its existing guards untouched and
 * carries `LOCAL_ACCESS`; the remote listener (remote-server.ts) binds one frozen `remote` context built from the
 * authenticated device row, never from a header or body. Pure: no I/O, no clock.
 *
 * Decision es-6a78c3: a Full-control remote device is trusted like a terminal. These helpers only keep the
 * dashboard's own pairing/device APIs from minting devices for a remote caller; they confine no shell.
 */
import { BlockList, isIP, isIPv4 } from "node:net";
import type { DeviceLevel } from "./device-files.ts";

export type LocalAccess = Readonly<{ kind: "local" }>;
export type RemoteAccess = Readonly<{ kind: "remote"; device_id: string; name: string; level: DeviceLevel; origin: string }>;
export type AccessContext = LocalAccess | RemoteAccess;

export const LOCAL_ACCESS: LocalAccess = Object.freeze({ kind: "local" });

export function remoteAccess(device: { id: string; name: string; level: DeviceLevel; origin: string }): RemoteAccess {
	return Object.freeze({ kind: "remote", device_id: device.id, name: device.name, level: device.level, origin: device.origin });
}

/** A protected read: local keeps its own flag (`requireTailnet` and friends) exactly; an authenticated remote device of either level reads. */
export const canRead = (access: AccessContext, localAllowed: boolean): boolean => (access.kind === "local" ? localAllowed : true);

/** An operational write: local keeps its existing guards; remote needs Full-control (View-only refuses before any effect). */
export const canControl = (access: AccessContext): boolean => access.kind === "local" || access.level === "full";

/** Revoking a device: the eligible local screen or a Full-control remote device. */
export const canRevoke = (access: AccessContext, peer: string | undefined): boolean => (access.kind === "local" ? mintPeer(peer) : access.level === "full");

const subnets = (entries: Array<[string, number, "ipv4" | "ipv6"]>): BlockList => {
	const list = new BlockList();
	for (const [net, prefix, family] of entries) list.addSubnet(net, prefix, family);
	return list;
};
// Loopback and the tailnet only: a private-LAN peer may reach the local listener but never mints a device.
const MINT_V4 = subnets([["127.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"]]);
const MINT_V6 = subnets([["::1", 128, "ipv6"], ["fd7a:115c:a1e0::", 48, "ipv6"]]);
const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Whether a socket peer address (never a forwarded header) is loopback or tailnet. */
export function mintPeer(peer: string | undefined): boolean {
	if (typeof peer !== "string" || peer.includes("%")) return false;
	const mapped = MAPPED.exec(peer)?.[1];
	const address = mapped ?? peer;
	if (isIP(address) === 0) return false;
	return isIPv4(address) ? MINT_V4.check(address, "ipv4") : MINT_V6.check(address, "ipv6");
}

/** Creating a pairing code from a browser: never remote, whatever its level; local only from a loopback/tailnet socket peer. */
export const canMint = (access: AccessContext, peer: string | undefined): boolean => access.kind === "local" && mintPeer(peer);

/**
 * The per-request context: only the remote listener's gate binds one, after it authenticated the device; a request it
 * never saw (every local-listener request) reads `LOCAL_ACCESS`, so local routes answer exactly as before.
 */
type Bound = { access: RemoteAccess; stillValid: () => boolean };
const bound = new WeakMap<object, Bound>();
export function bindAccess(req: object, access: RemoteAccess, stillValid: () => boolean): void {
	if (bound.has(req)) throw new Error("access already bound to this request");
	bound.set(req, Object.freeze({ access, stillValid }));
}
export const accessOf = (req: object): AccessContext => bound.get(req)?.access ?? LOCAL_ACCESS;
/** A refresh stream's per-tick session check (remote only; a local stream has none). */
export const streamValidity = (req: object): (() => boolean) | undefined => bound.get(req)?.stillValid;
