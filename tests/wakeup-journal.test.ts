/**
 * Durable wake-ups for silent stops (pi-command-post-autonomy-programme-cur.1.3).
 *
 * Worker death, hard-bound breach and restart-recovery must reach the parent
 * even across a restart, and a torn-down job must arrive stale.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DURABLE_WAKEUP_KINDS,
	EMPTY_USAGE,
	FAILURE_CLASSES,
	type Failure,
	type FailureClass,
	FAILURE_RECOVERABLE,
	isoTimestamp,
	LAYOUT,
	paths,
	STATE_WAKEUP_ANNOUNCEMENTS,
	type FleetRecord,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { BOUND_SPENT_PHRASE, boundWakeupId } from "../src/failure-announcer.ts";
import { CommandPost } from "../src/command-post.ts";
import {
	checkWakeup,
	FAILURE_CLASS_WAKEUP,
	formatDeathNotice,
	formatRecoveryNotice,
	STALE_WAKEUP_HEADLINE,
	WAKEUP_CUSTOM_TYPES,
	wakeupFacts,
	reviewWakeups,
} from "../src/wakeups.ts";
import type { WorkerProcess } from "../src/worker-process.ts";
import { boundedWakeupId, DurableWakeupOutbox } from "../src/wakeup-outbox.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const DOCS = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
const AGENTS = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

test("every announced transition names a wake-up kind, and the docs table lists it", () => {
	const kinds = new Set<string>(Object.keys(WAKEUP_CUSTOM_TYPES));
	const seen = new Set<string>();
	assert.ok(STATE_WAKEUP_ANNOUNCEMENTS.length > 0);
	for (const row of STATE_WAKEUP_ANNOUNCEMENTS) {
		assert.ok(row.event.length > 0, "event name missing");
		assert.ok(row.wakeup === "none" || kinds.has(row.wakeup), `${row.event} has unknown kind ${row.wakeup}`);
		assert.match(DOCS, new RegExp(`\\| \`${row.event}\``), `docs/contracts.md table misses ${row.event}`);
		if (row.wakeup !== "none") seen.add(row.wakeup);
	}
	for (const kind of kinds) {
		assert.ok(seen.has(kind), `wake-up kind ${kind} is never announced`);
	}
});

test("every failure class maps to a durable wake-up kind", () => {
	for (const cls of FAILURE_CLASSES) {
		const kind = FAILURE_CLASS_WAKEUP[cls as FailureClass];
		assert.ok((DURABLE_WAKEUP_KINDS as readonly string[]).includes(kind), `${cls} maps to non-durable ${kind}`);
		assert.notEqual(kind, "none");
	}
});

test("markFailed is only called from fleet.ts and the failure announcer", () => {
	const hits: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (readFileSync(path, "utf8").includes("markFailed(")) hits.push(path.slice(REPO_ROOT.length + 1));
		}
	};
	walk(join(REPO_ROOT, "src"));
	walk(join(REPO_ROOT, "extensions"));
	hits.sort();
	assert.deepEqual(hits, ["src/failure-announcer.ts", "src/fleet.ts"]);
});

test("a recovery id longer than 160 chars does not collapse distinct sets", () => {
	const a = boundedWakeupId(`recovery:${"cp-a,".repeat(40)}`);
	const b = boundedWakeupId(`recovery:${"cp-b,".repeat(40)}`);
	assert.ok(a.length <= 160);
	assert.ok(b.length <= 160);
	assert.notEqual(a, b);
});

test("AGENTS.md tells the parent to act on death and recovery wake-ups", () => {
	assert.match(AGENTS, /cp-death/);
	assert.match(AGENTS, /cp-recovery/);
	assert.match(AGENTS, /act on the wake-up/i);
	assert.doesNotMatch(AGENTS, /A worker that died: restart the parent to reconcile/);
});

test("a spent bound's wake-up phrase is unambiguous, and AGENTS.md names it (cur.4.4)", () => {
	// "not attempted — 0 attempt(s) left" reads as permission to hand-revive;
	// `BOUND_SPENT_PHRASE` names the actual truth instead — pin the code's own
	// constant against AGENTS.md's cp-bound bullet, not a copy of the string.
	assert.match(AGENTS, /bound spent/, "AGENTS.md's cp-bound bullet must name the exhausted phrase");
	assert.ok(BOUND_SPENT_PHRASE.includes("bound spent"));
	assert.doesNotMatch(BOUND_SPENT_PHRASE, /^not attempted/, "the exhausted phrase must never read as the ordinary 'not attempted' one");
	assert.match(
		DOCS,
		/one automatic attempt was already made and did not stick/,
		"docs/contracts.md must quote BOUND_SPENT_PHRASE's own wording, not a stale copy",
	);
});

test("no doc or notice claims a previewed attempt 'did not stick' (zh7.4)", () => {
	assert.doesNotMatch(DOCS, /attempted, did not stick/, "docs/contracts.md still quotes the preview-derived claim");
	assert.doesNotMatch(AGENTS, /attempted, did not stick/);
	assert.match(DOCS, /settleBound/, "docs/contracts.md must name the post-outcome bound announcement");
	assert.match(AGENTS, /cp-bound.{0,400}after (its|the) outcome/s, "AGENTS.md must say the cp-bound wake arrives after the outcome");
});

test("a bound or death notice replayed beside a live replacement is stale (zh7.4)", () => {
	for (const phase of ["waiting", "launching"] as const) {
		for (const kind of ["bound", "death"] as const) {
			const verdict = checkWakeup(
				{ kind, job_id: "cp-back", keys: ["wall_clock_exceeded"], issued_at: "2026-09-25T12:00:00Z" },
				{ job: () => ({ phase, generation: 1, alive: true }) },
			);
			assert.equal(verdict.state, "superseded", `${kind} while ${phase}`);
			assert.match(verdict.reason ?? "", /live worker again/);
		}
	}
	const failed = checkWakeup(
		{ kind: "bound", job_id: "cp-back", keys: ["wall_clock_exceeded"], issued_at: "2026-09-25T12:00:00Z" },
		{ job: () => ({ phase: "failed" as const, generation: 1, failure_class: "wall_clock_exceeded" }) },
	);
	assert.equal(failed.state, "fresh", "a still-failed job keeps its notice");
});

test("a durable outbox replays undelivered wake-ups once across a restart", () => {
	const home = createScratchHome();
	try {
		const first = new DurableWakeupOutbox({ home: home.path, owner: "parent-1" });
		assert.equal(
			first.enqueue({
				id: "death:cp-x:1",
				kind: "death",
				job_id: "cp-x",
				content: "WORKER DEATH — cp-x",
				keys: ["crash"],
			}),
			true,
		);
		assert.equal(first.enqueue({ id: "death:cp-x:1", kind: "death", job_id: "cp-x", content: "x", keys: ["crash"] }), false);

		const sent: string[] = [];
		first.drain((entry) => sent.push(entry.id));
		assert.deepEqual(sent, ["death:cp-x:1"]);
		assert.equal(first.pending().length, 1, "send is not delivery");

		const successor = new DurableWakeupOutbox({ home: home.path, owner: "parent-2" });
		const replayed: string[] = [];
		successor.drain((entry) => replayed.push(entry.id));
		assert.deepEqual(replayed, ["death:cp-x:1"], "undelivered wake-up is due for the new parent");
		successor.confirmDelivered(["death:cp-x:1"]);

		const third = new DurableWakeupOutbox({ home: home.path, owner: "parent-3" });
		assert.deepEqual(
			third.drain(() => assert.fail("delivered must not replay")),
			[],
		);
	} finally {
		home.cleanup();
	}
});

test("a death wake-up for a torn-down job is stale", () => {
	const facts = {
		job(jobId: string) {
			if (jobId === "cp-gone") return undefined;
			return {
				phase: "failed" as const,
				generation: 1,
				failure_class: "crash",
			};
		},
	};
	const live = checkWakeup(
		{ kind: "death", job_id: "cp-live", keys: ["crash"], issued_at: "2026-08-31T12:00:00Z" },
		facts,
	);
	assert.equal(live.state, "fresh");
	const torn = checkWakeup(
		{ kind: "death", job_id: "cp-gone", keys: ["crash"], issued_at: "2026-08-31T12:00:00Z" },
		facts,
	);
	assert.equal(torn.state, "superseded");
	const reviewed = reviewWakeups(
		[
			{
				role: "custom",
				customType: "cp-death",
				content: "WORKER DEATH — cp-gone",
				details: {
					cp_wakeup: { kind: "death", job_id: "cp-gone", keys: ["crash"], issued_at: "2026-08-31T12:00:00Z" },
				},
			},
		],
		facts,
	);
	assert.equal(reviewed.changed, true);
	assert.match(reviewed.messages[0]?.content as string, new RegExp(STALE_WAKEUP_HEADLINE));
});

test("a recovery wake-up is stale once every listed job is gone", () => {
	const facts = {
		job(jobId: string) {
			if (jobId === "cp-a") return { phase: "done" as const, generation: 1 };
			return undefined;
		},
	};
	const stale = checkWakeup(
		{ kind: "recovery", keys: ["cp-a", "cp-b"], issued_at: "2026-08-31T12:00:00Z" },
		facts,
	);
	assert.equal(stale.state, "superseded");
	const still = checkWakeup(
		{ kind: "recovery", keys: ["cp-a", "cp-live"], issued_at: "2026-08-31T12:00:00Z" },
		{
			job(jobId: string) {
				if (jobId === "cp-live") return { phase: "failed" as const, generation: 1, failure_class: "crash" };
				if (jobId === "cp-a") return { phase: "done" as const, generation: 1 };
				return undefined;
			},
		},
	);
	assert.equal(still.state, "fresh");
});

test("death and recovery notices name disk evidence and next tools, never a poll", () => {
	const death = formatDeathNotice("cp-x", { class: "crash", message: "pid 9 gone", at: isoTimestamp() }, {
		state: "dirty",
		files: ["src/app.ts"],
		file_count: 1,
		commits_ahead: 0,
		observed_at: isoTimestamp(),
	});
	assert.match(death, /cp-x/);
	assert.match(death, /crash/);
	assert.match(death, /on disk/i);
	assert.match(death, /cp_teardown/);
	assert.doesNotMatch(death, /poll/i);

	const recovery = formatRecoveryNotice([
		{ job_id: "cp-x", outcome: "failed", detail: "worker gone", resumable: false },
		{ job_id: "cp-y", outcome: "revivable", detail: "session survived", resumable: true },
	]);
	assert.match(recovery, /cp-x/);
	assert.match(recovery, /cp-y/);
	assert.match(recovery, /cp_revive/);
	assert.match(recovery, /cp_teardown/);
	assert.doesNotMatch(recovery, /poll/i);
});

test("reconcile journals one recovery wake-up and a second parent does not replay after confirm", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const session = join(home.path, "sess.jsonl");
	mkdirSync(home.path, { recursive: true });
	writeFileSync(session, "");
	const fleet = new FleetStore({ home: home.path });
	await fleet.add({
		job_id: "cp-dead",
		project: "demo",
		kind: "ship",
		delivery: "local",
		origin: "terminal",
		phase: "waiting",
		worker: {
			pid: 1,
			session_id: "s",
			session_file: "/no/such/session.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock",
			started_at: isoTimestamp(),
		},
		worktree: join(home.path, "wt"),
		branch: "cp-dead",
		dispatched_at: isoTimestamp(),
		usage: {
			input: 0,
			output: 0,
			cache_read: 0,
			cache_write: 0,
			total_tokens: 0,
			cost_usd: 0,
		},
	});

	const queued: string[] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		onDurableWakeup: () => queued.push("queued"),
	});
	t.after(() => post.shutdown());
	const { report } = await post.reconcile({ isPidAlive: () => false });
	assert.ok(report.entries.some((entry) => entry.job_id === "cp-dead" && entry.outcome === "failed"));
	assert.equal(queued.length, 1);

	const sent: string[] = [];
	post.drainDurableWakeups((entry) => {
		sent.push(entry.kind);
		assert.equal(entry.kind, "recovery");
		assert.match(entry.content, /cp-dead/);
	});
	assert.deepEqual(sent, ["recovery"]);
	const ids = post.durableWakeups.pending().map((entry) => entry.id);
	post.confirmDurableWakeups(ids);

	const again = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => again.shutdown());
	await again.reconcile({ isPidAlive: () => false });
	assert.deepEqual(
		again.drainDurableWakeups(() => assert.fail("confirmed recovery must not replay")),
		[],
	);
});

test("a reviewer finish with no safe cp-verdict journals one recovery notice that survives a restart", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const queued: string[] = [];
	const verdicts: unknown[] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		onDurableWakeup: () => queued.push("queued"),
		sendWakeup: (wakeup) => (verdicts.push(wakeup), true),
	});
	t.after(() => post.shutdown());
	// Partial finish: the decision is written, then something after it throws.
	const key = post.reviewRuns.start<{ operational?: string }>({
		jobId: "cp-held",
		surface: "review",
		attempt: 3,
		model: "mock/reviewer",
		deadline: isoTimestamp(),
		wait: async () => ({}),
		finish: async () => {
			const file = join(home.path, paths.reviewFile("cp-held", 3));
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, "{}");
			throw new Error("run log unwritable");
		},
	}).key;
	post.reviewRuns.handBack(key);
	await post.reviewRuns.settled(key);
	assert.equal(queued.length, 1);
	assert.equal(verdicts.length, 0, "no cp-verdict without a safe decision");

	// A new parent, same home: the notice is still owed, exactly once.
	const again = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => again.shutdown());
	const drained = again.drainDurableWakeups(() => {});
	assert.equal(drained.length, 1);
	const entry = drained[0];
	assert.equal(entry?.kind, "recovery");
	assert.equal(entry?.job_id, "cp-held");
	assert.deepEqual(entry?.keys, ["cp-held"]);
	assert.match(entry?.id ?? "", /^review-finish:cp-held:review:3:/, "one notice per reviewer run");
	assert.match(entry?.content ?? "", /cp-held review attempt 3/);
	assert.match(entry?.content ?? "", /run log unwritable; a decision was already written/);
	assert.match(entry?.content ?? "", /cp_review cp-held action:status/);
	assert.match(entry?.content ?? "", /never merge on this notice/);
	assert.doesNotMatch(entry?.content ?? "", /poll/i);
	again.confirmDurableWakeups([entry?.id as string]);
	assert.deepEqual(again.drainDurableWakeups(() => assert.fail("confirmed notice must not replay")), []);
});

test("LAYOUT names the durable wake-up file under state/", () => {
	assert.equal(LAYOUT.wakeupsFile, ".pi-command-post/state/wakeups.json");
});

function waitingRecord(home: string, jobId: string): FleetRecord {
	return {
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "local",
		origin: "terminal",
		phase: "waiting",
		worker: {
			pid: 1,
			session_id: "s",
			session_file: join(home, "no-session.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock",
			started_at: isoTimestamp(),
		},
		worktree: join(home, "missing-wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
}

/**
 * Event-driven: every durable wake-up goes through `#journalDurable`, which
 * calls `onDurableWakeup` after it is on disk, so `pred` is re-checked exactly
 * when the journal changes. The 5 s poll this replaced failed CI (#217, #219)
 * on a loaded runner; the 30 s bound (H7 floor is 5 s) only turns a regression
 * into a named failure instead of a hang.
 */
