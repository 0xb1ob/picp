/**
 * T22 acceptance: the voting math, unit-tested, and the pass itself behind its
 * flag — off by default, opted into per job, one pass per job.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import {
	DEFAULT_ORIGIN,
	DEFAULT_QUALITY_THRESHOLD,
	EMPTY_USAGE,
	type JobRouting,
	type QualityConfig,
	type QualityReport,
	type QualityVote,
	isoTimestamp,
	paths,
	PENDING_REVIEW_FILE,
	QUALITY_LENSES,
	type RoutingConfig,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { loadProfile } from "../src/profiles.ts";
import { assembleBrief, readBriefTemplate } from "../src/profiles.ts";
import {
	fixesFrom,
	formatQuality,
	isEnabled,
	isQualityWait,
	lensesFor,
	loadQualityConfig,
	QualityError,
	QualityPass,
	QUALITY_OFF,
	qualityFixMessage,
	resolveQualityConfig,
	tallyVotes,
} from "../src/quality.ts";
import { ReviewRuns, type ReviewWakeup } from "../src/review-runs.ts";
import { DEFAULT_ROUTING_CONFIG, type ModelProbe } from "../src/routing.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	argOf,
	captureSpawns,
	createAgentDir,
	createScratchHome,
	MockProvider,
	REPO_ROOT,
	type ScriptStep,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

test("loadQualityConfig reads <home>/.pi-command-post/data/quality.json, never a top-level data/ (cp-u3i2)", (t) => {
	const home = createScratchHome();
	t.after(home.cleanup);
	// Legacy-layout negative fixture: the old top-level file alone is not config.
	mkdirSync(join(home.path, "data"), { recursive: true });
	writeFileSync(join(home.path, "data/quality.json"), JSON.stringify({ verify: true }));
	assert.equal(loadQualityConfig(home.path), undefined);
	mkdirSync(join(home.path, ".pi-command-post/data"), { recursive: true });
	writeFileSync(join(home.path, ".pi-command-post/data/quality.json"), JSON.stringify({ verify: true }));
	assert.deepEqual(loadQualityConfig(home.path), { verify: true });
});

const MOCK_ONLY: ModelProbe = { isAvailable: (model) => model.startsWith("mock/") };

function vote(overrides: Partial<QualityVote> = {}): QualityVote {
	return { lens: "evidence", sound: true, reasons: [], model: "mock/voter", ...overrides };
}

// ---------------------------------------------------------------------------
// the math
// ---------------------------------------------------------------------------

test("the tally is a fraction of every expected vote, and an abstention is not a yes", () => {
	assert.deepEqual(tallyVotes([vote(), vote({ sound: false })], 0.5), {
		sound: true,
		sound_count: 1,
		total: 2,
		ratio: 0.5,
		threshold: 0.5,
	});
	// Threshold is >=, so a 1-of-2 split passes at 0.5 and fails at 0.6.
	assert.equal(tallyVotes([vote(), vote({ sound: false })], 0.6).sound, false);
	assert.equal(tallyVotes([vote(), vote(), vote({ sound: false })], 0.66).sound, true);

	// An abstention counts in the denominator: a panel that could not answer
	// has approved nothing.
	const abstained = tallyVotes([vote(), vote({ sound: true, abstained: true })], 0.5);
	assert.equal(abstained.sound_count, 1);
	assert.equal(abstained.total, 2);
	assert.equal(abstained.sound, true);
	assert.equal(tallyVotes([vote({ abstained: true }), vote({ abstained: true })], 0.5).sound, false);

	// An empty panel is never sound, whatever the threshold claims.
	assert.equal(tallyVotes([], 0).sound, false);
	assert.throws(() => tallyVotes([vote()], 1.5), QualityError);
});

test("voters get distinct lenses, then round-robin", () => {
	assert.deepEqual(lensesFor(1), ["evidence"]);
	assert.deepEqual(lensesFor(3), ["evidence", "file_list", "test_plan"]);
	assert.equal(lensesFor(QUALITY_LENSES.length + 1).at(-1), "evidence");
	assert.throws(() => lensesFor(0), QualityError);
});

test("fixes name the lens that raised them, and nothing that passed", () => {
	const fixes = fixesFrom({
		schema_version: SCHEMA_VERSION,
		job_id: "cp-a",
		ran_at: "2026-08-27T10:00:00Z",
		passed: false,
		verify: {
			sound: false,
			sound_count: 1,
			total: 3,
			ratio: 1 / 3,
			threshold: 0.5,
			votes: [
				vote({ lens: "evidence", sound: true, reasons: ["quotes check out"] }),
				vote({ lens: "file_list", sound: false, reasons: ["no paths at all"] }),
				vote({ lens: "test_plan", sound: false, reasons: ["no paths at all", "invents a command"] }),
			],
		},
		completeness: { complete: false, missing: ["the migration half of the task"], model: "mock/voter" },
	});
	assert.deepEqual(fixes, [
		"[file_list] no paths at all",
		"[test_plan] no paths at all",
		"[test_plan] invents a command",
		"[completeness] the migration half of the task",
	]);
	assert.ok(!fixes.some((fix) => fix.includes("quotes check out")), "a sound vote is not a fix");
});

test("the pass is off until a job asks for it", () => {
	assert.equal(isEnabled(QUALITY_OFF), false);
	assert.equal(isEnabled(resolveQualityConfig(undefined, undefined)), false);
	assert.equal(isEnabled(resolveQualityConfig({ verify: true })), true);
	// Later layers win: the job's opt-in overrides the home default.
	const config: QualityConfig = resolveQualityConfig({ verify: true, voters: 3 }, { verify: false, completeness: true });
	assert.deepEqual(config, { verify: false, completeness: true, voters: 3 });
	assert.equal(DEFAULT_QUALITY_THRESHOLD, 0.5);
});

test("the fix message says what to fix and nothing about the body", () => {
	const report: QualityReport = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-a",
		ran_at: "2026-08-27T10:00:00Z",
		passed: false,
		verify: { sound: false, sound_count: 0, total: 2, ratio: 0, threshold: 0.5, votes: [] },
		completeness: { complete: false, missing: ["the rollback path"], model: "mock/voter" },
		fixes: ["[completeness] the rollback path"],
	};
	const message = qualityFixMessage(report);
	assert.match(message, /0\/2 sound/);
	assert.match(message, /the rollback path/);
	assert.match(message, /update the artifact in place/i);
	assert.match(formatQuality(report), /not ready/);
});

test("the lens briefs render and use only allowed placeholders", () => {
	const profile = loadProfile(PROFILES_DIR, "gate-reviewer");
	const verify = assembleBrief({
		profile,
		template: readBriefTemplate(BRIEFS_DIR, "quality-verify"),
		templatePath: "quality-verify",
		values: { job_id: "cp-a", task: "do the thing", artifact_path: "/tmp/artifact.md", lens: "file_list" },
	});
	assert.ok(verify.includes("file_list") && verify.includes("/tmp/artifact.md") && !verify.includes("${"));
	// s64: the report_verdict bounds live in GateReviewSchema, so a voter that
	// only reads this brief overruns them and pays an extra turn on the reject.
	// The eval corpus pins the same two lines on the gate and diff rubrics; this
	// is the third report_verdict surface, and it has no eval surface of its own.
	assert.match(verify, /each item ≤ 400 characters \(about three lines\), max 10 items\./);
	assert.match(verify, /\*\*only when `verdict` is `revise`\*\*/);
	const completeness = assembleBrief({
		profile,
		template: readBriefTemplate(BRIEFS_DIR, "quality-completeness"),
		templatePath: "quality-completeness",
		values: { job_id: "cp-a", task: "do the thing", artifact_path: "/tmp/artifact.md" },
	});
	assert.ok(completeness.includes("do the thing") && !completeness.includes("${"));
});

