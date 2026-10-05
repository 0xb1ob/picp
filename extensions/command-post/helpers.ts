/**
 * The command-post extension's pure helpers: package identity, the session
 * runtime, argument parsers, output routing and the tested wiring units.
 * A leaf module: it imports nothing from ./index.ts, so every sibling module
 * can use it without a cycle. index.ts re-exports all of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ResolvedAwaitingItem } from "../../src/awaiting.ts";
import type { CommandPost } from "../../src/command-post.ts";
import { configureLayout, type DiffVerdict, DiffVerdictSchema, type Escalation, type Runtime, validate } from "../../src/contracts.ts";
import { type DiffReviewResult, formatDiffReview } from "../../src/diff-review.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { LOADED_COMMIT } from "../../src/viewer/loaded-commit.ts";
import { readVersion } from "../../src/viewer/version-view.ts";
import { ModeError, resolveRuntime } from "../../src/mode.ts";
import { escalationProjects, type MandateProjects, type ProjectOf, withProjectTag } from "../../src/project-report.ts";
import { type StatusQuery } from "../../src/status.ts";
import { userContextDigest } from "../../src/user-context.ts";
import { boundedSeen, WAKEUP_SOURCE_FAILURE_MEMORY, type WakeupFactSources } from "../../src/wakeups.ts";
import { PARENT_TAIL_DEFAULT, type WatchMode } from "../../src/watch.ts";

export interface PackageIdentity {
	name: string;
	version: string;
	root: string;
}

/**
 * Read the package identity from package.json at `root`.
 * Throws when the manifest is missing or malformed — a command post that
 * cannot identify itself is not a command post (fail closed).
 */
export function readPackageIdentity(root: string = PACKAGE_ROOT): PackageIdentity {
	const manifestPath = join(root, "package.json");
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (error) {
		throw new Error(`pi-command-post: cannot read ${manifestPath}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`pi-command-post: invalid JSON in ${manifestPath}: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`pi-command-post: ${manifestPath} is not an object`);
	}
	const { name, version } = parsed as { name?: unknown; version?: unknown };
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`pi-command-post: missing "name" in ${manifestPath}`);
	}
	if (typeof version !== "string" || version.length === 0) {
		throw new Error(`pi-command-post: missing "version" in ${manifestPath}`);
	}
	return { name, version, root };
}

let runtimeCache: Runtime | undefined;
let runtimeFailure: Error | undefined;

/**
 * The session's runtime, resolved once: mode and home. Configures the layout
 * as a side effect, so every path read after this call is the right layout's.
 * Throws `ModeError` for a refusal (single mode, a plain git repository, a
 * former single-project home) and an invalid CP_MODE; `session_start` turns
 * that into a notify and ends startup.
 *
 * **The failure is cached too.** A refused mode is not a transient condition —
 * re-resolving it on every later call would re-run git and re-throw the same
 * error from whatever hook happened to ask next, and a refusal is exactly the
 * case where the rest of the session must degrade quietly rather than throw
 * once per prompt.
 */
export function currentRuntime(): Runtime {
	if (runtimeFailure) throw runtimeFailure;
	if (!runtimeCache) {
		try {
			const resolved = resolveRuntime({ cwd: process.cwd(), env: process.env, packageRoot: PACKAGE_ROOT });
			configureLayout(resolved.mode, resolved.home);
			runtimeCache = resolved;
		} catch (error) {
			runtimeFailure = error as Error;
			throw runtimeFailure;
		}
	}
	return runtimeCache;
}

/**
 * The runtime, or the refusal that ended startup — never a throw.
 *
 * `session_start` reports a refused mode once and stops, but the session keeps
 * running: pi still renders commands and the model can still call tools. Every
 * surface that runs *after* that point therefore asks through here, so a
 * refusal is reported where the operator is looking instead of raised out of a
 * hook or a command handler that has no way to explain it.
 */
export function runtimeOrRefusal(): { runtime: Runtime } | { refusal: string } {
	try {
		return { runtime: currentRuntime() };
	} catch (error) {
		return { refusal: error instanceof ModeError ? error.message : (error as Error).message };
	}
}

