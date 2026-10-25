/** Behavior 11, P9e: worker envelopes as the real parent's intake, settle watcher and a real worker's reporter see them. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION, type EnvelopeCorrection, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { readStatusFile } from "../../src/run-artifacts.ts";
import { REPORT_NUDGE_TEXT } from "../../src/settle.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, readFleet, readRunEvents, startRpc, waitFor } from "../harness/index.ts";
import { SKIP, startStack } from "./landing-helpers.ts";

const PR = "https://github.com/demo/demo/pull/42";

/** Files `extra` over a valid ship envelope into the job's write-once slot; returns the bytes written. */
function file(home: string, id: string, extra: object = {}): string {
	mkdirSync(join(home, paths.runDir(id)), { recursive: true });
	const body = JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: id, kind: "ship", status: "done", summary: "shipped it", branch: id, head_sha: "0".repeat(40), pr_url: PR, ...extra } });
	writeFileSync(join(home, paths.envelopeFile(id)), body);
	return body;
}

// P9e-correction: a missing-artifact envelope is quarantined (never deleted) once per generation, a restart neither
// re-refuses nor refunds it, the corrected report is that generation's one delivery, and the next refusal fails closed.
test("P9e-correction: a refused envelope is quarantined once per generation and its one corrected report is the delivery", { timeout: 150_000 }, async (t) => {
	const home = createScratchHome();
	const agent = createAgentDir();
	t.after(() => { agent.cleanup(); home.cleanup(); });
	const store = new FleetStore({ home: home.path });
	const session = join(home.path, "s.jsonl");
	writeFileSync(session, "");
	const add = (id: string, extra: Partial<FleetRecord> = {}) => store.add({ job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "waiting", branch: id, worktree: join(home.path, "wt"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: 2147483600, session_id: "s", session_file: session, profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() }, ...extra } as FleetRecord);
	const missing = (name: string) => ({ artifact_path: join(home.path, "docs", name) });
	const at = (id: string, ...name: [number, number?]) => join(home.path, paths.invalidEnvelopeFile(id, ...name));
	const job = (id: string) => readFleet(home.path).jobs.find((j) => j.job_id === id)!;
	const events = (id: string, type: string) => readRunEvents(home.path, id).filter((event) => event.type === type);
	const start = async () => {
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
		t.after(() => rpc.close().then(() => undefined));
		rpc.send({ type: "get_state", id: "ready" });
		await rpc.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
		return rpc;
	};
	const wakes = async (rpc: Awaited<ReturnType<typeof start>>) => {
		rpc.send({ type: "get_messages", id: "wakes" });
		const reply = await rpc.waitFor((r) => r.type === "response" && r.id === "wakes");
		return (reply.data as { messages: Array<{ customType?: string }> }).messages.filter((message) => message.customType === "cp-envelope").length;
	};
	const notice = (rpc: Awaited<ReturnType<typeof start>>, pattern: RegExp) => rpc.waitFor((r) => pattern.test(JSON.stringify(r)), 30_000);

	await add("cp-uad");
	await add("cp-twice");
	const stale: EnvelopeCorrection = { generation: 1, at: isoTimestamp(new Date(0)), quarantined: paths.invalidEnvelopeFile("cp-stale", 1), reason: "the previous generation's refusal" };
	await add("cp-stale", { supersessions: 1, envelope_correction: stale });
	await add("cp-crash");
	const filed = file(home.path, "cp-uad", missing("evals.md"));
	file(home.path, "cp-twice", missing("evals.md"));
	file(home.path, "cp-stale", missing("evals.md"));
	writeFileSync(at("cp-stale", 1), "generation 1's refused record\n");
	const crashFiled = file(home.path, "cp-crash", missing("still-nowhere.md"));
	writeFileSync(at("cp-crash", 1), "the interrupted refusal's record\n");

	const first = await start();
	await waitFor(() => ["cp-uad", "cp-twice", "cp-stale", "cp-crash"].map(job), (jobs) => jobs.every((j) => j.envelope_correction), { what: "four quarantines" });
	const correction = job("cp-uad").envelope_correction!;
	assert.deepEqual([correction.generation, correction.quarantined], [1, paths.invalidEnvelopeFile("cp-uad", 1)]);
	assert.match(correction.reason, /docs\/evals\.md/, "the reason names the cause, not a category");
	assert.equal(readFileSync(at("cp-uad", 1), "utf8"), filed, "nothing is deleted and nothing is rewritten");
	assert.equal(existsSync(join(home.path, paths.envelopeFile("cp-uad"))), false, "the write-once slot is free again");
	assert.deepEqual([job("cp-uad").phase, job("cp-uad").reported_at, job("cp-uad").receipts, job("cp-uad").failure], ["waiting", undefined, undefined, undefined]);
	assert.equal(events("cp-uad", "envelope_rejected").length, 1);
	await notice(first, /cp-uad: envelope refused and quarantined at [^ ]*envelope-invalid-1\.json — [^"]*docs\/evals\.md[^"]*nothing was deleted/);
	assert.deepEqual([job("cp-stale").envelope_correction?.generation, job("cp-stale").envelope_correction?.quarantined, job("cp-stale").failure],
		[2, paths.invalidEnvelopeFile("cp-stale", 2), undefined], "a stale correction never spends the live generation's");
	assert.equal(readFileSync(at("cp-stale", 1), "utf8"), "generation 1's refused record\n", "the earlier quarantine is untouched");
	assert.deepEqual([job("cp-crash").envelope_correction?.generation, job("cp-crash").envelope_correction?.quarantined], [1, paths.invalidEnvelopeFile("cp-crash", 1, 2)]);
	assert.equal(readFileSync(at("cp-crash", 1), "utf8"), "the interrupted refusal's record\n", "a quarantine left by a crash is preserved");
	assert.equal(readFileSync(at("cp-crash", 1, 2), "utf8"), crashFiled, "the retry keeps its own bytes under a fresh name");
	assert.equal((events("cp-crash", "envelope_rejected")[0]?.payload as { quarantined?: string }).quarantined, paths.invalidEnvelopeFile("cp-crash", 1, 2));
	await notice(first, /cp-crash: envelope refused and quarantined at [^ ]*envelope-invalid-1-2\.json/);
	assert.equal(await wakes(first), 0, "nobody is woken with a delivery that was refused");
	first.endInput(); await first.close();

	const corrections = ["cp-uad", "cp-twice", "cp-stale", "cp-crash"].map((id) => job(id).envelope_correction);
	const second = await start();
	await notice(second, /cp-uad revivable/);
	assert.deepEqual(["cp-uad", "cp-twice", "cp-stale", "cp-crash"].map((id) => job(id).envelope_correction), corrections, "a restart never refunds a correction");
	assert.deepEqual(["cp-uad", "cp-twice", "cp-stale", "cp-crash"].map((id) => events(id, "envelope_rejected").length), [1, 1, 1, 1], "a quarantine is not re-refused");
	assert.equal(job("cp-uad").phase, "waiting");
	second.endInput(); await second.close();

	file(home.path, "cp-uad");
	file(home.path, "cp-twice", missing("still-nowhere.md"));
	file(home.path, "cp-stale", missing("evals.md"));
	file(home.path, "cp-crash", missing("nor-here.md"));
	const third = await start();
	await waitFor(() => ["cp-uad", "cp-twice", "cp-stale", "cp-crash"].map(job), ([uad, ...rest]) => uad!.reported_at !== undefined && rest.every((j) => j.phase === "failed"), { what: "delivery and three closed slots" });
	const uad = job("cp-uad");
	assert.deepEqual([uad.phase, uad.supersessions, uad.receipts?.some((r) => r.kind === "pr")], ["held", undefined, true]);
	assert.deepEqual(events("cp-uad", "envelope_received").map((event) => (event.payload as { generation: number }).generation), [1], "the corrected report is generation 1's delivery");
	assert.ok(existsSync(at("cp-uad", 1)), "the refused record survives the delivery that replaced it");
	assert.equal(await wakes(third), 1, "woken once, by the accepted delivery");
	const twice = job("cp-twice");
	assert.equal(twice.failure?.class, "envelope_invalid");
	assert.match(twice.failure?.message ?? "", /already spent its one correction/);
	assert.match(twice.failure?.message ?? "", /docs\/still-nowhere\.md/, "the failure names this refusal's cause");
	assert.deepEqual([existsSync(at("cp-twice", 1)), existsSync(join(home.path, paths.envelopeFile("cp-twice"))), existsSync(at("cp-twice", 2))], [true, true, false],
		"both records kept, no second quarantine, no new generation");
	assert.match(job("cp-stale").failure?.message ?? "", /generation 2 already spent its one correction/);
	assert.match(job("cp-crash").failure?.message ?? "", /already spent its one correction[^]*envelope-invalid-1-2\.json/);
	assert.deepEqual(readdirSync(join(home.path, paths.runDir("cp-crash"))).filter((name) => name.startsWith("envelope-invalid-")).sort(),
		["envelope-invalid-1-2.json", "envelope-invalid-1.json"], "two refusals, two records, and no third");
	third.endInput(); await third.close();

	const fourth = await start();
	await notice(fourth, /cp-uad/);
	assert.equal(job("cp-uad").reported_at, uad.reported_at, "reported_at is never restamped");
	assert.equal(events("cp-uad", "envelope_received").length, 1);
	fourth.endInput(); await fourth.close();
});

