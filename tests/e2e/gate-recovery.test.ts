import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { EMPTY_USAGE, paths, SCHEMA_VERSION, type GateVerdict } from "../../src/contracts.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { recoveryDigest, recoveryFile } from "../../src/gate-recovery.ts";
import { createScratchHome, createScratchLedger, REPO_ROOT, waitFor } from "../harness/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MockProvider } from "../harness/index.ts";
import { isGateWait } from "../../src/gate.ts";
import { decide } from "../../src/decide.ts";
import { deriveFromEscalations } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { createScratchRepo, enableTreehouse, startPiChild } from "../harness/index.ts";
import { isPidAlive } from "../../src/fleet.ts";

for (const mode of ["corrected", "postclaim", "run-directory", "live-unregistered", "spawn-failure", "postdecision", "orphan", "mismatch", "equivalent"] as const) {
 test(`standing public recovery: ${mode}`, async (t) => {
	const f = await fixture(t);
	await f.post.replacePlanner(f.source, f.target, f.authority);
	writeFileSync(f.post.artifacts.path(f.target), "legacy candidate\n");
	const provider = await MockProvider.start();
	const agent = mkdtempSync(join(tmpdir(), "cp-standing-agent-"));
	const post = new CommandPost({ home: f.scratch.path, packageRoot: REPO_ROOT,
		parentEnv: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
	t.after(async () => { await post.shutdown(); await provider.stop(); rmSync(agent, { recursive: true, force: true }); });
	const run = async (ordinal: number, verdict: "pass" | "revise", attemptId?: string, frozen?: { task_base64: string; artifact_base64: string }, race = false) => {
		const model = provider.addScript(`standing-${ordinal}`, [{ kind: "tool_calls", calls: [{ name: "read", args: () => {
			const scratch = join(f.scratch.path, paths.gateScratchDir(f.target, ordinal));
			if (frozen) {
				assert.deepEqual(readFileSync(join(scratch, "original-task.md")), Buffer.from(frozen.task_base64, "base64"));
				assert.deepEqual(readFileSync(join(scratch, "artifact.md")), Buffer.from(frozen.artifact_base64, "base64"));
			}
			return { path: join(scratch, "original-task.md") };
		} }] }, { kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: f.target, verdict,
			flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["bounded readiness"],
			...(verdict === "revise" ? { revisions: ["correct candidate"] } : {}) } }] }]);
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		if (race) {
			const barrier = join(f.scratch.path, "standing-race");
			const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
			const children = [1, 2].map(() => child([f.scratch.path, f.source, f.target, attemptId!, "", barrier, "standing", model], env));
			await waitFor(() => readdirSync(f.scratch.path).filter((name) => name.startsWith("standing-race.") && name.endsWith(".ready")).length === 2,
				(value) => value, { timeoutMs: 15000, what: "both standing claimants" });
			writeFileSync(`${barrier}.release`, "release");
			const results = await Promise.all(children);
			assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
			assert.equal(readFileSync(join(f.scratch.path, "spawn-observations.jsonl"), "utf8").trim().split("\n").length, 1);
			return;
		}
		const result = await post.gate({ jobId: f.target, model, ...(attemptId ? { recoveryAttemptId: attemptId } : {}) });
		assert.ok(isGateWait(result));
		post.reviewRuns.handBack(result.key);
		await post.reviewRuns.settled(result.key);
		return result;
	};
	await run(3, "revise");
	if (mode !== "corrected" && mode !== "equivalent") await post.fleet.add({ ...post.fleet.get(f.source)!, job_id: f.target, phase: "held",
		reported_at: "2026-10-24T13:00:00Z", branch: f.target, worktree: `/wt/${f.target}` });
	const legacy = readFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim"));
	const a = await f.ledger.create({ title: "standing A", project: "demo", kind: "ship", delivery: "local" });
	const b = await f.ledger.create({ title: "standing B", project: "demo", kind: "ship", delivery: "local" });
	await f.ledger.addDep(a.id, f.target);
	await f.ledger.addDep(a.id, f.source);
	await f.ledger.addDep(b.id, f.target);
	await f.ledger.addDep(b.id, a.id);
	const grant = post.mandates.issue({ projects: ["demo"], objective: "bounded migration recovery", expiry: "2099-01-01T00:00:00Z",
		spend_cap: { usd: 100, tokens: 1000000 }, job_cap: 10, job_ids: [f.target, a.id, b.id] });
	const obsolete = await f.ledger.create({ title: "whole-program readiness superseded for bounded scope", project: "demo", kind: "research", delivery: "pipeline" });
	const unrelated = await f.ledger.create({ title: "unrelated hold", project: "demo", kind: "research", delivery: "pipeline" });
	await f.ledger.addDep(b.id, unrelated.id);
	await f.ledger.addDep(a.id, obsolete.id);
	await f.ledger.addDep(b.id, obsolete.id);
	if (mode === "corrected" || mode === "equivalent") {
		const repo = createScratchRepo({ name: "demo", files: { "README.md": "readiness fixture\n" } });
		await post.registry.register({ name: "demo", clone_url: repo.remote!, delivery: "pr" });
		const clone = post.registry.pathOf("demo");
		execFileSync("git", ["clone", "--quiet", repo.remote!, clone]);
		const pool = enableTreehouse(clone);
		t.after(async () => { await post.shutdown(); pool.cleanup(); repo.cleanup(); });
		const model = provider.addScript("reported-research", [{ kind: "tool_calls", calls: [{ name: "report_result", args: {
			job_id: f.target, kind: "research", status: "done", artifact_path: post.artifacts.file(f.target), summary: "Scoped readiness research delivered.",
			plan_summary: { goal: "Scoped readiness", approach: ["Review bounded evidence"], touched: ["README.md"], acceptance: ["Preserve later work"], risk: "Read only" },
			self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false },
		} }] }]);
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		const dispatched = await post.dispatch({ jobId: f.target, model, taskFile: join(f.scratch.path, paths.runDir(f.target), "revision-task.md") });
		assert.equal(dispatched.state, "dispatched");
		await waitFor(() => post.fleet.get(f.target), (record) => record?.phase === "held", { timeoutMs: 30000, what: "research report accepted" });
		assert.ok(post.fleet.get(f.target)?.reported_at);
	}
	const controls = ["dc-20261024132350-022c499e", "dc-20261024132412-aef10217"];
	const sends = ["ps-20261024132433-da0e3265", "ps-20261024132620-9b6e1bb4"];
	const releases = [a.id, b.id].map((id) => ({ dependent_job_id: id, blocker_id: obsolete.id,
		reason: "Obsolete whole-audit readiness; bounded PASS only, S32–S131 remains outstanding." }));
	const quotes = [`Finish recovery and approved migration; retain unrelated blocker ${unrelated.id}.\nobsolete_whole_audit_readiness_releases=${JSON.stringify(releases)}\n`, "Continue that same scope."];
	const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const texts = quotes.map((quote, i) => `${controls[i]}: ${quote} Existing ${f.target}, A ${a.id} and B ${b.id}; standing authority, unchanged budgets.`);
	texts[1] += ` Reinforces ${sends[0]}.`;
	atomicWriteJson(join(f.scratch.path, ".pi-command-post/state/sessions/cp-parent.sends.json"), { schema_version: 1,
		updated_at: at, entries: sends.map((id, i) => ({ schema_version: 1, id, text: texts[i], queued_at: at,
			state: "settled", attempts: 1, landed_at: at, settled_at: at })) });
	const journal = controls.flatMap((id, i) => [{ type: "request", by: "bridge", id, at, peer: "sanitized", kind: "message",
		text: quotes[i], ask_id: null, deliver: "followUp", session_started_at: at, session_file: "/scratch/operator.jsonl" },
		{ type: "outcome", by: "bridge", id, at, peer: "sanitized", state: "delivered", reason: null }]);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(f.scratch.path, ".pi-command-post/state/operator"), { recursive: true });
	writeFileSync(join(f.scratch.path, ".pi-command-post/state/operator/asks.jsonl"), [
		{ type: "open", id: "ask-a8f38b7f4245", project: "demo", created_at: at,
			question: "Authorize the recovery fix and one fresh migration review, then proceed with S11b stage 2 and S31 if it passes?",
			context: "The migration package is assembled, but the recovery tool permanently blocks a second explicitly authorized recovery. Existing override controls cannot release this standalone planner. Recommended scope: extend recovery so a NEW operator decision can authorize one new attempt after a spent recovery. Bind each attempt to the exact artifact digest and existing jobs, preserve all history, reject replay/stale authority, and retain normal review gates. Prove with a public regression: failed/spent recovery -> new explicit authority -> exactly one further review; repeat without new authority must refuse. Ship through scoped tests, green CI, review/privacy and merge, then verify loaded runtime. This same approval would authorize ONE migration readiness review for S11b stage 2 and S31 using the complete package; later-slice reconciliation stays outstanding. If it passes, dispatch the existing jobs and continue migration under the existing mandate. Do not bypass review, reset claims, or waive retirement proof. This is a tooling scope expansion plus exhausted-loop decision, reserved for you by the Operator note. One approval covers the complete sequence; routine in-scope repair steps will not ask again.",
			options: [{ label: "Fix recovery and continue", consequence: "One scoped readiness review, then existing jobs on pass." },
				{ label: "Keep held", consequence: "Both jobs remain blocked." }], recommendation: "Fix recovery and continue",
			source_escalation: "es-5445be", job_ids: [f.target, a.id, b.id], evidence_paths: [] },
		{ type: "answer", id: "ask-a8f38b7f4245", answer: "Fix recovery and continue", answered_at: at },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	writeFileSync(join(f.scratch.path, ".pi-command-post/state/operator/dashboard.jsonl"), journal.map((line) => JSON.stringify(line)).join("\n") + "\n");
	const addenda = join(f.scratch.path, paths.taskAddendaFile(f.target));
	writeFileSync(addenda, readFileSync(addenda, "utf8") + JSON.stringify({ schema_version: 1, n: 2, added_at: at,
		text: `${controls[0]} / ${sends[0]} grants standing ${mode === "equivalent" ? "authorization" : "authority"} to ${f.target}; ${mode === "equivalent" ? `approved subjects ${b.id}, ${a.id}` : `A ${a.id} and B ${b.id}`}. ${quotes[0]} Unrelated hold ${unrelated.id} stays. S32-S131 outstanding; missing logs stay missing, retain originals, pass only. Retained ${grant.id}.`,
		by: "operator-quote", quote: quotes[0], reason: "bounded standing scope" }) + "\n");
	const selectors = { job_id: f.target, authority_mode: "standing" as const, operator_control_id: controls[0]!,
		operator_send_id: sends[0]!, reinforcement_control_id: controls[1]!, reinforcement_send_id: sends[1]!, dependent_job_ids: [a.id, b.id] };
	const context = texts.map((text, i) => `${text}\n\n[cp-send ${sends[i]} — delivery id, not an instruction]`);
	writeFileSync(f.post.artifacts.file(f.target), "first standing candidate\n");
	assert.throws(() => post.authorizeRecovery(selectors, []), /operator messages|authenticated session/);
	assert.throws(() => post.authorizeRecovery({ ...selectors, dependent_job_ids: [a.id, f.source] }, context), /scope|amendment/);
	const asksPath = join(f.scratch.path, ".pi-command-post/state/operator/asks.jsonl");
	const asksBytes = readFileSync(asksPath);
	writeFileSync(asksPath, asksBytes.toString().replace(JSON.stringify([f.target, a.id, b.id]), JSON.stringify([f.target, f.source, b.id])));
	assert.throws(() => post.authorizeRecovery(selectors, context), /recorded authenticated recovery scope/);
	writeFileSync(asksPath, asksBytes);
	const authority = post.authorizeRecovery(selectors, context);
	assert.deepEqual(post.authorizeRecovery(selectors, context), authority);
	const grantFile = post.mandates.file(grant.id);
	const grantBytes = readFileSync(grantFile);
	for (const changes of [{ status: "revoked" }, { expiry: "2020-01-01T00:00:00Z" }]) {
		atomicWriteJson(grantFile, { ...JSON.parse(grantBytes.toString()), ...changes });
		assert.throws(() => post.prepareRecoveryAttempt({ job_id: f.target, recovery_authority_id: authority.authority_id,
			expected_previous_attempt_id: authority.current_predecessor_id,
			current_artifact_sha256: authority.candidate.artifact_sha256, dependent_job_ids: [a.id, b.id] }), /active grant|permit/);
		writeFileSync(grantFile, grantBytes);
	}
	const prepare = (predecessor: string) => post.prepareRecoveryAttempt({ job_id: f.target,
		recovery_authority_id: authority.authority_id, expected_previous_attempt_id: predecessor,
		current_artifact_sha256: recoveryDigest(readFileSync(post.artifacts.file(f.target))), dependent_job_ids: [a.id, b.id] });
	const first = prepare(authority.current_predecessor_id);
	assert.deepEqual(prepare(authority.current_predecessor_id), first);
	if (mode !== "corrected" && mode !== "equivalent") {
		const model = provider.addScript("standing-fault", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
			job_id: f.target, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["bounded readiness"],
		} }] }]);
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		if (mode === "mismatch") {
			const task = join(f.scratch.path, paths.runDir(f.target), "revision-task.md");
			const original = readFileSync(task);
			writeFileSync(task, "changed governing task");
			await assert.rejects(post.gate({ jobId: f.target, model, recoveryAttemptId: first.attempt_id }), /frozen candidate/);
			writeFileSync(task, original);
		} else {
			const fault = mode === "postclaim" ? "claim.json" : mode === "postdecision" ? "gate-4.json" : mode;
			const result = await child([f.scratch.path, f.source, f.target, first.attempt_id, fault, "", "standing", model],
				{ ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
			assert.equal(result.code, mode === "spawn-failure" ? 0 : 73, result.output);
			if (mode === "run-directory") assert.equal(existsSync(join(f.scratch.path, paths.gateRunDir(f.target, 4))), true);
			if (mode === "live-unregistered") {
				const claimPath = join(f.scratch.path, paths.runDir(f.target), `recovery-attempt-${first.attempt_id}-claim.json`);
				const claimBytes = readFileSync(claimPath);
				const pid = Number(readFileSync(join(f.scratch.path, paths.runDir(f.target), `recovery-attempt-${first.attempt_id}-reviewer-pid.json`), "utf8"));
				t.after(() => { if (isPidAlive(pid)) process.kill(pid, "SIGKILL"); });
				assert.equal(isPidAlive(pid), true);
				assert.throws(() => prepare(first.attempt_id), /terminal nonpass/);
				assert.deepEqual(readFileSync(claimPath), claimBytes);
				process.kill(pid, "SIGKILL");
				await waitFor(() => isPidAlive(pid), (alive) => !alive, { timeoutMs: 15000, what: "owned reviewer exit" });
			}
			if (mode === "orphan" || mode === "postdecision") {
				await post.reviewRuns.sweepOrphans({ gate: (pending, reason) => post.gateModule().orphan(pending, reason) }, [f.target]);
			}
		}
		await assert.rejects(post.gate({ jobId: f.target, model, recoveryAttemptId: first.attempt_id }), /claimed|terminal/);
		if (mode === "postdecision") {
			assert.throws(() => prepare(first.attempt_id), /terminal nonpass/);
			assert.equal((post.gateModule().status(f.target).standing_recovery as { eligibility: string }).eligibility, "completed");
		} else {
			assert.equal(provider.requests().length, 2);
			const successor = prepare(first.attempt_id);
			assert.notEqual(successor.attempt_id, first.attempt_id);
			const claimPath = join(f.scratch.path, paths.runDir(f.target), `recovery-attempt-${first.attempt_id}-claim.json`);
			const spentClaim = readFileSync(claimPath);
			const terminal = JSON.parse(readFileSync(join(f.scratch.path, paths.runDir(f.target), `recovery-attempt-${first.attempt_id}-terminal.json`), "utf8"));
			assert.equal(terminal.outcome, mode === "mismatch" ? "invalidated" : mode === "spawn-failure" ? "spawn_failure" : "interrupted");
			assert.equal(successor.authority_id, first.authority_id);
			await run(5, "pass", successor.attempt_id, successor);
			assert.deepEqual(readFileSync(claimPath), spentClaim);
			assert.equal(post.gateModule().status(f.target).decisions.at(-1)?.attempt, 5);
		}
		assert.deepEqual(readFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), legacy);
		return;
	}
	await run(4, "revise", first.attempt_id, first, true);
	const spentRequests = provider.requests().length;
	await assert.rejects(post.gate({ jobId: f.target, recoveryAttemptId: first.attempt_id }), /already claimed|terminal/);
	assert.equal(provider.requests().length, spentRequests);
	assert.equal((await f.ledger.ready()).some((job) => job.id === a.id || job.id === b.id), false);
	const nonpassStatus = post.gateModule().status(f.target).standing_recovery as { eligibility: string; current_predecessor_id: string; release_scope?: unknown };
	assert.equal(nonpassStatus.release_scope, undefined);
	assert.equal(nonpassStatus.current_predecessor_id, first.attempt_id);
	assert.equal(nonpassStatus.eligibility, "eligible");
	atomicWriteJson(grantFile, { ...JSON.parse(grantBytes.toString()), spend_cap: { usd: 0.000001, tokens: 1 } });
	assert.throws(() => prepare(first.attempt_id), /grant|budget|cap|permit/);
	writeFileSync(grantFile, grantBytes);
	writeFileSync(post.artifacts.file(f.target), "corrected standing candidate\n");
	const second = prepare(first.attempt_id);
	assert.notEqual(second.attempt_id, first.attempt_id);
	assert.equal(second.authority_id, first.authority_id);
	await run(5, "pass", second.attempt_id, second);
	const passStatus = post.gateModule().status(f.target).standing_recovery as { eligibility: string; release_scope: typeof authority.release_scope };
	assert.deepEqual(passStatus.release_scope, authority.release_scope);
	assert.deepEqual(passStatus.release_scope.eligible_readiness_edges.map(({ dependent_job_id, blocker_id }) =>
		({ dependent_job_id, blocker_id })).sort((x, y) => x.dependent_job_id.localeCompare(y.dependent_job_id)),
		[a.id, b.id].sort().map((id) => ({ dependent_job_id: id, blocker_id: obsolete.id })));
	assert.equal(passStatus.eligibility, "completed");
	assert.throws(() => prepare(second.attempt_id), /terminal nonpass/);
	const drift = await f.ledger.create({ title: "graph drift", project: "demo", kind: "research", delivery: "pipeline" });
	await f.ledger.addDep(a.id, drift.id);
	assert.equal((post.gateModule().status(f.target).standing_recovery as { eligibility: string }).eligibility, "ineligible");
	assert.equal((await f.ledger.ready()).some((job) => job.id === a.id || job.id === b.id), false);
	await f.ledger.removeDep(a.id, drift.id);
	await f.ledger.comment(a.id, `Actual scoped PASS ${second.attempt_id}; S32–S131 remains outstanding.`);
	await f.ledger.comment(b.id, `Actual scoped PASS ${second.attempt_id}; preserve A ordering.`);
	const torn = await post.tearDown(f.target);
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	assert.equal(torn.lease_returned, true);
	assert.equal(post.fleet.get(f.target)?.phase, "done");
	assert.equal((await f.ledger.show(f.target)).status, "closed");
	const reason = `Actual scoped PASS ${second.attempt_id} supersedes ${obsolete.id} for these readiness jobs only; S32–S131 remains outstanding.`;
	const controlsModel = provider.addScript("scoped-continuation", [
		...passStatus.release_scope.eligible_readiness_edges.flatMap((edge) => [
			{ kind: "tool_calls" as const, calls: [{ name: "cp_job", args: { action: "comment", job_id: edge.dependent_job_id, text: `${reason} ${edge.reason}` } }] },
			{ kind: "tool_calls" as const, calls: [{ name: "cp_job", args: { action: "dep_remove", job_id: edge.dependent_job_id, blocker_id: edge.blocker_id } }] },
		]), { kind: "text", text: "Scoped continuation recorded." },
	]);
	writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
	const parent = startPiChild({ cwd: f.scratch.path, model: controlsModel,
		env: { ...process.env, PI_CODING_AGENT_DIR: agent, CP_HOME: f.scratch.path, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		extensions: [join(REPO_ROOT, "extensions/command-post/index.ts")] });
	t.after(() => parent.close());
	await parent.prompt(reason);
	await parent.waitForSettled(30000);
	const ends = parent.eventsOfType("tool_execution_end") as Array<{ isError?: boolean }>;
	assert.equal(ends.length, 4);
	assert.equal(ends.some((event) => event.isError), false);
	assert.equal((await f.ledger.show(obsolete.id)).status, "open");
	assert.equal((await f.ledger.show(a.id)).blocked_by.includes(obsolete.id), false);
	assert.equal((await f.ledger.show(b.id)).blocked_by.includes(obsolete.id), false);
	for (const edge of passStatus.release_scope.eligible_readiness_edges) {
		assert.equal((await f.ledger.show(edge.dependent_job_id)).comments.some((comment) => comment.text === `${reason} ${edge.reason}`), true);
	}
	const ready = await f.ledger.ready();
	assert.equal(ready.some((job) => job.id === a.id), true);
	assert.equal(ready.some((job) => job.id === b.id), false);
	assert.equal((await f.ledger.show(a.id)).blocked_by.includes(f.source), true);
	assert.equal((await f.ledger.show(b.id)).blocked_by.includes(unrelated.id), true);
	assert.deepEqual(readFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), legacy);
});
}
async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
	const scratch = createScratchHome();
	const { ledger } = createScratchLedger({ home: scratch.path });
	const post = new CommandPost({ home: scratch.path, packageRoot: REPO_ROOT });
	t.after(async () => { await post.shutdown(); scratch.cleanup(); });
	const source = await ledger.create({ title: "capped source", project: "demo", kind: "research", delivery: "pipeline" });
	const target = await ledger.create({ title: "replacement", project: "demo", kind: "research", delivery: "pipeline" });
	await post.fleet.add({ job_id: source.id, project: "demo", kind: "research", delivery: "pipeline", origin: "terminal", phase: "done",
		worker: { pid: 1, session_id: "s", session_file: "/s.jsonl", profile: "planner", role: "planner", model: "mock/test", started_at: "2026-09-04T18:00:00Z" },
		worktree: `/wt/${source.id}`, branch: source.id, dispatched_at: "2026-09-04T18:00:00Z", usage: EMPTY_USAGE });
	await ledger.close(source.id, "completed");
	const plan = Buffer.alloc(59022, 65);
	writeFileSync(post.artifacts.path(source.id), plan);
	atomicWriteJson(join(scratch.path, paths.gateFile(source.id, 1)), {
		schema_version: SCHEMA_VERSION, job_id: source.id, attempt: 1, verdict: "revise", cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["missing proof"], revisions: ["correct proof"], decided_at: "2026-09-04T18:00:00Z",
	});
	const decision: GateVerdict = {
		schema_version: SCHEMA_VERSION, job_id: source.id, attempt: 2, verdict: "escalate", cause: "policy",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["revision max cap"], decided_at: "2026-09-04T18:01:00Z",
	};
	atomicWriteJson(join(scratch.path, paths.gateFile(source.id, 2)), decision);
	writeFileSync(join(scratch.path, paths.originalTaskFile(source.id)), `full original scope\nWrite report to ${post.artifacts.file(source.id)}.\nEvidence pointer: ${join(scratch.path, "external-evidence.md")}\n`);
	writeFileSync(join(scratch.path, paths.taskAddendaFile(source.id)), JSON.stringify({ schema_version: SCHEMA_VERSION, n: 1,
		added_at: "2026-09-04T18:00:00Z", text: "Preserve the complete migration scope.\n".repeat(1000),
		by: "operator-quote", quote: "Keep the original scope.", reason: "corrected review" }) + "\n");
	atomicWriteJson(join(scratch.path, paths.gateFileRaw(source.id, 2)), { ...decision, reasons: ["full feedback\n".repeat(1000)] });
	const escalation = await post.escalations.raise({ job_ids: [source.id], kind: "loop_exhausted", question: "correct capped plan?",
		options: [{ id: "replan", label: "replan", consequence: "one correction", cost: "one review" }], recommended: "replan",
		evidence_paths: [paths.gateFile(source.id, 2)] });
	await decide({ target: escalation.id, decision: "replan", basis: { operator_quote: "Allow one corrected attempt." } }, {
		items: deriveFromEscalations([escalation]), ship: new CheckpointStore(scratch.path),
		diff: new CheckpointStore(scratch.path, { kind: "diff" }), merge: new CheckpointStore(scratch.path, { kind: "merge" }),
		mandates: post.mandates, lookupJob: () => ({ project: "demo", jobKind: "research" }), usageJobs: () => [],
		operatorTexts: [`${escalation.id}: Allow one corrected attempt.`], answerDeclared: async () => { throw new Error("unexpected declared answer"); },
		getEscalation: (id) => post.escalations.get(id),
		answerEscalation: (id, answer, by, basis, provenance) => post.escalations.answer(id, { answer, by, basis, ...(provenance ? { provenance } : {}) }),
	});
	return { scratch, post, ledger, source: source.id, target: target.id, authority: escalation.id, plan };
}

