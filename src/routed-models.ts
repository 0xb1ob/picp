/** The models data/routing.json names: an explicit model must be one of them, never a new one. */

import type { RoutingConfig } from "./contracts.ts";
import { boundedList, RoutingError } from "./routing.ts";

/** Every rubric row's `model` and `fallbacks`, in file order, de-duplicated. */
export function routedModels(config: RoutingConfig): string[] {
	return [...new Set(config.rubric.flatMap((row) => [row.model, ...(row.fallbacks ?? [])]))];
}

/** Throws `RoutingError` (`refusal: "unrouted"`) when `model` is not one `config` routes; `where` names its source. */
export function requireRouted(config: RoutingConfig, model: string, where: string): void {
	const routed = routedModels(config);
	if (routed.includes(model)) return;
	throw new RoutingError(
		`${where} names ${model}, which data/routing.json does not route: an explicit model must be one routing.json ` +
			`already names (a rubric row's model or fallbacks), so it is refused, never substituted. Omit the model to let ` +
			`routing decide, or add ${model} to a rubric row in data/routing.json (dashboard Settings → models). ` +
			`Routed: ${boundedList(routed, { max: 8, cap: 400, separator: ", " }) || "(none)"}.`,
		{ refusal: "unrouted" },
	);
}
