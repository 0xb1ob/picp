/**
 * N3b: research jobs on the native Claude driver through the real `cp_dispatch` of a pi parent (mock parent model),
 * the installed `claude` against the loopback fake model, synthetic credentials in a temp HOME's settings file, a temp
 * CLAUDE_CONFIG_DIR per run and no user setting sources. P3a–P3j of the N3b task.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { localChecks } from "../../extensions/worker-reporter/index.ts";
import { DEFAULT_BUDGET_CONFIG, EMPTY_USAGE, type Envelope, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { NATIVE_SESSION_FILE, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { nativeAvailabilityFile, readNativeAvailability } from "../../src/native-availability.ts";
import { NATIVE_REPORTED_GRACE_MS, NATIVE_RESULT_GRACE_MS } from "../../src/drivers/claude-usage.ts";
import { checkBudget } from "../../src/failures.ts";
import { updatePending } from "../../src/update-hold.ts";
import type { JobTranscriptResponse } from "../../src/viewer/api-types.ts";
import { jobsView } from "../../src/viewer/jobs-view.ts";
import { startViewer } from "../harness/dashboard.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, FAKE_NATIVE_MODEL, routeNativeModel, startClaudeMockProvider, subscriberEnv, toolResults } from "../harness/claude-mock-provider.ts";
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

/** A fake HOME whose Claude settings file points the native worker at the fake model; the switch file is the test's.
 * `settings` adds keys to that file; `subscriber` uses OAuth, the only path where the CLI reads rate-limit headers. */
async function nativeHome(t: TestContext, script: readonly ClaudeStep[], usage = true, settings: Record<string, unknown> = {}, subscriber = false) {
	const big = Array.from({ length: 1800 }, (_, i) => `line ${String(i).padStart(4, "0")} of the over-cap file, padded past the cap\n`).join("");
	const b = await dispatchS29(t, { files: { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/picp-n3b-hook-ran" }] }] } }), ".claude/commands/extra.md": "extra\n", "big.txt": big } });
	const claude = await startClaudeMockProvider(script, { usage });
	routeNativeModel(b.home);
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-n3b-home-"));
	t.after(async () => { await claude.close(); rmSync(fakeHome, { recursive: true, force: true }); });
	const settingsFile = join(fakeHome, ".claude", "settings.json");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	const env = subscriber ? subscriberEnv(claude.url) : { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN };
	writeFileSync(settingsFile, JSON.stringify({ env, ...settings }));
	const toggle = (on: boolean) => writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: on }));
	const job = (kind: "research" | "ship" = "research") => b.ledger.create({ title: `native ${kind} ${Math.random()}`, project: "demo", delivery: "local", kind });
	const envelope = (id: string) => join(b.home, paths.envelopeFile(id));
	const waitFile = (file: string) => `for i in $(seq 300); do [ -f "${file}" ] && break; sleep 0.2; done; sleep 2`;
	return { b, claude, settings: settingsFile, toggle, job, envelope, waitFile, env: { HOME: fakeHome } };
}

// P3e (follow-ups refused) moved to native-worker-followups.test.ts, where N3c resumes them instead.
test("P3a/c/d/h/i/j: a native research job reports once, refuses peers and ship roles, and tears down on its observed exit", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		step("Bash", { command: "echo x > native-write.txt" }),
		{ kind: "tool_use", calls: [{ name: "Read", input: () => ({ file_path: h.settings }) }] },
		{ kind: "tool_use", calls: [{ name: "Read", input: () => ({ file_path: join(readFleet(h.b.home).jobs.find((job) => job.job_id === ids[0])!.worktree, "big.txt") }) }] },
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
	const dispatch = (id: string, driver = true) => ({ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", model: driver ? FAKE_NATIVE_MODEL : model, queue: false, when_ready: false, ...(driver ? { driver: "claude" } : {}) } });
	const bash = (command: string) => ({ name: "bash", args: { command } });
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [dispatch(native.id)] },
		{ kind: "tool_calls", calls: [dispatch(peer.id)] },
		{ kind: "tool_calls", calls: [dispatch(ship.id)] },
		{ kind: "tool_calls", calls: [bash(h.waitFile(h.envelope(native.id)))] },
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
	assert.deepEqual([run?.max_turns, run?.stop], [500, undefined], "an unset CP_NATIVE_MAX_TURNS runs with the 500 default");
	assert.equal(existsSync("/tmp/picp-n3b-hook-ran"), false, "no project hook ran");
	// P3i: the wrong-job report was refused; the filed envelope is this job's.
	assert.match(toolResults(h.claude.requests).join("\n"), /job_id/);
	assert.equal((JSON.parse(readFileSync(h.envelope(native.id), "utf8")) as { envelope: { job_id: string } }).envelope.job_id, native.id);
	// P3c, P3d: a second native job and a ship role are refused before any spawn.
	assert.match(text(second), /concurrency is 1/);
	assert.match(text(third), /the switch workers\.native_claude_ship is off/);
	for (const id of [peer.id, ship.id]) assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
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

	// The Log: the transcript outlives teardown (the scratch dir does not) and the job's transcript route serves it.
	const transcript = status.transcript_file;
	assert.equal(transcript, join(h.b.home, LAYOUT.sessions, "native", `${native.id}.jsonl`));
	assert.equal(statSync(transcript!).mode & 0o777, 0o600);
	const removed = events.find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.ok(removed?.removed && !existsSync(removed.removed), "the scratch dir survived teardown");
	const raw = readFileSync(transcript!, "utf8");
	assert.doesNotMatch(raw, /signature|"subtype"|"type":"system"|apiKeySource|claude_code_version/, "no signature or system/init content");
	assert.equal(raw.includes(FAKE_CLAUDE_AUTH_TOKEN), false);
	const viewer = await startViewer(t, { home: h.b.home });
	const served = (await viewer.get(`/api/job/${native.id}/transcript`)).body as unknown as JobTranscriptResponse;
	assert.equal(served.warning, null);
	const entries = served.entries;
	assert.ok(entries.some((e) => e.kind === "say" && e.who === "Parent" && e.text.includes("Report the repo's package name.")), "the brief");
	assert.ok(entries.some((e) => e.kind === "say" && e.who === "Worker" && e.text === "Reported."), "assistant text");
	const shell = entries.find((e) => e.name === "Bash");
	assert.match(shell?.text ?? "", /echo x > native-write\.txt[\s\S]*\n\nResult\n\S/, "the Bash call and its result");
	assert.ok(entries.some((e) => e.name === "report_result" && e.text.includes(native.id) && e.text.includes("\n\nResult\n")), "the report call");
	const over = entries.find((e) => e.name === "Read" && e.text.includes("big.txt"));
	assert.match(over?.text ?? "", /\n\[picp: truncated \d+ bytes over the 64 KiB block cap\]$/, "an over-cap result is cut with the marker");
});

