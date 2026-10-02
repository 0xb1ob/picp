/**
 * T18 acceptance: each failure class is simulated and recovers per policy, and
 * the budget soft gate escalates instead of killing.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	isoTimestamp,
	paths,
	type RunEvent,
	type Usage,
} from "../src/contracts.ts";
import {
	checkBudget,
	classifyRun,
	decideRecovery,
	detectDeadModelCall,
	readModelCallError,
	FailureMonitor,
	mayRerunResearch,
	MAX_RECOVERY_ATTEMPTS,
	TOOL_LOOP_THRESHOLD,
} from "../src/failures.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readFleet,
	readRunEvents,
	REPO_ROOT,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

let seq = 0;
function event(type: string, payload: Record<string, unknown> = {}, source: "pi" | "cp" = "pi", ts?: string): RunEvent {
	seq += 1;
	return { seq, ts: ts ?? isoTimestamp(), job_id: "cp-x", source, type, payload };
}

function assistantMessage(text: string): RunEvent {
	return event("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test("a reported run is never a failure, whatever else happened", () => {
	const events = [
		event("spawned", {}, "cp"),
		event("session_start"),
		event("agent_settled"),
		event("envelope_received", { status: "done" }, "cp"),
		event("process_exit", { code: 1 }, "cp"),
	];
	assert.equal(classifyRun(events), undefined);
});

test("crash: an observed non-zero close with no envelope", () => {
	const events = [event("spawned", {}, "cp"), event("agent_start"), event("process_exit", { code: 137 }, "cp")];
	const result = classifyRun(events);
	assert.equal(result?.class, "crash");
	assert.match(result?.message ?? "", /code 137/);
	assert.deepEqual(result?.evidence, ["cp:process_exit"]);
});

test("spawn_failed: the child never emitted a single event", () => {
	const events = [event("spawned", {}, "cp"), event("process_exit", { code: 2 }, "cp")];
	assert.equal(classifyRun(events)?.class, "spawn_failed");
});

test("a close we asked for is not a failure", () => {
	const events = [
		event("spawned", {}, "cp"),
		event("agent_start"),
		assistantMessage("working"),
		event("agent_settled"),
		event("shutdown_requested", { job_id: "cp-x" }, "cp"),
		event("process_exit", { code: 0 }, "cp"),
	];
	assert.equal(classifyRun(events), undefined);

	// The same close, unasked for, is a run that finished its turn and ended
	// without an envelope (cp-settle-without-report) — not a crash. A crash is an
	// exit with no settle behind it, which is the second case below.
	const unasked = events.filter((entry) => entry.type !== "shutdown_requested");
	assert.equal(classifyRun(unasked)?.class, "settled_without_report");
	const neverSettled = unasked.filter((entry) => entry.type !== "agent_settled");
	assert.equal(classifyRun(neverSettled)?.class, "crash");
});

test("provider_limit: the auto-retry ladder gave up", () => {
	const events = [
		event("spawned", {}, "cp"),
		event("agent_start"),
		event("auto_retry_start", { attempt: 1 }),
		event("auto_retry_end", { success: false, attempt: 3, finalError: "429 rate_limit" }),
		event("agent_settled"),
	];
	const result = classifyRun(events);
	assert.equal(result?.class, "provider_limit");
	assert.match(result?.message ?? "", /429 rate_limit/);
});

test("agent_empty_output: settled with nothing to show", () => {
	const events = [event("spawned", {}, "cp"), event("agent_start"), event("agent_settled")];
	assert.equal(classifyRun(events)?.class, "agent_empty_output");

	// text output is not empty output
	const withText = [
		event("spawned", {}, "cp"),
		event("agent_start"),
		assistantMessage("here is what I found"),
		event("agent_settled"),
	];
	assert.equal(classifyRun(withText), undefined);
});

// ---------------------------------------------------------------------------
// cp-0wq7: dead on arrival — the model call itself failed
// ---------------------------------------------------------------------------

/**
 * Verbatim shape from `state/runs/cp-1l2s/events.jsonl` (2026-09-04): pi ran
 * the loop, the assistant message came back `stopReason: "error"` with the
 * provider's words and zero tokens, and the run settled two seconds after it
 * started. Four workers did this in one session; every prompt sent at them
 * produced another one of these.
 */
