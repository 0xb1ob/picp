/**
 * Project registry and clone-on-demand.
 *
 * Ported policy (command-post AGENTS.md §Project management + `cmdp check`):
 *
 *  - Clone on demand into `projects/<name>`; **one canonical clone per name**.
 *    Extra checkouts are how a lease ends up in the wrong tree.
 *  - `project:<name>` br labels must match a registered Name.
 *  - Never clone into the command post root, and never lease from `~/<name>`.
 *  - The "belongs to another repo" family of traps is detected mechanically:
 *    a nested clone, a linked worktree pretending to be a clone, a shared
 *    git-common-dir, or a symlink into the operator's own checkout.
 *
 * `data/projects.json` is the machine registry; `data/projects.md` is a
 * rendered view for humans and is never read back.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type Delivery,
	DELIVERIES,
	isoTimestamp,
	isSafeProjectName,
	LAYOUT,
	PROJECT_NAME_PATTERN,
	type Project,
	type ProjectRegistryFile,
	paths,
	SCHEMA_VERSION,
	validateProjectRegistry,
} from "./contracts.ts";
import { atomicWriteJson, atomicWriteText, canonicalDir, queued } from "./json-store.ts";

export class ProjectError extends Error {}

export const DEFAULT_CLONE_TIMEOUT_MS = 300_000;

export interface ProjectRegistryOptions {
	/** Command post home; the registry is `<home>/data/projects.json`. */
	home: string;
	now?: () => Date;
	gitBin?: string;
	cloneTimeoutMs?: number;
}

export interface RegisterInput {
	name: string;
	clone_url: string;
	delivery?: Delivery;
	notes?: string;
	base_branch?: string;
}

export interface EnsureCloneResult {
	project: Project;
	/** Canonical, symlink-resolved path of the clone. */
	path: string;
	/** True when this call created the clone. */
	cloned: boolean;
}

/** Synchronous git for fact checks; they are local and must not be racy. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | undefined {
	try {
		return git(cwd, ...args);
	} catch {
		return undefined;
	}
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Traps 3–5 of the canonical-clone check, for an absolute path: the path is
 * its own git toplevel (not nested), `.git` is a directory (not a linked
 * worktree), and the common dir is that `.git` (not another repo's).
 * Returns the realpath. `label` names the path in messages.
 */
export function assertCanonicalRepo(path: string, label: string = path): string {
	const abs = realpathOrSelf(path);
	if (!isDirectory(abs)) throw new ProjectError(`${label}: not a directory (${abs})`);
	const toplevel = tryGit(abs, "rev-parse", "--show-toplevel");
	if (!toplevel) throw new ProjectError(`not a git clone: ${abs}`);
	const toplevelAbs = realpathOrSelf(toplevel);
	if (toplevelAbs !== abs) {
		throw new ProjectError(`nested wrong git: ${abs} is inside ${toplevelAbs} — ${label} must be its own clone`);
	}
	const gitDir = join(abs, ".git");
	if (!isDirectory(gitDir)) {
		throw new ProjectError(
			`${label} is not a primary clone (${gitDir} is not a directory; it belongs to another repo as a linked worktree) — launch from the main worktree of the repository`,
		);
	}
	const common = tryGit(abs, "rev-parse", "--git-common-dir");
	if (!common) throw new ProjectError(`cannot resolve git-common-dir for ${abs}`);
	const commonAbs = realpathOrSelf(isAbsolute(common) ? common : resolve(abs, common));
	if (commonAbs !== realpathOrSelf(gitDir)) {
		throw new ProjectError(
			`${label} git-common-dir is ${commonAbs}, not ${gitDir} — it belongs to another repo. Lease only from the canonical clone.`,
		);
	}
	return abs;
}

export class ProjectRegistry {
	readonly home: string;
	readonly file: string;
	readonly viewFile: string;
	readonly #now: () => Date;
	readonly #options: ProjectRegistryOptions;

	constructor(options: ProjectRegistryOptions) {
		this.home = canonicalDir(options.home);
		this.file = join(this.home, LAYOUT.projectsFile);
		this.viewFile = join(this.home, LAYOUT.projectsView);
		this.#now = options.now ?? (() => new Date());
		this.#options = options;
	}

	get exists(): boolean {
		return existsSync(this.file);
	}

