/**
 * The fleet widget (cp-8tu) — "grouped by what it asks of you".
 *
 * `ctx.ui.setWidget` is the one surface the operator sees *without asking*, so
 * its job is not density: it is answering "does anything want me?" before any
 * number is read. Three sections, fixed order, each drawn only when it has a
 * row:
 *
 *   NEEDS YOU   a human is the blocker (a worker's question, an open
 *               Awaiting-you item)
 *   ATTENTION   failed, exited without an envelope, or a tool call open past
 *               LONG_TOOL_CALL_SECONDS
 *   RUNNING     everything else — so no job is ever silently dropped
 *
 * Membership is `jobState()` (`status-render.ts`), computed from facts already
 * on `StatusJob`. Nothing new is read: the widget stays **files-only** because
 * it refreshes on a timer, and a 5-second `br`/`gh` call is not a widget.
 *
 * Three properties this module owes the operator, each pinned by a test:
 *
 *  1. **Every line fits.** pi wraps — it does not truncate — a widget line
 *     longer than the usable width (`Text#render` → `wrapTextWithAnsi`), so an
 *     overlong line silently becomes two and the editor below jumps. The
 *     budget is a parameter, never a guess about the terminal.
 *  2. **Columns are fleet-wide.** The old renderer picked its degradation per
 *     row, so the model vanished from the two rows with long job ids and stayed
 *     on the others — a column that is neither aligned nor comparable, with no
 *     visible sign a field was missing. The ladder now runs once for the whole
 *     fleet: every running row shows the same columns, or none does.
 *  3. **Height is bounded at 10 lines** — pi's own cap
 *     (`InteractiveMode.MAX_WIDGET_LINES`), beyond which it slices the array
 *     and appends `... (widget truncated)`. Overflow collapses per section,
 *     with a count, and NEEDS YOU is the last thing to collapse.
 *
 * **No blank lines, ever.** `Text#render` returns `[]` for a whitespace-only
 * line, so a spacer would vanish in the TUI and survive in RPC — two different
 * layouts from one renderer. Section headers are the separator.
 *
 * **Plain text in, roles out.** Every line carries a `role`; the extension maps
 * role → theme in the TUI path only. RPC clients get the strings verbatim (see
 * docs/rpc.md §setWidget: component factories are ignored there), so no ANSI is
 * ever embedded here, and no test needs a theme.
 */

import {
	describeUnreportedWork,
	type StatusJob,
	type StatusSnapshot,
	unreportedWorkPresent,
} from "./contracts.ts";
import {
	ageSeconds,
	chooseTokenUnit,
	formatAge,
	formatCost,
	formatScopeRisk,
	formatThinking,
	formatTokensIn,
	type JobStateKind,
	jobState,
	shortModel,
	type TokenUnit,
	WAIT_REASON_MAX_CHARS,
	waitReason,
	type WidgetSection,
} from "./status-render.ts";

/**
 * pi truncates a widget at exactly 10 lines and appends its own truncation
 * line (`interactive-mode.js`: `MAX_WIDGET_LINES = 10`). Ten is therefore a
 * ceiling, not a taste: past it our own overflow line is what gets eaten.
 */
export const WIDGET_MAX_LINES = 10;

/**
 * The RPC fallback width only. In the TUI the real width is handed to
 * `render(width)`; in the string-array path pi insets each line by one column
 * on both sides, so the usable budget there is `terminalWidth - 2` — which is
 * a number this process cannot see over RPC, hence a documented constant.
 */
export const WIDGET_MAX_WIDTH = 100;

/** Below this the columns stop meaning anything; the widget summarises instead. */
export const WIDGET_MIN_WIDTH = 60;

/** A job id shorter than this is not identifiable, so it is never squeezed further. */
export const WIDGET_ID_MIN = 12;

/** And no single long id may eat the line: past this it truncates with an ellipsis. */
export const WIDGET_ID_MAX = 28;

