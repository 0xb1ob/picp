/**
 * Behavior 02: mandate, budgets and authority, through a real CommandPost dispatch, real implementer workers on a
 * treehouse pool and a mock LLM. Every refusal is checked to start nothing: no fleet record, no provider request.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, type Mandate, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { liveUsageJobs } from "../../src/mandate-usage.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
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
	const dispatch = (jobId: string, task = "Add a line to README.md.") => post.dispatch({ jobId, task, fetch: false });
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
		issue: (job_ids: string[], over: { ask_on?: ("merge" | "risk:high")[]; job_cap?: number; tokens?: number; expiry?: string; dispatch_parallelism?: number; channel?: "bridge" } = {}) =>
			post.mandates.issue({
				projects: ["demo"],
				objective: "authority e2e",
				expiry: over.expiry ?? FAR,
				spend_cap: { usd: 100, tokens: over.tokens ?? 10_000_000 },
				job_cap: over.job_cap ?? 10,
				ask_on: over.ask_on ?? [],
				...(job_ids.length ? { job_ids } : {}),
				...(over.dispatch_parallelism ? { dispatch_parallelism: over.dispatch_parallelism } : {}),
				...(over.channel ? { channel: over.channel } : {}),
			}),
		provider,
		/** An accepted dispatch reaches the provider through a live worker. */
		accepted: async (jobId: string) => {
			const result = await dispatch(jobId);
			assert.equal(result.receipt, "accepted");
			await waitFor(() => requests(jobId), (n: number) => n > 0, { timeoutMs: 60_000, what: `${jobId}'s worker asking the model` });
			return { mandate_id: "mandate_id" in result ? result.mandate_id : undefined, budget: record(jobId)?.budget };
		},
		/** A refused dispatch writes no fleet record and spends no model request; returns the refusal text. */
		refused: async (jobId: string, pattern: RegExp, task?: string) => {
			let message = "";
			await assert.rejects(dispatch(jobId, task), (error: Error) => ((message = error.message), pattern.test(message)));
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

	// A failed job's re-dispatch meets its own leftover branch in preflight, before any resource check: never a
	// self-conflict. The operator path tears it down first, and a torn-down record holds no lease. The direct
	// recordRecoveryAttempt spends the one automatic attempt: only a real death spends it, and that death would revive.
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
	"Doctor incorrectly calls the live .beads tracker database 'a frozen archive, safe to delete'. The bead body is authoritative for acceptance.",
	"stop advising users to delete .beads",
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
	["stop advising deletion and delete the .beads directory"],
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
