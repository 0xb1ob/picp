/**
 * worker-reporter — WORKER extension.
 *
 * Loaded only into worker sessions (`pi --mode rpc -e .../worker-reporter`).
 * It gives a worker exactly ONE way to finish its job, chosen by role:
 *
 *   planner / implementer -> `report_result`  (job envelope)
 *   gate-reviewer            -> `report_verdict` (gate observation)
 *
 * Never both. An implementer must not be able to emit a verdict, and a
 * reviewer must not be able to emit a job envelope.
 *
 * Both tools share the same discipline:
 *  1. schema + cross-field validation at the source
 *  2. bounded repair — an invalid payload is rejected WITH the reason, so the
 *     model can fix it while its context is still warm; after the cap the run
 *     fails and the parent sees a rejection file
 *  3. write-once record in the run dir; an identical re-report is a no-op and a
 *     contradicting one is refused. Write-once is scoped to one *generation*:
 *     when the parent promotes an already-reported job it archives the record
 *     first (`envelope-superseded-<n>.json`), and this worker's next report is
 *     accepted rather than refused. A worker that can be given work always has
 *     a way to report it.
 *
 * The worker writes only its own record files. `events.jsonl` and `fleet.json`
 * have a single writer, the parent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ciStatusQuery, ciStatusRepeatRefusal, ciWaitRefusal, detectCiWait, shellPatchCommand, shellPatchRefusal } from "../../src/ci-wait.ts";
import { detectWorkerMerge, workerMergeRefusal } from "../../src/worker-merge-guard.ts";
import {
	detectGhAuthStatus,
	detectHomeBulkCopy,
	detectHostAuthCopy,
	ghAuthStatusRefusal,
	homeBulkCopyRefusal,
	hostAuthCopyRefusal,
	redactGithubTokens,
} from "../../src/worker-credential-guard.ts";
import { webEgressRefusal } from "../../src/web-egress.ts";
import { createEditResultEnricher, enrichSilentBashFailure } from "./edit-failures.ts";
import { registerWorkerCompactionGuard } from "./compaction.ts";
import { headShaErrors, type ObservedHead, worktreeHead } from "./head.ts";
export {
	BASH_COMMAND_ECHO_MAX,
	classifyEditFailure,
	createMissCounter,
	type EditFailureDiagnosis,
	editsFromToolInput,
	enrichAnchorEditFailure,
	enrichEditFailure,
	enrichSilentBashFailure,
	extractFailedEditIndex,
	findEditMatchLines,
	REREAD_AFTER_MISSES,
} from "./edit-failures.ts";
import {
	ANSWER_MAX_BYTES,
	type Delivery,
	decisionSummaryErrors,
	DELIVERIES,
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	type Envelope,
	type EnvelopeContext,
	EnvelopeSchema,
	type EnvelopeRecord,
	GATE_REASONS_MAX_ITEMS,
	type GateReview,
	GateReviewSchema,
	isoTimestamp,
	JOB_KINDS,
	type JobKind,
	QUESTION_MAX_CHARS,
	QUESTION_MAX_OPTIONS,
	QUESTION_OPTION_MAX_CHARS,
	type Role,
	ROLES,
	SCHEMA_VERSION,
	SUMMARY_MAX_CHARS,
	SUMMARY_MAX_LINES,
	terminatingToolForRole,
	validate,
	validateEnvelope,
	type VerdictRecord,
	WORKER_FORBIDDEN_TOOLS,
} from "../../src/contracts.ts";

export const ENVELOPE_FILE = "envelope.json";
export const REJECTION_FILE = "envelope-rejected.json";
export const VERDICT_FILE = "verdict.json";
export const VERDICT_REJECTION_FILE = "verdict-rejected.json";
export const VERDICT_RAW_FILE = "verdict-raw.json";

export interface JobContext extends EnvelopeContext {
	/** Role decides which terminating tool this worker gets. */
	role: Role;
	/** Absolute path of `state/runs/<job-id>` on the parent's machine. */
	runDir: string;
	/** Predeclared research artifact path, when the job has one. */
	artifactPath?: string;
	/**
	 * The parent has an operator and this role may ask (T31). Absent
	 * means the tool is not registered at all: a worker that cannot reach a human
	 * must not be told it can.
	 */
	mayAskOperator: boolean;
}

