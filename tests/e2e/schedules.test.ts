/**
 * Behavior 12 (Schedules), P13: cp_schedule, the schedule runner and the dashboard control journal in real pi parents
 * on a scratch home, with a mock LLM. Schedules, runs, policies, grants and the ledger are read back from disk.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { MandateStore } from "../../src/mandate.ts";
import { loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { effectivePolicyBounds } from "../../src/schedule-policy.ts";
import { schedulePolicyView } from "../../src/viewer/schedule-policy-view.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { openScheduleRunStore } from "../../src/schedule-runs.ts";
import { appendScheduleControlLine } from "../../src/viewer/control-audit.ts";
import { controlConfigFile, readScheduleControl, scheduleControlFieldError, scheduleControlFile, type ScheduleControlFields, type ScheduleControlOp } from "../../src/viewer/control-files.ts";
import { isNativePolicy, policyFromLegacy, type NativeSchedulePolicy } from "../../src/viewer/schedule-policy.ts";
import type { Schedule } from "../../src/viewer/schedule-core.ts";
import type { ScheduleControlStatusResponse } from "../../src/viewer/api-types.ts";
import { handleScheduleControlStatus } from "../../src/viewer/control-api.ts";
import type { IncomingMessage } from "node:http";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, MOCK_PROVIDER_ID,
	MockProvider, type MockToolCall, type PiChild, readFleet, type RpcRecord, type ScriptStep, startPiChild, waitFor,
} from "../harness/index.ts";

type End = RpcRecord & { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } };

/** A scratch home with project demo cloned onto a treehouse pool, and a mock provider for every pi. */
async function schedulesHome(t: TestContext, options: { held?: boolean; cloneUrl?: string } = {}) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: options.cloneUrl ?? (repo.remote as string), delivery: "pr" });
	const clone = registry.pathOf("demo");
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 8 });
	const provider = await MockProvider.start();
	// A held parent: past 500 context tokens the compaction hold engages and keeps it for a minute.
	const agent = createAgentDir({ provider, ...(options.held ? { settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } } : {}) });
	const holdEnv = options.held ? { CP_PARENT_COMPACT_HOLD_SECONDS: "60" } : {};
	const parents: PiChild[] = [];
	t.after(async () => { for (const child of parents) await child.close(); agent.cleanup(); await provider.stop(); pool.cleanup(); repo.cleanup(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: [`${MOCK_PROVIDER_ID}/*`], rubric: [] }));
	if (options.held) writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 500 }));
	let serial = 0;
	const stateDir = join(home.path, LAYOUT.state);
	const schedules = (): Schedule[] => existsSync(join(stateDir, "schedules.json")) ? (JSON.parse(readFileSync(join(stateDir, "schedules.json"), "utf8")) as { schedules: Schedule[] }).schedules : [];
	const idOf = (name: string): string => {
		const found = schedules().find((entry) => entry.name === name);
		assert.ok(found, `no schedule named ${name}`);
		return found.id;
	};
	const model = (name: string, steps: ScriptStep[]) => {
		const id = provider.addScript(`p13-${name}-${serial++}`, steps, { onExhausted: "repeat" });
		agent.writeModels(provider);
		return id;
	};
	return {
		home: home.path, stateDir, ledger: scratch.ledger, provider, schedules, idOf, model,
		runs: () => openScheduleRunStore(home.path),
		grants: () => new MandateStore(home.path).list(),
		/** A parent pi on this home: prompts `prompt` (the operator's words), runs `steps`, then `settle` each later turn. */
		async parent(prompt: string, steps: ScriptStep[], settle: ScriptStep = { kind: "text", text: "P13 parent settled." }): Promise<PiChild> {
			const child = startPiChild({ cwd: home.path, model: model("parent", [...steps, settle]),
				env: { ...agent.env, ...holdEnv, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
			parents.push(child);
			await child.prompt(prompt);
			await child.waitForSettled(90_000);
			return child;
		},
		async closeParents() { for (const child of parents.splice(0)) await child.close(); },
	};
}

/** Tool results by call id, in order: a replayed call id keeps every result. */
const ends = (child: PiChild): Map<string, End[]> => {
	const byId = new Map<string, End[]>();
	for (const end of child.eventsOfType("tool_execution_end") as End[]) byId.set(end.toolCallId, [...(byId.get(end.toolCallId) ?? []), end]);
	return byId;
};
const said = (end: End | undefined): string => end?.result?.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(end);
const wakes = (child: PiChild) => child.records().filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "cp-schedule");
const schedule = (id: string, args: Record<string, unknown> | (() => Record<string, unknown>)): MockToolCall =>
	({ id, name: "cp_schedule", args: typeof args === "function" ? () => args() : args });

/** The `nth` result of call `id`: `ok` must not be an error, `refused` must be one; either way it matches `pattern`. */
function checkCall(results: Map<string, End[]>, id: string, outcome: "ok" | "refused", pattern: RegExp, nth = 0): string {
	const end = results.get(id)?.[nth];
	assert.ok(end, `${id}#${nth}: no tool result`);
	assert.equal(end.isError === true, outcome === "refused", `${id}: ${said(end)}`);
	assert.match(said(end), pattern, id);
	return said(end);
}

/** The Schedules page's side of the control journal: append a request as the viewer does, read its latest state. */
function dashboard(stateDir: string) {
	const file = scheduleControlFile(stateDir);
	let serial = 0;
	const request = (op: ScheduleControlOp, scheduleId: string, extra: ScheduleControlFields & { at?: Date } = {}) => {
		const { at = new Date(), ...fields } = extra;
		const requestId = `sc-${at.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${String(++serial).padStart(8, "0")}`;
		assert.equal(appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: requestId, at: at.toISOString(), peer: "127.0.0.1", op, schedule_id: scheduleId, ...fields }).ok, true);
		return requestId;
	};
	const state = (requestId: string) => readScheduleControl(stateDir).requests.find((entry) => entry.id === requestId);
	const answered = (requestId: string) => waitFor(() => state(requestId), (entry) => entry !== undefined && !["queued", "applying"].includes(entry.state), { timeoutMs: 15_000, what: `${requestId} answered` });
	/** Request `op` and wait for its answer: `[state, reason]`. */
	const ask = async (op: ScheduleControlOp, scheduleId: string, extra: ScheduleControlFields = {}) => {
		const entry = await answered(request(op, scheduleId, extra));
		return [entry?.state, entry?.reason ?? ""] as const;
	};
	const types = (requestId: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; type: string }).filter((line) => line.id === requestId).map((line) => line.type);
	return { file, request, state, answered, ask, types };
}

