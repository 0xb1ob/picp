/**
 * Per-project human-review handoff (`merge_policy: human_handoff`).
 *
 * A project may choose that the command post never lands its PRs. Once the
 * current head has a passing `cp_review` and green CI (or the repository
 * positively has no CI), `cp_integrate` hands the PR to a human on GitHub: one
 * subject-keyed Awaiting row `human-review pr <url>` naming the head, step
 * `permit`, next `surface`. It never runs `gh pr merge` or `gh pr update-branch`
 * and never mints a merge checkpoint. The human's merge is observed through the
 * ordinary `MERGED` path; a change request is a `cp_send` to the same job, and
 * the new head is reviewed, CI-checked and handed off again on the same row.
 *
 * The policy is read through the project registry the composition root injects,
 * keyed by the project name on the job's fleet record — the same name
 * `cp_integrate` already resolves the canonical clone from. Absent or `repo`
 * returns `undefined` at every hook, so integration is unchanged.
 */

import type { MergePolicy, Project } from "./contracts.ts";
import type { AwaitingLike, IntegrateResult } from "./integrate.ts";
import type { MergePermissionVerdict } from "./merge-permission.ts";
import type { RunRegistry } from "./runs.ts";

/** Pending causes that are a human's to settle on GitHub, so they hand off. */
export const HANDOFF_PENDING_CAUSES: readonly string[] = Object.freeze(["reviews", "behind", "unknown_block"]);

/** The registry read this module needs; `get` may throw on an unreadable registry. */
export interface MergePolicyRegistry {
	get(name: string): Pick<Project, "merge_policy"> | undefined;
}

/** What the port writes through the Integrator's own record writer. */
export interface HandoffWrite {
	jobId: string;
	branch: string;
	step: "permit";
	next: "surface";
	facts: string[];
	reason: string;
	prUrl: string;
	headSha: string;
}

export interface HandoffInput {
	jobId: string;
	branch: string;
	facts: string[];
	prUrl: string;
	head: string;
	/** The project name from the job's fleet record. */
	project: string;
	/** `permit`: CI is green (or positively absent) and GitHub's verdict was read. `fallback`: CI or merge state is unreadable. */
	at: "permit" | "fallback";
	verdict?: MergePermissionVerdict;
	/** The Integrator's review gate; a result (`next: review`, a final-fix step) is returned unchanged. Absent where review already passed. */
	review?: () => Promise<IntegrateResult | undefined>;
	write: (input: HandoffWrite) => IntegrateResult;
}

/** The Integrator's `handoff` option: a result stops the step before any update or merge; absent or `undefined` changes nothing. */
export type HandoffPort = (input: HandoffInput) => Promise<IntegrateResult | undefined>;

/** Absent means `repo`. Throws when the registry cannot be read. */
export function mergePolicyOf(registry: MergePolicyRegistry, project: string): MergePolicy {
	return registry.get(project)?.merge_policy === "human_handoff" ? "human_handoff" : "repo";
}

/** `handoff` iff GitHub permits the merge, or holds it on a cause a human settles on GitHub. */
export function handOffDecision(verdict: Pick<MergePermissionVerdict, "permission" | "cause"> | undefined): "handoff" | "default" {
	if (verdict?.permission === "permitted") return "handoff";
	return verdict?.permission === "pending" && verdict.cause !== undefined && HANDOFF_PENDING_CAUSES.includes(verdict.cause) ? "handoff" : "default";
}

/**
 * The Integrator's #fallback hold: the review gate first, then the handoff port (absent → no-op).
 * Review always runs, whatever the policy; human_handoff never mints a merge checkpoint.
 */
export async function reviewThenHandoff(review: () => Promise<IntegrateResult | undefined>, port: HandoffPort | undefined, input: HandoffInput): Promise<IntegrateResult | undefined> {
	const blocked = await review();
	if (blocked) return blocked;
	return port?.(input);
}

const bounded = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function makeHandoff(deps: { registry: MergePolicyRegistry; awaiting?: () => AwaitingLike | undefined; runs?: RunRegistry }): HandoffPort {
	return async (input) => {
		const { jobId, branch, prUrl, head } = input;
		const head12 = head.slice(0, 12);
		const surface = (fact: string, reason: string) =>
			input.write({ jobId, branch, step: "permit", next: "surface", facts: [...input.facts, fact], reason, prUrl, headSha: head });
		let policy: MergePolicy;
		try {
			policy = mergePolicyOf(deps.registry, input.project);
		} catch (error) {
			// Fail closed: a project that may have asked for a human is never merged on a guess.
			const detail = (error as Error).message.split("\n")[0] ?? "unreadable";
			return surface(`merge_policy unreadable: ${detail}`, `${jobId}: the merge policy of project ${input.project} could not be read (${detail}). Nothing was merged; fix the registry and call cp_integrate again.`);
		}
		if (policy !== "human_handoff") return undefined;
		if (input.at === "fallback") {
			return surface(
				"human_handoff: CI or merge state unreadable — not handed off, no merge checkpoint",
				`${jobId}: ${prUrl} was not handed off — CI or GitHub's merge state could not be read at ${head12}, and merge_policy human_handoff never mints a merge checkpoint. Call cp_integrate again once it reads.`,
			);
		}
		if (handOffDecision(input.verdict) === "default") return undefined;
		const blocked = await input.review?.();
		if (blocked) return blocked;
		const subject = bounded(`human-review pr ${prUrl}`, 200);
		try {
			await deps.awaiting?.()?.declareGated({
				type: "approval",
				subject,
				decision: bounded(`human review at ${head12}: ${prUrl}`, 100),
				why: "cp_review passed and CI is green; merge_policy human_handoff: a human lands it",
				blocks: bounded(`${jobId} lands when a human merges it on GitHub`, 100),
				options: ["Merged on GitHub", "Changes requested — cp_send the job", "Drop this PR"],
				job_id: jobId,
			});
		} catch {
			// Best-effort, like the merge-pending reminder: the record and the notice still say it.
		}
		try {
			deps.runs?.open(jobId).cp("integration_permitted", { job_id: jobId, step: "permit", policy: "human_handoff", head_sha: head, pr_url: prUrl });
		} catch {
			// A run log that cannot be written never undoes a handoff.
		}
		return surface(
			`human_handoff: handed to a human at ${head12} (cp_review passed, CI green or none configured) — nothing merged`,
			`${jobId}: ${prUrl} at ${head12} passed cp_review and CI and is handed to a human to review and merge on GitHub (merge_policy human_handoff). The command post never merges it; a change request is a cp_send to ${jobId}.`,
		);
	};
}
