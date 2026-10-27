/**
 * Behavior 23 (Memory and guidance), P23b: cp_next through a real parent pi on a scratch home with a mock LLM.
 * Jobs and grants are seeded through cp_job and cp_mandate, answers through cp_decide; fleet records are written to
 * fleet.json as a dispatching parent writes them, and the spawn-cap case dispatches hanging workers via cp_dispatch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, SCHEMA_VERSION } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { MandateStore } from "../../src/mandate.ts";
import type { NextResult, NextSnapshot } from "../../src/next.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, MockProvider, type MockToolCall,
	type PiChild, REPO_ROOT, type RpcRecord, type ScriptStep, startPiChild, treehouseAvailable,
} from "../harness/index.ts";

type End = RpcRecord & { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
const CLOCK = pathToFileURL(join(REPO_ROOT, "tests/harness/process-clock.ts")).href;
const HOUR = 3_600_000;
const DEAD = 2 ** 22 + 1; // above the default pid_max, so never a live process
const said = (end: End | undefined): string => end?.result?.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(end);
const details = (end: End | undefined): Record<string, unknown> => end?.result?.details ?? {};
const call = (id: string, name: string, args: Record<string, unknown>): MockToolCall => ({ id, name, args });
const later = (shift = 24 * HOUR) => isoTimestamp(new Date(Date.now() + shift));
const views = (result: NextResult): NextResult[] => [result, ...(result.others ?? [])];
const viewOf = (result: NextResult, mandateId: string) => views(result).find((view) => view.mandate?.id === mandateId);
const GRANT = { spend_usd: 100, spend_tokens: 1_000_000, job_cap: 10 };

/** A fleet record as a dispatching parent writes it: a working implementer on a live pid unless `extra` overrides. */
function rec(jobId: string, extra: Partial<FleetRecord> & { pid?: number } = {}): FleetRecord {
	const { pid = process.pid, ...rest } = extra;
	return { job_id: jobId, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "waiting", worktree: `/wt/${jobId}`, branch: jobId,
		worker: { pid, session_id: `sess-${jobId}`, session_file: `/sessions/${jobId}.jsonl`, profile: "implementer", role: "implementer", model: "mock/mock-model", started_at: isoTimestamp() },
		dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, ...rest } as FleetRecord;
}

/** A scratch home with registered `projects` whose parents run on a clock `h.shift(ms)` moves. */
async function nextHome(t: TestContext, projects = ["demo"], setup?: (home: string) => Promise<void>) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const clock = join(agent.path, "clock-offset");
	writeFileSync(clock, "0");
	const parents: PiChild[] = [];
	t.after(async () => { for (const child of parents) await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const scratch = createScratchLedger({ home: home.path, knownProjects: projects });
	for (const name of projects) await new ProjectRegistry({ home: home.path }).register({ name, clone_url: `https://example.invalid/${name}.git` });
	await setup?.(home.path);
	const path = (relative: string) => join(home.path, relative);
	let serial = 0;
	return {
		home: home.path, path, provider, agent, ledger: scratch.ledger,
		shift: (shift: number) => writeFileSync(clock, String(shift)),
		put(relative: string, text: string) { mkdirSync(dirname(path(relative)), { recursive: true }); writeFileSync(path(relative), text); },
		fleet(jobs: FleetRecord[]) { this.put(LAYOUT.fleetFile, `${JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs }, null, 2)}\n`); },
		escalations: () => new EscalationStore({ home: home.path }),
		mandates: () => new MandateStore(home.path),
		snapshot: () => JSON.parse(readFileSync(path(`${LAYOUT.state}/next-snapshot.json`), "utf8")) as NextSnapshot,
		/** A parent pi on this home; `run` is one operator prompt whose model makes each step's calls, one step at a time. */
		parent() {
			const steps: ScriptStep[] = [];
			const script = `p23b-next-${++serial}`;
			const model = provider.addScript(script, steps);
			agent.writeModels(provider);
			const child = startPiChild({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION],
				env: { ...agent.env, CP_HOME: home.path, CP_TEST_CLOCK_FILE: clock, NODE_OPTIONS: `--import ${CLOCK}` } });
			parents.push(child);
			const after = (from: number, match: (r: RpcRecord) => boolean) => child.waitFor((r) => child.records().indexOf(r) >= from && match(r), 120_000);
			const run = async (calls: Array<MockToolCall | MockToolCall[]>, prompt = "What next?"): Promise<Map<string, End>> => {
				steps.push(...calls.map((one): ScriptStep => ({ kind: "tool_calls", calls: Array.isArray(one) ? one : [one] })), { kind: "text", text: "P23b parent settled." });
				const from = child.records().length;
				await child.prompt(prompt);
				await after(from, (r) => r.type === "agent_settled");
				const ends = child.records().slice(from).filter((r) => r.type === "tool_execution_end") as End[];
				return new Map(ends.map((end) => [end.toolCallId, end]));
			};
			const ok = (ends: Map<string, End>, id: string): End => {
				const end = ends.get(id);
				assert.ok(end && end.isError !== true, `${id}: ${said(end)}`);
				return end;
			};
			return {
				child, steps, run, ok,
				/** One cp_next call: its full result (details) and the text the model read. */
				async next(args: Record<string, unknown> = { project: "demo" }): Promise<{ result: NextResult; text: string }> {
					const end = ok(await run([call("next", "cp_next", args)]), "next");
					return { result: details(end) as unknown as NextResult, text: said(end) };
				},
				/** Create one job per title through cp_job; returns their ids in order. */
				async jobs(titles: string[], extra: Record<string, unknown> = {}): Promise<string[]> {
					const ends = await run(titles.map((title, i) => call(`job${i}`, "cp_job", { action: "create", title, project: "demo", delivery: "pr", kind: "ship", ...extra })));
					return titles.map((_, i) => String((details(ok(ends, `job${i}`)).job as { id: string }).id));
				},
				/** Issue one grant through cp_mandate; returns its id. */
				async grant(args: Record<string, unknown>): Promise<string> {
					const ends = await run([call("grant", "cp_mandate", { action: "issue", projects: ["demo"], objective: "ship it", expiry: later(), ...GRANT, ...args })]);
					return String(details(ok(ends, "grant")).id);
				},
				async job(action: string, args: Record<string, unknown>): Promise<End> {
					return ok(await run([call("job", "cp_job", { action, ...args })]), "job");
				},
				async mandate(action: string, mandateId: string): Promise<End> {
					return ok(await run([call("mandate", "cp_mandate", { action, mandate_id: mandateId })]), "mandate");
				},
			};
		},
	};
}

