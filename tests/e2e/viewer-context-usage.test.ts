/**
 * Behavior 19 (P19b): context-window usage as `bin/cp-view` serves it on a scratch home: pi session files and the
 * model windows the parent records, read back through /api/sessions, /api/jobs and /api/map and the served app in its
 * linkedom tab (DOM and text only, no layout or pixels).
 */
import assert from "node:assert/strict";
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { recordModelWindows } from "../../src/model-windows.ts";
import { SCAN_BYTES } from "../../src/viewer/context-usage.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { type Context, type Json, viewer, write } from "../harness/conversations.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const reply = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => line({ type: "message", timestamp: "2026-09-27T10:00:00.000Z", message: { role: "assistant", provider: "openai", model: "gpt-x", content: [], usage, ...extra } });
const USAGE = { input: 1_000, output: 200, cacheRead: 80_000, cacheWrite: 3_000 };
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const change = line({ type: "model_change", provider: "anthropic", modelId: "claude-x" }) + line({ type: "thinking_level_change", thinkingLevel: "low" }) + line({ type: "thinking_level_change", thinkingLevel: "high" });
const filler = line({ type: "message", message: { role: "user", content: "x".repeat(1_000) } }).repeat(Math.ceil(SCAN_BYTES / 1_000) + 100);
/** pi's model registry as the parent records it at session start; a model without a window is skipped. */
const REGISTRY = { getAll: () => [{ provider: "openai", id: "gpt-x", contextWindow: 272_000 }, { provider: "openai", id: "w100", contextWindow: 100_000 }, { provider: "anthropic", id: "no-window" }] };

type Seed = { stateDir: string; home: string; sessions: string; file(name: string, body: string): string };
/**
 * A viewer whose fleet holds one held worker `cp-<name>` per `workers` entry, its session file `<name>.jsonl`;
 * `windows: false` skips the parent's model-window record.
 */
async function ctxViewer(t: Context, workers: Record<string, string>, { windows = true, seed }: { windows?: boolean; seed?: (s: Seed) => void } = {}) {
	let at!: Seed;
	const d = await viewer(t, { seed: (stateDir, home) => {
		const sessions = join(stateDir, "sessions");
		at = { stateDir, home, sessions, file: (name, body) => { const path = join(sessions, `${name}.jsonl`); write(path, body); return path; } };
		if (windows) recordModelWindows(home, REGISTRY);
		write(join(stateDir, "fleet.json"), { jobs: Object.entries(workers).map(([name, body]) => ({ job_id: `cp-${name}`, project: "demo", phase: "held", worker: { session_file: at.file(name, body), model: "openai/gpt-x" } })) });
		seed?.(at);
	} });
	const view = async (path: string) => (await d.get(path)).body as Json;
	const workerOf = async (id: string) => ((await view(`/api/sessions?view=workers&id=${id}`)).workers as Json[]).find((w) => w.id === id)!;
	const ctx = async (id: string) => (await workerOf(id)).context as Json;
	return { d, at, view, workerOf, ctx };
}

test("P19-ctx-levels: a worker's context is ok below 70% of its window, warn from 70%, high from 90%", { timeout: 120_000 }, async (t) => {
	const usage = (input: number) => reply({ ...ZERO, input }, { model: "w100" });
	const { ctx } = await ctxViewer(t, { a: usage(69_999), b: usage(70_000), c: usage(89_999), d: usage(90_000), e: usage(120_000) });
	const levels = [];
	for (const id of ["cp-a", "cp-b", "cp-c", "cp-d", "cp-e"]) levels.push((await ctx(id)).level);
	assert.deepEqual(levels, ["ok", "warn", "warn", "high", "high"], "69.999% ok, 70% warn, 89.999% warn, 90% and 120% high");
});

test("P19-ctx-known: the last counted assistant usage against the recorded window; totalTokens wins", { timeout: 120_000 }, async (t) => {
	const replies = reply({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }) + reply(USAGE) + reply({ ...ZERO, input: 9_999_999 }, { stopReason: "aborted" }) + reply(ZERO);
	const { at, ctx } = await ctxViewer(t, { one: replies, other: reply(USAGE, { provider: "anthropic", model: "no-window" }) });
	assert.match(readFileSync(join(at.stateDir, "model-windows.json"), "utf8"), /recorded_at/, "the parent's record is dated");
	const usage = await ctx("cp-one");
	assert.equal(usage.tokens, 84_200, "input + output + cacheRead + cacheWrite; aborted and all-zero replies skipped");
	assert.deepEqual([usage.window, Math.round(usage.percent as number), usage.level, usage.reason, usage.model], [272_000, 31, "ok", null, "openai/gpt-x"]);
	appendFileSync(join(at.sessions, "one.jsonl"), reply({ ...USAGE, totalTokens: 250_000 }));
	const high = await ctx("cp-one");
	assert.deepEqual([high.tokens, high.level], [250_000, "high"], "totalTokens wins when present, as in pi");
	const other = await ctx("cp-other");
	assert.deepEqual([other.percent, other.reason], [null, "no context window known for anthropic/no-window"], "a model without a window is not recorded");
});

