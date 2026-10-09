/**
 * The ledger's two surfaces (spec 2026-09-04 D6, D7).
 *
 *  - **`cp_job`** is the model's. One tool, `action`-discriminated, every
 *    argument typed in the schema so a malformed call is refused at the
 *    boundary. It returns the affected job (or the list) and never anything
 *    the ledger does not store.
 *  - **`/cp-jobs`** is the operator's: `ready`, `list`, `show` (read-only) and
 *    the one write, `import-beads`.
 *
 * Three refusals live here and not in `Ledger`, because the model is the only
 * caller that could make them by accident: closing a job a live worker holds
 * (`cp_teardown` is the path), claiming a job that is already `in_progress`
 * (dispatch claims), and hand-creating a `pipeline` or `answer` job (those
 * come from `cp_pipeline start` and `cp_ask`, which also do the rest).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { CommandPost } from "../../src/command-post.ts";
import { operatorTextsFromEntries } from "../../src/decide.ts";
import { addTaskAddendum } from "../../src/task-addenda.ts";
import { DELIVERIES, JOB_KINDS, JOB_STATUSES, jobLabelErrors, type Job, type JobStatus, RISK_CRITERIA, RISKS, type Runtime, type TrackerConnection } from "../../src/contracts.ts";
import { type EscalationStore, raiseConflictingRef } from "../../src/escalation.ts";
import { formatBeadsImport, importBeads } from "../../src/ledger-import.ts";
import { type Ledger, assertScriptIntake, formatJobLabels, parseJobLabels } from "../../src/ledger.ts";
import { resolveProjectArg } from "../../src/mode.ts";
import { admitScheduledMember, readSchedulesOrEmpty, scheduleLabelRefusal, scheduleRiskRefusal } from "../../src/schedule-expand.ts";
import { openScheduleRunStore, type ScheduleRunStore } from "../../src/schedule-runs.ts";
import { TrackerStore } from "../../src/trackers/config.ts";
import { autoLink } from "../../src/trackers/link.ts";
import { BR_SHOW_RE, describeRefMismatch, describeRefVerification, type RefVerification, verifyExternalRef } from "../../src/verify-external-ref.ts";

export const JOB_ACTIONS = [
	"create",
	"show",
	"list",
	"ready",
	"blocked",
	"claim",
	"update",
	"comment",
	"amend",
	"dep_add",
	"dep_remove",
	"close",
	"drop",
] as const;

/**
 * Closed, like every other contract object: an argument this tool does not
 * name is a refusal, never a silent drop. That is what makes the retirement of
 * `type` and `priority` visible to a caller that still sends them (2026-09-05)
 * instead of accepting the call and quietly ignoring the field.
 */
export const JobActionSchema = Type.Object(
	{
		action: StringEnum([...JOB_ACTIONS]),
		job_id: Type.Optional(Type.String({ description: "show/claim/update/comment/amend/dep_*/close/drop: the job" })),
		title: Type.Optional(Type.String({ description: "create: the job title (a question, for Q&A; a one-line task otherwise)" })),
		project: Type.Optional(Type.String({ description: "create: a registered project name; list/ready: filter" })),
		delivery: Type.Optional(StringEnum([...DELIVERIES], { description: "create: pr|local (pipeline and answer come from cp_pipeline / cp_ask); list: filter" })),
		kind: Type.Optional(StringEnum([...JOB_KINDS], { description: "create: ship|research; list: filter" })),
		risk: Type.Optional(StringEnum([...RISKS], { description: `create: what a mistake costs, recorded on the job as a risk:<low|high> label (explicit). The risk:high gate reads it: a recorded low turns a keyword-only high into a warning, a recorded high always gates. ${RISK_CRITERIA}` })),
		description: Type.Optional(Type.String()),
		external_ref: Type.Optional(
			Type.String({
				description:
					"create: where the issue lives — a tracker url, a file path, or the command that shows it (for a br tracker: `br --db <absolute path to project's .beads/beads.db> show <id> --json`, so it still works from a leased worktree); one line, never the body",
			}),
		),
		script_path: Type.Optional(Type.String({ description: "create only: checked-in POSIX repository-relative shell script; requires kind:ship delivery:local" })),
		slug: Type.Optional(Type.String({ description: "create: optional readable stem, e.g. fix-login -> cp-fix-login-a1b2" })),
		labels: Type.Optional(Type.Array(Type.String(), { description: "create: extra labels; list: AND filter" })),
		status: Type.Optional(StringEnum([...JOB_STATUSES], { description: "update: open|in_progress|deferred (never closed); list: filter" })),
		all: Type.Optional(Type.Boolean({ description: "list: include closed jobs" })),
		limit: Type.Optional(Type.Integer({ minimum: 0, description: "list: page size; 0 or absent = unlimited" })),
		notes: Type.Optional(Type.String({ description: "update: replace the notes" })),
		add_labels: Type.Optional(Type.Array(Type.String())),
		remove_labels: Type.Optional(Type.Array(Type.String())),
		text: Type.Optional(Type.String({ description: "comment: the comment; amend: inline scope addition (or task_file)" })),
		task_file: Type.Optional(Type.String({ description: "amend: file containing the scope addition, frozen at add time" })),
		quote: Type.Optional(Type.String({ description: "amend: verbatim operator quote authorizing this addition" })),
		blocker_id: Type.Optional(Type.String({ description: "dep_add/dep_remove: the job that must close first" })),
		reason: Type.Optional(Type.String({ description: "close/drop/amend: why (a PR url, an artifact, or what superseded it)" })),
	},
	{ additionalProperties: false },
);
export type JobActionInput = Static<typeof JobActionSchema>;

