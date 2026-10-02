/**
 * Routing T7: the epic's behaviour where its parts meet.
 *
 * T1-T6 each proved their own half against its own seam, and green helper tests
 * are not the same claim as "a dispatch does this". Three joins had no test at
 * all, and each of them is a place a regression would be invisible:
 *
 *  1. **inference -> record -> spawn.** A parent that supplies only `scope` for
 *     work whose words name production credentials must route high, record that
 *     it did, and *launch* that model at that effort. `tests/routing.test.ts`
 *     proves the resolver, `tests/dispatch.test.ts` proves a dispatch — nothing
 *     proved the argv agrees with the fleet record on a route nobody named.
 *  2. **preview == dispatch.** The preview is only worth having if it answers
 *     the question a dispatch would answer. It was tested for what it does not
 *     touch, never against the dispatch that followed it.
 *  3. **the shipped default, as an operator meets it.** cp-routing-t4 removed
 *     the planner catch-all so QA and ordinary planning fall through to their
 *     profiles — through `scaffoldHome`'s copy-once, from `loadRoutingConfig`,
 *     into the dispatch path that picks the profile. And a home that already
 *     has a routing.json keeps its own rows, catch-all included: this epic
 *     migrates nobody.
 *
 * Deliberately not re-proved here, because it already is:
 *   - pipeline impact retention, recovery and reanchor — `tests/pipeline.test.ts`
 *     ("routing T2: …", "pipeline: without a human answer nothing is dispatched");
 *   - reviewer inputs and the effort a reviewer actually spawns —
 *     `tests/gate.test.ts`, `tests/diff-review.test.ts`, `tests/quality.test.ts`
 *     (all assert `argOf(spawn.args, "--thinking")`);
 *   - the lint, the nudge and doctor's routing findings — `tests/routing.test.ts`,
 *     `tests/doctor.test.ts`.
 *
 * No inference API is called and no live config is read: the models are the
 * mock provider's, the homes are scratch dirs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EMPTY_USAGE, LAYOUT, paths, type RoutingConfig, type RunEvent } from "../src/contracts.ts";
import { CapacityReader } from "../src/capacity.ts";
import { Dispatcher, type DispatcherOptions } from "../src/dispatch.ts";
import { FleetStore } from "../src/fleet.ts";
import { LeaseManager } from "../src/leases.ts";
import type { Ledger } from "../src/ledger.ts";
import { Preflight } from "../src/preflight.ts";
import { ProjectRegistry } from "../src/projects.ts";
import { ALWAYS_AVAILABLE, loadRoutingConfig, reviewerRoutingInputs } from "../src/routing.ts";
import { scaffoldHome } from "../src/scaffold.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	argOf,
	type CapturedSpawn,
	captureSpawns,
	createAgentDir,
	createScratchHome,
	createScratchLedger,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	readFleet,
	readRunEvents,
	REPO_ROOT,
	treehouse,
	treehouseAvailable,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");
const SKIP = treehouseAvailable() ? false : "br and treehouse are required for the integrated routing tests";

// ---------------------------------------------------------------------------
// 1 + 2: one dispatch, from the words of the job to the argv of the worker
// ---------------------------------------------------------------------------

interface Bench {
	home: string;
	dispatcher: Dispatcher;
	ledger: Ledger;
	clone: string;
	/** Two scripted mock models, so a rubric row's choice is observable. */
	careful: string;
	quick: string;
	spawns: CapturedSpawn[];
}

