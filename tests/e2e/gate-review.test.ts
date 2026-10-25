/**
 * P11c behavior 10: the plan gate through a real CommandPost — `post.gateModule()` (cp_gate's module), `post.gate`,
 * `post.replacePlanner` and the orphan sweep — with real mock-model `gate-reviewer` workers routed by the home's
 * routing.json. Every verdict/cause branch is a scripted reviewer answer; the policy is the product's.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import {
	DEFAULT_ORIGIN, type DiffVerdict, EMPTY_USAGE, GATE_REASONS_MAX_ITEMS, type GateReview, type GateVerdict, GateVerdictSchema,
	isoTimestamp, type JobRouting, LAYOUT, paths, SCHEMA_VERSION, validate,
} from "../../src/contracts.ts";
import { isDiffReviewWait } from "../../src/diff-review.ts";
import { isGateWait, ORIGINAL_TASK_COPY } from "../../src/gate.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { loadProfile } from "../../src/profiles.ts";
import type { ReviewWakeup } from "../../src/review-runs.ts";
import {
	createAgentDir, createScratchHome, createScratchRepo, MockProvider, REPO_ROOT, type ScriptOptions, type ScriptStep,
} from "../harness/index.ts";

const NO_FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const verdict = (jobId: string, overrides: Partial<GateReview> = {}): ScriptStep => ({
	kind: "tool_calls",
	calls: [{ name: "report_verdict", args: { verdict: "pass", flags: { ...NO_FLAGS }, reasons: ["file list is concrete"], ...overrides, job_id: jobId } }],
	usage: { prompt_tokens: 900, completion_tokens: 40 },
});
/** A step whose verdict is computed inside the provider handler, while the reviewer process and its cwd are live. */
const live = (args: () => Record<string, unknown>): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "report_verdict", args }] });
const words = (label: string, size: number) => `${label} ${"w ".repeat(size - 1).trim()}`;