test("P23b-next-dispatch: cp_next names no grant without one, dispatches a dependent once its blocker closes, stops on pause and offers nothing past expiry", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const none = await p.next();
	assert.deepEqual([none.result.action.kind, none.result.mandate], ["no_mandate", undefined]);

	const [first, second] = await p.jobs(["first", "second"]);
	await p.job("dep_add", { job_id: second, blocker_id: first });
	const grant = await p.grant({ objective: "ship the pair" });
	const before = (await p.next()).result;
	assert.deepEqual([before.action.kind, before.action.job_id, before.ready.map((job) => job.id)], ["dispatch", first, [first]]);
	await p.job("close", { job_id: first, reason: "https://example.com/pr/1" });
	const after = (await p.next()).result;
	assert.deepEqual([after.mandate?.id, after.action.kind, after.action.job_id], [grant, "dispatch", second], "the second job dispatches with no operator message");
	assert.equal(h.escalations().open().filter((item) => item.kind === "mission_end").length, 0, "a project-wide grant invents no mission end on the first close");

	await p.mandate("pause", grant);
	const paused = (await p.next()).result;
	assert.equal(paused.action.kind, "paused");
	assert.match(paused.action.reason, /paused/);
	await p.mandate("resume", grant);
	h.shift(48 * HOUR);
	const lapsed = (await p.next()).result;
	assert.deepEqual([lapsed.action.kind, lapsed.action.job_id], ["no_mandate", undefined], "an expired grant offers no fresh work");
});

test("P23b-next-slots: parallelism, a held delivery, the job cap and the fleet total decide the recommendation; a drain refuses", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t, ["demo", "other"]);
	const p = h.parent();
	await p.jobs(["a", "b", "c"]);
	const grant = await p.grant({ objective: "ship three", dispatch_parallelism: 2 });
	const queue = (await p.next()).result.ready.map((job) => job.id);
	const [a, b, c] = queue as [string, string, string];
	const first = (await p.next()).result;
	assert.deepEqual([first.action.kind, first.action.job_id], ["dispatch", a]);
	await p.job("claim", { job_id: a });
	h.fleet([rec(a)]);
	const second = (await p.next()).result;
	assert.deepEqual([second.action.kind, second.action.job_id], ["dispatch", b], "one live worker leaves room under parallelism 2");
	await p.job("claim", { job_id: b });
	h.fleet([rec(a), rec(b)]);
	const third = (await p.next()).result;
	assert.equal(third.action.kind, "wait");
	assert.match(third.action.reason, /full/);
	assert.deepEqual(third.ready.map((job) => job.id), [c]);

	// A held PR waiting on CI takes no working slot, but its spend and its job still count.
	const usage = { ...EMPTY_USAGE, total_tokens: 500, cost_usd: 0.25 };
	h.fleet([rec(a, { phase: "held", reported_at: isoTimestamp(), usage }), rec(b, { phase: "held", reported_at: isoTimestamp() })]);
	const held = (await p.next()).result;
	assert.deepEqual([held.action.kind, held.action.job_id], ["dispatch", c], "a PR waiting on CI is not a working worker");
	assert.equal(held.mandate?.live_workers, 0);
	assert.deepEqual([held.mandate?.tokens, held.mandate?.spend_usd, held.mandate?.jobs_used], [500, 0.25, 2], "held still counts toward spend and jobs");
	h.fleet([rec(a, { usage }), rec(b)]);
	const working = (await p.next()).result;
	assert.deepEqual([working.action.kind, working.mandate?.live_workers], ["wait", 2]);

	await p.mandate("revoke", grant);
	const [d] = await p.jobs(["d"]);
	const capped = await p.grant({ objective: "one job", job_cap: 1 });
	await p.job("claim", { job_id: c });
	h.fleet([rec(c, { phase: "held", reported_at: isoTimestamp() })]);
	const atCap = (await p.next()).result;
	assert.deepEqual([atCap.mandate?.id, atCap.mandate?.status, atCap.action.kind, atCap.ready.map((job) => job.id)], [capped, "active", "wait", [d]]);
	assert.match(atCap.action.reason, /job cap 1 reached .* no new dispatch/);

	// Four working records under another project's grant: informational, never a quota; a held one is not counted.
	await p.mandate("revoke", capped);
	const wide = await p.grant({ objective: "ship it", dispatch_parallelism: 3 });
	await p.grant({ projects: ["other"], objective: "elsewhere", dispatch_parallelism: 5 });
	h.fleet(["cp-o1", "cp-o2", "cp-o3", "cp-o4"].map((id) => rec(id, { project: "other" })).concat(rec("cp-h1", { project: "other", phase: "held", reported_at: isoTimestamp() })));
	const total = await p.next();
	assert.equal(total.result.fleet_live_workers, 4, "held records are not counted");
	assert.deepEqual([total.result.mandate?.id, total.result.mandate?.live_workers, total.result.action.kind], [wide, 0, "dispatch"]);
	assert.match(total.text, /fleet: 4 in-flight worker records .* informational, not a dispatch quota: each grant's parallelism decides admission, held deliveries take no slot, and cp_dispatch queues at a full spawn cap/);
	assert.match(total.text, new RegExp(`action: dispatch ${total.result.action.job_id}`));

	await p.mandate("pause", wide);
	const pausedView = await p.next();
	assert.deepEqual([pausedView.result.action.kind, pausedView.result.mandate?.live_workers, pausedView.result.fleet_live_workers], ["paused", 0, 4]);
	assert.match(pausedView.text, new RegExp(`${wide}: paused, 0/3 workers working under this mandate`));
	assert.doesNotMatch(pausedView.text, /workers working across all mandates/);
	await p.mandate("resume", wide);

	h.put(`${LAYOUT.state}/drain.json`, JSON.stringify({ state: "draining", started_at: "2026-08-27T12:00:00Z", deadline: "2026-08-27T12:10:00Z", timeout_s: 600, jobs: [] }));
	const drained = await p.next();
	assert.equal(drained.result.action.kind, "draining");
	assert.match(drained.text, /action: draining — draining since 2026-08-27T12:00:00Z/);
	assert.match(h.snapshot().unavailable[0]?.error ?? "", /^not read: draining since/);
});

