/**
 * T10 acceptance: registering, cloning and duplicate-clone rejection, plus the
 * ported "belongs to another repo" detection that keeps a lease out of the
 * wrong tree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import {
	assertCanonicalRepo,
	formatEnsured,
	formatProjects,
	ProjectError,
	ProjectRegistry,
	renderRegistry,
	sameRemote,
} from "../src/projects.ts";
import { Ledger } from "../src/ledger.ts";
import { classifyMergeFlow, detectMergePolicy, ghMergeFlowProbe, type MergeFlowFacts } from "../src/merge-policy-detect.ts";
import { createScratchHome, createScratchLedger, createScratchRepo, git, type ScratchHome, type ScratchRepo } from "./harness/index.ts";


test("reviewer preference persists, displays, replaces and clears; refusals do not write", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
	await registry.setReviewerModel("demo", "a/first");
	assert.equal(new ProjectRegistry({ home: home.path }).get("demo")?.reviewer_model, "a/first");
	assert.match(formatProjects(registry.list()), /a\/first/);
	await registry.setReviewerModel("demo", " b/second ");
	assert.equal(registry.get("demo")?.reviewer_model, "b/second");
	const before = readFileSync(registry.file, "utf8");
	for (const value of ["invalid", "   ", "a/has space", `a/${"x".repeat(129)}`]) await assert.rejects(registry.setReviewerModel("demo", value));
	await assert.rejects(registry.setReviewerModel("absent", null));
	assert.equal(readFileSync(registry.file, "utf8"), before);
	await registry.setReviewerModel("demo", null);
	assert.equal(new ProjectRegistry({ home: home.path }).get("demo")?.reviewer_model, undefined);
	assert.doesNotMatch(formatProjects(registry.list()), /reviewer model/);
});

test("after_merge_deploy stores, defaults its branch, refuses bad input, prints, and clears (#326)", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path, now: () => new Date("2026-09-01T10:00:00Z") });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
	await registry.register({ name: "based", clone_url: "https://github.com/o/based.git", base_branch: "main" });
	await assert.rejects(registry.setAfterMergeDeploy("demo", { task: "deploy it", resources: ["host-a"] }), /name branch/);
	const before = readFileSync(registry.file, "utf8");
	for (const bad of [[], ["a", "a"], ["-bad"], Array.from({ length: 9 }, (_, i) => `r${i}`)]) {
		await assert.rejects(registry.setAfterMergeDeploy("based", { task: "deploy it", resources: bad }), ProjectError);
	}
	await assert.rejects(registry.setAfterMergeDeploy("based", { task: "  ", resources: ["host-a"] }), /task/);
	await assert.rejects(registry.setAfterMergeDeploy("absent", null), /unknown project/);
	assert.equal(readFileSync(registry.file, "utf8"), before, "a refusal writes nothing");
	await registry.setAfterMergeDeploy("based", { task: " copy and restart ", resources: ["host-a", "db"] });
	assert.deepEqual(new ProjectRegistry({ home: home.path }).get("based")?.after_merge_deploy, {
		branch: "main", task: "copy and restart", resources: ["host-a", "db"], enabled_at: "2026-09-01T10:00:00Z",
	});
	assert.match(formatProjects(registry.list()), /after-merge deploy: main · resource:host-a,resource:db · since 2026-09-01T10:00:00Z/);
	await registry.setAfterMergeDeploy("demo", { branch: "release", task: "x", resources: ["h"] });
	assert.equal(registry.get("demo")?.after_merge_deploy?.branch, "release");
	await registry.setAfterMergeDeploy("based", null);
	assert.equal(new ProjectRegistry({ home: home.path }).get("based")?.after_merge_deploy, undefined);
	assert.doesNotMatch(formatProjects([registry.require("based")]), /after-merge deploy/);
});


test("cp_project reviewer_model dispatches set/clear and displays the saved preference", async (t) => {
	const { registerProjectMemoryTools } = await import("../extensions/command-post/tools-project-memory.ts");
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProjectMemoryTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => ({ registry }), setLive: () => {} } as never);
	const run = (params: Record<string, unknown>) => tools.get("cp_project")!.execute("c", params, undefined, undefined, {});
	await run({ action: "reviewer_model", name: "demo", reviewer_model: "a/review" });
	assert.equal(registry.get("demo")?.reviewer_model, "a/review");
	const show = await run({ action: "show", name: "demo" }) as { content: Array<{ text: string }> };
	assert.match(show.content[0]!.text, /a\/review/);
	await assert.rejects(run({ action: "reviewer_model", name: "demo" }), /needs reviewer_model/);
	await run({ action: "reviewer_model", name: "demo", reviewer_model: null });
	assert.equal(registry.get("demo")?.reviewer_model, undefined);
});

test("cp_project after_merge_deploy sets, shows and clears the opt-in; a call without deploy is refused", async (t) => {
	const { registerProjectMemoryTools } = await import("../extensions/command-post/tools-project-memory.ts");
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git", base_branch: "main" });
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProjectMemoryTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => ({ registry }), setLive: () => {} } as never);
	const run = (params: Record<string, unknown>) => tools.get("cp_project")!.execute("c", params, undefined, undefined, {}) as Promise<{ content: Array<{ text: string }> }>;
	const set = await run({ action: "after_merge_deploy", name: "demo", deploy: { task: "copy dist to host-a", resources: ["host-a"] } });
	assert.match(set.content[0]!.text, /^demo after-merge deploy: main · resource:host-a/);
	assert.deepEqual([registry.get("demo")?.after_merge_deploy?.branch, registry.get("demo")?.after_merge_deploy?.resources], ["main", ["host-a"]]);
	assert.match((await run({ action: "show", name: "demo" })).content[0]!.text, /after-merge deploy: main/);
	await assert.rejects(run({ action: "after_merge_deploy", name: "demo" }), /needs deploy/);
	assert.ok(registry.get("demo")?.after_merge_deploy, "a refused call leaves the setting in place");
	assert.equal((await run({ action: "after_merge_deploy", name: "demo", deploy: null })).content[0]!.text, "demo after-merge deploy: off");
	assert.equal(registry.get("demo")?.after_merge_deploy, undefined);
});

test("forge: legacy registries read unchanged; set/show/clear stores only non-secret settings; refusals write nothing", async (t) => {
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "git@code.example.com:team/sub/app.git" });
	assert.ok(!("forge" in registry.require("demo")), "absent means detect from the remote");
	const before = readFileSync(registry.file, "utf8");
	const canary = "glpat-CANARY-never-stored";
	for (const bad of [
		{ kind: "gitlab", web_base_url: "http://code.example.com" },
		{ kind: "gitlab", web_base_url: `https://u:${canary}@code.example.com` },
		{ kind: "gitlab", token_env: canary },
		{ kind: "gitlab", token: canary },
		{ kind: "github", token_env: "GH_TOKEN" },
	]) {
		const error = await registry.setForge("demo", bad as never).then(() => undefined, (caught: Error) => caught);
		assert.ok(error instanceof ProjectError, JSON.stringify(Object.keys(bad)));
		assert.ok(!error.message.includes(canary), "a refusal never echoes the value");
	}
	await assert.rejects(registry.setForge("absent", { kind: "gitlab" }), /unknown project/);
	assert.equal(readFileSync(registry.file, "utf8"), before, "a refusal writes nothing");

	const set = await registry.setForge("demo", { kind: "gitlab", web_base_url: " https://Code.Example.com/gitlab/ ", token_env: "EXAMPLE_GL_TOKEN" });
	assert.deepEqual(set.forge, { kind: "gitlab", web_base_url: "https://code.example.com/gitlab", token_env: "EXAMPLE_GL_TOKEN" });
	assert.deepEqual(new ProjectRegistry({ home: home.path }).require("demo").forge, set.forge, "persisted");
	assert.match(formatProjects(registry.list()), /forge: gitlab {2}web=https:\/\/code\.example\.com\/gitlab {2}token env=EXAMPLE_GL_TOKEN/);
	await registry.setForge("demo", null);
	assert.ok(!("forge" in registry.require("demo")), "null clears");
	assert.doesNotMatch(formatProjects(registry.list()), /forge:/);

	const file = JSON.parse(readFileSync(registry.file, "utf8")) as { projects: Array<Record<string, unknown>> };
	(file.projects[0] as Record<string, unknown>).forge = { kind: "gitlab", token: canary };
	writeFileSync(registry.file, JSON.stringify(file));
	assert.throws(() => registry.read(), /violates the registry contract/, "a hand-written token field is refused on read");
});

test("forge at registration must fit the clone url; an https remote on another host is refused", async (t) => {
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	await assert.rejects(
		registry.register({ name: "demo", clone_url: "https://code.example.com/team/app.git", forge: { kind: "gitlab", web_base_url: "https://other.example.com" } }),
		/forge does not fit the clone url/,
	);
	assert.equal(registry.exists, false, "nothing written");
	const added = await registry.register({ name: "demo", clone_url: "https://code.example.com/gitlab/team/app.git", forge: { kind: "gitlab", web_base_url: "https://code.example.com/gitlab" } });
	assert.equal(added.forge?.web_base_url, "https://code.example.com/gitlab");
});

test("cp_project forge sets and clears through the tool; a token value has no parameter", async (t) => {
	const { registerProjectMemoryTools } = await import("../extensions/command-post/tools-project-memory.ts");
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "git@code.example.com:team/app.git" });
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown>; parameters: { properties: Record<string, unknown> } }>();
	registerProjectMemoryTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown>; parameters: { properties: Record<string, unknown> } }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => ({ registry }), setLive: () => {} } as never);
	const tool = tools.get("cp_project")!;
	assert.ok(!JSON.stringify(tool.parameters).includes('"token"'), "no token-valued parameter");
	const run = (params: Record<string, unknown>) => tool.execute("c", params, undefined, undefined, {}) as Promise<{ content: Array<{ text: string }> }>;
	const set = await run({ action: "forge", name: "demo", forge: { kind: "gitlab", web_base_url: "https://code.example.com", token_env: "EXAMPLE_GL_TOKEN" } });
	assert.match(set.content[0]!.text, /demo forge: gitlab {2}web=https:\/\/code\.example\.com {2}token env=EXAMPLE_GL_TOKEN/);
	assert.equal(registry.get("demo")?.forge?.token_env, "EXAMPLE_GL_TOKEN");
	await assert.rejects(run({ action: "forge", name: "demo" }), /needs forge/);
	const cleared = await run({ action: "forge", name: "demo", forge: null });
	assert.match(cleared.content[0]!.text, /unset/);
	assert.equal(registry.get("demo")?.forge, undefined);
});
function withHome(t: { after(fn: () => void): void }): ScratchHome {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return home;
}

function withRepo(t: { after(fn: () => void): void }, name = "demo"): ScratchRepo {
	const repo = createScratchRepo({ name, files: { "README.md": `# ${name}\n` } });
	t.after(() => repo.cleanup());
	return repo;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test("an empty registry reads clean and creates nothing", (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	assert.deepEqual(registry.list(), []);
	assert.equal(registry.exists, false);
	assert.throws(() => registry.require("ghost"), /unknown project "ghost"/);
});

test("registration writes the machine registry and the human view", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	const project = await registry.register({
		name: "muxa",
		clone_url: "https://github.com/0xb1ob/muxa.git",
		delivery: "pr",
		notes: "spawn/mail CLI",
	});

	assert.ok(!("path" in project), "the clone path is derived from the name, never stored");
	assert.equal(project.delivery, "pr");
	assert.ok(project.registered_at.endsWith("Z"));
	assert.deepEqual(registry.names(), ["muxa"]);
	assert.equal(registry.pathOf("muxa"), join(registry.home, LAYOUT.projects, "muxa"));

	const view = readFileSync(join(home.path, LAYOUT.projectsView), "utf8");
	assert.match(view, /\| muxa \| https:\/\/github\.com\/0xb1ob\/muxa\.git \| \.pi-command-post\/projects\/muxa \| pr \| spawn\/mail CLI \|/);
	assert.match(view, /Name \| Clone URL \| Path \| Delivery \| Notes/);

	// the view is derived, never authoritative
	assert.equal(renderRegistry(registry.read()), view);
});

test("one canonical clone per name and per remote", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "muxa", clone_url: "https://example.invalid/muxa.git" });

	await assert.rejects(
		() => registry.register({ name: "muxa", clone_url: "https://example.invalid/muxa.git" }),
		/already registered/,
	);
	await assert.rejects(
		() => registry.register({ name: "muxa", clone_url: "https://example.invalid/other.git" }),
		/different remote/,
	);
	await assert.rejects(
		() => registry.register({ name: "muxa-two", clone_url: "https://example.invalid/muxa.git" }),
		/already registered as "muxa"/,
	);
	assert.deepEqual(registry.names(), ["muxa"]);
});

test("project names must survive as directories and as job labels", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	for (const bad of ["../escape", "with space", "dotted.name", "", "UPPER/lower"]) {
		await assert.rejects(
			() => registry.register({ name: bad, clone_url: "https://example.invalid/x.git" }),
			ProjectError,
			`accepted bad name ${JSON.stringify(bad)}`,
		);
	}
	await assert.rejects(
		() => registry.register({ name: "ok", clone_url: "https://example.invalid/x.git", delivery: "carrier" as never }),
		/must be one of pr\|local\|pipeline/,
	);
});

test("update and remove keep the registry consistent", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: "https://example.invalid/demo.git" });
	const updated = await registry.update("demo", { delivery: "local", notes: "research clone" });
	assert.equal(updated.delivery, "local");
	assert.equal(updated.notes, "research clone");
	assert.ok(!("path" in updated), "an update never stores a path");
	assert.equal(registry.pathOf("demo"), join(registry.home, LAYOUT.projects, "demo"));

	await assert.rejects(() => registry.update("ghost", { notes: "x" }), /unknown project/);
	await registry.remove("demo");
	assert.deepEqual(registry.names(), []);
	await assert.rejects(() => registry.remove("demo"), /unknown project/);
});

test("a corrupt or contract-violating registry is refused", (t) => {
	const home = withHome(t);
	const file = join(home.path, LAYOUT.projectsFile);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });

	writeFileSync(file, "{ nope");
	assert.throws(() => new ProjectRegistry({ home: home.path }).read(), /not valid JSON/);

	writeFileSync(
		file,
		JSON.stringify({
			schema_version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			projects: [
				{
					name: "demo",
					clone_url: "https://example.invalid/demo.git",
					path: "/somewhere/else",
					delivery: "pr",
					registered_at: "2026-01-01T00:00:00Z",
				},
			],
		}),
	);
	// cp-u3i2: a stored `path` is not tolerated — the clone path has one definition, derived from LAYOUT.
	assert.throws(() => new ProjectRegistry({ home: home.path }).read(), /violates the registry contract[\s\S]*path/);
});

test("remote urls compare without .git noise", () => {
	assert.ok(sameRemote("https://x/y.git", "https://x/y"));
	assert.ok(sameRemote("https://x/y/", "https://x/y"));
	assert.ok(!sameRemote("https://x/y", "https://x/z"));
});

// ---------------------------------------------------------------------------
// clone on demand + canonical clone facts
// ---------------------------------------------------------------------------

test("clone on demand is idempotent and lands in projects/<name>", async (t) => {
	const home = withHome(t);
	const repo = withRepo(t, "demo");
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string });

	const first = await registry.ensureClone("demo");
	assert.equal(first.cloned, true);
	assert.equal(first.path, registry.pathOf("demo"));
	assert.ok(existsSync(join(first.path, "README.md")));

	const second = await registry.ensureClone("demo");
	assert.equal(second.cloned, false, "an existing canonical clone is verified, not re-cloned");
	assert.equal(second.path, first.path);

	// ensureProject registers and clones in one step
	const other = withRepo(t, "other");
	const ensured = await registry.ensureProject({ name: "other", clone_url: other.remote as string, delivery: "local" });
	assert.equal(ensured.cloned, true);
	assert.equal(ensured.project.delivery, "local");
	assert.deepEqual(registry.names().sort(), ["demo", "other"]);
});

test("cp_project's path: register from the session, twice, and render it", async (t) => {
	// cp-sdm: `cp_dispatch` refuses a job whose `project:` label the registry does
	// not know, and until cp_project existed the only cure was hand-editing
	// data/projects.json. This is the path that tool takes.
	const home = withHome(t);
	const repo = withRepo(t, "web");
	const registry = new ProjectRegistry({ home: home.path });

	assert.match(formatProjects(registry.list()), /no projects registered/);
	assert.match(formatProjects(registry.list()), /cp_project add/, "an empty registry names the fix");

	const added = await registry.ensureProject({
		name: "web",
		clone_url: repo.remote as string,
		delivery: "pr",
		notes: "the app",
	});
	assert.equal(added.cloned, true);
	const rendered = formatEnsured(added);
	assert.match(rendered, /web ready \(delivery:pr\)/);
	assert.match(rendered, /cloned now/);
	assert.match(rendered, /project:web/, "the operator is told the label to use");
	assert.match(rendered, /merge: repo — change with cp_project merge_policy name:web policy:human_handoff/, "registry default is unchanged");

	// Adding the same project again is a no-op that says so — never a second clone.
	const again = await registry.ensureProject({ name: "web", clone_url: repo.remote as string, delivery: "pr" });
	assert.equal(again.cloned, false);
	assert.match(formatEnsured(again), /already present/);
	assert.deepEqual(registry.names(), ["web"]);

	// The listing states the two facts a dispatch depends on: the label name and
	// whether the clone-on-demand cache is populated.
	const list = formatProjects(registry.list(), { cloneExists: () => true });
	assert.match(list, /1 project\(s\)/);
	assert.match(list, /web {2}delivery:pr {2}\.pi-command-post\/projects\/web \(cloned\)/);
	assert.match(formatProjects(registry.list(), { pathOf: (p) => registry.pathOf(p.name) }), new RegExp(`delivery:pr {2}${registry.pathOf("web")}`));
	assert.match(formatProjects(registry.list(), { cloneExists: () => false }), /not cloned yet/);

	// An unknown name is a refusal that lists what is known (fail-closed lookup).
	assert.throws(() => registry.require("nope"), /unknown project "nope".*known: web/s);
});

test("a worker can never register a project", () => {
	// The recursion guard is a list, so the list is the test: cp_project clones
	// repositories, and a worker choosing what to clone is a worker choosing its
	// own scope.
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_project"));
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_pipeline"), "a worker cannot start pipelines either");
});

test("an existing directory with a foreign origin is reported, never adopted", async (t) => {
	const home = withHome(t);
	const mine = withRepo(t, "mine");
	const foreign = withRepo(t, "foreign");
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: mine.remote as string });

	// someone cloned the wrong repo into projects/demo
	mkdirSync(join(home.path, LAYOUT.projects), { recursive: true });
	execFileSync("git", ["clone", "--quiet", foreign.remote as string, registry.pathOf("demo")]);

	await assert.rejects(() => registry.ensureClone("demo"), /its origin is .*foreign.*not the registered/s);
});

test("belongs to another repo: linked worktrees and nested clones are refused", async (t) => {
	const home = withHome(t);
	const repo = withRepo(t, "demo");
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string });
	const projectsDir = join(home.path, LAYOUT.projects);
	mkdirSync(projectsDir, { recursive: true });

	// (a) missing clone
	assert.throws(() => registry.assertCanonicalClone("demo"), /project clone not at/);

	// (b) a directory that is not a git repo at all
	mkdirSync(registry.pathOf("demo"), { recursive: true });
	assert.throws(() => registry.assertCanonicalClone("demo"), /not a git clone/);

	// (c) a plain directory nested inside another repo
	rmSync(registry.pathOf("demo"), { recursive: true, force: true });
	const outer = createScratchRepo({ name: "outer", files: { "README.md": "# outer\n" }, withRemote: false });
	t.after(() => outer.cleanup());
	rmSync(projectsDir, { recursive: true, force: true });
	symlinkSync(outer.path, projectsDir);
	mkdirSync(join(outer.path, "demo"), { recursive: true });
	assert.throws(() => registry.assertCanonicalClone("demo"), /nested wrong git/);
	rmSync(projectsDir, { force: true });

	// (d) a linked worktree of another repo pretending to be the clone
	mkdirSync(projectsDir, { recursive: true });
	git(repo.path, "worktree", "add", "--quiet", registry.pathOf("demo"), "-b", "wt-branch");
	assert.throws(() => registry.assertCanonicalClone("demo"), /not a primary clone/);
	git(repo.path, "worktree", "remove", "--force", registry.pathOf("demo"));

	// (e) the real thing passes
	execFileSync("git", ["clone", "--quiet", repo.remote as string, registry.pathOf("demo")]);
	assert.equal(registry.assertCanonicalClone("demo"), registry.pathOf("demo"));
	assert.ok(registry.originUrl("demo"));
});

test("assertCanonicalRepo passes the main worktree and refuses a linked worktree and a nested clone", (t) => {
	const repo = createScratchRepo({ name: "canon" });
	t.after(() => repo.cleanup());
	assert.equal(assertCanonicalRepo(repo.path), realpathSync(repo.path));

	// A linked worktree: `.git` is a file, the common dir is elsewhere.
	const linked = join(repo.path, "..", "canon-linked");
	repo.git("worktree", "add", "-q", "--detach", linked);
	t.after(() => {
		try {
			repo.git("worktree", "remove", "--force", linked);
		} catch {
			// best effort
		}
	});
	assert.throws(() => assertCanonicalRepo(linked), /is not a primary clone .* linked worktree/);

	// A clone nested inside another repository's tree.
	const nestedParent = createScratchRepo({ name: "outer", withRemote: false });
	t.after(() => nestedParent.cleanup());
	const nested = join(nestedParent.path, "inner");
	execFileSync("git", ["clone", "-q", repo.path, nested]);
	// `inner` is its own toplevel, so it passes; the trap is a *subdirectory* of a repo pretending to be one:
	assert.equal(assertCanonicalRepo(nested), realpathSync(nested));
	mkdirSync(join(nestedParent.path, "src"), { recursive: true });
	assert.throws(() => assertCanonicalRepo(join(nestedParent.path, "src")), /nested wrong git/);
});

// ---------------------------------------------------------------------------
// archive flag
// ---------------------------------------------------------------------------

test("an old registry without archived still validates; archive/unarchive round-trips and keeps names()", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "alpha", clone_url: "https://example.invalid/alpha.git" });
	await registry.register({ name: "beta", clone_url: "https://example.invalid/beta.git" });
	assert.ok(!("archived" in registry.require("alpha")), "absent means false");
	assert.deepEqual(registry.activeNames(), ["alpha", "beta"]);

	const archived = await registry.setArchived("alpha", true);
	assert.equal(archived.archived, true);
	assert.deepEqual(registry.activeNames(), ["beta"]);
	assert.deepEqual(registry.names(), ["alpha", "beta"], "lookups still see the archived registration");
	assert.deepEqual(registry.archivedNames(), ["alpha"]);
	assert.match(formatProjects(registry.list()), /alpha \[archived\]/);

	const restored = await registry.setArchived("alpha", false);
	assert.ok(!("archived" in restored), "unarchive drops the key");
	assert.deepEqual(registry.activeNames(), ["alpha", "beta"]);
	await assert.rejects(() => registry.setArchived("ghost", true), /unknown project "ghost"/);
});

test("merge_policy round-trips: absent is repo, human_handoff persists and renders, repo drops the key, junk is refused", async (t) => {
	const home = withHome(t);
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "example-app", clone_url: "https://example.invalid/example-app.git" });
	assert.ok(!("merge_policy" in registry.require("example-app")), "absent means repo");

	const handed = await registry.setMergePolicy("example-app", "human_handoff");
	assert.equal(handed.merge_policy, "human_handoff");
	assert.equal(new ProjectRegistry({ home: home.path }).require("example-app").merge_policy, "human_handoff", "persisted");
	assert.match(formatProjects(registry.list()), /example-app {2}delivery:pr merge:human_handoff/);

	const repo = await registry.setMergePolicy("example-app", "repo");
	assert.ok(!("merge_policy" in repo), "repo deletes the key");
	assert.doesNotMatch(formatProjects(registry.list()), /merge:/);

	const before = readFileSync(registry.file, "utf8");
	await assert.rejects(() => registry.setMergePolicy("example-app", "auto" as "repo"), /unknown merge policy "auto"/);
	await assert.rejects(() => registry.setMergePolicy("ghost", "human_handoff"), /unknown project "ghost"/);
	assert.equal(readFileSync(registry.file, "utf8"), before, "a refusal writes nothing");
	const file = JSON.parse(before) as { projects: Array<Record<string, unknown>> };
	(file.projects[0] as Record<string, unknown>).merge_policy = "auto";
	writeFileSync(registry.file, JSON.stringify(file));
	assert.throws(() => registry.read(), /violates the registry contract/);
});

test("register stores merge_policy human_handoff; repo and absent store no key; junk is refused and writes nothing", async (t) => {
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	assert.equal((await registry.register({ name: "team", clone_url: "https://github.com/o/team.git", merge_policy: "human_handoff" })).merge_policy, "human_handoff");
	assert.ok(!("merge_policy" in (await registry.register({ name: "solo", clone_url: "https://github.com/o/solo.git", merge_policy: "repo" }))));
	assert.ok(!("merge_policy" in (await registry.register({ name: "legacy", clone_url: "https://github.com/o/legacy.git" }))));
	const before = readFileSync(registry.file, "utf8");
	await assert.rejects(registry.register({ name: "junk", clone_url: "https://github.com/o/junk.git", merge_policy: "auto" as never }), /unknown merge policy "auto"/);
	assert.equal(readFileSync(registry.file, "utf8"), before);
});

const SOLO: MergeFlowFacts = { owner: "me", login: "Me", inOrganization: false, requiredReviews: false, codeOwners: false };

test("classifyMergeFlow: solo only when every signal agrees; a failed probe is human_handoff", async () => {
	assert.deepEqual(classifyMergeFlow(SOLO), { policy: "repo", note: "detected solo repo: owned by Me, no required reviews, no CODEOWNERS" });
	assert.deepEqual(classifyMergeFlow({ ...SOLO, owner: "acme", inOrganization: true }), { policy: "human_handoff", note: "detected team repo: org-owned" });
	assert.deepEqual(classifyMergeFlow({ ...SOLO, owner: "friend" }), { policy: "human_handoff", note: "detected team repo: owned by friend, not Me" });
	assert.equal(classifyMergeFlow({ ...SOLO, requiredReviews: true }).note, "detected team repo: required reviews");
	assert.equal(classifyMergeFlow({ ...SOLO, inOrganization: true, codeOwners: true }).note, "detected team repo: org-owned, CODEOWNERS");
	const failed = await detectMergePolicy(async () => { throw new Error("gh: HTTP 403"); }, { cwd: "/", repo: "o/r" });
	assert.deepEqual(failed, { policy: "human_handoff", note: "detection failed, fail safe: gh: HTTP 403" });
});

test("ghMergeFlowProbe reads login, repo view, base rules and CODEOWNERS on the base; an unreadable call throws", async () => {
	const calls: string[] = [];
	const answers: Record<string, string> = {
		"gh api user --jq .login": "me\n",
		"gh repo view o/r --json owner,isInOrganization,defaultBranchRef": JSON.stringify({ owner: { login: "me" }, isInOrganization: false, defaultBranchRef: { name: "main" } }),
		"gh api repos/{owner}/{repo}/rules/branches/main": JSON.stringify([{ type: "pull_request", parameters: { required_approving_review_count: 0, require_code_owner_review: true } }]),
		"git ls-tree --name-only origin/main -- CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS": ".github/CODEOWNERS\n",
	};
	const exec = async (command: string, args: readonly string[]) => {
		const key = [command, ...args].join(" ");
		calls.push(key);
		if (!(key in answers)) throw new Error(`unexpected ${key}`);
		return answers[key] as string;
	};
	assert.deepEqual(await ghMergeFlowProbe(exec)({ cwd: "/clone", repo: "o/r" }), { owner: "me", login: "me", inOrganization: false, requiredReviews: true, codeOwners: true });
	assert.deepEqual(calls, Object.keys(answers));
	answers["gh repo view o/r --json owner,isInOrganization,defaultBranchRef"] = "{}";
	await assert.rejects(ghMergeFlowProbe(exec)({ cwd: "/clone", repo: "o/r" }), /answered without owner/);
});

test("cp_project add: new projects default to human_handoff, detection may set repo, explicit policy skips it, re-add changes nothing", async (t) => {
	const { registerProjectMemoryTools } = await import("../extensions/command-post/tools-project-memory.ts");
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	let facts: MergeFlowFacts | Error = SOLO;
	const probed: string[] = [];
	const probe = async (input: { repo: string }) => {
		probed.push(input.repo);
		if (facts instanceof Error) throw facts;
		return facts;
	};
	let ci = { status: 0 as number | null, stdout: JSON.stringify({ total_count: 0, workflows: [] }), stderr: "" };
	const ciRun = () => ci;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProjectMemoryTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => ({ registry }), setLive: () => {} } as never, probe, ciRun);
	const run = async (params: Record<string, unknown>) =>
		((await tools.get("cp_project")!.execute("c", { action: "add", ...params }, undefined, undefined, {})) as { content: Array<{ text: string }> }).content[0]!.text;
	// A GitHub remote without network: the canonical clone is already in place with that origin.
	const addGithub = (name: string, extra: Record<string, unknown> = {}) => {
		const url = `https://github.com/o/${name}.git`;
		execFileSync("git", ["clone", "-q", withRepo(t, name).remote as string, registry.pathOf(name)]);
		git(registry.pathOf(name), "remote", "set-url", "origin", url);
		return run({ name, clone_url: url, ...extra });
	};

	const local = await run({ name: "local", clone_url: withRepo(t, "local").remote });
	assert.equal(registry.require("local").merge_policy, "human_handoff");
	assert.match(local, /merge: human_handoff \(default for new projects; not a GitHub remote, so no detection\) — change with cp_project merge_policy name:local policy:repo/);

	const solo = await addGithub("solo");
	assert.ok(!("merge_policy" in registry.require("solo")));
	assert.match(solo, /merge: repo \(detected solo repo: owned by Me, no required reviews, no CODEOWNERS\) — change with cp_project merge_policy name:solo policy:human_handoff/);

	facts = { ...SOLO, owner: "acme", inOrganization: true, codeOwners: true };
	assert.match(await addGithub("team"), /merge: human_handoff \(detected team repo: org-owned, CODEOWNERS\)/);
	assert.equal(registry.require("team").merge_policy, "human_handoff");

	facts = new Error("gh: HTTP 403");
	assert.match(await addGithub("unknown"), /merge: human_handoff \(detection failed, fail safe: gh: HTTP 403\)/);
	assert.deepEqual(probed, ["o/solo", "o/team", "o/unknown"]);

	assert.match(await addGithub("explicit", { policy: "repo" }), /merge: repo \(set explicitly\)/);
	assert.ok(!("merge_policy" in registry.require("explicit")));
	assert.match(await run({ name: "solo", clone_url: "https://github.com/o/solo.git" }), /merge: repo \(existing project, unchanged\)/);
	assert.equal(probed.length, 3, "an explicit policy or a re-add never probes");

	// Readiness (#329): advisory lines plus a paste-ready paragraph; a refused or failed CI read never fails add
	// and never reads as "no CI"; gh's output (which may carry a token) is never echoed.
	assert.match(local, /forge: {3}unknown: .*\n {4}CI: {6}not probed[^\n]*\n {2}tell the user:/);
	assert.doesNotMatch(local, /tracker|cp_tracker/);
	assert.match(local, /tell the user: picp is set up for local\. picp opens a pull request.*it never merges itself\. picp does not probe/);
	assert.match(solo, /forge: {3}github \(o\/solo\)\n {4}CI: {6}no Actions CI configured for o\/solo/);
	assert.match(solo, /picp merges a pull request once it is reviewed.*no GitHub Actions workflows/);
	ci = { status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by personal access token sentinel-secret" };
	const denied = await addGithub("denied");
	assert.match(denied, /CI: {6}CI unreadable — token lacks Actions read for o\/denied — fix: give the token/);
	assert.match(denied, /cannot read this repository's CI yet.*Actions read/);
	ci = { status: 1, stdout: "", stderr: "dial tcp: i/o timeout sentinel-secret" };
	const flaky = await addGithub("flaky");
	assert.match(flaky, /CI: {6}CI state unknown for o\/flaky/);
	assert.match(flaky, /unknown, not "no CI"/);
	ci = { status: null, stdout: "", stderr: "spawnSync gh ENOENT" };
	assert.match(await run({ name: "solo", clone_url: "https://github.com/o/solo.git" }), /CI: {6}unknown: gh is not installed/);
	assert.doesNotMatch(denied + flaky, /sentinel-secret/);
	assert.doesNotMatch(local, /on GitHub/, "a non-GitHub remote is never told to merge on GitHub");
	assert.match(await addGithub("team2"), /hands it to you on GitHub to merge/);
});

test("cp_project add readiness: delivery:local wording, and a throwing probe never fails add", async (t) => {
	const { registerProjectMemoryTools } = await import("../extensions/command-post/tools-project-memory.ts");
	const home = withHome(t), registry = new ProjectRegistry({ home: home.path });
	const ciRun = () => { throw new Error("gh exploded"); };
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProjectMemoryTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as never,
		{ commandPost: () => ({ registry }), setLive: () => {} } as never, async () => SOLO, ciRun);
	const run = async (params: Record<string, unknown>) =>
		((await tools.get("cp_project")!.execute("c", { action: "add", ...params }, undefined, undefined, {})) as { content: Array<{ text: string }> }).content[0]!.text;

	const remote = withRepo(t, "local").remote;
	const tell = (text: string) => /tell the user: .*/.exec(text)?.[0] ?? "";
	const local = await run({ name: "local", clone_url: remote, delivery: "local" });
	assert.match(tell(local), /pushes each job's branch to the remote; it opens no pull or merge request and merges nothing\./);
	assert.doesNotMatch(tell(local), /opens a pull request|on GitHub/);

	assert.match(tell(local), /Work arrives as requests to the operator\./);

	// A GitHub remote whose CI probe throws (#329): add still succeeds and says readiness is unknown, never "no CI".
	const url = "https://github.com/o/boom.git";
	execFileSync("git", ["clone", "-q", withRepo(t, "boom").remote as string, registry.pathOf("boom")]);
	git(registry.pathOf("boom"), "remote", "set-url", "origin", url);
	const boom = await run({ name: "boom", clone_url: url });
	assert.match(boom, /boom ready \(delivery:pr\)/);
	assert.match(boom, /readiness: unknown \(gh exploded\); add itself succeeded/);
	assert.doesNotMatch(boom, /no Actions CI/);
});

test("the ledger refuses a job in an archived project with a clear message", async (t) => {
	const home = withHome(t);
	createScratchLedger({ home: home.path });
	const ledger = new Ledger({ home: home.path, knownProjects: ["alpha", "beta"], archivedProjects: ["alpha"] });
	await assert.rejects(() => ledger.create({ title: "t", project: "alpha", delivery: "pr" }), /project "alpha" is archived.*cp_project unarchive/);
	await ledger.create({ title: "t", project: "beta", delivery: "pr" });
});