/** Single-line, machine-greppable identity banner. */
export function formatVersionLine(identity: PackageIdentity): string {
	return `${identity.name} ${identity.version} (root: ${identity.root})`;
}

/**
 * `/cp-version`'s third line (cp-kz20): the commit this parent loaded against the checkout's HEAD now, and upstream —
 * through the version badge's own reader (bounded, cached git; never a fetch).
 */
export async function formatCommitLine(home: string | undefined): Promise<string> {
	const [own, view] = await Promise.all([LOADED_COMMIT, readVersion({ home: home ?? PACKAGE_ROOT })]);
	const deployed = view.deployed?.sha;
	const state = !own || !deployed ? "unknown" : own.sha === deployed ? "current" : "stale — rotate at a quiet point (cp_parent rotate)";
	const u = view.upstream;
	const upstream = u.state === "behind" || u.state === "diverged" ? `${u.behind} behind` : u.state === "ahead" ? `${u.ahead} ahead` : u.state;
	return `commit ${own?.sha.slice(0, 7) ?? "unknown"} · deployed ${deployed?.slice(0, 7) ?? "unknown"} (${state}) · upstream ${upstream}${u.state !== "unknown" && !u.checked_at ? " (unchecked)" : ""}`;
}

/** What `session_start` hands `USER.md` to. `pi.sendMessage`'s shape, narrowed. */
export type UserContextSender = (
	message: { customType: string; content: string; display: boolean },
	options: { triggerTurn: false },
) => void;

/**
 * Load optional machine-local operator context (`USER.md`) into this session.
 *
 * Extracted from `session_start` so the call site is a tested function rather
 * than a promise in a comment. Two behaviours, and both are the contract:
 * **absent → nothing is sent at all** (an absent file is the normal case and
 * must stay indistinguishable from before the feature existed), and **present
 * → exactly one `cp-user-context` message**, `display: false` and
 * `triggerTurn: false` (in context for a wake-driven first turn too, unlike
 * `nextTurn`, which only rides a user prompt) — context,
 * never an event. Returns whether it sent.
 */
export function deliverUserContext(send: UserContextSender, root: string = PACKAGE_ROOT): boolean {
	const content = userContextDigest(root);
	if (!content) return false;
	send({ customType: "cp-user-context", content, display: false }, { triggerTurn: false });
	return true;
}

/** Widget key; one widget per package, replaced in place on every refresh. */
export const FLEET_WIDGET_KEY = "command-post";

/**
 * How often the fleet widget re-reads the run projections. Ages and current
 * tools change without any event of ours firing, so a timer is the honest way
 * to keep the widget true; it reads files only (never br, never a process) and
 * is unref'd, so it can neither cost tokens nor hold the session open.
 */
export const WIDGET_REFRESH_MS = 5000;

export interface StatusArgs {
	json: boolean;
	query: StatusQuery;
}

/**
 * `/status [--json] [--all] [--project NAME] [--no-titles]`.
 *
 * Ported behaviour: an unknown argument is an error, never a silent ignore
 * (`cmdp status` did the same). Parsing is pure so it is unit-testable.
 */
export function parseStatusArgs(args: string): StatusArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const parsed: StatusArgs = { json: false, query: {} };
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--json") parsed.json = true;
		else if (token === "--all") parsed.query.include = "all";
		else if (token === "--no-titles") parsed.query.titles = false;
		else if (token === "--project") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) throw new Error("/status --project needs a project name");
			parsed.query.project = value;
			index += 1;
		} else {
			throw new Error(
				`/status: unknown argument ${JSON.stringify(token)} — usage: /status [--json] [--all] [--project NAME] [--no-titles]`,
			);
		}
	}
	return parsed;
}

export interface WatchArgs {
	jobId: string;
	mode: WatchMode;
	last: number;
	exportRun: boolean;
}

/**
 * `/memory`'s argument completions. Pure so cp-kzu's UX fix is unit-testable:
 * completing to bare "capture" is a trap (the dropdown then submits
 * `/memory capture` with an empty lesson, which errors) — "capture " with a
 * trailing space leaves the cursor waiting for the lesson instead.
 *
 * The operator's surface is deliberately read-plus-capture: `curate` and
 * `audit` show what the parent's own pass is about to do and what it has
 * already done, but promotion and retirement are the parent's job now
 * (`cp_memory`), not a slash command a human has to remember to run.
 */
