/**
 * Routing T5: the `cp_dispatch dry_run` tool boundary.
 *
 * The preview's own resolution is proven in `tests/dispatch.test.ts`; this is
 * the surface, in the style of `tests/review-tool.test.ts` — a real `pi --mode
 * rpc` parent with the command-post extension loaded and the scriptable mock
 * provider as its model, so "the parameter exists" means pi actually offered it
 * to a model and actually ran the call.
 *
 * Three properties, each of which the design can lose while the code still
 * looks right:
 *
 *  1. `dry_run` is an optional parameter on `cp_dispatch` itself, not a second
 *     tool and not a second subsystem (issue §Implementation 3).
 *  2. It answers with the route: effective inputs and provenance, source/rule,
 *     model and effort, and what the probe knows about the model.
 *  3. It takes nothing. No lease, no branch, no worker, no fleet record, no run
 *     directory, no brief, no session, and no ledger claim (§Implementation 4).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchLedger,
	MOCK_PROVIDER_ID,
	MockProvider,
	startPiChild,
} from "./harness/index.ts";

interface ToolSpec {
	function?: { name?: string; description?: string; parameters?: { properties?: Record<string, unknown> } };
	name?: string;
}

test("cp_dispatch offers dry_run, previews the route, and takes nothing", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const job = await scratch.ledger.create({
		title: "bump x",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		slug: "bump-x",
	});

	const provider = await MockProvider.start();
	// The script's own model, computed before the script is registered so the tool
	// call can name it: the route must resolve against a model this hermetic
	// registry really has, since the point under test is the preview and not which
	// model a scratch home happens to reach.
	const script = "dispatch-preview-tool";
	const model = `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`;
	assert.equal(
		provider.addScript(script, [
			{
				kind: "tool_calls",
				calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x to 2 in src/app.ts.", model, dry_run: true } }],
			},
			{
				kind: "tool_calls",
				// A model this home's own allowlist refuses. Routing throws for it, and
				// the preview reports that refusal rather than failing the call: "it
				// would be refused, for this reason" is the answer to what a dispatch
				// would do (docs/contracts.md §The route preview).
				calls: [
					{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x to 2 in src/app.ts.", model: "forbidden/model", dry_run: true } },
				],
			},
			{ kind: "text", text: "previewed" },
		]),
		model,
	);
	// The allowlist is this home's own policy, and it must not refuse the mock
	// model the first call names.
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.routingFile),
		JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }),
	);
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
		scratch.cleanup();
		home.cleanup();
	});

	await child.prompt(`preview the route for ${job.id}`);
	await child.waitForSettled(60_000);

	// 1. Registration, as pi itself reports the tool to the model: one tool, with
	//    dry_run among its optional parameters.
	const offered = (provider.requests(script)[0]?.body.tools as ToolSpec[] | undefined)?.find(
		(tool) => (tool.function?.name ?? tool.name) === "cp_dispatch",
	);
	assert.ok(offered, "cp_dispatch was not offered to the model");
	const properties = Object.keys(offered.function?.parameters?.properties ?? {});
	assert.ok(properties.includes("dry_run"), `dry_run is not on cp_dispatch: ${properties.join(", ")}`);

	// 2. The answer: the whole decision, through the ordinary tool result.
	const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_dispatch");
	assert.equal(ends.length, 2, `expected two cp_dispatch calls, got ${ends.length}`);
	const end = ends[0] as { isError?: boolean; result?: unknown };
	assert.notEqual(end.isError, true, `the preview failed: ${JSON.stringify(end.result)}`);
	const text = JSON.stringify(end.result ?? {});
	assert.match(text, /"preview":true/);
	assert.match(text, new RegExp(`"job_id":"${job.id}"`));
	assert.match(text, /"profile":"implementer"/);
	assert.match(text, /"source":"override"/);
	assert.match(text, /"provenance"/);
	assert.match(text, /"availability"/);

	// 2b. A model the allowlist refuses comes back as a *preview* naming the
	//     refusal, not as a failed tool call: the whole point of asking is to
	//     hear what a dispatch would do, and a refusal is an answer.
	const refused = ends[1] as { isError?: boolean; result?: unknown };
	assert.notEqual(refused.isError, true, `a routing refusal must not fail the preview: ${JSON.stringify(refused.result)}`);
	const refusedText = JSON.stringify(refused.result ?? {});
	assert.match(refusedText, /"preview":true/);
	assert.match(refusedText, /the allowlist refuses/);
	assert.doesNotMatch(refusedText, /"decision"/, "a refused route has no decision to report");
	assert.match(refusedText, /"routing"/, "the inputs are still knowable when the model is not");

	// 3. Nothing was taken. A dispatch would have written every one of these.
	assert.equal(existsSync(join(home.path, LAYOUT.fleetFile)), false, "a preview wrote a fleet record");
	assert.equal(existsSync(join(home.path, paths.runDir(job.id))), false, "a preview created a run directory");
	assert.equal(existsSync(join(home.path, paths.briefFile(job.id))), false, "a preview wrote a brief");
	assert.equal(existsSync(join(home.path, LAYOUT.sessions)), false, "a preview created a worker session");
	assert.equal((await scratch.ledger.show(job.id)).status, "open", "a preview claimed the job in the ledger");
});