export class WorkerReporterError extends Error {}

/** What the planner is told when a deciding party asks for a revision. */
export function loadJobContext(env: NodeJS.ProcessEnv = process.env): JobContext {
	const jobId = env.CP_JOB_ID?.trim();
	const kind = env.CP_KIND?.trim();
	const delivery = env.CP_DELIVERY?.trim();
	const runDir = env.CP_RUN_DIR?.trim();
	const role = env.CP_ROLE?.trim();
	const missing: string[] = [];
	if (!jobId) missing.push("CP_JOB_ID");
	if (!kind) missing.push("CP_KIND");
	if (!delivery) missing.push("CP_DELIVERY");
	if (!runDir) missing.push("CP_RUN_DIR");
	if (!role) missing.push("CP_ROLE");
	if (missing.length > 0) {
		throw new WorkerReporterError(
			`worker-reporter: missing ${missing.join(", ")} — this extension only runs in a worker dispatched by pi-command-post`,
		);
	}
	if (!(JOB_KINDS as readonly string[]).includes(kind as string)) {
		throw new WorkerReporterError(`worker-reporter: CP_KIND must be one of ${JOB_KINDS.join("|")}, got "${kind}"`);
	}
	if (!(DELIVERIES as readonly string[]).includes(delivery as string)) {
		throw new WorkerReporterError(
			`worker-reporter: CP_DELIVERY must be one of ${DELIVERIES.join("|")}, got "${delivery}"`,
		);
	}
	if (!(ROLES as readonly string[]).includes(role as string)) {
		throw new WorkerReporterError(`worker-reporter: CP_ROLE must be one of ${ROLES.join("|")}, got "${role}"`);
	}
	const context: JobContext = {
		job_id: jobId as string,
		kind: kind as JobKind,
		delivery: delivery as Delivery,
		role: role as Role,
		runDir: runDir as string,
		// Opt-in, set by the parent per spawn. Anything but "1" is off.
		mayAskOperator: env.CP_ASK_OPERATOR?.trim() === "1",
	};
	const worktree = env.CP_WORKTREE?.trim();
	if (worktree) context.worktree = worktree;
	const artifactPath = env.CP_ARTIFACT_PATH?.trim();
	if (artifactPath) context.artifactPath = artifactPath;
	return context;
}

function atomicWriteJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, file);
}

/** Checks the worker can make itself, so the model gets a chance to fix them. */
export function localChecks(
	envelope: Envelope,
	context: JobContext,
	observeHead: (cwd: string) => ObservedHead = worktreeHead,
): string[] {
	const errors: string[] = [];
	const cwd = context.worktree ?? process.cwd();
	errors.push(...headShaErrors(envelope, cwd, () => observeHead(cwd)));
	if (envelope.status !== "done") return errors;

	// pi-command-post-uad: any envelope that NAMES an artifact is checked here,
	// whatever its kind. Intake registers the artifact by stat-and-move and
	// refuses an envelope whose file is not there — and a ship envelope naming a
	// nonexistent path (cp-o77y: `docs/evals.md`) used to skip this check, so the
	// first thing that noticed was the parent, after the slot had closed. The
	// worker can still repair it here, while its context is warm.
	if (envelope.artifact_path) {
		if (context.artifactPath && envelope.artifact_path !== context.artifactPath) {
			errors.push(
				`artifact_path: must be the predeclared path "${context.artifactPath}", got "${envelope.artifact_path}"`,
			);
		} else if (!existsSync(envelope.artifact_path)) {
			errors.push(`artifact_path: "${envelope.artifact_path}" does not exist — write the findings before reporting`);
		} else if (statSync(envelope.artifact_path).size === 0) {
			errors.push(`artifact_path: "${envelope.artifact_path}" is empty — the artifact is the deliverable`);
		} else if (context.delivery === "answer") {
			// cp-u3o4: an answer is glanceable by contract — it renders as a card in
			// the operator's transcript, not as a plan they open. The bound is
			// repairable on purpose: the worker can tighten it, or say the honest
			// answer is a plan and stop.
			const size = statSync(envelope.artifact_path).size;
			if (size > ANSWER_MAX_BYTES) {
				errors.push(
					`artifact_path: "${envelope.artifact_path}" is ${size} bytes, over the ${ANSWER_MAX_BYTES}-byte answer bound — ` +
						"an answer is glanceable: tighten it to the answer plus its evidence, or report blocked saying the honest answer is a plan (that is a research job, not a question)",
				);
			}
		}
	}

	if (envelope.kind === "research" && context.worktree) {
		const porcelain = gitPorcelain(context.worktree);
		if (porcelain && porcelain.length > 0) {
			errors.push(
				`worktree: research must leave the tree clean, but git status --porcelain reports:\n${porcelain}\nRevert the changes or report status "blocked" with the reason.`,
			);
		}
	}
	return errors;
}

