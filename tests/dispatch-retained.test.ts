import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../src/command-post.ts";
import { cleanupCreatedJobBranch, type DispatchResult, type GitRunner } from "../src/dispatch.ts";
import { dispatchS29 } from "./harness/dispatch-s29.ts";
import { git, REPO_ROOT, treehouseAvailable } from "./harness/index.ts";

const SKIP = treehouseAvailable() ? false : "treehouse is required for dispatch tests";

async function bench(t: TestContext) {
	const b = await dispatchS29(t);
	const model = b.provider.addScript("retained", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	return { ...b, model, fleet: post.fleet, dispatcher: post.dispatcher() };
}

function recordingGit(log: string[][]): GitRunner {
	return async (cwd, args) => {
		log.push([...args]);
		try {
			return { status: 0, stdout: git(cwd, ...args), stderr: "" };
		} catch (error) {
			return { status: 1, stdout: "", stderr: (error as Error).message };
		}
	};
}

test("model-only dispatcher refuses declared scripts without falling through to routing", { skip: SKIP }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
	const request = { jobId: job.id, task: "run", model: b.model };
	await assert.rejects(b.dispatcher.preview(request), /script jobs use CommandPost.previewDispatch/);
	await assert.rejects(b.dispatcher.dispatch(request), /script jobs use CommandPost.dispatch/);
	await assert.rejects(b.dispatcher.dispatch({ jobId: job.id }), /script jobs use CommandPost.dispatch/);
	assert.equal(b.fleet.read().jobs.length, 0);
});

test("an unlabelled issue is not a job", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const unlabelled = {
		id: "cp-unlabelled",
		title: "unlabelled",
		status: "open" as const,
		labels: ["project:demo"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T10:00:00Z",
		updated_at: "2026-09-04T10:00:00Z",
	};
	const before = readFileSync(b.ledger.file, "utf8");
	await assert.rejects(b.ledger.importJobs([unlabelled]), /exactly one delivery:/);
	assert.equal(readFileSync(b.ledger.file, "utf8"), before, "invalid imports persist nothing");
	// Seed a historical record directly: every current write enforces required labels.
	const doc = b.ledger.read();
	doc.jobs.push(unlabelled);
	writeFileSync(b.ledger.file, JSON.stringify(doc));

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: "cp-unlabelled", task: "do it", model: b.model, fetch: false }),
		/not dispatchable/,
	);
});

test("the cleanup never runs git at all on a branch name that is not a job id", async () => {
	for (const branch of ["../../../etc/passwd", "feature/main", "-D", "", "a branch with spaces"]) {
		const log: string[][] = [];
		const outcome = await cleanupCreatedJobBranch({
			git: recordingGit(log),
			worktree: "/pool/1/demo",
			branch,
			base: "main",
		});
		assert.equal(outcome.deleted, false, `${branch} must not be deleted`);
		assert.equal(outcome.at, undefined);
		assert.match(String(outcome.note), /not a job id/);
		assert.deepEqual(log, [], `${branch} must not reach git at all`);
	}
});

test("dispatch result is one JSON object with the ported fields", async () => {
	const result: DispatchResult = {
		job_id: "cp-a",
		worker: "cp-a",
		worktree: "/pool/1/demo",
		branch: "cp-a",
		state: "dispatched",
		receipt: "accepted",
	};
	const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(parsed).sort(), ["branch", "job_id", "receipt", "state", "worker", "worktree"]);
});
