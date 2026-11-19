/**
 * The Codex CLI research driver's dispatch side (C1b): which job may run on it and the spawn that starts
 * src/drivers/codex-worker.ts in place of pi. Every refusal is named and happens before any process starts.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delivery, JobKind, Role } from "../contracts.ts";
import { type CodexClass, loadNativeConfig, nativeConfigFile } from "../worker-driver.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";
import { WORKER_MEMORY_MAX_ENV } from "../worker-scope.ts";
import { liveNativeJobs, NativeDriverError, type NativeRefusal, type NativeSelection, nativeSlotRefusal } from "./claude.ts";
import { codexLoginRefusal, defaultCodexHome, resolveCodexAsync } from "./codex-cli.ts";
import { resolveCodexContainment } from "./codex-containment.ts";

const WORKER_ENTRY = fileURLToPath(new URL("./codex-worker.ts", import.meta.url));
const SYSTEM_PROMPT_FILE = "codex-system-prompt.md";
export const SKILL_DIRS_ENV = "CP_CODEX_SKILL_DIRS";
const DELIVERIES: readonly Delivery[] = ["local", "answer"];
export const CODEX_MODEL = /^openai\/(gpt-[A-Za-z0-9][A-Za-z0-9._-]*)$/;
/** Routed levels the Codex CLI serves as `effort`; `off` and `minimal` have none. */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** The worker reports before its 30 s grace: a reported run only closes its app-server after stdin ends. */
export const CODEX_SHUTDOWN_GRACE_MS = 30_000;

export const isCodexModel = (model: string): boolean => CODEX_MODEL.test(model);

/** The CLI's model id from an explicit `openai/gpt-…` ref; any other ref is refused, never silently omitted. */
export function codexModelId(model: string): string {
	const id = CODEX_MODEL.exec(model)?.[1];
	if (id === undefined) throw new NativeDriverError(`the Codex CLI driver runs an explicit openai/gpt-… model, and ${model} is not one: fix the rubric row or the dispatch model`, "model");
	return id;
}

/** Refuses a routed level with no Codex effort; absent (the CLI default) and low…max pass. */
export function assertCodexEffort(level: string | undefined): void {
	if (level === undefined || level === "" || (CODEX_EFFORTS as readonly string[]).includes(level)) return;
	throw new NativeDriverError(`thinking=${level} has no Codex CLI effort; route low, medium, high, xhigh or max`, "effort");
}

/** The Codex home picp passes as `CODEX_HOME` and never opens: `CP_CODEX_HOME`, else `<passwd home>/.codex`. */
export const codexHomeOf = (env: NodeJS.ProcessEnv): string => env.CP_CODEX_HOME?.trim() || defaultCodexHome();

/** Planner research and (C6) gate reviewers have a Codex class; `codex_ship` selects nothing yet. */
export const codexClassOf = (kind: JobKind, role: Role): CodexClass | undefined =>
	role === "gate-reviewer" ? "codex_review" : role === "planner" && kind === "research" ? "codex_research" : undefined;

/** `codex_max_concurrent`; an unreadable data/native.json keeps the safe 1. */
export function codexMaxConcurrent(home: string): number {
	try {
		return loadNativeConfig(nativeConfigFile(home)).codex_max_concurrent;
	} catch {
		return 1;
	}
}

/**
 * Why picp may not persist a `codex` value (a queued or armed request, a rubric row) in this home: while every codex
 * switch is off, the fleet, queue, routing and native.json files stay readable by a build before C1b.
 */
export function codexPersistRefusal(home: string, what: string): string | undefined {
	let on: boolean;
	try {
		on = loadNativeConfig(nativeConfigFile(home)).codex_research;
	} catch (error) {
		return `${what} names the codex driver and data/native.json is unreadable (${(error as Error).message}); nothing was written`;
	}
	return on ? undefined : `${what} names the codex driver while codex_research is off (data/native.json); turn it on first. Nothing was written`;
}

/** The first selection refusal, in order: switch file, class, switch, delivery, profile, slot, scope, CLI, login. */
export async function codexSelectionRefusal(input: NativeSelection): Promise<{ category: NativeRefusal; why: string } | undefined> {
	let config: ReturnType<typeof loadNativeConfig>;
	try {
		config = loadNativeConfig(nativeConfigFile(input.home));
	} catch (error) {
		return { category: "switch", why: `the native switch is unreadable (${(error as Error).message})` };
	}
	const ineligible = {
		category: "ineligible" as const,
		why: `only research (role planner, delivery local or answer) runs on the Codex CLI, beside gate reviewers; this is ${input.kind}/${input.role}/${input.delivery}`,
	};
	const codexClass = codexClassOf(input.kind, input.role);
	if (codexClass === undefined) return ineligible;
	if (!config[codexClass]) return { category: "switch", why: `the switch ${codexClass} is off (data/native.json ${codexClass})` };
	if (codexClass === "codex_research" && !DELIVERIES.includes(input.delivery)) return ineligible;
	// C5 Q3: the Codex shell has no network and no agent socket, so an ops job falls back rather than run without ssh.
	if (input.profile === "ops") return { category: "ineligible", why: "profile ops runs no Codex CLI job: the Codex shell has no network and no ssh agent" };
	const occupied = nativeSlotRefusal(liveNativeJobs(input.jobs, "codex"), input.jobId, config.codex_max_concurrent, "live", "codex");
	if (occupied) return occupied;
	const env = input.env ?? process.env;
	const memory = env[WORKER_MEMORY_MAX_ENV];
	try {
		resolveCodexContainment({ ...env, ...(memory ? { CP_CODEX_MEMORY_MAX: memory } : {}) });
	} catch (error) {
		return { category: "containment", why: (error as Error).message };
	}
	let codex: { path: string };
	try {
		codex = await resolveCodexAsync(env);
	} catch (error) {
		return { category: (error as { cli?: string }).cli === "missing" ? "cli_missing" : "cli_version", why: (error as Error).message };
	}
	// F10: `login status` reads only CODEX_HOME; HOME is a path that does not exist, so nothing is written to a home.
	const login = await codexLoginRefusal(codex.path, { codexHome: codexHomeOf(env), home: "/nonexistent", pathEnv: env.PATH ?? "" });
	return login === undefined ? undefined : { category: "auth", why: login };
}

