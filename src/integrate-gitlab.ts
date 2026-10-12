/**
 * Forge PR 3: `cp_integrate` for a GitLab job — observation and recovery only.
 * v1 creates no MR, reads no GitLab CI and never merges: the MR is read
 * through the project's forge observer, a merged MR continues into the
 * same record → sync → teardown → delete-head tail as a merged GitHub PR,
 * and every other state stops with a named reason. Nothing here runs gh.
 */

import type { IntegrationNext } from "./contracts.ts";
import { parseChangeRequestUrl } from "./forge-url.ts";
import type { ForgeObserver } from "./forges/adapter.ts";

export type GitlabIntegrateStep =
	/** Merged on GitLab: finish against the MR's own target branch. */
	| { merged: true; prUrl: string; base: string; head?: string; fact: string }
	| { merged: false; next: IntegrationNext; reason: string; facts: string[]; prUrl?: string; head?: string };

/** What a held GitLab job's step leads with: the hold is the only thing that applies. */
export const GITLAB_HELD_LEAD = "GitLab CI is not read in v1 and nothing is merged from here";

export async function observeGitlabMr(input: { jobId: string; branch: string; pr: string; observer: ForgeObserver }): Promise<GitlabIntegrateStep> {
	const { jobId, branch, pr } = input;
	if (parseChangeRequestUrl(pr)?.kind !== "gitlab") {
		return {
			merged: false,
			next: "surface",
			facts: [`${pr} is not a GitLab merge request url`],
			reason: `${jobId}: this GitLab job names no merge request url (${pr}), and v1 never searches for one. Nothing was touched; re-run with pr set to the MR url.`,
		};
	}
	const read = await input.observer.readChangeRequest(pr);
	if (!read.ok) {
		const retry = read.reason === "unavailable" || read.reason === "invalid";
		return {
			merged: false,
			next: retry ? "retry" : "surface",
			facts: [`gitlab: ${read.reason} — ${read.detail}`],
			prUrl: pr,
			reason: `${jobId}: ${pr} could not be read (${read.reason}: ${read.detail}). Nothing was touched${retry ? "; retry" : ""}.`,
		};
	}
	const mr = read.observation;
	const head = mr.head_sha;
	const seen = { prUrl: mr.url, ...(head ? { head } : {}) };
	const fact = `gitlab: ${mr.url} is ${mr.state} from ${mr.source_branch ?? "an unknown branch"} into ${mr.target_branch ?? "an unknown branch"}${head ? ` at ${head.slice(0, 12)}` : ""}`;
	if (mr.source_branch !== branch) {
		return { merged: false, next: "surface", facts: [fact], ...seen, reason: `${mr.url} merges ${mr.source_branch ?? "an unknown branch"}, but ${jobId}'s branch is ${branch} — that MR is not this job's delivery, so nothing was touched.` };
	}
	if (mr.state === "merged" && mr.target_branch) return { merged: true, prUrl: mr.url, base: mr.target_branch, ...(head ? { head } : {}), fact };
	if (mr.state === "closed") {
		return { merged: false, next: "surface", facts: [fact], ...seen, reason: `${mr.url} is closed and was never merged. Nothing was recorded and nothing was torn down — reopen it, or decide with the operator whether this job is dropped.` };
	}
	return {
		merged: false,
		next: "surface",
		facts: [fact],
		...seen,
		reason: `${jobId}: ${mr.url} is ${mr.state}. v1 reads no GitLab CI and never merges an MR: merge it on GitLab, then re-run cp_integrate (the watch also wakes you when it merges). Nothing was touched.`,
	};
}
