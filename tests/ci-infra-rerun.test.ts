/**
 * unload-parent PR2: one automatic rerun of an infra-only CI failure — the classifier
 * fixtures, the claim written before the gh call, and every path that leaves it to the parent.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CiRerunStore, classifyInfraFailure, maybeRerunInfra } from "../src/ci-infra-rerun.ts";
import { LAYOUT } from "../src/contracts.ts";
import { drainFile } from "../src/drain.ts";
import type { CiRun } from "../src/merge-ask.ts";
import { createScratchHome } from "./harness/index.ts";

const HEAD = "d48a81d1f4d3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The repo's own workflow (.github/workflows/ci.yml) with one failed step. */
function view(failed: string, conclusion = "failure"): string {
	const names = ["Set up job", "Checkout", "Set up Node", "Install dependencies", "Install treehouse", "Run suite (typecheck + tests)", "Eval contract check"];
	const at = names.indexOf(failed);
	const steps = names.map((name, index) => ({ name, conclusion: index < at ? "success" : index === at ? "failure" : "skipped" }));
	return JSON.stringify({ jobs: [{ name: "suite", conclusion, steps }] });
}

test("classifyInfraFailure: setup steps are infra; the suite, a cancel and an unreadable listing are not", () => {
	for (const step of ["Set up job", "Checkout", "Set up Node", "Install dependencies", "Install treehouse"]) {
		const verdict = classifyInfraFailure(view(step));
		assert.equal(verdict.infra, true, step);
		assert.equal(verdict.step, step);
	}
	assert.equal(classifyInfraFailure(view("Run suite (typecheck + tests)")).infra, false);
	assert.equal(classifyInfraFailure(view("Eval contract check")).infra, false);
	assert.equal(classifyInfraFailure(view("Install treehouse", "cancelled")).infra, false, "a cancelled job is never infra");
	assert.equal(classifyInfraFailure(view("Install treehouse", "timed_out")).infra, false, "a timed-out job is never infra");
	assert.equal(classifyInfraFailure(JSON.stringify({ jobs: [{ name: "a", conclusion: "failure", steps: [{ name: "Install build tools", conclusion: "failure" }] }] })).infra, false, "a setup-looking step naming a build is not infra");
	const mixed = { jobs: [JSON.parse(view("Install treehouse")).jobs[0], { ...JSON.parse(view("Run suite (typecheck + tests)")).jobs[0], name: "other" }] };
	assert.equal(classifyInfraFailure(JSON.stringify(mixed)).infra, false, "every failed job must be infra");
	assert.equal(classifyInfraFailure("not json").infra, false);
	assert.equal(classifyInfraFailure(JSON.stringify({ jobs: [{ name: "a", conclusion: "failure", steps: [] }] })).infra, false, "a failed job with no failed step is not proven infra");
});

function bench(t: { after(fn: () => void): void }, options: { view?: string; viewStatus?: number; rerunStatus?: number } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CiRerunStore(home.path);
	const calls: string[] = [];
	const claimsAtRerun: number[] = [];
	const run = async (_cwd: string, _bin: string, args: readonly string[]) => {
		calls.push(args.join(" "));
		if (args[1] === "rerun") {
			claimsAtRerun.push(store.read().entries.length);
			return { status: options.rerunStatus ?? 0, stdout: "", stderr: options.rerunStatus ? "HTTP 403: forbidden" : "" };
		}
		return { status: options.viewStatus ?? 0, stdout: options.view ?? view("Install treehouse"), stderr: options.viewStatus ? "gh: not found" : "" };
	};
	const failed = (overrides: Partial<CiRun> = {}): CiRun => ({ status: "completed", conclusion: "failure", headSha: HEAD, databaseId: 41, attempt: 1, workflowName: "CI", ...overrides });
	const go = (runs: CiRun[]) => maybeRerunInfra({ jobId: "cp-r1", head: HEAD, runs, cwd: home.path, run, home: home.path, store, now: () => new Date("2026-10-04T15:00:00Z") });
	return { home: home.path, store, calls, claimsAtRerun, failed, go };
}