function child(args: string[], env = process.env): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const process = spawn(globalThis.process.execPath, ["--experimental-strip-types", "tests/fixtures/gate-recovery-child.ts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => process.kill("SIGKILL"), 30000);
		process.once("close", () => clearTimeout(timer));
		let output = "";
		process.stdout.on("data", (data) => output += data);
		process.stderr.on("data", (data) => output += data);
		process.on("error", reject);
		process.on("close", (code) => resolve({ code, output }));
	});
}

test("recovery public preparation preserves full input/history and binds an idempotent replacement", async (t) => {
	const f = await fixture(t);
	const history = [1, 2].map((n) => recoveryDigest(readFileSync(join(f.scratch.path, paths.gateFile(f.source, n)))));
	const result = await f.post.replacePlanner(f.source, f.target, f.authority);
	assert.deepEqual(await f.post.replacePlanner(f.source, f.target, f.authority), result);
	assert.deepEqual(readFileSync(join(f.scratch.path, paths.runDir(f.target), "previous-plan.md")), f.plan);
	for (const file of ["task-addenda.jsonl", "gate-2-raw.json"]) {
		assert.deepEqual(readFileSync(join(f.scratch.path, paths.runDir(f.target), file)),
			readFileSync(join(f.scratch.path, paths.runDir(f.source), file)));
	}
	assert.deepEqual([1, 2].map((n) => recoveryDigest(readFileSync(join(f.scratch.path, paths.gateFile(f.source, n))))), history);
	writeFileSync(f.post.artifacts.path(f.target), "corrected plan\n");
	await assert.rejects(f.post.gate({ jobId: f.target, model: "invalid/too/many" }), /allowlist/);
	assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), false);
	await assert.rejects(f.post.gate({ jobId: f.source }), /recovery reserved/);
	await assert.rejects(f.post.replacePlanner(f.target, f.source, f.authority), /chaining/);
	await assert.rejects(f.post.replacePlanner(f.source, f.target), /recovery binding/);
});

