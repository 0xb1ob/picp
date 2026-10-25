/**
 * The failure classifier and recovery ladder declarations with no e2e entry point, kept verbatim from
 * tests/failures.test.ts; docs/testing-migration/p8d.md maps the rest to 04-17..04-25.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isoTimestamp, type RunEvent } from "../src/contracts.ts";
import { classifyRun, decideRecovery, MAX_RECOVERY_ATTEMPTS, mayRerunResearch, readModelCallError } from "../src/failures.ts";

let seq = 0;
function event(type: string, payload: Record<string, unknown> = {}, source: "pi" | "cp" = "pi", ts?: string): RunEvent {
	seq += 1;
	return { seq, ts: ts ?? isoTimestamp(), job_id: "cp-x", source, type, payload };
}

function assistantMessage(text: string): RunEvent {
	return event("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
}

test("spawn_failed: the child never emitted a single event", () => {
	const events = [event("spawned", {}, "cp"), event("process_exit", { code: 2 }, "cp")];
	assert.equal(classifyRun(events)?.class, "spawn_failed");
});

test("agent_empty_output: settled with nothing to show", () => {
	const events = [event("spawned", {}, "cp"), event("agent_start"), event("agent_settled")];
	assert.equal(classifyRun(events)?.class, "agent_empty_output");

	// text output is not empty output
	const withText = [
		event("spawned", {}, "cp"),
		event("agent_start"),
		assistantMessage("here is what I found"),
		event("agent_settled"),
	];
	assert.equal(classifyRun(withText), undefined);
});

/**
 * Verbatim shape from `state/runs/cp-1l2s/events.jsonl` (2026-09-04): pi ran
 * the loop, the assistant message came back `stopReason: "error"` with the
 * provider's words and zero tokens, and the run settled two seconds after it
 * started. Four workers did this in one session; every prompt sent at them
 * produced another one of these.
 */
function failedModelCall(errorMessage = "401 Invalid API key"): Record<string, unknown> {
	return {
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "error",
			errorMessage,
		},
	};
}

test("readModelCallError reads pi's own words, and nothing that merely looks like them", () => {
	const errored = event("message_end", failedModelCall());
	assert.deepEqual(readModelCallError(errored), {
		message: "401 Invalid API key",
		provider: "anthropic",
		model: "claude-opus-5",
	});

	// A worker talking about a 401 is not a failed model call.
	assert.equal(readModelCallError(assistantMessage("the API returned 401 Invalid API key")), undefined);
	// Neither is a user message, a tool result, or a cp marker.
	assert.equal(readModelCallError(event("message_end", { message: { role: "user", stopReason: "error" } })), undefined);
	assert.equal(readModelCallError(event("failure", { class: "crash" }, "cp")), undefined);
	// An error with no message still names itself rather than inventing a cause.
	const blank = event("message_end", { message: { role: "assistant", stopReason: "error" } });
	assert.match(readModelCallError(blank)?.message ?? "", /error with no message/);
});

test("timeout: silence past the deadline, and only while unsettled", () => {
	const old = "2026-01-01T00:00:00Z";
	const events = [event("spawned", {}, "cp", old), event("agent_start", {}, "pi", old)];
	const now = new Date("2026-01-01T01:00:00Z");
	assert.equal(classifyRun(events, { now, inactivityMs: 60_000 })?.class, "timeout");
	assert.equal(classifyRun(events, { now, inactivityMs: 24 * 3600_000 }), undefined, "inside the deadline is fine");

	const settled = [...events, event("agent_settled", {}, "pi", old), assistantMessage("done")];
	assert.equal(classifyRun(settled, { now, inactivityMs: 60_000 }), undefined, "a settled run is not a timeout");
});

test("recovery: recoverable classes retry the same brief, bounded", () => {
	for (const failureClass of ["crash", "timeout", "agent_empty_output"] as const) {
		const first = decideRecovery({ class: failureClass, role: "implementer", attempts: 0 });
		assert.equal(first.action, "retry_same", failureClass);
		assert.equal(first.same_brief, true, "an implementer crash is re-dispatched with the SAME brief");

		const exhausted = decideRecovery({ class: failureClass, role: "implementer", attempts: MAX_RECOVERY_ATTEMPTS });
		assert.equal(exhausted.action, "escalate");
		assert.match(exhausted.reason, /instead of looping/);
	}
});

test("recovery: unrecoverable classes never retry", () => {
	for (const failureClass of ["tool_loop", "budget_exceeded", "spawn_failed", "wall_clock_exceeded", "tool_call_cap_exceeded"] as const) {
		const decision = decideRecovery({ class: failureClass, role: "implementer", attempts: 0 });
		assert.equal(decision.action, "escalate", failureClass);
		assert.match(decision.reason, /not recoverable by policy/);
	}
	assert.equal(decideRecovery({ class: "envelope_invalid", role: "planner", attempts: 0 }).action, "escalate");
});

test("recovery: provider limits retry the same model, then a fallback", () => {
	const same = decideRecovery({ class: "provider_limit", role: "planner", attempts: 0 });
	assert.equal(same.action, "retry_same");

	// cp-eff: no fallback model exists to try, so a persisting limit keeps
	// retrying the same model until the cap, then escalates to a human.
	const persisting = decideRecovery({ class: "provider_limit", role: "planner", attempts: 1 });
	assert.equal(persisting.action, "retry_same");

	const noFallback = decideRecovery({ class: "provider_limit", role: "planner", attempts: 1 });
	assert.equal(noFallback.action, "retry_same");

	const capped = decideRecovery({ class: "provider_limit", role: "planner", attempts: 2 });
	assert.equal(capped.action, "escalate");
});

test("an implementation failure never re-runs the research that preceded it", () => {
	assert.equal(mayRerunResearch("implementer", "planner"), false);
	assert.equal(mayRerunResearch("planner", "planner"), true);
	assert.equal(mayRerunResearch("implementer", "implementer"), true);
	assert.equal(mayRerunResearch("planner", "implementer"), true);
});
