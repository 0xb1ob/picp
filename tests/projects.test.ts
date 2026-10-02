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
import { createScratchHome, createScratchRepo, git, type ScratchHome, type ScratchRepo } from "./harness/index.ts";

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

test("project names must survive as directories and as br labels", async (t) => {
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
