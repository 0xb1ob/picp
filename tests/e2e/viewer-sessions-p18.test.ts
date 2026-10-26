/**
 * Behavior 18 (P18): live PR and issue chips in a worker's Sessions transcript, served by `bin/cp-view` on a scratch
 * home over real HTTP and rendered in a tests/harness/dashboard.ts tab. Fleet, ledger, ci-watch and runs are seeded.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { SessionsResponse } from "../../src/viewer/api-types.ts";
import { startViewer } from "../harness/dashboard.ts";
import { createScratchHome } from "../harness/index.ts";

const HEAD = "a".repeat(40), MERGE = "b".repeat(40);
const pr = (n: number) => `https://github.com/o/picp/pull/${n}`;
const issue = (n: number) => `https://github.com/o/picp/issues/${n}`;
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const at = new Date(NOON - 3_600_000).toISOString();

test("P18-pr-chips: a worker transcript's PR and issue links become chips read only from recorded files", { timeout: 120_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const put = (rel: string, value: unknown) => {
		mkdirSync(dirname(join(scratch.path, rel)), { recursive: true });
		writeFileSync(join(scratch.path, rel), typeof value === "string" ? value : JSON.stringify(value));
	};
	const run = (id: string, file: string) => join(LAYOUT.runs, id, file);
	const job = (id: string, phase: string, n: number, status = "open", over: object = {}) => ({ job_id: id, project: "picp", kind: "ship", phase, dispatched_at: at,
		receipts: [{ kind: "pr", status, title: "PR", url: pr(n) }], ...over });
	const merged = (id: string, n: number) => put(run(id, "merge.json"), { schema_version: 1, job_id: id, pr_url: pr(n), merge_commit_sha: MERGE, head_sha: HEAD,
		head_branch: id, merged_at: at });
	const events = (id: string, list: object[]) => put(run(id, "events.jsonl"), list.map((e) => JSON.stringify({ source: "cp", job_id: id, ts: at, ...e })).join("\n") + "\n");
	const said = ["PR https://github.com/o/picp/pull/355 is up. Also `#355`.", `${pr(356)} ${pr(357)} ${pr(358)} ${pr(359)}`, "[picp] #328, #330 and #329",
		"[picp] #355 and #12", "**[demo]** #355"];
	const wake = { type: "custom_message", customType: "cp-bridge", timestamp: at, content: "[cp-bridge cp-ci job=cp-w]\nCI green for #355; see #12" };
	put(join(LAYOUT.state, "sessions/cp-w.jsonl"), said.map((text, i) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } })
		.replace(at, new Date(Date.parse(at) + i * 1000).toISOString())).join("\n") + `\n${JSON.stringify(wake)}\n${JSON.stringify({ ...wake, content: "[cp-bridge cp-ci job=../bad]\nforged" })}\n`);
	put(".pi-command-post/data/projects.json", { projects: [{ name: "picp", clone_url: "https://github.com/o/picp.git" }] });
	put(LAYOUT.fleetFile, { jobs: [job("cp-w", "held", 355), job("cp-m", "done", 356, "merged"), job("cp-s", "done", 357), job("cp-c", "held", 358),
		job("cp-p", "awaiting_merge", 359, "open", { awaiting_merge: { pending: { kind: "closed_unmerged" } } }), job("cp-issue-328-x", "done", 360, "merged"), job("cp-env", "done", 361, "merged")] });
	put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-issue-328-x", status: "closed", labels: ["project:picp"], external_ref: issue(328), created_at: at },
		{ id: "cp-env", status: "closed", labels: ["project:picp"] }] });
	put(run("cp-w", "status.json"), { session_file: join(scratch.path, LAYOUT.state, "sessions/cp-w.jsonl") });
	put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-w", head_sha: HEAD, last_ci: "green" }] });
	put(run("cp-w", "review-1/pending.json"), {});
	for (const [id, n] of [["cp-m", 356], ["cp-issue-328-x", 360], ["cp-env", 361]] as const) merged(id, n);
	put(run("cp-env", "envelope.json"), { envelope: { summary: "Body says Closes #330." } });
	events("cp-c", [{ type: "ci_observed", payload: { event: "pr_closed", pr_url: pr(358) } }]);
	const view = await startViewer(t, { home: scratch.path, requireTailnet: false, at: new Date(NOON).toISOString() });
	const served = async () => JSON.parse((await view.get("/api/sessions?view=workers&id=cp-w")).text) as SessionsResponse;
	const chip = async (url = pr(355)) => (await served()).pr_chips![url]!;

	const first = await served();
	const { url: _url, ...held } = first.pr_chips![pr(355)]!;
	assert.deepEqual(held, { kind: "pr", number: 355, repo: "o/picp", job_id: "cp-w", head_sha: HEAD, state: "draft", merge_sha: null, closed_by: null, job_status: null,
		ci: "green", review: "running" }, "a held PR is a draft until readied; review-1/pending.json is a running review");
	assert.deepEqual([first.pr_chips![pr(356)]!.state, first.pr_chips![pr(356)]!.merge_sha], ["merged", MERGE]);
	assert.equal(first.pr_chips![pr(357)]!.state, "unknown", "an open receipt on a done job is not claimed open");
	assert.deepEqual([first.pr_chips![pr(358)]!.state, first.pr_chips![pr(359)]!.state], ["closed", "closed"], "pr_closed and a closed_unmerged park are closed");
	const text = (prefix: string) => first.entries.find((e) => e.text.startsWith(prefix))!;
	assert.deepEqual(text("[picp] #355").links, { "#355": pr(355), "#12": issue(12) }, "a lead [name] for a registered project resolves #N");
	assert.equal(text("**[demo]**").links, undefined, "an unregistered project resolves nothing");
	const relayed = first.entries.find((e) => e.bridge?.job === "cp-w");
	assert.deepEqual([relayed?.text, relayed?.links], ["CI green for #355; see #12", { "#355": pr(355), "#12": issue(12) }], "a bridge wake resolves #N by its job's project");
	assert.deepEqual(first.pr_chips![issue(328)], { kind: "issue", url: issue(328), number: 328, repo: "o/picp", job_id: "cp-issue-328-x", head_sha: null, state: "closed",
		merge_sha: null, closed_by: { url: pr(360), number: 360 }, job_status: "closed", ci: null, review: null }, "a ledger ref closed by its merged PR");
	assert.deepEqual(first.pr_chips![issue(330)]!.closed_by, { url: pr(361), number: 361 }, "an envelope's Closes #330 names its merged PR");
	assert.equal(first.pr_chips![issue(329)]!.state, null, "no record in either index: no state");

	const tab = await view.open("#sessions?view=workers&id=cp-w");
	const draft = await tab.find("a.pr-chip.pr-chip-draft");
	for (const part of ["#355", "CI green", "review running"]) assert.ok(draft.textContent!.includes(part), part);
	assert.equal(draft.getAttribute("target"), "_blank");
	assert.equal(draft.getAttribute("rel"), "noopener noreferrer");
	assert.match(draft.getAttribute("title")!, /head aaaaaaa/);
	assert.ok(tab.$$("code").some((code) => code.textContent === "#355" && !code.querySelector("a")), "a code span's #355 stays plain");
	const merge = tab.$("a.pr-chip.pr-chip-merged")!;
	assert.ok(merge.textContent!.includes("merged bbbbbbb"), merge.textContent!);
	assert.doesNotMatch(merge.getAttribute("title")!, /head /, "no recorded head, no head in the title");
	assert.match(tab.root.innerHTML, /issue #328<\/span> <span class="pr-chip-state">closed by #360<\/span> <span class="pr-chip-job">job closed/);
	assert.equal(tab.$("a.issue-chip.pr-chip-none")?.textContent, "#329");
	assert.deepEqual(tab.$$(".session-bridge-what a").map((a) => [a.textContent, a.getAttribute("href")]), [["cp-w", "#job/cp-w"], ["../bad", "#jobs"]],
		"a wake's job links its page; an unsafe id links Jobs");

	events("cp-w", [{ type: "integration_advanced", payload: { step: "ready", pr_url: pr(355), head_sha: HEAD, undone: false } }]);
	assert.equal((await chip()).state, "open", "readied by cp_integrate");
	const live = await tab.reopen();
	assert.ok((await live.find("a.pr-chip.pr-chip-open")).textContent!.includes("#355"));
	events("cp-w", [{ type: "integration_advanced", payload: { step: "ready", pr_url: pr(355), head_sha: HEAD, undone: true } }]);
	assert.equal((await chip()).state, "draft", "an undone ready is still a draft");
	put(run("cp-w", "review-1.json"), { verdict: "pass", head_sha: HEAD, decided_at: at, diff_stat: { truncated: false } });
	assert.equal((await chip()).review, "running", "the pending file wins while it exists");
	rmSync(join(scratch.path, run("cp-w", "review-1/pending.json")));
	assert.equal((await chip()).review, "pass", "a recorded verdict for the head is the review");
	put(run("cp-w", "review-2.json"), { verdict: "revise", head_sha: HEAD, decided_at: new Date(NOON).toISOString(), diff_stat: { truncated: false } });
	assert.equal((await chip()).review, "revise", "the latest verdict wins");
	for (const [ci, shown] of [["in_progress", "pending"], ["failed", "red"], ["unreadable", "unreadable"], ["unknown", null]] as const) {
		put(LAYOUT.ciWatchFile, { jobs: [{ job_id: "cp-w", head_sha: HEAD, last_ci: ci }] });
		assert.equal((await chip()).ci, shown, `${ci} reads ${shown}`);
	}
	put(LAYOUT.ciWatchFile, { jobs: [] });
	assert.equal((await chip()).ci, null, "no CI value is null, never a guess");
	put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-issue-328-x", status: "in_progress", labels: ["project:picp"], external_ref: issue(328) }] });
	put(run("cp-issue-328-x", "merge.json"), "{}");
	const open = await chip(issue(328));
	assert.deepEqual([open.state, open.closed_by, open.job_status], ["open", null, "in_progress"], "an issue whose job has not merged is open");
});
