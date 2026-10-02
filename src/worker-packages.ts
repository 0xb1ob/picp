/**
 * Optional worker packages (cp-5hui), scoped per role (cp-role-scoped-guidance).
 *
 * A worker is spawned with `--no-extensions --no-skills`, so pi's ordinary
 * discovery of user-level packages is off. Two packages this home may have
 * installed for the parent — `pi-caveman` and `@dietrichgebert/ponytail` — are
 * useful to *some* workers, so we pass them explicitly with `-e` (never `--skill`)
 * WHEN PI'S OWN PACKAGE MANAGER RESOLVES THEM **AND** THE ROLE ACTIVATES THEM,
 * and change nothing at all otherwise. cp-worker-skills added pi-lens and
 * pi-web-access; its single skills were dropped again (skillreads-vqy).
 *
 * **Availability is not activation.** Detection answers "what does this home
 * have installed"; `ROLE_PACKAGES` answers "what does this role load". They
 * are separate because the two questions have different answers: caveman
 * compresses prose, which conflicts with a planner's complete plan and a
 * reviewer's evidence-bearing verdict, and generic minimalism guidance can
 * bias a review toward "delete it" before the evidence says so. So a planner
 * and a gate-reviewer load neither package; an implementer loads ponytail,
 * whose minimal / root-cause bias is what an implementer is for. The planner
 * role (planner and qa profiles) loads pi-web-access for public docs (cp-if9x).
 *
 * Precedence, highest first:
 *  1. **profile** — `packages: [...]` in a profile's frontmatter replaces the
 *     role default outright (`packages: []` means "none"); an unknown name
 *     matches nothing, exactly like an uninstalled one.
 *  2. **role** — `ROLE_PACKAGES[role]`, the default when a profile is silent.
 *  3. **availability** — a package the home does not have is silence.
 *
 * A **brief cannot change activation at all**: resources are argv, fixed at
 * spawn, and a brief arrives afterwards. What a brief and a profile body *do*
 * outrank is a loaded package's guidance: the role contract wins over any
 * package's output-length advice, so "the summary is at most three lines" and
 * "the artifact is complete" are obeyed even with ponytail loaded.
 *
 * The rules this file exists to keep:
 *  - optional, never required: a missing package is silence, not a warning;
 *  - resolved by pi, never scanned by us (H4): `DefaultPackageManager.resolve()`
 *    over the user `settings.json` (`SettingsManager`, both public exports of
 *    `@earendil-works/pi-coding-agent`) says which packages are configured,
 *    where they are installed, which of their resources the package manifest
 *    and the settings filters enable, and which skills sit in
 *    `~/.pi/agent/skills` — so a worker sees what the parent's pi would load;
 *  - independent: one present and the other absent is an ordinary case;
 *  - trust policy untouched: the required flags stay, and the extra flags are
 *    additive.
 *
 * The CLI fact this file depends on (pi docs shipped with the coding agent):
 *  - `--skill <path>` still loads under `--no-skills`, and `-e` still loads under
 *    `--no-extensions` (`docs/cli.md` flags, pi 0.87: "Explicit `--skill` paths
 *    still load", "Explicit `-e` paths still load"). That is why passing them
 *    alongside the frozen trust flags loads the resource without relaxing discovery.
 *
 * `tests/worker-packages.test.ts` pins it against those docs, and resolves the
 * real installed layout when this machine happens to have it.
 *
 * WHEN detection runs: once, started at CommandPost construction (src/command-post.ts).
 * That is deliberate — it is a startup snapshot, so a package installed while
 * the parent session is running is not seen until the parent restarts, exactly
 * like the parent's own package loading. It keeps every spawn free of
 * filesystem work and keeps a fleet's workers consistent with each other.
 * `WorkerManagerOptions.optionalPackages` is a plain value, so a caller that
 * wants a different policy passes a freshly detected one.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Role } from "./contracts.ts";
import { webSearchAvailability } from "./web-provider.ts";

/** Compared with profile mtimes by doctor; never reset when doctor is invoked. */
export const WORKER_PACKAGES_LOADED_AT = Date.now();

