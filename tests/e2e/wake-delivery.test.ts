import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FleetStore } from "../../src/fleet.ts";
import {
	DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION,
	SHIPPED_SEEN_KEEP_SESSIONS, SHIPPED_SEEN_MAX_IDS,
} from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { AnsweredOutbox } from "../../src/answered.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { frameBatch } from "../../src/parent-outbox.ts";
import { REPO_ROOT, readRunEvents, waitFor } from "../harness/index.ts";
import { FAILURE_CLASSES, type FleetRecord } from "../../src/contracts.ts";
import { checkWakeup, wakeupFacts } from "../../src/wakeups.ts";
import { dirname } from "node:path";
import { EscalationRelayLedger, escalationRelayLedgerFile } from "../../src/escalation-backstop.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { attachParentHost, currentHost, parentHostPaths, type ParentHostClient } from "../../src/parent-host.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { CP_BRIDGE_EXTENSION } from "../harness/index.ts";

test("S20: shipped rows collapse through cp_status_block and survive a resumed parent", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-status", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {
			labels: [{ job_id: "cp-s20-shipped", label: "changed label" }],
			awaiting: [{ type: "approval", decision: "S20 decision", why: "research finished", blocks: "follow-up" }],
		} }] },
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: () => {
			const file = join(home.path, LAYOUT.fleetFile);
			const data = JSON.parse(readFileSync(file, "utf8"));
			data.jobs.push({ ...data.jobs[0], job_id: "cp-s20-new", branch: "cp-s20-new",
				receipts: [{ kind: "pr", status: "merged", title: "New", url: "https://github.com/example/demo/pull/21" }] });
			writeFileSync(file, JSON.stringify(data));
			return {};
		} }] },
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: () => {
			writeFileSync(join(home.path, LAYOUT.shippedSeenFile), "{corrupt");
			return {};
		} }] },
		{ kind: "text", text: "Status reported." },
	]);
	const resumedModel = provider.addScript("s20-resumed", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "text", text: "Status still reported." },
	]);
	const freshModel = provider.addScript("s20-fresh", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "text", text: "Fresh session checked." },
	]);
	const newestModel = provider.addScript("s20-newest", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: {} }] },
		{ kind: "text", text: "Session bound checked." },
	]);
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const now = isoTimestamp();
	await new FleetStore({ home: home.path }).add({
		job_id: "cp-s20-shipped", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "done", worktree: join(home.path, "wt"), branch: "cp-s20-shipped", dispatched_at: now,
		reported_at: now, closed_at: now, closed_reason: "gated", usage: EMPTY_USAGE,
		receipts: [{ kind: "pr", status: "merged", title: "Shipped", url: "https://github.com/example/demo/pull/20" }],
		worker: { pid: 4242, session_id: "s20-worker", session_file: join(home.path, "worker.jsonl"),
			profile: "implementer", role: "implementer", model, started_at: now, exited_at: now, exit_code: 0 },
	});
	const env = { ...agent.env, CP_HOME: home.path };
	const first = startPiChild({
		cwd: home.path, model, env, extensions: [COMMAND_POST_EXTENSION], sessionDir: join(home.path, "sessions"),
	});
	children.push(first);
	writeFileSync(join(home.path, LAYOUT.shippedSeenFile), "{initial-corruption");
	await first.prompt("Render the status twice.");
	await first.waitForSettled(60_000);
	const results = first.eventsOfType("tool_execution_end").filter((r) => r.toolName === "cp_status_block");
	assert.equal(results.length, 4);
	assert.match(JSON.stringify(results[0]), /pull\/20/);
	assert.match(JSON.stringify(results[1]), /none new \(1 already reported\)/);
	assert.match(JSON.stringify(results[1]), /S20 decision/);
	assert.match(JSON.stringify(results[2]), /pull\/21/);
	assert.doesNotMatch(JSON.stringify(results[2]), /pull\/20/);
	assert.match(JSON.stringify(results[3]), /none new \(2 already reported\)/);
	const warnings = JSON.stringify(first.records().filter((r) => r.type === "extension_ui_request"));
	assert.match(warnings, /Shipped memory unreadable/);
	assert.match(warnings, /safe to delete/);
	assert.match(warnings, /rebuilt/);
	const state = await first.getState();
	assert.equal(typeof state.sessionFile, "string");
	await first.close();
	const resumed = startPiChild({
		cwd: home.path, model: resumedModel, env, extensions: [COMMAND_POST_EXTENSION],
		sessionFile: state.sessionFile as string,
	});
	children.push(resumed);
	await resumed.prompt("Render status after resuming.");
	await resumed.waitForSettled(60_000);
	const result = resumed.eventsOfType("tool_execution_end").find((r) => r.toolName === "cp_status_block");
	assert.match(JSON.stringify(result), /none new \(2 already reported\)/);
	assert.doesNotMatch(JSON.stringify(result), /pull\/20/);
	await resumed.close();
	const fresh = startPiChild({ cwd: home.path, model: freshModel, env, extensions: [COMMAND_POST_EXTENSION] });
	children.push(fresh);
	const freshState = await fresh.getState();
	assert.equal(typeof freshState.sessionId, "string");
	const memory = JSON.parse(readFileSync(join(home.path, LAYOUT.shippedSeenFile), "utf8"));
	const originalSession = memory.sessions[0];
	const sessions = [originalSession, ...Array.from({ length: SHIPPED_SEEN_KEEP_SESSIONS - 2 }, (_, i) => ({
		session_id: `seed-${i}`, shipped_ids: [`cp-seed-${i}`], updated_at: now,
	})), { session_id: freshState.sessionId, updated_at: now,
		shipped_ids: Array.from({ length: SHIPPED_SEEN_MAX_IDS }, (_, i) => `cp-old-${i}`) }];
	writeFileSync(join(home.path, LAYOUT.shippedSeenFile), JSON.stringify({ schema_version: SCHEMA_VERSION,
		updated_at: now, sessions }));
	await fresh.prompt("Render fresh session twice.");
	await fresh.waitForSettled(60_000);
	const freshResults = fresh.eventsOfType("tool_execution_end").filter((r) => r.toolName === "cp_status_block");
	assert.match(JSON.stringify(freshResults[0]), /pull\/20/);
	assert.match(JSON.stringify(freshResults[0]), /pull\/21/);
	assert.match(JSON.stringify(freshResults[1]), /none new \(2 already reported\)/);
	const bounded = JSON.parse(readFileSync(join(home.path, LAYOUT.shippedSeenFile), "utf8"));
	assert.equal(bounded.sessions.length, SHIPPED_SEEN_KEEP_SESSIONS);
	assert.deepEqual(bounded.sessions.find((s: { session_id: string }) => s.session_id === originalSession.session_id),
		originalSession, "another writer must preserve the original session");
	const current = bounded.sessions.at(-1);
	assert.equal(current.session_id, freshState.sessionId);
	assert.equal(current.shipped_ids.length, SHIPPED_SEEN_MAX_IDS);
	assert.deepEqual(current.shipped_ids.slice(-2), ["cp-s20-new", "cp-s20-shipped"]);
	await fresh.close();
	const newest = startPiChild({ cwd: home.path, model: newestModel, env, extensions: [COMMAND_POST_EXTENSION] });
	children.push(newest);
	const newestState = await newest.getState();
	await newest.prompt("Render one more session.");
	await newest.waitForSettled(60_000);
	const trimmed = JSON.parse(readFileSync(join(home.path, LAYOUT.shippedSeenFile), "utf8"));
	assert.equal(trimmed.sessions.length, SHIPPED_SEEN_KEEP_SESSIONS);
	assert.equal(trimmed.sessions.at(-1).session_id, newestState.sessionId);
	assert.ok(!trimmed.sessions.some((s: { session_id: string }) => s.session_id === originalSession.session_id));
	assert.equal(provider.remaining("s20-newest"), 0);
	assert.equal(provider.remaining("s20-fresh"), 0);
	assert.equal(provider.remaining("s20-status"), 0);
	assert.equal(provider.remaining("s20-resumed"), 0);
});

 test("S20: persisted stale notices are filtered at the actual provider boundary", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-context", [
		{ kind: "text", text: "Context checked." },
		{ kind: "text", text: "Tail checked." },
		{ kind: "text", text: "Reload checked." },
	]);
	const agent = createAgentDir({ provider });
	const session = join(home.path, "legacy.jsonl");
	mkdirSync(join(home.path, paths.runDir("cp-gone")), { recursive: true });
	const stamp = (kind: string, extra = {}) => ({ kind, job_id: "cp-gone", issued_at: "2026-09-26T08:00:00Z", ...extra });
	const messages = [
		{ role: "user", content: "Keep this ordinary user message" },
		...["envelope", "ci", "verdict"].map((kind) => ({ role: "custom", customType: `cp-${kind}`,
			content: `OBSOLETE-${kind}`, display: true, details: { cp_wakeup: stamp(kind) } })),
		{ role: "custom", customType: "cp-answered", content: "FRESH-ANSWER", display: true,
			details: { cp_wakeup: stamp("answered", { keys: ["aw-new"] }) } },
		{ role: "custom", customType: "cp-answered", content: "DUPLICATE-ANSWER", display: true,
			details: { cp_wakeup: stamp("answered", { keys: ["aw-new"] }) } },
		{ role: "custom", customType: "cp-verdict", content: "OBSOLETE-INTEGRATE", display: true,
			details: { cp_wakeup: stamp("verdict"), verdict: { reasons: ["medium: preserve these findings"] } } },
		{ role: "custom", customType: "cp-recovery", content: "LANDED-FIRST", display: true,
			details: { durable_id: "continuation:cp-gone:1:done", cp_wakeup: stamp("recovery") } },
		{ role: "custom", customType: "cp-recovery", content: "LANDED-DUPLICATE", display: true,
			details: { durable_id: "continuation:cp-gone:1:done", cp_wakeup: stamp("recovery", {
				issued_at: "2026-09-26T08:04:00Z",
			}) } },
		{ role: "custom", customType: "cp-recovery", content: "JOBLESS-GONE", display: true,
			details: { cp_wakeup: { kind: "recovery", keys: ["cp-gone"], issued_at: "2026-09-26T08:05:00Z" } } },
	];
	const timestamp = new Date().toISOString();
	let parentId: string | null = null;
	const rows: unknown[] = [{ type: "session", version: 3, id: "s20-context-session", timestamp, cwd: home.path }];
	for (const [index, message] of messages.entries()) {
		const id = `message-${index}`;
		rows.push({ type: "message", id, parentId, timestamp, message: { ...message, timestamp: Date.now() } });
		parentId = id;
	}
	writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const injector = join(home.path, "notice-injector.ts");
	writeFileSync(injector, `export default function(pi) {
		pi.registerCommand("s20tail", { description: "Replay a legacy stale tail", handler: async () => {
			pi.sendMessage({ customType: "cp-verdict", content: "OBSOLETE-TAIL", display: true,
				details: { cp_wakeup: ${JSON.stringify(stamp("verdict"))} } }, { triggerTurn: true });
		} });
	}`);
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION, injector], sessionFile: session });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Inspect the carried context.");
	await child.waitForSettled(60_000);
	const request = JSON.stringify(provider.requests("s20-context").map((r) => r.body.messages));
	assert.match(request, /Keep this ordinary user message/);
	assert.doesNotMatch(request, /OBSOLETE-|DUPLICATE-ANSWER/);
	assert.match(request, /FRESH-ANSWER/);
	assert.match(request, /medium: preserve these findings/);
	assert.doesNotMatch(request, /OBSOLETE-INTEGRATE/);
	assert.match(request, /LANDED-FIRST/);
	assert.doesNotMatch(request, /LANDED-DUPLICATE|JOBLESS-GONE/);
	const suppressed = readRunEvents(home.path, "cp-gone").filter((e) => e.type === "wakeup_suppressed");
	const payloads = suppressed.map((e) => e.payload as { kind: string; stage: string; reason: string; keys?: string[] });
	for (const kind of ["envelope", "ci", "verdict", "answered", "recovery"]) {
		assert.ok(payloads.some((p) => p.kind === kind && p.stage === "delivery" && p.reason.length > 0));
	}
	assert.ok(payloads.some((p) => p.kind === "answered" && p.keys?.includes("aw-new")));
	assert.ok(payloads.some((p) => p.keys?.includes("cp-gone") && /every candidate/.test(p.reason)));
	assert.doesNotMatch(JSON.stringify(suppressed), /OBSOLETE-|FRESH-ANSWER|LANDED-FIRST/);
	assert.match(readFileSync(session, "utf8"), /OBSOLETE-envelope/, "filtering must not mutate persisted history");
	const offset = child.records().length;
	await child.prompt("/s20tail");
	await child.waitFor((r) => r.type === "agent_settled" && child.records().indexOf(r) >= offset, 60_000);
	const tailRequest = JSON.stringify(provider.requests("s20-context")[1]?.body.messages);
	assert.doesNotMatch(tailRequest, /OBSOLETE-TAIL/);
	assert.match(tailRequest, /A fleet notice queued for this turn was withdrawn before delivery/);
	await child.close();
	const resumed = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION], sessionFile: session });
	t.after(() => resumed.close());
	await resumed.prompt("Recheck the persisted notices after reload.");
	await resumed.waitForSettled(60_000);
	const reloaded = JSON.stringify(provider.requests("s20-context")[2]?.body.messages);
	assert.match(reloaded, /FRESH-ANSWER/);
	assert.match(reloaded, /LANDED-FIRST/);
	assert.doesNotMatch(reloaded, /OBSOLETE-|DUPLICATE-ANSWER|LANDED-DUPLICATE|JOBLESS-GONE/);
	await resumed.close();
	assert.equal(provider.remaining("s20-context"), 0);
});

