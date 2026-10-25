/**
 * P8f: optional worker packages through cp_dispatch on real pi workers (behavior 04). Fake packages sit in the
 * parent's pi agent dir exactly as `pi install` lays them out; each worker's argv, environment and offered tools are
 * read from the live process and the model's first request.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PACKAGE_FLAGS, PACKAGE_TOOLS } from "../../src/worker-packages.ts";
import { type ScriptStep, treehouseAvailable, waitFor, WORKER_REPORTER_EXTENSION } from "../harness/index.ts";
import { configure, environ, fakeExtension, flagValues, installPackage, offeredTools, type PackageBench, packageBench, writeSkill } from "../harness/package-home.ts";

const SKIP = treehouseAvailable() ? false : "worker-packages-p8f e2e needs treehouse on PATH";
const HANG: ScriptStep = { kind: "hang" };
const LENS_FLAGS = [...(PACKAGE_FLAGS["pi-lens"] ?? [])];
const LENS_TOOLS = [...(PACKAGE_TOOLS["pi-lens"] ?? [])];
const WEB_TOOLS = [...(PACKAGE_TOOLS["pi-web-access"] ?? [])];
const HASHLINE_ONLY = /tools resolve to nothing: replace, insert, anchor_grep, undo_last_change/;

/** Dispatch one hanging worker and return what it was spawned with once its model has been called. */
async function spawned(f: PackageBench, slug: string, kind: "ship" | "research", extra: { profile?: string; skills?: string[] } = {}) {
	const jobId = await f.job(slug, kind);
	await f.post.dispatch({ jobId, task: "Do the job.", model: f.script(slug, [HANG]), fetch: false, ...extra });
	await waitFor(() => f.provider.requests(slug).length, (n) => n >= 1, { timeoutMs: 60_000, what: `${slug}'s first request` });
	const pid = f.post.fleet.require(jobId).worker.pid as number;
	// pi retitles its process, so /proc cmdline no longer holds the argv; the manager keeps the exec'd one.
	const args = f.post.manager.get(jobId)?.plan.args ?? [];
	return { jobId, args, env: environ(pid), tools: flagValues(args, "--tools").join(",").split(","), offered: offeredTools(f.provider.requests(slug)[0]) };
}

test("P8f packages: each dispatched role loads only its installed packages and their tools, never caveman, a skill file or a never-list skill; an operator-named skill reaches its own job", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const log = join(mkdtempSync(join(tmpdir(), "p8f-loads-")), "loads.log");
	t.after(() => rmSync(join(log, ".."), { recursive: true, force: true }));
	const ext: Record<string, string> = {};
	const f = await packageBench(t, {
		setup(agentDir) {
			const ponytail = installPackage(agentDir, "@dietrichgebert/ponytail", { extensions: ["./pi-extension/index.js"], skills: ["./skills"] },
				{ "pi-extension/index.js": fakeExtension("ponytail", log) });
			writeSkill(join(ponytail, "skills"), "ponytail");
			ext.ponytail = join(ponytail, "pi-extension/index.js");
			ext.caveman = join(installPackage(agentDir, "pi-caveman", { extensions: ["./extensions/caveman.ts"] }, { "extensions/caveman.ts": fakeExtension("caveman", log) }), "extensions/caveman.ts");
			ext.lens = join(installPackage(agentDir, "pi-lens", { extensions: ["./dist/index.js"] }, { "dist/index.js": fakeExtension("lens", log, { tools: LENS_TOOLS, flags: LENS_FLAGS.map((flag) => flag.slice(2)) }) }), "dist/index.js");
			ext.web = join(installPackage(agentDir, "pi-web-access", { extensions: ["./index.ts"] }, { "index.ts": fakeExtension("web", log, { tools: [...WEB_TOOLS, "web_enable"] }) }), "index.ts");
			// Single skills in ~/.pi/agent/skills and a git package of skills, never-list ones among them.
			for (const name of ["verification-before-completion", "systematic-debugging"]) writeSkill(join(agentDir, "skills"), name);
			const repo = join(agentDir, "git/github.com/obra/superpowers");
			mkdirSync(repo, { recursive: true });
			writeFileSync(join(repo, "package.json"), JSON.stringify({ pi: { skills: ["./skills"] } }));
			for (const name of ["test-driven-development", "writing-plans", "brainstorming", "requesting-code-review"]) writeSkill(join(repo, "skills"), name);
			configure(agentDir, "git:github.com/obra/superpowers");
		},
	});
	const implementer = await spawned(f, "impl", "ship");
	const planner = await spawned(f, "plan", "research");
	const qa = await spawned(f, "qa", "research", { profile: "qa", skills: ["systematic-debugging"] });
	const roles = { implementer, planner, qa };

	assert.deepEqual(flagValues(implementer.args, "-e"), [WORKER_REPORTER_EXTENSION, ext.ponytail, ext.lens], "an implementer: ponytail and pi-lens");
	assert.deepEqual(flagValues(planner.args, "-e"), [WORKER_REPORTER_EXTENSION, ext.lens, ext.web], "a planner: pi-lens and pi-web-access");
	assert.deepEqual(flagValues(qa.args, "-e"), [WORKER_REPORTER_EXTENSION, ext.lens, ext.web], "qa is the planner role");
	for (const [name, worker] of Object.entries(roles)) {
		assert.ok(worker.args.includes("--no-extensions") && worker.args.includes("--no-skills"), `${name}: discovery stays off`);
		for (const flag of LENS_FLAGS) assert.ok(worker.args.includes(flag), `${name}: pi-lens runs headless with ${flag}`);
		assert.ok(worker.env.PI_LENS_HOME, `${name}: pi-lens logs are pinned out of the worktree`);
		assert.ok(worker.tools.includes("ast_grep_search") && worker.offered.includes("ast_grep_search"), `${name}: pi-lens's tools reach the model`);
		assert.equal(worker.tools.includes("web_enable") || worker.offered.includes("web_enable"), false, `${name}: the lazy web loader never`);
		const web = name === "planner" || name === "qa";
		assert.equal(WEB_TOOLS.every((tool) => worker.tools.includes(tool) && worker.offered.includes(tool)), web, `${name}: web tools`);
		assert.equal(worker.offered.some((tool) => WEB_TOOLS.includes(tool)), web, `${name}: the model sees web tools only in the planner role`);
	}
	assert.deepEqual(flagValues(implementer.args, "--skill"), [], "no package, single or git skill file reaches a worker");
	assert.deepEqual(flagValues(planner.args, "--skill"), []);
	assert.deepEqual(flagValues(qa.args, "--skill"), [join(f.agentDir.path, "skills/systematic-debugging")], "only the operator-named skill, for its own job");
	const loads = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
	assert.equal(loads.includes("caveman"), false, "no role ever loads caveman");
	assert.deepEqual(loads.filter((name) => name === "ponytail").length, 1, "ponytail loads for the implementer only");
	assert.equal(loads.filter((name) => name === "lens").length, 3);
	// No hashline package here: the implementer's profile names its tools, and the run log says so.
	assert.match(String(f.events(implementer.jobId, "worker_packages_unresolved")[0]?.error), new RegExp(`^profile implementer ${HASHLINE_ONLY.source}`));
});

