/**
 * Worker credential guard — the worker's refusals for credential leaks, all
 * at the worker-reporter `tool_call`/`tool_result` hooks:
 *  - a copy of the host `auth.json` (below);
 *  - a bulk `cp`/`rsync` of a command-post home (`detectHomeBulkCopy`, N1);
 *  - `gh auth status` / `gh auth token`, which print the stored token
 *    (`detectGhAuthStatus`, N2);
 *  - GitHub token shapes in bash results (`redactGithubTokens`, N2).
 *
 * A worker never copies the host's `auth.json` (nor
 * `mcp-auth.json`, the MCP OAuth tokens pi reads in place: cp-fl8b). A
 * temp agent dir takes `models.json` only (profiles and standing orders say
 * so); a copied `auth.json` leaves host credentials in a world-readable /tmp
 * dir. The "if authentication is truly needed" exception already lost once
 * (cp-bridge-auto-reattach-3wgt copied it to make a suite green), so this is a
 * hard refusal.
 *
 * Refused: `cp … <anything>/.pi/agent/(mcp-)auth.json` (`~`, `$HOME`, an absolute
 * path) in command position, and the loop form
 * `for f in auth.json …; do cp ~/.pi/agent/$f …`. Same command-position and
 * heredoc-blanking rule as src/worker-merge-guard.ts, so `grep "cp
 * ~/.pi/agent/auth.json"`, `echo '…'` and a report heredoc that quotes the
 * command are prose. A models-only copy or loop passes.
 */

import { GITHUB_TOKEN_RE } from "./secret-patterns.ts";

