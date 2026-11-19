/**
 * C1b: research jobs on the Codex CLI driver through the real `cp_dispatch` of a pi parent (mock parent model), with
 * tests/fixtures/fake-codex.ts and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts). Every case
 * checks the synthetic Codex home is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, paths } from "../../src/contracts.ts";
import { checkBudget } from "../../src/failures.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { AUTH_SENTINEL, fakeExecuted, fakePids, fakeRpcMethods, fakeScopes, fakeSpawns } from "../harness/codex-mock.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { startViewer } from "../harness/dashboard.ts";
import { readFleet, readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");

/** The Codex home is untouched, and no host OPENAI_/CODEX_ key but CODEX_HOME reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server")) {
		assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
	}
}

const allScopesKilled = (h: H) => waitFor(() => fakeScopes(h.state), (scopes) => scopes.filter((each) => each.killed !== undefined || each.collected).length >= scopes.filter((each) => each.started).length,
	{ timeoutMs: 20_000, what: "every started scope killed or collected" });

test("CX-1a: a codex research job reports once through cp_dispatch, counts tokens at an unknown cost, and teardown deletes its thread", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [[
		{ kind: "tool", tool: "report_result", arguments: h.report("cp-someone-else") },
		...h.reporting(job.id),
	]] });
	const ends = await h.run([job.dispatch(), h.awaitEnvelope(job.id), h.pause(2), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id } }] }]);
	const [dispatched] = ends.filter((end) => end.toolName === "cp_dispatch");
	const [down] = ends.filter((end) => end.toolName === "cp_teardown");
	assert.notEqual(dispatched?.isError, true, text(dispatched));
	const record = h.record(job.id);
	assert.equal(record?.worker.driver, "codex");
	assert.equal(record?.routing?.driver, "codex");
	const events = readRunEvents(h.b.home, job.id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 1, "exactly one accepted report");
	const [run] = await h.runs(job.id);
	assert.equal(run?.driver, "codex");
	assert.equal(run?.lockdown, "ok", JSON.stringify(run));
	assert.equal(run?.cost_unknown, true);
	assert.equal(run?.report_refusals, 1, "the wrong-job report was refused");
	assert.equal((JSON.parse(readFileSync(join(h.b.home, paths.envelopeFile(job.id)), "utf8")) as { envelope: { job_id: string } }).envelope.job_id, job.id);
	// D3: tokens counted, the USD side 0 and marked unknown; the per-job token budget binds, the USD one never does.
	const status = readRunStatus(h.b.home, job.id);
	assert.ok(status.usage.total_tokens > 0, JSON.stringify(status.usage));
	assert.equal(status.usage.cost_usd, 0);
	assert.equal(status.cost_unknown, true);
	const budget = checkBudget(status.usage, { tokens: 1, cost_usd: 1_000 }, DEFAULT_BUDGET_CONFIG);
	assert.equal(budget.state, "exceeded");
	assert.equal(budget.cost.used, 0);
	// The Log: written with the worker, 0600, never the auth sentinel.
	const transcript = status.transcript_file as string;
	assert.ok(transcript && existsSync(transcript), `transcript ${transcript}`);
	assert.equal(statSync(transcript).mode & 0o777, 0o600);
	const log = readFileSync(transcript, "utf8");
	assert.ok(!log.includes(AUTH_SENTINEL));
	assert.match(log, /"toolCall"/);
	assert.match(log, /"toolResult"/);
	// Containment: every app-server ran in a started scope.
	const scopes = fakeScopes(h.state);
	assert.ok(scopes.some((each) => each.started), "a scope started");
	for (const scope of scopes.filter((each) => each.started)) assert.ok(scope.unit, JSON.stringify(scope));
	// Teardown: lease back, the thread deleted through a bare app-server (web search off, no hook), then the scratch.
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	const after = readRunEvents(h.b.home, job.id).map((event) => event.type);
	const deleted = readRunEvents(h.b.home, job.id).find((event) => event.type === "native_thread_deleted")?.payload as Record<string, unknown> | undefined;
	assert.equal(deleted?.deleted, true, JSON.stringify(deleted));
	assert.ok(after.indexOf("native_thread_deleted") < after.indexOf("native_scratch_removed"), after.join(","));
	assert.equal(existsSync(join(h.state, "threads", `${String(deleted?.thread_id)}.json`)), false, "the fake's thread file is gone");
	const servers = fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");
	const bare = servers.at(-1);
	assert.ok(bare?.argv.includes('web_search="disabled"'), "D4 on the teardown app-server");
	assert.ok(!bare?.argv.some((arg) => arg.startsWith("hooks.PreToolUse=")), "no hook on the teardown app-server");
	assert.ok(!bare?.argv.some((arg) => arg.startsWith("permissions.")), "no profile: the bare server runs no turn");
	// The job page: driver codex and an unknown cost, never $0.00.
	const viewer = await startViewer(t, { home: h.b.home });
	const page = (await viewer.get(`/api/job/${job.id}`)).body as { job?: { driver?: string; cost_unknown?: boolean } };
	assert.equal(page.job?.driver, "codex", JSON.stringify(page).slice(0, 400));
	assert.equal(page.job?.cost_unknown, true);
	assertClean(h);
});
