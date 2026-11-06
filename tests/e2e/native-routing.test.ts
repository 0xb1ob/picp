/**
 * Native routing S1: a rubric row's `driver` chooses the worker driver at dispatch, through the real `cp_dispatch` of a
 * pi parent (mock parent model). The installed `claude` runs against the loopback fake model with synthetic credentials
 * in a mode-0700 temp HOME; fake `claude` executables only stand in for the missing and too-old CLI cases.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, type DiffVerdict, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { VERDICT_TOOL } from "../../src/drivers/claude-verdict.ts";
import { nativeAvailabilityFile, readNativeAvailability, recordNativeObservation } from "../../src/native-availability.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import {
	type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, FAKE_CLAUDE_MODEL, FAKE_NATIVE_MODEL, routeNativeModel, startClaudeMockProvider, subscriberEnv, toolResults,
} from "../harness/claude-mock-provider.ts";
import { seedOperatorPick } from "../harness/operator-pick.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, readFleet, readRunEvents, REPO_ROOT, treehouseAvailable } from "../harness/index.ts";

const missing = [whichAll("claude", process.env)[0] === undefined && "claude", !treehouseAvailable() && "treehouse"].filter(Boolean);
const skip = missing.length > 0 ? `needs ${missing.join(" and ")} on PATH` : false;
type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
const tool = (name: string, args: unknown) => ({ kind: "tool_calls" as const, calls: [{ name, args }] });
const report = (jobId: string, home: string) => ({
	job_id: jobId, kind: "research", status: "done", summary: "Native research done.", artifact_path: join(home, paths.artifactFile(jobId)),
	plan_summary: { goal: "Name the package.", approach: ["Read README.md."], acceptance: ["The name is reported."], risk: "None.", touched: ["README.md"] },
});

/** A home whose S rows prefer claude (pi lane: the fake native model, then a mock pi model); L rows are plain pi. */
async function routedHome(t: TestContext, script: readonly ClaudeStep[], options: { subscriber?: boolean } = {}) {
	const b = await dispatchS29(t);
	const claude = await startClaudeMockProvider(script);
	const scratch = mkdtempSync(join(tmpdir(), "cp-s1-native-"));
	chmodSync(scratch, 0o700);
	t.after(async () => { await claude.close(); rmSync(scratch, { recursive: true, force: true }); });
	const fakeHome = join(scratch, "home");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	const settingsEnv = options.subscriber ? subscriberEnv(claude.url) : { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN };
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: settingsEnv }));
	const piModel = b.provider.addScript(`s1-pi-${Math.random().toString(36).slice(2, 8)}`, Array.from({ length: 12 }, () => ({ kind: "text" as const, text: "idle" })));
	const rows = (native: Record<string, unknown>) => [
		{ id: "native-research", role: "planner", scope: ["S"], model: FAKE_NATIVE_MODEL, fallbacks: [piModel], thinking: "high", ...native },
		{ id: "plain-research", role: "planner", scope: ["L"], model: piModel },
	];
	const routing = (native: Record<string, unknown> = { driver: "claude" }) =>
		JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", FAKE_NATIVE_MODEL], rubric: rows(native) });
	writeFileSync(join(b.home, LAYOUT.routingFile), routing());
	const switchFile = join(b.home, LAYOUT.data, "native.json");
	const toggle = (on: boolean) => writeFileSync(switchFile, JSON.stringify({ claude_research: on }));
	const job = (delivery: "local" | "answer" = "local") => b.ledger.create({ title: `s1 ${Math.random()}`, project: "demo", delivery, kind: "research" });
	const fleet = (id: string) => readFleet(b.home).jobs.find((record) => record.job_id === id);
	const noLease = (id: string) => assert.equal(existsSync(join(b.home, paths.runDir(id))), false, `${id} has a run`);
	return { b, claude, scratch, piModel, routing, toggle, job, fleet, noLease, env: { HOME: fakeHome, CLAUDE_CONFIG_DIR: join(fakeHome, ".claude") } };
}

const dispatch = (id: string, extra: Record<string, unknown> = {}) => ({ name: "cp_dispatch", args: { job_id: id, task: "Report the repo's package name.", scope: "S", queue: false, when_ready: false, ...extra } });

