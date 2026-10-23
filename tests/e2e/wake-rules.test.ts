import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CpBridge, type BridgeRelay } from "../../src/cp-bridge.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, waitFor } from "../harness/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { formatContinuationNotice } from "../../src/held-continuation.ts";
import { boundedWakeupId } from "../../src/wakeup-outbox.ts";
import { REPO_ROOT, readRunEvents, startPiChild } from "../harness/index.ts";
import { JOB as CI_JOB, PR, seedHeldHome } from "../harness/held-home.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { CiWatchStore } from "../../src/ci-watch.ts";
import { execFileSync } from "node:child_process";
import { LeaseManager } from "../../src/leases.ts";
import { FleetStore } from "../../src/fleet.ts";
import { enableTreehouse } from "../harness/treehouse.ts";

async function startCiParent(t: import("node:test").TestContext, held: Awaited<ReturnType<typeof seedHeldHome>>, tag: string) {
	const provider = await MockProvider.start();
	const model = provider.addScript(tag, [{ kind: "text", text: "CI notice carried." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: held.home.path, model, extensions: [COMMAND_POST_EXTENSION],
		env: { ...agent.env, CP_HOME: held.home.path, PATH: `${held.bin}:${process.env.PATH ?? ""}`,
			CP_CI_WATCH_SECONDS: "1", CP_CI_WATCH_DELIVERY_RETRY_SECONDS: "1", CP_REVIEW_MERGE_WINDOW_SECONDS: "1" } });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.home.cleanup(); held.repo.cleanup(); });
	await child.getState();
	await waitFor(() => readFileSync(held.ghLog, "utf8").split("\n").filter((line) => line.includes("/actions/runs?")).length,
		(n) => n >= 2, { timeoutMs: 30_000, what: "the initial watch completes before the fixture transition" });
	return { child, requests: () => provider.requests(tag), events: () => readRunEvents(held.home.path, CI_JOB)
		.filter((e) => e.type === "continuation").map((e) => e.payload as Record<string, unknown>).filter((e) => e.wake_rule === "ci_green") };
}

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

for (const [mode, title] of [
	["dispatch", "S20: green review fact wakes for dispatch"],
	["mission_end", "S20: green review fact wakes for mission_end"],
	["failure", "S20: green review fact wakes for failure"],
] as const) {
	test(title, { timeout: 120_000 }, async (t) => {
		const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
		initJobsDocument(held.home.path, "cp");
		const post = new CommandPost({ home: held.home.path, packageRoot: REPO_ROOT });
		if (mode !== "failure") {
			const job = await post.ledger().create({ title: "Independent work", project: "demo", delivery: "local", kind: "ship" });
			post.mandates.issue({ projects: ["demo"], objective: "Independent work", job_ids: [job.id],
				expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [] });
			if (mode === "mission_end") await post.ledger().close(job.id, "dropped: operator cancelled the fixture job");
		}
		await post.shutdown();
		const parent = await startCiParent(t, held, `s20-green-next-${mode}`);
		if (mode === "failure") writeFileSync(join(held.home.path, LAYOUT.jobsFile), "not json");
		writeFileSync(held.stateFile, "green\n");
		await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("CI/PR OBSERVED")), {
			timeoutMs: 30_000, what: `green review fact wakes for ${mode}`,
		});
		assert.equal(parent.events().length, 1);
		assert.equal(parent.events()[0]?.decision, "woke");
		assert.match(String(parent.events()[0]?.reason), mode === "failure" ? /^cp_next failed:/ : new RegExp(`^cp_next ${mode}$`));
		await parent.child.close();
	});
}

test("S20: green CI on an operator-held PR wakes with the continuation wait reason", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	new IntegrationHolds(held.home.path).hold(CI_JOB, "operator paused this PR");
	const parent = await startCiParent(t, held, "s20-ci-wait");
	writeFileSync(held.stateFile, "green\n");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("CI/PR OBSERVED")), {
		timeoutMs: 30_000, what: "held green fact reaches the provider",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]), [["woke", "outcome wait/wait"]]);
});

