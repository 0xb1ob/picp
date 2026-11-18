/**
 * How picp starts `codex app-server`: the child env, the reduced surface, picp's hook, and the `picp_planner`
 * allow-list permission profile that confines every command in the kernel whatever the hook, approvals or rules do.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_ENV_NAME } from "../web-egress.ts";
import { CodexSpikeError } from "./codex-cli.ts";
import { CONTAIN_ENV_KEY } from "./codex-containment.ts";

/** Features picp turns off (AP probe P11, C1 probes E5/E7/E8); the lockdown reads each back as disabled. */
export const CODEX_OFF_FEATURES: readonly string[] = [
	"apps", "plugins", "multi_agent", "image_generation", "memories", "view_image", "goals", "sleep_tool", "unified_exec_tty",
];
export const SURFACE_FLAGS: readonly string[] = [
	...CODEX_OFF_FEATURES.flatMap((feature) => ["--disable", feature]),
	"--enable", "skip_host_skill_discovery",
];
export const CODEX_PROFILE = "picp_planner";
export const HOOK_TIMEOUT_SEC = 20;
export const CODEX_HOOK_CLIENT = fileURLToPath(new URL("./codex-hook.mjs", import.meta.url));
const HOST_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
const WEB_SEARCH_OFF = 'web_search="disabled"';

/** The CLI child env from an allow-list; a host OPENAI_*, CODEX_* (but CODEX_HOME) or secret-named key throws. */
export function buildCodexChildEnv(
	dirs: { home: string; tmp: string },
	hostEnv: NodeJS.ProcessEnv,
	codexHome: string,
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of HOST_ENV_ALLOW) {
		const value = hostEnv[key];
		if (value !== undefined) env[key] = value;
	}
	Object.assign(env, { HOME: dirs.home, TMPDIR: dirs.tmp, CODEX_HOME: codexHome, GIT_SSH_COMMAND: "false" });
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	const bad = Object.keys(env).find((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME") || SECRET_ENV_NAME.test(key) || CONTAIN_ENV_KEY.test(key));
	if (bad !== undefined) throw new CodexSpikeError(`the Codex child env may not carry ${bad}`);
	return env;
}

const toml = (value: string): string => JSON.stringify(value);

/** The hook command the CLI runs per tool call; a path holding a single quote throws. */
export function codexHookCommand(socket: string, clientTimeoutMs = 10_000): string {
	const words = [process.execPath, CODEX_HOOK_CLIENT, socket];
	if (words.some((word) => word.includes("'"))) throw new CodexSpikeError("the Codex hook command needs paths without a single quote");
	return `${words.map((word) => `'${word}'`).join(" ")} ${clientTimeoutMs}`;
}

export interface CodexProfileRoots {
	worktree: string;
	/** `git rev-parse --git-common-dir`: a linked worktree's `.git` is a file pointing outside it. */
	gitDir?: string;
	/** The release dir the sandbox re-executes the codex binary from (E17). */
	codexDir?: string;
	artifactDir?: string;
	tmp: string;
}
export interface CodexProfile { config: string[]; writableRoots: string[] }

/** The allow-list profile: system paths and picp's roots read, the artifact dir and scratch tmp written, nothing else. */
export function codexPermissionProfile(roots: CodexProfileRoots): CodexProfile {
	const access = new Map<string, "read" | "write">([[":minimal", "read"]]);
	for (const path of [roots.worktree, roots.gitDir, roots.codexDir]) if (path !== undefined) access.set(resolve(path), "read");
	for (const path of [roots.artifactDir, roots.tmp]) if (path !== undefined) access.set(resolve(path), "write");
	const filesystem = [...access].map(([path, mode]) => `${toml(path)}=${toml(mode)}`).join(",");
	return {
		config: ["-c", `permissions.${CODEX_PROFILE}={filesystem={${filesystem}}}`, "-c", `default_permissions=${toml(CODEX_PROFILE)}`],
		writableRoots: [...access].filter(([, mode]) => mode === "write").map(([path]) => path),
	};
}

/** The worktree's git common dir, or undefined outside a repository. */
export function codexGitDir(worktree: string): string | undefined {
	try {
		const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Two levels above the real codex binary, unless it is a system install the `:minimal` root already reads. */
export function codexReleaseDir(codexPath: string): string | undefined {
	const dir = dirname(dirname(realpathSync(codexPath)));
	return ["/usr", "/opt"].some((root) => dir === root || dir.startsWith(`${root}${sep}`)) ? undefined : dir;
}

/** `codex app-server` argv: the reduced surface, the permission profile, picp's hook, and its trust entry when known. */
export function codexSpawnArgs(options: {
	hookCommand: string;
	profile: CodexProfile;
	hookTimeoutSec?: number;
	trust?: { key: string; currentHash: string };
	surfaceFlags?: readonly string[];
}): string[] {
	const hook = `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${toml(options.hookCommand)},timeout=${options.hookTimeoutSec ?? HOOK_TIMEOUT_SEC}}]}]`;
	return [
		"app-server", "--strict-config", ...(options.surfaceFlags ?? SURFACE_FLAGS),
		"-c", hook,
		"-c", WEB_SEARCH_OFF,
		...options.profile.config,
		"-c", "project_doc_max_bytes=0",
		"-c", 'shell_environment_policy.inherit="core"',
		"-c", 'shell_environment_policy.exclude=["CODEX_*","OPENAI_*"]',
		...(options.trust === undefined ? [] : ["-c", `hooks.state={${toml(options.trust.key)}={trusted_hash=${toml(options.trust.currentHash)}}}`]),
	];
}

/** An app-server that runs no turn (a thread delete, a listing): the surface flags and web search off, no hook. */
export function codexBareArgs(): string[] {
	return ["app-server", "--strict-config", ...SURFACE_FLAGS, "-c", WEB_SEARCH_OFF];
}
