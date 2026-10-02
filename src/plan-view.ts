/**
 * Reading the plan (cp-9c5) — pure policy and the one file reader.
 *
 * This module resolves *what* an operator asked to view (a research artifact
 * or a gate decision, by job id) and reads its bytes, capped. It never imports
 * pi, never imports a TUI, and never decides *whether* the caller may show
 * anything — that gate lives in `extensions/command-post/plan-viewer.ts`,
 * which is the only consumer of `readPlanSource`.
 *
 * Import discipline (Constraints): only `node:*` and `./contracts.ts`. Every
 * other dependency (Checkpoint.research_id, PipelineStore.findByShipId) is
 * injected as a plain function, so this file never needs to know those
 * modules exist and stays testable with no fixtures beyond a temp directory.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeJobId, paths } from "./contracts.ts";

export type PlanTargetKind = "artifact" | "gate" | "absent";

export interface PlanTarget {
	kind: PlanTargetKind;
	/** The research job whose artifact/gate this resolves to. */
	researchId: string;
	/** The id the operator actually typed (may be a ship id). */
	requestedId: string;
	/** Absolute path — existing for artifact/gate, expected for absent. */
	path: string;
	/** Size on disk, when the target exists. */
	bytes?: number;
	/** Only for kind "gate": which attempt this is. */
	attempt?: number;
	/** Only for kind "absent": why nothing was found. */
	reason?: string;
}

/** What `resolvePlanTarget` needs from the rest of the home, injected. */
export interface PlanViewDeps {
	/** Command post home; artifact and gate paths are resolved under it. */
	home: string;
	/** `Checkpoint.research_id` for this job id, when a checkpoint exists. */
	checkpointResearchId(jobId: string): string | undefined;
	/** `PipelineStore.findByShipId(jobId)?.research_id`. */
	pipelineResearchIdForShip(jobId: string): string | undefined;
}

export interface ResolvePlanOptions {
	/** Absent: artifact. `true`: gate, highest attempt on disk. `n`: that attempt. */
	gate?: true | number;
}

/** Every research id worth trying for a given (possibly ship) job id, in order, deduplicated. */
function candidateResearchIds(jobId: string, deps: PlanViewDeps): string[] {
	const candidates = [jobId];
	const viaCheckpoint = deps.checkpointResearchId(jobId);
	if (viaCheckpoint && !candidates.includes(viaCheckpoint)) candidates.push(viaCheckpoint);
	const viaPipeline = deps.pipelineResearchIdForShip(jobId);
	if (viaPipeline && !candidates.includes(viaPipeline)) candidates.push(viaPipeline);
	return candidates;
}

/**
 * Gate attempts found on disk for a research id, contiguous from 1 (mirrors
 * `readPriorAttempts`'s own scan): a raw file counts, and so does a capped one
 * (the capped file *is* the whole decision when nothing had to be dropped).
 */
function findGateAttempts(home: string, researchId: string, max = 32): number[] {
	const found: number[] = [];
	for (let attempt = 1; attempt <= max; attempt += 1) {
		const raw = join(home, paths.gateFileRaw(researchId, attempt));
		const capped = join(home, paths.gateFile(researchId, attempt));
		if (existsSync(raw) || existsSync(capped)) found.push(attempt);
		else break;
	}
	return found;
}

function resolveGateFile(
	home: string,
	researchId: string,
	gate: true | number,
): { path: string; attempt: number; bytes: number } | undefined {
	const attempts = findGateAttempts(home, researchId);
	if (attempts.length === 0) return undefined;
	const attempt = gate === true ? (attempts[attempts.length - 1] as number) : gate;
	if (!attempts.includes(attempt)) return undefined;
	const raw = join(home, paths.gateFileRaw(researchId, attempt));
	const capped = join(home, paths.gateFile(researchId, attempt));
	const path = existsSync(raw) ? raw : capped;
	return { path, attempt, bytes: statSync(path).size };
}

/**
 * Resolve a job id (research or ship) to a viewable document. Total: an unsafe
 * id, an unknown job or a missing file all come back as `kind: "absent"` with
 * a reason naming the expected path — never a throw.
 */
