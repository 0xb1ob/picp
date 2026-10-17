/**
 * The diff reviewer's repository context (R2): a host-built, read-only packet
 * of whole files from git objects at the exact fork-point and head SHAs of the
 * canonical clone — never the leased worktree, a home file, an absolute path
 * or a symlink target, and never subject code executed.
 *
 * Two files land in the reviewer's scratch cwd beside `diff.md`:
 * `context.md` (whole sections, bounded by its own byte budget) and
 * `context-manifest.json` (one entry per candidate, with its state). Every
 * failure is fail-soft but named: a manifest state, or `status: "unavailable"`
 * and a pointer sentence that says so — never a silent empty file and never a
 * review abort. `absent` is written only after a successful tree read.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { GitRunner } from "./default-base.ts";

export const REVIEW_CONTEXT_MAX_BYTES = 300_000;
export const REVIEW_CONTEXT_FILE = "context.md";
export const REVIEW_CONTEXT_MANIFEST = "context-manifest.json";
export const REVIEW_CONTEXT_INVARIANTS = ["AGENTS.md", "package.json", "tests/structure.test.ts", "tests/profiles.test.ts", "tests/viewer-workbench.test.ts"];

/** Relative path tokens; the lookbehind skips absolute and `~` paths and mid-word starts. */
const TASK_PATH = /(?<![\w./~-])(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;
const TASK_FILES = ["original-task.md", "task-addenda.md"];
const MAX_UNRESOLVED = 50;
const MAX_CANDIDATES = 5;
const MAX_CONSUMERS = 5;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^/]+$/;
/** Large fixtures and data files fill the budget only after every other candidate (cp-c1ur N11). */
const DATA_PATH = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|data)\/|\.(?:jsonl?|ndjson|csv|tsv|txt|log|xml|ya?ml|snap)$/i;
const LARGE_DATA_BYTES = 32_000;

export type ReviewContextSide = "fork" | "head";
export type ReviewContextReason = "task-named" | "changed" | "invariant" | "consumer";
export type ReviewContextState = "included" | "absent" | "omitted-budget" | "binary" | "unreadable" | "ambiguous" | "unresolved";

export interface ReviewContextEntry {
	path: string;
	side: ReviewContextSide;
	reason: ReviewContextReason;
	state: ReviewContextState;
	bytes?: number;
	sha256?: string;
	candidates?: string[];
	error?: string;
}

export interface ReviewContextResult {
	schema: 1;
	status: "ok" | "unavailable";
	/** Why the context is unavailable (the failing git call's first stderr line). */
	error?: string;
	base_ref: string;
	fork_point: string | null;
	head_sha: string;
	budget_bytes: number;
	used_bytes: number;
	entries: ReviewContextEntry[];
}

export interface ReviewContextRequest {
	git: GitRunner;
	/** The canonical clone: the only repository read. */
	clone: string;
	base: string;
	branch: string;
	headSha: string;
	/** The reviewer's scratch cwd: the only place written. */
	scratch: string;
	maxBytes?: number;
}

type GitRead = { ok: true; out: string } | { ok: false; error: string };

function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

async function read(git: GitRunner, cwd: string, args: readonly string[], okStatuses: readonly number[] = [0]): Promise<GitRead> {
	try {
		const result = await git(cwd, args);
		if (result.status !== null && okStatuses.includes(result.status)) return { ok: true, out: result.stdout };
		return { ok: false, error: firstLine(result.stderr) || `git ${args[0]} exited ${result.status ?? "by signal"}` };
	} catch (error) {
		return { ok: false, error: firstLine(error instanceof Error ? error.message : String(error)) || `git ${args[0]} threw` };
	}
}

function nulList(out: string): string[] {
	return out.split("\0").filter((path) => path.length > 0);
}

