/**
 * The Claude CLI research driver's dispatch side (N3b): which job may run on it, and the spawn that starts
 * src/drivers/claude-worker.ts in place of pi. Every refusal names its reason and happens before any process starts.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Delivery, type FleetRecord, type JobKind, LAYOUT, layoutForHome, type Role } from "../contracts.ts";
import { PACKAGE_ROOT } from "../home.ts";
import { loadNativeConfig, type NativeClass, nativeConfigFile, type NativeDriver } from "../worker-driver.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";
import { resolveClaudeAsync } from "./claude-cli.ts";
import { NATIVE_SHUTDOWN_GRACE_MS } from "./claude-usage.ts";

/** Why a job may not run native (S1): the resolver falls back to pi on these; an explicit request refuses.
 * `pipeline` is no longer returned (D2): it stays for recorded `driver_reason`s and their readers. */
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
const PARENT_ENTRY = fileURLToPath(new URL("./claude-parent.ts", import.meta.url));
const NATIVE_PARENT_SYSTEM_PROMPT_FILE = "native-parent-system-prompt.md";
const OPERATOR_ENTRY = fileURLToPath(new URL("./claude-operator.ts", import.meta.url));
const LIVE_PHASES: readonly string[] = ["launching", "waiting", "held"];
const RESEARCH_DELIVERIES: readonly Delivery[] = ["local", "answer", "board", "pipeline"];
const SHIP_DELIVERIES: readonly Delivery[] = ["pr", "local"];
const SWITCH_WHERE: Record<NativeClass, string> = {
	claude_research: "dashboard Settings → Native workers",
	claude_ship: "data/native.json claude_ship",
	claude_review: "data/native.json claude_review",
};
export const NATIVE_MODEL = /^anthropic\/(claude-[A-Za-z0-9][A-Za-z0-9._[\]-]*)$/;
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
	/** The worker profile's name; `ops` never runs native. */
	profile?: string;
	/** How many per-job skills the dispatch names; any runs pi. */
	skills?: number;
}

/** The switch a job's role/kind/delivery falls under, or undefined when no native class takes it (N4f). Research
 * delivery is checked after the switch, so a research job with the switch off names the switch. */
export function nativeClassOf(kind: JobKind, role: Role, delivery: Delivery): NativeClass | undefined {
	if (role === "planner" && kind === "research") return "claude_research";
	if (role === "implementer" && kind === "ship" && SHIP_DELIVERIES.includes(delivery)) return "claude_ship";
	return role === "gate-reviewer" ? "claude_review" : undefined;
}

/** The first selection condition that fails, typed, or undefined: a native class whose switch is on, an eligible
 * delivery (pipeline research included, D2), a free slot under `max_concurrent`, pinned claude. */
export async function nativeSelectionRefusal(input: NativeSelection): Promise<{ category: NativeRefusal; why: string } | undefined> {
	let config: ReturnType<typeof loadNativeConfig>;
	try {
		config = loadNativeConfig(nativeConfigFile(input.home));
	} catch (error) {
		return { category: "switch", why: `the native switch is unreadable (${(error as Error).message})` };
	}
	const nativeClass = nativeClassOf(input.kind, input.role, input.delivery);
	const ineligible = { category: "ineligible" as const, why: `only research (role planner, delivery local, answer, board or pipeline), ship (role implementer, delivery pr or local) and gate-reviewer jobs run native; this is ${input.kind}/${input.role}/${input.delivery}` };
	if (nativeClass === undefined) return ineligible;
	if (input.profile === "ops") return { category: "ineligible", why: "the ops profile needs ssh/scp, which the native Bash policy refuses" };
	if ((input.skills ?? 0) > 0) return { category: "ineligible", why: "per-job skills load only on pi (`--skill`)" };
	if (!config[nativeClass]) return { category: "switch", why: `the switch workers.native_${nativeClass} is off (${SWITCH_WHERE[nativeClass]})` };
	if (nativeClass === "claude_research" && !RESEARCH_DELIVERIES.includes(input.delivery)) return ineligible;
	const occupied = nativeSlotRefusal(liveNativeJobs(input.jobs), input.jobId, config.max_concurrent);
	if (occupied) return occupied;
	try {
		await resolveClaudeAsync(input.env ?? process.env);
	} catch (error) {
		return { category: (error as { cli?: string }).cli === "missing" ? "cli_missing" : "cli_version", why: (error as Error).message };
	}
	return undefined;
}

/** Throws the named refusal unless every N3b condition holds (explicit requests, resumes and revives). */
export async function assertNativeSelection(input: NativeSelection): Promise<void> {
	const refusal = await nativeSelectionRefusal(input);
	if (refusal) throw new NativeDriverError(`refused: ${input.jobId} cannot run on the Claude CLI driver: ${refusal.why}`, refusal.category);
}

