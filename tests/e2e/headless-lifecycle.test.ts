/**
 * cur.5.1: parent under `pi --mode rpc` — CI watch and deferred-row release
 * with no TUI; a mid-turn wake-up is queued, never dropped.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import {
	DEFAULT_ORIGIN,
	DiffVerdictSchema,
	EMPTY_USAGE,
	isoTimestamp,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	validate,
	validatePendingReview,
	type DiffVerdict,
	type FleetRecord,
} from "../../src/contracts.ts";
import { CiWatchStore } from "../../src/ci-watch.ts";
import { formatContinuationNotice } from "../../src/held-continuation.ts";
import { listPendingReviews } from "../../src/review-runs.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { readPendingSends } from "../../src/viewer/control-pending.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { FleetStore } from "../../src/fleet.ts";
import { createMergeAskProbe } from "../../src/merge-ask.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import {
	COMMAND_POST_EXTENSION,
	CP_BRIDGE_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	startPiChild,
	startRpc,
	waitFor,
} from "../harness/index.ts";

const JOB = "cp-held";
const PR = "https://github.com/example/demo/pull/58";

function writeReviewPass(home: string, headSha: string): void {
	const verdict = {
		schema_version: SCHEMA_VERSION,
		job_id: JOB,
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff does what the brief asked"],
		decided_at: "2026-09-05T10:30:21Z",
		head_sha: headSha,
		diff_stat: { files: 1, truncated: false },
	};
	const checked = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	const file = join(home, paths.reviewFile(JOB, 1));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(verdict)}\n`);
}

/** `prView` answers `gh pr view` (open, clean) so the continuation reaches its review step; every call is logged. */
function writeFakeGh(bin: string, headFile: string, stateFile: string, logFile: string, prView: boolean): void {
	mkdirSync(bin, { recursive: true });
	const gh = join(bin, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("fs");
const head = readFileSync(${JSON.stringify(headFile)}, "utf8").trim();
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
if (args[0] === "api" && (args[1] || "").includes("/actions/runs?head_sha=")) {
  const state = readFileSync(${JSON.stringify(stateFile)}, "utf8").trim();
  const run = state === "green"
    ? { id: 7, run_attempt: 1, conclusion: "success", status: "completed", head_sha: head, name: "ci" }
    : { id: 7, run_attempt: 1, conclusion: null, status: "in_progress", head_sha: head, name: "ci" };
  process.stdout.write(JSON.stringify({ total_count: args[1].includes(head) ? 1 : 0, workflow_runs: args[1].includes(head) ? [run] : [] }));
  process.exit(0);
}
if (args[0] === "api" && (args[1] || "").includes("/actions/runs/7/attempts/1/jobs?")) {
  process.stdout.write(JSON.stringify({ total_count: 0, jobs: [] }));
  process.exit(0);
}
if (${prView} && args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: 58, url: ${JSON.stringify(PR)}, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    headRefName: "cp-held", headRefOid: head, baseRefName: "main", isDraft: false, autoMergeRequest: null,
  }));
  process.exit(0);
}
if (args[0] === "api") {
  process.stdout.write(JSON.stringify({
    number: 58,
    html_url: ${JSON.stringify(PR)},
    state: "open",
    merged: false,
    head: { sha: head, ref: "cp-held" },
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`,
	);
	chmodSync(gh, 0o755);
}

/** An in-flight attempt-1 review of `headSha` whose reviewer (this test process) is alive, so no sweep reaps it. */
function writeReviewPending(home: string, headSha: string): void {
	const pending = {
		schema_version: SCHEMA_VERSION,
		job_id: JOB,
		surface: "review",
		attempt: 1,
		model: "mock/mock-model",
		pid: process.pid,
		started_at: isoTimestamp(),
		deadline: isoTimestamp(new Date(Date.now() + 3_600_000)),
		handed_back: true,
		subject: { head_sha: headSha, branch: JOB, files: 1, truncated: false },
	};
	const checked = validatePendingReview(pending);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	const file = join(home, paths.pendingReviewFile(JOB, "review", 1));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(pending)}\n`);
}

async function seedHeldHome(options: { ciState: "green" | "in_progress"; review?: "pass" | "pending" }) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	repo.git("checkout", "-b", "cp-held");
	repo.write("held.txt", "held\n");
	const headSha = repo.commitAll("held work");
	repo.git("push", "--quiet", "-u", "origin", "cp-held");

	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote!, delivery: "pr" });
	const clone = join(home.path, LAYOUT.projects, "demo");
	execFileSync("git", ["clone", "--quiet", repo.remote!, clone]);

	const fleet = new FleetStore({ home: home.path });
	const record: FleetRecord = {
		job_id: JOB,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		worker: {
			pid: process.pid,
			session_id: "sess-held",
			session_file: "/nonexistent/sess-held.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree: "/tmp/worktrees/demo-held",
		branch: JOB,
		dispatched_at: isoTimestamp(),
		reported_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		receipts: [{ kind: "pr", status: "open", title: "PR for cp-held", url: PR }],
	};
	await fleet.add(record);
	if (options.review === "pending") {
		writeReviewPending(home.path, headSha);
		// The seeded worker is an unreachable orphan to the child; its restart notice was already relayed.
		const outbox = new DurableWakeupOutbox({ home: home.path });
		outbox.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "RESTART RECOVERY — relayed by the previous parent", keys: [JOB] });
		outbox.confirmDelivered([`recovery:${JOB}`]);
	} else writeReviewPass(home.path, headSha);

	const store = new AwaitingStore({
		home: home.path,
		mergeAsk: createMergeAskProbe({
			head: async () => ({ sha: headSha }),
			runs: async () =>
				options.ciState === "green"
					? [{ status: "completed", conclusion: "success", headSha, workflowName: "ci" }]
					: [{ status: "in_progress", conclusion: null, headSha, workflowName: "ci" }],
			reviewedHeads: () => [headSha],
		}),
	});
	const declared = await store.declareGated({
		type: "approval",
		decision: "Ship cp-held (PR 58), drop it, or open a follow-up?",
		why: "the change is verified",
		blocks: "cp-held delivery",
		job_id: JOB,
	});

	const bin = join(home.path, "bin");
	const stateFile = join(home.path, "gh-state");
	const headFile = join(home.path, "gh-head");
	const ghLog = join(home.path, "gh-calls.log");
	writeFileSync(stateFile, `${options.ciState}\n`);
	writeFileSync(headFile, `${headSha}\n`);
	writeFileSync(ghLog, "");
	writeFakeGh(bin, headFile, stateFile, ghLog, options.review === "pending");

	return { home, repo, headSha, declared, bin, stateFile, headFile, ghLog };
}

