/**
 * Recent serialized screen responses per `principal|url`, the bases a delta request may name (server.ts `sendView`).
 * Strings, not objects, so a later in-place mutation of a projection cannot corrupt a base. Process memory only.
 */
import { randomBytes } from "node:crypto";

export const VIEW_VERSIONS_PER_KEY = 16;
export const VIEW_VERSIONS_MAX_BYTES = 48 * 1024 * 1024;

// Map order is recency: a touched key is re-inserted at the end, so the first key is the least recently used.
const store = new Map<string, Map<string, string>>();
let nonce = randomBytes(6).toString("hex"), counter = 0, bytes = 0;

function touch(key: string): Map<string, string> {
	const versions = store.get(key) ?? new Map<string, string>();
	store.delete(key);
	store.set(key, versions);
	return versions;
}

function dropOldest(key: string, versions: Map<string, string>): void {
	const [version, json] = versions.entries().next().value!;
	versions.delete(version);
	bytes -= json.length;
	if (!versions.size) store.delete(key);
}

export const viewVersions = {
	/** Stores `json` and returns its new version id: `<per-process nonce>-<n>`, so a pre-restart base never matches. */
	record(key: string, json: string): string {
		const version = `${nonce}-${++counter}`;
		const versions = touch(key);
		versions.set(version, json);
		bytes += json.length;
		if (versions.size > VIEW_VERSIONS_PER_KEY) dropOldest(key, versions);
		while (bytes > VIEW_VERSIONS_MAX_BYTES && store.size) {
			const [lru, oldest] = store.entries().next().value!;
			dropOldest(lru, oldest);
		}
		return version;
	},
	base(key: string, version: string): string | undefined {
		return store.get(key)?.get(version);
	},
	/** A test seam: forget every version and start a new nonce, as a restart would. */
	reset(): void {
		store.clear();
		bytes = 0;
		counter = 0;
		nonce = randomBytes(6).toString("hex");
	},
};