function gitPorcelain(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
	} catch {
		// Not a git repo, or git missing: nothing to assert.
		return undefined;
	}
}

/** Cross-field policy for a verdict; shape is already schema-checked. */
export function verdictChecks(review: GateReview, context: JobContext): string[] {
	const errors: string[] = [];
	if (review.job_id !== context.job_id) {
		errors.push(`job_id: must be "${context.job_id}" (the job you are reviewing), got "${review.job_id}"`);
	}
	if (review.verdict === "revise" && (review.revisions ?? []).length === 0) {
		errors.push(
			'revisions: required and non-empty when verdict is "revise" — say exactly what to change, concretely enough to act on without you',
		);
	}
	if (review.verdict !== "revise" && (review.revisions ?? []).length > 0) {
		errors.push(`revisions: only allowed when verdict is "revise" (got verdict "${review.verdict}")`);
	}
	if (review.decision_summary) errors.push(...decisionSummaryErrors(review.decision_summary));
	return errors;
}

/**
 * The strict per-item bound `GateReviewSchema` puts on `reasons`/`revisions`,
 * read from the schema itself so the clamp below cannot drift from the contract.
 */
export const GATE_REVIEW_ITEM_MAX =
	(GateReviewSchema.properties.reasons.items as { maxLength?: number }).maxLength ?? 400;

/**
 * The bound `report_verdict` *advertises*, which is what pi validates against
 * before `execute()` runs.
 *
 * A reviewer that writes a 450-char reason used to have the whole call rejected
 * by pi's own `parameters` check, before this extension saw a byte of it —
 * costing a full extra reviewer turn for a finding that was already complete.
 * So the tool accepts leniently and `validate` clamps to the strict cap: the
 * same degrade-rather-than-discard choice the parent's decided verdict already
 * makes (`capPayload` + `gate-<n>-raw.json`, cp-yg2). Past this bound rejecting
 * is still right — that is not a long finding, it is an artifact body.
 */
export const GATE_REVIEW_LENIENT_ITEM_MAX = 2000;

const LENIENT_ITEM = Type.String({ minLength: 1, maxLength: GATE_REVIEW_LENIENT_ITEM_MAX });

/**
 * `GateReviewSchema` with only the item length bound relaxed — derived from it,
 * so item counts, `minItems`, the optionality of `revisions` and every other
 * field stay whatever the contract says they are.
 */
export const LenientGateReviewSchema = Type.Object(
	{
		...GateReviewSchema.properties,
		reasons: { ...GateReviewSchema.properties.reasons, items: LENIENT_ITEM },
		// Re-wrapped: an object spread does not carry TypeBox's optional marker,
		// and a required `revisions` would reject every pass and escalate.
		revisions: Type.Optional({ ...GateReviewSchema.properties.revisions, items: LENIENT_ITEM }),
	},
	{ additionalProperties: false },
);

/**
 * Hard-cut every over-long `reasons`/`revisions` item to `GATE_REVIEW_ITEM_MAX`,
 * ending it in `…` so a clamped finding never reads as a finished sentence.
 * Returns the payload untouched (same reference) when nothing was over.
 */
export function clampVerdictItems(payload: unknown): { payload: unknown; clamped: boolean } {
	if (typeof payload !== "object" || payload === null) return { payload, clamped: false };
	const source = payload as Record<string, unknown>;
	const next: Record<string, unknown> = { ...source };
	let clamped = false;
	for (const key of ["reasons", "revisions"] as const) {
		const value = source[key];
		if (!Array.isArray(value)) continue;
		next[key] = value.map((item) => {
			if (typeof item !== "string" || item.length <= GATE_REVIEW_ITEM_MAX) return item;
			clamped = true;
			return `${item.slice(0, GATE_REVIEW_ITEM_MAX - 1)}…`;
		});
	}
	return clamped ? { payload: next, clamped: true } : { payload, clamped: false };
}