test("/doctor under rpc names the mode and running timers", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});
	rpc.send({ id: "doc", type: "prompt", message: "/doctor" });
	const notify = await rpc.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			r.message.includes("session: rpc"),
		60_000,
	);
	assert.match(String(notify.message), /headless/);
	assert.match(String(notify.message), /ci-watch on/);
});

test(
	"rpc: CI green on a held PR wakes the parent and opens the deferred merge row",
	{ timeout: 120_000 },
	async (t) => {
		const held = await seedHeldHome({ ciState: "in_progress" });
		t.after(() => {
			held.home.cleanup();
			held.repo.cleanup();
		});
		assert.equal(held.declared.item.state, "deferred");

		const provider = await MockProvider.start();
		const model = provider.addScript("headless-ci", [{ kind: "text", text: "acknowledged" }], {
			onExhausted: "repeat",
		});
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: held.home.path,
			model,
			env: {
				...agentDir.env,
				CP_HOME: held.home.path,
				PATH: `${held.bin}:${process.env.PATH ?? ""}`,
				CP_CI_WATCH_SECONDS: "1",
			},
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
		});

		writeFileSync(held.stateFile, "green\n");
		const notice = await child.waitFor(
			(r) =>
				r.type === "extension_ui_request" &&
				r.method === "notify" &&
				typeof r.message === "string" &&
				(r.message.includes("CI/PR OBSERVED") || r.message.includes("decision is now ready")),
			90_000,
		);
		assert.match(String(notice.message), /cp-held|CI\/PR OBSERVED|now ready/);

		await waitFor(
			() => new AwaitingStore({ home: held.home.path }).list("open"),
			(open) => open.some((item) => item.job_id === JOB),
			{ timeoutMs: 30_000, what: "deferred merge row to open" },
		);
	},
);

