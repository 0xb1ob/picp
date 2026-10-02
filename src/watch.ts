/**
 * Watch (T24) — the run viewer over `state/runs/<job-id>/events.jsonl`.
 *
 * This is the replacement for `muxa tail`, and the difference is the whole
 * point: `muxa tail` scraped a terminal pane, so it could only ever show the
 * last N lines of *text* and could not tell a running worker from a hung one.
 * Here the log is a fact stream the parent teed itself, so the viewer renders
 * events — tool calls, turn ends, envelopes, budget warnings, the observed exit
 * — and works identically while a worker runs and long after it is gone.
 *
 * Two ported rules survive, both about *who* looks:
 *
 *  1. **The parent never polls.** command-post's rule was "inspect once, do not
 *     loop"; the parent wakes on envelopes, not on a tail. The parent's
 *     `/watch` is therefore one-shot and bounded (`PARENT_TAIL_DEFAULT`).
 *  2. **An unknown run is not an empty run.** `muxa tail` exited 2 on an unknown
 *     pane so nobody would read "no output" as "idle". `renderRun` throws
 *     `unknown_run`, and every caller surfaces that as its own refusal.
 *
 * T30 amendment: the `cmdp` CLI is **deleted**, and with it `follow()`. Nothing
 * but a human ever called that CLI, `/watch` already did everything it did
 * except an unbounded live tail, and a second entry point had to keep agreeing
 * with the parent about the home, the fleet and the renderer. A live tail is now
 * `tail -f state/runs/<job-id>/events.jsonl` — the log is a file on purpose.
 *
 * Bodies: a worker's run log contains what the worker did, including text it
 * wrote (docs/contracts.md §T19 — this is the surface `watch` renders). Every
 * rendered line is therefore capped (`WATCH_LINE_CAP`) and detailed mode shows
 * at most `WATCH_DETAIL_LINES` lines per event, so a viewer summarizes work; it
 * never reproduces an artifact.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type CpEventKind,
	type FleetRecord,
	isScriptFleetRecord,
	isSafeJobId,
	LAYOUT,
	LONG_TOOL_CALL_SECONDS,
	paths,
	type RunEvent,
	type RunStatus,
	type UnreportedWork,
} from "./contracts.ts";
import { readStatusFile } from "./run-artifacts.ts";
import { formatAge, formatCost, formatTokens, shortModel } from "./status.ts";

export class WatchError extends Error {
	readonly code: "unknown_run" | "no_session" | "unsafe_id";
	constructor(code: WatchError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Tolerant line parse, for the viewer only.
 *
 * `parseEventLog` (run-artifacts) throws on a bad line, and it must: rebuilding
 * a projection from a log with a hole in it would produce a wrong number. A
 * *viewer* has the opposite duty. A worker killed mid-`appendFileSync` can
 * leave one torn line behind forever, and the operator looking at that run is
 * usually looking precisely because something died — so an unparseable line is
 * skipped, counted, and reported in the view, and every line that does parse is
 * still shown.
 */
export function parseWatchLines(text: string): { events: RunEvent[]; skipped: number } {
	const events: RunEvent[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line) as RunEvent);
		} catch {
			skipped += 1;
		}
	}
	return { events, skipped };
}

export const WATCH_MODES = ["compact", "detailed"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];

/** No rendered line is longer than this, in either mode. */
export const WATCH_LINE_CAP = 200;

/** Detailed mode shows at most this many lines of one event's payload. */
export const WATCH_DETAIL_LINES = 5;

