/**
 * cp-qmry: the CLI a routing row names is binding. A saturated CLI queues the job ("waiting for <CLI> capacity") and
 * starts it on that same CLI when a slot frees; nothing ever re-routes it to pi. Real `cp_dispatch` of a pi parent
 * (mock model) with fake-codex and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts).
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { FAKE_NATIVE_MODEL } from "../harness/claude-mock-provider.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { readRunEvents, treehouseAvailable } from "../harness/index.ts";
import { seedOperatorPick } from "../harness/operator-pick.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");

/** A codex planner row with a pi fallback model: the fallback is a model list for codex, never a pi escape hatch. */
function codexRow(h: H): string {
	const piModel = h.b.provider.addScript(`hard-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF],
		rubric: [{ id: "codex-research", role: "planner", model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" }] }));
	return piModel;
}

test("T1: a row-routed job never runs pi when the codex slot is full; it queues waiting for Codex CLI capacity and starts on codex", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	codexRow(h);
	const [first, second] = await Promise.all([h.job(), h.job()]);
	h.setScript({ turns: [[{ kind: "hold", marker: "held", forMs: 4_000 }, ...h.reporting(first.id)], h.reporting(second.id)] });
	const ends = await h.run([
		first.dispatch(), h.awaitFile(join(h.state, "held")),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: second.id, task: "Report what README.md says." } }] },
		h.awaitEnvelope(first.id), h.pause(2),
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: first.id } }] },
		h.awaitEnvelope(second.id), h.pause(2),
	]);
	const dispatched = ends.filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(dispatched[0]?.isError, true, text(dispatched[0]));
	assert.equal(dispatched[1]?.result.details?.state, "queued", text(dispatched[1]));
	assert.match(text(dispatched[1]), /waiting for Codex CLI capacity/);
	const record = h.record(second.id);
	assert.equal(record?.worker.driver, "codex", JSON.stringify(record?.worker));
	assert.equal(record?.routing?.driver, "codex");
});

// T4: on a codex row only the human's own per-job request moves a job to pi, recorded on it with its source; a parent's
// driver, a model-only pick and a model the configured CLI cannot run are refused before any lease.
test("T4: on a codex row a parent's driver pi, a model-only pick and a pi model refuse; the human's driver pick runs pi, recorded", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const piModel = codexRow(h);
	const [parent, modelOnly, model, human] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	const v1 = seedOperatorPick(h.b.home, piModel, { jobId: modelOnly.id });
	const v2 = seedOperatorPick(h.b.home, piModel, { jobId: human.id, driver: "pi" });
	assert.throws(() => seedOperatorPick(h.b.home, piModel, { jobId: human.id, driver: "pi", quote: `use ${piModel} for this one` }),
		/operator_pick_fabricated: the quote does not name the pi CLI as a whole word/);
	const call = (id: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report.", queue: false, when_ready: false, ...args } }] });
	const ends = (await h.run([
		call(parent.id, { driver: "pi" }), call(modelOnly.id, { driver: "pi", model: piModel, operator_quote: v1 }), call(model.id, { model: piModel }),
		call(human.id, { driver: "pi", model: piModel, operator_quote: v2 }),
	])).filter((end) => end.toolName === "cp_dispatch");
	for (const [end, id] of [[ends[0], parent.id], [ends[1], modelOnly.id]] as const) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), /configured to run on the Codex CLI \(rule codex-research\), and a parent's driver choice is not an override/);
		assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	}
	assert.equal(ends[2]?.isError, true, text(ends[2]));
	assert.match(text(ends[2]), /cannot run on the configured Codex CLI \(rule codex-research\); a model change never changes the CLI/);
	assert.notEqual(ends[3]?.isError, true, text(ends[3]));
	const record = h.record(human.id);
	assert.deepEqual([record?.worker.driver, record?.worker.model, record?.routing?.driver], [undefined, piModel, "pi"]);
	assert.match(record?.routing?.driver_reason ?? "", /^override: human terminal \S+ proof omp-[a-f0-9]{32} asked for pi$/);
	const resolved = readRunEvents(h.b.home, human.id).find((event) => event.type === "routing_resolved")?.payload as { driver_override?: Record<string, unknown> };
	assert.deepEqual([resolved.driver_override?.driver, resolved.driver_override?.kind, resolved.driver_override?.quote], ["pi", "terminal", v2.quote]);
});

// P3: an explicit driver is the parent's choice, so it must match the row's CLI (absent = pi) in every direction
// (native→another native, pi→native) unless the human's v2 pick names that CLI for that one job.
test("P3: an explicit codex on a claude or pi row and an explicit claude on a codex row refuse; the human's codex pick allows it", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const piModel = h.b.provider.addScript(`p3-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF, FAKE_NATIVE_MODEL], rubric: [
		{ id: "codex-research", role: "planner", scope: ["S"], model: FAKE_CODEX_REF, driver: "codex" },
		{ id: "claude-research", role: "planner", scope: ["M"], model: FAKE_NATIVE_MODEL, driver: "claude" },
		{ id: "pi-research", role: "planner", scope: ["L"], model: piModel },
	] }));
	const [onClaude, onPi, claudeOnCodex, picked, pickedPi] = await Promise.all([h.job(), h.job(), h.job(), h.job(), h.job()]);
	const codexPick = seedOperatorPick(h.b.home, FAKE_CODEX_REF, { jobId: picked.id, driver: "codex" });
	const piRowPick = seedOperatorPick(h.b.home, FAKE_CODEX_REF, { jobId: pickedPi.id, driver: "codex" });
	h.setScript({ turns: [h.reporting(picked.id)] });
	const ends = (await h.run([
		onClaude.dispatch({ scope: "M" }), onPi.dispatch({ scope: "L" }), claudeOnCodex.dispatch({ scope: "S", driver: "claude", model: FAKE_NATIVE_MODEL }),
		picked.dispatch({ scope: "M", operator_quote: codexPick }), h.awaitEnvelope(picked.id),
		pickedPi.dispatch({ scope: "L", operator_quote: piRowPick, dry_run: true }),
	])).filter((end) => end.toolName === "cp_dispatch");
	const refusals = [[onClaude, /configured to run on the Claude CLI \(rule claude-research\)/], [onPi, /configured to run on pi \(rule pi-research\)/],
		[claudeOnCodex, /configured to run on the Codex CLI \(rule codex-research\)/]] as const;
	for (const [[job, pattern], end] of refusals.map((each, at) => [each, ends[at]] as const)) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), new RegExp(`${pattern.source}, and a parent's driver choice is not an override`));
		assert.equal(existsSync(join(h.b.home, paths.runDir(job.id))), false, `${job.id} has a run`);
	}
	assert.notEqual(ends[3]?.isError, true, text(ends[3]));
	const record = h.record(picked.id);
	assert.deepEqual([record?.worker.driver, record?.routing?.driver], ["codex", "codex"]);
	assert.match(record?.routing?.driver_reason ?? "", /^override: human terminal \S+ proof omp-[a-f0-9]{32} asked for codex; effort /);
	const preview = (ends[4]?.result.details as { decision?: { driver?: string; driver_reason?: string } } | undefined)?.decision;
	assert.deepEqual([preview?.driver, /^override: human terminal \S+ proof omp-/.test(preview?.driver_reason ?? "")], ["codex", true], text(ends[4]));
});
