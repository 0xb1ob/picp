/**
 * Routing T6: the `cp_pipeline classify` tool boundary, and the criteria the
 * parent reads beside the two routing enums.
 *
 * `classifyIntake` has always taken `kind`, and the tool never offered it — so
 * a parent that already knew "the operator asked for research" had no way to
 * say so, and got the keyword answer for the task text instead ("investigate
 * …" reads as a pipeline). The pure classifier is covered in
 * `tests/pipeline.test.ts`; what can only be proven here is that pi actually
 * offers the parameter to a model and actually carries it through the call.
 *
 * Style follows `tests/dispatch-preview-tool.test.ts`: a real `pi --mode rpc`
 * parent with the command-post extension loaded and the scriptable mock
 * provider as its model, so "the parameter exists" is a fact about the tool
 * schema pi published, not about a string in the source.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RISK_CRITERIA, SCOPE_CRITERIA } from "../src/contracts.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MOCK_PROVIDER_ID,
	MockProvider,
	startPiChild,
} from "./harness/index.ts";

interface ToolSpec {
	function?: { name?: string; description?: string; parameters?: { properties?: Record<string, { description?: string }> } };
	name?: string;
}

const RESEARCH_TASK = "Investigate why the gate reviewer occasionally reports an operational fault, and write up the options.";

test("cp_pipeline classify offers kind, and the routing enums carry their criteria", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "pipeline-classify-tool";
	const model = `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`;
	provider.addScript(script, [
		{
			kind: "tool_calls",
			// The operator already said this is research. With `kind` the answer is
			// one research job; without it the same words recommend a pipeline.
			calls: [{ name: "cp_pipeline", args: { action: "classify", task: RESEARCH_TASK, kind: "research" } }],
		},
		{
			kind: "tool_calls",
			calls: [{ name: "cp_pipeline", args: { action: "classify", task: RESEARCH_TASK } }],
		},
		{ kind: "text", text: "classified" },
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

	await child.prompt(`classify this: ${RESEARCH_TASK}`);
	await child.waitForSettled(60_000);

	// 1. The schema pi published to the model.
	const tools = provider.requests(script)[0]?.body.tools as ToolSpec[] | undefined;
	const named = (name: string): ToolSpec | undefined => tools?.find((tool) => (tool.function?.name ?? tool.name) === name);
	const pipeline = named("cp_pipeline");
	assert.ok(pipeline, "cp_pipeline was not offered to the model");
	const properties = pipeline.function?.parameters?.properties ?? {};
	assert.ok("wall_clock_seconds" in properties, "pipeline start must offer the per-stage wall-clock override");
	assert.ok("kind" in properties, `kind is not on cp_pipeline: ${Object.keys(properties).join(", ")}`);
	assert.match(String(properties.kind?.description), /kind:research is one research job/);

	// 2. The criteria travel with the enums, on both tools that accept them: a
	//    bare `S|M|L` is what left the parent guessing what S meant.
	for (const toolName of ["cp_pipeline", "cp_dispatch"]) {
		const offered = named(toolName)?.function?.parameters?.properties ?? {};
		assert.equal(offered.scope?.description, SCOPE_CRITERIA, `${toolName} scope has no criteria`);
		assert.equal(offered.risk?.description, RISK_CRITERIA, `${toolName} risk has no criteria`);
	}
	// The workflow choice and the resource choice are named as separate
	// decisions where the parent reads them.
	assert.match(String(named("cp_pipeline")?.function?.description), /separate choices/);

	// 3. The call itself: kind changes the answer, and dropping it loses the
	//    research intent — which is the whole reason for the pass-through.
	const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_pipeline");
	assert.equal(ends.length, 2, `expected two cp_pipeline calls, got ${ends.length}`);
	const withKind = JSON.stringify((ends[0] as { result?: unknown }).result ?? {});
	assert.match(withKind, /"mode":"single"/);
	assert.match(withKind, /kind:research is a single research job/);
	const withoutKind = JSON.stringify((ends[1] as { result?: unknown }).result ?? {});
	assert.match(withoutKind, /"mode":"pipeline"/);
});
