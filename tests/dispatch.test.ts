/**
 * T14 acceptance: an end-to-end dispatch against a scratch project, and no
 * orphan lease or branch when anything fails.
 *
 * The worker is a real `pi --mode rpc` child on the mock provider; the ledger
 * is a real scratch beads workspace; the lease is a real treehouse lease.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths, type RunEvent, THINKING_LEVELS } from "../src/contracts.ts";
import { DispatchQueue } from "../src/dispatch-queue.ts";
import { HeldRelease } from "../src/held-release.ts";
import { MandateError } from "../src/mandate-accounting.ts";
import { RunRegistry } from "../src/runs.ts";
import {
	cleanupCreatedJobBranch,
	Dispatcher,
	type DispatcherOptions,
	type DispatchResult,
	DispatchError,
	type GitRunner,
} from "../src/dispatch.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { LeaseManager } from "../src/leases.ts";
import { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { batchRiskHigh } from "../src/risk-batch.ts";
import { Preflight, type PreflightRequest, type PreflightResult } from "../src/preflight.ts";
import { loadProfile } from "../src/profiles.ts";
import { ProjectRegistry } from "../src/projects.ts";
import {
	ALWAYS_AVAILABLE,
	DEFAULT_ROUTING_CONFIG,
	type ModelProbe,
	registryProbe,
	splitModelRef,
} from "../src/routing.ts";
import { SpawnSafetyError, WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchLedger,
	createScratchRepo,
	enableTreehouse,
	git,
	MockProvider,
	readFleet,
	fakeWorkerManager,
	readRunEvents,
	readRunStatus,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");
const READY = treehouseAvailable();
const SKIP = READY ? false : "br and treehouse are required for dispatch tests";

interface Bench {
	home: string;
	dispatcher: Dispatcher;
	/** Same wiring, with individual options replaced (fault injection). */
	makeDispatcher(overrides: Partial<DispatcherOptions>): Dispatcher;
	fleet: FleetStore;
	ledger: Ledger;
	registry: ProjectRegistry;
	provider: MockProvider;
	clone: string;
	model: string;
	cleanup(): Promise<void>;
}

/**
 * A full command post: scratch home, scratch project (registered + cloned),
 * scratch ledger, treehouse pool, mock provider.
 */
async function bench(
	t: { after(fn: () => void | Promise<void>): void },
	options: { script?: ScriptStep[]; probe?: ModelProbe; branch?: string; maxTrees?: number } = {},
): Promise<Bench> {
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: "demo",
		files: { "README.md": "# demo\n", "src/app.ts": "export const x = 1;\n" },
		...(options.branch ? { branch: options.branch } : {}),
	});
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	const model = provider.addScript(
		"dispatch",
		options.script ?? [{ kind: "text", text: "on it" }],
	);
	agentDir.writeModels(provider);

	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, registry.pathOf("demo")]);
	const clone = registry.pathOf("demo");
	const pool = enableTreehouse(clone, options.maxTrees ? { maxTrees: options.maxTrees } : {});

	const fleet = new FleetStore({ home: home.path });
	const leases = new LeaseManager({ home: home.path, cwd: () => home.path });
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const dispatcherOptions: DispatcherOptions = {
		home: home.path,
		profilesDir: PROFILES_DIR,
		briefsDir: BRIEFS_DIR,
		ledger: scratch.ledger,
		registry,
		fleet,
		preflight: new Preflight({ registry, fleet }),
		leases,
		manager,
		routing: { ...DEFAULT_ROUTING_CONFIG, allow: ["**"] },
		probe: options.probe ?? ALWAYS_AVAILABLE,
	};
	const dispatcher = new Dispatcher(dispatcherOptions);

	const cleanup = async () => {
		await manager.shutdownAll();
		try {
			treehouse(clone, "prune");
		} catch {
			// best effort; the pool root is removed next
		}
		pool.cleanup();
		scratch.cleanup();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	};
	t.after(cleanup);

	return {
		home: home.path,
		dispatcher,
		makeDispatcher: (overrides) => new Dispatcher({ ...dispatcherOptions, ...overrides }),
		fleet,
		ledger: scratch.ledger,
		registry,
		provider,
		clone,
		model,
		cleanup,
	};
}

test("model-only dispatcher refuses declared scripts without falling through to routing", { skip: SKIP }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "run", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/run.sh" });
	const request = { jobId: job.id, task: "run", model: b.model };
	await assert.rejects(b.dispatcher.preview(request), /script jobs use CommandPost.previewDispatch/);
	await assert.rejects(b.dispatcher.dispatch(request), /script jobs use CommandPost.dispatch/);
	await assert.rejects(b.dispatcher.dispatch({ jobId: job.id }), /script jobs use CommandPost.dispatch/);
	assert.equal(b.fleet.read().jobs.length, 0);
});

test("a failed npm ci is logged once and the worker still starts, told in its brief", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "stale deps", project: "demo", kind: "ship", delivery: "pr" });
	const installs: string[] = [];
	const deps = {
		read: (path: string) => path.endsWith("/package-lock.json") ? JSON.stringify({ packages: { "node_modules/x": { version: "1.0.0" } } }) : undefined,
		npmCi: async (cwd: string) => (installs.push(cwd), { ok: false, error: "EINTEGRITY" }),
	};
	const result = await b.makeDispatcher({ deps }).dispatch({ jobId: job.id, task: "Bump x.", model: b.model, fetch: false });
	assert.equal(result.receipt, "accepted");
	assert.deepEqual(installs, [result.worktree]);
	const logged = readRunEvents(b.home, job.id).filter((event) => event.type === "deps_prepared");
	assert.equal(logged.length, 1);
	assert.match(JSON.stringify(logged[0]?.payload), /failed.*EINTEGRITY/);
	assert.match(readFileSync(join(b.home, paths.briefFile(job.id)), "utf8"), /Dependencies in this worktree may be stale/);
});

test("4B1-T7: at the cap dispatch releases the one idle held author into a reserved slot; a failed spawn rolls back; nothing releasable lets spawn_cap escape", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const workers = fakeWorkerManager(b.home, 1);
	t.after(() => workers.manager.shutdownAll());
	const runs = new RunRegistry(b.home);
	t.after(() => runs.closeAll());
	const idle = workers.spawn("cp-aaa1");
	await b.fleet.add({
		job_id: "cp-aaa1", project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held",
		worker: { pid: 4242, session_id: "s", session_file: join(b.home, "s.jsonl"), profile: "implementer", role: "implementer", model: b.model, started_at: isoTimestamp() },
		worktree: b.home, branch: "cp-aaa1", dispatched_at: isoTimestamp(), reported_at: isoTimestamp(), usage: EMPTY_USAGE,
	});
	const held = new HeldRelease({
		home: b.home, fleet: b.fleet, manager: workers.manager,
		busy: { sending: () => false, promoting: () => false, driving: () => false },
		integration: () => undefined, journal: (id, kind, payload) => runs.open(id).cp(kind, payload),
	});
	const dispatcher = b.makeDispatcher({ manager: workers.manager, makeRoom: (id, role) => held.makeRoom(id, role) });

	// Nothing releasable (the author is busy): spawn_cap escapes, nothing reserved, no record.
	const blocked = await b.ledger.create({ title: "blocked", project: "demo", kind: "ship", delivery: "local", slug: "t7-blocked" });
	const busy = idle as { busy: boolean };
	busy.busy = true;
	await assert.rejects(dispatcher.dispatch({ jobId: blocked.id, task: "Bump x.", model: b.model, fetch: false }), (error: unknown) => (error as SpawnSafetyError).code === "spawn_cap");
	assert.equal(workers.manager.reserved, 0);
	assert.equal(b.fleet.get(blocked.id), undefined);
	busy.busy = false;

	// A spawn that throws after makeRoom: the author is released, the reservation is not leaked, the same error escapes.
	const failing = await b.ledger.create({ title: "failing", project: "demo", kind: "ship", delivery: "local", slug: "t7-failing" });
	workers.failNext();
	await assert.rejects(dispatcher.dispatch({ jobId: failing.id, task: "Bump x.", model: b.model, fetch: false }), /spawn failed/);
	assert.equal(idle.shutdownCalls, 1);
	assert.equal(workers.manager.reserved, 0);
	assert.equal(b.fleet.get(failing.id), undefined);
	assert.equal(b.fleet.require("cp-aaa1").phase, "held", "a release never changes phase");

	// At the cap with one releasable author: it is released and the dispatch spawns into its slot.
	const second = workers.spawn("cp-aaa1");
	const job = await b.ledger.create({ title: "reserved", project: "demo", kind: "ship", delivery: "local", slug: "t7-ok" });
	const result = await dispatcher.dispatch({ jobId: job.id, task: "Bump x.", model: b.model, fetch: false });
	assert.equal(result.state, "dispatched");
	assert.equal(second.shutdownCalls, 1);
	assert.equal(workers.manager.reserved, 0);
	assert.ok(workers.manager.get(job.id));
	assert.equal(readRunEvents(b.home, "cp-aaa1").filter((event) => event.type === "held_released").length, 2);
});

