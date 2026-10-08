/** The parent model resolvers `cp_parent start` uses; moved out of cp-bridge.ts unchanged (size cap), re-exported there. */
import { CpBridgeError } from "./cp-bridge.ts";
import type { ModelProbe } from "./routing.ts";

/**
 * cp-0wq7/cur.5.4: never invent a parent model. `CP_PARENT_MODEL`, then the
 * operator session's own model (explicit `sessionModel`, which the caller
 * builds from `ctx.model` or `PI_PROVIDER`+`PI_MODEL`), then refuse naming
 * both options.
 */
export function resolveParentModel(
	env: { CP_PARENT_MODEL?: string; PI_PROVIDER?: string; PI_MODEL?: string },
	sessionModel?: string,
): string {
	const fromEnv = env.CP_PARENT_MODEL?.trim();
	if (fromEnv) return fromEnv;
	if (sessionModel?.trim()) return sessionModel.trim();
	const provider = env.PI_PROVIDER?.trim();
	const modelId = env.PI_MODEL?.trim();
	if (provider && modelId) return `${provider}/${modelId}`;
	throw new CpBridgeError(
		"cp_parent start needs a model: set CP_PARENT_MODEL, or run the operator with a model selected " +
			"(PI_PROVIDER/PI_MODEL or --model) so its own model is reused",
	);
}

/** Refuse an unknown/unauthenticated model before spawn, naming what pi does know. */
export function requireAvailableParentModel(model: string, probe: ModelProbe): void {
	if (probe.isAvailable(model)) return;
	const available = probe.available?.() ?? [];
	throw new CpBridgeError(
		`cp_parent start refuses ${model}: not available (unknown to pi, or its provider has no configured auth). ` +
			`Known: ${available.join(", ") || "(none)"}.`,
	);
}
