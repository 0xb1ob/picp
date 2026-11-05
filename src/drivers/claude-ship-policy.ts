/**
 * N4c: a native implementer's Bash. Deny by default: the read-only list, local git verbs, the named npm scripts,
 * `node`/`npx tsx` on worktree scripts and `mkdir|mv|cp|rm` and redirects on worktree paths only. No network.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hitsNeedle } from "../mandate.ts";
import { lex, type Options, own, segmentRefusal, unlistedOption, wordsRefusal } from "./claude-bash-policy.ts";

const DENIED = new Set(["gh", "cd", "curl", "wget", "ssh", "scp", "nc", "env", "printenv", "export", "sudo"]);
const GIT_DENIED = new Set(["push", "fetch", "pull", "remote", "config", "worktree"]);
const GIT_WRITE: Record<string, Options> = {
	add: { short: "Auvn", long: ["--all", "--update", "--dry-run", "--verbose"] },
	commit: { short: "aqs", shortValue: "m", long: ["--all", "--quiet", "--signoff", "--allow-empty"], longValue: ["--message"] },
	merge: { short: "q", long: ["--no-edit", "--no-ff", "--ff-only", "--abort", "--continue", "--quiet"] },
	restore: { short: "SW", shortValue: "s", long: ["--staged", "--worktree"], longValue: ["--source"] },
};
const STASH_PUSH: Options = { short: "uq", shortValue: "m", long: ["--include-untracked", "--quiet"], longValue: ["--message"] };
const NPM_SCRIPTS = new Set(["typecheck", "test:one", "lint", "build"]);
const FILE_OPS: Record<string, Options> = { mkdir: { short: "pv" }, mv: { short: "fnv" }, cp: { short: "rRpfnv" }, rm: { short: "rRfdv" } };

const exists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Undefined when `path` lands strictly inside `worktree` by the realpath of its nearest existing ancestor (so no link
 * escapes, a dangling one included), outside any `.git` and every `excluded` needle; else what it hit.
 */
export function worktreePathRefusal(path: string, worktree: string, excluded: readonly string[] = []): string | undefined {
	const target = resolve(worktree, path);
	let probe = target;
	while (!exists(probe)) probe = dirname(probe);
	let real: string;
	try {
		real = realpathSync(probe);
	} catch {
		return `a dangling symlink (${path})`;
	}
	const rel = relative(realpathSync(worktree), join(real, relative(probe, target)));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `a path outside the worktree (${path})`;
	if (rel.split(sep).includes(".git")) return `a path inside .git (${path})`;
	const needle = excluded.find((ex) => hitsNeedle(rel, ex));
	return needle === undefined ? undefined : `an excluded path (${path} matches ${needle})`;
}

/** Every path argument (after `--`, every argument) must be a worktree path. */
function pathArgsRefusal(args: readonly string[], worktree: string, excluded: readonly string[]): string | undefined {
	let literal = false;
	for (const arg of args) {
		if (!literal && arg === "--") literal = true;
		else if (literal || !arg.startsWith("-")) {
			const why = worktreePathRefusal(arg, worktree, excluded);
			if (why !== undefined) return why;
		}
	}
	return undefined;
}

function optionRefusal(options: Options, args: readonly string[], label: string): string | undefined {
	const option = unlistedOption(options, args, false);
	return option === undefined ? undefined : `\`${label}\` option \`${option}\` (not on its allow-list)`;
}

function gitRefusal(args: readonly string[], worktree: string, secrets: readonly string[], branch: string, excluded: readonly string[]): string | undefined {
	const [sub = "", ...rest] = args;
	if (sub.startsWith("-") || GIT_DENIED.has(sub)) return `\`git ${sub}\` (no network, config or other checkout; picp's tools push)`;
	if (sub === "stash") return rest[0] === "push" ? optionRefusal(STASH_PUSH, rest.slice(1), "git stash push") : "`git stash` (only `git stash push`)";
	if (sub === "checkout") return rest[0] === "--" && rest.length > 1 ? pathArgsRefusal(rest, worktree, excluded) : "`git checkout` (only `git checkout -- <path>`)";
	if (sub === "restore") {
		// The `--source`/`-s` value is a ref, not a path; every other positional must be a writable worktree path.
		const paths = rest.filter((_, i) => !(rest[i - 1] === "--source" || /^-[SW]*s$/.test(rest[i - 1] ?? "")));
		return optionRefusal(GIT_WRITE.restore as Options, rest, "git restore") ?? pathArgsRefusal(paths, worktree, excluded);
	}
	if (sub === "switch") return rest.length === 1 && rest[0] === branch ? undefined : `\`git switch\` (only to ${branch})`;
	const known = own(GIT_WRITE, sub);
	return known === undefined ? segmentRefusal(["git", ...args], worktree, secrets) : optionRefusal(known, rest, `git ${sub}`);
}

function npmRefusal(args: readonly string[], worktree: string, excluded: readonly string[]): string | undefined {
	const [verb = "", script = "", dashes, ...rest] = args;
	if (verb === "ci" && args.length === 1) return undefined;
	const named = NPM_SCRIPTS.has(script) || script.startsWith("changelog:");
	if (verb === "run" && named && (dashes === undefined || dashes === "--")) return pathArgsRefusal(rest, worktree, excluded);
	return `\`npm ${args.slice(0, 2).join(" ")}\` (only npm ci and npm run typecheck|test:one|lint|build|changelog:*)`;
}

function segmentShipRefusal(words: readonly string[], worktree: string, secrets: readonly string[], branch: string, excluded: readonly string[]): string | undefined {
	const shared = wordsRefusal(words, worktree, secrets);
	if (shared !== undefined) return shared;
	const [name = "", ...args] = words;
	if (DENIED.has(name)) return `\`${name}\` (denied to an implementer)`;
	if (name === "git") return gitRefusal(args, worktree, secrets, branch, excluded);
	if (name === "npm") return npmRefusal(args, worktree, excluded);
	if (name === "node" || (name === "npx" && args[0] === "tsx")) {
		const scriptArgs = name === "node" ? args : args.slice(1);
		const script = scriptArgs[0];
		if (script === undefined || script.startsWith("-")) return `\`${name}\` (only on a worktree script, no options before it)`;
		return pathArgsRefusal(scriptArgs, worktree, excluded);
	}
	const fileOp = own(FILE_OPS, name);
	if (fileOp !== undefined) return optionRefusal(fileOp, args, name) ?? pathArgsRefusal(args, worktree, excluded);
	return segmentRefusal(words, worktree, secrets);
}

/** Undefined when every part of `command`, run in `worktree` on `branch`, is on the implementer allow-list. */
export function shipBashRefusal(command: string, worktree: string, secrets: readonly string[], branch: string, excluded: readonly string[] = []): string | undefined {
	const lexed = lex(command, { redirects: true });
	const why = "denied" in lexed
		? lexed.denied
		: [
			...lexed.redirects.map((path) => wordsRefusal(["", path], worktree, secrets) ?? worktreePathRefusal(path, worktree, excluded)),
			...lexed.segments.map((words) => segmentShipRefusal(words, worktree, secrets, branch, excluded)),
		].find((reason) => reason !== undefined);
	if (why === undefined) return undefined;
	return `Refused: an implementer's Bash runs only the read-only list, local git (add, commit, status, diff, log, merge, restore, stash push, checkout --, switch to its branch), npm ci|run typecheck|test:one|lint|build|changelog:*, node/npx tsx on worktree scripts and mkdir/mv/cp/rm or redirects on worktree paths; ${why} is denied. Edit files with Edit/Write; there is no network in this run.`;
}