test("dispatch snapshots referenced beads for the worker and reviewers, including missing refs", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "reference snapshot", project: "demo", kind: "ship", delivery: "pr" });
	const task = "Implement cp-abc and cp-missing as a read-only follow-up.";
	// The project's own DB (as its tracker connection resolves it) reaches the snapshot and the worker env.
	const db = join(b.home, "tracker db", "beads.db");
	const ledger = new Ledger({ home: b.ledger.home, knownProjects: ["demo"], beadsDbFor: (project) => project === "demo" ? db : undefined });
	const dispatcher = b.makeDispatcher({ ledger, referenceExec: async (_command, args) => {
		assert.equal(args[1], db);
		if (args.includes("cp-missing")) throw new Error("not found");
		return JSON.stringify([{ id: "cp-abc", title: "Requirement", status: "open", description: "Preserve this acceptance criterion verbatim." }]);
	} });
	const result = await dispatcher.dispatch({ jobId: job.id, task, model: b.model, fetch: false });
	assert.equal(result.receipt, "accepted");
	const frozen = readFileSync(join(b.home, paths.originalTaskFile(job.id)), "utf8");
	const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
	assert.ok(frozen.startsWith(task));
	assert.match(frozen, /Preserve this acceptance criterion verbatim\./);
	assert.match(frozen, /cp-missing: br unavailable: Error: not found/);
	assert.doesNotMatch(frozen, /### (read-only|follow-up)/);
	assert.ok(frozen.includes(`BEADS_DIR points to \`${join(b.home, "tracker db")}\``));
	assert.ok(brief.includes(frozen), "worker and reviewers see the identical snapshot");
});

test("dispatch: ledger -> routing -> lease -> branch -> brief -> worker -> fleet", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, {
		script: [
			{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "git rev-parse --abbrev-ref HEAD" } }] },
			{ kind: "text", text: "branch confirmed" },
		],
	});
	const job = await b.ledger.create({
		title: "bump x",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		slug: "bump-x",
	});

	const result = await b.dispatcher.dispatch({
		jobId: job.id,
		task: "Bump x to 2 in src/app.ts.",
		model: b.model,
		fetch: false,
	});

	// stdout parity with `cmdp dispatch`, receipt is now a fact
	assert.equal(result.state, "dispatched");
	assert.equal(result.receipt, "accepted");
	assert.equal(result.job_id, job.id);
	assert.equal(result.branch, job.id);
	assert.equal(result.worker, job.id);
	assert.equal(result.model, b.model);
	assert.equal(result.profile, "implementer");
	assert.match(result.routing ?? "", /source=override model=/);
	assert.ok(result.pid);

	// the worktree is a lease, on the job branch, cut from origin/main
	assert.notEqual(result.worktree, b.clone);
	assert.equal(git(result.worktree, "symbolic-ref", "--short", "HEAD"), job.id);
	assert.equal(git(result.worktree, "rev-parse", "HEAD"), git(b.clone, "rev-parse", "origin/main"));

	// the brief that was actually sent is on disk, fully substituted
	const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
	assert.ok(brief.includes(job.id) && brief.includes(result.worktree));
	assert.ok(!brief.includes("${"), "no unsubstituted placeholders reach a worker");
	assert.ok(brief.includes("Bump x to 2"));
	assert.match(brief, /## Repo map/);
	assert.match(brief, /src\/app\.ts.*1 lines.*x/);
	assert.ok(existsSync(join(b.home, LAYOUT.state, "repo-map/demo", `${git(b.clone, "rev-parse", "origin/main")}.md`)));

	// do8.3: the task is frozen beside the brief, from the dispatch request, so a
	// later reviewer can score a plan against what was actually asked.
	assert.equal(readFileSync(join(b.home, paths.originalTaskFile(job.id)), "utf8"), "Bump x to 2 in src/app.ts.");

	// the fleet records facts, not intentions
	const record = readFleet(b.home).jobs[0];
	assert.equal(record?.phase, "waiting");
	assert.equal(record?.project, "demo");
	assert.equal(record?.delivery, "pr");
	assert.equal(record?.kind, "ship");
	assert.equal(record?.worktree, result.worktree);
	assert.equal(record?.branch, job.id);
	assert.equal(record?.worker.model, b.model);
	assert.equal(record?.worker.pid, result.pid);
	// cp-u3i2: the worker transcript lives under the one runtime root, never a literal state/sessions.
	assert.ok(record?.worker.session_file.startsWith(join(b.home, ".pi-command-post", "state", "sessions") + sep), record?.worker.session_file);
	assert.ok(record?.budget?.tokens);
	assert.ok(record?.lease_id, "the lease identity travels into the fleet");
	// cp-status-scope-risk: the same scope/risk/thinking decision recorded on
	// cp:routing_resolved is persisted on the fleet record itself, so /status
	// can read it back without re-inferring anything. Neither scope nor risk
	// was given or inferable from "Bump x to 2 in src/app.ts.", so routing used
	// its standing defaults — and cp-routing-provenance records them as
	// `defaulted`, the values routing was actually given, never as a choice
	// somebody made.
	assert.equal(record?.routing?.inferred, false);
	assert.equal(record?.routing?.scope, "S");
	assert.equal(record?.routing?.risk, "low");
	assert.deepEqual(record?.routing?.provenance, { scope: "defaulted", risk: "defaulted" });
	assert.equal(record?.routing?.reasons, undefined, "nothing was inferred, so there is no evidence to carry");

	// the ledger claim happens only once the worker exists
	assert.equal((await b.ledger.show(job.id)).status, "in_progress");

	// run artifacts are live
	const status = await waitFor(
		() => readRunStatus(b.home, job.id),
		(value) => value.tool_calls >= 1,
		{ what: "worker activity in the projection" },
	);
	assert.equal(status.profile, "implementer");
	assert.equal(status.model, b.model);
	const events = readRunEvents(b.home, job.id);
	// cp-routing-provenance: same fact, same moment, one journal — the run event
	// carries the per-axis provenance the fleet record does, not a second one.
	const resolved = events.find((event) => event.source === "cp" && event.type === "routing_resolved");
	assert.deepEqual((resolved as { payload?: { provenance?: unknown } } | undefined)?.payload?.provenance, {
		scope: "defaulted",
		risk: "defaulted",
	});
	const types = events.map((event) => event.type);
	assert.equal(types[0], "spawned");
	assert.ok(types.includes("prompt_sent"));
	assert.ok(types.includes("agent_start"));

	// Default base: the same brief names origin/main, because that is what this
	// clone resolves to — the placeholder is resolved, never hardcoded.
	assert.ok(brief.includes("git rebase origin/main"), "a main-based repo still gets origin/main");
	assert.ok(brief.includes("git rev-parse origin/main"));
});

// The base is per repository, not per fleet: a clone whose origin/HEAD is not
// `main` must get a brief that rebases and reports `base_sha` against ITS base.
// Hardcoded `origin/main` prose in the ship template made a non-main worker
// rebase onto a branch that may not even exist.
test("dispatch: a non-main base reaches the ship brief, with no origin/main residue", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, { branch: "trunk" });
	const job = await b.ledger.create({ title: "bump x on trunk", project: "demo", delivery: "pr", kind: "ship", slug: "trunk-x" });

	const result = await b.dispatcher.dispatch({ jobId: job.id, task: "Bump x to 2 in src/app.ts.", model: b.model, fetch: false });
	assert.equal(result.state, "dispatched");
	// the job branch is cut from the resolved base, not from a guessed "main"
	assert.equal(git(result.worktree, "rev-parse", "HEAD"), git(b.clone, "rev-parse", "origin/trunk"));

	const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
	assert.ok(!brief.includes("${"), "no unsubstituted placeholders reach a worker");
	assert.ok(brief.includes("git rebase origin/trunk"), "the rebase names the resolved base");
	assert.ok(brief.includes("git rev-parse origin/trunk"), "base_sha is read from the resolved base");
	assert.ok(!brief.includes("origin/main"), "no origin/main residue in a non-main-base brief");
});

// cp-n7w: the artifact-handover deadlock. The sanctioned path (`cp_artifact
// get` then dispatch with `taskFile`) used to fail closed whenever the
// artifact legitimately quoted credential-shaped text, because the whole
// body was inlined into the brief the guard scans — and the parent has no
// sanctioned way to read the artifact and resolve that itself. These three
// tests are the acceptance criteria from the br issue, one each.