/** A command post whose rubric has the shipped default's shape on mock models. */
async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	/** Last word on the dispatcher's routing inputs, once the mock models exist. */
	configure: (options: DispatcherOptions, models: { careful: string; quick: string; home: string; agentDir: string }) => void = () => {},
): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	const careful = provider.addScript("routing-careful", [{ kind: "text", text: "on it" }]);
	const quick = provider.addScript("routing-quick", [{ kind: "text", text: "on it" }]);
	agentDir.writeModels(provider);

	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, registry.pathOf("demo")]);
	const clone = registry.pathOf("demo");
	const pool = enableTreehouse(clone);

	const fleet = new FleetStore({ home: home.path });
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const spawns = captureSpawns(manager);
	const options: DispatcherOptions = {
		home: home.path,
		profilesDir: PROFILES_DIR,
		briefsDir: BRIEFS_DIR,
		ledger: scratch.ledger,
		registry,
		fleet,
		preflight: new Preflight({ registry, fleet }),
		leases: new LeaseManager({ home: home.path, cwd: () => home.path }),
		manager,
		// The shipped template's shape — the high-risk row before the size rows —
		// on models this test can actually spawn.
		routing: {
			schema_version: 1,
			allow: ["**"],
			rubric: [
				{ id: "risky-ship", role: "implementer", risk: "high", model: careful, thinking: "high" },
				{ id: "big-ship", role: "implementer", scope: ["M", "L"], model: quick, thinking: "medium" },
				{ id: "small-ship", role: "implementer", scope: ["S"], model: quick, thinking: "low" },
			],
		},
		probe: ALWAYS_AVAILABLE,
	};

	t.after(async () => {
		await manager.shutdownAll();
		try {
			treehouse(clone, "prune");
		} catch {
			// best effort; the pool root goes next
		}
		pool.cleanup();
		scratch.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	});

	configure(options, { careful, quick, home: home.path, agentDir: agentDir.path });
	return { home: home.path, dispatcher: new Dispatcher(options), ledger: scratch.ledger, clone, careful, quick, spawns };
}

/**
 * The shipped profiles with their ladder pointed at two mock models: what an
 * operator's profiles are on a machine where the preferred provider is down.
 */
function ladderProfiles(dir: string, preferred: string, fallback: string): string {
	mkdirSync(dir, { recursive: true });
	for (const name of ["planner", "implementer", "qa", "gate-reviewer"]) {
		const original = readFileSync(join(REPO_ROOT, "profiles", `${name}.md`), "utf8");
		writeFileSync(
			join(dir, `${name}.md`),
			original.replace(/^model: .*$/m, `model: ${preferred}`).replace(/^fallbacks: .*$/m, `fallbacks: [${fallback}]`),
		);
	}
	return dir;
}

