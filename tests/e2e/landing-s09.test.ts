/** Behavior 05 landing e2e, part of the split of landing.test.ts; fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { isoTimestamp, LAYOUT, paths } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { readMergeReceipt } from "../../src/merges.ts";
import { git, readRunEvents, REPO_ROOT, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, type RunRow, type Reply, type Route, run, json, runsBody, setupJob, startFakeGitlab, startStack, mergedCalls } from "./landing-helpers.ts";

test("landing S09: exact head and branch evidence distinguish pending, superseded and absent CI", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["pending", "older", "present", "none", "denied-branch", "malformed-branch", "invalid-branch", "branch-green", "denied-workflows", "network-workflows", "empty-workflows", "malformed-workflows"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 CI boundaries", 301);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const checkpoints = new CheckpointStore(s.home, { kind: "merge" });
		const scope = live.head.slice(0, 12);
		const routes: Route[] = [];
		let rows: RunRow[] = [];
		if (mode === "pending") rows = [run(301, live.head, "in_progress", null)];
		if (mode === "older") rows = [run(301, "b".repeat(40), "completed", "success")];
		if (mode === "older") routes.push({ match: "actions/runs?branch=", replies: [runsBody(rows)] });
		if (mode.endsWith("branch")) routes.push({ match: "actions/runs?branch=", replies: [mode === "denied-branch" ? { code: 1, stderr: "HTTP 403" } : mode === "malformed-branch" ? { stdout: "<html>502</html>" } : runsBody([run(301, "invalid", "completed", "success")])] });
		if (mode === "branch-green") routes.push({ match: "actions/runs?branch=", replies: [runsBody([run(301, live.head, "completed", "success")])] });
		const workflows = mode === "none" || mode.endsWith("branch") ? json({ total_count: 0, workflows: [] }) : mode === "denied-workflows" ? { code: 1, stderr: "HTTP 403" } : mode === "network-workflows" ? { code: 1, stderr: "dial tcp: no such host" } : mode === "empty-workflows" ? { code: 1, stdout: "" } : mode === "malformed-workflows" ? { stdout: "<html>502</html>" } : json({ total_count: 1, workflows: [{ id: 1, name: "ci" }] });
		routes.push({ match: "actions/workflows", replies: [workflows] });
		s.setGh({ integration: true, runs: rows, routes });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "none" ? "advance" : ["pending", "older"].includes(mode) ? "wait" : "surface", `${mode}: ${result.text}`);
		assert.equal(mergedCalls(result.calls).length, mode === "none" ? 1 : 0, mode);
		if (mode === "pending" || mode === "older") {
			assert.equal(checkpoints.get(live.jobId, { scope }), undefined);
			assert.ok(!result.calls.some((call) => call.includes("actions/workflows")));
		} else if (mode === "none") {
			assert.equal(result.record.record.merge_authority?.kind, "repo_derived");
			assert.equal(checkpoints.get(live.jobId, { scope }), undefined);
			assert.ok(result.record.facts.some((fact) => fact.startsWith("ci configuration: none (authoritative_empty)")));
		} else {
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "pending", mode);
			assert.ok(!result.record.facts.some((fact) => fact.startsWith("ci: green")), mode);
			if (mode.endsWith("branch")) assert.ok(result.record.facts.some((fact) => fact.startsWith("ci: branch runs unreadable")), result.text);
			if (mode === "branch-green") assert.ok(!result.calls.some((call) => call.includes("/attempts/")));
			if (mode.endsWith("workflows")) assert.ok(result.record.facts.some((fact) => fact.startsWith("ci configuration: unreadable (")), result.text);
		}
		if (mode === "present") {
			checkpoints.decide(live.jobId, true, { by: "operator command", scope });
			const approved = await s.integrate(live.jobId);
			assert.equal(approved.record.next, "advance", approved.text);
			assert.equal(approved.record.record.merge_authority?.kind, "human_checkpoint");
			assert.ok(approved.calls.some((call) => call.includes(`--match-head-commit ${live.head}`)));
		}
	});
});

test("landing S09: repository refusals and draft transitions preserve head authority", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["blocked", "approved-blocked", "unreadable-rules", "unstable", "no-ci-blocked", "auto", "moved", "unreviewed-draft", "stale-draft", "ready", "ready-unreadable-ci", "ready-moved", "ready-undo-refused", "ready-refused", "reminder"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 permission boundaries", 302);
		if (mode !== "unreviewed-draft") writeWindowPass(s.home, live.jobId, mode === "stale-draft" ? "b".repeat(40) : live.head, "2026-01-01T00:00:00Z");
		const view = { number: 302, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main", isDraft: false };
		if (mode === "approved-blocked") {
			const approved = new CheckpointStore(s.home, { kind: "merge" });
			const scope = live.head.slice(0, 12);
			approved.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			approved.decide(live.jobId, true, { by: "operator command", scope });
		}
		const changed = { ...view, ...(mode.includes("blocked") || mode === "unreadable-rules" || mode === "reminder" ? { mergeStateStatus: "BLOCKED", reviewDecision: mode === "unreadable-rules" ? "" : "REVIEW_REQUIRED" } : mode === "unstable" ? { mergeStateStatus: "UNSTABLE" } : mode === "auto" ? { autoMergeRequest: {} } : {}), ...(mode.includes("draft") || mode.startsWith("ready") ? { isDraft: true } : {}) };
		const routes: Route[] = [{ match: "pr view", replies: [json(changed), ...(mode === "moved" ? [json({ ...changed, headRefOid: "b".repeat(40) })] : mode === "ready-moved" || mode === "ready-undo-refused" ? [json(changed), json({ ...changed, isDraft: false, headRefOid: "b".repeat(40) })] : mode === "ready-unreadable-ci" ? [json(view)] : mode.startsWith("ready") ? [json(changed), json(view)] : [])] }];
		if (mode.startsWith("ready") && mode !== "ready-refused") routes.push({ match: "pr ready", replies: [{ stdout: "" }] });
		if (mode === "ready-refused") routes.unshift({ match: "pr ready", replies: [{ code: 1, stderr: "GraphQL: forbidden" }] });
		if (mode === "ready-undo-refused") routes.unshift({ match: "pr ready --undo", replies: [{ code: 1, stderr: "HTTP 502" }] });
		if (mode === "unreadable-rules") routes.push({ match: "rules/branches", replies: [{ code: 1, stderr: "HTTP 403" }] });
		if (mode === "no-ci-blocked" || mode === "ready-unreadable-ci") routes.push({ match: "actions/workflows", replies: [mode === "no-ci-blocked" ? json({ total_count: 0, workflows: [] }) : { code: 1, stderr: "HTTP 403" }] });
		s.setGh({ integration: true, runs: mode === "no-ci-blocked" || mode === "ready-unreadable-ci" ? [] : [run(302, live.head, "completed", "success")], routes });
		const result = await s.integrate(live.jobId);
		const expected = mode.endsWith("draft") ? "review" : mode === "moved" || mode === "ready-moved" ? "wait" : mode === "ready" || mode === "ready-unreadable-ci" ? "advance" : "surface";
		assert.equal(result.record.next, expected, `${mode}: ${result.text}`);
		assert.equal(mergedCalls(result.calls).length, 0, mode);
		const rows = new AwaitingStore({ home: s.home }).list();
		if (["blocked", "unreadable-rules", "unstable", "no-ci-blocked", "reminder"].includes(mode)) assert.equal(rows.filter((row) => row.state === "open").length, 1, mode);
		const store = new CheckpointStore(s.home, { kind: "merge" });
		assert.equal(store.get(live.jobId, { scope: live.head.slice(0, 12) })?.decision, mode === "approved-blocked" ? "approved" : undefined, "repository refusals preserve existing authorization and mint none");
		if (mode.endsWith("draft")) {
			assert.equal(result.calls.filter((call) => call.startsWith("pr ready")).length, 0);
			assert.equal(rows.length + s.post.escalations.list({ jobId: live.jobId }).length, 0);
		}
		if (mode === "ready") {
			s.setGh({ routes: [] });
			const merged = await s.integrate(live.jobId);
			assert.equal(merged.record.next, "advance", merged.text);
			assert.equal(mergedCalls(merged.calls).length, 1);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr ready")).length, 1);
		}
		if (mode === "ready-moved") {
			assert.match(result.text, /returned to draft/);
			s.setGh({ routes: [{ match: "pr view", replies: [json({ ...view, isDraft: true, headRefOid: "b".repeat(40) })] }] });
			const held = await s.integrate(live.jobId);
			assert.equal(held.record.next, "review", held.text);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr ready")).length, 2);
		}
		if (mode === "ready-undo-refused") assert.match(result.text, /undo refused/);
		if (mode === "ready-refused") assert.match(result.text, /ready refused: GraphQL: forbidden/);
		if (mode === "reminder") {
			await s.integrate(live.jobId);
			assert.equal(new AwaitingStore({ home: s.home }).list().length, 1);
			s.setGh({ routes: [] });
			const merged = await s.integrate(live.jobId);
			assert.equal(merged.record.next, "advance", merged.text);
			assert.equal(mergedCalls(merged.calls).length, 1);
			assert.equal(new AwaitingStore({ home: s.home }).list()[0]?.state, "withdrawn");
		}
	});
});

test("landing S09: external PR facts stop or finish without an automated merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["closed", "foreign", "denied", "merged"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 observed PR facts", 303);
		const view = { number: 303, url: live.prUrl, state: mode === "closed" ? "CLOSED" : mode === "merged" ? "MERGED" : "OPEN", headRefName: mode === "foreign" ? "someone-else" : live.jobId, headRefOid: live.head, baseRefName: "main", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: { oid: live.head } };
		s.setGh({ routes: [{ match: "pr view", replies: [mode === "denied" ? { code: 1, stderr: "HTTP 403: Resource not accessible\nmore" } : json(view)] }] });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "merged" ? "done" : mode === "denied" ? "retry" : "surface", result.text);
		assert.equal(mergedCalls(result.calls).length, 0);
		if (mode === "merged") {
			assert.equal(result.record.merge?.recorded, true);
			assert.equal(s.post.fleet.require(live.jobId).phase, "done");
			assert.equal(result.record.end_state?.br_closed, true);
			assert.equal(new CheckpointStore(s.home, { kind: "merge" }).get(live.jobId, { scope: live.head.slice(0, 12) }), undefined);
		} else {
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held");
			if (mode === "denied") assert.match(result.text, /403/);
			if (mode === "foreign") assert.match(result.text, /not this job's delivery/);
		}
	});
});

test("landing S09: GitLab integration observes the target and never asks GitHub to merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["squash", "merge-commit", "open", "unknown", "closed", "foreign", "no-target", "unavailable", "fork", "held", "contradictory-base", "bound"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", GIT_SSL_NO_VERIFY: "1", CP_E2E_GITLAB_TOKEN: "S09-local-canary" } });
		const live = await s.held("S09 GitLab facts", 304);
		const lab = await startFakeGitlab(t, s.remote);
		await s.project("lab", { cloneUrl: `${lab.web}/o/lab.git`, forge: { kind: "gitlab", web_base_url: lab.web, token_env: "CP_E2E_GITLAB_TOKEN" } });
		git(s.remote, "branch", "develop", live.head);
		const url = `${lab.web}/o/lab/-/merge_requests/7`;
		await s.post.fleet.patch(live.jobId, { project: "lab", receipts: [{ kind: "pr", status: "open", title: "MR", url }], ...(mode === "bound" ? { bound_pr: { number: 7, url, base: "develop" } } : {}) });
		lab.mrs[7] = { status: mode === "unavailable" ? 503 : 200, body: { id: 7, iid: 7, project_id: 42, source_project_id: mode === "fork" ? 43 : 42, target_project_id: 42, state: mode === "open" ? "opened" : mode === "unknown" ? "unknown" : mode === "closed" ? "closed" : "merged", source_branch: mode === "foreign" ? "another-branch" : live.jobId, target_branch: mode === "no-target" ? undefined : "develop", sha: live.head, merge_commit_sha: mode === "merge-commit" ? live.head : null, squash_commit_sha: mode === "merge-commit" ? null : live.head, merged_at: "2026-10-01T00:00:00Z", web_url: url } };
		if (mode === "held") new IntegrationHolds(s.home).hold(live.jobId, "operator pause");
		const before = s.ghCalls().length;
		if (mode === "squash") git(s.remote, "branch", "-D", live.jobId);
		const result = await s.post.integrate({ jobId: live.jobId, ...(mode === "merge-commit" ? { strategy: "squash" as const } : {}) });
		const lands = ["squash", "merge-commit", "contradictory-base", "bound"].includes(mode);
		assert.equal(result.next, lands ? "done" : mode === "held" ? "wait" : mode === "unavailable" || mode === "no-target" ? "retry" : "surface", result.reason);
		assert.deepEqual(s.ghCalls().slice(before), [], "GitLab integration runs no gh command");
		if (lands) {
			assert.equal(result.merge?.receipt?.base_branch, "develop");
			assert.equal(result.merge?.receipt?.strategy, mode === "merge-commit" ? "unknown" : "squash");
			assert.equal(result.merge?.receipt?.merge_commit_sha, live.head);
			assert.equal(result.end_state?.br_closed, true);
			assert.equal(result.merge?.receipt?.forge?.provider, "gitlab");
			assert.equal(result.merge?.receipt?.head_branch_deleted, mode === "squash");
			assert.equal(lab.asked.length, 2);
			const again = await s.post.integrate({ jobId: live.jobId });
			assert.equal(again.next, "done");
			assert.equal(again.merge?.recorded, false);
			assert.equal(lab.asked.length, 2, "receipt fast path reads no forge");
			if (mode === "bound") assert.notEqual(git(s.remote, "show-ref", `refs/heads/${live.jobId}`), "");
			if (mode === "contradictory-base") {
				const wrong = await s.post.integrate({ jobId: live.jobId, base: "main" });
				assert.equal(wrong.next, "surface");
				assert.match(wrong.reason, /landed on develop, not main/);
			}
		} else {
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held");
			const reasons: Record<string, RegExp> = { open: /merge it on GitLab/, unknown: /is unknown/, closed: /closed and was never merged/, foreign: /not this job's delivery/, "no-target": /response names no source or target branch/, unavailable: /could not be read \(unavailable:.*503/, fork: /unsupported:.*fork/, held: /GitLab CI is not read in v1.*integration held/ };
			assert.match(result.reason, reasons[mode]!);
			if (mode === "held") assert.equal(lab.asked.length, 0);
		}
	});
});

test("landing S09: a real repair stays single while active and conflict handoffs follow heads", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const conflict of [false, true]) await t.test(conflict ? "conflict" : "red", async (t) => {
		const s = await startStack(t);
		const gate = join(s.home, "repair-release");
		const live = await s.held("S09 repair lifecycle", 305, { repairGate: gate });
		const view = { number: 305, url: live.prUrl, state: "OPEN", mergeable: conflict ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		s.setGh({ runs: [run(305, live.head, "completed", "failure", { html_url: "https://github.com/example/demo/actions/runs/305" })], routes: [{ match: "pr view", replies: [json(view)] }, { match: "actions/workflows", replies: [json({ total_count: 0, workflows: [] })] }] });
		const first = await s.post.integrate({ jobId: live.jobId });
		assert.equal(first.next, "resolve", first.reason);
		assert.equal(first.step, conflict ? "conflict" : "ci");
		if (!conflict) {
			assert.ok(first.facts.some((fact) => /ci: failed.*run 305 https:\/\/github.com\/example\/demo\/actions\/runs\/305/.test(fact)), first.facts.join("\n"));
			assert.ok(!s.ghCalls().some((call) => call.includes("actions/workflows")));
		}
		assert.equal(first.record.resolve_attempts, 1);
		await waitFor(() => existsSync(`${gate}.entered`), Boolean, { timeoutMs: 30_000, what: "repair waits at its worker barrier" });
		try {
			const requests = s.provider.requests(`landing-${live.jobId}`).length;
			for (const green of [false, true]) {
				s.setGh({ runs: [run(305, live.head, green ? "completed" : "in_progress", green ? "success" : null)] });
				const active = await s.post.integrate({ jobId: live.jobId });
				assert.equal(active.next, "resolve", active.reason);
				assert.match(active.reason, /worker phase waiting|wait for its report/);
				assert.equal(active.record.resolve_attempts, 1);
			}
			assert.equal(s.provider.requests(`landing-${live.jobId}`).length, requests, "active repair receives no second prompt");
			assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		} finally { writeFileSync(gate, "release"); }
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held", { timeoutMs: 30_000, what: "repair report is accepted" });
		s.setGh({ runs: [run(305, live.head, "completed", "failure")] });
		const exhausted = await s.post.integrate({ jobId: live.jobId });
		assert.equal(exhausted.next, "surface", exhausted.reason);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		if (conflict) {
			const quiet = await s.post.integrate({ jobId: live.jobId });
			assert.equal(quiet.next, "wait");
			assert.match(quiet.reason, /until the branch moves/);
			assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "integration_surfaced").length, 1);
			git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "new conflict head");
			git(live.worktree, "push", "--quiet", "origin", live.jobId);
			const moved = git(live.worktree, "rev-parse", "HEAD");
			s.setGh({ routes: [{ match: "pr view", replies: [json({ ...view, headRefOid: moved })] }] });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve");
			await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held" && record.supersessions === 2, { timeoutMs: 30_000, what: "new conflict head receives one report" });
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "wait");
			assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "integration_surfaced").length, 2);
		}
		const handoff = s.provider.requests(`landing-${live.jobId}`).flatMap((request) => request.body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).find((text) => text.includes(conflict ? `${live.prUrl} conflicts with` : "CI is red on the pushed head")) ?? "";
		assert.match(handoff, /plain.*git push/);
		assert.match(handoff, new RegExp(`rev-list --count HEAD\\.\\.origin/${live.jobId}`));
		assert.match(handoff, new RegExp(`git merge origin/${live.jobId}`));
		assert.doesNotMatch(handoff, /git reset|git rebase|force-with-lease|advanced on the server/);
		if (conflict) {
			assert.match(handoff, /git fetch origin && git merge origin\/main/);
			assert.match(handoff, /both sides survive/);
		} else {
			assert.match(handoff, /run 305 https:\/\/github.com\/example\/demo\/actions\/runs\/305/);
			assert.match(handoff, new RegExp(`rev-list --count origin/${live.jobId}\\.\\.HEAD`));
		}
		assert.equal(mergedCalls(s.ghCalls()).length, 0);
		assert.equal(new CheckpointStore(s.home, { kind: "merge" }).get(live.jobId, { scope: live.head.slice(0, 12) }), undefined);
	});
});

test("landing S09: public promotion before or during integration waits for a fresh report", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) for (const during of [false, true]) await t.test(`${fallback ? "checkpoint" : "repository"}/waiting/${during ? "during permission" : "before integration"}`, async (t) => {
		const s = await startStack(t);
		const gate = join(s.home, "public-send-release");
		const live = await s.held("S09 public promotion", 306, { repairGate: gate, repair: true });
		const approve = (head: string) => {
			const store = new CheckpointStore(s.home, { kind: "merge" });
			const scope = head.slice(0, 12);
			store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			store.decide(live.jobId, true, { by: "operator command", scope });
		};
		if (fallback) approve(live.head);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const forgeGate = join(s.home, "forge-release");
		const view = { number: 306, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: fallback ? undefined : "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		s.setGh({ integration: true, runs: [run(306, live.head, "completed", !fallback && !during ? "failure" : "success")], routes: [{ match: "pr view", replies: during ? [json(view), { ...json(view), untilFile: forgeGate }] : [json(view)] }] });
		const advancing = during ? s.post.integrate({ jobId: live.jobId }) : undefined;
		try {
			if (during) await waitFor(() => s.ghCalls().filter((call) => call.startsWith("pr view")).length, (count) => count >= 2, { timeoutMs: 30_000, what: "permission read waits at forge" });
			await s.post.send({ jobId: live.jobId, message: "Revise and report the current pushed head." });
			await waitFor(() => existsSync(`${gate}.entered`), Boolean, { timeoutMs: 30_000, what: "public send reaches worker gate" });
		} finally { writeFileSync(forgeGate, "release"); }
		try {
			const result = await (advancing ?? s.post.integrate({ jobId: live.jobId }));
			assert.equal(result.next, "resolve", result.reason);
			assert.equal(result.record.resolve_attempts, 0);
			assert.equal(mergedCalls(s.ghCalls()).length, 0);
		} finally {
			writeFileSync(gate, "release");
		}
		await waitFor(() => s.post.fleet.require(live.jobId), (record) => record.phase === "held", { timeoutMs: 30_000, what: "fresh public report" });
		const moved = git(live.worktree, "rev-parse", "HEAD");
		assert.notEqual(moved, live.head);
		const movedView = { ...view, headRefOid: moved };
		s.setGh({ routes: [{ match: "pr view", replies: [json(movedView)] }], runs: [run(306, moved, "completed", "success")] });
		const unreviewed = await s.post.integrate({ jobId: live.jobId });
		assert.equal(unreviewed.next, "review", unreviewed.reason);
		writeWindowPass(s.home, live.jobId, moved, "2026-01-01T00:00:00Z");
		if (fallback) approve(moved);
		assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "advance");
		assert.ok(s.ghCalls().some((call) => call.includes(`--match-head-commit ${moved}`)));
	});
});

test("landing S09: infra reruns once while second attempts and test failures promote", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["infra", "second", "test"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held("S09 infra repair", 307);
		const jobs = [setupJob(mode === "test" ? "Run suite (typecheck + tests)" : "Install treehouse")];
		s.setGh({ runs: [run(307, live.head, "completed", "failure", { run_attempt: mode === "second" ? 2 : 1 })], jobs: { "307": jobs } });
		const first = await s.post.integrate({ jobId: live.jobId });
		assert.equal(first.next, mode === "infra" ? "wait" : "resolve", first.reason);
		if (mode === "infra") {
			assert.match(first.reason, /reran the failed jobs once/);
			assert.equal(s.post.fleet.require(live.jobId).supersessions ?? 0, 0);
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "resolve");
		}
		assert.equal(s.ghCalls().filter((call) => call.startsWith("run rerun")).length, mode === "infra" ? 1 : 0);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, 1);
		assert.equal(mergedCalls(s.ghCalls()).length, 0);
	});
});

test("landing S09: a missing implementer surfaces without spending the same-head repair", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const gate = join(s.home, "revived-repair");
	const live = await s.held("S09 missing implementer", 308, { repairGate: gate });
	s.setGh({ routes: [{ match: "pr view", replies: [json({ number: 308, url: live.prUrl, state: "OPEN", mergeable: "CONFLICTING", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" })] }] });
	await s.post.shutdown();
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	const missing = await restarted.integrate({ jobId: live.jobId });
	assert.equal(missing.next, "surface", missing.reason);
	assert.match(missing.reason, /no live worker/);
	assert.equal(missing.record.resolve_attempts, 0);
	assert.equal(restarted.manager.active.length, 0);
	writeFileSync(gate, "release");
	await restarted.revive(live.jobId);
	const delivered = await restarted.integrate({ jobId: live.jobId });
	assert.equal(delivered.next, "resolve", delivered.reason);
	assert.equal(delivered.record.resolve_attempts, 1);
	assert.equal(mergedCalls(s.ghCalls()).length, 0);
});

test("landing: held repair rejects invalid PR identity, CI, holds, drains and worktree hazards", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("held repair boundary matrix", 121);
	const holds = new IntegrationHolds(s.home);
	const view = { number: 121, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
	const original = s.post.fleet.require(live.jobId);
	const check = async (label: string, expected: string) => {
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, expected, `${label}: ${result.text}`);
		assert.equal(result.record.record.resolve_attempts, 0, label);
		assert.equal(s.post.fleet.require(live.jobId).supersessions, original.supersessions, label);
		assert.deepEqual(mergedCalls(result.calls), [], label);
		assert.ok(existsSync(holds.file(live.jobId)), label);
		return result;
	};
	holds.hold(live.jobId, "boundary QA");
	for (const patch of [{ state: "CLOSED" }, { state: "MERGED" }, { headRefName: "foreign" }, { headRefName: undefined }, { headRefOid: "invalid" }, { headRefOid: undefined }]) {
		s.setGh({ runs: [run(121, live.head, "completed", "failure")], routes: [{ match: "pr view", replies: [json({ ...view, ...patch })] }] });
		await check(JSON.stringify(patch), "wait");
	}
	for (const rows of [[], [run(121, live.head, "in_progress", null)], [run(121, live.head, "completed", "success")], [run(121, "b".repeat(40), "completed", "failure")]]) {
		s.setGh({ runs: rows, routes: [] });
		const result = await check(JSON.stringify(rows), "wait");
		if (rows[0]?.conclusion === "success") {
			assert.match(result.text, /CI green/);
			assert.equal(result.record.head_sha, live.head);
			assert.equal(result.record.pr_url, live.prUrl);
		}
	}
	for (const stdout of ["{", "null", "{}", '[{"conclusion":"failure"}]']) {
		s.setGh({ routes: [{ match: "actions/runs?head_sha=", replies: [{ stdout }] }] });
		await check(`malformed CI ${stdout}`, "wait");
	}
	for (const match of ["pr view", "actions/runs?head_sha="]) {
		s.setGh({ routes: [{ match, replies: [{ code: 1, stderr: "HTTP 403" }] }] });
		await check(`denied ${match}`, "wait");
	}
	s.setGh({ routes: [] });
	for (const body of ["{", "{}", JSON.stringify({ job_id: "foreign", reason: "QA", held_at: isoTimestamp() })]) {
		writeFileSync(holds.file(live.jobId), body);
		const result = await check(body, "wait");
		assert.deepEqual(result.calls, [], "invalid hold starts no process");
	}
	holds.release(live.jobId);
	holds.hold(live.jobId, "boundary QA");
	for (const body of ["{", JSON.stringify({ started_at: isoTimestamp(), jobs: [] })]) {
		writeFileSync(drainFile(s.home), body);
		const result = await check(body, "wait");
		assert.deepEqual(result.calls, [], "drain starts no process");
		assert.ok(result.record.facts.some((fact) => fact.startsWith("ci: not read — ")));
		rmSync(drainFile(s.home));
	}
	s.setGh({ runs: [run(121, live.head, "completed", "failure")], routes: [] });
	for (const phase of ["waiting", "launching", "failed", "done", "unreported", "held"]) {
		const file = join(s.home, LAYOUT.fleetFile);
		const before = readFileSync(file, "utf8");
		const legacy = JSON.parse(before);
		const row = legacy.jobs.find((entry: { job_id: string }) => entry.job_id === live.jobId);
		row.phase = phase;
		if (phase === "held") delete row.reported_at;
		writeFileSync(file, JSON.stringify(legacy));
		try {
			if (["launching", "failed", "unreported", "held"].includes(phase)) {
				await assert.rejects(() => s.integrate(live.jobId), /violates the fleet contract/, phase);
			} else {
				const result = await s.integrate(live.jobId);
				assert.equal(result.record.next, "wait", `${phase}: ${result.text}`);
				assert.deepEqual(mergedCalls(result.calls), [], phase);
			}
		} finally { writeFileSync(file, before); }
	}
	const gitDir = git(live.worktree, "rev-parse", "--absolute-git-dir");
	for (const hazard of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
		const file = join(gitDir, hazard);
		writeFileSync(file, "unfinished");
		try { await check(hazard, "surface"); }
		finally { rmSync(file, { force: true }); }
	}
	const defaultsFile = join(s.home, LAYOUT.mandateDefaultsFile);
	const defaultsBefore = existsSync(defaultsFile) ? readFileSync(defaultsFile, "utf8") : undefined;
	writeFileSync(defaultsFile, JSON.stringify({ deny_projects: ["demo"] }));
	try {
		const refused = await s.integrate(live.jobId);
		assert.equal(refused.record.next, "surface", refused.text);
		assert.match(refused.record.resolve_error ?? "", /project demo is denied/);
		assert.equal(refused.record.record.resolve_attempts, 0);
		assert.equal(holds.get(live.jobId)?.reason, "boundary QA");
	} finally {
		if (defaultsBefore === undefined) rmSync(defaultsFile);
		else writeFileSync(defaultsFile, defaultsBefore);
	}
});


test("landing: held CI revalidates local state after each external read", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("held CI read races", 122);
	const holds = new IntegrationHolds(s.home);
	const view = { number: 122, url: live.prUrl, state: "OPEN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
	const envelopeFile = join(s.home, paths.envelopeFile(live.jobId));
	const fleetFile = join(s.home, LAYOUT.fleetFile);
	for (const at of ["ci", "confirm"]) {
		for (const change of ["drain", "invalid-drain", "invalid-hold", "release", "blocked", "unreadable-report", "waiting", "generation", "hazard", "closed", "branch", "head", "unreadable-pr"]) {
			holds.hold(live.jobId, "race QA");
			const fleetBefore = readFileSync(fleetFile, "utf8");
			const envelopeBefore = readFileSync(envelopeFile, "utf8");
			const barrier = join(s.home, `release-${at}-${change}`);
			const gitHazard = join(git(live.worktree, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD");
			const changedView = { ...view, ...(change === "closed" ? { state: "CLOSED" } : change === "branch" ? { headRefName: "foreign" } : change === "head" ? { headRefOid: "b".repeat(40) } : {}) };
			const changedReply: Reply = change === "unreadable-pr" ? { code: 1, stderr: "HTTP 403" } : json(changedView);
			const routes: Route[] = at === "ci"
				? [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(122, live.head, "completed", "failure")]), untilFile: barrier }] }]
				: [{ match: "pr view", replies: [json(view), { ...changedReply, untilFile: barrier }] }];
			s.setGh({ runs: [run(122, live.head, "completed", "failure")], routes });
			const before = s.ghCalls().length;
			const advancing = s.integrate(live.jobId);
			try {
				await waitFor(() => s.ghCalls().slice(before), (calls) => at === "ci" ? calls.some((call) => call.includes("actions/runs?head_sha=")) : calls.filter((call) => call.startsWith("pr view")).length >= 2, { timeoutMs: 30_000, what: `${at}/${change} reaches external barrier` });
				if (change === "drain" || change === "invalid-drain") writeFileSync(drainFile(s.home), change === "drain" ? JSON.stringify({ started_at: isoTimestamp(), jobs: [] }) : "{");
				if (change === "invalid-hold") writeFileSync(holds.file(live.jobId), "{");
				if (change === "release") holds.release(live.jobId);
				if (change === "unreadable-report") writeFileSync(envelopeFile, "{");
				if (change === "blocked") {
					const report = JSON.parse(envelopeBefore);
					report.envelope.status = "blocked";
					report.envelope.blockers = ["QA blocker"];
					writeFileSync(envelopeFile, JSON.stringify(report));
				}
				if (change === "waiting" || change === "generation") {
					const fleet = JSON.parse(fleetBefore);
					const row = fleet.jobs.find((entry: { job_id: string }) => entry.job_id === live.jobId);
					if (change === "waiting") row.phase = "waiting";
					else row.supersessions = (row.supersessions ?? 0) + 1;
					writeFileSync(fleetFile, JSON.stringify(fleet));
				}
				if (change === "hazard") writeFileSync(gitHazard, live.head);
				if (["closed", "branch", "head", "unreadable-pr"].includes(change)) {
					s.setGh({ routes: [{ match: "pr view", replies: [changedReply] }] });
				}
			} finally { writeFileSync(barrier, "release"); }
			try {
				const result = await advancing;
				assert.equal(result.record.next, ["blocked", "unreadable-report", "hazard"].includes(change) ? "surface" : "wait", `${at}/${change}: ${result.text}`);
				assert.equal(result.record.record.resolve_attempts, 0, `${at}/${change}`);
				assert.deepEqual(mergedCalls(result.calls), []);
			} finally {
				writeFileSync(fleetFile, fleetBefore);
				writeFileSync(envelopeFile, envelopeBefore);
				rmSync(drainFile(s.home), { force: true });
				rmSync(gitHazard, { force: true });
				holds.release(live.jobId);
			}
		}
	}
	for (const at of ["ci", "confirm"]) {
		const repair = await s.held(`changed hold reason ${at}`, at === "ci" ? 133 : 134);
		holds.hold(repair.jobId, "old QA reason");
		const barrier = join(s.home, `reason-${at}`);
		const repairView = { ...view, url: repair.prUrl, headRefName: repair.jobId, headRefOid: repair.head };
		const routes: Route[] = at === "ci"
			? [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(133, repair.head, "completed", "failure")]), untilFile: barrier }] }]
			: [{ match: "pr view", replies: [json(repairView), { ...json(repairView), untilFile: barrier }] }];
		s.setGh({ runs: [run(133, repair.head, "completed", "failure")], routes });
		const before = s.ghCalls().length;
		const advancing = s.integrate(repair.jobId);
		try {
			await waitFor(() => s.ghCalls().slice(before), (calls) => at === "ci" ? calls.some((call) => call.includes("actions/runs?head_sha=")) : calls.filter((call) => call.startsWith("pr view")).length >= 2, { timeoutMs: 30_000, what: "changed reason reaches external barrier" });
			holds.hold(repair.jobId, "updated QA reason");
		} finally { writeFileSync(barrier, "release"); }
		const result = await advancing;
		assert.equal(result.record.next, "resolve", result.text);
		assert.match(result.text, /updated QA reason/);
		assert.equal(holds.get(repair.jobId)?.reason, "updated QA reason");
	}
});