test("rpc: a wake-up arriving mid-turn is delivered after the turn", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});

	const provider = await MockProvider.start();
	const model = provider.addScript(
		"headless-midturn",
		[
			{ kind: "hang", ms: 4000 },
			{ kind: "text", text: "first turn done" },
		],
		{ onExhausted: "repeat" },
	);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: held.home.path,
		model,
		env: {
			...agentDir.env,
			CP_HOME: held.home.path,
			PATH: `${held.bin}:${process.env.PATH ?? ""}`,
			CP_CI_WATCH_SECONDS: "1",
		},
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
	});

	child.send({ id: "cmds", type: "get_commands" });
	await child.waitFor((r) => r.type === "response" && r.id === "cmds", 30_000);

	const first = child.prompt("hold the floor");
	await child.waitFor((r) => r.type === "message_start", 30_000);
	writeFileSync(held.stateFile, "green\n");
	const notice = await child.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			r.message.includes("CI/PR OBSERVED"),
		30_000,
	);
	assert.match(String(notice.message), /CI\/PR OBSERVED/);
	const firstResponse = await first;
	assert.equal(firstResponse.success, true);
	await child.waitFor((r) => r.type === "agent_settled", 30_000);
	const settledAfterFirst = child.eventsOfType("agent_settled").length;
	await waitFor(
		() => provider.requests("headless-midturn").length,
		(n) => n >= 2,
		{ timeoutMs: 60_000, what: "queued wake-up turn after the in-flight one" },
	);
	assert.ok(
		child.eventsOfType("agent_settled").length >= settledAfterFirst,
		"wake-up must not drop the in-flight turn",
	);
});

type Held = Awaited<ReturnType<typeof seedHeldHome>>;

/** One headless parent on `held`'s home; `turns()` counts its model requests, i.e. parent turns. */
async function startParent(t: { after(fn: () => unknown): void }, held: Held, script: string) {
	const provider = await MockProvider.start();
	const model = provider.addScript(script, [{ kind: "text", text: "acknowledged" }], { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: held.home.path,
		model,
		env: { ...agentDir.env, CP_HOME: held.home.path, PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1" },
		extensions: [COMMAND_POST_EXTENSION],
	});
	let closed: Promise<void> | undefined;
	const close = () => (closed ??= (async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
	})());
	t.after(close);
	return { child, close, turns: () => provider.requests(script).length, requestText: () => JSON.stringify(provider.requests(script).map((r) => r.body.messages)) };
}

function wakeRuleEvents(home: string, rule: "ci_green" | "held_stop_resolve"): Record<string, unknown>[] {
	let events;
	try {
		events = readRunEvents(home, JOB);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return events.map((event) => event.payload as Record<string, unknown>).filter((payload) => payload?.wake_rule === rule);
}

const ghCalls = (held: Held, needle: string): number => readFileSync(held.ghLog, "utf8").split("\n").filter((line) => line.includes(needle)).length;

/** A quiet window that ends on watch evidence, not a clock: `n` more CI queries ran after this call. */
async function ciTicks(held: Held, n: number): Promise<void> {
	const before = ghCalls(held, "/actions/runs?");
	await waitFor(() => ghCalls(held, "/actions/runs?"), (calls) => calls >= before + n, { timeoutMs: 60_000, what: `${n} more CI watch ticks` });
}

function notified(child: Awaited<ReturnType<typeof startParent>>["child"], pattern: RegExp) {
	return child.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && typeof r.message === "string" && pattern.test(r.message), 90_000);
}