function failedModelCall(errorMessage = "401 Invalid API key"): Record<string, unknown> {
	return {
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage,
		},
	};
}

function deadOnArrivalRun(): RunEvent[] {
	return [
		event("spawned", { pid: 1, model: "anthropic/claude-opus-5", profile: "qa" }, "cp"),
		event("prompt_sent", { receipt: "delivered", bytes: 3367 }, "cp"),
		event("agent_start"),
		event("turn_start"),
		event("message_end", { message: { role: "user", content: [{ type: "text", text: "the brief" }] } }),
		event("message_end", failedModelCall()),
		event("turn_end", failedModelCall()),
		event("agent_end", { willRetry: false }),
		event("agent_settled"),
	];
}

test("model_call_failed: the worker settled in seconds because the model call errored", () => {
	const result = classifyRun(deadOnArrivalRun(), { alive: false });
	assert.equal(result?.class, "model_call_failed");
	assert.match(result?.message ?? "", /401 Invalid API key/);
	assert.match(result?.message ?? "", /anthropic\/claude-opus-5/);
	assert.match(result?.message ?? "", /never ran a turn/);

	// The same run after the nudge and the close: still the model call, never
	// "settled without report" (there is no delivery) and never a crash.
	const nudgedThenExited = [
		...deadOnArrivalRun(),
		event("report_nudged", { receipt: "delivered", settles: 1 }, "cp"),
		event("agent_start"),
		event("message_end", failedModelCall()),
		event("agent_settled"),
		event("process_exit", { code: 0 }, "cp"),
	];
	assert.equal(classifyRun(nudgedThenExited, { alive: false })?.class, "model_call_failed");

	// It is not recoverable by another attempt: the same credential fails again.
	const decision = decideRecovery({ class: "model_call_failed", role: "implementer", attempts: 0 });
	assert.equal(decision.action, "escalate");
	assert.match(decision.reason, /credential/);
});

test("one errored model call in a run that did real work is not dead on arrival", () => {
	const recovered = [
		event("spawned", {}, "cp"),
		event("agent_start"),
		event("message_end", failedModelCall("529 overloaded")),
		event("tool_execution_start", { toolName: "bash", args: { command: "npm test" } }),
		assistantMessage("pushed the branch"),
		event("agent_settled"),
		event("process_exit", { code: 0 }, "cp"),
	];
	// The work happened; the missing envelope is the only problem here.
	assert.equal(classifyRun(recovered, { alive: false })?.class, "settled_without_report");
	assert.equal(detectDeadModelCall(recovered), undefined);

	// And a run that reported is never dead on arrival, whatever its calls did.
	assert.equal(detectDeadModelCall([...deadOnArrivalRun(), event("envelope_received", {}, "cp")]), undefined);
});

test("a model error pi is still retrying is a recovery in progress, never dead on arrival", () => {
	// pi's own ladder owns transient provider failures: `auto_retry_start` with no
	// matching `auto_retry_end` means it has not given up. A live run in that state
	// has produced nothing yet and looks exactly like the DOA shape — failing it
	// here would kill a run mid-recovery.
	const retrying = [
		event("spawned", {}, "cp"),
		event("prompt_sent", { receipt: "delivered" }, "cp"),
		event("agent_start"),
		event("message_end", failedModelCall("529 overloaded")),
		event("auto_retry_start", { attempt: 1 }),
	];
	assert.equal(detectDeadModelCall(retrying), undefined);
	assert.equal(classifyRun(retrying, { alive: true })?.class, undefined);

	// The retry succeeds: still not dead, and nothing to classify.
	const recovered = [...retrying, event("auto_retry_end", { success: true, attempt: 2 })];
	assert.equal(detectDeadModelCall(recovered), undefined, "a closed retry that succeeded clears the error");

	// The retry gives up: pi says so, and `provider_limit` — not model_call_failed
	// — is the class, because the ladder is what was exhausted.
	const exhausted = [
		...retrying,
		event("auto_retry_end", { success: false, attempt: 3, finalError: "529 overloaded" }),
		event("agent_settled"),
	];
	assert.equal(classifyRun(exhausted, { alive: false })?.class, "provider_limit");
});

