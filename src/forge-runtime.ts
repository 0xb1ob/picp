/**
 * Project-scoped forge composition (forge PR 2, PR 3): which observer reads a
 * job's change request, which base a project lands on, and where a GitLab job
 * leaves the gh-only paths (intake listing, CI reads, merge asks). Nonsecret
 * helpers over the existing registry — no store, no token; `token_env` stays a
 * variable name until the GitLab transport reads it. Provider checks live here,
 * never in a render path.
 */

import { type PrObservation, prReceiptOf, type WatchableRecord } from "./ci-watch.ts";
import { type ForgeResolution, parseChangeRequestUrl, parseRemote, resolveForgeRepository } from "./forge-url.ts";
import { type ForgeObserver, type ObserverPorts, observerFor } from "./forges/adapter.ts";
import { githubObserver } from "./forges/github.ts";
import { type GitlabTransport, gitlabObserver } from "./forges/gitlab.ts";
import { ProjectRegistry } from "./projects.ts";

function registryEntry(home: string, project: string) {
	try {
		const registry = new ProjectRegistry({ home });
		const entry = registry.get(project);
		return entry ? { entry, origin: registry.originUrl(project) } : undefined;
	} catch {
		return undefined; // an unreadable registry is no configuration, never a crash out of a gate
	}
}

/** The registry's `base_branch` for a project, when it names one. */
export function projectBaseBranch(home: string, project: string): string | undefined {
	return registryEntry(home, project)?.entry.base_branch;
}

/**
 * The forge repository a registered project lives on: its actual origin under
 * its `forge` block, which must be the registered repository before any
 * credential is aimed at it. Undefined for an unregistered project.
 */
export function projectForge(home: string, project: string): ForgeResolution | undefined {
	const found = registryEntry(home, project);
	if (!found) return undefined;
	const registered = resolveForgeRepository(found.entry.clone_url, found.entry.forge);
	if (!found.origin || !registered.ok) return registered;
	const actual = resolveForgeRepository(found.origin, found.entry.forge);
	if (actual.ok && (actual.repository.kind !== registered.repository.kind || actual.repository.web_base_url !== registered.repository.web_base_url || actual.repository.path !== registered.repository.path)) {
		return { ok: false, reason: "invalid", detail: `project ${project}: the clone's origin is not the registered repository, so it is not asked` };
	}
	return actual;
}

/**
 * The observer for a job's change request. A resolvable project gets its own
 * forge; anything else keeps the pre-forge behaviour (`gh pr view`) unless the
 * ref is a GitLab MR link, which needs a resolvable project and gets its named failure.
 */
export function changeRequestObserver(home: string, project: string, ref: string, ports: ObserverPorts): ForgeObserver {
	const resolution = projectForge(home, project);
	if (resolution?.ok) return observerFor(resolution, ports);
	if (parseChangeRequestUrl(ref)?.kind !== "gitlab") return githubObserver(ports.run, ports.cwd);
	return observerFor(resolution ?? { ok: false, reason: "unsupported", detail: `project ${project} is not registered, so its GitLab forge is unknown` }, ports);
}

/** The project's GitLab observer (intake), or undefined: a GitHub or unresolvable project keeps its gh resolution. */
export function projectGitlabObserver(home: string, project: string, transport?: GitlabTransport): ForgeObserver | undefined {
	const resolution = projectForge(home, project);
	return resolution?.ok && resolution.repository.kind === "gitlab" ? gitlabObserver(resolution.repository, transport) : undefined;
}

/**
 * A GitLab job: its PR receipt is a GitLab MR link. Intake stores only a verified
 * project MR there for a GitLab project, so the receipt decides with no registry
 * read — this runs per watch tick and on the merge-ask render path.
 */
export function isGitlabJob(record: WatchableRecord | undefined): boolean {
	return parseChangeRequestUrl(record ? (prReceiptOf(record)?.url ?? "") : "")?.kind === "gitlab";
}

/**
 * Why a job's merge ask stays deferred as unknown with no gh query: a GitLab MR in v1,
 * or a non-GitHub project with no forge declared.
 */
export function gitlabCiUnsupported(home: string, record: WatchableRecord | undefined): string | undefined {
	if (isGitlabJob(record)) return "GitLab CI is not read in v1, so CI is unknown; merge the MR on GitLab, and its observed merge withdraws this ask";
	return record && ghCiUnwatched(home, record.project) ? "CI watch disabled: non-GitHub remote, no forge declared, so CI is unknown; declare it with cp_project forge" : undefined;
}

const unwatchedLogged = new Set<string>();

/**
 * True when no gh CI reader may ask about a project: its origin names a non-github.com host and no forge is
 * declared. The skip is logged once per home and project per process, never as a per-tick failure.
 */
export function ghCiUnwatched(home: string, project: string): boolean {
	const found = registryEntry(home, project);
	if (!found || found.entry.forge) return false;
	// An unparsable remote (a local path) keeps the gh reader and its named failure.
	const host = parseRemote(found.origin ?? found.entry.clone_url)?.host;
	if (host === undefined || host === "github.com") return false;
	const key = `${home}\n${project}`;
	if (!unwatchedLogged.has(key)) {
		unwatchedLogged.add(key);
		console.error(`cp: ${project}: CI watch disabled: non-GitHub remote, no forge declared`);
	}
	return true;
}

const NO_GH: ObserverPorts["run"] = async () => ({ status: 1, stdout: "", stderr: "gh is never asked about a GitLab merge request" });

/**
 * The CI watch's PR read. GitHub keeps its REST call; a GitLab MR is read
 * through its observer for its terminal state, mapped onto the REST shape
 * (`merged`, or `state: closed`) the event rule already reads. A failed read
 * throws its named detail, so it is that one job's failure and backoff.
 * `observer` is injected in tests; production asks the project's forge.
 */
export async function watchChangeRequest(home: string, project: string, prUrl: string, github: () => Promise<PrObservation | undefined>, observer?: ForgeObserver): Promise<PrObservation | undefined> {
	if (parseChangeRequestUrl(prUrl)?.kind !== "gitlab") return github();
	const read = await (observer ?? changeRequestObserver(home, project, prUrl, { run: NO_GH, cwd: home })).readChangeRequest(prUrl);
	if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
	const mr = read.observation;
	const landing = mr.merge_commit_sha ?? mr.squash_commit_sha;
	return {
		merged: mr.state === "merged",
		state: mr.state === "open" || mr.state === "unknown" ? mr.state : "closed",
		number: mr.number,
		url: mr.url,
		...(mr.head_sha ? { head_sha: mr.head_sha } : {}),
		...(mr.source_branch ? { head_ref: mr.source_branch } : {}),
		...(landing ? { merge_commit_sha: landing } : {}),
		...(mr.merged_at ? { merged_at: mr.merged_at } : {}),
	};
}
