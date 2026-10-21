/**
 * Forge PR 1 (T2b): the read-only observers, against a fake `gh` and a fake
 * fetch. Nothing here reaches a network or a real forge, and a fake transport
 * fails the test on any request it was not told to expect.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { afterMergeDeploy } from "../src/after-merge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type MergeReceipt, paths, type Receipt } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { resolveForgeRepository, type ForgeRepository } from "../src/forge-url.ts";
import { observerFor, type ObservationOutcome } from "../src/forges/adapter.ts";
import { GH_PR_FIELDS, githubObserver } from "../src/forges/github.ts";
import { type FetchLike, gitlabObserver } from "../src/forges/gitlab.ts";
import { MandateStore } from "../src/mandate.ts";
import { GH_PR_FIELDS as MERGES_GH_PR_FIELDS, type CommandRunner, formatMerge, MergeStore, readMergeReceipt } from "../src/merges.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

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
	let declaredCancelled = false;
	const declaredBody = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(big));
		},
		cancel() {
			declaredCancelled = true;
		},
	});
	const declared = await gitlabObserver(repo(), { fetch: fakeFetch(() => new Response(declaredBody, { status: 200, headers: { "content-length": String(big.length) } })).fetch, env: {}, maxBytes: 1024 }).readChangeRequest("7");
	assert.match(failure(declared).detail, /exceeds the size limit/);
	assert.equal(declaredCancelled, true, "a body refused on its declared length is cancelled, not left open");
	let streamedCancelled = false;
	const streamed = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 4; i += 1) controller.enqueue(new TextEncoder().encode("x".repeat(512)));
		},
		cancel() {
			streamedCancelled = true;
		},
	});
	const undeclared = await gitlabObserver(repo(), { fetch: fakeFetch(() => new Response(streamed, { status: 200 })).fetch, env: {}, maxBytes: 1024 }).readChangeRequest("7");
	assert.match(failure(undeclared).detail, /exceeds the size limit/, "a body without content-length is still capped while it streams");
	assert.equal(streamedCancelled, true, "a body refused while streaming is cancelled");
});

test("a foreign or malformed MR reference makes zero requests", async () => {
	for (const ref of [
		"https://evil.example.com/gitlab/team/sub/app/-/merge_requests/7",
		"https://code.example.com/gitlab/team/other/-/merge_requests/7",
		"https://code.example.com/team/sub/app/-/merge_requests/7",
		"https://github.com/team/app/pull/7", "0", "7; rm -rf /", "",
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

// Retained by P3b (docs/testing-migration.md): moved verbatim from tests/merges.test.ts.
interface GhPr {
	number?: number;
	url?: string;
	state?: string;
	mergedAt?: string;
	mergeCommit?: { oid?: string } | null;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
}

/**
 * A `gh` that answers with exactly what the test says GitHub knows, and a `git`
 * that answers "the head branch is gone". Nothing here shells out.
 */
function runner(pr: GhPr | { fail: string }, options: { branchOnRemote?: boolean } = {}): CommandRunner {
	return async (_cwd, bin, args) => {
		if (bin === "git") {
			assert.deepEqual([...args].slice(0, 2), ["ls-remote", "--heads"]);
			return { status: 0, stdout: options.branchOnRemote ? `abc123\trefs/heads/x\n` : "", stderr: "" };
		}
		assert.equal(bin, "gh");
		assert.deepEqual([...args].slice(0, 2), ["pr", "view"]);
		if ("fail" in pr) return { status: 1, stdout: "", stderr: pr.fail };
		return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
	};
}

interface Bench {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	store(pr: GhPr | { fail: string }, options?: { branchOnRemote?: boolean }): MergeStore;
	addJob(jobId: string, receipts?: Receipt[]): Promise<void>;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	return {
		home: home.path,
		fleet,
		runs,
		store(pr, options = {}) {
			return new MergeStore({ home: home.path, fleet, runs, run: runner(pr, options) });
		},
		async addJob(jobId, receipts) {
			await fleet.add({
				job_id: jobId,
				project: "demo",
				kind: "ship",
				delivery: "pr",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "implementer",
					role: "implementer",
					model: "mock/model",
					started_at: isoTimestamp(),
				},
				worktree: join(home.path, "worktrees", jobId),
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				...(receipts ? { receipts } : {}),
			});
		},
	};
}

const PR_RECEIPT: Receipt = { kind: "pr", status: "open", title: "PR for cp-m1", url: "https://github.com/o/r/pull/54" };

test("an unreadable receipt is no receipt, never an exception out of a gate", async (t) => {
	const b = benchOf(t);
	assert.equal(readMergeReceipt(b.home, "cp-none"), undefined);
	assert.equal(readMergeReceipt(b.home, "../escape"), undefined, "an unsafe id is not a path");
});