test("P8f package faults: a failed resolution spawns the bare argv and says why; an unkeyed web provider withholds pi-web-access until a key arrives; a directory manifest reaches -e as entry files", { skip: SKIP, timeout: 300_000 }, async (t) => {
	await t.test("broken settings.json", async (t) => {
		const broken = mkdtempSync(join(tmpdir(), "p8f-broken-"));
		t.after(() => rmSync(broken, { recursive: true, force: true }));
		writeFileSync(join(broken, "settings.json"), "{ not json");
		const f = await packageBench(t, { resolveFrom: broken });
		const worker = await spawned(f, "broken", "ship");
		assert.deepEqual(flagValues(worker.args, "-e"), [WORKER_REPORTER_EXTENSION], "nothing resolved: only the reporter");
		assert.deepEqual(flagValues(worker.args, "--skill"), []);
		const error = String(f.events(worker.jobId, "worker_packages_unresolved")[0]?.error);
		assert.match(error, new RegExp(`^.+; profile implementer ${HASHLINE_ONLY.source}`), "pi's own failure leads the run-log line");
	});

	const web = (configText: string, env: NodeJS.ProcessEnv) => async (t: TestContext) => {
		let entry = "";
		const f = await packageBench(t, {
			env,
			setup(agentDir) {
				entry = join(installPackage(agentDir, "pi-web-access", { extensions: ["./index.ts"] }, { "index.ts": fakeExtension("web", join(agentDir, "loads.log"), { tools: WEB_TOOLS }) }), "index.ts");
				writeFileSync(join(agentDir, "web-search.json"), configText);
			},
		});
		const worker = await spawned(f, "web", "research");
		return { entry, worker };
	};
	await t.test("brave without a key", async (t) => {
		const { entry, worker } = await web(JSON.stringify({ searchProvider: "brave" }), { BRAVE_API_KEY: "" })(t);
		assert.equal(flagValues(worker.args, "-e").includes(entry), false, "an unusable provider is absence");
		assert.equal(worker.offered.some((tool) => WEB_TOOLS.includes(tool)), false);
	});
	await t.test("brave with a key", async (t) => {
		const { entry, worker } = await web(JSON.stringify({ searchProvider: "brave" }), { BRAVE_API_KEY: "k" })(t);
		assert.ok(flagValues(worker.args, "-e").includes(entry), "the key restores the package");
		assert.ok(WEB_TOOLS.every((tool) => worker.offered.includes(tool)));
	});
	await t.test("unparseable web-search.json", async (t) => {
		const { entry, worker } = await web("{", { BRAVE_API_KEY: "" })(t);
		assert.equal(flagValues(worker.args, "-e").includes(entry), false);
	});

	await t.test("directory-style manifest", async (t) => {
		let dir = "";
		const f = await packageBench(t, {
			setup(agentDir) {
				const log = join(agentDir, "loads.log");
				dir = installPackage(agentDir, "@dietrichgebert/ponytail", { extensions: ["./extensions"] }, {
					"extensions/a.ts": fakeExtension("a", log),
					"extensions/nested/index.ts": fakeExtension("nested", log),
					"extensions/README.md": "not an extension\n",
					"extensions/no-entry-point/helper.ts": fakeExtension("helper", log),
				});
			},
		});
		const worker = await spawned(f, "dir", "ship");
		assert.deepEqual(flagValues(worker.args, "-e"), [WORKER_REPORTER_EXTENSION, join(dir, "extensions/a.ts"), join(dir, "extensions/nested/index.ts")]);
		assert.deepEqual(readFileSync(join(f.agentDir.path, "loads.log"), "utf8").trim().split("\n").map((line) => line.split(" ")[0]).sort(), ["a", "nested"], "each entry point loads in the worker");
	});
});
