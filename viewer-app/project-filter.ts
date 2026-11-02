/** One project selection in a screen's hash: `project=<name>` (as Stats) or `untagged=1`; absent is All. */
export type ProjectSelection = {project: string} | {untagged: true} | null;
/** The Untagged option's select value: a slash can never be a `projects/*` directory name. */
export const UNTAGGED = "/untagged";
const KEYS = ["project","untagged"];

export function readSelection(query: string | undefined): ProjectSelection {
 const q = new URLSearchParams(query ?? ""), project = q.get("project");
 return project ? {project} : q.get("untagged") === "1" ? {untagged:true} : null;
}
/** The select's value for a selection: "" is All. */
export const selectionValue = (s: ProjectSelection): string => !s ? "" : "project" in s ? s.project : UNTAGGED;
/** `hash` with only its selection replaced; every other parameter (P1 `ref`/`draft`, `session`, `view`) is kept. */
export function selectionHash(hash: string, value: string): string {
 const [path = "", query = ""] = hash.replace(/^#/,"").split("?");
 const q = new URLSearchParams(query);
 for (const key of KEYS) q.delete(key);
 if (value === UNTAGGED) q.set("untagged","1"); else if (value) q.set("project",value);
 const rest = q.toString();
 return `#${path}${rest ? `?${rest}` : ""}`;
}
/** A route query without its selection: the API never sees it, and a change never remounts the screen. */
export function withoutSelection(query: string | undefined): string {
 const q = new URLSearchParams(query ?? "");
 for (const key of KEYS) q.delete(key);
 return q.toString();
}
/** Exact any-project match: Untagged is no project at all; All matches everything. */
export const matchesSelection = (projects: readonly string[] | undefined, s: ProjectSelection): boolean =>
 !s || ("project" in s ? !!projects?.includes(s.project) : !projects?.length);
