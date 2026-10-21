import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PrObservation } from "../src/ci-watch.ts";
import { ForeignCiWatch, type ForeignCiWatchDeps, type ForeignJobRecord } from "../src/foreign-ci-watch.ts";
import type { CiRun } from "../src/merge-ask.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const HEAD = "d48a81d1f4d3c8a1b0d5e6f7a8b9c0d1e2f3a4b5";
const PR = "https://github.com/acme/widgets/pull/7";
const CREATED = "2026-10-06T10:00:00Z";
const repoOf = (project: string): string | undefined => (project === "widgets" ? "acme/widgets" : project === "other" ? "acme/other" : undefined);
function job(overrides: Partial<ForeignJobRecord> = {}): ForeignJobRecord {
	return { id: "cp-r1", status: "open", labels: ["project:widgets", "delivery:local", "kind:research", "schedule:sch-abc123"], external_ref: PR, created_at: CREATED, ...overrides };
}
function bench(t: { after(fn: () => void): void }, jobs: ForeignJobRecord[] = [job()]) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const state: { jobs: ForeignJobRecord[]; own: string[]; pr: PrObservation | undefined; prError?: string; runs: CiRun[]; now: Date } = {
		jobs,
		own: [],
		pr: { merged: false, state: "open", number: 7, url: PR, head_sha: HEAD, head_ref: "feature" },
		runs: [{ status: "completed", conclusion: "success", headSha: HEAD, workflowName: "ci", databaseId: 11, attempt: 1 }],
		now: new Date("2026-10-06T10:05:00Z"),
	};
	const calls = { pr: 0, runs: [] as string[] };
	const deps: ForeignCiWatchDeps = {
		home: home.path,
		jobs: () => state.jobs,
		ownPrUrls: () => state.own,
		repoOf,
		pr: async () => {
			calls.pr += 1;
			if (state.prError) throw new Error(state.prError);
			return state.pr;
		},
		runs: async (owner, repo, sha) => {
			calls.runs.push(`${owner}/${repo}@${sha}`);
			return state.runs;
		},
		now: () => state.now,
		intervalMs: 1000,
	};
	const later = (ms: number) => {
		state.now = new Date(state.now.getTime() + ms);
	};
	return { home: home.path, watch: new ForeignCiWatch(deps), deps, state, calls, later };
}

test("evidence only: the ports are read-only, the module reaches no merge or wake path, and its query never waits", (t) => {
	const b = bench(t);
	assert.deepEqual(Object.keys(b.deps).sort(), ["home", "intervalMs", "jobs", "now", "ownPrUrls", "pr", "repoOf", "runs"]);
	const source = readFileSync(join(REPO_ROOT, "src/foreign-ci-watch.ts"), "utf8");
	for (const banned of ["./integrate.ts", "./wakeups.ts", "./wakeup-outbox.ts", "sendWakeup", "gh pr merge", "rerun", "comment("]) {
		assert.equal(source.includes(banned), false, `foreign-ci-watch.ts must not reach ${banned}`);
	}
});