// N4b: a native worker never saw its role contract; the profile body and the native addendum now reach the model.
test("N4b: a native research dispatch sends the planner profile and the native addendum as the system prompt, and reports", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	]);
	h.toggle(true);
	const native = await h.job();
	ids.push(native.id);
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: native.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(native.id)) } }] },
	], h.env)) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const first = h.claude.requests.find((request) => request.path.startsWith("/v1/messages") && Array.isArray(request.body.tools));
	const system = JSON.stringify(first?.body.system ?? "");
	assert.match(system, /A plan is executable or it is not a plan\./, "a line of profiles/planner.md");
	assert.match(system, /Write the research artifact with the Write tool/, "the native addendum");
	const file = join(h.b.home, paths.runDir(native.id), "native-system-prompt.md");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(readRunEvents(h.b.home, native.id).filter((event) => event.type === "envelope_received").length, 1, "the run still reports");
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: Given a research delivery:board job on a claude row
//   When it is dispatched, and later killed and cp_revive'd
//   Then both runs write board.json and site/index.html, the report is accepted, and the board is published once
test("J2 board: a native board job writes its board, survives a kill through cp_revive, and publishes once", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const dir = () => join(h.b.home, paths.artifactDir(ids[0]!));
	const board = (run: number) => JSON.stringify({ title: `Board run ${run}`, description: "Native board.", job_ids: [ids[0]], created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
	const write = (file: string, content: () => string): ClaudeStep => ({ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(dir(), file), content: content() }) }] });
	const calls = () => h.claude.requests.filter((request) => request.path.split("?")[0] === "/v1/messages").length;
	const h = await nativeHome(t, [
		write("board.json", () => board(1)),
		write("site/index.html", () => "<p>run 1</p>\n"),
		// The dispatched turn never gets this answer: closing the parent kills the worker inside it.
		{ kind: "tool_use", calls: [{ name: "Read", input: { file_path: "/nonexistent" } }], beforeAnswer: () => new Promise<void>(() => {}) },
		{ kind: "tool_use", calls: ["board.json", "site/index.html"].map((file) => ({ name: "Read", input: () => ({ file_path: join(dir(), file) }) })) },
		write("board.json", () => board(2)),
		write("site/index.html", () => "<p>run 2</p>\n"),
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ ...report(ids[0]!, h.b.home), artifact_path: join(dir(), "board.json") }) }] },
		{ kind: "text", text: "Reported." },
	]);
	h.toggle(true);
	const job = await h.b.ledger.create({ title: `native board ${Math.random()}`, project: "demo", delivery: "board", kind: "research" });
	ids.push(job.id);
	const dispatched = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Publish a board of the repo.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
	], h.env)) as Tool[];
	assert.notEqual(dispatched[0]?.isError, true, text(dispatched[0]));
	await waitFor(calls, (n) => n >= 3, { timeoutMs: 120_000, what: "the first run's writes" });
	assert.equal(readFileSync(join(dir(), "site/index.html"), "utf8"), "<p>run 1</p>\n");
	assert.match(readFileSync(join(dir(), "board.json"), "utf8"), /Board run 1/);
	const system = readFileSync(join(h.b.home, paths.runDir(job.id), "native-system-prompt.md"), "utf8");
	assert.match(system, /This job is delivery board/, "the board addendum");
	await h.b.closeParents();
	const revived = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_revive", args: { job_id: job.id, confirm: true } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(job.id)) } }] },
	], h.env)) as Tool[];
	assert.match(text(revived.find((end) => end.toolName === "cp_revive")), /resumed its native Claude session/);
	const events = readRunEvents(h.b.home, job.id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 1, JSON.stringify(events.filter((event) => event.type === "envelope_rejected")));
	const record = readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id);
	assert.equal(record?.receipts?.filter((receipt) => receipt.kind === "board").length, 1, JSON.stringify(record?.receipts));
	const published = join(h.b.home, LAYOUT.state, "boards", job.id);
	assert.equal(readFileSync(join(published, "site/index.html"), "utf8"), "<p>run 2</p>\n");
	assert.match(readFileSync(join(published, "board.json"), "utf8"), /Board run 2/);
	assert.equal(h.claude.overrun(), 0);
});

