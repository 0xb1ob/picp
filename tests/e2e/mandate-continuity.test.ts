import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { createAgentDir, createScratchHome, createScratchRepo, enableTreehouse, MockProvider, REPO_ROOT, treehouseAvailable, waitFor } from "../harness/index.ts";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { cpNext } from "../../src/next.ts";

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
	assert.ok(enrolled.admissions![1]!.admitted_at >= saved.issued_at);
	assert.ok(enrolled.admissions![1]!.admitted_at < saved.expiry);
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
	const model = provider.addScript("continuation-worker", [
		{ kind: "tool_calls", calls: [{ name: "read", args: () => ({ path: snapshot }) }] },
		{ kind: "text", text: "standing by" },
	], { onExhausted: "repeat" });
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
	const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const grant = post.mandates.issue({ projects: ["demo"], objective: "Complete only the admitted research, preserving all instructions",
		job_ids: [job.id], expiry, provenance: { expiry_hours: "project" },
		spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 1, ask_on: [] });
	snapshot = `${join(home.path, paths.mandateFile(grant.id))}.governing-inputs`;
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 20)));
	await assert.rejects(post.dispatch({ jobId: job.id, task: task + "\nAlso implement an unrelated feature", fetch: false }), /differs from its frozen original scope/);
	assert.equal(post.fleet.get(job.id), undefined);
	assert.equal(provider.requests("continuation-worker").length, 0);
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
	post.mandates.revoke(grant.id, { by: "parent" });
	assert.throws(() => post.mandates.assertPermitted("promote", { jobId: job.id, project: "demo", kind: "research" }, post.fleet.read().jobs), /revoked/);
});