test("quota preview, dispatch record, routing event and worker argv agree on the scored provider", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, (options, models) => {
		const alt = models.quick.replace(/^.*\//, "mock2/");
		const file = join(models.agentDir, "models.json");
		const catalog = JSON.parse(readFileSync(file, "utf8"));
		const mock = models.careful.split("/")[0] ?? "mock";
		catalog.providers.mock2 = { ...catalog.providers[mock] };
		writeFileSync(file, JSON.stringify(catalog));
		options.routing = { schema_version: 1, allow: ["**"], rubric: [
			{ id: "scored", role: "implementer", model: models.careful, fallbacks: [alt], thinking: "low" },
		] };
		mkdirSync(join(models.home, LAYOUT.data), { recursive: true });
		writeFileSync(join(models.home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/capacity" }));
		options.capacity = new CapacityReader({ home: models.home, fleet: options.fleet, env: { CP_GATEWAY_ADMIN_KEY: "test-only" }, fetch: async (url) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith("/accounts")) return Response.json({ code: 0, data: { items: [mock, "mock2"].map((platform, id) => ({ id: id + 1, platform, type: "oauth", status: "active", schedulable: true, temp_unschedulable_until: null, overload_until: null })) } });
			if (path.endsWith("/usage")) return Response.json({ code: 0, data: { five_hour: { utilization: 2 }, seven_day: { utilization: path.includes("/1/") ? 86 : 11 } } });
			return Response.json({ code: 0, data: { enabled: true, timestamp: "2026-09-25T00:00:00Z", platform: { [mock]: { max_capacity: 8, current_in_use: 0, waiting_in_queue: 0 }, mock2: { max_capacity: 8, current_in_use: 0, waiting_in_queue: 0 } } } });
		} });
	});
	const job = await b.ledger.create({ title: "score model", project: "demo", delivery: "pr", kind: "ship", slug: "score" });
	const request = { jobId: job.id, task: "Score model.", scope: "S" as const, risk: "low" as const, fetch: false };
	const preview = await b.dispatcher.preview(request);
	assert.equal(preview.decision?.model, b.quick.replace(/^.*\//, "mock2/"));
	assert.match(preview.line ?? "", /quota=.*7d=86\(tight\)/);
	assert.match(preview.line ?? "", /capacity=admin:/);
	const result = await b.dispatcher.dispatch(request);
	assert.equal(result.model, preview.decision?.model);
	assert.equal(argOf((b.spawns[0] as CapturedSpawn).args, "--model"), result.model);
	const event = readRunEvents(b.home, job.id).find((item) => item.type === "routing_resolved");
	assert.deepEqual((event?.payload as { quota?: unknown })?.quota, preview.decision?.quota);
	assert.deepEqual((event?.payload as { capacity?: unknown })?.capacity, preview.decision?.capacity);
	assert.equal(readFleet(b.home).jobs.find((item) => item.job_id === job.id)?.worker.model, result.model);
});
test(
	"pi-command-post-0a9: a dispatch launches the fallback candidate and records what it stepped over",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t, (options, models) => {
			// One provider down: the preferred candidate is in pi's registry and its
			// auth does not resolve, which is the one-provider day this contract is for.
			options.profilesDir = ladderProfiles(join(models.home, "profiles"), models.careful, models.quick);
			options.routing = {
				schema_version: 1,
				allow: ["**"],
				rubric: [
					{
						id: "small-ship",
						role: "implementer",
						scope: ["S"],
						model: models.careful,
						fallbacks: [models.quick],
						thinking: "low",
					},
				],
			};
			options.probe = {
				isAvailable: (model) => model !== models.careful,
				available: () => [models.quick],
			};
		});

		const attemptedIn = (jobId: string): unknown => {
			const resolved = readRunEvents(b.home, jobId).find(
				(event: RunEvent) => event.source === "cp" && event.type === "routing_resolved",
			) as { payload?: Record<string, unknown> } | undefined;
			return resolved?.payload?.attempted;
		};

		// 1. A rubric ladder, the shipped template's shape: the row decides, the
		//    second candidate spawns, and the row's effort is untouched.
		const ship = await b.ledger.create({ title: "rename the helper", project: "demo", delivery: "pr", kind: "ship", slug: "rename" });
		const shipped = await b.dispatcher.dispatch({ jobId: ship.id, task: "Rename the helper.", scope: "S", risk: "low", fetch: false });
		assert.equal(shipped.model, b.quick);
		const shipSpawn = b.spawns[0] as CapturedSpawn;
		assert.equal(argOf(shipSpawn.args, "--model"), b.quick, "the argv is the candidate that passed the gates");
		assert.equal(argOf(shipSpawn.args, "--thinking"), "low", "a fallback never substitutes the effort");
		assert.deepEqual(attemptedIn(ship.id), [{ model: b.careful, refusal: "availability" }]);

		// 2. A profile ladder, through the QA path: `delivery:answer` picks the qa
		//    profile (role planner), so this is the planner-role launch too.
		const question = await b.ledger.create({
			title: "Where is the retry ladder configured?",
			project: "demo",
			delivery: "answer",
			kind: "research",
			slug: "question",
		});
		const answered = await b.dispatcher.dispatch({ jobId: question.id, task: "Where is the retry ladder configured?", fetch: false });
		assert.equal(answered.model, b.quick);
		const qaSpawn = b.spawns[1] as CapturedSpawn;
		assert.equal(argOf(qaSpawn.args, "--model"), b.quick);
		assert.deepEqual(attemptedIn(question.id), [{ model: b.careful, refusal: "availability" }]);

		// 3. An explicit override never falls back, and is refused before anything is
		//    taken: no worker, no fleet record, no branch.
		const named = await b.ledger.create({ title: "tidy up", project: "demo", delivery: "pr", kind: "ship", slug: "tidy" });
		const spawnsBefore = b.spawns.length;
		await assert.rejects(
			() => b.dispatcher.dispatch({ jobId: named.id, task: "Tidy up.", model: b.careful, fetch: false }),
			/no available model/,
		);
		assert.equal(b.spawns.length, spawnsBefore, "a refused override spawned a worker");
		assert.equal(
			readFleet(b.home).jobs.some((record) => record.job_id === named.id),
			false,
			"a refused override took a fleet record",
		);
	},
);