/** Package names we look for. Presence here is availability, never activation. */
export const OPTIONAL_WORKER_PACKAGES: readonly string[] = Object.freeze([
	"pi-caveman",
	"@dietrichgebert/ponytail",
	"pi-lens",
	"pi-web-access",
	"pi-hashline-edit-pro",
]);

/**
 * Never activated for any worker, whatever a role or profile names: planning,
 * brainstorming and review-requesting skills are the parent's loop, not a
 * worker's; an ask-the-user dialog has no human behind a headless worker; goal
 * loops and sub-agents are dispatch capability (the recursion guard).
 */
export const NEVER_WORKER_RESOURCES: readonly string[] = Object.freeze([
	"writing-plans",
	"brainstorming",
	"requesting-code-review",
	"rpiv-ask-user-question",
	"@juicesharp/rpiv-ask-user-question",
	"pi-goal-x",
	"pi-subagents",
	"@tintinweb/pi-subagents",
]);

/** Per-role additions to the never-list: prose compression breaks a complete plan or verdict. */
export const ROLE_NEVER: Readonly<Record<Role, readonly string[]>> = Object.freeze({
	planner: Object.freeze(["pi-caveman", "pi-hashline-edit-pro"]) as readonly string[],
	"gate-reviewer": Object.freeze(["pi-caveman", "pi-hashline-edit-pro"]) as readonly string[],
	implementer: Object.freeze([]) as readonly string[],
});

/**
 * Extra worker argv a package needs to be safe headless.
 *
 * pi-lens: its read guard blocks an edit to a file not read first, and its
 * only per-edit exemption is the `/lens-allow-edit` slash command — which a
 * headless worker has no operator to type. `--no-read-guard` turns the guard
 * off (a CLI value wins over ~/.pi-lens/config.json in pi-lens's own flag
 * resolution), so no edit can wait on that command. `--no-lazy-tools` keeps
 * structural tools such as `ast_grep_search` active for a headless worker.
 * `tests/pi-lens-headless.test.ts` proves both flags against the installed package.
 */
export const PACKAGE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"pi-lens": Object.freeze(["--no-read-guard", "--no-lazy-tools"]) as readonly string[],
});

/**
 * Worker env a package needs. pi-lens writes its logs to
 * `<cwd>/.pi-lens-probe-home` when `PI_LENS_HOME` is unset and the cwd is
 * under the tmp dir or an agent worktree — an untracked dir that would make a
 * worker's tree dirty and refuse its teardown. Pinning `PI_LENS_HOME` to its
 * ordinary home (or the operator's own override) keeps the worktree clean.
 */
export function packageEnv(name: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Record<string, string> | undefined {
	if (name === "pi-lens") return { PI_LENS_HOME: env.PI_LENS_HOME?.trim() || join(home, ".pi-lens") };
	return undefined;
}

/**
 * Tools a package registers, appended to the profile's `--tools` allowlist
 * only when that package is activated (and installed). pi-lens uses the pi
 * package tool names; pi-web-access uses its defaults. A renamed-tools config
 * in pi-web-access is not followed. The planner role (planner, qa) loads
 * pi-web-access (cp-if9x); its lazy loader `web_enable` is deliberately not
 * allowlisted — the `--tools` filter drops it, so the four tools stay active —
 * and an unavailable provider withholds the package (`withheld`).
 * LSP navigation is omitted: pi-lens 4.3.0 refuses server spawns under the
 * worker's required --no-approve trust policy, even with servers installed.
 */
export const PACKAGE_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"pi-lens": Object.freeze(["pi_lens_activate_tools", "lens_diagnostics", "ast_grep_search", "ast_grep_outline"]) as readonly string[],
	"pi-hashline-edit-pro": Object.freeze(["read", "replace", "insert", "anchor_grep", "undo_last_change"]) as readonly string[],
	"pi-web-access": Object.freeze(["web_search", "fetch_content", "get_search_content", "source_check"]) as readonly string[],
});

/** Role defaults; profile overrides still obey ROLE_NEVER and the skill/tool limits below. */
export const ROLE_PACKAGES: Readonly<Record<Role, readonly string[]>> = Object.freeze({
	planner: Object.freeze(["pi-lens", "pi-web-access"]) as readonly string[],
	"gate-reviewer": Object.freeze(["pi-lens"]) as readonly string[],
	implementer: Object.freeze([
		"@dietrichgebert/ponytail",
		"pi-lens",
		"pi-hashline-edit-pro",
	]) as readonly string[],
});

