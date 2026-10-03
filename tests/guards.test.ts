/**
 * T19 acceptance (guard half): the parent's attempts to read an artifact body
 * or to commit runtime state are blocked with actionable messages — and the
 * guard is really wired into pi's `tool_call` event, not just unit-testable.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { ContextGuard, GUARD_CODES, type GuardDecision, formatGuardDecision, parseGit, splitSegments } from "../src/guards.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MockProvider,
	startPiChild,
} from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

interface Bench {
	home: string;
	guard: ContextGuard;
	artifacts: ArtifactStore;
	bash(command: string, cwd?: string): GuardDecision | undefined;
	tool(toolName: string, path: string, cwd?: string): GuardDecision | undefined;
}

function bench(t: { after(fn: () => void): void }): Bench {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const artifacts = new ArtifactStore({ home: home.path });
	const guard = new ContextGuard({ home: home.path, artifacts });
	// One artifact-bearing job, one job without an artifact.
	writeFileSync(artifacts.path("cp-research-1"), "# findings\nbody\n");
	mkdirSync(artifacts.dir("cp-empty-1"), { recursive: true });
	return {
		home: home.path,
		guard,
		artifacts,
		bash: (command, cwd) => guard.check({ toolName: "bash", input: { command }, cwd: cwd ?? home.path }),
		tool: (toolName, path, cwd) => guard.check({ toolName, input: { path }, cwd: cwd ?? home.path }),
	};
}

// -- artifact bodies --------------------------------------------------------

test("read/grep of an artifact body is blocked with the sanctioned alternative", (t) => {
	const b = bench(t);
	for (const path of [
		".pi-command-post/state/artifacts/cp-research-1/report.md",
		join(b.home, LAYOUT.artifacts, "cp-research-1/report.md"),
		"@.pi-command-post/state/artifacts/cp-research-1/report.md",
		"./.pi-command-post/state/artifacts/cp-research-1/../cp-research-1/report.md",
	]) {
		const decision = b.tool("read", path);
		assert.ok(decision, `read ${path} was allowed`);
		assert.equal(decision.code, "artifact_body_read");
		assert.match(decision.reason, /cp_artifact get/);
		assert.match(decision.reason, /never reads/);
	}
	assert.equal(b.tool("grep", ".pi-command-post/state/artifacts")?.code, "artifact_body_read");
});

test("edit/write inside the artifact store is blocked as authorship", (t) => {
	const b = bench(t);
	for (const tool of ["edit", "write"]) {
		const decision = b.tool(tool, ".pi-command-post/state/artifacts/cp-research-1/report.md");
		assert.equal(decision?.code, "artifact_body_write");
		assert.match(decision.reason, /cp_artifact add/);
	}
});

test("reading run artifacts, briefs, envelopes and verdicts stays allowed", (t) => {
	const b = bench(t);
	for (const path of [
		"state/runs/cp-research-1/status.json",
		"state/runs/cp-research-1/envelope.json",
		"state/runs/cp-research-1/verdict.json",
		"state/fleet.json",
		join(b.home, LAYOUT.learningsFile),
	]) {
		assert.equal(b.tool("read", path), undefined, `read ${path} was blocked`);
	}
});

test("the operator-question journal is not the parent's reading material", (t) => {
	// T31: /watch renders the exchange in code; a model that reads the journal has
	// undone the only property that made the channel worth building.
	const b = bench(t);
	for (const path of [
		"state/runs/cp-research-1/questions.jsonl",
		join(b.home, LAYOUT.runs, "cp-research-1/questions.jsonl"),
	]) {
		const decision = b.tool("read", path);
		assert.equal(decision?.code, "question_journal_read", `read ${path} was not blocked`);
		assert.match(decision?.reason ?? "", /\/watch <job-id>/, "the refusal names the sanctioned surface");
		assert.equal(b.tool("grep", path)?.code, "question_journal_read");
	}

	// Same rule through bash, with the same metadata allowance as artifacts.
	assert.equal(b.bash("cat state/runs/cp-research-1/questions.jsonl")?.code, "question_journal_read");
	assert.equal(b.bash("jq . state/runs/cp-research-1/questions.jsonl")?.code, "question_journal_read");
	assert.equal(b.bash("wc -l state/runs/cp-research-1/questions.jsonl"), undefined, "counting lines is metadata");

	// And the neighbours in the same run dir stay readable: this is one file, not
	// a ban on the run directory.
	assert.equal(b.tool("read", "state/runs/cp-research-1/status.json"), undefined);
	assert.equal(b.tool("write", "state/runs/cp-research-1/questions.jsonl"), undefined, "the parent never writes it either, but that is the store's job to refuse");
});

test("review-approval.json is not the parent's reading material", (t) => {
	const b = bench(t);
	assert.equal(b.tool("read", "state/runs/cp-research-1/review-approval.json")?.code, "review_approval_read");
	assert.equal(b.bash("cat state/runs/cp-research-1/review-approval.json")?.code, "review_approval_read");
	assert.equal(b.tool("grep", "state/runs/cp-research-1/review-approval.json")?.code, "review_approval_read");
});

test("bash may describe an artifact but never emit one", (t) => {
	const b = bench(t);
	for (const command of [
		"ls .pi-command-post/state/artifacts",
		"ls -la .pi-command-post/state/artifacts/cp-research-1",
		"stat .pi-command-post/state/artifacts/cp-research-1/report.md",
		"wc -l .pi-command-post/state/artifacts/cp-research-1/report.md",
		"find .pi-command-post/state/artifacts -name report.md",
		// A plain input redirect into a metadata command still only ever emits
		// metadata (a count, a size), whether the path arrives as an argument
		// or on stdin — the shape the guard's own refusal reason promises.
		"wc -l < .pi-command-post/state/artifacts/cp-research-1/report.md",
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
	for (const command of [
		"cat .pi-command-post/state/artifacts/cp-research-1/report.md",
		"head -50 .pi-command-post/state/artifacts/cp-research-1/report.md",
		"rg findings .pi-command-post/state/artifacts",
		"ls .pi-command-post/state/artifacts && cat .pi-command-post/state/artifacts/cp-research-1/report.md",
		"cat .pi-command-post/state/artifacts/cp-research-1/report.md | head -5",
		"ls $(cat .pi-command-post/state/artifacts/cp-research-1/report.md)",
		// An output redirect/append, a process substitution or a substituted
		// path can still smuggle the body somewhere else even through a
		// metadata command, so those stay refused.
		"wc -l < .pi-command-post/state/artifacts/cp-research-1/report.md > /tmp/out",
		"wc -l < $(echo .pi-command-post/state/artifacts/cp-research-1/report.md)",
		`cat ${join(b.home, LAYOUT.artifacts, "cp-research-1/report.md")}`,
	]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "artifact_body_read", `${command} was allowed`);
		assert.match(decision.reason, /cp_artifact/);
	}
});

// -- cp-qlu acceptance: sanctioned metadata commands, and one refused
// segment inside a compound command that is otherwise fine ------------------

test("wc -c/stat/ls -l against an artifact are exactly the metadata commands the refusal promises", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	// Every shape the refusal message names by name is allowed, argument or
	// stdin alike.
	for (const command of [`wc -c < ${path}`, `wc -c ${path}`, `stat ${path}`, `ls -l ${path}`]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
});

test("an unrelated command that merely mentions an artifact path in prose is not a read", (t) => {
	// cp_job close --reason "...<path>..." writes a close record; it never reads
	// the artifact's body, so it must not be refused as one.
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	for (const command of [
		`echo "done, see ${path} for the writeup"`,
		`echo "see ${path} and stat ${path}"`,
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
});

test("a job description that quotes an artifact path is allowed", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	assert.equal(
		b.bash(`echo "follow up on the findings in ${path}"`),
		undefined,
		"an echoed job description quoting the path was blocked",
	);
});

test("cat/head/tail/sed -n/grep and the read tool against an artifact body are still refused", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	for (const command of [`cat ${path}`, `head ${path}`, `tail ${path}`, `sed -n '1,2p' ${path}`, `grep findings ${path}`]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "artifact_body_read", `${command} was allowed`);
	}
	assert.equal(b.tool("read", path)?.code, "artifact_body_read");
});

test("the refusal names the specific segment that tripped it, not the whole compound command", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	const decision = b.bash(`ls .pi-command-post/state/artifacts && echo "see ${path}" && cat ${path}`);
	assert.equal(decision?.code, "artifact_body_read");
	assert.equal(decision.subject, path, "the reason should name the offending path, not the whole command");
});

// -- textual mentions (false-positive narrowing) ---------------------------

test("a bare textual mention of an artifact path is bookkeeping, not a read", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	for (const command of [
		`echo "the stages are defined in ${path}"`,
		`echo "see ${path} for the plan"`,
		`echo "the artifact lives at ${path}"`,
		`git commit -m "reference ${path} in the brief" src/guards.ts`,
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
});

test("a real read of the same path is still refused, including through indirection", (t) => {
	const b = bench(t);
	const path = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	for (const command of [
		`cat ${path}`,
		`read ${path}`,
		`less ${path}`,
		`more ${path}`,
		`head ${path}`,
		`tail ${path}`,
		`cp ${path} /tmp/out.md`,
		`mv ${path} /tmp/out.md`,
		// redirection into and out of the path
		`cat < ${path}`,
		`echo hi > ${path}`,
		`cat /etc/hosts >> ${path}`,
		// indirection: pipeline, xargs, sh -c, quoted subshell
		`echo ${path} | xargs cat`,
		`sh -c "cat ${path}"`,
		`ls $(cat ${path})`,
	]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "artifact_body_read", `${command} was allowed`);
		assert.match(decision.reason, /cp_artifact/);
	}
});

test("a bare textual mention of a review path is bookkeeping, not a read", (t) => {
	const b = bench(t);
	const path = "state/runs/cp-research-1/review-1/verdict.json";
	for (const command of [
		`echo "the diff landed at ${path}"`,
		`echo "see ${path} for the diff"`,
		`echo "the review scratch dir is ${path}"`,
		`git commit -m "reference ${path} in the brief" src/guards.ts`,
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
});

test("a real read of a review path is still refused, including through indirection", (t) => {
	const b = bench(t);
	const path = "state/runs/cp-research-1/review-1/verdict.json";
	for (const command of [
		`cat ${path}`,
		`less ${path}`,
		`head ${path}`,
		`tail ${path}`,
		`cp ${path} /tmp/out.json`,
		`mv ${path} /tmp/out.json`,
		// redirection into and out of the path
		`cat < ${path}`,
		`echo hi > ${path}`,
		// indirection: pipeline, xargs, sh -c, quoted subshell
		`echo ${path} | xargs cat`,
		`sh -c "cat ${path}"`,
		`ls $(cat ${path})`,
	]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "diff_body_read", `${command} was allowed`);
		assert.match(decision.reason, /review-<n>\.json/);
	}
});

// -- CI checks API -------------------------------------------------------------

test("parent reads of the checks API are refused and point at cp_integrate", (t) => {
	const b = bench(t);
	const refused = [
		"gh pr checks 12",
		"gh pr view 12 --json statusCheckRollup",
		"gh pr view 12 --json=number,statusCheckRollup",
		"cd x && gh pr checks 12",
		"gh --repo acme/demo pr checks 12",
		"gh -R acme/demo pr checks 12",
		"gh pr -R acme/demo checks 12",
		"gh api graphql -f query='{ pr { statusCheckRollup } }'",
		"gh api graphql --field=query=statusCheckRollup",
		"gh api graphql --raw-field=query=statusCheckRollup",
		"gh api graphql -fquery=statusCheckRollup",
	];
	for (const command of refused) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "ci_checks_read", `${command} was allowed`);
		assert.match(decision.reason, /cp_integrate <job-id>/);
	}
	for (const command of [
		"gh run list --branch cp-a1",
		"gh run view 123 --log-failed",
		"gh -R acme/demo run list --limit 3",
		"gh run -R acme/demo view 123",
	]) {
		assert.equal(b.bash(command)?.code, "ci_checks_read", `${command} was allowed`);
	}
	assert.equal(b.bash("gh run rerun 123"), undefined);
	assert.equal(b.bash('gh issue create --body "document statusCheckRollup"'), undefined);
	assert.equal(b.bash("gh --repo acme/demo pr view 12 --json number"), undefined);
	assert.equal(b.bash("gh api repos/acme/demo/issues/1/comments --field=body=hello"), undefined);
});

// -- diff-review bodies ------------------------------------------------------

test("read/grep of a diff-review body is blocked with the sanctioned alternative", (t) => {
	const b = bench(t);
	for (const path of [
		"state/runs/cp-research-1/review-1/verdict.json",
		"state/runs/cp-research-1/review-1/review/diff.patch",
		join(b.home, LAYOUT.runs, "cp-research-1/review-1/review/diff.patch"),
		"@state/runs/cp-research-1/review-1/verdict.json",
	]) {
		const decision = b.tool("read", path);
		assert.ok(decision, `read ${path} was allowed`);
		assert.equal(decision.code, "diff_body_read");
		assert.match(decision.reason, /verdict is the interface/);
		assert.match(decision.reason, /never reads a diff body/);
	}
	assert.equal(b.tool("grep", "state/runs/cp-research-1/review-1/review/diff.patch")?.code, "diff_body_read");
});

test("a non-review path under state/runs/ is not blocked", (t) => {
	const b = bench(t);
	for (const path of [
		"state/runs/cp-research-1/status.json",
		"state/runs/cp-research-1/review-1.json",
		"state/runs/cp-research-1/gate-1/verdict.json",
		"state/runs/cp-research-1/review-notes/plan.md",
	]) {
		assert.equal(b.tool("read", path), undefined, `read ${path} was blocked`);
	}
	assert.equal(b.bash("cat state/runs/cp-research-1/review-1.json"), undefined);
});

test("bash may describe a diff-review directory but never emit its contents", (t) => {
	const b = bench(t);
	for (const command of [
		"ls state/runs/cp-research-1/review-1",
		"stat state/runs/cp-research-1/review-1/verdict.json",
		"wc -l state/runs/cp-research-1/review-1/review/diff.patch",
		"find state/runs/cp-research-1/review-1 -name '*.patch'",
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
	for (const command of [
		"cat state/runs/cp-research-1/review-1/review/diff.patch",
		"head -50 state/runs/cp-research-1/review-1/verdict.json",
		"rg findings state/runs/cp-research-1/review-1",
		"cat state/runs/cp-research-1/review-1/verdict.json | head -5",
		"ls $(cat state/runs/cp-research-1/review-1/verdict.json)",
		`cat ${join(b.home, LAYOUT.runs, "cp-research-1/review-1/review/diff.patch")}`,
	]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "diff_body_read", `${command} was allowed`);
		assert.match(decision.reason, /review-<n>\.json/);
	}
});

// -- ledger -----------------------------------------------------------------

test("the ledger has no bash surface any more: br-shaped commands are neither blocked nor special", (t) => {
	const b = bench(t);
	for (const command of ["br show cp-research-1", "br list --status open", "br ready --json"]) {
		assert.equal(b.bash(command), undefined, `${command} is an ordinary command now`);
	}
	assert.ok(!(GUARD_CODES as readonly string[]).includes("ledger_inlines_artifact"));
});

// -- never-commit paths -----------------------------------------------------

test("staging or pushing runtime state is blocked, source is not", (t) => {
	const b = bench(t);
	for (const command of [
		"git add .pi-command-post/state/fleet.json",
		"git add .pi-command-post/data/learnings.md",
		"git add .beads/issues.jsonl",
		"git add .pi-command-post/jobs.json",
		// The retired type/priority values a mutation archived (2026-09-05). It
		// sits beside the ledger in both modes precisely so this guard covers it.
		"git add .pi-command-post/jobs-legacy-fields.jsonl",
		`git add ${join(b.home, ".pi-command-post/jobs-legacy-fields.jsonl")}`,
		"git add .pi-command-post/projects/acme",
		"git commit -m wip .pi-command-post/state/fleet.json",
		"git -C /tmp/elsewhere add .beads",
		`git add ${join(b.home, LAYOUT.runs, "cp-research-1/events.jsonl")}`,
		"git rm -r --cached .pi-command-post",
	]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "never_commit_path", `${command} was allowed`);
		assert.match(decision.reason, /never\s+committed or pushed/);
	}
	for (const command of [
		"git add src/guards.ts",
		"git add data.json",
		// cp-u3i2: a top-level `state/` is no longer runtime state, so staging it is allowed.
		"git add state/x",
		"git commit -m 'guards' src/guards.ts",
		"git status --porcelain",
		"git log --oneline -5",
	]) {
		assert.equal(b.bash(command), undefined, `${command} was blocked`);
	}
});

test("bulk staging is blocked in the home and allowed elsewhere", (t) => {
	const b = bench(t);
	for (const command of ["git add -A", "git add .", "git add --all", "git commit -am wip", "git commit -a -m wip"]) {
		const decision = b.bash(command);
		assert.equal(decision?.code, "bulk_stage_in_home", `${command} was allowed in the home`);
		assert.match(decision.reason, /explicit source paths/);
	}
	// A worktree is not the command post home: bulk staging there is the
	// worker's business, not ours.
	assert.equal(b.bash("git add -A", "/tmp"), undefined);
	assert.equal(b.bash("git commit -m wip", "/tmp"), undefined);
	assert.equal(b.bash("git commit -m wip"), undefined, "an explicit commit in the home is fine");
});

test("parent git mutations cannot target a live lease, including -C and compound statements", (t) => {
	const b = bench(t);
	const lease = join(b.home, "leases", "cp-live");
	mkdirSync(lease, { recursive: true });
	const guard = new ContextGuard({ home: b.home, artifacts: b.artifacts, leases: () => [lease] });
	const check = (command: string, cwd = b.home) => guard.check({ toolName: "bash", input: { command }, cwd });
	for (const command of ["git reset --hard HEAD", "git checkout main", "git switch main", "git clean -fd", "git push --force origin main", "git push -f", "git -C . reset --hard", "git status && git reset --hard HEAD"]) {
		const decision = check(command, lease);
		assert.equal(decision?.code, "leased_git_mutation", command);
		assert.match(decision.reason, /cp_send|cp_revive/);
	}
	assert.equal(check(`git -C ${lease} reset --hard HEAD`)?.code, "leased_git_mutation");
	assert.equal(check(`git --work-tree=${lease} reset --hard HEAD`)?.code, "leased_git_mutation");
	assert.equal(check(`git --git-dir=${lease}/.git reset --hard HEAD`)?.code, "leased_git_mutation");
	assert.equal(check(`git -C ${lease} status && git -C ${lease} clean -fd`)?.code, "leased_git_mutation");
	assert.equal(check(`cd ${lease} && git reset --hard HEAD`)?.code, "leased_git_mutation");
	assert.equal(check("cd $LEASE && git reset --hard HEAD")?.code, "leased_git_mutation", "an unresolved cwd may enter the lease");
	assert.equal(check("cd ~/leases/cp-live && git reset --hard HEAD")?.code, "leased_git_mutation", "shell tilde expansion cannot be treated as a literal cwd");
	assert.equal(check("git -C ~/leases/cp-live reset --hard HEAD")?.code, "leased_git_mutation", "git -C expands tilde before git runs");
	assert.equal(check("git -C~/leases/cp-live reset --hard HEAD")?.code, "leased_git_mutation", "combined -C must fail closed too");
	assert.equal(check("cd $LEASE && git fetch origin"), undefined, "read-only git stays allowed");
	assert.equal(check("cd $LEASE && cd /tmp && git reset --hard HEAD"), undefined, "a later known cwd outside clears uncertainty");
	assert.equal(check(`GIT_DIR=${lease}/.git git reset --hard HEAD`)?.code, "leased_git_mutation");
	assert.equal(check("GIT_DIR=/tmp/other.git git reset --hard HEAD"), undefined);
	assert.equal(check("git -C '$LEASE' reset --hard HEAD")?.code, "leased_git_mutation", "unresolved target cannot prove it is outside a lease");
	for (const command of ["git status", "git log -1", "git fetch origin", "git push origin main"]) {
		assert.equal(check(command, lease), undefined, command);
	}
	assert.equal(check("git reset --hard HEAD", b.home), undefined);
	assert.equal(check("git -C /tmp reset --hard HEAD"), undefined);
	const returned = new ContextGuard({ home: b.home, artifacts: b.artifacts, leases: () => [] });
	assert.equal(returned.check({ toolName: "bash", input: { command: "git reset --hard HEAD" }, cwd: lease }), undefined);
});

// -- shape ------------------------------------------------------------------

test("non-guarded tools and shell shapes are left alone", (t) => {
	const b = bench(t);
	assert.equal(b.guard.check({ toolName: "cp_artifact", input: { job_id: "cp-research-1", action: "get" } }), undefined);
	assert.equal(b.guard.check({ toolName: "read", input: {} }), undefined);
	assert.equal(b.guard.check({ toolName: "read", input: null }), undefined);
	assert.equal(b.bash(""), undefined);
	assert.deepEqual(splitSegments("a && b; c | d"), ["a", "b", "c", "d"]);
	assert.deepEqual(parseGit(["git", "-C", "/tmp", "add", "-A"]), { subcommand: "add", args: ["-A"] });
	assert.match(
		formatGuardDecision(b.tool("read", ".pi-command-post/state/artifacts/cp-research-1/report.md") as GuardDecision),
		/^\[artifact_body_read\]/,
	);
});

// -- wiring -----------------------------------------------------------------

/**
 * The guard is only real if pi enforces it. A parent pi session with the
 * command-post extension is scripted to `read` an artifact body; the tool must
 * come back as an error carrying the block reason, and the artifact body must
 * never appear in the transcript.
 */
