/**
 * cp-qmry, the reported bug on the Claude CLI: with Settings → Workers CLI = claude (applied through the dashboard's
 * settings writer) the CLI binds every job. A fake `claude` shim on PATH answers `--version`, so the saturation case
 * never skips; the real `cp_dispatch` of a pi parent (mock model) decides. Nothing here may reach the pi model.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { nativeAvailabilityFile } from "../../src/native-availability.ts";
import { readSettings } from "../../src/settings.ts";
import { applySettings } from "../../src/settings-write.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { VERDICT_TOOL } from "../../src/drivers/claude-verdict.ts";
import { type ClaudeStep, FAKE_NATIVE_MODEL } from "../harness/claude-mock-provider.ts";
import { FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { readFleet, readRunEvents, REPO_ROOT, routeDriver, treehouseAvailable, waitFor } from "../harness/index.ts";
import { nativeWorkerHome } from "../harness/native-worker.ts";
import { seedOperatorPick } from "../harness/operator-pick.ts";

type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
type Queued = { job_id: string; waiting_driver?: string };
const queuedEntry = (home: string, id: string): Queued | undefined =>
	(JSON.parse(readFileSync(join(home, LAYOUT.dispatchQueueFile), "utf8")) as { entries: Queued[] }).entries
		.find((entry) => entry.job_id === id);
const call = (id: string, args: Record<string, unknown> = {}) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", ...args } }] });

/** PATH without any real `claude`: the shim dir (if any), `tools` (links to a claude dir's other tools), the rest. */
function pathWith(tools: string, shim?: string): string {
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs.filter((each) => existsSync(join(each, "claude")))) {
		for (const name of readdirSync(dir)) {
			if (name === "claude") continue;
			try { symlinkSync(join(dir, name), join(tools, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
	}
	return [...(shim ? [shim] : []), tools, ...dirs.filter((dir) => !existsSync(join(dir, "claude")))].join(delimiter);
}

/** A home whose planner row names a Claude model with a pi fallback, then Workers CLI = claude (settings writer). */
async function claudeHome(t: TestContext) {
	const b = await dispatchS29(t);
	const script = `hard-claude-pi-${Math.random().toString(36).slice(2, 8)}`;
	const piModel = b.provider.addScript(script, [{ kind: "text", text: "idle" }], { onExhausted: "repeat" });
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*", FAKE_NATIVE_MODEL],
		rubric: [{ id: "research", role: "planner", model: FAKE_NATIVE_MODEL, fallbacks: [piModel] }] }));
	const applied = applySettings(b.home, { request: { mode: "set", changes: { "workers.driver": "claude" } }, expected_revision: readSettings(b.home, {}).revision,
		dry_run: false, request_id: "req-12345678", peer: null, actor: "dashboard", env: {} });
	assert.equal(applied.state, "applied", JSON.stringify(applied));
	const shim = mkdtempSync(join(tmpdir(), "cp-fake-claude-"));
	t.after(() => rmSync(shim, { recursive: true, force: true }));
	for (const dir of ["bin", "tools"]) mkdirSync(join(shim, dir));
	writeFileSync(join(shim, "bin", "claude"), "#!/bin/sh\necho '2.1.318 (Claude Code)'\n");
	chmodSync(join(shim, "bin", "claude"), 0o755);
	const job = async () => (await b.ledger.create({ title: `hard claude ${Math.random()}`, project: "demo", delivery: "local", kind: "research" })).id;
	const fleet = (id: string) => (existsSync(join(b.home, LAYOUT.fleetFile)) ? readFleet(b.home).jobs.find((record) => record.job_id === id) : undefined);
	const run = async (steps: Parameters<typeof b.run>[0], shimmed = true, tool = "cp_dispatch") => {
		await b.closeParents();
		return ((await b.run(steps, { PATH: pathWith(join(shim, "tools"), shimmed ? join(shim, "bin") : undefined) })) as Tool[]).filter((end) => end.toolName === tool);
	};
	const piUntouched = () => assert.equal(b.provider.requests(script).length, 0, "a job reached the pi model");
	return { b, piModel, job, fleet, run, piUntouched };
}

