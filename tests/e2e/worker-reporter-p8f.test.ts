/**
 * P8f: the worker reporter on real dispatched and gated workers (behavior 04). report_result and report_verdict
 * repair, write-once records and caps, and the tool_call/tool_result guards are read from the run dir, the run log,
 * the fleet record and the model's requests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_REVIEW_ITEM_MAX, VERDICT_RAW_FILE } from "../../extensions/worker-reporter/index.ts";
import { REVIEWER_RAW_FILE } from "../../src/diff-revise-message.ts";
import { ENVELOPE_REPAIR_MAX_ATTEMPTS, type EnvelopeRecord, type GateVerdict, MINIMAL_PLAN_SUMMARY, paths, validate,
	type VerdictRecord, VerdictRecordSchema } from "../../src/contracts.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { PACKAGE_TOOLS } from "../../src/worker-packages.ts";
import { type ScriptStep, treehouseAvailable, waitFor } from "../harness/index.ts";
import { fakeExtension, installPackage, offeredTools, type PackageBench, packageBench } from "../harness/package-home.ts";

const SKIP = treehouseAvailable() ? false : "worker-reporter-p8f e2e needs treehouse on PATH";
const HANG: ScriptStep = { kind: "hang" };
const CAP = ENVELOPE_REPAIR_MAX_ATTEMPTS;
const PR = "https://github.com/org/repo/pull/9";
const ARTIFACT = { kind: "tool_calls", calls: [{ name: "bash", args: { command: "printf '# Goal\\nCache.\\n' > \"$CP_ARTIFACT_PATH\"" } }] } as ScriptStep;
const ASSESSMENT = { confidence: "high", scope: "S", blocking_unknowns: false, destructive_scope: false };
const BLOCKER = { question: "Which store?", why: "Schema depends on it.", options: ["Postgres", "SQLite"], recommended: "SQLite", assume_if_unanswered: "SQLite" };
const FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const STALE = '[E_STALE_ANCHOR] 1 stale anchor in README.md: "ReUA". The file changed since read. Call read() on README.md for fresh anchors.';

const call = (name: string, args: unknown): ScriptStep => ({ kind: "tool_calls", calls: [{ name, args }] });
const head = (f: PackageBench, jobId: string) =>
	execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.post.fleet.require(jobId).worktree, encoding: "utf8" }).trim();
const json = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;
const sent = (f: PackageBench, script: string, index: number) => JSON.stringify(f.provider.requests(script)[index]?.body.messages ?? []);
const toolEnds = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []).map((line) => JSON.parse(line) as { payload?: Record<string, unknown> })
	.filter((event) => event.payload?.type === "tool_execution_end")
	.map(({ payload = {} }) => ({ tool: String(payload.toolName), text: JSON.stringify(payload.result ?? {}) }));

async function dispatch(f: PackageBench, slug: string, kind: "ship" | "research", delivery: "pr" | "pipeline" | "answer", steps: (jobId: string) => ScriptStep[]) {
	const jobId = await f.job(slug, kind, delivery);
	await f.post.dispatch({ jobId, task: "Do the job.", model: f.script(slug, steps(jobId)), fetch: false });
	return jobId;
}
const reported = (f: PackageBench, jobId: string) =>
	waitFor(() => f.post.fleet.get(jobId)?.reported_at, Boolean, { timeoutMs: 90_000, what: `${jobId}'s accepted envelope` });

test("P8f reporter envelopes: a ship report is filed once at the worker, a wrong head or a contract break is repaired in-run, a re-report is a no-op or refused, and past the cap the job fails envelope_invalid", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await packageBench(t);
	const shipped = (jobId: string, extra: Record<string, unknown> = {}) => ({ job_id: jobId, kind: "ship", status: "done",
		summary: "Implemented the ladder; suite green.", branch: jobId, head_sha: head(f, jobId), pr_url: PR, ...extra });
	const report = (args: () => unknown) => ({ name: "report_result", args });
	const ok = await dispatch(f, "ok", "ship", "pr", (id) => [call("report_result", () => shipped(id)), HANG]);
	const stale = await dispatch(f, "head", "ship", "pr", (id) => [call("report_result", () => shipped(id, { head_sha: "f".repeat(40) })),
		call("report_result", () => shipped(id)), HANG]);
	const broken = await dispatch(f, "repair", "ship", "pr", (id) => [call("report_result", () => shipped(id, { job_id: "cp-other", summary: "# Findings\n```\nlots of body\n```" })),
		call("report_result", () => shipped(id)), HANG]);
	const twice = await dispatch(f, "twice", "ship", "pr", (id) => [{ kind: "tool_calls", calls: [report(() => shipped(id)), report(() => shipped(id)),
		report(() => shipped(id, { pr_url: "https://github.com/org/repo/pull/10" }))] }, HANG]);
	const capped = await dispatch(f, "cap", "ship", "pr", (id) => [...Array.from({ length: CAP }, () => call("report_result", { job_id: id, kind: "ship", status: "done", summary: "shipped" })), HANG]);
	for (const id of [ok, stale, broken, twice]) await reported(f, id);
	const failure = (await waitFor(() => f.post.fleet.get(capped)?.failure, Boolean, { timeoutMs: 90_000, what: "the capped job's failure" }))!;

	const record = (id: string) => json<EnvelopeRecord>(join(f.home, paths.envelopeFile(id)));
	const rejection = (id: string) => join(f.home, paths.runDir(id), "envelope-rejected.json");
	assert.deepEqual(record(ok).envelope, shipped(ok), "the report is filed as sent");
	assert.equal(record(ok).attempt, 1);
	assert.match(record(ok).received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	assert.equal(existsSync(rejection(ok)), false);
	assert.equal(f.provider.requests("ok").length, 1, "report_result terminates: no extra model turn");
	assert.ok(offeredTools(f.provider.requests("ok")[0]).includes("report_result"), "an implementer reports with report_result");
	assert.equal(offeredTools(f.provider.requests("ok")[0]).includes("report_verdict"), false, "and never sees report_verdict");
	assert.deepEqual([ok, stale].flatMap((id) => f.post.questions.store.list(id)), [], "no report ever opens a console question");

	assert.deepEqual([record(stale).envelope, record(stale).attempt], [shipped(stale), 2], "the corrected head is attempt 2");
	assert.match(sent(f, "head", 1), /is not HEAD of your worktree/);
	assert.ok(sent(f, "head", 1).includes(head(f, stale)), "the repair prompt names the observed sha");
	assert.deepEqual([record(broken).envelope, record(broken).attempt, f.provider.requests("repair").length], [shipped(broken), 2, 2]);
	assert.match(sent(f, "repair", 1), /report_result rejected \(attempt 1\)/);
	assert.equal(existsSync(rejection(broken)), false);

	assert.deepEqual([record(twice).envelope, record(twice).attempt], [shipped(twice), 1], "neither re-report touches the record");
	const ends = toolEnds(join(f.home, paths.eventsFile(twice))).filter((end) => end.tool === "report_result").map((end) => end.text);
	assert.equal(ends.length, 3);
	assert.ok(ends.some((text) => /Already recorded \(no-op\)/.test(text)), "an identical re-report is a no-op");
	assert.ok(ends.some((text) => /your report was already filed/.test(text)), "a contradicting report is refused");

	assert.equal(failure.class, "envelope_invalid");
	assert.ok(failure.message.includes(rejection(capped)), "the failure names the worker's rejection record");
	assert.equal(existsSync(join(f.home, paths.envelopeFile(capped))), false, "no envelope may be recorded");
	const refused = json<{ attempts: number; errors: string[] }>(rejection(capped));
	assert.equal(refused.attempts, CAP);
	assert.ok(refused.errors.some((error) => error.startsWith("branch:")) && refused.errors.some((error) => error.startsWith("pr_url:")));
	assert.equal(f.provider.requests("cap").length, CAP, "repair stops at the cap");
});

test("P8f reporter plans: a blocked planner report is first-class, a body-shaped blocker and an oversize plan_summary are repaired, and neither a plan nor an answer opens a console hold", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await packageBench(t);
	const plan = (id: string, extra: Record<string, unknown> = {}) => () => ({ job_id: id, kind: "research", status: "done", summary: "Plan written; cache in redis.",
		artifact_path: f.post.artifacts.file(id), plan_summary: MINIMAL_PLAN_SUMMARY, self_assessment: ASSESSMENT, ...extra });
	const blockedEnvelope = (id: string) => ({ job_id: id, kind: "research", status: "blocked", summary: "Need a store decision.", blockers: [BLOCKER] });
	const blocked = await dispatch(f, "blocked", "research", "pipeline", (id) => [call("report_result", blockedEnvelope(id)), HANG]);
	const body = await dispatch(f, "blocker", "research", "pipeline", (id) => [
		call("report_result", { ...blockedEnvelope(id), blockers: [{ ...BLOCKER, why: "# Findings\n```\nthe body\n```" }] }), call("report_result", blockedEnvelope(id)), HANG]);
	const planned = await dispatch(f, "plan", "research", "pipeline", (id) => [ARTIFACT, call("report_result", plan(id)), HANG]);
	const fat = await dispatch(f, "fat", "research", "pipeline", (id) => [ARTIFACT,
		call("report_result", plan(id, { plan_summary: { ...MINIMAL_PLAN_SUMMARY, goal: "word ".repeat(40).trim() } })), call("report_result", plan(id)), HANG]);
	const answer = await dispatch(f, "answer", "research", "answer", (id) => [ARTIFACT, call("report_result", () => ({ job_id: id, kind: "research", status: "done",
		summary: "it is in src/config.ts", artifact_path: f.post.artifacts.file(id) })), HANG]);
	for (const id of [blocked, body, planned, fat, answer]) await reported(f, id);
	const record = (id: string) => json<EnvelopeRecord>(join(f.home, paths.envelopeFile(id)));

	assert.deepEqual([record(blocked).envelope.status, record(blocked).envelope.blockers], ["blocked", [BLOCKER]], "blocked is filed as a report, not a failure");
	const repair = sent(f, "blocker", 1);
	for (const text of [/report_result rejected \(attempt 1\)/, /body belongs in the artifact/, /Fix exactly these points and call report_result again/]) assert.match(repair, text);
	assert.deepEqual([record(body).envelope.status, record(body).attempt], ["blocked", 2]);
	assert.deepEqual([record(planned).attempt, existsSync(join(f.home, paths.runDir(planned), "envelope-rejected.json"))], [1, false]);
	assert.deepEqual([record(fat).envelope.plan_summary?.goal, record(fat).attempt, f.provider.requests("fat").length], [MINIMAL_PLAN_SUMMARY.goal, 2, 3]);
	assert.equal(record(answer).envelope.summary, "it is in src/config.ts");
	assert.deepEqual([planned, fat, answer].flatMap((id) => f.post.questions.store.list(id)), [], "report_result never opens a console review");
});

test("P8f reporter guards: a CI wait, a credential probe and a state-bearing web call are refused while plain calls run; token output is redacted; silent bash and anchor-edit failures are enriched", { skip: SKIP, timeout: 300_000 }, async (t) => {
	// Built at runtime by the worker's own shell: no token shape lives in a tool call or in this source.
	const pat = ["github", "pat", "Q".repeat(22), "r".repeat(59)].join("_");
	const classic = `${"gh"}${"p_"}${"Z".repeat(36)}`;
	const f = await packageBench(t, {
		setup(agentDir) {
			const throwing = (name: string) => `pi.registerTool({ name: "${name}", label: "${name}", description: "fake ${name}", parameters: { type: "object", properties: {} },
	async execute() { throw new Error(${JSON.stringify(STALE)}); } });`;
			installPackage(agentDir, "pi-hashline-edit-pro", { extensions: ["./index.js"] }, { "index.js": `export default function (pi) {\n${throwing("replace")}\n${throwing("insert")}\n}\n` });
			installPackage(agentDir, "pi-web-access", { extensions: ["./index.ts"] }, { "index.ts": fakeExtension("web", join(agentDir, "loads.log"), { tools: PACKAGE_TOOLS["pi-web-access"] }) });
		},
	});
	const bash = (command: string) => call("bash", { command });
	const replace = call("replace", { remove_from: "MMvt", remove_to: "MMvt", replacement_lines: "x" });
	const steps = [
		bash("sleep 300; gh run list --branch cp-ciwait --limit 3 --json conclusion,status,headSha"),
		bash("echo LEGIT-RAN"),
		bash("gh auth status 2>&1"),
		bash(`echo "Token: github_pat_$(printf 'Q%.0s' $(seq 22))_$(printf 'r%.0s' $(seq 59))"; echo "classic=gh""p_$(printf 'Z%.0s' $(seq 36))"`),
		bash("false"),
		replace, replace, replace,
		HANG,
	];
	const guard = await dispatch(f, "guard", "ship", "pr", () => steps);
	const web = await dispatch(f, "web", "research", "pipeline", () => [call("web_search", { query: "/srv/cp/.pi-command-post/state/x" }),
		call("web_search", { query: "node --test-force-exit" }), HANG]);
	const ends = (id: string, count: number) => waitFor(() => toolEnds(join(f.home, paths.eventsFile(id))), (rows) => rows.length >= count,
		{ timeoutMs: 90_000, what: `${id}'s ${count} tool results` });
	const [ci, legit, auth, token, silent, ...edits] = (await ends(guard, steps.length - 1)).map((end) => end.text);

	assert.match(ci ?? "", /Refused/);
	assert.match(ci ?? "", /head_sha/);
	assert.doesNotMatch(ci ?? "", /"conclusion"/, "the poll never reaches GitHub");
	assert.match(legit ?? "", /LEGIT-RAN/, "an ordinary bash call still runs");
	assert.match(auth ?? "", /gh api user --jq \.login/, "a credential probe is refused with the sanctioned read");
	const clean = (text: string, what: string) => {
		assert.ok(text.includes("[REDACTED]"), `${what} carries [REDACTED]`);
		assert.ok(!text.includes(pat) && !text.includes(classic), `${what} carries no token`);
	};
	clean(token ?? "", "tool_execution_end");
	clean(readFileSync(f.post.fleet.require(guard).worker.session_file, "utf8"), "the session JSONL");
	clean(sent(f, "guard", 4), "the next model request");
	assert.match(silent ?? "", /Command: false/, "a silent non-zero exit names its command");
	assert.match(edits[0] ?? "", /cause: stale_anchor/);
	assert.doesNotMatch(edits[1] ?? "", /Identical/);
	assert.match(edits[2] ?? "", /Identical stale_anchor failure #3 on README\.md\. Stop retrying: read README\.md again/);

	const [state, plain] = (await ends(web, 2)).map((end) => end.text);
	assert.doesNotMatch(state ?? "", /web_search:ran/, "a web call carrying command-post state never runs");
	assert.match(state ?? "", /command-post state never leaves the host|\.pi-command-post/);
	assert.match(plain ?? "", /web_search:ran/, "a clean web call runs");
});

test("P8f reporter verdicts: a gate reviewer files one schema-valid verdict, over-long items are clamped with the original kept, a malformed verdict is repaired in-run, and an exhausted repair is an operational gate", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const f = await packageBench(t);
	f.post.reviewRuns.wakeupPort = () => true;
	const verdict = (id: string, extra: Record<string, unknown> = {}) => ({ job_id: id, verdict: "pass", flags: FLAGS,
		reasons: ["File list names every path in Evidence", "Test plan runs as written"], ...extra });
	const planned = async (slug: string) => {
		const id = await dispatch(f, slug, "research", "pipeline", (jobId) => [ARTIFACT, call("report_result", () => ({ job_id: jobId, kind: "research", status: "done",
			summary: "Plan written.", artifact_path: f.post.artifacts.file(jobId), plan_summary: MINIMAL_PLAN_SUMMARY, self_assessment: ASSESSMENT })), HANG]);
		await reported(f, id);
		return id;
	};
	const gate = async (id: string, script: string, steps: ScriptStep[]) => {
		await f.post.gate({ jobId: id, model: f.script(script, steps) });
		const key = ReviewRuns.key(id, "gate", 1);
		f.post.reviewRuns.handBack(key);
		await f.post.reviewRuns.settled(key);
		return json<GateVerdict>(join(f.home, paths.gateFile(id, 1)));
	};
	const runDir = (id: string) => join(f.home, paths.gateRunDir(id, 1));
	const record = (id: string) => json<VerdictRecord>(join(f.home, paths.gateVerdictFile(id, 1)));
	const [pass, clamp, repair, cap] = await Promise.all(["pass", "clamp", "repair", "cap"].map(planned)) as [string, string, string, string];
	const reason = `${"r".repeat(449)}Z`;
	const revision = `${"v".repeat(400)}Z`;
	const bad = { verdict: "pass", reasons: ["looks fine"], revisions: ["you cannot revise on a pass"] };
	const decisions = await Promise.all([
		gate(pass, "v-pass", [call("report_verdict", verdict(pass))]),
		gate(clamp, "v-clamp", [call("report_verdict", verdict(clamp, { verdict: "revise", reasons: [reason, "Test plan runs as written"], revisions: [revision] }))]),
		gate(repair, "v-repair", [call("report_verdict", { job_id: "cp-other", verdict: "revise", flags: FLAGS, reasons: ["file list is thin"] }),
			call("report_verdict", verdict(repair, { verdict: "revise", reasons: ["File list omits db/migrations"], revisions: ["List the files under db/migrations"] }))]),
		gate(cap, "v-cap", Array.from({ length: CAP }, () => call("report_verdict", verdict(cap, bad)))),
	]);

	assert.deepEqual(record(pass).review, verdict(pass));
	assert.equal(record(pass).attempt, 1);
	const valid = validate<VerdictRecord>(VerdictRecordSchema, record(pass));
	assert.ok(valid.ok, valid.ok ? "" : valid.errors.join("; "));
	assert.equal(existsSync(join(runDir(pass), VERDICT_RAW_FILE)), false, "nothing was clamped, so there is no raw copy");
	assert.equal(f.provider.requests("v-pass").length, 1, "report_verdict terminates the review");
	assert.equal(decisions[0]?.verdict, "pass");
	const tools = (f.provider.requests("v-pass")[0]?.body.tools ?? []) as Array<{ function?: { name?: string; description?: string } }>;
	assert.deepEqual(["report_verdict", "report_result"].map((name) => tools.some((tool) => tool.function?.name === name)), [true, false], "a reviewer reports only a verdict");
	const description = tools.find((tool) => tool.function?.name === "report_verdict")?.function?.description ?? "";
	assert.match(description, /400 characters/, "the reason cap is in the prose the model reads");
	assert.match(description, /revisions.* only when the verdict is revise/);

	assert.deepEqual([record(clamp).attempt, f.provider.requests("v-clamp").length, existsSync(join(runDir(clamp), "verdict-rejected.json"))], [1, 1, false],
		"an over-long item is clamped, not rejected");
	assert.equal(record(clamp).review.reasons[0]?.length, GATE_REVIEW_ITEM_MAX);
	assert.ok(record(clamp).review.reasons[0]?.endsWith("…"));
	assert.equal(record(clamp).review.revisions?.[0]?.length, GATE_REVIEW_ITEM_MAX);
	const raw = json<{ reasons: string[]; revisions: string[] }>(join(runDir(clamp), VERDICT_RAW_FILE));
	assert.deepEqual([raw.reasons[0], raw.revisions[0]], [reason, revision], "the reviewer's own words survive in full");
	const told = toolEnds(join(runDir(clamp), "events.jsonl")).find((end) => end.tool === "report_verdict")?.text ?? "";
	assert.match(told, /clamp|cut to/i);
	assert.ok(told.includes(VERDICT_RAW_FILE), "the reviewer is told where the raw copy is");
	assert.equal(REVIEWER_RAW_FILE, VERDICT_RAW_FILE, "a revise promote points at the same raw copy");
	assert.equal(decisions[1]?.verdict, "revise");

	assert.deepEqual([record(repair).review.job_id, record(repair).review.revisions, record(repair).attempt], [repair, ["List the files under db/migrations"], 2]);
	assert.equal(f.provider.requests("v-repair").length, 2, "repaired in the same run");
	assert.equal(existsSync(join(runDir(repair), "verdict-rejected.json")), false);

	assert.equal(existsSync(join(f.home, paths.gateVerdictFile(cap, 1))), false, "no verdict may be recorded");
	const refused = json<{ attempts: number; errors: string[] }>(join(runDir(cap), "verdict-rejected.json"));
	assert.equal(refused.attempts, CAP);
	assert.ok(refused.errors.some((error) => error.startsWith("revisions:")));
	assert.equal(f.provider.requests("v-cap").length, CAP);
	assert.deepEqual([decisions[3]?.verdict, decisions[3]?.cause], ["escalate", "operational"], "exhaustion reaches the parent as an operational gate");
});