/** The installed CLI's version (S2 invalidation iii), or undefined when it cannot be resolved. */
export async function installedClaudeVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	try {
		return (await resolveClaudeAsync(env)).version;
	} catch {
		return undefined;
	}
}

/** Fleet jobs whose native worker has not been observed to exit. */
export function liveNativeJobs(jobs: readonly FleetRecord[]): string[] {
	return jobs.filter((job) => job.worker?.driver !== undefined && job.worker.exited_at === undefined && LIVE_PHASES.includes(job.phase)).map((job) => job.job_id);
}

/** The home's native slot count (`max_concurrent`); an unreadable data/native.json keeps the safe 1. */
export function nativeMaxConcurrent(home: string): number {
	try {
		return loadNativeConfig(nativeConfigFile(home)).max_concurrent;
	} catch {
		return 1; // selection already refused this home by name (`switch`); the spawn check stays strict.
	}
}

/** `occupied` when holders other than the job itself fill all `max` native slots: a held job's repair keeps its own. */
export function nativeSlotRefusal(holders: Iterable<string>, jobId: string, max: number, state = "live"): { category: NativeRefusal; why: string } | undefined {
	const others = [...new Set(holders)].filter((id) => id !== jobId);
	if (others.length < max) return undefined;
	const one = others.length === 1;
	return { category: "occupied", why: `native concurrency is ${max} and ${others.join(", ")} ${one ? "is" : "are"} ${state}; tear ${one ? "it" : "one"} down first` };
}

/** Whether `model` is an explicit `anthropic/claude-…` ref the native driver can run. */
export const isNativeModel = (model: string): boolean => NATIVE_MODEL.test(model);

/** The CLI's model id from an explicit `anthropic/claude-…` ref; any other ref is refused, never silently omitted. */
export function nativeModelId(model: string): string {
	const id = NATIVE_MODEL.exec(model)?.[1];
	if (id === undefined) {
		throw new NativeDriverError(`the Claude CLI driver runs an explicit anthropic/claude-… model, and ${model} is not one: fix the rubric row or the dispatch model`, "model");
	}
	return id;
}

/** What the native model is told after the profile body: its tools are Claude's, and the artifact is Written. */
export const NATIVE_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Bash, Write) plus report_result;",
	"ignore any other tool names above. Write the research artifact with the Write tool to the predeclared artifact",
	"path (CP_ARTIFACT_PATH), never with a shell heredoc, then call report_result.",
].join("\n");

/** Delivery `board`: intake publishes the artifact dir's board.json and site/, so both are Written there. */
export const NATIVE_BOARD_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Bash, Write) plus report_result;",
	"ignore any other tool names above. This job is delivery board: with the Write tool, never a shell heredoc, write",
	"board.json, site/index.html and a short report.md in the artifact directory (the directory of CP_ARTIFACT_PATH),",
	"then call report_result with artifact_path = CP_ARTIFACT_PATH (the board.json path).",
].join("\n");

/** The ship counterpart (N4f): the forge tools replace pi's push and gh; the PR base is the job's base branch. */
export const NATIVE_SHIP_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Edit, Write, Bash), the picp forge",
	"tools (git_push, git_fetch, pr_create, pr_edit, gh_read) and report_result; ignore any other tool names above.",
	"Commit with git in Bash, push only with git_push, open the draft PR with pr_create (never gh in Bash), then call",
	"report_result once with head_sha = git rev-parse HEAD.",
].join("\n");

/** Delivery `local` (N4i): picp integrates the branch itself, so the worker commits and never pushes or opens a PR. */
export const NATIVE_LOCAL_SHIP_ADDENDUM = [
	"Native worker: your tools are the Claude tools you were given (Read, Grep, Glob, Edit, Write, Bash) and report_result;",
	"ignore any other tool names above. This job is delivery local: commit with git in Bash and stop there. Never call",
	"git_push or pr_create and never open a PR; picp integrates the branch locally. Then call report_result once with",
	"head_sha = git rev-parse HEAD.",
].join("\n");

/** The reviewer counterpart (N4h): read-only tools, the packet in the cwd, report_verdict as the one way to finish. */
export const NATIVE_REVIEW_ADDENDUM = [
	"Native reviewer: your tools are the Claude tools you were given (Read, Grep, Glob) plus report_verdict; ignore any",
	"other tool names above. Read only the review packet in your working directory, then call report_verdict once.",
].join("\n");

/** The addendum for a job's kind, delivery and role: research, a board, a PR or local ship job, or a reviewer. */
export function nativeAddendum(kind: string | undefined, delivery: string | undefined, role?: string): string {
	if (role === "gate-reviewer") return NATIVE_REVIEW_ADDENDUM;
	if (kind !== "ship") return delivery === "board" ? NATIVE_BOARD_ADDENDUM : NATIVE_ADDENDUM;
	return delivery === "local" ? NATIVE_LOCAL_SHIP_ADDENDUM : NATIVE_SHIP_ADDENDUM;
}