/**
 * E2E A, ci_green: the watch's real onObserved -> continuation sees the attempt already in flight
 * (review_pending), so the green fact is relayed with no parent turn, journaled once, and repeated ticks, a
 * restart on the persisted home and a moved head repeat no review, merge or wake (36d0c03, 05f1581, 534cd14).
 */
test("rpc: one CI-green key whose review is in flight is relayed without a parent turn; ticks, restart and a moved head repeat nothing", { timeout: 300_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "green", review: "pending" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});
	const first = await startParent(t, held, "headless-green");
	const relay = await notified(first.child, /CI GREEN — .* handled in code, no parent turn\./);
	assert.match(String(relay.message), /cp-held/);
	assert.match(String(relay.message), /pull\/58/);
	await waitFor(() => wakeRuleEvents(held.home.path, "ci_green"), (events) => events.length > 0, { timeoutMs: 30_000, what: "the ci_green journal line" });
	await ciTicks(held, 3);
	const journal = wakeRuleEvents(held.home.path, "ci_green");
	assert.deepEqual(journal.map((e) => [e.decision, e.action, e.next_kind]), [["suppressed", "review_pending", "no_mandate"]], "one key, one ruling");
	assert.equal(first.turns(), 0, `no parent turn for a fact code already handled: ${first.requestText().slice(-2000)}`);
	assert.deepEqual(listPendingReviews(held.home.path, JOB).map((p) => p.attempt), [1], "the in-flight review is awaited, never a second one");
	assert.equal(ghCalls(held, "pr merge"), 0);
	await first.close();

	// Restart on the persisted home, with the head moved and CI not yet green on it.
	held.repo.write("held.txt", "moved\n");
	const moved = held.repo.commitAll("moved head");
	held.repo.git("push", "--quiet", "origin", "cp-held");
	writeFileSync(held.headFile, `${moved}\n`);
	writeFileSync(held.stateFile, "in_progress\n");
	const second = await startParent(t, held, "headless-green-restart");
	await ciTicks(held, 3);
	assert.equal(second.turns(), 0, "the confirmed green key for the old head never wakes the restarted parent");
	assert.equal(wakeRuleEvents(held.home.path, "ci_green").length, 1);
	assert.deepEqual(listPendingReviews(held.home.path, JOB).map((p) => p.attempt), [1]);
	assert.equal(ghCalls(held, "pr merge"), 0, "no merge on the old head's green");
	assert.equal(new FleetStore({ home: held.home.path }).list().length, 1);
});

/**
 * E2E B, amendment 1: the parent restarts on the persisted home with the SAME head and CI still green. The
 * confirmed key is replayed by no tick: no second review, wake, relay or merge, and one ci_green journal line.
 */
test("rpc: a restart on the same green head replays nothing for the confirmed ci_green key", { timeout: 300_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "green", review: "pending" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});
	const first = await startParent(t, held, "headless-same-head");
	await notified(first.child, /CI GREEN — .* handled in code, no parent turn\./);
	await waitFor(() => wakeRuleEvents(held.home.path, "ci_green"), (events) => events.length > 0, { timeoutMs: 30_000, what: "the ci_green journal line" });
	const confirmed = await waitFor(() => [...new CiWatchStore({ home: held.home.path }).announced(JOB)], (keys) => keys.length > 0, { timeoutMs: 30_000, what: "the green key to be confirmed" });
	await first.close();

	const observed = () => readRunEvents(held.home.path, JOB).filter((event) => event.type === "ci_observed").length;
	assert.equal(observed(), 1);
	const reads = ghCalls(held, "pulls/58");
	const second = await startParent(t, held, "headless-same-head-restart");
	// Two PR reads by the restarted watch: its first pass over the persisted green head has finished.
	await waitFor(() => ghCalls(held, "pulls/58"), (n) => n >= reads + 2, { timeoutMs: 90_000, what: "two watch passes after the restart" });
	await ciTicks(held, 1);
	assert.deepEqual(wakeRuleEvents(held.home.path, "ci_green").map((e) => [e.decision, e.action]), [["suppressed", "review_pending"]], "exactly one ci_green entry");
	assert.equal(observed(), 1, "the confirmed key is never re-observed");
	const ciNotices = second.child.records().filter((r) => r.type === "extension_ui_request" && r.method === "notify" && /CI GREEN|CI\/PR OBSERVED/.test(String(r.message)));
	assert.deepEqual(ciNotices, [], "the replayed green fact is neither relayed nor announced");
	assert.equal(second.turns(), 0, `no parent turn for the confirmed key: ${second.requestText().slice(-2000)}`);
	assert.deepEqual(listPendingReviews(held.home.path, JOB).map((p) => p.attempt), [1], "no second review");
	assert.equal(ghCalls(held, "pr merge"), 0);
	assert.deepEqual([...new CiWatchStore({ home: held.home.path }).announced(JOB)], confirmed, "the same key, still confirmed");
});

