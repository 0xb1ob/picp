/**
 * pi version nudge (cp-056q) — the npm-installed pi versus the pi that is
 * actually running.
 *
 * The incident: this package pinned `@earendil-works/pi-coding-agent` at 0.84.4
 * while the developer's installed pi was 0.85.0. Nothing was broken, and that
 * was the problem — `npm run` puts `node_modules/.bin` first on PATH, so under
 * `npm test` a worker's `pi` was the pinned 0.84.4 and in a plain shell it was
 * the host 0.85.0. `/doctor` said `host.pi.conflict`, correctly, but only once
 * somebody ran doctor from an npm script; the ordinary session said nothing,
 * and the drift cost a full investigation to re-derive.
 *
 * So this is the cheap, standing version of that investigation, run once at
 * `session_start`:
 *
 *  - **It warns; it never blocks.** A version skew is a nuisance, not a fault.
 *    This module formats a string and returns it — it throws nothing, refuses
 *    nothing, and cannot become a new way for the command post to fail to start.
 *  - **It names the fix, not just the fault.** Both versions, the file to edit
 *    (`package.json`) and the command to run (`npm install`), so the reader does
 *    not have to rediscover any of the above.
 *  - **Unknown is not a mismatch.** No resolvable host pi, an unreadable
 *    version, or no installed copy at all: silent. Warning on ignorance is how
 *    a check trains people to ignore it.
 *  - **It reuses doctor's own probes.** `whichAll` and `execRunner`, injected,
 *    so tests never touch a real PATH and there is no second notion of "which
 *    pi answers here".
 *
 * Once-per-startup is the caller's (`session_start` holds the flag, next to the
 * install nudge's).
 */

import { join, sep } from "node:path";
import { readFileSync } from "node:fs";
import { execRunner, whichAll } from "./doctor.ts";

/** The npm-installed copy, relative to the package root. */
export const PI_PACKAGE_PATH = join("node_modules", "@earendil-works", "pi-coding-agent", "package.json");

export interface PiVersionNudgeOptions {
	/** This package's root; the installed copy is `<root>/${PI_PACKAGE_PATH}`. */
	packageRoot: string;
	/** Same shape as `doctor.ts#whichAll`: every match on PATH, in order. */
	which?: (command: string) => string[];
	/** Reads a file; `undefined` when it is absent or unreadable. */
	readFile?: (path: string) => string | undefined;
	/** Runs `<path> --version`; `undefined` when it cannot be read. */
	probeVersion?: (path: string) => string | undefined;
}

/** A version number anywhere in the line, so `pi 0.85.0` and `0.85.0` both read. */
const VERSION = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

function parseVersion(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const line = text.split("\n")[0]?.trim();
	return line ? (VERSION.exec(line)?.[0] ?? undefined) : undefined;
}

function defaultReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function defaultProbeVersion(path: string): string | undefined {
	const result = execRunner(path, ["--version"], process.cwd());
	return result.status === 0 ? result.stdout : undefined;
}

/** The `version` of the installed pi package, when there is a readable one. */
function installedVersion(packageRoot: string, readFile: (path: string) => string | undefined): string | undefined {
	const raw = readFile(join(packageRoot, PI_PACKAGE_PATH));
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parseVersion(parsed.version) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The pi that answers when *our* `node_modules/.bin` is not in front of it —
 * i.e. the one a plain shell, and therefore a spawned worker, gets. Comparing
 * the installed copy against itself is what a bare `which pi` would do under
 * `npm run`, and it would never warn.
 */
function hostPiPath(packageRoot: string, which: (command: string) => string[]): string | undefined {
	const ours = join(packageRoot, "node_modules") + sep;
	return which("pi").find((path) => !path.startsWith(ours));
}

/**
 * `undefined` — show nothing — unless both versions are readable *and* differ.
 * Never throws: every probe is wrapped, and an unreadable anything is silence.
 */
export function computePiVersionNudge(options: PiVersionNudgeOptions): string | undefined {
	try {
		const readFile = options.readFile ?? defaultReadFile;
		const which = options.which ?? whichAll;
		const probeVersion = options.probeVersion ?? defaultProbeVersion;

		const installed = installedVersion(options.packageRoot, readFile);
		if (installed === undefined) return undefined;
		const hostPath = hostPiPath(options.packageRoot, which);
		if (hostPath === undefined) return undefined;
		const host = parseVersion(probeVersion(hostPath));
		if (host === undefined) return undefined;
		if (host === installed) return undefined;

		// Deliberately not prefixed with the package name, for the same reason the
		// install nudge is not: `/cp-version` and the scaffold announce are told
		// apart from unrelated notify traffic by that substring, and a startup
		// warning must not be mistaken for either of them.
		return [
			`pi version mismatch: this package installs pi ${installed}, the pi running it is ${host} (${hostPath})`,
			"npm puts node_modules/.bin first on PATH, so under `npm run` a worker's pi is the installed one, not yours",
			`fix: set "@earendil-works/pi-coding-agent" to ^${host} in package.json, then run \`npm install\` (\`npm ci\` after that)`,
		].join("\n");
	} catch {
		// A warning that can throw is a new way to fail to start. It cannot.
		return undefined;
	}
}