export function resolvePlanTarget(jobId: string, deps: PlanViewDeps, options: ResolvePlanOptions = {}): PlanTarget {
	if (!isSafeJobId(jobId)) {
		return { kind: "absent", researchId: jobId, requestedId: jobId, path: "", reason: `unsafe job id ${JSON.stringify(jobId)}` };
	}
	const candidates = candidateResearchIds(jobId, deps);

	if (options.gate !== undefined) {
		for (const researchId of candidates) {
			const resolved = resolveGateFile(deps.home, researchId, options.gate);
			if (resolved) {
				return {
					kind: "gate",
					researchId,
					requestedId: jobId,
					path: resolved.path,
					bytes: resolved.bytes,
					attempt: resolved.attempt,
				};
			}
		}
		const attemptLabel = options.gate === true ? "any attempt" : `attempt ${options.gate}`;
		return {
			kind: "absent",
			researchId: jobId,
			requestedId: jobId,
			path: "",
			reason: `no gate decision (${attemptLabel}) for ${jobId} (checked: ${candidates.join(", ")})`,
		};
	}

	for (const researchId of candidates) {
		const file = join(deps.home, paths.artifactFile(researchId));
		if (existsSync(file) && statSync(file).isFile() && statSync(file).size > 0) {
			return { kind: "artifact", researchId, requestedId: jobId, path: file, bytes: statSync(file).size };
		}
	}
	const expected = join(deps.home, paths.artifactFile(jobId));
	return {
		kind: "absent",
		researchId: jobId,
		requestedId: jobId,
		path: expected,
		reason: `no artifact for ${jobId} \u2014 expected ${expected}`,
	};
}

export interface ReadPlanResult {
	text: string;
	/** Full size on disk, even when truncated. */
	bytes: number;
	truncated: boolean;
}

/**
 * Read a plan source, capped at `maxBytes`. The one function in this repo
 * that reads an artifact body — its only caller is `openPlanViewer`, gated on
 * `ctx.mode === "tui" && ctx.hasUI` before this is ever invoked.
 */
export function readPlanSource(path: string, maxBytes: number): ReadPlanResult {
	const stats = statSync(path);
	if (stats.size <= maxBytes) {
		return { text: readFileSync(path, "utf8"), bytes: stats.size, truncated: false };
	}
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return { text: buffer.subarray(0, read).toString("utf8"), bytes: stats.size, truncated: true };
	} finally {
		closeSync(fd);
	}
}

const GATE_KNOWN_KEYS = [
	"schema_version",
	"job_id",
	"attempt",
	"verdict",
	"cause",
	"flags",
	"reasons",
	"revisions",
	"model",
	"decided_at",
];

/**
 * Render a gate decision (parsed JSON, `gate-<n>-raw.json` or `gate-<n>.json`)
 * as markdown, so the pager's one rendering path (`Markdown.render`) never
 * needs to know it is looking at a gate document instead of a report.
 * Tolerates unexpected top-level fields rather than throwing (Unknowns/Blockers
 * #5): they are appended verbatim as a JSON code block.
 */
