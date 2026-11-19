/**
 * C7b: ship jobs on the Codex CLI driver through the real `cp_dispatch`, `cp_send`, `cp_revive`, `cp_teardown` and
 * `/cp-drain freeze` of a pi parent (mock parent model), with tests/fixtures/fake-codex.ts, the fake `systemd-run`
 * and the scripted forge `gh` at the boundary (tests/harness/codex-worker.ts). Every case checks the Codex home.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { NATIVE_CODEX_SESSION_FILE, nativeRevivePrompt, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { CODEX_LOCAL_SHIP_ADDENDUM, CODEX_SHIP_ADDENDUM } from "../../src/drivers/codex.ts";
import { codexExcludedRoots, codexPermissionProfile } from "../../src/drivers/codex-launch.ts";
import { AUTH_SENTINEL, type FakeCodexScript, type FakeCodexStep, fakePatched, fakePrompts, fakeRpcMethods, fakeScopes, fakeSpawns, fakeThreads, fakeThreadTotal } from "../harness/codex-mock.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");
const tool = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
/** The `native_run` event lines only (a failure message also names native_run). */
const RUN = '"type":"native_run"';
const FILES = { ".github/workflows/ci.yml": "name: ci\n" };
const shipHome = (t: Parameters<typeof codexWorkerHome>[0], native: Record<string, unknown> | null = { codex_ship: true }) =>
	codexWorkerHome(t, { native, files: FILES, ship: true });
const appServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const failed = (h: H, id: string) => waitFor(() => h.record(id), (record) => record?.phase === "failed", { timeoutMs: 60_000, what: `${id} failed on its observed exit` });
const transcript = (h: H, id: string) => readFileSync(readRunStatus(h.b.home, id).transcript_file as string, "utf8");
const toolResults = (h: H, name: string) => h.lines<{ tool: string; result: { success?: boolean; contentItems?: Array<{ text?: string }> } }>("tool-results.jsonl")
	.filter((entry) => entry.tool === name).map((entry) => ({ ok: entry.result.success === true, text: (entry.result.contentItems ?? []).map((part) => part.text ?? "").join("\n") }));
const envelope = (h: H, id: string) => (JSON.parse(readFileSync(join(h.b.home, paths.envelopeFile(id)), "utf8")) as { envelope: Record<string, unknown> }).envelope;
const reset = (h: H, script: FakeCodexScript) => {
	h.setScript(script);
	for (const file of ["cursor.json", "tool-results.jsonl", "rpc.jsonl"]) rmSync(join(h.state, file), { force: true });
};
const workerGone = (h: H, id: string) => waitFor(() => h.record(id)?.worker.pid, (pid) => pid === undefined || !isPidAlive(pid), { timeoutMs: 30_000, what: `${id}'s worker exited` });
const allScopesKilled = (h: H) => waitFor(() => fakeScopes(h.state), (scopes) => scopes.filter((each) => each.killed !== undefined || each.collected).length >= scopes.filter((each) => each.started).length,
	{ timeoutMs: 20_000, what: "every started scope killed or collected" });

