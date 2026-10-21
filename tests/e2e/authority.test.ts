/**
 * Behavior 02: mandate, budgets and authority, through a real CommandPost dispatch, real implementer workers on a
 * treehouse pool and a mock LLM. Every refusal is checked to start nothing: no fleet record, no provider request.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import type { DispatchRequest } from "../../src/dispatch.ts";
import { DEFAULT_BUDGET_CONFIG, EMPTY_USAGE, isoTimestamp, LAYOUT, type Mandate, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { liveUsageJobs } from "../../src/mandate-usage.ts";
import type { NextResult } from "../../src/next.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
import { quoteSha } from "../../src/risk-preapproval.ts";
import { readEventLog } from "../../src/run-artifacts.ts";
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
	let parents = 0;
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
	const dispatch = (jobId: string, task = "Add a line to README.md.", over: Partial<DispatchRequest> = {}) => post.dispatch({ jobId, task, fetch: false, ...over });
	return {
		home: home.path,
		post,
		record,
		/** One prompt to a real pi parent: its scripted `cp_*` calls run, and their tool results come back. */
		parent: async (prompt: string, steps?: ScriptStep[]) => {
			// The harness rule: one script per child; a shared cursor lets a later child replay an earlier one's steps.
			const script = steps ? `${name}-parent-${(parents += 1)}` : `${name}-parent`;
			const model = steps ? provider.addScript(script, steps) : parentModel;
			if (steps) agentDir.writeModels(provider);
			assert.ok(model, "stack() was given no parentSteps");
			const env = { ...agentDir.env, CP_HOME: home.path };
			const child = startPiChild({ cwd: home.path, model, env, extensions: [COMMAND_POST_EXTENSION] });
			try {
				await child.prompt(prompt);
				await child.waitForSettled(90_000);
				if (steps) assert.equal(provider.remaining(script), 0, `${script}: the parent left scripted steps unused`);
				return child.eventsOfType("tool_execution_end");
			} finally {
				await child.close();
			}
		},
		requests,
		job: async (title: string, risk?: "high", over: { labels?: string[]; kind?: "ship" | "research"; delivery?: "pr" | "local"; description?: string } = {}) =>
			(await post.ledger().create({ title, project: "demo", delivery: over.delivery ?? "local", kind: over.kind ?? "ship", ...(risk ? { risk } : {}), ...(over.labels ? { labels: over.labels } : {}), ...(over.description ? { description: over.description } : {}) })).id,
		issue: (job_ids: string[], over: { ask_on?: ("merge" | "risk:high")[]; job_cap?: number; tokens?: number; usd?: number; expiry?: string; dispatch_parallelism?: number; channel?: "bridge" } = {}) =>
			post.mandates.issue({
				projects: ["demo"],
				objective: "authority e2e",
				expiry: over.expiry ?? FAR,
				spend_cap: { usd: over.usd ?? 100, tokens: over.tokens ?? 10_000_000 },
				job_cap: over.job_cap ?? 10,
				ask_on: over.ask_on ?? [],
				...(job_ids.length ? { job_ids } : {}),
				...(over.dispatch_parallelism ? { dispatch_parallelism: over.dispatch_parallelism } : {}),
				...(over.channel ? { channel: over.channel } : {}),
			}),
		provider,
		agentDir,
		/** An accepted dispatch reaches the provider through a live worker. */
		accepted: async (jobId: string, task?: string) => {
			const result = await dispatch(jobId, task);
			assert.equal(result.receipt, "accepted");
			await waitFor(() => requests(jobId), (n: number) => n > 0, { timeoutMs: 60_000, what: `${jobId}'s worker asking the model` });
			return { mandate_id: "mandate_id" in result ? result.mandate_id : undefined, budget: record(jobId)?.budget };
		},
		/** A refused dispatch writes no fleet record and spends no model request; returns the refusal text. */
		refused: async (jobId: string, pattern: RegExp, task?: string, over: Partial<DispatchRequest> = {}) => {
			let message = "";
			await assert.rejects(dispatch(jobId, task, over), (error: Error) => ((message = error.message), pattern.test(message)));
			assert.equal(record(jobId), undefined, `${jobId}: a refused dispatch left a fleet record`);
			assert.equal(requests(jobId), 0, `${jobId}: a refused dispatch reached the model`);
			return message;
		},
	};
}

type Stack = Awaited<ReturnType<typeof stack>>;
type End = Awaited<ReturnType<Stack["parent"]>>[number];
type ToolArgs = Record<string, unknown>;
const tool = (id: string, name: string, args: ToolArgs | (() => ToolArgs)) => ({ id, name, args: typeof args === "function" ? args : () => args });

/** One parent prompt; each `turns` entry is one model turn of tool calls. Returns every call's end by its id. */
async function prompted(s: Stack, prompt: string, ...turns: Array<Array<ReturnType<typeof tool>>>): Promise<Map<string, End>> {
	const ends = await s.parent(prompt, [...turns.map((calls) => ({ kind: "tool_calls" as const, calls })), { kind: "text" as const, text: "done" }]);
	return new Map(ends.map((end) => [String(end.toolCallId), end]));
}
const said = (end: End | undefined) => JSON.stringify(end?.result);

/** A `cp_send` promotion of a live worker, retried while it is still busy with its brief. */
async function promote(s: Stack, jobId: string) {
	await waitFor(() => s.requests(jobId), (n: number) => n > 0, { timeoutMs: 60_000, what: `${jobId}'s worker asking the model` });
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const sent = await s.post.send({ jobId, message: "Next: delete the stale rows.", task: "Delete the stale rows.", mode: "prompt" }).catch((error: Error) => {
			if (!/busy worker/.test(error.message)) throw error;
			return undefined;
		});
		if (sent) return sent;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return assert.fail(`${jobId}: the worker stayed busy`);
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

test("authority: a held PR job counts toward the job and spend caps but never holds a dispatch slot", { skip: SKIP, timeout: 300_000 }, async (t) => {
	let grantId = "";
	const raise = { id: "raise", name: "cp_mandate", args: () => ({ action: "raise_tokens", mandate_id: grantId, spend_tokens: 1_000_000, reason: "keep the job cap in view" }) };
	const s = await stack(t, "auth-held", 1_500, [{ kind: "tool_calls", calls: [raise] }, { kind: "text", text: "raised" }]);
	const [held, second, third] = [await s.job("held pr", undefined, { delivery: "pr" }), await s.job("second"), await s.job("third")];
	// Held spends 6,040 tokens; second 1,520 per model call (two or more calls, under 7,500 alone): only together
	// do they reach the 7,500 cap.
	const grant = s.issue([held, second, third], { job_cap: 2, dispatch_parallelism: 1, tokens: 7_500 });
	grantId = grant.id;
	const usage = { prompt_tokens: 3_000, completion_tokens: 20 };
	const head = () => execFileSync("git", ["-C", s.record(held)?.worktree as string, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const model = s.provider.addScript("auth-held-pr", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `printf 'held\\n' >> README.md && git add -A && git commit -q -m held && git push -q -u origin ${held}` } }], usage },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: held, kind: "ship", status: "done", summary: "Added a line.", branch: held, head_sha: head(), pr_url: "https://github.com/example/demo/pull/7" }) }], usage },
		{ kind: "text", text: "reported", usage: { prompt_tokens: 10, completion_tokens: 10 } },
	], { onExhausted: "repeat" });
	const dispatched = await s.post.dispatch({ jobId: held, task: "Add a line to README.md.", model, fetch: false });
	assert.equal("mandate_id" in dispatched ? dispatched.mandate_id : undefined, grant.id);
	await waitFor(() => s.record(held), (record) => record?.phase === "held", { timeoutMs: 60_000, what: "the PR job's envelope to be held" });
	assert.equal(s.post.mandates.get(grant.id)?.status, "active", "the held job alone stays under the token cap");

	// dispatch_parallelism 1: the held job has reported, so the one slot is free.
	assert.equal((await s.accepted(second)).mandate_id, grant.id);
	const status = () => s.post.mandates.get(grant.id)?.pause_reason;
	await waitFor(status, (reason) => reason === "token_cap", { timeoutMs: 60_000, what: "held + second spend to reach the token cap" });
	const raised = (await s.parent("Raise the paused grant's token cap.")).find((end) => end.toolCallId === "raise");
	assert.notEqual(raised?.isError, true, `raise_tokens failed: ${JSON.stringify(raised?.result)}`);
	await s.refused(third, new RegExp(`mandate ${grant.id} job cap 2 reached — no new dispatch`));
	assert.equal(s.record(held)?.phase, "held");
});

test("authority: an ops label fixes the profile and risk, never exempts the risk gate, and leases its resource", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const s = await stack(t, "auth-ops");
	const ops = (title: string, labels: string[], risk?: "high") => s.job(title, risk, { kind: "research", labels });
	const preview = (jobId: string, over: { risk?: "low"; profile?: string } = {}) => s.post.previewDispatch({ jobId, task: "Pull the remote logs.", ...over });
	const view = async (jobId: string, over?: { risk?: "low"; profile?: string }) => {
		const result = await preview(jobId, over);
		return [result.profile, "routing" in result ? result.routing.risk : undefined];
	};
	assert.deepEqual(await view(await ops("deploy", ["ops:deploy"]), { risk: "low" }), ["ops", "high"], "a deploy is high whatever the caller says");
	assert.deepEqual(await view(await ops("process", ["ops:process"])), ["ops", "high"]);
	const pull = await ops("pull", ["ops:pull"]);
	assert.deepEqual(await view(pull), ["ops", "low"]);
	const riskyPull = await ops("risky pull", ["ops:pull"], "high");
	assert.deepEqual(await view(riskyPull), ["ops", "high"], "a recorded high still wins");
	const plain = await ops("plain research", []);
	assert.equal((await preview(plain, { profile: "planner" })).profile, "planner", "a non-ops job keeps its own profile");

	await assert.rejects(preview(plain, { profile: "ops" }), /the ops profile needs an ops:<pull\|deploy\|process> label/);
	await assert.rejects(preview(pull, { profile: "planner" }), /an ops:pull job runs the ops profile, not planner/);
	await assert.rejects(preview(await s.job("ship pull", undefined, { labels: ["ops:pull"], delivery: "pr" })), /an ops job is kind:research delivery:local/);
	await assert.rejects(preview(await ops("two", ["ops:pull", "ops:deploy"])), /exactly one ops:<pull\|deploy\|process> label/);
	await assert.rejects(preview(await ops("unknown", ["ops:reboot"])), /found ops:reboot/);

	// The ops profile is read-only research, yet an ops job acts on a remote host: risk:high still asks.
	const readOnly = await s.job("read-only research", "high", { kind: "research" });
	s.issue([readOnly, riskyPull], { ask_on: ["risk:high"] });
	assert.equal((await preview(readOnly, { profile: "planner" })).mandate_gate, undefined, "read-only planning is never gated");
	assert.equal((await preview(riskyPull)).mandate_gate, "would ask: risk:high");

	const [holder, wanting, other] = [await s.job("holder", undefined, { labels: ["resource:tg-session"] }), await s.job("wanting", undefined, { labels: ["resource:tg-session"] }), await s.job("other", undefined, { labels: ["resource:mt5-2"] })];
	await s.accepted(holder);
	await s.refused(wanting, new RegExp(`resource:tg-session is leased by live job ${holder} — it is released when ${holder} is torn down`));
	await s.accepted(other);
	assert.equal((await s.post.tearDown(holder, { force: true })).torn_down, true);
	await s.accepted(wanting);

	// A failed re-dispatch meets its own leftover branch in preflight, before any resource check: never a self-conflict.
	// The direct recordRecoveryAttempt spends the one automatic attempt; a real death would revive the worker.
	recordRecoveryAttempt(s.home, wanting, "crash");
	await s.post.manager.get(wanting)?.worker.kill("SIGKILL");
	await waitFor(() => s.record(wanting), (record) => record?.phase === "failed", { timeoutMs: 60_000, what: "the killed worker to be classified" });
	await assert.rejects(s.post.dispatch({ jobId: wanting, task: "Add a line to README.md.", fetch: false }), (error: Error) => /branch_exists/.test(error.message) && !/leased by live job/.test(error.message));
});

