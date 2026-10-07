/**
 * Crash window in prepareGateReplacement: inherited gate-N.json can land
 * before gate-replacement.json. A retry accepts that history only when it
 * is exactly the inherited decisions; anything else still refuses.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { EMPTY_USAGE, type GateFlags, type GateVerdict, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { prepareGateReplacement } from "../src/gate-replacement.ts";
import { decideGate, readPriorAttempts } from "../src/gate.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import type { Ledger } from "../src/ledger.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

const FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const REFUSED = /already has an artifact or gate history/;

function verdict(jobId: string, attempt: number, kind: "revise" | "escalate", reason: string): GateVerdict {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		attempt,
		verdict: kind,
		cause: kind === "revise" ? null : "operational",
		flags: { ...FLAGS },
		reasons: [reason],
		...(kind === "revise" ? { revisions: ["name the exact commands"] } : {}),
		model: "mock/reviewer",
		decided_at: "2026-09-04T18:07:00Z",
	};
}

async function fixture() {
	const scratch = createScratchHome();
	const ledger = createScratchLedger({ home: scratch.path }).ledger;
	const fleet = new FleetStore({ home: scratch.path });
	const artifacts = new ArtifactStore({ home: scratch.path });
	const old = await ledger.create({ title: "old planner", project: "demo", kind: "research", delivery: "pipeline" });
	await fleet.add({
		job_id: old.id,
		project: "demo",
		kind: "research",
		delivery: "pipeline",
		origin: "terminal",
		phase: "done",
		worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "planner", role: "planner", model: "m/x", started_at: "2026-09-04T18:00:00Z" },
		worktree: `/wt/${old.id}`,
		branch: old.id,
		dispatched_at: "2026-09-04T18:00:00Z",
		usage: EMPTY_USAGE,
	});
	await ledger.close(old.id, "research completed");
	writeFileSync(artifacts.path(old.id), "# Original plan\nkeep the scope\n");
	const decisions = [
		verdict(old.id, 1, "escalate", "reviewer timed out"),
		verdict(old.id, 2, "revise", "test plan missing"),
	];
	for (const decision of decisions) atomicWriteJson(join(scratch.path, paths.gateFile(old.id, decision.attempt)), decision);
	return { scratch, ledger, fleet, artifacts, old, decisions };
}

function plant(home: string, replacementId: string, decisions: GateVerdict[]): void {
	for (const decision of decisions) {
		atomicWriteJson(join(home, paths.gateFile(replacementId, decision.attempt)), { ...decision, job_id: replacementId });
	}
}

function options(home: string, ledger: Ledger, fleet: FleetStore, artifacts: ArtifactStore, oldId: string, replacementId: string) {
	return { home, jobId: oldId, replacementJobId: replacementId, ledger, fleet, artifacts };
}

test("retry accepts gate history only when it is exactly the inherited decisions", async (t) => {
	const { scratch, ledger, fleet, artifacts, old, decisions } = await fixture();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const link = join(home, paths.runDir(old.id), "gate-replacement.json");

	const prefix = await ledger.create({ title: "prefix", project: "demo", kind: "research", delivery: "pipeline" });
	plant(home, prefix.id, decisions.slice(0, 1));
	await assert.rejects(prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, prefix.id)), REFUSED);

	const differ = await ledger.create({ title: "differ", project: "demo", kind: "research", delivery: "pipeline" });
	plant(home, differ.id, decisions);
	const tweaked = verdict(differ.id, 2, "revise", "a different finding");
	atomicWriteJson(join(home, paths.gateFile(differ.id, 2)), tweaked);
	await assert.rejects(prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, differ.id)), REFUSED);

	const unrelated = await ledger.create({ title: "unrelated", project: "demo", kind: "research", delivery: "pipeline" });
	atomicWriteJson(join(home, paths.gateFile(unrelated.id, 1)), verdict(unrelated.id, 1, "escalate", "its own review"));
	atomicWriteJson(join(home, paths.gateFile(unrelated.id, 2)), verdict(unrelated.id, 2, "revise", "its own revise"));
	await assert.rejects(prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, unrelated.id)), REFUSED);

	const filed = await ledger.create({ title: "filed", project: "demo", kind: "research", delivery: "pipeline" });
	writeFileSync(artifacts.path(filed.id), "# already filed\n");
	await assert.rejects(prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, filed.id)), REFUSED);

	const crash = await ledger.create({ title: "crash", project: "demo", kind: "research", delivery: "pipeline" });
	plant(home, crash.id, decisions);
	assert.equal(existsSync(link), false);
	const seeded = await prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, crash.id));
	assert.match(readFileSync(seeded.task_file, "utf8"), /replacement read-only planner/);
	rmSync(link);
	assert.deepEqual(await prepareGateReplacement(options(home, ledger, fleet, artifacts, old.id, crash.id)), seeded);
	const prior = readPriorAttempts(home, crash.id);
	assert.equal(prior.priorRevise, true);
	assert.equal(prior.decisions.at(-1)?.reasons[0], "test plan missing");
	assert.equal(decideGate({
		jobId: crash.id,
		attempt: prior.attempt,
		prior,
		model: "m",
		review: { job_id: crash.id, verdict: "revise", flags: { ...FLAGS }, reasons: ["still"], revisions: ["again"] },
	}).cause, "policy");
});
