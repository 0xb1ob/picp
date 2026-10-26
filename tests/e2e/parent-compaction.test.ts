import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { frameBatch } from "../../src/parent-outbox.ts";
import { buildPiArgs, COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT, startRpc, type ScriptStep, waitFor } from "../harness/index.ts";

const quote = "Add S24 Notice A, S24 Notice B and S24 Notice C schedules.";

const fireSchedules: ScriptStep = { kind: "tool_calls", calls: [0, 1, 2].map((index) => ({ name: "cp_schedule", args: (request: { body: Record<string, unknown> }) => {
	const ids = [...new Set([...JSON.stringify(request.body.messages).matchAll(/\bsch-[0-9a-f]{6}\b/g)].map((match) => match[0]))];
	assert.equal(ids.length, 3, JSON.stringify(request.body.messages));
	return { action: "run_now", id: ids[index] };
} })), usage: { prompt_tokens: 1000, completion_tokens: 1 } };
const settledReply: ScriptStep = { kind: "text", text: "S24 parent work settled.", usage: { prompt_tokens: 1000, completion_tokens: 1 } };
const wakeReply: ScriptStep = { kind: "text", text: "S24 schedule wakes answered." };
const busyRound: ScriptStep = { kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }], usage: { prompt_tokens: 1000, completion_tokens: 1 } };
async function openParent(t: TestContext, threshold: number | null, mode: "rpc" | "json", ...tails: ScriptStep[][]) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "S24 fixture" } });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: threshold }));
	const provider = await MockProvider.start();
	const initial: ScriptStep[] = [
		{ kind: "tool_calls", calls: ["A", "B", "C"].map((tag) => ({ name: "cp_schedule", args: {
			action: "add", name: `S24 Notice ${tag}`, project: "demo", manual: true, title: `S24 Notice ${tag}`,
			kind: "ship", delivery: "pr", operator_quote: quote, limits: {},
		} })) },
		busyRound,
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 2000)'" } }], usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		fireSchedules, settledReply,
	];
	const models = tails.map((tail, index) => provider.addScript(`s24-parent-${index}`, [...(index === 0 ? initial : []), ...tail], { onExhausted: "repeat" }));
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const child = startRpc({ cwd: home.path, mode,
		env: { ...agent.env, CP_HOME: home.path, CP_PARENT_COMPACT_HOLD_SECONDS: "5" },
		args: buildPiArgs({ cwd: home.path, model: models[0], extensions: [COMMAND_POST_EXTENSION],
			extraArgs: mode === "json" ? ["--print", quote] : [] }) });
	t.after(async () => { await child.close(); await post.shutdown(); agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	return { home: home.path, child, provider, models, post, settings: join(home.path, LAYOUT.data, "parent.json"), log: join(home.path, LAYOUT.state, "daemon.log"),
		wakes: () => child.records().filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "cp-schedule") };
}

test("S24 parent: schedule wakes hold in order until manual compaction finishes", { timeout: 90_000 }, async (t) => {
	const { child, log, wakes } = await openParent(t, 500, "rpc", [{ kind: "text", text: "S24 parent compact summary." }, wakeReply]);
	child.send({ type: "prompt", id: "schedules", message: quote });
	await waitFor(() => existsSync(log) ? readFileSync(log, "utf8") : "", (text) => text.includes("hold engaged phase=busy"), { timeoutMs: 20_000, what: "busy parent hold before operator steering" });
	const operatorQuestion = frameBatch([{ id: "ps-20300101000000-0000000a", text: "S24 operator question: preserve these schedule notices." }]);
	child.send({ type: "steer", id: "operator-question", message: operatorQuestion });
	const steered = await child.waitFor((r) => r.type === "response" && r.id === "operator-question", 10_000);
	assert.equal(steered.success, true, JSON.stringify(steered));
	await child.waitFor((r) => r.type === "agent_settled", 30_000);
	const toolEnds = child.records().filter((r) => r.type === "tool_execution_end" && r.toolName === "cp_schedule");
	assert.equal(toolEnds.length, 6, JSON.stringify(toolEnds));
	assert.ok(existsSync(log));
	assert.match(readFileSync(log, "utf8"), /hold engaged phase=busy/);
	assert.equal(wakes().length, 0);
	assert.ok(child.records().some((r) => r.type === "message_start" && (r.message as { role?: string })?.role === "user" && JSON.stringify(r.message).includes("S24 operator question:")));
	child.send({ type: "compact", id: "compact" });
	const result = await child.waitFor((r) => r.type === "response" && r.id === "compact", 30_000);
	assert.equal(result.success, true, JSON.stringify(result));
	await child.waitFor((r) => r.type === "message_start" && wakes().length === 3, 30_000);
	assert.deepEqual(wakes().map((r) => /S24 Notice ([ABC])/.exec(JSON.stringify(r.message))?.[1]), ["A", "B", "C"]);
	assert.match(readFileSync(log, "utf8"), /hold released reason=compacted held=3/);
});


