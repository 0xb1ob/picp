/**
 * cp-mxk4 PR1: `cp_parent answer` and the answers journal (`state/operator/answers.jsonl`). Hermetic: scratch homes,
 * no model, no auth. Secret-shaped test inputs are built at runtime so the patch carries no credential literal.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import bridgeExtension, { BRIDGE_TOOL, saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { OperatorAnswers } from "../src/operator-answers.ts";
import { appendAnswerLine } from "../src/viewer/control-audit.ts";
import { operatorAnswersFile, readAnswers } from "../src/viewer/control-files.ts";
import { createScratchHome } from "./harness/index.ts";

const ghShaped = `gh${"p"}_${"A".repeat(36)}`;
const keyHeader = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;

function job(home: string, jobId: string, over: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: jobId, project: "demo", kind: "research", delivery: "local", origin: DEFAULT_ORIGIN, phase: "held",
		worker: { pid: process.pid, session_id: "s", session_file: join(home, "s.jsonl"), profile: "planner", role: "planner", model: "mock/model", started_at: isoTimestamp() },
		worktree: join(home, "wt"), branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, ...(["held", "done"].includes(over.phase ?? "held") ? { reported_at: isoTimestamp() } : {}),
		...(over.phase === "failed" ? { failure: { class: "crash" as const, message: "died", at: isoTimestamp() } } : {}), ...over,
	};
}

async function bench(t: TestContext, jobs: Array<[string, Partial<FleetRecord>]> = []) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	for (const [id, over] of jobs) await fleet.add(job(home.path, id, over));
	const stateDir = join(home.path, LAYOUT.state);
	const answers = new OperatorAnswers(stateDir, { jobs: (id) => fleet.get(id) });
	return { home: home.path, stateDir, answers, file: operatorAnswersFile(stateDir), lines: () => readFileSync(operatorAnswersFile(stateDir), "utf8").split("\n").filter(Boolean) };
}

const input = { project: "demo", question: "Does it work?", answer: "Yes." };

test("post appends one posted line: ans- id, 0600 file, 0700 dir, a long question clipped to 500 chars", async (t) => {
	const b = await bench(t);
	const { state, answer } = b.answers.post({ ...input, question: "q".repeat(600), evidence_paths: ["state/runs/cp-1/artifact.md"] });
	assert.equal(state, "posted");
	assert.match(answer.id, /^ans-[a-f0-9]{12}$/);
	assert.equal(b.lines().length, 1);
	const line = JSON.parse(b.lines()[0]!);
	assert.deepEqual([line.type, line.by, line.id, line.job_id, line.evidence_paths], ["posted", "bridge", answer.id, null, ["state/runs/cp-1/artifact.md"]]);
	assert.equal(line.question.length, 500);
	assert.ok(line.question.endsWith("\u2026"));
	assert.equal(statSync(b.file).mode & 0o777, 0o600);
	assert.equal(statSync(join(b.stateDir, "operator")).mode & 0o777, 0o700);
	assert.deepEqual(b.answers.open().map((item) => item.id), [answer.id]);
});

test("secret-shaped text is redacted; one that survives redaction is refused by pattern name, writing nothing", async (t) => {
	const b = await bench(t);
	b.answers.post({ ...input, answer: `token ${ghShaped} here` });
	const stored = JSON.parse(b.lines()[0]!);
	assert.ok(stored.answer.includes("\u2022\u2022\u2022") && !stored.answer.includes(ghShaped));
	assert.throws(() => b.answers.post({ ...input, answer: `${keyHeader}\nMIIE` }), (error: Error) => {
		assert.match(error.message, /secret-shaped text \(private key block\) remains after redaction/);
		assert.ok(!error.message.includes("BEGIN"));
		return true;
	});
	assert.equal(b.lines().length, 1);
});

test("job_id: research landings of any delivery are accepted and deduplicated; everything else is refused", async (t) => {
	const b = await bench(t, [
		["cp-local", {}], ["cp-answer", { delivery: "answer", phase: "done" }], ["cp-board", { delivery: "board" }],
		["cp-ship", { kind: "ship", delivery: "pr" }], ["cp-other", { project: "elsewhere" }],
		["cp-waiting", { phase: "waiting" }], ["cp-failed", { phase: "failed" }],
	]);
	const ids = new Map<string, string>();
	for (const id of ["cp-local", "cp-answer", "cp-board"]) {
		const posted = b.answers.post({ ...input, job_id: id });
		assert.equal(posted.state, "posted", id);
		ids.set(id, posted.answer.id);
	}
	assert.equal(new Set(ids.values()).size, 3);
	for (const [id, first] of ids) {
		const again = b.answers.post({ ...input, answer: "second", job_id: id });
		assert.deepEqual([again.state, again.answer.id], ["duplicate", first], id);
	}
	assert.equal(b.lines().length, 3);
	const refuse = (id: string, message: RegExp) => assert.throws(() => b.answers.post({ ...input, job_id: id }), message, id);
	refuse("cp-nope", /unknown job cp-nope/);
	refuse("cp-ship", /cp-ship is a ship job \(delivery pr\); answers name kind:research landings only, any delivery/);
	refuse("cp-other", /cp-other belongs to elsewhere, not demo/);
	refuse("cp-waiting", /has not landed \(phase waiting\)/);
	refuse("cp-failed", /has not landed \(phase failed\)/);
	assert.equal(b.lines().length, 3);
});

test("an answer over 8000 chars and more than 10 evidence paths are refused by the schema", async (t) => {
	const b = await bench(t);
	assert.throws(() => b.answers.post({ ...input, answer: "a".repeat(8001) }), /invalid operator answer/);
	assert.throws(() => b.answers.post({ ...input, evidence_paths: Array.from({ length: 11 }, (_, i) => `p${i}`) }), /invalid operator answer/);
	b.answers.post({ ...input, answer: "a".repeat(8000) });
	assert.equal(b.lines().length, 1);
});

test("fold: ack sets acked_at once; unknown acks and garbage count as skipped; a torn last line is ignored; a directory is unreadable", async (t) => {
	const b = await bench(t);
	const { answer } = b.answers.post(input);
	const ack = (id: string, at: string) => appendAnswerLine(b.stateDir, { type: "acked", by: "viewer", id, at, peer: "127.0.0.1" });
	ack(answer.id, "2026-01-01T00:00:00Z");
	ack(answer.id, "2026-02-02T00:00:00Z"); // a repeat is ignored, not counted
	ack("ans-000000000000", "2026-01-01T00:00:00Z");
	appendFileSync(b.file, "not json\n");
	assert.deepEqual(readAnswers(b.stateDir).answers.map((item) => [item.acked_at, item.acked_peer]), [["2026-01-01T00:00:00Z", "127.0.0.1"]]);
	assert.equal(readAnswers(b.stateDir).skipped, 2);
	assert.deepEqual(b.answers.open(), []);
	appendFileSync(b.file, '{"type":"posted","by":"bridge","id":"ans-0123');
	assert.deepEqual([readAnswers(b.stateDir).answers.length, readAnswers(b.stateDir).skipped], [1, 2]);

	const dir = await bench(t);
	mkdirSync(dir.file, { recursive: true });
	assert.throws(() => dir.answers.post(input), /answers journal unreadable/);
	assert.deepEqual(readAnswers(join(dir.stateDir, "missing")), { exists: false, answers: [], skipped: 0, error: null });
});

function snapshot(root: string, rel = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of existsSync(join(root, rel)) ? readdirSync(join(root, rel), { withFileTypes: true }) : []) {
		const path = join(rel, entry.name);
		if (entry.isDirectory()) Object.assign(out, snapshot(root, path));
		else out[path] = readFileSync(join(root, path), "utf8");
	}
	return out;
}

test("cp_parent answer: in-process, no parent turn, writes only the journal; id and relays are refused", async (t) => {
	const b = await bench(t, [["cp-ans", { delivery: "answer" }]]);
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(b.home, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home: b.home, mode: "multi", hostPid: 0, parentPid: 0 });
	const tools = new Map<string, { parameters: { properties: { action: { enum: string[] } } }; execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> }> }>();
	bridgeExtension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never), registerCommand: () => {}, on: () => {}, sendMessage: () => {} } as never);
	const tool = tools.get(BRIDGE_TOOL)!;
	assert.ok(tool.parameters.properties.action.enum.includes("answer"));
	const before = snapshot(b.home);
	const posted = await tool.execute("a", { action: "answer", ...input, job_id: "cp-ans" });
	assert.equal(posted.isError, undefined);
	assert.equal(posted.details.state, "posted");
	assert.match(String(posted.details.id), /^ans-[a-f0-9]{12}$/);
	const after = snapshot(b.home);
	const journal = join(LAYOUT.state, "operator", "answers.jsonl");
	assert.deepEqual(Object.keys(after).filter((file) => !(file in before)), [journal]);
	assert.deepEqual(Object.keys(before).filter((file) => before[file] !== after[file]), []);
	const again = await tool.execute("b", { action: "answer", ...input, job_id: "cp-ans" });
	assert.equal(again.details.state, "duplicate");
	assert.deepEqual(snapshot(b.home), after, "a duplicate writes nothing");
	for (const params of [{ id: "ask-abc123" }, { question: "ask-abc123: Keep" }, { question: "[cp-bridge send] wake-up" }, { project: "" }]) {
		const refused = await tool.execute("c", { action: "answer", ...input, ...params });
		assert.equal(refused.isError, true, JSON.stringify(params));
	}
	assert.match((await tool.execute("d", { action: "answer", ...input, id: "ask-abc123" })).content[0]!.text, /ask_answer/);
	assert.deepEqual(snapshot(b.home), after);
});

test("no push: the push sweep never reads the answers journal, and posting creates no ask", async (t) => {
	const b = await bench(t);
	b.answers.post(input);
	assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "src", "push", "sweep.ts"), "utf8"), /answers\.jsonl|operator-answers|readAnswers/);
	assert.equal(existsSync(join(b.stateDir, "operator", "asks.jsonl")), false);
});