function journalWatch(): {
	onDurableWakeup: () => void;
	until: (pred: () => boolean, what: string, timeoutMs?: number) => Promise<void>;
} {
	let wake: (() => void) | undefined;
	return {
		onDurableWakeup: () => wake?.(),
		async until(pred, what, timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			while (!pred()) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
		},
	};
}

test("intake envelope_invalid journals exactly one death wake-up", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(waitingRecord(home.path, "cp-bad-env"));
	mkdirSync(join(home.path, paths.runDir("cp-bad-env")), { recursive: true });
	writeFileSync(join(home.path, paths.runDir("cp-bad-env"), "envelope-rejected.json"), "{}");
	const queued: string[] = [];
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		onDurableWakeup: () => queued.push("queued"),
	});
	t.after(() => post.shutdown());
	const result = await post.intake.intake("cp-bad-env");
	assert.equal(result.phase, "failed");
	assert.equal(result.failure?.class, "envelope_invalid");
	assert.equal(queued.length, 1);
	assert.equal(post.durableWakeups.pending().length, 1);
	assert.equal(post.durableWakeups.pending()[0]?.kind, "death");
	assert.deepEqual(post.durableWakeups.pending()[0]?.keys, ["envelope_invalid"]);
	const again = await post.intake.intake("cp-bad-env");
	assert.equal(again.failure, undefined);
	assert.equal(post.durableWakeups.pending().length, 1);
});