test("readModelCallError reads pi's own words, and nothing that merely looks like them", () => {
	const errored = event("message_end", failedModelCall());
	assert.deepEqual(readModelCallError(errored), {
		message: "401 Invalid API key",
		provider: "anthropic",
		model: "claude-opus-5",
	});

	// A worker talking about a 401 is not a failed model call.
	assert.equal(readModelCallError(assistantMessage("the API returned 401 Invalid API key")), undefined);
	// Neither is a user message, a tool result, or a cp marker.
	assert.equal(readModelCallError(event("message_end", { message: { role: "user", stopReason: "error" } })), undefined);
	assert.equal(readModelCallError(event("failure", { class: "crash" }, "cp")), undefined);
	// An error with no message still names itself rather than inventing a cause.
	const blank = event("message_end", { message: { role: "assistant", stopReason: "error" } });
	assert.match(readModelCallError(blank)?.message ?? "", /error with no message/);
});

test("tool_loop: the same call, over and over", () => {
	const events: RunEvent[] = [event("spawned", {}, "cp"), event("agent_start")];
	for (let index = 0; index < TOOL_LOOP_THRESHOLD; index++) {
		events.push(event("tool_execution_start", { toolName: "bash", args: { command: "npm test" } }));
	}
	const result = classifyRun(events);
	assert.equal(result?.class, "tool_loop");
	assert.match(result?.message ?? "", /repeated \d+ times/);

	// different arguments are progress, not a loop
	const varied: RunEvent[] = [event("spawned", {}, "cp"), event("agent_start")];
	for (let index = 0; index < TOOL_LOOP_THRESHOLD + 2; index++) {
		varied.push(event("tool_execution_start", { toolName: "bash", args: { command: `echo ${index}` } }));
	}
	assert.equal(classifyRun(varied), undefined);
});

test("timeout: silence past the deadline, and only while unsettled", () => {
	const old = "2026-01-01T00:00:00Z";
	const events = [event("spawned", {}, "cp", old), event("agent_start", {}, "pi", old)];
	const now = new Date("2026-01-01T01:00:00Z");
	assert.equal(classifyRun(events, { now, inactivityMs: 60_000 })?.class, "timeout");
	assert.equal(classifyRun(events, { now, inactivityMs: 24 * 3600_000 }), undefined, "inside the deadline is fine");

	const settled = [...events, event("agent_settled", {}, "pi", old), assistantMessage("done")];
	assert.equal(classifyRun(settled, { now, inactivityMs: 60_000 }), undefined, "a settled run is not a timeout");
});

test("budget_exceeded and explicit failures win over inference", () => {
	const budget = [event("spawned", {}, "cp"), event("budget_exceeded", { ratio: 1.2 }, "cp"), event("process_exit", { code: 0 }, "cp")];
	assert.equal(classifyRun(budget)?.class, "budget_exceeded");

	const explicit = [
		event("spawned", {}, "cp"),
		event("failure", { class: "envelope_invalid", message: "repairs exhausted", at: isoTimestamp() }, "cp"),
		event("process_exit", { code: 0 }, "cp"),
	];
	assert.equal(classifyRun(explicit)?.class, "envelope_invalid");
});

// ---------------------------------------------------------------------------
// recovery ladder
// ---------------------------------------------------------------------------

test("recovery: recoverable classes retry the same brief, bounded", () => {
	for (const failureClass of ["crash", "timeout", "agent_empty_output"] as const) {
		const first = decideRecovery({ class: failureClass, role: "implementer", attempts: 0 });
		assert.equal(first.action, "retry_same", failureClass);
		assert.equal(first.same_brief, true, "an implementer crash is re-dispatched with the SAME brief");

		const exhausted = decideRecovery({ class: failureClass, role: "implementer", attempts: MAX_RECOVERY_ATTEMPTS });
		assert.equal(exhausted.action, "escalate");
		assert.match(exhausted.reason, /instead of looping/);
	}
});

