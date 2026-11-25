/**
 * Worker commit signing on the Claude CLI driver, fake-claude at the boundary: a signing host gets signed Bash
 * commits and checkpoints; an unreachable key fails by name; no signing, or a repo opting out, stays unsigned.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { type ClaudeStep, type ClaudeToolUse, FAKE_CLAUDE_AUTH_TOKEN } from "../harness/claude-mock-provider.ts";
import { installClaudeStub, startClaudeMockProvider, toolResults } from "../harness/claude-mock-provider.ts";
import { hasSignature, signingAgent, signingKey, signsConfig, verifyCommit } from "../harness/commit-signing.ts";
import { waitFor } from "../harness/index.ts";
import { NATIVE, nativeWorkerHome } from "../harness/native-worker.ts";

type Home = Awaited<ReturnType<typeof nativeWorkerHome>>;
type Setup = (h: Home) => Promise<Record<string, string>> | Record<string, string>;
const skip = process.env.CI === "true" ? false : NATIVE;
const WORKER = join(import.meta.dirname, "..", "..", "src", "drivers", "claude-worker.ts");
const SIGNER_ENV = ["GIT_CONFIG_COUNT", "SSH_AUTH_SOCK", "GNUPGHOME", "GIT_CONFIG_GLOBAL"];
const UNREACHABLE = /commit_signing_unavailable: user\.signingkey names a key file that is missing or unreadable/;
const calls = (...uses: ClaudeToolUse[]): ClaudeStep => ({ kind: "tool_use", calls: uses });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const blocked = (id: string) => ({
	job_id: id, kind: "ship", status: "blocked", summary: "Signing case done.", blockers: ["the e2e case ends here"],
});

/** One native implementer: writes src/<name>.ts, commits it in Bash, runs `more`, reports blocked. */
async function commitJob(t: TestContext, name: string, more: ClaudeToolUse[], setup: Setup = () => ({})) {
	let id = "";
	const h: Home = await nativeWorkerHome(t, [
		calls({ name: "Write", input: () => ({ file_path: join(h.worktree(id), "src", `${name}.ts`), content: "x\n" }) }),
		calls({ name: "Bash", input: { command: `git add -A && git commit -q -m ${name}` } }),
		...(more.length > 0 ? [calls(...more)] : []),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		{ kind: "text", text: "Reported." },
	]);
	const env = await setup(h);
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch(`Add src/${name}.ts and commit it.`), h.awaitEnvelope(id)], env);
	assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends[0]?.result.content));
	return { h, id, wt: h.worktree(id), results: toolResults(h.claude.requests) };
}

/** The signer-related env names the CLI child was spawned with; fake-claude always logs them. */
function signerKeys(h: Home, id: string): string[] {
	const spawned = h.spawnedEnvKeys(id);
	assert.ok(spawned !== undefined, "fake-claude logged the spawned env keys");
	return spawned.filter((name) => SIGNER_ENV.includes(name));
}

// Scenario: a signing host's Bash commit verifies; Read and cat of the key are refused (best effort), no key text
//   reaches the model, and GIT_CONFIG_COUNT is the child's only signer variable.
test("SG-1: a host signing with an ssh key file gets a signed Bash commit", { skip, timeout: 300_000 }, async (t) => {
	let file = "";
	let allowed = "";
	const run = await commitJob(t, "sg1", [
		{ name: "Read", input: () => ({ file_path: file }) },
		{ name: "Bash", input: () => ({ command: `cat ${file}` }) },
	], (h) => {
		({ file, allowed } = signingKey(h.fakeHome));
		appendFileSync(join(h.fakeHome, ".gitconfig"), signsConfig(file));
		return {};
	});
	assert.equal(git(run.wt, "log", "-1", "--format=%s"), "sg1");
	const checked = verifyCommit(run.wt, allowed);
	assert.ok(checked.ok, checked.out);
	assert.match(checked.out, /Good "git" signature/);
	const denied = await run.h.denials(run.id);
	assert.deepEqual(denied.lines.map((line) => line.split(":")[0]), ["Read", "Bash"], JSON.stringify(denied));
	assert.equal(run.results.some((each) => each.includes("PRIVATE KEY")), false, run.results.join("\n---\n"));
	assert.deepEqual(signerKeys(run.h, run.id), ["GIT_CONFIG_COUNT"]);
});

