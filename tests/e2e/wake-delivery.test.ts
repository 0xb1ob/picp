import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FleetStore } from "../../src/fleet.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";

test("S20: shipped rows collapse through cp_status_block and survive a resumed parent", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-status", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "text", text: "Status reported." },
	]);
	const resumedModel = provider.addScript("s20-resumed", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "text", text: "Status still reported." },
	]);
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const now = isoTimestamp();
	await new FleetStore({ home: home.path }).add({
		job_id: "cp-s20-shipped", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "done", worktree: join(home.path, "wt"), branch: "cp-s20-shipped", dispatched_at: now,
		reported_at: now, closed_at: now, closed_reason: "gated", usage: EMPTY_USAGE,
		receipts: [{ kind: "pr", status: "merged", title: "Shipped", url: "https://github.com/example/demo/pull/20" }],
		worker: { pid: 4242, session_id: "s20-worker", session_file: join(home.path, "worker.jsonl"),
			profile: "implementer", role: "implementer", model, started_at: now, exited_at: now, exit_code: 0 },
	});
	const env = { ...agent.env, CP_HOME: home.path };
	const first = startPiChild({
		cwd: home.path, model, env, extensions: [COMMAND_POST_EXTENSION], sessionDir: join(home.path, "sessions"),
	});
	children.push(first);
	await first.prompt("Render the status twice.");
	await first.waitForSettled(60_000);
	const results = first.eventsOfType("tool_execution_end").filter((r) => r.toolName === "cp_status_block");
	assert.equal(results.length, 2);
	assert.match(JSON.stringify(results[0]), /pull\/20/);
	assert.match(JSON.stringify(results[1]), /none new \(1 already reported\)/);
	const state = await first.getState();
	assert.equal(typeof state.sessionFile, "string");
	await first.close();
	const resumed = startPiChild({
		cwd: home.path, model: resumedModel, env, extensions: [COMMAND_POST_EXTENSION],
		sessionFile: state.sessionFile as string,
	});
	children.push(resumed);
	await resumed.prompt("Render status after resuming.");
	await resumed.waitForSettled(60_000);
	const result = resumed.eventsOfType("tool_execution_end").find((r) => r.toolName === "cp_status_block");
	assert.match(JSON.stringify(result), /none new \(1 already reported\)/);
	assert.doesNotMatch(JSON.stringify(result), /pull\/20/);
	assert.equal(provider.remaining("s20-status"), 0);
	assert.equal(provider.remaining("s20-resumed"), 0);
});