// The reported bug: the default claude home (max_concurrent 1) with one live claude job used to run the next row-routed
// job on pi. It must queue for the Claude CLI instead, with no fleet record and no pi turn.
test("claude saturation: with Workers CLI claude and max_concurrent 1 full, a second job queues waiting for Claude CLI capacity and never runs pi", { timeout: 300_000 }, async (t) => {
	const h = await claudeHome(t);
	const native = JSON.parse(readFileSync(join(h.b.home, LAYOUT.data, "native.json"), "utf8")) as Record<string, unknown>;
	assert.deepEqual([native.claude_research, native.max_concurrent ?? 1], [true, 1], JSON.stringify(native));
	const holder = await h.job();
	const now = isoTimestamp();
	await new FleetStore({ home: h.b.home }).add({
		job_id: holder, project: "demo", kind: "research", delivery: "local", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE, branch: holder,
		worker: { pid: process.pid, session_id: "native", session_file: join(h.b.home, "native.jsonl"), profile: "planner", role: "planner", model: FAKE_NATIVE_MODEL, started_at: now, driver: "claude" },
		worktree: join(h.b.home, "recycled", holder),
	});
	const second = await h.job();
	const [end] = await h.run([call(second)]);
	assert.notEqual(end?.isError, true, text(end));
	assert.equal(end?.result.details?.state, "queued", text(end));
	assert.equal(end?.result.details?.waiting, "waiting for Claude CLI capacity");
	assert.match(text(end), new RegExp(`${second} waiting for Claude CLI capacity`));
	assert.equal(h.fleet(second), undefined, "the queued job has no fleet record");
	assert.equal(existsSync(join(h.b.home, paths.runDir(second))), false, "the queued job has a run");
	assert.match(readFileSync(join(h.b.home, LAYOUT.dispatchQueueFile), "utf8"), new RegExp(second));
	assert.equal(queuedEntry(h.b.home, second)?.waiting_driver, "claude", "the entry records the CLI that parked it");
	h.piUntouched();
});

// T7 (R2): a pipeline whose planner row is on the full Claude CLI never starts that planner on pi: cp_pipeline start
// returns queued "waiting for Claude CLI capacity"; the research job waits in the dispatch queue (replay: T1).
test("T7: cp_pipeline start on a full Claude CLI queues its planner waiting for Claude CLI capacity, never pi", { timeout: 300_000 }, async (t) => {
	const h = await claudeHome(t);
	const holder = await h.job();
	const now = isoTimestamp();
	await new FleetStore({ home: h.b.home }).add({
		job_id: holder, project: "demo", kind: "research", delivery: "local", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE, branch: holder,
		worker: { pid: process.pid, session_id: "native", session_file: join(h.b.home, "native.jsonl"), profile: "planner", role: "planner", model: FAKE_NATIVE_MODEL, started_at: now, driver: "claude" },
		worktree: join(h.b.home, "recycled", holder),
	});
	const [end] = await h.run([{ kind: "tool_calls", calls: [{ name: "cp_pipeline", args: { action: "start", title: "t7 pipeline", task: "Add a line to README.md.", project: "demo" } }] }], true, "cp_pipeline");
	assert.notEqual(end?.isError, true, text(end));
	const details = end?.result.details as { state?: string; waiting?: string; research_id?: string; queued?: { position: number } } | undefined;
	assert.deepEqual([details?.state, details?.waiting, details?.queued?.position], ["queued", "waiting for Claude CLI capacity", 1], text(end));
	assert.match(text(end), /queued \(position 1\), waiting for Claude CLI capacity — the planner starts on that CLI when a slot frees, never on another/);
	const research = details?.research_id ?? "";
	assert.equal(h.fleet(research), undefined, "the planner has no fleet record");
	assert.match(readFileSync(join(h.b.home, LAYOUT.dispatchQueueFile), "utf8"), new RegExp(research));
	assert.equal(queuedEntry(h.b.home, research)?.waiting_driver, "claude", "the planner's entry records its CLI");
	h.piUntouched();
});

