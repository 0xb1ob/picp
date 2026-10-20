/**
 * Retired tracker integration on the mock provider: an existing home's inert job links, command-shaped refs and
 * malformed retired state survive startup and a native dispatch→report→teardown→close, with no external call.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import type { IntakeResult } from "../../src/intake.ts";
import { formatNext } from "../../src/next.ts";
import { nextFor } from "../../src/wake-rules.ts";
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
const BR_JOB = "cp-legacy-br";
const LINK = { connection_id: "legacy-x", item_id: "item-1", linked_at: AT };
const OPAQUE = "external-tool show item --json";
const PINNED = "external-tool --db '/legacy/item.db' show item-2 --json";
const BR_REF = "br --db '/legacy/.beads/beads.db' show item-4 --json";
const RETIRED_HINT = /cp_tracker|import-beads/;

function legacyJob(id: string, status: string, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		id, title: `legacy ${id}`, status, labels: ["project:demo", "kind:ship", "delivery:local"], blocked_by: [],
		comments: [{ at: AT, author: "legacy", text: "kept verbatim" }], created_at: AT, updated_at: AT, ...extra,
	};
}

/** Every shipped file that can carry a hint, message or tool description. */
function shippedSurface(): string[] {
	const files = ["AGENTS.md"];
	for (const dir of ["extensions", "src", "prompts", "profiles"]) {
		for (const name of readdirSync(join(REPO_ROOT, dir), { recursive: true }) as string[]) {
			if (/\.(ts|tsx|md|json)$/.test(name)) files.push(join(dir, name));
		}
	}
	return files;
}

