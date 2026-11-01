import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYOUT } from "../../src/contracts.ts";
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
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
