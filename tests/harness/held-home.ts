import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AwaitingStore } from "../../src/awaiting.ts";
import { DEFAULT_ORIGIN, DiffVerdictSchema, EMPTY_USAGE, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION,
	validate, validatePendingReview, type DiffVerdict, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { createMergeAskProbe } from "../../src/merge-ask.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { createScratchHome } from "./state.ts";
import { createScratchRepo } from "./scratch-repo.ts";

export const JOB = "cp-held";
export const PR = "https://github.com/example/demo/pull/58";

export function writeReviewPass(home: string, headSha: string): void {
	const verdict = {
		schema_version: SCHEMA_VERSION, job_id: JOB, attempt: 1, verdict: "pass", cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff does what the brief asked"], decided_at: "2026-09-05T10:30:21Z", head_sha: headSha,
		diff_stat: { files: 1, truncated: false },
	};
	const checked = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	const file = join(home, paths.reviewFile(JOB, 1));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(verdict)}\n`);
}

function writeFakeGh(bin: string, headFile: string, stateFile: string, logFile: string, prView: boolean): void {
	mkdirSync(bin, { recursive: true });
	const gh = join(bin, "gh");
	writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("fs");
const head = readFileSync(${JSON.stringify(headFile)}, "utf8").trim();
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
if (readFileSync(${JSON.stringify(stateFile)}, "utf8").trim() === "offline") {
  process.stderr.write("S20 gh api failed: 500\\n");
  process.exit(1);
}
if (args[0] === "api" && (args[1] || "").includes("/actions/runs?head_sha=")) {
  const [state, delay] = readFileSync(${JSON.stringify(stateFile)}, "utf8").trim().split(":");
  appendFileSync(${JSON.stringify(`${logFile}.states`)}, JSON.stringify({ state, at: Date.now() }) + "\\n");
  if (Number(delay)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay));
  if (state === "broken") { process.stderr.write("gh: 403\\n"); process.exit(1); }
  const run = ["green", "green2", "wrong-head"].includes(state)
    ? { id: state === "green2" ? 8 : 7, run_attempt: 1, conclusion: "success", status: "completed", head_sha: state === "wrong-head" ? "a".repeat(40) : head, name: "ci" }
    : { id: 7, run_attempt: 1, conclusion: state === "red" ? "failure" : null, status: state === "red" ? "completed" : "in_progress", head_sha: head, name: "ci" };
  process.stdout.write(JSON.stringify({ total_count: args[1].includes(head) ? 1 : 0, workflow_runs: args[1].includes(head) ? [run] : [] }));
  process.exit(0);
}
if (args[0] === "api" && (args[1] || "").includes("/jobs?")) {
  process.stdout.write(JSON.stringify({ total_count: 0, jobs: [] }));
  process.exit(0);
}
if (${prView} && args[0] === "pr" && args[1] === "view") {
  if (require("fs").existsSync(${JSON.stringify(`${headFile}.delay`)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(readFileSync(${JSON.stringify(`${headFile}.delay`)}, "utf8")) || 10_000);
    appendFileSync(${JSON.stringify(logFile)}, "fixture delay completed\\n");
  }
  process.stdout.write(JSON.stringify({
    number: 58, url: ${JSON.stringify(PR)}, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    headRefName: "cp-held", headRefOid: head, baseRefName: "main", isDraft: false, autoMergeRequest: null,
    ...(require("fs").existsSync(${JSON.stringify(`${headFile}.view`)}) ? JSON.parse(readFileSync(${JSON.stringify(`${headFile}.view`)}, "utf8")) : {}),
  }));
  process.exit(0);
}
if (args[0] === "api") {
  process.stdout.write(JSON.stringify({
    number: 58, html_url: ${JSON.stringify(PR)}, state: "open", merged: false, head: { sha: head, ref: "cp-held" },
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`);
	chmodSync(gh, 0o755);
}

function writeReviewPending(home: string, headSha: string): void {
	const pending = {
		schema_version: SCHEMA_VERSION, job_id: JOB, surface: "review", attempt: 1, model: "mock/mock-model",
		pid: process.pid, started_at: isoTimestamp(), deadline: isoTimestamp(new Date(Date.now() + 3_600_000)),
		handed_back: true, subject: { head_sha: headSha, branch: JOB, files: 1, truncated: false },
	};
	const checked = validatePendingReview(pending);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	const file = join(home, paths.pendingReviewFile(JOB, "review", 1));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(pending)}\n`);
}

export async function seedHeldHome(options: { ciState: "green" | "red" | "in_progress"; review?: "pass" | "pending" | "none" }) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	repo.git("checkout", "-b", "cp-held");
	repo.write("held.txt", "held\n");
	const headSha = repo.commitAll("held work");
	repo.git("push", "--quiet", "-u", "origin", "cp-held");
	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote!, delivery: "pr" });
	const clone = join(home.path, LAYOUT.projects, "demo");
	execFileSync("git", ["clone", "--quiet", repo.remote!, clone]);
	const fleet = new FleetStore({ home: home.path });
	const record: FleetRecord = {
		job_id: JOB, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held",
		worker: { pid: process.pid, session_id: "sess-held", session_file: "/nonexistent/sess-held.jsonl",
			profile: "implementer", role: "implementer", model: "mock/mock-model", started_at: isoTimestamp() },
		worktree: "/tmp/worktrees/demo-held", branch: JOB, dispatched_at: isoTimestamp(), reported_at: isoTimestamp(),
		usage: EMPTY_USAGE, receipts: [{ kind: "pr", status: "open", title: "PR for cp-held", url: PR }],
	};
	await fleet.add(record);
	if (options.review === "pending") {
		writeReviewPending(home.path, headSha);
		// The child cannot reach the seeded orphan; its restart notice was already relayed.
		const outbox = new DurableWakeupOutbox({ home: home.path });
		outbox.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "RESTART RECOVERY — relayed by the previous parent", keys: [JOB] });
		outbox.confirmDelivered([`recovery:${JOB}`]);
	} else if (options.review !== "none") writeReviewPass(home.path, headSha);
	const store = new AwaitingStore({ home: home.path, mergeAsk: createMergeAskProbe({
		head: async () => ({ sha: headSha }),
		runs: async () => options.ciState === "green"
			? [{ status: "completed", conclusion: "success", headSha, workflowName: "ci" }]
			: [{ status: "in_progress", conclusion: null, headSha, workflowName: "ci" }],
		reviewedHeads: () => [headSha],
	}) });
	const declared = await store.declareGated({ type: "approval", decision: "Ship cp-held (PR 58), drop it, or open a follow-up?",
		why: "the change is verified", blocks: "cp-held delivery", job_id: JOB });
	const bin = join(home.path, "bin");
	const stateFile = join(home.path, "gh-state");
	const headFile = join(home.path, "gh-head");
	const ghLog = join(home.path, "gh-calls.log");
	writeFileSync(stateFile, `${options.ciState}\n`);
	writeFileSync(headFile, `${headSha}\n`);
	writeFileSync(ghLog, "");
	writeFakeGh(bin, headFile, stateFile, ghLog, options.review === "pending" || options.review === "none");
	return { home, repo, headSha, declared, store, bin, stateFile, headFile, ghLog };
}
