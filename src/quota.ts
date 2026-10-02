import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LAYOUT, type RoutingDecision } from "./contracts.ts";

export const DEFAULT_BALANCE_MARGIN = 10;
export type QuotaSnapshot = NonNullable<RoutingDecision["quota"]>;
interface GatewayBody {
	code?: unknown;
	data?: {
		items?: Array<Record<string, unknown>>;
		total?: number;
		five_hour?: { utilization?: unknown };
		seven_day?: { utilization?: unknown };
	};
}

export function loadCapacityConfig(home: string) {
	try {
		const { url, path, quota = {}, ...other } = JSON.parse(readFileSync(join(home, LAYOUT.data, "capacity.json"), "utf8"));
		if (Object.keys(other).length || typeof url !== "string" || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("invalid endpoint");
		const base = new URL(url);
		const endpoint = new URL(path, base);
		if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/" || endpoint.origin !== base.origin || endpoint.search || endpoint.hash) throw new Error("invalid endpoint");
		if (!quota || typeof quota !== "object" || Array.isArray(quota) || Object.entries(quota).some(([key, value]) => key === "balance_margin" ? value !== null && (typeof value !== "number" || !Number.isFinite(value)) : !["five_hour", "seven_day"].includes(key) || !percentage(value))) throw new Error("invalid quota thresholds");
		return { url: base.href, endpoint: endpoint.href, quota: { five_hour: 90, seven_day: 85, balance_margin: DEFAULT_BALANCE_MARGIN, ...quota } as { five_hour: number; seven_day: number; balance_margin: number | null } };
	} catch {
		throw new Error("capacity config unreadable");
	}
}

function percentage(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function formatQuota(snapshot: QuotaSnapshot): string {
	if (snapshot.reason) return snapshot.reason === "off:no admin key" ? `quota=${snapshot.reason}` : `quota unavailable: ${snapshot.reason}`;
	if (!snapshot.providers.length) return "quota=unknown:no configured providers";
	return `quota=${snapshot.providers.map((row) => {
		if (row.seven_day === undefined) return `${row.provider}:unknown`;
		return `${row.provider}:5h=${row.five_hour === undefined ? "n/a" : row.five_hour},7d=${row.seven_day}${row.tight ? "(tight)" : ""}`;
	}).join(",")}${snapshot.balance_reason ? `; ${snapshot.balance_reason}` : ""}`;
}

/** Advisory subscription windows. Concurrent dispatches share the same 60-second snapshot. */
export class QuotaReader {
	readonly #options: { home: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch };
	#cache?: { key: string; expires: number; value: Promise<QuotaSnapshot> };
	latest?: QuotaSnapshot;
	constructor(options: { home: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }) { this.#options = options; }

	async read(providers: readonly string[]): Promise<QuotaSnapshot> {
		const key = JSON.stringify(providers);
		if (!(this.#options.env ?? process.env).CP_GATEWAY_ADMIN_KEY) {
			return this.latest = { providers: [], reason: "off:no admin key" };
		}
		if (!this.#cache || this.#cache.key !== key || this.#cache.expires <= Date.now()) {
			this.#cache = { key, expires: Date.now() + 60_000, value: this.#read(providers) };
		}
		return this.latest = await this.#cache.value;
	}

	async #read(providers: readonly string[]): Promise<QuotaSnapshot> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reason: QuotaSnapshot["reason"] = "unreadable";
		try {
			const config = loadCapacityConfig(this.#options.home);
			const get = async (path: string) => {
				const response = await (this.#options.fetch ?? fetch)(new URL(path, config.url).href, {
					method: "GET", headers: { "x-api-key": (this.#options.env ?? process.env).CP_GATEWAY_ADMIN_KEY! }, signal: controller.signal,
				});
				if (response.status === 401 || response.status === 403) { reason = "auth rejected"; throw new Error("auth rejected"); }
				if (!response.ok) throw new Error("unreadable");
				return response.json() as Promise<GatewayBody>;
			};
			const read = async (): Promise<QuotaSnapshot> => {
				if (!providers.length) return { providers: [] };
				const body = await get("/api/v1/admin/accounts?page=1&page_size=50");
				if (body?.code !== 0 || !Array.isArray(body.data?.items)) throw new Error("unreadable");
				// A partial account list cannot establish which account is the best one.
				if (body.data.total !== undefined ? body.data.total !== body.data.items.length : body.data.items.length >= 50) throw new Error("unreadable");
				const unblocked = (value: unknown) => value === null || (typeof value === "string" && Date.parse(value) <= Date.now());
				const accounts = body.data.items.filter((row) => row && typeof row === "object" && typeof row.platform === "string" && providers.includes(row.platform) && row.status === "active" && row.schedulable === true && unblocked(row.temp_unschedulable_until) && unblocked(row.overload_until) && row.type === "oauth");
				const windows = await Promise.all(accounts.map(async (account) => {
					if (typeof account.id !== "number" || !Number.isSafeInteger(account.id) || account.id <= 0) throw new Error("unreadable");
					const usage = await get(`/api/v1/admin/accounts/${account.id}/usage`);
					const five = usage?.data?.five_hour?.utilization, seven = usage?.data?.seven_day?.utilization;
					const none: { provider: string; five_hour?: number; seven_day?: number } = { provider: account.platform as string };
					if (usage?.code !== 0 || !percentage(seven)) return none;
					// The gateway does not report an oauth account's 5h window at all; it reads back as a flat 0
					// while 7d is genuinely nonzero. Treat that as unreported, not a real 0% reading.
					const fiveUnreported = five === 0 && seven > 0;
					if (!fiveUnreported && !percentage(five)) return none;
					return { provider: account.platform as string, seven_day: seven, ...(fiveUnreported ? {} : { five_hour: five }) };
				}));
				return { balance_margin: config.quota.balance_margin, providers: providers.map((provider) => {
					const known = windows.filter((row) => row.provider === provider && row.seven_day !== undefined);
					known.sort((a, b) => Math.max(a.five_hour ?? 0, a.seven_day!) - Math.max(b.five_hour ?? 0, b.seven_day!));
					const best = known[0];
					return best ? { ...best, tight: (best.five_hour !== undefined && best.five_hour >= config.quota.five_hour) || best.seven_day! >= config.quota.seven_day } : { provider, tight: false };
				}) };
			};
			return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => { reason = "timeout"; controller.abort(); reject(new Error("timeout")); }, 1500);
			})]);
		} catch {
			controller.abort();
			return { providers: [], reason };
		} finally { clearTimeout(timer); }
	}
}