/** The Codex home is untouched, and no host OPENAI_/CODEX_ (but CODEX_HOME) or GH_ key reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of appServers(h)) assert.deepEqual(spawn.env.filter((key) => /^(?:OPENAI_|GH_)/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
}

/** The `picp_implementer` filesystem map from the last app-server argv that carries it. */
function implementerProfile(h: H): Record<string, string> {
	const flag = appServers(h).flatMap((each) => each.argv).filter((arg) => arg.startsWith("permissions.picp_implementer=")).at(-1) ?? "";
	return Object.fromEntries([...flag.matchAll(/("(?:[^"\\]|\\.)*")=("read"|"write"|"deny")/g)].map((m) => [JSON.parse(m[1] as string), JSON.parse(m[2] as string)]));
}

// Scenario: a codex ship job commits, pushes only its branch, opens one draft PR and reports head_sha
//   Given codex_ship on, a pre-commit hook in the canonical clone and the scripted forge gh
//   When cp_dispatch runs the job and cp_teardown ends it, Then only refs/heads/<job> moved, the hook never ran,
//   the thread had no MCP server, the lockdown was ok at cost 0 and teardown deleted the thread.
test("CX-7a: a codex ship job commits, pushes only its branch, opens a draft PR, reports head_sha and tears down", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("pr", "ship");
	const hook = join(h.outside, "hook-ran");
	const hooks = join(h.b.clone, ".git", "hooks");
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch '${hook}'\n`, { mode: 0o755 });
	const before = h.originRefs();
	h.setScript({ turns: [[
		{ kind: "shell", command: "mkdir -p src && printf 'x\\n' > src/x.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "Add src/x.txt" } },
		{ kind: "tool", tool: "git_push", arguments: {} },
		{ kind: "tool", tool: "pr_create", arguments: { title: "Ship x", body: "Codex ship e2e." } },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id) },
		{ kind: "message", text: "Reported." },
	]] });
	const [dispatched] = (await h.run([job.dispatch({ task: "Add src/x.txt." }), h.awaitEnvelope(job.id), h.pause(2)])).filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(dispatched?.isError, true, text(dispatched));
	const record = h.record(job.id);
	assert.deepEqual([record?.worker.driver, record?.worker.role, record?.routing?.driver], ["codex", "implementer", "codex"]);
	const worktree = h.worktree(job.id);
	const head = h.git(job.id, "rev-parse", "HEAD");
	const after = h.originRefs();
	assert.equal(after[`refs/heads/${job.id}`], head, "origin/<job> is the worktree HEAD");
	assert.equal(after["refs/heads/main"], before["refs/heads/main"], "main unchanged");
	assert.deepEqual(Object.keys(after).filter((ref) => before[ref] !== after[ref]), [`refs/heads/${job.id}`], "only the job branch moved");
	assert.equal(envelope(h, job.id).head_sha, head);
	assert.equal(h.git(job.id, "show", "HEAD:src/x.txt"), "x");
	assert.equal(existsSync(hook), false, "C3: git ran no repository hook");
	assert.ok(existsSync(join(h.git(job.id, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks", "pre-commit")), "the hook sat in the worktree's common dir");
	const created = h.ghCalls().filter((line) => line.startsWith("pr create"));
	assert.equal(created.length, 1, created.join("\n"));
	assert.match(created[0] ?? "", new RegExp(`^pr create --draft --head ${job.id} `));
	// The kernel profile: the worktree written, its .git and the git common dir read.
	const profile = implementerProfile(h);
	assert.equal(profile[realpathSync(worktree)], "write", JSON.stringify(profile));
	assert.equal(profile[join(realpathSync(worktree), ".git")], "read");
	assert.equal(profile[realpathSync(h.git(job.id, "rev-parse", "--path-format=absolute", "--git-common-dir"))], "read");
	assert.equal(profile[join(realpathSync(worktree), ".github", "workflows")], "read", "an existing excluded path is read-only");
	// R3: no MCP server; the ship tools on thread/start.
	const threads = fakeThreads(h.state);
	assert.ok(threads.length > 0 && threads.every((each) => each.mcpServers.length === 0), JSON.stringify(threads));
	assert.deepEqual(threads[0]?.dynamicTools, ["gh_read", "git_commit", "git_fetch", "git_merge", "git_push", "pr_create", "pr_edit", "report_result"]);
	const [run] = await h.runs(job.id);
	assert.deepEqual([run?.lockdown, run?.bypass, run?.cost_unknown, run?.report], ["ok", undefined, true, true], JSON.stringify(run));
	assert.equal(readRunStatus(h.b.home, job.id).usage.cost_usd, 0);
	assert.match(readFileSync(join(h.b.home, paths.runDir(job.id), "codex-system-prompt.md"), "utf8"), new RegExp(CODEX_SHIP_ADDENDUM.slice(0, 60)));
	assert.equal(h.session(job.id).base, "main", "the dispatch base reached the worker");
	await h.b.closeParents();
	const [down] = (await h.run([tool("cp_teardown", { job_id: job.id })])).filter((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	assert.equal((ofType(h, job.id, "native_thread_deleted")[0]?.payload as { deleted?: boolean } | undefined)?.deleted, true);
	await allScopesKilled(h);
	assertClean(h);
});

// Scenario: every forbidden write or forge step is refused with its remedy, and a valid one still lands
//   Given a codex implementer, When its shell writes outside, into an excluded dir and into .git, runs git and gh
//   writes, and git_push/git_merge are called out of scope, Then nothing lands, main is unchanged, and the valid
//   commit, push and report still land.
test("CX-7b: writes outside the profile, git and gh writes in the shell, and out-of-scope forge calls are refused; a valid ship still lands", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("pr", "ship");
	const before = h.originRefs();
	h.setScript({ turns: [[
		{ kind: "shell", command: `printf 'x\\n' > ${join(h.outside, "o.txt")}` },
		{ kind: "shell", command: "printf 'x\\n' > .github/workflows/evil.yml" },
		{ kind: "shell", command: "printf 'x\\n' > .git/hooks-evil" },
		{ kind: "shell", command: "git commit -am sneaky" },
		{ kind: "shell", command: "git push origin HEAD" },
		{ kind: "shell", command: "git fetch origin" },
		{ kind: "shell", command: "gh pr create --title x --body y" },
		{ kind: "tool", tool: "git_push", arguments: { branch: "main" } },
		{ kind: "tool", tool: "git_push", arguments: { force: true } },
		{ kind: "tool", tool: "git_merge", arguments: { ref: "origin/other" } },
		{ kind: "shell", command: "printf 'ok\\n' > ok.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "ok" } },
		{ kind: "tool", tool: "git_push", arguments: {} },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id) },
		{ kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add ok.txt." }), h.awaitEnvelope(job.id), h.pause(2)]);
	const worktree = h.worktree(job.id);
	assert.equal(existsSync(join(h.outside, "o.txt")), false, "outside");
	assert.equal(existsSync(join(worktree, ".github", "workflows", "evil.yml")), false, "excluded dir");
	assert.equal(readFileSync(join(worktree, ".git"), "utf8").startsWith("gitdir: "), true, ".git is still the worktree's link file");
	assert.equal(existsSync(join(worktree, ".git", "hooks-evil")), false);
	const log = transcript(h, job.id);
	assert.match(log, /never writes git or reaches a remote \(`git commit`\)[^"]*Use git_commit/);
	assert.match(log, /\(`git push`\)[^"]*Use git_push/);
	assert.match(log, /\(`git fetch`\)[^"]*git_fetch, then git_merge/, "C7a note: the fetch refusal names git_merge for codex");
	const pushes = toolResults(h, "git_push");
	assert.match(pushes[0]?.text ?? "", /Refused: git_push never pushes main/);
	assert.match(pushes[1]?.text ?? "", /Refused: git_push never forces a push/);
	assert.equal(pushes[2]?.ok, true, pushes[2]?.text);
	assert.match(toolResults(h, "git_merge")[0]?.text ?? "", new RegExp(`Refused: git_merge merges only origin/${job.id} or origin/main, not origin/other`));
	const after = h.originRefs();
	assert.equal(after["refs/heads/main"], before["refs/heads/main"]);
	assert.equal(after[`refs/heads/${job.id}`], h.git(job.id, "rev-parse", "HEAD"));
	assert.deepEqual(h.git(job.id, "show", "--name-only", "--format=", "HEAD").split("\n"), ["ok.txt"]);
	assert.equal(h.ghCalls().filter((line) => line.startsWith("pr create")).length, 0, "the shell's gh never ran");
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assertClean(h);
});

// Scenario: with a dead hook and a user allow rule, a codex implementer's effect is one in-worktree file at most
//   Given `touch` auto-approved and picp's hook killed, When job A touches r1.txt, B an excluded file, C commits,
//   Then each job fails `lockdown` with hook_failed; A leaves exactly `?? r1.txt`, B nothing, C no commit or push;
//   And (C1) cp_revive of A names r1.txt to the operator and the worker before any relaunch, never committing it.
test("CX-7c: a dead hook leaves one worktree file at most and runs no picp tool; a revive names that dirt first (C1)", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const [a, b, c] = [await h.job("pr", "ship"), await h.job("pr", "ship"), await h.job("pr", "ship")];
	const main = h.originRefs()["refs/heads/main"];
	const cases: Array<[typeof a, FakeCodexStep[]]> = [
		[a, [{ kind: "shell", command: "touch r1.txt", hook: "kill" }, { kind: "shell", command: "touch later.txt" }]],
		[b, [{ kind: "shell", command: "touch .github/workflows/r1.yml", hook: "kill" }]],
		[c, [
			{ kind: "shell", command: "printf 'c\\n' > c.txt" },
			{ kind: "tool", tool: "git_commit", arguments: { message: "dead hook" }, hook: "kill" },
			{ kind: "tool", tool: "git_push", arguments: {} },
			{ kind: "tool", tool: "pr_create", arguments: { title: "x", body: "y" } },
		]],
	];
	for (const [job, steps] of cases) {
		reset(h, { knobs: { autoApprove: ["touch"], modelMs: 1_000 }, turns: [steps] });
		await h.b.closeParents();
		await h.run([job.dispatch({ task: "Ship." })]);
		const record = await failed(h, job.id);
		const [run] = await h.runs(job.id);
		assert.deepEqual([run?.stop, run?.hook_failed, record?.failure?.class], ["lockdown", true, "spawn_failed"], JSON.stringify(run));
		assert.equal(h.git(job.id, "rev-parse", "HEAD"), main, "no commit");
		assert.equal(h.originRefs()[`refs/heads/${job.id}`], undefined, "no push");
		await allScopesKilled(h);
	}
	assert.equal(h.git(a.id, "status", "--porcelain", "--untracked-files=all"), "?? r1.txt", "A: one unasked in-worktree file, no later step");
	assert.equal(existsSync(join(h.worktree(b.id), ".github", "workflows", "r1.yml")), false, "B: the excluded dir held");
	assert.equal(toolResults(h, "git_commit").filter((each) => each.ok).length, 0, "C: no picp tool ran");
	assert.equal(h.ghCalls().filter((line) => line.startsWith("pr create")).length, 0, "C: no PR");
	// C1: the revive names A's dirt to the operator and to the worker before the relaunch, and commits nothing.
	reset(h, { turns: [[{ kind: "message", text: "Inspecting r1.txt before anything else." }]] });
	await h.b.closeParents();
	await workerGone(h, a.id);
	const ends = await h.run([tool("cp_revive", { job_id: a.id, confirm: true }), h.waitEvent(a.id, RUN, 2)]);
	const revived = ends.find((end) => end.toolName === "cp_revive");
	assert.notEqual(revived?.isError, true, text(revived));
	assert.match(text(revived), /left uncommitted paths nobody reviewed: r1\.txt/);
	assert.deepEqual((ofType(h, a.id, "worker_revived")[0]?.payload as { unreviewed_changes?: string[] } | undefined)?.unreviewed_changes, ["r1.txt"]);
	const prompt = fakePrompts(h.state).find((each) => each.text.startsWith(nativeRevivePrompt("ship")))?.text ?? "";
	assert.match(prompt, /these uncommitted paths in the worktree were never reviewed: r1\.txt\. [^]*never call it before these are reviewed/);
	assert.equal(h.git(a.id, "rev-parse", "HEAD"), main, "the dirt was not committed");
	assert.equal(h.git(a.id, "status", "--porcelain", "--untracked-files=all"), "?? r1.txt");
	assertClean(h);
});

// Scenario: every patch is declined for an implementer (F5)
//   Given a codex implementer, When it sends a patch with a healthy hook, one the CLI applies unasked, and one with a
//   dead hook, Then the hook names the shell remedy, the unasked one kills the run as a bypass, the dead-hook one is
//   declined, and no patch is ever accepted.
test("CX-7d: a patch is refused naming the shell remedy; an unasked apply is a bypass; a dead hook's patch is declined", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const [hooked, unasked, dead] = [await h.job("local", "ship"), await h.job("local", "ship"), await h.job("local", "ship")];
	reset(h, { turns: [[{ kind: "patch", path: "p1.txt" }, { kind: "message", text: "Done." }]] });
	await h.run([hooked.dispatch({ task: "Patch." }), h.waitEvent(hooked.id, RUN, 1)]);
	assert.equal(existsSync(join(h.worktree(hooked.id), "p1.txt")), false);
	assert.match(transcript(h, hooked.id), /never applies a patch[^"]*Write files with the shell \(a quoted heredoc/);
	for (const [job, script, file] of [
		[unasked, { knobs: { patchApply: "unasked" }, turns: [[{ kind: "patch" as const, path: "p2.txt", hook: "skip" as const }, { kind: "message" as const, text: "x" }]] }, "p2.txt"],
		[dead, { knobs: { modelMs: 500 }, turns: [[{ kind: "patch" as const, path: "p3.txt", hook: "kill" as const }, { kind: "message" as const, text: "x" }]] }, "p3.txt"],
	] as const) {
		reset(h, script as unknown as FakeCodexScript);
		await h.b.closeParents();
		await h.run([job.dispatch({ task: "Patch." })]);
		await failed(h, job.id);
		const [run] = await h.runs(job.id);
		assert.equal(run?.stop, "lockdown", JSON.stringify(run));
		if (job === unasked) assert.equal(run?.bypass, "fileChange");
		else {
			assert.equal(run?.hook_failed, true);
			assert.equal(existsSync(join(h.worktree(job.id), file)), false, "the dead hook's patch was declined");
		}
		await allScopesKilled(h);
	}
	assert.deepEqual(fakePatched(h.state), ["p2.txt"], "only the CLI's own unasked apply wrote");
	assertClean(h);
});

// Scenario: the staged-path gate refuses a commit holding an excluded path the kernel could not list
//   Given exclude_paths `**/.env*` and no such file at the run's start, When the shell writes a/.env.local and
//   ok.txt and calls git_commit, Then the commit is refused naming a/.env.local; after removing it the commit lands.
test("CX-7e: git_commit refuses a later-created excluded path by name and commits once it is gone", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("local", "ship");
	const base = h.originRefs()["refs/heads/main"];
	h.setScript({ turns: [[
		{ kind: "shell", command: "node -e \"const f=require('fs');f.mkdirSync('a',{recursive:true});f.writeFileSync('a/.e'+'nv.local','X=1')\"" },
		{ kind: "shell", command: "printf 'ok\\n' > ok.txt" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "first" } },
		{ kind: "shell", command: "git status --porcelain --untracked-files=all" },
		{ kind: "shell", command: "rm -r a" },
		{ kind: "tool", tool: "git_commit", arguments: { message: "second" } },
		{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local") },
		{ kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add ok.txt." }), h.awaitEnvelope(job.id), h.pause(2)]);
	const [first, second] = toolResults(h, "git_commit");
	assert.equal(first?.ok, false);
	assert.match(first?.text ?? "", /Refused: git_commit never commits an excluded path \(exclude_paths\): a\/\.env\.local\. Nothing was committed and the index is unstaged/);
	// The shell's status after the refusal: both files untracked again, nothing staged.
	assert.match(transcript(h, job.id), /\?\? a\/\.env\.local\\n\?\? ok\.txt/);
	assert.equal(second?.ok, true, second?.text);
	assert.deepEqual(h.git(job.id, "log", "--format=%s", `${base}..HEAD`).split("\n"), ["second"], "one commit, after the refusal");
	assert.deepEqual(h.git(job.id, "show", "--name-only", "--format=", "HEAD").split("\n"), ["ok.txt"]);
	assert.equal(envelope(h, job.id).head_sha, h.git(job.id, "rev-parse", "HEAD"));
	assertClean(h);
});

// Scenario: a freeze drain checkpoints a mid-turn codex implementer (Q2)
//   Given a codex implementer mid-turn with an uncommitted file, When /cp-drain freeze runs, Then the drain line names
//   the native codex checkpoint, the WIP is committed and pushed, every scope ends, the worker settles idle, and a
//   revive after the restart resumes the same thread with its tokens counted once.
test("CX-7f: /cp-drain freeze checkpoints a mid-turn codex implementer: WIP committed and pushed, scopes gone, the thread resumes once", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("pr", "ship");
	h.setScript({ turns: [
		[
			{ kind: "shell", command: "printf 'half done\\n' > wip.txt" },
			{ kind: "shell", command: "node -e \"require('fs').writeFileSync('.e'+'nv.local','X=1')\"" },
			{ kind: "hold", marker: "held" },
		],
		[{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "pr", { status: "blocked", summary: "Resumed after the freeze.", blockers: ["the e2e ends here"], pr_url: undefined }) }, { kind: "message", text: "Reported." }],
	] });
	const gate = join(h.root, "parent-gate");
	const running = h.run([job.dispatch({ task: "Add wip.txt." }), tool("bash", { command: `for i in $(seq 1500); do [ -f "${gate}" ] && break; sleep 0.2; done` })]);
	await waitFor(() => existsSync(join(h.state, "held")), Boolean, { timeoutMs: 120_000, what: "the codex implementer is mid-turn" });
	const parent = h.b.parents.at(-1)!;
	const records = parent.records().length;
	await parent.prompt("/cp-drain 120 freeze");
	const ui = await parent.waitFor((r) => parent.records().indexOf(r) >= records && r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 60_000);
	await waitFor(() => ofType(h, job.id, "agent_settled"), (found) => found.length > 0, { timeoutMs: 60_000, what: "the frozen worker settles idle" });
	const head = h.git(job.id, "rev-parse", "HEAD");
	assert.ok(String((ui as Record<string, unknown>).message).includes(`freeze: ${job.id} checkpointed (native codex at ${head})`), String((ui as Record<string, unknown>).message));
	assert.deepEqual([h.git(job.id, "log", "-1", "--format=%s"), h.git(job.id, "show", "HEAD:wip.txt")], ["WIP: freeze checkpoint", "half done"]);
	// The staged-path gate held for the checkpoint too: the excluded file stays uncommitted and is named.
	assert.equal(h.git(job.id, "status", "--porcelain", "--untracked-files=all"), "?? .env.local");
	const checkpoint = ofType(h, job.id, "native_checkpoint")[0]?.payload as { head?: string; pushed?: boolean; excluded?: string[] } | undefined;
	assert.deepEqual([checkpoint?.head, checkpoint?.pushed, checkpoint?.excluded], [head, true, [".env.local"]], JSON.stringify(checkpoint));
	assert.equal(h.originRefs()[`refs/heads/${job.id}`], head, "the WIP head is on origin/<job>");
	const types = readRunEvents(h.b.home, job.id).map((event) => event.type);
	assert.ok(types.indexOf("native_run") < types.indexOf("native_checkpoint") && types.indexOf("native_checkpoint") < types.indexOf("agent_settled"), types.join(","));
	assert.equal((ofType(h, job.id, "native_run")[0]?.payload as { stop?: string }).stop, undefined, "a frozen turn is no named failure");
	await allScopesKilled(h);
	assert.notEqual(h.record(job.id)?.phase, "failed");
	writeFileSync(gate, "open\n");
	await running;
	await h.b.closeParents();
	await workerGone(h, job.id);
	const threadId = h.session(job.id).thread_id;
	const ends = await h.run([tool("cp_revive", { job_id: job.id, confirm: true }), h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 2)]);
	assert.match(text(ends.find((end) => end.toolName === "cp_revive")), /resumed its Codex CLI thread/);
	assert.equal(fakeRpcMethods(h.state).filter((method) => method === "thread/resume").length, 1);
	assert.deepEqual(fakePrompts(h.state).map((each) => each.threadId), [threadId, threadId], "the same thread resumed");
	assert.equal(readRunStatus(h.b.home, job.id).usage.total_tokens, fakeThreadTotal(h.state, threadId as string).totalTokens, "KC4: tokens counted once");
	assertClean(h);
});

// Scenario: a moved worktree starts a fresh thread led by the brief (Q4)
//   Given a codex ship job whose session record names another worktree, When cp_revive runs, Then the old thread is
//   deleted, a second thread/start (no resume) carries the brief first, and the job reports.
test("CX-7g: a revive from a moved worktree deletes the old thread and starts a fresh one led by the brief", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("local", "ship");
	h.setScript({ turns: [[{ kind: "hold", marker: "held" }], [{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local") }, { kind: "message", text: "Reported." }]] });
	await h.run([job.dispatch({ task: "Unique brief text CX7G." }), h.awaitFile(join(h.state, "held"))]);
	await h.b.closeParents();
	await workerGone(h, job.id);
	const sessionFile = join(h.b.home, paths.runDir(job.id), NATIVE_CODEX_SESSION_FILE);
	const old = readNativeSession(sessionFile);
	assert.ok(old.thread_id);
	writeFileSync(sessionFile, `${JSON.stringify({ ...old, cwd: "/leases/moved/picp" })}\n`);
	const ends = await h.run([tool("cp_revive", { job_id: job.id, confirm: true }), h.waitEvent(job.id, "envelope_received", 1)]);
	assert.notEqual(ends.find((end) => end.toolName === "cp_revive")?.isError, true, text(ends[0]));
	assert.equal((ofType(h, job.id, "native_session_moved")[0]?.payload as { from?: string } | undefined)?.from, "/leases/moved/picp");
	const deleted = ofType(h, job.id, "native_thread_deleted")[0]?.payload as { deleted?: boolean; thread_id?: string } | undefined;
	assert.deepEqual([deleted?.deleted, deleted?.thread_id], [true, old.thread_id], JSON.stringify(deleted));
	const methods = fakeRpcMethods(h.state);
	assert.deepEqual([methods.filter((m) => m === "thread/start").length, methods.filter((m) => m === "thread/resume").length], [2, 0]);
	const brief = readFileSync(join(h.b.home, paths.briefFile(job.id)), "utf8").trimEnd();
	const prompt = fakePrompts(h.state).find((each) => each.threadId !== old.thread_id);
	assert.ok(prompt?.text.startsWith(brief) && prompt.text.includes(nativeRevivePrompt("ship")), prompt?.text.slice(0, 300));
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	assertClean(h);
});

// Scenario: a CI repair resumes the same thread and merges the moved base (git_merge allow-list)
//   Given a reported codex ship job and a new commit on origin/main, When cp_send asks it to merge the base,
//   Then one thread/resume runs git_fetch, git_merge origin/main and git_push, and origin/<job> is a merge commit.
test("CX-7h: cp_send to a held codex ship job resumes its thread, merges origin/main and pushes a fast-forward", { skip, timeout: 420_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("pr", "ship");
	const work = mkdtempSync(join(tmpdir(), "cp-cx7h-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));
	execFileSync("git", ["clone", "--quiet", execFileSync("git", ["-C", h.b.clone, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(), work]);
	const moveMain = `cd '${work}' && printf 'base\\n' > base.txt && git add -A && git -c user.name=b -c user.email=b@test.invalid commit -q -m base-moved && git push -q origin HEAD:main`;
	h.setScript({ turns: [
		[
			{ kind: "shell", command: "printf 'x\\n' > x.txt" }, { kind: "tool", tool: "git_commit", arguments: { message: "x" } }, { kind: "tool", tool: "git_push", arguments: {} },
			{ kind: "tool", tool: "pr_create", arguments: { title: "x", body: "y" } }, { kind: "tool", tool: "report_result", arguments: h.shipReport(job.id) }, { kind: "message", text: "Reported." },
		],
		[
			{ kind: "tool", tool: "git_fetch", arguments: {} }, { kind: "tool", tool: "git_merge", arguments: { ref: "origin/main" } },
			{ kind: "tool", tool: "git_commit", arguments: { message: "nothing left" } }, { kind: "tool", tool: "git_push", arguments: {} },
			{ kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "pr", { summary: "Merged the base." }) }, { kind: "message", text: "Repaired." },
		],
	] });
	await h.run([
		job.dispatch({ task: "Add x.txt." }), h.awaitEnvelope(job.id), h.waitEvent(job.id, "agent_settled", 1),
		tool("bash", { command: moveMain }),
		tool("cp_send", { job_id: job.id, message: "The base moved: merge origin/main and push." }),
		h.waitEvent(job.id, "envelope_received", 2), h.waitEvent(job.id, "agent_settled", 2),
	]);
	const main = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(fakeRpcMethods(h.state).filter((method) => method === "thread/resume").length, 1);
	const head = h.git(job.id, "rev-parse", "HEAD");
	const parents = h.git(job.id, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);
	assert.equal(parents.length, 2, "a merge commit");
	assert.ok(parents.includes(main), "the moved base is merged");
	assert.match(toolResults(h, "git_merge")[0]?.text ?? "", /^Merged origin\/main\./);
	assert.equal(h.originRefs()[`refs/heads/${job.id}`], head, "origin/<job> fast-forwarded to the merge");
	assert.equal(h.originRefs()["refs/heads/main"], main, "main moved only by the test");
	assertClean(h);
});

// Scenario: codex ship ships off (CX-7i)
//   Given every codex switch off, When an explicit codex ship dispatch and a codex small-ship row dispatch run,
//   Then the explicit one is refused before any lease naming codex_ship, the row runs pi by `switch:` with no
//   requested_driver, and no persisted file holds a codex value; with only codex_research on codex ship still refuses.
test("CX-7i: with codex_ship off an explicit codex ship refuses by name and a codex row runs pi with no codex value persisted", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t, null);
	const [explicit, rowed, second] = [await h.job("pr", "ship"), await h.job("pr", "ship"), await h.job("pr", "ship")];
	const piModel = h.b.provider.addScript(`cx7i-pi-${Math.random().toString(36).slice(2, 8)}`, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }] }, { kind: "text", text: "idle" },
	]);
	const row = { id: "small-ship", role: "implementer", scope: ["S"], model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" };
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: [row] }));
	const ends = (await h.run([explicit.dispatch(), tool("cp_dispatch", { job_id: rowed.id, task: "Ship.", scope: "S", queue: false, when_ready: false })]))
		.filter((end) => end.toolName === "cp_dispatch");
	assert.equal(ends[0]?.isError, true, text(ends[0]));
	assert.match(text(ends[0]), /cannot run on the Codex CLI driver: the switch codex_ship is off/);
	assert.equal(existsSync(join(h.b.home, paths.runDir(explicit.id))), false, "no lease, no run");
	assert.notEqual(ends[1]?.isError, true, text(ends[1]));
	const record = await waitFor(() => h.record(rowed.id), Boolean, { timeoutMs: 30_000, what: "the pi job's fleet record" });
	assert.deepEqual([record?.worker.driver, record?.worker.model, record?.routing?.driver, record?.routing?.requested_driver], [undefined, piModel, "pi", undefined]);
	assert.match(record?.routing?.driver_reason ?? "", /^switch: the switch codex_ship is off/);
	assert.equal(existsSync(join(h.b.home, paths.runDir(rowed.id), "native-codex")), false);
	// The previous build reads every file: no driver key names codex (a reason text may name the switch).
	const drivers = (value: unknown): unknown[] => (value === null || typeof value !== "object" ? [] : Object.entries(value as Record<string, unknown>)
		.flatMap(([key, child]) => [...(key === "driver" || key === "requested_driver" ? [child] : []), ...drivers(child)]));
	const persisted = [LAYOUT.fleetFile, LAYOUT.dispatchQueueFile, join(LAYOUT.data, "armed-dispatches.json")].map((rel) => join(h.b.home, rel)).filter((file) => existsSync(file));
	assert.ok(persisted.length >= 1, persisted.join(","));
	for (const value of [...persisted.map((file) => JSON.parse(readFileSync(file, "utf8")) as unknown), ...readRunEvents(h.b.home, rowed.id)]) {
		for (const driver of drivers(value)) assert.ok(driver === "pi" || driver === "claude", `a persisted driver value ${String(driver)}`);
	}
	assert.equal(existsSync(h.nativeFile), false, "native.json was never written");
	writeFileSync(h.nativeFile, JSON.stringify({ codex_research: true }));
	await h.b.closeParents();
	const [only] = (await h.run([second.dispatch()])).filter((end) => end.toolName === "cp_dispatch");
	assert.match(text(only), /the switch codex_ship is off/);
	assert.equal(existsSync(join(h.b.home, paths.runDir(second.id))), false);
	assertClean(h);
});

// Scenario: delivery local has no push (CX-7j)
//   Given a local codex ship job, When it commits and calls git_push, Then git_push is not in its tool set, origin is
//   unchanged, and the report's head_sha is the worktree HEAD.
test("CX-7j: a local codex ship job has no git_push: origin unchanged, head_sha is HEAD", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("local", "ship");
	const before = h.originRefs();
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'l\\n' > l.txt" }, { kind: "tool", tool: "git_commit", arguments: { message: "local" } },
		{ kind: "tool", tool: "git_push", arguments: {} }, { kind: "tool", tool: "report_result", arguments: h.shipReport(job.id, "local") }, { kind: "message", text: "Reported." },
	]] });
	await h.run([job.dispatch({ task: "Add l.txt." }), h.awaitEnvelope(job.id), h.pause(2)]);
	assert.match(transcript(h, job.id), /Refused: git_push is not in the Codex spike's tool set/);
	assert.deepEqual(h.originRefs(), before, "origin unchanged");
	assert.equal(envelope(h, job.id).head_sha, h.git(job.id, "rev-parse", "HEAD"));
	assert.equal(h.git(job.id, "log", "-1", "--format=%s"), "local");
	assert.deepEqual(fakeThreads(h.state)[0]?.dynamicTools, ["gh_read", "git_commit", "git_fetch", "git_merge", "report_result"]);
	assert.match(readFileSync(join(h.b.home, paths.runDir(job.id), "codex-system-prompt.md"), "utf8"), new RegExp(CODEX_LOCAL_SHIP_ADDENDUM.split("\n").at(-2)!.slice(0, 50)));
	assertClean(h);
});

// Scenario: the implementer profile is read back entry by entry (CX-7k)
//   Given a CLI whose config/read omits one filesystem entry, When a codex ship job is dispatched,
//   Then the lockdown refuses before any turn and the job fails spawn_failed.
test("CX-7k: a profile read-back missing one entry refuses before any turn", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const job = await h.job("pr", "ship");
	h.setScript({ knobs: { profileReadback: "dropEntry" }, turns: [[{ kind: "shell", command: "touch never.txt" }]] });
	await h.run([job.dispatch({ task: "Ship." })]);
	const record = await failed(h, job.id);
	const [run] = await h.runs(job.id);
	assert.deepEqual([run?.lockdown, run?.stop, record?.failure?.class], ["refused", "lockdown", "spawn_failed"], JSON.stringify(run));
	assert.ok(!fakeRpcMethods(h.state).includes("turn/start"), "no turn started");
	assert.equal(existsSync(join(h.worktree(job.id), "never.txt")), false);
	await allScopesKilled(h);
	assertClean(h);
});

// Scenario: operator read roots are vetted (CX-7l, Q5)
//   Given CP_CODEX_READ_ROOTS naming a tool dir, When the shell reads it, Then it is a read entry and the read works;
//   naming the CP home instead refuses the run before any app-server.
test("CX-7l: CP_CODEX_READ_ROOTS opens a tool dir read-only; one naming the CP home refuses before any app-server", { skip, timeout: 300_000 }, async (t) => {
	const h = await shipHome(t);
	const [reads, refused] = [await h.job("local", "ship"), await h.job("local", "ship")];
	const tools = join(h.root, "tools");
	mkdirSync(tools);
	writeFileSync(join(tools, "tool"), "READ-ROOT-SENTINEL\n");
	reset(h, { turns: [[{ kind: "shell", command: `cat ${join(tools, "tool")}` }, { kind: "message", text: "Read it." }]] });
	await h.run([reads.dispatch({ task: "Read the tool." }), h.waitEvent(reads.id, RUN, 1)], { CP_CODEX_READ_ROOTS: JSON.stringify([tools]) });
	assert.equal(implementerProfile(h)[realpathSync(tools)], "read");
	assert.match(transcript(h, reads.id), /READ-ROOT-SENTINEL/);
	const servers = appServers(h).length;
	reset(h, { turns: [[{ kind: "message", text: "never" }]] });
	await h.b.closeParents();
	await h.run([refused.dispatch({ task: "Ship." })], { CP_CODEX_READ_ROOTS: JSON.stringify([h.b.home]) });
	await failed(h, refused.id);
	const [run] = await h.runs(refused.id);
	assert.deepEqual([run?.stop, run?.outcome, run?.lockdown], ["lockdown", "refused", "unchecked"], JSON.stringify(run));
	assert.equal(appServers(h).length, servers, "no app-server for the refused run");
	assertClean(h);
});

// Scenario: a symlinked worktree still nests its read-only entries (item 4)
//   Given a worktree reached through a symlink with an existing excluded dir, When the implementer profile is built,
//   Then the worktree entry is its realpath, so `.git` and the excluded realpaths sit under it as read entries.
// A unit check: a treehouse lease is a real dir, so no entry point hands the run core a symlinked worktree.
test("CX-7m: the implementer profile keys a symlinked worktree by realpath, so its excluded entries nest under it", (t) => {
	const root = mkdtempSync(join(tmpdir(), "cp-cx7m-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const real = join(root, "real");
	mkdirSync(join(real, ".github", "workflows"), { recursive: true });
	writeFileSync(join(real, ".git"), "gitdir: /nowhere\n");
	symlinkSync(real, join(root, "link"));
	const link = join(root, "link");
	const excluded = codexExcludedRoots(link, [".github/workflows/"]);
	const profile = codexPermissionProfile({ role: "implementer", worktree: link, tmp: join(root, "tmp"), readOnly: [join(link, ".git"), ...excluded] });
	assert.equal(profile.filesystem[realpathSync(real)], "write");
	assert.equal(profile.filesystem[link], undefined, "the symlink is never an entry");
	assert.equal(profile.filesystem[join(realpathSync(real), ".git")], "read");
	assert.equal(profile.filesystem[join(realpathSync(real), ".github", "workflows")], "read");
	assert.deepEqual(profile.writableRoots, [join(root, "tmp")]);
});
