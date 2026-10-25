/** awaiting_merge: cp_send's resume of a parked job through a stub coordinator, and revive's refusal of a parked job. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { ResumeError } from "../src/awaiting-merge.ts";
import { EMPTY_USAGE, type FleetRecord } from "../src/contracts.ts";
import { drainFile } from "../src/drain.ts";
import { FleetStore } from "../src/fleet.ts";
import { Reviver } from "../src/revive.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender, SendError } from "../src/send.ts";
import { MandateStore } from "../src/mandate.ts";
import { createScratchHome, type FakeWorker, fakeWorkerManager } from "./harness/index.ts";

const AT = "2026-10-15T10:00:00Z";

function parked(): FleetRecord {
	return {
		job_id: "cp-park", project: "demo", kind: "ship", delivery: "pr", origin: "terminal", phase: "awaiting_merge",
		worker: { pid: 4242, session_id: "s", session_file: "/nonexistent/s.jsonl", profile: "implementer", role: "implementer", model: "m/m", started_at: AT, exited_at: AT, exit_code: 0 },
		worktree: "/wt/old", branch: "cp-park", dispatched_at: AT, reported_at: AT, usage: EMPTY_USAGE,
		awaiting_merge: { cycle: 1, pr_url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "cp-park", head_sha: "a".repeat(40), base: "main",
			handed_at: AT, released_at: AT, frozen_seconds: 60, frozen_usage: EMPTY_USAGE },
	};
}

interface Options { spawn?: boolean; fail?: boolean; mandates?: (home: string) => MandateStore }

async function bench(t: { after(fn: () => void | Promise<void>): void }, options: Options = {}) {
	const home = createScratchHome();
	const runs = new RunRegistry(home.path);
	const fleet = new FleetStore({ home: home.path });
	const workers = fakeWorkerManager(home.path, 3);
	t.after(async () => {
		await workers.manager.shutdownAll();
		runs.closeAll();
		home.cleanup();
	});
	await fleet.add(parked());
	const calls: string[] = [];
	let worker: FakeWorker | undefined;
	const sender = new Sender({
		fleet, manager: workers.manager, runs, home: home.path,
		...(options.mandates ? { mandates: options.mandates(home.path) } : {}),
		// The park journaled held_released; a stale "released" answer must still never trigger a second revive.
		released: () => true,
		revive: async (id) => {
			calls.push(`revive ${id}`);
		},
		resume: async (id) => {
			calls.push(`resume ${id}`);
			if (options.fail) throw new ResumeError("lease_failed", `${id}: treehouse refused; it stays parked`);
			await fleet.mutate((jobs) => {
				const job = jobs.find((candidate) => candidate.job_id === id)!;
				job.phase = "held";
				job.worktree = "/wt/new";
				delete job.awaiting_merge;
				delete job.worker.exited_at;
				delete job.worker.exit_code;
			});
			if (options.spawn !== false) worker = workers.spawn(id);
			return { note: "[resumed from awaiting_merge] NOTE" };
		},
	});
	return { home: home.path, fleet, sender, calls, worker: () => worker };
}

test("Sender resume: the coordinator's note leads the delivered message and the job leaves awaiting_merge", async (t) => {
	const b = await bench(t);
	const result = await b.sender.send({ jobId: "cp-park", message: "address the review" });
	assert.equal(result.receipt, "delivered");
	assert.deepEqual(b.calls, ["resume cp-park"]);
	assert.equal(b.worker()?.sent[0]?.startsWith("[resumed from awaiting_merge] NOTE\n\naddress the review"), true);
	assert.notEqual(b.fleet.require("cp-park").phase, "awaiting_merge");
});

// Regression (send.ts kept the pre-resume record): with no live worker after resume, the refusal reads the resumed
// record (held, not awaiting_merge), and the HeldRelease restore path never revives the just-resumed worker again.
test("Sender resume: after resume the send reads the re-read record and never restores a released worker", async (t) => {
	const b = await bench(t, { spawn: false });
	await assert.rejects(b.sender.send({ jobId: "cp-park", message: "go" }), (error: unknown) => {
		assert.ok(error instanceof SendError);
		assert.match(error.message, /fleet phase held/);
		return true;
	});
	assert.deepEqual(b.calls, ["resume cp-park"], "no second revive through the released path");
});

test("Sender resume: the mandate's repair permission is checked first, whatever the purpose", async (t) => {
	const refused = await bench(t, { mandates: (home) => {
		const store = new MandateStore(home);
		const grant = store.issue({ projects: ["demo"], objective: "Parked repair", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 100000 }, job_cap: 1 });
		store.pause(grant.id, "spend_cap");
		return store;
	} });
	await assert.rejects(refused.sender.send({ jobId: "cp-park", message: "go" }), (error: unknown) => error instanceof SendError && /paused/.test(error.message));
	assert.deepEqual(refused.calls, [], "a refused grant never resumes");
	assert.equal(refused.fleet.require("cp-park").phase, "awaiting_merge");
});

test("Sender resume: a drain refuses before the coordinator runs", async (t) => {
	const b = await bench(t);
	mkdirSync(dirname(drainFile(b.home)), { recursive: true });
	writeFileSync(drainFile(b.home), JSON.stringify({ state: "draining", started_at: AT, deadline: "x", timeout_s: 1, jobs: [] }));
	await assert.rejects(b.sender.send({ jobId: "cp-park", message: "go" }), /draining for a restart.*resume of parked cp-park/s);
	assert.deepEqual(b.calls, []);
	assert.equal(b.fleet.require("cp-park").phase, "awaiting_merge");
});

test("Sender resume: a coordinator refusal surfaces as a SendError and nothing is sent", async (t) => {
	const b = await bench(t, { fail: true });
	await assert.rejects(b.sender.send({ jobId: "cp-park", message: "go" }), (error: unknown) => {
		assert.ok(error instanceof SendError);
		assert.match(error.message, /resume from awaiting_merge refused — cp-park: treehouse refused; it stays parked\. Nothing was sent\./);
		return true;
	});
	assert.equal(b.fleet.require("cp-park").phase, "awaiting_merge");
	assert.equal(b.sender.sending("cp-park"), false);
});

test("revive refuses an awaiting_merge job and names cp_send as the resume path", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const fleet = new FleetStore({ home: home.path });
	await fleet.add(parked());
	const reviver = new Reviver({ home: home.path, fleet } as never);
	const plan = await reviver.plan("cp-park");
	assert.equal(plan.ok, false);
	assert.equal(!plan.ok && plan.code, "not_revivable_phase");
	assert.match(!plan.ok ? plan.message : "", /cp_send cp-park resumes it on a fresh lease/);
	assert.equal((await reviver.plan("cp-park", { recovering: true, continueFailed: true })).ok, false, "no option revives on the old path");
	await assert.rejects(reviver.revive("cp-park"), /cannot revive cp-park \(not_revivable_phase\)/);
	assert.equal(fleet.require("cp-park").phase, "awaiting_merge");
});
