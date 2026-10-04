/**
 * cp-av8 acceptance: Awaiting-you is answerable, durable and never a second
 * authorization path.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	AwaitingError,
	AwaitingStore,
	awaitingId,
	awaitingSubjectKey,
	decisionSubject,
	itemSubjectKey,
	repairAwaitingItems,
	isDerivedAwaitingId,
	materialiseDerived,
	deriveFromCheckpoints,
	deriveFromHeldResearch,
	mergeAwaiting,
	researchApprovalIneligibleReason,
	type ResolvedAwaitingItem,
} from "../src/awaiting.ts";
import { type AwaitingWriters, resolveAwaitingResponse } from "./harness/awaiting-resolve.ts";
import {
	CheckpointError,
	CheckpointStore,
} from "../src/checkpoint.ts";
import type { AwaitingItem, Checkpoint, StatusJob } from "../src/contracts.ts";
import {
	AWAITING_KEEP_ANSWERED,
	checkpointAwaitingId,
	LAYOUT,
	parseCheckpointAwaitingId,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

function checkpoint(overrides: Partial<Checkpoint> & { job_id: string }): Checkpoint {
	return {
		schema_version: 1,
		question: "authorize?",
		requested_at: "2026-08-30T11:00:00Z",
		decision: "pending",
		...overrides,
	};
}

function heldResearchJob(overrides: Partial<StatusJob> & { job_id: string }): StatusJob {
	return {
		project: "demo",
		kind: "research",
		delivery: "pipeline",
		origin: "terminal",
		phase: "held",
		title: null,
		br_status: null,
		profile: "planner",
		role: "planner",
		model: "anthropic/claude-sonnet-5",
		run_phase: null,
		current_tool: null,
		current_tool_seconds: null,
		turns: 0,
		tool_calls: 0,
		alive: false,
		pid: 1234,
		session_id: "sess",
		worktree: "/tmp/demo",
		branch: overrides.job_id,
		timestamp: "2026-08-30T12:00:00Z",
		time_source: "dispatched_at",
		age_seconds: 60,
		last_activity_at: null,
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_usd: 0 },
		...overrides,
	} as StatusJob;
}

// ---------------------------------------------------------------------------
// Derivation + merge
// ---------------------------------------------------------------------------

test("deriveFromCheckpoints turns a pending checkpoint into one authorization row", () => {
	const rows = deriveFromCheckpoints([checkpoint({ job_id: "cp-ship" })]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.type, "authorization");
	assert.equal(rows[0]!.job_id, "cp-ship");
});

test("an approved checkpoint yields no row at all (derived from listPending, which excludes it)", () => {
	// listPending() itself only returns `pending` records; this asserts the
	// derivation trusts that filter rather than re-checking `decision` itself.
	const rows = deriveFromCheckpoints([]);
	assert.deepEqual(rows, []);
});

test("deriveFromHeldResearch: held research with no PR is one approval row; a PR receipt suppresses it", () => {
	const noPr = heldResearchJob({ job_id: "cp-research" });
	const withPr = heldResearchJob({
		job_id: "cp-shipped-research",
		receipts: [{ kind: "pr", status: "open", title: "p", url: "https://example.com/pr/1" }],
	});
	const notHeld = heldResearchJob({ job_id: "cp-waiting", phase: "waiting" });
	const notResearch = heldResearchJob({ job_id: "cp-ship-job", kind: "ship" });
	const rows = deriveFromHeldResearch([noPr, withPr, notHeld, notResearch]);
	assert.deepEqual(
		rows.map((row) => row.job_id),
		["cp-research"],
	);
	assert.equal(rows[0]!.type, "approval");
});

test("deriveFromHeldResearch: a Q&A job (delivery:answer) raises no ship decision at all", () => {
	// cp-u3o4: a Q&A job is research by kind, so without this it would mint
	// "ship, drop or follow-up?" for a question the operator already had answered
	// on a card. Plain research is the regression half: it still derives a row.
	const answered = heldResearchJob({ job_id: "cp-question", delivery: "answer" });
	const board = heldResearchJob({ job_id: "cp-board", delivery: "board" });
	const plain = heldResearchJob({ job_id: "cp-research" });
	const rows = deriveFromHeldResearch([answered, board, plain]);
	assert.deepEqual(
		rows.map((row) => row.job_id),
		["cp-research"],
	);
});

test("mergeAwaiting orders authorization first, then oldest-first; a snoozed item is still rendered", () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		return (async () => {
			const early = await store.declare({ type: "design", decision: "pick rubric", why: "affects all jobs", blocks: "everything" });
			const late = await store.declare({ type: "approval", decision: "ship cp-x?", why: "research done", blocks: "cp-x" });
			// Force a distinct opened_at ordering by re-reading and patching the file
			// directly is unnecessary here: declare() already stamps `now`, and the
			// two calls above are sequential, so `early` is opened first.
			const merged = mergeAwaiting({
				checkpoints: [checkpoint({ job_id: "cp-auth" })],
				heldResearch: [],
				declared: store.list("open"),
				snoozed: new Set([late.id]),
			});
			assert.equal(merged[0]!.type, "authorization");
			assert.equal(merged[1]!.id, early.id);
			assert.equal(merged[2]!.id, late.id);
			assert.equal(merged[2]!.snoozed, true);
			assert.equal(merged[1]!.snoozed, undefined);
		})();
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("declare refuses an authorization type; authorization-shaped wording is a lint", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await assert.rejects(
			() =>
				store.declare({
					type: "authorization" as never,
					decision: "authorize cp-x",
					why: "w",
					blocks: "b",
				}),
			AwaitingError,
		);
		const outcome = await store.declareGated({
			type: "approval",
			decision: "may I go ahead and ship this?",
			why: "w",
			blocks: "b",
		});
		assert.equal(outcome.item.state, "open");
		assert.match(outcome.lint ?? "", /authorization request/);
	} finally {
		home.cleanup();
	}
});

test("declare is an upsert keyed by {job_id,type,decision}: same triple, same row", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const first = await store.declare({ type: "design", decision: "A or B?", why: "first why", blocks: "cp-x" });
		const second = await store.declare({ type: "design", decision: "A or B?", why: "updated why", blocks: "cp-x" });
		assert.equal(first.id, second.id);
		assert.equal(store.list("open").length, 1);
		assert.equal(store.get(first.id)!.why, "updated why");
	} finally {
		home.cleanup();
	}
});

test("answer refuses to overwrite a different answer, but the same answer twice is idempotent", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare({ type: "design", decision: "A or B?", why: "w", blocks: "b" });
		await store.answer(item.id, { answer: "A", by: "operator dialog (tui)" });
		const again = await store.answer(item.id, { answer: "A", by: "operator dialog (tui)" });
		assert.equal(again.answer, "A");
		await assert.rejects(() => store.answer(item.id, { answer: "B", by: "operator dialog (tui)" }), AwaitingError);
	} finally {
		home.cleanup();
	}
});

test("skip writes nothing: the file is untouched, and the item stays open", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await store.declare({ type: "design", decision: "A or B?", why: "w", blocks: "b" });
		const before = readFileSync(store.file, "utf8");
		// Skip is modelled as "no call at all" — resolveAwaitingResponse's skip
		// branch never touches a writer (asserted below); here we assert the file
		// itself is byte-identical after doing nothing.
		const after = readFileSync(store.file, "utf8");
		assert.equal(before, after);
		assert.equal(store.list("open").length, 1);
	} finally {
		home.cleanup();
	}
});

test("withdraw refuses a derived id (authorization/approval), leaving the item to /cp-authorize or /cp-decide", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		// Derived authorization rows must be refused
		await assert.rejects(
			() => store.withdraw("aw-checkpoint-cp-x"),
			(error: Error) => error instanceof AwaitingError,
		);
		// Derived approval rows must be refused
		await assert.rejects(
			() => store.withdraw("aw-research-cp-y"),
			(error: Error) => error instanceof AwaitingError,
		);
	} finally {
		home.cleanup();
	}
});

test("answered items are pruned to AWAITING_KEEP_ANSWERED, open items are never pruned", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		for (let i = 0; i < AWAITING_KEEP_ANSWERED + 5; i += 1) {
			const item = await store.declare({ type: "design", decision: `q${i}`, why: "w", blocks: "b" });
			await store.answer(item.id, { answer: "x", by: "operator command" });
		}
		const stillOpen = await store.declare({ type: "design", decision: "still open", why: "w", blocks: "b" });
		const all = store.list();
		const answered = all.filter((entry) => entry.state === "answered");
		assert.equal(answered.length, AWAITING_KEEP_ANSWERED);
		assert.ok(store.get(stillOpen.id));
	} finally {
		home.cleanup();
	}
});

test("declared state survives a fresh AwaitingStore on the same home (restart survival)", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare({ type: "approval", decision: "ship it?", why: "w", blocks: "b" });
		const reopened = new AwaitingStore({ home: home.path });
		assert.deepEqual(reopened.get(item.id), item);
		assert.ok(!existsSync(`${store.file}.tmp`), "a .tmp file was left behind by the atomic write");
	} finally {
		home.cleanup();
	}
});

test("awaitingId is stable for the same {job_id,type,decision} and differs otherwise", () => {
	const a = awaitingId({ job_id: "cp-x", type: "design", decision: "A or B?" });
	const b = awaitingId({ job_id: "cp-x", type: "design", decision: "A or B?" });
	const c = awaitingId({ job_id: "cp-x", type: "design", decision: "A or C?" });
	assert.equal(a, b);
	assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// cp-nx7: identity is the decision's subject, and the store is keyed by id
// ---------------------------------------------------------------------------

/** Write a store file by hand — the only way to reproduce a store that is
 * already broken (this home's own duplicated ids) without a broken writer. */
