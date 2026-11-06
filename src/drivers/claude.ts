/**
 * The native Claude research driver's dispatch side (N3b): which job may run on it, and the spawn that starts
 * src/drivers/claude-worker.ts in place of pi. Every refusal names its reason and happens before any process starts.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Delivery, type FleetRecord, type JobKind, paths, type Role } from "../contracts.ts";
import { loadNativeConfig, type NativeClass, nativeConfigFile, type NativeDriver } from "../worker-driver.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";

/** Why a job may not run native (S1): the resolver falls back to pi on these; an explicit request refuses. */
export type NativeRefusal = "switch" | "pipeline" | "ineligible" | "occupied" | "cli_missing" | "cli_version" | "model" | "effort" | "denied" | "window" | "auth" | "lockdown";

export class NativeDriverError extends Error {
	readonly category?: NativeRefusal;
	constructor(message: string, category?: NativeRefusal) {
		super(message);
		if (category) this.category = category;
	}
}

const WORKER_ENTRY = fileURLToPath(new URL("./claude-worker.ts", import.meta.url));
const NATIVE_SYSTEM_PROMPT_FILE = "native-system-prompt.md";
const LIVE_PHASES: readonly string[] = ["launching", "waiting", "held"];
// One shared load: concurrent admissions awaiting their own import() could see a half-evaluated module.
let spike: Promise<typeof import("./claude-spike.ts")> | undefined;
const RESEARCH_DELIVERIES: readonly Delivery[] = ["local", "answer"];
const SHIP_DELIVERIES: readonly Delivery[] = ["pr", "local"];
const SWITCH_WHERE: Record<NativeClass, string> = {
	claude_research: "dashboard Settings → Native workers",
	claude_ship: "data/native.json claude_ship",
	claude_review: "data/native.json claude_review",
};
const NATIVE_MODEL = /^anthropic\/(claude-[A-Za-z0-9][A-Za-z0-9._[\]-]*)$/;
/** Routed levels the SDK serves as `effort`; `off` disables thinking and `minimal` has no native equivalent. */
export const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface NativeSelection {
	home: string;
	jobId: string;
	driver: NativeDriver;
	kind: JobKind;
	role: Role;
	delivery: Delivery;
	jobs: readonly FleetRecord[];
	env?: NodeJS.ProcessEnv;
}

/** The switch a job's role/kind/delivery falls under, or undefined when no native class takes it (N4f). */
export function nativeClassOf(kind: JobKind, role: Role, delivery: Delivery): NativeClass | undefined {
	if (role === "planner" && kind === "research" && RESEARCH_DELIVERIES.includes(delivery)) return "claude_research";
	if (role === "implementer" && kind === "ship" && SHIP_DELIVERIES.includes(delivery)) return "claude_ship";
	return role === "gate-reviewer" ? "claude_review" : undefined;
}

/** The first selection condition that fails, typed, or undefined: a native class whose switch is on, not owned by a
 * pipeline (D2), concurrency 1, pinned claude. */
export async function nativeSelectionRefusal(input: NativeSelection): Promise<{ category: NativeRefusal; why: string } | undefined> {
	let config: ReturnType<typeof loadNativeConfig>;
	try {
		config = loadNativeConfig(nativeConfigFile(input.home));
	} catch (error) {
		return { category: "switch", why: `the native switch is unreadable (${(error as Error).message})` };
	}
	const nativeClass = nativeClassOf(input.kind, input.role, input.delivery);
	if (nativeClass === undefined) {
		return { category: "ineligible", why: `only research (role planner, delivery local or answer) and ship (role implementer, delivery pr or local) jobs run native; this is ${input.kind}/${input.role}/${input.delivery}` };
	}
	if (!config[nativeClass]) return { category: "switch", why: `the switch workers.native_${nativeClass} is off (${SWITCH_WHERE[nativeClass]})` };
	if (existsSync(join(input.home, paths.pipelineFile(input.jobId)))) {
		return { category: "pipeline", why: "pipeline-owned research stays on pi; only local and answer research run native" };
	}
	// N4h builds the reviewer path; until then claude_review gates nothing and a reviewer stays on pi.
	if (nativeClass === "claude_review") return { category: "ineligible", why: "the native reviewer path is not built yet; gate-reviewers run on pi" };
	const live = liveNativeJobs(input.jobs).filter((id) => id !== input.jobId);
	if (live.length > 0) return { category: "occupied", why: `native concurrency is 1 and ${live.join(", ")} is live; tear it down first` };
	try {
		// Loaded on use: the SDK it imports is not on the extension's startup path.
		spike ??= import("./claude-spike.ts");
		const { resolveClaude } = await spike;
		resolveClaude(input.env ?? process.env);
	} catch (error) {
		return { category: (error as { cli?: string }).cli === "missing" ? "cli_missing" : "cli_version", why: (error as Error).message };
	}
	return undefined;
}

