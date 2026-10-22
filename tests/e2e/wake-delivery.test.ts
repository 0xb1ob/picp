import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FleetStore } from "../../src/fleet.ts";
import {
	DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, SCHEMA_VERSION,
	SHIPPED_SEEN_KEEP_SESSIONS, SHIPPED_SEEN_MAX_IDS,
} from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";

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
	]);
	const agent = createAgentDir({ provider });
	const session = join(home.path, "legacy.jsonl");
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
	assert.match(readFileSync(session, "utf8"), /OBSOLETE-envelope/, "filtering must not mutate persisted history");
	const offset = child.records().length;
	await child.prompt("/s20tail");
	await child.waitFor((r) => r.type === "agent_settled" && child.records().indexOf(r) >= offset, 60_000);
	const tailRequest = JSON.stringify(provider.requests("s20-context")[1]?.body.messages);
	assert.doesNotMatch(tailRequest, /OBSOLETE-TAIL/);
	assert.match(tailRequest, /A fleet notice queued for this turn was withdrawn before delivery/);
	assert.equal(provider.remaining("s20-context"), 0);
});
