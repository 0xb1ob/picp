/**
 * cur.5.1: parent under `pi --mode rpc` — CI watch and deferred-row release
 * with no TUI; a mid-turn wake-up is queued, never dropped.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { CiWatchStore } from "../../src/ci-watch.ts";
import { formatContinuationNotice } from "../../src/held-continuation.ts";
import { listPendingReviews } from "../../src/review-runs.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { readPendingSends } from "../../src/viewer/control-pending.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { FleetStore } from "../../src/fleet.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import {
	COMMAND_POST_EXTENSION,
	CP_BRIDGE_EXTENSION,
	createAgentDir,
	createScratchHome,
	MockProvider,
	readRunEvents,
	REPO_ROOT,
	startPiChild,
	startRpc,
	waitFor,
} from "../harness/index.ts";

import { JOB, PR, seedHeldHome, writeReviewPass } from "../harness/held-home.ts";

test("/doctor under rpc names the mode and running timers", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-doctor", [{ kind: "text", text: "Ready." }]);
	const agent = createAgentDir({ provider });
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "--model", model, "-e", COMMAND_POST_EXTENSION],
		env: { ...agent.env, CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		agent.cleanup();
		await provider.stop();
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
async function startParent(t: { after(fn: () => unknown): void }, held: Held, script: string, retrySeconds?: string, busy = false) {
	const provider = await MockProvider.start();
	const model = provider.addScript(script, busy ? [{ kind: "hang", ms: 15_000 }, { kind: "text", text: "acknowledged" }]
		: [{ kind: "text", text: "acknowledged" }], { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: held.home.path,
		model,
		env: { ...agentDir.env, CP_HOME: held.home.path, PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1",
			...(retrySeconds ? { CP_CI_WATCH_DELIVERY_RETRY_SECONDS: retrySeconds } : {}) },
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
	const relay = await notified(first.child, /CI GREEN|CI\/PR OBSERVED/);
	assert.match(String(relay.message), /handled in code, no parent turn\./);
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
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});
	mkdirSync(join(held.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}\n');
	const parent = await startParent(t, held, "headless-green-off", "1", true);
	await parent.child.prompt("Keep working while the watch runs.");
	await waitFor(parent.turns, (n) => n === 1, { timeoutMs: 30_000, what: "the operator's in-flight turn" });
	writeFileSync(held.stateFile, "green\n");
	await waitFor(() => parent.child.records().filter((r) => r.type === "extension_ui_request" && /CI\/PR OBSERVED/.test(String(r.message))).length,
		(n) => n >= 2, { timeoutMs: 30_000, what: "the unconfirmed key's bounded resend" });
	await waitFor(parent.turns, (n) => n >= 2, { timeoutMs: 30_000, what: "the queued watch fact reaches the provider" });
	assert.match(parent.requestText(), /CI\/PR OBSERVED/);
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
async function queuedThroughCompaction(t: { after(fn: () => unknown): void }, script: string, drops: number, automatic = false) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const settings = join(home.path, LAYOUT.data, "operator.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: automatic ? 100_000_000 : 1 }));
	const dropper = join(home.path, "dashboard-drop.ts");
	const dropLog = join(home.path, "dashboard-drops.log");
	writeFileSync(dropper, DASHBOARD_DROP);
	writeFileSync(dropLog, "");
	const provider = await MockProvider.start();
	const model = provider.addScript(script, [
		{ kind: "tool_calls", calls: [automatic ? { name: "bash", args: { command: "true" } } : { name: "self_compact", args: { instructions: COMPACT_INSTRUCTIONS } }] },
		{ kind: "hang", ms: 3000 },
		...(automatic ? [
			{ kind: "tool_calls" as const, calls: [{ name: "self_compact", args: { instructions: COMPACT_INSTRUCTIONS } }] },
			{ kind: "text" as const, text: "Finishing the compact-request turn." },
		] : []),
		{ kind: "hang", ms: 500 },
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
	// Rearm only the automatic-request variant; a queued self_compact needs the trigger raised before settlement.
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: automatic ? 1 : 100_000_000 }));
	const sent = await controlRequest(control, "send", { kind: "message", text: "list the validator owner wallets" });
	assert.ok(sent.ok && (sent.result as { state: string }).state === "queued", JSON.stringify(sent));
	const id = (sent.result as { id: string }).id;
	if (automatic) {
		await waitFor(() => provider.requests(script).length, (n) => n >= 4, { timeoutMs: 30_000, what: "compact-request tool reply" });
		writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
	}
	await rpc.waitFor((r) => r.type === "compaction_start", 30_000);
	const edited = await controlRequest(control, "queue_edit", { id, text: "list the validator owner wallets" });
	assert.ok(edited.ok && (edited.result as { editable?: boolean }).editable, `held while compacting: ${JSON.stringify(edited)}`);
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


test("rpc bridge S24: a queued message survives compaction without a dropped handoff", { timeout: 110_000 }, async (t) => {
	const run = await queuedThroughCompaction(t, "dashboard-compact-no-drop", 0, true);
	await waitFor(() => run.states(), (s) => s.at(-1) === "delivered", { timeoutMs: 30_000, what: "queued dashboard delivery" });
	assert.deepEqual(run.states(), ["request", "queued", "injected", "delivered"]);
	const consumed = await waitFor(() => run.consumed(), (c) => c.length === 1, { timeoutMs: 30_000, what: "one consumed message" });
	const records = run.rpc.records();
	assert.ok(records.findIndex((r) => r.type === "compaction_end") < records.indexOf(consumed[0]!), "held through compaction");
	assert.equal(run.pending(), "delivered");
	assert.equal(run.dropped(), 0);
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

test("S20: reported envelope heads survive failed watch queries until a newer remote observation supersedes the verdict", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	writeReviewPass(held.home.path, held.headSha);
	const store = new CiWatchStore({ home: held.home.path });
	const oldAt = "2026-08-31T12:40:00Z";
	const envelopeAt = "2026-08-31T12:45:43Z";
	const staleHead = "3d3355f0c4d2".padEnd(40, "0");
	mkdirSync(join(held.home.path, paths.runDir(JOB)), { recursive: true });
	writeFileSync(join(held.home.path, paths.envelopeFile(JOB)), JSON.stringify({
		schema_version: SCHEMA_VERSION, job_id: JOB, received_at: envelopeAt, attempt: 1,
		envelope: { job_id: JOB, kind: "ship", status: "done", summary: "S20", head_sha: held.headSha },
	}));
	store.record(JOB, { head_sha: staleHead, head_observed_at: oldAt, last_checked_at: oldAt });
	writeFileSync(held.stateFile, "offline\n");
	const injector = join(held.home.path, "s20-verdict.ts");
	writeFileSync(injector, `export default function(pi) {
		let sequence = 0;
		pi.registerCommand("s20head", { description: "Replay a persisted verdict", handler: async () => {
			pi.sendMessage({ customType: "cp-verdict", content: "S20 authoritative verdict " + (++sequence), display: true,
				details: { cp_wakeup: { kind: "verdict", job_id: ${JSON.stringify(JOB)}, keys: ["review", String(sequence), ${JSON.stringify(held.headSha)}],
				issued_at: new Date().toISOString() } } }, { triggerTurn: true });
		} });
	}`);
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-head", [{ kind: "text", text: "Head checked." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1" },
		extensions: [COMMAND_POST_EXTENSION, injector] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.home.cleanup(); held.repo.cleanup(); });
	await waitFor(() => store.job(JOB), (job) => (job?.consecutive_failures ?? 0) > 0, {
		timeoutMs: 30_000, what: "failed production CI watch query",
	});
	assert.equal(store.job(JOB)?.head_observed_at, oldAt, "failed queries must not freshen a stale head");
	await child.prompt("/s20head");
	await child.waitForSettled(60_000);
	assert.match(JSON.stringify(provider.requests("s20-head").at(-1)?.body.messages), /S20 authoritative verdict/);
	const moved = "cc55dd66ee77".padEnd(40, "0");
	writeFileSync(held.headFile, moved + "\n");
	writeFileSync(held.stateFile, "in_progress\n");
	store.record(JOB, { next_due_at: oldAt });
	await waitFor(() => store.job(JOB), (job) => job?.head_sha === moved, {
		timeoutMs: 30_000, what: "a genuine newer remote head",
	});
	const decision = JSON.parse(readFileSync(join(held.home.path, paths.reviewFile(JOB, 1)), "utf8"));
	for (const attempt of [2, 3]) {
		writeFileSync(join(held.home.path, paths.reviewFile(JOB, attempt)), JSON.stringify({ ...decision, attempt }));
		const before = provider.requests("s20-head").length;
		await child.prompt("/s20head");
		await waitFor(() => provider.requests("s20-head"), (rows) => rows.length > before, {
			timeoutMs: 30_000, what: "superseded verdict at the provider boundary",
		});
		assert.doesNotMatch(JSON.stringify(provider.requests("s20-head").at(-1)?.body.messages), new RegExp(`S20 authoritative verdict ${attempt}`));
		await child.waitForSettled(60_000);
	}
	assert.equal(provider.remaining("s20-head"), 0);
});

test("S20: a green watch fact starts a real mock reviewer and relays without a parent request", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	unlinkSync(join(held.home.path, paths.pendingReviewFile(JOB, "review", 1)));
	const provider = await MockProvider.start();
	const reviewer = provider.addScript("s20-started-review", [{ kind: "hang" }]);
	const model = provider.addScript("s20-started-parent", [{ kind: "text", text: "Unexpected parent wake." }]);
	await new ProjectRegistry({ home: held.home.path }).setReviewerModel("demo", reviewer);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.home.cleanup(); held.repo.cleanup(); });
	await ciTicks(held, 2);
	writeFileSync(held.stateFile, "green\n");
	const relay = await notified(child, /CI GREEN|CI\/PR OBSERVED/);
	assert.match(String(relay.message), /handled in code, no parent turn\./);
	await waitFor(() => provider.requests("s20-started-review"), (rows) => rows.length === 1, {
		timeoutMs: 30_000, what: "the continuation's actual reviewer reaches the mock provider",
	});
	assert.deepEqual(wakeRuleEvents(held.home.path, "ci_green").map((e) => [e.decision, e.action, e.next_kind]), [["suppressed", "review_started", "no_mandate"]]);
	assert.equal(provider.requests("s20-started-parent").length, 0);
	assert.equal(listPendingReviews(held.home.path, JOB).length, 1);
});

test("S20: multi-fact green batches and a single red fact wake without a single-green ruling", { timeout: 120_000 }, async (t) => {
	for (const ciState of ["green", "red"] as const) {
		const held = await seedHeldHome({ ciState, review: "pending" });
		if (ciState === "green") {
			const fleet = new FleetStore({ home: held.home.path });
			await fleet.add({ ...fleet.get(JOB)!, job_id: "cp-second", branch: "cp-second" });
			const pending = JSON.parse(readFileSync(join(held.home.path, paths.pendingReviewFile(JOB, "review", 1)), "utf8"));
			mkdirSync(dirname(join(held.home.path, paths.pendingReviewFile("cp-second", "review", 1))), { recursive: true });
			writeFileSync(join(held.home.path, paths.pendingReviewFile("cp-second", "review", 1)), JSON.stringify({ ...pending, job_id: "cp-second" }));
			const box = new DurableWakeupOutbox({ home: held.home.path });
			box.enqueue({ id: "recovery:cp-second", kind: "recovery", job_id: "cp-second", content: "already relayed" });
			box.confirmDelivered(["recovery:cp-second"]);
		}
		const parent = await startParent(t, held, `s20-green-batch-${ciState}`);
		t.after(() => { held.home.cleanup(); held.repo.cleanup(); });
		const count = ciState === "green" ? 2 : 1;
		await waitFor(parent.requestText, (text) => text.includes(`CI/PR OBSERVED — ${count} new fact`), { timeoutMs: 30_000, what: "the watch facts reach the parent" });
		assert.match(parent.requestText(), /cp-held/);
		if (ciState === "green") assert.match(parent.requestText(), /cp-second/);
		await ciTicks(held, 2);
		assert.deepEqual(wakeRuleEvents(held.home.path, "ci_green"), []);
		await parent.close();
	}
});

test("S20: overlapping green sweeps leave one owner for a delayed continuation ruling", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	const parent = await startParent(t, held, "s20-green-overlap", "1");
	t.after(() => { held.home.cleanup(); held.repo.cleanup(); });
	await ciTicks(held, 3);
	writeFileSync(`${held.headFile}.delay`, "delay the public gh pr view call");
	writeFileSync(held.stateFile, "green\n");
	const duplicate = await notified(parent.child, /CI GREEN — /);
	assert.match(String(duplicate.message), /already being handled in code\./);
	unlinkSync(`${held.headFile}.delay`);
	await notified(parent.child, /CI GREEN — .* handled in code, no parent turn\./);
	await ciTicks(held, 2);
	assert.deepEqual(wakeRuleEvents(held.home.path, "ci_green").map((e) => [e.decision, e.action]), [["suppressed", "review_pending"]]);
	assert.equal(parent.turns(), 0);
	assert.equal(listPendingReviews(held.home.path, JOB).length, 1);
	await parent.close();
});

test("rpc parent S24: a CI fleet wake stays held across settlement until manual compaction", { timeout: 90_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress" });
	const provider = await MockProvider.start();
	mkdirSync(join(held.home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(held.home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 500 }));
	const model = provider.addScript("s24-parent-ci", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }], usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 4000)'" } }], usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "text", text: "S24 CI parent settled.", usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "text", text: "S24 CI parent summary.", usage: { prompt_tokens: 1000, completion_tokens: 1 } },
		{ kind: "text", text: "S24 CI wake answered.", usage: { prompt_tokens: 1000, completion_tokens: 1 } },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const child = startPiChild({ cwd: held.home.path, model, extensions: [COMMAND_POST_EXTENSION],
		env: { ...agent.env, CP_HOME: held.home.path, PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1", CP_PARENT_COMPACT_HOLD_SECONDS: "5" } });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.home.cleanup(); held.repo.cleanup(); });
	child.send({ type: "prompt", id: "busy", message: "S24 finish this run before answering the CI wake." });
	await waitFor(() => provider.requests("s24-parent-ci").length, (n) => n >= 2, { timeoutMs: 30_000, what: "over-threshold tool round" });
	writeFileSync(held.stateFile, "green\n");
	await notified(child, /CI\/PR OBSERVED/);
	await child.waitFor((r) => r.type === "agent_settled", 30_000);
	const ciWakes = () => child.records().filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "cp-ci");
	assert.equal(ciWakes().length, 0);
	const log = join(held.home.path, LAYOUT.state, "daemon.log");
	assert.match(readFileSync(log, "utf8"), /hold engaged phase=busy/);
	child.send({ type: "compact", id: "compact-ci" });
	const compact = await child.waitFor((r) => r.type === "response" && r.id === "compact-ci", 30_000);
	assert.equal(compact.success, true, JSON.stringify(compact));
	await child.waitFor((r) => r.type === "message_start" && ciWakes().length >= 1, 30_000);
	assert.equal(ciWakes().length, 1);
	assert.match(JSON.stringify(ciWakes()), /cp-held/);
	assert.ok(child.records().findIndex((r) => r.type === "compaction_end") < child.records().indexOf(ciWakes()[0]!), JSON.stringify(child.records().map((r, index) => ({ index, type: r.type, id: r.id, customType: (r.message as { customType?: string })?.customType })).filter((r) => r.customType || r.type.includes("compaction") || r.type === "agent_settled" || r.type === "response")));
});

for (const [mode, name] of [
	["ready", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: ready"],
	["revise", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: revise"],
	["red", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: red"],
	["running", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: running"],
	["late", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: late"],
	["late-failure", "rpc S19: a real review rechecks a deferred decision before delivering its verdict: late-failure"],
] as const) {
test(name, { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "none" });
	const late = mode === "late" || mode === "late-failure";
	if (late) for (const suffix of ["second", "third"]) await held.store.declareGated({ type: "approval",
		decision: `Ship cp-held (PR 58), ${suffix}?`, subject: `s19-${suffix}`, why: "S19 bounded recheck", blocks: "delivery", job_id: JOB });
	const provider = await MockProvider.start();
	const reviewer = provider.addScript("s19-deferred-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: JOB, verdict: mode === "revise" ? "revise" : "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: mode === "revise" ? ["[severity: high] [confidence: high] missing coverage"] : ["Reviewed the current diff"],
		...(mode === "revise" ? { revisions: ["Add the missing coverage"] } : {}),
	} }] }]);
	const diskSnapshot = () => ({ queries: readFileSync(held.ghLog, "utf8").split("\n").filter((line) => line.includes("/actions/runs?head_sha=")).length,
		awaiting: readFileSync(held.store.file, "utf8") });
	const snapshots: Array<{ state?: string; request: string; queries: number; awaiting: string }> = [];
	const capture = (request: { body: unknown }) => {
		snapshots.push({ ...diskSnapshot(), state: new AwaitingStore({ home: held.home.path }).list("open")[0]?.state,
			request: JSON.stringify((request.body as { messages: unknown[] }).messages.slice(-2)) });
		return { action: "list" };
	};
	const model = provider.addScript("s19-deferred-parent", [
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: () => {
			snapshots.push({ ...diskSnapshot(), state: new AwaitingStore({ home: held.home.path }).list("deferred")[0]?.state, request: "before review" });
			return { job_id: JOB, model: reviewer };
		} }] },
		{ kind: "text", text: "Review started." },
		{ kind: "tool_calls", calls: [{ name: "cp_awaiting", args: capture },
			...(mode === "ready" ? [{ name: "cp_status_block", args: {} }] : [])] },
		{ kind: "text", text: "The reviewed decision is ready." },
	]);
	const agent = createAgentDir({ provider });
	const recovery = new DurableWakeupOutbox({ home: held.home.path });
	recovery.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "Previously delivered recovery", keys: [JOB] });
	recovery.confirmDelivered([`recovery:${JOB}`]);
	new IntegrationHolds(held.home.path).hold(JOB, "S19 isolates verdict delivery before integration");
	writeReviewPass(held.home.path, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "3600" }, extensions: [COMMAND_POST_EXTENSION] });
	const awaitingDir = dirname(new AwaitingStore({ home: held.home.path }).file);
	t.after(async () => { chmodSync(awaitingDir, 0o700); await child.close(); agent.cleanup(); await provider.stop(); held.repo.cleanup(); held.home.cleanup(); });
	await waitFor(() => new CiWatchStore({ home: held.home.path }).job(JOB)?.last_checked_at, (at) => !!at,
		{ timeoutMs: 30_000, what: "initial running-CI catch-up completes" });
	writeFileSync(held.stateFile, mode === "red" ? "red\n" : mode === "running" ? "in_progress\n" : late ? "green:12000\n" : "green\n");
	await child.prompt("Review the held job and handle its verdict.");
	if (mode === "late-failure") {
		await waitFor(() => existsSync(join(held.home.path, paths.reviewFile(JOB, 2))), (written) => written,
			{ timeoutMs: 30_000, what: "review verdict persists before refusing the later awaiting write" });
		chmodSync(awaitingDir, 0o500);
	}
	await waitFor(() => snapshots.length, (count) => count === 2, { timeoutMs: 120_000, what: "actual reviewer verdict reaches parent model" });
	assert.equal(snapshots[0]?.state, "deferred", "stale review must leave current green head deferred");
	assert.equal(snapshots[1]?.state, mode === "ready" ? "open" : undefined,
		`row state when actual verdict reaches parent: ${JSON.stringify(new AwaitingStore({ home: held.home.path }).read().items.map(({ state, deferred_reason }) => ({ state, deferred_reason })))}`);
	assert.match(snapshots[1]?.request ?? "", new RegExp(`diff review attempt 2: ${mode === "revise" ? "revise" : "pass"}`));
	if (mode === "revise") {
		assert.equal(snapshots[1]!.queries, snapshots[0]!.queries, "a revise verdict must not read the CI gate");
		assert.equal(snapshots[1]!.awaiting, snapshots[0]!.awaiting, "a revise verdict must leave awaiting bytes unchanged");
	}
	if (mode === "late") {
		const readyNotices = () => child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("3 decisions are now ready"));
		await waitFor(readyNotices, (records) => records.length === 1, { timeoutMs: 60_000, what: "late gate announces actual opened decisions" });
		assert.equal(new AwaitingStore({ home: held.home.path }).list("open").length, 3);
		const notice = String(readyNotices()[0]!.message);
		assert.ok(notice.length <= 320 && !notice.includes("\n"), "late notice stays one bounded line");
	}
	assert.equal(new AwaitingStore({ home: held.home.path }).read().items.length, late ? 3 : 1, "recheck preserves decision identity");
	await waitFor(() => provider.remaining("s19-deferred-parent"), (remaining) => remaining === 0, { timeoutMs: 90_000, what: "parent consumes the decision reply" });
	if (mode === "late-failure") {
		assert.equal(new AwaitingStore({ home: held.home.path }).list("deferred").length, 3, "failed late write opens nothing");
		const failures = child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("deferred rows not re-gated"));
		assert.equal(failures.length, 1, "late failure must not report a second warning");
		assert.ok(!child.records().some((record) => String(record.message).includes("decisions are now ready")));
		chmodSync(awaitingDir, 0o700);
	}
	if (mode === "revise" || mode === "red" || mode === "running") {
		assert.equal(new AwaitingStore({ home: held.home.path }).list("deferred").length, 1);
		assert.equal(child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("decision is now ready")).length, 0);
	}
	assert.equal(provider.remaining("s19-deferred-reviewer"), 0);
	if (mode === "ready") {
		await new Promise((done) => setTimeout(done, 250));
		assert.equal(provider.requests("s19-deferred-parent").length, 4, "in-bound completion must not trigger a second late turn");
		const notices = child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("decision is now ready"));
		assert.equal(notices.length, 1, "one opening produces one operator notice");
		const notice = String(notices[0]!.message);
		assert.match(notice, /Ship cp-held \(PR 58\)/);
		assert.match(notice, /cp_decide/);
		assert.ok(notice.length <= 300 && !notice.includes("\n"));
	}
});
}
