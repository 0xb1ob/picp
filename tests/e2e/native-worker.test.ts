/**
 * N3b: research jobs on the native Claude driver through the real `cp_dispatch` of a pi parent (mock parent model),
 * the installed `claude` against the loopback fake model, synthetic credentials in a temp HOME's settings file, a temp
 * CLAUDE_CONFIG_DIR per run and no user setting sources. P3a–P3j of the N3b task.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_BUDGET_CONFIG, EMPTY_USAGE, LAYOUT, paths } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { checkBudget } from "../../src/failures.ts";
import { jobsView } from "../../src/viewer/jobs-view.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { LIVE_TESTS_ENABLED, readFleet, readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const missing = [whichAll("claude", process.env)[0] === undefined && "claude", !treehouseAvailable() && "treehouse"].filter(Boolean);
const skip = missing.length > 0 ? `needs ${missing.join(" and ")} on PATH` : false;
type Tool = { toolName: string; isError?: boolean; durationMs?: number; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
const step = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
const report = (jobId: string, home: string) => ({
	job_id: jobId, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(jobId)),
	plan_summary: { goal: "Name the package.", approach: ["Read README.md."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] },
});

/** A fake HOME whose Claude settings file points the native worker at the fake model; the switch file is the test's. */
async function nativeHome(t: TestContext, script: readonly ClaudeStep[], usage = true) {
	const b = await dispatchS29(t, { files: { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/picp-n3b-hook-ran" }] }] } }), ".claude/commands/extra.md": "extra\n" } });
	const claude = await startClaudeMockProvider(script, { usage });
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-n3b-home-"));
	t.after(async () => { await claude.close(); rmSync(fakeHome, { recursive: true, force: true }); });
	const settings = join(fakeHome, ".claude", "settings.json");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	const toggle = (on: boolean) => writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: on }));
	const job = (kind: "research" | "ship" = "research") => b.ledger.create({ title: `native ${kind} ${Math.random()}`, project: "demo", delivery: "local", kind });
	const envelope = (id: string) => join(b.home, paths.envelopeFile(id));
	const waitFile = (file: string) => `for i in $(seq 300); do [ -f "${file}" ] && break; sleep 0.2; done; sleep 2`;
	return { b, claude, settings, toggle, job, envelope, waitFile, env: { HOME: fakeHome } };
}

