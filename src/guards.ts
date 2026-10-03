/**
 * Parent context guards — the rules that used to be prose in AGENTS.md.
 *
 * Three of command-post's hardest-won operating rules were "the parent must
 * remember not to…", which is another way of saying they were unenforced:
 *
 *  1. **The parent never reads artifact bodies.** A findings body in the
 *     parent's context is how a fleet controller turns into an implementer.
 *  2. **The ledger never holds an artifact body.** `state/artifacts/<job-id>/
 *     report.md` is the only home of findings, so no ledger read can leak one.
 *  3. **`data/ state/ projects/ .beads/ .pi-command-post/` are never
 *     committed or pushed.** They are runtime truth, not source.
 *
 * Here they are `tool_call` guards: a decision function over the tool name and
 * its arguments, returning a block reason the model can act on. Policy is code,
 * and the reason names the sanctioned alternative every time.
 *
 * Scope: this runs in the PARENT session only. Workers spawn with
 * `--no-extensions` and never load this file — a worker reading the artifact it
 * is being asked to implement is the entire point of `cp_artifact get`.
 */

import { resolve } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import { isInside, LAYOUT, NEVER_COMMIT_PATHS } from "./contracts.ts";
import { canonicalDir } from "./json-store.ts";

export const GUARD_CODES = [
	/** A tool call that would put an artifact body into the parent's context. */
	"artifact_body_read",
	/** A tool call that would let the parent author or destroy an artifact. */
	"artifact_body_write",
	/** Staging or pushing runtime state. */
	"never_commit_path",
	/** A bulk `git add`/`git commit -a` in the command post home. */
	"bulk_stage_in_home",
	/** A read of a worker's operator-question journal (T31). */
	"question_journal_read",
	/** The console's approval of a plan: an authorization record the parent relays, never reads. */
	"review_approval_read",
	/** Parent git may not rewrite a live worker lease. */
	"leased_git_mutation",
	/** A tool call that would put a diff-review body into the parent's context. */
	"diff_body_read",
	/** A parent read of the checks API (`gh pr checks`, `statusCheckRollup`), refused in this home. */
	"ci_checks_read",
] as const;
export type GuardCode = (typeof GUARD_CODES)[number];

export interface GuardDecision {
	code: GuardCode;
	/** Model-facing: says what was blocked, why, and what to do instead. */
	reason: string;
	/** The offending path or argument, when there is exactly one. */
	subject?: string;
}

export interface GuardRequest {
	toolName: string;
	/** The tool's arguments, verbatim from the `tool_call` event. */
	input: unknown;
	/** The parent session's cwd; relative paths are resolved against it. */
	cwd?: string;
}

export interface ContextGuardOptions {
	home: string;
	artifacts: ArtifactStore;
	/** Live worktree paths, read at check time so returned leases are not blocked. */
	leases?: () => readonly string[];
}

/** Tools whose *path* argument would pull a body into context. */
const READING_TOOLS = new Set(["read", "grep"]);
/** Tools whose *path* argument would let the parent author an artifact. */
const WRITING_TOOLS = new Set(["edit", "write"]);

/**
 * Bash programs that actually emit, move or open a file's *contents* — the
 * shapes named in the guard's brief ("cat/read/less/more/head/tail/cp/mv and
 * friends") plus the other common content-surfacing tools. A program outside
 * this set that merely *names* an artifact path in one of its arguments (`br
 * create -d "..."`, `echo`, `printf`, a commit message) never reads the body,
 * so it is not on this list.
 */
const REAL_READ_COMMANDS = new Set([
	"cat",
	"read",
	"less",
	"more",
	"tac",
	"nl",
	"od",
	"xxd",
	"hexdump",
	"head",
	"tail",
	"view",
	"vim",
	"vi",
	"nvim",
	"nano",
	"emacs",
	"pico",
	"bat",
	"batcat",
	"open",
	"sed",
	"awk",
	"perl",
	"python",
	"python3",
	"ruby",
	"php",
	"node",
	"tee",
	"dd",
	"cp",
	"mv",
	"ln",
	"scp",
	"rsync",
	"install",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"ag",
	"ack",
	"zcat",
	"gunzip",
	"zless",
	"bzcat",
	"xz",
	"strings",
	"diff",
	"cmp",
	"comm",
	"join",
	"paste",
	"base64",
]);

