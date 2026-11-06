/**
 * N4c security guard (local adversarial rows beside the native e2e): a native implementer's Bash, Edit/Write and Read
 * through the real PreToolUse hook on a real worktree. No `claude` binary needed, so CI runs every row.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { secretPaths } from "../src/drivers/claude-bash-policy.ts";
import { roleTools } from "../src/drivers/claude-roles.ts";
import { preToolUseHook, type SpikeJob, spikeGuards } from "../src/drivers/claude-spike.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";

const SECRETS = secretPaths("/op/settings.json", ["/op"]);

const decide = async (hook: HookCallback, tool_name: string, tool_input: unknown) => {
	const input = { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" };
	const out = (await hook(input as Parameters<HookCallback>[0], "t1", { signal: new AbortController().signal })) as {
		hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
	};
	return out.hookSpecificOutput;
};

function withWorktree(body: (root: string, worktree: string, job: (excludePaths?: readonly string[]) => SpikeJob) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "cp-ship-policy-"));
	const worktree = join(root, "repo");
	for (const dir of [".git/hooks", "src", ".github/workflows", "../outside"]) mkdirSync(join(worktree, dir), { recursive: true });
	writeFileSync(join(worktree, "README.md"), "readme\n");
	symlinkSync(join(root, "outside"), join(worktree, "out"));
	symlinkSync(join(root, "outside", "missing.md"), join(worktree, "dangling.md"));
	const job = (excludePaths?: readonly string[]): SpikeJob => ({
		job_id: "cp-ship-unit", kind: "ship", role: "implementer", delivery: "pr", runDir: join(root, "run"), worktree,
		artifactPath: join(root, "art", "report.md"), ...(excludePaths ? { excludePaths } : {}),
	});
	return body(root, worktree, job).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("implementer guards: network, escapes, expansions, secrets, .git and exclusions are denied; local work is allowed", async () => {
	await withWorktree(async (_root, worktree, job) => {
		const hook = preToolUseHook(spikeGuards(job(SCAFFOLD_MANDATE_DEFAULTS.exclude_paths), SECRETS));
		const bash = (command: string) => ["Bash", { command }] as const;
		const write = (tool: string, path: string) => [tool, { file_path: path, content: "x\n" }] as const;
		const denied: Array<readonly [string, unknown]> = [
			bash("git push"), bash("git push origin HEAD:main"), bash("git -C .. status"), bash("git fetch origin"), bash("git config user.name x"),
			bash("cd /"), bash("cat > ../x"), bash("echo x > /tmp/x"), bash("echo x >> out/x"), bash("curl https://example.com"), bash("env"),
			bash("printenv"), bash("echo $HOME"), bash("sudo ls"), bash("gh pr merge 1"), bash("gh pr view 1"), bash("git switch main"),
			bash("node -e 1"), bash("npm install x"), bash("npm run evil"), bash("rm -rf .git"), bash("cp README.md /tmp/x"),
			bash("mv README.md ../x"), bash("cat /proc/self/environ"), bash("echo x > .github/workflows/x"), bash("cat <<EOF"),
			bash("git restore .github/workflows/x.yml"), bash("git restore --source HEAD~1 -- .github/workflows/x.yml"),
			bash("git checkout -- .github/workflows/x.yml"),
			write("Edit", join(worktree, ".env")), write("Write", ".github/workflows/x.yml"), write("Write", "../x"), write("Write", "out/x"),
			write("Write", "dangling.md"), write("Write", ".git/hooks/pre-commit"), write("Edit", join(worktree, ".git", "config")),
			write("Write", "/op/.claude/settings.json"), write("Write", worktree), ["Read", { file_path: "/proc/self/environ" }],
		];
		for (const [tool, input] of denied) assert.equal((await decide(hook, tool, input))?.permissionDecision, "deny", JSON.stringify(input));
		const allowed: Array<readonly [string, unknown]> = [
			bash("git add -A"), bash("git commit -m x"), bash("npm run test:one -- tests/x.test.ts"), bash("npm run typecheck"), bash("npm ci"),
			bash("git status --porcelain && git diff --stat"), bash("git switch cp-ship-unit"), bash("npx tsx scripts/x.ts"),
			bash("node scripts/x.ts arg"), bash("mkdir -p src/new && echo x > src/new/a.txt 2>/dev/null"), bash("rm -f src/old.ts"),
			bash("git restore src/x.ts"),
			write("Edit", join(worktree, "src", "x.ts")), write("Write", "src/new.ts"), ["Read", { file_path: join(worktree, "README.md") }],
		];
		for (const [tool, input] of allowed) assert.equal((await decide(hook, tool, input))?.permissionDecision, "allow", JSON.stringify(input));
		const reason = async (tool: string, input: unknown) => (await decide(hook, tool, input))?.permissionDecisionReason ?? "";
		assert.match(await reason("Bash", { command: "git push" }), /^Refused: an implementer's Bash .*; `git push` \(no network/);
		assert.match(await reason("Write", { file_path: "../x" }), /; a path outside the worktree \(\.\.\/x\) is denied\.$/);
		assert.match(await reason("Write", { file_path: "out/x" }), /a path outside the worktree \(out\/x\)/);
		assert.match(await reason("Write", { file_path: ".git/hooks/x" }), /a path inside \.git/);
		assert.match(await reason("Edit", { file_path: ".env" }), /an excluded path \(\.env matches \*\*\/\.env\*\)/);
	});
});

test("implementer exclusions come from the job: unlisted, a workflow write is allowed; absent, the guards refuse to build", async () => {
	await withWorktree(async (_root, _worktree, job) => {
		const open = preToolUseHook(spikeGuards(job([]), SECRETS));
		assert.equal((await decide(open, "Write", { file_path: ".github/workflows/x.yml" }))?.permissionDecision, "allow");
		assert.throws(() => spikeGuards(job(), SECRETS), /implementer cp-ship-unit has no exclude_paths/);
		assert.throws(() => spikeGuards(job([]), SECRETS, "ops" as never), /no tool set for role ops/);
		assert.deepEqual(roleTools("implementer"), ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
		assert.deepEqual(roleTools("planner"), ["Read", "Grep", "Glob", "Bash", "Write"]);
		// Research keeps its own Bash and write scope under the same job: Edit is still outside its tool set.
		const research = preToolUseHook(spikeGuards({ ...job([]), kind: "research", role: "planner" }, SECRETS));
		assert.equal((await decide(research, "Edit", { file_path: "src/x.ts" }))?.permissionDecisionReason, "Refused: Edit is not in the spike's tool set.");
		assert.equal((await decide(research, "Bash", { command: "git add -A" }))?.permissionDecision, "deny");
	});
});

// N4h: a native reviewer reads only its scratch dir (the review packet); a Read/Grep/Glob outside it, through a link, into a
// secret, and any Bash, Write or Edit are refused by the real hook, so a reviewer cannot look past what it was handed.
test("reviewer guards: Read/Grep/Glob stay in the scratch dir; secrets, Bash, Write and Edit are refused", async () => {
	await withWorktree(async (root, scratch, job) => {
		const hook = preToolUseHook(spikeGuards({ ...job(), kind: "research", role: "gate-reviewer" }, SECRETS));
		assert.deepEqual(roleTools("gate-reviewer"), ["Read", "Grep", "Glob"]);
		const allowed = [["Read", { file_path: join(scratch, "README.md") }], ["Read", { file_path: "README.md" }], ["Grep", { pattern: "x" }],
			["Grep", { pattern: "x", path: "src" }], ["Glob", { pattern: "**/*.md" }]] as const;
		for (const [tool, input] of allowed) assert.equal((await decide(hook, tool, input))?.permissionDecision, "allow", JSON.stringify(input));
		const reason = async (tool: string, input: unknown) => (await decide(hook, tool, input))?.permissionDecisionReason ?? "";
		assert.match(await reason("Read", { file_path: join(root, "outside", "x.md") }), /^Refused: a reviewer reads only its scratch dir .*outside/);
		assert.match(await reason("Read", { file_path: "out/x.md" }), /reads only its scratch dir.*a path outside the worktree \(out\/x\.md\)/);
		assert.match(await reason("Grep", { pattern: "x", path: "/etc" }), /reads only its scratch dir/);
		assert.match(await reason("Glob", { pattern: "../**/*" }), /reads only its scratch dir/);
		assert.match(await reason("Read", { file_path: "/op/settings.json" }), /^Refused: a reviewer/);
		assert.match(await reason("Bash", { command: "ls" }), /^Refused: a reviewer has no Bash/);
		for (const tool of ["Write", "Edit"]) assert.match(await reason(tool, { file_path: "README.md", content: "x" }), /^Refused: a reviewer has no Edit or Write/);
	});
});
