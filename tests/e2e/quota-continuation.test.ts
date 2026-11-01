/**
 * P3 PR2: durable quota-continuation intents through a real CommandPost, real pi workers on a treehouse pool and the
 * mock provider. The verified reset adapter is test-only and passed explicitly; production composition passes none.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import type { Delivery, JobKind } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { QUOTA_CONTINUE_NUDGE, type QuotaIntent } from "../../src/quota-continuation.ts";
import { PRODUCTION_QUOTA_RESET_ADAPTER } from "../../src/quota-reset-signal.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	type RecordedRequest,
	readRunEvents,
	REPO_ROOT,
	type ScriptStep,
	treehouse,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";
import { decodeMockQuotaReset, mockQuotaResetAdapter, quotaResetError } from "../harness/quota-reset-adapter.ts";

const SKIP = treehouseAvailable() ? false : "quota-continuation e2e needs treehouse on PATH";

interface JobSpec {
	slug: string;
	kind?: JobKind;
	delivery?: Delivery;
	labels?: string[];
	profile?: string;
}

interface Fleet {
	home: string;
	post: CommandPost;
	provider: MockProvider;
	job(spec: JobSpec): Promise<string>;
	script(name: string, steps: ScriptStep[]): string;
	dispatch(jobId: string, model: string, profile?: string): Promise<string>;
	events(jobId: string, type: string): Array<Record<string, unknown>>;
	/** Stop this parent and start a new owner on the same home, as a restart does. */
	restart(): Promise<CommandPost>;
}

async function fleet(t: { after(fn: () => void | Promise<void>): void }, options: { verified: boolean; maxTrees?: number }): Promise<Fleet> {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider, settings: { retry: { enabled: false } } });
	initJobsDocument(home.path, "cp");
	const start = () => new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		holdsParentLock: () => true,
		parentEnv: { ...process.env, ...agentDir.env },
		...(options.verified ? { quotaResetAdapter: mockQuotaResetAdapter(provider) } : {}),
	});
	let post = start();
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const clone = post.registry.pathOf("demo");
	const pool = enableTreehouse(clone, { maxTrees: options.maxTrees ?? 3 });
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
	const f: Fleet = {
		home: home.path,
		get post() {
			return post;
		},
		provider,
		async job(spec) {
			const { slug, kind = "ship", delivery = "local", labels } = spec;
			return (await post.ledger().create({ title: slug, project: "demo", delivery, kind, slug, ...(labels ? { labels } : {}) })).id;
		},
		script(name, steps) {
			const model = provider.addScript(name, steps, { onExhausted: "repeat" });
			agentDir.writeModels(provider);
			return model;
		},
		async dispatch(jobId, model, profile) {
			const dispatched = await post.dispatch({ jobId, task: `Brief for ${jobId}.`, model, fetch: false, wallClockSeconds: 600, toolCallCap: 100, ...(profile ? { profile } : {}) });
			return dispatched.worktree;
		},
		events(jobId, type) {
			return readRunEvents(home.path, jobId).filter((event) => event.source === "cp" && event.type === type).map((event) => (event.payload ?? {}) as Record<string, unknown>);
		},
		async restart() {
			await post.shutdown();
			post = start();
			await post.reconcile();
			return post;
		},
	};
	return f;
}

const HOURS_5 = 5 * 3_600_000;
/** A whole-second reset instant `ms` from now: the wire carries epoch seconds. */
const resetIn = (ms: number): Date => new Date(Math.floor((Date.now() + ms) / 1000) * 1000);
const failed = (f: Fleet, jobId: string) =>
	waitFor(() => f.post.fleet.require(jobId), (record) => record.phase === "failed", { timeoutMs: 60_000, what: `${jobId} failed` });
const claimEvents = (f: Fleet, jobId: string) => waitFor(() => f.events(jobId, "quota_continuation"), (rows) => rows.length > 0, { timeoutMs: 60_000, what: `${jobId} quota decision` });

/** The terminal assistant message pi ended the job's last turn on. */
function terminal(f: Fleet, jobId: string): Record<string, unknown> {
	const ends = readRunEvents(f.home, jobId).filter((event) => event.source === "pi" && event.type === "message_end");
	return ((ends.at(-1)?.payload ?? {}) as { message: Record<string, unknown> }).message;
}

function lastUserText(request: RecordedRequest): string {
	const users = (request.body.messages ?? []).filter((message) => message.role === "user");
	const content = users.at(-1)?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
}

