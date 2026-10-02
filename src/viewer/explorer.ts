/**
 * Where the workbench may read files and run git (cp-s560 W2c/W2d): a live worktree under the treehouse
 * pool, or a `projects/<name>` clone. Both are realpath-confined; anything else is undefined (fail closed).
 * A root is named by id (`project:<name>`, `worktree:<job>`), never by path. Inside a root, `.git`, `.env*`,
 * any `secrets` segment and key-like files (`*.pem`, `*.key`, `id_rsa*`, `*.p12`, `auth.json`) are never
 * listed or served, checked on the request path and again on its realpath.
 */

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { runGit, SHA, type GitResult } from "./git-read.ts";
import { fleetJobs, isSafeId, type Json, str, type ViewerState } from "./sessions.ts";

/** `CP_TREEHOUSE_ROOT` → `TREEHOUSE_ROOT` (absolute only) → `~/.treehouse`, as `src/leases.ts` resolves it. */
export function poolRoot(env: NodeJS.ProcessEnv = process.env): string {
	for (const value of [env.CP_TREEHOUSE_ROOT, env.TREEHOUSE_ROOT]) if (value && isAbsolute(value)) return value;
	return join(homedir(), ".treehouse");
}

const real = (path: string): string | undefined => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};

/** The job's worktree while it is `waiting`/`held` and really inside the pool root. */
export function worktreeRoot(job: Json, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const worktree = str(job.worktree);
	if (!worktree || (job.phase !== "waiting" && job.phase !== "held")) return undefined;
	const path = real(worktree);
	const pool = real(poolRoot(env));
	return path && pool && path.startsWith(`${pool}${sep}`) ? path : undefined;
}

