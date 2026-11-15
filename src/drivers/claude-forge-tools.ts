/**
 * N4d/WP1: a native implementer's network (a planner's: gh_read) as in-process picp MCP tools. They run in the
 * claude-worker process, which holds the worker env, so no credential enters the CLI child. Output is redacted, capped.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ciStatusRepeatRefusal } from "../ci-wait.ts";
import { redactGithubTokens } from "../worker-credential-guard.ts";
import type { SpikeJob } from "./claude-spike.ts";

export const FORGE_OUTPUT_MAX = 20_000;
/** This job's PR, recorded in its run dir by `pr_create`: what `pr_edit` and `gh_read` accept as "this job's PR". */
export const FORGE_PR_FILE = "native-pr.json";
const EXEC_TIMEOUT_MS = 120_000;
const TITLE_MAX = 256;
const BODY_MAX = 60_000;
const run = promisify(execFile);

/** Per worker process, like the Bash hook's quota: one CI status snapshot, then the ci-wait repeat refusal. */
export interface ForgeState {
	statusQueries: number;
}
const processState: ForgeState = { statusQueries: 0 };

type ForgeJob = Pick<SpikeJob, "job_id" | "worktree" | "runDir">;
interface RecordedPr {
	url: string;
	number: number;
}

const capped = (value: string): string => {
	const text = redactGithubTokens(value);
	return text.length <= FORGE_OUTPUT_MAX ? text : `[truncated: the first ${text.length - FORGE_OUTPUT_MAX} chars]\n${text.slice(-FORGE_OUTPUT_MAX)}`;
};
const reply = (value: string, isError: boolean) => ({ content: [{ type: "text" as const, text: capped(value) }], isError });
const refuse = (value: string) => reply(`Refused: ${value}`, true);

async function exec(file: "git" | "gh", args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
	try {
		const options = { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 << 20, encoding: "utf8" as const };
		const { stdout, stderr } = await run(file, args, options);
		return { ok: true, out: `${stdout}${stderr}`.trim() };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
	}
}

function recordedPr(runDir: string): RecordedPr | undefined {
	const file = join(runDir, FORGE_PR_FILE);
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RecordedPr) : undefined;
	} catch {
		// An unreadable record is no record: pr_create finds the open PR through gh's "already exists".
		return undefined;
	}
}

function recordPr(runDir: string, pr: RecordedPr): void {
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, `${FORGE_PR_FILE}.tmp`), `${JSON.stringify(pr)}\n`);
	renameSync(join(runDir, `${FORGE_PR_FILE}.tmp`), join(runDir, FORGE_PR_FILE));
}

