import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CI_READ_NEEDED, CI_UNREADABLE, CI_UNREADABLE_LABEL, ciReadDenied } from "../src/ci-access.ts";
import { ciAccessFindings } from "../src/ci-access-doctor.ts";
import { LAYOUT, SCHEMA_VERSION } from "../src/contracts.ts";
import { waitReason } from "../src/status-render.ts";
import { CI_UNREADABLE as VIEWER_CI_UNREADABLE } from "../src/viewer/overview-jobs.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

test("ciReadDenied: only a permission refusal of a CI read counts", () => {
	assert.ok(ciReadDenied("gh run list --branch b failed: HTTP 403: Resource not accessible by personal access token"));
	assert.ok(ciReadDenied("HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/runs?branch=b)"));
	assert.ok(ciReadDenied("repos/o/r/actions/runs/9/attempts/2/jobs: Resource not accessible by integration"));
	assert.ok(ciReadDenied("gh run view 9 --json jobs failed: HTTP 403"));
	for (const path of ["repos/o/r/commits/abc/check-runs", "repos/o/r/commits/abc/status", "repos/o/r/statuses/abc"]) {
		assert.equal(ciReadDenied(`${path}: HTTP 403: Resource not accessible by integration`), false, `${path} is not CI evidence`);
	}
	assert.equal(ciReadDenied("gh run list --branch b failed: dial tcp: network is unreachable"), false, "a network fault is unknown");
	assert.equal(ciReadDenied("gh api repos/o/r/pulls/7 failed: HTTP 403"), false, "a PR read is not a CI read");
	assert.equal(VIEWER_CI_UNREADABLE, CI_UNREADABLE, "the viewer reads the value the watcher writes");
});

test("the browser mirrors the backend's Actions-only label and advice, keeping its needs prefix", () => {
	const tsx = readFileSync(join(REPO_ROOT, "viewer-app/components/JobSignals.tsx"), "utf8");
	assert.ok(tsx.includes(`CI_UNREADABLE_LABEL = "${CI_UNREADABLE_LABEL}"`), "label parity");
	assert.ok(tsx.includes(`CI_READ_NEEDED = "needs ${CI_READ_NEEDED}"`), "advice parity");
	assert.doesNotMatch(`${CI_UNREADABLE_LABEL} ${CI_READ_NEEDED}`, /checks|statuses/i);
});

test("a held job whose CI read was refused names the token as its wait reason, before any head is known", () => {
	const reason = waitReason({ phase: "held", delivery: "pr", ci: { state: CI_UNREADABLE } } as Parameters<typeof waitReason>[0]);
	assert.equal(reason, "CI unreadable (token)");
});

function register(home: string, projects: { name: string; clone_url: string }[]): void {
	const file = join(home, LAYOUT.projectsFile);
	mkdirSync(dirname(file), { recursive: true });
	const rows = projects.map((p) => ({ ...p, delivery: "pr", registered_at: "2026-10-15T00:00:00Z" }));
	writeFileSync(file, JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-10-15T00:00:00Z", projects: rows }));
}

test("doctor ci.<project>: refused, none, readable and unknown are four distinct findings; gh output is never echoed", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	register(home.path, [
		{ name: "denied", clone_url: "https://github.com/o/denied.git" },
		{ name: "bare", clone_url: "git@github.com:o/bare.git" },
		{ name: "ci", clone_url: "https://github.com/o/ci" },
		{ name: "flaky", clone_url: "https://github.com/o/flaky" },
		{ name: "lab", clone_url: "https://gitlab.com/o/lab.git" },
	]);
	const asked: string[] = [];
	const secret = "sentinel-credential-value";
	const findings = ciAccessFindings(home.path, (command, args) => {
		asked.push(`${command} ${args.join(" ")}`);
		const repo = args[1] ?? "";
		if (repo.includes("/denied/")) return { status: 1, stdout: "", stderr: `HTTP 403: Resource not accessible by personal access token ${secret}` };
		if (repo.includes("/bare/")) return { status: 0, stdout: JSON.stringify({ total_count: 0, workflows: [] }), stderr: "" };
		if (repo.includes("/ci/")) return { status: 0, stdout: JSON.stringify({ total_count: 2, workflows: [{}, {}] }), stderr: "" };
		return { status: 1, stdout: "", stderr: `dial tcp: i/o timeout ${secret}` };
	});
	assert.deepEqual(asked, ["denied", "bare", "ci", "flaky"].map((r) => `gh api repos/o/${r}/actions/workflows`), "one read per GitHub project");
	const by = Object.fromEntries(findings.map((f) => [f.check, f]));
	assert.equal(by["ci.denied"]?.severity, "warn");
	assert.equal(by["ci.denied"]?.what, `${CI_UNREADABLE_LABEL} for o/denied`);
	assert.match(by["ci.denied"]?.fix ?? "", /Actions read \+ Contents read \+ Metadata read \+ Pull requests read; classic: repo/);
	assert.doesNotMatch(by["ci.denied"]?.fix ?? "", /Checks|statuses/i, "never advises a grant that does not fix the read");
	assert.deepEqual([by["ci.bare"]?.severity, by["ci.bare"]?.what], ["ok", "no CI configured for o/bare (0 Actions workflows)"]);
	assert.deepEqual([by["ci.ci"]?.severity, by["ci.ci"]?.what], ["ok", "CI readable for o/ci (2 workflow(s))"]);
	assert.equal(by["ci.flaky"]?.severity, "warn");
	assert.match(by["ci.flaky"]?.what ?? "", /CI state unknown/);
	assert.equal(by["ci.lab"], undefined, "a non-GitHub project is not asked");
	assert.doesNotMatch(JSON.stringify(findings), new RegExp(secret), "never prints what gh printed");
	assert.deepEqual(ciAccessFindings(home.path, () => ({ status: null, stdout: "", stderr: "spawnSync gh ENOENT" })), [], "no gh: host.gh says so");
});