export interface JobPorts {
	ledger: Ledger;
	runs?: ScheduleRunStore;
	/** amend: user messages from this session, never worker/tool text. */
	operatorTexts?: readonly string[];
	/** True when fleet.json has a record for the job in phase `waiting` or `held`. */
	hasLiveWorker: (jobId: string) => boolean;
	/** dep_remove: has this job's worker filed a report? "none" = never dispatched; absent port reads "none". */
	reportState?: (jobId: string) => "reported" | "unreported" | "none";
	/** Intake: record an id `cp_job create` returned this parent turn. */
	noteCreated?: (jobId: string) => void;
	/**
	 * The `project` argument, resolved against the session's runtime: required
	 * (a registered project name).
	 */
	resolveProject: (given: string | undefined) => string;
	/**
	 * create: verifies `external_ref` before the job is recorded (pi-command-post-autonomy-programme-cur.4.5).
	 * Defaults to `verifyExternalRef`; overridden in tests to script `gh`/`br` responses.
	 */
	verifyRef?: (ref: string) => Promise<RefVerification>;
	/** create: where a refused/unverifiable ref's escalation and note are written. */
	escalations: () => EscalationStore;
	/** create: tracker connections, to auto-link a job whose external_ref names a bead on its project's active connection (laf). */
	trackers?: () => readonly TrackerConnection[];
}

export interface JobActionResult {
	text: string;
	details: Record<string, unknown>;
}

function need<K extends keyof JobActionInput>(params: JobActionInput, key: K): NonNullable<JobActionInput[K]> {
	const value = params[key];
	if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
		throw new Error(`cp_job ${params.action} needs ${String(key)}`);
	}
	return value as NonNullable<JobActionInput[K]>;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** One line per job: id, status, project, delivery/kind, title. */
export function formatJobLine(job: Job): string {
	const errors = jobLabelErrors(job.labels);
	if (errors.length > 0) return `${pad(job.id, 12)} ${pad(job.status, 12)} ${job.title} [label error: ${errors.join("; ")}]`;
	const labels = parseJobLabels(job.labels);
	const route = `${labels.delivery ?? "?"}${labels.kind ? `/${labels.kind}` : ""}${job.script ? " [script]" : ""}`;
	return `${pad(job.id, 12)} ${pad(job.status, 12)} ${pad(labels.project ?? "?", 16)} ${pad(route, 10)} ${job.title}`.trimEnd();
}

