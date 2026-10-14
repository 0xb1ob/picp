/**
 * `cp-tunnel up --api-token-file`: this home's named tunnel, its ingress and its DNS record through the Cloudflare API.
 * The API token lives only in memory: it is redacted from every reason this module returns. Idempotent: a re-run finds
 * the zone, the tunnel (saved id, else its `picp-<home id>` name) and its own CNAME, and creates only what is missing.
 */
import { createHash } from "node:crypto";
import { hostname as machineName } from "node:os";
import { CLOUDFLARE_ID_RE } from "../service/daemon-tunnel-files.ts";

export const CF_API = "https://api.cloudflare.com/client/v4";
export const CF_TIMEOUT_MS = 30_000;
export const TUNNEL_SCOPE = "Account › Cloudflare Tunnel › Edit";
export const DNS_SCOPE = "Zone › DNS › Edit";

export type CfFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;
export const defaultCfFetch: CfFetch = (url, init) => fetch(url, init);

export interface NamedSetupInput {
	hostname: string;
	/** The remote listener's loopback port the ingress points at. */
	port: number;
	apiToken: string;
	tunnelName: string;
	savedTunnelId?: string;
}
export type NamedSetup = { ok: true; token: string; tunnel_id: string; zone_id: string; account_id: string } | { ok: false; reason: string };

/** `picp-<8 hex>`: stable for this machine and home, distinct for another home in the same account. */
export const tunnelNameFor = (home: string): string => `picp-${createHash("sha256").update(`${machineName()}\0${home}`).digest("hex").slice(0, 8)}`;

class ApiError extends Error {}
type Item = Record<string, unknown>;

export async function setupNamedTunnel(input: NamedSetupInput, fetchPort: CfFetch, log: (line: string) => void): Promise<NamedSetup> {
	const redact = (text: string): string => text.split(input.apiToken).join("[redacted]");
	const api = async (method: string, path: string, scope: string, body?: unknown): Promise<unknown> => {
		let response: Response;
		try {
			const headers: Record<string, string> = { authorization: `Bearer ${input.apiToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
			response = await fetchPort(`${CF_API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(CF_TIMEOUT_MS) });
		} catch (error) {
			throw new ApiError(`${method} ${path}: ${(error as Error).message}`);
		}
		const envelope = (await response.json().catch(() => null)) as { success?: unknown; errors?: unknown; result?: unknown } | null;
		if (response.ok && envelope?.success === true) return envelope.result;
		const errors = (Array.isArray(envelope?.errors) ? envelope.errors : []) as Array<Item | null>;
		if (response.status === 403 || errors.some((error) => error?.code === 10000)) throw new ApiError(`the Cloudflare API token lacks the ${scope} permission (${method} ${path} was refused)`);
		const detail = errors.map((error) => `${error?.code}: ${error?.message}`).join("; ").slice(0, 300);
		throw new ApiError(`${method} ${path}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
	};
	const list = (value: unknown, what: string): Item[] => {
		if (!Array.isArray(value)) throw new ApiError(`Cloudflare answered no ${what} list`);
		return value as Item[];
	};
	const id = (value: unknown, what: string): string => {
		if (typeof value !== "string" || !CLOUDFLARE_ID_RE.test(value)) throw new ApiError(`Cloudflare answered no usable ${what}`);
		return value;
	};
	const host = input.hostname;
	let tunnelId: string | undefined;
	let tunnelInPlace = false;
	try {
		const labels = host.split(".");
		let zone: Item | undefined;
		for (let i = 0; i < labels.length - 1 && !zone; i += 1) {
			const name = labels.slice(i).join(".");
			const zones = list(await api("GET", `/zones?name=${encodeURIComponent(name)}`, DNS_SCOPE), "zone");
			if (zones.length > 1) throw new ApiError(`${zones.length} zones named ${name} are visible to the API token; scope it to one`);
			zone = zones[0];
		}
		if (!zone) throw new ApiError(`no Cloudflare zone for ${host} is visible to the API token; add the domain to Cloudflare and give the token ${DNS_SCOPE} on it`);
		const zoneId = id(zone.id, "zone id");
		const accountId = id((zone.account as Item | undefined)?.id, "account id");
		log(`zone ${String(zone.name)} (${zoneId}), account ${accountId}`);

		const live = async (query: string, match: (tunnel: Item) => boolean): Promise<string | undefined> => {
			const found = list(await api("GET", `/accounts/${accountId}/cfd_tunnel?is_deleted=false&${query}`, TUNNEL_SCOPE), "tunnel").filter(match);
			return found.length === 1 ? id(found[0]!.id, "tunnel id") : undefined;
		};
		const saved = input.savedTunnelId;
		tunnelId = (saved ? await live(`uuid=${saved}`, (tunnel) => tunnel.id === saved) : undefined) ?? (await live(`name=${encodeURIComponent(input.tunnelName)}`, (tunnel) => tunnel.name === input.tunnelName));

		// Never overwrite a record: the one exception is this home's own CNAME, which makes a re-run idempotent.
		const records = list(await api("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`, DNS_SCOPE), "DNS record");
		const target = (tunnel: string): string => `${tunnel}.cfargotunnel.com`;
		const own = tunnelId !== undefined && records.length === 1 && records[0]!.type === "CNAME" && String(records[0]!.content).toLowerCase() === target(tunnelId);
		if (records.length > 0 && !own) {
			const shown = records.map((record) => `${String(record.type)} ${String(record.content)}`).join(", ").slice(0, 300);
			throw new ApiError(`${host} already has DNS records (${shown}); cp-tunnel never overwrites one: delete them in Cloudflare or pick another --hostname`);
		}

		if (tunnelId) log(`reusing tunnel ${tunnelId}`);
		else {
			const created = (await api("POST", `/accounts/${accountId}/cfd_tunnel`, TUNNEL_SCOPE, { name: input.tunnelName, config_src: "cloudflare" })) as Item | null;
			tunnelId = id(created?.id, "tunnel id");
			log(`created tunnel ${input.tunnelName} (${tunnelId})`);
		}
		tunnelInPlace = true;

		const origin = `127.0.0.1:${input.port}`;
		await api("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, TUNNEL_SCOPE, {
			config: { ingress: [{ hostname: host, service: `http://${origin}`, originRequest: { httpHostHeader: origin } }, { service: "http_status:404" }] },
		});
		log(`wrote the ingress: ${host} -> http://${origin} (Host header ${origin}), anything else 404`);
		if (own) log(`DNS: ${host} already points to this tunnel`);
		else {
			await api("POST", `/zones/${zoneId}/dns_records`, DNS_SCOPE, { type: "CNAME", name: host, content: target(tunnelId), proxied: true });
			log(`created DNS record: ${host} CNAME ${target(tunnelId)} (proxied)`);
		}
		const token = await api("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, TUNNEL_SCOPE);
		if (typeof token !== "string" || !/^\S{1,4096}$/.test(token)) throw new ApiError("Cloudflare answered no usable tunnel run token");
		return { ok: true, token, tunnel_id: tunnelId, zone_id: zoneId, account_id: accountId };
	} catch (error) {
		const why = redact((error as Error).message);
		return { ok: false, reason: tunnelInPlace ? `${why}. The tunnel ${tunnelId} stays in place; re-run the same cp-tunnel up command, it reuses what already exists` : why };
	}
}
