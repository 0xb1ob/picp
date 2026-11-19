/**
 * C3: usage and availability for Codex CLI research jobs through the real `cp_dispatch`, `cp_send`, `cp_revive` and
 * `cp_teardown` of a pi parent (mock parent model), with tests/fixtures/fake-codex.ts and the fake `systemd-run` at the
 * boundary. Every case checks the synthetic Codex home is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { codexAvailabilityFile, nativeAvailabilityFile, readCodexAvailability } from "../../src/native-availability.ts";
import { recordRecoveryAttempt } from "../../src/recovery.ts";
import { AUTH_SENTINEL, fakeScopes, fakeSpawns, fakeThreadTotal } from "../harness/codex-mock.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { startViewer } from "../harness/dashboard.ts";
import { readRunEvents, readRunStatus, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
type End = Awaited<ReturnType<H["run"]>>[number];
const text = (end: End | undefined) => JSON.stringify(end?.result.content ?? "");
const tool = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const ofType = (h: H, id: string, type: string) => readRunEvents(h.b.home, id).filter((event) => event.type === type);
const appServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server");
const failed = (h: H, id: string) => waitFor(() => h.record(id), (record) => record?.phase === "failed", { timeoutMs: 60_000, what: `${id} failed on its observed exit` });
const preview = (end: End | undefined) => (end?.result.details as { decision?: { driver?: string; requested_driver?: string; driver_reason?: string } } | undefined)?.decision;
const dry = (id: string) => tool("cp_dispatch", { job_id: id, task: "Report.", queue: false, when_ready: false, dry_run: true });
const threadTotal = (h: H, id: string) => fakeThreadTotal(h.state, h.session(id).thread_id as string).totalTokens;

/** The Codex home is untouched, and no host OPENAI_/CODEX_ key but CODEX_HOME reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of appServers(h)) {
		assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
	}
}

/** A codex research row that falls back to a pi model, the only rubric row. */
function codexRow(h: H, tag: string): string {
	const piModel = h.b.provider.addScript(`${tag}-pi-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
	const row = { id: "codex-research", role: "planner", model: FAKE_CODEX_REF, fallbacks: [piModel], driver: "codex" };
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_CODEX_REF], rubric: [row] }));
	return piModel;
}

test("CX-3a: completed, failed and interrupted codex turns each carry measured tokens at cost 0 with cost_unknown", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_max_concurrent: 3 } });
	const [done, broken, held] = await Promise.all([h.job(), h.job(), h.job()]);
	const message = { kind: "message" as const, text: "step" };
	const [artifact] = h.reporting(held.id);
	h.setScript({ turns: [h.reporting(done.id), [message, message, { kind: "fail", errorInfo: "serverOverloaded" }], [artifact!, message, { kind: "hold", marker: "held" }]] });
	// A pre-spent attempt keeps bounded recovery from reviving the failed job mid-assertion (the CX-1f pattern).
	recordRecoveryAttempt(h.b.home, broken.id, "crash");
	const quote = `Force teardown ${held.id} and discard its unreported result.`;
	await h.run([
		done.dispatch(), h.awaitEnvelope(done.id), h.waitEvent(done.id, "agent_settled", 1),
		broken.dispatch(), h.waitEvent(broken.id, "native_run", 1), h.pause(2),
		held.dispatch(), h.awaitFile(join(h.state, "held")),
		tool("cp_teardown", { job_id: held.id, force: true, operator_quote: quote }),
	], {}, `Run the checks. ${quote}`);
	const [a] = await h.runs(done.id);
	assert.deepEqual([a?.outcome, a?.turn_status, a?.usage], ["completed", "completed", "measured"], JSON.stringify(a));
	assert.equal(readRunStatus(h.b.home, done.id).usage.total_tokens, threadTotal(h, done.id));
	const record = await failed(h, broken.id);
	const [b] = await h.runs(broken.id);
	assert.deepEqual([b?.outcome, b?.turn_status, b?.error_info, b?.stop, b?.usage], ["failed", "failed", "serverOverloaded", undefined, "measured"], JSON.stringify(b));
	assert.equal(readRunStatus(h.b.home, broken.id).usage.total_tokens, 220);
	assert.equal(threadTotal(h, broken.id), 220);
	assert.notEqual(record?.failure?.class, "provider_limit", JSON.stringify(record?.failure));
	const [c] = await h.runs(held.id);
	assert.deepEqual([c?.outcome, c?.usage], ["interrupted", "measured"], JSON.stringify(c));
	const interrupted = readRunStatus(h.b.home, held.id).usage.total_tokens;
	assert.ok(interrupted > 0);
	assert.equal(interrupted, h.session(held.id).totals?.totalTokens);
	for (const id of [done.id, broken.id, held.id]) {
		const status = readRunStatus(h.b.home, id);
		assert.deepEqual([status.usage.cost_usd, status.cost_unknown], [0, true], id);
	}
	for (const scope of fakeScopes(h.state).filter((each) => each.started)) assert.ok(scope.unit, JSON.stringify(scope));
	assertClean(h);
});

test("CX-3b: a SIGKILLed turn's tokens are counted once, by the revived run on the same thread (KC4)", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const message = { kind: "message" as const, text: "step" };
	h.setScript({ turns: [[message, message, { kind: "hold", marker: "held" }], h.reporting(job.id)] });
	const killer = (async () => {
		await waitFor(() => existsSync(join(h.state, "held")) && h.record(job.id)?.worker.pid, Boolean, { timeoutMs: 90_000, what: "the held codex turn" });
		process.kill(h.record(job.id)?.worker.pid as number, "SIGKILL");
	})();
	await h.run([job.dispatch(), h.awaitFile(join(h.state, "held")), h.waitEvent(job.id, "envelope_received", 1), h.waitEvent(job.id, "agent_settled", 1)]);
	await killer;
	assert.equal(ofType(h, job.id, "worker_revived").length, 1);
	assert.equal(ofType(h, job.id, "envelope_received").length, 1);
	const status = readRunStatus(h.b.home, job.id);
	assert.equal(status.usage.total_tokens, threadTotal(h, job.id), JSON.stringify(status.usage));
	assert.equal(status.usage.cost_usd, 0);
	assertClean(h);
});

test("CX-3c: a run with no token update is usage_unavailable, never 0", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const job = await h.job();
	h.setScript({ knobs: { usage: false }, turns: [h.reporting(job.id)] });
	await h.run([job.dispatch(), h.awaitEnvelope(job.id), h.waitEvent(job.id, "agent_settled", 1)]);
	const [run] = await h.runs(job.id);
	assert.equal(run?.usage, "unavailable", JSON.stringify(run));
	const status = readRunStatus(h.b.home, job.id);
	assert.equal(status.usage_unavailable, true);
	assert.equal(status.usage.total_tokens, 0);
	assert.equal(ofType(h, job.id, "message_end").length, 0);
	assert.equal(h.session(job.id).totals?.totalTokens, 0);
	const viewer = await startViewer(t, { home: h.b.home });
	const page = (await viewer.get(`/api/job/${job.id}`)).body as { job?: { usage_unavailable?: boolean } };
	assert.equal(page.job?.usage_unavailable, true, JSON.stringify(page).slice(0, 400));
	assertClean(h);
});

test("CX-3d: a usage-limit turn fails as provider_limit, is not revived, and turns codex selections and resumes away until its reset", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const [spent, rowed, explicit, after] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	codexRow(h, "cx3d");
	const now = Math.floor(Date.now() / 1000);
	const [r0, r1, r2] = [now + 3_600, now + 5_400, now + 7_200];
	h.setScript({ turns: [[
		{ kind: "message", text: "step" },
		{ kind: "rateLimits", rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: r1 } } },
		{ kind: "rateLimits", rateLimits: { secondary: { usedPercent: 100, resetsAt: r2 } } },
		{ kind: "rateLimits", rateLimits: { limitId: "codex_other", primary: { usedPercent: 5, resetsAt: r0 } } },
		{ kind: "fail", errorInfo: "usageLimitExceeded", message: "You've hit your usage limit." },
	]] });
	await h.run([spent.dispatch(), h.waitEvent(spent.id, "native_run", 1), h.pause(2)]);
	const record = await failed(h, spent.id);
	assert.equal(record?.failure?.class, "provider_limit", JSON.stringify(record?.failure));
	assert.match(record?.failure?.message ?? "", /the Codex usage limit is reached \(resets \d{4}-/);
	assert.match(record?.failure?.message ?? "", /resumes the same thread/);
	const [run] = await h.runs(spent.id);
	assert.deepEqual([run?.stop, run?.resets_at, run?.usage, run?.error_info], ["window", r2 * 1000, "measured", "usageLimitExceeded"], JSON.stringify(run));
	assert.ok(!JSON.stringify(readRunEvents(h.b.home, spent.id)).includes("hit your usage limit"), "the CLI's message text is never recorded");
	const status = readRunStatus(h.b.home, spent.id);
	assert.deepEqual([status.usage.total_tokens, status.usage.cost_usd], [110, 0]);
	assert.equal(threadTotal(h, spent.id), 110);
	await waitFor(() => ofType(h, spent.id, "recovery_failed"), (found) => found.length > 0, { timeoutMs: 30_000, what: "bounded recovery's refusal" });
	assert.deepEqual(ofType(h, spent.id, "recovery_failed").map((event) => (event.payload as { stage?: string }).stage), ["native"]);
	assert.equal(ofType(h, spent.id, "worker_revived").length, 0);
	const snapshot = readCodexAvailability(h.b.home);
	assert.deepEqual([snapshot?.limit?.reached, snapshot?.limit?.resets_at], ["usageLimitExceeded", r2 * 1000], JSON.stringify(snapshot));
	assert.equal(existsSync(nativeAvailabilityFile(h.b.home)), false, "the Claude snapshot is untouched");
	// While the limit holds: a codex row falls back to pi, an explicit codex dispatch and a revive are refused by name.
	await h.b.closeParents();
	const spawned = appServers(h).length;
	const ends = await h.run([dry(rowed.id), explicit.dispatch(), tool("cp_revive", { job_id: spent.id, confirm: true })]);
	const [fellBack, refused] = ends.filter((end) => end.toolName === "cp_dispatch");
	assert.deepEqual([preview(fellBack)?.driver, preview(fellBack)?.requested_driver], ["pi", "codex"], text(fellBack));
	assert.match(preview(fellBack)?.driver_reason ?? "", /^window: usage limit reached until \d{4}-/);
	assert.equal(refused?.isError, true, text(refused));
	assert.match(text(refused), /cannot run on the Codex CLI driver: usage limit reached until/);
	assert.equal(existsSync(join(h.b.home, paths.runDir(explicit.id))), false, "no run for the refused dispatch");
	const revive = ends.find((end) => end.toolName === "cp_revive");
	assert.match(text(revive), /native_refused.*usage limit reached until/, text(revive));
	assert.equal(appServers(h).length, spawned, "no app-server for the refused revive");
	// Past its reset the limit is unknown: codex is attempted with a note.
	const file = codexAvailabilityFile(h.b.home);
	writeFileSync(file, JSON.stringify({ version: 1, limit: { ...snapshot?.limit, resets_at: Date.now() - 60_000 } }));
	await h.b.closeParents();
	const past = (await h.run([dry(after.id)])).find((end) => end.toolName === "cp_dispatch");
	assert.equal(preview(past)?.driver, "codex", text(past));
	assert.match(preview(past)?.driver_reason ?? "", /usage limit unknown since its reset/);
	assertClean(h);
});

test("CX-3d2: a reached limit on a turn that still completed blocks the next codex selection until the switch is rewritten", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t);
	const [reporter, blocked, cleared] = await Promise.all([h.job(), h.job(), h.job()]);
	codexRow(h, "cx3d2");
	h.setScript({ turns: [h.reporting(reporter.id, [{ kind: "rateLimits", rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: "rate_limit_reached" } }])] });
	const ends = await h.run([
		reporter.dispatch(), h.awaitEnvelope(reporter.id), h.waitEvent(reporter.id, "agent_settled", 1),
		tool("cp_teardown", { job_id: reporter.id }), dry(blocked.id),
	]);
	assert.notEqual(h.record(reporter.id)?.phase, "failed");
	const [run] = await h.runs(reporter.id);
	assert.equal(run?.stop, undefined, JSON.stringify(run));
	const observed = ofType(h, reporter.id, "native_observation").map((event) => (event.payload as { kind?: string }).kind);
	assert.deepEqual(observed, ["limit"]);
	const limit = readCodexAvailability(h.b.home)?.limit;
	assert.deepEqual([limit?.reached, limit?.resets_at], ["rate_limit_reached", undefined], JSON.stringify(limit));
	const fellBack = ends.filter((end) => end.toolName === "cp_dispatch").at(-1);
	assert.equal(preview(fellBack)?.driver, "pi", text(fellBack));
	assert.match(preview(fellBack)?.driver_reason ?? "", /^window: usage limit reached, reset unknown/);
	// The switch file rewritten after the observation (off then on) voids a no-reset limit.
	writeFileSync(h.nativeFile, readFileSync(h.nativeFile, "utf8"));
	await h.b.closeParents();
	const again = (await h.run([dry(cleared.id)])).find((end) => end.toolName === "cp_dispatch");
	assert.equal(preview(again)?.driver, "codex", text(again));
	assertClean(h);
});

test("CX-3e: codex turned off during a turn and on again: the idle resume counts that turn once (KC4)", { skip, timeout: 300_000 }, async (t) => {
	// Carry-in 1 (#854): totals were saved only while codex_research was on, so turn 1 ended with a stale record and the
	// resume counted its tokens again (1210 against a thread total of 770 on the C2 build).
	const h = await codexWorkerHome(t);
	const job = await h.job();
	const [artifact, report, message] = h.reporting(job.id);
	h.setScript({ turns: [[artifact!, { kind: "hold", marker: "held", forMs: 6_000 }, report!, message!], h.reporting(job.id)] });
	const ends = await h.run([
		job.dispatch(), h.awaitFile(join(h.state, "held")),
		tool("bash", { command: `echo '{"codex_research":false}' > "${h.nativeFile}"` }),
		h.waitEvent(job.id, "agent_settled", 1),
		tool("bash", { command: `echo '{"codex_research":true}' > "${h.nativeFile}"` }),
		tool("cp_send", { job_id: job.id, message: "Follow-up after the switch came back on." }),
		h.waitEvent(job.id, "envelope_received", 2), h.waitEvent(job.id, "agent_settled", 2),
	]);
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.equal(sent?.result.details?.mode, "prompt");
	assert.equal(ofType(h, job.id, "envelope_received").length, 2);
	const threadId = h.session(job.id).thread_id as string;
	const thread = fakeThreadTotal(h.state, threadId).totalTokens;
	assert.equal(readRunStatus(h.b.home, job.id).usage.total_tokens, thread, "the job's counted tokens equal the thread's own total");
	const ended = ofType(h, job.id, "message_end").map((event) => ((event.payload as { message?: { usage?: { totalTokens?: number } } }).message?.usage?.totalTokens ?? 0));
	assert.equal(ended.reduce((sum, each) => sum + each, 0), thread, `message_end totals ${JSON.stringify(ended)}`);
	assert.equal(h.session(job.id).totals?.totalTokens, thread, "the record holds the next baseline");
	assertClean(h);
});
