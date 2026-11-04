/**
 * `data/viewer.json` (settings keys `viewer.strict_host`, `viewer.public_url`): whether the local listener pins its exact
 * bind Host, the DNS-rebinding guard (off by default, operator decision ask-1946d8fc2bf8, so a proxied URL works), and
 * the public URL board links use. Nothing here writes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicUrlError } from "../contracts.ts";

export const viewerConfigFile = (stateDir: string): string => join(dirname(stateDir), "data", "viewer.json");

const KEYS = ["strict_host", "public_url"];

/** Absent file or keys: `strict_host` false, `public_url` null. Any other key or a bad value throws, naming why. */
export function loadViewerConfig(file: string): { strict_host: boolean; public_url: string | null } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { strict_host: false, public_url: null };
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => !KEYS.includes(key));
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the only keys are "strict_host" and "public_url"`);
	const { strict_host: strict, public_url: url } = raw as { strict_host?: unknown; public_url?: unknown };
	if (strict !== undefined && typeof strict !== "boolean") throw new Error(`${file}: strict_host must be true or false`);
	const why = url === undefined || url === null ? undefined : publicUrlError(url);
	if (why) throw new Error(`${file}: public_url ${why}`);
	return { strict_host: strict === true, public_url: typeof url === "string" ? url : null };
}

/** Read per request; an invalid file fails closed (strict), and `/doctor` warns about it. */
export function strictHost(stateDir: string): boolean {
	try {
		return loadViewerConfig(viewerConfigFile(stateDir)).strict_host;
	} catch {
		return true;
	}
}

/** `viewer.public_url` read at link time, trailing slashes dropped; unset or an invalid file is undefined. */
export function publicUrl(stateDir: string): string | undefined {
	try {
		return loadViewerConfig(viewerConfigFile(stateDir)).public_url?.replace(/\/+$/, "") || undefined;
	} catch {
		return undefined;
	}
}
