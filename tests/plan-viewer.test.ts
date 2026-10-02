/**
 * cp-9c5: the TUI half. Two groups of tests live here:
 *
 *  - the pager component (`PlanViewer`), driven with an injected `rows()` and
 *    a plain (no-ANSI) `renderLines`, so no real theme or terminal is needed;
 *  - the guard tests that make the mode gate mechanical: `openPlanViewer`
 *    never reads a body outside a real TUI, and never through a registered
 *    tool.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandPostSource } from "./harness/pi-child.ts";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import {
	decodePlanViewAction,
	openPlanViewer,
	PlanViewer,
	type PlanViewerCtx,
	type PlanViewerOptions,
} from "../extensions/command-post/plan-viewer.ts";
import type { PlanTarget } from "../src/plan-view.ts";

const SENTINEL = "CP9C5-SENTINEL-DO-NOT-LEAK";

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

function fakeCtx(overrides: {
	mode: string;
	hasUI: boolean;
	notify?: (text: string, level?: string) => void;
	custom?: (factory: unknown, options?: unknown) => Promise<unknown>;
}) {
	const calls: string[] = [];
	const ctx = {
		mode: overrides.mode,
		hasUI: overrides.hasUI,
		ui: {
			notify: (text: string, level?: string) => {
				calls.push("notify");
				overrides.notify?.(text, level);
			},
			custom: async (factory: unknown, options?: unknown) => {
				calls.push("custom");
				return overrides.custom ? overrides.custom(factory, options) : undefined;
			},
		},
	};
	return { ctx: ctx as unknown as PlanViewerCtx, calls };
}

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

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

/** The CSI-u form a Kitty-protocol terminal sends for a printable key. */
function csiU(codepoint: number, modifiers?: number): string {
	return modifiers === undefined ? `\x1b[${codepoint}u` : `\x1b[${codepoint};${modifiers}u`;
}

test("render(width) returns exactly rows()+2 lines at rows 30, 12 and 6", () => {
	for (const rows of [30, 12, 6]) {
		const { viewer } = makeViewer({ rows: () => rows });
		const frame = viewer.render(80);
		assert.equal(frame.length, rows + 2, `rows=${rows}`);
	}
});

