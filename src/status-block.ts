/**
 * Status block (cp-8aj) — the parent's per-turn report to the operator,
 * rendered by the extension instead of hand-typed markdown.
 *
 * AGENTS.md deliberately kept this distinct from `/status`: `/status` is the
 * live fleet rendered from files; the status block is "what you tell the
 * operator, in their language". That distinction survives here as a split:
 *
 *  - Everything derivable from disk — job id, phase, worker/model, repo, age,
 *    tokens, cost, and a Shipped row once a PR receipt exists — comes from the
 *    SAME `StatusSnapshot` `/status` and `/watch` already read
 *    (`assembleStatus` in `status.ts`). There is no second read path here.
 *  - Two things this module cannot derive, and does not try to: a
 *    plain-language label for a job (falls back to the br title), and the
 *    "Awaiting you" table in full (type, decision, why, what it blocks — none
 *    of that exists in any file). "Blocked"'s `waiting_on` cell is the same
 *    kind of judgment: `/status` has no notion of a *human-legible* reason a
 *    job is stuck.
 *
 * The caller (the command-post extension) supplies that judgment via a tool
 * call (`cp_status_block`) and this module renders the merge. Pure and
 * synchronous: everything here is string formatting over an already-assembled
 * snapshot plus small, bounded, caller-supplied rows.
 */

import type { Receipt, StatusJob, StatusSnapshot } from "./contracts.ts";
import { projectGroupedLines } from "./project-report.ts";
import { formatAge, formatCost, formatScopeRisk, formatThinking, formatTokens, jobState, shortModel } from "./status-render.ts";

/** A label longer than this blows up a one-line row; bound it, do not wrap it. */
export const MAX_LABEL_CHARS = 80;

/** Same bound for the free-text judgment cells (why/decision/blocks/waiting_on). */
export const MAX_CELL_CHARS = 100;

/**
 * A refusal reason names the fix, so it gets more room than a table cell: the
 * bound exists to stop an unbounded store error from blowing up the layout, not
 * to trim the guidance. It is set above the longest refusal this system builds
 * (the authorization-wording one, ~311 chars with the longest trigger phrase
 * quoted), and tests/awaiting-rows.test.ts asserts the *rendered* line still
 * carries both the quoted trigger and the whole suggested rewording — a fix cut
 * in half is the same bug as no fix.
 */
export const MAX_REASON_CHARS = 360;

/** Default rendering width; narrower terminals pass a smaller value. */
export const STATUS_BLOCK_DEFAULT_WIDTH = 100;

export type AwaitingType = "approval" | "design" | "authorization" | "escalation";

export interface StatusBlockLabelInput {
	job_id: string;
	label: string;
}

export interface StatusBlockBlockedInput {
	job_id: string;
	/** A real dependency, CI check, gate or worker — never a human decision. */
	waiting_on: string;
}

export interface StatusBlockAwaitingInput {
	type: AwaitingType;
	decision: string;
	why: string;
	blocks: string;
	/** Optional: ties the row back to a job so its label can be reused. */
	job_id?: string;
	/** cp-av8: the stable id of the merged/persisted item, so the operator can answer it. */
	id?: string;
	/** cp-av8: how long this item has been open, for the operator's own judgment. */
	age_seconds?: number;
	/** cp-av8: skipped this session — still rendered, never hidden. */
	snoozed?: boolean;
	/** Authorization-shaped wording: guidance, never a refusal. */
	lint?: string;
}

/**
 * cp-gmy: a merge ask that was NOT raised, and why. The rule is "never ask a
 * human to merge while CI is still running for that head"; the corollary is
 * that the ask must never disappear quietly either, so every gated row is
 * printed right under the table it would have joined.
 */
export interface StatusBlockMergeAskInput {
	/**
	 * `deferred` — will be raised automatically; `ci_failed` — will not be asked
	 * at all; `job_gone` (cp-to39) — the row's job no longer exists, so it will
	 * never be raised by itself and is waiting for the operator to answer or
	 * withdraw it; `already_merged` (cp-p1sh) — the merge happened while the row
	 * was deferred, so the row is closed and reported once, never asked.
	 */
	kind: "deferred" | "ci_failed" | "job_gone" | "already_merged";
	decision: string;
	reason: string;
	job_id?: string;
	id?: string;
}

