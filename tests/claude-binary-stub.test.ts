/**
 * The Agent SDK's 8 bundled-binary packages resolve to empty in-repo workspace stubs, never a registry tarball (T3 drops
 * them too). A stub version that drifts from the SDK's pin would let npm fetch the real 323 MB binary, so it fails here.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const STUBS = join(ROOT, "vendor", "claude-binary-stub");
const SDK = "node_modules/@anthropic-ai/claude-agent-sdk";

interface LockEntry {
	resolved?: string;
	link?: boolean;
	name?: string;
	version?: string;
	optionalDependencies?: Record<string, string>;
}

test("claude-binary-stub: every SDK platform package is a workspace link to a package.json-only stub at the SDK's pin", () => {
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };
	const pinned = lock.packages[SDK]?.optionalDependencies ?? {};
	assert.equal(Object.keys(pinned).length, 8, JSON.stringify(pinned));

	const platformEntries = Object.entries(lock.packages).filter(([key]) => /(^|\/)@anthropic-ai\/claude-agent-sdk-[\w-]+$/.test(key));
	assert.equal(platformEntries.length, 8, platformEntries.map(([key]) => key).join("\n"));
	for (const [key, entry] of platformEntries) {
		assert.equal(entry.link, true, `${key} must be a workspace link, not a tarball`);
		assert.match(entry.resolved ?? "", /^vendor\/claude-binary-stub\/[\w-]+$/, key);
	}

	const stubs = readdirSync(STUBS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	assert.equal(stubs.length, 8);
	const seen: string[] = [];
	for (const dir of stubs) {
		assert.deepEqual(readdirSync(join(STUBS, dir)), ["package.json"], `${dir} has files beyond package.json`);
		const stub = JSON.parse(readFileSync(join(STUBS, dir, "package.json"), "utf8")) as LockEntry & Record<string, unknown>;
		assert.deepEqual(Object.keys(stub).sort(), ["description", "name", "private", "version"], dir);
		assert.equal(stub.name, `@anthropic-ai/claude-agent-sdk-${dir}`);
		assert.equal(stub.version, pinned[stub.name], `${dir}: stub version must equal the SDK's pinned optional version`);
		seen.push(stub.name);
	}
	assert.deepEqual(seen.sort(), Object.keys(pinned).sort());
});
