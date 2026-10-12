/**
 * Forge PR 1 (T2b): the read-only observers, against a fake `gh` and a fake
 * fetch. Nothing here reaches a network or a real forge, and a fake transport
 * fails the test on any request it was not told to expect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveForgeRepository, type ForgeRepository } from "../src/forge-url.ts";
import { observerFor, type ObservationOutcome } from "../src/forges/adapter.ts";
import { GH_PR_FIELDS, githubObserver } from "../src/forges/github.ts";
import { type FetchLike, gitlabObserver } from "../src/forges/gitlab.ts";
import { GH_PR_FIELDS as MERGES_GH_PR_FIELDS, type CommandRunner } from "../src/merges.ts";

const CANARY = "CANARY-fake-secret-do-not-leak-0123456789";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const SQUASH = "c".repeat(40);
const noRun: CommandRunner = async () => assert.fail("no command expected");

function repo(): ForgeRepository {
	const resolved = resolveForgeRepository("git@ssh-alias:team/sub/app.git", {
		kind: "gitlab",
		web_base_url: "https://code.example.com/gitlab",
		token_env: "EXAMPLE_GL_TOKEN",
	});
	assert.ok(resolved.ok);
	return resolved.repository;
}

const MR_URL = "https://code.example.com/gitlab/team/sub/app/-/merge_requests/7";

function mr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 9001,
		iid: 7,
		project_id: 42,
		source_project_id: 42,
		target_project_id: 42,
		state: "merged",
		source_branch: "cp-job-1",
		target_branch: "release",
		sha: HEAD,
		diff_refs: { head_sha: HEAD, base_sha: "d".repeat(40), start_sha: "d".repeat(40) },
		merge_commit_sha: MERGE,
		squash_commit_sha: null,
		merged_at: "2026-01-02T03:04:05.000Z",
		web_url: MR_URL,
		...overrides,
	};
}

interface Call {
	url: string;
	init: RequestInit;
}

/** A fetch that answers each expected call in order and fails on any extra one. */
function fakeFetch(...answers: Array<(call: Call) => Response | Promise<Response>>): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			const call = { url, init };
			calls.push(call);
			const answer = answers[calls.length - 1];
			if (!answer) assert.fail(`unexpected request #${calls.length}`);
			return answer(call);
		},
	};
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function observe(ref: string, ...answers: Array<(call: Call) => Response | Promise<Response>>) {
	const fake = fakeFetch(...answers);
	const outcome = await gitlabObserver(repo(), { fetch: fake.fetch, env: { EXAMPLE_GL_TOKEN: CANARY } }).readChangeRequest(ref);
	assert.ok(!JSON.stringify(outcome).includes(CANARY), "the token never appears in an outcome");
	return { outcome, calls: fake.calls };
}

function failure(outcome: ObservationOutcome): { reason: string; detail: string } {
	assert.equal(outcome.ok, false, JSON.stringify(outcome));
	return outcome as { reason: string; detail: string };
}

// ---------------------------------------------------------------------------
// GitHub: the extracted gh command is unchanged
// ---------------------------------------------------------------------------

test("github observer runs the same gh pr view command and normalizes its answer", async () => {
	assert.equal(MERGES_GH_PR_FIELDS, GH_PR_FIELDS, "merges.ts keeps exporting the same field list");
	const seen: string[][] = [];
	const run: CommandRunner = async (cwd, bin, args) => {
		assert.equal(cwd, "/work");
		assert.equal(bin, "gh");
		seen.push([...args]);
		return {
			status: 0,
			stdout: JSON.stringify({ number: 12, url: "https://github.com/o/r/pull/12", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: MERGE }, headRefName: "cp-x", headRefOid: HEAD, baseRefName: "main" }),
			stderr: "",
		};
	};
	const outcome = await githubObserver(run, "/work").readChangeRequest("12");
	assert.deepEqual(seen, [["pr", "view", "12", "--json", "number,url,state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName"]]);
	assert.deepEqual(outcome, {
		ok: true,
		observation: { provider: "github", url: "https://github.com/o/r/pull/12", number: 12, state: "merged", source_branch: "cp-x", target_branch: "main", head_sha: HEAD, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: MERGE },
	});
});

