/**
 * cp-qmry: the CLI a routing row names is binding. A saturated CLI queues the job ("waiting for <CLI> capacity") and
 * starts it on that same CLI when a slot frees; nothing ever re-routes it to pi. Real `cp_dispatch` of a pi parent
 * (mock model) with fake-codex and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type FailureClass, isoTimestamp, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { readRecoveryAttempts } from "../../src/recovery.ts";
import { fakePrompts } from "../harness/codex-mock.ts";
import { FAKE_NATIVE_MODEL } from "../harness/claude-mock-provider.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { readRunEvents, REPO_ROOT, treehouseAvailable, waitFor } from "../harness/index.ts";
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
		// Previewed first: once the picked job runs it holds the only codex slot.
		pickedPi.dispatch({ scope: "L", operator_quote: piRowPick, dry_run: true }),
		picked.dispatch({ scope: "M", operator_quote: codexPick }), h.awaitEnvelope(picked.id),
	])).filter((end) => end.toolName === "cp_dispatch");
	const refusals = [[onClaude, /configured to run on the Claude CLI \(rule claude-research\)/], [onPi, /configured to run on pi \(rule pi-research\)/],
		[claudeOnCodex, /configured to run on the Codex CLI \(rule codex-research\)/]] as const;
	for (const [[job, pattern], end] of refusals.map((each, at) => [each, ends[at]] as const)) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), new RegExp(`${pattern.source}, and a parent's driver choice is not an override`));
		assert.equal(existsSync(join(h.b.home, paths.runDir(job.id))), false, `${job.id} has a run`);
	}
	assert.notEqual(ends[4]?.isError, true, text(ends[4]));
	const record = h.record(picked.id);
	assert.deepEqual([record?.worker.driver, record?.routing?.driver], ["codex", "codex"]);
	assert.match(record?.routing?.driver_reason ?? "", /^override: human terminal \S+ proof omp-[a-f0-9]{32} asked for codex; effort /);
	const preview = (ends[3]?.result.details as { decision?: { driver?: string; driver_reason?: string } } | undefined)?.decision;
	assert.deepEqual([preview?.driver, /^override: human terminal \S+ proof omp-/.test(preview?.driver_reason ?? "")], ["codex", true], text(ends[3]));
});

const step = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const waitEntries = (h: H) => (existsSync(join(h.b.home, LAYOUT.nativeWaitFile)) ? (JSON.parse(readFileSync(join(h.b.home, LAYOUT.nativeWaitFile), "utf8")) as { entries: unknown[] }).entries : []);
/** Lowers codex to one slot once `holder` reported: two live codex jobs then fill it (CX-6f's trick, at a real boundary). */
const lowerToOne = (h: H) => writeFileSync(h.nativeFile, JSON.stringify({ codex_research: true, codex_max_concurrent: 1 }));