/** The whole record, for `show`: labels, blockers with their statuses, comments in order. */
export function formatJobDetail(job: Job, blockers: readonly Job[]): string {
	const lines = [
		`${job.id}  ${job.status}${job.assignee ? `  (assignee ${job.assignee})` : ""}`,
		`  title:     ${job.title}`,
		`  labels:    ${job.labels.join(", ")}`,
		`  created:   ${job.created_at}  updated: ${job.updated_at}`,
	];
	if (job.script) lines.push(`  script:    ${job.script.path}`);
	if (job.external_ref) lines.push(`  ref:       ${job.external_ref}`);
	if (job.description) lines.push(`  desc:      ${job.description.split("\n")[0]}${job.description.includes("\n") ? " …" : ""}`);
	if (job.notes) lines.push(`  notes:     ${job.notes.split("\n")[0]}`);
	if (job.blocked_by.length > 0) {
		lines.push("  blocked by:");
		for (const id of job.blocked_by) {
			const blocker = blockers.find((b) => b.id === id);
			lines.push(`    ${id}  ${blocker ? blocker.status : "(unknown)"}`);
		}
	}
	if (job.status === "closed") lines.push(`  closed:    ${job.closed_at}  ${job.close_reason}`);
	if (job.comments.length > 0) {
		lines.push(`  comments (${job.comments.length}):`);
		for (const comment of job.comments) lines.push(`    ${comment.at} ${comment.author}: ${comment.text}`);
	}
	return lines.join("\n");
}

function listResult(jobs: Job[], empty: string): JobActionResult {
	return {
		text: jobs.length === 0 ? empty : jobs.map(formatJobLine).join("\n"),
		details: { jobs },
	};
}

/** create: auto-link a job whose ref names a bead (laf). Never fails the create; no ref or no port adds nothing. */
async function linkCreated(ledger: Ledger, job: Job, ports: JobPorts): Promise<{ text: string; job: Job; details: { tracker?: string } }> {
	if (!ports.trackers || !job.external_ref) return { text: "", job, details: {} };
	let line: string;
	try {
		line = await autoLink(ledger, job, ports.trackers());
	} catch (error) {
		line = `not linked to a tracker bead: ${(error as Error).message.split("\n")[0]}`;
	}
	return { text: `\n  tracker: ${line}`, job: await ledger.show(job.id), details: { tracker: line } };
}