test("recovery: unrecoverable classes never retry", () => {
	for (const failureClass of ["tool_loop", "budget_exceeded", "spawn_failed", "wall_clock_exceeded", "tool_call_cap_exceeded"] as const) {
		const decision = decideRecovery({ class: failureClass, role: "implementer", attempts: 0 });
		assert.equal(decision.action, "escalate", failureClass);
		assert.match(decision.reason, /not recoverable by policy/);
	}
	assert.equal(decideRecovery({ class: "envelope_invalid", role: "planner", attempts: 0 }).action, "escalate");
});

test("recovery: provider limits retry the same model, then a fallback", () => {
	const same = decideRecovery({ class: "provider_limit", role: "planner", attempts: 0 });
	assert.equal(same.action, "retry_same");

	// cp-eff: no fallback model exists to try, so a persisting limit keeps
	// retrying the same model until the cap, then escalates to a human.
	const persisting = decideRecovery({ class: "provider_limit", role: "planner", attempts: 1 });
	assert.equal(persisting.action, "retry_same");

	const noFallback = decideRecovery({ class: "provider_limit", role: "planner", attempts: 1 });
	assert.equal(noFallback.action, "retry_same");

	const capped = decideRecovery({ class: "provider_limit", role: "planner", attempts: 2 });
	assert.equal(capped.action, "escalate");
});

test("an implementation failure never re-runs the research that preceded it", () => {
	assert.equal(mayRerunResearch("implementer", "planner"), false);
	assert.equal(mayRerunResearch("planner", "planner"), true);
	assert.equal(mayRerunResearch("implementer", "implementer"), true);
	assert.equal(mayRerunResearch("planner", "implementer"), true);
});

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

test("the soft gate warns before it breaches, and never kills", () => {
	const limits = { tokens: 1000, cost_usd: 10 };
	const usage = (tokens: number, cost = 0): Usage => ({ ...EMPTY_USAGE, total_tokens: tokens, cost_usd: cost });

	assert.equal(checkBudget(usage(100), limits).state, "ok");
	const warn = checkBudget(usage(800), limits);
	assert.equal(warn.state, "warn", `ratio ${warn.ratio}`);
	assert.match(warn.message ?? "", /budget at 80%/);

	const breach = checkBudget(usage(1200), limits);
	assert.equal(breach.state, "exceeded");
	assert.match(breach.message ?? "", /escalating to the operator/);

	// cost can breach on its own
	assert.equal(checkBudget(usage(10, 11), limits).state, "exceeded");
});

test("cache_read is excluded from the budgeted token total (cp-d7y)", () => {
	const limits = { tokens: 1000, cost_usd: 50 };

	// cp-n10's real shape: ~98% cache_read, 300% of the token ceiling by raw
	// count, 8% of the cost ceiling. Billed on cache_read-inclusive tokens this
	// reads as a breach; billed on the near-free-read-excluded total it does not.
	const mostlyCached: Usage = {
		...EMPTY_USAGE,
		input: 273_510,
		cache_read: 14_388_091,
		total_tokens: 14_661_601,
		cost_usd: 4.07,
	};
	const scaled = checkBudget(mostlyCached, { tokens: 15_000_000, cost_usd: 50 });
	assert.equal(scaled.state, "ok", `ratio ${scaled.ratio}, tokens.used ${scaled.tokens.used}`);
	assert.equal(scaled.tokens.used, 273_510, "billable tokens exclude cache_read");

	// A small, cheap, cache-read-heavy run must not misread as a breach either.
	const cached = (billable: number, cacheRead: number, cost = 0): Usage => ({
		...EMPTY_USAGE,
		input: billable,
		cache_read: cacheRead,
		total_tokens: billable + cacheRead,
		cost_usd: cost,
	});
	assert.equal(checkBudget(cached(100, 5000), limits).state, "ok", "5100 raw tokens, 100 of them billable");

	// Cache-free usage still breaches exactly as before.
	assert.equal(checkBudget(cached(1200, 0), limits).state, "exceeded");

	// A cost-only breach is unaffected by the token accounting change.
	assert.equal(checkBudget(cached(10, 5000, 60), limits).state, "exceeded");
});

// ---------------------------------------------------------------------------
// runtime: the monitor and the gate against a live worker
// ---------------------------------------------------------------------------