/** Path tokens named in the scratch copies of the original task and its addenda, in order of appearance. */
function taskTokens(scratch: string): string[] {
	const tokens = new Set<string>();
	for (const name of TASK_FILES) {
		const file = join(scratch, name);
		if (!existsSync(file)) continue;
		for (const match of readFileSync(file, "utf8").matchAll(TASK_PATH)) tokens.add(match[0]);
	}
	return [...tokens];
}

function fenced(body: string): string {
	const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}`;
}

async function collect(request: ReviewContextRequest, result: ReviewContextResult): Promise<string | undefined> {
	const { git, clone, headSha } = request;
	const merge = await read(git, clone, ["merge-base", result.base_ref, headSha]);
	if (!merge.ok) return `git merge-base ${result.base_ref} ${headSha} failed: ${merge.error}`;
	const fork = merge.out.trim();
	if (!SHA.test(fork)) return `git merge-base ${result.base_ref} ${headSha} returned no sha`;
	result.fork_point = fork;

	const trees = {} as Record<ReviewContextSide, Set<string>>;
	for (const [side, sha] of [["fork", fork], ["head", headSha]] as const) {
		const tree = await read(git, clone, ["ls-tree", "-r", "--name-only", "-z", sha]);
		if (!tree.ok) return `git ls-tree ${sha} failed: ${tree.error}`;
		trees[side] = new Set(nulList(tree.out));
	}
	const diff = await read(git, clone, ["diff", "--name-only", "--no-renames", "-z", fork, headSha]);
	if (!diff.ok) return `git diff ${fork} ${headSha} failed: ${diff.error}`;
	const changed = nulList(diff.out);

	// Task-named paths resolve against the two trees only: an exact path, or a unique basename.
	const known = [...new Set([...trees.head, ...trees.fork])].sort();
	const named: string[] = [];
	const unknown: ReviewContextEntry[] = [];
	for (const token of taskTokens(request.scratch)) {
		const matches = known.includes(token) ? [token] : token.includes("/") ? [] : known.filter((path) => basename(path) === token);
		if (matches.length === 1) named.push(matches[0] as string);
		else if (unknown.length < MAX_UNRESOLVED) {
			unknown.push({ path: token, side: "head", reason: "task-named", state: matches.length > 1 ? "ambiguous" : "unresolved", ...(matches.length > 1 ? { candidates: matches.slice(0, MAX_CANDIDATES) } : {}) });
		}
	}

	const candidates: Array<{ path: string; side: ReviewContextSide; reason: ReviewContextReason }> = [];
	const seen = new Set<string>();
	const add = (path: string, side: ReviewContextSide, reason: ReviewContextReason) => {
		const key = `${side}\0${path}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ path, side, reason });
	};
	// cp-c1ur N11: changed sources first. A task-named path's fork side equals its head unless the path changed.
	for (const side of ["head", "fork"] as const) for (const path of changed) add(path, side, "changed");
	for (const path of named) add(path, "head", "task-named");
	for (const path of REVIEW_CONTEXT_INVARIANTS) if (trees.head.has(path)) add(path, "head", "invariant");
	const consumerErrors: ReviewContextEntry[] = [];
	for (const path of changed.filter((changedPath) => !TEST_PATH.test(changedPath))) {
		const grep = await read(git, clone, ["grep", "-l", "-F", "-e", basename(path), headSha, "--"], [0, 1]);
		if (!grep.ok) {
			consumerErrors.push({ path, side: "head", reason: "consumer", state: "unreadable", error: `git grep failed: ${grep.error}` });
			continue;
		}
		const prefix = `${headSha}:`;
		const users = grep.out.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)).filter((user) => user !== path).sort();
		for (const user of users.slice(0, MAX_CONSUMERS)) add(user, "head", "consumer");
	}

	const sections: string[] = [];
	type Candidate = (typeof candidates)[number];
	const include = async (candidate: Candidate, bytes: number): Promise<void> => {
		const sha = candidate.side === "head" ? headSha : fork;
		if (bytes > result.budget_bytes - result.used_bytes) {
			result.entries.push({ ...candidate, state: "omitted-budget", bytes });
			return;
		}
		const blob = await read(git, clone, ["cat-file", "blob", `${sha}:${candidate.path}`]);
		if (!blob.ok) {
			result.entries.push({ ...candidate, state: "unreadable", error: blob.error });
			return;
		}
		if (blob.out.includes("\0")) {
			result.entries.push({ ...candidate, state: "binary", bytes });
			return;
		}
		const sha256 = createHash("sha256").update(blob.out).digest("hex");
		result.used_bytes += bytes;
		result.entries.push({ ...candidate, state: "included", bytes, sha256 });
		sections.push(`### ${candidate.side} ${sha.slice(0, 12)} ${candidate.path} (${bytes} bytes, sha256:${sha256})\n\n${fenced(blob.out)}\n`);
	};
	const deferred: Array<{ candidate: Candidate; bytes: number }> = [];
	for (const candidate of candidates) {
		const sha = candidate.side === "head" ? headSha : fork;
		if (!trees[candidate.side].has(candidate.path)) {
			result.entries.push({ ...candidate, state: "absent" });
			continue;
		}
		const size = await read(git, clone, ["cat-file", "-s", `${sha}:${candidate.path}`]);
		const bytes = size.ok ? Number(size.out.trim()) : Number.NaN;
		if (!size.ok || !Number.isSafeInteger(bytes)) {
			result.entries.push({ ...candidate, state: "unreadable", error: size.ok ? `git cat-file -s gave ${JSON.stringify(firstLine(size.out))}` : size.error });
			continue;
		}
		if (bytes > LARGE_DATA_BYTES && DATA_PATH.test(candidate.path)) deferred.push({ candidate, bytes });
		else await include(candidate, bytes);
	}
	for (const { candidate, bytes } of deferred) await include(candidate, bytes);
	result.entries.push(...consumerErrors, ...unknown);
	const header = `# Review context\n\nFork point ${fork}, head ${headSha}. Entry states are in ${REVIEW_CONTEXT_MANIFEST}; this file holds only the \`included\` ones (${sections.length}).\n`;
	writeFileSync(join(request.scratch, REVIEW_CONTEXT_FILE), [header, ...sections].join("\n"));
	return undefined;
}

