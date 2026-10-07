import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { CiWatch, isWatched } from "../src/ci-watch.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { HeldContinuation } from "../src/held-continuation.ts";
import { FleetStore } from "../src/fleet.ts";
import { Integrator, type IntegrateResult } from "../src/integrate.ts";
import { IntegrationHolds } from "../src/integration-hold.ts";
import { EnvelopeIntake } from "../src/intake.ts";
import { MandateStore } from "../src/mandate.ts";
import { MergeStore, type CommandRunner } from "../src/merges.ts";
import { ParentCompactHold } from "../src/parent-compact-hold.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { createScratchHome, fakeWorkerManager } from "./harness/index.ts";

const JOB = "cp-held-ci";
const PR = "https://github.com/o/r/pull/61";
const A = "a".repeat(40);
const B = "b".repeat(40);

async function bench(t: TestContext) {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const fakes = fakeWorkerManager(home.path, 3);
	const worker = fakes.spawn(JOB);
	const worktree = join(home.path, "worktree");
	mkdirSync(worktree);
	const dispatched = isoTimestamp(new Date(Date.now() - 60_000));
	await fleet.add({
		job_id: JOB, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN,
		phase: "waiting", worktree, branch: JOB, dispatched_at: dispatched, usage: EMPTY_USAGE,
		worker: { pid: worker.pid, session_id: "same-session", session_file: join(home.path, "session.jsonl"), model: "mock/unused", profile: "implementer", role: "implementer", started_at: dispatched },
	});
	const holds = new IntegrationHolds(home.path);
	const hold = holds.hold(JOB, "QA in progress");
	const mandates = new MandateStore(home.path);
	let revivalCalls = 0;
	const sender = new Sender({ home: home.path, fleet, runs, manager: fakes.manager, mandates,
		released: () => true, revive: async () => { revivalCalls++; },
	});
	const world = { head: A, conclusion: "failure" };
	const commands: string[] = [];
	const results: IntegrateResult[] = [];
	const notices: string[] = [];
	const run: CommandRunner = async (_cwd, bin, args) => {
		commands.push(`${bin} ${args.join(" ")}`);
		let value: unknown;
		if (bin === "gh" && args[0] === "pr" && args[1] === "view") value = { number: 61, url: PR, state: "OPEN", headRefName: JOB, headRefOid: world.head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main" };
		else if (bin === "gh" && args[0] === "run" && args[1] === "list") value = [{ status: "completed", conclusion: world.conclusion, headSha: world.head, workflowName: "ci", databaseId: 77 }];
		else if (bin === "git" && args[0] === "ls-remote") return { status: 0, stdout: `${world.head}\trefs/heads/${JOB}\n`, stderr: "" };
		else if (bin === "git" && args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
		else throw new Error(`unexpected command: ${commands.at(-1)}`);
		return { status: 0, stdout: JSON.stringify(value), stderr: "" };
	};
	const makeIntegrator = () => new Integrator({
		home: home.path, fleet, runs, run, projectDir: () => home.path,
		merges: new MergeStore({ home: home.path, fleet, runs, run }),
		teardown: { teardown: async () => { throw new Error("held teardown"); } },
		ledger: () => ({ close: async () => { throw new Error("held close"); } }),
		awaiting: () => new AwaitingStore({ home: home.path }),
		infraRerun: async () => { throw new Error("held infrastructure rerun"); },
		send: async (jobId, message) => sender.send({ jobId, message, purpose: "repair" }),
	});
	let integrator = makeIntegrator();
	const makeContinuation = () => new HeldContinuation({
		enabled: () => true, fleet, runs,
		advance: async (jobId) => { const result = await integrator.advance({ jobId }); results.push(result); return result; },
		review: async () => { throw new Error("held review"); },
		reviews: { pending: () => undefined, handBack: async () => { throw new Error("held handback"); } },
		head: () => world.head, notify: (notice) => notices.push(notice.content),
	});
	let continuation = makeContinuation();
	const intake = new EnvelopeIntake({ home: home.path, fleet, runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onReported: (result) => continuation.onEnvelope(result),
	});
	const report = async () => {
		writeFileSync(join(home.path, paths.envelopeFile(JOB)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: JOB, received_at: isoTimestamp(), attempt: 1,
			envelope: { job_id: JOB, kind: "ship", status: "done", summary: "Repair delivered", branch: JOB, pr_url: PR, head_sha: world.head },
		}));
		return intake.intake(JOB);
	};
	// Use a separate initial intake so the initial held report does not race setup.
	writeFileSync(join(home.path, paths.envelopeFile(JOB)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: JOB, received_at: isoTimestamp(), attempt: 1,
		envelope: { job_id: JOB, kind: "ship", status: "done", summary: "Initial delivery", branch: JOB, pr_url: PR, head_sha: A },
	}));
	const initial = new EnvelopeIntake({ home: home.path, fleet, runs, fail: (jobId, failure) => fleet.markFailed(jobId, failure) });
	assert.equal((await initial.intake(JOB)).accepted, true);
	const watch = new CiWatch({ home: home.path, jobs: () => fleet.list(),
		pr: async () => ({ state: "open", merged: false, number: 61, url: PR, head_sha: world.head, head_ref: JOB }),
		runs: async () => [{ status: "completed", conclusion: world.conclusion, headSha: world.head, workflowName: "ci", databaseId: 77 }],
		onObserved: (jobId, observation) => continuation.onCi(jobId, observation),
	});
	const settle = () => continuation.serialize(JOB, async () => {});
	t.after(async () => { continuation.stop(); await fakes.manager.shutdownAll(); runs.closeAll(); home.cleanup(); });
	return { home: home.path, fleet, worker, fakes, holds, hold, mandates, world, results, notices, commands, report, settle,
		get integrator() { return integrator; }, get continuation() { return continuation; }, watch,
		revivalCalls: () => revivalCalls,
		restart: () => { continuation.stop(); integrator = makeIntegrator(); continuation = makeContinuation(); },
	};
}