/** The policy behind `cp_job`. Pure over its ports; the tool and the tests call this. */
export async function runJobAction(params: JobActionInput, ports: JobPorts): Promise<JobActionResult> {
	const { ledger } = ports;
	const runs = ports.runs ?? openScheduleRunStore(ledger.home);
	if (params.script_path !== undefined && params.action !== "create") throw new Error("script_path is create only");
	if (params.risk !== undefined && params.action !== "create") throw new Error("risk is create only; change a recorded risk with cp_job update add_labels/remove_labels (risk:<low|high>)");
	switch (params.action) {
		case "create": {
			const delivery = need(params, "delivery");
			if (delivery === "pipeline") {
				throw new Error("cp_job create refuses delivery:pipeline — a pipeline is two dep-linked jobs and a planner dispatch; use `cp_pipeline start`");
			}
			if (delivery === "answer") {
				throw new Error("cp_job create refuses delivery:answer — a Q&A job is created and dispatched together; use `cp_ask`");
			}
			const title = need(params, "title");
			assertScriptIntake({ delivery, kind: params.kind, scriptPath: params.script_path });
			const project = ports.resolveProject(params.project);
			const labelErrors = jobLabelErrors([...formatJobLabels({ project, delivery, kind: params.kind, risk: params.risk }), ...(params.labels ?? [])]);
			if (labelErrors.length > 0) throw new Error(`cp_job create refused: ${labelErrors.join("; ")}`);
			const existing = ledger.findDuplicate({ title, project, ...(params.external_ref !== undefined ? { externalRef: params.external_ref } : {}) });
			// A `schedule:<id>` label is minted by a fire: only a parent-expanded schedule's open run may add jobs to it.
			const labelRefusal = scheduleLabelRefusal(params.labels ?? [], ledger.read().jobs, readSchedulesOrEmpty(ledger.home), { runs, ...(existing ? { reuseId: existing.id } : {}), ...(params.risk ? { risk: params.risk } : {}) });
			if (labelRefusal) throw new Error(`cp_job create refused: ${labelRefusal}`);
			if (existing) {
				const errors = jobLabelErrors(existing.labels);
				if (errors.length > 0) throw new Error(`${existing.id}: label error: ${errors.join("; ")}; repair with cp_job update add_labels/remove_labels`);
				if (existing.script?.path !== params.script_path) throw new Error(`cp_job create refused: ${existing.id} has a different action (${existing.script ? `script:${existing.script.path}` : "model"})`);
				const recordedRisk = parseJobLabels(existing.labels).risk;
				if (params.risk !== undefined && recordedRisk !== params.risk) {
					throw new Error(`cp_job create refused: ${existing.id} records ${recordedRisk ? `risk:${recordedRisk}` : "no risk"}; change it with cp_job update add_labels/remove_labels`);
				}
				await admitScheduledMember(runs, existing);
				ports.noteCreated?.(existing.id);
				const linked = await linkCreated(ledger, existing, ports);
				return { text: `created ${existing.id}: ${formatJobLine(existing)}${linked.text}`, details: { job: linked.job, existing: true, ...linked.details } };
			}
			// pi-command-post-autonomy-programme-cur.4.5: a ref is checked once, only on the create that
			// would actually mint a job \u2014 the idempotent hit above already carries whatever the first
			// create found. A mismatch refuses before anything is written; unverifiable/unreachable is
			// ignorance, not a mismatch, and lands on the job as a note instead.
			let refNote: string | undefined;
			if (params.external_ref !== undefined) {
				const ref = ledger.normalizeRef(params.external_ref, project);
				const bare = BR_SHOW_RE.exec(ref);
				// No project DB: a bare br ref is never read against the home's (or cwd's) database.
				const verification: RefVerification = bare && !bare[1]
					? { status: "unreachable", message: `no beads database is configured for project ${project} (cp_tracker connect, or <clone>/.beads); bare br ref not verified` }
					: await (ports.verifyRef ? ports.verifyRef(ref) : verifyExternalRef(ref, { cwd: ledger.home }));
				const mismatch = describeRefMismatch(params.external_ref, verification);
				if (mismatch) {
					const anchorJobId = `verify-${project}`;
					const store = ports.escalations();
					const deferred = verification.status === "found" && verification.kind === "br" && verification.state === "deferred";
					const override = deferred ? store.list({ jobId: anchorJobId, kind: "conflicting_acceptance", status: "answered" }).find((item) =>
						item.job_ids.length === 1 && item.answer?.trim().toLowerCase() === "override" &&
						item.answered_at !== undefined && item.answered_at >= item.created_at &&
						(item.deferred_refs !== undefined ? item.deferred_refs.includes(ref)
							// Legacy records lack structured refs: require the complete single-ref question and an explicit DB pin.
							: BR_SHOW_RE.exec(params.external_ref ?? "")?.[1] !== undefined && item.question === `external_ref check failed — ${params.external_ref}: ${mismatch}`)) : undefined;
					if (!override) {
						await raiseConflictingRef(store, { anchorJobId, ref: params.external_ref, found: mismatch, ...(deferred ? { deferredRef: ref } : {}) });
						throw new Error(
							`cp_job create refused: ${mismatch} \u2014 raised a conflicting_acceptance escalation (job_ids [${anchorJobId}]); relay it, do not dispatch`,
						);
					}
					refNote = `${describeRefVerification(verification)}; deferred-bead admission override: ${override.id}`;
				} else {
					refNote = describeRefVerification(verification);
				}
			}
			const created = await ledger.create({
				title,
				project,
				delivery,
				...(params.kind ? { kind: params.kind } : {}),
				...(params.risk ? { risk: params.risk } : {}),
				...(params.description !== undefined ? { description: params.description } : {}),
				...(params.external_ref !== undefined ? { externalRef: params.external_ref } : {}),
				...(params.script_path !== undefined ? { scriptPath: params.script_path } : {}),
				...(params.slug !== undefined ? { slug: params.slug } : {}),
				...(params.labels ? { labels: params.labels } : {}),
			});
			const job = refNote ? await ledger.update(created.id, { notes: refNote }) : created;
			await admitScheduledMember(runs, job);
			ports.noteCreated?.(job.id);
			const linked = await linkCreated(ledger, job, ports);
			const riskLine = params.risk ? `\n  risk: ${params.risk} recorded on the job (the risk:high gate reads it; routing does not lower on it)` : "";
			return { text: `created ${job.id}: ${formatJobLine(job)}${riskLine}${linked.text}`, details: { job: linked.job, ...linked.details } };
		}
		case "show": {
			const job = await ledger.show(need(params, "job_id"));
			const blockers = await Promise.all(job.blocked_by.map((id) => ledger.show(id).catch(() => undefined)));
			return { text: formatJobDetail(job, blockers.filter((b): b is Job => b !== undefined)), details: { job } };
		}
		case "list": {
			const jobs = await ledger.list({
				...(params.project ? { project: params.project } : {}),
				...(params.delivery ? { delivery: params.delivery } : {}),
				...(params.kind ? { kind: params.kind } : {}),
				...(params.status ? { status: params.status as JobStatus } : {}),
				...(params.all ? { all: true } : {}),
				...(params.limit !== undefined ? { limit: params.limit } : {}),
				...(params.labels ? { labels: params.labels } : {}),
			});
			return listResult(jobs, "no jobs match");
		}
		case "ready": {
			const jobs = await ledger.ready(params.project ? { project: params.project } : {});
			return listResult(jobs, "nothing is ready");
		}
		case "blocked": {
			const jobs = await ledger.blocked();
			const rows = await Promise.all(jobs.map(async (job) => ({ id: job.id, blockers: await ledger.blockersOf(job.id) })));
			return {
				text: rows.length === 0 ? "nothing is blocked" : rows.map((row) => `${row.id}  blocked by ${row.blockers.join(", ")}`).join("\n"),
				details: { jobs: rows },
			};
		}
		case "claim": {
			const id = need(params, "job_id");
			const current = await ledger.show(id);
			if (current.status === "in_progress") {
				throw new Error(
					`${id} is already in_progress (assignee ${current.assignee ?? "unknown"}) — dispatch claims a job; a second claim means a dispatch was skipped. Use cp_dispatch.`,
				);
			}
			const job = await ledger.claim(id, id);
			return { text: `claimed ${job.id}`, details: { job } };
		}
		case "update": {
			// The org run cap reads the labels the job would carry after this update: a risk:high it keeps or gains counts.
			const jobs = ledger.read().jobs;
			const schedules = readSchedulesOrEmpty(ledger.home);
			const target = params.job_id === undefined ? undefined : jobs.find((job) => job.id === params.job_id);
			const after = [...(target?.labels ?? []).filter((label) => !(params.remove_labels ?? []).includes(label)), ...(params.add_labels ?? [])];
			const labelRefusal =
				scheduleLabelRefusal([...(params.add_labels ?? []), ...after.filter((label) => label.startsWith("schedule:") && runs.active && runs.activePolicy(label.slice("schedule:".length)))], jobs, schedules, { runs, ...(target ? { reuseId: target.id } : {}), ...(after.includes("risk:high") ? { risk: "high" } : {}) }) ??
				(target ? scheduleRiskRefusal(target.id, params.add_labels ?? [], jobs, schedules) : undefined);
			if (labelRefusal) throw new Error(`cp_job update refused: ${labelRefusal}`);
			const job = await ledger.update(need(params, "job_id"), {
				...(params.status ? { status: params.status as JobStatus } : {}),
				...(params.notes !== undefined ? { notes: params.notes } : {}),
				...(params.add_labels ? { addLabels: params.add_labels } : {}),
				...(params.remove_labels ? { removeLabels: params.remove_labels } : {}),
			});
			await admitScheduledMember(runs, job);
			return { text: `updated ${job.id}: ${formatJobLine(job)}`, details: { job } };
		}
		case "comment": {
			const job = await ledger.comment(need(params, "job_id"), need(params, "text"));
			return { text: `commented on ${job.id} (${job.comments.length} comment(s))`, details: { job } };
		}
		case "amend": {
			const id = need(params, "job_id");
			const { text: _body, ...addendum } = await addTaskAddendum({
				ledger, jobId: id, taskFile: params.task_file, text: params.text,
				quote: need(params, "quote"), reason: need(params, "reason"), operatorTexts: ports.operatorTexts ?? [],
			});
			return { text: `amended ${id}: addendum ${addendum.n} by ${addendum.by}; cp_send ${id} to deliver it`, details: { job_id: id, addendum } };
		}
		case "dep_add": {
			const id = need(params, "job_id");
			await ledger.addDep(id, need(params, "blocker_id"));
			const job = await ledger.show(id);
			return { text: `${id} is now blocked by ${job.blocked_by.join(", ")}`, details: { job } };
		}
		case "dep_remove": {
			const id = need(params, "job_id");
			const blockerId = need(params, "blocker_id");
			// issue #2: a blocker whose worker never reported has produced nothing to depend on or to skip.
			const blocker = await ledger.show(blockerId).catch(() => undefined); // unknown blockers stay removable (doctor.ts)
			const report = ports.reportState?.(blockerId) ?? "none";
			if (blocker && blocker.status !== "closed" && report === "unreported") {
				throw new Error(`cp_job dep_remove refused: ${blockerId} is ${blocker.status} and its worker has filed no report — nothing it was to produce exists; relay "no report" for it. Wait for its envelope, or to go on without it: cp_job drop ${blockerId} with a reason (cp_teardown first if a worker holds it), and the operator answers the dropped-dependency question cp_next raises for ${id}.`);
			}
			await ledger.removeDep(id, blockerId);
			const job = await ledger.show(id);
			const warning = blocker && blocker.status !== "closed"
				? `warning: ${blockerId} is still ${blocker.status}${report === "none" ? " and was never dispatched" : ""}; ${id} no longer waits for it, and nothing of ${blockerId}'s may be relayed as done`
				: undefined;
			return { text: `${id} is blocked by ${job.blocked_by.length === 0 ? "nothing" : job.blocked_by.join(", ")}${warning ? `\n  ${warning}` : ""}`, details: { job, ...(warning ? { warning } : {}) } };
		}
		case "close":
		case "drop": {
			const id = need(params, "job_id");
			const reason = need(params, "reason");
			if (ports.hasLiveWorker(id)) {
				throw new Error(
					`${id}: a worker holds this job; cp_teardown ${id} first (or cp_integrate ${id} for a merged PR), then ${params.action} it`,
				);
			}
			const job = params.action === "close" ? await ledger.close(id, reason) : await ledger.drop(id, reason);
			return { text: `${params.action === "close" ? "closed" : "dropped"} ${job.id}: ${job.close_reason}`, details: { job } };
		}
	}
}

