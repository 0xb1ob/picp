import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { DEFAULT_BUDGET_CONFIG, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { MandateStore } from "../../src/mandate.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { readFleet, readRunEvents, waitFor, type ScriptStep } from "../harness/index.ts";
import { ScheduleRunStore } from "../../src/schedule-runs.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { CommandPost } from "../../src/command-post.ts";
import { composeImplementationRouting } from "../../src/pipeline.ts";
import { REPO_ROOT } from "../harness/index.ts";
import { acquireParentLock } from "../../src/parent-lock.ts";
import { policyFromLegacy } from "../../src/viewer/schedule-policy.ts";

test("S29 authority: recorded risk, readonly profiles and ops enforce public dispatch gates", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 30, dispatch_parallelism: 16, ask_on: ["risk:high"] });
	const specs = [
		{ title: "explicit", recorded: "low", risk: "high", task: "Fix typo.", refused: true },
		{ title: "label", recorded: "high", risk: "low", task: "Fix typo.", refused: true },
		{ title: "header", risk: "low", task: "Scope S, risk high.\n\nFix typo.", refused: true },
		{ title: "writer", kind: "research", profile: "implementer", risk: "high", task: "Fix typo.", refused: true },
		{ title: "deploy", kind: "research", labels: ["ops:deploy"], risk: "low", task: "Deploy the build.", refused: true },
		{ title: "hard stop", task: "Delete the stale fixture and migrate the test helper. Then rm -rf the build dir.", refused: true },
		{ title: "planner", kind: "research", profile: "planner", risk: "high", task: "Rotate production credentials.", refused: false },
		{ title: "qa", kind: "research", profile: "qa", risk: "high", task: "Rotate production credentials.", refused: false },
		{ title: "low keyword", risk: "low", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /inferred from keywords only/ },
		{ title: "label low", recorded: "low", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /job's risk: label/ },
		{ title: "header low", task: "Scope S, risk low.\n\nDelete the stale fixture and migrate the test helper.", refused: false, warning: /task header/ },
		{ title: "description low", description: "Scope S, risk low.", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /job description header/ },
		{ title: "bare keyword", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /issued from operator chat/ },
	] as const;
	const jobs = [];
	const steps: ScriptStep[] = [];
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i]!;
		const job = await b.ledger.create({ title: spec.title, project: "demo", delivery: "local", kind: "kind" in spec ? spec.kind : "ship", ...("labels" in spec ? { labels: [...spec.labels] } : {}), ...("recorded" in spec ? { risk: spec.recorded } : {}), ...("description" in spec ? { description: spec.description } : {}) });
		jobs.push(job);
		const model = b.provider.addScript(`worker-${i}`, [{ kind: "text", text: "received" }]);
		steps.push({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: spec.task, model, queue: false, when_ready: false, ...("risk" in spec ? { risk: spec.risk } : {}), ...("profile" in spec ? { profile: spec.profile } : {}) } }] });
	}
	const ends = await b.run(steps);
	assert.equal(ends.length, specs.length);
	const fleet = readFleet(b.home).jobs;
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i]!;
		const end = ends[i]!;
		const job = jobs[i]!;
		await t.test(spec.title, async () => {
			assert.equal(end.isError === true, spec.refused, `${spec.title}: ${JSON.stringify(end.result)}`);
			const record = fleet.find((record) => record.job_id === job.id);
			if (spec.refused) {
				assert.match(JSON.stringify(end.result), /risk:high under ask_on/);
				assert.equal(record, undefined, spec.title);
				assert.equal((await b.ledger.show(job.id)).status, "open");
			} else {
				assert.equal(end.result.details?.state, "dispatched", spec.title);
				assert.ok(record, spec.title);
				if ("profile" in spec) assert.equal(end.result.details?.profile, spec.profile);
				if ("warning" in spec) {
					assert.match(String(end.result.details?.risk_warning), spec.warning);
					const event = readRunEvents(b.home, job.id).find((event) => event.type === "routing_resolved");
					assert.equal((event?.payload as Record<string, unknown>)?.risk_warning, end.result.details?.risk_warning);
					if (spec.title === "label low") {
						assert.equal(record.routing?.risk, "high");
						assert.equal(record.routing?.provenance?.risk, "inferred");
						assert.equal(record.routing?.recorded_risk, "low");
						assert.equal((event?.payload as Record<string, unknown>)?.recorded_risk, "low");
						assert.equal((event?.payload as Record<string, unknown>)?.recorded_risk_from, "job_label");
					}
					if (spec.title === "bare keyword") assert.equal(record.routing?.risk, "high");
					if (spec.title === "low keyword") assert.equal(record.routing?.risk, "low");
				}
			}
		});
	}
	const escalations = new EscalationStore({ home: b.home }).open();
	assert.deepEqual(escalations.flatMap((entry) => entry.job_ids).sort(), jobs.filter((_, i) => specs[i]!.refused).map((job) => job.id).sort());
	for (const [title, pattern] of [["label", /risk high recorded on the job's risk: label; risk source: explicit\)$/], ["header", /risk high recorded in the task header/]] as const) {
		const job = jobs[specs.findIndex((spec) => spec.title === title)]!;
		assert.match(escalations.find((entry) => entry.job_ids.includes(job.id))?.question ?? "", pattern);
	}
});

