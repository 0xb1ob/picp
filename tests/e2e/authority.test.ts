/**
 * Behavior 02: mandate, budgets and authority, through a real CommandPost dispatch, real implementer workers on a
 * treehouse pool and a mock LLM. Every refusal is checked to start nothing: no fleet record, no provider request.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { liveUsageJobs } from "../../src/mandate-usage.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	REPO_ROOT,
	type ScriptStep,
	startPiChild,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the authority e2e needs treehouse on PATH";
const FAR = "2099-01-01T00:00:00Z";

/** `parentSteps` script a pi parent with the command-post extension on the same home (`parent()`), for `cp_*` calls. */
async function stack(t: TestContext, name: string, promptTokens = 100, parentSteps?: ScriptStep[]) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const script = `${name}-worker`;
	const steps = [{ kind: "text" as const, text: "standing by", usage: { prompt_tokens: promptTokens, completion_tokens: 20 } }];
	const model = provider.addScript(script, steps, { onExhausted: "repeat" });
	const parentModel = parentSteps ? provider.addScript(`${name}-parent`, parentSteps) : undefined;
	agentDir.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const rubric = [{ id: "implementer", role: "implementer", model }];
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric }));
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env } });
	t.after(async () => {
		await post.shutdown();
		await provider.stop();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 14 });
	t.after(() => pool.cleanup());

	// A worker's brief names its own job id, so a request that mentions it was spent on that job.
	const requests = (jobId: string) => provider.requests(script).filter((request) => JSON.stringify(request.body.messages ?? []).includes(jobId)).length;
	const record = (jobId: string) => (existsSync(join(home.path, LAYOUT.fleetFile)) ? readFleet(home.path).jobs.find((job) => job.job_id === jobId) : undefined);
	const dispatch = (jobId: string) => post.dispatch({ jobId, task: "Add a line to README.md.", fetch: false });
	return {
		home: home.path,
		post,
		record,
		/** One prompt to a real pi parent: its scripted `cp_*` calls run, and their tool results come back. */
		parent: async (prompt: string) => {
			assert.ok(parentModel, "stack() was given no parentSteps");
			const env = { ...agentDir.env, CP_HOME: home.path };
			const child = startPiChild({ cwd: home.path, model: parentModel, env, extensions: [COMMAND_POST_EXTENSION] });
			try {
				await child.prompt(prompt);
				await child.waitForSettled(90_000);
				return child.eventsOfType("tool_execution_end");
			} finally {
				await child.close();
			}
		},
		requests,
		job: async (title: string, risk?: "high") =>
			(await post.ledger().create({ title, project: "demo", delivery: "local", kind: "ship", ...(risk ? { risk } : {}) })).id,
		issue: (job_ids: string[], over: { ask_on?: ("merge" | "risk:high")[]; job_cap?: number; tokens?: number; expiry?: string } = {}) =>
			post.mandates.issue({
				projects: ["demo"],
				objective: "authority e2e",
				expiry: over.expiry ?? FAR,
				spend_cap: { usd: 100, tokens: over.tokens ?? 10_000_000 },
				job_cap: over.job_cap ?? 10,
				ask_on: over.ask_on ?? [],
				job_ids,
			}),
		/** An accepted dispatch reaches the provider through a live worker. */
		accepted: async (jobId: string) => {
			const result = await dispatch(jobId);
			assert.equal(result.receipt, "accepted");
			await waitFor(() => requests(jobId), (n: number) => n > 0, { timeoutMs: 60_000, what: `${jobId}'s worker asking the model` });
			return { mandate_id: "mandate_id" in result ? result.mandate_id : undefined, budget: record(jobId)?.budget };
		},
		/** A refused dispatch writes no fleet record and spends no model request; returns the refusal text. */
		refused: async (jobId: string, pattern: RegExp) => {
			let message = "";
			await assert.rejects(dispatch(jobId), (error: Error) => ((message = error.message), pattern.test(message)));
			assert.equal(record(jobId), undefined, `${jobId}: a refused dispatch left a fleet record`);
			assert.equal(requests(jobId), 0, `${jobId}: a refused dispatch reached the model`);
			return message;
		},
	};
}

test("authority: a scoped mandate dispatches the job it names under its id; an unnamed job is not its to speak for", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const s = await stack(t, "auth-scope");
	const named = await s.job("named job");
	const unnamed = await s.job("unnamed job");
	const grant = s.issue([named]);
	assert.equal((await s.accepted(named))?.mandate_id, grant.id);
	const free = await s.accepted(unnamed);
	assert.equal(free?.mandate_id, undefined, "a grant naming other jobs never speaks for this one");
});

test("authority: a paused or revoked mandate stops speaking; an expired or job-capped one refuses new paid work", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const s = await stack(t, "auth-refuse");
	const [paused, revoked, expired, first, capped] = [await s.job("paused"), await s.job("revoked"), await s.job("expired"), await s.job("first"), await s.job("capped")];

	// Paused and revoked grants are silent for dispatch: no grant authorizes the job, so none is charged for it.
	const grant = s.issue([paused, revoked]);
	s.post.mandates.pause(grant.id);
	assert.equal((await s.accepted(paused)).mandate_id, undefined, "a paused grant never speaks for a dispatch");
	s.post.mandates.revoke(grant.id);
	assert.equal((await s.accepted(revoked)).mandate_id, undefined, "a revoked grant never speaks for a dispatch");

	const short = s.issue([expired], { expiry: new Date(Date.now() + 3_000).toISOString().replace(/\.\d{3}Z$/, "Z") });
	await new Promise((resolve) => setTimeout(resolve, 3_500));
	await s.refused(expired, new RegExp(`mandate ${short.id} expired at .*A new job needs a new grant \\(cp_mandate issue\\)`));

	const cap = s.issue([first, capped], { job_cap: 1 });
	assert.equal((await s.accepted(first)).mandate_id, cap.id);
	await s.refused(capped, new RegExp(`mandate ${cap.id} job cap 1 reached — no new dispatch`));
});

