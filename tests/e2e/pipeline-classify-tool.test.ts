/**
 * Routing T6: the `cp_pipeline classify` tool boundary, and the criteria the
 * parent reads beside the two routing enums.
 *
 * `classifyIntake` has always taken `kind`, and the tool never offered it — so
 * a parent that already knew "the operator asked for research" had no way to
 * say so, and got the keyword answer for the task text instead ("investigate
 * …" reads as a pipeline). The pure classifier is covered in
 * P11d-classify below, through this same tool; what can only be proven here is that pi actually
 * offers the parameter to a model and actually carries it through the call.
 *
 * Style follows `tests/e2e/dispatch-preview-s28.test.ts`: a real `pi --mode rpc`
 * parent with the command-post extension loaded and the scriptable mock
 * provider as its model, so "the parameter exists" is a fact about the tool
 * schema pi published, not about a string in the source.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RISK_CRITERIA, SCOPE_CRITERIA } from "../../src/contracts.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MOCK_PROVIDER_ID,
	MockProvider,
	startPiChild,
} from "../harness/index.ts";

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

type ClassifyCase = { args: Record<string, unknown>; mode?: string; not?: string; forced?: boolean };
const CLASSIFY_CASES: ClassifyCase[] = [
	...[
		"Figure out why the nightly job times out",
		"Refactor the auth module",
		"Rename the config key across all services",
		"We need a plan for migrating to the new schema",
		"Something is wrong somewhere in billing",
	].map((task) => ({ args: { task }, mode: "pipeline" })),
	...["Fix the typo in README.md", "Bump the version to 1.2.3", "Update the changelog for the release"].map(
		(task) => ({ args: { task }, mode: "single" }),
	),
	{ args: { task: "Add a flag", scope: "L" }, mode: "pipeline" },
	{ args: { task: "Add a flag", risk: "high" }, mode: "pipeline" },
	{ args: { task: "Refactor everything", force: "single" }, mode: "single", forced: true },
	{ args: { task: "Investigate the flake", kind: "research" }, mode: "single" },
	...[
		"Where is the retry ladder configured?",
		"which module owns the lease pool?",
		"Does the widget read fleet.json directly?",
		"How many profiles does this package have?",
	].map((task) => ({ args: { task }, mode: "qa", forced: false })),
	...[
		"Can you refactor the auth module?",
		"Should we migrate to the new schema? Write the plan.",
		"How many profiles ship in this package?",
		`Why ${"very ".repeat(45)}slow?`,
	].map((task) => ({ args: { task }, not: "qa" })),
	{ args: { task: "Where is the retry ladder configured?", scope: "L" }, not: "qa" },
	{ args: { task: "Where is the retry ladder configured?", kind: "ship" }, not: "qa" },
	{ args: { task: "Refactor everything", force: "qa" }, mode: "qa", forced: true },
];

/** P11d-classify: the deleted classifier units' inputs, through the cp_pipeline classify tool a model calls. */
test("P11d-classify: single, pipeline and qa are advisory, and forcing or a settled kind wins", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "pipeline-classify-modes";
	provider.addScript(script, [
		...CLASSIFY_CASES.map((c) => ({
			kind: "tool_calls" as const,
			calls: [{ name: "cp_pipeline", args: { action: "classify", ...c.args } }],
		})),
		{ kind: "text", text: "classified" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model: `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`,
		env: { ...agentDir.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});
	await child.prompt("classify these");
	await child.waitForSettled(90_000);

	const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_pipeline");
	assert.equal(ends.length, CLASSIFY_CASES.length, `expected ${CLASSIFY_CASES.length} cp_pipeline calls, got ${ends.length}`);
	CLASSIFY_CASES.forEach((c, i) => {
		const result = (ends[i] as { result?: { details?: { mode?: string; forced?: boolean; reasons?: string[] } } }).result;
		const details = result?.details ?? {};
		const label = `${JSON.stringify(c.args).slice(0, 80)} -> ${JSON.stringify(details)}`;
		if (c.mode) assert.equal(details.mode, c.mode, label);
		if (c.not) assert.ok(details.mode && details.mode !== c.not, label);
		if (c.forced !== undefined) assert.equal(details.forced, c.forced, label);
		assert.ok((details.reasons ?? []).length > 0, `${label}: reasons are stated`);
	});
});