const GH_READ_VERBS = [
	"pr view", "pr list", "pr diff", "pr checks", "issue view", "issue list", "run view", "run list", "release view", "release list", "repo view", "api",
] as const;
const GH_ARG_MAX = 200;
const GH_ARGS_MAX = 20;
// A method, a body, a header, another host or repo, the browser, or a blocking watch: never a plain GET read here.
const GH_REFUSED_LONG = ["--method", "--field", "--raw-field", "--input", "--header", "--hostname", "--repo", "--web", "--watch"];
const GH_REFUSED_SHORT = new Set(["X", "f", "F", "H", "R", "w"]);
// Read flags whose next word is their value; any other bare word in `args` is a positional (a repo, URL or extra).
const GH_VALUE_LONG = new Set([
	"--json", "--jq", "--template", "--limit", "--state", "--label", "--author", "--assignee", "--base", "--head", "--search", "--branch",
	"--workflow", "--event", "--status", "--user", "--commit", "--job", "--attempt", "--milestone", "--app", "--created", "--mention", "--cache",
	"--preview", "--order",
]);
const GH_VALUE_SHORT = new Set([..."qtLslAaBSbecjmpO"]);
const SEARCH_QUALIFIER = /(?:^|[\s(])-?(?:repo|org|user|owner):/i;
const API_REPO = /^\/*repos\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/;
const REMEDY = "gh_read only reads this job's repo with GET; forge writes are not available to a native worker";
/** An `api` path that reads CI status (runs, check runs or suites, a commit's status), not a log: one snapshot too. */
const CI_STATUS_PATH = /\/(?:actions\/runs|check-runs|check-suites|commits\/[^/?#]+\/status(?:es)?)(?![^?#]*\/logs)(?:[/?#]|$)/;

/** Why `gh_read` refuses `args` (and an `api` `path`) before gh runs; undefined when the read may run. */
function ghReadRefusal(verb: string, args: readonly string[], path: string | undefined): string | undefined {
	if (path !== undefined && verb !== "api") return `gh_read takes a path only with \`api\`, not \`${verb}\`.`;
	if (path !== undefined && (/^\/?graphql(?:[/?#]|$)/i.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("-"))) {
		return `gh_read \`api\` never reads ${path} (graphql, a URL or a flag); ${REMEDY}.`;
	}
	if (path !== undefined && (/(?:^|\/)\.\.?(?:[/?#]|$)|%2[ef]|%5c|\\/i.test(path) || !API_REPO.test(path))) {
		return `gh_read \`api\` reads only repos/<owner>/<repo>/... of this job's repo, never ${path}; ${REMEDY}.`;
	}
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const long = arg.startsWith("--") ? GH_REFUSED_LONG.find((flag) => arg === flag || arg.startsWith(`${flag}=`)) : undefined;
		// pflag bundles short letters (`-iXPOST`), so any refused letter in the leading run counts.
		const short = !arg.startsWith("--") && arg.startsWith("-") ? [.../^-([A-Za-z]*)/.exec(arg)?.[1] ?? ""].find((c) => GH_REFUSED_SHORT.has(c)) : undefined;
		const flag = long ?? (short === undefined ? undefined : `-${short}`);
		if (flag !== undefined) return `gh_read never passes \`${flag}\` (in \`${arg}\`); ${REMEDY}.`;
		if (arg === "--") {
			positionals.push(...args.slice(i + 1));
			break;
		}
		let search = arg === "--search" ? args[i + 1] : arg.startsWith("--search=") ? arg.slice(9) : undefined;
		if (arg.startsWith("--")) {
			if (GH_VALUE_LONG.has(arg)) i++;
		} else if (arg.length > 1 && arg.startsWith("-")) {
			// As pflag: the first value letter takes the rest of the bundle, or the next word (`-dSrepo:x/y`, `-dS q`).
			const letters = /^-([A-Za-z]*)/.exec(arg)?.[1] ?? "";
			const at = [...letters].findIndex((c) => GH_VALUE_SHORT.has(c));
			if (at >= 0) {
				const attached = arg.slice(2 + at);
				const value = attached === "" ? args[++i] : attached;
				if (letters[at] === "S") search = value;
			}
		} else positionals.push(arg);
		if (search !== undefined && SEARCH_QUALIFIER.test(search)) return `gh_read never searches another repo, org or user (\`${search}\`); ${REMEDY}.`;
	}
	const extra = positionals.slice(verb === "release view" ? 1 : 0)[0];
	if (extra !== undefined) {
		return `gh_read never passes the positional \`${extra}\` (another repo, a URL or an extra argument): it reads only this job's repo; ` +
			"put the number in number/run_id and the api path in path.";
	}
	return undefined;
}

/** The `owner/repo` an `api` path names; undefined for gh's `{owner}/{repo}` placeholders (this job's repo). */
function apiPathRepo(path: string): string | undefined {
	const [, owner = "", repo = ""] = API_REPO.exec(path) ?? [];
	return owner === "{owner}" && repo === "{repo}" ? undefined : `${owner}/${repo}`;
}

/** `git_push`, `git_fetch`, `pr_create`, `pr_edit` and `gh_read` for `job`; `env` is the worker's own (credentials). */
export function forgeTools(job: ForgeJob, env: NodeJS.ProcessEnv = process.env, state: ForgeState = processState): SdkMcpToolDefinition<any>[] {
	const base = env.CP_BASE_BRANCH?.trim() || undefined;
	const protectedBranches = [...new Set(["main", ...(base ? [base] : [])])];
	const branch = job.job_id;
	const gh = (args: string[]) => exec("gh", args, job.worktree, env);
	// The worker's GH_REPO is dropped; a GitHub origin pins it, so no upstream remote or set-default picks the base repo.
	const { GH_REPO: _ghRepo, ...readEnv } = env;
	let origin: Promise<string | undefined> | undefined;
	const originRepo = (): Promise<string | undefined> => (origin ??= exec("git", ["remote", "get-url", "origin"], job.worktree, readEnv).then((remote) => {
		const github = remote.ok ? /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.out) : null;
		return github === null ? undefined : `${github[1]}/${github[2]}`;
	}));
	const ghReadOnly = async (args: string[]) => {
		const pinned = await originRepo();
		return exec("gh", args, job.worktree, pinned === undefined ? readEnv : { ...readEnv, GH_REPO: pinned });
	};
	let creating: Promise<ReturnType<typeof reply>> | undefined;
	let jobRepo: string | undefined;
	const resolveJobRepo = async (): Promise<string | undefined> => {
		if (jobRepo !== undefined) return jobRepo;
		const pinned = await originRepo();
		if (pinned !== undefined) return (jobRepo = pinned);
		// A non-GitHub origin URL (an enterprise host, a local mirror): gh resolves the repo from the worktree.
		const read = await ghReadOnly(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
		const name = read.out.trim();
		if (read.ok && /^[\w.-]+\/[\w.-]+$/.test(name)) jobRepo = name;
		return jobRepo;
	};

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

	const ghRead = tool(
		"gh_read",
		"One GitHub read in this job's repo: any issue, PR (`pr view|checks|diff` default to this job's PR), run, release or the repo; " +
			"`api` is a GET of `path` under repos/<owner>/<repo>/ of this repo (no graphql, no URL). `args` add read flags only: " +
			"write, host, repo, browser and watch flags and positionals (but a release tag) are refused. One CI status snapshot per worker; never poll.",
		{
			verb: z.enum(GH_READ_VERBS),
			number: z.number().int().positive().optional(),
			run_id: z.string().regex(/^\d+$/).optional(),
			log_failed: z.boolean().optional(),
			path: z.string().min(1).max(GH_ARG_MAX).optional(),
			args: z.array(z.string().max(GH_ARG_MAX)).max(GH_ARGS_MAX).optional(),
		},
		async (args) => {
			const extra = args.args ?? [];
			const why = ghReadRefusal(args.verb, extra, args.path);
			if (why !== undefined) return refuse(why);
			let argv: string[];
			if (args.verb === "run view") {
				if (args.run_id === undefined || !/^\d+$/.test(args.run_id)) return refuse("gh_read `run view` needs a numeric run_id.");
				argv = ["run", "view", args.run_id, ...(args.log_failed === true ? ["--log-failed"] : [])];
			} else if (args.verb === "api") {
				if (args.path === undefined) return refuse("gh_read `api` needs a path, such as repos/<owner>/<repo>/pulls/<n>/comments.");
				const named = apiPathRepo(args.path);
				if (named !== undefined) {
					const own = await resolveJobRepo();
					if (own === undefined) return refuse(`gh_read could not tell this job's origin repo, so it never reads ${args.path}; use repos/{owner}/{repo}/... in path.`);
					if (named.toLowerCase() !== own.toLowerCase()) return refuse(`gh_read \`api\` reads only ${own}, this job's origin, never ${args.path} (${named}); ${REMEDY}.`);
				}
				argv = ["api", args.path];
			} else if (args.verb === "issue view") {
				if (args.number === undefined) return refuse("gh_read `issue view` needs the issue number.");
				argv = ["issue", "view", String(args.number)];
			} else if (args.verb === "pr view" || args.verb === "pr checks" || args.verb === "pr diff") {
				argv = [...args.verb.split(" "), args.number === undefined ? (recordedPr(job.runDir)?.url ?? branch) : String(args.number)];
			} else {
				argv = args.verb.split(" ");
			}
			argv.push(...extra);
			const status = args.verb === "pr checks" || args.verb === "run list" || (args.verb === "run view" && args.log_failed !== true && !extra.includes("--log")) ||
				extra.some((arg) => /statusCheckRollup/i.test(arg)) || (args.verb === "api" && CI_STATUS_PATH.test(args.path ?? ""));
			if (status && state.statusQueries++ >= 1) return refuse(`${ciStatusRepeatRefusal().replace(/^Refused: /, "")}\nWith gh_read that log is \`run view\` with log_failed.`);
			const read = await ghReadOnly(argv);
			return reply(read.out || `gh ${argv.slice(0, 2).join(" ")} printed nothing`, !read.ok);
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