test(
	"cp-n7w: an artifact with credential-shaped text reaches an implementer through taskFile without tripping the guard",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const job = await b.ledger.create({ title: "handover", project: "demo", delivery: "local", kind: "ship", slug: "handover" });
		const taskFile = join(b.home, "handover-task.md");
		const matchedLine = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		writeFileSync(
			taskFile,
			[
				"# Plan",
				"",
				"Measured this home's gh/PAT/rate-limit behaviour during the run:",
				"",
				`    ${matchedLine}`,
				"",
				"That line documents an environment fact observed during research, not a live credential to paste anywhere.",
			].join("\n"),
		);

		// The sanctioned path itself: no `task`, only `taskFile` — same as
		// `cp_artifact get <job-id> --out <file>` followed by dispatch.
		const result = await b.dispatcher.dispatch({ jobId: job.id, taskFile, model: b.model, fetch: false });
		assert.equal(result.state, "dispatched");
		assert.equal(result.receipt, "accepted");

		// The artifact's own text never entered the brief the guard scanned —
		// only a pointer at the file naming it.
		const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
		assert.ok(!brief.includes(matchedLine), "the artifact body never reaches the brief");
		assert.ok(brief.includes(taskFile), "the brief points the worker at the file instead of inlining it");

		// The file itself is untouched — the worker reads the real body directly.
		assert.equal(readFileSync(taskFile, "utf8").includes(matchedLine), true);

		// do8.3: the same body is frozen under the run directory, so the plan gate
		// can hand it to a reviewer as a file. It is a file write, not model input:
		// it never entered the brief above, and it never entered the parent.
		assert.equal(readFileSync(join(b.home, paths.originalTaskFile(job.id)), "utf8"), readFileSync(taskFile, "utf8"));
		const events = readRunEvents(b.home, job.id).map((event) => event.type);
		assert.ok(events.includes("original_task_frozen"));
	},
);

test(
	"cp-n7w: a real secret pasted directly into a hand-written task is still refused",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const job = await b.ledger.create({ title: "leaky brief", project: "demo", delivery: "local", kind: "ship", slug: "leaky" });

		await assert.rejects(
			() =>
				b.dispatcher.dispatch({
					jobId: job.id,
					task: "Rotate this key: AKIAIOSFODNN7EXAMPLE and update the client.",
					model: b.model,
					fetch: false,
				}),
			(error: Error) => {
				assert.ok(error instanceof SpawnSafetyError, error.message);
				assert.match(error.message, /aws access key id/);
				return true;
			},
		);
		assert.deepEqual(b.fleet.read().jobs, [], "a refused brief takes no lease and leaves no record");
		assert.ok(!/leased/.test(treehouse(b.clone, "status")), "a refused brief never takes a lease");
	},
);

test(
	"cp-n7w: the refusal names the pattern and a line number, never the matched text",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const job = await b.ledger.create({ title: "leaky brief 2", project: "demo", delivery: "local", kind: "ship", slug: "leaky2" });
		const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";

		await assert.rejects(
			() => b.dispatcher.dispatch({ jobId: job.id, task: `line one\nline two\n${secret}\n`, model: b.model, fetch: false }),
			(error: Error) => {
				assert.ok(error instanceof SpawnSafetyError, error.message);
				// A coordinate (pattern name + line), never the content that matched —
				// the caller can find and fix the line without the parent (or anyone
				// relaying this message) ever reading the brief body back.
				assert.match(error.message, /anthropic-style key \(line \d+\)/);
				assert.ok(!error.message.includes(secret), "the refusal never echoes the matched text");
				return true;
			},
		);
	},
);

test("a second dispatch of the same job is refused with the promote instruction", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "one worker", project: "demo", delivery: "local", kind: "ship", slug: "one" });
	const first = await b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false });
	assert.equal(first.state, "dispatched");

	const second = await b.dispatcher.dispatch({ jobId: job.id, task: "do it again", model: b.model, fetch: false });
	assert.equal(second.state, "promote");
	assert.equal(second.receipt, "refused");
	assert.equal(second.promote?.job_id, job.id);
	assert.match(second.promote?.instruction ?? "", /cp_send/);
	assert.equal(readFleet(b.home).jobs.length, 1, "no second record, no second lease");
	assert.equal(treehouse(b.clone, "status").split("\n").filter((line) => line.includes("leased")).length, 1);
});

test("schedlater S3: a model dispatch of a schedule:<id> job writes schedule_id on its fleet record; an unlabelled job's record has none", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const scheduled = await b.ledger.create({ title: "nightly digest", project: "demo", delivery: "local", kind: "ship", slug: "scheduled", labels: ["schedule:sch-abc123"] });
	const plain = await b.ledger.create({ title: "plain work", project: "demo", delivery: "local", kind: "ship", slug: "plain" });
	assert.equal((await b.dispatcher.dispatch({ jobId: scheduled.id, task: "do it", model: b.model, fetch: false })).state, "dispatched");
	assert.equal((await b.dispatcher.dispatch({ jobId: plain.id, task: "do it", model: b.model, fetch: false })).state, "dispatched");
	assert.equal(b.fleet.get(scheduled.id)?.schedule_id, "sch-abc123");
	assert.equal(b.fleet.get(plain.id)?.schedule_id, undefined);
});

test(
	"cp-u3o4: delivery:answer defaults to the qa profile, and an explicit profile still wins",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const question = await b.ledger.create({
			title: "Where is the retry ladder configured?",
			project: "demo",
			delivery: "answer",
			kind: "research",
			slug: "question",
		});

		const asked = await b.dispatcher.dispatch({
			jobId: question.id,
			task: "Where is the retry ladder configured?",
			scope: "S",
			risk: "low",
			model: b.model,
			fetch: false,
		});
		assert.equal(asked.state, "dispatched");
		assert.equal(asked.profile, "qa", "the delivery picks the profile; the kind stays research");

		const record = readFleet(b.home).jobs[0];
		assert.equal(record?.kind, "research");
		assert.equal(record?.delivery, "answer");
		assert.equal(record?.worker.role, "planner", "ROLES is fixed at three: qa reuses planner");

		// A Q&A job is a research job, so the artifact path is predeclared exactly
		// as for research — which is what makes the answer land inside the store the
		// parent's guards already refuse to read.
		assert.ok(existsSync(join(b.home, paths.artifactDir(question.id))));
		const brief = readFileSync(join(b.home, paths.briefFile(question.id)), "utf8");
		assert.ok(brief.includes(join(b.home, paths.artifactFile(question.id))));
		assert.match(brief, /a question about demo \(delivery: answer\)/);
		assert.ok(brief.includes("under 8 KiB"), "the answer bound is in the brief the worker actually gets");

		assert.match(brief, /## Repo map/);
		// Local clone config also governs linked leases, even with a cached map.
		git(b.clone, "config", "--local", "command-post.repoMap", "false");

		// And a caller who names a profile still gets it: the default is a default.
		const second = await b.ledger.create({
			title: "Which module owns the lease pool?",
			project: "demo",
			delivery: "answer",
			kind: "research",
			slug: "question2",
		});
		const overridden = await b.dispatcher.dispatch({
			jobId: second.id,
			task: "Which module owns the lease pool?",
			profile: "planner",
			model: b.model,
			fetch: false,
		});
		assert.equal(overridden.profile, "planner");
		assert.doesNotMatch(readFileSync(join(b.home, paths.briefFile(second.id)), "utf8"), /## Repo map/);
	},
);

// pi-command-post-autonomy-programme-cur.2.4: ask_on: [risk:high] gates a
// direct dispatch (not only a checkpoint), before any lease.
test("risk:high under ask_on refuses a direct dispatch before any lease, with one escalation; an operator-quoted decide then lets it proceed", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the bump",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});
	const dispatcher = b.makeDispatcher({ mandates });
	const job = await b.ledger.create({
		title: "rotate prod creds",
		project: "demo",
		delivery: "local",
		kind: "ship",
		slug: "prod-creds",
	});

	await assert.rejects(
		() =>
			dispatcher.dispatch({
				jobId: job.id,
				task: "Rotate the production database credentials.",
				model: b.model,
				fetch: false,
			}),
		/risk:high under ask_on/,
	);
	assert.deepEqual(b.fleet.read().jobs, [], "a risk:high refusal takes no lease and leaves no record");
	assert.equal(git(b.clone, "branch", "--list", job.id), "", "no orphan branch");
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "a risk:high refusal never takes a lease");

	const escalations = new EscalationStore({ home: b.home });
	const open = escalations.open();
	assert.equal(open.length, 1, "exactly one escalation");
	assert.equal(open[0]?.kind, "risk_high_irreversible");
	assert.match(open[0]?.question ?? "", new RegExp(job.id));

	// risk:low dispatches untouched by the same mandate.
	const lowRisk = await b.ledger.create({ title: "typo", project: "demo", delivery: "local", kind: "ship", slug: "typo" });
	const lowResult = await dispatcher.dispatch({ jobId: lowRisk.id, task: "Fix the typo in the README.", model: b.model, fetch: false });
	assert.equal(lowResult.state, "dispatched");

	// The operator authorizes the refused job id; the same dispatch now proceeds.
	await escalations.answer(open[0]?.id as string, { answer: "approve", by: "operator-quote" });
	const result = await dispatcher.dispatch({
		jobId: job.id,
		task: "Rotate the production database credentials.",
		model: b.model,
		fetch: false,
	});
	assert.equal(result.state, "dispatched");
});