test("ordinary ship creates pending intent", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const jobId = await f.job({ slug: "ordinary" });
	const resetsAt = resetIn(HOURS_5);
	await f.dispatch(jobId, f.script("ordinary", [quotaResetError(resetsAt), { kind: "hang" }]));
	const record = await failed(f, jobId);

	const intents = f.post.quota.intents(jobId);
	assert.equal(intents.length, 1, "exactly one durable intent");
	const [intent] = intents as [QuotaIntent];
	assert.deepEqual(
		[intent.state, intent.delivery, intent.generation, intent.continuation_id, intent.capability_version, intent.policy.source],
		["pending", "waiting", 1, `${jobId}:quota:1`, "mock-quota-reset/1", "home"],
	);
	assert.equal(intent.signal.resetsAtUtc, resetsAt.toISOString());
	assert.deepEqual([intent.worktree, intent.branch, intent.session_file], [record.worktree, record.branch, record.worker.session_file]);
	assert.equal(record.failure?.class, "model_call_failed");
	assert.match(record.failure?.message ?? "", new RegExp(`quota continuation ${intent.continuation_id} is pending`));
	assert.deepEqual(await f.post.quota.tick(), [], "a reset hours away is never due");
	assert.equal(f.provider.requests("ordinary").length, 1, "nothing is sent before the reset");
	assert.deepEqual(f.post.quota.intents(jobId), intents);
});

test("home opt-in excludes planner research ask deploy and nonordinary ship", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t, { verified: true, maxTrees: 8 });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const rows: JobSpec[] = [
		{ slug: "planner-on-ship", profile: "planner" },
		{ slug: "research", kind: "research" },
		{ slug: "ask", kind: "research", delivery: "answer" },
		{ slug: "deploy", kind: "research", labels: ["ops:deploy"] },
		{ slug: "qa-on-ship", profile: "qa" },
		{ slug: "comparator" },
	];
	const jobs: Array<{ spec: JobSpec; jobId: string }> = [];
	for (const spec of rows) {
		const jobId = await f.job(spec);
		await f.dispatch(jobId, f.script(spec.slug, [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]), spec.profile);
		jobs.push({ spec, jobId });
	}
	for (const { spec, jobId } of jobs) {
		await failed(f, jobId);
		const [decision] = await claimEvents(f, jobId);
		assert.ok(decodeMockQuotaReset(f.provider, terminal(f, jobId)), `${spec.slug}: the same verified signal arrived`);
		if (spec.slug === "comparator") {
			assert.deepEqual(f.post.quota.intents(jobId).map((intent) => intent.state), ["pending"], "the ordinary ship comparator");
			continue;
		}
		// Capability, metadata and home policy are all present: the eligibility answer is the only exclusion.
		assert.equal(decision?.state, "not_created", spec.slug);
		assert.match(String(decision?.reason), /^not eligible: /, spec.slug);
		assert.deepEqual(f.post.quota.intents(jobId), [], `${spec.slug} never receives an intent`);
	}
});

