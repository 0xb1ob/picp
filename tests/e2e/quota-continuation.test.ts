/**
 * P3 PR2: durable quota-continuation intents through a real CommandPost, real pi workers on a treehouse pool and the
 * mock provider. The verified reset adapter is test-only and passed explicitly; production composition passes none.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_BUDGET_CONFIG, type Delivery, isoTimestamp, type JobKind, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { QUOTA_CONTINUE_NUDGE, type QuotaIntent, quotaContinuationErrorsFile, quotaContinuationFile } from "../../src/quota-continuation.ts";
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
	/** Stop this parent and start a new owner on the same home, as a restart does; `between` runs while none is up. */
	restart(between?: () => Promise<void>): Promise<CommandPost>;
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
		async restart(between) {
			await post.shutdown();
			await between?.();
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
	// No manual tick: the due timer armed by the claim is the production entry point that sends the continuation.
	const [done] = await waitFor(() => f.post.quota.intents(consumed), (rows) => rows[0]?.state === "consumed", { timeoutMs: 60_000, what: "the due timer's send" });
	assert.deepEqual([done?.state, done?.delivery, done?.consumed?.receipt, done?.attempts], ["consumed", "sending", "delivered", 1]);
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

test("corrupt quota store never stops startup reconcile", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t, { verified: true, maxTrees: 4 });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const research: string[] = [];
	for (const name of ["research-a", "research-b"]) {
		const jobId = await f.job({ slug: name, kind: "research" });
		await f.dispatch(jobId, f.script(name, [{ kind: "hang" }]));
		await waitFor(() => f.provider.requests(name).length, (n) => n === 1, { timeoutMs: 30_000, what: `${name} first request` });
		research.push(jobId);
	}
	const store = quotaContinuationFile(f.home);
	const journal = () => (existsSync(quotaContinuationErrorsFile(f.home)) ? readFileSync(quotaContinuationErrorsFile(f.home), "utf8") : "")
		.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>);
	const variants = [["corrupt", "{ not json", /is unreadable/], ["unknown schema", JSON.stringify({ schema_version: 2, intents: [] }), /unknown quota-continuation schema/]] as const;
	for (const [i, [why, bytes, named]] of variants.entries()) {
		const jobId = research[i]!;
		// While no parent is up: a done research job with an open ledger row (startup's ledger retry closes it) and a
		// junk park intent (park recovery refuses it in the run log) — proof both later reconcile steps still ran.
		const post = await f.restart(async () => {
			await f.post.fleet.mutate((jobs) => {
				const r = jobs.find((record) => record.job_id === jobId)!;
				Object.assign(r, { phase: "done", closed_reason: "gated", reported_at: isoTimestamp(), closed_at: isoTimestamp(new Date(Date.now() + 60_000)) });
			});
			mkdirSync(join(f.home, paths.runDir(jobId)), { recursive: true });
			writeFileSync(join(f.home, paths.envelopeFile(jobId)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1,
				envelope: { job_id: jobId, kind: "research", status: "done", summary: "findings" } }));
			mkdirSync(dirname(join(f.home, paths.parkIntentFile(jobId))), { recursive: true });
			writeFileSync(join(f.home, paths.parkIntentFile(jobId)), "{}");
			writeFileSync(store, bytes);
		});
		const rows = journal().filter((row) => row.during === "reconcile");
		assert.equal(rows.length, i + 1, `${why}: reconcile journaled the store failure once`);
		assert.equal(rows[i]?.error_name, "QuotaStoreError", why);
		assert.match(rows[i]?.error ?? "", named, why);
		assert.equal((await post.ledger().show(jobId)).status, "closed", `${why}: retryLedgerCloses still ran`);
		assert.ok(f.events(jobId, "awaiting_merge_refused").some((e) => e.code === "intent_mismatch"), `${why}: awaitingMerge.recover still ran`);
		assert.deepEqual(post.quota.intents(), [], `${why}: an unreadable store reads as no intents`);
		assert.equal(readFileSync(store, "utf8"), bytes, `${why}: the store is left in place, never overwritten`);
	}

	// Disabled, not default: the home opt-in written before the corruption is not honoured, and nothing rewrites the file.
	const ship = await f.job({ slug: "after-corrupt" });
	await f.dispatch(ship, f.script("after-corrupt", [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	const record = await failed(f, ship);
	assert.match(record.failure?.message ?? "", /never ran a turn.*re-dispatch/, "the ordinary outcome");
	assert.ok(decodeMockQuotaReset(f.provider, terminal(f, ship)), "the verified reset did arrive");
	const errors = await waitFor(() => f.events(ship, "quota_continuation"), (rows) => rows.some((row) => row.during === "claim"), { timeoutMs: 10_000, what: "the claim's store error" });
	assert.deepEqual([...new Set(errors.map((row) => row.error_name))], ["QuotaStoreError"]);
	assert.deepEqual(f.post.quota.intents(), []);
	assert.equal(readFileSync(store, "utf8"), variants[1][1], "dispatch and claim never overwrite the unreadable store");
	assert.throws(() => f.post.quota.setPolicy({ enabled: true, actor: "operator" }), { name: "QuotaStoreError" });
	assert.equal(readFileSync(store, "utf8"), variants[1][1], "a refused policy write leaves the file as found");
});

const FAR = "2099-01-01T00:00:00Z";
const nudges = (f: Fleet, name: string) => f.provider.requests(name).filter((request) => lastUserText(request) === QUOTA_CONTINUE_NUDGE).length;
const settled = (f: Fleet, jobIds: string[]) => waitFor(() => jobIds.map((jobId) => f.post.quota.intents(jobId)[0]),
	(rows) => rows.every((intent) => intent && intent.state !== "pending"), { timeoutMs: 60_000, what: "every due intent decided" });

test("pending intent frees its slot keeps its lease and spends no bounded recovery", { skip: SKIP, timeout: 240_000 }, async (t) => {
	const f = await fleet(t, { verified: true, maxTrees: 4 });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	writeFileSync(join(f.home, LAYOUT.budgetsFile), JSON.stringify({ ...DEFAULT_BUDGET_CONFIG, spawn_cap: 1 }));
	const held = await f.job({ slug: "held" });
	const soon = resetIn(8_000);
	const worktree = await f.dispatch(held, f.script("held", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "printf 'dirty bytes' > dirty.txt" } }] },
		quotaResetError(soon),
		{ kind: "text", text: "continued" },
	]));
	const record = await failed(f, held);
	assert.deepEqual(f.post.quota.intents(held).map((row) => row.state), ["pending"]);
	// Settle fails the job itself, so BoundedRecovery spends no attempt, escalates nothing and revives nothing.
	const recovery = ["recovery_attempted", "recovery_failed", "recovery_escalated", "worker_revived"].flatMap((type) => f.events(held, type));
	assert.deepEqual(recovery, []);
	assert.deepEqual(f.post.escalations.open().filter((item) => item.job_ids.includes(held)), []);

	// The one slot is free for another job while the lease, session and dirty bytes stay.
	const other = await f.job({ slug: "other" });
	await f.dispatch(other, f.script("other", [{ kind: "hang" }]));
	await waitFor(() => f.provider.requests("other").length, (n) => n === 1, { timeoutMs: 30_000, what: "the other job's first turn" });
	assert.equal(readFileSync(join(worktree, "dirty.txt"), "utf8"), "dirty bytes");
	assert.deepEqual([f.post.fleet.require(held).worktree, f.post.fleet.require(held).worker.session_file], [record.worktree, record.worker.session_file]);
	assert.ok(existsSync(record.worker.session_file));

	// Due while the slot is taken: the intent waits instead of crowding the cap, then continues once a slot frees.
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, soon.getTime() - Date.now() + 500)));
	assert.deepEqual(await f.post.quota.tick(), []);
	assert.deepEqual([f.post.quota.intents(held)[0]?.state, f.post.quota.intents(held)[0]?.delivery, nudges(f, "held")], ["pending", "waiting", 0]);
	assert.equal((await f.post.teardown.teardown(other, { force: true })).failure, undefined);
	const [done] = await f.post.quota.tick();
	assert.deepEqual([done?.job_id, done?.state, done?.consumed?.receipt], [held, "consumed", "delivered"]);
	await waitFor(() => f.provider.requests("held").length, (n) => n === 3, { timeoutMs: 30_000, what: "the continued turn" });
	assert.equal(nudges(f, "held"), 1);
	assert.equal(readFileSync(join(worktree, "dirty.txt"), "utf8"), "dirty bytes", "the continued session found its dirty work");
	assert.equal(f.post.fleet.require(held).worker.session_file, record.worker.session_file);
});

