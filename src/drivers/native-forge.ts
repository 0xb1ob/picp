/**
 * The native forge writes, SDK-free (C7a): `git_push`, `git_fetch`, `pr_create`, `pr_edit` (moved from
 * claude-forge-tools.ts), Codex's `git_commit` and `git_merge`, and the freeze checkpoint's WIP commit. Each runs in
 * the worker process; `env` is the worker's own, and commit and merge get a credential-free one (`gitEnv`).
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hitsNeedle } from "../mandate.ts";
import { workflowScopeRefusal } from "../workflow-scope.ts";
import { exec, FORGE_PR_FILE, type ForgeJob, type RecordedPr, recordedPr } from "./native-gh-read.ts";

export const TITLE_MAX = 256;
export const BODY_MAX = 60_000;
export const COMMIT_MESSAGE_MAX = 10_000;
/** C7a (U2, addendum C3): a codex job's worker-side git runs no repository hook and no fsmonitor command. */
export const GIT_HOOKS_OFF: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const GATE_NAMES_MAX = 5;

export interface ForgeReply {
	text: string;
	isError: boolean;
}
const reply = (text: string, isError: boolean): ForgeReply => ({ text, isError });
const refuse = (text: string): ForgeReply => reply(`Refused: ${text}`, true);

/** `hooksOff`: only the Codex driver passes it; every git call then starts with GIT_HOOKS_OFF. */
export interface ForgeOptions {
	hooksOff?: boolean;
}

function recordPr(runDir: string, pr: RecordedPr): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, `${FORGE_PR_FILE}.tmp`), `${JSON.stringify(pr)}\n`);
	renameSync(join(runDir, `${FORGE_PR_FILE}.tmp`), join(runDir, FORGE_PR_FILE));
}

export interface ForgeWrites {
	descriptions: { push: string; fetch: string; prCreate: string; prEdit: string };
	push(args: { branch?: string; force?: boolean }): Promise<ForgeReply>;
	fetch(args: { cwd?: string }): Promise<ForgeReply>;
	prCreate(args: { title: string; body: string }): Promise<ForgeReply>;
	prEdit(args: { pr?: number; title?: string; body?: string }): Promise<ForgeReply>;
}

