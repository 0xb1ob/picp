/**
 * Project-grouped reporting (cp-project-grouped-reporting).
 *
 * Every wake-up, escalation and relay names its project first —
 * `[demo-app] cp-78vu: …` — and anything spanning several projects is
 * split into one section per project. The project comes from the job's fleet
 * record, then its `project:` ledger label, then the mandates: one naming the
 * job, else the only project the active mandates cover.
 */
import { FleetStore } from "./fleet.ts";
import { parseJobLabels, readJobsDocument } from "./ledger.ts";
import { MandateStore } from "./mandate.ts";

/** What a message is tagged with when no source names its project. */
export const UNKNOWN_PROJECT = "project unknown";

export type ProjectOf = (jobId: string) => string | undefined;

/** `[a]`, or `[a, b]` for a message spanning several projects. */
export function projectTag(projects: readonly (string | undefined)[]): string {
	const names = [...new Set(projects.map((project) => project ?? UNKNOWN_PROJECT))];
	return `[${names.length > 0 ? names.join(", ") : UNKNOWN_PROJECT}]`;
}

/** Prefix `text` with its project tag. Idempotent: an already-tagged text is unchanged. */
export function withProjectTag(projects: readonly (string | undefined)[], text: string): string {
	const tag = projectTag(projects);
	return text === tag || text.startsWith(`${tag} `) || text.startsWith(`${tag}\n`) ? text : `${tag} ${text}`;
}

/** The deduplicated projects of `jobIds`, an unresolved one named as unknown. */
export function projectsOf(projectOf: ProjectOf, jobIds: readonly (string | undefined)[]): string[] {
	return [...new Set(jobIds.map((id) => (id ? projectOf(id) : undefined) ?? UNKNOWN_PROJECT))];
}

export type MandateProjects = (mandateId: string) => readonly string[] | undefined;

/** An escalation's projects: its job ids' where any resolve, else its mandate's own `projects`. */
export function escalationProjects(
	escalation: { job_ids: readonly string[]; mandate_id?: string },
	projectOf: ProjectOf,
	mandateProjects?: MandateProjects,
): string[] {
	const known = escalation.job_ids.map((id) => projectOf(id)).filter((project): project is string => project !== undefined);
	if (known.length > 0) return [...new Set(known)];
	const granted = escalation.mandate_id ? mandateProjects?.(escalation.mandate_id) : undefined;
	return granted && granted.length > 0 ? [...new Set(granted)] : [UNKNOWN_PROJECT];
}

/**
 * The projects a durable wake-up with no job_id is about, or undefined when it
 * has a job_id (the notifier resolves that one). A mandate 80%/cap notice
 * (`mandate-usage:<id>:…`) names its mandate's projects; a restart-recovery
 * notice names the jobs in its keys.
 */
export function durableWakeupProjects(
	entry: { id: string; kind: string; job_id?: string; keys?: readonly string[] },
	projectOf: ProjectOf,
	mandateProjects?: MandateProjects,
): string[] | undefined {
	if (entry.job_id) return undefined;
	const mandate = entry.id.match(/^mandate-usage:([^:]+):/)?.[1];
	if (mandate) return escalationProjects({ job_ids: [], mandate_id: mandate }, projectOf, mandateProjects);
	return entry.kind === "recovery" && entry.keys?.length ? projectsOf(projectOf, entry.keys) : undefined;
}

/** Items grouped by project, groups in order of first appearance. */
export function groupByProject<T>(items: readonly T[], projectOf: (item: T) => string | undefined): Array<[string, T[]]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const project = projectOf(item) ?? UNKNOWN_PROJECT;
		const group = groups.get(project);
		if (group) group.push(item);
		else groups.set(project, [item]);
	}
	return [...groups];
}

/**
 * The lines `render` gives each item. When the items span more than one
 * project, each project gets its own `  [project]` section header and its
 * rows are indented under it; a single project renders exactly as before.
 */
export function projectGroupedLines<T>(
	items: readonly T[],
	projectOf: ((item: T) => string | undefined) | undefined,
	render: (item: T) => string | string[],
): string[] {
	const flat = (group: readonly T[]): string[] => group.flatMap(render);
	if (!projectOf) return flat(items);
	const groups = groupByProject(items, projectOf);
	if (groups.length <= 1) return flat(items);
	return groups.flatMap(([project, group]) => [`  [${project}]`, ...flat(group).map((line) => `  ${line}`)]);
}

export interface ProjectSources {
	fleet?: ProjectOf;
	ledger?: ProjectOf;
	mandates?: () => ReadonlyArray<{ projects: readonly string[]; job_ids?: readonly string[]; status: string }>;
}

/** Fleet record, then `project:` label, then the mandates. Every source is best-effort. */
export function projectResolver(sources: ProjectSources): ProjectOf {
	const safe = <T>(read: () => T): T | undefined => {
		try {
			return read();
		} catch {
			return undefined;
		}
	};
	let mandates: ReturnType<NonNullable<ProjectSources["mandates"]>> | undefined;
	return (jobId) => {
		const named = safe(() => sources.fleet?.(jobId)) ?? safe(() => sources.ledger?.(jobId));
		if (named) return named;
		mandates ??= safe(() => sources.mandates?.()) ?? [];
		const naming = mandates.find((mandate) => mandate.job_ids?.includes(jobId) && mandate.projects.length === 1);
		if (naming) return naming.projects[0];
		const active = new Set(mandates.filter((mandate) => mandate.status === "active").flatMap((mandate) => mandate.projects));
		return active.size === 1 ? [...active][0] : undefined;
	};
}

/** A mandate's own `projects`, read from `home`; undefined for an unknown or unreadable id. */
export function homeMandateProjects(home: string): MandateProjects {
	return (mandateId) => {
		try {
			return new MandateStore(home).get(mandateId)?.projects;
		} catch {
			return undefined;
		}
	};
}

/** The production resolver: files under `home` only, read lazily, never a subprocess. */
export function homeProjectResolver(home: string): ProjectOf {
	let labels: Map<string, string | undefined> | undefined;
	return projectResolver({
		fleet: (jobId) => new FleetStore({ home }).get(jobId)?.project,
		ledger: (jobId) => {
			labels ??= new Map(readJobsDocument(home).jobs.map((job) => [job.id, parseJobLabels(job.labels).project]));
			return labels.get(jobId);
		},
		mandates: () => new MandateStore(home).list(),
	});
}