	read(): ProjectRegistryFile {
		if (!existsSync(this.file)) {
			return { schema_version: SCHEMA_VERSION, updated_at: "1970-01-01T00:00:00Z", projects: [] };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new ProjectError(`${this.file} is not valid JSON (${(error as Error).message}); refusing to guess`);
		}
		const version = (parsed as { schema_version?: unknown }).schema_version;
		if (typeof version === "number" && version > SCHEMA_VERSION) {
			throw new ProjectError(`${this.file} is schema_version ${version}; this build reads ${SCHEMA_VERSION}`);
		}
		const result = validateProjectRegistry(parsed);
		if (!result.ok) {
			throw new ProjectError(`${this.file} violates the registry contract:\n  ${result.errors.join("\n  ")}`);
		}
		return result.value;
	}

	list(): Project[] {
		return this.read().projects;
	}

	get(name: string): Project | undefined {
		return this.read().projects.find((project) => project.name === name);
	}

	/** Fail-closed lookup: `project:<name>` labels must name a registered repo. */
	require(name: string): Project {
		const project = this.get(name);
		if (!project) {
			const known = this.list().map((entry) => entry.name);
			throw new ProjectError(
				`unknown project "${name}" — register it before dispatching; known: ${known.join(", ") || "(none)"}`,
			);
		}
		return project;
	}

	/** Names for the ledger's `knownProjects` gate (T9): every registration, archived included. */
	names(): string[] {
		return this.list().map((project) => project.name);
	}

	/** Names a periodic poller should visit: archived registrations are skipped. */
	activeNames(): string[] {
		return this.list().filter((project) => !project.archived).map((project) => project.name);
	}

	/** Names refused for new work (jobs, mandates, dispatch). */
	archivedNames(): string[] {
		return this.list().filter((project) => project.archived).map((project) => project.name);
	}

	/** Archive or unarchive; the clone, records and history are untouched. */
	async setArchived(name: string, archived: boolean): Promise<Project> {
		await this.mutate((projects) => {
			const index = projects.findIndex((entry) => entry.name === name);
			if (index === -1) throw new ProjectError(`unknown project "${name}"`);
			const { archived: _drop, ...rest } = projects[index] as Project;
			projects[index] = archived ? { ...rest, archived: true } : rest;
		});
		return this.require(name);
	}

	/** Absolute path of the canonical clone (whether or not it exists yet). */
	pathOf(name: string): string {
		return join(this.home, paths.projectDir(name));
	}

