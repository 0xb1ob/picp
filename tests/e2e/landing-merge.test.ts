/** Behavior 05 landing e2e: reviewed-head merge, S10 synchronization and cleanup, merge authority and holds. Fixtures: landing-helpers.ts. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { MainCiStore } from "../../src/main-ci.ts";
import { readMergeReceipt } from "../../src/merges.ts";
import { CP_BRIDGE_EXTENSION, startPiChild, advanceBase, git, REPO_ROOT, type ScriptStep, waitFor } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { SKIP, type Reply, type Route, run, json, runsBody, startStack, mergedCalls, deployJobs } from "./landing-helpers.ts";

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
		if (["missing", "fallback"].includes(mode)) {
			assert.match(result.text, /cp_review/);
			assert.match(result.text, /unchanged/);
		}
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
	for (const mode of ["delete", "close", "rebase", "merge-unknown"]) await t.test(mode, async (t) => {
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
		if (mode === "merge-unknown") {
			s.setGh({ integration: true, runs: [run(914, live.head, "completed", "success")], routes: [{ match: "pr merge", replies: [{ code: 1, stderr: "connection reset by peer" }] }] });
			const outcome = await s.post.continuation.trigger({ jobId: live.jobId, event: "startup" });
			assert.equal(outcome.next, "retry", JSON.stringify(outcome));
			const notices = readFileSync(join(s.home, LAYOUT.wakeupsFile), "utf8");
			assert.match(notices, /connection reset by peer/);
			assert.doesNotMatch(notices, /nothing was mutated/i);
			assert.match(notices, /resumes, never starting over/);
			assert.equal(readMergeReceipt(s.home, live.jobId), undefined);
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
		assert.match(notices, /resumes, never starting over/);
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

test("P23-live-report: cp_integrate reads the live report before any merge — blocked strings, planner objects and an unreadable envelope hold, done and absent merge", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t);
	const live = await s.held("live report gate", 131);
	const absent = await s.held("absent report gate", 132);
	writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z");
	writeWindowPass(s.home, absent.jobId, absent.head, "2026-01-01T00:00:00Z");
	s.setGh({ integration: true, runs: [run(131, live.head, "completed", "success"), run(132, absent.head, "completed", "success")] });
	const file = join(s.home, paths.envelopeFile(live.jobId));
	const filed = readFileSync(file, "utf8");
	const put = (envelope: unknown) => writeFileSync(file, JSON.stringify({ ...JSON.parse(filed), envelope }));
	put({ status: "blocked", blockers: ["  no screenshots  ", "x".repeat(300)], head_sha: "abc" });
	const strings = await s.integrate(live.jobId);
	assert.equal(strings.record.next, "surface", strings.text);
	assert.match(strings.text, new RegExp(`^blocker: no screenshots$\\n^blocker: ${"x".repeat(200)}$\\n^blocked report head abc$`, "m"));
	put({ status: "blocked", blockers: [{ question: "which base?" }, { why: "no question" }, 7] });
	const planner = await s.integrate(live.jobId);
	assert.equal(planner.record.next, "surface", planner.text);
	assert.match(planner.text, /^blocker: which base\?$\n^cp-\w+: generation 1 reported blocked: which base\?\. A blocked delivery is never merged/m);
	writeFileSync(file, "{");
	const torn = await s.integrate(live.jobId);
	assert.deepEqual([torn.record.next, /generation 1 has an unreadable envelope\.json \(.*JSON/.test(torn.text)], ["surface", true], torn.text);
	put({ status: "maybe" });
	const maybe = await s.integrate(live.jobId);
	assert.match(maybe.text, /unreadable envelope\.json \(status maybe is neither done nor blocked\)/);
	assert.equal(mergedCalls(s.ghCalls()).length, 0, "a blocked or unreadable report is never merged");
	writeFileSync(file, filed);
	const done = await s.integrate(live.jobId);
	assert.deepEqual([done.record.next, mergedCalls(done.calls).length, /blocked/.test(done.text)], ["advance", 1, false], done.text);
	rmSync(join(s.home, paths.envelopeFile(absent.jobId)));
	const gone = await s.integrate(absent.jobId);
	assert.deepEqual([mergedCalls(gone.calls).length, /blocked|unreadable/.test(gone.text)], [1, false], "an absent report never blocks the merge");
});
