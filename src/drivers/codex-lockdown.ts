/**
 * The Codex surface lockdown: before any thread only picp's trusted hook, no MCP server, the pinned skills, picp's
 * features off and web search disabled; after `thread/start` the profile read-back and only the MCP servers picp
 * passed (C5). Any miss refuses. Counts only.
 */
import { resolve } from "node:path";
import { CODEX_OFF_FEATURES, CODEX_PROFILE } from "./codex-launch.ts";
import type {
	ConfigReadResponse,
	ExperimentalFeature,
	HooksListResponse,
	ListMcpServerStatusResponse,
	SkillsListResponse,
	ThreadStartResponse,
} from "./codex-protocol.ts";

/** The `system`-scope skills codex 0.170.0 loads under SURFACE_FLAGS, as the live smoke LS-2 listed them (X5). */
export const CODEX_BUILTIN_SKILLS: readonly string[] = ["imagegen", "openai-docs", "review-agent", "skill-creator", "skill-installer"];

export interface CodexSurface {
	codexHome: { passed: string; reported: string };
	account: boolean;
	hookCommand: string;
	hooks: HooksListResponse;
	mcpServers: ListMcpServerStatusResponse;
	skills: SkillsListResponse;
	builtinSkills?: readonly string[];
	/** Every page of `experimentalFeature/list`. */
	features: ExperimentalFeature[];
	config: ConfigReadResponse;
	/** What picp passed: the profile id and the roots it made writable. */
	profile: { id: string; writableRoots: readonly string[] };
	/** The MCP server names picp passed in the thread config (C5); the pre-thread list must still be empty. */
	mcpServersPassed?: readonly string[];
	/** Present once `thread/start` (or `thread/resume`) answered; `mcpListed` is that thread's server list (C5). */
	thread?: { response: ThreadStartResponse; cwd: string; mcpListed?: ListMcpServerStatusResponse };
}

/** `features`: seen counts enabled ones; extra counts picp's off-list enabled or unlisted, and `hooks` off. */
export interface CodexSurfaceCounts { hooks: number; mcpServers: number; skills: number; instructionSources: number; features: number }

export interface CodexLockdown {
	verdict: "ok" | "refused";
	seen: CodexSurfaceCounts;
	extra: CodexSurfaceCounts;
	refusal?: string;
	checkMs?: number;
}

/** Compares what the CLI loaded with what picp passed; pure, and never names a stray hook, server or skill. */
export function codexLockdownVerdict(surface: CodexSurface): CodexLockdown {
	const builtin = surface.builtinSkills ?? CODEX_BUILTIN_SKILLS;
	const hooks = surface.hooks.data.flatMap((entry) => entry.hooks);
	const hookErrors = surface.hooks.data.reduce((sum, entry) => sum + entry.errors.length, 0);
	const ours = hooks.filter((hook) => hook.handlerType === "command" && hook.command === surface.hookCommand);
	const skills = surface.skills.data.flatMap((entry) => entry.skills);
	const sources = surface.thread?.response.instructionSources ?? [];
	const enabled = new Map(surface.features.map((feature) => [feature.name, feature.enabled]));
	const passed = new Set(surface.mcpServersPassed ?? []);
	const listed = surface.thread?.mcpListed?.data ?? [];
	// With a server passed, picp's MCP gate is the CLI asking before each tool call (M8): that feature must be on.
	const elicitation = passed.size > 0 && enabled.get("tool_call_mcp_elicitation") !== true ? 1 : 0;
	const wrongFeatures = CODEX_OFF_FEATURES.filter((name) => enabled.get(name) !== false).length + (enabled.get("hooks") === true ? 0 : 1) + elicitation;
	const seen = {
		hooks: hooks.length, mcpServers: surface.mcpServers.data.length + listed.length, skills: skills.length, instructionSources: sources.length,
		features: surface.features.filter((feature) => feature.enabled).length,
	};
	const extra = {
		hooks: hooks.length - ours.length,
		mcpServers: surface.mcpServers.data.length + listed.filter((server) => !passed.has(server.name)).length,
		skills: skills.filter((skill) => skill.scope !== "system" || !builtin.includes(skill.name)).length,
		instructionSources: sources.length,
		features: wrongFeatures,
	};
	const loaded = Object.entries(extra).filter(([, count]) => count > 0);
	const hook = ours[0];
	const reasons = [
		...(resolve(surface.codexHome.reported) !== resolve(surface.codexHome.passed) ? ["the CLI runs on another Codex home than picp passed"] : []),
		...(surface.account ? [] : ["codex is not signed in (run `codex login`)"]),
		...(loaded.length > 0 ? [`it loaded a surface picp did not pass (${loaded.map(([key, count]) => `${key} ${count}`).join(", ")})`] : []),
		...(ours.length !== 1 ? [`picp's hook is listed ${ours.length} times`] : []),
		...(hook !== undefined && hook.trustStatus !== "trusted" ? [`picp's hook is not trusted (${hook.trustStatus})`] : []),
		...(hook !== undefined && (!hook.enabled || hook.isManaged || hook.source !== "sessionFlags" || hook.eventName !== "preToolUse") ? ["picp's hook is not an enabled session-flag preToolUse hook"] : []),
		...(hookErrors > 0 ? [`the hook listing has ${hookErrors} errors`] : []),
		...webSearchReasons(surface.config),
		...threadReasons(surface.thread, surface.profile),
	];
	if (reasons.length === 0) return { verdict: "ok", seen, extra };
	return { verdict: "refused", seen, extra, refusal: `Refused: the Codex CLI lockdown failed: ${reasons.join("; ")}. The run was stopped before any tool ran.` };
}

/** D4: hosted web search reads back `disabled`, set by picp's own session flag. */
function webSearchReasons(config: ConfigReadResponse): string[] {
	const value = config.config.web_search;
	const origin = config.origins.web_search?.name.type;
	return value === "disabled" && origin === "sessionFlags" ? [] : [`hosted web search reads back ${String(value)} from ${String(origin)}, not disabled from picp's flag`];
}

const sameRoots = (a: readonly string[], b: readonly string[]): boolean =>
	JSON.stringify(a.map((path) => resolve(path)).sort()) === JSON.stringify(b.map((path) => resolve(path)).sort());

function threadReasons(thread: CodexSurface["thread"], profile: CodexSurface["profile"]): string[] {
	if (thread === undefined) return [];
	const { response, cwd } = thread;
	const sandbox = response.sandbox;
	return [
		...(response.approvalPolicy !== "untrusted" ? [`the thread's approval policy is ${String(response.approvalPolicy)}, not untrusted`] : []),
		...(response.approvalsReviewer !== "user" ? ["the thread's approvals are not routed to picp"] : []),
		...(response.activePermissionProfile?.id !== profile.id || profile.id !== CODEX_PROFILE ? [`the thread's permission profile is not ${CODEX_PROFILE}`] : []),
		...(sandbox?.type !== "workspaceWrite" || sandbox.networkAccess !== false || sandbox.excludeSlashTmp !== true || !sameRoots(sandbox.writableRoots ?? [], profile.writableRoots)
			? ["the thread's sandbox is not picp's profile (its writable roots, network or tmp exclusion differ)"]
			: []),
		...(resolve(response.cwd) !== resolve(cwd) ? ["the thread runs outside the worktree"] : []),
	];
}