test("P23b-next-grants: a newer active grant outranks an older paused one, a token cap is the parent's to raise, earlier usage never fills a grant, and a full broad grant never vetoes a named supplement", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	h.fleet(["cp-h1", "cp-h2"].map((id) => rec(id, { phase: "done", usage: { ...EMPTY_USAGE, total_tokens: 20_000_000, cost_usd: 200 } })));
	const [job] = await p.jobs(["job"]);
	h.shift(-120_000);
	const old = await p.grant({ objective: "old", spend_tokens: 1_000 });
	const history = (await p.next()).result;
	assert.deepEqual([history.mandate?.id, history.mandate?.status, history.action.kind, history.action.job_id], [old, "active", "dispatch", job]);
	assert.deepEqual([history.mandate?.spend_usd, history.mandate?.tokens, history.mandate?.jobs_used], [0, 0, 0], "usage before the grant never fills its caps");
	h.shift(-90_000);
	await p.mandate("revoke", await p.grant({ objective: "revoked" }));
	h.shift(0);
	h.fleet([rec("cp-x", { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 90_000_000, cache_read: 89_998_000 } })]);
	const capped = (await p.next()).result;
	assert.deepEqual([capped.mandate?.id, capped.mandate?.tokens, capped.action.kind], [old, 2_000, "paused"], "non-cached tokens only");
	assert.match(capped.action.reason, /\(token_cap\).*decide it yourself: cp_mandate raise_tokens/);
	const fresh = await p.grant({ objective: "fresh" });
	const next = (await p.next()).result;
	assert.deepEqual([next.mandate?.id, next.action.kind], [fresh, "dispatch"], "the active grant wins over the earlier-issued paused one");

	// tv8: a broad grant at its job cap; a later named grant still speaks for its job, and the target counts on both.
	await p.mandate("revoke", old);
	await p.mandate("revoke", fresh);
	h.shift(-60_000);
	const broad = await p.grant({ objective: "sweep", job_cap: 3 });
	h.shift(0);
	const spent = (id: string) => rec(id, { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, cost_usd: 1, total_tokens: 100 } });
	const olds = ["cp-old1", "cp-old2", "cp-old3"].map(spent);
	h.fleet(olds);
	const named = await p.grant({ objective: "sweep", job_cap: 3, job_ids: [job] });
	const supplement = (await p.next()).result;
	assert.deepEqual([supplement.mandate?.id, supplement.action.kind, supplement.action.job_id], [named, "dispatch", job]);
	assert.deepEqual((supplement.others ?? []).flatMap((view) => view.ready.map((entry) => entry.id)), [], "one selected ready partition");
	h.fleet([...olds, rec(job as string, { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, cost_usd: 2, total_tokens: 200 } })]);
	const broadView = viewOf((await p.next()).result, broad);
	assert.deepEqual([broadView?.mandate?.jobs_used, broadView?.mandate?.spend_usd, broadView?.mandate?.tokens], [4, 5, 500], "overlapping coverage still counts the target");
});

test("P23b-next-selected: a full selected named grant waits without falling back to a broad one", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [first, second] = await p.jobs(["first", "second"]) as [string, string];
	h.shift(-60_000);
	const broad = await p.grant({ objective: "ship", dispatch_parallelism: 1 });
	h.shift(0);
	const named = await p.grant({ objective: "ship", job_cap: 1, dispatch_parallelism: 1, job_ids: [first, second] });
	await p.job("claim", { job_id: first });
	h.fleet([rec(first, { phase: "held", reported_at: isoTimestamp() })]);
	const full = (await p.next()).result;
	assert.equal(views(full).some((view) => view.action.kind === "dispatch"), false, "the broad grant is no fallback");
	assert.match(viewOf(full, named)?.action.reason ?? "", new RegExp(`${named} job cap 1 reached`));
	await p.mandate("revoke", named);
	const serial = await p.grant({ objective: "ship", dispatch_parallelism: 1, job_ids: [first, second] });
	h.fleet([rec(first)]);
	const busy = (await p.next()).result;
	assert.equal(views(busy).some((view) => view.action.kind === "dispatch"), false);
	assert.match(viewOf(busy, serial)?.action.reason ?? "", new RegExp(`${serial} dispatch-parallelism 1 is full`));
	assert.ok(viewOf(busy, broad), "the broad grant is still evaluated");
});