const CMD_POS = "(?:^|[;&|(\\n]|\\bdo\\b|\\bthen\\b|\\bwhile\\b|\\buntil\\b)[ \\t]*";
const AUTH = "\\.pi/agent/(?:mcp-)?auth\\.json\\b";
const DIRECT_RE = new RegExp(`${CMD_POS}(?:command\\s+)?cp\\b[^;&|\\n]*${AUTH}[^;&|\\n]*`, "i");
// `for f in auth.json …; do [stmts;] cp ~/.pi/agent/$f` — \1 is the loop variable.
const LOOP_RE = new RegExp(
	`${CMD_POS}for\\s+(\\w+)\\s+in\\s+[^;\\n]*\\bauth\\.json\\b[^;\\n]*[;\\n]\\s*do\\b(?:[^;\\n]*[;\\n])*?[ \\t]*(?:command\\s+)?cp\\b[^;&|\\n]*\\.pi/agent/\\$\\{?\\1\\b[^;&|\\n]*`,
	"i",
);
// Same heredoc-body blanking as src/ci-wait.ts: a report may quote the copy.
const HEREDOC_BODY_RE = /(?<!<)(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g;

export interface HostAuthCopyFinding {
	/** The copy fragment, trimmed and bounded — quoted back to the worker. */
	matched: string;
}

/** A finding when `command` copies the host `auth.json`, else `undefined`. */
export function detectHostAuthCopy(command: string): HostAuthCopyFinding | undefined {
	if (typeof command !== "string") return undefined;
	const body = command.replace(HEREDOC_BODY_RE, "$1");
	const found = (DIRECT_RE.exec(body) ?? LOOP_RE.exec(body))?.[0];
	if (!found) return undefined;
	const flat = found.replace(/\s+/g, " ").trim();
	return { matched: flat.length > 120 ? `${flat.slice(0, 119)}…` : flat };
}

/** The refusal a worker sees; names the sanctioned path and never tells it to copy the file. */
export function hostAuthCopyRefusal(finding: HostAuthCopyFinding): string {
	return [
		`Refused: a worker never copies the host's auth.json or mcp-auth.json (${finding.matched}).`,
		"Copy only `models.json` into a throwaway 0700 agent dir outside the worktree and remove it in a trap.",
		"If a test cannot run without host credentials, do not work around it: report_result `blocked` naming that test.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// N1: a worker never bulk-copies a command-post home (cp-xlax copied the live
// state/ and data/ into tmpfs /tmp and died mid-call). Bulk = the runtime root,
// state/, data/, state/sessions or all of state/runs — an `--exclude` or a glob
// does not make it smaller. One named state/runs/<id>/, single files and a copy
// whose `.pi-command-post` is only the destination pass. Matched by name with
// any prefix (like auth.json above), so a scratch home's state/ is refused too.
// ---------------------------------------------------------------------------

const COPY_RE = new RegExp(`${CMD_POS}(?:command\\s+|\\\\)?(cp|rsync)\\b([^;&|\\n]*)`, "gi");
const CP_VALUE_OPTS = new Set(["-t", "--target-directory", "-S", "--suffix"]);
const RSYNC_VALUE_OPTS = new Set([
	"--exclude",
	"--include",
	"--filter",
	"-f",
	"--exclude-from",
	"--include-from",
	"--files-from",
	"-e",
	"--rsh",
	"--rsync-path",
	"--link-dest",
	"--compare-dest",
	"--copy-dest",
	"--backup-dir",
	"--partial-dir",
	"--temp-dir",
	"-T",
	"--chmod",
	"--chown",
	"--log-file",
	"--out-format",
	"--max-size",
	"--min-size",
	"--bwlimit",
	"--timeout",
]);
const HOME_ROOT_RE = /(?:^|\/)\.pi-command-post(?=\/|$)/;
/** Deepest first; `[]` is the runtime root itself. */
const BULK_CONTAINERS: ReadonlyArray<ReadonlyArray<string>> = [["state", "sessions"], ["state", "runs"], ["state"], ["data"], []];
// A redirection word (`>`, `2>`, `&>`, `>/dev/null`) is not an operand; a bare operator also takes the next word.
const REDIRECT_RE = /^(?:\d*|&)[<>]/;
const BARE_REDIRECT_RE = /^(?:\d*|&)[<>]+&?$/;

/** Shell words of one segment: quotes stripped, adjacent pieces joined. Total: never throws. */
function shellWords(args: string): string[] {
	return (args.match(/(?:[^\s"'\\]+|"(?:[^"\\]|\\.)*"|'[^']*'|\\.)+/g) ?? []).map((word) =>
		word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g, (_, d?: string, s?: string, e?: string) => d ?? s ?? e ?? ""),
	);
}

/** One level of `{a,b}` brace expansion. */
function expandBraces(word: string): string[] {
	const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(word);
	return m ? (m[2] ?? "").split(",").map((item) => `${m[1]}${item}${m[3]}`) : [word];
}

/** The source operands of one `cp`/`rsync` invocation (options and the destination dropped). */
function copySources(tool: string, words: string[]): string[] {
	const valueOpts = tool === "cp" ? CP_VALUE_OPTS : RSYNC_VALUE_OPTS;
	const operands: string[] = [];
	let hasTarget = false;
	let endOfOptions = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (REDIRECT_RE.test(word)) {
			if (BARE_REDIRECT_RE.test(word)) i++;
			continue;
		}
		if (endOfOptions || !word.startsWith("-") || word === "-") {
			operands.push(word);
			continue;
		}
		if (tool === "cp") {
			if (word === "--target-directory" || word.startsWith("--target-directory=")) {
				hasTarget = true;
				if (!word.includes("=")) i++;
				continue;
			}
			const cluster = /^-[A-Za-z]*?t(.*)$/.exec(word);
			if (cluster) {
				hasTarget = true;
				if (cluster[1] === "") i++;
				continue;
			}
		}
		if (valueOpts.has(word)) i++;
	}
	return hasTarget ? operands : operands.slice(0, -1);
}

/** True when `word` names a command-post home in bulk (see the N1 rule above). */
function isBulkHomeSource(word: string): boolean {
	const root = HOME_ROOT_RE.exec(word);
	if (!root) return false;
	const segs = word
		.slice(root.index + root[0].length)
		.split("/")
		.filter((seg) => seg !== "" && seg !== ".");
	const container = BULK_CONTAINERS.find((c) => c.every((seg, i) => segs[i] === seg)) ?? [];
	const next = segs[container.length];
	if (next === undefined) return true;
	if (/[*?[]/.test(next)) return true;
	return next.startsWith("$") && (container.length === 0 || (container.length === 1 && container[0] === "state"));
}

export interface HomeBulkCopyFinding {
	/** The copy fragment, trimmed and bounded — quoted back to the worker. */
	matched: string;
	/** The bulk source operand that was refused. */
	source: string;
}

/** A finding when `command` bulk-copies a command-post home, else `undefined`. */
export function detectHomeBulkCopy(command: string): HomeBulkCopyFinding | undefined {
	if (typeof command !== "string") return undefined;
	const body = command.replace(HEREDOC_BODY_RE, "$1");
	COPY_RE.lastIndex = 0;
	for (let m = COPY_RE.exec(body); m; m = COPY_RE.exec(body)) {
		const tool = (m[1] ?? "").toLowerCase();
		const words = shellWords(m[2] ?? "").flatMap(expandBraces);
		const source = copySources(tool, words).find(isBulkHomeSource);
		if (source === undefined) continue;
		COPY_RE.lastIndex = 0;
		const flat = m[0].replace(/\s+/g, " ").trim();
		return { matched: flat.length > 120 ? `${flat.slice(0, 119)}…` : flat, source };
	}
	return undefined;
}

/** The refusal a worker sees; names the sanctioned paths. */
export function homeBulkCopyRefusal(finding: HomeBulkCopyFinding): string {
	return [
		`Refused: a worker never bulk-copies a command-post home (\`${finding.source}\` in: ${finding.matched}).`,
		"state/ and data/ hold session transcripts and dashboard and push keys; cp-xlax's copy into tmpfs /tmp killed the worker.",
		"Seed a scratch home with only the records your test needs (a node seed script), copy one run with `cp -a <home>/state/runs/<id>/ <dest>`, and copy only `models.json` into a throwaway agent dir.",
		"If the task cannot be done without the live home, report_result `blocked` naming why.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// N2: `gh auth status` (any flag) and `gh auth token` print the stored token —
// gh before 2.97.0 leaves part of a fine-grained PAT unmasked (cp-cuq5).
// ---------------------------------------------------------------------------

const GH_AUTH_RE = new RegExp(
	`${CMD_POS}(?:command\\s+|env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*gh(?:\\s+(?:-R|--repo|--hostname)(?:\\s+|=)\\S+)*\\s+auth\\s+(status|token)\\b[^;&|\\n]*`,
	"i",
);

export interface GhAuthStatusFinding {
	/** The command fragment, trimmed and bounded — quoted back to the worker. */
	matched: string;
	subcommand: "status" | "token";
}

/** A finding when `command` runs `gh auth status` or `gh auth token`, else `undefined`. */
export function detectGhAuthStatus(command: string): GhAuthStatusFinding | undefined {
	if (typeof command !== "string") return undefined;
	const m = GH_AUTH_RE.exec(command.replace(HEREDOC_BODY_RE, "$1"));
	if (!m) return undefined;
	const flat = m[0].replace(/\s+/g, " ").trim();
	return {
		matched: flat.length > 120 ? `${flat.slice(0, 119)}…` : flat,
		subcommand: (m[1] ?? "").toLowerCase() === "token" ? "token" : "status",
	};
}

/** The refusal a worker sees; names the login check that prints no token. */
export function ghAuthStatusRefusal(finding: GhAuthStatusFinding): string {
	return [
		`Refused: \`gh auth ${finding.subcommand}\` prints the stored GitHub token into your transcript (${finding.matched}); gh before 2.97.0 leaves part of a fine-grained token unmasked even without --show-token.`,
		"To check that gh is logged in, run `gh api user --jq .login` (it prints only the login). Never print a token.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// N2: GitHub token shapes in bash output reach the model and the pi session
// transcript only as `[REDACTED]`. The tail swallows gh's `*` mask and the
// `.`/`-` segments of a `ghs_<appid>_<jwt>`.
// ---------------------------------------------------------------------------

export const TOKEN_REDACTED = "[REDACTED]";
const GITHUB_TOKEN_ALL = new RegExp(`${GITHUB_TOKEN_RE.source}[A-Za-z0-9_.\\-*]*`, "g");

/** `text` with every GitHub token shape replaced by `[REDACTED]`; a pure regex, never throws. */
export function redactGithubTokens(text: string): string {
	return typeof text === "string" ? text.replace(GITHUB_TOKEN_ALL, TOKEN_REDACTED) : text;
}