export function formatRejection(errors: string[], attempt: number, attemptsLeft: number, tool: string): string {
	const lines = [
		`${tool} rejected (attempt ${attempt}). The payload is a contract, not prose.`,
		...errors.map((error) => `- ${error}`),
	];
	lines.push(
		attemptsLeft > 0
			? `Fix exactly these points and call ${tool} again (${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left).`
			: `No attempts left: the job is reported as invalid to the parent.`,
	);
	return lines.join("\n");
}

export interface ReportDetails {
	accepted: boolean;
	duplicate?: boolean;
	rejected?: boolean;
	errors?: string[];
	envelope?: Envelope;
	review?: GateReview;
	path?: string;
}

interface ReporterState {
	attempts: number;
	reported: boolean;
}

/**
 * Shared terminating-report machinery: validate, repair within the cap, write
 * once, refuse contradictions. Both tools are thin wrappers over this.
 */
function makeReporter<T>(options: {
	tool: string;
	recordFile: string;
	rejectionFile: string;
	state: ReporterState;
	validate: (payload: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
	buildRecord: (value: T, attempt: number) => unknown;
	recordPayload: (record: unknown) => unknown;
	details: (value: T, path: string) => ReportDetails;
	headline: (value: T) => string;
}): (payload: unknown, ctx?: ExtensionContext) => Promise<AgentToolResult<ReportDetails>> {
	return async (payload: unknown, ctx?: ExtensionContext): Promise<AgentToolResult<ReportDetails>> => {
		// The parent reopened this slot: it archived the record we wrote and gave us
		// new work. This run reports again, from a clean attempt budget — the repair
		// allowance belongs to a generation, not to a process lifetime.
		if (options.state.reported && !existsSync(options.recordFile)) {
			options.state.reported = false;
			options.state.attempts = 0;
		}

		const result = options.validate(payload);
		if (!result.ok) {
			options.state.attempts += 1;
			const attemptsLeft = ENVELOPE_REPAIR_MAX_ATTEMPTS - options.state.attempts;
			if (attemptsLeft > 0) {
				// Repairable: hand the reasons back while the context is warm.
				throw new WorkerReporterError(
					formatRejection(result.errors, options.state.attempts, attemptsLeft, options.tool),
				);
			}
			atomicWriteJson(options.rejectionFile, {
				schema_version: SCHEMA_VERSION,
				rejected_at: isoTimestamp(),
				attempts: options.state.attempts,
				errors: result.errors,
				last_payload: payload,
			});
			return {
				content: [
					{ type: "text" as const, text: formatRejection(result.errors, options.state.attempts, 0, options.tool) },
				],
				details: { accepted: false, rejected: true, errors: result.errors } satisfies ReportDetails,
				terminate: true,
			};
		}

		options.state.attempts += 1;
		const accepted = result.value;

		if (existsSync(options.recordFile)) {
			const existing = JSON.parse(readFileSync(options.recordFile, "utf8")) as unknown;
			if (JSON.stringify(options.recordPayload(existing)) === JSON.stringify(accepted)) {
				return {
					content: [{ type: "text" as const, text: `Already recorded (no-op): ${options.recordFile}` }],
					details: { accepted: true, duplicate: true } satisfies ReportDetails,
					terminate: true,
				};
			}
			// cp-rud: the previous message ("already accepted with different content")
			// implied the worker had a content conflict it could resolve, when in fact
			// the truth is simpler: the report is on disk and the job is done. Tell
			// the worker the truth so it stops trying.
			throw new WorkerReporterError(
				`${options.tool}: your report was already filed and is on disk at ${options.recordFile}. ` +
					"You are done — stop now. The parent will process this envelope; there is nothing more for you to do. " +
					"Do not call report_result again. If the parent promotes you with new work, the slot is reopened and a new call will be accepted then.",
			);
		}

		atomicWriteJson(options.recordFile, options.buildRecord(accepted, options.state.attempts));
		options.state.reported = true;
		return {
			content: [
				{ type: "text" as const, text: `${options.headline(accepted)} Stop now; the parent takes it from here.` },
			],
			details: options.details(accepted, options.recordFile),
			terminate: true,
		};
	};
}

/** The bounded question tool (T31). Registered only when the parent allows it. */
export const AskOperatorSchema = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			maxLength: QUESTION_MAX_CHARS,
			description: "One decision you cannot resolve by reading. No preamble, no findings body.",
		}),
		options: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: QUESTION_OPTION_MAX_CHARS }), {
				maxItems: QUESTION_MAX_OPTIONS,
				description: "Concrete choices. With options the operator picks one; without them they type an answer.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface AskDetails {
	asked: string;
	answered: boolean;
	answer?: string;
}

