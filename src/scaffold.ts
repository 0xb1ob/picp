/**
 * Self-scaffold (T30) — what a home needs before the first dispatch.
 *
 * A fresh install has no `data/`, no `state/`, no `projects/` and no ledger, and
 * an operator should not have to know that. `session_start` calls this, `cmdp
 * scaffold` calls this, and `/doctor` reports what it found. Three rules:
 *
 *  - **Idempotent, and never destructive.** An existing directory, ledger or
 *    file is left exactly as it is. Scaffolding twice is a no-op that says so.
 *  - **It reports rather than logs.** Every action comes back as a line the
 *    operator can read; nothing is written to stdout from inside a session.
 *  - **The ledger is a file.** A missing jobs document is created empty with
 *    the home's prefix; an existing one is never touched.
 *
 * What it deliberately does NOT do: create `USER.md`. That file is optional,
 * machine-local operator context beside `AGENTS.md` (`src/user-context.ts`), and
 * optional means the scaffold never brings it into existence, never rewrites an
 * existing one, and reports nothing about it either way.
 *
 * What it also deliberately does NOT do: copy skills into `.cursor/skills`,
 * `.claude/skills` or `.agents/skills`. The ported `bin/install.sh` did, so that
 * other agent CLIs would discover them; pi finds `skills/` through the package
 * manifest, so for pi those copies are dead weight, and the operator's decision
 * on this home is that no other agent CLI runs here (T28 finding, answered).
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ENV_LEDGER_PREFIX,
	isSafeLedgerPrefix,
	LAYOUT,
	LEDGER_PREFIX_PATTERN,
	NEVER_COMMIT_PATHS,
} from "./contracts.ts";
import { describeHome, PACKAGE_ROOT, type HomeResolution } from "./home.ts";
import { atomicWriteJson } from "./json-store.ts";
import { initJobsDocument, LedgerError } from "./ledger.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "./mandate-defaults.ts";

/** br prefix for the ledger this package creates. Job ids are `cp-...`. */
export const LEDGER_PREFIX = "cp";

/**
 * The prefix `br init` gets for a home, from that home's environment.
 *
 * Unset or empty is `cp` — every existing home, byte-for-byte. A set-but-
 * invalid value is a **refusal**, never a silent fallback to `cp`: the prefix
 * is the first component of every job id and therefore of every git branch
 * this home pushes, so quietly ignoring the operator's value is how two homes
 * end up minting the same branch name for two different jobs (cp-b8el).
 */
export function resolveLedgerPrefix(env: NodeJS.ProcessEnv = process.env): { prefix: string } | { error: string } {
	const raw = env[ENV_LEDGER_PREFIX];
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value.length === 0) return { prefix: LEDGER_PREFIX };
	if (!isSafeLedgerPrefix(value)) {
		return {
			error: `${ENV_LEDGER_PREFIX}=${JSON.stringify(value)} is not a usable ledger prefix: it must match ${LEDGER_PREFIX_PATTERN} (lowercase, starts with a letter, at most 8 chars) because it is the first component of every job id and of every branch this home pushes`,
		};
	}
	return { prefix: value };
}

export type ScaffoldAction = "created" | "present" | "skipped" | "failed";

export interface ScaffoldStep {
	/** `dir.state`, `ledger`, `gitignore`, … */
	step: string;
	action: ScaffoldAction;
	detail?: string;
}

export interface ScaffoldReport {
	home: string;
	home_source: HomeResolution["source"];
	/** True when nothing had to be created: the home was already ready. */
	already_ready: boolean;
	steps: ScaffoldStep[];
}

export interface ScaffoldOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Skip the ledger step entirely (a home that will never dispatch). */
	ledger?: boolean;
	/**
	 * Where the shipped `defaults/routing.default.json` template lives. Defaults to
	 * the package root; tests point it at a scratch source to stay hermetic.
	 */
	packageRoot?: string;
}

/**
 * Bring a home up to the state a first dispatch expects. Safe to call on every
 * session start: the common case is four `present` lines and no writes.
 */
export function scaffoldHome(options: ScaffoldOptions = {}): ScaffoldReport {
	const env = options.env ?? process.env;
	const resolution = describeHome(env);
	const home = resolve(options.home ?? resolution.home);
	const steps: ScaffoldStep[] = [];

	// A flat home (the standard `~/.pi-command-post`) is its own runtime root: no dotdir to create.
	const flat = LAYOUT.runtimeDir === "";
	const dirs: Array<[string, string]> = [
		...(flat ? [] : [["runtime", LAYOUT.runtimeDir] as [string, string]]),
		["data", LAYOUT.data],
		["state", LAYOUT.state],
		["projects", LAYOUT.projects],
	];
	for (const [key, dir] of dirs) {
		const path = join(home, dir);
		const stepName = `dir.${key}`;
		if (existsSync(path)) {
			steps.push({ step: stepName, action: "present" });
			continue;
		}
		try {
			mkdirSync(path, { recursive: true });
			steps.push({ step: stepName, action: "created", detail: path });
		} catch (error) {
			steps.push({ step: stepName, action: "failed", detail: (error as Error).message });
		}
	}

	// A flat home is not a repository, and it has no dotdir to ignore: no `.gitignore` step at all.
	if (!flat) steps.push(gitignoreStep(home));
	steps.push(routingDefaultStep(home, options.packageRoot ?? PACKAGE_ROOT));
	steps.push(mandateDefaultsStep(home));
	if (options.ledger !== false) steps.push(ledgerStep(home, env));

	return {
		home,
		home_source: resolution.source,
		already_ready: steps.every((step) => step.action === "present"),
		steps,
	};
}

