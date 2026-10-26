/**
 * Retained from tests/settings-write.test.ts (P16b): `applySettings`'s `writeText`, `readBack`, `append` (failing the
 * applied line) and `shippedRouting` seams, and `restoreShippedRubric`; no e2e entry point can inject those failures.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, type SettingFileOwner } from "../src/contracts.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { readSettings } from "../src/settings.ts";
import { applySettings, restoreShippedRubric, type SettingsApplyInput, settingsAuditFile, type SettingsWriteRequest, type SettingsWriteSeams } from "../src/settings-write.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const OWNER_FILE: Record<Exclude<SettingFileOwner, "routing">, string> = {
	"mandate-defaults": LAYOUT.mandateDefaultsFile,
	budgets: LAYOUT.budgetsFile,
	"worker-bounds": LAYOUT.workerBoundsFile,
	parent: `${LAYOUT.data}/parent.json`,
	operator: `${LAYOUT.data}/operator.json`,
	gate: LAYOUT.gateConfigFile,
	quality: `${LAYOUT.data}/quality.json`,
	capacity: `${LAYOUT.data}/capacity.json`,
	update: `${LAYOUT.data}/update.json`,
	viewer: `${LAYOUT.data}/viewer.json`,
};
type Owner = keyof typeof OWNER_FILE;
const CAPACITY = { url: "https://secret-gateway.example/", path: "/v1/secret-path" };

function scratch(t: TestContext): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	return home.path;
}
const file = (home: string, owner: Owner) => join(home, OWNER_FILE[owner]);
const put = (home: string, owner: Owner, body: unknown) => writeFileSync(file(home, owner), typeof body === "string" ? body : JSON.stringify(body));
const snap = (home: string) => readSettings(home, {});
const audit = (home: string): Array<Record<string, unknown>> => existsSync(settingsAuditFile(home)) ? readFileSync(settingsAuditFile(home), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function apply(home: string, request: SettingsWriteRequest, options: Partial<SettingsApplyInput> = {}, seams: SettingsWriteSeams = {}) {
	return applySettings(home, { request, expected_revision: snap(home).revision, dry_run: false, request_id: "req-12345678", peer: "100.64.0.1", actor: "dashboard", env: {}, ...options }, seams);
}

function listing(root: string): string[] {
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.map((path) => `${relative(root, path)}\t${statSync(path).mtimeMs}\t${sha(readFileSync(path))}`)
		.sort();
}

/** One existing file per owner, each with a key the transaction must keep. */
function fullHome(t: TestContext): string {
	const home = scratch(t);
	put(home, "mandate-defaults", SCAFFOLD_MANDATE_DEFAULTS);
	put(home, "budgets", { ...DEFAULT_BUDGET_CONFIG, cumulative_cost_usd: 5 });
	put(home, "worker-bounds", { wall_clock_seconds: 100 });
	put(home, "parent", { compact_at_tokens: 100 });
	put(home, "operator", { compact_at_tokens: 100, handoffs_dir: "/tmp/handoffs" });
	put(home, "gate", { schema_version: 1 });
	put(home, "quality", { model: "anthropic/claude-haiku" });
	put(home, "capacity", CAPACITY);
	put(home, "update", { enabled: true, interval_min: 15 });
	put(home, "viewer", {});
	return home;
}

