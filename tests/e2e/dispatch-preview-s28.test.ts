import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MOCK_PROVIDER_ID, MockProvider, startPiChild } from "../harness/index.ts";

test("S28: cp_dispatch previews permitted and refused routes without claiming resources", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const job = await scratch.ledger.create({ title: "bump x", project: "demo", delivery: "pr", kind: "ship" });
	const provider = await MockProvider.start();
	const script = "s28-preview";
	const model = `${MOCK_PROVIDER_ID}/${provider.modelId(script)}`;
	provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x to 2 in src/app.ts.", model, dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x to 2 in src/app.ts.", model: "forbidden/model", dry_run: true } }] },
		{ kind: "text", text: "previewed" },
	]);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); scratch.cleanup(); home.cleanup(); });
	await child.prompt(`preview ${job.id}`);
	await child.waitForSettled(60_000);
	const tools = provider.requests(script)[0]?.body.tools as Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>;
	const offered = tools.find((tool) => tool.function?.name === "cp_dispatch");
	assert.ok(offered, "cp_dispatch is offered");
	assert.ok("dry_run" in (offered.function?.parameters?.properties ?? {}), "dry_run is offered");
	const ends = child.eventsOfType("tool_execution_end").filter((event) => event.toolName === "cp_dispatch") as Array<{ isError?: boolean; result?: unknown }>;
	assert.equal(ends.length, 2);
	for (const end of ends) assert.notEqual(end.isError, true, JSON.stringify(end.result));
	const permitted = JSON.stringify(ends[0]!.result);
	for (const fragment of ['"preview":true', `"job_id":"${job.id}"`, '"profile":"implementer"', '"source":"override"', '"provenance"', '"availability"']) assert.ok(permitted.includes(fragment), fragment);
	const refused = JSON.stringify(ends[1]!.result);
	assert.match(refused, /"preview":true/);
	assert.match(refused, /the allowlist refuses/);
	assert.doesNotMatch(refused, /"decision"/);
	assert.match(refused, /"routing"/);
	for (const path of [LAYOUT.fleetFile, paths.runDir(job.id), paths.briefFile(job.id), LAYOUT.sessions]) assert.equal(existsSync(join(home.path, path)), false, `preview wrote ${path}`);
	assert.equal((await scratch.ledger.show(job.id)).status, "open");
	assert.equal(provider.remaining(script), 0);
});
