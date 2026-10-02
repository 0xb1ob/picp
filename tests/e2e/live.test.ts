/**
 * T29 — the LIVE end-to-end suite. **OPERATOR RUN ONLY, never in CI.**
 *
 *   CP_LIVE_TESTS=1 npm run e2e:live
 *
 * Five scenarios against a real model on a scratch project (see
 * tests/e2e/README.md for the full runbook):
 *
 *   (a) single ship job: intake → dispatch → envelope → teardown gates → close
 *   (b) pipeline: research → artifact → gate → checkpoint → implement
 *   (c) delivery:pr: hold → promote with a CI fix → teardown
 *   (d) parent kill -9 mid-job → restart → reconcile → the held worker survives
 *   (e) worker crash → classification → bounded re-dispatch
 *   (f) a planner asks the operator, and the answer reaches the worker (T31)
 *   (g) a planner's question is HELD, answered at a console, then detached
 *       (attach, phase 7)
 *
 * What these prove that the mock milestones (m1–m3) cannot: that a real model,
 * given our real briefs, produces envelopes our validator accepts, leaves trees
 * our teardown gates pass, and behaves under the same budgets. What they do
 * *not* prove is model quality — a `revise` verdict or a blocked report is a
 * legitimate outcome, and each scenario asserts the machinery around the
 * model's answer, never the answer itself.
 *
 * Cost discipline: every job's spend is recorded and asserted against
 * `CP_LIVE_TOKEN_BUDGET` (per job) and `CP_LIVE_TOTAL_BUDGET` (whole suite), and
 * the run prints a spend table at the end.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type EnvelopeRecord, type FleetRecord, paths, validateEnvelope } from "../../src/contracts.ts";
import { classifyRun, decideRecovery } from "../../src/failures.ts";
import { isPidAlive } from "../../src/fleet.ts";
import { readEventLog } from "../../src/run-artifacts.ts";
import type { Authorizer } from "../../src/pipeline.ts";
import type { Asker, OperatorQuestion } from "../../src/questions.ts";
import { formatStatusTable } from "../../src/status.ts";
import { lastFiledEnvelopeFile } from "../../src/supersede.ts";
import {
	assertUnderJobBudget,
	createLiveFixture,
	fakePrUrl,
	type LiveFixture,
	LIVE_JOB_BUDGET,
	LIVE_MODEL,
	liveSkip,
	recordGateSpend,
	recordSpend,
	remoteHas,
	spendReport,
} from "../harness/live.ts";
import { leaseState, readFleet, readRunStatus, REPO_ROOT, waitFor } from "../harness/index.ts";

/** Real models take turns; nothing here waits on a fixed count. */
const ENVELOPE_TIMEOUT_MS = 480_000;

/** Wait until the job reports, or until it is over budget (then fail loudly). */
async function waitForPhase(
	fixture: LiveFixture,
	jobId: string,
	phase: FleetRecord["phase"],
	what: string,
): Promise<FleetRecord> {
	const record = await waitFor(
		() => readFleet(fixture.home.path).jobs.find((job) => job.job_id === jobId),
		(job) => job?.phase === phase || (readRunStatus(fixture.home.path, jobId).usage.total_tokens ?? 0) > LIVE_JOB_BUDGET,
		{ timeoutMs: ENVELOPE_TIMEOUT_MS, intervalMs: 1000, what },
	);
	assertUnderJobBudget(fixture.home.path, jobId, what);
	assert.equal(record?.phase, phase, `${jobId}: expected ${phase}, got ${record?.phase}`);
	return record as FleetRecord;
}

/**
 * Wait for the planner to actually rewrite its artifact, which is the fact a
 * re-gate is keyed on (`artifact.modified_at > verdict.decided_at`).
 *
 * Not "wait for the worker to be idle": a worker is idle the *moment* it
 * reports, so that wait is already over before the revise is even delivered.
 * Bounded and boolean, because a live model may legitimately answer the
 * revisions without touching the file — that is an outcome, not a hang.
 */
async function waitForRevisedArtifact(
	post: CommandPost,
	jobId: string,
	before: string | undefined,
	timeoutMs = 240_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const modified = post.artifacts.info(jobId).modified_at;
		if (modified !== undefined && modified !== before) return true;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	return false;
}

