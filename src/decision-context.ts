/**
 * The decision details pane (pi-command-post-4mn) — what the evidence for one
 * Awaiting-you item actually says, bounded, redacted, and tied to the head it
 * describes.
 *
 * `/cp-decide` used to offer a row's `decision` / `why` / `blocks` and nothing
 * else: three bounded strings written by whoever declared the row. So a
 * decision that exists *because* a review found three issues was put to the
 * operator with none of them on screen — the findings were on disk, in
 * `state/runs/<job>/review-<n>.json`, and the only way to read them was to
 * leave the dialog. This module is the projection that closes that gap.
 *
 * Four rules make it safe to show, and each one is code here rather than a
 * habit at a call site:
 *
 *  - **Authoritative records only.** The evidence is what this home itself
 *    wrote: the diff-review verdict, the plan-gate verdict, the pending
 *    checkpoint, and the CI watcher's own observation of the branch head.
 *    Nothing here reads an artifact body, a diff, a task file or a run log —
 *    there is no path function for any of those in this file, and
 *    `tests/decision-context.test.ts` asserts it (the same rule
 *    `src/suggest.ts` enforces by closing its input type).
 *  - **Tied to job, head and attempt.** Evidence for another job is dropped;
 *    a review verdict whose `head_sha` is not the branch's current pushed head
 *    is shown as **stale**, never as a current finding; a `merge`
 *    authorization whose scope is not that head is shown as stale too. The
 *    attempt number is on every finding, because "the reviewer said this" is
 *    only useful with "in which round".
 *  - **Bounded and redacted.** Every line is clipped to
 *    `DECISION_CONTEXT_LINE_MAX_CHARS` and passed through `redactSecrets`, and
 *    the block is capped at `DECISION_CONTEXT_MAX_LINES`. Findings are the
 *    priority: the header, every actionable finding and the recommendation are
 *    kept, and what does not fit is *named* as elided rather than dropped
 *    silently.
 *  - **A recommendation is a reading, never a decision.** It is one line,
 *    prefixed with `DECISION_CONTEXT_RECOMMENDATION_LABEL`, and it lives in the
 *    pane — never in the option list, so it can never be preselected and a
 *    stray Enter can never answer with it.
 *
 * The split is `src/merge-ask.ts`'s: a pure rule (`buildDecisionContext`) over
 * facts, and one reader (`readDecisionEvidence`) that obtains those facts from
 * local files. Nothing here does network I/O — this runs on a render path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
	/\b(?:bearer|basic)\s+[\w\-._~+/=]+/gi,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{8,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
	/--?(?:password|passwd|token|secret|api[-_]?key|apikey)(?:[= ])\S+/gi,
	/[\w-]*(?:password|passwd|token|secret|api[-_]?key|apikey|access[-_]?key)[\w-]*=[^\s&]+/gi,
]);

/** Secret-shaped values become visible bullets. Never throws. */
export function redactSecrets(value: string): string {
	let out = value;
	for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "\u2022\u2022\u2022");
	return out;
}