test("4B2-T1c: a real Dispatcher's parallelism_full refusal reaches the queue coded; the head stays byte-identical, and a freed slot starts it", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({ projects: ["demo"], objective: "ship the queue", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, dispatch_parallelism: 1 });
	const dispatcher = b.makeDispatcher({ mandates });
	const first = await b.ledger.create({ title: "first", project: "demo", kind: "ship", delivery: "local", slug: "t1c-first" });
	assert.equal((await dispatcher.dispatch({ jobId: first.id, task: "Bump x.", model: b.model, fetch: false })).state, "dispatched");
	const job = await b.ledger.create({ title: "queued", project: "demo", kind: "ship", delivery: "local", slug: "t1c-queued" });
	const errors: unknown[] = [];
	const wakes: unknown[] = [];
	const queue = new DispatchQueue({
		home: b.home, owns: () => true, capacityFree: () => true, ledger: () => b.ledger, fleet: b.fleet, journal: (wake) => void wakes.push(wake),
		dispatch: (request) => dispatcher.dispatch({ jobId: request.jobId, task: request.task!, model: b.model, fetch: false }).catch((error: unknown) => {
			errors.push(error);
			throw error;
		}),
	});
	queue.enqueue(job.id, { task: "Bump x." });
	const file = join(b.home, LAYOUT.dispatchQueueFile);
	const before = readFileSync(file, "utf8");
	await queue.drain();
	assert.ok(errors[0] instanceof MandateError && errors[0].code === "parallelism_full", `coded refusal, got ${String(errors[0])}`);
	assert.equal(readFileSync(file, "utf8"), before, "the kept head is byte-identical");
	assert.deepEqual(queue.ids(), [job.id]);
	assert.equal(b.fleet.get(job.id), undefined, "no record");
	assert.ok(!treehouse(b.clone, "status").includes(job.id), "no lease");
	assert.equal(wakes.length, 0, "no wake-up");
});
// cp-itl4 6b (6B-T4): a refused dispatch of a job in an open batch raises nothing new and names the batch.
test("risk:high batch: a refused dispatch of a batched job names the batch and raises nothing; one approve dispatches every listed job", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({ projects: ["demo"], objective: "ship the bump", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"] });
	const dispatcher = b.makeDispatcher({ mandates });
	const task = "Rotate the production database credentials.";
	const jobs = [await b.ledger.create({ title: "rotate prod-a", project: "demo", delivery: "local", kind: "ship", slug: "prod-a" })];
	jobs.push(await b.ledger.create({ title: "rotate prod-b", project: "demo", delivery: "local", kind: "ship", slug: "prod-b" }));
	for (const job of jobs) await assert.rejects(() => dispatcher.dispatch({ jobId: job.id, task, model: b.model, fetch: false }), /risk:high under ask_on/);
	const escalations = new EscalationStore({ home: b.home });
	const { escalation, withdrawn } = await batchRiskHigh({ escalations, mandates, ledger: b.ledger }, { jobIds: jobs.map((job) => job.id) });
	assert.equal(withdrawn.length, 2);
	const count = escalations.list().length;

	await assert.rejects(() => dispatcher.dispatch({ jobId: jobs[0]!.id, task, model: b.model, fetch: false }), new RegExp(`${escalation.id} raised`));
	assert.equal(escalations.list().length, count, "no new escalation for a batched job");
	assert.deepEqual(b.fleet.read().jobs, [], "still no lease");

	await escalations.answer(escalation.id, { answer: "approve", by: "operator-quote" });
	for (const job of jobs) assert.equal((await dispatcher.dispatch({ jobId: job.id, task, model: b.model, fetch: false })).state, "dispatched");
});

// H6: an inferred risk:high warns; an assessed risk:high gates.
test("H6: an inferred-only risk:high with a recorded low dispatches under ask_on with the warning on the result, in the run journal and on the fleet routing; an explicit high still escalates", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the cleanup",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		dispatch_parallelism: 5,
		ask_on: ["risk:high"],
	});
	const dispatcher = b.makeDispatcher({ mandates });
	const task = "Delete the stale fixture and migrate the test helper.";

	// Explicit low from the parent: routing keeps low, the keyword high only warns.
	const explicit = await b.ledger.create({ title: "cleanup", project: "demo", delivery: "local", kind: "ship", slug: "h6-explicit" });
	const result = await dispatcher.dispatch({ jobId: explicit.id, task, risk: "low", model: b.model, fetch: false });
	assert.equal(result.state, "dispatched");
	assert.match(result.risk_warning ?? "", /risk:high inferred from keywords only \(delete, migrate\)/);
	const routed = readRunEvents(b.home, explicit.id).find((event) => event.type === "routing_resolved");
	assert.equal((routed?.payload as Record<string, unknown> | undefined)?.risk_warning, result.risk_warning, "the same line is in the run journal");

	// A planner-recorded low (the pipeline path): routing still takes the inferred high tier, the gate warns.
	const planned = await b.ledger.create({ title: "cleanup 2", project: "demo", delivery: "local", kind: "ship", slug: "h6-planned" });
	const second = await dispatcher.dispatch({ jobId: planned.id, task, recordedRisk: { risk: "low", from: "planner", provenance: "assessed" }, model: b.model, fetch: false });
	assert.equal(second.state, "dispatched");
	assert.match(second.risk_warning ?? "", /\(delete, migrate\); risk low was assessed by the planner, so ask_on risk:high warned instead of gating/);
	const record = b.fleet.get(planned.id);
	assert.equal(record?.routing?.risk, "high", "routing may still pick the risky tier");
	assert.equal(record?.routing?.provenance?.risk, "inferred");
	assert.equal(record?.routing?.recorded_risk, "low");
	assert.equal(new EscalationStore({ home: b.home }).open().length, 0, "nothing was escalated");

	// An explicit high is assessed: it still gates, exactly as before.
	const assessed = await b.ledger.create({ title: "cleanup 3", project: "demo", delivery: "local", kind: "ship", slug: "h6-high" });
	await assert.rejects(
		() => dispatcher.dispatch({ jobId: assessed.id, task, risk: "high", recordedRisk: { risk: "low", provenance: "explicit" }, model: b.model, fetch: false }),
		/risk:high under ask_on/,
	);
	assert.equal(new EscalationStore({ home: b.home }).open()[0]?.kind, "risk_high_irreversible");
});

// riskkw-f10: the job itself can record (label) or declare (header) its risk.
test("riskkw-f10: a job-recorded or header-declared low turns a keyword-only high into the named warning; every recorded, explicit and assessed high still gates", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, { maxTrees: 3 });
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the cleanup",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 20,
		dispatch_parallelism: 10,
		ask_on: ["risk:high"],
	});
	const dispatcher = b.makeDispatcher({ mandates });
	const task = "Delete the stale fixture and migrate the test helper.";
	const create = (slug: string, extra: { risk?: "low" | "high"; description?: string } = {}) =>
		b.ledger.create({ title: slug, project: "demo", delivery: "local", kind: "ship", slug, ...extra });
	const escalations = () => new EscalationStore({ home: b.home }).open();

	const labelled = await create("kw-label", { risk: "low" });
	const result = await dispatcher.dispatch({ jobId: labelled.id, task, model: b.model, fetch: false });
	assert.equal(result.state, "dispatched");
	assert.match(result.risk_warning ?? "", /\(delete, migrate\); risk low was recorded on the job's risk: label, so ask_on risk:high warned instead of gating/);
	const routing = b.fleet.get(labelled.id)?.routing;
	assert.equal(routing?.risk, "high", "a recorded low never lowers routing");
	assert.equal(routing?.provenance?.risk, "inferred");
	assert.equal(routing?.recorded_risk, "low");
	const routed = readRunEvents(b.home, labelled.id).find((event) => event.type === "routing_resolved")?.payload as Record<string, unknown> | undefined;
	assert.equal(routed?.recorded_risk, "low");
	assert.equal(routed?.recorded_risk_from, "job_label");
	assert.equal(escalations().length, 0, "nothing was escalated");

	const headed = await create("kw-task-header");
	const second = await dispatcher.dispatch({ jobId: headed.id, task: `Scope S, risk low.\n\n${task}`, model: b.model, fetch: false });
	assert.equal(second.state, "dispatched");
	assert.match(second.risk_warning ?? "", /risk low was recorded in the task header/);

	const described = await create("kw-desc-header", { description: "Scope S, risk low. Clean up the fixture." });
	const third = await dispatcher.dispatch({ jobId: described.id, task, model: b.model, fetch: false });
	assert.equal(third.state, "dispatched");
	assert.match(third.risk_warning ?? "", /risk low was recorded in the job description header/);
	assert.equal(escalations().length, 0);

	// A recorded high gates even on harmless words, and names where it was recorded.
	const high = await create("kw-high", { risk: "high" });
	await assert.rejects(() => dispatcher.dispatch({ jobId: high.id, task: "Fix the typo in the README.", model: b.model, fetch: false }), /risk:high under ask_on/);
	assert.match(escalations().find((e) => e.job_ids.includes(high.id))?.question ?? "", /risk high recorded on the job's risk: label/);
	assert.equal(b.fleet.get(high.id), undefined, "refused before any record");
	// ...and beats an explicit low on the dispatch.
	const highVsLow = await create("kw-high-low", { risk: "high" });
	await assert.rejects(() => dispatcher.dispatch({ jobId: highVsLow.id, task: "Fix the typo in the README.", risk: "low", model: b.model, fetch: false }), /risk:high under ask_on/);
	// An end-to-end gate for the other ordering: a task header declaring high against an explicit low on the dispatch.
	const headerHigh = await create("kw-header-high");
	await assert.rejects(
		() => dispatcher.dispatch({ jobId: headerHigh.id, task: `Scope S, risk high.\n\nFix the typo in the README.`, risk: "low", model: b.model, fetch: false }),
		/risk:high under ask_on/,
	);
	assert.match(escalations().find((e) => e.job_ids.includes(headerHigh.id))?.question ?? "", /risk high recorded in the task header/);
	// A recorded low never lowers an explicit or planner-assessed high, nor a keyword high with nothing recorded.
	const explicitHigh = await create("kw-explicit", { risk: "low" });
	await assert.rejects(() => dispatcher.dispatch({ jobId: explicitHigh.id, task, risk: "high", model: b.model, fetch: false }), /risk:high under ask_on/);
	const assessedHigh = await create("kw-assessed", { risk: "low" });
	await assert.rejects(
		() => dispatcher.dispatch({ jobId: assessedHigh.id, task, risk: "high", inputsFrom: { risk: "assessed" }, model: b.model, fetch: false }),
		/risk:high under ask_on/,
	);
	const bare = await create("kw-bare");
	await assert.rejects(() => dispatcher.dispatch({ jobId: bare.id, task, model: b.model, fetch: false }), /risk:high under ask_on/);
	const refused = [high, highVsLow, headerHigh, explicitHigh, assessedHigh, bare].map((job) => job.id);
	assert.deepEqual(escalations().filter((e) => e.kind === "risk_high_irreversible").flatMap((e) => e.job_ids).sort(), [...refused].sort(), "exactly one escalation per refused job");
});

