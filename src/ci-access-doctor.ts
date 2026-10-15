/** `/doctor`'s `ci.<project>` findings (ask-81b54d83f0b2): CI readable, absent, or refused to the token. */

import type { DoctorFinding } from "./contracts.ts";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL, ciReadDenied } from "./ci-access.ts";
import { readCiConfigured } from "./ci-configured.ts";
import { githubRepoFromCloneUrl } from "./mandate.ts";
import { ProjectRegistry } from "./projects.ts";

type Run = (command: string, args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

/** One Actions read per registered GitHub project; never throws, never prints `gh` output. */
export function ciAccessFindings(home: string, run: Run): DoctorFinding[] {
	let projects;
	try {
		projects = new ProjectRegistry({ home }).list().filter((project) => !project.archived);
	} catch {
		return []; // already reported by models.projects
	}
	const findings: DoctorFinding[] = [];
	for (const project of projects) {
		const repo = githubRepoFromCloneUrl(project.clone_url);
		if (!repo) continue; // not GitHub: this probe has nothing to ask
		const endpoint = `repos/${repo}/actions/workflows`;
		const result = run("gh", ["api", endpoint], home);
		if (result.status === null && /\bENOENT\b/.test(result.stderr)) return []; // host.gh already says gh is missing
		const check = `ci.${project.name}`;
		if (result.status !== 0 && ciReadDenied(`${endpoint} ${result.stderr} ${result.stdout}`)) {
			findings.push({
				check,
				severity: "warn",
				what: `${CI_UNREADABLE_LABEL} for ${repo}`,
				detail: "the token in use cannot read this repository's CI, so its PRs show no CI evidence and cannot hand off",
				fix: `give the token gh uses CI read access (${CI_READ_NEEDED}), then re-run /doctor`,
			});
			continue;
		}
		const verdict = readCiConfigured(result);
		if (verdict.state === "none") findings.push({ check, severity: "ok", what: `no CI configured for ${repo} (0 Actions workflows)` });
		else if (verdict.state === "present") findings.push({ check, severity: "ok", what: `CI readable for ${repo} (${verdict.workflow_count} workflow(s))` });
		else {
			findings.push({
				check,
				severity: "warn",
				what: `CI state unknown for ${repo}: the Actions read failed (${verdict.cause})`,
				fix: "check `gh auth status` and the network, then re-run /doctor",
			});
		}
	}
	return findings;
}