	async mutate(mutator: (projects: Project[]) => Project[] | void): Promise<ProjectRegistryFile> {
		return queued(this.file, async () => {
			const current = this.read();
			const draft = structuredClone(current.projects) as Project[];
			const returned = mutator(draft);
			const next: ProjectRegistryFile = {
				schema_version: SCHEMA_VERSION,
				updated_at: isoTimestamp(this.#now()),
				projects: returned ?? draft,
			};
			const result = validateProjectRegistry(next);
			if (!result.ok) {
				throw new ProjectError(`refusing to write an invalid project registry:\n  ${result.errors.join("\n  ")}`);
			}
			atomicWriteJson(this.file, result.value);
			// The human view is derived on every write and never read back.
			atomicWriteText(this.viewFile, renderRegistry(result.value));
			return result.value;
		});
	}

	/**
	 * Register a project. The name is the directory under `projects/`, the br
	 * label value and the fleet key, so it is validated here; a duplicate name
	 * or a remote already registered under another name is refused (that is the
	 * "one canonical clone" rule, made mechanical).
	 */
	async register(input: RegisterInput): Promise<Project> {
		if (!isSafeProjectName(input.name)) {
			throw new ProjectError(
				`invalid project name ${JSON.stringify(input.name)}: must match ${PROJECT_NAME_PATTERN} (it is also the projects/<name> directory and the br project: label)`,
			);
		}
		const delivery = input.delivery ?? "pr";
		if (!(DELIVERIES as readonly string[]).includes(delivery)) {
			throw new ProjectError(`delivery ${JSON.stringify(delivery)} must be one of ${DELIVERIES.join("|")}`);
		}
		// cp-u3o4: `answer` is chosen per question (cp_ask), never as a repository's
		// default for ordinary work — a project whose every job delivered an answer
		// card would never ship anything.
		if (delivery === "answer") {
			throw new ProjectError(
				`project ${input.name}: a default delivery is "pr" or "local" — delivery:answer is per-question (cp_ask), not a repository default`,
			);
		}
		const cloneUrl = input.clone_url.trim();
		if (cloneUrl.length === 0) throw new ProjectError(`project ${input.name} needs a clone url`);

		const project: Project = {
			name: input.name,
			clone_url: cloneUrl,
			delivery,
			registered_at: isoTimestamp(this.#now()),
			...(input.notes !== undefined ? { notes: input.notes } : {}),
			...(input.base_branch !== undefined ? { base_branch: input.base_branch } : {}),
		};
		await this.mutate((projects) => {
			const existing = projects.find((entry) => entry.name === input.name);
			if (existing) {
				throw new ProjectError(
					existing.clone_url === cloneUrl
						? `project "${input.name}" is already registered (${existing.clone_url}); update it instead of re-registering`
						: `project "${input.name}" is already registered with a different remote (${existing.clone_url}); one canonical clone per name`,
				);
			}
			const sameRemote = projects.find((entry) => entry.clone_url === cloneUrl);
			if (sameRemote) {
				throw new ProjectError(
					`${cloneUrl} is already registered as "${sameRemote.name}" — one canonical clone per remote; retire the extra checkout instead of adding a second name`,
				);
			}
			projects.push(project);
		});
		return this.require(input.name);
	}

	async update(name: string, patch: Partial<Omit<Project, "name" | "registered_at">>): Promise<Project> {
		await this.mutate((projects) => {
			const index = projects.findIndex((entry) => entry.name === name);
			if (index === -1) throw new ProjectError(`unknown project "${name}"`);
			const current = projects[index] as Project;
			const next: Project = { ...current };
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) continue;
				(next as unknown as Record<string, unknown>)[key] = value;
			}
			projects[index] = next;
		});
		return this.require(name);
	}

	/** Deregister. The clone on disk is left alone — deleting work is manual. */
	async remove(name: string): Promise<void> {
		await this.mutate((projects) => {
			const index = projects.findIndex((entry) => entry.name === name);
			if (index === -1) throw new ProjectError(`unknown project "${name}"`);
			projects.splice(index, 1);
		});
	}

	/**
	 * The ported `assertCanonicalClone`. Every trap here has cost somebody a
	 * dispatch into the wrong tree:
	 *
	 *  1. clone must live at `<home>/projects/<name>` (not `~/<name>`)
	 *  2. it must not be a symlink to the operator's own checkout
	 *  3. `git rev-parse --show-toplevel` must be the clone itself (not nested)
	 *  4. `.git` must be a directory (a file means a linked worktree)
	 *  5. `git-common-dir` must be that `.git` (not a secondary worktree of
	 *     another repo — "belongs to another repo")
	 */
	assertCanonicalClone(name: string): string {
		if (!isSafeProjectName(name)) {
			throw new ProjectError(`invalid project name ${JSON.stringify(name)}: must match ${PROJECT_NAME_PATTERN}`);
		}
		const clone = this.pathOf(name);
		if (!isDirectory(clone)) {
			throw new ProjectError(
				`project clone not at ${clone} (command post home ${this.home}). Clone into projects/${name}, not ~/${name}.`,
			);
		}
		const cloneAbs = realpathOrSelf(clone);

		const operatorClone = join(homedir(), name);
		if (isDirectory(operatorClone) && realpathOrSelf(operatorClone) === cloneAbs) {
			throw new ProjectError(
				`projects/${name} resolves to ~/${name} (${cloneAbs}). Lease only from the command post's own clone.`,
			);
		}

		return assertCanonicalRepo(cloneAbs, `projects/${name}`);
	}

	/** The clone's `origin` remote, when it has one. */
	originUrl(name: string): string | undefined {
		const clone = this.pathOf(name);
		if (!isDirectory(clone)) return undefined;
		return tryGit(clone, "remote", "get-url", "origin");
	}

