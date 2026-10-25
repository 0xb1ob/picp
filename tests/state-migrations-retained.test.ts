/**
 * Retained from tests/state-migrations.test.ts by P16 (docs/testing-migration/p16-slice.md): every session sweeps
 * before /doctor can run, so doctor's error for an unswept home has no entry point; P16-migration pins ok and warn.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { jobIdMigrationFinding, sweepJobIdRename } from "../src/state-migrations.ts";
import { createScratchHome } from "./harness/index.ts";

function write(home: string, relative: string, text: string): string {
	const file = join(home, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return file;
}

/** A home that looks like one written before the rename. */
function seedLegacyHome(home: string): void {
	write(
		home,
		LAYOUT.fleetFile,
		JSON.stringify({
			schema_version: 1,
			updated_at: "2026-09-01T00:00:00Z",
			jobs: [{ br_id: "cp-a", phase: "waiting", nested: { br_id: "cp-a" } }],
		}),
	);
	write(home, LAYOUT.awaitingFile, JSON.stringify({ items: [{ id: "aw-1", br_id: "cp-a" }] }));
	write(home, `${LAYOUT.checkpoints}/cp-a.json`, JSON.stringify({ br_id: "cp-a", decision: "pending" }));
	write(home, `${LAYOUT.runs}/cp-a/status.json`, JSON.stringify({ br_id: "cp-a", phase: "working" }));
	write(home, `${LAYOUT.runs}/cp-a/gate-1/verdict.json`, JSON.stringify({ br_id: "cp-a", verdict: "pass" }));
	write(
		home,
		`${LAYOUT.runs}/cp-a/events.jsonl`,
		[
			JSON.stringify({ seq: 1, br_id: "cp-a", type: "spawned", payload: { br_id: "cp-a" } }),
			"this line is not json {",
			JSON.stringify({ seq: 2, br_id: "cp-a", type: "text", payload: { text: "the string br_id stays" } }),
			"",
		].join("\n"),
	);
	// Must be left alone: pi's own transcripts, a backup, prose.
	write(home, `${LAYOUT.sessions}/2026-09-01.jsonl`, JSON.stringify({ br_id: "cp-a" }));
	write(home, `${LAYOUT.awaitingFile}.bak-1`, JSON.stringify({ br_id: "cp-a" }));
	write(home, `${LAYOUT.runs}/cp-a/brief.md`, "Job br_id cp-a");
	write(home, LAYOUT.parentLock, "12345");
}

test("doctor: unswept files are an error, a swept home is ok, and a legacy file behind the marker is a warning", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const fresh = jobIdMigrationFinding(home.path);
	assert.equal(fresh.check, "state.job_id_migration");
	assert.equal(fresh.severity, "ok");

	seedLegacyHome(home.path);
	const unswept = jobIdMigrationFinding(home.path);
	assert.equal(unswept.severity, "error");
	// 5 documents + the events journal: doctor counts journals too.
	assert.match(unswept.what, /6 file\(s\) still carry "br_id"/);
	assert.match(unswept.fix ?? "", /start a pi session/);

	sweepJobIdRename({ home: home.path });
	assert.equal(jobIdMigrationFinding(home.path).severity, "ok");

	write(home.path, `${LAYOUT.checkpoints}/restored.json`, JSON.stringify({ br_id: "cp-z" }));
	const restored = jobIdMigrationFinding(home.path);
	assert.equal(restored.severity, "warn");
	assert.match(restored.fix ?? "", /remove the marker/);
});
