/**
 * WP8 native GitHub parity (G1–G4) through the real `cp_dispatch` of a pi parent (mock model), fake-claude as the CLI
 * and a scripted gh at the boundary: owner-scoped planner reads, issue comments, review reply and resolve on the job's
 * own PR, and the planner's git_fetch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { type ClaudeStep, type ClaudeToolUse, toolResults } from "../harness/claude-mock-provider.ts";
import { readRunEvents, waitFor } from "../harness/index.ts";
import { isModelCall, REAL_CLAUDE } from "../harness/native-parent.ts";
import { NATIVE, nativeWorkerHome } from "../harness/native-worker.ts";

type Home = Awaited<ReturnType<typeof nativeWorkerHome>>;
// Off CI a laptop without treehouse skips by name; under CI (Actions and Dagger set CI=true) a missing tool fails.
const skip = process.env.CI === "true" ? false : NATIVE;
const calls = (...uses: ClaudeToolUse[]): ClaudeStep => ({ kind: "tool_use", calls: uses });
const picp = (name: string, input: ClaudeToolUse["input"]): ClaudeToolUse => ({ name: `mcp__picp__${name}`, input });
const ghRead = (input: Record<string, unknown>) => picp("gh_read", input);
const done: ClaudeStep = { kind: "text", text: "Reported." };
const text = (end: { result: { content?: unknown } } | undefined) => JSON.stringify(end?.result.content ?? "");
const accepted = (home: string, id: string) => readRunEvents(home, id).filter((event) => event.type === "envelope_received").length;
const blocked = (id: string) => ({ job_id: id, kind: "ship", status: "blocked", summary: "Parity case done.", blockers: ["the e2e case ends here"] });
const researchReport = (id: string, home: string) => ({
	job_id: id, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(id)),
	plan_summary: { goal: "Read GitHub.", approach: ["Use gh_read."], acceptance: ["The reads are reported."], risk: "None.", touched: ["README.md"] },
});
const artifact = (h: () => Home, id: () => string): ClaudeStep =>
	calls({ name: "Write", input: () => ({ file_path: join(h().b.home, paths.artifactFile(id())), content: "# native\n" }) });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const THREAD = '{"thread_id":"PRRT_a","isResolved":false,"isOutdated":false,"path":"src/nf.ts","line":1,"comments":[{"comment_id":101,"author":"bot","body":"nit"}]}';
const CLOSING = '{"body":"Fixes the parser.\\n\\nCloses #13","closingIssuesReferences":[{"number":13,"url":"https://github.com/o/r/issues/13",' +
	'"repository":{"name":"r","owner":{"login":"o"}}},{"number":15,"url":"https://github.com/other/x/issues/15","repository":{"name":"x","owner":{"login":"other"}}}]}';

/** A scripted `gh` first on the workers' PATH: logs each call (`repos`: its GH_REPO) and answers G1–G4's shapes. */
function forgeGh(t: TestContext, h: Home): (() => string[]) & { repos: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "cp-nf-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const [log, repoLog] = [join(dir, "calls.log"), join(dir, "repos.log")];
	const rest = h.env.PATH.split(delimiter).slice(1).join(delimiter);
	writeFileSync(join(dir, "gh"), [
		"#!/bin/sh",
		`case "$*" in "--version"|"api user --jq .login") PATH='${rest}' exec gh "$@" ;; esac`,
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
		"\t*) echo \"nf gh: unscripted gh $*\" >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	h.installStubBin("gh", join(dir, "gh"));
	const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
	return Object.assign(() => lines(log), { repos: () => lines(repoLog) });
}

/** Points the job's origin at github.com/o/r for gh while pushes still land on the scratch bare origin. */
function githubOrigin(worktree: string): void {
	const bare = git(worktree, "remote", "get-url", "origin");
	git(worktree, "remote", "set-url", "origin", "https://github.com/o/r.git");
	git(worktree, "remote", "set-url", "--push", "origin", bare);
}

/** The worker's synthetic credentials: they reach the worker process, never the CLI child. */
const workerCredentials = (tag: string) => ({ GH_TOKEN: `${tag}-synthetic-gh-token`, SSH_AUTH_SOCK: `/tmp/${tag}-agent.sock` });

/** Asserts the CLI child's env carried no GH_* key, ssh agent or CP_HOME though the worker held them. */
function noCredentialInChild(h: Home, id: string): void {
	const keys = h.spawnedEnvKeys(id);
	// Only the real CLI (CP_E2E_REAL_CLAUDE=1) records no keys; under fake-claude a missing log is a failure.
	assert.ok(keys !== undefined || REAL_CLAUDE, "fake-claude recorded no spawned env keys");
	if (keys === undefined) return;
	assert.ok(keys.includes("PATH"), JSON.stringify(keys));
	assert.deepEqual(keys.filter((key) => key.startsWith("GH_") || ["SSH_AUTH_SOCK", "CP_HOME"].includes(key)), [], JSON.stringify(keys));
}

// Scenario: Given data/gh-read.json granting owner acme, When a native planner searches org:acme, views an acme issue
//   with -R and GETs an acme api path, Then each reaches gh; other owners, an unscoped search, -X POST and graphql are
//   refused before gh runs. Controls: the same org:acme search by an implementer, or by a planner with no grant file,
//   is refused (the grant is planner-only and opt-in).
test("NF-1: a granted planner reads its owners' repos; other owners, writes and unscoped searches stay refused", { skip, timeout: 300_000 }, async (t) => {
	const reach = [
		{ verb: "search prs", args: ["org:acme", "author:alice", "--json", "number,url"] },
		{ verb: "issue view", number: 5, args: ["-R", "acme/x"] },
		{ verb: "api", path: "repos/acme/x/pulls/5/reviews" },
	];
	const refused: Array<[Record<string, unknown>, RegExp]> = [
		[{ verb: "search prs", args: ["org:other"] }, /^\[error\] Refused: gh_read never searches `org:other`: beyond this job's repo it reads only the repos of acme/],
		[{ verb: "search issues", args: ["author:alice"] }, /^\[error\] Refused: gh_read `search issues` needs a scope/],
		[{ verb: "api", path: "repos/other/x/issues" }, /^\[error\] Refused: gh_read `api` reads only o\/r, this job's origin or a repo of acme, never/],
		[{ verb: "pr view", number: 5, args: ["-R", "other/x"] }, /^\[error\] Refused: gh_read never passes `-R` other\/x: it reads only o\/r and the repos of acme/],
		[{ verb: "api", path: "repos/acme/x/issues", args: ["-X", "POST"] }, /^\[error\] Refused: gh_read never passes `-X`/],
		[{ verb: "api", path: "graphql" }, /^\[error\] Refused: gh_read `api` never reads graphql/],
	];
	const orgAcme = { verb: "search prs", args: ["org:acme"] };
	for (const variant of ["granted planner", "granted implementer", "planner without a grant"] as const) {
		let id = "";
		const planner = variant !== "granted implementer";
		const uses = variant === "granted planner" ? [...reach, ...refused.map(([input]) => input)] : [orgAcme];
		const h: Home = await nativeWorkerHome(t, [
			calls(...uses.map(ghRead)),
			...(planner ? [artifact(() => h, () => id)] : []),
			calls({ name: REPORT_TOOL, input: () => (planner ? researchReport(id, h.b.home) : blocked(id)) }),
			done,
		]);
		if (variant !== "planner without a grant") writeFileSync(join(h.b.home, LAYOUT.data, "gh-read.json"), JSON.stringify({ owners: ["acme"] }));
		const ghCalls = forgeGh(t, h);
		const job = await h.job(planner ? "research" : "ship");
		id = job.id;
		const ends = await h.run([job.dispatch("Summarise alice's acme PRs and reviews."), h.awaitEnvelope(id)], workerCredentials("nf1"));
		assert.notEqual(ends[0]?.isError, true, `${variant}: ${text(ends[0])}`);
		const results = toolResults(h.claude.requests);
		const all = `${variant}:\n${results.join("\n---\n")}`;
		const reads = ghCalls();
		if (variant === "granted planner") {
			assert.match(results[0] ?? "", /^nf search prs/, all);
			assert.match(results[1] ?? "", /^nf issue 5/, all);
			assert.match(results[2] ?? "", /nf":"api repos\/acme\/x\/pulls\/5\/reviews/, all);
			refused.forEach(([, why], i) => assert.match(results[reach.length + i] ?? "", why, all));
			for (const read of ["search prs org:acme author:alice --json number,url", "issue view 5 -R acme/x", "api repos/acme/x/pulls/5/reviews"]) {
				assert.ok(reads.includes(read), `${read} not in ${JSON.stringify(reads)}`);
			}
			const never = ["search prs org:other", "search issues", "api repos/other/", "pr view", "api repos/acme/x/issues", "api graphql"];
			assert.deepEqual(reads.filter((line) => never.some((prefix) => line.startsWith(prefix))), [], "gh ran for a refused shape");
		} else {
			assert.match(results[0] ?? "", /^\[error\] Refused: gh_read never searches `org:acme`: no owner is granted to this job/, all);
			assert.deepEqual(reads.filter((line) => line.startsWith("search")), [], `${variant}: gh ran the refused search`);
		}
		noCredentialInChild(h, id);
		assert.equal(accepted(h.b.home, id), 1, variant);
	}
});

// Scenario: Given an invalid data/gh-read.json ("owners" not an array), When a native planner is dispatched, Then
//   its turn fails closed: the CLI never starts, gh never runs, no report is accepted and the job fails as a crash.
//   Negative control: NF-1's planner with a valid grant reaches gh.
test("NF-1b: an invalid gh-read.json fails the planner's turn closed before the CLI starts", { skip, timeout: 300_000 }, async (t) => {
	let id = "";
	const h: Home = await nativeWorkerHome(t, [calls(ghRead({ verb: "search prs", args: ["org:acme"] })), done]);
	writeFileSync(join(h.b.home, LAYOUT.data, "gh-read.json"), JSON.stringify({ owners: "acme" }));
	const ghCalls = forgeGh(t, h);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Summarise alice's acme PRs."), h.awaitEnvelope(id)], workerCredentials("nf1b"));
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const record = await waitFor(() => h.record(id), (found) => found?.phase === "failed", { timeoutMs: 120_000, what: `${id} to fail` });
	assert.equal(record?.failure?.class, "crash", JSON.stringify(record?.failure));
	assert.equal(h.claude.requests.some(isModelCall), false, "the CLI started a model call under an invalid grant");
	assert.deepEqual(ghCalls().filter((line) => line.startsWith("search")), [], "gh ran the search");
	assert.equal(accepted(h.b.home, id), 0);
});

// Scenario: Given a ship job whose task names #12 and #14 and whose PR closes #13 (and other/x#15), When the worker
//   commits, pushes, opens its PR and calls issue_comment on 12, 13, 99, 14 and 15, Then 12 and 13 post with the
//   origin's GH_REPO; 99 (never named), 14 (a PR) and 15 (another repo) are refused, so gh logs two comments only.
test("NF-2: issue_comment posts only on issues the brief names or the job PR closes", { skip, timeout: 300_000 }, async (t) => {
	let id = "";
	const comment = (issue: number) => picp("issue_comment", { issue, body: "nf2 note" });
	const h: Home = await nativeWorkerHome(t, [
		calls({ name: "Write", input: () => (githubOrigin(h.worktree(id)), { file_path: join(h.worktree(id), "src", "nf2.ts"), content: "export const nf2 = true;\n" }) }),
		calls({ name: "Bash", input: { command: "git add -A && git commit -q -m nf2" } }),
		calls(picp("git_push", {})),
		calls(picp("pr_create", { title: "Fix the parser", body: "Closes #13" })),
		calls(...[12, 13, 99, 14, 15].map(comment)),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	]);
	const ghCalls = forgeGh(t, h);
	const job = await h.job("ship", "pr");
	id = job.id;
	const ends = await h.run([job.dispatch("Fix the parser for #12; #14 is related."), h.awaitEnvelope(id)], workerCredentials("nf2"));
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	assert.match(results[2] ?? "", new RegExp(`^Pushed HEAD to origin/${id}\\.`), all);
	assert.match(results[3] ?? "", /^Draft PR for .*: https:\/\/github\.com\/o\/r\/pull\/7$/, all);
	assert.match(results[4] ?? "", /^Commented on o\/r#12: https:\/\/github\.com\/o\/r\/issues\/12#issuecomment-1/, all);
	assert.match(results[5] ?? "", /^Commented on o\/r#13: https:\/\/github\.com\/o\/r\/issues\/13#issuecomment-1/, all);
	assert.match(results[6] ?? "", /^\[error\] Refused: issue_comment posts only on an issue of o\/r this job's brief names or its PR closes \(#12, #13, #14\); #99 is refused\./, all);
	assert.match(results[7] ?? "", /^\[error\] Refused: issue_comment: o\/r#14 is a pull request, not an issue/, all);
	assert.match(results[8] ?? "", /^\[error\] Refused: issue_comment posts only .*; #15 is refused\./, all);
	const reads = ghCalls();
	const posted = reads.map((line, i) => [line, ghCalls.repos()[i]]).filter(([line]) => line?.startsWith("issue comment "));
	assert.deepEqual(posted, [["issue comment 12 --body nf2 note", "o/r"], ["issue comment 13 --body nf2 note", "o/r"]], JSON.stringify(reads));
	noCredentialInChild(h, id);
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a ship job, When it reads `pr threads`, replies and resolves before pr_create, Then all three refuse
//   with "no PR yet"; after pr_create, threads list PRRT_a unresolved, a reply to top-level comment 101 and resolving
//   PRRT_a post once each, and comment 202 (PR 8), reply 303, thread PRRT_b (PR 8) and a malformed id are refused.
test("NF-3: review threads are read, replied to and resolved on the job's own PR only", { skip, timeout: 300_000 }, async (t) => {
	let id = "";
	const reply = (comment_id: number) => picp("pr_review_reply", { comment_id, body: "nf3 fixed" });
	const resolve = (thread_id: string) => picp("pr_thread_resolve", { thread_id });
	const h: Home = await nativeWorkerHome(t, [
		calls(picp("gh_read", () => (githubOrigin(h.worktree(id)), { verb: "pr threads" })), reply(101), resolve("PRRT_a")),
		calls(picp("pr_create", { title: "Fix the parser", body: "Body." })),
		calls(ghRead({ verb: "pr threads" }), reply(101), reply(202), reply(303), resolve("PRRT_a"), resolve("PRRT_b"), resolve("x y")),
		calls({ name: REPORT_TOOL, input: () => blocked(id) }),
		done,
	]);
	const ghCalls = forgeGh(t, h);
	const job = await h.job("ship", "pr");
	id = job.id;
	const ends = await h.run([job.dispatch("Answer and resolve the bot's review threads."), h.awaitEnvelope(id)], workerCredentials("nf3"));
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	for (const early of results.slice(0, 3)) assert.match(early, /^\[error\] Refused: .*no PR yet/, all);
	assert.match(results[3] ?? "", /^Draft PR for .*: https:\/\/github\.com\/o\/r\/pull\/7$/, all);
	assert.ok((results[4] ?? "").includes(THREAD), all);
	assert.match(results[5] ?? "", /^Replied to review comment 101 on https:\/\/github\.com\/o\/r\/pull\/7: /, all);
	assert.match(results[6] ?? "", /^\[error\] Refused: pr_review_reply replies only on this job's PR #7 .*review comment 202 is on .*\/pulls\/8/, all);
	assert.match(results[7] ?? "", /^\[error\] Refused: pr_review_reply: review comment 303 is a reply; reply to its top-level comment 101 instead\./, all);
	assert.match(results[8] ?? "", /^Resolved review thread PRRT_a on https:\/\/github\.com\/o\/r\/pull\/7\./, all);
	assert.match(results[9] ?? "", /^\[error\] Refused: pr_thread_resolve resolves only a review thread of this job's PR #7 .*PRRT_b is on o\/r#8/, all);
	assert.match(results[10] ?? "", /^\[error\] Refused: pr_thread_resolve takes a thread_id/, all);
	const reads = ghCalls();
	assert.ok(reads.some((line) => line.startsWith("api graphql -f query=query(") && line.includes("reviewThreads") && line.includes("-F number=7")), JSON.stringify(reads));
	assert.deepEqual(reads.filter((line) => line.startsWith("api --method POST")), ["api --method POST repos/o/r/pulls/7/comments/101/replies -f body=nf3 fixed --jq .html_url"]);
	const mutations = reads.filter((line) => line.includes("resolveReviewThread"));
	assert.equal(mutations.length, 1, JSON.stringify(reads));
	assert.match(mutations[0] ?? "", /-f id=PRRT_a /);
	noCredentialInChild(h, id);
	assert.equal(accepted(h.b.home, id), 1);
});

// Scenario: Given a native planner, When upstream main gains `nf4 upstream` and the planner calls git_fetch, Then its
//   Bash `git log origin/main` shows the commit; api commits reads leave the CI snapshot unused, a `-F per_page=5`
//   query is refused naming the path form, and research teardown still returns the lease.
test("NF-4: a planner fetches origin and reads upstream main; commits reads skip the CI snapshot", { skip, timeout: 300_000 }, async (t) => {
	let id = "";
	const scratch = mkdtempSync(join(tmpdir(), "cp-nf4-upstream-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const upstream = () => {
		git(scratch, "clone", "-q", git(h.worktree(id), "remote", "get-url", "origin"), "up");
		const up = join(scratch, "up");
		git(up, "-c", "user.name=nf4", "-c", "user.email=nf4@test.invalid", "commit", "-q", "--allow-empty", "-m", "nf4 upstream");
		git(up, "push", "-q", "origin", "HEAD:main");
	};
	const h: Home = await nativeWorkerHome(t, [
		calls(picp("git_fetch", () => (upstream(), {}))),
		calls({ name: "Bash", input: { command: "git log -1 --format=%s origin/main" } }),
		calls(ghRead({ verb: "api", path: "repos/o/r/commits" }), ghRead({ verb: "api", path: "repos/o/r/commits/abc123" }),
			ghRead({ verb: "api", path: "repos/o/r/actions/runs" }), ghRead({ verb: "api", path: "repos/o/r/commits", args: ["-F", "per_page=5"] })),
		artifact(() => h, () => id),
		calls({ name: REPORT_TOOL, input: () => researchReport(id, h.b.home) }),
		done,
	]);
	const ghCalls = forgeGh(t, h);
	const job = await h.job("research");
	id = job.id;
	const ends = await h.run([job.dispatch("Read upstream main."), h.awaitEnvelope(id), { kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: id } }] }]);
	assert.notEqual(ends[0]?.isError, true, text(ends[0]));
	const first = h.claude.requests.find(isModelCall);
	const offered = ((first?.body.tools ?? []) as Array<{ name: string }>).map((each) => each.name).filter((name) => name.startsWith("mcp__picp__"));
	assert.deepEqual(offered.sort(), [REPORT_TOOL, "mcp__picp__gh_read", "mcp__picp__git_fetch"].sort());
	const results = toolResults(h.claude.requests);
	const all = results.join("\n---\n");
	assert.match(results[0] ?? "", /^Fetched origin\./, all);
	assert.match(results[1] ?? "", /^nf4 upstream/, all);
	assert.match(results[2] ?? "", /nf":"api repos\/o\/r\/commits"/, all);
	assert.match(results[3] ?? "", /nf":"api repos\/o\/r\/commits\/abc123"/, all);
	assert.match(results[4] ?? "", /nf":"api repos\/o\/r\/actions\/runs"/, all);
	assert.match(results[5] ?? "", /^\[error\] Refused: gh_read never passes `-F` \(in `-F`\): a GET takes its query in path, e\.g\. repos\/<owner>\/<repo>\/commits\?sha=main&per_page=5/, all);
	assert.ok(ghCalls().includes("api repos/o/r/actions/runs"), JSON.stringify(ghCalls()));
	const down = ends.find((end) => end.toolName === "cp_teardown");
	assert.notEqual(down?.isError, true, text(down));
	assert.equal(down?.result.details?.lease_returned, true, text(down));
	assert.equal(accepted(h.b.home, id), 1);
});