test("every failure class survives parent death as exactly one delivered wake-up", async (t) => {
	for (const cls of FAILURE_CLASSES) {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		const jobId = `cp-${cls}`;
		const fleet = new FleetStore({ home: home.path });
		await fleet.add(waitingRecord(home.path, jobId));
		const failure: Failure = { class: cls, message: `${cls} forced`, at: isoTimestamp() };
		const post = new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			holdsParentLock: () => true,
		});
		await post.fail(jobId, failure);
		assert.equal(post.fleet.require(jobId).phase, "failed", cls);
		assert.equal(post.durableWakeups.pending().length, 1, cls);
		await post.shutdown();

		const next = new CommandPost({
			home: home.path,
			packageRoot: REPO_ROOT,
			holdsParentLock: () => true,
		});
		t.after(() => next.shutdown());
		await next.reconcile({ isPidAlive: () => false });
		const delivered = next.drainDurableWakeups((entry) => {
			assert.equal(entry.job_id, jobId, cls);
			assert.equal(entry.keys?.[0], cls);
			assert.ok((DURABLE_WAKEUP_KINDS as readonly string[]).includes(entry.kind), cls);
		});
		assert.equal(delivered.length, 1, cls);
		assert.deepEqual(next.confirmDurableWakeups(delivered.map((entry) => entry.id)), [delivered[0]?.id]);
		assert.equal(next.durableWakeups.read().delivered.length, 1, cls);
		assert.equal(next.durableWakeups.pending().length, 0, cls);
	}
});

