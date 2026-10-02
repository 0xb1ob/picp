/**
 * cp-lvo: the no-drift guarantee between `doctor.ts` (diagnoses) and
 * `install-tools.ts` (installs).
 *
 * `TOOL_INSTALL` is typed as `Record<RequiredTool, ToolInstallSpec>`, so a
 * tool added to `REQUIRED_TOOLS` without an install spec here is a
 * *typecheck* failure (`npm run typecheck`, which `npm test` always runs
 * first) — not a gap either of these tests could miss. This file pins the
 * runtime half of that: `doctor.ts` imports the very same array, not a copy
 * of its values.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_TOOLS as DOCTOR_REQUIRED_TOOLS } from "../src/doctor.ts";
import { installScriptHint, OPTIONAL_TOOL_INFO, OPTIONAL_TOOLS, REQUIRED_TOOLS, TOOL_INSTALL } from "../src/tool-manifest.ts";

test("doctor.ts's REQUIRED_TOOLS is the same array as tool-manifest.ts's, not a copy", () => {
	assert.equal(DOCTOR_REQUIRED_TOOLS, REQUIRED_TOOLS, "identity, not just equal values — a second list would drift silently");
});

test("every required tool has an install spec for both supported platforms", () => {
	for (const tool of REQUIRED_TOOLS) {
		const spec = TOOL_INSTALL[tool];
		assert.ok(spec, `missing TOOL_INSTALL entry for ${tool}`);
		assert.equal(spec.tool, tool);
		assert.ok(spec.macos, `missing macos install step for ${tool}`);
		assert.ok(spec.linux, `missing linux install step for ${tool}`);
	}
});

test("TOOL_INSTALL has no entries beyond REQUIRED_TOOLS", () => {
	assert.deepEqual(Object.keys(TOOL_INSTALL).sort(), [...REQUIRED_TOOLS].sort());
});

test("installScriptHint names the real script for every tool", () => {
	for (const tool of REQUIRED_TOOLS) {
		assert.equal(installScriptHint(tool), `node scripts/install-tools.ts ${tool}`);
	}
});

test("optional tools are never required, and each says why and how to get it", () => {
	for (const tool of OPTIONAL_TOOLS) {
		assert.ok(!(REQUIRED_TOOLS as readonly string[]).includes(tool), `${tool} is optional`);
		assert.ok(OPTIONAL_TOOL_INFO[tool].why && OPTIONAL_TOOL_INFO[tool].install, tool);
	}
	assert.ok(!/https?:/.test(OPTIONAL_TOOL_INFO.br.install), "br's install is not a guessed URL");
});
