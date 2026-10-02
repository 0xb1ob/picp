/**
 * The dashboard's bind-address policy and discovery (cp-5smb). The viewer serves write controls (operator
 * message, Start session, schedules) to whoever can reach it, so an address is acceptable only when it is a
 * Tailscale, private-LAN, ULA or loopback address — never a wildcard, link-local, public or
 * non-IP value. `cp-install --viewer-host` and `cp-view --require-tailnet` both apply it.
 */
import { execFileSync } from "node:child_process";
import { BlockList, isIP, isIPv4 } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

function subnets(entries: Array<[string, number, "ipv4" | "ipv6"]>): BlockList {
	const list = new BlockList();
	for (const [net, prefix, type] of entries) list.addSubnet(net, prefix, type);
	return list;
}

const ALLOWED = subnets([
	["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"],
	["100.64.0.0", 10, "ipv4"], // Tailscale's CGNAT space
	["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], // ULA; Tailscale's fd7a:115c:a1e0::/48
]);
const LINK_LOCAL = subnets([["169.254.0.0", 16, "ipv4"], ["fe80::", 10, "ipv6"]]);
// BlockList matches an IPv4 address against IPv6 rules through its mapped form, so these two apply to IPv6 only.
const MAPPED = subnets([["::ffff:0:0", 96, "ipv6"]]);
const LOOPBACK = subnets([["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]]);
const CGNAT = subnets([["100.64.0.0", 10, "ipv4"]]);

const type = (address: string): "ipv4" | "ipv6" => (isIPv4(address) ? "ipv4" : "ipv6");

/** Why `address` must not carry the dashboard, or undefined when it may. */
export function bindHostRefusal(address: string): string | undefined {
	if (address.includes("%")) return "a zone id is not a bind address";
	const family = isIP(address);
	if (family === 0) return "not an IP address";
	if (address === "0.0.0.0" || (family === 6 && sameAddress(address, "::"))) return "wildcard: binds every interface, public ones included";
	if (family === 6 && MAPPED.check(address, "ipv6")) return "IPv4-mapped; give the IPv4 address";
	if (ALLOWED.check(address, type(address))) return undefined;
	if (LINK_LOCAL.check(address, type(address))) return "link-local";
	return "public or non-unicast address: the dashboard serves write controls";
}

export interface LocalAddress { address: string; iface: string; family: 4 | 6 }

/** Every acceptable address on this machine's interfaces (link-local and the rest dropped), in interface order. */
export function localAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LocalAddress[] {
	return Object.entries(interfaces).flatMap(([iface, infos]) => (infos ?? [])
		.filter((info) => bindHostRefusal(info.address) === undefined)
		.map((info) => ({ address: info.address, iface, family: isIPv4(info.address) ? 4 as const : 6 as const })));
}

/** IPv4 by string; IPv6 by value (`FD7A::1` is `fd7a::1`). */
export function sameAddress(a: string, b: string): boolean {
	if (isIP(a) !== isIP(b) || isIP(a) === 0) return false;
	if (isIPv4(a)) return a === b;
	const one = new BlockList();
	one.addAddress(a, "ipv6");
	return one.check(b, "ipv6");
}

export interface HostCandidate extends LocalAddress { source: "tailscale" | "private" | "loopback"; recommended: boolean; why: string }

/**
 * The prompt's choices: Tailscale (recommended), other private, loopback. `tailscale ip -4` output only
 * labels an interface address: one no interface carries is dropped.
 */
export function viewerHostCandidates(locals: LocalAddress[], tailscaleIp: string | undefined): HostCandidate[] {
	const seen = new Set<string>();
	const unique = locals.filter((local) => !seen.has(local.address) && seen.add(local.address));
	const tailscale = tailscaleIp === undefined ? undefined : unique.find((local) => sameAddress(local.address, tailscaleIp));
	const out: HostCandidate[] = [];
	if (tailscale) out.push({ ...tailscale, source: "tailscale", recommended: true, why: "recommended: only devices on your tailnet can reach it" });
	const rest = unique.filter((local) => local !== tailscale);
	for (const local of rest.filter((l) => !LOOPBACK.check(l.address, type(l.address)))) {
		const shared = local.family === 4 && CGNAT.check(local.address, "ipv4") ? " (shared address space — may be your ISP's network)" : "";
		out.push({ ...local, source: "private", recommended: false, why: `anyone on this network can reach it${shared}` });
	}
	for (const local of rest.filter((l) => LOOPBACK.check(l.address, type(l.address)))) out.push({ ...local, source: "loopback", recommended: false, why: "this machine only (other local users included)" });
	return out;
}

/** `tailscale ip -4` output: the first line, an acceptable IPv4 — else undefined. */
export function parseTailscaleIp(stdout: string): string | undefined {
	const ip = stdout.split("\n")[0]?.trim();
	return ip && isIPv4(ip) && bindHostRefusal(ip) === undefined ? ip : undefined;
}

type Exec = (command: string, args: string[]) => string;
const execTool: Exec = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

/** The tailnet IPv4 (`tailscale ip -4`); undefined when tailscale is absent, down or silent. */
export function tailscaleIp(exec: Exec = execTool): string | undefined {
	try {
		return parseTailscaleIp(exec("tailscale", ["ip", "-4"]));
	} catch {
		return undefined; // not installed, not up, or timed out
	}
}