test("P23b-next-dead-research: reported research held with a dead worker is named for cp_teardown; a ship hold and a live pid are not", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [job] = await p.jobs(["next"]);
	await p.grant({});
	const held = (id: string, kind: "ship" | "research", pid: number) => rec(id, { kind, delivery: kind === "ship" ? "pr" : "local", phase: "held", reported_at: isoTimestamp(), pid });
	h.fleet([held("cp-ship", "ship", DEAD), held("cp-live", "research", process.pid)]);
	const quiet = (await p.next()).result;
	assert.doesNotMatch(quiet.warning ?? "", /dead worker/, "a ship hold and a live research worker never warn");
	assert.deepEqual([quiet.action.kind, quiet.action.job_id], ["dispatch", job]);
	h.fleet([held("cp-ship", "ship", DEAD), held("cp-live", "research", process.pid), ...["cp-r1", "cp-r2", "cp-r3", "cp-r4"].map((id) => held(id, "research", DEAD))]);
	const warned = await p.next();
	assert.match(warned.result.warning ?? "", /reported research with a dead worker: cp-r1 — cp_teardown cp-r1; cp-r2 — cp_teardown cp-r2; cp-r3 — cp_teardown cp-r3; \+1 more$/m);
	assert.doesNotMatch(warned.result.warning ?? "", /cp-ship|cp-live/);
	assert.deepEqual([warned.result.action.kind, warned.result.action.job_id], ["dispatch", job], "the recommendation is unchanged");
	assert.match(warned.text, /^warning: .*cp_teardown cp-r1/m);
	const fleet = JSON.parse(readFileSync(h.path(LAYOUT.fleetFile), "utf8")) as { jobs: FleetRecord[] };
	assert.equal(fleet.jobs.find((record) => record.job_id === "cp-r1")?.phase, "held", "cp_next never tears anything down");
});