// N4f Acceptance 2: a `small-ship` row with driver claude ships an implementer natively when claude_ship is on (commit,
// git_push, pr_create on a non-main base, head_sha report); with the switch off the same row runs pi, reason named.
test("N4f: a claude small-ship row ships natively with claude_ship on; off, the same dispatch runs pi by name", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const worktree = () => readFleet(h.b.home).jobs.find((job) => job.job_id === ids[0])!.worktree;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree(), encoding: "utf8" }).trim();
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(worktree(), "src", "shipped.ts"), content: "export const shipped = true;\n" }) }] },
		step("Bash", { command: "git add -A && git commit -q -m shipped" }),
		step("mcp__picp__git_push", { branch: "release" }),
		step("mcp__picp__git_push", {}),
		step("mcp__picp__pr_create", { title: "Ship it", body: "Native ship e2e." }),
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ job_id: ids[0], kind: "ship", status: "done", summary: "Shipped natively.", branch: ids[0], head_sha: git("rev-parse", "HEAD"), pr_url: PR_URL }) }] },
		{ kind: "text", text: "Reported." },
		// The CI-repair promotion's turn: the same session resumes and fixes the head.
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(worktree(), "repaired.txt"), content: "fixed\n" }) }] },
		step("Bash", { command: "git add -A && git commit -q -m repaired" }),
		step("mcp__picp__git_push", {}),
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ job_id: ids[0], kind: "ship", status: "done", summary: "Repaired natively.", branch: ids[0], head_sha: git("rev-parse", "HEAD"), pr_url: PR_URL }) }] },
		{ kind: "text", text: "Repaired." },
	]);
	const PR_URL = "https://github.com/picp-e2e/forge/pull/7";
	const piModel = h.b.provider.addScript("n4f-pi-ship", Array.from({ length: 6 }, () => ({ kind: "text" as const, text: "idle" })));
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", FAKE_NATIVE_MODEL],
		rubric: [{ id: "small-ship", role: "implementer", scope: ["S"], model: FAKE_NATIVE_MODEL, fallbacks: [piModel], driver: "claude" }] }));
	const switchFile = join(h.b.home, LAYOUT.data, "native.json");
	writeFileSync(switchFile, JSON.stringify({ claude_research: true, claude_ship: false }));
	// A non-main base: preflight keeps the canonical clone on it, so the clone switches to release and publishes it.
	execFileSync("git", ["checkout", "-q", "-b", "release"], { cwd: h.b.clone });
	execFileSync("git", ["push", "-q", "-u", "origin", "release"], { cwd: h.b.clone });
	const bin = mkdtempSync(join(tmpdir(), "cp-n4f-gh-"));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	copyFileSync(join(import.meta.dirname, "..", "fixtures", "forge-gh"), join(bin, "gh"));
	chmodSync(join(bin, "gh"), 0o755);
	const ghLog = join(bin, "calls.log");
	writeFileSync(join(bin, "gitconfig"), "[user]\n\tname = n4f e2e\n\temail = n4f@test.invalid\n");
	const [off, native] = await Promise.all([1, 2].map((n) => h.b.ledger.create({ title: `n4f ship ${n} ${Math.random()}`, project: "demo", delivery: "pr", kind: "ship" })));
	ids.push(native!.id);
	const dispatch = (id: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Add src/shipped.ts.", scope: "S", base: "release", queue: false, when_ready: false } }] });
	const ends = (await h.b.run([
		dispatch(off!.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `echo '{"claude_ship":true}' > "${switchFile}"` } }] },
		dispatch(native!.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(native!.id)) } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_send", args: { job_id: native!.id, message: "CI is red on the pushed head: fix it.", purpose: "repair" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(native!.id)) } }] },
	], { ...h.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FORGE_GH_LOG: ghLog, GIT_CONFIG_GLOBAL: join(bin, "gitconfig") }, undefined, 300_000)) as Tool[];
	const [offEnd, nativeEnd] = ends.filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(offEnd?.isError, true, text(offEnd));
	assert.notEqual(nativeEnd?.isError, true, text(nativeEnd));
	// Switch off: the claude row falls back to pi with the class switch named; no native run.
	const offRecord = readFleet(h.b.home).jobs.find((job) => job.job_id === off!.id)!;
	assert.deepEqual([offRecord.worker.driver, offRecord.worker.model, offRecord.routing?.requested_driver, offRecord.routing?.driver], [undefined, piModel, "claude", "pi"]);
	assert.match(offRecord.routing?.driver_reason ?? "", /^switch: the switch workers\.native_claude_ship is off/);
	// Switch on: the Driver fact is claude, and the report's head_sha is the worktree HEAD and origin/<job>.
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === native!.id)!;
	assert.deepEqual([record.worker.driver, record.routing?.driver], ["claude", "claude"]);
	// The repair below reopened the slot: the first accepted envelope is archived as generation 1, at the shipped commit.
	const filed = (JSON.parse(readFileSync(join(h.b.home, paths.supersededEnvelopeFile(native!.id, 1)), "utf8")) as { envelope: Envelope }).envelope;
	assert.equal(filed.head_sha, git("rev-parse", "HEAD~1"), toolResults(h.claude.requests).join("\n---\n"));
	assert.equal(git("log", "-1", "--format=%s", "HEAD~1"), "shipped");
	assert.equal(readRunEvents(h.b.home, native!.id).filter((event) => event.type === "envelope_received").length, 2, "the ship and the repair");
	// CP_BASE_BRANCH reached the worker from the dispatch base: pr_create targets it and git_push refuses it.
	assert.match(toolResults(h.claude.requests).join("\n"), /Refused: git_push never pushes release \(main and the base branch/);
	// The parent's own forge reads (`api user`, `pr view`) share the shim; only the worker creates a PR.
	const created = readFileSync(ghLog, "utf8").trim().split("\n").filter((line) => line.startsWith("pr create"));
	assert.deepEqual(created, [`pr create --draft --head ${native!.id} --base release --title Ship it --body Native ship e2e.`]);
	const system = readFileSync(join(h.b.home, paths.runDir(native!.id), "native-system-prompt.md"), "utf8");
	assert.match(system, /open the draft PR with pr_create/, "the ship addendum, not the research one");
	assert.doesNotMatch(system, /Write the research artifact/);
	const run = readRunEvents(h.b.home, native!.id).find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	assert.equal(run?.lockdown, "ok");
	assert.ok(readRunStatus(h.b.home, native!.id).usage.total_tokens > 0);
	// The CI-repair promotion (same kind) is admitted and resumes the reporting session: its prompt rides the transcript.
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	const repair = h.claude.requests.filter((request) => JSON.stringify(request.body.messages ?? "").includes("CI is red on the pushed head"));
	assert.ok(repair.length > 0, "the repair prompt reached the model");
	assert.match(JSON.stringify(repair[0]!.body.messages), /Shipped natively\.[\s\S]*CI is red on the pushed head/, "the repair turn resumed the same session");
	const repaired = (JSON.parse(readFileSync(h.envelope(native!.id), "utf8")) as { envelope: Envelope }).envelope;
	assert.deepEqual([repaired.summary, repaired.head_sha, git("log", "-1", "--format=%s")], ["Repaired natively.", git("rev-parse", "HEAD"), "repaired"]);
	assert.equal(git("ls-remote", "origin", `refs/heads/${native!.id}`).split("\t")[0], repaired.head_sha);
	assert.deepEqual(localChecks(repaired, { job_id: native!.id, kind: "ship", delivery: "pr", role: "implementer", runDir: join(h.b.home, paths.runDir(native!.id)), worktree: worktree(), mayAskOperator: false }), []);
	assert.ok(readNativeSession(join(h.b.home, paths.runDir(native!.id), NATIVE_SESSION_FILE)).session_id);
	assert.equal(h.claude.overrun(), 0);
});