// Every refusal other than a full CLI names its reason and switches nothing: a missing CLI, a remembered sign-in
// failure, a spent usage window, and a model-only override the Claude CLI cannot run.
test("claude refusals: unavailable CLI, auth failure, spent window and a model-only switch each refuse by name and never run pi", { timeout: 300_000 }, async (t) => {
	const h = await claudeHome(t);
	const [missing, auth, window, model] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	const once = { queue: false, when_ready: false };
	const [noCli] = await h.run([call(missing, once)], false);
	const file = nativeAvailabilityFile(h.b.home);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ version: 1, windows: {}, auth: { code: "authentication_failed", observed_at: Date.now() + 60_000 }, seen: [] }));
	const [signedOut] = await h.run([call(auth, once)]);
	writeFileSync(file, JSON.stringify({ version: 1, windows: { five_hour: { status: "rejected", observed_at: Date.now(), resets_at: Date.now() + 3_600_000 } }, seen: [] }));
	const [spent] = await h.run([call(window, once)]);
	rmSync(file);
	const [modelOnly] = await h.run([call(model, { ...once, model: h.piModel })]);
	const cases = [
		[noCli, missing, /cannot run on the Claude CLI driver: .*claude/i],
		[signedOut, auth, /cannot run on the Claude CLI driver: authentication_failed at /],
		[spent, window, /cannot run on the Claude CLI driver: five_hour rejected until /],
		[modelOnly, model, /cannot run on the configured Claude CLI \(rule research\); a model change never changes the CLI/],
	] as const;
	for (const [end, id, reason] of cases) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), reason);
		assert.equal(h.fleet(id), undefined, `${id} ran on another CLI`);
		assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	}
	h.piUntouched();
});

const skip = treehouseAvailable() ? false : "needs treehouse on PATH (the overridden job takes a lease)";

// Only the human's own request switches a job: a dashboard message (dc- id) is recorded with that id on that one job;
// the same words from the parent (a cp-bridge send) or the main session's model are refused before any proof exists.
test("claude override: a dashboard-sourced driver pick runs only that job on pi, recorded with its dc- id; parent and main-session picks refuse", { skip, timeout: 300_000 }, async (t) => {
	const h = await claudeHome(t);
	const [picked, other] = await Promise.all([h.job(), h.job()]);
	const controlId = "dc-20261123082112-0a1b2c3d";
	const quote = seedOperatorPick(h.b.home, h.piModel, { jobId: picked, driver: "pi", author: { kind: "dashboard", controlId } });
	assert.throws(() => seedOperatorPick(h.b.home, h.piModel, { jobId: other, driver: "pi", author: { kind: "parent" } }), /operator_pick_parent_authored/);
	assert.throws(() => seedOperatorPick(h.b.home, h.piModel, { jobId: other, driver: "pi", author: { kind: "main-session" } }), /operator_pick_main_session_authored/);
	const [overridden, preview] = await h.run([
		call(picked, { driver: "pi", model: h.piModel, operator_quote: quote, queue: false, when_ready: false }),
		call(other, { dry_run: true }),
	]);
	assert.notEqual(overridden?.isError, true, text(overridden));
	const record = h.fleet(picked);
	assert.deepEqual([record?.worker.driver, record?.worker.model, record?.routing?.driver], [undefined, h.piModel, "pi"]);
	assert.match(record?.routing?.driver_reason ?? "", new RegExp(`^override: human dashboard ${controlId} proof omp-[a-f0-9]{32} asked for pi$`));
	const resolved = readRunEvents(h.b.home, picked).find((event) => event.type === "routing_resolved")?.payload as { driver_override?: Record<string, unknown> };
	assert.deepEqual([resolved.driver_override?.kind, resolved.driver_override?.control_id, resolved.driver_override?.quote], ["dashboard", controlId, quote.quote]);
	// The override is that job's alone: the next job on the same row still routes to the Claude CLI.
	const decision = (preview?.result.details as { decision?: { driver?: string } } | undefined)?.decision;
	assert.equal(decision?.driver, "claude", text(preview));
});