test("source routing paused before concurrent preparation refuses dispatch", async (t) => {
	const f = await fixture(t);
	const barrier = join(f.scratch.path, "source-preflight");
	const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {} }));
	t.after(() => rmSync(agent, { recursive: true, force: true }));
	const pending = child([f.scratch.path, f.source, f.target, f.authority, "", barrier, "source-race"],
		{ ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
	await waitFor(() => existsSync(`${barrier}.ready`), Boolean, { timeoutMs: 15000 });
	await f.post.replacePlanner(f.source, f.target, f.authority);
	writeFileSync(`${barrier}.release`, "release");
	const result = await pending;
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /recovery reserved/);
	assert.equal(existsSync(join(f.scratch.path, "spawn-observations.jsonl")), false);
	assert.equal(existsSync(join(f.scratch.path, paths.gateScratchDir(f.source, 3))), false);
});

for (const value of [null, false, 0, "invalid", {}, { schema_version: 1 }]) {
	test(`source refuses schema-invalid canonical reservation ${JSON.stringify(value)}`, async (t) => {
		const f = await fixture(t);
		writeFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.source)), "reservation"), JSON.stringify(value));
		const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {} }));
		t.after(() => rmSync(agent, { recursive: true, force: true }));
		const result = await child([f.scratch.path, f.source, f.source, f.authority, "", "", "gate", "mock/test"],
			{ ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /invalid recovery reservation/);
		assert.equal(existsSync(join(f.scratch.path, "spawn-observations.jsonl")), false);
		assert.equal(existsSync(join(f.scratch.path, paths.gateScratchDir(f.source, 3))), false);
	});
}
test("independent processes choose one immutable replacement before publishing target inputs", async (t) => {
	const f = await fixture(t);
	const alternate = await f.ledger.create({ title: "alternate", project: "demo", kind: "research", delivery: "pipeline" });
	const barrier = join(f.scratch.path, "preparation-race");
	const pending = [f.target, alternate.id].map((target) => child([f.scratch.path, f.source, target, f.authority, "", barrier]));
	await waitFor(() => readdirSync(f.scratch.path).filter((name) => name.endsWith(".ready")).length, (count) => count === 2, { timeoutMs: 15000 });
	writeFileSync(`${barrier}.release`, "release");
	const results = await Promise.all(pending);
	assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
	const reservation = JSON.parse(readFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.source)), "reservation"), "utf8"));
	assert.ok([f.target, alternate.id].includes(reservation.replacement_job));
	const repeated = await child([f.scratch.path, f.source, reservation.replacement_job, f.authority]);
	assert.equal(repeated.code, 0, repeated.output);
});