/** `projects/<name>` when it is a real directory (not a symlink) directly under the projects dir. */
export function projectRoot(state: ViewerState, name: string): string | undefined {
	if (!isSafeId(name)) return undefined;
	const projects = join(dirname(state.stateDir), "projects");
	const path = join(projects, name);
	try {
		if (!lstatSync(path).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const base = real(projects);
	return base && real(path) === join(base, name) ? join(base, name) : undefined;
}

/** Where a job's diff runs: its live worktree, else its project clone. The id names it, never the path. */
export function jobRoot(state: ViewerState, jobId: string): { id: string; path: string } | undefined {
	const job = fleetJobs(state).find((candidate) => candidate.job_id === jobId);
	if (!job || !isSafeId(jobId)) return undefined;
	const worktree = worktreeRoot(job);
	if (worktree) return { id: `worktree:${jobId}`, path: worktree };
	const project = str(job.project);
	const clone = project ? projectRoot(state, project) : undefined;
	return clone ? { id: `project:${project}`, path: clone } : undefined;
}

export interface Root {
	id: string;
	kind: "project" | "worktree";
	label: string;
	project: string;
	job_id?: string;
}

const projectsDir = (state: ViewerState): string => join(dirname(state.stateDir), "projects");

/** Every explorer root: each `projects/*` clone, then each live worktree the fleet records. */
export function roots(state: ViewerState, env: NodeJS.ProcessEnv = process.env): Root[] {
	const out: Root[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(projectsDir(state)).sort();
	} catch {
		names = [];
	}
	for (const name of names) if (projectRoot(state, name)) out.push({ id: `project:${name}`, kind: "project", label: name, project: name });
	for (const job of fleetJobs(state)) {
		const id = str(job.job_id);
		if (!id || !isSafeId(id) || !worktreeRoot(job, env)) continue;
		const project = str(job.project) ?? "";
		out.push({ id: `worktree:${id}`, kind: "worktree", label: `${id} (${project})`, project, job_id: id });
	}
	return out;
}

/** A root id → its real path, or undefined for anything `roots()` would not list. */
export function resolveRootId(state: ViewerState, id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const at = id.indexOf(":");
	const kind = id.slice(0, at);
	const name = at < 0 ? "" : id.slice(at + 1);
	if (kind === "project") return projectRoot(state, name);
	if (kind !== "worktree" || !isSafeId(name)) return undefined;
	const job = fleetJobs(state).find((candidate) => candidate.job_id === name);
	return job ? worktreeRoot(job, env) : undefined;
}

/**
 * The one deny list (mirrors the mandate `exclude_paths` and key-like files): a path segment matching any
 * of these globs, case-insensitively, is never listed or served, as a file or in a patch.
 */
const DENY_GLOBS = [".git", ".env*", "secrets", "*.pem", "*.key", "*.p12", "id_rsa*", "auth.json"] as const;
const DENY_RES = DENY_GLOBS.map((glob) => new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`, "i"));

export function denied(name: string): boolean {
	return DENY_RES.some((re) => re.test(name));
}

/** The same list as git pathspecs (after `--`), supplemented with both sides of denied renames. */
const DENY_PATHSPEC: readonly string[] = [".", ...DENY_GLOBS.flatMap((glob) => [`:(exclude,glob,icase)**/${glob}`, `:(exclude,glob,icase)**/${glob}/**`])];
const deniedPath = (path: string): boolean => path.split("/").some(denied);
const incompletePaths = (): GitResult => ({ ok: false, stdout: "", truncated: false, reason: "incomplete git path list" });

/** Inspect unfiltered, NUL-delimited names first: pathspec filtering before -M loses rename provenance. */
export async function safePatch(root: string, view: "diff" | "show", revision: string): Promise<GitResult> {
	const args = [view, "--no-ext-diff", "--no-textconv", "--no-color", "-M", ...(view === "show" ? ["--diff-merges=first-parent"] : []), revision];
	const names = await runGit(root, [...args, "--format=", "--name-status", "-z"]);
	if (!names.ok) return names;
	if (names.truncated || (names.stdout && !names.stdout.endsWith("\0"))) return incompletePaths();
	const fields = names.stdout.split("\0");
	fields.pop();
	const excluded = new Set<string>();
	for (let i = 0; i < fields.length;) {
		const status = fields[i++]!;
		if (!/^(?:[ADMTUXB]|[RCM]\d+)$/.test(status)) return incompletePaths();
		const count = /^[RC]/.test(status) ? 2 : 1;
		const paths = fields.slice(i, i + count);
		i += count;
		if (paths.length !== count || paths.some((path) => !path)) return incompletePaths();
		if (paths.some(deniedPath)) for (const path of paths) excluded.add(path);
	}
	return runGit(root, [...args, ...(view === "show" ? ["--stat", "--patch", "--format=fuller"] : []), "--", ...DENY_PATHSPEC, ...[...excluded].map((path) => `:(top,exclude,literal)${path}`)]);
}

/** Porcelain -z keeps both rename paths intact, including tabs/newlines in names. */
function safeStatus(out: GitResult): GitResult {
	if (!out.ok) return out;
	if (out.truncated || (out.stdout && !out.stdout.endsWith("\0"))) return incompletePaths();
	const records = out.stdout.split("\0");
	records.pop();
	const lines: string[] = [];
	const quote = (path: string): string => /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.startsWith("## ")) { lines.push(record); continue; }
		if (record.length < 4 || record[2] !== " ") return incompletePaths();
		const path = record.slice(3);
		const from = /[RC]/.test(record.slice(0, 2)) ? records[++i] : undefined;
		if (/[RC]/.test(record.slice(0, 2)) && !from) return incompletePaths();
		if (deniedPath(path) || (from !== undefined && deniedPath(from))) continue;
		lines.push(`${record.slice(0, 3)}${from !== undefined ? `${quote(from)} -> ` : ""}${quote(path)}`);
	}
	return { ...out, stdout: lines.join("\n") };
}

/** `rel` inside `realRoot`, or undefined: empty/dot segments, `\`, NUL, denied names, or a realpath out. */
export function resolveInRoot(realRoot: string, rel: string): string | undefined {
	const segs = rel === "" ? [] : rel.split("/");
	if (segs.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0") || denied(s))) return undefined;
	let real: string;
	try {
		real = realpathSync(join(realRoot, ...segs));
	} catch {
		return undefined;
	}
	if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return undefined;
	const inner = relative(realRoot, real);
	return inner && inner.split(sep).some(denied) ? undefined : real;
}

type Entry = { name: string; type: "dir" | "file" | "link" | "other"; size?: number };
export type Listing =
	| { kind: "dir"; entries: Entry[]; truncated: boolean }
	| { kind: "file"; size: number; binary: boolean; too_large: boolean; text?: string };

const MAX_ENTRIES = 1000;
const MAX_FILE = 512 * 1024;

/** A directory listing or a file's text inside a root; undefined → 404. */
export function listOrRead(state: ViewerState, rootId: string, rel: string, env: NodeJS.ProcessEnv = process.env): Listing | undefined {
	const root = resolveRootId(state, rootId, env);
	const path = root ? resolveInRoot(root, rel) : undefined;
	if (!path) return undefined;
	try {
		const stat = statSync(path);
		if (stat.isDirectory()) {
			const entries = readdirSync(path, { withFileTypes: true })
				.filter((d) => !denied(d.name))
				.map((d): Entry => {
					const type: Entry["type"] = d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "link" : "other";
					return type === "file" ? { name: d.name, type, size: lstatSync(join(path, d.name)).size } : { name: d.name, type };
				})
				.sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
			return { kind: "dir", entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
		}
		if (!stat.isFile()) return undefined;
		if (stat.size > MAX_FILE) return { kind: "file", size: stat.size, binary: false, too_large: true };
		const probe = Buffer.alloc(Math.min(8000, stat.size));
		const fd = openSync(path, "r");
		try {
			readSync(fd, probe, 0, probe.length, 0);
		} finally {
			closeSync(fd);
		}
		if (probe.includes(0)) return { kind: "file", size: stat.size, binary: true, too_large: false };
		return { kind: "file", size: stat.size, binary: false, too_large: false, text: readFileSync(path, "utf8") };
	} catch {
		return undefined;
	}
}

const GIT_VIEWS: Record<string, readonly string[]> = {
	log: ["log", "-n", "100", "--no-color", "--format=%H%x1f%an%x1f%aI%x1f%s"],
	status: ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal", "--renames"],
	refs: ["for-each-ref", "--count=300", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)", "refs/heads", "refs/remotes", "refs/tags"],
	show: [],
};

/** One read-only git view of a root. Argv is built here: only an enum view and a 40-hex sha come from the request. */
export async function gitView(state: ViewerState, rootId: string, view: string, sha?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ status: number; body: unknown }> {
	const base = Object.hasOwn(GIT_VIEWS, view) ? GIT_VIEWS[view] : undefined;
	if (!base || (view === "show" && !SHA.test(sha ?? ""))) return { status: 400, body: { error: "bad view or sha" } };
	const root = resolveRootId(state, rootId, env);
	if (!root) return { status: 404, body: { error: "no such root" } };
	let out = view === "show" ? await safePatch(root, "show", sha as string) : await runGit(root, base);
	if (view === "status") out = safeStatus(out);
	if (!out.ok) return { status: 200, body: { ok: false, reason: out.reason } };
	const lines = out.stdout.split("\n").filter(Boolean);
	const data =
		view === "log"
			? { commits: lines.map((l) => { const [s, author, date, subject] = l.split("\x1f"); return { sha: s, author, date, subject }; }) }
			: view === "refs"
				? { refs: lines.map((l) => { const [ref, s, date] = l.split("\t"); return { ref, sha: s, date }; }) }
				: view === "status"
					? { lines }
					: { text: out.stdout };
	return { status: 200, body: { ok: true, view, root: rootId, truncated: out.truncated, ...data } };
}
