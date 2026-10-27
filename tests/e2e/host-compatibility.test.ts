/**
 * Behavior 24 (P24): packaging and host compatibility through real pi hosts on scratch homes — the command-post
 * extension loaded by pi, its tool_call guards on scripted parent tool calls, /doctor's MCP lines over a stubbed
 * `pi mcp list`, and the pi-lens activation a dispatched worker gets from a fake installed package.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULT_ORIGIN, type DoctorReport, EMPTY_USAGE, LAYOUT } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { readPackageIdentity } from "../../extensions/command-post/index.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MockProvider,
	type PiChild,
	REPO_ROOT,
	type RpcRecord,
	type ScriptStep,
	startPiChild,
	startRpc,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";
import { environ, fakeExtension, flagValues, installPackage, offeredTools, packageBench, writeSkill } from "../harness/package-home.ts";

interface CommandsResponse extends RpcRecord {
	success?: boolean;
	data?: { commands?: Array<{ name: string; description?: string; source: string }> };
}

test("P24 extension load: a real pi loads the command-post extension, registers its commands, sweeps the home and /cp-version reports identity, home and commit", { timeout: 60_000 }, async (t) => {
	// A scratch home: session_start scaffolds whatever home it is pointed at, never the operator's checkout.
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.fleetFile), JSON.stringify({ schema_version: 1, updated_at: "2026-09-01T00:00:00Z", jobs: [{ br_id: "cp-legacy" }] }));
	const rpc = startRpc({ cwd: REPO_ROOT, args: ["--no-session", "-e", COMMAND_POST_EXTENSION], env: { CP_HOME: home.path } });
	t.after(async () => { await rpc.close(); home.cleanup(); });
	rpc.send({ id: "cmds", type: "get_commands" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as CommandsResponse;
	assert.equal(response.success, true, `get_commands failed: ${JSON.stringify(response)}`);
	const commands = response.data?.commands ?? [];
	const source = (name: string) => commands.find((command) => command.name === name)?.source;
	assert.equal(source("cp-version"), "extension", "/cp-version is registered by the extension");
	assert.equal(source("cp-ask"), "extension", "/cp-ask is registered by the extension");
	assert.equal(source("cp-jobs"), "extension", "/cp-jobs is registered by the extension");
	assert.equal(source("cp-attach"), undefined, "retired /cp-attach stays unregistered");
	assert.equal(source("cp-next"), undefined, "retired /cp-next stays unregistered");
	assert.equal(source("cp-mode"), undefined, "retired /cp-mode stays unregistered");
	rpc.send({ id: "run", type: "prompt", message: "/cp-version" });
	const identity = readPackageIdentity();
	// session_start's scaffold notification is also a notify and arrives first on a fresh home.
	const notify = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith(`${identity.name} ${identity.version}`));
	const [line, homeLine, commitLine, ...extra] = String(notify.message).split("\n");
	assert.deepEqual(extra, [], "/cp-version prints exactly the identity, home and commit lines");
	assert.equal(line, `${identity.name} ${identity.version} (root: ${identity.root})`);
	assert.match(String(homeLine), new RegExp(`^multi-project mode, home ${home.path} \\(source: CP_HOME`));
	assert.match(String(commitLine), /^commit [0-9a-f]{7} · deployed [0-9a-f]{7} \(current\) · upstream /);
	assert.equal((await rpc.waitFor((r) => r.type === "response" && r.id === "run")).success, true);
	const swept = readFileSync(join(home.path, LAYOUT.fleetFile), "utf8");
	assert.ok(swept.includes('"job_id"'), `fleet.json was not swept: ${swept}`);
	assert.equal(swept.includes('"br_id"'), false, `fleet.json still carries br_id: ${swept}`);
	assert.ok(existsSync(join(home.path, LAYOUT.migrationsDir, "2026-09-job-id.done")), "the sweep marker was not written");
});

// -- guards ------------------------------------------------------------------

interface Call { id: string; name: string; args: Record<string, unknown> }
interface Seen { code: string | undefined; text: string; isError: boolean }
type Case = readonly [Call, string | undefined];

let seq = 0;
const call = (name: string, args: Record<string, unknown>): Call => ({ id: `g${(seq += 1)}`, name, args });
const sh = (command: string) => call("bash", { command });
const read = (path: string) => call("read", { path });
const grep = (path: string) => call("grep", { pattern: "findings", path });
const write = (path: string) => call("write", { path, content: "x\n" });
const edit = (path: string) => call("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
const label = (c: Call) => `${c.name} ${String(c.args.command ?? c.args.path ?? "")}`;

/** A scripted parent on `home` in `cwd`, a no-op `gh` first on PATH; each turn is one model message of tool calls. */
async function parentCalls(t: TestContext, provider: MockProvider, home: string, cwd: string, turns: readonly Call[][]) {
	const model = provider.addScript(`p24-guard-${(seq += 1)}`, [...turns.map((calls): ScriptStep => ({ kind: "tool_calls", calls })), { kind: "text", text: "done" }]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd, model, env: { ...agentDir.env, CP_HOME: home, HOME: join(home, "user"), PATH: ghStubPath(t) }, extensions: [COMMAND_POST_EXTENSION],
		tools: ["read", "bash", "grep", "write", "edit", "cp_artifact"] });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
	});
	await child.prompt("Run the scripted calls.");
	await child.waitForSettled(120_000);
	// The operator's notice is `[code] reason`; the model's tool result carries the reason.
	const notices = child.records().filter((r) => r.type === "extension_ui_request" && r.method === "notify")
		.map((r) => /^\[(\w+)\] ([\s\S]+)$/.exec(String(r.message))).flatMap((m) => (m ? [{ code: m[1] as string, reason: m[2] as string }] : []));
	const seen = new Map<string, Seen>();
	for (const end of child.eventsOfType("tool_execution_end")) {
		const result = end.result as { content?: Array<{ text?: string }> } | undefined;
		const text = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
		const code = notices.filter((n) => text.includes(n.reason)).sort((a, b) => b.reason.length - a.reason.length)[0]?.code;
		seen.set(String(end.toolCallId), { code, text, isError: end.isError === true });
	}
	return { seen, records: child.records(), notices };
}

