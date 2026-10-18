import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { afterMergeDeploy, afterMergeTaskText } from "../src/after-merge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type MergeReceipt, paths } from "../src/contracts.ts";
import { riskGateExempt } from "../src/dispatch-authority.ts";
import { FleetStore } from "../src/fleet.ts";
import { MandateStore } from "../src/mandate.ts";
import { opsClass, opsRequest } from "../src/ops-jobs.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, createScratchLedger, readRunEvents } from "./harness/index.ts";

const SHA = "b59fc3a1b59fc3a1b59fc3a1b59fc3a1b59fc3a1";

async function bench(t: import("node:test").TestContext, options: { optIn?: boolean } = {}) {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	t.after(() => (runs.closeAll(), home.cleanup()));
	const registry = new ProjectRegistry({ home: home.path, now: () => new Date("2026-09-01T10:00:00Z") });
	await registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git", base_branch: "main" });
	if (options.optIn !== false) await registry.setAfterMergeDeploy("demo", { task: "copy dist to host-a and restart", resources: ["host-a", "db"] });
	const { ledger } = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const fleet = new FleetStore({ home: home.path });
	const mandates = new MandateStore(home.path);
	const merged = await ledger.create({ title: "ship the thing", project: "demo", delivery: "pr", kind: "ship" });
	await fleet.add({
		job_id: merged.id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: isoTimestamp(),
		worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() },
		worktree: join(home.path, "worktrees", merged.id), branch: merged.id, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
	});
	const receipt = (extra: Partial<MergeReceipt> = {}): MergeReceipt => ({
		schema_version: 1, job_id: merged.id, pr_url: "https://github.com/o/demo/pull/7", merge_commit_sha: SHA, head_sha: SHA,
		head_branch: merged.id, base_branch: "main", merged_at: "2026-09-02T00:00:00Z", recorded_at: "2026-09-02T00:01:00Z", recorded_by: "gh pr view", ...extra,
	});
	const ports = { home: home.path, registry, ledger: () => ledger, mandates, fleet, runs, now: () => new Date("2026-09-02T00:02:00Z") };
	const issue = (extra: { job_ids?: string[]; job_cap?: number } = {}) => mandates.issue({
		projects: ["demo"], objective: "ship and deploy", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: extra.job_cap ?? 10,
		...(extra.job_ids ? { job_ids: extra.job_ids } : {}),
	});
	const record = () => JSON.parse(readFileSync(join(home.path, paths.afterMergeFile(merged.id)), "utf8"));
	const deployJobs = () => ledger.read().jobs.filter((job) => job.labels.includes(`after-merge:${merged.id}`));
	return { home: home.path, ledger, mandates, merged, receipt, ports, issue, record, deployJobs };
}

test("a merge into the deploy branch creates one blocked ops:deploy job with a frozen task file, never dispatched", async (t) => {
	const b = await bench(t);
	const line = await afterMergeDeploy(b.ports, b.receipt());
	const [job, ...rest] = b.deployJobs();
	assert.ok(job);
	assert.equal(rest.length, 0);
	for (const label of ["ops:deploy", "resource:host-a", "resource:db", "risk:high", "kind:research", "delivery:local", "project:demo"]) assert.ok(job.labels.includes(label), label);
	assert.deepEqual(job.blocked_by, [b.merged.id]);
	assert.equal(job.status, "open");
	const taskFile = join(b.home, paths.afterMergeTaskFile(b.merged.id));
	assert.equal(job.notes, `task_file: ${taskFile}`);
	const text = readFileSync(taskFile, "utf8");
	assert.equal(text, afterMergeTaskText(b.receipt(), b.ports.registry.require("demo").after_merge_deploy!));
	for (const fact of [SHA, "https://github.com/o/demo/pull/7", "branch: main", "copy dist to host-a and restart", "deployed b59fc3a1b59f", "rolled back:"]) assert.ok(text.includes(fact), fact);
	assert.match(line ?? "", new RegExp(`after-merge deploy ${job.id} created \\(blocked until ${b.merged.id} closes; no covering grant — dispatch needs a grant\\): cp_dispatch ${job.id} task_file=.* base=main`));
	assert.deepEqual({ ...b.record(), recorded_at: undefined }, {
		schema_version: 1, job_id: b.merged.id, merge_commit_sha: SHA, base_branch: "main", status: "created", deploy_job_id: job.id, coverage: "none", task_file: taskFile, recorded_at: undefined,
	});
	assert.equal(readRunEvents(b.home, b.merged.id).filter((event) => event.type === "after_merge_deploy").length, 1);
	// Dispatch of this job stays risk:high-gated: ops jobs are never exempt.
	assert.equal(opsRequest({}, job, "research", "local").risk, "high");
	assert.equal(riskGateExempt({ kind: "research", readOnly: true, ops: opsClass(job) !== undefined }), false);
});

