/**
 * How picp starts `codex app-server`: the child env, the reduced surface, picp's hook, and the allow-list permission
 * profile (`picp_planner`, C7a `picp_implementer`) that confines every command in the kernel whatever the hook does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, globSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_ENV_NAME } from "../web-egress.ts";
import { agentDirOf } from "../worker-mcp.ts";
import { CodexSpikeError } from "./codex-cli.ts";
import { CONTAIN_ENV_KEY } from "./codex-containment.ts";
import type { SpikeJob } from "./native-guards.ts";

/** Features picp turns off (AP probe P11, C1 probes E5/E7/E8); the lockdown reads each back as disabled. */
export const CODEX_OFF_FEATURES: readonly string[] = [
	"apps", "plugins", "multi_agent", "image_generation", "memories", "view_image", "goals", "sleep_tool", "unified_exec_tty",
];
export const SURFACE_FLAGS: readonly string[] = [
	...CODEX_OFF_FEATURES.flatMap((feature) => ["--disable", feature]),
	"--enable", "skip_host_skill_discovery",
];
/** C6: a reviewer also loses the CLI's shell (V3); the lockdown reads it back off. */
export const CODEX_REVIEWER_OFF_FEATURES: readonly string[] = ["shell_tool"];
export const REVIEWER_SURFACE_FLAGS: readonly string[] = [...SURFACE_FLAGS, ...CODEX_REVIEWER_OFF_FEATURES.flatMap((feature) => ["--disable", feature])];
export const CODEX_PROFILE = "picp_planner";
/** C7a: the write-capable profile; its worktree is written, its `.git` and existing excluded paths only read. */
export const CODEX_IMPLEMENTER_PROFILE = "picp_implementer";
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
	/** C7a: `implementer` writes the worktree under `picp_implementer`; any other run reads it under `picp_planner`. */
	role?: "implementer";
	worktree: string;
	/** `git rev-parse --git-common-dir`: a linked worktree's `.git` is a file pointing outside it. */
	gitDir?: string;
	/** The release dir the sandbox re-executes the codex binary from (E17). */
	codexDir?: string;
	artifactDir?: string;
	tmp: string;
	/** Per-job skill dirs the brief names (C5), each a read root; `codexSkillRoots` vets them. */
	skills?: readonly string[];
	/** Implementer only: paths inside the writable worktree kept read-only (`.git`, existing excluded paths). */
	readOnly?: readonly string[];
	/** Operator read roots (`CP_CODEX_READ_ROOTS`), vetted as skill dirs are. */
	readRoots?: readonly string[];
}
export type CodexAccess = "read" | "write" | "deny";
/** `filesystem` is the map picp passed, which the lockdown reads back entry by entry (C7a). */
export interface CodexProfile { id: string; config: string[]; writableRoots: string[]; filesystem: Record<string, CodexAccess> }

/**
 * The allow-list profile: system paths and picp's roots read, the artifact dir and scratch tmp written, nothing else.
 * The `/` deny keeps the sandbox on for a command a user allow rule approves; without one 0.170.0 runs it unsandboxed.
 * An implementer also writes its worktree (the cwd, which the thread read-back does not list as a writable root).
 */
export function codexPermissionProfile(roots: CodexProfileRoots): CodexProfile {
	const implementer = roots.role === "implementer";
	const id = implementer ? CODEX_IMPLEMENTER_PROFILE : CODEX_PROFILE;
	const access = new Map<string, CodexAccess>([["/", "deny"], [":minimal", "read"]]);
	const worktree = resolve(roots.worktree);
	access.set(worktree, implementer ? "write" : "read");
	const reads = [roots.gitDir, roots.codexDir, ...(roots.skills ?? []), ...(roots.readRoots ?? []), ...(implementer ? roots.readOnly ?? [] : [])];
	for (const path of reads) if (path !== undefined) access.set(resolve(path), "read");
	for (const path of [roots.artifactDir, roots.tmp]) if (path !== undefined) access.set(resolve(path), "write");
	const filesystem = [...access].map(([path, mode]) => `${toml(path)}=${toml(mode)}`).join(",");
	return {
		id,
		config: ["-c", `permissions.${id}={filesystem={${filesystem}}}`, "-c", `default_permissions=${toml(id)}`],
		writableRoots: [...access].filter(([path, mode]) => mode === "write" && path !== worktree).map(([path]) => path),
		filesystem: Object.fromEntries(access),
	};
}

const EXCLUDED_GLOB_MAX = 200;

/**
 * The implementer's existing excluded paths inside `worktree`: a plain needle joined to it, a glob through `globSync`
 * (at most 200 hits, `.git` and `node_modules` not walked), each kept only when its realpath stays inside. A missing
 * path is never listed: the sandbox would create it (C7 probe PA). The `git_commit` gate is the complete check.
 */