/** Extension entry points and skill directories to add to a worker's argv. */
export interface OptionalWorkerPackages {
	/** Absolute paths passed as `-e <path>`. */
	readonly extensions: readonly string[];
	/** Absolute paths passed as `--skill <path>`. */
	readonly skills: readonly string[];
	/** Extra argv (`PACKAGE_FLAGS`); absent when none. */
	readonly flags?: readonly string[];
	/** Tools added to the allowlist (`PACKAGE_TOOLS`); absent when none. */
	readonly tools?: readonly string[];
	/** Worker env additions (`packageEnv`); absent when none. */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * What this home has installed, keyed by package name. A package with nothing
 * resolvable on disk is absent from the record — availability is a fact about
 * files, not about the manifest's intentions.
 */
export type DetectedWorkerPackages = Readonly<Record<string, OptionalWorkerPackages>>;

/**
 * The shared "nothing installed" value. Deep-frozen: it is handed to every
 * manager that did not detect anything, so a future caller pushing into one of
 * these arrays must fail loudly rather than corrupt the default for everyone.
 */
export const NO_OPTIONAL_WORKER_PACKAGES: OptionalWorkerPackages = Object.freeze({
	extensions: Object.freeze([]) as readonly string[],
	skills: Object.freeze([]) as readonly string[],
});

/** The shared "this home has nothing" detection result. */
export const NO_DETECTED_WORKER_PACKAGES: DetectedWorkerPackages = Object.freeze({});

/**
 * Resolve what this home offers a worker through pi's own package manager
 * (`DefaultPackageManager.resolve()` over the user `settings.json`) and return
 * it keyed by name. Never throws, never installs: a missing source is skipped,
 * and any failure is the "nothing installed" value, so the worst case is a
 * worker spawned exactly as if nothing were installed.
 *
 * Only enabled, user-scope resources count: a package's manifest and the
 * settings filters (`pi config`) decide what is enabled, and project settings
 * are never read, since worker packages are this home's, not a worktree's.
 * The user settings are read once into `SettingsManager.inMemory`: a read-only
 * snapshot that never takes the settings.json lock a live pi session holds.
 */
export async function resolveWorkerPackages(agentDir: string = getAgentDir(), options: WorkerPackageOptions = {}): Promise<DetectedWorkerPackages> {
	return (await tryResolveWorkerPackages(agentDir, options)).packages;
}

/** Test and doctor seams: the env and web-search.json path the provider check reads. */
export interface WorkerPackageOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly webConfigPath?: string;
}

/** A resolution that says why it is empty when pi could not resolve (H4 review: never silent). */
export interface WorkerPackageResolution {
	readonly packages: DetectedWorkerPackages;
	readonly error?: string;
	/** Installed but unusable; the reason, never a warning at spawn. */
	readonly withheld?: Readonly<Record<string, string>>;
}

/**
 * pi-web-access's own config path (`utils.ts` `getWebSearchConfigDir`),
 * mirrored branch for branch and never cached.
 */
export function webSearchConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const file = "web-search.json";
	if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, file);
	const legacy = join(home, ".pi");
	const first = (...dirs: string[]) => dirs.find((dir) => existsSync(join(dir, file)));
	if (env.XDG_CONFIG_HOME) {
		const xdg = join(env.XDG_CONFIG_HOME, "pi");
		return join(first(xdg, legacy) ?? xdg, file);
	}
	const agent = join(home, ".pi", "agent");
	return join(first(agent, legacy) ?? agent, file);
}

