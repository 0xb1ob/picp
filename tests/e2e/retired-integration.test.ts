/**
 * Retired tracker sync, link and import on the mock provider: an existing home's inert job links, command-shaped
 * refs and malformed retired sync state survive startup and a native dispatch→report→teardown→close.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import type { IntakeResult } from "../../src/intake.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readFleet,
	REPO_ROOT,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "needs treehouse on PATH";
const AT = "2026-01-01T00:00:00Z";
const OPEN = "cp-legacy-open";
const DEFERRED = "cp-legacy-deferred";
const CLOSED = "cp-legacy-closed";
const LINK = { connection_id: "legacy-x", item_id: "item-1", linked_at: AT };
const OPAQUE = "external-tool show item --json";
const PINNED = "external-tool --db '/legacy/item.db' show item-2 --json";

function legacyJob(id: string, status: string, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		id, title: `legacy ${id}`, status, labels: ["project:demo", "kind:ship", "delivery:local"], blocked_by: [],
		comments: [{ at: AT, author: "legacy", text: "kept verbatim" }], created_at: AT, updated_at: AT, ...extra,
	};
}

test("retired integration: an existing home keeps its data and runs the native lifecycle with no external call", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	// A command-shaped ref must never run: a fake on PATH records any invocation.
	const bin = join(home.path, "fake-bin");
	const calls = join(home.path, "external-calls.log");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "external-tool"), `#!/bin/sh\necho "$*" >> '${calls}'\n`);
	chmodSync(join(bin, "external-tool"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;

	const retired: Record<string, string> = {
		[join(LAYOUT.state, "tracker-sync.json")]: "[ malformed retired intents",
		[join(LAYOUT.state, "tracker-tasks", `${OPEN}.md`)]: "frozen task snapshot\n",
	};
	for (const [file, body] of Object.entries(retired)) {
		mkdirSync(join(home.path, file, ".."), { recursive: true });
		writeFileSync(join(home.path, file), body);
	}
	writeFileSync(join(home.path, LAYOUT.jobsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [
		legacyJob(OPEN, "open", { external_ref: OPAQUE, tracker: LINK }),
		legacyJob(DEFERRED, "deferred", { external_ref: PINNED, tracker: { ...LINK, item_id: "item-2" } }),
		legacyJob(CLOSED, "closed", { external_ref: "external-tool show item-3 --json", tracker: { ...LINK, item_id: "item-3" }, closed_at: AT, close_reason: "done" }),
	] }));

	const reported: IntakeResult[] = [];
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, onReported: (result) => reported.push(result) });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });
	t.after(async () => {
		process.env.PATH = savedPath;
		await post.shutdown();
		try { treehouse(clone, "prune"); } catch { /* the pool root is removed next anyway */ }
		pool.cleanup(); agentDir.cleanup(); repo.cleanup(); home.cleanup();
		await provider.stop();
	});

	// Native reads keep every legacy field; the deferred job stays deferred until an explicit native update.
	const ledger = post.ledger();
	const open = await ledger.show(OPEN);
	assert.deepEqual([open.tracker, open.external_ref, open.comments.length], [LINK, OPAQUE, 1]);
	assert.equal((await ledger.list({ all: true })).length, 3);
	assert.deepEqual((await ledger.ready()).map((job) => job.id), [OPEN]);
	await assert.rejects(ledger.claim(DEFERRED, "operator"), /is deferred; review its task and authority, then use cp_job update status=open when authorized/);
	assert.equal((await ledger.show(DEFERRED)).status, "deferred");

	const model = provider.addScript("retired-ship", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x' && git push -q -u origin ${OPEN}` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({
			job_id: OPEN, kind: "ship", status: "done", summary: "Bumped x.", branch: OPEN,
			head_sha: treehouseHead(home.path),
		}) }] },
	]);
	agentDir.writeModels(provider);
	const dispatched = await post.dispatch({ jobId: OPEN, task: "Bump x to 2 in src/app.ts.", model, fetch: false });
	assert.equal(dispatched.state, "dispatched");
	const brief = readFileSync(join(home.path, paths.briefFile(OPEN)), "utf8");
	assert.doesNotMatch(brief, /legacy-x|item-1|tracker/i, "no lookup of the legacy link reaches the brief");
	await waitFor(() => readFleet(home.path).jobs.find((job) => job.job_id === OPEN), (job) => job?.phase === "held", { timeoutMs: 60_000, what: "the envelope" });
	assert.equal(reported.at(-1)?.next, "teardown");
	assert.equal((await post.tearDown(OPEN)).torn_down, true);
	await ledger.close(OPEN, "landed on origin");
	const landed = await ledger.show(OPEN);
	assert.deepEqual([landed.status, landed.tracker, landed.external_ref], ["closed", LINK, OPAQUE]);

	const reopened = await ledger.update(DEFERRED, { status: "open" });
	assert.deepEqual([reopened.status, reopened.tracker?.item_id, reopened.external_ref], ["open", "item-2", PINNED]);

	for (const [file, body] of Object.entries(retired)) assert.equal(readFileSync(join(home.path, file), "utf8"), body, `${file} untouched`);
	assert.throws(() => readFileSync(calls, "utf8"), /ENOENT/, "no external_ref was ever executed");
	assert.equal(provider.remaining("retired-ship"), 0);
});

/** HEAD of the job's own worktree, read when the report step is served. */
function treehouseHead(home: string): string {
	const worktree = readFleet(home).jobs.find((job) => job.job_id === OPEN)?.worktree;
	assert.ok(worktree, "no worktree recorded");
	return git(worktree, "rev-parse", "HEAD").trim();
}
