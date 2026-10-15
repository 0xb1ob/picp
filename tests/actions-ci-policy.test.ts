/**
 * Regression policy: CI evidence comes only from Actions REST runs and attempt jobs — never the Checks API, the
 * commit-status API or GraphQL statusCheckRollup. The fake runner throws on any other request, response links to
 * prohibited endpoints are never followed, and the acquisition sources carry no prohibited request string.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readActionsCi } from "../src/actions-ci.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { REPO_ROOT } from "./harness/index.ts";

const SHA = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const ALLOWED = [
	/^repos\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\{owner\}\/\{repo\})\/actions\/runs\?head_sha=[0-9a-f]{40}(?:&branch=[^&]+)?&per_page=100&page=\d+$/,
	/^repos\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\{owner\}\/\{repo\})\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?per_page=100&page=\d+$/,
];
const PROHIBITED = /check-runs|check-suites|check_runs|check_suites|\/status(?:es)?\b|statusCheckRollup|\bpr\s+checks\b|graphql/i;

/** The CI acquisition modules; every new CI reader joins this list. */
const ACQUISITION_SOURCES = [
	"src/actions-ci.ts",
	"src/merge-ask.ts",
	"src/ci-watch.ts",
	"src/foreign-ci-watch.ts",
	"src/main-ci.ts",
	"src/integrate.ts",
	"src/integrate-held.ts",
	"src/ci-infra-rerun.ts",
];

function allowlistedGh(answer: (endpoint: string) => string) {
	const calls: string[] = [];
	const exec: CommandRunner = async (command, args) => {
		const request = [command, ...args].join(" ");
		if (command !== "gh" || args[0] !== "api" || args.length !== 2) throw new Error(`prohibited CI request: ${request}`);
		const endpoint = String(args[1]);
		if (!ALLOWED.some((pattern) => pattern.test(endpoint)) || PROHIBITED.test(endpoint)) throw new Error(`prohibited CI request: ${request}`);
		calls.push(endpoint);
		return answer(endpoint);
	};
	return { exec, calls };
}

test("Actions reader issues only runs and attempt-jobs requests and never follows response metadata links", async () => {
	const api = "https://api.github.com/repos/acme/app";
	const { exec, calls } = allowlistedGh((endpoint) =>
		endpoint.includes("/jobs")
			? JSON.stringify({
					total_count: 1,
					jobs: [{ id: 3, run_id: 7, run_attempt: 1, head_sha: SHA, name: "t", status: "completed", conclusion: "success", check_run_url: `${api}/check-runs/3` }],
				})
			: JSON.stringify({
					total_count: 1,
					workflow_runs: [
						{
							id: 7,
							run_attempt: 1,
							head_sha: SHA,
							status: "completed",
							conclusion: "success",
							jobs_url: `${api}/check-suites/9/check-runs`,
							check_suite_url: `${api}/check-suites/9`,
							statuses_url: `${api}/statuses/${SHA}`,
							url: `${api}/commits/${SHA}/status`,
						},
					],
				}),
	);
	for (const repo of [{ owner: "acme", repo: "app" }, undefined]) {
		calls.length = 0;
		const runs = await readActionsCi({ cwd: "/x", exec, ...(repo ? { repo } : {}), sha: SHA, branch: "main" });
		assert.equal(runs.length, 1);
		assert.equal(calls.length, 2);
		for (const call of calls) assert.ok(!PROHIBITED.test(call), call);
	}
});

/** Code only: comments may explain what is prohibited, and guards/detectors are not acquisition sources. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("CI acquisition sources contain no Checks, commit-status or statusCheckRollup request", () => {
	for (const file of ACQUISITION_SOURCES) {
		const lines = code(readFileSync(join(REPO_ROOT, file), "utf8")).split("\n");
		const hits = lines.filter((line) => PROHIBITED.test(line));
		assert.deepEqual(hits, [], `${file} must read CI only through Actions runs/jobs`);
	}
});
