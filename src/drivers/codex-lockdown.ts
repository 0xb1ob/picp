/**
 * The Codex surface lockdown: before any thread the CLI must list only picp's trusted hook, no MCP server and only
 * its pinned built-in skills; after `thread/start` the read-back must hold. Any miss refuses the run. Counts only.
 */
import { resolve } from "node:path";
import type { HooksListResponse, ListMcpServerStatusResponse, SkillsListResponse, ThreadStartResponse } from "./codex-protocol.ts";

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
	/** Present once `thread/start` (or `thread/resume`) answered. */
	thread?: { response: ThreadStartResponse; cwd: string };
}

export interface CodexSurfaceCounts { hooks: number; mcpServers: number; skills: number; instructionSources: number }

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
	const seen = { hooks: hooks.length, mcpServers: surface.mcpServers.data.length, skills: skills.length, instructionSources: sources.length };
	const extra = {
		hooks: hooks.length - ours.length,
		mcpServers: surface.mcpServers.data.length,
		skills: skills.filter((skill) => skill.scope !== "system" || !builtin.includes(skill.name)).length,
		instructionSources: sources.length,
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
		...threadReasons(surface.thread),
	];
	if (reasons.length === 0) return { verdict: "ok", seen, extra };
	return { verdict: "refused", seen, extra, refusal: `Refused: the Codex CLI lockdown failed: ${reasons.join("; ")}. The run was stopped before any tool ran.` };
}

function threadReasons(thread: CodexSurface["thread"]): string[] {
	if (thread === undefined) return [];
	const { response, cwd } = thread;
	return [
		...(response.approvalPolicy !== "untrusted" ? [`the thread's approval policy is ${String(response.approvalPolicy)}, not untrusted`] : []),
		...(response.sandbox?.type !== "readOnly" ? ["the thread's sandbox is not read-only"] : []),
		...(resolve(response.cwd) !== resolve(cwd) ? ["the thread runs outside the worktree"] : []),
	];
}