test("P13 cp_schedule add and run_now: a naming quote saves an active native revision, a run starts once per tool call, refusals create nothing", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t);
	const add = (id: string, name: string, extra: Record<string, unknown> = {}) => schedule(id, {
		action: "add", name, project: "demo", manual: true, title: `${name} fix`, kind: "ship", delivery: "pr", operator_quote: `Add the ${name} schedule.`, ...extra,
	});
	const prompt = "P13: please add a schedule. Add the nightlyish schedule. Add the nightly schedule. Add the (a+b) schedule. Add the spare schedule.";
	const parent = await h.parent(prompt, [
		{ kind: "tool_calls", calls: [
			add("unnamed", "nightly", { operator_quote: "please add a schedule." }),
			add("partial", "nightly", { operator_quote: "Add the nightlyish schedule." }),
			add("unquoted", "nightly", { operator_quote: undefined }),
			add("mandate", "nightly", { mandate_id: "md-123456", limits: { usd: 1 } }),
			add("refire", "nightly", { refire: true }),
			add("approval", "nightly", { approval_quote: "Yes." }),
			add("nightly", "nightly", { limits: { parallelism: 2 } }),
			add("meta", "(a+b)", { kind: "research", delivery: "answer" }),
			add("spare", "spare"),
		] },
		{ kind: "tool_calls", calls: [
			schedule("run-1", () => ({ action: "run_now", id: h.idOf("nightly"), operator_quote: "never said by anyone", overrides: { model: "mock/fast", parallelism: 1 } })),
		] },
		{ kind: "tool_calls", calls: [
			schedule("run-1", () => ({ action: "run_now", id: h.idOf("nightly") })),
			schedule("run-2", () => ({ action: "run_now", id: h.idOf("nightly") })),
			schedule("missing", { action: "run_now", id: "sch-ffffff" }),
			schedule("disable", () => ({ action: "disable", id: h.idOf("spare") })),
		] },
		{ kind: "tool_calls", calls: [schedule("disabled", () => ({ action: "run_now", id: h.idOf("spare") }))] },
	]);
	const results = ends(parent);
	checkCall(results, "unnamed", "refused", /whole token/);
	checkCall(results, "partial", "refused", /whole token/);
	checkCall(results, "unquoted", "refused", /needs operator_quote/);
	checkCall(results, "mandate", "refused", /cp_schedule add refused: unknown parameter mandate_id/);
	checkCall(results, "refire", "refused", /cp_schedule add refused: unknown parameter refire; a schedule's bounds are its saved policy/);
	checkCall(results, "approval", "refused", /cp_schedule add refused: unknown parameter approval_quote/);
	checkCall(results, "nightly", "ok", /added sch-[0-9a-f]{6}.*\nnative policy revision 1 saved and active/s);
	checkCall(results, "meta", "ok", /added sch-[0-9a-f]{6} \(a\+b\)/);
	const id = h.idOf("nightly");
	const policy = h.runs().activePolicy(id);
	assert.ok(policy && isNativePolicy(policy));
	assert.equal(policy.limits.parallelism, 2);

	const fired = checkCall(results, "run-1", "ok", new RegExp(`schedule nightly \\(${id}\\) fired: created cp-\\S+ under run .*run now via cp_schedule \\(run-1\\)`));
	assert.match(fired, /operator_quote is ignored; the saved native policy authorizes the run/);
	const run = h.runs().openRun(id);
	assert.ok(run);
	assert.equal(run.start_key, "cp_schedule:run-1");
	assert.deepEqual(run.execution?.effective, { model: "mock/fast", parallelism: 1 });
	const jobs = await h.ledger.list({ labels: [`schedule:${id}`], all: true });
	assert.equal(jobs.length, 1);
	assert.match(jobs[0]!.notes ?? "", new RegExp(`run now via cp_schedule \\(run-1\\) for ${id} \\(nightly\\) under run ${run.id}`));
	assert.deepEqual(jobs[0]!.comments, [], "no quote is recorded: none authorized the run");
	assert.equal(wakes(parent).length, 1, "a pr fire wakes the parent like any other fire");
	assert.match(JSON.stringify(wakes(parent)[0]!.message), new RegExp(`Call cp_next: ${jobs[0]!.id} is a member of ${run.id}`));

	checkCall(results, "run-1", "ok", /replayed: start cp_schedule:run-1 was already accepted/, 1);
	checkCall(results, "run-2", "ok", /run now not recorded: already_running/);
	checkCall(results, "missing", "refused", /no schedule sch-ffffff/);
	checkCall(results, "disabled", "refused", new RegExp(`schedule ${h.idOf("spare")} is disabled`));
	assert.equal((await h.ledger.list({ labels: [`schedule:${id}`], all: true })).length, 1);
	assert.deepEqual(await h.ledger.list({ labels: [`schedule:${h.idOf("spare")}`], all: true }), []);
	assert.equal(wakes(parent).length, 1);
	assert.deepEqual(h.grants(), [], "no seed grant and no fire grant");
});

