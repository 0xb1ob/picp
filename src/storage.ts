/**
 * `/doctor`'s `storage.*` findings (cp-u3i2, docs/storage.md): every home-local
 * file lives under the one `.pi-command-post/` root, operator material lives in
 * its `operator/` workspace, and nothing else accumulates beside them.
 *
 * Warn-only and read-only, like the rest of doctor; each finding names a fix.
 * `LAYOUT` is read inside the functions, never at import time, so a
 * flat or nested home sees its configured layout.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type DoctorFinding, isInside, LAYOUT } from "./contracts.ts";
import type { CommandRunner } from "./doctor.ts";
import { enclosingHome } from "./home.ts";
import { boundedList } from "./routing.ts";

/** The record suffixes code writes at the top of `state/`; anything else there is somebody's stray file. */
const STATE_RECORD_SUFFIXES = [".json", ".jsonl", ".lock", ".sock", ".log", ".tmp"];
/** A home with no `.git` (a standard, managed or `CP_HOME` home) may hold only these at its top level. */
const KNOWN_TOP_LEVEL = (): string[] =>
	LAYOUT.runtimeDir
		? [LAYOUT.runtimeDir, ".beads", ".gitignore", "operator-targets"]
		: // A flat home is its runtime root: the layout's own top-level entries, the mode settings, the code checkout.
			[...new Set(Object.values(LAYOUT).filter(Boolean).map((path) => path.split("/")[0] as string)), "settings.json", "app", ".beads", "operator-targets"];
/** The runtime root, as doctor names it: `.pi-command-post/`, or the home itself for a flat home. */
const rootName = (): string => (LAYOUT.runtimeDir ? `${LAYOUT.runtimeDir}/` : "the home itself");
const LISTED = 10;

/** Never throws: doctor reports a broken environment, it does not crash on one. */
export function storageFindings(home: string, run: CommandRunner): DoctorFinding[] {
	try {
		const findings = [...stateFindings(home), ...aliasFindings(home), ...homeFindings(home, run), ...handoffsFindings(home)];
		if (findings.length) return findings;
		return [{ check: "storage", severity: "ok", what: `home-local files are under the runtime root, ${rootName()} (docs/storage.md)` }];
	} catch (error) {
		return [{ check: "storage", severity: "warn", what: "home layout could not be read", detail: String((error as Error).message).slice(0, 2000), fix: `check ${home} and its runtime root ${join(home, LAYOUT.runtimeDir)} are readable by this user` }];
	}
}

function stateFindings(home: string): DoctorFinding[] {
	const state = join(home, LAYOUT.state);
	if (!existsSync(state)) return [];
	const stray = readdirSync(state, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !STATE_RECORD_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
		.map((entry) => entry.name)
		.sort();
	if (!stray.length) return [];
	return [{
		check: "storage.state",
		severity: "warn",
		what: `${stray.length} non-record file(s) at the top of ${LAYOUT.state}/`,
		detail: boundedList(stray, { max: LISTED }),
		fix: `state/ holds code-written records only: move operator material into ${join(home, LAYOUT.operatorWorkspace)}/ (docs/storage.md)`,
	}];
}

function homeFindings(home: string, run: CommandRunner): DoctorFinding[] {
	let stray: string[];
	if (existsSync(join(home, ".git"))) {
		const listed = run("git", ["ls-files", "--others", "--exclude-standard", "--directory"], home);
		if (listed.status !== 0) {
			return [{
				check: "storage.home",
				severity: "warn",
				what: "untracked files in the home could not be listed",
				detail: `git ls-files exited ${listed.status}: ${listed.stderr.trim()}`.slice(0, 2000),
				fix: `run git -C ${home} status, fix what it reports, then rerun /doctor`,
			}];
		}
		stray = listed.stdout.split("\n").filter(Boolean);
	} else {
		const known = new Set(KNOWN_TOP_LEVEL());
		stray = readdirSync(home).filter((name) => !known.has(name)).sort();
	}
	if (!stray.length) return [];
	return [{
		check: "storage.home",
		severity: "warn",
		what: `${stray.length} home entr${stray.length === 1 ? "y" : "ies"} outside the runtime root ${rootName()} and .beads/`,
		detail: boundedList(stray, { max: LISTED }),
		fix: LAYOUT.runtimeDir
			? `a top-level data/, state/ or projects/ is the old layout: move it under the runtime root ${LAYOUT.runtimeDir}/ with the parent stopped; operator material goes in ${LAYOUT.operatorWorkspace}/ (docs/storage.md)`
			: `a flat home holds only its runtime root's own entries, app/ and .beads/: operator material goes in ${LAYOUT.operatorWorkspace}/ (docs/storage.md)`,
	}];
}

/**
 * The alias guard: a home named `.pi-command-post` is flat by name, so
 * pointing a session at `<other home>/.pi-command-post` (by `CP_HOME`, a
 * setting or a launch directory) would open another home's nested runtime
 * root as a second, flat home. `enclosingHome` is the same evidence mode
 * resolution uses before it looks for a git toplevel.
 */
function aliasFindings(home: string): DoctorFinding[] {
	const parent = enclosingHome(home);
	if (!parent) return [];
	return [{
		check: "storage.alias",
		severity: "warn",
		what: `this home is another home's runtime root; use ${parent.home} as the home`,
		detail: `${home} is flat by name, but ${parent.home} is a home (${parent.evidence})`,
		fix: `point this session at ${parent.home} instead (CP_HOME, or launch from it) and restart the parent; its runtime root stays ${home} (docs/storage.md)`,
	}];
}

function handoffsFindings(home: string): DoctorFinding[] {
	const file = join(home, LAYOUT.data, "operator.json");
	if (!existsSync(file)) return [];
	let value: unknown;
	try {
		value = (JSON.parse(readFileSync(file, "utf8")) as { handoffs_dir?: unknown } | null)?.handoffs_dir;
	} catch (error) {
		return [{
			check: "storage.handoffs_dir",
			severity: "warn",
			what: `${LAYOUT.data}/operator.json is not valid JSON`,
			detail: String((error as Error).message).slice(0, 2000),
			fix: `fix ${file}; until then self_compact ignores it and writes handoffs to ${LAYOUT.state}/operator/`,
		}];
	}
	if (typeof value !== "string" || !value.trim() || isInside(resolve(home, value), resolve(home))) return [];
	return [{
		check: "storage.handoffs_dir",
		severity: "warn",
		what: `${LAYOUT.data}/operator.json handoffs_dir is outside the home`,
		detail: value.slice(0, 2000),
		fix: `point handoffs_dir at ${join(home, LAYOUT.operatorWorkspace, "handoffs")}, or drop it for the default ${LAYOUT.state}/operator/ (docs/storage.md)`,
	}];
}
