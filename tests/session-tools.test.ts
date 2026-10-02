import assert from "node:assert/strict";
import { test } from "node:test";
import {
	foreignSessionTools,
	guessCapabilities,
	isExpectedParentTool,
	isUncovered,
	PARENT_BUILTIN_TOOLS,
	snapshotSessionTools,
} from "../src/session-tools.ts";

test("pi builtins and cp_* tools are expected; anything else is foreign", () => {
	for (const name of PARENT_BUILTIN_TOOLS) {
		assert.equal(isExpectedParentTool({ name }), true, name);
	}
	assert.equal(isExpectedParentTool({ name: "cp_dispatch" }), true);
	assert.equal(isExpectedParentTool({ name: "cp_artifact" }), true);
	assert.equal(
		isExpectedParentTool({ name: "something_else", source: "/x/extensions/command-post/index.ts" }),
		true,
	);
	assert.equal(
		isExpectedParentTool({
			name: "lens_read",
			source: "/Users/x/.treehouse/pi-command-post-abc/7/pi-command-post/tests/fixtures/foreign-file-tool.ts",
		}),
		false,
		"a path that merely contains the string command-post is not ours",
	);
	assert.equal(isExpectedParentTool({ name: "read_symbol" }), false);
	assert.equal(isExpectedParentTool({ name: "lens_read" }), false);
});

test("capability guess from name and schema", () => {
	assert.deepEqual(guessCapabilities({ name: "read_symbol" }), ["file_read"]);
	assert.deepEqual(guessCapabilities({ name: "ast_grep_search" }), ["file_read"]);
	assert.deepEqual(
		guessCapabilities({ name: "lens_read", parameters: { properties: { path: { type: "string" } } } }),
		["file_read"],
	);
	assert.deepEqual(guessCapabilities({ name: "run_shell" }), ["shell"]);
	assert.deepEqual(
		guessCapabilities({ name: "exec_thing", parameters: { properties: { command: { type: "string" } } } }),
		["shell"],
	);
	assert.deepEqual(guessCapabilities({ name: "fetch_content" }), ["network"]);
	assert.deepEqual(
		guessCapabilities({ name: "lookup", parameters: { properties: { url: { type: "string" } } } }),
		["network"],
	);
	assert.ok(isUncovered({ capabilities: ["file_read"] }));
	assert.ok(isUncovered({ capabilities: ["shell"] }));
	assert.equal(isUncovered({ capabilities: ["network"] }), false);
});

test("snapshot records capabilities; foreign list drops expected tools", () => {
	const snap = snapshotSessionTools([
		{ name: "read", sourceInfo: { path: "builtin", source: "builtin" } },
		{ name: "cp_dispatch", sourceInfo: { path: "/repo/extensions/command-post/index.ts", source: "extension" } },
		{
			name: "lens_read",
			parameters: { properties: { path: { type: "string" } } },
			sourceInfo: { path: "/home/.pi/agent/extensions/pi-lens.ts", source: "extension" },
		},
		{ name: "fetch_url", sourceInfo: { path: "/home/.pi/agent/extensions/fetch.ts", source: "extension" } },
	]);
	const foreign = foreignSessionTools(snap);
	assert.deepEqual(
		foreign.map((tool) => tool.name),
		["lens_read", "fetch_url"],
	);
	assert.deepEqual(foreign[0]?.capabilities, ["file_read"]);
	assert.ok(isUncovered(foreign[0]!));
	assert.deepEqual(foreign[1]?.capabilities, ["network"]);
	assert.equal(isUncovered(foreign[1]!), false);
});