test("P3a/c/d/e/h/i/j: a native research job reports once, refuses follow-ups and peers, and tears down on its observed exit", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		step("Bash", { command: "echo x > native-write.txt" }),
		{ kind: "tool_use", calls: [{ name: "Read", input: () => ({ file_path: h.settings }) }] },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report("cp-someone-else", h.b.home) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	]);
	h.toggle(true);
	const [native, peer, ship, pi] = await Promise.all([h.job(), h.job(), h.job("ship"), h.job()]);
	ids.push(native.id);
	const worker = h.b.provider.addScript("n3b-pi-worker", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `mkdir -p "$(dirname "$CP_ARTIFACT_PATH")" && echo '# pi' > "$CP_ARTIFACT_PATH"` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => report(pi.id, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	]);
	const model = worker;
	const dispatch = (id: string, driver = true) => ({ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", model, queue: false, when_ready: false, ...(driver ? { driver: "claude" } : {}) } });
	const bash = (command: string) => ({ name: "bash", args: { command } });
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [dispatch(native.id)] },
		{ kind: "tool_calls", calls: [dispatch(peer.id)] },
		{ kind: "tool_calls", calls: [dispatch(ship.id)] },
		{ kind: "tool_calls", calls: [bash(h.waitFile(h.envelope(native.id)))] },
		{ kind: "tool_calls", calls: [{ name: "cp_send", args: { job_id: native.id, message: "One more thing." } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_revive", args: { job_id: native.id } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: native.id } }] },
		{ kind: "tool_calls", calls: [dispatch(pi.id, false)] },
		{ kind: "tool_calls", calls: [bash(h.waitFile(h.envelope(pi.id)))] },
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: pi.id } }] },
	], h.env)) as Tool[];
	const named = (name: string) => ends.filter((end) => end.toolName === name);
	const [first, second, third, fourth] = named("cp_dispatch");
	const [nativeDown, piDown] = named("cp_teardown");
	t.diagnostic(`measured ms: dispatch-to-accepted native ${first?.durationMs} pi ${fourth?.durationMs}; teardown native ${nativeDown?.durationMs} pi ${piDown?.durationMs}`);

	// P3a: dispatched native, reported once through intake, torn down on an observed exit with the lease back.
	assert.notEqual(first?.isError, true, text(first));
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === native.id);
	// G1/R1 inside the native run (checked first so a missing guard is named): the write and the settings read are refused.
	const results = toolResults(h.claude.requests);
	assert.match(results[0] ?? "", /^\[error\]/, `Bash write: ${results[0]}`);
	assert.match(results[1] ?? "", /^\[error\]/, `settings read: ${results[1]}`);
	assert.equal(existsSync(join(record!.worktree, "native-write.txt")), false, "Bash wrote the worktree");
	assert.equal(h.claude.requests.some((request) => JSON.stringify(request.body).includes(FAKE_CLAUDE_AUTH_TOKEN)), false, "no secret reached the model");
	assert.equal(record?.worker.driver, "claude");
	assert.equal(record?.phase, "done");
	assert.ok(record?.worker.exited_at, "teardown observed the native worker's exit");
	assert.notEqual(nativeDown?.isError, true, text(nativeDown));
	assert.equal(nativeDown?.result.details?.lease_returned, true, text(nativeDown));
	const events = readRunEvents(h.b.home, native.id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 1, "exactly one accepted report");
	const run = events.find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	assert.equal(run?.lockdown, "ok", "the lockdown ran and passed");
	assert.equal(existsSync("/tmp/picp-n3b-hook-ran"), false, "no project hook ran");
	// P3i: the wrong-job report was refused; the filed envelope is this job's.
	assert.match(toolResults(h.claude.requests).join("\n"), /job_id/);
	assert.equal((JSON.parse(readFileSync(h.envelope(native.id), "utf8")) as { envelope: { job_id: string } }).envelope.job_id, native.id);
	// P3c, P3d: a second native job and a ship role are refused before any spawn.
	assert.match(text(second), /concurrency is 1/);
	assert.match(text(third), /only research jobs/);
	for (const id of [peer.id, ship.id]) assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	// P3e: follow-ups are refused by name; nothing was queued.
	assert.match(text(named("cp_send")[0]), /native follow-ups land in N3c/);
	assert.match(text(named("cp_revive")[0]), /native follow-ups land in N3c/);
	assert.equal(events.some((event) => event.type === "prompt_sent" && (event.payload as { receipt?: string }).receipt === "queued"), false);
	// P3h: usage is measured, never zero, and the budget check reads it.
	const status = readRunStatus(h.b.home, native.id);
	assert.equal(status.usage_unavailable, undefined);
	assert.ok(status.usage.total_tokens > 0, JSON.stringify(status.usage));
	assert.deepEqual(record?.usage, status.usage, "the fleet carries the measured usage");
	const budget = checkBudget(status.usage, { tokens: 1, cost_usd: 1_000 }, DEFAULT_BUDGET_CONFIG);
	assert.equal(budget.state, "exceeded", "the per-job budget check sees the native usage");
	assert.equal(budget.tokens.used, status.usage.total_tokens - status.usage.cache_read);
	// P3j: a pi research job in the same home is unchanged.
	assert.notEqual(fourth?.isError, true, text(fourth));
	const piRecord = readFleet(h.b.home).jobs.find((job) => job.job_id === pi.id);
	assert.equal(piRecord?.worker.driver, undefined);
	assert.equal(piRecord?.phase, "done");
	assert.equal(h.claude.overrun(), 0);
});

