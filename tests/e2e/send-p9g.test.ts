/**
 * Behavior 11 (P9g): cp_send through a real CommandPost and real implementer workers on a treehouse pool — receipts by
 * worker state, promotions that reopen a report and replace the frozen task, plan-conversation guards and the grants.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { decideGate } from "../../src/gate.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { decisionReviseAt } from "../../src/plan-followup.ts";
import type { SendRequest } from "../../src/send.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readRunEvents,
	readRunStatus,
	REPO_ROOT,
	type RecordedRequest,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "send-p9g e2e needs treehouse on PATH";
const TEXT: ScriptStep = { kind: "text", text: "on it" };
const SLOW: ScriptStep = { kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 6 && echo slept" } }] };
const POLICY_MARKER = JSON.stringify({ type: "custom", customType: "worker-compaction-policy-block", data: { errorMessage: "content_filter" } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (jobId: string, envelope: Record<string, unknown>): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: jobId, kind: "ship", ...envelope } }] });

async function bench(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agentDir.env } });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: 4 });
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// pool root is removed next
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	const lastUser = (request: RecordedRequest): string => {
		const content = (request.body.messages ?? []).filter((message) => message.role === "user").at(-1)?.content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
	};
	const f = {
		home: home.path,
		post,
		provider,
		head: repo.head(),
		/** Creates and dispatches a ship/local job whose worker runs `steps` (the last one repeats). */
		async dispatch(slug: string, steps: (jobId: string) => ScriptStep[], task = "Work."): Promise<string> {
			const jobId = (await post.ledger().create({ title: slug, project: "demo", delivery: "local", kind: "ship", slug })).id;
			const model = provider.addScript(slug, steps(jobId), { onExhausted: "repeat" });
			agentDir.writeModels(provider);
			await post.dispatch({ jobId, task, model, fetch: false });
			return jobId;
		},
		events(jobId: string, type: string): Array<Record<string, unknown>> {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "cp" && event.type === type).map((event) => (event.payload ?? {}) as Record<string, unknown>);
		},
		prompts: (slug: string) => provider.requests(slug).map(lastUser),
		worker: (jobId: string) => post.manager.get(jobId)?.worker,
		/** Waits until `slug`'s worker answered `requests` model calls and stays idle (a report nudge is one call). */
		async idle(jobId: string, slug: string, requests: number): Promise<void> {
			await waitFor(() => provider.requests(slug).length, (n) => n >= requests, { timeoutMs: 60_000, what: `${requests} model calls for ${slug}` });
			await waitFor(() => post.manager.get(jobId)?.worker.busy, (busy) => busy === false, { timeoutMs: 30_000, what: `${slug} idle` });
			await pause(500);
			assert.equal(provider.requests(slug).length, requests, `${slug} made no further call`);
		},
		original: (jobId: string) => readFileSync(join(home.path, paths.originalTaskFile(jobId)), "utf8"),
		archived: (jobId: string, generation: number) => join(home.path, paths.supersededOriginalTaskFile(jobId, generation)),
	};
	return f;
}

const refusal = (pattern: RegExp) => (error: Error) => pattern.test(error.message);

