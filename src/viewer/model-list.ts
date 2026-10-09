/**
 * The models pi can use on this machine, for the Settings pickers: `pi --no-extensions --list-models` parsed by the
 * cp-install parser (src/service/models.ts). Read-only, cached in memory and never awaited by a request: a caller gets the
 * cached list at once (stale included) or `loading`, while one background run refreshes it. A failure is a note, never an error.
 */
import { execFile } from "node:child_process";
import { parseModelList } from "../service/models.ts";

export interface ModelList { models: string[] | null; error: string | null; /** No list yet: the first run is still going. */ loading: boolean }
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
 * A lister with its own cache. Each call answers synchronously; a missing or expired entry starts one background run
 * (deduplicated). A good list is fresh for 5 minutes, a failure for 30 seconds; a stale entry keeps being served until the run lands.
 */
export function modelLister(run: ListRun = piList, clock: () => number = Date.now): () => ModelList {
	let cached: { at: number; ttl: number; list: ModelList } | undefined;
	let inflight = false;
	const refresh = async (): Promise<void> => {
		const result = await run().catch(() => ({ status: 1, stdout: "" }));
		const models = result.status === 0 ? parseModelList(result.stdout) : undefined;
		const list: ModelList = models === undefined ? { models: null, error: "model list unavailable", loading: false } : models.length === 0 ? { models: null, error: "pi lists no usable models", loading: false } : { models, error: null, loading: false };
		cached = { at: clock(), ttl: list.error ? FAILED_TTL_MS : TTL_MS, list };
	};
	return () => {
		if (!inflight && (!cached || clock() - cached.at >= cached.ttl)) {
			inflight = true;
			void refresh().catch(() => undefined).finally(() => { inflight = false; });
		}
		return cached?.list ?? { models: null, error: null, loading: true };
	};
}

export const availableModels = modelLister();