/**
 * Programs that can smuggle a real read through indirection — the pipeline,
 * `xargs`, and `sh -c` shapes the brief calls out by name. Any of these
 * appearing in a pipeline that touches an artifact anywhere is refused, even
 * when this particular stage's own arguments do not name the path: that is
 * exactly the evasion (`echo <path> | xargs cat`).
 */
const SHELL_WRAPPERS = new Set(["xargs", "sh", "bash", "zsh", "ksh", "dash", "eval", "source"]);

/**
 * Bash commands that report *about* a file without emitting its contents.
 * Everything else that names an artifact path is refused — an allowlist is the
 * only shape of this rule that fails closed.
 */
const METADATA_COMMANDS = new Set([
	"ls",
	"stat",
	"wc",
	"find",
	"du",
	"mkdir",
	"test",
	"basename",
	"dirname",
	"realpath",
	"file",
	"shasum",
	"sha256sum",
	"md5sum",
]);

/**
 * Matches a path inside a diff-review run's scratch/run directory —
 * `state/runs/<job-id>/review-<attempt>/…` — but not the top-level attempt
 * record (`review-<attempt>.json`) that sits beside it. The trailing edge is
 * strict (a `/` or end of string, so `review-1.json` never matches); the
 * leading edge is just "not a word character", not "start of string or `/`",
 * so an embedded occurrence (`sh -c "cat state/runs/.../review-1/x"`, a
 * quoted argument, …) still matches. Digits-only so a plain textual
 * coincidence like `review-notes/` never matches either.
 */
const REVIEW_DIR_RE = /(?:^|[^0-9A-Za-z_])state[\\/]runs[\\/][^\\/]+[\\/]review-\d+(?:[\\/]|$)/;

function isReviewPathString(path: string): boolean {
	return REVIEW_DIR_RE.test(path);
}

/** git subcommands that can put a path into a commit or send one to a remote. */
const GIT_PUBLISHING_SUBCOMMANDS = new Set(["add", "stage", "commit", "rm", "stash", "push"]);

/** The checks API: `gh pr checks` or any `gh` call asking for `statusCheckRollup`. */
const CI_CHECKS_READ_RE = /\bgh\s+pr\s+checks\b|statusCheckRollup/;
const CI_CHECKS_READ_REASON =
	"blocked: the checks API is refused in this home; CI is read from the Actions runs API by cp_integrate and " +
	"the cp-ci wake-up — call cp_integrate <job-id>";

export class ContextGuard {
	readonly #home: string;
	readonly #canonicalHome: string;
	readonly #artifacts: ArtifactStore;
	readonly #leases: () => readonly string[];

	constructor(options: ContextGuardOptions) {
		this.#home = options.home;
		this.#canonicalHome = canonicalDir(options.home);
		this.#artifacts = options.artifacts;
		this.#leases = options.leases ?? (() => []);
	}