/**
 * These PR runs dispatch no workers, so the test closes them from this process, each in one write with its result card
 * already delivered: the parent's 30 s result sync then never rewrites schedule-runs.json and cannot revert a closure.
 */
function closeOpenRuns(f: Awaited<ReturnType<typeof openParent>>): void {
	const at = isoTimestamp();
	for (const run of f.post.mandates.scheduleRuns.runs().filter((run) => run.phase !== "closed")) {
		f.post.mandates.scheduleRuns.editRun(run.id, (row) => Object.assign(row, { phase: "closed", outcome: "refused", closed_at: at,
			result: { source_key: `${run.id}:fixture`, job_id: null, generation: null, outcome: "refused", headline: "S24 fixture close",
				at, links: [], answer_id: null, delivered_at: at } }));
	}
}

async function phase(f: Awaited<ReturnType<typeof openParent>>, index: number) {
	closeOpenRuns(f);
	const [provider, modelId] = f.models[index]!.split("/");
	f.child.send({ type: "set_model", id: `model-${index}`, provider, modelId });
	const model = await f.child.waitFor((r) => r.type === "response" && r.id === `model-${index}`, 10_000);
	assert.equal(model.success, true, JSON.stringify(model));
	const from = f.child.records().length;
	f.child.send({ type: "prompt", id: `phase-${index}`, message: index === 0 ? quote : `S24 phase ${index}.` });
	await f.child.waitFor((r) => r.type === "agent_settled" && f.child.records().indexOf(r) >= from, 30_000);
}

async function drained(f: Awaited<ReturnType<typeof openParent>>, count: number) {
	await f.child.waitFor((r) => r.type === "agent_settled" && f.wakes().length >= count && f.child.records().indexOf(r) >
		f.child.records().findLastIndex((record) => record.type === "message_start" && (record.message as { customType?: string })?.customType === "cp-schedule"), 30_000);
}