test("P13 cp_schedule adopt and deactivate: one naming quote each, revisions bind run_now, only the lock holder changes authority, a deactivated schedule starts nothing", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t);
	const add = (name: string) => schedule(`add-${name}`, { action: "add", name, project: "demo", manual: true, title: `${name} fix`, kind: "ship", delivery: "pr", operator_quote: `Add the ${name} schedule.` });
	const early = await h.parent("P13: Add the nightly schedule. Add the weekly schedule.", [
		{ kind: "tool_calls", calls: [add("nightly"), add("weekly")] },
		{ kind: "tool_calls", calls: [schedule("unsaid", () => ({ action: "adopt", id: h.idOf("nightly"), operator_quote: `Adopt ${h.idOf("nightly")}.`, revision: 1 }))] },
	]);
	checkCall(ends(early), "unsaid", "refused", /quote not found/);
	await h.closeParents();
	const [id, weekly] = [h.idOf("nightly"), h.idOf("weekly")];
	const adopt = `Adopt ${id}.`;
	const owner = await h.parent(`P13: ${adopt} Yes, please. Deactivate ${weekly}.`, [
		{ kind: "tool_calls", calls: [
			schedule("vague", { action: "adopt", id, operator_quote: "Yes, please.", revision: 1 }),
			schedule("unrevised", { action: "adopt", id, operator_quote: adopt }),
		] },
		{ kind: "tool_calls", calls: [schedule("adopt", { action: "adopt", id, operator_quote: adopt, revision: 1 })] },
		{ kind: "tool_calls", calls: [
			schedule("reused", { action: "deactivate", id, operator_quote: adopt }),
			schedule("stale", { action: "run_now", id, revision: 1 }),
		] },
		{ kind: "tool_calls", calls: [
			schedule("current", { action: "run_now", id, revision: 2 }),
			schedule("off", { action: "deactivate", id: weekly, operator_quote: `Deactivate ${weekly}.` }),
		] },
		{ kind: "tool_calls", calls: [schedule("inactive", { action: "run_now", id: weekly })] },
	]);
	const results = ends(owner);
	checkCall(results, "vague", "refused", /whole token/);
	checkCall(results, "unrevised", "refused", /needs revision/);
	checkCall(results, "adopt", "ok", /revision 2/);
	checkCall(results, "reused", "refused", /already used/);
	checkCall(results, "stale", "refused", /Schedule changed/);
	checkCall(results, "current", "ok", /no grant minted/);
	assert.equal(h.runs().openRun(id)?.policy_revision, 2);
	checkCall(results, "off", "ok", /Deactivated · no new runs until a revision is adopted/);
	checkCall(results, "inactive", "ok", new RegExp(`schedule weekly \\(${weekly}\\) skipped: .*no active native policy`));
	assert.equal(h.runs().runs().filter((run) => run.schedule_id === weekly).length, 0, "no run without an active policy");
	assert.deepEqual(await h.ledger.list({ labels: [`schedule:${weekly}`], all: true }), []);

	// A second parent on the same home does not hold the parent lock: it changes no authority and starts no run.
	const bystander = await h.parent(`P13: ${adopt}`, [{ kind: "tool_calls", calls: [
		schedule("foreign-adopt", { action: "adopt", id, operator_quote: adopt, revision: 2 }),
		schedule("foreign-off", { action: "deactivate", id, operator_quote: adopt }),
		schedule("foreign-run", { action: "run_now", id: weekly }),
	] }]);
	const foreign = ends(bystander);
	checkCall(foreign, "foreign-adopt", "refused", /fleet lock/);
	checkCall(foreign, "foreign-off", "refused", /fleet lock/);
	checkCall(foreign, "foreign-run", "refused", /does not hold the parent lock/);
	assert.equal(h.runs().policyRecord(id)?.active_revision, 2);
	assert.equal(h.runs().runs().length, 1);
	assert.deepEqual(h.grants(), [], "no grant for a run, an adopt or a deactivate");
});

