/**
 * The TUI half of the fleet widget (cp-8tu): role → theme, and nothing else.
 *
 * The renderer (`src/widget.ts`) is pure and plain: it returns `{text, role}`
 * per line and never emits an escape sequence. This file is the only place a
 * colour is chosen, and it runs **only** in the TUI path. Three reasons that
 * split is structural rather than stylistic:
 *
 *  - **RPC gets plain strings.** docs/rpc.md §setWidget: "Only string arrays
 *    are supported in RPC mode; component factories are ignored" — an RPC
 *    client receives `widgetLines` verbatim, so ANSI there would corrupt a
 *    programmatic consumer (and this repo's own RPC assertions).
 *  - **Goldens stay readable.** No test needs a theme to pin a layout.
 *  - **Colour is never the only carrier.** Every distinction is also a glyph
 *    and a spelled-out word, so `NO_COLOR`, a monochrome terminal and the RPC
 *    path all lose emphasis and lose no information.
 *
 * **On font size.** The operator asked for the worker rows in a smaller font
 * than the headers. No terminal application can do that: pi's `Theme` exposes
 * exactly `fg`/`bg`/`bold`/`italic`/`underline`/`inverse`/`strikethrough`, a
 * widget is a list of lines, and a line is a row of terminal cells whose size
 * belongs to the emulator. Double-height (DECDHL) is not a substitute — pi
 * renders a diffed, padded, full-width buffer and would count a double-height
 * line as one row while it occupied two, corrupting the editor below. So the
 * hierarchy is carried by intensity instead, named here rather than silently
 * swapped: headers bold, running rows' cells `dim` from the id onward.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WidgetLine } from "../../src/widget.ts";

/** The style each role carries. Colour tokens only (docs/tui.md §Theme tokens). */
export function styleWidgetLine(theme: Theme, line: WidgetLine): string {
	switch (line.role) {
		case "marker":
			// The brightest thing in the widget: an open decision must be the first
			// thing the eye lands on (cp-av8's "impossible to miss even if every
			// dialog is dismissed").
			return theme.bold(theme.fg("warning", line.text));
		case "headline":
			return theme.bold(theme.fg("text", line.text));
		case "section":
			return theme.bold(theme.fg("accent", line.text));
		case "section-alert":
			return theme.bold(theme.fg("error", line.text));
		case "overflow":
			return theme.fg("dim", line.text);
		case "row":
		case "row-alert":
			return styleRow(theme, line);
	}
}

function styleRow(theme: Theme, line: WidgetLine): string {
	const glyphColor = line.role === "row-alert" ? "error" : "accent";
	const at = line.glyphAt ?? -1;
	if (at < 0 || at >= line.text.length) return theme.fg("text", line.text);
	const head = line.text.slice(0, at);
	const glyph = theme.fg(glyphColor, line.text.slice(at, at + 1));
	const rest = line.text.slice(at + 1);
	// The recessive half: everything after the job id on a running row. `dim` is a
	// theme colour token, not SGR 2 faint, so it survives a terminal that ignores
	// faint and still reads as secondary.
	const split = line.dimFrom === undefined ? -1 : line.dimFrom - (at + 1);
	if (split <= 0 || split >= rest.length) return `${head}${glyph}${theme.fg("text", rest)}`;
	return `${head}${glyph}${theme.fg("text", rest.slice(0, split))}${theme.fg("dim", rest.slice(split))}`;
}

/** Every line, styled. The array pi's component factory renders. */
export function styleWidgetLines(theme: Theme, lines: readonly WidgetLine[]): string[] {
	return lines.map((line) => styleWidgetLine(theme, line));
}
