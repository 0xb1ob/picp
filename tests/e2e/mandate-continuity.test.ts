import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { MandateStore } from "../../src/mandate.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, REPO_ROOT, startPiChild, type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { cpNext } from "../../src/next.ts";
import { isGateWait, readPriorAttempts } from "../../src/gate.ts";

const shellArg = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function parentCommands(home: string, provider: MockProvider, agent: ReturnType<typeof createAgentDir>) {
	let ordinal = 0;
	return async (prompt: string, steps: ScriptStep[]) => {
		const script = `continuity-parent-${++ordinal}`;
		const model = provider.addScript(script, [...steps, { kind: "text", text: "done" }]);
		agent.writeModels(provider);
		const child = startPiChild({ cwd: home, model, env: { ...agent.env, CP_HOME: home }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await child.prompt(prompt);
			await child.waitForSettled(30_000);
			assert.equal(provider.remaining(script), 0);
			return child.eventsOfType("tool_execution_end");
		} finally { await child.close(); }
	};
}
test("typed obsolete coverage requires authenticated full-scope confirmation and preserves the original accounting root", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(async () => { await post.shutdown(); await provider.stop(); agent.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: "https://github.com/example/demo.git", delivery: "local" });
	const original = await post.ledger().create({ title: "Original scope", description: "Keep every original instruction.\n".repeat(100), project: "demo", kind: "research", delivery: "local" });
	const source = post.mandates.issue({ projects: ["demo"], objective: "Finish only original admitted work", job_ids: [original.id], expiry: "2099-01-01T00:00:00Z", provenance: { expiry_hours: "home" }, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	post.mandates.save({ ...source, admissions: undefined, provenance: undefined });
	const replacement = post.mandates.issue({ projects: ["demo"], objective: "Independent new coverage", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 200, tokens: 10_000_000 }, job_cap: 2, ask_on: [] });
	const parent = parentCommands(home.path, provider, agent);
	const args = { action: "continue", source_id: source.id, replacement_id: replacement.id };
	const before = await parent("Inspect the proposed coverage mapping; do not authorize it.", [
		{ kind: "tool_calls", calls: [{ name: "cp_mandate", args }] },
		{ kind: "tool_calls", calls: [{ name: "cp_mandate", args }] },
	]);
	assert.ok(before.every((event) => !event.isError), JSON.stringify(before));
	assert.equal(post.mandates.get(source.id)!.coverage_superseded, undefined);
	assert.equal(post.mandates.get(source.id)!.continuity, undefined);
	const questions = post.escalations.open().filter((item) => item.coverage_scope_digest);
	assert.equal(questions.length, 1);
	const question = questions[0]!;
	assert.equal(question.continuity_default_expiry, true);
	assert.match(question.question, /default admission window rather than an explicit completion deadline/);
	const evidence = JSON.parse(readFileSync(question.evidence_paths[2]!, "utf8"));
	assert.equal(evidence.inputs[0].task, original.description);
	assert.equal(evidence.authority.objective, source.objective);
	const quote = `${question.id}: approve only the unchanged original admission, default expiry fact and obsolete coverage mapping`;
	const after = await parent(quote, [
		{ kind: "tool_calls", calls: [{ name: "cp_decide", args: { target: question.id, decision: "approve", basis: { operator_quote: quote } } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: { ...args, confirmation_escalation_id: question.id } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_mandate", args }] },
	]);
	assert.ok(after.every((event) => !event.isError), JSON.stringify(after));
	assert.match(JSON.stringify(after[1]!.result), /committed/);
	assert.match(JSON.stringify(after[2]!.result), /committed/);
	const saved = post.mandates.get(source.id)!;
	assert.equal(saved.coverage_superseded?.replacement_id, replacement.id);
	assert.equal(saved.continuity?.accounting_root_id, source.id);
	assert.equal(saved.expiry, source.expiry);
	assert.deepEqual(saved.spend_cap, source.spend_cap);
	assert.deepEqual(saved.usage_baseline, source.usage_baseline);
	assert.equal(post.mandates.selection("dispatch", { jobId: original.id, project: "demo", kind: "research" })?.grant.id, source.id);
	const future = new MandateStore(home.path, { now: () => new Date("2100-01-01T00:00:00Z") });
	assert.equal((await future.continue(source.id)).state, "committed");
	assert.equal(future.selection("dispatch", { jobId: original.id, project: "demo", kind: "research" })?.grant.id, source.id);
	post.mandates.pause(source.id);
	assert.throws(() => post.mandates.assertPermitted("dispatch", { jobId: original.id, project: "demo", kind: "research" }), /paused/);
	assert.equal((await post.mandates.continue(source.id)).state, "ineligible");
	writeFileSync(post.artifacts.path(original.id), "# Legacy original plan\n");
	const stoppedReview = await parent("Inspect the paused legacy research gate without reopening its authority.", [
		{ kind: "tool_calls", calls: [{ name: "cp_gate", args: { job_id: original.id } }] },
	]);
	assert.ok(stoppedReview[0]!.isError);
	assert.match(JSON.stringify(stoppedReview[0]!.result), /paused/);
});

test("named mandate issue captures immutable typed admission without widening project scope", { timeout: 30_000 }, async (t) => {
	const home = createScratchHome();
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(async () => { await post.shutdown(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: "https://github.com/example/demo.git", delivery: "local" });
	const original = await post.ledger().create({
		title: "Original research", description: "Preserve the entire original task.",
		project: "demo", kind: "research", delivery: "local",
	});
	const unrelated = await post.ledger().create({
		title: "Unrelated research", project: "demo", kind: "research", delivery: "local",
	});
	const grant = post.mandates.issue({
		projects: ["demo"], objective: "Complete original research", job_ids: [original.id],
		expiry: "2099-01-01T00:00:00Z", provenance: { expiry_hours: "home" },
		spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 2, ask_on: [],
	});
	const saved = post.mandates.get(grant.id)!;
	assert.equal(saved.admissions?.length, 1);
	assert.equal(saved.admissions?.[0]?.job_id, original.id);
	assert.equal(saved.admissions?.[0]?.admitted_at, saved.issued_at);
	assert.equal(saved.admissions?.[0]?.project, "demo");
	assert.equal(saved.admissions?.[0]?.kind, "research");
	assert.match(saved.admissions![0]!.scope_digest, /^[a-f0-9]{64}$/);
	assert.ok(!saved.admissions?.some((admission) => admission.job_id === unrelated.id));
	assert.equal(saved.expiry, grant.expiry);
	assert.deepEqual(saved.spend_cap, { usd: 100, tokens: 10_000_000 });
	assert.equal(saved.continuity, undefined);
	const enrolled = post.mandates.enroll(saved.id, { jobId: unrelated.id, project: "demo", kind: "research" }, [], new Set([original.id, unrelated.id]));
	assert.deepEqual(enrolled.admissions?.[0], saved.admissions?.[0]);
	assert.equal(enrolled.admissions?.[1]?.job_id, unrelated.id);
	const admittedAt = enrolled.admissions![1]!.admitted_at;
	assert.ok(admittedAt !== undefined);
	assert.ok(admittedAt >= saved.issued_at);
	assert.ok(admittedAt < saved.expiry);
	assert.deepEqual(enrolled.spend_cap, saved.spend_cap);
	const replay = post.mandates.enroll(saved.id, { jobId: unrelated.id, project: "demo", kind: "research" }, [], new Set());
	assert.deepEqual(replay.admissions, enrolled.admissions);
});

test("typed default admission freezes full governing input after expiry without resetting authority", { timeout: 30_000 }, async (t) => {
	const home = createScratchHome();
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(async () => { await post.shutdown(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: "https://github.com/example/demo.git", delivery: "local" });
	const description = "Original acceptance\n" + "retain these exact bytes\n".repeat(400);
	const job = await post.ledger().create({ title: "Admitted research", description, project: "demo", kind: "research", delivery: "local" });
	const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const grant = post.mandates.issue({ projects: ["demo"], objective: "Finish the admitted research", job_ids: [job.id],
		expiry, provenance: { expiry_hours: "home" }, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	const deadline = post.mandates.issue({ projects: ["demo"], objective: "An explicit deadline", job_ids: [job.id],
		expiry, provenance: { expiry_hours: "explicit" }, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 20)));
	const next = await cpNext({ ledger: post.ledger(), fleet: post.fleet, mandates: post.mandates, escalations: post.escalations, packageRoot: REPO_ROOT }, "demo");
	assert.equal(next.action.kind, "dispatch");
	assert.equal(next.action.job_id, job.id);
	assert.equal(next.mandate?.id, grant.id);
	const result = await post.mandates.continue(grant.id);
	assert.equal(result.state, "committed");
	assert.deepEqual(result.job_ids, [job.id]);
	const saved = post.mandates.get(grant.id)!;
	assert.equal(saved.expiry, expiry);
	assert.equal(saved.continuity?.accounting_root_id, grant.id);
	assert.equal(saved.continuity?.phase, "committed");
	assert.deepEqual(saved.spend_cap, grant.spend_cap);
	assert.deepEqual(saved.usage_baseline, grant.usage_baseline);
	const frozen = JSON.parse(readFileSync(saved.continuity!.governing_input_refs[0]!, "utf8"));
	assert.equal(frozen.inputs[0].task, description);
	assert.equal(frozen.authority.objective, grant.objective);
	await post.ledger().claim(job.id, "continuity-test");
	const replay = await post.mandates.continue(grant.id);
	assert.equal(replay.receipt_id, result.receipt_id);
	assert.equal(replay.state, "committed");
	assert.equal((await post.mandates.continue(deadline.id)).state, "ineligible");
	assert.equal(post.mandates.get(deadline.id)!.continuity, undefined);
	post.mandates.pause(grant.id);
	assert.equal((await post.mandates.continue(grant.id)).state, "ineligible");
});

test("direct expired dispatch rejects added scope then delivers complete governing bytes to a real mock worker", {
	timeout: 90_000, skip: treehouseAvailable() ? false : "requires treehouse",
}, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	let snapshot = "";
	let workerJobId = "", workerArtifact = "";
	const model = provider.addScript("continuation-worker", [
		{ kind: "tool_calls", calls: [{ name: "read", args: () => ({ path: snapshot }) }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => ({ command: `printf '%s' 'Original bounded research report' > ${shellArg(workerArtifact)}` }) }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: workerJobId, kind: "research", status: "done", artifact_path: workerArtifact, summary: "Original research delivered.",
			plan_summary: { goal: "Original research", approach: ["Read complete original scope"], touched: ["README.md"], acceptance: ["Preserve scope"], risk: "Read only" },
			self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false } }) }] },
	]);
	agent.writeModels(provider);
	initJobsDocument(home.path, "cp");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION,
		allow: ["mock/*"], rubric: [{ id: "planner", role: "planner", model }] }));
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
	let pool: ReturnType<typeof enableTreehouse> | undefined;
	t.after(async () => { await post.shutdown(); await provider.stop(); pool?.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	pool = enableTreehouse(clone, { maxTrees: 2 });
	const task = "Research the original scope.\n" + "Preserve the exact governing instructions.\n".repeat(100);
	const job = await post.ledger().create({ title: "Research the original scope", description: task,
		project: "demo", kind: "research", delivery: "local" });
	workerJobId = job.id;
	workerArtifact = post.artifacts.file(job.id);
	const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const grant = post.mandates.issue({ projects: ["demo"], objective: "Complete only the admitted research, preserving all instructions",
		job_ids: [job.id], expiry, provenance: { expiry_hours: "project" },
		spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	snapshot = `${join(home.path, paths.mandateFile(grant.id))}.governing-inputs`;
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 20)));
	await assert.rejects(post.dispatch({ jobId: job.id, task: task + "\nAlso implement an unrelated feature", fetch: false }), /differs from its frozen original scope/);
	assert.equal(post.fleet.get(job.id), undefined);
	assert.equal(provider.requests("continuation-worker").length, 0);
	post.mandates.issue({ projects: ["demo"], objective: "Independent new project work", expiry: "2099-01-01T00:00:00Z",
		spend_cap: { usd: 200, tokens: 10_000_000 }, job_cap: 2, ask_on: [] });
	const accepted = await post.dispatch({ jobId: job.id, task, fetch: false });
	assert.equal(accepted.receipt, "accepted");
	assert.equal("mandate_id" in accepted ? accepted.mandate_id : undefined, grant.id);
	await waitFor(() => provider.requests("continuation-worker"), (requests) => requests.length >= 2,
		{ timeoutMs: 30_000, what: "worker reading complete continuation input" });
	const requests = provider.requests("continuation-worker").map((request) => JSON.stringify(request.body));
	assert.ok(requests[0]!.includes(JSON.stringify(task).slice(1, -1)));
	assert.ok(requests[0]!.includes(snapshot));
	assert.ok(requests.some((request) => request.includes(JSON.stringify(readFileSync(snapshot, "utf8")).slice(1, -1))));
	assert.equal(post.mandates.get(grant.id)!.expiry, expiry);
	assert.equal(post.mandates.assertPermitted("review", { jobId: job.id, project: "demo", kind: "research" }, post.fleet.read().jobs).selected?.id, grant.id);
	await waitFor(() => post.fleet.get(job.id)?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "accepted original research report" });
	await waitFor(() => post.manager.get(job.id)?.worker.busy, (busy) => busy === false, { timeoutMs: 30_000, what: "original research worker settling" });
	const originalTaskFile = join(home.path, paths.originalTaskFile(job.id));
	const originalBytes = readFileSync(originalTaskFile, "utf8");
	await assert.rejects(post.send({ jobId: job.id, message: "Continue the original research", task: task + "\nAlso implement unrelated scope" }), /differs from its frozen original scope/);
	assert.equal(readFileSync(originalTaskFile, "utf8"), originalBytes);
	post.mandates.revoke(grant.id, { by: "parent" });
	assert.throws(() => post.mandates.assertPermitted("promote", { jobId: job.id, project: "demo", kind: "research" }, post.fleet.read().jobs), /revoked/);
});

