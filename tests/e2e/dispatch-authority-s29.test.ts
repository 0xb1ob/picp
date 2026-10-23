import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { MandateStore } from "../../src/mandate.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { readFleet, readRunEvents, type ScriptStep } from "../harness/index.ts";

test("S29 authority: recorded risk, readonly profiles and ops enforce public dispatch gates", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const mandates = new MandateStore(b.home);
	mandates.issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 30, dispatch_parallelism: 16, ask_on: ["risk:high"] });
	const specs = [
		{ title: "explicit", risk: "high", task: "Fix typo.", refused: true },
		{ title: "label", recorded: "high", risk: "low", task: "Fix typo.", refused: true },
		{ title: "header", risk: "low", task: "Scope S, risk high.\n\nFix typo.", refused: true },
		{ title: "writer", kind: "research", profile: "implementer", risk: "high", task: "Fix typo.", refused: true },
		{ title: "deploy", kind: "research", labels: ["ops:deploy"], risk: "low", task: "Deploy the build.", refused: true },
		{ title: "hard stop", task: "Delete the stale fixture and migrate the test helper. Then rm -rf the build dir.", refused: true },
		{ title: "planner", kind: "research", profile: "planner", risk: "high", task: "Rotate production credentials.", refused: false },
		{ title: "qa", kind: "research", profile: "qa", risk: "high", task: "Rotate production credentials.", refused: false },
		{ title: "low keyword", risk: "low", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /inferred from keywords only/ },
		{ title: "label low", recorded: "low", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /job's risk: label/ },
		{ title: "header low", task: "Scope S, risk low.\n\nDelete the stale fixture and migrate the test helper.", refused: false, warning: /task header/ },
		{ title: "description low", description: "Scope S, risk low.", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /job description header/ },
		{ title: "bare keyword", task: "Delete the stale fixture and migrate the test helper.", refused: false, warning: /issued from operator chat/ },
	] as const;
	const jobs = [];
	const steps: ScriptStep[] = [];
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i]!;
		const job = await b.ledger.create({ title: spec.title, project: "demo", delivery: "local", kind: "kind" in spec ? spec.kind : "ship", ...("labels" in spec ? { labels: [...spec.labels] } : {}), ...("recorded" in spec ? { risk: spec.recorded } : {}), ...("description" in spec ? { description: spec.description } : {}) });
		jobs.push(job);
		const model = b.provider.addScript(`worker-${i}`, [{ kind: "text", text: "received" }]);
		steps.push({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: spec.task, model, queue: false, when_ready: false, ...("risk" in spec ? { risk: spec.risk } : {}), ...("profile" in spec ? { profile: spec.profile } : {}) } }] });
	}
	const ends = await b.run(steps);
	assert.equal(ends.length, specs.length);
	const fleet = readFleet(b.home).jobs;
	for (let i = 0; i < specs.length; i++) {
		const spec = specs[i]!;
		const end = ends[i]!;
		const job = jobs[i]!;
		await t.test(spec.title, async () => {
		assert.equal(end.isError === true, spec.refused, `${spec.title}: ${JSON.stringify(end.result)}`);
		const record = fleet.find((record) => record.job_id === job.id);
		if (spec.refused) {
			assert.match(JSON.stringify(end.result), /risk:high under ask_on/);
			assert.equal(record, undefined, spec.title);
			assert.equal((await b.ledger.show(job.id)).status, "open");
		} else {
			assert.equal(end.result.details?.state, "dispatched", spec.title);
			assert.ok(record, spec.title);
			if ("profile" in spec) assert.equal(end.result.details?.profile, spec.profile);
			if ("warning" in spec) {
				assert.match(String(end.result.details?.risk_warning), spec.warning);
				const event = readRunEvents(b.home, job.id).find((event) => event.type === "routing_resolved");
				assert.equal((event?.payload as Record<string, unknown>)?.risk_warning, end.result.details?.risk_warning);
			}
		}
		});
	}
	const escalations = new EscalationStore({ home: b.home }).open();
	assert.deepEqual(escalations.flatMap((entry) => entry.job_ids).sort(), jobs.filter((_, i) => specs[i]!.refused).map((job) => job.id).sort());
});

test("S29 authority: denied project precedes risk escalation", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	new MandateStore(b.home).issue({ projects: ["demo"], objective: "dispatch", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10, ask_on: ["risk:high"], channel: "bridge" });
	writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), JSON.stringify({ deny_projects: ["demo"] }));
	const job = await b.ledger.create({ title: "denied", project: "demo", delivery: "local", kind: "ship" });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "must not start" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Rotate production credentials.", risk: "high", model } }] }]);
	assert.equal(ends[0]?.isError, true);
	assert.match(JSON.stringify(ends[0]?.result), /project_denied/);
	assert.deepEqual(new EscalationStore({ home: b.home }).open(), []);
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
	assert.equal(b.provider.remaining("worker"), 1);
	assert.equal((await b.ledger.show(job.id)).status, "open");
	assert.ok(readFileSync(join(b.home, LAYOUT.mandateDefaultsFile), "utf8").includes("demo"));
});
