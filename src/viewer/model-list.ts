/**
 * The models pi can use on this machine, for the Settings pickers: `pi --no-extensions --list-models` parsed by the
 * cp-install parser (src/service/models.ts). Read-only and cached in memory; a failure is a note, never an error for the page.
 */
import { execFile } from "node:child_process";
import { parseModelList } from "../service/models.ts";

export interface ModelList { models: string[] | null; error: string | null }
export type ListRun = () => Promise<{ status: number; stdout: string }>;

const TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;
const LIST_TIMEOUT_MS = 8_000;

const piList: ListRun = () => new Promise((resolve) => {
	execFile("pi", ["--no-extensions", "--list-models"], { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 << 20 }, (error, stdout) => {
		resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") });
	});
});

/** A lister with its own cache: one run in flight, a good list kept 5 minutes, a failure 30 seconds. */
export function modelLister(run: ListRun = piList, clock: () => number = Date.now): () => Promise<ModelList> {
	let cached: { at: number; ttl: number; list: ModelList } | undefined;
	let inflight: Promise<ModelList> | undefined;
	const load = async (): Promise<ModelList> => {
		const result = await run().catch(() => ({ status: 1, stdout: "" }));
		const models = result.status === 0 ? parseModelList(result.stdout) : undefined;
		const list: ModelList = models === undefined ? { models: null, error: "model list unavailable" } : models.length === 0 ? { models: null, error: "pi lists no usable models" } : { models, error: null };
		cached = { at: clock(), ttl: list.error ? FAILED_TTL_MS : TTL_MS, list };
		return list;
	};
	return () => {
		if (cached && clock() - cached.at < cached.ttl) return Promise.resolve(cached.list);
		inflight ??= load().finally(() => { inflight = undefined; });
		return inflight;
	};
}

export const availableModels = modelLister();
