/**
 * Curation (cp-autonomous-memory-curation) — promotion, rejection and
 * retirement, with the safety properties held in **code** rather than in a
 * human approval step.
 *
 * Until now `data/learnings.md` could only grow through a human-run pass: the
 * parent captured candidates, triaged them, proposed promotions, and then had
 * to stop and ask. On the session that motivated this, 9 of 12 candidates were
 * already superseded by code merged the same day, 3 were worth promoting, and
 * the human step added authorization and nothing else.
 *
 * Removing that step is only safe if the properties the human was nominally
 * holding are now enforced by the only functions that can write. They are:
 *
 *  1. **Bounded growth.** `LEARNINGS_MAX_LINES` is a hard ceiling — a promotion
 *     into a full file is refused, not absorbed — and at most
 *     `PROMOTIONS_PER_DAY_MAX` promotions can land in one UTC day. A runaway
 *     parent can add three lines a day into a 60-line file, and no more.
 *  2. **Nothing the parent promotes is permanent.** `PROMOTABLE_TIERS` excludes
 *     `pinned`: every autonomously promoted line decays (aging at 30 days,
 *     perishable at 7) and leaves through the archive if nothing reinforces it.
 *     A bad promotion therefore has a shelf life, which is the only real
 *     defence against a lesson that poisons every future session's context.
 *     Pinning stays a human edit.
 *  3. **Evidence and a date, or no line.** `promoteCandidate` composes the line
 *     itself from a lesson, an evidence string that must name a checkable
 *     source, a tier and (for perishable) an expiry condition. There is no way
 *     to write an undated, unevidenced or untiered learning through this path.
 *  4. **Append-only, never a silent rewrite.** The new line goes at the end and
 *     `assertAppendOnly` proves, byte for byte, that everything already in the
 *     file survived. Editing or dropping an existing line is not something this
 *     module can do; removal has exactly one path, and it is a move.
 *     The *mechanism* is an `O_APPEND` write (`durableAppend`), never a
 *     read-modify-write of the whole file: `O_APPEND` is what makes two
 *     concurrent writers — a promotion and the operator's own hand edit — both
 *     land instead of one silently overwriting the other. Measured, a
 *     read-modify-write loses 1176 of 1600 concurrent writes; no amount of
 *     atomicity around the rename closes that window, so the append stays
 *     (cp-nqj).
 *  5. **A superseded or disproven candidate can never be promoted.**
 *     `rejectCandidate` records the disposition in the journal, and every
 *     candidate carries at most one disposition, forever. `candidates.md` stays
 *     append-only — the judgment lives in the journal, not in a rewrite.
 *  6. **Every write is auditable, and the audit is written first.**
 *     `data/curation.jsonl` gets its record before `learnings.md` is touched,
 *     so a crash leaves an audit entry for a line that does not exist
 *     (detectable, conservative) rather than a line nobody can trace.
 *     `traceLearning` turns a suspect line back into the decision that made it.
 *
 * Retirement is held to the same standard as promotion, because the motivating
 * case was a lesson going false within a day: `retireLearning` needs a reason
 * and evidence, is journalled first, is bounded per day, and removes the line
 * only through `archiveEntry` — archive written first, never a delete.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { durableAppend } from "./json-store.ts";
import {
	archiveEntry,
	ensureMemoryScaffold,
	type LearningEntry,
	LEARNINGS_MAX_LINES,
	type MemoryStatus,
	memoryStatus,
	type MemoryTier,
	parseLearnings,
	PROMOTIONS_PER_DAY_MAX,
	readMemoryFile,
	RETIREMENTS_PER_DAY_MAX,
	scanCandidates,
	today,
} from "./memory.ts";

export class CurationError extends Error {}

/**
 * The two per-day bounds, defined next to the other memory budgets in
 * `memory.ts` (the learnings header quotes the promotion one) and re-exported
 * here, which is where callers reason about them:
 *
 * - `PROMOTIONS_PER_DAY_MAX` — promotions that may land in one UTC day; the
 *   file's absolute ceiling is `LEARNINGS_MAX_LINES`.
 * - `RETIREMENTS_PER_DAY_MAX` — higher on purpose: a retirement is recoverable
 *   (the line is in `archive.md` with its provenance), so the failure mode it
 *   guards against is a loop, not a loss.
 */
