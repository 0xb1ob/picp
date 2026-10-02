/**
 * The TUI half of "reading the plan" (cp-9c5).
 *
 * `openPlanViewer` is the one place that decides whether an artifact or gate
 * body may be read at all: `ctx.mode === "tui" && ctx.hasUI` is checked
 * **before** `deps.readSource` is ever called. Every other mode gets a
 * message naming the path and byte count, never the body.
 *
 * Deliberately does not take `pi: ExtensionAPI` — only `ctx` and a small
 * `deps` object — so `pi.appendEntry` / `pi.sendMessage` are structurally
 * unreachable from this file. The component writes to the terminal only
 * (`ctx.ui.custom`), never to a session entry, a message, or a tool result.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { PLAN_VIEW_IDLE_TIMEOUT_MS, PLAN_VIEW_MIN_ROWS, PLAN_VIEW_RESERVED_ROWS } from "../../src/contracts.ts";
import {
	findMatches,
	formatBytes,
	formatPlanFooter,
	formatPlanHeader,
	nextMatch,
	type PlanTarget,
	sliceViewport,
	viewportRows,
} from "../../src/plan-view.ts";

/**
 * `openPlanViewer` takes the real `ExtensionContext` — not `pi: ExtensionAPI`.
 * That asymmetry is the point (Guard boundary #3): `pi.appendEntry` and
 * `pi.sendMessage` are structurally unreachable from a function that was never
 * handed the object that owns them. A test that needs a fake context casts a
 * minimal object (`{mode, hasUI, ui: {...}} as unknown as ExtensionContext`);
 * that cast is exactly how a test-only surface should look — real callers
 * always pass the real thing.
 */
export type PlanViewerCtx = ExtensionContext;

export interface OpenPlanViewerDeps {
	/** Reads the target's bytes, capped. Never called outside the TUI gate. */
	readSource(target: PlanTarget): { text: string; bytes: number; truncated: boolean };
	/** Markdown render, memoized by the caller's choice of theme/width. */
	renderLines(text: string, width: number): string[];
	/**
	 * Viewport body rows. Optional: when absent, `openPlanViewer` computes it
	 * from the real terminal the `ctx.ui.custom` factory hands it, via
	 * `viewportRows`. Tests that never reach the TUI branch (the guard tests)
	 * never need this at all.
	 */
	rows?: () => number;
	now?: () => number;
	idleTimeoutMs?: number;
}

export interface OpenPlanViewerResult {
	shown: boolean;
	reason: "absent" | "no-tui" | "closed";
	path?: string;
	bytes?: number;
}

/**
 * Open the pager for `target`, or degrade. Fail-closed: the mode/UI check
 * happens before `deps.readSource` is invoked, so a non-TUI caller (RPC,
 * print, json, or a worker that somehow loaded this file) never triggers a
 * read at all — see tests/plan-view.test.ts Guard test A.
 */
