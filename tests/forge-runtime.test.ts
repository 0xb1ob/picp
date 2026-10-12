/** Forge PR 2: project-scoped observer choice and base branch, from the registry only (no network, no token). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { changeRequestObserver, projectBaseBranch } from "../src/forge-runtime.ts";
import type { CommandRunner } from "../src/merges.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { createScratchHome } from "./harness/index.ts";

const run: CommandRunner = async () => assert.fail("choosing an observer runs nothing");

test("an unregistered project keeps gh for GitHub refs and names its GitLab MR failure", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ports = { run, cwd: home.path };
	assert.equal(changeRequestObserver(home.path, "nope", "https://github.com/o/r/pull/5", ports).provider, "github");
	assert.equal(changeRequestObserver(home.path, "nope", "5", ports).provider, "github", "a bare number keeps the pre-forge path");
	const gitlab = changeRequestObserver(home.path, "nope", "https://gitlab.com/g/r/-/merge_requests/5", ports);
	assert.equal(gitlab.provider, "none");
	const read = await gitlab.readChangeRequest("https://gitlab.com/g/r/-/merge_requests/5");
	assert.equal(read.ok === false && read.reason, "unsupported");
	assert.equal(projectBaseBranch(home.path, "nope"), undefined);
});

test("a registered GitLab project gets the GitLab observer and its base branch", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "gl", clone_url: "https://gitlab.com/group/sub/repo.git", delivery: "pr", base_branch: "trunk" });
	await registry.register({ name: "gh", clone_url: "https://github.com/o/r.git", delivery: "pr" });
	const ports = { run, cwd: home.path };
	assert.equal(changeRequestObserver(home.path, "gl", "7", ports).provider, "gitlab");
	assert.equal(changeRequestObserver(home.path, "gh", "7", ports).provider, "github");
	assert.equal(projectBaseBranch(home.path, "gl"), "trunk");
	assert.equal(projectBaseBranch(home.path, "gh"), undefined);
});
