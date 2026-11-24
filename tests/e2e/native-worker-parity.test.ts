/**
 * Claude/pi worker parity: native jobs through the real `cp_dispatch` of a pi parent (mock model), with fake-claude as
 * the CLI on CI. NP-0a…NP-0e pin the guards every parity PR keeps; NP-1* the forge reads; NP-2* the Bash scope;
 * NP-3a the child env.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { MandateStore } from "../../src/mandate.ts";
import { type ClaudeStep, type ClaudeToolUse, FAKE_CLAUDE_AUTH_TOKEN, toolResults } from "../harness/claude-mock-provider.ts";
import { readRunEvents } from "../harness/index.ts";
import { REAL_CLAUDE } from "../harness/native-parent.ts";
import { NATIVE, nativeWorkerHome } from "../harness/native-worker.ts";

const calls = (...uses: ClaudeToolUse[]): ClaudeStep => ({ kind: "tool_use", calls: uses });
const bash = (command: string): ClaudeToolUse => ({ name: "Bash", input: { command } });
const done: ClaudeStep = { kind: "text", text: "Reported." };
const text = (end: { result: { content?: unknown } } | undefined) => JSON.stringify(end?.result.content ?? "");
const researchReport = (id: string, home: string) => ({
	job_id: id, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(id)),
	plan_summary: { goal: "Name the package.", approach: ["Read README.md."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] },
});
const blocked = (id: string) => ({ job_id: id, kind: "ship", status: "blocked", summary: "Parity case done.", blockers: ["the e2e case ends here"] });
const accepted = (home: string, id: string) => readRunEvents(home, id).filter((event) => event.type === "envelope_received").length;
const ghRead = (input: Record<string, unknown>): ClaudeToolUse => ({ name: "mcp__picp__gh_read", input });
type Home = Awaited<ReturnType<typeof nativeWorkerHome>>;
const STUB_CHROMIUM = join(import.meta.dirname, "..", "fixtures", "stub-chromium.mjs");
/** Whether `tool` runs here; a case asserts a runner's own output only where the runner exists. */
const onPath = (tool: string): boolean => spawnSync(tool, ["--version"], { stdio: "ignore" }).error === undefined;

/** Puts `fixture` on the workers' PATH as `name` through a 0755 wrapper (a committed fixture carries no exec bit). */
function stubBin(t: TestContext, h: Home, name: string, fixture: string): void {
	const dir = mkdtempSync(join(tmpdir(), `cp-np2-${name}-`));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, name), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
	h.installStubBin(name, join(dir, name));
}

/** A scripted forge `gh` first on the workers' PATH: logs and answers reads (`repos`: each read's GH_REPO); the
 * hermetic stub answers the rest. */
function scriptedGh(t: TestContext, h: Awaited<ReturnType<typeof nativeWorkerHome>>): (() => string[]) & { repos: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "cp-np1-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const [log, repoLog] = [join(dir, "calls.log"), join(dir, "repos.log")];
	const rest = h.env.PATH.split(delimiter).slice(1).join(delimiter);
	writeFileSync(join(dir, "gh"), [
		"#!/bin/sh",
		`case "$*" in "--version"|"api user --jq .login") PATH='${rest}' exec gh "$@" ;; esac`,
		`printf '%s\\n' "$*" >> '${log}'`,
		`printf '%s\\n' "$GH_REPO" >> '${repoLog}'`,
		'case "$1 $2" in',
		"\t\"issue view\") printf 'np1 issue %s body\\n' \"$3\" ;;",
		"\t\"pr view\") printf 'np1 pr %s body\\n' \"$3\" ;;",
		"\t\"repo view\") echo o/r ;;",
		"\t\"api \"*) printf '[{\"body\":\"np1 comment from %s\"}]\\n' \"$2\" ;;",
		"\t*) echo \"np1 gh: unscripted gh $*\" >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	h.installStubBin("gh", join(dir, "gh"));
	const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
	return Object.assign(() => lines(log), { repos: () => lines(repoLog) });
}

test("NP-0a: a native research job reports through fake-claude and tears down", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls({ name: "Grep", input: { pattern: "# demo" } }, { name: "Glob", input: { pattern: "*.md" } }),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Report the repo's package name."), h.awaitEnvelope(id), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: id } }] }]);
	const [dispatched, down] = [ends.find((end) => end.toolName === "cp_dispatch"), ends.find((end) => end.toolName === "cp_teardown")];
	assert.notEqual(dispatched?.isError, true, text(dispatched));
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	const record = h.record(id);
	assert.deepEqual([record?.worker.driver, record?.phase], ["claude", "done"]);
	assert.ok(record?.worker.exited_at, "teardown observed the native worker's exit");
	assert.equal(accepted(h.b.home, id), 1, "exactly one accepted report");
	const [run] = await h.runs(id);
	assert.deepEqual([run?.lockdown, run?.report, run?.denials], ["ok", true, 0], JSON.stringify(run));
	// The in-worktree Grep and Glob ran (fake-claude's new built-ins under the real CLI's hook path).
	const [grep, glob] = toolResults(h.claude.requests);
	assert.match(grep ?? "", /README\.md/, grep);
	assert.match(glob ?? "", /README\.md/, glob);
	assert.equal(h.claude.overrun(), 0);
});

test("NP-0b: secret paths and env dumps stay denied; the report is still accepted", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls({ name: "Read", input: () => ({ file_path: h.settings }) }, { name: "Bash", input: () => ({ command: `cat ${h.settings}` }) }, bash("cat /proc/self/environ"), bash("printenv")),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Report the repo's package name."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const denied = await h.denials(id);
	assert.equal(denied.count, 4, JSON.stringify(denied));
	assert.deepEqual(denied.lines.map((line) => line.split(":")[0]), ["Read", "Bash", "Bash", "Bash"], JSON.stringify(denied));
	assert.ok(toolResults(h.claude.requests).slice(0, 4).every((result) => result.startsWith("[error] ")), toolResults(h.claude.requests).join("\n---\n"));
	assert.equal(h.claude.requests.some((request) => JSON.stringify(request.body).includes(FAKE_CLAUDE_AUTH_TOKEN)), false, "a secret reached the model");
	assert.equal(accepted(h.b.home, id), 1, "the report was accepted");
});