test("an infra-only failure is claimed first, then rerun once; the same job+head never again", async (t) => {
	const b = bench(t);
	const outcome = await b.go([b.failed()]);
	assert.equal(outcome?.rerun, true, outcome?.fact);
	assert.deepEqual(b.calls, ["run view 41 --json jobs", "run rerun 41 --failed"]);
	assert.deepEqual(b.claimsAtRerun, [1], "the claim was on disk before gh run rerun ran");
	assert.deepEqual(JSON.parse(readFileSync(join(b.home, LAYOUT.ciRerunsFile), "utf8")).entries, [{ job_id: "cp-r1", head_sha: HEAD, run_id: 41, step: "Install treehouse", at: "2026-10-04T15:00:00Z" }]);
	const again = await b.go([b.failed()]);
	assert.equal(again?.rerun, false);
	assert.match(again?.fact ?? "", /was spent at/);
	assert.equal(b.calls.length, 2, "no second gh call of any kind");
});

test("attempt 2, a test failure, a cancel, no run id, a green head and a drain all leave it to the parent", async (t) => {
	const b = bench(t);
	assert.equal(await b.go([b.failed({ conclusion: "success" })]), undefined, "nothing failed: nothing to say");
	assert.match((await b.go([b.failed({ attempt: 2 })]))?.fact ?? "", /attempt 2: a second failure is the parent's/);
	assert.match((await b.go([b.failed({ conclusion: "cancelled" })]))?.fact ?? "", /concluded cancelled/);
	assert.match((await b.go([b.failed({ conclusion: "timed_out" })]))?.fact ?? "", /concluded timed_out/);
	const { databaseId: _id, ...noId } = b.failed();
	assert.match((await b.go([noId]))?.fact ?? "", /no id or attempt/);
	assert.deepEqual(b.calls, [], "none of those asked gh anything");
	mkdirSync(dirname(drainFile(b.home)), { recursive: true });
	writeFileSync(drainFile(b.home), JSON.stringify({ state: "draining", started_at: "2026-10-04T15:00:00Z", deadline: "x", timeout_s: 1, jobs: [] }));
	assert.match((await b.go([b.failed()]))?.fact ?? "", /draining/);
	assert.deepEqual(b.calls, []);

	const tests = bench(t, { view: view("Run suite (typecheck + tests)") });
	const outcome = await tests.go([tests.failed()]);
	assert.equal(outcome?.rerun, false);
	assert.deepEqual(tests.calls, ["run view 41 --json jobs"], "classified, never rerun");
	assert.deepEqual(tests.store.read().entries, [], "no claim for a test failure");
});

test("fail closed: an unreadable claim file or jobs listing reruns nothing; a refused rerun keeps its claim", async (t) => {
	const corrupt = bench(t);
	mkdirSync(dirname(corrupt.store.file), { recursive: true });
	writeFileSync(corrupt.store.file, "{ not json");
	assert.match((await corrupt.go([corrupt.failed()]))?.fact ?? "", /unparseable/);
	assert.deepEqual(corrupt.calls, []);

	const blind = bench(t, { viewStatus: 1 });
	assert.match((await blind.go([blind.failed()]))?.fact ?? "", /gh run view 41 failed/);
	assert.deepEqual(blind.store.read().entries, []);

	const refused = bench(t, { rerunStatus: 1 });
	const outcome = await refused.go([refused.failed()]);
	assert.equal(outcome?.rerun, false);
	assert.match(outcome?.fact ?? "", /gh refused .*HTTP 403.*goes to the parent/);
	assert.equal(refused.store.read().entries.length, 1, "the claim stands: a gh fault never earns a second try");
	await refused.go([refused.failed()]);
	assert.equal(refused.calls.filter((call) => call.startsWith("run rerun")).length, 1);
});
