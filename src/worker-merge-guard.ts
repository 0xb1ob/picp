/**
 * Worker merge guard — a worker never merges. `cp_integrate` is the one merge
 * path: it reads CI for the pushed head and the repo's own merge permission,
 * and never passes `--admin`. A worker's `gh pr merge` (and above all
 * `--admin`, which steps around branch protection) skips both reads.
 *
 * Refused: `gh pr merge` and `gh pr ready` in command position (start of the
 * command, or after `;`, `&&`, `||`, `|`, `(`, a newline, `do`, `then`, `while`,
 * `until`), tolerating `-R/--repo/--hostname <v>` after `gh`. Same
 * command-position rule as src/ci-wait.ts, so `grep "gh pr merge"`,
 * `echo 'gh pr merge'` and a heredoc commit message are prose, not a merge.
 * Ready is refused too: a worker's PR stays a draft until `cp_integrate`
 * readies a reviewed head. `gh pr create|view` and `gh run list` are untouched.
 */

const CMD_POS = "(?:^|[;&|(\\n]|\\bdo\\b|\\bthen\\b|\\bwhile\\b|\\buntil\\b)[ \\t]*";
const GH = "gh(?:\\s+(?:-R|--repo|--hostname)(?:\\s+|=)\\S+)*";
const MERGE_RE = new RegExp(`${CMD_POS}${GH}\\s+pr\\s+(merge|ready)\\b[^;&|\\n]*`, "i");
// Same heredoc-body blanking as src/ci-wait.ts: a commit message may mention a merge.
const HEREDOC_BODY_RE = /(?<!<)(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g;

export interface WorkerMergeFinding {
	/** The merge fragment, trimmed and bounded — quoted back to the worker. */
	matched: string;
	admin: boolean;
	action: "merge" | "ready";
}

/** A finding when `command` runs `gh pr merge` or `gh pr ready` as a command, else `undefined`. */
export function detectWorkerMerge(command: string): WorkerMergeFinding | undefined {
	if (typeof command !== "string") return undefined;
	const hit = MERGE_RE.exec(command.replace(HEREDOC_BODY_RE, "$1"));
	if (!hit) return undefined;
	const [found, action] = hit;
	const flat = found.replace(/\s+/g, " ").trim();
	return {
		matched: flat.length > 120 ? `${flat.slice(0, 119)}…` : flat,
		admin: /\s--admin\b/.test(found),
		action: action?.toLowerCase() === "ready" ? "ready" : "merge",
	};
}

/** The refusal a worker sees; names `cp_integrate` as the sanctioned path. */
export function workerMergeRefusal(finding: WorkerMergeFinding): string {
	if (finding.action === "ready") {
		return [
			`Refused: a worker never marks its PR ready (${finding.matched}).`,
			"The PR stays a draft as a review hold: only the parent's `cp_integrate` marks a reviewed head ready.",
			"Push, leave the PR in draft, and report the pushed head sha in report_result.",
		].join("\n");
	}
	return [
		`Refused: a worker never merges (${finding.admin ? "--admin " : ""}${finding.matched}).`,
		"Merging is the parent's `cp_integrate`: it reads CI for your pushed head and the repository's own merge",
		"permission, and never passes `--admin`. Push, open the draft PR, and report the pushed head sha in report_result.",
	].join("\n");
}
