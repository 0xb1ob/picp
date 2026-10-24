import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { initJobsDocument } from "../../src/ledger.ts";

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
