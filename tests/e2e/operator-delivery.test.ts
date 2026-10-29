/** Behavior 11 (operator to parent delivery), P9 first slice: what the real bridge, parent host and parent record,
 * read back through their consumers (provider requests, /doctor, the viewer API, the host log). */
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { layoutForHome, type DoctorReport } from "../../src/contracts.ts";
import { attachParentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc } from "../harness/index.ts";
import { stopParentHosts } from "../harness/parent-hosts.ts";

/** A throwaway extension file registering `tools` (name + JSON-schema properties); no imports, so any dir loads it. */
function toolExtension(file: string, tools: Array<{ name: string; properties?: Record<string, unknown> }>): string {
	mkdirSync(join(file, ".."), { recursive: true });
	const body = tools.map((tool) => `pi.registerTool({ name: ${JSON.stringify(tool.name)}, label: ${JSON.stringify(tool.name)}, description: "fixture",
		parameters: { type: "object", properties: ${JSON.stringify(tool.properties ?? {})} },
		async execute() { return { content: [{ type: "text", text: "fixture" }], details: {} }; } });`).join("\n");
	writeFileSync(file, `export default function (pi) {\n${body}\n}\n`);
	return file;
}

// P9-tools: foreign tools reach `/doctor --json` with guessed capability; builtins, cp_* and command-post's own dir
// are expected, a lookalike path is not; file reads and shells are uncovered, network tools are not.
test("P9-tools: /doctor names a parent's foreign tools with their capabilities and guard coverage", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const dir = mkdtempSync(join(tmpdir(), "cp-p9-tools-"));
	t.after(() => { home.cleanup(); rmSync(dir, { recursive: true, force: true }); });
	const foreign = toolExtension(join(dir, "global", "foreign-tools.ts"), [
		{ name: "lens_read", properties: { path: { type: "string" } } },
		{ name: "read_symbol" },
		{ name: "ast_grep_search" },
		{ name: "run_shell" },
		{ name: "exec_thing", properties: { command: { type: "string" } } },
		{ name: "fetch_content" },
		{ name: "lookup", properties: { url: { type: "string" } } },
		{ name: "cp_foreign_probe" },
	]);
	const ours = toolExtension(join(dir, "pkg", "extensions", "command-post", "extra.ts"), [{ name: "something_else" }]);
	const lookalike = toolExtension(join(dir, ".treehouse", "pi-command-post-abc", "7", "pi-command-post", "tests", "fixtures", "lens.ts"),
		[{ name: "lens_view", properties: { path: { type: "string" } } }]);
	const rpc = startRpc({ cwd: home.path, env: { CP_HOME: home.path },
		args: ["--no-session", "--no-extensions", "-e", COMMAND_POST_EXTENSION, "-e", foreign, "-e", ours, "-e", lookalike] });
	t.after(() => rpc.close().then(() => undefined));
	rpc.send({ id: "doctor", type: "prompt", message: "/doctor --json" });
	const notify = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).trimStart().startsWith("{"), 90_000);
	const finding = (JSON.parse(String(notify.message)) as DoctorReport).findings.find((f) => f.check === "session.tools");
	assert.equal(finding?.severity, "warn", JSON.stringify(finding));
	assert.equal(finding?.what, "8 foreign tool(s); 6 can read files or run a shell (outside guard coverage)");
	assert.deepEqual(finding?.detail?.split("; ").sort(), [
		"ast_grep_search (file_read, outside guard coverage)",
		"exec_thing (shell, outside guard coverage)",
		"fetch_content (network)",
		"lens_read (file_read, outside guard coverage)",
		"lens_view (file_read, outside guard coverage)",
		"lookup (network)",
		"read_symbol (file_read, outside guard coverage)",
		"run_shell (shell, outside guard coverage)",
	]);
	assert.match(finding?.fix ?? "", /--no-extensions -e extensions\/command-post/);
});