test(
	"routing T7: a scope-only dispatch of credential work — the preview, the record and the spawn all say the same thing",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const job = await b.ledger.create({
			title: "rotate the deploy credentials",
			project: "demo",
			delivery: "pr",
			kind: "ship",
			slug: "rotate",
		});
		// The parent named the size and nothing else — the case routing T6's
		// guidance makes ordinary ("an axis you do not know stays absent").
		const request = { jobId: job.id, task: "Rotate the production credentials the deploy job uses.", scope: "M" as const };

		const preview = await b.dispatcher.preview({ ...request });
		// The risk nobody supplied is read from the job's own words, and it is
		// labelled as read rather than as chosen.
		assert.equal(preview.routing.scope, "M");
		assert.equal(preview.routing.risk, "high");
		assert.deepEqual(preview.routing.provenance, { scope: "explicit", risk: "inferred" });
		assert.ok((preview.routing.reasons ?? []).some((reason) => reason.startsWith("risk high:")));
		// High risk beats the size row, exactly as the shipped template orders it.
		assert.equal(preview.decision?.rule, "risky-ship");
		assert.equal(preview.decision?.model, b.careful);
		assert.equal(preview.decision?.thinking, "high");
		// A preview takes nothing: nothing to promote, nothing to return, nothing
		// to reconcile after it.
		assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false, "a preview wrote a fleet file");
		assert.equal(existsSync(join(b.home, paths.runDir(job.id))), false, "a preview opened a run");
		assert.equal(b.spawns.length, 0, "a preview spawned a worker");
		assert.ok(!/leased/.test(treehouse(b.clone, "status")), "a preview took a lease");

		const result = await b.dispatcher.dispatch({ ...request, fetch: false });

		assert.equal(result.state, "dispatched");
		assert.equal(result.model, b.careful);
		assert.equal(result.routing, preview.line, "the preview's line is the dispatch's line");

		// What was recorded: the same decision, on the fleet record and on the run.
		const record = readFleet(b.home).jobs[0];
		assert.deepEqual(record?.routing, preview.routing, "the record is the preview's projection, made real");
		assert.equal(record?.worker.model, b.careful);
		const resolved = readRunEvents(b.home, job.id).find(
			(event: RunEvent) => event.source === "cp" && event.type === "routing_resolved",
		) as { payload?: Record<string, unknown> } | undefined;
		assert.equal(resolved?.payload?.model, b.careful);
		assert.equal(resolved?.payload?.rule, "risky-ship");
		assert.equal(resolved?.payload?.thinking, "high");
		assert.deepEqual(resolved?.payload?.provenance, { scope: "explicit", risk: "inferred" });

		// And what was actually launched. This is the assertion the epic exists for:
		// a resolved route that the spawn does not honour is the defect
		// cp-reviewer-routing found on the reviewer surfaces, and nothing had
		// pinned it on the ordinary dispatch path with a rubric-chosen effort.
		assert.equal(b.spawns.length, 1);
		const spawn = b.spawns[0] as CapturedSpawn;
		assert.equal(spawn.request.model, b.careful);
		assert.equal(spawn.request.thinking, "high");
		assert.equal(argOf(spawn.args, "--model"), b.careful);
		assert.equal(argOf(spawn.args, "--thinking"), "high", "the rubric row's effort reaches the argv");
	},
);

// ---------------------------------------------------------------------------
// 3: the shipped default as an operator meets it — copied once, never migrated
// ---------------------------------------------------------------------------

/** A dispatcher that can only preview: every side-effecting collaborator throws. */
function previewOnly(home: string, ledger: Ledger, routing: RoutingConfig): Dispatcher {
	const forbidden = <T>(what: string): T =>
		new Proxy(
			{},
			{
				get(_target, property) {
					throw new Error(`a preview touched ${what}.${String(property)}`);
				},
			},
		) as T;
	return new Dispatcher({
		home,
		profilesDir: PROFILES_DIR,
		briefsDir: BRIEFS_DIR,
		ledger,
		routing,
		probe: ALWAYS_AVAILABLE,
		registry: forbidden<ProjectRegistry>("the registry"),
		fleet: forbidden<FleetStore>("the fleet"),
		preflight: forbidden<Preflight>("preflight"),
		leases: forbidden<LeaseManager>("leases"),
		manager: forbidden<WorkerManager>("the worker manager"),
	});
}

