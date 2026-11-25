/**
 * cp-qmry: the CLI a routing row names is binding. A saturated CLI queues the job ("waiting for <CLI> capacity") and
 * starts it on that same CLI when a slot frees; nothing ever re-routes it to pi. Real `cp_dispatch` of a pi parent
 * (mock model) with fake-codex and the fake `systemd-run` at the boundary (tests/harness/codex-worker.ts).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type FailureClass, isoTimestamp, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, type QualityReport, SCHEMA_VERSION } from "../../src/contracts.ts";
import { recoveryDigest, recoveryJson } from "../../src/gate-recovery.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { readRecoveryAttempts } from "../../src/recovery.ts";
import { fakePrompts, fakeSpawns } from "../harness/codex-mock.ts";
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
/** Lowers codex to one slot: two live codex jobs then fill it (CX-6f's trick, at a real boundary). */
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
	const escalations = existsSync(join(h.b.home, LAYOUT.escalationsFile)) ? readFileSync(join(h.b.home, LAYOUT.escalationsFile), "utf8") : "";
	assert.equal(escalations.includes(dead.id), false, "a queued revive (revive_refused, not attempted) escalates nothing");
	assert.deepEqual(ofType(h, dead.id, "recovery_escalated"), []);
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
// Then it is queued "waiting for Codex CLI capacity" (nothing sent, never pi); And once the other tears down the
// message is delivered on codex, on the job's own thread, and it reports again.
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
	// The implementer pin rides on every advance, so the queued one must carry it into its replay.
	const pin = { implementerModel: FAKE_CODEX_REF };
	let result = await post.advancePipeline(id, pin);
	for (let guard = 0; result.pending && guard < 10; guard += 1) {
		const key = ReviewRuns.key(result.pending.surface === "review" ? result.ship_id : id, result.pending.surface, result.pending.attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
		result = await post.advancePipeline(id, pin);
	}
	assert.equal(result.next, "wait", result.message);
	assert.match(result.message, new RegExp(`^${started.ship_id}: waiting for Codex CLI capacity — queued \\(position 1\\)`));
	assert.equal(h.record(started.ship_id), undefined, "no implementer ran on another CLI");
	assert.deepEqual(post.nativeWait.list().map((row) => [row.job_id, row.kind, row.driver]), [[id, "pipeline-advance", "codex"]]);
	assert.equal(post.nativeWait.read().entries[0]?.request.implementer_model, FAKE_CODEX_REF, "the queued advance keeps its pin");
	await post.tearDown(holder.id);
	const ship = await waitFor(() => h.record(started.ship_id), (record) => record?.worker.driver === "codex", { timeoutMs: 120_000, what: "the implementer on codex" });
	assert.deepEqual([ship?.worker.role, ship?.worker.model, ship?.routing?.driver], ["implementer", FAKE_CODEX_REF, "codex"]);
	assert.match(ship?.routing?.driver_reason ?? "", new RegExp(`override ${FAKE_CODEX_REF}`), "the replay ran with the pin");
	assert.deepEqual(post.nativeWait.list(), []);
});

// Off CI a laptop without treehouse skips by name; under CI (Actions and Dagger set CI=true) a missing tool fails.
const ciSkip = process.env.CI === "true" ? false : skip;

/** T6's in-process parent on h's home: this process's env carries the codex stub dir and the synthetic Codex home. */
function codexPost(t: TestContext, h: H): CommandPost {
	const saved = { PATH: process.env.PATH, CP_CODEX_HOME: process.env.CP_CODEX_HOME };
	Object.assign(process.env, h.env);
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
	});
	return h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_CODEX_REF }),
	}));
}