test("NP-0c: an implementer cannot write outside its worktree or into .git; an Edit inside lands", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const outside = mkdtempSync(join(tmpdir(), "cp-np0c-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	const wt = () => h.worktree(id);
	const h = await nativeWorkerHome(t, [
		calls(
			{ name: "Write", input: () => ({ file_path: join(wt(), "..", `${id}-write.txt`), content: "x\n" }) },
			// The link is planted as the model asks, so the worktree exists: `out/x` resolves outside it.
			{ name: "Write", input: () => (symlinkSync(outside, join(wt(), "out")), { file_path: join(wt(), "out", "x"), content: "x\n" }) },
			{ name: "Write", input: () => ({ file_path: join(wt(), ".git", "hooks", "pre-commit"), content: "#!/bin/sh\n" }) },
			{ name: "Bash", input: () => ({ command: `echo x > ../${id}-bash.txt` }) },
			{ name: "Edit", input: () => ({ file_path: join(wt(), "src", "x.ts"), old_string: "x = 1", new_string: "x = 2" }) },
		),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	], { files: { "src/x.ts": "export const x = 1;\n" } });
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Edit src/x.ts."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const denied = await h.denials(id);
	const hook = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: wt(), encoding: "utf8" }).trim();
	for (const file of [join(wt(), "..", `${id}-write.txt`), join(outside, "x"), hook, join(wt(), "..", `${id}-bash.txt`)]) {
		assert.equal(existsSync(file), false, `file exists: ${file}; denials ${JSON.stringify(denied)}`);
	}
	assert.equal(denied.count, 4, JSON.stringify(denied));
	assert.deepEqual(denied.lines.map((line) => line.split(":")[0]), ["Write", "Write", "Write", "Bash"], JSON.stringify(denied));
	assert.equal(readFileSync(join(wt(), "src", "x.ts"), "utf8"), "export const x = 2;\n");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native implementer, When it pushes to main by Bash or git_push, Then main is unchanged and only
//   refs/heads/<job> moved; and the CLI child got no GH token, ssh agent or CP_HOME though the worker holds them.
test("NP-0d: an implementer pushes only its job branch; no credential reaches the CLI child", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.worktree(id), encoding: "utf8" }).trim();
	const push = (input: Record<string, unknown>): ClaudeToolUse => ({ name: "mcp__picp__git_push", input });
	const h = await nativeWorkerHome(t, [
		calls({ name: "Write", input: () => ({ file_path: join(h.worktree(id), "src", "np0d.ts"), content: "export const pushed = true;\n" }) }),
		calls(bash("git add -A && git commit -q -m np0d")),
		calls(bash("git push origin HEAD:main"), push({ branch: "main" }), push({ branch: "other" }), push({ force: true }), push({})),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	]);
	const before = h.originRefs();
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Add src/np0d.ts and push it."), h.awaitEnvelope(id)], { GH_TOKEN: "np0d-synthetic-gh-token", SSH_AUTH_SOCK: "/tmp/np0d-agent.sock" });
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const after = h.originRefs();
	assert.deepEqual(after, { ...before, [`refs/heads/${id}`]: head() }, results.join("\n---\n"));
	const denied = await h.denials(id);
	assert.equal(denied.count, 1, JSON.stringify(denied));
	assert.match(denied.lines[0] ?? "", /^Bash: Refused: /);
	assert.match(results[2] ?? "", /^\[error\] /, "the Bash push");
	assert.match(results[3] ?? "", /^\[error\] Refused: git_push never pushes main/);
	assert.match(results[4] ?? "", /^\[error\] Refused: git_push pushes only to origin\/.*, not other\./);
	assert.match(results[5] ?? "", /^\[error\] Refused: git_push never forces/);
	assert.match(results[6] ?? "", new RegExp(`^Pushed HEAD to origin/${id}\\.`));
	const keys = h.spawnedEnvKeys(id);
	if (keys !== undefined) {
		assert.ok(keys.includes("PATH") && keys.includes("CLAUDE_CONFIG_DIR"), JSON.stringify(keys));
		assert.deepEqual(keys.filter((key) => key.startsWith("GH_") || ["SSH_AUTH_SOCK", "CP_HOME"].includes(key)), [], JSON.stringify(keys));
	}
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a custom exclude_paths naming .github/workflows/, When a native implementer edits .env or writes
//   under .github/workflows/ or secrets/, Then each call is refused and the files are absent or unchanged; an ordinary
//   new file still lands.
test("NP-0e: exclude_paths hold for Edit and Write; a write outside them lands", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const wt = () => h.worktree(id);
	const h = await nativeWorkerHome(t, [
		calls(
			{ name: "Edit", input: () => ({ file_path: join(wt(), ".env"), old_string: "A=1", new_string: "A=2" }) },
			{ name: "Write", input: () => ({ file_path: join(wt(), ".github", "workflows", "x.yml"), content: "on: push\n" }) },
			{ name: "Write", input: () => ({ file_path: join(wt(), "secrets", "k"), content: "k\n" }) },
			{ name: "Write", input: () => ({ file_path: join(wt(), "src", "new.ts"), content: "export const fresh = true;\n" }) },
		),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	], { files: { ".env": "A=1\n" } });
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Add src/new.ts."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const denied = await h.denials(id);
	for (const file of [join(wt(), ".github", "workflows", "x.yml"), join(wt(), "secrets", "k")]) {
		assert.equal(existsSync(file), false, `file exists: ${file}; denials ${JSON.stringify(denied)}`);
	}
	assert.equal(readFileSync(join(wt(), ".env"), "utf8"), "A=1\n");
	assert.equal(denied.count, 3, JSON.stringify(denied));
	assert.ok(denied.lines.every((line) => / an excluded path /.test(line)), JSON.stringify(denied));
	assert.equal(readFileSync(join(wt(), "src", "new.ts"), "utf8"), "export const fresh = true;\n");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given fresh defaults, When a native implementer Edits, Writes and Bash-writes .github/workflows/, Then they
//   land, secrets/x and .env stay refused, and a workflow-scope push refusal comes back as workflow_scope_missing.
test("NP-0f: under fresh defaults an implementer edits CI workflows; a workflow-scope push refusal is named", {
	skip: NATIVE, timeout: 300_000,
}, async (t) => {
	let id = "";
	const wt = () => h.worktree(id);
	const workflow = (name: string) => join(wt(), ".github", "workflows", name);
	const refuseWorkflows = () => {
		const origin = execFileSync("git", ["-C", h.b.clone, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
		const refusal = "refusing to allow a Personal Access Token to create or update workflow "
			+ "`.github/workflows/ci.yml` without `workflow` scope";
		mkdirSync(join(origin, "hooks"), { recursive: true });
		writeFileSync(join(origin, "hooks", "pre-receive"), `#!/bin/sh\necho '${refusal}' >&2\nexit 1\n`, { mode: 0o755 });
	};
	const h = await nativeWorkerHome(t, [
		calls(
			{ name: "Edit", input: () => ({
				file_path: workflow("ci.yml"), old_string: "on: push", new_string: "on: [push, pull_request]",
			}) },
			{ name: "Write", input: () => ({ file_path: workflow("new.yml"), content: "on: workflow_dispatch\n" }) },
			{ name: "Write", input: () => ({ file_path: join(wt(), "secrets", "x"), content: "k\n" }) },
			{ name: "Edit", input: () => ({ file_path: join(wt(), ".env"), old_string: "A=1", new_string: "A=2" }) },
		),
		calls(bash("echo '# bash' >> .github/workflows/ci.yml"), bash("echo k > secrets/x"), bash("echo A=3 > .env")),
		calls(bash("git add -A && git commit -q -m np0f")),
		calls({ name: "mcp__picp__git_push", input: () => (refuseWorkflows(), {}) }),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	], { mandateDefaults: "scaffold", files: { ".github/workflows/ci.yml": "on: push\n", ".env": "A=1\n" } });
	const job = await h.job("ship");
	id = job.id;
	const args = { action: "issue", projects: ["demo"], objective: "edit CI", job_ids: [id] };
	const issue = { kind: "tool_calls" as const, calls: [{ name: "cp_mandate", args }] };
	const ends = await h.run([issue, job.dispatch("Edit the CI workflow."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const grant = new MandateStore(h.b.home).list().find((mandate) => mandate.job_ids?.includes(id));
	assert.deepEqual(grant?.exclusions?.paths, ["secrets/", "**/.env*"], JSON.stringify(grant));
	const results = toolResults(h.claude.requests);
	const denied = await h.denials(id);
	assert.equal(readFileSync(workflow("ci.yml"), "utf8"), "on: [push, pull_request]\n# bash\n", results.join("\n---\n"));
	assert.equal(readFileSync(workflow("new.yml"), "utf8"), "on: workflow_dispatch\n");
	assert.equal(existsSync(join(wt(), "secrets", "x")), false);
	assert.equal(readFileSync(join(wt(), ".env"), "utf8"), "A=1\n");
	// Edit/Write (native-guards writeScopeGuard) and Bash (claude-bash-scope) each refuse secrets/x and .env.
	const tools = denied.lines.map((line) => line.split(":")[0]);
	assert.deepEqual(tools, ["Write", "Edit", "Bash", "Bash"], JSON.stringify(denied));
	assert.ok(denied.lines.every((line) => / an excluded path /.test(line)), JSON.stringify(denied));
	const pushed = results.find((result) => result.includes("refusing to allow")) ?? results.join("\n---\n");
	assert.match(pushed, /^\[error\] workflow_scope_missing: .*`workflow` scope/);
	assert.doesNotMatch(pushed, /^\[error\] git_push failed/);
	assert.equal(h.originRefs()[`refs/heads/${id}`], undefined, "nothing was pushed");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native planner whose task names issue 7, When it calls gh_read issue view 7, Then the issue body
//   reaches it; so do another PR and an api GET; an implementer reads the same way; Bash gh is refused naming gh_read.
test("NP-1a: a native planner and implementer read issues and other PRs with gh_read", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	for (const kind of ["research", "ship"] as const) {
		let id = "";
		// A GitHub origin pins GH_REPO; an upstream remote marked as gh's set-default (gh-resolved) must not win.
		const remotes = () => [["remote", "set-url", "origin", "https://github.com/o/r.git"], ["remote", "add", "upstream", "https://github.com/other/x.git"],
			["config", "remote.upstream.gh-resolved", "base"]].forEach((args) => execFileSync("git", args, { cwd: h.worktree(id) }));
		const h = await nativeWorkerHome(t, [
			calls({ name: "mcp__picp__gh_read", input: () => (remotes(), { verb: "issue view", number: 7 }) }, ghRead({ verb: "pr view", number: 9 }),
				ghRead({ verb: "api", path: "repos/o/r/pulls/9/comments" }), bash("gh issue view 7")),
			...(kind === "research" ? [calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) })] : []),
			calls({ name: REPORT_TOOL, input: () => (kind === "research" ? researchReport(id, h.b.home) : blocked(id)) }),
			done,
		]);
		const ghCalls = scriptedGh(t, h);
		const job = await h.job(kind);
		id = job.id;
		const ends = await h.run([job.dispatch("Summarise issue 7, PR 9 and its comments."), h.awaitEnvelope(id)]);
		assert.notEqual(ends[0]?.isError, true, `${kind}: ${text(ends[0])}`);
		const results = toolResults(h.claude.requests);
		const all = `${kind}:\n${results.join("\n---\n")}`;
		assert.match(results[0] ?? "", /^np1 issue 7 body/, all);
		assert.match(results[1] ?? "", /^np1 pr 9 body/, all);
		assert.match(results[2] ?? "", /np1 comment from repos\/o\/r\/pulls\/9\/comments/, all);
		assert.match(results[3] ?? "", /^\[error\] [\s\S]*`gh` \(no credentials in this run; read GitHub with the gh_read tool\)/, all);
		const denied = await h.denials(id);
		assert.equal(denied.count, 1, JSON.stringify(denied));
		assert.match(denied.lines[0] ?? "", /^Bash: Refused: /);
		const reads = ghCalls();
		for (const read of ["pr view 9", "api repos/o/r/pulls/9/comments"]) assert.ok(reads.includes(read), `${kind}: ${read} not in ${JSON.stringify(reads)}`);
		assert.equal(reads.filter((line) => line === "issue view 7").length, 1, `${kind}: gh_read ran it once; Bash gh never did`);
		assert.deepEqual(ghCalls.repos(), reads.map(() => "o/r"), `${kind}: every gh_read ran with the origin's GH_REPO`);
		assert.equal(accepted(h.b.home, id), 1, kind);
	}
});

// Scenario: Given gh_read in repo o/r, When the model passes -X POST (or any other write, host, repo, browser or watch
//   flag, a bundled -iXPOST, a graphql path, or another repo by api path, URL, positional or search qualifier), Then
//   the call is refused by name and gh never ran for it; only the repo resolution `gh repo view` ran.
test("NP-1b: gh_read refuses every write shape and every other repo before gh runs", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const issues = (args: string[]) => ({ verb: "api", path: "repos/o/r/issues", args });
	const shapes: Array<[Record<string, unknown>, string]> = [
		[issues(["-X", "POST"]), "-X"], [issues(["--method", "PUT"]), "--method"], [issues(["-f", "a=b"]), "-f"], [issues(["-F", "a=b"]), "-F"],
		[issues(["--raw-field", "a=b"]), "--raw-field"], [issues(["--input", "f"]), "--input"], [issues(["-H", "x"]), "-H"],
		[issues(["--hostname", "h"]), "--hostname"], [issues(["--repo", "o/x"]), "--repo"], [{ verb: "api", path: "/graphql" }, "/graphql"],
		[{ verb: "pr view", args: ["--web"] }, "--web"], [issues(["-iXPOST"]), "-X"],
		[{ verb: "run view", run_id: "42", args: ["--watch"] }, "--watch"], [{ verb: "pr checks", args: ["-w"] }, "-w"],
		[{ verb: "api", path: "repos/other/x/issues" }, "other/x"], [{ verb: "api", path: "/repos/other/x/issues" }, "other/x"],
		[{ verb: "api", path: "https://api.github.com/repos/other/x/issues" }, "https://api.github.com/repos/other/x/issues"],
		[{ verb: "repo view", args: ["other/x"] }, "other/x"], [{ verb: "pr list", args: ["--search", "repo:other/x"] }, "repo:other/x"],
		[{ verb: "issue list", args: ["-Srepo:other/y"] }, "repo:other/y"], [{ verb: "pr list", args: ["-dS", "org:other"] }, "org:other"],
	];
	const h = await nativeWorkerHome(t, [
		calls(...shapes.map(([input]) => ghRead(input))),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const ghCalls = scriptedGh(t, h);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Try every gh_read shape."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const resolve = "repo view --json nameWithOwner --jq .nameWithOwner";
	assert.deepEqual(ghCalls().filter((line) => line !== resolve), [], "gh ran for a refused shape");
	const results = toolResults(h.claude.requests);
	shapes.forEach(([, flag], i) => {
		const escaped = flag.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		assert.match(results[i] ?? "", new RegExp(`^\\[error\\] Refused: gh_read .*${escaped}`), results.join("\n---\n"));
	});
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given gh_read, When a worker reads CI status through `api …/actions/runs` and then again through
//   `pr view --json statusCheckRollup`, Then the second read is refused as the repeat snapshot and gh never ran it.
//   Negative control: without the count, the gh log holds the `pr view` poll.
test("NP-1c: every gh_read CI-status route counts toward the one snapshot", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls(ghRead({ verb: "api", path: "repos/o/r/actions/runs" }), ghRead({ verb: "pr view", args: ["--json", "statusCheckRollup"] })),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const ghCalls = scriptedGh(t, h);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Read the CI status twice."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	assert.match(results[0] ?? "", /np1 comment from repos\/o\/r\/actions\/runs/, results.join("\n---\n"));
	assert.match(results[1] ?? "", /^\[error\] Refused: this worker already took its one CI status snapshot/, results.join("\n---\n"));
	const reads = ghCalls();
	assert.ok(reads.includes("api repos/o/r/actions/runs"), JSON.stringify(reads));
	assert.deepEqual(reads.filter((line) => line.startsWith("pr view")), [], "gh ran the second CI read");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a repo whose tests run with make, When a native implementer runs make test, python3 -c, node -e, a
//   tee into the worktree, a glob, a cd and a heredoc commit, Then each runs (none denied), the tee lands and HEAD
//   carries the heredoc body. The allow-list WP2 replaced refused every one of them.
test("NP-2a: an implementer runs what pi runs", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const message = "np2a: the body names $HOME > /x";
	const commands = ["make test", "python3 -c \"print(1)\"", "node -e \"console.log(2)\"", "echo ok | tee src/out.txt", "ls src/*.ts", "cd src && ls",
		`git add -A && git commit -q -F - <<'EOF'\n${message}\nEOF`];
	const h = await nativeWorkerHome(t, [calls(...commands.map(bash)), calls({ name: REPORT_TOOL, input: () => blocked(id) }), done],
		{ files: { Makefile: "test:\n\t@echo make-ok\n", "src/x.ts": "export const x = 1;\n" } });
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Run the tests and commit."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	const denied = await h.denials(id);
	assert.equal(denied.count, 0, JSON.stringify(denied));
	if (onPath("make")) assert.match(results[0] ?? "", /^make-ok/, all);
	if (onPath("python3")) assert.match(results[1] ?? "", /^1/, all);
	assert.match(results[2] ?? "", /^2/, all);
	assert.equal(readFileSync(join(h.worktree(id), "src", "out.txt"), "utf8"), "ok\n");
	assert.match(results[4] ?? "", /src\/x\.ts/, all);
	assert.match(results[5] ?? "", /out\.txt\nx\.ts/, all);
	assert.equal(execFileSync("git", ["log", "-1", "--format=%B"], { cwd: h.worktree(id), encoding: "utf8" }).trim(), message);
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native implementer, When it takes a headless Chrome screenshot into its worktree, Then the PNG
//   exists; given a native planner, When it screenshots into its artifact directory, Then the PNG exists there.
test("NP-2b: a headless screenshot lands in an allowed root for an implementer and a planner", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	for (const kind of ["ship", "research"] as const) {
		let id = "";
		const artifactDir = () => dirname(join(h.b.home, paths.artifactFile(id)));
		const shot = () => (kind === "ship" ? "shots/a.png" : join(artifactDir(), "a.png"));
		const h = await nativeWorkerHome(t, [
			calls({ name: "Bash", input: () => ({ command: `chromium --headless --screenshot=${shot()} about:blank` }) }),
			...(kind === "research" ? [calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) })] : []),
			calls({ name: REPORT_TOOL, input: () => (kind === "research" ? researchReport(id, h.b.home) : blocked(id)) }),
			done,
		]);
		stubBin(t, h, "chromium", STUB_CHROMIUM);
		const job = await h.job(kind);
		id = job.id;
		const ends = await h.run([job.dispatch("Take a screenshot of the page."), h.awaitEnvelope(id)]);
		assert.notEqual(ends[0]?.isError, true, `${kind}: ${text(ends[0])}`);
		const denied = await h.denials(id);
		assert.equal(denied.count, 0, `${kind}: ${JSON.stringify(denied)}`);
		const file = kind === "ship" ? join(h.worktree(id), "shots", "a.png") : join(artifactDir(), "a.png");
		assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${kind}: ${toolResults(h.claude.requests).join("\n---\n")}`);
		assert.equal(accepted(h.b.home, id), 1, kind);
	}
});

// Scenario: Given a native planner, When it runs a script and fetches a loopback page, Then both run; When it
//   redirects into README.md, stages with git add or touches a worktree file, Then each is refused, and teardown's
//   research gate (clean tree, no commits) passes. Negative control: without the destination check, README changes.
test("NP-2c: a planner runs scripts and reaches the network but writes only its artifact dir", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const server = createServer((_req, res) => res.end("np2c-ok\n"));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const h = await nativeWorkerHome(t, [
		calls(bash("node -e 1"), bash(`curl -s http://127.0.0.1:${port}/`), bash("echo x > README.md"), bash("git add -A"), bash("touch src/x")),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Report the repo's package name."), h.awaitEnvelope(id), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: id } }] }]);
	const down = ends.find((end) => end.toolName === "cp_teardown");
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	assert.doesNotMatch(results[0] ?? "", /^\[error\]/, all);
	if (onPath("curl")) assert.match(results[1] ?? "", /^np2c-ok/, all);
	for (const refused of results.slice(2, 5)) assert.match(refused, /^\[error\] Refused: a native planner's Bash /, all);
	const denied = await h.denials(id);
	assert.equal(denied.count, 3, JSON.stringify(denied));
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native implementer with a local commit, When it runs sh -c "git push origin HEAD:main" or any
//   other literal push shape (an env-config alias `git p`, a HOME handed to sh -c's git), Then it is refused and no
//   origin ref moves.
//   Negative control: skip the `sh -c` re-scan or the GIT_CONFIG_* refusal and the local-path origin takes main.
test("NP-2d: push scope holds in every literal shape", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const pushes = ["git push", "git push origin HEAD:other", "sh -c \"git push origin HEAD:main\"", "git -c x=y push", "GIT_DIR=../o git push", "cd .. && git push",
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin HEAD:main",
		"X=push git --config-env=alias.p=X p origin HEAD:main", "git send-pack origin HEAD:refs/heads/main", "HOME=/tmp/np2d git p origin HEAD:main",
		"HOME=/tmp/np2d sh -c 'git p origin HEAD:main'"];
	const h = await nativeWorkerHome(t, [
		calls(bash("git commit -q --allow-empty -m np2d")),
		calls(...pushes.map(bash)),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	]);
	const before = h.originRefs();
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Commit and push."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	assert.doesNotMatch(results[0] ?? "", /^\[error\]/, results.join("\n---\n"));
	assert.deepEqual(h.originRefs(), before, results.join("\n---\n"));
	const denied = await h.denials(id);
	assert.equal(denied.count, pushes.length, JSON.stringify(denied));
	for (const refused of results.slice(1, 1 + pushes.length)) assert.match(refused, /^\[error\] Refused: a native implementer's Bash /, results.join("\n---\n"));
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native implementer, When it runs gh pr merge, a force push or a host auth.json copy, Then pi's own
//   pattern guard answers first, in pi's wording, before the native scope sees the command.
test("NP-2e: pi's pattern guards still run first", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls(bash("gh pr merge 1"), bash("git push --force"), bash("cp ~/.pi/agent/auth.json x")),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	]);
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Merge it."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	assert.match(results[0] ?? "", /^\[error\] Refused: a worker never merges/, all);
	assert.match(results[1] ?? "", /^\[error\] Refused: a worker never rewrites its branch's history/, all);
	assert.match(results[2] ?? "", /^\[error\] Refused: a worker never copies the host's auth\.json/, all);
	assert.equal((await h.denials(id)).count, 3);
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native planner, When it globs the Claude settings, runs env, expands the provider token, runs
//   declare -p or cds to ~<user> and reads .claude/, Then each is refused and the settings env never reaches the model.
test("NP-2f: secret and env-dump shapes stay denied", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const h = await nativeWorkerHome(t, [
		calls({ name: "Bash", input: () => ({ command: `cat ${h.fakeHome}/.cla*/settings.json` }) }, bash("env"), bash("echo $ANTHROPIC_AUTH_TOKEN"), bash("declare -p"),
			bash(`cd ~${userInfo().username} && cat .claude/.credentials.json`)),
		calls({ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(id)), content: "# native\n" }) }),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Report the repo's package name."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	assert.match(results[0] ?? "", /^\[error\] Refused: /, all);
	assert.match(results[1] ?? "", /^\[error\] Refused: a native planner's Bash an environment dump \(`env`\) is denied/, all);
	assert.match(results[2] ?? "", /^\[error\] Refused: a native planner's Bash expanding \$ANTHROPIC_AUTH_TOKEN/, all);
	assert.match(results[3] ?? "", /^\[error\] Refused: a native planner's Bash an environment dump \(`declare -p`\) is denied/, all);
	assert.match(results[4] ?? "", /^\[error\] Refused: /, all);
	assert.equal((await h.denials(id)).count, 5);
	assert.equal(h.claude.requests.some((request) => JSON.stringify(request.body).includes(FAKE_CLAUDE_AUTH_TOKEN)), false, "a secret reached the model");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a custom exclude_paths naming .github/workflows/, When a native implementer's Bash redirects, tees,
//   copies or checks out into .github/workflows/, secrets/ or .env*, Then each is refused and the files are absent or
//   unchanged; a write to src/ lands. Negative control: without the destination check, the workflow files exist.
test("NP-2g: Bash honours exclude_paths", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const wt = () => h.worktree(id);
	const ci = () => join(wt(), ".github", "workflows", "ci.yml");
	const h = await nativeWorkerHome(t, [
		calls(
			bash("echo x > .github/workflows/x.yml"), bash("echo x | tee .github/workflows/y.yml"), bash("cp README.md .github/workflows/z.yml"),
			bash("echo k > secrets/k"), bash("echo A=1 > .env.local"),
			bash("tar -cf src.tar src"), bash("tar -xf src.tar -C .github/workflows"), bash("unzip -d .github/workflows src.zip"),
			// The workflow is edited on disk as the model asks, so the refused checkout is what would have reverted it.
			{ name: "Bash", input: () => (writeFileSync(ci(), "edited\n"), { command: "git checkout -- .github/workflows/ci.yml" }) },
			bash("echo x > src/ok.txt"),
		),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	], { files: { "README.md": "# demo\n", ".github/workflows/ci.yml": "on: push\n", "src/x.ts": "export const x = 1;\n" } });
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Add src/ok.txt."), h.awaitEnvelope(id)]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const denied = await h.denials(id);
	for (const file of [".github/workflows/x.yml", ".github/workflows/y.yml", ".github/workflows/z.yml", "secrets/k", ".env.local"]) {
		assert.equal(existsSync(join(wt(), file)), false, `file exists: ${file}; denials ${JSON.stringify(denied)}`);
	}
	assert.equal(readFileSync(ci(), "utf8"), "edited\n");
	assert.equal(denied.count, 8, JSON.stringify(denied));
	assert.ok(denied.lines.every((line) => / an excluded path /.test(line)), JSON.stringify(denied));
	assert.equal(existsSync(join(wt(), ".github", "workflows", "src")), false, "tar extracted into .github/workflows");
	assert.equal(readFileSync(join(wt(), "src", "ok.txt"), "utf8"), "x\n");
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given PLAYWRIGHT_BROWSERS_PATH on the host, When a native worker starts a headless browser, Then the browser
//   sees that path; it merges with no editor wait and reads its job id; no GH token, secret-named variable or
//   credentialed proxy reaches the child. Negative control: the whole host env as childEnv puts GH_TOKEN in its keys.
test("NP-3a: the CLI child gets pi's non-interactive env, the job identity and named tool variables only", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const wt = () => h.worktree(id);
	const identity = { GIT_AUTHOR_NAME: "np3a", GIT_AUTHOR_EMAIL: "np3a@test.invalid", GIT_COMMITTER_NAME: "np3a", GIT_COMMITTER_EMAIL: "np3a@test.invalid" };
	const git = (...args: string[]) => execFileSync("git", args, { cwd: wt(), encoding: "utf8", env: { ...process.env, ...identity } }).trim();
	// The side branch is planted as the model asks, so the worktree exists; the worker's own Bash may not branch.
	const side = () => (git("branch", "np3a-side", git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "np3a side")), { command: "git merge --no-ff -m m np3a-side" });
	const h = await nativeWorkerHome(t, [
		calls({ name: "Bash", input: side }, bash("printf '%s' \"$CP_JOB_ID\" > src/id.txt"), bash("chromium --headless --screenshot=shots/a.png about:blank")),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	], { files: { "src/x.ts": "export const x = 1;\n" } });
	stubBin(t, h, "chromium", STUB_CHROMIUM);
	const job = await h.job("ship");
	id = job.id;
	const ends = await h.run([job.dispatch("Merge the side branch and take a screenshot."), h.awaitEnvelope(id)],
		{ PLAYWRIGHT_BROWSERS_PATH: "/x", HTTPS_PROXY: "http://u:p@h:1", GH_TOKEN: "np3a-synthetic-gh-token", FOO_TOKEN: "np3a-synthetic-foo-token" });
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const all = toolResults(h.claude.requests).join("\n---\n");
	const denied = await h.denials(id);
	assert.equal(denied.count, 0, JSON.stringify(denied));
	assert.equal(git("log", "-1", "--format=%P").split(" ").length, 2, `HEAD is the merge commit: ${all}`);
	assert.equal(git("log", "-1", "--format=%s"), "m");
	assert.equal(readFileSync(join(wt(), "src", "id.txt"), "utf8"), id, all);
	assert.equal(readFileSync(join(wt(), "shots", "a.png.env"), "utf8"), "/x", all);
	const dropped = readRunEvents(h.b.home, id).filter((event) => event.type === "native_env_dropped").map((event) => (event.payload as { line: string }).line);
	assert.deepEqual(dropped, ["HTTPS_PROXY not passed to the CLI child: a proxy URL with embedded credentials"]);
	const keys = h.spawnedEnvKeys(id);
	// Only the real CLI (CP_E2E_REAL_CLAUDE=1) records no keys; under fake-claude a missing log is a failure.
	assert.ok(keys !== undefined || REAL_CLAUDE, "fake-claude recorded no spawned env keys");
	if (keys !== undefined) {
		for (const key of ["GIT_EDITOR", "CP_JOB_ID", "PLAYWRIGHT_BROWSERS_PATH"]) assert.ok(keys.includes(key), `${key} missing: ${JSON.stringify(keys)}`);
		const leaked = ["GH_TOKEN", "FOO_TOKEN", "HTTPS_PROXY", "SSH_AUTH_SOCK", "CP_HOME", "CP_RUN_DIR"].filter((key) => keys.includes(key));
		assert.deepEqual(leaked, [], JSON.stringify(keys));
	}
	assert.equal(accepted(h.b.home, id), 1);
});