test("S29 authority: denied project precedes risk escalation", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	new MandateStore(b.home).issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"], channel: "bridge" });
	writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), JSON.stringify({ deny_projects: ["demo"] }));
	const job = await b.ledger.create({ title: "denied", project: "demo", delivery: "local", kind: "ship" });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "must not start" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Rotate production credentials.", risk: "high", model } }] }]);
	assert.equal(ends[0]?.isError, true);
	assert.match(JSON.stringify(ends[0]?.result), /project_denied/);
	assert.deepEqual(new EscalationStore({ home: b.home }).open(), []);
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
	assert.equal(b.provider.remaining("worker"), 1);
	assert.equal((await b.ledger.show(job.id)).status, "open");
	assert.ok(readFileSync(join(b.home, LAYOUT.mandateDefaultsFile), "utf8").includes("demo"));
});

test("S29 authority: a batch refusal stays singular and one quoted decision authorizes both jobs", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	new MandateStore(b.home).issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"], channel: "bridge" });
	const jobs = await Promise.all(["a", "b"].map((title) => b.ledger.create({ title, project: "demo", delivery: "local", kind: "ship", risk: "high" })));
	const models = jobs.map((_, i) => b.provider.addScript(`worker-${i}`, [{ kind: "text", text: "received" }]));
	const dispatches: ScriptStep[] = jobs.map((job, i) => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Fix typo.", model: models[i] } }] }));
	const initial = await b.run([...dispatches, { kind: "tool_calls", calls: [{ name: "cp_escalate", args: { action: "batch_risk_high", job_ids: jobs.map((job) => job.id) } }] }, dispatches[0]!]);
	assert.equal(initial[0]?.isError, true);
	assert.equal(initial[1]?.isError, true);
	assert.notEqual(initial[2]?.isError, true, JSON.stringify(initial));
	const escalations = new EscalationStore({ home: b.home });
	const batch = escalations.open()[0]!;
	assert.equal(escalations.open().length, 1);
	assert.deepEqual([...batch.job_ids].sort(), jobs.map((job) => job.id).sort());
	assert.equal(escalations.list().length, 3, "repeat refusal raises no fourth escalation");
	assert.match(JSON.stringify(initial[3]?.result), new RegExp(batch.id));
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
	await b.closeParents();
	const quote = `Approve ${batch.id}.`;
	const final = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_decide", args: { target: batch.id, decision: "approve", basis: { operator_quote: quote } } }] }, ...dispatches], {}, quote);
	for (const end of final) assert.notEqual(end.isError, true, JSON.stringify(final));
	for (const end of final.slice(1)) assert.equal(end.result.details?.state, "dispatched");
	assert.equal(escalations.list().find((entry) => entry.id === batch.id)?.status, "answered");
	assert.equal(readFleet(b.home).jobs.length, 2);
});

