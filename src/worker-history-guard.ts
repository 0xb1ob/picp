/**
 * Worker history guard (cp-c1ur N6): a worker's branch only moves forward. Refused: `git rebase` but `--abort`,
 * a force push (`-f`, `--force`, `--force-with-lease`, `+ref`), and `git reset --hard` onto a remote-tracking ref,
 * which adopts origin's history over unpushed commits. The sanctioned path: merge origin, then a plain push.
 */
import { basename, isForcePush, parseGit, splitStages, splitStatements, stripEnvAssignments, tokenize } from "./guards.ts";

// Same heredoc-body blanking as src/ci-wait.ts: a commit message may mention a rebase.
const HEREDOC_BODY_RE = /(?<!<)(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g;
const REMOTE_REF_RE = /^(?:origin|origin\/.+|refs\/remotes\/.+|FETCH_HEAD)$|@\{(?:u|upstream|push)\}/;

export interface WorkerHistoryFinding {
	action: "rebase" | "force-push" | "reset";
	/** The git stage, bounded — quoted back to the worker. */
	matched: string;
}

function actionOf(subcommand: string | undefined, args: readonly string[]): WorkerHistoryFinding["action"] | undefined {
	if (subcommand === "rebase") return args.includes("--abort") ? undefined : "rebase";
	if (subcommand === "push") return isForcePush(args) ? "force-push" : undefined;
	if (subcommand === "reset" && args.includes("--hard") && args.some((arg) => REMOTE_REF_RE.test(arg))) return "reset";
	return undefined;
}

/** A finding when `command` runs a history-rewriting git command, else `undefined`. */
export function detectWorkerHistoryRewrite(command: string): WorkerHistoryFinding | undefined {
	if (typeof command !== "string") return undefined;
	for (const stage of splitStatements(command.replace(HEREDOC_BODY_RE, "$1")).flatMap(splitStages)) {
		const argv = stripEnvAssignments(tokenize(stage));
		if (basename(argv[0] ?? "") !== "git") continue;
		const { subcommand, args } = parseGit(argv);
		const action = actionOf(subcommand, args);
		if (action) return { action, matched: stage.length > 120 ? `${stage.slice(0, 119)}…` : stage };
	}
	return undefined;
}

/** The refusal a worker sees; names the merge alternative. */
export function workerHistoryRefusal(finding: WorkerHistoryFinding): string {
	const why = {
		rebase: "a rebase rewrites commits that may already be pushed and then needs a force push",
		"force-push": "a force push overwrites the remote branch, including anything pushed there since you fetched",
		reset: "a hard reset onto a remote ref throws away your unpushed commits",
	}[finding.action];
	return [
		`Refused: a worker never rewrites its branch's history (${finding.matched}) — ${why}.`,
		"Merge instead: `git fetch origin`, then `git merge origin/<your branch>` if origin moved and",
		"`git merge origin/<base>` to bring the base in; resolve so both sides survive, commit, and a plain `git push`.",
		"`git rebase --abort` stays allowed to leave a rebase already in progress.",
	].join("\n");
}