test("github observer names gh failures, non-JSON and missing fields", async () => {
	const answer = (status: number, stdout: string, stderr = ""): CommandRunner => async () => ({ status, stdout, stderr });
	assert.equal(failure(await githubObserver(answer(1, "", "gh: not logged in\nmore"), "/w").readChangeRequest("1")).reason, "unavailable");
	assert.match(failure(await githubObserver(answer(1, "", "gh: not logged in\nmore"), "/w").readChangeRequest("1")).detail, /not logged in\)$/);
	assert.equal(failure(await githubObserver(answer(0, "<html>"), "/w").readChangeRequest("1")).reason, "invalid");
	assert.equal(failure(await githubObserver(answer(0, JSON.stringify({ state: "OPEN" })), "/w").readChangeRequest("1")).reason, "invalid");
	const open = await githubObserver(answer(0, JSON.stringify({ number: 3, url: "https://github.com/o/r/pull/3", state: "OPEN" })), "/w").readChangeRequest("3");
	assert.ok(open.ok && open.observation.state === "open");
});

// ---------------------------------------------------------------------------
// GitLab: one bounded GET, strict mapping
// ---------------------------------------------------------------------------

test("gitlab observer sends one GET with the token only in PRIVATE-TOKEN, nested path encoded, no redirects followed", async () => {
	const { outcome, calls } = await observe(MR_URL, json(mr()));
	assert.equal(calls.length, 1);
	const [call] = calls as [Call];
	assert.equal(call.url, "https://code.example.com/gitlab/api/v4/projects/team%2Fsub%2Fapp/merge_requests/7");
	assert.equal(call.init.method, "GET");
	assert.equal(call.init.redirect, "manual");
	assert.ok(call.init.signal, "the request carries an abort signal");
	assert.deepEqual(call.init.headers, { accept: "application/json", "PRIVATE-TOKEN": CANARY }, "the header is the token's only sink");
	assert.ok(!call.url.includes(CANARY));
	assert.deepEqual(outcome, {
		ok: true,
		observation: {
			provider: "gitlab",
			url: MR_URL,
			number: 7,
			state: "merged",
			source_branch: "cp-job-1",
			target_branch: "release",
			head_sha: HEAD,
			merged_at: "2026-01-02T03:04:05.000Z",
			merge_commit_sha: MERGE,
		},
	});
});

test("gitlab states and landing shas: merge, squash, fast-forward, open, closed, locked", async () => {
	const squash = (await observe("7", json(mr({ merge_commit_sha: null, squash_commit_sha: SQUASH, squash: true })))).outcome;
	assert.ok(squash.ok && squash.observation.squash_commit_sha === SQUASH && squash.observation.merge_commit_sha === undefined);
	const both = (await observe("7", json(mr({ squash_commit_sha: SQUASH })))).outcome;
	assert.ok(both.ok && both.observation.merge_commit_sha === MERGE && both.observation.squash_commit_sha === SQUASH);
	const fastForward = (await observe("7", json(mr({ merge_commit_sha: null, squash_commit_sha: null })))).outcome;
	assert.ok(fastForward.ok && fastForward.observation.state === "merged");
	assert.equal(fastForward.ok && fastForward.observation.merge_commit_sha, undefined, "a missing landing sha is never filled in");
	for (const [state, expected] of [["opened", "open"], ["closed", "closed"], ["locked", "unknown"], ["weird", "unknown"]] as const) {
		const outcome = (await observe("7", json(mr({ state, merged_at: null, merge_commit_sha: null })))).outcome;
		assert.ok(outcome.ok && outcome.observation.state === expected, state);
		assert.equal(outcome.ok && outcome.observation.merged_at, undefined);
	}
	const fallback = (await observe("7", json(mr({ sha: null })))).outcome;
	assert.ok(fallback.ok && fallback.observation.head_sha === HEAD, "diff_refs.head_sha is the fallback head");
	const deleted = (await observe("7", json(mr({ should_remove_source_branch: true, force_remove_source_branch: true })))).outcome;
	assert.ok(deleted.ok && deleted.observation.source_branch === "cp-job-1", "a deleted source branch is still the observed source");
});