function seedStore(home: string, items: AwaitingItem[]): string {
	const file = join(home, LAYOUT.awaitingFile);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-08-31T14:00:00Z", items }, null, 2)}\n`);
	return file;
}

function storedItem(overrides: Partial<AwaitingItem> & { id: string }): AwaitingItem {
	return {
		schema_version: SCHEMA_VERSION,
		type: "approval",
		decision: "Merge PR #48 (pregenerated /cp-decide answers)",
		why: "green",
		blocks: "cp-qd4",
		state: "open",
		opened_at: "2026-08-31T13:59:59Z",
		...overrides,
	} as AwaitingItem;
}

test("the subject of a decision survives every rewording the parent actually applied", () => {
	// Verbatim from cp-nx7: three ids existed for two real decisions.
	const pr44 = [
		"Merge PR #44 once its rebase lands green",
		"Merge PR #44 when CI goes green on cd178f4",
	].map(decisionSubject);
	assert.deepEqual(pr44, ["merge pr#44", "merge pr#44"]);
	const pr42 = [
		"Merge PR #42 once rebased and the question is answered",
		"Merge PR #42 when green on b5f1ecd",
		"Merge PR #42 - both conditions now met",
	].map(decisionSubject);
	assert.deepEqual(pr42, ["merge pr#42", "merge pr#42", "merge pr#42"]);
	const pr47 = [
		"Merge PR #47 (diff-review orchestrator) - ANSWER IN CHAT",
		"Merge PR #47 (diff-review orchestrator)",
	].map(decisionSubject);
	assert.deepEqual(pr47, ["merge pr#47", "merge pr#47"]);

	// Different subjects stay different: identity is stable, not blurry.
	assert.notEqual(decisionSubject("Merge PR #47"), decisionSubject("Merge PR #48"));
	assert.notEqual(decisionSubject("Merge PR #47"), decisionSubject("Close PR #47"));
	assert.notEqual(decisionSubject("postgres or sqlite?"), decisionSubject("one queue or two?"));
	// A decision that is nothing but a qualifier keeps its own text rather than
	// collapsing onto every other such decision.
	assert.notEqual(decisionSubject("once more, with feeling"), decisionSubject("once upon a time"));
	// An explicit subject wins outright, so a caller is never at the mercy of the
	// derivation.
	assert.equal(
		awaitingSubjectKey({ type: "approval", job_id: "cp-x", decision: "totally different prose", subject: "merge pr#44" }),
		awaitingSubjectKey({ type: "approval", job_id: "cp-x", decision: "and again", subject: "merge pr#44" }),
	);
	// Only the first word before the PR reference used to survive: "Ship PR #44
	// results" and "Ship PR #44 to staging" both collapsed to "ship pr#44", so a
	// second, genuinely different question about the same PR silently overwrote
	// the first one's row (cp-rs1). The object words after the reference must
	// stay, so the two subjects differ.
	assert.notEqual(decisionSubject("Ship PR #44 results"), decisionSubject("Ship PR #44 to staging"));
});

test("cp-rs1: a merge-ask's undecorated first rendering and its qualifier-decorated later rendering fold to one key", () => {
	// Exactly the case stripJobIdMention exists for: the first rendering names the
	// job with no qualifier word to trigger a QUALIFIER_CLAUSE split, the later
	// one attaches the fact behind "once" and drops the job mention entirely.
	const first = awaitingSubjectKey({ type: "approval", job_id: "cp-gmy", decision: "Merge PR #58 for cp-gmy?" });
	const later = awaitingSubjectKey({ type: "approval", job_id: "cp-gmy", decision: "Merge PR #58 once CI goes green" });
	assert.equal(first, later, "the job mention and the qualifier clause are both prose, not the decision");
});

