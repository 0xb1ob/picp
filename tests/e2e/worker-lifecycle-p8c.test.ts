/**
 * Behavior 04 (P8c): the spawn cap's gate-reviewer reserve, driven through a real CommandPost, real pi planners and
 * gate reviewers on a treehouse pool and the mock provider.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, MINIMAL_PLAN_SUMMARY, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { isGateWait } from "../../src/gate.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "worker-lifecycle-p8c e2e needs treehouse on PATH";

function verdict(jobId: string): ScriptStep {
	return { kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["plan is concrete"],
	} }] };
}

test("P8c reserve: held authors at the spawn cap refuse another author, yet gate reviewers start until the reserve is full and a closed reviewer frees it", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [] }));
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 5 });
	let release = (): void => {};
	t.after(async () => {
		release();
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	const authors: string[] = [];
	for (const slug of ["r1", "r2", "r3"]) {
		const jobId = (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "research", slug })).id;
		const model = provider.addScript(`plan-${slug}`, [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf '# Goal\\n${slug}\\n' > "$CP_ARTIFACT_PATH"` } }] },
			{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: jobId, kind: "research", status: "done", summary: "Plan written.",
				artifact_path: post.artifacts.file(jobId), plan_summary: MINIMAL_PLAN_SUMMARY,
				self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false } } }] },
			{ kind: "text", text: "Reported." },
		], { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		await post.dispatch({ jobId, task: `Plan ${slug}.`, model, fetch: false });
		authors.push(jobId);
	}
	const [r1, r2, r3] = authors as [string, string, string];
	const held = new Promise<void>((resolve) => (release = resolve));
	const gateR1 = provider.addScript("gate-r1", [{ kind: "hang", until: held }, verdict(r1)], { onExhausted: "repeat" });
	const gateR2 = provider.addScript("gate-r2", [verdict(r2)], { onExhausted: "repeat" });
	const freshModel = provider.addScript("fresh", [{ kind: "text", text: "never" }]);
	agentDir.writeModels(provider);
	for (const jobId of authors) await waitFor(() => post.fleet.require(jobId).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: `${jobId} held` });
	assert.deepEqual(authors.map((jobId) => post.manager.get(jobId) !== undefined), [true, true, true], "held planners keep their process");

	writeFileSync(join(home.path, LAYOUT.budgetsFile), JSON.stringify({ schema_version: 1, per_job_tokens: 1_000_000, per_job_cost_usd: 3, warn_ratio: 0.8, spawn_cap: 1 }));
	const fresh = (await post.ledger().create({ title: "fresh", project: "demo", delivery: "local", kind: "ship", slug: "fresh" })).id;
	await assert.rejects(post.dispatch({ jobId: fresh, task: "More work.", model: freshModel, fetch: false }),
		/spawn cap reached \(3\/1 workers\).*Three extra slots are reserved for gate-reviewer/, "an author never takes the reserve");

	const first = await post.gate({ jobId: r1, model: gateR1 });
	assert.ok(isGateWait(first), JSON.stringify(first));
	assert.ok(post.manager.get(first.key), "a gate reviewer starts past the authors' cap");

	const full = await post.gate({ jobId: r2, model: gateR2 });
	assert.equal(isGateWait(full), false, "no reviewer past the reserve");
	const refusal = JSON.parse(readFileSync(join(home.path, paths.gateFile(r2, 1)), "utf8")) as { cause: string; reasons: string[] };
	assert.equal(refusal.cause, "operational");
	assert.match(refusal.reasons.join(" "), /reviewer could not run: review reserve exhausted \(4\/4 workers\)/);
	assert.equal(post.manager.get(r2) !== undefined && post.manager.get(r3) !== undefined, true, "the refusal stops no author");

	release();
	post.reviewRuns.handBack(first.key);
	await post.reviewRuns.settled(first.key);
	await waitFor(() => post.manager.get(first.key), (live) => live === undefined, { timeoutMs: 30_000, what: "the first reviewer's close" });
	const retry = await post.gate({ jobId: r2, model: gateR2 });
	assert.ok(isGateWait(retry), `a closed reviewer frees its reserve slot: ${JSON.stringify(retry)}`);
	post.reviewRuns.handBack(retry.key);
	await post.reviewRuns.settled(retry.key);
});
