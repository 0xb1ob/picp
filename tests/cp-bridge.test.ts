/**
 * cp-bridge: mock parent, receipts, one wake, one escalation, relaunch same session.
 * A real pi load proves the main session has no fleet tools.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isZombieProcessStat } from "./harness/fake-parent-tracker.ts";
import { BRIDGE_RECEIPT_LEVELS, LAYOUT, layoutForHome, PARENT_BRIDGE_FLAGS } from "../src/contracts.ts";
import { workerEnvironment } from "../src/worker-manager.ts";
import {
	type BridgeReceipt,
	type BridgeRelay,
	buildParentArgv,
	CpBridge,
	CpBridgeError,
	operatorPiArgs,
	parentEnv,
	PARENT_SKILLS,
	parentSkillPaths,
	requireAvailableParentModel,
	resolveParentModel,
} from "../src/cp-bridge.ts";
import { ALWAYS_AVAILABLE, registryProbe } from "../src/routing.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import { isPidAlive } from "../src/fleet.ts";
import { EscalationStore, raiseMissionEnd } from "../src/escalation.ts";
import { initJobsDocument, Ledger } from "../src/ledger.ts";
import { acquireParentLock } from "../src/parent-lock.ts";
import { attachParentHost, currentHost, ParentHostClient, parentHostPaths, runParentHost } from "../src/parent-host.ts";
import { operatorSendTexts, ParentSendOutbox, parentSendFile } from "../src/parent-outbox.ts";
import type { WorkerExit } from "../src/worker-process.ts";
import bridgeExtension, { BRIDGE_TOOL, operatorTargetFile, resolveOperatorTarget, saveOperatorTarget, assertOperatorTarget, validateOperatorTarget, clearOperatorTarget, retireStaleOperatorTarget, observedSendStubs } from "../extensions/cp-bridge/index.ts";
import { deliverStandingOrders, standingOrdersFile } from "../src/parent-context.ts";
import { parentFile, parentRow } from "../src/viewer/sessions.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import { OPERATOR_BUILTIN_EXTENSIONS } from "../src/viewer/operator.ts";
import { readOperatorSessions } from "../src/viewer/operator-sessions.ts";
import { createScratchHome, startRpc } from "./harness/index.ts";

const FAKE_PARENT = resolve(import.meta.dirname, "fixtures", "fake-parent.mjs");

test("fake-parent tracker recognizes Linux zombie process states", () => {
	assert.equal(isZombieProcessStat("42 (worker) Z 1 2 3"), true);
	assert.equal(isZombieProcessStat("42 (worker ) with parens) Z 1 2 3"), true);
	assert.equal(isZombieProcessStat("42 (worker) S 1 2 3"), false);
});


function scratch(): string {
	return mkdtempSync(join(tmpdir(), "cp-bridge-"));
}

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function lines(file: string): string[] {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** A bridge on a scratch home with the send-outbox fixture logs wired up. */
async function outboxBridge(t: import("node:test").TestContext) {
	const home = createScratchHome();
	const dir = scratch();
	const files = { prompts: join(dir, "prompts"), ids: join(dir, "ids"), noland: join(dir, "noland") };
	Object.assign(process.env, { FAKE_PARENT_PROMPTS: files.prompts, FAKE_PARENT_SEND_IDS: files.ids, FAKE_PARENT_NOLAND_ONCE: files.noland });
	const bridges: CpBridge[] = [];
	const relays: BridgeRelay[] = [];
	const open = async () => {
		const bridge = new CpBridge();
		bridges.push(bridge);
		bridge.onRelay((relay) => relays.push(relay));
		await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
		return bridge;
	};
	t.after(async () => {
		for (const key of ["FAKE_PARENT_PROMPTS", "FAKE_PARENT_SEND_IDS", "FAKE_PARENT_NOLAND_ONCE"]) delete process.env[key];
		for (const bridge of bridges) await bridge.stop();
		home.cleanup();
	});
	const sendRelays = (id: string | undefined) => relays.filter((relay) => relay.kind === "send" && relay.sendId === id);
	return { home: home.path, files, relays, sendRelays, open };
}

test("operator targets are keyed by home and stale pids refuse attachment", () => {
	const base = scratch();
	const env = { PI_HOME: base };
	const a = { home: join(base, "home-a"), mode: "multi" as const, hostPid: process.pid, parentPid: process.pid };
	const b = { home: join(base, "home-b"), mode: "multi" as const, hostPid: process.pid, parentPid: process.pid };
	saveOperatorTarget(a, env);
	saveOperatorTarget(b, env);
	for (const target of [a, b]) {
		assert.deepEqual(resolveOperatorTarget(target.home, target.mode, { ...env, CP_HOME: join(base, "different-env") }, join(base, "different-cwd")), target);
	}
	assert.deepEqual(resolveOperatorTarget(undefined, undefined, { ...env, CP_HOME: join(base, "different-env") }, join(base, "different-cwd")), b);
	for (const [attached, requested] of [[a, b], [b, a]] as const) {
		assert.throws(() => assertOperatorTarget(attached, requested), /attached to/);
	}
	assert.equal(operatorTargetFile(a.home, env) === operatorTargetFile(b.home, env), false);
	const lock = acquireParentLock({ home: a.home });
	assert.equal(lock.ok, true);
	if (!lock.ok) throw new Error("test parent lock acquisition failed");
	assert.doesNotThrow(() => validateOperatorTarget(a));
	lock.lock.release();
	assert.throws(() => validateOperatorTarget({ ...a, hostPid: -1 }), /host pid -1 is dead/);
	clearOperatorTarget(b, env);
	assert.deepEqual(resolveOperatorTarget(a.home, "multi", env, join(base, "different-cwd")), a);
	clearOperatorTarget(a, env);
});
test("a stored single-project operator target is refused, naming the file and pids; a multi one reads unchanged", () => {
	const base = scratch();
	const env = { PI_HOME: base };
	const home = join(base, "former-single");
	const file = operatorTargetFile(home, env);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ home: resolve(home), mode: "single", hostPid: 4242, parentPid: 4343 }));
	writeFileSync(join(file, "..", "selected.json"), JSON.stringify({ home: resolve(home), mode: "single" }));
	for (const read of [() => resolveOperatorTarget(undefined, undefined, env), () => resolveOperatorTarget(home, "multi", env)]) {
		assert.throws(read, (error: unknown) => {
			const message = (error as Error).message;
			return error instanceof CpBridgeError && /single-project mode was removed/.test(message) && message.includes(file) && /host pid 4242, parent pid 4343/.test(message);
		});
	}
	assert.ok(existsSync(file), "the refused file is never deleted automatically");
	const multi = { home: resolve(home), mode: "multi" as const, hostPid: 1, parentPid: 2 };
	writeFileSync(file, JSON.stringify(multi));
	assert.deepEqual(resolveOperatorTarget(undefined, undefined, env), multi);
});
test("cp_parent start refuses mode single without spawning anything", async () => {
	const home = scratch();
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	} as never);
	const schema = (tools.get(BRIDGE_TOOL) as unknown as { parameters: { properties: { mode: { enum: string[] } } } }).parameters.properties.mode;
	assert.deepEqual(schema.enum, ["multi"], "the cp_parent mode schema accepts only multi");
	const result = await tools.get(BRIDGE_TOOL)!.execute("start", { action: "start", home, mode: "single", model: "mock/parent" });
	assert.match(result.content[0]!.text, /^cp_parent start: single-project mode was removed; .*omit mode or pass multi$/);
	assert.deepEqual(readdirSync(home), [], "no host, lock or layout was created");
	await assert.rejects(new CpBridge().start({ home, mode: "single" as never, model: "mock/parent" }), /single-project mode was removed/);
	await assert.rejects(attachParentHost({ home, mode: "single" as never, timeoutMs: 1 }), /single-project mode was removed/);
	// Parent-host argv keeps [HOST_SCRIPT, home, mode, gen]; single in argv[3] is refused before anything is written.
	await assert.rejects(runParentHost(home, "single", 1), /single-project mode was removed/);
	await assert.rejects(runParentHost(home, "dual", 1), /mode must be multi, got dual/);
	assert.deepEqual(readdirSync(home), []);
});
test("stale operator targets are retired unless their own parent still holds the lock", () => {
	const home = scratch();
	const env = { PI_HOME: scratch() };
	const lock = acquireParentLock({ home });
	assert.equal(lock.ok, true);
	if (!lock.ok) throw new Error("test parent lock acquisition failed");
	// Dead host, but the saved parent is alive and owns the lock: that orphaned parent stays tracked.
	const orphan = { home, mode: "multi" as const, hostPid: -1, parentPid: process.pid };
	saveOperatorTarget(orphan, env);
	assert.throws(() => retireStaleOperatorTarget(orphan, env), /parent pid \d+ is alive and holds the parent lock/);
	assert.deepEqual(resolveOperatorTarget(home, "multi", env), orphan);
	// Dead saved pids while a different live parent holds the lock: the stale file is retired.
	const target = { home, mode: "multi" as const, hostPid: -1, parentPid: -1 };
	saveOperatorTarget(target, env);
	retireStaleOperatorTarget(target, env);
	assert.equal(resolveOperatorTarget(home, "multi", env).hostPid, 0);
	lock.lock.release();
});
test("receipt levels are the five names and not accepted", () => {
	assert.deepEqual(BRIDGE_RECEIPT_LEVELS, ["injected", "turn_settled", "http_accepted", "owner_observed", "turn_failed"]);
	assert.equal(BRIDGE_RECEIPT_LEVELS.includes("accepted" as never), false);
});

test("parent host restart retires dead target after crash and does not replay an observed send", async (t) => {
	const ctx = hostHome(t);
	const env = { PI_HOME: scratch() };
	const first = await ctx.attach();
	const started = await ctx.start(first);
	const relays: BridgeRelay[] = [];
	await first.onRelay((relay) => relays.push(relay));
	const receipt = await first.request("send", "before host crash") as BridgeReceipt;
	const target = { home: ctx.home, mode: "multi" as const, hostPid: first.hostPid, parentPid: started.pid as number };
	saveOperatorTarget(target, env);
	first.disconnect();
	await first.closed;
	process.kill(target.parentPid, "SIGKILL");
	process.kill(target.hostPid, "SIGKILL");
	await until(() => !isPidAlive(target.parentPid) && !isPidAlive(target.hostPid), "crashed parent and host");
	retireStaleOperatorTarget(target, env);
	const replacement = await ctx.attach();
	const replayed: BridgeRelay[] = [];
	await replacement.onRelay((relay) => replayed.push(relay));
	const next = await ctx.start(replacement);
	assert.notEqual(next.pid, target.parentPid);
	assert.equal(replayed.some((relay) => relay.sendId === receipt.send_id), false);
	await replacement.request("stop", { discardPending: true });
	await replacement.closed;
});
test("operator launcher loads the bridge, pi's built-in MCP extensions and the web extension", () => {
	const script = readFileSync(join(PACKAGE_ROOT, "bin/cp-operator"), "utf8");
	assert.match(script, /exec node "\$ROOT\/src\/viewer\/operator\.ts" "\$@"/);
	const launcher = readFileSync(join(PACKAGE_ROOT, "src/viewer/operator.ts"), "utf8");
	// The supervise loop (src/operator-relaunch.ts) hands each run its args: the CLI's first, `--session <file>` on a relaunch.
	assert.match(launcher, /spawn\(options\.piBin \?\? "pi", operatorPiArgs\(PACKAGE_ROOT, operatorModelArgs\(args, process\.env, model\), \[\.\.\.OPERATOR_BUILTIN_EXTENSIONS, \.\.\.web\.extensions\]\)/);
	assert.deepEqual(OPERATOR_BUILTIN_EXTENSIONS, ["builtin:mcp", "builtin:codemode", "builtin:tool-search"]);
	assert.match(launcher, /firstArgs: piArgs/);
	assert.equal(script.includes("extensions/command-post") || launcher.includes("extensions/command-post"), false);
	const args = operatorPiArgs(PACKAGE_ROOT);
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.some((arg) => arg.endsWith("extensions/cp-bridge/index.ts")));
	assert.equal(args.some((arg) => arg.includes("extensions/command-post")), false);
	assert.equal(BRIDGE_TOOL, "cp_parent");
});

test("operator argv adds only the resolved web extension, after the bridge", () => {
	const bridge = join(PACKAGE_ROOT, "extensions/cp-bridge/index.ts");
	assert.deepEqual(operatorPiArgs(PACKAGE_ROOT, ["--x"]), ["--no-extensions", "-e", bridge, "--x"]);
	assert.deepEqual(operatorPiArgs(PACKAGE_ROOT, ["--x"], ["/pkg/web/index.ts"]), ["--no-extensions", "-e", bridge, "-e", "/pkg/web/index.ts", "--x"]);
});

