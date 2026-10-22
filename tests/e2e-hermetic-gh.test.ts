import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertNoHostGh, resolveGh } from "./harness/gh-stub.ts";

// Every e2e spawn inherits a PATH whose first gh is the preload's stub, never the host's real gh.
test("the hermetic preload puts a deterministic gh stub first on PATH", () => {
	assert.match(resolveGh(process.env.PATH) ?? "", /cp-hermetic-gh-/);
	const login = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
	assert.equal(login.stdout.trim(), "cp-e2e-stub");
	assert.equal(spawnSync("gh", ["pr", "list"], { encoding: "utf8" }).status, 1);
	assert.equal(process.env.GH_TOKEN, undefined);
});

test("a spawn PATH that resolves a host gh is refused", () => {
	const host = resolveGh(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":"));
	if (host) assert.throws(() => assertNoHostGh("/usr/bin:/usr/local/bin:/opt/homebrew/bin"), /host gh/);
	assertNoHostGh(process.env.PATH);
});