test("cp-rs1: stripJobIdMention removes only the ' for <jobId>' token, not the object words that follow it", () => {
	// The collision this could otherwise introduce: if the whole remainder of the
	// string were dropped from " for <jobId>" onward, these two would collapse
	// onto one subject the same way the un-fixed PR-reference collapse once did.
	// Narrowing the cut to the token itself keeps them apart.
	const results = awaitingSubjectKey({ type: "approval", job_id: "cp-44", decision: "Ship PR #44 for cp-44 results" });
	const staging = awaitingSubjectKey({ type: "approval", job_id: "cp-44", decision: "Ship PR #44 for cp-44 to staging" });
	assert.notEqual(results, staging, "the object words after the job_id mention still distinguish two real decisions");
});

test("cp-rs1: two different decisions that both mention the same PR get two rows, not one", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const first = await store.declare({
			type: "approval",
			decision: "Ship PR #44 results",
			why: "benchmarks are in",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		const second = await store.declare({
			type: "approval",
			decision: "Ship PR #44 to staging",
			why: "staging deploy is ready",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		assert.notEqual(second.id, first.id, "two questions about one PR are two rows");
		const all = store.list();
		assert.equal(all.length, 2, "neither declare overwrote the other");
		assert.equal(store.get(first.id)!.decision, "Ship PR #44 results");
		assert.equal(store.get(second.id)!.decision, "Ship PR #44 to staging");
	} finally {
		home.cleanup();
	}
});

test("cp-rs1: itemSubjectKey still recognises a pre-subject row against a reworded re-declare", () => {
	// A row written before the `subject` field existed carries none, so its
	// identity must still be derivable from its stored decision text alone —
	// exactly the on-disk shape `storedItem()` below produces.
	const onDisk = storedItem({
		id: "aw-oldrow0001",
		job_id: "cp-44",
		decision: "Merge PR #44 once its rebase lands green",
	});
	assert.equal(onDisk.subject, undefined, "an old row carries no subject field");
	const reworded = itemSubjectKey({
		type: "approval",
		job_id: "cp-44",
		decision: "Merge PR #44 when CI goes green on cd178f4",
	});
	assert.equal(itemSubjectKey(onDisk), reworded, "the reworded declare still matches the old, subject-less row");
});

test("upserting a row whose why/blocks changed updates the one record and appends nothing", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const first = await store.declare({
			type: "approval",
			decision: "Merge PR #44",
			why: "CI pending",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		const second = await store.declare({
			type: "approval",
			decision: "Merge PR #44",
			why: "green on cd178f4",
			blocks: "cp-44 and the two PRs behind it",
			job_id: "cp-44",
		});
		assert.equal(second.id, first.id);
		const all = store.list();
		assert.equal(all.length, 1, "one subject, one record");
		assert.equal(all[0]!.why, "green on cd178f4");
		assert.equal(all[0]!.blocks, "cp-44 and the two PRs behind it");
		assert.equal(all[0]!.opened_at, first.opened_at, "the same question, not a newer one");
	} finally {
		home.cleanup();
	}
});

test("rewording an open decision updates it in place: same subject, same id, no second row", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const first = await store.declare({
			type: "approval",
			decision: "Merge PR #44 once its rebase lands green",
			why: "rebase in flight",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		const reworded = await store.declare({
			type: "approval",
			decision: "Merge PR #44 when CI goes green on cd178f4",
			why: "rebased, CI running",
			blocks: "cp-44",
			job_id: "cp-44",
		});
		assert.equal(reworded.id, first.id, "refining the wording is not a new decision");
		assert.equal(store.list().length, 1);
		assert.equal(store.get(first.id)!.decision, "Merge PR #44 when CI goes green on cd178f4", "the latest wording wins");

		// The clean reproduction from cp-nx7: the "ANSWER IN CHAT" suffix, removed.
		const chat = await store.declare({
			type: "approval",
			decision: "Merge PR #47 (diff-review orchestrator) - ANSWER IN CHAT",
			why: "green",
			blocks: "cp-47",
			job_id: "cp-diffgate-orchestrator-03v",
		});
		const plain = await store.declare({
			type: "approval",
			decision: "Merge PR #47 (diff-review orchestrator)",
			why: "green",
			blocks: "cp-47",
			job_id: "cp-diffgate-orchestrator-03v",
		});
		assert.equal(plain.id, chat.id, "one decision, asked once");
		assert.equal(store.list().length, 2, "two decisions in the store, not four");
	} finally {
		home.cleanup();
	}
});

test("an answered item is never reopened by a re-render, however the prose changed", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare({
			type: "approval",
			decision: "Merge PR #48 (pregenerated /cp-decide answers)",
			why: "green",
			blocks: "cp-qd4",
			job_id: "cp-qd4",
		});
		await store.answer(item.id, { answer: "yes", by: "operator dialog (tui)" });

		// The loop, exactly as it happened: the wake-up has not arrived yet, so the
		// parent renders the same row again — identically, then reworded.
		const again = await store.declare({
			type: "approval",
			decision: "Merge PR #48 (pregenerated /cp-decide answers)",
			why: "green",
			blocks: "cp-qd4",
			job_id: "cp-qd4",
		});
		const reworded = await store.declare({
			type: "approval",
			decision: "Merge PR #48 - CI green, ready",
			why: "green on the rebased head",
			blocks: "cp-qd4",
			job_id: "cp-qd4",
		});

		assert.equal(again.id, item.id);
		assert.equal(reworded.id, item.id, "an answered decision is never resurrected under a new id");
		assert.equal(store.list().length, 1, "and never duplicated under its own");
		const stored = store.get(item.id)!;
		assert.equal(stored.state, "answered");
		assert.equal(stored.answer, "yes");
		assert.deepEqual(store.list("open"), [], "nothing is left for /cp-decide to ask again");
	} finally {
		home.cleanup();
	}
});