// ---------------------------------------------------------------------------
// the pass, with scripted voters
// ---------------------------------------------------------------------------

interface Bench {
	home: string;
	artifacts: ArtifactStore;
	manager: WorkerManager;
	pass(model: string, options?: { voteTimeoutMs?: number; rubric?: RoutingConfig["rubric"]; deny?: RoutingConfig["deny_by_role"] }): QualityPass;
	script(name: string, steps: ScriptStep[]): string;
	seal(): void;
	sent: ReviewWakeup[];
	reviews: ReviewRuns;
	/** The subject job's dispatch record, with the routing it was dispatched on. */
	subjectRecord(jobId: string, routing?: JobRouting): Promise<void>;
}

async function bench(t: { after(fn: () => void | Promise<void>): void }): Promise<Bench> {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const artifacts = new ArtifactStore({ home: home.path });
	const fleet = new FleetStore({ home: home.path });
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const runs = new RunRegistry(home.path);
	const sent: ReviewWakeup[] = [];
	const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
	t.after(async () => {
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});
	return {
		home: home.path,
		artifacts,
		manager,
		async subjectRecord(jobId, routing) {
			await fleet.add({
				job_id: jobId,
				project: "demo",
				kind: "research",
				delivery: "pipeline",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "planner",
					role: "planner",
					model: "mock/planner",
					started_at: isoTimestamp(),
				},
				worktree: home.path,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				...(routing ? { routing } : {}),
			});
		},
		pass: (model, options = {}) =>
			new QualityPass({
				home: home.path,
				profilesDir: PROFILES_DIR,
				briefsDir: BRIEFS_DIR,
				artifacts,
				manager,
				fleet,
				// cp-cxt: one mechanism. A voter is a gate-reviewer, so one rubric row
				// pins the whole panel to the scripted model.
				routing: {
					...DEFAULT_ROUTING_CONFIG,
					rubric: options.rubric ?? [{ id: "voters", role: "gate-reviewer", model }],
					...(options.deny ? { deny_by_role: options.deny } : {}),
				},
				probe: MOCK_ONLY,
				reviews,
				voteTimeoutMs: options.voteTimeoutMs ?? 20_000,
			}),
		script: (name, steps) => provider.addScript(name, steps),
		seal: () => agentDir.writeModels(provider),
		sent,
		reviews,
	};
}