test("an unavailable model fails before the lease: no orphan branch, no orphan lease", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t, { probe: { isAvailable: () => false, available: () => [] } });
	const job = await b.ledger.create({ title: "no model", project: "demo", delivery: "local", kind: "ship", slug: "nomodel" });

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: "mock/gone", fetch: false }),
		/no available model/,
	);

	assert.deepEqual(b.fleet.read().jobs, []);
	assert.equal(git(b.clone, "branch", "--list", job.id), "", "no orphan branch");
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "no orphan lease");
	assert.equal((await b.ledger.show(job.id)).status, "open", "the ledger is untouched by a failed dispatch");
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false, "a refusal writes no state at all");
});

test(
	"cp-ot3b: an override's effort is honoured, and an unserviceable one dispatches nothing",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		// The operator's rule: an explicit override is an instruction, so the effort
		// travels with the model instead of being replaced by the profile default.
		const b = await bench(t, {
			probe: {
				isAvailable: () => true,
				available: () => ["mock/capped"],
				supportedThinking: () => ["off", "minimal", "low", "medium", "high"],
			},
		});
		const job = await b.ledger.create({ title: "effort", project: "demo", delivery: "local", kind: "ship", slug: "effort" });

		// xhigh is not serviceable here: refuse before the lease, name the ask.
		await assert.rejects(
			() => b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, thinking: "xhigh", fetch: false }),
			/thinking=xhigh/,
		);
		assert.deepEqual(b.fleet.read().jobs, [], "nothing was dispatched");
		assert.equal(git(b.clone, "branch", "--list", job.id), "", "no orphan branch");
		assert.ok(!/leased/.test(treehouse(b.clone, "status")), "no orphan lease");
		assert.equal((await b.ledger.show(job.id)).status, "open", "the ledger is untouched by a refused dispatch");

		// A serviceable effort reaches the worker's routing decision and its record.
		const ok = await b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, thinking: "low", fetch: false });
		assert.equal(ok.state, "dispatched");
		assert.match(ok.routing ?? "", /thinking=low effort=override/);
		assert.equal(readFleet(b.home).jobs[0]?.routing?.thinking, "low");
	},
);

test(
	"cp-reviewer-routing: a profile's own effort never grounds an ordinary dispatch on a model that serves no level",
	{ skip: SKIP, timeout: 180_000 },
	async (t) => {
		// Review finding (2). Widening the effort check from "what the caller asked
		// for" to "what will actually spawn" put every shipped profile's own
		// `thinking:` in front of the probe, on every dispatch — not just reviewer
		// spawns. The failure mode it must never have: an ordinary implementer
		// dispatch refused before its lease because the model reports no serviceable
		// level, which pi treats as inert rather than as an error.
		//
		// The probe is the real `registryProbe` over pi-shaped metadata, and the
		// metadata is the `[]` case: every level nulled, `off` included.
		const b = await bench(t);
		const parts = splitModelRef(b.model);
		assert.ok(parts, `${b.model} is not a provider/model-id ref`);
		const probe = registryProbe({
			find: (provider, modelId) =>
				provider === parts.provider && modelId === parts.modelId
					? {
							provider,
							id: modelId,
							reasoning: true,
							thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, null])),
						}
					: undefined,
			hasConfiguredAuth: () => true,
			getAvailable: () => [{ provider: parts.provider, id: parts.modelId }],
		});
		assert.deepEqual(probe.supportedThinking?.(b.model), [], "fixture check: this is the empty-answer case");

		const job = await b.ledger.create({ title: "inert", project: "demo", delivery: "local", kind: "ship", slug: "inert" });
		const result = await b
			.makeDispatcher({ probe })
			.dispatch({ jobId: job.id, task: "Bump x to 2 in src/app.ts.", model: b.model, fetch: false });

		assert.equal(result.state, "dispatched");
		// The profile's level is carried, not dropped and not refused: validated,
		// never substituted.
		const profileThinking = loadProfile(PROFILES_DIR, "implementer").frontmatter.thinking;
		assert.match(result.routing ?? "", new RegExp(`thinking=${profileThinking}`));
		assert.equal(readFleet(b.home).jobs[0]?.routing?.thinking, profileThinking);
	},
);

test("a blocked or closed issue is never dispatched", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const blocker = await b.ledger.create({ title: "first", project: "demo", delivery: "local", kind: "ship", slug: "first" });
	const blocked = await b.ledger.create({ title: "second", project: "demo", delivery: "local", kind: "ship", slug: "second" });
	await b.ledger.addDep(blocked.id, blocker.id);

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: blocked.id, task: "do it", model: b.model, fetch: false }),
		new RegExp(`is blocked by ${blocker.id}`),
	);

	await b.ledger.close(blocker.id, "done");
	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: blocker.id, task: "do it", model: b.model, fetch: false }),
		/is closed/,
	);
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "refusals never take a lease");
});

test("an unlabelled issue is not a job", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	// Ledger.update() refuses to strip a required label (requireJobLabels runs on
	// every edit), so a job missing delivery: can only come from a raw import —
	// which does not validate the dispatchability contract, only the JobSchema.
	const at = "2026-09-04T10:00:00Z";
	await b.ledger.importJobs([
		{
			id: "cp-unlabelled",
			title: "unlabelled",
			status: "open",
			labels: ["project:demo"],
			blocked_by: [],
			comments: [],
			created_at: at,
			updated_at: at,
		},
	]);

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: "cp-unlabelled", task: "do it", model: b.model, fetch: false }),
		/not dispatchable/,
	);
});

test("a failure after the lease returns the lease and records nothing", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "leftover", project: "demo", delivery: "local", kind: "ship", slug: "leftover" });

	// Branch creation fails the way a leftover branch fails — after the lease
	// has already been taken, which is the interesting half of the cleanup.
	const dispatcher = b.makeDispatcher({
		git: async (cwd, args) => {
			if (args[0] === "switch" || args[0] === "checkout") {
				return { status: 1, stdout: "", stderr: `fatal: a branch named '${job.id}' already exists` };
			}
			try {
				return { status: 0, stdout: git(cwd, ...args), stderr: "" };
			} catch (error) {
				return { status: 1, stdout: "", stderr: (error as Error).message };
			}
		},
	});

	await assert.rejects(
		() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		(error: Error) => {
			assert.ok(error instanceof DispatchError, error.message);
			assert.match(error.message, /cannot create branch/);
			return true;
		},
	);
	assert.deepEqual(b.fleet.read().jobs, [], "no half-dispatched job");
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "the lease went back");
	assert.equal((await b.ledger.show(job.id)).status, "open");
});

test("a leftover job branch is refused before the lease", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "taken", project: "demo", delivery: "local", kind: "ship", slug: "taken" });
	git(b.clone, "branch", job.id, "origin/main");

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		/branch_exists/,
	);
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "a refusal never takes a lease");
});

