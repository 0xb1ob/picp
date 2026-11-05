/**
 * N4d security guard: a native implementer's forge tools against a temp bare origin and a scripted gh on PATH. Ship
 * selection is not open yet, so no product entry point reaches them; CI runs every row without `claude`.
 */
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { commitIdentityEnv, forgeTools } from "../src/drivers/claude-forge-tools.ts";
import { FORGE_TOOL_NAMES } from "../src/drivers/claude-roles.ts";
import { createScratchRepo } from "./harness/scratch-repo.ts";

const JOB = "cp-forge-unit";
// Built at runtime so no token-shaped literal is committed.
const TOKEN = `ghp_${"a1".repeat(18)}`;

test("forge tools: push lands origin/<job> only; main, base, force and non-fast-forward are refused by name", async () => {
	const repo = createScratchRepo({ name: "forge" });
	const bin = mkdtempSync(join(tmpdir(), "cp-forge-gh-"));
	try {
		copyFileSync(join(import.meta.dirname, "fixtures", "forge-gh"), join(bin, "gh"));
		chmodSync(join(bin, "gh"), 0o755);
		const log = join(bin, "calls.log");
		repo.git("checkout", "-q", "-b", JOB);
		const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FORGE_GH_LOG: log, FORGE_GH_TOKEN: TOKEN, CP_BASE_BRANCH: "release" };
		const tools = forgeTools({ job_id: JOB, worktree: repo.path, runDir: join(bin, "run") }, env, { statusQueries: 0 });
		assert.deepEqual(tools.map((tool) => tool.name), [...FORGE_TOOL_NAMES]);
		const call = async (name: string, args: Record<string, unknown>) => {
			const result = await (tools.find((tool) => tool.name === name) as (typeof tools)[number]).handler(args, {});
			return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
		};
		const remoteHead = () => repo.git("ls-remote", "origin", `refs/heads/${JOB}`).split("\t")[0];

		repo.write("src/a.ts", "export const a = 1;\n");
		const first = repo.commitAll("a");
		assert.equal((await call("git_push", {})).isError, false);
		assert.equal(remoteHead(), first);
		assert.match((await call("git_push", { branch: "main" })).text, /^Refused: git_push never pushes main \(main and the base branch/);
		assert.match((await call("git_push", { branch: "release" })).text, /^Refused: git_push never pushes release \(main and the base branch/);
		assert.match((await call("git_push", { force: true })).text, /^Refused: git_push never forces a push/);
		assert.match((await call("git_push", { branch: "cp-other" })).text, /^Refused: git_push pushes only to origin\/cp-forge-unit/);
		repo.git("reset", "-q", "--hard", "HEAD~1");
		repo.write("src/b.ts", "export const b = 1;\n");
		repo.commitAll("b");
		const diverged = await call("git_push", {});
		assert.match(diverged.text, /^Refused: git_push: HEAD is not a fast-forward of origin\/cp-forge-unit/);
		assert.equal(remoteHead(), first);

		assert.match((await call("git_fetch", { cwd: bin })).text, /^Refused: git_fetch runs only in this job's worktree/);
		assert.equal((await call("git_fetch", { cwd: repo.path })).isError, false);

		assert.match((await call("pr_edit", { title: "early" })).text, /pr_create has not opened it yet/);
		const created = await call("pr_create", { title: "Native forge", body: "Body." });
		assert.match(created.text, /^Draft PR for cp-forge-unit: https:\/\/github\.com\/picp-e2e\/forge\/pull\/7$/);
		assert.match((await call("pr_create", { title: "Again", body: "" })).text, /already opened this job's PR: https:\/\/github\.com\/picp-e2e\/forge\/pull\/7/);
		assert.match((await call("pr_edit", { pr: 99, title: "x" })).text, /^Refused: pr_edit reaches only this job's PR #7 .*; #99 is refused\.$/);
		assert.equal((await call("pr_edit", { pr: 7, title: "Renamed" })).isError, false);
		assert.match((await call("gh_read", { verb: "pr view", pr: 99 })).text, /#99 is refused/);

		const view = await call("gh_read", { verb: "pr view" });
		const logs = await call("gh_read", { verb: "run view", run_id: "42", log_failed: true });
		for (const read of [view, logs]) {
			assert.equal(read.text.includes(TOKEN), false, read.text);
			assert.match(read.text, /token \[REDACTED\]/);
		}
		assert.equal((await call("gh_read", { verb: "pr checks" })).isError, false);
		assert.match((await call("gh_read", { verb: "run view", run_id: "42" })).text, /already took its one CI status snapshot/);

		const calls = readFileSync(log, "utf8").trim().split("\n");
		assert.deepEqual(calls.map((line) => line.split(" ").slice(0, 2).join(" ")), ["pr create", "pr edit", "pr view", "run view", "pr checks"]);
		assert.match(calls[0] ?? "", /^pr create --draft --head cp-forge-unit --base release --title Native forge --body Body\.$/);
		assert.equal(calls[1], "pr edit https://github.com/picp-e2e/forge/pull/7 --title Renamed");
		assert.deepEqual(commitIdentityEnv(repo.path, env), { GIT_AUTHOR_NAME: "cp test", GIT_AUTHOR_EMAIL: "cp@test.invalid", GIT_COMMITTER_NAME: "cp test", GIT_COMMITTER_EMAIL: "cp@test.invalid" });
	} finally {
		rmSync(bin, { recursive: true, force: true });
		repo.cleanup();
	}
});
