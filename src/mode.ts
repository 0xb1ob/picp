/**
 * Mode resolution. One mode is left: **multi-project** (a home with
 * `projects/<name>` clones). Single-project mode (spec 2026-09-04) was removed
 * (cp-8knh): `CP_MODE=single`, a `settings.json` saying `single`, a launch
 * inside a plain git repository and a former single-project home used as
 * `CP_HOME` are all refused with a `ModeError`. `resolveRuntime` decides once,
 * before anything reads a path:
 *
 *   1. `CP_MODE` (`multi|auto`; `single` refused) — any other value ends startup;
 *   2. `<toplevel-or-cwd>/.pi-command-post/settings.json` `{ mode }` — read
 *      only (`single` refused); garbage is reported and ignored;
 *   3. the default: `CP_HOME`, the source checkout, or an existing multi home;
 *      a git repository is refused; else multi on today's default home.
 *
 * Everything here is pure over an injected `git` runner and the filesystem;
 * nothing imports pi.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ENV_MODE,
	isInside,
	type Layout,
	layoutFor,
	MODE_SETTINGS,
	type ModeSetting,
	type Runtime,
	runtimeDirFor,
	type RuntimeSource,
	validateModeSettings,
	validateRuntime,
} from "./contracts.ts";
import { describeHome, enclosingHome, isManagedInstall, PACKAGE_ROOT } from "./home.ts";

export class ModeError extends Error {}

export type GitRunner = (cwd: string, args: readonly string[]) => string | undefined;

/** Real git, quiet: a failure (not a repo, no remote) is `undefined`, never a throw. */
export const defaultGit: GitRunner = (cwd, args) => {
	try {
		const out = execFileSync("git", [...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
};

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/**
 * The layout a directory is read with *before* the mode is known. Flat only
 * for a candidate standard home: named `.pi-command-post`, not a git
 * repository (a git repository keeps its nested root whatever it is
 * called), and not another home's nested runtime root (`enclosingHome`).
 */
function preModeLayout(dir: string): Layout {
	const flat = runtimeDirFor(dir) === "" && !existsSync(join(dir, ".git")) && enclosingHome(dir) === undefined;
	return flat ? layoutFor("multi", "") : layoutFor("multi");
}

/** `<dir>/.pi-command-post/settings.json`, or `<dir>/settings.json` for a flat standard home (`preModeLayout`). */
export function settingsPath(dir: string): string {
	return join(dir, preModeLayout(dir).runtimeDir, "settings.json");
}

export function readModeSettings(dir: string): { mode: ModeSetting } | { error: string } | undefined {
	const file = settingsPath(dir);
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { error: `${file} is not JSON (${(error as Error).message})` };
	}
	const result = validateModeSettings(parsed);
	if (!result.ok) return { error: `${file}: ${result.errors.join("; ")} (mode must be ${MODE_SETTINGS.join("|")})` };
	return { mode: result.value.mode };
}

export const SINGLE_MODE_REMOVED = "single-project mode was removed; the command post runs multi-project homes only";

/**
 * A former single-project home: a git repository whose nested runtime root
 * holds `state/` but no `projects/`, and whose `.git/info/exclude` lists
 * `.pi-command-post/` (what single mode wrote). Read-only.
 */
export function isLegacySingleHome(dir: string): boolean {
	const nested = layoutFor("multi"); // single mode always kept the nested root
	if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, nested.state)) || existsSync(join(dir, nested.projects))) {
		return false;
	}
	try {
		return readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
			.split("\n")
			.some((line) => line.trim() === `${nested.runtimeDir}/`);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Repository facts
// ---------------------------------------------------------------------------

export function gitToplevel(cwd: string, git: GitRunner = defaultGit): string | undefined {
	if (!existsSync(cwd)) return undefined;
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	return top ? realpathOrSelf(top) : undefined;
}

/** A multi home has `projects/` and `state/` under its runtime root (`preModeLayout`); nothing else is taken as evidence. */
export function isMultiHomeDir(dir: string): boolean {
	const layout = preModeLayout(dir);
	return existsSync(join(dir, layout.projects)) && existsSync(join(dir, layout.state));
}


// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveRuntimeOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	packageRoot?: string;
	git?: GitRunner;
}

