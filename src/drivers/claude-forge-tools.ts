/**
 * N4d/WP1: a native implementer's network (a planner's: gh_read) as in-process picp MCP tools. They run in the
 * claude-worker process, which holds the worker env, so no credential enters the CLI child. Output is redacted, capped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	capped, exec, FORGE_PR_FILE, type ForgeJob, type ForgeState, GH_ARG_MAX, GH_ARGS_MAX, GH_READ_VERBS, ghRead as sharedGhRead, processState, type RecordedPr,
	recordedPr,
} from "./native-gh-read.ts";

export { FORGE_OUTPUT_MAX, FORGE_PR_FILE, type ForgeState } from "./native-gh-read.ts";

const TITLE_MAX = 256;
const BODY_MAX = 60_000;

const reply = (value: string, isError: boolean) => ({ content: [{ type: "text" as const, text: capped(value) }], isError });
const refuse = (value: string) => reply(`Refused: ${value}`, true);

function recordPr(runDir: string, pr: RecordedPr): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, `${FORGE_PR_FILE}.tmp`), `${JSON.stringify(pr)}\n`);
	renameSync(join(runDir, `${FORGE_PR_FILE}.tmp`), join(runDir, FORGE_PR_FILE));
}

/** `git_push`, `git_fetch`, `pr_create`, `pr_edit` and `gh_read` for `job`; `env` is the worker's own (credentials). */
export function forgeTools(job: ForgeJob, env: NodeJS.ProcessEnv = process.env, state: ForgeState = processState): SdkMcpToolDefinition<any>[] {
	const base = env.CP_BASE_BRANCH?.trim() || undefined;
	const protectedBranches = [...new Set(["main", ...(base ? [base] : [])])];
	const branch = job.job_id;
	const gh = (args: string[]) => exec("gh", args, job.worktree, env);
	let creating: Promise<ReturnType<typeof reply>> | undefined;

	const push = tool(
		"git_push",
		`Push HEAD to origin/${branch}, this job's branch, never forced. Main and the base branch are refused.`,
		{ branch: z.string().optional(), force: z.boolean().optional() },
		async (args) => {
			const target = args.branch ?? branch;
			if (args.force === true) return refuse(`git_push never forces a push; merge origin/${branch} and push again.`);
			if (protectedBranches.includes(target)) return refuse(`git_push never pushes ${target} (main and the base branch are refused); it pushes HEAD to origin/${branch} only.`);
			if (target !== branch) return refuse(`git_push pushes only to origin/${branch}, this job's branch, not ${target}.`);
			const pushed = await exec("git", ["push", "origin", `HEAD:refs/heads/${branch}`], job.worktree, env);
			if (!pushed.ok && /non-fast-forward|fetch first|\[rejected\]/.test(pushed.out)) {
				return refuse(`git_push: HEAD is not a fast-forward of origin/${branch}, and it never forces. git_fetch, \`git merge origin/${branch}\`, then push again.\n${pushed.out}`);
			}
			return reply(pushed.ok ? `Pushed HEAD to origin/${branch}.\n${pushed.out}` : `git_push failed:\n${pushed.out}`, !pushed.ok);
		},
	);

	const fetch = tool(
		"git_fetch",
		"Fetch origin in this job's worktree. No other directory, the canonical clone included.",
		{ cwd: z.string().optional() },
		async (args) => {
			const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
			if (args.cwd !== undefined && real(resolve(job.worktree, args.cwd)) !== real(job.worktree)) {
				return refuse(`git_fetch runs only in this job's worktree ${job.worktree}, never ${args.cwd}.`);
			}
			const fetched = await exec("git", ["fetch", "origin"], job.worktree, env);
			return reply(fetched.ok ? `Fetched origin.\n${fetched.out}` : `git_fetch failed:\n${fetched.out}`, !fetched.ok);
		},
	);

	const prCreate = tool(
		"pr_create",
		`Open this job's draft PR from ${branch}${base ? ` to ${base}` : ""}. Once per job; a second call returns its URL.`,
		{ title: z.string().min(1).max(TITLE_MAX), body: z.string().max(BODY_MAX) },
		async (args) => {
			const recorded = recordedPr(job.runDir);
			if (recorded !== undefined) return reply(`pr_create already opened this job's PR: ${recorded.url}`, false);
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
	);

	const thisPr = (pr: number | undefined, verb: string): RecordedPr | string | undefined => {
		const recorded = recordedPr(job.runDir);
		if (pr === undefined || pr === recorded?.number) return recorded;
		return `${verb} reaches only this job's PR${recorded ? ` #${recorded.number} (${recorded.url})` : ", and pr_create has not opened it"}; #${pr} is refused.`;
	};

	const prEdit = tool(
		"pr_edit",
		"Edit the title and/or body of this job's PR. Any other PR number is refused.",
		{ pr: z.number().int().optional(), title: z.string().min(1).max(TITLE_MAX).optional(), body: z.string().max(BODY_MAX).optional() },
		async (args) => {
			const pr = thisPr(args.pr, "pr_edit");
			if (typeof pr === "string") return refuse(pr);
			if (pr === undefined) return refuse("pr_edit edits only this job's PR, and pr_create has not opened it yet.");
			if (args.title === undefined && args.body === undefined) return refuse("pr_edit needs a title or a body.");
			const edited = await gh(["pr", "edit", pr.url, ...(args.title === undefined ? [] : ["--title", args.title]), ...(args.body === undefined ? [] : ["--body", args.body])]);
			return reply(edited.ok ? `Edited ${pr.url}.\n${edited.out}` : `pr_edit failed:\n${edited.out}`, !edited.ok);
		},
	);

	const shared = sharedGhRead(job, env, state);
	const ghRead = tool(
		"gh_read",
		shared.description,
		{
			verb: z.enum(GH_READ_VERBS),
			number: z.number().int().positive().optional(),
			run_id: z.string().regex(/^\d+$/).optional(),
			log_failed: z.boolean().optional(),
			path: z.string().min(1).max(GH_ARG_MAX).optional(),
			args: z.array(z.string().max(GH_ARG_MAX)).max(GH_ARGS_MAX).optional(),
		},
		async (args) => {
			const read = await shared.run(args);
			return reply(read.text, read.isError);
		},
	);

	return [push, fetch, prCreate, prEdit, ghRead];
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
