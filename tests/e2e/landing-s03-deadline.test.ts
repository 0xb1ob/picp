/** Behavior 05 landing S03 e2e: durable review deadlines; split from landing-s03.test.ts, fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { readRunEvents, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, run, json, startStack, mergedCalls } from "./landing-helpers.ts";

test("landing S03: a durable review deadline resumes once and respects changed facts", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const guard of ["none", "draft", "hold", "head", "missing_head", "generation", "phase", "closed", "drain", "stop"]) await t.test(guard, async (t) => {
		const s = await startStack(t, { continuation: true, env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "5" } });
		const live = await s.held(`review deadline ${guard}`, 310);
		await s.post.continuation.serialize(live.jobId, async () => {});
		const passedAt = isoTimestamp();
		writeWindowPass(s.home, live.jobId, live.head, passedAt);
		const draft = json({ number: 310, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", isDraft: true });
		const routes = guard === "draft" ? [{ match: "pr view", replies: [draft, draft, { pass: true }] }, { match: "pr ready", replies: [{}] }] : [];
		s.setGh({ integration: true, runs: [run(310, live.head, "completed", "success")], routes });
		await s.tick(live.jobId);
		await s.post.continuation.serialize(live.jobId, async () => {});
		const waiting = s.post.durableWakeups.pending().filter((entry) => entry.content.includes("HELD PR WAITING"));
		assert.equal(waiting.length, 1, "one deadline notice");
		assert.match(waiting[0]!.content, /re-enters every gate.*by itself; no cp_integrate advance is needed/);
		assert.match(waiting[0]!.content, /Sampled hold: none recorded/);
		if (guard !== "none" && guard !== "draft") new IntegrationHolds(s.home).hold(live.jobId, "deadline hold");
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
			assert.equal(outcome.action, guard === "none" || guard === "draft" ? "done" : guard === "hold" || guard === "missing_head" ? "wait" : guard === "drain" ? "draining" : "stale", `${guard}: ${JSON.stringify(outcome)}`);
			assert.equal(mergedCalls(s.ghCalls()).length, guard === "none" || guard === "draft" ? 1 : 0, "the deadline rechecks every gate and merges only the unheld head");
			if (guard === "draft") assert.equal(s.ghCalls().filter((call) => call.startsWith("pr ready")).length, 1, "the timer readies the reviewed draft once, with no cp_integrate call");
			if (guard !== "none" && guard !== "draft") assert.equal(outcome.steps, guard === "hold" ? 1 : 0, "changed facts prevent further integration");
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