test("routing T7: the scaffolded default routes QA and ordinary planning through their own profiles", async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	t.after(() => {
		scratch.cleanup();
		home.cleanup();
	});

	// The operator's path: session_start scaffolds, the template lands once, and
	// routing reads the file rather than anything the test hand-wrote.
	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, packageRoot: REPO_ROOT, ledger: false });
	assert.equal(report.steps.find((step) => step.step === "routing.default")?.action, "created");
	const config = loadRoutingConfig(home.path);
	const dispatcher = previewOnly(home.path, scratch.ledger, config);

	const question = await scratch.ledger.create({
		title: "Where is the retry ladder configured?",
		project: "demo",
		delivery: "answer",
		kind: "research",
		slug: "question",
	});
	const plan = await scratch.ledger.create({
		title: "plan the widget refresh",
		project: "demo",
		delivery: "pr",
		kind: "research",
		slug: "plan",
	});
	const ship = await scratch.ledger.create({
		title: "rename the widget helper",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		slug: "rename",
	});

	// cp-routing-t4: `qa` shares role `planner`, so a broad planner row would
	// swallow it. With the catch-all gone, the QA profile's own model and effort
	// are what a question gets.
	const qa = await dispatcher.preview({ jobId: question.id, task: "Where is the retry ladder configured?" });
	assert.equal(qa.profile, "qa");
	assert.equal(qa.decision?.source, "profile");
	assert.equal(qa.decision?.rule, "profile qa");
	assert.equal(qa.decision?.model, "anthropic/claude-opus-5-5");
	assert.equal(qa.decision?.thinking, "low");

	// Ordinary planning falls through the same way, to the planner profile.
	const research = await dispatcher.preview({ jobId: plan.id, task: "Plan the widget refresh.", scope: "M", risk: "low" });
	assert.equal(research.profile, "planner");
	assert.equal(research.decision?.source, "profile");
	assert.equal(research.decision?.model, "anthropic/claude-opus-5-5");
	assert.equal(research.decision?.thinking, "medium");

	// A ship job still resolves from a row: the size rows were never removed.
	const small = await dispatcher.preview({ jobId: ship.id, task: "Rename the helper.", scope: "S", risk: "low" });
	assert.equal(small.decision?.source, "rubric");
	assert.equal(small.decision?.rule, "small-ship");

	// Copy-once, on the very next session: from here the file is the operator's.
	const copied = readFileSync(join(home.path, LAYOUT.routingFile), "utf8");
	const second = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, packageRoot: REPO_ROOT, ledger: false });
	assert.equal(second.steps.find((step) => step.step === "routing.default")?.action, "present");
	assert.equal(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"), copied, "the second scaffold rewrote the copy");
});

test("routing T7: a home that kept the old planner catch-all is not migrated by anything in this epic", async (t) => {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	t.after(() => {
		scratch.cleanup();
		home.cleanup();
	});

	// The pre-cp-routing-t4 shape, byte for byte as such a home carries it —
	// including the broad `research` row the shipped template no longer has.
	const existing = `${JSON.stringify(
		{
			schema_version: 1,
			allow: ["*/*"],
			rubric: [
				{ id: "risky-any", role: "researcher", risk: "high", model: "anthropic/claude-opus-5", thinking: "xhigh" },
				{ id: "research", role: "researcher", model: "anthropic/claude-opus-5", thinking: "medium" },
				{ id: "small-ship", role: "implementer", scope: ["S"], model: "anthropic/claude-haiku-4-5", thinking: "low" },
			],
		},
		null,
		2,
	)}\n`;
	scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, packageRoot: REPO_ROOT, ledger: false });
	writeFileSync(join(home.path, LAYOUT.routingFile), existing);

	const report = scaffoldHome({ home: home.path, env: { CP_HOME: home.path }, packageRoot: REPO_ROOT, ledger: false });
	assert.equal(report.steps.find((step) => step.step === "routing.default")?.action, "present");
	assert.equal(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"), existing, "the scaffold rewrote an operator's routing.json");

	// It still routes as that operator configured it: the retired role word is
	// mapped forward on read, and the catch-all still takes ordinary planning.
	const config = loadRoutingConfig(home.path);
	const plan = await scratch.ledger.create({
		title: "plan the widget refresh",
		project: "demo",
		delivery: "pr",
		kind: "research",
		slug: "plan",
	});
	const preview = await previewOnly(home.path, scratch.ledger, config).preview({
		jobId: plan.id,
		task: "Plan the widget refresh.",
		scope: "M",
		risk: "low",
	});
	assert.equal(preview.decision?.source, "rubric");
	assert.equal(preview.decision?.rule, "research");
	assert.equal(preview.decision?.model, "anthropic/claude-opus-5");
	// And reading it changed nothing on disk. Normalisation is a read, not a
	// migration: this epic never rewrites a live document.
	assert.equal(readFileSync(join(home.path, LAYOUT.routingFile), "utf8"), existing, "loadRoutingConfig rewrote the file it read");
});

