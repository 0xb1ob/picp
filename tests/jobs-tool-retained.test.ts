/**
 * portsFor's hasLiveWorker over every fleet phase: launching and awaiting_merge records need a script or a parking
 * record no cp_job scenario can seed, so the phase table stays a unit. Verbatim from jobs-tool.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { portsFor } from "../extensions/command-post/jobs.ts";
import { JOB_PHASES, type Runtime } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { createScratchLedger } from "./harness/index.ts";

const MULTI_RUNTIME: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "test" };

function ports(t: { after(fn: () => void): void }) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	return { scratch };
}

test("portsFor's hasLiveWorker: launching has no worker; waiting/held do, done/failed do not", (t) => {
	const { scratch } = ports(t);
	const live: Record<string, string | undefined> = {
		"cp-waiting": "waiting",
		"cp-held": "held",
		"cp-awaiting_merge": "awaiting_merge",
		"cp-done": "done",
		"cp-failed": "failed",
	};
	const fakePost = {
		ledger: () => scratch.ledger,
		escalations: new EscalationStore({ home: scratch.path }),
		fleet: { get: (id: string) => (live[id] ? { phase: live[id] } : undefined) },
	} as never;
	const p = portsFor(fakePost, MULTI_RUNTIME);
	assert.deepEqual(
		JOB_PHASES.map((phase) => p.hasLiveWorker(`cp-${phase}`)),
		[false, true, true, false, false, false],
		"launching has no process; waiting and held hold one; awaiting_merge, done and failed do not",
	);
	assert.equal(p.hasLiveWorker("cp-never-dispatched"), false, "no fleet record at all is not a live worker");
});
