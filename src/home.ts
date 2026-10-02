/**
 * The command post home, resolved in one place.
 *
 * Ported from command-post's `internal/cmdp/home.go`: everything runtime
 * (`data/`, `state/`, `projects/`) lives under one home, and every entry point
 * — the parent extension and the tests — must agree on which one, or two
 * processes will write two different fleets.
 *
 * T30 amendment, and it is load-bearing: the home may **not** default to the
 * package root when the package is an *installed* pi package. `pi install
 * git:...` clones to `~/.pi/agent/git/<host>/<path>`, and pi "resets and cleans
 * the clone" when it reconciles a ref (docs/packages.md §git). A home inside
 * that clone means `pi update --extensions` deletes the fleet, the ledger, the
 * run logs and every artifact. So an installed package keeps its state in a
 * managed home outside the clone, and only a source checkout — where the
 * operator, not pi, owns the directory — uses the package root.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DoctorFinding, LAYOUT, runtimeDirFor } from "./contracts.ts";
import type { CommandRunner } from "./doctor.ts";
import { canonicalDir } from "./json-store.ts";

/** Package root: `src/home.ts` -> `..` */
export const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The retired managed home's directory name under `~/.pi` (machine-local `operator-targets/` only now). */
export const MANAGED_HOME_DIRNAME = "command-post";

/** The standard home's directory name under `$HOME`; the home is its own runtime root. */
export const STANDARD_HOME_DIRNAME = ".pi-command-post";

/**
 * Path fragments pi uses for package installs (docs/packages.md): user installs
 * under `~/.pi/agent/{git,npm}`, project installs under `.pi/{git,npm}`, and
 * `-e npm:`/`-e git:` into a temp dir. Anything living under one of these is
 * pi's to reset, never ours to write state into.
 */
const MANAGED_FRAGMENTS: readonly string[] = Object.freeze([
	`${sep}.pi${sep}agent${sep}git${sep}`,
	`${sep}.pi${sep}agent${sep}npm${sep}`,
	`${sep}.pi${sep}git${sep}`,
	`${sep}.pi${sep}npm${sep}`,
	`${sep}node_modules${sep}`,
]);

export type HomeSource = "CP_HOME" | "standard" | "checkout" | "managed";

export interface HomeResolution {
	home: string;
	source: HomeSource;
	/** Operator-facing: why this home, in one line. */
	reason: string;
	package_root: string;
}

/** True when this package lives somewhere pi installs (and therefore cleans). */
export function isManagedInstall(packageRoot: string = PACKAGE_ROOT): boolean {
	const path = `${resolve(packageRoot)}${sep}`;
	return MANAGED_FRAGMENTS.some((fragment) => path.includes(fragment));
}

/** The standard home, `~/.pi-command-post`: the home *and* its runtime root, with the code at `app/`. */
export function standardHome(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), STANDARD_HOME_DIRNAME);
}

/** True when this package is the standard home's own checkout, `~/.pi-command-post/app`. */
export function isStandardApp(packageRoot: string = PACKAGE_ROOT, env: NodeJS.ProcessEnv = process.env): boolean {
	return canonicalDir(resolve(packageRoot)) === canonicalDir(resolve(standardHome(env), "app"));
}

/**
 * The home a `.pi-command-post`-named directory is the *nested* runtime root
 * of, if any: its parent has `.beads/`, or a `.gitignore` or
 * `.git/info/exclude` listing `.pi-command-post/`. Such a directory is flat by
 * name but belongs to that parent home — `storage.alias` warns on it, and mode
 * resolution never takes it for a flat standard home.
 */
export function enclosingHome(dir: string): { home: string; evidence: string } | undefined {
	if (runtimeDirFor(dir) !== "") return undefined;
	const parent = dirname(resolve(dir));
	if (existsSync(join(parent, ".beads"))) return { home: parent, evidence: ".beads/ present" };
	for (const list of [".gitignore", ".git/info/exclude"]) {
		const file = join(parent, list);
		let text = "";
		try {
			text = existsSync(file) ? readFileSync(file, "utf8") : "";
		} catch {
			continue; // unreadable (e.g. .git is a file): no evidence from it
		}
		if (text.split("\n").some((line) => /^\/?\.pi-command-post\/?$/.test(line.trim()))) return { home: parent, evidence: `${list} lists .pi-command-post/` };
	}
	return undefined;
}