test("P19-ctx-unknown: each unknown names its reason, never 0", { timeout: 120_000 }, async (t) => {
	const compacted = reply(USAGE) + line({ type: "compaction", timestamp: "2026-09-27T11:00:00.000Z", tokensBefore: 84_200 });
	const { at, ctx, view } = await ctxViewer(t, { empty: line({ type: "session", id: "x" }) + line({ type: "message", message: { role: "user", content: "hi" } }), compacted }, {
		seed: ({ sessions, home }) => write(operatorSessionsFile(sessions), line({ at: "2026-09-27T08:00:00.000Z", session_file: join(home, "gone.jsonl") })),
	});
	const none = await ctx("cp-empty");
	assert.deepEqual([none.tokens, none.percent, none.level, none.reason], [null, null, null, "no assistant reply yet"]);
	const after = await ctx("cp-compacted");
	assert.deepEqual([after.tokens, after.reason, after.last_compact_at], [null, "no assistant reply since the last compaction", "2026-09-27T11:00:00.000Z"]);
	appendFileSync(join(at.sessions, "compacted.jsonl"), reply({ ...USAGE, cacheRead: 10_000 }));
	const replied = await ctx("cp-compacted");
	assert.equal(replied.tokens, 14_200, "a reply after the compaction is trusted again");
	assert.equal(replied.last_compact_at, "2026-09-27T11:00:00.000Z", "the last compaction stays shown");
	assert.equal(((await view("/api/sessions?view=you")).operator_context as Json).reason, "session file missing");

	const bare = await ctxViewer(t, { one: reply(USAGE) }, { windows: false });
	assert.match(String((await bare.ctx("cp-one")).reason), /model windows not recorded yet/);
});

test("P19-ctx-views: Sessions carries operator, parent and worker context; Jobs and Map carry the worker's; the app shows them", { timeout: 120_000 }, async (t) => {
	const { d, view } = await ctxViewer(t, { one: reply({ ...USAGE, cacheRead: 200_000 }) }, { seed: ({ sessions, home }) => {
		write(join(sessions, "cp-parent-context.json"), { contextTokens: 136_000, lastCompactAt: "2026-09-27T09:00:00.000Z" });
		write(join(sessions, "cp-parent-control.json"), { model: "openai/gpt-x" });
		write(join(home, "operator.jsonl"), line({ type: "session", id: "op" }));
		write(operatorSessionsFile(sessions), line({ at: "2026-09-27T08:00:00.000Z", session_file: join(home, "operator.jsonl") }));
	} });
	const sessions = await view("/api/sessions?view=workers&id=cp-one");
	const worker = ((sessions.workers as Json[])[0]!.context as Json), parent = ((sessions.parent as Json).context as Json);
	assert.deepEqual([worker.level, worker.tokens], ["warn", 204_200], "204,200 / 272,000 is 75%");
	assert.deepEqual([parent.tokens, parent.percent, parent.last_compact_at], [136_000, 50, "2026-09-27T09:00:00.000Z"], "the parent uses its recorded contextTokens");
	assert.equal((sessions.operator_context as Json).reason, "no assistant reply yet");
	assert.equal((((await view("/api/jobs")).jobs as Json[]).find((j) => j.id === "cp-one")!.context as Json).tokens, 204_200);
	assert.equal((((await view("/api/map")).nodes as Json[]).find((n) => n.id === "cp-one")!.context as Json).tokens, 204_200);

	const tab = await d.open("#sessions?view=workers&id=cp-one");
	await tab.find(".session-ctx.ctx-warn");
	const titles = tab.$$(".session-ctx").map((s) => s.getAttribute("title"));
	assert.ok(titles.includes("ctx 204K / 272K · 75%") && titles.includes("ctx 136K / 272K · 50%"), `worker and parent figures: ${titles}`);
	assert.ok(titles.includes("context n/a"), "the operator's unknown context reads n/a");
	assert.doesNotMatch(tab.root.innerHTML, /style=/);
	const you = await d.open("#sessions?view=you");
	const heading = await you.find(".session-heading .session-ctx");
	assert.deepEqual([heading.className, heading.getAttribute("title"), heading.textContent], ["session-ctx ctx-unknown", "context n/a", "ctx n/a"], "the heading shows ctx n/a, never 0");
	const jobs = await d.open("#jobs");
	const chip = await jobs.find(".job-context > .ctx-chip.ctx-warn.ctx-compact");
	assert.match(chip.textContent ?? "", /ctx 204K \/ 272K · 75%/);
	assert.match(jobs.$('progress[aria-label="Context window used"]')!.getAttribute("value") ?? "", /^75\./);
});