test("missing and mismatched recovery authority cannot prepare a replacement", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.post.replacePlanner(f.source, f.target, "es-000000"), /missing recovery authority/);
	const other = await f.ledger.create({ title: "other", project: "demo", kind: "research", delivery: "pipeline" });
	await assert.rejects(f.post.replacePlanner(other.id, f.target, f.authority), /no capped gate decision/);
});

for (const fault of ["before-reservation", "gate-recovery-reservation.json", "gate-recovery-source.json", "previous-plan.md", "gate-recovery-prepared.json"]) {
	test(`preparation resumes after child exits at ${fault}`, async (t) => {
		const f = await fixture(t);
		const stopped = await child([f.scratch.path, f.source, f.target, f.authority, fault]);
		assert.equal(stopped.code, 73, stopped.output);
		if (fault === "gate-recovery-reservation.json") {
			await assert.rejects(f.post.gate({ jobId: f.source }), /recovery reserved/);
			await assert.rejects(f.post.gate({ jobId: f.target }), /preparation incomplete/);
		}
		await f.post.replacePlanner(f.source, f.target, f.authority);
		assert.deepEqual(readFileSync(join(f.scratch.path, paths.runDir(f.target), "previous-plan.md")), f.plan);
		assert.equal(f.post.gateModule().status(f.target).recovery?.remaining, 1);
	});
}