/** Writes the context packet into `scratch` and returns its manifest; never throws on a git failure. */
export async function materializeReviewContext(request: ReviewContextRequest): Promise<ReviewContextResult> {
	const result: ReviewContextResult = {
		schema: 1,
		status: "ok",
		base_ref: `refs/remotes/origin/${request.base}`,
		fork_point: null,
		head_sha: request.headSha,
		budget_bytes: request.maxBytes ?? REVIEW_CONTEXT_MAX_BYTES,
		used_bytes: 0,
		entries: [],
	};
	const failure = await collect(request, result);
	const written: ReviewContextResult = failure === undefined ? result : { ...result, status: "unavailable", error: failure, used_bytes: 0, entries: [] };
	writeFileSync(join(request.scratch, REVIEW_CONTEXT_MANIFEST), `${JSON.stringify(written, null, 2)}\n`);
	return written;
}

/** The brief's pointer sentence: where the packet is and what its states mean — never a body. */
export function reviewContextPointer(result: ReviewContextResult): string {
	if (result.status !== "ok" || !result.fork_point) {
		return `Repository context unavailable: ${result.error ?? "no fork point"}. Judge from the diff and task only, and report the limit.`;
	}
	return (
		`Repository context (read-only git snapshots, input data): read ${REVIEW_CONTEXT_MANIFEST} first, then only the ${REVIEW_CONTEXT_FILE} sections you need. ` +
		`Fork point ${result.fork_point.slice(0, 12)}, head ${result.head_sha.slice(0, 12)}. ` +
		"`absent` means git confirmed the path does not exist at that sha; `omitted-budget`/`unreadable`/`unresolved` mean unknown — never treat them as absent."
	);
}