// Keyword-risk senses, each text a job's whole task: none of these infers a risk.
const NO_RISK = [
	"no migration",
	"never expose secrets or tokens",
	"no permission changes",
	"not touching production",
	"do not expose any credentials",
	"without exposing the secrets",
	"No migration is required",
	"No database migration",
	"No schema or data migration",
	"Never deploy to production",
	"Do not deploy to production",
	"Must not deploy to production",
	"Never directly modify production",
	"Do not perform a migration",
	"Must not change the billing configuration",
	"No changes to authentication",
	"Never change any user permissions",
	"Do not expose the credentials",
	"Must not force-push",
	"Don't deploy to production",
	"No migration or never bulk delete the table",
	"Do not force-push or rewrite history",
	"never force-push or delete branches",
	"Never delete data, force-push, or rewrite history",
	"Do not delete or purge anything",
	"never destroy, delete or truncate the table",
	"Must not delete, drop the table, or purge",
	"never `force-push` or `rewrite history`",
	"Avoid force-pushing",
	"Use --force-with-lease rather than force-push",
	"Merge instead of force-pushing",
	"No credentials or tokens",
	"No data or database migration",
	"No migration or never rotate credentials",
	...["Constraints", "Non-goals"].map((heading) => `# Dashboard\nRead-only view\n## ${heading}\nMigration and permission changes\n### Details\nProduction tokens\n`),
	...["```", "~~~", "````", "~~~~"].flatMap((fence) => [`## Constraints\n${fence}\n## Implementation\n${fence}\nproduction`, `${fence}\nexample\n${fence}\n## Constraints\nproduction`]),
	"```\nexample\n````\n## Constraints\nproduction",
	"Doctor incorrectly calls the live .tracker database 'a frozen archive, safe to delete'. The issue body is authoritative for acceptance.",
	"stop advising users to delete .tracker",
	"Keep tracker runSync running after backfill failure and test integration write-back",
	"Fix tracker-tick backfill failure skipping runSync and add the missing cp_integrate write-back test from PR #340 review.",
	"Fix src/trackers/backfill.ts for cp-tracker-backfill-sync-ne5t",
	"project-wide accounting includes $634.17 and 53.6M historical tokens from before the grant existed",
	"a grant's spend and token caps count usage attributable to that grant",
	"Hitting a token-cap raise within the ceiling",
	'"Context" means **context-window usage**: tokens currently in context against the model\'s window',
	"The bar turns amber at ≥70% and red at ≥90%, using existing colour tokens only.",
	"Show each worker's context tokens against its window",
	"Migration: none — existing records keep their fields.",
	"Changelog entry with **Migration:** n/a.",
	"Include `Migration: none` in the changelog.",
	"## Goal\nAdd a status column to the report view.\n## Acceptance\n- Merge only with green CI and repository merge permission.\n## Test plan\n- Feed \"drop the legacy column\" and \"rotate credentials\" as fixtures.\n## Evidence\n- The access check reads the token from the record.\n## Unknowns/Blockers\n- Whether production uses it.\n## Self-assessment\n- destructive_scope: false; a schema migration was considered.",
	"Show cost/tokens/PR per job and spend: {usd, tokens}.",
	"Render spend.tokens / spend_cap.tokens on each card; usd and tokens include reviewers.",
	"Estimate the tokens and time spent before the first edit.",
	"Report estimated waste, in minutes, tokens and $ where computable.",
	"Add a context-tokens status line that counts noncached tokens.",
	"Read-only audit of the repository history. For each finding name the fix: delete/redact/rewrite history.",
	"Read-only reviewer audit, answer deliverable. Severity per finding, and fix (delete/redact/rewrite history).",
];

// Real risk wording, each with the words the risk:high ask must name (absent: any word, as long as it is high).
const RISKY: Array<[string, string[]?]> = [
	["No database migration; deploy to production", ["production"]],
	["Never deploy to production but delete the table", ["delete"]],
	["No migration and rotate credentials", ["credentials"]],
	["No changes are planned for production", ["production"]],
	["No tests. Deploy to production", ["production"]],
	["Do not wait to purge the table", ["purge"]],
	["Deploy without tests to production", ["production"]],
	["No migration or bulk delete the table", ["delete"]],
	["No migration or permanently destroy the table", ["destroy"]],
	["No migration or immediately truncate the table", ["truncate"]],
	["No migration or quickly purge the table", ["purge"]],
	["No migration or bulk backfill the table", ["backfill"]],
	["No migration or immediately drop the table", ["drop the table"]],
	["No migration or immediately migrate the table", ["migrate"]],
	["Force-push main", ["force-push"]],
	["Delete the stale rows and purge the cache", ["delete", "purge"]],
	["Never force-push; delete the table", ["delete"]],
	["Never force-push or delete branches, then truncate the table", ["truncate"]],
	["Do not purge, but drop the table", ["drop the table"]],
	["never force-push and delete the branch", ["delete"]],
	["Never force-push or rotate credentials", ["credentials"]],
	["Never delete. Force-push main", ["force-push"]],
	["Delete the table instead, then force-push", ["delete", "force-push"]],
	["Avoid downtime by deleting rows; purge the cache", ["deleting", "purge"]],
	["Avoid downtime by deleting rows", ["deleting"]],
	["Instead of migrating we will drop the table", ["drop the table"]],
	["Rather than patching it we purge the cache", ["purge"]],
	["Avoid the outage window and truncate the table", ["truncate"]],
	["Avoid any downtime when deleting the rows", ["deleting"]],
	["No migration or rotate credentials", ["credentials"]],
	["No migration or expose secrets", ["secrets"]],
	["No migration or grant permissions", ["permissions"]],
	["No migration or change authentication", ["authentication"]],
	["No migration or rotate secrets or tokens", ["secrets", "tokens"]],
	...["Constraints", "Non-goals"].flatMap((heading): Array<[string, string[]]> => {
		const text = `# Dashboard\nRead-only view\n## ${heading}\nMigration and permission changes\n### Details\nProduction tokens\n`;
		return [[`${text}## Implementation\nRotate credentials`, ["credentials"]], [`${text}# Implementation\nRotate credentials`, ["credentials"]], [`Rotate credentials\n${text}`, ["credentials"]]];
	}),
	...["```", "~~~", "````", "~~~~"].flatMap((fence) =>
		["Constraints", "Non-goals"].map((heading): [string, string[]] => [`${fence}markdown\n## ${heading}\nproduction\n${fence}\nRotate credentials`, ["credentials", "production"]]),
	),
	...["~~~", "```", "```` trailing text"].map((close): [string, string[]] => [`\`\`\`\`markdown\n${close}\n## Constraints\nproduction`, ["production"]]),
	["Never expose secrets or tokens; rotate credentials", ["credentials"]],
	["No migration, but change production billing", ["billing", "production"]],
	["Never expose secrets or delete rows", ["delete"]],
	["Expose secrets or tokens"],
	["This stage only reads and plans; implementation follows a passing cp_gate and applicable risk authorization.", ["authorization"]],
	["Rotate the tokens"],
	["Rotate the 2 leaked tokens"],
	["Revoke 3 old tokens"],
	["Implement token rotation"],
	["Store API tokens in the request context"],
	["hard-delete the rows"],
	["Delete the stale user rows"],
	["Run 'delete all rows' now"],
	["Fix the delete path so it removes rows"],
	["Backfill step: rewrite every row"],
	["Backfill the accounts table and drop the legacy column"],
	["stop advising deletion and delete the .tracker directory"],
	["Deploy to prod-us-east"],
	["Edit config/credentials.yml"],
	["Add src/migrations/002_drop_users.sql"],
	["The alert says 'production credentials expired'; rotate them"],
	["The runbook says 'purge the cache'; do it"],
	["Delete the user's 'archive' folder"],
	["Rotate the GitHub token", ["token"]],
	["Drop the column", ["drop the column"]],
	["Delete the production database", ["delete", "production"]],
	["Change repo permissions", ["permissions"]],
	["## Goal\nDrop the column.\n## Acceptance\n- tests pass", ["drop the column"]],
	["## Acceptance\n- tests pass\n## Implementation\nDelete the production database", ["delete", "production"]],
	["Migration: rewrite every row of the accounts table", ["migration"]],
	["Migration: none of the old rows are kept", ["migration"]],
	["Fix: delete/redact/rewrite history", ["rewrite history"]],
	["Read-only audit first, then rewrite history on main", ["rewrite history"]],
	["keep backups read-only; run squash/rewrite history on main", ["rewrite history"]],
	["Read-only audit of the backups. Then run squash/rewrite history on main.", ["rewrite history"]],
	["Read-only audit first, then fix: squash/rewrite history on main", ["rewrite history"]],
	["Read-only audit of the repository. Name each fix: delete/redact/rewrite history. Then apply the fix.", ["rewrite history"]],
	["Report 1000 github-tokens per org", ["tokens"]],
	["Store API tokens, usd limits included", ["tokens"]],
	["Print the tokens and $GH_PAT", ["tokens"]],
];

test("authority: keyword risk inference skips negated, excluded and benign senses; the risk:high ask names every word it matched", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const s = await stack(t, "auth-infer");
	s.issue([], { ask_on: ["risk:high"], channel: "bridge", job_cap: 1_000 });
	const ask = /risk:high under ask_on — refused before dispatch; (es-\S+) raised/;
	let probe = 0;
	// A bridge grant gates every keyword high, so the refusal's ask carries the matched words; a low only previews.
	const words = async (task: string, over: { title?: string; description?: string } = {}) => {
		const jobId = await s.job(over.title ?? `probe ${(probe += 1)}`, undefined, over.description ? { description: over.description } : {});
		const preview = await s.post.previewDispatch({ jobId, task });
		assert.ok("routing" in preview, task);
		if (preview.routing.risk === "low") {
			assert.deepEqual([preview.routing.provenance?.risk, preview.mandate_gate], ["defaulted", undefined], task);
			return [];
		}
		assert.deepEqual([preview.routing.provenance?.risk, preview.mandate_gate], ["inferred", "would ask: risk:high"], task);
		const id = ask.exec(await s.refused(jobId, ask, task))?.[1] as string;
		return /risk source: classify \(word: ([^)]*)\)/.exec(String(s.post.escalations.get(id)?.question))?.[1]?.split(", ");
	};
	for (const text of NO_RISK) assert.deepEqual(await words(text), [], text);
	for (const [text, want] of RISKY) {
		const got = await words(text);
		if (want) assert.deepEqual(got, want, text);
		else assert.ok(got?.length, `${text}: expected a risk word`);
	}

	// The job's own title and description are read too, and an excluded-section name never swallows them.
	const report = "## Goal\nAdd a report view.\n## Self-assessment\n- confidence: high";
	assert.deepEqual(await words(report, { title: "Add a report view", description: "Delete the production database" }), ["delete", "production"]);
	assert.deepEqual(await words(report, { title: "Add a rendered report view", description: "Render it." }), []);
	for (const title of ["Evidence", "Acceptance", "Test plan", "Unknowns/Blockers", "Self-assessment", "Constraints", "Non-goals"]) {
		assert.deepEqual(await words("Add a report view.", { title, description: "Delete the production database" }), ["delete", "production"], title);
	}
	// A supplied risk wins over the words, and keeps who supplied it.
	const supplied = await s.job("supplied risk");
	for (const risk of ["low", "high"] as const) {
		for (const inputsFrom of ["explicit", "assessed"] as const) {
			const preview = await s.post.previewDispatch({ jobId: supplied, task: "## Constraints\nproduction migration", risk, inputsFrom });
			assert.ok("routing" in preview);
			assert.deepEqual([preview.routing.risk, preview.routing.provenance?.risk], [risk, inputsFrom]);
		}
	}
});

