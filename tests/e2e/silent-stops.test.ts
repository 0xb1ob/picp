/**
 * Silent-stop wake-ups (pi-command-post-autonomy-programme-cur.1.3).
 *
 * Kill a mock worker → one death wake-up. Restart reconcile → one recovery
 * message, not replayed after confirm.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type DurableWakeupEntry, isoTimestamp } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	readRunStatus,
	REPO_ROOT,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "silent-stops e2e needs treehouse on PATH";

test("kill a mock worker mid-run produces exactly one death wake-up", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const deaths: DurableWakeupEntry[] = [];
	let pool: ReturnType<typeof enableTreehouse> | undefined;
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...agentDir.env },
		holdsParentLock: () => true,
		onDurableWakeup: () => {
			post.drainDurableWakeups((entry) => {
				if (entry.kind === "death") deaths.push(entry);
			});
		},
	});
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(post.registry.pathOf("demo"), "prune");
		} catch {
			// pool gone next
		}
		pool?.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	pool = enableTreehouse(clone, { maxTrees: 3 });
	const issue = await post.ledger().create({
		title: "die mid-run",
		project: "demo",
		delivery: "local",
		kind: "ship",
		slug: "silent",
	});
	const jobId = issue.id;
	const model = provider.addScript("silent-die", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 30" } }] },
	]);
	agentDir.writeModels(provider);
	await post.dispatch({ jobId, task: "Bump x.", model, fetch: false });
	const managed = post.manager.get(jobId);
	assert.ok(managed);
	await waitFor(
		() => readRunStatus(home.path, jobId),
		(status) => status.phase === "working",
		{ timeoutMs: 60_000, what: "worker working" },
	);
	await managed.worker.kill("SIGKILL");
	await waitFor(
		() => readFleet(home.path).jobs[0],
		(record) => record?.phase === "failed",
		{ timeoutMs: 60_000, what: "crash classified" },
	);
	await waitFor(
		() => deaths.length,
		(n) => n === 1,
		{ timeoutMs: 15_000, what: "one death wake-up" },
	);
	assert.equal(deaths.length, 1);
	assert.equal(deaths[0]?.kind, "death");
	assert.equal(deaths[0]?.job_id, jobId);
	assert.match(deaths[0]?.content ?? "", /WORKER DEATH/);
	assert.match(deaths[0]?.content ?? "", /cp_teardown/);
	post.confirmDurableWakeups(deaths.map((entry) => entry.id));
	assert.deepEqual(
		post.drainDurableWakeups(() => assert.fail("confirmed death must not replay")),
		[],
	);
});

test("reconcile after a dead worker produces one recovery message", { timeout: 30_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const fleet = new FleetStore({ home: home.path });
	await fleet.add({
		job_id: "cp-rec",
		project: "demo",
		kind: "ship",
		delivery: "local",
		origin: "terminal",
		phase: "waiting",
		worker: {
			pid: 1,
			session_id: "s",
			session_file: "/no/session.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: "cp-rec",
		dispatched_at: isoTimestamp(),
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 },
	});
	writeFileSync(join(home.path, "wt-placeholder"), "");
	const recovered: DurableWakeupEntry[] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		onDurableWakeup: () => {
			post.drainDurableWakeups((entry) => recovered.push(entry));
		},
	});
	t.after(() => post.shutdown());
	await post.reconcile({ isPidAlive: () => false });
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.kind, "recovery");
	assert.match(recovered[0]?.content ?? "", /cp-rec/);
	post.confirmDurableWakeups(recovered.map((entry) => entry.id));
	const again = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
	});
	t.after(() => again.shutdown());
	await again.reconcile({ isPidAlive: () => false });
	assert.deepEqual(
		again.drainDurableWakeups(() => assert.fail("confirmed recovery must not replay")),
		[],
	);
});
