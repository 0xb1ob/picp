import { realpathSync } from "node:fs";

/** realpath of a script path, or undefined when it is missing: an entry guard must never throw at import. */
export function entryRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}