test("parent starts with --no-skills plus --skill <home>/skills/<name> for each PARENT_SKILLS entry, and nothing else skill-wise", () => {
	assert.deepEqual([...PARENT_BRIDGE_FLAGS], ["--no-extensions", "--no-skills"]);
	const pkg = (name: string) => join(PACKAGE_ROOT, "skills", name);
	// A checkout home is the package root: the shipped skills resolve from it.
	assert.deepEqual(parentSkillPaths(PACKAGE_ROOT), [pkg("cp-memory"), pkg("cp-self-review"), pkg("cp-pr-review"), pkg("cp-org-pr-review")]);
	for (const name of PARENT_SKILLS) assert.match(readFileSync(join(PACKAGE_ROOT, "skills", name, "SKILL.md"), "utf8"), new RegExp(`^name: ${name}$`, "m"));
	// A home with its own copy wins per skill; a managed home without one falls back to the package.
	const home = scratch();
	assert.deepEqual(parentSkillPaths(home), [pkg("cp-memory"), pkg("cp-self-review"), pkg("cp-pr-review"), pkg("cp-org-pr-review")]);
	mkdirSync(join(home, "skills/cp-memory"), { recursive: true });
	writeFileSync(join(home, "skills/cp-memory/SKILL.md"), "---\nname: cp-memory\n---\n", "utf8");
	assert.deepEqual(parentSkillPaths(home), [join(home, "skills/cp-memory"), pkg("cp-self-review"), pkg("cp-pr-review"), pkg("cp-org-pr-review")]);

	const args = buildParentArgv({ sessionFile: "/s.jsonl", model: "m/x", extension: "/cp.ts", skills: parentSkillPaths(home) });
	assert.ok(args.includes("--no-extensions") && args.includes("--no-skills"));
	const skills = args.flatMap((arg, i) => (arg === "--skill" ? [args[i + 1]] : []));
	assert.deepEqual(skills, parentSkillPaths(home));
});

test("cp_parent ask accepts and records the ask's context in state/operator/asks.jsonl", async (t) => {
	const home = createScratchHome();
	const previousPiHome = process.env.PI_HOME;
	process.env.PI_HOME = scratch();
	t.after(() => {
		if (previousPiHome === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previousPiHome;
		home.cleanup();
	});
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown> }> }>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	} as never);
	const context = "The parent paused cp-demo at the spend cap.\n\n- Keep: nothing more is spent\n- Raise: $5 more, finishes today";
	const opened = await tools.get(BRIDGE_TOOL)!.execute("ask", { action: "ask", ask: { project: "demo", question: "Raise the cap?", options: [{ label: "Keep", consequence: "Work stays paused" }], recommendation: "Keep", context } });
	assert.match(String(opened.details.id), /^ask-/);
	const file = join(home.path, LAYOUT.state, "operator", "asks.jsonl");
	const [event] = lines(file).map((line) => JSON.parse(line) as { type?: string; context?: string });
	assert.equal(event?.type, "open");
	assert.equal(event?.context, context, "the ask's context reaches the journal, not just the tool schema");
});

test("send returns owner_observed and the reply; http_accepted is not claimed", async (t) => {
	const home = createScratchHome();
	const argvFile = join(scratch(), "argv");
	process.env.FAKE_PARENT_ARGV = argvFile;
	const bridge = new CpBridge();
	t.after(async () => {
		delete process.env.FAKE_PARENT_ARGV;
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	const receipt = await bridge.send("mandate ship the widget");
	assert.equal(receipt.level, "owner_observed");
	assert.deepEqual(receipt.reached, ["injected", "turn_settled", "owner_observed"]);
	assert.equal(receipt.reached.includes("http_accepted"), false);
	assert.match(receipt.reply ?? "", /mandate ship the widget/);
	assert.equal(JSON.stringify(receipt).includes("accepted"), false);
	const status = bridge.status();
	assert.equal(status.alive, true);
	assert.equal(typeof status.pid, "number");
	assert.ok(status.sessionFile?.endsWith("cp-parent.jsonl"));
	assert.ok(status.lastReplyAt);
});

test("parent controls compact only when settled and status reports context tokens", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	assert.equal((await bridge.statusWithContext()).contextTokens, 42000);
	assert.equal((await bridge.compact()).tokensBefore, 42000);
	await bridge.send("HANG x", 50);
	await assert.rejects(bridge.compact(), /pending send|settled/);
	await bridge.send("RELEASE");
	assert.equal((await bridge.statusWithContext()).contextTokens, 5000);
});

test("automatic compact runs after settlement, never with a pending durable send", async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), '{"compact_at_tokens":40000}');
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const pending = await bridge.send("HANG x", 100);
	assert.equal(pending.pending, pending.send_id);
	assert.equal((await bridge.statusWithContext()).contextTokens, 42000);
	await bridge.send("RELEASE");
	await until(() => bridge.status().lastCompactAt !== undefined, "automatic compact");
	assert.equal((await bridge.statusWithContext()).contextTokens, null);
	await bridge.send("next turn");
	assert.ok((await bridge.statusWithContext()).contextTokens! < 40000);
});

test("an immediate next send waits for automatic compaction", async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), '{"compact_at_tokens":40000}');
	process.env.FAKE_PARENT_STATS_DELAY_MS = "250";
	const bridge = new CpBridge();
	t.after(async () => { delete process.env.FAKE_PARENT_STATS_DELAY_MS; await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	await bridge.send("first turn");
	await bridge.send("immediate next turn");
	assert.ok(bridge.status().lastCompactAt, "compaction completed before the next send");
	assert.ok((await bridge.statusWithContext()).contextTokens! < 40000);
});

/** C1/picp-80q: the bridge's automatic-control lines in `state/daemon.log`. */
const daemonLog = (home: string, event: string) => lines(daemonPaths(home).log).filter((line) => line.includes(`cp-parent-host[`) && line.includes(`parent context ${event}`));

async function controlBridge(t: import("node:test").TestContext, env: Record<string, string>, threshold: number, requestTimeoutMs = 5_000) {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: threshold }));
	Object.assign(process.env, env);
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => { for (const key of Object.keys(env)) delete process.env[key]; await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs, settleTimeoutMs: 5_000 });
	return { home: home.path, bridge, relays, log: (event: string) => daemonLog(home.path, event), errors: () => relays.filter((relay) => relay.kind === "error") };
}

test("C1: automatic compact runs before a queued send drains, and is logged once", async (t) => {
	const ctx = await outboxBridge(t);
	mkdirSync(join(ctx.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(ctx.home, LAYOUT.data, "parent.json"), '{"compact_at_tokens":40000}');
	const bridge = await ctx.open();
	await bridge.send("HANG first", 100);
	// Queued by the bridge, not yet in pi: it no longer blocks automatic compaction.
	new ParentSendOutbox({ file: parentSendFile(join(ctx.home, LAYOUT.sessions, "cp-parent.jsonl")) }).enqueue("QUEUED second");
	await bridge.send("RELEASE");
	await until(() => lines(ctx.files.prompts).includes("QUEUED second"), "the queued send drained");
	assert.deepEqual(lines(ctx.files.prompts), ["HANG first", "RELEASE", "[compact]", "QUEUED second"]);
	assert.ok(bridge.status().lastCompactAt);
	assert.equal(daemonLog(ctx.home, "compacted").length, 1);
});

test("C1: ready-time control compacts before a queued send drains", async (t) => {
	const ctx = await outboxBridge(t);
	mkdirSync(join(ctx.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(ctx.home, LAYOUT.data, "parent.json"), '{"compact_at_tokens":40000}');
	new ParentSendOutbox({ file: parentSendFile(join(ctx.home, LAYOUT.sessions, "cp-parent.jsonl")) }).enqueue("QUEUED at start");
	await ctx.open();
	await until(() => lines(ctx.files.prompts).includes("QUEUED at start"), "the queued send drained");
	assert.deepEqual(lines(ctx.files.prompts), ["[compact]", "QUEUED at start"]);
	assert.equal(daemonLog(ctx.home, "compacted").length, 1);
});

test("N6: a length stop is not compacted, and the skip is logged once", async (t) => {
	const ctx = await controlBridge(t, { FAKE_PARENT_LENGTH_STOP: "1", FAKE_PARENT_STATS_TOKENS: "255640" }, 200000);
	await ctx.bridge.send("first turn");
	await until(() => ctx.log("skipped_length_stop").length > 0, "the skip line");
	assert.equal(ctx.log("skipped_length_stop").length, 1);
	assert.match(ctx.log("skipped_length_stop")[0]!, /raw=255640 effective=127\d{3} threshold=200000/);
	assert.equal(ctx.bridge.status().lastCompactAt, undefined);
});

test("C1: a failed automatic compact is logged and relayed, never silent", async (t) => {
	const ctx = await controlBridge(t, { FAKE_PARENT_COMPACT_FAIL: "1" }, 40000);
	await ctx.bridge.send("first turn");
	await until(() => ctx.log("failed").length > 0 && ctx.errors().length > 0, "the failure line and relay");
	assert.equal(ctx.log("failed").length, 1);
	assert.match(ctx.log("failed")[0]!, /fixture compaction failure/);
	assert.equal(ctx.errors().length, 1);
	assert.match(ctx.errors()[0]!.text, /parent automatic context control failed: compact rejected: fixture compaction failure/);
});

test("C1: a refused automatic compact names its reason", async (t) => {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	t.after(() => { process.off("unhandledRejection", onRejection); });
	const ctx = await controlBridge(t, { FAKE_PARENT_STATS_BUSY_ONCE: "1" }, 40000);
	await ctx.bridge.send("first turn");
	await until(() => ctx.log("refused").length > 0, "the refusal line");
	assert.equal(ctx.log("refused").length, 1);
	assert.match(ctx.log("refused")[0]!, /refused busy raw=42000/);
	assert.equal(ctx.bridge.status().lastCompactAt, undefined);
	assert.deepEqual(rejections, []);
});

test("C1: a timed-out automatic compact is logged once as timed_out", async (t) => {
	const ctx = await controlBridge(t, { FAKE_PARENT_COMPACT_DELAY_MS: "3000" }, 40000, 1_000);
	await ctx.bridge.send("first turn");
	await until(() => ctx.log("timed_out").length > 0, "the timed_out line");
	assert.equal(ctx.log("timed_out").length, 1);
	assert.equal(ctx.log("failed").length, 0);
	assert.equal(ctx.errors().length, 1);
	assert.match(ctx.errors()[0]!.text, /timed out: timeout after 1000ms waiting for response to compact/);
});

test("mission-end rotates after settlement without restarting the parent or its worker", async (t) => {
	const home = createScratchHome();
	const workerFile = join(scratch(), "worker-pid");
	process.env.FAKE_PARENT_WORKER_PID_FILE = workerFile;
	const bridge = new CpBridge();
	t.after(async () => { delete process.env.FAKE_PARENT_WORKER_PID_FILE; await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	await bridge.model("mock/other");
	const worker = Number(readFileSync(workerFile, "utf8"));
	const pid = bridge.status().pid;
	const previous = bridge.status().sessionFile;
	const pending = await bridge.send("HANG MISSIONEND", 100);
	assert.equal(pending.pending, pending.send_id);
	assert.equal(bridge.status().sessionFile, previous, "mission end does not rotate mid-turn");
	await bridge.send("RELEASE");
	await until(() => bridge.status().lastRotateAt !== undefined, "mission-end rotation");
	await until(() => daemonLog(home.path, "rotated").length > 0, "the rotation line");
	assert.equal(daemonLog(home.path, "rotated").length, 1);
	assert.match(daemonLog(home.path, "rotated")[0]!, /rotated mission=md-test/);
	assert.notEqual(bridge.status().sessionFile, previous);
	assert.equal(bridge.status().model, "mock/other");
	assert.equal(bridge.status().pid, pid);
	assert.ok(isPidAlive(worker));
	const current = bridge.status().sessionFile;
	await bridge.send("MISSIONEND");
	assert.equal(bridge.status().sessionFile, current, "same mission end is not rotated twice");
	assert.equal(daemonLog(home.path, "rotated").length, 1, "and is logged once");
});

test("rotate archives old session and relaunches the new file", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const started = await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const rotated = await bridge.rotate();
	assert.notEqual(rotated.sessionFile, started.sessionFile);
	assert.ok(rotated.archivedFile.includes("cp-parent-"));
	assert.ok(readFileSync(rotated.archivedFile, "utf8").includes('"type":"session"'));
	const delivered = await bridge.send("after rotation");
	assert.equal(delivered.reply, "reply: after rotation");
	assert.equal(bridge.status().sends.find((send) => send.id === delivered.send_id)?.level, "owner_observed");
	const pid = bridge.status().pid as number;
	process.kill(pid, "SIGKILL");
	await until(() => bridge.status().pid !== pid && bridge.status().alive, "rotated session relaunch");
	assert.equal(bridge.status().sessionFile, rotated.sessionFile);
	await bridge.stop();
	const next = new CpBridge();
	t.after(() => next.stop());
	assert.equal((await next.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT })).sessionFile, rotated.sessionFile);
});

test("model changes without restarting the parent or its live worker and persists for next start", async (t) => {
	const home = createScratchHome();
	const workerFile = join(scratch(), "worker-pid");
	process.env.FAKE_PARENT_WORKER_PID_FILE = workerFile;
	const bridge = new CpBridge();
	t.after(async () => { delete process.env.FAKE_PARENT_WORKER_PID_FILE; await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const workerPid = Number(readFileSync(workerFile, "utf8"));
	assert.ok(isPidAlive(workerPid), "fixture worker is alive before the switch");
	const pid = bridge.status().pid;
	assert.equal((await bridge.model("mock/other")).model, "mock/other");
	assert.equal(bridge.status().pid, pid);
	assert.equal(Number(readFileSync(workerFile, "utf8")), workerPid);
	assert.ok(isPidAlive(workerPid), "fixture worker survives the switch");
	assert.equal(bridge.status().alive, true);
	await bridge.stop();
	const next = new CpBridge();
	t.after(() => next.stop());
	await next.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	assert.equal(next.status().model, "mock/other");
});

test("start model precedence: data/parent.json model beats the saved control model and a resolved model; an explicit start model beats the file", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	mkdirSync(join(home.path, LAYOUT.sessions), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.sessions, "cp-parent-control.json"), JSON.stringify({ model: "mock/saved" }));
	const startWith = async (options: { model: string; modelExplicit?: boolean }) => {
		const bridge = new CpBridge();
		t.after(() => bridge.stop());
		await bridge.start({ home: home.path, mode: "multi", piBin: FAKE_PARENT, ...options });
		const model = bridge.status().model;
		await bridge.stop();
		return model;
	};
	assert.equal(await startWith({ model: "mock/env" }), "mock/saved", "absent model key: the saved control model still wins, as before");
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 1000, model: "mock/file" }));
	assert.equal(await startWith({ model: "mock/env" }), "mock/file", "the file beats the saved control model and the env/session model");
	assert.equal(await startWith({ model: "mock/explicit", modelExplicit: true }), "mock/saved", "an explicit start model skips the file; the saved control model still beats it, as today");
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ model: "not a model" }));
	assert.equal(await startWith({ model: "mock/env" }), "mock/saved", "an invalid file model is ignored");
});