test("P24 guards: a real parent's read, grep, write, edit and bash calls are refused with the guard's code and sanctioned path, the rest run, and cp_artifact get hands a body to a file", { timeout: 300_000 }, async (t) => {
	const scratch = createScratchHome();
	const home = realpathSync(scratch.path);
	const provider = await MockProvider.start();
	t.after(async () => {
		await provider.stop();
		scratch.cleanup();
	});
	mkdirSync(join(home, "user"), { recursive: true });
	const artifactFile = (job: string) => join(home, LAYOUT.artifacts, job, "report.md");
	mkdirSync(join(home, LAYOUT.artifacts, "cp-research-1"), { recursive: true });
	mkdirSync(join(home, LAYOUT.artifacts, "cp-empty-1"), { recursive: true });
	mkdirSync(join(home, LAYOUT.artifacts, "cp-guard-1"), { recursive: true });
	writeFileSync(artifactFile("cp-research-1"), "# findings\nbody\n");
	const secret = "SUPER-SECRET-FINDINGS-BODY";
	writeFileSync(artifactFile("cp-guard-1"), `# findings\n${secret}\n`);
	const lease = join(home, "leases", "cp-live");
	const clone = join(home, LAYOUT.projects, "demo");
	const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "cp-p24-elsewhere-")));
	t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
	for (const dir of [lease, clone]) mkdirSync(dir, { recursive: true });
	const fleet = (phase: string) => writeFileSync(join(home, LAYOUT.fleetFile), JSON.stringify({ schema_version: 1, updated_at: "2026-09-01T00:00:00Z", jobs: [{
		job_id: "cp-live", project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase, worktree: lease, branch: "cp-live",
		dispatched_at: "2026-09-01T00:00:00Z", usage: EMPTY_USAGE, worker: { pid: 999_999_999, session_id: "s", session_file: "/sessions/gone.jsonl",
			profile: "implementer", role: "implementer", model: "mock/x", started_at: "2026-09-01T00:00:00Z" } }] }));
	fleet("waiting");

	const A = ".pi-command-post/state/artifacts/cp-research-1/report.md";
	const DIR = ".pi-command-post/state/artifacts";
	const Q = "state/runs/cp-research-1/questions.jsonl";
	const RA = "state/runs/cp-research-1/review-approval.json";
	const R = "state/runs/cp-research-1/review-1/verdict.json";
	const DIFF = "state/runs/cp-research-1/review-1/review/diff.patch";
	const SC = "state/schedule-control.jsonl";
	const absArtifact = join(home, LAYOUT.artifacts, "cp-research-1/report.md");
	const absDiff = join(home, LAYOUT.runs, "cp-research-1/review-1/review/diff.patch");
	const handoff = join(home, "handoff/task.md");
	const allowed = (calls: Call[]): Case[] => calls.map((c) => [c, undefined] as const);
	const refused = (code: string, calls: Call[]): Case[] => calls.map((c) => [c, code] as const);

	const wiringRead = read(artifactFile("cp-guard-1"));
	const wiringGet = call("cp_artifact", { action: "get", job_id: "cp-guard-1", out: handoff });
	const bodyReads = refused("artifact_body_read", [read(A), read(absArtifact), read(`@${A}`), read("./.pi-command-post/state/artifacts/cp-research-1/../cp-research-1/report.md")]);
	const bodyGrep = refused("artifact_body_read", [grep(DIR)]);
	const authorship = refused("artifact_body_write", [edit(A), write(A)]);
	const runReads = allowed([read("state/runs/cp-research-1/status.json"), read("state/runs/cp-research-1/envelope.json"), read("state/runs/cp-research-1/verdict.json"),
		read("state/fleet.json"), read(join(home, LAYOUT.learningsFile))]);
	const journalTools = refused("question_journal_read", [read(Q), read(join(home, LAYOUT.runs, "cp-research-1/questions.jsonl")), grep(Q), grep(join(home, LAYOUT.runs, "cp-research-1/questions.jsonl"))]);
	const journalBash: Case[] = [...refused("question_journal_read", [sh(`cat ${Q}`), sh(`jq . ${Q}`)]), ...allowed([sh(`wc -l ${Q}`), read("state/runs/cp-research-1/status.json"), write(Q)])];
	const approval = refused("review_approval_read", [read(RA), sh(`cat ${RA}`), grep(RA)]);
	const describeArtifact = allowed([sh(`ls ${DIR}`), sh(`ls -la ${DIR}/cp-research-1`), sh(`stat ${A}`), sh(`wc -l ${A}`), sh(`find ${DIR} -name report.md`), sh(`wc -l < ${A}`)]);
	const emitArtifact = refused("artifact_body_read", [sh(`cat ${A}`), sh(`head -50 ${A}`), sh(`rg findings ${DIR}`), sh(`ls ${DIR} && cat ${A}`), sh(`cat ${A} | head -5`),
		sh(`ls $(cat ${A})`), sh(`wc -l < ${A} > /tmp/out`), sh(`wc -l < $(echo ${A})`), sh(`cat ${absArtifact}`)]);
	const promised = allowed([sh(`wc -c < ${A}`), sh(`wc -c ${A}`), sh(`stat ${A}`), sh(`ls -l ${A}`)]);
	const prose = allowed([sh(`echo "done, see ${A} for the writeup"`), sh(`echo "see ${A} and stat ${A}"`), sh(`echo "follow up on the findings in ${A}"`)]);
	const stillRefused = refused("artifact_body_read", [sh(`cat ${A}`), sh(`head ${A}`), sh(`tail ${A}`), sh(`sed -n '1,2p' ${A}`), sh(`grep findings ${A}`), read(A)]);
	const compound = sh(`ls ${DIR} && echo "see ${A}" && cat ${A}`);
	const mentions = allowed([sh(`echo "the stages are defined in ${A}"`), sh(`echo "see ${A} for the plan"`), sh(`echo "the artifact lives at ${A}"`),
		sh(`git commit -m "reference ${A} in the brief" src/guards.ts`)]);
	const indirection = refused("artifact_body_read", [sh(`cat ${A}`), sh(`read ${A}`), sh(`less ${A}`), sh(`more ${A}`), sh(`head ${A}`), sh(`tail ${A}`),
		sh(`cp ${A} /tmp/out.md`), sh(`mv ${A} /tmp/out.md`), sh(`cat < ${A}`), sh(`echo hi > ${A}`), sh(`cat /etc/hosts >> ${A}`), sh(`echo ${A} | xargs cat`),
		sh(`sh -c "cat ${A}"`), sh(`ls $(cat ${A})`)]);
	const reviewMentions = allowed([sh(`echo "the diff landed at ${R}"`), sh(`echo "see ${R} for the diff"`), sh(`echo "the review scratch dir is ${R}"`),
		sh(`git commit -m "reference ${R} in the brief" src/guards.ts`)]);
	const reviewIndirection = refused("diff_body_read", [sh(`cat ${R}`), sh(`less ${R}`), sh(`head ${R}`), sh(`tail ${R}`), sh(`cp ${R} /tmp/out.json`), sh(`mv ${R} /tmp/out.json`),
		sh(`cat < ${R}`), sh(`echo hi > ${R}`), sh(`echo ${R} | xargs cat`), sh(`sh -c "cat ${R}"`), sh(`ls $(cat ${R})`)]);
	const checksApi = refused("ci_checks_read", ["gh pr checks 12", "gh pr view 12 --json statusCheckRollup", "gh pr view 12 --json=number,statusCheckRollup", "cd x && gh pr checks 12",
		"gh --repo acme/demo pr checks 12", "gh -R acme/demo pr checks 12", "gh pr -R acme/demo checks 12", "gh api graphql -f query='{ pr { statusCheckRollup } }'",
		"gh api graphql --field=query=statusCheckRollup", "gh api graphql --raw-field=query=statusCheckRollup", "gh api graphql -fquery=statusCheckRollup"].map(sh));
	const checksRest = refused("ci_checks_read", ["gh run list --branch cp-a1", "gh run view 123 --log-failed", "gh -R acme/demo run list --limit 3", "gh run -R acme/demo view 123",
		"gh api repos/acme/demo/commits/abc123/check-runs", "gh api repos/acme/demo/commits/abc123/check-suites --paginate", "gh api 'repos/acme/demo/commits/abc123/status?per_page=1'",
		"gh api repos/acme/demo/commits/abc123/statuses", "gh api repos/acme/demo/statuses/abc123", "gh api -X GET /repos/acme/demo/check-runs/9",
		"gh api https://api.github.com/repos/acme/demo/commits/main/check-runs", "gh api --hostname ghe.example https://ghe.example/api/v3/repos/acme/demo/statuses/abc",
		"gh api 'repos/{owner}/{repo}/actions/runs?head_sha=abc&per_page=100'", "gh api repos/acme/demo/actions/runs/9/attempts/2/jobs", "gh api repos/acme/demo/actions/workflows"].map(sh));
	const ghAllowed = allowed(["gh run rerun 123", 'gh issue create --body "document statusCheckRollup"', "gh --repo acme/demo pr view 12 --json number",
		"gh api repos/acme/demo/issues/1/comments --field=body=hello", "gh api repos/acme/demo/pulls/7", "gh api repos/acme/demo/pulls/7/reviews",
		"gh api repos/acme/demo/issues/1/comments -f body='see repos/acme/demo/commits/a/check-runs'", 'gh pr create --title "read check-runs" --body "drop repos/o/r/statuses/abc"'].map(sh));
	const scheduleTools = refused("schedule_control_write", [write(SC), edit(SC)]);
	const scheduleBash = refused("schedule_control_write", [`echo '{"type":"request","by":"viewer"}' >> ${SC}`, "printf x > .pi-command-post/state/schedule-control.jsonl",
		`tee -a ${SC} < line.json`, `cp forged.jsonl ${SC}`, `cat forged.jsonl >> ${SC}`, `python3 -c "open('${SC}','a').write('x')"`, "cd state && node -e 'x' schedule-control.jsonl",
		`sed -i s/a/b/ ${SC}`].map(sh));
	const scheduleReads = allowed([read(SC), sh(`tail -n 5 ${SC}`), sh(`wc -l ${SC}`), sh(`grep run_now ${SC} | jq .id`)]);
	const diffReads = refused("diff_body_read", [read(R), read(DIFF), read(absDiff), read(`@${R}`)]);
	const diffGrep = refused("diff_body_read", [grep(DIFF)]);
	const nonReview = allowed([read("state/runs/cp-research-1/status.json"), read("state/runs/cp-research-1/review-1.json"), read("state/runs/cp-research-1/gate-1/verdict.json"),
		read("state/runs/cp-research-1/review-notes/plan.md"), sh("cat state/runs/cp-research-1/review-1.json")]);
	const describeReview = allowed([sh("ls state/runs/cp-research-1/review-1"), sh(`stat ${R}`), sh(`wc -l ${DIFF}`), sh("find state/runs/cp-research-1/review-1 -name '*.patch'")]);
	const emitReview = refused("diff_body_read", [sh(`cat ${DIFF}`), sh(`head -50 ${R}`), sh("rg findings state/runs/cp-research-1/review-1"), sh(`cat ${R} | head -5`),
		sh(`ls $(cat ${R})`), sh(`cat ${absDiff}`)]);
	const ledgerShaped = allowed(["external-tool show cp-research-1", "external-tool list --status open", "external-tool ready --json"].map(sh));
	const neverCommit = refused("never_commit_path", ["git add .pi-command-post/state/fleet.json", "git add .pi-command-post/data/learnings.md", "git add .pi-command-post/jobs.json",
		"git add .pi-command-post/jobs-legacy-fields.jsonl", `git add ${join(home, ".pi-command-post/jobs-legacy-fields.jsonl")}`, "git add .pi-command-post/projects/acme",
		"git commit -m wip .pi-command-post/state/fleet.json", "git -C /tmp/elsewhere add .pi-command-post", "cd $HOME && git add .pi-command-post",
		`git add ${join(home, LAYOUT.runs, "cp-research-1/events.jsonl")}`, "git rm -r --cached .pi-command-post"].map(sh));
	const sourceStaging = allowed(["git add src/guards.ts", "git add data.json", "git add state/x", "git commit -m 'guards' src/guards.ts", "git status --porcelain", "git log --oneline -5"].map(sh));
	const bulkHome: Case[] = [...refused("bulk_stage_in_home", ["git add -A", "git add .", "git add --all", "git commit -am wip", "git commit -a -m wip"].map(sh)), ...allowed([sh("git commit -m wip")])];
	const leaseFromHome: Case[] = [...refused("leased_git_mutation", [`git -C ${lease} reset --hard HEAD`, `git --work-tree=${lease} reset --hard HEAD`, `git --git-dir=${lease}/.git reset --hard HEAD`,
		`git -C ${lease} status && git -C ${lease} clean -fd`, `cd ${lease} && git reset --hard HEAD`, "cd $LEASE && git reset --hard HEAD", "cd ~/leases/cp-live && git reset --hard HEAD",
		"git -C ~/leases/cp-live reset --hard HEAD", "git -C~/leases/cp-live reset --hard HEAD", "cd $LEASE && git fetch origin", `GIT_DIR=${lease}/.git git reset --hard HEAD`,
		"git -C '$LEASE' reset --hard HEAD"].map(sh)),
	...allowed(["cd $LEASE && git status", "cd $LEASE && cd /tmp && git reset --hard HEAD", "GIT_DIR=/tmp/other.git git reset --hard HEAD", "git reset --hard HEAD", "git -C /tmp reset --hard HEAD"].map(sh))];
	const cloneFromHome: Case[] = [...refused("canonical_git_mutation", [`git -C ${clone} fetch origin main`, `cd ${clone} && git fetch`, `git -C ${clone} clean -fdx`, `git -C ${clone} checkout main`,
		`git -C ${clone} switch -C main origin/main`, `git -C ${clone} switch --discard-changes main`, `cd ${clone} && git push --force origin main`].map(sh)),
	...allowed([`git -C ${clone} switch main`, `git -C ${clone} status`, "git -C /tmp fetch origin", "git -C /tmp reset --hard HEAD"].map(sh))];
	const shapes = allowed([sh(""), call("read", {})]);
	const groups = [bodyReads, bodyGrep, authorship, runReads, journalTools, journalBash, approval, describeArtifact, emitArtifact, promised, prose, stillRefused, [[compound, "artifact_body_read"] as const],
		mentions, indirection, reviewMentions, reviewIndirection, checksApi, checksRest, ghAllowed, scheduleTools, scheduleBash, scheduleReads, diffReads, diffGrep, nonReview,
		describeReview, emitReview, ledgerShaped, neverCommit, sourceStaging, bulkHome, leaseFromHome, cloneFromHome, shapes];
	const fromHome = await parentCalls(t, provider, home, home, [[wiringRead], [wiringGet], ...groups.map((cases) => cases.map(([c]) => c))]);

	const inLease: Case[] = [...refused("leased_git_mutation", ["git reset --hard HEAD", "git checkout main", "git switch main", "git clean -fd", "git push --force origin main", "git push -f",
		"git -C . reset --hard", "git status && git reset --hard HEAD", "git fetch origin", "git pull --ff-only"].map(sh)), ...allowed(["git status", "git log -1", "git push origin main"].map(sh))];
	const fromLease = await parentCalls(t, provider, home, lease, [inLease.map(([c]) => c)]);
	const inClone = refused("canonical_git_mutation", ["git fetch origin", "git pull", "git reset --hard origin/main"].map(sh));
	const fromClone = await parentCalls(t, provider, home, clone, [inClone.map(([c]) => c)]);
	const inElsewhere: Case[] = [...refused("never_commit_path", [sh("git add .pi-command-post/state/fleet.json")]), ...allowed([sh("git add -A"), sh("git commit -m wip")])];
	const fromElsewhere = await parentCalls(t, provider, home, elsewhere, [inElsewhere.map(([c]) => c)]);
	fleet("done");
	const returnedLease = allowed([sh("git reset --hard HEAD")]);
	const fromReturned = await parentCalls(t, provider, home, lease, [returnedLease.map(([c]) => c)]);

	const run = { ...Object.fromEntries(fromHome.seen), ...Object.fromEntries(fromLease.seen), ...Object.fromEntries(fromClone.seen), ...Object.fromEntries(fromElsewhere.seen),
		...Object.fromEntries(fromReturned.seen) } as Record<string, Seen>;
	const codes = (cases: readonly Case[]) => cases.map(([c]) => [label(c), run[c.id]?.code] as const);
	const expected = (cases: readonly Case[]) => cases.map(([c, code]) => [label(c), code] as const);
	const reasons = (cases: readonly Case[]) => cases.filter(([, code]) => code).map(([c]) => run[c.id]?.text ?? "").join("\n---\n");
	const everyReason = (cases: readonly Case[], pattern: RegExp) => cases.filter(([, code]) => code).every(([c]) => pattern.test(run[c.id]?.text ?? ""));

	// The wiring: a blocked read is an error carrying the reason, the operator sees `[code]`, cp_artifact get works.
	assert.deepEqual([run[wiringRead.id]?.isError, run[wiringRead.id]?.code], [true, "artifact_body_read"], JSON.stringify(run[wiringRead.id]));
	assert.match(run[wiringRead.id]?.text ?? "", /cp_artifact get/);
	assert.ok(fromHome.records.some((r) => r.method === "notify" && String(r.message).startsWith("[artifact_body_read]")), "no operator notice for the blocked read");
	assert.equal(run[wiringGet.id]?.isError, false, `cp_artifact get failed: ${run[wiringGet.id]?.text}`);
	assert.equal(readFileSync(handoff, "utf8"), `# findings\n${secret}\n`);
	assert.equal(JSON.stringify([fromHome.records, fromLease.records]).includes(secret), false, "the artifact body leaked into the RPC stream");

	assert.deepEqual(codes([...bodyReads, ...bodyGrep]), expected([...bodyReads, ...bodyGrep]));
	assert.ok(everyReason(bodyReads, /cp_artifact get[\s\S]*never reads|never reads[\s\S]*cp_artifact get/), reasons(bodyReads));
	assert.deepEqual(codes(authorship), expected(authorship));
	assert.ok(everyReason(authorship, /cp_artifact add/), reasons(authorship));
	assert.deepEqual(codes(runReads), expected(runReads));
	assert.deepEqual(codes(journalTools), expected(journalTools));
	assert.ok(everyReason(journalTools, /\/watch <job-id>/), reasons(journalTools));
	assert.deepEqual(codes(journalBash), expected(journalBash));
	assert.deepEqual(codes(approval), expected(approval));
	assert.deepEqual(codes(describeArtifact), expected(describeArtifact));
	assert.deepEqual(codes(emitArtifact), expected(emitArtifact));
	assert.ok(everyReason(emitArtifact, /cp_artifact/), reasons(emitArtifact));
	assert.deepEqual(codes(promised), expected(promised));
	assert.deepEqual(codes(prose), expected(prose));
	assert.deepEqual(codes(stillRefused), expected(stillRefused));
	assert.equal(run[compound.id]?.code, "artifact_body_read");
	assert.ok(run[compound.id]?.text.includes(`blocked: ${A} is an artifact body`), `the reason names the path, not the command: ${run[compound.id]?.text}`);
	assert.deepEqual(codes(mentions), expected(mentions));
	assert.deepEqual(codes(indirection), expected(indirection));
	assert.ok(everyReason(indirection, /cp_artifact/), reasons(indirection));
	assert.deepEqual(codes(reviewMentions), expected(reviewMentions));
	assert.deepEqual(codes(reviewIndirection), expected(reviewIndirection));
	assert.ok(everyReason(reviewIndirection, /review-<n>\.json/), reasons(reviewIndirection));
	assert.deepEqual(codes(checksApi), expected(checksApi));
	assert.ok(everyReason(checksApi, /cp_integrate <job-id>/), reasons(checksApi));
	assert.deepEqual(codes(checksRest), expected(checksRest));
	assert.deepEqual(codes(ghAllowed), expected(ghAllowed));
	assert.deepEqual(codes([...scheduleTools, ...scheduleBash]), expected([...scheduleTools, ...scheduleBash]));
	assert.ok(everyReason(scheduleTools, /Run now/), reasons(scheduleTools));
	assert.deepEqual(codes(scheduleReads), expected(scheduleReads));
	assert.deepEqual(codes([...diffReads, ...diffGrep]), expected([...diffReads, ...diffGrep]));
	assert.ok(everyReason(diffReads, /verdict is the interface[\s\S]*never reads a diff body|never reads a diff body[\s\S]*verdict is the interface/), reasons(diffReads));
	assert.deepEqual(codes(nonReview), expected(nonReview));
	assert.deepEqual(codes(describeReview), expected(describeReview));
	assert.deepEqual(codes(emitReview), expected(emitReview));
	assert.ok(everyReason(emitReview, /review-<n>\.json/), reasons(emitReview));
	assert.deepEqual(codes(ledgerShaped), expected(ledgerShaped));
	assert.deepEqual(codes(neverCommit), expected(neverCommit));
	assert.ok(everyReason(neverCommit, /never\s+committed or pushed/), reasons(neverCommit));
	assert.deepEqual(codes(sourceStaging), expected(sourceStaging));
	assert.deepEqual(codes(inElsewhere), expected(inElsewhere));
	assert.deepEqual(codes(bulkHome), expected(bulkHome));
	assert.ok(everyReason(bulkHome, /explicit source paths/), reasons(bulkHome));
	assert.deepEqual(codes(inLease), expected(inLease));
	assert.ok(everyReason(inLease, /cp_send|cp_revive/), reasons(inLease));
	assert.deepEqual(codes(leaseFromHome), expected(leaseFromHome));
	assert.deepEqual(codes(returnedLease), expected(returnedLease));
	assert.deepEqual(codes([...inClone, ...cloneFromHome]), expected([...inClone, ...cloneFromHome]));
	assert.ok(everyReason([...inClone, ...cloneFromHome], /cp_check and cp_dispatch fetch/), reasons(inClone));
	assert.deepEqual(codes(shapes), expected(shapes));
});