/**
 * cp-nz95: a row the parent passed that the awaiting store would **not** store
 * as open. It is never rendered as an open question — the operator cannot
 * answer a row that does not exist — but it is never silent either: it prints
 * under the table with the store's own refusal, which names the fix.
 */
export interface StatusBlockRefusedInput {
	type: AwaitingType;
	decision: string;
	/** The refusal, verbatim from the store. It names what to do instead. */
	reason: string;
	job_id?: string;
}

export interface StatusBlockInput {
	labels?: StatusBlockLabelInput[];
	blocked?: StatusBlockBlockedInput[];
	awaiting?: StatusBlockAwaitingInput[];
	/** Merge asks the CI gate held back this turn (cp-gmy). Never silent. */
	mergeAsks?: StatusBlockMergeAskInput[];
	/** Rows the awaiting store refused (cp-nz95). Never rendered as open. */
	refused?: StatusBlockRefusedInput[];
	/**
	 * cp-av8: set when a derived Awaiting-you source (checkpoints, the fleet
	 * join) could not be read. "Awaiting you: none" must never be the failure
	 * mode for an unreadable source — that is exactly the missed decision this
	 * table exists to prevent.
	 */
	awaitingUnavailable?: string;
}

export interface StatusBlockOptions {
	/** job ids already rendered under Shipped in an earlier block this session. */
	shownShipped?: ReadonlySet<string>;
	/** Rendering width; a narrow terminal degrades cells before it drops rows. */
	width?: number;
}

export interface StatusBlockResult {
	text: string;
	/** Every shipped job_id this call saw (not just the newly-shown ones) — the
	 * caller folds this into its own shown-set for next time. */
	shippedIds: string[];
}

function truncate(value: string, width: number): string {
	if (!Number.isFinite(width) || value.length <= width) return value;
	return `${value.slice(0, Math.max(1, width - 1))}…`;
}

function boundedLabel(value: string): string {
	return truncate(value.trim(), MAX_LABEL_CHARS);
}

function boundedCell(value: string): string {
	return truncate(value.trim(), MAX_CELL_CHARS);
}

/** A refusal must stay actionable, so it is bounded generously and never cut
 * to the terminal width — an unreadable fix is the same bug as no fix. */
function boundedReason(value: string): string {
	return truncate(value.trim(), MAX_REASON_CHARS);
}

/** Job cells pair the job id with a plain-language label (AGENTS.md contract):
 * the caller's label wins, then the br title from the same snapshot join,
 * then the bare id — never a blank cell. */
function labelFor(jobId: string, job: StatusJob | undefined, labels: ReadonlyMap<string, string>): string {
	const supplied = labels.get(jobId);
	if (supplied && supplied.trim().length > 0) return boundedLabel(supplied);
	if (job?.title) return boundedLabel(job.title);
	return jobId;
}

function findPrReceipt(job: StatusJob): Receipt | undefined {
	// pi-command-post-1jz: a board delivery's served URL is a Shipped fact too,
	// not only a PR's.
	return (job.receipts ?? []).find((receipt) => (receipt.kind === "pr" || receipt.kind === "board") && receipt.url);
}

/**
 * A `force` teardown skipped the gates: nothing was proven about this job's
 * state, so an open (unmerged) PR receipt on a forced record must never read
 * as Shipped (cp-8km). A normal teardown, or a PR receipt some other path has
 * since confirmed, is unaffected — this excludes exactly the one unverified
 * case, nothing more.
 */
function isUnverifiedForced(job: StatusJob, receipt: Receipt): boolean {
	return job.closed_reason === "forced" && receipt.status === "open";
}

/** Section 1, "In progress": every active-phase job, one line each. Leans on
 * the same facts the widget already renders (age, tokens, cost, run/phase) so
 * the block never restates them worse in a second table. */
function renderInProgress(jobs: readonly StatusJob[], labels: ReadonlyMap<string, string>, width: number): string[] {
	if (jobs.length === 0) return ["In progress: none"];
	// cp-project-grouped-reporting: rows spanning several projects get one
	// `[project]` section each; a single-project block renders as it always has.
	return ["In progress:", ...projectGroupedLines(jobs, (job) => job.project, (job) => inProgressLine(job, labels, width))];
}