test("rpc: with the wake-rules switch off, the same CI-green fact wakes the parent and journals why", { timeout: 180_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "green", review: "pending" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});
	mkdirSync(join(held.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}\n');
	const parent = await startParent(t, held, "headless-green-off");
	await notified(parent.child, /CI\/PR OBSERVED/);
	await waitFor(() => parent.turns(), (n) => n >= 1, { timeoutMs: 60_000, what: "the parent turn the switch restores" });
	assert.deepEqual(wakeRuleEvents(held.home.path, "ci_green").map((e) => [e.decision, e.reason]), [["woke", "kill switch"]]);
});

/** The durable notice HeldContinuation writes for a stop, carried across a restart (a real resolve needs a live worker). */
function carryStop(held: Held, next: "resolve" | "surface"): string {
	const id = `continuation:${JOB}:1:${held.headSha.slice(0, 12)}:ci:${next}`;
	const queued = new DurableWakeupOutbox({ home: held.home.path }).enqueue({
		id,
		kind: "recovery",
		job_id: JOB,
		keys: [JOB],
		content: formatContinuationNotice(JOB, next, `${JOB}: CI failed on ${held.headSha.slice(0, 12)}; implementer promoted (receipt delivered)`, PR),
	});
	assert.equal(queued, true);
	return id;
}

/**
 * E2E A, held_stop_resolve: a carried `next: resolve` stop is relayed once with no parent turn and the repair
 * stays on the same job; a `surface` stop, or the switch off, still wakes the parent (e83a1a8).
 */
test("rpc: a carried resolve stop is relayed once without a parent turn; the repair stays the same job", { timeout: 180_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});
	const id = carryStop(held, "resolve");
	const parent = await startParent(t, held, "headless-resolve");
	await notified(parent.child, /HELD PR STOPPED — cp-held \(continuation, next: resolve\)/);
	await waitFor(() => wakeRuleEvents(held.home.path, "held_stop_resolve"), (events) => events.length > 0, { timeoutMs: 30_000, what: "the resolve journal line" });
	await ciTicks(held, 3);
	assert.deepEqual(wakeRuleEvents(held.home.path, "held_stop_resolve").map((e) => [e.decision, e.next_kind]), [["relayed", "no_mandate"]]);
	assert.equal(parent.turns(), 0, `a stop code already acted on is not a parent turn: ${parent.requestText().slice(-2000)}`);
	assert.equal(new DurableWakeupOutbox({ home: held.home.path }).pending().some((entry) => entry.id === id), false, "delivered, so never replayed");
	const fleet = new FleetStore({ home: held.home.path }).list();
	assert.deepEqual(fleet.map((record) => [record.job_id, record.supersessions ?? 0]), [[JOB, 0]], "no second job, no supersession");
});

