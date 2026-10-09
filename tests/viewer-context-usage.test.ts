import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { LAYOUT } from "../src/contracts.ts";
import { recordModelWindows } from "../src/model-windows.ts";
import { contextLevel, contextUsage, modelWindows, SCAN_BYTES, scanSession } from "../src/viewer/context-usage.ts";
import { jobsView } from "../src/viewer/jobs-view.ts";
import { dependencyMap } from "../src/viewer/mandates-map-view.ts";
import { operatorSessionsFile } from "../src/viewer/operator-sessions.ts";
import { sessionsView } from "../src/viewer/sessions-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const reply = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => line({ type: "message", timestamp: "2026-09-27T10:00:00.000Z", message: { role: "assistant", provider: "openai", model: "gpt-x", content: [], usage, ...extra } });
const USAGE = { input: 1_000, output: 200, cacheRead: 80_000, cacheWrite: 3_000 };

function fixture(t: { after: (fn: () => void) => void }) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state), sessions = join(stateDir, "sessions");
	const state = { home: home.path, stateDir };
	mkdirSync(sessions, { recursive: true });
	recordModelWindows(home.path, { getAll: () => [{ provider: "openai", id: "gpt-x", contextWindow: 272_000 }, { provider: "anthropic", id: "no-window" }] });
	return { home, stateDir, sessions, state };
}

test("threshold classes: ok below 70%, warn from 70%, high from 90%", () => {
	assert.equal(contextLevel(0), "ok");
	assert.equal(contextLevel(69.99), "ok");
	assert.equal(contextLevel(70), "warn");
	assert.equal(contextLevel(89.99), "warn");
	assert.equal(contextLevel(90), "high");
	assert.equal(contextLevel(120), "high");
});