function inProgressLine(job: StatusJob, labels: ReadonlyMap<string, string>, width: number): string {
	const label = labelFor(job.job_id, job, labels);
	// scope/risk and thinking are the routing inputs that decided the model
	// (cp-status-scope-risk): shown right after it, so the operator sees the
	// choice and why in the same glance. `formatScopeRisk`/`formatThinking`
	// already mark inferred values (`M?/high?`) and unknown jobs (`—`); this
	// line never re-derives either, it only reads what dispatch recorded.
	// One state, one vocabulary (cp-8tu): `jobState` is the same call the widget
	// makes, so the block and the widget can never name a job's state
	// differently. The policy phase stays alongside it — it is a different fact
	// (fleet.json, not the run projection) — unless the two would say the same
	// word twice.
	const state = jobState(job);
	const stateCell = state.word === job.phase ? state.word : `${state.word} (${job.phase})`;
	const facts = `${job.project} · ${shortModel(job.model)} · ${formatScopeRisk(job)} · ${formatThinking(job)} · ${stateCell} · ${formatAge(job.age_seconds)} · ${formatTokens(job.usage.total_tokens)} ${formatCost(job.usage.cost_usd)}`;
	return truncate(`  - ${job.job_id} — ${label}  (${facts})`, width);
}

/** Section 2, "Blocked": parent-supplied — the same rows `br dep add` and the
 * gate ladder already track, in the operator's language. */
function renderBlocked(
	rows: readonly StatusBlockBlockedInput[],
	jobsById: ReadonlyMap<string, StatusJob>,
	labels: ReadonlyMap<string, string>,
	width: number,
): string[] {
	if (rows.length === 0) return ["Blocked: none"];
	const render = (row: StatusBlockBlockedInput): string => {
		// The label is width-bounded (it carries an operator-facing repo/job name
		// that could be long); `waiting_on` is already bounded to MAX_CELL_CHARS by
		// the tool's own schema, so it is never re-truncated by the terminal width
		// on top of that — a narrow terminal must degrade the label first.
		const label = truncate(labelFor(row.job_id, jobsById.get(row.job_id), labels), width);
		return `  - ${row.job_id} — ${label}  (waiting on: ${boundedCell(row.waiting_on)})`;
	};
	return ["Blocked:", ...projectGroupedLines(rows, (row) => jobsById.get(row.job_id)?.project, render)];
}

/** Section 3, "Awaiting you": entirely parent-supplied — none of type,
 * decision, why or blocks exists in any file. */
function renderAwaiting(
	rows: readonly StatusBlockAwaitingInput[],
	jobsById: ReadonlyMap<string, StatusJob>,
	labels: ReadonlyMap<string, string>,
	width: number,
	unavailable: string | undefined,
	mergeAsks: readonly StatusBlockMergeAskInput[],
	refused: readonly StatusBlockRefusedInput[],
): string[] {
	// Every exit from this function renders the same two notices, so a refused or
	// deferred row cannot be lost by the table above it being empty (cp-nz95).
	const notices = [...renderMergeAsks(mergeAsks, width), ...renderRefused(refused, width)];
	if (unavailable) return [`Awaiting you: unavailable (${boundedCell(unavailable)})`, ...notices];
	if (rows.length === 0) return ["Awaiting you: none", ...notices];
	const render = (row: StatusBlockAwaitingInput): string[] => {
		// Each cell is already bounded to MAX_CELL_CHARS by the tool's own schema —
		// this is the one table with no disk-derived facts to crowd out, so the
		// per-cell bound is the layout guard, not the terminal width.
		const prefix = row.job_id ? `${truncate(`${row.job_id} — ${labelFor(row.job_id, jobsById.get(row.job_id), labels)}`, width)}: ` : "";
		const idTag = row.id ? `${row.id} ` : "";
		const snoozedTag = row.snoozed ? " (skipped this session)" : "";
		const line =
			`  - ${idTag}[${row.type}] ${prefix}${boundedCell(row.decision)} — why: ${boundedCell(row.why)} — blocks: ${boundedCell(row.blocks)}${snoozedTag}`;
		return row.lint ? [line, `    ${boundedReason(row.lint)}`] : [line];
	};
	const lines = [
		"Awaiting you:",
		...projectGroupedLines(rows, (row) => (row.job_id ? jobsById.get(row.job_id)?.project : undefined), render),
	];
	lines.push(`answer with cp_decide (${rows.length} open)`);
	lines.push(...notices);
	return lines;
}