test("startup reconcile keeps a pending intent's dead worker failed not revivable", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const jobId = await f.job({ slug: "cut" });
	await f.dispatch(jobId, f.script("cut", [quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	await failed(f, jobId);
	const [intent] = f.post.quota.intents(jobId);
	// The parent died after the quota claim but before the failed write: the record still says waiting.
	const post = await f.restart(async () => {
		await f.post.fleet.mutate((jobs) => {
			const r = jobs.find((record) => record.job_id === jobId)!;
			r.phase = "waiting";
			delete r.failure;
		});
	});
	const record = post.fleet.require(jobId);
	assert.equal(record.phase, "failed", "never offered to cp_revive as an ordinary revivable");
	assert.match(record.failure?.message ?? "", new RegExp(`quota continuation ${intent?.continuation_id} is pending`));
	assert.deepEqual(post.quota.intents(jobId).map((row) => [row.state, row.delivery]), [["pending", "waiting"]], "the intent survives");
	assert.deepEqual(f.events(jobId, "worker_revived"), []);
});

test("due tick survives a store gone unreadable mid-pass", { skip: SKIP, timeout: 180_000 }, async (t) => {
	const f = await fleet(t, { verified: true });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const soon = resetIn(5_000);
	const jobs: string[] = [];
	for (const name of ["first", "second"]) {
		const jobId = await f.job({ slug: name });
		await f.dispatch(jobId, f.script(name, [quotaResetError(soon), { kind: "hang" }]));
		await failed(f, jobId);
		jobs.push(jobId);
	}
	// The due timer claims one intent and revives its worker; the store turns corrupt before the next read.
	const [claimed] = await waitFor(() => f.post.quota.intents().filter((row) => row.delivery === "claimed"), (rows) => rows.length === 1, { timeoutMs: 30_000, intervalMs: 5, what: "a claimed intent" });
	writeFileSync(quotaContinuationFile(f.home), "{ not json");
	for (const jobId of jobs) {
		await waitFor(() => f.events(jobId, "quota_continuation"), (rows) => rows.some((row) => row.during === "tick"), { timeoutMs: 30_000, what: `${jobId}'s own tick error` });
	}
	assert.ok(jobs.includes(claimed!.job_id));
	assert.deepEqual(await f.post.quota.tick(), [], "a later pass resolves on the unreadable store");
	assert.equal(readFileSync(quotaContinuationFile(f.home), "utf8"), "{ not json", "the store is left as found");
	assert.deepEqual(["first", "second"].map((name) => nudges(f, name)), [0, 0], "nothing was sent on an unreadable store");
});

test("closure revocation and manual replacement send nothing; restart and replay send once", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await fleet(t, { verified: true, maxTrees: 6 });
	f.post.quota.setPolicy({ enabled: true, actor: "operator" });
	const closed = await f.job({ slug: "closed" });
	const revoked = await f.job({ slug: "revoked" });
	const replaced = await f.job({ slug: "replaced" });
	const once = await f.job({ slug: "once" });
	const grant = f.post.mandates.issue({ projects: ["demo"], objective: `cover ${revoked}`, expiry: FAR, spend_cap: { usd: 100, tokens: 10_000_000 }, job_cap: 10, ask_on: [], job_ids: [revoked] });
	const soon = resetIn(10_000);
	for (const [jobId, name] of [[closed, "closed"], [revoked, "revoked"], [replaced, "replaced"]] as const) {
		await f.dispatch(jobId, f.script(name, [quotaResetError(soon), { kind: "hang" }]));
	}
	await f.dispatch(once, f.script("once", [quotaResetError(soon), quotaResetError(resetIn(HOURS_5)), { kind: "hang" }]));
	for (const jobId of [closed, revoked, replaced, once]) await failed(f, jobId);
	await waitFor(() => f.post.quota.intents().length, (n) => n === 4, { timeoutMs: 10_000, what: "four pending intents" });

	assert.equal((await f.post.teardown.teardown(closed, { force: true })).failure, undefined);
	f.post.mandates.revoke(grant.id);
	await f.post.revive(replaced, { continueFailed: true });
	// A restart before the reset: the new owner's startup timer is the only wake; replayed passes race it.
	const post = await f.restart();
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, soon.getTime() - Date.now())));
	await Promise.all([post.quota.tick(), post.quota.tick()]);
	const [c, r, m, o] = await settled(f, [closed, revoked, replaced, once]);
	assert.deepEqual([c?.state, c?.reason], ["cancelled", `${closed} is closed`]);
	assert.deepEqual(r?.state, "cancelled");
	assert.match(String(r?.reason), /^authority refused: /);
	assert.deepEqual([m?.state, m?.reason], ["cancelled", `${replaced} was continued by other means (phase waiting)`]);
	assert.deepEqual([o?.state, o?.consumed?.receipt, o?.attempts], ["consumed", "delivered", 1]);
	await waitFor(() => nudges(f, "once"), (n) => n === 1, { timeoutMs: 30_000, what: "the one continuation request" });
	assert.deepEqual(["closed", "revoked", "replaced"].map((name) => nudges(f, name)), [0, 0, 0], "nothing sent where a stop applied");

	// The continued turn hits a second limit: a new generation, the first stays consumed, and nothing resends.
	const second = await waitFor(() => post.quota.intents(once), (rows) => rows.length === 2, { timeoutMs: 60_000, what: "the second limit's intent" });
	assert.deepEqual(second.map((row) => [row.generation, row.state, row.delivery]), [[1, "consumed", "sending"], [2, "pending", "waiting"]]);
	assert.match((await failed(f, once)).failure?.message ?? "", new RegExp(`quota continuation ${once}:quota:2 is pending`));
	await post.quota.tick();
	assert.equal(nudges(f, "once"), 1);
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