test("failures: a write failure on a later owner rolls earlier owners back (a created file unlinked); a read-back mismatch rolls back all", (t) => {
	const home = fullHome(t);
	const gateBefore = readFileSync(file(home, "gate"));
	const bounds = file(home, "worker-bounds");
	rmSync(bounds);
	let calls = 0;
	const failing: SettingsWriteSeams = {
		writeText: (target, text, options) => {
			calls++;
			if (target === file(home, "quality")) throw new Error(`EIO writing ${target}`);
			writeFileSync(target, text, { mode: options.mode });
		},
	};
	const result = apply(home, { mode: "set", changes: { "sessions.wall_clock_seconds": 60, "review.timeout_ms": 60_000, "review.quality_voters": 2 } }, {}, failing);
	assert.deepEqual([result.status, result.state], [500, "failed"]);
	assert.equal(calls, 3);
	assert.ok(!(result.error ?? "").includes(home), "the home path is redacted");
	assert.equal(existsSync(bounds), false, "the file this transaction created is gone");
	assert.ok(readFileSync(file(home, "gate")).equals(gateBefore), "the existing owner is byte-identical");
	const failed = audit(home).at(-1)!;
	assert.equal(failed.type, "failed");
	assert.deepEqual((failed.rolled_back as Array<{ owner: string; ok: boolean }>).map((row) => [row.owner, row.ok]), [["worker-bounds", true], ["gate", true], ["quality", true]]);

	const snapshots: SettingsWriteSeams = {
		readBack: (target, env) => {
			const read = readSettings(target, env);
			return { ...read, fields: read.fields.map((row) => row.key === "grants.job_cap" ? { ...row, value: 1 } : row) };
		},
	};
	const mandateBefore = readFileSync(file(home, "mandate-defaults"));
	const mismatch = apply(home, { mode: "set", changes: { "grants.job_cap": 6, "review.timeout_ms": 90_000 } }, {}, snapshots);
	assert.deepEqual([mismatch.status, mismatch.state], [500, "failed"]);
	assert.match(mismatch.error ?? "", /read-back disagrees: grants\.job_cap/);
	assert.ok(readFileSync(file(home, "mandate-defaults")).equals(mandateBefore));
	assert.ok(readFileSync(file(home, "gate")).equals(gateBefore));
});

test("crash recovery: a dangling intent is recorded once as recovered, per owner; a non-JSON last line is 503", (t) => {
	const home = fullHome(t);
	const warned = apply(home, { mode: "set", changes: { "grants.job_cap": 5 } }, {}, {
		append: (target, text) => { if (text.includes('"type":"applied"')) throw new Error("ENOSPC"); writeFileSync(target, text, { flag: "a", mode: 0o600 }); },
	});
	assert.deepEqual([warned.status, warned.state], [200, "applied"]);
	assert.match(warned.audit_warning ?? "", /recorded as recovered|records it as recovered/);
	assert.equal(audit(home).at(-1)?.type, "intent");
	const next = apply(home, { mode: "set", changes: { "budgets.spawn_cap": 6 } });
	assert.equal(next.state, "applied");
	const recovered = audit(home).filter((line) => line.type === "recovered");
	assert.equal(recovered.length, 1);
	assert.deepEqual(recovered[0]!.owners, [{ owner: "mandate-defaults", state: "applied" }]);
	apply(home, { mode: "set", changes: { "budgets.spawn_cap": 7 } });
	assert.equal(audit(home).filter((line) => line.type === "recovered").length, 1, "a second apply adds none");

	// A crash between the intent and the rename: not_written; a hand edit since: changed_since.
	const gate = readFileSync(file(home, "gate"));
	const intent = { v: 1, type: "intent", id: "st-20260101000000-deadbeef", at: "2026-01-01T00:00:00Z", actor: "dashboard", peer: null, request_id: "req-12345678", mode: "set", base_revision: "0".repeat(64), writes: [
		{ owner: "gate", path: OWNER_FILE.gate, prior_sha256: sha(gate), next_sha256: "1".repeat(64), changes: [] },
		{ owner: "quality", path: OWNER_FILE.quality, prior_sha256: "2".repeat(64), next_sha256: "3".repeat(64), changes: [] },
	] };
	writeFileSync(settingsAuditFile(home), `${JSON.stringify(intent)}\n`, { flag: "a" });
	apply(home, { mode: "set", changes: { "budgets.spawn_cap": 8 } }, { expected_revision: "0".repeat(64) });
	const lines = audit(home);
	assert.deepEqual(lines.at(-2), { v: 1, type: "recovered", id: intent.id, at: lines.at(-2)!.at, owners: [{ owner: "gate", state: "not_written" }, { owner: "quality", state: "changed_since" }] });
	assert.equal(lines.at(-1)?.status, 412, "recovery runs before the revision check");

	writeFileSync(settingsAuditFile(home), "{torn", { flag: "a" });
	const torn = apply(home, { mode: "set", changes: { "budgets.spawn_cap": 9 } });
	assert.equal(torn.status, 503);
	assert.match(torn.error ?? "", /not JSON/);
});