test("no rendered line exceeds width at 120/80/40/20", () => {
	const longText = Array.from({ length: 20 }, (_, i) => `${"x".repeat(200)}-${i}`).join("\n");
	for (const width of [120, 80, 40, 20]) {
		const { viewer } = makeViewer({ text: longText, rows: () => 10 });
		const frame = viewer.render(width);
		// visibleWidth, not .length: a truncated line may carry a trailing SGR
		// reset (docs/tui.md §Line Width), which is zero-width on screen.
		for (const line of frame) assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${visibleWidth(line)}`);
	}
});

test("paging: PageDown advances, End lands on the last page, Home returns to 0", () => {
	const { viewer } = makeViewer({ rows: () => 10 });
	viewer.render(80);
	viewer.handleInput("\x1b[6~"); // PageDown
	const afterPage = viewer.render(80);
	assert.notEqual(afterPage[1], "line 0");
	viewer.handleInput("\x1b[4~"); // End
	viewer.render(80);
	viewer.handleInput("\x1bOF"); // some terminals send End differently; ensure no throw either way
	viewer.handleInput("g");
	const afterHome = viewer.render(80);
	assert.equal(afterHome[1], "line 0");
});

test("scrolling past either end is a no-op, not a negative index", () => {
	const { viewer } = makeViewer({ rows: () => 10 });
	viewer.render(80);
	for (let i = 0; i < 50; i += 1) viewer.handleInput("k"); // up, way past the top
	const frame = viewer.render(80);
	assert.equal(frame[1], "line 0");
});

test("search: / then a query then Enter puts a matching heading in view; n cycles", () => {
	const text = Array.from({ length: 30 }, (_, i) => (i === 25 ? "Unknowns" : `line ${i}`)).join("\n");
	const { viewer } = makeViewer({ text, rows: () => 5 });
	viewer.render(80);
	viewer.handleInput("/");
	for (const ch of "Unknowns") viewer.handleInput(ch);
	viewer.handleInput("\r"); // enter
	const frame = viewer.render(80);
	assert.ok(frame.some((line) => line.includes("Unknowns")), frame.join("\n"));
});

test("Escape while searching leaves search without closing the viewer", () => {
	const { viewer, done } = makeViewer({ rows: () => 5 });
	viewer.render(80);
	viewer.handleInput("/");
	viewer.handleInput("x");
	viewer.handleInput("\x1b"); // escape
	assert.equal(done.length, 0, "escape while searching must not close the viewer");
});

test("q and Escape call done(); Enter does not (the accidental-answer guard)", () => {
	const { viewer, done } = makeViewer({ rows: () => 5 });
	viewer.render(80);
	viewer.handleInput("\r");
	assert.equal(done.length, 0, "Enter must never close the viewer");
	viewer.handleInput("q");
	assert.equal(done.length, 1);

	const { viewer: viewer2, done: done2 } = makeViewer({ rows: () => 5 });
	viewer2.render(80);
	viewer2.handleInput("\x1b");
	assert.equal(done2.length, 1);
});

test("a document longer than the viewport scrolls and reports its position", () => {
	const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
	const { viewer, repaints } = makeViewer({ text, rows: () => 10 });
	const first = viewer.render(80);
	assert.match(first[0] as string, /line 1-10\/500 \(top\)/);
	assert.equal(first[1], "line 0");

	viewer.handleInput("\x1b[6~"); // PageDown
	const paged = viewer.render(80);
	assert.match(paged[0] as string, /line 10-19\/500/, paged[0]);
	assert.equal(paged[1], "line 9");

	viewer.handleInput("d"); // half page
	const half = viewer.render(80);
	assert.equal(half[1], "line 14");

	viewer.handleInput("u");
	assert.equal(viewer.render(80)[1], "line 9");

	viewer.handleInput("G"); // bottom
	const bottom = viewer.render(80);
	assert.match(bottom[0] as string, /line 491-500\/500 \(bot\)/, bottom[0]);
	assert.equal(bottom[1], "line 490");

	viewer.handleInput("g"); // top
	assert.match(viewer.render(80)[0] as string, /\(top\)/);

	// Every one of those state changes asked the host for a repaint: a pager that
	// scrolls its own state and never requests a frame looks frozen.
	assert.equal(repaints.length, 5, "one repaint per keypress: PgDn, d, u, G, g");
});

test("a document shorter than the viewport reports (all) and cannot scroll off", () => {
	const { viewer } = makeViewer({ text: "only line", rows: () => 10 });
	assert.match(viewer.render(80)[0] as string, /line 1\/1 \(all\)/);
	viewer.handleInput("\x1b[6~");
	assert.match(viewer.render(80)[0] as string, /line 1\/1 \(all\)/);
});

test("Kitty keyboard protocol: every documented key still works as a CSI-u sequence", () => {
	// The cp-viewer-scroll-stuck regression: `G`, `/` and `N` were raw string
	// comparisons, so on a terminal that negotiates the Kitty protocol (Ghostty,
	// Kitty, WezTerm, recent iTerm2) they arrived as CSI-u and did nothing at all.
	setKittyProtocolActive(true);
	try {
		assert.equal(decodePlanViewAction(csiU(106)), "line-down", "j");
		assert.equal(decodePlanViewAction(csiU(107)), "line-up", "k");
		assert.equal(decodePlanViewAction(csiU(103)), "top", "g");
		assert.equal(decodePlanViewAction(csiU(103, 2)), "bottom", "shift+g");
		assert.equal(decodePlanViewAction(csiU(47)), "search", "/");
		assert.equal(decodePlanViewAction(csiU(110)), "next-match", "n");
		assert.equal(decodePlanViewAction(csiU(110, 2)), "prev-match", "shift+n");
		assert.equal(decodePlanViewAction(csiU(113)), "close", "q");
		assert.equal(decodePlanViewAction(csiU(100)), "half-down", "d");
		assert.equal(decodePlanViewAction(csiU(117)), "half-up", "u");

		const text = Array.from({ length: 200 }, (_, i) => (i === 150 ? "Unknowns and Blockers" : `line ${i}`)).join("\n");
		const { viewer } = makeViewer({ text, rows: () => 8 });
		viewer.render(80);
		viewer.handleInput(csiU(103, 2)); // G — jump to the bottom
		assert.equal(viewer.render(80)[1], "line 192");
		viewer.handleInput(csiU(103)); // g — back to the top
		// A search typed entirely in CSI-u sequences must land in the query box.
		viewer.handleInput(csiU(47));
		for (const character of "Unknowns") viewer.handleInput(csiU(character.codePointAt(0) as number));
		assert.equal(viewer.position().query, "Unknowns", "typing under the Kitty protocol reached the search box");
		viewer.handleInput("\r");
		const frame = viewer.render(80);
		assert.ok(
			frame.some((line) => line.includes("Unknowns and Blockers")),
			frame.join("\n"),
		);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("ctrl+c closes the viewer instead of trapping the operator in it", () => {
	const { viewer, done } = makeViewer({ rows: () => 5 });
	viewer.render(80);
	viewer.handleInput("\x03");
	assert.equal(done.length, 1);
});

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

// ---------------------------------------------------------------------------
// Guard tests (requirement 3): the central invariant of this job.
// ---------------------------------------------------------------------------

test("Guard A: openPlanViewer never reads a body outside a real TUI", async () => {
	const target: PlanTarget = { kind: "artifact", researchId: "cp-x", requestedId: "cp-x", path: "/tmp/does-not-matter.md", bytes: 42 };
	let readCalled = false;
	const readSource = () => {
		readCalled = true;
		return { text: SENTINEL, bytes: 42, truncated: false };
	};
	const renderLines = () => [SENTINEL];

	for (const mode of [
		{ mode: "rpc", hasUI: true },
		{ mode: "print", hasUI: false },
		{ mode: "json", hasUI: false },
	]) {
		readCalled = false;
		let notified = "";
		const { ctx } = fakeCtx({ ...mode, notify: (text) => (notified += text) });
		const result = await openPlanViewer(ctx, target, { readSource, renderLines });
		assert.equal(readCalled, false, `readSource was called in mode ${mode.mode}`);
		assert.equal(result.shown, false);
		if (mode.hasUI) {
			assert.ok(!notified.includes(SENTINEL));
			assert.ok(notified.includes(target.path));
		}
	}
});

test("Guard A2: an absent target never reads either, and names the reason, not a body", async () => {
	const target: PlanTarget = { kind: "absent", researchId: "cp-x", requestedId: "cp-x", path: "", reason: "no artifact for cp-x" };
	let readCalled = false;
	const { ctx } = fakeCtx({ mode: "tui", hasUI: true });
	const result = await openPlanViewer(ctx, target, {
		readSource: () => {
			readCalled = true;
			return { text: SENTINEL, bytes: 0, truncated: false };
		},
		renderLines: () => [],
	});
	assert.equal(readCalled, false);
	assert.equal(result.shown, false);
	assert.equal(result.reason, "absent");
});

test("Guard B: openPlanViewer is registered in no registerTool block, and no cp_ tool name matches /plan/", () => {
	const extension = commandPostSource();
	const toolBlocks = [...extension.matchAll(/pi\.registerTool\(\{[\s\S]*?\n\t\}\);/g)].map((match) => match[0]);
	for (const block of toolBlocks) {
		assert.ok(!block.includes("openPlanViewer"), "openPlanViewer appears inside a registerTool block");
		const nameMatch = block.match(/name:\s*"([a-z_]+)"/);
		if (nameMatch) assert.ok(!/plan/i.test(nameMatch[1] as string), `a registered tool name matches /plan/: ${nameMatch[1]}`);
	}
	// openPlanViewer must still be wired somewhere — the command, not a tool.
	assert.match(extension, /pi\.registerCommand\("cp-plan"/);
	assert.match(extension, /openPlanViewer\(/);
});

test("Guard C: a full non-TUI run's only ui call is notify; the module never takes an ExtensionAPI/pi parameter", async () => {
	const target: PlanTarget = { kind: "artifact", researchId: "cp-x", requestedId: "cp-x", path: "/tmp/x.md", bytes: 10 };
	const { ctx, calls } = fakeCtx({ mode: "print", hasUI: false });
	await openPlanViewer(ctx, target, {
		readSource: () => ({ text: "", bytes: 10, truncated: false }),
		renderLines: () => [],
	});
	assert.deepEqual(calls, [], "print mode has no ui at all — nothing should be called");

	// Type-level: openPlanViewer's declared arity is (ctx, target, deps) — no
	// ExtensionAPI/pi parameter exists to smuggle appendEntry/sendMessage in.
	assert.equal(openPlanViewer.length, 3);
});

test("TUI: openPlanViewer opens a full-screen overlay and focuses it", async () => {
	const target: PlanTarget = {
		kind: "artifact",
		researchId: "cp-x",
		requestedId: "cp-x",
		path: "/tmp/x.md",
		bytes: 10,
	};
	let readCalls = 0;
	let customCalls = 0;
	let captured: Record<string, unknown> | undefined;
	let focused = 0;
	const { ctx, calls } = fakeCtx({
		mode: "tui",
		hasUI: true,
		custom: (factory, options) => {
			customCalls += 1;
			captured = options as Record<string, unknown>;
			return new Promise((resolve) => {
				const done = () => resolve(undefined);
				(factory as (tui: unknown, theme: unknown, keys: unknown, done: () => void) => unknown)(
					{ terminal: { rows: 24 } },
					{},
					{},
					done,
				);
				(captured?.onHandle as (handle: { focus: () => void }) => void)?.({ focus: () => (focused += 1) });
				done();
			});
		},
	});
	const result = await openPlanViewer(ctx, target, {
		readSource: () => {
			readCalls += 1;
			return { text: "hello", bytes: 10, truncated: false };
		},
		renderLines: () => ["hello"],
	});
	assert.equal(result.shown, true);
	assert.equal(customCalls, 1);
	assert.equal(readCalls, 1);
	assert.deepEqual(calls, ["custom"]);
	assert.equal(captured?.overlay, true);
	assert.deepEqual(captured?.overlayOptions, { width: "100%", maxHeight: "100%", margin: 0 });
	assert.equal(typeof captured?.onHandle, "function");
	assert.equal(focused, 1);
});

