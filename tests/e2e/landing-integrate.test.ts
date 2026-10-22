/** Behavior 05 landing e2e, part of the split of landing.test.ts; fixtures live in landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { drainFile } from "../../src/drain.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { MainCiStore } from "../../src/main-ci.ts";
import { readMergeReceipt } from "../../src/merges.ts";
import { COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, startPiChild, advanceBase, git, readRunEvents, REPO_ROOT, type ScriptStep, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, type RunRow, type Reply, type Route, run, json, runsBody, setupJob, startFakeGitlab, startStack, mergedCalls, deployJobs } from "./landing-helpers.ts";

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


test("landing: a reviewed green head merges once, records, tears down and closes from forge facts", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const bound of [false, true]) await t.test(bound ? "bound branch" : "job branch", async (t) => {
	const s = await startStack(t);
	const live = await s.held("integrate entire landing", 123);
	if (bound) await s.post.fleet.patch(live.jobId, { bound_pr: { number: 123, url: live.prUrl, base: "main" } });
	if (bound) await s.post.registry.setAfterMergeDeploy("demo", { branch: "main", task: "deploy this merge", resources: ["host-a"] });
	const jobsFile = join(s.home, LAYOUT.jobsFile);
	const legacyJobs = JSON.parse(readFileSync(jobsFile, "utf8"));
	legacyJobs.jobs.find((job: { id: string }) => job.id === live.jobId).tracker = { connection_id: "retired", item_id: "x-9", linked_at: isoTimestamp() };
	writeFileSync(jobsFile, JSON.stringify(legacyJobs));
	const trackerFile = join(s.home, LAYOUT.data, "trackers.json");
	writeFileSync(trackerFile, "{ retired, malformed");
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	s.setGh({ integration: true, runs: [run(123, live.head, "completed", "success")] });
	const merged = await s.integrate(live.jobId);
	assert.equal(merged.record.next, "advance", merged.text);
	assert.equal(merged.record.record.merge_authority?.kind, "repo_derived");
	assert.equal(mergedCalls(merged.calls).length, 1);
	assert.ok(merged.calls.some((call) => call.includes(`--match-head-commit ${live.head}`)));
	assert.ok(merged.calls.every((call) => !["--admin", "--auto", "--delete-branch"].some((flag) => call.includes(flag))));
	assert.equal(s.post.fleet.require(live.jobId).phase, "held", "the branch survives until teardown");
	assert.notEqual(git(s.post.registry.pathOf("demo"), "ls-remote", "--heads", "origin", live.jobId), "");
	await s.post.shutdown();
	const restarted = new CommandPost({ home: s.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...s.agentDir.env }, holdsParentLock: () => true });
	t.after(() => restarted.shutdown());
	const resumed = await restarted.integrate({ jobId: live.jobId });
	const done = { record: resumed, text: [...resumed.facts, resumed.reason].join("\n") };
	assert.equal(done.record.next, "done", done.text);
	assert.equal(done.record.end_state?.fleet_done, true);
	assert.equal(done.record.end_state?.merge_receipt, true);
	assert.equal(done.record.end_state?.br_closed, true);
	assert.equal(s.post.fleet.require(live.jobId).closed_reason, "gated");
	const afterMergeFacts = done.record.facts.filter((fact) => fact.startsWith("after-merge"));
	assert.equal(afterMergeFacts.length, bound ? 1 : 0);
	if (bound) assert.equal(deployJobs(restarted, live.jobId).length, 1);
	const remoteBranch = git(s.post.registry.pathOf("demo"), "ls-remote", "--heads", "origin", live.jobId);
	assert.equal(remoteBranch.length > 0, bound, "only a job-owned branch is deleted");
	if (bound) assert.match(done.text, /head kept \(bound PR\)/);
	const again = await s.integrate(live.jobId);
	assert.equal(again.record.next, "done", again.text);
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
	assert.equal(again.record.merge?.recorded, false);
	const events = await s.parent("Read the completed integration result.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
		{ kind: "text", text: "Integration is complete." },
	]);
	assert.doesNotMatch(JSON.stringify(events), /tracker|write-back/);
	assert.equal(readFileSync(trackerFile, "utf8"), "{ retired, malformed");
	});
});

test("landing S10: synchronization preserves local work and proves origin before resetting", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["behind", "stale", "dirty", "unpushed", "absorbed", "divergence", "branch-denied", "branch-empty", "base-denied", "base-empty", "merge-base", "diff", "patch-id", "empty-id", "empty-diff", "salvage"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 sync ${mode}`, 910);
		const clone = s.post.registry.pathOf("demo");
		git(clone, "fetch", "origin", live.jobId);
		git(clone, "checkout", "--detach", `origin/${live.jobId}`);
		writeFileSync(join(clone, "change.txt"), "remote update\n");
		git(clone, "commit", "-am", "remote update");
		git(clone, "push", "origin", `HEAD:${live.jobId}`);
		git(clone, "checkout", "main");
		const head = git(clone, "ls-remote", "--heads", "origin", live.jobId).split("\t")[0]!;
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(910, head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		if (!["behind", "stale", "dirty", "divergence", "branch-denied", "branch-empty"].includes(mode)) {
			writeFileSync(join(live.worktree, "change.txt"), mode === "unpushed" ? "unique local work\n" : "remote update\n");
			git(live.worktree, "commit", "-am", "local version");
		}
		if (mode === "dirty") writeFileSync(join(live.worktree, "change.txt"), "precious uncommitted content\n");
		const local = git(live.worktree, "rev-parse", "HEAD");
		const commonDir = git(live.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const log = join(s.home, "sync-git.jsonl");
		const fault = mode === "divergence" ? "rev-list" : mode === "merge-base" ? "merge-base" : mode === "diff" || mode === "empty-diff" ? "diff" : mode === "patch-id" || mode === "empty-id" ? "patch-id" : mode === "salvage" ? "update-ref" : "";
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const fs=require("node:fs");const a=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(live.worktree)}) {\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+"\\n");\nif(a[0]===${JSON.stringify(fault)}) {process.stderr.write("injected git refusal\\n");process.exit(${mode.startsWith("empty") ? 0 : 128});}\nif(a[0]==="ls-remote" && a.at(-1)===${JSON.stringify(mode.startsWith("base-") ? "main" : live.jobId)} && ${JSON.stringify(["branch-denied", "branch-empty", "base-denied", "base-empty"].includes(mode))}) process.exit(${mode.endsWith("empty") ? 0 : 128});\nif(${JSON.stringify(mode === "stale")} && a[0]==="fetch") {const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});spawnSync(${JSON.stringify(realGit)},["update-ref","-d",${JSON.stringify(`refs/remotes/origin/${live.jobId}`)}]);process.exit(r.status??1);}\n}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const result = await s.integrate(live.jobId);
		const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((row) => JSON.parse(row));
		const resets = calls.filter((args) => args[0] === "reset");
		const success = ["behind", "stale", "absorbed"].includes(mode);
		assert.deepEqual(resets, success ? [["reset", "--hard", head]] : [], `${mode}: reset requires proof`);
		if (success) {
			assert.equal(result.record.next, "done", result.text);
			assert.match(result.text, /worktree reset to/);
			if (mode === "absorbed") {
				assert.match(result.text, /pre-rebase commit\(s\) were discarded/);
				assert.match(result.text, /kept at refs\/cp-salvage\//);
				const rescue = calls.findIndex((a) => a[0] === "update-ref" && a[1] !== "-d");
				assert.ok(rescue >= 0 && rescue < calls.findIndex((a) => a[0] === "reset"));
				assert.equal(execFileSync(realGit, ["--git-dir", commonDir, "rev-parse", calls[rescue]![1]!], { encoding: "utf8" }).trim(), local);
			} else assert.equal(calls.filter((a) => a[0] === "patch-id" || (a[0] === "update-ref" && a[1] !== "-d")).length, 0);
		} else {
			assert.equal(git(live.worktree, "rev-parse", "HEAD"), local);
			if (mode === "dirty") assert.equal(readFileSync(join(live.worktree, "change.txt"), "utf8"), "precious uncommitted content\n");
			assert.equal(result.record.next, "surface", result.text);
			const reasons: Record<string, RegExp> = { dirty: /worktree is dirty/, unpushed: /could not be proven/, divergence: /could not tell whether/, "base-denied": /origin did not name a tip/, "base-empty": /origin did not name a tip/, "merge-base": /no readable merge base/, diff: /could not be read/, "patch-id": /gave no id/, "empty-id": /gave no id/, "empty-diff": /empty cumulative diff/, salvage: /rescue ref first/ };
			if (reasons[mode]) assert.match(result.text, reasons[mode]!);
			if (mode.startsWith("branch-")) assert.match(result.text, /teardown refused.*unpushed/s);
		}
	});
});
test("landing S10: rescue retention proves reachability and bounds cleanup", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["mixed", "origin-denied", "origin-empty", "listing", "ancestry", "delete", "fetch", "bound", "empty", "outside"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 rescue ${mode}`, 911);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(911, live.head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		const clone = s.post.registry.pathOf("demo");
		const base = git(clone, "rev-parse", "HEAD");
		const reachable = "refs/cp-salvage/cp-old/001";
		const orphan = "refs/cp-salvage/cp-old/999";
		if (mode !== "empty") git(clone, "update-ref", reachable, base);
		if (mode === "mixed") git(clone, "update-ref", orphan, live.head);
		if (mode === "bound") for (let index = 2; index <= 101; index++) git(clone, "update-ref", `refs/cp-salvage/cp-old/${String(index).padStart(3, "0")}`, base);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(clone)}) {\nconst m=${JSON.stringify(mode)};if((m==="origin-denied"||m==="origin-empty")&&a[0]==="ls-remote"&&a.at(-1)==="main")process.exit(m==="origin-empty"?0:128);\nif((m==="listing"&&a[0]==="for-each-ref")||(m==="ancestry"&&a[0]==="merge-base"&&a[1]==="--is-ancestor")||(m==="delete"&&a[0]==="update-ref"&&a[1]==="-d")||(m==="fetch"&&a[0]==="fetch"&&a.at(-1)==="main")){process.stderr.write("injected rescue refusal\\n");process.exit(128);}\n}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		if (mode === "outside") writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const a=process.argv.slice(2);\nif(a[0]==="for-each-ref"&&a.includes("refs/cp-salvage/")){console.log(${JSON.stringify([`refs/heads/main ${base}`, `refs/remotes/origin/main ${base}`, `refs/cp-salvage-old/x ${base}`, `refs/cp-salvage/ ${base}`, `refs/cp-salvage/../heads/main ${base}`, `${reachable} ${base}`].join("\n"))});process.exit(0);}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "done", result.text);
		const refs = execFileSync(realGit, ["for-each-ref", "--format=%(refname)", "refs/cp-salvage/"], { cwd: clone, encoding: "utf8" }).trim().split("\n").filter(Boolean);
		if (mode === "outside") {
			const main = spawnSync(realGit, ["rev-parse", "refs/heads/main"], { cwd: clone, encoding: "utf8" });
			assert.deepEqual([main.status, main.stdout.trim()], [0, base], "cleanup must preserve main");
			assert.deepEqual(refs, []);
			return;
		}
		if (mode === "mixed") {
			assert.deepEqual(refs, [orphan]);
			assert.match(result.text, /1 rescue ref\(s\) pruned/);
			assert.match(result.text, /not reachable from main/);
		} else if (mode === "bound") {
			assert.deepEqual(refs, ["refs/cp-salvage/cp-old/101"]);
			assert.match(result.text, /1 further rescue ref\(s\) were not examined/);
		} else if (mode === "empty") {
			assert.deepEqual(refs, []);
			assert.doesNotMatch(result.text, /rescue ref/);
		} else {
			assert.deepEqual(refs, [reachable]);
			assert.match(result.text, mode.startsWith("origin-") ? /origin did not name a tip/ : mode === "listing" ? /could not be listed/ : mode === "ancestry" ? /reachability could not be read/ : mode === "delete" ? /could not be deleted/ : /could not be fetched/);
		}
	});
});
test("landing S10: review evidence authorizes only the reviewed complete head", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["missing", "pass", "equivalent", "moved", "revise", "flagged", "approved", "truncated", "truncated-flag", "moved-flag", "fallback"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 review ${mode}`, 912);
		const old = "b".repeat(40);
		if (!["missing", "fallback"].includes(mode)) {
			writeWindowPass(s.home, live.jobId, ["moved", "moved-flag"].includes(mode) ? old : live.head, "2026-01-01T00:00:00Z");
			const file = join(s.home, paths.reviewFile(live.jobId, 1));
			const verdict = JSON.parse(readFileSync(file, "utf8"));
			if (mode === "revise") Object.assign(verdict, { verdict: "revise", cause: "policy" });
			if (["flagged", "approved", "moved-flag", "truncated-flag"].includes(mode)) Object.assign(verdict, { verdict: "escalate", cause: "flagged" });
			if (mode.startsWith("truncated")) verdict.diff_stat.truncated = true;
			writeFileSync(file, JSON.stringify(verdict));
			if (mode === "equivalent") {
				verdict.equivalent_to = { head_sha: old, attempt: 1 };
				writeFileSync(join(s.home, paths.reviewEquivalenceFile(live.jobId, live.head)), JSON.stringify(verdict));
				rmSync(file);
			}
		}
		if (["approved", "moved-flag", "truncated-flag"].includes(mode)) {
			const checkpoint = new CheckpointStore(s.home, { kind: "diff" });
			checkpoint.request({ jobId: live.jobId, question: "Accept flagged diff?" });
			checkpoint.decide(live.jobId, true, { by: "operator command" });
		}
		if (mode === "fallback") {
			const checkpoint = new CheckpointStore(s.home, { kind: "merge" });
			checkpoint.request({ jobId: live.jobId, scope: live.head.slice(0, 12), question: "Merge this head?" });
			checkpoint.decide(live.jobId, true, { by: "operator command", scope: live.head.slice(0, 12) });
		}
		s.setGh({ integration: true, permission: mode === "fallback" ? null : "CLEAN", runs: [run(912, live.head, "completed", "success")] });
		const result = await s.integrate(live.jobId);
		const permitted = ["pass", "equivalent", "approved"].includes(mode);
		assert.equal(result.record.next, permitted ? "advance" : "review", result.text);
		assert.equal(mergedCalls(result.calls).length, permitted ? 1 : 0);
		assert.equal(result.record.head_sha, live.head);
		assert.equal(result.calls.filter((call) => call.startsWith("pr update-branch")).length, 0);
	});
});
test("landing S10: unreadable forge and Actions evidence names the cause and makes no mutation", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["rate", "permission", "jobs-denied", "jobs-partial", "jobs-malformed", "missing-gh"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`S10 evidence ${mode}`, 913);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const failure: Reply = mode === "jobs-partial" ? json({ total_count: 2, jobs: [] }) : mode === "jobs-malformed" ? { stdout: "<html>502</html>" } : { code: mode === "missing-gh" ? 127 : 1, stderr: mode === "rate" ? "API rate limit exceeded" : mode === "missing-gh" ? "spawn gh ENOENT" : "HTTP 403: Resource not accessible by personal access token" };
		s.setGh({ integration: true, runs: [run(913, live.head, "completed", "success")], routes: [{ match: mode === "missing-gh" ? "pr view" : mode.startsWith("jobs-") ? "/jobs" : "actions/runs?head_sha=", replies: [failure] }] });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, mode === "missing-gh" ? "surface" : "retry", result.text);
		assert.equal(mergedCalls(result.calls).length, 0);
		assert.equal(result.calls.filter((call) => call.startsWith("pr ready")).length, 0);
		assert.match(result.text, mode === "rate" ? /rate_limited/ : mode === "permission" || mode === "jobs-denied" ? /token lacks Actions read/ : mode === "missing-gh" ? /gh is not available.*proves nothing/ : /could not read CI/);
		if (mode === "rate") assert.doesNotMatch(result.text, /token lacks/);
	});
});
test("landing S10: cleanup failures preserve landed effects and resume", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["delete", "close", "rebase"]) await t.test(mode, async (t) => {
		const s = await startStack(t, { continuation: mode !== "rebase" });
		const live = await s.held(`S10 cleanup ${mode}`, 914);
		await s.post.continuation.serialize(live.jobId, async () => {});
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(914, live.head, "completed", "success")] });
		if (mode === "rebase") {
			const gitDir = git(live.worktree, "rev-parse", "--absolute-git-dir");
			mkdirSync(join(gitDir, "rebase-merge"));
			const result = await s.integrate(live.jobId);
			assert.equal(result.record.next, "surface", result.text);
			assert.match(result.text, /rebase is in progress/);
			assert.equal(mergedCalls(result.calls).length, 0);
			rmSync(join(gitDir, "rebase-merge"), { recursive: true });
			return;
		}
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		const jobsFile = join(s.home, LAYOUT.jobsFile);
		const jobs = readFileSync(jobsFile, "utf8");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const fs=require("node:fs");const a=process.argv.slice(2);\nif(a[0]==="push"&&a.includes("--delete")) {if(${JSON.stringify(mode === "delete")}){process.stderr.write("protected branch\\n");process.exit(1);}const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});fs.writeFileSync(${JSON.stringify(jobsFile)},"{");process.exit(r.status??1);}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const outcome = await s.post.continuation.trigger({ jobId: live.jobId, event: "startup" });
		assert.equal(outcome.next, "retry", JSON.stringify(outcome));
		const notices = readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8");
		assert.match(notices, /HELD PR STOPPED/);
		assert.match(notices, mode === "delete" ? /merged and torn down/ : /still open/);
		assert.doesNotMatch(notices, /nothing was mutated/i);
		assert.ok(readMergeReceipt(s.home, live.jobId));
		writeFileSync(jobsFile, jobs);
		rmSync(wrapper);
		const done = await s.integrate(live.jobId);
		assert.equal(done.record.next, "done", done.text);
		assert.equal(s.post.ledger().read().jobs.find((job) => job.id === live.jobId)?.status, "closed");
		assert.equal(mergedCalls(s.ghCalls()).length, 1);
	});
});

test("landing S10: dispatch rejects profiles granting parent integration tools", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const tool of ["cp_integrate", "cp_merged"]) await t.test(tool, async (t) => {
		const packageRoot = mkdtempSync(join(tmpdir(), "cp-profile-package-"));
		t.after(() => rmSync(packageRoot, { recursive: true, force: true }));
		for (const name of ["profiles", "prompts"]) cpSync(join(REPO_ROOT, name), join(packageRoot, name), { recursive: true });
		for (const name of ["extensions", "src"]) symlinkSync(join(REPO_ROOT, name), join(packageRoot, name), "dir");
		const profile = join(packageRoot, "profiles", "implementer.md");
		writeFileSync(profile, readFileSync(profile, "utf8").replace("tools: [", `tools: [${tool}, `));
		const s = await startStack(t, { packageRoot });
		const job = await s.post.ledger().create({ title: `S10 forbidden ${tool}`, project: "demo", delivery: "pr", kind: "ship" });
		const model = s.provider.addScript(`forbidden-${tool}`, [{ kind: "text", text: "done" }], { onExhausted: "repeat" });
		s.agentDir.writeModels(s.provider);
		await assert.rejects(s.post.dispatch({ jobId: job.id, task: "Make a change.", model, fetch: false }), new RegExp(`${tool}.*parent-only tool`));
		assert.equal(s.post.fleet.list().some((entry) => entry.job_id === job.id), false);
	});
});

test("landing S15 retry: real parent delivery confirms, retries withheld verdicts and expires permanent suppression", { skip: SKIP, timeout: 100_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_VERDICT_DELIVERY_RETRY_SECONDS: "1", CP_REVIEW_SUPPRESSION_SECONDS: "32" } });
	const jobs: Awaited<ReturnType<typeof s.held>>[] = [];
	for (let n = 0; n < 4; n++) {
		const live = await s.held(`S15 retry ${n}`, 161 + n, { command: (branch) => `printf retry > retry-${n}.txt && git add retry-${n}.txt && git commit -q -m retry && git push -q -u origin ${branch}` });
		new IntegrationHolds(s.home).hold(live.jobId, "retry evidence collection");
		jobs.push(live);
	}
	const originals = jobs.map((live) => readFileSync(join(s.home, paths.envelopeFile(live.jobId)), "utf8"));
	const models = jobs.map((live, n) => s.provider.addScript(`s15-retry-${n}`, [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: () => {
		if (n === 1 || n === 2) {
			const record = JSON.parse(originals[n]!);
			record.envelope.head_sha = "f".repeat(40);
			record.received_at = isoTimestamp(new Date(Date.now() + 3_600_000));
			writeFileSync(join(s.home, paths.envelopeFile(live.jobId)), JSON.stringify(record));
		}
		return { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 retry evidence"] };
	} }] }]));
	const releaseParent = join(s.home, "release-retry-parent");
	const parent = s.provider.addScript("s15-retry-parent", [
		{ kind: "tool_calls", calls: [
			...jobs.slice(0, 3).map((live, n) => ({ name: "cp_review", args: { job_id: live.jobId, model: models[n] } })),
			{ name: "bash", args: { command: `while [ ! -f '${releaseParent}' ]; do sleep 0.1; done` } },
		] },
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: jobs[3]!.jobId, model: models[3] } }] },
		{ kind: "text", text: "Review deliveries observed." },
	], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model: parent, env: { ...s.agentDir.env, CP_HOME: s.home }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => child.close());
	const prompted = child.prompt("Review these three branches and wait while their verdict delivery settles.");
	const events = (n: number) => readRunEvents(s.home, jobs[n]!.jobId);
	const sends = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_sent");
	const delivered = (n: number) => events(n).filter((event) => event.type === "verdict_wakeup_delivered");
	try {
		await waitFor(() => sends(0).length, (count) => count >= 2, { timeoutMs: 30_000, what: "the busy parent leaves its first verdict unconfirmed through one resend" });
	} finally {
		writeFileSync(releaseParent, "release");
	}
	await prompted;
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 2, { timeoutMs: 10_000, what: "real timer retries a withheld verdict" }), "suppression remains eligible for its configured retry window");
	assert.equal((sends(1)[0]!.payload as { sent: boolean }).sent, false);
	assert.equal((sends(1)[1]!.payload as { sent: boolean }).sent, false);
	await assert.doesNotReject(waitFor(() => sends(1).length, (count) => count >= 3, { timeoutMs: 10_000, what: "a second withheld copy never spends resend eligibility" }), "withheld copies preserve resend eligibility");
	await waitFor(() => delivered(3).length, (count) => count >= 1, { timeoutMs: 10_000, what: "the idle parent's immediate confirmation" });
	assert.equal(delivered(3).length, 1, "one arrival confirms a verdict only once");
	await waitFor(() => Date.now(), (now) => now >= Date.parse(sends(3)[0]!.ts) + 6_000, { timeoutMs: 10_000, what: "confirmed verdict's resend deadline passes" });
	assert.equal(sends(3).length, 1, "confirmation removes the key before its first resend");
	await waitFor(() => sends(1).length, (count) => count >= 6, { timeoutMs: 30_000, what: "lagging facts outlast the old five-copy bound" });
	writeFileSync(join(s.home, paths.envelopeFile(jobs[1]!.jobId)), originals[1]!);
	await waitFor(() => delivered(1).length, (count) => count === 1, { timeoutMs: 10_000, what: "withheld retry remains eligible until facts catch up" });
	assert.equal(sends(0).length, 2, "a queued unconfirmed verdict is resent exactly once");
	assert.equal(delivered(3).length, 1);
	assert.equal(sends(3).length, 1, "an immediately confirmed verdict never resends");
	assert.equal((sends(0)[1]!.payload as { resend: boolean }).resend, true);
	assert.ok(sends(1).length >= 7, "withheld copies outlast the old five-copy bound without consuming the successful resend");
	const cutoff = Date.parse(sends(2)[0]!.ts) + 32_000;
	await waitFor(() => Date.now(), (now) => now >= cutoff, { timeoutMs: 40_000, what: "configured suppression lifetime expires" });
	assert.ok(sends(2).every((event) => Date.parse(event.ts) < cutoff), "permanent suppression stops at its lifetime bound");
	assert.ok(Date.parse(sends(2).at(-1)!.ts) >= cutoff - 6_000, "suppressed attempts remain eligible until near the configured cutoff");
	assert.ok(sends(2).length >= 7, "suppressed retries outlast the old five-copy bound");
	const counts = jobs.map((_, n) => sends(n).length);
	writeFileSync(join(s.home, paths.envelopeFile(jobs[2]!.jobId)), originals[2]!);
	const restoredAt = Date.now();
	await waitFor(() => Date.now(), (now) => now >= restoredAt + 6_000, { timeoutMs: 10_000, what: "expired verdict remains dropped after its facts recover" });
	assert.deepEqual(jobs.map((_, n) => sends(n).length), counts, "confirmed and expired verdicts never resend again");
	assert.equal(delivered(2).length, 0);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
});

test("landing S15 order: a real verdict wakes the parent before its deadline continuation merges", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "5" } });
	const live = await s.held("S15 verdict ordering", 153);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(153, live.head, "completed", "success")] });
	const reviewer = s.provider.addScript("s15-order-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: live.jobId, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["S15 scoped pass"] } }] }]);
	s.agentDir.writeModels(s.provider);
	await s.parent("Review the S15 ordering branch.", [
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: live.jobId, model: reviewer } }] },
		{ kind: "text", text: "Review started." },
	], async () => {
		await waitFor(() => readRunEvents(s.home, live.jobId).some((event) => event.type === "verdict_wakeup_delivered"), Boolean, { timeoutMs: 30_000, what: "real verdict reaches parent context" });
		const file = join(s.home, paths.reviewFile(live.jobId, 1));
		const original = readFileSync(file, "utf8");
		const verdict = JSON.parse(original);
		assert.ok(Date.parse(readRunEvents(s.home, live.jobId).find((event) => event.type === "verdict_wakeup_delivered")!.ts) < Date.parse(verdict.decided_at) + 5_000, "the raw verdict reaches parent context before its deadline continuation");
		assert.equal(existsSync(join(s.home, paths.pendingReviewFile(live.jobId, "review", 1))), false);
		assert.deepEqual(mergedCalls(s.ghCalls()), [], "the verdict arrives while the merge window is open");
		await waitFor(() => mergedCalls(s.ghCalls()).length, (count) => count === 1, { timeoutMs: 45_000, what: "real deadline continuation merges" });
		assert.ok(Date.now() >= Date.parse(verdict.decided_at) + 5_000);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(readRunEvents(s.home, live.jobId).filter((event) => event.type === "review_started").length, 1);
		await waitFor(() => JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages)).includes("HELD PR LANDED"), Boolean, { timeoutMs: 30_000, what: "completed deadline integration reaches the parent" });
	});
	assert.equal(mergedCalls(s.ghCalls()).length, 1);
	const context = JSON.stringify(s.provider.requests("landing-parent-1").map((request) => request.body.messages));
	const verdictAt = context.indexOf("S15 scoped pass");
	assert.ok(verdictAt >= 0, "the parent receives the actual verdict reason");
	assert.ok(context.includes("HELD PR LANDED"), "the parent receives completed deadline integration");
});

test("landing S15: durable review evidence owns the merge window across parent restarts", { skip: SKIP, timeout: 60_000 }, async (t) => {
	const s = await startStack(t, { env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "20" } });
	const live = await s.held("S15 durable review window", 151);
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(151, live.head, "completed", "success")] });
	assert.equal((await s.integrate(live.jobId)).record.next, "review");
	const file = join(s.home, paths.reviewFile(live.jobId, 1));
	const at = new Date().toISOString();
	writeWindowPass(s.home, live.jobId, live.head, at, { diff_stat: { files: 1, truncated: true } });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "a truncated pass cannot arm a window");
	for (const body of ["{", JSON.stringify({ verdict: "pass" })]) {
		writeFileSync(file, body);
		assert.equal((await s.integrate(live.jobId)).record.next, "review", "malformed evidence cannot arm a window");
	}
	const other = "b".repeat(40);
	writeWindowPass(s.home, live.jobId, other, at);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "another head's pass cannot arm this window");
	const fresh = isoTimestamp();
	writeWindowPass(s.home, live.jobId, live.head, fresh);
	const original = readFileSync(file, "utf8");
	const deadline = new Date(Date.parse(fresh) + 20_000).toISOString();
	for (let replay = 0; replay < 2; replay++) {
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "wait", result.text);
		assert.equal(result.record.review_resume_at, deadline);
	}
	const ends = await s.parent("Check the durable S15 review deadline after restart.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId, action: "advance" } }] },
		{ kind: "text", text: "Deadline checked." },
	]);
	assert.ok(JSON.stringify(ends).includes(deadline), "the fresh parent reads the original durable deadline");
	assert.equal(readFileSync(file, "utf8"), original);
	assert.deepEqual(mergedCalls(s.ghCalls()), []);
	writeWindowPass(s.home, live.jobId, live.head, fresh, { equivalent_to: { head_sha: other, attempt: 1 } });
	rmSync(file);
	const equivalentWait = await s.integrate(live.jobId);
	assert.equal(equivalentWait.record.next, "wait", equivalentWait.text);
	assert.equal(equivalentWait.record.review_resume_at, deadline);
	const expired = new Date(Date.now() - 21_000).toISOString();
	writeWindowPass(s.home, live.jobId, live.head, expired, { equivalent_to: { head_sha: other, attempt: 1 } });
	const ready = await s.integrate(live.jobId);
	assert.equal(ready.record.next, "advance", ready.text);
	assert.equal(ready.record.review_resume_at, undefined, "elapsed equivalent passes do not renew the window");
	const mismatched = await s.held("S15 mismatched equivalence", 152, { command: (branch) => `printf mismatch > mismatch.txt && git add mismatch.txt && git commit -q -m mismatch && git push -q -u origin ${branch}` });
	s.setGh({ integration: true, permission: "CLEAN", runs: [run(152, mismatched.head, "completed", "success")] });
	const wrong = writeWindowPass(s.home, mismatched.jobId, other, new Date().toISOString(), { equivalent_to: { head_sha: mismatched.head, attempt: 1 } });
	writeFileSync(join(s.home, paths.reviewEquivalenceFile(mismatched.jobId, mismatched.head)), JSON.stringify(wrong));
	assert.equal((await s.integrate(mismatched.jobId)).record.review_resume_at, undefined, "mismatched equivalence cannot arm a window");
});

test("landing: the review deadline resumes once and rechecks current gates", { skip: SKIP, timeout: 119_000 }, async (t) => {
	for (const fallback of [false, true]) {
		for (const change of ["hold", "unreadable-hold", "head", "ci", "permission", "none"]) await t.test(`${fallback ? "fallback" : "repository"}/${change}`, async (t) => {
			const s = await startStack(t, { continuation: true, env: { CP_REVIEW_MERGE_WINDOW_SECONDS: "3" } });
			const live = await s.held("review deadline gates", 124);
			await s.post.continuation.serialize(live.jobId, async () => {});
			const reviewedAt = new Date().toISOString();
			writeWindowPass(s.home, live.jobId, live.head, reviewedAt);
			if (fallback) {
				const store = new CheckpointStore(s.home, { kind: "merge" });
				const scope = live.head.slice(0, 12);
				store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
				store.decide(live.jobId, true, { by: "operator command", scope });
			}
			s.setGh({ integration: true, permission: fallback ? null : "CLEAN", runs: [run(124, live.head, "completed", "success")] });
			await s.tick(live.jobId);
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(s.post.integrator.get(live.jobId)?.next, "wait");
			assert.deepEqual(mergedCalls(s.ghCalls()), []);
			const holds = new IntegrationHolds(s.home);
			if (change === "hold" || change === "unreadable-hold") {
				holds.hold(live.jobId, "hold during review window");
				if (change === "unreadable-hold") writeFileSync(holds.file(live.jobId), "{");
			}
			if (change === "head") {
				git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "push during review window");
				git(live.worktree, "push", "--quiet", "origin", live.jobId);
			}
			if (change === "ci") s.setGh({ runs: [run(124, live.head, "in_progress", null)] });
			if (change === "permission") s.setGh({ permission: "BLOCKED" });
			await waitFor(() => Date.now(), (now) => now >= Date.parse(reviewedAt) + 4_000, { timeoutMs: 10_000, what: "configured review deadline elapses" });
			await s.post.continuation.serialize(live.jobId, async () => {});
			assert.equal(mergedCalls(s.ghCalls()).length, change === "none" ? 1 : 0, `${fallback}/${change}`);
			if (change === "hold" || change === "unreadable-hold") {
				holds.release(live.jobId);
				const result = await s.integrate(live.jobId);
				assert.equal(result.record.next, "advance", result.text);
				assert.equal(result.record.record.merge_authority?.kind, fallback ? "human_checkpoint" : "repo_derived");
			}
		});
	}
});


test("landing: main red gates only the mandated login and permits a green fix-forward", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("main red integration", 125);
	const base = advanceBase(s.repo, "unrelated.txt", "new base\n");
	const store = new MainCiStore({ home: s.home });
	const routes = [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }];
	const grant = s.post.mandates.issue({ projects: ["demo"], objective: "main red integration", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	store.setRed("demo", base, { login: "e2e" });
	s.setGh({ runs: [run(125, live.head, "completed", "success")], routes: [{ match: "api user --jq .login", replies: [{ code: 1, stderr: "login unavailable" }] }] });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "an unreadable login does not enforce a latch");
	s.setGh({ routes, runs: [run(125, live.head, "completed", "success")] });
	store.setRed("demo", base, { failing: "structure", login: "e2e" });
	for (const rows of [[run(125, live.head, "completed", "success")], [run(125, live.head, "completed", "failure")], []]) {
		s.setGh({ runs: rows });
		const result = await s.integrate(live.jobId);
		assert.equal(result.record.next, "wait", result.text);
		assert.match(result.record.reason, /main is red/);
		assert.deepEqual(mergedCalls(result.calls), []);
	}
	s.setGh({ runs: [run(125, live.head, "completed", "success")] });
	store.clear("demo");
	store.setRed("elsewhere", base, { login: "e2e" });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "another project's latch cannot block");
	store.setRed("demo", base, { login: "foreign" });
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "a foreign login cannot block");
	store.setRed("demo", base, { login: "e2e" });
	s.post.mandates.revoke(grant.id);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "without a mandate main red is not enforced");
	s.post.mandates.issue({ projects: ["demo"], objective: "fix forward", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	s.setGh({ routes });
	writeFileSync(store.file, "{broken");
	const corrupt = await s.integrate(live.jobId);
	assert.equal(corrupt.record.next, "review");
	assert.match(corrupt.text, /main-ci.json unreadable/);
	rmSync(store.file);
	store.setRed("demo", live.head, { login: "e2e" });
	store.setRed("demo", base, { login: "e2e" });
	assert.ok((await s.integrate(live.jobId)).record.reason.includes(`main is red since ${live.head.slice(0, 12)}`), "setting the same login twice preserves its first red head");
	git(live.worktree, "fetch", "origin", "main");
	git(live.worktree, "merge", "--no-edit", "origin/main");
	git(live.worktree, "push", "origin", live.jobId);
	const fixedHead = git(live.worktree, "rev-parse", "HEAD");
	s.setGh({ runs: [run(126, fixedHead, "completed", "success")] });
	const fixed = await s.integrate(live.jobId);
	assert.equal(fixed.record.next, "review", fixed.text);
	assert.match(fixed.text, /fix-forward/);
	store.clear("demo");
	assert.equal((await s.integrate(live.jobId)).record.next, "review");
});


test("landing: repository and fallback merges bind the approved head at the forge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) await t.test(fallback ? "fallback" : "repository", async (t) => {
		const s = await startStack(t);
		const live = await s.held("atomic merge binding", 127);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const view = { number: 127, url: live.prUrl, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: fallback ? undefined : "CLEAN", headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		const routes: Route[] = [{ match: "pr view", replies: [json(view)] }];
		s.setGh({ integration: true, runs: [run(127, live.head, "completed", "success")], routes });
		const checkpoints = new CheckpointStore(s.home, { kind: "merge" });
		const scope = live.head.slice(0, 12);
		if (fallback) {
			const missing = await s.integrate(live.jobId);
			assert.equal(missing.record.next, "surface");
			assert.match(missing.text, /evidence is not authorization/);
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "pending");
			const pending = await s.integrate(live.jobId);
			assert.match(pending.text, /awaiting a human/);
			const checkpointFile = join(s.home, paths.checkpointFile(live.jobId, "merge", scope));
			const pendingBytes = readFileSync(checkpointFile, "utf8");
			checkpoints.decide(live.jobId, false, { by: "operator command", scope });
			assert.match((await s.integrate(live.jobId)).text, /declined/);
			writeFileSync(checkpointFile, pendingBytes);
			checkpoints.decide(live.jobId, true, { by: "operator command", scope });
		}
		const barrier = join(s.home, "merge-release");
		s.setGh({ routes: [...routes, { match: "pr merge", replies: [{ pass: true, untilFile: barrier }] }] });
		const before = s.ghCalls().length;
		const advancing = s.integrate(live.jobId);
		try {
			await waitFor(() => s.ghCalls().slice(before).some((call) => call.startsWith("pr merge")), Boolean, { timeoutMs: 30_000, what: "merge reaches forge barrier" });
			git(live.worktree, "commit", "--quiet", "--allow-empty", "-m", "concurrent push");
			git(live.worktree, "push", "--quiet", "origin", live.jobId);
		} finally { writeFileSync(barrier, "release"); }
		const refused = await advancing;
		assert.equal(refused.record.next, "retry", refused.text);
		assert.match(refused.text, /Head branch was modified/);
		assert.equal(refused.record.record.merge_authority, undefined);
		assert.equal(existsSync(join(s.home, paths.mergeFile(live.jobId))), false);
		assert.equal(s.post.fleet.require(live.jobId).phase, "held");
		const call = mergedCalls(refused.calls)[0]!;
		assert.ok(call.includes(`--match-head-commit ${live.head}`));
		assert.ok(!call.includes("--delete-branch") && !call.includes("--admin") && !call.includes("--auto"));
		const moved = git(live.worktree, "rev-parse", "HEAD");
		s.setGh({ runs: [run(128, moved, "completed", "success")], routes: [{ match: "pr view", replies: [json({ ...view, headRefOid: moved })] }] });
		assert.equal((await s.integrate(live.jobId)).record.next, "review", "old review never covers a pushed head");
		writeWindowPass(s.home, live.jobId, moved, "2026-01-01T00:00:00Z");
		if (fallback) {
			const unapproved = await s.integrate(live.jobId);
			assert.equal(unapproved.record.step, "authorize");
			assert.equal(unapproved.record.next, "surface");
			assert.equal(checkpoints.get(live.jobId, { scope: moved.slice(0, 12) })?.decision, "pending");
			assert.equal(checkpoints.get(live.jobId, { scope })?.decision, "approved");
		}
	});
});


test("landing: stale bases update only for BEHIND or an authoritative strict rule", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["clean", "blocked", "denied-rules", "unknown", "behind", "strict", "current", "unreadable-ancestry", "red", "conflict", "moved", "superseded"]) await t.test(mode, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`base policy ${mode}`, 129);
		if (mode !== "current") advanceBase(s.repo, "base-policy.txt", "base changed\n");
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		const strict = ["strict", "current", "unreadable-ancestry"].includes(mode);
		const status = ["clean", "red", "moved", "superseded"].includes(mode) ? "CLEAN" : mode === "unknown" ? "UNKNOWN" : mode === "behind" ? "BEHIND" : mode === "conflict" ? "DIRTY" : "BLOCKED";
		const view = { number: 129, url: live.prUrl, state: "OPEN", mergeable: mode === "conflict" ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: status, headRefName: live.jobId, headRefOid: live.head, baseRefName: "main" };
		const routes: Route[] = [{ match: "pr view", replies: [json(view)] }, { match: "/rules/branches/", replies: [mode === "denied-rules" ? { code: 1, stderr: "HTTP 403" } : json(strict ? [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "ci" }] } }] : [])] }];
		if (mode === "unreadable-ancestry") {
			const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
			const wrapper = join(s.home, "bin", "git");
			writeFileSync(wrapper, `#!/usr/bin/env node\nconst { spawnSync } = require("child_process");\nconst args = process.argv.slice(2);\nif (args[0] === "merge-base" && args.includes("--is-ancestor")) process.exit(128);\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`);
			chmodSync(wrapper, 0o755);
		}
		if (mode === "moved") routes[0]!.replies.push(json({ ...view, headRefOid: "b".repeat(40) }));
		const rows = [run(129, mode === "superseded" ? "b".repeat(40) : live.head, "completed", mode === "red" ? "failure" : "success")];
		if (mode === "superseded") routes.push({ match: "actions/runs?branch=", replies: [runsBody(rows)] });
		s.setGh({ integration: true, routes, runs: rows });
		const result = await s.integrate(live.jobId);
		const updates = result.calls.filter((call) => call.startsWith("pr update-branch"));
		if (mode === "behind" || mode === "strict") {
			assert.equal(result.record.step, "fresh", result.text);
			assert.equal(result.record.next, "advance", result.text);
			assert.equal(result.record.head_sha, undefined);
			assert.equal(updates.length, 1);
			assert.deepEqual(mergedCalls(result.calls), []);
			const head = git(s.remote, "rev-parse", live.jobId);
			assert.notEqual(head, live.head);
			s.setGh({ routes: [{ match: "actions/runs?branch=", replies: [runsBody([run(129, live.head, "completed", "success")])] }] });
			const stale = await s.integrate(live.jobId);
			assert.equal(stale.record.next, "wait", stale.text);
			s.setGh({ runs: [run(130, head, "completed", "success")] });
			const unreviewed = await s.integrate(live.jobId);
			assert.equal(unreviewed.record.next, "review", unreviewed.text);
			assert.equal(s.ghCalls().filter((call) => call.startsWith("pr update-branch")).length, 1);
		} else if (mode === "clean") {
			assert.equal(result.record.next, "advance", result.text);
			assert.equal(mergedCalls(result.calls).length, 1);
			assert.ok(mergedCalls(result.calls)[0]!.includes(`--match-head-commit ${live.head}`));
			assert.equal(updates.length, 0);
		} else {
			const expected = mode === "unknown" ? "retry" : ["red", "conflict"].includes(mode) ? "resolve" : ["moved", "superseded"].includes(mode) ? "wait" : "surface";
			assert.equal(result.record.next, expected, result.text);
			assert.equal(updates.length, 0);
			assert.deepEqual(mergedCalls(result.calls), []);
		}
	});
});


test("landing: the operator bridge persists a hold without a parent and a restarted parent reads and releases it", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const operatorHome = mkdtempSync(join(tmpdir(), "cp-s08-operator-"));
	t.after(() => rmSync(operatorHome, { recursive: true, force: true }));
	const s = await startStack(t, { env: { PI_HOME: operatorHome } });
	const live = await s.held("operator bridge hold", 131);
	saveOperatorTarget({ home: s.home, mode: "multi", hostPid: 0, parentPid: 0 });
	const model = s.provider.addScript("s08-bridge", [
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "integration_hold", job_id: live.jobId, reason: "operator QA" } }] },
		{ kind: "text", text: "Hold written." },
		{ kind: "tool_calls", calls: [{ name: "cp_parent", args: { action: "integration_release", job_id: live.jobId } }] },
		{ kind: "text", text: "Hold released." },
	]);
	s.agentDir.writeModels(s.provider);
	const child = startPiChild({ cwd: s.home, model, env: { ...s.agentDir.env, CP_HOME: s.home, PI_HOME: operatorHome }, extensions: [CP_BRIDGE_EXTENSION] });
	t.after(() => child.close());
	await child.prompt("Pause integration for operator QA.");
	await child.waitForSettled(90_000);
	assert.equal(new IntegrationHolds(s.home).get(live.jobId)?.reason, "operator QA");
	s.setGh({ runs: [run(131, live.head, "completed", "success")] });
	const held = await s.integrate(live.jobId);
	assert.equal(held.record.next, "wait", held.text);
	assert.match(held.text, /CI green/);
	const local = await s.seed("local hold validation");
	await s.post.fleet.patch(local.jobId, { delivery: "local" });
	const invalid = [
		{ action: "hold", job_id: local.jobId, reason: "QA" },
		{ action: "release", job_id: local.jobId },
		{ action: "hold", job_id: "missing", reason: "QA" },
		{ action: "release", job_id: "missing" },
		{ action: "hold", job_id: "../escape", reason: "QA" },
		{ action: "hold", job_id: live.jobId, reason: " " },
		{ action: "hold", job_id: live.jobId, reason: "x".repeat(2001) },
	];
	const events = await s.parent("Read the durable integration hold, and validate rejected hold requests.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { action: "status", job_id: live.jobId } }] },
		...invalid.map((args): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_integrate", args }] })),
		{ kind: "text", text: "Validated." },
	]);
	assert.match(JSON.stringify(events[0]), /operator QA/);
	assert.match(JSON.stringify(events[0]), /ci: green/);
	for (const event of events.slice(1)) assert.equal((event as { isError?: boolean }).isError, true, JSON.stringify(event));
	await child.prompt("Release the integration hold.");
	await waitFor(() => s.provider.remaining("s08-bridge"), (remaining) => remaining === 0, { timeoutMs: 90_000, what: "bridge release script consumed" });
	await child.waitForSettled(90_000);
	assert.equal(new IntegrationHolds(s.home).get(live.jobId), undefined);
	assert.equal((await s.integrate(live.jobId)).record.next, "review", "release still requires a review");
	const pendingFile = join(s.home, paths.pendingReviewFile(live.jobId, "review", 2));
	const reviews = await s.parent("Check integration while review is already pending.", [
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: { job_id: live.jobId } }] },
		{ kind: "tool_calls", calls: [{ name: "cp_integrate", args: () => {
			mkdirSync(dirname(pendingFile), { recursive: true });
			writeFileSync(pendingFile, JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: live.jobId, surface: "review", attempt: 2, model: "mock/reviewer", pid: process.pid, started_at: isoTimestamp(), deadline: "2099-01-01T00:00:00Z", handed_back: true, subject: { head_sha: live.head, branch: live.jobId, files: 1, truncated: false } }));
			return { job_id: live.jobId };
		} }] },
		{ kind: "text", text: "Review is pending." },
	]);
	assert.ok(!JSON.stringify(reviews[0]).includes("already in flight"));
	assert.match(JSON.stringify(reviews[1]), /review already in flight/);
	assert.match(JSON.stringify(reviews[1]), /attempt 2/);
	rmSync(pendingFile);
	assert.equal(s.provider.remaining("s08-bridge"), 0);
});


test("landing: a hold arriving during green CI stops both merge authority paths", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const fallback of [false, true]) await t.test(fallback ? "fallback" : "repository", async (t) => {
		const s = await startStack(t);
		const live = await s.held("hold across CI", 132);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
		if (fallback) {
			const store = new CheckpointStore(s.home, { kind: "merge" });
			const scope = live.head.slice(0, 12);
			store.request({ jobId: live.jobId, scope, question: "Merge this head?" });
			store.decide(live.jobId, true, { by: "operator command", scope });
		}
		const barrier = join(s.home, "green-ci-release");
		s.setGh({ integration: true, permission: fallback ? null : "CLEAN", runs: [run(132, live.head, "completed", "success")], routes: [{ match: "actions/runs?head_sha=", replies: [{ ...runsBody([run(132, live.head, "completed", "success")]), untilFile: barrier }] }] });
		const advancing = s.integrate(live.jobId);
		const holds = new IntegrationHolds(s.home);
		try {
			await waitFor(() => s.ghCalls().some((call) => call.includes("actions/runs?head_sha=")), Boolean, { timeoutMs: 30_000, what: "green CI reaches external barrier" });
			holds.hold(live.jobId, "QA requested during CI read");
		} finally { writeFileSync(barrier, "release"); }
		const stopped = await advancing;
		assert.equal(stopped.record.next, "wait", stopped.text);
		assert.match(stopped.text, /QA requested during CI read/);
		assert.ok(stopped.record.facts.some((fact) => fact.startsWith("ci: green — ")));
		assert.equal(stopped.record.head_sha, live.head);
		assert.equal(stopped.record.pr_url, live.prUrl);
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
		holds.release(live.jobId);
		s.setGh({ routes: [] });
		const resumed = await s.integrate(live.jobId);
		assert.equal(resumed.record.next, "advance", resumed.text);
		assert.equal(resumed.record.record.merge_authority?.kind, fallback ? "human_checkpoint" : "repo_derived");
	});
});
test("landing: held CI repair checks Sender authority before restoring a worker", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["revoked", "capped", "expired", "expired-released", "missing", "dead"]) {
		const permitted = mode.startsWith("expired");
		const s = await startStack(t);
		const live = await s.held(`held permission ${mode}`, 121, { repair: true });
		const identity = s.post.fleet.require(live.jobId);
		if (mode === "revoked" || mode === "capped" || mode === "expired-released") {
			writeFileSync(join(s.home, LAYOUT.budgetsFile), JSON.stringify({ ...s.post.budgets(), spawn_cap: 1 }));
			await s.held(`occupy released slot ${mode}`, 122);
			assert.equal(s.post.heldRelease.wasReleased(live.jobId), true, "a real dispatch releases the idle held worker");
		}
		const grant = s.post.mandates.issue({ projects: ["demo"], objective: "repair held CI", expiry: isoTimestamp(new Date(Date.now() - 1_000)), at: isoTimestamp(new Date(Date.parse(identity.dispatched_at) - 60_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
		if (mode === "revoked") s.post.mandates.revoke(grant.id);
		if (mode === "capped") s.post.mandates.save({ ...s.post.mandates.require(grant.id), status: "paused", pause_reason: "spend_cap", paused_at: isoTimestamp() });
		new IntegrationHolds(s.home).hold(live.jobId, "permission probe");
		if (mode === "dead") {
			const worker = s.post.manager.get(live.jobId)!.worker;
			process.kill(identity.worker.pid, "SIGKILL");
			await waitFor(() => worker.alive, (alive) => alive === false, { timeoutMs: 10_000, what: "held worker death observed" });
		} else if (!permitted) await s.post.manager.shutdownAll();
		s.setGh({ runs: [run(121, live.head, "completed", "failure")] });
		const result = await s.post.integrate({ jobId: live.jobId });
		assert.equal(result.next, permitted ? "resolve" : "surface", mode);
		assert.equal(result.record.resolve_attempts, permitted ? 1 : 0, mode);
		if (!permitted) {
			assert.match(result.resolve_error ?? "", mode === "revoked" ? /is revoked/ : mode === "capped" ? /is paused \(spend_cap\)/ : /no live worker/, mode);
			assert.equal(s.post.fleet.require(live.jobId).phase, "held", mode);
			assert.equal(JSON.parse(readFileSync(join(s.home, paths.envelopeFile(live.jobId)), "utf8")).envelope.head_sha, live.head, mode);
			assert.equal(s.post.fleet.require(live.jobId).worker.pid, identity.worker.pid, "refusal never revives a worker");
		}
		assert.equal(new IntegrationHolds(s.home).get(live.jobId)?.reason, "permission probe");
		assert.deepEqual(mergedCalls(s.ghCalls()), []);
	}
});

test("landing: unreadable worktree status preserves uncommitted content", { skip: SKIP, timeout: 120_000 }, async (t) => {
	const faults = [
		{ cmd: "status", code: 128, out: "", detail: /git status\) \(exit 128/ },
		{ cmd: "ls-remote", code: 2, out: `process.stdout.write("${"a".repeat(40)}\\trefs/heads/x\\n");`, detail: /teardown refused: dirty/ },
	];
	for (const fault of faults) await t.test(fault.cmd, async (t) => {
		const s = await startStack(t);
		const live = await s.held("preserve unreadable dirty tree", 910);
		const clone = s.post.registry.pathOf("demo");
		git(clone, "fetch", "origin", live.jobId);
		git(clone, "checkout", "--detach", `origin/${live.jobId}`);
		writeFileSync(join(clone, "change.txt"), "remote update\n");
		git(clone, "commit", "-am", "remote update");
		git(clone, "push", "origin", `HEAD:${live.jobId}`);
		git(clone, "checkout", "main");
		const head = git(clone, "ls-remote", "--heads", "origin", live.jobId).split("\t")[0]!;
		writeWindowPass(s.home, live.jobId, head, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(910, head, "completed", "success")] });
		assert.equal((await s.integrate(live.jobId)).record.next, "advance");
		writeFileSync(join(live.worktree, "change.txt"), "precious uncommitted content\n");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = join(s.home, "bin", "git");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");\nconst args=process.argv.slice(2);\nif(process.cwd()===${JSON.stringify(live.worktree)} && args[0]===${JSON.stringify(fault.cmd)}) {${fault.out}process.stderr.write("fatal: unavailable\\n");process.exit(${fault.code});}\nconst r=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exit(r.status??1);\n`);
		chmodSync(wrapper, 0o755);
		const out = await s.integrate(live.jobId);
		assert.match(JSON.stringify(out.record), fault.detail);
		if (fault.cmd === "ls-remote") assert.equal(out.record.step, "teardown", "an unreachable origin is left alone, never a sync failure");
		assert.equal(readFileSync(join(live.worktree, "change.txt"), "utf8"), "precious uncommitted content\n", `unreadable ${fault.cmd} must never authorize destruction of uncommitted work`);
	});
});

