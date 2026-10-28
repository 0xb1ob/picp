/**
 * P11c behavior 10: a job's run log (events.jsonl) and projection (status.json) through a real CommandPost: a real
 * pi worker is dispatched, teed, watched and torn down, and a seeded post-exit log still tears down.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type RunEvent } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { rebuildStatus } from "../../src/run-artifacts.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readRunEvents,
	readRunStatus,
	REPO_ROOT,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "P11c run log needs treehouse on PATH";
const at = (seconds: number) => isoTimestamp(new Date(Date.UTC(2026, 7, 27, 12, 0, seconds)));
const line = (jobId: string, seq: number, source: "pi" | "cp", type: string, payload: unknown = {}, seconds = seq): string =>
	`${JSON.stringify({ seq, ts: at(seconds), job_id: jobId, source, type, payload } satisfies RunEvent)}\n`;

test("P11c-run-log: a dispatched worker's log and projection are the read surface through teardown, and a post-exit log still tears down", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 3 });
	t.after(async () => {
		await post.shutdown();
		try { treehouse(clone, "prune"); } catch { /* the pool root is removed next */ }
		pool.cleanup(); agentDir.cleanup(); repo.cleanup(); home.cleanup();
		await provider.stop();
	});
	const worker = provider.addScript("p11c-run-worker", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "printf 'STREAMED-%s\\n' SECRET; sleep 2; echo tee-ok" } }], usage: { prompt_tokens: 300, completion_tokens: 40 } },
		{ kind: "text", text: "done", usage: { prompt_tokens: 400, completion_tokens: 50 } },
	]);
	agentDir.writeModels(provider);
	const jobId = (await post.ledger().create({ title: "run log", project: "demo", delivery: "local", kind: "ship", slug: "runlog" })).id;
	await post.dispatch({ jobId, task: "Echo, then stop.", model: worker, fetch: false, toolCallCap: 100 });

	const watched = () => post.watch(jobId).status;
	const working = await waitFor(watched, (s) => s?.phase === "working" && s.current_tool?.name === "bash", { timeoutMs: 60_000, what: "a working projection holding the bash call" });
	assert.equal(typeof working?.current_tool?.tool_call_id, "string");
	const idle = (await waitFor(watched, (s) => s?.phase === "idle" && s.turns >= 2, { timeoutMs: 60_000, what: "the settled projection" }))!;
	assert.deepEqual([idle.tool_calls, idle.current_tool, idle.reported, idle.model, idle.profile], [1, null, false, worker, "implementer"]);
	assert.deepEqual(idle.usage, { ...EMPTY_USAGE, input: 700, output: 90, total_tokens: 790 }, "streamed usage is neither double counted nor invisible");
	assert.equal(idle.settled_at, idle.last_activity_at);
	const raw = readFileSync(join(home.path, paths.eventsFile(jobId)), "utf8");
	assert.ok(raw.endsWith("\n"));
	assert.doesNotMatch(raw, /partialResult/, "a streamed partialResult is never logged");
	const live = readRunEvents(home.path, jobId);
	const s = live.find((e) => e.type === "spawned"); // CI may log worker_packages_unresolved first
	assert.deepEqual([s?.source, (s?.payload as { pid?: number }).pid], ["cp", idle.pid]);
	assert.deepEqual(live.map((event) => event.seq), live.map((_, i) => i + 1), "seq is dense and monotonic");
	for (const type of ["agent_start", "tool_execution_start", "tool_execution_end", "agent_settled"]) assert.ok(live.some((e) => e.type === type), type);
	assert.ok(!live.some((event) => event.type === "message_update"), "streaming deltas are summarized, not stored");
	const updates = live.filter((event) => event.type === "tool_execution_update");
	assert.ok(updates.length > 0 && updates.every((event) => (event.payload as { toolCallId?: string }).toolCallId === working?.current_tool?.tool_call_id));
	assert.doesNotMatch(JSON.stringify(updates), /STREAMED-SECRET/, "an update keeps its call id, never its streamed output");
	// After idle the one report nudge hits the exhausted mock script; pi retries and the outer ladder add turns.
	assert.deepEqual([idle.event_count <= live.length, live[idle.event_count - 1]?.ts], [true, idle.last_activity_at]);

	assert.equal((await post.tearDown(jobId, { force: true })).torn_down, true);
	const exited = readRunStatus(home.path, jobId);
	const closed = readRunEvents(home.path, jobId);
	assert.deepEqual(closed.slice(0, live.length), live, "the log is append-only");
	assert.deepEqual(closed.map((event) => event.seq), closed.map((_, i) => i + 1));
	assert.deepEqual([exited.phase, exited.exit_code, exited.tool_calls, exited.current_tool], ["exited", 0, 1, null]);
	assert.ok(exited.turns >= idle.turns && idle.turns >= 2, "turns never shrink; the failed nudge turn and its retries add more");
	assert.ok(closed.filter((event) => event.type === "report_nudged").length <= 1, "a settled-without-report worker is nudged once");
	const extraTurnCause = closed.some((event) => ["report_nudged", "recovery_prompted", "auto_retry_start"].includes(event.type));
	assert.ok(exited.turns <= 2 || extraTurnCause, `${exited.turns} turns past the script's two need a nudge or a retry event`);
	assert.ok(exited.exited_at && post.watch(jobId).exited, "the observed close is a cp marker the projection follows");
	assert.deepEqual(exited.usage, idle.usage);
	assert.deepEqual(rebuildStatus(home.path, jobId), exited, "the log rebuilds exactly the cached projection");

	// A failed job whose log outlived its process (cp-0wq7): pi events teed after the observed close, then hours of
	// suppressed wake-ups (8sz), a corrupt status cache, and a garbled sibling log. Teardown opens each run from its log.
	const fleet = new FleetStore({ home: home.path });
	const seed = async (slug: string, log: string) => {
		const id = (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "ship", slug })).id;
		const lease = JSON.parse(execFileSync("treehouse", ["get", "--lease", "--json", "--lease-holder", id], { cwd: clone, encoding: "utf8" })) as { path: string; lease_id: string };
		mkdirSync(join(home.path, paths.runDir(id)), { recursive: true });
		writeFileSync(join(home.path, paths.eventsFile(id)), log.replaceAll("JOB", id));
		await fleet.add({ job_id: id, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "failed", failure: { class: "crash", message: "worker exited 137", at: isoTimestamp() },
			worker: { pid: 999_999_999, session_id: id, session_file: join(home.path, `${id}.jsonl`), profile: "implementer", role: "implementer", model: worker, started_at: isoTimestamp() },
			worktree: lease.path, lease_id: lease.lease_id, branch: id, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE });
		return id;
	};
	const late = await seed("late", [
		line("JOB", 1, "cp", "spawned", { pid: 4242, model: worker, profile: "implementer" }), line("JOB", 2, "pi", "agent_start"), line("JOB", 3, "pi", "agent_settled"),
		line("JOB", 4, "cp", "process_exit", { code: 0, signal: null }), line("JOB", 5, "pi", "turn_start"), line("JOB", 6, "pi", "agent_start"),
		line("JOB", 7, "pi", "tool_execution_start", { toolName: "bash", toolCallId: "late-1" }), line("JOB", 8, "pi", "agent_settled"),
		line("JOB", 9, "cp", "wakeup_suppressed", { kind: "envelope", issued_at: at(0), reason: "already done", stage: "delivery" }, 4000),
		line("JOB", 10, "cp", "wakeup_suppressed", { kind: "verdict", issued_at: at(0), reason: "already done", stage: "delivery" }, 8000),
	].join(""));
	writeFileSync(join(home.path, paths.statusFile(late)), "{}\n");
	const garbled = await seed("garbled", `${line("JOB", 1, "cp", "spawned", { pid: 1 })}{not json\n`);
	const garbledLog = readFileSync(join(home.path, paths.eventsFile(garbled)), "utf8");

	const tornLate = await post.tearDown(late, { force: true });
	assert.deepEqual([tornLate.torn_down, tornLate.lease_returned], [true, true], "the run that used to throw 'projection is invalid' tears down");
	const lateRun = readRunStatus(home.path, late);
	assert.deepEqual([lateRun.phase, lateRun.exited_at, lateRun.settled_at, lateRun.current_tool, lateRun.turns], ["exited", at(4), at(3), null, 0],
		"post-exit pi events never reopen liveness, a settle mark or a tool call");
	assert.deepEqual(readRunEvents(home.path, late).slice(10).map((e) => [e.seq, e.type]), [[11, "shutdown_requested"]], "teardown appends after the history");
	assert.equal(lateRun.event_count, 11);

	await assert.rejects(post.tearDown(garbled, { force: true }), SyntaxError, "a corrupt log is refused, never silently replaced");
	assert.equal(readFileSync(join(home.path, paths.eventsFile(garbled)), "utf8"), garbledLog);
	assert.deepEqual([post.watch(garbled).events_read, post.watch(garbled).skipped_lines], [1, 1], "the viewer shows the torn line, never hides it");
});
