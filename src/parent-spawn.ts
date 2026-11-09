/** The parent process's argv for each driver (`data/parent.json` `driver`): pi's `--mode rpc` or the native entry. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PARENT_BRIDGE_FLAGS, type ThinkingLevel, WORKER_FORBIDDEN_FLAGS } from "./contracts.ts";
import { CpBridgeError } from "./cp-bridge-error.ts";
import { isNativeModel, NativeDriverError, nativeParentSpawnOptions } from "./drivers/claude.ts";
import { PACKAGE_ROOT } from "./home.ts";
import { type ParentDriver, parentDriverSetting, parentThinkingSetting } from "./parent-context.ts";
import type { WorkerSpawnOptions } from "./worker-process.ts";

/** The parent's skills, each `<home>/skills/<name>` when present, else the copy shipped in the package root (a managed home holds state, not the package). */
export const PARENT_SKILLS = ["cp-memory", "cp-self-review", "cp-pr-review", "cp-org-pr-review"] as const;
export function parentSkillPaths(home: string, packageRoot: string = PACKAGE_ROOT): string[] {
	return PARENT_SKILLS.map((name) => (existsSync(join(home, "skills", name, "SKILL.md")) ? join(home, "skills", name) : join(packageRoot, "skills", name)));
}

export function buildParentArgv(options: {
	sessionFile: string;
	model: string;
	extension: string;
	thinking?: ThinkingLevel;
	/** `--skill` paths; additive under `--no-skills`. */
	skills?: readonly string[];
	extraArgs?: readonly string[];
}): string[] {
	for (const flag of options.extraArgs ?? []) {
		if ((WORKER_FORBIDDEN_FLAGS as readonly string[]).includes(flag)) {
			throw new CpBridgeError(`forbidden parent flag ${flag}`);
		}
	}
	const args = ["--mode", "rpc", ...PARENT_BRIDGE_FLAGS, "--session", options.sessionFile, "--model", options.model];
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push("-e", options.extension);
	for (const skill of options.skills ?? []) args.push("--skill", skill);
	args.push(...(options.extraArgs ?? []));
	for (const flag of PARENT_BRIDGE_FLAGS) {
		if (!args.includes(flag)) throw new CpBridgeError(`parent argv missing ${flag}`);
	}
	return args;
}

/** The home's parent driver, refusing by name an unknown one or `claude` beside a non-`anthropic/claude-*` model. */
export function assertParentDriver(home: string, model: string): ParentDriver {
	const driver = parentDriverSetting(home);
	if (driver === "claude" && !isNativeModel(model)) {
		throw new NativeDriverError(`the claude parent driver runs an explicit anthropic/claude-… model, and ${model} is not one: fix data/parent.json or the start model`, "model");
	}
	return driver;
}

/** `piBin`/`argv` for one parent spawn: the native entry on driver `claude`, else pi with command-post. */
export function parentSpawnArgs(home: string, sessionFile: string, options: { model: string; piBin?: string; commandPostExtension?: string; thinking?: ThinkingLevel }): Pick<WorkerSpawnOptions, "piBin" | "argv"> {
	if (assertParentDriver(home, options.model) === "claude") return nativeParentSpawnOptions({ home, sessionFile, model: options.model });
	const argv = buildParentArgv({
		sessionFile,
		model: options.model,
		extension: options.commandPostExtension ?? join(PACKAGE_ROOT, "extensions/command-post/index.ts"),
		skills: parentSkillPaths(home),
		thinking: options.thinking ?? parentThinkingSetting(home),
	});
	return { ...(options.piBin ? { piBin: options.piBin } : {}), argv };
}
