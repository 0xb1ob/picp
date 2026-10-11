/**
 * Pure `@skill` mention helpers shared by the viewer server and the browser bundle, so this module imports nothing.
 * A skill name is pi's (lowercase letters, digits and single hyphens, at most 64 characters), so it can never hold
 * `/` or `.`. A resolved mention travels as one code-written `[cp-skill <name> <absolute dir>]` line.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_MENTION_MAX = 8;

// `@name` at a word start: `a@b.com` is not a mention, `(@x)` and `@x.` are; `@xY` and `@x_y` are not.
const MENTION = /(?<![\w.+@/-])@([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g;
const LINE = /^\[cp-skill ([a-z0-9]+(?:-[a-z0-9]+)*) (\/[^\]\n]*)\]$/;

/** Distinct `@name` tokens in order of appearance, each a well-formed name of at most 64 characters. */
export function mentionNames(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const name = match[1] ?? "";
		if (name.length <= SKILL_NAME_MAX && !names.includes(name)) names.push(name);
	}
	return names;
}

export function skillLine(name: string, dir: string): string {
	return `[cp-skill ${name} ${dir}]`;
}

/** Removes every whole `[cp-skill <name> </abs dir>]` line and, when one was removed, the trailing blank-line gap. */
export function parseSkillLines(text: string): { body: string; names: string[] } {
	const names: string[] = [];
	const kept = text.split("\n").filter((line) => {
		const name = LINE.exec(line)?.[1];
		if (name !== undefined && !names.includes(name)) names.push(name);
		return name === undefined;
	});
	return { body: names.length ? kept.join("\n").replace(/\s+$/, "") : text, names };
}

export function stripSkillLines(text: string): string {
	return parseSkillLines(text).body;
}