/** What `/watch` shows the parent when no `--last` is given. */
export const PARENT_TAIL_DEFAULT = 40;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function clip(value: string, cap = WATCH_LINE_CAP): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function timeOf(ts: string): string {
	return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

/**
 * The one-line form of an `unreported_work` observation carried on a cp event
 * (cp-0dhw). Defensive about its input: the payload is whatever was written to
 * the log, and a viewer never throws on a line it cannot read.
 */
function describeWork(value: unknown): string {
	const work = value as Partial<UnreportedWork> | undefined;
	if (!work || typeof work !== "object" || typeof work.state !== "string") return "work state unknown";
	return `${work.state} (${work.file_count ?? 0} file(s), ${work.commits_ahead ?? 0} unpushed commit(s))`;
}

/** Shown instead of a payload that came from (or went to) the artifact store. */
export const ARTIFACT_SUPPRESSED =
	"      [artifact payload not shown — the parent never reads a body; cp_artifact get <job-id> --out <file>]";

/** The first `WATCH_DETAIL_LINES` lines of a block, each capped. */
function detailLines(value: string): string[] {
	const lines = value.split("\n").filter((line) => line.trim().length > 0);
	const kept = lines.slice(0, WATCH_DETAIL_LINES).map((line) => `      ${clip(line)}`);
	if (lines.length > WATCH_DETAIL_LINES) kept.push(`      … ${lines.length - WATCH_DETAIL_LINES} more lines`);
	return kept;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const block = item as { type?: unknown; text?: unknown };
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** A one-line summary of a tool's arguments: the field that says what it did. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "file_path", "path", "pattern", "url", "query", "claim", "responseId", "job_id", "message"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return clip(value, 120);
	}
	// pi-web-access batches: web_search `queries`, fetch_content `urls` (cp-if9x).
	for (const key of ["queries", "urls"]) {
		const value = record[key];
		const joined = Array.isArray(value) ? value.filter((s) => typeof s === "string").join(", ") : "";
		if (joined.length > 0) return clip(joined, 120);
	}
	const keys = Object.keys(record);
	return keys.length === 0 ? "" : clip(keys.join(","), 60);
}

interface RenderState {
	turns: number;
	tools: number;
	/**
	 * Tool calls seen writing to (or reading) the artifact store, by id. A
	 * `tool_execution_end` carries no args, so the *start* event is where the
	 * artifact reference is recognised and remembered (cp-ti5).
	 */
	artifactCalls?: Set<string>;
}

/**
 * Does this payload name the artifact store?
 *
 * Deliberately a substring test over the whole argument blob rather than a path
 * parse: `bash` hides its paths inside a command string, and a viewer that only
 * understood `write`/`edit` would miss the way a planner actually writes its
 * report (`cat > "$CP_ARTIFACT_PATH"`).
 */
function touchesArtifactStore(payload: Record<string, unknown>): boolean {
	const blob = JSON.stringify(payload.args ?? "");
	return blob.includes(LAYOUT.artifacts) || blob.includes("CP_ARTIFACT_PATH");
}

/**
 * One event, zero or more lines. Pure, and deliberately conservative: an event
 * type this build does not know about is shown in detailed mode as its type,
 * never dropped silently and never guessed at.
 */