test("S20: busy durable wakes wait for an operator answer and late notices receive one nudge", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	initJobsDocument(home.path, "cp");
	const seed = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await seed.registry.register({ name: "demo", clone_url: home.path, delivery: "local" });
	const ready = await seed.ledger().create({ title: "S20 ready work", project: "demo", delivery: "local", kind: "ship" });
	seed.mandates.issue({ projects: ["demo"], objective: "S20 wake authority", job_ids: [ready.id],
		expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [] });
	await seed.shutdown();
	// A timed reply can settle and erase send records before the test observes the busy state.
	const holds = Array.from({ length: 3 }, () => {
		let release!: () => void;
		const until = new Promise<void>((resolve) => { release = resolve; });
		return { until, release };
	});
	const model = provider.addScript("s20-busy", [
		{ kind: "hang", until: holds[0]!.until }, { kind: "hang", until: holds[1]!.until },
		{ kind: "hang", until: holds[2]!.until }, { kind: "text", text: "Notices handled." },
	]);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION], sessionDir: join(home.path, "sessions") });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const box = new DurableWakeupOutbox({ home: home.path });
	const queue = (id: string) => box.enqueue({ id, kind: "recovery", content: `S20-BUSY-${id}` });
	const requests = () => provider.requests("s20-busy");
	await child.prompt(frameBatch([{ id: "ps-20300101000000-0000000a", text: "S20 operator question" }]));
	await waitFor(requests, (r) => r.length === 1, { timeoutMs: 30_000, what: "first busy request" });
	queue("w1"); queue("w2"); queue("w3");
	await waitFor(() => ({ outbox: box.read(), requests: requests().length }), (state) => (state.outbox.sends ?? []).length === 3, {
		timeoutMs: 30_000, what: "durable notices offered to the parent (outbox and request count)",
	});
	assert.equal(requests().length, 1, "an unanswered operator send cannot start a notice turn");
	const state = await child.getState();
	assert.doesNotMatch(readFileSync(state.sessionFile as string, "utf8"), /S20-BUSY-w[123]/,
		"held notices must not enter the session before the operator answer");
	const answers = new AnsweredOutbox({ home: home.path });
	answers.enqueue({ id: "aw-s20-held", type: "approval", decision: "S20 answer bypasses hold",
		answer: "continue", answered_by: "operator dialog (tui)" });
	await waitFor(() => answers.read().sends ?? [], (sends) => sends.length > 0, {
		timeoutMs: 30_000, what: "answer offered while operator question is unanswered",
	});
	holds[0]!.release();
	await waitFor(requests, (r) => r.length === 2, { timeoutMs: 30_000, what: "notice request after operator answer" });
	const carried = JSON.stringify(requests()[1]?.body.messages);
	for (const id of ["w1", "w2", "w3"]) assert.match(carried, new RegExp(`S20-BUSY-${id}`));
	assert.ok(carried.indexOf("S20 answer bypasses hold") >= 0);
	queue("w4");
	await waitFor(() => box.read().sends ?? [], (sends) => sends.some((s) => s.id === "w4"), {
		timeoutMs: 30_000, what: "late non-triggering notice offered",
	});
	new AnsweredOutbox({ home: home.path }).enqueue({ id: "aw-s20-busy", type: "approval",
		decision: "S20 actionable decision", answer: "continue", answered_by: "operator dialog (tui)" });
	await waitFor(() => answers.read(), (state) => [...(state.sends ?? []), ...state.delivered].some((row) => row.id === "aw-s20-busy"), {
		timeoutMs: 30_000, what: "second answer offered while the parent remains busy",
	});
	holds[1]!.release();
	await waitFor(requests, (r) => r.length === 3, { timeoutMs: 30_000, what: "actionable answer bypasses busy gate" });
	const answered = JSON.stringify(requests()[2]?.body.messages);
	assert.match(answered, /S20 actionable decision/);
	assert.match(answered, /S20-BUSY-w4/);
	assert.doesNotMatch(answered, /fleet notice\(s\) arrived while you were busy/);
	queue("w5");
	await waitFor(() => box.read(), (state) => (state.sends ?? []).some((row) => row.id === "w5"), {
		timeoutMs: 30_000, what: "late non-triggering notice offered while parent remains busy",
	});
	holds[2]!.release();
	await waitFor(requests, (r) => r.length === 4, { timeoutMs: 30_000, what: "one stranded-notice nudge" });
	await waitFor(() => box.pending(), (pending) => pending.length === 0, {
		timeoutMs: 30_000, what: "late non-triggering notice accepted after the busy turn",
	});
	const nudged = JSON.stringify(requests()[3]?.body.messages);
	assert.match(nudged, /S20-BUSY-w5/);
	assert.match(nudged, /1 fleet notice\(s\) arrived while you were busy/);
	await child.waitFor((r) => r.type === "message_end" && JSON.stringify(r).includes("Notices handled."), 60_000);
	assert.equal(requests().length, 4);
	assert.equal(provider.remaining("s20-busy"), 0);
});