test("P13 runner-owned fires: answer, board and local runs are dispatched in code with no parent wake; a native pipeline starts in code and only a failed start wakes", { timeout: 240_000 }, async (t) => {
	const h = await schedulesHome(t);
	const worker = h.model("worker", [{ kind: "text", text: "P13 worker received." }]);
	const recipes = { "answer-run": ["research", "answer"], "board-run": ["research", "board"], "local-run": ["ship", "local"], "research-run": ["research", "pipeline"], "blocked-run": ["research", "pipeline"] } as const;
	const names = Object.keys(recipes) as Array<keyof typeof recipes>;
	const pipelines = join(h.home, LAYOUT.pipelines);
	t.after(() => { if (existsSync(pipelines)) chmodSync(pipelines, 0o755); });
	const parent = await h.parent(`P13: ${names.map((name) => `Add the ${name} schedule.`).join(" ")}`, [
		{ kind: "tool_calls", calls: names.map((name) => schedule(`add-${name}`, {
			action: "add", name, project: "demo", manual: true, title: `${name} task`, kind: recipes[name][0], delivery: recipes[name][1], operator_quote: `Add the ${name} schedule.`,
		})) },
		{ kind: "tool_calls", calls: names.filter((name) => name !== "blocked-run").map((name) => schedule(`run-${name}`, () => ({ action: "run_now", id: h.idOf(name), overrides: { model: worker } }))) },
		// The pipeline store turns read-only before the last fire: its start fails after the run and anchor exist.
		{ kind: "tool_calls", calls: [schedule("run-blocked-run", () => { chmodSync(pipelines, 0o555); return { action: "run_now", id: h.idOf("blocked-run"), overrides: { model: worker } }; })] },
	]);
	const results = ends(parent);
	for (const name of names) checkCall(results, `add-${name}`, "ok", /added sch-/);
	for (const name of names) checkCall(results, `run-${name}`, "ok", /fired: created cp-/);
	const anchor = (name: string) => h.runs().runs().find((run) => run.schedule_id === h.idOf(name))?.anchor_job_id as string;
	for (const name of ["answer-run", "board-run", "local-run", "research-run"]) {
		const record = await waitFor(() => readFleet(h.home).jobs.find((job) => job.job_id === anchor(name)), Boolean, { timeoutMs: 60_000, what: `${name}'s anchor dispatched` });
		assert.equal(record?.schedule_id, h.idOf(name));
	}
	for (const name of ["answer-run", "board-run", "local-run"]) {
		assert.match(readFileSync(join(h.home, paths.briefFile(anchor(name))), "utf8"), new RegExp(`${name} task`), `${name}: the runner hands the recipe as the task`);
	}
	const answered = h.runs().runs().find((run) => run.schedule_id === h.idOf("answer-run"));
	assert.equal(answered?.authority_log.at(-1)?.use, "dispatch", "the run, not a grant, authorized the dispatch");

	const research = anchor("research-run");
	const pipeline = JSON.parse(readFileSync(join(h.home, paths.pipelineFile(research)), "utf8")) as { ship_id: string };
	const ship = await h.ledger.show(pipeline.ship_id);
	assert.ok(ship.labels.includes(`schedule:${h.idOf("research-run")}`));
	assert.ok(h.runs().runs().find((run) => run.schedule_id === h.idOf("research-run"))?.members.some((member) => member.job_id === ship.id && member.role === "ship"));
	assert.equal(readFleet(h.home).jobs.filter((job) => job.job_id === research).length, 1, "the planner was dispatched once");

	const blocked = h.idOf("blocked-run");
	await waitFor(() => wakes(parent).length, (count) => count > 0, { timeoutMs: 20_000, what: "the failed pipeline start's wake" });
	assert.equal(wakes(parent).length, 1, "only the failed pipeline start wakes the parent");
	assert.match(JSON.stringify(wakes(parent)[0]!.message), new RegExp(`schedule blocked-run \\(${blocked}\\) could not start its pipeline on ${anchor("blocked-run")}`));
	assert.equal(existsSync(join(h.home, paths.pipelineFile(anchor("blocked-run")))), false);
	assert.deepEqual(h.grants(), []);
});

