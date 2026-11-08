/** Behavior 05 landing S03 e2e: held-continuation CI facts, review gating and integration steps; fixtures in landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { routeNamed, readRunEvents, waitFor } from "../harness/index.ts";
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
		routeNamed(s.home, [model]);
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
		routeNamed(s.home, [model]);
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
	routeNamed(s.home, [planner]);
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