/** A filed research envelope for `id` over a minimal plan artifact, as T6 writes it. */
function fileResearch(post: CommandPost, h: H, id: string): void {
	mkdirSync(dirname(post.artifacts.file(id)), { recursive: true });
	writeFileSync(post.artifacts.file(id), "# Goal\nAdd a line to README.md.\n\n# File list\n- README.md\n\n# Test plan\nnpm test\n\n# Unknowns/Blockers\nnone\n");
	const envelope = { job_id: id, kind: "research", status: "done", summary: "plan complete", artifact_path: post.artifacts.file(id), plan_summary: MINIMAL_PLAN_SUMMARY,
		self_assessment: { scope: "S", confidence: "high", destructive_scope: false, blocking_unknowns: false } };
	mkdirSync(dirname(join(h.b.home, paths.envelopeFile(id))), { recursive: true });
	writeFileSync(join(h.b.home, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1, envelope }));
}

const VOTE = (id: string) => ({ job_id: id, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed the packet"] });

// Scenario (R3): a pipeline's quality panel on a full codex queues as kind "quality" (without QualityPass's wait: a
// "pipeline-advance"); once the slot frees it replays (nativeReplay) and its voter votes on codex, never pi.
test("R3-quality: a quality panel start on a full codex queues as quality and replays its voter on codex when the slot frees", { skip: ciSkip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_review: true } });
	const planner = h.b.provider.addScript("r3q-plan", [{ kind: "text", text: "Planned." }], { onExhausted: "repeat" });
	const piVoter = h.b.provider.addScript("r3q-pi-voter", [{ kind: "text", text: "unused" }]);
	h.b.agent.writeModels(h.b.provider);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: [
		{ id: "codex-plan", role: "planner", scope: ["S"], model: FAKE_CODEX_REF, driver: "codex" },
		{ id: "pi-plan", role: "planner", scope: ["L"], model: planner },
		{ id: "reviews", role: "gate-reviewer", model: FAKE_CODEX_REF, fallbacks: [piVoter], driver: "codex" },
	] }));
	const post = codexPost(t, h);
	const started = await post.startPipeline({ title: "r3q", project: "demo", task: "Add a line to README.md.", delivery: "local", scope: "L", fetch: false,
		quality: { verify: true, voters: 1 } });
	const id = started.research_id;
	const holder = await h.job();
	h.setScript({ turns: [h.reporting(holder.id), [{ kind: "tool", tool: "report_verdict", arguments: VOTE(id) }, { kind: "message", text: "Voted." }]] });
	await post.dispatch({ jobId: holder.id, task: "Report what README.md says.", scope: "S", fetch: false });
	await waitFor(() => ofType(h, holder.id, "agent_settled").length > 0, Boolean, { timeoutMs: 120_000, what: "the holder's settled, reported turn" });
	fileResearch(post, h, id);
	const result = await post.advancePipeline(id);
	assert.equal(result.next, "wait", result.message);
	assert.match(result.message, new RegExp(`^${started.ship_id}: waiting for Codex CLI capacity — queued \\(position 1\\)`));
	const entries = post.nativeWait.read().entries;
	assert.deepEqual(entries.map((entry) => [entry.job_id, entry.kind, entry.driver, entry.text]), [[id, "quality", "codex", "waiting for Codex CLI capacity"]]);
	assert.equal(entries[0]?.request.quality?.verify, true, JSON.stringify(entries[0]?.request));
	assert.equal(existsSync(join(h.b.home, paths.qualityFile(id))), false, "no panel voted while the CLI was full");
	const torn = await post.tearDown(holder.id);
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	await waitFor(() => existsSync(join(h.b.home, paths.qualityFile(id))), Boolean, { timeoutMs: 120_000, what: "the replayed panel's report" });
	const report = JSON.parse(readFileSync(join(h.b.home, paths.qualityFile(id)), "utf8")) as QualityReport;
	assert.deepEqual(report.verify?.votes.map((vote) => [vote.model, vote.abstained ?? false]), [[FAKE_CODEX_REF, false]], JSON.stringify(report));
	assert.equal(h.b.provider.requests("r3q-pi-voter").length, 0, "a voter ran on pi");
	assert.deepEqual(post.nativeWait.list(), []);
	assert.deepEqual(readdirSync(join(h.b.home, paths.runDir(id))).filter((name) => name.startsWith("waiting-quality-")), [], "the waiting task is removed");
});