test("S24 parent: failures and expiries release wakes, three disable, compaction reenables, low context releases", { timeout: 110_000 }, async (t) => {
	const f = await openParent(t, 500, "rpc",
		[{ kind: "error", status: 400, message: "S24 manual summary unavailable" }, wakeReply],
		[busyRound, fireSchedules, settledReply, busyRound, settledReply, wakeReply],
		[busyRound, fireSchedules, settledReply, { kind: "hang", ms: 12000 }, busyRound, fireSchedules, settledReply, wakeReply],
		[{ kind: "tool_calls", calls: [{ name: "cp_schedule", args: { action: "list" } }] },
			busyRound, fireSchedules, settledReply, wakeReply]);
	await phase(f, 0);
	assert.equal(f.wakes().length, 0);
	f.child.send({ type: "compact", id: "failed" });
	const failed = await f.child.waitFor((r) => r.type === "response" && r.id === "failed", 30_000);
	assert.equal(failed.success, false);
	await drained(f, 3);
	assert.match(readFileSync(f.log, "utf8"), /hold released reason=failed held=3/);
	await phase(f, 1);
	assert.equal(f.wakes().length, 3);
	const from = f.child.records().length;
	f.child.send({ type: "prompt", id: "unheld-start", message: "S24 starting another run must not release held wakes." });
	await f.child.waitFor((r) => r.type === "agent_settled" && f.child.records().indexOf(r) >= from, 10_000);
	assert.equal(f.wakes().length, 3);
	await drained(f, 6);
	assert.match(readFileSync(f.log, "utf8"), /hold released reason=start_timeout held=3/);
	await phase(f, 2);
	assert.equal(f.wakes().length, 6);
	closeOpenRuns(f);
	const before = (readFileSync(f.log, "utf8").match(/hold engaged/g) ?? []).length;
	f.child.send({ type: "compact", id: "cap" });
	await waitFor(() => readFileSync(f.log, "utf8"), (text) => /hold disabled failures=3/.test(text), { timeoutMs: 10_000, what: "five-second cap disables the third failed hold" });
	assert.match(readFileSync(f.log, "utf8"), /hold released reason=cap_timeout held=3/);
	assert.equal(f.child.records().some((r) => r.type === "response" && r.id === "cap"), false);
	await drained(f, 12);
	assert.equal((readFileSync(f.log, "utf8").match(/hold engaged/g) ?? []).length, before);
	const completed = await f.child.waitFor((r) => r.type === "response" && r.id === "cap", 20_000);
	assert.equal(completed.success, true, JSON.stringify(completed));
	await phase(f, 3);
	assert.equal(f.wakes().length, 12);
	assert.equal((readFileSync(f.log, "utf8").match(/hold engaged/g) ?? []).length, before + 1);
	writeFileSync(f.settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
	f.child.send({ type: "prompt", id: "under", message: "S24 settle below the raised threshold." });
	await drained(f, 15);
	assert.match(readFileSync(f.log, "utf8"), /hold released reason=not_over held=3/);
});


test("S24 parent: low, disabled and non-headless contexts deliver schedule wakes immediately", { timeout: 90_000 }, async (t) => {
	for (const mode of ["low", "disabled", "non-headless"] as const) {
		await t.test(mode, async (t) => {
			const f = await openParent(t, mode === "low" ? 100_000_000 : mode === "disabled" ? null : 500,
				mode === "non-headless" ? "json" : "rpc", [wakeReply]);
			if (mode !== "non-headless") f.child.send({ type: "prompt", id: "immediate", message: quote });
			else f.child.endInput();
			await f.child.waitFor((r) => r.type === "message_start" && f.wakes().length === 3, 30_000);
			assert.equal((existsSync(f.log) ? readFileSync(f.log, "utf8").match(/hold engaged/g) ?? [] : []).length, 0);
			assert.equal(f.child.records().filter((r) => r.type === "compaction_start").length, 0);
		});
	}
});


test("S24 parent: length stops cancel threshold compaction without disabling later manual and normal compaction", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 200000 }));
	const provider = await MockProvider.start();
	const length: ScriptStep = { kind: "text", text: "x".repeat(40), finishReason: "length", usage: { prompt_tokens: 127598, completion_tokens: 128000 } };
	const model = provider.addScript("s24-parent-length", [{ kind: "text", text: "S24 compactable seed." }, length, length, length,
		{ kind: "text", text: "S24 manual summary after length stops." }], { onExhausted: "repeat" });
	const over = provider.addScript("s24-parent-over", [{ kind: "text", text: "S24 ordinary over-threshold answer.", usage: { prompt_tokens: 210000, completion_tokens: 1 } },
		{ kind: "text", text: "S24 normal threshold summary." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const child = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, CP_PARENT_COMPACT_HOLD_SECONDS: "5" },
		args: buildPiArgs({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION] }) });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	for (const index of [0, 1, 2, 3]) {
		const from = child.records().length;
		child.send({ type: "prompt", id: `length-${index}`, message: `S24 work ${index}.` });
		await child.waitFor((r) => r.type === "agent_settled" && child.records().indexOf(r) >= from, 30_000);
		assert.equal(provider.requests("s24-parent-length").length, index + 1);
	}
	const log = join(home.path, LAYOUT.state, "daemon.log");
	const before = readFileSync(log, "utf8");
	assert.equal((before.match(/threshold_compaction_cancelled/g) ?? []).length, 5);
	assert.equal((before.match(/hold skipped_length_stop/g) ?? []).length, 3);
	assert.doesNotMatch(before, /hold engaged|hold disabled|hold released reason=failed/);
	child.send({ type: "compact", id: "manual-length" });
	const manual = await child.waitFor((r) => r.type === "response" && r.id === "manual-length", 30_000);
	assert.equal(manual.success, true, JSON.stringify(manual));
	const [providerId, modelId] = over.split("/");
	child.send({ type: "set_model", id: "over-model", provider: providerId, modelId });
	await child.waitFor((r) => r.type === "response" && r.id === "over-model", 10_000);
	const from = child.records().length;
	child.send({ type: "prompt", id: "over", message: "S24 a normal context can still compact." });
	await child.waitFor((r) => r.type === "agent_settled" && child.records().indexOf(r) >= from, 30_000);
	assert.match(readFileSync(log, "utf8"), /hold engaged/);
	assert.ok(provider.requests("s24-parent-over").length >= 2);
	assert.equal((readFileSync(log, "utf8").match(/threshold_compaction_cancelled/g) ?? []).length, 5);
});