test("P3b/f/g: switch off and a drain freeze refuse before any spawn; a native run without a report fails on its observed exit", { skip, timeout: 300_000 }, async (t) => {
	const h = await nativeHome(t, [{ kind: "text", text: "No report from me." }]);
	const [off, frozen, crash] = await Promise.all([h.job(), h.job(), h.job()]);
	const model = h.b.provider.addScript("n3b-unused", [{ kind: "text", text: "unused" }]);
	const dispatch = (id: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", model, queue: false, when_ready: false, driver: "claude" } }] });
	const drain = join(h.b.home, LAYOUT.state, "drain.json");
	const now = new Date().toISOString();
	const freeze = JSON.stringify({ state: "drained", started_at: now, deadline: now, timeout_s: 0, jobs: [], cause: { reason: "freeze" } });
	const ends = (await h.b.run([
		dispatch(off.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `echo '{"claude_research":true}' > "${join(h.b.home, LAYOUT.data, "native.json")}" && echo '${freeze}' > "${drain}"` } }] },
		dispatch(frozen.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `rm "${drain}"` } }] },
		dispatch(crash.id),
	], h.env)) as Tool[];
	const [first, second, third] = ends.filter((end) => end.toolName === "cp_dispatch");
	// P3b: off by default; refused with no child, no request to the model.
	assert.match(text(first), /workers\.native_claude_research is off/);
	assert.match(text(second), /draining/);
	for (const id of [off.id, frozen.id]) assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	// P3g: the run ended without a report; the job fails on the worker's observed exit, never a guessed completion.
	assert.notEqual(third?.isError, true, text(third));
	const record = await waitFor(() => readFleet(h.b.home).jobs.find((job) => job.job_id === crash.id), (job) => job?.phase === "failed", { timeoutMs: 120_000, what: "failed native job" });
	assert.equal(record?.failure?.class, "crash");
	const status = readRunStatus(h.b.home, crash.id);
	assert.deepEqual([status.phase, status.exit_code], ["exited", 1], "the observed exit");
	const run = readRunEvents(h.b.home, crash.id).find((event) => event.type === "native_run")?.payload as { report?: boolean } | undefined;
	assert.equal(run?.report, false);
	assert.equal(existsSync(h.envelope(crash.id)), false);
	assert.equal(h.claude.requests.filter((request) => request.path.startsWith("/v1/messages") && Array.isArray(request.body.tools)).length, 1, "only the crash run reached the model");
});

// F1: the fake model reports no usage, so the run's cost and tokens are unknown; recorded as unavailable, never a zero.
test("P3h-unavailable: a native run whose usage the model omits is flagged unavailable, never a measured zero", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	], false);
	h.toggle(true);
	const native = await h.job();
	ids.push(native.id);
	const model = h.b.provider.addScript("n3b-unmeasured", [{ kind: "text", text: "unused" }]);
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: native.id, task: "Report the repo's package name.", model, queue: false, when_ready: false, driver: "claude" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(native.id)) } }] },
	], h.env)) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const run = readRunEvents(h.b.home, native.id).find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	t.diagnostic(JSON.stringify({ report: run?.report, usage: run?.usage }));
	const status = readRunStatus(h.b.home, native.id);
	assert.equal(status.usage_unavailable, true, `usage ${run?.usage} was recorded as measured: ${JSON.stringify(status.usage)}`);
	assert.equal(readRunEvents(h.b.home, native.id).some((event) => event.type === "message_end"), false, "no measured usage was written");
	assert.deepEqual(status.usage, EMPTY_USAGE, "run usage stays unwritten");
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === native.id);
	assert.ok(record?.usage === undefined || isDeepStrictEqual(record.usage, EMPTY_USAGE), `fleet usage: ${JSON.stringify(record?.usage)}`);
	const flight = jobsView({ home: h.b.home, stateDir: join(h.b.home, LAYOUT.state) }).jobs.find((job) => job.id === native.id);
	assert.equal(flight?.usage_unavailable, true, "the dashboard job says unavailable");
});

// The single live run of N3b: the operator's own claude settings (claude reads them; picp never does). Counts only.
test("native live smoke: one research job through cp_dispatch on the installed claude", { skip: LIVE_TESTS_ENABLED ? skip : "set CP_LIVE_TESTS=1 to run live smokes", timeout: 300_000 }, async (t) => {
	const b = await dispatchS29(t);
	writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true }));
	const job = await b.ledger.create({ title: "native live smoke", project: "demo", delivery: "local", kind: "research" });
	const model = b.provider.addScript("n3b-live-unused", [{ kind: "text", text: "unused" }]);
	const envelope = join(b.home, paths.envelopeFile(job.id));
	const status = join(b.home, paths.runDir(job.id), "status.json");
	const wait = `for i in $(seq 900); do [ -f "${envelope}" ] && break; grep -q '"exited"' "${status}" 2>/dev/null && break; sleep 0.2; done; sleep 2`;
	const ends = (await b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name from package.json in one line.", model, queue: false, when_ready: false, driver: "claude" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: wait } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id } }] },
	])) as Tool[];
	const run = readRunEvents(b.home, job.id).find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	const usage = readRunStatus(b.home, job.id);
	t.diagnostic(JSON.stringify({ exit: run?.exit_code, lockdown: run?.lockdown, report: run?.report, usage_measured: usage.usage_unavailable !== true && usage.usage.total_tokens > 0, seen: run?.seen, extra: run?.extra }));
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.equal(run?.lockdown, "ok");
	assert.equal(run?.report, true);
});
