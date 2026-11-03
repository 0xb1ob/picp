/**
 * Self-review A2: script, promotion, freshness and replacement parity for the A1 authority hold. Cases H11–H14 of the
 * approved plan, plus a gate history past attempt 32. Admission runs through real pi parents' registered tools; the
 * pipeline and gate producers run on an in-process CommandPost, as in authority-hold.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { isGateWait, readPriorAttempts } from "../../src/gate.ts";
import { initJobsDocument, requireJobLabels } from "../../src/ledger.ts";
import type { Authorizer } from "../../src/pipeline.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	poolStatus,
	readRunEvents,
	REPO_ROOT,
	type ScriptStep,
	startPiChild,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "the pipeline producers need treehouse on PATH";
const ARTIFACT_BODY = ["# Goal", "Bump x to 2 in src/app.ts.", "", "# File list", "- src/app.ts", "", "# Test plan", "npm test", "",
	"# Unknowns/Blockers", "none", ""].join("\n");
const GRANT = { expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 50, tokens: 1_000_000 }, job_cap: 50, allowed_actions: ["implement" as const] };

type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, args });
const quote = (id: string, target: string, decision: string, text: string): Call =>
	call(id, "cp_decide", { target, decision, basis: { operator_quote: text } });
const dispatch = (id: string, jobId: string, extra: Record<string, unknown> = { task: "Bump x." }): Call =>
	call(id, "cp_dispatch", { job_id: jobId, fetch: false, ...extra });
const verdict = (jobId: string, overrides: Record<string, unknown> = {}): ScriptStep => ({
	kind: "tool_calls",
	calls: [{ name: "report_verdict", args: { job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["file list is concrete"], ...overrides } }],
});

/** A real CommandPost on a treehouse pool for `demo`, scripted planner, gate reviewer and implementer models. */
async function bench(t: TestContext) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n", "scripts/run.sh": "touch \"$CP_RUN_DIR/ran\"\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	// One write-and-stop pair per planner run: a repeating script repeats only its last step.
	const planner = provider.addScript("a2-research", Array.from({ length: 12 }, (): ScriptStep[] => [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ARTIFACT_BODY}EOF` } }] },
		{ kind: "text", text: "Artifact written." },
	]).flat(), { onExhausted: "repeat" });
	const gateSteps: ScriptStep[] = [];
	const reviewer = provider.addScript("a2-gate", gateSteps);
	const implementer = provider.addScript("a2-ship", [{ kind: "text", text: "Working on it." }], { onExhausted: "repeat" });
	agentDir.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [
		{ id: "planner", role: "planner", model: planner },
		{ id: "gate-reviewer", role: "gate-reviewer", model: reviewer },
		{ id: "implementer", role: "implementer", model: implementer },
	] }));
	const authorizer: Authorizer = { ask: async () => undefined };
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...agentDir.env }, authorizer });
	post.reviewRuns.wakeupPort = () => true;
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 6 });
	t.after(async () => {
		await post.shutdown();
		try {
			treehouse(clone, "prune");
		} catch {
			// the pool root goes next anyway
		}
		pool.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});
	let ordinal = 0;
	/** One real pi parent per prompt; `during` runs while its turns do, so a `bash` wait turn can hold it mid-prompt. */
	const single = async (text: string, turns: Call[][], during?: () => Promise<void>) => {
		const steps: ScriptStep[] = [...turns.map((calls) => ({ kind: "tool_calls" as const, calls })), { kind: "text" as const, text: "done" }];
		const model = provider.addScript(`a2-parent-${(ordinal += 1)}`, steps);
		agentDir.writeModels(provider);
		// Queued wake-ups from in-process producers would start a turn before the prompt and consume its script.
		rmSync(join(home.path, LAYOUT.wakeupsFile), { force: true });
		const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			await Promise.all([child.prompt(text).then(() => child.waitForSettled(180_000)), during?.()]);
			const ends = new Map(child.eventsOfType("tool_execution_end").map((end) => [String(end.toolCallId), end]));
			const said = (id: string) => JSON.stringify(ends.get(id)?.result);
			return {
				ok(id: string, pattern?: RegExp) {
					assert.ok(ends.has(id), `${id} never ran`);
					assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(id)}`);
					if (pattern) assert.match(said(id), pattern, id);
				},
				failed(id: string, pattern: RegExp) {
					assert.equal(ends.get(id)?.isError, true, `${id}: ${said(id)}`);
					assert.match(said(id), pattern, id);
				},
			};
		} finally {
			await child.close();
		}
	};
	const advanceThrough = async (researchId: string) => {
		let result = await post.advancePipeline(researchId);
		for (let guard = 0; result.pending && guard < 10; guard += 1) {
			const key = ReviewRuns.key(result.pending.surface === "review" ? result.ship_id : result.research_id, result.pending.surface, result.pending.attempt);
			post.reviewRuns.handBack(key);
			await post.reviewRuns.settled(key);
			result = await post.advancePipeline(researchId);
		}
		return result;
	};
	/** A real pipeline whose first gate decides `overrides`; returns its ids and, on a policy stop, its escalation. */
	const gated = async (slug: string, overrides: Record<string, unknown>) => {
		const started = await post.startPipeline({ title: slug, project: "demo", task: "Bump x to 2 in src/app.ts.", delivery: "local", slug, fetch: false });
		await waitFor(() => post.artifacts.has(started.research_id), (there) => there, { what: `${slug}'s planner artifact` });
		gateSteps.push(verdict(started.research_id, overrides));
		const result = await advanceThrough(started.research_id);
		const [held] = new EscalationStore({ home: home.path }).list({ jobId: started.research_id }).filter((item) => item.authority_hold);
		return { ...started, result, held };
	};
	const ship = async (title: string) => (await post.ledger().create({ title, project: "demo", delivery: "local", kind: "ship" })).id;
	const leased = () => poolStatus(clone).filter((entry) => entry.status === "leased").map((entry) => entry.path).sort();
	const untouched = (jobId: string) => {
		assert.equal(post.fleet.get(jobId), undefined, `${jobId}: no fleet record`);
		assert.equal(existsSync(join(home.path, paths.briefFile(jobId))), false, `${jobId}: no brief, so no lease or spawn`);
	};
	const closeResearch = async (jobId: string, reason: string) => {
		await post.tearDown(jobId, { force: true });
		await post.ledger().close(jobId, reason);
	};
	const replacement = async (sourceId: string, title: string) => {
		const labels = requireJobLabels(await post.ledger().show(sourceId));
		return (await post.ledger().create({ title, project: labels.project, kind: "research", delivery: labels.delivery })).id;
	};
	/** In-process planner run whose worker this bench can tear down; returns once its artifact exists. */
	const plan = async (jobId: string, taskFile?: string) => {
		assert.equal((await post.dispatch({ jobId, ...(taskFile ? { taskFile } : { task: "Plan bumping x to 2 in src/app.ts." }), fetch: false })).receipt, "accepted");
		await waitFor(() => post.artifacts.has(jobId), (there) => there, { what: `${jobId}'s planner artifact` });
	};
	const gateOnce = async (jobId: string, overrides: Record<string, unknown> = {}) => {
		gateSteps.push(verdict(jobId, overrides));
		const result = await post.gate({ jobId });
		if (isGateWait(result)) {
			post.reviewRuns.handBack(result.key);
			await post.reviewRuns.settled(result.key);
		}
	};
	return { home: home.path, post, provider, gateSteps, single, advanceThrough, gated, ship, leased, untouched, closeResearch, replacement, plan, gateOnce };
}