	/**
	 * Clone on demand. Idempotent: an existing canonical clone is verified and
	 * returned. A directory that is not the registered remote's canonical clone
	 * is never "fixed" automatically — it is reported, because the recovery
	 * (retire the extra checkout, re-lease) is an operator decision.
	 */
	async ensureClone(name: string): Promise<EnsureCloneResult> {
		const project = this.require(name);
		const target = this.pathOf(name);

		if (existsSync(target)) {
			const path = this.assertCanonicalClone(name);
			const origin = tryGit(path, "remote", "get-url", "origin");
			if (origin && !sameRemote(origin, project.clone_url)) {
				throw new ProjectError(
					`projects/${name} already exists but its origin is ${origin}, not the registered ${project.clone_url} — that is a different repo. Retire the extra checkout or fix the registration.`,
				);
			}
			return { project, path, cloned: false };
		}

		await this.#clone(project.clone_url, target);
		const path = this.assertCanonicalClone(name);
		return { project, path, cloned: true };
	}

	/** Register (if new) and clone (if missing) in one step. */
	async ensureProject(input: RegisterInput): Promise<EnsureCloneResult> {
		if (!this.get(input.name)) await this.register(input);
		return this.ensureClone(input.name);
	}

	async #clone(url: string, target: string): Promise<void> {
		const bin = this.#options.gitBin ?? "git";
		const timeout = this.#options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
		await new Promise<void>((resolvePromise, reject) => {
			execFile(bin, ["clone", url, target], { timeout, cwd: this.home }, (error, _stdout, stderr) => {
				if (error) {
					reject(new ProjectError(`git clone ${url} -> ${target} failed: ${stderr.trim() || error.message}`));
					return;
				}
				resolvePromise();
			});
		});
	}
}

/** `.git` suffix and a trailing slash are noise, not identity. */
export function sameRemote(a: string, b: string): boolean {
	return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(url: string): string {
	return url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
}

const VIEW_HEADER = `# Projects

<!--
Rendered from data/projects.json by pi-command-post (T10). This file is a VIEW:
edit the registry through the project tools, never here. Never committed.

- Name: slug; the projects/<name> directory AND the br project:<name> label
- Clone URL: git remote we clone/fetch from
- Path: derived from the name, never stored (relative to the command post home)
- Delivery: pr | local | pipeline (default for jobs in this repo)
- Notes: freeform
-->
`;

/** Human-readable table, ported from command-post's data/projects.md. */
export function renderRegistry(registry: ProjectRegistryFile): string {
	const rows = registry.projects.map((project) =>
		`| ${project.name} | ${project.clone_url} | ${paths.projectDir(project.name)} | ${project.delivery} | ${escapeCell(project.notes ?? "")} |`,
	);
	return [
		VIEW_HEADER,
		`_updated ${registry.updated_at}_`,
		"",
		"| Name | Clone URL | Path | Delivery | Notes |",
		"|------|-----------|------|----------|-------|",
		...rows,
		"",
	].join("\n");
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/**
 * One operator-facing block for `cp_project` (cp-sdm). Facts only: the name a
 * `project:` label must use, where the canonical clone is, and whether it is on
 * disk yet — `projects/` is a clone-on-demand cache, so "absent" is normal, not
 * broken.
 */
export function formatProjects(
	projects: readonly Project[],
	options: { cloneExists?: (project: Project) => boolean; pathOf?: (project: Project) => string } = {},
): string {
	if (projects.length === 0) {
		return "no projects registered. Register one with cp_project add (name, clone_url, delivery) before dispatching.";
	}
	const lines = [`${projects.length} project(s):`];
	for (const project of projects) {
		const clone = options.cloneExists ? (options.cloneExists(project) ? "cloned" : "not cloned yet") : "";
		lines.push(
			`  ${project.name}${project.archived ? " [archived]" : ""}  delivery:${project.delivery}  ${options.pathOf?.(project) ?? paths.projectDir(project.name)}${clone ? ` (${clone})` : ""}`,
			`    ${project.clone_url}${project.base_branch ? `  base=${project.base_branch}` : ""}`,
		);
	}
	return lines.join("\n");
}

/** The result of registering (or adopting) one project, as one line. */
export function formatEnsured(result: EnsureCloneResult): string {
	return [
		`${result.project.name} ready (delivery:${result.project.delivery})`,
		`  clone: ${result.path} (${result.cloned ? "cloned now" : "already present"})`,
		`  url:   ${result.project.clone_url}`,
		`  use it with the br label project:${result.project.name}`,
	].join("\n");
}