function envelopeOf(home: string, jobId: string): EnvelopeRecord {
	return JSON.parse(readFileSync(join(home, paths.envelopeFile(jobId)), "utf8")) as EnvelopeRecord;
}

/** The last envelope this job filed, live or archived by a supersession. */
function lastEnvelopeOf(post: CommandPost, home: string, jobId: string): EnvelopeRecord {
	const file = lastFiledEnvelopeFile(home, post.fleet.require(jobId));
	if (!file) throw new Error(`${jobId} has filed no envelope`);
	return JSON.parse(readFileSync(file, "utf8")) as EnvelopeRecord;
}

// ---------------------------------------------------------------------------
// (a) single ship job → envelope → teardown
// ---------------------------------------------------------------------------

test(
	"live (a): a single ship job goes intake → dispatch → envelope → teardown",
	{ timeout: 900_000, skip: liveSkip() },
	async (t) => {
		const fixture = await createLiveFixture();
		t.after(async () => {
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const issue = await post.ledger().create({
			title: "bump the version file",
			project: fixture.project,
			delivery: "local",
			kind: "ship",
			slug: "live-a",
		});

		const dispatched = await post.dispatch({
			jobId: issue.id,
			task:
				"Change the single number in src/version.txt from 1 to 2 and commit it with the message 'bump version'. " +
				"That is the whole job. There is no test suite. This job is delivery:local: push the branch as your brief says, " +
				"and do not open a PR.",
			model: LIVE_MODEL,
		});
		assert.equal(dispatched.state, "dispatched");
		assert.equal(dispatched.receipt, "accepted", "the receipt is a fact: pi answered the prompt");
		assert.equal(dispatched.branch, issue.id, "branch is the job id");

		// The ledger claim is last in dispatch's order: in_progress only once a
		// worker exists.
		assert.equal((await post.ledger().show(issue.id)).status, "in_progress");

		await waitForPhase(fixture, issue.id, "held", "the worker's envelope");
		recordSpend("a/ship", home.path, issue.id);

		// The envelope is re-validated here for the same reason intake does it:
		// the worker's word is not evidence.
		const record = envelopeOf(home.path, issue.id);
		const validation = validateEnvelope(record.envelope, {
			job_id: issue.id,
			kind: "ship",
			delivery: "local",
			worktree: dispatched.worktree,
		});
		assert.ok(validation.ok, validation.ok ? "" : validation.errors.join("; "));
		assert.equal(record.envelope.status, "done", `worker reported blocked: ${record.envelope.summary}`);
		assert.equal(record.envelope.pr_url, undefined, "delivery:local opens no PR");
		assert.equal(readFileSync(join(dispatched.worktree, "src/version.txt"), "utf8").trim(), "2");
		assert.ok(remoteHas(fixture, issue.id), "every ship job publishes its branch, PR or not");

		// Teardown runs its REAL gates (no force): clean, on the job branch, and
		// pushed; then the observed close and the lease return.
		const torn = await post.tearDown(issue.id);
		assert.equal(torn.torn_down, true, `teardown refused: ${JSON.stringify(torn)}`);
		assert.equal(torn.reason, "pushed");
		assert.equal(torn.exit_code ?? 0, 0, "the close is observed, not inferred");
		assert.equal(readFleet(home.path).jobs.find((job) => job.job_id === issue.id)?.phase, "done");
		// The lease came back. Measured, not assumed: `treehouse return` *recycles*
		// the worktree — it cleans, resets and keeps the directory for the next job
		// — so the observable fact is the pool calling it `available`, never a path
		// that stopped existing (T29 amendment; the same rule as
		// tests/leases.test.ts).
		assert.equal(torn.lease_returned, true);
		assert.equal(leaseState(fixture.clone, dispatched.worktree), "available", "the pool still shows the lease held");

		await post.ledger().close(issue.id, `live: ${record.envelope.summary.split("\n")[0]}`);
		assert.equal((await post.ledger().show(issue.id)).status, "closed");
	},
);

// ---------------------------------------------------------------------------
// (b) pipeline: research → gate → checkpoint → implement
// ---------------------------------------------------------------------------

test(
	"live (b): a pipeline reaches a real verdict, a real authorization and a real implementation",
	{ timeout: 1_800_000, skip: liveSkip() },
	async (t) => {
		const asked: string[] = [];
		// The suite answers its own checkpoint and says so on the record: an
		// unattended run is exactly when "who authorized this?" matters.
		const authorizer: Authorizer = {
			async ask(checkpoint) {
				asked.push(checkpoint.job_id);
				return { approved: true, by: "live suite (unattended)" };
			},
		};
		const fixture = await createLiveFixture({ maxTrees: 3, authorizer });
		t.after(async () => {
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const started = await post.startPipeline({
			title: "bump the version file",
			project: fixture.project,
			task:
				"Plan the change that sets the single number in src/version.txt from 1 to 2. " +
				"It is one file and one line: keep the plan short, name the file explicitly, and say in the test plan that this repo has no test suite.",
			delivery: "local",
			slug: "live-b",
			model: LIVE_MODEL,
		});
		const { research_id: researchId, ship_id: shipId } = started;
		assert.equal(started.dispatch.receipt, "accepted");
		// br cannot offer the ship job while the research is open.
		assert.ok(
			(await post.ledger().blockersOf(shipId)).includes(researchId),
			"the two issues must be dep-linked",
		);

		await waitForPhase(fixture, researchId, "held", "the research envelope");
		recordSpend("b/research", home.path, researchId);

		// The artifact exists, and the parent has still never read it.
		assert.ok(post.artifacts.has(researchId), "research must file an artifact");

		let advanced = await post.advancePipeline(researchId);
		let verdict = advanced.gate?.verdict;
		assert.ok(verdict, `no gate decision: ${advanced.message}`);
		assert.equal(verdict.cause === null, verdict.verdict !== "escalate", "cause is null exactly on pass/revise");
		// The reviewer is its own worker with its own run dir: charge the gate to
		// the gate, not to the planner whose id it shares.
		recordGateSpend("b/gate-1", home.path, researchId, 1);

		// A revise is a legitimate live outcome: it exercises the promote path and
		// the one-revise cap for real. Give the planner one chance, then re-gate.
		if (verdict.verdict === "revise") {
			// `advance` speaks the pipeline's vocabulary (wait/authorize/surface/done);
			// the ladder words (revise/retry/proceed) belong to cp_gate's own result.
			// The revisions are already with the live planner, so the only correct
			// instruction to the parent is: wait.
			assert.equal(advanced.state, "gating");
			assert.equal(advanced.next, "wait");
			assert.equal(advanced.gate?.revise_receipt, "delivered", "the live planner must receive the revisions");
			const revised = await waitForRevisedArtifact(post, researchId, post.artifacts.info(researchId).modified_at);
			assertUnderJobBudget(home.path, researchId, "post-revise research");
			advanced = await post.advancePipeline(researchId);
			assert.equal(advanced.gate !== undefined, revised, "a re-gate happens exactly when the artifact changed");
			if (advanced.gate) {
				verdict = advanced.gate.verdict;
				recordGateSpend("b/gate-2", home.path, researchId, 2);
				assert.ok(verdict.verdict !== "revise", "a second revise must become escalate (GATE_MAX_REVISE)");
			} else {
				// A revise is only spent once the artifact actually changes. The
				// planner answered without touching it, so there is nothing new to
				// judge — assert that no re-gate was paid for and stop.
				assert.equal(advanced.state, "gating");
				assert.equal(advanced.next, "wait");
				assert.deepEqual(asked, [], "an unjudged artifact never reaches a human");
				console.log("[live b] the planner left the artifact unchanged — no second gate, nothing authorized");
				await post.tearDown(researchId, { force: true });
				return;
			}
		}

		if (verdict.verdict !== "pass") {
			// Escalation is a decision, not a failure: assert it surfaced correctly
			// and stop. Nothing may have been authorized. `surface` means a human
			// owns it; `wait` means advance again (an operational fault retries on a
			// different model) — cp_gate's `retry` is the tool's word, not this one's.
			const expected = verdict.verdict === "escalate" && verdict.cause !== "operational" ? "surface" : "wait";
			assert.equal(advanced.next, expected, `unexpected next for ${verdict.verdict}/${verdict.cause}`);
			assert.deepEqual(asked, [], "only a passed gate reaches a human");
			assert.equal(post.checkpoints.get(shipId)?.decision ?? "absent", "absent");
			console.log(`[live b] gate escalated (cause=${verdict.cause}) — implementation deliberately not reached`);
			await post.tearDown(researchId, { force: true });
			return;
		}

		// pass → the research job is closed and torn down, and a human is asked.
		assert.deepEqual(asked, [shipId], "a passed gate asks for authorization, exactly once");
		const checkpoint = post.checkpoints.get(shipId);
		assert.equal(checkpoint?.decision, "approved");
		assert.match(checkpoint?.decided_by ?? "", /live suite/, "the journal names who answered");
		assert.equal(advanced.state, "implementing");
		assert.equal(advanced.dispatch?.receipt, "accepted");

		// The artifact reached the implementer as a file, never through the parent.
		const taskFile = join(home.path, paths.taskFile(shipId));
		assert.ok(readFileSync(taskFile, "utf8").length > 0, "the implementer got the artifact as a task file");

		await waitForPhase(fixture, shipId, "held", "the implementer's envelope");
		recordSpend("b/implement", home.path, shipId);
		const shipEnvelope = envelopeOf(home.path, shipId);
		assert.equal(shipEnvelope.envelope.kind, "ship");
		if (shipEnvelope.envelope.status === "done") {
			const worktree = readFleet(home.path).jobs.find((job) => job.job_id === shipId)?.worktree as string;
			assert.equal(readFileSync(join(worktree, "src/version.txt"), "utf8").trim(), "2");
			const torn = await post.tearDown(shipId);
			assert.equal(torn.torn_down, true, `teardown refused: ${JSON.stringify(torn)}`);
		} else {
			console.log(`[live b] implementer reported blocked: ${shipEnvelope.envelope.summary}`);
			await post.tearDown(shipId, { force: true });
		}

		// The terminal state is a projection like every other state in this machine:
		// the next advance reads the ship job's facts and writes `done`. Nothing
		// else writes it — teardown does not reach into the pipeline record — so the
		// operator's last pipeline step is one more advance (T29 amendment; before
		// it, `done` was documented and unreachable).
		const finished = await post.advancePipeline(researchId);
		assert.equal(finished.next, "done");
		assert.equal(finished.dispatch, undefined, "a finished pipeline dispatches nothing");
		assert.equal(post.pipeline().store.get(researchId)?.state, "done");
	},
);

// ---------------------------------------------------------------------------
// (c) delivery:pr hold → promote with a CI fix → teardown
// ---------------------------------------------------------------------------

test(
	"live (c): a delivery:pr job holds, takes a promoted CI fix, then tears down",
	{ timeout: 1_500_000, skip: liveSkip() },
	async (t) => {
		const fixture = await createLiveFixture();
		t.after(async () => {
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const issue = await post.ledger().create({
			title: "add a greeting module",
			project: fixture.project,
			delivery: "pr",
			kind: "ship",
			slug: "live-c",
		});

		// There is no GitHub here, so the PR url is supplied BY THE TEST, not
		// invented by the model: `delivery:pr` requires an https pr_url, and the
		// point of this scenario is the hold/promote/teardown machinery around it.
		// Operators who want the real thing can run this against a real remote
		// (see tests/e2e/README.md).
		const prUrl = fakePrUrl(fixture.project, issue.id);
		const dispatched = await post.dispatch({
			jobId: issue.id,
			task:
				"Create src/greet.txt containing exactly the word 'hello'. Commit it with the message 'add greeting' and push the branch to origin. " +
				`This job is delivery:pr, and the PR already exists: report its url exactly as ${prUrl}. Do not create a PR yourself and do not guess a different url.`,
			model: LIVE_MODEL,
		});
		assert.equal(dispatched.state, "dispatched");

		const held = await waitForPhase(fixture, issue.id, "held", "the first envelope");
		recordSpend("c/first", home.path, issue.id);
		const first = envelopeOf(home.path, issue.id);
		assert.equal(first.envelope.status, "done", `worker reported blocked: ${first.envelope.summary}`);
		assert.equal(first.envelope.pr_url, prUrl, "delivery:pr requires the https PR url in the envelope");
		assert.ok(remoteHas(fixture, issue.id), "delivery:pr means the branch is pushed");
		assert.ok(
			held.receipts?.some((receipt) => receipt.kind === "pr" && receipt.url === prUrl),
			"intake records the PR receipt",
		);

		// The hold: worker and lease are deliberately still alive after the
		// envelope, because CI has not spoken yet.
		assert.ok(post.manager.get(issue.id), "delivery:pr keeps the worker for the hold");
		assert.equal(readRunStatus(home.path, issue.id).phase, "idle");

		// Promote: same worker, same worktree, same model — the ported rule. This
		// is what a CI failure or a review comment looks like.
		//
		// The brief deliberately does not ASK for a second report: the envelope is
		// already in and a one-line CI fix is answered in the reply. The promote
		// still reopens the envelope slot (contracts §Envelope supersession), so a
		// worker that decided it had something new to report could file it — that
		// is the invariant, not an instruction to use it.
		const turnsBefore = readRunStatus(home.path, issue.id).turns;
		const receipt = await post.send({
			jobId: issue.id,
			message:
				"CI on the PR failed: src/greet.txt must end with a trailing newline. Fix exactly that, commit with the message 'fix trailing newline', and push. " +
				"Do not call report_result again — you already reported this job. Just tell me in your reply what you changed.",
			model: LIVE_MODEL,
		});
		assert.ok(["delivered", "queued"].includes(receipt.receipt), `promote receipt: ${JSON.stringify(receipt)}`);
		assert.equal(receipt.superseded?.generation, 1, "a promote to a held job reopens its envelope slot");

		await waitFor(
			() => readRunStatus(home.path, issue.id),
			(status) => status.phase === "idle" && status.turns > turnsBefore,
			{ timeoutMs: ENVELOPE_TIMEOUT_MS, intervalMs: 1000, what: "the promoted worker to settle" },
		);
		// One job, one report: the worker answered in its reply, so the envelope
		// that stands is generation 1 — archived by the supersession, never lost.
		assert.equal(
			lastEnvelopeOf(post, home.path, issue.id).envelope.pr_url,
			prUrl,
			"the reported envelope survives the supersession",
		);
		recordSpend("c/promote", home.path, issue.id);

		const worktree = dispatched.worktree;
		assert.equal(
			readFileSync(join(worktree, "src/greet.txt"), "utf8"),
			"hello\n",
			"the promoted fix landed in the same worktree",
		);
		// Pushed again: teardown's ship gate is clean + pushed.
		assert.equal(
			execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
			execFileSync("git", ["rev-parse", `origin/${issue.id}`], { cwd: worktree, encoding: "utf8" }).trim(),
			"the promoted commit is pushed",
		);

		// The PR landed (the operator's decision), so the hold ends and teardown
		// runs its real gates.
		await post.ledger().close(issue.id, `PR: ${prUrl}`);
		const torn = await post.tearDown(issue.id);
		assert.equal(torn.torn_down, true, `teardown refused: ${JSON.stringify(torn)}`);
		assert.ok(
			["pushed", "upstream", "merged", "merged_head_deleted"].includes(torn.reason ?? ""),
			`pass reason: ${torn.reason}`,
		);
	},
);

// ---------------------------------------------------------------------------
// (d) parent kill -9 → restart → reconcile → the held worker survives
// ---------------------------------------------------------------------------

/**
 * A driver that dispatches one job and then does nothing, so the test can
 * `kill -9` a **real parent process** while a **real worker** is running. It is
 * written into the scratch home rather than kept in the repo: it is a fixture,
 * not a product surface, and it must always match this build's own modules.
 */
const DRIVER = `
import { CommandPost } from ${JSON.stringify(join(REPO_ROOT, "src/command-post.ts"))};

const [home, project, jobId, model] = process.argv.slice(2);
const post = new CommandPost({ home, packageRoot: ${JSON.stringify(REPO_ROOT)} });
const result = await post.dispatch({
	jobId,
	task: "Read README.md, then write a two-line summary of it into notes.txt in the repository root. Commit it with the message 'add notes' and push the branch. Do not open a PR.",
	model,
});
process.stdout.write("DISPATCHED " + JSON.stringify({ pid: result.pid, worktree: result.worktree }) + "\\n");
// A real parent would now be waiting on events. This one waits to be killed:
// deliberately NO shutdown handler, because a kill -9 has none either.
setInterval(() => {}, 1000);
`;

test(
	"live (d): kill -9 the parent mid-job, restart, reconcile — the worker and its hold survive",
	{ timeout: 900_000, skip: liveSkip() },
	async (t) => {
		const fixture = await createLiveFixture();
		let workerPid: number | undefined;
		t.after(async () => {
			// The orphaned worker is ours to clean up: its parent is gone, so
			// nothing else will.
			if (workerPid) {
				try {
					process.kill(workerPid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const issue = await post.ledger().create({
			title: "summarize the readme",
			project: fixture.project,
			delivery: "local",
			kind: "ship",
			slug: "live-d",
		});

		const driverPath = join(home.path, "driver.ts");
		writeFileSync(driverPath, DRIVER);
		const driver = spawn(process.execPath, [driverPath, home.path, fixture.project, issue.id, LIVE_MODEL], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		driver.stdout.setEncoding("utf8");
		driver.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		driver.stderr.setEncoding("utf8");
		driver.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		// Wait for the parent to have dispatched a real worker.
		await waitFor(
			() => stdout,
			(text) => text.includes("DISPATCHED"),
			{ timeoutMs: 300_000, intervalMs: 500, what: `the driver to dispatch (stderr: ${stderr.slice(-400)})` },
		);
		const dispatched = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { pid: number; worktree: string };
		workerPid = dispatched.pid;
		assert.ok(workerPid > 0);
		const before = readFleet(home.path).jobs.find((job) => job.job_id === issue.id);
		assert.equal(before?.phase, "waiting", "a dispatched job with no envelope yet is `waiting`");

		// The parent dies with no chance to clean up. The worker keeps working.
		driver.kill("SIGKILL");
		await new Promise((resolve) => driver.once("close", resolve));
		// Liveness is `isPidAlive` — the same predicate reconcile uses. `process.kill(pid, 0)`
		// returns **true**, not undefined, so the two probes here used to assert
		// nothing at all (one of them was literally `|| true`).
		assert.equal(isPidAlive(workerPid), true, "the worker must outlive its parent — that is the whole scenario");

		// Restart: a fresh parent on the same home, exactly like a new session.
		const restarted = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
		const report = await restarted.fleet.reconcile();
		const entry = report.entries.find((row) => row.job_id === issue.id);
		assert.ok(entry, "reconcile must account for the job");
		// The worker's pid is alive but this process does not own it: `orphan` is
		// the honest answer, and reconcile must not kill it at startup.
		assert.ok(
			["orphan", "revivable", "reported", "failed"].includes(entry.outcome),
			`unexpected reconcile outcome: ${entry.outcome} (${entry.detail})`,
		);
		if (entry.outcome === "orphan") {
			assert.equal(entry.phase_after, "waiting", "an orphan is reported, never re-phased");
			assert.equal(isPidAlive(workerPid), true, "an orphan is reported, never killed at startup");
		}
		recordSpend("d/orphan", home.path, issue.id);

		// The run log survives a parent death: it is the history, and `/watch`
		// renders it afterwards exactly as it did live.
		const events = readEventLog(home.path, issue.id);
		assert.ok(events.length > 0, "events.jsonl survives the parent");
		assert.ok(
			events.some((event) => event.source === "cp" && event.type === "spawned"),
			"the spawn marker is on disk",
		);
		const view = restarted.watch(issue.id);
		assert.ok(view.lines.length > 0, "a restarted parent can still render the run");

		// Closing the books on an orphan is a deliberate act: force, and it claims
		// no pass reason because nothing was proven.
		const torn = await restarted.tearDown(issue.id, { force: true });
		assert.equal(torn.torn_down, true, JSON.stringify(torn));
		assert.equal(torn.reason, undefined, "force proves nothing, so it claims nothing");
		assert.equal(readFleet(home.path).jobs.find((job) => job.job_id === issue.id)?.phase, "done");
	},
);

// ---------------------------------------------------------------------------
// (e) worker crash → classification → bounded re-dispatch
// ---------------------------------------------------------------------------

test(
	"live (e): a crashed worker is classified and re-dispatched with the same brief, once",
	{ timeout: 1_200_000, skip: liveSkip() },
	async (t) => {
		const fixture = await createLiveFixture({ maxTrees: 2 });
		t.after(async () => {
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const issue = await post.ledger().create({
			title: "write a notes file",
			project: fixture.project,
			delivery: "local",
			kind: "ship",
			slug: "live-e",
		});

		const task =
			"Create notes.txt in the repository root containing the single line 'ready'. Commit it with the message 'add notes' " +
			"and push the branch. Do not open a PR.";
		const first = await post.dispatch({ jobId: issue.id, task, model: LIVE_MODEL });
		const managed = post.manager.get(issue.id);
		assert.ok(managed, "the job has a live worker");

		// Let the worker actually start working, then kill it the way a real crash
		// does: no warning, no shutdown.
		await waitFor(
			() => readRunStatus(home.path, issue.id),
			(status) => status.phase === "working" || status.tool_calls > 0,
			{ timeoutMs: 300_000, intervalMs: 500, what: "the worker to start working" },
		);
		process.kill(first.pid as number, "SIGKILL");

		// The close is OBSERVED — that is what makes it a crash rather than a guess.
		const exit = await managed.worker.closed;
		assert.equal(exit.signal, "SIGKILL");
		recordSpend("e/crash", home.path, issue.id);

		const failure = await post.failures.evaluate(issue.id);
		assert.ok(failure, "an observed non-zero close with no envelope is a failure");
		assert.equal(failure.class, "crash", `classified as ${failure.class}: ${failure.message}`);
		assert.equal(readFleet(home.path).jobs.find((job) => job.job_id === issue.id)?.phase, "failed");

		// The ladder decides; the test does not.
		const decision = decideRecovery({ class: failure.class, attempts: 0, role: "implementer" });
		// `retry_same` is the ladder's word for it (RECOVERY_ACTIONS): same brief,
		// same model, new process. "redispatch" was this test's own invention and
		// never a value the ladder can return.
		assert.equal(decision.action, "retry_same");
		assert.equal(decision.same_brief, true, "a crash re-runs the same brief, never a new plan");
		assert.equal(decision.attempt, 1, "and the attempt is counted, because the ladder is bounded");

		// Re-dispatch: the fleet record is gone (teardown returns the lease first),
		// so this is a fresh lease and a fresh worker for the same job.
		await post.tearDown(issue.id, { force: true });

		// And it is refused until the crashed attempt's branch is dealt with. One
		// job has one branch and it is the job id, so "retry the same brief" is not a
		// bare re-dispatch: the operator returns the lease, removes the leftover
		// branch (nothing was pushed), and only then dispatches again — the sequence
		// the m2 gate performs and preflight's own fix text names.
		await assert.rejects(
			() => post.dispatch({ jobId: issue.id, task, model: LIVE_MODEL }),
			/branch_exists/,
			"a leftover job branch must fail closed, not be silently reused",
		);
		execFileSync("git", ["branch", "-D", issue.id], { cwd: fixture.clone, stdio: "ignore" });

		const second = await post.dispatch({ jobId: issue.id, task, model: LIVE_MODEL });
		assert.equal(second.state, "dispatched");
		assert.notEqual(second.pid, first.pid, "a re-dispatch is a new process");

		await waitForPhase(fixture, issue.id, "held", "the re-dispatched worker's envelope");
		recordSpend("e/retry", home.path, issue.id);
		const record = envelopeOf(home.path, issue.id);
		assert.equal(record.envelope.job_id, issue.id);

		// And the ladder is bounded: a second crash at the cap escalates instead
		// of looping. (Asserted as policy, not by crashing a live worker twice.)
		const capped = decideRecovery({ class: "crash", attempts: 2, role: "implementer", maxAttempts: 2 });
		assert.equal(capped.action, "escalate");

		if (record.envelope.status === "done") {
			const torn = await post.tearDown(issue.id);
			assert.equal(torn.torn_down, true, `teardown refused: ${JSON.stringify(torn)}`);
		} else {
			await post.tearDown(issue.id, { force: true });
		}

		// Classification is a function of the log, so it still holds afterwards.
		const events = readEventLog(home.path, issue.id);
		assert.ok(events.length > 0);
		assert.equal(classifyRun(events, { alive: false })?.class ?? "none", "none", "a reported run is never a failure");
	},
);

// ---------------------------------------------------------------------------
// (f) a planner asks the operator (T31)
// ---------------------------------------------------------------------------

test(
	"live (f): a planner asks the operator, plans with the answer, and never sees the parent's context",
	{ timeout: 900_000, skip: liveSkip() },
	async (t) => {
		const asked: OperatorQuestion[] = [];
		let statusWhileWaiting: string | undefined;
		// The human, scripted. A real operator is the only difference between this
		// and a release run — the dialog, the relay and the journal are the real ones.
		const asker: Asker = {
			async ask(question) {
				asked.push(question);
				// While the planner waits, /status must already say who it is waiting on.
				statusWhileWaiting = formatStatusTable(fixture.post.statusNow());
				return { answer: "SQLite", by: "live suite (unattended)" };
			},
		};
		const fixture = await createLiveFixture({ asker });
		t.after(async () => {
			await fixture.cleanup();
		});
		const { post, home } = fixture;

		const issue = await post.ledger().create({
			title: "plan the cache store",
			project: fixture.project,
			delivery: "pipeline",
			kind: "research",
			slug: "live-f",
		});

		const dispatched = await post.dispatch({
			jobId: issue.id,
			task:
				"Plan a cache for this repository. The store is NOT specified anywhere in the repo and you cannot deduce it: " +
				"use your ask_operator tool exactly once to ask the operator which store to use, with the options Postgres and " +
				"SQLite. Then write the plan and name their choice verbatim in the Constraints section. Do not ask anything else.",
			model: LIVE_MODEL,
		});
		assert.equal(dispatched.receipt, "accepted");

		await waitForPhase(fixture, issue.id, "held", "the planner's envelope");
		recordSpend("f/ask", home.path, issue.id);

		// 1. A real model reached for the tool, and a human was asked once.
		assert.equal(asked.length, 1, `expected exactly one question, got ${asked.length}`);
		assert.equal(asked[0]?.role, "planner");
		assert.ok((asked[0]?.question.length ?? 0) > 0);

		// 2. While it waited, the fleet view named the job that was waiting on us —
		//    a question is a fact with a timestamp, never a fifth phase.
		assert.match(statusWhileWaiting ?? "", /\? asked you \(q1/, statusWhileWaiting ?? "no status captured");

		// 3. The exchange is journaled, both halves, with who answered.
		const journal = post.questions.store.list(issue.id);
		assert.equal(journal.at(-1)?.outcome, "answered");
		assert.equal(journal.at(-1)?.answer, "SQLite");
		assert.match(journal.at(-1)?.answered_by ?? "", /live suite/);
		assert.equal(post.questions.store.open(issue.id), undefined);

		// 4. The answer reached the WORKER: the artifact quotes it. (Test code reads
		//    the file; the parent's context never does — that is the guard's job.)
		assert.ok(post.artifacts.has(issue.id), "the planner must still file an artifact");
		assert.match(
			readFileSync(join(home.path, paths.artifactFile(issue.id)), "utf8"),
			/SQLite/i,
			"the operator's decision must appear in the plan",
		);

		// 5. The envelope is a headline, as always: the answer is not envelope content.
		const record = envelopeOf(home.path, issue.id);
		assert.equal(record.envelope.kind, "research");
		assert.ok(record.envelope.summary.split("\n").length <= 3);

		// 6. And the run log carries the exchange for `/watch`.
		const kinds = readEventLog(home.path, issue.id)
			.filter((event) => event.source === "cp")
			.map((event) => event.type);
		assert.ok(kinds.includes("question_asked"), `no question_asked in ${kinds.join(", ")}`);
		assert.ok(kinds.includes("question_closed"));

		const torn = await post.tearDown(issue.id);
		assert.equal(torn.torn_down, true, `teardown refused: ${JSON.stringify(torn)}`);
		await post.ledger().close(issue.id, "live: planner asked, operator answered, plan written");
	},
);

test("live: spend report", { skip: liveSkip({ needsLedger: false }) }, () => {
	// Runs last (node --test keeps file order) so the operator ends the run with
	// one line per job and a total. A live run that cannot say what it spent is
	// not a test, it is a bill.
	console.log(spendReport());
});
