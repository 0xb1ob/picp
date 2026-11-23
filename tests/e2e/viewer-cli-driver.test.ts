/**
 * The recorded CLI driver badge (pi, Claude CLI, Codex CLI, unknown) through `bin/cp-view` on a scratch home: the
 * operator and parent session headers, every worker in the Jobs list and Job detail, and the reviewer in Job detail.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { jsonl, viewer, write } from "../harness/conversations.ts";

const AT = "2026-09-27T08:00:00.000Z";
/** The first line src/drivers/claude-parent-session.ts writes into a Claude CLI parent's or operator's record. */
const RECORD = jsonl([{ type: "record", driver: "claude", created_at: AT }]);
const PI = jsonl([{ type: "session", id: "pi" }]);
const routed = (payload: object) => jsonl([{ source: "cp", type: "routing_resolved", ts: AT, payload: { surface: "review", attempt: 1, ...payload } }]);

// Scenario: Given held workers whose fleet records say pi (no driver), claude and codex, and one with no worker record,
//   When the Jobs list and each Job detail open, Then each row shows pi, Claude CLI, Codex CLI or unknown and each Model
//   fact the same (no worker: not recorded); the Review fact shows the reviewer's routed CLI, unknown with no run log.
test("CLI-driver jobs: the Jobs list and Job detail show each worker's and reviewer's recorded CLI", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed: (stateDir) => {
		const worker = (driver?: string) => ({ model: driver === "codex" ? "openai/gpt-x" : "anthropic/claude-x", ...(driver ? { driver } : {}) });
		write(join(stateDir, "fleet.json"), { jobs: [
			{ job_id: "cp-pi", project: "demo", kind: "ship", phase: "held", worker: worker() },
			{ job_id: "cp-claude", project: "demo", kind: "research", phase: "held", worker: worker("claude") },
			{ job_id: "cp-codex", project: "demo", kind: "ship", phase: "held", worker: worker("codex") },
			{ job_id: "cp-none", project: "demo", kind: "ship", phase: "held" },
		] });
		for (const id of ["cp-pi", "cp-codex", "cp-none"]) write(join(stateDir, "runs", id, "review-1.json"), { job_id: id, attempt: 1 });
		write(join(stateDir, "runs", "cp-pi", "review-1", "events.jsonl"), routed({ model: "openai/gpt-x" }));
		write(join(stateDir, "runs", "cp-codex", "review-1", "events.jsonl"), routed({ model: "openai/gpt-x", driver: "codex" }));
	} });
	const expected = { "cp-pi": "pi", "cp-claude": "Claude CLI", "cp-codex": "Codex CLI", "cp-none": "unknown" };
	const jobs = await d.open("#jobs");
	await jobs.find(".job-model .driver-badge");
	const rows = Object.fromEntries(jobs.$$("article.job-row").map((row) => [row.querySelector(".job-row-id code")?.textContent, row.querySelector(".job-model .driver-badge")?.textContent]));
	assert.deepEqual(rows, expected, "one badge per Jobs row");
	const reviewer = { "cp-pi": "pi", "cp-claude": null, "cp-codex": "Codex CLI", "cp-none": "unknown" };
	for (const [id, shown] of Object.entries(expected)) {
		const tab = await d.open(`#job/${id}`);
		const model = await tab.find(".job-fact-model dd");
		// No worker record means no model either: the fact stays `not recorded`, as before any worker spawned.
		assert.equal(id === "cp-none" ? model.textContent : model.querySelector(".driver-badge")?.textContent, id === "cp-none" ? "not recorded" : shown, `${id} Model fact`);
		assert.equal(tab.$(".job-fact-review .driver-badge")?.textContent ?? null, reviewer[id as keyof typeof reviewer], `${id} Review fact`);
	}
});

// Scenario: Given a pi operator session, a Claude CLI parent record and a codex worker, When each Sessions header opens,
//   Then it shows pi, Claude CLI and Codex CLI; And once the operator's newest file is a Claude CLI record and the parent
//   control names no session file, the operator shows Claude CLI and the parent unknown, never a guess.
test("CLI-driver sessions: the operator, parent and worker headers show the recorded CLI", { timeout: 120_000 }, async (t) => {
	let sessions = "", home = "";
	const d = await viewer(t, { seed: (stateDir, at) => {
		sessions = join(stateDir, "sessions"); home = at;
		write(join(home, "operator.jsonl"), PI);
		write(operatorSessionsFile(sessions), jsonl([{ at: AT, session_file: join(home, "operator.jsonl") }]));
		write(join(sessions, "native-parent-1.jsonl"), RECORD);
		write(join(sessions, "cp-parent-control.json"), { sessionFile: join(sessions, "native-parent-1.jsonl"), model: "anthropic/claude-x" });
		write(join(stateDir, "fleet.json"), { jobs: [{ job_id: "cp-codex", project: "demo", phase: "held", worker: { model: "openai/gpt-x", driver: "codex" } }] });
	} });
	const badge = async (hash: string) => (await (await d.open(hash)).find(".session-heading-state .driver-badge")).textContent;
	assert.deepEqual([await badge("#sessions?view=you"), await badge("#sessions?view=parent"), await badge("#sessions?view=workers&id=cp-codex")],
		["pi", "Claude CLI", "Codex CLI"]);
	write(join(sessions, "native-operator-1.jsonl"), RECORD);
	write(operatorSessionsFile(sessions), jsonl([{ at: AT, session_file: join(sessions, "native-operator-1.jsonl") }]));
	write(join(sessions, "cp-parent-control.json"), { model: "anthropic/claude-x" });
	assert.deepEqual([await badge("#sessions?view=you"), await badge("#sessions?view=parent")], ["Claude CLI", "unknown"]);
});