// Scenario: a host with no signing: the Bash commit lands unsigned and the CLI child gets no signer variable at all.
test("SG-2: a host that does not sign leaves Bash commits unsigned", { skip, timeout: 300_000 }, async (t) => {
	const run = await commitJob(t, "sg2", []);
	assert.equal(git(run.wt, "log", "-1", "--format=%s"), "sg2");
	assert.equal(hasSignature(run.wt), false);
	assert.deepEqual(signerKeys(run.h, run.id), []);
});

// Scenario: the host signs with a missing key file: the Bash commit fails naming commit_signing_unavailable,
//   an agent-written GIT_CONFIG_COUNT is refused, and no commit lands.
test("SG-3: an unreachable key fails the Bash commit by name", { skip, timeout: 300_000 }, async (t) => {
	const bypass: ClaudeToolUse = { name: "Bash", input: { command: "GIT_CONFIG_COUNT=0 git commit -q -m sg3" } };
	const run = await commitJob(t, "sg3", [bypass], (h) => {
		appendFileSync(join(h.fakeHome, ".gitconfig"), signsConfig(join(h.fakeHome, "keys", "missing")));
		return {};
	});
	assert.match(run.results[1] ?? "", UNREACHABLE, run.results.join("\n---\n"));
	const denied = await run.h.denials(run.id);
	assert.equal(denied.count, 1, JSON.stringify(denied));
	assert.match(denied.lines[0] ?? "", /GIT_CONFIG_COUNT/);
	assert.equal(git(run.wt, "rev-list", "--count", "origin/main..HEAD"), "0", "no commit landed");
});

/** J6's direct checkpoint RPC (native-freeze-checkpoint.test.ts) on fake-claude, under the host gitconfig `config`. */
async function frozen(t: TestContext, config: (home: string) => string) {
	const root = mkdtempSync(join(tmpdir(), "cp-sg4-"));
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	let reached = false;
	const hold: ClaudeStep = { kind: "text", text: "never sent", beforeAnswer: () => ((reached = true), held) };
	const provider = await startClaudeMockProvider([hold]);
	let worker: ChildProcessWithoutNullStreams | undefined;
	t.after(async () => {
		release();
		if (worker && worker.exitCode === null) worker.kill("SIGKILL");
		await provider.close();
		rmSync(root, { recursive: true, force: true });
	});
	const worktree = join(root, "repo");
	execFileSync("git", ["init", "-q", worktree]);
	git(worktree, "config", "user.name", "sg4 e2e");
	git(worktree, "config", "user.email", "sg4@test.invalid");
	writeFileSync(join(worktree, "README.md"), "demo\n");
	git(worktree, "add", "-A");
	git(worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
	const base = git(worktree, "rev-parse", "HEAD");
	execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
	git(worktree, "remote", "add", "origin", join(root, "origin.git"));
	writeFileSync(join(worktree, "wip.txt"), "half done\n");
	const home = join(root, "home");
	mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
	const settings = { env: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } };
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
	writeFileSync(join(home, ".gitconfig"), config(home));
	const bin = join(root, "bin");
	installClaudeStub(bin);
	const runDir = join(root, "run");
	mkdirSync(runDir);
	writeFileSync(join(runDir, "system.md"), "You are a test implementer.\n");
	const env = {
		PATH: [bin, process.env.PATH ?? ""].join(delimiter), HOME: home, CP_HOME: join(root, "cp-home"),
		CP_JOB_ID: "cp-sg4", CP_RUN_DIR: runDir, CP_WORKTREE: worktree, CP_KIND: "ship", CP_ROLE: "implementer",
		CP_DELIVERY: "pr", CP_NATIVE_SYSTEM_PROMPT_FILE: join(runDir, "system.md"),
	};
	worker = spawn(process.execPath, [WORKER], { env, stdio: ["pipe", "pipe", "pipe"] });
	const out: Array<{ type?: string; id?: unknown; success?: boolean; error?: string }> = [];
	let stderr = "";
	worker.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
	const parse = (line: string) => void out.push(JSON.parse(line) as (typeof out)[number]);
	createInterface({ input: worker.stdout }).on("line", parse);
	const send = (record: Record<string, unknown>) => worker!.stdin.write(`${JSON.stringify(record)}\n`);
	send({ id: 1, type: "prompt", message: "Write the feature." });
	await waitFor(() => reached, Boolean, { timeoutMs: 60_000, what: "the turn reaches the model" });
	send({ id: 2, type: "checkpoint" });
	const answered = () => out.find((line) => line.type === "response" && line.id === 2);
	const reply = await waitFor(answered, Boolean, { timeoutMs: 60_000, what: "the checkpoint reply" });
	return { worktree, home, base, reply: reply!, stderr: () => stderr };
}