/** Nor may the id column outgrow this share of a narrow terminal (defect 1c:
 * `cp-rebase-before-report-jue` spent 27 of the old 100-column budget first). */
const ID_WIDTH_SHARE = 0.3;

export type WidgetRole = "marker" | "headline" | "section" | "section-alert" | "row" | "row-alert" | "overflow";

export interface WidgetLine {
	text: string;
	role: WidgetRole;
	/**
	 * Column at which a running row's **recessive** half begins (everything after
	 * the job id: model, routing, activity, age, tokens, cost). The operator asked
	 * for the worker rows in a smaller font; a terminal has no font size (see
	 * docs/contracts.md §the widget), so the hierarchy is carried by intensity —
	 * the styler dims from here on. Absent on every line that has no such half.
	 */
	dimFrom?: number;
	/** Column of the state glyph, so a styler can accent exactly that cell. */
	glyphAt?: number;
}

/** The subset of `ResolvedAwaitingItem` the widget reads. Structural on purpose:
 * `src/awaiting.ts` owns that type, and the renderer must stay pure over data. */
export interface WidgetAwaitingItem {
	id?: string;
	type?: string;
	decision?: string;
	job_id?: string;
}

export interface RenderFleetWidgetOptions {
	/** Usable columns. Defaults to the RPC fallback (`WIDGET_MAX_WIDTH`). */
	width?: number;
	/** Hard line cap, including the `⧗` marker. Defaults to pi's own 10. */
	maxLines?: number;
	/** Open Awaiting-you items (cp-av8), already computed by the caller. */
	awaiting?: readonly WidgetAwaitingItem[];
	/** ASCII-only output for a terminal that cannot draw the glyphs. */
	ascii?: boolean;
}

// ---------------------------------------------------------------------------
// Alphabet
// ---------------------------------------------------------------------------

interface Charset {
	glyph(kind: JobStateKind): string;
	marker: string;
	ellipsis: string;
	dot: string;
	emdash: string;
	/** Free text (a question, a decision, a failure message) passed through the
	 * same alphabet, so `ascii` is a property of the whole line, not of ours. */
	text(value: string): string;
}

const UNICODE_GLYPHS: Readonly<Record<JobStateKind, string>> = Object.freeze({
	asked: "?",
	approval: "\u25c6",
	// Its own glyph, never the failure cross: the work is probably there, only
	// the envelope is missing (cp-settle-without-report).
	unreported: "\u25cc",
	failed: "\u2717",
	exited: "\u2717",
	"long-tool": "!",
	working: "\u25b6",
	idle: "\u25cb",
	starting: "\u25cb",
	"no-pid": "\u25cb",
	unknown: "\u25cb",
});

const ASCII_GLYPHS: Readonly<Record<JobStateKind, string>> = Object.freeze({
	asked: "?",
	approval: "#",
	unreported: "~",
	failed: "x",
	exited: "x",
	"long-tool": "!",
	working: ">",
	idle: "o",
	starting: "o",
	"no-pid": "o",
	unknown: "o",
});

const UNICODE: Charset = {
	glyph: (kind) => UNICODE_GLYPHS[kind],
	marker: "\u29d7",
	ellipsis: "\u2026",
	dot: "\u00b7",
	emdash: "\u2014",
	text: (value) => value,
};

const ASCII: Charset = {
	glyph: (kind) => ASCII_GLYPHS[kind],
	marker: "!",
	ellipsis: "...",
	dot: "-",
	// `--` rather than `-`: the whole-cell "no routing decision on record"
	// placeholder must stay distinguishable from a single missing side (`-`).
	emdash: "--",
	// Operator-supplied text can contain anything; in ASCII mode a codepoint the
	// terminal cannot draw becomes `?` rather than a mojibake column shift.
	text: (value) => value.replace(/[^\x20-\x7e]/g, "?"),
};

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function truncateCell(value: string, width: number, charset: Charset): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	const room = width - charset.ellipsis.length;
	if (room <= 0) return value.slice(0, width);
	return `${value.slice(0, room)}${charset.ellipsis}`;
}

