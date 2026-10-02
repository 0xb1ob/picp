/**
 * cp-8v1: where a command's output goes.
 *
 * `/status` and `/doctor` render documents — a fleet table with a TOTAL line, a
 * doctor report with fixes — and used to hand them to `ctx.ui.notify`, which is
 * a short fire-and-forget notice. In a TUI that is not a scrollable surface.
 *
 * The policy is a pure function so that every branch is provable without a
 * terminal, and so that the two exclusions cannot be lost in a refactor:
 * `--json` always notifies (headless callers and our own RPC tests read it), and
 * only a real TUI gets durable entries.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseOutputChannel, collapseOutputLines, LONG_OUTPUT_LINES } from "../extensions/command-post/index.ts";

const short = "FLEET 1 worker";
const long = Array.from({ length: LONG_OUTPUT_LINES + 1 }, (_, n) => `line ${n}`).join("\n");

test("a long human-readable payload becomes a durable entry, but only in a TUI", () => {
	// The whole point: entries do not participate in LLM context
	// (docs/extensions.md), so this moves where the operator reads a 40-line table
	// without changing what the model sees — which is nothing, either way.
	assert.equal(chooseOutputChannel({ mode: "tui", hasUI: true, text: long }), "entry");

	// A short notice is still a notice; an entry for two lines is ceremony.
	assert.equal(chooseOutputChannel({ mode: "tui", hasUI: true, text: short }), "notify");
	const exactlyAtLimit = Array.from({ length: LONG_OUTPUT_LINES }, (_, n) => `line ${n}`).join("\n");
	assert.equal(chooseOutputChannel({ mode: "tui", hasUI: true, text: exactlyAtLimit }), "notify");
});

test("`--json` always notifies, whatever its size", () => {
	// Headless consumers and the RPC suites read `extension_ui_request`; an entry
	// is session data with no protocol event (docs/rpc.md), so a JSON payload
	// delivered as an entry would be invisible to the caller that asked for it.
	assert.equal(chooseOutputChannel({ mode: "tui", hasUI: true, text: long, json: true }), "notify");
	assert.equal(chooseOutputChannel({ mode: "rpc", hasUI: true, text: long, json: true }), "notify");
});

test("cp-iuu: /watch's collapsed view shows the tail, in order, with the header pinned", () => {
	// A run log rendered past the window: a header, a blank line, then more
	// event lines than LONG_OUTPUT_LINES allows.
	const header = "run cp-demo · job held · demo/research · run running · turns 71 · last activity 1s ago";
	const events = Array.from({ length: 40 }, (_, n) => `12:00:${String(n).padStart(2, "0")} ⤶ turn ${n + 32} end`);
	const text = [header, "", ...events];

	const collapsed = collapseOutputLines(text, "watch");
	// The header survives collapse — the operator must always see which job and
	// phase this is, not just its most recent events.
	assert.equal(collapsed.shown[0], header);
	assert.equal(collapsed.shown[1], "");
	// The LAST event is visible without expanding.
	assert.equal(collapsed.shown.at(-1), events.at(-1));
	// Chronological order is preserved within the visible slice: newest last.
	const bodyShown = collapsed.shown.slice(2);
	assert.deepEqual(bodyShown, events.slice(events.length - bodyShown.length));
	// The collapsed-count line unambiguously describes what is hidden: older
	// lines, not "more" (which reads as "below").
	assert.equal(collapsed.hidden, events.length - bodyShown.length);
	assert.equal(collapsed.hiddenPosition, "before");
});

test("other cp-output sources still collapse to the head (their summary line comes first)", () => {
	const lines = Array.from({ length: 10 }, (_, n) => `line ${n}`);
	const collapsed = collapseOutputLines(lines, "status");
	assert.deepEqual(collapsed.shown, lines.slice(0, LONG_OUTPUT_LINES));
	assert.equal(collapsed.hidden, lines.length - LONG_OUTPUT_LINES);
	assert.equal(collapsed.hiddenPosition, "after");
});

test("a payload within the limit is never collapsed, watch or otherwise", () => {
	const lines = ["run cp-demo · turns 2", "", "12:00:00 ⤶ turn 1 end"];
	const collapsed = collapseOutputLines(lines, "watch");
	assert.deepEqual(collapsed.shown, lines);
	assert.equal(collapsed.hidden, 0);
});

test("RPC mode keeps notify, and no UI keeps stderr", () => {
	// `hasUI` is true in RPC mode because the dialog sub-protocol works, but the
	// client is a program: it gets protocol messages, not transcript entries.
	assert.equal(chooseOutputChannel({ mode: "rpc", hasUI: true, text: long }), "notify");
	assert.equal(chooseOutputChannel({ mode: "rpc", hasUI: true, text: short }), "notify");

	// print/json modes have no UI at all; stdout belongs to the transcript.
	for (const text of [short, long]) {
		assert.equal(chooseOutputChannel({ mode: "print", hasUI: false, text }), "stderr");
		assert.equal(chooseOutputChannel({ mode: "print", hasUI: false, text, json: true }), "stderr");
	}
});