	/** `undefined` means "allowed". Anything else is a block with a reason. */
	check(request: GuardRequest): GuardDecision | undefined {
		const input = (typeof request.input === "object" && request.input !== null ? request.input : {}) as Record<
			string,
			unknown
		>;
		const cwd = request.cwd ?? this.#home;

		if (request.toolName === "bash" || request.toolName === "powershell") {
			const command = typeof input.command === "string" ? input.command : undefined;
			return command ? this.#checkCommand(command, cwd) : undefined;
		}

		const path = firstString(input.path, input.file_path);
		if (path === undefined) return undefined;
		if (READING_TOOLS.has(request.toolName) && isQuestionJournal(path)) {
			return { code: "question_journal_read", subject: path, reason: questionJournalReason(path) };
		}
		if (READING_TOOLS.has(request.toolName) && isReviewApproval(path)) {
			return { code: "review_approval_read", subject: path, reason: reviewApprovalReason(path) };
		}
		if (READING_TOOLS.has(request.toolName) && this.#isReviewPath(path, cwd)) {
			return { code: "diff_body_read", subject: path, reason: this.#diffBodyReadReason(path) };
		}
		if (!this.#isArtifactPath(path, cwd)) return undefined;

		if (READING_TOOLS.has(request.toolName)) {
			return { code: "artifact_body_read", subject: path, reason: this.#bodyReadReason(path) };
		}
		if (WRITING_TOOLS.has(request.toolName)) {
			return {
				code: "artifact_body_write",
				subject: path,
				reason:
					`blocked: ${path} is inside the artifact store. The artifact is the worker's deliverable — the parent ` +
					"never authors or edits one. Use cp_artifact add to file a file into the store, or dispatch a worker to rewrite it.",
			};
		}
		return undefined;
	}

	// -- bash ---------------------------------------------------------------

	#checkCommand(command: string, cwd: string): GuardDecision | undefined {
		let shellCwd = cwd;
		let uncertainCwd = false;
		for (const statement of splitStatements(command)) {
			const stages = splitStages(statement);
			for (const stage of stages) {
				const argv = stripEnvAssignments(tokenize(stage));
				const program = basename(argv[0] ?? "");

				if (program === "cd") {
					const dir = argv[1];
					uncertainCwd = !dir || shellPathUnresolved(dir);
					if (dir && !uncertainCwd) shellCwd = resolve(shellCwd, dir);
				}
				if (program === "git") {
					const decision = this.#checkGit(argv, stage, shellCwd, uncertainCwd);
					if (decision) return decision;
				}
				if (program === "gh" && CI_CHECKS_READ_RE.test(stage)) {
					return { code: "ci_checks_read", subject: stage.trim(), reason: CI_CHECKS_READ_REASON };
				}

				// T31: the question journal is the operator's record, not the parent's
				// reading material. Same allowlist shape as the artifact rule.
				const journalToken = argv.find((token) => isQuestionJournal(token));
				const metadataOnly = METADATA_COMMANDS.has(program) && !hasSubstitution(stage) && !stage.includes("<");
				if (journalToken && !metadataOnly) {
					return { code: "question_journal_read", subject: journalToken, reason: questionJournalReason(journalToken) };
				}
				const approvalToken = argv.find((token) => isReviewApproval(token));
				if (approvalToken && !metadataOnly) {
					return { code: "review_approval_read", subject: approvalToken, reason: reviewApprovalReason(approvalToken) };
				}
			}

			const decision = this.#checkArtifactRead(statement, stages, cwd);
			if (decision) return decision;
		}
		return undefined;
	}

	/**
	 * Refuse a statement only when it would actually surface an artifact's
	 * *contents* — a real read/write command targeting the path, redirection
	 * into or out of it, a substitution, or a pipeline stage (`xargs`, `sh -c`,
	 * …) that could consume it indirectly. A bare textual mention of the path
	 * inside an unrelated command's argument (`echo`, a job description, a
	 * commit message) is left alone: the guard exists for context integrity,
	 * not to ban the string.
	 */
	#checkArtifactRead(statement: string, stages: readonly string[], cwd: string): GuardDecision | undefined {
		const stageInfos = stages.map((stage) => {
			const argv = stripEnvAssignments(tokenize(stage));
			const program = basename(argv[0] ?? "");
			return {
				stage,
				argv,
				program,
				touchesArtifacts: this.#segmentTouchesArtifacts(stage, argv, cwd),
				touchesReview: this.#segmentTouchesReview(stage, argv, cwd),
			};
		});

		const anyTouchesArtifacts = stageInfos.some((info) => info.touchesArtifacts) || statement.includes(LAYOUT.artifacts);
		const anyTouchesReview = stageInfos.some((info) => info.touchesReview) || isReviewPathString(statement);
		if (!anyTouchesArtifacts && !anyTouchesReview) return undefined;

		// A pipeline carries data between its stages: mentioning the path in one
		// stage and reading stdin in the next (`echo <path> | xargs cat`) is still
		// a real read, even though no single stage's own arguments name the path.
		const piped = stageInfos.length > 1;

		for (const info of stageInfos) {
			const isRedirect = /[<>]/.test(info.stage);
			const hasSub = hasSubstitution(info.stage);
			// A metadata command is allowed to *describe* an artifact or review path,
			// including through a plain input redirect (`wc -c < report.md`, the
			// shape the guard's own refusal message promises): the command's own
			// output stays metadata (a count, a size, a hash) whether the path
			// arrives as an argument or on stdin. A substitution, an output
			// redirect/append, a heredoc or a process substitution can still
			// smuggle the body into the arguments (or the destination) of
			// something else, so those stay refused even for a metadata command.
			const isDangerousRedirect = hasDangerousRedirect(info.stage);
			if (METADATA_COMMANDS.has(info.program) && !hasSub && !isDangerousRedirect) continue;

			const isRealRead = REAL_READ_COMMANDS.has(info.program) || SHELL_WRAPPERS.has(info.program) || isRedirect || hasSub;
			if (!isRealRead) continue;
			if (!(info.touchesArtifacts || info.touchesReview || piped)) continue;

			// A review path takes priority when this stage names one directly; when
			// the read comes through a pipe with no path of its own, fall back to
			// whichever kind the pipeline touched (review first — it is the more
			// specific, rarer case, and the two shapes never legitimately overlap).
			const isReview = info.touchesReview || (piped && !info.touchesArtifacts && anyTouchesReview);
			if (isReview) {
				const subject =
					stageInfos.map((s) => this.#reviewToken(s.stage, s.argv, cwd)).find((token) => token !== undefined) ??
					statement.trim();
				return { code: "diff_body_read", subject, reason: this.#diffBodyReadReason(subject) };
			}

			const subject =
				stageInfos.map((s) => this.#artifactToken(s.stage, s.argv, cwd)).find((token) => token !== undefined) ??
				statement.trim();
			return { code: "artifact_body_read", subject, reason: this.#bodyReadReason(subject) };
		}
		return undefined;
	}

	#checkGit(argv: readonly string[], segment: string, cwd: string, uncertainCwd = false): GuardDecision | undefined {
		const { subcommand, args } = parseGit(argv);
		if (!subcommand) return undefined;
		if (isDestructiveGit(subcommand, args)) {
			let target = cwd;
			let unresolved = uncertainCwd;
			let gitDir = tokenize(segment).find((token) => token.startsWith("GIT_DIR="))?.slice("GIT_DIR=".length);
			for (let i = 1; i < argv.length && argv[i] !== subcommand; i++) {
				const token = argv[i] ?? "";
				if (token === "-C" || token === "--work-tree") {
					const dir = argv[++i] ?? "";
					unresolved ||= !dir || shellPathUnresolved(dir);
					if (token === "-C") target = resolve(target, dir);
					else target = resolve(cwd, dir);
				} else if (token.startsWith("-C") && token.length > 2) {
					const dir = token.slice(2);
					unresolved ||= shellPathUnresolved(dir);
					target = resolve(target, dir);
				} else if (token.startsWith("--work-tree=")) {
					const dir = token.slice("--work-tree=".length);
					unresolved ||= !dir || shellPathUnresolved(dir);
					target = resolve(cwd, dir);
				} else if (token === "--git-dir" || token.startsWith("--git-dir=")) {
					gitDir = token === "--git-dir" ? argv[++i] : token.slice("--git-dir=".length);
				}
			}
			unresolved ||= gitDir !== undefined && (!gitDir || shellPathUnresolved(gitDir));
			const leased = this.#leases().some((path) => {
				const root = canonicalDir(resolve(path));
				return unresolved || isInside(canonicalDir(resolve(target)), root) ||
					(gitDir !== undefined && isInside(canonicalDir(resolve(cwd, gitDir)), root));
			});
			if (leased) return {
				code: "leased_git_mutation",
				subject: segment.trim(),
				reason: `blocked: parent git ${subcommand} may target a live worker lease. Use cp_send/cp_revive for worker changes or cp_integrate for merge and sync; keep the lease intact.`,
			};
		}
		if (!GIT_PUBLISHING_SUBCOMMANDS.has(subcommand)) return undefined;

		for (const token of args) {
			if (token.startsWith("-")) continue;
			const matched = this.#neverCommitPath(token, cwd);
			if (!matched) continue;
			return {
				code: "never_commit_path",
				subject: token,
				reason:
					`blocked: \`git ${subcommand} ${token}\` would publish ${matched}, which is runtime state and is never ` +
					`committed or pushed (${NEVER_COMMIT_PATHS.join(" ")}). Commit source only; the fleet's truth lives on disk, ` +
					"not in history.",
			};
		}

		if (this.#inHome(cwd) && isBulkStaging(subcommand, args)) {
			return {
				code: "bulk_stage_in_home",
				subject: segment.trim(),
				reason:
					`blocked: a bulk \`git ${subcommand}\` in the command post home would sweep in ` +
					`${NEVER_COMMIT_PATHS.join(" ")}. Stage the explicit source paths you mean instead of -A/-a/./--all.`,
			};
		}
		return undefined;
	}

	// -- path facts ---------------------------------------------------------

	#bodyReadReason(subject: string): string {
		return (
			`blocked: ${subject} is an artifact body, and the parent never reads one — findings in the parent's context ` +
			"are how a fleet controller starts doing the work itself. Use `cp_artifact get` with an out file (a worker " +
			"reads it), `cp_artifact path` for the location, or ls/stat/wc for metadata. The envelope summary and the " +
			"gate verdict are the sanctioned readable surfaces."
		);
	}

	#diffBodyReadReason(subject: string): string {
		return (
			`blocked: ${subject} is a diff-review run's scratch/run directory, and the parent never reads a diff body — ` +
			"it destroys context integrity the same way an artifact body would. The verdict is the interface: read the " +
			"attempt's review-<n>.json record for the outcome, or ls/stat/wc for metadata."
		);
	}

