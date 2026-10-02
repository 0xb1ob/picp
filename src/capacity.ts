import { QuotaReader, loadCapacityConfig } from "./quota.ts";
import type { FleetStore } from "./fleet.ts";

export type CapacityScore = { score: number; source: "admin" } | { score: number; source: "fleet"; reason?: CapacityFallbackReason } | { source: "unknown" };

export type CapacityFallbackReason = "capacity auth rejected" | "capacity response unreadable";

/** Free slots from one sub2api `data.platform.<provider>` row: capacity minus in-use minus queued. */
function freeSlots(row: unknown): number | undefined {
	if (!row || typeof row !== "object") return undefined;
	const { max_capacity: max, current_in_use: used, waiting_in_queue: queued } = row as Record<string, unknown>;
	if (![max, used, queued].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
	return (max as number) - (used as number) - (queued as number);
}

/** Advisory only: a snapshot never reserves capacity or refuses a spawn. */
export class CapacityReader {
	readonly quota: QuotaReader;
	readonly #home: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #fleet?: Pick<FleetStore, "read">;
	readonly #fetch: typeof fetch;

	constructor(options: { home: string; env?: NodeJS.ProcessEnv; fleet?: Pick<FleetStore, "read">; fetch?: typeof fetch }) {
		this.quota = new QuotaReader(options);
		this.#home = options.home;
		this.#env = options.env ?? process.env;
		this.#fleet = options.fleet;
		this.#fetch = options.fetch ?? fetch;
	}

	async read(providers: readonly string[]): Promise<Record<string, CapacityScore>> {
		if (!this.#env.CP_GATEWAY_ADMIN_KEY) return Object.fromEntries(providers.map((provider) => [provider, { source: "unknown" }]));
		let reason: CapacityFallbackReason | undefined;
		try {
			const { endpoint } = loadCapacityConfig(this.#home);
			const response = await this.#fetch(endpoint, {
				method: "GET",
				headers: { "x-api-key": this.#env.CP_GATEWAY_ADMIN_KEY },
				signal: AbortSignal.timeout(500),
			});
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) reason = "capacity auth rejected";
				throw new Error("capacity unavailable");
			}
			// sub2api GET /api/v1/admin/ops/concurrency: { code: 0, data: { enabled, timestamp, platform: { <p>: { max_capacity, current_in_use, waiting_in_queue } } } }
			reason = "capacity response unreadable";
			const body: unknown = await response.json();
			if (!body || typeof body !== "object") throw new Error("invalid response");
			const { code, data } = body as Record<string, unknown>;
			if (code !== 0 || !data || typeof data !== "object") throw new Error("invalid response");
			const { enabled, timestamp, platform } = data as Record<string, unknown>;
			if (enabled !== true || typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || !platform || typeof platform !== "object") throw new Error("invalid response");
			const scores: Record<string, CapacityScore> = {};
			for (const provider of providers) {
				const slots = freeSlots((platform as Record<string, unknown>)[provider]);
				if (slots === undefined) throw new Error("missing provider");
				scores[provider] = { score: slots, source: "admin" };
			}
			return scores;
		} catch {
			// No gateway or an incomplete snapshot: compare *only* local counts.
			try {
				if (!this.#fleet) throw new Error("fleet unavailable");
				const jobs = this.#fleet.read().jobs;
				const scores: Record<string, CapacityScore> = {};
				for (const provider of providers) {
					const count = jobs.filter((job) => job.phase === "waiting" && job.worker?.model.startsWith(`${provider}/`)).length;
					scores[provider] = { score: count === 0 ? 0 : -count, source: "fleet", ...(reason ? { reason } : {}) };
				}
				return scores;
			} catch {
				return Object.fromEntries(providers.map((provider) => [provider, { source: "unknown" }]));
			}
		}
	}
}