test("S20: abort strands no autonomous turn and the next prompt carries the notices", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-abort", [
		{ kind: "hang" }, { kind: "text", text: "Resumed notices handled." },
		{ kind: "text", text: "Idle notice handled." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const box = new DurableWakeupOutbox({ home: home.path });
	const requests = () => provider.requests("s20-abort");
	await child.prompt("S20 ordinary busy turn");
	await waitFor(requests, (r) => r.length === 1, { timeoutMs: 30_000, what: "aborted request" });
	for (const id of ["abort-first", "abort-late"]) box.enqueue({ id, kind: "recovery", content: `S20-${id}` });
	await waitFor(() => box.read().sends ?? [], (sends) => sends.length === 2, {
		timeoutMs: 30_000, what: "busy notices offered before abort",
	});
	child.send({ id: "abort-s20", type: "abort" });
	await child.waitForSettled(60_000);
	await child.getState();
	assert.equal(requests().length, 1, "abort must not start a stranded-notice turn");
	await child.prompt("S20 resume after abort");
	await child.waitFor((r) => r.type === "message_end" && JSON.stringify(r).includes("Resumed notices handled."), 60_000);
	const resumed = JSON.stringify(requests()[1]?.body.messages);
	assert.match(resumed, /S20-abort-late/);
	assert.doesNotMatch(resumed, /fleet notice\(s\) arrived while you were busy/);
	box.enqueue({ id: "after-abort-idle", kind: "recovery", content: "S20 idle wake" });
	// Diagnostics only: timestamped wake-surface trail, printed when this wait times out (flaky in CI).
	const trail: string[] = [];
	let seenRecords = child.records().length;
	const stamp = (line: string) => trail.push(`${new Date().toISOString()} ${line}`);
	const sample = () => {
		const all = child.records();
		for (; seenRecords < all.length; seenRecords++) stamp(`rpc ${all[seenRecords]!.type}`);
		return requests();
	};
	const wakeAt = Date.now();
	try {
		await waitFor(sample, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("S20 idle wake")), {
			timeoutMs: 30_000, what: "idle notice reaches a model request",
		});
	} catch (error) {
		let detail: string;
		try {
			const outbox = box.read();
			const at = (r: { at?: number }) => (Number.isFinite(r.at) ? new Date(r.at!).toISOString() : "?");
			detail = [
				`wake enqueued at ${new Date(wakeAt).toISOString()}; trail built ${new Date().toISOString()}`,
				`outbox pending=${JSON.stringify(outbox.pending.map((e) => ({ id: e.id, queued_at: e.queued_at })))}`,
				`outbox sends=${JSON.stringify(outbox.sends ?? [])}`,
				`outbox delivered=${JSON.stringify(outbox.delivered)} discarded=${JSON.stringify(outbox.discarded ?? [])}`,
				...requests().map((r, i) => `request#${i} at=${at(r)} last=${String(JSON.stringify(r.body.messages?.at(-1))).slice(0, 300)}`),
				"rpc records (first seen by 25ms poll):", ...trail,
				`stderr: ${child.stderr().slice(-1500)}`,
			].join("\n");
		} catch (trailError) {
			detail = `trail unavailable: ${(trailError as Error).message ?? String(trailError)}`;
		}
		throw new Error(`${(error as Error).message}\nwake-surface trail:\n${detail}`);
	}
	assert.doesNotMatch(JSON.stringify(requests().map((r) => r.body.messages)), /fleet notice\(s\) arrived while you were busy/);
	assert.equal(provider.remaining("s20-abort"), 0);
});