test("legacy continuation exposes one actionable scope-bound confirmation and accepts only authenticated approval", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	t.after(async () => { await post.shutdown(); await provider.stop(); agent.cleanup(); repo.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const first = await post.ledger().create({ title: "First original scope", description: "Preserve the complete first scope.\n".repeat(100), project: "demo", kind: "research", delivery: "local" });
	const second = await post.ledger().create({ title: "Second original scope", description: "Preserve the complete second scope.", project: "demo", kind: "research", delivery: "local" });
	const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const grants = [first, second].map((job) => {
		const grant = post.mandates.issue({ projects: ["demo"], objective: job.title, job_ids: [job.id], expiry,
			spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
		return post.mandates.save({ ...grant, admissions: undefined, provenance: undefined });
	});
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 20)));
	const parent = parentCommands(home.path, provider, agent);
	const escalation = (index: number) => post.escalations.list().find((item) => item.mandate_id === grants[index]!.id)!;
	const before = await parent("Inspect original admission; do not authorize any continuation.", [
		{ kind: "tool_calls", calls: [{ id: "next", name: "cp_next", args: { project: "demo" } }] },
		{ kind: "tool_calls", calls: [{ id: "replay", name: "cp_mandate", args: { action: "continue", source_id: grants[0]!.id } }] },
		{ kind: "tool_calls", calls: [{ id: "unanswered", name: "cp_mandate", args: () => ({ action: "continue", source_id: grants[0]!.id, confirmation_escalation_id: escalation(0).id }) }] },
		{ kind: "tool_calls", calls: [{ id: "unquoted", name: "cp_decide", args: () => ({ target: escalation(0).id, decision: "approve", basis: { mandate: grants[0]!.id, clause: "confirm" } }) }] },
		{ kind: "tool_calls", calls: [{ id: "budget", name: "cp_mandate", args: { action: "continue", source_id: grants[0]!.id, spend_usd: 1000 } }] },
	]);
	assert.equal(post.escalations.open().length, 2);
	const nextShown = JSON.stringify(before.find((event) => event.toolCallId === "next")?.result);
	assert.ok(post.escalations.open().some((item) => nextShown.includes(item.id)), nextShown);
	assert.match(nextShown, /cp_decide/);
	assert.equal(before.find((event) => event.toolCallId === "unquoted")?.isError, true);
	assert.equal(before.find((event) => event.toolCallId === "budget")?.isError, true);
	assert.equal(escalation(0).status, "open");
	assert.equal(post.mandates.get(grants[0]!.id)!.continuity, undefined);
	const evidence = JSON.parse(readFileSync(escalation(0).evidence_paths[1]!, "utf8"));
	assert.equal(evidence.inputs[0].task, first.description);
	assert.equal(evidence.authority.objective, grants[0]!.objective);
	const approve = `${escalation(0).id}: approve the original unchanged admission only`;
	const deny = `${escalation(1).id}: deny continuation`;
	const after = await parent(`${approve}\n${deny}`, [
		{ kind: "tool_calls", calls: [{ id: "approve", name: "cp_decide", args: { target: escalation(0).id, decision: "approve", basis: { operator_quote: approve } } }] },
		{ kind: "tool_calls", calls: [{ id: "deny", name: "cp_decide", args: { target: escalation(1).id, decision: "deny", basis: { operator_quote: deny } } }] },
		{ kind: "tool_calls", calls: [{ id: "commit", name: "cp_mandate", args: { action: "continue", source_id: grants[0]!.id, confirmation_escalation_id: escalation(0).id } }] },
		{ kind: "tool_calls", calls: [{ id: "denied", name: "cp_mandate", args: { action: "continue", source_id: grants[1]!.id, confirmation_escalation_id: escalation(1).id } }] },
		{ kind: "tool_calls", calls: [{ id: "ready", name: "cp_next", args: { project: "demo" } }] },
	]);
	for (const event of after) assert.notEqual(event.isError, true, JSON.stringify(event.result));
	assert.match(JSON.stringify(after.find((event) => event.toolCallId === "commit")!.result), /committed/);
	assert.match(JSON.stringify(after.find((event) => event.toolCallId === "denied")!.result), /ineligible/);
	assert.match(JSON.stringify(after.find((event) => event.toolCallId === "ready")!.result), new RegExp(first.id));
	assert.equal(post.mandates.get(grants[0]!.id)!.continuity?.phase, "committed");
	assert.equal(post.mandates.get(grants[1]!.id)!.continuity, undefined);
	assert.equal(post.mandates.list().length, 2);
	assert.deepEqual(post.mandates.get(grants[0]!.id)!.spend_cap, grants[0]!.spend_cap);
	assert.equal(post.mandates.get(grants[0]!.id)!.expiry, expiry);
});