test("retired integration: an existing home keeps its data and runs the native lifecycle with no external call", { skip: SKIP, timeout: 300_000 }, async (t) => {
	// Cleanup is registered before any setup that can throw, so PATH and scratch dirs never leak.
	const savedPath = process.env.PATH;
	const cleanups: Array<() => unknown> = [];
	t.after(async () => {
		process.env.PATH = savedPath;
		const errors: unknown[] = [];
		for (const cleanup of cleanups.reverse()) {
			try { await cleanup(); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, "retired-integration cleanup failed");
	});
	const home = createScratchHome();
	cleanups.push(() => home.cleanup());
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" } });
	cleanups.push(() => repo.cleanup());
	const provider = await MockProvider.start();
	cleanups.push(() => provider.stop());
	const agentDir = createAgentDir({ provider });
	cleanups.push(() => agentDir.cleanup());

	// A command-shaped ref must never run: fakes on PATH record any invocation.
	const bin = join(home.path, "fake-bin");
	const calls = join(home.path, "external-calls.log");
	const leak = join(home.path, "worker-db-env.log");
	mkdirSync(bin, { recursive: true });
	for (const tool of ["external-tool", "br"]) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\n`);
		chmodSync(join(bin, tool), 0o755);
	}
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;

	const retired: Record<string, string> = {
		[join(LAYOUT.data, "trackers.json")]: "{ retired, malformed connections",
		[join(LAYOUT.state, "tracker-sync.json")]: "[ malformed retired intents",
		[join(LAYOUT.state, "tracker-tasks", `${OPEN}.md`)]: "frozen task snapshot\n",
		[join(".beads", "beads.db")]: "legacy database bytes",
	};
	for (const [file, body] of Object.entries(retired)) {
		mkdirSync(join(home.path, file, ".."), { recursive: true });
		writeFileSync(join(home.path, file), body);
	}
	writeFileSync(join(home.path, LAYOUT.jobsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, prefix: "cp", jobs: [
		legacyJob(OPEN, "open", { external_ref: OPAQUE, tracker: LINK }),
		legacyJob(DEFERRED, "deferred", { external_ref: PINNED, tracker: { ...LINK, item_id: "item-2" } }),
		legacyJob(CLOSED, "closed", { external_ref: "external-tool show item-3 --json", tracker: { ...LINK, item_id: "item-3" }, closed_at: AT, close_reason: "done" }),
		legacyJob(BR_JOB, "open", { external_ref: BR_REF, tracker: { ...LINK, item_id: "item-4" } }),
	] }));

	const reported: IntakeResult[] = [];
	// A parent that still exports a retired database must not hand it to the worker.
	const dbEnv = { BEADS_DIR: join(home.path, ".beads"), BEADS_DB: join(home.path, ".beads", "beads.db") };
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env, ...dbEnv }, onReported: (result) => reported.push(result) });
	cleanups.push(() => post.shutdown());
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 2 });
	cleanups.push(() => pool.cleanup());
	cleanups.push(() => treehouse(clone, "prune"));

	// Native reads keep every legacy field; the deferred job stays deferred until an explicit native update.
	const ledger = post.ledger();
	const open = await ledger.show(OPEN);
	assert.deepEqual([open.tracker, open.external_ref, open.comments.length], [LINK, OPAQUE, 1]);
	assert.equal((await ledger.list({ all: true })).length, 4);
	assert.deepEqual((await ledger.ready()).map((job) => job.id).sort(), [BR_JOB, OPEN].sort());
	await assert.rejects(ledger.claim(DEFERRED, "operator"), /is deferred; review its task and authority, then use cp_job update status=open when authorized/);
	assert.equal((await ledger.show(DEFERRED)).status, "deferred");
	assert.doesNotMatch(formatNext(await nextFor(post)), /bead|tracker/i, "cp_next reads native jobs only");

	const model = provider.addScript("retired-ship", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `{ test -z "$BEADS_DIR" && test -z "$BEADS_DB"; } || echo leaked > '${leak}'; printf 'export const x = 2;\\n' > src/app.ts && git add -A && git commit -q -m 'bump x' && git push -q -u origin ${BR_JOB}` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({
			job_id: BR_JOB, kind: "ship", status: "done", summary: "Bumped x.", branch: BR_JOB,
			head_sha: treehouseHead(home.path, BR_JOB),
		}) }] },
	]);
	agentDir.writeModels(provider);
	// The task names the job's own id: no inferred issue lookup may follow from it.
	const dispatched = await post.dispatch({ jobId: BR_JOB, task: `Bump x to 2 in src/app.ts (${BR_JOB}).`, model, fetch: false });
	assert.equal(dispatched.state, "dispatched");
	const brief = readFileSync(join(home.path, paths.briefFile(BR_JOB)), "utf8");
	assert.doesNotMatch(brief, /legacy-x|item-4|tracker|BEADS_DIR|Referenced material/i, "no lookup of the legacy link or ref reaches the brief");
	assert.doesNotMatch(brief, RETIRED_HINT);
	await waitFor(() => readFleet(home.path).jobs.find((job) => job.job_id === BR_JOB), (job) => job?.phase === "held", { timeoutMs: 60_000, what: "the envelope" });
	assert.equal(reported.at(-1)?.next, "teardown");
	assert.doesNotMatch(JSON.stringify(reported), RETIRED_HINT);
	assert.equal((await post.tearDown(BR_JOB)).torn_down, true);
	await ledger.close(BR_JOB, "landed on origin");
	const landed = await ledger.show(BR_JOB);
	assert.deepEqual([landed.status, landed.tracker?.item_id, landed.external_ref], ["closed", "item-4", BR_REF]);
	assert.deepEqual(await ledger.show(OPEN), open, "an untouched legacy job reads back unchanged");

	const reopened = await ledger.update(DEFERRED, { status: "open" });
	assert.deepEqual([reopened.status, reopened.tracker?.item_id, reopened.external_ref], ["open", "item-2", PINNED]);

	for (const [file, body] of Object.entries(retired)) assert.equal(readFileSync(join(home.path, file), "utf8"), body, `${file} untouched`);
	assert.equal(existsSync(calls), false, "no external_ref was ever executed and br never ran");
	assert.equal(existsSync(leak), false, "the worker saw no retired database environment");
	assert.equal(provider.remaining("retired-ship"), 0);
	for (const file of shippedSurface()) assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf8"), RETIRED_HINT, `${file} names a retired surface`);
});

/** HEAD of the job's own worktree, read when the report step is served. */
function treehouseHead(home: string, jobId: string): string {
	const worktree = readFleet(home).jobs.find((job) => job.job_id === jobId)?.worktree;
	assert.ok(worktree, "no worktree recorded");
	return git(worktree, "rev-parse", "HEAD").trim();
}
