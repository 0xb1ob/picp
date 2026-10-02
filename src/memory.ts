/**
 * Memory (T26) — the three-tier session memory under `data/`.
 *
 * Ported from command-post's `cp-memory` skill and the file contracts
 * `bin/install.sh` scaffolded. The judgment stays in the skill (what
 * generalizes, what supersedes what, when to consolidate); what moves into code
 * is everything that was only prose discipline before, and therefore only ever
 * as good as the model's attention:
 *
 *  - **Capture appends to `candidates.md`, never `learnings.md`.** The ported
 *    rule was "never blind-append to learnings"; `captureCandidate` is the only
 *    append this module offers, and it writes to the append-only file.
 *  - **Archiving is a move, never a delete.** `archiveEntry` writes the
 *    provenance line to `archive.md` and only then drops the line from
 *    `learnings.md`, so "never delete" cannot be half-done.
 *  - **Decay is dated arithmetic** (`decayCandidates`), not a feeling: pinned
 *    never decays, perishable is stale at 7 days, aging at 30.
 *  - **The scaffold is idempotent** (`write_if_absent`, ported): an existing
 *    file is never rewritten, because it holds the operator's memory.
 *  - **No write ever truncates a memory file** (cp-nqj). Every whole-file write
 *    here goes through `atomicWriteText` (tmp -> fsync -> rename), never
 *    `writeFileSync`, which opens `O_TRUNC` and leaves the target at zero bytes
 *    between the open and the write. That window was reachable on every
 *    retirement (`archiveEntry`) and every capture (`captureCandidate`): a
 *    process killed inside it lost the whole curated memory, not a line of it.
 *    Appends (`data/learnings.md`, `data/curation.jsonl`) stay appends — see
 *    `durableAppend` in `json-store.ts`; a read-modify-write would trade this
 *    tear for lost updates.
 *
 * `data/` is gitignored and machine-local by contract: what generalizes belongs
 * in AGENTS.md or docs/, and job history belongs in br.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { atomicWriteText } from "./json-store.ts";

export class MemoryError extends Error {}

/** Ported budget: learnings stay small enough to load every session. */
export const LEARNINGS_MAX_LINES = 60;

/** Ported decay windows, in days. */
export const PERISHABLE_STALE_DAYS = 7;
export const AGING_STALE_DAYS = 30;

/**
 * Curation bounds. They live here, with the other file budgets, because they
 * are part of the memory files' own contract (the learnings header quotes
 * them) and because `curation.ts` imports this module — not the other way
 * round. `src/curation.ts` re-exports them as its public surface.
 */
export const PROMOTIONS_PER_DAY_MAX = 3;
export const RETIREMENTS_PER_DAY_MAX = 10;

/** One captured line stays a line: a paragraph belongs in a report. */
export const CANDIDATE_MAX_CHARS = 300;

