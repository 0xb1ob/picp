/**
 * cp-7bsr PR2: Settings over the operator socket. `startDashboardControl` with the real `settingsPorts` on a
 * scratch home answers `settings_get` and `settings_apply`; a bridge without the port answers `unknown op`; the
 * real cp-bridge extension wires the port for its home.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT, SETTING_FIELDS } from "../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../src/dashboard-control.ts";
import { settingsPorts } from "../src/settings-control.ts";
import { settingsAuditFile } from "../src/settings-write.ts";
import { controlRequest } from "../src/viewer/control-api.ts";
import { controlJournalFile, readControlRecord } from "../src/viewer/control-files.ts";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { createScratchHome } from "./harness/index.ts";

type Record_ = Parameters<typeof controlRequest>[0];
type Snapshot = { revision: string; fields: Array<{ key: string; value: unknown; source: string; status: string }> };

function scratch(t: TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	return { home: home.path, stateDir: join(home.path, LAYOUT.state) };
}

const basePorts = (): ControlPorts => ({ inject: () => {}, abort: () => {}, isIdle: () => true, hasPendingMessages: () => false, sessionFile: () => undefined });

async function listening(t: TestContext, stateDir: string, ports: ControlPorts): Promise<Record_> {
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 50, log: () => {} });
	assert.equal(control.state, "listening");
	t.after(() => (control as DashboardControl).stop());
	return (readControlRecord(stateDir) as { record: Record_ }).record;
}

async function get(record: Record_) {
	const reply = await controlRequest(record, "settings_get", {});
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply.result as { snapshot: Snapshot; catalog: unknown[]; audit: Array<Record<string, unknown>> };
}

async function apply(record: Record_, args: Record<string, unknown>) {
	const reply = await controlRequest(record, "settings_apply", { dry_run: false, request_id: "req-12345678", peer: "100.64.0.9", ...args });
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply.result as { status: number; state: string; error?: string; revision?: string; snapshot?: Snapshot; changes?: unknown[] };
}

test("settings_get: snapshot, the full catalog and the audit tail; settings_apply set, restore and dry run", async (t) => {
	const { home, stateDir } = scratch(t);
	const gate = join(home, LAYOUT.gateConfigFile);
	writeFileSync(gate, JSON.stringify({ schema_version: 1 }));
	const record = await listening(t, stateDir, { ...basePorts(), ...settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }) });
	const first = await get(record);
	assert.match(first.snapshot.revision, /^[0-9a-f]{64}$/);
	assert.deepEqual(first.catalog, JSON.parse(JSON.stringify(SETTING_FIELDS)));
	assert.equal(first.catalog.length, 31);
	assert.deepEqual(first.audit, []);

	const preview = await apply(record, { mode: "set", changes: { "review.timeout_ms": 60_000 }, expected_revision: null, dry_run: true });
	assert.deepEqual([preview.status, preview.state, preview.changes?.length], [200, "planned", 1]);
	const set = await apply(record, { mode: "set", changes: { "review.timeout_ms": 60_000 }, expected_revision: first.snapshot.revision, actor: "someone-else" });
	assert.deepEqual([set.status, set.state], [200, "applied"], JSON.stringify(set));
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1, review_timeout_ms: 60_000 });
	const stale = await apply(record, { mode: "restore", keys: ["review.timeout_ms"], expected_revision: first.snapshot.revision });
	assert.deepEqual([stale.status, stale.state, stale.revision], [412, "stale", set.revision]);
	const restored = await apply(record, { mode: "restore", section: "review", expected_revision: set.revision });
	assert.deepEqual([restored.status, restored.state], [200, "applied"]);
	assert.deepEqual(JSON.parse(readFileSync(gate, "utf8")), { schema_version: 1 });
	assert.equal((await apply(record, { mode: "set", changes: { "models.allow": [] }, expected_revision: restored.revision })).status, 403);
	assert.equal((await apply(record, { mode: "set", changes: { "grants.job_cap": 2 }, expected_revision: null })).status, 428);

	const audit = (await get(record)).audit;
	assert.deepEqual(audit.map((line) => line.type), ["intent", "applied", "refused", "intent", "applied", "refused"]);
	assert.ok(audit.filter((line) => "actor" in line).every((line) => line.actor === "dashboard"), "the actor is the owner's, never the frame's");
	assert.equal(audit[0]!.peer, "100.64.0.9");
	assert.equal(existsSync(controlJournalFile(stateDir)), false, "settings ops write no dashboard.jsonl line");
});

test("settings_apply arg shapes: each malformed frame is 400 before the transaction, with no audit line", async (t) => {
	const { home, stateDir } = scratch(t);
	const record = await listening(t, stateDir, { ...basePorts(), ...settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }) });
	const ok = { mode: "set", changes: { "grants.job_cap": 2 }, expected_revision: "a".repeat(64), dry_run: false, request_id: "req-12345678", peer: null };
	const bad: Array<[Record<string, unknown>, RegExp]> = [
		[{ ...ok, mode: "patch" }, /mode must be/],
		[{ ...ok, changes: {} }, /at least one key/],
		[{ ...ok, changes: [] }, /at least one key/],
		[{ ...ok, keys: ["grants.job_cap"] }, /set takes changes only/],
		[{ ...ok, mode: "restore", changes: undefined }, /exactly one of keys, section or all/],
		[{ ...ok, mode: "restore", changes: undefined, keys: ["a"], all: true }, /exactly one/],
		[{ ...ok, mode: "restore", changes: undefined, keys: [] }, /non-empty array/],
		[{ ...ok, mode: "restore", changes: undefined, all: false }, /all must be true/],
		[{ ...ok, mode: "restore", changes: undefined, section: 7 }, /section must be/],
		[{ ...ok, mode: "restore" }, /restore takes no changes/],
		[{ ...ok, expected_revision: "abc" }, /64-hex/],
		[{ ...ok, dry_run: "yes" }, /dry_run must be a boolean/],
		[{ ...ok, request_id: "short" }, /request_id/],
		[{ ...ok, request_id: "has space 12345" }, /request_id/],
		[{ ...ok, peer: "x".repeat(65) }, /peer must be/],
	];
	for (const [args, error] of bad) {
		const reply = await controlRequest(record, "settings_apply", JSON.parse(JSON.stringify(args)));
		assert.ok(reply.ok);
		const result = reply.result as { status: number; error: string };
		assert.equal(result.status, 400, JSON.stringify(args));
		assert.match(result.error, error, JSON.stringify(args));
	}
	assert.equal(existsSync(settingsAuditFile(home)), false);
});

test("a bridge without the settings port answers unknown op settings_get / settings_apply", async (t) => {
	const { stateDir } = scratch(t);
	const record = await listening(t, stateDir, basePorts());
	for (const op of ["settings_get", "settings_apply"]) {
		const reply = await controlRequest(record, op, {});
		assert.deepEqual(reply.ok ? null : [reply.status, reply.error], [400, `unknown op ${op}`]);
	}
});

test("cp-bridge wiring: index.ts spreads settingsPorts; the real extension's socket answers settings_get for its home", async (t) => {
	const source = readFileSync(new URL("../extensions/cp-bridge/index.ts", import.meta.url), "utf8");
	assert.match(source, /\.\.\.settingsPorts\(\{ target: \(\) => target \}\)/);
	const { home, stateDir } = scratch(t);
	writeFileSync(join(home, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: 1, review_timeout_ms: 90_000 }));
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(home, "pi-home");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home, mode: "multi", hostPid: 0, parentPid: 0 });
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const emit = async (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
	bridgeExtension({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as never);
	const ctx = { hasUI: false, isIdle: () => true, abort: () => {}, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => join(home, "operator-session.jsonl") } };
	await emit("session_start", {}, ctx);
	t.after(() => emit("session_shutdown", {}));
	const result = await get((readControlRecord(stateDir) as { record: Record_ }).record);
	assert.deepEqual(result.snapshot.fields.find((row) => row.key === "review.timeout_ms"), { key: "review.timeout_ms", value: 90_000, source: "file", status: "ok" });
	assert.ok(!JSON.stringify(result).includes(home), "no home path in the reply");
});