test("P13 held parent: a pr fire's job and run exist before the held wake is released once by compaction; runner-owned fires dispatch at once", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t, { held: true });
	const worker = h.model("worker", [{ kind: "text", text: "P13 worker received." }]);
	const usage = { prompt_tokens: 1000, completion_tokens: 1 };
	const add = (name: string, kind: string, delivery: string) => schedule(`add-${name}`, { action: "add", name, project: "demo", manual: true, title: `${name} task`, kind, delivery, operator_quote: `Add the ${name} schedule.` });
	const parent = await h.parent("P13: Add the pr-run schedule. Add the answer-run schedule.", [
		{ kind: "tool_calls", calls: [add("pr-run", "ship", "pr"), add("answer-run", "research", "answer")] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }], usage },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "node -e 'setTimeout(() => {}, 2000)'" } }], usage },
		{ kind: "tool_calls", usage, calls: [
			schedule("pr", () => ({ action: "run_now", id: h.idOf("pr-run") })),
			schedule("answer", () => ({ action: "run_now", id: h.idOf("answer-run"), overrides: { model: worker } })),
		] },
		{ kind: "tool_calls", usage, calls: [schedule("again", () => ({ action: "run_now", id: h.idOf("pr-run") }))] },
	], { kind: "text", text: "P13 held parent settled.", usage });
	const results = ends(parent);
	const fired = checkCall(results, "pr", "ok", /fired: created cp-/);
	checkCall(results, "again", "ok", /already_running/);
	assert.match(readFileSync(join(h.stateDir, "daemon.log"), "utf8"), /hold engaged/);
	const [job] = await h.ledger.list({ labels: [`schedule:${h.idOf("pr-run")}`], all: true });
	assert.ok(job && h.runs().openRun(h.idOf("pr-run")), "the job and its run exist while the wake is held");
	const answer = h.runs().openRun(h.idOf("answer-run"))?.anchor_job_id;
	await waitFor(() => readFleet(h.home).jobs.find((entry) => entry.job_id === answer), Boolean, { timeoutMs: 60_000, what: "runner-owned dispatch while held" });
	assert.equal(wakes(parent).length, 0, "no parent transport during the hold");

	parent.send({ type: "compact", id: "compact" });
	assert.equal((await parent.waitFor((r) => r.type === "response" && r.id === "compact", 30_000)).success, true);
	await parent.waitFor(() => wakes(parent).length === 1, 30_000);
	const message = wakes(parent)[0]!.message as { content?: unknown; details?: { job_id?: string } };
	assert.deepEqual([message.content, message.details?.job_id], [fired, job.id]);
	await parent.waitForSettled(30_000);
	assert.equal(wakes(parent).length, 1, "a released wake is delivered once");
	assert.deepEqual(h.grants(), [], "release mints no grant");
});