export const MEMORY_TIERS = ["pinned", "aging", "perishable", "untiered"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

// ---------------------------------------------------------------------------
// The scaffold
// ---------------------------------------------------------------------------

/**
 * The file headers, ported verbatim in substance from `bin/install.sh`. They are
 * HTML comments so the contract travels *with* the file: whoever opens
 * `data/learnings.md` in six months reads the rules before the entries.
 */
const LEARNINGS_HEADER = `# Learnings

<!--
Contract: curated core. Always loaded at session start.
Budget: max ~${LEARNINGS_MAX_LINES} lines / ~1,500 tokens. Over budget -> consolidate or demote
until under before the file is saved.

Writes: inspect, then decide - and the decision is never a blind append.
Read the whole file, classify the finding as new / duplicate / superseding /
obsoleting, and only a genuinely new one is written. It is written by
cp_memory promote, which appends it and cannot alter a line already here
(append-only, proved on the bytes). A duplicate is refused, not folded in; a
superseded entry leaves through cp_memory retire, which moves it to
data/archive.md with provenance. A hand edit is the only way to rewrite a
line, and it is the operator's, not a pass's. Every write leaves the file more
accurate, not merely longer.

Entries: one line each, dated, evidence-backed. Shape:
  - YYYY-MM-DD what happened; what to do; evidence: <source>. <!--tier-->
Tiers (trailing HTML comments):
  <!--P-->            pinned - never decays
  <!--a:YYYY-MM-DD--> aging - stale at >=${AGING_STALE_DAYS} days since last reinforcement
  <!--p:YYYY-MM-DD--> perishable - stale at >=${PERISHABLE_STALE_DAYS} days; must name a checkable
                      expiry condition (issue, version, dated expectation)
Reinforcement counts only on real evidence of use this session. Re-reading
memory is never reinforcement.

Scope: this machine and this home only. Anything a fresh command post would
need is a contract edit (AGENTS.md / docs/), not a learning. Project-intrinsic
facts ("repo X's tests need flag Y") go to that repo's AGENTS.md via a worker.

Job history lives in br (closed issues), not here.

Promotion: candidates live in data/candidates.md until a curation pass
promotes ones that generalize. Capture is not promotion, and promotion is not
a hand edit: it goes through cp_memory promote, which composes this shape,
refuses an unevidenced or pinned line, appends (never rewrites), bounds itself
to ${PROMOTIONS_PER_DAY_MAX} per day and to this budget, and journals every
decision to data/curation.jsonl.

Decay: evaluated lazily at curation (when the session-start digest reports pending or stale). Stale
entries move to data/archive.md with provenance - never delete. Nothing an
autonomous pass writes is pinned, so every promoted line has a shelf life.
-->
`;

const CANDIDATES_HEADER = `# Candidates

<!--
Contract: append-only capture of reflection candidates. Never loaded wholesale.
Who writes: the parent session, at job completion or failure, when a lesson was
observed - through \`/memory capture <lesson>\`, which appends here and never
touches data/learnings.md.
When: one dated line per candidate. Most jobs yield nothing.
What: \`YYYY-MM-DD <one-line lesson>\`. Failures include a one-sentence root
cause when a generalization is worth promoting.
Promotion: candidates stay here until a curation pass inspects data/learnings.md
and promotes ones that generalize. Capture is not promotion.
Disposition: a candidate is promoted or rejected exactly once, and the decision
is recorded in data/curation.jsonl - never as an edit to this file. A rejected
candidate (superseded, disproven, generalizes, noise) can never be promoted.
Do not rewrite or delete lines.
-->
`;

const ARCHIVE_HEADER = `# Archive

<!--
Contract: cold tier for demoted learnings. Never loaded at session start.
Who writes: the parent session, during a curation pass (when the digest reports
pending or stale).
When: perishable entries whose named condition is expired (>=${PERISHABLE_STALE_DAYS}d), or aging
entries with no reinforcement this period (>=${AGING_STALE_DAYS}d), or any entry demoted to
enforce the data/learnings.md budget.
What: the original learning line plus provenance - source file, tier, date
moved, and a one-line reason. Shape:
  - YYYY-MM-DD (from data/learnings.md, <!--a:...-->, archived YYYY-MM-DD): <entry>. Reason: <why>

Never delete. Recovery is \`rg\` plus a copy-back into data/learnings.md by
hand - a curation pass never restores a line, because promotion appends and
cannot rewrite.
-->
`;

export interface MemoryFileSpec {
	key: "learnings" | "candidates" | "archive";
	/** Home-relative path, from `LAYOUT`. */
	path: string;
	header: string;
}

/**
 * `path` is a getter, not a captured string: `configureLayout` runs at session
 * start, after this module is imported, so a value read here at import time
 * would pin the default layout before `configureLayout` runs.
 */
export const MEMORY_FILES: readonly MemoryFileSpec[] = Object.freeze([
	{
		key: "learnings" as const,
		get path() {
			return LAYOUT.learningsFile;
		},
		header: LEARNINGS_HEADER,
	},
	{
		key: "candidates" as const,
		get path() {
			return LAYOUT.candidatesFile;
		},
		header: CANDIDATES_HEADER,
	},
	{
		key: "archive" as const,
		get path() {
			return LAYOUT.archiveFile;
		},
		header: ARCHIVE_HEADER,
	},
]);

export interface ScaffoldResult {
	/** Files this call created. */
	created: string[];
	/** Files that already existed and were left exactly as they were. */
	kept: string[];
}

/**
 * Create the three files if they are absent. **Idempotent**, and deliberately
 * so: an existing file holds the operator's curated memory, and the one
 * unforgivable bug in a scaffold is overwriting it.
 */
export function ensureMemoryScaffold(home: string): ScaffoldResult {
	const result: ScaffoldResult = { created: [], kept: [] };
	for (const file of MEMORY_FILES) {
		const path = join(home, file.path);
		if (existsSync(path)) {
			result.kept.push(file.path);
			continue;
		}
		atomicWriteText(path, file.header);
		result.created.push(file.path);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Reading learnings
// ---------------------------------------------------------------------------

export interface LearningEntry {
	/** The line as written, including its tier comment. */
	line: string;
	/** The entry's own date (`- YYYY-MM-DD …`), when it has one. */
	date?: string;
	tier: MemoryTier;
	/** The tier's reference date (aging/perishable), when present. */
	since?: string;
}

const ENTRY_RE = /^-\s+(?<date>\d{4}-\d{2}-\d{2})?\s*(?<body>.*)$/;
const PINNED_RE = /<!--\s*P\s*-->/;
const AGING_RE = /<!--\s*a:(?<since>\d{4}-\d{2}-\d{2})\s*-->/;
const PERISHABLE_RE = /<!--\s*p:(?<since>\d{4}-\d{2}-\d{2})\s*-->/;

/**
 * Entries are the `- ` lines. The header's HTML comment block is skipped, so
 * the contract text is never mistaken for memory.
 */
export function parseLearnings(text: string): LearningEntry[] {
	const entries: LearningEntry[] = [];
	let inComment = false;
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (inComment) {
			if (line.includes("-->")) inComment = false;
			continue;
		}
		if (line.trimStart().startsWith("<!--") && !line.includes("-->")) {
			inComment = true;
			continue;
		}
		if (!line.startsWith("- ")) continue;
		const match = ENTRY_RE.exec(line);
		if (!match) continue;
		const pinned = PINNED_RE.test(line);
		const aging = AGING_RE.exec(line);
		const perishable = PERISHABLE_RE.exec(line);
		const tier: MemoryTier = pinned ? "pinned" : perishable ? "perishable" : aging ? "aging" : "untiered";
		const since = perishable?.groups?.since ?? aging?.groups?.since;
		entries.push({
			line,
			...(match.groups?.date ? { date: match.groups.date } : {}),
			tier,
			...(since ? { since } : {}),
		});
	}
	return entries;
}

export interface MemoryStatus {
	home: string;
	/** Files that exist. A missing file is not an error; it is unscaffolded. */
	present: Record<MemoryFileSpec["key"], boolean>;
	entries: LearningEntry[];
	tiers: Record<MemoryTier, number>;
	lines: number;
	budget: number;
	over_budget: boolean;
	/** Entries whose dated window has expired (`decayCandidates`). */
	stale: LearningEntry[];
	/** Entries with no tier: a contract violation, reported not repaired. */
	untiered: LearningEntry[];
	candidates: number;
	/**
	 * Candidate lines that are not the contract shape (`YYYY-MM-DD <text>`).
	 *
	 * Reported for the same reason `untiered` is: curation reads what the file
	 * says it contains, so a line the counter cannot see is a lesson that will
	 * never be promoted — invisible, not merely uncounted. Never repaired here;
	 * rewriting somebody's note is not a status command's job (cp-2lh).
	 */
	malformed_candidates: string[];
}

export function readMemoryFile(home: string, key: MemoryFileSpec["key"]): string | undefined {
	const spec = MEMORY_FILES.find((file) => file.key === key);
	if (!spec) throw new MemoryError(`unknown memory file ${key}`);
	const path = join(home, spec.path);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Days between two `YYYY-MM-DD` dates; `undefined` when either is unusable. */
export function daysBetween(from: string, to: string): number | undefined {
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	return Math.floor((end - start) / 86_400_000);
}

/**
 * Lazy decay, ported: pinned never decays, perishable is stale at
 * `PERISHABLE_STALE_DAYS`, aging at `AGING_STALE_DAYS`. An untiered entry is
 * never decayed — it is a contract violation and is reported as one, because
 * guessing a tier would silently archive somebody's note.
 */
export function decayCandidates(entries: readonly LearningEntry[], today: string): LearningEntry[] {
	return entries.filter((entry) => {
		if (entry.tier === "pinned" || entry.tier === "untiered") return false;
		const reference = entry.since ?? entry.date;
		if (!reference) return false;
		const age = daysBetween(reference, today);
		if (age === undefined) return false;
		return age >= (entry.tier === "perishable" ? PERISHABLE_STALE_DAYS : AGING_STALE_DAYS);
	});
}

/** Today in the contract's date format (UTC, matching every stored date). */
export function today(at: Date = new Date()): string {
	return at.toISOString().slice(0, 10);
}

export function memoryStatus(home: string, at: Date = new Date()): MemoryStatus {
	const learnings = readMemoryFile(home, "learnings");
	const candidates = readMemoryFile(home, "candidates");
	const entries = learnings ? parseLearnings(learnings) : [];
	const scan: CandidateScan = candidates ? scanCandidates(candidates) : { counted: 0, lines: [], malformed: [] };
	const tiers: Record<MemoryTier, number> = { pinned: 0, aging: 0, perishable: 0, untiered: 0 };
	for (const entry of entries) tiers[entry.tier] += 1;
	return {
		home,
		present: {
			learnings: learnings !== undefined,
			candidates: candidates !== undefined,
			archive: readMemoryFile(home, "archive") !== undefined,
		},
		entries,
		tiers,
		lines: entries.length,
		budget: LEARNINGS_MAX_LINES,
		over_budget: entries.length > LEARNINGS_MAX_LINES,
		stale: decayCandidates(entries, today(at)),
		untiered: entries.filter((entry) => entry.tier === "untiered"),
		// Candidates are dated plain lines by contract, not `- ` entries.
		candidates: scan.counted,
		malformed_candidates: scan.malformed,
	};
}

/** How many candidate lines a file holds, and which lines it holds badly. */
export interface CandidateScan {
	counted: number;
	/** The contract-shaped lines themselves, in file order. */
	lines: string[];
	/** Off-contract lines, in file order, capped so a mangled file cannot flood. */
	malformed: string[];
}

/** A candidate line is `YYYY-MM-DD <text>` — dated and plain, never `- `. */
const CANDIDATE_LINE = /^\d{4}-\d{2}-\d{2}\s+\S/;
/** Enough to fix a file by hand; more than this is a file to open, not to list. */
export const MALFORMED_CANDIDATES_MAX = 10;

/**
 * Scan `data/candidates.md`: count contract-shaped lines and collect the rest.
 *
 * Everything that is not content is skipped rather than reported — the header,
 * blank lines, markdown headings and HTML comments (including multi-line ones).
 * What remains is either a candidate or a line somebody meant to be one.
 */
export function scanCandidates(text: string): CandidateScan {
	let inComment = false;
	const lines: string[] = [];
	const malformed: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (inComment) {
			if (line.includes("-->")) inComment = false;
			continue;
		}
		if (line.startsWith("<!--")) {
			if (!line.includes("-->")) inComment = true;
			continue;
		}
		if (line.length === 0 || line.startsWith("#")) continue;
		if (CANDIDATE_LINE.test(line)) {
			lines.push(line);
			continue;
		}
		if (malformed.length < MALFORMED_CANDIDATES_MAX) malformed.push(line);
	}
	return { counted: lines.length, lines, malformed };
}

/**
 * The session-start read. Returns the learnings **entries** (never the contract
 * header) as one block, or `undefined` when there is nothing to load — a fresh
 * home must not start every session by announcing that it has no memory.
 *
 * Over budget, the digest is truncated and says so: the point of the budget is
 * that this text enters every session's context.
 */
export function sessionStartDigest(home: string, at: Date = new Date()): string | undefined {
	const status = memoryStatus(home, at);
	if (status.entries.length === 0) return undefined;
	const kept = status.entries.slice(0, LEARNINGS_MAX_LINES);
	const lines = [`${LAYOUT.learningsFile} (${status.lines} entr${status.lines === 1 ? "y" : "ies"}, machine-local):`];
	for (const entry of kept) lines.push(entry.line);
	if (status.entries.length > kept.length) {
		lines.push(
			`… ${status.entries.length - kept.length} entries beyond the ${LEARNINGS_MAX_LINES}-line budget were not loaded — curate now (cp_memory curate; skill: cp-memory).`,
		);
	}
	if (status.stale.length > 0) {
		lines.push(
			`(${status.stale.length} entr${status.stale.length === 1 ? "y" : "ies"} past their decay window; curate now — cp_memory curate.)`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writing: capture and archive
// ---------------------------------------------------------------------------

export interface CaptureResult {
	line: string;
	file: string;
	/** Total dated candidate lines after the append. */
	candidates: number;
}

/**
 * Append one dated candidate line. This is the **only** append this module
 * offers, and it cannot touch `learnings.md`: the ported rule "capture is not
 * promotion" stops being a thing the model has to remember.
 */
export function captureCandidate(home: string, lesson: string, at: Date = new Date()): CaptureResult {
	const text = lesson.trim();
	if (text.length === 0) throw new MemoryError("capture needs a one-line lesson");
	if (text.includes("\n")) {
		throw new MemoryError("a candidate is one line — put the long version in a report and capture the lesson");
	}
	if (text.length > CANDIDATE_MAX_CHARS) {
		throw new MemoryError(`a candidate is at most ${CANDIDATE_MAX_CHARS} chars (got ${text.length})`);
	}
	ensureMemoryScaffold(home);
	const spec = MEMORY_FILES.find((file) => file.key === "candidates") as MemoryFileSpec;
	const path = join(home, spec.path);
	const existing = readFileSync(path, "utf8");
	const line = `${today(at)} ${text}`;
	const separator = existing.endsWith("\n") ? "" : "\n";
	// Atomic, never `writeFileSync`: this file is the capture log, and a kill
	// between an `O_TRUNC` open and its write would empty it (cp-nqj).
	atomicWriteText(path, `${existing}${separator}${line}\n`);
	return { line, file: spec.path, candidates: scanCandidates(readFileSync(path, "utf8")).counted };
}

export interface ArchiveResult {
	archived: string;
	/** Learnings entries left after the move. */
	remaining: number;
}

/**
 * Move one learning to the cold tier. The archive line is written **first**, so
 * a crash between the two writes leaves a duplicate (recoverable) rather than a
 * hole (not). Both writes are atomic renames, so a crash *inside* either one
 * leaves that file exactly as it was — the two-write ordering only buys
 * anything if neither write can destroy its own file. Ported provenance shape;
 * `Now:` is appended when the caller can name where the knowledge went.
 */
export function archiveEntry(
	home: string,
	entryLine: string,
	options: { reason: string; now?: string; at?: Date },
): ArchiveResult {
	const learnings = readMemoryFile(home, "learnings");
	if (learnings === undefined) throw new MemoryError(`${LAYOUT.learningsFile} does not exist yet — nothing to archive`);
	const target = entryLine.trim();
	const lines = learnings.split("\n");
	const index = lines.findIndex((line) => line.trim() === target);
	if (index === -1) {
		throw new MemoryError(`no such learning to archive (match the line exactly): ${target.slice(0, 120)}`);
	}
	if (options.reason.trim().length === 0) throw new MemoryError("archiving needs a reason (provenance is the point)");

	const entry = parseLearnings(target)[0];
	const tierMark = entry?.tier === "pinned" ? "<!--P-->" : entry?.since ? `<!--${entry.tier === "perishable" ? "p" : "a"}:${entry.since}-->` : "<!--untiered-->";
	const stamp = today(options.at ?? new Date());
	const body = target.replace(/^-\s+/, "");
	const provenance =
		`- ${stamp} (from ${LAYOUT.learningsFile}, ${tierMark}, archived ${stamp}): ${body}. Reason: ${options.reason.trim()}` +
		(options.now ? `. Now: ${options.now.trim()}` : "");

	ensureMemoryScaffold(home);
	const archivePath = join(home, LAYOUT.archiveFile);
	const archive = readFileSync(archivePath, "utf8");
	atomicWriteText(archivePath, `${archive}${archive.endsWith("\n") ? "" : "\n"}${provenance}\n`);

	// The sharpest instance of the truncation window (cp-nqj): this is the one
	// write in the system that legitimately shortens `learnings.md`, and under
	// `writeFileSync` the whole file was zero bytes between the open and the
	// write. Rename-in instead, so a crash leaves the pre-archive file whole.
	lines.splice(index, 1);
	atomicWriteText(join(home, LAYOUT.learningsFile), lines.join("\n"));
	return { archived: provenance, remaining: parseLearnings(lines.join("\n")).length };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function formatMemoryStatus(status: MemoryStatus): string {
	const missing = MEMORY_FILES.filter((file) => !status.present[file.key]).map((file) => file.path);
	const lines = [
		`MEMORY ${status.lines}/${status.budget} learning line(s)${status.over_budget ? " — OVER BUDGET" : ""} · ${status.candidates} candidate(s)`,
		`  tiers: ${status.tiers.pinned} pinned · ${status.tiers.aging} aging · ${status.tiers.perishable} perishable${
			status.tiers.untiered > 0 ? ` · ${status.tiers.untiered} untiered` : ""
		}`,
	];
	if (missing.length > 0) lines.push(`  not scaffolded yet: ${missing.join(", ")}`);
	if (status.over_budget) {
		lines.push(`  budget: archive absorbed or stale entries until under ${status.budget} (pinned entries are not dropped for space)`);
	}
	if (status.stale.length > 0) {
		lines.push(`  past their decay window (${status.stale.length}):`);
		for (const entry of status.stale.slice(0, 10)) lines.push(`    ${entry.line}`);
		if (status.stale.length > 10) lines.push(`    … ${status.stale.length - 10} more`);
	}
	if (status.untiered.length > 0) {
		lines.push(`  untiered (contract wants <!--P-->, <!--a:DATE--> or <!--p:DATE-->):`);
		for (const entry of status.untiered.slice(0, 10)) lines.push(`    ${entry.line}`);
	}
	if (status.malformed_candidates.length > 0) {
		// An invisible candidate is worse than a missing one: nobody is looking for
		// it. Name the shape, then show the lines.
		lines.push(`  candidates that will never be promoted (want \`YYYY-MM-DD <lesson>\`):`);
		for (const line of status.malformed_candidates) lines.push(`    ${line}`);
		if (status.malformed_candidates.length === MALFORMED_CANDIDATES_MAX) {
			lines.push("    … more; open the file");
		}
	}
	if (
		status.stale.length === 0 &&
		!status.over_budget &&
		status.untiered.length === 0 &&
		status.malformed_candidates.length === 0
	) {
		lines.push("  nothing to curate");
	}
	return lines.join("\n");
}