test("P23b-next-schedules: a schedule grant offers only its own pr and fan-out jobs, never a runner-owned answer or deferred anchor, and a project-wide grant covers no scheduled job", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	// cp_job create refuses a schedule: label outside a fire, so the scheduled jobs are written to the ledger directly.
	const scheduled = (title: string, delivery: "pr" | "local" | "answer", kind: "ship" | "research", schedule = "sch-def456") =>
		h.ledger.create({ title, project: "demo", delivery, kind, labels: [`schedule:${schedule}`] });
	const [unrelated] = await p.jobs(["unrelated"]);
	await scheduled("digest", "answer", "research");
	const nightly = await scheduled("nightly fix", "pr", "ship");
	await scheduled("another schedule's fix", "pr", "ship", "sch-aaa111");
	const anchor = await scheduled("Self-review (run now)", "local", "research");
	await h.ledger.update(anchor.id, { status: "deferred" });
	const child = await scheduled(`L1 [${anchor.id}]`, "local", "research");
	const grant = await p.grant({ objective: "nightly", schedule_grant: true });
	const schedule = { id: "sch-def456", name: "sch-def456", project: "demo", mandate_id: grant, trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" },
		job: { title: "nightly", kind: "ship", delivery: "pr" }, enabled: true, created_at: "2026-01-01T00:00:00Z" };
	h.put(`${LAYOUT.state}/schedules.json`, JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	const only = (await p.next()).result;
	assert.equal(only.mandate?.id, grant);
	assert.deepEqual([only.action.kind, only.action.job_id, only.ready.map((job) => job.id)], ["dispatch", nightly.id, [nightly.id]], "never the answer job or another schedule's");
	// A parent-expanded self-review schedule: its fan-out child is offered, never the deferred anchor.
	h.put(`${LAYOUT.state}/schedules.json`, JSON.stringify({ schema_version: 1, schedules: [{ ...schedule, trigger: { type: "manual" },
		job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" } }] }));
	const fanOut = (await p.next()).result.ready.map((job) => job.id);
	assert.ok(fanOut.includes(child.id) && !fanOut.includes(anchor.id), fanOut.join(","));
	h.put(`${LAYOUT.state}/schedules.json`, "not json");
	assert.deepEqual((await p.next()).result.ready, [], "an unreadable schedules.json covers nothing");
	await p.mandate("revoke", grant);
	const wide = await p.grant({});
	const projectWide = (await p.next()).result;
	assert.deepEqual([projectWide.mandate?.id, projectWide.ready.map((job) => job.id)], [wide, [unrelated]], "a project-wide grant covers no scheduled job");
});

test("P23b-next-mission-end: a messy finish asks once and refreshes its cost, a clean one closes itself, and every finished grant raises its own", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [messy, failed, clean] = await p.jobs(["messy", "failed", "clean"]) as [string, string, string];
	const messyGrant = await p.grant({ objective: "messy", job_ids: [messy] });
	await p.job("drop", { job_id: messy, reason: "not needed" });
	const failedGrant = await p.grant({ objective: "failed", job_ids: [failed] });
	await p.job("close", { job_id: failed, reason: "https://example.com/pr/9" });
	const failure = { class: "wall_clock_exceeded" as const, message: "bound", at: isoTimestamp() };
	h.fleet([rec(messy, { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 100, cost_usd: 9.23 } }), rec(failed, { phase: "failed", failure })]);
	const raised = (await p.next()).result;
	for (const [grant, label] of [[messyGrant, "dropped"], [failedGrant, "failed"]] as const) {
		const view = viewOf(raised, grant);
		assert.equal(view?.action.kind, "mission_end", label);
		assert.equal(h.escalations().get(view?.escalation_id ?? "")?.status, "open", label);
		assert.equal(h.mandates().get(grant)?.status, "active", label);
		assert.doesNotMatch(view?.action.reason ?? "", /landed clean/, label);
	}
	const messyEnd = viewOf(raised, messyGrant)?.escalation_id ?? "";
	assert.match(h.escalations().get(messyEnd)?.question ?? "", /cost \$9\.23$/);
	h.fleet([rec(messy, { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, total_tokens: 200, cost_usd: 9.95 } }), rec(failed, { phase: "failed", failure })]);
	const again = (await p.next()).result;
	assert.equal(viewOf(again, messyGrant)?.escalation_id, messyEnd, "the same escalation, not a second one");
	assert.equal(viewOf(again, messyGrant)?.mandate?.spend_usd, 9.95);
	assert.match(h.escalations().get(messyEnd)?.question ?? "", /cost \$9\.95$/, "the open record reads what the mandate reads");
	assert.equal(h.escalations().open().filter((item) => item.job_ids.includes(messy)).length, 1);
	const both = (await p.next({ project: "demo", full: true })).text;
	for (const grant of [messyGrant, failedGrant]) assert.match(both, new RegExp(`${grant}: every named job is closed`));

	await p.mandate("revoke", messyGrant);
	await p.mandate("revoke", failedGrant);
	const cleanGrant = await p.grant({ objective: "ship the one job", job_ids: [clean] });
	await p.job("close", { job_id: clean, reason: "https://example.com/pr/10" });
	const closed = (await p.next()).result;
	assert.equal(closed.action.kind, "mission_end");
	assert.match(closed.action.reason, /landed clean/);
	const record = h.escalations().get(closed.escalation_id ?? "");
	assert.deepEqual([record?.status, record?.answer, record?.answered_by], ["answered", "close", `mandate:${cleanGrant}`]);
	assert.equal((record?.basis as { mandate?: string } | undefined)?.mandate, cleanGrant, "the auto decision is journaled with its basis");
	assert.equal(h.mandates().get(cleanGrant)?.status, "revoked");
	assert.equal(h.escalations().open().filter((item) => item.mandate_id === cleanGrant).length, 0, "nothing is asked");
	assert.equal((await p.next()).result.action.kind, "no_mandate");
	assert.equal(h.escalations().list({ kind: "mission_end" }).filter((item) => item.mandate_id === cleanGrant).length, 1, "one terminal record");
});

test("P23b-next-mission-order: the grant with work leads, each finished grant raises its own mission end, and 18 waiting grants stay within 25 lines", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [a, b, c] = await p.jobs(["a", "b", "c"]) as [string, string, string];
	h.shift(-60_000);
	const first = await p.grant({ objective: "first", job_ids: [a] });
	h.shift(-30_000);
	const second = await p.grant({ objective: "second", job_ids: [b] });
	h.shift(-10_000);
	const third = await p.grant({ objective: "third", job_ids: [c] });
	h.shift(0);
	await p.job("drop", { job_id: a, reason: "not needed" });
	await p.job("drop", { job_id: b, reason: "not needed" });
	const { result, text } = await p.next();
	assert.deepEqual([result.mandate?.id, result.action.kind, result.action.job_id], [third, "dispatch", c], "the grant with work to dispatch leads");
	assert.deepEqual((result.others ?? []).map((other) => [other.mandate?.id, other.action.kind]), [[first, "mission_end"], [second, "mission_end"]]);
	const open = h.escalations().open().filter((item) => item.kind === "mission_end");
	assert.deepEqual(open.map((item) => item.mandate_id).sort(), [first, second].sort(), "one mission end per finished grant");
	assert.deepEqual((result.others ?? []).map((other) => other.escalation_id).sort(), open.map((item) => item.id).sort());
	assert.match(text, new RegExp(`${first}: every named job is closed[\\s\\S]*${second}: every named job is closed`));

	for (const id of [first, second, third]) await p.mandate("revoke", id);
	await p.job("drop", { job_id: c, reason: "not needed" });
	await p.run([Array.from({ length: 18 }, (_, i) => call(`g${i}`, "cp_mandate", { action: "issue", projects: ["demo"], objective: `topic ${i}`, expiry: later(), ...GRANT }))]);
	const many = await p.next();
	assert.equal(many.result.others?.length, 17);
	assert.ok(many.text.split("\n").length <= 25, many.text);
	const other = many.result.others![0]!;
	assert.match(many.text, new RegExp(`^${other.mandate!.id}: active 0/3, jobs 0/10 \u2014 wait: nothing ready under this mandate$`, "m"));
});

test("P23b-next-answered-end: a mission end answered close or extend is terminal and never re-asked; a replacement grant asks its own", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [closeJob, extendJob] = await p.jobs(["close me", "extend me"]) as [string, string];
	const grants = { close: await p.grant({ objective: "one", job_ids: [closeJob] }), extend: await p.grant({ objective: "two", job_ids: [extendJob] }) };
	await p.job("drop", { job_id: closeJob, reason: "not needed" });
	await p.job("drop", { job_id: extendJob, reason: "not needed" });
	const raised = (await p.next()).result;
	const asked = { close: viewOf(raised, grants.close)?.escalation_id ?? "", extend: viewOf(raised, grants.extend)?.escalation_id ?? "" };
	for (const answer of ["close", "extend"] as const) {
		const quote = `${asked[answer]}: ${answer}`;
		p.ok(await p.run([call("decide", "cp_decide", { target: asked[answer], decision: answer, basis: { operator_quote: quote } })], quote), "decide");
	}
	await p.mandate("revoke", grants.close);
	for (let n = 0; n < 3; n += 1) {
		const again = (await p.next()).result;
		assert.equal(viewOf(again, grants.close), undefined, "a closed grant is revoked, never evaluated again");
		const extended = viewOf(again, grants.extend);
		assert.deepEqual([extended?.action.kind, extended?.escalation_id], ["mission_end", asked.extend]);
		assert.match(extended?.action.reason ?? "", /already answered "extend" .* not re-asked/);
	}
	assert.deepEqual(h.escalations().list({ kind: "mission_end" }).map((item) => [item.id, item.status]).sort(),
		[[asked.close, "answered"], [asked.extend, "answered"]].sort(), "one terminal record each, no fresh open one");
	const replacement = await p.grant({ objective: "three", job_ids: [closeJob] });
	const own = viewOf((await p.next()).result, replacement);
	assert.equal(own?.action.kind, "mission_end");
	assert.notEqual(own?.escalation_id, asked.close, "a new grant has its own identity");
	assert.equal(h.escalations().get(own?.escalation_id ?? "")?.status, "open");
});