// P3, the other direction: an explicit claude on a pi row or a codex row is a parent's choice and refuses; the human's
// own v2 claude pick for that job allows it (previewed: the route resolves claude with the override recorded).
test("P3: an explicit claude on a pi or codex row refuses; the human's claude pick allows it", { timeout: 300_000 }, async (t) => {
	const h = await claudeHome(t);
	const file = join(h.b.home, LAYOUT.routingFile);
	const config = JSON.parse(readFileSync(file, "utf8")) as { allow: string[]; rubric: Array<Record<string, unknown>> };
	writeFileSync(file, JSON.stringify({ ...config, allow: [...config.allow, FAKE_CODEX_REF], rubric: [
		{ ...config.rubric.find((row) => row.id === "research"), scope: ["S"] },
		{ id: "codex-research", role: "planner", scope: ["M"], model: FAKE_CODEX_REF, driver: "codex" },
		{ id: "pi-research", role: "planner", scope: ["L"], model: h.piModel },
	] }));
	const [onPi, onCodex, pickedPi, pickedCodex] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	const claude = { driver: "claude", model: FAKE_NATIVE_MODEL, queue: false, when_ready: false };
	const pick = (id: string) => seedOperatorPick(h.b.home, FAKE_NATIVE_MODEL, { jobId: id, driver: "claude" });
	const ends = await h.run([
		call(onPi, { ...claude, scope: "L" }), call(onCodex, { ...claude, scope: "M" }),
		call(pickedPi, { ...claude, scope: "L", operator_quote: pick(pickedPi), dry_run: true }),
		call(pickedCodex, { ...claude, scope: "M", operator_quote: pick(pickedCodex), dry_run: true }),
	]);
	for (const [end, id, where] of [[ends[0], onPi, "pi \\(rule pi-research\\)"], [ends[1], onCodex, "the Codex CLI \\(rule codex-research\\)"]] as const) {
		assert.equal(end?.isError, true, text(end));
		assert.match(text(end), new RegExp(`configured to run on ${where}, and a parent's driver choice is not an override`));
		assert.equal(existsSync(join(h.b.home, paths.runDir(id))), false, `${id} has a run`);
	}
	for (const end of ends.slice(2)) {
		const decision = (end?.result.details as { decision?: { driver?: string; driver_reason?: string } } | undefined)?.decision;
		assert.equal(decision?.driver, "claude", text(end));
		assert.match(decision?.driver_reason ?? "", /^override: human terminal \S+ proof omp-[a-f0-9]{32} asked for claude; effort /);
	}
	h.piUntouched();
});