test("rotate applies the configured parent model; a set_model rejection keeps the running model, relays one error and still returns", async (t) => {
	const home = createScratchHome();
	process.env.FAKE_PARENT_REJECT_MODEL = "mock/bad";
	const bridge = new CpBridge();
	t.after(async () => { delete process.env.FAKE_PARENT_REJECT_MODEL; await bridge.stop(); home.cleanup(); });
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const parentFile = join(home.path, LAYOUT.data, "parent.json");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(parentFile, JSON.stringify({ compact_at_tokens: 1000, model: "mock/next" }));
	const first = await bridge.rotate();
	assert.equal(bridge.status().model, "mock/next");
	assert.equal(bridge.status().sessionFile, first.sessionFile);
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.sessions, "cp-parent-control.json"), "utf8")).model, "mock/next");
	assert.deepEqual(relays.filter((relay) => relay.kind === "error"), []);

	writeFileSync(parentFile, JSON.stringify({ compact_at_tokens: 1000, model: "mock/bad" }));
	const second = await bridge.rotate();
	assert.notEqual(second.sessionFile, first.sessionFile, "the rotation itself completed");
	assert.equal(bridge.status().model, "mock/next", "the old model stays");
	assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.sessions, "cp-parent-control.json"), "utf8")).model, "mock/next");
	const errors = relays.filter((relay) => relay.kind === "error");
	assert.equal(errors.length, 1);
	assert.match(errors[0]!.text, /^parent rotate kept mock\/next: set_model mock\/bad rejected: Model not found: mock\/bad$/);
	assert.equal((await bridge.send("after a refused switch")).reply, "reply: after a refused switch");
});

test("rotate keeps an explicit start model and a live cp_parent model switch over data/parent.json; absent explicit, the file applies", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 1000, model: "mock/file" }));
	const control = () => JSON.parse(readFileSync(join(home.path, LAYOUT.sessions, "cp-parent-control.json"), "utf8")).model;

	const explicit = new CpBridge();
	t.after(() => explicit.stop());
	await explicit.start({ home: home.path, mode: "multi", model: "mock/explicit", modelExplicit: true, piBin: FAKE_PARENT });
	assert.equal(explicit.status().model, "mock/explicit");
	await explicit.rotate();
	assert.equal(explicit.status().model, "mock/explicit", "an explicit start model survives rotation");
	assert.equal(control(), "mock/explicit");
	await explicit.stop();

	const live = new CpBridge();
	t.after(() => live.stop());
	await live.start({ home: home.path, mode: "multi", model: "mock/env", piBin: FAKE_PARENT });
	assert.equal(live.status().model, "mock/file", "no explicit model: the file wins at start");
	await live.model("mock/live");
	await live.rotate();
	assert.equal(live.status().model, "mock/live", "a live cp_parent model switch survives rotation");
	assert.equal(control(), "mock/live");
});

test("standing orders seed once, survive operator edits, and deliver beyond 8000 characters", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const messages: string[] = [];
	const send = (message: { content: string }) => { messages.push(message.content); };
	assert.equal(deliverStandingOrders(send, home.path), true);
	const seeded = readFileSync(standingOrdersFile(home.path), "utf8");
	assert.match(seeded, /^# Standing orders/);
	assert.doesNotMatch(seeded, /wall_clock_seconds|gpt-6-sol|gpt-6.1-sol|hold new work/);
	assert.match(seeded, /review only on a green pushed head, and merge only that reviewed head[^]*conflict-resolved/i);
	assert.match(seeded, /state transitions or merge gating goes planner-first/);
	const edited = `${seeded}\n${"x".repeat(8000)}\nLAST ORDER`;
	writeFileSync(standingOrdersFile(home.path), edited);
	assert.equal(deliverStandingOrders(send, home.path), true);
	assert.equal(readFileSync(standingOrdersFile(home.path), "utf8"), edited);
	assert.match(messages[1] ?? "", /LAST ORDER$/);
});

test("fresh home seeds generic operational orders and reloads them after rotation", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const messages: string[] = [];
	const send = (message: { content: string }) => { messages.push(message.content); };
	assert.equal(deliverStandingOrders(send, home.path), true);
	const seeded = readFileSync(standingOrdersFile(home.path), "utf8");
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const rotated = await bridge.rotate();
	await bridge.stop();
	const next = new CpBridge();
	t.after(() => next.stop());
	assert.equal((await next.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT })).sessionFile, rotated.sessionFile);
	assert.equal(deliverStandingOrders(send, home.path), true);
	assert.equal(readFileSync(standingOrdersFile(home.path), "utf8"), seeded);
	for (const message of messages) assert.equal(message.split("\n\n").slice(1).join("\n\n"), seeded.trim());
	assert.match(messages[1] ?? "", /npm run test:one/);
	assert.match(messages[1] ?? "", /never run the full npm test locally/i);
	assert.match(messages[1] ?? "", /one complete operator sentence, verbatim, ending with punctuation/i);
	assert.doesNotMatch(messages[1] ?? "", /full npm test after rebase/i);
	for (const rule of [/\[project\]/, /plain words.*options.*recommendation/i, /push after every commit/i, /CI.*timeout.*5000/i, /CI.*green.*review.*pass/i, /verdict.*due time/i, /server-side rebase.*plain merge.*origin\/main/i]) {
		assert.match(messages[1] ?? "", rule);
	}
	assert.doesNotMatch(seeded, /gpt-6-sol|gpt-6.1-sol|wall_clock_seconds|paused project/i);
});

test("operator-edited standing orders reach a fresh rotated session and viewer follows its file", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const messages: Array<{ content: string; customType: string }> = [];
	const send = (message: { content: string; customType: string }, options: { triggerTurn: false }) => {
		assert.equal(options.triggerTurn, false);
		messages.push(message);
	};
	const operatorOrders = "# Standing orders\n\n## Relays\n- Prefix relays with the current project.\n";
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(standingOrdersFile(home.path), operatorOrders);
	assert.equal(deliverStandingOrders(send, home.path), true);
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT });
	const rotated = await bridge.rotate();
	await bridge.stop();
	const next = new CpBridge();
	t.after(() => next.stop());
	assert.equal((await next.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT })).sessionFile, rotated.sessionFile);
	assert.equal(deliverStandingOrders(send, home.path), true);
	assert.deepEqual(messages.map((m) => m.customType), ["cp-standing-orders", "cp-standing-orders"]);
	for (const message of messages) {
		assert.equal(message.content.split("\n\n").slice(1).join("\n\n"), operatorOrders.trim());
	}
	assert.equal(readFileSync(standingOrdersFile(home.path), "utf8"), operatorOrders);
	const viewer = { home: home.path, stateDir: join(home.path, LAYOUT.state) };
	assert.equal(parentFile(viewer), rotated.sessionFile);
	assert.ok(parentRow(viewer).standing_orders_at);
	assert.ok(parentRow(viewer).last_rotate_at);
});

test("a synthetic wake is relayed once, tagged, paths not bodies", async (t) => {
	const home = createScratchHome();
	writeFileSync(join(home.path, "secret-body.txt"), "SECRET_BODY_DO_NOT_RELAY");
	process.env.FAKE_PARENT_WAKE = "1";
	process.env.FAKE_PARENT_WAKE_JOB = "cp-wake";
	const bridge = new CpBridge();
	const relays: string[] = [];
	bridge.onRelay((relay) => relays.push(`${relay.kind}:${relay.jobId}:${relay.stale}:${relay.text}`));
	t.after(async () => {
		delete process.env.FAKE_PARENT_WAKE;
		delete process.env.FAKE_PARENT_WAKE_JOB;
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
	});
	const wakes = relays.filter((line) => line.startsWith("wake:"));
	assert.equal(wakes.length, 1, JSON.stringify(relays));
	// cp-project-grouped-reporting: a relay about a job opens with its project,
	// and a job no source knows is named as such rather than left untagged.
	assert.match(wakes[0] ?? "", /wake:cp-wake:false:\[project unknown\] job: cp-wake/);
	assert.equal(relays.join("\n").includes("SECRET_BODY_DO_NOT_RELAY"), false);
});

