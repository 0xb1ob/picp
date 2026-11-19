/**
 * C2 and C2b: follow-ups, revive, recovery and steer for Codex CLI research jobs through the real `cp_dispatch`,
 * `cp_send`, `cp_revive` and `cp_teardown` of a pi parent (mock parent model), with tests/fixtures/fake-codex.ts and the
 * fake `systemd-run` at the boundary. Every case checks the synthetic Codex home is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { nativeRevivePrompt } from "../../src/drivers/claude-followup.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { AUTH_SENTINEL, fakePids, fakePrompts, fakeRpcMethods, fakeScopes, fakeSpawns, fakeThreadTotal } from "../harness/codex-mock.ts";
import { codexWorkerHome } from "../harness/codex-worker.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");
const send = (jobId: string, message: string, mode?: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_send", args: { job_id: jobId, message, ...(mode ? { mode } : {}) } }] });
const tool = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const appServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");

/** The Codex home is untouched, and no host OPENAI_/CODEX_ key but CODEX_HOME reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of appServers(h)) assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
}

/** KC4: the job's counted tokens equal the fake thread's own cumulative total, so no resume recounted a turn. */
function assertCountedOnce(h: H, id: string): void {
	const status = readRunStatus(h.b.home, id);
	const threadId = h.session(id).thread_id as string;
	assert.equal(status.usage.total_tokens, fakeThreadTotal(h.state, threadId).totalTokens, JSON.stringify(status.usage));
	assert.equal(status.usage.cost_usd, 0);
}

const noQueueLeft = (h: H, id: string) => {
	for (const file of ["native-followups.jsonl", "native-followups.jsonl.claimed"]) assert.equal(existsSync(join(h.b.home, paths.runDir(id), file)), false, file);
};

test("CX-2a: an idle cp_send resumes the same thread under the lockdown and counts tokens once; with the switch off it refuses before any app-server", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id), h.reporting(job.id)] });
	const ends = await h.run([
		job.dispatch(), h.waitEvent(job.id, "agent_settled", 1),
		send(job.id, "Follow-up: check README.md once more and report again."),
		h.waitEvent(job.id, "envelope_received", 2), h.waitEvent(job.id, "agent_settled", 2),
		tool("bash", { command: `echo '{"codex_research":false}' > "${h.nativeFile}"` }),
		send(job.id, "One more, with the switch off."),
	]);
	const [first, second] = ends.filter((end) => end.toolName === "cp_send");
	assert.notEqual(first?.isError, true, text(first));
	assert.equal(first?.result.details?.mode, "prompt");
	assert.match(String(first?.result.details?.native), /^resuming: one new Codex app-server resumes this job's thread/);
	const session = h.session(job.id);
	assert.equal(fakeRpcMethods(h.state).filter((method) => method === "thread/resume").length, 1);
	const prompts = fakePrompts(h.state);
	assert.deepEqual(prompts.map((each) => each.threadId), [session.thread_id, session.thread_id], "both turns on the recorded thread");
	assert.match(prompts[1]?.text ?? "", /Follow-up: check README\.md once more/);
	const runs = await h.runs(job.id);
	assert.deepEqual(runs.map((run) => [run.resumed, run.lockdown]), [[false, "ok"], [true, "ok"]], JSON.stringify(runs));
	assert.equal(ofType(h, job.id, "envelope_received").length, 2);
	assertCountedOnce(h, job.id);
	assert.equal(session.totals?.totalTokens, fakeThreadTotal(h.state, session.thread_id as string).totalTokens, "the record holds the next baseline");
	for (const scope of fakeScopes(h.state).filter((each) => each.started)) assert.ok(scope.unit, JSON.stringify(scope));
	// The switch off: the send's admission refuses by name and no third run starts.
	assert.equal(second?.isError, true, text(second));
	assert.match(text(second), /cannot run on the Codex CLI driver: the switch codex_research is off/);
	assert.equal(appServers(h).length, 4, "a trust probe and a run per turn, none for the refused send");
	assertClean(h);
});