function finish(runtime: Runtime): Runtime {
	const result = validateRuntime(runtime);
	if (!result.ok) throw new ModeError(`internal: runtime record invalid: ${result.errors.join("; ")}`);
	return Object.freeze(result.value);
}

function multi(home: string, source: RuntimeSource, reason: string): Runtime {
	return finish({ mode: "multi", home: resolve(home), source, reason });
}

export function resolveRuntime(options: ResolveRuntimeOptions): Runtime {
	const env = options.env ?? process.env;
	const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT);
	const git = options.git ?? defaultGit;
	const cwd = realpathOrSelf(resolve(options.cwd));
	const toplevel = gitToplevel(cwd, git);
	const anchor = toplevel ?? cwd;

	// 1. CP_MODE
	const envMode = (env[ENV_MODE] ?? "").trim();
	let forced: ModeSetting | undefined;
	let source: RuntimeSource | undefined;
	if (envMode.length > 0) {
		if (!(MODE_SETTINGS as readonly string[]).includes(envMode)) {
			throw new ModeError(`${ENV_MODE} must be multi or auto, got ${JSON.stringify(envMode)}`);
		}
		if (envMode === "single") {
			throw new ModeError(`${SINGLE_MODE_REMOVED}: ${ENV_MODE}=single — unset ${ENV_MODE} or set ${ENV_MODE}=multi`);
		}
		if (envMode !== "auto") {
			forced = envMode as ModeSetting;
			source = "CP_MODE";
		}
	}

	// 2. settings.json in the launch directory's toplevel (or the directory itself)
	let note = "";
	if (!forced) {
		const settings = readModeSettings(anchor);
		if (settings && "error" in settings) note = ` (settings.json ignored: ${settings.error})`;
		else if (settings && settings.mode === "single") {
			throw new ModeError(
				`${SINGLE_MODE_REMOVED}: ${settingsPath(anchor)} says single — delete it or write {"schema_version":1,"mode":"multi"}`,
			);
		} else if (settings && settings.mode !== "auto") {
			forced = settings.mode;
			source = "settings";
		}
	}

	// A former single-project home is refused only where it is named as the home (CP_HOME):
	// the checkout and home-dir paths are multi evidence of their own and never probed.
	const cpHome = env.CP_HOME && env.CP_HOME.length > 0 ? env.CP_HOME : undefined;
	if (cpHome && isLegacySingleHome(resolve(cpHome))) {
		throw new ModeError(
			`${cpHome} is a former single-project home — ${SINGLE_MODE_REMOVED}; its state is not migrated. Point CP_HOME at a multi home`,
		);
	}

	if (forced === "multi") {
		const fallback = cpHome ? { home: cpHome, reason: "CP_HOME" } : describeHome(env, packageRoot);
		return multi(
			fallback.home,
			source as RuntimeSource,
			`${source === "CP_MODE" ? ENV_MODE : "settings.json"} says multi; home ${resolve(fallback.home)} (${fallback.reason})`,
		);
	}

	// 3. auto
	if (env.CP_HOME && env.CP_HOME.length > 0) return multi(env.CP_HOME, "CP_HOME", `CP_HOME is set; it wins over every default${note}`);
	if (!isManagedInstall(packageRoot) && isInside(cwd, packageRoot)) {
		// The standard app (`~/.pi-command-post/app`) is never a home itself: describeHome names the standard home.
		const home = describeHome(env, packageRoot);
		const why = home.source === "checkout" ? "running inside the source checkout; the package root is the home" : home.reason;
		return multi(home.home, home.source, `${why}${note}`);
	}
	if (isMultiHomeDir(cwd)) return multi(cwd, "home-dir", `this directory is already a command-post home (projects/ and state/ under its runtime root)${note}`);
	if (toplevel) {
		const legacy = isLegacySingleHome(toplevel)
			? `; ${toplevel}/.pi-command-post/ holds a former single-project home's state, which is not migrated`
			: "";
		throw new ModeError(
			`${toplevel} is a git repository, not a command-post home — ${SINGLE_MODE_REMOVED}. Run the command post from its home (bin/cp-operator, or CP_HOME=<home>), or set CP_MODE=multi to use ${describeHome(env, packageRoot).home}${legacy}`,
		);
	}
	const fallback = describeHome(env, packageRoot);
	return multi(fallback.home, fallback.source, `${fallback.reason}${note}`);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** One operator-facing line for /cp-version and /doctor. */