// Scenario: a mid-turn implementer's freeze checkpoint verifies under a signing host; with a missing key file the
//   checkpoint fails naming commit_signing_unavailable and HEAD stays at the base commit.
test("SG-4: the freeze checkpoint signs, and fails by name on an unreachable key", { timeout: 240_000 }, async (t) => {
	const signed = await frozen(t, (home) => signsConfig(signingKey(home).file));
	assert.equal(signed.reply.success, true, `${JSON.stringify(signed.reply)}\n${signed.stderr()}`);
	assert.equal(git(signed.worktree, "log", "-1", "--format=%s"), "WIP: freeze checkpoint");
	const checked = verifyCommit(signed.worktree, join(signed.home, "keys", "allowed_signers"));
	assert.ok(checked.ok, checked.out);
	const missing = await frozen(t, (home) => signsConfig(join(home, "keys", "missing")));
	assert.equal(missing.reply.success, false, JSON.stringify(missing.reply));
	assert.match(missing.reply.error ?? "", UNREACHABLE);
	assert.equal(git(missing.worktree, "rev-parse", "HEAD"), missing.base);
});

// Scenario: the host signs but the clone's local config sets commit.gpgsign=false: the Bash commit lands unsigned,
//   as plain git would, while the other signing keys still reach the child.
test("SG-5: a repo-local commit.gpgsign=false still wins", { skip, timeout: 300_000 }, async (t) => {
	const run = await commitJob(t, "sg5", [], (h) => {
		appendFileSync(join(h.fakeHome, ".gitconfig"), signsConfig(signingKey(h.fakeHome).file));
		git(h.b.clone, "config", "commit.gpgsign", "false");
		return {};
	});
	assert.equal(git(run.wt, "config", "--local", "--get", "commit.gpgsign"), "false", "the lease shares it");
	assert.equal(git(run.wt, "log", "-1", "--format=%s"), "sg5");
	assert.equal(hasSignature(run.wt), false);
	assert.deepEqual(signerKeys(run.h, run.id), ["GIT_CONFIG_COUNT"]);
});

// Scenario: the host signs with an agent-held key (.pub path, private file gone): the Bash commit verifies, and the
//   socket reaches only picp's signer in the run dir, never the CLI child's env.
test("SG-6: an agent-held key signs through picp's signer", { skip, timeout: 300_000 }, async (t) => {
	let allowed = "";
	const run = await commitJob(t, "sg6", [], async (h) => {
		const made = signingKey(h.fakeHome);
		allowed = made.allowed;
		const socket = await signingAgent(t, h.fakeHome, made.file);
		appendFileSync(join(h.fakeHome, ".gitconfig"), signsConfig(`${made.file}.pub`));
		return { SSH_AUTH_SOCK: socket };
	});
	const checked = verifyCommit(run.wt, allowed);
	assert.ok(checked.ok, checked.out);
	assert.deepEqual(signerKeys(run.h, run.id), ["GIT_CONFIG_COUNT"]);
	assert.ok(existsSync(join(run.h.b.home, paths.runDir(run.id), "ssh-signer")), "picp wrote the signer");
});