export function memoryArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	const words = ["status", "capture ", "curate", "audit"];
	const items = words.filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word.trim() }));
	return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------------
// Long output (cp-8v1)
// ---------------------------------------------------------------------------

/** Above this many lines, a payload is a document, not a notification. */
export const LONG_OUTPUT_LINES = 6;

export type OutputChannel = "entry" | "notify" | "stderr";

export interface CollapsedOutput {
	shown: string[];
	/** Lines hidden by the collapse, wherever they sit. 0 means nothing hid. */
	hidden: number;
	/** Where the hidden lines sit relative to `shown`: before it, or after. */
	hiddenPosition: "before" | "after";
}

/**
 * Collapse a rendered payload's lines to `LONG_OUTPUT_LINES`, for the entry's
 * collapsed state (cp-iuu).
 *
 * Most sources (`/status`, `/doctor`) put their summary first (`FLEET …`,
 * `DOCTOR …`), so collapsing to the head is correct for them: the important
 * line survives.
 *
 * `/watch` is different — it is a bounded *tail* of a live run log
 * (`state/runs/<job-id>/events.jsonl`), and the whole point of a tail is that
 * the newest activity survives truncation, not the oldest. `formatRunView`
 * already tail-slices the event log itself; the bug this fixes was a second,
 * head-slicing truncation right here, which threw that away again by keeping
 * the first `LONG_OUTPUT_LINES` lines of the *already-correct* tail — so a run
 * at turn 71 showed turns 57–58 and called everything newer "more", not "less
 * recent". The header line (`run cp-…, turns …, last activity …`) is pinned
 * so the operator always knows which job and phase this is, and the budget
 * left over goes to the *end* of the body, in original (chronological) order.
 */
export function collapseOutputLines(lines: readonly string[], source: string, limit = LONG_OUTPUT_LINES): CollapsedOutput {
	if (source !== "watch" || lines.length <= limit) {
		const shown = lines.slice(0, limit);
		return { shown, hidden: lines.length - shown.length, hiddenPosition: "after" };
	}
	// Pin the header line, and the blank line after it when present, so the
	// collapsed view never loses "what job, what phase" to make room for a tail
	// of events.
	const pin = lines.length > 1 && lines[1] === "" ? 2 : lines.length > 0 ? 1 : 0;
	const head = lines.slice(0, pin);
	const body = lines.slice(pin);
	const budget = Math.max(0, limit - pin);
	if (body.length <= budget) return { shown: [...head, ...body], hidden: 0, hiddenPosition: "after" };
	const tail = body.slice(body.length - budget);
	return { shown: [...head, ...tail], hidden: body.length - tail.length, hiddenPosition: "before" };
}

/**
 * Where a command's human-readable output should go.
 *
 * `ctx.ui.notify` is a short fire-and-forget notice; `/status` and `/doctor`
 * hand it 20-40 line documents, which in a TUI is not a scrollable surface. A
 * durable **entry** is (`pi.appendEntry` + `pi.registerEntryRenderer`), and
 * entries explicitly do **not** participate in LLM context (docs/extensions.md),
 * so this changes where the operator reads it without changing what the model
 * can see: nothing, either way.
 *
 * Two deliberate exclusions:
 *  - **`--json` always notifies.** Headless callers and our own RPC tests read
 *    `extension_ui_request`; an entry would be invisible to them.
 *  - **Only `ctx.mode === "tui"` gets entries.** In RPC mode `hasUI` is true but
 *    the client is a program, and entries are session data rather than protocol
 *    messages (docs/rpc.md lists no entry event) — so RPC keeps notify.
 */
export function chooseOutputChannel(options: {
	mode: string;
	hasUI: boolean;
	text: string;
	json?: boolean;
}): OutputChannel {
	if (!options.hasUI) return "stderr";
	if (options.json) return "notify";
	if (options.mode !== "tui") return "notify";
	return options.text.split("\n").length > LONG_OUTPUT_LINES ? "entry" : "notify";
}

/** Payload of a `cp-output` entry: the rendered text, and what produced it. */
export interface OutputEntry {
	source: string;
	text: string;
	level: "info" | "error";
}

