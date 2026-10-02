/**
 * Worker profiles and brief assembly.
 *
 * A profile is a named role bundle (pi-dynamic-workflows' `agentType`):
 * markdown with YAML-ish frontmatter that fixes tools, model, thinking and the
 * brief template, plus a body that becomes the worker's appended system
 * prompt.
 *
 * Brief assembly is PURE: templates in, string out, no fs writes and no model
 * calls. Dispatch (T14) is the only thing allowed to send the result.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	BRIEF_PLACEHOLDERS,
	type ProfileFrontmatter,
	type Role,
	type WorkerProfile,
	validateProfile,
} from "./contracts.ts";

export class ProfileError extends Error {}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface ParsedDocument {
	frontmatter: Record<string, unknown>;
	body: string;
}

/**
 * Minimal, deliberately boring frontmatter parser: scalars, inline arrays
 * (`[a, b]`), inline maps (`{ tokens: 1 }`) and booleans/numbers. No anchors,
 * no multi-line strings, no YAML surprises. A profile is configuration, not a
 * programming language.
 */
export function parseFrontmatter(text: string, source = "<inline>"): ParsedDocument {
	const match = FRONTMATTER_RE.exec(text.replace(/\r\n/g, "\n"));
	if (!match) {
		throw new ProfileError(`${source}: missing --- frontmatter block`);
	}
	const frontmatter: Record<string, unknown> = {};
	const lines = (match[1] ?? "").split("\n");
	for (const raw of lines) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const separator = line.indexOf(":");
		if (separator === -1) {
			throw new ProfileError(`${source}: cannot parse frontmatter line ${JSON.stringify(raw)}`);
		}
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		frontmatter[key] = parseScalar(value, source);
	}
	return { frontmatter, body: text.slice(match[0].length).trim() };
}

function parseScalar(value: string, source: string): unknown {
	if (value === "") return "";
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (inner.length === 0) return [];
		return inner.split(",").map((item) => parseScalar(item.trim(), source));
	}
	if (value.startsWith("{") && value.endsWith("}")) {
		const inner = value.slice(1, -1).trim();
		const map: Record<string, unknown> = {};
		if (inner.length === 0) return map;
		for (const entry of inner.split(",")) {
			const separator = entry.indexOf(":");
			if (separator === -1) throw new ProfileError(`${source}: cannot parse inline map entry ${JSON.stringify(entry)}`);
			map[entry.slice(0, separator).trim()] = parseScalar(entry.slice(separator + 1).trim(), source);
		}
		return map;
	}
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

/** Parse + validate a profile document. Invalid profiles never load. */
export function parseProfile(text: string, path: string): WorkerProfile {
	const { frontmatter, body } = parseFrontmatter(text, path);
	const result = validateProfile(frontmatter);
	if (!result.ok) {
		throw new ProfileError(`${path}: invalid profile frontmatter\n  ${result.errors.join("\n  ")}`);
	}
	if (body.length === 0) {
		throw new ProfileError(`${path}: profile body is empty — the body is the worker's system prompt`);
	}
	const expected = basename(path).replace(/\.md$/, "");
	if (result.value.name !== expected) {
		throw new ProfileError(`${path}: profile name "${result.value.name}" must match the file name "${expected}"`);
	}
	return { frontmatter: result.value as ProfileFrontmatter, systemPrompt: body, path };
}

export function loadProfile(profilesDir: string, name: string): WorkerProfile {
	const path = join(profilesDir, `${name}.md`);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// Name the files, not the parsed profiles: a broken sibling profile must
		// not turn "unknown profile" into a different error.
		const available = profileNames(profilesDir).join(", ");
		throw new ProfileError(`unknown profile "${name}" (available: ${available || "none"})`);
	}
	return parseProfile(text, path);
}

/** Profile file names present in a directory (no parsing, no validation). */
export function profileNames(profilesDir: string): string[] {
	try {
		return readdirSync(profilesDir)
			.filter((entry) => entry.endsWith(".md"))
			.map((entry) => entry.replace(/\.md$/, ""))
			.sort();
	} catch {
		return [];
	}
}

