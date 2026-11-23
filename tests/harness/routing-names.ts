import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "../../src/contracts.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { DEFAULT_ROUTING_CONFIG } from "../../src/routing.ts";
import { REPO_ROOT } from "./pi-child.ts";

type Row = { id: string; model: string; fallbacks?: string[] };

/**
 * Names `models` in `home`'s data/routing.json so an explicit override of them is routed, not refused.
 * Rows sit under a project no job has, so they never decide a route. A missing file is seeded from
 * DEFAULT_ROUTING_CONFIG (a direct home) or, with `seed: "template"`, from the shipped template (a tool home).
 */
export function routeNamed(home: string, models: readonly string[], options: { seed?: "template" } = {}): void {
	const file = join(home, LAYOUT.routingFile);
	const config = existsSync(file)
		? JSON.parse(readFileSync(file, "utf8"))
		: options.seed === "template"
			? JSON.parse(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"))
			: structuredClone(DEFAULT_ROUTING_CONFIG);
	const rubric = config.rubric as Row[];
	const routed = new Set(rubric.flatMap((row) => [row.model, ...(row.fallbacks ?? [])]));
	const missing = [...new Set(models)].filter((model) => !routed.has(model));
	if (missing.length === 0 && existsSync(file)) return;
	let k = rubric.filter((row) => row.id.startsWith("test-routed-names-")).length;
	const rows: Array<Row & { role: string; project: string }> = [];
	for (let at = 0; at < missing.length; at += 5, k++) {
		const [model, ...fallbacks] = missing.slice(at, at + 5) as [string, ...string[]];
		rows.push({ id: `test-routed-names-${k}`, role: "implementer", project: `__test-routed-names-${k}__`, model, ...(fallbacks.length ? { fallbacks } : {}) });
	}
	config.rubric = [...rows, ...rubric];
	// Atomic: concurrent child processes (gate-recovery races) read this file while another writes it.
	atomicWriteJson(file, config);
}

/**
 * cp-qmry: the configured CLI binds, so a native harness configures it the way Settings → Workers CLI does: `project`'s
 * rows for `roles` run `driver` on `model`, ahead of every other row. Re-running replaces this helper's earlier rows.
 */
export function routeDriver(home: string, driver: "claude" | "codex", model: string, options: { project?: string; roles?: readonly string[] } = {}): void {
	const file = join(home, LAYOUT.routingFile);
	const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : structuredClone(DEFAULT_ROUTING_CONFIG);
	const project = options.project ?? "demo";
	const rows = (options.roles ?? ["planner", "implementer"]).map((role) => ({ id: `harness-${driver}-${role}`, role, project, model, driver }));
	config.rubric = [...rows, ...(config.rubric as Row[]).filter((row) => !row.id.startsWith("harness-"))];
	config.allow = [...new Set([...(config.allow ?? []), model])];
	atomicWriteJson(file, config);
}
