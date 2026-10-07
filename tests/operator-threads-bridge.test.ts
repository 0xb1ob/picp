/**
 * cp-xmw2 S2: the optional `thread` on `cp_parent answer` and `cp_parent ask` files the ans-/ask- id in
 * `state/operator/threads.jsonl`. Hermetic: scratch homes, no model, no auth.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import bridgeExtension, { BRIDGE_TOOL, saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { fileUnderThread, threadTag } from "../src/operator-threads.ts";
import { operatorThreadsFile, readThreads } from "../src/viewer/control-files.ts";
import { decisionsScreen } from "../src/viewer/decision-views.ts";
import { createScratchHome } from "./harness/index.ts";

type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> }> };

async function bench(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	await new FleetStore({ home: home.path }).add({
		job_id: "cp-ans", project: "demo", kind: "research", delivery: "answer", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(),
		worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "planner", role: "planner", model: "mock/model", started_at: isoTimestamp() },
		worktree: join(home.path, "wt"), branch: "cp-ans", dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
	});
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home.path, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const tools = new Map<string, Tool>();
	bridgeExtension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never), registerCommand: () => {}, on: () => {}, sendMessage: () => {} } as never);
	const stateDir = join(home.path, LAYOUT.state);
	const read = (name: string) => existsSync(join(stateDir, "operator", name)) ? readFileSync(join(stateDir, "operator", name), "utf8") : null;
	const lines = () => (read("threads.jsonl") ?? "").split("\n").filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>);
	return { home: home.path, stateDir, tool: tools.get(BRIDGE_TOOL)!, read, lines };
}

const answer = { action: "answer", project: "demo", question: "Does it work?", answer: "Yes." };
const ask = { project: "demo", question: "A or B?", options: [{ label: "A", consequence: "does a" }, { label: "B", consequence: "does b" }], recommendation: "A" };

test("threadTag normalizes or throws naming the rule", () => {
	assert.equal(threadTag("  Billing Bug "), "billing-bug");
	assert.throws(() => threadTag("bad tag!"), /thread must be a tag \(1-32 of a-z 0-9 -, first a letter or digit\)/);
	assert.throws(() => threadTag("x".repeat(33)), /thread must be a tag/);
});

test("answer with a thread posts, then writes open + bind once; a second answer with the tag writes only a bind", async (t) => {
	const b = await bench(t);
	const first = await b.tool.execute("a", { ...answer, thread: "Billing" });
	assert.equal(first.isError, undefined);
	assert.equal(first.details.state, "posted");
	const filed = first.details.thread as { tag: string; id: string; error: null };
	assert.equal(filed.tag, "billing");
	assert.match(filed.id, /^th-[a-f0-9]{12}$/);
	assert.equal(filed.error, null);
	assert.match(first.content[0]!.text, new RegExp(`filed under thread billing \\(${filed.id}\\)`));
	assert.deepEqual(b.lines().map((line) => [line.type, line.by, line.peer]), [["open", "bridge", null], ["bind", "bridge", null]]);
	assert.deepEqual(b.lines()[1]!.ref, { kind: "answer", id: first.details.id });
	assert.equal(b.lines()[0]!.tag, "billing");

	const second = await b.tool.execute("b", { ...answer, question: "And now?", thread: "billing" });
	assert.equal((second.details.thread as { id: string }).id, filed.id);
	assert.deepEqual(b.lines().map((line) => line.type), ["open", "bind", "bind"]);
	assert.deepEqual(b.lines()[2]!.ref, { kind: "answer", id: second.details.id });
	assert.equal(readThreads(b.stateDir).threads[0]!.refs.length, 2);

	const plain = await b.tool.execute("c", { ...answer, question: "No thread?" });
	assert.equal(plain.details.thread, undefined);
	assert.equal(b.lines().length, 3, "no thread param: nothing filed");
});

test("an invalid tag throws before any journal is written", async (t) => {
	const b = await bench(t);
	await b.tool.execute("seed", { ...answer, thread: "seed" });
	await b.tool.execute("seed-ask", { action: "ask", ask, thread: "seed" });
	const before = [b.read("answers.jsonl"), b.read("asks.jsonl"), b.read("threads.jsonl")];
	for (const params of [{ ...answer, question: "Other?", thread: "bad tag!" }, { action: "ask", ask, thread: "-x" }]) {
		const refused = await b.tool.execute("bad", params);
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text, /thread must be a tag/);
	}
	assert.deepEqual([b.read("answers.jsonl"), b.read("asks.jsonl"), b.read("threads.jsonl")], before);
});

test("a duplicate job_id answer writes no bind and says the first id was not re-filed", async (t) => {
	const b = await bench(t);
	const first = await b.tool.execute("a", { ...answer, job_id: "cp-ans" });
	assert.equal(first.details.state, "posted");
	const again = await b.tool.execute("b", { ...answer, job_id: "cp-ans", thread: "billing" });
	assert.equal(again.details.state, "duplicate");
	assert.equal(again.details.thread, undefined);
	assert.match(again.content[0]!.text, new RegExp(`thread billing: ${first.details.id} was not re-filed`));
	assert.equal(b.read("threads.jsonl"), null, "nothing written");
});

test("ask with a thread binds the ask id; asks.jsonl keeps today's keys; the result text is JSON with id and state", async (t) => {
	const b = await bench(t);
	const opened = await b.tool.execute("q", { action: "ask", ask, thread: "Release Plan" });
	assert.equal(opened.isError, undefined);
	const parsed = JSON.parse(opened.content[0]!.text) as { id: string; state: string; thread: { tag: string; id: string; error: null } };
	assert.match(parsed.id, /^ask-[a-f0-9]+$/);
	assert.equal(parsed.state, "open");
	assert.equal(parsed.thread.tag, "release-plan");
	assert.deepEqual(opened.details.thread, parsed.thread);
	assert.deepEqual(b.lines()[1]!.ref, { kind: "ask", id: parsed.id });
	const askLine = JSON.parse(b.read("asks.jsonl")!.trim()) as Record<string, unknown>;
	assert.equal("thread" in askLine, false);
	const screen = decisionsScreen({ home: b.home, stateDir: b.stateDir });
	assert.ok(JSON.stringify(screen.items).includes(parsed.id), "the Decisions screen still lists the ask");
});

test("an unwritable threads journal: the answer and the ask still land, the result says NOT filed, isError stays false", async (t) => {
	const b = await bench(t);
	mkdirSync(operatorThreadsFile(b.stateDir), { recursive: true });
	const posted = await b.tool.execute("a", { ...answer, thread: "billing" });
	assert.equal(posted.isError, undefined);
	assert.equal(posted.details.state, "posted");
	assert.match(posted.content[0]!.text, /; thread billing NOT filed: /);
	assert.deepEqual({ ...(posted.details.thread as object), error: "x" }, { tag: "billing", id: null, error: "x" });
	assert.match(b.read("answers.jsonl")!, new RegExp(String(posted.details.id)));
	const opened = await b.tool.execute("q", { action: "ask", ask, thread: "billing" });
	assert.equal(opened.isError, undefined);
	const parsed = JSON.parse(opened.content[0]!.text) as { id: string; thread: { id: null; error: string } };
	assert.equal(parsed.thread.id, null);
	assert.ok(parsed.thread.error.length > 0);
	assert.match(b.read("asks.jsonl")!, new RegExp(parsed.id));
});

test("fileUnderThread never throws on a bad ref and names the failure", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const filed = fileUnderThread(join(home.path, LAYOUT.state), "billing", { kind: "answer", id: "nope" });
	assert.equal(filed.details.id, null);
	assert.match(filed.note, /thread billing NOT filed: thread ref/);
});

test("thread_bind files job refs locally, normalizes, repeats without writes, and moves a job to the newest thread", async (t) => {
	const b = await bench(t);
	const params = { action: "thread_bind", thread: "  Billing Bug ", job_ids: ["cp-one", "other_TWO-2"] };
	const bound = await b.tool.execute("bind", params);
	assert.equal(bound.isError, undefined);
	assert.equal(bound.details.state, "filed");
	assert.deepEqual(b.lines().map((line) => [line.type, line.by, line.peer]), [["open", "bridge", null], ["bind", "bridge", null], ["bind", "bridge", null]]);
	assert.deepEqual(b.lines().slice(1).map(line => line.ref), [{ kind: "job", id: "cp-one" }, { kind: "job", id: "other_TWO-2" }]);
	const journal = readThreads(b.stateDir);
	assert.equal(journal.skipped, 0);
	assert.equal(journal.refs.get("job:cp-one"), journal.threads[0]!.id);
	assert.equal(journal.threads[0]!.tag, "billing-bug");
	await b.tool.execute("repeat", params);
	assert.equal(b.lines().length, 3);
	await b.tool.execute("move", { action: "thread_bind", thread: "ops", job_ids: ["cp-one"] });
	assert.equal(readThreads(b.stateDir).refs.get("job:cp-one"), readThreads(b.stateDir).threads[1]!.id);
	assert.equal(b.read("asks.jsonl"), null);
	assert.equal(b.read("answers.jsonl"), null);
	assert.equal(existsSync(join(b.stateDir, "parent.lock")), false, "no parent started for bookkeeping");
});

test("thread_bind validates the whole request before writes; a journal failure is named without throwing", async (t) => {
	const b = await bench(t);
	for (const params of [
		{ thread: "bad!", job_ids: ["cp-one"] }, { job_ids: ["cp-one"] },
		{ thread: "ok" }, { thread: "ok", job_ids: [] }, { thread: "ok", job_ids: "cp-one" },
		...[["cp-one", "../bad"], ["cp-one", 7], ["cp-one", ""], ["cp-one", "x".repeat(129)]].map(job_ids => ({ thread: "ok", job_ids })),
	]) {
		const refused = await b.tool.execute("bad", { action: "thread_bind", ...params });
		assert.equal(refused.isError, true, JSON.stringify(params));
		assert.equal(b.read("threads.jsonl"), null, "all fields checked before the first bind");
	}
	mkdirSync(operatorThreadsFile(b.stateDir), { recursive: true });
	const failed = await b.tool.execute("blocked", { action: "thread_bind", thread: "ok", job_ids: ["cp-one"] });
	assert.equal(failed.isError, undefined);
	assert.equal(failed.details.state, "unfiled");
	assert.match(failed.content[0]!.text, /cp-one.*thread ok NOT filed: .*threads\.jsonl/);
	assert.deepEqual(failed.details.bindings, [{ job_id: "cp-one", tag: "ok", id: null, error: (failed.details.bindings as Array<{ error: string }>)[0]!.error }]);
});