test("same mapping preparations in two processes converge", async (t) => {
	const f = await fixture(t);
	const barrier = join(f.scratch.path, "same-race");
	const pending = [1, 2].map(() => child([f.scratch.path, f.source, f.target, f.authority, "", barrier]));
	await waitFor(() => readdirSync(f.scratch.path).filter((name) => name.endsWith(".ready")).length, (count) => count === 2, { timeoutMs: 15000 });
	writeFileSync(`${barrier}.release`, "release");
	const results = await Promise.all(pending);
	assert.ok(results.every((result) => result.code === 0), JSON.stringify(results));
	assert.equal(results[0]?.output, results[1]?.output);
});

for (const change of ["job", "evidence", "quote", "time", "withdrawn", "answer"] as const) {
	test(`recovery refuses ${change} authority before reservation`, async (t) => {
		const f = await fixture(t);
		const store = f.post.escalations.read();
		const item = store.items.find((entry) => entry.id === f.authority)!;
		if (change === "job") item.job_ids = [f.target];
		if (change === "evidence") item.evidence_paths = [paths.gateFile(f.source, 1)];
		if (change === "quote") item.answered_by = "parent";
		if (change === "time") item.answered_at = "2026-09-01T00:00:00Z";
		if (change === "withdrawn") item.status = "withdrawn";
		if (change === "answer") item.answer = "override";
		atomicWriteJson(f.post.escalations.file, store);
		await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /authority/);
		assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.source)), "reservation")), false);
	});
}

