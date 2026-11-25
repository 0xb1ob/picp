/**
 * Worker commit signing on the Codex CLI driver, fake-codex at the boundary: git_commit and the freeze checkpoint
 * sign in the worker process; an unreachable key fails git_commit by name; a non-signing host adds no env var.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { fakeExecuted, fakeHooks, fakeSpawns } from "../harness/codex-mock.ts";
import { codexWorkerHome } from "../harness/codex-worker.ts";
import { hasSignature, signingAgent, signingKey, signsConfig, verifyCommit } from "../harness/commit-signing.ts";
import { readRunEvents, type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = process.env.CI === "true" || treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type Result = { tool: string; result: { success?: boolean; contentItems?: Array<{ text?: string }> } };
const SIGNER_ENV = ["GIT_CONFIG_COUNT", "SSH_AUTH_SOCK", "GNUPGHOME"];
const UNREACHABLE = /commit_signing_unavailable: user\.signingkey names a key file that is missing or unreadable/;
const FILES = { ".github/workflows/ci.yml": "name: ci\n" };
const shipHome = (t: TestContext) => codexWorkerHome(t, { native: { codex_ship: true }, files: FILES, ship: true });
/** The host gitconfig the harness points GIT_CONFIG_GLOBAL at (tests/harness/codex-worker.ts). */
const hostConfig = (h: H): string => join(h.root, "forge", "gitconfig");
const text = (entry: Result): string => (entry.result.contentItems ?? []).map((part) => part.text ?? "").join("\n");
const commits = (h: H) => h.lines<Result>("tool-results.jsonl").filter((entry) => entry.tool === "git_commit")
	.map((entry) => ({ ok: entry.result.success === true, text: text(entry) }));

/** A `git` first on PATH that logs each commit's argv and env names, then runs the real git: a spy at the boundary. */
function gitSpy(h: H) {
	const dir = join(h.root, "git-spy");
	mkdirSync(dir);
	const log = join(dir, "commits.log");
	const real = whichAll("git", process.env)[0];
	assert.ok(real !== undefined, "git is on PATH");
	writeFileSync(join(dir, "git"), [
		"#!/bin/sh",
		'case " $* " in *" commit "*)',
		`\tprintf '%s %s\\n' '---' "$*" >> '${log}'`,
		`\tenv | cut -d= -f1 | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' >> '${log}' ;;`,
		"esac",
		`exec '${real}' "$@"`,
		"",
	].join("\n"), { mode: 0o755 });
	const commits = () => {
		const blocks: Array<{ args: string; names: string[] }> = [];
		for (const line of existsSync(log) ? readFileSync(log, "utf8").split("\n") : []) {
			if (line.startsWith("--- ")) blocks.push({ args: line.slice(4), names: [] });
			else if (line !== "") blocks.at(-1)?.names.push(line);
		}
		return blocks;
	};
	return { env: { PATH: `${dir}${delimiter}${h.env.PATH}` }, commits };
}

// Scenario: a signing host: git_commit and the /cp-drain freeze checkpoint both verify; git_commit's git got the
//   pairs but no SSH_AUTH_SOCK, and no app-server env carries a signer variable.
test("CS-1: a signing host gets a signed git_commit and freeze checkpoint", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const { file, allowed } = signingKey(h.root);
	appendFileSync(hostConfig(h), signsConfig(file));
	const spy = gitSpy(h);
	const job = await h.job("pr", "ship");
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'one\\n' > one.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "cs1 commit" } },
		{ kind: "shell", command: "printf 'half done\\n' > wip.txt" },
		{ kind: "hold", marker: "held" },
	]] });
	const gate = join(h.root, "parent-gate");
	const wait: ScriptStep = { kind: "tool_calls", calls: [{ name: "bash", args: {
		command: `for i in $(seq 1500); do [ -f "${gate}" ] && break; sleep 0.2; done`,
	} }] };
	const running = h.run([job.dispatch({ task: "Add one.txt." }), wait], spy.env);
	const holding = { timeoutMs: 120_000, what: "the codex implementer is mid-turn" };
	await waitFor(() => existsSync(join(h.state, "held")), Boolean, holding);
	const parent = h.b.parents.at(-1)!;
	const records = parent.records().length;
	await parent.prompt("/cp-drain 120 freeze");
	await parent.waitFor((r) => parent.records().indexOf(r) >= records && r.type === "extension_ui_request"
		&& String(r.message).startsWith("DRAIN:"), 60_000);
	const settled = () => readRunEvents(h.b.home, job.id).filter((event) => event.type === "agent_settled");
	await waitFor(settled, (found) => found.length > 0, { timeoutMs: 60_000, what: "the frozen worker settles" });
	assert.equal(commits(h)[0]?.ok, true, JSON.stringify(commits(h)));
	const subjects = [h.git(job.id, "log", "-1", "--format=%s"), h.git(job.id, "log", "-1", "--format=%s", "HEAD~1")];
	assert.deepEqual(subjects, ["WIP: freeze checkpoint", "cs1 commit"]);
	for (const rev of ["HEAD", "HEAD~1"]) {
		const checked = verifyCommit(h.worktree(job.id), allowed, rev);
		assert.ok(checked.ok, `${rev}: ${checked.out}`);
	}
	const block = spy.commits().find((each) => each.args.endsWith("-m cs1 commit"));
	const passed = block?.names.filter((name) => SIGNER_ENV.includes(name));
	assert.deepEqual(passed, ["GIT_CONFIG_COUNT"], JSON.stringify(block));
	for (const spawned of fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server")) {
		assert.deepEqual(spawned.env.filter((name) => /^GIT_CONFIG_|^SSH_AUTH_SOCK$|^GNUPGHOME$/.test(name)), []);
	}
	writeFileSync(gate, "open\n");
	await running;
});

