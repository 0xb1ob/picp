/**
 * Project-scoped forge composition (forge PR 2): which observer reads a job's
 * change request, and which base a project lands on. Nonsecret helpers over the
 * existing registry — no store, no token; `token_env` stays a variable name
 * until the GitLab transport reads it.
 */

import { type ForgeResolution, parseChangeRequestUrl, resolveForgeRepository } from "./forge-url.ts";
import { type ForgeObserver, type ObserverPorts, observerFor } from "./forges/adapter.ts";
import { githubObserver } from "./forges/github.ts";
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