test("re-recording and a crash before the record write resume onto the same single job", async (t) => {
	const b = await bench(t);
	await afterMergeDeploy(b.ports, b.receipt());
	assert.equal(await afterMergeDeploy(b.ports, b.receipt()), undefined, "an existing record says nothing new");
	rmSync(join(b.home, paths.afterMergeFile(b.merged.id)));
	const line = await afterMergeDeploy(b.ports, b.receipt());
	assert.equal(b.deployJobs().length, 1);
	assert.match(line ?? "", new RegExp(`after-merge deploy ${b.deployJobs()[0]?.id} created`));
	await b.ledger.drop(b.deployJobs()[0]!.id, "operator dropped it");
	rmSync(join(b.home, paths.afterMergeFile(b.merged.id)));
	await afterMergeDeploy(b.ports, b.receipt());
	assert.equal(b.deployJobs().length, 1, "a closed deploy job still holds the key");
});

test("base mismatch, missing base and a pre-opt-in merge write skipped and create nothing; no opt-in is silent", async (t) => {
	for (const [extra, reason] of [
		[{ base_branch: "develop" }, /merged into develop, not the deploy branch main/],
		[{ base_branch: undefined }, /names no base branch/],
		[{ merged_at: "2026-08-31T00:00:00Z" }, /before after_merge_deploy was enabled/],
	] as const) {
		const b = await bench(t);
		const receipt = b.receipt(extra as Partial<MergeReceipt>);
		assert.match((await afterMergeDeploy(b.ports, receipt)) ?? "", reason);
		assert.equal(b.record().status, "skipped");
		assert.match(b.record().reason, reason);
		assert.equal(b.deployJobs().length, 0);
	}
	const off = await bench(t, { optIn: false });
	assert.equal(await afterMergeDeploy(off.ports, off.receipt()), undefined);
	assert.equal(existsSync(join(off.home, paths.afterMergeFile(off.merged.id))), false);
});

test("coverage: a named grant listing the merged job enrolls the deploy; at its cap it is refused; project-wide covers", async (t) => {
	const named = await bench(t);
	const grant = named.issue({ job_ids: [named.merged.id] });
	assert.match((await afterMergeDeploy(named.ports, named.receipt())) ?? "", new RegExp(`enrolled in ${grant.id}`));
	const deployId = named.deployJobs()[0]!.id;
	assert.deepEqual(named.mandates.require(grant.id).job_ids, [named.merged.id, deployId]);
	assert.equal(named.record().coverage, "enrolled");
	assert.equal(named.record().mandate_id, grant.id);

	const capped = await bench(t);
	const full = capped.issue({ job_ids: [capped.merged.id], job_cap: 1 });
	assert.match((await afterMergeDeploy(capped.ports, capped.receipt())) ?? "", /no covering grant — dispatch needs a grant \(cannot enroll .*job cap 1 reached\)/);
	assert.equal(capped.record().coverage, "none");
	assert.deepEqual(capped.mandates.require(full.id).job_ids, [capped.merged.id]);

	const wide = await bench(t);
	const projectWide = wide.issue();
	assert.match((await afterMergeDeploy(wide.ports, wide.receipt())) ?? "", new RegExp(`covered by project-wide ${projectWide.id}`));
	assert.equal(wide.record().coverage, "project_wide");

	// Coverage is cp_dispatch's own grant selection: a project-wide grant that excludes research never selects the deploy.
	const excluded = await bench(t);
	excluded.mandates.issue({ projects: ["demo"], objective: "ship only", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10, exclusions: { job_kinds: ["research"] } });
	assert.match((await afterMergeDeploy(excluded.ports, excluded.receipt())) ?? "", /no covering grant — dispatch needs a grant/);
	assert.equal(excluded.record().coverage, "none");
});

test("a ledger refusal throws and writes no record, so the merge store names it and a retry can still create", async (t) => {
	const b = await bench(t);
	const failing = { ...b.ports, ledger: () => { throw new Error("ledger refused: archived project"); } };
	await assert.rejects(afterMergeDeploy(failing, b.receipt()), /ledger refused/);
	assert.equal(existsSync(join(b.home, paths.afterMergeFile(b.merged.id))), false);
	assert.match((await afterMergeDeploy(b.ports, b.receipt())) ?? "", /created/);
});