function renderOne(event: RunEvent, mode: WatchMode, state: RenderState): string[] {
	const at = timeOf(event.ts);
	const detailed = mode === "detailed";
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	const line = (glyph: string, text: string): string[] => [clip(`${at} ${glyph} ${text}`)];

	if (event.source === "cp") {
		switch (event.type as CpEventKind) {
			case "spawned":
				return line(
					"+",
					`spawned ${payload.profile ?? "?"} pid=${payload.pid ?? "?"} model=${payload.model ?? "?"}`,
				);
			case "prompt_sent":
			case "steer_sent":
			case "follow_up_sent": {
				const kind = event.type.replace("_sent", "");
				const receipt = payload.receipt ? ` (${payload.receipt})` : "";
				const lines = line("→", `${kind} sent${receipt}`);
				if (detailed && typeof payload.message === "string") lines.push(...detailLines(payload.message));
				return lines;
			}
			case "envelope_received":
				// The envelope summary is a headline by contract (never a body), so
				// it is safe here and it is the single most useful line in the log.
				return line("✓", `envelope ${payload.status ?? "?"}: ${clip(String(payload.summary ?? ""), 120)}`);
			case "envelope_rejected":
				return line("✗", `envelope rejected: ${clip(String(payload.reason ?? payload.errors ?? ""), 140)}`);
			case "gate_decided":
				return line(
					"⚑",
					`gate attempt ${payload.attempt ?? "?"}: ${payload.verdict ?? "?"}${payload.cause ? ` (${payload.cause})` : ""}`,
				);
			case "review_decided":
				return line(
					"⚑",
					`review attempt ${payload.attempt ?? "?"}: ${payload.verdict ?? "?"}${payload.cause ? ` (${payload.cause})` : ""}`,
				);
			case "budget_warning":
			case "budget_exceeded":
				return line("$", `${event.type.replace("_", " ")}: ${clip(String(payload.message ?? ""), 140)}`);
			case "failure":
				return line("✗", `failure ${payload.class ?? "?"}: ${clip(String(payload.message ?? ""), 140)}`);
			case "report_nudged":
				return line("!", `settled without an envelope: nudged to report (${payload.receipt ?? "?"}, settle ${payload.settles ?? "?"})`);
			// cp-0dhw: the automatic recovery prompt and its evidence. This line is
			// the difference between "a worker went quiet" and "a worker went quiet
			// with 12 files uncommitted", which is what /watch exists to show.
			case "recovery_prompted":
				return line(
					"↻",
					`recovery prompt ${payload.attempt ?? "?"}/${payload.of ?? "?"} sent (${payload.receipt ?? "?"}): ` +
						`${describeWork(payload.work)} — commit/push/report, nothing redone`,
				);
			case "settled_without_report":
				return line("◌", `settled without report (${payload.settles ?? "?"}x): ${clip(String(payload.reason ?? ""), 120)}`);
			case "recovery_exhausted":
				return line(
					"⛔",
					`automatic recovery spent after ${payload.attempts ?? "?"} prompt(s), work still on disk: ` +
						`${describeWork(payload.work)} — nothing deleted, a human decides now`,
				);
			case "teardown_refused":
				return line("⛔", `teardown refused: ${clip(String(payload.code ?? payload.message ?? ""), 140)}`);
			case "routing_resolved": {
				// cp-routing-provenance: per-axis when the event carries it (`S(explicit)/
				// high(inferred)`), and the old one-word summary for every run logged
				// before it did. Nothing is invented for an older event.
				const from = payload.provenance as { scope?: string; risk?: string } | undefined;
				const axis = (value: unknown, fallback: string, source: string | undefined): string =>
					`${value ?? fallback}${source ? `(${source})` : ""}`;
				const inputs = from
					? `${axis(payload.scope, "S", from.scope)}/${axis(payload.risk, "low", from.risk)}`
					: `${payload.scope ?? "S"}/${payload.risk ?? "low"} ${payload.inputs ?? "explicit"}`;
				return line(
					"~",
					`routing ${payload.model ?? "?"} (source=${payload.source ?? "?"}, rule=${payload.rule ?? "?"}` +
						`${payload.thinking ? `, thinking=${payload.thinking}` : ""}) inputs=${inputs}`,
				);
			}
			case "question_asked": {
				// The run log is the operator's history, not the parent's context: the
				// question belongs here in full, which is the whole point of T31.
				const options = Array.isArray(payload.options) ? ` [${(payload.options as string[]).join(" | ")}]` : "";
				const verb = payload.method === "review" ? "plan review asked" : "asked the operator";
				return line("?", `${verb}: ${clip(String(payload.question ?? ""), 140)}${options}`);
			}
			case "question_closed": {
				const answer = typeof payload.answer === "string" ? payload.answer.split("\n")[0] : undefined;
				const what =
					answer === "approve"
						? "plan approved"
						: answer === "revise"
							? "revision requested"
							: answer === "ask"
								? "operator asked"
								: `question ${payload.outcome ?? "?"}`;
				return line(payload.outcome === "answered" ? "!" : "·", `${what}${payload.answered_by ? ` by ${payload.answered_by}` : ""}`);
			}
			case "attach_opened":
				return line("⌂", `console opened by ${payload.by ?? "the operator"}`);
			case "attach_closed": {
				// Historical: counts and a duration only. The console journal is gone.
				const seconds = typeof payload.duration_ms === "number" ? Math.round(payload.duration_ms / 1000) : undefined;
				return line(
					"⌂",
					`console closed (${payload.reason ?? "?"})${seconds === undefined ? "" : ` after ${seconds}s`}: ` +
						`${payload.messages ?? 0} message(s), ${payload.answers ?? 0} answer(s), ${payload.tools ?? 0} tool call(s)`,
				);
			}
			case "budget_clamped": {
				const clamped = payload.clamped as { tokens?: boolean; cost?: boolean } | undefined;
				const which = [clamped?.tokens ? "tokens" : undefined, clamped?.cost ? "cost" : undefined]
					.filter((v): v is string => v !== undefined)
					.join(", ");
				const effective = payload.effective as { tokens?: number; cost_usd?: number } | undefined;
				return line(
					"!",
					`budget clamped (${which || "?"}): effective ${effective?.tokens ?? "?"} tokens / $${effective?.cost_usd ?? "?"} — the profile asked for more than data/budgets.json allows`,
				);
			}
			case "deps_prepared":
				return line(payload.outcome === "failed" ? "⚠" : "·", `deps ${payload.outcome ?? "?"}: ${clip(String(payload.detail ?? "?"), 160)}`);
			case "job_branch_cleaned":
				return payload.deleted === true
					? line("⌫", `removed the empty job branch ${payload.branch ?? "?"} at ${String(payload.at ?? "?").slice(0, 12)}`)
					: line("⚠", `job branch ${payload.branch ?? "?"} left in place: ${clip(String(payload.reason ?? "?"), 140)}`);
			case "shutdown_requested":
				return line("↓", "shutdown requested");
			case "process_exit":
				return line("×", `process exit code=${payload.code ?? "null"}${payload.signal ? ` signal=${payload.signal}` : ""}`);
			default:
				return detailed ? line("·", `cp:${event.type}`) : [];
		}
	}

	switch (event.type) {
		case "agent_start":
			return line("▶", "agent start");
		case "turn_end": {
			state.turns += 1;
			return line("⤶", `turn ${state.turns} end`);
		}
		case "tool_execution_start": {
			state.tools += 1;
			const name = String(payload.toolName ?? "unknown");
			const isArtifactCall = touchesArtifactStore(payload);
			if (isArtifactCall) {
				const id = String(payload.toolCallId ?? "");
				if (id) (state.artifactCalls ??= new Set()).add(id);
			}
			// A bash call can embed the artifact body directly in its command (the
			// documented `cat > "$CP_ARTIFACT_PATH" <<'EOF'` pattern), so the args
			// summary is exactly as much a leak surface as the result payload the
			// end event already suppresses (cp-ti5) — redact it here too, at the
			// start event, rather than only once the call has finished.
			const summary = isArtifactCall ? "touches the artifact store (payload not shown)" : summarizeToolArgs(name, payload.args);
			return line("⚙", `${name}${summary ? `: ${summary}` : ""}`);
		}
		case "tool_execution_end": {
			const name = String(payload.toolName ?? "unknown");
			const isError = payload.isError === true;
			const result = payload.result as { content?: unknown } | undefined;
			const text = textOfContent(result?.content);
			// cp-ti5: WATCH_DETAIL_LINES bounds one event, not a session. Repeated
			// `--detailed` calls over a long run could reassemble an artifact in the
			// parent's context — the one thing the T19 guards exist to prevent — so a
			// tool call that touched the artifact store never expands its payload
			// here, however often it is rendered. The line still appears: *that* the
			// worker wrote its report is exactly what an operator needs to see.
			const artifactCall = state.artifactCalls?.has(String(payload.toolCallId ?? "")) === true;
			if (isError) {
				// The failure *headline* clips the payload too, so an artifact call's
				// error says only that it failed. (The first version of this rule
				// suppressed the detail lines and leaked the body into the summary;
				// the test caught it, which is the point of testing a redaction.)
				if (artifactCall) return line("✗", `${name} failed (artifact payload not shown)`);
				const lines = line("✗", `${name} failed: ${clip(text, 140)}`);
				if (detailed && text) lines.push(...detailLines(text));
				return lines;
			}
			if (!detailed) return [];
			const lines = line("✓", `${name} ok`);
			if (artifactCall) {
				lines.push(ARTIFACT_SUPPRESSED);
				return lines;
			}
			if (text) lines.push(...detailLines(text));
			return lines;
		}
		case "message_end": {
			const message = payload.message as { role?: unknown; content?: unknown } | undefined;
			if (message?.role !== "assistant") return [];
			const text = textOfContent(message.content);
			if (text.trim().length === 0) return [];
			if (!detailed) return line("💬", clip(text, 140));
			return [clip(`${at} 💬`), ...detailLines(text)];
		}
		case "agent_settled":
			return line("■", "settled");
		case "auto_retry_start":
			return line("↻", `auto retry: ${clip(String(payload.reason ?? payload.error ?? ""), 120)}`);
		case "auto_retry_end":
			return line("↻", "auto retry finished");
		case "extension_error":
			return line("!", `extension error: ${clip(String(payload.error ?? payload.message ?? ""), 140)}`);
		default:
			return detailed ? line("·", event.type) : [];
	}
}

