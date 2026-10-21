import assert from "node:assert/strict";
import test from "node:test";

test("importing entry modules with a missing process.argv[1] does not throw", async (t) => {
	const saved = process.argv[1];
	t.after(() => {
		process.argv[1] = saved as string;
	});
	process.argv[1] = "/nonexistent/entry-guard-probe.js";
	for (const m of ["viewer/cli", "viewer/operator", "service/daemon", "service/health", "tunnel/cli"]) {
		await assert.doesNotReject(import(`../src/${m}.ts`), m);
	}
});