test("CX-2b: a busy follow_up is queued durably and delivered once on a resumed thread after the turn", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const [artifact, hold, ...rest] = h.reporting(job.id, [{ kind: "hold", marker: "held", forMs: 8_000 }]);
	h.setScript({ turns: [[artifact!, hold!, ...rest], [{ kind: "message", text: "Follow-up handled." }]] });
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")),
		send(job.id, "Queued follow-up text.", "follow_up"),
		h.waitEvent(job.id, "native_followup_delivered", 1), h.waitEvent(job.id, "agent_settled", 1),
	]);
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.equal(sent?.result.details?.receipt, "queued", text(sent));
	assert.match(String(sent?.result.details?.native), /^queued until the current turn ends/);
	assert.equal(ofType(h, job.id, "native_followup_delivered").length, 1);
	const delivered = fakePrompts(h.state).filter((each) => each.text.includes("Queued follow-up text."));
	assert.deepEqual(delivered.map((each) => each.method), ["turn/start"]);
	const methods = fakeRpcMethods(h.state);
	assert.ok(methods.indexOf("thread/resume") >= 0 && methods.lastIndexOf("turn/start") > methods.indexOf("thread/resume"), methods.join(","));
	noQueueLeft(h, job.id);
	assertCountedOnce(h, job.id);
	assertClean(h);
});

test("CX-2c: a parent close mid-turn leaves no process; cp_revive refuses with the switch off and resumes the thread with it on", { skip, timeout: 420_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [[{ kind: "shell", command: "sleep 300", background: true }, { kind: "hold", marker: "held" }], h.reporting(job.id)] });
	await h.run([job.dispatch(), h.awaitFile(join(h.state, "held"))]);
	const threadId = h.session(job.id).thread_id;
	assert.ok(threadId, "the thread was recorded at turn/started");
	await h.b.closeParents();
	const pids = [...fakePids(h.state), ...appServers(h).map((each) => each.pid)];
	await waitFor(() => pids.filter(isPidAlive), (alive) => alive.length === 0, { timeoutMs: 30_000, what: "every command and app-server pid gone" });
	await waitFor(() => fakeScopes(h.state), (scopes) => scopes.filter((each) => each.killed !== undefined || each.collected).length >= scopes.filter((each) => each.started).length,
		{ timeoutMs: 20_000, what: "every started scope killed or collected" });
	t.diagnostic(`U9: turn/interrupt ${fakeRpcMethods(h.state).includes("turn/interrupt") ? "was" : "was not"} sent on the parent close`);
	const spawned = appServers(h).length;
	writeFileSync(h.nativeFile, JSON.stringify({ codex_research: false }));
	const off = (await h.run([tool("cp_revive", { job_id: job.id, confirm: true })])).find((end) => end.toolName === "cp_revive");
	assert.match(text(off), /native_refused.*the switch codex_research is off/, text(off));
	assert.equal(appServers(h).length, spawned, "no app-server for the refused revive");
	writeFileSync(h.nativeFile, JSON.stringify({ codex_research: true }));
	await h.b.closeParents();
	const ends = await h.run([
		tool("cp_revive", { job_id: job.id, confirm: true }), h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 1),
		tool("cp_teardown", { job_id: job.id }),
	]);
	const revived = ends.find((end) => end.toolName === "cp_revive");
	assert.notEqual(revived?.isError, true, text(revived));
	assert.match(text(revived), /resumed its Codex CLI thread with picp's revive prompt/);
	assert.equal(ofType(h, job.id, "worker_revived").length, 1);
	const prompt = fakePrompts(h.state).find((each) => each.text.includes(nativeRevivePrompt("research").slice(0, 40)));
	assert.equal(prompt?.threadId, threadId, "the revive prompt ran on the recorded thread");
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	assert.equal((ofType(h, job.id, "native_thread_deleted")[0]?.payload as { deleted?: boolean } | undefined)?.deleted, true);
	assertClean(h);
});

test("CX-2d: an unreported clean turn settles instead of failing, and picp's nudge resumes the thread to its report", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [[{ kind: "message", text: "Looked around; no report yet." }], h.reporting(job.id)] });
	await h.run([job.dispatch(), h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 2)]);
	const types = readRunEvents(h.b.home, job.id).map((event) => event.type);
	assert.ok(types.indexOf("agent_settled") < types.indexOf("report_nudged"), types.join(","));
	assert.equal(ofType(h, job.id, "failure").length, 0, "the clean unreported turn did not fail");
	const nudges = ofType(h, job.id, "report_nudged");
	assert.deepEqual(nudges.map((event) => (event.payload as { receipt?: string }).receipt), ["delivered"]);
	const runs = await h.runs(job.id);
	assert.deepEqual(runs.map((run) => run.resumed), [false, true]);
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assert.equal(h.record(job.id)?.phase, "held");
	assertClean(h);
});