const RUBRIC = [
	{ id: "risky", role: "researcher", risk: "high", model: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt-6.1-sol"], thinking: "xhigh", note: "legacy role word" },
	{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-opus-5-5" },
	{ id: "custom", role: "implementer", project: "demo", scope: ["S"], model: "openai/gpt-5", fallbacks: ["anthropic/claude-haiku"] },
];
const ROUTING_DOC = { schema_version: 1, allow: ["anthropic/*", "openai/*"], deny_by_role: { implementer: ["openai/gpt-4*"] }, rubric: RUBRIC };
const routingFile = (home: string) => join(home, LAYOUT.routingFile);
const routing = (home: string) => JSON.parse(readFileSync(routingFile(home), "utf8"));

test("models.rubric restore: the shipped model/fallbacks/thinking per matching row id; other rows untouched; absent routing.json is 409 / no-op", (t) => {
	const home = scratch(t);
	const template = { schema_version: 1, allow: ["*/*"], rubric: [
		{ id: "risky", role: "planner", risk: "high", model: "anthropic/claude-opus-5-5", thinking: "high" },
		{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-sonnet-5-5", fallbacks: ["openai/gpt-6.1-sol"] },
		{ id: "shipped-only", role: "implementer", model: "anthropic/claude-haiku" },
	] };
	writeFileSync(routingFile(home), JSON.stringify(ROUTING_DOC));
	const seams: SettingsWriteSeams = { shippedRouting: () => template };
	const result = apply(home, { mode: "restore", keys: ["models.rubric"] }, {}, seams);
	assert.deepEqual([result.status, result.state], [200, "applied"], JSON.stringify(result));
	assert.deepEqual(routing(home).rubric, [
		{ id: "risky", role: "researcher", risk: "high", model: "anthropic/claude-opus-5-5", thinking: "high", note: "legacy role word" },
		{ id: "reviews", role: "gate-reviewer", model: "anthropic/claude-sonnet-5-5", fallbacks: ["openai/gpt-6.1-sol"] },
		RUBRIC[2],
	], "fallbacks the template lacks are deleted; the hand-added row stays; a template-only row is not added");
	assert.deepEqual(routing(home).deny_by_role, ROUTING_DOC.deny_by_role);
	assert.deepEqual(restoreShippedRubric([{ id: "x", role: "planner", model: "a/b" }], template), [{ id: "x", role: "planner", model: "a/b" }]);

	const unreadable = apply(home, { mode: "restore", keys: ["models.rubric"] }, {}, { shippedRouting: () => { throw new Error("ENOENT"); } });
	assert.equal(unreadable.status, 409);
	assert.match(unreadable.error ?? "", /shipped routing defaults .* unreadable/);

	// The real shipped template: an edited copy of it restores to the file byte-for-byte in value.
	const shipped = JSON.parse(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	const edited = structuredClone(shipped);
	edited.rubric[0].model = "openai/gpt-5";
	delete edited.rubric[1].fallbacks;
	edited.rubric[2].thinking = "low";
	writeFileSync(routingFile(home), JSON.stringify(edited));
	const real = apply(home, { mode: "restore", section: "models" });
	assert.deepEqual([real.status, real.state], [200, "applied"], JSON.stringify(real));
	assert.deepEqual(routing(home), shipped);

	const absent = scratch(t);
	const before = listing(absent);
	const refused = apply(absent, { mode: "set", changes: { "models.rubric": [] } });
	assert.equal(refused.status, 409);
	assert.match(refused.error ?? "", /routing\.json is absent: worker routing uses each profile's model/);
	assert.deepEqual([apply(absent, { mode: "restore", keys: ["models.rubric"] }).state], ["unchanged"]);
	assert.equal(existsSync(routingFile(absent)), false);
	assert.deepEqual(listing(absent).filter((row) => !row.startsWith(relative(absent, settingsAuditFile(absent)))), before);
});