test("S1 native: a claude row runs native with its model and effort; peers, plain rows and overrides stay pi", { skip, timeout: 300_000 }, async (t) => {
	const ids: string[] = [];
	const h = await routedHome(t, [
		{ kind: "tool_use", calls: [{ name: "Write", input: () => ({ file_path: join(h.b.home, paths.artifactFile(ids[0]!)), content: "# native\n" }) }], beforeAnswer: () => sleep(8_000) },
		{ kind: "tool_use", calls: [{ name: REPORT_TOOL, input: () => report(ids[0]!, h.b.home) }] },
		{ kind: "text", text: "Reported." },
	]);
	h.toggle(true);
	const [a, b, peer, plain, override] = await Promise.all([h.job(), h.job("answer"), h.job(), h.job(), h.job()]);
	const ends = (await h.b.run([
		// Two admissions in one message: exactly one may take the native slot.
		{ kind: "tool_calls", calls: [dispatch(a.id), dispatch(b.id)] },
		{ kind: "tool_calls", calls: [dispatch(peer.id)] },
		{ kind: "tool_calls", calls: [dispatch(plain.id, { scope: "L" })] },
		{ kind: "tool_calls", calls: [dispatch(override.id, { model: h.piModel })] },
	], h.env)) as Tool[];
	const dispatches = ends.filter((end) => end.toolName === "cp_dispatch");
	for (const end of dispatches) assert.notEqual(end.isError, true, text(end));
	const native = [a, b].map((job) => h.fleet(job.id)!).filter((record) => record.worker.driver === "claude");
	assert.equal(native.length, 1, "exactly one concurrent dispatch ran native");
	const winner = native[0]!;
	ids.push(winner.job_id);
	const loser = h.fleet(winner.job_id === a.id ? b.id : a.id)!;
	// The native job: its record, routing record and cp_dispatch response name claude, the row's model and effort.
	assert.equal(winner.worker.model, FAKE_NATIVE_MODEL);
	assert.deepEqual([winner.routing?.requested_driver, winner.routing?.driver, winner.routing?.thinking], ["claude", "claude", "high"]);
	assert.match(winner.routing?.driver_reason ?? "", /^rule: native-research prefers claude; effort high$/);
	assert.match(dispatches.map(text).join("\n"), new RegExp(`model=${FAKE_NATIVE_MODEL}[^"]*thinking=high driver=claude`));
	const resolved = readRunEvents(h.b.home, winner.job_id).find((event) => event.type === "routing_resolved")?.payload as Record<string, unknown>;
	assert.deepEqual([resolved.driver, resolved.model], ["claude", FAKE_NATIVE_MODEL]);
	const first = h.claude.requests.find((request) => request.path.split("?")[0] === "/v1/messages" && Array.isArray(request.body.tools));
	assert.equal(first?.body.model, FAKE_CLAUDE_MODEL, "the CLI ran the row's model");
	assert.equal((first?.body.output_config as { effort?: string } | undefined)?.effort, "high", "the CLI ran the row's effort");
	// The concurrent loser and a later peer fall back to pi by name; a plain row and an override never ask for claude.
	for (const [record, held] of [[loser, /is being admitted$/], [h.fleet(peer.id)!, /is live; tear it down first$/]] as const) {
		assert.equal(record.worker.driver, undefined, `${record.job_id} ran native`);
		assert.equal(record.worker.model, h.piModel);
		assert.deepEqual([record.routing?.requested_driver, record.routing?.driver], ["claude", "pi"]);
		// The loser met the admission-time slot, not the winner's fleet record: the reservation itself is proven.
		assert.match(record.routing?.driver_reason ?? "", new RegExp(`^occupied: native concurrency is 1 and ${winner.job_id} ${held.source}`));
	}
	for (const id of [plain.id, override.id]) {
		const record = h.fleet(id)!;
		assert.deepEqual([record.worker.driver, record.worker.model, record.routing?.driver, record.routing?.requested_driver], [undefined, h.piModel, undefined, undefined]);
	}
});