// N4e: an unreported clean turn used to exit non-zero and fail the job (old P3g); it now settles idle for the nudge.
test("P3b/f/g: switch off and a drain freeze refuse before any spawn; an unreported turn settles idle and the nudge lands it", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "text", text: "No report from me." },
		// The Stop hook blocks the first unreported stop once; this second stop ends the turn unreported.
		{ kind: "text", text: "Still no report." },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the nudge." },
	]);
	const [off, frozen, settle] = await Promise.all([h.job(), h.job(), h.job()]);
	ids.push(settle.id);
	const dispatch = (id: string) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] });
	const drain = join(h.b.home, LAYOUT.state, "drain.json");
	const now = new Date().toISOString();
	const freeze = JSON.stringify({ state: "drained", started_at: now, deadline: now, timeout_s: 0, jobs: [], cause: { reason: "freeze" } });
	const ends = (await h.b.run([
		dispatch(off.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `echo '{"claude_research":true}' > "${join(h.b.home, LAYOUT.data, "native.json")}" && echo '${freeze}' > "${drain}"` } }] },
		dispatch(frozen.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `rm "${drain}"` } }] },
		dispatch(settle.id),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(settle.id)) } }] },
	], { ...h.env, CP_NATIVE_MAX_TURNS: "forty" })) as Tool[];
	const [first, second, third] = ends.filter((end) => end.toolName === "cp_dispatch");
	// P3b: off by default; refused with no child, no request to the model.
	assert.match(text(first), /workers\.native_claude_research is off/);
	assert.match(text(second), /draining/);
	for (const id of [off.id, frozen.id]) assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	// P3g: the unreported turn settled idle (no exit, no failure); the settle watcher's nudge resumed the same session.
	assert.notEqual(third?.isError, true, text(third));
	const events = readRunEvents(h.b.home, settle.id);
	const types = events.map((event) => event.type);
	const runs = events.filter((event) => event.type === "native_run").map((event) => event.payload as { report?: boolean; resumed?: boolean; max_turns?: number; stop?: string });
	assert.deepEqual(runs.map((run) => [run.report, run.resumed]), [[false, false], [true, true]], JSON.stringify(runs));
	assert.deepEqual([runs[0]?.max_turns, runs[0]?.stop], [500, undefined], "an invalid CP_NATIVE_MAX_TURNS keeps the default and no stop");
	assert.ok(types.indexOf("agent_settled") >= 0 && types.indexOf("agent_settled") < types.indexOf("report_nudged"), types.join(","));
	assert.equal((events.find((event) => event.type === "report_nudged")?.payload as { receipt?: string } | undefined)?.receipt, "delivered");
	assert.equal(types.includes("process_exit") || types.includes("failure"), false, types.join(","));
	const record = readFleet(h.b.home).jobs.find((job) => job.job_id === settle.id);
	assert.equal(record?.failure, undefined, JSON.stringify(record?.failure));
	assert.notEqual(record?.phase, "failed");
	assert.equal(types.filter((type) => type === "envelope_received").length, 1, "the nudged turn landed one report");
	const calls = h.claude.requests.filter((request) => request.path.startsWith("/v1/messages") && Array.isArray(request.body.tools));
	assert.match(JSON.stringify(calls.at(-1)?.body.messages ?? ""), /No report from me\.[\s\S]*You have stopped without calling report_result/, "the nudge resumed the same session");
	assert.equal(h.claude.overrun(), 0);
});