async function bench(t: { after(fn: () => void | Promise<void>): void }, env: NodeJS.ProcessEnv = {}) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	initJobsDocument(home.path, "cp");
	const lowOnly = new Set<string>();
	const down = new Set<string>();
	const modelRegistry = {
		find: (p: string, id: string) => ({ provider: p, id, reasoning: true,
			...(lowOnly.has(`${p}/${id}`) ? { thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: null } } : {}) }),
		hasConfiguredAuth: (m: { provider?: string; id?: string }) => m.provider !== "unauth" && !down.has(`${m.provider}/${m.id}`),
	};
	const options = { home: home.path, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...agent.env, ...env },
		modelRegistry: () => modelRegistry };
	const posts = [new CommandPost(options)];
	const post = posts[0]!;
	const sent: ReviewWakeup[] = [];
	post.reviewRuns.wakeupPort = (wakeup) => (sent.push(wakeup), true);
	await post.registry.register({ name: "demo", clone_url: "https://github.com/o/demo.git" });
	t.after(async () => { for (const each of posts) await each.shutdown(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const routing = (rubric: unknown[] = [], extra: Record<string, unknown> = {}) => writeFileSync(join(home.path, LAYOUT.routingFile),
		JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", "mock2/*", "unauth/*"], rubric, ...extra }));
	routing();
	const script = (name: string, steps: ScriptStep[], scriptOptions?: ScriptOptions) => {
		const model = provider.addScript(name, steps, scriptOptions);
		const config = provider.modelsJson() as { providers: Record<string, { models: Record<string, unknown>[] }> };
		for (const entry of Object.values(config.providers)) for (const row of entry.models) row.reasoning = true;
		config.providers.mock2 = config.providers.mock!;
		writeFileSync(join(agent.path, "models.json"), JSON.stringify(config));
		return model;
	};
	const subject = async (jobId: string, body?: string, routed?: JobRouting) => {
		writeFileSync(post.artifacts.path(jobId), body ?? "# Goal\nship it\n\n# File list\nsrc/app.ts\n");
		await post.fleet.add({ job_id: jobId, project: "demo", kind: "research", delivery: "pipeline", origin: DEFAULT_ORIGIN, phase: "held",
			reported_at: isoTimestamp(), worktree: home.path, branch: jobId, dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: "planner", role: "planner",
				model: "mock/planner", started_at: isoTimestamp() },
			...(routed ? { routing: routed } : {}) });
	};
	const runEvents = (jobId: string, attempt = 1) => readFileSync(join(home.path, paths.gateRunDir(jobId, attempt), "events.jsonl"), "utf8")
		.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
	return {
		home: home.path, post, provider, sent, routing, script, subject, lowOnly, down, posts, options,
		gate: (jobId: string, extra: { model?: string; deliverRevise?: boolean } = {}) => post.gateModule().gateAndWait({ jobId, ...extra }),
		decision: (jobId: string, attempt = 1) => JSON.parse(readFileSync(join(home.path, paths.gateFile(jobId, attempt)), "utf8")) as GateVerdict,
		routed: (jobId: string, attempt = 1) => runEvents(jobId, attempt).find((event) => event.type === "routing_resolved")?.payload,
		selected: (jobId: string) => runEvents(jobId).find((event) => event.type === "reviewer_model_selected")?.payload,
		/** The effort the reviewer's pi process ran at, from its own state in the run log. */
		effort: (jobId: string, attempt = 1) => /"thinkingLevel":"([a-z]+)"/
			.exec(JSON.stringify(runEvents(jobId, attempt).filter((event) => event.type !== "routing_resolved")))?.[1],
		jobLog: (jobId: string) => readFileSync(join(home.path, paths.eventsFile(jobId)), "utf8"),
		originalTask(jobId: string, body: string) {
			mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
			writeFileSync(join(home.path, paths.originalTaskFile(jobId)), body);
		},
		async livePlanner(jobId: string, model: string) {
			await subject(jobId);
			const managed = post.manager.spawn({
				identity: { jobId, kind: "research", delivery: "pipeline", runDir: join(home.path, paths.runDir(jobId)), worktree: home.path },
				profile: loadProfile(join(REPO_ROOT, "profiles"), "planner"), model, brief: "stand by",
			});
			await managed.worker.getState(20_000);
		},
	};
}

test("P11c-gate-policy: every verdict and cause branch, the caps and the persisted shape come from scripted reviewers", { timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	const run = async (jobId: string, steps: ScriptStep[], attempts = steps.length) => {
		await b.subject(jobId);
		const model = b.script(jobId, steps);
		b.routing([{ id: "reviews", role: "gate-reviewer", model }]);
		const results = [];
		for (let index = 0; index < attempts; index += 1) results.push(await b.gate(jobId, { deliverRevise: false }));
		return results;
	};
	const shape = (result: { verdict: GateVerdict; next: string }) => [result.verdict.verdict, result.verdict.cause, result.next];
	const said = (result: { verdict: GateVerdict }, text: string) => result.verdict.reasons.some((reason) => reason.includes(text));

	const [pass] = await run("cp-p-pass", [verdict("cp-p-pass")]);
	assert.deepEqual(shape(pass!), ["pass", null, "proceed"]);
	const [revise] = await run("cp-p-revise", [verdict("cp-p-revise", { verdict: "revise", revisions: ["name the exact files"] })]);
	assert.deepEqual([...shape(revise!), revise!.verdict.revisions], ["revise", null, "revise", ["name the exact files"]]);
	const [escalate] = await run("cp-p-escalate", [verdict("cp-p-escalate", { verdict: "escalate", reasons: ["no test plan"] })]);
	assert.deepEqual(shape(escalate!), ["escalate", "policy", "surface"], "a reviewer's own escalate is a judgment: policy");

	// cp-950e: every decision names its rubric in its own field; a reviewer at the item cap loses no reason to it.
	const maxed = Array.from({ length: GATE_REASONS_MAX_ITEMS }, (_unused, index) => `reviewer reason ${index}`);
	const [atCap] = await run("cp-p-maxed", [verdict("cp-p-maxed", { reasons: maxed })]);
	for (const each of [pass!, revise!, escalate!, atCap!]) {
		assert.match(each.verdict.rubric ?? "", /implementation-plan rubric/);
		assert.ok(!said(each, "implementation-plan rubric"), "the rubric statement is never a reason");
		assert.ok(validate(GateVerdictSchema, b.decision(each.verdict.job_id)).ok);
	}
	assert.deepEqual(atCap!.verdict.reasons, maxed);
	assert.match(b.sent.find((wake) => wake.jobId === "cp-p-maxed")?.content ?? "", /rubric: .*implementation-plan rubric/);

	// A veto flag on a reviewer pass is FLAGGED and may reach a checkpoint; on a revise or an own escalate it is policy.
	for (const flag of ["destructive_scope", "scope_growth"] as const) {
		const [flagged] = await run(`cp-p-flag-${flag.split("_")[0]}`, [verdict(`cp-p-flag-${flag.split("_")[0]}`, { flags: { ...NO_FLAGS, [flag]: true } })]);
		assert.deepEqual(shape(flagged!), ["escalate", "flagged", "authorize"], flag);
		assert.ok(said(flagged!, `flag forced escalate: ${flag}`) && flagged!.verdict.flags[flag]);
		const id = `cp-p-vrev-${flag.split("_")[0]}`;
		const [onRevise] = await run(id, [verdict(id, { verdict: "revise", flags: { ...NO_FLAGS, [flag]: true }, revisions: ["name the exact files"] })]);
		assert.deepEqual(shape(onRevise!), ["escalate", "policy", "surface"], flag);
	}
	const [ownEscalate] = await run("cp-p-vesc", [verdict("cp-p-vesc", { verdict: "escalate", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: ["drops the wrong table"] })]);
	assert.deepEqual(shape(ownEscalate!), ["escalate", "policy", "surface"], "a disputed plan, not a flagged-but-sound one");

	// cp-unknowns-no-veto: blocking_unknowns is reported and persisted, never forced.
	const unknowns = { ...NO_FLAGS, blocking_unknowns: true };
	const [onPass] = await run("cp-p-unk", [verdict("cp-p-unk", { flags: unknowns, reasons: ["defers the hub to cp-b1"] })]);
	assert.deepEqual(shape(onPass!), ["pass", null, "proceed"]);
	assert.deepEqual(b.decision("cp-p-unk").flags, unknowns);
	assert.ok(said(onPass!, "defers the hub to cp-b1") && said(onPass!, "flag reported, no veto: blocking_unknowns") && !said(onPass!, "flag forced"));
	const [unkRevise] = await run("cp-p-unkrev", [verdict("cp-p-unkrev", { verdict: "revise", flags: unknowns, revisions: ["name the exact files"] })]);
	assert.deepEqual([...shape(unkRevise!), unkRevise!.verdict.revisions], ["revise", null, "revise", ["name the exact files"]]);
	const [alongside] = await run("cp-p-unkveto", [verdict("cp-p-unkveto", { flags: { ...unknowns, destructive_scope: true } })]);
	assert.deepEqual(shape(alongside!).slice(0, 2), ["escalate", "flagged"]);
	assert.ok(said(alongside!, "flag forced escalate: destructive_scope") && !said(alongside!, "destructive_scope, blocking_unknowns"));
	assert.ok(said(alongside!, "flag reported, no veto: blocking_unknowns"));

	// One revise max, and a veto-rewritten revise spends it (N4, cp-itl4); a flagged pass does not.
	const again = (id: string) => verdict(id, { verdict: "revise", revisions: ["again"] });
	const [, capped] = await run("cp-p-twice", [verdict("cp-p-twice", { verdict: "revise", revisions: ["first"] }), again("cp-p-twice")]);
	assert.deepEqual([...shape(capped!), capped!.verdict.revisions, said(capped!, "attempt cap")], ["escalate", "policy", "surface", undefined, true]);
	const vetoed = { ...NO_FLAGS, destructive_scope: true };
	const [vFirst, vSecond] = await run("cp-p-vtwice", [verdict("cp-p-vtwice", { verdict: "revise", flags: vetoed, revisions: ["drop it"] }),
		verdict("cp-p-vtwice", { verdict: "revise", flags: vetoed, revisions: ["again"] })]);
	assert.deepEqual([said(vFirst!, "attempt cap"), said(vSecond!, "attempt cap")], [false, true]);
	const [, afterFlag] = await run("cp-p-fthen", [verdict("cp-p-fthen", { flags: vetoed }), again("cp-p-fthen")]);
	assert.deepEqual(shape(afterFlag!), ["revise", null, "revise"], "a flagged row never spends the revise");

	// No usable verdict is operational and retried on the same model, then persistent and surfaced.
	const silent = ["I think it is fine.", "Still fine.", "Fine again."].map((text): ScriptStep => ({ kind: "text", text }));
	const [op, persistent, third] = await run("cp-p-silent", silent);
	assert.deepEqual([...shape(op!), op!.verdict.flags], ["escalate", "operational", "retry", NO_FLAGS], "flags are never invented");
	assert.match(op!.verdict.reasons.join(" "), /settled without reporting a verdict/);
	assert.deepEqual([...shape(persistent!), persistent!.model, persistent!.verdict.attempt], ["escalate", "operational_persistent", "surface", op!.model, 2]);
	assert.deepEqual(shape(third!), ["escalate", "operational_persistent", "surface"], "a persistent fault stays persistent");

	// The relayable payload is capped by words and items; the first revision is reserved; the raw copy keeps everything.
	const long = Array.from({ length: 10 }, (_unused, index) => words(`r${index}`, 60));
	const [wordy] = await run("cp-p-words", [verdict("cp-p-words", { reasons: long })]);
	assert.ok(wordy!.verdict.reasons.length < long.length && wordy!.verdict.reasons.at(-1)!.includes("dropped"));
	assert.ok(wordy!.verdict.reasons.join(" ").split(/\s+/).length <= 320);
	const reasons = Array.from({ length: 4 }, (_unused, index) => words(`reason${index}`, 90));
	const revisions = [words("fix-first", 40), words("fix-second", 40)];
	const [reserved] = await run("cp-p-reserve", [verdict("cp-p-reserve", { verdict: "revise", reasons, revisions })]);
	assert.equal(b.decision("cp-p-reserve").revisions?.[0], revisions[0], "the first required change survives the cap");
	assert.ok(validate(GateVerdictSchema, b.decision("cp-p-reserve")).ok && reserved!.verdict.verdict === "revise");
	assert.deepEqual(JSON.parse(readFileSync(join(b.home, paths.gateFileRaw("cp-p-reserve", 1)), "utf8")).reasons, reasons);
	// cp-yg2: a reviewer at the item cap plus the parent's own flag line is one over; the decision stays gateable.
	const [overflow] = await run("cp-p-overflow", [verdict("cp-p-overflow", { flags: vetoed, reasons: maxed })]);
	assert.deepEqual(shape(overflow!).slice(0, 2), ["escalate", "flagged"]);
	assert.ok(b.decision("cp-p-overflow").reasons.length <= GATE_REASONS_MAX_ITEMS && said(overflow!, "dropped"));
	const raw = JSON.parse(readFileSync(join(b.home, paths.gateFileRaw("cp-p-overflow", 1)), "utf8")) as GateVerdict;
	assert.ok(raw.reasons.length > GATE_REASONS_MAX_ITEMS && raw.reasons.some((reason) => reason.includes("flag forced escalate")));
	for (const reason of maxed) assert.ok(raw.reasons.includes(reason), reason);
});

test("P11c-gate-run: isolation, the async wake-up, status, orphans, promotes, restarts and refusals", { timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	const pin = (model: string) => b.routing([{ id: "reviews", role: "gate-reviewer", model }]);

	// The reviewer's cwd holds one copy of the artifact while it runs; a pass removes it and leaves the store and record.
	await b.subject("cp-gate-pass");
	const scratch = join(b.home, paths.gateScratchDir("cp-gate-pass", 1));
	const seen: { entries: string[]; body: string }[] = [];
	pin(b.script("gate-pass", [live(() => {
		seen.push({ entries: readdirSync(scratch), body: readFileSync(join(scratch, "artifact.md"), "utf8") });
		return { job_id: "cp-gate-pass", verdict: "pass", flags: NO_FLAGS, reasons: ["file list is concrete", "test plan runs"] };
	})]));
	const passed = await b.gate("cp-gate-pass");
	assert.deepEqual([passed.verdict.verdict, passed.verdict.cause, passed.next, passed.verdict.attempt], ["pass", null, "proceed", 1]);
	assert.deepEqual(seen, [{ entries: ["artifact.md"], body: readFileSync(b.post.artifacts.file("cp-gate-pass"), "utf8") }]);
	assert.ok(!existsSync(scratch) && existsSync(b.post.artifacts.file("cp-gate-pass")) && existsSync(join(b.home, paths.gateVerdictFile("cp-gate-pass", 1))));
	const passBrief = readFileSync(join(b.home, paths.gateRunDir("cp-gate-pass", 1), "brief.md"), "utf8");
	assert.ok(passBrief.includes(join(scratch, "artifact.md")) && !passBrief.includes(b.post.artifacts.file("cp-gate-pass")));
	assert.ok(/gate_decided/.test(b.jobLog("cp-gate-pass")) && /gate_scratch_removed/.test(b.jobLog("cp-gate-pass")), "the removal is logged");
	assert.ok(!b.jobLog("cp-gate-pass").includes("File list"), "the job log never carries the artifact");
	assert.equal(b.post.manager.get("cp-gate-pass#gate-1"), undefined, "one-shot: nothing is left running");
	assert.match(b.sent.at(-1)?.content ?? "", /gate attempt 1: pass/);

	// A scratch removal that fails is logged and changes nothing about the verdict.
	await b.subject("cp-gate-rmfail");
	const stuck = join(b.home, paths.gateScratchDir("cp-gate-rmfail", 1));
	pin(b.script("gate-rmfail", [live(() => (chmodSync(stuck, 0o555), { job_id: "cp-gate-rmfail", verdict: "pass", flags: NO_FLAGS, reasons: ["ok"] }))]));
	const kept = await b.gate("cp-gate-rmfail");
	chmodSync(stuck, 0o755);
	assert.deepEqual([kept.verdict.verdict, kept.next, b.decision("cp-gate-rmfail").verdict], ["pass", "proceed", "pass"]);
	assert.ok(existsSync(join(stuck, "artifact.md")), "a failed removal leaves the copy");
	assert.match(b.jobLog("cp-gate-rmfail"), /gate_scratch_removed.*"removed":false.*"reason":"failed".*EACCES/);

	// cp_gate returns wait at once with a pending attempt; a second start is refused; the verdict arrives as one wake-up.
	await b.subject("cp-gate-async");
	const asyncModel = b.script("gate-async", [verdict("cp-gate-async")]);
	assert.deepEqual(b.post.gateModule().status("cp-gate-async"), { decisions: [] });
	const started = await b.post.gate({ jobId: "cp-gate-async", model: asyncModel, directive: "call cp_pipeline advance cp-gate-async" });
	assert.ok(isGateWait(started) && started.attempt === 1 && started.model === asyncModel, JSON.stringify(started));
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile("cp-gate-async", "gate", 1))) && !existsSync(join(b.home, paths.gateFile("cp-gate-async", 1))));
	assert.equal(b.post.gateModule().status("cp-gate-async").pending?.attempt, 1);
	await b.post.registry.setReviewerModel("demo", "unavailable/reviewer");
	await assert.rejects(b.post.gate({ jobId: "cp-gate-async" }), /already has a gate review in flight/);
	await assert.rejects(b.post.gate({ jobId: "cp-gate-async", model: asyncModel }), /already has a gate review in flight/);
	await b.post.registry.setReviewerModel("demo", null);
	const wakes = b.sent.length;
	b.post.reviewRuns.handBack(started.key);
	await b.post.reviewRuns.settled(started.key);
	assert.deepEqual(b.sent.slice(wakes).map((wake) => [wake.surface, wake.attempt]), [["gate", 1]]);
	assert.match(b.sent.at(-1)!.content, /gate attempt 1: pass[^]*Next: call cp_pipeline advance cp-gate-async/);
	assert.ok(!b.sent.at(-1)!.content.includes("ship it"), "the wake-up never carries the artifact");
	const status = b.post.gateModule().status("cp-gate-async");
	assert.deepEqual([status.pending, status.decisions.length], [undefined, 1]);
	const finished = await b.post.gate({ jobId: "cp-gate-async", model: asyncModel });
	assert.ok(!isGateWait(finished) && finished.verdict.attempt === 1 && finished.next === "proceed");
	assert.match(b.jobLog("cp-gate-async"), /review_started[^]*verdict_wakeup_sent/);

	// An attempt lost with the previous parent is decided operational by the session-start sweep; the ladder says retry.
	await b.subject("cp-gate-orphan");
	mkdirSync(join(b.home, paths.pendingReviewFile("cp-gate-orphan", "gate", 1), ".."), { recursive: true });
	writeFileSync(join(b.home, paths.pendingReviewFile("cp-gate-orphan", "gate", 1)), JSON.stringify({ schema_version: SCHEMA_VERSION,
		job_id: "cp-gate-orphan", surface: "gate", attempt: 1, model: "mock/gone", pid: 999_999_999, started_at: isoTimestamp(), deadline: isoTimestamp(), handed_back: true }));
	const swept = await b.post.sweepOrphanReviews();
	assert.ok(swept.finished.some((pending) => pending.job_id === "cp-gate-orphan"), JSON.stringify(swept));
	assert.match(b.sent.at(-1)?.content ?? "", /escalate \(cause: operational\)[^]*-> retry/);
	assert.ok(b.decision("cp-gate-orphan").reasons.some((reason) => reason.includes("reviewer lost with the parent session")));

	// A revise is promoted to the live planner once, as a receipt; the second revise is capped; both keep their evidence.
	const planner = b.script("planner", [{ kind: "text", text: "standing by" }], { onExhausted: "repeat" });
	await b.livePlanner("cp-gate-revise", planner);
	pin(b.script("gate-revise", [verdict("cp-gate-revise", { verdict: "revise", reasons: ["test plan is not runnable"], revisions: ["name the exact commands"] }),
		verdict("cp-gate-revise", { verdict: "revise", reasons: ["still not runnable"], revisions: ["again"] })]));
	const first = await b.gate("cp-gate-revise");
	assert.deepEqual([first.next, first.revise_receipt, first.revise_error], ["revise", "delivered", undefined]);
	await waitForRequests(b.provider, "planner", 1);
	const promote = JSON.stringify(b.provider.requests("planner").at(-1)?.body.messages?.at(-1));
	for (const line of ["name the exact commands", "only revision available", "A reply is enough", "Update the artifact in place"]) assert.ok(promote.includes(line), line);
	assert.match(promote, /envelope slot was(\\n| )reopened/);
	assert.ok(!promote.includes("Do not call report_result again"));
	assert.match(b.jobLog("cp-gate-revise"), /"type":"prompt_sent","payload":\{"receipt":"delivered"/);
	assert.ok(!b.jobLog("cp-gate-revise").includes("name the exact commands"), "the log records the receipt, never the text");
	// The revise cap survives a parent restart: a fresh CommandPost reads the prior attempts from disk.
	const restarted = new CommandPost(b.options);
	b.posts.push(restarted);
	const second = await restarted.gateModule().gateAndWait({ jobId: "cp-gate-revise" });
	assert.deepEqual([second.verdict.attempt, second.verdict.verdict, second.verdict.cause, second.next, second.revise_receipt], [2, "escalate", "policy", "surface", undefined]);
	for (const attempt of [1, 2]) assert.ok(statSync(join(b.home, paths.gateScratchDir("cp-gate-revise", attempt), "artifact.md")).size > 0);
	writeFileSync(join(b.home, paths.gateFile("cp-gate-revise", 3)), JSON.stringify({ ...second.verdict, attempt: 3, verdict: "x" }));
	await assert.rejects(restarted.gateModule().start({ jobId: "cp-gate-revise" }), /gate-3\.json violates the gate verdict contract/);

	// picp-ox6: a late revise for a torn-down planner seeds one replacement through cp_gate replace_planner.
	const ledger = b.post.ledger();
	const old = await ledger.create({ title: "old planner", project: "demo", kind: "research", delivery: "pipeline" });
	const replacement = await ledger.create({ title: "replacement planner", project: "demo", kind: "research", delivery: "pipeline" });
	await b.subject(old.id, "# Original plan\nkeep the scope\n");
	mkdirSync(join(b.home, paths.runDir(old.id)), { recursive: true });
	writeFileSync(join(b.home, paths.originalTaskFile(old.id)), "original scope");
	await b.post.fleet.patch(old.id, { phase: "done" });
	await ledger.close(old.id, "research completed");
	pin(b.script("late-revise", [verdict(old.id, { verdict: "revise", reasons: ["test plan missing"], revisions: ["name the exact commands"] }),
		verdict(replacement.id, { verdict: "revise", revisions: ["again"] })]));
	const late = await b.gate(old.id);
	assert.deepEqual([late.next, late.revise_receipt], ["revise", undefined]);
	assert.match(late.revise_error ?? "", /replace_planner/);
	const rawPath = join(b.home, paths.gateFileRaw(old.id, 1));
	writeFileSync(rawPath, JSON.stringify({ ...late.verdict, revisions: ["full revision ".repeat(100)] }));
	const seeded = await b.post.replacePlanner(old.id, replacement.id);
	assert.deepEqual(await b.post.replacePlanner(old.id, replacement.id), seeded, "retry is idempotent");
	const dir = join(b.home, paths.runDir(replacement.id));
	assert.equal(readFileSync(join(dir, "previous-plan.md"), "utf8"), "# Original plan\nkeep the scope\n");
	assert.equal(readFileSync(join(dir, "gate-1-raw.json"), "utf8"), readFileSync(rawPath, "utf8"));
	assert.equal(readFileSync(join(dir, "original-task.md"), "utf8"), "original scope");
	const seededTask = readFileSync(seeded.task_file, "utf8");
	assert.ok(/replacement read-only planner/.test(seededTask) && seededTask.includes(b.post.artifacts.file(replacement.id)));
	assert.ok(!JSON.stringify(seeded).includes("keep the scope") && !b.post.artifacts.has(replacement.id));
	assert.deepEqual([(await ledger.show(old.id)).status, b.post.fleet.get(old.id)?.phase], ["closed", "done"]);
	const another = await ledger.create({ title: "another replacement", project: "demo", kind: "research", delivery: "pipeline" });
	await assert.rejects(b.post.replacePlanner(old.id, another.id), /already prepared/);
	const wrong = await ledger.create({ title: "ship", project: "demo", kind: "ship", delivery: "pipeline" });
	await assert.rejects(b.post.replacePlanner(old.id, wrong.id), /fresh, undispatched research/);
	await b.post.fleet.patch(old.id, { phase: "held" });
	await assert.rejects(b.post.replacePlanner(old.id, replacement.id), /torn-down, closed research/);
	await b.post.fleet.patch(old.id, { phase: "done" });
	await b.subject(replacement.id, "# Revised plan\nexact test commands\n");
	const carried = await b.gate(replacement.id, { deliverRevise: false });
	assert.deepEqual([carried.verdict.attempt, carried.verdict.cause], [2, "policy"], "the seeded revise is spent: the next one is capped");
	await assert.rejects(b.post.replacePlanner(replacement.id, another.id), /torn-down, closed research/);

	// data/gate.json is read per attempt: an operator edit reaches the very next review, no restart.
	await b.subject("cp-gate-timeout");
	writeFileSync(join(b.home, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: SCHEMA_VERSION, review_timeout_ms: 1_000 }));
	pin(b.script("gate-hang-1", [{ kind: "hang" }]));
	assert.match((await b.gate("cp-gate-timeout")).verdict.reasons.join(" "), /did not report a verdict within 1000ms/);
	writeFileSync(join(b.home, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: SCHEMA_VERSION, review_timeout_ms: 2_500 }));
	pin(b.script("gate-hang-2", [{ kind: "hang" }]));
	const slower = await b.gate("cp-gate-timeout");
	assert.equal(slower.verdict.cause, "operational_persistent");
	assert.match(slower.verdict.reasons.join(" "), /did not report a verdict within 2500ms/);
	writeFileSync(join(b.home, LAYOUT.gateConfigFile), JSON.stringify({ schema_version: SCHEMA_VERSION, review_timeout_ms: 60_000 }));

	// An unparseable verdict is operational, with the rejection on disk; no artifact is a refusal, not an escalate.
	await b.subject("cp-gate-bad");
	const bad = { job_id: "cp-someone-else", verdict: "pass", flags: NO_FLAGS, reasons: ["ok"] };
	pin(b.script("gate-bad", [...Array.from({ length: 3 }, (): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "report_verdict", args: bad }] })),
		{ kind: "text", text: "giving up" }]));
	assert.equal((await b.gate("cp-gate-bad")).verdict.cause, "operational");
	assert.ok(existsSync(join(b.home, paths.gateRunDir("cp-gate-bad", 1), "verdict-rejected.json")));
	await assert.rejects(b.gate("cp-gate-none"), /no artifact for cp-gate-none/);
	assert.equal(existsSync(join(b.home, paths.gateFile("cp-gate-none", 1))), false);

	// A reviewer process that dies mid-review is an operational fault, worded exactly, and the ladder retries.
	await b.subject("cp-gate-exit");
	pin(b.script("gate-exit", [live(() => {
		const { pid } = JSON.parse(readFileSync(join(b.home, paths.pendingReviewFile("cp-gate-exit", "gate", 1)), "utf8")) as { pid: number };
		process.kill(pid, "SIGKILL");
		return { job_id: "cp-gate-exit", verdict: "pass", flags: NO_FLAGS, reasons: ["never delivered"] };
	})]));
	const exited = await b.gate("cp-gate-exit");
	assert.deepEqual([exited.verdict.cause, exited.next], ["operational", "retry"]);
	assert.ok(exited.verdict.reasons.includes("reviewer exited without reporting a verdict"), JSON.stringify(exited.verdict.reasons));
});

