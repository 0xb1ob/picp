/**
 * riskkw-f10: header declarations, the recorded-risk precedence the dispatch,
 * dry-run and cp_send gates share, and `inferredRiskGate`'s three branches
 * (recorded high gates, recorded low warns on an inferred-only high, explicit /
 * assessed highs gate).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Risk } from "../src/contracts.ts";
import type { MandateStore } from "../src/mandate.ts";
import { declaredRisk, inferredRiskGate, recordedRisk, riskField, riskKeywords } from "../src/risk-warning.ts";

test("declaredRisk reads a clause-start risk in the header only; a named gate declares nothing", () => {
	const cases: Array<[string, Risk | undefined]> = [
		["Scope M each, risk low.", "low"],
		["Risk: low", "low"],
		["**Risk:** low", "low"],
		["- risk: high", "high"],
		["Scope S, risk:low", "low"],
		["preserve risk:high escalation", undefined],
		["ask_on risk:high gates it", undefined],
		["the risk low was recorded", undefined],
		["scope/risk assessment", undefined],
		["Implementation requires its own risk:high escalation", undefined],
		["high-risk low-level", undefined],
		["Risk: low-ish", undefined],
		["Risk: low\n\n## Details\nrisk high", "low"],
		["# T\nRisk: low. Risk: high.", "high"],
		[
			"# Dashboard: context-window usage everywhere, and a real desktop layout\n\nProject: pi-command-post-system. Two kind:ship delivery:pr jobs under one mandate (\"dashboard context + desktop\nlayout\"), run serially: A, then B. Scope M each, risk low. **Queued:** dispatch after xt7 (#341) has merged. Both jobs\ntouch viewer-app, which xt7 is changing.",
			"low",
		],
	];
	for (const [text, want] of cases) assert.equal(declaredRisk(text), want, text);
	assert.equal(declaredRisk(undefined), undefined);
	assert.equal(declaredRisk("x\n```\nRisk: high\n```"), undefined, "a fence ends the header");
});

test("recordedRisk: any high first, then the caller's, then the job's own low", () => {
	const job = (labels: string[] = [], description?: string) => ({ labels: ["project:demo", "delivery:pr", ...labels], ...(description ? { description } : {}) });
	assert.equal(recordedRisk({}), undefined);
	assert.deepEqual(recordedRisk({ job: job() }), undefined);
	assert.deepEqual(recordedRisk({ job: job(["risk:low"]) }), { risk: "low", from: "job_label" });
	assert.deepEqual(recordedRisk({ job: job([], "Scope S, risk low. Tidy.") }), { risk: "low", from: "description_header" });
	assert.deepEqual(recordedRisk({ job: job(), taskText: "Risk: low\n\nDelete it." }), { risk: "low", from: "task_header" });
	assert.deepEqual(recordedRisk({ job: job(["risk:low"]), requested: "high" }), { risk: "high", from: "dispatch" });
	assert.deepEqual(recordedRisk({ job: job(["risk:high"]), requested: "low" }), { risk: "high", from: "job_label" });
	assert.deepEqual(
		recordedRisk({ job: job(), taskText: "Risk: high", pipeline: { risk: "low", provenance: "assessed" } }),
		{ risk: "high", from: "task_header" },
	);
	assert.deepEqual(
		recordedRisk({ job: job(["risk:low"]), pipeline: { risk: "low", provenance: "explicit" } }),
		{ risk: "low", from: "pipeline" },
	);
	assert.deepEqual(recordedRisk({ fleet: "low" }), { risk: "low", from: "fleet_record" });
	assert.deepEqual(recordedRisk({ requested: "low", fleet: "high" }), { risk: "high", from: "fleet_record" }, "a recorded high beats an explicit low");
});

test("a pipeline risk is a record only when it was explicit or assessed, and says which half recorded it", () => {
	// riskkw: `cp_pipeline start` without a `risk` freezes a `defaulted` low on
	// `task_impact` — "nobody named it". That is not a record, so it can never warn
	// a keyword-only high away, and neither is an `inferred` axis.
	assert.equal(recordedRisk({ pipeline: { risk: "low", provenance: "defaulted" } }), undefined);
	assert.equal(recordedRisk({ pipeline: { risk: "low", provenance: "inferred" } }), undefined);
	assert.deepEqual(
		recordedRisk({ pipeline: { risk: "low", provenance: "explicit" } }),
		{ risk: "low", from: "pipeline" },
		"an explicit low frozen at start is the pipeline's own record",
	);
	assert.deepEqual(
		recordedRisk({ pipeline: { risk: "low", from: "planner", provenance: "assessed" } }),
		{ risk: "low", from: "planner" },
		"the planner's non-destructive assessment is named as the planner's",
	);
	assert.deepEqual(
		recordedRisk({ job: { labels: ["risk:high"] }, pipeline: { risk: "low", provenance: "defaulted" } }),
		{ risk: "high", from: "job_label" },
		"a defaulted low is not a record for anything else to lose to",
	);
});

test("riskField routes a recorded high only, never a low, and never overrides the caller", () => {
	assert.deepEqual(riskField(undefined, { labels: ["risk:high"] }, ""), { risk: "high" });
	assert.deepEqual(riskField(undefined, { labels: ["risk:low"] }, ""), {});
	assert.deepEqual(riskField(undefined, { labels: [] }, "Risk: high\n\nFix it."), { risk: "high" });
	assert.deepEqual(riskField("low", { labels: ["risk:high"] }, ""), { risk: "low" });
});

test("inferredRiskGate: a recorded high gates, a recorded low warns on inferred-only, explicit/assessed highs gate", () => {
	const asks = { wouldAskRiskHigh: () => true } as unknown as MandateStore;
	const job = { jobId: "cp-x", project: "demo", kind: "ship" as const };
	assert.deepEqual(
		inferredRiskGate({ mandates: asks, job, routed: "low", routedFrom: "defaulted", recorded: "high", recordedFrom: "job_label", text: "Fix the typo" }),
		{ risk: "high", evidence: "risk high recorded on the job's risk: label" },
	);
	assert.deepEqual(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "explicit", recorded: "high", recordedFrom: "dispatch", text: "x" }), { risk: "high" });
	const warned = inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "job_label", text: "Delete the stale fixture" });
	assert.equal(warned.risk, "low");
	assert.match(warned.warning ?? "", /keywords only \(delete\); risk low was recorded on the job's risk: label, so ask_on risk:high warned instead of gating/);
	const planned = inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "planner", text: "Delete the stale fixture" });
	assert.equal(planned.risk, "low", "a planner-assessed low still only warns on an inferred-only high");
	assert.match(
		planned.warning ?? "",
		/keywords only \(delete\); risk low was assessed by the planner, so ask_on risk:high warned instead of gating/,
	);
	assert.equal(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "explicit", recorded: "low", recordedFrom: "job_label", text: "Delete it" }).risk, "high");
	assert.equal(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "assessed", recorded: "low", recordedFrom: "job_label", text: "Delete it" }).risk, "high");
	assert.equal(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", text: "Delete it" }).risk, "high");
	assert.equal(
		inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", text: "Delete it" }).warning,
		"cp-x: warning: risk:high inferred from keywords only (delete); risk low was recorded, so ask_on risk:high warned instead of gating",
	);
	const quiet = { wouldAskRiskHigh: () => false } as unknown as MandateStore;
	const none = inferredRiskGate({ mandates: quiet, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "job_label", text: "Delete it" });
	assert.deepEqual(none, { risk: "low" });
});

test("riskkw-qno: audit tags and an unapproved named item do not warn; the gate and inference are unchanged", () => {
	const asks = { wouldAskRiskHigh: () => true } as unknown as MandateStore;
	const job = { jobId: "cp-x", project: "demo", kind: "ship" as const };
	// cp-sr-s1-lkgo N4: bare `auth` is no risk signal, so the `gh auth status` probe is not even inferred any more.
	assert.deepEqual(riskKeywords("After it's installed, check `gh auth status`."), []);
	for (const text of [
		"P4 of the plan below. **P5 (migrating a home) is not approved:** don't build any of it.",
		"P5 (migration) is not approved.",
		"The scope is over-engineering only: `delete:` / `stdlib:` / `shrink:`.",
	]) {
		assert.ok(riskKeywords(text).length > 0, `inference still counts it: ${text}`);
		assert.deepEqual(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "task_header", text }), { risk: "low" }, text);
		assert.equal(inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", text }).risk, "high", `no recorded low still gates: ${text}`);
	}
	const mixed = inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "task_header", text: "Check `gh auth status`, then delete the stale fixture" });
	assert.match(mixed.warning ?? "", /keywords only \(delete\)/, "a true positive beside a benign sense still warns");
});

test("deleting a named source/doc file or dead code does not warn; a bare or data deletion still does", () => {
	const asks = { wouldAskRiskHigh: () => true } as unknown as MandateStore;
	const job = { jobId: "cp-x", project: "demo", kind: "ship" as const };
	const gate = (text: string) => inferredRiskGate({ mandates: asks, job, routed: "high", routedFrom: "inferred", recorded: "low", recordedFrom: "task_header", text });
	for (const text of ["Delete src/viewer/awaiting-view.ts.", "Delete the docs/HANDOFF.md file.", "Then delete dead code in the viewer."]) {
		assert.deepEqual(gate(text), { risk: "low" }, text);
	}
	for (const text of ["Delete it", "Delete the table", "delete rows", "Delete the files", "delete code that handles billing", "delete docs", "delete data/users.json", "Do not modify or delete the remaining files in the real home."]) {
		assert.match(gate(text).warning ?? "", /keywords only \(delete/, text);
	}
});