// ---------------------------------------------------------------------------
// 4: records written before this epic still load, and reading them rewrites
//    nothing
// ---------------------------------------------------------------------------

test("routing T7: pre-epic fleet records load, route as unknown rather than as measured, and are not rewritten", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	// Three generations in one file: a record from before `routing` existed at
	// all, one from before `provenance` did, and one written by this build.
	const worker = {
		pid: 4321,
		session_id: "s1",
		session_file: "/tmp/s1.json",
		profile: "researcher",
		role: "researcher",
		model: "anthropic/claude-opus-5",
		started_at: "2026-08-27T12:00:00Z",
	};
	const base = {
		project: "demo",
		kind: "research" as const,
		delivery: "pr" as const,
		origin: "terminal" as const,
		phase: "waiting" as const,
		worktree: "/tmp/wt",
		branch: "cp-old",
		dispatched_at: "2026-08-27T12:00:00Z",
		usage: EMPTY_USAGE,
	};
	const file = `${JSON.stringify(
		{
			schema_version: 1,
			updated_at: "2026-08-27T12:00:00Z",
			jobs: [
				{ ...base, job_id: "cp-no-routing", worker },
				{ ...base, job_id: "cp-one-bit", worker, routing: { scope: "L", risk: "high", inferred: true } },
				{
					...base,
					job_id: "cp-current",
					worker: { ...worker, role: "planner", profile: "planner" },
					routing: { scope: "M", risk: "low", inferred: false, provenance: { scope: "explicit", risk: "defaulted" } },
				},
			],
		},
		null,
		2,
	)}\n`;
	const path = join(home.path, LAYOUT.fleetFile);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, file);

	const fleet = new FleetStore({ home: home.path });
	const jobs = fleet.read().jobs;
	assert.equal(jobs.length, 3);
	assert.equal(jobs[0]?.worker.role, "planner", "the retired role word loads as the current one");

	// A reviewer of the oldest job knows nothing about its axes, and says so —
	// routing's own S/low default decides, and nothing claims it was measured.
	const unknown = reviewerRoutingInputs(jobs[0]);
	assert.equal(unknown.scope, undefined);
	assert.equal(unknown.risk, undefined);
	assert.deepEqual(unknown.provenance, { scope: "unknown", risk: "unknown" });
	assert.equal(unknown.subject, undefined);

	// A one-bit legacy record still carries its axes: a known high risk is never
	// lost because the record predates per-axis provenance.
	const oneBit = reviewerRoutingInputs(jobs[1]);
	assert.equal(oneBit.scope, "L");
	assert.equal(oneBit.risk, "high");
	assert.deepEqual(oneBit.provenance, { scope: "inherited", risk: "inherited" });
	assert.equal(oneBit.subject, undefined, "a record with no per-axis provenance claims none");

	const current = reviewerRoutingInputs(jobs[2]);
	assert.deepEqual(current.subject, { scope: "explicit", risk: "defaulted" });

	assert.equal(readFileSync(path, "utf8"), file, "reading the fleet rewrote it");
});