test("P11c-gate-routing: preferences, refusals, subject axes, fallbacks and capacity choose the reviewer and its effort", { timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	const noSpawn = (jobId: string) => !existsSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl"));

	// A configured preference (project, mandate, explicit, reread) picks the model, keeps the axes and profile effort,
	// and a complete pass is retained when preferences change.
	const cases = ["project", "mandate", "explicit", "reread"] as const;
	const models = cases.map((source) => b.script(`gate-pref-${source}`, [verdict(`cp-pref-${source}`)]));
	for (const [index, source] of cases.entries()) {
		const jobId = `cp-pref-${source}`, model = models[index]!;
		await b.subject(jobId, undefined, { scope: "L", risk: "high", inferred: false });
		await b.post.registry.setReviewerModel("demo", source === "reread" ? model : models[0]!);
		if (source === "mandate" || source === "explicit") b.post.mandates.issue({ projects: ["demo"], job_ids: [jobId], objective: "review",
			reviewer_model: models[1]!, expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
		const result = await b.gate(jobId, source === "explicit" ? { model } : {});
		assert.deepEqual([result.model, result.verdict.verdict, b.effort(jobId)], [model, "pass", "high"], source);
		assert.deepEqual([b.selected(jobId)?.source, b.selected(jobId)?.model], [source === "reread" ? "project" : source, model]);
		const routed = b.routed(jobId)!;
		assert.deepEqual([routed.scope, routed.risk, routed.provenance], ["L", "high", { scope: "inherited", risk: "inherited" }]);
		await b.post.registry.setReviewerModel("demo", "unavailable/reviewer");
		const grant = b.post.mandates.list().find((each) => each.job_ids?.includes(jobId));
		if (grant) b.post.mandates.setReviewerModel(grant.id, "unavailable/reviewer");
		const reused = await b.post.gateModule().start({ jobId });
		assert.ok(!isGateWait(reused) && reused.model === model, "a complete pass is retained when preferences change");
		assert.ok(!existsSync(join(b.home, paths.gateRunDir(jobId, 2))), "preference changes cannot spend another review");
	}

	// A configured or explicit preference that is refused never falls back to the row's spare (cp-7re9 for role deny).
	for (const refusal of ["allowlist", "availability", "effort", "deny"] as const) {
		const jobId = `cp-pref-${refusal}`;
		const chosen = b.script(`gate-refuse-${refusal}`, [verdict(jobId)]);
		const spare = b.script(`gate-spare-${refusal}`, [verdict(jobId)]);
		if (refusal === "availability") b.down.add(chosen);
		if (refusal === "effort") b.lowOnly.add(chosen);
		b.routing([{ id: "available-spare", role: "gate-reviewer", model: spare, fallbacks: [spare] }],
			refusal === "allowlist" ? { allow: [spare] } : refusal === "deny" ? { deny_by_role: { "gate-reviewer": [chosen] } } : {});
		await b.subject(jobId);
		await b.post.registry.setReviewerModel("demo", chosen);
		await assert.rejects(b.post.gate({ jobId }), { allowlist: /which the allowlist refuses/, availability: /no available model for gate-reviewer/,
			effort: /cannot serve.*never substitutes an effort level/, deny: /not allowed for role gate-reviewer/ }[refusal]);
		if (refusal === "deny") await assert.rejects(b.post.gate({ jobId, model: chosen }), /not allowed for role gate-reviewer/);
		assert.ok(noSpawn(jobId) && b.provider.requests(`gate-spare-${refusal}`).length === 0, refusal);
	}
	await b.post.registry.setReviewerModel("demo", null);

	// cp-reviewer-routing: the subject's axes fire the narrow row and its effort reaches the spawned reviewer.
	const narrow = b.script("gate-narrow", [verdict("cp-gate-routed")]);
	const broad = b.script("gate-broad", [verdict("cp-gate-legacy")]);
	b.routing([{ id: "reviews-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
		{ id: "reviews-default", role: "gate-reviewer", model: broad, thinking: "low" }]);
	await b.subject("cp-gate-routed", undefined, { scope: "L", risk: "high", thinking: "xhigh", inferred: false, provenance: { scope: "assessed", risk: "assessed" } });
	assert.deepEqual([(await b.gate("cp-gate-routed")).model, b.effort("cp-gate-routed")], [narrow, "medium"], "not the profile's high");
	const { quota: _quota, line, ...routed } = b.routed("cp-gate-routed")!;
	assert.deepEqual(routed, { surface: "gate", attempt: 1, model: narrow, source: "rubric", rule: "reviews-large", thinking: "medium",
		scope: "L", risk: "high", provenance: { scope: "inherited", risk: "inherited" }, subject_provenance: { scope: "assessed", risk: "assessed" } });
	assert.match(String(line), new RegExp(`^source=rubric model=${narrow} rule=reviews-large thinking=medium`));
	// A legacy subject with no recorded routing is unknown, never a measured S/low.
	await b.subject("cp-gate-legacy");
	assert.deepEqual([(await b.gate("cp-gate-legacy")).model, b.effort("cp-gate-legacy")], [broad, "low"]);
	const legacy = b.routed("cp-gate-legacy")!;
	assert.deepEqual([legacy.provenance, "scope" in legacy, "risk" in legacy], [{ scope: "unknown", risk: "unknown" }, false, false]);

	// pi-command-post-0a9: an unavailable first candidate falls back at the row's effort; a named override still refuses.
	const spare = b.script("gate-spare", [verdict("cp-gate-fallback")]);
	b.routing([{ id: "reviews", role: "gate-reviewer", model: "unauth/opus", fallbacks: [spare], thinking: "low" }]);
	await b.subject("cp-gate-fallback");
	assert.deepEqual([(await b.gate("cp-gate-fallback")).model, b.effort("cp-gate-fallback")], [spare, "low"]);
	assert.deepEqual(b.routed("cp-gate-fallback")?.attempted, [{ model: "unauth/opus", refusal: "availability" }]);
	assert.match(String(b.routed("cp-gate-fallback")?.line), /attempted=unauth\/opus\(availability\)/);
	await b.subject("cp-gate-override");
	await assert.rejects(b.gate("cp-gate-override", { model: "unauth/opus" }), /no available model/);
});

test("P11c-gate-capacity: with no gateway answer, a high-risk reviewer goes to the provider with no waiting worker", { timeout: 300_000 }, async (t) => {
	// The admin endpoint must be https; an unreachable one makes the reader compare only the fleet's waiting workers.
	const b = await bench(t, { CP_GATEWAY_ADMIN_KEY: "test-only" });
	writeFileSync(join(b.home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://127.0.0.1:9/", path: "/capacity" }));
	const main = b.script("gate-cap-main", [verdict("cp-gate-capacity")]);
	const other = b.script("gate-cap-other", [verdict("cp-gate-capacity")]).replace(/^.*\//, "mock2/");
	await b.subject("cp-busy");
	await b.post.fleet.patch("cp-busy", { phase: "waiting" });
	b.routing([{ id: "reviews-high", role: "gate-reviewer", risk: "high", model: main, fallbacks: [other], thinking: "low" }]);
	await b.subject("cp-gate-capacity", undefined, { scope: "L", risk: "high", inferred: false });
	assert.equal((await b.gate("cp-gate-capacity")).model, other, JSON.stringify(b.routed("cp-gate-capacity")));
	assert.match(String(b.routed("cp-gate-capacity")?.line), /capacity=fleet:mock=-1,mock2=0/);
});

/** do8.3's original task: three numbered requirements the reviewer scores the plan against. */
const TASK = ["Rework the retry ladder.", "", "1. Retries must be bounded at three attempts.", "2. A budget breach must escalate to the operator.",
	"3. The ladder must survive a parent restart."].join("\n");
const planFor = (covered: readonly number[]) => ["## Goal", "Make the ladder better.", "", "## Test plan",
	...covered.map((requirement) => `- npm test proves requirement ${requirement}`), ""].join("\n");

test("P11c-gate-task: the reviewer scores the frozen original task, as a bounded file beside the artifact", { timeout: 600_000 }, async (t) => {
	const b = await bench(t);
	const scratchOf = (jobId: string) => join(b.home, paths.gateScratchDir(jobId, 1));
	const briefOf = (jobId: string) => readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "brief.md"), "utf8");
	const seen = new Map<string, { entries: string[]; task?: string }>();
	/** Reads what the gate put in its cwd and revises every original requirement the artifact misses. */
	const coverage = (jobId: string) => live(() => {
		const scratch = scratchOf(jobId);
		const entries = readdirSync(scratch).sort();
		const task = entries.includes(ORIGINAL_TASK_COPY) ? readFileSync(join(scratch, ORIGINAL_TASK_COPY), "utf8") : undefined;
		seen.set(jobId, { entries, ...(task === undefined ? {} : { task }) });
		const artifact = readFileSync(join(scratch, "artifact.md"), "utf8");
		const missing = [...(task ?? "").matchAll(/^(\d+)\. (.+)$/gm)].filter(([, number]) => !artifact.includes(`requirement ${number}`))
			.map(([, number, text]) => `requirement coverage: the plan does not cover "${text}" (task item ${number})`);
		return missing.length === 0 ? { job_id: jobId, verdict: "pass", flags: NO_FLAGS, reasons: ["every task item maps to a test"] }
			: { job_id: jobId, verdict: "revise", flags: NO_FLAGS, reasons: missing, revisions: missing };
	});
	const review = async (jobId: string, body: string, task?: string) => {
		await b.subject(jobId, body);
		if (task !== undefined) b.originalTask(jobId, task);
		b.routing([{ id: "reviews", role: "gate-reviewer", model: b.script(`gate-${jobId}`, [coverage(jobId)]) }]);
		return b.gate(jobId, { deliverRevise: false });
	};

	const gap = await review("cp-gate-omits", planFor([1, 3]), TASK);
	assert.deepEqual([gap.verdict.verdict, gap.next], ["revise", "revise"], "a silently omitted requirement must not pass");
	assert.match(gap.verdict.revisions?.join(" ") ?? "", /budget breach must escalate to the operator/);
	assert.deepEqual([(await review("cp-gate-complete", planFor([1, 2, 3]), TASK)).next], ["proceed"]);

	// A task quoting credential-shaped text still reaches the reviewer, as a file the brief only points at.
	const secretish = `GITHUB_TOKEN=${"ghp_"}${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
	const task = `${TASK}\n\nMeasured during research: ${secretish}\n`;
	assert.equal((await review("cp-gate-taskfile", planFor([1, 2, 3]), task)).verdict.verdict, "pass");
	assert.deepEqual(seen.get("cp-gate-taskfile"), { entries: ["artifact.md", ORIGINAL_TASK_COPY], task });
	const brief = briefOf("cp-gate-taskfile");
	assert.ok(brief.includes(join(scratchOf("cp-gate-taskfile"), ORIGINAL_TASK_COPY)) && !brief.includes(secretish) && !brief.includes("Retries must be bounded"));
	assert.match(brief, /never the source of truth/);
	assert.ok(!brief.includes("task-addenda.md") && !/Addendum \d/.test(brief), "no addenda, no addenda block");
	assert.equal(readFileSync(join(b.home, paths.originalTaskFile("cp-gate-taskfile")), "utf8"), task);
	assert.ok(!existsSync(scratchOf("cp-gate-taskfile")) && !b.jobLog("cp-gate-taskfile").includes(secretish));

	// Authorized addenda ride beside the original task, with provenance, and only as a file.
	await b.subject("cp-gate-addenda", planFor([1, 2, 3]));
	b.originalTask("cp-gate-addenda", TASK);
	writeFileSync(join(b.home, paths.taskAddendaFile("cp-gate-addenda")), [1, 2].map((n) => `${JSON.stringify({ schema_version: 1, n,
		added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: `Extra scope ${n}.` })}\n`).join(""));
	b.routing([{ id: "reviews", role: "gate-reviewer", model: b.script("gate-addenda", [verdict("cp-gate-addenda", { verdict: "revise", revisions: ["cover it"] })]) }]);
	await b.gate("cp-gate-addenda", { deliverRevise: false });
	const amended = briefOf("cp-gate-addenda");
	assert.ok(amended.includes(join(scratchOf("cp-gate-addenda"), ORIGINAL_TASK_COPY)) && amended.includes(join(scratchOf("cp-gate-addenda"), "task-addenda.md")));
	assert.match(amended, /Addendum 1 \(operator-quote, 2026-09-24T10:00:00Z\)[^]*Addendum 2/);
	assert.match(amended, /authorized scope/);
	assert.match(amended, /not their presence as scope growth/);
	assert.ok(!amended.includes("Extra scope 1."));
	const addendaCopy = readFileSync(join(scratchOf("cp-gate-addenda"), "task-addenda.md"), "utf8");
	assert.ok(["Extra scope 1.", "Extra scope 2.", 'Quote: "approved"'].every((line) => addendaCopy.includes(line)), addendaCopy);

	// No freeze, or an empty one, is reviewed artifact-only and the brief says so.
	for (const [jobId, frozen] of [["cp-gate-notask", undefined], ["cp-gate-emptytask", ""]] as const) {
		assert.equal((await review(jobId, planFor([1]), frozen)).verdict.verdict, "pass", "a missing freeze is not an operational fault");
		assert.deepEqual(seen.get(jobId)?.entries, ["artifact.md"]);
		assert.match(briefOf(jobId), /Original task: not available/);
		assert.ok(!briefOf(jobId).includes("${"), "no unsubstituted placeholder reaches a reviewer");
	}

	// A task over REVIEW_ORIGINAL_TASK_MAX_BYTES (100 000) is refused whole before any reviewer spawns: nothing truncated.
	await assert.rejects(review("cp-gate-bound", planFor([1]), `${"requirement line\n".repeat(6_000)}tail\n`),
		/original-task\.md: complete planner input exceeds the byte cap; nothing truncated/);
	assert.ok(!seen.has("cp-gate-bound") && !existsSync(join(b.home, paths.gateFile("cp-gate-bound", 1))));
});

test("P11c-gate-diff-bar: cp_review's high-only bar downgrades a revise with no high/high finding", { timeout: 300_000 }, async (t) => {
	const b = await bench(t);
	const repo = createScratchRepo({ name: "diffdemo" });
	t.after(() => repo.cleanup());
	await b.post.registry.register({ name: "diffdemo", clone_url: repo.remote as string, delivery: "pr" });
	const review = async (jobId: string, observation: Partial<GateReview>) => {
		repo.git("checkout", "--quiet", "-b", jobId, repo.branch);
		repo.write(`${jobId}.ts`, "export const x = 1;\n");
		repo.commitAll(jobId);
		repo.git("push", "--quiet", "-u", "origin", jobId);
		repo.git("checkout", "--quiet", repo.branch);
		await b.post.fleet.add({ job_id: jobId, project: "diffdemo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held",
			reported_at: isoTimestamp(), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, worktree: join(b.home, "gone", jobId), branch: jobId,
			worker: { pid: process.pid, session_id: "s", session_file: join(b.home, "s.jsonl"), profile: "implementer", role: "implementer",
				model: "mock/implementer", started_at: isoTimestamp() } });
		const started = await b.post.diffReview({ jobId, model: b.script(`diff-${jobId}`, [verdict(jobId, observation)]) });
		if (!isDiffReviewWait(started)) return started.verdict;
		b.post.reviewRuns.handBack(started.key);
		await b.post.reviewRuns.settled(started.key);
		return JSON.parse(readFileSync(join(b.home, paths.reviewFile(jobId, started.attempt)), "utf8")) as DiffVerdict;
	};
	const downgraded = "downgraded: no high/high finding";
	for (const [jobId, reason] of [["cp-bar-medium", "[severity: medium] [confidence: high] src/x.ts:1 — missing a test"],
		["cp-bar-mixed", "[severity: high] [confidence: medium] src/x.ts:1 — maybe a leak"], ["cp-bar-untagged", "needs a test"]] as const) {
		const decided = await review(jobId, { verdict: "revise", reasons: [reason], revisions: ["add a test"] });
		assert.deepEqual([decided.verdict, decided.cause, decided.revisions], ["pass", null, undefined], jobId);
		assert.ok(decided.reasons.some((each) => each.includes(downgraded)), jobId);
	}
	const kept = await review("cp-bar-high", { verdict: "revise", reasons: ["[severity: high] [confidence: high] src/x.ts:1 — auth bypass"],
		revisions: ["reject empty token"] });
	assert.deepEqual([kept.verdict, kept.revisions, kept.reasons.some((each) => each.includes(downgraded))], ["revise", ["reject empty token"], false]);
	const escalated = await review("cp-bar-escalate", { verdict: "escalate", reasons: ["stat empty"] });
	assert.deepEqual([escalated.verdict, escalated.cause], ["escalate", "policy"]);
});

async function waitForRequests(provider: MockProvider, name: string, count: number) {
	for (let tries = 0; provider.requests(name).length < count && tries < 200; tries += 1) await new Promise((done) => setTimeout(done, 100));
	assert.ok(provider.requests(name).length >= count, `${name} never received request ${count}`);
}