/** Runs `env` in this process (the parent host inherits it) until the test ends. */
function processEnv(t: TestContext, env: NodeJS.ProcessEnv): void {
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

// P9-control: saved sessions reopen only while on disk; reported sessions are recorded only once on disk (dangling
// records repaired, saved model kept); a refused record write is logged, never failing the start.
test("P9-control: the parent host's session record reopens only existing files and never fails a start", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("p9-control-parent", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const settingModel = provider.addScript("p9-control-setting", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	processEnv(t, { ...agent.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" });
	t.after(async () => { await stopParentHosts(home.path); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const layout = layoutForHome("multi", home.path);
	const sessions = join(home.path, layout.sessions);
	const control = join(sessions, "cp-parent-control.json");
	const fallback = join(sessions, "cp-parent.jsonl");
	const log = parentHostPaths(home.path, "multi").log;
	const logSince = (from: number) => (existsSync(log) ? readFileSync(log, "utf8").slice(from) : "");
	const logSize = () => (existsSync(log) ? readFileSync(log, "utf8").length : 0);
	const run = async (options: Record<string, unknown>, body?: (host: ParentHostClient) => Promise<void>) => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		try {
			const started = await host.request("start", { home: home.path, mode: "multi", ...options }) as { pid?: number; sessionFile: string };
			assert.ok(started.pid, JSON.stringify(started));
			await body?.(host);
			await host.request("stop");
			await host.closed;
			return started;
		} finally { host.disconnect(); }
	};

	let from = logSize();
	const first = await run({ model: parentModel, modelExplicit: true }, async (host) => { await host.request("send", "Say ready."); });
	assert.equal(first.sessionFile, fallback);
	assert.match(logSince(from), new RegExp(`reported parent session ${escape(fallback)} is not on disk; keeping the saved control record`));
	assert.doesNotMatch(logSince(from), /is missing; not reopening it/, "no saved record logs nothing about one");
	assert.equal(existsSync(control), false, "a session not yet on disk is never recorded");
	assert.ok(existsSync(fallback), "the parent's reply wrote its session");

	from = logSize();
	const second = await run({ model: parentModel, modelExplicit: true });
	assert.equal(second.sessionFile, fallback);
	assert.deepEqual(JSON.parse(readFileSync(control, "utf8")), { sessionFile: fallback, model: parentModel });

	const saved = join(home.path, "alt", "saved.jsonl");
	mkdirSync(join(saved, ".."), { recursive: true });
	cpSync(fallback, saved);
	writeFileSync(control, JSON.stringify({ sessionFile: saved, model: parentModel }));
	const reopened = await run({ model: parentModel });
	assert.equal(reopened.sessionFile, saved, "an existing saved session other than the fallback is reopened");
	assert.doesNotMatch(logSince(from), /is missing; not reopening it/, "an existing saved session logs nothing");
	assert.deepEqual(JSON.parse(readFileSync(control, "utf8")), { sessionFile: saved, model: parentModel });

	const dangling = join(sessions, "deleted.jsonl");
	writeFileSync(control, JSON.stringify({ sessionFile: dangling, model: parentModel }));
	mkdirSync(join(home.path, layout.data), { recursive: true });
	writeFileSync(join(home.path, layout.data, "parent.json"), JSON.stringify({ model: settingModel }));
	from = logSize();
	const repaired = await run({ model: parentModel });
	assert.equal(repaired.sessionFile, fallback, "a missing saved session is not reopened");
	assert.equal((repaired as { missing?: string }).missing, dangling, "the start reports the saved session it could not resume");
	assert.match(logSince(from), new RegExp(`saved parent session ${escape(dangling)} is missing; not reopening it`));
	assert.deepEqual(JSON.parse(readFileSync(control, "utf8")), { sessionFile: fallback, model: parentModel }, "the path is repaired; the saved model is kept");
	rmSync(join(home.path, layout.data, "parent.json"));

	const unborn = join(home.path, "alt", "unborn.jsonl");
	from = logSize();
	await run({ model: parentModel, modelExplicit: true, sessionFile: unborn });
	assert.match(logSince(from), new RegExp(`reported parent session ${escape(unborn)} is not on disk; keeping the saved control record`));
	assert.deepEqual(JSON.parse(readFileSync(control, "utf8")), { sessionFile: fallback, model: parentModel });

	const copy = join(home.path, "alt", "copy.jsonl");
	cpSync(fallback, copy);
	chmodSync(sessions, 0o555);
	from = logSize();
	try { await run({ model: parentModel, modelExplicit: true, sessionFile: copy }); } finally { chmodSync(sessions, 0o755); }
	assert.match(logSince(from), new RegExp(`parent control write failed for ${escape(copy)}`));
	assert.deepEqual(JSON.parse(readFileSync(control, "utf8")), { sessionFile: fallback, model: parentModel });

	writeFileSync(control, '{"sessionFile": "/gone.js');
	const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
	t.after(() => host.disconnect());
	await assert.rejects(host.request("start", { home: home.path, mode: "multi", model: parentModel, modelExplicit: true }),
		new RegExp(`parent control unreadable: ${escape(control)}`), "a corrupt record refuses the start before any spawn");
	assert.equal(readFileSync(control, "utf8"), '{"sessionFile": "/gone.js', "the refused start leaves the record for the operator");
});

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
