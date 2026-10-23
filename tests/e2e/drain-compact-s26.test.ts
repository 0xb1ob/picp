import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { drainFile, readDrain } from "../../src/drain.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

for (const [timeout, name] of [
	[false, "S26: parent compact hold refuses new drains and releases a running drain"],
	[true, "S26: parent compact hold is named at drain timeout"],
] as const) test(name, { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 500 }));
	const provider = await MockProvider.start();
	const model = provider.addScript("s26-compact-drain", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }], usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "text", text: "Work settled.", usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "text", text: "Compact summary." },
		{ kind: "text", text: "Drain wake received." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path, CP_PARENT_COMPACT_HOLD_SECONDS: "60" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const command = async (text: string) => {
		const before = child.records().length;
		await child.prompt(text);
		return String((await child.waitFor((r) => child.records().indexOf(r) >= before && r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000)).message);
	};
	await child.prompt("Do the work.");
	await child.waitForSettled(20_000);
	const log = join(home.path, LAYOUT.state, "daemon.log");
	await waitFor(() => existsSync(log) ? readFileSync(log, "utf8") : "", (text) => text.includes("hold engaged"), { what: "real parent compact hold" });
	assert.match(await command("/cp-drain 30"), /refused:.*compact/i);
	assert.equal(existsSync(drainFile(home.path)), false, "hold refuses before writing");
	const record = { state: "draining", started_at: "2026-09-27T12:00:00Z", deadline: timeout ? "2026-09-27T12:00:01Z" : "2099-01-01T00:00:00Z", timeout_s: 30, jobs: [] };
	writeFileSync(drainFile(home.path), JSON.stringify(record));
	assert.match(await command("/cp-drain 30"), /draining since/);
	if (timeout) {
		await waitFor(() => readDrain(home.path), (r) => r?.state === "timeout", { what: "compact hold timeout" });
		assert.deepEqual(readDrain(home.path)?.survivors, ["parent compaction"]);
	} else {
		assert.equal(readDrain(home.path)?.state, "draining");
		await assert.rejects(waitFor(() => readDrain(home.path)?.state, (state) => state !== "draining", { timeoutMs: 6000, what: "drain stays blocked through an orchestration tick" }), /timed out/);
		writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 100_000 }));
		child.send({ type: "compact", id: "release-hold" });
		const response = await child.waitFor((r) => r.type === "response" && r.id === "release-hold", 30_000);
		assert.equal(response.success, true, JSON.stringify(response));
		await waitFor(() => readDrain(home.path), (r) => r?.state === "drained", { what: "compact completion releases drain" });
	}
});
