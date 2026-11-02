/**
 * E2 (self-review C, S1-09..S1-16): continuation and finalization notes reach the real dispatched worker's model input,
 * and a scripted replay through real read/bash/report_result keeps the unchanged controls: one CI status snapshot, an
 * unmetered failure-log read, bounded report repair, one accepted report. Scripted steps prove plumbing, not compliance.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type EnvelopeRecord, MINIMAL_PLAN_SUMMARY, paths } from "../../src/contracts.ts";
import { routeNamed, type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";
import { type PackageBench, packageBench } from "../harness/package-home.ts";

const SKIP = treehouseAvailable() ? false : "worker-prompt-e2 e2e needs treehouse on PATH";
const HANG: ScriptStep = { kind: "hang" };
const PR = "https://github.com/org/repo/pull/9";
const ASSESSMENT = { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false };
const SENTINEL = "E2-LONG-ACCEPTANCE: the last page names this acceptance.";
const NOTE = "Continuation note: task read 1-2000 and 2001-EOF; unmet acceptance: E2-LONG-ACCEPTANCE; failed checks: false exit 1; CI snapshot used; next action: report.";

const A = [
	"Discover paths and declared checks before use; check an interpreter before calling it.",
	"Resolve authorized git metadata paths with `git rev-parse --git-path <name>`, never `.git/<name>`.",
];
const B = [
	"Keep a continuation note: task path and read ranges through EOF, unmet acceptance, failed checks with exit codes, CI snapshot used, next action.",
	"Resume at the first unread range after truncation; retain this note across compaction, not settled history.",
	"Before the final tree check, prepare the payload: artifact exists if named, full HEAD/base SHAs copied, summary within 3 lines/600 characters.",
	"After acceptance, stop; after rejection, correct only the named defect within the existing cap.",
];
const C = [
	"Track task read ranges through EOF and unmet acceptance across compaction; resume truncation at the first unread range.",
	"Settle board content before writing it.",
	"Before the final tree check, prepare the payload: artifact exists, approach at most 3 items, touched bare paths, headlines at most 24 words.",
	"After acceptance, stop; repair only the named rejection within the existing cap.",
];
const D = [
	"Run checks separately and preserve each exit code; a no-match search is not a failed test.",
	"Fix explicit diagnostics before retrying a timeout.",
];
const G = ["At the first refusal, follow its named remedy; try no variants."];

const call = (name: string, args: unknown): ScriptStep => ({ kind: "tool_calls", calls: [{ name, args }] });
const bash = (command: string) => call("bash", { command });
const json = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;
const sent = (f: PackageBench, script: string, index: number) => JSON.stringify(f.provider.requests(script)[index]?.body.messages ?? []);
const assertSentences = (input: string, sentences: string[], where: string) => {
	for (const sentence of sentences) assert.ok(input.includes(JSON.stringify(sentence).slice(1, -1)), `${where} lacks: ${sentence}`);
};
const toolEnds = (f: PackageBench, jobId: string) => {
	const file = join(f.home, paths.eventsFile(jobId));
	return (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []).map((line) => JSON.parse(line) as { payload?: Record<string, unknown> })
		.filter((event) => event.payload?.type === "tool_execution_end")
		.map(({ payload = {} }) => ({ tool: String(payload.toolName), text: JSON.stringify(payload.result ?? {}) }));
};
const record = (f: PackageBench, id: string) => json<EnvelopeRecord>(join(f.home, paths.envelopeFile(id)));
const reported = (f: PackageBench, jobId: string) =>
	waitFor(() => f.post.fleet.get(jobId)?.reported_at, Boolean, { timeoutMs: 120_000, what: `${jobId}'s accepted envelope` });

async function dispatch(f: PackageBench, slug: string, kind: "ship" | "research", delivery: "pr" | "pipeline" | "board",
	steps: (jobId: string) => ScriptStep[], taskFile?: string) {
	const jobId = await f.job(slug, kind, delivery as "pr");
	const model = f.script(slug, steps(jobId));
	routeNamed(f.home, [model]);
	await f.post.dispatch({ jobId, ...(taskFile ? { taskFile } : { task: "Do the job." }), model, fetch: false });
	return jobId;
}

/** A fake `gh` on PATH is the one external boundary: it logs each invocation and answers status or a failure log. */
function fakeGh(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "cp-e2-gh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "gh.log");
	writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n*--log-failed*) echo "E2-FAILED-LOG: tests/x.test.ts failed";;\n*) echo '[{"conclusion":"failure","status":"completed"}]';;\nesac\n`);
	chmodSync(join(dir, "gh"), 0o755);
	return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("E2 ship worker: notes reach the implementer input; long-task read, checks, one CI snapshot, logs, git-path and report repair replay", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const gh = fakeGh(t);
	const f = await packageBench(t, { env: { PATH: `${gh.dir}:${process.env.PATH}` } });
	const head = (jobId: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.post.fleet.require(jobId).worktree, encoding: "utf8" }).trim();
	const shipped = (jobId: string, extra: Record<string, unknown> = {}) => ({ job_id: jobId, kind: "ship", status: "done",
		summary: "Implemented; focused checks green.", branch: jobId, head_sha: head(jobId), pr_url: PR, ...extra });
	const taskFile = join(f.home, "e2-long-task.md");
	writeFileSync(taskFile, `${Array.from({ length: 2100 }, (_, i) => `Requirement line ${i + 1}.`).join("\n")}\n${SENTINEL}\n`);

	// E2-valid: a correct report is accepted once and ends the model turn.
	const valid = await dispatch(f, "e2-valid", "ship", "pr", (id) => [call("report_result", () => shipped(id)), HANG]);
	// E2-long/check/snapshot/resume/logs/gitpath/sha in one worker process; the text step settles and the one nudge resumes it.
	const long = await dispatch(f, "e2-long", "ship", "pr", (id) => [
		call("read", { path: taskFile }),
		call("read", { path: taskFile, offset: 2001 }),
		bash("false"),
		bash("grep -c E2-NO-SUCH-TEXT README.md"),
		bash(`gh run list --branch ${id} --limit 3 --json conclusion,status,headSha,workflowName`),
		bash("git rev-parse --git-path e2e-probe"),
		{ kind: "text", text: NOTE },
		bash(`gh run list --branch ${id} --limit 3 --json conclusion,status,headSha,workflowName`),
		bash("gh run view 1 --log-failed"),
		call("report_result", () => shipped(id, { head_sha: "f".repeat(40) })),
		call("report_result", () => shipped(id)),
		HANG,
	], taskFile);
	for (const id of [valid, long]) await reported(f, id);

	const input = sent(f, "e2-valid", 0);
	assertSentences(input, [...A, ...B], "implementer role input (A/B)");
	assertSentences(input, [...D, ...G], "ship brief input (D/G)");
	assert.equal(input.split(JSON.stringify(G[0]).slice(1, -1)).length - 1, 1, "G appears once in the worker brief");
	assert.doesNotMatch(input, /lint/, "the scratch project declares no lint check (E2-discovery)");
	assert.equal(existsSync(join(f.post.fleet.require(valid).worktree, "package.json")), false);
	assert.deepEqual([record(f, valid).envelope, record(f, valid).attempt], [shipped(valid), 1], "E2-valid");
	assert.equal(f.provider.requests("e2-valid").length, 1, "an accepted report ends the model turn");

	const ends = toolEnds(f, long);
	const [page1, page2, failed, nomatch, status1, gitPath, status2, logs] = ends.map((end) => end.text);
	assert.ok(!page1?.includes(SENTINEL) && /offset=2001/.test(page1 ?? ""), "the first page is truncated before the acceptance");
	assert.ok(page2?.includes("E2-LONG-ACCEPTANCE"), "E2-long: the last-page acceptance is read");
	assert.match(failed ?? "", /Command exited with code 1/, "E2-check: a failed check keeps its exit code");
	assert.match(nomatch ?? "", /"output":"0\\n".*"exit_code":1/, "E2-check: the no-match search keeps its own count and exit code");
	assert.match(status1 ?? "", /conclusion/, "E2-snapshot: the first status query reaches gh");
	const worktree = f.post.fleet.require(long).worktree;
	const resolved = execFileSync("git", ["rev-parse", "--git-path", "e2e-probe"], { cwd: worktree, encoding: "utf8" }).trim();
	assert.ok(statSync(join(worktree, ".git")).isFile(), "E2-gitpath: the lease is a linked worktree, so .git/<name> is invalid");
	assert.ok(gitPath?.includes(resolved) && !resolved.startsWith(".git/"), "E2-gitpath: rev-parse resolves the linked metadata path");
	assert.equal(existsSync(resolved), false, "E2-gitpath: resolution mutates no metadata");
	assert.match(status2 ?? "", /already took its one CI status snapshot/, "E2-resume: the second status is refused after the nudge");
	assert.match(logs ?? "", /E2-FAILED-LOG/, "E2-logs: the failure log stays unmetered");
	assert.deepEqual(gh.calls().map((line) => line.split(" ").slice(0, 2).join(" ")), ["run list", "run view"], "fake gh ran one status and one log");

	const requests = f.provider.requests("e2-long");
	const resumed = JSON.stringify(requests[7]?.body.messages ?? []);
	for (const text of [NOTE, "E2-LONG-ACCEPTANCE", JSON.stringify(B[0]).slice(1, -1)]) assert.ok(resumed.includes(text), `E2-resume keeps ${text}`);
	assert.match(sent(f, "e2-long", 10), /is not HEAD of your worktree/, "E2-sha: the stale sha is refused");
	assert.deepEqual([record(f, long).envelope, record(f, long).attempt], [shipped(long), 2], "E2-sha: the corrected head is attempt 2");
	assert.equal(requests.length, 11, "the accepted report ends the turn");
});

test("E2 research worker: notes reach the planner input; missing artifact and oversize plan are repaired; board brief settles first", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await packageBench(t);
	const artifact = { kind: "tool_calls", calls: [{ name: "bash", args: { command: "printf '# Goal\\nE2.\\n' > \"$CP_ARTIFACT_PATH\"" } }] } as ScriptStep;
	const plan = (id: string, extra: Record<string, unknown> = {}) => () => ({ job_id: id, kind: "research", status: "done", summary: "Plan written.",
		artifact_path: f.post.artifacts.file(id), plan_summary: MINIMAL_PLAN_SUMMARY, self_assessment: ASSESSMENT, ...extra });
	const missing = await dispatch(f, "e2-artifact", "research", "pipeline", (id) => [call("report_result", plan(id)), artifact, call("report_result", plan(id)), HANG]);
	const fat = await dispatch(f, "e2-plan", "research", "pipeline", (id) => [artifact,
		call("report_result", plan(id, { plan_summary: { ...MINIMAL_PLAN_SUMMARY, approach: ["one", "two", "three", "four"] } })), call("report_result", plan(id)), HANG]);
	const board = await dispatch(f, "e2-board", "research", "board", () => [HANG]);
	for (const id of [missing, fat]) await reported(f, id);

	const input = sent(f, "e2-artifact", 0);
	assertSentences(input, [...C, ...D, ...G], "research brief input (C/D/G)");
	assert.match(sent(f, "e2-artifact", 1), /does not exist — write the findings before reporting/, "E2-artifact: a missing file is rejected");
	assert.deepEqual([record(f, missing).attempt, f.provider.requests("e2-artifact").length], [2, 3], "E2-artifact: the written file is accepted");
	// The tool schema refuses a fourth approach entry before the reporter runs, so the accepted report is attempt 1.
	assert.match(sent(f, "e2-plan", 2), /plan_summary\.approach: must not have more than 3 items/, "E2-plan: four entries are rejected");
	assert.deepEqual([record(f, fat).envelope.plan_summary?.approach, record(f, fat).attempt, f.provider.requests("e2-plan").length],
		[MINIMAL_PLAN_SUMMARY.approach, 1, 3], "E2-plan: the corrected plan is accepted");

	const boardInput = await waitFor(() => sent(f, "e2-board", 0), (text) => text.length > 2, { timeoutMs: 60_000, what: "board brief" });
	assertSentences(boardInput, [C[1]!, "For delivery:board, write `board.json` at that path", "the plan sections and `plan_summary` instructions below do"],
		"E2-board: settle-before-write and the board exceptions");
	assert.ok(f.post.fleet.get(board), "the board worker was dispatched");
});