test("S1 fallback: switch off, CLI missing or too old, and a pipeline-owned planner run pi with the reason named", { skip, timeout: 300_000 }, async (t) => {
	const h = await routedHome(t, []);
	const [off, absent, old, explicit, denied, deniedExplicit] = await Promise.all([h.job(), h.job(), h.job(), h.job(), h.job(), h.job()]);
	// Missing: PATH keeps every other tool from claude's directories, minus claude. Too old: a fake that prints 2.1.0.
	const shim = join(h.scratch, "no-claude");
	mkdirSync(shim, { mode: 0o700 });
	const claudeDirs = whichAll("claude", process.env).map((file) => dirname(file));
	for (const dir of claudeDirs) {
		for (const name of readdirSync(dir)) if (name !== "claude" && !existsSync(join(shim, name))) symlinkSync(join(dir, name), join(shim, name));
	}
	const kept = (process.env.PATH ?? "").split(delimiter).filter((dir) => !existsSync(join(dir, "claude")));
	const oldDir = join(h.scratch, "old-claude");
	mkdirSync(oldDir, { mode: 0o700 });
	writeFileSync(join(oldDir, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n", { mode: 0o755 });
	h.toggle(false);
	const offEnds = (await h.b.run([
		{ kind: "tool_calls", calls: [dispatch(off.id)] },
		{ kind: "tool_calls", calls: [dispatch(explicit.id, { driver: "claude", model: FAKE_NATIVE_MODEL })] },
	], h.env)) as Tool[];
	h.toggle(true);
	// One parent per home: each run below starts its own parent with its own PATH, after the last one closed.
	const runAlone = async (steps: Parameters<typeof h.b.run>[0], env: NodeJS.ProcessEnv) => { await h.b.closeParents(); return (await h.b.run(steps, env)) as Tool[]; };
	const absentEnds = await runAlone([{ kind: "tool_calls", calls: [dispatch(absent.id)] }], { ...h.env, PATH: [shim, ...kept].join(delimiter) });
	const oldEnds = await runAlone([{ kind: "tool_calls", calls: [dispatch(old.id)] }], { ...h.env, PATH: [oldDir, process.env.PATH].join(delimiter) });
	const pipelineEnds = await runAlone([tool("cp_pipeline", { action: "start", title: `s1 pipeline ${Math.random()}`, project: "demo", task: "Plan a README tweak.", delivery: "local", scope: "S" })], h.env);
	// A row with fallbacks skips pickModel's allowlist check; a primary denied for the role still never runs native.
	const denyRole = { ...JSON.parse(h.routing()) as object, deny_by_role: { planner: [FAKE_NATIVE_MODEL] } };
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify(denyRole));
	const deniedEnds = await runAlone([dispatch(denied.id), dispatch(deniedExplicit.id, { driver: "claude" })].map((call) => ({ kind: "tool_calls" as const, calls: [call] })), h.env);
	const fellBack = [[offEnds[0], off.id, /^switch: /], [absentEnds[0], absent.id, /^cli_missing: /], [oldEnds[0], old.id, /^cli_version: /],
		[deniedEnds[0], denied.id, /^denied: deny_by_role\.planner matches /]] as const;
	for (const [end, id, reason] of fellBack) {
		assert.notEqual(end?.isError, true, text(end));
		const record = h.fleet(id)!;
		assert.deepEqual([record.worker.driver, record.worker.model, record.routing?.driver], [undefined, h.piModel, "pi"]);
		assert.match(record.routing?.driver_reason ?? "", reason);
		assert.match(text(end), /driver=pi/);
	}
	// An explicit driver keeps today's strict refusal: no fallback, no lease.
	assert.equal(offEnds[1]?.isError, true, text(offEnds[1]));
	assert.match(text(offEnds[1]), /workers\.native_claude_research is off/);
	h.noLease(explicit.id);
	assert.equal(deniedEnds[1]?.isError, true, text(deniedEnds[1]));
	assert.match(text(deniedEnds[1]), /cannot run on the native claude driver: deny_by_role\.planner matches /);
	h.noLease(deniedExplicit.id);
	// D2: the pipeline's research child is planner research, yet stays on pi because the pipeline owns it.
	const research = (pipelineEnds[0]?.result.details as { research_id?: string } | undefined)?.research_id;
	assert.ok(research, text(pipelineEnds[0]));
	const child = h.fleet(research)!;
	assert.deepEqual([child.worker.driver, child.routing?.driver], [undefined, "pi"]);
	assert.match(child.routing?.driver_reason ?? "", /^pipeline: /);
	assert.equal(h.claude.requests.length, 0, "no fallback reached the native model");
});

test("S1 config: an unknown driver or a non-anthropic claude model refuses with no lease; a started job keeps its driver", { skip, timeout: 300_000 }, async (t) => {
	// N4e: an unreported clean turn now settles idle, so the locked job ends by its turn limit (CP_NATIVE_MAX_TURNS=1).
	const bash = { kind: "tool_use" as const, calls: [{ name: "Bash", input: { command: "ls" } }] };
	const h = await routedHome(t, [bash, bash]);
	const limited = { ...h.env, CP_NATIVE_MAX_TURNS: "1" };
	const routingFile = join(h.b.home, LAYOUT.routingFile);
	const [codex, badModel, minimal, locked] = await Promise.all([h.job(), h.job(), h.job(), h.job()]);
	h.toggle(true);
	const write = (json: string) => tool("bash", { command: `printf '%s' '${json}' > "${routingFile}"` });
	const ends = (await h.b.run([
		write(h.routing({ driver: "codex" })),
		{ kind: "tool_calls", calls: [dispatch(codex.id)] },
		write(h.routing({ driver: "claude", model: h.piModel })),
		{ kind: "tool_calls", calls: [dispatch(badModel.id)] },
		write(h.routing({ driver: "claude", thinking: "minimal" })),
		{ kind: "tool_calls", calls: [dispatch(minimal.id)] },
		write(h.routing()),
		{ kind: "tool_calls", calls: [dispatch(locked.id)] },
	], limited)) as Tool[];
	const [first, second, third, fourth] = ends.filter((end) => end.toolName === "cp_dispatch");
	assert.equal(first?.isError, true, text(first));
	assert.match(text(first), /violates the routing contract/);
	assert.equal(second?.isError, true, text(second));
	assert.match(text(second), /explicit anthropic\/claude-… model/);
	assert.equal(third?.isError, true, text(third));
	assert.match(text(third), /thinking=minimal has no native claude effort/);
	for (const id of [codex.id, badModel.id, minimal.id]) h.noLease(id);
	// D1: the native job fails on its observed exit and stays native. With the row no longer preferring claude, a
	// re-dispatch with the switch off refuses (never pi), and a revive after the switch is back respawns it native.
	assert.notEqual(fourth?.isError, true, text(fourth));
	const failed = await waitFailed(h.fleet, locked.id);
	assert.equal(failed?.worker.driver, "claude");
	h.toggle(false);
	await h.b.closeParents();
	writeFileSync(routingFile, h.routing({}));
	const again = (await h.b.run([
		{ kind: "tool_calls", calls: [dispatch(locked.id)] },
		tool("bash", { command: `echo '{"claude_research":true}' > "${join(h.b.home, LAYOUT.data, "native.json")}"` }),
		tool("cp_revive", { job_id: locked.id, confirm: true }),
	], limited)) as Tool[];
	const redispatch = again.find((end) => end.toolName === "cp_dispatch");
	assert.equal(redispatch?.isError, true, text(redispatch));
	assert.match(text(redispatch), /cannot run on the native claude driver/);
	const revive = again.find((end) => end.toolName === "cp_revive");
	assert.notEqual(revive?.isError, true, text(revive));
	const revived = h.fleet(locked.id);
	assert.deepEqual([revived?.worker.driver, revived?.worker.model], ["claude", FAKE_NATIVE_MODEL], "the job was rerouted off its driver");
	assert.equal(readRunEvents(h.b.home, locked.id).filter((event) => event.type === "worker_revived").length, 1, text(revive));
	// A native record whose model the CLI cannot run (hand-edited here) refuses revive at admission, before any spawn.
	await waitFailed(h.fleet, locked.id);
	await h.b.closeParents();
	const fleetFile = join(h.b.home, LAYOUT.fleetFile);
	const file = readFleet(h.b.home);
	for (const record of file.jobs) if (record.job_id === locked.id) record.worker.model = h.piModel;
	writeFileSync(fleetFile, JSON.stringify(file));
	const requests = h.claude.requests.length;
	const refused = ((await h.b.run([tool("cp_revive", { job_id: locked.id, confirm: true })], h.env)) as Tool[]).find((end) => end.toolName === "cp_revive");
	assert.match(text(refused), /native_refused.*explicit anthropic\/claude-… model.*Nothing was spawned/);
	assert.equal(readRunEvents(h.b.home, locked.id).filter((event) => event.type === "worker_revived").length, 1, "a second spawn ran");
	assert.equal(h.claude.requests.length, requests);
});

test("S1 carry: a native primary missing from a plain allowlist falls back with denied:, and an explicit driver refuses", { skip, timeout: 300_000 }, async (t) => {
	const h = await routedHome(t, []);
	h.toggle(true);
	const [fallback, explicit] = await Promise.all([h.job(), h.job()]);
	writeFileSync(join(h.b.home, LAYOUT.routingFile), JSON.stringify({ ...JSON.parse(h.routing()) as object, allow: ["mock/*"] }));
	const ends = (await h.b.run([dispatch(fallback.id), dispatch(explicit.id, { driver: "claude", model: FAKE_NATIVE_MODEL })].map((call) => ({ kind: "tool_calls" as const, calls: [call] })), h.env)) as Tool[];
	const [first, second] = ends.filter((end) => end.toolName === "cp_dispatch");
	assert.notEqual(first?.isError, true, text(first));
	const record = h.fleet(fallback.id)!;
	assert.deepEqual([record.worker.driver, record.worker.model, record.routing?.driver], [undefined, h.piModel, "pi"]);
	assert.match(record.routing?.driver_reason ?? "", new RegExp(`^denied: the allowlist refuses ${FAKE_NATIVE_MODEL}$`));
	assert.equal(second?.isError, true, text(second));
	assert.match(text(second), /allowlist/);
	h.noLease(explicit.id);
	assert.equal(h.claude.requests.length, 0);
});

test("S2 availability: spent, reset, no-reset and auth evidence steer new jobs; a started native job never moves", { skip, timeout: 600_000 }, async (t) => {
	const reset = Math.floor(Date.now() / 1000) + 3600;
	// N4e: an unreported clean turn settles idle for a nudge, so the jobs that must end unreported end by turn limit.
	const ls = { kind: "tool_use" as const, calls: [{ name: "Bash", input: { command: "ls" } }] };
	const h = await routedHome(t, [
		{ kind: "text", text: "Spent.", limit: { status: "rejected", claim: "five_hour", resetsAt: reset } },
		{ ...ls, limit: { status: "allowed", claim: "seven_day", resetsAt: reset } },
		{ kind: "text", text: "Spent again.", limit: { status: "rejected", claim: "five_hour", resetsAt: reset * 1000 } },
		{ kind: "auth_error" },
		ls,
	], { subscriber: true });
	h.env = { ...h.env, CP_NATIVE_MAX_TURNS: "1" } as typeof h.env;
	const file = nativeAvailabilityFile(h.b.home);
	const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	const runAlone = async (id: string, extra: Record<string, unknown> = {}) => { await h.b.closeParents(); return (await h.b.run([{ kind: "tool_calls", calls: [dispatch(id, extra)] }], h.env)) as Tool[]; };
	const reason = (id: string) => h.fleet(id)?.routing?.driver_reason ?? "";
	const ranNative = (id: string) => assert.deepEqual([h.fleet(id)?.worker.driver, h.fleet(id)?.worker.model], ["claude", FAKE_NATIVE_MODEL], reason(id));
	const ranPi = (id: string, pattern: RegExp) => {
		assert.deepEqual([h.fleet(id)?.worker.driver, h.fleet(id)?.worker.model], [undefined, h.piModel], reason(id));
		assert.match(reason(id), pattern);
	};
	const [spent, fallback, afterReset, invalidReset, noReset, signedOut, authFallback, signedIn] = await Promise.all([h.job(), h.job(), h.job(), h.job(), h.job(), h.job(), h.job(), h.job()]);
	h.toggle(true);
	// A corrupt snapshot is unknown, never spent: the first job runs native and its 429 writes a fresh snapshot.
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{not json");
	await runAlone(spent.id);
	ranNative(spent.id);
	assert.equal((await waitFailed(h.fleet, spent.id))?.phase, "failed");
	const window = readNativeAvailability(h.b.home)?.windows.five_hour;
	assert.deepEqual([window?.status, window?.resets_at], ["rejected", reset * 1000], "resetsAt is epoch seconds, kept as epoch ms");
	const requests = h.claude.requests.length;

	// A spent window sends the next new job to pi by name; the failed native job is never revived, re-dispatched or
	// rerouted onto pi (R1: an operator pick of a pi model), and bounded recovery refused it.
	await runAlone(fallback.id);
	ranPi(fallback.id, new RegExp(`^window: five_hour rejected until ${iso(reset * 1000)}$`));
	const quote = seedOperatorPick(h.b.home, h.piModel, { jobId: spent.id });
	await h.b.closeParents();
	const lock = (await h.b.run([
		tool("cp_revive", { job_id: spent.id, confirm: true }),
		{ kind: "tool_calls", calls: [dispatch(spent.id)] },
		{ kind: "tool_calls", calls: [dispatch(spent.id, { model: h.piModel, operator_quote: quote })] },
	], h.env)) as Tool[];
	const [revive, redispatch, reroute] = lock.filter((end) => end.toolName === "cp_revive" || end.toolName === "cp_dispatch");
	assert.match(text(revive), /native_refused.*subscription window is spent.*Nothing was spawned/);
	assert.equal(redispatch?.isError, true, text(redispatch));
	assert.match(text(redispatch), /cannot run on the native claude driver: five_hour rejected until/);
	assert.equal(reroute?.isError, true, text(reroute));
	assert.match(text(reroute), new RegExp(`runs an explicit anthropic/claude-… model, and ${h.piModel} is not one`));
	ranNative(spent.id);
	const events = readRunEvents(h.b.home, spent.id);
	assert.equal(events.filter((event) => event.type === "worker_revived").length, 0, "the spent native job was respawned");
	assert.equal((events.find((event) => event.type === "recovery_failed")?.payload as { stage?: string } | undefined)?.stage, "native");
	assert.equal(h.claude.requests.length, requests, "no claude request after the window was spent");

	// At the reset the window is unknown and native is attempted; a no-reset entry from another CLI version is void (iii).
	// A replayed uuid is ignored; the later allowed seven_day event replaces its rejected entry (i).
	const snapshot = readNativeAvailability(h.b.home)!;
	assert.ok(snapshot.seen.length > 0, "the rate-limit event's uuid was kept");
	snapshot.windows.five_hour = { ...window!, resets_at: Date.now() - 1000 };
	snapshot.windows.seven_day = { status: "rejected", observed_at: Date.now() - 1000, claude_version: "2.0.0" };
	writeFileSync(file, JSON.stringify(snapshot));
	const replay = { type: "native_observation", kind: "window", window: "seven_day", status: "allowed", uuid: snapshot.seen[0], observed_at: Date.now() };
	assert.equal(recordNativeObservation(h.b.home, replay), false);
	await runAlone(afterReset.id);
	ranNative(afterReset.id);
	assert.match(reason(afterReset.id), /; five_hour unknown since its reset /);
	await waitFailed(h.fleet, afterReset.id);
	assert.equal(readNativeAvailability(h.b.home)?.windows.seven_day?.status, "allowed");

	// A 429 whose reset has the wrong magnitude (milliseconds) is stored with no reset (F1), and stays blocked until the
	// switch goes off and on (ii).
	await runAlone(invalidReset.id);
	ranNative(invalidReset.id);
	await waitFailed(h.fleet, invalidReset.id);
	const noResetEntry = readNativeAvailability(h.b.home)?.windows.five_hour;
	assert.deepEqual([noResetEntry?.status, noResetEntry?.resets_at], ["rejected", undefined]);
	await runAlone(noReset.id);
	ranPi(noReset.id, /^window: five_hour rejected, reset unknown \(observed /);
	h.toggle(false);
	h.toggle(true);
	// An auth error sends the next new job to pi with auth:; switching off then on clears it.
	await runAlone(signedOut.id);
	ranNative(signedOut.id);
	await waitFailed(h.fleet, signedOut.id);
	assert.equal(readNativeAvailability(h.b.home)?.auth?.code, "authentication_failed");
	await runAlone(authFallback.id);
	ranPi(authFallback.id, /^auth: authentication_failed at /);
	h.claude.endAuthError();
	h.toggle(false);
	h.toggle(true);
	await runAlone(signedIn.id);
	ranNative(signedIn.id);
	await waitFailed(h.fleet, signedIn.id);
	assert.doesNotMatch(readFileSync(file, "utf8"), /fake: |invalid credentials|limit reached|Ran after/, "raw SDK text in the snapshot");
});

test("S3 carry: real opus and sonnet turns clear no-reset blocks by family; seven_day_overage_included clears on either", { skip, timeout: 600_000 }, async (t) => {
	// A millisecond-magnitude reset is stored as no reset (F1), so each 429 leaves a sticky block.
	const spent = (claim: string): ClaudeStep => ({ kind: "text", text: "Spent.", limit: { status: "rejected", claim, resetsAt: (Math.floor(Date.now() / 1000) + 3600) * 1000 } });
	// N4e: a clean unreported turn (the one that clears blocks) settles idle; its nudged resume ends by turn limit.
	const nudged: ClaudeStep = { kind: "tool_use", calls: [{ name: "Bash", input: { command: "ls" } }] };
	const h = await routedHome(t, [spent("seven_day_opus"), spent("seven_day_overage_included"), { kind: "text", text: "Sonnet ran." }, nudged,
		spent("seven_day_overage_included"), { kind: "text", text: "Opus ran." }, nudged], { subscriber: true });
	h.env = { ...h.env, CP_NATIVE_MAX_TURNS: "1" } as typeof h.env;
	const [opus, sonnet] = [`${FAKE_NATIVE_MODEL}-opus`, `${FAKE_NATIVE_MODEL}-sonnet`];
	routeNativeModel(h.b.home, [opus, sonnet]);
	h.toggle(true);
	const windows = () => readNativeAvailability(h.b.home)?.windows ?? {};
	const turn = async (model: string) => {
		const job = await h.job();
		await h.b.closeParents();
		const ends = (await h.b.run([{ kind: "tool_calls", calls: [dispatch(job.id, { driver: "claude", model })] }], h.env)) as Tool[];
		const end = ends.find((e) => e.toolName === "cp_dispatch");
		assert.notEqual(end?.isError, true, text(end));
		assert.deepEqual([h.fleet(job.id)?.worker.driver, h.fleet(job.id)?.worker.model], ["claude", model]);
		await waitFailed(h.fleet, job.id);
	};
	const offOn = () => { h.toggle(false); h.toggle(true); };
	await turn(opus);
	assert.deepEqual([windows().seven_day_opus?.status, windows().seven_day_opus?.resets_at], ["rejected", undefined]);
	await turn(sonnet);
	assert.deepEqual([windows().seven_day_overage_included?.status, windows().seven_day_overage_included?.resets_at], ["rejected", undefined]);
	// Off then on admits new runs past both blocks (ii) but deletes neither; only a successful turn does.
	offOn();
	assert.ok(windows().seven_day_opus && windows().seven_day_overage_included, JSON.stringify(windows()));
	await turn(sonnet);
	assert.equal(windows().seven_day_overage_included, undefined, "a sonnet turn left the overage block");
	assert.equal(windows().seven_day_opus?.status, "rejected", "a sonnet turn cleared the opus block");
	await turn(sonnet);
	assert.equal(windows().seven_day_overage_included?.status, "rejected");
	offOn();
	await turn(opus);
	assert.deepEqual([windows().seven_day_opus, windows().seven_day_overage_included], [undefined, undefined], "an opus turn left a block");
	assert.equal(h.claude.overrun(), 0);
});

async function waitFailed(fleet: (id: string) => ReturnType<typeof readFleet>["jobs"][number] | undefined, id: string) {
	for (let i = 0; i < 600; i++) {
		const record = fleet(id);
		if (record?.phase === "failed") return record;
		await sleep(200);
	}
	return fleet(id);
}

// N4h: with the reviews row on `driver: "claude"` and claude_review on, cp_review runs a native reviewer (Bash refused,
// lockdown ok, usage measured) that files the verdict pi would; with the switch off the same review runs on pi.
test("N4h native reviewer: cp_review on a claude row files pi's verdict natively; claude_review off runs pi", { skip, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo" });
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const verdict = (jobId: string) => ({ job_id: jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed the packet"] });
	const [nativeJob, piJob] = ["cp-n4h-native", "cp-n4h-pi"];
	const claude = await startClaudeMockProvider([
		{ kind: "tool_use", calls: [{ name: "Bash", input: { command: "cat /etc/hostname" } }] },
		{ kind: "tool_use", calls: [{ name: VERDICT_TOOL, input: verdict(nativeJob) }] },
		{ kind: "text", text: "Reviewed." },
	]);
	const scratch = mkdtempSync(join(tmpdir(), "cp-n4h-native-"));
	chmodSync(scratch, 0o700);
	const fakeHome = join(scratch, "home");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	const parentEnv = { ...process.env, ...agent.env, HOME: fakeHome, CLAUDE_CONFIG_DIR: join(fakeHome, ".claude") };
	// pi's lane cannot serve the native model, so the switch-off walk lands on the row's pi fallback.
	const modelRegistry = () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_NATIVE_MODEL });
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv, holdsParentLock: () => true, sendWakeup: () => true, modelRegistry });
	t.after(async () => {
		await post.shutdown(); await claude.close(); agent.cleanup(); await provider.stop(); repo.cleanup(); home.cleanup();
		rmSync(scratch, { recursive: true, force: true });
	});
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "pr" });
	for (const jobId of [nativeJob, piJob]) {
		repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
		repo.write(`${jobId}.txt`, "one\n");
		repo.commitAll(jobId);
		repo.git("push", "--quiet", "-u", "origin", jobId);
		repo.git("checkout", "--quiet", repo.branch);
		const now = isoTimestamp();
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "legacy", session_file: join(home.path, "legacy.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: now }, worktree: join(home.path, "recycled", jobId), branch: jobId });
	}
	const piModel = provider.addScript("n4h-pi", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(piJob) }] }]);
	agent.writeModels(provider);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", FAKE_NATIVE_MODEL],
		rubric: [{ id: "reviews", role: "gate-reviewer", model: FAKE_NATIVE_MODEL, fallbacks: [piModel], driver: "claude" }] }));
	const toggle = (on: boolean) => writeFileSync(join(home.path, LAYOUT.data, "native.json"), JSON.stringify({ claude_review: on }));
	const review = async (jobId: string) => {
		const started = await post.diffReview({ jobId });
		if (isDiffReviewWait(started)) {
			post.reviewRuns.handBack(started.key);
			await post.reviewRuns.settled(started.key);
		}
		const attempt = isDiffReviewWait(started) ? started.attempt : started.verdict.attempt;
		const result = JSON.parse(readFileSync(join(home.path, paths.reviewFile(jobId, attempt)), "utf8")) as DiffVerdict;
		const run = join(home.path, paths.reviewRunDir(jobId, attempt));
		const events = readFileSync(join(run, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
		const routed = events.find((event) => event.type === "cp:routing_resolved" || event.type === "routing_resolved")?.payload;
		return { result, run, events, routed, verdictFile: join(home.path, paths.reviewVerdictFile(jobId, attempt)) };
	};
	toggle(true);
	const native = await review(nativeJob);
	assert.equal(native.result.verdict, "pass", JSON.stringify(native.result));
	assert.match(String(native.routed?.line), new RegExp(`model=${FAKE_NATIVE_MODEL} .*driver=claude`), JSON.stringify(native.routed));
	assert.deepEqual((JSON.parse(readFileSync(native.verdictFile, "utf8")) as { review: unknown }).review, verdict(nativeJob), "the native verdict file is pi's shape");
	assert.match(toolResults(claude.requests)[0] ?? "", /^\[error\]/, "the reviewer's Bash call is refused");
	const run = native.events.find((event) => event.type === "native_run")?.payload;
	assert.deepEqual([run?.lockdown, run?.report, run?.usage], ["ok", true, "measured"], JSON.stringify(run));
	assert.ok((JSON.parse(readFileSync(join(native.run, "status.json"), "utf8")) as { usage: { total_tokens: number } }).usage.total_tokens > 0, "native usage is measured");
	toggle(false);
	const pi = await review(piJob);
	assert.equal(pi.routed?.model, piModel, JSON.stringify(pi.routed));
	assert.doesNotMatch(String(pi.routed?.line), /driver=claude/);
	assert.equal(pi.events.some((event) => event.type === "native_run"), false);
	const same = (v: DiffVerdict) => ({ verdict: v.verdict, cause: v.cause, flags: v.flags, reasons: v.reasons });
	assert.deepEqual(same(native.result), same(pi.result), "the native review result equals pi's for the same verdict");
});
