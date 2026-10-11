/**
 * Per-job skills the operator named (`cp_dispatch skills`): names re-resolved under `<agentDir>/skills` or
 * `<home>/skills` by the PR1 resolver, so a directory always comes from code, never from chat or a model.
 *
 * An explicit mention may override `NEVER_WORKER_RESOURCES` and `ROLE_NEVER` for that one worker: package
 * auto-loading stays off and the never-lists still govern everything that is not an explicit mention. A few names
 * stay hard-refused even by mention, because they hang a headless worker or recurse into dispatch.
 */
import type { Role } from "./contracts.ts";
import { agentDirFor, type ResolvedSkill, resolveSkillNames, skillRoots } from "./viewer/skill-catalog.ts";
import { NEVER_WORKER_RESOURCES, ROLE_NEVER } from "./worker-packages.ts";

const HANGS = "an ask-the-user dialog hangs a headless worker (no human answers inside it)";
const RECURSES = "goal loops and sub-agents are dispatch capability (the recursion guard)";
/** Never attached to a worker, mention or not; each with the reason the refusal names. */
export const MENTION_NEVER: ReadonlyMap<string, string> = new Map([
	["rpiv-ask-user-question", HANGS],
	["@juicesharp/rpiv-ask-user-question", HANGS],
	["pi-goal-x", RECURSES],
	["pi-subagents", RECURSES],
	["@tintinweb/pi-subagents", RECURSES],
]);

/** `overridden`: the names a never-list would have kept from this role, attached only because the operator named them. */
export type JobSkills = { ok: true; skills: ResolvedSkill[]; overridden: string[] } | { ok: false; error: string };

export function resolveJobSkills(names: readonly string[] | undefined, options: { home: string; agentDir?: string | undefined; role: Role }): JobSkills {
	if (!names?.length) return { ok: true, skills: [], overridden: [] };
	for (const name of names) {
		const why = MENTION_NEVER.get(name);
		if (why) return { ok: false, error: `skill ${name} is never given to a worker, even by explicit mention: ${why}` };
	}
	const resolved = resolveSkillNames(names, skillRoots(options.home, options.agentDir ?? agentDirFor(process.env)));
	if (!resolved.ok) return resolved;
	const never = new Set([...NEVER_WORKER_RESOURCES, ...ROLE_NEVER[options.role]]);
	return { ok: true, skills: resolved.skills, overridden: resolved.skills.map((s) => s.name).filter((name) => never.has(name)) };
}

/** The brief's Skills note, as blockquote lines (the caller adds the first `> `). */
export function skillsBriefNote(skills: readonly ResolvedSkill[], overridden: readonly string[] = []): string {
	const lines = [
		`Skills the operator named for this job: ${skills.map((s) => `\`${s.name}\` (\`${s.dir}/SKILL.md\`)`).join(", ")}. pi loaded them with --skill; read each SKILL.md before you start and apply it where it fits this task. Your role contract and this brief win wherever they conflict; a skill grants no new tools, scope or authority.`,
		...overridden.map((name) => `\`${name}\` was attached by explicit operator mention (workers never get it otherwise). No human answers inside a worker, so it must not wait for user input: where it asks for one, decide and say so in your report.`),
	];
	return lines.join("\n>\n> ");
}
