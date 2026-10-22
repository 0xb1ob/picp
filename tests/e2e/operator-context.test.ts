import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc } from "../harness/index.ts";
import { layoutForHome } from "../../src/contracts.ts";

test("S24 context: fresh bridge loads orders, parsed learnings and newest handoff into the provider request", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s24-context", [{ kind: "text", text: "Context received." }]);
	const agent = createAgentDir({ provider });
	const layout = layoutForHome("multi", home.path);
	const handoffs = join(home.path, layout.operatorWorkspace, "handoffs");
	mkdirSync(join(home.path, layout.data), { recursive: true });
	mkdirSync(handoffs, { recursive: true });
	writeFileSync(join(home.path, layout.data, "standing-orders.md"), "- S24 best result per dollar.\n");
	writeFileSync(join(home.path, layout.learningsFile), "<!-- header\n- 2000-01-01 not an entry\n-->\n- 2026-09-01 S24 keep me\n");
	writeFileSync(join(handoffs, "main-session-compact-a.md"), "old");
	utimesSync(join(handoffs, "main-session-compact-a.md"), 1000, 1000);
	writeFileSync(join(handoffs, "main-session-2026-09-29.md"), "new");
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", join(home.path, "operator.jsonl"), "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "context", message: "Read the supplied operator context." });
	await rpc.waitFor((r) => r.type === "agent_settled", 60_000);
	const input = JSON.stringify(provider.requests("s24-context")[0]?.body);
	assert.match(input, /read-only; preferences, not authorization/);
	assert.match(input, /S24 best result per dollar/);
	assert.match(input, /S24 keep me/);
	assert.doesNotMatch(input, /not an entry/);
	assert.match(input, /main-session-2026-09-29\.md/);
	assert.doesNotMatch(input, /main-session-compact-a/);
	assert.equal(provider.remaining("s24-context"), 0);
	rpc.send({ type: "get_messages", id: "transcript" });
	const reply = await rpc.waitFor((r) => r.type === "response" && r.id === "transcript");
	const transcript = (reply.data as { messages: Array<{ customType?: string; display?: boolean }> }).messages;
	const contexts = transcript.filter((m) => m.customType === "cp-operator-context");
	assert.equal(contexts.length, 1);
	assert.equal(contexts[0]?.display, false);
	await rpc.close();
	const resumedModel = provider.addScript("s24-resumed", [{ kind: "text", text: "Resumed." }]);
	agent.writeModels(provider);
	writeFileSync(join(home.path, layout.data, "standing-orders.md"), "S24 SHOULD NOT RELOAD");
	const resumed = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--session", join(home.path, "operator.jsonl"), "--model", resumedModel] });
	t.after(() => resumed.close());
	resumed.send({ type: "prompt", id: "resume", message: "Continue." });
	await resumed.waitFor((r) => r.type === "agent_settled", 60_000);
	assert.doesNotMatch(JSON.stringify(provider.requests("s24-resumed")[0]?.body), /S24 SHOULD NOT RELOAD/);
	resumed.send({ type: "get_messages", id: "resumed-transcript" });
	const again = await resumed.waitFor((r) => r.type === "response" && r.id === "resumed-transcript");
	assert.equal((again.data as { messages: Array<{ customType?: string }> }).messages.filter((m) => m.customType === "cp-operator-context").length, 1);
	await resumed.close();
});


test("S24 context: an empty home adds no operator context or preference files", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s24-empty", [{ kind: "text", text: "Empty context received." }]);
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "empty", message: "Reply once." });
	await rpc.waitFor((r) => r.type === "agent_settled", 60_000);
	rpc.send({ type: "get_messages", id: "empty-transcript" });
	const result = await rpc.waitFor((r) => r.type === "response" && r.id === "empty-transcript");
	assert.equal((result.data as { messages: Array<{ customType?: string }> }).messages.filter((m) => m.customType === "cp-operator-context").length, 0);
	const layout = layoutForHome("multi", home.path);
	for (const file of [join(layout.data, "standing-orders.md"), layout.learningsFile, join(layout.operatorWorkspace, "handoffs")]) {
		assert.equal(existsSync(join(home.path, file)), false, `${file} remains absent`);
	}
});