export function renderGateDocument(raw: unknown, jobId: string): string {
	const obj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
	const lines: string[] = [`# Gate decision \u2014 ${jobId}`, ""];
	if (typeof obj.verdict === "string") lines.push(`**Verdict:** ${obj.verdict}`);
	if (typeof obj.cause === "string") lines.push(`**Cause:** ${obj.cause}`);
	if (typeof obj.attempt === "number") lines.push(`**Attempt:** ${obj.attempt}`);
	if (typeof obj.model === "string") lines.push(`**Model:** ${obj.model}`);
	if (typeof obj.decided_at === "string") lines.push(`**Decided at:** ${obj.decided_at}`);
	if (obj.flags && typeof obj.flags === "object") {
		lines.push("", "## Flags", "", "```json", JSON.stringify(obj.flags, null, 2), "```");
	}
	if (Array.isArray(obj.reasons) && obj.reasons.length > 0) {
		lines.push("", "## Reasons", "");
		for (const reason of obj.reasons) lines.push(`- ${String(reason)}`);
	}
	if (Array.isArray(obj.revisions) && obj.revisions.length > 0) {
		lines.push("", "## Revisions", "");
		for (const revision of obj.revisions) lines.push(`- ${String(revision)}`);
	}
	const unknownKeys = Object.keys(obj).filter((key) => !GATE_KNOWN_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		const extra = Object.fromEntries(unknownKeys.map((key) => [key, obj[key]]));
		lines.push("", "## Additional fields", "", "```json", JSON.stringify(extra, null, 2), "```");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Viewport maths (pure — no terminal, no theme)
// ---------------------------------------------------------------------------

/** Terminal rows to viewport body rows, clamped to a floor. */
export function viewportRows(terminalRows: number, reservedRows: number, minRows: number): number {
	return Math.max(minRows, terminalRows - reservedRows);
}

export interface ViewportSlice {
	slice: string[];
	/** The clamped offset actually used (never negative, never past the end). */
	offset: number;
}

/** Slice `lines` for display, clamping `offset` into range instead of throwing. */
export function sliceViewport(lines: readonly string[], offset: number, rows: number): ViewportSlice {
	if (rows <= 0 || lines.length === 0) return { slice: [], offset: 0 };
	const maxOffset = Math.max(0, lines.length - rows);
	const clamped = Math.min(Math.max(0, offset), maxOffset);
	return { slice: lines.slice(clamped, clamped + rows), offset: clamped };
}

/** Strip ANSI SGR/OSC sequences before searching or measuring "real" text. */
export function stripAnsiSequences(line: string): string {
	// biome-ignore lint: control-character regex is the point here.
	return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** Every line index (0-based) whose stripped text contains `query`, case-insensitively. */
export function findMatches(lines: readonly string[], query: string): number[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];
	const needle = trimmed.toLowerCase();
	const matches: number[] = [];
	lines.forEach((line, index) => {
		if (stripAnsiSequences(line).toLowerCase().includes(needle)) matches.push(index);
	});
	return matches;
}

/**
 * The next (or previous, `direction: -1`) match relative to `current`, wrapping
 * around. `undefined` when there are no matches at all. `current` need not
 * itself be a match — search jumps to the nearest one in that direction.
 */
export function nextMatch(matches: readonly number[], current: number, direction: 1 | -1): number | undefined {
	if (matches.length === 0) return undefined;
	const at = matches.indexOf(current);
	if (at === -1) {
		if (direction === 1) return matches.find((line) => line > current) ?? matches[0];
		const reversed = [...matches].reverse();
		return reversed.find((line) => line < current) ?? matches[matches.length - 1];
	}
	const nextIndex = (at + direction + matches.length) % matches.length;
	return matches[nextIndex];
}

/** `42 KB`, `1.3 MB`, `812 B` — the only units the chrome ever needs. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Where the viewport sits, as a word rather than a number the operator has to
 * do arithmetic on: `top`, `bot`, or a percentage. `visibleLines` is what makes
 * `bot` honest — the last page starts well before the last line.
 */
export function formatPlanPosition(currentLine: number, totalLines: number, visibleLines?: number): string {
	if (totalLines <= 0) return "empty";
	if (visibleLines !== undefined) {
		if (currentLine <= 1 && visibleLines >= totalLines) return "all";
		if (currentLine <= 1) return "top";
		if (currentLine + visibleLines - 1 >= totalLines) return "bot";
	}
	return `${Math.round((currentLine / totalLines) * 100)}%`;
}

/**
 * `cp-xyz — plan · 42 KB · line 120-153/4662 (3%)`. The position indicator is
 * chrome the viewer must always show: an operator paging through 70 KB has no
 * other way to know where they are or that the document moved at all.
 */
export function formatPlanHeader(
	jobId: string,
	bytes: number,
	currentLine: number,
	totalLines: number,
	options: { visibleLines?: number } = {},
): string {
	const visible = options.visibleLines;
	const position = formatPlanPosition(currentLine, totalLines, visible);
	const lastLine = visible !== undefined ? Math.min(totalLines, currentLine + Math.max(1, visible) - 1) : undefined;
	const range = lastLine !== undefined && lastLine > currentLine ? `${currentLine}-${lastLine}` : `${currentLine}`;
	return `${jobId} \u2014 plan \u00b7 ${formatBytes(bytes)} \u00b7 line ${range}/${totalLines} (${position})`;
}

/**
 * The documented key map, in the footer where the operator can see it. Every
 * key here is matched through pi-tui's `matchesKey` (never a raw string
 * comparison), so it works on a legacy terminal and on one that negotiated the
 * Kitty keyboard protocol, where a printable key arrives as a CSI-u sequence.
 */
export const PLAN_VIEW_LEGEND =
	"\u2193/\u2191 j/k scroll \u00b7 PgDn/PgUp Spc/b page \u00b7 d/u half \u00b7 g/G Home/End top/bottom \u00b7 / search \u00b7 n/N match \u00b7 q/Esc close";

/** The footer chrome line: the key legend, or the search prompt while typing. */
export function formatPlanFooter(state: { searching: boolean; query?: string; matches?: number }): string {
	if (state.searching) {
		const count = state.matches === undefined ? "" : ` (${state.matches} match${state.matches === 1 ? "" : "es"})`;
		return `search: ${state.query ?? ""}\u2588${count}`;
	}
	if (state.query && state.query.length > 0) {
		const count = state.matches ?? 0;
		return `${PLAN_VIEW_LEGEND} \u00b7 "${state.query}": ${count} match${count === 1 ? "" : "es"}`;
	}
	return PLAN_VIEW_LEGEND;
}