test("a refused ledger claim leaves no leftover fleet record (pi-command-post-aap)", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "stuck", project: "demo", delivery: "local", kind: "ship", slug: "stuck" });
	// Force the job into the one state `ledger.claim` refuses: deferred (an
	// unenrolled tracker import). The dispatch reaches the fleet write and the
	// ledger claim before failing, which is exactly the order this regression covers.
	await b.ledger.update(job.id, { status: "deferred" });

	await assert.rejects(
		() => b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		/is deferred: run cp_tracker import again to finish enrollment/,
	);
	assert.deepEqual(b.fleet.read().jobs, [], "a refused claim leaves no leftover fleet record");
});

// ---------------------------------------------------------------------------
// cp-bw4: a failed dispatch must not leave the job branch it just created
// behind, and must not touch a branch that could be holding work.
// ---------------------------------------------------------------------------

type GitRun = { status: number | null; stdout: string; stderr: string };

/** The injected git runner, recording every argv and optionally faulting one. */
function recordingGit(log: string[][], fault?: (cwd: string, args: readonly string[]) => GitRun | undefined): GitRunner {
	return async (cwd, args) => {
		log.push([...args]);
		const injected = fault?.(cwd, args);
		if (injected) return injected;
		try {
			return { status: 0, stdout: git(cwd, ...args), stderr: "" };
		} catch (error) {
			return { status: 1, stdout: "", stderr: (error as Error).message };
		}
	};
}

/**
 * A preflight that passes before the lease and refuses the *leased worktree* —
 * i.e. the first thing after `#createJobBranch` that can throw. `onWorktree`
 * runs while the lease is still held, which is how a test can put a real commit
 * on the branch the cleanup is about to consider.
 */
function refuseLeasedWorktree(real: Preflight, onWorktree?: (worktree: string) => void): Preflight {
	return {
		check: async (request: PreflightRequest): Promise<PreflightResult> => {
			const result = await real.check(request);
			if (!request.worktree) return result;
			onWorktree?.(request.worktree);
			return {
				...result,
				status: "fail",
				findings: [
					...result.findings,
					{ code: "worktree_dirty", level: "fail", message: "injected: the leased worktree is unusable" },
				],
			};
		},
	} as unknown as Preflight;
}

const deletedBranch = (log: string[][], branch: string): boolean =>
	log.some((args) => args[0] === "branch" && args[1] === "-D" && args[2] === branch);

/**
 * A fleet whose write fails. It is the last thing in a dispatch that can throw,
 * and the only injection point that reaches the branch cleanup with the run
 * recorder still open — which is where `job_branch_cleaned` is journaled.
 */
function fleetThatRefusesTheRecord(real: FleetStore, onAdd?: (record: FleetRecord) => void): FleetStore {
	return new Proxy(real, {
		get(target, prop) {
			if (prop === "add") {
				return async (record: FleetRecord) => {
					onAdd?.(record);
					throw new Error("injected: the fleet write failed");
				};
			}
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/** The one `job_branch_cleaned` line a failed dispatch is allowed to write. */
function onlyCleanupEvent(events: readonly RunEvent[]): Record<string, unknown> {
	const cleaned = events.filter((event) => event.source === "cp" && event.type === "job_branch_cleaned");
	assert.equal(cleaned.length, 1, `expected exactly one job_branch_cleaned event, saw ${cleaned.length}`);
	return (cleaned[0]?.payload ?? {}) as Record<string, unknown>;
}

test("the branch removal is journaled with the sha it removed", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "journal", project: "demo", delivery: "local", kind: "ship", slug: "journal" });
	const tip = git(b.clone, "rev-parse", "origin/main");
	// The fleet write fails: late enough that the run recorder is open, so the
	// destructive step has somewhere to be observed.
	const dispatcher = b.makeDispatcher({ fleet: fleetThatRefusesTheRecord(b.fleet) });

	await assert.rejects(
		() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		/injected: the fleet write failed/,
	);

	const payload = onlyCleanupEvent(readRunEvents(b.home, job.id));
	assert.equal(payload.deleted, true);
	assert.equal(payload.at, tip, "the log names the exact sha that was removed");
	assert.equal(payload.branch, job.id);
	assert.equal(payload.reason, undefined, "a clean removal has nothing to explain");
	assert.equal(git(b.clone, "branch", "--list", job.id), "", "and the branch really is gone");
});

test("a branch with commits is journaled as left in place, with the reason", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "journal keep", project: "demo", delivery: "local", kind: "ship", slug: "jkeep" });
	const dispatcher = b.makeDispatcher({
		fleet: fleetThatRefusesTheRecord(b.fleet, (record) => {
			git(record.worktree, "commit", "--allow-empty", "-m", "work nobody may lose");
		}),
	});

	await assert.rejects(() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }), /left in place/);

	const payload = onlyCleanupEvent(readRunEvents(b.home, job.id));
	assert.equal(payload.deleted, false);
	assert.equal(payload.at, undefined, "nothing was removed, so no sha is claimed");
	assert.match(String(payload.reason), /has commits on it/);
	assert.notEqual(git(b.clone, "branch", "--list", job.id), "", "the branch is still there");
});

test("a delete that fails is journaled as left in place, with the reason", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "journal stuck", project: "demo", delivery: "local", kind: "ship", slug: "jstuck" });
	const log: string[][] = [];
	const dispatcher = b.makeDispatcher({
		fleet: fleetThatRefusesTheRecord(b.fleet),
		git: recordingGit(log, (_cwd, args) =>
			args[0] === "branch" && args[1] === "-D"
				? { status: 1, stdout: "", stderr: "fatal: injected delete failure" }
				: undefined,
		),
	});

	await assert.rejects(() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }), /left in place/);

	const payload = onlyCleanupEvent(readRunEvents(b.home, job.id));
	assert.equal(payload.deleted, false);
	assert.equal(payload.at, undefined);
	assert.match(String(payload.reason), /the delete failed/);
	assert.ok(deletedBranch(log, job.id), "the delete was attempted before it was reported as failed");
});

// The guard, unit-tested: no lease, no ledger, no worker — just the predicate
// that decides whether anything destructive runs at all.
test("the cleanup never runs git at all on a branch name that is not a job id", async () => {
	for (const branch of ["../../../etc/passwd", "feature/main", "-D", "", "a branch with spaces"]) {
		const log: string[][] = [];
		const outcome = await cleanupCreatedJobBranch({
			git: recordingGit(log),
			worktree: "/pool/1/demo",
			branch,
			base: "main",
		});
		assert.equal(outcome.deleted, false, `${branch} must not be deleted`);
		assert.equal(outcome.at, undefined);
		assert.match(String(outcome.note), /not a job id/);
		assert.deepEqual(log, [], `${branch} must not reach git at all`);
	}
});

test("the cleanup leaves a branch alone when its tip cannot be read", async () => {
	const log: string[][] = [];
	const outcome = await cleanupCreatedJobBranch({
		git: recordingGit(log, (_cwd, args) =>
			args[0] === "rev-parse" ? { status: 1, stdout: "", stderr: "fatal: no such ref" } : undefined,
		),
		worktree: "/pool/1/demo",
		branch: "cp-unreadable-abc",
		base: "main",
	});
	assert.equal(outcome.deleted, false);
	assert.match(String(outcome.note), /tip could not be read/);
	assert.ok(!log.some((args) => args[0] === "branch" || args[0] === "switch"), "nothing destructive was issued");
});

test("a failure after the branch is created removes the empty branch it created", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "cleanup", project: "demo", delivery: "local", kind: "ship", slug: "cleanup" });
	const log: string[][] = [];
	const dispatcher = b.makeDispatcher({
		preflight: refuseLeasedWorktree(new Preflight({ registry: b.registry, fleet: b.fleet })),
		git: recordingGit(log),
	});

	await assert.rejects(
		() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		(error: Error) => {
			assert.ok(error instanceof DispatchError, error.message);
			assert.match(error.message, /preflight refused the leased worktree/);
			assert.ok(!/left in place/.test(error.message), "nothing was left behind to report");
			return true;
		},
	);

	assert.ok(deletedBranch(log, job.id), "the branch delete was issued");
	assert.equal(git(b.clone, "branch", "--list", job.id), "", "no orphan branch");
	assert.deepEqual(b.fleet.read().jobs, [], "no half-dispatched job");
	assert.ok(!/leased/.test(treehouse(b.clone, "status")), "the lease went back");

	// The property the operator actually cares about: the same job id dispatches
	// again, end to end, with nobody deleting a branch by hand first.
	const second = await b.dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false });
	assert.equal(second.state, "dispatched");
	assert.equal(second.branch, job.id);
	assert.equal(git(second.worktree, "symbolic-ref", "--short", "HEAD"), job.id);
});

