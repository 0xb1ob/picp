/** Skip a repeat schema check of a state file whose text has not changed since it last passed (#561 event-loop lag). */
import { LEGACY_ROLE_ALIASES, normalizeLegacyRoles, type ValidationResult } from "./contracts.ts";

const passed = new Map<string, string>();
const ALIASES = Object.keys(LEGACY_ROLE_ALIASES).map((alias) => `"${alias}"`);

/** Count of real validations (cache misses); tests read it to prove an unchanged text is not re-checked. */
export const validationStats = { checks: 0 };

/**
 * `validate(parsed)` for `file`'s `text`, or the same answer without re-checking when this exact text passed before.
 * `validate` must be a pure function of the parsed text; a hit still applies the in-place role normalisation.
 */
export function validatedOnce<T>(file: string, text: string, parsed: unknown, validate: (value: unknown) => ValidationResult<T>): ValidationResult<T> {
	if (passed.get(file) === text) {
		return { ok: true, value: (ALIASES.some((alias) => text.includes(alias)) ? normalizeLegacyRoles(parsed) : parsed) as T };
	}
	validationStats.checks++;
	const result = validate(parsed);
	if (result.ok) passed.set(file, text);
	else passed.delete(file);
	return result;
}

/** Record that `text` was just validated and written to `file`, so the next read of it skips the check. */
export function markValidated(file: string, text: string): void {
	passed.set(file, text);
}
