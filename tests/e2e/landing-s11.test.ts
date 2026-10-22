import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { readRunEvents, waitFor } from "../harness/index.ts";
import { json, landOnOrigin, mergeAndDeleteHead, run, SKIP, startStack } from "./landing-helpers.ts";

for (const mode of ["blocked", "conflict", "unreadable"] as const) {
	test(`S11: ${mode} delivery report stops integration before review, conflict repair or merge`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S11 blocked report", 211);
		s.setGh({ integration: true, runs: [run(211, live.head, "completed", "success")] });
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const file = join(s.home, paths.envelopeFile(live.jobId));
		const saved = readFileSync(file, "utf8");
		const blocked = JSON.parse(saved);
		Object.assign(blocked.envelope, { status: "blocked", blockers: ["S11 missing acceptance evidence"] });
		writeFileSync(file, mode === "unreadable" ? "{" : JSON.stringify(blocked));
		s.setGh({ routes: mode === "conflict" ? [{ match: "pr view", replies: [{ stdout: JSON.stringify({ number: 211, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", isDraft: false }) }] }] : [] });
		const before = s.ghCalls().length;
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.equal(result.next, "surface", mode);
		assert.match(result.reason, mode === "unreadable" ? /unreadable/ : /blocked/, mode);
		assert.match(result.reason, /cp_send/);
		if (mode !== "unreadable") assert.ok(result.facts.includes("blocker: S11 missing acceptance evidence"));
		assert.ok(readRunEvents(s.home, live.jobId).some((event) => event.type === "integration_surfaced"));
		assert.equal(new CheckpointStore(s.home, { kind: "merge" }).get(live.jobId, { scope: live.head.slice(0, 12) }), undefined);
		assert.ok(!s.ghCalls().slice(before).some((call) => /^(pr merge|pr ready|pr update-branch)/.test(call)), `${mode}: no forge mutation`);
		assert.equal(s.post.fleet.require(live.jobId).phase, "held", `${mode}: no conflict promotion`);
		s.setGh({ routes: [] });
		if (mode === "unreadable") rmSync(file);
		else writeFileSync(file, saved);
		assert.equal((await s.post.integrate({ jobId: live.jobId })).step, "merge", "restoring or removing the legacy report permits merge");
	});
}

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

for (const state of ["pending", "declined", "mandate", "truncated", "other-pr", "moved-head", "approved", "approved-red", "approved-push", "approved-report", "approved-pr", "approved-draft", "approved-ask-report", "approved-ask-pr"] as const) {
	test(`S11: final-fix integration ${state}`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const fixGate = join(s.home, "final-fix-release");
		const live = await s.held("S11 final fix", 213, { repair: true, ...(state.startsWith("approved") ? { repairGate: fixGate } : {}) });
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
		assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve", "an unreported fix cannot merge");
		assert.equal(s.post.fleet.require(live.jobId).supersessions, 1, "the implementer is promoted exactly once");
		writeFileSync(fixGate, "release");
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held" && !!record.reported_at, { timeoutMs: 30_000, what: "final fix worker reports" });
		const head = s.repo.git("ls-remote", "origin", `refs/heads/${live.jobId}`).split("\t")[0]!.trim();
		assert.notEqual(head, live.head, "real worker pushed its fix");
		if (state.startsWith("approved-ask")) {
			const draft = json({ number: 213, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: head, baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", isDraft: true });
			s.setGh({ runs: [run(214, head, "completed", "success")], routes: [{ match: "pr view", replies: [draft, draft, { pass: true }] }, { match: "pr ready", replies: [{}] }] });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "advance");
			s.setGh({ routes: [] });
			const ask = (subject: string) => s.post.awaiting.declareGated({ type: "approval", subject, decision: `Ship ${live.jobId} (PR 213)?`, why: "S11 final fix", blocks: "delivery", job_id: live.jobId });
			assert.equal((await ask("S11 before invalidation")).raised, true, "reported final fix counts as reviewed for merge asks");
			if (state === "approved-ask-report") await s.post.fleet.patch(live.jobId, { supersessions: (s.post.fleet.require(live.jobId).supersessions ?? 0) + 1 });
			else await s.post.fleet.patch(live.jobId, { receipts: [{ kind: "pr", status: "open", title: "other PR", url: "https://github.com/example/demo/pull/999" }] });
			const after = await ask("S11 after invalidation");
			assert.equal(after.raised, false, "later report or PR immediately removes final-fix review evidence");
			assert.match(JSON.stringify(after.gate), /review/);
			return;
		}
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
			if (state === "approved-push") {
				s.setGh({ runs: [run(214, head, "completed", "success")], routes: [{ match: "pr view", replies: [json({ number: 213, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: head, baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", isDraft: false })] }] });
				const returned = await s.post.integrate({ jobId: live.jobId });
				assert.equal(returned.next, "surface", "a voided fix never returns when the old head reappears");
				assert.match(returned.reason, /is void/);
			}
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

for (const mode of ["clean", "behind", "reviews", "unknown-block", "no-ci", "checks", "strict", "strict-stale", "strict-pending", "strict-unreviewed", "unknown", "pending", "superseded", "red", "unstable", "unreadable", "unreviewed", "draft", "empty-base", "trimmed-base", "park-dirty"] as const) {
	test(`S11: human handoff ${mode}`, { skip: SKIP, timeout: 120_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S11 handoff", 215);
		await s.post.registry.setMergePolicy("demo", "human_handoff");
		const strict = mode.startsWith("strict");
		const pending = mode === "pending" || mode === "strict-pending";
		const unreviewed = mode === "unreviewed" || mode === "strict-unreviewed";
		if (strict && mode !== "strict") landOnOrigin(s.repo, "printf 'main advance\\n' > main-advance.txt", "advance base");
		if (!unreviewed) writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const pr = { number: 215, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: mode === "empty-base" ? "  " : mode === "trimmed-base" ? " main " : "main", mergeable: "MERGEABLE", mergeStateStatus: mode === "behind" ? "BEHIND" : ["reviews", "unknown-block", "checks"].includes(mode) || strict ? "BLOCKED" : mode === "unknown" ? "UNKNOWN" : mode === "unstable" ? "UNSTABLE" : "CLEAN", reviewDecision: mode === "reviews" ? "REVIEW_REQUIRED" : "", isDraft: mode === "draft" };
		const rules = [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: strict, required_status_checks: [{ context: "ci" }] } }];
		if (mode === "park-dirty") writeFileSync(join(live.worktree, "change.txt"), "uncommitted\n");
		s.setGh({ integration: true, runs: mode === "no-ci" ? [] : [run(215, mode === "superseded" ? "b".repeat(40) : live.head, pending ? "in_progress" : "completed", mode === "red" ? "failure" : "success")], routes: [
			{ match: "pr view", replies: mode === "unreadable" ? [{ code: 1, stderr: "HTTP 403" }] : [json(pr)] },
			{ match: "pr ready", replies: [{}] },
			...(mode === "checks" || strict ? [{ match: "/rules/branches/", replies: [json(rules)] }] : []),
			...(mode === "no-ci" ? [{ match: "actions/workflows", replies: [json({ total_count: 0, workflows: [] })] }] : []),
		] });
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.ok(!s.ghCalls().some((call) => /^(pr merge|pr update-branch)/.test(call)), "human handoff never merges or updates the branch");
		const parked = s.post.fleet.require(live.jobId);
		if (["clean", "behind", "reviews", "unknown-block", "no-ci", "trimmed-base", "strict-stale"].includes(mode)) {
			assert.equal(result.next, "wait", JSON.stringify(result));
			assert.equal(parked.phase, "awaiting_merge");
			assert.equal(parked.awaiting_merge?.base, "main");
			const before = s.ghCalls().length;
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "wait");
			assert.equal(s.ghCalls().length, before, "parked calls touch no forge");
		} else {
			assert.notEqual(parked.phase, "awaiting_merge", `${mode}: never parked`);
			if (unreviewed) assert.equal(result.next, "review");
			if (pending) assert.deepEqual([result.step, result.next], ["ci", "wait"]);
			if (mode === "empty-base") assert.match(result.reason, /Not parked.*no base branch/);
			if (mode === "park-dirty") {
				assert.match(result.reason, /Not parked/);
				assert.equal(s.post.awaiting.list().filter((row) => row.subject?.includes(live.prUrl)).length, 1, "failed parking keeps the human-review row");
			}
		}
	});
}

test("S11: a human merge finishes a blocked delivery without merging it again", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 human merged blocked", 216);
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	s.setGh({ integration: true, runs: [run(216, live.head, "completed", "success")] });
	writeFileSync(join(live.worktree, "change.txt"), "dirty\n");
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
	assert.equal(s.post.awaiting.list().filter((row) => row.subject?.includes(live.prUrl)).length, 1);
	s.repo.git("-C", live.worktree, "checkout", "--", "change.txt");
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
	assert.equal((await s.post.awaitingSnapshot()).filter((row) => row.job_id === live.jobId).length, 0, "the handoff row goes obsolete after the human merge");
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
		const checkpoint = new CheckpointStore(s.home, { kind }).request({ jobId: live.jobId, scope, question: `S11 ${kind} ${scope ?? ""}` });
		rmSync(join(s.home, paths.checkpointFile(live.jobId, kind, scope)));
		const suffix = kind === "ship" ? "" : kind === "diff" ? ".diff" : `.merge-${scope}`;
		writeFileSync(join(s.home, `.pi-command-post/state/checkpoints/${live.jobId}${suffix}.json`), JSON.stringify(checkpoint));
	}
	const rows = await s.post.awaitingSnapshot();
	const ids = rows.filter((row) => row.id.startsWith(`aw-checkpoint-${live.jobId}`)).map((row) => row.id);
	assert.equal(new Set(ids).size, 4, JSON.stringify(rows));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.diff`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.merge-${live.head.slice(0, 12)}`));
	assert.ok(ids.includes(`aw-checkpoint-${live.jobId}.merge-${other.slice(0, 12)}`));
	const quote = "Decline every S11 checkpoint.";
	const events = await s.parent(quote, [
		...ids.map((target) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_decide", args: { target, decision: "decline", basis: { operator_quote: quote } } }] })),
		{ kind: "text", text: "All four checkpoints declined." },
	]);
	assert.equal(events.filter((event) => event.toolName === "cp_decide").length, 4);
	assert.ok(events.every((event) => !event.isError), "each derived decision id is answerable through cp_decide");
	for (const [kind, scope] of [["ship", undefined], ["diff", undefined], ["merge", live.head.slice(0, 12)], ["merge", other.slice(0, 12)]] as const) {
		assert.equal(new CheckpointStore(s.home, { kind }).get(live.jobId, { scope })?.decision, "declined");
	}
});

test("S11: conflict promotion delivers the generated merge instructions to the original worker", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 conflict instructions", 218);
	s.setGh({ routes: [{ match: "pr view", replies: [json({ number: 218, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", isDraft: false })] }] });
	const before = s.provider.requests(`landing-${live.jobId}`).length;
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve");
	await waitFor(() => s.provider.requests(`landing-${live.jobId}`).length, (count) => count > before, { timeoutMs: 10_000, what: "conflict promotion reaches worker" });
	const messages = JSON.stringify(s.provider.requests(`landing-${live.jobId}`).at(-1)?.body.messages);
	assert.match(messages, /git fetch origin && git merge origin\/main/);
	assert.match(messages, /second PR, never a new branch/);
});

test("S11: CI green on a legacy blocked report emits a stopped notice without starting review", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t, { continuation: true });
	const live = await s.seed("S11 blocked continuation", { branch: "main" });
	const head = s.repo.git("rev-parse", "HEAD");
	mkdirSync(join(s.home, paths.runDir(live.jobId)), { recursive: true });
	writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live.jobId, received_at: isoTimestamp(), attempt: 1, envelope: { job_id: live.jobId, kind: "ship", status: "blocked", summary: "Evidence missing", branch: "main", pr_url: live.prUrl, head_sha: head, blockers: ["S11 continuation blocker"] } }));
	s.setGh({ prs: { main: { number: Number(live.prUrl!.split("/").pop()), url: live.prUrl! } }, runs: [run(219, head, "completed", "success")] });
	await s.tick(live.jobId);
	const journal = join(s.home, LAYOUT.state, "wakeups.json");
	await waitFor(() => readFileSync(journal, "utf8"), (body) => body.includes("HELD PR STOPPED"), { timeoutMs: 10_000, what: "blocked continuation notice" });
	const body = readFileSync(journal, "utf8");
	assert.ok(body.includes("S11 continuation blocker"));
	assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")));
	assert.ok(!s.provider.requests().some((request) => JSON.stringify(request.body.messages).includes("Review the diff")), "blocked continuation starts no reviewer");
});

test("S11: a changed head needs review before updating the same legacy handoff row", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("S11 handoff revisions", 220, { repair: true });
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	s.setGh({ integration: true, runs: [run(220, live.head, "completed", "success")] });
	writeFileSync(join(live.worktree, "change.txt"), "dirty\n");
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
	const first = s.post.awaiting.list().find((row) => row.subject?.includes(live.prUrl));
	assert.ok(first);
	s.repo.git("-C", live.worktree, "checkout", "--", "change.txt");
	assert.equal((await s.post.sender.send({ jobId: live.jobId, message: "Implement the requested revision and report." })).receipt, "delivered");
	await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held" && !!record.reported_at, { timeoutMs: 30_000, what: "handoff revision reported" });
	const head = s.repo.git("ls-remote", "origin", `refs/heads/${live.jobId}`).split("\t")[0]!.trim();
	assert.notEqual(head, live.head);
	s.setGh({ runs: [run(221, head, "completed", "success")] });
	assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "review");
	assert.match(s.post.awaiting.list().find((row) => row.id === first.id)!.decision, new RegExp(live.head.slice(0, 12)));
	writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z", { attempt: 2 });
	writeFileSync(join(live.worktree, "change.txt"), "dirty again\n");
	await s.post.integrate({ jobId: live.jobId });
	const rows = s.post.awaiting.list().filter((row) => row.subject?.includes(live.prUrl));
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, first.id);
	assert.match(rows[0]!.decision, new RegExp(head.slice(0, 12)));
	assert.ok(!s.ghCalls().some((call) => /^(pr merge|pr update-branch)/.test(call)));
});
