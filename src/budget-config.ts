/**
 * The home budget config (`data/budgets.json`), read fresh per call — never cached at
 * construction (cp-sr5). Absent is `DEFAULT_BUDGET_CONFIG`; bad JSON or a schema miss throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BudgetConfig, BudgetConfigSchema, ContractError, DEFAULT_BUDGET_CONFIG, LAYOUT, validate } from "./contracts.ts";

export function loadBudgetConfig(home: string): BudgetConfig {
	const file = join(home, LAYOUT.budgetsFile);
	if (!existsSync(file)) return DEFAULT_BUDGET_CONFIG;
	let input: unknown;
	try {
		input = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new ContractError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const result = validate<BudgetConfig>(BudgetConfigSchema, input);
	if (!result.ok) {
		throw new Error(`${file} violates the budget contract:\n  ${result.errors.join("\n  ")}`);
	}
	return result.value;
}