test("effective opt-out cancels pending only", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const byJob = await f.job({ slug: "job-opt-out" });
	const byHome = await f.job({ slug: "home-opt-out" });
	for (const [jobId, name] of [[byJob, "job-opt-out"], [byHome, "home-opt-out"]] as const) {
		await f.dispatch(jobId, f.script(name, [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	}
	await failed(f, byJob);
	await failed(f, byHome);
	await waitFor(() => f.post.quota.intents().length, (n) => n === 2, { timeoutMs: 10_000, what: "two pending intents" });
	const before = [f.post.fleet.require(byJob), f.post.fleet.require(byHome)];

	const jobCancel = f.post.quota.setPolicy({ jobId: byJob, enabled: false, actor: "operator" });
	assert.deepEqual(jobCancel.map((intent) => [intent.job_id, intent.state]), [[byJob, "cancelled"]], "the job override cancels only its own");
	assert.match(String(jobCancel[0]?.reason), /turned off \(job\) by operator/);
	assert.equal(f.post.quota.intents(byHome)[0]?.state, "pending");
	const homeCancel = f.post.quota.setPolicy({ enabled: false, actor: "operator" });
	assert.deepEqual(homeCancel.map((intent) => [intent.job_id, intent.state, intent.cancelled?.actor]), [[byHome, "cancelled", "operator"]]);
	assert.match(String(homeCancel[0]?.reason), /turned off \(home\)/);

	assert.deepEqual([f.post.fleet.require(byJob), f.post.fleet.require(byHome)], before, "job, session and counters untouched");
	for (const record of before) assert.ok(existsSync(record.worker.session_file), "the session file is kept");
	assert.deepEqual(f.post.quota.intents().map((intent) => intent.generation), [1, 1], "nothing deleted or renumbered");
});

test("opt-in never replays old failure", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	const jobId = await f.job({ slug: "replay" });
	const model = f.script("replay", [quotaResetError(resetIn(HOURS_5)), quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]);
	await f.dispatch(jobId, model);
	await failed(f, jobId);
	const [off] = await claimEvents(f, jobId);
	assert.deepEqual([off?.state, off?.reason], ["not_created", "quota continuation is off (default)"]);

	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	await f.post.quota.tick();
	const post = await f.restart();
	await post.quota.tick();
	assert.deepEqual(post.quota.intents(jobId), [], "opting in creates nothing for the earlier failure, across a restart");

	await post.revive(jobId, { continueFailed: true });
	await post.send({ jobId, message: "Continue." });
	const [later] = await waitFor(() => post.quota.intents(jobId), (rows) => rows.length === 1, { timeoutMs: 60_000, what: "the later interruption's intent" });
	assert.deepEqual([later?.state, later?.generation, later?.policy.source], ["pending", 1, "home"]);
});

test("home opt-in covers existing eligible jobs", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const covered = await f.job({ slug: "covered" });
	const optedOut = await f.job({ slug: "opted-out" });
	for (const [jobId, name] of [[covered, "covered"], [optedOut, "opted-out"]] as const) {
		await f.dispatch(jobId, f.script(name, [{ kind: "hang", until: gate }, quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
		await waitFor(() => f.provider.requests(name).length, (n) => n === 1, { timeoutMs: 30_000, what: `${name} first request` });
	}
	// Both jobs were dispatched while the home was off; the opt-in lands before either interruption.
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	f.post.quota.setPolicy({ jobId: optedOut, enabled: false, actor: "operator" });
	release();

	const [intent] = await waitFor(() => f.post.quota.intents(covered), (rows) => rows.length === 1, { timeoutMs: 60_000, what: "the covered job's intent" });
	assert.deepEqual([intent?.state, intent?.policy.source], ["pending", "home"]);
	const [decision] = await claimEvents(f, optedOut);
	assert.deepEqual([decision?.state, decision?.reason], ["not_created", "quota continuation is off (job)"]);
	assert.deepEqual(f.post.quota.intents(optedOut), []);
});

test("reconcile pending consumed cancelled", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t, { verified: true, maxTrees: 4 });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const pending = await f.job({ slug: "stays-pending" });
	const consumed = await f.job({ slug: "consumed" });
	const cancelled = await f.job({ slug: "cancelled" });
	await f.dispatch(pending, f.script("stays-pending", [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	await f.dispatch(cancelled, f.script("cancelled", [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	const soon = resetIn(4_000);
	let worktree = "";
	const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
	worktree = await f.dispatch(consumed, f.script("consumed", [
		quotaResetError(soon),
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo after > after.txt && git add -A && git -c user.email=w@w -c user.name=w commit -q -m after && git push -q -u origin HEAD" } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: consumed, kind: "ship", status: "done", summary: "Continued after the reset.", branch: consumed, head_sha: head() }) }] },
		{ kind: "text", text: "reported" },
	]));
	for (const jobId of [pending, consumed, cancelled]) await failed(f, jobId);
	await waitFor(() => f.post.quota.intents().length, (n) => n === 3, { timeoutMs: 10_000, what: "three pending intents" });
	const session = f.post.fleet.require(consumed).worker.session_file;

	const cancel = f.post.quota.cancel(cancelled, { actor: "operator", reason: "taking the job back" });
	assert.equal(cancel.ok, true, JSON.stringify(cancel));
	assert.deepEqual(await f.post.quota.tick(), [], "nothing is due before the reset");
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, soon.getTime() - Date.now() + 200)));
	const due = await f.post.quota.tick();
	assert.deepEqual(due.map((intent) => [intent.job_id, intent.state, intent.delivery, intent.consumed?.receipt]), [[consumed, "consumed", "sending", "delivered"]]);
	await waitFor(() => f.post.fleet.require(consumed).phase, (phase) => phase === "held", { timeoutMs: 60_000, what: "the continued job's envelope" });
	const continued = f.provider.requests("consumed");
	assert.equal(lastUserText(continued[1]!), QUOTA_CONTINUE_NUDGE, "the continuation is the short nudge, never the brief");
	assert.equal(f.post.fleet.require(consumed).worker.session_file, session, "the same session continued");

	const snapshot = f.post.quota.intents();
	const requests = () => ["stays-pending", "consumed", "cancelled"].map((name) => f.provider.requests(name).length);
	const sent = requests();
	const post = await f.restart();
	await post.quota.tick();
	assert.deepEqual(post.quota.intents(), snapshot, "a restart keeps ids, generations, receipts and counters");
	const states = Object.fromEntries(post.quota.intents().map((intent) => [intent.job_id, intent.state]));
	assert.deepEqual(states, { [pending]: "pending", [consumed]: "consumed", [cancelled]: "cancelled" });
	assert.deepEqual(requests(), sent, "consumed and cancelled never resend; pending is not due");
});

test("production capabilities cannot create intents", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t, { verified: false, maxTrees: 4 });
	const matrix: Array<{ name: string; home: boolean; job?: boolean }> = [
		{ name: "home-on", home: true },
		{ name: "home-on-job-on", home: true, job: true },
		{ name: "home-off-job-on", home: false, job: true },
		{ name: "home-off-job-off", home: false, job: false },
	];
	const jobs: string[] = [];
	for (const row of matrix) {
		const jobId = await f.job({ slug: row.name });
		f.post.quota.setPolicy({ enabled: row.home, actor: "operator" });
		if (row.job !== undefined) f.post.quota.setPolicy({ jobId, enabled: row.job, actor: "operator" });
		await f.dispatch(jobId, f.script(row.name, [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
		await failed(f, jobId);
		jobs.push(jobId);
	}
	for (const [i, jobId] of jobs.entries()) {
		const record = f.post.fleet.require(jobId);
		assert.match(record.failure?.message ?? "", /never ran a turn.*re-dispatch/, `${matrix[i]?.name}: the ordinary outcome`);
		assert.ok(decodeMockQuotaReset(f.provider, terminal(f, jobId)), "the reset-shaped error did arrive");
		assert.deepEqual(f.events(jobId, "quota_continuation"), [], "production decodes nothing, so nothing is even considered");
	}
	assert.deepEqual(f.post.quota.intents(), []);
	assert.equal(f.post.quota.capabilityVersion, "none");

	const message = terminal(f, jobs[0]!);
	assert.equal(PRODUCTION_QUOTA_RESET_ADAPTER.decode(message), undefined);
	assert.ok(Object.isFrozen(PRODUCTION_QUOTA_RESET_ADAPTER), "the production adapter cannot be widened at runtime");
	const fake = mockQuotaResetAdapter(f.provider);
	for (const provider of ["anthropic", "openai", "openai-codex"]) {
		assert.equal(fake.decode({ ...message, provider }), undefined, `even the test resolver refuses ${provider}`);
	}
});

/** Every `.ts`/`.tsx` file below `dir`, skipping dependencies. */
function sources(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules") return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

// Structural, not e2e (security-boundary exception): production composition never passes the fake adapter, so a
// dormant import edge to the test harness changes no observable behaviour an entry point could assert. Only reading
// the import graph fails on the edge itself, before any code path starts using it.
test("no production file imports the test-only quota-reset decoder or the mock-provider capability", () => {
	const production = ["src", "extensions", "bin"].flatMap((dir) => sources(join(REPO_ROOT, dir)));
	assert.ok(production.length > 100, "the production tree was found");
	const tests = resolve(REPO_ROOT, "tests");
	const edges: string[] = [];
	const mentions: string[] = [];
	for (const file of production) {
		const text = readFileSync(file, "utf8");
		const rel = relative(REPO_ROOT, file);
		for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
			const target = resolve(dirname(file), match[1] as string);
			if (match[1]?.startsWith(".") && (target === tests || target.startsWith(`${tests}/`))) edges.push(`${rel} -> ${relative(REPO_ROOT, target)}`);
		}
		for (const name of ["quota-reset-adapter", "mockQuotaResetAdapter", "decodeMockQuotaReset", "mock-quota-reset"]) {
			if (text.includes(name)) mentions.push(`${rel} names ${name}`);
		}
		if (rel !== "src/command-post.ts" && text.includes("quotaResetAdapter")) mentions.push(`${rel} composes a quota-reset adapter`);
	}
	assert.deepEqual(edges, [], "production imports from tests/ (tests/harness/quota-reset-adapter.ts, tests/harness/mock-provider.ts)");
	assert.deepEqual(mentions, [], "only e2e composition may reach the fake verified adapter");
});