interface Bench {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	manager: WorkerManager;
	monitor: FailureMonitor;
	failures: Array<[string, string]>;
	spawn(jobId: string, script: Parameters<MockProvider["addScript"]>[1]): Promise<{ worker: import("../src/worker-process.ts").WorkerProcess; model: string }>;
}

async function bench(t: { after(fn: () => void | Promise<void>): void }): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "fail" });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const failures: Array<[string, string]> = [];
	const monitor = new FailureMonitor({
		home: home.path,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onFailure: (jobId, failure) => failures.push([jobId, failure.class]),
	});

	t.after(async () => {
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	return {
		home: home.path,
		fleet,
		runs,
		manager,
		monitor,
		failures,
		async spawn(jobId, script) {
			const model = provider.addScript(jobId, script);
			agentDir.writeModels(provider);
			const runDir = join(home.path, paths.runDir(jobId));
			const managed = manager.spawn({
				identity: { jobId, kind: "ship", delivery: "local", runDir, worktree: repo.path },
				profile: loadProfile(PROFILES_DIR, "implementer"),
				model,
				sessionDir: join(home.path, "sessions"),
			});
			runs.open(jobId).markSpawned({ pid: managed.worker.pid, model, profile: "implementer" });
			runs.open(jobId).attach(managed.worker);
			monitor.watch(jobId, managed.worker);
			const record: FleetRecord = {
				job_id: jobId,
				project: "fail",
				kind: "ship",
				delivery: "local",
				origin: DEFAULT_ORIGIN,
				phase: "waiting",
				worker: {
					pid: managed.worker.pid as number,
					session_id: "s",
					session_file: join(home.path, "sessions/s.jsonl"),
					profile: "implementer",
					role: "implementer",
					model,
					started_at: isoTimestamp(),
				},
				worktree: repo.path,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				budget: { tokens: 1000, cost_usd: 5 },
			};
			await fleet.add(record);
			await managed.worker.getState(30_000);
			return { worker: managed.worker, model };
		},
	};
}

test("a killed worker is classified and recorded in the fleet", { timeout: 120_000 }, async (t) => {
	const b = await bench(t);
	const { worker } = await b.spawn("cp-crash", [{ kind: "text", text: "working" }]);
	await worker.send("go");
	await worker.waitForSettled(60_000);

	await worker.kill("SIGKILL");
	const record = await waitFor(
		() => readFleet(b.home).jobs.find((job) => job.job_id === "cp-crash") as FleetRecord,
		(job) => job.phase === "failed",
		{ what: "the death to be recorded" },
	);
	// The run settled before it was killed, so the honest class is the specific
	// one (cp-settle-without-report): this worker finished a turn and never filed
	// an envelope. `crash` is reserved for an exit with no settle at all, which
	// the classifier unit tests cover directly.
	assert.equal(record.failure?.class, "settled_without_report");
	assert.deepEqual(b.failures, [["cp-crash", "settled_without_report"]]);
	assert.ok(readRunEvents(b.home, "cp-crash").some((entry) => entry.type === "failure"));

	// Evaluating again changes nothing: the job is already failed.
	assert.equal(await b.monitor.evaluate("cp-crash"), undefined);
});

test("a shutdown we asked for is not a failure", { timeout: 120_000 }, async (t) => {
	const b = await bench(t);
	const { worker } = await b.spawn("cp-quiet", [{ kind: "text", text: "all done" }]);
	await worker.send("go");
	await worker.waitForSettled(60_000);
	// Exactly what teardown records before it shuts a worker down.
	b.runs.open("cp-quiet").cp("shutdown_requested", { job_id: "cp-quiet" });
	await worker.shutdown();

	// The run settled with output; nothing to classify.
	assert.equal(await b.monitor.evaluate("cp-quiet"), undefined);
	assert.equal(b.fleet.require("cp-quiet").phase, "waiting");
	assert.deepEqual(b.failures, []);
});

test("the budget gate escalates a breach but still delivers the next send", { timeout: 120_000 }, async (t) => {
	const b = await bench(t);
	const { worker } = await b.spawn("cp-budget", [
		{ kind: "text", text: "cheap", usage: { prompt_tokens: 700, completion_tokens: 100 } },
		{ kind: "text", text: "expensive", usage: { prompt_tokens: 4000, completion_tokens: 1000 } },
		{ kind: "text", text: "still reachable", usage: { prompt_tokens: 100, completion_tokens: 20 } },
	]);
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home });

	// The gate runs BEFORE each delivery, so the first send sees no usage yet.
	const first = await sender.send({ jobId: "cp-budget", message: "first" });
	assert.equal(first.receipt, "delivered");
	assert.equal(first.budget?.state, "ok", `ratio ${first.budget?.ratio}`);
	await worker.waitForSettled(60_000);

	const second = await sender.send({ jobId: "cp-budget", message: "second" });
	assert.equal(second.receipt, "delivered");
	assert.equal(second.budget?.state, "warn", `ratio ${second.budget?.ratio}`);
	await worker.waitForSettled(60_000);

	// A budget breach is a T18 escalation, never a severed channel (cp-d7y):
	// the third send goes through even though the job is now over its ceiling.
	const third = await sender.send({ jobId: "cp-budget", message: "third" });
	assert.equal(third.receipt, "delivered", "a breach escalates; it does not block delivery");
	assert.equal(third.budget?.state, "exceeded", `ratio ${third.budget?.ratio}`);
	assert.match(third.budget?.message ?? "", /escalating to the operator/);
	await worker.waitForSettled(60_000);
	assert.equal(worker.alive, true, "a breach escalates; it never kills the worker");

	const markers = readRunEvents(b.home, "cp-budget")
		.filter((entry) => entry.source === "cp")
		.map((entry) => entry.type);
	assert.ok(markers.includes("budget_warning"));
	assert.ok(markers.includes("budget_exceeded"));

	// Usage syncs into the fleet from the projection.
	const usage = await b.monitor.syncUsage("cp-budget");
	assert.ok((usage?.total_tokens ?? 0) >= 1000);
	assert.equal(b.fleet.require("cp-budget").usage.total_tokens, usage?.total_tokens);
});

