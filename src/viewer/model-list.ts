/**
 * The models pi can use on this machine, for the Settings pickers: `pi --no-extensions --list-models` parsed by the
 * cp-install parser (src/service/models.ts). Read-only, cached in memory and never awaited by a request: a caller gets the
 * cached list at once (stale included; `loading` while one background run refreshes it). A failure is a note.
 */
import { execFile } from "node:child_process";
import { parseModelList } from "../service/models.ts";
import type { ModelList } from "./api-types.ts";

export type ListRun = () => Promise<{ status: number; stdout: string }>;

const TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;
const LIST_TIMEOUT_MS = 8_000;

const piList: ListRun = () => new Promise((resolve) => {
	execFile("pi", ["--no-extensions", "--list-models"], { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 << 20 }, (error, stdout) => {
		resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") });
	});
});

/**
 * A lister with its own cache, answering synchronously; a missing or expired entry, or `force`, starts one background
 * run (deduplicated). A list is fresh for 5 minutes, a failure 30 seconds; a stale entry is served until the run lands.
 */
export function modelLister(run: ListRun = piList, clock: () => number = Date.now): (force?: boolean) => ModelList {
	let cached: { at: number; ttl: number; models: string[] | null; error: string | null } | undefined;
	let inflight = false;
	const refresh = async (): Promise<void> => {
		const result = await run().catch(() => ({ status: 1, stdout: "" }));
		const models = result.status === 0 ? parseModelList(result.stdout) : undefined;
		const error = models === undefined ? "model list unavailable" : models.length === 0 ? "pi lists no usable models" : null;
		cached = { at: clock(), ttl: error ? FAILED_TTL_MS : TTL_MS, models: error ? null : models!, error };
	};
	return (force = false) => {
		if (!inflight && (force || !cached || clock() - cached.at >= cached.ttl)) {
			inflight = true;
			void refresh().catch(() => undefined).finally(() => { inflight = false; });
		}
		return { models: cached?.models ?? null, error: cached?.error ?? null, loading: inflight, listed_at: cached ? new Date(cached.at).toISOString() : null };
	};
}

export const availableModels = modelLister();
