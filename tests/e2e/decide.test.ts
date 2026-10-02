/**
 * cp_decide over a real parent: operator quote from the user message decides a checkpoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointStore } from "../../src/checkpoint.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MOCK_PROVIDER_ID,
	MockProvider,
	startPiChild,
} from "../harness/index.ts";

test("cp_decide with an operator quote approves a pending checkpoint", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: "cp-ship1", question: "Authorize implementation?" });

	const provider = await MockProvider.start();
	const quote = "Please approve the plan.";
	const script = "cp-decide-quote";
	const model = `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`;
	provider.addScript(script, [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "cp_decide",
					args: {
						target: "aw-checkpoint-cp-ship1",
						decision: "approve",
						basis: { operator_quote: quote },
					},
				},
			],
		},
		{ kind: "text", text: "decided" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model,
		env: { ...agentDir.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});

	await child.prompt(`${quote} Ship it today.`);
	await child.waitForSettled(90_000);

	const end = child.eventsOfType("tool_execution_end").find((record) => record.toolName === "cp_decide");
	assert.ok(end, "cp_decide was not called");
	assert.notEqual(end.isError, true, `cp_decide failed: ${JSON.stringify(end.result)}`);
	const record = checkpoints.get("cp-ship1");
	assert.equal(record?.decision, "approved");
	assert.equal(record?.decided_by, "operator-quote");
	assert.ok(record?.basis && "operator_quote" in record.basis);
});