test("gitlab malformed or conflicting answers are named, never an empty success", async () => {
	const cases: Array<[string, Record<string, unknown> | unknown, string]> = [
		["conflicting heads", mr({ diff_refs: { head_sha: "e".repeat(40) } }), "invalid"],
		["malformed sha", mr({ merge_commit_sha: "not-a-sha" }), "invalid"],
		["merged without head", mr({ sha: null, diff_refs: null }), "invalid"],
		["no source branch", mr({ source_branch: "" }), "invalid"],
		["no target branch", mr({ target_branch: undefined }), "invalid"],
		["bad merged_at", mr({ merged_at: "yesterday" }), "invalid"],
		["array body", [mr()], "invalid"],
		["another iid", mr({ iid: 8 }), "mismatch"],
		["string iid", mr({ iid: "7" }), "mismatch"],
		["another project web_url", mr({ web_url: "https://code.example.com/gitlab/team/other/-/merge_requests/7" }), "mismatch"],
		["another host web_url", mr({ web_url: "https://evil.example.com/gitlab/team/sub/app/-/merge_requests/7" }), "mismatch"],
		["no web_url", mr({ web_url: null }), "mismatch"],
		["fork", mr({ source_project_id: 43 }), "unsupported"],
		["no project ids", mr({ source_project_id: undefined, target_project_id: undefined }), "unsupported"],
	];
	for (const [label, body, reason] of cases) {
		const { reason: actual, detail } = failure((await observe("7", json(body))).outcome);
		assert.equal(actual, reason, label);
		assert.match(detail, /^gitlab code\.example\.com: /, label);
	}
	const notJson = failure((await observe("7", () => new Response("<html>login</html>", { status: 200 }))).outcome);
	assert.equal(notJson.reason, "invalid");
	assert.doesNotMatch(notJson.detail, /login/, "a response body is never relayed");
});

test("gitlab HTTP failures: 401/403/404/429/500 are unavailable with status and static cause only", async () => {
	for (const status of [401, 403, 404, 429, 500]) {
		const body = { message: `token ${CANARY} rejected`, error_description: CANARY };
		const { detail, reason } = failure((await observe("7", json(body, status))).outcome);
		assert.equal(reason, "unavailable");
		assert.match(detail, new RegExp(`HTTP ${status} \\(`));
		assert.doesNotMatch(detail, /rejected/);
	}
	const unauthenticated = await gitlabObserver(repo(), { fetch: fakeFetch(json({}, 401)).fetch, env: {} }).readChangeRequest("7");
	assert.match(failure(unauthenticated).detail, /EXAMPLE_GL_TOKEN is unset/, "the variable NAME is named, never a value");
});