// Scenario: a host with no signing: git_commit lands unsigned, and its git env (gitEnv) holds none of
//   GIT_CONFIG_COUNT, SSH_AUTH_SOCK and GNUPGHOME.
test("CS-2: a non-signing host leaves git_commit and gitEnv unchanged", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const spy = gitSpy(h);
	const job = await h.job("local", "ship");
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'two\\n' > two.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "cs2" } },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local") },
		{ kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add two.txt." }), h.awaitEnvelope(job.id)], spy.env);
	assert.equal(commits(h)[0]?.ok, true, JSON.stringify(commits(h)));
	assert.equal(h.git(job.id, "log", "-1", "--format=%s"), "cs2");
	assert.equal(hasSignature(h.worktree(job.id)), false);
	const block = spy.commits().find((each) => each.args.endsWith("-m cs2"));
	assert.ok(block !== undefined, JSON.stringify(spy.commits()));
	assert.deepEqual(block.names.filter((name) => SIGNER_ENV.includes(name)), []);
});

// Scenario: the host signs with a missing key file: git_commit fails naming commit_signing_unavailable and no
//   commit lands.
test("CS-3: an unreachable signing key fails Codex git_commit by name", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	appendFileSync(hostConfig(h), signsConfig(join(h.root, "keys", "missing")));
	const job = await h.job("local", "ship");
	const over = { status: "blocked", summary: "Signing unavailable.", blockers: ["the e2e ends here"] };
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'three\\n' > three.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "cs3" } },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local", over) },
		{ kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add three.txt." }), h.awaitEnvelope(job.id)]);
	const [commit] = commits(h);
	assert.equal(commit?.ok, false, JSON.stringify(commit));
	assert.match(commit?.text ?? "", UNREACHABLE);
	assert.equal(h.git(job.id, "rev-list", "--count", "origin/main..HEAD"), "0", "no commit landed");
});

// Scenario: the host signs with an agent-held key (.pub, private file gone, SSH_AUTH_SOCK set for picp): git_commit
//   verifies through picp's signer; neither the Codex shell env (app-server) nor git_commit's env holds SSH_AUTH_SOCK
//   or GNUPGHOME; a shell read of the key path is refused by picp's guard, best effort.
test("CS-4: an agent key signs git_commit; the shell env gets no agent",{ skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const { file, allowed } = signingKey(h.root);
	const socket = await signingAgent(t, h.root, file);
	appendFileSync(hostConfig(h), signsConfig(`${file}.pub`));
	const spy = gitSpy(h);
	const job = await h.job("local", "ship");
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'four\\n' > four.txt" },
		{ kind: "shell", command: `cat ${file}` },
		{ kind: "tool", tool: "git_commit", arguments: { message: "cs4" } },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local") },
		{ kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add four.txt." }), h.awaitEnvelope(job.id)], { ...spy.env, SSH_AUTH_SOCK: socket });
	assert.equal(commits(h)[0]?.ok, true, JSON.stringify(commits(h)));
	const checked = verifyCommit(h.worktree(job.id), allowed);
	assert.ok(checked.ok, checked.out);
	assert.ok(existsSync(join(h.b.home, paths.runDir(job.id), "ssh-signer")), "picp wrote the signer");
	const block = spy.commits().find((each) => each.args.endsWith("-m cs4"));
	const passed = block?.names.filter((name) => SIGNER_ENV.includes(name));
	assert.deepEqual(passed, ["GIT_CONFIG_COUNT"], JSON.stringify(block));
	const servers = fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");
	assert.ok(servers.length > 0, "an app-server was spawned");
	for (const spawned of servers) {
		assert.deepEqual(spawned.env.filter((name) => /^GIT_CONFIG_|^SSH_AUTH_SOCK$|^GNUPGHOME$/.test(name)), []);
	}
	const refused = fakeHooks(h.state).filter((each) => each.status === "blocked");
	assert.equal(refused.length, 1, JSON.stringify(fakeHooks(h.state)));
	assert.match(refused[0]?.stderr ?? "", /secret path/);
	assert.equal(fakeExecuted(h.state).some((command) => command.includes(file)), false);
});