test("S20: tool turns do not answer operator sends and an errored run releases held wakes", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-error-release", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 10000)'" } }] },
		{ kind: "error", status: 400, message: "S20 provider rejected request" },
		{ kind: "text", text: "Held notice recovered." },
	]);
	const agent = createAgentDir({ provider, settings: { retry: { enabled: false, maxRetries: 0 } } });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const requests = () => provider.requests("s20-error-release");
	await child.prompt(frameBatch([{ id: "ps-20300101000000-0000000b", text: "S20 unanswered operator question" }]));
	await child.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash", 30_000);
	const box = new DurableWakeupOutbox({ home: home.path });
	box.enqueue({ id: "s20-tool-held", kind: "recovery", content: "S20 held through tool turn" });
	box.enqueue({ id: "s20-tool-held-2", kind: "recovery", content: "S20 held through tool turn second" });
	await waitFor(() => box.read().sends ?? [], (sends) => sends.length > 0, {
		timeoutMs: 30_000, what: "notice offered during tool execution",
	});
	await child.waitFor((r) => r.type === "message_end" && JSON.stringify(r).includes("Held notice recovered."), 30_000);
	assert.equal(requests().length, 3);
	assert.doesNotMatch(JSON.stringify(requests()[1]?.body.messages), /S20 held through tool turn/);
	assert.match(JSON.stringify(requests()[2]?.body.messages), /S20 held through tool turn/);
	assert.equal(provider.remaining("s20-error-release"), 0);
});

