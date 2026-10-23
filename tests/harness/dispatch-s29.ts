import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, MOCK_PROVIDER_ID, MockProvider, startPiChild, type ScriptStep } from "./index.ts";

export async function dispatchS29(t: TestContext, options: { files?: Record<string, string> } = {}) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", ...options.files } });
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const clone = registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 16 });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => { for (const child of children) await child.close(); agent.cleanup(); await provider.stop(); pool.cleanup(); scratch.cleanup(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	let serial = 0;
	return {
		home: home.path, clone, ledger: scratch.ledger, provider, agent,
		async run(steps: ScriptStep[], env: NodeJS.ProcessEnv = {}) {
			const name = `s29-parent-${serial++}`;
			const model = provider.addScript(name, [...steps, { kind: "text", text: "observed" }]);
			agent.writeModels(provider);
			const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path, ...env }, extensions: [COMMAND_POST_EXTENSION] });
			children.push(child);
			await child.prompt("Execute the supplied dispatch checks.");
			await child.waitForSettled(90_000);
			return child.eventsOfType("tool_execution_end") as unknown as Array<{ toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } }>;
		},
	};
}
