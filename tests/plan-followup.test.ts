/**
 * pi-command-post-autonomy-programme-cur.3.3: the two operator phrasings
 * ("revise the plan for job X: …" / "ask the planner of job X: …") mapped to
 * `cp_send` promote briefs, plus the two invariants code enforces on top of
 * the AGENTS.md prose: refuse a revise once the plan checkpoint is approved
 * and the implementer is dispatched, and one open revise at a time per job.
 *
 * Pure over `decidePlanSend`: no worker, no pi child — the pipeline link,
 * checkpoint and gate files it reads are written straight to disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";
import { paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { atomicWriteJson } from "../src/json-store.ts";
import {
	decidePlanSend,
	decisionReviseAt,
	implementedReviseRefusal,
	parseOperatorPlanAsk,
	planQuestionBrief,
	planReviseBrief,
	recordPlanRevise,
	reviseStillOpen,
} from "../src/plan-followup.ts";
import { createScratchHome } from "./harness/index.ts";

function writeLink(home: string, researchId: string, shipId: string): void {
	atomicWriteJson(join(home, paths.pipelineFile(researchId)), {
		schema_version: SCHEMA_VERSION,
		research_id: researchId,
		ship_id: shipId,
	});
}

function writeGate(home: string, researchId: string, attempt: number, decidedAt: string): void {
	const file = join(home, paths.gateFile(researchId, attempt));
	mkdirSync(join(home, paths.runDir(researchId)), { recursive: true });
	writeFileSync(file, JSON.stringify({ decided_at: decidedAt }));
}

test("parseOperatorPlanAsk: the two operator phrasings", () => {
	assert.deepEqual(parseOperatorPlanAsk("revise the plan for job cp-abc: split step 3"), {
		kind: "revise",
		jobId: "cp-abc",
		text: "split step 3",
	});
	assert.deepEqual(parseOperatorPlanAsk("ask the planner of job cp-abc: which auth provider?"), {
		kind: "question",
		jobId: "cp-abc",
		text: "which auth provider?",
	});
	assert.equal(parseOperatorPlanAsk("revise the plan for job cp-abc:"), undefined, "no text after the colon");
	assert.equal(parseOperatorPlanAsk("do something else entirely"), undefined);
});

test("planReviseBrief names the artifact path and quotes the revision", () => {
	const brief = planReviseBrief("/state/artifacts/cp-abc/report.md", "split step 3");
	assert.match(brief, /^Revision requested on the filed plan:/);
	assert.match(brief, /split step 3/);
	assert.match(brief, /Artifact path: \/state\/artifacts\/cp-abc\/report\.md/);
});

test("planQuestionBrief asks for a blocked envelope, not a new plan", () => {
	const brief = planQuestionBrief("which auth provider?");
	assert.match(brief, /^Question for the planner:/);
	assert.match(brief, /which auth provider\?/);
	assert.match(brief, /one blocked envelope/);
});

test("decidePlanSend: ignores a message that is neither phrase nor marker", () => {
	const home = createScratchHome();
	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "please rebase your branch",
		implementerDispatched: () => false,
	});
	assert.deepEqual(decision, { kind: "ignore" });
	home.cleanup();
});

test("decidePlanSend: refuses a revise with no linked pipeline", () => {
	const home = createScratchHome();
	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-standalone",
		message: "revise the plan for job cp-standalone: split step 3",
		implementerDispatched: () => false,
	});
	assert.equal(decision.kind, "refuse");
	if (decision.kind === "refuse") assert.match(decision.reason, /no pipeline/);
	home.cleanup();
});

test("decidePlanSend: revise before implementation starts", () => {
	const home = createScratchHome();
	writeLink(home.path, "cp-research", "cp-ship");
	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "revise the plan for job cp-research: split step 3",
		implementerDispatched: () => false,
	});
	assert.equal(decision.kind, "revise");
	if (decision.kind === "revise") {
		assert.equal(decision.researchId, "cp-research");
		assert.equal(decision.shipId, "cp-ship");
		assert.equal(decision.text, "split step 3");
		assert.match(decision.message, /^Revision requested on the filed plan:/);
	}
	home.cleanup();
});

test("decidePlanSend: question asks for a blocked envelope", () => {
	const home = createScratchHome();
	writeLink(home.path, "cp-research", "cp-ship");
	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "ask the planner of job cp-research: which auth provider?",
		implementerDispatched: () => false,
	});
	assert.equal(decision.kind, "question");
	if (decision.kind === "question") {
		assert.match(decision.message, /^Question for the planner:/);
		assert.match(decision.message, /which auth provider\?/);
	}
	home.cleanup();
});

test("decidePlanSend: a revise is refused once the plan checkpoint is approved and the implementer is dispatched, naming the sanctioned path", () => {
	const home = createScratchHome();
	writeLink(home.path, "cp-research", "cp-ship");
	const checkpoints = new CheckpointStore(home.path);
	checkpoints.request({ jobId: "cp-ship", question: "ship cp-ship?" });
	checkpoints.decide("cp-ship", true, { by: "mandate:test" });

	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "revise the plan for job cp-research: split step 3",
		implementerDispatched: (shipId) => shipId === "cp-ship",
	});
	assert.equal(decision.kind, "refuse");
	if (decision.kind === "refuse") {
		assert.equal(decision.reason, implementedReviseRefusal("cp-research", "cp-ship"));
		assert.match(decision.reason, /new research job/);
		assert.match(decision.reason, /cp_send cp-ship/);
	}
	home.cleanup();
});

test("decidePlanSend: one open revise at a time, until the next gate decision", () => {
	const home = createScratchHome();
	writeLink(home.path, "cp-research", "cp-ship");
	recordPlanRevise(home.path, "cp-research", "split step 3", "2026-01-01T00:00:00.000Z");
	assert.ok(reviseStillOpen(home.path, "cp-research"));

	const blocked = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "revise the plan for job cp-research: also fix step 4",
		implementerDispatched: () => false,
	});
	assert.equal(blocked.kind, "refuse");
	if (blocked.kind === "refuse") assert.match(blocked.reason, /one open revise at a time/);

	// A later gate decision closes the window.
	writeGate(home.path, "cp-research", 1, "2026-01-02T00:00:00.000Z");
	assert.equal(reviseStillOpen(home.path, "cp-research"), false);
	const reopened = decidePlanSend({
		home: home.path,
		jobId: "cp-research",
		message: "revise the plan for job cp-research: also fix step 4",
		implementerDispatched: () => false,
	});
	assert.equal(reopened.kind, "revise");
	home.cleanup();
});

test("decidePlanSend: sent to the wrong job in a linked pipeline is refused, naming the planner", () => {
	const home = createScratchHome();
	writeLink(home.path, "cp-research", "cp-ship");
	const decision = decidePlanSend({
		home: home.path,
		jobId: "cp-ship",
		message: "revise the plan for job cp-research: split step 3",
		implementerDispatched: () => false,
	});
	assert.equal(decision.kind, "refuse");
	if (decision.kind === "refuse") assert.match(decision.reason, /cp_send cp-research \(the planner\)/);
	home.cleanup();
});

test("decisionReviseAt: absent until a revise is recorded", () => {
	const home = createScratchHome();
	assert.equal(decisionReviseAt(home.path, "cp-research"), undefined);
	recordPlanRevise(home.path, "cp-research", "split step 3", "2026-01-01T00:00:00.000Z");
	assert.equal(decisionReviseAt(home.path, "cp-research"), "2026-01-01T00:00:00.000Z");
	home.cleanup();
});