export function listProfiles(profilesDir: string): WorkerProfile[] {
	let entries: string[];
	try {
		entries = readdirSync(profilesDir);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".md"))
		.sort()
		.map((entry) => parseProfile(readFileSync(join(profilesDir, entry), "utf8"), join(profilesDir, entry)));
}

/**
 * The profile for a role, with one deliberate tiebreak (cp-u3o4).
 *
 * `ROLES` is fixed at three by contract, so a fourth kind of worker reuses an
 * existing role: `profiles/qa.md` is `role: planner` (which is also what keeps
 * `validateProfile`'s "planner profiles are read-only" rule and the
 * planner-only `ask_operator` grant working for it). Without a tiebreak its
 * mere presence would make *every* default research dispatch ambiguous.
 *
 * So when several profiles share a role, the one whose `name` **is** the role
 * wins — `planner.md` is the profile for role planner, and `qa.md` is asked
 * for by name. Ambiguity that this does not resolve still throws: two
 * same-role profiles neither of which is named after it is a configuration
 * mistake, not a default.
 */
export function profileForRole(profilesDir: string, role: Role): WorkerProfile {
	const matches = listProfiles(profilesDir).filter((profile) => profile.frontmatter.role === role);
	const profile = matches[0];
	if (!profile) throw new ProfileError(`no profile for role "${role}" in ${profilesDir}`);
	if (matches.length > 1) {
		const named = matches.filter((match) => match.frontmatter.name === role);
		if (named.length === 1) return named[0] as WorkerProfile;
		throw new ProfileError(
			`ambiguous role "${role}": ${matches.map((match) => match.frontmatter.name).join(", ")} — one profile per role, or exactly one named "${role}"`,
		);
	}
	return profile;
}

// ---------------------------------------------------------------------------
// Brief assembly (pure)
// ---------------------------------------------------------------------------

export type BriefValues = Partial<Record<(typeof BRIEF_PLACEHOLDERS)[number], string>>;

const PLACEHOLDER_RE = /\$\{([a-z_]+)\}/g;

/** Placeholders a template actually uses, in first-appearance order. */
export function templatePlaceholders(template: string): string[] {
	const seen: string[] = [];
	for (const match of template.matchAll(PLACEHOLDER_RE)) {
		const name = match[1] as string;
		if (!seen.includes(name)) seen.push(name);
	}
	return seen;
}

/**
 * Substitute `${placeholder}` tokens. Fail closed on both sides:
 *  - an unknown placeholder in the template is an error (typo protection)
 *  - a missing value is an error (a brief never renders an empty hole)
 */
export function renderTemplate(template: string, values: BriefValues, source = "<template>"): string {
	const used = templatePlaceholders(template);
	const unknown = used.filter((name) => !(BRIEF_PLACEHOLDERS as readonly string[]).includes(name));
	if (unknown.length > 0) {
		throw new ProfileError(
			`${source}: unknown placeholder(s) ${unknown.map((name) => `\${${name}}`).join(", ")}; allowed: ${BRIEF_PLACEHOLDERS.join(", ")}`,
		);
	}
	const missing = used.filter((name) => {
		const value = values[name as keyof BriefValues];
		return value === undefined || value.length === 0;
	});
	if (missing.length > 0) {
		throw new ProfileError(`${source}: missing value(s) for ${missing.map((name) => `\${${name}}`).join(", ")}`);
	}
	return template.replace(PLACEHOLDER_RE, (_match, name: string) => values[name as keyof BriefValues] as string);
}

export interface BriefRequest {
	profile: WorkerProfile;
	/** Raw template text (read by the caller from prompts/briefs/<name>.md). */
	template: string;
	values: BriefValues;
	templatePath?: string;
}

/**
 * The first brief. It is the whole instruction set: the worker gets no skills
 * and no ambient context beyond the repo's own files.
 */
export function assembleBrief(request: BriefRequest): string {
	const { profile, template, values } = request;
	const rendered = renderTemplate(template, values, request.templatePath ?? profile.frontmatter.briefTemplate);
	return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

/** Read a brief template by name from a briefs directory. */
export function readBriefTemplate(briefsDir: string, name: string): string {
	const path = join(briefsDir, `${name}.md`);
	try {
		return readFileSync(path, "utf8");
	} catch {
		throw new ProfileError(`unknown brief template "${name}" (looked for ${path})`);
	}
}