function heldOnly(b: Awaited<ReturnType<typeof bench>>) {
	assert.deepEqual(b.holds.get(JOB), b.hold);
	assert.ok(b.commands.every((command) => command.startsWith("gh pr view ") || command.startsWith("gh run list ")), b.commands.join("\n"));
	assert.equal(new CheckpointStore(b.home, { kind: "merge" }).list().length, 0);
	assert.equal(new AwaitingStore({ home: b.home }).list().length, 0);
}

test("CI observation repairs without parent notice delivery; duplicates and manual integration share the project lane", { timeout: 15_000 }, async (t) => {
	const b = await bench(t);
	const identity = b.fleet.require(JOB);
	let enter!: () => void;
	let resume!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const release = new Promise<void>((resolve) => { resume = resolve; });
	b.worker.send = async (message) => { enter(); await release; b.worker.sent.push(message); return { receipt: "delivered" }; };
	t.after(() => resume());
	const compact = new ParentCompactHold();
	compact.turnEnded({ over: true, raw: 200_000, effective: 200_000, threshold: 200_000 });
	let parentDelivered = 0;
	const tick = await b.watch.tick();
	for (const observation of tick.observations) {
		assert.equal(compact.offer(() => { parentDelivered++; b.watch.confirm([observation.key]); }), "hold");
	}
	await entered;
	const fact = tick.observations.find((observation) => observation.event === "ci_failed")!;
	assert.equal(fact.run_id, 77);
	const duplicate = await b.continuation.trigger({ jobId: JOB, event: "ci_failed", head: A, run: fact.run_identity, generation: 1 });
	assert.equal(duplicate.action, "coalesced");
	const direct = await b.integrator.advance({ jobId: JOB });
	assert.equal(direct.next, "wait");
	assert.equal(b.integrator.promoting(JOB), true);
	let manualStarted = false;
	const manual = b.continuation.serialize(JOB, async () => { manualStarted = true; return b.integrator.advance({ jobId: JOB }); });
	let projectLaneStarted = false;
	await b.fleet.add({ ...identity, job_id: "cp-held-peer", branch: "cp-held-peer" });
	const peer = b.continuation.serialize("cp-held-peer", async () => { projectLaneStarted = true; });
	assert.equal(manualStarted || projectLaneStarted, false);
	resume();
	assert.equal((await manual).next, "wait");
	await peer;
	await b.settle();
	assert.equal(manualStarted && projectLaneStarted, true);
	assert.equal(b.worker.sent.length, 1);
	assert.equal(parentDelivered, 0, "repair did not need a parent turn or notice arrival");
	compact.compacted();
	assert.equal(parentDelivered, tick.observations.length);
	assert.match(b.worker.sent[0]!, /run 77/);
	assert.match(b.worker.sent[0]!, /integration hold remains active/);
	assert.equal(b.results[0]?.next, "resolve");
	assert.equal(b.results[0]?.record.resolve_attempts, 1);
	const reopened = b.fleet.require(JOB);
	assert.equal(reopened.phase, "waiting");
	assert.equal(reopened.reported_at, undefined);
	assert.equal(reopened.supersessions, 1);
	assert.deepEqual(reopened.worker, identity.worker);
	assert.equal(reopened.branch, identity.branch);
	assert.equal(reopened.worktree, identity.worktree);
	assert.equal(isWatched(reopened), false);
	assert.equal(existsSync(join(b.home, paths.envelopeFile(JOB))), false);
	assert.ok(existsSync(join(b.home, paths.supersededEnvelopeFile(JOB, 1))));
	assert.ok(b.notices.some((notice) => notice.includes("resolve")));
	assert.equal((await b.continuation.trigger({ jobId: JOB, event: "envelope", generation: 1, head: A })).action, "stale");
	b.world.head = B;
	b.world.conclusion = "success";
	assert.equal((await b.report()).generation, 2);
	await b.settle();
	assert.equal(b.results.at(-1)?.next, "wait");
	assert.equal(b.results.at(-1)?.record.resolve_attempts, 1);
	assert.equal(isWatched(b.fleet.require(JOB)), true);
	heldOnly(b);
	b.holds.release(JOB);
	const released = await b.integrator.advance({ jobId: JOB });
	assert.equal(released.next, "review", "new green head still needs current-head review after release");
	assert.equal(b.worker.sent.length, 1);
});

