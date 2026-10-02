/**
 * The write half of the viewer's model-window snapshot (src/viewer/context-usage.ts):
 * `provider/id → contextWindow` from pi's `ctx.modelRegistry`, recorded by the parent at
 * session start. The viewer may not import pi, so this is how it learns the windows.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";
import { MODEL_WINDOWS_FILE } from "./viewer/context-usage.ts";

/** Structural view of pi's `ModelRegistry.getAll()`. */
export interface ModelWindowRegistry {
	getAll(): Array<{ provider?: string; id?: string; contextWindow?: number }>;
}

/** Write the snapshot when it changed; returns how many windows it holds. */
export function recordModelWindows(home: string, registry: ModelWindowRegistry, now = new Date()): number {
	const windows: Record<string, number> = {};
	for (const model of registry.getAll()) {
		if (model.provider && model.id && typeof model.contextWindow === "number" && model.contextWindow > 0) windows[`${model.provider}/${model.id}`] = model.contextWindow;
	}
	const file = join(home, LAYOUT.state, MODEL_WINDOWS_FILE);
	let prior: unknown;
	try { prior = (JSON.parse(readFileSync(file, "utf8")) as { windows?: unknown }).windows; } catch { prior = undefined; }
	if (JSON.stringify(prior) !== JSON.stringify(windows)) atomicWriteJson(file, { recorded_at: now.toISOString(), windows });
	return Object.keys(windows).length;
}