test("changed recorded authority after preparation prevents a claim", async (t) => {
	const f = await fixture(t);
	await f.post.replacePlanner(f.source, f.target, f.authority);
	const store = f.post.escalations.read();
	store.items.find((item) => item.id === f.authority)!.basis = { operator_quote: "different approval" };
	atomicWriteJson(f.post.escalations.file, store);
	await assert.rejects(f.post.gate({ jobId: f.target }), /authority/);
	assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), false);
});

test("unsupported links fail closed and leave no authoritative reservation", async (t) => {
	const f = await fixture(t);
	const result = await child([f.scratch.path, f.source, f.target, f.authority, "unsupported-link"]);
	assert.equal(result.code, 1);
	assert.match(result.output, /EOPNOTSUPP/);
	assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.source)), "reservation")), false);
});

test("a revoked authority grant prevents preparation", async (t) => {
	const f = await fixture(t);
	const grant = f.post.mandates.issue({ projects: ["demo"], objective: "correct capped plan", expiry: "2099-01-01T00:00:00Z",
		spend_cap: { usd: 100, tokens: 1000000 }, job_cap: 3, job_ids: [f.source, f.target] });
	const store = f.post.escalations.read();
	store.items.find((entry) => entry.id === f.authority)!.mandate_id = grant.id;
	atomicWriteJson(f.post.escalations.file, store);
	await f.post.replacePlanner(f.source, f.target, f.authority);
	f.post.mandates.revoke(grant.id, { by: "system" });
	await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /current active grant/);
	await assert.rejects(f.post.gate({ jobId: f.target }), /current active grant/);
	assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), false);
});

