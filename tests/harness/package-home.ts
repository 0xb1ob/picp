/**
 * A command post whose pi agent dir holds fake worker packages laid out as `pi install npm:<name>` would (P8f), so
 * detection, role activation and the argv run against real dispatched workers. The parent resolves packages from
 * `PI_CODING_AGENT_DIR` in its own env, set for the whole test.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandPost } from "../../src/command-post.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { type AgentDir, createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, readRunEvents, REPO_ROOT,
	type RecordedRequest, type ScriptStep, treehouse } from "./index.ts";

/** A fake package extension: appends `<name> <job>` to `log` on load, registers `flags` and echoing `tools`. */
export function fakeExtension(name: string, log: string, options: { tools?: readonly string[]; flags?: readonly string[] } = {}): string {
	return `import { appendFileSync } from "node:fs";
export default function (pi) {
	appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + process.env.CP_JOB_ID + "\\n");
	for (const flag of ${JSON.stringify(options.flags ?? [])}) pi.registerFlag(flag, { type: "boolean" });
	for (const tool of ${JSON.stringify(options.tools ?? [])}) pi.registerTool({ name: tool, label: tool, description: "fake " + tool,
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: tool + ":ran" }], details: {} }; } });
}
`;
}

/** Install `files` under `<agentDir>/npm/node_modules/<name>` with a `pi` manifest, configured in settings.json. */
export function installPackage(agentDir: string, name: string, manifest: unknown, files: Record<string, string> = {}): string {
	const dir = join(agentDir, "npm/node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: manifest }));
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), body);
	}
	configure(agentDir, `npm:${name}`);
	return dir;
}

/** Add a package source to the agent dir's settings.json, as `pi install` would. */
export function configure(agentDir: string, source: string): void {
	const file = join(agentDir, "settings.json");
	const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown[] }) : {};
	settings.packages = [...(settings.packages ?? []), source];
	writeFileSync(file, JSON.stringify(settings));
}

/** A skill directory `<dir>/<name>/SKILL.md`. */
export function writeSkill(dir: string, name: string): string {
	const skill = join(dir, name);
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
	return skill;
}

/** A live worker's environment, from /proc. */
export const environ = (pid: number): Record<string, string> => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8")
	.split("\0").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
export const flagValues = (args: readonly string[], flag: string): string[] => args.flatMap((arg, i) => (arg === flag ? [args[i + 1] as string] : []));
/** Tool names a model was offered in one request. */
export const offeredTools = (request: RecordedRequest | undefined): string[] =>
	((request?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []).map((tool) => String(tool.function?.name));

export interface PackageBench {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	agentDir: AgentDir;
	job(slug: string, kind?: "ship" | "research", delivery?: "local" | "pr" | "pipeline" | "answer"): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	events(jobId: string, type: string): Array<Record<string, unknown>>;
}

/**
 * `setup` installs packages into the workers' agent dir before the parent starts; `resolveFrom` points the parent's
 * resolution elsewhere (a broken settings.json must not stop the workers' own pi). `env` joins the parent's env.
 */
export async function packageBench(t: { after(fn: () => void | Promise<void>): void }, options: { setup?: (agentDir: string) => void; resolveFrom?: string; env?: NodeJS.ProcessEnv } = {}): Promise<PackageBench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	options.setup?.(agentDir.path);
	initJobsDocument(home.path, "cp");
	const parentEnv = { PI_CODING_AGENT_DIR: options.resolveFrom ?? agentDir.path, ...options.env };
	// Workers inherit process.env, so an inherited PI_LENS_HOME would stand in for the pin pi-lens activation adds.
	const saved = Object.fromEntries(["PI_LENS_HOME", ...Object.keys(parentEnv)].map((key) => [key, process.env[key]]));
	delete process.env.PI_LENS_HOME;
	Object.assign(process.env, parentEnv);
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 8 });
	t.after(async () => {
		await post.shutdown();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	return {
		home: home.path,
		post,
		provider,
		agentDir,
		async job(slug, kind = "ship", delivery) {
			return (await post.ledger().create({ title: slug, project: "demo", delivery: delivery ?? (kind === "ship" ? "local" : "pipeline"), kind, slug })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps);
			agentDir.writeModels(provider);
			return model;
		},
		events(jobId, type) {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "cp" && event.type === type).map((event) => (event.payload ?? {}) as Record<string, unknown>);
		},
	};
}