/**
 * A managed home is not a git repository, but an operator's checkout is, and a
 * stray `git add -A` in *another* tool is exactly how runtime state leaks. So a
 * home that has no `.gitignore` gets one; a home that has one is never edited —
 * doctor warns instead, because rewriting an operator's file is not scaffolding.
 */
function gitignoreStep(home: string): ScaffoldStep {
	const file = join(home, ".gitignore");
	if (existsSync(file)) return { step: "gitignore", action: "present" };
	try {
		writeFileSync(
			file,
			[
				"# pi-command-post runtime state. Never commit any of this:",
				"# the fleet, the leases, the run logs and the artifacts are machine-local.",
				...NEVER_COMMIT_PATHS,
				"node_modules/",
				"",
			].join("\n"),
		);
		return { step: "gitignore", action: "created", detail: file };
	} catch (error) {
		return { step: "gitignore", action: "failed", detail: (error as Error).message };
	}
}

/**
 * Copy the shipped default rubric into `data/routing.json`, once. This is the
 * *only* write this scaffold ever makes to a routing decision: an existing
 * file — operator-authored or a previous copy — is never touched, so a later
 * `session_start` can never silently rewrite policy out from under an
 * operator who has since edited it. A missing template (a home whose package
 * root does not ship one, e.g. an old install) is a skip, not a failure:
 * `DEFAULT_ROUTING_CONFIG`'s in-code fallback ( "no policy configured yet" )
 * still applies exactly as before.
 */
function routingDefaultStep(home: string, packageRoot: string): ScaffoldStep {
	const dest = join(home, LAYOUT.routingFile);
	if (existsSync(dest)) return { step: "routing.default", action: "present" };
	const source = join(packageRoot, "defaults/routing.default.json");
	if (!existsSync(source)) {
		return { step: "routing.default", action: "skipped", detail: `no shipped default at ${source}` };
	}
	try {
		copyFileSync(source, dest);
		return { step: "routing.default", action: "created", detail: `copied ${source} -> ${dest}` };
	} catch (error) {
		return { step: "routing.default", action: "failed", detail: (error as Error).message };
	}
}

/**
 * `data/mandate-defaults.json`, written once with the scope's conservative
 * scaffold values (autonomy-programme-cur.2.5). An existing file \u2014
 * operator-edited or a previous scaffold \u2014 is never touched.
 */
function mandateDefaultsStep(home: string): ScaffoldStep {
	const file = join(home, LAYOUT.mandateDefaultsFile);
	if (existsSync(file)) return { step: "mandate-defaults", action: "present" };
	try {
		atomicWriteJson(file, SCAFFOLD_MANDATE_DEFAULTS);
		return { step: "mandate-defaults", action: "created", detail: file };
	} catch (error) {
		return { step: "mandate-defaults", action: "failed", detail: (error as Error).message };
	}
}

/**
 * The jobs document, created empty with this home's prefix when there is
 * none (`CP_LEDGER_PREFIX`, default `cp`). An existing document is never
 * touched: it is the operator's job history, and its recorded prefix wins
 * over the environment from then on (doctor reports a mismatch).
 */
function ledgerStep(home: string, env: NodeJS.ProcessEnv = process.env): ScaffoldStep {
	if (existsSync(join(home, LAYOUT.jobsFile))) return { step: "ledger", action: "present" };
	const resolved = resolveLedgerPrefix(env);
	if ("error" in resolved) return { step: "ledger", action: "failed", detail: resolved.error };
	try {
		initJobsDocument(home, resolved.prefix);
		return { step: "ledger", action: "created", detail: `${LAYOUT.jobsFile} with prefix ${resolved.prefix}` };
	} catch (error) {
		const message = error instanceof LedgerError ? error.message : (error as Error).message;
		return { step: "ledger", action: "failed", detail: `could not create ${LAYOUT.jobsFile}: ${message}` };
	}
}

/** One operator-facing block. Silent about the boring case unless asked. */
export function formatScaffold(report: ScaffoldReport, options: { verbose?: boolean } = {}): string {
	const interesting = report.steps.filter((step) => step.action !== "present");
	if (interesting.length === 0 && !options.verbose) {
		return `command post home ready (${report.home_source}): ${report.home}`;
	}
	const lines = [`command post home (${report.home_source}): ${report.home}`];
	for (const step of options.verbose ? report.steps : interesting) {
		const glyph = step.action === "created" ? "+" : step.action === "failed" ? "!" : step.action === "skipped" ? "·" : " ";
		lines.push(`  ${glyph} ${step.step}: ${step.action}${step.detail ? ` — ${step.detail}` : ""}`);
	}
	return lines.join("\n");
}