test("immutable preparation refuses changed input, history and malformed reservation", async (t) => {
	const f = await fixture(t);
	await f.post.replacePlanner(f.source, f.target, f.authority);
	const previous = join(f.scratch.path, paths.runDir(f.target), "previous-plan.md");
	writeFileSync(previous, "conflicting partial copy");
	await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /immutable recovery file differs/);
	assert.equal(readFileSync(previous, "utf8"), "conflicting partial copy");
	writeFileSync(previous, f.plan);
	const decision = join(f.scratch.path, paths.gateFile(f.source, 2));
	const bytes = readFileSync(decision);
	writeFileSync(decision, bytes.toString().replace("revision max cap", "changed cap"));
	await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /immutable recovery file differs/);
	writeFileSync(decision, bytes);
	writeFileSync(recoveryFile(join(f.scratch.path, paths.runDir(f.source)), "reservation"), "{");
	await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /unreadable recovery record/);
});


test("absent addenda preparation is deterministic and rejects newly added scope", async (t) => {
	const f = await fixture(t);
	const addenda = readFileSync(join(f.scratch.path, paths.taskAddendaFile(f.source)));
	unlinkSync(join(f.scratch.path, paths.taskAddendaFile(f.source)));
	const prepared = await f.post.replacePlanner(f.source, f.target, f.authority);
	const task = readFileSync(prepared.task_file, "utf8");
	assert.ok(task.startsWith("full original scope\n"));
	assert.ok(!task.includes("## Authorized task addenda"));
	assert.deepEqual(await f.post.replacePlanner(f.source, f.target, f.authority), prepared);
	writeFileSync(join(f.scratch.path, paths.taskAddendaFile(f.source)), addenda);
	await assert.rejects(f.post.replacePlanner(f.source, f.target, f.authority), /immutable recovery file differs|addenda mismatch/);
	assert.equal(existsSync(recoveryFile(join(f.scratch.path, paths.runDir(f.target)), "claim")), false);
});
for (const change of ["task", "addenda", "legacy"] as const) {
	test(`preclaim ${change} mismatch preserves the unused claim`, async (t) => {
		const f = await fixture(t);
		const prepared = await f.post.replacePlanner(f.source, f.target, f.authority);
		writeFileSync(f.post.artifacts.path(f.target), "corrected plan\n");
		const target = join(f.scratch.path, paths.runDir(f.target));
		writeFileSync(change === "addenda" ? join(target, "task-addenda.jsonl") : prepared.task_file,
			change === "legacy" ? "Read previous-original-task.md\n" : "tampered\n");
		const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {} }));
		t.after(() => rmSync(agent, { recursive: true, force: true }));
		const result = await child([f.scratch.path, f.source, f.target, f.authority, "", "", "gate", "mock/test"],
			{ ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /prepared recovery input changed|legacy handoff mismatch/);
		assert.equal(existsSync(recoveryFile(target, "claim")), false);
		assert.equal(existsSync(join(f.scratch.path, "spawn-observations.jsonl")), false);
		assert.equal(f.post.gateModule().status(f.target).recovery?.remaining, 1);
	});
}
test("postcapture task mutation cannot change frozen reviewer bytes", async (t) => {
	const f = await fixture(t);
	const prepared = await f.post.replacePlanner(f.source, f.target, f.authority);
	const frozen = readFileSync(prepared.task_file);
	writeFileSync(f.post.artifacts.path(f.target), "corrected plan\n");
	const provider = await MockProvider.start();
	const model = provider.addScript("frozen", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: f.target, verdict: "revise", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["reviewed"], revisions: ["fix proof"],
	} }] }]);
	const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
	writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
	t.after(async () => { rmSync(agent, { recursive: true, force: true }); await provider.stop(); });
	const barrier = join(f.scratch.path, "frozen-barrier");
	const pending = child([f.scratch.path, f.source, f.target, f.authority, "", barrier, "gate", model],
		{ ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
	await waitFor(() => readdirSync(f.scratch.path).some((name) => name.endsWith(".ready")), Boolean, { timeoutMs: 15000 });
	writeFileSync(prepared.task_file, "changed after capture\n");
	writeFileSync(`${barrier}.release`, "release");
	const result = await pending;
	assert.equal(result.code, 0, result.output);
	assert.deepEqual(readFileSync(join(f.scratch.path, paths.gateScratchDir(f.target, 3), "original-task.md")), frozen);
	assert.equal(f.post.gateModule().status(f.target).recovery?.remaining, 0);
});