/**
 * `/watch <job-id> [--detailed] [--last N] [--export]`.
 *
 * There is no `--follow` here, on purpose: the parent wakes on envelopes and
 * never polls (the ported "inspect once, do not loop" rule), so the parent's
 * view is a bounded one-shot tail. A live tail belongs in the operator's own
 * terminal (`tail -f` on the run log); T30 deleted the CLI that used to own it.
 */
export function parseWatchArgs(args: string): WatchArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const parsed: WatchArgs = { jobId: "", mode: "compact", last: PARENT_TAIL_DEFAULT, exportRun: false };
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--detailed") parsed.mode = "detailed";
		else if (token === "--export") parsed.exportRun = true;
		else if (token === "--last") {
			const value = Number(tokens[index + 1]);
			if (!Number.isInteger(value) || value < 0) throw new Error("/watch --last needs a non-negative integer");
			parsed.last = value;
			index += 1;
		} else if (token === "--follow" || token === "-f") {
			throw new Error(
				"/watch does not follow: this session wakes on envelopes, it never polls. Run `tail -f state/runs/<job-id>/events.jsonl` in a terminal.",
			);
		} else if (token.startsWith("-")) {
			throw new Error(`/watch: unknown argument ${JSON.stringify(token)} — usage: /watch <job-id> [--detailed] [--last N] [--export]`);
		} else if (parsed.jobId === "") {
			parsed.jobId = token;
		} else {
			throw new Error(`/watch: one job id at a time (got ${JSON.stringify(token)} as well)`);
		}
	}
	if (parsed.jobId === "") throw new Error("usage: /watch <job-id> [--detailed] [--last N] [--export]");
	return parsed;
}

export interface PlanArgs {
	jobId?: string;
	gate?: true | number;
}

/**
 * `/cp-plan [<job-id>] [--gate [n]]`. With no job id, the handler lists what is
 * viewable (a `select` in TUI, a text listing otherwise) — this parser only
 * owns the flags, exactly like `parseWatchArgs`.
 */
export function parsePlanArgs(args: string): PlanArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const parsed: PlanArgs = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--gate") {
			const next = tokens[index + 1];
			if (next !== undefined && /^\d+$/.test(next)) {
				parsed.gate = Number(next);
				index += 1;
			} else {
				parsed.gate = true;
			}
		} else if (token.startsWith("-")) {
			throw new Error(`/cp-plan: unknown argument ${JSON.stringify(token)} — usage: /cp-plan [<job-id>] [--gate [n]]`);
		} else if (parsed.jobId === undefined) {
			parsed.jobId = token;
		} else {
			throw new Error(`/cp-plan: one job id at a time (got ${JSON.stringify(token)} as well)`);
		}
	}
	return parsed;
}

export interface AskArgs {
	project: string;
	question: string;
	model?: string;
}

/**
 * `/cp-ask <project> <question…> [--model <ref>]` (cp-u3o4).
 *
 * The deterministic door to the Q&A path: the operator types it, so no model
 * turn is spent deciding that a question is a question. Everything after the
 * project name is the question, verbatim — a question is prose and must not be
 * re-tokenized, so only `--model` is recognised as a flag.
 */
export function parseAskArgs(args: string): AskArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const usage = "usage: /cp-ask <project> <question…> [--model <ref>]";
	let project: string | undefined;
	let model: string | undefined;
	const words: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--model") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`/cp-ask --model needs a model ref — ${usage}`);
			model = value;
			index += 1;
			continue;
		}
		if (project === undefined) {
			if (token.startsWith("-")) throw new Error(`/cp-ask: unknown argument ${JSON.stringify(token)} — ${usage}`);
			project = token;
			continue;
		}
		words.push(token);
	}
	if (project === undefined) throw new Error(usage);
	const question = words.join(" ").trim();
	if (question.length === 0) throw new Error(`/cp-ask needs a question about ${project} — ${usage}`);
	return { project, question, ...(model ? { model } : {}) };
}

