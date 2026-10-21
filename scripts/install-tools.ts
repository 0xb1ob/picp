#!/usr/bin/env node
/**
 * `node scripts/install-tools.ts [--dry-run|--check] [tool ...]`
 *
 * The mutating half of `/doctor` (which stays read-only by design — see
 * `src/doctor.ts`'s header). All policy lives in `src/install-tools.ts`
 * (dependency-injected core) and `src/tool-manifest.ts` (the tool list and
 * install specs, shared with `doctor.ts` so the two cannot drift). This file
 * is only the edge: real `which`, real `execFileSync`, real `process.argv`,
 * real exit code.
 *
 *   --dry-run, --check   print the plan, touch nothing, exit non-zero if
 *                        anything is missing (usable as a preflight)
 *   git / treehouse / pi   restrict to one or more tools
 *
 * Exit codes: 0 everything on PATH (or, in dry-run, would already pass);
 * 1 something still needs attention; 2 bad arguments; 3 dry-run: only tools
 * a real run would install are missing (still a failed preflight).
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { whichAll } from "../src/doctor.ts";
import { formatInstallReport, installExitCode, type InstallerOS, planOrInstall } from "../src/install-tools.ts";
import { type InstallStep, REQUIRED_TOOLS, type RequiredTool } from "../src/tool-manifest.ts";

function detectOS(): InstallerOS {
	switch (platform()) {
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		default:
			return "unsupported";
	}
}

function realRun(step: InstallStep): void {
	switch (step.kind) {
		case "brew":
			execFileSync("brew", ["install", step.formula], { stdio: "inherit" });
			return;
		case "npm":
			execFileSync("npm", ["install", ...(step.flags ?? []), step.pkg], { stdio: "inherit" });
			return;
		case "curl":
			// The tool's own published quick-install (see src/tool-manifest.ts):
			// treehouse ships a self-detecting `curl | sh` one-liner.
			execFileSync("/bin/sh", ["-c", `curl -fsSL "${step.url}" | sh`], { stdio: "inherit" });
			return;
		case "manual":
			throw new Error(step.summary);
	}
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; only?: RequiredTool[] } {
	const dryRun = argv.includes("--dry-run") || argv.includes("--check");
	const positionals = argv.filter((arg) => !arg.startsWith("--"));
	for (const arg of positionals) {
		if (!(REQUIRED_TOOLS as readonly string[]).includes(arg)) {
			console.error(`install-tools: unknown tool "${arg}" (known: ${REQUIRED_TOOLS.join(", ")})`);
			process.exit(2);
		}
	}
	return { dryRun, ...(positionals.length > 0 ? { only: positionals as RequiredTool[] } : {}) };
}

/** `npm prefix -g`, and whether this user may write where npm installs (lib/node_modules, else its nearest dir). */
function npmPrefix(): { path: string; writable: boolean } | undefined {
	let path: string;
	try {
		path = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 30_000 }).trim();
	} catch {
		return undefined; // no npm answer: the npm step itself then fails with its own error
	}
	let target = existsSync(join(path, "lib/node_modules")) ? join(path, "lib/node_modules") : path;
	while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
	try {
		accessSync(target, constants.W_OK);
		return { path, writable: true };
	} catch {
		return { path, writable: false };
	}
}

function main(): number {
	const { dryRun, only } = parseArgs(process.argv.slice(2));
	const report = planOrInstall({
		os: detectOS(),
		dryRun,
		...(only ? { only } : {}),
		which: whichAll,
		run: realRun,
		env: process.env,
		npmPrefix,
	});
	console.log(formatInstallReport(report));
	const code = installExitCode(report);
	const open = report.outcomes.filter((outcome) => outcome.kind !== "ok" && outcome.kind !== "installed").map((outcome) => outcome.tool);
	if (code === 1 && !dryRun) console.log(`after fixing the above, retry: ${process.execPath} ${fileURLToPath(import.meta.url)} ${open.join(" ")}`);
	return code;
}

process.exit(main());
