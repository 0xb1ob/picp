/** Job report URLs, DOM-free so the server and the app share one rule for what a report may reference. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The image types a report may embed from its own artifact dir; SVG is excluded (it can carry script). */
export const REPORT_IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * A relative path inside the artifact dir as its segments, or null: no scheme, root, `..`, `.`, backslash or empty
 * segment.
 */
export function artifactSegments(path: string): string[] | null {
 const rel = path.replace(/^(?:\.\/)+/, "");
 if (!rel || /^[A-Za-z][A-Za-z0-9+.-]*:|^\/|\\|[?#\0]/.test(rel)) return null;
 const segments = rel.split("/");
 return segments.every(s => s && s !== "." && s !== "..") ? segments : null;
}

/** `/api/report/<id>/files/<path>` for a relative image in the job's artifact dir; null when the path is refused. */
export function reportImageUrl(id: string, src: string): string | null {
 const segments = JOB_ID.test(id) ? artifactSegments(src) : null;
 const ext = segments?.at(-1)?.split(".").pop()?.toLowerCase() ?? "";
 return segments && Object.hasOwn(REPORT_IMAGE_TYPES, ext) ? `/api/report/${id}/files/${segments.map(encodeURIComponent).join("/")}` : null;
}