// ---------------------------------------------------------------------------
// /cp-jobs
// ---------------------------------------------------------------------------

export type JobsCommand =
	| { kind: "ready"; project?: string }
	| { kind: "list"; project?: string; all: boolean; status?: JobStatus }
	| { kind: "show"; jobId: string }
	| { kind: "import-beads" };

const USAGE = "usage: /cp-jobs [ready [--project N] | list [--all] [--status S] [--project N] | show <job-id> | import-beads]";

export function parseJobsArgs(args: string): JobsCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const head = tokens[0] ?? "ready";
	const rest = tokens.slice(1);
	const flag = (name: string): string | undefined => {
		const index = rest.indexOf(name);
		if (index < 0) return undefined;
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`/cp-jobs: ${name} needs a value — ${USAGE}`);
		return value;
	};
	switch (head) {
		case "ready": {
			const project = flag("--project");
			return { kind: "ready", ...(project ? { project } : {}) };
		}
		case "list": {
			const project = flag("--project");
			const status = flag("--status");
			if (status !== undefined && !(JOB_STATUSES as readonly string[]).includes(status)) {
				throw new Error(`/cp-jobs list: --status must be one of ${JOB_STATUSES.join("|")}`);
			}
			return { kind: "list", all: rest.includes("--all"), ...(project ? { project } : {}), ...(status ? { status: status as JobStatus } : {}) };
		}
		case "show": {
			const jobId = rest[0];
			if (!jobId || jobId.startsWith("--")) throw new Error(`/cp-jobs show needs a job id — ${USAGE}`);
			return { kind: "show", jobId };
		}
		case "import-beads":
			return { kind: "import-beads" };
		default:
			throw new Error(`/cp-jobs: unknown subcommand ${JSON.stringify(head)} — ${USAGE}`);
	}
}