test("P9g-send-promote: an idle worker takes a promote with its addenda, refuses an idle steer, records each task generation and refuses what is not its own", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("promote", () => [TEXT], "Original scope.");
	await f.idle(jobId, "promote", 2);
	const frozen = f.original(jobId);
	assert.match(frozen, /Original scope\./);
	const row = { schema_version: 1, n: 1, added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: "Implement the additional requirement." };
	writeFileSync(join(f.home, paths.taskAddendaFile(jobId)), `${JSON.stringify(row)}\n`);
	const sentBefore = f.events(jobId, "prompt_sent").length;

	const first = await f.post.send({ jobId, message: "Continue the job." });
	assert.deepEqual([first.receipt, first.mode, first.busy_before, first.task_updated], ["delivered", "prompt", false, undefined]);
	await f.idle(jobId, "promote", 4);
	const brief = f.prompts("promote")[2] ?? "";
	for (const part of [/Continue the job\./, /Implement the additional requirement\./, /Addendum 1 \(operator-quote, 2026-09-24T10:00:00Z\)/, /Quote: "approved"/]) assert.match(brief, part);
	assert.equal(f.original(jobId), frozen, "an addendum rides on the brief, never replaces the frozen task");
	const delivered = f.events(jobId, "prompt_sent").slice(sentBefore);
	assert.deepEqual(delivered.map((payload) => [payload.receipt, payload.disposition, payload.wall_clock_rearmed]), [["delivered", "started", true]],
		"one marker, and an idle prompt starts a fresh wall-clock round");

	// cp-send-idle-steer: no running turn would ever flush an idle steer or follow_up.
	await assert.rejects(f.post.send({ jobId, message: "also check the tests", mode: "steer" }),
		(error: Error) => /is idle, not mid-turn/.test(error.message) && /"steer"/.test(error.message) && /mode: "prompt"/.test(error.message));
	await assert.rejects(f.post.send({ jobId, message: "also update the README", mode: "follow_up" }), refusal(/"follow_up"/));
	assert.deepEqual([f.events(jobId, "steer_sent").length, f.events(jobId, "follow_up_sent").length, f.prompts("promote").length], [0, 0, 4]);

	// cp-promote-task-record: each promotion's task is a new generation; every prior text is archived.
	const grown = "Bump x to 2 AND update the README.";
	const g1 = await f.post.send({ jobId, message: "scope grew: also update the README", task: grown });
	assert.deepEqual([g1.receipt, g1.mode, g1.task_updated?.generation, g1.task_updated?.source], ["delivered", "prompt", 1, "task"]);
	assert.equal(f.original(jobId), grown);
	assert.equal(readFileSync(f.archived(jobId, 1), "utf8"), frozen, "the prior task text survives, archived");
	assert.equal(f.post.fleet.require(jobId).task_generations, 1);
	await f.idle(jobId, "promote", 6);
	const dir = mkdtempSync(join(tmpdir(), "cp-send-task-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, "Bump x to 2, update the README, and add a changelog entry.");
	const model = f.post.fleet.require(jobId).worker.model;
	const g2 = await f.post.send({ jobId, message: "one more scope change", taskFile: relative(process.cwd(), taskFile), model });
	assert.deepEqual([g2.receipt, g2.task_updated?.generation, g2.task_updated?.source], ["delivered", 2, "task_file"]);
	assert.equal(f.original(jobId), "Bump x to 2, update the README, and add a changelog entry.");
	assert.equal(readFileSync(f.archived(jobId, 2), "utf8"), grown, "generation 1's text is kept too");
	assert.equal(f.post.fleet.require(jobId).task_generations, 2);
	assert.equal(f.events(jobId, "original_task_updated").length, 2, "one journal entry per replacement");
	await f.idle(jobId, "promote", 8);

	// The ported promote rules: same model, live jobs, live workers; nothing reaches the model.
	await assert.rejects(f.post.send({ jobId, message: "   " }), /empty message/);
	await assert.rejects(f.post.send({ jobId: "cp-unknown", message: "hi" }), /no fleet record/);
	await assert.rejects(f.post.send({ jobId, message: "hi", model: "mock/other" }), /cross-model role hop is teardown \+ fresh dispatch/);
	await f.post.fleet.patch(jobId, { phase: "done", closed_at: isoTimestamp() });
	await assert.rejects(f.post.send({ jobId, message: "hi" }), /nothing to promote/);
	await f.post.fleet.patch(jobId, { phase: "waiting" });
	await f.post.manager.shutdown(jobId);
	await assert.rejects(f.post.send({ jobId, message: "hi" }), (error: Error) =>
		/has no live worker in this session/.test(error.message) && new RegExp(`cp_revive ${jobId}`).test(error.message));
	assert.equal(f.prompts("promote").length, 8);
});

test("P9g-send-busy: a busy worker's auto send steers and queues, and no steer, follow_up or busy prompt changes scope", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("busy", () => [SLOW, TEXT], "Original scope.");
	await waitFor(() => readRunEvents(f.home, jobId).filter((event) => event.source === "pi" && event.type === "tool_execution_start").length,
		(n) => n === 1, { timeoutMs: 60_000, what: "the slow bash call" });
	assert.equal(f.worker(jobId)?.busy, true);
	const frozen = f.original(jobId);
	const original = join(f.home, paths.originalTaskFile(jobId));

	await assert.rejects(f.post.send({ jobId, message: "also check the tests", mode: "steer", task: "A different job entirely." }),
		(error: Error) => /only accepted with a promotion/.test(error.message) && /resolved to "steer"/.test(error.message));
	await assert.rejects(f.post.send({ jobId, message: "also this", task: "Yet another job." }), /only accepted with a promotion/);
	await assert.rejects(f.post.send({ jobId, message: "afterwards", mode: "follow_up", taskFile: original }), /only accepted with a promotion/);
	await assert.rejects(f.post.send({ jobId, message: "scope change", mode: "prompt", task: "A different job entirely." }), (error: Error) =>
		/only accepted with a promotion of an idle worker/.test(error.message) && /resolved to "prompt"/.test(error.message) && /busy worker/.test(error.message));
	assert.deepEqual([f.original(jobId), f.post.fleet.require(jobId).task_generations, f.events(jobId, "original_task_updated").length], [frozen, undefined, 0],
		"no refused attempt mutated the frozen task");

	const steered = await f.post.send({ jobId, message: "also check the tests" });
	assert.deepEqual([steered.mode, steered.receipt, steered.busy_before], ["steer", "queued", true], "auto mode steers a busy worker");
	const followUp = await f.post.send({ jobId, message: "afterwards, update the README", mode: "follow_up" });
	assert.equal(followUp.receipt, "queued");
	assert.deepEqual(f.events(jobId, "steer_sent").map((payload) => [payload.disposition, payload.wall_clock_rearmed]), [["queued", undefined]]);
	assert.deepEqual(f.events(jobId, "follow_up_sent").map((payload) => payload.wall_clock_rearmed), [undefined], "queued messages never restart the wall clock");
	const bare = await f.post.send({ jobId, message: "bare prompt", mode: "prompt" });
	assert.deepEqual([bare.receipt, Boolean(bare.error)], ["failed", true], "pi refuses a bare prompt while streaming; the receipt says so");
	assert.deepEqual(f.events(jobId, "prompt_sent").filter((payload) => payload.receipt === "failed").map((payload) => payload.wall_clock_rearmed), [undefined],
		"the refused prompt is logged and never restarts the wall clock");
});