test("S20: a green fact overtaken by a closed PR wakes with the stopped reason", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	writeFileSync(`${held.headFile}.view`, JSON.stringify({ state: "CLOSED" }));
	const parent = await startCiParent(t, held, "s20-ci-stopped");
	writeFileSync(held.stateFile, "green\n");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("CI/PR OBSERVED")), {
		timeoutMs: 30_000, what: "refused continuation leaves the fact to the parent",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]), [["woke", "outcome stopped/surface"]]);
});

test("S20: a legacy unconfirmed green key wakes when its continuation was already handled", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "green", review: "pending" });
	const parent = await startCiParent(t, held, "s20-ci-coalesced");
	await waitFor(parent.events, (rows) => rows.some((e) => e.decision === "suppressed"), { timeoutMs: 30_000, what: "the first green key is handled" });
	// "suppressed" is journaled at observation; strip only once the key is confirmed, or confirm re-adds it.
	const file = new CiWatchStore({ home: held.home.path }).file;
	await waitFor(() => new CiWatchStore({ home: held.home.path }).announced(CI_JOB), (keys) => [...keys].some((k) => k.includes("ci_green")), { timeoutMs: 30_000, what: "the first green key is confirmed" });
	// Confirm has landed; one atomic strip (temp+rename) so no torn write can race the watcher's own atomic writes.
	const state = JSON.parse(readFileSync(file, "utf8"));
	for (const job of state.jobs) job.announced = job.announced.filter((key: string) => !key.includes("ci_green"));
	atomicWriteJson(file, state);
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("CI/PR OBSERVED")), {
		timeoutMs: 30_000, what: "legacy unconfirmed key wakes for its coalesced outcome",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]).slice(1), [["woke", "outcome coalesced/none"]]);
});

test("S20: a slow forge continuation times out the green rule and leaves the fact to the parent", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	const parent = await startCiParent(t, held, "s20-ci-unsettled");
	writeFileSync(`${held.headFile}.delay`, "50000");
	writeFileSync(held.stateFile, "green\n");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes("CI/PR OBSERVED")), {
		timeoutMs: 65_000, what: "bounded continuation wait wakes instead of stranding the CI fact",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]), [["woke", "continuation unsettled after 30000ms"]]);
	await waitFor(() => readFileSync(held.ghLog, "utf8").includes("fixture delay completed"), Boolean,
		{ timeoutMs: 55_000, what: "the owned forge command finishes before cleanup" });
});

test("S20: a green fact overtaken by a merged PR emits an ordinary notice after completion", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	initJobsDocument(held.home.path, "cp");
	const post = new CommandPost({ home: held.home.path, packageRoot: REPO_ROOT });
	await post.ledger().create({ title: "Held PR", project: "demo", delivery: "pr", kind: "ship" });
	const document = post.ledger().read();
	document.jobs[0]!.id = CI_JOB;
	writeFileSync(join(held.home.path, LAYOUT.jobsFile), JSON.stringify(document));
	await post.shutdown();
	const parent = await startCiParent(t, held, "s20-ci-done");
	const clone = join(held.home.path, LAYOUT.projects, "demo");
	const pool = enableTreehouse(clone, { maxTrees: 1 });
	t.after(() => pool.cleanup());
	const lease = await new LeaseManager({ home: held.home.path }).acquire(clone, { project: "demo", holder: "s20-fixture" });
	execFileSync("git", ["checkout", "--quiet", CI_JOB], { cwd: lease.path });
	const fleet = new FleetStore({ home: held.home.path });
	await fleet.patch(CI_JOB, { worktree: lease.path, ...(lease.lease_id ? { lease_id: lease.lease_id } : {}),
		worker: { ...fleet.require(CI_JOB).worker, pid: 2_000_000_000 } });
	held.repo.git("checkout", "--quiet", "main");
	held.repo.git("merge", "--ff-only", "--quiet", CI_JOB);
	held.repo.git("push", "--quiet", "origin", "main");
	writeFileSync(`${held.headFile}.view`, JSON.stringify({ state: "MERGED", mergedAt: isoTimestamp(), mergeCommit: { oid: held.headSha } }));
	writeFileSync(held.stateFile, "green\n");
	await waitFor(() => parent.child.records().some((r) => r.type === "extension_ui_request" && /CI\/PR OBSERVED/.test(String(r.message))),
		(seen) => seen, { timeoutMs: 30_000, what: "ordinary CI notification after the continuation finishes" });
	assert.equal(parent.requests().length, 0, "the landed job's separate freshness gate prevents an autonomous turn");
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]), [["woke", "outcome done/done"]]);
	assert.equal(fleet.require(CI_JOB).phase, "done");
	assert.equal(post.ledger().read().jobs[0]?.status, "closed");
});

