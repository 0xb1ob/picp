import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { git, REPO_ROOT } from "../harness/index.ts";
import { EscalationStore } from "../../src/escalation.ts";

test("preview: the same request dispatched afterwards lands on exactly what the preview said", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "migrate the billing tables across every service", project: "demo", delivery: "pr", kind: "ship" });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const request = { jobId: job.id, task: "Migrate the billing tables across every service.", model, fetch: false };
	const preview = await post.previewDispatch(request);
	for (const path of [LAYOUT.fleetFile, paths.runDir(job.id), LAYOUT.sessions]) assert.equal(existsSync(join(b.home, path)), false);
	assert.equal((await b.ledger.show(job.id)).status, "open");
	const result = await post.dispatch(request);
	assert.equal(result.state, "dispatched");
	if (result.state !== "dispatched") return;
	assert.equal(result.model, preview.decision?.model);
	assert.equal(result.profile, preview.profile);
	assert.equal(result.routing, preview.line, "the preview's line IS the line the dispatch printed");
	assert.deepEqual(post.fleet.get(job.id)?.routing, preview.routing);
	assert.equal("mandate_id" in result, false, "unmandated dispatch fabricates no grant");
	assert.equal(git(result.worktree, "symbolic-ref", "--short", "HEAD"), job.id);
});

test("preview: a task file's body never travels in the result, and config changes belong to the dispatch", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "handover", project: "demo", delivery: "pr", kind: "ship" });
	const first = b.provider.addScript("first", [{ kind: "text", text: "received" }]);
	const second = b.provider.addScript("second", [{ kind: "text", text: "received" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const taskFile = join(b.home, "plan.md");
	const secretish = ["GITHUB_TOKEN=ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
	const body = `# Plan\n\nMeasured during the run: ${secretish}\n`;
	writeFileSync(taskFile, body);
	const policy = (model: string) => writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "small-ship", role: "implementer", scope: ["S"], model }] }));
	policy(first);
	const before = await post.previewDispatch({ jobId: job.id, taskFile, scope: "S", risk: "low" });
	assert.equal(JSON.stringify(before).includes(secretish), false, "a task file body reached the preview payload");
	assert.ok(!JSON.stringify(before).includes("# Plan"));
	assert.deepEqual(before.task, { source: "task_file", path: taskFile, bytes: Buffer.byteLength(body) });
	assert.equal(before.decision?.model, first);
	policy(second);
	const after = await post.previewDispatch({ jobId: job.id, taskFile, scope: "S", risk: "low" });
	assert.equal(after.decision?.model, second, "the live config decides, never a stale preview");
});

test("preview: an explicit model and effort, a QA job's profile, and a project row all resolve as they would at dispatch", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const ship = await b.ledger.create({ title: "small tidy-up", project: "demo", delivery: "pr", kind: "ship" });
	const qa = await b.ledger.create({ title: "where is the retry?", project: "demo", delivery: "answer", kind: "research" });
	const model = b.provider.addScript("preview", [{ kind: "text", text: "unused" }]);
	const override = b.provider.addScript("named", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "small-ship", role: "implementer", scope: ["S"], model, thinking: "low" }] }));
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const overridden = await post.previewDispatch({ jobId: ship.id, task: "tidy up", model: override, thinking: "xhigh" });
	assert.equal(overridden.decision?.source, "override");
	assert.equal(overridden.decision?.model, override);
	assert.equal(overridden.decision?.thinking, "xhigh");
	assert.match(overridden.line ?? "", /effort=override/);
	const answer = await post.previewDispatch({ jobId: qa.id, task: "look and tell me", model });
	assert.equal(answer.profile, "qa");
	assert.equal(answer.kind, "research");
	assert.equal(answer.delivery, "answer");
	const small = await post.previewDispatch({ jobId: ship.id, task: "tidy up", scope: "S", risk: "low" });
	assert.equal(small.decision?.rule, "small-ship");
	assert.deepEqual(small.routing.provenance, { scope: "explicit", risk: "explicit" });
});

test("preview: a route that fell back shows what it stepped over, and the model it would spawn", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "tidy up", project: "demo", delivery: "pr", kind: "ship" });
	const model = b.provider.addScript("spare", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "small-ship", role: "implementer", scope: ["S"], model: "mock/unavailable", fallbacks: [model], thinking: "low" }] }));
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "tidy up", scope: "S", risk: "low", dry_run: true } }] }]);
	assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
	const preview = ends[0]!.result.details as unknown as import("../../src/dispatch.ts").DispatchPreview;
	assert.equal(preview.decision?.model, model);
	assert.equal(preview.decision?.rule, "small-ship");
	assert.deepEqual(preview.decision?.attempted, [{ model: "mock/unavailable", refusal: "availability" }]);
	assert.equal(preview.line, `source=rubric model=${model} rule=small-ship thinking=low quota=off:no admin key attempted=mock/unavailable(availability)`);
	assert.equal(preview.availability?.available, true);
});