test("P9g-send-held: a held worker refuses an idle follow_up, a promote reopens its report and the next one supersedes it; a landed job refuses, a handed-off PR reopens", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("held", (id) => [
		report(id, { status: "blocked", summary: "Blocked: the migration needs owner sign-off.", blockers: ["migration needs owner sign-off"] }),
		report(id, { status: "done", summary: "Stage A implemented, committed and pushed.", branch: id, head_sha: f.head }),
	]);
	await waitFor(() => f.post.fleet.require(jobId), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the blocked envelope" });
	await f.idle(jobId, "held", 1);
	await assert.rejects(f.post.send({ jobId, message: "sign-off is in", mode: "follow_up" }), /is idle, not mid-turn/);
	assert.deepEqual([f.post.fleet.require(jobId).phase, f.post.fleet.require(jobId).supersessions], ["held", undefined], "refused before any reopen");

	const promote = await f.post.send({ jobId, message: "sign-off is in — implement Stage A and report it" });
	assert.deepEqual([promote.receipt, promote.superseded?.generation, promote.superseded?.prior_status], ["delivered", 1, "blocked"]);
	await waitFor(() => f.events(jobId, "envelope_received").length, (n) => n === 2, { timeoutMs: 60_000, what: "the superseding envelope accepted" });
	const reported = f.post.fleet.require(jobId);
	assert.deepEqual([reported.phase, Boolean(reported.reported_at), reported.supersessions], ["held", true, 1]);
	assert.ok(existsSync(join(f.home, paths.supersededEnvelopeFile(jobId, 1))), "the blocked envelope is kept, not destroyed");
	assert.deepEqual(readRunEvents(f.home, jobId).filter((event) => event.source === "cp" && event.type.startsWith("envelope_")).map((event) => event.type),
		["envelope_received", "envelope_superseded", "envelope_received"], "one envelope per generation, the supersession between them");
	assert.equal(readRunStatus(f.home, jobId).reported, true);

	// A landed delivery is refused, never silently reopened.
	await f.post.fleet.patch(jobId, { receipts: [{ kind: "pr", status: "merged", title: `PR for ${jobId}`, url: "https://github.com/o/r/pull/22" }] });
	const sent = f.events(jobId, "prompt_sent").length;
	await assert.rejects(f.post.send({ jobId, message: "one more thing while you are there" }), (error: Error) =>
		/landed delivery/.test(error.message) && new RegExp(`cp_teardown ${jobId}`).test(error.message) && /cp_dispatch a new job id/.test(error.message));
	assert.deepEqual([f.post.fleet.require(jobId).phase, f.post.fleet.require(jobId).supersessions, f.events(jobId, "envelope_superseded").length, f.events(jobId, "prompt_sent").length],
		["held", 1, 1, sent], "refused means nothing happened");
	assert.ok(existsSync(join(f.home, paths.envelopeFile(jobId))));

	// human_handoff: a change request on the open PR reopens the same job on its branch.
	const handed = await f.dispatch("handoff", (id) => [report(id, { status: "done", summary: "Pushed and opened the PR.", branch: id, head_sha: f.head }), TEXT]);
	await waitFor(() => f.post.fleet.require(handed), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the handoff envelope" });
	await f.idle(handed, "handoff", 1);
	await f.post.fleet.patch(handed, { delivery: "pr", receipts: [{ kind: "pr", status: "open", title: `PR for ${handed}`, url: "https://github.com/example/example-app/pull/1" }] });
	const change = await f.post.send({ jobId: handed, message: "the reviewer asked for a rename — push it and report" });
	assert.deepEqual([change.receipt, change.superseded?.generation], ["delivered", 1], "the change request reopens the envelope");
	const reopened = f.post.fleet.require(handed);
	assert.deepEqual([reopened.phase, reopened.branch, f.post.fleet.list().map((job) => job.job_id).sort()], ["waiting", handed, [jobId, handed].sort()], "same branch, no new job");
	await f.idle(handed, "handoff", 3);
	await f.post.manager.shutdown(handed);
	await assert.rejects(f.post.send({ jobId: handed, message: "one more change" }), /no live worker in this session[\s\S]*revive/);
});

test("P9g-send-continue: a send to a failed job names continue_failed; the continued worker's report supersedes the accepted envelope", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("cont", (id) => [
		report(id, { status: "blocked", summary: "Blocked: needs a hand.", blockers: ["needs a hand"] }),
		report(id, { status: "done", summary: "Continued and pushed.", branch: id, head_sha: f.head }),
	]);
	await waitFor(() => f.post.fleet.require(jobId), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the blocked envelope" });
	await f.idle(jobId, "cont", 1);
	const before = f.post.fleet.require(jobId);
	await f.post.manager.shutdown(jobId);
	await f.post.fleet.markFailed(jobId, { class: "crash", message: "worker exited 137", at: isoTimestamp() });
	await assert.rejects(f.post.send({ jobId, message: "carry on" }), (error: Error) =>
		new RegExp(`cp_revive ${jobId} continue_failed:true`).test(error.message) && /never a takeover job/.test(error.message));

	const revived = await f.post.revive(jobId, { continueFailed: true });
	assert.equal(revived.session_file, before.worker.session_file);
	const continued = f.post.fleet.require(jobId);
	assert.deepEqual([continued.phase, continued.failure, Boolean(continued.reported_at)], ["waiting", undefined, true], "continuation keeps the accepted envelope");
	const promote = await f.post.send({ jobId, message: "the hand is here — finish and report" });
	assert.deepEqual([promote.receipt, promote.superseded?.generation, promote.superseded?.prior_status], ["delivered", 1, "blocked"]);
	await waitFor(() => f.events(jobId, "envelope_received").length, (n) => n === 2, { timeoutMs: 60_000, what: "the continued worker's envelope" });
	const reported = f.post.fleet.require(jobId);
	assert.deepEqual([reported.phase, reported.supersessions, reported.worktree], ["held", 1, before.worktree]);
	assert.ok(existsSync(join(f.home, paths.supersededEnvelopeFile(jobId, 1))), "the first envelope is kept, not overwritten");
});

test("P23-supersede: a promote reopens a held report slot — archived envelope and rejection, open stamp, a bodiless marker — the next report is the delivery and a second promote supersedes generation 2; an unreported or report-once job never supersedes", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("sup", (id) => [
		report(id, { status: "blocked", summary: "Blocked: the base branch is missing.", blockers: ["origin/main does not exist"], head_sha: f.head }),
		SLOW,
		report(id, { status: "done", summary: "Stage A landed.", branch: id, head_sha: f.head }),
		report(id, { status: "done", summary: "Stage B landed.", branch: id, head_sha: f.head }),
	]);
	await waitFor(() => f.post.fleet.require(jobId), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the blocked envelope" });
	await f.idle(jobId, "sup", 1);
	const firstReportedAt = f.post.fleet.require(jobId).reported_at;
	const runDir = join(f.home, paths.runDir(jobId));
	writeFileSync(join(runDir, "envelope-rejected.json"), JSON.stringify({ job_id: jobId, attempts: 3 }));

	const promote = await f.post.send({ jobId, message: "the base branch is back — implement Stage A and report it" });
	assert.deepEqual([promote.superseded?.generation, promote.superseded?.prior_status, promote.superseded?.prior_reported_at], [1, "blocked", firstReportedAt]);
	const open = f.post.fleet.require(jobId);
	assert.deepEqual([open.phase, open.reported_at, open.supersessions], ["waiting", undefined, 1], "the slot is open: the job owes a report again");
	assert.equal(existsSync(join(f.home, paths.envelopeFile(jobId))), false);
	assert.match(readFileSync(join(f.home, paths.supersededEnvelopeFile(jobId, 1)), "utf8"), /base branch is missing/, "nothing is destroyed, it is moved aside");
	assert.ok(f.post.reportedHeadAt(jobId), "the last filed envelope is read from the archive while the slot is open");
	assert.deepEqual([existsSync(join(runDir, "envelope-rejected.json")), existsSync(join(f.home, paths.supersededRejectionFile(jobId, 1)))], [false, true],
		"an exhausted rejection is archived with the envelope it would have failed");
	const [marker] = f.events(jobId, "envelope_superseded");
	assert.equal(marker?.generation, 1);
	assert.match(String(marker?.reason), /\S/, "the supersession carries its reason");
	assert.ok(!JSON.stringify(marker).includes("origin/main does not exist"), "no body travels in a marker");
	assert.equal(readRunStatus(f.home, jobId).reported, false, "the run projection stops claiming a report");

	await waitFor(() => f.events(jobId, "envelope_received").length, (n) => n === 2, { timeoutMs: 60_000, what: "the superseding envelope" });
	assert.deepEqual([f.post.fleet.require(jobId).phase, f.post.fleet.require(jobId).supersessions], ["held", 1], "the superseding envelope is accepted, not swallowed");
	assert.equal(readRunStatus(f.home, jobId).reported, true);
	await f.idle(jobId, "sup", 3);
	const second = await f.post.send({ jobId, message: "now Stage B" });
	assert.deepEqual([second.superseded?.generation, second.superseded?.prior_status], [2, "done"], "a second supersession is the next generation");
	await waitFor(() => f.events(jobId, "envelope_received").length, (n) => n === 3, { timeoutMs: 60_000, what: "the third envelope" });
	assert.deepEqual(readRunEvents(f.home, jobId).filter((event) => event.source === "cp" && event.type.startsWith("envelope_")).map((event) => event.type),
		["envelope_received", "envelope_superseded", "envelope_received", "envelope_superseded", "envelope_received"], "one live envelope per generation");
	assert.equal(f.post.fleet.require(jobId).supersessions, 2);

	const once = await f.dispatch("once", (id) => [report(id, { status: "done", summary: "Done once, reported once.", branch: id, head_sha: f.head }), TEXT]);
	const unreported = await f.dispatch("unreported", () => [TEXT]);
	await waitFor(() => f.post.fleet.require(once), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the report-once envelope" });
	await f.idle(once, "once", 1);
	assert.deepEqual([f.events(once, "envelope_received").length, f.post.fleet.require(once).supersessions, existsSync(join(f.home, paths.supersededEnvelopeFile(once, 1)))],
		[1, undefined, false], "report once: one envelope, no supersession");
	await f.idle(unreported, "unreported", 2);
	const plain = await f.post.send({ jobId: unreported, message: "carry on" });
	assert.deepEqual([plain.receipt, plain.superseded, f.post.fleet.require(unreported).supersessions, f.events(unreported, "envelope_superseded").length],
		["delivered", undefined, undefined, 0], "an unreported job is open: nothing to supersede");
});

test("P9g-send-plan: a conversation revise is refused once the plan is approved or vetoed, delivered once until re-gated, and a question is delivered", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const [researchId, shipId] = ["cp-plan-research", "cp-plan-ship"];
	atomicWriteJson(join(f.home, paths.pipelineFile(researchId)), { schema_version: SCHEMA_VERSION, research_id: researchId, ship_id: shipId });
	f.post.checkpoints.request({ jobId: shipId, question: `ship ${shipId}?` });
	f.post.checkpoints.decide(shipId, true, { by: "mandate:test" });
	await f.post.fleet.add({ job_id: shipId, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "waiting", worktree: f.home, branch: shipId,
		worker: { pid: 999999, session_id: "s", session_file: join(f.home, "sessions/s.jsonl"), profile: "implementer", role: "implementer", model: "m", started_at: isoTimestamp() },
		dispatched_at: isoTimestamp(), usage: EMPTY_USAGE });
	await assert.rejects(f.post.send({ jobId: researchId, message: `revise the plan for job ${researchId}: split step 3` }), (error: Error) =>
		/plan checkpoint .* is already approved and the implementer has been dispatched/.test(error.message)
		&& new RegExp(`start a new research job, or steer the implementer with cp_send ${shipId}`).test(error.message));

	const vetoedId = "cp-veto-research";
	atomicWriteJson(join(f.home, paths.gateFile(vetoedId, 1)), decideGate({ jobId: vetoedId, attempt: 1, prior: { priorRevise: false, priorCause: null }, model: "m",
		review: { job_id: vetoedId, verdict: "revise", flags: { destructive_scope: true, scope_growth: false, blocking_unknowns: false }, reasons: ["drops a table"], revisions: ["keep it"] } }));
	await assert.rejects(f.post.send({ jobId: vetoedId, message: "Revise ONLY 4b" }), (error: Error) => error.message.includes(paths.gateFile(vetoedId, 1)));
	await assert.rejects(f.post.send({ jobId: vetoedId, message: "add a citation" }), /no fleet record/, "text without revise passes the guard");

	const planner = await f.dispatch("planner", () => [TEXT]);
	await f.idle(planner, "planner", 2);
	atomicWriteJson(join(f.home, paths.pipelineFile(planner)), { schema_version: SCHEMA_VERSION, research_id: planner, ship_id: "cp-plan-ship2" });
	const revise = await f.post.send({ jobId: planner, message: `revise the plan for job ${planner}: split step 3` });
	assert.equal(revise.receipt, "delivered");
	await f.idle(planner, "planner", 4);
	assert.ok(decisionReviseAt(f.home, planner), "a delivered revise leaves an open-revise marker");
	await assert.rejects(f.post.send({ jobId: planner, message: `revise the plan for job ${planner}: also fix step 4` }), /one open revise at a time/);
	const question = await f.post.send({ jobId: planner, message: `ask the planner of job ${planner}: which auth provider?` });
	assert.equal(question.receipt, "delivered", "a question is an ask, not a second revise");
	await f.idle(planner, "planner", 6);
	assert.match(f.prompts("planner")[4] ?? "", /which auth provider\?/);
});

test("P9g-send-risk: a promotion's risk gates, warns or proceeds on an answered ask exactly as a dispatch would, and a denied project refuses every send", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const day = () => isoTimestamp(new Date(Date.now() + 86_400_000));
	const grant = { projects: ["demo"], objective: "ship the cleanup", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high" as const] };

	// A bridge grant gates a risky promotion with one escalation; an operator-quoted approval lets it through.
	const a = await bench(t);
	const gated = await a.dispatch("gated", () => [TEXT], "Bump x to 2 in src/app.ts.");
	await a.idle(gated, "gated", 2);
	a.post.mandates.issue({ ...grant, objective: "ship the bump", expiry: day(), channel: "bridge" });
	await assert.rejects(a.post.send({ jobId: gated, message: "scope grew", task: "Rotate the production database credentials." }), /risk:high under ask_on/);
	const open = a.post.escalations.open();
	assert.deepEqual([open.length, open[0]?.kind], [1, "risk_high_irreversible"], "exactly one escalation");
	assert.match(open[0]?.question ?? "", new RegExp(gated));
	await a.post.escalations.answer(open[0]?.id as string, { answer: "approve", by: "operator-quote" });
	assert.equal((await a.post.send({ jobId: gated, message: "scope grew", task: "Rotate the production database credentials." })).receipt, "delivered");
	await a.idle(gated, "gated", 4);

	// cp-7re9: a denied project refuses a steer, a promotion and a repair before delivery; the frozen task is untouched.
	const frozen = a.original(gated);
	const generations = a.post.fleet.require(gated).task_generations;
	atomicWriteJson(join(a.home, LAYOUT.mandateDefaultsFile), { deny_projects: ["demo"] });
	const denied: SendRequest[] = [{ jobId: gated, message: "steer", mode: "steer" }, { jobId: gated, message: "scope grew", task: "Bump x and update the README." },
		{ jobId: gated, message: "CI is red; fix it", purpose: "repair" }];
	for (const request of denied) await assert.rejects(a.post.send(request), /settings: project demo is denied/);
	assert.deepEqual([a.prompts("gated").length, a.original(gated), a.post.fleet.require(gated).task_generations], [4, frozen, generations], "nothing was delivered or rewritten");

	// H6, #321 and riskkw-f10 under an operator-chat grant: inferred-only or classify-only highs warn, assessed highs gate.
	const d = await bench(t);
	const [inferred, classify, header] = [await d.dispatch("inferred", () => [TEXT]), await d.dispatch("classify", () => [TEXT]), await d.dispatch("header", () => [TEXT])];
	for (const [jobId, slug] of [[inferred, "inferred"], [classify, "classify"], [header, "header"]] as const) await d.idle(jobId, slug, 2);
	d.post.mandates.issue({ ...grant, expiry: day() });
	const route = (jobId: string, routing: NonNullable<ReturnType<typeof d.post.fleet.require>["routing"]>) =>
		d.post.fleet.mutate((jobs) => { for (const job of jobs) if (job.job_id === jobId) job.routing = routing; });
	const escalated = (jobId: string) => d.post.escalations.open().filter((item) => item.job_ids.includes(jobId));

	await route(inferred, { risk: "high", inferred: true, provenance: { scope: "defaulted", risk: "inferred" }, recorded_risk: "low" });
	const warned = await d.post.send({ jobId: inferred, message: "re-brief", task: "Delete the stale fixture." });
	assert.equal(warned.receipt, "delivered");
	assert.match(warned.risk_warning ?? "", /risk:high inferred from keywords only \(delete\)/);
	assert.equal(d.events(inferred, "prompt_sent").at(-1)?.risk_warning, warned.risk_warning, "the same line is in the run journal");
	assert.deepEqual(escalated(inferred), [], "nothing was escalated");
	await d.idle(inferred, "inferred", 4);
	await route(inferred, { risk: "high", inferred: false, provenance: { scope: "defaulted", risk: "explicit" } });
	await assert.rejects(d.post.send({ jobId: inferred, message: "re-brief", task: "Delete the stale fixture." }), /risk:high under ask_on/);
	assert.equal(escalated(inferred)[0]?.kind, "risk_high_irreversible", "an assessed high still escalates");

	const chat = await d.post.send({ jobId: classify, message: "re-brief", task: "Delete the stale fixture." });
	assert.equal(chat.receipt, "delivered");
	assert.match(chat.risk_warning ?? "", /risk source: classify \(word: delete\); grant md-\w+ was issued from operator chat/);
	assert.deepEqual(escalated(classify), []);
	await d.idle(classify, "classify", 4);
	await assert.rejects(d.post.send({ jobId: classify, message: "re-brief", task: "Delete the fixture, then force push the branch." }), /risk:high under ask_on/, "a hard stop still escalates");

	await route(header, { risk: "low", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } });
	const declared = await d.post.send({ jobId: header, message: "re-brief", task: "Scope S, risk low.\n\nDelete the stale fixture." });
	assert.equal(declared.receipt, "delivered");
	assert.match(declared.risk_warning ?? "", /\(delete\); risk low was recorded in the task header/);
	assert.deepEqual(escalated(header), []);
	await d.idle(header, "header", 4);
	await assert.rejects(d.post.send({ jobId: header, message: "re-brief", task: "Risk: high\n\nFix the typo." }), /risk:high under ask_on/);
	assert.match(escalated(header)[0]?.question ?? "", /risk high recorded in the task header/);
});

