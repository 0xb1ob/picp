import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerProcess } from "../../src/worker-process.ts";
import { createAgentDir, createScratchRepo, MockProvider, WORKER_REPORTER_EXTENSION } from "../harness/index.ts";
import type { ScriptStep } from "../harness/index.ts";

const OBSERVATION = "worker-compaction-observation";
const BLOCK = "worker-compaction-policy-block";
const SECRET = "E3-SECRET-SENTINEL-7f3a";
const START_KEYS = ["v", "attempt", "phase", "reason", "willRetry", "tokensBefore", "enabled", "reserveTokens", "keepRecentTokens",
	"contextWindow", "threshold", "thresholdRule", "thresholdUnavailable", "settingsSourceUnavailable"];
const END_KEYS = ["v", "attempt", "phase", "outcome", "closedBy", "entryId", "fromExtension", "retainedEstimate",
	"retainedEstimateUnavailable", "nextInput", "nextInputUnavailable", "willRetry"];
const largeReply: ScriptStep = { kind: "text", text: "Continue the work. ".repeat(7000), usage: { prompt_tokens: 190000 } };

type Entry = { type: string; id: string; customType?: string; data?: Record<string, unknown>; message?: { role?: string; content?: unknown } };
const readSession = (file: string): Entry[] => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Entry);
const observations = (file: string) => readSession(file).filter((entry) => entry.type === "custom" && entry.customType === OBSERVATION).map((entry) => entry.data!);

/** Allowlist: only known keys, scalar numbers/booleans/null, enum-or-id strings and the numeric next-input object. */
function assertAllowlisted(file: string): void {
	for (const line of readFileSync(file, "utf8").split("\n").filter((row) => row.includes(OBSERVATION))) assert.ok(!line.includes(SECRET), "no payload in telemetry");
	for (const record of observations(file)) {
		const allowed = record.phase === "start" ? START_KEYS : END_KEYS;
		for (const [key, value] of Object.entries(record)) {
			assert.ok(allowed.includes(key), `unexpected telemetry key ${key}`);
			if (key === "nextInput" && value !== null) {
				assert.deepEqual(Object.keys(value as object).sort(), ["cacheRead", "cacheWrite", "input", "total"]);
				for (const part of Object.values(value as object)) assert.equal(typeof part, "number");
			} else if (typeof value === "string") assert.match(value, /^[a-z_]+$|^[0-9a-f-]{8,36}$/, `${key} is an enum or id`);
			else assert.ok(value === null || ["number", "boolean"].includes(typeof value), `${key} is scalar`);
		}
	}
}

async function startWorker(t: import("node:test").TestContext, name: string, steps: ScriptStep[], settings: (model: string) => Record<string, unknown>) {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "e3-telemetry", withRemote: false });
	const model = provider.addScript(name, steps);
	const agent = createAgentDir({ provider, settings: { retry: { enabled: false }, ...settings(model) } });
	const options = {
		cwd: repo.path, model, tools: ["report_result"], extensions: [WORKER_REPORTER_EXTENSION],
		sessionDir: join(agent.path, "sessions"), extraArgs: ["--no-context-files"],
		env: { ...agent.env, CP_JOB_ID: "cp-e3-telemetry", CP_KIND: "ship", CP_DELIVERY: "pr", CP_ROLE: "implementer", CP_RUN_DIR: join(agent.path, "run"), CP_WORKTREE: repo.path },
	};
	const state = { worker: WorkerProcess.spawn(options) };
	t.after(async () => { await state.worker.shutdown(); agent.cleanup(); repo.cleanup(); await provider.stop(); });
	const prompt = async (text: string) => {
		const settled = state.worker.waitForSettled(60_000);
		await state.worker.prompt(text);
		await settled;
	};
	const revive = async (sessionFile?: string) => {
		state.worker = WorkerProcess.spawn({ ...options, ...(sessionFile ? { sessionFile } : {}) });
		await state.worker.getState();
	};
	await state.worker.getState();
	return { provider, model, state, prompt, revive, requests: () => provider.requests(name).length, remaining: () => provider.remaining(name) };
}

const hasAssistantText = (file: string, text: string) =>
	readSession(file).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes(text));

