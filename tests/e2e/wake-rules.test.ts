import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CpBridge, type BridgeRelay } from "../../src/cp-bridge.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, waitFor } from "../harness/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { formatContinuationNotice } from "../../src/held-continuation.ts";
import { boundedWakeupId } from "../../src/wakeup-outbox.ts";
import { REPO_ROOT, readRunEvents, startPiChild } from "../harness/index.ts";

async function startRuleParent(t: import("node:test").TestContext, tag: string, switchFile?: string) {
	const home = createScratchHome();
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await post.registry.register({ name: "demo", clone_url: home.path, delivery: "local" });
	await post.fleet.add({ job_id: "cp-s20", project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN,
		phase: "held", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), branch: "cp-s20", worktree: home.path,
		worker: { pid: process.pid, session_id: "s20-seeded", session_file: join(home.path, "worker.jsonl"),
			profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() }, usage: EMPTY_USAGE });
	post.runs.open("cp-s20");
	post.durableWakeups.enqueue({ id: "recovery:cp-s20", kind: "recovery", job_id: "cp-s20", content: "already relayed", keys: ["cp-s20"] });
	post.durableWakeups.confirmDelivered(["recovery:cp-s20"]);
	if (switchFile !== undefined) {
		mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(home.path, LAYOUT.data, "wake-rules.json"), switchFile);
	}
	const provider = await MockProvider.start();
	const model = provider.addScript(tag, [{ kind: "text", text: "Wake handled." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); await post.shutdown(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const events = () => existsSync(join(home.path, paths.eventsFile("cp-s20")))
		? readRunEvents(home.path, "cp-s20").filter((e) => e.type === "continuation")
			.map((e) => e.payload as { wake_rule?: string; decision?: string; reason?: string; next_kind?: string }) : [];
	const queue = (suffix: string, next: Parameters<typeof formatContinuationNotice>[1] = "resolve") => {
		const id = boundedWakeupId(`continuation:cp-s20:1:${suffix}:ci:${next}`);
		post.durableWakeups.enqueue({ id, kind: "recovery", job_id: "cp-s20", keys: ["cp-s20"],
			content: formatContinuationNotice("cp-s20", next, `S20 notice ${suffix}`, "https://example.test/7") });
		return id;
	};
	await child.getState();
	return { home, post, child, queue, events, requests: () => provider.requests(tag) };
}

test("S20: the real parent bridge relays landing, resolve, green and flagged notices once", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s20-bridge-relay", [{ kind: "text", text: "Relay messages carried." }]);
	const agent = createAgentDir({ provider });
	const extension = join(home.path, "relay-fixture.ts");
	const notices = [
		"HELD PR LANDED — cp-s20-landing",
		"[demo] HELD PR STOPPED — cp-s20-resolve (continuation, next: resolve)\n  repaired",
		"[demo] CI GREEN — cp-s20-green: handled in code, no parent turn. https://example.test/7",
	];
	writeFileSync(extension, `import commandPost from ${JSON.stringify(COMMAND_POST_EXTENSION)};
export default function(pi) {
	commandPost(pi);
	pi.on("session_start", async (_event, ctx) => {
		for (const text of ${JSON.stringify(notices)}) { ctx.ui.notify(text, "info"); ctx.ui.notify(text, "info"); }
		ctx.ui.notify("HELD PR STOPPED — cp-s20-surface (continuation, next: surface)", "info");
		ctx.ui.notify("CI/PR OBSERVED — S20 ordinary fact", "info");
	});
	pi.on("input", () => {
		pi.sendMessage({ customType: "cp-recovery", content: "S20 flagged relay", details: { relay_only: true }, display: true }, { triggerTurn: false });
		pi.sendMessage({ customType: "cp-recovery", content: "S20 ordinary custom", details: {}, display: true }, { triggerTurn: false });
	});
}`);
	const originalEnv = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => {
		await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
		Object.assign(process.env, originalEnv);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	await bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: extension });
	await waitFor(() => relays.filter((r) => r.informational), (rows) => rows.length >= 3, {
		timeoutMs: 30_000, what: "startup relay notifications at the bridge consumer",
	});
	await bridge.send("Carry the queued custom messages.", 30_000);
	await waitFor(() => relays, (rows) => rows.some((r) => r.informational && r.text === "S20 flagged relay"), {
		timeoutMs: 30_000, what: "flagged custom message relayed by the bridge",
	});
	const info = relays.filter((r) => r.informational).map((r) => r.text);
	for (const text of [...notices, "S20 flagged relay"]) assert.equal(info.filter((s) => s === text).length, 1, text);
	assert.ok(!info.some((s) => /cp-s20-surface|S20 ordinary/.test(s)));
	assert.equal(provider.remaining("s20-bridge-relay"), 0);
});