/**
 * The refused rows (cp-nz95). Every other refusal in this system names its
 * fix; this one used to name nothing at all — the row simply appeared as an
 * open question the operator could not answer, because it was never stored.
 * Now it appears here instead, marked unanswerable, with the store's reason.
 */
function renderRefused(rows: readonly StatusBlockRefusedInput[], width: number): string[] {
	if (rows.length === 0) return [];
	const lines = [`Not asked — refused by the awaiting store (${rows.length}); not stored, so cp_decide cannot offer them:`];
	for (const row of rows) {
		lines.push(truncate(`  - ${row.job_id ? `${row.job_id} — ` : ""}[${row.type}] ${boundedCell(row.decision)}`, width));
		lines.push(`    refused: ${boundedReason(row.reason)}`);
	}
	return lines;
}

/**
 * The gated merge asks (cp-gmy). A deferral is announced, so "the parent did
 * not ask me to merge" is always distinguishable from "the parent forgot": a
 * deferred row says it will be raised by itself, and a red one says it will not
 * be asked at all.
 */
/**
 * The rows `cp_status_block` reports for merge asks the review just **closed**
 * (cp-p1sh). Extracted from the extension so the reporting path is testable
 * without a pi context: the extension calls this and passes the result through.
 *
 * One-shot by construction. A resolved row is `withdrawn` in the store, so it is
 * not in `list("deferred")` and no later review returns it again — the notice is
 * printed on the render that closed the row, and never after it.
 */
export function resolvedMergeAskRows(
	resolved: readonly { id: string; decision: string; job_id?: string; deferred_reason?: string }[],
	verdicts?: ReadonlyMap<string, { reason: string }>,
): StatusBlockMergeAskInput[] {
	return resolved.map((item) => ({
		kind: "already_merged" as const,
		decision: item.decision,
		reason: verdicts?.get(item.id)?.reason ?? item.deferred_reason ?? "the merge already happened",
		id: item.id,
		...(item.job_id ? { job_id: item.job_id } : {}),
	}));
}

function renderMergeAsks(rows: readonly StatusBlockMergeAskInput[], width: number): string[] {
	if (rows.length === 0) return [];
	const deferred = rows.filter((row) => row.kind === "deferred");
	const failed = rows.filter((row) => row.kind === "ci_failed");
	const orphaned = rows.filter((row) => row.kind === "job_gone");
	const merged = rows.filter((row) => row.kind === "already_merged");
	const lines: string[] = [];
	const render = (row: StatusBlockMergeAskInput): string =>
		truncate(`  - ${row.job_id ? `${row.job_id} — ` : ""}${boundedCell(row.decision)}: ${boundedCell(row.reason)}`, width);
	if (deferred.length > 0) {
		// cp-1som: "CI unfinished" was the only wording, and it became a lie once a
		// deferral could also mean "CI state unknown" or "this head is unreviewed".
		// The heading names the rule; each row's reason names which half is missing.
		lines.push(`Not asked yet — not ready to merge (${deferred.length}, raised automatically once CI is green on the current head and a review passes):`);
		lines.push(...deferred.map(render));
	}
	if (failed.length > 0) {
		lines.push(`Not asked — CI red (${failed.length}); merging red is forbidden, so fix or close it instead:`);
		lines.push(...failed.map(render));
	}
	if (orphaned.length > 0) {
		// cp-to39: never raised (the ask would be unanswerable) and never dropped
		// (the question was real). It sits here until a human resolves it.
		lines.push(`Not asked — the job is gone (${orphaned.length}); answer or withdraw it with cp_decide:`);
		lines.push(...orphaned.map(render));
	}
	if (merged.length > 0) {
		// cp-p1sh: reported once and then gone, because the row is closed — asking a
		// human to approve a merge that already landed is the defect this replaces.
		lines.push(`Not asked — already merged (${merged.length}); the row is closed, nothing to approve:`);
		lines.push(...merged.map(render));
	}
	return lines;
}