test("E3 telemetry: threshold compaction records resolved override settings, retained estimate and next input", { timeout: 120_000 }, async (t) => {
	const steps: ScriptStep[] = [
		{ kind: "text", text: "First turn done.", usage: { prompt_tokens: 180000 } },
		{ kind: "text", text: `Summary mentioning ${SECRET}.` },
		{ kind: "text", text: "E3-CONTINUATION-DONE", usage: { prompt_tokens: 52000, cached_tokens: 40000, completion_tokens: 999 } },
	];
	// The override lowers the threshold to 170000; the ordinary reserve (183616) would not compact 180020 tokens.
	const run = await startWorker(t, "e3-threshold", steps, (model) => ({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1, modelOverrides: { [model]: { reserveTokens: 30000 } } } }));
	await run.prompt(`Start the job; never log ${SECRET}.`);
	assert.equal(run.requests(), 2, "threshold compaction summarizes once");
	await run.prompt("Continue the job.");
	assert.equal(run.requests(), 3, "continuation makes exactly one task request");
	assert.equal(run.remaining(), 0);
	const sessionFile = (await run.state.worker.getState()).sessionFile!;
	assert.ok(hasAssistantText(sessionFile, "E3-CONTINUATION-DONE"), "final continuation sentinel reached");
	const records = observations(sessionFile);
	assert.equal(records.length, 2);
	const [start, end] = records;
	assert.deepEqual({ ...start, tokensBefore: typeof start!.tokensBefore }, {
		v: 1, attempt: start!.attempt, phase: "start", reason: "threshold", willRetry: false, tokensBefore: "number", enabled: true,
		reserveTokens: 30000, keepRecentTokens: 1, contextWindow: 200000, threshold: 170000, thresholdRule: "context_tokens_gt_threshold",
		thresholdUnavailable: null, settingsSourceUnavailable: "hook_exposes_resolved_values_only",
	});
	const compaction = readSession(sessionFile).find((entry) => entry.type === "compaction")!;
	assert.deepEqual(end, {
		v: 1, attempt: start!.attempt, phase: "end", outcome: "compacted", closedBy: "next_usage", entryId: compaction.id, fromExtension: false,
		retainedEstimate: null, retainedEstimateUnavailable: "sdk_context_unknown",
		nextInput: { input: 12000, cacheRead: 40000, cacheWrite: 0, total: 52000 }, nextInputUnavailable: null,
	});
	assertAllowlisted(sessionFile);
});

test("E3 telemetry: manual compaction closes on shutdown; revival and abrupt death never attach stale state", { timeout: 120_000 }, async (t) => {
	const steps: ScriptStep[] = [
		{ kind: "text", text: "Read the brief." },
		{ kind: "text", text: "Summary one." },
		{ kind: "text", text: "Second turn.", usage: { prompt_tokens: 900 } },
		{ kind: "text", text: "Summary two." },
		{ kind: "text", text: "Turn prefix summary." },
		{ kind: "text", text: "E3-REVIVED-DONE", usage: { prompt_tokens: 700 } },
	];
	const run = await startWorker(t, "e3-manual", steps, () => ({ compaction: { enabled: false, keepRecentTokens: 1 } }));
	await run.prompt("Start the job.");
	assert.equal((await run.state.worker.request("compact", {}, 30_000)).success, true);
	assert.equal(run.requests(), 2);
	const sessionFile = (await run.state.worker.getState()).sessionFile!;
	await run.state.worker.shutdown();
	const [start, end] = observations(sessionFile);
	assert.equal(start!.reason, "manual");
	assert.equal(start!.enabled, false, "manual compaction reports the disabled automatic setting as resolved");
	assert.deepEqual([end!.attempt, end!.outcome, end!.closedBy, end!.nextInput, end!.nextInputUnavailable], [start!.attempt, "compacted", "shutdown", null, "no_next_usage"]);

	await run.revive(sessionFile);
	await run.prompt("Continue after revival.");
	assert.equal(run.requests(), 3);
	assert.equal(observations(sessionFile).length, 2, "revived usage never attaches to the closed attempt");
	assert.equal((await run.state.worker.request("compact", {}, 30_000)).success, true);
	assert.equal(run.requests(), 5, "split-turn compaction summarizes history and turn prefix");
	await run.state.worker.kill("SIGKILL");
	const afterDeath = observations(sessionFile);
	assert.deepEqual(afterDeath.slice(2).map((record) => record.phase), ["start"], "abrupt death leaves an open start");

	await run.revive(sessionFile);
	await run.prompt("Continue after death.");
	assert.equal(run.requests(), 6);
	assert.equal(run.remaining(), 0);
	assert.ok(hasAssistantText(sessionFile, "E3-REVIVED-DONE"));
	assert.equal(observations(sessionFile).length, 3, "a new process does not close the dead process's attempt");
	assertAllowlisted(sessionFile);
});