// Scenario: picp's report nudge reaches an idle native worker while an auto-update waits for mid-turn workers
//   Given a native research worker whose turn is running when an auto-update starts waiting on busy workers
//   When the turn ends unreported and settle nudges the idle worker
//   Then the nudge is delivered, not refused by the update hold, and the resumed turn reports
test("update hold: picp's report nudge to an idle unreported native worker passes a pending auto-update", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const hold = async () => {
		writeFileSync(join(h.b.home, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true }));
		writeFileSync(join(h.b.home, LAYOUT.state, "update.json"), JSON.stringify({ last_result: "skipped_busy", busy_since: new Date().toISOString(), to: "cc2833047290" }));
	};
	const h = await nativeHome(t, [
		{ kind: "text", text: "No report from me.", beforeAnswer: hold },
		{ kind: "text", text: "Still no report." },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the nudge." },
	]);
	h.toggle(true);
	const job = await h.job();
	ids.push(job.id);
	await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(job.id)) } }] },
	], h.env);
	assert.ok(updatePending(h.b.home), "the update hold stayed in force");
	const events = readRunEvents(h.b.home, job.id);
	const nudge = events.find((event) => event.type === "report_nudged")?.payload as { receipt?: string; error?: string } | undefined;
	assert.equal(nudge?.receipt, "delivered", JSON.stringify(nudge));
	const runs = events.filter((event) => event.type === "native_run").map((event) => (event.payload as { report?: boolean }).report);
	assert.deepEqual(runs, [false, true]);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 1);
});

test("N4e lockdown: a refused lockdown is a named failure, never a nudge", { skip, timeout: 300_000 }, async (t) => {
	const h = await nativeHome(t, [{ kind: "text", text: "Never reached." }], true, { outputStyle: "Explanatory" });
	h.toggle(true);
	const job = await h.job();
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
	], h.env)) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "failed", { timeoutMs: 120_000, what: "failed native job" });
	assert.equal(record?.failure?.class, "spawn_failed");
	assert.match(record?.failure?.message ?? "", /^native run stopped: the Claude CLI lockdown refused the loaded surface before any tool ran; not nudged\./);
	const events = readRunEvents(h.b.home, job.id);
	const run = events.find((event) => event.type === "native_run")?.payload as { lockdown?: string; stop?: string } | undefined;
	assert.deepEqual([run?.lockdown, run?.stop], ["refused", "lockdown"], JSON.stringify(run));
	assert.equal(events.some((event) => event.type === "agent_settled" || event.type === "report_nudged"), false, "a lockdown stop was nudged");
});

