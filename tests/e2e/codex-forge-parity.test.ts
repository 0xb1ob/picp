/**
 * cp-1nrn: WP8 GitHub parity (G1–G4, #875's named push error) on the Codex CLI driver, through the real `cp_dispatch`,
 * `cp_send`, `/cp-drain freeze` and `cp_teardown` of a pi parent (mock model), with fake-codex, the fake `systemd-run`
 * and a scripted gh at the boundary. The Claude counterparts are native-forge-parity.test.ts (NF-1…NF-4) and NP-0f.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { fakeSpawns, fakeThreads } from "../harness/codex-mock.ts";
import { codexWorkerHome } from "../harness/codex-worker.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

// Off CI a laptop without treehouse skips by name; under CI (Actions and Dagger set CI=true) a missing tool fails.
const skip = process.env.CI === "true" ? false : (treehouseAvailable() ? false : "needs treehouse on PATH");
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");
const step = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const tool = (name: string, args: Record<string, unknown>) => ({ kind: "tool" as const, tool: name, arguments: args });
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const appServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");
const results = (h: H, name: string) => h.lines<{ tool: string; result: { success?: boolean; contentItems?: Array<{ text?: string }> } }>("tool-results.jsonl")
	.filter((entry) => entry.tool === name).map((entry) => ({ ok: entry.result.success === true, text: (entry.result.contentItems ?? []).map((part) => part.text ?? "").join("\n") }));
const blocked = (id: string) => ({ job_id: id, kind: "ship", status: "blocked", summary: "Parity case done.", blockers: ["the e2e case ends here"] });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const THREAD = '{"thread_id":"PRRT_a","isResolved":false,"isOutdated":false,"path":"src/cxf.ts","line":1,"comments":[{"comment_id":101,"author":"bot","body":"nit"}]}';
const CLOSING = '{"body":"Fixes the parser.\\n\\nCloses #13","closingIssuesReferences":[{"number":13,"url":"https://github.com/o/r/issues/13",' +
	'"repository":{"name":"r","owner":{"login":"o"}}},{"number":15,"url":"https://github.com/other/x/issues/15","repository":{"name":"x","owner":{"login":"other"}}}]}';

/** NF's scripted gh, first on the workers' PATH: logs each call with its GH_REPO and answers G1–G4's shapes. */
function forgeGh(t: TestContext, h: H): { path: string; calls: () => string[]; repos: () => string[] } {
	const dir = mkdtempSync(join(h.root, "cxf-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const [log, repoLog] = [join(dir, "calls.log"), join(dir, "repos.log")];
	writeFileSync(join(dir, "gh"), [
		"#!/bin/sh",
		`case "$*" in "--version"|"api user --jq .login") PATH='${process.env.PATH ?? ""}' exec gh "$@" ;; esac`,
		`printf '%s\\n' "$*" >> '${log}'`,
		`printf '%s\\n' "$GH_REPO" >> '${repoLog}'`,
		'case "$*" in',
		"\t\"search \"*) printf 'nf search %s\\n' \"$2\" ;;",
		"\t\"issue view \"*) printf 'nf issue %s\\n' \"$3\" ;;",
		"\t\"repo view \"*) echo o/r ;;",
		"\t\"pr create \"*) echo https://github.com/o/r/pull/7 ;;",
		`\t"pr view https://github.com/o/r/pull/7 --json body,closingIssuesReferences") printf '%s\\n' '${CLOSING}' ;;`,
		"\t\"pr view \"*) echo 'no pull requests found for branch' >&2; exit 1 ;;",
		"\t\"issue comment \"*) printf 'https://github.com/o/r/issues/%s#issuecomment-1\\n' \"$3\" ;;",
		"\t\"api repos/o/r/issues/14 \"*) echo true ;;",
		"\t\"api repos/o/r/issues/\"*) echo false ;;",
		"\t\"api repos/o/r/pulls/comments/101 \"*) printf 'https://api.github.com/repos/o/r/pulls/7\\t\\n' ;;",
		"\t\"api repos/o/r/pulls/comments/202 \"*) printf 'https://api.github.com/repos/o/r/pulls/8\\t\\n' ;;",
		"\t\"api repos/o/r/pulls/comments/303 \"*) printf 'https://api.github.com/repos/o/r/pulls/7\\t101\\n' ;;",
		"\t\"api --method POST \"*) echo https://github.com/o/r/pull/7#discussion_r999 ;;",
		"\t\"api graphql \"*resolveReviewThread*) echo true ;;",
		"\t\"api graphql \"*\"id=PRRT_a\"*) printf 'false\\t7\\to/r\\n' ;;",
		"\t\"api graphql \"*\"id=PRRT_b\"*) printf 'false\\t8\\to/r\\n' ;;",
		`\t"api graphql "*reviewThreads*) printf '%s\\n' '${THREAD}' ;;`,
		"\t\"api \"*) printf '[{\"nf\":\"api %s\"}]\\n' \"$2\" ;;",
		"\t*) echo \"cxf gh: unscripted gh $*\" >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
	return { path: `${dir}:${h.env.PATH}`, calls: () => lines(log), repos: () => lines(repoLog) };
}

/** The worker's synthetic credential: it reaches the worker process, never an app-server. */
const credentials = (tag: string) => ({ GH_TOKEN: `${tag}-synthetic-gh-token` });
function noGhKeyInAppServers(h: H): void {
	assert.ok(appServers(h).length > 0, "no app-server ran");
	for (const spawn of appServers(h)) assert.deepEqual(spawn.env.filter((key) => key.startsWith("GH_")), [], JSON.stringify(spawn.env));
}

/** Waits for the fake's hold `marker`, runs `then`, and writes `<root>/<marker>-done` for the parent to wait on. */
function whenHeld(h: H, marker: string, then: () => void): { done: string; settled: Promise<void> } {
	const done = join(h.root, `${marker}-done`);
	const settled = (async () => {
		await waitFor(() => existsSync(join(h.state, marker)), Boolean, { timeoutMs: 120_000, what: `the codex worker holds at ${marker}` });
		then();
		writeFileSync(done, "");
	})();
	return { done, settled };
}

// Scenario (A6, #2b): Given data/gh-read.json granting acme, When a codex planner searches org:acme, views an acme issue
//   with -R, GETs an acme api path, searches repo:o/r and reads `pr threads`, Then each reaches gh; org:other and another
//   owner's api path are refused. Controls: a codex implementer with the same grant and a planner with no grant file
//   are refused the org:acme search before gh runs. Before cp-1nrn the Codex planner carried no owners at all.
test("CXF-1: a granted codex planner reads its owners' repos; a codex implementer and an ungranted planner are refused", { skip, timeout: 420_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_ship: true, codex_max_concurrent: 3 }, ship: true });
	const gh = forgeGh(t, h);
	const grant = join(h.b.home, LAYOUT.data, "gh-read.json");
	writeFileSync(grant, JSON.stringify({ owners: ["acme"] }));
	const [planner, implementer, ungranted] = [await h.job(), await h.job("local", "ship"), await h.job()];
	const orgAcme = tool("gh_read", { verb: "search prs", args: ["org:acme"] });
	h.setScript({ turns: [
		h.reporting(planner.id, [
			tool("gh_read", { verb: "search prs", args: ["org:acme", "author:alice", "--json", "number,url"] }),
			tool("gh_read", { verb: "issue view", number: 5, args: ["-R", "acme/x"] }),
			tool("gh_read", { verb: "api", path: "repos/acme/x/pulls/5/reviews" }),
			tool("gh_read", { verb: "search prs", args: ["repo:o/r"] }),
			tool("gh_read", { verb: "pr threads", number: 7 }),
			tool("gh_read", { verb: "search prs", args: ["org:other"] }),
			tool("gh_read", { verb: "api", path: "repos/other/x/issues" }),
		]),
		[orgAcme, tool("report_result", blocked(implementer.id)), { kind: "message", text: "Reported." }],
		h.reporting(ungranted.id, [orgAcme]),
	] });
	await h.run([
		planner.dispatch(), h.awaitEnvelope(planner.id),
		implementer.dispatch({ task: "Summarise alice's acme PRs." }), h.awaitEnvelope(implementer.id),
		step("bash", { command: `rm -f '${grant}'` }),
		ungranted.dispatch(), h.awaitEnvelope(ungranted.id),
	], { PATH: gh.path, ...credentials("cxf1") });
	const reads = results(h, "gh_read");
	const all = JSON.stringify(reads, null, 1);
	assert.match(reads[0]?.text ?? "", /^nf search prs/, all);
	assert.match(reads[1]?.text ?? "", /^nf issue 5/, all);
	assert.match(reads[2]?.text ?? "", /nf":"api repos\/acme\/x\/pulls\/5\/reviews/, all);
	assert.match(reads[3]?.text ?? "", /^nf search prs/, all);
	assert.ok((reads[4]?.text ?? "").includes(THREAD), all);
	assert.match(reads[5]?.text ?? "", /^Refused: gh_read never searches `org:other`: beyond this job's repo it reads only the repos of acme/, all);
	assert.match(reads[6]?.text ?? "", /^Refused: gh_read `api` reads only o\/r/, all);
	for (const control of [reads[7], reads[8]]) {
		assert.match(control?.text ?? "", /^Refused: gh_read never searches `org:acme`: no owner is granted to this job/, all);
	}
	const searches = gh.calls().filter((line) => line.startsWith("search"));
	assert.deepEqual(searches, ["search prs org:acme author:alice --json number,url", "search prs repo:o/r"], "only the granted planner's searches ran gh");
	assert.ok(gh.calls().includes("issue view 5 -R acme/x") && gh.calls().includes("api repos/acme/x/pulls/5/reviews"), JSON.stringify(gh.calls()));
	assert.deepEqual(gh.calls().filter((line) => line.startsWith("api repos/other/")), []);
	for (const job of [planner, implementer, ungranted]) assert.equal(ofType(h, job.id, "envelope_received").length, 1, job.id);
	noGhKeyInAppServers(h);
});

// Scenario (A6): Given an invalid data/gh-read.json ("owners" not an array), When a codex planner is dispatched, Then its
//   turn fails closed before any app-server starts: gh runs no search, no report is accepted and the job fails as a crash.
test("CXF-1b: an invalid gh-read.json fails the codex planner's turn before any app-server starts", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const gh = forgeGh(t, h);
	writeFileSync(join(h.b.home, LAYOUT.data, "gh-read.json"), JSON.stringify({ owners: "acme" }));
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id, [tool("gh_read", { verb: "search prs", args: ["org:acme"] })])] });
	const ends = await h.run([job.dispatch(), h.pause(3)], { PATH: gh.path, ...credentials("cxf1b") });
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => h.record(job.id), (found) => found?.phase === "failed", { timeoutMs: 120_000, what: `${job.id} to fail` });
	assert.equal(record?.failure?.class, "crash", JSON.stringify(record?.failure));
	assert.equal(appServers(h).length, 0, "an app-server started under an invalid grant");
	assert.deepEqual(gh.calls().filter((line) => line.startsWith("search")), [], "gh ran the search");
	assert.equal(ofType(h, job.id, "envelope_received").length, 0);
});

