/** Behavior 05 landing S03 e2e: real-parent notices, relays and startup review windows; fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, paths } from "../../src/contracts.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { lastFiledEnvelopeFile } from "../../src/supersede.ts";
import { COMMAND_POST_EXTENSION, startPiChild, advanceBase, git, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, run, startStack, mergedCalls } from "./landing-helpers.ts";

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