test("S20: a different green head receives its own woke journal measurement", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "green", review: "pending" });
	writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}');
	const parent = await startCiParent(t, held, "s20-ci-new-key");
	await waitFor(parent.events, (rows) => rows.length === 1, { timeoutMs: 30_000, what: "the first green key journals" });
	writeFileSync(held.stateFile, "in_progress\n");
	held.repo.write("second.txt", "independent head\n");
	const head = held.repo.commitAll("second green head");
	held.repo.git("push", "--quiet", "origin", CI_JOB);
	writeFileSync(held.headFile, `${head}\n`);
	await waitFor(() => new CiWatchStore({ home: held.home.path }).head(CI_JOB), (sha) => sha === head, {
		timeoutMs: 30_000, what: "the watch observes the second head before its green result",
	});
	writeFileSync(held.stateFile, "green\n");
	await waitFor(parent.requests, (rows) => rows.some((r) => JSON.stringify(r.body.messages).includes(`CI green on ${head.slice(0, 12)}`)), {
		timeoutMs: 30_000, what: "the independent green key reaches the provider",
	});
	assert.deepEqual(parent.events().map((e) => [e.decision, e.reason]), [["woke", "kill switch"], ["woke", "kill switch"]]);
});

test("S20: a quiet green lookup warms the resolve cache before independent work becomes ready", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "pending" });
	initJobsDocument(held.home.path, "cp");
	const post = new CommandPost({ home: held.home.path, packageRoot: REPO_ROOT });
	await post.ledger().create({ title: "Held PR", project: "demo", delivery: "pr", kind: "ship" });
	const document = post.ledger().read();
	document.jobs[0]!.id = CI_JOB;
	writeFileSync(join(held.home.path, LAYOUT.jobsFile), JSON.stringify(document));
	await post.ledger().claim(CI_JOB, "s20-fixture");
	post.mandates.issue({ projects: ["demo"], objective: "Finish the held PR", job_ids: [CI_JOB],
		expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [] });
	const parent = await startCiParent(t, held, "s20-ci-warms-cache");
	t.after(() => post.shutdown());
	writeFileSync(held.stateFile, "green\n");
	await waitFor(parent.events, (rows) => rows.some((e) => e.decision === "suppressed"), { timeoutMs: 30_000, what: "the quiet CI lookup finishes" });
	const independent = await post.ledger().create({ title: "Independent work", project: "demo", delivery: "local", kind: "ship" });
	post.mandates.issue({ projects: ["demo"], objective: "Independent work", job_ids: [independent.id],
		expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [] });
	post.durableWakeups.enqueue({ id: `continuation:${CI_JOB}:1:${held.headSha}:ci:resolve`, kind: "recovery", job_id: CI_JOB, keys: [CI_JOB],
		content: formatContinuationNotice(CI_JOB, "resolve", "S20 CI warmed the cache", PR) });
	await waitFor(() => readRunEvents(held.home.path, CI_JOB).filter((e) => e.type === "continuation")
		.map((e) => e.payload as Record<string, unknown>).filter((e) => e.wake_rule === "held_stop_resolve"), (rows) => rows.length === 1,
		{ timeoutMs: 30_000, what: "the warm resolve cache delivers without another lookup" });
	const ruling = readRunEvents(held.home.path, CI_JOB).map((e) => e.payload as Record<string, unknown>).find((e) => e.wake_rule === "held_stop_resolve");
	assert.deepEqual([ruling?.decision, ruling?.reason], ["relayed", "cp_next wait"]);
});