test("P23b-next-blocked: a blocked job names its blocker under every standing of the blocker's grant, and the status block derives it", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const states = ["active", "paused", "expired", "revoked", "uncovered"] as const;
	const pairs = new Map<string, { blocker: string; dependent: string; owner: string }>();
	for (const state of states) {
		const [blocker, dependent] = await p.jobs([`base ${state}`, `follow-up ${state}`]) as [string, string];
		await p.job("dep_add", { job_id: dependent, blocker_id: blocker });
		const owner = await p.grant({ objective: `work ${state}`, job_ids: [dependent] });
		if (state !== "uncovered") {
			const base = await p.grant({ objective: `base ${state}`, job_ids: [blocker], expiry: later(state === "expired" ? HOUR : 24 * HOUR) });
			if (state === "paused") await p.mandate("pause", base);
			if (state === "revoked") await p.mandate("revoke", base);
		}
		pairs.set(state, { blocker, dependent, owner });
	}
	h.shift(2 * HOUR);
	const result = (await p.next()).result;
	for (const state of states) {
		const { blocker, dependent, owner } = pairs.get(state)!;
		const own = viewOf(result, owner)!;
		assert.equal(own.action.kind, "wait", state);
		assert.match(own.action.reason, new RegExp(`${dependent}.*${blocker}`), state);
		assert.match(own.action.reason, state === "active" ? /waiting on/ : state === "uncovered" ? /no active grant covers it/ : new RegExp(state), state);
		assert.deepEqual(own.ready, [], state);
	}
	const { blocker, dependent } = pairs.get("uncovered")!;
	const block = said(p.ok(await p.run([call("block", "cp_status_block", {})]), "block"));
	assert.match(block, new RegExp(`Blocked:[\\s\\S]*${dependent}.*${blocker}.*no active grant covers it`));
	assert.deepEqual(h.escalations().open().filter((item) => item.kind === "scope_expansion"), [], "neither read asks a question");
});

test("P23b-next-dropped-dependency: a dropped blocker asks once per pair, proceed, drop and reopen resolve through cp_decide, and an uncovered pair is only named", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [loose, looseDep] = await p.jobs(["loose base", "loose follow-up"]) as [string, string];
	await p.job("dep_add", { job_id: looseDep, blocker_id: loose });
	await p.job("drop", { job_id: loose, reason: "not doing it" });
	const uncovered = await p.next();
	assert.equal(uncovered.result.action.kind, "no_mandate");
	assert.match(uncovered.text, new RegExp(`${looseDep}.*${loose}.*closed as dropped`));
	assert.deepEqual(h.escalations().open(), [], "an uncovered dependent raises no question");

	const answers = ["proceed", "drop", "reopen"] as const;
	const pairs = new Map<string, { blocker: string; dependent: string }>();
	for (const answer of answers) {
		const [blocker, dependent] = await p.jobs([`base ${answer}`, `follow-up ${answer}`]) as [string, string];
		await p.job("dep_add", { job_id: dependent, blocker_id: blocker });
		await p.job("drop", { job_id: blocker, reason: "no result" });
		// Two covering grants must not mint two questions for the same pair.
		for (const n of [0, 1]) await p.grant({ objective: `work ${answer} ${n}`, job_ids: [dependent] });
		pairs.set(answer, { blocker, dependent });
	}
	const first = await p.next();
	assert.match(first.text, /closed as dropped/);
	await p.next({ project: "demo", full: true });
	const questions = h.escalations().open().filter((item) => item.kind === "scope_expansion");
	assert.equal(questions.length, 3, "one question per pair");
	for (const answer of answers) {
		const { blocker, dependent } = pairs.get(answer)!;
		const question = questions.find((item) => item.job_ids.includes(dependent))!;
		assert.match(question.question, new RegExp(`${dependent}.*${blocker}.*no result`));
		assert.deepEqual(question.options.map((option) => option.id), ["proceed", "drop", "reopen"]);
		const decide = (decision: string) => call(decision, "cp_decide", { target: question.id, decision, basis: { operator_quote: `${question.id}: ${answer}` } });
		const ends = await p.run([decide("maybe"), decide(answer)], `${question.id}: ${answer}`);
		assert.match(said(ends.get("maybe")), /proceed.*drop.*reopen/);
		p.ok(ends, answer);
	}
	const shown = async (id: string) => details(p.ok(await p.run([call("show", "cp_job", { action: "show", job_id: id })]), "show")).job as { status: string; close_reason?: string; blocked_by: string[]; comments: Array<{ text: string }> };
	assert.deepEqual((await shown(pairs.get("proceed")!.dependent)).blocked_by, []);
	assert.equal((await shown(pairs.get("drop")!.dependent)).status, "closed");
	assert.match((await shown(pairs.get("drop")!.dependent)).close_reason ?? "", /dropped:.*no result/);
	const reopened = await shown(pairs.get("reopen")!.blocker);
	assert.deepEqual([reopened.status, reopened.close_reason], ["open", undefined]);
	assert.ok(reopened.comments.some((comment) => comment.text.includes("no result")), "reopening preserves the dropped history");
	assert.deepEqual((await shown(pairs.get("reopen")!.dependent)).blocked_by, [pairs.get("reopen")!.blocker]);
	const after = (await p.next({ project: "demo", full: true })).result;
	assert.ok(views(after).some((view) => view.ready.some((job) => job.id === pairs.get("proceed")!.dependent)), "a proceeded dependent is ready");
	assert.equal(h.escalations().list({ kind: "scope_expansion" }).length, 3, "an answered pair is never asked again");
});

