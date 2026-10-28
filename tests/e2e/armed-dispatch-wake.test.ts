import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, MockProvider, readRunEvents, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";

// An armed dispatch refused after its blockers close has no fleet record: its DROPPED notice must still reach
// the parent (it used to be superseded as "every candidate ... torn down") and must leave no status.json stub.
test("armed dispatch dropped at release wakes the parent and leaves no stub status", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	const provider = await MockProvider.start();
	initJobsDocument(home.path, "cp");
	const setup = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await setup.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const blocker = await setup.ledger().create({ title: "blocker", project: "demo", delivery: "local", kind: "ship" });
	const armed = await setup.ledger().create({ title: "armed", project: "demo", delivery: "local", kind: "ship" });
	await setup.ledger().addDep(armed.id, blocker.id);
	await setup.shutdown();
	const taskFile = join(home.path, "armed-task.md");
	writeFileSync(taskFile, "Do the armed work.\n");
	const watch = provider.addScript("armed-wake-watch", [{ kind: "text", text: "noted" }, { kind: "text", text: "noted again" }]);
	const arm = provider.addScript("armed-wake-arm", [
		{ kind: "tool_calls", calls: [{ name: "cp_job", args: { action: "amend", job_id: armed.id, text: "Also keep the change small.", quote: "keep the change small", reason: "pre-start scope" } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: armed.id, task_file: taskFile } }] },
		{ kind: "text", text: "armed" },
	]);
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup(); });
	const first = startPiChild({ cwd: home.path, model: arm, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	await first.prompt(`Please keep the change small for ${armed.id}, then dispatch it.`);
	await first.waitForSettled(60_000);
	await first.close();
	const ends = first.eventsOfType("tool_execution_end") as Array<{ toolName?: string; isError?: boolean; result?: unknown }>;
	assert.match(JSON.stringify(ends.find((end) => end.toolName === "cp_dispatch")?.result), /"state":"armed"/);

	rmSync(taskFile);
	const closer = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await closer.ledger().close(blocker.id, "done");
	await closer.shutdown();
	const second = startPiChild({ cwd: home.path, model: watch, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => second.close());
	const seen = () => JSON.stringify(provider.requests("armed-wake-watch").map((r) => r.body.messages));
	await waitFor(seen, (body) => body.includes("ARMED DISPATCH DROPPED"), { timeoutMs: 60_000, what: "the DROPPED notice in a provider request" });
	assert.match(seen(), new RegExp(`does not exist[^"]*— ${armed.id}`));
	const suppressed = existsSync(join(home.path, paths.eventsFile(armed.id))) && readRunEvents(home.path, armed.id).some((event) => event.type === "wakeup_suppressed");
	assert.equal(suppressed, false);
	assert.equal(existsSync(join(home.path, paths.statusFile(armed.id))), false);
	assert.deepEqual(JSON.parse(readFileSync(join(home.path, LAYOUT.armedDispatchFile), "utf8")).entries, []);
});