/**
 * The retired managed home, `${PI_HOME:-~/.pi}/command-post`. Kept only so
 * doctor can name it; it holds machine-local `operator-targets/` and no state.
 */
export function legacyManagedHome(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.PI_HOME && env.PI_HOME.length > 0 ? env.PI_HOME : resolve(homedir(), ".pi");
	return resolve(base, MANAGED_HOME_DIRNAME);
}

/** Where an installed package keeps its state: the standard home, outside every clone pi resets. */
export function managedHome(env: NodeJS.ProcessEnv = process.env): string {
	return standardHome(env);
}

/**
 * Resolve the home and say why. `CP_HOME` always wins (tests, and an operator
 * running several fleets); otherwise the standard home's own checkout
 * (`~/.pi-command-post/app`) and an installed package both use the standard
 * home `~/.pi-command-post`, and any other source checkout uses its own root.
 */
export function describeHome(
	env: NodeJS.ProcessEnv = process.env,
	packageRoot: string = PACKAGE_ROOT,
): HomeResolution {
	const override = env.CP_HOME;
	if (override && override.length > 0) {
		return {
			home: resolve(override),
			source: "CP_HOME",
			reason: "CP_HOME is set; it wins over every default",
			package_root: packageRoot,
		};
	}
	if (isStandardApp(packageRoot, env)) {
		return {
			home: standardHome(env),
			source: "standard",
			reason: "the code is the standard home's app/ checkout; the standard home ~/.pi-command-post is the home and its runtime root (set CP_HOME to choose another home)",
			package_root: packageRoot,
		};
	}
	if (isManagedInstall(packageRoot)) {
		return {
			home: managedHome(env),
			source: "managed",
			reason:
				"this is an installed pi package, and pi resets its clone on update — state lives outside it, in the standard home ~/.pi-command-post " +
				"(set CP_HOME to choose another home)",
			package_root: packageRoot,
		};
	}
	return {
		home: resolve(packageRoot),
		source: "checkout",
		reason: "running from a source checkout; the package root is the home",
		package_root: packageRoot,
	};
}

/**
 * The home is this package's root unless it is the standard app or an
 * installed package (then the standard home) or `CP_HOME` overrides it.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
	return describeHome(env).home;
}

/** Has this home ever been scaffolded? Cheap check, used by doctor and the CLI. */
export function homeIsScaffolded(home: string): boolean {
	return existsSync(resolve(home, LAYOUT.state)) && existsSync(resolve(home, LAYOUT.data));
}

/** Local refs only: never fetch, update the checkout, or restart the parent. */
export function homeCheckoutFinding(home: string, packageRoot: string, run: CommandRunner): DoctorFinding | undefined {
	if (canonicalDir(home) !== canonicalDir(packageRoot) || !existsSync(resolve(home, ".git"))) return undefined;
	const unavailable: DoctorFinding = {
		check: "home.checkout", severity: "warn", what: "home checkout comparison with origin/main unavailable",
		fix: "inspect git status and the local origin/main ref in the home, then rerun /doctor or cp_next",
	};
	const status = run("git", ["--no-optional-locks", "status", "--porcelain"], home);
	if (status.status !== 0) return unavailable;
	if (status.stdout.trim()) return undefined;
	const counts = run("git", ["rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"], home);
	if (counts.status !== 0 || !/^\d+\s+\d+$/.test(counts.stdout.trim())) return unavailable;
	const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
	if (ahead !== 0 || !behind) return undefined;
	const manual = "git merge --ff-only origin/main, then restart the parent at a quiet point";
	return {
		check: "home.checkout", severity: "warn", what: `home is ${behind} commits behind origin/main`,
		fix: autoUpdateEnabled(home) ? `auto-update is on (data/update.json): cp-update.timer applies it once the fleet is idle (state/update.json says why not yet); by hand: ${manual}` : manual,
	};
}

function autoUpdateEnabled(home: string): boolean {
	try {
		return (JSON.parse(readFileSync(resolve(home, LAYOUT.data, "update.json"), "utf8")) as { enabled?: unknown } | null)?.enabled === true;
	} catch {
		return false; // absent or unreadable: auto-update is off (cp-update records config_invalid for the latter)
	}
}
