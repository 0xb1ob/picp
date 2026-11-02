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

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type DoctorFinding,
	ENV_LEDGER_PREFIX,
	isSafeLedgerPrefix,
	LAYOUT,
	LEDGER_PREFIX_PATTERN,
	NEVER_COMMIT_PATHS,
	type RoutingConfig,
} from "./contracts.ts";
import { describeHome, PACKAGE_ROOT, type HomeResolution } from "./home.ts";
import { atomicWriteJson } from "./json-store.ts";
import { initJobsDocument, LedgerError } from "./ledger.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "./mandate-defaults.ts";
import { uncoveredRoles } from "./routed-models.ts";
import { boundedList, loadRoutingConfig } from "./routing.ts";

/** Id prefix for the ledger this package creates. Job ids are `cp-...`. */
export const LEDGER_PREFIX = "cp";

/**
 * The ledger id prefix for a home, from that home's environment.
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
	steps.push(routingRoleDefaultsStep(home, options.packageRoot ?? PACKAGE_ROOT));
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

const ROLE_DEFAULTS_MIGRATION = "role-defaults-v1";

/** One `state/routing-migrations.jsonl` line of the `role-defaults-v1` migration. */
export interface RoleDefaultsJournalLine {
	migration: string;
	at: string;
	outcome: "intent" | "done" | "covered" | "failed";
	/** intent: the rows about to be appended. */
	rows?: Array<Record<string, unknown>>;
	/** done: the appended row ids. */
	ids?: string[];
	role?: string;
	before_sha256?: string;
	after_sha256?: string;
}

/** The migration's journal lines, in file order; a torn line (a crash mid-append) is not a migration fact. */
export function readRoleDefaultsJournal(home: string): RoleDefaultsJournalLine[] {
	const file = join(home, LAYOUT.routingMigrationsFile);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").flatMap((line) => {
		try {
			const parsed = JSON.parse(line) as RoleDefaultsJournalLine;
			return parsed?.migration === ROLE_DEFAULTS_MIGRATION ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Once per home (D1): append a default row (defaults/routing.role-defaults.json) for every role an existing
 * data/routing.json leaves partly unrouted, so nothing that routed through its profile is now refused.
 * Journaled intent → atomic write → done; existing rows are never rewritten or reordered, legacy role words kept.
 */
function routingRoleDefaultsStep(home: string, packageRoot: string): ScaffoldStep {
	const step = "routing.roles";
	const journal = readRoleDefaultsJournal(home);
	if (journal.some((line) => line.outcome === "done" || line.outcome === "covered")) return { step, action: "present" };
	const file = join(home, LAYOUT.routingFile);
	if (!existsSync(file)) return { step, action: "skipped", detail: `no ${LAYOUT.routingFile}` };
	const journalFile = join(home, LAYOUT.routingMigrationsFile);
	const record = (line: Omit<RoleDefaultsJournalLine, "migration" | "at">): void => {
		mkdirSync(dirname(journalFile), { recursive: true });
		appendFileSync(journalFile, `${JSON.stringify({ migration: ROLE_DEFAULTS_MIGRATION, at: new Date().toISOString(), ...line })}\n`);
	};
	let text: string, raw: { rubric: Array<Record<string, unknown>> }, config: RoutingConfig;
	try {
		text = readFileSync(file, "utf8");
		raw = JSON.parse(text);
		config = loadRoutingConfig(home);
	} catch (error) {
		return { step, action: "skipped", detail: `${(error as Error).message.split("\n")[0]} (config.routing reports it)` };
	}
	try {
		const intent = [...journal].reverse().find((line) => line.outcome === "intent");
		if (intent?.rows?.length && isDeepStrictEqual(raw.rubric.slice(-intent.rows.length), intent.rows)) {
			const ids = intent.rows.map((row) => String(row.id));
			record({ outcome: "done", ids, after_sha256: sha256(text) });
			return { step, action: "created", detail: `appended ${ids.join(", ")} to ${file}` };
		}
		const uncovered = uncoveredRoles(config);
		if (uncovered.length === 0) {
			record({ outcome: "covered" });
			return { step, action: "present" };
		}
		const source = join(packageRoot, "defaults/routing.role-defaults.json");
		if (!existsSync(source)) return { step, action: "skipped", detail: `no shipped role defaults at ${source}` };
		const defaults = (JSON.parse(readFileSync(source, "utf8")) as { rubric: Array<Record<string, unknown>> }).rubric;
		const taken = new Set(raw.rubric.map((row) => row.id));
		const rows: Array<Record<string, unknown>> = [];
		for (const { role } of uncovered) {
			const row = defaults.find((each) => each.role === role);
			const id = [`${role}-default`, `${role}-default-migrated`].find((each) => !taken.has(each));
			if (!row || !id) {
				record({ outcome: "failed", role });
				continue;
			}
			taken.add(id);
			rows.push({ ...row, id });
		}
		const ids = rows.map((row) => String(row.id));
		if (rows.length > 0) {
			record({ outcome: "intent", rows, before_sha256: sha256(text) });
			const next = { ...raw, rubric: [...raw.rubric, ...rows] };
			atomicWriteJson(file, next);
			record({ outcome: "done", ids, after_sha256: sha256(`${JSON.stringify(next, null, 2)}\n`) });
			return { step, action: "created", detail: `appended ${ids.join(", ")} to ${file}` };
		}
		record({ outcome: "done", ids });
		return { step, action: "failed", detail: `no default row could be appended for ${uncovered.map((each) => each.role).join(", ")} (id taken)` };
	} catch (error) {
		return { step, action: "failed", detail: (error as Error).message };
	}
}

/** Doctor: the `role-defaults-v1` migration's outcome, and any role a scope/risk cell leaves unrouted (P7). */
export function routingCoverageFindings(home: string, config: RoutingConfig): DoctorFinding[] {
	const journal = readRoleDefaultsJournal(home);
	const settled = journal.find((line) => line.outcome === "done" || line.outcome === "covered");
	const failed = journal.filter((line) => line.outcome === "failed").map((line) => line.role ?? "?");
	const findings: DoctorFinding[] = [{
		check: "config.routing.migration",
		severity: "ok",
		what: settled?.outcome === "done" ? `routing role defaults appended: ${settled.ids?.join(", ") || "(none)"}`
			: settled ? "routing role defaults: every role was already routed, nothing appended" : "routing role defaults: not run on this home yet",
		...(failed.length ? { detail: `no free id for: ${failed.join(", ")}` } : {}),
	}];
	const uncovered = uncoveredRoles(config);
	if (uncovered.length > 0) {
		findings.push({
			check: "config.routing.unrouted",
			severity: "warn",
			what: `${uncovered.length} role(s) have scope/risk cells no rubric row routes: those jobs are refused`,
			detail: boundedList(uncovered.map((each) => `${each.role}: ${each.cells.join(", ")}`), { cap: 600 }),
			fix: `add a row for each role in ${LAYOUT.routingFile} (defaults/routing.role-defaults.json has one per role)`,
		});
	}
	return findings;
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
