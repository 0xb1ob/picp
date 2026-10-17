import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetRecord } from "../src/contracts.ts";
import { riskGateExempt } from "../src/dispatch-authority.ts";
import { assertResourcesFree, opsClass, opsRequest } from "../src/ops-jobs.ts";

const job = (id: string, ...labels: string[]) => ({ id, labels: ["project:demo", "delivery:local", "kind:research", ...labels] });

test("opsClass reads one known ops:<class> label and refuses two or an unknown one", () => {
	assert.equal(opsClass(job("cp-a")), undefined);
	assert.equal(opsClass(job("cp-a", "ops:deploy")), "deploy");
	assert.throws(() => opsClass(job("cp-a", "ops:pull", "ops:deploy")), /exactly one ops:<pull\|deploy\|process>/);
	assert.throws(() => opsClass(job("cp-a", "ops:reboot")), /ops:reboot/);
});

test("opsRequest: deploy/process are always high, a pull defaults low, and the ops profile pairs with an ops label", () => {
	assert.deepEqual(opsRequest({ risk: "low" as const }, job("cp-a", "ops:deploy"), "research", "local"), { risk: "high", profile: "ops" });
	assert.equal(opsRequest({}, job("cp-a", "ops:process"), "research", "local").risk, "high");
	assert.equal(opsRequest({}, job("cp-a", "ops:pull"), "research", "local").risk, "low");
	assert.equal(opsRequest({}, job("cp-a", "ops:pull", "risk:high"), "research", "local").risk, "high", "a recorded high still wins");
	const plain = { profile: "planner" };
	assert.equal(opsRequest(plain, job("cp-a"), "research", "local"), plain, "a non-ops job is untouched");
	assert.throws(() => opsRequest({ profile: "ops" }, job("cp-a"), "research", "local"), /needs an ops:/);
	assert.throws(() => opsRequest({ profile: "planner" }, job("cp-a", "ops:pull"), "research", "local"), /runs the ops profile, not planner/);
	assert.throws(() => opsRequest({}, job("cp-a", "ops:pull"), "ship", "pr"), /kind:research delivery:local/);
});

test("riskGateExempt never exempts an ops job, even with a read-only profile", () => {
	assert.equal(riskGateExempt({ kind: "research", readOnly: true }), true);
	assert.equal(riskGateExempt({ kind: "research", readOnly: true, ops: true }), false);
});

test("a resource:<name> label is leased while its holder is live and free once it is torn down (phase done)", () => {
	const record = (job_id: string, phase: string) => ({ job_id, phase }) as unknown as FleetRecord;
	const holder = job("cp-hold", "ops:pull", "resource:tg-session");
	const wanting = job("cp-want", "ops:pull", "resource:tg-session");
	assert.throws(() => assertResourcesFree(wanting, [record("cp-hold", "held")], [holder, wanting]), /resource:tg-session is leased by live job cp-hold/);
	assert.doesNotThrow(() => assertResourcesFree(wanting, [record("cp-hold", "done")], [holder, wanting]));
	assert.doesNotThrow(() => assertResourcesFree(wanting, [record("cp-want", "failed")], [wanting]), "its own re-dispatch is not a conflict");
	assert.doesNotThrow(() => assertResourcesFree(job("cp-b", "resource:mt5-2"), [record("cp-hold", "held")], [holder]));
});