export interface RenderOptions {
	mode?: WatchMode;
	/** Keep only the last N rendered lines (the tail an operator asked for). */
	last?: number;
}

/** Fold a whole log into display lines. Counters come from the log itself. */
export function renderEvents(events: readonly RunEvent[], options: RenderOptions = {}): string[] {
	const mode = options.mode ?? "compact";
	const state: RenderState = { turns: 0, tools: 0 };
	const lines: string[] = [];
	for (const event of events) lines.push(...renderOne(event, mode, state));
	if (options.last !== undefined && options.last >= 0 && lines.length > options.last) {
		return lines.slice(lines.length - options.last);
	}
	return lines;
}

/**
 * The header: what the run *is*, from the projection and the fleet record. Run
 * phase is liveness and job phase is policy (T23's rule), so both are printed
 * and neither is derived from the other.
 */
export function renderHeader(
	jobId: string,
	status: RunStatus | undefined,
	record: FleetRecord | undefined,
	now: string,
): string {
	const parts = [`run ${jobId}`];
	if (record) parts.push(`job ${record.phase}`, `${record.project}/${record.kind}`);
	// Same rule as the fleet view: the run projection wins when it has seen an
	// event, the dispatch-time fleet record is the fallback for a run with no
	// status.json yet.
	if (record && isScriptFleetRecord(record)) {
		parts.push(`script ${record.script_path}`, `pid ${record.script_process?.pid ?? "unknown"}`);
		const exit = record.script_process ?? record.script_observed_exit;
		if (exit?.exited_at) parts.push(`exited ${exit.exited_at} (${exit.exit_code ?? exit.signal ?? "unknown"})`);
	} else {
		const model = status?.model ?? record?.worker.model;
		if (model) parts.push(`model ${shortModel(model)}`);
	}
	if (status) {
		parts.push(`run ${status.phase}`);
		parts.push(`turns ${status.turns}`, `tools ${status.tool_calls}`);
		parts.push(`${formatTokens(status.usage.total_tokens)} ${formatCost(status.usage.cost_usd)}`);
		parts.push(`events ${status.event_count}`);
		parts.push(`last activity ${formatAge(Math.max(0, Math.floor((Date.parse(now) - Date.parse(status.last_activity_at)) / 1000)))} ago`);
		if (status.current_tool) {
			const toolSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(status.current_tool.started_at)) / 1000));
			// Same rule as /status: an observed duration, never a `stalled` verdict.
			// Long is a fact worth a glyph; it is not evidence of anything by itself.
			const flag = toolSeconds >= LONG_TOOL_CALL_SECONDS ? " !" : "";
			parts.push(`current tool ${status.current_tool.name} running ${formatAge(toolSeconds)}${flag}`);
		}
		if (status.exited_at) parts.push(`exited ${status.exited_at} (code ${status.exit_code ?? "null"})`);
	} else {
		parts.push("no projection yet");
	}
	return parts.join(" · ");
}

