/** The models data/routing.json names: an explicit model must be one of them, never a new one. */

import { Value } from "typebox/value";
import { ReviewerModelSchema, RISKS, type Role, ROLES, type RoutingConfig, SCOPES } from "./contracts.ts";
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

/** A reviewer preference's write-time check; a malformed value passes through to its store's own schema refusal. */
export function requireRoutedPreference(config: () => RoutingConfig, model: string, where: string): void {
	if (Value.Check(ReviewerModelSchema, model.trim())) requireRouted(config(), model.trim(), where);
}

/** Roles with a scope/risk cell (`S/low`, …) no project-free rubric row matches: such a job is refused `unrouted`. */
export function uncoveredRoles(config: RoutingConfig): Array<{ role: Role; cells: string[] }> {
	const covers = (role: Role, scope: string, risk: string) => config.rubric.some((row) => row.role === role &&
		row.project === undefined && (!row.scope || row.scope.some((each) => each === scope)) && (row.risk ?? risk) === risk);
	return ROLES.map((role) => ({ role, cells: SCOPES.flatMap((scope) => RISKS.filter((risk) => !covers(role, scope, risk))
		.map((risk) => `${scope}/${risk}`)) })).filter((entry) => entry.cells.length > 0);
}