test("a branch with commits on it survives the failed dispatch", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "keep", project: "demo", delivery: "local", kind: "ship", slug: "keep" });
	const log: string[][] = [];
	const dispatcher = b.makeDispatcher({
		preflight: refuseLeasedWorktree(new Preflight({ registry: b.registry, fleet: b.fleet }), (worktree) => {
			git(worktree, "commit", "--allow-empty", "-m", "work nobody may lose");
		}),
		git: recordingGit(log),
	});

	await assert.rejects(
		() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		(error: Error) => {
			assert.ok(error instanceof DispatchError, error.message);
			// The instance the dispatch threw, not a wrapper: same type, same
			// payload, its own message intact as the first line. Only the note about
			// what could not be cleaned up is appended.
			assert.equal(error.constructor.name, "DispatchError");
			assert.notEqual(error.result, undefined, "the DispatchError keeps its preflight payload");
			const lines = error.message.split("\n");
			assert.match(lines[0] ?? "", /preflight refused the leased worktree/, "the original error still propagates");
			assert.match(lines.at(-1) ?? "", /left in place/, "the note is appended, never substituted");
			return true;
		},
	);

	assert.ok(!deletedBranch(log, job.id), "a branch with commits is never deleted");
	assert.notEqual(git(b.clone, "branch", "--list", job.id), "", "the branch is still there");
	assert.equal(git(b.clone, "log", "-1", "--format=%s", job.id), "work nobody may lose");
});

test("a failing branch cleanup never masks the original error", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "masked", project: "demo", delivery: "local", kind: "ship", slug: "masked" });
	const log: string[][] = [];
	const dispatcher = b.makeDispatcher({
		preflight: refuseLeasedWorktree(new Preflight({ registry: b.registry, fleet: b.fleet })),
		git: recordingGit(log, (_cwd, args) =>
			args[0] === "branch" && args[1] === "-D"
				? { status: 1, stdout: "", stderr: "fatal: injected delete failure" }
				: undefined,
		),
	});

	await assert.rejects(
		() => dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false }),
		(error: Error) => {
			assert.ok(error instanceof DispatchError, error.message);
			assert.match(error.message, /preflight refused the leased worktree/, "the cause, not the cleanup, is what escapes");
			assert.match(error.message, /left in place/);
			return true;
		},
	);
	assert.ok(deletedBranch(log, job.id), "the delete was attempted");
	assert.notEqual(git(b.clone, "branch", "--list", job.id), "", "and it is still there, because it failed");
});

test("a successful dispatch deletes no branch at all", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({ title: "happy", project: "demo", delivery: "local", kind: "ship", slug: "happy" });
	const log: string[][] = [];
	const dispatcher = b.makeDispatcher({ git: recordingGit(log) });

	const result = await dispatcher.dispatch({ jobId: job.id, task: "do it", model: b.model, fetch: false });
	assert.equal(result.state, "dispatched");
	assert.ok(!deletedBranch(log, job.id), "the happy path issues no branch deletion");
	assert.ok(!log.some((args) => args[0] === "switch" && args[1] === "--detach"), "and never leaves the job branch");
	assert.equal(git(result.worktree, "symbolic-ref", "--short", "HEAD"), job.id);
});

test("dispatch result is one JSON object with the ported fields", async () => {
	const result: DispatchResult = {
		job_id: "cp-a",
		worker: "cp-a",
		worktree: "/pool/1/demo",
		branch: "cp-a",
		state: "dispatched",
		receipt: "accepted",
	};
	const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(parsed).sort(), ["branch", "job_id", "receipt", "state", "worker", "worktree"]);
});

// ---------------------------------------------------------------------------
// Routing T5: the route preview (cp_dispatch dry_run)
// ---------------------------------------------------------------------------

/**
 * Anything a preview must not touch. Every property access throws, so "took no
 * lease, spawned no worker, wrote no fleet record" is proven by construction
 * rather than asserted after the fact.
 */
function forbidden<T>(what: string): T {
	return new Proxy(
		{},
		{
			get(_target, property) {
				throw new Error(`a preview touched ${what}.${String(property)}`);
			},
		},
	) as T;
}

interface PreviewBench {
	home: string;
	ledger: Ledger;
	dispatcher(routing: DispatcherOptions["routing"], probe?: ModelProbe, mandates?: MandateStore): Dispatcher;
	cleanup(): void;
}

function previewBench(t: { after(fn: () => void): void }): PreviewBench {
	const home = createScratchHome();
	const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
	t.after(() => {
		scratch.cleanup();
		home.cleanup();
	});
	return {
		home: home.path,
		ledger: scratch.ledger,
		dispatcher: (routing, probe, mandates) =>
			new Dispatcher({
				home: home.path,
				profilesDir: PROFILES_DIR,
				briefsDir: BRIEFS_DIR,
				ledger: scratch.ledger,
				routing,
				probe: probe ?? ALWAYS_AVAILABLE,
				// A preview that reaches any of these is a preview with side effects.
				registry: forbidden<ProjectRegistry>("the project registry"),
				fleet: forbidden<FleetStore>("the fleet"),
				preflight: forbidden<Preflight>("preflight"),
				leases: forbidden<LeaseManager>("the lease manager"),
				manager: forbidden<WorkerManager>("the worker manager"),
				...(mandates ? { mandates } : {}),
			}),
		cleanup: () => {
			scratch.cleanup();
			home.cleanup();
		},
	};
}

const PREVIEW_RUBRIC = {
	schema_version: 1 as const,
	allow: ["**"],
	rubric: [
		{ id: "risky-ship", role: "implementer" as const, risk: "high" as const, model: "mock/careful", thinking: "high" as const },
		{ id: "small-ship", role: "implementer" as const, scope: ["S" as const], model: "mock/quick", thinking: "low" as const },
	],
};

test("preview: the route, resolved by the dispatch path, with nothing taken", async (t) => {
	const b = previewBench(t);
	const job = await b.ledger.create({
		title: "rotate the production credentials",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		slug: "rotate",
	});

	const preview = await b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: job.id, task: "Rotate production credentials." });

	// The effective inputs and their provenance: the risk was inferred from the
	// job's own words, exactly as a dispatch would have inferred it.
	assert.equal(preview.preview, true);
	assert.equal(preview.job_id, job.id);
	assert.equal(preview.project, "demo");
	assert.equal(preview.kind, "ship");
	assert.equal(preview.delivery, "pr");
	assert.equal(preview.profile, "implementer");
	assert.equal(preview.routing.risk, "high");
	assert.deepEqual(preview.routing.provenance, { scope: "defaulted", risk: "inferred" });
	assert.ok((preview.routing.reasons ?? []).length > 0, "an inferred axis carries its evidence");

	// Source, rule, model and effort — the whole decision, not just a model.
	assert.equal(preview.decision?.model, "mock/careful");
	assert.equal(preview.decision?.source, "rubric");
	assert.equal(preview.decision?.rule, "risky-ship");
	assert.equal(preview.decision?.thinking, "high");
	assert.equal(preview.line, "source=rubric model=mock/careful rule=risky-ship thinking=high");
	assert.equal(preview.availability?.available, true);
	assert.equal(preview.availability?.supported_thinking, undefined, "a probe with no metadata says nothing, never 'unsupported'");
	assert.equal(preview.error, undefined);
	assert.deepEqual(preview.task, { source: "task", bytes: "Rotate production credentials.".length });

	// Nothing was taken and nothing was written: no fleet, no run directory, no
	// brief, no lease — and the ledger job is still open, never claimed.
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false, "a preview wrote a fleet file");
	assert.equal(existsSync(join(b.home, paths.runDir(job.id))), false, "a preview created a run directory");
	assert.equal(existsSync(join(b.home, LAYOUT.sessions)), false, "a preview created a session directory");
	assert.equal((await b.ledger.show(job.id)).status, "open", "a preview claimed the job");
});

test("preview: an explicit model and effort, a QA job's profile, and a project row all resolve as they would at dispatch", async (t) => {
	const b = previewBench(t);
	const ship = await b.ledger.create({ title: "small tidy-up", project: "demo", delivery: "pr", kind: "ship", slug: "tidy" });
	const qa = await b.ledger.create({ title: "where is the retry?", project: "demo", delivery: "answer", kind: "research", slug: "where" });

	// An override carries model AND effort, and the line says the effort was the
	// caller's — the same record `formatRoutingDecision` prints at dispatch.
	const overridden = await b
		.dispatcher(PREVIEW_RUBRIC)
		.preview({ jobId: ship.id, task: "tidy up", model: "mock/named", thinking: "xhigh" });
	assert.equal(overridden.decision?.source, "override");
	assert.equal(overridden.decision?.model, "mock/named");
	assert.equal(overridden.decision?.thinking, "xhigh");
	assert.match(overridden.line ?? "", /effort=override/);

	// cp-u3o4: a delivery:answer job previews with the QA profile, because that is
	// the profile the dispatch would load.
	const answer = await b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: qa.id, task: "look and tell me" });
	assert.equal(answer.profile, "qa");
	assert.equal(answer.kind, "research");
	assert.equal(answer.delivery, "answer");

	// A caller-supplied axis wins its own axis, and the row it selects is named.
	const small = await b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: ship.id, task: "tidy up", scope: "S", risk: "low" });
	assert.equal(small.decision?.rule, "small-ship");
	assert.deepEqual(small.routing.provenance, { scope: "explicit", risk: "explicit" });
});

