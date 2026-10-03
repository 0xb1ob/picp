/**
 * CI-wait detection — the enforcement behind "report the pushed head sha and
 * stop" (cp-kzc).
 *
 * The defect this exists for is observed, not hypothetical: workers block their
 * own turn on `sleep 270; gh run list --branch <b> ...`, sleeping inside a tool
 * call while the parent — which re-verifies CI against the pushed head before
 * every merge anyway — waits for an envelope that a finished job could already
 * have filed. PR #39 fixed it as ship-brief *guidance*, and guidance lost to the
 * next brief that said "confirm CI green on the new head". Wording that already
 * failed once is not a control, so this is the control: a bash call whose shape
 * is "wait for CI" is refused at the worker's tool-call boundary, with the
 * sanctioned path named in the refusal.
 *
 * ## What is refused, precisely
 *
 * Three shapes, and nothing else:
 *
 *  - `sleep_then_poll` — a `sleep` in **command position** in the same call as a
 *    CI status query (`gh run list|view|watch`, `gh pr checks`, `gh api` on a
 *    check/runs endpoint). This is the observed shape verbatim.
 *  - `poll_loop` — a shell loop (`while` / `until` / `for … do`) containing a CI
 *    status query. Same defect, no `sleep` needed.
 *  - `blocking_watch` — `gh run watch` or `gh pr checks --watch`: a call that
 *    blocks until CI finishes, which is the thing itself and not a workaround.
 *
 * ## What is NOT refused (over-blocking is a worse bug than the bug)
 *
 *  - a long-running command with no CI query: `npm test`, a build, a big rebase;
 *  - a bare `sleep 5` (a settle wait, a retry backoff on something local);
 *  - a **single, non-blocking** CI status check: `gh run list --branch b --limit
 *    3 --json conclusion,status,headSha` returns immediately and costs nothing,
 *    so a worker that wants the sha's run state may still look once;
 *  - any of these words inside a quoted string (`grep "sleep 270; gh run list"`,
 *    `rg 'gh run watch' src/`): every match must be in **command position** —
 *    the start of the command, or right after `;`, `&&`, `||`, `|`, `(`, a
 *    newline, or a `do` / `then` / `while` / `until` keyword.
 *
 * Pure and dependency-free on purpose: it is the same function in the worker
 * extension, in the tests, and anywhere the docs are checked against code.
 */

/** Which of the three refused shapes a command matched. */
export const CI_WAIT_SHAPES = ["sleep_then_poll", "poll_loop", "blocking_watch"] as const;
export type CiWaitShape = (typeof CI_WAIT_SHAPES)[number];

export interface CiWaitFinding {
	shape: CiWaitShape;
	/** The fragment that matched, trimmed and bounded — quoted back to the worker. */
	matched: string;
	/** One line: what the shape does, so the refusal is not a bare "no". */
	what: string;
}

/**
 * Command position: the start of the command, or right after a separator. Every
 * pattern below is anchored on it, which is what keeps a *quoted mention* of a
 * poll (`grep "sleep 270; gh run list"`, `rg 'gh run watch' src/`) from being
 * mistaken for the poll itself. `do`, `then`, `while` and `until` count as
 * separators too: `until gh run list …; do sleep 20; done` runs the query as a
 * command exactly as `; gh run list` does.
 */
const CMD_POS = "(?:^|[;&|(\\n]|\\bdo\\b|\\bthen\\b|\\bwhile\\b|\\buntil\\b)[ \\t]*";

function atCommandPosition(pattern: string): RegExp {
	return new RegExp(`${CMD_POS}${pattern}`, "i");
}

/** A CI status query, in command position. */
const CI_QUERY_RES: readonly RegExp[] = [
	atCommandPosition("gh\\s+run\\s+(?:list|view|watch)\\b"),
	atCommandPosition("gh\\s+pr\\s+checks\\b"),
	atCommandPosition("gh\\s+api\\b[^;&|\\n]*(?:check-runs|check-suites|actions/runs|commits/[^\\s]*/(?:status|check-runs))"),
];

/** `sleep N`, in command position — never inside a quoted string. */
const SLEEP_RE = atCommandPosition("sleep\\s+[0-9]+(?:\\.[0-9]+)?\\b");

/** A shell loop header, in command position. */
const LOOP_RE = atCommandPosition("(?:while|until|for)\\b[^\\n]*?\\bdo\\b");

/** Commands that block until CI finishes, in command position. */
const BLOCKING_WATCH_RES: readonly RegExp[] = [
	atCommandPosition("gh\\s+run\\s+watch\\b"),
	atCommandPosition("gh\\s+pr\\s+checks\\b[^;&|\\n]*(?:--watch|\\s-w\\b)"),
];

function firstMatch(command: string, patterns: readonly RegExp[]): string | undefined {
	for (const pattern of patterns) {
		const found = pattern.exec(command);
		if (found) return found[0];
	}
	return undefined;
}