async function wakeRelay(t: import("node:test").TestContext, env: Record<string, string>) {
	const home = createScratchHome();
	Object.assign(process.env, { FAKE_PARENT_WAKE: "1", ...env });
	const bridge = new CpBridge();
	const relays: Array<{ kind: string; jobId?: string; paths: string[] }> = [];
	bridge.onRelay((relay) => relays.push({ kind: relay.kind, jobId: relay.jobId, paths: relay.paths }));
	t.after(async () => {
		for (const key of ["FAKE_PARENT_WAKE", ...Object.keys(env)]) delete process.env[key];
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	return { home: home.path, wakes: relays.filter((relay) => relay.kind === "wake") };
}

test("a wake-up about a PR URL takes its job id from the structured job field, never the URL", async (t) => {
	const prose = "[demo] https://github.com/o/r/pull/9: CI green on the pushed head";
	const { home, wakes } = await wakeRelay(t, { FAKE_PARENT_WAKE_TEXT: prose, FAKE_PARENT_WAKE_JOB: "cp-real-9" });
	assert.equal(wakes.length, 1, JSON.stringify(wakes));
	assert.equal(wakes[0]?.jobId, "cp-real-9");
	assert.ok(wakes[0]?.paths.includes(join(home, LAYOUT.runs, "cp-real-9")), JSON.stringify(wakes[0]?.paths));
	assert.equal(wakes[0]?.paths.some((path) => path.includes("runs/https")), false);
});

test("prose with only a PR URL names no job rather than job=https", async (t) => {
	const { wakes } = await wakeRelay(t, { FAKE_PARENT_WAKE_TEXT: "[demo] https://github.com/o/r/pull/9: merged\njob: https://github.com/o/r/pull/9" });
	assert.equal(wakes.length, 1, JSON.stringify(wakes));
	assert.equal(wakes[0]?.jobId, undefined);
	assert.deepEqual(wakes[0]?.paths, []);
});

test("wake identity never comes from parent reply prose", async (t) => {
	for (const prose of [
		"Running: polish cp-zaao, ...",
		"[demo] Running: polish cp-zaao, ...",
		"job: Running",
		"[demo] cp-zaao: polishing",
		"STALE WAKE-UP — do not act on this (Running).",
	]) {
		await t.test(prose, async (t) => {
			const { wakes } = await wakeRelay(t, { FAKE_PARENT_WAKE_TEXT: prose });
			assert.equal(wakes.length, 1, JSON.stringify(wakes));
			assert.equal(wakes[0]?.jobId, undefined);
			assert.deepEqual(wakes[0]?.paths, []);
		});
	}
});

test("a Running reply keeps the structured wake identity, including legacy IDs", async (t) => {
	for (const job of ["cp-zaao", "pi-command-post-ksw"]) {
		await t.test(job, async (t) => {
			const { home, wakes } = await wakeRelay(t, {
				FAKE_PARENT_WAKE_TEXT: "[demo] Running: polish cp-zaao, ...",
				FAKE_PARENT_WAKE_JOB: job,
			});
			assert.equal(wakes.length, 1, JSON.stringify(wakes));
			assert.equal(wakes[0]?.jobId, job);
			assert.ok(wakes[0]?.paths.includes(join(home, LAYOUT.runs, job)));
			assert.equal(wakes[0]?.paths.some((path) => path.includes("/Running")), false);
		});
	}
});

test("cp-hhuf P1: a cp-schedule fire turn takes its job ids from details.job_id; all-scheduled is not relayed", async (t) => {
	for (const [name, labelled, env] of [
		["unscheduled job: relayed with its job ids", false, {}],
		["scheduled job: not relayed", true, {}],
		["scheduled plus an unscheduled stamp: relayed", true, { FAKE_PARENT_WAKE_JOB: "cp-plain" }],
	] as const) {
		await t.test(name, async (t) => {
			const home = createScratchHome();
			initJobsDocument(home.path, "cp");
			const job = await new Ledger({ home: home.path }).create({ title: "Weather", project: "demo", kind: "research", delivery: "answer", ...(labelled ? { labels: ["schedule:sch-aaaaaa"] } : {}) });
			Object.assign(process.env, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_TEXT: "weather: 29 C", FAKE_PARENT_WAKE_SCHEDULE: job.id, ...env });
			const bridge = new CpBridge();
			const wakes: Array<{ jobIds?: string[] }> = [];
			bridge.onRelay((relay) => { if (relay.kind === "wake") wakes.push({ jobIds: relay.jobIds }); });
			t.after(async () => {
				for (const key of ["FAKE_PARENT_WAKE", "FAKE_PARENT_WAKE_TEXT", "FAKE_PARENT_WAKE_SCHEDULE", "FAKE_PARENT_WAKE_JOB"]) delete process.env[key];
				await bridge.stop();
				home.cleanup();
			});
			await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
			const expected = "FAKE_PARENT_WAKE_JOB" in env ? [["cp-plain", job.id]] : labelled ? [] : [[job.id]];
			assert.deepEqual(wakes.map((wake) => wake.jobIds), expected, JSON.stringify(wakes));
		});
	}
});

test("issue #2: a wake carries the envelope summary verbatim; a killed_unreported notice reaches the operator directly", async (t) => {
	const cases = [
		["an accepted envelope rides on the parent's paraphrase", {
			FAKE_PARENT_WAKE_TEXT: "The worker confirmed: pnpm 9",
			FAKE_PARENT_WAKE_ENVELOPE: JSON.stringify({ job_id: "cp-9b9f", status: "done", summary: "npm, Node v24 (.nvmrc)" }),
		}],
		["a killed-unreported durable wake is relayed as is", {
			FAKE_PARENT_WAKE_DURABLE: JSON.stringify({ id: "killed-unreported:cp-o0mm:2026-10-03T05:24:46Z", content: "[demo] cp-o0mm: killed_unreported — no report" }),
		}],
		["a drain outcome wake reaches the operator with its drain id for the delivery-time recheck (cp-ukqv)", {
			FAKE_PARENT_WAKE_DURABLE: JSON.stringify({ id: "drain:2026-10-04T00:00:00.000Z:timeout", content: "DRAIN: drain timed out after 5s: still busy cp-busy; a restart now kills them" }),
		}],
	] as const;
	for (const [name, env] of cases) {
		await t.test(name, async (t) => {
			const home = createScratchHome();
			initJobsDocument(home.path, "cp");
			Object.assign(process.env, { FAKE_PARENT_WAKE: "1", ...env });
			const bridge = new CpBridge();
			const wakes: Array<{ jobId?: string; drainId?: string; text: string }> = [];
			bridge.onRelay((relay) => { if (relay.kind === "wake") wakes.push({ ...(relay.jobId ? { jobId: relay.jobId } : {}), ...(relay.drainId ? { drainId: relay.drainId } : {}), text: relay.text }); });
			t.after(async () => {
				for (const key of ["FAKE_PARENT_WAKE", "FAKE_PARENT_WAKE_TEXT", "FAKE_PARENT_WAKE_ENVELOPE", "FAKE_PARENT_WAKE_DURABLE"]) delete process.env[key];
				await bridge.stop();
				home.cleanup();
			});
			await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
			if ("FAKE_PARENT_WAKE_ENVELOPE" in env) {
				assert.equal(wakes.length, 1, JSON.stringify(wakes));
				assert.equal(wakes[0]?.jobId, "cp-9b9f");
				assert.ok(wakes[0]?.text.includes("The worker confirmed: pnpm 9"), wakes[0]?.text);
				assert.ok(wakes[0]?.text.includes("envelope cp-9b9f (done), verbatim: npm, Node v24 (.nvmrc)"), wakes[0]?.text);
			} else if (name.startsWith("a drain")) {
				assert.ok(wakes.some((wake) => wake.drainId === "drain:2026-10-04T00:00:00.000Z:timeout" && wake.text.startsWith("DRAIN: drain timed out")), JSON.stringify(wakes));
			} else {
				assert.ok(wakes.some((wake) => wake.text === "[demo] cp-o0mm: killed_unreported — no report" && wake.drainId === undefined), JSON.stringify(wakes));
			}
		});
	}
});

test("a landed continuation reaches the operator once without a parent reply", async (t) => {
	for (const startup of [true, false]) await t.test(`startup=${startup}`, async (t) => {
		const home = createScratchHome();
		initJobsDocument(home.path, "cp");
		const content = "[demo] HELD PR LANDED — cp-land\n  https://github.com/o/r/pull/7";
		Object.assign(process.env, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_DURABLE: JSON.stringify({ id: "continuation:done:cp-land:1", content, quiet: true, startup }) });
		const bridge = new CpBridge();
		const wakes: BridgeRelay[] = [];
		bridge.onRelay((relay) => { if (relay.kind === "wake") wakes.push(relay); });
		t.after(async () => {
			delete process.env.FAKE_PARENT_WAKE;
			delete process.env.FAKE_PARENT_WAKE_DURABLE;
			await bridge.stop();
			home.cleanup();
		});
		await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
		assert.equal(wakes.length, 1);
		assert.equal(wakes[0]!.text, content);
	});
});

test("a withdrawn escalation is not replayed by a stale tool result in a fresh bridge", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const store = new EscalationStore({ home: home.path });
	const raised = await store.raise({
		job_ids: ["cp-job"], kind: "product_ambiguity", question: "ship?",
		options: [{ id: "hold", label: "Hold", consequence: "No merge", cost: "none" }],
		recommended: "hold", evidence_paths: [],
	});
	await store.withdraw(raised.id);
	const data = store.read();
	data.items[0]!.id = "es-0001";
	writeFileSync(store.file, JSON.stringify(data));

	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("ESCALATE");
	assert.equal(relays.filter((relay) => relay.kind === "escalation").length, 0);
	assert.equal(store.get("es-0001")?.status, "withdrawn");
});

test("a mission end that cp_next raised itself reaches the relay, once by id", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	const store = new EscalationStore({ home: home.path });
	await raiseMissionEnd(store, { jobIds: ["cp-job"], mandateId: "md-000001", summary: "landed 0, dropped 1, cost $1.00" });
	const data = store.read();
	data.items[0]!.id = "es-0001";
	writeFileSync(store.file, JSON.stringify(data));
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("NEXTMESSY");
	await bridge.send("NEXTMESSY");
	const open = relays.filter((relay) => relay.kind === "escalation");
	assert.deepEqual(open.map((relay) => relay.escalationId), ["es-0001"], "one relay, by id, though cp_next ran twice");
	assert.match(open[0]?.text ?? "", /dropped 1/);
});

test("a re-raised escalation relays again with its refreshed numbers, under the same id", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: Array<{ id?: string; text: string }> = [];
	bridge.onRelay((relay) => {
		if (relay.kind === "escalation") relays.push({ id: relay.escalationId, text: relay.text });
	});
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("REFRESH");
	assert.deepEqual(relays.map((relay) => relay.id), ["es-0002", "es-0002"]);
	assert.match(relays[1]?.text ?? "", /cost \$9\.95$/);
});

test("escalation on the stream is one message; stale headline is marked", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: Array<{ kind: string; id?: string; jobId?: string; stale: boolean; text: string; paths: string[] }> = [];
	bridge.onRelay((relay) =>
		relays.push({
			kind: relay.kind,
			id: relay.escalationId,
			jobId: relay.jobId,
			stale: relay.stale,
			text: relay.text,
			paths: relay.paths,
		}),
	);
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	const receipt = await bridge.send("ESCALATE STALE please");
	assert.equal(receipt.level, "owner_observed");
	const escalations = relays.filter((relay) => relay.kind === "escalation");
	assert.equal(escalations.length, 1, JSON.stringify(relays));
	assert.equal(escalations[0]?.id, "es-0001");
	assert.equal(escalations[0]?.jobId, "cp-job");
	assert.equal(escalations[0]?.stale, true);
	assert.ok(escalations[0]?.paths.some((path) => path.endsWith("artifact.md")));
	assert.equal(escalations[0]?.text.includes("# "), false);
});

test("a refused cp_escalate tool call is an error notice, never keyed by its raw tool call id", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("REFUSE_ESCALATION");
	assert.equal(relays.some((relay) => relay.kind === "escalation" || relay.escalationId === "call_raw-id"), false);
	assert.ok(relays.some((relay) => relay.kind === "error" && relay.text.includes("option consequence exceeds schema cap")));
});

test("a refused cp_escalate followed by a successful call in the same parent turn relays only the escalation", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => { await bridge.stop(); home.cleanup(); });
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("RETRY_ESCALATION");
	assert.equal(relays.some((relay) => relay.kind === "error"), false, JSON.stringify(relays));
	assert.deepEqual(relays.filter((relay) => relay.kind === "escalation").map((relay) => relay.escalationId), ["es-0001"]);
});

test("a deliberately failing fake-parent test leaves no parent or descendant pid", { skip: process.platform !== "linux" && "cleanup requires Linux procfs identity checks" }, (t) => {
	const dir = scratch();
	const pidFile = join(dir, "pids");
	t.after(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
	const failureTest = resolve(import.meta.dirname, "fixtures", "fake-parent-failure.ts");
	const env: NodeJS.ProcessEnv = { ...process.env, FAKE_PARENT_PID_FILE: pidFile };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-force-exit", failureTest], { encoding: "utf8", env, timeout: 15_000 });
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1, output); // The intentional failure must still fail the child run.
	assert.match(output, /^ok \d+ - afterEach removed the failed subtest's fake-parent processes$/m);
});

test("H6: a dispatch or pipeline advance carrying a risk_warning wakes the main session with that one line; a result without one relays nothing", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const wakes: Array<{ jobId?: string; text: string }> = [];
	bridge.onRelay((relay) => {
		if (relay.kind === "wake" && relay.text.includes("risk:high inferred")) wakes.push({ jobId: relay.jobId, text: relay.text });
	});
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 });
	await bridge.send("RISKWARN");
	assert.deepEqual(wakes.map((wake) => wake.jobId), ["cp-h6", "cp-h6p"], JSON.stringify(wakes));
	assert.match(wakes[0]?.text ?? "", /cp-h6: warning: risk:high inferred from keywords only \(delete\)/);
});

test("killing the parent relaunches the same session once and does not replay sends", async (t) => {
	const home = createScratchHome();
	const dir = scratch();
	const argvFile = join(dir, "argv");
	const promptFile = join(dir, "prompts");
	process.env.FAKE_PARENT_ARGV = argvFile;
	process.env.FAKE_PARENT_PROMPTS = promptFile;
	const bridge = new CpBridge();
	const notices: string[] = [];
	bridge.onRelay((relay) => {
		if (relay.kind === "relaunch") notices.push(relay.text);
	});
	t.after(async () => {
		delete process.env.FAKE_PARENT_ARGV;
		delete process.env.FAKE_PARENT_PROMPTS;
		await bridge.stop();
		home.cleanup();
	});
	const started = await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	await bridge.send("mandate once");
	const pid = bridge.status().pid;
	assert.equal(typeof pid, "number");
	process.kill(pid as number, "SIGKILL");
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const count = readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean).length;
		if (notices.length >= 1 && count >= 2 && bridge.status().alive) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.match(notices[0] ?? "", /relaunching same session/);
	assert.match(notices[0] ?? "", /reconcile/);
	assert.match(notices[0] ?? "", /not replayed/);
	const lines = readFileSync(argvFile, "utf8").trim().split("\n");
	assert.equal(lines.length, 2, lines.join("\n"));
	const first = JSON.parse(lines[0] ?? "[]") as string[];
	const second = JSON.parse(lines[1] ?? "[]") as string[];
	assert.equal(second[second.indexOf("--session") + 1], first[first.indexOf("--session") + 1]);
	assert.equal(second[second.indexOf("--session") + 1], started.sessionFile);
	const prompts = readFileSync(promptFile, "utf8").trim().split("\n");
	assert.deepEqual(prompts, ["mandate once"]);
	assert.equal(bridge.status().alive, true);
});