/** Throws the named refusal unless every N3b condition holds (explicit requests, resumes and revives). */
export async function assertNativeSelection(input: NativeSelection): Promise<void> {
	const refusal = await nativeSelectionRefusal(input);
	if (refusal) throw new NativeDriverError(`refused: ${input.jobId} cannot run on the native ${input.driver} driver: ${refusal.why}`, refusal.category);
}

/** The installed CLI's version (S2 invalidation iii), or undefined when it cannot be resolved. */
export async function installedClaudeVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	try {
		spike ??= import("./claude-spike.ts");
		return (await spike).resolveClaude(env).version;
	} catch {
		return undefined;
	}
}

/** Fleet jobs whose native worker has not been observed to exit. */
export function liveNativeJobs(jobs: readonly FleetRecord[]): string[] {
	return jobs.filter((job) => job.worker?.driver !== undefined && job.worker.exited_at === undefined && LIVE_PHASES.includes(job.phase)).map((job) => job.job_id);
}

/** The CLI's model id from an explicit `anthropic/claude-…` ref; any other ref is refused, never silently omitted. */
export function nativeModelId(model: string): string {
	const id = NATIVE_MODEL.exec(model)?.[1];
	if (id === undefined) {
		throw new NativeDriverError(`the native claude driver runs an explicit anthropic/claude-… model, and ${model} is not one: fix the rubric row or the dispatch model`, "model");
	}
	return id;
}

/** What the native model is told after the profile body: its tools are Claude's, and the artifact is Written. */
export const NATIVE_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Bash, Write) plus report_result;",
	"ignore any other tool names above. Write the research artifact with the Write tool to the predeclared artifact",
	"path (CP_ARTIFACT_PATH), never with a shell heredoc, then call report_result.",
].join("\n");

/** The ship counterpart (N4f): the forge tools replace pi's push and gh; the PR base is the job's base branch. */
export const NATIVE_SHIP_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Edit, Write, Bash), the picp forge",
	"tools (git_push, git_fetch, pr_create, pr_edit, gh_read) and report_result; ignore any other tool names above.",
	"Commit with git in Bash, push only with git_push, open the draft PR with pr_create (never gh in Bash), then call",
	"report_result once with head_sha = git rev-parse HEAD.",
].join("\n");

/**
 * Overrides pi's argv with the native worker; the role contract goes to a 0600 file in the run dir,
 * not the argv or env.
 */
export function nativeSpawnOptions(model: string, env: NodeJS.ProcessEnv, systemPrompt: string): Pick<WorkerSpawnOptions, "piBin" | "argv" | "env"> {
	const runDir = env.CP_RUN_DIR;
	if (!runDir) throw new NativeDriverError("the native claude worker has no run dir to hold its system prompt (CP_RUN_DIR unset)");
	const file = join(runDir, NATIVE_SYSTEM_PROMPT_FILE);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(file, `${systemPrompt.trimEnd()}\n\n${env.CP_KIND === "ship" ? NATIVE_SHIP_ADDENDUM : NATIVE_ADDENDUM}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return { piBin: process.execPath, argv: [WORKER_ENTRY], env: { ...env, CP_NATIVE_MODEL: nativeModelId(model), CP_NATIVE_SYSTEM_PROMPT_FILE: file } };
}

/** Refuses a routed level with no native effort; absent (the CLI default), `off` and low…max pass. */
export function assertNativeEffort(level: string | undefined): asserts level is (typeof NATIVE_EFFORTS)[number] | "off" | "" | undefined {
	if (level === undefined || level === "" || level === "off" || (NATIVE_EFFORTS as readonly string[]).includes(level)) return;
	throw new NativeDriverError(`thinking=${level} has no native claude effort; route off, low, medium, high, xhigh or max`, "effort");
}

/** The routed thinking level for the native worker's SDK options; absent leaves the CLI default (recorded as such). */
export function nativeThinkingEnv(thinking: string | undefined): Record<string, string> {
	return thinking ? { CP_NATIVE_THINKING: thinking } : {};
}

/** The job's base branch for the native worker's forge tools: the PR base, and a branch `git_push` refuses. */
export function nativeBaseEnv(base: string | undefined): Record<string, string> {
	return base?.trim() ? { CP_BASE_BRANCH: base.trim() } : {};
}
