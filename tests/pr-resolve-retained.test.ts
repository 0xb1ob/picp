import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeRequestObservation, ForgeObserver, ObservationOutcome } from "../src/forges/adapter.ts";
import { resolveForgeRepository } from "../src/forge-url.ts";
import { gitlabObserver } from "../src/forges/gitlab.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { resolvePr } from "../src/pr-resolve.ts";

const BRANCH = "cp-typo";
const CANONICAL = "https://github.com/0xb1ob/pi-command-post/pull/338";
const HEAD = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";
const MR_URL = "https://gitlab.example.com/group/sub/repo/-/merge_requests/12";
const GH_NEVER: CommandRunner = async () => assert.fail("a GitLab project never asks gh");

function gitlabAnswering(outcome: Partial<ChangeRequestObservation> | Exclude<ObservationOutcome, { ok: true }>, asked: string[] = []): ForgeObserver {
	return {
		provider: "gitlab",
		readChangeRequest: async (ref) => {
			asked.push(ref);
			if ("ok" in outcome) return outcome;
			return { ok: true, observation: { provider: "gitlab", url: MR_URL, number: 12, state: "open", source_branch: BRANCH, target_branch: "main", head_sha: HEAD, ...outcome } };
		},
	};
}

test("forge PR 3: a GitLab MR from the job's branch is verified by its IID, and every other answer is refused or unverified by name", async () => {
	const asked: string[] = [];
	const verified = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: MR_URL }, { exec: GH_NEVER, gitlab: gitlabAnswering({}, asked) });
	assert.deepEqual(verified, { status: "verified", url: MR_URL, number: 12 });
	assert.deepEqual(asked, [MR_URL], "the reported url is read, nothing else");

	const reason = (result: Awaited<ReturnType<typeof resolvePr>>) => (result.status === "refused" ? result.reason : `not refused: ${result.status}`);
	const none = await resolvePr({ branch: BRANCH, cwd: "/tmp" }, { exec: GH_NEVER, gitlab: gitlabAnswering({}) });
	assert.match(reason(none), /never searched for: open the merge request from branch "cp-typo"/);
	const github = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: CANONICAL }, { exec: GH_NEVER, gitlab: gitlabAnswering({}) });
	assert.match(reason(github), /not a GitLab merge request url/);
	const otherBranch = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: MR_URL }, { exec: GH_NEVER, gitlab: gitlabAnswering({ source_branch: "someone-else" }) });
	assert.match(reason(otherBranch), /is from branch "someone-else", not this job's branch "cp-typo"/);
	const mismatch = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: MR_URL }, { exec: GH_NEVER, gitlab: gitlabAnswering({ ok: false, reason: "mismatch", detail: "not this project's merge request url" }) });
	assert.match(reason(mismatch), /not this project's merge request \(mismatch: /);
	const fork = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: MR_URL }, { exec: GH_NEVER, gitlab: gitlabAnswering({ ok: false, reason: "unsupported", detail: "fork (cross-project) merge requests are not supported in v1" }) });
	assert.match(reason(fork), /unsupported: fork/);

	for (const failure of ["unavailable", "invalid"] as const) {
		const down = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: MR_URL }, { exec: GH_NEVER, gitlab: gitlabAnswering({ ok: false, reason: failure, detail: "HTTP 503" }) });
		assert.equal(down.status, "unverified", `${failure} is unverified, never verified and never a refusal`);
		assert.match(down.status === "unverified" ? down.message : "", /GitLab gave no usable answer \(HTTP 503\)/);
	}
	const bound = await resolvePr({ branch: BRANCH, cwd: "/tmp", bound: { number: 12, url: MR_URL } }, { exec: GH_NEVER, gitlab: gitlabAnswering({}) });
	assert.equal(bound.status, "verified", "a bound MR resolves from its bound url");

	// A plausible same IID on another host is refused by the real observer before any request is made.
	const repository = resolveForgeRepository("https://gitlab.example.com/group/sub/repo.git", { kind: "gitlab", web_base_url: "https://gitlab.example.com" });
	assert.ok(repository.ok, repository.ok ? "" : repository.detail);
	const fetched: string[] = [];
	const real = gitlabObserver(repository.repository, { env: {}, fetch: async (url) => (fetched.push(url), assert.fail("no request for a foreign url")) });
	const wrongHost = await resolvePr({ branch: BRANCH, cwd: "/tmp", given: "https://gitlab.attacker.example/group/sub/repo/-/merge_requests/12" }, { exec: GH_NEVER, gitlab: real });
	assert.match(reason(wrongHost), /not this project's merge request \(mismatch: /);
	assert.deepEqual(fetched, [], "a foreign url causes zero requests");
});
