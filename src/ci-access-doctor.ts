/** `/doctor`'s `ci.<project>` findings (ask-81b54d83f0b2): CI readable, absent, or refused to the token. */

import { ACTIONS_MAX_PAGES, ACTIONS_PER_PAGE, actionsJobsPath, actionsLatestRunPath, parseJobsPage, parseRunsPage } from "./actions-ci.ts";
import type { DoctorFinding } from "./contracts.ts";
import { CI_READ_NEEDED, CI_UNREADABLE_LABEL, ciReadDenied } from "./ci-access.ts";
import { readCiConfigured } from "./ci-configured.ts";
import { githubRepoFromCloneUrl } from "./mandate.ts";
import { ProjectRegistry } from "./projects.ts";

type Run = (command: string, args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
/** Why a read failed: `missing` is no gh at all, `denied` the token, `unknown` anything else. */
type Failed = { failed: "missing" | "denied" | "unknown"; cause: string };
type Read = { stdout: string } | Failed;

function read(run: Run, home: string, endpoint: string): Read {
	const result = run("gh", ["api", endpoint], home);
	if (result.status === null && /\bENOENT\b/.test(result.stderr)) return { failed: "missing", cause: "gh missing" };
	if (result.status === 0) return { stdout: result.stdout };
	if (ciReadDenied(`${endpoint} ${result.stderr} ${result.stdout}`)) return { failed: "denied", cause: "denied" };
	return { failed: "unknown", cause: "command_failed" };
}

/** The latest run's attempt jobs, every page; a parse failure is `unknown` by its category, never the raw body. */
function probeLatestRun(run: Run, home: string, repo: string): Failed | { runs: 0 } | { jobs: number } {
	const [owner = "", name = ""] = repo.split("/");
	try {
		const runsEndpoint = actionsLatestRunPath({ owner, repo: name });
		const runs = read(run, home, runsEndpoint);
		if (!("stdout" in runs)) return runs;
		const latest = parseRunsPage(runs.stdout, undefined, runsEndpoint).items[0];
		if (!latest) return { runs: 0 };
		let jobs = 0;
		for (let page = 1; page <= ACTIONS_MAX_PAGES; page++) {
			const endpoint = actionsJobsPath({ repo: { owner, repo: name }, runId: latest.databaseId, attempt: latest.attempt, page });
			const answer = read(run, home, endpoint);
			if (!("stdout" in answer)) return answer;
			const parsed = parseJobsPage(answer.stdout, { runId: latest.databaseId, attempt: latest.attempt, sha: latest.headSha }, endpoint);
			jobs += parsed.items.length;
			if (parsed.items.length < ACTIONS_PER_PAGE) return jobs === parsed.total ? { jobs } : { failed: "unknown", cause: "incomplete" };
		}
		return { failed: "unknown", cause: "incomplete" };
	} catch (error) {
		return { failed: "unknown", cause: (error as { category?: string }).category ?? "malformed" };
	}
}

/** Workflows, then the newest run and its attempt jobs, per GitHub project; never throws, never prints gh output. */
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
		const denied = { check, severity: "warn" as const, what: `${CI_UNREADABLE_LABEL} for ${repo}`,
			detail: "the token in use cannot read this repository's CI, so its PRs show no CI evidence and cannot hand off",
			fix: `give the token gh uses CI read access (${CI_READ_NEEDED}), then re-run /doctor` };
		const unknown = (cause: string) => ({ check, severity: "warn" as const, what: `CI state unknown for ${repo}: the Actions read failed (${cause})`,
			fix: "check `gh auth status` and the network, then re-run /doctor" });
		if (result.status !== 0 && ciReadDenied(`${endpoint} ${result.stderr} ${result.stdout}`)) {
			findings.push(denied);
			continue;
		}
		const verdict = readCiConfigured(result);
		if (verdict.state === "none") {
			findings.push({ check, severity: "ok", what: `no Actions CI configured for ${repo} (0 Actions workflows)` });
			continue;
		}
		if (verdict.state !== "present") {
			findings.push(unknown(verdict.cause));
			continue;
		}
		const probe = probeLatestRun(run, home, repo);
		const workflows = `${verdict.workflow_count} workflow(s)`;
		if ("jobs" in probe) findings.push({ check, severity: "ok", what: `CI readable for ${repo} (${workflows}; latest run and its ${probe.jobs} job(s) read)` });
		else if ("runs" in probe) findings.push({ check, severity: "ok", what: `Actions workflows readable for ${repo} (${workflows}; no runs yet, so run and job access is untested)` });
		else if (probe.failed === "denied") findings.push(denied);
		else if (probe.failed === "missing") return [];
		else findings.push(unknown(probe.cause));
	}
	return findings;
}