test("E3 telemetry: failure, cancellation, failed next response and session replacement keep correlation", { timeout: 120_000 }, async (t) => {
	const policy: ScriptStep = { kind: "error", status: 400, message: `Request blocked by safety policy ${SECRET}`, type: "invalid_request_error" };
	const steps: ScriptStep[] = [
		largeReply, policy, largeReply,
		largeReply, { kind: "text", text: "Summary three." },
		{ kind: "error", status: 503, message: `service unavailable ${SECRET}` },
		{ kind: "text", text: "Summary four." },
		{ kind: "text", text: "E3-FRESH-DONE", usage: { prompt_tokens: 600 } },
	];
	const run = await startWorker(t, "e3-failures", steps, () => ({ compaction: { keepRecentTokens: 1 } }));
	const first = (await run.state.worker.getState()).sessionFile!;
	await run.prompt("Start the job.");
	assert.equal(run.requests(), 2, "threshold compaction reaches the summarizer");
	await run.prompt("Continue the job.");
	assert.equal(run.requests(), 3, "the policy guard still cancels without a summarizer request");
	const one = observations(first);
	// Pre-prompt and post-response threshold checks both reach the guard; each cancelled attempt gets its own pair.
	assert.deepEqual(one.map((record) => [record.phase, record.outcome ?? record.reason]), [
		["start", "threshold"], ["end", "failed"], ["start", "threshold"], ["end", "cancelled"], ["start", "threshold"], ["end", "cancelled"],
	]);
	for (let index = 0; index < one.length; index += 2) assert.equal(one[index + 1]!.attempt, one[index]!.attempt, "start and end share an attempt");
	assert.equal(new Set(one.map((record) => record.attempt)).size, 3, "each attempt has its own id");
	assert.equal(readSession(first).filter((entry) => entry.customType === BLOCK).length, 1, "the guard's own error record is unchanged");
	assertAllowlisted(first);

	assert.equal((await run.state.worker.request("new_session", {}, 30_000)).success, true);
	const second = (await run.state.worker.getState()).sessionFile!;
	await run.prompt("Fresh transcript.");
	assert.equal(run.requests(), 5, "fresh session may summarize");
	await run.prompt("Next turn fails.");
	assert.equal(run.requests(), 6);
	assert.equal((await run.state.worker.request("compact", {}, 30_000)).success, true);
	assert.equal(run.requests(), 7);
	assert.equal((await run.state.worker.request("new_session", {}, 30_000)).success, true);
	const third = (await run.state.worker.getState()).sessionFile!;
	await run.prompt("Third transcript.");
	assert.equal(run.requests(), 8);
	assert.equal(run.remaining(), 0);
	assert.ok(hasAssistantText(third, "E3-FRESH-DONE"));
	const two = observations(second);
	assert.deepEqual(two.map((record) => [record.phase, record.reason ?? record.closedBy, record.nextInputUnavailable ?? null]), [
		["start", "threshold", null], ["end", "next_usage", "next_response_failed"], ["start", "manual", null], ["end", "session_replaced", "no_next_usage"],
	]);
	assert.deepEqual(observations(third), [], "replacement leaves no stale pending state");
	assertAllowlisted(second);
});

/**
 * E3 fixtures: the 28 L3 compactions (state/artifacts/cp-xvq8/report.md "All recorded compactions"), tokensBefore →
 * next input. Historical trigger/settings/retained estimates are unrecorded; terminal rows have no next usage: unknown.
 */
const E3: ReadonlyArray<readonly [string, number, number | null]> = [
	["S04:119", 53401, 49666], ["S04:122", 49977, 49785], ["S04:125", 49935, 49493], ["S04:128", 49885, 49899],
	["S04:131", 50412, 50203], ["S04:134", 50594, 49959], ["S04:139", 50593, 48739], ["S04:150", 53869, 50272],
	["S04:157", 51135, 50292], ["S04:161", 51720, 50498], ["S04:166", 51217, 50532], ["S04:173", 51354, 51569],
	["S04:177", 51743, 49006], ["S04:200", 53116, 51715], ["S04:204", 52691, 52005], ["S04:207", 52588, 51696],
	["S04:214", 52215, 52032], ["S04:217", 52260, 51932], ["S04:222", 52490, 52436], ["S04:225", 52621, 52381],
	["S04:228", 52876, 52356], ["S04:231", 52811, 52329], ["S04:240", 53364, null],
	["S12:81", 46507, 44131], ["S12:92", 49772, 42110], ["S12:101", 44340, null],
	["S17:225", 183915, 50225], ["S33:208", 184348, 51943],
];

test("E3 telemetry: 28 historical compactions keep terminal unknowns and distinguish useful reductions", () => {
	assert.equal(E3.length, 28);
	const ratio = ([, before, next]: readonly [string, number, number | null]) => (next === null ? null : next / before);
	assert.deepEqual(E3.filter((row) => ratio(row) === null).map(([id]) => id), ["S04:240", "S12:101"], "terminal rows stay unknown, never zero");
	assert.deepEqual(E3.filter((row) => (ratio(row) ?? 1) < 0.5).map(([id]) => id), ["S17:225", "S33:208"], "only the controls are useful reductions");
	assert.ok(E3.filter(([id]) => /^S(04|12):/.test(id)).every((row) => ratio(row) === null || ratio(row)! > 0.8), "S04/S12 retain over 80% of input");
	assert.deepEqual(E3.filter(([, before, next]) => next !== null && next > before).map(([id]) => id), ["S04:128", "S04:173"], "next input grew");
});