test("P23b-next-dependents: two dependents of one dropped blocker get one question each from concurrent reads, and the blocked list stays bounded", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [blocker, one, two] = await p.jobs(["base", "one", "two"]) as [string, string, string];
	for (const id of [one, two]) await p.job("dep_add", { job_id: id, blocker_id: blocker });
	await p.job("drop", { job_id: blocker, reason: "not delivered" });
	await p.grant({ objective: "the dependents", job_ids: [one, two] });
	await p.run([[call("n1", "cp_next", { project: "demo", full: true }), call("n2", "cp_next", { project: "demo", full: true })]]);
	const questions = h.escalations().open();
	assert.deepEqual(questions.map((item) => item.job_ids[0]).sort(), [one, two].sort());
	const rendered = (await p.next({ project: "demo", full: true })).text;
	for (const question of questions) assert.match(rendered, new RegExp(`cp_decide ${question.id}`));

	const bases = await p.jobs(Array.from({ length: 5 }, (_, i) => `base ${i}`));
	const followers = await p.jobs(Array.from({ length: 15 }, (_, i) => `follow-up ${i}`));
	await p.run(followers.flatMap((id, i) => bases.map((base, j) => call(`d${i}-${j}`, "cp_job", { action: "dep_add", job_id: id, blocker_id: base }))));
	const bounded = (await p.next({ project: "demo", full: true })).text;
	assert.match(bounded, /\+2 more blockers/);
	assert.match(bounded, /\+7 more jobs/);
	assert.ok(bounded.length < 5000);
});

test("P23b-next-repeat: an identical cp_next answer is one line until full, compaction or a new session; a change is whole; a mission end prints the curation count; the snapshot keeps its since", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t, ["demo", "other"]);
	const p = h.parent();
	const first = (await p.next()).text;
	assert.match(first, /no active mandate/);
	const emptyAt = h.snapshot();
	assert.equal(emptyAt.action.kind, "no_mandate", "#323: every call persists the snapshot");
	const second = (await p.next()).text;
	assert.match(second, /^cp_next unchanged since \S+: nothing new/);
	assert.equal(second.split("\n").length, 1, "the repeat is one line");
	assert.deepEqual([h.snapshot().empty_since, h.snapshot().items], [emptyAt.at, []], "nothing queued keeps its since");
	assert.equal((await p.next({ project: "other" })).text.includes("unchanged since"), false, "another project scope has its own last answer");
	assert.equal(h.snapshot().empty_since, h.snapshot().at, "another scope starts its own since");
	assert.equal((await p.next({ project: "demo", full: true })).text, first, "full: true is the escape after losing context");
	assert.match((await p.next()).text, /unchanged since/);
	p.steps.push({ kind: "text", text: "P23b compaction summary." });
	p.child.send({ type: "compact", id: "compact" });
	const compacted = await p.child.waitFor((r) => r.type === "response" && r.id === "compact", 60_000);
	assert.equal(compacted.success, true, JSON.stringify(compacted));
	assert.equal((await p.next()).text, first, "a compaction forgets what was shown");
	assert.match((await p.next()).text, /unchanged since/);
	p.child.send({ type: "new_session", id: "rotate" });
	await p.child.waitFor((r) => r.type === "response" && r.id === "rotate", 60_000);
	assert.equal((await p.next()).text, first, "a rotated session forgets what was shown");

	const [only] = await p.jobs(["only job"]);
	const grant = await p.grant({ objective: "ship the one job", job_ids: [only] });
	await p.job("drop", { job_id: only, reason: "not needed" });
	assert.match((await p.next()).text, /action: mission_end[\s\S]*\nmemory: 0 pending candidate\(s\) \u2014 cp_memory curate only when above 0$/);
	await p.mandate("revoke", grant);
	assert.equal((await p.next()).text, first, "a change and back is news, not a repeat");
});