function padEnd(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
	return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/** The routing cell: scope/risk/thinking, or the one unknown placeholder. */
function routingCell(job: StatusJob, charset: Charset): string {
	if (!job.routing) return charset.emdash;
	return `${formatScopeRisk(job)}/${formatThinking(job)}`.replaceAll("\u2014", charset.emdash);
}

/**
 * The activity cell (defect 6). A tool name only while a call is actually open,
 * with the long-call marker inline (`bash 7m!`); otherwise the state word, and
 * for an idle worker the time since its last event — a fact `/watch` already
 * showed and the widget did not, in place of a `-` that carried nothing.
 */
function activityCell(job: StatusJob, kind: JobStateKind, word: string, now: string): string {
	if (job.current_tool) {
		const seconds = job.current_tool_seconds;
		return kind === "long-tool" && seconds !== null ? `${job.current_tool} ${formatAge(seconds)}!` : job.current_tool;
	}
	if ((kind === "idle" || kind === "starting") && job.last_activity_at) {
		return `${word} ${formatAge(ageSeconds(job.last_activity_at, now))}`;
	}
	return word;
}

/** One space before a non-empty suffix, nothing before an empty one. */
function withGap(suffix: string): string {
	return suffix === "" ? "" : ` ${suffix}`;
}

function firstLine(value: string): string {
	return value.split("\n")[0] ?? "";
}

/** `cp-x: ship, drop or follow-up?` → `ship, drop or follow-up?` (the id is
 * already the row's own first column; repeating it spends columns on nothing). */
function withoutIdPrefix(decision: string, jobId: string): string {
	return decision.startsWith(`${jobId}: `) ? decision.slice(jobId.length + 2) : decision;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface FreeRow {
	kind: "free";
	glyph: string;
	id: string;
	text: string;
	alert: boolean;
}

interface ColumnRow {
	kind: "columns";
	glyph: string;
	id: string;
	model: string;
	routing: string;
	activity: string;
	age: string;
	tokens: string;
	cost: string;
}

type Row = FreeRow | ColumnRow;

interface Section {
	section: WidgetSection;
	header: string;
	alert: boolean;
	rows: Row[];
	/** What the per-section overflow line says, and where it sends the operator. */
	label: string;
	hint: string;
}

/** `3 blockers` on a waiting planner. Ordinary row, not a marker. */
function blockerMark(job: StatusJob): string {
	const n = job.blockers;
	if (!n) return "";
	return `${n} blocker${n === 1 ? "" : "s"}`;
}

/** `gate 2 ⋅ 4m`: a reviewer is running for this job (spec 2026-09-05). Never a phase. */
function reviewMark(job: StatusJob, now: string, charset: Charset): string {
	const pending = job.pending_review;
	if (!pending) return "";
	return `${pending.surface} ${pending.attempt} ${charset.dot} ${formatAge(ageSeconds(pending.started_at, now))}`;
}

/**
 * `waits: CI on d48a81d` — what a held row is waiting on (cp-status-wait-reasons).
 *
 * Empty for every job with nothing disk-derived to say, which is every running
 * and every unblocked row, so those are byte-identical to what they were (a
 * reviewer in flight is one of those: `reviewMark` above already says it).
 *
 * The cell is bounded by `WAIT_REASON_MAX_CHARS`, which every phrase already
 * fits — the activity column is fleet-wide, so an unbounded reason would drop
 * MODEL or SCOPE/RISK off every row in the fleet, and a *clipped* one would cut
 * the short sha in half. The `truncateCell` call is therefore a guard against
 * a future phrase, never a working truncation.
 */
function waitMark(job: StatusJob, charset: Charset): string {
	const reason = waitReason(job);
	return reason === null ? "" : `waits: ${truncateCell(reason, WAIT_REASON_MAX_CHARS, charset)}`;
}

function needsRow(job: StatusJob, item: WidgetAwaitingItem | undefined, now: string, charset: Charset): FreeRow {
	if (job.open_question) {
		const when = `asked ${formatAge(ageSeconds(job.open_question.asked_at, now))} ago`;
		return {
			kind: "free",
			glyph: charset.glyph("asked"),
			id: job.job_id,
			text: `${charset.text(`${when}: ${firstLine(job.open_question.question)}`)}`,
			alert: true,
		};
	}
	const decision = item?.decision ? withoutIdPrefix(item.decision, job.job_id) : "needs a decision";
	return {
		kind: "free",
		glyph: charset.glyph("approval"),
		id: job.job_id,
		text: `${charset.text(`${job.kind} held ${formatAge(job.age_seconds)}: ${decision}`)}`,
		alert: false,
	};
}

function attentionRow(job: StatusJob, kind: JobStateKind, word: string, now: string, charset: Charset): FreeRow {
	const parts: string[] = [];
	if (kind === "long-tool" && job.current_tool && job.current_tool_seconds !== null) {
		parts.push(`${job.current_tool} running ${formatAge(job.current_tool_seconds)}`);
	} else {
		parts.push(`${word} ${formatAge(job.age_seconds)} ago`);
	}
	// The one row where the state word alone would understate the situation: say
	// what is missing and what it is worth checking (cp-settle-without-report).
	// cp-0dhw: and which of the two unreported situations it is. "No envelope
	// filed" reads like nothing is at risk; "4 files uncommitted" does not.
	if (kind === "unreported") {
		parts.push(
			unreportedWorkPresent(job.unreported_work) && job.unreported_work
				? `no envelope filed; work on disk: ${describeUnreportedWork(job.unreported_work)}`
				: "no envelope filed; check the branch/PR",
		);
	}
	if (job.failure) parts.push(job.failure.class);
	parts.push(`/watch ${job.job_id}`);
	return { kind: "free", glyph: charset.glyph(kind), id: job.job_id, text: charset.text(parts.join(` ${charset.dot} `)), alert: true };
}

function runningRow(job: StatusJob, kind: JobStateKind, word: string, unit: TokenUnit, now: string, charset: Charset): ColumnRow {
	return {
		kind: "columns",
		glyph: charset.glyph(kind),
		id: job.job_id,
		model: charset.text(shortModel(job.model)),
		routing: routingCell(job, charset),
		activity: `${charset.text(activityCell(job, kind, word, now))}${withGap(blockerMark(job))}${withGap(reviewMark(job, now, charset))}${withGap(waitMark(job, charset))}`,
		age: formatAge(job.age_seconds),
		tokens: formatTokensIn(job.usage.total_tokens, unit),
		cost: formatCost(job.usage.cost_usd),
	};
}

// ---------------------------------------------------------------------------
// The fleet-wide column ladder
// ---------------------------------------------------------------------------

/** First dropped to last. `COST`, the age, the id and the glyph never appear
 * here: they are the fields the operator relies on most, and the rule since
 * cp-status-scope-risk has been that a column is dropped **whole**, fleet-wide,
 * before any field after it is touched — never truncated into something that
 * still looks like a valid value. */
const LADDER = ["routing", "model", "tokens", "activity"] as const;
type Droppable = (typeof LADDER)[number];

interface Layout {
	idWidth: number;
	model: number;
	routing: number;
	activity: number;
	age: number;
	tokens: number;
	cost: number;
	shown: ReadonlySet<Droppable>;
	/** True when even the minimum row does not fit: sections collapse to one line. */
	compact: boolean;
}

const GAP = 2;
/** `"  " + glyph + " "` — two columns of indent, the glyph, one separator. */
const PREFIX = 4;

function widest(values: readonly string[]): number {
	let max = 0;
	for (const value of values) if (value.length > max) max = value.length;
	return max;
}

function layoutFor(sections: readonly Section[], width: number): Layout {
	const columnRows = sections.flatMap((section) => section.rows.filter((row): row is ColumnRow => row.kind === "columns"));
	const allRows = sections.flatMap((section) => section.rows);
	const idCap = Math.max(WIDGET_ID_MIN, Math.min(WIDGET_ID_MAX, Math.floor(width * ID_WIDTH_SHARE)));
	const natural = {
		id: Math.min(widest(allRows.map((row) => row.id)), idCap),
		model: widest(columnRows.map((row) => row.model)),
		routing: widest(columnRows.map((row) => row.routing)),
		activity: widest(columnRows.map((row) => row.activity)),
		age: widest(columnRows.map((row) => row.age)),
		tokens: widest(columnRows.map((row) => row.tokens)),
		cost: widest(columnRows.map((row) => row.cost)),
	};

	const shown = new Set<Droppable>(LADDER);
	const total = (idWidth: number): number => {
		let sum = PREFIX + idWidth;
		for (const key of LADDER) if (shown.has(key) && natural[key] > 0) sum += GAP + natural[key];
		if (natural.age > 0) sum += GAP + natural.age;
		if (natural.cost > 0) sum += GAP + natural.cost;
		return sum;
	};

	// Fleet-wide, in ladder order: a column is present on every running row or on
	// none. This is the fix for the reported defect — the old renderer chose per
	// row, so the model disappeared from exactly the two rows with the longest
	// job ids and nothing said a field was missing.
	for (const key of LADDER) {
		if (columnRows.length === 0) break;
		if (total(natural.id) <= width) break;
		shown.delete(key);
	}
	let idWidth = natural.id;
	if (total(idWidth) > width) idWidth = Math.max(WIDGET_ID_MIN, width - (total(idWidth) - idWidth));
	const compact = width < WIDGET_MIN_WIDTH || total(idWidth) > width;
	return {
		idWidth,
		model: natural.model,
		routing: natural.routing,
		activity: natural.activity,
		age: natural.age,
		tokens: natural.tokens,
		cost: natural.cost,
		shown,
		compact,
	};
}

function renderRow(row: Row, layout: Layout, width: number, charset: Charset): string {
	const prefix = `  ${row.glyph} `;
	const id = padEnd(truncateCell(row.id, layout.idWidth, charset), layout.idWidth);
	if (row.kind === "free") {
		// A row with no job id (the `unclaimed` note) is not a job, so it does not
		// reserve the job column: an empty column would read as a missing id.
		if (row.id === "") return `${prefix}${truncateCell(row.text, Math.max(1, width - prefix.length), charset)}`.trimEnd();
		const room = width - prefix.length - layout.idWidth - GAP;
		const text = truncateCell(row.text, Math.max(1, room), charset);
		return `${prefix}${id}${" ".repeat(GAP)}${text}`.trimEnd();
	}
	const cells: string[] = [];
	if (layout.shown.has("model") && layout.model > 0) cells.push(padEnd(truncateCell(row.model, layout.model, charset), layout.model));
	if (layout.shown.has("routing") && layout.routing > 0) cells.push(padEnd(row.routing, layout.routing));
	if (layout.shown.has("activity") && layout.activity > 0) {
		cells.push(padEnd(truncateCell(row.activity, layout.activity, charset), layout.activity));
	}
	if (layout.age > 0) cells.push(padStart(row.age, layout.age));
	if (layout.shown.has("tokens") && layout.tokens > 0) cells.push(padStart(row.tokens, layout.tokens));
	if (layout.cost > 0) cells.push(padStart(row.cost, layout.cost));
	return `${prefix}${id}${cells.map((cell) => " ".repeat(GAP) + cell).join("")}`.trimEnd();
}

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

interface Allocation {
	section: Section;
	rows: number;
	overflow: number;
}

/**
 * Lines by priority, per section: every section that has a row gets its header
 * and at least one line, then NEEDS YOU is filled first, then ATTENTION, then
 * RUNNING. A section that cannot show all its rows spends its last line on a
 * count — `… 8 more running (/status)` — so a hidden job is always visible as
 * a number. NEEDS YOU is collapsed last and never dropped without its count.
 */
function allocate(sections: readonly Section[], budget: number): Allocation[] | null {
	if (sections.length === 0) return [];
	// One header + one line each is the floor; below it the sections themselves
	// collapse to a single summary line (see `compactLine`).
	if (budget < sections.length * 2) return null;
	const allocation = sections.map((section) => ({ section, lines: 1 }));
	let spare = budget - sections.length * 2;
	for (const entry of allocation) {
		if (spare <= 0) break;
		const want = entry.section.rows.length - entry.lines;
		const take = Math.min(want, spare);
		entry.lines += take;
		spare -= take;
	}
	return allocation.map(({ section, lines }) => {
		const hidden = section.rows.length - lines;
		// The overflow line costs one of the section's own lines, so a section
		// with something hidden shows one row fewer and says how many.
		if (hidden <= 0) return { section, rows: section.rows.length, overflow: 0 };
		return { section, rows: Math.max(0, lines - 1), overflow: section.rows.length - Math.max(0, lines - 1) };
	});
}

function overflowText(section: Section, hidden: number, shown: number, charset: Charset): string {
	const more = shown === 0 ? "" : "more ";
	return `  ${charset.ellipsis} ${hidden} ${more}${section.label} (${section.hint})`;
}

/** The floor: one line naming every section and its count, and where to look. */
function compactLine(sections: readonly Section[], width: number, charset: Charset): string {
	const parts = sections.map((section) => `${section.header} (${section.rows.length})`);
	return truncateCell(`${parts.join(` ${charset.dot} `)} ${charset.emdash} /status`, width, charset);
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * The widget's headline (defect 2). The old one restated the same fleet four
 * ways — `4 jobs · 4 waiting · of which 4 live, 4 working` — because it reused
 * the table's headline, where the clauses do partition something. Here the
 * sections carry the breakdown, so the headline carries what they do not: how
 * many jobs there are and what the fleet has spent. `/status`'s own headline is
 * unchanged; it has the room and a different job.
 */
function widgetHeadline(snapshot: StatusSnapshot, charset: Charset): string {
	const jobs = `${snapshot.counts.jobs} job${snapshot.counts.jobs === 1 ? "" : "s"}`;
	return `command post ${charset.dot} ${jobs} ${charset.dot} ${formatCost(snapshot.usage.cost_usd)}`;
}

/**
 * One snapshot in, the widget's lines out. Pure: width, line cap, awaiting
 * items and the alphabet are all arguments, and every age is measured against
 * the snapshot's own `generated_at`, so two renders of one snapshot are
 * byte-identical and no test needs a terminal, a clock or a theme.
 */
export function renderFleetWidget(snapshot: StatusSnapshot, options: RenderFleetWidgetOptions = {}): WidgetLine[] {
	const width = Math.max(1, options.width ?? WIDGET_MAX_WIDTH);
	const maxLines = Math.max(1, options.maxLines ?? WIDGET_MAX_LINES);
	const charset = options.ascii ? ASCII : UNICODE;
	const now = snapshot.generated_at;

	const awaitingItems = options.awaiting ?? [];
	const awaitingByJob = new Map<string, WidgetAwaitingItem>();
	for (const item of awaitingItems) {
		if (item.job_id && !awaitingByJob.has(item.job_id)) awaitingByJob.set(item.job_id, item);
	}

	const lines: WidgetLine[] = [];
	const parts: string[] = [];
	if (awaitingItems.length > 0) {
		parts.push(
			`${awaitingItems.length} decision${awaitingItems.length === 1 ? "" : "s"} awaiting you ${charset.emdash} /cp-awaiting`,
		);
	}
	if (parts.length > 0) {
		lines.push({
			role: "marker",
			text: truncateCell(`${charset.marker} ${parts.join(` ${charset.dot} `)}`, width, charset),
		});
	}
	// An empty fleet clears the widget rather than drawing a header (T23); with
	// an open decision the marker is the whole widget.
	if (snapshot.jobs.length === 0) return lines;
	if (lines.length >= maxLines) return lines;
	lines.push({ role: "headline", text: truncateCell(widgetHeadline(snapshot, charset), width, charset) });
	if (lines.length >= maxLines) return lines;

	// One unit for the whole TOKENS column, chosen from the fleet maximum
	// (defect 5): `0.56M` under `2.39M` compares; `558.2k` under `2.39M` does not.
	const unit = chooseTokenUnit(snapshot.jobs.map((job) => job.usage.total_tokens));

	const needs: Row[] = [];
	const attention: Row[] = [];
	const running: Row[] = [];
	for (const job of snapshot.jobs) {
		const item = awaitingByJob.get(job.job_id);
		const state = jobState(job, item ? { awaiting: true } : {});
		if (state.section === "needs") needs.push(needsRow(job, item, now, charset));
		else if (state.section === "attention") attention.push(attentionRow(job, state.kind, state.word, now, charset));
		else running.push(runningRow(job, state.kind, state.word, unit, now, charset));
	}
	// `unclaimed` is not a job (br says in_progress, this fleet has no record),
	// but it is exactly the kind of thing ATTENTION exists for, and it must not
	// be the line that silently falls off the bottom.
	if (snapshot.unclaimed.length > 0) {
		attention.push({
			kind: "free",
			glyph: charset.glyph("long-tool"),
			id: "",
			text: `${snapshot.unclaimed.length} unclaimed in the ledger (/status)`,
			alert: true,
		});
	}

	const sections: Section[] = [];
	if (needs.length > 0) {
		sections.push({ section: "needs", header: "NEEDS YOU", alert: false, rows: needs, label: "need you", hint: "/cp-awaiting" });
	}
	if (attention.length > 0) {
		sections.push({ section: "attention", header: "ATTENTION", alert: true, rows: attention, label: "need attention", hint: "/status" });
	}
	if (running.length > 0) {
		sections.push({ section: "running", header: "RUNNING", alert: false, rows: running, label: "running", hint: "/status" });
	}

	const layout = layoutFor(sections, width);
	const allocation = layout.compact ? null : allocate(sections, maxLines - lines.length);
	if (allocation === null) {
		lines.push({ role: "overflow", text: compactLine(sections, width, charset) });
		return lines;
	}
	for (const entry of allocation) {
		const header = `${entry.section.header} (${entry.section.rows.length})`;
		lines.push({ role: entry.section.alert ? "section-alert" : "section", text: truncateCell(header, width, charset) });
		for (const row of entry.section.rows.slice(0, entry.rows)) {
			const alert = row.kind === "free" && row.alert;
			lines.push({
				role: alert ? "row-alert" : "row",
				text: truncateCell(renderRow(row, layout, width, charset), width, charset),
				glyphAt: PREFIX - 2,
				...(row.kind === "columns" ? { dimFrom: PREFIX + layout.idWidth } : {}),
			});
		}
		if (entry.overflow > 0) {
			lines.push({ role: "overflow", text: truncateCell(overflowText(entry.section, entry.overflow, entry.rows, charset), width, charset) });
		}
	}
	return lines;
}

/**
 * The plain-string form: what RPC clients receive verbatim, and what the golden
 * files pin. `renderFleetWidget` is the renderer; this is the one-line adapter
 * every caller that does not care about styling uses.
 */
export function statusWidgetLines(snapshot: StatusSnapshot, options: RenderFleetWidgetOptions = {}): string[] {
	return renderFleetWidget(snapshot, options).map((line) => line.text);
}
