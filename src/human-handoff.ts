/**
 * Per-project human-review handoff (`merge_policy: human_handoff`).
 *
 * A project may choose that the command post never lands its PRs. Once the
 * current head has a passing `cp_review` and green CI (or the repository
 * positively has no CI), `cp_integrate` hands the PR to a human on GitHub and
 * parks the job in `awaiting_merge` (src/awaiting-merge.ts): worker closed,
 * lease returned, step `permit`, next `wait`. A park that cannot finish keeps
 * the job held behind one subject-keyed Awaiting row `human-review pr <url>`,
 * next `surface`. It never runs `gh pr merge` or `gh pr update-branch` and never
 * mints a merge checkpoint. The batched awaiting-merge watch observes the
 * human's merge, a change request or a moved head (src/awaiting-merge-exits.ts).
 *
 * The policy is read through the project registry the composition root injects,
 * keyed by the project name on the job's fleet record — the same name
 * `cp_integrate` already resolves the canonical clone from. Absent or `repo`
 * returns `undefined` at every hook, so integration is unchanged.
 */

import type { ParkFacts, ParkResult } from "./awaiting-merge.ts";
import { parsePrUrl } from "./ci-watch.ts";
import { isoTimestamp, type MergePolicy, type Project } from "./contracts.ts";
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
	next: "surface" | "wait";
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
	/** The PR's base as GitHub reported it; parking records it. Absent never parks. */
	base?: string;
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

/** The subject prefix of the handoff's Awaiting row; teardown withdraws it when the job closes (picp-pvo). */
export const HUMAN_REVIEW_SUBJECT = "human-review pr ";

export function makeHandoff(deps: { registry: MergePolicyRegistry; awaiting?: () => AwaitingLike | undefined; runs?: RunRegistry } & ParkDeps): HandoffPort {
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
		try {
			deps.runs?.open(jobId).cp("integration_permitted", { job_id: jobId, step: "permit", policy: "human_handoff", head_sha: head, pr_url: prUrl });
		} catch {
			// A run log that cannot be written never undoes a handoff.
		}
		const parked = await parkHandedOff(deps, input);
		if (parked?.parked) {
			const facts = [...input.facts, `human_handoff: parked with the team at ${head12} (awaiting_merge cycle ${parked.awaiting_merge.cycle}) — worker closed, lease returned, nothing merged`];
			return input.write({ jobId, branch, step: "permit", next: "wait", facts, prUrl, headSha: head,
				reason: `${jobId}: ${prUrl} at ${head12} passed cp_review and CI and waits with the team (awaiting_merge). The command post never merges it; the awaiting-merge watch closes the job on a merge and wakes you on a change request, a human comment, a moved head or a close.` });
		}
		const subject = bounded(`${HUMAN_REVIEW_SUBJECT}${prUrl}`, 200);
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
		const notParked = parked ? ` Not parked (${parked.failure.code}): ${parked.failure.message} — ${parked.failure.fix}.` : "";
		return surface(
			`human_handoff: handed to a human at ${head12} (cp_review passed, CI green or none configured) — nothing merged${parked ? `; not parked: ${parked.failure.code}` : ""}`,
			`${jobId}: ${prUrl} at ${head12} passed cp_review and CI and is handed to a human to review and merge on GitHub (merge_policy human_handoff). The command post never merges it; a change request is a cp_send to ${jobId}.${notParked}`,
		);
	};
}

type ParkDeps = { park?: (jobId: string, facts: ParkFacts) => Promise<ParkResult>; now?: () => Date };

/** Park the handed-off job; `undefined` when no park port or GitHub PR url is known (the legacy row stands). */
async function parkHandedOff(deps: ParkDeps, input: HandoffInput): Promise<ParkResult | undefined> {
	const pr = parsePrUrl(input.prUrl);
	if (!deps.park || !pr) return undefined;
	if (!input.base) return { job_id: input.jobId, parked: false, failure: { code: "not_parkable", message: "GitHub reported no base branch for the PR", fix: "the job stays held; call cp_integrate again once the PR reads its base" } };
	const facts: ParkFacts = { pr_url: input.prUrl, repo: `${pr.owner}/${pr.repo}`, head_sha: input.head, base: input.base, handed_at: isoTimestamp((deps.now ?? (() => new Date()))()) };
	try {
		return await deps.park(input.jobId, facts);
	} catch (error) {
		return { job_id: input.jobId, parked: false, failure: { code: "not_parkable", message: (error as Error).message.split("\n")[0] ?? "park threw", fix: "the job stays held; call cp_integrate again" } };
	}
}