// N4e: a rejected window mid-run was an unnamed crash; it is now provider_limit, and a revive after the reset resumes.
test("N4e window: a rejected window ends the run as provider_limit by name, and a revive after the reset resumes the session", { skip, timeout: 420_000 }, async (t) => {
	const ids: string[] = [];
	const reset = Math.floor(Date.now() / 1000) + 3600;
	const h = await nativeHome(t, [
		{ kind: "text", text: "Spent.", limit: { status: "rejected", claim: "five_hour", resetsAt: reset } },
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported after the reset." },
	], true, {}, true);
	h.toggle(true);
	const job = await h.job();
	ids.push(job.id);
	const dispatched = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
	], h.env)) as Tool[];
	assert.notEqual(dispatched[0]?.isError, true, text(dispatched[0]));
	const record = await waitFor(() => readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "failed", { timeoutMs: 120_000, what: "failed native job" });
	const at = new Date(reset * 1000).toISOString();
	assert.equal(record?.failure?.class, "provider_limit");
	assert.equal(record?.failure?.message, `native run stopped: the Claude subscription window five_hour is spent (resets ${at}); the worktree and session are kept, and cp_revive after the reset resumes the same session`);
	const before = readRunEvents(h.b.home, job.id);
	const run = before.find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	assert.deepEqual([run?.stop, run?.window, run?.resets_at, run?.report], ["window", "five_hour", reset * 1000, false], JSON.stringify(run));
	assert.equal(before.some((event) => event.type === "agent_settled" || event.type === "report_nudged"), false, "a window stop was nudged");
	// The reset passes (the snapshot says so); a plain revive then resumes the same session through the existing path.
	const sessionFile = join(h.b.home, paths.runDir(job.id), NATIVE_SESSION_FILE);
	const session = readNativeSession(sessionFile).session_id;
	const snapshot = readNativeAvailability(h.b.home)!;
	snapshot.windows.five_hour = { ...snapshot.windows.five_hour!, resets_at: Date.now() - 1000 };
	writeFileSync(nativeAvailabilityFile(h.b.home), JSON.stringify(snapshot));
	await h.b.closeParents();
	const revived = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_revive", args: { job_id: job.id, confirm: true } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(job.id)) } }] },
	], h.env)) as Tool[];
	assert.match(text(revived.find((end) => end.toolName === "cp_revive")), /resumed its native Claude session/);
	const runs = readRunEvents(h.b.home, job.id).filter((event) => event.type === "native_run").map((event) => event.payload as { resumed?: boolean; report?: boolean });
	assert.deepEqual(runs.map((entry) => [entry.resumed, entry.report]), [[false, false], [true, true]], JSON.stringify(runs));
	assert.equal(readNativeSession(sessionFile).session_id, session, "the revive started a new session");
	assert.equal(readRunEvents(h.b.home, job.id).filter((event) => event.type === "envelope_received").length, 1);
	assert.equal(h.claude.overrun(), 0);
});

// cp-s26-flake-research-dudi exited at the SDK turn cap and was recorded as a crash; the stop is now named turn_limit.
test("turn limit: a native run stopped at CP_NATIVE_MAX_TURNS fails as turn_limit and is never auto-recovered", { skip, timeout: 300_000 }, async (t) => {
	const h = await nativeHome(t, [step("Bash", { command: "ls" })]);
	h.toggle(true);
	const job = await h.job();
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
	], { ...h.env, CP_NATIVE_MAX_TURNS: "1" })) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "failed", { timeoutMs: 120_000, what: "failed native job" });
	assert.equal(record?.failure?.class, "turn_limit");
	assert.equal(record?.failure?.message, "native run stopped at the turn limit (1 turns) before reporting; the worktree and session are kept");
	const run = readRunEvents(h.b.home, job.id).find((event) => event.type === "native_run")?.payload as { max_turns?: number; stop?: string } | undefined;
	assert.deepEqual([run?.max_turns, run?.stop], [1, "max_turns"], "the override is honoured and the stop recorded");
	// D1: bounded recovery refuses the native job by name; nothing revives, redispatches or moves it to pi.
	const refused = await waitFor(() => readRunEvents(h.b.home, job.id).find((event) => event.type === "recovery_failed"), (event) => event !== undefined, { timeoutMs: 30_000, what: "recovery refusal" });
	assert.equal((refused?.payload as { stage?: string }).stage, "native");
	const events = readRunEvents(h.b.home, job.id).map((event) => event.type);
	assert.equal(events.includes("worker_revived") || events.includes("recovery_attempted"), false, events.join(","));
	const after = readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id);
	assert.deepEqual([after?.phase, after?.worker.driver], ["failed", "claude"]);
	assert.equal(h.claude.overrun(), 0);
});

// N4a: cp-s26-flake-research-dudi cost $1.81 at error_max_turns but recorded 0, and its denials logged a count only.
test("N4a: an error_max_turns run is measured from modelUsage, and its refused Bash calls are named in native_run", { skip, timeout: 300_000 }, async (t) => {
	const refused = ["echo x > native-write.txt", "rm -rf native-dir", "touch native-a", "mkdir native-b", "cp README.md native-c", "mv README.md native-d"];
	const h = await nativeHome(t, [{ kind: "tool_use", calls: refused.map((command) => ({ name: "Bash", input: { command } })) }]);
	h.toggle(true);
	const job = await h.job();
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
	], { ...h.env, CP_NATIVE_MAX_TURNS: "1" })) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => readFleet(h.b.home).jobs.find((entry) => entry.job_id === job.id), (entry) => entry?.phase === "failed", { timeoutMs: 120_000, what: "failed native job" });
	assert.equal(record?.failure?.class, "turn_limit");
	const run = readRunEvents(h.b.home, job.id).find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	assert.deepEqual([run?.result_subtype, run?.usage, run?.usage_status], ["error_max_turns", "measured", "complete"], JSON.stringify(run));
	const status = readRunStatus(h.b.home, job.id);
	assert.equal(status.usage_unavailable, undefined);
	assert.ok(status.usage.cost_usd > 0 && status.usage.total_tokens > 0, JSON.stringify(status.usage));
	// Six refusals: five are named, each cut at 200 chars (the policy's text runs longer).
	const denied = run?.denied as string[];
	assert.equal(run?.denials, 6);
	assert.equal(denied.length, 5, JSON.stringify(denied));
	assert.ok(denied.every((line) => line.length <= 200 && line.startsWith("Bash: Refused: ") && / is denied/.test(line)), JSON.stringify(denied));
	assert.ok(denied.some((line) => line.length === 200), "a reason past 200 chars is cut");
	assert.equal(h.claude.overrun(), 0);
});

