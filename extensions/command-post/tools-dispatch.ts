/**
 * cp_ask, cp_dispatch and cp_check.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveProjectArg } from "../../src/mode.ts";
import { type QueuedDispatchRequest, RISK_CRITERIA, RISKS, SCOPE_CRITERIA, SCOPES, type ThinkingLevel, THINKING_LEVELS } from "../../src/contracts.ts";
import { formatDispatchPreview, formatDispatchResult } from "../../src/dispatch.ts";
import { SpawnSafetyError } from "../../src/worker-manager.ts";
import { formatPreflight } from "../../src/preflight.ts";
import { TrackerStore } from "../../src/trackers/config.ts";
import { autoLink } from "../../src/trackers/link.ts";
import { currentRuntime } from "./helpers.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerDispatchTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, refreshWidget, askQuestion } = deps;
	/**
	 * cp-u3o4: the Q&A path as a tool, for a question the operator asked in chat.
	 *
	 * It is `cp_dispatch` with the decision already made — one br issue
	 * (`kind:research`, `delivery:answer`), a read-only worker, scope S — and it
	 * returns the **dispatch record**. The answer never comes back through this
	 * tool: it lands as a card in the operator's transcript, which is the whole
	 * point. The parent still never reads it.
	 */
	pi.registerTool({
		name: "cp_ask",
		label: "Ask",
		description:
			"Ask a small question about a registered project: creates one br issue (kind:research, delivery:answer) and " +
			"dispatches a read-only worker to answer it. Returns the dispatch record as JSON — the answer itself lands as " +
			"a card in the operator's transcript and never enters this session. Use it when the deliverable is an answer a " +
			"human reads once; if the deliverable is a plan an implementer acts on, that is kind:research, and if it is a " +
			"change, that is kind:ship.",
		promptSnippet: "Ask a small question about a project and get an answer card (cp_ask)",
		promptGuidelines: [
			"Use cp_ask when the operator asks a small factual question about an onboarded project: a worker looks, and the answer is shown to the operator directly.",
			"If the honest deliverable is a plan or a change, do not use cp_ask: dispatch kind:research or kind:ship instead.",
			"Never answer a question about project source from your own memory — you never read that source, and a worker is the only thing that looks.",
			"Escalating from an answer to action is a new job, never a promote of the Q&A worker.",
		],
		parameters: Type.Object({
			project: Type.Optional(
				Type.String({ description: "Registered project name" }),
			),
			question: Type.String({ description: "The question, as the operator asked it. It becomes the br title and the worker's task." }),
			model: Type.Optional(Type.String({ description: "Explicit provider/model-id override" })),
			thinking: Type.Optional(StringEnum([...THINKING_LEVELS], { description: "Explicit effort override" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const result = await askQuestion({
				...(params.project ? { project: params.project } : {}),
				question: params.question,
				...(params.model ? { model: params.model } : {}),
				...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
				registry: ctx.modelRegistry,
			});
			refreshWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text: `${result.job_id} (kind:research, delivery:answer) — the answer will be shown to the operator as a card; you will get the headline only.\n${formatDispatchResult(result.dispatch)}`,
					},
				],
				details: { job_id: result.job_id, dispatch: { ...result.dispatch } },
			};
		},
	});

	pi.registerTool({
		name: "cp_dispatch",
		label: "Dispatch",
		description:
			"Dispatch a declared script or a br job to a fresh worker: preflight, mandate, lease and branch. " +
			"Returns the dispatch record as JSON. Refuses (with a promote instruction) when the job or its " +
			"worktree already has a live worker. `scope` and `risk` are the resource-routing inputs (see their own " +
			"descriptions); they are independent of the workflow choice cp_pipeline classify advises on, and each " +
			"overrides only its own axis. dry_run previews the route without taking anything.",
		promptSnippet: "Dispatch a br job to a worker (cp_dispatch)",
		promptGuidelines: [
			"Use cp_dispatch to start work on a br job; never do the job yourself.",
			"cp_dispatch returning state:promote means send the existing worker a new brief instead of dispatching.",
			"cp_dispatch with dry_run:true answers 'which model and effort would this job get, and why' and takes nothing. It is optional — never a required step before a dispatch — and it reserves nothing: the dispatch recomputes from the live config. Reach for it when a job is uncertain or expensive, not as a habit.",
			"Leave scope or risk absent when you do not know it: the axis is then assessed from the task's own words and recorded as inferred or defaulted. Never invent S/low to fill the schema, and never dispatch an extra worker just to classify a task.",
			"cp_dispatch returning state:queued means the spawn cap was full: the job starts by itself when a slot frees and a QUEUED DISPATCH STARTED/DROPPED wake-up reports it. Never re-dispatch a queued job.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The job id; it is also the branch and the run directory" }),
			task: Type.Optional(Type.String({ description: "The task text substituted into the worker's brief" })),
			task_file: Type.Optional(
				Type.String({
					description:
						"A file whose contents become the task (e.g. a research artifact exported with cp_artifact get). " +
						"Read in code, so its body never enters this session. Use instead of task, never with it.",
				}),
			),
			scope: Type.Optional(StringEnum([...SCOPES], { description: SCOPE_CRITERIA })),
			risk: Type.Optional(StringEnum([...RISKS], { description: RISK_CRITERIA })),
			model: Type.Optional(Type.String({ description: "Explicit provider/model-id override" })),
			thinking: Type.Optional(
				StringEnum([...THINKING_LEVELS], {
					description:
						"Explicit effort override, usable with or without model. Wins over the rubric row's level and the " +
						"profile's; a level the model cannot serve is refused before anything is leased, never substituted.",
				}),
			),
			profile: Type.Optional(Type.String({ description: "Worker profile; defaults to the job's kind" })),
			base: Type.Optional(Type.String({ description: "Base branch; defaults to origin/HEAD" })),
			wall_clock_seconds: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Per-job wall-clock cap since spawn; home/env default otherwise",
				}),
			),
			tool_call_cap: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Per-job tool-start cap; home/env default otherwise",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({
					description:
						"Preview the route instead of dispatching: the same task loading, profile selection, input " +
						"assessment and model resolution, returning effective inputs and provenance, source/rule, " +
						"model/effort and what the probe knows about the model. Takes nothing — no lease, no branch, no " +
						"worker, no fleet/ledger/routing write, no auth refresh — and returns no task-file body. Dispatch " +
						"recomputes from the live config, so a preview reserves nothing and authorizes nothing.",
				}),
			),
			queue: Type.Optional(
				Type.Boolean({
					description:
						"Default true: a dispatch refused only by the spawn cap is queued (state/dispatch-queue.json) and started, fully re-gated, " +
						"when a worker slot frees. false keeps the plain refusal. Script jobs are never queued.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			if (params.dry_run === true) {
				// No `refreshWidget`: preview changes no fleet state.
				const preview = await commandPost(ctx.modelRegistry).previewDispatch({
					jobId: params.job_id,
					...(params.task === undefined ? {} : { task: params.task }),
					...(params.task_file === undefined ? {} : { taskFile: params.task_file }),
					...(params.scope ? { scope: params.scope as "S" | "M" | "L" } : {}),
					...(params.risk ? { risk: params.risk as "low" | "high" } : {}),
					...(params.model ? { model: params.model } : {}),
					...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
					...(params.profile ? { profile: params.profile } : {}),
					...(params.base ? { base: params.base } : {}),
					...(params.wall_clock_seconds !== undefined ? { wallClockSeconds: params.wall_clock_seconds } : {}),
					...(params.tool_call_cap !== undefined ? { toolCallCap: params.tool_call_cap } : {}),
				});
				return {
					content: [{ type: "text", text: formatDispatchPreview(preview) }],
					details: { ...preview },
				};
			}
			const post = commandPost(ctx.modelRegistry);
			// laf: link before dispatching (the job exists either way); a tracker problem never refuses a dispatch.
			let trackerLine: string | undefined;
			try {
				const job = await post.ledger().show(params.job_id);
				if (job.external_ref && !job.tracker) trackerLine = await autoLink(post.ledger(), job, new TrackerStore({ home: post.home, registry: post.registry }).list());
			} catch (error) {
				trackerLine = `not linked to a tracker bead: ${(error as Error).message.split("\n")[0]}`;
			}
			// 4b-2: a queued job starts when a slot frees; a second dispatch would race it.
			const queuedAt = post.dispatchQueue.position(params.job_id);
			if (queuedAt !== undefined) throw new Error(`${params.job_id} is already queued at position ${queuedAt} — it starts when a worker slot frees; the outcome arrives as a wake-up. Do not re-dispatch.`);
			let result: Awaited<ReturnType<typeof post.dispatch>>;
			try {
				result = await post.dispatch({
					jobId: params.job_id,
					...(params.task === undefined ? {} : { task: params.task }),
					...(params.task_file === undefined ? {} : { taskFile: params.task_file }),
					...(params.scope ? { scope: params.scope as "S" | "M" | "L" } : {}),
					...(params.risk ? { risk: params.risk as "low" | "high" } : {}),
					...(params.model ? { model: params.model } : {}),
					...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
					...(params.profile ? { profile: params.profile } : {}),
					...(params.base ? { base: params.base } : {}),
					...(params.wall_clock_seconds !== undefined ? { wallClockSeconds: params.wall_clock_seconds } : {}),
					...(params.tool_call_cap !== undefined ? { toolCallCap: params.tool_call_cap } : {}),
				});
			} catch (error) {
				// Only the spawn cap queues, only for a non-script job, and only unless queue:false.
				if (!(error instanceof SpawnSafetyError && error.code === "spawn_cap") || params.queue === false) throw error;
				if ((await post.ledger().show(params.job_id).catch(() => undefined))?.script) throw error;
				const { job_id: _id, dry_run: _dry, queue: _queue, ...request } = params;
				const position = post.dispatchQueue.enqueue(params.job_id, request as QueuedDispatchRequest);
				refreshWidget(ctx);
				return {
					content: [{ type: "text", text: `queued (position ${position}): ${params.job_id} starts when a worker slot frees; the outcome arrives as a wake-up — do not re-dispatch` }],
					details: { state: "queued", position, job_id: params.job_id },
				};
			}
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: `${formatDispatchResult(result)}${trackerLine ? `\n  tracker: ${trackerLine}` : ""}` }],
				details: { ...result },
			};
		},
	});

	// Preflight on its own. T12 built the policy and dispatch calls it, but until
	// T27's parity review nothing exposed it: "may this job be dispatched here,
	// right now?" is a question the parent must be able to ask *before* it takes
	// a lease, and the answer (ok | promote | fail) is how promote-not-spawn stops
	// being a rule somebody has to remember.
	pi.registerTool({
		name: "cp_check",
		label: "Check",
		description:
			"Preflight a job without dispatching, leasing or writing anything: canonical clone, git preflight " +
			"(clean base, fetched, correct origin), worktree state and occupancy. Returns {status: ok|promote|fail, " +
			"findings[], promote?}; every finding carries a code and a fix. Branch on the code, never on the prose.",
		promptSnippet: "Preflight a job before dispatching it (cp_check)",
		promptGuidelines: [
			"Use cp_check when you are unsure whether a job may be dispatched, or which worktree it belongs in.",
			"cp_check returning status:promote means send the existing worker a new brief instead of dispatching.",
		],
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Registered project name" })),
			job_id: Type.String({ description: "The job; it is also the branch a new lease would get" }),
			model: Type.Optional(
				Type.String({
					description: "Resolved model. Without it occupancy fails closed: 'same model' cannot be asserted about a model nobody named.",
				}),
			),
			worktree: Type.Optional(Type.String({ description: "A lease already held, to check instead of a fresh one" })),
			base: Type.Optional(Type.String({ description: "Base branch; defaults to origin/HEAD" })),
			fetch: Type.Optional(Type.Boolean({ description: "Run `git fetch origin` first. Default true." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await commandPost(ctx.modelRegistry).preflight.check({
				project: resolveProjectArg(currentRuntime(), params.project, "cp_check"),
				jobId: params.job_id,
				...(params.model ? { model: params.model } : {}),
				...(params.worktree ? { worktree: params.worktree } : {}),
				...(params.base ? { base: params.base } : {}),
				...(params.fetch === undefined ? {} : { fetch: params.fetch }),
			});
			return {
				content: [{ type: "text", text: formatPreflight(result) }],
				details: { ...result },
			};
		},
	});
}
