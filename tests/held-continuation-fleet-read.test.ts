import assert from "node:assert/strict";
import test from "node:test";
import { HeldContinuation } from "../src/held-continuation.ts";

// A fleet read that fails mid-continuation must still yield a durable failure notice, not an unhandled rejection.
test("a fleet read failure during a continuation is journaled as a notice, not thrown", async () => {
	let broken = false;
	const notices: { id: string; content: string }[] = [];
	const continuation = new HeldContinuation({
		enabled: () => true,
		fleet: {
			get: () => {
				if (broken) throw new Error("fleet.json is not valid JSON");
				return {
					job_id: "cp-fleet", project: "demo", kind: "ship", delivery: "pr", phase: "held", supersessions: 0,
					reported_at: "2026-01-01T00:00:00Z", receipts: [{ kind: "pr", url: "https://github.com/o/r/pull/1", status: "open" }],
				};
			},
			list: () => [],
		} as never,
		advance: async () => {
			broken = true;
			throw new Error("advance failed");
		},
		review: async () => ({}) as never,
		reviews: { pending: () => undefined, handBack: () => undefined },
		head: () => "a".repeat(40),
		notify: (notice: { id: string; content: string }) => void notices.push(notice),
		relay: (notice: { id: string; content: string }) => void notices.push(notice),
	} as never);
	const outcome = await continuation.trigger({ jobId: "cp-fleet", event: "envelope" } as never);
	assert.equal(outcome.action, "error", outcome.reason);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!.id, /^continuation:cp-fleet:1:error:/);
});
