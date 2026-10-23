import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { LAYOUT, SCHEMA_VERSION, THINKING_LEVELS } from "../../src/contracts.ts";
import type { CommandPost } from "../../src/command-post.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, MOCK_PROVIDER_ID, MockProvider, startPiChild, type ScriptStep } from "./index.ts";

export async function dispatchS29(t: TestContext, options: { files?: Record<string, string>; emptyThinking?: boolean } = {}) {
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
	const posts: CommandPost[] = [];
	t.after(async () => { for (const child of children) await child.close(); for (const post of posts) await post.shutdown(); agent.cleanup(); await provider.stop(); pool.cleanup(); scratch.cleanup(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	let serial = 0;
	return {
		home: home.path, clone, ledger: scratch.ledger, provider, agent,
		ownPost(post: CommandPost) { posts.push(post); return post; },
		async closeParents() { for (const child of children) await child.close(); },
		async run(steps: ScriptStep[], env: NodeJS.ProcessEnv = {}, prompt = "Execute the supplied dispatch checks.") {
			const name = `s29-parent-${serial++}`;
			const model = provider.addScript(name, [...steps, { kind: "text", text: "observed" }]);
			agent.writeModels(provider);
			if (options.emptyThinking) {
				const config = provider.modelsJson();
				for (const entry of Object.values(config.providers)) {
					for (const model of (entry as { models: Record<string, unknown>[] }).models) {
						model.reasoning = true;
						model.thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [level, null]));
					}
				}
				writeFileSync(join(agent.path, "models.json"), JSON.stringify(config));
			}
			const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path, ...env }, extensions: [COMMAND_POST_EXTENSION] });
			children.push(child);
			await child.prompt(prompt);
			await child.waitForSettled(90_000);
			return child.eventsOfType("tool_execution_end") as unknown as Array<{ toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } }>;
		},
	};
}