	#isArtifactPath(path: string, cwd: string): boolean {
		const raw = path.startsWith("@") ? path.slice(1) : path;
		if (raw.includes(LAYOUT.artifacts)) return true;
		const resolved = resolve(cwd, raw);
		return isInside(resolved, this.#artifacts.root()) || isInside(resolved, resolve(this.#canonicalHome, LAYOUT.artifacts));
	}

	/**
	 * Same shape as {@link ContextGuard#isArtifactPath}, but for a diff-review
	 * run's scratch/run directory (`state/runs/<job-id>/review-<attempt>/…`)
	 * rather than the artifact store — matched by the review-path shape itself,
	 * not `LAYOUT.artifacts`, since there is no separate store object for it.
	 */
	#isReviewPath(path: string, cwd: string): boolean {
		const raw = path.startsWith("@") ? path.slice(1) : path;
		if (isReviewPathString(raw)) return true;
		const resolved = resolve(cwd, raw);
		return isReviewPathString(resolved);
	}

	#segmentTouchesArtifacts(segment: string, argv: readonly string[], cwd: string): boolean {
		if (segment.includes(LAYOUT.artifacts)) return true;
		return argv.some((token) => !token.startsWith("-") && this.#isArtifactPath(token, cwd));
	}

	#artifactToken(segment: string, argv: readonly string[], cwd: string): string | undefined {
		for (const token of argv) {
			if (!token.startsWith("-") && this.#isArtifactPath(token, cwd)) return token;
		}
		return segment.includes(LAYOUT.artifacts) ? LAYOUT.artifacts : undefined;
	}

	#segmentTouchesReview(segment: string, argv: readonly string[], cwd: string): boolean {
		if (isReviewPathString(segment)) return true;
		return argv.some((token) => !token.startsWith("-") && this.#isReviewPath(token, cwd));
	}

	#reviewToken(segment: string, argv: readonly string[], cwd: string): string | undefined {
		for (const token of argv) {
			if (!token.startsWith("-") && this.#isReviewPath(token, cwd)) return token;
		}
		return undefined;
	}

	/**
	 * Which never-commit root a token falls under, if any. Two rules, both
	 * fail-closed: a leading path segment that names one of them (whatever the
	 * cwd — `cd home && git add .beads` is the case that motivates it), and a
	 * path that resolves inside this home's copy of one.
	 */
	#neverCommitPath(token: string, cwd: string): string | undefined {
		const raw = (token.startsWith("@") ? token.slice(1) : token).replace(/^\.\//, "");
		if (raw.length === 0) return undefined;
		const head = raw.split("/")[0] ?? "";
		for (const never of NEVER_COMMIT_PATHS) {
			const name = never.replace(/\/$/, "");
			if (head === name) return never;
		}
		const resolved = resolve(cwd, raw);
		for (const never of NEVER_COMMIT_PATHS) {
			const name = never.replace(/\/$/, "");
			if (isInside(resolved, resolve(this.#home, name)) || isInside(resolved, resolve(this.#canonicalHome, name))) {
				return never;
			}
		}
		return undefined;
	}

	#inHome(cwd: string): boolean {
		const resolved = resolve(cwd);
		return (
			isInside(resolved, this.#home) ||
			isInside(resolved, this.#canonicalHome) ||
			isInside(canonicalDir(resolved), this.#canonicalHome)
		);
	}
}

/** One operator/log line for a blocked call. */
export function formatGuardDecision(decision: GuardDecision): string {
	return `[${decision.code}] ${decision.reason}`;
}

// ---------------------------------------------------------------------------
// Shell shapes (deliberately small: we classify commands, we do not run them)
// ---------------------------------------------------------------------------

/** Split a command line into the pieces a shell would run separately. */
export function splitSegments(command: string): string[] {
	return command
		.split(/\|\||&&|;|\||\n|(?<!\\)&/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

/**
 * Split a command line into independent statements — like {@link splitSegments}
 * but *keeping* a pipeline's stages together, because data flows between them:
 * a path named in one stage and read in the next is still one real read.
 */
export function splitStatements(command: string): string[] {
	return command
		.split(/\|\||&&|;|\n|(?<!\\)&/)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/** Split one statement into its pipeline stages. */
export function splitStages(statement: string): string[] {
	return statement
		.split("|")
		.map((stage) => stage.trim())
		.filter((stage) => stage.length > 0);
}

/** Whitespace tokens with surrounding quotes stripped. Good enough to classify. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null = re.exec(segment);
	while (match !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
		match = re.exec(segment);
	}
	return tokens;
}

function stripEnvAssignments(tokens: readonly string[]): string[] {
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
	return tokens.slice(index);
}

function basename(token: string): string {
	const cleaned = token.replace(/\.exe$/i, "");
	const slash = cleaned.lastIndexOf("/");
	return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function hasSubstitution(segment: string): boolean {
	return segment.includes("$(") || segment.includes("`") || segment.includes("${");
}

/**
 * A redirect shape that can smuggle a body somewhere other than the reading
 * command's own (metadata-only) output: an output redirect/append (`>`,
 * `>>`), a process substitution (`<(...)`), or a heredoc/herestring (`<<`,
 * `<<<`). A plain input redirect (`< path`) is deliberately *not* one of
 * these — `wc -c < report.md` still only ever emits a byte count.
 */
function hasDangerousRedirect(segment: string): boolean {
	return />/.test(segment) || /<\(/.test(segment) || /<</.test(segment);
}

/** `git [-C dir] [-c k=v] <subcommand> [args…]`. */
export function parseGit(argv: readonly string[]): { subcommand?: string; args: string[] } {
	let index = 1;
	while (index < argv.length) {
		const token = argv[index] ?? "";
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const subcommand = argv[index];
	return { ...(subcommand ? { subcommand } : {}), args: argv.slice(index + 1) };
}

function shellPathUnresolved(path: string): boolean {
	return /^~|[$`*?{}]/.test(path);
}

function isDestructiveGit(subcommand: string, args: readonly string[]): boolean {
	return subcommand === "checkout" || subcommand === "switch" || subcommand === "reset" || subcommand === "clean" ||
		(subcommand === "push" && args.some((arg) => arg === "-f" || arg === "--force" || arg.startsWith("--force-with-lease") || arg.startsWith("+")));
}

function isBulkStaging(subcommand: string, args: readonly string[]): boolean {
	if (subcommand === "add" || subcommand === "stage") {
		return args.some((arg) => arg === "-A" || arg === "--all" || arg === "-u" || arg === "--update" || arg === ".");
	}
	if (subcommand === "commit") {
		return args.some((arg) => arg === "--all" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("a")));
	}
	return false;
}

/**
 * A worker's operator-question journal (T31). Matched by name rather than by
 * resolving the home, because the reason to refuse it is the same wherever it
 * is: the exchange is the operator's record and `/watch` renders it in code.
 */
function isQuestionJournal(path: string): boolean {
	return /(?:^|[\\/])questions\.jsonl$/.test(path.trim());
}

function questionJournalReason(subject: string): string {
	return (
		`blocked: ${subject} is a job's operator-question journal. The whole point of that channel is that the ` +
		"question and the answer never enter this session's context — reading the journal here would undo it. " +
		"Use `/watch <job-id>` to see the exchange rendered, or `/status`, which shows a job that " +
		"is waiting on you."
	);
}

function isReviewApproval(path: string): boolean {
	return /(?:^|[\\/])review-approval\.json$/.test(path.trim());
}

function reviewApprovalReason(path: string): string {
	return `${path} is the operator's console approval of a plan; the checkpoint decision is what reaches you (cp-answered). See /watch <job-id>.`;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
