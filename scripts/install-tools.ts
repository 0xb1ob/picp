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
 *   --yes / --no-prompt / --no-pi-upgrade / --force   pi's range (package.json piCompat, #375): below min,
 *                        ask (--yes consents, --no-prompt declines, --no-pi-upgrade refuses) before `pi update
 *                        --self`; an incompatible pi is refused unless --force (a warning)
 *
 * Exit codes: 0 everything on PATH (or, in dry-run, would already pass);
 * 1 something still needs attention; 2 bad arguments; 3 dry-run: only tools
 * a real run would install are missing (still a failed preflight).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { whichAll } from "../src/doctor.ts";
import { formatInstallReport, installExitCode, type InstallerOS, piCompatGate, planOrInstall } from "../src/install-tools.ts";
import { readPiCompat } from "../src/pi-compat.ts";
import { probePiSync } from "../src/pi-compat-probe.ts";
import { askTty, shellWord } from "../src/service/install.ts";
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

/** Direct release-asset download (no "latest" API call), authenticated when GITHUB_TOKEN/GH_TOKEN is set (#428). */
function installRelease(repo: string, version: string): void {
	const name = repo.split("/")[1] ?? repo;
	const goArch = arch() === "arm64" ? "arm64" : "amd64";
	const file = `${name}-v${version}-${platform()}-${goArch}.tar.gz`;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	const dir = mkdtempSync(join(tmpdir(), "cp-release-"));
	try {
		const auth = token ? ["-H", `Authorization: Bearer ${token}`] : [];
		const url = `https://github.com/${repo}/releases/download/v${version}/${file}`;
		execFileSync("curl", ["-fsSL", ...auth, url, "-o", join(dir, file)], { stdio: "inherit" });
		execFileSync("tar", ["xzf", join(dir, file), "-C", dir], { stdio: "inherit" });
		const local = join(homedir(), ".local/bin");
		const dest = (process.env.PATH ?? "").split(":").includes(local) ? local : "/usr/local/bin";
		const sudo = (cmd: string, args: string[]) => {
			let writable = true;
			try {
				mkdirSync(dest, { recursive: true });
				accessSync(dest, constants.W_OK);
			} catch {
				writable = false;
			}
			execFileSync(writable ? cmd : "sudo", writable ? args : [cmd, ...args], { stdio: "inherit" });
		};
		sudo("mv", [join(dir, name), join(dest, name)]);
		console.log(`${name} v${version} installed to ${join(dest, name)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
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
		case "release":
			installRelease(step.repo, step.version);
			return;
		case "manual":
			throw new Error(step.summary);
	}
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; only?: RequiredTool[]; flags: string[] } {
	const dryRun = argv.includes("--dry-run") || argv.includes("--check");
	const positionals = argv.filter((arg) => !arg.startsWith("--"));
	for (const arg of positionals) {
		if (!(REQUIRED_TOOLS as readonly string[]).includes(arg)) {
			console.error(`install-tools: unknown tool "${arg}" (known: ${REQUIRED_TOOLS.join(", ")})`);
			process.exit(2);
		}
	}
	const flags = argv.filter((arg) => PI_FLAGS.includes(arg));
	return { dryRun, flags, ...(positionals.length > 0 ? { only: positionals as RequiredTool[] } : {}) };
}

/** pi's compatibility switches (#375), forwarded by cp-install. */
const PI_FLAGS = ["--yes", "--no-prompt", "--no-pi-upgrade", "--force"];

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
	const { dryRun, only, flags } = parseArgs(process.argv.slice(2));
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
	let code = installExitCode(report);
	const open = report.outcomes.filter((outcome) => outcome.kind !== "ok" && outcome.kind !== "installed").map((outcome) => outcome.tool);
	const retry = [process.execPath, fileURLToPath(import.meta.url), ...open, ...flags].map(shellWord).join(" ");
	if (code === 1 && !dryRun) console.log(`after fixing the above, retry: ${retry}`);
	// #375: pi's supported range (package.json piCompat), once pi itself is on PATH.
	const pi = report.outcomes.find((outcome) => outcome.tool === "pi");
	if (pi && (pi.kind === "ok" || pi.kind === "installed")) {
		const root = dirname(dirname(fileURLToPath(import.meta.url)));
		const gate = piCompatGate({
			compat: readPiCompat(root),
			dryRun,
			yes: flags.includes("--yes"),
			noPrompt: flags.includes("--no-prompt"),
			noUpgrade: flags.includes("--no-pi-upgrade"),
			force: flags.includes("--force"),
			env: process.env,
			which: whichAll,
			probe: (path) => probePiSync(path, root),
			update: (path) => {
				const ran = spawnSync(path, ["update", "--self"], { encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
				return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error ? ran.error.message : ""}` };
			},
			ask: askTty,
			log: (line) => console.log(line),
			retry: [process.execPath, fileURLToPath(import.meta.url), "pi", ...flags].map(shellWord).join(" "),
		});
		if (gate !== 0 && code !== 1) code = gate;
	}
	return code;
}

process.exit(main());