/** HEAD of the job's worktree, read when the mock model builds its report. */
function head(worktree: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
}

// P9e-reporter: the worker's own reporter refuses a ship report naming a missing artifact before anything is filed,
// naming the path, so the worker repairs it while its context is warm.
test("P9e-reporter: a worker's report naming a missing artifact is refused at the worker and files nothing", { skip: SKIP, timeout: 150_000 }, async (t) => {
	const s = await startStack(t);
	const job = await s.post.ledger().create({ title: "P9e missing artifact", project: "demo", kind: "ship", delivery: "pr" });
	const slot = join(s.home, paths.envelopeFile(job.id));
	const evals = join(s.home, "docs", "evals.md");
	let filedBeforeRepair: boolean | undefined;
	const script = `p9e-reporter-${job.id}`;
	const model = s.provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: job.id, kind: "ship", status: "done", summary: "Shipped.", branch: job.id,
			head_sha: head(s.post.fleet.require(job.id).worktree), pr_url: PR, artifact_path: evals }) }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => {
			filedBeforeRepair = existsSync(slot);
			return { job_id: job.id, kind: "ship", status: "done", summary: "Shipped.", branch: job.id, head_sha: head(s.post.fleet.require(job.id).worktree), pr_url: PR };
		} }] },
		{ kind: "hang" },
	]);
	s.agentDir.writeModels(s.provider);
	assert.equal((await s.post.dispatch({ jobId: job.id, task: "Report the delivery.", model, fetch: false })).receipt, "accepted");
	await waitFor(() => s.post.fleet.get(job.id)?.reported_at, (stamp) => stamp !== undefined, { timeoutMs: 60_000, what: "the repaired report" });
	const refusal = JSON.stringify(s.provider.requests(script)[1]?.body.messages);
	assert.ok(refusal.includes(`artifact_path: \\"${evals}\\" does not exist`), "the worker is told which artifact is missing");
	assert.equal(filedBeforeRepair, false, "a refused report files nothing");
	assert.equal(s.post.fleet.require(job.id).envelope_correction, undefined, "the parent never had to spend a correction");
});