test("preview: a route that fell back shows what it stepped over, and the model it would spawn", async (t) => {
	const b = previewBench(t);
	const job = await b.ledger.create({ title: "tidy up", project: "demo", delivery: "pr", kind: "ship", slug: "tidy" });
	const ladder = {
		...PREVIEW_RUBRIC,
		rubric: [
			{
				id: "small-ship",
				role: "implementer" as const,
				scope: ["S" as const],
				model: "mock/quick",
				fallbacks: ["mock/spare"],
				thinking: "low" as const,
			},
		],
	};
	const onlySpare: ModelProbe = { isAvailable: (model) => model === "mock/spare", available: () => ["mock/spare"] };
	const preview = await b.dispatcher(ladder, onlySpare).preview({ jobId: job.id, task: "tidy up", scope: "S", risk: "low" });

	assert.equal(preview.decision?.model, "mock/spare");
	assert.equal(preview.decision?.rule, "small-ship");
	assert.deepEqual(preview.decision?.attempted, [{ model: "mock/quick", refusal: "availability" }]);
	assert.equal(preview.line, "source=rubric model=mock/spare rule=small-ship thinking=low attempted=mock/quick(availability)");
	assert.equal(preview.availability?.available, true, "the model that would spawn is the one that was probed");
});

test("preview: a routing refusal is reported, not thrown, and an open blocker is visible", async (t) => {
	const b = previewBench(t);
	const job = await b.ledger.create({ title: "ship it", project: "demo", delivery: "pr", kind: "ship", slug: "ship-it" });
	const blocker = await b.ledger.create({ title: "first this", project: "demo", delivery: "pr", kind: "ship", slug: "first" });
	await b.ledger.addDep(job.id, blocker.id);

	const nothingAvailable: ModelProbe = { isAvailable: () => false, available: () => [] };
	const preview = await b.dispatcher(PREVIEW_RUBRIC, nothingAvailable).preview({ jobId: job.id, task: "ship it" });

	assert.equal(preview.decision, undefined);
	assert.equal(preview.availability, undefined);
	// The row that fires here names one model, so this is the single-candidate
	// refusal, unchanged in kind by pi-command-post-0a9 and naming the new fix.
	assert.match(preview.error ?? "", /no available model/);
	assert.match(preview.error ?? "", /This route has no other candidate/);
	assert.deepEqual(preview.blockers, [blocker.id], "a preview reports the refusal a dispatch would raise");
	// The inputs are still reported: what routing was given is knowable even when
	// what it resolved to is not.
	assert.equal(preview.routing.scope, "S");

	// The allowlist refusal takes the same road — it is a routing refusal, so it
	// is an answer about what a dispatch would do, not a failure to answer.
	const disallowed = await b
		.dispatcher({ ...PREVIEW_RUBRIC, allow: ["mock/*"] })
		.preview({ jobId: job.id, task: "ship it", model: "forbidden/model" });
	assert.equal(disallowed.decision, undefined);
	assert.match(disallowed.error ?? "", /the allowlist refuses/);
	assert.equal(disallowed.profile, "implementer", "everything resolved before the refusal is still reported");

	// And an unserviceable effort, the third shape of the same refusal.
	const shallow: ModelProbe = { isAvailable: () => true, supportedThinking: () => ["low"] };
	const tooMuch = await b
		.dispatcher(PREVIEW_RUBRIC, shallow)
		.preview({ jobId: job.id, task: "ship it", model: "mock/quick", thinking: "xhigh" });
	assert.equal(tooMuch.decision, undefined);
	assert.match(tooMuch.error ?? "", /cannot serve \(available: low\)/);

	// What cannot be *read* still throws, exactly as it does at dispatch: there is
	// no route to preview when the request itself is unusable.
	await assert.rejects(
		() => b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: job.id, task: "a", taskFile: "/nowhere" }),
		/pass task or taskFile, not both/,
	);
	await assert.rejects(() => b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: "cp-nope", task: "a" }));
});

test("preview: a task file's body never travels in the result, and config changes belong to the dispatch", async (t) => {
	const b = previewBench(t);
	const job = await b.ledger.create({ title: "handover", project: "demo", delivery: "pr", kind: "ship", slug: "handover" });
	const taskFile = join(b.home, "plan.md");
	const secretish = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	writeFileSync(taskFile, `# Plan\n\nMeasured during the run: ${secretish}\n`);

	const preview = await b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: job.id, taskFile });
	const serialized = JSON.stringify(preview);
	assert.equal(preview.task.source, "task_file");
	assert.equal(preview.task.path, taskFile);
	assert.ok(preview.task.bytes > 0);
	assert.ok(!serialized.includes(secretish), "a task file's body reached the preview payload");
	assert.ok(!serialized.includes("# Plan"), "a task file's body reached the preview payload");

	// A preview reserves nothing: the config is re-read per call, so the next
	// resolution is the new policy's, never the one a preview reported.
	const before = await b.dispatcher(PREVIEW_RUBRIC).preview({ jobId: job.id, taskFile, scope: "S", risk: "low" });
	assert.equal(before.decision?.model, "mock/quick");
	const rerouted = {
		...PREVIEW_RUBRIC,
		rubric: [{ id: "small-ship", role: "implementer" as const, scope: ["S" as const], model: "mock/elsewhere" }],
	};
	const after = await b.dispatcher(rerouted).preview({ jobId: job.id, taskFile, scope: "S", risk: "low" });
	assert.equal(after.decision?.model, "mock/elsewhere", "the live config decides, never a stale preview");
});

test("preview: dry_run reports would ask: risk:high without escalating anything", async (t) => {
	const b = previewBench(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({
		projects: ["demo"],
		objective: "ship the bump",
		expiry: isoTimestamp(new Date(Date.now() + 86_400_000)),
		spend_cap: { usd: 10, tokens: 100_000 },
		job_cap: 10,
		ask_on: ["risk:high"],
	});
	const job = await b.ledger.create({ title: "rotate prod creds", project: "demo", delivery: "pr", kind: "ship", slug: "prod-creds" });

	const preview = await b.dispatcher(PREVIEW_RUBRIC, undefined, mandates).preview({
		jobId: job.id,
		task: "Rotate the production database credentials.",
	});
	assert.equal(preview.mandate_gate, "would ask: risk:high");
	assert.equal(new EscalationStore({ home: b.home }).list().length, 0, "a dry run raises nothing");

	const low = await b.ledger.create({ title: "typo", project: "demo", delivery: "pr", kind: "ship", slug: "typo" });
	const lowPreview = await b.dispatcher(PREVIEW_RUBRIC, undefined, mandates).preview({
		jobId: low.id,
		task: "Fix the typo in the README.",
	});
	assert.equal(lowPreview.mandate_gate, undefined);

	// riskkw-f10: a risk:high label asks on harmless words and routes as an explicit high...
	const labelledHigh = await b.ledger.create({ title: "typo high", project: "demo", delivery: "pr", kind: "ship", slug: "typo-high", risk: "high" });
	const highPreview = await b.dispatcher(PREVIEW_RUBRIC, undefined, mandates).preview({ jobId: labelledHigh.id, task: "Fix the typo in the README." });
	assert.equal(highPreview.mandate_gate, "would ask: risk:high");
	assert.equal(highPreview.routing.risk, "high");
	assert.equal(highPreview.routing.provenance?.risk, "explicit");
	// ...and a risk:low label says nothing for a keyword-only high, while routing keeps the inferred high.
	const labelledLow = await b.ledger.create({ title: "cleanup low", project: "demo", delivery: "pr", kind: "ship", slug: "cleanup-low", risk: "low" });
	const lowLabelPreview = await b.dispatcher(PREVIEW_RUBRIC, undefined, mandates).preview({ jobId: labelledLow.id, task: "Delete the stale fixture and migrate the test helper." });
	assert.equal(lowLabelPreview.mandate_gate, undefined);
	assert.equal(lowLabelPreview.routing.risk, "high");
	assert.equal(new EscalationStore({ home: b.home }).list().length, 0, "a dry run raises nothing");
});

test("preview: the same request dispatched afterwards lands on exactly what the preview said", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const job = await b.ledger.create({
		title: "migrate the billing tables across every service",
		project: "demo",
		delivery: "pr",
		kind: "ship",
		slug: "migrate",
	});
	const request = { jobId: job.id, task: "Migrate the billing tables across every service.", model: b.model, fetch: false };

	const preview = await b.dispatcher.preview(request);
	// Nothing at all happened yet: no fleet file, no run directory, no claim.
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
	assert.equal(existsSync(join(b.home, paths.runDir(job.id))), false);
	assert.equal((await b.ledger.show(job.id)).status, "open");

	const result = await b.dispatcher.dispatch(request);
	assert.equal(result.model, preview.decision?.model);
	assert.equal(result.profile, preview.profile);
	assert.equal(result.routing, preview.line, "the preview's line IS the line the dispatch printed");
	// The inputs and their provenance agree too, down to the inferred axes: both
	// came from one `resolveRoutingInputs` call over the same words.
	assert.deepEqual(readFleet(b.home).jobs[0]?.routing, preview.routing);
});