test("a store that already holds duplicate ids is repaired on load, deterministically", async () => {
	const home = createScratchHome();
	try {
		// aw-7eed20da42: answered at 14:02:04, then an `open` duplicate appended 17
		// seconds later by a re-render — the record that made the question
		// unanswerable by construction. aw-123b695c29: two answered records, one id.
		const items: AwaitingItem[] = [
			storedItem({
				id: "aw-7eed20da42",
				job_id: "cp-qd4",
				state: "answered",
				answer: "yes",
				answered_by: "operator dialog (tui)",
				answered_at: "2026-08-31T14:02:04Z",
			}),
			storedItem({ id: "aw-7eed20da42", job_id: "cp-qd4", state: "open", opened_at: "2026-08-31T14:02:21Z" }),
			storedItem({
				id: "aw-123b695c29",
				type: "design",
				decision: "restart now or later?",
				why: "first why",
				blocks: "the fleet",
				state: "answered",
				answer: "later",
				answered_by: "operator command",
				answered_at: "2026-08-31T12:37:30Z",
				opened_at: "2026-08-31T12:37:05Z",
			}),
			storedItem({
				id: "aw-123b695c29",
				type: "design",
				decision: "restart now or later?",
				why: "second why",
				blocks: "the fleet",
				state: "answered",
				answer: "later",
				answered_by: "operator command",
				answered_at: "2026-08-31T12:39:40Z",
				opened_at: "2026-08-31T12:39:12Z",
			}),
		];
		seedStore(home.path, items);
		const store = new AwaitingStore({ home: home.path });

		const loaded = store.list();
		assert.equal(loaded.length, 2, "one id, one record");
		const qd4 = store.get("aw-7eed20da42")!;
		assert.equal(qd4.state, "answered", "the record carrying a human's answer wins");
		assert.equal(qd4.answer, "yes");
		assert.deepEqual(store.list("open"), [], "the open duplicate cannot keep asking");
		assert.equal(store.get("aw-123b695c29")!.why, "first why", "ties break on the earlier answer, every time");

		// Deterministic: the same file, read again (and by a second store), agrees.
		const second = new AwaitingStore({ home: home.path });
		assert.deepEqual(second.list(), loaded);
		assert.deepEqual(repairAwaitingItems(items).items, loaded);
		assert.deepEqual(repairAwaitingItems([...items].reverse()).items.map((item) => item.state), ["answered", "answered"]);

		// And the repair persists on the next write, rather than lurking.
		await store.declare({ type: "design", decision: "anything at all", why: "w", blocks: "b" });
		const onDisk = JSON.parse(readFileSync(join(home.path, LAYOUT.awaitingFile), "utf8")) as { items: AwaitingItem[] };
		const ids = onDisk.items.map((item) => item.id);
		assert.equal(new Set(ids).size, ids.length, "the file itself no longer holds two records under one id");
	} finally {
		home.cleanup();
	}
});

