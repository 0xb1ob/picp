/**
 * Installed pi skills, by name: the entries directly under `<agentDir>/skills` and `<home>/skills` whose `SKILL.md`
 * carries a readable frontmatter. Names are checked first (no traversal is expressible), then each entry and its
 * SKILL.md are resolved by realpath and must stay inside realpath(agentDir) or realpath(home); anything unusual fails
 * closed with a named reason. Read-only. `GET /api/skills` returns names and descriptions, never a body or a path.
 */
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { type AccessContext, canRead, LOCAL_ACCESS } from "./access.ts";
import type { SkillsResponse } from "./api-types.ts";
import { mentionNames, parseSkillLines, SKILL_MENTION_MAX, SKILL_NAME_MAX, SKILL_NAME_RE, skillLine, stripSkillLines } from "./skill-mentions.ts";

export type SkillSource = "agent" | "home";
/** `dir` is the skills root; `base` is what every entry and SKILL.md must stay inside after realpath. */
export interface SkillRoot { source: SkillSource; dir: string; base: string }
export type SkillResolution = { state: "ok"; name: string; dir: string; description: string; source: SkillSource } | { state: "absent" } | { state: "invalid"; reason: string };
export interface ResolvedSkill { name: string; dir: string }

const FRONTMATTER_MAX_BYTES = 8 * 1024;
const DESCRIPTION_MAX = 200;
const NAME_RULE = `must match ${SKILL_NAME_RE.source} and be at most ${SKILL_NAME_MAX} characters`;

/** pi's `getAgentDir()`: `PI_CODING_AGENT_DIR` with `~` expanded (made absolute here), else `~/.pi/agent`. */
export function agentDirFor(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
	const value = env.PI_CODING_AGENT_DIR;
	if (!value) return join(homeDir, ".pi", "agent");
	if (value === "~") return homeDir;
	return value.startsWith("~/") ? join(homeDir, value.slice(2)) : resolve(value);
}

export function skillRoots(home: string, agentDir: string): SkillRoot[] {
	return [{ source: "agent", dir: join(agentDir, "skills"), base: agentDir }, { source: "home", dir: join(home, "skills"), base: home }];
}

