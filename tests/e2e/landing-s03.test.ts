/** Behavior 05 landing e2e, part of the split of landing.test.ts; fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { lastFiledEnvelopeFile } from "../../src/supersede.ts";
import { COMMAND_POST_EXTENSION, startPiChild, advanceBase, git, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, run, json, startStack, mergedCalls } from "./landing-helpers.ts";

test("landing S03: corrupt CI memory recovers and arrival preserves fleet and decisions", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch corrupt memory", 301);
	const file = join(s.home, LAYOUT.ciWatchFile);
	const fleet = readFileSync(join(s.home, LAYOUT.fleetFile), "utf8");
	s.setGh({ runs: [run(301, live.head, "completed", "success")] });
	for (const corrupt of ["{ not json", JSON.stringify({ schema_version: 1, updated_at: "not-a-time", jobs: [] }), JSON.stringify({ jobs: [] }), JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs: null })]) {
		writeFileSync(file, corrupt);
		const tick = await s.post.ciTick();
		assert.equal(tick.errors.length, 0, "corrupt memory is forgotten, not a failed read");
		assert.equal(readFileSync(join(s.home, LAYOUT.fleetFile), "utf8"), fleet, "a watch tick writes no receipts or fleet state");
		assert.equal(tick.observations.length, 1, "lost memory duplicates a fact rather than losing it");
		const key = tick.observations[0]!.key;
		assert.deepEqual(s.post.confirmCi([key]), [key]);
		assert.deepEqual(s.post.confirmCi([key]), [], "duplicate arrival changes nothing");
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(persisted.schema_version, SCHEMA_VERSION);
		assert.deepEqual(persisted.jobs[0].announced, [key], "arrival round-trips to disk");
	}
	assert.equal(readFileSync(join(s.home, LAYOUT.fleetFile), "utf8"), fleet, "the watch never changes fleet receipts");
	assert.equal(new AwaitingStore({ home: s.home }).list().length, 0, "the watch never mints a decision");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("landing S03: actual parent CI notices carry facts and integration advice", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch parent notices", 302);
	new IntegrationHolds(s.home).hold(live.jobId, "notice verification");
	s.setGh({ runs: [run(302, live.head, "completed", "success")] });
	await s.parent("Observe the CI notice without taking action.", [{ kind: "text", text: "Observed." }], async () => {
		const messages = () => JSON.stringify(s.provider.requests("landing-parent-1-startup").concat(s.provider.requests("landing-parent-1")).map((request) => request.body.messages));
		const received = await waitFor(messages, (text) => text.includes("CI/PR OBSERVED"), { timeoutMs: 30_000, what: "CI notice reaches actual parent context" });
		const text = received.slice(received.lastIndexOf("CI/PR OBSERVED"));
		assert.match(text, /evidence, not authorization/i);
		assert.match(text, /Nothing has been merged/);
		assert.match(text, /cp_integrate/);
		assert.match(text, /do not re-query gh/i);
		assert.doesNotMatch(text, /verify CI (against|yourself)|check ancestry/i);
		assert.match(text, /no Awaiting-you row/i);
		assert.ok(text.includes(live.head.slice(0, 12)));
	});
	assert.ok(s.post.ciWatch.store.job(live.jobId)?.announced.length, "actual message arrival confirms the fact");
	s.setGh({ runs: [run(300, live.head, "completed", "skipped", { name: "lint" }), run(302, live.head, "completed", "failure")] });
	await s.parent("Observe the failing CI notice without taking action.", [{ kind: "text", text: "Observed red." }], async () => {
		const messages = () => JSON.stringify(s.provider.requests("landing-parent-2-startup").concat(s.provider.requests("landing-parent-2")).map((request) => request.body.messages));
		const received = await waitFor(messages, (text) => text.includes("CI/PR OBSERVED"), { timeoutMs: 30_000, what: "red CI notice reaches actual parent context" });
		const text = received.slice(received.lastIndexOf("CI/PR OBSERVED"));
		assert.match(text, /Merging red is forbidden/);
		assert.doesNotMatch(text, /evidence, not authorization/i);
		assert.ok(text.includes("(run 302 https://github.com/example/demo/actions/runs/302)"), "only the failing run is named");
		assert.ok(!text.includes("(run 300"), "a skipped run is never blamed");
	});
});

test("landing S03: a durable review deadline resumes once and respects changed facts", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const guard of ["none", "hold", "head", "missing_head", "generation", "phase", "closed", "drain", "stop"]) await t.test(guard, async (t) => {
		const s = await startStack(t, { continuation: true, env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "5" } });
		const live = await s.held(`review deadline ${guard}`, 310);
		await s.post.continuation.serialize(live.jobId, async () => {});
		const passedAt = isoTimestamp();
		writeWindowPass(s.home, live.jobId, live.head, passedAt);
		s.setGh({ integration: true, runs: [run(310, live.head, "completed", "success")] });
		await s.tick(live.jobId);
		await s.post.continuation.serialize(live.jobId, async () => {});
		const waiting = s.post.durableWakeups.pending().filter((entry) => entry.content.includes("HELD PR WAITING"));
		assert.equal(waiting.length, 1, "one deadline notice");
		assert.match(waiting[0]!.content, /re-enters every gate.*by itself; no cp_integrate advance is needed/);
		assert.match(waiting[0]!.content, /Sampled hold: none recorded/);
		if (guard !== "none") new IntegrationHolds(s.home).hold(live.jobId, "deadline hold");
		const before = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").length;
		if (guard === "head") {
			const file = join(s.home, LAYOUT.ciWatchFile);
			const memory = JSON.parse(readFileSync(file, "utf8"));
			memory.jobs[0].head_sha = "a".repeat(40);
			writeFileSync(file, JSON.stringify(memory));
		}
		if (guard === "missing_head") {
			const file = join(s.home, LAYOUT.ciWatchFile);
			const memory = JSON.parse(readFileSync(file, "utf8"));
			delete memory.jobs[0].head_sha;
			writeFileSync(file, JSON.stringify(memory));
		}
		if (guard === "phase" || guard === "closed") await s.post.fleet.patch(live.jobId, { phase: guard === "phase" ? "waiting" : "done" });
		if (guard === "generation") await s.post.fleet.patch(live.jobId, { supersessions: 1 });
		if (guard === "drain") writeFileSync(drainFile(s.home), JSON.stringify({ state: "draining", started_at: isoTimestamp(), deadline: isoTimestamp(new Date(Date.now() + 60_000)), timeout_s: 60, jobs: [] }));
		if (guard === "stop") {
			await s.post.shutdown();
			await waitFor(() => Date.now(), (now) => now >= Date.parse(passedAt) + 6_000, { timeoutMs: 15_000, what: "the stopped deadline passes in real time" });
			assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").length, before, "shutdown cancels deadline activity");
		}
		if (guard !== "stop") {
			const events = await waitFor(() => readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation"), (events) => events.length > before, { timeoutMs: 45_000, what: `deadline resumes through ${guard}` });
			const outcome = events.at(-1)!.payload as { action: string; steps: number };
			assert.equal(outcome.action, guard === "none" ? "done" : guard === "hold" || guard === "missing_head" ? "wait" : guard === "drain" ? "draining" : "stale", `${guard}: ${JSON.stringify(outcome)}`);
			assert.equal(mergedCalls(s.ghCalls()).length, guard === "none" ? 1 : 0, "the deadline rechecks every gate and merges only the unheld head");
			if (guard !== "none") assert.equal(outcome.steps, guard === "hold" ? 1 : 0, "changed facts prevent further integration");
		}
	});
});

test("landing S03: a restarted parent resumes a durable deadline and relays landing without a model turn", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("restart a review deadline", 307);
	await s.post.manager.shutdown(live.jobId);
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp());
	s.setGh({ integration: true, runs: [run(307, live.head, "completed", "success")] });
	const observed = await s.tick(live.jobId);
	s.post.confirmCi(observed.observations.map((entry) => entry.key));
	const original = s.post.integrator.get(live.jobId)?.updated_at;
	await s.parent("Observe the durable review window.", [{ kind: "text", text: "Window observed." }], async () => {
		await waitFor(() => s.post.integrator.get(live.jobId), (record) => record?.updated_at !== original && record?.next === "wait", { timeoutMs: 10_000, what: "the first parent arms the durable deadline" }).catch((error) => assert.fail(`startup did not arm the durable window: ${String(error)}`));
	});
	const before = s.post.integrator.get(live.jobId)!.updated_at;
	await waitFor(() => isoTimestamp(), (stamp) => stamp !== before, { timeoutMs: 5_000, what: "the next persisted timestamp quantum" });
	await s.parent("Resume the existing review window.", [{ kind: "text", text: "Window resumed." }], async (_events, _stderr, child) => {
		await waitFor(() => s.post.integrator.get(live.jobId), (record) => record?.updated_at !== before && record?.next === "wait", { timeoutMs: 10_000, what: "restart recomputes the existing review window" }).catch((error) => assert.fail(`restart did not recompute its durable window: ${String(error)}`));
		const turns = s.provider.requests("landing-parent-2").length;
		await waitFor(() => s.post.integrator.get(live.jobId), (record) => record?.next === "done" || record?.next === "surface", { timeoutMs: 45_000, what: "the restarted deadline reaches its terminal gate" });
		assert.equal(s.post.integrator.get(live.jobId)?.next, "done", JSON.stringify(s.post.integrator.get(live.jobId)));
		await child.waitFor((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && /HELD PR (LANDED|STOPPED)/.test(event.message), 45_000);
		assert.equal(mergedCalls(s.ghCalls()).length, 1);
		const notifications = child.records().filter((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("HELD PR LANDED"));
		assert.equal(notifications.length, 1, "one landed relay for this head and generation");
		assert.doesNotMatch(String(notifications[0]!.message), /tracker|write-back|receipt note/i);
		assert.ok(String(notifications[0]!.message).includes(live.prUrl), "the landed relay carries the full PR URL");
		assert.doesNotMatch(String(notifications[0]!.message), /then cp_next|relay the PR URL/);
		// The UI notification precedes any follow-up turn the runtime might queue.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await child.getState();
		assert.equal(s.provider.requests("landing-parent-2").length, turns, "landing is relayed without waking the parent model");
	});
});

test("landing S03: a real parent relays a newly parked handoff without a model turn", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("quiet parked handoff", 306);
	await s.post.manager.shutdown(live.jobId);
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
	s.setGh({ integration: true, runs: [run(306, live.head, "in_progress", null)] });
	await s.tick(live.jobId);
	await s.parent("Observe this PR while its CI runs.", [{ kind: "text", text: "Waiting for CI." }], async (_events, _stderr, child) => {
		const before = s.provider.requests("landing-parent-1").length;
		s.setGh({ integration: true, runs: [run(306, live.head, "completed", "success")] });
		await waitFor(() => s.post.fleet.get(live.jobId)?.phase, (phase) => phase === "awaiting_merge", { timeoutMs: 20_000, what: "green CI parks the reviewed PR through the real parent" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		await child.getState();
		const box = s.post.durableWakeups.read();
		const parked = [...box.pending, ...box.delivered, ...(box.discarded ?? [])].filter((entry) => entry.id.startsWith(`continuation:parked:${live.jobId}:`));
		assert.equal(parked.length, 1, "one durable parked relay");
		const parkedTurns = s.provider.requests("landing-parent-1").slice(before).filter((request) => JSON.stringify((request.body.messages as unknown[]).at(-1)).includes("HELD PR PARKED"));
		assert.equal(parkedTurns.length, 0, "parking is relayed without waking the parent model");
	});
});

test("landing S03: a driving worker keeps its slot and an integration write fault releases the busy fence", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("busy fence", 308);
	await s.post.continuation.serialize(live.jobId, async () => {});
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
	writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ ...s.post.budgets(), spawn_cap: 1 }));
	const model = s.provider.addScript("busy-fence-candidate", [{ kind: "hang" }]);
	s.agentDir.writeModels(s.provider);
	const candidate = await s.post.ledger().create({ title: "dispatch while integration drives", project: "demo", delivery: "local", kind: "ship" });
	const gate = join(s.home, "release-busy-read");
	const before = s.ghCalls().length;
	s.setGh({ runs: [run(308, live.head, "completed", "success")], routes: [{ match: `pr view ${live.prUrl}`, replies: [{ untilFile: gate, pass: true }] }] });
	await s.tick(live.jobId);
	try {
		await waitFor(() => s.ghCalls().slice(before), (calls) => calls.some((call) => call.startsWith("pr view")), { timeoutMs: 10_000, what: "integration occupies its worker's busy fence" });
		await assert.rejects(() => s.post.dispatch({ jobId: candidate.id, task: "Wait for a free worker slot.", model, fetch: false }), /spawn cap/);
		assert.equal(s.post.manager.get(live.jobId)?.worker.alive, true, "dispatch cannot release an author while integration drives");
		const file = join(s.home, paths.runDir(live.jobId), "integration.json");
		rmSync(file, { force: true });
		mkdirSync(file);
	} finally { writeFileSync(gate, "release"); }
	await s.post.continuation.serialize(live.jobId, async () => {});
	const outcome = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").at(-1)!.payload as { action: string; reason: string };
	assert.equal(outcome.action, "error", "a real filesystem write fault reaches the continuation catch");
	assert.match(outcome.reason, /EISDIR|directory/);
	rmSync(join(s.home, paths.runDir(live.jobId), "integration.json"), { recursive: true });
	const after = await s.post.ledger().create({ title: "dispatch after integration throws", project: "demo", delivery: "local", kind: "ship" });
	await assert.doesNotReject(async () => {
		assert.equal((await s.post.dispatch({ jobId: after.id, task: "Use the now-free worker slot.", model, fetch: false })).receipt, "accepted");
	}, "the throwing step clears its busy fence");
	assert.equal(s.post.heldRelease.wasReleased(live.jobId), true);
});

test("landing S03: a stopped red fact replays no repair while a new attempt is actionable", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("red attempt replay", 309);
	await s.post.continuation.serialize(live.jobId, async () => {});
	const grant = s.post.mandates.issue({ projects: ["demo"], objective: "repair red replay", expiry: isoTimestamp(new Date(Date.now() - 1_000)), at: isoTimestamp(new Date(Date.parse(s.post.fleet.require(live.jobId).dispatched_at) - 60_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
	s.post.mandates.revoke(grant.id);
	s.setGh({ runs: [run(309, live.head, "completed", "failure")] });
	const first = await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "surface", "red repair is refused by the revoked authority");
	const reads = s.ghCalls().filter((call) => call.startsWith("pr view")).length;
	const notices = s.post.durableWakeups.pending().map((entry) => entry.id);
	s.post.confirmCi([first.observations[0]!.key]);
	rmSync(join(s.home, LAYOUT.ciWatchFile));
	const replay = await s.post.ciTick();
	assert.equal(replay.observations[0]?.key, first.observations[0]!.key);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.ghCalls().filter((call) => call.startsWith("pr view")).length, reads, "a completed red replay starts no integration step");
	assert.deepEqual(s.post.durableWakeups.pending().map((entry) => entry.id), notices, "one durable stop for the same head and generation");
	s.post.confirmCi([replay.observations[0]!.key]);
	rmSync(join(s.home, LAYOUT.ciWatchFile));
	s.setGh({ runs: [run(309, live.head, "completed", "failure", { run_attempt: 2 })] });
	const rerun = await s.post.ciTick();
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.notEqual(rerun.observations[0]?.key, first.observations[0]!.key);
	assert.equal(s.ghCalls().filter((call) => call.startsWith("pr view")).length, reads + 1, "a new attempt reaches integration once");
	assert.equal(s.post.fleet.require(live.jobId).supersessions ?? 0, 0, "no promotion bypasses revoked authority");
	s.post.confirmCi([rerun.observations[0]!.key]);
	rmSync(join(s.home, LAYOUT.ciWatchFile));
	await s.post.fleet.patch(live.jobId, { supersessions: 1 });
	await s.post.ciTick();
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.ghCalls().filter((call) => call.startsWith("pr view")).length, reads + 2, "a reopened generation is a new continuation identity");
	const stops = () => s.post.durableWakeups.pending().filter((entry) => entry.content.startsWith("HELD PR STOPPED"));
	const handed = stops().length;
	writeFileSync(join(live.worktree, "change-request.txt"), "address the operator's change request\n");
	execFileSync("git", ["add", "change-request.txt"], { cwd: live.worktree });
	execFileSync("git", ["commit", "--quiet", "-m", "new handed-off head"], { cwd: live.worktree });
	execFileSync("git", ["push", "--quiet", "origin", "HEAD"], { cwd: live.worktree });
	const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: live.worktree, encoding: "utf8" }).trim();
	s.setGh({ runs: [run(309, newHead, "completed", "failure")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(stops().length, handed + 1, "a changed handed-off head gets one more durable stop");
	assert.ok(stops().every((entry) => entry.keys?.[0] === live.jobId), "actionable stops go stale when the job closes");
	execFileSync("git", ["push", "--quiet", "origin", "HEAD:refs/heads/main"], { cwd: live.worktree });
	s.setGh({ routes: [
		{ match: "pulls/309", replies: [json({ number: 309, html_url: live.prUrl, state: "closed", merged: true, merge_commit_sha: newHead, merged_at: isoTimestamp(), head: { sha: newHead, ref: live.jobId } })] },
		{ match: `pr view ${live.prUrl}`, replies: [json({ number: 309, url: live.prUrl, state: "MERGED", headRefOid: newHead, headRefName: live.jobId, baseRefName: "main", mergedAt: isoTimestamp(), mergeCommit: { oid: newHead } })] },
	] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "done", "a human's merge lands even after an actionable handoff");
	assert.equal(s.post.durableWakeups.pending().filter((entry) => entry.content.startsWith("HELD PR LANDED")).length, 1, "the human's merge is relayed once");
});

test("landing S03: lost watch memory coalesces in-flight facts and rearms a settled wait", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("replay a waiting CI fact", 311);
	await s.post.continuation.serialize(live.jobId, async () => {});
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
	new IntegrationHolds(s.home).hold(live.jobId, "wait replay");
	const before = s.ghCalls().filter((call) => call.startsWith("pr view")).length;
	const gate = join(s.home, "release-replay");
	s.setGh({ runs: [run(311, live.head, "completed", "success")], routes: [{ match: `pr view ${live.prUrl}`, replies: [{ untilFile: gate, pass: true }] }] });
	const original = await s.tick(live.jobId);
	try {
		await waitFor(() => s.ghCalls(), (calls) => calls.filter((call) => call.startsWith("pr view")).length > before, { timeoutMs: 10_000, what: "the first fact is in flight" });
		s.post.confirmCi([original.observations[0]!.key]);
		rmSync(join(s.home, LAYOUT.ciWatchFile));
		const replay = await s.post.ciTick();
		assert.equal(replay.observations[0]?.key, original.observations[0]!.key, "lost disk memory replays the same CI identity");
		s.post.confirmCi([replay.observations[0]!.key]);
	} finally { writeFileSync(gate, "release"); }
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.ghCalls().filter((call) => call.startsWith("pr view")).length, before + 1, "an in-flight replay starts no additional integration read");
	rmSync(join(s.home, LAYOUT.ciWatchFile));
	await s.post.ciTick();
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.ghCalls().filter((call) => call.startsWith("pr view")).length, before + 2, "the same identity can read again after settling on wait");
	assert.equal(s.post.integrator.get(live.jobId)?.next, "wait");
});

test("landing S03: changes during a branch update stop before the next integration step", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const changed of ["generation", "phase", "head", "drain"]) await t.test(changed, async (t) => {
		const s = await startStack(t, { continuation: true });
		const live = await s.held(`between integration steps ${changed}`, 312);
		await s.post.continuation.serialize(live.jobId, async () => {});
		writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
		const gate = join(s.home, "release-update");
		s.setGh({ runs: [run(312, live.head, "completed", "success")], routes: [
			{ match: `pr view ${live.prUrl}`, replies: [json({ number: 312, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", isDraft: false })] },
			{ match: "pr update-branch", replies: [{ untilFile: gate }] },
		] });
		await s.tick(live.jobId);
		try {
			await waitFor(() => s.ghCalls(), (calls) => calls.some((call) => call.startsWith("pr update-branch")), { timeoutMs: 10_000, what: "the server branch update starts" });
			if (changed === "generation") await s.post.fleet.patch(live.jobId, { supersessions: 1 });
			if (changed === "phase") await s.post.fleet.patch(live.jobId, { phase: "waiting" });
			if (changed === "head") {
				const file = join(s.home, LAYOUT.ciWatchFile);
				const memory = JSON.parse(readFileSync(file, "utf8"));
				memory.jobs[0].head_sha = "a".repeat(40);
				writeFileSync(file, JSON.stringify(memory));
			}
			if (changed === "drain") writeFileSync(drainFile(s.home), JSON.stringify({ state: "draining", started_at: isoTimestamp(), deadline: isoTimestamp(new Date(Date.now() + 60_000)), timeout_s: 60, jobs: [] }));
		} finally { writeFileSync(gate, "release"); }
		await s.post.continuation.serialize(live.jobId, async () => {});
		const outcome = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").at(-1)!.payload as { action: string; steps: number; reason: string };
		assert.equal(outcome.action, changed === "drain" ? "draining" : "stale", outcome.reason);
		assert.equal(outcome.steps, 1, "the already-running step completes and nothing starts after it");
		assert.equal(s.ghCalls().filter((call) => call.startsWith("pr update-branch")).length, 1, "no repeated update after changed facts");
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
	});
});

test("landing S03: actual parent arrival accepts legacy CI keys and rejects unrelated messages", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("legacy CI arrival", 322);
	new IntegrationHolds(s.home).hold(live.jobId, "arrival probe");
	s.setGh({ runs: [run(322, live.head, "in_progress", null)] });
	const legacy = `${live.jobId}|${live.head}|ci_green`;
	const current = `${live.jobId}|${live.head}|ci_failed|arrival`;
	const unrelated = `${live.jobId}|${live.head}|pr_closed`;
	const file = join(s.home, "arrival-messages.json");
	writeFileSync(file, JSON.stringify([
		{ customType: "cp-ci", content: "Legacy arrival", display: true, details: { ci: [legacy] } },
		{ customType: "cp-ci", content: "Object arrival", display: true, details: { ci: [{ key: current }] } },
		{ customType: "cp-envelope", content: "Unrelated arrival", display: true, details: { ci: [unrelated] } },
		{ customType: "cp-ci", content: "Missing details", display: true },
	]));
	const model = s.provider.addScript("arrival-parent", [{ kind: "text", text: "Arrivals observed." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model, env: { ...s.agentDir.env, CP_HOME: s.home, CP_S03_ARRIVAL_FILE: file }, extensions: [COMMAND_POST_EXTENSION, join(REPO_ROOT, "tests/fixtures/ci-arrival-extension.ts")] });
	try {
		await child.prompt("Observe the restored CI messages.");
		await child.waitForSettled(60_000);
		await waitFor(() => s.post.ciWatch.store.job(live.jobId)?.announced, (keys) => Boolean(keys?.includes(legacy) && keys.includes(current)), { timeoutMs: 10_000, what: "both legacy and object arrivals are confirmed on their owning job" });
		assert.ok(!s.post.ciWatch.store.job(live.jobId)!.announced.includes(unrelated), "only cp-ci messages confirm CI arrival");
	} finally { await child.close(); }
});

test("landing S03: startup snapshots queued held heads and generations before the lane opens", { skip: SKIP, timeout: 180_000 }, async (t) => {
	for (const changed of ["generation", "head"]) await t.test(changed, async (t) => {
		const s = await startStack(t);
		const first = await s.held("startup lane owner", 316);
		const second = await s.held("startup queued identity", 317);
		await s.post.manager.shutdown(first.jobId);
		await s.post.manager.shutdown(second.jobId);
		const gate = join(s.home, "startup-lane-release");
		s.setGh({ runs: [run(316, first.head, "completed", "success"), run(317, second.head, "completed", "success")], routes: [{ match: `pr view ${first.prUrl}`, replies: [{ pass: true, untilFile: gate }] }] });
		await s.parent("Observe queued startup identities.", [{ kind: "text", text: "Observed." }], async () => {
			await waitFor(() => s.ghCalls().some((call) => call.startsWith(`pr view ${first.prUrl}`)), Boolean, { timeoutMs: 10_000, what: "first startup holds the project lane" });
			try {
				if (changed === "generation") await s.post.fleet.patch(second.jobId, { supersessions: 1 });
				else {
					const file = lastFiledEnvelopeFile(s.home, s.post.fleet.get(second.jobId)!)!;
					const record = JSON.parse(readFileSync(file, "utf8"));
					record.envelope.head_sha = "a".repeat(40);
					writeFileSync(file, JSON.stringify(record));
				}
			} finally { writeFileSync(gate, "release"); }
			const outcome = await waitFor(() => readRunEvents(s.home, second.jobId).filter((event) => event.type === "continuation").at(-1)?.payload as { action: string; key: string; reason: string } | undefined, (entry) => entry !== undefined, { timeoutMs: 15_000, what: "queued startup records its outcome" });
			assert.equal(outcome!.action, "stale", "queued startup cannot adopt a reopened identity");
			assert.ok(outcome!.key.includes(second.head) && outcome!.key.endsWith("startup@1"), "startup identity preserves the observed head and generation");
			assert.match(outcome!.reason, changed === "generation" ? /generation 1 to 2/ : /moved from/);
			assert.ok(!s.ghCalls().some((call) => call.startsWith(`pr view ${second.prUrl}`)), "stale queued startup reaches no forge read");
		});
	});
});

test("landing S03: expired review passes advance immediately and deadline faults never rearm", { skip: SKIP, timeout: 240_000 }, async (t) => {
	for (const mode of ["expired", "retry"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`restart window ${mode}`, 318);
		await s.post.manager.shutdown(live.jobId);
		writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - (mode === "expired" ? 60_000 : 0))));
		s.setGh({ integration: true, runs: [run(318, live.head, "completed", "success")], routes: mode === "retry" ? [{ match: "pr merge", replies: [{ code: 1, stderr: "network unavailable" }] }] : [] });
		await s.parent("Resume the review window.", [{ kind: "text", text: "Observing." }], async () => {
			await waitFor(() => s.post.integrator.get(live.jobId), (record) => record?.next === (mode === "expired" ? "done" : "retry"), { timeoutMs: mode === "expired" ? 15_000 : 45_000, what: `${mode} startup reaches terminal result` });
			const records = () => readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation" && (event.payload as { event: string }).event === "startup");
			if (mode === "retry") await waitFor(records, (events) => events.some((event) => (event.payload as { next: string }).next === "retry"), { timeoutMs: 45_000, what: "startup deadline itself records retry" });
			if (mode === "expired") assert.equal(s.post.durableWakeups.read().pending.filter((entry) => entry.content.includes("HELD PR WAITING")).length, 0, "expired pass creates no new deadline");
			else {
				const count = records().length;
				await new Promise((resolve) => setTimeout(resolve, 32_000));
				assert.equal(records().length, count, "operational retry never rearms its deadline");
				assert.ok(records().some((event) => (event.payload as { next: string }).next === "retry"), "the deadline fault remains an operational retry");
			}
		});
	});
});

test("landing S03: unreadable drain blocks a deadline and leaves its fact actionable", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("unreadable drain recovery", 319);
	await s.post.continuation.serialize(live.jobId, async () => {});
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp());
	s.setGh({ integration: true, runs: [run(319, live.head, "completed", "success")] });
	const original = await s.tick(live.jobId);
	s.post.confirmCi(original.observations.map((entry) => entry.key));
	await s.post.continuation.serialize(live.jobId, async () => {});
	writeFileSync(drainFile(s.home), "{ invalid json");
	const before = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").length;
	const entries = await waitFor(() => readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation"), (entries) => entries.length > before, { timeoutMs: 45_000, what: "deadline encounters unreadable drain" });
	const outcome = entries.at(-1)!.payload as { action: string; steps: number };
	assert.equal(outcome.action, "draining", "unreadable drain fails closed at the real deadline");
	assert.equal(outcome.steps, 0);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	rmSync(drainFile(s.home));
	rmSync(join(s.home, LAYOUT.ciWatchFile));
	const replay = await s.post.ciTick();
	assert.equal(replay.observations[0]?.key, original.observations[0]?.key, "drain recovery replays the identical CI fact");
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "done", "the same CI fact remains actionable after drain recovery");
});

test("landing S03: patch-equivalent review waits synchronously on its new durable pass", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("equivalent review window", 321);
	await s.post.continuation.serialize(live.jobId, async () => {});
	await s.post.manager.shutdown(live.jobId);
	const patchId = execFileSync("git", ["patch-id", "--stable"], { input: git(live.worktree, "diff", "origin/main...HEAD"), encoding: "utf8" }).split(" ")[0]!;
	const originalPassAt = isoTimestamp();
	writeWindowPass(s.home, live.jobId, live.head, originalPassAt, { patch_id: patchId });
	s.setGh({ integration: true, runs: [run(321, live.head, "completed", "success")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	advanceBase(s.repo, "base-window.txt", "base advances\n");
	git(live.worktree, "fetch", "origin");
	git(live.worktree, "merge", "--no-edit", "origin/main");
	git(live.worktree, "push", "origin", live.jobId);
	const head = git(live.worktree, "rev-parse", "HEAD");
	s.setGh({ integration: true, runs: [run(321, head, "completed", "success")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	const equivalent = JSON.parse(readFileSync(join(s.home, paths.reviewEquivalenceFile(live.jobId, head)), "utf8"));
	assert.equal(equivalent.equivalent_to.head_sha, live.head);
	const outcome = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").at(-1)!.payload as { action: string; steps: number };
	assert.equal(outcome.action, "wait");
	assert.equal(outcome.steps, 1, "synchronous equivalence arms the window without another integration step");
	assert.equal(s.post.durableWakeups.pending().filter((entry) => entry.content.includes("HELD PR WAITING")).length, 2, "a changed head replaces the original deadline");
	await s.post.fleet.patch(live.jobId, { supersessions: 1 });
	s.setGh({ runs: [run(321, head, "completed", "success", { run_attempt: 2 })] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.durableWakeups.pending().filter((entry) => entry.content.includes("HELD PR WAITING")).length, 3, "a valid new generation replaces its deadline");
	await waitFor(() => Date.now(), (now) => now > Date.parse(originalPassAt) + 30_300, { timeoutMs: 40_000, what: "the canceled original deadline passes" });
	assert.equal(mergedCalls(s.ghCalls()).length, 0, "replaced deadlines never merge early");
	await s.post.integrate({ jobId: live.jobId });
	assert.equal(s.post.integrator.get(live.jobId)?.next, "wait", "the waiting review releases the manual integration lane");
	await waitFor(() => s.post.integrator.get(live.jobId)?.next, (next) => next === "done", { timeoutMs: 45_000, what: "equivalent pass deadline lands" });
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
});

test("landing S03: actionable surface and retry stops reach the real parent once", { skip: SKIP, timeout: 180_000 }, async (t) => {
	for (const next of ["surface", "retry"]) await t.test(next, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`actionable stop ${next}`, 323);
		await s.post.manager.shutdown(live.jobId);
		writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
		s.setGh({ integration: true, runs: [run(323, live.head, "in_progress", null)] });
		await s.parent("Observe this PR's actionable stop.", [{ kind: "text", text: "Observing." }], async () => {
			const before = s.provider.requests("landing-parent-1").length;
			s.setGh({ permission: next === "surface" ? "BLOCKED" : "CLEAN", runs: [run(323, live.head, "completed", "success")], routes: next === "retry" ? [{ match: "pr merge", replies: [{ code: 1, stderr: "network unavailable" }] }] : [] });
			await waitFor(() => s.provider.requests("landing-parent-1").slice(before).filter((request) => JSON.stringify((request.body.messages as unknown[]).at(-1)).includes("HELD PR STOPPED")), (requests) => requests.length > 0, { timeoutMs: 20_000, what: `${next} stop wakes the actual parent` });
			const box = s.post.durableWakeups.read();
			const stops = [...box.pending, ...box.delivered].filter((entry) => entry.id.startsWith(`continuation:${live.jobId}:`) && entry.id.endsWith(`:${next}`));
			assert.equal(stops.length, 1, "one durable actionable stop");
			assert.ok(s.provider.requests("landing-parent-1").slice(before).some((request) => JSON.stringify(request.body.messages).includes(`next: ${next}`)));
		});
	});
});

test("landing S03: armed-release failure stays visible after landing and a stop never releases", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.held("landing callback consumer", 325);
	await s.post.continuation.serialize(live.jobId, async () => {});
	await s.post.manager.shutdown(live.jobId);
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp(new Date(Date.now() - 60_000)));
	const file = join(s.home, LAYOUT.armedDispatchFile);
	writeFileSync(file, "{ invalid json");
	const failures = () => s.post.durableWakeups.pending().filter((entry) => entry.content.includes("ARMED DISPATCH RELEASE FAILED"));
	s.setGh({ integration: true, permission: "BLOCKED", runs: [run(325, live.head, "completed", "success")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(s.post.integrator.get(live.jobId)?.next, "surface");
	assert.equal(failures().length, 0, "a stopped continuation never releases armed dependents");
	s.setGh({ permission: "CLEAN", runs: [run(325, live.head, "completed", "success", { run_attempt: 2 })] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	await waitFor(failures, (entries) => entries.length === 1, { timeoutMs: 10_000, what: "the real landed hook reports its consumer failure" });
	assert.equal(s.post.integrator.get(live.jobId)?.next, "done", "armed-release failure cannot undo the landing");
	assert.equal(readFileSync(file, "utf8"), "{ invalid json", "failed release preserves its input");
	await s.post.ciTick();
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
});

test("landing S03: a real parent that loses its lock cannot execute a pending review deadline", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("deadline lock loss", 315);
	const passedAt = isoTimestamp();
	writeWindowPass(s.home, live.jobId, live.head, passedAt);
	s.setGh({ runs: [run(315, live.head, "completed", "success")] });
	await s.parent("Observe this held PR's review deadline.", [{ kind: "text", text: "Observed the deadline." }], async () => {
		// The parent may deliver the notice before this callback starts polling.
		await waitFor(() => {
			const { pending, delivered } = s.post.durableWakeups.read();
			return [...pending, ...delivered].some((entry) => entry.id.startsWith(`continuation:window:${live.jobId}@`));
		}, Boolean, { timeoutMs: 10_000, what: "startup arms its review deadline" });
		rmSync(join(s.home, LAYOUT.parentLock));
		await waitFor(() => Date.now(), (now) => now >= Date.parse(passedAt) + 31_000, { timeoutMs: 40_000, what: "the unowned parent's deadline passes" });
		assert.equal(s.post.integrator.get(live.jobId)?.next, "wait", "disabled ownership cannot advance beyond the review wait");
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
	});
});

test("landing S03: facts changed during a forge read prevent stale review spending", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const changed of ["generation", "phase", "observed", "remote", "missing"]) await t.test(changed, async (t) => {
		const s = await startStack(t, { continuation: true });
		const live = await s.held(`stale review ${changed}`, 320);
		await s.post.continuation.serialize(live.jobId, async () => {});
		const reviewer = s.provider.addScript(`stale-review-${changed}`, [{ kind: "hang" }]);
		s.agentDir.writeModels(s.provider);
		writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));

		const gate = join(s.home, "release-stale-read");
		const before = s.ghCalls().length;
		const notices = s.post.durableWakeups.pending().map((entry) => entry.id);
		const reply = changed === "remote"
			? json({ number: 320, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: "b".repeat(40), baseRefName: "main", isDraft: false })
			: { pass: true };
		s.setGh({ runs: [run(320, live.head, "completed", "success")], routes: [{ match: `pr view ${live.prUrl}`, replies: [{ untilFile: gate, ...reply }] }] });
		await s.tick(live.jobId);
		await waitFor(() => s.ghCalls().slice(before).some((call) => call.startsWith(`pr view ${live.prUrl}`)), Boolean, { timeoutMs: 10_000, what: "integration reaches real forge barrier" });
		try {
			if (changed === "generation") await s.post.fleet.patch(live.jobId, { supersessions: 1 });
			if (changed === "phase") await s.post.fleet.patch(live.jobId, { phase: "waiting" });
			if (changed === "observed") {
				const file = join(s.home, LAYOUT.ciWatchFile);
				const memory = JSON.parse(readFileSync(file, "utf8"));
				memory.jobs[0].head_sha = "a".repeat(40);
				writeFileSync(file, JSON.stringify(memory));
			}
		} finally {
			if (changed === "missing") rmSync(join(s.home, LAYOUT.ciWatchFile), { force: true });
			writeFileSync(gate, "release");
		}
		await s.post.continuation.serialize(live.jobId, async () => {});
		const outcome = readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").at(-1)!.payload as { action: string; steps: number; reason: string };
		assert.equal(outcome.action, changed === "phase" ? "stopped" : changed === "missing" ? "wait" : "stale", `${changed}: ${outcome.reason}`);
		assert.equal(outcome.steps, 1, "the running read finishes but starts no second step");
		assert.equal(existsSync(join(s.home, paths.reviewFile(live.jobId, 1))), false, "stale facts start no review");
		assert.equal(s.provider.requests(`stale-review-${changed}`).length, 0, "no model request on stale facts");
		if (changed !== "phase") assert.deepEqual(s.post.durableWakeups.pending().map((entry) => entry.id), notices, "stale facts create no actionable stop notice");
	});
});

test("landing S03: REST PR facts carry parsed fields and malformed inputs produce no fact", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("REST PR parsing", 350);
	const merge = "b".repeat(40);
	s.setGh({ routes: [{ match: "pulls/350", replies: [{ stdout: JSON.stringify({ number: 350, html_url: live.prUrl, state: "closed", merged: true, merge_commit_sha: merge, merged_at: isoTimestamp(), head: { sha: live.head, ref: live.jobId } }) }] }] });
	const tick = await s.post.ciTick();
	assert.equal(tick.observations[0]?.event, "pr_merged", "REST merged flag reaches the public observation");
	assert.equal(tick.observations[0]?.head_sha, live.head);
	assert.equal(tick.observations[0]?.merge_commit_sha, merge);
	rmSync(join(s.home, LAYOUT.ciWatchFile), { force: true });
	s.setGh({ routes: [{ match: "pulls/350", replies: [{ stdout: "" }] }] });
	const empty = await s.post.ciTick();
	assert.equal(empty.observations.length, 0, "empty REST output is no PR fact");
	assert.equal(empty.errors.length, 0, "empty REST output is tolerated");
	await s.post.fleet.patch(live.jobId, { receipts: [{ kind: "pr", status: "open", title: "invalid remote URL", url: "https://example.com/whatever" }] });
	rmSync(join(s.home, LAYOUT.ciWatchFile), { force: true });
	const before = s.ghCalls().length;
	const invalid = await s.post.ciTick();
	assert.equal(invalid.observations.length, 0, "an unsupported PR URL is no fact");
	assert.ok(s.ghCalls().slice(before).every((call) => !/api .*\/pulls\//.test(call)), "an unsupported PR URL issues no PR REST request");
});

test("landing S03: a real review verdict samples hold state in its one waiting notice", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const hold of ["absent", "present", "unreadable"]) await t.test(hold, async (t) => {
		const s = await startStack(t, { continuation: true });
		const live = await s.held(`waiting notice ${hold}`, 340);
		await s.post.continuation.serialize(live.jobId, async () => {});
		let sampledCalls = 0;
		const reviewer = s.provider.addScript(`sample-hold-${hold}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: () => {
			if (hold === "present") new IntegrationHolds(s.home).hold(live.jobId, `operator review ${"x".repeat(400)}`);
			if (hold === "unreadable") writeFileSync(new IntegrationHolds(s.home).file(live.jobId), "{broken");
			sampledCalls = s.ghCalls().length;
			return { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["the mocked diff satisfies the task"] };
		} }] }, { kind: "hang" }]);
		s.agentDir.writeModels(s.provider);
		writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));
		s.setGh({ runs: [run(340, live.head, "completed", "success")] });
		await s.tick(live.jobId);
		const notices = () => s.post.durableWakeups.pending().filter((entry) => entry.content.includes("HELD PR WAITING"));
		await waitFor(notices, (entries) => entries.length === 1, { timeoutMs: 15_000, what: "real review handback arms one deadline notice" });
		const text = notices()[0]!.content;
		assert.equal(s.ghCalls().length, sampledCalls, "verdict handback reads no forge facts");
		assert.match(text, /merge waits until .*re-enters every gate/s);
		assert.match(text, /by itself; no cp_integrate advance is needed/);
		if (hold === "absent") assert.match(text, /Sampled hold: none recorded/);
		if (hold === "present") {
			assert.match(text, /Sampled hold \(not a fresh CI or permission read\): operator review x+… \(truncated, 416 chars\)/);
			assert.ok(!text.includes("x".repeat(301)), "the sampled reason is bounded");
		}
		if (hold === "unreadable") assert.match(text, /Hold state unconfirmed .*integration fails closed/s);
	});
});

test("landing S03: a real revise verdict belongs to its implementer and starts no continuation", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const repairGate = join(s.home, "revise-author-release");
	const live = await s.held("revise handback", 324, { repairGate });
	await s.post.continuation.serialize(live.jobId, async () => {});
	const reviewer = s.provider.addScript("s03-revise-review", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: live.jobId, verdict: "revise", reasons: ["[severity: high] [confidence: high] missing behavior"], revisions: ["S03 repair this behavior"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } } }] }, { kind: "hang" }]);
	s.agentDir.writeModels(s.provider);
	writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));
	s.setGh({ runs: [run(324, live.head, "completed", "success")] });
	await s.tick(live.jobId);
	await waitFor(() => s.provider.requests(`landing-${live.jobId}`), (requests) => requests.some((request) => JSON.stringify(request.body.messages).includes("S03 repair this behavior")), { timeoutMs: 20_000, what: "revision reaches this job's implementer" });
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation" && (event.payload as { event: string }).event === "verdict").length, 0, "revise handback never schedules integration");
	assert.equal(s.provider.requests("s03-revise-review").length, 1, "no second reviewer");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("landing S03: a real passing research gate starts no held-PR continuation", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const job = await s.post.ledger().create({ title: "gate is not diff review", project: "demo", delivery: "answer", kind: "research" });
	const planner = s.provider.addScript("s03-gate-planner", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: 'printf "# Plan\\nInspect the existing implementation.\\n" > "$CP_ARTIFACT_PATH"' } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: job.id, kind: "research", status: "done", summary: "Inspection plan.", artifact_path: join(s.home, paths.artifactFile(job.id)), plan_summary: { goal: "Inspect", approach: ["Read implementation"], touched: ["src/ci-watch.ts"], acceptance: ["Report findings"], risk: "Read only" } } }] },
		{ kind: "hang" },
	]);
	const reviewer = s.provider.addScript("s03-gate-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: job.id, verdict: "pass", reasons: ["Plan is complete"], flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false } } }] }, { kind: "hang" }]);
	s.agentDir.writeModels(s.provider);
	writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));
	await s.post.dispatch({ jobId: job.id, task: "Read and report a short inspection plan.", model: planner, fetch: false });
	await waitFor(() => s.post.fleet.get(job.id)?.reported_at, Boolean, { timeoutMs: 20_000, what: "planner report" });
	const gate = await s.post.gate({ jobId: job.id });
	assert.equal(gate.next, "wait");
	assert.ok("key" in gate);
	await s.post.reviewRuns.settled(gate.key);
	assert.equal(JSON.parse(readFileSync(join(s.home, paths.gateFile(job.id, gate.attempt)), "utf8")).verdict, "pass", "the real gate passes");
	assert.equal(readRunEvents(s.home, job.id).filter((event) => event.type === "continuation").length, 0, "a gate pass schedules no PR integration");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("landing S03: new CI attempts never duplicate a pending real reviewer", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const reviewer = s.provider.addScript("s03-pending-review", [{ kind: "hang" }]);
	writeFileSync(join(s.home, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer }] }));
	const live = await s.held("review pending and wait rearm", 330);
	await s.post.continuation.serialize(live.jobId, async () => {});
	s.setGh({ runs: [run(330, live.head, "in_progress", null)] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	s.setGh({ runs: [run(330, live.head, "completed", "success")] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	await waitFor(() => s.provider.requests("s03-pending-review").length, (count) => count === 1, { timeoutMs: 10_000, what: "real reviewer receives its request" });
	const observations = () => readRunEvents(s.home, live.jobId).filter((event) => event.type === "continuation").map((event) => event.payload as { action: string; event: string });
	assert.ok(observations().some((outcome) => outcome.action === "review_started"), "the envelope starts the real reviewer");
	s.setGh({ runs: [run(330, live.head, "completed", "success", { run_attempt: 2 })] });
	await s.tick(live.jobId);
	await s.post.continuation.serialize(live.jobId, async () => {});
	assert.equal(observations().at(-1)?.action, "review_pending", "a new fact reaches the already-pending review gate");
	assert.equal(s.provider.requests("s03-pending-review").length, 1, "one model request while review is pending");
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});


// A malformed fleet.json while the real parent watches a held PR must journal one watch failure, not crash it.
test("landing S03: the real parent journals a watch failure on a malformed fleet without crashing", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("watch error journal", 305);
	s.setGh({ runs: [run(305, live.head, "in_progress", null)] });
	const file = s.post.fleet.file;
	const original = readFileSync(file, "utf8");
	await s.parent("Observe watch recovery.", [{ kind: "text", text: "Observing." }], async (_events, stderr) => {
		try {
			writeFileSync(file, "{ invalid json");
			await waitFor(stderr, (text) => /WATCH (TICK )?FAILED/.test(text), { timeoutMs: 40_000, what: "watch journals malformed fleet" });
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			assert.doesNotMatch(stderr(), /Node\.js v\d|FleetError: .*\n\s+at /, "the parent survives the unreadable fleet");
		} finally {
			writeFileSync(file, original);
		}
	});
});