for (const outcome of ["pass", "revise", "escalate", "operational"] as const) {
	test(outcome === "pass" ? "recovery handoff uses home default reviewer" : `corrected ${outcome} is durably terminal through CommandPost`, async (t) => {
		const f = await fixture(t);
		await f.post.replacePlanner(f.source, f.target, f.authority);
		writeFileSync(f.post.artifacts.path(f.target), "# Corrected plan\n");
		writeFileSync(join(f.scratch.path, paths.originalTaskFile(f.target)), "replacement dispatch task pointer\n");
		writeFileSync(join(f.scratch.path, "external-evidence.md"), "EXTERNAL-ONLY-SECRET-MARKER\n");
		const provider = await MockProvider.start();
		const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
		const model = provider.addScript("recovery", [{ kind: "tool_calls", calls: [{ name: "read", args: {
			path: join(f.scratch.path, paths.gateScratchDir(f.target, 3), "original-task.md"),
		} }] }, ...(outcome === "operational" ? [{ kind: "text" as const, text: "no verdict" }] : [{
			kind: "tool_calls" as const, calls: [{ name: "report_verdict", args: { job_id: f.target, verdict: outcome,
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["corrected review"],
				...(outcome === "revise" ? { revisions: ["still missing proof"] } : {}) } }],
		}])]);
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		if (outcome === "pass") atomicWriteJson(join(f.scratch.path, ".pi-command-post/data/routing.json"), {
			schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "gate-reviewer", role: "gate-reviewer", model }],
		});
		const post = new CommandPost({ home: f.scratch.path, packageRoot: REPO_ROOT,
			parentEnv: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
		t.after(async () => { await post.shutdown(); rmSync(agent, { recursive: true, force: true }); await provider.stop(); });
		const governing = readFileSync(join(f.scratch.path, paths.runDir(f.target), "revision-task.md"), "utf8");
		assert.ok(governing.startsWith("full original scope\n"));
		assert.ok(governing.includes("Preserve the complete migration scope.\n".repeat(1000)));
		assert.ok(governing.includes(`Write the complete corrected plan to ${post.artifacts.file(f.target)}`));
		const started = await post.gate({ jobId: f.target, ...(outcome === "pass" ? {} : { model }) });
		assert.ok(isGateWait(started));
		post.reviewRuns.handBack(started.key);
		await post.reviewRuns.settled(started.key);
		if (outcome !== "pass") assert.equal(readFileSync(join(f.scratch.path, paths.gateScratchDir(f.target, 3), "original-task.md"), "utf8"), governing);
		assert.ok(JSON.stringify(provider.requests()).includes("full original scope"));
		assert.ok(!JSON.stringify(provider.requests()).includes("EXTERNAL-ONLY-SECRET-MARKER"));
		const count = provider.requests().length;
		const replay = await post.gate({ jobId: f.target, model });
		assert.ok(!isGateWait(replay));
		assert.equal(replay.next, outcome === "pass" ? "proceed" : "surface");
		assert.equal(provider.requests().length, count);
		if (outcome !== "pass") {
			assert.deepEqual(readFileSync(join(f.scratch.path, paths.gateScratchDir(f.target, 3), "original-task.md")),
				readFileSync(join(f.scratch.path, paths.runDir(f.target), "revision-task.md")));
			const ship = await f.ledger.create({ title: "ship after correction", project: "demo", kind: "ship", delivery: "local" });
			post.pipeline().store.write({ schema_version: SCHEMA_VERSION, research_id: f.target, ship_id: ship.id,
				project: "demo", delivery: "local", state: "gating", created_at: "2026-09-04T18:00:00Z", updated_at: "2026-09-04T18:00:00Z" });
			assert.equal((await post.advancePipeline(f.target)).next, "surface");
			assert.equal((await post.advancePipeline(f.target)).next, "surface");
			assert.equal(provider.requests().length, count);
		}
		writeFileSync(join(f.scratch.path, paths.runDir(f.target), "revision-task.md"), "legacy pointer after spent claim\n");
		const restarted = new CommandPost({ home: f.scratch.path, packageRoot: REPO_ROOT });
		try {
			assert.deepEqual(await restarted.gate({ jobId: f.target }), replay);
			writeFileSync(post.artifacts.file(f.target), "changed artifact\n");
			await assert.rejects(restarted.gate({ jobId: f.target }), /exhausted; artifact changed/);
		} finally { await restarted.shutdown(); }
	});
}

for (const mode of ["race", "postclaim", "spawn-failure", "postdecision", "orphan"] as const) {
	test(`single recovery claim: ${mode}`, async (t) => {
		const f = await fixture(t);
		await f.post.replacePlanner(f.source, f.target, f.authority);
		writeFileSync(f.post.artifacts.path(f.target), "# corrected\n");
		const provider = await MockProvider.start();
		const model = provider.addScript("claim", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
			job_id: f.target, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["sound"],
		} }] }]);
		const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		t.after(async () => { rmSync(agent, { recursive: true, force: true }); await provider.stop(); });
		const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
		if (mode !== "race") {
			const fault = mode === "postclaim" ? "gate-recovery-claim.json" : mode === "postdecision" ? "gate-3.json" : mode;
			const result = await child([f.scratch.path, f.source, f.target, f.authority, fault, "", "gate", model], env);
			assert.equal(result.code, mode === "spawn-failure" ? 0 : 73, result.output);
			if (mode === "orphan") {
				const report = await f.post.reviewRuns.sweepOrphans({ gate: (pending, reason) => f.post.gateModule().orphan(pending, reason) }, [f.target]);
				assert.equal(report.finished.length, 1);
			}
			if (mode === "postclaim") {
				await assert.rejects(f.post.gate({ jobId: f.target }), /claimed\/interrupted/);
				assert.equal(existsSync(join(f.scratch.path, paths.gateScratchDir(f.target, 3))), false);
			} else assert.equal((await f.post.gate({ jobId: f.target })).next, mode === "postdecision" ? "proceed" : "surface");
			assert.equal(provider.requests().length, mode === "postdecision" ? 1 : 0);
		} else {
			const barrier = join(f.scratch.path, "claim-race");
			const pending = [1, 2].map(() => child([f.scratch.path, f.source, f.target, f.authority, "", barrier, "gate", model], env));
			await waitFor(() => readdirSync(f.scratch.path).filter((name) => name.endsWith(".ready")).length, (count) => count === 2, { timeoutMs: 15000 });
			writeFileSync(`${barrier}.release`, "release");
			const results = await Promise.all(pending);
			assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
			assert.equal(readFileSync(join(f.scratch.path, "spawn-observations.jsonl"), "utf8").trim().split("\n").length, 1);
			assert.equal(provider.requests().length, 1);
			assert.equal((await f.post.gate({ jobId: f.target })).next, "proceed");
		}
		assert.equal(f.post.gateModule().status(f.target).recovery?.remaining, 0);
	});
}
