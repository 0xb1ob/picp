/**
 * cp-qmry: the CLI a routing row names is binding. A saturated CLI queues the job ("waiting for <CLI> capacity") and
 * starts it on that same CLI when a slot frees; nothing ever re-routes it to pi. Real `cp_dispatch` of a pi parent
 * (mock model) with fake-codex and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { treehouseAvailable } from "../harness/index.ts";

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