export function describeRuntime(runtime: Runtime): string {
	return `multi-project mode, home ${runtime.home} (source: ${runtime.source}; ${runtime.reason})`;
}

/** The `project` argument every tool and command takes: required (a registered project name). */
export function resolveProjectArg(_runtime: Runtime, given: string | undefined, what: string): string {
	const value = given?.trim();
	if (!value) throw new ModeError(`${what} needs \`project\` (a registered project name)`);
	return value;
}

// ---------------------------------------------------------------------------
// The parent's contract (D8)
// ---------------------------------------------------------------------------

export interface ContractInjectionEvent {
	systemPrompt: string;
	contextFiles?: ReadonlyArray<{ path: string }>;
}

export interface ContractInjectionOptions {
	packageRoot: string;
	runtime: Runtime;
	/** Injected in tests; production reads `<packageRoot>/AGENTS.md`. `undefined` means "no contract". */
	readContract?: () => string | undefined;
}

/**
 * pi loads context files from the working directory and its parents only, so
 * a parent launched anywhere but this checkout has no AGENTS.md. When the
 * package's own AGENTS.md is not among the loaded context files, append it to
 * the chained system prompt; when it is, return nothing and change nothing.
 */
/**
 * The same, for a runtime that may not exist. A refused mode (`CP_MODE` or
 * settings `single`, a plain git repository, a former single-project home, an
 * invalid `CP_MODE`) has already ended startup with its message; this hook runs
 * on **every** prompt afterwards, and re-raising the same refusal from it would
 * repeat a decision that was made once. No runtime means no injection: the agent
 * runs on pi's own prompt, and nothing throws.
 */
export function contractInjectionOrNone(
	event: ContractInjectionEvent,
	options: Omit<ContractInjectionOptions, "runtime"> & { runtime: () => Runtime },
): { systemPrompt: string } | undefined {
	let runtime: Runtime;
	try {
		runtime = options.runtime();
	} catch {
		return undefined;
	}
	const { runtime: _getter, ...rest } = options;
	return contractInjection(event, { ...rest, runtime });
}

/**
 * Is **this package's** `AGENTS.md` among the loaded context files?
 *
 * Compared by realpath, never by suffix: a project's own `AGENTS.md` is a
 * different file with the same basename, and treating it as the parent's
 * contract would both skip the injection and silence the "the parent runs
 * without its operating contract" warning.
 */
export function packageContractLoaded(
	contextFiles: ReadonlyArray<{ path: string }> | undefined,
	packageRoot: string,
): boolean {
	const contractPath = realpathOrSelf(join(packageRoot, "AGENTS.md"));
	return (contextFiles ?? []).some((file) => realpathOrSelf(file.path) === contractPath);
}

export function contractInjection(
	event: ContractInjectionEvent,
	options: ContractInjectionOptions,
): { systemPrompt: string } | undefined {
	const contractPath = realpathOrSelf(join(options.packageRoot, "AGENTS.md"));
	if (packageContractLoaded(event.contextFiles, options.packageRoot)) return undefined;
	const read =
		options.readContract ??
		(() => {
			try {
				return readFileSync(contractPath, "utf8");
			} catch {
				return undefined;
			}
		});
	const contract = read();
	if (contract === undefined) return undefined;
	return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
}