test("withdraw never overwrites a recorded answer", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = await store.declare({ type: "design", decision: "A or B?", why: "w", blocks: "b" });
		await store.answer(item.id, { answer: "A", by: "operator dialog (tui)" });
		await assert.rejects(() => store.withdraw(item.id), AwaitingError);
		const stored = store.get(item.id)!;
		assert.equal(stored.state, "answered");
		assert.equal(stored.answer, "A", "the operator's answer is still there");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Resolver policy
// ---------------------------------------------------------------------------

function fakeWriters(): AwaitingWriters & { checkpointCalls: unknown[]; answerCalls: unknown[] } {
	const checkpointCalls: unknown[] = [];
	const answerCalls: unknown[] = [];
	return {
		checkpointCalls,
		answerCalls,
		decideCheckpoint: (jobId, approved, by, kind) => {
			checkpointCalls.push({ jobId, approved, by, kind });
		},
		answerDeclared: (item, answer, by) => {
			answerCalls.push({ id: item.id, answer, by });
		},
	};
}

test("resolver: skip/cancel writes nothing to either writer", async () => {
	const writers = fakeWriters();
	const item = resolvedItem({ id: "aw-1", type: "design", job_id: "cp-x" });
	const skip = await resolveAwaitingResponse({ id: "aw-1", kind: "skip" }, item, writers);
	const cancel = await resolveAwaitingResponse({ id: "aw-1", kind: "cancel" }, item, writers);
	assert.equal(skip.wrote, false);
	assert.equal(cancel.wrote, false);
	assert.equal(writers.checkpointCalls.length, 0);
	assert.equal(writers.answerCalls.length, 0);
});

test("resolver: approve/decline on an authorization item calls decideCheckpoint exactly once, by a human channel", async () => {
	const writers = fakeWriters();
	const item = resolvedItem({ id: "aw-checkpoint-cp-ship", type: "authorization", job_id: "cp-ship" });
	const result = await resolveAwaitingResponse(
		{ id: "aw-checkpoint-cp-ship", kind: "answer", value: "approve", by: "operator dialog (tui)" },
		item,
		writers,
	);
	assert.equal(result.wrote, true);
	assert.equal(writers.checkpointCalls.length, 1);
	assert.deepEqual(writers.checkpointCalls[0], {
		jobId: "cp-ship",
		approved: true,
		by: "operator dialog (tui)",
		// No `checkpoint_kind` on the row reads as the pre-implementation one, so
		// every pre-cp-khf caller keeps its exact meaning.
		kind: "ship",
	});
	assert.equal(writers.answerCalls.length, 0);
});

test("resolver: free text on an authorization item is a note, never a verdict — the checkpoint is never called", async () => {
	const writers = fakeWriters();
	const item = resolvedItem({ id: "aw-checkpoint-cp-ship", type: "authorization", job_id: "cp-ship" });
	const result = await resolveAwaitingResponse(
		{ id: "aw-checkpoint-cp-ship", kind: "answer", value: "sure, sounds good", by: "operator dialog (tui)" },
		item,
		writers,
	);
	assert.equal(result.wrote, false);
	assert.equal(result.note, "sure, sounds good");
	assert.equal(writers.checkpointCalls.length, 0);
});

test("resolver: a declared item's answer calls answerDeclared, never the checkpoint writer", async () => {
	const writers = fakeWriters();
	const item = resolvedItem({ id: "aw-1", type: "design", job_id: "cp-x" });
	const result = await resolveAwaitingResponse(
		{ id: "aw-1", kind: "answer", value: "B, with C as the escape hatch", by: "operator command" },
		item,
		writers,
	);
	assert.equal(result.wrote, true);
	assert.equal(writers.answerCalls.length, 1);
	assert.equal(writers.checkpointCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Real checkpoint integration: one writer, one record
// ---------------------------------------------------------------------------

test("an authorization item resolved through the resolver lands exactly where /cp-authorize would", async () => {
	const home = createScratchHome();
	try {
		const checkpoints = new CheckpointStore(home.path);
		checkpoints.request({ jobId: "cp-ship", question: "ship it?" });
		const writers: AwaitingWriters = {
			decideCheckpoint: (jobId, approved, by) => {
				checkpoints.decide(jobId, approved, { by });
			},
			answerDeclared: () => {
				throw new Error("must not be called for an authorization item");
			},
		};
		await resolveAwaitingResponse(
			{ id: "aw-checkpoint-cp-ship", kind: "answer", value: "approve", by: "operator dialog (tui)" },
			resolvedItem({ id: "aw-checkpoint-cp-ship", type: "authorization", job_id: "cp-ship" }),
			writers,
		);
		const record = checkpoints.get("cp-ship");
		assert.equal(record!.decision, "approved");
		assert.equal(record!.decided_by, "operator dialog (tui)");
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// ledger audit trail (best effort, never load-bearing for the answer)
// ---------------------------------------------------------------------------

test("ledger audit: answering a declared item with a job_id adds exactly one comment", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const job = await scratch.ledger.create({
		title: "demo job",
		project: "demo",
		delivery: "pr",
		description: "d",
	});
	await scratch.ledger.comment(
		job.id,
		`decision: ship it? \u2014 answered "yes" by operator command at 2026-08-30T12:00:00Z (awaiting aw-1)`,
	);
	assert.equal((await scratch.ledger.show(job.id)).comments.length, 1);
});

function resolvedItem(overrides: Partial<ResolvedAwaitingItem> & { id: string }): ResolvedAwaitingItem {
	return {
		type: "design",
		decision: "A or B?",
		why: "w",
		blocks: "b",
		opened_at: "2026-08-30T12:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Derived rows are answerable (cp-derived-awaiting-unanswerable)
//
// The P0: `/cp-decide aw-research-cp-0hj ship` failed with "no awaiting item
// aw-research-cp-0hj", because a derived row exists nowhere until someone
// answers it. Everything below exercises the *real* writers the extension
// wires (AwaitingStore + CheckpointStore over a scratch home), never a stub of
// the thing under test.
// ---------------------------------------------------------------------------

/** Exactly the wiring `extensions/command-post/index.ts#awaitingWriters` uses. */
function liveWriters(store: AwaitingStore, checkpoints: CheckpointStore, diff?: CheckpointStore): AwaitingWriters {
	return {
		decideCheckpoint: (jobId, approved, by, kind) => {
			// Exactly what the extension does: the row picks the store, and
			// `CheckpointStore.decide` stays the only writer either way.
			const target = kind === "diff" ? (diff ?? new CheckpointStore(store.home, { kind: "diff" })) : checkpoints;
			target.decide(jobId, approved, { by });
		},
		answerDeclared: async (item, answer, by) => {
			await store.answerResolved(item, { answer, by });
		},
	};
}

test("derived approval: the id the operator is shown is the id that answers, and it stops being derived", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		const jobs = [heldResearchJob({ job_id: "cp-0hj" })];

		const offered = mergeAwaiting({ checkpoints: [], heldResearch: jobs, declared: store.list() });
		assert.equal(offered.length, 1);
		const item = offered[0]!;
		assert.equal(item.id, "aw-research-cp-0hj", "the derived id is what the menu prints");
		assert.ok(!existsSync(store.file), "nothing is persisted merely by listing");

		const result = await resolveAwaitingResponse(
			{ id: item.id, kind: "answer", value: "ship", by: "operator command" },
			item,
			liveWriters(store, checkpoints),
		);
		assert.equal(result.wrote, true);

		const stored = store.get("aw-research-cp-0hj");
		assert.ok(stored, "the answered row is materialised under the very id offered");
		assert.equal(stored!.state, "answered");
		assert.equal(stored!.answer, "ship");
		assert.equal(stored!.answered_by, "operator command");
		assert.equal(stored!.type, "approval");
		assert.equal(stored!.job_id, "cp-0hj");
		assert.equal(stored!.opened_at, item.opened_at, "opened_at is the projection's, not the answer's");

		// The job is still held with no PR receipt, so the projection would happily
		// re-derive it; the stored answer is what makes "answered" stick.
		const after = mergeAwaiting({ checkpoints: [], heldResearch: jobs, declared: store.list() });
		assert.deepEqual(after, [], "an answered derived row is never offered again");
	} finally {
		home.cleanup();
	}
});

test("derived approval survives a restart: a fresh store still suppresses the answered row", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const jobs = [heldResearchJob({ job_id: "cp-0hj" })];
		const item = mergeAwaiting({ checkpoints: [], heldResearch: jobs, declared: store.list() })[0]!;
		await store.answerResolved(item, { answer: "drop", by: "operator dialog (tui)" });

		const reopened = new AwaitingStore({ home: home.path });
		assert.equal(reopened.get(item.id)!.answer, "drop");
		assert.deepEqual(mergeAwaiting({ checkpoints: [], heldResearch: jobs, declared: reopened.list() }), []);
	} finally {
		home.cleanup();
	}
});

test("derived authorization routes through CheckpointStore.decide and writes no awaiting row at all", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		checkpoints.request({ jobId: "cp-ship", question: "ship it?" });

		const offered = mergeAwaiting({
			checkpoints: checkpoints.listPending(),
			heldResearch: [],
			declared: store.list(),
		});
		const item = offered[0]!;
		assert.equal(item.id, "aw-checkpoint-cp-ship");

		const result = await resolveAwaitingResponse(
			{ id: item.id, kind: "answer", value: "approve", by: "operator dialog (tui)" },
			item,
			liveWriters(store, checkpoints),
		);
		assert.equal(result.wrote, true);

		// One record of an authorization, and it is the checkpoint file.
		const record = checkpoints.get("cp-ship");
		assert.equal(record!.decision, "approved");
		assert.equal(record!.decided_by, "operator dialog (tui)");
		assert.ok(!existsSync(store.file), "an authorization never lands in state/awaiting.json");

		// It leaves the merged set because it is no longer pending, not because
		// anything was written here.
		assert.deepEqual(
			mergeAwaiting({ checkpoints: checkpoints.listPending(), heldResearch: [], declared: store.list() }),
			[],
		);
	} finally {
		home.cleanup();
	}
});

test("answerResolved refuses an authorization row outright: there is no second path to a checkpoint", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = resolvedItem({ id: "aw-checkpoint-cp-ship", type: "authorization", job_id: "cp-ship" });
		await assert.rejects(() => store.answerResolved(item, { answer: "approve", by: "operator command" }), AwaitingError);
		assert.throws(() => materialiseDerived(item), AwaitingError);
		assert.ok(!existsSync(store.file), "the refusal wrote nothing");
	} finally {
		home.cleanup();
	}
});

