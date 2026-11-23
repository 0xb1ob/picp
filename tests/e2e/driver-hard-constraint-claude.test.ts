/**
 * cp-qmry, the reported bug on the Claude CLI: with Settings → Workers CLI = claude (applied through the dashboard's
 * settings writer) the CLI binds every job. A fake `claude` shim on PATH answers `--version`, so the saturation case
 * never skips; the real `cp_dispatch` of a pi parent (mock model) decides. Nothing here may reach the pi model.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { nativeAvailabilityFile } from "../../src/native-availability.ts";
import { readSettings } from "../../src/settings.ts";
import { applySettings } from "../../src/settings-write.ts";
import { FAKE_NATIVE_MODEL } from "../harness/claude-mock-provider.ts";
import { FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { readFleet, readRunEvents, treehouseAvailable } from "../harness/index.ts";
import { seedOperatorPick } from "../harness/operator-pick.ts";

type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
const call = (id: string, args: Record<string, unknown> = {}) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", ...args } }] });

/** PATH without any real `claude`: the shim dir (if any), `tools` (links to every other tool of a dir holding claude), the rest. */
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

/** A home whose planner row names a Claude model with a pi fallback, then Workers CLI = claude through the settings writer. */
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
	const run = async (steps: Parameters<typeof b.run>[0], shimmed = true) => {
		await b.closeParents();
		return ((await b.run(steps, { PATH: pathWith(join(shim, "tools"), shimmed ? join(shim, "bin") : undefined) })) as Tool[]).filter((end) => end.toolName === "cp_dispatch");
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