/** Points the job's origin at github.com/o/r for gh while pushes still land on the scratch bare origin. */
function githubOrigin(worktree: string): void {
	const bare = git(worktree, "remote", "get-url", "origin");
	git(worktree, "remote", "set-url", "origin", "https://github.com/o/r.git");
	git(worktree, "remote", "set-url", "--push", "origin", bare);
}

// Scenario (A7, #2b): Given a codex pr implementer whose brief names #12 and #14 and whose PR closes #13 (and other/x#15),
//   When it commits, pushes, opens its PR, reads `pr threads`, replies to 101/202/303, resolves PRRT_a/PRRT_b/"x y" and
//   comments on 12/13/99/14/15, Then only 12 and 13 post with GH_REPO o/r, one reply and one resolve reach gh, the rest
//   are refused by name (NF-2/NF-3's rules), and no GH_* key reached an app-server. Before cp-1nrn the tools were absent.
test("CXF-2: a codex pr implementer comments, replies and resolves on its own PR and named issues only", { skip, timeout: 420_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_ship: true }, ship: true });
	const gh = forgeGh(t, h);
	const job = await h.job("pr", "ship");
	const bare = git(h.b.clone, "remote", "get-url", "origin");
	const reply = (comment_id: number) => tool("pr_review_reply", { comment_id, body: "cxf2 fixed" });
	const resolve = (thread_id: string) => tool("pr_thread_resolve", { thread_id });
	const comment = (issue: number) => tool("issue_comment", { issue, body: "cxf2 note" });
	h.setScript({ turns: [[
		{ kind: "hold", marker: "held" },
		{ kind: "shell", command: "mkdir -p src && printf 'export const cxf2 = true;\\n' > src/cxf2.ts" },
		tool("git_commit", { message: "cxf2" }), tool("git_push", {}), tool("pr_create", { title: "Fix the parser", body: "Closes #13" }),
		tool("gh_read", { verb: "pr threads" }), reply(101), reply(202), reply(303), resolve("PRRT_a"), resolve("PRRT_b"), resolve("x y"),
		...[12, 13, 99, 14, 15].map(comment),
		tool("report_result", blocked(job.id)), { kind: "message", text: "Reported." },
	]] });
	const origin = whenHeld(h, "held", () => githubOrigin(h.worktree(job.id)));
	const ends = await h.run([
		job.dispatch({ task: "Fix the parser for #12; #14 is related." }), h.awaitFile(origin.done),
		step("cp_send", { job_id: job.id, message: "Go on.", mode: "steer" }), h.awaitEnvelope(job.id), h.pause(2),
	], { PATH: gh.path, ...credentials("cxf2") });
	await origin.settled;
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	assert.match(results(h, "git_push")[0]?.text ?? "", new RegExp(`^Pushed HEAD to origin/${job.id}\\.`));
	assert.equal(execFileSync("git", ["ls-remote", bare, `refs/heads/${job.id}`], { encoding: "utf8" }).split("\t")[0], h.git(job.id, "rev-parse", "HEAD"));
	assert.match(results(h, "pr_create")[0]?.text ?? "", /^Draft PR for .*: https:\/\/github\.com\/o\/r\/pull\/7$/);
	assert.ok((results(h, "gh_read")[0]?.text ?? "").includes(THREAD), JSON.stringify(results(h, "gh_read")));
	const replies = results(h, "pr_review_reply");
	assert.match(replies[0]?.text ?? "", /^Replied to review comment 101 on https:\/\/github\.com\/o\/r\/pull\/7: /, JSON.stringify(replies));
	assert.match(replies[1]?.text ?? "", /^Refused: pr_review_reply replies only on this job's PR #7 .*review comment 202 is on .*\/pulls\/8/);
	assert.match(replies[2]?.text ?? "", /^Refused: pr_review_reply: review comment 303 is a reply; reply to its top-level comment 101 instead\./);
	const resolves = results(h, "pr_thread_resolve");
	assert.match(resolves[0]?.text ?? "", /^Resolved review thread PRRT_a on https:\/\/github\.com\/o\/r\/pull\/7\./, JSON.stringify(resolves));
	assert.match(resolves[1]?.text ?? "", /^Refused: pr_thread_resolve resolves only a review thread of this job's PR #7 .*PRRT_b is on o\/r#8/);
	assert.match(resolves[2]?.text ?? "", /^Refused: pr_thread_resolve takes a thread_id/);
	const comments = results(h, "issue_comment");
	assert.deepEqual(comments.map((each) => each.ok), [true, true, false, false, false], JSON.stringify(comments));
	assert.match(comments[2]?.text ?? "", /^Refused: issue_comment posts only on an issue of o\/r this job's brief names or its PR closes .*; #99 is refused\./);
	assert.match(comments[3]?.text ?? "", /^Refused: issue_comment: o\/r#14 is a pull request, not an issue/);
	assert.match(comments[4]?.text ?? "", /; #15 is refused\./);
	const calls = gh.calls();
	const posted = calls.map((line, i) => [line, gh.repos()[i]]).filter(([line]) => line?.startsWith("issue comment "));
	assert.deepEqual(posted, [["issue comment 12 --body cxf2 note", "o/r"], ["issue comment 13 --body cxf2 note", "o/r"]], JSON.stringify(calls));
	assert.deepEqual(calls.filter((line) => line.startsWith("api --method POST")), ["api --method POST repos/o/r/pulls/7/comments/101/replies -f body=cxf2 fixed --jq .html_url"]);
	const mutations = calls.filter((line) => line.includes("resolveReviewThread"));
	assert.equal(mutations.length, 1, JSON.stringify(calls));
	assert.match(mutations[0] ?? "", /-f id=PRRT_a /);
	const declared = fakeThreads(h.state)[0]?.dynamicTools ?? [];
	assert.ok(["issue_comment", "pr_review_reply", "pr_thread_resolve"].every((name) => declared.includes(name)), JSON.stringify(declared));
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	noGhKeyInAppServers(h);
});

// Scenario (A5): Given a codex planner held mid-turn, When upstream main gains `cxf3 upstream` and the planner calls
//   git_fetch, then git_fetch with cwd at the canonical clone, Then the first fetches into the worktree's origin/main,
//   the second is refused naming the worktree, the thread declared gh_read, git_fetch and report_result, and research
//   teardown returns the lease. Before cp-1nrn a Codex planner had no git_fetch.
test("CXF-3: a codex planner fetches origin in its worktree only and reads the new upstream main", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ turns: [h.reporting(job.id, [
		{ kind: "hold", marker: "held" }, tool("git_fetch", {}), { kind: "shell", command: "git log -1 --format=%s origin/main" }, tool("git_fetch", { cwd: h.b.clone }),
	])] });
	const upstream = whenHeld(h, "held", () => {
		const up = join(h.root, "cxf3-up");
		mkdirSync(up);
		git(up, "clone", "-q", git(h.b.clone, "remote", "get-url", "origin"), ".");
		git(up, "-c", "user.name=cxf3", "-c", "user.email=cxf3@test.invalid", "commit", "-q", "--allow-empty", "-m", "cxf3 upstream");
		git(up, "push", "-q", "origin", "HEAD:main");
	});
	const ends = await h.run([
		job.dispatch(), h.awaitFile(upstream.done), step("cp_send", { job_id: job.id, message: "Go on.", mode: "steer" }),
		h.awaitEnvelope(job.id), h.pause(2), step("cp_teardown", { job_id: job.id }),
	]);
	await upstream.settled;
	const fetches = results(h, "git_fetch");
	assert.match(fetches[0]?.text ?? "", /^Fetched origin\./, JSON.stringify(fetches));
	assert.equal(fetches[1]?.ok, false);
	assert.match(fetches[1]?.text ?? "", new RegExp(`^Refused: git_fetch runs only in this job's worktree .*, never ${h.b.clone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
	assert.match(readFileSync(readRunStatus(h.b.home, job.id).transcript_file as string, "utf8"), /cxf3 upstream/, "the shell read the fetched origin/main");
	assert.deepEqual(fakeThreads(h.state)[0]?.dynamicTools, ["gh_read", "git_fetch", "report_result"]);
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
});

// Scenario (A9, #9b, #9c): Given a bare origin whose pre-receive prints GitHub's workflow-scope refusal, When a codex pr
//   implementer commits a workflow edit and calls git_push, and then /cp-drain freeze checkpoints its next WIP, Then both
//   the push and the checkpoint answer the named workflow_scope_missing error and origin has no job branch.
test("CXF-4: a codex git_push and freeze checkpoint refused for the workflow scope name workflow_scope_missing", { skip, timeout: 420_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_ship: true }, files: { ".github/workflows/ci.yml": "name: ci\n" }, ship: true, mandateDefaults: "scaffold" });
	const job = await h.job("pr", "ship");
	const bare = git(h.b.clone, "remote", "get-url", "origin");
	const refusal = "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope";
	mkdirSync(join(bare, "hooks"), { recursive: true });
	writeFileSync(join(bare, "hooks", "pre-receive"), `#!/bin/sh\necho '${refusal}' >&2\nexit 1\n`, { mode: 0o755 });
	h.setScript({ turns: [[
		{ kind: "shell", command: "printf 'name: ci2\\n' > .github/workflows/ci.yml" }, tool("git_commit", { message: "ci" }), tool("git_push", {}),
		{ kind: "shell", command: "printf 'half done\\n' > wip.txt" }, { kind: "hold", marker: "held" },
	]] });
	const gate = join(h.root, "parent-gate");
	const running = h.run([job.dispatch({ task: "Rename the CI workflow." }), step("bash", { command: `for i in $(seq 1500); do [ -f "${gate}" ] && break; sleep 0.2; done` })]);
	await waitFor(() => existsSync(join(h.state, "held")), Boolean, { timeoutMs: 120_000, what: "the codex implementer is mid-turn" });
	const parent = h.b.parents.at(-1)!;
	const records = parent.records().length;
	await parent.prompt("/cp-drain 120 freeze");
	await parent.waitFor((r) => parent.records().indexOf(r) >= records && r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 60_000);
	await waitFor(() => ofType(h, job.id, "agent_settled"), (found) => found.length > 0, { timeoutMs: 60_000, what: "the frozen worker settles idle" });
	writeFileSync(gate, "open\n");
	await running;
	const [push] = results(h, "git_push");
	assert.equal(push?.ok, false, push?.text);
	assert.match(push?.text ?? "", /^workflow_scope_missing: GitHub refused the push: the token cannot create or update workflow `\.github\/workflows\/ci\.yml`\. .*Nothing was pushed\./);
	const checkpoint = ofType(h, job.id, "native_checkpoint")[0]?.payload as { head?: string; pushed?: boolean; error?: string } | undefined;
	assert.deepEqual([checkpoint?.head, checkpoint?.pushed], [h.git(job.id, "rev-parse", "HEAD"), false], JSON.stringify(checkpoint));
	assert.match(checkpoint?.error ?? "", /^workflow_scope_missing: /, JSON.stringify(checkpoint));
	assert.equal(h.git(job.id, "log", "-1", "--format=%s"), "WIP: freeze checkpoint");
	assert.equal(h.originRefs()[`refs/heads/${job.id}`], undefined, "nothing was pushed");
});