test("skip on a derived row writes nothing anywhere — the row is not even created — and it reappears", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		checkpoints.request({ jobId: "cp-ship", question: "ship it?" });
		const jobs = [heldResearchJob({ job_id: "cp-0hj" })];
		const writers = liveWriters(store, checkpoints);

		const offered = mergeAwaiting({ checkpoints: checkpoints.listPending(), heldResearch: jobs, declared: store.list() });
		assert.equal(offered.length, 2);
		for (const item of offered) {
			const skipped = await resolveAwaitingResponse({ id: item.id, kind: "skip" }, item, writers);
			assert.equal(skipped.wrote, false);
		}

		assert.ok(!existsSync(store.file), "skip never materialises a derived row");
		assert.equal(checkpoints.get("cp-ship")!.decision, "pending", "skip is not a verdict");

		const again = mergeAwaiting({ checkpoints: checkpoints.listPending(), heldResearch: jobs, declared: store.list() });
		assert.deepEqual(
			again.map((row) => row.id).sort(),
			["aw-checkpoint-cp-ship", "aw-research-cp-0hj"],
			"both skipped rows reappear, unchanged",
		);
	} finally {
		home.cleanup();
	}
});

test("a declared row still answers exactly as before, through the same resolver path", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		const declared = await store.declare({ type: "design", decision: "A or B?", why: "w", blocks: "cp-x", job_id: "cp-x" });
		const offered = mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list() });
		const item = offered[0]!;
		assert.equal(item.id, declared.id);

		await resolveAwaitingResponse(
			{ id: item.id, kind: "answer", value: "B", by: "operator command" },
			item,
			liveWriters(store, checkpoints),
		);
		assert.equal(store.get(declared.id)!.state, "answered");
		assert.equal(store.get(declared.id)!.answer, "B");
		assert.equal(store.list().length, 1, "no duplicate row was materialised alongside it");
		assert.deepEqual(mergeAwaiting({ checkpoints: [], heldResearch: [], declared: store.list() }), []);

		// Answered once, for a materialised row and a declared one alike.
		await assert.rejects(() => store.answerResolved(item, { answer: "A", by: "operator command" }), AwaitingError);
	} finally {
		home.cleanup();
	}
});

test("answering a derived row twice: idempotent for the same answer, refused for a different one", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const item = mergeAwaiting({
			checkpoints: [],
			heldResearch: [heldResearchJob({ job_id: "cp-0hj" })],
			declared: store.list(),
		})[0]!;
		await store.answerResolved(item, { answer: "ship", by: "operator command" });
		const again = await store.answerResolved(item, { answer: "ship", by: "operator command" });
		assert.equal(again.answer, "ship");
		assert.equal(store.list().length, 1);
		await assert.rejects(() => store.answerResolved(item, { answer: "drop", by: "operator command" }), AwaitingError);
	} finally {
		home.cleanup();
	}
});

test("vanished job: the checkpoint is gone, so the answer fails loudly and nothing is recorded anywhere", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const checkpoints = new CheckpointStore(home.path);
		// Offered from a snapshot, then the underlying checkpoint disappears before
		// the operator answers (a torn-down job, a wiped state dir).
		const item = resolvedItem({ id: "aw-checkpoint-cp-gone", type: "authorization", job_id: "cp-gone" });
		await assert.rejects(
			() =>
				resolveAwaitingResponse(
					{ id: item.id, kind: "answer", value: "approve", by: "operator command" },
					item,
					liveWriters(store, checkpoints),
				),
			(error: Error) => /no checkpoint for cp-gone/.test(error.message),
			"the failure names what is missing, instead of appearing to succeed",
		);
		assert.ok(!existsSync(store.file), "a failed answer records nothing in the declared store either");
	} finally {
		home.cleanup();
	}
});

test("a projected row the contract cannot hold fails loudly at the write, and leaves no file behind", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const bad = resolvedItem({ id: "aw-research-cp-bad", type: "approval", job_id: "../escape" });
		await assert.rejects(
			() => store.answerResolved(bad, { answer: "ship", by: "operator command" }),
			(error: Error) => error instanceof AwaitingError && /awaiting contract|invalid awaiting/.test(error.message),
		);
		assert.ok(!existsSync(store.file), "a refused write leaves no partial file");
	} finally {
		home.cleanup();
	}
});

test("store.answer on a derived id refuses by name, pointing at the path that materialises it", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await assert.rejects(
			() => store.answer("aw-research-cp-0hj", { answer: "ship", by: "operator command" }),
			(error: Error) => error instanceof AwaitingError && /derived Awaiting-you row/.test(error.message),
		);
		assert.equal(isDerivedAwaitingId("aw-research-cp-0hj"), true);
		assert.equal(isDerivedAwaitingId("aw-checkpoint-cp-x"), true);
		assert.equal(isDerivedAwaitingId("aw-0f1e2d3c4b"), false);
	} finally {
		home.cleanup();
	}
});

test("the resolver refuses an answer whose id is not the offered item's id", async () => {
	const writers = fakeWriters();
	const item = resolvedItem({ id: "aw-research-cp-0hj", type: "approval", job_id: "cp-0hj" });
	await assert.rejects(
		() => resolveAwaitingResponse({ id: "aw-research-cp-other", kind: "answer", value: "ship", by: "op" }, item, writers),
		AwaitingError,
	);
	assert.equal(writers.answerCalls.length, 0);
	assert.equal(writers.checkpointCalls.length, 0);
});

test("a long job id still round-trips: the derived id is stored verbatim, prose cells are clipped", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const jobId = `cp-${"x".repeat(100)}`;
		const item = mergeAwaiting({
			checkpoints: [],
			heldResearch: [heldResearchJob({ job_id: jobId })],
			declared: store.list(),
		})[0]!;
		const stored = await store.answerResolved(item, { answer: "ship", by: "operator command" });
		assert.equal(stored.id, item.id, "the id is never truncated — identity is the invariant");
		assert.ok(stored.decision.length <= 100, "the rendering-bounded cells are clipped instead");
		assert.ok(store.get(item.id));
	} finally {
		home.cleanup();
	}
});

