/**
 * Claude/pi worker parity, WP0 baseline: native jobs through the real `cp_dispatch` of a pi parent (mock model), with
 * fake-claude as the CLI on CI. NP-0a…NP-0e pin the guards that must hold before and after every parity PR.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { type ClaudeStep, type ClaudeToolUse, FAKE_CLAUDE_AUTH_TOKEN, toolResults } from "../harness/claude-mock-provider.ts";
import { readRunEvents } from "../harness/index.ts";
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

/** A scripted forge `gh` first on the workers' PATH: logs and answers reads; the hermetic stub answers the rest. */
function scriptedGh(t: TestContext, h: Awaited<ReturnType<typeof nativeWorkerHome>>): () => string[] {
	const dir = mkdtempSync(join(tmpdir(), "cp-np1-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	const rest = h.env.PATH.split(delimiter).slice(1).join(delimiter);
	writeFileSync(join(dir, "gh"), [
		"#!/bin/sh",
		`case "$*" in "--version"|"api user --jq .login") PATH='${rest}' exec gh "$@" ;; esac`,
		`printf '%s\\n' "$*" >> '${log}'`,
		'case "$1 $2" in',
		"\t\"issue view\") printf 'np1 issue %s body\\n' \"$3\" ;;",
		"\t\"pr view\") printf 'np1 pr %s body\\n' \"$3\" ;;",
		"\t\"api \"*) printf '[{\"body\":\"np1 comment from %s\"}]\\n' \"$2\" ;;",
		"\t*) echo \"np1 gh: unscripted gh $*\" >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	h.installStubBin("gh", join(dir, "gh"));
	return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
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

// Scenario: Given the scaffold exclude_paths, When a native implementer edits .env or writes under .github/workflows/
//   or secrets/, Then each call is refused and the files are absent or unchanged; an ordinary new file still lands.
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

// Scenario: Given a native planner whose task names issue 7, When it calls gh_read issue view 7, Then the issue body
//   reaches it; so do another PR and an api GET; an implementer reads the same way; Bash gh is refused naming gh_read.
test("NP-1a: a native planner and implementer read issues and other PRs with gh_read", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	for (const kind of ["research", "ship"] as const) {
		let id = "";
		const h = await nativeWorkerHome(t, [
			calls(ghRead({ verb: "issue view", number: 7 }), ghRead({ verb: "pr view", number: 9 }), ghRead({ verb: "api", path: "repos/o/r/pulls/9/comments" }), bash("gh issue view 7")),
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
		assert.equal(accepted(h.b.home, id), 1, kind);
	}
});

// Scenario: Given gh_read, When the model passes -X POST (or any other write, host, repo or browser shape, or a graphql
//   path), Then the call is refused by name and gh never ran for it.
test("NP-1b: gh_read refuses every write shape before gh runs", { skip: NATIVE, timeout: 300_000 }, async (t) => {
	let id = "";
	const issues = (args: string[]) => ({ verb: "api", path: "repos/o/r/issues", args });
	const shapes: Array<[Record<string, unknown>, string]> = [
		[issues(["-X", "POST"]), "-X"], [issues(["--method", "PUT"]), "--method"], [issues(["-f", "a=b"]), "-f"], [issues(["-F", "a=b"]), "-F"],
		[issues(["--raw-field", "a=b"]), "--raw-field"], [issues(["--input", "f"]), "--input"], [issues(["-H", "x"]), "-H"],
		[issues(["--hostname", "h"]), "--hostname"], [issues(["--repo", "o/x"]), "--repo"], [{ verb: "api", path: "/graphql" }, "/graphql"],
		[{ verb: "pr view", args: ["--web"] }, "--web"],
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
	assert.deepEqual(ghCalls().filter((line) => /^api |--web/.test(line)), [], "gh ran for a refused shape");
	const results = toolResults(h.claude.requests);
	shapes.forEach(([, flag], i) => {
		const escaped = flag.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		assert.match(results[i] ?? "", new RegExp(`^\\[error\\] Refused: gh_read .*${escaped}`), results.join("\n---\n"));
	});
	assert.equal(accepted(h.b.home, id), 1);
});