test("authority: cp_mandate issue needs only projects and an objective; every other field resolves explicit > project > home and says which", { skip: SKIP, timeout: 300_000 }, async (t) => {
	type Args = Record<string, unknown>;
	const call = (id: string, args: Args | (() => Args)) => ({ id, name: "cp_mandate", args: typeof args === "function" ? args : () => args });
	const step = (...calls: ReturnType<typeof call>[]) => ({ kind: "tool_calls" as const, calls });
	const done = { kind: "text" as const, text: "done" };
	const set = (key: string, value: string) => ({ action: "defaults_set", key, value });
	const first = "tidy the README";
	let grants: () => Mandate[] = () => [];
	const grant = (objective: string) => grants().find((mandate) => mandate.objective === objective);
	const raise = (id: string, spend_tokens: number) => call(id, () => ({ action: "raise_tokens", mandate_id: grant(first)?.id, spend_tokens, reason: "ceiling probe" }));
	const issue = (id: string, objective: string, projects = ["demo"], over: Args = {}) => call(id, { action: "issue", projects, objective, ...over });
	const s = await stack(t, "auth-defaults");
	grants = () => s.post.mandates.list();
	const other = createScratchRepo({ name: "other", files: { "README.md": "# other\n" } });
	t.after(() => other.cleanup());
	await s.post.registry.register({ name: "other", clone_url: other.remote as string, delivery: "pr" });
	const file = join(s.home, LAYOUT.mandateDefaultsFile);
	const ends = new Map<string, Awaited<ReturnType<typeof s.parent>>[number]>();
	// Each prompt runs its own script, and every call it scripts must end in that prompt, after the files it reads.
	const prompt = async (text: string, steps: ReturnType<typeof step>[]) => {
		ends.clear();
		for (const end of await s.parent(text, [...steps, done])) ends.set(String(end.toolCallId), end);
		assert.deepEqual([...ends.keys()].sort(), steps.flatMap((each) => each.calls.map((c) => c.id)).sort(), text);
	};
	const said = (id: string) => JSON.stringify(ends.get(id)?.result);
	const ok = (id: string) => assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(id)}`);
	const failed = (id: string, pattern: RegExp) => assert.ok(ends.get(id)?.isError === true && pattern.test(said(id)), `${id}: ${said(id)}`);

	// A fresh home: the first session scaffolds the scope's conservative defaults, and a bare issue resolves from them.
	assert.equal(existsSync(file), false);
	await prompt("Show the mandate defaults, then fix the README under a grant.", [
		step(call("show0", { action: "defaults_show" }), issue("issue0", first)),
		step(call("view0", () => ({ action: "show", mandate_id: grant(first)?.id }))),
	]);
	const written = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(
		[written.expiry_hours, written.spend_usd, written.spend_tokens, written.token_ceiling, written.job_cap, written.dispatch_parallelism],
		[8, 100, 10_000_000, 100_000_000, 3, 3],
	);
	assert.equal(written.notes.dispatch_parallelism, "jobs under the grant that may run at once; set 1 for serial");
	assert.deepEqual([[...written.allowed_actions].sort(), written.ask_on], [["implement", "merge", "plan", "repair", "review"], ["risk:high"]]);
	assert.deepEqual(written.exclude_paths, [".github/workflows/", "secrets/", "**/.env*"]);
	for (const shown of [/expiry_hours: 8/, /spend_usd: 100/, /conservative so a stale mandate/]) assert.match(said("show0"), shown);
	ok("issue0");
	const bare = grant(first);
	assert.deepEqual(bare?.projects, ["demo"]);
	assert.ok(Object.keys(bare?.provenance ?? {}).length > 0 && Object.values(bare?.provenance ?? {}).every((from) => from === "home"), JSON.stringify(bare?.provenance));
	assert.ok(Math.abs(Date.parse(bare?.expiry ?? "") - Date.parse(bare?.issued_at ?? "") - 8 * 3_600_000) < 60_000, "expiry is issued_at + expiry_hours");
	assert.match(said("view0"), /field sources:/);
	assert.match(said("view0"), /expiry_hours:home/);

	// An operator edit survives the next session's scaffold; defaults_set writes, refuses junk; a lowered ceiling binds.
	writeFileSync(file, JSON.stringify({ ...written, spend_usd: 42, dispatch_parallelism: 1 }));
	await prompt("Tune the mandate defaults.", [
		step(call("show1", { action: "defaults_show" })),
		step(call("cap", set("job_cap", "9"))),
		step(call("ask", set("ask_on", "merge, risk:high"))),
		step(call("bogus", set("bogus", "1")), call("nan", set("job_cap", "not-a-number"))),
		step(call("ceiling", set("token_ceiling", "50000000"))),
		step(raise("over", 60_000_000)),
		step(issue("issue1", "after the edits")),
	]);
	assert.match(said("show1"), /spend_usd: 42/);
	assert.match(said("show1"), /dispatch_parallelism: 1/);
	ok("cap");
	ok("ask");
	ok("ceiling");
	assert.match(said("ceiling"), /token_ceiling: 50000000/);
	failed("bogus", /bogus/);
	failed("nan", /not-a-number|job_cap/);
	failed("over", /token_ceiling 50000000/);
	const edited = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual([edited.job_cap, edited.ask_on, edited.token_ceiling], [9, ["merge", "risk:high"], 50_000_000]);
	ok("issue1");
	const after = grant("after the edits");
	assert.deepEqual([after?.job_cap, after?.dispatch_parallelism, after?.ask_on, after?.provenance?.dispatch_parallelism], [9, 1, ["merge", "risk:high"], "home"]);

	// Project overrides apply only when every named project agrees, whatever their key order; explicit beats both.
	const overrides = (demo: Args, rest?: Args) => {
		const path = join(s.home, LAYOUT.projectsFile);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		for (const project of doc.projects) project.mandate = project.name === "demo" ? demo : rest;
		writeFileSync(path, JSON.stringify(doc));
	};
	const demo = { spend_usd: 25, job_cap: 5, allowed_actions: ["implement", "review"], expiry_hours: 1 };
	overrides(demo, { expiry_hours: 1, allowed_actions: ["implement", "review"], job_cap: 5, spend_usd: 25 });
	await prompt("Issue a grant over both projects.", [step(issue("agree", "agreeing overrides", ["demo", "other"], { spend_usd: 99 }))]);
	ok("agree");
	const agreed = grant("agreeing overrides");
	assert.deepEqual([agreed?.spend_cap, agreed?.job_cap, agreed?.allowed_actions], [{ usd: 99, tokens: 10_000_000 }, 5, ["implement", "review"]]);
	assert.deepEqual(
		[agreed?.provenance?.spend_usd, agreed?.provenance?.job_cap, agreed?.provenance?.spend_tokens, agreed?.provenance?.allowed_actions],
		["explicit", "project", "home", "project"],
	);
	overrides(demo, { ...demo, job_cap: 6 });
	await prompt("Issue a grant over both projects, then a dated one.", [
		step(issue("disagree", "disagreeing overrides", ["demo", "other"])),
		step(issue("dated", "dated", ["demo"], { expiry: "2030-01-01T00:00:00Z" })),
	]);
	ok("disagree");
	ok("dated");
	const split = grant("disagreeing overrides");
	assert.deepEqual([split?.job_cap, split?.spend_cap.usd, split?.provenance?.job_cap], [9, 42, "home"], "disagreement falls through to home");
	const dated = grant("dated");
	assert.deepEqual([dated?.expiry, dated?.provenance?.expiry_hours], ["2030-01-01T00:00:00Z", "explicit"], "an explicit expiry beats expiry_hours");
	// One project with an override and one without do not agree either: the grant falls through to home.
	overrides(demo);
	await prompt("Issue a grant over both projects again.", [step(issue("mixed", "mixed overrides", ["demo", "other"]))]);
	ok("mixed");
	const mixed = grant("mixed overrides");
	assert.deepEqual([mixed?.job_cap, mixed?.spend_cap.usd, mixed?.provenance?.job_cap], [9, 42, "home"], "an override beside none falls through");

	// An invalid defaults file is refused, never guessed; an unreadable one leaves nothing parent-raisable.
	writeFileSync(file, JSON.stringify({ ...edited, job_cap: 0 }));
	await prompt("Show the mandate defaults.", [step(call("invalid", { action: "defaults_show" }))]);
	failed("invalid", /job_cap/);
	writeFileSync(file, "{ not json");
	await prompt("Raise the grant's token cap.", [step(raise("unreadable", 20_000_000))]);
	failed("unreadable", /token_ceiling 0\b/);
});

// The keyword sentence every declaration and record below has to stand down (or not).
const DELETE = "Delete the stale fixture.";
const DASHBOARD =
	"# Dashboard: context-window usage everywhere, and a real desktop layout\n\nProject: pi-command-post-system. Two kind:ship delivery:pr jobs under one mandate (\"dashboard context + desktop\nlayout\"), run serially: A, then B. Scope M each, risk low. **Queued:** dispatch after xt7 (#341) has merged. Both jobs\ntouch viewer-app, which xt7 is changing.";

test("authority: a recorded or declared low turns a keyword-only high into a warning; a recorded, supplied or planner high still gates", { skip: SKIP, timeout: 900_000 }, async (t) => {
	const s = await stack(t, "auth-warn");
	s.issue([], { ask_on: ["risk:high"], channel: "bridge", job_cap: 1_000 });
	const ask = /risk:high under ask_on — refused before dispatch; (es-\S+) raised/;
	let probe = 0;
	const job = (labels: string[] = [], description?: string) => s.job(`warn ${(probe += 1)}`, undefined, { labels, ...(description ? { description } : {}) });
	type Over = Partial<DispatchRequest>;
	const gate = async (jobId: string, task: string, over: Over = {}) => (await s.post.previewDispatch({ jobId, task, ...over })).mandate_gate;
	const routed = async (jobId: string, task: string, over: Over = {}) => {
		const preview = await s.post.previewDispatch({ jobId, task, ...over });
		return "routing" in preview ? [preview.routing.risk, preview.routing.provenance?.risk] : [];
	};
	// An accepted dispatch returns the warning; the worker is torn down at once so the pool never fills.
	const warned = async (jobId: string, task: string, over: Over = {}) => {
		const result = await s.post.dispatch({ jobId, task, fetch: false, ...over });
		assert.equal(result.receipt, "accepted", task);
		assert.equal((await s.post.tearDown(jobId, { force: true })).torn_down, true);
		return "risk_warning" in result ? result.risk_warning : undefined;
	};
	const evidence = async (jobId: string, task: string, over: Over = {}) => {
		const id = ask.exec(await s.refused(jobId, ask, task, over))?.[1] as string;
		return String(s.post.escalations.get(id)?.question);
	};
	const stoodDown = (jobId: string, from: string, words = "delete") =>
		`${jobId}: warning: risk:high inferred from keywords only (${words}); risk low was ${from}, so ask_on risk:high warned instead of gating`;

	// declaredRisk: a clause-start risk in the header declares; a named gate, a later section or a fence does not.
	const declaredLow = ["Scope M each, risk low.", "Risk: low", "**Risk:** low", "Scope S, risk:low", `Risk: low\n\n${DELETE}\n\n## Details\nrisk high`, DASHBOARD];
	for (const head of declaredLow) assert.equal(await gate(await job(), head.includes(DELETE) ? head : `${head}\n\n${DELETE}`), undefined, head);
	const undeclared = ["preserve risk:high escalation", "ask_on risk:high gates it", "the risk low was recorded", "scope/risk assessment", "Implementation requires its own risk:high escalation", "high-risk low-level", "Risk: low-ish", "x\n```\nRisk: low\n```"];
	for (const head of undeclared) assert.equal(await gate(await job(), `${head}\n\n${DELETE}`), "would ask: risk:high", head);
	for (const head of ["- risk: high", "# T\nRisk: low. Risk: high."]) assert.equal(await gate(await job(), `${head}\n\nFix the typo.`), "would ask: risk:high", head);

	// riskField: a recorded or declared high routes high, a recorded low never routes, and the caller's own risk wins.
	assert.deepEqual(await routed(await job(["risk:high"]), "Fix the typo."), ["high", "explicit"]);
	assert.deepEqual(await routed(await job(["risk:low"]), "Fix the typo."), ["low", "defaulted"]);
	assert.deepEqual(await routed(await job(), "Risk: high\n\nFix it."), ["high", "explicit"]);
	const callerLow = await job(["risk:high"]);
	assert.deepEqual(await routed(callerLow, "Fix the typo.", { risk: "low", inputsFrom: "explicit" }), ["low", "explicit"]);

	// recordedRisk: any high first (the job's own, then the caller's), then the caller's low, then the job's own low.
	assert.equal(await gate(callerLow, "Fix the typo.", { risk: "low", inputsFrom: "explicit" }), "would ask: risk:high", "a recorded high beats an explicit low");
	assert.equal(await gate(await job(["risk:low"]), DELETE, { risk: "high", inputsFrom: "explicit" }), "would ask: risk:high");
	assert.equal(await gate(await job(), `Risk: high\n\n${DELETE}`, { recordedRisk: { risk: "low", provenance: "assessed", from: "planner" } }), "would ask: risk:high");
	for (const provenance of ["defaulted", "inferred"] as const) {
		assert.equal(await gate(await job(), DELETE, { recordedRisk: { risk: "low", provenance } }), "would ask: risk:high", `a ${provenance} pipeline low is no record`);
	}
	assert.equal(await gate(await job(["risk:high"]), "Fix the typo.", { recordedRisk: { risk: "low", provenance: "defaulted" } }), "would ask: risk:high");

	// Each recorded low names where it was recorded; a grant that does not ask stays silent.
	const label = await job(["risk:low"]);
	assert.equal(await warned(label, DELETE), stoodDown(label, "recorded on the job's risk: label"));
	const planner = await job(["risk:low"]);
	assert.equal(await warned(planner, DELETE, { recordedRisk: { risk: "low", provenance: "assessed", from: "planner" } }), stoodDown(planner, "assessed by the planner"));
	const pipeline = await job(["risk:low"]);
	assert.equal(await warned(pipeline, DELETE, { recordedRisk: { risk: "low", provenance: "explicit" } }), stoodDown(pipeline, "recorded by the pipeline"));
	const described = await job([], "Scope S, risk low. Tidy.");
	assert.equal(await warned(described, DELETE), stoodDown(described, "recorded in the job description header"));
	const header = await job();
	assert.equal(await warned(header, `Risk: low\n\n${DELETE}`), stoodDown(header, "recorded in the task header"));
	const requested = await job();
	assert.equal(await warned(requested, DELETE, { risk: "low", inputsFrom: "explicit" }), stoodDown(requested, "recorded on the dispatch"));
	const quiet = await job(["risk:low"]);
	s.issue([quiet]);
	assert.equal(await warned(quiet, DELETE), undefined, "a selected grant that never asks warns nothing");
	// A cp_send promotion reads the dispatch's recorded low back from the fleet record.
	const promoted = await job(["risk:low"]);
	assert.equal((await s.post.dispatch({ jobId: promoted, task: DELETE, fetch: false })).receipt, "accepted");
	assert.equal(s.record(promoted)?.routing?.recorded_risk, "low");
	assert.equal((await promote(s, promoted)).risk_warning, stoodDown(promoted, "recorded at dispatch"));
	assert.equal((await s.post.tearDown(promoted, { force: true })).torn_down, true);

	// inferredRiskGate: every gated high names its source in the ask.
	assert.match(await evidence(await job(["risk:high"]), "Fix the typo."), /\(.*risk high recorded on the job's risk: label; risk source: explicit\)$/);
	assert.match(await evidence(await job(), "Fix the typo.", { risk: "high", inputsFrom: "explicit" }), /\(risk source: explicit\)$/);
	const plannerHigh = { recordedRisk: { risk: "high" as const, provenance: "assessed" as const, from: "planner" as const } };
	assert.match(await evidence(await job(), "Fix the typo.", plannerHigh), /risk high assessed by the planner; risk source: planner\)$/);
	assert.match(await evidence(await job(), "Delete it"), /risk source: classify \(word: delete\)\)$/);

	// riskkw-qno: warning-only benign senses (an audit tag, an unapproved item, a named file, dead code) never warn,
	// while inference still counts them; a bare or data deletion warns. `gh auth status` is no risk word at all.
	const qno = ["P4 of the plan below. **P5 (migrating a home) is not approved:** don't build any of it.", "P5 (migration) is not approved.", "The scope is over-engineering only: `delete:` / `stdlib:` / `shrink:`."];
	for (const text of qno) assert.equal(await gate(await job(), text), "would ask: risk:high", `no recorded low still gates: ${text}`);
	const benign = [...qno, "Delete src/viewer/awaiting-view.ts.", "Delete the docs/HANDOFF.md file.", "Then delete dead code in the viewer.", "After it's installed, check `gh auth status`."];
	for (const text of benign) assert.equal(await warned(await job(["risk:low"]), text), undefined, text);
	assert.deepEqual(await routed(await job(), "After it's installed, check `gh auth status`."), ["low", "defaulted"]);
	const mixed = await job(["risk:low"]);
	assert.equal(await warned(mixed, "Check `gh auth status`, then delete the stale fixture"), stoodDown(mixed, "recorded on the job's risk: label"));
	const bare = ["Delete it", "Delete the table", "delete rows", "Delete the files", "delete code that handles billing", "delete docs", "delete data/users.json"];
	for (const text of bare) assert.match(String(await warned(await job(["risk:low"]), text)), /keywords only \(delete/, text);

	// #321: a named operator-chat grant warns on a keyword-only high with its words; a supplied, recorded or hard-stop
	// high still gates under it.
	const [chatty, explicit, assessed, labelled, ...stops] = [await job(), await job(), await job(), await job(["risk:high"]), await job(), await job(), await job()];
	const chat = s.issue([chatty, explicit, assessed, labelled, ...stops], { ask_on: ["risk:high"] });
	const chatWarning = `${chatty}: warning: risk:high inferred from keywords only; risk source: classify (word: delete, migration); grant ${chat.id} was issued from operator chat, so ask_on risk:high warned instead of gating`;
	assert.equal(await warned(chatty, "Delete the old migration helper"), chatWarning);
	assert.equal(await gate(explicit, "Delete it", { risk: "high", inputsFrom: "explicit" }), "would ask: risk:high", "explicit high");
	assert.equal(await gate(assessed, "Delete it", { risk: "high", inputsFrom: "assessed" }), "would ask: risk:high", "planner high");
	assert.equal(await gate(labelled, "Delete it"), "would ask: risk:high", "recorded high");
	// A hard stop beside the keyword: without it the same chat grant would only warn.
	for (const [i, text] of ["rm -rf build", "Copy auth.json into the worker", "force push the branch"].entries()) {
		assert.equal(await gate(stops[i] as string, `${DELETE} Then ${text}.`), "would ask: risk:high", `hard stop gates: ${text}`);
	}
});

