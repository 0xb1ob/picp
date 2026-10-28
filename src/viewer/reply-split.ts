/** Read-time split of an operator reply into `[project]` sections (issue 589); pure, no I/O. */

export interface ReplySegment {
	/** The section's text, its header removed and surrounding blank lines trimmed. */
	text: string;
	/** Empty for `general` (no chip). */
	projects: string[];
	source: "header" | "id" | "reply" | "general";
}

export interface SplitContext {
	/** Known project names; only these make a header or an id chip. */
	projects: ReadonlySet<string>;
	/** The project an id (`cp-…`, `ask-…`, `es-…`) or a PR/MR URL belongs to, when known. */
	projectOf: (ref: string) => string | undefined;
	/** The project of the human message this reply answers. */
	fallback?: string;
}

const HEADER = /^\[([^\]\n]+)\](?: |$)/gm;
const REFS = /\bcp-[a-z0-9][a-z0-9-]*\b|\bask-[a-f0-9]{12}\b|\bes-[a-f0-9]{6}\b|https?:\/\/\S+?\/(?:pull|-\/merge_requests)\/\d+/g;

/** A header's projects when every bracketed name is known, else undefined (the line stays text). */
function headerProjects(inner: string, known: ReadonlySet<string>): string[] | undefined {
	const names = inner.split(/,\s*/);
	return names.length > 0 && names.every((name) => known.has(name)) ? [...new Set(names)] : undefined;
}

/** The one known project the ids in `text` resolve to; several or none is undefined. */
export function projectByRefs(text: string, ctx: Pick<SplitContext, "projects" | "projectOf">): string | undefined {
	const found = new Set([...text.matchAll(REFS)].map((m) => ctx.projectOf(m[0])).filter((p): p is string => !!p && ctx.projects.has(p)));
	return found.size === 1 ? [...found][0] : undefined;
}

/**
 * One segment per `[project]` section; text before the first header is `general`. A reply with no header is one
 * section: the project its ids resolve to, else `ctx.fallback`, else `general`.
 */
export function splitReply(text: string, ctx: SplitContext): ReplySegment[] {
	const heads = [...text.matchAll(HEADER)].flatMap((m) => {
		const projects = headerProjects(m[1]!, ctx.projects);
		return projects ? [{ at: m.index, body: m.index + m[0].length, projects }] : [];
	});
	if (heads.length === 0) {
		const byRef = projectByRefs(text, ctx), project = byRef ?? (ctx.fallback && ctx.projects.has(ctx.fallback) ? ctx.fallback : undefined);
		return [{ text, projects: project ? [project] : [], source: byRef ? "id" : project ? "reply" : "general" }];
	}
	const segments: ReplySegment[] = [];
	const preamble = text.slice(0, heads[0]!.at).trim();
	if (preamble) segments.push({ text: preamble, projects: [], source: "general" });
	heads.forEach((head, i) => {
		const body = text.slice(head.body, heads[i + 1]?.at ?? text.length).trim();
		if (body) segments.push({ text: body, projects: head.projects, source: "header" });
	});
	return segments;
}