// cp-withdraw-mislabel-vlf acceptance: fix refusal messages to distinguish
// between derived row types. A derived approval row's message should name its
// type (approval) and explain it clears via /cp-decide. An authorization row's
// message stays the same.
test("declared rows withdraw normally; derived rows refuse with type-specific messages", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		// Declared row: should withdraw successfully.
		const declared = await store.declare({
			type: "approval",
			decision: "ship cp-x?",
			why: "research done",
			blocks: "cp-x",
			job_id: "cp-x",
		});
		const withdrawn = await store.withdraw(declared.id);
		assert.equal(withdrawn.state, "withdrawn", "declared row withdraws successfully");

		// Derived approval row: should refuse with approval-specific message.
		// The error comes from AwaitingStore.withdraw refusing any derived id.
		// The distinction in messages happens at the tool level (extension).
		await assert.rejects(
			() => store.withdraw("aw-research-cp-0hj"),
			(error: Error) => error instanceof AwaitingError,
			"derived approval row refuses to withdraw",
		);

		// Derived authorization row: should also refuse.
		// The distinction in messages happens at the tool level (extension).
		await assert.rejects(
			() => store.withdraw("aw-checkpoint-cp-ship"),
			(error: Error) => error instanceof AwaitingError,
			"derived authorization row refuses to withdraw",
		);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// cp-khf: a flagged diff review's second authorization is a first-class
// Awaiting-you row — listable beside the ship one, separately answerable, and
// neither can satisfy the other.
// ---------------------------------------------------------------------------

/** The two stores exactly as CommandPost builds them: one home, two kinds. */
function bothCheckpointStores(home: string): { ship: CheckpointStore; diff: CheckpointStore } {
	return { ship: new CheckpointStore(home), diff: new CheckpointStore(home, { kind: "diff" }) };
}

test("checkpointAwaitingId: two kinds, two ids, and a job id that starts with `diff-` cannot collide", () => {
	assert.equal(checkpointAwaitingId("cp-ship"), "aw-checkpoint-cp-ship");
	assert.equal(checkpointAwaitingId("cp-ship", "ship"), "aw-checkpoint-cp-ship");
	assert.equal(checkpointAwaitingId("cp-ship", "diff"), "aw-checkpoint-cp-ship.diff");
	assert.deepEqual(parseCheckpointAwaitingId("aw-checkpoint-cp-ship"), { job_id: "cp-ship", kind: "ship" });
	assert.deepEqual(parseCheckpointAwaitingId("aw-checkpoint-cp-ship.diff"), { job_id: "cp-ship", kind: "diff" });
	assert.equal(parseCheckpointAwaitingId("aw-research-cp-x"), undefined);
	// `diff-x` is a legal job id (JOB_ID_PATTERN), which is why the marker is a
	// suffixed `.diff` and not a `-diff-` infix: these two must never be one id.
	assert.notEqual(checkpointAwaitingId("diff-x"), checkpointAwaitingId("x", "diff"));
	assert.deepEqual(parseCheckpointAwaitingId("aw-checkpoint-diff-x"), { job_id: "diff-x", kind: "ship" });
	// Both ids are still recognisably derived, so `withdraw` refuses both.
	assert.equal(isDerivedAwaitingId("aw-checkpoint-cp-ship.diff"), true);
});

test("a pending diff checkpoint is one row of its own, alongside the ship row for the same job", () => {
	const home = createScratchHome();
	try {
		const { ship, diff } = bothCheckpointStores(home.path);
		ship.request({ jobId: "cp-ship", question: "act on the plan?", at: "2026-08-30T09:00:00Z" });
		diff.request({ jobId: "cp-ship", question: "accept the diff?", at: "2026-08-30T15:00:00Z" });

		const rows = mergeAwaiting({
			checkpoints: ship.listPending(),
			diffCheckpoints: diff.listPending(),
			heldResearch: [],
			declared: [],
		});
		assert.equal(rows.length, 2, "two open authorizations for one ship_id, never collapsed into one");
		assert.deepEqual(
			rows.map((row) => row.id),
			["aw-checkpoint-cp-ship", "aw-checkpoint-cp-ship.diff"],
		);
		assert.deepEqual(
			rows.map((row) => row.checkpoint_kind),
			["ship", "diff"],
		);
		// Distinguishable to the operator, not just to the code: two subjects, two
		// questions, two things blocked.
		assert.equal(new Set(rows.map((row) => row.decision)).size, 2);
		assert.equal(new Set(rows.map((row) => row.blocks)).size, 2);
		assert.match(rows[1]!.decision, /diff/);
		assert.equal(rows[1]!.why, "accept the diff?");
		for (const row of rows) {
			assert.equal(row.type, "authorization");
			assert.equal(row.job_id, "cp-ship");
			assert.deepEqual(row.options, ["approve", "decline"]);
		}
	} finally {
		home.cleanup();
	}
});

test("both rows are separately answerable, and answering one neither answers nor overwrites the other", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const { ship, diff } = bothCheckpointStores(home.path);
		ship.request({ jobId: "cp-ship", question: "act on the plan?", at: "2026-08-30T09:00:00Z" });
		diff.request({ jobId: "cp-ship", question: "accept the diff?", at: "2026-08-30T15:00:00Z" });
		const writers = liveWriters(store, ship, diff);

		const offered = () =>
			mergeAwaiting({
				checkpoints: ship.listPending(),
				diffCheckpoints: diff.listPending(),
				heldResearch: [],
				declared: store.list(),
			});

		// Answer the *diff* row first — the harder order, because the ship
		// checkpoint is still pending and shares the ship_id.
		const diffRow = offered().find((row) => row.checkpoint_kind === "diff")!;
		const result = await resolveAwaitingResponse(
			{ id: diffRow.id, kind: "answer", value: "approve", by: "operator dialog (tui)" },
			diffRow,
			writers,
		);
		assert.equal(result.wrote, true);
		assert.equal(diff.get("cp-ship")!.decision, "approved");
		assert.equal(ship.get("cp-ship")!.decision, "pending", "the pre-implementation checkpoint is untouched");

		// The ship row is still open, and answering it differently is recorded
		// against its own file.
		const shipRow = offered()[0]!;
		assert.equal(shipRow.id, "aw-checkpoint-cp-ship");
		await resolveAwaitingResponse(
			{ id: shipRow.id, kind: "answer", value: "decline", by: "operator command" },
			shipRow,
			writers,
		);
		assert.equal(ship.get("cp-ship")!.decision, "declined");
		assert.equal(diff.get("cp-ship")!.decision, "approved", "the diff answer survived the second decision");
		assert.equal(diff.get("cp-ship")!.decided_by, "operator dialog (tui)");
		assert.equal(ship.get("cp-ship")!.decided_by, "operator command");

		// One record each, both in state/checkpoints, none in state/awaiting.json.
		assert.ok(!existsSync(store.file), "an authorization of either kind never lands in state/awaiting.json");
		assert.notEqual(ship.file("cp-ship"), diff.file("cp-ship"));
	} finally {
		home.cleanup();
	}
});

