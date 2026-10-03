/**
 * install-tools — get `REQUIRED_TOOLS` onto PATH. Doctor (`src/doctor.ts`)
 * diagnoses and stays read-only by design (see its own header); this is the
 * separate, mutating half a fresh home has no supported way to reach without
 * (cp-lvo).
 *
 * Dependency-injected the same way `Doctor` is (`CommandRunner`, `which`): the
 * core here takes `which`/`run`/`env` as options so `scripts/install-tools.ts`
 * wires the real world exactly once, at the edge, and the tests prove the
 * policy without touching a real machine — same shape as
 * `tests/doctor.test.ts` proving doctor's checks with an injected `run`.
 *
 * Rules this holds itself to:
 *
 *  - **Never shadow.** If a tool is already on PATH — once or more than
 *    once — this never installs a second copy. More than one match is
 *    reported as the exact hazard `doctor`'s `host.<tool>.conflict` exists to
 *    catch (two `treehouse`s, PATH order deciding which answers): a second
 *    install here would recreate that incident on a fresh machine, not
 *    prevent it.
 *  - **Idempotent.** A tool already present is `ok` and untouched. A second
 *    run against a machine this script already fixed does nothing further.
 *  - **`dryRun` mutates nothing** and reports `ok: false` whenever anything is
 *    not already satisfied, so it doubles as a preflight check.
 *  - **No silent sudo.** A step with no non-sudo path (`kind: "manual"`) is
 *    reported, never run.
 *  - **pi is special.** If pi is missing from PATH but this process is itself
 *    running inside a pi session (`PI_SESSION_ID` / `PI_CODING_AGENT` in the
 *    environment — a live worker's own env, not guessed), the script refuses
 *    to install or replace it here rather than fight the process it is
 *    running under.
 */

import {
	type InstallStep,
	type RequiredTool,
	REQUIRED_TOOLS,
	TOOL_INSTALL,
} from "./tool-manifest.ts";

export type InstallerOS = "macos" | "linux" | "unsupported";

export type ToolOutcomeKind =
	| "ok" // already on PATH, single copy — untouched
	| "installed" // was missing, install step ran, now on PATH
	| "planned" // dry run: missing, would run an install step
	| "conflict" // more than one copy on PATH — refuses to add a third
	| "pi_session_guard" // pi missing, but this process is running inside a pi session
	| "unsupported" // this OS has no install step for this tool
	| "manual" // an install step exists but needs a human (usually: sudo)
	| "failed"; // install step ran (or dry-run planned) but did not resolve

export interface ToolOutcome {
	tool: RequiredTool;
	kind: ToolOutcomeKind;
	detail: string;
	step?: InstallStep;
}

export interface InstallReport {
	os: InstallerOS;
	dryRun: boolean;
	/** Set when this process is itself running inside a pi session. */
	piSession?: string;
	outcomes: ToolOutcome[];
	/** True only when every tool is `ok` or `installed` — nothing left for a human. */
	ok: boolean;
}

export interface InstallerOptions {
	os: InstallerOS;
	dryRun: boolean;
	/** Defaults to every `REQUIRED_TOOLS` entry. */
	only?: readonly RequiredTool[];
	/** Every match on PATH, in order — same contract as `doctor.ts#whichAll`. */
	which: (command: string) => string[];
	/** Executes one step for real. Throws on failure. Never called when `dryRun`. */
	run?: (step: InstallStep) => void;
	env?: NodeJS.ProcessEnv;
}

/** `PI_SESSION_ID`/`PI_CODING_AGENT` are set on every live worker's own env — not guessed. */
export function runningUnderPi(env: NodeJS.ProcessEnv): string | undefined {
	if (env.PI_SESSION_ID) return env.PI_SESSION_ID;
	if (env.PI_CODING_AGENT === "true") return "pi-coding-agent";
	return undefined;
}

export function describeStep(step: InstallStep): string {
	switch (step.kind) {
		case "brew":
			return `brew install ${step.formula}`;
		case "npm":
			return `npm install ${[...(step.flags ?? []), step.pkg].join(" ")}`;
		case "curl":
			return `curl -fsSL "${step.url}" | sh`;
		case "manual":
			return step.summary;
	}
}