test("post-expiry replacement uses a committed original-root link, full findings and one logical budget", { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
	const parent = parentCommands(home.path, provider, agent);
	let pool: ReturnType<typeof enableTreehouse> | undefined;
	t.after(async () => { await post.shutdown(); await provider.stop(); pool?.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	await post.registry.register({ name: "other", clone_url: "https://github.com/example/other.git", delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	pool = enableTreehouse(clone, { maxTrees: 3 });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "budgets.json"), JSON.stringify({ schema_version: 1, per_job_tokens: 10_000_000, per_job_cost_usd: 100, warn_ratio: 0.9, spawn_cap: 3 }));
	const task = "Research the original bounded work.\n" + "Keep every original acceptance detail unchanged.\n".repeat(200);
	const original = await post.ledger().create({ title: "Original bounded research", description: task, project: "demo", kind: "research", delivery: "local" });
	const addendum = "Additional original acceptance, in order.\n" + "Keep the original evidence and constraints complete.\n".repeat(200);
	const amended = await parent(`Authorize this original scope addition: ${addendum}`, [{ kind: "tool_calls", calls: [{ name: "cp_job", args: { action: "amend", job_id: original.id, text: addendum, quote: "Authorize this original scope addition", reason: "Original acceptance before admission" } }] }]);
	assert.notEqual(amended[0]!.isError, true, JSON.stringify(amended[0]!.result));
	const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const grant = post.mandates.issue({ projects: ["demo"], objective: "Complete only this original research", job_ids: [original.id], expiry,
		provenance: { expiry_hours: "home" }, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	const plan = "Complete original plan and findings.\n" + "Preserve the original research evidence.\n".repeat(200);
	let replacementId = "";
	const worker = (name: string, id: () => string, counted: boolean) => {
		const steps: ScriptStep[] = [
		{ kind: "tool_calls", usage: { prompt_tokens: counted ? 90_000 : 0, completion_tokens: counted ? 3200 : 0 }, calls: [
			{ name: "read", args: () => ({ path: counted ? post.mandates.get(grant.id)!.continuity!.governing_input_refs[0]! : join(home.path, paths.runDir(id()), "previous-plan.md") }) },
			...(!counted ? [
				{ name: "read", args: () => ({ path: join(home.path, paths.runDir(id()), "task-addenda.md") }) },
				{ name: "read", args: () => ({ path: join(home.path, paths.runDir(id()), "gate-1-raw.json") }) },
			] : []),
		] },
		{ kind: "tool_calls", usage: { prompt_tokens: 0, completion_tokens: 0 }, calls: [{ name: "bash", args: () => ({ command: `printf '%s' ${shellArg(plan)} > ${shellArg(post.artifacts.file(id()))}` }) }] },
		{ kind: "tool_calls", usage: { prompt_tokens: 0, completion_tokens: 0 }, calls: [{ name: "report_result", args: () => ({ job_id: id(), kind: "research", status: "done", artifact_path: post.artifacts.file(id()), summary: "Bounded original research delivered.",
			plan_summary: { goal: "Complete original research", approach: ["Read full original evidence"], touched: ["README.md"], acceptance: ["Preserve original scope"], risk: "Read only" },
			self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false } }) }] },
		];
		return provider.addScript(name, counted ? [...steps, ...steps.map((step) => ({ ...step, usage: { prompt_tokens: 0, completion_tokens: 0 } }))] : steps);
	};
	const originalModel = worker("original-research", () => original.id, true);
	const replacementModel = worker("replacement-research", () => replacementId, false);
	const gateModel = provider.addScript("original-gate", [
		{ kind: "tool_calls", usage: { prompt_tokens: 10_000, completion_tokens: 0 }, calls: [{ name: "read", args: () => ({ path: join(home.path, paths.gateScratchDir(original.id, 1), "original-task.md") }) }] },
		{ kind: "tool_calls", usage: { prompt_tokens: 0, completion_tokens: 0 }, calls: [{ name: "report_verdict", args: { job_id: original.id, verdict: "revise", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["Clarify one bounded acceptance detail"], revisions: ["Clarify the original acceptance without expanding scope"] } }] },
	]);
	const replacementGateModel = provider.addScript("replacement-gate", [
		{ kind: "tool_calls", usage: { prompt_tokens: 0, completion_tokens: 0 }, calls: [
			{ name: "read", args: () => ({ path: join(home.path, paths.gateScratchDir(replacementId, 2), "original-task.md") }) },
			{ name: "read", args: () => ({ path: join(home.path, paths.runDir(replacementId), "task-addenda.md") }) },
			{ name: "read", args: () => ({ path: join(home.path, paths.runDir(replacementId), "previous-plan.md") }) },
			{ name: "read", args: () => ({ path: join(home.path, paths.runDir(replacementId), "gate-1-raw.json") }) },
		] },
		{ kind: "tool_calls", usage: { prompt_tokens: 0, completion_tokens: 0 }, calls: [{ name: "report_verdict", args: () => ({ job_id: replacementId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["Original bounded acceptance satisfied"] }) }] },
	]);
	const models = provider.modelsJson();
	for (const settings of Object.values(models.providers)) {
		for (const model of (settings as { models: { id: string; cost: { input: number } }[] }).models) {
			if (model.id === provider.modelId("original-research")) model.cost.input = 9.94 / 0.09;
			if (model.id === provider.modelId("original-gate")) model.cost.input = 1;
		}
	}
	writeFileSync(join(agent.path, "models.json"), JSON.stringify(models));
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [{ id: "planner", role: "planner", model: originalModel }] }));
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 20)));
	assert.equal((await post.dispatch({ jobId: original.id, task, model: originalModel, fetch: false })).receipt, "accepted");
	await waitFor(() => post.fleet.get(original.id)?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "original public research report" });
	const reviewed = await post.gate({ jobId: original.id, model: gateModel });
	assert.ok(isGateWait(reviewed));
	post.reviewRuns.handBack(reviewed.key);
	await post.reviewRuns.settled(reviewed.key);
	assert.equal(readPriorAttempts(home.path, original.id).decisions.at(-1)?.verdict, "revise");
	await waitFor(() => post.fleet.get(original.id)?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "automatic bounded revision report" });
	await waitFor(() => post.manager.get(original.id)?.worker.busy, (busy) => busy === false, { timeoutMs: 30_000 });
	const torn = await post.teardown.teardown(original.id);
	assert.equal(post.fleet.get(original.id)?.phase, "done", JSON.stringify(torn));
	assert.equal((await post.ledger().show(original.id)).status, "closed");
	for (const candidate of [
		{ title: "Wrong kind", project: "demo", kind: "ship" as const, delivery: "local" as const },
		{ title: "Wrong project", project: "other", kind: "research" as const, delivery: "local" as const },
		{ title: "Additional scope", description: "Also implement an unrelated feature", project: "demo", kind: "research" as const, delivery: "local" as const },
	]) {
		const wrong = await post.ledger().create(candidate);
		const refused = await parent("Inspect an ineligible replacement without adding authority.", [{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: {
			action: "replace_work", source_id: grant.id, original_job_id: original.id, replacement_job_id: wrong.id,
		} }] }]);
		assert.match(JSON.stringify(refused[0]!.result), /ineligible/);
		assert.equal(post.fleet.get(wrong.id), undefined);
		assert.equal(post.mandates.get(grant.id)!.same_work_replacements, undefined);
	}
	const replacement = await post.ledger().create({ title: "Fresh successor identity", project: "demo", kind: "research", delivery: "local" });
	replacementId = replacement.id;
	assert.ok(replacement.created_at >= expiry);
	const competing = await post.ledger().create({ title: "Competing successor identity", project: "demo", kind: "research", delivery: "local" });
	const replacementArgs = { action: "replace_work", source_id: grant.id, original_job_id: original.id, replacement_job_id: replacement.id };
	const blockedFile = join(home.path, paths.runDir(replacement.id), "revision-task.md");
	mkdirSync(blockedFile, { recursive: true });
	await parent("Prepare the original-work replacement.", [{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: replacementArgs }] }]);
	assert.equal(post.mandates.get(grant.id)!.same_work_replacements?.[0]?.phase, "prepared");
	assert.equal(post.fleet.get(replacement.id), undefined);
	await assert.rejects(post.dispatch({ jobId: replacement.id, task: "Continue the unchanged original work", model: replacementModel, fetch: false }), /not committed/);
	await assert.rejects(post.gate({ jobId: original.id, model: gateModel }), /same work is bound/);
	rmdirSync(blockedFile);
	await Promise.all([
		parent("Resume the same original-work replacement.", [{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: replacementArgs }] }]),
		parent("Try the competing replacement identity.", [{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: { ...replacementArgs, replacement_job_id: competing.id } }] }]),
	]);
	assert.equal(post.mandates.get(grant.id)!.same_work_replacements?.length, 1);
	assert.equal(post.mandates.get(grant.id)!.same_work_replacements?.[0]?.replacement_job_id, replacement.id);
	const linked = await parent("Continue the unchanged admitted research under its original remaining budget.", [
		{ kind: "tool_calls", calls: [{ id: "link", name: "cp_mandate", args: { action: "replace_work", source_id: grant.id, original_job_id: original.id, replacement_job_id: replacement.id } }] },
		{ kind: "tool_calls", calls: [{ id: "replay", name: "cp_mandate", args: { action: "replace_work", source_id: grant.id, original_job_id: original.id, replacement_job_id: replacement.id } }] },
		{ kind: "tool_calls", calls: [{ id: "show", name: "cp_mandate", args: { action: "show", mandate_id: grant.id } }] },
		{ kind: "tool_calls", calls: [{ id: "ready", name: "cp_next", args: { project: "demo", full: true } }] },
	]);
	for (const event of linked) assert.notEqual(event.isError, true, JSON.stringify(event.result));
	assert.match(JSON.stringify(linked.find((event) => event.toolCallId === "link")!.result), /committed/);
	const saved = post.mandates.get(grant.id)!;
	assert.equal(saved.same_work_replacements?.length, 1);
	assert.equal(saved.same_work_replacements![0]!.work_id, original.id);
	assert.equal(saved.same_work_replacements![0]!.accounting_root_id, grant.id);
	assert.equal(saved.expiry, expiry);
	assert.deepEqual(saved.spend_cap, grant.spend_cap);
	assert.match(JSON.stringify(linked.find((event) => event.toolCallId === "show")!.result), /9\.95/);
	assert.match(JSON.stringify(linked.find((event) => event.toolCallId === "show")!.result), /103200/);
	assert.match(JSON.stringify(linked.find((event) => event.toolCallId === "ready")!.result), new RegExp(replacement.id));
	const taskFile = join(home.path, paths.runDir(replacement.id), "revision-task.md");
	assert.equal(readFileSync(join(home.path, paths.runDir(replacement.id), "previous-plan.md"), "utf8"), plan);
	assert.ok(readFileSync(join(home.path, paths.originalTaskFile(replacement.id)), "utf8").includes(task));
	assert.equal((await post.dispatch({ jobId: replacement.id, taskFile, model: replacementModel, fetch: false })).receipt, "accepted");
	await waitFor(() => post.fleet.get(replacement.id)?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "replacement public report" });
	await waitFor(() => post.manager.get(replacement.id)?.worker.busy, (busy) => busy === false, { timeoutMs: 30_000 });
	post.mandates.pause(grant.id);
	const stoppedSend = await parent("Inspect the stopped original-root successor without reopening it.", [
		{ kind: "tool_calls", calls: [{ name: "cp_send", args: { job_id: replacement.id, message: "Continue only the unchanged original research.", task_file: taskFile } }] },
	]);
	assert.ok(stoppedSend[0]!.isError);
	assert.match(JSON.stringify(stoppedSend[0]!.result), /paused/);
	assert.equal(post.fleet.get(replacement.id)!.phase, "held");
	post.mandates.resume(grant.id);
	assert.equal(readFileSync(join(home.path, paths.runDir(replacement.id), "previous-original-task.md"), "utf8"), readFileSync(join(home.path, paths.originalTaskFile(original.id)), "utf8"));
	assert.ok(readFileSync(join(home.path, paths.runDir(replacement.id), "previous-task-addenda.md"), "utf8").includes(addendum));
	assert.ok(readFileSync(join(home.path, paths.originalTaskFile(replacement.id)), "utf8").includes(task));
	assert.ok(Math.abs(post.fleet.get(replacement.id)!.budget!.cost_usd - 90.05) < 1e-8);
	assert.equal(post.fleet.get(replacement.id)!.budget!.tokens, 9_896_800);
	assert.equal(post.mandates.list().length, 1);
	const substantiveId = (await post.ledger().create({ title: "Substantive hold", description: "Independent substantive work", project: "demo", kind: "ship", delivery: "pr" })).id;
	const dependentId = (await post.ledger().create({ title: "Mechanical consumer", description: "Independent consumer", project: "demo", kind: "ship", delivery: "pr" })).id;
	await post.ledger().addDep(dependentId, original.id);
	await post.ledger().addDep(dependentId, substantiveId);
	const handoff = { action: "handoff", job_id: replacement.id, source_job_id: original.id, dependent_job_ids: [dependentId] };
	const registered = await parent("Register only this exact mechanical handoff; preserve the other hold.", [
		{ kind: "tool_calls", calls: [{ id: "register-handoff", name: "cp_gate", args: handoff }] },
		{ kind: "tool_calls", calls: [{ id: "replay-handoff", name: "cp_gate", args: handoff }] },
	]);
	for (const event of registered) assert.notEqual(event.isError, true, JSON.stringify(event.result));
	assert.deepEqual((await post.ledger().show(dependentId)).blocked_by.sort(), [original.id, substantiveId].sort());
	const mechanical = post.escalations.list().filter((item) => item.gate_handoff_id);
	assert.equal(mechanical.length, 1);
	const mechanicalQuote = `${mechanical[0]!.id}: confirm only this recorded mechanical dependency, retaining the substantive hold.`;
	const confirmed = await parent(mechanicalQuote, [{ kind: "tool_calls", calls: [{ name: "cp_decide", args: { target: mechanical[0]!.id, decision: "confirm", basis: { operator_quote: mechanicalQuote } } }] }]);
	assert.notEqual(confirmed[0]!.isError, true, JSON.stringify(confirmed[0]!.result));
	const waiting = await parent("The replacement still needs its real normal gate.", [{ kind: "tool_calls", calls: [{ name: "cp_gate", args: handoff }] }]);
	assert.notEqual(waiting[0]!.isError, true, JSON.stringify(waiting[0]!.result));
	assert.match(JSON.stringify(waiting[0]!.result), /waiting_review/);
	await assert.rejects(() => post.previewDispatch({ jobId: dependentId, task: "No premature dispatch" }), /handoff.*actual PASS/);
	const passed = await post.gate({ jobId: replacement.id, model: replacementGateModel });
	assert.ok(isGateWait(passed));
	post.reviewRuns.handBack(passed.key);
	await post.reviewRuns.settled(passed.key);
	assert.equal(readPriorAttempts(home.path, replacement.id).decisions.length, 2);
	assert.equal(readPriorAttempts(home.path, replacement.id).decisions.at(-1)?.verdict, "pass");
	const received = (script: string, text: string) => provider.requests(script).some((request) => request.body.messages?.some((message) => typeof message.content === "string" && message.content.includes(text)));
	assert.ok(received("original-research", JSON.stringify(task).slice(1, -1)));
	for (const script of ["replacement-research", "replacement-gate"]) {
		assert.ok(received(script, plan), `${script}: complete prior plan`);
		assert.ok(received(script, addendum), `${script}: complete ordered original addendum`);
		assert.ok(received(script, "Clarify the original acceptance without expanding scope"), `${script}: actual prior findings`);
		assert.ok(JSON.stringify(provider.requests(script)[0]).includes(join(home.path, paths.runDir(replacement.id), "task-addenda.md")));
	}
	assert.ok(received("replacement-gate", task));
	const unclosed = await parent("A real PASS does not replace normal closure.", [{ kind: "tool_calls", calls: [{ name: "cp_gate", args: handoff }] }]);
	assert.notEqual(unclosed[0]!.isError, true, JSON.stringify(unclosed[0]!.result));
	assert.match(JSON.stringify(unclosed[0]!.result), /waiting_review/);
	await waitFor(() => post.manager.get(replacement.id)?.worker.busy, (busy) => busy === false, { timeoutMs: 30_000 });
	assert.equal((await post.tearDown(replacement.id)).torn_down, true);
	const originalLedgerFactory = post.ledger.bind(post);
	const faultLedger = post.ledger();
	const projectEdges = faultLedger.retargetDeps.bind(faultLedger);
	faultLedger.retargetDeps = async (edges, assertCurrent) => { await projectEdges(edges, assertCurrent); throw new Error("interrupted after exact handoff projection"); };
	post.ledger = () => faultLedger;
	try {
		await assert.rejects(() => post.handoffGate(handoff), /interrupted after exact handoff projection/);
	} finally { post.ledger = originalLedgerFactory; }
	assert.deepEqual((await post.ledger().show(dependentId)).blocked_by.sort(), [replacement.id, substantiveId].sort());
	await assert.rejects(() => post.previewDispatch({ jobId: dependentId, task: "No partial handoff dispatch" }), /handoff.*actual PASS/);
	const committed = await parent("Commit the actual PASS-bound edge projection and replay it.", [
		{ kind: "tool_calls", calls: [{ id: "commit-handoff", name: "cp_gate", args: handoff }] },
		{ kind: "tool_calls", calls: [{ id: "commit-replay", name: "cp_gate", args: handoff }] },
	]);
	for (const event of committed) { assert.notEqual(event.isError, true, JSON.stringify(event.result)); assert.match(JSON.stringify(event.result), /committed/); }
	assert.deepEqual((await post.ledger().show(dependentId)).blocked_by.sort(), [replacement.id, substantiveId].sort());
	assert.equal(post.fleet.get(dependentId), undefined);
	// A delayed billing update arrives after the original worker has closed.
	const late = post.fleet.get(original.id)!.usage;
	post.fleet.patch(original.id, { usage: { ...late, input: late.input + 100, total_tokens: late.total_tokens + 100, cost_usd: late.cost_usd + 1 } });
	const final = await parent("Show the shared original budget after successor delivery.", [{ kind: "tool_calls", calls: [{ id: "shared", name: "cp_mandate", args: { action: "show", mandate_id: grant.id } }] }]);
	assert.match(JSON.stringify(final[0]!.result), /job cap: 1 \/ 1/);
	assert.match(JSON.stringify(final[0]!.result), /103300/);
	assert.match(JSON.stringify(final[0]!.result), /10\.95/);
	const unrelatedExpiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const unrelatedRoot = post.mandates.issue({ projects: ["demo"], objective: "Separately authorized research", job_ids: [original.id],
		expiry: unrelatedExpiry, provenance: { expiry_hours: "home" }, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] }, post.fleet.read().jobs);
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(unrelatedExpiry) - Date.now() + 20)));
	const rebound = await parent("Try binding the retired original through a different accounting root.", [{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: { ...replacementArgs, source_id: unrelatedRoot.id, replacement_job_id: competing.id } }] }]);
	assert.match(JSON.stringify(rebound[0]!.result), /original or replacement already belongs to another work link/);
	assert.equal(post.mandates.get(unrelatedRoot.id)!.same_work_replacements, undefined);
	assert.equal(post.fleet.get(competing.id), undefined);
	await parent("Close only the completed original logical mission.", [{ kind: "tool_calls", calls: [{ name: "cp_next", args: { project: "demo", full: true } }] }]);
	assert.equal(post.mandates.get(grant.id)!.status, "revoked");
	const fulfilled = await parent("Inspect the fulfilled root without adding budget or work.", [
		{ kind: "tool_calls", calls: [{ name: "cp_mandate", args: { action: "continue", source_id: grant.id } }] },
	]);
	assert.match(JSON.stringify(fulfilled[0]!.result), /ineligible/);
	assert.equal(post.mandates.get(grant.id)!.same_work_replacements!.length, 1);
});

