/**
 * Install nudge (cp-install-nudge-5o4): the discovery half `install-tools`
 * (cp-lvo) was missing. Hermetic — `which` is injected, never a real PATH
 * lookup, so these tests never depend on what happens to be installed on the
 * machine running them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeInstallNudge } from "../src/install-nudge.ts";
import { REQUIRED_TOOLS } from "../src/tool-manifest.ts";

test("computeInstallNudge is silent when every required tool resolves", () => {
	const nudge = computeInstallNudge({ which: () => ["/usr/bin/tool"] });
	assert.equal(nudge, undefined);
});

test("computeInstallNudge names the exact install command when a tool is missing", () => {
	const nudge = computeInstallNudge({
		which: (command) => (command === "treehouse" ? [] : ["/usr/bin/tool"]),
	});
	assert.ok(nudge, "expected a nudge when treehouse is missing");
	assert.match(nudge as string, /treehouse/);
	assert.match(nudge as string, /npm run doctor:install/);
	// Never a second, silent auto-install or sudo suggestion.
	assert.doesNotMatch(nudge as string, /sudo\s+npm|sudo\s+node/);
	// Never the package name: other notifications (`/cp-version`, the T30
	// scaffold announce) are told apart from unrelated notify traffic by that
	// substring, and this message must not be mistaken for either of them.
	assert.doesNotMatch(nudge as string, /pi-command-post/);
});

test("computeInstallNudge lists every missing tool, not just the first", () => {
	const nudge = computeInstallNudge({ which: () => [] });
	assert.ok(nudge);
	for (const tool of REQUIRED_TOOLS) {
		assert.match(nudge as string, new RegExp(tool));
	}
});

test("computeInstallNudge never mutates anything: which is the only call it makes", () => {
	let calls = 0;
	computeInstallNudge({
		which: (command) => {
			calls += 1;
			return [`/opt/bin/${command}`];
		},
	});
	assert.equal(calls, REQUIRED_TOOLS.length);
});