export function codexExcludedRoots(worktree: string, excluded: readonly string[]): string[] {
	const top = realpathSync(worktree);
	const inside = (path: string): string | undefined => {
		if (!existsSync(path)) return undefined;
		const real = realpathSync(path);
		const rel = relative(top, real);
		return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : real;
	};
	const found = new Set<string>();
	for (const needle of excluded) {
		const clean = needle.replace(/\/+$/, "");
		if (clean === "") continue;
		const hits = !needle.includes("*")
			? [join(top, clean)]
			: globSync(clean, { cwd: top, exclude: (name) => name === ".git" || name === "node_modules" }).slice(0, EXCLUDED_GLOB_MAX).map((hit) => join(top, hit));
		for (const hit of hits) {
			const real = inside(hit);
			if (real !== undefined) found.add(real);
		}
	}
	return [...found].sort();
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

const realOrResolved = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};
/** Whether `dir` is `path` or one of its ancestors. */
const holds = (dir: string, path: string): boolean => realOrResolved(path) === dir || realOrResolved(path).startsWith(`${dir === sep ? "" : dir}${sep}`);

/**
 * Two levels above the real codex binary, unless it is a system install the `:minimal` root already reads. A dir that
 * is or holds a home or the Codex home would open it to the sandbox, so it throws and the driver does not start.
 */
export function codexReleaseDir(codexPath: string, guarded: { homes: ReadonlyArray<string | undefined>; codexHome: string }): string | undefined {
	const dir = dirname(dirname(realpathSync(codexPath)));
	if (["/usr", "/opt"].some((root) => dir === root || dir.startsWith(`${root}${sep}`))) return undefined;
	const home = guarded.homes.find((path): path is string => path !== undefined && path !== "" && holds(dir, path));
	const why = home !== undefined ? "is or holds the home" : holds(dir, guarded.codexHome) ? "is or holds the Codex home" : undefined;
	if (why === undefined) return dir;
	throw Object.assign(new CodexSpikeError(`Refused: the codex release dir (two levels above the real codex binary) ${why}; picp will not open it to the sandbox. Reinstall the Codex CLI under its own release dir.`), { cli: "version" as const });
}

/** The skill dirs' (or read roots') realpaths; one that is relative, or is or holds a home, the Codex home or a guarded
 * dir, throws. */
export function codexSkillRoots(
	dirs: readonly string[],
	guarded: { homes: ReadonlyArray<string | undefined>; codexHome: string; others: ReadonlyArray<string | undefined> },
	label = "skill dir",
): string[] {
	return dirs.map((each) => {
		if (!isAbsolute(each)) throw Object.assign(new CodexSpikeError(`Refused: the ${label} ${each} is not an absolute path.`), { cli: "version" as const });
		const dir = realOrResolved(each);
		const hit = [...guarded.homes, guarded.codexHome, ...guarded.others].find((path): path is string => path !== undefined && path !== "" && holds(dir, path));
		if (hit === undefined) return dir;
		throw Object.assign(new CodexSpikeError(`Refused: the ${label} ${each} is or holds a home, the Codex home, the agent dir or the CP home; picp will not open it to the sandbox.`), { cli: "version" as const });
	});
}

/** A run's profile roots: the role's git dir, the release dir, vetted skill and read roots, and (implementer) the
 * worktree's `.git` and existing excluded paths read-only. A guarded root throws before any app-server. */
export function codexRunRoots(input: {
	job: Pick<SpikeJob, "role" | "worktree" | "artifactPath" | "excludePaths">;
	codexPath: string;
	codexHome: string;
	hostEnv: NodeJS.ProcessEnv;
	tmp: string;
	skillDirs?: readonly string[];
	readRoots?: readonly string[];
}): CodexProfileRoots {
	const { job, codexHome, hostEnv } = input;
	const homes = [hostEnv.HOME, userInfo().homedir];
	const guarded = { homes, codexHome, others: [agentDirOf(hostEnv), hostEnv.CP_HOME] };
	const implementer = job.role === "implementer";
	const dotGit = join(job.worktree, ".git");
	return {
		...(implementer ? { role: "implementer" as const } : {}),
		worktree: job.worktree, gitDir: job.role === "gate-reviewer" ? undefined : codexGitDir(job.worktree), codexDir: codexReleaseDir(input.codexPath, { homes, codexHome }),
		artifactDir: job.artifactPath === undefined ? undefined : dirname(job.artifactPath), tmp: input.tmp,
		skills: input.skillDirs?.length ? codexSkillRoots(input.skillDirs, guarded) : undefined,
		...(input.readRoots?.length ? { readRoots: codexSkillRoots(input.readRoots, guarded, "read root") } : {}),
		...(implementer ? { readOnly: [...(existsSync(dotGit) ? [dotGit] : []), ...codexExcludedRoots(job.worktree, job.excludePaths ?? [])] } : {}),
	};
}

/** `codex app-server` argv: the reduced surface, the profile, picp's hook, and its trust entry when known. */
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
		// "all" over picp's own allow-listed app-server env, so the WP3 names reach the model's shell (C5, M12).
		"-c", 'shell_environment_policy.inherit="all"',
		"-c", 'shell_environment_policy.exclude=["CODEX_*","OPENAI_*","INVOCATION_ID"]',
		...(options.trust === undefined ? [] : ["-c", `hooks.state={${toml(options.trust.key)}={trusted_hash=${toml(options.trust.currentHash)}}}`]),
	];
}

/** An app-server that runs no turn (a thread delete, a listing): the surface flags and web search off, no hook. */
export function codexBareArgs(): string[] {
	return ["app-server", "--strict-config", ...SURFACE_FLAGS, "-c", WEB_SEARCH_OFF];
}
