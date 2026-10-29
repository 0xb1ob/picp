/** Behavior 05 landing e2e: S15/S21 review verdict delivery and the merge window. Fixtures: landing-helpers.ts. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { isoTimestamp, paths } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { COMMAND_POST_EXTENSION, startPiChild, git, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, run, startStack, mergedCalls } from "./landing-helpers.ts";

test("landing S15 retry: real parent delivery confirms, retries withheld verdicts and expires permanent suppression", { skip: SKIP, timeout: 100_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_VERDICT_DELIVERY_RETRY_SECONDS: "1", CP_REVIEW_SUPPRESSION_SECONDS: "32" } });
	const jobs: Awaited<ReturnType<typeof s.held>>[] = [];
	for (let n = 0; n < 4; n++) {
		const live = await s.held(`S15 retry ${n}`, 161 + n, { command: (branch) => `printf retry > retry-${n}.txt && git add retry-${n}.txt && git commit -q -m retry && git push -q -u origin ${branch}` });
		new IntegrationHolds(s.home).hold(live.jobId, "retry evidence collection");
		jobs.push(live);
	}
	const originals = jobs.map((live) => readFileSync(join(s.home, paths.envelopeFile(live.jobId)), "utf8"));
	const models = jobs.map((live, n) => s.provider.addScript(`s15-retry-${n}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: () => {
		if (n === 1 || n === 2) {
			const record = JSON.parse(originals[n]!);
			record.envelope.head_sha = "f".repeat(40);
			record.received_at = isoTimestamp(new Date(Date.now() + 3_600_000));
			writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify(record));
		}
		return { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 retry evidence"] };
	} }] }]));
	const releaseParent = join(s.home, "release-retry-parent");
	const parent = s.provider.addScript("s15-retry-parent", [
		{ kind: "tool_calls", calls: [
			...jobs.slice(0, 3).map((live, n) => ({ name: "cp_review", args: { job_id: live.jobId, model: models[n] } })),
			{ name: "bash", args: { command: `while [ ! -f '${releaseParent}' ]; do sleep 0.1; done` } },
		] },
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: jobs[3]!.jobId, model: models[3] } }] },
		{ kind: "text", text: "Review deliveries observed." },
	], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model: parent, env: { ...s.agentDir.env, CP_HOME: s.home }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => child.close());
	const prompted = child.prompt("Review these three branches and wait while their verdict delivery settles.");
	const events = (n: number) => readRunEvents(s.home, jobs[n]!.jobId);
	const sends = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_sent");
	const delivered = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_delivered");
	try {
		await waitFor(() => sends(0).length, (count) => count >= 2, { timeoutMs: 30_000, what: "the busy parent leaves its first verdict unconfirmed through one resend" });
	} finally {
		writeFileSync(releaseParent, "release");
	}
	await prompted;
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 2, { timeoutMs: 10_000, what: "real timer retries a withheld verdict" }), "suppression remains eligible for its configured retry window");
	assert.equal((sends(1)[0]!.payload as { sent: boolean }).sent, false);
	assert.equal((sends(1)[1]!.payload as { sent: boolean }).sent, false);
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 3, { timeoutMs: 10_000, what: "a second withheld copy never spends resend eligibility" }), "withheld copies preserve resend eligibility");
	await waitFor(() => delivered(3).length, (count) => count >= 1, { timeoutMs: 10_000, what: "the idle parent's immediate confirmation" });
	assert.equal(delivered(3).length, 1, "one arrival confirms a verdict only once");
	await waitFor(() => Date.now(), (now) => now >= Date.parse(sends(3)[0]!.ts) + 6_000, { timeoutMs: 10_000, what: "confirmed verdict's resend deadline passes" });
	assert.equal(sends(3).length, 1, "confirmation removes the key before its first resend");
	await waitFor(() => sends(1).length, (count) => count >= 6, { timeoutMs: 30_000, what: "lagging facts outlast the old five-copy bound" });
	writeFileSync(join(s.home, paths.envelopeFile(jobs[1]!.jobId)), originals[1]!);
	await waitFor(() => delivered(1).length, (count) => count === 1, { timeoutMs: 10_000, what: "withheld retry remains eligible until facts catch up" });
	assert.equal(sends(0).length, 2, "a queued unconfirmed verdict is resent exactly once");
	assert.equal(delivered(3).length, 1);
	assert.equal(sends(3).length, 1, "an immediately confirmed verdict never resends");
	assert.equal((sends(0)[1]!.payload as { resend: boolean }).resend, true);
	assert.ok(sends(1).length >= 7, "withheld copies outlast the old five-copy bound without consuming the successful resend");
	const cutoff = Date.parse(sends(2)[0]!.ts) + 32_000;
	// The product drops the key on its own clock, which may trail the first send's log stamp; wait on that drop.
	const expiry = await waitFor(() => events(2).find((event) => event.type === "verdict_wakeup_expired"), Boolean, { timeoutMs: 40_000, what: "configured suppression lifetime expires" });
	const expiredAt = events(2).findIndex((event) => event.type === "verdict_wakeup_expired");
	assert.ok(events(2).every((event, at) => event.type !== "verdict_wakeup_sent" || at < expiredAt), "permanent suppression stops at its lifetime bound");
	assert.ok(Date.parse(expiry!.ts) >= cutoff, "suppression is never dropped before its configured lifetime");
	assert.ok(Date.parse(expiry!.ts) < cutoff + 6_000, "suppression is dropped on the first tick past its configured lifetime");
	assert.ok(Date.parse(sends(2).at(-1)!.ts) >= cutoff - 6_000, "suppressed attempts remain eligible until near the configured cutoff");
	assert.ok(sends(2).length >= 7, "suppressed retries outlast the old five-copy bound");
	const counts = jobs.map((_, n) => sends(n).length);
	writeFileSync(join(s.home, paths.envelopeFile(jobs[2]!.jobId)), originals[2]!);
	const restoredAt = Date.now();
	await waitFor(() => Date.now(), (now) => now >= restoredAt + 6_000, { timeoutMs: 10_000, what: "expired verdict remains dropped after its facts recover" });
	assert.deepEqual(jobs.map((_, n) => sends(n).length), counts, "confirmed and expired verdicts never resend again");
	assert.equal(delivered(2).length, 0);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("S21b: verdict delivery precedes the merge-window notice", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "30" } });
	const live = await s.held("S21b verdict ordering", 154);
	await s.post.shutdown();
	const order: string[] = [];
	const post = new CommandPost({ home: s.home, packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true, continuation: true,
		sendWakeup: () => { order.push("verdict"); return true; },
		onDurableWakeup: () => {
			if (post.durableWakeups.pending().some((entry) => entry.content.includes("HELD PR WAITING"))) order.push("window");
		},
	});
	t.after(() => post.shutdown());
	const model = s.provider.addScript("s21b-order", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["ordered verdict"],
	} }] }]);
	s.agentDir.writeModels(s.provider);
	const started = await post.diffReview({ jobId: live.jobId, model });
	assert.ok(isDiffReviewWait(started));
	post.reviewRuns.handBack(started.key);
	await post.reviewRuns.settled(started.key);
	assert.deepEqual(order, ["verdict", "window"], "verdict delivery precedes the window notice");
});

test("landing S15 order: a real verdict wakes the parent before its deadline continuation merges", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "5" } });
	const live = await s.held("S15 verdict ordering", 153);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(153, live.head, "completed", "success")] });
	const reviewer = s.provider.addScript("s15-order-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 scoped pass"] } }] }]);
	s.agentDir.writeModels(s.provider);
	await s.parent("Review the S15 ordering branch.", [
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: live.jobId, model: reviewer } }] },
		{ kind: "text", text: "Review started." },
	], async () => {
		await waitFor(() => readRunEvents(s.home, live.jobId).some((event) => event.type === "verdict_wakeup_delivered"), Boolean, { timeoutMs: 30_000, what: "real verdict reaches parent context" });
		const file = join(s.home, paths.reviewFile(live.jobId, 1));
		const original = readFileSync(file, "utf8");
		const verdict = JSON.parse(original);
		assert.ok(Date.parse(readRunEvents(s.home, live.jobId).find((event) => event.type === "verdict_wakeup_delivered")!.ts) < Date.parse(verdict.decided_at) + 5_000, "the raw verdict reaches parent context before its deadline continuation");
		assert.equal(existsSync(join(s.home, paths.pendingReviewFile(live.jobId, "review", 1))), false);
		assert.deepEqual(mergedCalls(s.ghCalls()), [], "the verdict arrives while the merge window is open");
		await waitFor(() => mergedCalls(s.ghCalls()).length, (count) => count === 1, { timeoutMs: 45_000, what: "real deadline continuation merges" });
		assert.ok(Date.now() >= Date.parse(verdict.decided_at) + 5_000);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "review_started").length, 1);
		await waitFor(() => JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages)).includes("HELD PR LANDED"), Boolean, { timeoutMs: 30_000, what: "completed deadline integration reaches the parent" });
	});
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
	const context = JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages));
	const verdictAt = context.indexOf("S15 scoped pass");
	assert.ok(verdictAt >= 0, "the parent receives the actual verdict reason");
	assert.ok(context.includes("HELD PR LANDED"), "the parent receives completed deadline integration");
});

test("landing S15: durable review evidence owns the merge window across parent restarts", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "20" } });
	const live = await s.held("S15 durable review window", 151);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(151, live.head, "completed", "success")] });
	assert.equal((await s.integrate(live.jobId)).record.next, "review");
	const file = join(s.home, paths.reviewFile(live.jobId, 1));
	const at = new Date().toISOString();
	writeWindowPass(s.home, live.jobId, live.head, at, { diff_stat: { files: 1, truncated: true } });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "a truncated pass cannot arm a window");
	for (const body of ["{", JSON.stringify({ verdict: "pass" })]) {
		writeFileSync(file, body);
		assert.equal((await s.integrate(live.jobId)).record.next, "review", "malformed evidence cannot arm a window");
	}
	const other = "b".repeat(40);
	writeWindowPass(s.home, live.jobId, other, at);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "another head's pass cannot arm this window");
	const fresh = isoTimestamp();
	writeWindowPass(s.home, live.jobId, live.head, fresh);
	const original = readFileSync(file, "utf8");
	const deadline = new Date(Date.parse(fresh) + 20_000).toISOString();
	for (let replay = 0; replay < 2; replay++) {
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "wait", result.text);
		assert.equal(result.record.review_resume_at, deadline);
	}
	const ends = await s.parent("Check the durable S15 review deadline after restart.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId, action: "advance" } }] },
		{ kind: "text", text: "Deadline checked." },
	]);
	assert.ok(JSON.stringify(ends).includes(deadline), "the fresh parent reads the original durable deadline");
	assert.equal(readFileSync(file, "utf8"), original);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	writeWindowPass(s.home, live.jobId, live.head, fresh, { equivalent_to: { head_sha: other, attempt: 1 } });
	rmSync(file);
	const equivalentWait = await s.integrate(live.jobId);
	assert.equal(equivalentWait.record.next, "wait", equivalentWait.text);
	assert.equal(equivalentWait.record.review_resume_at, deadline);
	const expired = new Date(Date.now() - 21_000).toISOString();
	writeWindowPass(s.home, live.jobId, live.head, expired, { equivalent_to: { head_sha: other, attempt: 1 } });
	const ready = await s.integrate(live.jobId);
	assert.equal(ready.record.next, "advance", ready.text);
	assert.equal(ready.record.review_resume_at, undefined, "elapsed equivalent passes do not renew the window");
	const mismatched = await s.held("S15 mismatched equivalence", 152, { command: (branch) => `printf mismatch > mismatch.txt && git add mismatch.txt && git commit -q -m mismatch && git push -q -u origin ${branch}` });
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(152, mismatched.head, "completed", "success")] });
	const wrong = writeWindowPass(s.home, mismatched.jobId, other, new Date().toISOString(), { equivalent_to: { head_sha: mismatched.head, attempt: 1 } });
	writeFileSync(join(s.home, paths.reviewEquivalenceFile(mismatched.jobId, mismatched.head)), JSON.stringify(wrong));
	assert.equal((await s.integrate(mismatched.jobId)).record.review_resume_at, undefined, "mismatched equivalence cannot arm a window");
});

test("landing: the review deadline resumes once and rechecks current gates", { skip: SKIP, timeout: 119_000 }, async (t) => {
	for (const fallback of [false, true]) {
		for (const change of ["hold", "unreadable-hold", "head", "ci", "permission", "none"]) await t.test(`${fallback ? "fallback" : "repository"}/${change}`, async (t) => {
			const s = await startStack(t, { continuation: true, env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "3" } });
			const live = await s.held("review deadline gates", 124);
			await s.post.continuation.serialize(live.jobId, async () => {});
			const reviewedAt = new Date().toISOString();
			writeWindowPass(s.home, live.jobId, live.head, reviewedAt);
			if (fallback) {
				const store = new CheckpointStore(s.home, { kind: "merge" });
				const scope = live.head.slice(0, 12);
				store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
				store.decide(live.jobId, true, { by: "operator command", scope });
			}
			s.setGh({ integration: true, permission: fallback ? null : "CLEAN", runs: [run(124, live.head, "completed", "success")] });
			await s.tick(live.jobId);
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(s.post.integrator.get(live.jobId)?.next, "wait");
			assert.deepEqual(mergedCalls(s.ghCalls()), []);
			const holds = new IntegrationHolds(s.home);
			if (change === "hold" || change === "unreadable-hold") {
				holds.hold(live.jobId, "hold during review window");
				if (change === "unreadable-hold") writeFileSync(holds.file(live.jobId), "{");
			}
			if (change === "head") {
				git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "push during review window");
				git(live.worktree, "push", "--quiet", "origin", live.jobId);
			}
			if (change === "ci") s.setGh({ runs: [run(124, live.head, "in_progress", null)] });
			if (change === "permission") s.setGh({ permission: "BLOCKED" });
			await waitFor(() => Date.now(), (now) => now >= Date.parse(reviewedAt) + 4_000, { timeoutMs: 10_000, what: "configured review deadline elapses" });
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(mergedCalls(s.ghCalls()).length, change === "none" ? 1 : 0, `${fallback}/${change}`);
			if (change === "hold" || change === "unreadable-hold") {
				holds.release(live.jobId);
				const result = await s.integrate(live.jobId);
				assert.equal(result.record.next, "advance", result.text);
				assert.equal(result.record.record.merge_authority?.kind, fallback ? "human_checkpoint" : "repo_derived");
			}
		});
	}
});