test("wake S19: a real operator reconnects read-only and delivers a gap escalation once", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("s19-parent", [{ kind: "hang", ms: 3_000 }, { kind: "hang", ms: 3_000 }]);
	const operatorModel = provider.addScript("s19-operator", [
		{ kind: "text", text: "Unseen send received." },
		{ kind: "text", text: "Live send received." },
		{ kind: "text", text: "Live escalation received." },
		{ kind: "text", text: "Gap escalation received." },
	]);
	const agent = createAgentDir({ provider });
	const env = { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const hosts: ParentHostClient[] = [];
	let operator: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => {
		await operator?.close();
		for (const host of hosts) {
			await host.request("stop", undefined, 5_000).catch(() => undefined);
			host.disconnect();
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const start = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 });
		hosts.push(host);
		const started = await host.request("start", { home: home.path, mode: "multi", model: parentModel, modelExplicit: true }) as { pid?: number };
		host.parentPid = started.pid;
		return host;
	};
	const first = await start();
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, ".pi-command-post", "state")));
	await first.onRelay(() => {});
	const send = async (text: string) => {
		const result = await first.request("send", text, 100) as { send_id?: string; pending?: string };
		const id = result.send_id ?? result.pending;
		assert.ok(id, JSON.stringify(result));
		await waitFor(() => outbox.read().entries, (entries) => entries.some((entry) => entry.relay.sendId === id),
			{ timeoutMs: 30_000, what: "real parent send outcome persists" });
		return id;
	};
	const unseenId = await send("Acknowledge the unseen S19 send.");
	operator = startPiChild({ cwd: home.path, model: operatorModel, env, extensions: [CP_BRIDGE_EXTENSION] });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 1,
		{ timeoutMs: 30_000, what: "unseen real send outcome delivered at attach" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[0]!.body).includes(unseenId));
	const seenId = await send("Acknowledge the live S19 send.");
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 2,
		{ timeoutMs: 30_000, what: "live real send outcome delivered" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[1]!.body).includes(seenId));
	const liveStore = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 11_000) });
	const live = await liveStore.raise({ job_ids: ["cp-s19-live"], kind: "product_ambiguity", question: "Live S19 decision",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [] });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 3,
		{ timeoutMs: 30_000, what: "live escalation delivered before reconnect" });
	await operator.waitForSettled();
	assert.ok(JSON.stringify(provider.requests("s19-operator")[2]!.body).includes(live.id));
	const status = () => operator!.stderr() + JSON.stringify(operator!.records());
	await waitFor(status, (text) => text.includes("cp-parent: attached"), { timeoutMs: 30_000, what: "initial bridge attachment" });
	const paths = parentHostPaths(home.path, "multi");
	const generation = currentHost(paths).gen;
	process.kill(first.hostPid, "SIGKILL");
	if (first.parentPid) { try { process.kill(first.parentPid, "SIGTERM"); } catch {} }
	await first.closed;
	await waitFor(status, (text) => text.includes("host connection closed"), { timeoutMs: 30_000, what: "bridge detects host close" });
	await new Promise((done) => setTimeout(done, 2_000));
	assert.equal(currentHost(paths).gen, generation, "read-only retries must not create a host");
	const raised = await new EscalationStore({ home: home.path }).raise({
		job_ids: ["cp-s19-gap"], kind: "product_ambiguity", question: "Choose the S19 gap outcome",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [],
	});
	const second = await start();
	await waitFor(status, (text) => text.includes(`reattached (pid ${second.hostPid})`), { timeoutMs: 45_000, what: "bridge reattaches to replacement host" });
	await waitFor(() => provider.requests("s19-operator"), (requests) => requests.length === 4, { timeoutMs: 45_000, what: "gap escalation reaches real operator model" });
	const request = JSON.stringify(provider.requests("s19-operator")[3]!.body);
	assert.ok(request.includes(raised.id), "gap escalation id must reach operator context");
	assert.ok(request.includes("Choose the S19 gap outcome"), "gap escalation question must reach operator context");
	await operator.waitForSettled();
	await new Promise((done) => setTimeout(done, 12_000));
	assert.equal(provider.requests("s19-operator").length, 4, "replay and host watch must not deliver sends or escalations twice");
	assert.equal(currentHost(paths).gen, generation + 1, "bridge must not spawn extra generations");
	assert.ok(outbox.read().entries.filter((entry) => entry.id.startsWith(`esc:${raised.id}`)).length <= 1);
	assert.equal(provider.remaining("s19-operator"), 0);
	assert.equal(provider.remaining("s19-parent"), 0);
});