test("preview: a routing refusal is reported, not thrown, and an open blocker is visible", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t, { supportedThinking: ["low"] });
	const job = await b.ledger.create({ title: "ship it", project: "demo", delivery: "pr", kind: "ship" });
	const blocker = await b.ledger.create({ title: "first this", project: "demo", delivery: "pr", kind: "ship" });
	await b.ledger.addDep(job.id, blocker.id);
	const model = b.provider.addScript("shallow", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "ship", role: "implementer", model: "mock/unavailable" }] }));
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const ends = await b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "ship it", dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "ship it", model: "forbidden/model", dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "ship it", model, thinking: "xhigh", dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "a", task_file: "/nowhere", dry_run: true } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: "cp-nope", task: "a", dry_run: true } }] },
	]);
	assert.equal(ends.length, 5);
	for (const end of ends.slice(0, 3)) assert.notEqual(end.isError, true, JSON.stringify(end));
	assert.equal(ends[3]?.isError, true);
	assert.match(JSON.stringify(ends[3]?.result), /pass task or taskFile, not both/);
	assert.equal(ends[4]?.isError, true);
	assert.match(JSON.stringify(ends[4]?.result), /cp-nope/);
	const preview = ends[0]!.result.details as unknown as import("../../src/dispatch.ts").DispatchPreview;
	assert.equal(preview.decision, undefined);
	assert.equal(preview.availability, undefined);
	assert.match(preview.error ?? "", /no available model/);
	assert.match(preview.error ?? "", /This route has no other candidate/);
	assert.deepEqual(preview.blockers, [blocker.id]);
	assert.equal(preview.routing.scope, "S");
	const disallowed = ends[1]!.result.details as unknown as import("../../src/dispatch.ts").DispatchPreview;
	assert.equal(disallowed.decision, undefined);
	assert.match(disallowed.error ?? "", /the allowlist refuses/);
	assert.equal(disallowed.profile, "implementer");
	const tooMuch = ends[2]!.result.details as unknown as import("../../src/dispatch.ts").DispatchPreview;
	assert.equal(tooMuch.decision, undefined);
	assert.match(tooMuch.error ?? "", /cannot serve \(available: low\)/);
	await assert.rejects(post.previewDispatch({ jobId: job.id, task: "a", taskFile: "/nowhere" }), /pass task or taskFile, not both/);
	await assert.rejects(post.previewDispatch({ jobId: "cp-nope", task: "a" }));
});

test("preview: dry_run reports would ask: risk:high without escalating anything", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const model = b.provider.addScript("preview", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	post.mandates.issue({ projects: ["demo"], objective: "ship the bump", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
	for (const variant of [
		{ name: "hard stop", title: "rotate prod creds", task: "Rotate the production database credentials, then rm -rf the old dump.", gate: "would ask: risk:high" },
		{ name: "keyword", title: "rotate prod creds", task: "Rotate the production database credentials.", gate: undefined },
		{ name: "harmless", title: "typo", task: "Fix the typo in the README.", gate: undefined },
		{ name: "high label", title: "typo high", task: "Fix the typo in the README.", risk: "high" as const, gate: "would ask: risk:high" },
		{ name: "low label", title: "cleanup low", task: "Delete the stale fixture and migrate the test helper.", risk: "low" as const, gate: undefined },
	]) await t.test(variant.name, async () => {
		const job = await b.ledger.create({ title: variant.title, project: "demo", delivery: "pr", kind: "ship", ...(variant.risk ? { risk: variant.risk } : {}) });
		const preview = await post.previewDispatch({ jobId: job.id, task: variant.task, model });
		assert.equal(preview.mandate_gate, variant.gate, `${variant.name} gate`);
		if (variant.risk) assert.equal(preview.routing.risk, "high");
		if (variant.risk === "high") assert.equal(preview.routing.provenance?.risk, "explicit");
		assert.equal(new EscalationStore({ home: b.home }).list().length, 0, `${variant.name} raises no escalation`);
	});
});

test("preview: the route, resolved by the dispatch path, with nothing taken", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "rotate the production credentials", project: "demo", delivery: "pr", kind: "ship" });
	const model = b.provider.addScript("careful", [{ kind: "text", text: "unused" }]);
	b.agent.writeModels(b.provider);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "risky-ship", role: "implementer", risk: "high", model, thinking: "high" }] }));
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const preview = await post.previewDispatch({ jobId: job.id, task: "Rotate production credentials." });
	assert.equal(preview.preview, true);
	assert.equal(preview.job_id, job.id);
	assert.equal("mandate_id" in preview, false);
	assert.equal(preview.project, "demo");
	assert.equal(preview.kind, "ship");
	assert.equal(preview.delivery, "pr");
	assert.equal(preview.profile, "implementer");
	assert.equal(preview.routing.risk, "high");
	assert.deepEqual(preview.routing.provenance, { scope: "defaulted", risk: "inferred" });
	assert.ok((preview.routing.reasons ?? []).length > 0);
	assert.equal(preview.decision?.model, model);
	assert.equal(preview.decision?.source, "rubric");
	assert.equal(preview.decision?.rule, "risky-ship");
	assert.equal(preview.decision?.thinking, "high");
	assert.equal(preview.line, `source=rubric model=${model} rule=risky-ship thinking=high quota=off:no admin key`);
	assert.equal(preview.availability?.available, true);
	assert.equal(preview.availability?.supported_thinking, undefined);
	assert.equal(preview.error, undefined);
	assert.deepEqual(preview.task, { source: "task", bytes: "Rotate production credentials.".length });
	for (const path of [LAYOUT.fleetFile, paths.runDir(job.id), LAYOUT.sessions]) assert.equal(existsSync(join(b.home, path)), false);
	assert.equal((await b.ledger.show(job.id)).status, "open");
});
