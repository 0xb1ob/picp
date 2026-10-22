import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { paths } from "../../src/contracts.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { waitFor } from "../harness/index.ts";
import { json, mergeAndDeleteHead, run, SKIP, startStack } from "./landing-helpers.ts";

test("S11: blocked and unreadable delivery reports stop integration before review, conflict repair or merge", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 blocked report", 211);
	s.setGh({ integration: true, runs: [run(211, live.head, "completed", "success")] });
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	const file = join(s.home, paths.envelopeFile(live.jobId));
	const saved = readFileSync(file, "utf8");
	const blocked = JSON.parse(saved);
	Object.assign(blocked.envelope, { status: "blocked", blockers: ["S11 missing acceptance evidence"] });
	for (const mode of ["blocked", "conflict", "unreadable"] as const) {
		writeFileSync(file, mode === "unreadable" ? "{" : JSON.stringify(blocked));
		s.setGh({ routes: mode === "conflict" ? [{ match: "pr view", replies: [{ stdout: JSON.stringify({ number: 211, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", isDraft: false }) }] }] : [] });
		const before = s.ghCalls().length;
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.equal(result.next, "surface", mode);
		assert.match(result.reason, mode === "unreadable" ? /unreadable/ : /blocked/, mode);
		assert.ok(!s.ghCalls().slice(before).some((call) => /^(pr merge|pr ready|pr update-branch)/.test(call)), `${mode}: no forge mutation`);
		assert.equal(s.post.fleet.require(live.jobId).phase, "held", `${mode}: no conflict promotion`);
	}
	writeFileSync(file, saved);
	assert.equal((await s.post.integrate({ jobId: live.jobId })).step, "merge", "restoring the report permits merge");
});

for (const permission of ["CLEAN", null]) {
	test(`S11: a report blocked during CI stops the ${permission ?? "fallback"} merge`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S11 report race", 212);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		if (permission === null) {
			const decisions = new CheckpointStore(s.home, { kind: "merge" });
			decisions.request({ jobId: live.jobId, scope: live.head.slice(0, 12), question: "Approve this head" });
			decisions.decide(live.jobId, true, { by: "operator-quote", scope: live.head.slice(0, 12), basis: { operator_quote: "Approve this exact head." } });
		}
		const gate = join(s.home, "ci-release");
		const file = join(s.home, paths.envelopeFile(live.jobId));
		const saved = readFileSync(file, "utf8");
		s.setGh({ integration: true, permission, routes: [{ match: "actions/runs?head_sha=", replies: [{ ...json({ total_count: 1, workflow_runs: [run(212, live.head, "completed", "success")] }), untilFile: gate }] }] });
		const pending = s.post.integrate({ jobId: live.jobId });
		try {
			await waitFor(() => s.ghCalls().some((call) => call.includes("actions/runs?head_sha=")), Boolean, { timeoutMs: 10_000, what: "CI external barrier" });
			const blocked = JSON.parse(saved);
			Object.assign(blocked.envelope, { status: "blocked", blockers: ["S11 CI race blocker"] });
			writeFileSync(file, JSON.stringify(blocked));
		} finally {
			writeFileSync(gate, "release");
		}
		const result = await pending;
		assert.equal(result.next, "surface");
		assert.match(result.reason, /blocked/);
		assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "no merge after blocked report arrives during CI");
	});
}

for (const state of ["pending", "declined", "mandate", "truncated", "other-pr", "moved-head", "approved", "approved-red", "approved-push", "approved-report", "approved-pr", "approved-draft"] as const) {
	test(`S11: final-fix integration ${state}`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S11 final fix", 213, { repair: true });
		for (let attempt = 1; attempt <= 5; attempt++) writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z", {
			attempt, verdict: "escalate", cause: "policy", model: "mock/reviewer", diff_stat: { files: 1, truncated: state === "truncated" }, reasons: ["S11 final finding"],
		});
		const decisions = new CheckpointStore(s.home, { kind: "final_fix" });
		const scope = live.head.slice(0, 12);
		decisions.request({ jobId: live.jobId, scope, prUrl: state === "other-pr" ? "https://github.com/example/demo/pull/999" : live.prUrl, question: "One final fix", evidence: ["S11 final finding"] });
		if (state !== "pending") decisions.decide(live.jobId, state !== "declined", { by: state === "mandate" ? "mandate:md-abcd" : "operator-quote", scope, basis: { operator_quote: "Approve one final fix." } });
		s.setGh({ integration: true, runs: [run(213, live.head, "completed", "success")], routes: state === "moved-head" ? [{ match: "pr view", replies: [json({ number: 213, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: "b".repeat(40), baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", isDraft: false })] }] : [] });
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "no merge before a final fix report");
		if (!state.startsWith("approved")) {
			assert.notEqual(result.next, "resolve", state);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held", "no repair spawned");
			return;
		}
		assert.equal(result.next, "resolve");
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held" && !!record.reported_at, { timeoutMs: 30_000, what: "final fix worker reports" });
		const head = s.repo.git("ls-remote", "origin", `refs/heads/${live.jobId}`).split("\t")[0]!.trim();
		assert.notEqual(head, live.head, "real worker pushed its fix");
		if (state === "approved-push") {
			s.repo.git("-C", live.worktree, "commit", "--allow-empty", "-m", "later push");
			s.repo.git("-C", live.worktree, "push", "origin", live.jobId);
		}
		const observedHead = s.repo.git("ls-remote", "origin", `refs/heads/${live.jobId}`).split("\t")[0]!.trim();
		if (state === "approved-report") await s.post.fleet.patch(live.jobId, { supersessions: (s.post.fleet.require(live.jobId).supersessions ?? 0) + 1 });
		if (state === "approved-pr") await s.post.fleet.patch(live.jobId, { receipts: [{ kind: "pr", status: "open", title: "other PR", url: "https://github.com/example/demo/pull/999" }] });
		const draft = json({ number: 213, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: head, baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", isDraft: true });
		s.setGh({ runs: [run(214, observedHead, "completed", state === "approved-red" ? "failure" : "success")], routes: state === "approved-draft" ? [{ match: "pr view", replies: [draft, draft, { pass: true }] }, { match: "pr ready", replies: [{}] }] : [] });
		const merged = await s.post.integrate({ jobId: live.jobId });
		if (["approved-red", "approved-push", "approved-report", "approved-pr"].includes(state)) {
			assert.notEqual(merged.step, "merge", JSON.stringify(merged));
			assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "invalid or red fix cannot merge");
			return;
		}
		if (state === "approved-draft") {
			assert.equal(merged.next, "advance", JSON.stringify(merged));
			assert.ok(s.ghCalls().some((call) => call.startsWith("pr ready")), "approved draft is readied");
			assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "draft is reread before merge");
			s.setGh({ routes: [] });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).step, "merge");
			return;
		}
		assert.equal(merged.step, "merge", JSON.stringify(merged));
		assert.ok(s.ghCalls().some((call) => call.startsWith("pr merge") && call.includes(head)), "merge bound to reported fix head");
	});
}

for (const mode of ["clean", "behind", "reviews", "unknown", "pending", "superseded", "red", "unstable", "unreadable", "unreviewed", "draft", "empty-base"] as const) {
	test(`S11: human handoff ${mode}`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S11 handoff", 215);
		await s.post.registry.setMergePolicy("demo", "human_handoff");
		if (mode !== "unreviewed") writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const pr = { number: 215, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: mode === "empty-base" ? "  " : "main", mergeable: "MERGEABLE", mergeStateStatus: mode === "behind" ? "BEHIND" : mode === "reviews" ? "BLOCKED" : mode === "unknown" ? "UNKNOWN" : mode === "unstable" ? "UNSTABLE" : "CLEAN", reviewDecision: mode === "reviews" ? "REVIEW_REQUIRED" : "", isDraft: mode === "draft" };
		s.setGh({ integration: true, runs: [run(215, mode === "superseded" ? "b".repeat(40) : live.head, mode === "pending" ? "in_progress" : "completed", mode === "red" ? "failure" : "success")], routes: [{ match: "pr view", replies: mode === "unreadable" ? [{ code: 1, stderr: "HTTP 403" }] : [json(pr)] }, { match: "pr ready", replies: [{}] }] });
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.ok(!s.ghCalls().some((call) => /^(pr merge|pr update-branch)/.test(call)), "human handoff never merges or updates the branch");
		const parked = s.post.fleet.require(live.jobId);
		if (["clean", "behind", "reviews"].includes(mode)) {
			assert.equal(result.next, "wait", JSON.stringify(result));
			assert.equal(parked.phase, "awaiting_merge");
			assert.equal(parked.awaiting_merge?.base, "main");
			const before = s.ghCalls().length;
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "wait");
			assert.equal(s.ghCalls().length, before, "parked calls touch no forge");
		} else {
			assert.notEqual(parked.phase, "awaiting_merge", `${mode}: never parked`);
			if (mode === "unreviewed") assert.equal(result.next, "review");
			if (mode === "empty-base") assert.match(result.reason, /Not parked.*no base branch/);
		}
	});
}

test("S11: a human merge finishes a blocked delivery without merging it again", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 human merged blocked", 216);
	const file = join(s.home, paths.envelopeFile(live.jobId));
	const envelope = JSON.parse(readFileSync(file, "utf8"));
	Object.assign(envelope.envelope, { status: "blocked", blockers: ["S11 outstanding evidence"] });
	writeFileSync(file, JSON.stringify(envelope));
	const commit = mergeAndDeleteHead(s.repo, live.jobId);
	s.setGh({ integration: true, merged: { [live.jobId]: { head: live.head, commit } } });
	const result = await s.post.integrate({ jobId: live.jobId });
	assert.equal(result.next, "done", JSON.stringify(result));
	assert.equal(result.merge?.recorded, true);
	assert.equal(s.post.fleet.require(live.jobId).phase, "done");
	assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "human merge is never reissued");
});

test("S11: integration rejects research delivery before forge reads", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const job = await s.seed("S11 wrong kind");
	await s.post.fleet.patch(job.jobId, { kind: "research", delivery: "pipeline" });
	const before = s.ghCalls().length;
	await assert.rejects(() => s.post.integrate({ jobId: job.jobId }), /delivery:pr ship job/);
	assert.equal(s.ghCalls().length, before);
});

test("S11: ship, diff and two merge-head decisions remain independently answerable", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 decisions", 217);
	const other = "b".repeat(40);
	for (const [kind, scope] of [["ship", undefined], ["diff", undefined], ["merge", live.head.slice(0, 12)], ["merge", other.slice(0, 12)]] as const) {
		new CheckpointStore(s.home, { kind }).request({ jobId: live.jobId, scope, question: `S11 ${kind} ${scope ?? ""}` });
	}
	const rows = await s.post.awaitingSnapshot();
	const ids = rows.filter((row) => row.id.startsWith(`aw-checkpoint-${live.jobId}`)).map((row) => row.id);
	assert.equal(new Set(ids).size, 4, JSON.stringify(rows));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.diff`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.merge-${live.head.slice(0, 12)}`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.merge-${other.slice(0, 12)}`));
});
