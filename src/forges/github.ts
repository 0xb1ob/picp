/**
 * GitHub observation through `gh pr view` (forge PR 1). Extracted from
 * MergeStore unchanged: the same command, the same fields, the same runner.
 */

import type { CommandRunner } from "../merges.ts";
import type { ChangeRequestState, ForgeObserver } from "./adapter.ts";

/** The `gh pr view --json` fields this module asks for, and nothing else. */
export const GH_PR_FIELDS = ["number", "url", "state", "mergedAt", "mergeCommit", "headRefName", "headRefOid", "baseRefName"] as const;

export interface GhPrView {
	number?: number;
	url?: string;
	state?: string;
	mergedAt?: string;
	mergeCommit?: { oid?: string } | null;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
}

export type GhPrRead = { ok: true; view: GhPrView } | { ok: false; reason: "command" | "json"; detail: string };

/** One `gh pr view`; a failed command carries its first output line, unparseable output says so. */
export async function readGhPr(run: CommandRunner, cwd: string, pr: string): Promise<GhPrRead> {
	const result = await run(cwd, "gh", ["pr", "view", pr, "--json", GH_PR_FIELDS.join(",")]);
	if (result.status !== 0) {
		return { ok: false, reason: "command", detail: (result.stderr || result.stdout).trim().split("\n")[0] ?? "no output" };
	}
	try {
		return { ok: true, view: JSON.parse(result.stdout) as GhPrView };
	} catch {
		return { ok: false, reason: "json", detail: "gh returned output that is not JSON" };
	}
}

const STATES: Readonly<Record<string, ChangeRequestState>> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };

export function githubObserver(run: CommandRunner, cwd: string): ForgeObserver {
	return {
		provider: "github",
		async readChangeRequest(ref) {
			const read = await readGhPr(run, cwd, ref);
			if (!read.ok) {
				return read.reason === "command"
					? { ok: false, reason: "unavailable", detail: `github: gh pr view failed (${read.detail.slice(0, 200)})` }
					: { ok: false, reason: "invalid", detail: `github: ${read.detail}` };
			}
			const view = read.view;
			if (typeof view !== "object" || view === null || typeof view.number !== "number" || typeof view.url !== "string") {
				return { ok: false, reason: "invalid", detail: "github: gh pr view named no PR number or url" };
			}
			const mergeCommit = view.mergeCommit?.oid?.trim();
			return {
				ok: true,
				observation: {
					provider: "github",
					url: view.url,
					number: view.number,
					state: STATES[view.state ?? ""] ?? "unknown",
					...(view.headRefName ? { source_branch: view.headRefName } : {}),
					...(view.baseRefName ? { target_branch: view.baseRefName } : {}),
					...(view.headRefOid ? { head_sha: view.headRefOid } : {}),
					...(view.mergedAt ? { merged_at: view.mergedAt } : {}),
					...(mergeCommit ? { merge_commit_sha: mergeCommit } : {}),
				},
			};
		},
	};
}