// T9-T11 (ruling ps-20261123080922): at the default claude max_concurrent 1, a held idle ship job X lends its slot to
// its own reviewer (routing line names it; a verdict lands, no deadlock). Meanwhile a cp_send to X queues (its reviewer
// uses the held author's slot) and an unrelated claude job queues with no borrow and no pi; after the verdict the send
// reaches X on claude and X reports again, while the unrelated job still waits.
test("T9/T10/T11: a held claude author lends its slot to its own reviewer; a send waits for the verdict, an unrelated job keeps waiting", { skip, timeout: 300_000 }, async (t) => {
	let id = "";
	const release = { file: "" };
	const blocked = () => ({ job_id: id, kind: "ship", status: "blocked", summary: "T9 change pushed.", blockers: ["the e2e case ends here"] });
	const verdict = () => ({ job_id: id, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed the packet"] });
	const calls = (...uses: Array<{ name: string; input: unknown }>): ClaudeStep => ({ kind: "tool_use", calls: uses as never });
	const h = await nativeWorkerHome(t, [
		calls({ name: "Write", input: () => ({ file_path: join(h.worktree(id), "src", "t9.ts"), content: "export const t9 = true;\n" }) }),
		calls({ name: "Bash", input: { command: "git add -A && git commit -q -m t9" } }),
		calls({ name: "mcp__picp__git_push", input: {} }),
		calls({ name: REPORT_TOOL, input: blocked }),
		{ kind: "text", text: "Reported." },
		// The reviewer holds its verdict until the parent has sent to X and dispatched the unrelated job.
		{ kind: "tool_use", calls: [{ name: VERDICT_TOOL, input: verdict }] as never, beforeAnswer: () => waitFor(() => existsSync(release.file), Boolean, { timeoutMs: 120_000, what: "the release marker" }).then(() => undefined) },
		{ kind: "text", text: "Reviewed." },
		calls({ name: REPORT_TOOL, input: blocked }),
		{ kind: "text", text: "Reported again." },
	]);
	release.file = join(h.fakeHome, "t9-release");
	writeFileSync(join(h.b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true, claude_ship: true, claude_review: true }));
	routeDriver(h.b.home, "claude", FAKE_NATIVE_MODEL, { roles: ["planner", "implementer", "gate-reviewer"] });
	const author = await h.job("ship", "pr");
	id = author.id;
	const other = await h.job("research");
	const events = join(h.b.home, paths.eventsFile(id));
	const waitEvents = (pattern: string, count: number) => ({ kind: "tool_calls" as const, calls: [{ name: "bash", args: {
		command: `for i in $(seq 600); do [ "$(grep -c '${pattern}' "${events}" 2>/dev/null)" -ge ${count} ] && break; sleep 0.2; done; sleep 1` } }] });
	const step = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
	const message = "T10 follow-up: report once more.";
	const ends = await h.run([
		author.dispatch("Add src/t9.ts, commit, push and report."), h.awaitEnvelope(id), waitEvents('"type":"native_run"', 1),
		step("cp_review", { job_id: id }), step("cp_send", { job_id: id, message }),
		step("cp_dispatch", { job_id: other.id, task: "Report what README.md says.", model: FAKE_NATIVE_MODEL, driver: "claude" }),
		step("bash", { command: `touch '${release.file}'` }),
		h.awaitEnvelope(id), waitEvents('"type":"envelope_received"', 2), waitEvents('"type":"native_run"', 2),
	]);
	const review = ends.find((end) => end.toolName === "cp_review");
	assert.notEqual(review?.isError, true, text(review));
	const reviewEvents = readFileSync(join(h.b.home, paths.reviewRunDir(id, 1), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
	const routed = reviewEvents.find((event) => event.type === "routing_resolved")?.payload;
	assert.match(String(routed?.line), new RegExp(`driver=claude slot="reviewer using held author's slot ${id}"`), JSON.stringify(routed));
	assert.match(String(routed?.driver_reason), new RegExp(`^borrowed: reviewer using held author's slot \\(${id}\\)`));
	await waitFor(() => existsSync(join(h.b.home, paths.reviewFile(id, 1))), Boolean, { timeoutMs: 60_000, what: "the verdict" });
	assert.equal((JSON.parse(readFileSync(join(h.b.home, paths.reviewFile(id, 1)), "utf8")) as { verdict: string }).verdict, "pass");
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.equal(sent?.result.details?.receipt, "queued", text(sent));
	assert.match(String(sent?.result.details?.waiting), /^waiting for Claude CLI capacity: its reviewer is using the held author's slot \(/);
	const unrelated = ends.find((end) => end.toolName === "cp_dispatch" && JSON.stringify(end.result.details ?? {}).includes(other.id));
	assert.deepEqual([unrelated?.result.details?.state, unrelated?.result.details?.waiting], ["queued", "waiting for Claude CLI capacity"], text(unrelated));
	// After the verdict: the send was delivered to X on claude (its second report), and the unrelated job still waits.
	const prompts = readRunEvents(h.b.home, id).filter((event) => event.type === "prompt_sent").map((event) => event.payload as { receipt?: string });
	assert.ok(prompts.some((each) => each.receipt === "delivered"), JSON.stringify(prompts));
	assert.equal(readRunEvents(h.b.home, id).filter((event) => event.type === "envelope_received").length, 2);
	assert.equal(h.record(id)?.worker.driver, "claude");
	assert.equal(h.record(other.id), undefined, "the unrelated job never borrowed and never ran on another CLI");
	assert.match(readFileSync(join(h.b.home, LAYOUT.dispatchQueueFile), "utf8"), new RegExp(other.id));
	assert.equal(h.claude.requests.some((request) => JSON.stringify(request.body).includes(message)), true, "the follow-up reached claude");
});

// Off CI a laptop without treehouse skips by name; under CI (Actions and Dagger set CI=true) a missing tool fails.
const ciSkip = process.env.CI === "true" ? false : skip;

/**
 * A pass-through `git` first on PATH that logs each fetch with its parent pid. `treehouse get` (however wrapped)
 * fetches on every lease from its own process; only a fetch this process spawns (picp's preflight) breaks fetch:false.
 */
function fetchLog(dir: string): { bin: string; fetches: () => Array<{ ownProcess: boolean; args: string }> } {
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const [bin, log] = [join(dir, "git-shim"), join(dir, "git-fetches.log")];
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) printf '%s\\t%s\\n' "$PPID" "$*" >> '${log}';; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
	const fetches = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
		const [parent = "", args = ""] = line.split("\t");
		return { ownProcess: parent === String(process.pid), args };
	}) : []);
	return { bin, fetches };
}