test("H11-H12: a held script never leases or launches, and a held ship-task promotion never reopens or messages", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	b.post.mandates.issue({ projects: ["demo"], objective: "a2 held work", ...GRANT });
	const script = (await b.post.ledger().create({ title: "held script", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" })).id;
	const worker = await b.ship("promoted ship");
	const promotion = join(b.home, "promotion.md");
	writeFileSync(promotion, "Implement the promoted scope: bump x to 3 in src/app.ts.\n");
	const ready = join(b.home, "hold-ready");
	const sends = () => readRunEvents(b.home, worker).filter((event) => /^(prompt|steer|follow_up)_sent$/.test(event.type)).length;
	let es = "", before: string[] = [], briefed = 0;
	// The bash turn keeps this parent, and the worker it dispatched, live and idle until the hold exists.
	const run = await b.single("Dispatch the ship; once the hold exists, dispatch the script and promote the ship.", [
		[dispatch("ship", worker)],
		[call("wait", "bash", { command: `for i in $(seq 1 900); do [ -f '${ready}' ] && exit 0; sleep 0.2; done; exit 1` })],
		[dispatch("script", script, {})],
		[call("promote", "cp_send", { job_id: worker, message: "Implement the promoted scope.", mode: "prompt", task_file: promotion })],
	], async () => {
		await waitFor(() => b.provider.requests("a2-ship").length, (count) => count > 0, { what: "the ship worker's first turn", timeoutMs: 60_000 });
		const policy = await b.gated("held", { verdict: "escalate", reasons: ["the plan skips a rollback step"] });
		assert.ok(policy.held?.authority_hold, "the policy gate recorded an authority hold");
		es = policy.held.id;
		before = b.leased();
		briefed = sends();
		writeFileSync(ready, "");
	});
	run.ok("wait");
	run.ok("ship", /accepted/);
	// H11: no fleet record, no new lease, no script process.
	run.failed("script", new RegExp(`${script}: refused before lease — authority hold ${es}`));
	b.untouched(script);
	assert.deepEqual(b.leased(), before, "H11: the refused script took no lease");
	assert.equal(existsSync(join(b.home, paths.runDir(script), "ran")), false, "H11: the script never ran");
	// H12: the promotion reopens nothing and never reaches the idle worker.
	run.failed("promote", new RegExp(`${worker}: refused before lease — authority hold ${es}`));
	await new Promise((resolve) => setTimeout(resolve, 2000));
	assert.equal(sends(), briefed, "H12: no delivery marker beyond the dispatch brief");
	assert.equal(b.provider.requests("a2-ship").some((request) => JSON.stringify(request.body.messages).includes("Implement the promoted scope")), false,
		"H12: the worker never saw the promoted message");
	assert.equal(b.post.fleet.get(worker)?.reported_at, undefined, "H12: no envelope slot was reopened or filed");
});

test("H13: a plan changed after its answered gate attempt needs a fresh gate for direct and pipeline admission", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	b.post.mandates.issue({ projects: ["demo"], objective: "a2 fresh gate", ...GRANT });
	const policy = await b.gated("fresh", { verdict: "escalate", reasons: ["the plan skips a rollback step"] });
	const es = policy.held!.id;
	const fresh = await b.ship("fresh covered ship");
	(await b.single(`Override ${es}.`, [[quote("override", es, "override", `Override ${es}.`)]])).ok("override");
	writeFileSync(b.post.artifacts.file(policy.research_id), `${ARTIFACT_BODY}\n# Addendum\nAlso bump y in src/app.ts.\n`);
	const before = b.leased();
	const stale = await b.single("Dispatch the ship.", [[dispatch("stale", fresh)]]);
	stale.failed("stale", new RegExp(`authority hold ${es} \\(mandate [^)]+\\) was released, but .*answered gate attempt 1 .*cp_gate ${policy.research_id}`));
	b.untouched(fresh);
	const surfaced = await b.advanceThrough(policy.research_id);
	assert.deepEqual([surfaced.state, surfaced.next], ["escalated", "surface"], "the pipeline's own admission surfaces the stale consent");
	assert.match(surfaced.message ?? "", /artifact has changed .*cp_gate/);
	assert.equal(b.post.fleet.get(policy.ship_id), undefined, "the pipeline ship was never dispatched");
	assert.deepEqual(b.leased(), before, "a stale consent takes no lease");
	// The replay holds again under a new id; overriding it still leaves the consent stale until a fresh gate binds.
	const reheld = new EscalationStore({ home: b.home }).list({ jobId: policy.research_id }).filter((item) => item.authority_hold && item.status === "open");
	assert.equal(reheld.length, 1, "the replayed policy verdict records one new hold");
	const again = await b.single(`Override ${reheld[0]!.id}.`, [[quote("again", reheld[0]!.id, "override", `Override ${reheld[0]!.id}.`)],
		[dispatch("still-stale", fresh)]]);
	again.ok("again");
	again.failed("still-stale", /was released, but .*cp_gate/);
	b.untouched(fresh);
	// A fresh gate on the changed plan binds its inputs; the same consent then admits again.
	b.gateSteps.push(verdict(policy.research_id));
	const regate = await b.post.gate({ jobId: policy.research_id });
	if (isGateWait(regate)) {
		b.post.reviewRuns.handBack(regate.key);
		await b.post.reviewRuns.settled(regate.key);
	}
	assert.deepEqual(readPriorAttempts(b.home, policy.research_id).decisions.map((decision) => decision.verdict), ["escalate", "pass"]);
	(await b.single("Dispatch the ship.", [[dispatch("fresh", fresh)]])).ok("fresh", /accepted/);
	let advanced = await b.advanceThrough(policy.research_id);
	if (advanced.state === "awaiting_authorization") {
		b.post.checkpoints.decide(policy.ship_id, true, { by: "operator-quote" });
		advanced = await b.advanceThrough(policy.research_id);
	}
	assert.deepEqual([advanced.state, advanced.dispatch?.receipt], ["implementing", "accepted"], "the pipeline admits after the fresh gate");
});

test("H14: replace_planner and authorized recovery run eligible research; neither they nor source closure clears the ship hold", { skip: SKIP, timeout: 900_000 }, async (t) => {
	const b = await bench(t);
	b.post.mandates.issue({ projects: ["demo"], objective: "a2 replacement work", ...GRANT });
	const capped = await b.gated("capped", { verdict: "escalate", reasons: ["revision max cap reached"] });
	const es = capped.held!.id;
	assert.equal(capped.held!.kind, "loop_exhausted");
	const revised = await b.gated("revised", { verdict: "revise", reasons: ["missing proof"], revisions: ["add the proof"] });
	assert.equal(readPriorAttempts(b.home, revised.research_id).decisions.at(-1)?.verdict, "revise");
	const fresh = await b.ship("fresh covered ship");
	const holdRefusal = new RegExp(`${fresh}: refused before lease — authority hold ${es}`);

	// Ordinary replace_planner on the revised source: the replacement research dispatches, the ship stays held.
	await b.closeResearch(revised.research_id, "replaced by a fresh planner");
	const ordinary = await b.replacement(revised.research_id, "ordinary replacement");
	const first = await b.single("Replace the planner, dispatch it, then the ship.", [
		[call("replace", "cp_gate", { action: "replace_planner", job_id: revised.research_id, replacement_job_id: ordinary })],
		[dispatch("research", ordinary, { task_file: join(b.home, paths.runDir(ordinary), "revision-task.md") })],
		[dispatch("ship", fresh)]]);
	first.ok("replace");
	first.ok("research", /accepted/);
	first.failed("ship", holdRefusal);
	b.untouched(fresh);

	// Authorized recovery of the capped source: a replan answer releases nothing, recovery research still runs.
	await b.closeResearch(capped.research_id, "recovering a corrected plan");
	const recovered = await b.replacement(capped.research_id, "recovery replacement");
	(await b.single(`Replan ${es}.`, [[quote("replan", es, "replan", `Replan ${es}.`)]])).ok("replan");
	const second = await b.single("Recover the planner, dispatch it, then the ship.", [
		[call("recover", "cp_gate", { action: "replace_planner", job_id: capped.research_id, replacement_job_id: recovered, replan_escalation_id: es })],
		[dispatch("research", recovered, { task_file: join(b.home, paths.runDir(recovered), "revision-task.md") })],
		[dispatch("ship", fresh)]]);
	second.ok("recover");
	second.ok("research", /accepted/);
	second.failed("ship", holdRefusal);
	b.untouched(fresh);

	// Closing every replacement planner grants no ship consent either.
	for (const id of [ordinary, recovered]) await b.closeResearch(id, "replacement planner closed");
	const before = b.leased();
	(await b.single("Dispatch the ship.", [[dispatch("closed", fresh)]])).failed("closed", holdRefusal);
	b.untouched(fresh);
	assert.deepEqual(b.leased(), before, "the refused ship took no lease");
});

test("H14b: replace_work runs the replacement research of expired admitted work; the ship stays held until a named-id release", { skip: SKIP, timeout: 900_000 }, async (t) => {
	const b = await bench(t);
	// The original research is the named work of a default-expiry grant, admitted through continuation after expiry.
	const original = (await b.post.ledger().create({ title: "original research", description: "Plan bumping x to 2 in src/app.ts.", project: "demo",
		kind: "research", delivery: "local" })).id;
	const expiry = new Date(Date.now() + 3000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const root = b.post.mandates.issue({ projects: ["demo"], objective: "complete only the original research", job_ids: [original], expiry,
		provenance: { expiry_hours: "home" }, spend_cap: { usd: 50, tokens: 1_000_000 }, job_cap: 1, ask_on: [] });
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 50)));
	await b.plan(original);
	await b.gateOnce(original, { verdict: "revise", reasons: ["missing proof"], revisions: ["add the proof"] });
	await waitFor(() => b.post.manager.get(original)?.worker.busy, (busy) => busy === false, { what: "the revised planner's turn" });
	await b.closeResearch(original, "replaced by the same admitted work");
	b.post.mandates.issue({ projects: ["demo"], objective: "a2 replace_work", ...GRANT });
	const policy = await b.gated("held", { verdict: "escalate", reasons: ["the plan skips a rollback step"] });
	const es = policy.held!.id;
	const fresh = await b.ship("fresh covered ship");
	const successor = await b.replacement(original, "same-work successor");
	const run = await b.single("Bind the same-work successor, dispatch it, then the ship.", [
		[call("link", "cp_mandate", { action: "replace_work", source_id: root.id, original_job_id: original, replacement_job_id: successor })],
		[dispatch("research", successor, { task_file: join(b.home, paths.runDir(successor), "revision-task.md") })],
		[dispatch("ship", fresh)]]);
	run.ok("link", /committed/);
	run.ok("research", /accepted/);
	run.failed("ship", new RegExp(`${fresh}: refused before lease — authority hold ${es}`));
	b.untouched(fresh);
	const released = await b.single(`Override ${es}.`, [[quote("override", es, "override", `Override ${es}.`)], [dispatch("released", fresh)]]);
	released.ok("override");
	released.ok("released", /accepted/);
});