function stepFor(spec: (typeof TOOL_INSTALL)[RequiredTool], os: InstallerOS): InstallStep | undefined {
	if (os === "macos") return spec.macos;
	if (os === "linux") return spec.linux;
	return undefined;
}

/**
 * The whole decision, per tool, in one place — read top to bottom, it is the
 * policy: don't shadow, don't fight a running pi, don't sudo silently, and
 * only ever touch the machine when asked to and told exactly how.
 */
export function planOrInstall(options: InstallerOptions): InstallReport {
	const env = options.env ?? {};
	const tools = options.only ?? REQUIRED_TOOLS;
	const piSession = runningUnderPi(env);
	const outcomes: ToolOutcome[] = [];

	for (const tool of tools) {
		const spec = TOOL_INSTALL[tool];
		const matches = options.which(tool);

		if (matches.length > 1) {
			outcomes.push({
				tool,
				kind: "conflict",
				detail: `${matches.length} copies already on PATH (${matches.join(", ")}) — not installing another; resolve the duplicate first (see \`/doctor\`'s host.${tool}.conflict)`,
			});
			continue;
		}
		if (matches.length === 1) {
			outcomes.push({ tool, kind: "ok", detail: `already installed at ${matches[0]}` });
			continue;
		}
		if (tool === "pi" && piSession) {
			outcomes.push({
				tool,
				kind: "pi_session_guard",
				detail: `not on PATH, but this process is running inside a pi session (${piSession}) — refusing to install or replace pi from here`,
			});
			continue;
		}

		const step = stepFor(spec, options.os);
		if (!step) {
			outcomes.push({
				tool,
				kind: "unsupported",
				detail: `no supported install path on this platform (${options.os})`,
				step: spec.macos,
			});
			continue;
		}
		if (step.kind === "manual") {
			outcomes.push({ tool, kind: "manual", detail: step.summary, step });
			continue;
		}
		if (options.dryRun) {
			outcomes.push({ tool, kind: "planned", detail: `missing — would run: ${describeStep(step)}`, step });
			continue;
		}
		try {
			if (!options.run) throw new Error("no runner supplied for a non-dry-run install");
			options.run(step);
			const after = options.which(tool);
			if (after.length === 0) {
				outcomes.push({
					tool,
					kind: "failed",
					detail: `ran ${describeStep(step)} but ${tool} is still not on PATH — check your shell's PATH`,
					step,
				});
			} else {
				outcomes.push({ tool, kind: "installed", detail: `${describeStep(step)} -> ${after[0]}`, step });
			}
		} catch (error) {
			outcomes.push({ tool, kind: "failed", detail: `${describeStep(step)} failed: ${(error as Error).message}`, step });
		}
	}

	const ok = outcomes.every((outcome) => outcome.kind === "ok" || outcome.kind === "installed");
	return { os: options.os, dryRun: options.dryRun, ...(piSession ? { piSession } : {}), outcomes, ok };
}

/** The dry-run exit when nothing is wrong but tools a real run would install (`planned`): cp-install's dry-run goes on past it. */
export const DRY_RUN_PLANNED_EXIT = 3;

/** 0 nothing left; 3 a dry run that only planned installs; 1 anything a human must resolve. */
export function installExitCode(report: InstallReport): number {
	if (report.ok) return 0;
	return report.dryRun && report.outcomes.every((outcome) => outcome.kind === "ok" || outcome.kind === "planned") ? DRY_RUN_PLANNED_EXIT : 1;
}

const GLYPH: Readonly<Record<ToolOutcomeKind, string>> = Object.freeze({
	ok: "✓",
	installed: "✓",
	planned: "…",
	conflict: "✗",
	pi_session_guard: "✗",
	unsupported: "✗",
	manual: "✗",
	failed: "✗",
});

export function formatInstallReport(report: InstallReport): string {
	const lines = [`install-tools${report.dryRun ? " (dry run)" : ""} · os=${report.os}`];
	if (report.piSession) lines.push(`running inside a pi session (${report.piSession}); pi will not be reinstalled`);
	lines.push("");
	for (const outcome of report.outcomes) {
		lines.push(`${GLYPH[outcome.kind]} ${outcome.tool}: ${outcome.detail}`);
	}
	lines.push("");
	lines.push(report.ok ? "all required tools are on PATH" : "some tools still need attention (see above)");
	return lines.join("\n").trimEnd();
}