test("rpc: a surface stop, and a resolve stop with the switch off, still wake the parent", { timeout: 240_000 }, async (t) => {
	for (const [next, switchOff] of [["surface", false], ["resolve", true]] as const) {
		const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
		t.after(() => {
			held.home.cleanup();
			held.repo.cleanup();
		});
		if (switchOff) {
			mkdirSync(join(held.home.path, LAYOUT.data), { recursive: true });
			writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}\n');
		}
		carryStop(held, next);
		const parent = await startParent(t, held, `headless-${next}-${switchOff ? "off" : "on"}`);
		await waitFor(() => parent.turns(), (n) => n >= 1, { timeoutMs: 60_000, what: `the parent turn for a ${next} stop` });
		assert.match(parent.requestText(), new RegExp(`next: ${next}`));
		assert.deepEqual(wakeRuleEvents(held.home.path, "held_stop_resolve"), [], "no relay was decided");
		await parent.close();
	}
});

/** Test-only extension: drops the first N dashboard handoffs at pi's input stage, as a refused prompt is lost. */
const DASHBOARD_DROP = `import { appendFileSync } from "node:fs";
export default function (pi) {
	let left = Number(process.env.CP_TEST_DASHBOARD_DROPS ?? "0");
	pi.on("input", (event) => {
		if (event.source !== "extension" || !event.text.includes("[cp-dashboard ") || left <= 0) return { action: "continue" };
		left -= 1;
		appendFileSync(process.env.CP_TEST_DASHBOARD_DROP_LOG, "dropped\\n");
		return { action: "handled" };
	});
}
`;
const COMPACT_INSTRUCTIONS =
	"Operator delegated cp-b7m6 under the standing mandate. The draft PR awaits review on its pushed head; no merge is authorized yet. " +
	"Preserve the open decision, held work and next review step. Latest handoff: /home/ubuntu/reports/handoffs/operator.md.";

/**
 * A real bridge under rpc self-compacts while a dashboard message is queued during the turn before it. The
 * message is held through the compaction and handed after it; `drops` of those handoffs are lost at pi's input.
 */