function verdictStep(jobId: string, verdict: "pass" | "revise", extra: Record<string, unknown> = {}): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [
			{
				name: "report_verdict",
				args: {
					job_id: jobId,
					verdict,
					flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
					reasons: ["checked"],
					...(verdict === "revise" ? { revisions: ["name the exact files"] } : {}),
					...extra,
				},
			},
		],
		usage: { prompt_tokens: 400, completion_tokens: 20 },
	};
}

test("a disabled pass costs nothing and writes nothing", { timeout: 60_000 }, async (t) => {
	const b = await bench(t);
	b.seal();
	writeFileSync(b.artifacts.path("cp-q-off"), "# Goal\nx\n");
	const pass = b.pass("mock/script-none");
	assert.equal(await pass.runAndWait({ jobId: "cp-q-off", task: "t", config: QUALITY_OFF }), undefined);
	assert.equal(await pass.runAndWait({ jobId: "cp-q-off", task: "t", config: {} }), undefined);
	assert.equal(existsSync(join(b.home, paths.qualityFile("cp-q-off"))), false);
});

test("an opted-in pass votes, checks completeness, and is written once", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-on";
	writeFileSync(b.artifacts.path(jobId), "# Goal\nbump x\n\n# File list\nsrc/app.ts\n");
	// Two voters and one completeness check share one scripted model, in order.
	const model = b.script("quality-ok", [
		verdictStep(jobId, "pass"),
		verdictStep(jobId, "revise"),
		verdictStep(jobId, "pass"),
	]);
	b.seal();

	const report = await b.pass(model).runAndWait({
		jobId,
		task: "Bump x to 2 in src/app.ts",
		config: { verify: true, completeness: true, voters: 2, threshold: 0.5 },
	});
	assert.ok(report);
	assert.equal(report.verify?.total, 2);
	assert.equal(report.verify?.sound_count, 1);
	assert.equal(report.verify?.sound, true, "1 of 2 clears a 0.5 threshold");
	assert.deepEqual(
		report.verify?.votes.map((cast) => cast.lens),
		["evidence", "file_list"],
	);
	assert.equal(report.completeness?.complete, true);
	assert.equal(report.passed, true);
	assert.deepEqual(report.fixes, ["[file_list] name the exact files"], "a dissenting vote is still a fix to offer");

	// Written once: a second run returns the same report without spending a model.
	const onDisk = JSON.parse(readFileSync(join(b.home, paths.qualityFile(jobId)), "utf8")) as QualityReport;
	assert.deepEqual(onDisk, report);
	const again = await b.pass(model).runAndWait({ jobId, task: "t", config: { verify: true, voters: 2 } });
	assert.deepEqual(again, report);

	// The panel never puts the artifact in the report.
	assert.ok(!JSON.stringify(report).includes("# Goal"));
});

