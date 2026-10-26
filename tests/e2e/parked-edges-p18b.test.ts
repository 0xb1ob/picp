/**
 * Behavior 18 (P18b): the human_handoff decision and the awaiting-merge watch on their real faults — a garbage
 * registry, an unreadable CI, a dirty worktree, GitHub refusals, overlapping sweeps — through the landing stack.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { git, readRunEvents, REPO_ROOT } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { json, mergedCalls, run as ciRun, SKIP, startStack } from "./landing-helpers.ts";

test("P18-parked-edges: review first, a garbage registry, an unreadable merge state and a dirty worktree never park; the watch backs off GitHub's refusals", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("P18b handoff edges", 191);
	await s.post.registry.setMergePolicy("demo", "human_handoff");
	const rows = () => s.post.awaiting.list().filter((item) => item.job_id === live.jobId && item.subject?.startsWith("human-review pr "));
	const parks = () => readRunEvents(s.home, live.jobId).filter((e) => e.source === "cp" && e.type === "awaiting_merge_parked").length;
	const green = (head: string, permission: string | null = "CLEAN") => s.setGh({ integration: true, permission, runs: [ciRun(191, head, "completed", "success")], routes: [] } as never);
	const leased = s.post.fleet.require(live.jobId).lease_id;
	green(live.head);
	await s.tick(live.jobId);

	const unreviewed = await s.integrate(live.jobId);
	assert.equal(unreviewed.record.next, "review", unreviewed.text);
	assert.deepEqual([rows().length, parks(), s.post.fleet.require(live.jobId).phase], [0, 0, "held"], "no unreviewed head is handed off");
	writeWindowPass(s.home, live.jobId, live.head, isoTimestamp());

	const registry = join(s.home, LAYOUT.projectsFile);
	const saved = readFileSync(registry, "utf8");
	writeFileSync(registry, "{");
	const blind = await s.integrate(live.jobId);
	writeFileSync(registry, saved);
	assert.equal(blind.record.next, "surface", blind.text);
	assert.match(blind.record.reason, /could not be read.*Nothing was merged/s, "an unreadable registry fails closed");
	assert.deepEqual([mergedCalls(s.ghCalls()), rows().length, parks()], [[], 0, 0]);

	s.post.registry.setMergePolicy("demo", "human_handoff");
	writeFileSync(join(s.home, paths.ciEvidenceFile(live.jobId)), JSON.stringify({ schema_version: 1, job_id: live.jobId, repo: "example/demo",
		observations: [{ head_sha: live.head, result: "success", source: "forwarded", observed_at: isoTimestamp(), operator_quote: "CI is green on that head." }] }));
	green(live.head, null);
	const unread = await s.integrate(live.jobId);
	assert.match(unread.text, /CI or merge state unreadable — not handed off/, "a forwarded green never hands off a PR whose merge state is unreadable");
	assert.deepEqual([unread.record.next, rows().length, parks()], ["surface", 0, 0], "the fallback declares no row");
	s.setGh({ integration: true, permission: "CLEAN", runs: [], routes: [{ match: "actions/runs", replies: [{ code: 1, stderr: "HTTP 502: Bad Gateway" }] }] } as never);
	const noCi = await s.integrate(live.jobId);
	assert.match(noCi.text, /could not read CI/i, "a forwarded green never stands in for an unreadable CI read");
	assert.deepEqual([mergedCalls(s.ghCalls()), rows().length, parks()], [[], 0, 0], "nothing handed off on unreadable CI");

	green(live.head, "UNSTABLE");
	await s.tick(live.jobId);
	const unstable = await s.integrate(live.jobId);
	assert.doesNotMatch(unstable.text, /human_handoff/, "a default verdict leaves the repo path to run");
	assert.deepEqual([mergedCalls(s.ghCalls()), rows().length, parks()], [[], 0, 0]);

	writeFileSync(join(live.worktree, "stray.txt"), "left behind\n");
	green(live.head, "BLOCKED");
	const dirty = await s.integrate(live.jobId);
	assert.match(dirty.text, /Not parked \(gate_refused\)/, "unknown_block hands off; the dirty worktree refuses the park");
	const row = rows();
	assert.equal(row.length, 1, "the fallback human-review row");
	assert.match(row[0]!.decision, new RegExp(live.head.slice(0, 12)));
	assert.deepEqual([s.post.fleet.require(live.jobId).phase, s.post.fleet.require(live.jobId).lease_id, parks()], ["held", leased, 0], "held with its lease");

	// Policy and GitHub's verdict through one dirty worktree: a handoff reaches the refused park, the repo path never.
	const view = (over: object) => ({ match: "pr view", replies: [json({ number: 191, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", headRefName: live.jobId,
		headRefOid: live.head, baseRefName: "main", isDraft: false, autoMergeRequest: null, mergeStateStatus: "CLEAN", ...over })] });
	const rules = { match: "rules/branches", replies: [json([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }])] };
	const verdicts: [string, boolean, object[], RegExp][] = [["CLEAN", true, [], /mergeStateStatus=CLEAN/], ["BEHIND", true, [], /behind/],
		["BLOCKED", true, [view({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" })], /reviewDecision=REVIEW_REQUIRED/],
		["BLOCKED", false, [rules], /required check/], ["DRAFT", false, [], /draft/], ["UNKNOWN", false, [], /still computing/],
		["DIRTY", false, [], /conflict/]];
	for (const [state, hands, routes, why] of verdicts) {
		s.setGh({ integration: true, permission: state, runs: [ciRun(191, live.head, "completed", "success")], routes } as never);
		const told = await s.integrate(live.jobId);
		assert.match(told.text, why, `${state}: ${told.text}`);
		assert.equal(/Not parked \(gate_refused\)/.test(told.text), hands, `${state} ${routes.length}: ${told.text}`);
	}
	const demo = (JSON.parse(saved) as { projects: { name: string }[] }).projects.find((p) => p.name === "demo")!;
	for (const [why, projects] of [["an explicit repo policy", [{ ...demo, merge_policy: "repo" }]], ["an unregistered project", []]] as const) {
		writeFileSync(registry, JSON.stringify({ ...JSON.parse(saved), projects }));
		green(live.head, "BLOCKED");
		const told = await s.integrate(live.jobId);
		assert.match(told.text, /BLOCKED/, `${why}: ${told.text}`);
		assert.doesNotMatch(told.text, /human_handoff|Not parked/, `${why} takes the repo path: ${told.text}`);
	}
	writeFileSync(registry, saved);
	assert.deepEqual([mergedCalls(s.ghCalls()), rows().length, parks()], [[], 1, 0], "no verdict merges or parks the dirty worktree");

	git(live.worktree, "add", "stray.txt");
	git(live.worktree, "commit", "--quiet", "-m", "stray");
	git(live.worktree, "push", "--quiet", "origin", live.jobId);
	const moved = git(live.worktree, "rev-parse", "HEAD");
	writeFileSync(join(live.worktree, "stray2.txt"), "again\n");
	writeWindowPass(s.home, live.jobId, moved, isoTimestamp());
	green(moved);
	await s.tick(live.jobId);
	await s.integrate(live.jobId);
	const again = rows();
	assert.deepEqual([again.length, again[0]?.id], [1, row[0]!.id], "one row per PR, updated in place");
	assert.match(again[0]!.decision, new RegExp(moved.slice(0, 12)));

	rmSync(join(live.worktree, "stray2.txt"));
	s.setGh({ integration: true, permission: "CLEAN", runs: [ciRun(191, moved, "completed", "success")], routes: [view({ headRefOid: moved, baseRefName: "" })] } as never);
	const baseless = await s.integrate(live.jobId);
	assert.match(baseless.text, /Not parked \(not_parkable\)/, "no observed base never parks");
	assert.deepEqual([rows().length, parks()], [1, 0], "a refused park keeps today's row");
	green(moved);
	const parked = await s.integrate(live.jobId);
	assert.match(parked.text, new RegExp(`parked with the team at ${moved.slice(0, 12)}`), parked.text);
	assert.equal(s.post.awaiting.get(row[0]!.id)?.state, "withdrawn", "a park withdraws the fallback row");

	// The watch on GitHub's refusals: path-less errors, a failed gh and a low rate limit back off; time passing is the
	// backoff_until removed from disk. A per-PR error keeps the last observation.
	const handed = s.post.fleet.require(live.jobId).awaiting_merge!.handed_at;
	const child = await s.held("P18b stacked child", 192);
	assert.equal(s.post.fleet.require(child.jobId).phase, "held", "a parked job is no occupancy for others");
	const watchPath = join(s.home, LAYOUT.awaitingMergeWatchFile);
	const watch = () => JSON.parse(readFileSync(watchPath, "utf8")) as { backoff_until?: string; last_error?: string; prs: { cursors: Record<string, string> }[] };
	const later = () => writeFileSync(watchPath, JSON.stringify({ ...watch(), backoff_until: undefined }));
	const page = (nodes: object[] = [], endCursor: string | null = null) => ({ pageInfo: { hasNextPage: false, endCursor }, nodes });
	const pr = (over: object = {}) => ({ url: live.prUrl, number: 191, state: "OPEN", headRefOid: moved, headRefName: live.jobId, baseRefName: "main", mergedAt: null,
		mergeCommit: null, latestOpinionatedReviews: { nodes: [] }, comments: page(), reviews: page(), ...over });
	const body = (over: object = {}, stacked: object[] = [], rate = 5000) => json({ data: { rateLimit: { remaining: rate, resetAt: "2099-01-01T00:00:00Z" }, p0: { pullRequest: pr(over), stacked: { nodes: stacked } } } });
	const answer = (...replies: object[]) => s.setGh({ integration: true, permission: "CLEAN", runs: [ciRun(193, moved, "completed", "success")],
		routes: [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }, { match: "api graphql", replies }] } as never);
	const graphql = () => s.ghCalls().filter((call) => call.startsWith("api graphql")).length;
	const sweep = () => s.post.awaitingMerge.sweep();

	answer(json({ errors: [{ message: "Bad credentials" }] }));
	const denied = await sweep();
	assert.deepEqual([typeof denied.backoff_until, denied.observed], ["string", 0], "a path-less error batch is a runner failure");
	assert.match(watch().last_error ?? "", /Bad credentials/);
	const asked = graphql();
	assert.match((await sweep()).skipped ?? "", /backing off/);
	assert.equal(graphql(), asked, "a backing-off watch asks GitHub nothing");
	later();
	answer({ code: 1, stderr: "gh: network down" });
	assert.equal(typeof (await sweep()).backoff_until, "string", "a failed gh backs off");
	later();
	answer(body({}, [], 10));
	assert.equal((await sweep()).backoff_until, "2099-01-01T00:00:00Z", "a low rate limit waits for its reset");
	later();
	const seen = watch().prs;
	answer(json({ data: { rateLimit: { remaining: 5000 }, p0: null }, errors: [{ message: "Could not resolve to a PullRequest", path: ["p0"] }] }));
	assert.match((await sweep()).errors.join("\n"), /Could not resolve to a PullRequest; its last observation stands/);
	assert.deepEqual(watch().prs.map((p) => p.cursors), seen.map((p) => p.cursors));

	// Bots, the CP's own login and pre-handoff comments wake nobody, yet the cursor advances; a stacked job is an edge.
	const at = (ms: number) => isoTimestamp(new Date(Date.parse(handed) + ms));
	const by = (login: string, __typename = "User") => ({ login, __typename });
	answer(body({ comments: page([{ id: "IC_old", createdAt: at(-60_000), author: by("ann") }, { id: "IC_bot", createdAt: at(1_000), author: by("ci", "Bot") },
		{ id: "IC_cp", createdAt: at(1_000), author: by("e2e") }], "C1") }, [{ headRefName: child.jobId }, { headRefName: "someone-else" }]));
	assert.deepEqual((await sweep()).outcomes.map((o) => o.applied), ["none"], "no human event");
	assert.equal(watch().prs[0]?.cursors.comments, "C1", "the comment cursor advances");
	const edges = JSON.parse(readFileSync(join(s.home, LAYOUT.stackFollowupsFile), "utf8")).edges as { parent_job: string; child_job: string }[];
	assert.deepEqual(edges.map((e) => [e.parent_job, e.child_job]), [[live.jobId, child.jobId]], "only the live stacked job");

	// Overlapping sweeps run one. A moved head outranks a review in one snapshot, and a CI store that cannot be read
	// skips nothing; a lower event never clobbers the pending exit, a close does.
	const gate = join(s.home, "graphql.gate");
	const ciWatch = join(s.home, LAYOUT.ciWatchFile);
	rmSync(ciWatch, { force: true });
	mkdirSync(join(ciWatch, "x"), { recursive: true });
	answer({ ...body({ headRefOid: "e".repeat(40), reviews: page([{ id: "PRR_1", state: "CHANGES_REQUESTED", body: "", createdAt: at(2_000), author: by("ann"), comments: { totalCount: 0 } }], "R1") }), untilFile: gate });
	const first = sweep();
	await new Promise((done) => setTimeout(done, 200));
	assert.equal((await sweep()).skipped, "a sweep is already running");
	writeFileSync(gate, "");
	const outranked = await first;
	rmSync(ciWatch, { recursive: true });
	assert.deepEqual(outranked.outcomes.map((o) => o.applied), ["head_moved"], "a moved head outranks the review");
	assert.match(outranked.errors.join("\n"), /native CI not recorded/, "a CI store fault skips nothing");
	assert.equal(s.post.fleet.require(live.jobId).awaiting_merge?.last_human_activity_at, at(2_000), "the review is the last human activity");
	const ciReads = (from: number) => s.ghCalls().slice(from).filter((call) => call.includes("actions/runs")).length;
	const opened = s.ghCalls().length;
	answer(body({ comments: page([{ id: "IC_h", createdAt: at(3_000), author: by("ann") }], "C2") }));
	await sweep();
	assert.equal(s.post.fleet.require(live.jobId).awaiting_merge?.pending?.kind, "head_moved", "a human comment never clobbers it");
	assert.ok(ciReads(opened) > 0, "an open snapshot reads its head's CI");
	const closing = s.ghCalls().length;
	answer(body({ state: "CLOSED" }));
	await sweep();
	assert.equal(ciReads(closing), 0, "a closed snapshot reads no CI");
	assert.equal(s.post.fleet.require(live.jobId).awaiting_merge?.pending?.kind, "closed_unmerged", "a close does");

	// A garbage fleet file on disk: each sweep reports it, and one recovery wake is journaled for the cause.
	const fleetPath = join(s.home, LAYOUT.fleetFile);
	const fleet = readFileSync(fleetPath, "utf8");
	const recoveries = () => s.post.durableWakeups.read().pending.filter((w) => w.kind === "recovery").map((w) => w.id);
	const before = recoveries();
	writeFileSync(fleetPath, "{");
	const broken = [await sweep(), await sweep()];
	writeFileSync(fleetPath, fleet);
	for (const result of broken) assert.match(result.errors.join("\n"), /fleet\.json is not valid JSON/, "a garbage fleet file is reported");
	assert.equal(recoveries().filter((id) => !before.includes(id)).length, 1, "one wake for the same cause");
	const other = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: process.env });
	t.after(() => other.shutdown());
	const asking = s.ghCalls().length;
	assert.equal((await other.awaitingMerge.sweep()).skipped, "this process does not hold the home", "a session without the home lock sweeps nothing");
	assert.equal(s.ghCalls().length, asking, "and asks GitHub nothing");

	// Mislabelled records on disk are refused by the reader that meets them: the fleet and watch file by the sweep, a
	// stack edge to itself by its recording, a park intent at an unknown stage by startup recovery.
	const jobs = JSON.parse(fleet).jobs as { job_id: string; worker: object; awaiting_merge: object }[];
	const mine = jobs.find((j) => j.job_id === live.jobId)!;
	const bad: [string, object][] = [["no parking record", { awaiting_merge: undefined }], ["live worker", { worker: { ...mine.worker, exited_at: undefined } }],
		["held lease", { lease_id: "lease-1" }], ["checkpoint ref", { checkpoint_ref: "refs/cp-checkpoints/x" }], ["research job", { kind: "research" }],
		["local delivery", { delivery: "local" }], ["no envelope", { reported_at: undefined }], ["record on a held job", { phase: "held" }],
		["branch mismatch", { awaiting_merge: { ...mine.awaiting_merge, branch: "other" } }], ["short sha", { awaiting_merge: { ...mine.awaiting_merge, head_sha: "abc1234" } }]];
	for (const [why, over] of bad) {
		writeFileSync(fleetPath, JSON.stringify({ ...JSON.parse(fleet), jobs: jobs.map((j) => (j === mine ? { ...j, ...over } : j)) }));
		assert.match((await sweep()).errors.join("\n"), /violates the fleet contract/, `a fleet record with ${why} is refused`);
	}
	const copies = Array.from({ length: 25 }, (_, i) => ({ ...mine, job_id: `cp-copy-${i}`, branch: `cp-copy-${i}`,
		awaiting_merge: { ...mine.awaiting_merge, branch: `cp-copy-${i}`, pr_url: `https://github.com/example/demo/pull/${300 + i}` } }));
	writeFileSync(fleetPath, JSON.stringify({ ...JSON.parse(fleet), jobs: [...jobs, ...copies] }));
	const batched = graphql();
	answer(body());
	const wide = await sweep();
	writeFileSync(fleetPath, fleet);
	assert.equal(graphql() - batched, 2, `26 parked PRs are asked in two batches: ${wide.errors.slice(0, 2).join("; ")}`);
	const row0 = watch().prs.find((p) => (p as { job_id?: string }).job_id === live.jobId)!;
	for (const [why, prs] of [["a merge without its sha", [{ ...row0, state: "merged" }]], ["two rows for one job", [row0, row0]]] as const) {
		writeFileSync(watchPath, JSON.stringify({ ...watch(), prs }));
		assert.match((await sweep()).errors.join("\n"), /not a valid awaiting-merge watch file/, why);
	}
	writeFileSync(watchPath, JSON.stringify({ ...watch(), prs: [row0] }));
	const stackPath = join(s.home, LAYOUT.stackFollowupsFile);
	const stack = JSON.parse(readFileSync(stackPath, "utf8"));
	writeFileSync(stackPath, JSON.stringify({ ...stack, edges: [{ ...stack.edges[0], child_job: live.jobId }] }));
	answer(body());
	assert.match((await sweep()).errors.join("\n"), /not a valid stack-followups file/, "an edge to itself is refused");
	writeFileSync(stackPath, JSON.stringify(stack));
	const intent = join(s.home, paths.parkIntentFile(live.jobId));
	writeFileSync(intent, JSON.stringify({ schema_version: 1, job_id: live.jobId, cycle: 1, stage: "parked", pr_url: live.prUrl, repo: "example/demo",
		branch: live.jobId, head_sha: moved, base: "main", created_at: handed, updated_at: handed }));
	const recovered = (await s.post.awaitingMerge.recover()).find((r) => r.job_id === live.jobId);
	assert.equal(!recovered?.parked && recovered?.failure.code, "intent_mismatch", "an unknown park stage is refused");
	rmSync(intent);

	// The team merges. A receipt that cannot be written keeps the cursors; then the merge outranks a moved head and a
	// review, closes the job, queues the stacked child's retarget and releases the armed dependent, once.
	const dependent = await s.post.ledger().create({ title: "after the parked PR", project: "demo", kind: "ship", delivery: "local" });
	await s.post.ledger().addDep(dependent.id, live.jobId);
	const hang = s.provider.addScript("p18b-dependent", [{ kind: "hang" }]);
	s.agentDir.writeModels(s.provider);
	writeFileSync(join(s.home, LAYOUT.armedDispatchFile), JSON.stringify({ schema_version: 1,
		entries: [{ job_id: dependent.id, request: { task: "after the merge", model: hang }, armed_at: handed, blockers: [live.jobId] }] }));
	const receipt = join(s.home, LAYOUT.runs, live.jobId, "merge.json");
	mkdirSync(join(receipt, "x"), { recursive: true });
	const kept = watch().prs.map((p) => p.cursors);
	answer(body({ state: "MERGED", headRefOid: "f".repeat(40), mergedAt: isoTimestamp(), mergeCommit: { oid: "9".repeat(40) },
		reviews: page([{ id: "PRR_2", state: "CHANGES_REQUESTED", body: "", createdAt: at(4_000), author: by("ann"), comments: { totalCount: 0 } }], "R2") }));
	const unwritable = await sweep();
	assert.match(unwritable.errors.join("\n"), /cursors kept/, "an unwritable receipt keeps the cursors");
	assert.deepEqual([s.post.fleet.require(live.jobId).phase, watch().prs.map((p) => p.cursors)], ["awaiting_merge", kept]);
	rmSync(receipt, { recursive: true });
	assert.deepEqual((await sweep()).outcomes.map((o) => o.applied), ["merged"], "a merge outranks a moved head and a review");
	assert.equal(JSON.parse(readFileSync(receipt, "utf8")).merge_commit_sha, "9".repeat(40), "the merge receipt is written");
	const closed = s.post.fleet.require(live.jobId);
	assert.deepEqual([closed.phase, closed.awaiting_merge?.cycle], ["done", 1], "a done record keeps its parking history");
	const retargets = () => (JSON.parse(readFileSync(stackPath, "utf8")).actions as { child_job: string; previous_base: string; target_base: string }[])
		.map((a) => [a.child_job, a.previous_base, a.target_base]);
	assert.deepEqual(retargets(), [[child.jobId, live.jobId, "main"]], "the stacked child is queued to retarget");
	assert.deepEqual(JSON.parse(readFileSync(join(s.home, LAYOUT.armedDispatchFile), "utf8")).entries, [], "the armed dependent is released");
	assert.equal(typeof s.post.fleet.get(dependent.id)?.dispatched_at, "string", "and dispatched");
	await sweep();
	assert.deepEqual(retargets(), [[child.jobId, live.jobId, "main"]], "a second sweep applies nothing again");
});