test("known case: the last assistant usage (pi's calculateContextTokens) against the registry window", (t) => {
	const { sessions, home, stateDir } = fixture(t);
	assert.deepEqual([...modelWindows(stateDir)!], [["openai/gpt-x", 272_000]], "a model without a window is not recorded");
	assert.match(readFileSync(join(home.path, LAYOUT.state, "model-windows.json"), "utf8"), /recorded_at/);
	const file = join(sessions, "w.jsonl");
	writeFileSync(file, reply({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }) + reply(USAGE) + reply({ input: 9_999_999, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "aborted" }) + reply({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
	const usage = contextUsage(scanSession(file), null, modelWindows(stateDir));
	assert.equal(usage.tokens, 84_200, "input + output + cacheRead + cacheWrite; aborted and all-zero replies skipped");
	assert.equal(usage.window, 272_000);
	assert.equal(Math.round(usage.percent!), 31);
	assert.equal(usage.level, "ok");
	assert.equal(usage.reason, null);
	assert.equal(usage.model, "openai/gpt-x");
	appendFileSync(file, reply({ ...USAGE, totalTokens: 250_000 }));
	const high = contextUsage(scanSession(file), null, modelWindows(stateDir));
	assert.equal(high.tokens, 250_000, "totalTokens wins when present, as in pi");
	assert.equal(high.level, "high");
});

test("unknown case: named reasons, never 0", (t) => {
	const { sessions, stateDir } = fixture(t);
	const windows = modelWindows(stateDir);
	const empty = join(sessions, "empty.jsonl");
	writeFileSync(empty, line({ type: "session", id: "x" }) + line({ type: "message", message: { role: "user", content: "hi" } }));
	const none = contextUsage(scanSession(empty), "openai/gpt-x", windows);
	assert.deepEqual([none.tokens, none.percent, none.level, none.reason], [null, null, null, "no assistant reply yet"]);
	const compacted = join(sessions, "compacted.jsonl");
	writeFileSync(compacted, reply(USAGE) + line({ type: "compaction", timestamp: "2026-09-27T11:00:00.000Z", tokensBefore: 84_200 }));
	const after = contextUsage(scanSession(compacted), null, windows);
	assert.equal(after.tokens, null);
	assert.equal(after.reason, "no assistant reply since the last compaction");
	assert.equal(after.last_compact_at, "2026-09-27T11:00:00.000Z");
	appendFileSync(compacted, reply({ ...USAGE, cacheRead: 10_000 }));
	const replied = contextUsage(scanSession(compacted), null, windows);
	assert.equal(replied.tokens, 14_200, "a reply after the compaction is trusted again");
	assert.equal(replied.last_compact_at, "2026-09-27T11:00:00.000Z", "the last compaction stays shown");
	const other = join(sessions, "other.jsonl");
	writeFileSync(other, reply(USAGE, { provider: "anthropic", model: "no-window" }));
	const noWindow = contextUsage(scanSession(other), null, windows);
	assert.equal(noWindow.percent, null);
	assert.equal(noWindow.reason, "no context window known for anthropic/no-window");
	assert.match(contextUsage(scanSession(other), null, undefined).reason!, /model windows not recorded yet/);
	assert.equal(contextUsage(scanSession(join(sessions, "gone.jsonl")), null, windows).reason, "session file missing");
});

test("views: Sessions carries operator, parent and worker context; Jobs and Map carry the worker's", async (t) => {
	const { stateDir, sessions, state, home } = fixture(t);
	const worker = join(sessions, "one.jsonl");
	writeFileSync(worker, reply({ ...USAGE, cacheRead: 200_000 }));
	put(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-one", project: "demo", phase: "held", worker: { session_file: worker, model: "openai/gpt-x" } }] });
	put(join(sessions, "cp-parent-context.json"), { contextTokens: 136_000, lastCompactAt: "2026-09-27T09:00:00.000Z" });
	put(join(sessions, "cp-parent-control.json"), { model: "openai/gpt-x" });
	const operator = join(home.path, "operator.jsonl");
	writeFileSync(operator, line({ type: "session", id: "op" }));
	writeFileSync(operatorSessionsFile(sessions), line({ at: "2026-09-27T08:00:00.000Z", session_file: operator }));

	const view = sessionsView(state, "workers", "cp-one")!;
	assert.equal(view.workers[0]!.context!.level, "warn", "204,200 / 272,000 is 75%");
	assert.equal(view.workers[0]!.context!.tokens, 204_200);
	assert.equal(view.parent.context!.tokens, 136_000, "the parent uses its recorded contextTokens");
	assert.equal(view.parent.context!.percent, 50);
	assert.equal(view.parent.context!.last_compact_at, "2026-09-27T09:00:00.000Z");
	assert.equal(view.operator_context!.reason, "no assistant reply yet");
	assert.equal(jobsView(state).jobs.find((j) => j.id === "cp-one")!.context!.tokens, 204_200);
	assert.equal(dependencyMap(state).nodes.find((n) => n.id === "cp-one")!.context!.tokens, 204_200);

	const result = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; export const sessions=(data)=>render(h(Sessions,{data})); export const jobs=(data)=>render(h(Jobs,{data}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
	const screens = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
	const html = screens.sessions(view);
	assert.match(html, /class="session-ctx ctx-warn"/);
	assert.match(html, /ctx (<\/span>)?204K \/ 272K · 75%/);
	assert.match(html, /ctx (<\/span>)?136K \/ 272K · 50%/);
	assert.match(html, /context n\/a/);
	assert.doesNotMatch(html, /style=/);
	const you = screens.sessions(sessionsView(state, "you", null)!);
	assert.match(parseHTML(you).document.querySelector(".session-heading")!.innerHTML, /class="session-ctx ctx-unknown" title="context n\/a">ctx n\/a<\/span>/, "the heading shows ctx n/a, never 0");
	const jobsHtml = screens.jobs(jobsView(state));
	assert.match(jobsHtml, /<span class="job-context"><span class="ctx-chip ctx-warn ctx-compact"/);
	assert.match(jobsHtml, /ctx (<\/span>)?204K \/ 272K · 75%/);
	assert.match(jobsHtml, /aria-label="Context window used" max="100" value="75\./);
});

test("model and thinking: latest model_change and thinking_level_change; last assistant model fallback; unknown model explicit, unknown thinking omitted", async (t) => {
	const { stateDir, sessions, state, home } = fixture(t);
	const windows = modelWindows(stateDir);
	const change = line({ type: "model_change", provider: "anthropic", modelId: "claude-x" }) + line({ type: "thinking_level_change", thinkingLevel: "low" }) + line({ type: "thinking_level_change", thinkingLevel: "high" });
	const withThinking = join(sessions, "with.jsonl");
	writeFileSync(withThinking, change);
	const known = contextUsage(scanSession(withThinking), null, windows);
	assert.deepEqual([known.model, known.thinking], ["anthropic/claude-x", "high"], "the latest of each");
	// No model_change: an errored last reply still names the model that ran.
	const fallback = join(sessions, "fallback.jsonl");
	writeFileSync(fallback, reply({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "error" }));
	const fell = contextUsage(scanSession(fallback), null, windows);
	assert.deepEqual([fell.model, fell.thinking], ["openai/gpt-x", null]);

	put(join(sessions, "cp-parent-context.json"), { contextTokens: 1_000 });
	const operator = join(home.path, "operator.jsonl");
	writeFileSync(operator, change);
	writeFileSync(operatorSessionsFile(sessions), line({ at: "2026-09-27T08:00:00.000Z", session_file: operator }));
	put(join(sessions, "cp-parent-control.json"), { model: "openai/gpt-x" });
	const build_ = async () => {
		const result = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const sessions=(data)=>render(h(Sessions,{data}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
		return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
	};
	const screens = await build_();

	// Operator has thinking; the parent has none recorded and falls back to the bridge's model.
	const view = sessionsView(state, "you", null)!;
	assert.deepEqual([view.operator_context!.model, view.operator_context!.thinking], ["anthropic/claude-x", "high"]);
	assert.deepEqual([view.parent.context!.model, view.parent.context!.thinking], ["openai/gpt-x", null]);
	let html = screens.sessions(view);
	assert.match(html, /<small class="session-model">claude-x · high<\/small>/);
	assert.match(html, /<small class="session-model">gpt-x · (?:idle|active)<\/small>/, "no thinking, no separator");

	// Parent with thinking, operator with nothing recorded: the model is explicitly unknown.
	const parentFile = join(sessions, "cp-parent.jsonl");
	writeFileSync(parentFile, change);
	writeFileSync(operator, line({ type: "session", id: "op" }));
	const next = sessionsView(state, "parent", null)!;
	assert.deepEqual([next.parent.context!.model, next.parent.context!.thinking], ["anthropic/claude-x", "high"]);
	assert.deepEqual([next.operator_context!.model, next.operator_context!.thinking], [null, null]);
	html = screens.sessions(next);
	assert.match(html, /<small class="session-model">claude-x · high · (?:idle|active)<\/small>/);
	assert.match(html, /<small class="session-model">model unknown<\/small>/);
});

test("workers: model · thinking from the session, else routing (fleet record, status.json), else omitted", async (t) => {
	const { stateDir, sessions, state } = fixture(t);
	const file = (name: string, body: string) => { const path = join(sessions, `${name}.jsonl`); writeFileSync(path, body); return path; };
	const job = (id: string, extra: Record<string, unknown>, session?: string) => ({ job_id: id, project: "demo", phase: "waiting", ...extra, worker: { model: "openai/gpt-x", ...(session ? { session_file: session } : {}) } });
	put(join(stateDir, "fleet.json"), { jobs: [
		job("cp-a", { routing: { thinking: "low", inferred: false } }, file("a", line({ type: "thinking_level_change", thinkingLevel: "medium" }))),
		job("cp-b", { routing: { thinking: "high", inferred: false } }, file("b", line({ type: "session", id: "b" }))),
		job("cp-c", {}),
		job("cp-d", {}),
	] });
	put(join(stateDir, "runs", "cp-c", "status.json"), { routing: { thinking: "minimal", inferred: false } });
	const thinking = (id: string) => sessionsView(state, "workers", id)!.workers.find((w) => w.id === id)!.thinking;
	assert.deepEqual(["cp-a", "cp-b", "cp-c", "cp-d"].map(thinking), ["medium", "high", "minimal", undefined]);
	assert.equal(sessionsView(state, "workers", "cp-a")!.subtitle, "gpt-x · medium");
	assert.equal(sessionsView(state, "workers", "cp-d")!.subtitle, "gpt-x", "unknown thinking is omitted");

	const result = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const sessions=(data)=>render(h(Sessions,{data}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
	const screens = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`);
	const html: string = screens.sessions(sessionsView(state, "workers", "cp-a")!);
	for (const meta of ["gpt-x · medium", "gpt-x · high", "gpt-x · minimal", "gpt-x"]) assert.match(html, new RegExp(`<small class="session-model">${meta} · no run status</small>`));

	// A model switched inside the session after dispatch wins over the dispatch model; the row and the subtitle agree.
	put(join(stateDir, "fleet.json"), { jobs: [job("cp-e", {}, file("e", line({ type: "model_change", provider: "anthropic", modelId: "claude-x" }) + line({ type: "thinking_level_change", thinkingLevel: "high" })))] });
	const switched = sessionsView(state, "workers", "cp-e")!;
	assert.equal(switched.subtitle, "claude-x · high");
	const switchedHtml: string = screens.sessions(switched);
	assert.match(switchedHtml, /<small class="session-model">claude-x · high · no run status<\/small>/);
	assert.doesNotMatch(switchedHtml, /<small>[^<]*gpt-x/);
});

test("long session (> SCAN_BYTES): the head's model/thinking fill what the tail lacks; the tail wins", (t) => {
	const { sessions, stateDir } = fixture(t);
	const windows = modelWindows(stateDir);
	const head = line({ type: "session", id: "long" }) + line({ type: "model_change", provider: "anthropic", modelId: "claude-head" }) + line({ type: "thinking_level_change", thinkingLevel: "high" });
	const filler = line({ type: "message", message: { role: "user", content: "x".repeat(1_000) } }).repeat(Math.ceil(SCAN_BYTES / 1_000) + 100);
	const file = join(sessions, "long.jsonl");
	writeFileSync(file, head + filler);
	assert.ok(statSync(file).size > SCAN_BYTES);
	const headOnly = contextUsage(scanSession(file), null, windows);
	assert.deepEqual([headOnly.model, headOnly.thinking], ["anthropic/claude-head", "high"], "only the head records them");

	appendFileSync(file, line({ type: "thinking_level_change", thinkingLevel: "low" }) + reply(USAGE));
	const tail = contextUsage(scanSession(file), null, windows);
	assert.deepEqual([tail.model, tail.thinking], ["openai/gpt-x", "low"], "the tail's thinking and assistant model beat the head");

	const none = join(sessions, "plain.jsonl");
	writeFileSync(none, line({ type: "session", id: "plain" }) + filler);
	assert.deepEqual([scanSession(none).model, scanSession(none).thinking], [null, null], "nothing recorded stays unknown");
});

test("long session: an appended poll does not re-read the head; a shrink or a replaced file does", (t) => {
	const { sessions } = fixture(t);
	const body = (level: string) => line({ type: "session", id: "grow" }) + line({ type: "thinking_level_change", thinkingLevel: level }) + line({ type: "message", message: { role: "user", content: "x".repeat(1_000) } }).repeat(Math.ceil(SCAN_BYTES / 1_000) + 100);
	const file = join(sessions, "grow.jsonl");
	writeFileSync(file, body("high"));
	assert.equal(scanSession(file).thinking, "high");

	// Rewrite the head bytes in place (same length) and append: a re-read would see "xxxx", the kept head still says "high".
	const at = readFileSync(file).indexOf('"high"') + 1;
	const fd = openSync(file, "r+"); writeSync(fd, "xxxx", at); closeSync(fd);
	appendFileSync(file, line({ type: "message", message: { role: "user", content: "more" } }));
	assert.equal(scanSession(file).thinking, "high", "append-only growth keeps the head without re-reading it");

	truncateSync(file, statSync(file).size - 2_000);
	assert.equal(scanSession(file).thinking, "xxxx", "a shrink reads the head again");

	const next = join(sessions, "grow.next.jsonl");
	writeFileSync(next, body("low"));
	renameSync(next, file);
	assert.equal(scanSession(file).thinking, "low", "a replaced file (new inode) reads the head again");
});
