import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
	writeFileSync(join(scratch.path, paths.originalTaskFile(source.id)), "full original scope\n");
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

for (const outcome of ["pass", "revise", "escalate", "operational"] as const) {
	test(`corrected ${outcome} is durably terminal through CommandPost`, async (t) => {
		const f = await fixture(t);
		await f.post.replacePlanner(f.source, f.target, f.authority);
		writeFileSync(f.post.artifacts.path(f.target), "# Corrected plan\n");
		writeFileSync(join(f.scratch.path, paths.originalTaskFile(f.target)), "replacement dispatch task pointer\n");
		const provider = await MockProvider.start();
		const agent = mkdtempSync(join(tmpdir(), "cp-recovery-agent-"));
		const model = provider.addScript("recovery", outcome === "operational" ? [{ kind: "text", text: "no verdict" }] : [{
			kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: f.target, verdict: outcome,
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["corrected review"],
				...(outcome === "revise" ? { revisions: ["still missing proof"] } : {}) } }],
		}]);
		writeFileSync(join(agent, "models.json"), JSON.stringify(provider.modelsJson()));
		const post = new CommandPost({ home: f.scratch.path, packageRoot: REPO_ROOT,
			parentEnv: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } });
		t.after(async () => { await post.shutdown(); rmSync(agent, { recursive: true, force: true }); await provider.stop(); });
		const started = await post.gate({ jobId: f.target, model });
		assert.ok(isGateWait(started));
		post.reviewRuns.handBack(started.key);
		await post.reviewRuns.settled(started.key);
		const count = provider.requests().length;
		const replay = await post.gate({ jobId: f.target, model });
		assert.ok(!isGateWait(replay));
		assert.equal(replay.next, outcome === "pass" ? "proceed" : "surface");
		assert.equal(provider.requests().length, count);
		if (outcome !== "pass") {
			assert.deepEqual(readFileSync(join(f.scratch.path, paths.gateScratchDir(f.target, 3), "original-task.md")),
				readFileSync(join(f.scratch.path, paths.originalTaskFile(f.source))));
			const ship = await f.ledger.create({ title: "ship after correction", project: "demo", kind: "ship", delivery: "local" });
			post.pipeline().store.write({ schema_version: SCHEMA_VERSION, research_id: f.target, ship_id: ship.id,
				project: "demo", delivery: "local", state: "gating", created_at: "2026-09-04T18:00:00Z", updated_at: "2026-09-04T18:00:00Z" });
			assert.equal((await post.advancePipeline(f.target)).next, "surface");
			assert.equal((await post.advancePipeline(f.target)).next, "surface");
			assert.equal(provider.requests().length, count);
		}
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