test("a close or bound breach during parent shutdown is the parent's own stop: no failure, no recovery spent, no wake-up", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true });
	t.after(() => post.shutdown());
	await fleet.add(waitingRecord(home.path, "cp-stopping"));
	const run = post.runs.open("cp-stopping");
	run.cp("spawned", {});
	run.cp("process_exit", { code: 2 });
	const listeners: Array<(event: { type: string }) => void> = [];
	const worker = {
		onEvent(cb: (event: { type: string }) => void) {
			listeners.push(cb);
			return () => {};
		},
		closed: new Promise(() => {}),
	} as unknown as WorkerProcess;
	post.bounds.watch("cp-stopping", worker, { wall_clock_seconds: 3600, tool_call_cap: 1 });

	await post.shutdown();
	assert.equal(await post.failures.evaluate("cp-stopping"), undefined, "the same log outside shutdown is spawn_failed");
	listeners[0]?.({ type: "tool_execution_start" });
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(new FleetStore({ home: home.path }).require("cp-stopping").phase, "waiting", "the next parent's reconcile judges it");
	assert.deepEqual(post.durableWakeups.pending(), [], "no false death or bound wake-up");
	assert.equal(existsSync(join(home.path, paths.recoveryAttemptsFile("cp-stopping"))), false, "its one automatic recovery is intact");
});

