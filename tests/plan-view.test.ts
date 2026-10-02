/**
 * cp-9c5: pure resolution and viewport maths, with no pi, no terminal, no
 * theme. `openPlanViewer`'s own gate is tested in tests/plan-viewer.test.ts
 * (Guard test A/B/C live there, next to the fake `ExtensionContext`); this
 * file only exercises what `src/plan-view.ts` may import — node and
 * `./contracts.ts`.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../src/contracts.ts";
import {
	findMatches,
	formatBytes,
	formatPlanFooter,
	formatPlanHeader,
	nextMatch,
	type PlanViewDeps,
	readPlanSource,
	renderGateDocument,
	resolvePlanTarget,
	sliceViewport,
	stripAnsiSequences,
	viewportRows,
} from "../src/plan-view.ts";
import { createScratchHome } from "./harness/index.ts";

function deps(home: string, overrides: Partial<PlanViewDeps> = {}): PlanViewDeps {
	return {
		home,
		checkpointResearchId: () => undefined,
		pipelineResearchIdForShip: () => undefined,
		...overrides,
	};
}

function writeArtifact(home: string, jobId: string, text = "# report\n"): void {
	const file = join(home, paths.artifactFile(jobId));
	mkdirSync(join(home, paths.artifactDir(jobId)), { recursive: true });
	writeFileSync(file, text);
}

function writeGate(home: string, researchId: string, attempt: number, raw: boolean, body: unknown): void {
	const file = join(home, raw ? paths.gateFileRaw(researchId, attempt) : paths.gateFile(researchId, attempt));
	mkdirSync(join(home, paths.runDir(researchId)), { recursive: true });
	writeFileSync(file, JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// resolvePlanTarget
// ---------------------------------------------------------------------------

test("resolvePlanTarget: a research id resolves straight to its artifact", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeArtifact(home.path, "cp-research-1", "# hello\n");
	const target = resolvePlanTarget("cp-research-1", deps(home.path));
	assert.equal(target.kind, "artifact");
	assert.equal(target.researchId, "cp-research-1");
	assert.equal(target.path, join(home.path, paths.artifactFile("cp-research-1")));
	assert.equal(target.bytes, 8);
});

test("resolvePlanTarget: a ship id with a checkpoint resolves via Checkpoint.research_id", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeArtifact(home.path, "cp-research-2");
	const target = resolvePlanTarget(
		"cp-ship-2",
		deps(home.path, { checkpointResearchId: (id) => (id === "cp-ship-2" ? "cp-research-2" : undefined) }),
	);
	assert.equal(target.kind, "artifact");
	assert.equal(target.researchId, "cp-research-2");
});

test("resolvePlanTarget: a ship id with no checkpoint resolves via PipelineStore.findByShipId", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeArtifact(home.path, "cp-research-3");
	const target = resolvePlanTarget(
		"cp-ship-3",
		deps(home.path, { pipelineResearchIdForShip: (id) => (id === "cp-ship-3" ? "cp-research-3" : undefined) }),
	);
	assert.equal(target.kind, "artifact");
	assert.equal(target.researchId, "cp-research-3");
});

test("resolvePlanTarget: unknown job, missing artifact, or unsafe id all come back absent, never a throw", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const unknown = resolvePlanTarget("cp-nope", deps(home.path));
	assert.equal(unknown.kind, "absent");
	assert.match(unknown.reason ?? "", /no artifact for cp-nope/);

	const unsafe = resolvePlanTarget("../etc/passwd", deps(home.path));
	assert.equal(unsafe.kind, "absent");
	assert.match(unsafe.reason ?? "", /unsafe job id/);
});

test("resolvePlanTarget --gate: resolves gate-2-raw.json when present, falls back to gate-2.json otherwise", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeGate(home.path, "cp-r", 1, false, { verdict: "revise", cause: "quality", attempt: 1 });
	writeGate(home.path, "cp-r", 2, true, { verdict: "pass", cause: "quality", attempt: 2, reasons: ["dropped further"] });

	const withRaw = resolvePlanTarget("cp-r", deps(home.path), { gate: 2 });
	assert.equal(withRaw.kind, "gate");
	assert.equal(withRaw.attempt, 2);
	assert.equal(withRaw.path, join(home.path, paths.gateFileRaw("cp-r", 2)));

	const capped = resolvePlanTarget("cp-r", deps(home.path), { gate: 1 });
	assert.equal(capped.kind, "gate");
	assert.equal(capped.attempt, 1);
	assert.equal(capped.path, join(home.path, paths.gateFile("cp-r", 1)));
});

test("resolvePlanTarget --gate true: picks the highest attempt on disk", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeGate(home.path, "cp-r", 1, false, { verdict: "revise" });
	writeGate(home.path, "cp-r", 2, false, { verdict: "pass" });
	const target = resolvePlanTarget("cp-r", deps(home.path), { gate: true });
	assert.equal(target.kind, "gate");
	assert.equal(target.attempt, 2);
});

test("resolvePlanTarget --gate: absent when no gate decision exists, names what was checked", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const target = resolvePlanTarget("cp-r", deps(home.path), { gate: true });
	assert.equal(target.kind, "absent");
	assert.match(target.reason ?? "", /no gate decision/);
});

// ---------------------------------------------------------------------------
// readPlanSource
// ---------------------------------------------------------------------------

test("readPlanSource: under the cap reads the whole file untruncated", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, "small.md");
	writeFileSync(file, "hello world");
	const result = readPlanSource(file, 1024);
	assert.equal(result.text, "hello world");
	assert.equal(result.truncated, false);
	assert.equal(result.bytes, 11);
});

test("readPlanSource: over the cap truncates and still reports the full byte count", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, "big.md");
	const body = "x".repeat(3 * 1024 * 1024);
	writeFileSync(file, body);
	const result = readPlanSource(file, 1024 * 1024);
	assert.equal(result.truncated, true);
	assert.equal(result.bytes, body.length);
	assert.equal(result.text.length, 1024 * 1024);
});

// ---------------------------------------------------------------------------
// renderGateDocument
// ---------------------------------------------------------------------------

test("renderGateDocument: known fields render as markdown, unknown fields survive as a JSON block", () => {
	const rendered = renderGateDocument(
		{
			verdict: "pass",
			cause: "quality",
			attempt: 2,
			model: "anthropic/claude",
			decided_at: "2024-01-01T00:00:00.000Z",
			reasons: ["ok"],
			mystery_field: 42,
		},
		"cp-r",
	);
	assert.match(rendered, /Gate decision — cp-r/);
	assert.match(rendered, /\*\*Verdict:\*\* pass/);
	assert.match(rendered, /## Reasons/);
	assert.match(rendered, /- ok/);
	assert.match(rendered, /## Additional fields/);
	assert.match(rendered, /"mystery_field": 42/);
});

test("renderGateDocument: tolerates a non-object payload rather than throwing", () => {
	assert.doesNotThrow(() => renderGateDocument(null, "cp-r"));
	assert.doesNotThrow(() => renderGateDocument("not an object", "cp-r"));
});

// ---------------------------------------------------------------------------
// Viewport maths
// ---------------------------------------------------------------------------

test("viewportRows: clamps to the floor on a tiny terminal", () => {
	assert.equal(viewportRows(24, 6, 4), 18);
	assert.equal(viewportRows(5, 6, 4), 4);
});

test("sliceViewport: top, middle, bottom, and clamping past the end", () => {
	const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
	assert.deepEqual(sliceViewport(lines, 0, 10).slice, lines.slice(0, 10));
	assert.equal(sliceViewport(lines, 50, 10).offset, 50);
	// past the end clamps to the last full page, never a negative or partial-then-empty slice
	const atEnd = sliceViewport(lines, 1000, 10);
	assert.equal(atEnd.offset, 90);
	assert.equal(atEnd.slice.length, 10);
});

test("sliceViewport: a document shorter than the viewport, and a zero-line document", () => {
	const short = sliceViewport(["a", "b"], 0, 10);
	assert.deepEqual(short.slice, ["a", "b"]);
	assert.equal(short.offset, 0);
	const empty = sliceViewport([], 0, 10);
	assert.deepEqual(empty.slice, []);
	assert.equal(empty.offset, 0);
});

test("findMatches / nextMatch: wrap-around, no-match, case-insensitivity, ANSI-styled lines", () => {
	const lines = ["Unknowns", "\x1b[32mplain\x1b[0m", "unknowns again", "nothing here"];
	const matches = findMatches(lines, "unknowns");
	assert.deepEqual(matches, [0, 2]);
	assert.deepEqual(findMatches(lines, "PLAIN"), [1]);
	assert.deepEqual(findMatches(lines, "zzz"), []);

	assert.equal(nextMatch(matches, 0, 1), 2);
	assert.equal(nextMatch(matches, 2, 1), 0, "wraps around forward");
	assert.equal(nextMatch(matches, 0, -1), 2, "wraps around backward");
	assert.equal(nextMatch([], 0, 1), undefined);
});

test("stripAnsiSequences removes SGR codes", () => {
	assert.equal(stripAnsiSequences("\x1b[31mred\x1b[0m"), "red");
});

test("formatBytes / formatPlanHeader / formatPlanFooter", () => {
	assert.equal(formatBytes(500), "500 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.match(formatPlanHeader("cp-x", 2048, 5, 100), /cp-x — plan · 2\.0 KB · line 5\/100 \(5%\)/);
	assert.match(formatPlanFooter({ searching: false }), /scroll/);
	assert.match(formatPlanFooter({ searching: true, query: "abc" }), /search: abc/);
});