// Scenario (T5a, R4 respawn): Given a codex job that dies while another codex job fills the one slot, When bounded
// recovery and then the operator's cp_revive try to revive it, Then both queue "waiting for Codex CLI capacity" (one
// entry, no recovery attempt spent, never pi); And once the holder tears down it revives on codex and reports.
test("T5a: a dead codex job's revive waits for Codex CLI capacity (no attempt spent) and revives on codex when the slot frees", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 2 } });
	codexRow(h);
	const [dead, holder] = await Promise.all([h.job(), h.job()]);
	h.setScript({ turns: [[{ kind: "hold", marker: "held" }], h.reporting(holder.id), h.reporting(dead.id)] });
	const queued = join(h.state, "recovery-queued");
	const killer = (async () => {
		await waitFor(() => existsSync(join(h.b.home, paths.envelopeFile(holder.id))) && h.record(dead.id)?.worker.pid, Boolean, { timeoutMs: 120_000, what: "the holder's report" });
		lowerToOne(h);
		process.kill(h.record(dead.id)?.worker.pid as number, "SIGKILL");
		await waitFor(() => ofType(h, dead.id, "recovery_failed"), (found) => found.some((event) => (event.payload as { stage?: string }).stage === "native_waiting"),
			{ timeoutMs: 120_000, what: "bounded recovery queued the revive" });
		writeFileSync(queued, "");
	})();
	const ends = await h.run([
		dead.dispatch(), h.awaitFile(join(h.state, "held")), holder.dispatch(), h.awaitEnvelope(holder.id), h.awaitFile(queued),
		step("cp_revive", { job_id: dead.id, confirm: true }), step("cp_next", {}), step("cp_teardown", { job_id: holder.id }),
		h.waitEvent(dead.id, "envelope_received", 1), h.pause(2),
	]);
	await killer;
	const failure = ofType(h, dead.id, "failure")[0]?.payload as { class?: FailureClass } | undefined;
	assert.equal(readRecoveryAttempts(h.b.home, dead.id, failure?.class ?? "crash"), 0, "a queued revive spends no recovery attempt");
	const revive = ends.find((end) => end.toolName === "cp_revive");
	assert.notEqual(revive?.isError, true, text(revive));
	assert.deepEqual([revive?.result.details?.state, revive?.result.details?.kind, revive?.result.details?.position], ["queued", "revive", 1], text(revive));
	assert.match(text(revive), /waiting for Codex CLI capacity/);
	const next = ends.find((end) => end.toolName === "cp_next")?.result.details as { lined_up?: { waiting?: Array<{ job_id: string; kind: string; driver: string }> } };
	assert.deepEqual(next.lined_up?.waiting?.map((row) => [row.job_id, row.kind, row.driver]), [[dead.id, "revive", "codex"]]);
	assert.equal(ofType(h, dead.id, "worker_revived").length, 1);
	// The killed run records no native_run; the revived one ran on codex, nothing on pi.
	assert.deepEqual([h.record(dead.id)?.worker.driver, ofType(h, dead.id, "native_run").map((event) => (event.payload as { driver?: string }).driver)], ["codex", ["codex"]]);
	assert.deepEqual(waitEntries(h), []);
});

// Scenario (T5b, R5 continuation): Given two held codex jobs filling the one slot, When cp_send reaches one of them,
// Then it is queued "waiting for Codex CLI capacity" (nothing sent, never pi); And once the other tears down the message
// is delivered on codex, on the job's own thread, and it reports again.
test("T5b: a cp_send whose codex slot is full is queued and delivered on codex when the slot frees", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 2 } });
	codexRow(h);
	const [author, holder] = await Promise.all([h.job(), h.job()]);
	h.setScript({ turns: [h.reporting(author.id), h.reporting(holder.id), h.reporting(author.id)] });
	const lowered = join(h.state, "lowered");
	const lower = (async () => {
		await waitFor(() => ofType(h, holder.id, "agent_settled").length > 0 && ofType(h, author.id, "agent_settled").length > 0, Boolean, { timeoutMs: 120_000, what: "both turns settled" });
		lowerToOne(h);
		writeFileSync(lowered, "");
	})();
	const message = "T5b follow-up: name one more file and report again.";
	const ends = await h.run([
		author.dispatch(), h.awaitEnvelope(author.id), holder.dispatch(), h.awaitEnvelope(holder.id), h.awaitFile(lowered),
		step("cp_send", { job_id: author.id, message }), step("cp_teardown", { job_id: holder.id }),
		h.waitEvent(author.id, "envelope_received", 2), h.pause(2),
	]);
	await lower;
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.deepEqual([sent?.result.details?.receipt, sent?.result.details?.waiting], ["queued", "waiting for Codex CLI capacity"], text(sent));
	assert.match(String(sent?.result.details?.native), /delivered on the Codex CLI when a slot frees, never on another CLI/);
	const delivered = fakePrompts(h.state).filter((each) => each.text.includes(message));
	assert.equal(delivered.length, 1, "delivered once, after the slot freed");
	assert.equal(delivered[0]?.threadId, h.session(author.id).thread_id, "on the job's own codex thread");
	assert.equal(ofType(h, author.id, "envelope_received").length, 2);
	assert.deepEqual(waitEntries(h), []);
	assert.deepEqual(readdirSync(join(h.b.home, paths.runDir(author.id))).filter((name) => name.startsWith("waiting-send-")), [], "the waiting body is removed");
});

