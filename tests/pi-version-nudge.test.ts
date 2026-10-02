/**
 * pi version nudge (cp-056q). Hermetic: PATH, the filesystem and `pi --version`
 * are all injected, so these tests never depend on which pi happens to be
 * installed on the machine running them — the exact condition the nudge exists
 * to describe.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { computePiVersionNudge, PI_PACKAGE_PATH } from "../src/pi-version-nudge.ts";

const ROOT = "/repo";
const INSTALLED = join(ROOT, PI_PACKAGE_PATH);
const OURS = join(ROOT, "node_modules", ".bin", "pi");
const HOST = "/usr/local/bin/pi";

/** A machine where everything is readable; each test bends one fact. */
function machine(overrides: {
	installed?: string | undefined;
	paths?: string[];
	hostVersion?: string | undefined;
}) {
	const installed = "installed" in overrides ? overrides.installed : `{"version":"0.84.4"}`;
	return {
		packageRoot: ROOT,
		which: () => overrides.paths ?? [OURS, HOST],
		readFile: (path: string) => (path === INSTALLED ? installed : undefined),
		probeVersion: (path: string) =>
			path === HOST ? ("hostVersion" in overrides ? overrides.hostVersion : "0.85.0") : "0.84.4",
	};
}

test("a mismatch warns, naming both versions, package.json and npm install", () => {
	const nudge = computePiVersionNudge(machine({}));
	assert.ok(nudge, "expected a warning when 0.84.4 is installed and 0.85.0 is running");
	assert.match(nudge as string, /0\.84\.4/, "the installed version");
	assert.match(nudge as string, /0\.85\.0/, "the running host version");
	assert.match(nudge as string, /package\.json/, "the file to change");
	assert.match(nudge as string, /npm install/, "the command to run");
	assert.match(nudge as string, /@earendil-works\/pi-coding-agent/, "the dependency to change");
	// Never the package name: other notifications (`/cp-version`, the scaffold
	// announce) are told apart from unrelated notify traffic by that substring.
	assert.doesNotMatch(nudge as string, /pi-command-post/);
});

test("matching versions are silent", () => {
	assert.equal(computePiVersionNudge(machine({ hostVersion: "0.84.4" })), undefined);
	// Same version, noisier spelling on the host probe: still a match.
	assert.equal(computePiVersionNudge(machine({ hostVersion: "pi 0.84.4\n" })), undefined);
});

test("no resolvable host pi is silent: unknown is not a mismatch", () => {
	// Nothing on PATH at all.
	assert.equal(computePiVersionNudge(machine({ paths: [] })), undefined);
	// Only our own node_modules/.bin answers — comparing the installed copy
	// against itself would never warn, and pretending otherwise would warn on a
	// machine with one pi.
	assert.equal(computePiVersionNudge(machine({ paths: [OURS] })), undefined);
});

test("an unreadable host version is silent", () => {
	assert.equal(computePiVersionNudge(machine({ hostVersion: undefined })), undefined);
	assert.equal(computePiVersionNudge(machine({ hostVersion: "" })), undefined);
	assert.equal(computePiVersionNudge(machine({ hostVersion: "unknown build" })), undefined);
});

test("an absent or unreadable installed package is silent", () => {
	assert.equal(computePiVersionNudge(machine({ installed: undefined })), undefined);
	assert.equal(computePiVersionNudge(machine({ installed: "{not json" })), undefined);
	assert.equal(computePiVersionNudge(machine({ installed: "{}" })), undefined);
	assert.equal(computePiVersionNudge(machine({ installed: `{"version":"nightly"}` })), undefined);
});

test("it never throws: a probe that explodes is silence, not a failed startup", () => {
	const boom = () => {
		throw new Error("PATH is on fire");
	};
	assert.equal(
		computePiVersionNudge({
			packageRoot: ROOT,
			which: boom,
			readFile: () => `{"version":"0.84.4"}`,
			probeVersion: () => "0.85.0",
		}),
		undefined,
	);
	assert.equal(
		computePiVersionNudge({ ...machine({}), probeVersion: boom }),
		undefined,
	);
});

test("the host pi is never probed when there is no installed copy to compare it to", () => {
	let probes = 0;
	const nudge = computePiVersionNudge({
		packageRoot: ROOT,
		which: () => [HOST],
		readFile: () => undefined,
		probeVersion: () => {
			probes += 1;
			return "0.85.0";
		},
	});
	assert.equal(nudge, undefined);
	assert.equal(probes, 0, "no spawn on a machine that has nothing to say");
});