/**
 * What `cp_review` hands back, in one place so the rule is enforced once and
 * testable without a pi process.
 *
 * Two invariants live here, and they are the whole point of the function:
 *
 *  1. **The verdict round-trips.** `details.verdict` is re-validated against
 *     `DiffVerdictSchema` before it leaves the tool. The orchestrator already
 *     validates what it writes to `review-<n>.json`; this re-check is what
 *     makes the *tool surface* — the thing the parent actually reads — hold
 *     the same contract, so a future change to the result shape cannot quietly
 *     ship a payload no schema describes.
 *  2. **No diff text, and no path to it.** `formatDiffReview` renders verdict,
 *     cause, flags, capped reasons and revisions — never a hunk. `details`
 *     carries the same capped verdict plus counts, and deliberately drops two
 *     fields of `DiffReviewResult`:
 *       - `review` (the reviewer's *uncapped* observation): `capPayload` bounds
 *         the verdict's reasons, so the verdict is the safe surface and the raw
 *         observation is not re-exported around that cap;
 *       - `diff.path` (the materialized diff file, under `review-<n>/`): Stage
 *         E's `diff_body_read` guard refuses a parent read of that directory,
 *         and a tool that helpfully hands over the path is the same hole with
 *         better manners.
 */
export function diffReviewToolPayload(result: DiffReviewResult): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	const validated = validate<DiffVerdict>(DiffVerdictSchema, result.verdict);
	if (!validated.ok) {
		throw new Error(
			`cp_review: the diff verdict for ${result.verdict?.job_id ?? "this job"} does not satisfy DiffVerdictSchema:\n  ` +
				validated.errors.join("\n  "),
		);
	}
	const verdict = validated.value;
	const details: Record<string, unknown> = {
		verdict,
		next: result.next,
		/** `state/runs/<job-id>/review-<n>.json` — the decision, never the diff. */
		review_file: result.path,
		...(result.model ? { model: result.model } : {}),
		...(result.diff
			? {
					subject: {
						base: result.diff.base,
						branch: result.diff.branch,
						head_sha: result.diff.head_sha,
						files: result.diff.files,
						truncated: result.diff.truncated,
						omitted: result.diff.omitted,
					},
				}
			: {}),
		...(result.revise_receipt ? { revise_receipt: result.revise_receipt } : {}),
		...(result.revise_error ? { revise_error: result.revise_error } : {}),
	};
	return { content: [{ type: "text", text: formatDiffReview(result) }], details };
}

/**
 * The slice of the command post the head sources read (pi-command-post-b04).
 * Structural on purpose: the test that pins this wiring supplies its own.
 */
export interface HeadSourcePost {
	ciHead(jobId: string): string | undefined;
	ciHeadObservedAt(jobId: string): string | undefined;
	reportedHeadSha(jobId: string): string | undefined;
	reportedHeadAt(jobId: string): string | undefined;
}

/**
 * The production wiring for the two head readings `headMoved` compares, as one
 * importable unit (pi-command-post-b04, finding 2).
 *
 * Deliberately **catch-free**: a failing lookup throws into `wakeupFacts`,
 * which keeps "it threw" distinct from "it had nothing to say", fails safe (a
 * degraded reading supersedes nothing) and reports it through
 * `onSourceFailure`. Swallowing it here is what made a wiring failure
 * indistinguishable from an ordinary absent fact.
 */
export function wakeupHeadSources(
	post: HeadSourcePost,
): Pick<WakeupFactSources, "ciHead" | "ciHeadObservedAt" | "fleetHead" | "fleetHeadAt"> {
	return {
		ciHead: (jobId) => post.ciHead(jobId),
		ciHeadObservedAt: (jobId) => post.ciHeadObservedAt(jobId),
		fleetHead: (jobId) => post.reportedHeadSha(jobId),
		fleetHeadAt: (jobId) => post.reportedHeadAt(jobId),
	};
}

/** Where a degraded head source is written down. The extension supplies the run log. */
export type SourceFailureJournal = (source: "fleetHead" | "ciHead", jobId: string, reason: string) => void;

/**
 * The production `onSourceFailure` (pi-command-post-8ok), as one importable
 * unit for the same reason `wakeupHeadSources` is one.
 *
 * A degraded source is journaled **once per (source, job) per session** so a
 * broken wiring is news rather than a line on every provider request — and that
 * dedupe memory is keyed by job id, so the bound on the journal used to leave
 * the memory itself unbounded in a long-lived session. `boundedSeen` caps it:
 * cardinality never exceeds `limit`, and a key that recurs after the cap is
 * reached is journaled exactly once more.
 *
 * The reason is truncated here rather than at the sink, because "a reason,
 * never a stack" is a property of the fact, not of where it is written.
 */
