import assert from "node:assert/strict";
import test from "node:test";

test("importing an entry module with a missing process.argv[1] does not throw", async (t) => {
	const saved = process.argv[1];
	t.after(() => {
		process.argv[1] = saved as string;
	});
	process.argv[1] = "/nonexistent/entry-guard-probe.js";
	await assert.doesNotReject(import("../src/viewer/cli.ts"));
});
