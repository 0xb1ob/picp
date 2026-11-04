/**
 * N3c: follow-ups into native Claude research jobs through the real `cp_send`, `cp_revive` and `cp_teardown` of a pi
 * parent (mock parent model), the installed `claude` against the loopback fake model, synthetic credentials in a temp
 * HOME's settings file, a temp CLAUDE_CONFIG_DIR per job and no user setting sources. F1–F8 of the N3c task.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { NATIVE_REVIVE_PROMPT, NATIVE_SESSION_FILE, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, type RecordedClaudeRequest, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { readFleet, readRunEvents, readRunStatus, treehouseAvailable } from "../harness/index.ts";

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
		dispatch: (id: string, model: string) => tool("cp_dispatch", { job_id: id, task: "Report the repo's package name.", model, queue: false, when_ready: false, driver: "claude" }),
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
	const model = h.b.provider.addScript("n3c-unused", [{ kind: "text", text: "unused" }]);
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
		h.dispatch(id, model),
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

	// F1: idle sends resume the same session (the earlier turns are in the conversation) and the replies land.
	for (const send of [first, second]) {
		assert.notEqual(send?.isError, true, text(send));
		assert.equal(send?.result.details?.receipt, "delivered", text(send));
		assert.match(String(send?.result.details?.native), /^resumed:/);
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
	assert.equal(h.claude.overrun(), 0);
});

test("F2/F5/F6/F7: switch-off and freeze refuse resume and revive, continue_failed is refused, revive resumes once", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
		{ kind: "text", text: "I will not report this time." },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the revive." },
	]);
	const native = await h.job();
	ids.push(native.id);
	const id = native.id;
	const model = h.b.provider.addScript("n3c-unused-2", [{ kind: "text", text: "unused" }]);
	const fleet = join(h.b.home, LAYOUT.fleetFile);
	// Two parent runs keep each under the harness's 90 s settle bound; the no-report turn ends the worker failed.
	const first = (await h.b.run([
		h.dispatch(id, model),
		h.wait(id, "agent_settled", 1),
		h.off,
		tool("cp_send", { job_id: id, message: "Switched off." }),
		h.frozen,
		tool("cp_send", { job_id: id, message: "Frozen." }),
		h.thawed,
		tool("cp_send", { job_id: id, message: "Follow-up without a report." }),
		h.wait(id, "process_exit", 1),
	], h.env)) as Tool[];
	await h.b.closeParents();
	const ends = (await h.b.run([
		tool("cp_revive", { job_id: id, continue_failed: true, confirm: true }),
		h.off,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.frozen,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.thawed,
		tool("cp_revive", { job_id: id, confirm: true }),
		h.wait(id, "agent_settled", 2),
		h.off,
		tool("cp_teardown", { job_id: id }),
	], h.env)) as Tool[];
	const [offSend, frozenSend, resumed] = first.filter((end) => end.toolName === "cp_send");
	const [continued, offRevive, frozenRevive, revived] = ends.filter((end) => end.toolName === "cp_revive");
	const runsBefore = (pattern: RegExp) => modelCalls(h.claude.requests).filter((request) => pattern.test(messages(request))).length;

	// F5/F6 on resume: refused by name before any process starts; the refused messages never reached the model.
	assert.equal(offSend?.isError, true, text(offSend));
	assert.match(text(offSend), /workers\.native_claude_research is off/);
	assert.equal(frozenSend?.isError, true, text(frozenSend));
	assert.match(text(frozenSend), /draining/);
	assert.equal(runsBefore(/Switched off\.|Frozen\./), 0);
	assert.match(String(resumed?.result.details?.native), /^resumed:/, text(resumed));
	// F7, then F5/F6 on revive: the failed native job is not continued, not revived while off or frozen.
	assert.match(text(continued), /continue_failed is refused/);
	assert.match(text(offRevive), /native_refused.*workers\.native_claude_research is off/);
	assert.match(text(frozenRevive), /native_refused.*draining/);
	// F2: the revive resumes the session with picp's revive prompt and the job reports once more (generation 2).
	assert.match(text(revived), /resumed its native Claude session/, text(revived));
	const revivedRun = modelCalls(h.claude.requests).find((request) => messages(request).includes(NATIVE_REVIVE_PROMPT.slice(0, 40)));
	assert.ok(messages(revivedRun).includes("I will not report this time."), "the revive resumed the same session");
	const events = readRunEvents(h.b.home, id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 2);
	assert.equal(events.filter((event) => event.type === "native_run").length, 3);
	// F5 teardown: with the switch off, the job still tears down on an observed exit and its scratch dir goes.
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	const removed = events.concat(readRunEvents(h.b.home, id)).find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.ok(removed?.removed && !existsSync(removed.removed), JSON.stringify(removed));
	assert.equal(readFleet(h.b.home).jobs.find((job) => job.job_id === id)?.phase, "done");
	assert.equal(h.claude.overrun(), 0);
});