test("P9g-send-grants: an expired grant keeps its in-flight promotion and repair only while repair is allowed, refuses after a revoke or cap pause, and a serial slot never blocks the held job's own promotion", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const past = (ms: number) => isoTimestamp(new Date(Date.now() - ms));
	const grant = { projects: ["demo"], objective: "ship it", spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 };

	const b = await bench(t);
	const flight = await b.dispatch("flight", () => [TEXT]);
	await b.idle(flight, "flight", 2);
	b.post.mandates.issue({ ...grant, expiry: past(1_000), at: past(86_400_000), allowed_actions: ["implement", "review", "repair", "merge"] });
	rmSync(join(b.home, paths.originalTaskFile(flight)));
	const first = await b.post.send({ jobId: flight, message: "review fix", task: "Address the review finding." });
	assert.deepEqual([first.receipt, first.task_updated?.generation, first.task_updated?.archived], ["delivered", 1, undefined], "nothing frozen, nothing archived");
	assert.equal(b.original(flight), "Address the review finding.");
	assert.equal(existsSync(b.archived(flight, 1)), false);
	await b.idle(flight, "flight", 4);
	assert.equal((await b.post.send({ jobId: flight, message: "CI is red; fix it", purpose: "repair" })).receipt, "delivered");
	await b.idle(flight, "flight", 6);
	b.post.mandates.issue({ ...grant, expiry: past(1_000), at: past(60_000), allowed_actions: ["implement", "review"] });
	await assert.rejects(b.post.send({ jobId: flight, message: "fix it again", purpose: "repair" }), /repair is not an allowed action/);
	await assert.rejects(b.post.send({ jobId: flight, message: "again", task: "Address it again." }), /repair is not an allowed action/);

	const c = await bench(t);
	const stopped = await c.dispatch("stopped", () => [TEXT]);
	await c.idle(stopped, "stopped", 2);
	const revoked = c.post.mandates.issue({ ...grant, expiry: past(2_000), at: past(86_400_000) });
	c.post.mandates.revoke(revoked.id);
	await assert.rejects(c.post.send({ jobId: stopped, message: "CI is red; fix it", purpose: "repair" }), new RegExp(`mandate ${revoked.id} is revoked .*no repair under it`));
	const capped = c.post.mandates.issue({ ...grant, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), at: past(60_000) });
	c.post.mandates.save({ ...c.post.mandates.require(capped.id), status: "paused", paused_at: past(30_000), pause_reason: "spend_cap", expiry: past(1_000) });
	await assert.rejects(c.post.send({ jobId: stopped, message: "CI is red; fix it", purpose: "repair" }), new RegExp(`mandate ${capped.id} is paused \\(spend_cap\\) .*no repair under it`));
	assert.equal(c.prompts("stopped").length, 2, "nothing was delivered");

	const e = await bench(t);
	const held = await e.dispatch("serial", (id) => [report(id, { status: "blocked", summary: "Blocked on review.", blockers: ["diff review asked for a fix"] }), TEXT]);
	await waitFor(() => e.post.fleet.require(held), (job) => job.phase === "held", { timeoutMs: 60_000, what: "the held envelope" });
	await e.idle(held, "serial", 1);
	const working = await e.dispatch("working", () => [{ kind: "hang" }]);
	e.post.mandates.issue({ ...grant, spend_cap: { usd: 10, tokens: 10_000_000 }, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), dispatch_parallelism: 1 });
	const pids = e.post.manager.active.map((managed) => managed.worker.pid).sort();
	const promote = await e.post.send({ jobId: held, message: "apply the review fix", task: "Apply the review fix on the same branch." });
	assert.equal(promote.receipt, "delivered", "its own held slot never blocks its promotion");
	assert.deepEqual([e.post.manager.active.map((managed) => managed.worker.pid).sort(), e.post.fleet.list().map((job) => job.job_id).sort()],
		[pids, [held, working].sort()], "same workers, no new job");
});