import type { ResolvedAwaitingItem } from "./awaiting.ts";
import {
	type Checkpoint,
	CheckpointSchema,
	DECISION_CONTEXT_LINE_MAX_CHARS,
	DECISION_CONTEXT_MAX_FINDINGS,
	DECISION_CONTEXT_MAX_LINES,
	DECISION_CONTEXT_RECOMMENDATION_LABEL,
	type DiffVerdict,
	DiffVerdictSchema,
	type GateVerdict,
	GateVerdictSchema,
	GATE_MAX_ATTEMPTS_SCANNED,
	LAYOUT,
	paths,
	REVIEW_MAX_ATTEMPTS,
	validate,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// The facts (structural: a persisted verdict satisfies them as-is)
// ---------------------------------------------------------------------------

/** The latest diff-review verdict for this job, as persisted. */
export type ReviewEvidence = Pick<
	DiffVerdict,
	"job_id" | "attempt" | "verdict" | "cause" | "reasons" | "head_sha" | "decided_at"
> &
	Partial<Pick<DiffVerdict, "revisions" | "model" | "flags">>;

/** The latest plan-gate verdict for this job, as persisted. */
export type GateEvidence = Pick<GateVerdict, "job_id" | "attempt" | "verdict" | "cause" | "reasons" | "decided_at"> &
	Partial<Pick<GateVerdict, "revisions" | "flags" | "model">>;

/** The checkpoint this row is about, when it is one. */
export type CheckpointEvidence = Pick<Checkpoint, "job_id" | "question" | "decision" | "requested_at"> &
	Partial<Pick<Checkpoint, "kind" | "scope" | "evidence">>;

/**
 * What the CI watcher last observed for this job (`state/ci-watch.json`). It is
 * the **files-only** source of the branch's pushed head, which is what every
 * staleness comparison below is made against — no `gh` call belongs on a render
 * path, and the watcher's observation is a fact this home recorded, not a claim.
 */
export interface CiEvidence {
	head_sha?: string;
	last_ci?: string;
	last_checked_at?: string;
}

export interface DecisionEvidence {
	review?: ReviewEvidence;
	gate?: GateEvidence;
	checkpoint?: CheckpointEvidence;
	ci?: CiEvidence;
}

export interface DecisionContext {
	/** The rendered pane, bounded and redacted. Empty when there is nothing to say. */
	lines: string[];
	/** Every actionable finding, in order, as rendered. */
	findings: string[];
	/** One line, always labelled. Absent when no evidence supports one. */
	recommendation?: string;
	/** Evidence that exists but does not describe this head/attempt, and why. */
	stale: string[];
	/** Which records this pane was built from (`review-2`, `gate-1`, `ci-watch`, …). */
	sources: string[];
}

export const EMPTY_DECISION_CONTEXT: DecisionContext = Object.freeze({
	lines: [],
	findings: [],
	stale: [],
	sources: [],
});

// ---------------------------------------------------------------------------
// Bounding and redaction
// ---------------------------------------------------------------------------

/** One line: whitespace collapsed, secrets redacted, clipped. Never throws. */
export function contextLine(text: string, maxChars: number = DECISION_CONTEXT_LINE_MAX_CHARS): string {
	const collapsed = redactSecrets(String(text).replace(/\s+/g, " ").trim());
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxChars - 1))}\u2026`;
}

function short(sha: string | undefined): string {
	return sha ? sha.trim().slice(0, 7) : "?";
}

/**
 * Is there a head to tie evidence to at all?
 *
 * A head this home never observed is not a weaker fact than a superseded one —
 * it is **no** fact (PR #151 review). `CiWatchJobSchema` bounds a head at 7
 * characters, so anything shorter is not a head this home wrote.
 */
function headKnown(head: string | undefined): head is string {
	return typeof head === "string" && head.trim().length >= 7;
}

/** The same tolerant comparison the merge ask uses; duplicated, not imported,
 * so this module's fact list stays local (`src/merge-ask.ts` owns CI policy). */
function sameHead(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = a.trim().toLowerCase();
	const right = b.trim().toLowerCase();
	if (left.length < 7 || right.length < 7) return false;
	return left.startsWith(right) || right.startsWith(left);
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export interface BuildDecisionContextOptions {
	maxLines?: number;
	maxFindings?: number;
	maxLineChars?: number;
	/**
	 * Terminal width, when the caller knows it. A pane line is not a screen row:
	 * at 40 columns a 160-character line is four of them, which is how a bounded
	 * pane still filled a small terminal and pushed the answer rows out of sight
	 * on a real pi TUI. With `columns` the budget below is counted in **rows**.
	 */
	columns?: number;
	/** Screen rows the pane may occupy once wrapped. Needs `columns` to mean anything. */
	maxRows?: number;
}

/** Screen rows one pane line takes once the renderer wraps it at `columns`. */
function rowsFor(line: string, columns: number | undefined): number {
	if (!columns || columns <= 0) return 1;
	return Math.max(1, Math.ceil(line.length / columns));
}

/**
 * Cut an ordered list to its budget — in lines, and in wrapped screen rows when
 * the caller knows the width — and **always say what was cut**, inside the
 * budget. The marker's own room is reserved before anything is kept, using the
 * longest count it could carry, so the announcement can never be the thing that
 * overflows.
 */
function fitToBudget(
	all: readonly string[],
	limits: { maxLines: number; maxRows?: number; columns?: number },
	marker: (omitted: number) => string,
): string[] {
	if (limits.maxLines <= 0) return [];
	const maxRows = limits.maxRows ?? Number.POSITIVE_INFINITY;
	const totalRows = all.reduce((sum, line) => sum + rowsFor(line, limits.columns), 0);
	if (all.length <= limits.maxLines && totalRows <= maxRows) return [...all];

	const reserve = rowsFor(marker(all.length), limits.columns);
	const lineBudget = limits.maxLines - 1;
	const rowBudget = maxRows - reserve;
	const kept: string[] = [];
	let rows = 0;
	for (const line of all) {
		if (kept.length + 1 > lineBudget) break;
		const cost = rowsFor(line, limits.columns);
		if (rows + cost > rowBudget) break;
		kept.push(line);
		rows += cost;
	}
	// Even a budget too small for one line still says how much it hid: a pane that
	// silently renders nothing is the failure this marker exists to prevent.
	return [...kept, marker(all.length - kept.length)];
}

/**
 * Project one item plus its evidence onto the pane the operator reads before
 * answering. Pure, total, and never a body: everything it can emit is derived
 * from the bounded fields of a verdict, a checkpoint or the CI watcher's own
 * record.
 */
export function buildDecisionContext(
	item: Pick<ResolvedAwaitingItem, "id" | "type" | "job_id" | "checkpoint_kind" | "checkpoint_scope">,
	evidence: DecisionEvidence,
	options: BuildDecisionContextOptions = {},
): DecisionContext {
	const maxLines = options.maxLines ?? DECISION_CONTEXT_MAX_LINES;
	const maxFindings = options.maxFindings ?? DECISION_CONTEXT_MAX_FINDINGS;
	const clip = (text: string): string => contextLine(text, options.maxLineChars ?? DECISION_CONTEXT_LINE_MAX_CHARS);

	const jobId = item.job_id;
	const head = evidence.ci?.head_sha;
	const sources: string[] = [];
	const stale: string[] = [];
	const findings: string[] = [];
	const extras: string[] = [];

	// Evidence about a different job is not this decision's evidence, ever.
	const review = jobId && evidence.review?.job_id === jobId ? evidence.review : undefined;
	const gate = jobId && evidence.gate?.job_id === jobId ? evidence.gate : undefined;
	const checkpoint = jobId && evidence.checkpoint?.job_id === jobId ? evidence.checkpoint : undefined;

	// **Nothing is current without a head to tie it to** (PR #151 review). The
	// branch head this home observed is the anchor every record below is checked
	// against; with no observed head each record is *named* — with its finding
	// count and where the whole thing is — and none of it is presented as
	// describing the state the operator is being asked about.
	const tied = headKnown(head);
	const untied = (label: string, what: string, count: number): void => {
		stale.push(
			clip(
				`${label}: ${what} — untied: no current head is known for ${jobId ?? item.id}` +
					`${count > 0 ? `, so its ${count} finding(s) are not shown as current` : ""}; read it with /watch ${jobId ?? item.id}`,
			),
		);
	};

	// --- the diff review -----------------------------------------------------
	let reviewIsCurrent = false;
	if (review) {
		const label = `review-${review.attempt}`;
		sources.push(label);
		const reviewFindings = (review.reasons?.length ?? 0) + (review.revisions?.length ?? 0);
		if (!tied) {
			untied(label, `${review.verdict} on ${short(review.head_sha)}`, reviewFindings);
		} else if (!sameHead(review.head_sha, head)) {
			stale.push(
				clip(
					`${label} reviewed ${short(review.head_sha)}, but the branch head is ${short(head)} — stale, not shown as current evidence`,
				),
			);
		} else {
			reviewIsCurrent = true;
			extras.push(
				clip(
					`${label}: ${review.verdict}${review.cause ? `/${review.cause}` : ""} on ${short(review.head_sha)}` +
						`${review.model ? ` (${review.model})` : ""}, decided ${review.decided_at}`,
				),
			);
			const reviewFlags = flagList(review.flags);
			if (reviewFlags.length > 0) extras.push(clip(`${label} flags: ${reviewFlags.join(", ")}`));
			for (const reason of review.reasons ?? []) findings.push(clip(`finding [${label} ${review.verdict}]: ${reason}`));
			for (const revision of review.revisions ?? []) {
				findings.push(clip(`required change [${label}]: ${revision}`));
			}
		}
	}

	// --- the plan gate -------------------------------------------------------
	let gateIsCurrent = false;
	if (gate) {
		const label = `gate-${gate.attempt}`;
		sources.push(label);
		const gateFindings = (gate.reasons?.length ?? 0) + (gate.revisions?.length ?? 0);
		if (!tied) {
			untied(label, `${gate.verdict}${gate.cause ? `/${gate.cause}` : ""}`, gateFindings);
		} else {
			gateIsCurrent = true;
			extras.push(clip(`${label}: ${gate.verdict}${gate.cause ? `/${gate.cause}` : ""}, decided ${gate.decided_at}`));
			const flagged = flagList(gate.flags);
			if (flagged.length > 0) extras.push(clip(`${label} flags: ${flagged.join(", ")}`));
			for (const reason of gate.reasons ?? []) findings.push(clip(`finding [${label} ${gate.verdict}]: ${reason}`));
			for (const revision of gate.revisions ?? []) findings.push(clip(`required change [${label}]: ${revision}`));
		}
	}

	// --- the checkpoint this row asks about ----------------------------------
	if (checkpoint) {
		const kind = checkpoint.kind ?? item.checkpoint_kind ?? "ship";
		const label = `checkpoint:${kind}`;
		sources.push(label);
		if (checkpoint.decision !== "pending") {
			stale.push(clip(`${label} is already ${checkpoint.decision} — not a current question`));
		} else if ((kind === "merge" || kind === "final_fix") && !tied) {
			untied(label, `authorizes ${short(checkpoint.scope)}`, 0);
		} else if (kind === "merge" && !sameHead(checkpoint.scope, head)) {
			stale.push(
				clip(
					`${label} authorizes ${short(checkpoint.scope)}, but the branch head is ${short(head)} — stale, a force-push voids it`,
				),
			);
		} else {
			extras.push(clip(`${label}${checkpoint.scope ? ` @${short(checkpoint.scope)}` : ""}: ${checkpoint.question}`));
			for (const line of checkpoint.evidence ?? []) extras.push(clip(`${label} evidence: ${line}`));
		}
	}

	// --- CI, as this home last observed it -----------------------------------
	if (evidence.ci && (evidence.ci.head_sha || evidence.ci.last_ci)) {
		sources.push("ci-watch");
		extras.push(
			clip(
				`CI: ${evidence.ci.last_ci ?? "not observed"} on ${short(head)}` +
					`${evidence.ci.last_checked_at ? ` (checked ${evidence.ci.last_checked_at})` : ""}`,
			),
		);
	}

	if (sources.length === 0) return EMPTY_DECISION_CONTEXT;

	// Findings are the reason this pane exists: they are never traded away for
	// the lines below them, only capped, and a cap says how many it hid.
	const shown = findings.slice(0, maxFindings);
	const hidden = findings.length - shown.length;
	// Numbered, then clipped: the prefix is part of the line, so it is inside the
	// budget rather than pushed past it.
	const numbered = shown.map((finding, index) => clip(`${index + 1}/${findings.length} ${finding}`));
	if (hidden > 0) {
		numbered.push(clip(`+${hidden} more finding(s) — read them with /watch ${jobId ?? item.id}`));
	}

	const recommendation = recommendationFor({
		item,
		...(review && reviewIsCurrent ? { review } : {}),
		...(gate && gateIsCurrent ? { gate } : {}),
		tied,
		findingCount: findings.length,
		...(evidence.ci ? { ci: evidence.ci } : {}),
		staleCount: stale.length,
	});

	const header = clip(
		`evidence for ${jobId ?? item.id}${head ? ` @${short(head)}` : ""} — from ${sources.join(", ")}` +
			`${findings.length > 0 ? `; ${findings.length} actionable finding(s)` : "; no findings"}`,
	);
	const recommendationLine = recommendation ? clip(`${DECISION_CONTEXT_RECOMMENDATION_LABEL} ${recommendation}`) : undefined;

	// One ordered list, one truncation, one marker (PR #151 review). Priority is
	// the order itself — header, findings, recommendation, then the tail (verdict
	// headers, checkpoint text, CI, stale notes) — and **whatever the budget cuts
	// is always announced, inside the budget**: the marker takes the last slot
	// rather than being appended past it, and it counts every omitted line. The
	// previous shape had a hole at `room === 0`, where the whole tail was dropped
	// with nothing said. A `maxLines` of 0 renders nothing at all rather than a
	// claim nobody can check.
	const all = [header, ...numbered, ...(recommendationLine ? [recommendationLine] : []), ...extras, ...stale];
	const lines = fitToBudget(
		all,
		{
			maxLines,
			...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
			...(options.columns !== undefined ? { columns: options.columns } : {}),
		},
		(omitted) => clip(`+${omitted} more line(s) — /watch ${jobId ?? item.id}`),
	);

	return {
		lines,
		findings: numbered,
		...(recommendationLine ? { recommendation: recommendationLine } : {}),
		stale,
		sources,
	};
}

function flagList(flags: { destructive_scope?: boolean; scope_growth?: boolean; blocking_unknowns?: boolean } | undefined): string[] {
	if (!flags) return [];
	return Object.entries(flags)
		.filter(([, value]) => value === true)
		.map(([key]) => key);
}

/**
 * The parent's reading of the evidence, in one line. Mechanical on purpose: it
 * is derived from verdicts and counts, never generated, so it cannot become a
 * second opinion about the decision — and it is rendered in the pane, never as
 * an option, so nothing can preselect it.
 */
function recommendationFor(input: {
	item: Pick<ResolvedAwaitingItem, "type">;
	review?: ReviewEvidence;
	gate?: GateEvidence;
	ci?: CiEvidence;
	/** False when no head was observed, so nothing here describes the current state. */
	tied: boolean;
	findingCount: number;
	staleCount: number;
}): string | undefined {
	const ci = input.ci?.last_ci;
	// Untied evidence answers nothing, so the recommendation says exactly that
	// rather than reading a verdict nobody can place.
	if (!input.tied) return "no evidence here is tied to a current head — nothing on screen is current; read it with /watch.";
	if (ci === "failed") return "CI is red on this head — merging red is forbidden; the failure is the thing to answer.";
	if (input.findingCount > 0) {
		return `read the ${input.findingCount} finding(s) above before answering; a fix moves the head and needs a fresh review.`;
	}
	if (input.review?.verdict === "pass" || input.gate?.verdict === "pass") {
		const green = ci === "green" ? ", CI green on this head" : "";
		return `the latest verdict is a pass${green} — evidence, never authorization.`;
	}
	if (input.staleCount > 0 && input.findingCount === 0) {
		return "the evidence on disk describes a different head — nothing current supports an answer yet.";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The facts, from local files
// ---------------------------------------------------------------------------

/** What `readDecisionEvidence` needs beyond the home. Injected for tests. */
export interface ReadDecisionEvidenceOptions {
	/** The branch's current pushed head, when the caller already knows it. */
	ci?: CiEvidence;
}

function readJson<T>(file: string, schema: unknown): T | undefined {
	if (file.length === 0) return undefined;
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validate<T>(schema, JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		// An unreadable record is no evidence — never a thrown dialog.
		return undefined;
	}
}

/**
 * The latest verdict of each kind, the row's own checkpoint, and the watcher's
 * last CI observation. Every read is total: a missing, unreadable or
 * contract-violating file is simply absent from the result, because a decision
 * must never be taken down by its own details pane.
 *
 * The attempt scans mirror `readReviewPassHeads`' rule rather than
 * `readPriorAttempts`': every slot is looked at and a gap is not a stop, since
 * the question here is "what is the newest verdict on disk", not "how many
 * attempts has this branch spent".
 */
export function readDecisionEvidence(
	home: string,
	item: Pick<ResolvedAwaitingItem, "job_id" | "checkpoint_kind" | "checkpoint_scope">,
	options: ReadDecisionEvidenceOptions = {},
): DecisionEvidence {
	const jobId = item.job_id;
	if (!jobId) return {};
	const evidence: DecisionEvidence = {};

	for (let attempt = REVIEW_MAX_ATTEMPTS; attempt >= 1; attempt -= 1) {
		const found = readJson<DiffVerdict>(join(home, safePath(() => paths.reviewFile(jobId, attempt))), DiffVerdictSchema);
		if (found) {
			evidence.review = found;
			break;
		}
	}
	for (let attempt = GATE_MAX_ATTEMPTS_SCANNED; attempt >= 1; attempt -= 1) {
		const found = readJson<GateVerdict>(join(home, safePath(() => paths.gateFile(jobId, attempt))), GateVerdictSchema);
		if (found) {
			evidence.gate = found;
			break;
		}
	}

	const kind = item.checkpoint_kind ?? "ship";
	const scope = kind === "merge" || kind === "final_fix" ? item.checkpoint_scope : undefined;
	const checkpointFile = safePath(() => paths.checkpointFile(jobId, kind, scope));
	if (checkpointFile.length > 0) {
		const found = readJson<Checkpoint>(join(home, checkpointFile), CheckpointSchema);
		if (found) evidence.checkpoint = found;
	}

	const ci = options.ci ?? readCiEvidence(home, jobId);
	if (ci) evidence.ci = ci;
	return evidence;
}

/** A path helper that refuses an unsafe id throws; that is "no evidence", not a crash. */
function safePath(build: () => string): string {
	try {
		return build();
	} catch {
		return "";
	}
}

/**
 * The CI watcher's own record for this job. Read here rather than through
 * `CiWatchStore` so this module keeps its one-way dependency on `./contracts.ts`
 * and the fs, and so a malformed file is "no observation" instead of an error
 * on a render path.
 */
function readCiEvidence(home: string, jobId: string): CiEvidence | undefined {
	const file = join(home, ciWatchFile());
	if (!existsSync(file)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const jobs = (parsed as { jobs?: unknown })?.jobs;
		if (!Array.isArray(jobs)) return undefined;
		const job = jobs.find((entry) => (entry as { job_id?: unknown })?.job_id === jobId) as
			| { head_sha?: unknown; last_ci?: unknown; last_checked_at?: unknown }
			| undefined;
		if (!job) return undefined;
		const evidence: CiEvidence = {};
		if (typeof job.head_sha === "string") evidence.head_sha = job.head_sha;
		if (typeof job.last_ci === "string") evidence.last_ci = job.last_ci;
		if (typeof job.last_checked_at === "string") evidence.last_checked_at = job.last_checked_at;
		return Object.keys(evidence).length > 0 ? evidence : undefined;
	} catch {
		return undefined;
	}
}

/** `LAYOUT` is filled in at session start, so it is only ever read in a body. */
function ciWatchFile(): string {
	return LAYOUT.ciWatchFile;
}
