/** The per-row driver, effort and allowlist checks a Settings rubric write is refused on, each tagged by field. */
import type { RoutingConfig, RoutingRule } from "./contracts.ts";
import { isNativeModel, NATIVE_EFFORTS } from "./drivers/claude.ts";
import { CODEX_EFFORTS, codexPersistRefusal, codexRowClass, isCodexModel } from "./drivers/codex.ts";
import { deniedFor, isAllowed } from "./routing.ts";

/** What a claude parent or row may run: off, plus the levels the SDK serves as `effort` (`assertNativeEffort`). */
export const claudeEfforts = (): readonly string[] => ["off", ...NATIVE_EFFORTS];

export interface RowRefusal {
	field: "model" | "thinking" | "driver";
	message: string;
}

/** `prior` is the same row as the file held it (legacy roles normalised); absent, every check applies. */
export function routingRowRefusals(
	home: string, config: RoutingConfig, row: RoutingRule, prior?: Record<string, unknown>,
): RowRefusal[] {
	const out: RowRefusal[] = [];
	const add = (field: RowRefusal["field"], message: string): void => void out.push({ field, message });
	const { id, model, thinking, driver } = row;
	// Evaluated per call: drivers/claude.ts reaches this module through doctor.ts and scaffold.ts (an import cycle).
	const claude = claudeEfforts(), gpt: readonly string[] = CODEX_EFFORTS;
	// Condition 2 (C1b): while codex is off, picp writes no new or changed codex row; an unchanged hand-written one stays.
	const kept = prior !== undefined && JSON.stringify(prior) === JSON.stringify(row);
	const off = driver === "codex" && !kept ? codexPersistRefusal(home, `row ${id}`, codexRowClass(row.role)) : undefined;
	if (off !== undefined) add("driver", off);
	if (driver === "claude" && !isNativeModel(model)) {
		add("model", `row ${id}: the Claude CLI runs only an anthropic/claude-… model, not ${model}; pick one for this row`);
	}
	if (driver === "claude" && thinking !== undefined && !claude.includes(thinking)) {
		add("thinking", `row ${id}: thinking ${thinking} has no Claude effort; use ${claude.join(", ")}`);
	}
	if (driver === "codex" && !isCodexModel(model)) {
		add("model", `row ${id}: the Codex CLI runs only an openai/gpt-… model, not ${model}`);
	}
	if (driver === "codex" && thinking !== undefined && !gpt.includes(thinking)) {
		add("thinking", `row ${id}: thinking ${thinking} has no Codex effort; use ${gpt.join(", ")}`);
	}
	const toCodex = driver === "codex" && prior?.driver !== "codex";
	if (prior?.model === model && !toCodex) return out;
	if (!isAllowed(config, model)) {
		add("model", `row ${id}: models.allow does not permit ${model}, so routing would refuse it`);
	}
	const pattern = deniedFor(config, row.role, model);
	if (pattern !== undefined) add("model", `row ${id}: deny_by_role.${row.role} matches ${pattern} for ${model}`);
	return out;
}