export interface JobsRegistration {
	commandPost: (registry?: unknown) => CommandPost;
	emit: (ctx: ExtensionContext, source: string, text: string, options?: { level?: "info" | "error" }) => void;
	/** The session's runtime; `project` is required. */
	runtime: () => Runtime;
	/** Intake: ids `cp_job create` returned this parent turn. */
	onJobCreated?: (jobId: string) => void;
}

/**
 * `hasLiveWorker`'s one real implementation: a job counts as held by a worker
 * exactly when the fleet record for it is in phase `waiting` (dispatched,
 * running or idle-but-alive) or `held` (a `delivery:pr` job whose PR has not
 * landed yet, worker and lease deliberately still up). `done` and `failed`
 * are the two phases `cp_teardown` has already cleared, and no record at all
 * means no worker was ever dispatched for this id — both are "safe to close
 * here", not "ask cp_teardown first".
 */
export function portsFor(post: CommandPost, runtime: Runtime): JobPorts {
	return {
		ledger: post.ledger(),
		resolveProject: (given) => resolveProjectArg(runtime, given, "cp_job create"),
		escalations: () => post.escalations,
		trackers: () => new TrackerStore({ home: post.home, registry: post.registry }).list(),
		hasLiveWorker: (jobId) => {
			try {
				const phase = post.fleet.get(jobId)?.phase;
				return phase === "waiting" || phase === "held";
			} catch {
				return false;
			}
		},
		// An unreadable fleet cannot prove a report, so it fails closed.
		reportState: (jobId) => {
			try {
				const record = post.fleet.get(jobId);
				return !record ? "none" : record.reported_at !== undefined ? "reported" : "unreported";
			} catch {
				return "unreported";
			}
		},
	};
}