test("S20: switch files control resolve relays and malformed settings restore a parent turn", { timeout: 120_000 }, async (t) => {
	for (const [index, raw] of [undefined, "{}", '{"enabled":true}', '{"enabled":false}', "not json", '{"enabled":"no"}'].entries()) {
		const parent = await startRuleParent(t, `s20-switch-${index}`, raw);
		const id = parent.queue(`switch-${index}`);
		await waitFor(() => parent.post.durableWakeups.pending(), (rows) => !rows.some((r) => r.id === id), {
			timeoutMs: 30_000, what: "resolve notice delivered through the selected switch",
		});
		if (index < 3) {
			assert.deepEqual(parent.events().map((e) => [e.decision, e.next_kind]), [["relayed", "no_mandate"]]);
			assert.equal(parent.requests().length, 0);
		} else {
			await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes(`S20 notice switch-${index}`)), {
				timeoutMs: 30_000, what: "disabled rule wakes the real parent",
			});
			assert.deepEqual(parent.events(), []);
		}
		await parent.child.close();
	}
});

test("S20: non-resolve and hashed legacy continuation IDs reach context without a resolve ruling", { timeout: 120_000 }, async (t) => {
	const parent = await startRuleParent(t, "s20-identities");
	const ids = ["continuation:cp-s20:1:abc:ci:surface", "continuation:cp-s20:1:abc:ci:retry",
		"continuation:done:cp-s20:1", "continuation:window:x",
		boundedWakeupId(`continuation:cp-s20:1:${"x".repeat(200)}:ci:resolve`)];
	for (const [index, id] of ids.entries()) {
		parent.post.durableWakeups.enqueue({ id, kind: "recovery", job_id: "cp-s20", content: `S20 non-resolve ${index}` });
		await waitFor(() => parent.post.durableWakeups.pending(), (rows) => !rows.some((r) => r.id === id), {
			timeoutMs: 30_000, what: "legacy notice reaches the parent",
		});
		await parent.child.prompt(`Carry S20 identity ${index}.`);
		await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes(`S20 non-resolve ${index}`)), {
			timeoutMs: 30_000, what: "non-resolve continuation reaches the provider",
		});
	}
	assert.deepEqual(parent.events(), []);
});

test("S20: a resolve cache stays quiet within its minute and refreshes to dispatch after expiry", { timeout: 120_000 }, async (t) => {
	const parent = await startRuleParent(t, "s20-cache-expiry");
	parent.queue("cache-initial");
	await waitFor(parent.events, (rows) => rows.length === 1, { timeoutMs: 30_000, what: "initial quiet cache" });
	const cachedAt = Date.now();
	const ready = await parent.post.ledger().create({ title: "S20 independent work", project: "demo", delivery: "local", kind: "ship" });
	parent.post.mandates.issue({ projects: ["demo"], objective: "S20 independent work", job_ids: [ready.id],
		expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [] });
	parent.queue("cache-fresh");
	await waitFor(parent.events, (rows) => rows.length === 2, { timeoutMs: 30_000, what: "fresh quiet cache" });
	assert.deepEqual(parent.events().map((e) => [e.decision, e.next_kind]), [["relayed", "no_mandate"], ["relayed", "no_mandate"]]);
	assert.equal(parent.requests().length, 0);
	await waitFor(() => Date.now() - cachedAt, (elapsed) => elapsed > 61_000, { timeoutMs: 70_000, what: "public one-minute cache expiry" });
	parent.queue("cache-expired");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("S20 notice cache-expired")), {
		timeoutMs: 30_000, what: "expired cache wakes for actionable independent work",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.next_kind]), [
		["relayed", "no_mandate"], ["relayed", "no_mandate"], ["woke", "dispatch"],
	]);
});

test("S20: a failed next refresh wakes with a reason and is not retried during its cache minute", { timeout: 120_000 }, async (t) => {
	const parent = await startRuleParent(t, "s20-cache-failure");
	const ledgerFile = join(parent.home.path, LAYOUT.jobsFile);
	const original = readFileSync(ledgerFile, "utf8");
	writeFileSync(ledgerFile, "not json");
	parent.queue("failed-refresh");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("S20 notice failed-refresh")), {
		timeoutMs: 30_000, what: "failed next refresh wakes instead of stranding a resolve",
	});
	writeFileSync(ledgerFile, original);
	parent.queue("remembered-failure");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("S20 notice remembered-failure")), {
		timeoutMs: 30_000, what: "recent failed refresh stays fail-open",
	});
	assert.equal(parent.events().length, 2);
	for (const event of parent.events()) {
		assert.equal(event.decision, "woke");
		assert.match(event.reason ?? "", /cp_next unavailable:/);
		assert.doesNotMatch(event.reason ?? "", /never computed/);
	}
});
