/**
 * cp_awaiting, cp_pipeline, cp_gate and cp_review.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveHome } from "../../src/home.ts";
import { resolveProjectArg } from "../../src/mode.ts";
import { type JobKind, JOB_KINDS, RISK_CRITERIA, RISKS, SCOPE_CRITERIA, SCOPES } from "../../src/contracts.ts";
import { diffReviewStatusOf, formatDiffReviewStatus, formatReviewWait, isDiffReviewWait } from "../../src/diff-review.ts";
import { classifyIntake, formatAdvance } from "../../src/pipeline.ts";
import { formatDispatchResult } from "../../src/dispatch.ts";
import { formatGate, formatGateStatus, formatGateWait, isGateWait } from "../../src/gate.ts";
import { ReviewRuns } from "../../src/review-runs.ts";
import { currentRuntime, diffReviewToolPayload, awaitingListText } from "./helpers.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerReviewTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, refreshWidget } = deps;

	// The read/withdraw half of Awaiting-you, as a tool (cp-av8). Deliberately NOT
	// a dialog and NOT an approve/decline surface: answering is /cp-decide only,
	// never a tool a model can call. `withdraw` refuses an authorization item —
	// that record belongs to CheckpointStore alone.
	pi.registerTool({
		name: "cp_awaiting",
		label: "Awaiting you",
		description:
			"List or withdraw Awaiting-you items. `list` merges pending checkpoints (authorization), held research " +
			"with no PR (approval) and declared rows. Answering is cp_decide (mandate or operator quote), not this tool.",
		promptSnippet: "List or withdraw Awaiting-you items — answering is cp_decide (cp_awaiting)",
		promptGuidelines: [
			"cp_awaiting has no approve/decline action; call cp_decide with a mandate or operator quote to resolve a row.",
			"Withdraw only a declared item you no longer need answered — an authorization item cannot be withdrawn here.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "withdraw"]),
			id: Type.Optional(Type.String({ description: "withdraw: the item id (from a prior list)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const post = commandPost(ctx.modelRegistry);
			if (params.action === "list") {
				const { text, items, deferred } = await awaitingListText(post);
				return { content: [{ type: "text", text }], details: { items, deferred } as unknown as Record<string, unknown> };
			}
			if (!params.id) throw new Error("cp_awaiting withdraw needs an id");
			if (params.id.startsWith("aw-checkpoint-")) {
				throw new Error(
					`${params.id} is a derived authorization item, not declared \u2014 it cannot be withdrawn here. ` +
						"An authorization resolves only through cp_decide.",
				);
			}
			if (params.id.startsWith("aw-research-")) {
				throw new Error(
					`${params.id} is a derived approval item from a held research job, not declared \u2014 it cannot be withdrawn here. ` +
						"It will clear when the research job is answered (ship, drop, or follow-up) via cp_decide.",
				);
			}

			const withdrawn = await post.awaiting.withdraw(params.id);
			return {
				content: [{ type: "text", text: `withdrawn: ${withdrawn.id}` }],
				details: withdrawn as unknown as Record<string, unknown>,
			};
		},
	});

	pi.registerTool({
		name: "cp_pipeline",
		label: "Pipeline",
		description:
			"Run the research -> gate -> checkpoint -> implement pipeline. " +
			"classify: recommend single vs pipeline vs qa for a task, with reasons (qa means it is a question: use cp_ask). " +
			"start: create the two br issues (dep-linked) and dispatch the planner. " +
			"advance: take the next step from what is on disk (gate, close, authorization, implementer dispatch). " +
			"recover: re-dispatch a failed implementer from the same task file. " +
			"reanchor: point a pipeline at a replacement research job (a superseded plan can never reach an implementer; " +
			"the replacement is re-gated from scratch). " +
			"classify decides a workflow (how many workers, and whether a plan comes first); scope/risk decide resources " +
			"(which model and effort). They are separate choices: a high-risk task is not automatically a pipeline. " +
			"The artifact is handed over as a file; it never enters this session.",
		promptSnippet: "Run or advance a research->gate->implement pipeline (cp_pipeline)",
		promptGuidelines: [
			"Use cp_pipeline advance after a research envelope lands; it gates, closes and dispatches for you.",
			"cp_pipeline never dispatches an implementer without valid authority: a human answer through cp_decide, or an active mandate that permits the job. next 'authorize' means it stayed pending — ask the operator.",
			"classify is advisory: it recommends a workflow with reasons, and you may force it. It is not a routing decision — scope and risk choose the model, and a high-risk keyword is not a reason to build a pipeline.",
			"Pass kind when the operator already settled it: kind:research classifies as one research job, never a pipeline.",
		],
		parameters: Type.Object({
			action: StringEnum(["classify", "start", "advance", "recover", "reanchor"]),
			research_id: Type.Optional(
				Type.String({ description: "advance/recover/reanchor: the research job that owns the pipeline (reanchor: the superseded one)" }),
			),
			replacement_research_id: Type.Optional(
				Type.String({ description: "reanchor: the replacement research job to point the pipeline at" }),
			),
			title: Type.Optional(Type.String({ description: "start: the shared title of the two issues" })),
			project: Type.Optional(Type.String({ description: "start: registered project name" })),
			task: Type.Optional(Type.String({ description: "classify/start: the task text" })),
			delivery: Type.Optional(StringEnum(["pr", "local"], { description: "start: delivery of the ship job" })),
			kind: Type.Optional(
				StringEnum([...JOB_KINDS], {
					description:
						"classify: the job kind, when the operator has already settled it. kind:research is one research job, " +
						"never a pipeline; kind:ship is never a question. Leave it absent to let the task's own words decide.",
				}),
			),
			scope: Type.Optional(StringEnum([...SCOPES], { description: SCOPE_CRITERIA })),
			risk: Type.Optional(StringEnum([...RISKS], { description: RISK_CRITERIA })),
			model: Type.Optional(Type.String({ description: "start: planner model override" })),
			wall_clock_seconds: Type.Optional(Type.Integer({
				minimum: 1, description: "start: wall-clock bound in seconds for both planner and implementer; home/env defaults when omitted",
			})),
			force: Type.Optional(StringEnum(["single", "pipeline", "qa"], { description: "classify: caller decides" })),
			quality: Type.Optional(
				Type.Object(
					{
						verify: Type.Optional(Type.Boolean({ description: "N cheap voters on the artifact before the gate" })),
						completeness: Type.Optional(Type.Boolean({ description: "one pass: does the artifact cover the task?" })),
						voters: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
						threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
						model: Type.Optional(Type.String({ description: "cheap model for the panel" })),
					},
					{
						additionalProperties: false,
						description: "start: per-job opt-in for the pre-gate quality pass. Off unless asked for.",
					},
				),
			),
			review: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(Type.Boolean({ description: "gate `done` on a diff review of the pushed branch" })),
						model: Type.Optional(Type.String({ description: "reviewer model override; routing decides when absent" })),
					},
					{
						additionalProperties: false,
						description:
							"start: per-job opt-in for the post-implementation diff review. Off unless asked for; when on, the " +
							"pipeline does not reach done until a review of the branch's current head resolves.",
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const runner = commandPost(ctx.modelRegistry).pipeline();
			if (params.action === "classify") {
				if (!params.task) throw new Error("cp_pipeline classify needs `task`");
				const classification = classifyIntake({
					task: params.task,
					// routing T6: `ClassifyInput` has always had `kind` and the tool never
					// offered it, so a parent that already knew "this is research" could
					// not say so and got the keyword answer instead — "investigate the
					// flake" reads as a pipeline until you know it is one research job.
					...(params.kind ? { kind: params.kind as JobKind } : {}),
					...(params.scope ? { scope: params.scope as "S" | "M" | "L" } : {}),
					...(params.risk ? { risk: params.risk as "low" | "high" } : {}),
					...(params.force ? { force: params.force as "single" | "pipeline" | "qa" } : {}),
				});
				return {
					content: [{ type: "text", text: JSON.stringify(classification) }],
					details: classification as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "start") {
				if (!params.title || !params.task) {
					throw new Error("cp_pipeline start needs `title` and `task`");
				}
				const result = await runner.start({
					title: params.title,
					project: resolveProjectArg(currentRuntime(), params.project, "cp_pipeline start"),
					task: params.task,
					...(params.delivery ? { delivery: params.delivery as "pr" | "local" } : {}),
					...(params.scope ? { scope: params.scope as "S" | "M" | "L" } : {}),
					...(params.risk ? { risk: params.risk as "low" | "high" } : {}),
					...(params.model ? { model: params.model } : {}),
					...(params.wall_clock_seconds !== undefined ? { wallClockSeconds: params.wall_clock_seconds } : {}),
					...(params.quality ? { quality: params.quality } : {}),
					...(params.review ? { review: params.review } : {}),
				});
				refreshWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `${result.research_id} (research) -> ${result.ship_id} (ship, blocked)\n${formatDispatchResult(result.dispatch)}`,
						},
					],
					details: result as unknown as Record<string, unknown>,
				};
			}
			if (!params.research_id) throw new Error(`cp_pipeline ${params.action} needs \`research_id\``);
			if (params.action === "reanchor") {
				if (!params.replacement_research_id) {
					throw new Error("cp_pipeline reanchor needs `replacement_research_id`");
				}
				const record = await runner.reanchor(params.research_id, params.replacement_research_id);
				refreshWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `${params.research_id} superseded by ${record.research_id} — ${record.ship_id} now points at ${record.research_id}. Advance ${record.research_id} to re-gate.`,
						},
					],
					details: record as unknown as Record<string, unknown>,
				};
			}
			const result =
				params.action === "advance"
					? await runner.advance(params.research_id)
					: await runner.recoverShip(params.research_id);
			refreshWidget(ctx);
			const payload = {
				content: [{ type: "text" as const, text: formatAdvance(result) }],
				details: result as unknown as Record<string, unknown>,
			};
			if (result.pending) {
				// D7 for the pipeline path: advance started the reviewer, so advance
				// hands back. A key this process does not hold is a no-op.
				commandPost().reviewRuns.handBack(
					ReviewRuns.key(
						result.pending.surface === "review" ? result.ship_id : result.research_id,
						result.pending.surface,
						result.pending.attempt,
					),
				);
			}
			return payload;
		},
	});

	pi.registerTool({
		name: "cp_gate",
		label: "Gate",
		description:
			"Review a research artifact with a fresh-context gate-reviewer worker and apply gate policy. " +
			"Returns {next: wait, attempt, deadline} the moment the reviewer is spawned; the verdict arrives as a " +
			"cp-verdict wake-up. Returns the decision directly only when this attempt is already decided on disk: " +
			"{verdict, cause, flags, reasons, revisions?, next}, where next is proceed (pass), revise (sent to the " +
			"live planner), retry (operational: re-run, a different model is chosen) or surface (stop and tell the " +
			"operator). One revise per artifact is enforced here, not by you. Never reads the artifact into this session.",
		promptSnippet: "Gate a research artifact and get a verdict with a cause (cp_gate)",
		promptGuidelines: [
			"Use cp_gate after a research envelope lands, before any implementation is dispatched.",
			"Branch on cp_gate's cause field, never on the reason prose; a pass is quality, never authorization to ship.",
			"next: wait means end the turn; never call cp_gate status to wait for a verdict.",
			"cp_gate without `action` spawns a NEW reviewer attempt (spend). To read a recorded or pending verdict call it with action: status.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The research job whose artifact is reviewed" }),
			action: Type.Optional(
				StringEnum(["start", "status", "replace_planner"], {
					description:
						"start (default): spawn a NEW reviewer attempt (spend) and return wait, or the decision if this attempt is already decided. status: read pending and decided attempts. replace_planner: prepare a fresh research job with the old plan and gate feedback after planner teardown; dispatch separately using the returned task_file.",
				}),
			),
			replacement_job_id: Type.Optional(Type.String({ description: "replace_planner: a fresh research job in the same project and delivery; prepares a task_file for normal cp_dispatch" })),
			model: Type.Optional(Type.String({ description: "Explicit reviewer model override (provider/model-id)" })),
			deliver_revise: Type.Optional(
				Type.Boolean({ description: "Promote a revise verdict to the live planner. Default true." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			if (params.action === "status") {
				const status = post.gateModule().status(params.job_id);
				return {
					content: [{ type: "text" as const, text: formatGateStatus(params.job_id, status) }],
					details: status as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "replace_planner") {
				if (!params.replacement_job_id) throw new Error("cp_gate replace_planner needs replacement_job_id");
				const result = await post.replacePlanner(params.job_id, params.replacement_job_id);
				return {
					content: [{ type: "text" as const, text: `Replacement planner ${result.replacement_job_id} prepared. Dispatch it with task_file: ${result.task_file}. For a pipeline, cp_pipeline reanchor to this replacement before advancing it. The original job stays closed.` }],
					details: result,
				};
			}
			const result = await post.gate({
				jobId: params.job_id,
				...(params.model ? { model: params.model } : {}),
				...(params.deliver_revise === undefined ? {} : { deliverRevise: params.deliver_revise }),
			});
			refreshWidget(ctx);
			if (isGateWait(result)) {
				const payload = {
					content: [{ type: "text" as const, text: formatGateWait(result) }],
					details: result as unknown as Record<string, unknown>,
				};
				// D7: the parent holds this result before the verdict may wake it.
				post.reviewRuns.handBack(result.key);
				return payload;
			}
			return {
				content: [{ type: "text", text: formatGate(result) }],
				details: result as unknown as Record<string, unknown>,
			};
		},
	});

	pi.registerTool({
		name: "cp_review",
		label: "Diff review",
		description:
			"Review the diff a pushed ship branch actually introduces, with a fresh-context reviewer, and apply the same " +
			"policy ladder cp_gate uses. This is not cp_gate with a flag: cp_gate reviews a research plan before any code " +
			"exists, cp_review reviews code that is already on origin, and firing the wrong one at the wrong stage reviews " +
			"nothing. Always callable for a kind:ship job whose branch is pushed — a pipeline is not required — and every " +
			"kind:ship delivery:pr job gets one after its PR exists, not just the risky-looking ones — one passing review per " +
			"pushed head, so a head that already passed is never reviewed again. Returns " +
			"{verdict, cause, flags, reasons, revisions?, next} plus the head sha and file count it reviewed: next is " +
			"proceed (pass), revise (sent to the live implementer for one more commit on the same branch, never a second " +
			"PR), retry (operational: re-run, a different model is chosen) or surface (stop and tell the operator). On " +
			"revise, run cp_review on the same branch again once the implementer's fix is pushed, and keep going until a " +
			"review comes back with no unfixed findings (pass) or it surfaces: the cap is 5 reviews per branch " +
			"(REVIEW_MAX_ATTEMPTS), the 5th never asks for another revision, and a 6th is refused — all enforced here, not " +
			"by you. Never reads the diff into this session: the verdict is the interface, and no diff text is returned, ever.",
		promptSnippet: "Review a pushed ship branch's diff and get a verdict with a cause (cp_review)",
		promptGuidelines: [
			"Use cp_review on a kind:ship job whose branch is on origin; use cp_gate for a research artifact — they are separate tools on purpose and neither reviews the other's subject.",
			"Run cp_review on every kind:ship delivery:pr job once its PR exists and the head sha is on origin — the standing rule, not an opt-in. One pass per pushed head: before cp_integrate, review only if that head has no passing verdict yet, and never re-review an unchanged head. delivery:local and delivery:answer have no PR and get no review.",
			"Branch on cp_review's cause field, never on the reason prose; a pass is evidence about the diff, never authorization to merge.",
			"A revise is not the end of the review loop: re-run cp_review on the same branch after the implementer pushes the fix, until pass or surface (5 reviews per branch, enforced by the tool).",
			"next: wait means end the turn; the verdict arrives as a cp-verdict wake-up. Never call cp_review status to wait for it.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The ship job whose pushed branch is reviewed" }),
			action: Type.Optional(
				StringEnum(["start", "status"], {
					description:
						"start (default): spawn the reviewer and return wait, or the decision if this attempt is already decided. status: what is pending and decided, changing nothing.",
				}),
			),
			model: Type.Optional(Type.String({ description: "Explicit reviewer model override (provider/model-id)" })),
			deliver_revise: Type.Optional(
				Type.Boolean({ description: "Promote a revise verdict to the live implementer. Default true." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			// No pipeline lookup here, deliberately (design Constraints §1): the
			// preconditions are the dispatch record, kind:ship and origin/<branch>,
			// and `DiffReview` owns all three. A missing pipeline record removes the
			// automation, never the reachability.
			const post = commandPost(ctx.modelRegistry);
			if (params.action === "status") {
				const status = diffReviewStatusOf(
					resolveHome(),
					params.job_id,
					post.reviewRuns.pending(params.job_id, "review"),
				);
				return {
					content: [{ type: "text" as const, text: formatDiffReviewStatus(params.job_id, status) }],
					details: status as unknown as Record<string, unknown>,
				};
			}
			const result = await post.diffReview({
				jobId: params.job_id,
				...(params.model ? { model: params.model } : {}),
				...(params.deliver_revise === undefined ? {} : { deliverRevise: params.deliver_revise }),
			});
			refreshWidget(ctx);
			if (isDiffReviewWait(result)) {
				const payload = {
					content: [{ type: "text" as const, text: formatReviewWait(result) }],
					details: result as unknown as Record<string, unknown>,
				};
				post.reviewRuns.handBack(result.key);
				return payload;
			}
			return diffReviewToolPayload(result);
		},
	});
}