test("every class that stays failed is woken by its emitter", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const unreported: string[] = [];
	const journal = journalWatch();
	const until = journal.until;
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		onDurableWakeup: journal.onDurableWakeup,
		onUnreportedSettle: (_jobId, outcome) => {
			if (outcome.action !== "recorded") return;
			unreported.push(outcome.failure?.class ?? "settled_without_report");
		},
	});
	t.after(() => post.shutdown());
	const exercised = new Set<string>();

	const death = async (jobId: string, write: (jobId: string) => void, cls: string): Promise<void> => {
		await fleet.add(waitingRecord(home.path, jobId));
		write(jobId);
		const failure = await post.failures.evaluate(jobId);
		assert.equal(failure?.class, cls);
		await until(
			() => post.durableWakeups.pending().some((entry) => entry.kind === "death" && entry.keys?.includes(cls)),
			`${cls} death wake-up`,
		);
		exercised.add("worker_death");
		exercised.add(cls);
	};

	await death("cp-spawn", (jobId) => {
		const run = post.runs.open(jobId);
		run.cp("spawned", {});
		run.cp("process_exit", { code: 2 });
	}, "spawn_failed");
	await death("cp-budget", (jobId) => {
		post.runs.open(jobId).cp("budget_exceeded", { ratio: 1.2 });
	}, "budget_exceeded");
	await death("cp-loop", (jobId) => {
		const run = post.runs.open(jobId);
		for (let i = 0; i < 6; i++) run.record("pi", "tool_execution_start", { toolName: "bash", args: { command: "ls" } });
	}, "tool_loop");

	const listeners: Array<(event: { type: string }) => void> = [];
	const worker = {
		onEvent(cb: (event: { type: string }) => void) {
			listeners.push(cb);
			return () => {};
		},
		closed: new Promise(() => {}),
	} as unknown as WorkerProcess;
	await fleet.add(waitingRecord(home.path, "cp-tools"));
	post.bounds.watch("cp-tools", worker, { wall_clock_seconds: 3600, tool_call_cap: 1 });
	listeners[0]?.({ type: "tool_execution_start" });
	await until(
		() => post.durableWakeups.pending().some((entry) => entry.keys?.includes("tool_call_cap_exceeded")),
		"tool cap wake-up",
	);
	exercised.add("hard_bound");
	exercised.add("tool_call_cap_exceeded");

	await fleet.add(waitingRecord(home.path, "cp-wall"));
	post.bounds.watch("cp-wall", worker, { wall_clock_seconds: 1, tool_call_cap: 900 });
	await until(
		() => post.durableWakeups.pending().some((entry) => entry.keys?.includes("wall_clock_exceeded")),
		"wall-clock wake-up",
	);
	exercised.add("wall_clock_exceeded");

	await fleet.add(waitingRecord(home.path, "cp-model"));
	const model = post.runs.open("cp-model");
	const failedCall = {
		message: {
			role: "assistant",
			content: [],
			provider: "anthropic",
			model: "mock",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage: "401 Invalid API key",
		},
	};
	model.cp("spawned", { pid: 1 });
	model.record("pi", "agent_start", {});
	model.record("pi", "message_end", failedCall);
	model.record("pi", "agent_end", { willRetry: false });
	const modelOutcome = await post.settle.settled("cp-model", {
		alive: true,
		send: async () => ({ receipt: "failed" }),
		onEvent: () => () => {},
	});
	assert.equal(modelOutcome.action, "recorded");
	assert.ok(unreported.includes("model_call_failed"));
	exercised.add("model_call_failed");

	await fleet.add(waitingRecord(home.path, "cp-silent"));
	const silent = await post.settle.settled("cp-silent", {
		alive: false,
		send: async () => ({ receipt: "failed" }),
		onEvent: () => () => {},
	});
	assert.equal(silent.action, "recorded");
	assert.ok(unreported.includes("settled_without_report"));
	exercised.add("settled_without_report");

	await fleet.add(waitingRecord(home.path, "cp-recon"));
	await post.reconcile({ isPidAlive: () => false });
	assert.ok(post.durableWakeups.pending().some((entry) => entry.kind === "recovery"));
	exercised.add("reconcile_unsalvageable");

	await fleet.add(waitingRecord(home.path, "cp-bad-env"));
	mkdirSync(join(home.path, paths.runDir("cp-bad-env")), { recursive: true });
	writeFileSync(join(home.path, paths.runDir("cp-bad-env"), "envelope-rejected.json"), "{}");
	const invalid = await post.intake.intake("cp-bad-env");
	assert.equal(invalid.failure?.class, "envelope_invalid");
	assert.ok(post.durableWakeups.pending().some((entry) => entry.keys?.includes("envelope_invalid")));
	exercised.add("envelope_invalid");

	for (const cls of FAILURE_CLASSES) {
		if (FAILURE_RECOVERABLE[cls]) continue;
		assert.notEqual(FAILURE_CLASS_WAKEUP[cls], "none", `${cls} stays failed`);
		// X1 PR 1 declares script failures; PR 2 supplies their runner/intake emitter.
		if (cls === "script_exit" || cls === "script_signal") {
			assert.equal(FAILURE_CLASS_WAKEUP[cls], "death");
			continue;
		}
		assert.ok(exercised.has(cls), `${cls} stays failed and no emitter was exercised`);
	}
	for (const row of STATE_WAKEUP_ANNOUNCEMENTS) {
		if (!("to" in row) || row.to !== "failed") continue;
		assert.notEqual(row.wakeup, "none");
		assert.ok(exercised.has(row.event), `${row.event} ends in failed and no emitter was exercised`);
	}
});