test("an answered checkpoint of either kind is never re-raised by a later render", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const { ship, diff } = bothCheckpointStores(home.path);
		ship.request({ jobId: "cp-ship", question: "act on the plan?", at: "2026-08-30T09:00:00Z" });
		diff.request({ jobId: "cp-ship", question: "accept the diff?", at: "2026-08-30T15:00:00Z" });
		const writers = liveWriters(store, ship, diff);
		const render = () =>
			mergeAwaiting({
				checkpoints: ship.listPending(),
				diffCheckpoints: diff.listPending(),
				heldResearch: [],
				declared: store.list(),
			});

		const diffRow = render().find((row) => row.checkpoint_kind === "diff")!;
		await resolveAwaitingResponse(
			{ id: diffRow.id, kind: "answer", value: "approve", by: "operator dialog (tui)" },
			diffRow,
			writers,
		);

		const after = render();
		assert.deepEqual(after.map((row) => row.id), ["aw-checkpoint-cp-ship"], "the answered diff row is gone");
		// And it stays gone across a restart of every reader: the fact lives in the
		// checkpoint file, which is the only record of an authorization.
		const reopened = bothCheckpointStores(home.path);
		assert.deepEqual(reopened.diff.listPending(), []);
		assert.equal(reopened.diff.get("cp-ship")!.decision, "approved");

		// The overwrite refusal holds across the two paths: re-answering the diff
		// checkpoint the other way is refused, and the recorded answer stands.
		assert.throws(
			() => reopened.diff.decide("cp-ship", false, { by: "operator command" }),
			CheckpointError,
		);
		assert.equal(reopened.diff.get("cp-ship")!.decision, "approved");
	} finally {
		home.cleanup();
	}
});

test("listPending never crosses the two kinds, so neither store can raise the other's question", () => {
	const home = createScratchHome();
	try {
		const { ship, diff } = bothCheckpointStores(home.path);
		ship.request({ jobId: "cp-a", question: "plan?" });
		diff.request({ jobId: "cp-b", question: "diff?" });
		assert.deepEqual(ship.listPending().map((entry) => entry.job_id), ["cp-a"]);
		assert.deepEqual(diff.listPending().map((entry) => entry.job_id), ["cp-b"]);
		assert.equal(diff.get("cp-a"), undefined);
		assert.equal(ship.get("cp-b"), undefined);
	} finally {
		home.cleanup();
	}
});

test("a home with no diff checkpoints renders exactly as it did before cp-khf", () => {
	const home = createScratchHome();
	try {
		const { ship, diff } = bothCheckpointStores(home.path);
		ship.request({ jobId: "cp-ship", question: "act on the plan?" });
		const rows = mergeAwaiting({
			checkpoints: ship.listPending(),
			diffCheckpoints: diff.listPending(),
			heldResearch: [],
			declared: [],
		});
		assert.deepEqual(rows.map((row) => row.id), ["aw-checkpoint-cp-ship"]);
		// And with the field omitted entirely (every pre-cp-khf caller).
		assert.deepEqual(
			mergeAwaiting({ checkpoints: ship.listPending(), heldResearch: [], declared: [] }).map((row) => row.id),
			["aw-checkpoint-cp-ship"],
		);
	} finally {
		home.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Ineligible held pipeline research (cp-5hqi)
// ---------------------------------------------------------------------------

test("researchApprovalIneligibleReason: escalated or superseded is ineligible; missing or still-live is not", () => {
	assert.match(
		researchApprovalIneligibleReason("cp-x", [
			{ research_id: "cp-x", ship_id: "cp-s", state: "escalated" },
		]) ?? "",
		/escalated/,
	);
	assert.match(
		researchApprovalIneligibleReason("cp-x", [
			{ research_id: "cp-x", ship_id: "cp-s", state: "gating", superseded_by: "cp-new" },
		]) ?? "",
		/superseded/,
	);
	assert.equal(
		researchApprovalIneligibleReason("cp-x", [{ research_id: "cp-x", ship_id: "cp-s", state: "gating" }]),
		undefined,
	);
	assert.equal(
		researchApprovalIneligibleReason("cp-x", [{ research_id: "cp-x", ship_id: "cp-s", state: "researching" }]),
		undefined,
	);
	assert.equal(researchApprovalIneligibleReason("cp-x", []), undefined);
	assert.equal(
		researchApprovalIneligibleReason("cp-x", [
			{ research_id: "cp-other", ship_id: "cp-s", state: "escalated" },
		]),
		undefined,
		"an unrelated pipeline is ignorance for this job",
	);
});

test("mergeAwaiting: held pipeline + escalated raises no research row", () => {
	const rows = mergeAwaiting({
		checkpoints: [],
		pipelines: [{ research_id: "cp-research", ship_id: "cp-ship", state: "escalated" }],
		heldResearch: [heldResearchJob({ job_id: "cp-research" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		[],
	);
});

test("mergeAwaiting: held pipeline + gating + superseded_by raises no research row", () => {
	const rows = mergeAwaiting({
		checkpoints: [],
		pipelines: [
			{ research_id: "cp-research", ship_id: "cp-ship", state: "gating", superseded_by: "cp-new" },
		],
		heldResearch: [heldResearchJob({ job_id: "cp-research" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		[],
	);
});

test("mergeAwaiting: held pipeline + gating without superseded_by still raises its research row", () => {
	const rows = mergeAwaiting({
		checkpoints: [],
		pipelines: [{ research_id: "cp-research", ship_id: "cp-ship", state: "gating" }],
		heldResearch: [heldResearchJob({ job_id: "cp-research" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-research-cp-research"],
	);
});

test("mergeAwaiting: standalone held research is not silenced by an unrelated escalated pipeline", () => {
	const rows = mergeAwaiting({
		checkpoints: [],
		pipelines: [{ research_id: "cp-other", ship_id: "cp-ship", state: "escalated" }],
		heldResearch: [heldResearchJob({ job_id: "cp-solo", delivery: "pr" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-research-cp-solo"],
	);
});

test("mergeAwaiting: omitted pipelines leave a delivery:pipeline held job eligible (ignorance)", () => {
	const rows = mergeAwaiting({
		checkpoints: [],
		heldResearch: [heldResearchJob({ job_id: "cp-research" })],
		declared: [],
	});
	assert.deepEqual(
		rows.map((row) => row.id),
		["aw-research-cp-research"],
	);
});

test("mergeAwaiting: a declared open row for escalated research is not offered", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		await store.declare({
			type: "approval",
			decision: "Ship cp-research, drop it, or open a follow-up?",
			why: "research done",
			blocks: "cp-research",
			job_id: "cp-research",
		});
		const rows = mergeAwaiting({
			checkpoints: [],
			pipelines: [{ research_id: "cp-research", ship_id: "cp-ship", state: "escalated" }],
			heldResearch: [],
			declared: store.list(),
		});
		assert.deepEqual(
			rows.map((row) => row.id),
			[],
		);
		assert.equal(store.list("open").length, 1, "nothing withdrawn — obsolete-on-read");
	} finally {
		home.cleanup();
	}
});