/** A native job that reports (or, `reported: false`, only writes its artifact), then holds its last model answer (and
 * so its `result`) on `hold`; torn down in between, the way a reviewer is stopped once its verdict lands. */
async function teardownBeforeResult(t: TestContext, hold: () => Promise<void>, reported = true) {
	const ids: string[] = [];
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }] },
		...(reported ? [{ kind: "tool_use" as const, calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] }] : []),
		{ kind: "text", text: "Reported.", beforeAnswer: hold },
	]);
	h.toggle(true);
	const native = await h.job();
	ids.push(native.id);
	const quote = `Force teardown ${native.id} and discard its unreported result.`;
	const ready = reported ? h.envelope(native.id) : join(h.b.home, paths.artifactFile(native.id));
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: native.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `for i in $(seq 600); do [ -f "${ready}" ] && break; sleep 0.1; done; sleep 0.5` } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: native.id, ...(reported ? {} : { force: true, operator_quote: quote }) } }] },
	], h.env, reported ? undefined : quote, 180_000)) as Tool[];
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	const events = readRunEvents(h.b.home, native.id);
	const removed = events.find((event) => event.type === "native_scratch_removed")?.payload as { removed?: string } | undefined;
	assert.ok(removed?.removed && !existsSync(removed.removed), "the scratch dir survived teardown");
	const run = events.find((event) => event.type === "native_run")?.payload as Record<string, unknown> | undefined;
	return { down, events, run, status: readRunStatus(h.b.home, native.id) };
}

// N4a R1: the soak runs read unavailable because teardown stopped claude between the report and its result.
// N4k: every native review read $0, its result slower than the 4 s grace; 15 s is past that, inside the reported grace.
test("N4k grace: a stop after an accepted report waits the longer grace for the result, measures the run and tears down", { skip, timeout: 300_000 }, async (t) => {
	const { events, run, status } = await teardownBeforeResult(t, () => sleep(NATIVE_RESULT_GRACE_MS + 11_000));
	const seq = (type: string) => events.find((event) => event.type === type)?.seq ?? Number.NaN;
	assert.ok(seq("shutdown_requested") < seq("message_end"), "teardown was requested before the result was measured");
	assert.deepEqual([run?.report, run?.result_subtype, run?.usage, run?.usage_status], [true, "success", "measured", "complete"], JSON.stringify(run));
	assert.equal(status.usage_unavailable, undefined);
	assert.ok(status.usage.cost_usd > 0, JSON.stringify(status.usage));
});

test("N4k grace: a reported run whose result never comes is estimated from its streamed usage after the longer grace", { skip, timeout: 300_000 }, async (t) => {
	const { down, run, status } = await teardownBeforeResult(t, () => new Promise(() => {}));
	assert.ok((down?.durationMs ?? Infinity) < NATIVE_REPORTED_GRACE_MS + 3_000, `teardown took ${down?.durationMs} ms`);
	assert.deepEqual([run?.report, run?.usage, run?.usage_status, run?.cost_unknown], [true, "estimated", "estimated", true], JSON.stringify(run));
	assert.equal(status.usage_unavailable, undefined);
	assert.ok(status.usage.total_tokens > 0 && status.usage.cost_usd === 0, JSON.stringify(status.usage));
});

test("N4k grace: an unreported stop mid-turn still tears down within the old bound, its streamed usage estimated", { skip, timeout: 300_000 }, async (t) => {
	const { down, run, status } = await teardownBeforeResult(t, () => new Promise(() => {}), false);
	assert.ok((down?.durationMs ?? Infinity) < NATIVE_RESULT_GRACE_MS + 3_000, `teardown took ${down?.durationMs} ms`);
	assert.deepEqual([run?.report, run?.usage_status], [false, "estimated"], JSON.stringify(run));
	assert.ok(status.usage.total_tokens > 0, JSON.stringify(status.usage));
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
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: native.id, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false, driver: "claude" } }] },
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

