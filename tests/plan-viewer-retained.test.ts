/**
 * Two `PlanViewer` units no entry point reaches, kept verbatim from tests/plan-viewer.test.ts (P11b): a real setTimeout
 * fires once, and pi-tui writes nothing for an unchanged frame, so a spurious repaint never reaches the terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanViewer, type PlanViewerOptions } from "../extensions/command-post/plan-viewer.ts";

function plainRenderLines(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length <= width) {
			lines.push(rawLine);
			continue;
		}
		for (let index = 0; index < rawLine.length; index += width) lines.push(rawLine.slice(index, index + width));
	}
	return lines;
}

function makeViewer(overrides: Partial<PlanViewerOptions> & { text?: string; rows?: () => number } = {}) {
	const idleCancels: Array<() => void> = [];
	let idleCallback: (() => void) | undefined;
	const scheduleIdle = (_ms: number, onTimeout: () => void) => {
		idleCallback = onTimeout;
		const cancel = () => {};
		idleCancels.push(cancel);
		return { cancel };
	};
	const done: string[] = [];
	const repaints: number[] = [];
	const viewer = new PlanViewer({
		jobId: "cp-x",
		path: "/tmp/report.md",
		bytes: 1000,
		truncated: false,
		text: overrides.text ?? Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
		renderLines: plainRenderLines,
		rows: overrides.rows ?? (() => 10),
		scheduleIdle,
		onChange: () => repaints.push(repaints.length + 1),
		onDone: () => done.push("done"),
	});
	return { viewer, done, repaints, fireIdle: () => idleCallback?.() };
}

test("an unknown key changes nothing and asks for no repaint", () => {
	const { viewer, repaints } = makeViewer({ rows: () => 5 });
	viewer.render(80);
	viewer.handleInput("\x1b[200~"); // a paste marker: not a pager key
	assert.deepEqual(repaints, []);
	assert.equal(viewer.position().offset, 0);
});

test("idle timer: firing calls done() once and only once", () => {
	const { viewer, done, fireIdle } = makeViewer({ rows: () => 5 });
	viewer.render(80);
	fireIdle();
	fireIdle();
	assert.equal(done.length, 1);
});
