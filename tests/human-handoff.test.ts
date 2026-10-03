/** merge_policy human_handoff: the policy read, the decision table and the Integrator port (src/human-handoff.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { HANDOFF_PENDING_CAUSES, type HandoffInput, type HandoffWrite, handOffDecision, makeHandoff, mergePolicyOf, reviewThenHandoff } from "../src/human-handoff.ts";
import type { IntegrateResult } from "../src/integrate.ts";
import type { MergePermissionVerdict } from "../src/merge-permission.ts";
import { createScratchHome } from "./harness/index.ts";

const JOB = "cp-aaa1";
const PR = "https://github.com/example/example-app/pull/1";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const registryOf = (policy?: "repo" | "human_handoff") => ({ get: (name: string) => (name === "example-app" ? (policy ? { merge_policy: policy } : {}) : undefined) });
const permitted: MergePermissionVerdict = { permission: "permitted", reason: "CLEAN", facts: [] };

function input(overrides: Partial<HandoffInput> = {}): HandoffInput & { written: HandoffWrite[] } {
	const written: HandoffWrite[] = [];
	return {
		jobId: JOB,
		branch: JOB,
		facts: ["gh: open"],
		prUrl: PR,
		head: HEAD_A,
		project: "example-app",
		at: "permit",
		verdict: permitted,
		write: (w) => {
			written.push(w);
			return { job_id: w.jobId, branch: w.branch, step: w.step, next: w.next, facts: w.facts, reason: w.reason, head_sha: w.headSha, pr_url: w.prUrl } as unknown as IntegrateResult;
		},
		written,
		...overrides,
	};
}

test("mergePolicyOf: absent, unregistered and repo are repo; only human_handoff hands off", () => {
	assert.equal(mergePolicyOf(registryOf(), "example-app"), "repo");
	assert.equal(mergePolicyOf(registryOf("repo"), "example-app"), "repo");
	assert.equal(mergePolicyOf(registryOf("human_handoff"), "ghost"), "repo");
	assert.equal(mergePolicyOf(registryOf("human_handoff"), "example-app"), "human_handoff");
});

test("handOffDecision: permitted and pending reviews/behind/unknown_block hand off; everything else is default", () => {
	assert.deepEqual([...HANDOFF_PENDING_CAUSES], ["reviews", "behind", "unknown_block"]);
	assert.equal(handOffDecision({ permission: "permitted" }), "handoff");
	for (const cause of ["reviews", "behind", "unknown_block"] as const) assert.equal(handOffDecision({ permission: "pending", cause }), "handoff", cause);
	for (const cause of ["checks", "unstable", "conflict", "queue", "draft"] as const) assert.equal(handOffDecision({ permission: "pending", cause }), "default", cause);
	assert.equal(handOffDecision({ permission: "pending" }), "default");
	assert.equal(handOffDecision({ permission: "retry" }), "default");
	assert.equal(handOffDecision({ permission: "unreadable" }), "default");
	assert.equal(handOffDecision(undefined), "default");
});

test("the port: repo changes nothing; a default verdict falls through; fallback surfaces with no row", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const awaiting = new AwaitingStore({ home: home.path });
	let reviewed = 0;
	const review = async () => {
		reviewed += 1;
		return undefined;
	};

	const repo = input({ review });
	assert.equal(await makeHandoff({ registry: registryOf(), awaiting: () => awaiting })(repo), undefined);
	assert.equal(repo.written.length + reviewed, 0, "repo: no write, no review call");

	const port = makeHandoff({ registry: registryOf("human_handoff"), awaiting: () => awaiting });
	const checks = input({ review, verdict: { permission: "pending", cause: "checks", reason: "checks", facts: [] } });
	assert.equal(await port(checks), undefined);
	assert.equal(checks.written.length + reviewed, 0, "a default verdict leaves the existing path to run");

	const fallback = input({ at: "fallback", verdict: undefined });
	const result = await port(fallback);
	assert.deepEqual([result?.step, result?.next], ["permit", "surface"]);
	assert.match(fallback.written[0]?.facts.at(-1) ?? "", /not handed off, no merge checkpoint/);
	assert.equal(awaiting.list().length, 0, "fallback declares no row");
});

test("the port: review first, then one row per PR, updated in place for a new head", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const awaiting = new AwaitingStore({ home: home.path });
	const port = makeHandoff({ registry: registryOf("human_handoff"), awaiting: () => awaiting });

	const unreviewed = { job_id: JOB, next: "review" } as unknown as IntegrateResult;
	const blocked = input({ review: async () => unreviewed });
	assert.equal(await port(blocked), unreviewed, "a review result is returned unchanged");
	assert.equal(blocked.written.length + awaiting.list().length, 0, "no unreviewed head is handed off");

	const first = input({ review: async () => undefined });
	const handed = await port(first);
	assert.deepEqual([handed?.step, handed?.next], ["permit", "surface"]);
	const rows = awaiting.list();
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.subject, `human-review pr ${PR}`);
	assert.match(rows[0]?.decision ?? "", new RegExp(HEAD_A.slice(0, 12)));
	assert.equal(rows[0]?.job_id, JOB);

	await port(input({ head: HEAD_B, verdict: { permission: "pending", cause: "reviews", reason: "reviews", facts: [] }, review: async () => undefined }));
	const after = awaiting.list();
	assert.equal(after.length, 1, "still one row");
	assert.equal(after[0]?.id, rows[0]?.id, "the same row");
	assert.match(after[0]?.decision ?? "", new RegExp(HEAD_B.slice(0, 12)));
});

test("the port: an unreadable registry fails closed — surface, nothing handed off, nothing merged", async () => {
	const port = makeHandoff({
		registry: {
			get: () => {
				throw new Error("data/projects.json is not valid JSON");
			},
		},
	});
	const call = input();
	const result = await port(call);
	assert.equal(result?.next, "surface");
	assert.match(call.written[0]?.reason ?? "", /could not be read.*Nothing was merged/);
});

test("reviewThenHandoff: a review hold wins and the port never runs; otherwise the port decides, absent is a no-op", async () => {
	const hold = { next: "review" } as unknown as IntegrateResult;
	const handed = { next: "surface" } as unknown as IntegrateResult;
	let portCalls = 0;
	const port = async () => {
		portCalls += 1;
		return handed;
	};
	assert.equal(await reviewThenHandoff(async () => hold, port, input({ at: "fallback" })), hold);
	assert.equal(portCalls, 0, "review gate first: the port is not consulted while review holds");
	assert.equal(await reviewThenHandoff(async () => undefined, port, input({ at: "fallback" })), handed);
	assert.equal(portCalls, 1);
	assert.equal(await reviewThenHandoff(async () => undefined, undefined, input({ at: "fallback" })), undefined, "no port wired: nothing changes");
});