test("gitlab redirects are refused, not followed, and the token is not forwarded", async () => {
	const { outcome, calls } = await observe("7", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/x" } }));
	const { reason, detail } = failure(outcome);
	assert.equal(reason, "unavailable");
	assert.match(detail, /HTTP 302 redirect refused/);
	assert.doesNotMatch(detail, /elsewhere/);
	assert.equal(calls.length, 1, "exactly one request: the redirect target is never asked");
});

test("gitlab network errors, timeouts and oversize bodies fail closed without echoing the exception", async () => {
	const network = failure((await observe("7", () => Promise.reject(new Error(`connect ECONNREFUSED with ${CANARY}`)))).outcome);
	assert.equal(network.reason, "unavailable");
	assert.match(network.detail, /request failed/);

	const hang: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error(`aborted ${CANARY}`))));
	const timedOut = await gitlabObserver(repo(), { fetch: hang, env: { EXAMPLE_GL_TOKEN: CANARY }, timeoutMs: 5 }).readChangeRequest("7");
	assert.match(failure(timedOut).detail, /request timed out/);
	assert.ok(!JSON.stringify(timedOut).includes(CANARY));

	const big = JSON.stringify(mr({ description: "x".repeat(2048) }));
	const declared = await gitlabObserver(repo(), { fetch: fakeFetch(() => new Response(big, { status: 200, headers: { "content-length": String(big.length) } })).fetch, env: {}, maxBytes: 1024 }).readChangeRequest("7");
	assert.match(failure(declared).detail, /exceeds the size limit/);
	const streamed = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 4; i += 1) controller.enqueue(new TextEncoder().encode("x".repeat(512)));
			controller.close();
		},
	});
	const undeclared = await gitlabObserver(repo(), { fetch: fakeFetch(() => new Response(streamed, { status: 200 })).fetch, env: {}, maxBytes: 1024 }).readChangeRequest("7");
	assert.match(failure(undeclared).detail, /exceeds the size limit/, "a body without content-length is still capped while it streams");
});

test("a foreign or malformed MR reference makes zero requests", async () => {
	for (const ref of [
		"https://evil.example.com/gitlab/team/sub/app/-/merge_requests/7",
		"https://code.example.com/gitlab/team/other/-/merge_requests/7",
		"https://code.example.com/team/sub/app/-/merge_requests/7",
		"https://github.com/team/app/pull/7",
		"0",
		"7; rm -rf /",
		"",
	]) {
		const { outcome, calls } = await observe(ref);
		assert.equal(failure(outcome).reason, "mismatch", ref);
		assert.equal(calls.length, 0, ref);
	}
});

test("a gitlab.com project sends GITLAB_TOKEN; with none set it reads unauthenticated", async () => {
	const resolved = resolveForgeRepository("https://gitlab.com/group/sub/app.git");
	assert.ok(resolved.ok);
	const body = mr({ web_url: "https://gitlab.com/group/sub/app/-/merge_requests/7" });
	const withToken = fakeFetch(json(body));
	assert.ok((await gitlabObserver(resolved.repository, { fetch: withToken.fetch, env: { GITLAB_TOKEN: CANARY } }).readChangeRequest("7")).ok);
	assert.equal(withToken.calls[0]?.url, "https://gitlab.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests/7");
	assert.equal((withToken.calls[0]?.init.headers as Record<string, string>)["PRIVATE-TOKEN"], CANARY);
	const anonymous = fakeFetch(json(body));
	assert.ok((await gitlabObserver(resolved.repository, { fetch: anonymous.fetch, env: {} }).readChangeRequest("7")).ok);
	assert.deepEqual(anonymous.calls[0]?.init.headers, { accept: "application/json" });
});

test("observerFor: unknown hosts are unsupported with no request; known kinds get their observer", async () => {
	const unknown = observerFor(resolveForgeRepository("git@git.example.com:team/app.git"), { run: noRun, cwd: "/w" });
	assert.equal(unknown.provider, "none");
	assert.equal(failure(await unknown.readChangeRequest("7")).reason, "unsupported");
	assert.equal(observerFor(resolveForgeRepository("git@github.com:o/r.git"), { run: noRun, cwd: "/w" }).provider, "github");
	const gitlab = observerFor(resolveForgeRepository("git@gitlab.com:g/a.git"), { run: noRun, cwd: "/w", gitlab: { fetch: fakeFetch().fetch } });
	assert.equal(gitlab.provider, "gitlab");
	assert.equal(failure(await gitlab.readChangeRequest("https://evil.example.com/g/a/-/merge_requests/1")).reason, "mismatch");
});