test("P9g-send-policy: a torn or policy-blocked worker session refuses every send mode before delivery; marker-looking prose still delivers", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await bench(t);
	const jobId = await f.dispatch("policy", () => [TEXT], `Quote this marker in the README: ${POLICY_MARKER}`);
	await f.idle(jobId, "policy", 2);
	assert.equal((await f.post.send({ jobId, message: "first" })).receipt, "delivered", "the marker inside a user message is prose");
	await f.idle(jobId, "policy", 4);
	const session = f.post.fleet.require(jobId).worker.session_file;
	const size = statSync(session).size;
	const lines = readFileSync(session, "utf8").split("\n").filter(Boolean).length;

	appendFileSync(session, `{"type":"cust\n`);
	await assert.rejects(f.post.send({ jobId, message: "go" }), new RegExp(`worker session .*line ${lines + 1} is not valid JSON`));
	truncateSync(session, size);

	appendFileSync(session, `${POLICY_MARKER}\n`);
	const before = f.post.fleet.require(jobId);
	const sends: Array<Omit<SendRequest, "jobId">> = [{ message: "go" }, ...(["auto", "prompt", "steer", "follow_up"] as const).map((mode) => ({ message: "go", mode })),
		{ message: "go", task: "new scope" }, { message: "fix CI", purpose: "repair" }];
	for (const request of sends) {
		await assert.rejects(f.post.send({ jobId, ...request }), (error: Error) =>
			error.message.includes(session) && /worker-compaction-policy-block.*keep the lease/s.test(error.message));
	}
	assert.equal(f.prompts("policy").length, 4, "nothing delivered");
	assert.deepEqual(f.post.fleet.require(jobId), before, "no envelope reopen or settle clear");
});
