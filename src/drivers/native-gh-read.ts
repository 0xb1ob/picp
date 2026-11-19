/**
 * WP1's `gh_read`, SDK-free (C5): the verb list, the refusal table, the origin pin and the CI-status quota, shared by
 * the Claude forge tools and the Codex dynamic tool. It runs in the worker process with the worker's own env.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ciStatusRepeatRefusal } from "../ci-wait.ts";
import { redactGithubTokens } from "../worker-credential-guard.ts";
import type { SpikeJob } from "./native-guards.ts";

export const FORGE_OUTPUT_MAX = 20_000;
/** This job's PR, recorded in its run dir by `pr_create`: what `pr_edit` and `gh_read` accept as "this job's PR". */
export const FORGE_PR_FILE = "native-pr.json";
const EXEC_TIMEOUT_MS = 120_000;
const run = promisify(execFile);

/** Per worker process, like the Bash hook's quota: one CI status snapshot, then the ci-wait repeat refusal. */
export interface ForgeState {
	statusQueries: number;
}
export const processState: ForgeState = { statusQueries: 0 };

export type ForgeJob = Pick<SpikeJob, "job_id" | "worktree" | "runDir">;
export interface RecordedPr {
	url: string;
	number: number;
}

export const capped = (value: string): string => {
	const text = redactGithubTokens(value);
	return text.length <= FORGE_OUTPUT_MAX ? text : `[truncated: the first ${text.length - FORGE_OUTPUT_MAX} chars]\n${text.slice(-FORGE_OUTPUT_MAX)}`;
};

export async function exec(file: "git" | "gh", args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
	try {
		const options = { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 << 20, encoding: "utf8" as const };
		const { stdout, stderr } = await run(file, args, options);
		return { ok: true, out: `${stdout}${stderr}`.trim() };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
	}
}

export function recordedPr(runDir: string): RecordedPr | undefined {
	const file = join(runDir, FORGE_PR_FILE);
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RecordedPr) : undefined;
	} catch {
		// An unreadable record is no record: pr_create finds the open PR through gh's "already exists".
		return undefined;
	}
}

export const GH_READ_VERBS = [
	"pr view", "pr list", "pr diff", "pr checks", "issue view", "issue list", "run view", "run list", "release view", "release list", "repo view", "api",
] as const;
export const GH_ARG_MAX = 200;
export const GH_ARGS_MAX = 20;
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

export type GhReadVerb = (typeof GH_READ_VERBS)[number];
export interface GhReadArgs { verb: GhReadVerb; number?: number; run_id?: string; log_failed?: boolean; path?: string; args?: string[] }
export interface GhReadResult { text: string; isError: boolean }

export const GH_READ_DESCRIPTION =
	"One GitHub read in this job's repo: any issue, PR (`pr view|checks|diff` default to this job's PR), run, release or the repo; " +
	"`api` is a GET of `path` under repos/<owner>/<repo>/ of this repo (no graphql, no URL). `args` add read flags only: " +
	"write, host, repo, browser and watch flags and positionals (but a release tag) are refused. One CI status snapshot per worker; never poll.";

/** The JSON schema of the arguments, the same limits as the Claude tool's `zod` shape. */
export const GH_READ_INPUT_SCHEMA = {
	type: "object",
	properties: {
		verb: { type: "string", enum: [...GH_READ_VERBS] },
		number: { type: "integer", minimum: 1 },
		run_id: { type: "string", pattern: "^\\d+$" },
		log_failed: { type: "boolean" },
		path: { type: "string", minLength: 1, maxLength: GH_ARG_MAX },
		args: { type: "array", items: { type: "string", maxLength: GH_ARG_MAX }, maxItems: GH_ARGS_MAX },
	},
	required: ["verb"],
	additionalProperties: false,
} as const;

/** The arguments under GH_READ_INPUT_SCHEMA's limits, or one refusal naming the first bad field. */
export function parseGhReadArgs(value: unknown): GhReadArgs | string {
	const bad = (field: string, why: string) => `Refused: gh_read \`${field}\` ${why}.`;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return "Refused: gh_read takes an object of arguments.";
	const a = value as Record<string, unknown>;
	const unknown = Object.keys(a).find((key) => !(key in GH_READ_INPUT_SCHEMA.properties));
	if (unknown !== undefined) return bad(unknown, "is not a gh_read argument");
	if (typeof a.verb !== "string" || !(GH_READ_VERBS as readonly string[]).includes(a.verb)) return bad("verb", `must be one of ${GH_READ_VERBS.join(", ")}`);
	if (a.number !== undefined && (typeof a.number !== "number" || !Number.isInteger(a.number) || a.number < 1)) return bad("number", "must be a positive integer");
	if (a.run_id !== undefined && (typeof a.run_id !== "string" || !/^\d+$/.test(a.run_id))) return bad("run_id", "must be digits");
	if (a.log_failed !== undefined && typeof a.log_failed !== "boolean") return bad("log_failed", "must be a boolean");
	if (a.path !== undefined && (typeof a.path !== "string" || a.path.length < 1 || a.path.length > GH_ARG_MAX)) return bad("path", `must be 1-${GH_ARG_MAX} characters`);
	if (a.args !== undefined && (!Array.isArray(a.args) || a.args.length > GH_ARGS_MAX || a.args.some((arg) => typeof arg !== "string" || arg.length > GH_ARG_MAX))) {
		return bad("args", `must be at most ${GH_ARGS_MAX} strings of at most ${GH_ARG_MAX} characters`);
	}
	return a as unknown as GhReadArgs;
}

/** `gh_read` for `job`: `env` is the worker's own (credentials); `run` returns uncapped text, the caller caps it. */
export function ghRead(job: ForgeJob, env: NodeJS.ProcessEnv = process.env, state: ForgeState = processState): { description: string; run(args: GhReadArgs): Promise<GhReadResult> } {
	const branch = job.job_id;
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
	const refuse = (value: string): GhReadResult => ({ text: `Refused: ${value}`, isError: true });
	return {
		description: GH_READ_DESCRIPTION,
		async run(args) {
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
			return { text: read.out || `gh ${argv.slice(0, 2).join(" ")} printed nothing`, isError: !read.ok };
		},
	};
}