// Scenario (T6, R1 retry/hand-off): Given a pipeline whose implementer row is on codex and a codex job holding the one
// slot, When the advance reaches the implementer, Then it returns wait "waiting for Codex CLI capacity" with no ship
// record (never pi); And once the holder tears down the queued advance re-runs and the implementer starts on codex.
test("T6: a pipeline advance whose codex implementer finds the slot full waits for Codex CLI capacity and dispatches on codex when it frees", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_ship: true }, ship: true });
	const planner = h.b.provider.addScript("t6-plan", [{ kind: "text", text: "Planned." }], { onExhausted: "repeat" });
	const gate: Array<{ kind: "tool_calls"; calls: Array<{ name: string; args: unknown }> }> = [];
	const reviewer = h.b.provider.addScript("t6-gate", gate);
	h.b.agent.writeModels(h.b.provider);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: [
		{ id: "codex-plan", role: "planner", scope: ["S"], model: FAKE_CODEX_REF, driver: "codex" },
		{ id: "pi-plan", role: "planner", scope: ["L"], model: planner },
		{ id: "pi-gate", role: "gate-reviewer", model: reviewer },
		{ id: "codex-ship", role: "implementer", model: FAKE_CODEX_REF, driver: "codex" },
	] }));
	// Driver selection and the spawn read this process's env: the stub dir and the synthetic Codex home.
	const saved = { PATH: process.env.PATH, CP_CODEX_HOME: process.env.CP_CODEX_HOME };
	Object.assign(process.env, h.env);
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
	});
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		authorizer: { ask: async () => ({ approved: true, by: "t6 operator" }) },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_CODEX_REF }),
	}));
	const holder = await h.job();
	h.setScript({ turns: [h.reporting(holder.id), [{ kind: "hold", marker: "implementing", forMs: 2_000 }, { kind: "message", text: "Implementing." }]] });
	await post.dispatch({ jobId: holder.id, task: "Report what README.md says.", scope: "S", fetch: false });
	await waitFor(() => existsSync(join(h.b.home, paths.envelopeFile(holder.id))), Boolean, { timeoutMs: 120_000, what: "the holder's report" });
	const started = await post.startPipeline({ title: "t6", project: "demo", task: "Add a line to README.md.", delivery: "local", scope: "L", fetch: false });
	const id = started.research_id;
	mkdirSync(dirname(post.artifacts.file(id)), { recursive: true });
	writeFileSync(post.artifacts.file(id), "# Goal\nAdd a line to README.md.\n\n# File list\n- README.md\n\n# Test plan\nnpm test\n\n# Unknowns/Blockers\nnone\n");
	const envelope = { job_id: id, kind: "research", status: "done", summary: "plan complete", artifact_path: post.artifacts.file(id), plan_summary: MINIMAL_PLAN_SUMMARY,
		self_assessment: { scope: "S", confidence: "high", destructive_scope: false, blocking_unknowns: false } };
	mkdirSync(dirname(join(h.b.home, paths.envelopeFile(id))), { recursive: true });
	writeFileSync(join(h.b.home, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1, envelope }));
	gate.push({ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: id, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["concrete"] } }] });
	let result = await post.advancePipeline(id);
	for (let guard = 0; result.pending && guard < 10; guard += 1) {
		const key = ReviewRuns.key(result.pending.surface === "review" ? result.ship_id : id, result.pending.surface, result.pending.attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
		result = await post.advancePipeline(id);
	}
	assert.equal(result.next, "wait", result.message);
	assert.match(result.message, new RegExp(`^${started.ship_id}: waiting for Codex CLI capacity — this advance is queued \\(position 1\\)`));
	assert.equal(h.record(started.ship_id), undefined, "no implementer ran on another CLI");
	assert.deepEqual(post.nativeWait.list().map((row) => [row.job_id, row.kind, row.driver]), [[id, "pipeline-advance", "codex"]]);
	await post.tearDown(holder.id);
	const ship = await waitFor(() => h.record(started.ship_id), (record) => record?.worker.driver === "codex", { timeoutMs: 120_000, what: "the implementer on codex" });
	assert.deepEqual([ship?.worker.role, ship?.routing?.driver], ["implementer", "codex"]);
	assert.deepEqual(post.nativeWait.list(), []);
});
