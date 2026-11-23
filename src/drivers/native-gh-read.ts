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

export type ForgeJob = Pick<SpikeJob, "job_id" | "worktree" | "runDir" | "ghReadOwners">;
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

/** The `owner/repo` of a github.com `origin` remote of `worktree`; undefined for any other origin. */
export async function originRepoOf(worktree: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const remote = await exec("git", ["remote", "get-url", "origin"], worktree, env);
	const github = remote.ok ? /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.out) : null;
	return github === null ? undefined : `${github[1]}/${github[2]}`;
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
	"pr view", "pr list", "pr diff", "pr checks", "pr threads", "issue view", "issue list", "run view", "run list", "release view", "release list",
	"repo view", "search prs", "search issues", "search commits", "api",
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
	"--preview", "--order", "--owner", "--involves", "--reviewed-by", "--review-requested", "--commenter", "--updated", "--merged-at", "--sort",
	"--visibility", "--match", "--hash", "--committer", "--language", "--closed",
]);
const GH_VALUE_SHORT = new Set([..."qtLslAaBSbecjmpO"]);
/** A repo or owner qualifier in a search query (`-` excludes); a lone quote leaves an empty, refused value. */
const SCOPE_QUALIFIER = /(?<![\w.-])(-?)(repo|org|user|owner):("?)([^\s"]*)\3/gi;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const OWNER_NAME = /^[A-Za-z0-9-]+$/;
const API_REPO = /^\/*repos\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/;
const REMEDY = "gh_read only reads, with GET, this job's repo (and a granted owner's repos); it never writes";
const API_BODY_FLAGS = new Set(["-X", "-f", "-F", "--method", "--field", "--raw-field"]);
const GET_QUERY = "a GET takes its query in path, e.g. repos/<owner>/<repo>/commits?sha=main&per_page=5";
/** An `api` path that reads CI status (runs, check runs or suites, a commit's status), not a log: one snapshot too. */
const CI_STATUS_PATH = /\/(?:actions\/runs|check-runs|check-suites|commits\/[^/?#]+\/status(?:es)?)(?![^?#]*\/logs)(?:[/?#]|$)/;
const THREADS_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){" +
	"reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:20){nodes{databaseId author{login} body}}}}}}}";
const THREADS_JQ = ".data.repository.pullRequest.reviewThreads.nodes[] | {thread_id: .id, isResolved, isOutdated, path, line, " +
	"comments: [.comments.nodes[] | {comment_id: .databaseId, author: .author.login, body: .body[0:400]}]}";

/** A repo or owner a read names: `shown` completes "gh_read never …" in a refusal. */
interface Scope {
	kind: "repo" | "owner";
	value: string;
	shown: string;
	negative: boolean;
}
interface Scoped {
	scopes: Scope[];
	/** `-R`/`--repo` was passed, so `pr view|diff|checks` cannot default to this job's PR. */
	repoFlag: boolean;
}

/** Why `gh_read` refuses `args` (and an `api` `path`) before gh runs; else the repo and owner scopes they name. */
function ghReadRefusal(verb: string, args: readonly string[], path: string | undefined): string | Scoped {
	if (path !== undefined && verb !== "api") return `gh_read takes a path only with \`api\`, not \`${verb}\`.`;
	if (path !== undefined && (/^\/?graphql(?:[/?#]|$)/i.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("-"))) {
		return `gh_read \`api\` never reads ${path} (graphql, a URL or a flag); ${REMEDY}.`;
	}
	if (path !== undefined && (/(?:^|\/)\.\.?(?:[/?#]|$)|%2[ef]|%5c|\\/i.test(path) || !API_REPO.test(path))) {
		return `gh_read \`api\` reads only repos/<owner>/<repo>/... of this job's repo, never ${path}; ${REMEDY}.`;
	}
	// `-R`/`--repo` (and `--owner`) are scopes on every verb but `api`, checked against the origin and the grant later.
	const scoped = verb !== "api";
	const isSearch = verb.startsWith("search ");
	const positionals: string[] = [];
	const queries: string[] = [];
	const found: Scoped = { scopes: [], repoFlag: false };
	const take = (kind: Scope["kind"], flag: string, value: string | undefined): string | undefined => {
		if (value === undefined || value === "") return `gh_read never passes \`${flag}\` without a value.`;
		if (kind === "repo") found.repoFlag = true;
		// gh's search --repo/--owner are string slices: each comma-separated part is a scope of its own.
		for (const part of value.split(",").map((v) => v.trim())) found.scopes.push({ kind, value: part, shown: `passes \`${flag}\` ${part}`, negative: false });
		return undefined;
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const named = scoped ? /^(--repo|--owner)(?:=(.*))?$/s.exec(arg) : null;
		if (named !== null) {
			const why = take(named[1] === "--repo" ? "repo" : "owner", named[1] as string, named[2] ?? args[++i]);
			if (why !== undefined) return why;
			continue;
		}
		// pflag: a leading -R takes the rest of the word (`-Racme/x`, `-R=acme/x`) or the next one as its value.
		if (scoped && arg.startsWith("-R")) {
			const why = take("repo", "-R", arg.length > 2 ? arg.slice(2).replace(/^=/, "") : args[++i]);
			if (why !== undefined) return why;
			continue;
		}
		const letters = arg.startsWith("--") || !arg.startsWith("-") ? "" : (/^-([A-Za-z]*)/.exec(arg)?.[1] ?? "");
		const long = arg.startsWith("--") ? GH_REFUSED_LONG.find((flag) => arg === flag || arg.startsWith(`${flag}=`)) : undefined;
		// pflag bundles short letters (`-iXPOST`), so any refused letter in the leading run counts; after a -R it is a value.
		const run = scoped && letters.includes("R") ? letters.slice(0, letters.indexOf("R")) : letters;
		const short = [...run].find((c) => GH_REFUSED_SHORT.has(c));
		const flag = long ?? (short === undefined ? undefined : `-${short}`);
		if (flag !== undefined) return `gh_read never passes \`${flag}\` (in \`${arg}\`)${verb === "api" && API_BODY_FLAGS.has(flag) ? `: ${GET_QUERY}` : ""}; ${REMEDY}.`;
		if (arg === "--") {
			positionals.push(...args.slice(i + 1));
			break;
		}
		let search = arg === "--search" ? args[i + 1] : arg.startsWith("--search=") ? arg.slice(9) : undefined;
		if (arg.startsWith("--")) {
			if (GH_VALUE_LONG.has(arg)) i++;
		} else if (arg.length > 1 && arg.startsWith("-")) {
			// As pflag: the first value letter takes the rest of the bundle, or the next word (`-dSrepo:x/y`, `-dS q`).
			const at = [...letters].findIndex((c) => GH_VALUE_SHORT.has(c) || (scoped && c === "R"));
			if (at >= 0) {
				const attached = arg.slice(2 + at);
				const value = attached === "" ? args[++i] : attached;
				if (letters[at] === "S") search = value;
				const why = letters[at] === "R" ? take("repo", "-R", value) : undefined;
				if (why !== undefined) return why;
			}
		} else positionals.push(arg);
		if (search !== undefined) queries.push(search);
	}
	if (isSearch) queries.push(positionals.join(" "));
	else {
		const extra = positionals.slice(verb === "release view" ? 1 : 0)[0];
		if (extra !== undefined) {
			return `gh_read never passes the positional \`${extra}\` (another repo, a URL or an extra argument): it reads only this job's repo; ` +
				"put the number in number/run_id, the api path in path and another repo in -R.";
		}
	}
	for (const query of queries) {
		const qualifiers = [...query.matchAll(SCOPE_QUALIFIER)];
		// GitHub's OR and grouping can join an unscoped clause to a scoped one, so a scope must bind the whole query.
		if ((isSearch || qualifiers.length > 0) && /(?:^|\s)OR(?:\s|$)|[()]/.test(query)) {
			return `gh_read never searches with OR or parentheses (\`${query}\`): each repo:/org: scope binds the whole query; ${REMEDY}.`;
		}
		for (const [whole, negative, kind = "", , value = ""] of qualifiers) {
			found.scopes.push({ kind: kind.toLowerCase() === "repo" ? "repo" : "owner", value, shown: `searches \`${whole}\``, negative: negative === "-" });
		}
	}
	return found;
}

/** Why a scope is refused: a repo must be `origin` or a granted owner's, an owner granted; a search needs a scope. */
function scopeRefusal(verb: string, scopes: readonly Scope[], origin: string | undefined, owners: readonly string[]): string | undefined {
	const granted = (owner: string) => owners.some((listed) => listed.toLowerCase() === owner.toLowerCase());
	const theirs = owners.length > 0 ? `the repos of ${owners.join(", ")}` : undefined;
	for (const scope of scopes) {
		if (scope.negative) continue;
		if (scope.kind === "repo") {
			const ok = REPO_NAME.test(scope.value) && (scope.value.toLowerCase() === origin?.toLowerCase() || granted(scope.value.split("/")[0] as string));
			if (!ok) return `gh_read never ${scope.shown}: it reads only ${origin ?? "this job's origin repo"}${theirs ? ` and ${theirs}` : ""}; ${REMEDY}.`;
		} else if (!OWNER_NAME.test(scope.value) || !granted(scope.value)) {
			return `gh_read never ${scope.shown}: ${theirs ? `beyond this job's repo it reads only ${theirs}` : "no owner is granted to this job, so it reads only this job's repo"}; ${REMEDY}.`;
		}
	}
	if (verb.startsWith("search ") && !scopes.some((scope) => !scope.negative)) {
		return `gh_read \`${verb}\` needs a scope (repo:<owner>/<repo>, org:<owner>, --repo or --owner) of this job's repo${theirs ? ` or ${theirs}` : ""}; ` +
			"an unscoped search reads all of GitHub.";
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

/** The tool description; `owners` (a planner's grant) are named as the repos it may read beyond this job's. */
export function ghReadDescription(owners: readonly string[] = []): string {
	const theirs = owners.length > 0 ? ` or of ${owners.join(", ")}` : "";
	return "One GitHub read in this job's repo: any issue, PR (`pr view|checks|diff|threads` default to this job's PR), run, release or " +
		"the repo; `pr threads` lists the PR's review threads (thread_id, isResolved, comment ids). `api` is a GET of `path` under " +
		`repos/<owner>/<repo>/ (no graphql, no URL; a query goes in path). \`search prs|issues|commits\` take query terms in \`args\` and need a ` +
		`repo:/org: qualifier or --repo/--owner. \`-R owner/repo\` reads another repo. Every repo or owner named must be this job's${theirs}. ` +
		"`args` add read flags only: write, host, browser and watch flags and other positionals (but a release tag) are refused. " +
		"One CI status snapshot per worker; never poll.";
}

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
	const owners = job.ghReadOwners ?? [];
	// The worker's GH_REPO is dropped; a GitHub origin pins it, so no upstream remote or set-default picks the base repo.
	const { GH_REPO: _ghRepo, ...readEnv } = env;
	let origin: Promise<string | undefined> | undefined;
	const originRepo = (): Promise<string | undefined> => (origin ??= originRepoOf(job.worktree, readEnv));
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
	const granted = (repo: string) => owners.some((owner) => owner.toLowerCase() === repo.split("/")[0]?.toLowerCase());
	const threads = async (args: GhReadArgs): Promise<GhReadResult> => {
		if ((args.args ?? []).length > 0 || args.path !== undefined) return refuse("gh_read `pr threads` takes only number (default: this job's PR); its query is fixed.");
		const own = await resolveJobRepo();
		if (own === undefined) return refuse("gh_read could not tell this job's origin repo, so `pr threads` never runs.");
		let number = args.number ?? recordedPr(job.runDir)?.number;
		if (number === undefined) {
			const read = await ghReadOnly(["pr", "view", branch, "--json", "number", "--jq", ".number"]);
			const found = Number(read.out.trim());
			if (read.ok && Number.isInteger(found) && found > 0) number = found;
		}
		if (number === undefined) return refuse(`gh_read \`pr threads\` found no PR for ${branch} (no PR yet); pass number, or open this job's PR with pr_create first.`);
		const [owner, name] = own.split("/") as [string, string];
		const argv = ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "--jq", THREADS_JQ];
		const read = await ghReadOnly(argv);
		return { text: read.out || `PR #${number} of ${own} has no review threads.`, isError: !read.ok };
	};
	return {
		description: ghReadDescription(owners),
		async run(args) {
			if (args.verb === "pr threads") return threads(args);
			const extra = args.args ?? [];
			const parsed = ghReadRefusal(args.verb, extra, args.path);
			if (typeof parsed === "string") return refuse(parsed);
			if (parsed.scopes.length > 0 || args.verb.startsWith("search ")) {
				const repoScoped = parsed.scopes.some((scope) => scope.kind === "repo" && !scope.negative);
				const why = scopeRefusal(args.verb, parsed.scopes, repoScoped ? await resolveJobRepo() : undefined, owners);
				if (why !== undefined) return refuse(why);
			}
			if (parsed.repoFlag && (args.verb === "pr view" || args.verb === "pr checks" || args.verb === "pr diff") && args.number === undefined) {
				return refuse(`gh_read \`${args.verb}\` with -R/--repo needs the PR number; only this job's own PR is the default.`);
			}
			let argv: string[];
			if (args.verb === "run view") {
				if (args.run_id === undefined || !/^\d+$/.test(args.run_id)) return refuse("gh_read `run view` needs a numeric run_id.");
				argv = ["run", "view", args.run_id, ...(args.log_failed === true ? ["--log-failed"] : [])];
			} else if (args.verb === "api") {
				if (args.path === undefined) return refuse("gh_read `api` needs a path, such as repos/<owner>/<repo>/pulls/<n>/comments.");
				const named = apiPathRepo(args.path);
				if (named !== undefined && !granted(named)) {
					const own = await resolveJobRepo();
					if (own === undefined) return refuse(`gh_read could not tell this job's origin repo, so it never reads ${args.path}; use repos/{owner}/{repo}/... in path.`);
					if (named.toLowerCase() !== own.toLowerCase()) {
						const theirs = owners.length > 0 ? ` or a repo of ${owners.join(", ")}` : "";
						return refuse(`gh_read \`api\` reads only ${own}, this job's origin${theirs}, never ${args.path} (${named}); ${REMEDY}.`);
					}
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