test("authority: an operator-quoted risk:high pre-approval lets covered dispatches and promotions proceed with an audit row; anything else still asks", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await stack(t, "auth-preapprove");
	const QUOTE = "Pre-approve risk high for this mission's jobs.";
	const N3 = "build all except N12";
	const [covered, other, pushing, noisy, negated, serialJob, busy, named, outside] = [
		await s.job("covered", "high"), await s.job("other", "high"), await s.job("pushing", "high"), await s.job("noisy", "high"),
		await s.job("negated", "high"), await s.job("serial", "high"), await s.job("busy"), await s.job("named"), await s.job("outside"),
	];
	const grant = s.issue([], { ask_on: ["merge", "risk:high"] });
	const serial = s.issue([serialJob, busy], { ask_on: ["risk:high"], dispatch_parallelism: 1 });
	const narrow = s.issue([named], { ask_on: ["risk:high"] });
	const revoked = s.issue([named], { ask_on: ["risk:high"] });
	s.post.mandates.revoke(revoked.id);
	// issued_at has whole-second resolution: the project-wide serial grant must be issued after `grant` to lose to it.
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const wideSerial = s.issue([], { ask_on: ["risk:high"], dispatch_parallelism: 1 });
	const ask = /risk:high under ask_on — refused before dispatch; (es-\S+) raised/;
	const questions = (jobId: string) => s.post.escalations.list({ jobId }).map((row) => row.question);

	// N3 (b): an open risk:high ask for the job does not make the quote name its es- id.
	await s.refused(covered, ask);
	const preapprove = (id: string, mandate_id: string, operator_quote: string, job_ids?: string[]) =>
		tool(id, "cp_mandate", { action: "preapprove_risk", mandate_id, operator_quote, ...(job_ids ? { job_ids } : {}) });
	let ends = await prompted(s, `${QUOTE} ${N3}`, [preapprove("absent", grant.id, "go ahead with whatever, all of it.")]);
	assert.equal(ends.get("absent")?.isError, true, said(ends.get("absent")));
	assert.equal(s.post.mandates.require(grant.id).risk_preapproval, undefined, "a quote not found writes nothing");
	const scripted = (await s.post.ledger().create({ title: "scripted", project: "demo", delivery: "local", kind: "ship", risk: "high", scriptPath: "scripts/release.sh" })).id;
	const listed = [covered, pushing, noisy, negated, scripted];
	ends = await prompted(s, `${QUOTE} ${N3}`, [preapprove("named", grant.id, N3, listed), preapprove("serial", serial.id, QUOTE, [serialJob])], [tool("show", "cp_mandate", { action: "show", mandate_id: grant.id })]);
	assert.match(said(ends.get("named")), new RegExp(`risk:high pre-approved by operator-quote for ${listed.join(", ")}: dispatch and promotion only, never merge`));
	assert.notEqual(ends.get("serial")?.isError, true, said(ends.get("serial")));
	assert.match(said(ends.get("show")), /build all except N12/);
	assert.deepEqual(s.post.mandates.require(grant.id).risk_preapproval?.job_ids, listed);
	// A named script job still asks: a pre-approval never covers a script.
	await assert.rejects(s.post.dispatch({ jobId: scripted, fetch: false }), /risk:high under ask_on/);

	// Covered: the dispatch and a promotion proceed under the grant, raise nothing, and append one audit row each.
	const asked = questions(covered).length;
	assert.equal((await s.accepted(covered)).mandate_id, grant.id);
	await promote(s, covered);
	assert.equal(questions(covered).length, asked, "no escalation for a covered job");

	// Uncovered jobs and hard stops ask exactly as without a pre-approval; a negated hard stop is none.
	assert.equal(questions(other).length, 0);
	await s.refused(other, ask);
	assert.equal(questions(other).some((question) => question.includes("hard stop")), false, "uncovered evidence unchanged");
	const hardStop = /risk:high under ask_on.*; hard stop in the task text \(force push\): no standing risk pre-approval covers a hard stop/;
	await s.refused(pushing, hardStop, "Rebase, then force push to main.");
	assert.match(String(questions(pushing)[0]), /hard stop force push: force push/);
	const secret = "sk-live-ABCDEF1234567890";
	const noise = [`print the token ${secret}`, "git push --force origin main", "force-push again", "rm -rf build", "npm publish"].join("\n");
	const refusal = await s.refused(noisy, /hard stop/, noise);
	assert.match(refusal, /\(credential handling, data deletion, force push, external publishing\)/);
	for (const raw of [secret, "print the token", "--force", "rm -rf", "npm publish"]) assert.equal(refusal.includes(raw), false, `no raw text: ${raw}`);
	// The full project-wide serial grant (busy is live) is not the selected grant, so it cannot veto `negated`.
	assert.equal((await s.accepted(busy)).mandate_id, serial.id);
	assert.equal((await s.accepted(negated, "Ship it; no force-push and never npm publish.")).mandate_id, grant.id);
	assert.notEqual(wideSerial.id, grant.id);
	// The selected serial grant still caps its own pre-approved job, and that refusal audits nothing.
	await s.refused(serialJob, /dispatch-parallelism 1 is full/);
	assert.equal(s.post.mandates.require(serial.id).risk_preapproved, undefined);

	const rows = s.post.mandates.require(grant.id).risk_preapproved ?? [];
	assert.deepEqual(rows.map((row) => [row.job_id, row.use, row.decided_by, row.quote_sha]), [
		[covered, "dispatch", "operator-delegated", quoteSha(N3)],
		[covered, "promote", "operator-delegated", quoteSha(N3)],
		[negated, "dispatch", "operator-delegated", quoteSha(N3)],
	]);
	assert.ok(!JSON.stringify(rows).includes(N3), "audit rows carry the quote hash, never the quote");
	const shown = s.post.mandates.show(grant.id);
	assert.match(shown, /risk:high pre-approved \(dispatch\/promote only, never merge\)/);
	assert.match(shown, new RegExp(`dispatch ${covered} \\(operator-delegated\\)`));

	// A repeated pre-approval adds no authority; it never widens past a grant's jobs, outlives it, or skips issue.
	ends = await prompted(s, `${QUOTE} ${N3}`, [preapprove("again", grant.id, N3, [pushing]), preapprove("wider", narrow.id, QUOTE, [outside]), preapprove("dead", revoked.id, QUOTE)], [
		tool("issue", "cp_mandate", { action: "issue", projects: ["demo"], objective: "pre-approved at issue", job_cap: 20, risk_preapproval: { operator_quote: QUOTE } }),
	]);
	assert.notEqual(ends.get("again")?.isError, true, said(ends.get("again")));
	await s.refused(pushing, /refused before dispatch; .* raised, cp_decide it with an operator quote.*\(force push\)/, "Rebase, then force push to main.");
	assert.equal(ends.get("wider")?.isError, true);
	assert.match(said(ends.get("wider")), new RegExp(`does not cover ${outside}`));
	assert.equal(ends.get("dead")?.isError, true, said(ends.get("dead")));
	assert.notEqual(ends.get("issue")?.isError, true, said(ends.get("issue")));
	const issued = s.post.mandates.list().find((mandate) => mandate.objective === "pre-approved at issue");
	assert.equal(issued?.risk_preapproval?.operator_quote, QUOTE, "issue writes the pre-approval with the grant");
	// That pre-approval covers its projects' jobs created at or after the issue, never an older one.
	for (const id of [grant.id, wideSerial.id]) s.post.mandates.revoke(id);
	for (const jobId of [covered, negated, busy]) assert.equal((await s.post.tearDown(jobId, { force: true })).torn_down, true);
	const late = await s.job("late", "high");
	assert.equal((await s.accepted(late)).mandate_id, issued?.id);
	assert.deepEqual(s.post.mandates.require(String(issued?.id)).risk_preapproved?.map((row) => [row.job_id, row.use]), [[late, "dispatch"]]);
	await s.refused(other, ask);
});