test("stop is an observed close and does not relaunch", async (t) => {
	const home = createScratchHome();
	const argvFile = join(scratch(), "argv-stop");
	process.env.FAKE_PARENT_ARGV = argvFile;
	const bridge = new CpBridge();
	const notices: string[] = [];
	bridge.onRelay((relay) => notices.push(relay.kind));
	t.after(() => {
		delete process.env.FAKE_PARENT_ARGV;
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
	});
	const exit = await bridge.stop();
	assert.equal(exit?.code, 0);
	assert.equal(bridge.status().alive, false);
	assert.equal(notices.includes("relaunch"), false);
	assert.equal(readFileSync(argvFile, "utf8").trim().split("\n").length, 1);
});

test("start refuses a live lock holder", async (t) => {
	const home = createScratchHome();
	const lock = acquireParentLock({ home: home.path });
	assert.equal(lock.ok, true);
	t.after(() => {
		if (lock.ok) lock.lock.release();
		home.cleanup();
	});
	const bridge = new CpBridge();
	await assert.rejects(
		bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT }),
		(error: unknown) => error instanceof CpBridgeError && /already holds/.test((error as Error).message),
	);
});

test("status lists open escalations from the store, not bodies", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
	});
	await new EscalationStore({ home: home.path }).raise({
		job_ids: ["cp-job"],
		kind: "product_ambiguity",
		question: "which copy?",
		options: [
			{ id: "approve", label: "approve", consequence: "proceed", cost: "none" },
			{ id: "decline", label: "decline", consequence: "stop", cost: "sunk" },
		],
		recommended: "approve",
		evidence_paths: ["state/runs/cp-job/artifact.md"],
	});
	const status = bridge.status();
	assert.equal(status.openEscalations.length, 1);
	assert.equal(status.openEscalations[0]?.question, "which copy?");
	assert.ok(status.paths.some((path) => path.endsWith(`${join("state", "runs", "cp-job", "artifact.md")}`)));
});

test("main session has no cp_dispatch or cp_integrate", { timeout: 60_000 }, async (t) => {
	const rpc = startRpc({
		cwd: scratch(),
		args: [...operatorPiArgs(PACKAGE_ROOT), "--no-session"],
	});
	t.after(() => rpc.close());
	rpc.send({ id: "cmds", type: "get_commands" });
	const commands = await rpc.waitFor((record) => record.type === "response" && record.id === "cmds");
	const names = ((commands.data as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []).map(
		(command) => command.name,
	);
	assert.ok(names.includes("cp-bridge"), names.join(","));
	assert.equal(names.includes("cp-version"), false);
	rpc.send({ id: "run", type: "prompt", message: "/cp-bridge" });
	const notify = await rpc.waitFor(
		(record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string",
	);
	const message = String(notify.message);
	assert.match(message, /cp_parent/);
	assert.equal(message.includes("cp_dispatch"), false);
	assert.equal(message.includes("cp_integrate"), false);
});

test("a turn whose assistant message ends in error yields turn_failed, never owner_observed, reply undefined", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	const receipt = await bridge.send("trigger ERROR please");
	assert.equal(receipt.level, "turn_failed");
	assert.deepEqual(receipt.reached, ["injected", "turn_settled", "turn_failed"]);
	assert.equal(receipt.reached.includes("owner_observed"), false);
	assert.equal(receipt.reply, undefined);
	assert.match(receipt.error ?? "", /404 model not found: gpt-5/);
});

test("a normal send turn yields owner_observed with only assistant text, never the echoed prompt", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	const receipt = await bridge.send("ship the widget");
	assert.equal(receipt.level, "owner_observed");
	assert.equal(receipt.reply, "reply: ship the widget");
	assert.equal(receipt.error, undefined);
});

test("H1: transient provider failure runs the outer ladder and resumes, never re-sending the original text", async (t) => {
	const home = createScratchHome();
	const promptLog = join(scratch(), "prompts");
	process.env.FAKE_PARENT_PROMPTS = promptLog;
	const bridge = new CpBridge();
	const delays: number[] = [];
	t.after(async () => {
		delete process.env.FAKE_PARENT_PROMPTS;
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
		outerRetrySleep: async (ms) => {
			delays.push(ms);
		},
	});
	const receipt = await bridge.send("trigger TRANSIENT please");
	assert.equal(receipt.level, "owner_observed");
	assert.match(receipt.reply ?? "", /^reply: /);
	// One outer-ladder attempt: the fake parent's TRANSIENT branch fails exactly
	// once, then the resumed prompt (which never contains TRANSIENT) succeeds.
	assert.deepEqual(delays, [5_000]);
	const prompts = readFileSync(promptLog, "utf8").trim().split("\n");
	assert.deepEqual(prompts, [
		"trigger TRANSIENT please",
		"The previous turn failed with a transient provider error. Continue where you left off \u2014 do not repeat the original task or brief, and do not redo actions you already completed.",
	]);
});

test("H1 review: a persistently transient failure runs the ladder to its full cap of 5, and never trips the 3-consecutive-turn_failed relaunch", async (t) => {
	const home = createScratchHome();
	process.env.FAKE_PARENT_TRANSIENT_ALWAYS = "1";
	const bridge = new CpBridge();
	const relays: string[] = [];
	bridge.onRelay((relay) => relays.push(`${relay.kind}:${relay.text}`));
	const delays: number[] = [];
	t.after(async () => {
		delete process.env.FAKE_PARENT_TRANSIENT_ALWAYS;
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
		outerRetrySleep: async (ms) => {
			delays.push(ms);
		},
	});
	const receipt = await bridge.send("trigger a transient failure");
	// Never recovers: the ladder runs its full 5 attempts and stays turn_failed.
	assert.equal(receipt.level, "turn_failed");
	assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000]);
	// H1 review, finding 3: one send that retried 5 times spends exactly ONE
	// toward the 3-consecutive-turn_failed relaunch cap \u2014 never a relaunch here.
	const relaunches = relays.filter((line) => line.startsWith("relaunch:"));
	assert.equal(relaunches.length, 0, JSON.stringify(relays));
	// H1 review, finding 2: the parent's own outer-ladder journal, since the
	// bridge keeps no other durable run log.
	const journal = readFileSync(join(home.path, LAYOUT.state, "bridge-retry.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const attempts = journal.filter((line) => line.event === "outer_retry_attempt");
	assert.equal(attempts.length, 5);
	assert.deepEqual(
		attempts.map((line) => line.attempt),
		[1, 2, 3, 4, 5],
	);
	const exhausted = journal.find((line) => line.event === "outer_retry_exhausted");
	assert.ok(exhausted, "exhaustion journaled");
	assert.equal(exhausted.attempts, 5);

	// Two more ordinary failed sends now DO trip the cap: the ladder-exhausted
	// send above counted as exactly one.
	await bridge.send("trigger ERROR please");
	const receipt3 = await bridge.send("trigger ERROR please");
	assert.equal(receipt3.level, "turn_failed");
	const relaunchesAfter = relays.filter((line) => line.startsWith("relaunch:"));
	assert.equal(relaunchesAfter.length, 1, JSON.stringify(relays));
});

test("three consecutive turn_failed sends stop the parent and emit one relaunch relay", async (t) => {
	const home = createScratchHome();
	const bridge = new CpBridge();
	const relays: string[] = [];
	bridge.onRelay((relay) => relays.push(`${relay.kind}:${relay.text}`));
	t.after(async () => {
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
	});
	for (let i = 0; i < 3; i += 1) {
		const receipt = await bridge.send("trigger ERROR please");
		assert.equal(receipt.level, "turn_failed");
	}
	const relaunches = relays.filter((line) => line.startsWith("relaunch:"));
	assert.equal(relaunches.length, 1, JSON.stringify(relays));
	assert.match(relaunches[0] ?? "", /3 turns in a row/);
	assert.match(relaunches[0] ?? "", /404 model not found: gpt-5/);
});

test("resolveParentModel: env, then session, then refusal naming both options", () => {
	assert.equal(resolveParentModel({ CP_PARENT_MODEL: "anthropic/claude" }, "openai/gpt"), "anthropic/claude");
	assert.equal(resolveParentModel({}, "openai/gpt"), "openai/gpt");
	assert.equal(resolveParentModel({ PI_PROVIDER: "openai", PI_MODEL: "gpt" }), "openai/gpt");
	assert.throws(
		() => resolveParentModel({}),
		(error: unknown) =>
			error instanceof CpBridgeError && /CP_PARENT_MODEL/.test((error as Error).message) && /own model/.test((error as Error).message),
	);
});

test("parentEnv: CP_GATEWAY_ADMIN_KEY from the env first, else gateway.env only with capacity.json and a 0600 file; workers never get it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-bridge-gateway-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "home");
	const base = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), PATH: "/usr/bin" };
	const keyFile = join(dir, "config/pi-command-post/gateway.env");
	mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
	writeFileSync(keyFile, "CP_GATEWAY_ADMIN_KEY=file-k3y\n", { mode: 0o600 });
	assert.equal(parentEnv(home, "multi", base).CP_GATEWAY_ADMIN_KEY, undefined, "no capacity.json: not loaded");
	const data = join(home, layoutForHome("multi", home).data);
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "capacity.json"), "{}");
	assert.equal(parentEnv(home, "multi", base).CP_GATEWAY_ADMIN_KEY, "file-k3y");
	assert.equal(parentEnv(home, "multi", { ...base, CP_GATEWAY_ADMIN_KEY: "env-k3y" }).CP_GATEWAY_ADMIN_KEY, "env-k3y", "the env wins");
	const env = parentEnv(home, "multi", base);
	assert.equal(workerEnvironment({ jobId: "cp-x", kind: "ship", delivery: "pr", runDir: join(dir, "run"), worktree: join(dir, "wt") }, { home, parentEnv: env }).CP_GATEWAY_ADMIN_KEY, undefined, "workers never carry it");

	chmodSync(keyFile, 0o644);
	const stderr: string[] = [];
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
	try {
		assert.equal(parentEnv(home, "multi", base).CP_GATEWAY_ADMIN_KEY, undefined, "a group/other-readable file is refused");
	} finally {
		process.stderr.write = write;
	}
	assert.equal(stderr.length, 1, stderr.join(""));
	assert.match(stderr[0] ?? "", /chmod 600/);
	assert.ok(!stderr.join("").includes("file-k3y"), "never the value");
});

test("requireAvailableParentModel refuses an unknown model before spawn, naming known models", () => {
	assert.equal(requireAvailableParentModel("mock/known", ALWAYS_AVAILABLE), undefined);
	const probe = registryProbe({
		find: (provider, modelId) => (provider === "mock" && modelId === "known" ? { id: "known", provider: "mock" } : undefined),
		hasConfiguredAuth: () => true,
		getAvailable: () => [{ id: "known", provider: "mock" }],
	});
	assert.throws(() => requireAvailableParentModel("openai/gpt-5", probe), (error: unknown) =>
		error instanceof CpBridgeError && /gpt-5/.test((error as Error).message) && /mock\/known/.test((error as Error).message),
	);
});

// Durable operator→parent delivery (src/parent-outbox.ts).

test("a send that outlasts the wait returns pending, then relays its reply once by id", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = await ctx.open();
	const hang = await bridge.send("HANG x", 200);
	assert.equal(hang.level, "injected");
	assert.ok(hang.send_id);
	assert.equal(hang.pending, hang.send_id);
	assert.equal(hang.error, undefined);
	const release = await bridge.send("RELEASE");
	assert.equal(release.level, "owner_observed");
	assert.equal(release.reply, "reply: RELEASE");
	const relays = ctx.sendRelays(hang.send_id);
	assert.equal(relays.length, 1, JSON.stringify(ctx.relays));
	assert.equal(relays[0]?.text, "reply: HANG x");
	assert.equal(ctx.relays.filter((relay) => relay.kind === "send").length, 1, "the synchronous RELEASE is its own tool result");
	assert.equal(ctx.relays.some((relay) => relay.kind === "wake"), false);
	const id = hang.send_id as string;
	assert.equal(bridge.sendReceipt(id)?.level, "turn_settled");
	bridge.observe([{ customType: "cp-ci", details: { send_id: id } }, "junk"]);
	assert.equal(bridge.sendReceipt(id)?.level, "turn_settled", "only a cp-bridge relay observes a send");
	bridge.observe([{ customType: "cp-bridge", content: "x", details: { send_id: id } }]);
	assert.equal(bridge.sendReceipt(id)?.level, "owner_observed");
	assert.equal(bridge.confirmObserved(id), false, "observing twice is a no-op");
	assert.equal(bridge.status().sends.find((row) => row.id === id)?.level, "owner_observed");
});