test("a panel below the threshold fails the pass and names the fixes", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-fail";
	writeFileSync(b.artifacts.path(jobId), "# Goal\nvague\n");
	const model = b.script("quality-bad", [verdictStep(jobId, "revise"), verdictStep(jobId, "revise")]);
	b.seal();

	const report = await b.pass(model).runAndWait({
		jobId,
		task: "Do the thing",
		config: { verify: true, voters: 2, threshold: 0.5 },
	});
	assert.equal(report?.passed, false);
	assert.equal(report?.verify?.sound, false);
	assert.ok(report?.fixes?.every((fix) => fix.startsWith("[")));
	assert.match(qualityFixMessage(report as QualityReport), /0\/2 sound/);
});

test("a voter that never votes abstains, and abstention counts against the artifact", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-abstain";
	writeFileSync(b.artifacts.path(jobId), "# Goal\nx\n");
	const model = b.script("quality-silent", [{ kind: "text", text: "I would rather discuss it." }]);
	b.seal();

	const report = await b.pass(model).runAndWait({ jobId, task: "t", config: { verify: true, voters: 1, threshold: 0.5 } });
	assert.equal(report?.verify?.votes[0]?.abstained, true);
	assert.equal(report?.verify?.sound_count, 0);
	assert.equal(report?.passed, false);
	assert.match(String(report?.verify?.votes[0]?.note), /without reporting a verdict/);
});

test("no artifact is a refusal, not a silent pass", { timeout: 60_000 }, async (t) => {
	const b = await bench(t);
	b.seal();
	await assert.rejects(
		() => b.pass("mock/script-none").runAndWait({ jobId: "cp-q-missing", task: "t", config: { verify: true } }),
		/no artifact for cp-q-missing/,
	);
});

function writeArtifact(b: Bench, jobId: string): void {
	writeFileSync(b.artifacts.path(jobId), "# Goal\nbump x\n\n# File list\nsrc/app.ts\n");
}

test("the panel is one pending attempt in its own slot, and one wake-up", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-async";
	writeArtifact(b, jobId);
	const model = b.script("q-async", [verdictStep(jobId, "pass"), verdictStep(jobId, "pass")]);
	b.seal();
	const pass = b.pass(model);

	const started = await pass.start({ jobId, task: "t", config: { verify: true, voters: 2, threshold: 1 } });
	assert.ok(isQualityWait(started), JSON.stringify(started));
	assert.equal(started.attempt, 1);
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile(jobId, "quality", 1))));
	assert.equal(
		existsSync(join(b.home, paths.qualityRunDir(jobId, "verify-1"), PENDING_REVIEW_FILE)),
		false,
		"votes carry no pending file",
	);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	assert.ok(existsSync(join(b.home, paths.qualityFile(jobId))));
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.surface, "quality");
	assert.match(b.sent[0]?.content ?? "", /quality pass: passed/);
	// One pass per job: a second start returns the report, spawning nothing.
	const again = await pass.start({ jobId, task: "t", config: { verify: true } });
	assert.ok(again && !isQualityWait(again));
	assert.equal(again.passed, true);
});