/** A prepared recovery attempt for `jobId` (as cp_gate prepare_attempt writes it), bound to no recorded authority. */
function seedRecoveryAttempt(h: H, jobId: string, dependents: [string, string]): string {
	const [authority_id, predecessor_id] = ["ra-r3g-fixture", "anchor-r3g-fixture"];
	const attempt_id = recoveryDigest(recoveryJson({ authority_id, predecessor_id }));
	const artifact = readFileSync(join(h.b.home, paths.artifactFile(jobId)));
	const task = Buffer.from("frozen recovery task\n");
	const attempt = { schema_version: 2, attempt_id, authority_id, predecessor_id, job_id: jobId, root_job_id: jobId, dependent_job_ids: dependents,
		history_sha256: recoveryDigest(Buffer.from("history")), graph_sha256: recoveryDigest(Buffer.from("graph")), artifact_sha256: recoveryDigest(artifact),
		artifact_bytes: artifact.length, task_sha256: recoveryDigest(task), artifact_base64: artifact.toString("base64"), task_base64: task.toString("base64"), state: "prepared" };
	mkdirSync(join(h.b.home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(h.b.home, paths.runDir(jobId), `recovery-attempt-${attempt_id}-prepared.json`), recoveryJson(attempt));
	return attempt_id;
}

// Scenario (R3): cp_gate with recovery_attempt_id on a full codex queues as kind "gate" with that id, nothing claimed;
// the replay re-reads, claims and re-validates the attempt (no recorded authority here: invalidated, no reviewer runs).
test("R3-recovery-gate: a recovery gate on a full codex queues with its attempt id and replays with the attempt re-read", { skip: ciSkip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_review: true } });
	h.reviewsRow(h.b.provider.addScript("r3g-pi", [{ kind: "text", text: "unused" }]));
	const [holder, subject, first, second] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	writeFileSync(subject.artifact, "# recovery candidate\n");
	const attemptId = seedRecoveryAttempt(h, subject.id, [first.id, second.id]);
	const runDir = join(h.b.home, paths.runDir(subject.id));
	const terminal = join(runDir, `recovery-attempt-${attemptId}-terminal.json`);
	const [snapshot, listing] = [join(h.state, "native-wait-snapshot.json"), join(h.state, "run-dir-while-queued.txt")];
	h.setScript({ turns: [h.reporting(holder.id)] });
	const ends = await h.run([
		holder.dispatch(), h.awaitEnvelope(holder.id),
		step("cp_gate", { job_id: subject.id, recovery_attempt_id: attemptId }),
		step("bash", { command: `cp '${join(h.b.home, LAYOUT.nativeWaitFile)}' '${snapshot}' && ls -1 '${runDir}' > '${listing}'` }),
		h.waitEvent(holder.id, "agent_settled"), step("cp_teardown", { job_id: holder.id }), h.awaitFile(terminal), h.pause(2),
	]);
	const teardown = ends.find((end) => end.toolName === "cp_teardown");
	assert.equal(teardown?.result.details?.torn_down, true, text(teardown));
	const gate = ends.find((end) => end.toolName === "cp_gate");
	assert.notEqual(gate?.isError, true, text(gate));
	assert.deepEqual([gate?.result.details?.state, gate?.result.details?.kind, gate?.result.details?.position, gate?.result.details?.waiting],
		["queued", "gate", 1, "waiting for Codex CLI capacity"], text(gate));
	const queued = (JSON.parse(readFileSync(snapshot, "utf8")) as { entries: Array<{ kind: string; job_id: string; driver: string; request: { recovery_attempt_id?: string } }> }).entries;
	assert.deepEqual(queued.map((entry) => [entry.kind, entry.job_id, entry.driver, entry.request.recovery_attempt_id]), [["gate", subject.id, "codex", attemptId]]);
	const whileQueued = readFileSync(listing, "utf8").split("\n").filter(Boolean);
	assert.deepEqual(whileQueued.filter((name) => /^gate-\d+-standing\.json$/.test(name)), [], `the queued gate claimed an ordinal: ${JSON.stringify(whileQueued)}`);
	// The replay, not the refused start, claimed a gate ordinal for this attempt and re-validated its authority.
	const standing = readdirSync(runDir).filter((name) => /^gate-\d+-standing\.json$/.test(name));
	assert.equal(standing.length, 1, JSON.stringify(readdirSync(runDir)));
	assert.equal((JSON.parse(readFileSync(join(runDir, standing[0]!), "utf8")) as { attempt_id: string }).attempt_id, attemptId);
	assert.equal((JSON.parse(readFileSync(terminal, "utf8")) as { outcome: string }).outcome, "invalidated");
	assert.equal(readdirSync(runDir).some((name) => /^gate-\d+\.json$/.test(name)), false, "no reviewer decided");
	assert.equal(h.b.provider.requests("r3g-pi").length, 0, "a reviewer ran on pi");
	assert.deepEqual(waitEntries(h), []);
});

