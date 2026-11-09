/**
 * N3c: follow-ups into Claude CLI research jobs through the real `cp_send`, `cp_revive` and `cp_teardown` of a pi
 * parent (mock parent model), the installed `claude` against the loopback fake model, synthetic credentials in a temp
 * HOME's settings file, a temp CLAUDE_CONFIG_DIR per job and no user setting sources. F1–F8 of the N3c task.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CommandPost } from "../../src/command-post.ts";
import { QUOTA_CONTINUE_NUDGE, type QuotaIntent, quotaContinuationFile } from "../../src/quota-continuation.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
import { childPids } from "../../src/revive.ts";
import { DEFAULT_BUDGET_CONFIG, type Failure, LAYOUT, paths, type ReviewSurface } from "../../src/contracts.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { whichAll } from "../../src/doctor.ts";
import { NATIVE_FOLLOWUPS_FILE, NATIVE_SESSION_FILE, nativeRevivePrompt, queuedFollowUps, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { OBSERVATION_EVENT } from "../../src/drivers/claude-observation.ts";
import { recordNativeObservation } from "../../src/native-availability.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { VERDICT_TOOL } from "../../src/drivers/claude-verdict.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, FAKE_NATIVE_MODEL, type RecordedClaudeRequest, routeNativeModel, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { LIVE_TESTS_ENABLED, readFleet, readRunEvents, readRunStatus, REPO_ROOT, type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";

const missing = [whichAll("claude", process.env)[0] === undefined && "claude", !treehouseAvailable() && "treehouse"].filter(Boolean);
const skip = missing.length > 0 ? `needs ${missing.join(" and ")} on PATH` : false;
type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
const call = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
const tool = (name: string, args: unknown) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const report = (jobId: string, home: string) => ({
	job_id: jobId, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(jobId)),
	plan_summary: { goal: "Name the package.", approach: ["Read README.md."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] },
});
const messages = (request: RecordedClaudeRequest | undefined) => JSON.stringify(request?.body.messages ?? []);
const modelCalls = (requests: readonly RecordedClaudeRequest[]) => requests.filter((request) => request.path.split("?")[0] === "/v1/messages");

async function nativeHome(t: TestContext, script: readonly ClaudeStep[]) {
	const b = await dispatchS29(t);
	const claude = await startClaudeMockProvider(script);
	routeNativeModel(b.home);
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-n3c-home-"));
	t.after(async () => { await claude.close(); rmSync(fakeHome, { recursive: true, force: true }); });
	const settings = join(fakeHome, ".claude", "settings.json");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	const switchFile = join(b.home, LAYOUT.data, "native.json");
	const drain = join(b.home, LAYOUT.state, "drain.json");
	const now = new Date().toISOString();
	const freeze = JSON.stringify({ state: "drained", started_at: now, deadline: now, timeout_s: 0, jobs: [], cause: { reason: "freeze" } });
	writeFileSync(switchFile, JSON.stringify({ claude_research: true }));
	const job = () => b.ledger.create({ title: `native followups ${Math.random()}`, project: "demo", delivery: "local", kind: "research" });
	const events = (id: string) => join(b.home, paths.eventsFile(id));
	// Waits in the parent's bash until `pattern` appears `count` times in the job's run log (bounded at 120 s).
	const wait = (id: string, pattern: string, count: number) =>
		tool("bash", { command: `for i in $(seq 600); do [ "$(grep -c '${pattern}' "${events(id)}" 2>/dev/null)" -ge ${count} ] && break; sleep 0.2; done; sleep 1` });
	const sh = (command: string) => tool("bash", { command });
	return {
		b, claude, settings, job, events, wait, sh, env: { HOME: fakeHome },
		off: sh(`echo '{"claude_research":false}' > "${switchFile}"`),
		on: sh(`echo '{"claude_research":true}' > "${switchFile}"`),
		frozen: sh(`echo '{"claude_research":true}' > "${switchFile}" && echo '${freeze}' > "${drain}"`),
		thawed: sh(`rm -f "${drain}"`),
		dispatch: (id: string) => tool("cp_dispatch", { job_id: id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" }),
	};
}

test("F1/F3/F4/F8: a busy send queues until the turn ends, idle sends resume the session, usage counts once, gates stay on", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		// Run 1 holds its first answer so the parent's send lands mid-turn.
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }], beforeAnswer: () => sleep(6_000) },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
		{ kind: "text", text: "Noted the queued follow-up." },
		call("Bash", { command: "echo x > native-write.txt" }),
		{ kind: "tool_use", calls: [{ name: "Read", input: () => ({ file_path: h.settings }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported again." },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported a third time." },
	]);
	const native = await h.job();
	ids.push(native.id);
	const id = native.id;
	// The budget is set to exactly the billable total after two resumes, so the next resume's admission must refuse it.
	const spendAll = { kind: "tool_calls" as const, calls: [{ name: "bash", args: () => {
		const fleetFile = join(h.b.home, LAYOUT.fleetFile);
		const fleet = JSON.parse(readFileSync(fleetFile, "utf8")) as { jobs: Array<{ job_id: string; budget?: unknown }> };
		const usage = readRunStatus(h.b.home, id).usage;
		fleet.jobs.find((job) => job.job_id === id)!.budget = { tokens: usage.total_tokens - usage.cache_read, cost_usd: 1_000 };
		writeFileSync(fleetFile, JSON.stringify(fleet, null, 2));
		return { command: "true" };
	} }] };
	const ends = (await h.b.run([
		h.dispatch(id),
		tool("cp_send", { job_id: id, message: "Queued follow-up: also note the license." }),
		tool("cp_send", { job_id: id, message: "Steer now.", mode: "steer" }),
		h.wait(id, "agent_settled", 1),
		tool("cp_send", { job_id: id, message: "Idle follow-up one." }),
		h.wait(id, "agent_settled", 2),
		tool("cp_send", { job_id: id, message: "Idle follow-up two." }),
		h.wait(id, "agent_settled", 3),
		spendAll,
		tool("cp_send", { job_id: id, message: "Over budget." }),
		tool("cp_teardown", { job_id: id }),
	], h.env)) as Tool[];
	const sends = ends.filter((end) => end.toolName === "cp_send");
	const [queued, steer, first, second, overBudget] = sends;
	const events = readRunEvents(h.b.home, id);
	const runs = events.filter((event) => event.type === "native_run").map((event) => event.payload as Record<string, unknown>);
	t.diagnostic(JSON.stringify({ runs: runs.map((run) => ({ resumed: run.resumed, usage: run.usage, report: run.report, lockdown: run.lockdown })) }));

	// F3: the busy send was queued, acked as queued until the turn ended, and delivered by one resume after it.
	assert.notEqual(queued?.isError, true, text(queued));
	assert.equal(queued?.result.details?.receipt, "queued", text(queued));
	assert.equal(queued?.result.details?.mode, "follow_up");
	assert.match(String(queued?.result.details?.native), /queued until the current turn ends/);
	assert.equal(steer?.isError, true, "a mid-turn steer is refused, never acked");
	assert.match(text(steer), /no mid-turn steer/);
	assert.equal(events.some((event) => event.type === "steer_sent"), false);
	assert.equal(events.filter((event) => event.type === "native_followup_delivered").length, 1);
	const calls = modelCalls(h.claude.requests);
	const run2 = calls.find((request) => messages(request).includes("Queued follow-up: also note the license."));
	assert.ok(run2, "the queued message reached the model");
	assert.ok(messages(run2).includes("Report the repo"), "the queued follow-up resumed the dispatched conversation");
	// N4b: the resumed process carries the role contract again, not only the dispatched one.
	for (const request of [calls[0], run2]) assert.match(JSON.stringify(request?.body.system ?? ""), /A plan is executable or it is not a plan\./);

	// F1: idle sends resume the same session (the earlier turns are in the conversation) and the replies land.
	for (const send of [first, second]) {
		assert.notEqual(send?.isError, true, text(send));
		assert.equal(send?.result.details?.receipt, "delivered", text(send));
		assert.match(String(send?.result.details?.native), /^resuming:/);
	}
	const run3 = calls.find((request) => messages(request).includes("Idle follow-up one."));
	assert.ok(messages(run3).includes("Noted the queued follow-up."), "the idle send resumed the same session");
	assert.equal(runs.length, 4);
	assert.deepEqual(runs.map((run) => run.resumed), [false, true, true, true]);
	// Reports: one accepted per generation (dispatch, then each idle send's reopened slot); the queued turn adds none.
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 3);
	assert.equal(events.filter((event) => event.type === "envelope_superseded").length, 2);

	// F8: the resumed run still refuses a Bash write and a settings read.
	const results = toolResults(h.claude.requests);
	assert.ok(results.some((result) => result.startsWith("[error]") && /read-only|Refused/.test(result) && results.indexOf(result) >= 1), results.join("\n"));
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === id);
	assert.equal(existsSync(join(record!.worktree, "native-write.txt")), false, "Bash wrote the worktree on a resume");
	assert.equal(runs[2]?.denials, 2, "both gated calls of the resumed run were denied");
	assert.equal(h.claude.requests.some((request) => JSON.stringify(request.body).includes(FAKE_CLAUDE_AUTH_TOKEN)), false);

	// F4: four measured runs sum to exactly the model calls made (no restored total recounted); cost equals the session's.
	assert.deepEqual(runs.map((run) => run.usage), ["measured", "measured", "measured", "measured"]);
	const status = readRunStatus(h.b.home, id);
	assert.deepEqual({ input: status.usage.input, output: status.usage.output }, { input: calls.length * 12, output: calls.length * 7 });
	const session = readNativeSession(join(h.b.home, paths.runDir(id), NATIVE_SESSION_FILE));
	assert.ok(Math.abs(status.usage.cost_usd - (session.baseline?.cost_usd ?? Number.NaN)) < 1e-9, `${status.usage.cost_usd} vs ${session.baseline?.cost_usd}`);
	// ...and the real admission path reads that running total: at the budget, the next resume is refused before a spawn.
	assert.equal(overBudget?.isError, true, text(overBudget));
	assert.match(text(overBudget), new RegExp(`per-job budget is spent \\(${status.usage.total_tokens}/${status.usage.total_tokens} billable`));
	assert.equal(readRunEvents(h.b.home, id).filter((event) => event.type === "native_run").length, 4);

	// Teardown: the observed exit, then the kept scratch dir is gone.
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	const removed = readRunEvents(h.b.home, id).find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.equal(removed?.removed, session.scratch_dir);
	assert.equal(existsSync(session.scratch_dir), false, "the scratch dir survived teardown");
	// The Log: every resumed turn (the queued one, then each idle send) appends to the one transcript, marked resumed.
	const transcript = readFileSync(status.transcript_file!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; content?: string; message?: { content?: Array<{ text?: string }> } });
	assert.equal(transcript.filter((line) => line.type === "session").length, 1, "one transcript, one header");
	assert.equal(transcript.filter((line) => line.type === "custom_message" && line.content === "Resumed the recorded Claude session").length, 3);
	const said = transcript.flatMap((line) => line.message?.content?.map((block) => block.text ?? "") ?? []).join("\n");
	for (const text of ["Queued follow-up: also note the license.", "Idle follow-up two.", "Reported a third time."]) assert.ok(said.includes(text), text);
	assert.equal(h.claude.overrun(), 0);
});

test("F2/F5/F6: switch-off and freeze refuse resume and revive, revive resumes once", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
		// N4e: an unreported clean turn would settle idle and be nudged, so this follow-up ends at its turn limit (3).
		call("Bash", { command: "ls" }),
		call("Bash", { command: "ls -a" }),
		call("Bash", { command: "ls -l" }),
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the revive." },
	]);
	const native = await h.job();
	ids.push(native.id);
	const id = native.id;
	const fleet = join(h.b.home, LAYOUT.fleetFile);
	// Two parent runs keep each under the harness's 90 s settle bound; the turn-limit follow-up ends the worker failed.
	const limited = { ...h.env, CP_NATIVE_MAX_TURNS: "3" };
	const first = (await h.b.run([
		h.dispatch(id),
		h.wait(id, "agent_settled", 1),
		h.off,
		tool("cp_send", { job_id: id, message: "Switched off." }),
		h.frozen,
		tool("cp_send", { job_id: id, message: "Frozen." }),
		h.thawed,
		tool("cp_send", { job_id: id, message: "Follow-up without a report." }),
		h.wait(id, "process_exit", 1),
	], limited)) as Tool[];
	await h.b.closeParents();
	const ends = (await h.b.run([
		h.off,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.frozen,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.thawed,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.wait(id, "agent_settled", 2),
		// M1: a record that lost its session id makes the next resume throw after the "resuming" ack.
		h.sh(`sed -i 's/,"session_id":"[^"]*"//' "${join(h.b.home, paths.runDir(id), NATIVE_SESSION_FILE)}"`),
		tool("cp_send", { job_id: id, message: "Resume that cannot start." }),
		h.wait(id, "native_resume_failed", 1),
		h.off,
		tool("cp_teardown", { job_id: id }),
	], limited)) as Tool[];
	const [offSend, frozenSend, resumed] = first.filter((end) => end.toolName === "cp_send");
	const [offRevive, frozenRevive, revived] = ends.filter((end) => end.toolName === "cp_revive");
	const runsBefore = (pattern: RegExp) => modelCalls(h.claude.requests).filter((request) => pattern.test(messages(request))).length;

	// F5/F6 on resume: refused by name before any process starts; the refused messages never reached the model.
	assert.equal(offSend?.isError, true, text(offSend));
	assert.match(text(offSend), /workers\.native_claude_research is off/);
	assert.equal(frozenSend?.isError, true, text(frozenSend));
	assert.match(text(frozenSend), /draining/);
	assert.equal(runsBefore(/Switched off\.|Frozen\./), 0);
	assert.match(String(resumed?.result.details?.native), /^resuming:/, text(resumed));
	// F5/F6 on revive: the failed native job is not revived while off or frozen.
	assert.match(text(offRevive), /native_refused.*workers\.native_claude_research is off/);
	assert.match(text(frozenRevive), /native_refused.*draining/);
	// F2: the revive resumes the session with picp's revive prompt and the job reports once more (generation 2).
	assert.match(text(revived), /resumed its Claude CLI session/, text(revived));
	const revivedRun = modelCalls(h.claude.requests).find((request) => messages(request).includes(nativeRevivePrompt("research").slice(0, 40)));
	assert.ok(messages(revivedRun).includes("ls -l"), "the revive resumed the same session");
	const stops = readRunEvents(h.b.home, id).filter((event) => event.type === "native_run").map((event) => (event.payload as { stop?: string }).stop);
	assert.deepEqual(stops, [undefined, "max_turns", undefined], "the unreported follow-up ended at its turn limit, never settled");
	const events = readRunEvents(h.b.home, id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 2);
	assert.equal(events.filter((event) => event.type === "native_run").length, 3);
	// M1: the "resuming" ack is not a delivery claim; the resume that threw is journaled by name, and no run was counted.
	const failedSend = ends.find((end) => end.toolName === "cp_send");
	assert.match(String(failedSend?.result.details?.native), /^resuming:/, text(failedSend));
	const failedResume = events.find((event) => event.type === "native_resume_failed")?.payload as { reason?: string } | undefined;
	assert.match(failedResume?.reason ?? "", /holds no session id/);
	// F5 teardown: with the switch off, the job still tears down on an observed exit and its scratch dir goes.
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	const removed = events.concat(readRunEvents(h.b.home, id)).find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.ok(removed?.removed && !existsSync(removed.removed), JSON.stringify(removed));
	assert.equal(readFleet(h.b.home).jobs.find((job) => job.job_id === id)?.phase, "done");
	assert.equal(h.claude.overrun(), 0);
});

test("H2: a resume that throws returns its claimed sends undelivered, and the next admitted turn end delivers them once", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		// The dispatched turn holds its first answer so the send lands mid-turn and queues.
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }], beforeAnswer: () => sleep(6_000) },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the revive." },
	]);
	const id = (await h.job()).id;
	ids.push(id);
	const runDir = join(h.b.home, paths.runDir(id));
	const record = join(runDir, NATIVE_SESSION_FILE);
	const queued = "Queued follow-up: also note the license.";
	// Switched off at turn end, the queued send is refused back into the queue; the idle send's resume then claims it
	// and throws (its record lost the session id). Settling that claim before the turn ran lost the send (N3c H2).
	const first = (await h.b.run([
		h.dispatch(id),
		tool("cp_send", { job_id: id, message: queued }),
		h.off,
		h.wait(id, "agent_settled", 1),
		h.on,
		h.sh(`cp "${record}" "${record}.kept" && sed -i 's/,"session_id":"[^"]*"//' "${record}"`),
		tool("cp_send", { job_id: id, message: "Idle send whose resume throws." }),
		h.wait(id, "process_exit", 1),
	], h.env)) as Tool[];
	const [queuedSend, idleSend] = first.filter((end) => end.toolName === "cp_send");
	assert.equal(queuedSend?.result.details?.receipt, "queued", text(queuedSend));
	assert.match(String(idleSend?.result.details?.native), /^resuming:/, text(idleSend));
	const failed = readRunEvents(h.b.home, id);
	assert.equal(failed.filter((event) => event.type === "native_followup_refused").length, 1);
	assert.match((failed.find((event) => event.type === "native_resume_failed")?.payload as { reason?: string } | undefined)?.reason ?? "", /holds no session id/);
	assert.equal(failed.some((event) => event.type === "native_followup_delivered"), false, "a resume that threw journaled a delivery");
	assert.deepEqual(queuedFollowUps(runDir), [queued], "the claimed send was lost when the resume threw");
	await h.b.closeParents();
	renameSync(`${record}.kept`, record);

	const ends = (await h.b.run([
		tool("cp_revive", { job_id: id, confirm: true }),
		h.wait(id, "agent_settled", 2),
		tool("cp_teardown", { job_id: id }),
	], h.env)) as Tool[];
	const revived = ends.find((end) => end.toolName === "cp_revive");
	assert.match(text(revived), /resumed its Claude CLI session/, text(revived));
	const events = readRunEvents(h.b.home, id);
	assert.deepEqual(events.filter((event) => event.type === "native_followup_delivered").map((event) => (event.payload as { count?: number }).count), [1]);
	assert.deepEqual(queuedFollowUps(runDir), []);
	assert.equal(existsSync(join(runDir, `${NATIVE_FOLLOWUPS_FILE}.claimed`)), false);
	const last = messages(modelCalls(h.claude.requests).at(-1));
	assert.equal(last.split(queued).length - 1, 1, "the queued send reached the model exactly once");
	assert.ok(last.includes(nativeRevivePrompt("research").slice(0, 40)), "the revive turn delivered it");
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 2);
	assert.equal(h.claude.overrun(), 0);
});

test("S2 lock: a spent window refuses a native resume, its queued sends stay queued in order, and none reaches pi", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const reset = Date.now() + 3_600_000;
	const observe = (status: string, observedAt: number) => recordNativeObservation(h.b.home, {
		type: OBSERVATION_EVENT, kind: "window", window: "five_hour", status, observed_at: observedAt, ...(status === "rejected" ? { resets_at: reset } : {}),
	});
	const h = await nativeHome(t, [
		// The dispatched turn holds its first answer: the window is spent meanwhile and two sends queue behind it.
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }], beforeAnswer: async () => { observe("rejected", Date.now()); await sleep(6_000); } },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
		// N4e: an unreported follow-up settles idle and is nudged, so the released follow-up re-reports.
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Noted the released follow-ups." },
	]);
	const id = (await h.job()).id;
	ids.push(id);
	const runDir = join(h.b.home, paths.runDir(id));
	let held: string[] = [];
	const step = (run: () => void) => ({ kind: "tool_calls" as const, calls: [{ name: "bash", args: () => (run(), { command: "true" }) }] });
	const ends = (await h.b.run([
		h.dispatch(id),
		tool("cp_send", { job_id: id, message: "Queued one." }),
		tool("cp_send", { job_id: id, message: "Queued two." }),
		h.wait(id, "native_followup_refused", 1),
		step(() => { held = queuedFollowUps(runDir); }),
		tool("cp_send", { job_id: id, message: "Idle while spent." }),
		tool("cp_revive", { job_id: id, confirm: true }),
		step(() => observe("allowed", Date.now())),
		tool("cp_send", { job_id: id, message: "Released." }),
		h.wait(id, "native_followup_delivered", 1),
		tool("cp_teardown", { job_id: id }),
	], h.env)) as Tool[];
	const [one, two, spent, released] = ends.filter((end) => end.toolName === "cp_send");
	const events = readRunEvents(h.b.home, id);
	for (const send of [one, two]) assert.equal(send?.result.details?.receipt, "queued", text(send));
	assert.match((events.find((event) => event.type === "native_followup_refused")?.payload as { reason?: string } | undefined)?.reason ?? "", /subscription window is spent \(five_hour rejected until /);
	assert.deepEqual(held, ["Queued one.", "Queued two."], "the refused sends left the queue or changed order");
	assert.equal(spent?.isError, true, text(spent));
	assert.match(text(spent), /subscription window is spent/);
	assert.match(text(ends.find((end) => end.toolName === "cp_revive")), /native_refused.*subscription window is spent/);
	// Released: one resume delivers both queued sends in order; the refused idle send never reaches the model or pi.
	assert.match(String(released?.result.details?.native), /^resuming:/, text(released));
	const last = messages(modelCalls(h.claude.requests).at(-1));
	assert.ok(last.indexOf("Queued one.") < last.indexOf("Queued two.") && last.indexOf("Queued one.") >= 0, last);
	assert.equal(last.includes("Idle while spent."), false, "the refused idle send reached the model");
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === id);
	assert.equal(record?.worker.driver, "claude");
	assert.equal(events.filter((event) => event.type === "worker_revived").length, 0);
	// Usage once: two measured runs sum to exactly the model calls made.
	const runs = readRunEvents(h.b.home, id).filter((event) => event.type === "native_run");
	assert.equal(runs.length, 2);
	const calls = modelCalls(h.claude.requests);
	assert.deepEqual(((usage) => [usage.input, usage.output])(readRunStatus(h.b.home, id).usage), [calls.length * 12, calls.length * 7]);
	assert.equal(h.claude.overrun(), 0);
});

test("L1/F11: a native worker killed by a parent restart resumes on a plain cp_revive and reports once; pi cp_revive and cp_send are unchanged", { skip, timeout: 420_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const h = await nativeHome(t, [
		// The dispatched turn never gets its answer: closing the parent kills the worker inside it.
		{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => new Promise<void>(() => {}) },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.native!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids.native!, h.b.home) }] },
		{ kind: "text", text: "Reported after the restart." },
	]);
	ids.native = (await h.job()).id;
	ids.pi = (await h.b.ledger.create({ title: "pi beside native", project: "demo", delivery: "local", kind: "research" })).id;
	const artifact = join(h.b.home, paths.artifactFile(ids.pi));
	const piModel = h.b.provider.addScript("n3d-l1-pi", [
		tool("bash", { command: `mkdir -p "${dirname(artifact)}" && printf '# pi\\n' > "${artifact}"` }),
		tool("report_result", report(ids.pi, h.b.home)),
		{ kind: "text", text: "reported" },
		...Array.from({ length: 4 }, () => ({ kind: "text" as const, text: "pi follow-up noted" })),
	]);
	await h.b.run([
		tool("cp_dispatch", { job_id: ids.pi, task: "Report.", model: piModel, queue: false, when_ready: false }),
		h.wait(ids.pi, "envelope_received", 1),
		h.dispatch(ids.native),
	], h.env);
	await waitFor(() => modelCalls(h.claude.requests).length, (n) => n >= 1, { timeoutMs: 60_000, what: "the native turn's first model call" });
	const sessionFile = join(h.b.home, paths.runDir(ids.native), NATIVE_SESSION_FILE);
	const before = readNativeSession(sessionFile).session_id;
	assert.ok(before, "the native session id was recorded before the restart");
	await h.b.closeParents();

	const ends = (await h.b.run([
		tool("cp_revive", { job_id: ids.native, confirm: true }),
		h.wait(ids.native, "agent_settled", 1),
		tool("cp_revive", { job_id: ids.pi, confirm: true }),
		tool("cp_send", { job_id: ids.pi, message: "Pi follow-up." }),
		tool("cp_teardown", { job_id: ids.native }),
	], h.env)) as Tool[];
	const [nativeRevive, piRevive] = ends.filter((end) => end.toolName === "cp_revive");
	// L1: the plain revive resumed the same session with picp's revive prompt, and the job reported exactly once.
	assert.match(text(nativeRevive), /resumed its Claude CLI session/, text(nativeRevive));
	const revivedRun = modelCalls(h.claude.requests).find((request) => messages(request).includes(nativeRevivePrompt("research").slice(0, 40)));
	assert.ok(messages(revivedRun).includes("Report the repo"), "the revive resumed the killed turn's conversation");
	assert.equal(readNativeSession(sessionFile).session_id, before);
	const events = readRunEvents(h.b.home, ids.native);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 1);
	assert.equal((events.filter((event) => event.type === "native_run").at(-1)?.payload as { resumed?: boolean } | undefined)?.resumed, true);
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	// F11: a pi job beside it still revives idle with no native prompt, and its send is delivered with no native ack.
	assert.notEqual(piRevive?.isError, true, text(piRevive));
	assert.match(text(piRevive), /idle; send it a message to continue/);
	assert.equal(readRunEvents(h.b.home, ids.pi).some((event) => (event.payload as { native_revive?: unknown } | undefined)?.native_revive), false);
	const piSend = ends.find((end) => end.toolName === "cp_send");
	assert.equal(piSend?.result.details?.receipt, "delivered", text(piSend));
	assert.equal(piSend?.result.details?.native, undefined);
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given a native job that crashed unreported, When bounded recovery runs, Then it resumes the session once
// with the revive prompt (recovery_attempted) and reports; And a turn_limit failure is not recovered; And cp_revive
// continue_failed resumes instead of refusing.
test("J7: bounded recovery resumes a crashed native job, a turn limit stays a human's, continue_failed revives", { skip, timeout: 420_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const descendants = (pid: number): number[] => childPids(pid).flatMap((child) => [child, ...descendants(child)]);
	const crash = async () => {
		const sessionFile = join(h.b.home, paths.runDir(ids.crashed!), NATIVE_SESSION_FILE);
		await waitFor(() => existsSync(sessionFile) && readNativeSession(sessionFile).session_id, Boolean, { timeoutMs: 30_000, what: "the session id" });
		const pid = readFleet(h.b.home).jobs.find((job) => job.job_id === ids.crashed)!.worker.pid;
		// The worker dies first so nothing observes its CLI; SIGTERM lets the CLI keep the session it resumes from.
		const children = descendants(pid);
		process.kill(pid, "SIGKILL");
		for (const child of children) process.kill(child, "SIGTERM");
		await new Promise<void>(() => {});
	};
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: crash },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.crashed!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids.crashed!, h.b.home) }] },
		{ kind: "text", text: "Reported after recovery." },
		call("Bash", { command: "ls" }),
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.limited!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids.limited!, h.b.home) }] },
		{ kind: "text", text: "Reported after continue_failed." },
	]);
	ids.crashed = (await h.job()).id;
	ids.limited = (await h.job()).id;
	await h.b.run([h.dispatch(ids.crashed)], h.env);
	const types = (id: string) => readRunEvents(h.b.home, id).map((event) => event.type);
	await waitFor(() => types(ids.crashed!), (seen) => seen.includes("envelope_received") && seen.includes("agent_settled"), { timeoutMs: 180_000, what: "the recovered report" })
		.catch((error: Error) => assert.fail(`${error.message}: ${JSON.stringify(readRunEvents(h.b.home, ids.crashed!).filter((event) => ["failure", "native_run", "worker_revived"].includes(event.type)))}`));
	const crashed = readRunEvents(h.b.home, ids.crashed);
	const attempted = crashed.find((event) => event.type === "recovery_attempted")?.payload as Record<string, unknown> | undefined;
	assert.deepEqual([attempted?.class, attempted?.action, attempted?.native_revive], ["crash", "revive", true], JSON.stringify(attempted));
	assert.equal(crashed.filter((event) => event.type === "worker_revived").length, 1);
	const revivedRun = modelCalls(h.claude.requests).find((request) => messages(request).includes(nativeRevivePrompt("research").slice(0, 40)));
	assert.ok(messages(revivedRun).includes("Report the repo"), "recovery did not resume the crashed session");
	assert.equal(crashed.filter((event) => event.type === "envelope_received").length, 1);

	await h.b.closeParents();
	await h.b.run([h.dispatch(ids.limited)], { ...h.env, CP_NATIVE_MAX_TURNS: "1" });
	await waitFor(() => types(ids.limited!), (seen) => seen.includes("recovery_failed"), { timeoutMs: 120_000, what: "the turn limit's refusal" })
		.catch((error: Error) => assert.fail(`${error.message}: ${types(ids.limited!).join(",")}`));
	const limited = readRunEvents(h.b.home, ids.limited);
	assert.equal(readFleet(h.b.home).jobs.find((job) => job.job_id === ids.limited)?.failure?.class, "turn_limit");
	assert.equal((limited.find((event) => event.type === "recovery_failed")?.payload as { stage?: string } | undefined)?.stage, "native");
	assert.equal(limited.some((event) => event.type === "worker_revived" || event.type === "recovery_attempted"), false);

	await h.b.closeParents();
	const ends = (await h.b.run([
		tool("cp_revive", { job_id: ids.limited, continue_failed: true, confirm: true }),
		h.wait(ids.limited, "envelope_received", 1),
		h.wait(ids.limited, "agent_settled", 1),
		tool("cp_teardown", { job_id: ids.limited }),
		tool("cp_teardown", { job_id: ids.crashed }),
	], h.env)) as Tool[];
	assert.match(text(ends.find((end) => end.toolName === "cp_revive")), /resumed its Claude CLI session/);
	const continued = readRunEvents(h.b.home, ids.limited).find((event) => event.type === "worker_revived")?.payload as Record<string, unknown> | undefined;
	assert.equal(continued?.continue_failed_as_revive, true, JSON.stringify(continued));
	assert.equal(readRunEvents(h.b.home, ids.limited).filter((event) => event.type === "envelope_received").length, 1);
	for (const down of ends.filter((end) => end.toolName === "cp_teardown")) assert.notEqual(down.isError, true, text(down));
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given a failed native job holding a due quota continuation, When the parent's due tick runs, Then it resumes
// the session by the plain native revive (no continue_failed, no recovery continuation) and the nudge reaches it.
// The pi tick's continue_failed revive is pinned in tests/e2e/quota-continuation.test.ts.
test("J7 quota: a native job's due quota continuation revives it plainly and delivers the nudge", { skip, timeout: 420_000 }, async (t) => {
	let id = "";
	const h = await nativeHome(t, [
		call("Bash", { command: "ls" }),
		// The revived turn holds its first answer so the continuation's nudge lands mid-turn and queues.
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }], beforeAnswer: () => sleep(6_000) },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(id, h.b.home) }] },
		{ kind: "text", text: "Reported after the quota reset." },
		{ kind: "text", text: "Continued after the nudge." },
	]);
	id = (await h.job()).id;
	const types = () => readRunEvents(h.b.home, id).map((event) => event.type);
	const until = (what: string, done: (seen: string[]) => boolean) =>
		waitFor(types, done, { timeoutMs: 120_000, what }).catch((error: Error) => assert.fail(`${error.message}: ${types().join(",")}`));
	await h.b.run([h.dispatch(id)], { ...h.env, CP_NATIVE_MAX_TURNS: "1" });
	await until("the turn limit's refusal", (seen) => seen.includes("recovery_failed"));
	await h.b.closeParents();
	// No native adapter claims a reset, so the due intent is seeded as a claim would have written it.
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === id)!;
	const past = Math.floor(Date.now() / 1000) - 60;
	const at = new Date().toISOString();
	const intent: QuotaIntent = {
		continuation_id: `${id}:quota:1`, job_id: id, generation: 1, state: "pending", delivery: "waiting", capability_version: "test",
		signal: { provider: "anthropic", model: record.worker.model, status: 429, category: "usage", scope: "five_hour", resetsAtEpochSeconds: past, resetsAtUtc: new Date(past * 1000).toISOString() },
		observed_at: at, policy: { enabled: true, source: "job", changed_at: at }, worktree: record.worktree, branch: record.branch,
		session_file: record.worker.session_file, worker_pid: record.worker.pid, worker_started_at: record.worker.started_at, attempts: 0,
	};
	writeFileSync(quotaContinuationFile(h.b.home), JSON.stringify({ schema_version: 1, policy: { jobs: { [id]: { enabled: true, changed_at: at, actor: "operator" } } }, eligibility: {}, intents: [intent] }));
	await h.b.run([], h.env);
	await until("the delivered nudge", (seen) => seen.includes("envelope_received") && seen.lastIndexOf("agent_settled") > seen.indexOf("native_followup_delivered") && seen.includes("native_followup_delivered"));
	const stored = JSON.parse(readFileSync(quotaContinuationFile(h.b.home), "utf8")) as { intents: QuotaIntent[] };
	assert.deepEqual([stored.intents[0]?.state, stored.intents[0]?.consumed?.receipt], ["consumed", "queued"], JSON.stringify(stored.intents[0]));
	const revived = readRunEvents(h.b.home, id).filter((event) => event.type === "worker_revived").map((event) => event.payload as Record<string, unknown>);
	assert.equal(revived.length, 1);
	assert.deepEqual([revived[0]?.continuation, revived[0]?.continue_failed_as_revive], ["operator", undefined], JSON.stringify(revived[0]));
	assert.ok(modelCalls(h.claude.requests).some((request) => messages(request).includes(QUOTA_CONTINUE_NUDGE.slice(0, 60))), "the nudge never reached the model");
	await h.b.closeParents();
	const [down] = (await h.b.run([tool("cp_teardown", { job_id: id })], h.env)) as Tool[];
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(h.claude.overrun(), 0);
});

test("N4i moved session: a revive from a changed worktree starts a fresh session led by the brief and logs native_session_moved", { skip, timeout: 420_000 }, async (t) => {
	let id = "";
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => new Promise<void>(() => {}) },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(id, h.b.home) }] },
		{ kind: "text", text: "Reported on a fresh session." },
	]);
	id = (await h.job()).id;
	await h.b.run([h.dispatch(id)], h.env);
	await waitFor(() => modelCalls(h.claude.requests).length, (n) => n >= 1, { timeoutMs: 60_000, what: "the native turn's first model call" });
	await h.b.closeParents();
	// The record says the session started elsewhere: the CLI keys sessions by cwd, so the resume must not run there.
	const sessionFile = join(h.b.home, paths.runDir(id), NATIVE_SESSION_FILE);
	const before = readNativeSession(sessionFile);
	writeFileSync(sessionFile, `${JSON.stringify({ ...before, cwd: "/leases/moved/picp" })}\n`);
	const calls = modelCalls(h.claude.requests).length;
	const ends = (await h.b.run([tool("cp_revive", { job_id: id, confirm: true }), h.wait(id, "envelope_received", 1)], h.env)) as Tool[];
	assert.notEqual(ends.find((end) => end.toolName === "cp_revive")?.isError, true, text(ends[0]));
	const moved = readRunEvents(h.b.home, id).find((event) => event.type === "native_session_moved")?.payload as { from?: string } | undefined;
	assert.equal(moved?.from, "/leases/moved/picp", readFileSync(h.events(id), "utf8").slice(-2000));
	// A fresh session has no prior conversation, so the task text in its first prompt can only come from the brief.
	const first = modelCalls(h.claude.requests).slice(calls).find((request) => Array.isArray(request.body.tools));
	assert.ok(messages(first).includes("Report the repo") && messages(first).includes(nativeRevivePrompt("research").slice(0, 40)), messages(first));
	assert.notEqual(readNativeSession(sessionFile).session_id, before.session_id, "the moved session was resumed");
	assert.equal(readRunEvents(h.b.home, id).filter((event) => event.type === "envelope_received").length, 1);
});

// N3d's one live run: the operator's own claude settings (claude reads them; picp never does). Counts only.
test("native live follow-up smoke: a research dispatch, then one idle cp_send resumes the same session", { skip: !LIVE_TESTS_ENABLED ? "set CP_LIVE_TESTS=1 to run live smokes" : !process.env.CP_LIVE_NATIVE_MODEL ? "set CP_LIVE_NATIVE_MODEL to the account's anthropic/claude-… id" : skip, timeout: 900_000 }, async (t) => {
	const b = await dispatchS29(t);
	writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true }));
	const id = (await b.ledger.create({ title: "native live follow-up smoke", project: "demo", delivery: "local", kind: "research" })).id;
	// S1: a native dispatch names an explicit model; the live account's own id, from the env, routed here.
	const model = process.env.CP_LIVE_NATIVE_MODEL!;
	routeNativeModel(b.home, [model]);
	const events = join(b.home, paths.eventsFile(id));
	const sessionFile = join(b.home, paths.runDir(id), NATIVE_SESSION_FILE);
	const settled = (count: number) => tool("bash", { command: `for i in $(seq 1500); do [ "$(grep -c '"agent_settled"\\|"process_exit"' "${events}" 2>/dev/null)" -ge ${count} ] && break; sleep 0.2; done; sleep 2` });
	let firstSession: string | undefined;
	const ends = (await b.run([
		tool("cp_dispatch", { job_id: id, task: "Report the repo's package name from README.md in one line.", model, queue: false, when_ready: false, driver: "claude" }),
		settled(1),
		tool("bash", () => ((firstSession = readNativeSession(sessionFile).session_id), { command: "true" })),
		tool("cp_send", { job_id: id, message: "Follow-up: confirm the name once more and call report_result again with the same report." }),
		settled(2),
		tool("cp_teardown", { job_id: id }),
	], {}, undefined, 900_000)) as Tool[];
	const log = readRunEvents(b.home, id);
	const runs = log.filter((event) => event.type === "native_run").map((event) => event.payload as Record<string, unknown>);
	const status = readRunStatus(b.home, id);
	const session = readNativeSession(sessionFile);
	const removed = log.find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	const counts = {
		exit_codes: runs.map((run) => run.exit_code), lockdown: runs.map((run) => run.lockdown),
		reports_accepted: log.filter((event) => event.type === "envelope_received").length,
		same_session_resumed: runs[1]?.resumed === true && firstSession !== undefined && session.session_id === firstSession,
		usage_measured: runs.length === 2 && runs.every((run) => run.usage === "measured"),
		counted_once: Math.abs(status.usage.cost_usd - (session.baseline?.cost_usd ?? Number.NaN)) < 1e-9,
		scratch_removed: Boolean(removed?.removed && !existsSync(removed.removed)),
	};
	t.diagnostic(JSON.stringify(counts));
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.deepEqual(counts, { ...counts, exit_codes: [0, 0], lockdown: ["ok", "ok"], reports_accepted: 2, same_session_resumed: true, usage_measured: true, counted_once: true, scratch_removed: true });
});

test("F9: a queued driver:claude dispatch releases native, and an armed one is refused by name, never pi", { skip, timeout: 420_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.queued!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids.queued!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	]);
	writeFileSync(join(h.b.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1 }));
	const pi = (await h.b.ledger.create({ title: "pi slot holder", project: "demo", delivery: "local", kind: "research" })).id;
	ids.queued = (await h.job()).id;
	ids.armed = (await h.job()).id;
	await h.b.ledger.addDep(ids.armed, ids.queued);
	const artifact = join(h.b.home, paths.artifactFile(pi));
	const piModel = h.b.provider.addScript("n3c-pi-slot", [
		tool("bash", { command: `mkdir -p "${dirname(artifact)}" && printf '# pi\\n' > "${artifact}"` }),
		tool("report_result", report(pi, h.b.home)),
		{ kind: "text", text: "reported" },
	]);
	const armedFile = join(h.b.home, LAYOUT.armedDispatchFile);
	const native = (id: string) => tool("cp_dispatch", { job_id: id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, driver: "claude" });
	const ends = (await h.b.run([
		tool("cp_dispatch", { job_id: pi, task: "Report.", model: piModel, queue: false, when_ready: false }),
		h.wait(pi, "envelope_received", 1),
		native(ids.queued),
		native(ids.armed),
		tool("cp_teardown", { job_id: pi }),
		h.wait(ids.queued, "agent_settled", 1),
		h.off,
		tool("cp_teardown", { job_id: ids.queued }),
		h.sh(`for i in $(seq 450); do grep -q '${ids.armed}' "${armedFile}" 2>/dev/null || break; sleep 0.2; done`),
	], h.env, undefined, 300_000)) as Tool[];
	const dispatches = ends.filter((end) => end.toolName === "cp_dispatch");
	const teardowns = ends.filter((end) => end.toolName === "cp_teardown");
	t.diagnostic(JSON.stringify(ends.map((end) => [end.toolName, end.isError, text(end).slice(0, 200)])));
	assert.match(text(dispatches[1]), /queue/i, "the spawn cap queued the native dispatch");
	assert.match(text(dispatches[2]), /armed/i, "the open blocker armed the native dispatch");
	for (const end of teardowns) assert.notEqual(end.isError, true, text(end));
	// The queued request released on the native driver: its run log has a native run, its record keeps the driver.
	assert.equal(readFleet(h.b.home).jobs.find((job) => job.job_id === ids.queued)?.worker.driver, "claude");
	assert.equal(readRunEvents(h.b.home, ids.queued!).filter((event) => event.type === "native_run").length, 1);
	// The armed request released with the switch off: refused by name, nothing spawned, no pi worker.
	assert.equal(readFleet(h.b.home).jobs.some((job) => job.job_id === ids.armed), false);
	assert.equal(existsSync(join(h.b.home, paths.runDir(ids.armed!))), false);
	// The drop wake-up reached the parent session (the outbox keeps only its id once delivered).
	const parent = JSON.stringify(h.b.parents.at(-1)?.records() ?? []);
	assert.match(parent, new RegExp(`ARMED DISPATCH DROPPED: [^"]*workers\\.native_claude_research is off[^"]*${ids.armed}`));
	assert.match(readFileSync(join(h.b.home, LAYOUT.wakeupsFile), "utf8"), new RegExp(`armed-dispatch:dropped:${ids.armed}`));
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given max_concurrent 1 held by a live native job, When an explicit driver claude dispatch arrives,
// Then it is queued (position 1) and starts natively when the holder tears down,
// And a quality voter that loses the slot runs on pi instead of abstaining (main refused, then abstained).
test("J8: a full native slot queues a driver:claude dispatch until teardown, and a voter that lost it votes on pi", { skip, timeout: 420_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const switchFile = join(LAYOUT.data, "native.json");
	const research = (key: string): ClaudeStep[] => [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[key]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[key]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	];
	const verdict = () => ({ job_id: ids.subject, verdict: "pass", reasons: ["checked"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } });
	// Voter 2 must find the slot gone at spawn: the cap drops to 1 while the subject holds one and voter 1 runs.
	const lose = async () => writeFileSync(join(h.b.home, switchFile), JSON.stringify({ claude_research: true, claude_review: true, max_concurrent: 1 }));
	const h = await nativeHome(t, [...research("holder"), ...research("queued"), ...research("subject"),
		{ kind: "tool_use", calls: [{ name: VERDICT_TOOL, input: verdict }], beforeAnswer: lose }, { kind: "text", text: "Reviewed." }]);
	for (const key of ["holder", "queued", "subject"]) ids[key] = (await h.job()).id;
	// No scheduler-tick backstop: only the holder's teardown may start the queued job.
	const noTick = { ...h.env, CP_SCHEDULER_TICK_SECONDS: "3600" };
	const ends = (await h.b.run([
		h.dispatch(ids.holder!),
		h.wait(ids.holder!, "agent_settled", 1),
		tool("cp_dispatch", { job_id: ids.queued, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, when_ready: false, driver: "claude" }),
		tool("cp_teardown", { job_id: ids.holder }),
		h.wait(ids.queued!, "agent_settled", 1),
		tool("cp_teardown", { job_id: ids.queued }),
	], noTick, undefined, 300_000)) as Tool[];
	const queued = ends.filter((end) => end.toolName === "cp_dispatch")[1];
	assert.notEqual(queued?.isError, true, text(queued));
	assert.deepEqual([queued?.result.details?.state, queued?.result.details?.position], ["queued", 1], text(queued));
	for (const end of ends.filter((e) => e.toolName === "cp_teardown")) assert.notEqual(end.isError, true, text(end));
	assert.equal(readFleet(h.b.home).jobs.find((job) => job.job_id === ids.queued)?.worker.driver, "claude");
	assert.equal(readRunEvents(h.b.home, ids.queued!).filter((event) => event.type === "native_run").length, 1);
	assert.match(readFileSync(join(h.b.home, LAYOUT.wakeupsFile), "utf8"), new RegExp(`dispatch-queue:started:${ids.queued}`));
	await h.b.closeParents();

	// A claude voter row with a pi fallback; pi's lane cannot serve the native model, so pi walks to the fallback.
	const piVoter = h.b.provider.addScript("j8-pi-voter", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict }] }]);
	h.b.agent.writeModels(h.b.provider);
	const routing = JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: unknown[] };
	routing.rubric.unshift({ id: "j8-voters", role: "gate-reviewer", model: FAKE_NATIVE_MODEL, fallbacks: [piVoter], driver: "claude" });
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify(routing));
	writeFileSync(join(h.b.home, switchFile), JSON.stringify({ claude_research: true, claude_review: true, max_concurrent: 2 }));
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_NATIVE_MODEL }),
	}));
	await post.dispatch({ jobId: ids.subject!, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, driver: "claude", fetch: false });
	await waitFor(() => readRunEvents(h.b.home, ids.subject!).some((event) => event.type === "agent_settled"), Boolean, { timeoutMs: 120_000, what: "the subject's settled turn" });
	const panel = await post.qualityPass().runAndWait({ jobId: ids.subject!, task: "Report the repo's package name.", config: { verify: true, voters: 2, threshold: 1 } });
	const votes = panel?.verify?.votes ?? [];
	assert.deepEqual(votes.map((vote) => [vote.model, vote.sound, vote.abstained ?? false]), [[FAKE_NATIVE_MODEL, true, false], [piVoter, true, false]], JSON.stringify(votes));
	assert.equal(panel?.passed, true);
	assert.equal(h.claude.overrun(), 0);
});

async function boundsPost(t: TestContext, script: readonly ClaudeStep[], ids: Record<string, string>, spent = true) {
	const h = await nativeHome(t, script);
	const bounds: Failure[] = [];
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		onHardBound: (_jobId, failure) => void bounds.push(failure),
	}));
	ids.job = (await h.job()).id;
	// `spent`: the one recovery attempt is spent up front, so the bound escalates and the job ends there.
	if (spent) for (const cls of ["tool_call_cap_exceeded", "wall_clock_exceeded"] as const) recordRecoveryAttempt(h.b.home, ids.job, cls);
	return { h, post, bounds, model: FAKE_NATIVE_MODEL };
}

async function assertBoundEnds(f: Awaited<ReturnType<typeof boundsPost>>, jobId: string, failureClass: string): Promise<void> {
	const failed = await waitFor(() => f.post.fleet.get(jobId), (record) => record?.phase === "failed", { timeoutMs: 120_000, what: `${failureClass} to fail the native job` });
	await waitFor(() => f.bounds.length, (n) => n === 1, { timeoutMs: 15_000, what: "one bound wake-up" });
	assert.equal(failed?.failure?.class, failureClass);
	assert.equal(f.bounds[0]?.class, failureClass);
	await waitFor(() => readRunEvents(f.h.b.home, jobId).some((event) => event.type === "process_exit"), (seen) => seen, { timeoutMs: 30_000, what: "the observed exit" });
	// Bounded recovery runs on the bound first (and escalates, its attempt spent); teardown waits for it, as for pi.
	let down = await f.post.tearDown(jobId);
	for (let i = 0; i < 60 && down.failure?.code === "job_in_flight"; i++) down = await sleep(1_000).then(() => f.post.tearDown(jobId));
	assert.equal(down.torn_down, true, JSON.stringify(down));
	assert.equal(f.post.fleet.get(jobId)?.worker.driver, "claude", "recovery relaunched the job off the native driver");
	const events = readRunEvents(f.h.b.home, jobId);
	const escalated = events.find((event) => event.type === "recovery_escalated")?.payload as { reason?: string } | undefined;
	assert.match(escalated?.reason ?? "", /recurred after 1 automatic/);
	assert.equal(events.some((event) => event.type === "worker_revived"), false, "a spent bound revived the native job");
	const removed = readRunEvents(f.h.b.home, jobId).find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.ok(removed?.removed && !existsSync(removed.removed), JSON.stringify(removed));
	assert.equal(down.lease_returned, true, "the lease was not returned");
}

test("F10a: a native worker past its tool-call cap ends as a pi worker does", { skip, timeout: 240_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const read = (): ClaudeStep => ({ kind: "tool_use", calls: [{ name: "Read", input: () => ({ file_path: join(readFleet(f.h.b.home).jobs[0]!.worktree, "README.md") }) }] });
	const f = await boundsPost(t, [read(), read(), read(), read(), read()], ids);
	await f.post.dispatch({ jobId: ids.job!, task: "Read the README.", model: f.model, driver: "claude", fetch: false, toolCallCap: 3, wallClockSeconds: 600 });
	await assertBoundEnds(f, ids.job!, "tool_call_cap_exceeded");
});

test("F10b: a native worker past its wall-clock ends as a pi worker does", { skip, timeout: 240_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const f = await boundsPost(t, [{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => sleep(60_000) }], ids);
	await f.post.dispatch({ jobId: ids.job!, task: "Read the README.", model: f.model, driver: "claude", fetch: false, toolCallCap: 900, wallClockSeconds: 15 });
	await assertBoundEnds(f, ids.job!, "wall_clock_exceeded");
});

// Scenario: Given a native worker past its wall-clock, When bounded recovery runs on the bound, Then it resumes the same
// session once with the revive prompt and reports; And a second bound after a follow-up is escalated, never revived.
test("J7 bound: a native wall-clock bound is recovered once by a plain revive, and a second bound is not", { skip, timeout: 300_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const hang = (): ClaudeStep => ({ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => new Promise<void>(() => {}) });
	const f = await boundsPost(t, [
		hang(),
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(f.h.b.home, paths.artifactFile(ids.job!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids.job!, f.h.b.home) }] },
		{ kind: "text", text: "Reported after the bound." },
		hang(),
	], ids, false);
	const id = ids.job!;
	const types = () => readRunEvents(f.h.b.home, id).map((event) => event.type);
	const until = (what: string, done: (seen: string[]) => boolean) =>
		waitFor(types, done, { timeoutMs: 120_000, what }).catch((error: Error) => assert.fail(`${error.message}: ${JSON.stringify(readRunEvents(f.h.b.home, id).filter((event) => event.source === "cp" && event.type !== "native_transcript").map((event) => [event.type, event.payload]))}`));
	await f.post.dispatch({ jobId: id, task: "Read the README.", model: f.model, driver: "claude", fetch: false, toolCallCap: 900, wallClockSeconds: 15 });
	await until("the recovered report", (seen) => seen.includes("envelope_received") && seen.includes("agent_settled"));
	const events = readRunEvents(f.h.b.home, id);
	const attempted = events.find((event) => event.type === "recovery_attempted")?.payload as Record<string, unknown> | undefined;
	assert.deepEqual([attempted?.class, attempted?.action, attempted?.native_revive], ["wall_clock_exceeded", "revive", true], JSON.stringify(attempted));
	const revived = events.filter((event) => event.type === "worker_revived").map((event) => event.payload as { continuation?: string });
	assert.deepEqual(revived.map((payload) => payload.continuation), ["bounded_recovery"]);
	const revivedRun = modelCalls(f.h.claude.requests).find((request) => messages(request).includes(nativeRevivePrompt("research").slice(0, 40)));
	assert.ok(messages(revivedRun).includes("Read the README"), "recovery did not resume the bound session");

	// The follow-up turn hangs past a fresh wall-clock round: the attempt is spent, so recovery escalates.
	await f.post.send({ jobId: id, message: "One more look." });
	await until("the second bound's escalation", (seen) => seen.includes("recovery_escalated"));
	const escalated = readRunEvents(f.h.b.home, id).find((event) => event.type === "recovery_escalated")?.payload as { reason?: string } | undefined;
	assert.match(escalated?.reason ?? "", /wall_clock_exceeded recurred after 1 automatic/);
	assert.equal(types().filter((type) => type === "worker_revived").length, 1, "the second bound was revived again");
	assert.deepEqual(f.bounds.map((bound) => bound.class), ["wall_clock_exceeded", "wall_clock_exceeded"]);
	let down = await f.post.tearDown(id);
	for (let i = 0; i < 60 && down.failure?.code === "job_in_flight"; i++) down = await sleep(1_000).then(() => f.post.tearDown(id));
	assert.equal(down.torn_down, true, JSON.stringify(down));
	assert.equal(f.h.claude.overrun(), 0);
});

// Scenario: Given cp_pipeline start on a claude planner row, When the planner reports and cp_gate returns revise,
// Then the revise resumes the same native session (busy: queued; idle: resuming), a second report is accepted
// And cp_pipeline advance dispatches the implementer natively. Main kept a pipeline's planner on pi (D2).
test("J3 pipeline planner: a native planner takes the gate revise busy or idle, reports again, and the implementer runs native", { skip, timeout: 420_000 }, async (t) => {
	const ids: Record<string, string> = {};
	const body = "# Goal\nAdd a line to README.md.\n\n# File list\n- README.md\n\n# Test plan\nnpm test\n\n# Unknowns/Blockers\nnone\n";
	const known = (key: string) => () => waitFor(() => ids[key], Boolean, { timeoutMs: 60_000, what: `the ${key} research id` }).then(() => undefined);
	const write = (key: string, content: string, beforeAnswer = known(key)): ClaudeStep => ({ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[key]!)), content }) }], beforeAnswer });
	const assessed = { scope: "S", confidence: "high", destructive_scope: false, blocking_unknowns: false };
	const filed = (key: string): ClaudeStep => call(REPORT_TOOL, () => ({ ...report(ids[key]!, h.b.home), self_assessment: assessed }));
	const queued = (key: string) => () => waitFor(() => existsSync(join(h.b.home, paths.runDir(ids[key]!), NATIVE_FOLLOWUPS_FILE)), Boolean, { timeoutMs: 120_000, what: "the queued revise" }).then(() => undefined);
	const planner = (key: string, busy: boolean): ClaudeStep[] => [
		write(key, body), filed(key),
		// Busy: the reporting turn holds its last answer until the gate's revise is queued behind it.
		{ kind: "text", text: `Reported ${key}.`, ...(busy ? { beforeAnswer: queued(key) } : {}) },
		// The gate's verdict time has whole seconds: a rewrite in the same second reads as unchanged.
		write(key, `${body}\n# Revised\nnpm test -- readme\n`, () => sleep(1_100)), filed(key), { kind: "text", text: "Revised." },
		// The implementer's first call never returns; the test tears it down once it is native.
		{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => new Promise<void>(() => {}) },
	];
	const h = await nativeHome(t, [...planner("busy", true), ...planner("idle", false)]);
	const gate: ScriptStep[] = [];
	const reviewer = h.b.provider.addScript("j3-gate", gate);
	const fallback = h.b.provider.addScript("j3-pi", Array.from({ length: 8 }, () => ({ kind: "text" as const, text: "idle" })));
	h.b.agent.writeModels(h.b.provider);
	const routing = JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: unknown[] };
	routing.rubric.unshift(
		{ id: "j3-plan", role: "planner", model: FAKE_NATIVE_MODEL, fallbacks: [fallback], driver: "claude" },
		{ id: "j3-gate", role: "gate-reviewer", model: reviewer },
		{ id: "j3-ship", role: "implementer", model: FAKE_NATIVE_MODEL, fallbacks: [fallback], driver: "claude" },
	);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify(routing));
	writeFileSync(join(h.b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true, claude_ship: true }));
	// A native implementer refuses to start without a commit identity.
	const gitconfig = join(h.env.HOME, "gitconfig");
	writeFileSync(gitconfig, "[user]\n\tname = j3 e2e\n\temail = j3@test.invalid\n");
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env, GIT_CONFIG_GLOBAL: gitconfig },
		authorizer: { ask: async () => ({ approved: true, by: "j3 operator" }) },
	}));
	const settle = async (jobId: string, surface: ReviewSurface, attempt: number) => {
		const key = ReviewRuns.key(jobId, surface, attempt);
		post.reviewRuns.handBack(key);
		await post.reviewRuns.settled(key);
	};
	const offered = () => h.claude.requests.filter((request) => request.path.split("?")[0] === "/v1/messages" && Array.isArray(request.body.tools) && request.body.tools.length > 0).length;
	const flags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
	for (const [key, busy] of [["busy", true], ["idle", false]] as const) {
		const started = await post.startPipeline({ title: `j3 ${key}`, project: "demo", task: "Add a line to README.md.", delivery: "local", fetch: false });
		const id = started.research_id;
		ids[key] = id;
		assert.equal(post.fleet.get(id)?.worker.driver, "claude", `${key}: ${post.fleet.get(id)?.routing?.driver_reason}`);
		const types = () => readRunEvents(h.b.home, id).map((event) => event.type);
		const count = (type: string) => types().filter((each) => each === type).length;
		const until = (what: string, done: (seen: string[]) => boolean) =>
			waitFor(types, done, { timeoutMs: 120_000, what: `${key}: ${what}` }).catch((error: Error) => assert.fail(`${error.message}: ${types().join(",")}`));
		await until("the first report", (seen) => seen.includes("envelope_received") && (busy || seen.lastIndexOf("agent_settled") > seen.indexOf("envelope_received")));
		gate.push(tool("report_verdict", { job_id: id, verdict: "revise", revisions: ["name the exact test command"], flags, reasons: ["vague"] }), tool("report_verdict", { job_id: id, verdict: "pass", flags, reasons: ["concrete"] }));
		const gating = await post.advancePipeline(id);
		assert.equal(gating.pending?.surface, "gate", gating.message);
		await settle(id, "gate", gating.pending!.attempt);
		await until("the revised report", (seen) => seen.filter((type) => type === "envelope_received").length === 2 && seen.lastIndexOf("agent_settled") > seen.lastIndexOf("envelope_received"));

		// The revise reopened generation 1's slot and reached the planner's own session: queued busy, resuming idle.
		const revise = readRunEvents(h.b.home, id).find((event) => (event.payload as { superseded_generation?: number } | undefined)?.superseded_generation === 1);
		const sent = revise?.payload as { receipt?: string; disposition?: string } | undefined;
		assert.deepEqual([revise?.type, sent?.receipt], busy ? ["follow_up_sent", "queued"] : ["prompt_sent", "delivered"], JSON.stringify(revise));
		if (!busy) assert.equal(sent?.disposition, "resuming");
		assert.equal(count("native_followup_delivered"), busy ? 1 : 0);
		const runs = readRunEvents(h.b.home, id).filter((event) => event.type === "native_run").map((event) => (event.payload as { resumed?: boolean }).resumed);
		assert.deepEqual(runs, [false, true], `${key}: the revise did not resume the planner's session`);
		const revisedCall = modelCalls(h.claude.requests).find((request) => messages(request).includes(`Gate review of your artifact for ${id} `));
		assert.ok(messages(revisedCall).includes(`Reported ${key}.`), `${key}: the revise turn lost the reporting turn`);
		assert.deepEqual([count("envelope_received"), count("envelope_superseded")], [2, 1]);

		// Re-gate passes; advance authorizes and dispatches the implementer on the native driver.
		let result = await post.advancePipeline(id);
		for (let guard = 0; result.pending && guard < 10; guard += 1) {
			await settle(result.pending.surface === "review" ? result.ship_id : id, result.pending.surface, result.pending.attempt);
			result = await post.advancePipeline(id);
		}
		assert.equal(result.state, "implementing", result.message);
		const ship = post.fleet.get(started.ship_id);
		assert.deepEqual([ship?.worker.driver, ship?.routing?.driver], ["claude", "claude"], ship?.routing?.driver_reason);
		await waitFor(offered, (n) => n >= (busy ? 7 : 14), { timeoutMs: 60_000, what: `${key}: the native implementer's first model call` });
		let down = await post.tearDown(started.ship_id, { force: true });
		for (let i = 0; i < 60 && down.failure?.code === "job_in_flight"; i++) down = await sleep(1_000).then(() => post.tearDown(started.ship_id, { force: true }));
		assert.equal(down.torn_down, true, JSON.stringify(down));
	}
	assert.equal(h.claude.overrun(), 0);
});
