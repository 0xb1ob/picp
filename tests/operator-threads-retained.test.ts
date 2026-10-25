/**
 * cp-xmw2 units retained by P9d: the bridge's own thread_bind guard and the bad-ref/bad-tag refusals of
 * fileUnderThread/bindThread are shadowed by pi's schema and generated ids, so no entry point reaches them.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import bridgeExtension, { BRIDGE_TOOL, saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../src/contracts.ts";
import { fileUnderThread } from "../src/operator-threads.ts";
import { bindThread } from "../src/viewer/control-audit.ts";
import { operatorThreadsFile } from "../src/viewer/control-files.ts";
import { createScratchHome } from "./harness/index.ts";

type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> }> };

async function bench(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home.path, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const tools = new Map<string, Tool>();
	bridgeExtension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never), registerCommand: () => {}, on: () => {}, sendMessage: () => {} } as never);
	const stateDir = join(home.path, LAYOUT.state);
	const read = (name: string) => existsSync(join(stateDir, "operator", name)) ? readFileSync(join(stateDir, "operator", name), "utf8") : null;
	return { home: home.path, stateDir, tool: tools.get(BRIDGE_TOOL)!, read };
}

test("thread_bind validates the whole request before writes", async (t) => {
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
});

test("fileUnderThread never throws on a bad ref and names the failure", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const filed = fileUnderThread(join(home.path, LAYOUT.state), "billing", { kind: "answer", id: "nope" });
	assert.equal(filed.details.id, null);
	assert.match(filed.note, /thread billing NOT filed: thread ref/);
});

test("bindThread: a bad tag or ref writes nothing; invalid job refs open no thread", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const b = { stateDir: join(home.path, LAYOUT.state), file: operatorThreadsFile(join(home.path, LAYOUT.state)) };
	const ref = { kind: "ask", id: "ask-0a1b" } as const;
	const T0 = "2026-10-06T08:00:00Z";
	const badTag = bindThread(b.stateDir, { tag: "Billing Bug", ref, by: "bridge", peer: null, at: T0 });
	assert.deepEqual(badTag, { ok: false, error: 'thread tag "Billing Bug" is not normalized (1-32 of a-z 0-9 -, first a letter or digit)' });
	const badRef = bindThread(b.stateDir, { tag: "ok", ref: { kind: "ask", id: "ask-XYZ" }, by: "bridge", peer: null, at: T0 });
	assert.equal(badRef.ok, false);
	assert.equal(existsSync(b.file), false);
	const bind = (tag: string, id: string) => bindThread(b.stateDir, { tag, ref: { kind: "job", id }, by: "bridge", peer: null, at: T0 });
	for (const id of ["", "../cp-one", "cp/one", "cp.one", "x".repeat(129)]) assert.equal(bind("bad", id).ok, false);
	assert.equal(existsSync(b.file), false, "invalid refs open no thread");
});