for (const denied of [false, true]) {
	test(`S29 authority: native schedule member ${denied ? "is denied before authority" : "carries its run origin"}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const runs = new ScheduleRunStore({ home: b.home });
		const mandates = new MandateStore(b.home, { runs });
		const defaults = structuredClone(loadMandateDefaults(b.home));
		const scheduler = new Scheduler({ home: b.home, ledger: () => b.ledger, mandates, runs, usageJobs: () => [], cloneOf: () => b.clone, mintContext: () => ({ defaults, ceiling: defaults.token_ceiling! }) });
		const action = { saved_by: "operator-quote" as const, provenance: { channel: "cp_schedule" as const, tool_call_id: "call-add", quote_sha: "abcdef123456" } };
		const schedule = await scheduler.add({ name: "nightly", project: "demo", native: { action, limits: {} }, manual: true, title: "Nightly bump", kind: "ship", delivery: "local" });
		if (denied) writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), JSON.stringify({ deny_projects: ["demo"] }));
		const fired = await scheduler.fireNow(schedule.id, { via: "cp_schedule", tool_call_id: "call-1" });
		assert.equal(fired.outcome, "fired", fired.reason);
		assert.deepEqual(mandates.list(), []);
		const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: fired.job_id!, task: "Bump x.", model } }] }]);
		if (denied) {
			assert.equal(ends[0]?.isError, true);
			assert.match(JSON.stringify(ends[0]?.result), /project_denied/);
			assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
		} else {
			assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
			assert.equal(readFleet(b.home).jobs[0]?.schedule_id, schedule.id);
			const brief = readFileSync(join(b.home, paths.briefFile(fired.job_id!)), "utf8");
			assert.match(brief, /Started via cp_schedule run_now.*under native policy rev 1/);
			assert.doesNotMatch(brief, /Started by the operator/);
		}
	});
}

test("S29 authority: ops pull selects ops and a second resource user refuses", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const jobs = [];
	for (const title of ["pull ticks", "pull history"]) jobs.push(await b.ledger.create({ title, project: "demo", delivery: "local", kind: "research", labels: ["ops:pull", "resource:tg-session"] }));
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	const ends = await b.run(jobs.map((job) => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Pull ticks.", model } }] })));
	assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
	assert.equal(ends[0]?.result.details?.profile, "ops");
	assert.equal(ends[1]?.isError, true);
	assert.ok(JSON.stringify(ends[1]?.result).includes(`resource:tg-session is leased by live job ${jobs[0]!.id}`));
	assert.deepEqual(readFleet(b.home).jobs.map((record) => record.job_id), [jobs[0]!.id]);
	assert.equal((await b.ledger.show(jobs[1]!.id)).status, "open");
});

test("S29 authority: headless public dispatch preserves planner provenance and classify warnings", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	post.mandates.issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
	const task = "Delete the stale fixture and migrate the test helper.";
	await t.test("classify-only warning", async () => {
		const plain = await b.ledger.create({ title: "unassessed", project: "demo", delivery: "local", kind: "ship" });
		const routing = composeImplementationRouting({});
		const result = await post.dispatch({ jobId: plain.id, task, model, ...routing });
		assert.equal(result.state, "dispatched");
		assert.match("risk_warning" in result ? result.risk_warning ?? "" : "", /issued from operator chat/);
	});
	await t.test("planner high gates", async () => {
		const assessed = await b.ledger.create({ title: "assessed", project: "demo", delivery: "local", kind: "ship", risk: "low" });
		const destructive = composeImplementationRouting({ assessment: { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: true } });
		await assert.rejects(post.dispatch({ jobId: assessed.id, task, model, ...destructive }), /risk:high under ask_on/);
		assert.equal(post.fleet.get(assessed.id), undefined);
	});
	await t.test("planner low warns with provenance", async () => {
		const planned = await b.ledger.create({ title: "planner low", project: "demo", delivery: "local", kind: "ship" });
		const plannedModel = b.provider.addScript("planned-worker", [{ kind: "text", text: "received" }]);
		b.agent.writeModels(b.provider);
		const low = await post.dispatch({ jobId: planned.id, task, model: plannedModel, recordedRisk: { risk: "low", from: "planner", provenance: "assessed" } });
		assert.equal(low.state, "dispatched");
		assert.match("risk_warning" in low ? low.risk_warning ?? "" : "", /risk low was assessed by the planner/);
		assert.equal(post.fleet.get(planned.id)?.routing?.risk, "high");
		assert.equal(post.fleet.get(planned.id)?.routing?.provenance?.risk, "inferred");
		assert.equal(new EscalationStore({ home: b.home }).list({ jobId: planned.id }).length, 0);
		const event = readRunEvents(b.home, planned.id).find((event) => event.type === "routing_resolved");
		assert.equal((event?.payload as Record<string, unknown>)?.risk_warning, "risk_warning" in low ? low.risk_warning : undefined);
		assert.equal(post.fleet.get(planned.id)?.routing?.recorded_risk, "low");
	});
});

test("S29 authority: a reported idle author yields its real process at the spawn cap", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	writeFileSync(join(b.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1 }));
	const author = await b.ledger.create({ title: "held author", project: "demo", delivery: "pr", kind: "ship" });
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: b.clone, encoding: "utf8" }).trim();
	const model = b.provider.addScript("author", [{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "git push --set-upstream origin HEAD" } }] }, { kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: author.id, kind: "ship", status: "done", summary: "Fixture delivery.", branch: author.id, head_sha: sha, pr_url: "https://github.com/example/demo/pull/1" } }] }, { kind: "text", text: "reported" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const first = await post.dispatch({ jobId: author.id, task: "Bump x.", model });
	assert.equal(first.state, "dispatched");
	await waitFor(() => post.fleet.get(author.id), (record) => record?.phase === "held" && post.manager.get(author.id)?.worker.busy === false, { timeoutMs: 30_000 });
	const next = await b.ledger.create({ title: "next", project: "demo", delivery: "local", kind: "ship" });
	const nextModel = b.provider.addScript("next", [{ kind: "text", text: "received" }]);
	b.agent.writeModels(b.provider);
	const watcher = watch(join(b.home, paths.eventsFile(author.id)), () => {
		if (!existsSync(join(b.home, paths.eventsFile(author.id)))) { watcher.close(); return; }
		if (!readRunEvents(b.home, author.id).some((event) => event.type === "held_released")) return;
		writeFileSync(join(b.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1, per_job_tokens: "invalid" }));
		watcher.close();
	});
	t.after(() => watcher.close());
	await assert.rejects(post.dispatch({ jobId: next.id, task: "Bump x.", model: nextModel }), /violates the budget contract/);
	watcher.close();
	writeFileSync(join(b.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1 }));
	assert.equal(post.manager.reserved, 0);
	assert.equal(post.fleet.get(next.id), undefined);
	assert.equal(post.fleet.get(author.id)?.phase, "held");
	const second = await post.dispatch({ jobId: next.id, task: "Bump x.", model: nextModel });
	assert.equal(second.state, "dispatched");
	assert.equal(post.fleet.get(author.id)?.phase, "held");
	assert.equal(post.manager.get(author.id), undefined);
	assert.equal(readRunEvents(b.home, author.id).filter((event) => event.type === "held_released").length, 1);
	const blocked = await b.ledger.create({ title: "no held slot", project: "demo", delivery: "local", kind: "ship" });
	await assert.rejects(post.dispatch({ jobId: blocked.id, task: "Bump x.", model: nextModel }), /spawn cap reached/);
	assert.equal(post.fleet.get(blocked.id), undefined);
});

test("S29 authority: parallelism keeps the real queue head byte-identical until a slot frees", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const lock = acquireParentLock({ home: b.home });
	assert.equal(lock.ok, true);
	if (!lock.ok) return;
	t.after(() => lock.lock.release());
	const firstModel = b.provider.addScript("first", [{ kind: "text", text: "received" }]);
	const secondModel = b.provider.addScript("second", [{ kind: "text", text: "received" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	post.mandates.issue({ projects: ["demo"], objective: "queue", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, dispatch_parallelism: 1 });
	const first = await b.ledger.create({ title: "first", project: "demo", delivery: "local", kind: "ship" });
	const second = await b.ledger.create({ title: "queued", project: "demo", delivery: "local", kind: "ship" });
	assert.equal((await post.dispatch({ jobId: first.id, task: "Bump x.", model: firstModel })).state, "dispatched");
	post.dispatchQueue.enqueue(second.id, { task: "Bump x.", model: secondModel });
	const file = join(b.home, LAYOUT.dispatchQueueFile);
	const before = readFileSync(file, "utf8");
	const refusal = await post.dispatch({ jobId: second.id, task: "Bump x.", model: secondModel }).catch((error: unknown) => error);
	await post.dispatchQueue.drain();
	assert.equal(readFileSync(file, "utf8"), before);
	assert.deepEqual(post.dispatchQueue.ids(), [second.id]);
	assert.equal((refusal as { code?: string }).code, "parallelism_full");
	assert.equal(post.fleet.get(second.id), undefined);
	assert.equal((await post.tearDown(first.id, { force: true })).torn_down, true);
	await post.dispatchQueue.drain();
	await waitFor(() => post.fleet.get(second.id)?.phase, (phase) => phase === "waiting", { timeoutMs: 30_000 });
	assert.deepEqual(post.dispatchQueue.ids(), []);
});

test("S29 authority: a legacy dashboard run names its request without inventing operator preapproval", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const runs = new ScheduleRunStore({ home: b.home });
	const job = await b.ledger.create({ title: "run member", project: "demo", delivery: "local", kind: "ship" });
	const at = isoTimestamp(new Date(Date.now() - 600_000));
	const policy = policyFromLegacy({ id: "sch-123456", name: "Nightly work", project: "demo", mandate_id: "md-123456", enabled: true, created_at: at, trigger: { type: "manual" }, job: { title: "Nightly work", kind: "ship", delivery: "local" } }, {
		seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly work", expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 3,
		allowed_actions: ["implement", "review", "repair"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run nightly work", decided_by: "operator-quote", approved_at: at },
	});
	await runs.savePolicyRevision(policy);
	const click = "sc-20261010030653-11806a8e";
	await runs.createRun({ schema_version: 1, id: "run-20261010030655-53ff68", schedule_id: policy.schedule_id, policy_revision: 1, policy, trigger: { via: "dashboard", at, request_id: click }, anchor_job_id: job.id,
		members: [{ job_id: job.id, role: null, admitted_at: at }], phase: "running", outcome: null, started_at: at, deadline_at: isoTimestamp(new Date(Date.now() + 3_600_000)), risk_preapproved: [], authority_log: [], cap_notices: [] });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", model } }] }]);
	assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
	assert.ok(readFileSync(join(b.home, paths.briefFile(job.id)), "utf8").includes(`> Started via dashboard Run now (request ${click}, ${at}); no operator pre-approval recorded`));
});