test("H14c: a mechanical cp_gate handoff of a recovered plan keeps the ship hold; a released consent follows the replacement's plan", { skip: SKIP, timeout: 900_000 }, async (t) => {
	const b = await bench(t);
	b.post.mandates.issue({ projects: ["demo"], objective: "a2 handoff", ...GRANT });
	const capped = await b.gated("capped", { verdict: "escalate", reasons: ["revision max cap reached"] });
	const es = capped.held!.id;
	const [fresh, later] = [await b.ship("fresh covered ship"), await b.ship("later covered ship")];
	await b.closeResearch(capped.research_id, "recovering a corrected plan");
	const recovered = await b.replacement(capped.research_id, "recovery replacement");
	(await b.single(`Replan ${es}.`, [[quote("replan", es, "replan", `Replan ${es}.`)]])).ok("replan");
	(await b.single("Recover the planner.", [[call("recover", "cp_gate", { action: "replace_planner", job_id: capped.research_id, replacement_job_id: recovered,
		replan_escalation_id: es })]])).ok("recover");
	await b.plan(recovered, join(b.home, paths.runDir(recovered), "revision-task.md"));
	await b.gateOnce(recovered);
	await waitFor(() => b.post.manager.get(recovered)?.worker.busy, (busy) => busy === false, { what: "the recovered planner's turn" });
	await b.closeResearch(recovered, "recovered plan passed");
	const handoff = { action: "handoff", job_id: recovered, source_job_id: capped.research_id, dependent_job_ids: [capped.ship_id] };
	const before = b.leased();
	const run = await b.single("Hand the pipeline ship off to the passed replacement, then dispatch both ships.", [
		[call("register", "cp_gate", handoff)], [call("commit", "cp_gate", handoff)], [dispatch("pipeline-ship", capped.ship_id)], [dispatch("ship", fresh)]]);
	run.ok("register", /waiting_review/);
	run.ok("commit", /committed/);
	assert.deepEqual((await b.post.ledger().show(capped.ship_id)).blocked_by, [recovered], "the mechanical edge now points at the replacement");
	for (const [id, jobId] of [["pipeline-ship", capped.ship_id], ["ship", fresh]] as const) {
		run.failed(id, new RegExp(`${jobId}: refused before lease — authority hold ${es}`));
		b.untouched(jobId);
	}
	assert.deepEqual(b.leased(), before, "neither refused ship took a lease");
	// The replan answer closed the hold's chain: a named replacement escalation is the release path.
	(await b.single(`Replace ${es}.`, [[call("replace", "cp_escalate", { action: "replace", escalation_id: es })]])).ok("replace");
	const rep = new EscalationStore({ home: b.home }).list().find((item) => item.replaces_escalation_id === es)!.id;
	const released = await b.single(`Approve ${rep}.`, [[quote("approve", rep, "approve", `Approve ${rep}.`)], [dispatch("released", fresh)]]);
	released.ok("approve");
	released.ok("released", /accepted/);
	// The approved plan now lives in the replacement: changing it there makes the consent stale.
	writeFileSync(b.post.artifacts.file(recovered), `${ARTIFACT_BODY}\n# Addendum\nAlso bump y in src/app.ts.\n`);
	(await b.single("Dispatch the later ship.", [[dispatch("stale", later)]])).failed("stale", new RegExp(`was released, but .*cp_gate ${recovered}`));
	b.untouched(later);
});

test("carried low: an escalated pipeline's latest gate is read past attempt 32, and an unknown cause still fails closed", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const pipeline = async (title: string, attempt?: number) => {
		const research = (await b.post.ledger().create({ title: `${title} plan`, project: "demo", kind: "research", delivery: "local" })).id;
		const shipId = await b.ship(title);
		const file = join(b.home, paths.pipelineFile(research));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ research_id: research, ship_id: shipId, project: "demo", state: "escalated" }));
		if (attempt) {
			const gate = join(b.home, paths.gateFile(research, attempt));
			mkdirSync(dirname(gate), { recursive: true });
			writeFileSync(gate, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: research, attempt, verdict: "escalate", cause: "operational",
				flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewer timed out"], decided_at: "2026-11-03T00:00:00Z" }));
		}
		return { research, shipId };
	};
	const operational = await pipeline("operational stop", 33);
	const unknown = await pipeline("unknown stop");
	const run = await b.single("Dispatch both ships.", [[dispatch("past-32", operational.shipId)], [dispatch("unknown", unknown.shipId)]]);
	run.ok("past-32", /accepted/);
	run.failed("unknown", new RegExp(`${unknown.research}'s gate escalated but its authority hold is not recorded`));
	b.untouched(unknown.shipId);
});