/** `git_push`, `git_fetch`, `pr_create` and `pr_edit` for `job`; `env` is the worker's own (credentials). */
export function forgeWrites(job: ForgeJob, env: NodeJS.ProcessEnv = process.env, options: ForgeOptions = {}): ForgeWrites {
	const base = env.CP_BASE_BRANCH?.trim() || undefined;
	const protectedBranches = [...new Set(["main", ...(base ? [base] : [])])];
	const branch = job.job_id;
	const gh = (args: string[]) => exec("gh", args, job.worktree, env);
	const git = (args: string[]) => exec("git", [...(options.hooksOff ? GIT_HOOKS_OFF : []), ...args], job.worktree, env);
	let creating: Promise<ForgeReply> | undefined;

	const thisPr = (pr: number | undefined, verb: string): RecordedPr | string | undefined => {
		const recorded = recordedPr(job.runDir);
		if (pr === undefined || pr === recorded?.number) return recorded;
		return `${verb} reaches only this job's PR${recorded ? ` #${recorded.number} (${recorded.url})` : ", and pr_create has not opened it"}; #${pr} is refused.`;
	};

	return {
		descriptions: {
			push: `Push HEAD to origin/${branch}, this job's branch, never forced. Main and the base branch are refused.`,
			fetch: "Fetch origin in this job's worktree. No other directory, the canonical clone included.",
			prCreate: `Open this job's draft PR from ${branch}${base ? ` to ${base}` : ""}. Once per job; a second call returns its URL.`,
			prEdit: "Edit the title and/or body of this job's PR. Any other PR number is refused.",
		},
		async push(args) {
			const target = args.branch ?? branch;
			if (args.force === true) return refuse(`git_push never forces a push; merge origin/${branch} and push again.`);
			if (protectedBranches.includes(target)) return refuse(`git_push never pushes ${target} (main and the base branch are refused); it pushes HEAD to origin/${branch} only.`);
			if (target !== branch) return refuse(`git_push pushes only to origin/${branch}, this job's branch, not ${target}.`);
			const pushed = await git(["push", "origin", `HEAD:refs/heads/${branch}`]);
			if (!pushed.ok && /non-fast-forward|fetch first|\[rejected\]/.test(pushed.out)) {
				const merge = options.hooksOff ? `git_merge {ref: "origin/${branch}"}` : `\`git merge origin/${branch}\``;
				return refuse(`git_push: HEAD is not a fast-forward of origin/${branch}, and it never forces. git_fetch, ${merge}, then push again.\n${pushed.out}`);
			}
			const scope = pushed.ok ? undefined : workflowScopeRefusal(pushed.out);
			if (scope) return reply(`${scope}\n${pushed.out}`, true);
			return reply(pushed.ok ? `Pushed HEAD to origin/${branch}.\n${pushed.out}` : `git_push failed:\n${pushed.out}`, !pushed.ok);
		},
		async fetch(args) {
			const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
			if (args.cwd !== undefined && real(resolve(job.worktree, args.cwd)) !== real(job.worktree)) {
				return refuse(`git_fetch runs only in this job's worktree ${job.worktree}, never ${args.cwd}.`);
			}
			const fetched = await git(["fetch", "origin"]);
			return reply(fetched.ok ? `Fetched origin.\n${fetched.out}` : `git_fetch failed:\n${fetched.out}`, !fetched.ok);
		},
		prCreate(args) {
			const recorded = recordedPr(job.runDir);
			if (recorded !== undefined) return Promise.resolve(reply(`pr_create already opened this job's PR: ${recorded.url}`, false));
			creating ??= (async () => {
				const made = await gh(["pr", "create", "--draft", "--head", branch, ...(base ? ["--base", base] : []), "--title", args.title, "--body", args.body]);
				const url = /https:\/\/\S+\/pull\/(\d+)/.exec(made.out);
				// gh names the open PR when one already exists, so a lost record still finds it.
				if (url === null || (!made.ok && !/already exists/.test(made.out))) return reply(`pr_create failed:\n${made.out}`, true);
				recordPr(job.runDir, { url: url[0], number: Number(url[1]) });
				return reply(`Draft PR for ${branch}: ${url[0]}`, false);
			})().finally(() => (creating = undefined));
			return creating;
		},
		async prEdit(args) {
			const pr = thisPr(args.pr, "pr_edit");
			if (typeof pr === "string") return refuse(pr);
			if (pr === undefined) return refuse("pr_edit edits only this job's PR, and pr_create has not opened it yet.");
			if (args.title === undefined && args.body === undefined) return refuse("pr_edit needs a title or a body.");
			const edited = await gh(["pr", "edit", pr.url, ...(args.title === undefined ? [] : ["--title", args.title]), ...(args.body === undefined ? [] : ["--body", args.body])]);
			return reply(edited.ok ? `Edited ${pr.url}.\n${edited.out}` : `pr_edit failed:\n${edited.out}`, !edited.ok);
		},
	};
}

/** The worktree's commit identity as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so `git commit` works in the scratch-HOME
 * child. */