test("wake S19: host escalation watch suppresses represented decisions, retries read failures and bounds write failures", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-watch-parent", [{ kind: "text", text: "Ready." }]);
	const agent = createAgentDir({ provider });
	const env = { ...agent.env, CP_HOST_ESCALATION_TICK_SECONDS: "1" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const hosts: ParentHostClient[] = [];
	let backstopOperator: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => {
		chmodSync(parentHostPaths(home.path, "multi").dir, 0o700);
		await backstopOperator?.close();
		for (const host of hosts) { await host.request("stop", undefined, 5_000).catch(() => undefined); host.disconnect(); }
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const paths = parentHostPaths(home.path, "multi");
	const store = new EscalationStore({ home: home.path, now: () => new Date(Date.now() - 60_000) });
	const raise = (question: string) => store.raise({ job_ids: ["cp-s19-watch"], kind: "product_ambiguity", question,
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [] });
	const ordinary = await raise("Deliver the unrepresented decision");
	const represented = await raise("Already represented by an operator ask");
	const ledgered = await raise("Already delivered to a session");
	const boxed = await raise("Already present under a suffixed outbox id");
	const asks = new OperatorAsks(join(paths.dir, "operator", "asks.jsonl"));
	asks.open({ project: "demo", question: represented.question, source_escalation: represented.id,
		options: [{ label: "Hold", consequence: "Wait" }], recommendation: "Hold" });
	new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")).note(ledgered.id, "bridge");
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(paths.dir));
	outbox.enqueue({ kind: "escalation", escalationId: boxed.id, jobId: "cp-s19-watch", stale: false,
		text: boxed.question, receipt: { level: null, reached: [] }, paths: [] }, "seed");
	const seeded = JSON.parse(readFileSync(outbox.file, "utf8"));
	seeded.entries[0].id += "#2";
	writeFileSync(outbox.file, JSON.stringify(seeded));
	const start = async () => {
		const host = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: 60_000 }); hosts.push(host);
		await host.request("start", { home: home.path, mode: "multi", model, modelExplicit: true }); return host;
	};
	const first = await start();
	const entries = () => outbox.read().entries;
	await waitFor(entries, (items) => items.some((item) => item.id === `esc:${ordinary.id}`), { timeoutMs: 30_000, what: "host directly relays code-raised escalation" });
	const freshStore = new EscalationStore({ home: home.path });
	const freshInput = { job_ids: ["cp-s19-watch"], kind: "product_ambiguity" as const, question: "Fresh grace decision",
		options: [{ id: "hold", label: "Hold", consequence: "Wait", cost: "none" }], recommended: "hold", evidence_paths: [],
		at: isoTimestamp(new Date(Date.now() + 5_000)) };
	const fresh = await freshStore.raise(freshInput);
	const immediate = await freshStore.raise({ ...freshInput, kind: "service_health", question: "Immediate service decision" });
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === immediate.id), { timeoutMs: 15_000, what: "service health bypasses the grace" });
	assert.equal(entries().some((item) => item.relay.escalationId === fresh.id), false, "fresh ordinary escalation stays inside grace");
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === fresh.id), { timeoutMs: 15_000, what: "ordinary escalation leaves grace" });
	const relay = entries().find((item) => item.id === `esc:${ordinary.id}`)!.relay;
	assert.equal(relay.kind, "escalation"); assert.equal(relay.escalationId, ordinary.id); assert.equal(relay.jobId, "cp-s19-watch");
	assert.match(relay.text, new RegExp(`^\\[.*\\] ${ordinary.id} \\(product_ambiguity\\) — Deliver the unrepresented decision$`));
	assert.equal(entries().some((item) => item.relay.escalationId === represented.id), false, "open ask suppresses relay");
	assert.equal(entries().some((item) => item.relay.escalationId === ledgered.id), false, "session ledger suppresses relay");
	await first.request("stop"); await first.closed;
	const second = await start();
	const restartedFrames: string[] = [];
	await second.onRelay((relay) => { if (relay.escalationId) restartedFrames.push(relay.escalationId); });
	await new Promise((done) => setTimeout(done, 2_500));
	assert.equal(entries().filter((item) => item.relay.escalationId === ordinary.id).length, 1, "restart must not duplicate an outbox relay");
	assert.equal(entries().filter((item) => item.relay.escalationId === boxed.id).length, 1, "existing outbox id suppresses relay");
	assert.equal(restartedFrames.includes(ordinary.id), false, "restart must not reframe an existing outbox relay");
	assert.equal(restartedFrames.includes(boxed.id), false, "existing outbox id must suppress host frames");
	const failed = await raise("Read faults must be logged then recover");
	for (const file of [store.file, escalationRelayLedgerFile(home.path, "multi"), outbox.file]) {
		const saved = readFileSync(file, "utf8");
		const before = readFileSync(paths.log, "utf8").length;
		writeFileSync(file, "{");
		await waitFor(() => readFileSync(paths.log, "utf8").slice(before), (text) => text.includes("escalation relay watch failed"), { timeoutMs: 25_000, what: `visible read failure for ${file}` });
		writeFileSync(file, saved);
	}
	await waitFor(entries, (items) => items.some((item) => item.relay.escalationId === failed.id), { timeoutMs: 25_000, what: "watch recovers after corrupt reads" });
	const writeFailed = await raise("A refused outbox write is framed only once");
	const frames: string[] = [];
	await second.onRelay((relay) => { if (relay.escalationId === writeFailed.id) frames.push(relay.text); });
	chmodSync(dirname(outbox.file), 0o500);
	await waitFor(() => readFileSync(paths.log, "utf8"), (text) => text.includes("relay outbox write failed"), { timeoutMs: 25_000, what: "visible outbox write failure" });
	await new Promise((done) => setTimeout(done, 2_500));
	assert.equal(frames.length, 1, "failed outbox write must not reframe each tick");
	chmodSync(dirname(outbox.file), 0o700);
	await second.request("stop"); await second.closed;
	const delivered = JSON.parse(readFileSync(outbox.file, "utf8"));
	delivered.entries = [];
	writeFileSync(outbox.file, JSON.stringify(delivered));
	// Service-health is due at age 0; with the outbox emptied the backstop would send it as a second request.
	new EscalationRelayLedger(escalationRelayLedgerFile(home.path, "multi")).note(immediate.id, "bridge");
	const ancient = await freshStore.raise({ ...freshInput, question: "An undelivered decision still needs the backstop", at: isoTimestamp(new Date(Date.now() - 601_000)) });
	const backstopModel = provider.addScript("s19-backstop-operator", [{ kind: "text", text: "Backstop received." }]);
	agent.writeModels(provider);
	backstopOperator = startPiChild({ cwd: home.path, model: backstopModel,
		env: { ...agent.env, CP_HOME: home.path, PI_HOME: home.path, CP_MODE: "multi" }, extensions: [CP_BRIDGE_EXTENSION] });
	await waitFor(() => provider.requests("s19-backstop-operator"), (requests) => requests.length === 1,
		{ timeoutMs: 30_000, what: "undelivered escalation reaches the real operator backstop" });
	assert.ok(JSON.stringify(provider.requests("s19-backstop-operator")[0]!.body).includes(ancient.id));
	assert.ok(JSON.stringify(provider.requests("s19-backstop-operator")[0]!.body).includes("has been open"));
	await backstopOperator.waitForSettled();
	assert.equal(provider.remaining("s19-backstop-operator"), 0);
});
test("S21: restart delivers an unobserved death once and discards obsolete fleet notices", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-durable";
	const model = provider.addScript(script, [{ kind: "text", text: "Recovery notice received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const fleet = new FleetStore({ home: home.path });
	const record = (jobId: string, phase: "failed" | "done" | "waiting"): FleetRecord => ({
		job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase,
		branch: jobId, worktree: join(home.path, "missing"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: phase === "waiting" ? process.pid : 1, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() },
		failure: { class: "crash", message: "legacy crash", at: isoTimestamp() },
	});
	await fleet.add(record("cp-live", "failed"));
	await fleet.add(record("cp-finished", "done"));
	for (const resumable of [false, true]) {
		const jobId = resumable ? "cp-revivable" : "cp-unsalvageable";
		const dead = record(jobId, "waiting");
		dead.worker.pid = 2147483647;
		if (resumable) {
			dead.worker.session_file = join(home.path, "surviving-session.jsonl");
			writeFileSync(dead.worker.session_file, "");
		}
		await fleet.add(dead);
	}
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "previous-parent" });
	outbox.enqueue({ id: "death:cp-gone:1", kind: "death", job_id: "cp-gone", keys: ["crash"], content: "S21_OBSOLETE_DEATH" });
	outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" });
	const transportOwner = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(() => transportOwner.shutdown());
	const facts = wakeupFacts({ record: (jobId) => fleet.get(jobId) });
	assert.throws(() => transportOwner.sweepDurableWakeups((entry) => {
		const verdict = checkWakeup({ kind: entry.kind, job_id: entry.job_id, keys: entry.keys, generation: entry.generation, issued_at: entry.queued_at }, facts);
		if (verdict.state === "superseded") return verdict.reason ?? "stale";
		writeFileSync(join(home.path, "absent-transport", "message"), entry.content);
		return true;
	}), /ENOENT/);
	assert.deepEqual(outbox.pending().map((entry) => entry.id), ["death:cp-live:1"]);
	assert.equal(outbox.read().discarded?.[0]?.id, "death:cp-gone:1");
	outbox.enqueue({ id: "recovery:finished", kind: "recovery", keys: ["cp-finished", "cp-gone"], content: "S21_OBSOLETE_RECOVERY" });
	for (const kind of ["death", "bound"] as const) {
		const jobId = `cp-waiting-${kind}`;
		await fleet.add(record(jobId, "waiting"));
		outbox.enqueue({ id: `${kind}:${jobId}:1`, kind, job_id: jobId, generation: 1, keys: [kind === "death" ? "crash" : "tool_call_cap_exceeded"], content: `S21_OBSOLETE_waiting_${kind}` });
	}
	outbox.enqueue({ id: "recovery:mixed", kind: "recovery", keys: ["cp-live", "cp-finished"], content: "S21_MIXED_RECOVERY" });
	assert.equal(outbox.enqueue({ id: "death:cp-live:1", kind: "death", job_id: "cp-live", keys: ["crash"], content: "S21_LIVE_DEATH legacy crash" }), false);
	outbox.drain(() => {});
	assert.equal(outbox.pending().length, 5, "transport handoff cannot confirm delivery");
	const launch = () => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	const first = launch();
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 10_000, what: "replayed death reaching the model" });
	await waitFor(() => outbox.read().delivered, (rows) => rows.some((row) => row.id === "death:cp-live:1") && rows.some((row) => row.id === "recovery:mixed"), { timeoutMs: 15_000, what: "observed death and mixed recovery arrivals" });
	await waitFor(() => outbox.pending().length, (n) => n === 0, { timeoutMs: 15_000, what: "startup reconciliation notice arrival" });
	const receivedText = () => JSON.stringify(provider.requests(script).map((r) =>
		(r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	await waitFor(() => receivedText().includes("RESTART RECOVERY"), Boolean,
		{ timeoutMs: 15_000, what: "reconciliation reaching the mock model" });
	const text = receivedText();
	const recoveryNotices = provider.requests(script).flatMap((request) =>
		(request.body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user")
			.flatMap((message) => Array.isArray(message.content) ? message.content : [])
			.filter((part: { text?: string }) => part.text?.includes("RESTART RECOVERY —"))
			.map((part: { text: string }) => part.text)).join("\n");
	assert.match(recoveryNotices, /cp_revive cp-revivable/, "the recovery notice names the resumable job's next tool");
	assert.match(recoveryNotices, /cp_teardown cp-unsalvageable/, "the recovery notice names the failed job's next tool");
	assert.doesNotMatch(recoveryNotices, /poll/i);
	assert.match(text, /S21_LIVE_DEATH/);
	assert.match(text, /S21_MIXED_RECOVERY/);
	assert.match(text, /RESTART RECOVERY/);
	assert.match(text, /cp-unsalvageable/);
	assert.match(text, /cp-revivable/);
	assert.match(text, /cp_revive/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.equal(outbox.read().delivered.filter((row) => row.id.startsWith("recovery:cp-")).length, 1);
	assert.doesNotMatch(text, /S21_OBSOLETE/);
	assert.deepEqual(outbox.pending(), []);
	assert.equal(outbox.read().discarded?.length, 4, "obsolete notices are terminally discarded");
	await first.close();
	const before = provider.requests(script).length;
	const second = launch();
	second.send({ id: "ready", type: "get_commands" });
	await second.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
	await second.prompt("S21 restart inspection");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "restart inspection turn" });
	const restartText = JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages));
	assert.doesNotMatch(restartText, /S21_LIVE_DEATH|S21_OBSOLETE/);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8")).delivered.filter((row: { id: string }) => row.id === "death:cp-live:1").length, 1);
});