// -- MCP access ----------------------------------------------------------------

/** A parent with a `pi` stub first on PATH: `pi mcp list --json` is canned and logged, any other call runs real pi. */
async function mcpParent(t: TestContext) {
	const scratch = createScratchHome();
	const home = realpathSync(scratch.path);
	const bin = realpathSync(mkdtempSync(join(tmpdir(), "cp-p24-bin-")));
	const realPi = realpathSync(whichAll("pi")[0] as string);
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nif [ "$1 $2 $3" = "mcp list --json" ]; then\n\techo "$*" >> "${bin}/calls.log"\n\t/bin/cat "${bin}/list.out"\n\t/bin/cat "${bin}/list.err" >&2\n\texit "$(/bin/cat "${bin}/list.status")"\nfi\nexec "${realPi}" "$@"\n`, { mode: 0o755 });
	const agentDir = createAgentDir();
	const child = startPiChild({ cwd: home, extensions: [COMMAND_POST_EXTENSION], env: { ...agentDir.env, CP_HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		scratch.cleanup();
		rmSync(bin, { recursive: true, force: true });
	});
	const answer = (out: string, err = "", status = 0) => {
		writeFileSync(join(bin, "list.out"), out);
		writeFileSync(join(bin, "list.err"), err);
		writeFileSync(join(bin, "list.status"), String(status));
	};
	answer("");
	return {
		answer,
		servers: (servers: Record<string, unknown> | string | undefined) => {
			const file = join(agentDir.path, "mcp.json");
			if (servers === undefined) rmSync(file, { force: true });
			else writeFileSync(file, typeof servers === "string" ? servers : JSON.stringify({ mcpServers: servers }));
		},
		calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []),
		doctor: async () => JSON.parse(await ask(child, "/doctor --json", (text) => text.trimStart().startsWith("{"))) as DoctorReport,
	};
}

async function ask(child: PiChild, message: string, answer: (text: string) => boolean): Promise<string> {
	const from = child.records().length;
	child.send({ id: `d${from}`, type: "prompt", message });
	const hit = await child.waitFor((r) => child.records().indexOf(r) >= from && r.type === "extension_ui_request" && r.method === "notify" && answer(String(r.message)), 120_000);
	return String(hit.message);
}

test("P24 MCP access: /doctor --json in a real parent reports mcp.operator and mcp.workers from the agent dir's mcp.json and one stubbed pi mcp list, never a config value", { timeout: 300_000 }, async (t) => {
	const p = await mcpParent(t);
	const mcp = (report: DoctorReport) => {
		const findings = report.findings.filter((finding) => finding.check.startsWith("mcp."));
		return [findings.find((f) => f.check === "mcp.operator"), findings.find((f) => f.check === "mcp.workers")] as const;
	};

	for (const servers of [undefined, { off: { command: "x", enabled: false } }]) {
		p.servers(servers);
		const [operator, workers] = mcp(await p.doctor());
		assert.deepEqual([operator?.severity, workers?.what], ["ok", "read-only workers: no MCP servers configured"]);
	}
	assert.deepEqual(p.calls(), [], "pi mcp list never runs without an enabled server");

	const secret = "sk-live-0123456789abcdefghij";
	p.servers({ docs: { url: "https://mcp.internal.example/mcp", headers: { Authorization: `Bearer ${secret}` } }, local: { command: "/opt/secret-tool", args: ["--token", secret] } });
	p.answer(JSON.stringify({ servers: [
		{ name: "docs", enabled: true, state: "connected", tools: ["a", "b"], transport: "https://mcp.internal.example/mcp" },
		{ name: "local", enabled: true, state: "failed", tools: [], error: `spawn /opt/secret-tool --token ${secret} ENOENT` },
	], errors: [] }));
	const [operator, workers] = mcp(await p.doctor());
	assert.deepEqual(p.calls(), ["mcp list --json"], "one live probe");
	assert.deepEqual([workers?.check, workers?.what], ["mcp.workers", "read-only workers: all 2 servers, read-only tools only"]);
	assert.match(String(workers?.detail), /gate-reviewer, ops, planner, qa via mcp_call/);
	assert.doesNotMatch(String(workers?.what) + String(workers?.detail), /allowlist/);
	assert.deepEqual([operator?.severity, Boolean(operator?.fix)], ["warn", true]);
	assert.match(String(operator?.what), /connected 1\/2; tools 2/);
	assert.match(String(operator?.detail), /local: failed/);
	const printed = JSON.stringify([operator, workers]);
	assert.deepEqual([secret, "/opt/secret-tool", "mcp.internal.example"].filter((value) => printed.includes(value)), [], "no config value is printed");

	p.servers({ a: { command: "/opt/hidden-cmd" } });
	p.answer("", "spawn /opt/hidden-cmd ETIMEDOUT", 1);
	const [noReport] = mcp(await p.doctor());
	assert.deepEqual([noReport?.severity, Boolean(noReport?.fix)], ["warn", true]);
	assert.equal(JSON.stringify(noReport).includes("/opt/hidden-cmd"), false);
	p.servers('{"mcpServers": {"x": "Bearer sk-live-0123456789abcdefghij"');
	const [invalid, invalidWorkers] = mcp(await p.doctor());
	assert.deepEqual([invalid?.severity, Boolean(invalid?.fix)], ["warn", true]);
	assert.equal(JSON.stringify([invalid, invalidWorkers]).includes("sk-live"), false);
	assert.equal(p.calls().length, 2, "an invalid mcp.json is never probed");
});

// -- pi-lens ---------------------------------------------------------------------

const LENS_FLAGS = ["--no-read-guard", "--no-lazy-tools", "--no-lens-context"];
const LENS_TOOLS = ["pi_lens_activate_tools", "lens_diagnostics", "ast_grep_search", "ast_grep_outline"];
const LENS_WITHHELD = ["lsp_navigation", "ast_grep_replace", "lens_diagnostic_mark"];
const SKIP_LENS = treehouseAvailable() ? false : "the pi-lens dispatch e2e needs treehouse on PATH";

test("P24 pi-lens: dispatched workers with pi-lens installed run headless with its flags and a pinned PI_LENS_HOME, get only the structural tools, and a withheld or write tool is refused", { skip: SKIP_LENS, timeout: 300_000 }, async (t) => {
	const log = join(mkdtempSync(join(tmpdir(), "p24-lens-")), "loads.log");
	t.after(() => rmSync(join(log, ".."), { recursive: true, force: true }));
	const f = await packageBench(t, {
		setup(agentDir) {
			const lens = installPackage(agentDir, "pi-lens", { extensions: ["./dist/index.js"], skills: ["./skills"] },
				{ "dist/index.js": fakeExtension("lens", log, { tools: [...LENS_TOOLS, ...LENS_WITHHELD], flags: LENS_FLAGS.map((flag) => flag.slice(2)) }) });
			writeSkill(join(lens, "skills"), "pi-lens-lsp-navigation");
		},
	});
	const dispatch = async (slug: string, kind: "ship" | "research", calls: Array<{ name: string; args: Record<string, unknown> }>) => {
		const jobId = await f.job(slug, kind);
		await f.post.dispatch({ jobId, task: "Exercise the tools.", model: f.script(slug, [{ kind: "tool_calls", calls }, { kind: "hang" }]), fetch: false });
		await waitFor(() => f.provider.requests(slug).length, (n) => n >= 2, { timeoutMs: 120_000, what: `${slug}'s tool results` });
		const record = f.post.fleet.require(jobId);
		const args = f.post.manager.get(jobId)?.plan.args ?? [];
		const requests = f.provider.requests(slug);
		const messages = (requests.at(-1)?.body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
		const results = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
		return { args, env: environ(record.worker.pid as number), worktree: record.worktree, offered: requests.map(offeredTools), results };
	};
	const implementer = await dispatch("impl", "ship", [
		{ name: "lsp_navigation", args: { operation: "documentSymbol", path: "README.md" } },
		{ name: "edit", args: { path: "forbidden.txt", edits: [{ oldText: "a", newText: "b" }] } },
		{ name: "ast_grep_search", args: {} },
	]);
	const planner = await dispatch("plan", "research", ["write", "edit", "replace"].map((name) => ({ name, args: { path: "forbidden.txt", content: "unsafe" } })));

	for (const [name, worker] of Object.entries({ implementer, planner })) {
		assert.deepEqual(LENS_FLAGS.filter((flag) => !worker.args.includes(flag)), [], `${name}: pi-lens runs headless with ${LENS_FLAGS.join(" ")}`);
		assert.ok(worker.env.PI_LENS_HOME && !worker.env.PI_LENS_HOME.startsWith(worker.worktree), `${name}: PI_LENS_HOME is pinned out of the worktree`);
		assert.deepEqual(flagValues(worker.args, "--skill"), [], `${name}: the lsp-navigation skill never reaches a worker`);
		assert.deepEqual(worker.offered.flatMap((tools) => tools.filter((tool) => LENS_WITHHELD.includes(tool))), [], `${name}: withheld lens tools are never offered`);
		assert.equal(existsSync(join(worker.worktree, "forbidden.txt")), false);
	}
	assert.deepEqual(LENS_TOOLS.filter((tool) => !implementer.offered.every((tools) => tools.includes(tool))), [], "the implementer gets all four lens tools");
	assert.match(implementer.results.join("\n"), /ast_grep_search:ran/);
	assert.equal(implementer.offered.some((tools) => tools.includes("edit")), false, "the implementer is never offered edit");
	assert.equal(implementer.results.filter((text) => /not found|not available|unknown tool/i.test(text)).length, 2, `lsp_navigation and edit are refused: ${implementer.results.join("\n")}`);
	assert.deepEqual(planner.offered.map((tools) => tools.filter((tool) => LENS_TOOLS.includes(tool)).sort()), planner.offered.map(() => ["ast_grep_outline", "ast_grep_search"]), "a planner gets the two read-only lens tools");
	assert.equal(planner.offered.some((tools) => tools.some((tool) => ["write", "edit", "replace"].includes(tool))), false, "a planner is never offered a write tool");
	assert.equal(planner.results.filter((text) => /not found|not available|unknown tool/i.test(text)).length, 3, `write, edit and replace are refused: ${planner.results.join("\n")}`);
});

/** PATH with a no-op `gh` first, so an allowed `gh` call in the parent's real bash never reaches GitHub. */
function ghStubPath(t: TestContext): string {
	const bin = realpathSync(mkdtempSync(join(tmpdir(), "cp-p24-gh-")));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return `${bin}:${process.env.PATH ?? ""}`;
}