test("P13 dashboard schedule control: a live parent claims each journaled request before acting and answers it once; stale, expired, foreign, unjournaled and opted-out requests act on nothing", { timeout: 180_000 }, async (t) => {
	const h = await schedulesHome(t);
	const add = (name: string) => schedule(`add-${name}`, { action: "add", name, project: "demo", cron: "0 9 * * *", tz: "UTC", title: `${name} report`, kind: "research", delivery: "answer", operator_quote: `Add the ${name} schedule.` });
	await h.parent("P13: Add the nightly schedule. Add the dormant schedule.", [{ kind: "tool_calls", calls: [add("nightly"), add("dormant")] }]);
	await h.closeParents();
	const [id, dormant] = [h.idOf("nightly"), h.idOf("dormant")];
	const parent = await h.parent(`P13: Deactivate ${dormant}.`, [{ kind: "tool_calls", calls: [
		schedule("off", { action: "deactivate", id: dormant, operator_quote: `Deactivate ${dormant}.` }),
		schedule("disable", { action: "disable", id: dormant }),
	] }]);
	checkCall(ends(parent), "off", "ok", /Deactivated/);
	const { file, request, state, answered, types } = dashboard(h.stateDir);
	const enabled = (scheduleId: string) => h.schedules().find((entry) => entry.id === scheduleId)?.enabled;

	const stale = request("run_now", id, { revision: 0 });
	assert.match((await answered(stale))!.reason ?? "", /Schedule changed/);
	assert.deepEqual([state(stale)?.state, types(stale)], ["refused", ["request", "claimed", "outcome"]], "claimed before refused");
	const off = request("disable", id);
	assert.deepEqual([(await answered(off))?.state, state(off)?.reason, enabled(id), types(off)], ["done", `disabled ${id}`, false, ["request", "claimed", "outcome"]]);
	const on = request("enable", id);
	assert.deepEqual([(await answered(on))?.state, enabled(id)], ["done", true]);
	const run = request("run_now", id);
	const fired = await answered(run);
	assert.equal(fired?.state, "done");
	const job = await h.ledger.show(fired?.job_id as string);
	assert.match(job.title, /nightly run now \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
	const opened = h.runs().runs().find((entry) => entry.schedule_id === id);
	assert.match(job.notes ?? "", new RegExp(`^run now from the dashboard \\(${run}\\) for ${id} \\(nightly\\) under run ${opened?.id} \\(native policy rev 1; start dashboard:${run}\\)$`));
	assert.equal(h.schedules().find((entry) => entry.id === id)?.last_fire, undefined, "a run now never writes last_fire");
	const again = request("run_now", id);
	assert.deepEqual([(await answered(again))?.state, /already_running/.test(state(again)?.reason ?? "")], ["refused", true]);
	const size = readFileSync(file).length;
	await new Promise((resolve) => setTimeout(resolve, 4_500));
	assert.equal(readFileSync(file).length, size, "later polls append nothing");
	const revive = request("enable", dormant);
	assert.match((await answered(revive))?.reason ?? "", new RegExp(`enable ${dormant} refused: schedule ${dormant} has no active native policy`));
	assert.equal(enabled(dormant), false);

	// Negative controls: none of these act, and the journal says why.
	const old = request("disable", id, { at: new Date(Date.now() - 121_000) });
	const foreign = request("disable", id);
	appendScheduleControlLine(h.stateDir, { type: "claimed", by: "parent", id: foreign, at: new Date().toISOString(), pid: 999_999 });
	assert.match((await answered(old))?.reason ?? "", /within 120 s/);
	assert.deepEqual([(await answered(foreign))?.state, /parent pid 999999/.test(state(foreign)?.reason ?? "")], ["interrupted", true]);
	const unjournaled = request("disable", id);
	chmodSync(file, 0o444);
	await new Promise((resolve) => setTimeout(resolve, 4_500));
	assert.deepEqual([state(unjournaled)?.state, types(unjournaled), enabled(id)], ["queued", ["request"], true], "no claim, no act");
	chmodSync(file, 0o644);
	assert.equal((await answered(unjournaled))?.state, "done", "the parent applies it once it can claim it");
	writeFileSync(controlConfigFile(h.stateDir), '{"enabled": false}');
	const optedOut = request("enable", id);
	assert.match((await answered(optedOut))?.reason ?? "", /dashboard control is off/);
	assert.equal(enabled(id), false);
	const gone = request("remove", id);
	assert.match((await answered(gone))?.reason ?? "", /dashboard control is off/);
	writeFileSync(controlConfigFile(h.stateDir), '{"enabled": true}');
	const removed = request("remove", id);
	assert.deepEqual([(await answered(removed))?.state, state(removed)?.reason, h.schedules().map((entry) => entry.id)], ["done", `removed ${id}`, [dormant]]);
	assert.ok(parent.stderr().includes(`schedule control ${removed} remove ${id}: done`));
	assert.equal((await h.ledger.list({ labels: [`schedule:${id}`], all: true })).length, 1, "one run now, one job");
	const shown = handleScheduleControlStatus({} as IncomingMessage, { home: h.home, stateDir: h.stateDir, host: "127.0.0.1", port: 0, requireTailnet: true }).body as ScheduleControlStatusResponse;
	const byId = new Map(shown.requests.map((entry) => [entry.id, entry]));
	assert.deepEqual([stale, off, run, again, old, foreign].map((requestId) => byId.get(requestId)?.state), ["refused", "done", "done", "refused", "expired", "interrupted"]);
	assert.equal(byId.get(run)?.job_id, job.id, "the dashboard reads the run now's job back");
});

test("P13 dashboard policy activation: saves and adopts bind revisions while open runs keep their frozen policy, deactivation drains authority, invalid or overfull saves change nothing, no grant is minted", { timeout: 240_000 }, async (t) => {
	const h = await schedulesHome(t);
	const add = (name: string) => schedule(`add-${name}`, { action: "add", name, project: "demo", manual: true, title: `${name} report`, kind: "ship", delivery: "pr", operator_quote: `Add the ${name} schedule.` });
	const adder = await h.parent("P13: Add the nightly schedule. Add the spare schedule.", [{ kind: "tool_calls", calls: [add("nightly"), add("spare")] }]);
	for (const name of ["nightly", "spare"]) checkCall(ends(adder), `add-${name}`, "ok", /added sch-/);
	const [id, spare] = [h.idOf("nightly"), h.idOf("spare")];
	const d = dashboard(h.stateDir);
	const answer = async (op: ScheduleControlOp, fields: ScheduleControlFields, state: string, reason: RegExp, scheduleId = id) => {
		const [got, why] = await d.ask(op, scheduleId, fields);
		assert.equal(got, state, `${op}: ${why}`);
		assert.match(why, reason, op);
	};
	const record = () => h.runs().policyRecord(id)!;
	const defaultsFile = join(h.home, LAYOUT.data, "mandate-defaults.json");

	await answer("run_now", { revision: 1 }, "done", /created cp-\S+ under run .*no grant minted/);
	const open = h.runs().openRun(id)!;
	await answer("adopt", { revision: 1 }, "refused", /open legacy\/run job/);
	assert.equal(record().revisions.length, 1);
	const draft = structuredClone(h.runs().activePolicy(id)!) as NativeSchedulePolicy;
	draft.recipe.title = "Next recipe";
	draft.limits.tokens = 2_000_000;
	await answer("save_policy", { revision: 1, policy: draft }, "done", /./);
	assert.equal(h.runs().activePolicy(id)?.recipe.title, "Next recipe");
	assert.equal(h.runs().run(open.id)?.policy.recipe.title, "nightly report", "the open run keeps its frozen policy");
	await answer("save_policy", { revision: 1, policy: draft }, "refused", /Schedule changed/);
	await answer("deactivate", {}, "refused", /open run/);

	// Invalid authority and overfull live bounds leave the policy bytes alone.
	const before = readFileSync(h.runs().policiesFile, "utf8");
	const approving = structuredClone(h.runs().activePolicy(id)!);
	approving.effects.push("org_review_approve");
	// The dashboard refuses it before journaling; a forged line is ignored by the parent.
	assert.match(scheduleControlFieldError({ op: "save_policy", revision: 2, policy: approving }) ?? "", /invalid schedule policy/);
	const forged = d.request("save_policy", id, { revision: 2, policy: approving });
	const excludes = (length: number, tag: string) => Array.from({ length }, (_, i) => `${tag}-${i}`);
	writeFileSync(defaultsFile, JSON.stringify({ ...loadMandateDefaults(h.home), exclude_paths: excludes(20, "home") }));
	const overfull = structuredClone(h.runs().activePolicy(id)!);
	overfull.exclusions.paths = excludes(13, "own");
	await answer("save_policy", { revision: 2, policy: overfull }, "refused", /33 paths, over the 32/);
	const shipless = structuredClone(h.runs().activePolicy(id)!);
	shipless.exclusions.job_kinds = ["ship"];
	await answer("save_policy", { revision: 2, policy: shipless }, "refused", /excludes ship jobs/);
	writeFileSync(defaultsFile, JSON.stringify({ ...loadMandateDefaults(h.home), token_ceiling: 0 }));
	await answer("save_policy", { revision: 2, policy: draft }, "refused", /token_ceiling is 0: .*nothing to spend/);
	assert.equal(d.state(forged), undefined);
	writeFileSync(defaultsFile, JSON.stringify({ ...loadMandateDefaults(join(h.home, "absent")), exclude_paths: excludes(33, "home") }));
	assert.match(schedulePolicyView(h.stateDir, id).blocking.join(";"), /32/);
	writeFileSync(defaultsFile, "{");
	assert.match(schedulePolicyView(h.stateDir, id).blocking.join(";"), /unreadable/);
	const defaults = { ...loadMandateDefaults(join(h.home, "absent")), token_ceiling: 500_000, exclude_paths: ["home-private"] };
	writeFileSync(defaultsFile, JSON.stringify(defaults));
	// demo's own mandate override narrows the preview and every later save, as it narrows a fire.
	const projectsFile = join(h.home, LAYOUT.projectsFile);
	const registry = JSON.parse(readFileSync(projectsFile, "utf8")) as { projects: { name: string; mandate?: object }[] };
	const projectOverride = { exclude_paths: ["project-private"] };
	registry.projects.find((entry) => entry.name === "demo")!.mandate = projectOverride;
	writeFileSync(projectsFile, JSON.stringify(registry));
	const policy = h.runs().activePolicy(id)!;
	const preview = schedulePolicyView(h.stateDir, id).effective;
	assert.deepEqual(preview, effectivePolicyBounds(policy, { defaults, ceiling: defaults.token_ceiling, projectOverride }, "demo", "ship", new Date()));
	assert.ok(preview?.exclusions.paths?.includes("project-private"), "the preview narrows to the project override");
	assert.equal(readFileSync(h.runs().policiesFile, "utf8"), before, "no refused save and no preview wrote the policies");

	// The open run settles; the next parent's first tick closes it.
	await h.ledger.close(open.anchor_job_id!, "completed");
	await h.closeParents();
	await h.parent("P13: carry on.", []);
	await waitFor(() => h.runs().run(open.id)?.phase, (phase) => phase === "closed", { timeoutMs: 20_000, what: "the settled run closed" });
	await answer("run_now", { revision: 1 }, "refused", /Schedule changed/);
	await answer("adopt", { revision: 2 }, "done", /./);
	assert.deepEqual([record().revisions.length, record().active_revision], [3, 3]);
	const adopted = h.runs().activePolicy(id)!;
	assert.equal(adopted.limits.tokens, 500_000, "the adopted revision's tokens clamp to the home's token_ceiling");
	assert.deepEqual(adopted.exclusions.paths, [...new Set([...policy.exclusions.paths ?? [], "home-private", "project-private"])], "exclusions only grow");
	const excluding = structuredClone(h.runs().activePolicy(id)!);
	excluding.exclusions.paths = excludes(13, "own");
	await answer("save_policy", { revision: 3, policy: excluding }, "done", /./);
	const kept = h.runs().activePolicy(id)!.exclusions;
	writeFileSync(defaultsFile, JSON.stringify({ ...defaults, exclude_paths: excludes(20, "home") }));
	await answer("run_now", { revision: 4 }, "refused", /over the 32/);
	const off = d.request("deactivate", id);
	assert.equal((await d.answered(off))?.state, "done", "deactivation drains authority even when bounds forbid new runs");
	assert.deepEqual([record().active_revision, record().revisions.length, record().revisions.at(-1)?.provenance.request_id], [null, 5, off]);
	assert.deepEqual(record().revisions.at(-1)?.exclusions, kept, "the deactivated revision keeps its bounds");
	await answer("run_now", { revision: 0 }, "refused", /no active native policy/);

	// The editor opens a legacy snapshot; the operator's save lands a native revision.
	const legacy = policyFromLegacy({ ...h.schedules().find((entry) => entry.id === id)!, mandate_id: "md-123456" }, { seed_mandate_id: "md-123456", channel: "operator_chat", objective: "Nightly report",
		expiry_hours: 1, spend_usd: 10, spend_tokens: 1000, job_cap: 3, allowed_actions: ["plan"], ask_on: ["merge", "risk:high"], approval: { operator_quote: "Run the nightly report", decided_by: "operator-quote", approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") } });
	await answer("save_policy", { revision: 5, policy: legacy }, "done", /./);
	assert.ok(isNativePolicy(h.runs().activePolicy(id)!));
	assert.deepEqual([record().active_revision, h.runs().activePolicy(id)?.limits.usd], [6, legacy.limits.usd]);

	writeFileSync(defaultsFile, "{");
	const drained = d.request("deactivate", spare);
	assert.equal((await d.answered(drained))?.state, "done", "deactivation needs no readable live admission context");
	assert.deepEqual([h.runs().activePolicy(spare), h.runs().policyRecord(spare)?.revisions.at(-1)?.provenance.request_id], [undefined, drained]);
	assert.deepEqual(h.grants(), [], "no grant audit, synthetic grant or fallback grant");
	assert.equal((await h.ledger.list({ labels: [`schedule:${id}`], all: true })).length, 1);
});

test("P13 restart recovery: a skill anchor is offered once per parent process until expanded, a run that crashed before its anchor heals, and settled runs close completed or partial", { timeout: 240_000 }, async (t) => {
	const h = await schedulesHome(t, { cloneUrl: "https://github.com/acme/demo.git" });
	const first = await h.parent("P13: Add the pr-review schedule. Add the nightly schedule.", [{ kind: "tool_calls", calls: [
		schedule("add-review", { action: "add", name: "pr-review", project: "demo", manual: true, title: "PR review", kind: "research", delivery: "local",
			skill: "cp-pr-review", description: "pr: https://github.com/acme/demo/pull/1", operator_quote: "Add the pr-review schedule." }),
		schedule("add-nightly", { action: "add", name: "nightly", project: "demo", manual: true, title: "nightly fix", kind: "ship", delivery: "pr", operator_quote: "Add the nightly schedule." }),
	] }]);
	checkCall(ends(first), "add-review", "ok", /added sch-/);
	const [review, nightly] = [h.idOf("pr-review"), h.idOf("nightly")];
	assert.equal(wakes(first).length, 0, "startup cannot fire a manual schedule");
	const d = dashboard(h.stateDir);
	assert.equal((await d.ask("run_now", review))[0], "done");
	await waitFor(() => wakes(first).length, (count) => count === 1, { timeoutMs: 20_000, what: "the skill fire's wake" });
	const [anchor] = await h.ledger.list({ labels: [`schedule:${review}`], all: true });
	assert.equal(anchor?.status, "deferred");
	const live = wakes(first)[0]!.message as { content?: string; details?: Record<string, unknown> };
	assert.match(JSON.stringify(live.content), /run now via the dashboard/);
	assert.deepEqual([live.details?.schedule_id, live.details?.job_id, live.details?.skill], [review, anchor!.id, "cp-pr-review"]);

	// A crash between the run's acceptance and its anchor attachment leaves an accepted run with no anchor.
	assert.equal((await d.ask("run_now", nightly))[0], "done");
	await h.closeParents();
	const crashed = h.runs().openRun(nightly)!;
	h.runs().editRun(crashed.id, (row) => Object.assign(row, { anchor_job_id: null, phase: "accepted", members: [] }));
	const second = await h.parent("P13: second process.", []);
	await waitFor(() => wakes(second).length, (count) => count === 1, { timeoutMs: 20_000, what: "the restart's expansion wake" });
	assert.match(JSON.stringify((wakes(second)[0]!.message as { content?: unknown }).content), /use skill cp-pr-review to expand it now/);
	const healed = h.runs().run(crashed.id)!;
	assert.equal(healed.phase, "running");
	assert.equal(healed.anchor_job_id, crashed.anchor_job_id, "the run re-attaches its own anchor from the ledger");
	assert.equal(h.runs().runOfJob(crashed.anchor_job_id!)?.id, crashed.id);
	await second.waitForSettled(30_000);
	assert.equal(wakes(second).length, 1, "one offer per process");

	await h.ledger.comment(anchor!.id, `expanded: L1 ${anchor!.id}`);
	await h.ledger.close(crashed.anchor_job_id!, "completed after recovery");
	await h.closeParents();
	const third = await h.parent("P13: third process.", []);
	await waitFor(() => h.runs().run(crashed.id)?.outcome, (outcome) => outcome === "completed", { timeoutMs: 20_000, what: "the healed run closed" });
	assert.equal((await d.ask("run_now", nightly))[0], "done");
	const partial = h.runs().openRun(nightly)!;
	await h.ledger.drop(partial.anchor_job_id!, "cap refusal");
	await h.closeParents();
	const fourth = await h.parent("P13: fourth process.", []);
	await waitFor(() => h.runs().run(partial.id)?.outcome, (outcome) => outcome === "partial", { timeoutMs: 20_000, what: "the dropped run closed partial" });
	const offers = (child: PiChild) => wakes(child).filter((r) => JSON.stringify(r.message).includes("cp-pr-review")).length;
	assert.deepEqual([offers(third), offers(fourth)], [0, 0], "an expanded anchor is never recovered");
	assert.equal((await h.ledger.show(anchor!.id)).status, "deferred");
	assert.equal((await h.ledger.list({ labels: [`schedule:${review}`], all: true })).length, 1);
	assert.equal(existsSync(join(h.stateDir, "fleet.json")), false, "a local skill anchor belongs to the parent: nothing was dispatched");
	assert.deepEqual(h.grants(), [], "recovery and release mint no grant");
});
