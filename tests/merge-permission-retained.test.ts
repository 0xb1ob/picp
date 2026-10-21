import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCiWait } from "../src/ci-wait.ts";
import { ghBranchRulesArgs } from "../src/merge-permission.ts";

test("no command this module can build is a blocking CI-wait shape", () => {
	assert.equal(detectCiWait(`gh ${ghBranchRulesArgs("main").join(" ")}`), undefined);
});
