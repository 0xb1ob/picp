/** `cp_project add`'s readiness block (#329): forge, CI access and tracker, plus what to tell the project's user. */

import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "./ci-access.ts";
import { ciAccessFinding } from "./ci-access-doctor.ts";
import type { CommandRunner } from "./doctor.ts";
import { resolveForgeRepository } from "./forge-url.ts";
import type { EnsureCloneResult } from "./projects.ts";
import { type ProjectTracker, projectTracker } from "./trackers/config.ts";

/** Advisory: a failed probe prints `unknown`, never "no CI" or gh's output; a throwing `run` propagates. */
export function formatReadiness(home: string, project: EnsureCloneResult["project"], clonePath: () => string, run: CommandRunner): string {
	const { name } = project;
	const forge = resolveForgeRepository(project.clone_url, project.forge);
	const forgeLine = forge.ok ? `${forge.repository.kind} (${forge.repository.path})` : `unknown: ${forge.detail}`;

	let ci: string, tellCi: string;
	const finding = forge.ok && forge.repository.kind === "github" ? ciAccessFinding(home, run, name, project.clone_url) : undefined;
	if (finding === "gh_missing") {
		ci = "unknown: gh is not installed — fix: install gh and run `gh auth login`";
		tellCi = "CI access is not checked yet, which is unknown, not \"no CI\".";
	} else if (!finding) {
		ci = "not probed: only GitHub Actions on github.com is probed";
		tellCi = "picp does not probe this remote's CI.";
	} else {
		ci = `${finding.what}${finding.fix ? ` — fix: ${finding.fix}` : ""}`;
		tellCi = finding.what.startsWith(CI_UNREADABLE_LABEL)
			? `picp cannot read this repository's CI yet, so its pull requests show no CI evidence until the token gets ${CI_READ_NEEDED}.`
			: finding.severity !== "ok"
				? "CI access could not be checked yet, which is unknown, not \"no CI\"."
				: finding.what.startsWith("no Actions CI")
					? "The repository has no GitHub Actions workflows, so pull requests carry no CI evidence."
					: "picp reads this repository's GitHub Actions results for each pull request.";
	}

	let tracker: ProjectTracker | undefined, trackerError: string | undefined;
	try {
		tracker = projectTracker(home, name, clonePath);
	} catch (error) {
		trackerError = (error as Error).message;
	}
	const trackerLine = trackerError !== undefined
		? `unknown: ${trackerError}`
		: !tracker
			? `none — connect one with cp_tracker connect project=${name} adapter=beads endpoint=<path to beads.db>`
			: tracker.adapter === "beads" ? `beads (${tracker.db}, from the ${tracker.source})` : `github (${tracker.connection_id})`;
	const tellTracker = tracker ? `Work items come from its ${tracker.adapter} tracker.` : "Work arrives as requests to the operator; no tracker is connected.";

	const tellMerge = project.merge_policy === "human_handoff"
		? "picp opens a pull request, gets it reviewed and green, then hands it to you on GitHub to merge; it never merges itself."
		: "picp merges a pull request once it is reviewed, CI is green and the repository's own rules allow it (nothing forced).";
	return [
		"  readiness (advisory, never blocks add; re-run cp_project add to check again):",
		`    forge:   ${forgeLine}`,
		`    CI:      ${ci}`,
		`    tracker: ${trackerLine}`,
		`  tell the user: picp is set up for ${name}. ${tellMerge} ${tellCi} ${tellTracker}`,
	].join("\n");
}