test("a send is answered at its clean turn_end, before the run settles, and never relayed again", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = await ctx.open();
	const segment = await bridge.send("SEGMENT x", 2_000);
	assert.equal(segment.level, "owner_observed", JSON.stringify(segment));
	assert.equal(segment.reply, "reply: SEGMENT x");
	assert.equal(segment.pending, undefined);
	const release = await bridge.send("RELEASE");
	assert.equal(release.reply, "reply: RELEASE");
	assert.equal(ctx.sendRelays(segment.send_id).length, 0, JSON.stringify(ctx.relays));
	assert.equal(ctx.relays.some((relay) => relay.kind === "wake"), false, JSON.stringify(ctx.relays));
});

test("a wake answered at a clean turn_end relays before the run settles", async (t) => {
	const home = createScratchHome();
	Object.assign(process.env, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_SEGMENT: "1", FAKE_PARENT_WAKE_JOB: "cp-a1", FAKE_PARENT_WAKE_TEXT: "[demo-app] cp-a1: CI green" });
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => {
		for (const key of ["FAKE_PARENT_WAKE", "FAKE_PARENT_WAKE_SEGMENT", "FAKE_PARENT_WAKE_JOB", "FAKE_PARENT_WAKE_TEXT"]) delete process.env[key];
		await bridge.stop();
		home.cleanup();
	});
	await bridge.start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000 });
	await until(() => relays.some((relay) => relay.kind === "wake"), "the segment's wake relay");
	const wakes = relays.filter((relay) => relay.kind === "wake");
	assert.equal(wakes.length, 1, JSON.stringify(relays));
	assert.equal(wakes[0]?.text, "[demo-app] cp-a1: CI green");
	assert.deepEqual(wakes[0]?.jobIds, ["cp-a1"]);
	assert.equal(bridge.status().lastReplyAt !== undefined, true);
});

test("a follow-up lost with the parent is delivered once after relaunch", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = await ctx.open();
	const notices: string[] = [];
	bridge.onRelay((relay) => {
		if (relay.kind === "relaunch") notices.push(relay.text);
	});
	const lost = await bridge.send("NOLAND y", 200);
	assert.equal(lost.pending, lost.send_id);
	process.kill(bridge.status().pid as number, "SIGKILL");
	await until(() => ctx.sendRelays(lost.send_id).length > 0, "the redelivered send's relay");
	assert.equal(ctx.sendRelays(lost.send_id).length, 1);
	assert.equal(ctx.sendRelays(lost.send_id)[0]?.text, "reply: NOLAND y");
	assert.match(notices[0] ?? "", /1 undelivered send\(s\) are delivered once by id/);
	assert.equal(lines(ctx.files.ids).filter((id) => id === lost.send_id).length, 2, "one dead injection, one redelivery");
	assert.deepEqual(lines(ctx.files.prompts), ["NOLAND y"]);
});

test("a send that landed before death is never re-injected, only nudged", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = await ctx.open();
	const landed = await bridge.send("HANG z", 200);
	process.kill(bridge.status().pid as number, "SIGKILL");
	await until(() => ctx.sendRelays(landed.send_id).length > 0, "the resumed send's relay");
	const prompts = lines(ctx.files.prompts);
	assert.equal(prompts.filter((line) => line === "HANG z").length, 1, prompts.join("\n"));
	assert.ok(prompts.some((line) => line.includes(`[cp-send ${landed.send_id} — resume]`)), prompts.join("\n"));
	assert.equal(bridge.sendReceipt(landed.send_id as string)?.level, "turn_settled");
});

test("a new bridge drains another bridge's pending sends", async (t) => {
	const ctx = await outboxBridge(t);
	const first = await ctx.open();
	const pending = await first.send("NOLAND w", 200);
	assert.equal(pending.pending, pending.send_id);
	await first.stop();
	assert.equal(ctx.sendRelays(pending.send_id).length, 0);
	await ctx.open();
	await until(() => ctx.sendRelays(pending.send_id).length > 0, "the second bridge's relay");
	assert.equal(ctx.sendRelays(pending.send_id)[0]?.text, "reply: NOLAND w");
});

test("cp_parent stop discards never-landed sends with one relay", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = await ctx.open();
	const pending = await bridge.send("NOLAND v", 200);
	await bridge.stop({ discardPending: true });
	const relays = ctx.sendRelays(pending.send_id);
	assert.equal(relays.length, 1, JSON.stringify(ctx.relays));
	assert.match(relays[0]?.text ?? "", /not delivered \(parent stopped by the operator\)/);
	assert.equal(bridge.status().sends.find((row) => row.id === pending.send_id)?.state, "undeliverable");
	await assert.rejects(bridge.send("after stop"), CpBridgeError);
});

test("a corrupt send outbox refuses the start, naming the file", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, LAYOUT.sessions, "cp-parent.sends.json");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "{ nope", "utf8");
	await assert.rejects(
		new CpBridge().start({ home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT }),
		(error: unknown) => (error as Error).message.includes(file),
	);
});

test("the outer retry ladder runs in the background under the same send id: pending now, one relay later", async (t) => {
	const ctx = await outboxBridge(t);
	const bridge = new CpBridge();
	bridge.onRelay((relay) => ctx.relays.push(relay));
	const delays: number[] = [];
	t.after(() => bridge.stop());
	await bridge.start({
		home: ctx.home,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		outerRetrySleep: (ms) => {
			delays.push(ms);
			return new Promise((resolve) => setTimeout(resolve, 400));
		},
	});
	const started = Date.now();
	const receipt = await bridge.send("trigger TRANSIENT please", 150);
	assert.ok(Date.now() - started < 2_000, "the caller never waits out the ladder");
	assert.equal(receipt.level, "injected");
	assert.equal(receipt.pending, receipt.send_id);
	assert.equal(receipt.error, undefined);
	await until(() => ctx.sendRelays(receipt.send_id).length > 0, "the resumed send's relay");
	await new Promise((resolve) => setTimeout(resolve, 200));
	const relays = ctx.sendRelays(receipt.send_id);
	assert.equal(relays.length, 1, JSON.stringify(ctx.relays));
	assert.equal(relays[0]?.receipt.level, "turn_settled");
	assert.match(relays[0]?.text ?? "", /^reply: The previous turn failed with a transient provider error/);
	assert.equal(ctx.relays.filter((relay) => relay.kind === "send").length, 1);
	assert.deepEqual(delays, [5_000]);
	// Same id both times: the resume nudge carries the original send's marker.
	assert.deepEqual(lines(ctx.files.ids), [receipt.send_id, receipt.send_id]);
	assert.equal(lines(ctx.files.prompts)[0], "trigger TRANSIENT please");
	const journal = lines(join(ctx.home, LAYOUT.state, "bridge-retry.jsonl")).map((line) => JSON.parse(line) as { event: string; send_id?: string });
	assert.deepEqual(journal.map((line) => [line.event, line.send_id]), [
		["outer_retry_attempt", receipt.send_id],
		["outer_retry_succeeded", receipt.send_id],
	]);
});

test("a restarted bridge continues a send's persisted transient budget: remaining delays only, then one failed receipt", async (t) => {
	const home = createScratchHome();
	process.env.FAKE_PARENT_TRANSIENT_ALWAYS = "1";
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	const delays: number[] = [];
	t.after(async () => {
		delete process.env.FAKE_PARENT_TRANSIENT_ALWAYS;
		await bridge.stop();
		home.cleanup();
	});
	// Left by a dead bridge: landed, two transient retries already spent.
	mkdirSync(join(home.path, LAYOUT.sessions), { recursive: true });
	const box = new ParentSendOutbox({ file: join(home.path, LAYOUT.sessions, "cp-parent.sends.json") });
	const entry = box.enqueue("seeded before the restart");
	box.markInjected([entry.id]);
	box.markLanded([entry.id]);
	box.reserveOuterRetry(entry.id, 5);
	box.reserveOuterRetry(entry.id, 5);
	await bridge.start({
		home: home.path,
		mode: "multi",
		model: "mock/parent",
		piBin: FAKE_PARENT,
		requestTimeoutMs: 5_000,
		settleTimeoutMs: 5_000,
		outerRetrySleep: async (ms) => {
			delays.push(ms);
		},
	});
	await until(() => relays.some((relay) => relay.kind === "send" && relay.sendId === entry.id), "the final relay");
	assert.deepEqual(delays, [20_000, 40_000, 80_000], "attempts 3-5 only: the spent two are not replayed");
	const final = new ParentSendOutbox({ file: box.file }).get(entry.id);
	assert.equal(final?.state, "failed");
	assert.equal(final?.outer_retry_attempts, 5);
	assert.equal(relays.filter((relay) => relay.kind === "send").length, 1);
});

// Parent host (src/parent-host.ts): a detached child owns the parent; clients attach over a private socket.

const HOST_MODULE = resolve(import.meta.dirname, "..", "src", "parent-host.ts");

/** A scratch home whose host, if any is left running, is stopped by its own `stop` op after the test. */
function hostHome(t: import("node:test").TestContext, env: Record<string, string> = {}) {
	const home = createScratchHome();
	Object.assign(process.env, env); // the host inherits the environment of the attach that spawns it
	const paths = parentHostPaths(home.path, "multi");
	const clients: ParentHostClient[] = [];
	const attach = async (timeoutMs?: number) => {
		// A host boots a fresh node with the whole module graph: slow on a loaded runner.
		const client = await attachParentHost({ home: home.path, mode: "multi", timeoutMs: timeoutMs ?? 60_000 });
		clients.push(client);
		return client;
	};
	const startOptions = { home: home.path, mode: "multi", model: "mock/parent", piBin: FAKE_PARENT, requestTimeoutMs: 5_000, settleTimeoutMs: 5_000 };
	t.after(async () => {
		for (const key of Object.keys(env)) delete process.env[key];
		for (const client of clients) client.disconnect();
		const { record } = currentHost(paths);
		if (record && isPidAlive(record.pid)) {
			const client = await ParentHostClient.connect(record, 30_000).catch(() => undefined);
			await client?.request("stop").catch(() => undefined);
			if (client) await Promise.race([client.closed, new Promise((done) => setTimeout(done, 10_000))]); // a failed stop never closes
			client?.disconnect();
			// This test's own host: never leave it running once its home is gone.
			if (isPidAlive(record.pid)) process.kill(record.pid, "SIGKILL");
		}
		home.cleanup();
	});
	const start = (client: ParentHostClient) => client.request("start", startOptions) as Promise<{ already: boolean; pid?: number }>;
	return { home: home.path, paths, attach, start, startOptions };
}