test("P19-ctx-model: the latest model_change and thinking_level_change, else the last assistant model; unknown model explicit, unknown thinking omitted", { timeout: 120_000 }, async (t) => {
	const { d, at, view, ctx } = await ctxViewer(t, { fallback: reply(ZERO, { stopReason: "error" }) }, { seed: ({ sessions, home }) => {
		write(join(sessions, "cp-parent-context.json"), { contextTokens: 1_000 });
		write(join(sessions, "cp-parent-control.json"), { model: "openai/gpt-x" });
		write(join(home, "operator.jsonl"), change);
		write(operatorSessionsFile(sessions), line({ at: "2026-09-27T08:00:00.000Z", session_file: join(home, "operator.jsonl") }));
	} });
	const fell = await ctx("cp-fallback");
	assert.deepEqual([fell.model, fell.thinking], ["openai/gpt-x", null], "no model_change: an errored last reply still names the model that ran");
	const you = await view("/api/sessions?view=you");
	assert.deepEqual([(you.operator_context as Json).model, (you.operator_context as Json).thinking], ["anthropic/claude-x", "high"], "the latest of each");
	const parent = (you.parent as Json).context as Json;
	assert.deepEqual([parent.model, parent.thinking], ["openai/gpt-x", null], "the parent falls back to the bridge's model");
	const models = async (hash: string) => { const tab = await d.open(hash); await tab.find(".session-model"); return tab.$$(".session-model").map((s) => s.textContent ?? ""); };
	const first = await models("#sessions?view=you");
	assert.ok(first.includes("claude-x · high"), `operator model · thinking: ${first}`);
	assert.ok(first.some((m) => /^gpt-x · (?:no )?recent activity$/.test(m)), `no thinking, no separator: ${first}`);

	write(join(at.sessions, "cp-parent.jsonl"), change);
	write(join(at.home, "operator.jsonl"), line({ type: "session", id: "op" }));
	const next = await view("/api/sessions?view=parent");
	assert.deepEqual([((next.parent as Json).context as Json).model, ((next.parent as Json).context as Json).thinking], ["anthropic/claude-x", "high"]);
	assert.deepEqual([(next.operator_context as Json).model, (next.operator_context as Json).thinking], [null, null]);
	const second = await models("#sessions?view=parent");
	assert.ok(second.some((m) => /^claude-x · high · (?:no )?recent activity$/.test(m)), `parent model · thinking: ${second}`);
	assert.ok(second.includes("model unknown"), `the operator's model is explicitly unknown: ${second}`);
});