test(
	"cp-reviewer-routing: a voter routes on the subject's axes, and a model override keeps them",
	{ timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const routed = "cp-q-routed";
		const overridden = "cp-q-override";
		writeArtifact(b, routed);
		writeArtifact(b, overridden);
		const narrow = b.script("q-narrow", [verdictStep(routed, "pass")]);
		const broad = b.script("q-broad", [verdictStep(overridden, "pass")]);
		b.seal();
		const rubric: RoutingConfig["rubric"] = [
			{ id: "voters-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
			{ id: "voters-default", role: "gate-reviewer", model: "mock/never", thinking: "low" },
		];
		const impact: JobRouting = {
			scope: "L",
			risk: "high",
			inferred: true,
			provenance: { scope: "inferred", risk: "assessed" },
		};
		await b.subjectRecord(routed, impact);
		await b.subjectRecord(overridden, impact);
		const spawns = captureSpawns(b.manager);

		// 1. Routing decides: the subject's L/high fires the narrow voter row, and
		//    its effort is what actually spawns.
		const report = await b
			.pass(narrow, { rubric })
			.runAndWait({ jobId: routed, task: "t", config: { verify: true, voters: 1, threshold: 0.5 } });
		assert.equal(report?.passed, true);
		assert.equal(report?.verify?.votes[0]?.model, narrow);
		assert.equal(spawns[0]?.request.model, narrow);
		assert.equal(spawns[0]?.request.thinking, "medium");
		assert.equal(argOf(spawns[0]?.args ?? [], "--thinking"), "medium");

		// 2. A configured voter model is an explicit override: it still wins, it
		//    still keeps the profile's effort (a model-only override always did), and
		//    the subject's high impact is still recorded rather than thrown away.
		const withOverride = await b
			.pass(narrow, { rubric })
			.runAndWait({ jobId: overridden, task: "t", config: { verify: true, voters: 1, threshold: 0.5, model: broad } });
		assert.equal(withOverride?.verify?.votes[0]?.model, broad);
		assert.equal(spawns[1]?.request.model, broad);
		assert.equal(
			spawns[1]?.request.thinking,
			loadProfile(PROFILES_DIR, "gate-reviewer").frontmatter.thinking,
			"a model-only override keeps the profile's effort",
		);

		const payload = readFileSync(join(b.home, paths.qualityRunDir(overridden, "verify-1"), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.filter((event) => event.type === "routing_resolved");
		assert.equal(payload.length, 1, "one voter, one recorded decision");
		assert.equal(payload[0]?.payload?.surface, "quality/verify-1", "the slot is the panel's unit of work");
		assert.equal(
			payload[0]?.payload?.attempt,
			undefined,
			"the panel does not number attempts: an absent field, never a fabricated attempt=1",
		);
		assert.equal(payload[0]?.payload?.model, broad);
		assert.equal(payload[0]?.payload?.source, "override");
		// Requested and effective are separate fields, under the contract's names: the
		// override named a model and no effort, so exactly one of them is claimed.
		assert.equal(payload[0]?.payload?.requested, broad, "the model that was asked for");
		assert.equal(
			payload[0]?.payload?.thinking,
			loadProfile(PROFILES_DIR, "gate-reviewer").frontmatter.thinking,
			"the effort that actually spawned",
		);
		assert.ok(
			!("requested_thinking" in (payload[0]?.payload ?? {})),
			"a model-only override claims no effort was asked for",
		);
		assert.equal(payload[0]?.payload?.scope, "L", "the subject's impact survives the override");
		assert.equal(payload[0]?.payload?.risk, "high");
		assert.deepEqual(payload[0]?.payload?.provenance, { scope: "inherited", risk: "inherited" });
		assert.deepEqual(payload[0]?.payload?.subject_provenance, { scope: "inferred", risk: "assessed" });
	},
);

test(
	"pi-command-post-0a9: a voter spawns the fallback candidate and records the attempt",
	{ timeout: 180_000 },
	async (t) => {
		const b = await bench(t);
		const jobId = "cp-q-fallback";
		writeArtifact(b, jobId);
		const spare = b.script("q-spare", [verdictStep(jobId, "pass")]);
		b.seal();
		// `unauth/opus` is unreachable under MOCK_ONLY: the voter row's second
		// candidate is the one that can actually vote.
		const rubric: RoutingConfig["rubric"] = [
			{ id: "voters", role: "gate-reviewer", model: "unauth/opus", fallbacks: [spare], thinking: "low" },
		];
		await b.subjectRecord(jobId);
		const spawns = captureSpawns(b.manager);

		const report = await b
			.pass(spare, { rubric })
			.runAndWait({ jobId, task: "t", config: { verify: true, voters: 1, threshold: 0.5 } });

		assert.equal(report?.verify?.votes[0]?.model, spare);
		assert.equal(argOf(spawns[0]?.args ?? [], "--model"), spare);
		assert.equal(argOf(spawns[0]?.args ?? [], "--thinking"), "low");
		const payload = readFileSync(join(b.home, paths.qualityRunDir(jobId, "verify-1"), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.find((event) => event.type === "routing_resolved")?.payload;
		assert.deepEqual(payload?.attempted, [{ model: "unauth/opus", refusal: "availability" }]);
	},
);

test("cp-7re9: deny_by_role refuses a voter's config.model and its rubric candidates, with no override bypass and no spawn", { timeout: 60_000 }, async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-deny";
	writeArtifact(b, jobId);
	const denied = b.script("q-denied", [verdictStep(jobId, "pass")]);
	const spare = b.script("q-deny-spare", [verdictStep(jobId, "pass")]);
	b.seal();
	await b.subjectRecord(jobId);
	const spawns = captureSpawns(b.manager);
	const deny = { "gate-reviewer": [denied] };
	// A configured voter model is an explicit override: denied hard, never routed around to the spare row.
	await assert.rejects(
		() => b.pass(spare, { deny }).runAndWait({ jobId, task: "t", config: { verify: true, voters: 1, model: denied } }),
		/^Error: settings: model .* is not allowed for role gate-reviewer \(override;/,
	);
	// The voter rubric row's only candidate is denied the same way.
	await assert.rejects(
		() => b.pass(denied, { deny }).runAndWait({ jobId, task: "t", config: { verify: true, voters: 1 } }),
		/not allowed for role gate-reviewer/,
	);
	// A row with fallbacks skips the denied member as allowlist and votes on the next one.
	const rubric: RoutingConfig["rubric"] = [{ id: "voters", role: "gate-reviewer", model: denied, fallbacks: [spare] }];
	assert.equal(spawns.length, 0, "a denied voter never spawns");
	const report = await b.pass(spare, { rubric, deny }).runAndWait({ jobId, task: "t", config: { verify: true, voters: 1, threshold: 0.5 } });
	assert.equal(report?.verify?.votes[0]?.model, spare);
	assert.equal(argOf(spawns[0]?.args ?? [], "--model"), spare);
	const payload = readFileSync(join(b.home, paths.qualityRunDir(jobId, "verify-1"), "events.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
		.find((event) => event.type === "routing_resolved")?.payload;
	assert.deepEqual(payload?.attempted, [{ model: denied, refusal: "allowlist" }]);
});

test("an orphaned panel writes no report and asks for the panel to run again", async (t) => {
	const b = await bench(t);
	const jobId = "cp-q-orphan";
	writeArtifact(b, jobId);
	const wakeup = await b.pass("mock/none").orphan(
		{
			schema_version: SCHEMA_VERSION,
			job_id: jobId,
			surface: "quality",
			attempt: 1,
			model: "m",
			pid: 999_999,
			started_at: isoTimestamp(),
			deadline: isoTimestamp(),
			handed_back: true,
		},
		"reviewer lost with the parent session",
	);
	assert.ok(wakeup);
	assert.match(wakeup.content, /quality panel .* was lost .* run the panel again/);
	assert.equal(existsSync(join(b.home, paths.qualityFile(jobId))), false);
});
