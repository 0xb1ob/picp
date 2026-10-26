/**
 * Retained from tests/settings-write.test.ts (P16b): `applySettings`'s `writeText` and `readBack` seams inject a failing
 * owner write and a disagreeing read-back; no e2e entry point can fail one owner's write mid-transaction.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_BUDGET_CONFIG, LAYOUT, type SettingFileOwner } from "../src/contracts.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../src/mandate-defaults.ts";
import { readSettings } from "../src/settings.ts";
import { applySettings, type SettingsApplyInput, settingsAuditFile, type SettingsWriteRequest, type SettingsWriteSeams } from "../src/settings-write.ts";
import { createScratchHome } from "./harness/index.ts";

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
