import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { readDrain } from "../../src/drain.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { JOB, seedHeldHome } from "../harness/held-home.ts";
import { FleetStore } from "../../src/fleet.ts";

for (const [timeout, name] of [
	[false, "S26: real diff reviewer settles before drain completes"],
	[true, "S26: real diff reviewer survives drain timeout"],
] as const) {
	test(name, { timeout: 90_000 }, async (t) => {
		const s = await seedHeldHome({ ciState: "in_progress", review: "none" });
		const fleet = new FleetStore({ home: s.home.path });
		await fleet.patch(JOB, { lease_id: "lease-7" });
		await fleet.add({ ...fleet.get(JOB)!, job_id: "cp-done", branch: "cp-done", phase: "done" });
		mkdirSync(join(s.home.path, paths.runDir(JOB)), { recursive: true });
		writeFileSync(join(s.home.path, paths.envelopeFile(JOB)), JSON.stringify({ received_at: "2026-09-27T12:00:00Z", envelope: { head_sha: s.headSha } }));
		const provider = await MockProvider.start();
		const agent = createAgentDir({ provider });
		const siblingModel = provider.addScript("s26-sibling", [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
		const reviewer = provider.addScript("s26-review", [
			{ kind: "error", status: 503, message: "transient reviewer outage", repeat: 2 },
			{ kind: "tool_calls", calls: [{ name: "report_verdict", args: { job_id: JOB, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["reviewed complete subject"] } }] },
		]);
		const model = provider.addScript("s26-review-parent", [
			{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: JOB, model: reviewer } }] },
			{ kind: "text", text: "review started" },
			{ kind: "text", text: "review wake received" },
		]);
		agent.writeModels(provider);
		mkdirSync(join(s.home.path, LAYOUT.data), { recursive: true });
		writeFileSync(join(s.home.path, LAYOUT.data, "routing.json"), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [] }));
		const child = startPiChild({ cwd: s.home.path, model, extensions: [COMMAND_POST_EXTENSION], env: { ...agent.env, CP_HOME: s.home.path, PATH: `${s.bin}:${process.env.PATH}` } });
		t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); s.repo.cleanup(); s.home.cleanup(); });
		await child.prompt("Review the held change using cp_review.");
		await waitFor(() => provider.requests("s26-review").length > 0, Boolean, { timeoutMs: 30_000, what: "real reviewer request" });
		await child.prompt(timeout ? "/cp-drain 0" : "/cp-drain 30");
		await child.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 15_000);
		if (timeout) await waitFor(() => readDrain(s.home.path), (record) => record?.state === "timeout", { timeoutMs: 12_000, what: "timeout tick" });
		const state = readDrain(s.home.path)!;
		assert.deepEqual(state.jobs, [{ job_id: JOB, phase: "held", lease: "lease-7", head: s.headSha }]);
		if (timeout) {
			assert.equal(state.state, "timeout");
			assert.deepEqual(state.survivors, ["cp-held#review-1"]);
			await child.prompt("/cp-drain-cancel");
		} else {
			assert.equal(state.state, "draining");
			const sibling = startPiChild({ cwd: s.home.path, model: siblingModel, extensions: [COMMAND_POST_EXTENSION], env: { ...agent.env, CP_HOME: s.home.path, PATH: `${s.bin}:${process.env.PATH}` } });
			t.after(() => sibling.close());
			await sibling.prompt("/cp-drain 0");
			const refusal = await sibling.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 15_000);
			assert.match(String(refusal.message), /does not hold the parent lock/);
			assert.equal(readDrain(s.home.path)?.state, "draining", "the sibling's empty manager proves nothing");
			await sibling.close();
		}
		await waitFor(() => {
			try { return JSON.parse(readFileSync(join(s.home.path, paths.reviewFile(JOB, 1)), "utf8")).verdict === "pass"; }
			catch { return false; }
		}, Boolean, { timeoutMs: 35_000, what: "reviewer report settles during drain" });
		if (!timeout) {
			await waitFor(() => readDrain(s.home.path)?.state === "drained", Boolean, { timeoutMs: 10_000, what: "review settlement completes drain" });
			assert.equal(readDrain(s.home.path)!.survivors, undefined);
		}
	});
}