const dispatchQueue = (h: H) => (existsSync(join(h.b.home, LAYOUT.dispatchQueueFile))
	? (JSON.parse(readFileSync(join(h.b.home, LAYOUT.dispatchQueueFile), "utf8")) as { entries: Array<{ job_id: string }> }).entries : []);
/** The job's fleet record; none before any job took a lease (no fleet file yet). */
const fleetRecord = (h: H, id: string) => (existsSync(join(h.b.home, LAYOUT.fleetFile)) ? h.record(id) : undefined);

// Scenario (T9–T11 on codex, cp-1nrn): Given a held codex pr author at the default codex_max_concurrent 1, When cp_review
//   runs on a codex reviews row, Then the reviewer borrows the author's slot (routing names it) and a verdict lands; a
//   cp_send to the author meanwhile queues naming the borrowed slot and an unrelated codex job queues with no borrow; after
//   the verdict the send reaches the author's own thread on codex while the unrelated job still waits.
test("T9c: a held codex author lends its slot to its own codex reviewer; a send waits for the verdict, an unrelated job keeps waiting", { skip: ciSkip, timeout: 420_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_ship: true, codex_review: true }, ship: true });
	h.reviewsRow(h.b.provider.addScript("t9c-pi", [{ kind: "text", text: "unused" }]));
	const [author, other] = [await h.job("pr", "ship"), await h.job()];
	const blocked = { job_id: author.id, kind: "ship", status: "blocked", summary: "T9c change pushed.", blockers: ["the e2e case ends here"] };
	const message = "T10 follow-up: report once more.";
	h.setScript({ turns: [
		[
			{ kind: "shell", command: "printf 't9c\\n' > t9c.txt" }, { kind: "tool", tool: "git_commit", arguments: { message: "t9c" } },
			{ kind: "tool", tool: "git_push", arguments: {} }, { kind: "tool", tool: "report_result", arguments: blocked }, { kind: "message", text: "Reported." },
		],
		// The reviewer holds its verdict while the parent sends to the author and dispatches the unrelated job.
		[{ kind: "hold", marker: "reviewing", forMs: 8_000 }, { kind: "tool", tool: "report_verdict", arguments: VOTE(author.id) }, { kind: "message", text: "Reviewed." }],
		[{ kind: "message", text: "Follow-up handled." }],
	] });
	const ends = await h.run([
		author.dispatch({ task: "Add t9c.txt, commit, push and report." }), h.awaitEnvelope(author.id), h.waitEvent(author.id, '"type":"native_run"', 1),
		step("cp_review", { job_id: author.id }), step("cp_send", { job_id: author.id, message }),
		step("cp_dispatch", { job_id: other.id, task: "Report what README.md says.", model: FAKE_CODEX_REF, driver: "codex" }),
		h.waitEvent(author.id, '"type":"native_run"', 2), h.pause(2),
	]);
	const review = ends.find((end) => end.toolName === "cp_review");
	assert.notEqual(review?.isError, true, text(review));
	const { routed, result } = await h.reviewRun(author.id);
	assert.match(String(routed?.line), new RegExp(`driver=codex slot="reviewer using held author's slot ${author.id}"`), JSON.stringify(routed));
	assert.match(String(routed?.driver_reason), new RegExp(`^borrowed: reviewer using held author's slot \\(${author.id}\\)`));
	assert.equal(result.verdict, "pass", JSON.stringify(result));
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.equal(sent?.result.details?.receipt, "queued", text(sent));
	assert.match(String(sent?.result.details?.waiting), /^waiting for Codex CLI capacity: its reviewer is using the held author's slot \(/);
	const unrelated = ends.find((end) => end.toolName === "cp_dispatch" && JSON.stringify(end.result.details ?? {}).includes(other.id));
	assert.deepEqual([unrelated?.result.details?.state, unrelated?.result.details?.waiting], ["queued", "waiting for Codex CLI capacity"], text(unrelated));
	const delivered = fakePrompts(h.state).filter((each) => each.text.includes(message));
	assert.equal(delivered.length, 1, "the follow-up was delivered once, after the verdict");
	assert.equal(delivered[0]?.threadId, h.session(author.id).thread_id, "on the author's own codex thread");
	assert.equal(h.record(author.id)?.worker.driver, "codex");
	assert.equal(h.record(other.id), undefined, "the unrelated job never borrowed and never ran on another CLI");
	assert.ok(dispatchQueue(h).some((entry) => entry.job_id === other.id), JSON.stringify(dispatchQueue(h)));
});