test("authority: cp_escalate batch_risk_high files one approve/drop record for jobs one asking grant gates; every refusal writes nothing", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await stack(t, "auth-batch");
	const PROD = "Deploy to production.";
	const [labelled, rowB, rowC, plain, a, b, mixA, mixB, approved, risky] = [
		await s.job("labelled", "high"), await s.job("row b"), await s.job("row c"), await s.job("plain"), await s.job("a", "high"),
		await s.job("b", "high"), await s.job("mix a", "high"), await s.job("mix b", "high"), await s.job("approved"), await s.job("risky", "high"),
	];
	// Every grant exists before the first ask: a later issue would supersede the asks it replaces.
	const broad = s.issue([], { ask_on: ["risk:high"], channel: "bridge", job_cap: 50 });
	const selected = s.issue([a, b], { ask_on: ["risk:high"] });
	s.issue([mixA], { ask_on: ["risk:high"] });
	s.issue([mixB], { ask_on: ["risk:high"] });
	const ask = /risk:high under ask_on — refused before dispatch; (es-\S+) raised/;
	await s.refused(rowB, ask, PROD, { risk: "high", inputsFrom: "explicit" });
	for (const jobId of [rowC, approved]) await s.refused(jobId, ask, PROD);
	for (const jobId of [a, b, mixA]) await s.refused(jobId, ask);
	const first = s.post.escalations.list({ jobId: approved })[0]?.id as string;
	await s.post.escalations.answer(first, { answer: "approve", by: "operator-quote", basis: { operator_quote: `Approve ${first}.` } });
	const bytes = () => readFileSync(s.post.escalations.file, "utf8");
	const before = bytes();

	const batch = (id: string, job_ids: string[], mandate_id?: string) => tool(id, "cp_escalate", { action: "batch_risk_high", job_ids, ...(mandate_id ? { mandate_id } : {}) });
	const refusals: Array<[ReturnType<typeof tool>, RegExp]> = [
		[batch("one", [labelled]), /needs 2\.\.16 job ids, got 1|job_ids/],
		[batch("many", Array.from({ length: 17 }, (_, i) => `cp-x${i}`)), /got 17|job_ids/],
		[batch("twice", [labelled, labelled]), /duplicate job ids: /],
		[batch("unknown", [labelled, "cp-zzz9"]), /unknown job ids: cp-zzz9/],
		[batch("ungated", [labelled, plain]), new RegExp(`not risk:high gated .*${plain}`)],
		[batch("named", [rowB, rowC], "md-000000"), new RegExp(`asking mandate is ${broad.id}, not md-000000`)],
		[batch("overlap", [a, b], broad.id), new RegExp(`asking mandate is ${selected.id}`)],
		[batch("mixed", [mixA, mixB]), /one asking mandate must cover every job/],
		[batch("approved", [approved, risky]), new RegExp(`already approved: ${approved}`)],
	];
	let ends = await prompted(s, "Batch the risky jobs.", refusals.map(([call]) => call));
	for (const [call, pattern] of refusals) {
		assert.equal(ends.get(call.id)?.isError, true, `${call.id}: ${said(ends.get(call.id))}`);
		assert.match(said(ends.get(call.id)), pattern, call.id);
	}
	assert.equal(bytes(), before, "every refusal left escalations.json byte-identical");
	// tv8: a covering grant that does not ask lends no authority, even when another grant over the jobs does.
	s.post.mandates.save({ ...s.post.mandates.require(selected.id), ask_on: [] });
	ends = await prompted(s, "Batch the risky jobs.", [batch("silent", [a, b])]);
	assert.match(said(ends.get("silent")), new RegExp(`no active mandate with ask_on risk:high covers: ${a}, ${b}`));
	assert.equal(bytes(), before);
	s.post.mandates.save({ ...s.post.mandates.require(selected.id), ask_on: ["risk:high"] });

	ends = await prompted(s, "Batch the risky jobs.", [batch("valid", [rowC, labelled, rowB]), batch("pair", [a, b], selected.id)]);
	for (const id of ["valid", "pair"]) assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(ends.get(id))}`);
	const rows = s.post.escalations.open();
	const valid = rows.find((row) => row.job_ids.includes(labelled));
	assert.deepEqual(valid?.job_ids, [labelled, rowB, rowC].sort());
	assert.deepEqual([valid?.options.map((option) => option.id), valid?.recommended, valid?.kind, valid?.mandate_id], [["approve", "drop"], "drop", "risk_high_irreversible", broad.id]);
	assert.match(String(valid?.question), /^3 jobs risk:high under ask_on — approve all or drop all: /);
	const rowEvidence = /\(([^()]*)\)$/.exec(String(s.post.escalations.list({ jobId: rowB })[0]?.question))?.[1];
	assert.ok(rowEvidence?.includes("risk source: explicit"), String(rowEvidence));
	assert.ok(String(valid?.question).includes(`${rowB} (${rowEvidence})`), "the per-job row's evidence carries into the batch");
	assert.match(String(valid?.question), new RegExp(`${labelled} \\(risk:high label\\)`));
	assert.match(said(ends.get("valid")), /withdrew 2 per-job rows/);
	const pair = rows.find((row) => row.job_ids.includes(a));
	assert.equal(pair?.mandate_id, selected.id);
	assert.deepEqual(rows.map((row) => row.id).sort(), [valid?.id, pair?.id, s.post.escalations.list({ jobId: mixA })[0]?.id].sort(), "only the batches and the unbatched ask stay open");

	// One approve answers every listed job, under the grant that asked.
	for (const row of [valid, pair]) await s.post.escalations.answer(String(row?.id), { answer: "approve", by: "operator-quote", basis: { operator_quote: `Approve ${row?.id}.` } });
	assert.equal((await s.accepted(rowB, PROD)).mandate_id, broad.id);
	assert.equal((await s.accepted(a)).mandate_id, selected.id);
	assert.equal(s.post.escalations.list({ jobId: rowB }).filter((row) => row.status === "open").length, 0);
});

test("authority: dispatch picks the named, earliest-issued, lowest-id grant that speaks; a full named grant yields only to an eligible supplement", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await stack(t, "auth-select");
	const PAST = "2020-01-01T00:00:00Z";
	const base = { projects: ["demo"], objective: "selection", expiry: FAR, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 3, ask_on: [] as Mandate["ask_on"],
		allowed_actions: ["implement", "review", "repair", "merge"] as Mandate["allowed_actions"] };
	type Issue = Parameters<typeof s.post.mandates.issue>[0];
	const grant = (id: string, job_ids: string[], at: string, over: Partial<Issue> = {}) => s.post.mandates.issue({ ...base, id, at, ...(job_ids.length ? { job_ids } : {}), ...over });
	const edit = (id: string, over: Partial<Mandate>) => s.post.mandates.save({ ...s.post.mandates.require(id), ...over });
	const mandateOf = async (jobId: string, task = "Add a line to README.md.") => (await s.post.previewDispatch({ jobId, task, fetch: false })).mandate_id;
	let n = 0;
	const job = (risk?: "high", labels?: string[]) => s.job(`select ${(n += 1)}`, risk, labels ? { labels } : {});

	// No grant speaks: the latest refusing grant (file order) is named; a paused or other-project grant lends nothing.
	const [tieA, tieB, quiet] = [await job(), await job(), await job()];
	const expiredA = grant("md-tie1a", [tieA], "2026-10-07T00:00:00Z"), cappedA = grant("md-tie1b", [tieA], "2026-10-07T00:00:00Z");
	const cappedB = grant("md-tie2a", [tieB], "2026-10-07T00:00:00Z"), expiredB = grant("md-tie2b", [tieB], "2026-10-07T00:00:00Z");
	for (const id of [expiredA.id, expiredB.id]) edit(id, { expiry: PAST });
	for (const id of [cappedA.id, cappedB.id]) s.post.mandates.pause(id, "spend_cap");
	assert.equal(await mandateOf(tieA), cappedA.id);
	assert.equal(await mandateOf(tieB), expiredB.id);
	await s.refused(tieA, new RegExp(cappedA.id));
	s.post.mandates.pause(grant("md-quiet1", [quiet], "2026-10-07T00:00:00Z").id, "operator");
	grant("md-quiet2", [quiet], "2026-10-07T00:00:00Z", { projects: ["other"] });
	assert.equal(await mandateOf(quiet), undefined, "a silent or uncovering grant never acquires authority");

	// Named first, then earliest issued, then code-point id; empty names are project-wide.
	const broad = grant("md-000000", [], "2026-10-01T00:00:00Z", { job_cap: 100 });
	const [first, unnamed] = [await job(), await job()];
	const named = grant("md-a994c5", [first], "2026-10-07T00:00:00Z");
	grant("md-b994c5", [first], "2026-10-07T00:00:00Z");
	grant("md-000001", [first], "2026-10-08T00:00:00Z");
	assert.equal(await mandateOf(first), named.id);
	assert.equal((await s.accepted(first)).mandate_id, named.id);
	assert.equal(await mandateOf(unnamed), broad.id);
	// Coverage and standing come before precedence.
	const excluded: Array<[string, Partial<Issue>, Partial<Mandate>?]> = [["md-cov1", { job_ids: ["cp-other"] }], ["md-cov2", { projects: ["other"] }],
		["md-cov3", { exclusions: { job_kinds: ["ship"] } }], ["md-cov4", {}, { status: "paused" }], ["md-cov5", {}, { expiry: PAST }], ["md-cov6", { schedule_grant: true }]];
	for (const [id, over, after] of excluded) {
		const target = await job();
		grant(id, [target], "2026-10-02T00:00:00Z", over);
		if (after) edit(id, after);
		assert.equal(await mandateOf(target), broad.id, id);
	}
	// A scheduled job may speak only through the schedule-only grant its schedule names.
	const [scheduled, foreign] = [await job(undefined, ["schedule:sch-123abc"]), await job(undefined, ["schedule:sch-456def"])];
	const cron = grant("md-sched1", [scheduled, foreign], "2026-10-02T00:00:00Z", { schedule_grant: true });
	const schedule = (id: string, mandate_id: string) => ({ id, name: id, project: "demo", mandate_id, trigger: { type: "manual" }, enabled: true, created_at: "2026-01-01T00:00:00Z",
		job: { title: "Self-review", kind: "ship", delivery: "local" } });
	mkdirSync(join(s.home, LAYOUT.state), { recursive: true });
	writeFileSync(join(s.home, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule("sch-123abc", cron.id), schedule("sch-456def", "md-zzzz")] }));
	assert.equal(await mandateOf(scheduled), cron.id);
	assert.equal(await mandateOf(foreign), undefined);

	// A full named grant yields to the earliest eligible named supplement, for dispatch, cp_next and promotion alike.
	const counted = [await job(), await job(), await job()];
	const [target, firstEligible, skipFull, headroom, slot, shadowed] = [await job(), await job(), await job(), await job(), await job(), await job()];
	const variants = [await job(), await job(), await job(), await job(), await job(), await job(), await job(), await job(), await job()];
	const [riskAsked, riskApproved, weak] = [await job("high"), await job("high"), await job()];
	const older = grant("md-older1", [...counted, target, firstEligible, skipFull, headroom, ...variants, riskAsked, riskApproved, weak], "2026-10-08T12:00:00Z");
	const supplement = grant("md-supp01", [target], "2026-10-09T12:00:00Z");
	for (const jobId of counted) assert.equal((await s.accepted(jobId)).mandate_id, older.id, "room under the original keeps it");
	assert.equal(await mandateOf(target), supplement.id);
	const nextEnd = (await prompted(s, "What next?", [tool("next", "cp_next", { project: "demo", full: true })])).get("next");
	const next = (nextEnd?.result as { details?: NextResult } | undefined)?.details;
	const views = next ? [next, ...(next.others ?? [])] : [];
	const under = views.find((view) => view.mandate?.id === supplement.id);
	assert.deepEqual([under?.action.kind, under?.action.job_id], ["dispatch", target], `cp_next partitions the job under the supplement: ${said(nextEnd)}`);
	assert.ok(!views.some((view) => view.mandate?.id !== supplement.id && view.ready.some((job) => job.id === target)), "and under no other grant");
	assert.equal((await s.accepted(target)).mandate_id, supplement.id);
	grant("md-supp02", [firstEligible], "2026-10-09T12:00:00Z");
	grant("md-supp03", [firstEligible], "2026-10-09T13:00:00Z");
	grant("md-supp04", [skipFull, ...counted], "2026-10-09T12:00:00Z");
	const third = grant("md-supp05", [skipFull], "2026-10-09T13:00:00Z");
	assert.equal(await mandateOf(firstEligible), "md-supp02", "first eligible in sorted order");
	assert.equal(await mandateOf(skipFull), third.id, "a full supplement is skipped");
	const pausedOriginal = grant("md-older2", [shadowed, ...counted], "2026-10-08T12:00:00Z");
	s.post.mandates.pause(pausedOriginal.id, "spend_cap");
	const unshadowed = grant("md-supp06", [shadowed], "2026-10-09T12:00:00Z");
	assert.equal(await mandateOf(shadowed), unshadowed.id, "a cap-paused original never shadows");
	// An ineligible supplement leaves the original's job-cap refusal.
	// "@" stands for the variant job itself.
	const ineligible: Array<[Partial<Issue>, Partial<Mandate>?]> = [[{ job_ids: ["@", ...counted] }], [{ job_ids: [] }], [{ exclusions: { job_kinds: ["ship"] } }],
		[{}, { status: "paused", pause_reason: "operator" }], [{}, { status: "paused", pause_reason: "spend_cap" }], [{}, { status: "revoked" }],
		[{}, { expiry: PAST }], [{ schedule_grant: true }], [{ job_ids: ["cp-other"] }]];
	for (const [i, [over, after]] of ineligible.entries()) {
		const variant = variants[i] as string;
		const id = `md-inel${i}`;
		grant(id, [variant], "2026-10-09T12:00:00Z", { ...over, ...(over.job_ids ? { job_ids: over.job_ids.map((name) => (name === "@" ? variant : name)) } : {}) });
		if (after) edit(id, after);
		assert.equal(await mandateOf(variant), older.id, `${id} ${JSON.stringify([over, after])}`);
		await s.refused(variant, new RegExp(`${older.id} job cap 3 reached`));
	}

	// The current job is out of its own headroom: a cap-1 supplement keeps it for promotion after dispatch.
	const own = grant("md-supp07", [headroom], "2026-10-09T12:00:00Z", { job_cap: 1 });
	assert.equal((await s.accepted(headroom)).mandate_id, own.id);
	await promote(s, headroom);
	assert.match(s.post.mandates.show(own.id, liveUsageJobs(s.post.fleet, s.post.runs)), /job cap: 1 \/ 1/);

	// The selected supplement owns the risk ask, the pre-approval and its audit; the original's approval lends nothing.
	const pre = (job_ids: string[]) => ({ operator_quote: "Approve the risky work.", decided_by: "operator-quote" as const, scope: "named_jobs" as const, job_ids, granted_at: isoTimestamp() });
	edit(older.id, { ask_on: ["risk:high"] });
	s.post.mandates.preapproveRisk(older.id, pre([riskAsked, riskApproved]));
	const asking = grant("md-supp08", [riskAsked], "2026-10-09T12:00:00Z", { ask_on: ["risk:high"] });
	const approving = grant("md-supp09", [riskApproved], "2026-10-09T12:00:00Z", { ask_on: ["risk:high"] });
	s.post.mandates.preapproveRisk(approving.id, pre([riskApproved]));
	await s.refused(riskAsked, /risk:high under ask_on/);
	assert.equal(s.post.escalations.open().find((row) => row.job_ids.includes(riskAsked))?.mandate_id, asking.id);
	await s.refused(riskApproved, /hard stop/, "Delete production data, then add a line to README.md.");
	assert.equal((await s.accepted(riskApproved)).mandate_id, approving.id);
	assert.deepEqual(s.post.mandates.require(approving.id).risk_preapproved?.map((row) => [row.job_id, row.use]), [[riskApproved, "dispatch"]]);
	assert.equal(s.post.mandates.require(older.id).risk_preapproved, undefined);

	// A selected supplement's denial never falls back to a weaker grant issued after it.
	const strict = grant("md-supp10", [weak, slot], "2026-10-09T12:00:00Z", { dispatch_parallelism: 1 });
	grant("md-weak01", [weak], "2026-10-09T13:00:00Z");
	assert.equal((await s.accepted(slot)).mandate_id, strict.id);
	await s.refused(weak, new RegExp(`${strict.id}.*dispatch-parallelism 1 is full`));
	assert.equal((await s.post.tearDown(slot, { force: true })).torn_down, true);
	assert.equal((await s.accepted(weak)).mandate_id, strict.id);
	// cp_decide on the job's checkpoint reads the same selection: the supplement's refusal stands.
	s.post.checkpoints.request({ jobId: weak, question: "Authorize implementation?" });
	const decide = async (over: Partial<Mandate>, refusal: RegExp) => {
		edit(strict.id, over);
		const basis = { mandate: strict.id, clause: "allowed_actions includes implement for project demo" };
		const ends = await prompted(s, "Decide the checkpoint.", [tool("decide", "cp_decide", { target: `aw-checkpoint-${weak}`, decision: "approve", basis })]);
		assert.equal(ends.get("decide")?.isError, true, said(ends.get("decide")));
		assert.match(said(ends.get("decide")), refusal);
	};
	await decide({ allowed_actions: ["review"] }, new RegExp(`${strict.id}: implement is not an allowed action`));
	await decide({ allowed_actions: base.allowed_actions, ask_on: ["plan_approval"] }, new RegExp(`${strict.id}: ask_on includes plan_approval`));
	assert.equal(s.post.checkpoints.get(weak)?.decision, "pending");
	// Documented edge: an operator cap raise on the original returns selection to it.
	edit(older.id, { job_cap: 40, ask_on: [] });
	assert.equal(await mandateOf(firstEligible), older.id);
});

test("authority: live usage crosses each cap line once while the worker runs; cache reads and pre-grant usage never count; a USD cap or the ceiling is the operator's", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await stack(t, "auth-usage");
	// Each scripted model turn reports its usage, then its bash call waits for the test to open that turn's gate.
	const gates = mkdtempSync(join(tmpdir(), "cp-gates-"));
	t.after(() => rmSync(gates, { recursive: true, force: true }));
	type Usage = { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
	const gated = (name: string, usages: Usage[]) => s.provider.addScript(name, [
		...usages.map((usage, i) => ({ kind: "tool_calls" as const, usage, calls: [{ name: "bash", args: { command: `while [ ! -e ${gates}/${name}-${i} ]; do sleep 0.1; done` } }] })),
		{ kind: "text" as const, text: "done", usage: { prompt_tokens: 1, completion_tokens: 0 } },
		{ kind: "text" as const, text: "revived", usage: { prompt_tokens: 1, completion_tokens: 0 } },
		{ kind: "text" as const, text: "revived again", usage: { prompt_tokens: 1, completion_tokens: 0 } },
	]);
	const open = (name: string, i: number) => writeFileSync(join(gates, `${name}-${i}`), "");
	const tokens = (prompt_tokens: number, cached_tokens?: number) => ({ prompt_tokens, completion_tokens: 0, ...(cached_tokens ? { cached_tokens } : {}) });
	const notices = (grantId: string) => s.post.durableWakeups.pending().filter((entry) => entry.id.startsWith(`mandate-usage:${grantId}:`));
	const ids = (grantId: string) => notices(grantId).map((entry) => entry.id.split(":").at(-1));
	const until = (grantId: string, expected: string[]) =>
		waitFor(() => ids(grantId), (seen) => JSON.stringify(seen) === JSON.stringify(expected), { timeoutMs: 60_000, what: `${grantId} notices ${expected.join(", ")}` });
	const budgetAsks = () => s.post.escalations.list({ kind: "budget_exhausted" });
	const shown = (grantId: string) => s.post.mandates.show(grantId, liveUsageJobs(s.post.fleet, s.post.runs));

	// Tokens: 50M cache reads plus 7,000 non-cached says nothing; 80% warns once; the cap pauses once; the worker lives.
	const [live, spender, top] = [await s.job("live"), await s.job("spender"), await s.job("top")];
	const grant = s.issue([live], { tokens: 10_000 });
	const model = gated("tok", [tokens(50_007_000, 50_000_000), tokens(1_100), tokens(2_000), tokens(6_000), tokens(4_000)]);
	assert.equal(((await s.post.dispatch({ jobId: live, task: "Add a line to README.md.", model, fetch: false })) as { mandate_id?: string }).mandate_id, grant.id);
	await waitFor(() => shown(grant.id), (text) => /7000 \/ 10000 non-cached tokens/.test(text), { timeoutMs: 60_000, what: "the first turn's usage" });
	assert.deepEqual(ids(grant.id), [], "cache reads never count; 70% says nothing");
	open("tok", 0);
	await until(grant.id, ["warn-tokens"]);
	open("tok", 1);
	await until(grant.id, ["warn-tokens", "token-cap"]);
	const paused = s.post.mandates.require(grant.id);
	assert.deepEqual([paused.status, paused.pause_reason, paused.escalations.length], ["paused", "token_cap", 1]);
	assert.match(notices(grant.id)[1]?.content ?? "", /used 10100 \/ 10000 non-cached tokens.*\n.*in-flight worker continues.*raise_tokens/s);
	assert.ok(notices(grant.id).every((entry) => entry.keys === undefined), "keyed to the mandate, never staled by a torn-down job");
	assert.equal(s.record(live)?.phase, "waiting", "the in-flight worker is not killed");
	assert.deepEqual(budgetAsks(), [], "a token cap under the ceiling never asks the operator");

	// The parent raises the cap itself: the grant resumes and the next round notices afresh, once each.
	const raised = await prompted(s, "Raise the paused grant's token cap.", [
		tool("raise", "cp_mandate", { action: "raise_tokens", mandate_id: grant.id, spend_tokens: 20_000, reason: "one more round" }),
	]);
	assert.notEqual(raised.get("raise")?.isError, true, said(raised.get("raise")));
	assert.deepEqual([s.post.mandates.require(grant.id).status, s.post.mandates.require(grant.id).token_raises?.[0]?.reason], ["active", "one more round"]);
	// A project-wide grant issued over in-flight usage (cp_mandate issue's live view) counts only what follows.
	const wide = s.post.mandates.issue({ projects: ["demo"], objective: "the whole project", expiry: FAR, spend_cap: { usd: 100, tokens: 30_000 }, job_cap: 10 },
		liveUsageJobs(s.post.fleet, s.post.runs));
	assert.equal(wide.usage_baseline?.find((entry) => entry.job_id === live)?.tokens, 10_100);
	open("tok", 2);
	// The parent prompt above delivered the first two notices; what follows is the raised round's own.
	await until(grant.id, ["warn-tokens@20000"]);
	open("tok", 3);
	await until(grant.id, ["warn-tokens@20000", "token-cap@20000"]);
	// A crash mid-turn: bounded recovery relaunches the worker on the same observer, and its message repeats nothing.
	const midTurn = s.record(live)?.worker?.pid as number;
	process.kill(midTurn, "SIGKILL");
	await waitFor(() => s.record(live), (record) => record?.phase === "waiting" && record.worker?.pid !== midTurn, { timeoutMs: 60_000, what: "bounded recovery" });
	assert.equal(readEventLog(s.home, live).filter((event) => event.type === "worker_revived").length, 1);
	await waitFor(() => shown(wide.id), (text) => /; 10001 \/ 30000 non-cached tokens/.test(text), { timeoutMs: 60_000, what: "the closing turn's usage" });
	assert.equal(ids(grant.id).length, 2, "past the line, a turn that crosses nothing writes nothing");
	const repaused = s.post.mandates.require(grant.id);
	assert.deepEqual([repaused.status, repaused.pause_reason, repaused.escalations.length], ["paused", "token_cap", 1], "no duplicate budget escalation");
	assert.match(shown(wide.id), /; 10001 \/ 30000 non-cached tokens/);
	assert.match(shown(wide.id), /job cap: 1 \/ 10/);
	assert.deepEqual(ids(wide.id), []);
	// Crashed again after reporting nothing: cp_revive relaunches it on the same observer; its message repeats nothing.
	const crashed = s.record(live)?.worker?.pid as number;
	process.kill(crashed, "SIGKILL");
	await waitFor(() => s.record(live)?.phase, (phase) => phase === "failed", { timeoutMs: 60_000, what: "the crash to be observed" });
	assert.notEqual((await s.post.revive(live, { continueFailed: true })).pid, crashed);
	assert.equal((await s.post.send({ jobId: live, message: "Carry on." })).receipt, "delivered");
	await waitFor(() => s.post.runs.get(live)?.status.usage?.input ?? 0, (input) => input > 20_101, { timeoutMs: 60_000, what: "the revived worker's message" });
	assert.deepEqual(ids(grant.id), ["warn-tokens@20000", "token-cap@20000"], "a revived worker repeats no notice");
	assert.equal(s.post.mandates.require(grant.id).escalations.length, 1, "nor a budget escalation");
	// With the project-wide grant gone, promoting the idle worker under its token-capped grant is refused with the
	// parent's own raise hint (a dispatch's is pinned by 02-4).
	s.post.mandates.revoke(wide.id);
	let promotion = "";
	for (let attempt = 0; attempt < 200 && !promotion; attempt += 1) {
		promotion = await s.post.send({ jobId: live, message: "Next: add another line.", task: "Add another line to README.md.", mode: "prompt" })
			.then(() => "delivered", (error: Error) => (/busy worker/.test(error.message) ? "" : error.message));
		if (!promotion) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.match(promotion, new RegExp(`${grant.id} is paused \\(token_cap\\).*raise it yourself: cp_mandate raise_tokens ${grant.id}`));
	assert.equal((await s.post.tearDown(live, { force: true })).torn_down, true);
	assert.equal(ids(grant.id).length, 2, "the notices survive the job's teardown");

	// USD crosses on its own, and its cap is always the operator's: one budget_exhausted ask.
	const dollars = s.issue([spender], { usd: 1, tokens: 50_000_000 });
	const usd = gated("usd", [tokens(850), tokens(200)]);
	s.agentDir.writeModels(s.provider);
	const models = join(s.agentDir.path, "models.json");
	const config = JSON.parse(readFileSync(models, "utf8"));
	// $1,000 per million input tokens: 850 tokens is $0.85.
	for (const entry of config.providers.mock.models) if (entry.id === s.provider.modelId("usd")) entry.cost = { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 };
	writeFileSync(models, JSON.stringify(config));
	await s.post.dispatch({ jobId: spender, task: "Add a line to README.md.", model: usd, fetch: false });
	await until(dollars.id, ["warn-usd"]);
	open("usd", 0);
	await until(dollars.id, ["warn-usd", "cap"]);
	assert.equal(s.post.mandates.require(dollars.id).pause_reason, "spend_cap");
	await waitFor(budgetAsks, (rows) => rows.length === 1, { what: "the USD cap's operator ask" });

	// At the home's token ceiling the cap is the operator's too.
	const ceiling = await prompted(s, "Set the token ceiling.", [tool("ceiling", "cp_mandate", { action: "defaults_set", key: "token_ceiling", value: "1000" })]);
	assert.notEqual(ceiling.get("ceiling")?.isError, true, said(ceiling.get("ceiling")));
	const capped = s.issue([top], { tokens: 1_000 });
	await s.post.dispatch({ jobId: top, task: "Add a line to README.md.", model: gated("top", [tokens(1_000)]), fetch: false });
	await waitFor(() => notices(capped.id).at(-1)?.content ?? "", (text) => /TOKEN CEILING/.test(text), { timeoutMs: 60_000, what: "the ceiling notice" });
	await waitFor(budgetAsks, (rows) => rows.length === 2, { what: "the ceiling's operator ask" });
	for (const name of ["usd-1", "top-0"]) writeFileSync(join(gates, name), "");
});

test("authority: the gateway's admin capacity and quota windows steer and annotate routing; every failure falls back and never leaks the key", { timeout: 120_000 }, async (t) => {
	const KEY = "private-key";
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	t.after(() => { repo.cleanup(); home.cleanup(); });
	initJobsDocument(home.path, "cp");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const rubric = [{ id: "implementer", role: "implementer", model: "mock/a", fallbacks: ["other/b"] }];
	writeFileSync(join(home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", "other/*"], rubric }));
	const configure = (over: object = {}) =>
		writeFileSync(join(home.path, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.test", path: "/api/admin/capacity", ...over }));
	configure();
	// The gateway is an external service, like the LLM: one fetch stub stands in for it, keyed by path.
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const row = (max: number, used: number, queued: number) => ({ current_in_use: used, max_capacity: max, load_percentage: 0, waiting_in_queue: queued });
	const snapshot = (platform: object, extra: object = {}) => ({ code: 0, message: "success", data: { account: {}, group: {}, enabled: true, timestamp: "2026-09-25T00:00:00.330580943Z", platform, ...extra } });
	const account = (id: number, platform = "mock", extra = {}) => ({ id, platform, type: "oauth", status: "active", schedulable: true, temp_unschedulable_until: null, overload_until: null, ...extra });
	const windows = (five: number, seven: number) => ({ code: 0, data: { five_hour: { utilization: five }, seven_day: { utilization: seven } } });
	type Reply = (signal?: AbortSignal | null) => unknown;
	let capacity: Reply = () => snapshot({ mock: row(8, 2, 0), other: row(20, 19, 1) });
	let accounts: Reply = () => ({ code: 0, data: { items: [] } });
	let usage: (id: string) => unknown = () => windows(0, 0);
	const calls: Array<{ path: string; method?: string; key: string | null; auth: boolean }> = [];
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		calls.push({ path: `${url.origin}${url.pathname}${url.search}`, method: init?.method, key: headers.get("x-api-key"), auth: headers.has("Authorization") });
		const reply = url.pathname === "/api/admin/capacity" ? capacity(init?.signal)
			: url.pathname === "/api/v1/admin/accounts" ? accounts(init?.signal) : usage(url.pathname.split("/").at(-2) as string);
		return reply instanceof Response ? reply : Response.json(await reply);
	}) as typeof fetch;
	const commandPost = (env: NodeJS.ProcessEnv) => {
		const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: env });
		t.after(() => post.shutdown());
		return post;
	};
	const keyed = commandPost({ CP_GATEWAY_ADMIN_KEY: KEY });
	await keyed.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	const job = (await keyed.ledger().create({ title: "route", project: "demo", delivery: "local", kind: "ship" })).id;
	const route = async (post = keyed) => {
		const preview = await post.previewDispatch({ jobId: job, task: "Add a line to README.md.", fetch: false });
		assert.equal(preview.error, undefined);
		assert.ok(!JSON.stringify(preview).includes(KEY), "no routing fact carries the admin key");
		return { model: preview.decision?.model, line: String(preview.line), quota: preview.decision?.quota, capacity: preview.decision?.capacity };
	};
	const fresh = () => { now += 60_000; };
	const quotaCalls = () => calls.filter((call) => call.path.includes("/api/v1/")).length;

	// Admin numbers: free slots per provider; a tight quota window steers off a provider that still has free slots.
	accounts = () => ({ code: 0, data: { items: [
		account(1), account(2, "mock", { schedulable: false }), account(3, "grok"), account(4, "mock", { type: "apikey" }), account(5, "other"),
		account(6, "mock", { overload_until: "2000-01-01T00:00:00Z" }), account(7, "mock", { status: "disabled" }),
		account(8, "mock", { overload_until: "2999-01-01T00:00:00Z" }), account(9, "mock", { temp_unschedulable_until: "2999-01-01T00:00:00Z" }),
	] } });
	usage = (id) => (id === "1" ? windows(2, 86) : id === "6" ? windows(95, 20) : windows(0, 11));
	const [first, concurrent] = await Promise.all([route(), route()]);
	assert.deepEqual(concurrent, first, "concurrent dispatches share one quota snapshot");
	assert.match(first.line, /quota=mock:5h=2,7d=86\(tight\),other:5h=n\/a,7d=11/);
	assert.match(first.line, /capacity=admin:mock=6,other=0/);
	assert.equal(first.model, "other/b");
	assert.deepEqual(first.quota, { balance_margin: 10, providers: [{ provider: "mock", seven_day: 86, five_hour: 2, tight: true }, { provider: "other", seven_day: 11, tight: false }] });
	await route();
	assert.deepEqual(calls.filter((call) => call.path.includes("/api/v1/")).map((call) => call.path).sort(), [
		"https://gateway.test/api/v1/admin/accounts/1/usage", "https://gateway.test/api/v1/admin/accounts/5/usage",
		"https://gateway.test/api/v1/admin/accounts/6/usage", "https://gateway.test/api/v1/admin/accounts?page=1&page_size=50",
	], "eligible accounts only, read once per 60 s");
	assert.ok(calls.every((call) => call.method === "GET" && call.key === KEY && !call.auth), "x-api-key only, never Authorization");
	assert.equal(calls.filter((call) => call.path.endsWith("/api/admin/capacity")).length, 3, "capacity is read live on every route");
	now += 59_999;
	await route();
	assert.equal(quotaCalls(), 4);
	now += 1;
	await route();
	assert.equal(quotaCalls(), 8, "the snapshot refreshes after 60 s");
	// Free admin slots win in rubric order once no window is tight.
	fresh();
	usage = () => windows(0, 11);
	assert.equal((await route()).model, "mock/a");
	capacity = () => snapshot({ mock: row(8, 8, 0), other: row(20, 10, 0) });
	assert.equal((await route()).model, "other/b");

	// An unreported 5h window leaves the account on 7d alone; a real 0/0 stays real; thresholds include their bound.
	accounts = () => ({ code: 0, data: { items: [account(1, "other")] } });
	for (const [five, seven, shown] of [[0, 11, "5h=n/a,7d=11"], [0, 90, "5h=n/a,7d=90(tight)"], [2, 86, "5h=2,7d=86(tight)"], [0, 0, "5h=0,7d=0"],
		[90, 0, "5h=90,7d=0(tight)"], [89, 84, "5h=89,7d=84"], [0, 85, "5h=n/a,7d=85(tight)"], [101, 0, "unknown"]] as const) {
		fresh();
		usage = () => windows(five, seven);
		assert.match((await route()).line, new RegExp(`quota=mock:unknown,other:${shown.replace(/[()]/g, "\\$&")}( |$)`), `${five}/${seven}`);
	}
	// A list is complete only when its total confirms it, or it is short of a page; an uncertain one reads no usage.
	for (const [count, total, complete] of [[50, 50, true], [49, undefined, true], [49, 49, true], [50, undefined, false], [50, 51, false],
		[49, 50, false], [50, 49, false], [50, "50", false], [50, null, false]] as const) {
		fresh();
		const before = quotaCalls();
		accounts = () => ({ code: 0, data: { items: Array.from({ length: count }, (_, id) => account(id + 1)), ...(total === undefined ? {} : { total }) } });
		usage = () => windows(2, 11);
		assert.match((await route()).line, complete ? /quota=mock:5h=2,7d=11,other:unknown/ : /quota unavailable: unreadable/, `${count}/${total}`);
		assert.equal(quotaCalls() - before, complete ? count + 1 : 1, "uncertain lists query no account usage");
	}
	// Unsupported shapes and API-key accounts are unknown; custom thresholds apply.
	fresh();
	configure({ quota: { five_hour: 95, seven_day: 90 } });
	accounts = () => ({ code: 0, data: { items: [account(1), account(2, "other", { type: "apikey" }), account(3, "other")] } });
	usage = (id) => (id === "1" ? windows(2, 86) : { code: 0, data: { tokens: 10 } });
	assert.match((await route()).line, /quota=mock:5h=2,7d=86,other:unknown/);

	// Every failure is named, never the key: a rejected credential, an unreadable reply, a total timeout.
	configure();
	// Two live workers on the mock provider: the fleet fallback counts them.
	const at = isoTimestamp();
	await keyed.fleet.add({ job_id: "cp-live1", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "waiting", worker: { pid: 1, session_id: "s", session_file: "/none.jsonl", profile: "implementer", role: "implementer", model: "mock/a", started_at: at }, worktree: "/wt", branch: "cp-live1", dispatched_at: at, usage: EMPTY_USAGE });
	await keyed.fleet.add({ ...keyed.fleet.require("cp-live1"), job_id: "cp-live2", branch: "cp-live2" });
	for (const [reply, quota, fallback] of [
		[() => new Response(KEY, { status: 401 }), "quota unavailable: auth rejected", "capacity=fleet:mock=-2,other=0 reason=capacity auth rejected"],
		[() => new Response(KEY, { status: 503 }), "quota unavailable: unreadable", "capacity=fleet:mock=-2,other=0"],
	] as const) {
		fresh();
		capacity = reply; accounts = reply;
		const routed = await route();
		assert.ok(routed.line.includes(quota) && routed.line.includes(fallback), routed.line);
		assert.equal(routed.model, "other/b", "fleet counts prefer the provider with fewer live workers");
	}
	fresh();
	accounts = () => new Promise(() => {});
	capacity = (signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error(`${KEY} timeout`))));
	assert.match((await route()).line, /quota unavailable: timeout capacity=fleet:mock=-2,other=0($| )/);
	// Malformed capacity snapshots fall back to fleet counts and say so; a thrown fetch falls back silently.
	accounts = () => ({ code: 0, data: { items: [] } });
	for (const body of [
		snapshot({ mock: row(8, 0, 0) }), snapshot({ mock: row(8, 0, 0), other: row(20, 0, 0) }, { enabled: false }),
		snapshot({ mock: row(8, 0, 0), other: row(20, 0, 0) }, { timestamp: "bad" }), snapshot({ mock: row(8, -1, 0), other: row(20, 0, 0) }),
		{ code: 0, enabled: true, timestamp: "2026-09-25T00:00:00Z", platforms: { mock: { free_slots: 6 }, other: { free_slots: 0 } } },
		{ ...snapshot({ mock: row(8, 2, 0), other: row(20, 19, 1) }), code: 1 },
	]) {
		capacity = () => body;
		assert.match((await route()).line, /capacity=fleet:mock=-2,other=0 reason=capacity response unreadable/, JSON.stringify(body));
	}
	capacity = () => { throw new Error(`${KEY} failed`); };
	assert.match((await route()).line, /capacity=fleet:mock=-2,other=0($| )/);

	// Malformed configuration is refused before any request leaves; no key means no request and no capacity at all.
	for (const over of [{ quota: { five_hour: -1 } }, { quota: { seven_day: 101 } }, { quota: { five_hour: "90" } }, { quota: { weekly: 85 } },
		{ quota: { balance_margin: "10" } }, { quota: { balance_margin: true } }, { quota: { balance_margin: {} } },
		{ url: "http://gateway.test" }, { admin_key: KEY }, { url: `https://${KEY}@gateway.test` }]) {
		fresh();
		configure(over);
		const before = calls.length;
		assert.match((await route()).line, /quota unavailable: unreadable capacity=fleet:mock=-2,other=0($| )/, JSON.stringify(over));
		assert.equal(calls.length, before, `${JSON.stringify(over)} reached the gateway`);
	}
	// cp-u3i2: a legacy top-level data/capacity.json alone is not config.
	rmSync(join(home.path, LAYOUT.data, "capacity.json"));
	mkdirSync(join(home.path, "data"), { recursive: true });
	writeFileSync(join(home.path, "data", "capacity.json"), JSON.stringify({ url: "https://gateway.test", path: "/api/admin/capacity" }));
	fresh();
	const legacy = calls.length;
	assert.match((await route()).line, /quota unavailable: unreadable capacity=fleet:mock=-2,other=0($| )/);
	assert.equal(calls.length, legacy, "the legacy file reached nothing");
	configure();
	const before = calls.length;
	const unkeyed = await route(commandPost({ CP_GATEWAY_ADMIN_KEY: "" }));
	assert.match(unkeyed.line, /quota=off:no admin key/);
	assert.equal(unkeyed.capacity, undefined, "no key: no capacity scores, rubric order stands");
	assert.equal(unkeyed.model, "mock/a");
	assert.equal(calls.length, before, "no key, no request");
});
