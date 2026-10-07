/**
 * cp_teardown, cp_merged, cp_integrate and cp_artifact.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatMerge } from "../../src/merges.ts";
import { formatIntegration } from "../../src/integrate.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { type MergeStrategy } from "../../src/contracts.ts";
import { operatorTextsFromEntries, requireOperatorQuote } from "../../src/decide.ts";
import { formatTeardown } from "../../src/teardown.ts";
import { TrackerStore } from "../../src/trackers/config.ts";
import { writeBackLine } from "../../src/trackers/link.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerIntegrateTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, refreshWidget } = deps;

	pi.registerTool({
		name: "cp_teardown",
		label: "Teardown",
		description:
			"Finish a job: verify the kind-aware gates (ship: clean and pushed; research: clean and no local commits), " +
			"return the lease, shut the worker down with an observed close, mark the job done, and close a research or Q&A job in the ledger. " +
			"Refuses and keeps everything when a gate fails.",
		promptSnippet: "Finish a job and return its worktree (cp_teardown)",
		promptGuidelines: [
			"Use cp_teardown once a job's envelope is in and its delivery has landed; never delete a worktree by hand.",
			"cp_teardown refusing is the correct outcome for a dirty or unpushed tree: fix the cause, then retry.",
			"Research and Q&A jobs close in the ledger here; do not follow with cp_job close. Dropped work is still cp_job drop.",
			"cp_teardown refusing unreported_live_worker means the worker is alive and has not reported: wait for its envelope or cp_send it to report, and relay \"no report\" for it. Force past it only with operator_quote taken verbatim from an operator message; it ends as killed_unreported.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The job to tear down" }),
			force: Type.Optional(
				Type.Boolean({
					description: "Operator authorization to skip the gates (e.g. the worktree is gone). Recorded in the run log. Forcing past unreported_live_worker (a live worker that never reported) also needs operator_quote and ends as killed_unreported.",
				}),
			),
			operator_quote: Type.Optional(Type.String({ description: "With force: one complete sentence, verbatim from an operator message in this session, authorizing this forced teardown; recorded with it." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			if (params.operator_quote !== undefined && !params.force) throw new Error("cp_teardown: operator_quote authorizes force; pass force: true with it, or neither");
			// issue #2: verified before anything runs; Teardown decides whether force needs it (unreported_live_worker).
			const verified = params.force && params.operator_quote !== undefined
				? requireOperatorQuote(params.operator_quote, { operatorTexts: operatorTextsFromEntries(ctx.sessionManager.getEntries()) })
				: undefined;
			const result = await commandPost(ctx.modelRegistry).tearDown(params.job_id, {
				...(params.force ? { force: true, requireAuthorization: true } : {}),
				...(verified ? { authorization: { by: verified.decidedBy, quote: verified.stored.operator_quote } } : {}),
			});
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatTeardown(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "cp_merged",
		label: "Merged",
		description:
			"Record that a job's PR landed, from what `gh pr view` reports: state MERGED, the merge commit and the " +
			"head oid. Writes state/runs/<job-id>/merge.json and moves the job's pr receipt to `merged`. " +
			"This is the mechanism behind 'confirm the PR merged': the teardown gate reads the receipt, so a " +
			"squash- or rebase-merged PR with a deleted head branch tears down without force. " +
			"Refuses (and writes nothing) unless gh itself says the PR is merged.",
		promptSnippet: "Record an observed PR merge so teardown can confirm it (cp_merged)",
		promptGuidelines: [
			"After merging a delivery:pr job's PR, run cp_merged <job-id> before cp_teardown: it is what lets the gate confirm a squash merge.",
			"Never reach for cp_teardown force on a merged PR — force records that nothing was proven, and cp_merged proves it.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The job whose PR merged" }),
			pr: Type.Optional(Type.String({ description: "PR url or number; defaults to the job's own pr receipt" })),
			strategy: Type.Optional(
				StringEnum(["squash", "rebase", "merge", "unknown"], { description: "How it was merged, for the record" }),
			),
		}),
		// A refusal throws, like every other tool here: MergeError's message names
		// what was not observed, and nothing is ever half-written on that path.
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const result = await commandPost(ctx.modelRegistry).recordMerge({
				jobId: params.job_id,
				...(params.pr ? { pr: params.pr } : {}),
				...(params.strategy ? { strategy: params.strategy as MergeStrategy } : {}),
			});
			refreshWidget(ctx);
			return {
				content: [{ type: "text", text: formatMerge(result) }],
				details: result,
			};
		},
	});

	// cp-uug: the merge sequence, as one resumable step per call. It runs in the
	// parent process on purpose — `src/ci-wait.ts`'s prohibition is a *worker*
	// hook and is untouched here, and the branch's only writer is still the job's
	// own implementer, promoted with cp_send when something needs resolving.
	pi.registerTool({
		name: "cp_integrate",
		label: "Integrate",
		description:
			"Advance one delivery:pr job's merge by exactly one step, and verify that step's postcondition: read CI " +
			"for the pushed head, read whether the repository itself permits the merge unforced (mergeStateStatus, " +
			"cp-x7i), update the branch server-side only when GitHub says BEHIND or a readable rule requires it, " +
			"merge, record the receipt, tear down and close the br issue. " +
			"Idempotent and resumable — it recomputes which step is due from git and gh every call, so a restarted " +
			"parent picks up where it stopped. Branch on `next`, never on the prose: advance | wait | review | resolve | retry | " +
			"surface | done. next: review means no passing cp_review on this head — run cp_review on that head, never re-review an unchanged one. " +
			"It never forces a merge the repository refuses (no --admin, no bypass): where GitHub " +
			"permits it, it merges with no checkpoint; where GitHub refuses, a merge-pending reminder appears in " +
			"Awaiting-you and nothing is retried automatically; where this home cannot read the verdict at all, the " +
			"fallback is a human answering state/checkpoints/<job-id>.merge-<head>.json, per PR and per head sha. There " +
			"is no standing or blanket merge authority a human can grant anywhere in this tool. " +
			"hold records a durable per-job integration pause with a reason; release removes it without bypassing any merge gate.",
		promptSnippet: "Advance one PR's merge by one verified step (cp_integrate)",
		promptGuidelines: [
			"Call cp_integrate advance for the next PR to merge; it does one step and returns `next`. Call it again while next is `advance`.",
			"next: `surface` means a human decision, or a merge the repository refuses (merge pending) — relay it, do not retry it.",
			"next: `wait` means CI is unfinished or an integration hold is active — the result still names CI for the pushed head. Nothing was merged; release a hold explicitly, then advance again.",
			"next: `review` means no passing cp_review on this head. Run cp_review on the named head; do not re-review an unchanged one.",
			"next: `resolve` means the job's own implementer is still working or being promoted to fix a conflict or a red suite. Wait for its envelope.",
			"A stale base alone is never rebased: only BEHIND, or a readable up-to-date rule, updates the branch, and the moved head needs CI and cp_review again.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The delivery:pr ship job whose PR is being merged" }),
			action: Type.Optional(
				StringEnum(["advance", "status", "hold", "release"], {
					description: "advance (default): do the next step. status: read only. hold: pause with reason. release: allow the next advance.",
				}),
			),
			pr: Type.Optional(Type.String({ description: "PR url or number; defaults to the job's own pr receipt" })),
			strategy: Type.Optional(
				StringEnum(["squash", "rebase", "merge"], { description: "Merge strategy. This repo squash-merges everything." }),
			),
			reason: Type.Optional(Type.String({ description: "hold: required reason for pausing integration", minLength: 1, maxLength: 2000 })),
			base: Type.Optional(Type.String({ description: "The PR's base branch (default: the PR's own, then main)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			const holds = new IntegrationHolds(post.home);
			if (params.action === "hold" || params.action === "release") {
				const hold = params.action === "hold" ? holds.hold(params.job_id, params.reason ?? "") : (holds.release(params.job_id), null);
				refreshWidget(ctx);
				return {
					content: [{ type: "text", text: hold ? `${params.job_id}: integration held: ${hold.reason}` : `${params.job_id}: integration hold released; call cp_integrate advance to resume with all gates rechecked.` }],
					details: { job_id: params.job_id, hold },
				};
			}
			if (params.action === "status") {
				// A pure read: what the record says and what the end-state facts say.
				// Never a step, so it can be called at any time without consequence.
				const record = post.integrator.get(params.job_id);
				const endState = post.integrator.endState(params.job_id);
				const hold = holds.get(params.job_id) ?? null;
				// picp-wzq: the record's facts (CI included, even while held) and the watcher's last CI read; never a gh call.
				let ciWatch: ReturnType<typeof post.ciWatch.store.job> | null = null;
				let watchLine: string;
				try {
					ciWatch = post.ciWatch.store.job(params.job_id) ?? null;
					watchLine = ciWatch
						? `last_ci=${ciWatch.last_ci ?? "unknown"} on ${ciWatch.head_sha?.slice(0, 12) ?? "no head"} observed ${ciWatch.head_observed_at ?? "never"}`
						: "not watched (only held PRs with a live report are)";
				} catch (error) {
					watchLine = `unavailable (${(error as Error).message})`;
				}
				const details = { job_id: params.job_id, record: record ?? null, end_state: endState, hold, ci_watch: ciWatch };
				const text = record
					? [`${record.job_id} integrate: ${record.step} -> ${record.next}`, `  ${record.reason}`, ...record.facts.map((fact) => `  - ${fact}`)].join("\n")
					: `${params.job_id}: no integration has been attempted yet`;
				return {
					content: [{ type: "text", text: `${text}\n  ci-watch: ${watchLine}\n  hold: ${hold?.reason ?? "none"}\n  end state: ${JSON.stringify(endState)}` }],
					details,
				};
			}
			const result = await post.integrate({
				jobId: params.job_id,
				...(params.pr ? { pr: params.pr } : {}),
				...(params.strategy ? { strategy: params.strategy as MergeStrategy } : {}),
				...(params.base ? { base: params.base } : {}),
			});
			refreshWidget(ctx);
			return {
				// laf: a landed job names its tracker write-back; writeBackLine reads local files only and never throws.
				content: [{ type: "text", text: result.next === "done" ? `${formatIntegration(result)}\n  ${writeBackLine(post.home, () => post.ledger(), () => new TrackerStore({ home: post.home, registry: post.registry }).list(), params.job_id)}` : formatIntegration(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "cp_artifact",
		label: "Artifact",
		description:
			"Manage a job's research artifact (state/artifacts/<job-id>/report.md) by reference only. " +
			"path: the predeclared file a planner must write. add: file an existing file into the store. " +
			"get: copy the body to a file you name, for a worker to read. Bodies are never returned inline — " +
			"this session must not contain findings.",
		promptSnippet: "Locate, file or export a job's research artifact without reading it (cp_artifact)",
		promptGuidelines: [
			"Use cp_artifact get with an out file to hand a research artifact to an implementer; never read the artifact yourself.",
			"Use cp_artifact path to tell a planner where its report must be written.",
		],
		parameters: Type.Object({
			action: StringEnum(["path", "add", "get"], {
				description: "path: predeclared location | add: file into the store | get: copy out to a file",
			}),
			job_id: Type.String({ description: "The job that owns the artifact" }),
			file: Type.Optional(Type.String({ description: "add: the file to store" })),
			out: Type.Optional(
				Type.String({ description: "get: destination file for the body (required; the body never travels inline)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = commandPost(ctx.modelRegistry).artifacts;
			const cwd = ctx.cwd;
			if (params.action === "path") {
				const path = store.path(params.job_id);
				return {
					content: [{ type: "text", text: JSON.stringify({ job_id: params.job_id, path }) }],
					details: { job_id: params.job_id, path },
				};
			}
			if (params.action === "add") {
				if (!params.file) throw new Error("cp_artifact add needs `file`: the file to store");
				const result = store.add(params.job_id, params.file, { cwd });
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
				};
			}
			if (!params.out) {
				throw new Error(
					"cp_artifact get needs `out`: the file to copy the body into. An artifact body is never returned inline — " +
						"pass the out path to a worker instead.",
				);
			}
			const result = store.get(params.job_id, params.out, { cwd });
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
