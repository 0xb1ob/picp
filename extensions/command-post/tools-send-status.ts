/**
 * cp_send, cp_revive and cp_status_block.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { awaitingRowsNotSupplied } from "../../src/awaiting.ts";
import { isoTimestamp, type AwaitingItem } from "../../src/contracts.ts";
import { blockedJobs } from "../../src/blocked-jobs.ts";
import { renderSessionStatusBlock } from "../../src/shipped-seen.ts";
import {
	MAX_CELL_CHARS,
	MAX_LABEL_CHARS,
	resolvedMergeAskRows,
	STATUS_BLOCK_DEFAULT_WIDTH,
	type StatusBlockAwaitingInput,
	type StatusBlockMergeAskInput,
	type StatusBlockRefusedInput,
} from "../../src/status-block.ts";
import { resolveAwaitingRows } from "../../src/awaiting-rows.ts";
import { formatRevivePlan, formatReviveResult } from "../../src/revive.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerSendStatusTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, refreshWidget } = deps;

	pi.registerTool({
		name: "cp_send",
		label: "Send",
		description:
			"Deliver a message to a live worker: promote an idle worker with a new brief, steer a running one, " +
			"or queue a follow-up. Returns the delivery receipt (delivered | queued | failed) as JSON. Promoting a job " +
			"that already reported reopens its envelope slot (the reply carries `superseded`), so the promoted run ends " +
			"in a new envelope; a job whose delivery has landed is refused, naming teardown + fresh dispatch. A promotion " +
			"of an IDLE worker (mode prompt) may also carry `task` or `task_file` to replace the frozen task a diff " +
			"reviewer scores against, applied only once the worker actually took the message (the reply then carries " +
			"`task_updated`); a steer, a follow_up, or a prompt aimed at a busy worker refuses either, because they must " +
			"never rewrite scope.",
		promptSnippet: "Send a message to a live worker (cp_send)",
		promptGuidelines: [
			"Use cp_send to promote or steer an existing worker instead of dispatching a second one.",
			"cp_send receipt 'delivered' means pi accepted the message, not that the worker complied.",
			"A promote to a held job reopens its envelope slot: expect a new envelope, and never re-brief a job whose PR already merged.",
			"When a promotion changes what was asked for, pass `task` (or `task_file`) too, so the reviewer's frozen task matches the new scope instead of flagging it as growth.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The job whose worker should receive this message" }),
			message: Type.String({ description: "The new brief, steer or follow-up text" }),
			mode: Type.Optional(
				StringEnum(["auto", "prompt", "steer", "follow_up"], {
					description: "auto: prompt when idle, steer when busy",
				}),
			),
			model: Type.Optional(
				Type.String({ description: "Assert the worker's model; a mismatch is refused (promote is same-model)" }),
			),
			task: Type.Optional(
				Type.String({
					description:
						"Replace the frozen original task with this text (promotions only, mode prompt). Mutually exclusive with task_file.",
				}),
			),
			task_file: Type.Optional(
				Type.String({
					description:
						"Replace the frozen original task from this file's contents (promotions only, mode prompt). Mutually exclusive with task.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const result = await commandPost(ctx.modelRegistry).send({
				jobId: params.job_id,
				message: params.message,
				...(params.mode ? { mode: params.mode as "auto" | "prompt" | "steer" | "follow_up" } : {}),
				...(params.model ? { model: params.model } : {}),
				...(params.task ? { task: params.task } : {}),
				...(params.task_file ? { taskFile: params.task_file } : {}),
			});
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				// SAFETY: send returns a plain structured payload; tool details accepts its fields as unknown values.
				details: result as unknown as Record<string, unknown>,
			};
		},
	});

	// Revival (cp-8km): relaunch (never "reattach") a fresh child on a dead
	// job's own session file, worktree, lease and model. Explicit and never
	// automatic (Constraint 1) — without `confirm` this only returns the plan
	// (or a refusal), so the operator sees the interrupted tool call and the
	// worktree state BEFORE anything spawns (Constraint 9). A worker must never
	// hold this tool (WORKER_FORBIDDEN_TOOLS): reviving a sibling job's dead
	// process is an operator decision, not a recursion a worker should have.
	pi.registerTool({
		name: "cp_revive",
		label: "Revive",
		description:
			"Relaunch a dead job's worker on its own session file, worktree and model — never a fresh worker, never a " +
			"brief. Without `confirm`, only plans: returns the interrupted tool call (if any) and refuses on a live pid, " +
			"a missing session, or a hazardous worktree (an in-progress rebase/merge/cherry-pick, a detached HEAD, or " +
			"uncommitted changes). Call it once to see the plan, then again with confirm:true to actually relaunch. " +
			"The revived worker lands idle; nothing is sent as part of revival. A failed (non-script) job is continued on its " +
			"original session, worktree and lease only with continue_failed:true; the failure is cleared only once the relaunch " +
			"is recorded, and an accepted envelope is superseded by the next cp_send, never overwritten.",
		promptSnippet: "Revive a dead job's worker from its session file (cp_revive)",
		promptGuidelines: [
			"Call cp_revive without confirm first and show the operator the plan (especially any interrupted tool call) before ever setting confirm:true.",
			"A revived worker believes its last tool call produced no result, whether or not it actually completed — say so.",
			"cp_revive refusing on a hazardous worktree (rebase/merge/cherry-pick in progress, detached HEAD, dirty tree) is the correct outcome: the operator must resolve it by hand first.",
			"A failed job is continued with cp_revive continue_failed:true (plan, then confirm), then cp_send — never a takeover job, a new branch or a force push.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The held or waiting (or, with continue_failed, failed) job to revive" }),
			continue_failed: Type.Optional(
				Type.Boolean({
					description:
						"Continue a failed non-script job on its original session, worktree and lease (operator continuation, " +
						"distinct from bounded recovery; its attempt counter is not reset).",
				}),
			),
			confirm: Type.Optional(
				Type.Boolean({
					description:
						"Actually relaunch the worker. Without this, cp_revive only returns the plan or refusal — always call it " +
						"once first and show the operator what would happen.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const reviver = commandPost(ctx.modelRegistry).reviver();
			const options = params.continue_failed ? { continueFailed: true } : {};
			const plan = await reviver.plan(params.job_id, options);
			if (!plan.ok || !params.confirm) {
				return {
					content: [{ type: "text", text: formatRevivePlan(plan) }],
					// SAFETY: RevivePlanResult is a plain JSON-serializable object; details only needs a record shape.
					details: plan as unknown as Record<string, unknown>,
				};
			}
			const result = await reviver.revive(params.job_id, options);
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatReviveResult(result) }],
				// SAFETY: ReviveResult is a plain JSON-serializable object; details only needs a record shape.
				details: result as unknown as Record<string, unknown>,
			};
		},
	});

	// The status block (cp-8aj). Everything derivable from disk — job id,
	// phase, worker/model, repo, age, tokens, cost, and a Shipped row once a PR
	// receipt exists — is read from the SAME snapshot /status and /watch already
	// read (status.ts#assembleStatus); this tool never opens a second path to
	// that data. What it cannot derive is the judgment: plain-language labels
	// (falls back to the br title), why a job is Blocked, and the whole of
	// Awaiting you (type, decision, why it matters, what it blocks — none of
	// that exists in any file). The rendered text is returned as the tool's own
	// result, exactly like every other cp_* tool here: pi's transcript already
	// shows a tool call's result to the operator, so this needs no extra
	// `pi.sendMessage` and, critically, does not force another model turn the
	// way a context-participating custom message would.
	pi.registerTool({
		name: "cp_status_block",
		label: "Status block",
		description:
			"Render the STATUS BLOCK (AGENTS.md \u00a7Status block) from disk facts merged with your " +
			"judgment. It is opt-in \u2014 call it when a status summary is asked for or useful, not on every turn \u2014 and always instead of hand-typing the four markdown tables. In progress and Shipped are " +
			"assembled from the same run projection /status and /watch read; you supply labels (falls back to the " +
			"br title), blocked reasons, and the Awaiting you rows, which exist in no file. A merge-approval row is gated on " +
			"CI for that branch's current head (cp-gmy): it is deferred while CI runs, refused while CI is red, and raised " +
			"by the extension itself the moment CI completes green on that head or a cp_review passes on it — no call to this " +
			"tool is needed for that, and the tool prints why a row is still deferred under the table. " +
			"A row the awaiting store will not store (type authorization, or prose that reads like an authorization request) " +
			"is never rendered as an open question: it prints under the table as refused, with the reason and the fix.",
		promptSnippet: "Render a STATUS BLOCK only when one is asked for or useful, via cp_status_block, never a hand-typed table (cp_status_block)",
		promptGuidelines: [
			"cp_status_block is opt-in: ordinary turns do not call it (the status line already shows the fleet); call it once when the operator asks for a status summary or a turn needs the full picture, instead of typing STATUS BLOCK tables by hand.",
			"A row deferred on CI or on a missing review raises itself: the extension re-gates every deferred row when CI completes on the held head (the cp-ci watch) and when a cp_review passes on it, so no render is needed to release one.",
			"A row deferred on an unknown CI state may become readable with no event at all: invoke cp_status_block manually when you think observability came back \u2014 the render re-gates the row, and never bypasses the gate.",
			"Only supply a label when the br title would not read plainly to the operator; an omitted label falls back to the title.",
			"Awaiting you is the one table this tool cannot derive: give type (approval|design|authorization|escalation), decision, why and blocks for every open human decision. Open escalations are merged from the store.",
			"Blocked rows name a real dependency, CI check, gate or worker — never a human decision; a human decision belongs in awaiting instead.",
			"Pass a merge-approval row whenever you want one: the tool checks CI for that branch's current head itself and defers the ask until it has finished, so you never have to time the question.",
			"Never pass type:authorization here — only a checkpoint authorizes; such a row is refused, printed under the table and never answerable via /cp-decide.",
			"Word an awaiting decision as a plain choice ('Ship cp-x, drop it, or open a follow-up?'); wording like 'authorize', 'approve' or 'may I proceed' is refused as authorization-shaped.",
		],
		parameters: Type.Object({
			labels: Type.Optional(
				Type.Array(
					Type.Object({
						job_id: Type.String({ description: "The job this label names" }),
						label: Type.String({ maxLength: MAX_LABEL_CHARS, description: "Plain-language label; bounded so one long label cannot blow up the layout" }),
					}),
					{ description: "Per-job human labels; a job without one falls back to its br title, then its bare id" },
				),
			),
			blocked: Type.Optional(
				Type.Array(
					Type.Object({
						job_id: Type.String({ description: "The blocked job" }),
						waiting_on: Type.String({ maxLength: MAX_CELL_CHARS, description: "A dependency, CI check, gate or worker — never a human decision" }),
					}),
					{ description: "Jobs blocked on something that is not a human decision" },
				),
			),
			awaiting: Type.Optional(
				Type.Array(
					Type.Object({
						type: StringEnum(["approval", "design", "authorization", "escalation"]),
						decision: Type.String({ maxLength: MAX_CELL_CHARS, description: "The decision needed" }),
						why: Type.String({ maxLength: MAX_CELL_CHARS, description: "Why it matters" }),
						blocks: Type.String({ maxLength: MAX_CELL_CHARS, description: "What it blocks" }),
						job_id: Type.Optional(Type.String({ description: "The job this decision is about, if any" })),
					}),
					{ description: "Open human decisions; the table this tool cannot derive from any file" },
				),
			),
			width: Type.Optional(
				Type.Integer({ minimum: 20, maximum: 200, description: `Rendering width; default ${STATUS_BLOCK_DEFAULT_WIDTH}. A narrow terminal degrades labels first and never drops a PR url.` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			// include: "all" so a job that shipped this turn (phase done) is still
			// visible for Shipped; "in progress" filters back to the active phases
			// itself, so this is still one query, not a second source.
			const snapshot = await post.status({ include: "all" });
			const warn = (message: string): void => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			};
			// cp-gmy: promote every deferred merge ask whose CI has since finished,
			// BEFORE anything is rendered. A deferral costs the operator nothing and
			// needs no action from them: the row comes back by itself.
			let promoted: AwaitingItem[] = [];
			// cp-to39: rows whose job is gone are neither raised nor dropped — they get
			// their own notice line, because "CI unfinished" would be a lie about them.
			let orphanedIds: ReadonlySet<string> = new Set<string>();
			// cp-p1sh: rows whose merge already happened are closed by the review, so
			// they are not in list("deferred") any more. Report them once, here, instead
			// of raising an ask for a merge that has a commit.
			const resolvedRows: StatusBlockMergeAskInput[] = [];
			try {
				const review = await post.awaiting.reviewDeferred();
				promoted = review.raised;
				orphanedIds = new Set(review.orphaned.map((item) => item.id));
				resolvedRows.push(...resolvedMergeAskRows(review.resolved, review.verdicts));
			} catch (error) {
				warn(`Warning: deferred merge asks not reviewed: ${(error as Error).message}`);
			}
			// Upsert the awaiting rows passed by the caller to state/awaiting.json so
			// the marker count and /cp-decide list agree. cp-nz95: the store decides
			// what may be rendered as open — a refused row (authorization, or
			// authorization-shaped prose) and a deferred one are notices under the
			// table, never questions in it, because the operator can answer neither.
			const supplied = (params.awaiting ?? []) as StatusBlockAwaitingInput[];
			const resolved = await resolveAwaitingRows(supplied, post.awaiting, snapshot.jobs);
			const rendered: StatusBlockAwaitingInput[] = resolved.rendered;
			const mergeAsks: StatusBlockMergeAskInput[] = [...resolvedRows, ...resolved.mergeAsks];
			const refused: StatusBlockRefusedInput[] = resolved.refused;
			for (const row of refused) warn(`Awaiting row refused, not stored: ${row.reason}`);
			// A merge ask raised by this turn's review that the model did not mention
			// is folded in anyway: the deferral must resurface without depending on
			// the parent remembering it.
			for (const item of post.escalations.open()) {
				if (rendered.some((row) => row.id === item.id)) continue;
				rendered.push({
					type: "escalation",
					decision: item.question.slice(0, MAX_CELL_CHARS),
					why: item.kind,
					blocks: item.job_ids.join(", ").slice(0, MAX_CELL_CHARS),
					id: item.id,
					job_id: item.job_ids[0],
				});
			}
			for (const item of awaitingRowsNotSupplied(
				supplied.map((row) => ({ type: row.type as "approval" | "design", decision: row.decision, ...(row.job_id ? { job_id: row.job_id } : {}) })),
				promoted,
			)) {
				rendered.push({
					type: item.type,
					decision: item.decision,
					why: item.why,
					blocks: item.blocks,
					id: item.id,
					...(item.job_id ? { job_id: item.job_id } : {}),
				});
			}
			// Every still-deferred row, including ones deferred on an earlier turn.
			for (const item of post.awaiting.list("deferred")) {
				if (mergeAsks.some((row) => row.id === item.id)) continue;
				mergeAsks.push({
					kind: orphanedIds.has(item.id) ? "job_gone" : "deferred",
					decision: item.decision,
					reason: item.deferred_reason ?? "CI has not finished for this head",
					id: item.id,
					...(item.job_id ? { job_id: item.job_id } : {}),
				});
			}
			// cp-b5eg: read the Shipped memory from disk, render, write it back. The
			// session id is the key, so a reload (a new extension instance, same
			// session) still sees what the previous instance reported.
			const dependencies = blockedJobs(post.ledger(), post.mandates.list(), isoTimestamp(), undefined, post.mandates.scheduleMandates());
			const blocked = [
				...dependencies.map(({ job, waiting_on }) => ({ job_id: job.id, waiting_on })),
				...(params.blocked ?? []).filter((row) => !dependencies.some(({ job }) => job.id === row.job_id)),
			];
			const result = renderSessionStatusBlock({
				store: post.shippedSeen,
				sessionId: ctx.sessionManager.getSessionId(),
				snapshot,
				input: {
					...(params.labels ? { labels: params.labels } : {}),
					blocked,
					awaiting: rendered,
					...(mergeAsks.length > 0 ? { mergeAsks } : {}),
					...(refused.length > 0 ? { refused } : {}),
				},
				...(params.width ? { width: params.width } : {}),
			});
			// A memory that could not be read or written is said out loud: losing it
			// silently is precisely the defect this replaced.
			for (const warning of result.warnings) warn(`Warning: ${warning}`);
			return {
				content: [{ type: "text", text: result.text }],
				// SAFETY: these named fields form the plain JSON payload returned by the status tool.
				details: { text: result.text, shipped_ids: result.shippedIds, refused } as unknown as Record<string, unknown>,
			};
		},
	});
}