test("P19-ctx-thinking: a worker's thinking comes from its session, else its routing (fleet, then status.json), else none", { timeout: 120_000 }, async (t) => {
	const job = (id: string, extra: Json, session?: string) => ({ job_id: id, project: "demo", phase: "waiting", ...extra, worker: { model: "openai/gpt-x", ...(session ? { session_file: session } : {}) } });
	const { d, at, workerOf, view } = await ctxViewer(t, {}, { seed: ({ stateDir, file }) => {
		write(join(stateDir, "fleet.json"), { jobs: [
			job("cp-a", { routing: { thinking: "low", inferred: false } }, file("a", line({ type: "thinking_level_change", thinkingLevel: "medium" }))),
			job("cp-b", { routing: { thinking: "high", inferred: false } }, file("b", line({ type: "session", id: "b" }))),
			job("cp-c", {}),
			job("cp-d", {}),
		] });
		write(join(stateDir, "runs", "cp-c", "status.json"), { routing: { thinking: "minimal", inferred: false } });
	} });
	const thinking = [];
	for (const id of ["cp-a", "cp-b", "cp-c", "cp-d"]) thinking.push((await workerOf(id)).thinking);
	assert.deepEqual(thinking, ["medium", "high", "minimal", undefined]);
	assert.equal((await view("/api/sessions?view=workers&id=cp-a")).subtitle, "gpt-x · medium");
	assert.equal((await view("/api/sessions?view=workers&id=cp-d")).subtitle, "gpt-x", "unknown thinking is omitted");
	const tab = await d.open("#sessions?view=workers&id=cp-a");
	await tab.find(".session-model");
	const metas = tab.$$(".session-model").map((s) => s.textContent);
	for (const meta of ["gpt-x · medium", "gpt-x · high", "gpt-x · minimal", "gpt-x"]) assert.ok(metas.includes(`${meta} · no run status`), `${meta}: ${metas}`);

	write(join(at.stateDir, "fleet.json"), { jobs: [job("cp-e", {}, at.file("e", change))] });
	assert.equal((await view("/api/sessions?view=workers&id=cp-e")).subtitle, "claude-x · high", "a model switched inside the session wins");
	const switched = await d.open("#sessions?view=workers&id=cp-e");
	await switched.find(".session-model");
	assert.deepEqual(switched.$$(".session-model").map((s) => s.textContent).filter((m) => m?.includes("no run status")), ["claude-x · high · no run status"]);
	assert.ok(!switched.$$("small").some((s) => /gpt-x/.test(s.textContent ?? "")), "the row and the subtitle agree");
});

test("P19-ctx-long: past SCAN_BYTES the head's model and thinking fill what the tail lacks; the tail wins", { timeout: 120_000 }, async (t) => {
	const head = line({ type: "session", id: "long" }) + line({ type: "model_change", provider: "anthropic", modelId: "claude-head" }) + line({ type: "thinking_level_change", thinkingLevel: "high" });
	const { at, ctx } = await ctxViewer(t, { long: head + filler }, { seed: ({ stateDir, file }) => {
		write(join(stateDir, "fleet.json"), { jobs: [
			{ job_id: "cp-long", project: "demo", phase: "held", worker: { session_file: join(stateDir, "sessions", "long.jsonl") } },
			{ job_id: "cp-plain", project: "demo", phase: "held", worker: { session_file: file("plain", line({ type: "session", id: "plain" }) + filler) } },
		] });
	} });
	assert.ok(statSync(join(at.sessions, "long.jsonl")).size > SCAN_BYTES);
	const headOnly = await ctx("cp-long");
	assert.deepEqual([headOnly.model, headOnly.thinking], ["anthropic/claude-head", "high"], "only the head records them");
	appendFileSync(join(at.sessions, "long.jsonl"), line({ type: "thinking_level_change", thinkingLevel: "low" }) + reply(USAGE));
	const tail = await ctx("cp-long");
	assert.deepEqual([tail.model, tail.thinking], ["openai/gpt-x", "low"], "the tail's thinking and assistant model beat the head");
	const plain = await ctx("cp-plain");
	assert.deepEqual([plain.model, plain.thinking, plain.reason], [null, null, "no assistant reply in the session's last 1 MiB"], "nothing recorded stays unknown");
});

test("P19-ctx-head-cache: an appended poll keeps the long session's head; a shrink or a replaced file reads it again", { timeout: 120_000 }, async (t) => {
	const body = (level: string) => line({ type: "session", id: "grow" }) + line({ type: "thinking_level_change", thinkingLevel: level }) + filler;
	const { at, ctx } = await ctxViewer(t, { grow: body("high") });
	const file = join(at.sessions, "grow.jsonl");
	assert.equal((await ctx("cp-grow")).thinking, "high");
	// Rewrite the head bytes in place (same length) and append: a re-read would see "xxxx", the kept head says "high".
	const fd = openSync(file, "r+"); writeSync(fd, "xxxx", readFileSync(file).indexOf('"high"') + 1); closeSync(fd);
	appendFileSync(file, line({ type: "message", message: { role: "user", content: "more" } }));
	assert.equal((await ctx("cp-grow")).thinking, "high", "append-only growth keeps the head without re-reading it");
	truncateSync(file, statSync(file).size - 2_000);
	assert.equal((await ctx("cp-grow")).thinking, "xxxx", "a shrink reads the head again");
	write(join(at.sessions, "grow.next.jsonl"), body("low"));
	renameSync(join(at.sessions, "grow.next.jsonl"), file);
	assert.equal((await ctx("cp-grow")).thinking, "low", "a replaced file (new inode) reads the head again");
});
