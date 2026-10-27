/** F2 (#561 lag): unchanged schedule-run and mandate files skip re-validation; invalid or changed text never does. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { MandateStore } from "../../src/mandate.ts";
import { policyFromLegacy } from "../../src/viewer/schedule-policy.ts";
import { readScheduleRuns, type ScheduleRun } from "../../src/viewer/schedule-run-core.ts";
import { createScratchHome } from "../harness/index.ts";

const at = "2026-07-01T06:00:00Z";
const policy = (id: string) => policyFromLegacy({ id, name: "Nightly", project: "demo", mandate_id: "md-123456", enabled: true, created_at: at, trigger: { type: "manual" }, job: { title: "Nightly", kind: "research", delivery: "answer", description: "d" } }, {
	seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 3,
	allowed_actions: ["plan", "review"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run it", decided_by: "operator-quote", approved_at: at },
});
const runs = (n: number): ScheduleRun[] => Array.from({ length: n }, (_, i) => {
	const sid = `sch-${i.toString(16).padStart(6, "0")}`;
	return {
	schema_version: 1, id: `run-20260701060000-${i.toString(16).padStart(6, "0")}`, schedule_id: sid, policy_revision: 1, policy: policy(sid),
	trigger: { via: "slot", at }, anchor_job_id: null, members: [], phase: "accepted", outcome: null, started_at: at, deadline_at: "2026-07-01T07:00:00Z", risk_preapproved: [], authority_log: [], cap_notices: [],
} as ScheduleRun;
});
const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("schedule runs read: an unchanged file skips re-validation, a changed or invalid one never does", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = `${home.path}/state/schedule-runs.json`;
	mkdirSync(dirname(file), { recursive: true });
	const write = (list: ScheduleRun[], pad = 0) => writeFileSync(file, JSON.stringify({ schema_version: 1, runs: list }) + " ".repeat(pad));
	const big = runs(1_500);
	// Distinct trailing whitespace makes each text new (validated) with identical parse cost; a repeat read is a hit.
	const cold = median(Array.from({ length: 5 }, (_, i) => { write(big, i + 1); return ms(() => readScheduleRuns(file)); }));
	write(big, 99);
	readScheduleRuns(file);
	const warm = median(Array.from({ length: 5 }, () => ms(() => readScheduleRuns(file))));
	assert.ok(warm < cold * 0.6, `unchanged reads (${warm.toFixed(1)} ms) should beat first reads of new text (${cold.toFixed(1)} ms)`);
	assert.equal(readScheduleRuns(file).length, 1_500);

	const bad = runs(2);
	bad[1]!.id = bad[0]!.id;
	write(bad);
	for (let i = 0; i < 3; i++) assert.throws(() => readScheduleRuns(file), /duplicate run id/, "an invalid file throws on every read");
	write(runs(2));
	assert.equal(readScheduleRuns(file).length, 2, "a corrected file re-validates and reads");
	writeFileSync(file, readFileSync(file, "utf8").replace('"accepted"', '"bogus"'));
	assert.throws(() => readScheduleRuns(file), /schedule run contract/, "a valid file changed to invalid throws");
});

test("mandate get: a changed or invalid mandate file throws on every read, a restored one reads", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const grant = store.issue({ projects: ["demo"], objective: "ship the bump", expiry: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z"), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 }, []);
	const file = store.file(grant.id);
	const good = readFileSync(file, "utf8");
	assert.equal(store.get(grant.id)?.objective, "ship the bump");
	assert.equal(store.get(grant.id)?.objective, "ship the bump");
	writeFileSync(file, good.replace('"job_cap": 10', '"job_cap": "ten"'));
	for (let i = 0; i < 3; i++) assert.throws(() => store.get(grant.id), /violates the mandate contract/);
	writeFileSync(file, good);
	assert.equal(store.get(grant.id)?.id, grant.id);
});
