import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deployView } from "../src/viewer/deploy-view.ts";
import { jobView } from "../src/viewer/jobs-view.ts";
import type { ViewerJob } from "../src/viewer/api-types.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

const SHA = "b59fc3a1".repeat(5);
const AT = "2026-09-26T12:00:00Z";

function fixture(t: import("node:test").TestContext) {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	const put = (file: string, value: unknown) => { const path = join(home.path, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
	const record = (extra: Record<string, unknown> = {}) => put(join(LAYOUT.runs, "cp-merged/after-merge.json"), {
		schema_version: 1, job_id: "cp-merged", merge_commit_sha: SHA, base_branch: "main", status: "created", deploy_job_id: "cp-deploy",
		coverage: "none", task_file: "/x/after-merge-task.md", recorded_at: AT, ...extra,
	});
	const envelope = (envelope: Record<string, unknown>) => put(join(LAYOUT.runs, "cp-deploy/envelope.json"), { envelope });
	return { state, put, record, envelope };
}
const deployJob = (over: Partial<ViewerJob>) => [{ id: "cp-deploy", phase: "queued", failure: null, finished_at: null, ...over } as ViewerJob];

test("deployView maps the after-merge record and the deploy job to one state; no record is null", (t) => {
	const { state, record, envelope } = fixture(t);
	assert.equal(deployView(state, "cp-merged", []), null, "no record: no Deploy row");
	record({ coverage: "project_wide", mandate_id: "md-wide" });
	assert.deepEqual(deployView(state, "cp-merged", []), {
		state: "queued", merge_sha: SHA, branch: "main", deploy_job_id: "cp-deploy", reason: null, at: null, coverage: "project_wide", mandate_id: "md-wide",
	}, "created with no fleet record yet: queued");
	assert.equal(deployView(state, "cp-merged", deployJob({ phase: "launching" }))?.state, "queued");
	assert.equal(deployView(state, "cp-merged", deployJob({ phase: "working" }))?.state, "deploying");
	assert.equal(deployView(state, "cp-merged", deployJob({ phase: "held" }))?.state, "deploying");
	const failed = deployView(state, "cp-merged", deployJob({ phase: "failed", failure: "worker died\nstack" }))!;
	assert.deepEqual([failed.state, failed.reason], ["failed", "worker died"]);
	const silent = deployView(state, "cp-merged", deployJob({ phase: "done" }))!;
	assert.deepEqual([silent.state, silent.reason], ["failed", "closed without a report"], "closed silently is never shown as deployed");

	envelope({ status: "blocked", blockers: [{ question: "rolled back: health check failed on host-a", why: "w" }] });
	const blocked = deployView(state, "cp-merged", deployJob({ phase: "held" }))!;
	assert.deepEqual([blocked.state, blocked.reason], ["blocked", "rolled back: health check failed on host-a"]);
	envelope({ status: "blocked", blockers: ["needs the operator to open port 22"] });
	assert.equal(deployView(state, "cp-merged", deployJob({ phase: "held" }))?.reason, "needs the operator to open port 22");
	envelope({ status: "done", summary: `deployed ${SHA.slice(0, 12)}` });
	const done = deployView(state, "cp-merged", deployJob({ phase: "done", finished_at: AT }))!;
	assert.deepEqual([done.state, done.at, done.reason], ["deployed", AT, null]);
});

test("a skipped record shows its reason; a malformed or foreign record shows nothing", (t) => {
	const { state, record } = fixture(t);
	record({ status: "skipped", deploy_job_id: undefined, coverage: undefined, reason: "merged into release, not the deploy branch main" });
	assert.deepEqual(deployView(state, "cp-merged", []), {
		state: "skipped", merge_sha: SHA, branch: "main", deploy_job_id: null, reason: "merged into release, not the deploy branch main", at: null, coverage: null, mandate_id: null,
	});
	record({ job_id: "cp-other" });
	assert.equal(deployView(state, "cp-merged", []), null, "a record for another job is not this job's deploy");
	record({ merge_commit_sha: "nope" });
	assert.equal(deployView(state, "cp-merged", []), null);
	assert.equal(deployView(state, "../cp-merged", []), null);
});

test("jobView attaches deploy only to the job with a record and labels the after_merge_deploy event", (t) => {
	const { state, put, record } = fixture(t);
	put(".pi-command-post/jobs.json", { jobs: [
		{ id: "cp-merged", title: "ship", status: "closed", closed_at: AT, labels: ["project:demo", "kind:ship"] },
		{ id: "cp-deploy", title: "deploy", status: "open", labels: ["project:demo", "kind:research", "ops:deploy"], blocked_by: [] },
	] });
	record();
	writeFileSync(join(state.stateDir, "runs/cp-merged/events.jsonl"), JSON.stringify({ source: "cp", job_id: "cp-merged", ts: AT, type: "after_merge_deploy", payload: { deploy_job_id: "cp-deploy", coverage: "none" } }) + "\n");
	const merged = jobView(state, "cp-merged", Date.parse(AT))!;
	assert.deepEqual([merged.deploy?.state, merged.deploy?.deploy_job_id, merged.deploy?.coverage], ["queued", "cp-deploy", "none"]);
	assert.deepEqual(merged.timeline.map((e) => [e.label, e.meta]), [["Deploy job created", "cp-deploy"]]);
	assert.equal("deploy" in jobView(state, "cp-deploy", Date.parse(AT))!, false);
});