// P9e-settle (cp-rud): an accepted envelope stamps reported_at, status.json and the settle counter in one write; a
// settle with an envelope on disk is never nudged, even when the fleet write fails; a second, different report_result
// is refused as already filed.
test("P9e-settle: the settle watcher stamps an envelope on disk atomically, never nudges it, and refuses a second report", { skip: SKIP, timeout: 200_000 }, async (t) => {
	const s = await startStack(t);
	const state = join(s.home, LAYOUT.state);
	const events = (id: string, type: string) => readRunEvents(s.home, id).filter((event) => event.type === type);

	const late = await s.post.ledger().create({ title: "P9e settle late", project: "demo", kind: "ship", delivery: "pr" });
	const lateScript = `p9e-late-${late.id}`;
	const lateModel = s.provider.addScript(lateScript, [
		{ kind: "text", text: "Done." },
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => (file(s.home, late.id), { command: "true" }) }] },
		{ kind: "text", text: "Reported." },
		{ kind: "hang" },
	]);
	s.agentDir.writeModels(s.provider);
	await s.post.dispatch({ jobId: late.id, task: "Do the work.", model: lateModel, fetch: false });
	await waitFor(() => s.post.fleet.get(late.id)?.reported_at, (stamp) => stamp !== undefined, { timeoutMs: 60_000, what: "the late envelope's stamp" });
	const nudged = s.provider.requests(lateScript)[1]?.body.messages as Array<{ role: string; content: unknown }>;
	assert.match(JSON.stringify(nudged.at(-1)?.content), new RegExp(REPORT_NUDGE_TEXT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const stamped = s.post.fleet.require(late.id);
	assert.deepEqual([stamped.phase, stamped.unreported_settles, readStatusFile(s.home, late.id)?.reported], ["held", undefined, true],
		"reported_at, the cleared settle counter and status.json land together");
	assert.equal(events(late.id, "envelope_received").length, 1, "the racing settle and stream intakes journal one delivery");
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	assert.equal(s.provider.requests(lateScript).length, 3, "the settle after the envelope is not nudged again");

	const twice = await s.post.ledger().create({ title: "P9e settle twice", project: "demo", kind: "ship", delivery: "pr" });
	const report = (summary: string) => ({ name: "report_result", args: () => ({ job_id: twice.id, kind: "ship", status: "done", summary, branch: twice.id,
		head_sha: head(s.post.fleet.require(twice.id).worktree), pr_url: PR }) });
	const twiceModel = s.provider.addScript(`p9e-twice-${twice.id}`, [{ kind: "tool_calls", calls: [report("first report"), report("a different summary")] }, { kind: "hang" }]);
	s.agentDir.writeModels(s.provider);
	await s.post.dispatch({ jobId: twice.id, task: "Report twice.", model: twiceModel, fetch: false });
	const envelopeFile = join(s.home, paths.envelopeFile(twice.id));
	await waitFor(() => readFileSync(join(s.home, paths.eventsFile(twice.id)), "utf8"), (log) => log.includes("already filed"), { timeoutMs: 60_000, what: "the duplicate refusal" });
	const log = readFileSync(join(s.home, paths.eventsFile(twice.id)), "utf8");
	assert.ok(log.includes(`your report was already filed and is on disk at ${envelopeFile}`) && log.includes("You are done"), "the refusal names the record and says the worker is done");
	assert.equal(JSON.parse(readFileSync(envelopeFile, "utf8")).envelope.summary, "first report");
	await waitFor(() => s.post.fleet.get(twice.id)?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "the first report's stamp" });
	assert.equal(events(twice.id, "report_nudged").length, 0, "a reported worker is never nudged");

	const broken = await s.post.ledger().create({ title: "P9e settle broken fleet", project: "demo", kind: "ship", delivery: "pr" });
	const brokenScript = `p9e-broken-${broken.id}`;
	const brokenModel = s.provider.addScript(brokenScript, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => (file(s.home, broken.id), chmodSync(state, 0o555), { command: "true" }) }] },
		{ kind: "text", text: "Done." },
		{ kind: "hang" },
	]);
	s.agentDir.writeModels(s.provider);
	await s.post.dispatch({ jobId: broken.id, task: "Do the work.", model: brokenModel, fetch: false });
	const recorded = await waitFor(() => events(broken.id, "settled_without_report"), (rows) => rows.length > 0, { timeoutMs: 60_000, what: "the recorded settle" })
		.finally(() => chmodSync(state, 0o755));
	assert.match(String((recorded[0]?.payload as { reason?: unknown }).reason), /envelope\.json exists but intake could not stamp the receipt: EACCES.*do not nudge/);
	assert.equal(s.provider.requests(brokenScript).length, 2, "an envelope on disk is never nudged, whatever the fleet write did");
	const unstamped = s.post.fleet.require(broken.id);
	assert.deepEqual([unstamped.reported_at, unstamped.phase], [undefined, "waiting"], "a failed write stamps nothing");
	assert.equal(events(broken.id, "envelope_received").length, 0, "and journals no delivery");
	assert.notEqual(readStatusFile(s.home, broken.id)?.reported, true, "and status.json never claims one");
});