test("CX-2e: bounded recovery revives a SIGKILLed codex worker once on its thread, and it reports", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [[{ kind: "hold", marker: "held" }], h.reporting(job.id)] });
	const killer = (async () => {
		await waitFor(() => existsSync(join(h.state, "held")) && h.record(job.id)?.worker.pid, Boolean, { timeoutMs: 90_000, what: "the held codex turn" });
		process.kill(h.record(job.id)?.worker.pid as number, "SIGKILL");
	})();
	await h.run([job.dispatch(), h.awaitFile(join(h.state, "held")), h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 1)]);
	await killer;
	const failure = ofType(h, job.id, "failure")[0]?.payload as { class?: string } | undefined;
	t.diagnostic(`U5: the SIGKILLed codex worker failed as ${failure?.class ?? "no failure event"}`);
	const attempted = ofType(h, job.id, "recovery_attempted")[0]?.payload as Record<string, unknown> | undefined;
	assert.deepEqual([attempted?.action, attempted?.native_revive], ["revive", true], JSON.stringify(readRunEvents(h.b.home, job.id).filter((event) => /recovery|failure/.test(event.type))));
	assert.equal(ofType(h, job.id, "worker_revived").length, 1);
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assertClean(h);
});

test("CX-2f: a busy steer is acknowledged by turn/steer on the live turn: delivered, steered, no second turn", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const [artifact, ...rest] = h.reporting(job.id);
	h.setScript({ turns: [[artifact!, { kind: "hold", marker: "held" }, ...rest]] });
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")),
		send(job.id, "Steer: also note the README's first line.", "steer"),
		h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 1),
	]);
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.deepEqual([sent?.result.details?.receipt, sent?.result.details?.mode], ["delivered", "steer"], text(sent));
	assert.match(String(sent?.result.details?.native), /^steered: the Codex CLI acknowledged turn\/steer/);
	assert.equal((ofType(h, job.id, "steer_sent")[0]?.payload as { disposition?: string } | undefined)?.disposition, "steered");
	assert.equal(ofType(h, job.id, "native_steered").length, 1);
	const prompts = fakePrompts(h.state);
	assert.deepEqual(prompts.map((each) => each.method), ["turn/start", "turn/steer"]);
	assert.equal(prompts[1]?.turnId, prompts[0]?.turnId, "the steer went to the live turn");
	noQueueLeft(h, job.id);
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assert.match(readFileSync(readRunStatus(h.b.home, job.id).transcript_file as string, "utf8"), /Steered the running turn[\s\S]*Steer: also note the README/);
	assertClean(h);
});

test("CX-2g: a steer the CLI refuses with -32600 is queued and delivered once as a new turn", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const [artifact, ...rest] = h.reporting(job.id);
	h.setScript({ knobs: { steer: "refuse" }, turns: [[artifact!, { kind: "hold", marker: "held", forMs: 8_000 }, ...rest], [{ kind: "message", text: "Steer handled." }]] });
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")),
		send(job.id, "Refused steer text."),
		h.waitEvent(job.id, "native_followup_delivered", 1), h.waitEvent(job.id, "agent_settled", 1),
	]);
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.deepEqual([sent?.result.details?.receipt, sent?.result.details?.mode], ["queued", "steer"], text(sent));
	assert.match(String(sent?.result.details?.native), /^queued until the current turn ends/);
	assert.equal(ofType(h, job.id, "native_steered").length, 0);
	assert.equal(ofType(h, job.id, "native_followup_delivered").length, 1);
	assert.deepEqual(fakePrompts(h.state).filter((each) => each.text.includes("Refused steer text.")).map((each) => each.method), ["turn/start"]);
	assertClean(h);
});

test("CX-2h: after the report a steer is refused by name and auto queues a new turn that reopens the slot", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const [artifact, report] = h.reporting(job.id);
	h.setScript({ turns: [[artifact!, report!, { kind: "hold", marker: "held", forMs: 8_000 }], h.reporting(job.id)] });
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")), h.waitEvent(job.id, "envelope_received", 1),
		send(job.id, "A steer after the report.", "steer"),
		send(job.id, "A follow-up after the report."),
		h.waitEvent(job.id, "envelope_received", 2), h.waitEvent(job.id, "agent_settled", 1),
	]);
	const [steer, auto] = ends.filter((end) => end.toolName === "cp_send");
	assert.equal(steer?.isError, true, text(steer));
	assert.match(text(steer), /has already reported: a steer cannot reopen its report slot/);
	assert.notEqual(auto?.isError, true, text(auto));
	assert.deepEqual([auto?.result.details?.mode, auto?.result.details?.receipt], ["follow_up", "queued"], text(auto));
	assert.equal((ofType(h, job.id, "envelope_superseded")[0]?.payload as { generation?: number } | undefined)?.generation, 1);
	assert.equal(fakePrompts(h.state).some((each) => each.method === "turn/steer"), false);
	assert.equal(ofType(h, job.id, "envelope_received").length, 2);
	assertClean(h);
});