test("pipeline reanchor resumes an interrupted exact edge projection and still requires fresh quality and authorization", { skip: !treehouseAvailable(), timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	let post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
	const parent = parentCommands(home.path, provider, agent);
	let pool: ReturnType<typeof enableTreehouse> | undefined;
	t.after(async () => { await post.shutdown(); await provider.stop(); pool?.cleanup(); agent.cleanup(); repo.cleanup(); home.cleanup(); });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	pool = enableTreehouse(clone, { maxTrees: 3 });
	let originalId = "";
	let replacementId = "";
	const worker = (name: string, id: () => string, twice = false) => {
		const steps: ScriptStep[] = [
			...(name === "reanchor-replacement" ? [{ kind: "tool_calls" as const, calls: [{ name: "read", args: () => ({ path: join(home.path, paths.runDir(id()), "previous-original-task.md") }) }] }] : []),
			{ kind: "tool_calls", calls: [{ name: "bash", args: () => ({ command: `printf '%s' '# Original bounded plan' > ${shellArg(post.artifacts.file(id()))}` }) }] },
			{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: id(), kind: "research", status: "done", artifact_path: post.artifacts.file(id()), summary: "Bounded plan ready.",
				plan_summary: { goal: "Research the bounded README change", approach: ["Read README.md"], touched: ["README.md"], acceptance: ["Keep the bounded scope"], risk: "Read only" },
				self_assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false } }) }] },
		];
		return provider.addScript(name, twice ? [...steps, ...steps] : steps);
	};
	const originalModel = worker("reanchor-original", () => originalId || post.pipeline().store.list()[0]!.research_id, true);
	const replacementModel = worker("reanchor-replacement", () => replacementId);
	const gate = (name: string, id: () => string, verdict: "revise" | "pass") => provider.addScript(name, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: () => ({ job_id: id(), verdict,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["Bounded README acceptance"], ...(verdict === "revise" ? { revisions: ["Clarify the bounded acceptance"] } : {}) }) }] }]);
	const originalGate = gate("reanchor-original-gate", () => originalId, "revise");
	const replacementGate = gate("reanchor-replacement-gate", () => replacementId, "pass");
	agent.writeModels(provider);
	const started = await post.startPipeline({ title: "Bounded README research", project: "demo", task: "Research a bounded README change.", delivery: "local", model: originalModel });
	originalId = started.research_id;
	await waitFor(() => post.fleet.get(originalId)?.phase, (phase) => phase === "held", { timeoutMs: 30_000 });
	const first = await post.gate({ jobId: originalId, model: originalGate });
	assert.ok(isGateWait(first));
	post.reviewRuns.handBack(first.key);
	await post.reviewRuns.settled(first.key);
	await waitFor(() => provider.remaining("reanchor-original") === 0 && post.manager.get(originalId)?.worker.busy === false, (settled) => settled, { timeoutMs: 30_000 });
	assert.equal((await post.tearDown(originalId)).torn_down, true);
	const replacement = await post.ledger().create({ title: "Replacement README research", description: "Research a bounded README change.", project: "demo", kind: "research", delivery: "pipeline" });
	replacementId = replacement.id;
	const prepared = await parent("Prepare the independent replacement planner.", [{ kind: "tool_calls", calls: [{ name: "cp_gate", args: { action: "replace_planner", job_id: originalId, replacement_job_id: replacementId } }] }]);
	assert.notEqual(prepared[0]!.isError, true, JSON.stringify(prepared[0]!.result));
	const hold = await post.ledger().create({ title: "Separate substantive hold", project: "demo", kind: "research", delivery: "local" });
	await post.ledger().addDep(started.ship_id, hold.id);
	const ledgerFile = post.ledger().file;
	renameSync(ledgerFile, `${ledgerFile}.saved`);
	mkdirSync(ledgerFile);
	try {
		await assert.rejects(() => post.reanchorPipeline(originalId, replacementId), /reanchor prepared; dependency projection failed/);
	} finally { rmdirSync(ledgerFile); renameSync(`${ledgerFile}.saved`, ledgerFile); }
	assert.deepEqual((await post.ledger().show(started.ship_id)).blocked_by, [originalId, hold.id]);
	assert.equal(post.pipeline().store.require(replacementId).reanchor?.phase, "prepared");
	await post.shutdown();
	post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agent.env } });
	await assert.rejects(() => post.advancePipeline(replacementId), /reanchor prepared/);
	await assert.rejects(() => post.dispatch({ jobId: started.ship_id, task: "Research a bounded README change.", model: replacementModel, fetch: false }), /reanchor prepared/);
	const projection = await post.reanchorPipeline(originalId, replacementId);
	assert.equal(projection.reanchor?.phase, "committed");
	assert.deepEqual((await post.ledger().show(started.ship_id)).blocked_by, [replacementId, hold.id]);
	assert.deepEqual(await post.reanchorPipeline(originalId, replacementId), projection);
	await assert.rejects(() => post.advancePipeline(originalId), /superseded/);
	assert.equal(readPriorAttempts(home.path, replacementId).decisions.at(-1)?.verdict, "revise");
	await post.dispatch({ jobId: replacementId, taskFile: join(home.path, paths.runDir(replacementId), "revision-task.md"), model: replacementModel, fetch: false });
	await waitFor(() => post.fleet.get(replacementId)?.phase, (phase) => phase === "held", { timeoutMs: 30_000 });
	assert.ok(provider.requests("reanchor-replacement").some((request) => request.body.messages?.some((message) => message.role === "tool" && typeof message.content === "string" && message.content.includes("Research a bounded README change."))), "ordinary replacement reads its preserved original scope after dispatch");
	const reviewed = await post.gate({ jobId: replacementId, model: replacementGate });
	assert.ok(isGateWait(reviewed));
	post.reviewRuns.handBack(reviewed.key);
	await post.reviewRuns.settled(reviewed.key);
	assert.equal(readPriorAttempts(home.path, replacementId).decisions.at(-1)?.attempt, 2);
	assert.equal(readPriorAttempts(home.path, replacementId).decisions.at(-1)?.verdict, "pass");
	assert.equal((await post.tearDown(replacementId)).torn_down, true);
	const pending = await post.advancePipeline(replacementId);
	assert.equal(pending.next, "authorize");
	assert.equal(post.fleet.get(started.ship_id), undefined);
	await assert.rejects(() => post.reanchorPipeline(originalId, replacementId), /human decision is pending/);
	const deny = "Decline this implementation checkpoint and retain its substantive hold.";
	const declined = await parent(deny, [{ kind: "tool_calls", calls: [{ name: "cp_decide", args: { target: `aw-checkpoint-${started.ship_id}`, decision: "decline", basis: { operator_quote: deny } } }] }]);
	assert.notEqual(declined[0]!.isError, true, JSON.stringify(declined[0]!.result));
	await assert.rejects(() => post.reanchorPipeline(originalId, replacementId), /checkpoint was declined/);
	assert.deepEqual((await post.ledger().show(started.ship_id)).blocked_by, [replacementId, hold.id]);
});
