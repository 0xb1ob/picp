/**
 * `GET /api/diff?id=<job>` (full match S7): `git diff base...head` of the job's recorded full shas in its clone,
 * through explorer.ts `safePatch` (bounded runGit, `--no-ext-diff --no-textconv`, deny list). Historical evidence only:
 * only `id` is read, nothing is fetched, and a missing sha or object is unavailable with the forge Files link.
 */
import { parseChangeRequestUrl } from "../forge-url.ts";
import type { JobDiffResponse } from "./api-types.ts";
import { projectRoot, safePatch } from "./explorer.ts";
import { SHA } from "./git-read.ts";
import { jobDetail } from "./fleet-view.ts";
import type { ViewerState } from "./sessions.ts";

/** The browser renders every line, so the payload stays well under runGit's 1 MB default. */
export const DIFF_MAX_BYTES = 256_000;
const COMMAND = "git diff --no-ext-diff --no-textconv --no-color -M base...head";

/** The PR's own Files page, from a validated PR/MR url; null without one. */
function filesHref(pr: string | undefined): string | null {
	const ref = pr ? parseChangeRequestUrl(pr) : undefined;
	if (!ref) return null;
	return ref.kind === "github" ? `${ref.origin}/${ref.path}/pull/${ref.number}/files` : `${ref.origin}/${ref.path}/-/merge_requests/${ref.number}/diffs`;
}

/** 400 for any query key but one `id` (a path or revision never reaches git), 404 for an unknown or unsafe id. */
export async function jobDiff(state: ViewerState, query: URLSearchParams): Promise<{ status: number; body: JobDiffResponse | { error: string } }> {
	if ([...query.keys()].some((key) => key !== "id") || query.getAll("id").length > 1) return { status: 400, body: { error: "only id is read: a path or revision is never accepted" } };
	const job = jobDetail(state, query.get("id") ?? "");
	if (!job) return { status: 404, body: { error: "no such job" } };
	// The raw recorded values, not fleet-view's filtered ones, so a malformed sha reads as such below.
	const base = job.envelope?.base_sha ?? null, head = job.ci?.head_sha ?? job.envelope?.head_sha ?? null;
	const root = job.project ? projectRoot(state, job.project) : undefined, rootId = root ? `project:${job.project}` : null;
	const body: JobDiffResponse = {
		job_id: job.job_id, available: false, unavailable: null, base, head, branch: job.envelope?.branch ?? job.branch ?? null,
		provenance: { base: base ? "envelope" : null, head: head ? (head === job.ci?.head_sha ? "ci_watch" : "envelope") : null, root: rootId, command: COMMAND },
		root: rootId, truncated: false, text: "", files_href: filesHref(job.pr_url),
	};
	const unavailable = (why: string) => ({ status: 200, body: { ...body, unavailable: why } });
	if (!base || !head) return unavailable(!base && !head ? "no base or head sha recorded" : !base ? "no base sha recorded" : "no head sha recorded");
	// A ref name, short sha or dash-led string is never handed to git as a revision.
	if (!SHA.test(base) || !SHA.test(head)) return unavailable("recorded base/head is not a full sha");
	if (!root) return unavailable("no project clone to read");
	const out = await safePatch(root, "diff", `${base}...${head}`, { maxBytes: DIFF_MAX_BYTES });
	if (!out.ok) return unavailable(`git could not read the recorded shas: ${out.reason ?? "unknown"}`);
	return { status: 200, body: { ...body, available: true, truncated: out.truncated, text: out.stdout } };
}