test("a steer still reaches a worker over its token ceiling but nowhere near its cost ceiling", { timeout: 120_000 }, async (t) => {
	const b = await bench(t);
	// The mock model's cost table is all-zero, so this run's cost_usd stays 0
	// however many tokens it burns — exactly the cp-n10 shape: 300% of the
	// token budget, a rounding error of the cost budget.
	const { worker } = await b.spawn("cp-budget-steer", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }],
			usage: { prompt_tokens: 5000, completion_tokens: 200 },
		},
		{ kind: "text", text: "acknowledged" },
		{ kind: "text", text: "and the queued steer too" },
	]);
	const sender = new Sender({ fleet: b.fleet, manager: b.manager, runs: b.runs, home: b.home });

	// Start the slow tool call; the gate sees no usage yet on this first send.
	const first = await sender.send({ jobId: "cp-budget-steer", message: "go" });
	assert.equal(first.receipt, "delivered");
	await worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(worker.busy, true, "the worker is mid-bash when the steer is attempted");

	// This run is already over its 1000-token ceiling (5200 billable tokens)
	// and at $0.00 of its $5 cost ceiling — healthy by the metric that matters.
	const steer = await sender.send({ jobId: "cp-budget-steer", message: "rebase before you open the PR", mode: "steer" });
	assert.equal(steer.receipt, "queued", "a steer to a busy, over-ceiling worker must still be delivered");
	assert.equal(steer.budget?.state, "exceeded", `ratio ${steer.budget?.ratio}`);
	assert.ok(steer.budget && steer.budget.tokens.used > steer.budget.tokens.limit, "the token ceiling really is breached");
	assert.ok(steer.budget && steer.budget.cost.used < steer.budget.cost.limit * 0.5, "the cost ceiling is nowhere close");
	assert.equal(worker.alive, true);

	await worker.waitForSettled(60_000);
	const markers = readRunEvents(b.home, "cp-budget-steer")
		.filter((entry) => entry.source === "cp")
		.map((entry) => entry.type);
	assert.ok(markers.includes("budget_exceeded"), "the breach still escalates to the operator");
	assert.ok(markers.includes("steer_sent"), "and the steer still reached the worker");
});
