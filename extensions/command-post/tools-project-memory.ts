/**
 * cp_project and cp_memory.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import { existsSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatMemoryStatus } from "../../src/memory.ts";
import { formatCurationAudit, formatCurationPlan, formatMemoryReport, PROMOTABLE_TIERS, REJECT_CAUSES } from "../../src/curation.ts";
import { formatEnsured, formatProjects } from "../../src/projects.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerProjectMemoryTools(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive } = deps;

	// Project registration (cp-sdm). Until this existed, `cp_dispatch` refused
	// every job in a repository the registry had never heard of, and the only way
	// to teach it one was hand-editing data/projects.json — the README promised
	// otherwise, and a first run ended in a text editor.
	pi.registerTool({
		name: "cp_project",
		label: "Projects",
		description:
			"Register a project (and clone it on demand), or list what is registered. A `project:<name>` br label " +
			"must name a registered project; `projects/<name>` is a clone-on-demand cache, never a place to keep work.",
		promptSnippet: "Register or list command post projects (cp_project)",
		promptGuidelines: [
			"Use cp_project add before the first dispatch into a repository this home has never worked in.",
			"A project name is what `project:<name>` labels use; it must match ^[a-z0-9][a-z0-9._-]{0,63}$.",
			"reviewer_model sets the exact model for plan/diff reviewers; null clears. Explicit review model wins, then the newest eligible configured mandate, then project, then existing routing. This changes no author routing or permission.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "show", "archive", "unarchive", "merge_policy", "reviewer_model"], { description: "list registered projects, add one, show one, archive/unarchive one (archived: skipped by pollers, refused for new jobs, mandates and dispatch; clone and history kept), set its merge_policy, or set/clear reviewer_model" }),
			name: Type.Optional(Type.String({ description: "Project name; required except for list" })),
			reviewer_model: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "reviewer_model: exact provider/model for plan gates and diff reviews; null clears. Eligible mandate preference takes precedence; unusable models refuse." })),
			policy: Type.Optional(StringEnum(["repo", "human_handoff"], { description: "merge_policy: repo (default; cp_integrate merges when the repository permits) or human_handoff (a reviewed, green PR is handed to a human on GitHub and never merged by the command post)" })),
			clone_url: Type.Optional(Type.String({ description: "git remote to clone/fetch from; required for add" })),
			delivery: Type.Optional(
				StringEnum(["pr", "local"], { description: "Default delivery for jobs in this repo (default: pr)" }),
			),
			base_branch: Type.Optional(Type.String({ description: "Default base branch; resolved from the clone when absent" })),
			notes: Type.Optional(Type.String({ description: "One line for the operator's own benefit" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			const registry = post.registry;
			if (params.action === "list") {
				const projects = registry.list();
				return {
					content: [
						{
							type: "text",
							text: formatProjects(projects, { cloneExists: (project) => existsSync(registry.pathOf(project.name)), pathOf: (project) => registry.pathOf(project.name) }),
						},
					],
					details: { projects } as unknown as Record<string, unknown>,
				};
			}
			if (!params.name) throw new Error(`cp_project ${params.action} needs a name`);
			if (params.action === "show") {
				const project = registry.require(params.name);
				return {
					content: [
						{
							type: "text",
							text: formatProjects([project], { cloneExists: () => existsSync(registry.pathOf(project.name)), pathOf: () => registry.pathOf(project.name) }),
						},
					],
					details: { project } as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "archive" || params.action === "unarchive") {
				const project = await registry.setArchived(params.name, params.action === "archive");
				return {
					content: [{ type: "text", text: `${project.name} ${project.archived ? "archived" : "unarchived"}` }],
					details: { project } as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "reviewer_model") {
				if (params.reviewer_model === undefined) throw new Error("cp_project reviewer_model needs reviewer_model (provider/model or null)");
				const project = await registry.setReviewerModel(params.name, params.reviewer_model);
				return { content: [{ type: "text", text: `${project.name} reviewer model: ${project.reviewer_model ?? "unset"}` }], details: { project } as unknown as Record<string, unknown> };
			}
			if (params.action === "merge_policy") {
				if (!params.policy) throw new Error("cp_project merge_policy needs a policy: repo or human_handoff");
				const project = await registry.setMergePolicy(params.name, params.policy as "repo" | "human_handoff");
				return {
					content: [{ type: "text", text: `${project.name} merge_policy: ${project.merge_policy ?? "repo"}` }],
					details: { project } as unknown as Record<string, unknown>,
				};
			}
			if (!params.clone_url) throw new Error("cp_project add needs a clone_url");
			// ensureProject is register-if-absent plus clone-on-demand, so adding a
			// project twice is a no-op that says so rather than a second clone.
			const result = await registry.ensureProject({
				name: params.name,
				clone_url: params.clone_url,
				delivery: (params.delivery ?? "pr") as "pr" | "local",
				...(params.base_branch ? { base_branch: params.base_branch } : {}),
				...(params.notes ? { notes: params.notes } : {}),
			});
			return {
				content: [{ type: "text", text: formatEnsured(result) }],
				details: result as unknown as Record<string, unknown>,
			};
		},
	});

	// The tool-level form of /memory (cp-kzu). Capture's only trigger used to be
	// a slash command, which a human types in the TUI; the parent session itself
	// had no way to call it, so a job's lesson survived only as long as this
	// session's own transcript memory. `data/candidates.md`'s own header names
	// the parent as the writer "at job completion or failure" — this is that path.
	// Same underlying capture as /memory: append-only, one dated line, never
	// touches learnings.md. This is an addition, not a replacement — /memory keeps
	// working unchanged for the operator.
	pi.registerTool({
		name: "cp_memory",
		label: "Memory",
		description:
			"Parent-only session memory and curation. `capture` appends one dated one-line lesson to " +
			"data/candidates.md (capture is not promotion); `status` reports budget, tiers, decay and candidates; " +
			"`curate` returns the pass's worklist (pending candidates, stale learnings, today's remaining bounds); " +
			"`promote` appends one evidenced, dated, decaying line to data/learnings.md; `reject` records that a " +
			"candidate is superseded/disproven/generalizes/noise and can never be promoted; `retire` moves a learning " +
			"to data/archive.md with provenance; `audit` reads data/curation.jsonl (with `line`, traces one entry). " +
			"Curation is this session's own job — the bounds are code, not a human approval step.",
		promptSnippet: "Capture, promote, retire and audit session memory (cp_memory)",
		promptGuidelines: [
			"Call cp_memory capture when a job's failure or recovery taught this home something it will hit again (a machine-local fact, or a workaround until a named fix lands), and for every `capture:` line in a main-session send — one line with evidence; a rule every clone needs is a contract edit, not a capture.",
			"Run cp_memory curate only when the digest or a capture result reports pending candidates or stale learnings; then decide every pending candidate. Do not ask the operator to approve a promotion.",
			"Promotion needs evidence that names a checkable source (job id, PR, commit, path or date) and is bounded per day and by the learnings budget; a pinned line is not autonomously writable.",
			"A lesson made false by merged code leaves through cp_memory retire (reason + evidence); the archive keeps it, so retiring is recoverable and deleting is not offered.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "capture", "curate", "promote", "reject", "retire", "audit"], {
				description:
					"status: budget/tiers/candidates; capture: append one dated lesson; curate: the pass's worklist; " +
					"promote/reject: decide one candidate; retire: archive one learning; audit: the curation journal",
			}),
			lesson: Type.Optional(
				Type.String({ description: "capture: the one-line lesson. promote: the lesson as it should read in learnings" }),
			),
			candidate: Type.Optional(
				Type.String({ description: "promote/reject: the exact data/candidates.md line (`YYYY-MM-DD <lesson>`)" }),
			),
			line: Type.Optional(Type.String({ description: "retire: the exact learnings line. audit: trace just this line" })),
			evidence: Type.Optional(
				Type.String({ description: "promote/retire (and superseded/disproven rejections): a checkable source — job id, PR, commit, path or date" }),
			),
			tier: Type.Optional(
				StringEnum([...PROMOTABLE_TIERS], { description: "promote: aging (default, stale at 30d) or perishable (7d). Pinned is not autonomously writable" }),
			),
			expires: Type.Optional(
				Type.String({ description: "promote, required for perishable: the checkable expiry condition (job id, version, date)" }),
			),
			cause: Type.Optional(
				StringEnum([...REJECT_CAUSES], { description: "reject: why this candidate will never be promoted" }),
			),
			reason: Type.Optional(Type.String({ description: "reject/retire: one line, why" })),
			now: Type.Optional(Type.String({ description: "retire: where the knowledge lives instead (AGENTS.md §X, docs/foo.md)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			if (params.action === "status") {
				const status = post.memory();
				const plan = post.curationPlan();
				return {
					content: [{ type: "text", text: formatMemoryReport(formatMemoryStatus(status), plan) }],
					details: status as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "curate") {
				const plan = post.curationPlan();
				return {
					content: [{ type: "text", text: formatCurationPlan(plan) }],
					details: {
						date: plan.date,
						pending: plan.pending,
						stale: plan.stale.map((entry) => entry.line),
						budget_remaining: plan.budget_remaining,
						promotions_remaining: plan.promotions_remaining,
						retirements_remaining: plan.retirements_remaining,
					},
				};
			}
			if (params.action === "audit") {
				const records = post.curationAudit(params.line?.trim() || undefined);
				return {
					content: [{ type: "text", text: formatCurationAudit(records) }],
					details: { records } as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "promote") {
				const result = post.promote({
					candidate: params.candidate ?? "",
					lesson: params.lesson ?? "",
					evidence: params.evidence ?? "",
					...(params.tier ? { tier: params.tier } : {}),
					...(params.expires ? { expires: params.expires } : {}),
				});
				return {
					content: [
						{
							type: "text",
							text:
								`promoted (${result.id}) into data/learnings.md — ${result.entries}/${result.budget} lines, ` +
								`${result.promotions_remaining} promotion(s) left today:\n${result.line}`,
						},
					],
					details: result as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "reject") {
				if (!params.cause) {
					throw new Error(`cp_memory reject needs a cause — one of ${REJECT_CAUSES.join(", ")}`);
				}
				const result = post.reject({
					candidate: params.candidate ?? "",
					cause: params.cause,
					reason: params.reason ?? "",
					...(params.evidence ? { evidence: params.evidence } : {}),
				});
				return {
					content: [
						{ type: "text", text: `rejected as ${result.cause} (${result.id}); it can never be promoted: ${result.candidate}` },
					],
					details: result as unknown as Record<string, unknown>,
				};
			}
			if (params.action === "retire") {
				const result = post.retire({
					line: params.line ?? "",
					reason: params.reason ?? "",
					evidence: params.evidence ?? "",
					...(params.now ? { now: params.now } : {}),
				});
				return {
					content: [
						{
							type: "text",
							text:
								`retired (${result.id}) to data/archive.md — ${result.remaining} learning line(s) left, ` +
								`${result.retirements_remaining} retirement(s) left today:\n${result.archived}`,
						},
					],
					details: result as unknown as Record<string, unknown>,
				};
			}
			if (!params.lesson || params.lesson.trim().length === 0) {
				throw new Error("cp_memory capture needs a one-line lesson — usage: cp_memory {action: \"capture\", lesson: \"<one-line lesson>\"}");
			}
			const result = post.capture(params.lesson);
			return {
				content: [
					{ type: "text", text: `captured in ${result.file} (${result.candidates} candidate(s)): ${result.line} — ${post.curationPlan().pending.length} pending; curate when done capturing` },
				],
				details: result as unknown as Record<string, unknown>,
			};
		},
	});
}