/** `resolveWorkerPackages`, keeping the failure instead of hiding it. Never rejects. */
export async function tryResolveWorkerPackages(agentDir: string = getAgentDir(), options: WorkerPackageOptions = {}): Promise<WorkerPackageResolution> {
	try {
		const file = join(agentDir, "settings.json");
		const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof SettingsManager.inMemory>[0]) : {};
		const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: false });
		const packages = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
		const resolved = await packages.resolve(async () => "skip");
		const usable = (list: ResolvedResource[]) => list.filter((r) => r.enabled && r.metadata.scope === "user");
		const extensions = usable(resolved.extensions);
		const skills = usable(resolved.skills);
		const detected: Record<string, OptionalWorkerPackages> = {};
		const configured = packages.listConfiguredPackages().filter((p) => p.scope === "user");
		for (const name of OPTIONAL_WORKER_PACKAGES) {
			const root = configured.find((p) => npmName(p.source) === name)?.installedPath;
			if (!root) continue;
			// By real path, not by `metadata.source`: pi dedupes a skill symlinked into
			// ~/.pi/agent/skills to that entry, yet it is still this package's skill.
			const inside = (r: ResolvedResource) => isInside(real(r.path), real(root));
			const own = { extensions: extensions.filter(inside).map((r) => r.path), skills: skills.filter(inside).map((r) => skillPath(r.path)) };
			if (own.extensions.length + own.skills.length === 0) continue;
			const flags = PACKAGE_FLAGS[name];
			const tools = own.extensions.length > 0 ? PACKAGE_TOOLS[name] : undefined;
			const env = packageEnv(name);
			detected[name] = { ...own, ...(flags ? { flags } : {}), ...(tools ? { tools } : {}), ...(env ? { env } : {}) };
		}
		// An unusable provider is absence, like an uninstalled package: no -e, no tools, no spawn warning.
		const withheld: Record<string, string> = {};
		if (detected["pi-web-access"]) {
			const env = options.env ?? process.env;
			const web = webSearchAvailability(options.webConfigPath ?? webSearchConfigPath(env), env);
			if (!web.available) {
				delete detected["pi-web-access"];
				withheld["pi-web-access"] = web.reason;
			}
		}
		return { packages: detected, ...(Object.keys(withheld).length > 0 ? { withheld } : {}) };
	} catch (error) {
		return { packages: NO_DETECTED_WORKER_PACKAGES, error: error instanceof Error ? error.message : String(error) };
	}
}

/** `npm:@scope/name@1.2.3` → `@scope/name`; any other source → undefined. */
function npmName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const at = spec.indexOf("@", 1);
	return at === -1 ? spec : spec.slice(0, at);
}

/** pi resolves a skill to its `SKILL.md`; `--skill` takes the skill's directory as well. */
function skillPath(path: string): string {
	return basename(path) === "SKILL.md" ? dirname(path) : path;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * What one worker actually loads: availability ∩ activation.
 *
 * `override` is the profile's `packages:` frontmatter — present (including
 * empty) it replaces the role default, absent it defers to `ROLE_PACKAGES`.
 * Fails open like the rest of this module: a name nobody installed, and a name
 * nobody has heard of, both resolve to nothing. `NEVER_WORKER_RESOURCES` and
 * `ROLE_NEVER` are subtracted last, so no profile can switch them on.
 */
export function activePackagesForRole(
	detected: DetectedWorkerPackages,
	role: Role,
	override?: readonly string[],
): OptionalWorkerPackages {
	const never = [...NEVER_WORKER_RESOURCES, ...(ROLE_NEVER[role] ?? [])];
	const wanted = (override ?? ROLE_PACKAGES[role] ?? []).filter((name) => !never.includes(name));
	if (wanted.length === 0) return NO_OPTIONAL_WORKER_PACKAGES;
	const extensions: string[] = [];
	const flags: string[] = [];
	const tools: string[] = [];
	const env: Record<string, string> = {};
	// Canonical order loads hashline last: its anchored read overrides built-in read.
	for (const name of OPTIONAL_WORKER_PACKAGES) {
		if (!wanted.includes(name)) continue;
		const found = detected[name];
		if (!found) continue;
		extensions.push(...found.extensions);
		flags.push(...(found.flags ?? []));
		tools.push(...(name === "pi-lens" && role !== "implementer"
			? ["ast_grep_search", "ast_grep_outline"]
			: (found.tools ?? [])));
		Object.assign(env, found.env);
	}
	// No `--skill` for any worker (skillreads-vqy): pi lists each loaded skill with
	// "use the read tool to load it", and some models then read every SKILL.md at
	// session start. The rules those skills carried live in the role profile, and
	// ponytail's extension injects its own mode without its skill file.
	return {
		extensions,
		skills: [],
		...(flags.length > 0 ? { flags } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(Object.keys(env).length > 0 ? { env } : {}),
	};
}