test("startup repair and restart preserve the cumulative allowance after repaired green and failing reports", async (t) => {
	const b = await bench(t);
	assert.equal((await b.continuation.resume())[0]?.next, "resolve");
	assert.equal(b.worker.sent.length, 1);
	b.world.head = B;
	b.world.conclusion = "success";
	assert.equal((await b.report()).accepted, true);
	await b.settle();
	b.restart();
	assert.equal((await b.continuation.resume())[0]?.next, "wait");
	assert.equal(b.results.at(-1)?.record.resolve_attempts, 1);
	b.world.conclusion = "failure";
	b.restart();
	assert.equal((await b.continuation.resume())[0]?.next, "surface");
	assert.equal(b.results.at(-1)?.record.resolve_attempts, 1);
	assert.equal(b.worker.sent.length, 1);
	heldOnly(b);
});

test("held repair uses real Sender permission before delivery or revival, including eligible expired grants", async (t) => {
	for (const mode of ["revoked", "capped", "expired", "missing", "dead"]) {
		const b = await bench(t);
		const grant = b.mandates.issue({ projects: ["demo"], objective: "repair held CI", expiry: isoTimestamp(new Date(Date.now() - 1_000)), at: isoTimestamp(new Date(Date.now() - 120_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 });
		if (mode === "revoked") b.mandates.revoke(grant.id);
		if (mode === "capped") b.mandates.save({ ...b.mandates.require(grant.id), status: "paused", pause_reason: "spend_cap", paused_at: isoTimestamp() });
		if (mode === "revoked" || mode === "capped" || mode === "missing") await b.fakes.manager.shutdownAll();
		if (mode === "dead") b.worker.alive = false;
		const outcome = (await b.continuation.resume())[0];
		assert.equal(outcome?.next, mode === "expired" ? "resolve" : "surface", mode);
		assert.equal(b.worker.sent.length, mode === "expired" ? 1 : 0, mode);
		assert.equal(b.results.at(-1)?.record.resolve_attempts, mode === "expired" ? 1 : 0, mode);
		if (mode === "revoked" || mode === "capped") {
			assert.equal(b.revivalCalls(), 0);
			assert.match(b.results.at(-1)?.resolve_error ?? "", mode === "revoked" ? /is revoked/ : /is paused \(spend_cap\)/);
			assert.equal(b.fleet.require(JOB).phase, "held");
			assert.equal(JSON.parse(readFileSync(join(b.home, paths.envelopeFile(JOB)), "utf8")).envelope.head_sha, A);
		}
		if (mode === "dead" || mode === "missing") assert.match(b.results.at(-1)?.resolve_error ?? "", /no live worker/);
		heldOnly(b);
	}
});