// Scenario: Given a native implementer mid-turn with an uncommitted edit, When /cp-drain freeze runs,
//   Then the drain line says checkpointed and a WIP commit exists at the worktree HEAD,
//   And the worker is idle, not failed, and resumes on the same session after the drain.
test("J6 freeze: /cp-drain freeze checkpoints a mid-turn native implementer, which resumes its session after the drain", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const worktree = () => readFleet(h.b.home).jobs.find((job) => job.job_id === ids[0])!.worktree;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree(), encoding: "utf8" }).trim();
	let release: () => void = () => {};
	const held = new Promise<void>((done) => (release = done));
	let holding = false;
	const h = await nativeHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(worktree(), "wip.txt"), content: "half done\n" }) }] },
		{ kind: "text", text: "never sent", beforeAnswer: () => ((holding = true), held) },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => ({ job_id: ids[0], kind: "ship", status: "blocked", summary: "Resumed after the freeze.", blockers: ["the e2e ends here"] }) }] },
		{ kind: "text", text: "Reported." },
	]);
	t.after(release);
	writeFileSync(join(h.b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_ship: true }));
	const bin = mkdtempSync(join(tmpdir(), "cp-j6-git-"));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	writeFileSync(join(bin, "gitconfig"), "[user]\n\tname = j6 e2e\n\temail = j6@test.invalid\n");
	const job = await h.b.ledger.create({ title: `j6 freeze ${Math.random()}`, project: "demo", delivery: "pr", kind: "ship" });
	ids.push(job.id);
	const gate = join(bin, "parent-gate");
	const env = { ...h.env, GIT_CONFIG_GLOBAL: join(bin, "gitconfig") };
	const running = h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Add wip.txt.", model: FAKE_NATIVE_MODEL, driver: "claude", queue: false, when_ready: false } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(gate) } }] },
	], env, undefined, 240_000) as Promise<Tool[]>;
	await waitFor(() => holding, Boolean, { timeoutMs: 120_000, what: "the native implementer is mid-turn" });
	const parent = h.b.parents[0]!;
	const drainLine = async (command: string) => {
		const before = parent.records().length;
		await parent.prompt(command);
		const ui = await parent.waitFor((r) => parent.records().indexOf(r) >= before && r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 60_000);
		return String((ui as Record<string, unknown>).message);
	};
	const frozen = await drainLine("/cp-drain 120 freeze");
	const head = git("rev-parse", "HEAD");
	assert.ok(frozen.includes(`freeze: ${job.id} checkpointed (native claude at ${head})`), frozen);
	assert.deepEqual([git("log", "-1", "--format=%s"), git("show", "HEAD:wip.txt"), git("status", "--porcelain")], ["WIP: freeze checkpoint", "half done", ""]);
	const session = readNativeSession(join(h.b.home, paths.runDir(job.id), NATIVE_SESSION_FILE)).session_id;
	await waitFor(() => readRunEvents(h.b.home, job.id).some((event) => event.type === "settled_without_report"), Boolean, { timeoutMs: 30_000, what: "the frozen worker settles idle" });
	const record = readFleet(h.b.home).jobs.find((row) => row.job_id === job.id);
	assert.deepEqual([record?.phase === "failed", record?.failure, record?.worker.exited_at], [false, undefined, undefined], JSON.stringify(record));
	assert.equal((readRunEvents(h.b.home, job.id).find((event) => event.type === "native_run")?.payload as Record<string, unknown>)?.stop, undefined, "a frozen turn is no named failure");
	// After the drain the parent restarts (a fresh parent clears the drained record) and revives the job.
	writeFileSync(gate, "open\n");
	await running;
	await h.b.closeParents();
	const ends = (await h.b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_revive", args: { job_id: job.id, confirm: true } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: h.waitFile(h.envelope(job.id)) } }] },
	], env)) as Tool[];
	assert.match(text(ends.find((end) => end.toolName === "cp_revive")), /resumed its native Claude session/);
	const filed = (JSON.parse(readFileSync(h.envelope(job.id), "utf8")) as { envelope: Envelope }).envelope;
	assert.equal(filed.summary, "Resumed after the freeze.");
	assert.equal(readNativeSession(join(h.b.home, paths.runDir(job.id), NATIVE_SESSION_FILE)).session_id, session, "the same session resumed");
	const runs = readRunEvents(h.b.home, job.id).filter((event) => event.type === "native_run").map((event) => (event.payload as { resumed?: boolean }).resumed);
	assert.deepEqual(runs, [false, true], "the frozen run, then one resumed run");
	assert.match(JSON.stringify(h.claude.requests.at(-1)?.body.messages), /wip\.txt[\s\S]*Resumed after the freeze/, "the resumed turn carries the frozen turn's history");
});

// The single live run of N3b: the operator's own claude settings (claude reads them; picp never does). Counts only.
test("native live smoke: one research job through cp_dispatch on the installed claude", { skip: !LIVE_TESTS_ENABLED ? "set CP_LIVE_TESTS=1 to run live smokes" : !process.env.CP_LIVE_NATIVE_MODEL ? "set CP_LIVE_NATIVE_MODEL to the account's anthropic/claude-… id" : skip, timeout: 300_000 }, async (t) => {
	const b = await dispatchS29(t);
	writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true }));
	const job = await b.ledger.create({ title: "native live smoke", project: "demo", delivery: "local", kind: "research" });
	// S1: a native dispatch names an explicit model; the live account's own id, from the env, routed here.
	const model = process.env.CP_LIVE_NATIVE_MODEL!;
	routeNativeModel(b.home, [model]);
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
