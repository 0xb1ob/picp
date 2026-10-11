import type { SkillsResponse } from "../src/viewer/api-types.ts";
import { mentionNames, SKILL_MENTION_MAX } from "../src/viewer/skill-mentions.ts";
import { failure } from "./control.ts";

/** Composer `@skill` autocomplete: the installed skill catalogue (names and descriptions only) and the pure helpers over it. */
export const SKILLS_URL = "/api/skills";
export type SkillCatalog = SkillsResponse | {error: string};
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchSkills(fetch: Fetch): Promise<SkillCatalog> {
 try {
  const response = await fetch(SKILLS_URL);
  return response.ok ? await response.json() as SkillsResponse : {error: await failure(response)};
 } catch {
  return {error: "Could not reach this home"};
 }
}

/** The `@query` the caret sits right after, at a word start (`a@b` is none); `start` is the `@`'s index. */
export function mentionAt(text: string, caret: number): {start: number; query: string} | null {
 const match = /(^|\s)@([a-z0-9-]{0,64})$/.exec(text.slice(0, caret));
 if (!match) return null;
 const query = match[2] ?? "";
 return {start: caret - query.length - 1, query};
}

/** Up to `max` skills whose name starts with `query`, then those that only contain it, each in catalogue order. */
export function matchSkills<T extends {name: string}>(skills: readonly T[], query: string, max = SKILL_MENTION_MAX): T[] {
 const prefix = skills.filter(s => s.name.startsWith(query));
 return [...prefix, ...skills.filter(s => !s.name.startsWith(query) && s.name.includes(query))].slice(0, max);
}

/** The text's `@name` tokens split into installed skills and plain text (the server derives the same tokens on send). */
export function composerMentions(text: string, skills: readonly {name: string}[]): {known: string[]; unknown: string[]} {
 const names = mentionNames(text);
 const installed = new Set(skills.map(s => s.name));
 return {known: names.filter(n => installed.has(n)), unknown: names.filter(n => !installed.has(n))};
}