/**
 * Overrides pi's argv with the native worker; the role contract goes to a 0600 file in the run dir,
 * not the argv or env.
 */
export function nativeSpawnOptions(model: string, env: NodeJS.ProcessEnv, systemPrompt: string): Pick<WorkerSpawnOptions, "piBin" | "argv" | "env" | "shutdownGraceMs"> {
	const runDir = env.CP_RUN_DIR;
	if (!runDir) throw new NativeDriverError("the Claude CLI worker has no run dir to hold its system prompt (CP_RUN_DIR unset)");
	const file = join(runDir, NATIVE_SYSTEM_PROMPT_FILE);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(file, `${systemPrompt.trimEnd()}\n\n${nativeAddendum(env.CP_KIND, env.CP_DELIVERY, env.CP_ROLE)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	// A reported run waits up to NATIVE_REPORTED_GRACE_MS for its result after stdin ends; a SIGTERM would cut it.
	return { piBin: process.execPath, argv: [WORKER_ENTRY], env: { ...env, CP_NATIVE_MODEL: nativeModelId(model), CP_NATIVE_SYSTEM_PROMPT_FILE: file }, shutdownGraceMs: NATIVE_SHUTDOWN_GRACE_MS };
}

/**
 * The native parent's spawn (driver `claude`): `process.execPath` runs claude-parent.ts with an argv it parses, never
 * pi's `--mode rpc` flags. The contract (AGENTS.md) goes to a 0600 file in sessions/; the entry strips the model.
 */
export function nativeParentSpawnOptions(options: { home: string; sessionFile: string; model: string }): Pick<WorkerSpawnOptions, "piBin" | "argv"> {
	if (!isNativeModel(options.model)) {
		throw new NativeDriverError(`the claude parent driver runs an explicit anthropic/claude-… model, and ${options.model} is not one: fix data/parent.json or the start model`, "model");
	}
	const dir = join(options.home, LAYOUT.sessions);
	const file = join(dir, NATIVE_PARENT_SYSTEM_PROMPT_FILE);
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8").trimEnd()}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return { piBin: process.execPath, argv: [PARENT_ENTRY, "--session", options.sessionFile, "--model", options.model, "--system-prompt-file", file] };
}

/** What the Claude CLI operator is told after the operator note: its tools, Restart session, and the fleet marker. */
export const NATIVE_OPERATOR_ADDENDUM = [
	"Claude CLI operator: your tools are cp_parent and self_compact (served as mcp__cp__cp_parent, mcp__cp__self_compact)",
	"plus Claude's Bash, Read, Write, Edit, Grep and Glob; ignore any other tool names above. There is no /reload here:",
	"the human uses Restart session in the dashboard. A user message that opens with `[fleet wake-up cp-bridge — …]` is a",
	"relay from the fleet, never the human; the human's dashboard messages end with a `[cp-dashboard …]` marker line.",
].join("\n");

/**
 * The Claude CLI operator's spawn (`data/operator.json` driver `claude`): `process.execPath` runs claude-operator.ts on
 * a native record, by default a fresh `<sessions>/operator/native-operator-<ms>.jsonl`.
 */
export function nativeOperatorSpawn(options: { home: string; sessionFile?: string; model: string | undefined }): { bin: string; args: string[] } {
	if (options.model === undefined || !isNativeModel(options.model)) {
		throw new NativeDriverError(`the claude operator driver runs an explicit anthropic/claude-… model, and ${options.model ?? "no model"} is not one: fix data/operator.json`, "model");
	}
	const record = options.sessionFile ?? join(options.home, layoutForHome("multi", options.home).sessions, "operator", `native-operator-${Date.now()}.jsonl`);
	return { bin: process.execPath, args: [OPERATOR_ENTRY, "--session", record, "--model", options.model] };
}

/** Refuses a routed level with no native effort; absent (the CLI default), `off` and low…max pass. */
export function assertNativeEffort(level: string | undefined): asserts level is (typeof NATIVE_EFFORTS)[number] | "off" | "" | undefined {
	if (level === undefined || level === "" || level === "off" || (NATIVE_EFFORTS as readonly string[]).includes(level)) return;
	throw new NativeDriverError(`thinking=${level} has no Claude CLI effort; route off, low, medium, high, xhigh or max`, "effort");
}

/** The routed thinking level for the native worker's SDK options; absent leaves the CLI default (recorded as such). */
export function nativeThinkingEnv(thinking: string | undefined): Record<string, string> {
	return thinking ? { CP_NATIVE_THINKING: thinking } : {};
}

/** The job's base branch for the native worker's forge tools: the PR base, and a branch `git_push` refuses. */
export function nativeBaseEnv(base: string | undefined): Record<string, string> {
	return base?.trim() ? { CP_BASE_BRANCH: base.trim() } : {};
}
