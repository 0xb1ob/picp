import assert from "node:assert/strict";
import test from "node:test";
import { paths } from "../../src/contracts.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { run, SKIP, startStack } from "./landing-helpers.ts";

// A complete cp_review escalate/policy below the cap used to send cp_integrate back to `review` forever.
// Now it surfaces one escalation; only an operator quote naming it clears that exact head, and a push voids it.
for (const mode of ["approve", "push"] as const) {
	test(`review policy escalation: ${mode}`, { skip: SKIP, timeout: 240_000 }, async (t) => {
		const s = await startStack(t);
		const live = await s.held(`policy escalation ${mode}`, 231);
		writeWindowPass(s.home, live.jobId, live.head, "2026-01-01T00:00:00Z", { verdict: "escalate", cause: "policy", model: "mock/reviewer", reasons: ["policy: scope looks wrong"] });
		s.setGh({ integration: true, runs: [run(231, live.head, "completed", "success")] });
		const escalations = new EscalationStore({ home: s.home });

		const surfaced = await s.post.integrate({ jobId: live.jobId });
		assert.deepEqual([surfaced.step, surfaced.next], ["review", "surface"], JSON.stringify(surfaced));
		const [raised, ...extra] = escalations.list({ jobId: live.jobId });
		assert.equal(extra.length, 0);
		assert.deepEqual([raised?.kind, raised?.status, raised?.evidence_paths], ["conflicting_acceptance", "open", [paths.reviewFile(live.jobId, 1)]]);
		assert.match(surfaced.reason, new RegExp(raised!.id));
		assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
		assert.equal(escalations.list({ jobId: live.jobId }).length, 1, "a repeated integrate reuses the one escalation");

		if (mode === "approve") {
			const refused = await s.parent("Ship the policy escalation anyway.", [
				{ kind: "tool_calls", calls: [
					{ name: "cp_decide", args: { target: raised!.id, decision: "approve", basis: { mandate: "md-abcd", clause: "merge reviewed work" } } },
					{ name: "cp_decide", args: { target: raised!.id, decision: "approve", basis: { operator_quote: "Ship the policy escalation anyway." } } },
				] },
				{ kind: "text", text: "Not authorized." },
			]);
			const replies = refused.filter((event) => event.toolName === "cp_decide");
			assert.equal(replies.length, 2);
			assert.ok(replies.every((event) => event.isError), "a mandate or a quote that does not name the escalation is refused");
			assert.equal(escalations.get(raised!.id)?.status, "open");
			assert.equal((await s.post.integrate({ jobId: live.jobId })).next, "surface");
		}

		const quote = `Approve ${raised!.id} for this head.`;
		const decided = await s.parent(quote, [
			{ kind: "tool_calls", calls: [{ name: "cp_decide", args: { target: raised!.id, decision: "approve", basis: { operator_quote: quote } } }] },
			{ kind: "text", text: "Approved." },
		]);
		assert.ok(decided.filter((event) => event.toolName === "cp_decide").every((event) => !event.isError), JSON.stringify(decided));
		assert.deepEqual([escalations.get(raised!.id)?.status, escalations.get(raised!.id)?.answered_by], ["answered", "operator-quote"]);

		if (mode === "push") {
			s.repo.git("-C", live.worktree, "commit", "--allow-empty", "-m", "later push");
			s.repo.git("-C", live.worktree, "push", "origin", live.jobId);
			const moved = s.repo.git("ls-remote", "origin", `refs/heads/${live.jobId}`).split("\t")[0]!.trim();
			s.setGh({ runs: [run(232, moved, "completed", "success")] });
			const voided = await s.post.integrate({ jobId: live.jobId });
			assert.deepEqual([voided.step, voided.next], ["review", "review"], JSON.stringify(voided));
			assert.equal(escalations.list({ jobId: live.jobId }).length, 1, "the moved head inherits nothing and raises nothing");
			assert.ok(!s.ghCalls().some((call) => call.startsWith("pr merge")), "an approval for another head never merges");
			return;
		}
		const merged = await s.post.integrate({ jobId: live.jobId });
		assert.equal(merged.step, "merge", JSON.stringify(merged));
		assert.ok(merged.facts.some((fact) => fact.includes(`approved on an operator quote (${raised!.id})`)));
		assert.ok(s.ghCalls().some((call) => call.startsWith("pr merge") && call.includes(live.head)), "merge bound to the approved head");
	});
}