// Scenario (R2): a pipeline planner started with fetch:false on a full Claude CLI queues with fetch:false (contract)
// and, once the slot frees, starts on claude with no preflight `git fetch` (treehouse's lease still fetches).
test("R2-fetch: a pipeline planner queued with fetch:false on a full Claude CLI keeps fetch:false when it starts on claude", { skip: ciSkip, timeout: 300_000 }, async (t) => {
	const ids = { holder: "" };
	const research = (id: string) => ({ job_id: id, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(h.b.home, paths.artifactFile(id)),
		plan_summary: { goal: "Name the package.", approach: ["Read README.md."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] } });
	const h = await nativeWorkerHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids.holder)), content: "# native\n" }) }] } as ClaudeStep,
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => research(ids.holder) }] } as ClaudeStep,
		{ kind: "text", text: "Reported." },
		{ kind: "text", text: "Planning." },
	]);
	const git = fetchLog(h.fakeHome);
	// This process's PATH drives driver selection, preflight and treehouse; the workers keep the harness PATH.
	const saved = process.env.PATH;
	process.env.PATH = [git.bin, h.env.PATH].join(delimiter);
	t.after(() => { process.env.PATH = saved; });
	const post = h.b.ownPost(new CommandPost({ home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env } }));
	ids.holder = (await h.job("research")).id;
	await post.dispatch({ jobId: ids.holder, task: "Report the repo's package name.", model: FAKE_NATIVE_MODEL, driver: "claude", fetch: false });
	await waitFor(() => readRunEvents(h.b.home, ids.holder).some((event) => event.type === "agent_settled"), Boolean,
		{ timeoutMs: 120_000, what: "the holder's settled, reported turn" });
	const started = await post.startPipeline({ title: "r2f", project: "demo", task: "Add a line to README.md.", delivery: "local", fetch: false });
	const id = started.research_id;
	assert.deepEqual([started.dispatch, started.queued?.waiting], [undefined, "waiting for Claude CLI capacity"], JSON.stringify(started));
	const queue = () => (existsSync(join(h.b.home, LAYOUT.dispatchQueueFile))
		? (JSON.parse(readFileSync(join(h.b.home, LAYOUT.dispatchQueueFile), "utf8")) as { entries: Array<{ job_id: string; request: { fetch?: boolean } }> }).entries : []);
	assert.deepEqual(queue().map((entry) => [entry.job_id, entry.request.fetch]), [[id, false]]);
	const leased = git.fetches().length;
	const torn = await post.tearDown(ids.holder);
	assert.equal(torn.torn_down, true, JSON.stringify(torn));
	const record = await waitFor(() => h.record(id), (found) => found?.worker.driver === "claude", { timeoutMs: 120_000, what: "the planner on claude" });
	assert.deepEqual([record?.worker.role, record?.routing?.driver], ["planner", "claude"]);
	await waitFor(() => queue().length, (left) => left === 0, { timeoutMs: 30_000, what: "the started planner leaving the dispatch queue" });
	const replayed = git.fetches().slice(leased);
	assert.ok(replayed.some((fetch) => !fetch.ownProcess), `the shim saw the replay's lease fetch: ${JSON.stringify(replayed)}`);
	assert.deepEqual(replayed.filter((fetch) => fetch.ownProcess), [], "the replayed planner's preflight fetched origin");
});