test("a hard bound journals one outcome notice under its occurrence id, with no teardown advice (zh7.4)", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	const journal = journalWatch();
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, onDurableWakeup: journal.onDurableWakeup });
	t.after(() => post.shutdown());
	await fleet.add(waitingRecord(home.path, "cp-capped"));
	let emit: ((event: { type: string }) => void) | undefined;
	const worker = {
		onEvent(cb: (event: { type: string }) => void) {
			emit = cb;
			return () => {};
		},
		closed: new Promise(() => {}),
	} as unknown as WorkerProcess;
	post.bounds.watch("cp-capped", worker, { wall_clock_seconds: 3600, tool_call_cap: 1 });
	emit?.({ type: "tool_execution_start" });
	await journal.until(() => post.durableWakeups.pending().length > 0, "bound outcome wake-up");

	const failure = post.fleet.require("cp-capped").failure as Failure;
	const pending = post.durableWakeups.pending();
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.id, boundWakeupId("cp-capped", "tool_call_cap_exceeded", failure.at), "the occurrence id is unchanged");
	assert.equal(pending[0]?.generation, 1);
	const content = pending[0]?.content ?? "";
	// The redispatch is refused here (the worktree does not exist): an outcome, not a preview.
	assert.match(content, /automatic recovery: attempted, not revived \(/);
	assert.doesNotMatch(content, /did not stick/);
	assert.match(content, /lease and worktree kept/);
	assert.doesNotMatch(content, /next: cp_teardown/);
});

