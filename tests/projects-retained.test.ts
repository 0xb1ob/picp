/**
 * Registry units no cp_project call reaches, verbatim from projects.test.ts: update/remove (no tool action),
 * a nested wrong-git clone and assertCanonicalRepo (no entry point), and a CI runner that throws.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { assertCanonicalRepo, ProjectRegistry } from "../src/projects.ts";
import type { MergeFlowFacts } from "../src/merge-policy-detect.ts";
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

const SOLO: MergeFlowFacts = { owner: "me", login: "Me", inOrganization: false, requiredReviews: false, codeOwners: false };

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