test("operator diagnostics use the live parent's commands without creating work", { timeout: 180_000 }, async (t) => {
	const previousPiHome = process.env.PI_HOME;
	process.env.PI_HOME = scratch();
	t.after(() => { if (previousPiHome === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previousPiHome; });
	const ctx = hostHome(t);
	const client = await ctx.attach();
	for (const action of ["doctor", "version"]) {
		await assert.rejects(client.request(action), /parent is not running/);
	}
	const started = await client.request("start", { ...ctx.startOptions, model: "openai/gpt-4o", piBin: "pi", requestTimeoutMs: 90_000 }) as { pid: number };
	const tools = new Map<string, {
		parameters: { properties: { action: { enum: string[] } } };
		execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;
	}>();
	const shutdown: Array<() => unknown> = [];
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: (event: string, handler: () => unknown) => { if (event === "session_shutdown") shutdown.push(handler); },
		sendMessage: () => assert.fail("diagnostics must not trigger a model turn"),
	} as never);
	const targetEnv = { PI_HOME: process.env.PI_HOME };
	t.after(async () => {
		for (const close of shutdown) await close();
		clearOperatorTarget({ home: ctx.home, mode: "multi", hostPid: client.hostPid, parentPid: started.pid }, targetEnv);
	});
	const tool = tools.get("cp_parent")!;
	for (const action of ["doctor", "version"]) assert.ok(tool.parameters.properties.action.enum.includes(action));
	assert.equal(tools.has("cp_dispatch"), false);
	const target = { home: ctx.home, mode: "multi" as const, hostPid: client.hostPid, parentPid: started.pid };
	saveOperatorTarget(target);
	const snapshot = () => Object.fromEntries([LAYOUT.data, LAYOUT.state].flatMap((dir) =>
		readdirSync(join(ctx.home, dir), { recursive: true, encoding: "utf8" })
			.filter((file) => /(?:jobs|fleet|mandates|decisions|sends)\.json$/.test(file))
			.map((file) => [join(dir, file), readFileSync(join(ctx.home, dir, file), "utf8")])));
	const before = snapshot();
	const openedAsk = await tool.execute("ask", { action: "ask", ask: { project: "example", question: "Proceed?", options: [{ label: "yes", consequence: "Continue" }], recommendation: "yes" } });
	const askId = openedAsk.details.id;
	assert.match(String(askId), /^ask-/);
	const askStatus = await tool.execute("ask-status", { action: "status" });
	assert.deepEqual((askStatus.details.asks as Array<{ id: string }>).map((ask) => ask.id), [askId]);
	const unknownAsk = await tool.execute("unknown-ask", { action: "ask_answer", id: "ask-unknown", answer: "yes" });
	assert.equal(unknownAsk.isError, true);
	await tool.execute("answer", { action: "ask_answer", id: askId, answer: "  Yes.  " });
	const withdrawnAsk = await tool.execute("ask-again", { action: "ask", ask: { project: "example", question: "Again?", options: [{ label: "no", consequence: "Stop" }], recommendation: "no" } });
	await tool.execute("withdraw", { action: "ask_withdraw", id: withdrawnAsk.details.id, reason: "Obsolete" });
	assert.deepEqual((await tool.execute("closed-asks", { action: "status" })).details.asks, []);
	assert.deepEqual(snapshot(), before, "ask bookkeeping does not create authority or send to the parent");
	const version = await tool.execute("version", { action: "version" });
	assert.match(version.content[0]!.text, /^pi-command-post \S+ \(root: /);
	assert.ok(version.content[0]!.text.includes(`multi-project mode, home ${ctx.home}`));
	assert.equal(version.details.text, version.content[0]!.text);
	assert.equal(version.details.level, "info");
	const doctor = await tool.execute("doctor", { action: "doctor" });
	assert.match(doctor.content[0]!.text, /^DOCTOR (ok|BROKEN)/);
	assert.ok(doctor.content[0]!.text.includes(`home: ${ctx.home}`));
	assert.match(doctor.content[0]!.text, /parent lock held by this session/);
	assert.match(doctor.content[0]!.text, /session: rpc/);
	assert.equal(doctor.details.text, doctor.content[0]!.text);
	assert.equal(doctor.isError, doctor.details.level === "error");
	assert.deepEqual(snapshot(), before, "no job, worker, mandate, decision or durable send created");
	// Graceful drain through the real host and parent: /cp-drain writes the flag and answers at once.
	const drainStarted = Date.now();
	const drained = await tool.execute("drain", { action: "drain", timeout_s: 0 });
	assert.match(drained.content[0]!.text, /^DRAIN: drained: safe to restart/, "no worker is mid-turn, so the answer is the one report");
	assert.ok(Date.now() - drainStarted < 30_000, "the drain handler never waits out its timeout");
	assert.equal(existsSync(join(ctx.home, LAYOUT.state, "drain.json")), true);
	assert.equal(drained.isError, false);
	assert.equal((await client.request("status") as { pid: number }).pid, started.pid);
	const targetFile = operatorTargetFile(ctx.home);
	const savedTarget = readFileSync(targetFile, "utf8");
	const generation = currentHost(ctx.paths).gen;
	await client.request("stop");
	await client.closed;
	const unavailable = await tool.execute("unavailable", { action: "doctor" });
	assert.equal(unavailable.isError, true);
	assert.match(unavailable.content[0]!.text, /parent.*(not running|unavailable|closed)/);
	assert.equal(readFileSync(targetFile, "utf8"), savedTarget, "diagnostics do not retire a stale target");
	assert.equal(currentHost(ctx.paths).gen, generation, "diagnostics do not replace a stopped host");
});

for (const outcome of ["missing", "error", "silent", "rejected"]) {
	test(`parent diagnostics fail explicitly when the command is ${outcome}`, async (t) => {
		const prompts = join(scratch(), "prompts");
		const ctx = hostHome(t, { FAKE_PARENT_DIAGNOSTIC: outcome, FAKE_PARENT_PROMPTS: prompts });
		const client = await ctx.attach();
		await ctx.start(client);
		for (const action of ["doctor", "version"]) {
			let failure = /diagnostic fixture failure/;
			if (outcome === "missing") failure = /not registered/;
			else if (outcome === "silent") failure = /no diagnostic output/;
			await assert.rejects(client.request(action), failure);
		}
		assert.deepEqual(lines(prompts), [], "a missing or failed diagnostic never falls through to a model prompt");
	});
}

test("parent host: the parent and its live worker outlive the operator process that started them", async (t) => {
	const workerFile = join(scratch(), "worker-pid");
	const ctx = hostHome(t, { FAKE_PARENT_WORKER_PID_FILE: workerFile });
	const script = [
		`import { attachParentHost } from ${JSON.stringify(HOST_MODULE)};`,
		`const client = await attachParentHost({ home: ${JSON.stringify(ctx.home)}, mode: "multi", timeoutMs: 60000 });`,
		`const started = await client.request("start", ${JSON.stringify(ctx.startOptions)});`,
		`console.log(JSON.stringify({ host: client.hostPid, parent: started.pid }));`,
		"setInterval(() => {}, 1000);",
	].join("\n");
	const operator = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => { if (operator.exitCode === null && operator.signalCode === null) operator.kill("SIGKILL"); });
	let out = "";
	operator.stdout.on("data", (chunk) => { out += String(chunk); });
	await until(() => out.includes("\n") || operator.exitCode !== null, "the operator's start line", 90_000);
	const { host, parent } = JSON.parse(out) as { host: number; parent: number };
	operator.kill("SIGKILL"); // an operator relaunch
	await once(operator, "close");
	const worker = Number(readFileSync(workerFile, "utf8"));
	assert.ok(isPidAlive(host), "host outlives the operator");
	assert.ok(isPidAlive(parent), "parent outlives the operator");
	assert.ok(isPidAlive(worker), "live worker outlives the operator");
	const { gen, record } = currentHost(ctx.paths);
	assert.equal(record?.pid, host);
	assert.equal(statSync(ctx.paths.socket(gen)).mode & 0o777, 0o600);
	assert.equal(statSync(ctx.paths.record(gen)).mode & 0o777, 0o600);
	const client = await ctx.attach();
	assert.deepEqual([client.hostPid, client.parentPid], [host, parent]);
	assert.equal(((await client.request("send", "after relaunch")) as BridgeReceipt).reply, "reply: after relaunch");
	await assert.rejects(ParentHostClient.connect({ ...record!, token: "0".repeat(64) }), /unauthenticated/);
	const exit = (await client.request("stop")) as WorkerExit;
	assert.equal(exit.code, 0, "stop observes the parent's close");
	await client.closed;
	await until(() => !isPidAlive(host) && !isPidAlive(parent), "host and parent exit");
	assert.equal(existsSync(ctx.paths.socket(gen)), false, "the host removed its socket");
	assert.equal(currentHost(ctx.paths).gen, gen, "its record stays, superseded by the next host, never deleted");
});

test("cp_parent delegated send crosses the host socket and stamps the injected message", { timeout: 90_000 }, async (t) => {
	const oldPiHome = process.env.PI_HOME;
	const oldPiBin = process.env.CP_PARENT_PI_BIN;
	const oldSession = process.env.PI_SESSION_FILE;
	process.env.PI_HOME = scratch();
	process.env.CP_PARENT_PI_BIN = FAKE_PARENT;
	const operatorSession = join(scratch(), "operator-session.jsonl");
	process.env.PI_SESSION_FILE = operatorSession;
	t.after(() => {
		if (oldPiHome === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = oldPiHome;
		if (oldPiBin === undefined) delete process.env.CP_PARENT_PI_BIN; else process.env.CP_PARENT_PI_BIN = oldPiBin;
		if (oldSession === undefined) delete process.env.PI_SESSION_FILE; else process.env.PI_SESSION_FILE = oldSession;
	});
	const ctx = hostHome(t);
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }>();
	const shutdown: Array<() => unknown> = [];
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: (event: string, handler: () => unknown) => { if (event === "session_shutdown") shutdown.push(handler); },
		sendMessage: () => {},
	} as never);
	t.after(async () => { for (const close of shutdown) await close(); });
	const tool = tools.get("cp_parent")!;
	const started = await tool.execute("start", { action: "start", home: ctx.home, mode: "multi", model: "mock/parent" });
	assert.match(started.content[0]!.text, /started pid=/);
	const receipt = await tool.execute("send", { action: "send", text: "approve this plan", delegated: true, delegation_rule: "standing approval" });
	assert.equal(receipt.details.level, "owner_observed");
	const session = started.details.sessionFile as string;
	const box = new ParentSendOutbox({ file: parentSendFile(session) });
	assert.equal(box.get(receipt.details.send_id as string)?.delegation_rule, "standing approval");
	const entries = lines(`${session}.fake-entries.jsonl`).map((line) => JSON.parse(line));
	const text = entries.at(-1).message.content[0].text;
	assert.deepEqual(operatorSendTexts(text), [{ text: "approve this plan", provenance: { delegation_rule: "standing approval", send_id: receipt.details.send_id } }]);
	// cp-sessions-operator-transcript-9giu: the operator session's own pi file, once, so the viewer can list it.
	assert.deepEqual(readOperatorSessions(join(ctx.home, LAYOUT.sessions)).map((row) => [row.id, row.file]), [["operator-session.jsonl", operatorSession]], "start and send record the same file once, never twice");
});

test("cp_parent starts again immediately after stopping the host", { timeout: 90_000 }, async (t) => {
	const previousPiBin = process.env.CP_PARENT_PI_BIN;
	process.env.CP_PARENT_PI_BIN = FAKE_PARENT;
	t.after(() => { if (previousPiBin === undefined) delete process.env.CP_PARENT_PI_BIN; else process.env.CP_PARENT_PI_BIN = previousPiBin; });
	const ctx = hostHome(t);
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	} as never);
	const tool = tools.get("cp_parent")!;
	const invoke = (action: string, extra: Record<string, unknown> = {}) => tool.execute("call", {
		action,
		...(action === "start" ? { home: ctx.home, model: "mock/parent" } : {}),
		...extra,
	});
	// No mode: cp_parent start defaults to multi (cp-8knh).
	assert.match((await invoke("start")).content[0]!.text, /started pid=/);
	assert.match((await invoke("stop")).content[0]!.text, /stopped code=0/);
	// An explicit mode: "multi" is accepted unchanged.
	assert.match((await invoke("start", { mode: "multi" })).content[0]!.text, /started pid=/);
});

test("cp_parent start wiring: data/parent.json model beats CP_PARENT_MODEL; an explicit model is sent as modelExplicit and beats the file", { timeout: 90_000 }, async (t) => {
	const argvFile = join(scratch(), "argv");
	const ctx = hostHome(t, { CP_PARENT_PI_BIN: FAKE_PARENT, FAKE_PARENT_ARGV: argvFile, CP_PARENT_MODEL: "mock/env" });
	mkdirSync(join(ctx.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(ctx.home, LAYOUT.data, "parent.json"), JSON.stringify({ compact_at_tokens: 1000, model: "mock/file" }));
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	} as never);
	const tool = tools.get("cp_parent")!;
	const modelArg = () => { const argv = JSON.parse(lines(argvFile).at(-1)!) as string[]; return argv[argv.indexOf("--model") + 1]; };
	assert.match((await tool.execute("call", { action: "start", home: ctx.home })).content[0]!.text, /started pid=/);
	assert.equal(modelArg(), "mock/file");
	assert.match((await tool.execute("call", { action: "stop" })).content[0]!.text, /stopped code=0/);
	rmSync(join(ctx.home, LAYOUT.sessions, "cp-parent-control.json"), { force: true });
	assert.match((await tool.execute("call", { action: "start", home: ctx.home, model: "mock/explicit" })).content[0]!.text, /started pid=/);
	assert.equal(modelArg(), "mock/explicit", "explicit beats the file (no saved control model in the way)");
	assert.match((await tool.execute("call", { action: "stop" })).content[0]!.text, /stopped code=0/);
	rmSync(join(ctx.home, LAYOUT.sessions, "cp-parent-control.json"), { force: true });
	rmSync(join(ctx.home, LAYOUT.data, "parent.json"));
	assert.match((await tool.execute("call", { action: "start", home: ctx.home })).content[0]!.text, /started pid=/);
	assert.equal(modelArg(), "mock/env", "no file: resolveParentModel (CP_PARENT_MODEL), as before");
	assert.match((await tool.execute("call", { action: "stop" })).content[0]!.text, /stopped code=0/);
});

test("cp_parent start retires a dead saved target and attaches to the new live parent holding the lock", { timeout: 90_000 }, async (t) => {
	const previousPiHome = process.env.PI_HOME;
	process.env.PI_HOME = scratch();
	t.after(() => { if (previousPiHome === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previousPiHome; });
	const ctx = hostHome(t);
	const live = await ctx.attach();
	const started = await ctx.start(live);
	live.disconnect();
	// A generation-1 target left behind by a parent restart: both pids dead, the lock held by the new parent.
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.equal(isPidAlive(dead), false);
	saveOperatorTarget({ home: ctx.home, mode: "multi", hostPid: dead, parentPid: dead });
	const lock = acquireParentLock({ home: ctx.home, pid: started.pid }); // the fake parent takes no lock itself
	if (!lock.ok) throw new Error(`test parent lock acquisition failed: ${lock.reason}`);
	t.after(() => lock.lock.release());
	const tools = new Map<string, { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>();
	const shutdown: Array<() => unknown> = [];
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: (event: string, handler: () => unknown) => { if (event === "session_shutdown") shutdown.push(handler); },
		sendMessage: () => {},
	} as never);
	t.after(async () => { for (const close of shutdown) await close(); });
	const result = await tools.get("cp_parent")!.execute("start", { action: "start", home: ctx.home, mode: "multi", model: "mock/parent" });
	assert.equal(result.isError, undefined, result.content[0]!.text);
	assert.match(result.content[0]!.text, new RegExp(`^already running pid=${started.pid} `));
	assert.deepEqual(resolveOperatorTarget(ctx.home, "multi"), { home: ctx.home, mode: "multi", hostPid: live.hostPid, parentPid: started.pid });
});