export async function openPlanViewer(ctx: PlanViewerCtx, target: PlanTarget, deps: OpenPlanViewerDeps): Promise<OpenPlanViewerResult> {
	if (target.kind === "absent") {
		const message = `${target.requestedId} plan: ${target.reason ?? "not available"}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else process.stderr.write(`${message}\n`);
		return { shown: false, reason: "absent", path: target.path };
	}

	if (!(ctx.mode === "tui" && ctx.hasUI)) {
		const size = target.bytes !== undefined ? ` (${formatBytes(target.bytes)})` : "";
		const message = ctx.hasUI
			? `${target.researchId} plan: ${target.path}${size} \u2014 open it in your own pager; the viewer needs a terminal.`
			: `${target.researchId} plan: ${target.path}${size}`;
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else process.stderr.write(`${message}\n`);
		return { shown: false, reason: "no-tui", path: target.path, ...(target.bytes !== undefined ? { bytes: target.bytes } : {}) };
	}

	// The only read in this module, gated above.
	const source = deps.readSource(target);
	await ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			const terminal = (tui as { terminal?: { rows?: number } }).terminal;
			const rows = deps.rows ?? (() => viewportRows(terminal?.rows ?? 24, PLAN_VIEW_RESERVED_ROWS, PLAN_VIEW_MIN_ROWS));
			const viewer = new PlanViewer({
				jobId: target.researchId,
				bytes: source.bytes,
				truncated: source.truncated,
				path: target.path,
				text: source.text,
				renderLines: deps.renderLines,
				rows,
				...(deps.now ? { now: deps.now } : {}),
				idleTimeoutMs: deps.idleTimeoutMs ?? PLAN_VIEW_IDLE_TIMEOUT_MS,
				// docs/tui.md §Using Components: a component that changes state outside the
				// input path (the idle timer, a resize) must ask for a repaint itself. The
				// input path already gets `requestImmediateRender` from TUI, so this is
				// belt and braces there and load-bearing everywhere else.
				onChange: () => (tui as { requestRender?: () => void }).requestRender?.(),
				onDone: () => done(undefined),
			});
			return viewer;
		},
		{
			// Full screen, no margin: same full-screen overlay options.
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
			onHandle: (handle) => handle.focus(),
		},
	);
	return { shown: true, reason: "closed", path: target.path, bytes: source.bytes };
}

// ---------------------------------------------------------------------------
// The pager component
// ---------------------------------------------------------------------------

export interface PlanViewerOptions {
	jobId: string;
	path: string;
	bytes: number;
	truncated: boolean;
	text: string;
	renderLines: (text: string, width: number) => string[];
	/** Viewport body rows; recomputed by the caller on every render (resize-safe). */
	rows: () => number;
	now?: () => number;
	idleTimeoutMs?: number;
	onDone: () => void;
	/** Ask the host for a repaint after state changed (docs/tui.md). */
	onChange?: () => void;
	/** Injectable so tests never wait on a real timer. Returns a canceller. */
	scheduleIdle?: (ms: number, onTimeout: () => void) => { cancel: () => void };
}

/**
 * What a keypress means to the pager. Decoding (which bytes are `G`) is
 * separate from semantics (what `G` does) so both halves are testable: the
 * decoder is exercised with real terminal byte sequences, including the CSI-u
 * forms a Kitty-protocol terminal sends, and the semantics with plain actions.
 */
export type PlanViewAction =
	| "line-down"
	| "line-up"
	| "page-down"
	| "page-up"
	| "half-down"
	| "half-up"
	| "top"
	| "bottom"
	| "search"
	| "next-match"
	| "prev-match"
	| "close";

/**
 * Decode one raw input chunk into a pager action.
 *
 * **Every** comparison goes through `matchesKey`. Raw equality (`data === "G"`)
 * was the cp-viewer-scroll-stuck defect: on any terminal that negotiates the
 * Kitty keyboard protocol — Ghostty, Kitty, WezTerm, recent iTerm2, i.e. most
 * of them — a printable key arrives as `\x1b[103;2u`, not as `"G"`, so `G`, `/`
 * and `N` did nothing at all and the document could not be searched or jumped
 * through. `matchesKey` handles the legacy byte, the CSI-u sequence and
 * xterm's modifyOtherKeys form in one call.
 */
export function decodePlanViewAction(data: string): PlanViewAction | undefined {
	if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return "close";
	if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "ctrl+n")) return "line-down";
	if (matchesKey(data, "up") || matchesKey(data, "k") || matchesKey(data, "ctrl+p")) return "line-up";
	if (matchesKey(data, "pageDown") || matchesKey(data, "space") || matchesKey(data, "ctrl+f") || matchesKey(data, "f")) {
		return "page-down";
	}
	if (matchesKey(data, "pageUp") || matchesKey(data, "b") || matchesKey(data, "ctrl+b")) return "page-up";
	if (matchesKey(data, "d") || matchesKey(data, "ctrl+d")) return "half-down";
	if (matchesKey(data, "u") || matchesKey(data, "ctrl+u")) return "half-up";
	if (matchesKey(data, "g") || matchesKey(data, "home")) return "top";
	if (matchesKey(data, "shift+g") || matchesKey(data, "end")) return "bottom";
	if (matchesKey(data, "/")) return "search";
	if (matchesKey(data, "shift+n")) return "prev-match";
	if (matchesKey(data, "n")) return "next-match";
	return undefined;
}

function defaultScheduleIdle(ms: number, onTimeout: () => void): { cancel: () => void } {
	const handle = setTimeout(onTimeout, ms);
	const maybeUnref = handle as unknown as { unref?: () => void };
	maybeUnref.unref?.();
	return { cancel: () => clearTimeout(handle) };
}

/**
 * A windowing pager over pre-rendered markdown lines. Never returns more than
 * `rows()` body lines plus its own header/footer (docs/tui.md §Line Width):
 * the main-screen TUI renders the whole component tree, so a component that
 * returns thousands of lines *is* the wall of text this job exists to avoid.
 */
export class PlanViewer {
	readonly #jobId: string;
	readonly #bytes: number;
	readonly #truncated: boolean;
	readonly #path: string;
	readonly #text: string;
	readonly #renderLines: (text: string, width: number) => string[];
	readonly #rows: () => number;
	readonly #onDone: () => void;
	readonly #onChange: () => void;
	readonly #scheduleIdle: (ms: number, onTimeout: () => void) => { cancel: () => void };
	readonly #idleTimeoutMs: number;

	#cache: { width: number; lines: string[] } | undefined;
	#offset = 0;
	#searching = false;
	#query = "";
	#matches: number[] = [];
	#finished = false;
	#idle: { cancel: () => void } | undefined;

	constructor(options: PlanViewerOptions) {
		this.#jobId = options.jobId;
		this.#bytes = options.bytes;
		this.#truncated = options.truncated;
		this.#path = options.path;
		this.#text = options.text;
		this.#renderLines = options.renderLines;
		this.#rows = options.rows;
		this.#onDone = options.onDone;
		this.#onChange = options.onChange ?? (() => {});
		this.#scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? PLAN_VIEW_IDLE_TIMEOUT_MS;
		this.#armIdle();
	}

	#armIdle(): void {
		this.#idle?.cancel();
		this.#idle = this.#scheduleIdle(this.#idleTimeoutMs, () => this.#finish());
	}

	#finish(): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#idle?.cancel();
		this.#onDone();
	}

	#linesFor(width: number): string[] {
		if (!this.#cache || this.#cache.width !== width) {
			this.#cache = { width, lines: this.#renderLines(this.#text, width) };
			this.#matches = findMatches(this.#cache.lines, this.#query);
		}
		return this.#cache.lines;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): string[] {
		const lines = this.#linesFor(width);
		const rows = Math.max(1, this.#rows());
		const { slice, offset } = sliceViewport(lines, this.#offset, rows);
		this.#offset = offset;
		const currentLine = lines.length === 0 ? 0 : offset + 1;
		const truncatedTag = this.#truncated ? " \u2014 truncated, see full file at " + this.#path : "";
		const header = truncateToWidth(
			formatPlanHeader(this.#jobId, this.#bytes, currentLine, lines.length, { visibleLines: rows }) + truncatedTag,
			width,
		);
		const footer = truncateToWidth(
			formatPlanFooter({ searching: this.#searching, query: this.#query, matches: this.#matches.length }),
			width,
		);
		const body = slice.map((line) => truncateToWidth(line, width));
		while (body.length < rows) body.push("");
		return [header, ...body, footer];
	}

	/** Where the viewport is, for tests and for the position indicator. */
	position(): { offset: number; searching: boolean; query: string; matches: number } {
		return { offset: this.#offset, searching: this.#searching, query: this.#query, matches: this.#matches.length };
	}

	/** Clamp the offset against the rendered document, so the indicator never lies. */
	#clamp(): void {
		const lines = this.#cache?.lines;
		const rows = Math.max(1, this.#rows());
		const maxOffset = lines ? Math.max(0, lines.length - rows) : Number.MAX_SAFE_INTEGER;
		this.#offset = Math.min(Math.max(0, this.#offset), maxOffset);
	}

	#handleSearchInput(data: string): void {
		if (matchesKey(data, "enter")) {
			this.#searching = false;
			this.#matches = findMatches(this.#cache?.lines ?? [], this.#query);
			const target = this.#matches.find((line) => line >= this.#offset) ?? this.#matches[0];
			if (target !== undefined) this.#offset = target;
			this.#clamp();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.#searching = false;
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.#query = this.#query.slice(0, -1);
			this.#matches = findMatches(this.#cache?.lines ?? [], this.#query);
			return;
		}
		// A printable character, whether it arrived raw or as a Kitty CSI-u
		// sequence. Without `decodeKittyPrintable`, typing a query on a modern
		// terminal put nothing in the box at all.
		const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
		if (printable !== undefined && printable.length === 1 && printable >= " ") {
			this.#query += printable;
			this.#matches = findMatches(this.#cache?.lines ?? [], this.#query);
		}
	}

	handleInput(data: string): void {
		this.#armIdle();
		if (this.#searching) {
			this.#handleSearchInput(data);
			this.#onChange();
			return;
		}
		const rows = Math.max(1, this.#rows());
		const lines = this.#cache?.lines ?? [];
		const action = decodePlanViewAction(data);
		if (action === undefined) return;
		if (action === "close") {
			this.#finish();
			return;
		}
		switch (action) {
			case "line-down":
				this.#offset += 1;
				break;
			case "line-up":
				this.#offset -= 1;
				break;
			case "page-down":
				this.#offset += Math.max(1, rows - 1);
				break;
			case "page-up":
				this.#offset -= Math.max(1, rows - 1);
				break;
			case "half-down":
				this.#offset += Math.max(1, Math.floor(rows / 2));
				break;
			case "half-up":
				this.#offset -= Math.max(1, Math.floor(rows / 2));
				break;
			case "top":
				this.#offset = 0;
				break;
			case "bottom":
				this.#offset = lines.length;
				break;
			case "search":
				this.#searching = true;
				this.#query = "";
				this.#matches = [];
				break;
			case "next-match": {
				const next = nextMatch(this.#matches, this.#offset, 1);
				if (next !== undefined) this.#offset = next;
				break;
			}
			case "prev-match": {
				const prev = nextMatch(this.#matches, this.#offset, -1);
				if (prev !== undefined) this.#offset = prev;
				break;
			}
		}
		this.#clamp();
		this.#onChange();
	}
}
