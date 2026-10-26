/**
 * Retained from tests/repo-map.test.ts (P16b): `repoMap`'s injected `git` runner fails `ls-tree`; a dispatch
 * only reaches repoMap after its own git reads of the same base succeeded, so no e2e entry point makes that read fail.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoMap } from "../src/repo-map.ts";
import { createScratchRepo } from "./harness/scratch-repo.ts";
import type { GitRunner } from "../src/dispatch.ts";

const git: GitRunner = async (cwd, args) => {
	try {
		return { status: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (error) {
		return { status: 1, stdout: "", stderr: String(error) };
	}
};

test("repo map reports failed git reads without caching a partial map", async (t) => {
	const repo = createScratchRepo({ withRemote: false });
	t.after(() => repo.cleanup());
	const map = await repoMap({ home: repo.path, project: "demo", worktree: repo.path, git: async (cwd, args) =>
		args[0] === "ls-tree" ? { status: 1, stdout: "", stderr: "injected failure" } : git(cwd, args) });
	assert.match(map, /## Repo map\n\nUnavailable:/);
	assert.equal(existsSync(join(repo.path, ".pi-command-post/state/repo-map")), false);
});
