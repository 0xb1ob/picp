/**
 * The Claude CLI operator's e2e fixture: a scratch home whose data/operator.json says driver `claude`, the claude mock
 * provider behind a fake HOME's Claude settings, fake-claude on PATH, the real `runOperator` launching the native entry,
 * and a real viewer on the home. Teardown stops the operator (SIGTERM to its pid) before anything is removed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { layoutForHome } from "../../src/contracts.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { type ControlRecord, readControlRecord } from "../../src/viewer/control-files.ts";
import { runOperator } from "../../src/viewer/operator.ts";
import { createViewer } from "../../src/viewer/server.ts";
import { type ClaudeStep, FAKE_NATIVE_MODEL, installClaudeStub, type RecordedClaudeRequest, startClaudeMockProvider, subscriberEnv } from "./claude-mock-provider.ts";
import { createScratchHome, waitFor } from "./index.ts";
import { isModelCall, userTexts, withEnv } from "./native-parent.ts";

type Json = Record<string, any>;

export type NativeOperator = Awaited<ReturnType<typeof nativeOperator>>;

/** `settingsEnv` reaches fake-claude through the settings file (its test knobs); `env` the launcher and operator. */
export async function nativeOperator(t: TestContext, script: ClaudeStep[], options: { settingsEnv?: Record<string, string>; env?: Record<string, string>; seed?: (home: string) => void } = {}) {
	const provider = await startClaudeMockProvider(script);
	const scratch = createScratchHome();
	const home = scratch.path;
	const layout = layoutForHome("multi", home);
	const state = join(home, layout.state);
	mkdirSync(join(home, layout.data), { recursive: true });
	writeFileSync(join(home, layout.data, "operator.json"), JSON.stringify({ driver: "claude", model: FAKE_NATIVE_MODEL }));
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-native-operator-home-"));
	const settings = join(fakeHome, ".claude", "settings.json");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(settings, JSON.stringify({ env: { ...subscriberEnv(provider.url), ...options.settingsEnv } }));
	const bin = join(fakeHome, "bin");
	installClaudeStub(bin);
	const agentDir = join(fakeHome, "agent");
	mkdirSync(agentDir);
	withEnv(t, { HOME: fakeHome, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_HOME: agentDir, CP_HOME: home, CP_MODE: "multi", CP_OPERATOR_VIEWER: "service", CP_OPERATOR_WEB: "0", ...options.env });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	options.seed?.(home);

	const viewer = createViewer({ home, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } });
	await new Promise<void>((done) => viewer.listen(0, "127.0.0.1", done));
	const port = (viewer.address() as AddressInfo).port;
	const exited = runOperator([], { viewer: { home, host: "127.0.0.1", port: 1 }, relaunchFile: join(fakeHome, "relaunch.json") });
	let record: ControlRecord | undefined;
	const stop = async () => {
		if (record) try { process.kill(record.pid, "SIGTERM"); } catch { /* already gone */ }
		await exited;
	};
	t.after(async () => {
		try { await stop(); } finally {
			viewer.close();
			await provider.close();
			scratch.cleanup();
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
	const found = await waitFor(() => readControlRecord(state), (row) => row.state === "ok", { timeoutMs: 60_000, what: "the Claude CLI operator's dashboard control" });
	if (found.state !== "ok") throw new Error("no dashboard control");
	record = found.record;

	const calls = (): RecordedClaudeRequest[] => provider.requests.filter(isModelCall);
	/** The first model call whose user turns carry `needle`. */
	const seen = async (needle: string, timeoutMs = 60_000) => (await waitFor(() => calls().find((request) => userTexts(request).some((text) => text.includes(needle))), Boolean, { timeoutMs, what: `a model call carrying ${needle}` }))!;
	const get = async (path: string): Promise<Json> => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "sec-fetch-site": "same-origin" } });
		if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
		return await response.json() as Json;
	};
	/** Polls a viewer read until `predicate` holds; `waitFor` is synchronous. */
	const view = async (path: string, predicate: (value: Json) => boolean, what: string, timeoutMs = 60_000): Promise<Json> => {
		let last: Json | undefined;
		for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((done) => setTimeout(done, 100))) {
			last = await get(path);
			if (predicate(last)) return last;
		}
		throw new Error(`timed out waiting for ${what}; last ${path}: ${JSON.stringify(last).slice(0, 2000)}`);
	};
	const send = (op: string, args: Record<string, unknown>) => controlRequest(record!, op, args);
	return { home, state, settings, provider, record, calls, seen, get, view, send, stop };
}