/** Wire `cp_job` and `/cp-jobs`. Called once from `index.ts`. */
export function registerJobs(pi: ExtensionAPI, ports: JobsRegistration): void {
	pi.registerTool({
		name: "cp_job",
		label: "Jobs ledger",
		description:
			"The job ledger: create a job (project + delivery labels are the dispatchability contract), show/list/ready/blocked, " +
			"claim, update, comment, amend scope with a verified operator quote, add or remove a blocking dependency, close or drop with a reason. Pipelines come from cp_pipeline, " +
			"Q&A jobs from cp_ask; finished research/answer close on cp_teardown and ship on cp_integrate; a live worker is refused here.",
		promptSnippet: "Record and query jobs in the ledger: create/show/list/ready/blocked/claim/update/comment/amend/dep_add/dep_remove/close/drop (cp_job)",
		promptGuidelines: [
			"Every job needs project (a registered name) and delivery (pr|local); add kind ship|research when it helps routing.",
			"Pass risk on cp_job create only when the operator or the spec states it (never invent it): a recorded low turns a keyword-only risk:high into a warning, a recorded high always gates.",
			"When the operator names an issue, store where it lives as external_ref (url, path, or the command that shows it); for a br tracker, pin the project's beads DB with --db and its absolute path (`br --db /abs/path/.beads/beads.db show <id> --json`) so it still works from a leased worktree — the ledger points at issues, it does not copy them.",
			"cp_job create is idempotent: the same project + title, or the same external_ref, returns the existing open job. Echo each id. A repeated list creates nothing new.",
			"cp_job ready is the queue; cp_next says which of it the active mandate covers and what to do next.",
			"cp_job close/drop is for dropping work (`dropped: …`). Finished research and Q&A close on cp_teardown; ship jobs close on cp_integrate. A live worker is torn down first.",
			"cp_job amend adds authorized scope: job_id, task_file (or text), quote from an operator message, and reason. It freezes an append-only addendum without replacing the original task; cp_send delivers it to the worker. Closed jobs refuse.",
			"Decisions and blockers are comments on the job, not a parallel journal.",
		],
		parameters: JobActionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const jobPorts = portsFor(ports.commandPost(ctx.modelRegistry), ports.runtime());
			if (params.action === "amend") jobPorts.operatorTexts = operatorTextsFromEntries(ctx.sessionManager.getEntries());
			if (ports.onJobCreated) jobPorts.noteCreated = ports.onJobCreated;
			const result = await runJobAction(params, jobPorts);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("cp-jobs", {
		description: "The job ledger: ready (default), list [--all] [--status S] [--project N], show <job-id>, import-beads",
		getArgumentCompletions: (prefix: string) => {
			const words = ["ready", "list", "show", "import-beads", "--all", "--status", "--project"]
				.filter((word) => word.startsWith(prefix))
				.map((word) => ({ value: word, label: word }));
			return words.length > 0 ? words : null;
		},
		handler: async (args, ctx) => {
			try {
				const command = parseJobsArgs(args);
				const post = ports.commandPost(ctx.modelRegistry);
				const p = portsFor(post, ports.runtime());
				let text: string;
				switch (command.kind) {
					case "ready":
						text = (await runJobAction({ action: "ready", ...(command.project ? { project: command.project } : {}) }, p)).text;
						break;
					case "list":
						text = (
							await runJobAction(
								{
									action: "list",
									all: command.all,
									...(command.project ? { project: command.project } : {}),
									...(command.status ? { status: command.status } : {}),
								},
								p,
							)
						).text;
						break;
					case "show":
						text = (await runJobAction({ action: "show", job_id: command.jobId }, p)).text;
						break;
					case "import-beads":
						text = formatBeadsImport(await importBeads(post.ledger()));
						break;
				}
				ports.emit(ctx, "cp-jobs", text);
			} catch (error) {
				ports.emit(ctx, "cp-jobs", (error as Error).message, { level: "error" });
			}
		},
	});
}
