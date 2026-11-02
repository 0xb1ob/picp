/**
 * P2 review guide: `GET /api/job/<id>` through `bin/cp-view` on a scratch home, and the served app in a linkedom tab
 * (tests/harness/dashboard.ts) at phone and desktop widths. DOM and responsive logic only, never pixel geometry.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import type { JobResponse, ReviewGuide } from "../../src/viewer/api-types.ts";
import { dashboard, openTab } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((c) => c.repeat(40)) as [string, string, string, string, string];
const GH = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : e.isSymbolicLink() ? "link" : readFileSync(join(dir, e.name)).toString("base64")]);

function seed(home: string) {
	const put = (file: string, value: unknown) => {
		const path = join(home, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, typeof value === "string" ? value : JSON.stringify(value));
		renameSync(`${path}.tmp`, path);
	};
	const run = (id: string, file: string) => join(LAYOUT.runs, id, file);
	const verdict = (id: string, attempt: number, head: string, value: string, over: object = {}) => put(run(id, `review-${attempt}.json`), {
		schema_version: 1, job_id: id, attempt, verdict: value, cause: value === "pass" ? "ok" : "quality", flags: FLAGS, reasons: [], model: "rev/model-1",
		decided_at: iso(200 - attempt * 10), head_sha: head, diff_stat: { files: 3, truncated: false }, ...over,
	});
	const parked = (id: string, project: string, pr: string, head: string, over: object = {}) => ({
		job_id: id, project, kind: "ship", delivery: "pr", phase: "awaiting_merge", branch: id, dispatched_at: iso(300), reported_at: iso(120),
		awaiting_merge: { cycle: 1, pr_url: pr, repo: pr.includes("gitlab") ? "g/p" : new URL(pr).pathname.split("/").slice(1, 3).join("/"), branch: id, head_sha: head, base: "main", handed_at: iso(120), released_at: iso(120), frozen_seconds: 600, frozen_usage: {}, ...over },
	});
	const watchRow = (id: string, pr: string, head: string, over: object = {}) => ({ job_id: id, cycle: 1, pr_url: pr, state: "open", head_sha: head, base: "main", cursors: {}, observed_at: iso(60), approvals: 0, approvals_required: null, ...over });
	const ciRow = (id: string, head: string, last_ci: string, observed: string | null = iso(40)) => ({ job_id: id, announced: [], head_sha: head, last_ci, last_checked_at: iso(35), ...(observed ? { head_observed_at: observed } : {}) });

	put(".pi-command-post/jobs.json", { jobs: [
		{ id: "cp-delta", title: "Widget export", status: "in_progress", labels: ["project:demo", "kind:ship"], blocked_by: [], description: "Ship the widget export.\nUse token=sekrit-value never." },
		...["cp-moved", "cp-equiv", "cp-lost", "cp-trunc", "cp-many", "cp-prose", "cp-cycle", "cp-held"].map((id) => ({ id, title: `Title ${id}`, status: "in_progress", labels: ["project:demo", "kind:ship"], blocked_by: [] })),
		{ id: "cp-alpha", title: "Alpha twelve", status: "in_progress", labels: ["project:alpha", "kind:ship"], blocked_by: [] },
		{ id: "cp-beta", title: "Beta twelve", status: "in_progress", labels: ["project:beta", "kind:ship"], blocked_by: [] },
		{ id: "cp-merged", title: "Merged one", status: "closed", labels: ["project:demo", "kind:ship"], blocked_by: [], closed_at: iso(5) },
	] });
	put(LAYOUT.fleetFile, { jobs: [
		parked("cp-delta", "demo", GH("o/r", 7), B),
		parked("cp-moved", "demo", GH("o/r", 8), B, { pending: { kind: "head_moved", event_id: "head:c", observed_at: iso(30), head_sha: C } }),
		parked("cp-equiv", "demo", GH("o/r", 9), B), parked("cp-lost", "demo", GH("o/r", 10), B),
		parked("cp-trunc", "demo", GH("o/r", 11), A), parked("cp-many", "demo", GH("o/r", 13), B),
		parked("cp-prose", "demo", "https://gitlab.com/g/p/-/merge_requests/3", A),
		parked("cp-alpha", "alpha", GH("o/alpha", 12), A), parked("cp-beta", "beta", GH("o/beta", 12), B),
		parked("cp-cycle", "demo", GH("o/r", 14), B, { cycle: 2, handed_at: iso(20), released_at: iso(20) }),
		{ job_id: "cp-held", project: "demo", kind: "ship", phase: "held", dispatched_at: iso(60) },
		{ job_id: "cp-merged", project: "demo", kind: "ship", phase: "done", worktree: join(home, "torn-down-worktree"), dispatched_at: iso(300), closed_at: iso(5) },
	] });
	put(LAYOUT.awaitingMergeWatchFile, { schema_version: 1, updated_at: iso(60), prs: [
		watchRow("cp-delta", GH("o/r", 7), B, { approvals: 1, approvals_required: 2, last_human_activity_at: iso(70) }),
		watchRow("cp-equiv", GH("o/r", 9), B), watchRow("cp-lost", GH("o/r", 10), B), watchRow("cp-many", GH("o/r", 13), B),
		watchRow("cp-prose", "https://gitlab.com/g/p/-/merge_requests/3", A),
		watchRow("cp-alpha", GH("o/alpha", 12), A), watchRow("cp-beta", GH("o/beta", 12), C),
		// The reopened job's only watch row is cycle 1's: its head, approvals and activity describe another hand-off.
		watchRow("cp-cycle", GH("o/r", 14), A, { observed_at: iso(100), approvals: 2, approvals_required: 1, last_human_activity_at: iso(90) }),
	] });
	put(LAYOUT.ciWatchFile, { schema_version: 1, updated_at: iso(35), jobs: [
		ciRow("cp-delta", B, "green"), ciRow("cp-moved", C, "in_progress", iso(32)), ciRow("cp-trunc", A, "unreadable", null),
		ciRow("cp-many", A, "unreadable"), ciRow("cp-cycle", B, "green", iso(50)),
	] });
	put(run("cp-moved", "events.jsonl"), `${JSON.stringify({ source: "cp", job_id: "cp-moved", ts: iso(100), type: "ci_observed", payload: { event: "ci_green", head_sha: B } })}\n`);
	put(paths.ciEvidenceFile("cp-trunc"), { schema_version: 1, job_id: "cp-trunc", repo: "o/r", observations: [{ head_sha: A, result: "success", source: "forwarded", observed_at: iso(45), operator_quote: "green on A." }] });

	verdict("cp-delta", 1, A, "revise", { revisions: ["Handle the empty list", "Handle  the empty list"], reasons: ["Missing null check, token=abc123secret"] });
	verdict("cp-delta", 2, B, "pass", { delta_from: A, reasons: ["Minor: naming"] });
	verdict("cp-moved", 1, B, "pass", { reasons: ["Fine"] });
	verdict("cp-equiv", 1, A, "pass", { delta_from: D, reasons: ["Original note"] });
	put(run("cp-equiv", `review-equivalent-${B}.json`), { schema_version: 1, job_id: "cp-equiv", attempt: 1, verdict: "pass", cause: "ok", flags: FLAGS, reasons: ["Original note"], model: "rev/model-1",
		decided_at: iso(150), head_sha: B, delta_from: D, diff_stat: { files: 3, truncated: false }, equivalent_to: { head_sha: A, attempt: 1 } });
	put(run("cp-lost", `review-equivalent-${B}.json`), { schema_version: 1, job_id: "cp-lost", attempt: 1, verdict: "pass", cause: "ok", flags: FLAGS, reasons: [],
		decided_at: iso(150), head_sha: B, diff_stat: { files: 1, truncated: false }, equivalent_to: { head_sha: A, attempt: 1 } });
	verdict("cp-trunc", 1, A, "pass", { diff_stat: { files: 412, truncated: true }, flags: { ...FLAGS, scope_growth: true } });
	verdict("cp-many", 1, A, "revise", { revisions: Array.from({ length: 8 }, (_, i) => `first-${i + 1}`) });
	verdict("cp-many", 2, B, "revise", { revisions: Array.from({ length: 6 }, (_, i) => `second-${i + 1}`) });
	// A legacy prose-only verdict: no model, flags or revisions; its prose names a path and a URL that are never links.
	put(run("cp-prose", "review-1.json"), { job_id: "cp-prose", attempt: 1, verdict: "pass", decided_at: iso(150), head_sha: A, diff_stat: { files: 2, truncated: false },
		reasons: ["See src/app.ts:12 and https://evil.example/x <script>alert(1)</script>"] });
	put(run("cp-prose", "review-2.json"), "{not json");
	put("outside.json", { schema_version: 1, job_id: "cp-prose", attempt: 3, verdict: "pass", decided_at: iso(10), head_sha: A, diff_stat: { files: 1, truncated: false }, reasons: ["escaped"] });
	symlinkSync(join(home, "outside.json"), join(home, run("cp-prose", "review-3.json")));
	verdict("cp-alpha", 1, A, "pass", { reasons: ["Alpha only"] });
	verdict("cp-beta", 1, B, "pass", { reasons: ["Beta only"] });
	verdict("cp-cycle", 1, A, "revise", { revisions: ["Cycle one ask"] });
	verdict("cp-cycle", 2, B, "pass", { delta_from: A });
	verdict("cp-held", 1, A, "pass");
	verdict("cp-merged", 1, A, "pass", { reasons: ["Merged note"] });
	put(run("cp-merged", "merge.json"), { job_id: "cp-merged", pr_url: GH("o/r", 15), merge_commit_sha: E, merged_at: iso(5) });
}

/** Fail-on-use gh, glab, pi, curl and wget, and a git that logs its argv before running the real one. */
function traps(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "cp-guide-traps-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	const realGit = (process.env.PATH ?? "").split(":").map((d) => join(d, "git")).find((p) => existsSync(p));
	assert.ok(realGit, "a git on PATH");
	const script = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
	for (const name of ["gh", "glab", "pi", "curl", "wget"]) script(name, `echo "${name} $*" >> '${log}'\nexit 97`);
	script("git", `echo "git $*" >> '${log}'\nexec '${realGit}' "$@"`);
	return { PATH: `${dir}:${process.env.PATH ?? ""}`, calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}

test("P2-review-guide: parked, moved, reopened, equivalent, truncated and merged PRs read as recorded, without a forge, agent or write", { timeout: 180_000 }, async (t) => {
	const trap = traps(t);
	const view = await dashboard(t, { requireTailnet: false, at: new Date(NOON).toISOString(), env: { PATH: trap.PATH }, seed: (_state, home) => seed(home) });
	const before = snapshot(view.home);
	const guide = async (id: string): Promise<ReviewGuide | null | undefined> => {
		const reply = await view.get(`/api/job/${id}`);
		assert.equal(reply.status, 200, `${id}: ${reply.text.slice(0, 200)}`);
		const value = (reply.body as unknown as JobResponse).review_guide;
		assert.doesNotMatch(JSON.stringify(value ?? null), /sekrit|abc123secret/, `${id}: a secret-shaped value is redacted in the guide`);
		return value;
	};

	const delta = (await guide("cp-delta"))!;
	assert.equal(delta.key, `demo|cp-delta|${GH("o/r", 7)}|${B}|2`, "keyed by project, job, PR URL, observed head and attempt");
	assert.deepEqual([delta.reviewed_head, delta.attempt, delta.verdict, delta.kind, delta.delta_from, delta.compare_href, delta.files_href],
		[B, 2, "pass", "delta", A, `https://github.com/o/r/compare/${A}..${B}`, `${GH("o/r", 7)}/files`]);
	assert.deepEqual([delta.observed_head, delta.freshness, delta.cycle, delta.handoff.state, delta.handoff.approvals, delta.handoff.approvals_required], [B, "current", 1, "with_team", 1, 2]);
	assert.equal(delta.task, "Ship the widget export. Use \u2022\u2022\u2022 never.");
	assert.deepEqual(delta.stops.map((s) => [s.attempt, s.list, s.historical, s.text]), [
		[2, "reasons", false, "Minor: naming"],
		[1, "revisions", true, "Handle the empty list"],
		[1, "reasons", true, "Missing null check, \u2022\u2022\u2022"],
	], "the passing attempt first, then the earlier concerns once each, historical");
	assert.deepEqual([delta.ci.head, delta.ci.state, delta.ci.source, delta.ci.read_failure, delta.ci.forwarded], [B, "green", "watch", false, null]);
	assert.deepEqual(delta.incomplete, []);

	const moved = (await guide("cp-moved"))!;
	assert.deepEqual([moved.reviewed_head, moved.observed_head, moved.observed_source, moved.freshness, moved.handoff.state, moved.handoff.pending], [B, C, "pending", "historical", "pending", "head_moved"],
		"a moved head makes B's guide historical at once");
	assert.deepEqual([moved.ci.head, moved.ci.state, moved.ci.source], [B, "green", "event"], "B's green stays B's, never C's");
	assert.equal(moved.kind, "full");

	const equiv = (await guide("cp-equiv"))!;
	assert.deepEqual([equiv.kind, equiv.reviewed_head, equiv.source_head, equiv.source_attempt, equiv.delta_from, equiv.compare_href, equiv.freshness], ["equivalent", B, A, 1, null, null, "current"],
		"a patch-equivalent pass credits attempt 1 on A; its copied delta base is no new delta");
	assert.deepEqual(equiv.stops.map((s) => [s.attempt, s.head, s.text]), [[1, A, "Original note"]]);
	assert.deepEqual(equiv.incomplete, []);
	assert.match((await guide("cp-lost"))!.incomplete.join("\n"), new RegExp(`source review \\(attempt 1 on ${A}\\) is not retained`));

	const trunc = (await guide("cp-trunc"))!;
	assert.deepEqual([trunc.truncated, trunc.file_count, trunc.flags, trunc.observed_head, trunc.freshness], [true, 412, ["scope_growth"], null, "unknown"], "no observation is unknown, never current");
	assert.deepEqual([trunc.ci.state, trunc.ci.read_failure, trunc.ci.forwarded?.ci], ["unreadable", true, "green"], "unreadable on this head, the forwarded green kept apart");

	const many = (await guide("cp-many"))!;
	assert.deepEqual([many.stops.length, many.omitted_count], [10, 4]);
	assert.deepEqual(many.stops.map((s) => s.text), [...Array.from({ length: 6 }, (_, i) => `second-${i + 1}`), "first-1", "first-2", "first-3", "first-4"]);
	assert.deepEqual([many.ci.state, many.ci.read_failure], ["missing", true], "a refused read on another head is a read failure, not this head's CI");

	const prose = (await guide("cp-prose"))!;
	assert.deepEqual([prose.reviewed_head, prose.kind, prose.model, prose.files_href, prose.compare_href], [A, "full", null, "https://gitlab.com/g/p/-/merge_requests/3/diffs", null]);
	assert.deepEqual(prose.stops.map((s) => s.text), ["See src/app.ts:12 and https://evil.example/x <script>alert(1)</script>"]);
	assert.match(prose.incomplete.join("\n"), /2 review records were unreadable or malformed and skipped/, "a malformed file and a symlink out of runs/");

	const [alpha, beta] = [(await guide("cp-alpha"))!, (await guide("cp-beta"))!];
	assert.deepEqual([alpha.project, alpha.pr_url, alpha.reviewed_head, alpha.observed_head, alpha.freshness, alpha.stops.map((s) => s.text)], ["alpha", GH("o/alpha", 12), A, A, "current", ["Alpha only"]]);
	assert.deepEqual([beta.project, beta.pr_url, beta.reviewed_head, beta.observed_head, beta.freshness, beta.stops.map((s) => s.text)], ["beta", GH("o/beta", 12), B, C, "historical", ["Beta only"]]);
	assert.notEqual(alpha.key, beta.key, "PR 12 in two projects shares no guide");

	const cycle = (await guide("cp-cycle"))!;
	assert.deepEqual([cycle.cycle, cycle.observed_head, cycle.freshness, cycle.handoff.approvals, cycle.handoff.last_human_activity_at, cycle.handoff.watched_at], [2, null, "unknown", null, null, null],
		"cycle 1's head, approvals and activity are never cycle 2's evidence");
	assert.deepEqual([cycle.reviewed_head, cycle.ci.state], [B, "green"]);

	const merged = (await guide("cp-merged"))!;
	assert.deepEqual([merged.freshness, merged.handoff.state, merged.handoff.merge_sha, merged.reviewed_head, merged.pr_url, merged.observed_head], ["historical", "merged", E, A, GH("o/r", 15), null]);
	assert.match(merged.incomplete.join("\n"), /Retained after merge/);
	assert.equal(await guide("cp-held"), null, "a job never handed off has no guide");

	// Phone: the guide sits above the tabs with both full SHAs, the first stop and the PR link; only links are clickable.
	const phone = await view.open("#job/cp-delta");
	const card = await phone.find(".job-detail-top .review-guide");
	assert.deepEqual(phone.$$(".review-guide h3").map((h) => h.textContent), ["Task and head", "Start here", "Since the previous review", "CI and remaining judgment", "Handoff status"]);
	assert.ok(phone.$(".job-detail-top + .job-tabs"), "the tabs still follow the top block");
	assert.deepEqual(phone.$$(".review-guide-task .review-guide-sha").map((el) => el.textContent), [B, B]);
	assert.match(card.textContent ?? "", /Minor: naming.*Handle the empty list.*not marked resolved/);
	assert.doesNotMatch((card.textContent ?? "").replaceAll("not marked resolved", ""), /resolved/i, "no concern is called resolved");
	assert.ok(phone.$(`.review-guide a[href="${GH("o/r", 7)}"]`), "PR link");
	assert.ok(phone.$(`.review-guide a[href="https://github.com/o/r/compare/${A}..${B}"]`), "the exact two-dot comparison");
	assert.equal(phone.$$(".review-guide button, .review-guide form, .review-guide input").length, 0, "the guide approves, merges or restarts nothing");
	const desk = await openTab(t, view.port, "#job/cp-delta", new Map(), undefined, {}, true);
	await desk.find(".job-detail-top .review-guide");
	assert.deepEqual(desk.$$(".review-guide-task .review-guide-sha").map((el) => el.textContent), [B, B]);
	assert.ok(desk.$(`.review-guide-files a[href="${GH("o/r", 7)}/files"]`), "PR Files ends Start here");

	const proseTab = await view.open("#job/cp-prose");
	await proseTab.find(".review-guide");
	assert.match(proseTab.$(".review-guide-start")?.textContent ?? "", /<script>alert\(1\)<\/script>/, "prose renders as text");
	assert.equal(proseTab.$$(".review-guide script").length, 0);
	assert.deepEqual(proseTab.$$(".review-guide-start a").map((a) => a.getAttribute("href")), ["https://gitlab.com/g/p/-/merge_requests/3/diffs"], "no invented location link");
	assert.equal(proseTab.$(".review-guide-files .review-guide-meta")?.textContent, "no validated file or line location is recorded; a path named in the text above is not checked",
		"prose citing src/app.ts:12 is not called location-free, nor validated");

	// Both With the team entry points carry an explicit Review guide link to the job page.
	const jobs = await view.open("#jobs");
	const fromJobs = await jobs.find("a.job-guide-link", (a) => a.getAttribute("href") === "#job/cp-delta");
	jobs.go(fromJobs.getAttribute("href")!);
	await jobs.find(".review-guide-task .review-guide-sha");
	const overview = await view.open("#overview");
	const fromOverview = await overview.find("a.overview-team-guide", (a) => a.getAttribute("href") === "#job/cp-alpha");
	overview.go(fromOverview.getAttribute("href")!);
	assert.match((await overview.find(".review-guide")).textContent ?? "", /Alpha only/);

	await guide("cp-delta");
	assert.deepEqual(snapshot(view.home), before, "reading and refreshing the guide wrote nothing and consumed no attempt");
	const calls = trap.calls();
	assert.ok(calls.some((c) => c.startsWith("git ")), "the trapped PATH is the viewer's own (its version read runs git)");
	assert.deepEqual(calls.filter((c) => !c.startsWith("git ")), [], "no gh, glab, pi, curl or wget");
	assert.deepEqual(calls.filter((c) => /^git (?:fetch|pull|push|clone|ls-remote|remote)\b/.test(c)), [], "no git network call");
});