export function commitIdentityEnv(worktree: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const get = (key: string): string => {
		try {
			return execFileSync("git", ["config", "--get", key], { cwd: worktree, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return "";
		}
	};
	const [name, email] = [get("user.name"), get("user.email")];
	if (name === "" || email === "") throw new Error(`native implementer: ${worktree} has no git user.name/user.email, so it cannot commit; set them`);
	return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

const GIT_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
/** RR2: commit and merge may run a filter the repository's config names, so they get no credential and no HOME. */
export function gitEnv(env: NodeJS.ProcessEnv, identity: Record<string, string>): NodeJS.ProcessEnv {
	const kept: NodeJS.ProcessEnv = {};
	for (const key of GIT_ENV_ALLOW) if (env[key] !== undefined) kept[key] = env[key];
	return { ...kept, ...identity };
}

export interface CommitOptions {
	excluded: readonly string[];
	/** The worker env: PATH, locale and the identity are taken from it; nothing else reaches git. */
	env: NodeJS.ProcessEnv;
	hooksOff?: boolean;
}

/** Staged paths that differ from `HEAD` (and from `MERGE_HEAD` during a merge) and match an `excluded` needle. */
async function gatedPaths(git: (args: string[]) => Promise<{ ok: boolean; out: string }>, excluded: readonly string[]): Promise<string[] | string> {
	const names = async (against: string[]): Promise<string[] | string> => {
		const listed = await git(["diff", "--cached", "--name-only", "--no-renames", "-z", ...against]);
		return listed.ok ? listed.out.split("\0").filter((path) => path !== "") : `git diff --cached failed:\n${listed.out}`;
	};
	const staged = await names([]);
	if (typeof staged === "string") return staged;
	const merging = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok;
	const theirs = merging ? await names(["MERGE_HEAD"]) : staged;
	if (typeof theirs === "string") return theirs;
	const authored = staged.filter((path) => theirs.includes(path));
	return authored.filter((path) => excluded.some((needle) => hitsNeedle(path, needle) || hitsNeedle(`${path}/`, needle)));
}

/** Codex's `git_commit`: `git add -A`, the staged-path gate over `exclude_paths`, then `git commit`; never a hook. */
export async function gitCommit(job: ForgeJob, args: { message: string }, options: CommitOptions): Promise<ForgeReply> {
	let identity: Record<string, string>;
	try {
		identity = commitIdentityEnv(job.worktree, options.env);
	} catch (error) {
		return refuse(`git_commit: ${(error as Error).message}.`);
	}
	const env = gitEnv(options.env, identity);
	const git = (more: string[]) => exec("git", [...(options.hooksOff ? GIT_HOOKS_OFF : []), ...more], job.worktree, env);
	const added = await git(["add", "-A"]);
	if (!added.ok) return reply(`git_commit failed at git add -A:\n${added.out}`, true);
	const hits = await gatedPaths(git, options.excluded);
	if (typeof hits === "string") return reply(`git_commit failed:\n${hits}`, true);
	if (hits.length > 0) {
		const unstaged = await git(["reset", "-q", "--", "."]);
		const named = hits.slice(0, GATE_NAMES_MAX).join(", ") + (hits.length > GATE_NAMES_MAX ? `, and ${hits.length - GATE_NAMES_MAX} more` : "");
		const note = unstaged.ok ? "Nothing was committed and the index is unstaged" : `Nothing was committed; unstaging failed:\n${unstaged.out}`;
		return refuse(`git_commit never commits an excluded path (exclude_paths): ${named}. ${note}. Delete or restore those files, then git_commit again.`);
	}
	const merging = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok;
	if (!merging && (await git(["diff", "--cached", "--quiet"])).ok) return reply("git_commit: nothing to commit; HEAD is unchanged.", false);
	const committed = await git(["commit", "-q", "-m", args.message]);
	if (!committed.ok) return reply(`git_commit failed:\n${committed.out}`, true);
	const head = await git(["rev-parse", "HEAD"]);
	return reply(head.ok ? `Committed ${head.out}.` : `Committed; reading HEAD failed:\n${head.out}`, !head.ok);
}

/** Codex's `git_merge`: only `origin/<job>` or `origin/<base>` (base `CP_BASE_BRANCH`, else main); never a hook. */
export async function gitMerge(job: ForgeJob, args: { ref: string }, options: Omit<CommitOptions, "excluded">): Promise<ForgeReply> {
	const base = options.env.CP_BASE_BRANCH?.trim() || "main";
	const allowed = [...new Set([`origin/${job.job_id}`, `origin/${base}`])];
	if (!allowed.includes(args.ref)) return refuse(`git_merge merges only ${allowed.join(" or ")}, not ${args.ref}.`);
	let identity: Record<string, string>;
	try {
		identity = commitIdentityEnv(job.worktree, options.env);
	} catch (error) {
		return refuse(`git_merge: ${(error as Error).message}.`);
	}
	const merged = await exec("git", [...(options.hooksOff ? GIT_HOOKS_OFF : []), "merge", "--no-edit", args.ref], job.worktree, gitEnv(options.env, identity));
	if (merged.ok) return reply(`Merged ${args.ref}.\n${merged.out}`, false);
	const conflict = /CONFLICT|Automatic merge failed/.test(merged.out);
	return reply(conflict ? `git_merge stopped on conflicts; fix the files with the shell, then git_commit concludes the merge.\n${merged.out}` : `git_merge failed:\n${merged.out}`, true);
}

type Checkpoint = { head: string; pushed: boolean; error?: string } | { error: string };

/**
 * Commits the worktree's WIP after a freeze aborted the turn (`git add -A` honours .gitignore), then pushes it to
 * origin/<job> best effort, never forced: a failed push is `pushed: false` with its error, still a checkpoint.
 */
export function checkpointCommit(worktree: string, branch: string, env: NodeJS.ProcessEnv = process.env): Checkpoint {
	const bounded = (error: unknown) => (error as Error).message.slice(0, 500);
	let head: string;
	let git: (args: string[]) => string;
	try {
		const options: ExecFileSyncOptionsWithStringEncoding = { cwd: worktree, env: { ...env, ...commitIdentityEnv(worktree) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
		git = (args) => execFileSync("git", args, options).trim();
		git(["add", "-A"]);
		if (git(["status", "--porcelain"]) !== "") git(["commit", "-q", "-m", "WIP: freeze checkpoint"]);
		head = git(["rev-parse", "HEAD"]);
	} catch (error) {
		return { error: bounded(error) };
	}
	if (!branch || ["main", env.CP_BASE_BRANCH?.trim()].includes(branch)) return { head, pushed: false, error: `no job branch to push (${branch || "unset"})` };
	try {
		git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
		return { head, pushed: true };
	} catch (error) {
		return { head, pushed: false, error: workflowScopeRefusal(String((error as Error).message)) ?? bounded(error) };
	}
}

const UNSTAGE_BATCH = 500;

export interface CodexCheckpointOptions extends Omit<CommitOptions, "hooksOff"> {
	/** C1: paths a lockdown-killed run left that the revive named; never WIP-committed, named in `unreviewed`. */
	unreviewed?: readonly string[];
	/** False for delivery local: the WIP commit stays local, as every other local-delivery write does. */
	push: boolean;
}

/**
 * C7b (Q2): a Codex implementer's freeze checkpoint: hooks off, a credential-free commit, the staged-path gate (a gated
 * path stays uncommitted, named in `excluded`) and C1's unreviewed paths left out. Then the best-effort push.
 */
export async function codexCheckpointCommit(job: ForgeJob, options: CodexCheckpointOptions): Promise<Checkpoint & { excluded?: string[]; unreviewed?: string[] }> {
	const bounded = (text: string) => text.slice(0, 500);
	let identity: Record<string, string>;
	try {
		identity = commitIdentityEnv(job.worktree, options.env);
	} catch (error) {
		return { error: bounded((error as Error).message) };
	}
	const git = (more: string[]) => exec("git", [...GIT_HOOKS_OFF, ...more], job.worktree, gitEnv(options.env, identity));
	const added = await git(["add", "-A"]);
	if (!added.ok) return { error: bounded(added.out) };
	const hits = await gatedPaths(git, options.excluded);
	if (typeof hits === "string") return { error: bounded(hits) };
	const staged = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"]);
	if (!staged.ok) return { error: bounded(staged.out) };
	const named = new Set(options.unreviewed ?? []);
	const gated = new Set(hits);
	const held = staged.out.split("\0").filter((path) => named.has(path) && !gated.has(path));
	// C8 (c): batched, so thousands of named paths never overflow one argv.
	const unstage = [...hits, ...held];
	for (let at = 0; at < unstage.length; at += UNSTAGE_BATCH) {
		const unstaged = await git(["reset", "-q", "--", ...unstage.slice(at, at + UNSTAGE_BATCH)]);
		if (!unstaged.ok) return { error: bounded(`unstaging the excluded or unreviewed paths failed: ${unstaged.out}`) };
	}
	const merging = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok;
	if (merging || !(await git(["diff", "--cached", "--quiet"])).ok) {
		const committed = await git(["commit", "-q", "-m", "WIP: freeze checkpoint"]);
		if (!committed.ok) return { error: bounded(committed.out) };
	}
	const head = await git(["rev-parse", "HEAD"]);
	if (!head.ok) return { error: bounded(head.out) };
	const excluded = {
		...(hits.length > 0 ? { excluded: hits.slice(0, GATE_NAMES_MAX) } : {}), ...(held.length > 0 ? { unreviewed: held.slice(0, GATE_NAMES_MAX) } : {}),
	};
	if (!options.push) return { head: head.out, pushed: false, ...excluded };
	const branch = job.job_id;
	if (!branch || ["main", options.env.CP_BASE_BRANCH?.trim()].includes(branch)) return { head: head.out, pushed: false, error: `no job branch to push (${branch || "unset"})`, ...excluded };
	const pushed = await exec("git", [...GIT_HOOKS_OFF, "push", "-q", "origin", `HEAD:refs/heads/${branch}`], job.worktree, options.env);
	if (pushed.ok) return { head: head.out, pushed: true, ...excluded };
	return { head: head.out, pushed: false, error: workflowScopeRefusal(pushed.out) ?? bounded(pushed.out), ...excluded };
}

/** The JSON input schemas of the six Codex forge tools, the Claude `zod` shapes' limits. */
export const FORGE_INPUT_SCHEMAS = {
	git_push: { type: "object", properties: { branch: { type: "string" }, force: { type: "boolean" } }, additionalProperties: false },
	git_fetch: { type: "object", properties: { cwd: { type: "string" } }, additionalProperties: false },
	pr_create: {
		type: "object", properties: { title: { type: "string", minLength: 1, maxLength: TITLE_MAX }, body: { type: "string", maxLength: BODY_MAX } },
		required: ["title", "body"], additionalProperties: false,
	},
	pr_edit: {
		type: "object",
		properties: { pr: { type: "integer" }, title: { type: "string", minLength: 1, maxLength: TITLE_MAX }, body: { type: "string", maxLength: BODY_MAX } },
		additionalProperties: false,
	},
	git_commit: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: COMMIT_MESSAGE_MAX } }, required: ["message"], additionalProperties: false },
	git_merge: { type: "object", properties: { ref: { type: "string", minLength: 1 } }, required: ["ref"], additionalProperties: false },
} as const;
export type ForgeToolName = keyof typeof FORGE_INPUT_SCHEMAS;

/** The arguments under FORGE_INPUT_SCHEMAS[name]'s limits, or one refusal naming the first bad field. */
export function parseForgeArgs(name: ForgeToolName, value: unknown): Record<string, unknown> | string {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return `Refused: ${name} takes an object of arguments.`;
	const a = value as Record<string, unknown>;
	const schema = FORGE_INPUT_SCHEMAS[name] as { properties: Record<string, { type: string; minLength?: number; maxLength?: number }>; required?: readonly string[] };
	for (const key of Object.keys(a)) if (!(key in schema.properties)) return `Refused: ${name} \`${key}\` is not a ${name} argument.`;
	for (const key of schema.required ?? []) if (a[key] === undefined) return `Refused: ${name} needs \`${key}\`.`;
	for (const [key, rule] of Object.entries(schema.properties)) {
		const field = a[key];
		if (field === undefined) continue;
		const bad = (why: string) => `Refused: ${name} \`${key}\` ${why}.`;
		if (rule.type === "boolean" && typeof field !== "boolean") return bad("must be a boolean");
		if (rule.type === "integer" && (typeof field !== "number" || !Number.isInteger(field))) return bad("must be an integer");
		if (rule.type === "string") {
			if (typeof field !== "string") return bad("must be a string");
			if (field.length < (rule.minLength ?? 0) || field.length > (rule.maxLength ?? Number.POSITIVE_INFINITY)) return bad(`must be ${rule.minLength ?? 0}-${rule.maxLength ?? "any"} characters`);
		}
	}
	return a;
}
