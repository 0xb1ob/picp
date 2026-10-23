import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, startPiChild } from "../harness/index.ts";
import { LAYOUT } from "../../src/contracts.ts";

test("S26: RPC drain names its cause, refuses invalid arguments and clears on restart", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	let sequence = 0;
	const agent = createAgentDir({ provider });
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const start = () => {
		const model = provider.addScript(`s26-drain-${++sequence}`, [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
		agent.writeModels(provider);
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	const child = start();
	const command = async (text: string) => {
		const before = child.records().length;
		await child.prompt(text);
		return String((await child.waitFor((r) => child.records().indexOf(r) >= before && r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("DRAIN:"), 30_000)).message);
	};
	for (const bad of ["abc", "-1", "30 junk", "30 auto-update xyz", "30 auto-update abcdef0 extra", "cancel now"]) {
		assert.match(await command(`/cp-drain ${bad}`), /refused:.*usage:/);
	}
	assert.match(await command("/cp-drain 30"), /drained: safe to restart/);
	assert.match(await command("/cp-drain status"), /cause: manual \/cp-drain/);
	assert.match(await command("/cp-drain cancel"), /refused: this parent drained/);
	const file = join(home.path, LAYOUT.state, "drain.json");
	assert.equal(existsSync(file), true);
	await child.close();
	const restarted = start();
	await restarted.prompt("/cp-drain status");
	await restarted.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("DRAIN:"), 30_000);
	assert.equal(existsSync(file), false, "fresh parent clears the drain before accepting commands");
	await restarted.close();
	const damaged = createScratchHome();
	t.after(() => damaged.cleanup());
	const brokenFile = join(damaged.path, LAYOUT.state, "drain.json");
	mkdirSync(join(damaged.path, LAYOUT.state), { recursive: true });
	writeFileSync(brokenFile, JSON.stringify({ state: "drained", started_at: "2020-01-01T00:00:00Z", finished_at: "2020-01-01T00:00:01Z", deadline: "x", timeout_s: 1, jobs: [], reported: true }));
	writeFileSync(join(damaged.path, LAYOUT.state, "schedules.json"), "{");
	const damagedModel = provider.addScript("s26-damaged", [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const broken = startPiChild({ cwd: damaged.path, model: damagedModel, env: { ...agent.env, CP_HOME: damaged.path }, extensions: [COMMAND_POST_EXTENSION] });
	children.push(broken);
	await broken.prompt("/cp-drain status");
	await broken.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("DRAIN:"), 30_000);
	assert.equal(existsSync(brokenFile), false, "startup clears stale drain even when schedules cannot load");
	await broken.prompt("/cp-drain 1");
	assert.equal(existsSync(brokenFile), true);
	broken.send({ id: "s26-new", type: "new_session" });
	const switched = await broken.waitFor((r) => r.type === "response" && r.id === "s26-new", 30_000);
	assert.equal(switched.success, true, JSON.stringify(switched));
	assert.equal(existsSync(brokenFile), false, "a new session in the same process releases the previous session's drain");
});

test("S26: real bridge restart refuses unsupported sessions and restarts a persisted session", { timeout: 110_000 }, async (t) => {
	const { CP_BRIDGE_EXTENSION, waitFor } = await import("../harness/index.ts");
	const { controlRequest } = await import("../../src/viewer/control-api.ts");
	const { readControlRecord, controlConfigFile, controlJournalFile } = await import("../../src/viewer/control-files.ts");
	const { saveOperatorTarget } = await import("../../extensions/cp-bridge/index.ts");
	const { readFileSync, statSync } = await import("node:fs");
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const plainModel = provider.addScript("s26-plain", [{ kind: "text", text: "Ready." }]);
	const restartModel = provider.addScript("s26-restart", [{ kind: "text", text: "Persist this session." }]);
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const stateDir = join(home.path, LAYOUT.state);
	const children: ReturnType<typeof startPiChild>[] = [];
	t.after(async () => {
		for (const child of children) await child.close();
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const start = (model: string, relaunch: string) => {
		const child = startPiChild({ cwd: home.path, model, sessionDir: join(home.path, "sessions"), extensions: [CP_BRIDGE_EXTENSION],
			env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi", CP_OPERATOR_RELAUNCH_FILE: relaunch } });
		children.push(child);
		return child;
	};
	const record = async () => (await waitFor(() => readControlRecord(stateDir), (r) => r.state === "ok", { timeoutMs: 30_000, what: "bridge control socket" }) as { record: Parameters<typeof controlRequest>[0] }).record;
	const plain = start(plainModel, "");
	const plainRecord = await record();
	const unsupportedStatus = await controlRequest(plainRecord, "status", {});
	const unsupported = await controlRequest(plainRecord, "restart", { peer: "100.64.0.9" });
	const unsupportedReason = "this session was not started by a cp-operator that relaunches it; restart it once by hand: /quit, then cp-operator -c";
	assert.deepEqual(unsupported, { ok: false, status: 409, error: `unsupported: ${unsupportedReason}` });
	assert.deepEqual((unsupportedStatus as { result: { restart: unknown } }).result.restart, { supported: false, blockers: [], reason: unsupportedReason });
	const journal = () => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(journal().map((line) => [line.type, line.kind ?? line.state]), [["request", "restart"], ["outcome", "refused"]]);
	assert.equal((await plain.getState()).isStreaming, false, "unsupported restart leaves the real session alive");
	await plain.close();
	const marker = join(home.path, "relaunch.json");
	const child = start(restartModel, marker);
	await child.prompt("Persist the session.");
	await child.waitForSettled(30_000);
	const active = await record();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled":false}');
	const disabled = await controlRequest(active, "restart", {});
	assert.match(JSON.stringify(disabled), /dashboard control is off/);
	assert.equal(existsSync(marker), false);
	writeFileSync(controlConfigFile(stateDir), '{"enabled":true}');
	const reply = await controlRequest(active, "restart", { peer: "100.64.0.9" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.match(JSON.stringify(reply), /restarting/);
	const saved = JSON.parse(readFileSync(marker, "utf8"));
	assert.equal(saved.version, 1);
	assert.ok(saved.pid > 0);
	assert.equal(existsSync(saved.session_file), true);
	assert.equal(statSync(marker).mode & 0o777, 0o600);
	assert.equal(JSON.stringify(reply).includes(home.path), false, "restart response exposes only the basename");
	const restartStatus = journal().filter((line) => line.kind === "restart" || line.state === "restarting");
	assert.deepEqual(restartStatus.slice(-2).map((line) => [line.type, line.kind ?? line.state, line.peer]), [["request", "restart", "100.64.0.9"], ["outcome", "restarting", "100.64.0.9"]]);
	assert.equal(saved.id, (reply as { result: { id: string } }).result.id);
	// RPC pi currently stays alive after ctx.shutdown; shutdown assertions remain pending-fix in the S26 ledger.
	assert.equal(provider.remaining("s26-restart"), 0);
});

test("S26: public dispatch gates heal only spent foreign drains and reopen after removal", { timeout: 110_000 }, async (t) => {
	const { readFileSync, rmSync } = await import("node:fs");
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const steps = [{ kind: "text" as const, text: "Ready." }, ...Array.from({ length: 11 }, () => [
		{ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: "cp-missing", task: "Probe the public start gate" } }] },
		{ kind: "text" as const, text: "Gate checked." },
	]).flat()];
	const model = provider.addScript("s26-gates", steps);
	const agent = createAgentDir({ provider });
	const spawnedAt = Date.now();
	const child = startPiChild({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION], env: { ...agent.env, CP_HOME: home.path } });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Ready.");
	await child.waitForSettled(30_000);
	const file = join(home.path, LAYOUT.state, "drain.json");
	const base = { state: "drained", started_at: "2020-01-01T00:00:00Z", finished_at: "2020-01-01T00:00:01Z", deadline: "x", timeout_s: 1, reported: true, jobs: [] };
	const probe = async () => {
		const before = child.records().length;
		await child.prompt("Probe dispatch.");
		await child.waitFor((r) => child.records().indexOf(r) >= before && r.type === "agent_settled", 30_000);
		return JSON.stringify(child.records().slice(before).filter((r) => r.type === "tool_execution_end"));
	};
	writeFileSync(file, JSON.stringify(base));
	assert.doesNotMatch(await probe(), /parent is draining/);
	assert.equal(existsSync(file), false, "old foreign drain is consumed at the public dispatch gate");
	const recent = { ...base, finished_at: new Date().toISOString() };
	writeFileSync(file, JSON.stringify(recent));
	assert.match(await probe(), /parent is draining/);
	assert.equal(existsSync(file), true, "recent foreign drain remains live");
	const sha = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	writeFileSync(file, JSON.stringify({ ...recent, cause: { reason: "auto-update", target_sha: sha.slice(0, 12) } }));
	assert.doesNotMatch(await probe(), /parent is draining/);
	assert.equal(existsSync(file), false, "running update target opens the gate");
	writeFileSync(file, JSON.stringify({ ...recent, cause: { reason: "auto-update", target_sha: "0".repeat(40) } }));
	assert.match(await probe(), /parent is draining/);
	writeFileSync(file, JSON.stringify({ ...base, state: "draining" }));
	assert.match(await probe(), /parent is draining/);
	assert.equal(existsSync(file), true, "a live draining record is not healed by age");
	rmSync(file);
	assert.doesNotMatch(await probe(), /parent is draining/);
	assert.equal(existsSync(file), false, "external removal opens the next gate in the same process");
	const recovery = readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8");
	assert.match(recovery, /recovery:drain:2020-01-01T00:00:00Z/);
	assert.equal(child.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes("RESTART AFTER DRAIN")).length, 1, "one recovery reaches the actual session");
	await probe();
	writeFileSync(file, JSON.stringify({ ...base, finished_at: new Date(spawnedAt).toISOString().slice(0, 19) + "Z" }));
	assert.match(await probe(), /parent is draining/, "a drain finished in the process-start second is not proven spent");
	rmSync(file);
	await child.prompt("/cp-drain 1");
	const own = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...own, finished_at: base.finished_at, cause: { reason: "auto-update", target_sha: sha } }));
	assert.match(await probe(), /parent is draining/, "the parent's own drain never self-heals");
	rmSync(file);
	assert.doesNotMatch(await probe(), /parent is draining/, "removing this process's own drain opens the next dispatch gate");
	assert.equal(provider.remaining("s26-gates"), 0);
});
