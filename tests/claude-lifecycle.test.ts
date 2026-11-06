/**
 * N4e units: native turn classification and the idle-prompt admission. The e2e cases need `claude` on PATH and CI
 * skips them, so the pure lifecycle logic the worker calls is pinned here too.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyTurn, nativeRunStop, startIdlePrompt, type TurnFacts } from "../src/drivers/claude-lifecycle.ts";

const clean: TurnFacts = { reported: false, resultSubtype: "success", lockdown: "ok", observations: [] };

test("N4e: a finished native turn is reported, settles, hits the turn limit or stops by name", () => {
	assert.deepEqual(classifyTurn({ ...clean, reported: true, lockdown: "refused" }), { kind: "reported" });
	// An unreported clean success settles idle; restoring the old exit would make this a stop.
	assert.deepEqual(classifyTurn(clean), { kind: "settle" });
	assert.deepEqual(classifyTurn({ ...clean, resultSubtype: "error_max_turns" }), { kind: "turn_limit" });
	assert.deepEqual(classifyTurn({ ...clean, lockdown: "refused" }), { kind: "stop", stop: "lockdown" });
	assert.deepEqual(classifyTurn({ ...clean, isError: true, observations: [{ kind: "auth", code: "authentication_failed" }] }), { kind: "stop", stop: "auth" });
	const spent = { ...clean, isError: true, observations: [{ kind: "window" as const, window: "five_hour" as const, status: "rejected" as const, resets_at: 1_900_000_000_000 }] };
	assert.deepEqual(classifyTurn(spent), { kind: "stop", stop: "window", window: "five_hour", resets_at: 1_900_000_000_000 });
	assert.deepEqual(classifyTurn({ ...clean, observations: [{ kind: "window", window: "seven_day", status: "allowed_warning" }] }), { kind: "settle" });
	for (const facts of [{ ...clean, isError: true }, { ...clean, error: "boom" }, { ...clean, resultSubtype: undefined }, { ...clean, lockdown: "unchecked" }]) {
		assert.deepEqual(classifyTurn(facts), { kind: "stop", stop: "other" }, JSON.stringify(facts));
	}
	assert.deepEqual(nativeRunStop(classifyTurn(spent), 500).fields, { stop: "window", window: "five_hour", resets_at: 1_900_000_000_000 });
	assert.deepEqual(nativeRunStop({ kind: "turn_limit" }, 3).fields, { stop: "max_turns" });
	assert.deepEqual(nativeRunStop({ kind: "settle" }, 3), { fields: {} });
	assert.deepEqual(nativeRunStop({ kind: "stop", stop: "other" }, 3), { fields: {} });
});

test("N4e: an idle prompt whose resume admission refuses is refused by name and starts no turn", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cp-n4e-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	let started = 0;
	const start = () => void started++;
	// The real admission: a home with no native fleet record refuses before any turn.
	const real = await startIdlePrompt({ home, jobId: "cp-n4e-x", resumed: true }, start);
	assert.match(real ?? "", /^refused: resume of native cp-n4e-x: no native fleet record\. Nothing was resumed\.$/);
	const frozen = await startIdlePrompt({ home, jobId: "cp-n4e-x", resumed: true }, start, async () => {
		throw new Error("refused: resume of native cp-n4e-x: the home is draining");
	});
	assert.match(frozen ?? "", /draining\. Nothing was resumed\.$/);
	assert.equal(started, 0, "a refused admission started a turn");
	// An admitted resume starts once; a dispatched first turn needs no second admission.
	let admitted = 0;
	assert.equal(await startIdlePrompt({ home, jobId: "cp-n4e-x", resumed: true }, start, async () => void admitted++), undefined);
	assert.equal(await startIdlePrompt({ home, jobId: "cp-n4e-x", resumed: false }, start, async () => assert.fail("admitted a first turn")), undefined);
	assert.deepEqual([admitted, started], [1, 2]);
});