test("P23b-next-snapshot: the snapshot lines up uncovered, blocked, dispatch and wait verdicts per job", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	const [first, second, after] = await p.jobs(["first", "second", "after"]) as [string, string, string];
	await p.job("dep_add", { job_id: after, blocker_id: first });
	const byId = (rows: string[][]) => [...rows].sort((x, y) => x[0]!.localeCompare(y[0]!));
	const verdicts = () => byId(h.snapshot().items.map((item) => [item.id, item.verdict]));
	await p.next();
	assert.deepEqual(verdicts(), byId([[after, "blocked"], [first, "uncovered"], [second, "uncovered"]]), "no grant: lined up, never nothing queued");
	assert.equal(h.snapshot().empty_since, null);
	await p.grant({ objective: "ship", dispatch_parallelism: 1 });
	const head = (await p.next()).result.action.job_id!;
	const other = head === first ? second : first;
	assert.deepEqual(verdicts(), byId([[head, "dispatch"], [other, "wait"], [after, "blocked"]]));
	assert.equal(h.snapshot().items.find((item) => item.id === other)?.reason, `after ${head}`);
});

test("P23b-next-spawn-cap: below the spawn cap cp_next dispatches plainly; at it, it still recommends dispatch and says cp_dispatch queues it; a queued job is never ready and holds a slot", { skip: !treehouseAvailable(), timeout: 300_000 }, async (t) => {
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "demo\n" } });
	let pool: ReturnType<typeof enableTreehouse> | undefined;
	const h = await nextHome(t, [], async (home) => {
		const registry = new ProjectRegistry({ home });
		await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
		execFileSync("git", ["clone", "--quiet", repo.remote as string, registry.pathOf("demo")]);
		pool = enableTreehouse(registry.pathOf("demo"), { maxTrees: 2 });
		mkdirSync(join(home, LAYOUT.data), { recursive: true });
		writeFileSync(join(home, LAYOUT.budgetsFile), JSON.stringify({ schema_version: SCHEMA_VERSION, per_job_tokens: 100000, per_job_cost_usd: 10, warn_ratio: 0.8, spawn_cap: 1 }));
	});
	t.after(() => { pool?.cleanup(); repo.cleanup(); });
	const hang = [h.provider.addScript("p23b-hang-1", [{ kind: "hang" }]), h.provider.addScript("p23b-hang-2", [{ kind: "hang" }])];
	const p = h.parent();
	await p.jobs(["a", "b", "c"], { delivery: "local" });
	const grant = await p.grant({ objective: "ship three", dispatch_parallelism: 2 });
	const [x1, x2, x3] = (await p.next()).result.ready.map((job) => job.id) as [string, string, string];
	const room = (await p.next({ project: "demo", full: true })).result;
	assert.deepEqual([room.action.kind, room.action.job_id, room.action.reason], ["dispatch", x1, `dispatch ${x1} under ${grant}`]);
	p.ok(await p.run([call("d1", "cp_dispatch", { job_id: x1, task: "hold", model: hang[0] })]), "d1");
	const added = JSON.parse(readFileSync(h.path(LAYOUT.fleetFile), "utf8")) as { updated_at: string; jobs: FleetRecord[] };
	assert.deepEqual([added.jobs.map((job) => job.job_id), added.updated_at.endsWith("Z")], [[x1], true], "dispatch adds one validated record");
	assert.deepEqual(readdirSync(h.path(LAYOUT.state)).filter((name) => name.startsWith("fleet")), ["fleet.json"], "the add leaves no temp file");
	const full = await p.next();
	assert.deepEqual([full.result.action.kind, full.result.action.job_id], ["dispatch", x2], "a full spawn cap still recommends dispatch");
	assert.match(full.text, new RegExp(`action: dispatch ${x2} \u2014 spawn cap 1 full: 1 live worker processes \u2014 cp_dispatch queues it`));
	const queuedEnd = p.ok(await p.run([call("d2", "cp_dispatch", { job_id: x2, task: "hold", model: hang[1] })]), "d2");
	assert.match(said(queuedEnd), /spawn cap reached|queued/);
	const queued = (await p.next()).result;
	assert.deepEqual(queued.ready.map((job) => job.id), [x3], "a queued job is not ready");
	assert.equal(queued.action.kind, "wait", "the queued job holds the other slot");
	assert.match(queued.action.reason, /dispatch-parallelism 2 is full — waiting on an in-flight job \(1 queued\)/);
	const items = h.snapshot().items;
	assert.equal(items.find((item) => item.id === x2)?.verdict, "queued");
	assert.match(items.find((item) => item.id === x3)?.reason ?? "", /dispatch-parallelism 2 is full .*1 queued/, "why a ready job is not running");
});

// withReviewerSpend builds one run-membership set per call: a 600-job fleet still counts exactly, and a torn runs file refuses.
test("P23b-next-large-fleet: cp_next counts a large fleet in one pass and an invalid schedule-runs file still refuses it", { timeout: 300_000 }, async (t) => {
	const h = await nextHome(t);
	const p = h.parent();
	h.shift(-60_000);
	const grant = await p.grant({ objective: "big fleet", job_cap: 1_000 });
	h.shift(0);
	h.fleet(Array.from({ length: 600 }, (_, i) => rec(`cp-big${i}`, { phase: "held", reported_at: isoTimestamp(), usage: { ...EMPTY_USAGE, cost_usd: 0.01, total_tokens: 10 } })));
	const view = viewOf((await p.next()).result, grant);
	assert.deepEqual([view?.mandate?.jobs_used, view?.mandate?.tokens], [600, 6_000], "every fleet job counts once");
	h.put(`${LAYOUT.state}/schedule-runs.json`, "{ not json");
	const end = (await p.run([call("torn", "cp_next", { project: "demo" })])).get("torn");
	assert.equal(end?.isError, true, said(end));
	assert.equal(said(end).match(/schedule-runs\.json is not valid JSON/g)?.length, 1, "the refusal is named once");
});