/** Section 4, "Shipped": disk-derivable (a done job with a `pr` receipt), and
 * capped to what is NEW since the previous block — the churn a long session
 * used to pay for, five unchanged rows a turn, is now paid once. */
function renderShipped(
	jobs: readonly StatusJob[],
	labels: ReadonlyMap<string, string>,
	shown: ReadonlySet<string>,
	width: number,
): { lines: string[]; ids: string[] } {
	const candidates = jobs
		.map((job) => ({ job, receipt: findPrReceipt(job) }))
		.filter((entry): entry is { job: StatusJob; receipt: Receipt } => entry.receipt !== undefined);
	const shippable = candidates.filter((entry) => !isUnverifiedForced(entry.job, entry.receipt));
	const unverified = candidates.filter((entry) => isUnverifiedForced(entry.job, entry.receipt));
	// Every candidate (verified or not) is a Shipped id once shown, so a forced,
	// unverified row does not keep reappearing as "new" turn after turn either.
	const ids = candidates.map((entry) => entry.job.job_id);
	const unverifiedLines = unverified
		.filter((entry) => !shown.has(entry.job.job_id))
		.map((entry) => {
			const label = labelFor(entry.job.job_id, entry.job, labels);
			const prefix = truncate(`  - ${entry.job.job_id} — ${label}: `, width);
			return `${prefix}${entry.receipt.url} (forced teardown, PR not confirmed merged)`;
		});
	if (shippable.length === 0) {
		return {
			lines: unverifiedLines.length > 0 ? ["Shipped: none", "Shipped (unverified, forced teardown):", ...unverifiedLines] : ["Shipped: none"],
			ids,
		};
	}
	const fresh = shippable.filter((entry) => !shown.has(entry.job.job_id));
	const lines: string[] =
		fresh.length === 0 ? [`Shipped: none new (${shippable.length} already reported)`] : ["Shipped:"];
	const render = ({ job, receipt }: { job: StatusJob; receipt: Receipt }): string => {
		const label = labelFor(job.job_id, job, labels);
		// The PR url is contract (AGENTS.md: "never a bare number or slug") and is
		// never truncated, even on a narrow terminal — only the prefix before it is.
		const prefix = truncate(`  - ${job.job_id} — ${label}: `, width);
		return `${prefix}${receipt.url}`;
	};
	lines.push(...projectGroupedLines(fresh, (entry) => entry.job.project, render));
	if (unverifiedLines.length > 0) {
		lines.push("Shipped (unverified, forced teardown):", ...unverifiedLines);
	}
	return { lines, ids };
}

/**
 * Merge disk facts (the snapshot) with the caller's judgment and render the
 * four sections. `snapshot` should be queried with `include: "all"` so a
 * just-shipped job (phase `done`) is still visible for the Shipped section;
 * "In progress" filters back down to the active phases itself.
 */
export function assembleStatusBlock(
	snapshot: StatusSnapshot,
	input: StatusBlockInput = {},
	options: StatusBlockOptions = {},
): StatusBlockResult {
	const width = options.width && options.width > 0 ? options.width : STATUS_BLOCK_DEFAULT_WIDTH;
	const shownShipped = options.shownShipped ?? new Set<string>();
	const labels = new Map((input.labels ?? []).map((entry) => [entry.job_id, entry.label] as const));
	const jobsById = new Map(snapshot.jobs.map((job) => [job.job_id, job] as const));

	const inProgressJobs = snapshot.jobs.filter((job) => job.phase !== "done");
	const shippedCandidates = snapshot.jobs.filter((job) => job.phase === "done");

	const shipped = renderShipped(shippedCandidates, labels, shownShipped, width);

	const sections = [
		...renderInProgress(inProgressJobs, labels, width),
		"",
		...renderBlocked(input.blocked ?? [], jobsById, labels, width),
		"",
		...renderAwaiting(input.awaiting ?? [], jobsById, labels, width, input.awaitingUnavailable, input.mergeAsks ?? [], input.refused ?? []),
		"",
		...shipped.lines,
	];

	return { text: sections.join("\n"), shippedIds: shipped.ids };
}