/** PATH without any `codex`: links to the other tools of a dir holding one (treehouse among them), then the rest. */
function pathWithoutCodex(h: H): string {
	const tools = join(h.root, "no-codex-tools");
	mkdirSync(tools);
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs.filter((each) => existsSync(join(each, "codex")))) {
		for (const name of readdirSync(dir).filter((each) => each !== "codex")) {
			try { symlinkSync(join(dir, name), join(tools, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
	}
	return [tools, ...dirs.filter((dir) => !existsSync(join(dir, "codex")))].join(delimiter);
}

// Scenario (#869 refusals on codex, cp-1nrn): Given a codex planner row with a pi fallback, When a job is dispatched with
//   no codex on PATH, and another with codex signed out, Then each refuses naming its reason (never pi): no fleet record,
//   no run dir, no app-server. The Claude counterpart is "claude refusals" in driver-hard-constraint-claude.test.ts.
test("CX-qmry-refusals: on a codex row a missing Codex CLI and a signed-out codex each refuse by name and never run pi", { skip: ciSkip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	codexRow(h);
	const [missing, signedOut] = [await h.job(), await h.job()];
	const once = { task: "Report what README.md says.", queue: false, when_ready: false };
	const [noCli] = (await h.run([step("cp_dispatch", { job_id: missing.id, ...once })], { PATH: pathWithoutCodex(h) })).filter((end) => end.toolName === "cp_dispatch");
	h.setScript({ knobs: { loginStatus: 1 }, turns: [] });
	await h.b.closeParents();
	const [noAuth] = (await h.run([step("cp_dispatch", { job_id: signedOut.id, ...once })])).filter((end) => end.toolName === "cp_dispatch");
	for (const [end, id, reason] of [[noCli, missing.id, /cannot run on the Codex CLI driver: codex is not on PATH/], [noAuth, signedOut.id, /cannot run on the Codex CLI driver: codex is not signed in/]] as const) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), reason);
		assert.equal(fleetRecord(h, id), undefined, `${id} ran on another CLI`);
		assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	}
	assert.deepEqual(fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server"), [], "no app-server started");
});