const code = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? "error";
const inside = (base: string, path: string): boolean => {
	const rel = relative(base, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** One frontmatter scalar: plain, '…', "…", or a `|`/`>` block (optional -/+ chomping) on more-indented lines. */
function scalar(first: string, more: string[]): string | null {
	const value = first.trim();
	const block = /^([|>])[+-]?$/.exec(value);
	if (block) {
		const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
		const lines = more.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
		return block[1] === "|" ? lines.join("\n") : lines.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
	}
	if (more.some((l) => l.trim())) return value.startsWith("'") || value.startsWith('"') ? null : [value, ...more.map((l) => l.trim())].filter(Boolean).join(" ");
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return null;
		}
	}
	if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : null;
	const plain = value.replace(/\s+#.*$/, "");
	return /^[[{&*!%@`|>]/.test(plain) || /:\s/.test(plain) || plain.endsWith(":") ? null : plain;
}

/** `name` (optional) and `description` from the first 8 KiB of a SKILL.md; any other key is ignored. */
export function readSkillFrontmatter(file: string): { name?: string; description: string } | { error: string } {
	let text: string;
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
			text = buffer.subarray(0, readSync(fd, buffer, 0, FRONTMATTER_MAX_BYTES, 0)).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return { error: `SKILL.md unreadable (${code(error)})` };
	}
	const lines = text.split(/\r?\n/);
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (lines[0]?.trimEnd() !== "---" || end < 0) return { error: "frontmatter unreadable" };
	const fields = new Map<string, string | null>();
	for (let i = 1; i < end; i++) {
		const line = lines[i] ?? "";
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const key = /^([A-Za-z0-9_-]+):(?:\s(.*))?$/.exec(line);
		if (!key) return { error: "frontmatter unreadable" };
		let j = i + 1;
		while (j < end && (!(lines[j] ?? "").trim() || /^\s/.test(lines[j] ?? ""))) j++;
		const name = key[1] ?? "";
		if (fields.has(name)) return { error: "frontmatter unreadable" };
		fields.set(name, name === "name" || name === "description" ? scalar(key[2] ?? "", lines.slice(i + 1, j)) : "");
		i = j - 1;
	}
	const name = fields.get("name");
	const description = fields.get("description");
	if (name === null || description === null) return { error: "frontmatter unreadable" };
	if (!description?.trim()) return { error: "frontmatter has no description" };
	return { ...(name === undefined ? {} : { name: name.trim() }), description: description.trim() };
}

function resolveIn(name: string, root: SkillRoot): SkillResolution {
	const entry = join(root.dir, name);
	try {
		lstatSync(entry);
	} catch (error) {
		return code(error) === "ENOENT" || code(error) === "ENOTDIR" ? { state: "absent" } : { state: "invalid", reason: `entry unreadable (${code(error)})` };
	}
	const where = `${root.source} skills`;
	try {
		const base = realpathSync(root.base);
		const dir = realpathSync(entry);
		if (!inside(base, dir)) return { state: "invalid", reason: `resolves outside the ${where} base` };
		if (!statSync(dir).isDirectory()) return { state: "invalid", reason: "not a directory" };
		if (/[\]\n\r\0]/.test(dir)) return { state: "invalid", reason: "its directory path cannot be carried in a skill line" };
		const file = realpathSync(join(dir, "SKILL.md"));
		if (!inside(base, file)) return { state: "invalid", reason: `SKILL.md resolves outside the ${where} base` };
		if (!statSync(file).isFile()) return { state: "invalid", reason: "SKILL.md is not a regular file" };
		const front = readSkillFrontmatter(file);
		if ("error" in front) return { state: "invalid", reason: front.error };
		if (front.name !== undefined && front.name !== name) return { state: "invalid", reason: "frontmatter name differs from the directory name" };
		return { state: "ok", name, dir, description: front.description, source: root.source };
	} catch (error) {
		return { state: "invalid", reason: code(error) === "ENOENT" ? "no SKILL.md (or a dangling link)" : `unreadable (${code(error)})` };
	}
}

/** One name against both roots: absent from both, invalid (with a reason), ambiguous when present under both, or ok. */
export function resolveSkill(name: string, roots: readonly SkillRoot[]): SkillResolution {
	if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) return { state: "invalid", reason: `skill name ${NAME_RULE}` };
	const found = roots.map((root) => resolveIn(name, root)).filter((r) => r.state !== "absent");
	if (found.length > 1) return { state: "invalid", reason: `present under both the agent and home skills roots (ambiguous)` };
	return found[0] ?? { state: "absent" };
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export interface SkillList {
	skills: { name: string; description: string; source: SkillSource }[];
	skipped: { name: string; reason: string }[];
	/** Entries past the caps, not listed. */
	omitted: number;
}

/** Every entry under both roots, sorted by name; dot-entries are not skills and are passed over. */
export function listSkills(roots: readonly SkillRoot[], { max = 200, skippedMax = 50 } = {}): SkillList {
	const out: SkillList = { skills: [], skipped: [], omitted: 0 };
	const names = new Set<string>();
	for (const root of roots) {
		try {
			for (const name of readdirSync(root.dir)) if (!name.startsWith(".")) names.add(name);
		} catch (error) {
			if (code(error) !== "ENOENT") out.skipped.push({ name: `(${root.source} root)`, reason: `skills root unreadable (${code(error)})` });
		}
	}
	for (const name of [...names].sort()) {
		const found = resolveSkill(name, roots);
		if (found.state === "ok" && out.skills.length < max) out.skills.push({ name, description: oneLine(found.description, DESCRIPTION_MAX), source: found.source });
		else if (found.state === "invalid" && out.skipped.length < skippedMax) out.skipped.push({ name: oneLine(name, SKILL_NAME_MAX + 16), reason: found.reason });
		else if (found.state !== "absent") out.omitted++;
	}
	return out;
}

/** Strict: every name must resolve, none twice, at most 8, none on `never`. */
export function resolveSkillNames(names: readonly string[], roots: readonly SkillRoot[], never: readonly string[] = []): { ok: true; skills: ResolvedSkill[] } | { ok: false; error: string } {
	if (names.length > SKILL_MENTION_MAX) return { ok: false, error: `at most ${SKILL_MENTION_MAX} skills (got ${names.length})` };
	const skills: ResolvedSkill[] = [];
	for (const name of names) {
		if (skills.some((s) => s.name === name)) return { ok: false, error: `skill ${name} is named twice` };
		if (never.includes(name)) return { ok: false, error: `skill ${name} is never given to workers` };
		const found = resolveSkill(name, roots);
		if (found.state === "absent") return { ok: false, error: `skill ${name} is not installed (agent or home skills)` };
		if (found.state === "invalid") return { ok: false, error: `skill ${name}: ${found.reason}` };
		skills.push({ name, dir: found.dir });
	}
	return { ok: true, skills };
}

const withLines = (body: string, skills: readonly ResolvedSkill[]): string => (skills.length ? `${body}\n\n${skills.map((s) => skillLine(s.name, s.dir)).join("\n")}` : body);

/** The viewer's derivation: typed skill lines removed, each `@name` that is installed appended as a code-written line. */
export function withSkillLines(text: string, roots: readonly SkillRoot[]): { ok: true; text: string; names: string[] } | { ok: false; reason: string } {
	const body = stripSkillLines(text);
	const skills: ResolvedSkill[] = [];
	for (const name of mentionNames(body)) {
		const found = resolveSkill(name, roots);
		if (found.state === "invalid") return { ok: false, reason: `@${name}: ${found.reason}` };
		if (found.state === "ok") skills.push({ name, dir: found.dir });
	}
	if (skills.length > SKILL_MENTION_MAX) return { ok: false, reason: `at most ${SKILL_MENTION_MAX} skill mentions per message (got ${skills.length})` };
	return { ok: true, text: withLines(body, skills), names: skills.map((s) => s.name) };
}

/** The `cp_parent send` relay: names from the param plus names on copied lines, re-resolved strictly; fresh lines only. */
export function relaySkillLines(text: string, names: readonly string[], roots: readonly SkillRoot[]): { ok: true; text: string } | { ok: false; error: string } {
	const parsed = parseSkillLines(text);
	const resolved = resolveSkillNames([...new Set([...names, ...parsed.names])], roots);
	return resolved.ok ? { ok: true, text: withLines(parsed.body, resolved.skills) } : resolved;
}

export const SKILLS_PATH = "/api/skills";

/** `GET /api/skills`: served only under `--require-tailnet`; names, descriptions and sources, never a body or a path. */
export function handleSkillsList(options: { home: string; requireTailnet?: boolean; agentDir?: string }, now = new Date(), access: AccessContext = LOCAL_ACCESS): { status: number; body: SkillsResponse | { error: string } } {
	if (!canRead(access, options.requireTailnet === true)) return { status: 403, body: { error: "the skills list is served only under --require-tailnet" } };
	return { status: 200, body: { generated_at: now.toISOString(), ...listSkills(skillRoots(options.home, options.agentDir ?? agentDirFor(process.env))) } };
}