export function sourceFailureRecorder(
	journal: SourceFailureJournal,
	limit: number = WAKEUP_SOURCE_FAILURE_MEMORY,
): (source: "fleetHead" | "ciHead", jobId: string, error: Error) => void {
	const unseen = boundedSeen(limit);
	return (source, jobId, error) => {
		if (!unseen(`${source}:${jobId}`)) return;
		try {
			journal(source, jobId, (error?.message ?? String(error)).slice(0, 300));
		} catch {
			// A run log that cannot be written must not turn a degraded fact into a
			// thrown one; the degraded reading already fails safe on its own.
		}
	};
}

// ---------------------------------------------------------------------------
// The /cp-awaiting listing text
// ---------------------------------------------------------------------------

/** How to read the whole record when the pane is only its bounded head. */
export const DECIDE_INSPECT_HINT =
	"Full context: /watch <job-id> for the run, /cp-plan <job-id> for the plan or its gate decision.";

export const DECIDE_ANSWER_HINT =
	"Answer one: cp_decide with a mandate {mandate, clause} or {operator_quote} basis.";

/** One listed row: its one-line rendering, plus the bounded pane under it. */
export interface DecideListingRow {
	line: string;
	context?: readonly string[];
}

/**
 * The text a `/cp-decide` with no args prints where there is no rich UI at all
 * (`pi -p`, `json`, a headless client). It carries the same bounded pane the
 * dialogs render, indented under its row, and names how to inspect the rest —
 * so the plain-prompt path is not a blinder (pi-command-post-4mn), and neither
 * the pane nor the hints can ever be mistaken for an answerable option.
 */
export function formatDecideListing(rows: readonly DecideListingRow[]): string {
	if (rows.length === 0) return "Awaiting you: none";
	const lines: string[] = ["Awaiting you:"];
	for (const row of rows) {
		lines.push(`  - ${row.line}`);
		for (const context of row.context ?? []) lines.push(`      ${context}`);
	}
	lines.push("", DECIDE_ANSWER_HINT, DECIDE_INSPECT_HINT);
	return lines.join("\n");
}

export function formatAwaitingLine(item: ResolvedAwaitingItem): string {
	const optionsTag = item.options && item.options.length > 0 ? ` (options: ${item.options.join(", ")})` : "";
	const snoozedTag = item.snoozed ? " (skipped this session)" : "";
	return `${item.id} [${item.type}]${item.job_id ? ` ${item.job_id}:` : ""} ${item.decision} \u2014 why: ${item.why} \u2014 blocks: ${item.blocks}${optionsTag}${snoozedTag}`;
}

/** `cp_awaiting list`'s output: the open decisions, then (cp-gmy) deferred merge asks under their own heading \u2014 not answerable, never invisible. */
export async function awaitingListText(post: Pick<CommandPost, "awaitingSnapshot" | "awaiting">) {
	const items = await post.awaitingSnapshot();
	const deferred = post.awaiting.list("deferred");
	const lines = items.length === 0 ? ["Awaiting you: none"] : items.map((item) => formatAwaitingLine(item));
	if (deferred.length > 0) {
		lines.push(`not asked yet — not ready to merge (${deferred.length}, raised automatically once CI is green on the current head and a review passes):`);
		for (const item of deferred) lines.push(`  ${item.id} ${item.job_id ? `${item.job_id} ` : ""}${item.decision} — ${item.deferred_reason ?? "CI not finished"}`);
	}
	return { text: lines.join("\n"), items, deferred };
}

/** `cp_escalate`'s result line, opening with the escalation's project(s), or its mandate's when no job id resolves. */
export function escalateToolText(raised: Escalation, projectOf: ProjectOf, mandateProjects?: MandateProjects): string {
	return withProjectTag(escalationProjects(raised, projectOf, mandateProjects), `${raised.id} [${raised.kind}] ${raised.status}: ${raised.question}`);
}
