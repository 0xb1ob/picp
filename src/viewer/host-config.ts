/**
 * `data/viewer.json` (keys `viewer.strict_host`, `viewer.public_url`): whether the local listener pins its exact bind
 * Host, the DNS-rebinding guard (off by default, operator decision ask-1946d8fc2bf8, so a proxied URL works), and the
 * public URL board links use. Nothing here writes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicUrlError } from "./public-url.ts";

export const viewerConfigFile = (stateDir: string): string => join(dirname(stateDir), "data", "viewer.json");

const KEYS = ["strict_host", "public_url"];

/** The file's object (absent: `{}`); unreadable, not an object or an unknown key throws, naming why. */
function readViewerFile(file: string): { strict_host?: unknown; public_url?: unknown } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => !KEYS.includes(key));
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the only keys are "strict_host" and "public_url"`);
	return raw;
}

function strictOf(file: string, raw: { strict_host?: unknown }): boolean {
	if (raw.strict_host !== undefined && typeof raw.strict_host !== "boolean") throw new Error(`${file}: strict_host must be true or false`);
	return raw.strict_host === true;
}

/** Absent file or keys: `strict_host` false, `public_url` null. Any other key or a bad value throws, naming why. */
export function loadViewerConfig(file: string): { strict_host: boolean; public_url: string | null } {
	const raw = readViewerFile(file);
	const strict = strictOf(file, raw);
	const url = raw.public_url;
	const why = url === undefined || url === null ? undefined : publicUrlError(url);
	if (why) throw new Error(`${file}: public_url ${why}`);
	return { strict_host: strict, public_url: typeof url === "string" ? url : null };
}

/** Read per request; a bad file or strict_host fails closed (strict), a bad public_url alone never does. */
export function strictHost(stateDir: string): boolean {
	const file = viewerConfigFile(stateDir);
	try {
		return strictOf(file, readViewerFile(file));
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