async function queuedThroughCompaction(t: { after(fn: () => unknown): void }, script: string, drops: number) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const settings = join(home.path, LAYOUT.data, "operator.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
	const dropper = join(home.path, "dashboard-drop.ts");
	const dropLog = join(home.path, "dashboard-drops.log");
	writeFileSync(dropper, DASHBOARD_DROP);
	writeFileSync(dropLog, "");
	const provider = await MockProvider.start();
	const model = provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions: COMPACT_INSTRUCTIONS } }] },
		{ kind: "hang", ms: 3000 }, // the tool-result reply: the turn the dashboard message is queued behind
		{ kind: "text", text: "acknowledged" },
	], { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const rpc = startRpc({
		cwd: home.path,
		env: { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi", CP_TEST_DASHBOARD_DROPS: String(drops), CP_TEST_DASHBOARD_DROP_LOG: dropLog },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "-e", dropper, "--no-session", "--no-context-files", "--model", model],
	});
	t.after(async () => {
		await rpc.close();
		agentDir.cleanup();
		await provider.stop();
	});
	const stateDir = join(home.path, LAYOUT.state);
	const record = await waitFor(() => readControlRecord(stateDir), (r) => r.state === "ok", { timeoutMs: 30_000, what: "dashboard control to listen" });
	const control = (record as { record: Parameters<typeof controlRequest>[0] }).record;

	rpc.send({ type: "prompt", id: "run", message: "Queue compaction, then finish your reply." });
	await waitFor(() => provider.requests(script).length, (n) => n >= 2, { timeoutMs: 30_000, what: "the reply turn to be in flight" });
	// self_compact already queued under the 1-token trigger; raised before the reply turn settles, no later settle
	// can ask for a second compaction.
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
	const sent = await controlRequest(control, "send", { kind: "message", text: "list the validator owner wallets" });
	assert.ok(sent.ok && (sent.result as { state: string }).state === "queued", JSON.stringify(sent));
	const id = (sent.result as { id: string }).id;
	await rpc.waitFor((r) => r.type === "extension_ui_request" && r.message === "self_compact completed", 60_000);

	const journal = () => {
		const file = controlJournalFile(stateDir);
		const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
		return lines.filter((line) => line.id === id && line.type !== "edited");
	};
	const states = () => journal().map((line) => (line.type === "outcome" ? line.state : line.type));
	const dropped = () => readFileSync(dropLog, "utf8").split("\n").filter(Boolean).length;
	const marker = `[cp-dashboard ${id} `;
	const consumed = () => rpc.records().filter((r) => r.type === "message_end" && (r.message as { role?: string })?.role === "user" && JSON.stringify(r.message).includes(marker));
	let nudges = 0;
	/** One ordinary turn: its settle is where the bridge looks for a handoff pi never showed. */
	const nudge = async () => {
		const request = `nudge-${++nudges}`;
		rpc.send({ type: "prompt", id: request, message: `turn ${nudges}` });
		await rpc.waitFor((r) => r.type === "response" && r.id === request, 30_000);
		await waitFor(() => rpc.records().filter((r) => r.type === "agent_settled").length, (n) => n >= settledBefore + nudges, { timeoutMs: 30_000, what: `turn ${nudges} to settle` });
	};
	const settledBefore = rpc.records().filter((r) => r.type === "agent_settled").length;
	return { rpc, states, dropped, consumed, nudge, pending: () => readPendingSends(stateDir).sends.find((send) => send.id === id)?.state, journal };
}

/**
 * E2E B, compaction queue (7ff5861): the message queued during the turn before a self-compaction is handed only after
 * the compaction ends; that first handoff is dropped, the next settle re-hands it once, and pi consumes it once.
 */
test("rpc bridge: a message queued before a self-compaction is held through it and consumed once after one dropped handoff", { timeout: 180_000 }, async (t) => {
	const run = await queuedThroughCompaction(t, "dashboard-compact-once", 1);
	await waitFor(() => run.dropped(), (n) => n === 1, { timeoutMs: 30_000, what: "the first handoff after the compaction to be dropped" });
	assert.deepEqual(run.states(), ["request", "queued", "injected"]);
	assert.equal(run.consumed().length, 0);
	await run.nudge();
	await waitFor(() => run.states(), (s) => s.at(-1) === "delivered", { timeoutMs: 60_000, what: `delivery after the re-hand: ${JSON.stringify(run.states())}` });
	assert.deepEqual(run.states(), ["request", "queued", "injected", "injected", "delivered"]);
	assert.equal(run.journal()[3]?.reason, "re-handed: not seen in the session when the turn settled");
	// `delivered` is journaled at message_start; the user message_end reaches rpc stdout later.
	const consumed = await waitFor(() => run.consumed(), (c) => c.length >= 1, { timeoutMs: 30_000, what: "pi to consume the message" });
	assert.equal(consumed.length, 1, "pi consumed the message once");
	const records = run.rpc.records();
	assert.ok(records.findIndex((r) => r.type === "compaction_end") < records.indexOf(consumed[0]!), "held through the compaction");
	assert.equal(run.pending(), "delivered", "acknowledged to the dashboard");
	assert.equal(run.dropped(), 1);
});

test("rpc bridge: a queued message whose handoff is dropped twice ends failed, never re-injected again", { timeout: 180_000 }, async (t) => {
	const run = await queuedThroughCompaction(t, "dashboard-compact-twice", 2);
	await waitFor(() => run.dropped(), (n) => n === 1, { timeoutMs: 30_000, what: "the first handoff to be dropped" });
	await run.nudge();
	await waitFor(() => run.dropped(), (n) => n === 2, { timeoutMs: 30_000, what: "the re-handed message to be dropped" });
	assert.deepEqual(run.states(), ["request", "queued", "injected", "injected"]);
	await run.nudge();
	await waitFor(() => run.states(), (s) => s.at(-1) === "failed", { timeoutMs: 30_000, what: `the second loss to fail: ${JSON.stringify(run.states())}` });
	assert.equal(run.journal().at(-1)?.reason, "handed to the session twice, never seen in its transcript");
	assert.equal(run.pending(), "failed");
	await run.nudge();
	assert.deepEqual(run.states(), ["request", "queued", "injected", "injected", "failed"], "no third handoff");
	assert.equal(run.dropped(), 2);
	assert.equal(run.consumed().length, 0);
});
