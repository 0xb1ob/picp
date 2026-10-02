/**
 * The br_id -> job_id state sweep (spec §Migrations, PR 1). Every rule is a
 * test: documents are deep-renamed, journals are rewritten line by line, a
 * malformed line is copied verbatim, sessions/ and .bak files are skipped,
 * the marker makes the second run a no-op, and doctor can tell an unswept
 * home from a swept one.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import {
	JOB_ID_MIGRATION_MARKER,
	jobIdMigrationFinding,
	listSweepTargets,
	renameKeyDeep,
	sweepJobIdRename,
} from "../src/state-migrations.ts";
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

test("renameKeyDeep renames object keys at every depth and never touches values", () => {
	const input = { br_id: "cp-a", list: [{ br_id: "cp-b" }, "br_id"], deep: { x: { br_id: null } }, text: "br_id" };
	const { value, renamed } = renameKeyDeep(input, "br_id", "job_id");
	assert.deepEqual(value, {
		job_id: "cp-a",
		list: [{ job_id: "cp-b" }, "br_id"],
		deep: { x: { job_id: null } },
		text: "br_id",
	});
	assert.equal(renamed, 3);
	assert.deepEqual(renameKeyDeep(42, "br_id", "job_id"), { value: 42, renamed: 0 });
});

test("listSweepTargets finds json documents and jsonl journals under state/ and skips sessions, backups and prose", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLegacyHome(home.path);
	const targets = listSweepTargets(home.path);
	const rel = (files: string[]) => files.map((file) => file.slice(home.path.length + 1)).sort();
	assert.deepEqual(rel(targets.documents), [
		".pi-command-post/state/awaiting.json",
		".pi-command-post/state/checkpoints/cp-a.json",
		".pi-command-post/state/fleet.json",
		".pi-command-post/state/runs/cp-a/gate-1/verdict.json",
		".pi-command-post/state/runs/cp-a/status.json",
	]);
	assert.deepEqual(rel(targets.journals), [".pi-command-post/state/runs/cp-a/events.jsonl"]);
});

test("the sweep renames documents and journal lines, copies a malformed line verbatim, writes the marker, and is a no-op afterwards", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	seedLegacyHome(home.path);

	const first = sweepJobIdRename({ home: home.path });
	assert.equal(first.already_done, false);
	assert.equal(first.documents.filter((d) => d.action === "renamed").length, 5);
	assert.deepEqual(first.journals, [
		{ file: join(home.path, LAYOUT.runs, "cp-a/events.jsonl"), lines_renamed: 2, lines_copied: 1 },
	]);
	assert.ok(existsSync(join(home.path, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER)));

	const fleet = JSON.parse(readFileSync(join(home.path, LAYOUT.fleetFile), "utf8")) as {
		jobs: Array<Record<string, unknown>>;
	};
	assert.deepEqual(fleet.jobs[0], { job_id: "cp-a", phase: "waiting", nested: { job_id: "cp-a" } });
	assert.ok(!readFileSync(join(home.path, LAYOUT.checkpoints, "cp-a.json"), "utf8").includes('"br_id"'));

	const events = readFileSync(join(home.path, LAYOUT.runs, "cp-a/events.jsonl"), "utf8").split("\n");
	assert.deepEqual(JSON.parse(events[0] as string), {
		seq: 1,
		job_id: "cp-a",
		type: "spawned",
		payload: { job_id: "cp-a" },
	});
	assert.equal(events[1], "this line is not json {");
	assert.deepEqual(JSON.parse(events[2] as string), {
		seq: 2,
		job_id: "cp-a",
		type: "text",
		payload: { text: "the string br_id stays" },
	});
	assert.equal(events[3], "", "the trailing newline survives");

	// Untouched by contract.
	assert.equal(
		readFileSync(join(home.path, LAYOUT.sessions, "2026-09-01.jsonl"), "utf8"),
		JSON.stringify({ br_id: "cp-a" }),
	);
	assert.equal(readFileSync(join(home.path, LAYOUT.state, "awaiting.json.bak-1"), "utf8"), JSON.stringify({ br_id: "cp-a" }));
	assert.equal(readFileSync(join(home.path, LAYOUT.runs, "cp-a/brief.md"), "utf8"), "Job br_id cp-a");

	const second = sweepJobIdRename({ home: home.path });
	assert.equal(second.already_done, true);
	assert.deepEqual(second.documents, []);
	assert.deepEqual(second.journals, []);
});

test("an unparseable document is reported and left exactly as it was", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = write(home.path, `${LAYOUT.runs}/cp-x/status.json`, '{"br_id": "cp-x", broken');
	const report = sweepJobIdRename({ home: home.path });
	assert.deepEqual(report.documents, [{ file, action: "unparseable", renamed: 0 }]);
	assert.equal(readFileSync(file, "utf8"), '{"br_id": "cp-x", broken');
	assert.ok(
		existsSync(join(home.path, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER)),
		"the marker is written: the sweep did all it could",
	);
});

test("a home with no state at all sweeps to an empty report and still writes the marker", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const report = sweepJobIdRename({ home: home.path });
	assert.equal(report.already_done, false);
	assert.deepEqual(report.documents, []);
	assert.ok(existsSync(report.marker));
});

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