test("S21: host failure events survive restart with distinct CI causes and one arrival per class", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const script = "s21-host-failures";
	const model = provider.addScript(script, [{ kind: "text", text: "Failure events received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	const post = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
	t.after(async () => {
		for (const child of children) await child.close();
		await post.shutdown();
		agent.cleanup();
		home.cleanup();
		await provider.stop();
	});
	for (const cls of FAILURE_CLASSES) {
		const jobId = `cp-${cls.replaceAll("_", "-")}`;
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting",
			branch: jobId, worktree: join(home.path, jobId), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: 2147483647, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		if (cls === "spawn_failed") {
			// A legacy pre-event exit is replayed through the real close observer's event entry point.
			post.runs.open(jobId).cp("spawned", {});
			post.runs.open(jobId).cp("process_exit", { code: 2 });
			assert.equal((await post.failures.evaluate(jobId))?.class, cls);
		} else await post.fail(jobId, { class: cls, message: `S21_FAILURE_${cls}`, at: isoTimestamp() });
	}
	const prefix = "watch cause ".repeat(20);
	post.ciWatchFailed(new Error(`${prefix}HTTP 403`));
	post.ciWatchFailed(new Error(`${prefix}HTTP 502`));
	const pending = post.durableWakeups.pending();
	assert.equal(pending.length, FAILURE_CLASSES.length + 2);
	assert.equal(new Set(pending.map((entry) => entry.id)).size, pending.length);
	assert.ok(pending.every((entry) => entry.id.length <= 160));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 403")));
	assert.ok(pending.some((entry) => entry.id.includes("HTTP 502")));
	await post.shutdown();
	const outbox = new DurableWakeupOutbox({ home: home.path, owner: "observer" });
	const first = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(first);
	await waitFor(() => outbox.read().delivered.length, (n) => n === pending.length, { timeoutMs: 30_000, what: "every failure event arriving after restart" });
	await waitFor(() => provider.requests(script).length, (n) => n > 0, { timeoutMs: 15_000, what: "failure consumer request" });
	const text = JSON.stringify(provider.requests(script).map((r) => (r.body.messages as Array<{ role: string }>).filter((message) => message.role !== "system")));
	for (const cls of FAILURE_CLASSES) {
		const queued = pending.find((entry) => entry.job_id === `cp-${cls.replaceAll("_", "-")}`);
		const row = outbox.read().delivered.find((entry) => entry.id === queued?.id);
		assert.ok(row, `${cls} has one durable arrival`);
		assert.equal(queued?.kind, cls === "wall_clock_exceeded" || cls === "tool_call_cap_exceeded" ? "bound" : "death");
		assert.match(text, new RegExp(cls === "spawn_failed" ? "spawn_failed" : `S21_FAILURE_${cls}`));
	}
	assert.match(text, /on disk:/);
	assert.match(text, /cp_teardown/);
	assert.doesNotMatch(text, /poll/i);
	assert.deepEqual(outbox.pending(), []);
	await first.close();
	const before = provider.requests(script).length;
	const second = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(second);
	await second.prompt("Inspect the restarted parent.");
	await waitFor(() => provider.requests(script).length, (n) => n > before, { timeoutMs: 15_000, what: "second host inspection" });
	assert.doesNotMatch(JSON.stringify(provider.requests(script).slice(before).map((r) => r.body.messages)), /S21_FAILURE_/);
});


test("S21: forty failed reconcile candidates retain distinct bounded notices through RPC restart", { timeout: 110_000 }, async (t) => {
	const provider = await MockProvider.start();
	const script = "s21-long-recovery";
	const model = provider.addScript(script, [{ kind: "text", text: "Recovery inventory received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const ids: string[] = [];
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => { for (const close of cleanup) await close(); agent.cleanup(); await provider.stop(); });
	for (const variant of ["a", "b"]) {
		const home = createScratchHome();
		const post = new CommandPost({ home: home.path, packageRoot: process.cwd(), holdsParentLock: () => true });
		let child: ReturnType<typeof startPiChild> | undefined;
		cleanup.push(async () => { await child?.close(); await post.shutdown(); home.cleanup(); });
		for (let i = 0; i < 40; i++) {
			const jobId = `cp-recovery-${String(i).padStart(2, "0")}-${"x".repeat(35)}${i === 39 ? variant : ""}`;
			await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "local", origin: "terminal", phase: "waiting",
				branch: jobId, worktree: join(home.path, jobId), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
				worker: { pid: 2147483647, session_id: "legacy", session_file: join(home.path, "missing.jsonl"), profile: "implementer", role: "implementer", model, started_at: isoTimestamp() } });
		}
		const { report } = await post.reconcile();
		assert.equal(report.entries.filter((entry) => entry.outcome === "failed").length, 40);
		assert.equal(post.fleet.list().filter((record) => record.phase === "failed").length, 40);
		const pending = post.durableWakeups.pending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.kind, "recovery");
		assert.equal(pending[0]?.keys?.length, 40);
		assert.ok((pending[0]?.id.length ?? Infinity) <= 160);
		assert.ok((pending[0]?.content.length ?? Infinity) <= 4000);
		assert.match(pending[0]?.content ?? "", /RESTART RECOVERY — 40 candidate/);
		assert.match(pending[0]?.content ?? "", /\.\.\.and \d+ more/);
		ids.push(pending[0]?.id ?? "");
		await post.shutdown();
		const before = provider.requests(script).length;
		child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		await waitFor(() => JSON.stringify(provider.requests(script).slice(before).map((request) => request.body.messages)).includes("RESTART RECOVERY — 40 candidate"), Boolean,
			{ timeoutMs: 20_000, what: "bounded forty-candidate notice reaching the real parent" });
		await waitFor(() => post.durableWakeups.read().delivered.some((entry) => entry.id === pending[0]?.id), Boolean,
			{ timeoutMs: 15_000, what: "long recovery arrival confirmation" });
		await child.close();
	}
	assert.notEqual(ids[0], ids[1], "sets sharing their first 39 candidates retain distinct durable IDs");
});
