/** `cp_project add`'s readiness block (#329): forge and CI access, plus what to tell the project's user. */

import { CI_READ_NEEDED, CI_UNREADABLE_LABEL } from "./ci-access.ts";
import { ciAccessFinding } from "./ci-access-doctor.ts";
import type { CommandRunner } from "./doctor.ts";
import { resolveForgeRepository } from "./forge-url.ts";
import type { EnsureCloneResult } from "./projects.ts";

/** Advisory: a failed probe prints `unknown`, never "no CI" or gh's output; a throwing `run` propagates. */
export function formatReadiness(home: string, project: EnsureCloneResult["project"], run: CommandRunner): string {
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


	const kind = forge.ok ? forge.repository.kind : undefined;
	const request = kind === "gitlab" ? "merge request" : "pull request";
	const where = kind === "github" ? " on GitHub" : kind === "gitlab" ? " on GitLab" : "";
	const tellMerge = project.delivery === "local"
		? "picp pushes each job's branch to the remote; it opens no pull or merge request and merges nothing."
		: project.merge_policy === "human_handoff"
			? `picp opens a ${request}, gets it reviewed and green, then hands it to you${where} to merge; it never merges itself.`
			: `picp merges a ${request} once it is reviewed, CI is green and the repository's own rules allow it (nothing forced).`;
	return [
		"  readiness (advisory, never blocks add; re-run cp_project add to check again):",
		`    forge:   ${forgeLine}`,
		`    CI:      ${ci}`,
		`  tell the user: picp is set up for ${name}. ${tellMerge} ${tellCi} Work arrives as requests to the operator.`,
	].join("\n");
}