test("pi blocks a scripted parent read of an artifact body", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const artifacts = new ArtifactStore({ home: home.path });
	const secret = "SUPER-SECRET-FINDINGS-BODY";
	writeFileSync(artifacts.path("cp-guard-1"), `# findings\n${secret}\n`);

	const handoff = join(home.path, "handoff/task.md");
	const model = provider.addScript("guard-wiring", [
		{
			kind: "tool_calls",
			calls: [{ name: "read", args: { path: join(home.path, LAYOUT.artifacts, "cp-guard-1/report.md") } }],
		},
		{
			kind: "tool_calls",
			calls: [{ name: "cp_artifact", args: { action: "get", job_id: "cp-guard-1", out: handoff } }],
		},
		{ kind: "text", text: "acknowledged" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model,
		env: { ...agentDir.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION],
		tools: ["read", "bash", "cp_artifact"],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});

	await child.prompt("read the artifact");
	await child.waitForSettled(60_000);

	const ends = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "read");
	assert.equal(ends.length, 1, `expected one read attempt, got ${ends.length}`);
	const end = ends[0] as { isError?: boolean; result?: { content?: Array<{ text?: string }> } };
	assert.equal(end.isError, true, "the blocked read must be reported as an error");
	const text = JSON.stringify(end.result ?? {});
	assert.match(text, /cp_artifact get/);
	assert.ok(!text.includes(secret), "the artifact body reached the parent's context");

	// The operator sees that a rule held, coded so it can be grepped.
	const notices = child
		.records()
		.filter((record) => record.type === "extension_ui_request" && record.method === "notify");
	assert.ok(
		notices.some((record) => typeof record.message === "string" && record.message.startsWith("[artifact_body_read]")),
		`no operator notice for the blocked read: ${JSON.stringify(notices)}`,
	);

	// The sanctioned path works in the same session, and still hands back only
	// metadata: the body lands in a file a worker can be pointed at.
	const gets = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_artifact");
	assert.equal(gets.length, 1, `expected one cp_artifact call, got ${gets.length}`);
	assert.notEqual((gets[0] as { isError?: boolean }).isError, true, `cp_artifact get failed: ${JSON.stringify(gets[0])}`);
	assert.equal(readFileSync(handoff, "utf8"), `# findings\n${secret}\n`);

	// Nothing anywhere in the session transcript carries the body.
	assert.ok(!JSON.stringify(child.records()).includes(secret), "the artifact body leaked into the RPC stream");
});