test("a durable wake-up for a torn-down job is discarded on the next sweep, not retried", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(waitingRecord(home.path, "cp-gone"));
	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
	});
	t.after(() => post.shutdown());
	post.durableWakeups.enqueue({
		id: "death:cp-gone:1",
		kind: "death",
		job_id: "cp-gone",
		content: "WORKER DEATH — cp-gone",
		keys: ["crash"],
	});
	post.durableWakeups.enqueue({
		id: "death:cp-live:1",
		kind: "death",
		job_id: "cp-live",
		content: "WORKER DEATH — cp-live",
		keys: ["crash"],
	});
	await fleet.remove("cp-gone");
	const facts = wakeupFacts({ record: (jobId) => fleet.get(jobId) });
	let threw = false;
	assert.throws(() => {
		post.sweepDurableWakeups((entry) => {
			if (entry.id === "death:cp-live:1") {
				threw = true;
				throw new Error("transport down");
			}
			const verdict = checkWakeup(
				{
					kind: entry.kind,
					job_id: entry.job_id,
					keys: entry.keys,
					generation: entry.generation,
					issued_at: entry.queued_at,
				},
				facts,
			);
			if (verdict.state === "superseded") return verdict.reason ?? "stale";
			return true;
		});
	});
	assert.equal(threw, true);
	assert.deepEqual(
		post.durableWakeups.pending().map((entry) => entry.id),
		["death:cp-live:1"],
		"transport failure stays pending",
	);
	const discarded = post.durableWakeups.read().discarded ?? [];
	assert.equal(discarded.length, 1);
	assert.equal(discarded[0]?.id, "death:cp-gone:1");
	assert.match(discarded[0]?.reason ?? "", /no fleet record/);

	const retried: string[] = [];
	post.sweepDurableWakeups((entry) => {
		retried.push(entry.id);
		return true;
	});
	assert.deepEqual(retried, ["death:cp-live:1"]);
	assert.ok(!post.durableWakeups.pending().some((entry) => entry.id === "death:cp-gone:1"));
	post.sweepDurableWakeups((entry) => {
		assert.notEqual(entry.id, "death:cp-gone:1", "torn-down wake-up must not be retried");
		return true;
	});
	assert.equal((post.durableWakeups.read().discarded ?? []).length, 1);
});