/**
 * What the worker is told when no answer came back. It is deliberately an
 * instruction, not an apology: the fail-closed path is the one the brief already
 * describes, and the job still has to end in a report.
 */
export const NO_ANSWER_TEXT = [
	"No answer from the operator (dismissed, or the deadline passed).",
	"Do NOT guess and do NOT ask again. Record the question verbatim under Unknowns/Blockers in your",
	"artifact, and finish: report_result with status \"blocked\" if the plan cannot stand without it, or",
	"status \"done\" with the unknown listed if the rest of the plan is still sound.",
].join(" ");

export default function (pi: ExtensionAPI): void {
	const context = loadJobContext();
	registerWorkerCompactionGuard(pi);
	const state: ReporterState = { attempts: 0, reported: false };
	let ciStatusQueries = 0;
	const enrichEdits = createEditResultEnricher((path) => readFileSync(resolve(process.cwd(), path), "utf8"));

	// Recursion guard: a worker never dispatches, gates, or tears down.
	// Same hook, second guard (cp-kzc): a worker never waits for CI either. The
	// brief says so, but a brief already lost this argument once — the shapes in
	// src/ci-wait.ts are refused here, where wording cannot be overridden by the
	// next brief that asks for a green confirmation.
	pi.on("tool_call", (event) => {
		if (WORKER_FORBIDDEN_TOOLS.includes(event.toolName)) {
			return {
				block: true,
				reason: `${event.toolName} is a parent-only tool. Workers do the job they were briefed on and report with ${terminatingToolForRole(context.role)}.`,
			};
		}
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			const finding = typeof command === "string" ? detectCiWait(command) : undefined;
			if (finding) return { block: true, reason: ciWaitRefusal(finding) };
			const merge = typeof command === "string" ? detectWorkerMerge(command) : undefined;
			if (merge) return { block: true, reason: workerMergeRefusal(merge) };
			const authCopy = typeof command === "string" ? detectHostAuthCopy(command) : undefined;
			if (authCopy) return { block: true, reason: hostAuthCopyRefusal(authCopy) };
			const homeCopy = typeof command === "string" ? detectHomeBulkCopy(command) : undefined;
			if (homeCopy) return { block: true, reason: homeBulkCopyRefusal(homeCopy) };
			const ghAuth = typeof command === "string" ? detectGhAuthStatus(command) : undefined;
			if (ghAuth) return { block: true, reason: ghAuthStatusRefusal(ghAuth) };
			if (typeof command === "string" && shellPatchCommand(command)) return { block: true, reason: shellPatchRefusal() };
			// One CI status snapshot per worker process (revive = new process = one more).
			if (typeof command === "string" && ciStatusQuery(command)) {
				if (ciStatusQueries++ >= 1) return { block: true, reason: ciStatusRepeatRefusal() };
			}
		}
		const web = webEgressRefusal(event.toolName, event.input);
		if (web) return { block: true, reason: web };
		return undefined;
	});

	// The single most common tool failure in the run-log corpus: edit's oldText
	// does not match. The built-in message already says which of three things
	// happened; append the cause label, the specific next move, and — cheaply,
	// from a file already on disk — the line(s) actually involved, so a retry is
	// a correction the model can make without re-reading the whole file.
	pi.on("tool_result", (event) => {
		if (event.toolName === "bash") {
			// GitHub token shapes reach the model and the session JSONL only as [REDACTED]. The run log's
			// streamed tool_execution_update is raw and not covered (docs/storage.md Known gaps).
			let redacted = false;
			const content = event.content.map((block) => {
				if (block.type !== "text") return block;
				const text = redactGithubTokens(block.text);
				if (text !== block.text) redacted = true;
				return { ...block, text };
			});
			if (event.isError) {
				const text = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
				const enriched = redactGithubTokens(enrichSilentBashFailure(text, event.input));
				if (enriched !== text) return { content: [{ type: "text" as const, text: enriched }] };
			}
			return redacted ? { content } : undefined;
		}
		const text = enrichEdits(event);
		return text === undefined ? undefined : { content: [{ type: "text" as const, text }] };
	});

	// T31: a planner may ask the operator one bounded question at a time. Not a
	// terminating tool, and not available to any other role — an implementer that
	// stops to ask is an implementer not implementing. The answer arrives in this
	// worker's context and nowhere near the parent's: pi turns ctx.ui.select into
	// an extension_ui_request on our stdout, which the parent relays to a human.
	if (context.mayAskOperator && context.role === "planner") {
		pi.registerTool(
			defineTool({
				name: "ask_operator",
				label: "Ask Operator",
				description:
					"Ask the human operator one bounded question about a decision you cannot resolve by reading the repository — " +
					"a product choice, a preference between two designs, a missing constraint. It is not for permission: never ask " +
					"whether you may proceed, ship or implement. There may be no operator and no answer; plan for that.",
				promptSnippet: "Ask the operator one bounded question (only what reading cannot answer)",
				promptGuidelines: [
					"Use ask_operator only for a decision the repository cannot answer: a preference, a product choice, a missing constraint.",
					"Never use ask_operator to request permission, approval or sign-off — that is the operator's checkpoint, not your question.",
					"Offer concrete options when there are any; a question with options is far cheaper for a human to answer.",
					"If there is no answer, record the question under Unknowns/Blockers and finish. Never guess, never ask twice.",
				],
				parameters: AskOperatorSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<AskDetails>> {
					const { question, options } = params as { question: string; options?: string[] };
					// hasUI is true in RPC mode precisely because the dialog sub-protocol
					// works (docs/rpc.md); without it there is nobody upstream to relay.
					const answer = ctx?.hasUI
						? options && options.length > 0
							? await ctx.ui.select(question, options)
							: await ctx.ui.input(question)
						: undefined;
					const text = typeof answer === "string" ? answer.trim() : "";
					if (text.length === 0) {
						return {
							content: [{ type: "text" as const, text: NO_ANSWER_TEXT }],
							details: { asked: question, answered: false } satisfies AskDetails,
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `The operator answered: ${text}\n\nTreat this as a decision on the record: cite it in your artifact (Constraints or Goal) and continue. Do not ask it again.`,
							},
						],
						details: { asked: question, answered: true, answer: text } satisfies AskDetails,
					};
				},
			}),
		);
	}

	if (context.role === "gate-reviewer") {
		const recordFile = join(context.runDir, VERDICT_FILE);
		const rawFile = join(context.runDir, VERDICT_RAW_FILE);
		// Set by validate() when the payload it accepted had to be clamped, read on
		// the write path below so the reviewer's own words land next to the record.
		let unclamped: unknown;
		const report = makeReporter<GateReview>({
			tool: "report_verdict",
			recordFile,
			rejectionFile: join(context.runDir, VERDICT_REJECTION_FILE),
			state,
			validate: (payload) => {
				const clamp = clampVerdictItems(payload);
				const shape = validate<GateReview>(GateReviewSchema, clamp.payload);
				if (!shape.ok) return shape;
				const errors = verdictChecks(shape.value, context);
				if (errors.length > 0) return { ok: false, errors };
				unclamped = clamp.clamped ? payload : undefined;
				return shape;
			},
			buildRecord: (review, attempt): VerdictRecord => {
				// buildRecord runs exactly once, immediately before the record is
				// persisted: the only point where "next to the record" is true.
				if (unclamped !== undefined) atomicWriteJson(rawFile, unclamped);
				return {
					schema_version: SCHEMA_VERSION,
					job_id: context.job_id,
					received_at: isoTimestamp(),
					attempt,
					review,
				};
			},
			recordPayload: (record) => (record as VerdictRecord).review,
			details: (review, path) => ({ accepted: true, review, path }),
			headline: (review) =>
				unclamped === undefined
					? `Recorded verdict "${review.verdict}" for ${context.job_id}.`
					: `Recorded verdict "${review.verdict}" for ${context.job_id}. Over-long reasons/revisions were cut to ` +
						`${GATE_REVIEW_ITEM_MAX} chars; your unabridged payload is at ${rawFile}.`,
		});

		pi.registerTool(
			defineTool({
				name: "report_verdict",
				label: "Report Verdict",
				description:
					"Finish this review by reporting your verdict on the artifact you were given. Call it exactly once, as your final action. " +
					"Report what you observed: the parent applies gate policy (flags, attempt caps) — you do not. " +
					`Bounds: each reason is at most 400 characters and there are at most ${GATE_REASONS_MAX_ITEMS} of them; ` +
					"include `revisions` only when the verdict is revise (omit the key otherwise); send no keys beyond job_id, verdict, flags, reasons, revisions.",
				promptSnippet: "Report the gate verdict for the reviewed artifact (final action)",
				promptGuidelines: [
					"Use report_verdict as the final action of this review; there is no other way to finish.",
					"Use report_verdict with verdict escalate when the artifact is missing required sections or cannot be scored at all.",
					"Never restate the artifact body in report_verdict: reasons are short bullets naming the criterion.",
					`Each reason ≤400 chars (max ${GATE_REASONS_MAX_ITEMS} items); include revisions only when verdict is revise.`,
				],
				parameters: LenientGateReviewSchema,
				async execute(_toolCallId, params): Promise<AgentToolResult<ReportDetails>> {
					return report(params);
				},
			}),
		);
		return;
	}

	const recordFile = join(context.runDir, ENVELOPE_FILE);
	const report = makeReporter<Envelope>({
		tool: "report_result",
		recordFile,
		rejectionFile: join(context.runDir, REJECTION_FILE),
		state,
		validate: (payload) => {
			const shape = validateEnvelope(payload, context);
			if (!shape.ok) return shape;
			const errors = localChecks(shape.value, context);
			return errors.length === 0 ? shape : { ok: false, errors };
		},
		buildRecord: (envelope, attempt): EnvelopeRecord => ({
			schema_version: SCHEMA_VERSION,
			job_id: context.job_id,
			received_at: isoTimestamp(),
			attempt,
			envelope,
		}),
		recordPayload: (record) => (record as EnvelopeRecord).envelope,
		details: (envelope, path) => ({ accepted: true, envelope, path }),
		headline: (envelope) =>
			envelope.status === "done"
				? `Reported ${context.job_id} as done.`
				: `Reported ${context.job_id} as blocked (${envelope.blockers?.length ?? 0} blocker(s)).`,
	});

	pi.registerTool(
		defineTool({
			name: "report_result",
			label: "Report Result",
			description:
				"Finish this job by reporting a structured envelope to the command post. Call it exactly once, as your final action. " +
				`The summary is a headline (max ${SUMMARY_MAX_LINES} lines, max ${SUMMARY_MAX_CHARS} characters) — findings belong in the artifact file, never in the envelope. ` +
				"`blockers` is required and non-empty when status is \"blocked\". A planner's blockers are objects " +
				"{question, why, options, recommended, assume_if_unanswered}, at most 3, each field one line; " +
				"an implementer's blockers are strings. `self_assessment` carries exactly the documented keys and no others; " +
				"`head_sha`/`base_sha` are full 40-character shas, never abbreviated; a completed ship job must send `head_sha` = `git rev-parse HEAD` of its worktree. " +
				"A completed research plan includes plan_summary. A missing or oversize summary is repaired, not filed.",
			promptSnippet: "Report the final job envelope to the command post (final action)",
			promptGuidelines: [
				"Use report_result as the final action of this job: status done when the work is complete, status blocked with concrete blockers when it is not.",
				"Pushing a branch, opening a PR or writing an artifact is not finishing: report_result is the only channel that reaches the operator, who wakes on envelopes and polls nothing.",
				"Never end a turn with prose describing what you delivered — that prose reaches nobody. Put it in report_result's summary and call the tool.",
				"Never put a findings body, a diff, or a transcript into report_result's summary — write those to the artifact file.",
			],
			parameters: EnvelopeSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<ReportDetails>> {
				return report(params, ctx);
			},
		}),
	);
}