test("authority: a risk:high answer authorizes only the job it names; a replacing grant supersedes the open ask", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const s = await stack(t, "auth-risk");
	const approved = await s.job("approved risky job", "high");
	const other = await s.job("other risky job", "high");
	const grant = s.issue([approved, other], { ask_on: ["risk:high"] });
	const ask = /risk:high under ask_on — refused before dispatch; (es-\S+) raised/;

	const first = ask.exec(await s.refused(approved, ask))?.[1] as string;
	const second = ask.exec(await s.refused(other, ask))?.[1] as string;
	assert.notEqual(first, second, "each job gets its own escalation");
	await s.post.escalations.answer(first, { answer: "approve", by: "operator-quote", basis: { operator_quote: `Approve ${first}.` } });

	assert.equal((await s.accepted(approved))?.mandate_id, grant.id, "the answered job dispatches");
	await s.refused(other, ask);
	assert.equal(s.post.escalations.get(second)?.status, "open", "an answer for one job is never consent for another");

	s.post.mandates.pause(grant.id);
	// issued_at has whole-second resolution and a replacement must be issued later than the grant it replaces.
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const replacement = s.issue([other], { ask_on: ["risk:high"] });
	// Issuing the replacement closes the old grant's open ask by itself; a later sweep finds nothing left.
	assert.deepEqual(s.post.mandates.supersedeEscalations(liveUsageJobs(s.post.fleet, s.post.runs)), []);
	assert.equal(s.post.escalations.get(second)?.status, "superseded");
	assert.match(String(s.post.escalations.get(second)?.superseded_reason), new RegExp(`${grant.id} was replaced by ${replacement.id}`));
	const fresh = ask.exec(await s.refused(other, ask))?.[1];
	assert.ok(fresh && fresh !== second, "the replacing grant asks again; the superseded ask cannot authorize it");
});

test("authority: token raises stay inside the ceiling, the USD cap never moves, and budgets.json is re-read live", { skip: SKIP, timeout: 300_000 }, async (t) => {
	let grantId = "";
	const raise = (id: string, over: Record<string, unknown>) => ({
		id,
		name: "cp_mandate",
		args: () => ({ action: "raise_tokens", mandate_id: grantId, reason: "the spender is still in scope", ...over }),
	});
	const s = await stack(t, "auth-budget", 5_000, [
		{ kind: "tool_calls", calls: [raise("over", { spend_tokens: 200_000_000 }), raise("usd", { spend_tokens: 1_000_000, spend_usd: 500 }), raise("ok", { spend_tokens: 1_000_000 })] },
		{ kind: "text", text: "raised" },
	]);
	const [spender, next, overflow] = [await s.job("spender"), await s.job("next"), await s.job("overflow")];
	const grant = s.issue([spender, next], { tokens: 4_000 });
	grantId = grant.id;

	// No data/budgets.json yet: the fleet defaults apply.
	assert.deepEqual((await s.accepted(spender))?.budget, { tokens: DEFAULT_BUDGET_CONFIG.per_job_tokens, cost_usd: DEFAULT_BUDGET_CONFIG.per_job_cost_usd });
	const status = () => s.post.mandates.list().find((mandate) => mandate.id === grant.id)?.pause_reason;
	await waitFor(status, (reason) => reason === "token_cap", { timeoutMs: 60_000, what: "the spender's usage to pause the grant" });
	await s.refused(next, new RegExp(`mandate ${grant.id} is paused \\(token_cap\\) — no new dispatch; in-flight continues; raise it yourself: cp_mandate raise_tokens ${grant.id}`));

	const ends = await s.parent("Raise the paused grant's token cap.");
	const end = (id: string) => ends.find((record) => record.toolCallId === id);
	assert.equal(end("over")?.isError, true);
	assert.match(JSON.stringify(end("over")?.result), /over the home's token_ceiling 100000000/);
	assert.equal(end("usd")?.isError, true);
	assert.match(JSON.stringify(end("usd")?.result), /can never raise the USD cap/);
	assert.notEqual(end("ok")?.isError, true, `raise_tokens failed: ${JSON.stringify(end("ok")?.result)}`);
	const raised = s.post.mandates.list().find((mandate) => mandate.id === grant.id);
	assert.deepEqual([raised?.status, raised?.spend_cap], ["active", { usd: 100, tokens: 1_000_000 }]);

	// The default spawn_cap (10 live workers) refuses an eleventh, with no data/budgets.json on disk.
	assert.equal(existsSync(join(s.home, LAYOUT.budgetsFile)), false);
	for (let i = 0; i < DEFAULT_BUDGET_CONFIG.spawn_cap - 1; i += 1) await s.accepted(await s.job(`filler ${i}`));
	const cap = DEFAULT_BUDGET_CONFIG.spawn_cap;
	await s.refused(overflow, new RegExp(`spawn cap reached \\(${cap}/${cap} workers\\)`));

	const budgets = (per_job_tokens: number, spawn_cap: number) =>
		writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ schema_version: 1, per_job_tokens, per_job_cost_usd: 3, warn_ratio: 0.8, spawn_cap }));
	// Written after this CommandPost was built: the raised cap and budget reach the very next dispatch.
	budgets(1_000, cap + 1);
	assert.deepEqual((await s.accepted(overflow))?.budget, { tokens: 1_000, cost_usd: 3 });
	budgets(2_000, cap + 2);
	assert.deepEqual((await s.accepted(next))?.budget, { tokens: 2_000, cost_usd: 3 }, "a second raise on the same live CommandPost applies");
});
