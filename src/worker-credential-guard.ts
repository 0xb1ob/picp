/**
 * Worker credential guard — a worker never copies the host's `auth.json`. A
 * temp agent dir takes `models.json` only (profiles and standing orders say
 * so); a copied `auth.json` leaves host credentials in a world-readable /tmp
 * dir. The "if authentication is truly needed" exception already lost once
 * (cp-bridge-auto-reattach-3wgt copied it to make a suite green), so this is a
 * hard refusal.
 *
 * Refused: `cp … <anything>/.pi/agent/auth.json` (`~`, `$HOME`, an absolute
 * path) in command position, and the loop form
 * `for f in auth.json …; do cp ~/.pi/agent/$f …`. Same command-position and
 * heredoc-blanking rule as src/worker-merge-guard.ts, so `grep "cp
 * ~/.pi/agent/auth.json"`, `echo '…'` and a report heredoc that quotes the
 * command are prose. A models-only copy or loop passes.
 */

const CMD_POS = "(?:^|[;&|(\\n]|\\bdo\\b|\\bthen\\b|\\bwhile\\b|\\buntil\\b)[ \\t]*";
const AUTH = "\\.pi/agent/auth\\.json\\b";
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
		`Refused: a worker never copies the host's auth.json (${finding.matched}).`,
		"Copy only `models.json` into a throwaway 0700 agent dir outside the worktree and remove it in a trap.",
		"If a test cannot run without host credentials, do not work around it: report_result `blocked` naming that test.",
	].join("\n");
}