export { PROMOTIONS_PER_DAY_MAX, RETIREMENTS_PER_DAY_MAX };

/** A learning is one line; a paragraph belongs in docs/ or a report. */
export const LEARNING_MAX_CHARS = 300;

/**
 * Tiers an autonomous promotion may use. `pinned` is deliberately absent:
 * pinned never decays, so pinning is a permanent write to every future
 * session's context, and permanence stays a human's decision.
 */
export const PROMOTABLE_TIERS = ["aging", "perishable"] as const;
export type PromotableTier = (typeof PROMOTABLE_TIERS)[number];

/** Why a candidate will never be promoted. The first two need evidence. */
export const REJECT_CAUSES = ["superseded", "disproven", "generalizes", "noise"] as const;
export type RejectCause = (typeof REJECT_CAUSES)[number];

export const CURATION_ACTIONS = ["promote", "reject", "retire"] as const;
export type CurationAction = (typeof CURATION_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Evidence has to name something a later reader can go and check: a job id, a
 * path, a url, an issue number, a commit sha or a date. Deliberately broad —
 * the point is not to grade the citation, it is to make "because I think so"
 * unwritable.
 */
const EVIDENCE_SOURCE_RE = new RegExp(
	[
		"https?://", // a url
		"[\\w.-]+/[\\w./-]+", // a path or owner/repo
		"\\b[a-z][a-z0-9]*-[a-z0-9][a-z0-9-]*\\b", // a job id (cp-t26-memory)
		"\\b\\d{4}-\\d{2}-\\d{2}\\b", // a date
		"#\\d+", // an issue or PR number
		"\\b[0-9a-f]{7,40}\\b", // a commit sha
		"\\.(md|ts|tsx|js|json|ya?ml|sh|toml)\\b", // a file
	].join("|"),
	"i",
);

/** One line, non-empty, and it names a source. Used by promote and retire. */
export function requireEvidence(evidence: string | undefined, what: string): string {
	const text = (evidence ?? "").trim();
	if (text.length === 0) {
		throw new CurationError(`${what} needs evidence — name a job id, a PR, a commit, a path or a date`);
	}
	if (text.includes("\n")) throw new CurationError(`${what} evidence is one line`);
	if (!EVIDENCE_SOURCE_RE.test(text)) {
		throw new CurationError(
			`${what} evidence must name a checkable source (job id, PR/issue number, commit sha, path or date), got ${JSON.stringify(text)}`,
		);
	}
	return text;
}

function requireOneLine(value: string | undefined, what: string, max: number): string {
	const text = (value ?? "").trim();
	if (text.length === 0) throw new CurationError(`${what} is required`);
	if (text.includes("\n")) throw new CurationError(`${what} is one line`);
	if (text.length > max) throw new CurationError(`${what} is at most ${max} chars (got ${text.length})`);
	return text;
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

export interface CurationRecord {
	/** `cur-YYYYMMDD-<n>`, unique within the day, and stable once written. */
	id: string;
	at: string;
	date: string;
	action: CurationAction;
	/** The exact candidate line this decision was about (promote, reject). */
	candidate?: string;
	/** The exact learnings line written (promote) or removed (retire). */
	line?: string;
	tier?: MemoryTier;
	cause?: RejectCause;
	reason: string;
	evidence?: string;
	/** Where the knowledge lives now, when a retirement can name it. */
	now?: string;
}

function curationLogPath(home: string): string {
	return join(home, LAYOUT.curationLog);
}

/**
 * Every decision, in order. A line that is not parseable JSON is skipped
 * rather than thrown on: the journal is an audit trail, and a single mangled
 * line must not make the whole history unreadable (and therefore unenforceable
 * — the bounds below are computed from it).
 */
export function readCurationLog(home: string): CurationRecord[] {
	const path = curationLogPath(home);
	if (!existsSync(path)) return [];
	const records: CurationRecord[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		try {
			const parsed = JSON.parse(line) as CurationRecord;
			if (parsed && typeof parsed.id === "string" && typeof parsed.action === "string") records.push(parsed);
		} catch {
			// Skipped by design; see above.
		}
	}
	return records;
}

function appendCurationRecord(home: string, record: CurationRecord): CurationRecord {
	const path = curationLogPath(home);
	// Appended *and flushed* before the file it describes: journal-before-file is
	// only a real ordering if the journal is on disk when the second write starts.
	durableAppend(path, `${JSON.stringify(record)}\n`);
	return record;
}

function nextId(existing: readonly CurationRecord[], date: string): string {
	const stamp = date.replace(/-/g, "");
	const sameDay = existing.filter((record) => record.date === date).length;
	return `cur-${stamp}-${sameDay + 1}`;
}

/** How many of `action` landed on `date`. The per-day bounds read this. */
export function countOnDate(records: readonly CurationRecord[], action: CurationAction, date: string): number {
	return records.filter((record) => record.action === action && record.date === date).length;
}

// ---------------------------------------------------------------------------
// Candidates and their dispositions
// ---------------------------------------------------------------------------

/**
 * The disposition of one candidate, or `undefined` when it is still pending.
 * A candidate carries **at most one**: promotion and rejection are both
 * terminal, and a rejected candidate can never come back — if the evidence
 * changes, that is a new observation and a new captured line.
 */
export function candidateDisposition(
	records: readonly CurationRecord[],
	candidate: string,
): CurationRecord | undefined {
	const target = candidate.trim();
	return records.find((record) => record.candidate?.trim() === target);
}

/**
 * Resolve a candidate parameter to the full candidate line.
 * Accepts either:
 * - A full candidate line (YYYY-MM-DD ...): verify it exists in candidates.md
 * - Just the lesson text: find the matching candidate line in candidates.md
 *
 * This solves the stuck-candidate problem where a 290-300 char lesson creates
 * a 301-310 char full line that exceeds the old 300-char validation limit.
 * Callers can now pass just the lesson text instead.
 *
 * Returns the full candidate line (normalized) and extracted lesson text.
 */
function resolveCandidateToLine(
	lessonOrLine: string,
	candidateText: string,
): { candidateLine: string; lesson: string } {
	const normalized = lessonOrLine.trim();
	if (normalized.length === 0) {
		throw new CurationError("candidate or lesson is required");
	}

	const known = scanCandidates(candidateText).lines;
	const datePattern = /^\d{4}-\d{2}-\d{2}\s+/;

	// Check if this looks like a full candidate line (starts with YYYY-MM-DD format)
	const isFullLine = datePattern.test(normalized);

	if (isFullLine) {
		// This is already a full candidate line; verify it exists and extract the lesson
		const matchingLine = known.find((line) => line.trim() === normalized);
		if (!matchingLine) {
			throw new CurationError(
				`no such candidate in ${LAYOUT.candidatesFile} (match the line exactly): ${normalized.slice(0, 120)}`,
			);
		}
		const lesson = normalized.replace(datePattern, "");
		return { candidateLine: matchingLine, lesson };
	} else {
		// This is just the lesson text; find the matching candidate line
		const matchingLine = known.find((line) => {
			const lineLesson = line.replace(datePattern, "");
			return lineLesson === normalized;
		});

		if (!matchingLine) {
			throw new CurationError(
				`no candidate in ${LAYOUT.candidatesFile} with lesson: ${normalized.slice(0, 120)}`,
			);
		}

		return { candidateLine: matchingLine, lesson: normalized };
	}
}

/** Contract-shaped candidate lines that nothing has decided about yet. */
export function pendingCandidates(home: string): string[] {
	const text = readMemoryFile(home, "candidates");
	if (text === undefined) return [];
	const records = readCurationLog(home);
	return scanCandidates(text).lines.filter((line) => candidateDisposition(records, line) === undefined);
}

/** One line for the session-start digest when candidates await a decision; undefined at zero. */
export function pendingNotice(home: string): string | undefined {
	const n = pendingCandidates(home).length;
	return n > 0 ? `(${n} pending candidate(s) — cp_memory curate)` : undefined;
}

// ---------------------------------------------------------------------------
// Append-only, proved
// ---------------------------------------------------------------------------

/**
 * The property the human gate was nominally holding: a promotion adds a line
 * and changes nothing else. Proved on the bytes, not asserted in a comment —
 * if the new content is not the old content plus a suffix, the write is a
 * rewrite and this throws before it can be handed back as success.
 */
export function assertAppendOnly(before: string, after: string): void {
	if (!after.startsWith(before)) {
		throw new CurationError("refusing a write that is not an append: an existing learnings line would change");
	}
}

/** Loose equality for duplicate detection: date, tier and punctuation ignored. */
function normalizeBody(line: string): string {
	return line
		.replace(/^-\s+/, "")
		.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
		.replace(/<!--.*?-->/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export interface PromoteOptions {
	/**
	 * The candidate being promoted: either the full `data/candidates.md` line
	 * (YYYY-MM-DD ...) for backward compatibility, or just the lesson text.
	 * The lesson-text form solves the stuck-candidate problem where long lessons
	 * create lines exceeding the old 300-char validation limit.
	 */
	candidate: string;
	/** The lesson, as it should read in learnings: what happened; what to do. */
	lesson: string;
	/** A checkable source. Required — a line without one is not promotable. */
	evidence: string;
	/** `aging` (default) or `perishable`. `pinned` is not autonomously writable. */
	tier?: PromotableTier;
	/** Required for perishable: the condition that makes it expire (a job id, a version, a date). */
	expires?: string;
	at?: Date;
}

export interface PromoteResult {
	id: string;
	line: string;
	/** Learnings entries after the append. */
	entries: number;
	budget: number;
	/** Promotions still allowed today, after this one. */
	promotions_remaining: number;
}

/**
 * Promote one candidate into `data/learnings.md`. Every safety property in this
 * module's header is checked here, in the order a reader would want them: does
 * the candidate exist, has it already been decided, is the request well formed,
 * is there room, and is it new.
 */
export function promoteCandidate(home: string, options: PromoteOptions): PromoteResult {
	ensureMemoryScaffold(home);
	const at = options.at ?? new Date();
	const date = today(at);

	// 1. The candidate must exist. Resolve it from either the full line or just
	//    the lesson text (backward compatible with old behavior, but also solves
	//    the stuck-candidate problem where 290-300 char lessons create 301-310
	//    char full lines that exceeded the old 300-char validation).
	const candidateText = readMemoryFile(home, "candidates") ?? "";
	const { candidateLine, lesson: extractedLesson } = resolveCandidateToLine(options.candidate, candidateText);

	// 2. One disposition per candidate, forever. This is what makes "superseded
	//    or disproven cannot be promoted" structural rather than remembered.
	const records = readCurationLog(home);
	const decided = candidateDisposition(records, candidateLine);
	if (decided) {
		throw new CurationError(
			decided.action === "promote"
				? `that candidate was already promoted (${decided.id}, ${decided.date}): ${decided.line}`
				: `that candidate was rejected as ${decided.cause} (${decided.id}, ${decided.date}: ${decided.reason}) — a rejected candidate is never promoted; capture a fresh observation if the evidence changed`,
		);
	}

	// 3. Shape: a dated, evidenced, tiered one-liner, composed here so there is
	//    no path that writes a line missing any of them.
	//    Prefer the explicit lesson parameter; fall back to extracted from candidate.
	const lesson = options.lesson
		? requireOneLine(options.lesson, "lesson", LEARNING_MAX_CHARS)
		: requireOneLine(extractedLesson, "lesson", LEARNING_MAX_CHARS);
	const evidence = requireEvidence(options.evidence, "promotion");
	const tier: PromotableTier = options.tier ?? "aging";
	if (!(PROMOTABLE_TIERS as readonly string[]).includes(tier)) {
		throw new CurationError(
			`tier must be one of ${PROMOTABLE_TIERS.join(", ")} — a pinned line never decays, and permanence is the operator's call, not a curation pass's`,
		);
	}
	let expiresClause = "";
	if (tier === "perishable") {
		const expires = requireOneLine(options.expires, "a perishable promotion's expiry condition", LEARNING_MAX_CHARS);
		expiresClause = `; expires: ${expires}`;
	} else if (options.expires) {
		expiresClause = `; expires: ${options.expires.trim()}`;
	}

	// 4. Room. The budget is a ceiling, not a target: over it, the digest that
	//    enters every session is truncated, so a promotion that would exceed it
	//    is refused and the pass has to retire something first.
	const status = memoryStatus(home, at);
	if (status.lines >= LEARNINGS_MAX_LINES) {
		throw new CurationError(
			`${LAYOUT.learningsFile} is at budget (${status.lines}/${LEARNINGS_MAX_LINES}) — retire or archive an entry before promoting`,
		);
	}
	const promotedToday = countOnDate(records, "promote", date);
	if (promotedToday >= PROMOTIONS_PER_DAY_MAX) {
		throw new CurationError(
			`${PROMOTIONS_PER_DAY_MAX} promotions already landed today (${date}) — the daily bound is what keeps an autonomous pass from rewriting memory in one sitting`,
		);
	}

	// 5. New. A near-duplicate is a rewrite wearing an append's clothes.
	const body = normalizeBody(`${lesson}${expiresClause}`);
	const duplicate = status.entries.find((entry) => {
		const existing = normalizeBody(entry.line);
		// The existing line carries its own `evidence: …` tail, so a duplicate shows
		// up as a prefix. The length floor keeps a three-word lesson from colliding
		// with an unrelated entry that happens to start the same way.
		return existing === body || (body.length >= 12 && existing.startsWith(body));
	});
	if (duplicate) {
		throw new CurationError(
			`that lesson is already in ${LAYOUT.learningsFile} (${duplicate.line.slice(0, 120)}) — fold it in by hand or retire the old line; promotion never rewrites`,
		);
	}

	const tierMark = tier === "perishable" ? `<!--p:${date}-->` : `<!--a:${date}-->`;
	const line = `- ${date} ${lesson.replace(/[.;]\s*$/, "")}${expiresClause}; evidence: ${evidence}. ${tierMark}`;

	// 6. Audit first. A crash between the two writes leaves a record of a line
	//    that does not exist (visible, and it costs one slot of today's budget)
	//    rather than a line nobody can trace back to a decision.
	const record = appendCurationRecord(home, {
		id: nextId(records, date),
		at: at.toISOString(),
		date,
		action: "promote",
		candidate: candidateLine,
		line,
		tier,
		reason: `promoted from ${LAYOUT.candidatesFile}`,
		evidence,
	});

	const path = join(home, LAYOUT.learningsFile);
	const before = readFileSync(path, "utf8");
	const after = `${before}${before.endsWith("\n") ? "" : "\n"}${line}\n`;
	assertAppendOnly(before, after);
	durableAppend(path, after.slice(before.length));

	const entries = parseLearnings(readFileSync(path, "utf8")).length;
	return {
		id: record.id,
		line,
		entries,
		budget: LEARNINGS_MAX_LINES,
		promotions_remaining: Math.max(0, PROMOTIONS_PER_DAY_MAX - promotedToday - 1),
	};
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

export interface RejectOptions {
	/**
	 * The candidate being rejected: either the full `data/candidates.md` line
	 * (YYYY-MM-DD ...) for backward compatibility, or just the lesson text.
	 * The lesson-text form solves the stuck-candidate problem where long lessons
	 * create lines exceeding the old 300-char validation limit.
	 */
	candidate: string;
	cause: RejectCause;
	reason: string;
	/** Required for `superseded` and `disproven`: name what did it. */
	evidence?: string;
	at?: Date;
}

export interface RejectResult {
	id: string;
	candidate: string;
	cause: RejectCause;
}

/**
 * Record that a candidate will never be promoted — the 9-of-12 path.
 *
 * `data/candidates.md` is not touched: it is append-only by contract, so the
 * disposition lives in the journal instead of as a rewrite of somebody's note.
 * `superseded` and `disproven` must name their evidence, because those two are
 * exactly the claims a future pass would otherwise have to re-derive.
 */
export function rejectCandidate(home: string, options: RejectOptions): RejectResult {
	ensureMemoryScaffold(home);
	const at = options.at ?? new Date();
	const date = today(at);
	if (!(REJECT_CAUSES as readonly string[]).includes(options.cause)) {
		throw new CurationError(`cause must be one of ${REJECT_CAUSES.join(", ")}`);
	}
	const reason = requireOneLine(options.reason, "reason", LEARNING_MAX_CHARS);
	const evidence =
		options.cause === "superseded" || options.cause === "disproven"
			? requireEvidence(options.evidence, `a ${options.cause} rejection`)
			: options.evidence?.trim();

	const candidateText = readMemoryFile(home, "candidates") ?? "";
	const before = candidateText;
	const { candidateLine } = resolveCandidateToLine(options.candidate, candidateText);

	const records = readCurationLog(home);
	const decided = candidateDisposition(records, candidateLine);
	if (decided) {
		const undo =
			decided.action === "promote"
				? `; to remove the learning it produced: cp_memory retire line: ${decided.line ?? `(not recorded — cp_memory audit line: ${candidateLine})`}`
				: "";
		throw new CurationError(
			`that candidate was already ${decided.action === "promote" ? "promoted" : "rejected"} (${decided.id}, ${decided.date}) — a candidate is decided once${undo}`,
		);
	}

	const record = appendCurationRecord(home, {
		id: nextId(records, date),
		at: at.toISOString(),
		date,
		action: "reject",
		candidate: candidateLine,
		cause: options.cause,
		reason,
		...(evidence ? { evidence } : {}),
	});
	// The append-only file stays byte-identical: rejection is a journal entry.
	if ((readMemoryFile(home, "candidates") ?? "") !== before) {
		throw new CurationError(`${LAYOUT.candidatesFile} changed during a rejection; it is append-only`);
	}
	return { id: record.id, candidate: candidateLine, cause: options.cause };
}

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

export interface RetireOptions {
	/** The exact learnings line to retire. */
	line: string;
	reason: string;
	/** A checkable source: the PR that made it false, the date it decayed. */
	evidence: string;
	/** Where the knowledge lives now, when there is somewhere. */
	now?: string;
	at?: Date;
}

export interface RetireResult {
	id: string;
	archived: string;
	remaining: number;
	retirements_remaining: number;
}

/**
 * Retire one learning: journal, then move it to `data/archive.md` with
 * provenance. Held to the promotion path's standard, because the motivating
 * case was a lesson going false within a day — the way out has to be as safe
 * and as auditable as the way in, or nobody will use it.
 *
 * Deletion is not offered at any level: `archiveEntry` writes the archive line
 * before removing the original, so the worst case is a duplicate.
 */
export function retireLearning(home: string, options: RetireOptions): RetireResult {
	ensureMemoryScaffold(home);
	const at = options.at ?? new Date();
	const date = today(at);
	const line = requireOneLine(options.line, "line", 2000);
	const reason = requireOneLine(options.reason, "reason", LEARNING_MAX_CHARS);
	const evidence = requireEvidence(options.evidence, "retirement");

	const learnings = readMemoryFile(home, "learnings") ?? "";
	if (!learnings.split("\n").some((existing) => existing.trim() === line)) {
		throw new CurationError(`no such learning to retire (match the line exactly): ${line.slice(0, 120)}`);
	}
	const records = readCurationLog(home);
	const retiredToday = countOnDate(records, "retire", date);
	if (retiredToday >= RETIREMENTS_PER_DAY_MAX) {
		throw new CurationError(
			`${RETIREMENTS_PER_DAY_MAX} retirements already landed today (${date}) — stop and look at the pass, not at the file`,
		);
	}

	const entry = parseLearnings(line)[0];
	const record = appendCurationRecord(home, {
		id: nextId(records, date),
		at: at.toISOString(),
		date,
		action: "retire",
		line,
		...(entry ? { tier: entry.tier } : {}),
		reason,
		evidence,
		...(options.now ? { now: options.now.trim() } : {}),
	});

	const moved = archiveEntry(home, line, {
		reason: `${reason} (${record.id}; evidence: ${evidence})`,
		...(options.now ? { now: options.now } : {}),
		at,
	});
	return {
		id: record.id,
		archived: moved.archived,
		remaining: moved.remaining,
		retirements_remaining: Math.max(0, RETIREMENTS_PER_DAY_MAX - retiredToday - 1),
	};
}

// ---------------------------------------------------------------------------
// Tracing: a bad line back to the decision that made it
// ---------------------------------------------------------------------------

/**
 * Every decision that ever touched this exact line, oldest first. This is the
 * property that makes an autonomous promotion recoverable rather than merely
 * regrettable: a line in the digest that reads wrong is one lookup away from
 * the candidate, the evidence, the date and the id it came from.
 */
export function traceLearning(home: string, line: string): CurationRecord[] {
	const target = line.trim();
	return readCurationLog(home).filter(
		(record) => record.line?.trim() === target || record.candidate?.trim() === target,
	);
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface CurationPlan {
	date: string;
	status: MemoryStatus;
	/** Candidates with no disposition yet: the pass's actual worklist. */
	pending: string[];
	/** Learnings past their decay window — the retirement worklist. */
	stale: LearningEntry[];
	budget_remaining: number;
	promotions_remaining: number;
	retirements_remaining: number;
	/** The last few journalled decisions, for context. */
	recent: CurationRecord[];
}

export const CURATION_RECENT_MAX = 10;

/**
 * What a curation pass has to work with, computed rather than remembered: the
 * pending candidates in full (the parent has to read them to judge them), the
 * stale learnings, and what today's bounds still allow.
 */
export function curationPlan(home: string, at: Date = new Date()): CurationPlan {
	const date = today(at);
	const status = memoryStatus(home, at);
	const records = readCurationLog(home);
	return {
		date,
		status,
		pending: pendingCandidates(home),
		stale: status.stale,
		budget_remaining: Math.max(0, LEARNINGS_MAX_LINES - status.lines),
		promotions_remaining: Math.max(0, PROMOTIONS_PER_DAY_MAX - countOnDate(records, "promote", date)),
		retirements_remaining: Math.max(0, RETIREMENTS_PER_DAY_MAX - countOnDate(records, "retire", date)),
		recent: records.slice(-CURATION_RECENT_MAX),
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PENDING_SHOWN_MAX = 20;

export function formatCurationPlan(plan: CurationPlan): string {
	const lines = [
		`CURATION ${plan.date} — ${plan.pending.length} pending candidate(s) · ${plan.stale.length} stale learning(s) · ` +
			`${plan.promotions_remaining}/${PROMOTIONS_PER_DAY_MAX} promotions and ${plan.retirements_remaining}/${RETIREMENTS_PER_DAY_MAX} retirements left today · ` +
			`${plan.budget_remaining} line(s) under budget`,
	];
	if (plan.pending.length > 0) {
		lines.push("  pending (promote, or reject with a cause — deciding is the pass, silence is not):");
		for (const candidate of plan.pending.slice(0, PENDING_SHOWN_MAX)) lines.push(`    ${candidate}`);
		if (plan.pending.length > PENDING_SHOWN_MAX) {
			lines.push(`    … ${plan.pending.length - PENDING_SHOWN_MAX} more`);
		}
	}
	if (plan.stale.length > 0) {
		lines.push("  past their decay window (retire with reason + evidence; the archive keeps them):");
		for (const entry of plan.stale.slice(0, PENDING_SHOWN_MAX)) lines.push(`    ${entry.line}`);
	}
	if (plan.budget_remaining === 0) {
		lines.push(`  at budget: nothing can be promoted until something is retired (${LEARNINGS_MAX_LINES} lines)`);
	}
	if (plan.pending.length === 0 && plan.stale.length === 0) lines.push("  nothing to curate");
	return lines.join("\n");
}

export function formatCurationAudit(records: readonly CurationRecord[]): string {
	if (records.length === 0) return `AUDIT ${LAYOUT.curationLog}: no curation decisions recorded yet`;
	const lines = [`AUDIT ${LAYOUT.curationLog} (${records.length} record(s), oldest first):`];
	for (const record of records) {
		const what = record.action === "reject" ? `${record.action}/${record.cause}` : record.action;
		lines.push(`  ${record.id} ${record.date} ${what}: ${record.line ?? record.candidate ?? ""}`);
		const detail = [record.reason, record.evidence ? `evidence: ${record.evidence}` : undefined, record.now ? `now: ${record.now}` : undefined]
			.filter(Boolean)
			.join(" · ");
		if (detail) lines.push(`    ${detail}`);
	}
	return lines.join("\n");
}

/** `/memory status` and `cp_memory status`: the arithmetic plus today's pass. */
export function formatMemoryReport(statusText: string, plan: CurationPlan): string {
	return `${statusText}\n${formatCurationPlan(plan)}`;
}