export interface RunView {
	job_id: string;
	header: string;
	lines: string[];
	status: RunStatus | undefined;
	/** True once the child close was observed. Never inferred from silence. */
	exited: boolean;
	events_read: number;
	/** Lines that were not JSON (a torn write). Shown, never hidden. */
	skipped_lines: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface WatcherOptions {
	home: string;
	/** Optional: the fleet record lookup, for the header's job facts. */
	record?: (jobId: string) => FleetRecord | undefined;
	now?: () => Date;
}

function requireRunDir(home: string, jobId: string): string {
	if (!isSafeJobId(jobId)) {
		throw new WatchError("unsafe_id", `${JSON.stringify(jobId)} is not a job id`);
	}
	const dir = join(home, paths.runDir(jobId));
	if (!existsSync(dir)) {
		throw new WatchError(
			"unknown_run",
			`no run for ${jobId} under ${home} — this home never dispatched it (an unknown run is not an idle one)`,
		);
	}
	return dir;
}

export class RunWatcher {
	readonly home: string;
	readonly #options: WatcherOptions;
	readonly #now: () => Date;

	constructor(options: WatcherOptions) {
		this.home = options.home;
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
	}

	/** One-shot: the whole log (or its tail), rendered. Works post-mortem. */
	render(jobId: string, options: RenderOptions = {}): RunView {
		requireRunDir(this.home, jobId);
		const file = join(this.home, paths.eventsFile(jobId));
		const { events, skipped } = existsSync(file)
			? parseWatchLines(readFileSync(file, "utf8"))
			: { events: [], skipped: 0 };
		const status = readStatusFile(this.home, jobId);
		const nowIso = this.#now().toISOString();
		return {
			job_id: jobId,
			header: renderHeader(jobId, status, this.#options.record?.(jobId), nowIso),
			lines: renderEvents(events, options),
			status,
			exited: events.some((event) => event.source === "cp" && event.type === "process_exit"),
			events_read: events.length,
			skipped_lines: skipped,
		};
	}

	/**
	 * The argv for `pi --export`. The session file comes from the fleet record
	 * first (the parent wrote it at spawn), then the run projection. Neither is
	 * a guess, and when both are missing we say so instead of inventing a path.
	 */
	exportCommand(jobId: string, outFile?: string): { argv: string[]; session_file: string } {
		requireRunDir(this.home, jobId);
		const record = this.#options.record?.(jobId);
		const status = readStatusFile(this.home, jobId);
		const sessionFile = record && isScriptFleetRecord(record) ? undefined : record?.worker.session_file ?? status?.session_file;
		if (!sessionFile) {
			throw new WatchError(
				"no_session",
				`no session file recorded for ${jobId} — the run log (state/runs/${jobId}/events.jsonl) is the only history there is`,
			);
		}
		if (!existsSync(sessionFile)) {
			throw new WatchError(
				"no_session",
				`session file for ${jobId} is gone: ${sessionFile} — nothing to export, the run log survives`,
			);
		}
		return { argv: ["--export", sessionFile, ...(outFile ? [outFile] : [])], session_file: sessionFile };
	}

	/** Is there a run directory for this id at all? Total, never throws. */
	knows(jobId: string): boolean {
		try {
			requireRunDir(this.home, jobId);
			return true;
		} catch {
			return false;
		}
	}

	/** Bytes of log on disk — what an operator wants before they cat anything. */
	logSize(jobId: string): number {
		const file = join(this.home, paths.eventsFile(jobId));
		return existsSync(file) ? statSync(file).size : 0;
	}
}

/** One rendered run view, for `/watch` and for tests' goldens. */
export function formatRunView(view: RunView): string {
	const lines = [view.header, ""];
	if (view.lines.length === 0) {
		lines.push(view.events_read === 0 ? "no events yet" : "no events matched this view");
	} else {
		lines.push(...view.lines);
	}
	if (view.skipped_lines > 0) {
		lines.push("", `! ${view.skipped_lines} unparseable line(s) skipped (a torn write; everything else is intact)`);
	}
	return lines.join("\n");
}
