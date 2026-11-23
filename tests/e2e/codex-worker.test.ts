/**
 * C1b: research jobs on the Codex CLI driver through the real `cp_dispatch` of a pi parent (mock parent model), with
 * tests/fixtures/fake-codex.ts and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts). Every case
 * checks the synthetic Codex home is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, paths } from "../../src/contracts.ts";
import { checkBudget } from "../../src/failures.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { MandateStore } from "../../src/mandate.ts";
import { codexAvailabilityFile, nativeAvailabilityFile } from "../../src/native-availability.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
import { AUTH_SENTINEL, codexFixture, type FakeCodexScript, fakeExecuted, fakePids, fakeRpcMethods, fakeScopes, fakeSpawns } from "../harness/codex-mock.ts";
import { FAKE_NATIVE_MODEL, routeNativeModel } from "../harness/claude-mock-provider.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { startViewer } from "../harness/dashboard.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

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

const noRun = (h: H, id: string) => assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
const failed = (h: H, id: string) => waitFor(() => h.record(id), (record) => record?.phase === "failed", { timeoutMs: 60_000, what: `${id} failed on its observed exit` });
const preview = (end: End | undefined) => (end?.result.details as { decision?: { driver?: string; requested_driver?: string; driver_reason?: string } } | undefined)?.decision;

test("CX-1b: the switch refuses an explicit codex job by name; a codex row binds codex, refuses by name (never pi), and a started job keeps its driver", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: {} });
	const piModel = h.b.provider.addScript(`cx1b-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	const routing = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
		writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: rows, ...extra }));
	const row = (over: Record<string, unknown> = {}) => ({ id: "codex-research", role: "planner", model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex", ...over });
	const dry = (id: string, over: Record<string, unknown> = {}) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report.", queue: false, when_ready: false, dry_run: true, ...over } }] });
	const [explicit, rowOff, rowOn, board, denied, badModel, ship, locked] = await Promise.all([
		h.job(), h.job(), h.job(), h.job("board"), h.job(), h.job(), h.job("local", "ship"), h.job(),
	]);
	// Switch off: the explicit request refuses naming the switch, before any lease; the row refuses too (cp-qmry: never pi).
	routing([row()]);
	const off = await h.run([explicit.dispatch(), dry(rowOff.id)]);
	const [refused, rowRefused] = off.filter((end) => end.toolName === "cp_dispatch");
	assert.equal(refused?.isError, true, text(refused));
	assert.match(text(refused), /cannot run on the Codex CLI driver: the switch codex_research is off/);
	noRun(h, explicit.id);
	const error = (end: End | undefined) => (end?.result.details as { error?: string } | undefined)?.error ?? "";
	assert.equal(preview(rowRefused), undefined, text(rowRefused));
	assert.match(error(rowRefused), /cannot run on the Codex CLI driver: the switch codex_research is off/);
	// Switch on: the row routes codex; delivery board, an implementer row with codex_ship off (C7b) and a denied model
	// refuse by name, never pi.
	writeFileSync(h.nativeFile, JSON.stringify({ codex_research: true }));
	routing([row(), row({ id: "codex-ship", role: "implementer" })]);
	await h.b.closeParents();
	const on = (await h.run([dry(rowOn.id), dry(board.id), dry(ship.id)])).filter((end) => end.toolName === "cp_dispatch");
	assert.deepEqual([preview(on[0])?.driver, preview(on[0])?.requested_driver], ["codex", "codex"], text(on[0]));
	assert.match(preview(on[0])?.driver_reason ?? "", /^rule: codex-research prefers codex; effort \w+/);
	assert.deepEqual([preview(on[1]), preview(on[2])], [undefined, undefined], JSON.stringify(on).slice(0, 600));
	assert.match(error(on[1]), /cannot run on the Codex CLI driver: only research \(role planner, delivery local or answer\), ship \(role implementer, delivery pr or local\) and gate reviews run on the Codex CLI/);
	assert.match(error(on[2]), /cannot run on the Codex CLI driver: the switch codex_ship is off/);
	routing([row()], { deny_by_role: { planner: [FAKE_CODEX_REF] } });
	await h.b.closeParents();
	const deny = (await h.run([dry(denied.id)])).find((end) => end.toolName === "cp_dispatch");
	assert.equal(preview(deny), undefined, text(deny));
	assert.match(error(deny), new RegExp(`cannot run on the Codex CLI driver: deny_by_role.planner matches ${FAKE_CODEX_REF}`));
	// A codex row on an Anthropic model is a config error with no lease (programme D1: model-checked, not vendor-checked).
	routing([row({ model: "anthropic/claude-opus-x", fallbacks: [] })], { allow: ["mock/*", "anthropic/claude-opus-x", FAKE_CODEX_REF] });
	await h.b.closeParents();
	const bad = (await h.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: badModel.id, task: "Report.", queue: false, when_ready: false } }] }])).find((end) => end.toolName === "cp_dispatch");
	assert.equal(bad?.isError, true, text(bad));
	assert.match(text(bad), /the Codex CLI driver runs an explicit openai\/gpt-… model/);
	noRun(h, badModel.id);
	// D1: a codex job that failed (a lockdown stop) keeps its driver: pi and claude re-dispatches refuse naming the lock.
	routing([row()]);
	h.setScript({ knobs: { features: { view_image: true } }, turns: [[{ kind: "message", text: "No report." }]] });
	await h.b.closeParents();
	await h.run([locked.dispatch()]);
	await failed(h, locked.id);
	await h.b.closeParents();
	const relock = (await h.run([locked.dispatch({ driver: "pi", model: piModel }), locked.dispatch({ driver: "claude", model: "anthropic/claude-opus-x" })])).filter((end) => end.toolName === "cp_dispatch");
	assert.match(text(relock[0]), new RegExp(`${locked.id} started on codex and a started job keeps its driver; dispatch a new job to run pi`));
	assert.match(text(relock[1]), new RegExp(`${locked.id} started on codex and a started job keeps its driver; dispatch a new job to run claude`));
	assertClean(h);
});

test("CX-1c: hook-denied calls never run and each is a tool pair in the run log", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	writeFileSync(join(h.outside, "secret.txt"), "SYNTHETIC-OUTSIDE-WORKTREE-SENTINEL\n");
	h.setScript({ turns: [h.reporting(job.id, [
		{ kind: "shell", command: "touch out-c1c" },
		{ kind: "shell", command: `cat ${join(h.codexHome, "auth.json")}` },
		{ kind: "shell", command: "cat secret.txt", workdir: h.outside },
	])] });
	await h.run([job.dispatch(), h.awaitEnvelope(job.id), h.pause(2)]);
	const [run] = await h.runs(job.id);
	assert.equal(existsSync(join(h.record(job.id)?.worktree as string, "out-c1c")), false, "the planner's write into the worktree did not run");
	assert.equal(run?.denials, 3, JSON.stringify(run));
	assert.equal((run?.denied as string[]).length, 3);
	assert.equal(run?.report, true);
	const events = readRunEvents(h.b.home, job.id);
	const starts = events.filter((event) => event.type === "tool_execution_start" && (event.payload as { toolName?: string }).toolName === "bash");
	const failedEnds = events.filter((event) => event.type === "tool_execution_end" && (event.payload as { isError?: boolean }).isError === true);
	assert.equal(starts.length, 4, "the artifact write and three blocked calls");
	assert.equal(failedEnds.length, 3, "B13: one failed end per blocked call");
	const transcript = readFileSync(readRunStatus(h.b.home, job.id).transcript_file as string, "utf8");
	for (const where of [JSON.stringify(events), transcript]) {
		assert.ok(!where.includes(AUTH_SENTINEL) && !where.includes("SYNTHETIC-OUTSIDE-WORKTREE-SENTINEL"), "a sentinel reached picp");
	}
	assert.equal((transcript.match(/"toolResult"/g) ?? []).length, 5, "the Log shows every call's result, blocked ones included");
	assertClean(h);
});

test("CX-1e: codex slots are counted per driver: a second codex job is occupied, a row-routed one never previews pi, a Claude slot is not taken", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, claude_research: true } });
	const [first, second, rowed, claude] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	const piModel = h.b.provider.addScript(`cx1e-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF],
		rubric: [
			{ id: "codex-research", role: "planner", scope: ["S"], model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" },
			{ id: "claude-research", role: "planner", scope: ["L"], model: FAKE_NATIVE_MODEL, fallbacks: [piModel], driver: "claude" },
		] }));
	routeNativeModel(h.b.home);
	h.setScript({ turns: [[{ kind: "hold", marker: "held" }]] });
	const ends = (await h.run([
		first.dispatch(), h.awaitFile(join(h.state, "held")),
		second.dispatch(),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: rowed.id, task: "Report.", scope: "S", queue: false, when_ready: false, dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: claude.id, task: "Report.", scope: "L", queue: false, when_ready: false, dry_run: true } }] },
	])).filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.equal(ends[1]?.isError, true, text(ends[1]));
	assert.match(text(ends[1]), new RegExp(`cannot run on the Codex CLI driver: codex concurrency is 1 and ${first.id} is live`));
	noRun(h, second.id);
	// cp-qmry: the row-preferred preview reports the full CLI as an error; it never previews pi.
	const error = (end: End | undefined) => (end?.result.details as { error?: string } | undefined)?.error ?? "";
	assert.equal(preview(ends[2]), undefined, text(ends[2]));
	assert.match(error(ends[2]), new RegExp(`cannot run on the Codex CLI driver: codex concurrency is 1 and ${first.id}`));
	// A live codex job takes no Claude slot: the claude row's preview is never occupied (it may lack a CLI here).
	assert.notEqual(preview(ends[3])?.driver, "pi", text(ends[3]));
	assert.doesNotMatch(`${preview(ends[3])?.driver_reason ?? ""} ${error(ends[3])}`, /occupied|concurrency/);
	assertClean(h);
});

test("CX-1f: a SIGKILLed codex worker leaves no app-server or command; the job fails on its exit and a forced teardown still deletes the thread", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ knobs: { osPid: "omit", terminate: "lie" }, turns: [[{ kind: "shell", command: "sleep 300", background: true }, { kind: "hold", marker: "held" }]] });
	// C2 opens bounded recovery to codex: a pre-spent attempt keeps it from reviving the killed job mid-assertion.
	recordRecoveryAttempt(h.b.home, job.id, "crash");
	const quote = `Force teardown ${job.id} and discard its unreported result.`;
	const killer = (async () => {
		await waitFor(() => existsSync(join(h.state, "held")) && h.record(job.id)?.worker.pid, Boolean, { timeoutMs: 90_000, what: "the held codex turn" });
		process.kill(h.record(job.id)?.worker.pid as number, "SIGKILL");
	})();
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")), h.pause(8),
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id, force: true, operator_quote: quote } }] },
	], {}, `Run the checks. ${quote}`);
	await killer;
	const pids = [...fakePids(h.state), ...fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server").map((each) => each.pid)];
	await waitFor(() => pids.filter(isPidAlive), (alive) => alive.length === 0, { timeoutMs: 20_000, what: "every command and app-server pid gone" });
	await allScopesKilled(h);
	assert.ok(readRunEvents(h.b.home, job.id).some((event) => event.type === "cp:process_exit" || event.type === "process_exit" || event.type === "exited"), "the exit was observed");
	const [down] = ends.filter((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	const deleted = readRunEvents(h.b.home, job.id).find((event) => event.type === "native_thread_deleted")?.payload as Record<string, unknown> | undefined;
	assert.equal(deleted?.deleted, true, JSON.stringify(deleted));
	assertClean(h);
});

test("CX-1g/CX-1h/CX-1q: a dead hook, an unasked command or an extra surface fails the dispatched job by name with nothing read", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	writeFileSync(join(h.outside, "secret.txt"), "SYNTHETIC-OUTSIDE-WORKTREE-SENTINEL\n");
	const [dead, unasked, surface] = await Promise.all([h.job(), h.job(), h.job()]);
	const cases = [
		[dead, { knobs: { autoApprove: ["cat"], modelMs: 1_000 }, turns: [[{ kind: "shell" as const, command: `cat ${join(h.outside, "secret.txt")}`, hook: "kill" as const }, { kind: "shell" as const, command: "cat README.md" }]] }],
		[unasked, { knobs: { autoApprove: ["cat"], modelMs: 1_000 }, turns: [[{ kind: "shell" as const, command: "cat README.md" }, { kind: "shell" as const, command: "echo second-step" }]] }],
		[surface, { knobs: { features: { view_image: true } }, turns: [[{ kind: "shell" as const, command: "cat README.md" }]] }],
	] as const;
	for (const [job, script] of cases) {
		h.setScript(script as unknown as FakeCodexScript);
		rmSync(join(h.state, "cursor.json"), { force: true });
		rmSync(join(h.state, "executed.jsonl"), { force: true });
		rmSync(join(h.state, "rpc.jsonl"), { force: true });
		await h.b.closeParents();
		const [end] = (await h.run([job.dispatch()])).filter((each) => each.toolName === "cp_dispatch");
		assert.notEqual(end?.isError, true, text(end));
		const record = await failed(h, job.id);
		const [run] = await h.runs(job.id);
		assert.equal(run?.stop, "lockdown", JSON.stringify(run));
		assert.equal(record?.failure?.class, "spawn_failed");
		assert.match(record?.failure?.message ?? "", /picp refused or killed the Codex CLI run/);
		assert.equal(existsSync(join(h.b.home, paths.envelopeFile(job.id))), false);
		if (job === dead) {
			assert.deepEqual(fakeExecuted(h.state), []);
			assert.equal(run?.hook_failed, true);
			const transcript = readFileSync(readRunStatus(h.b.home, job.id).transcript_file as string, "utf8");
			for (const where of [JSON.stringify(readRunEvents(h.b.home, job.id)), transcript]) assert.ok(!where.includes("SYNTHETIC-OUTSIDE-WORKTREE-SENTINEL"));
		} else if (job === unasked) {
			assert.equal(run?.bypass, "commandExecution");
			assert.deepEqual(fakeExecuted(h.state), ["cat README.md"], "no second step ran");
		} else {
			assert.equal(run?.lockdown, "refused");
			assert.ok(!fakeRpcMethods(h.state).includes("turn/start"));
		}
		await allScopesKilled(h);
	}
	assertClean(h);
});

test("CX-1j: a grant's token cap stops codex work: the turn's tokens pause it as token_cap at $0, the job reports, the next dispatch refuses", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const [spender, next] = await Promise.all([h.job(), h.job()]);
	const grant = new MandateStore(h.b.home).issue({
		projects: ["demo"], objective: "codex token cap e2e", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 50 }, job_cap: 10, ask_on: [], job_ids: [spender.id, next.id],
	});
	h.setScript({ turns: [h.reporting(spender.id, [{ kind: "shell", command: "cat README.md" }])] });
	const ends = (await h.run([
		spender.dispatch(), h.awaitEnvelope(spender.id), h.pause(3), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: spender.id } }] }, next.dispatch(),
	])).filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.equal(readRunEvents(h.b.home, spender.id).filter((event) => event.type === "envelope_received").length, 1, "the running job still reports");
	const paused = await waitFor(() => new MandateStore(h.b.home).list().find((mandate) => mandate.id === grant.id), (mandate) => mandate?.pause_reason === "token_cap",
		{ timeoutMs: 30_000, what: "the codex tokens to pause the grant" });
	assert.equal(paused?.status, "paused");
	assert.equal(readRunStatus(h.b.home, spender.id).usage.cost_usd, 0, "the USD side never binds a codex job");
	assert.equal(ends[1]?.isError, true, text(ends[1]));
	assert.match(text(ends[1]), new RegExp(`mandate ${grant.id} is paused \\(token_cap\\)`));
	noRun(h, next.id);
	assertClean(h);
});

test("CX-1n: a sub-agent is denied at the hook; with a dead hook the spawned sub-agent's command dies with the scope and the job fails by name", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const [healthy, dead] = await Promise.all([h.job(), h.job()]);
	h.setScript({ turns: [h.reporting(healthy.id, [{ kind: "subagent", command: "sleep 299" }])] });
	await h.run([healthy.dispatch(), h.awaitEnvelope(healthy.id), h.pause(2), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: healthy.id } }] }]);
	const [ok] = await h.runs(healthy.id);
	assert.equal(ok?.report, true, JSON.stringify(ok));
	assert.ok((ok?.denied as string[]).some((line) => line.startsWith("collaborationspawn_agent:")), JSON.stringify(ok?.denied));
	assert.deepEqual(fakePids(h.state), [], "no sub-agent command started");
	rmSync(join(h.state, "cursor.json"), { force: true });
	h.setScript({ knobs: { modelMs: 500 }, turns: [[{ kind: "shell", command: "sleep 300", background: true }, { kind: "subagent", command: "sleep 301", hook: "kill" }, { kind: "hold", marker: "held" }]] });
	await h.b.closeParents();
	await h.run([dead.dispatch()]);
	const record = await failed(h, dead.id);
	const [run] = await h.runs(dead.id);
	assert.equal(run?.stop, "lockdown", JSON.stringify(run));
	assert.equal(record?.failure?.class, "spawn_failed");
	const pids = fakePids(h.state);
	assert.ok(pids.length > 0, "the commands started");
	await waitFor(() => pids.filter(isPidAlive), (alive) => alive.length === 0, { timeoutMs: 20_000, what: "the sub-agent's command gone" });
	await allScopesKilled(h);
	assertClean(h);
});

test("CX-1o: the app-server scope carries the worker memory cap; a malformed cap refuses before any app-server", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id)] });
	await h.run([job.dispatch(), h.awaitEnvelope(job.id)], { CP_WORKER_MEMORY_MAX: "6G" });
	const started = fakeScopes(h.state).filter((each) => each.started);
	assert.ok(started.length >= 2, "the trust probe and the run");
	for (const scope of started) assert.deepEqual(scope.props, ["MemoryMax=6G", "MemorySwapMax=0"], JSON.stringify(scope));
	const fx = codexFixture(t, "cp-codex-memory", { turns: [[{ kind: "shell", command: "cat README.md" }]] });
	const base = fx.options();
	await assert.rejects(fx.run({ hostEnv: { ...base.hostEnv, CP_CODEX_MEMORY_MAX: "lots" } }), /CP_CODEX_MEMORY_MAX "lots" is not a byte size like 6G.*never runs Codex uncontained/);
	assert.deepEqual(fakeSpawns(fx.stateDir).filter((each) => each.argv[0] === "app-server"), []);
	assertClean(h);
});

test("C1b T-row: with every codex switch off nothing persisted takes a codex value, so a build before C1b still reads every file", { skip, timeout: 300_000 }, async (t) => {
	// Main-session condition 2 (es-aa639f): the shipped state writes no new-shape value. An explicit codex dispatch, a
	// queued or armed one and a codex rubric row are each refused while off; fleet, queue, armed, routing and native.json
	// then hold only values the previous enums accept.
	const h = await codexWorkerHome(t, { native: null });
	const [plain, blocker, armed] = await Promise.all([h.job(), h.job(), h.job()]);
	await h.b.ledger.addDep(armed.id, blocker.id);
	const piModel = h.b.provider.addScript(`cxoff-pi-${Math.random().toString(36).slice(2, 8)}`, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }] }, { kind: "text", text: "idle" },
	]);
	const routingBefore = readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8");
	const ends = (await h.run([
		plain.dispatch({ queue: true }),
		armed.dispatch({ when_ready: true }),
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: plain.id, task: "Report.", model: piModel, driver: "pi", queue: false, when_ready: false } }] },
	])).filter((end) => end.toolName === "cp_dispatch");
	assert.match(text(ends[0]), /the switch codex_research is off/);
	assert.match(text(ends[1]), /not armed: the armed dispatch of \S+ names the codex driver while every codex switch is off/);
	assert.notEqual(ends[2]?.isError, true, text(ends[2]));
	await waitFor(() => h.record(plain.id), Boolean, { timeoutMs: 30_000, what: "the pi job's fleet record" });
	const persisted = [LAYOUT.fleetFile, LAYOUT.dispatchQueueFile, LAYOUT.routingFile, join(LAYOUT.data, "native.json"), join(LAYOUT.data, "armed-dispatches.json")]
		.map((rel) => join(h.b.home, rel)).filter((file) => existsSync(file));
	assert.ok(persisted.length >= 2, persisted.join(","));
	for (const file of persisted) assert.doesNotMatch(readFileSync(file, "utf8"), /codex/, `${file} holds a codex value`);
	assert.equal(existsSync(h.nativeFile), false, "native.json was never written");
	assert.equal(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8").includes("codex"), routingBefore.includes("codex"));
	assertClean(h);
});

test("CX-off-2: with every codex switch off a hand-written codex row refuses by name (never pi) and no persisted record names a codex driver", { skip, timeout: 300_000 }, async (t) => {
	// C1b review item 1: no build before C1b may read a codex value. cp-qmry: the row's CLI binds, so the job is refused
	// naming the switch rather than run on pi; nothing is spawned or persisted for it.
	const h = await codexWorkerHome(t, { native: null });
	const job = await h.job();
	const piModel = h.b.provider.addScript(`cxoff2-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	const row = { id: "hand-written", role: "planner", model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" };
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: [row] }));
	const [end] = (await h.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report.", queue: false, when_ready: false } }] }]))
		.filter((each) => each.toolName === "cp_dispatch");
	assert.equal(end?.isError, true, text(end));
	assert.match(text(end), /cannot run on the Codex CLI driver: the switch codex_research is off/);
	assert.equal(existsSync(join(h.b.home, LAYOUT.fleetFile)) ? h.record(job.id) : undefined, undefined, "no fleet record: nothing ran on pi");
	noRun(h, job.id);
	const drivers = (value: unknown): unknown[] => (value === null || typeof value !== "object" ? [] : Object.entries(value as Record<string, unknown>)
		.flatMap(([key, child]) => [...(key === "driver" || key === "requested_driver" ? [child] : []), ...drivers(child)]));
	const persisted = [LAYOUT.fleetFile, LAYOUT.dispatchQueueFile, join(LAYOUT.data, "native.json"), join(LAYOUT.data, "armed-dispatches.json")]
		.map((rel) => join(h.b.home, rel)).filter((file) => existsSync(file));
	for (const value of persisted.map((file) => JSON.parse(readFileSync(file, "utf8")) as unknown)) {
		for (const driver of drivers(value)) assert.ok(driver === "pi" || driver === "claude", `a persisted driver value ${String(driver)}`);
	}
	assert.equal(existsSync(h.nativeFile), false, "native.json was never written");
	// C3: no codex job ran, so neither availability snapshot exists.
	assert.equal(existsSync(codexAvailabilityFile(h.b.home)), false, "no Codex availability snapshot");
	assert.equal(existsSync(nativeAvailabilityFile(h.b.home)), false, "no Claude availability snapshot");
	// The harness adds the parent's own rows; picp wrote no codex value: the hand-written row is the only one, as written.
	const rubric = (JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: Array<Record<string, unknown>> }).rubric;
	assert.deepEqual(rubric.filter((each) => each.driver === "codex"), [row]);
	assertClean(h);
});
