/** awaiting_merge PR5: the With-the-team section, frozen execution time and cost, and head-specific CI in the viewer. */

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type AwaitingMerge, DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { overview } from "../src/viewer/overview-view.ts";
import { jobsView } from "../src/viewer/jobs-view.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const AT = "2026-10-15T10:00:00Z";
const NOW = Date.parse("2026-10-15T12:00:00Z");

const parking = (over: Partial<AwaitingMerge> = {}): AwaitingMerge => ({
	cycle: 2, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: A, base: "main",
	handed_at: AT, released_at: AT, frozen_seconds: 600, frozen_usage: { ...EMPTY_USAGE, cost_usd: 1.5 }, ...over,
});
const parked = (id: string, over: Partial<AwaitingMerge> = {}): FleetRecord => ({
	job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "awaiting_merge",
	worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: AT, exited_at: AT, exit_code: 0 },
	worktree: "/tmp/worktrees/recycled", branch: id, dispatched_at: "2026-10-15T09:50:00Z", reported_at: AT,
	usage: { ...EMPTY_USAGE, cost_usd: 1.5, total_tokens: 100 }, awaiting_merge: parking({ branch: id, ...over }),
});
const ciEvent = (id: string, event: string, head: string) => JSON.stringify({ source: "cp", type: "ci_observed", ts: AT, job_id: id, payload: { event, head_sha: head } });

function bench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const put = (path: string, value: unknown) => {
		const full = join(home.path, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
	};
	const pending = parked("cp-pend", { pending: { kind: "head_moved", event_id: "head:b", observed_at: AT, head_sha: B } });
	put(LAYOUT.fleetFile, { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(), jobs: [parked("cp-park", { last_human_activity_at: "2026-10-15T10:30:00Z" }), parked("cp-bare"), pending] });
	put(LAYOUT.awaitingMergeWatchFile, { schema_version: 1, updated_at: AT, prs: [
		{ job_id: "cp-park", cycle: 2, pr_url: "https://github.com/o/r/pull/7", state: "open", head_sha: A, base: "main", approvals: 1, approvals_required: null, cursors: {}, last_human_activity_at: "2026-10-15T11:00:00Z", observed_at: AT },
		{ job_id: "cp-bare", cycle: 1, pr_url: "https://github.com/o/r/pull/7", state: "open", head_sha: A, base: "main", approvals: 3, approvals_required: 2, cursors: {}, observed_at: AT },
	] });
	put(`${LAYOUT.runs}/cp-park/events.jsonl`, `${[ciEvent("cp-park", "ci_failed", A), ciEvent("cp-park", "ci_green", A)].join("\n")}\n`);
	put(`${LAYOUT.runs}/cp-pend/events.jsonl`, `${ciEvent("cp-pend", "ci_green", A)}\n`);
	put(paths.ciEvidenceFile("cp-bare"), { schema_version: 1, job_id: "cp-bare", repo: "o/r", observations: [{ head_sha: A, result: "success", source: "forwarded", observed_at: AT, operator_quote: "green." }] });
	// A stale run status from the exited worker: parked usage is frozen, so it must not overlay the fleet total.
	put(`${LAYOUT.runs}/cp-park/status.json`, { job_id: "cp-park", phase: "working", started_at: AT, usage: { ...EMPTY_USAGE, cost_usd: 9, total_tokens: 900 } });
	return { home: home.path, state: { home: home.path, stateDir: join(home.path, LAYOUT.state) } };
}

test("overview: quiescent parked jobs are With the team with this cycle's approvals, head CI and latest human activity", (t) => {
	const { state } = bench(t);
	const data = overview(state, NOW);
	assert.deepEqual(data.with_team.map((j) => [j.id, j.approvals, j.approvals_required, j.ci, j.ci_forwarded?.ci ?? null, j.last_human_activity_at]), [
		["cp-park", 1, null, "green", null, "2026-10-15T11:00:00Z"],
		["cp-bare", null, null, null, "green", null],
	], "an older cycle's watch row is unknown, never its approvals");
	assert.deepEqual(data.in_flight.map((j) => j.id), ["cp-pend"], "only pending CP work is In flight");
	const later = overview(state, NOW + 3_600_000).with_team.find((j) => j.id === "cp-park")!;
	assert.equal(later.age_seconds, 10_800);
	assert.equal(later.frozen_seconds, 600, "team age grows; execution time does not");
});

test("overview: a pending parked row shows the moved head with no old-head CI and a frozen clock", (t) => {
	const { state } = bench(t);
	for (const now of [NOW, NOW + 3_600_000]) {
		const row = overview(state, now).in_flight.find((j) => j.id === "cp-pend")!;
		assert.deepEqual([row.phase, row.head, row.ci, row.parked_pending, row.elapsed_seconds], ["held", B, null, "head_moved", 600]);
	}
});

test("jobsView: parked jobs keep frozen duration and cost, the parked head's CI and their hand-off time", (t) => {
	const { state } = bench(t);
	const job = jobsView(state, NOW).jobs.find((j) => j.id === "cp-park")!;
	assert.deepEqual([job.phase, job.head, job.ci, job.elapsed_seconds, job.cost_usd, job.handed_at, job.parked_pending], ["awaiting_merge", A, "green", 600, 1.5, AT, null]);
	assert.equal(jobsView(state, NOW + 3_600_000).jobs.find((j) => j.id === "cp-park")?.elapsed_seconds, 600);
});

test("render: Overview and Jobs list parked PRs under With the team, never as In flight or 'no CI yet'", async (t) => {
	const { state } = bench(t);
	const bundle = await build({
		stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Overview} from "./viewer-app/screens/Overview.tsx"; import {Jobs} from "./viewer-app/screens/Jobs.tsx"; export const screen=(name,data)=>render(h({Overview,Jobs}[name],{data}));', loader: "tsx", resolveDir: REPO_ROOT },
		bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" },
	});
	const { screen } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`);
	const html: string = screen("Overview", overview(state, NOW));
	const team = html.slice(html.indexOf("With the team"));
	assert.match(html, /In flight &middot; 1|In flight · 1/);
	assert.match(team, /With the team (&middot;|·) 2/);
	assert.match(team, /1\/\? approvals/);
	assert.match(team, /approvals unknown/);
	assert.match(team, /CI green/);
	assert.match(team, /\(forwarded\)/);
	assert.doesNotMatch(team.slice(0, team.indexOf("Landed today")), /no CI yet/);
	assert.match(html, /head moved: review and CI again/);
	const jobs: string = screen("Jobs", jobsView(state, NOW));
	assert.match(jobs, /In flight · 1/);
	assert.match(jobs, /With the team · 2/);
});