function bound(fragment: string, max = 120): string {
	const flat = fragment.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The one decision function. Returns a finding when the command is a wait for
 * CI, and `undefined` for everything else — including every legitimate
 * long-running command.
 */
export function detectCiWait(command: string): CiWaitFinding | undefined {
	if (typeof command !== "string" || command.trim().length === 0) return undefined;

	const watch = firstMatch(command, BLOCKING_WATCH_RES);
	if (watch) {
		return {
			shape: "blocking_watch",
			matched: bound(watch),
			what: "this call blocks until CI finishes",
		};
	}

	const query = firstMatch(command, CI_QUERY_RES);
	if (!query) return undefined;

	const loop = LOOP_RE.exec(command)?.[0];
	if (loop) {
		return {
			shape: "poll_loop",
			matched: bound(`${loop.trim()} … ${query.trim()}`),
			what: "this is a hand-rolled poll loop around a CI status query",
		};
	}

	const sleep = SLEEP_RE.exec(command)?.[0];
	if (sleep) {
		return {
			shape: "sleep_then_poll",
			matched: bound(`${sleep.trim()} … ${query.trim()}`),
			what: "this sleeps inside a tool call and then asks GitHub whether CI is done",
		};
	}

	return undefined;
}

/**
 * The refusal a worker sees. It names the shape, the reason it is refused, and
 * the sanctioned path — a refusal that does not say what to do instead is how
 * a worker ends up inventing a second workaround for the first one.
 */
export function ciWaitRefusal(finding: CiWaitFinding): string {
	return [
		`Refused: ${finding.what} (${finding.shape}: ${finding.matched}).`,
		"A worker never waits for CI. Your job ends at: rebase onto the base branch your brief names",
		"(`origin/<base>`), run the full suite locally,",
		"push, and report the pushed head sha (`git rev-parse HEAD`) in report_result's `head_sha`.",
		"The parent re-verifies CI against that sha before it merges anything, so waiting here duplicates a",
		"check the parent redoes and does not take your word for — it only burns your turn and the lease.",
		"A single, non-blocking `gh run list --branch <branch> --limit 3 --json conclusion,status,headSha` is",
		"still allowed if you want a snapshot; sleeping, looping or --watch is not.",
	].join("\n");
}

/**
 * `gh`, tolerating `-R/--repo/--hostname <v>` between `gh` and the subcommand
 * (`gh -R o/r run list`), so a flag cannot step around the status quota.
 */
const GH = "gh(?:\\s+(?:-R|--repo|--hostname)(?:\\s+|=)\\S+)*";

const CI_STATUS_RES: readonly RegExp[] = [
	atCommandPosition(`${GH}\\s+run\\s+(?:list|view)\\b`),
	atCommandPosition(`${GH}\\s+pr\\s+checks\\b`),
	CI_QUERY_RES[2] as RegExp,
];

/** A log fetch (`--log`, `--log-failed`, `gh api …/logs`): failure evidence, not a status query. */
const CI_LOG_RE = /\s--log\b|\/logs\b/;

/**
 * True when a command-position stage of `command` asks GitHub for CI *status*
 * (`gh run list|view`, `gh pr checks`, check-runs API). `gh run view --log[-failed]`
 * is not status and stays unmetered. The worker hook allows one per process.
 */
export function ciStatusQuery(command: string): boolean {
	if (typeof command !== "string") return false;
	return command
		.split(/[;&|\n]+/)
		.some((stage) => CI_STATUS_RES.some((re) => re.test(stage)) && !CI_LOG_RE.test(stage));
}

/** Refusal for the second CI status query in one worker process. */
export function ciStatusRepeatRefusal(): string {
	return [
		"Refused: this worker already took its one CI status snapshot; a second one tells you nothing new.",
		"Rebase, run the suite, push, and report the pushed head sha (`git rev-parse HEAD`) in report_result's",
		"`head_sha`; the parent re-verifies CI itself. Failure logs (`gh run view <id> --log-failed`) are still allowed.",
	].join("\n");
}

const HEREDOC_BODY_RE = /(?<!<)(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g;

/**
 * True when `apply_patch` runs as a command in `command` (command position, so
 * `grep apply_patch`, `echo apply_patch` and heredoc bodies such as commit
 * messages are prose, not a call). `apply_patch` is not a shell command here:
 * the run logs show it dying with "command not found". `git apply` is not
 * refused: the audit has no evidence for it, and `git apply --check` is legitimate.
 */
export function shellPatchCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	return atCommandPosition("apply_patch\\b").test(command.replace(HEREDOC_BODY_RE, "$1"));
}

/** Refusal for a shell `apply_patch`. */
export function shellPatchRefusal(): string {
	return "Refused: `apply_patch` is not a shell command in this environment. Edit files with the `replace` or `insert` tool (or `write` for a new file).";
}