/** What the Codex model is told after the profile body: its tools, its read-only reach, and how the artifact is written. */
export const CODEX_ADDENDUM = [
	"Codex worker: your tools are the Codex shell, gh_read for GitHub reads (never gh in the shell), the MCP servers named",
	"below if any, and report_result; ignore any other tool names above. The shell reads the worktree, the skill",
	"directories your brief names and system paths only, has no network, and writes only the artifact directory. Write",
	"the artifact with a quoted heredoc to the predeclared artifact path (CP_ARTIFACT_PATH). apply_patch, sub-agents and",
	"web search are refused. Then call report_result once.",
].join("\n");

/** C6: what a Codex reviewer is told after the profile body: picp's packet reads and the verdict, no shell. */
export const CODEX_REVIEW_ADDENDUM = [
	"Codex reviewer: your tools are read, grep and find, served by picp over the review packet in your working",
	"directory, plus report_verdict; ignore any other tool names above (there is no ls). There is no shell, no patch tool,",
	"no web search and no sub-agent. grep takes literal text, not a regular expression. Read the packet, then call",
	"report_verdict once.",
].join("\n");

/**
 * Overrides pi's argv with the Codex worker; the role contract goes to a 0600 file in the run dir, not the argv or env.
 * `skills` (C5): the per-job skill dirs, as `CP_CODEX_SKILL_DIRS` (a JSON array) for the sandbox's read roots.
 */
export function codexSpawnOptions(
	model: string, env: NodeJS.ProcessEnv, systemPrompt: string, options: { skills?: readonly string[] } = {},
): Pick<WorkerSpawnOptions, "piBin" | "argv" | "env" | "shutdownGraceMs"> {
	const runDir = env.CP_RUN_DIR;
	if (!runDir) throw new NativeDriverError("the Codex CLI worker has no run dir to hold its system prompt (CP_RUN_DIR unset)");
	const file = join(runDir, SYSTEM_PROMPT_FILE);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(file, `${systemPrompt.trimEnd()}\n\n${env.CP_ROLE === "gate-reviewer" ? CODEX_REVIEW_ADDENDUM : CODEX_ADDENDUM}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	const memory = process.env[WORKER_MEMORY_MAX_ENV];
	const { [SKILL_DIRS_ENV]: _inherited, ...rest } = env;
	return {
		piBin: process.execPath,
		argv: [WORKER_ENTRY],
		env: {
			...rest, ...(options.skills?.length ? { [SKILL_DIRS_ENV]: JSON.stringify(options.skills) } : {}), CP_CODEX_MODEL: codexModelId(model), CP_CODEX_SYSTEM_PROMPT_FILE: file, CP_CODEX_HOME: codexHomeOf(process.env),
			...(memory ? { CP_CODEX_MEMORY_MAX: memory } : {}),
		},
		shutdownGraceMs: CODEX_SHUTDOWN_GRACE_MS,
	};
}

/** Why a codex job takes no checkpoint (C2): nothing is sent or spawned. */
export function codexDoorRefusal(jobId: string, door: string): string {
	return `${jobId} runs on the Codex CLI driver: ${door} is refused (a research planner has nothing to checkpoint; the checkpoint lands with Codex ship jobs, C7). Nothing was sent or spawned.`;
}

/** What a codex `cp_send` did (C2): resumed the thread, queued until the turn ends, or steered the running turn. */
export const CODEX_ACK = {
	resumed:
		"resuming: one new Codex app-server resumes this job's thread with the message as its next prompt (run event " +
		"native_run, or the worker's named failure on its observed exit); nothing was steered",
	queued:
		"queued until the current turn ends: one new Codex app-server resumes this job's thread after it and delivers the " +
		"message under the same admission and gates (run event native_followup_delivered), or native_followup_refused names " +
		"why not; nothing was steered",
	steered:
		"steered: the Codex CLI acknowledged turn/steer for the running turn (run event native_steered); the report slot was not reopened",
} as const;