test("parent host: concurrent attaches share one host and one parent, and mutations serialize", async (t) => {
	const argvFile = join(scratch(), "argv");
	const ctx = hostHome(t, { FAKE_PARENT_ARGV: argvFile });
	const [a, b] = await Promise.all([ctx.attach(), ctx.attach()]);
	assert.equal(a.hostPid, b.hostPid);
	const [first, second] = await Promise.all([ctx.start(a), ctx.start(b)]);
	assert.deepEqual([first.already, second.already].sort(), [false, true]);
	assert.equal(first.pid, second.pid);
	assert.equal(lines(argvFile).length, 1, "exactly one parent spawned");
	// Unserialized, the second set_model would meet the first's control-in-progress refusal.
	assert.deepEqual(await Promise.all([a.request("model", "mock/a"), b.request("model", "mock/b")]), [{ model: "mock/a" }, { model: "mock/b" }]);
	const sends = (await Promise.all([a.request("send", "from a"), b.request("send", "from b")])) as BridgeReceipt[];
	assert.deepEqual(sends.map((receipt) => receipt.reply), ["reply: from a", "reply: from b"]);
	const raw = createConnection(currentHost(ctx.paths).record!.socket);
	let replies = "";
	raw.on("data", (chunk) => { replies += String(chunk); });
	raw.write('null\n[]\n7\n"x"\nnot json\n');
	await until(() => replies.split("\n").filter(Boolean).length === 5, "five malformed-frame refusals");
	for (const reply of replies.trim().split("\n")) assert.match((JSON.parse(reply) as { error: string }).error, /not a JSON object/);
	raw.destroy();
	assert.equal(((await a.request("status")) as { alive: boolean }).alive, true, "malformed frames leave host and parent up");
	const third = await ctx.attach();
	assert.equal(third.hostPid, a.hostPid);
	assert.equal(third.parentPid, first.pid);
});

/** A record for generation `gen` naming a pid that has already exited, plus a leftover (non-socket) socket file. */
function staleHost(paths: ReturnType<typeof parentHostPaths>, gen: number): string {
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.equal(isPidAlive(dead), false);
	mkdirSync(paths.dir, { recursive: true });
	const stale = JSON.stringify({ version: 1, pid: dead, socket: paths.socket(gen), token: "stale", started_at: new Date().toISOString() });
	writeFileSync(paths.record(gen), stale);
	writeFileSync(paths.socket(gen), "");
	return stale;
}

test("parent host: a live lock without a matching host refuses; a stale socket is replaced only once host and lock pids are dead", async (t) => {
	const ctx = hostHome(t);
	const lock = acquireParentLock({ home: ctx.home });
	assert.equal(lock.ok, true);
	t.after(() => { if (lock.ok) lock.lock.release(); });
	await assert.rejects(ctx.attach(500), /already holds .* no matching responsive host/);
	assert.equal(currentHost(ctx.paths).gen, 0, "nothing was started");
	const stale = staleHost(ctx.paths, 1);
	await assert.rejects(ctx.attach(500), /already holds/);
	assert.equal(readFileSync(ctx.paths.record(1), "utf8"), stale, "a live lock keeps the stale record");
	assert.ok(existsSync(ctx.paths.socket(1)), "a live lock keeps the stale socket");
	if (lock.ok) lock.lock.release();
	writeFileSync(ctx.paths.record(1), JSON.stringify({ ...JSON.parse(stale), pid: process.pid }));
	await assert.rejects(ctx.attach(300), /alive but not answering/, "a live but silent host is never replaced");
	writeFileSync(ctx.paths.record(1), stale);
	const client = await ctx.attach();
	assert.equal(currentHost(ctx.paths).gen, 2, "the dead host is superseded, not overwritten");
	assert.equal(currentHost(ctx.paths).record?.pid, client.hostPid);
	assert.equal(existsSync(ctx.paths.record(1)) || existsSync(ctx.paths.socket(1)), false, "the superseded record and its dead socket are gone");
	assert.equal(statSync(ctx.paths.socket(2)).isSocket(), true);
});

test("parent host: racing attaches over a stale record start one host; a claim from a stale reading exits without touching it", async (t) => {
	const ctx = hostHome(t);
	staleHost(ctx.paths, 1);
	const clients = await Promise.all([ctx.attach(), ctx.attach(), ctx.attach(), ctx.attach()]);
	assert.equal(new Set(clients.map((client) => client.hostPid)).size, 1, "every attach joined the same host");
	const { gen, record } = currentHost(ctx.paths);
	assert.deepEqual([gen, record?.pid], [2, clients[0]?.hostPid]);
	assert.equal(existsSync(ctx.paths.record(3)), false, "no second host claimed a generation");
	// A slow attach that classified generation 1 as dead claims 2 (taken) or 1 (superseded): both exit 3.
	for (const claim of ["2", "1"]) {
		const late = spawnSync(process.execPath, [HOST_MODULE, ctx.home, "multi", claim], { timeout: 60_000 });
		assert.equal(late.status, 3, `claim ${claim}: ${String(late.stderr)}`);
	}
	assert.equal(currentHost(ctx.paths).record?.token, record?.token, "the live host's record is untouched");
	assert.equal(existsSync(ctx.paths.record(1)), false);
	const again = await ctx.attach();
	assert.equal(again.hostPid, record?.pid, "the live host still answers");
});

test("parent host: unobserved backlog survives reconnect, retaining stale annotations without replaying drained relays", async (t) => {
	// Unlike observed-send non-replay below, no client has subscribed when the wake arrives.
	const text = "STALE WAKE-UP — do not act on this (cp-anu7).\nIts contents are withheld. No promotion is requested.";
	const ctx = hostHome(t, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-anu7", FAKE_PARENT_WAKE_TEXT: text });
	const first = await ctx.attach();
	const started = await ctx.start(first);
	first.disconnect();
	await first.closed;
	const reconnected = await ctx.attach();
	const backlog: BridgeRelay[] = [];
	await reconnected.onRelay((relay) => backlog.push(relay));
	assert.equal(reconnected.parentPid, started.pid, "reconnect does not restart the parent");
	assert.equal(backlog.length, 1);
	assert.equal(backlog[0]?.kind, "wake");
	assert.equal(backlog[0]?.jobId, "cp-anu7");
	assert.equal(backlog[0]?.stale, true);
	assert.match(backlog[0]?.text ?? "", /STALE WAKE-UP/);
	assert.match(backlog[0]?.text ?? "", /contents are withheld/);
	reconnected.disconnect();
	await reconnected.closed;
	const third = await ctx.attach();
	const replayed: BridgeRelay[] = [];
	await third.onRelay((relay) => replayed.push(relay));
	assert.deepEqual(replayed, [], "a drained backlog is not delivered again");
});

test("parent host: withdrawal suppresses an escalation already queued for reconnect", async (t) => {
	const ctx = hostHome(t);
	const store = new EscalationStore({ home: ctx.home });
	await store.raise({
		job_ids: ["cp-job"], kind: "product_ambiguity", question: "ship?",
		options: [{ id: "hold", label: "Hold", consequence: "No merge", cost: "none" }],
		recommended: "hold", evidence_paths: [],
	});
	const data = store.read();
	data.items[0]!.id = "es-0001";
	writeFileSync(store.file, JSON.stringify(data));
	const first = await ctx.attach();
	await ctx.start(first);
	await first.request("send", "ESCALATE");
	await store.withdraw("es-0001");
	first.disconnect();
	await first.closed;
	const next = await ctx.attach();
	const backlog: BridgeRelay[] = [];
	await next.onRelay((relay) => backlog.push(relay));
	assert.equal(backlog.filter((relay) => relay.kind === "escalation").length, 0);
});

test("parent host: a current unobserved wake is delivered on subscribe after reconnect", async (t) => {
	const ctx = hostHome(t, { FAKE_PARENT_WAKE: "1", FAKE_PARENT_WAKE_JOB: "cp-current", FAKE_PARENT_WAKE_TEXT: "Current worker report received" });
	const first = await ctx.attach();
	await ctx.start(first);
	first.disconnect();
	await first.closed;
	const next = await ctx.attach();
	const backlog: BridgeRelay[] = [];
	await next.onRelay((relay) => backlog.push(relay));
	assert.equal(backlog.length, 1);
	assert.equal(backlog[0]?.stale, false);
	assert.match(backlog[0]?.text ?? "", /Current worker report received/);
});

test("parent host: a pending send survives its client's disconnect; stop observes the parent's close", async (t) => {
	const ctx = hostHome(t);
	const a = await ctx.attach();
	const started = await ctx.start(a);
	const targetEnv = { PI_HOME: scratch() };
	const target = { home: ctx.home, mode: "multi" as const, hostPid: a.hostPid, parentPid: started.pid as number };
	const fakeParentLock = acquireParentLock({ home: ctx.home, pid: started.pid });
	assert.equal(fakeParentLock.ok, true);
	if (!fakeParentLock.ok) throw new Error("test parent lock acquisition failed");
	saveOperatorTarget(target, targetEnv);
	assert.throws(() => assertOperatorTarget(target, { home: `${ctx.home}-other`, mode: "multi", hostPid: 0, parentPid: 0 }), /disconnect before starting/);
	const hang = (await a.request("send", "HANG x", 200)) as BridgeReceipt;
	assert.equal(hang.pending, hang.send_id);
	a.disconnect();
	await a.closed;
	const resolved = resolveOperatorTarget(undefined, undefined, { ...targetEnv, CP_HOME: `${ctx.home}-other` }, `${ctx.home}-other`);
	assert.deepEqual(resolved, target);
	validateOperatorTarget(resolved);
	const b = await ctx.attach();
	const relays: BridgeRelay[] = [];
	await b.onRelay((relay) => relays.push(relay));
	assert.equal(((await b.request("status")) as { pid?: number }).pid, started.pid);
	assert.equal(((await b.request("sendReceipt", hang.send_id)) as BridgeReceipt).level, "injected");
	assert.equal(((await b.request("send", "RELEASE")) as BridgeReceipt).reply, "reply: RELEASE");
	await until(() => relays.some((relay) => relay.kind === "send" && relay.sendId === hang.send_id), "the pending send's relay");
	assert.equal(relays.find((relay) => relay.sendId === hang.send_id)?.text, "reply: HANG x");
	await b.request("observe", [{ customType: "cp-bridge", details: { send_id: hang.send_id } }]);
	assert.equal(((await b.request("sendReceipt", hang.send_id)) as BridgeReceipt).level, "owner_observed");
	const parent = b.parentPid as number;
	await assert.rejects(b.request("stop", "nope"), /stop options must be an object/);
	assert.equal(((await b.request("status")) as { alive: boolean; pid?: number }).pid, parent, "a refused stop leaves the parent up");
	assert.equal(((await b.request("send", "still here")) as BridgeReceipt).reply, "reply: still here", "and the host usable");
	b.disconnect();
	await b.closed;
	const c = await ctx.attach();
	const replayed: BridgeRelay[] = [];
	await c.onRelay((relay) => replayed.push(relay));
	assert.equal(replayed.some((relay) => relay.sendId === hang.send_id), false, "observed send is not replayed to a reconnected client");
	const exit = (await c.request("stop", { discardPending: true })) as WorkerExit;
	assert.equal(exit.code, 0);
	clearOperatorTarget(target, targetEnv);
	fakeParentLock.lock.release();
	await c.closed;
	await until(() => !isPidAlive(c.hostPid) && !isPidAlive(parent), "host and parent exit");
	await assert.rejects(c.request("status"), /connection closed/);
});

test("observe sends only cp-bridge send-id stubs, never a whole oversized context", () => {
	const id = "ps-20260925172151-981ad077";
	const huge = { role: "toolResult", content: [{ type: "text", text: "x".repeat(2_000_000) }] };
	const relay = { customType: "cp-bridge", content: "y".repeat(10_000), details: { send_id: id } };
	const stubs = observedSendStubs([huge, relay, { customType: "cp-bridge", details: {} }, null]);
	assert.deepEqual(stubs, [{ customType: "cp-bridge", details: { send_id: id } }]);
	assert.ok(JSON.stringify(stubs).length < 200);
	assert.deepEqual(observedSendStubs("not an array"), []);
});
