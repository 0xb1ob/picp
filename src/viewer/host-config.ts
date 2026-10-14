/**
 * `data/viewer.json` (settings key `viewer.strict_host`): whether the local listener pins its exact bind Host, the
 * DNS-rebinding guard. Off by default (operator decision ask-1946d8fc2bf8) so a proxied URL works; nothing here writes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const viewerConfigFile = (stateDir: string): string => join(dirname(stateDir), "data", "viewer.json");

/** Absent file or key: `strict_host` false. Anything but `{"strict_host": <boolean>}` throws, naming why. */
export function loadViewerConfig(file: string): { strict_host: boolean } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { strict_host: false };
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => key !== "strict_host");
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the only key is "strict_host"`);
	const strict = (raw as { strict_host?: unknown }).strict_host;
	if (strict !== undefined && typeof strict !== "boolean") throw new Error(`${file}: strict_host must be true or false`);
	return { strict_host: strict === true };
}

/** Read per request; an invalid file fails closed (strict), and `/doctor` warns about it. */
export function strictHost(stateDir: string): boolean {
	try {
		return loadViewerConfig(viewerConfigFile(stateDir)).strict_host;
	} catch {
		return true;
	}
}
