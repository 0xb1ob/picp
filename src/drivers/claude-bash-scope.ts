/**
 * WP2: a native worker's Bash scope, after pi's pattern guards. It refuses by shape, not by name: secret paths and env
 * dumps; `gh` and git network, config, other-checkout and second-branch verbs (picp's tools do those); and literal
 * write destinations outside the role's roots, `.git` or `exclude_paths`. Everything else runs: a lexical tripwire.
 */
import { globSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hitsNeedle } from "../mandate.ts";
import { SECRET_ENV_NAME } from "../web-egress.ts";
import { HEREDOC_BODY_RE } from "../worker-credential-guard.ts";
import { type Cmd, extract, lexCommands, operands, values, type Word } from "./claude-bash-lex.ts";
import { bashSecretHit, secretPathIn } from "./claude-bash-policy.ts";
import type { SpikeJob } from "./claude-spike.ts";

export interface BashScope {
	role: "research" | "implementer";
	worktree: string;
	/** Private roots beside the worktree: the artifact dir and the scratch TMPDIR. `/tmp` is the shared one. */
	writeRoots: readonly string[];
	secrets: readonly string[];
	branch: string;
	excluded: readonly string[];
	/** Real dirs a `/tmp` destination may neither enter nor contain: the lease, the clone, the scratch, picp's state. */
	guarded: readonly string[];
	/** The worker's HOME, which a `~` in a path word names (the operator's, where its Claude config lives). */
	home: string;
	tmp?: string;
}

const exists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/** The realpath of `path`'s nearest existing ancestor joined with the rest; undefined through a dangling link. */
function realTarget(path: string): string | undefined {
	let probe = resolve(path);
	while (!exists(probe)) probe = dirname(probe);
	try {
		return join(realpathSync(probe), relative(probe, resolve(path)));
	} catch {
		return undefined;
	}
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/**
 * Undefined when `path` lands strictly inside `worktree` by the realpath of its nearest existing ancestor (so no link
 * escapes, a dangling one included), outside any `.git` and every `excluded` needle; else what it hit.
 */
export function worktreePathRefusal(path: string, worktree: string, excluded: readonly string[] = []): string | undefined {
	const real = realTarget(resolve(worktree, path));
	if (real === undefined) return `a dangling symlink (${path})`;
	const rel = relative(realpathSync(worktree), real);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `a path outside the worktree (${path})`;
	if (rel.split(sep).includes(".git")) return `a path inside .git (${path})`;
	// `${rel}/` too: a directory destination (`tar -C`, `cp -t`) named by an excluded `dir/` needle is inside it.
	const needle = excluded.find((ex) => hitsNeedle(rel, ex) || hitsNeedle(`${rel}${sep}`, ex));
	return needle === undefined ? undefined : `an excluded path (${path} matches ${needle})`;
}

/** True when `path` lands strictly inside `root` (which may not exist yet) and outside any `.git`. */
function inRoot(path: string, root: string): boolean {
	const [real, top] = [realTarget(path), realTarget(root)];
	const rel = real === undefined || top === undefined ? ".." : relative(top, real);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).includes(".git");
}

/** The clone a linked worktree's `.git` file points into; undefined when `.git` is a directory or unreadable. */
function cloneRoot(worktree: string): string | undefined {
	try {
		const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, ".git"), "utf8"))?.[1];
		const common = pointer === undefined ? undefined : dirname(dirname(resolve(worktree, pointer.trim())));
		return common === undefined || basename(common) !== ".git" ? common : dirname(common);
	} catch {
		return undefined;
	}
}

/** The scope a job's Bash runs under: its roots, secrets, branch, exclusions and the dirs `/tmp` may not reach. */
export function bashScope(job: SpikeJob, secrets: readonly string[], role: "research" | "implementer", home: string): BashScope {
	const artifactDir = job.artifactPath === undefined ? undefined : dirname(resolve(job.artifactPath));
	const guarded = [dirname(resolve(job.worktree)), cloneRoot(job.worktree), job.tmp && dirname(job.tmp), dirname(resolve(job.runDir)), artifactDir && dirname(artifactDir)];
	return {
		role, worktree: job.worktree, home, writeRoots: [artifactDir, job.tmp].filter((root): root is string => !!root), secrets, branch: job.job_id,
		excluded: job.excludePaths ?? [], guarded: guarded.flatMap((dir) => (dir ? [realTarget(dir) ?? resolve(dir)] : [])), ...(job.tmp ? { tmp: job.tmp } : {}),
	};
}

const denied = (what: string, remedy?: string): string => `${what} is denied${remedy ? `; ${remedy}` : ""}`;
const SECRET = denied("a secret path (settings, Claude config, /proc or /dev/fd)");
const secretVar = (name: string): boolean => SECRET_ENV_NAME.test(name) || /^(ANTHROPIC|CLAUDE)_/.test(name);
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const WRAPPERS: Record<string, readonly string[]> = {
	env: ["-u", "-C", "-S"], command: [], builtin: [], exec: [], nohup: [], time: [], nice: ["-n"], timeout: ["-s", "-k"], setsid: [],
	stdbuf: ["-i", "-o", "-e"], xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"], sudo: ["-u", "-g", "-C", "-D", "-h", "-p"], doas: ["-u"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ALL_OPERANDS = new Set(["rm", "rmdir", "mkdir", "touch", "truncate", "chmod", "chown", "chgrp", "tee", "shred", "unlink", "mv"]);
const BROWSERS = new Set(["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "headless_shell"]);
const HARMLESS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "-"]);
const GIT_NETWORK = new Set([
	"push", "fetch", "pull", "remote", "config", "worktree", "submodule", "clone", "send-pack", "http-push", "receive-pack", "upload-pack",
]);
/** Env handing git config past `-c` (an alias can rename a refused verb): refused as an assignment or export. */
const GIT_CONFIG_ENV = /^GIT_CONFIG(?:_\w*)?(?:=|$)/;
const HOME_ENV = /^(?:HOME|XDG_CONFIG_HOME)=/;
const EXPORTERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const GIT_PLANNER = new Set([
	"add", "commit", "merge", "rebase", "reset", "restore", "checkout", "switch", "stash", "clean", "rm", "mv", "cherry-pick", "revert", "tag", "am",
	"apply", "init", "update-ref", "notes",
]);
const BRANCH_WRITE = /^-(?:[dDmMcCfu]|-(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track)\b)/;
const BRANCH_LIST = /^-(?:[alrv]+$|-(?:list|all|remotes|contains|no-contains|merged|no-merged|points-at|show-current|format|sort|verbose))/;

/** The words a known writer writes through: every operand, the target, `of=`, `-o`, an in-place edit's files. */
function fileDests(name: string, args: readonly Word[]): Word[] {
	if (ALL_OPERANDS.has(name) || (name === "install" && args.some((w) => w.text === "-d"))) return operands(args);
	if (name === "cp" || name === "install" || name === "ln") {
		const ops = operands(args);
		const target = values(args, ["-t"], "--target-directory");
		if (target.length > 0) return target;
		if (name === "ln" && ops.length === 1) return [{ ...(ops[0] as Word), text: basename((ops[0] as Word).text) }];
		return ops.length >= 2 ? [ops.at(-1) as Word] : [];
	}
	if (name === "dd") return args.filter((w) => w.text.startsWith("of=")).map((w) => ({ ...w, text: w.text.slice(3) }));
	if (name === "sort" || name === "curl") return values(args, ["-o"], "--output");
	if (name === "wget") return values(args, ["-O", "-o"], "--output-document");
	if (name === "unzip") return values(args, ["-d"]);
	if (name === "tar") return values(args, ["-C"], "--directory");
	if (BROWSERS.has(name)) return args.flatMap((w) => /^--(?:screenshot|print-to-pdf)=(.+)$/s.exec(w.text)?.slice(1).map((text) => ({ ...w, text })) ?? []);
	if (name === "sed" || name === "perl") {
		if (!args.some((w) => /^-[a-zA-Z]*i/.test(w.text) || w.text.startsWith("--in"))) return [];
		// An over-read script flag only adds the script word as a destination; a missed one would drop a file.
		const script = name === "sed" ? /^-(?:[a-zA-Z]*[ef]$|-(?:e|f)[a-z]*(?:=|$))/ : /^-[a-zA-Z]*[eE]/;
		const ops = operands(args, name === "sed" ? ["-e", "-f", "--expression", "--file"] : ["-e", "-E"]);
		return args.some((w) => script.test(w.text)) ? ops : ops.slice(1);
	}
	return [];
}

/** An environment dump (`printenv`, bare `set`/`export`/`declare`, `compgen -v`, BSD `ps e`); undefined otherwise. */
function dumpRefusal(name: string, args: readonly string[]): string | undefined {
	const flags = args.filter((a) => a.startsWith("-"));
	const names = args.filter((a) => !a.startsWith("-"));
	const dump = name === "printenv" ? names.length === 0 || names.some(secretVar)
		: name === "set" ? args.length === 0
		: ["export", "readonly", "declare", "typeset"].includes(name) ? names.length === 0 || flags.some((f) => /^-[a-zA-Z]*p/.test(f))
		: name === "compgen" ? flags.some((f) => /^-[a-zA-Z]*[ve]/.test(f)) || args.includes("variable") || args.includes("export")
		: name === "ps" && /^[a-zA-Z]*e[a-zA-Z]*$/.test(args[0] ?? "-");
	return dump ? denied(`an environment dump (\`${[name, ...args].join(" ")}\`)`) : undefined;
}

function secretWord(word: Word, here: string | undefined, { secrets, home, worktree }: BashScope): boolean {
	const text = word.text.replace(/^~(?=$|\/)/, home);
	// Off a known worktree cwd (`cd ~user`, `cd /home/x`), a relative `.claude` may be a home's: refuse the name itself.
	if (!inWorktree(here, worktree) && /\.claude|\.config\/claude/.test(text)) return true;
	const base = here ?? worktree;
	if (/^[.~]|\//.test(text) && secretPathIn(text, base, secrets)) return true;
	if (!word.glob || /[$`]/.test(text)) return false;
	// A glob expands after this check, so its matches are checked through their links (a planted link to a secret).
	try {
		return globSync(text.replaceAll("**", "*"), { cwd: base }).slice(0, 2_000).some((hit) => secretPathIn(String(hit), base, secrets));
	} catch {
		return false;
	}
}

function destRefusal(word: Word, here: string | undefined, scope: BashScope): string | undefined {
	let { text, open } = word;
	if (HARMLESS.has(text)) return undefined;
	// The child's TMPDIR is the scratch tmp, so `$TMPDIR/…` with nothing else to expand is that path.
	const tmp = open && scope.tmp !== undefined ? /^\$(?:TMPDIR|\{TMPDIR\})((?:\/.*)?)$/s.exec(text) : null;
	if (tmp !== null && !/[$`*?[{~]/.test(tmp[1] as string)) [text, open] = [`${scope.tmp}${tmp[1]}`, false];
	if (open) return denied(`writing to ${text} (a destination the shell expands later)`, "name the path literally");
	if (!isAbsolute(text) && here === undefined) return denied(`writing to ${text} after a cd it cannot follow`, "use an absolute path");
	const path = resolve(here ?? scope.worktree, text);
	if (scope.role === "implementer") {
		const why = worktreePathRefusal(path, scope.worktree, scope.excluded);
		if (why === undefined) return undefined;
		if (!why.startsWith("a path outside")) return denied(`writing to ${why}`);
	}
	if (scope.writeRoots.some((root) => inRoot(path, root))) return undefined;
	const real = realTarget(path);
	if (inRoot(path, "/tmp") && real !== undefined && !scope.guarded.some((dir) => within(real, dir) || within(dir, real))) return undefined;
	return denied(`writing to ${text} outside its write roots (${scope.role === "implementer" ? "its worktree, " : ""}its artifact directory, TMPDIR or /tmp)`);
}

/** True when `path` is the worktree or inside it, by realpath. */
function inWorktree(path: string | undefined, worktree: string): boolean {
	const real = path === undefined ? undefined : realTarget(path);
	const rel = real === undefined ? ".." : relative(realpathSync(worktree), real);
	return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** git's refusal, or the paths it writes and the dir it runs in. */
function gitRefusal(args: readonly Word[], assigns: readonly Word[], here: string | undefined, scope: BashScope): string | { dests: Word[]; dir: string | undefined; pager?: Word } {
	let dir = here;
	const places: Word[] = assigns.flatMap((a) => {
		const m = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=(.*)$/s.exec(a.text);
		return m ? [{ ...a, text: m[1] as string }] : [];
	});
	let i = 0;
	for (; i < args.length; i++) {
		const text = (args[i] as Word).text;
		if (text === "-C") {
			const d = args[++i];
			dir = d === undefined || d.open || (dir === undefined && !isAbsolute(d.text)) ? undefined : resolve(dir ?? "/", d.text);
		} else if (text === "-c") {
			if (/^alias\./i.test(args[++i]?.text ?? "")) return denied("`git -c alias.…` (an alias can rename a refused verb)");
		} else if (text === "--config-env" || text.startsWith("--config-env=")) {
			const pair = text === "--config-env" ? args[++i]?.text ?? "" : text.slice("--config-env=".length);
			if (/^alias\./i.test(pair)) return denied("`git --config-env alias.…` (an alias can rename a refused verb)");
		} else if (text === "--git-dir" || text === "--work-tree" || text === "--namespace") {
			const value = args[++i];
			if (value && text !== "--namespace") places.push(value);
		} else if (/^--(?:git-dir|work-tree)=/.test(text)) {
			places.push({ ...(args[i] as Word), text: text.slice(text.indexOf("=") + 1) });
		} else if (!text.startsWith("-")) break;
	}
	const sub = args[i]?.text;
	const rest = args.slice(i + 1);
	if (sub === undefined) return { dests: [], dir };
	const impl = scope.role === "implementer";
	if (sub === "push") return denied("`git push` (no credentials in this run)", impl ? "push HEAD to this job's branch with git_push" : "a planner never pushes");
	if (sub === "fetch" || sub === "pull") return denied(`\`git ${sub}\` (no credentials in this run)`, impl ? "git_fetch, then `git merge origin/<branch>`" : "read GitHub with gh_read");
	if (GIT_NETWORK.has(sub)) return denied(`\`git ${sub}\` (no remote, config, submodule or other checkout from a native worker)`);
	const located = [dir, ...places.map((p) => (p.open || (dir === undefined && !isAbsolute(p.text)) ? undefined : resolve(dir ?? "/", p.text)))];
	if (located.some((at) => at === undefined)) return denied("running git in a directory the shell resolves later");
	const outside = located.find((at) => !inWorktree(at, scope.worktree));
	if (outside !== undefined) return denied(`running git outside this worktree (${outside})`);
	const ops = operands(rest);
	const has = (re: RegExp) => rest.some((w) => re.test(w.text));
	const second = denied(`\`git ${sub}\` onto a second branch`, `this job works on ${scope.branch} only`);
	if (sub === "switch" && (has(/^-(?:[cCd]|-(?:create|force-create|orphan|detach))/) || ops.some((w) => w.text !== scope.branch))) return second;
	let paths: Word[] = [];
	// A source rev can rewrite excluded paths when the root is named, so the root is allowed only without one.
	let rev = sub === "restore" && values(rest, ["-s"], "--source").length > 0;
	if (sub === "checkout") {
		if (has(/^-(?:[bB]|-(?:orphan|detach))/)) return second;
		const cut = rest.findIndex((w) => w.text === "--");
		const before = operands(cut < 0 ? rest : rest.slice(0, cut));
		paths = cut >= 0 ? rest.slice(cut + 1) : before.length > 0 && before.every((w) => !w.open && exists(resolve(dir ?? scope.worktree, w.text))) ? before : [];
		if (paths.length === 0 && before.some((w) => w.text !== scope.branch)) return second;
		rev = cut >= 0 && before.length > 0;
	}
	if (sub === "branch" && (has(BRANCH_WRITE) || (ops.length > 0 && !has(BRANCH_LIST)))) return second;
	if (!impl && GIT_PLANNER.has(sub)) return denied(`\`git ${sub}\` (a planner never changes the repo or its history)`);
	// As on pi, `git restore .` and `git checkout -- .` may name the worktree root itself.
	const root = realpathSync(scope.worktree);
	const notRoot = (w: Word) => w.open || realTarget(resolve(dir ?? scope.worktree, w.text)) !== root;
	const restored = sub === "restore" ? operands(rest, ["-s", "--source"]) : sub === "checkout" ? paths : [];
	const dests = sub === "rm" || sub === "mv" ? operands(rest) : restored.filter((w) => rev || notRoot(w));
	// An expansion in a diff-family call may become `--output=<file>`, so it counts as an unresolved destination.
	const expanding = /^(?:log|show|diff|format-patch|whatchanged|range-diff)$/.test(sub) ? rest.filter((w) => w.open && /[$`{]/.test(w.text)) : [];
	const pager = sub === "grep" ? values(rest, ["-O"], "--open-files-in-pager")[0] : undefined;
	return { dests: [...dests, ...values(rest, [], "--output"), ...expanding], dir, ...(pager ? { pager } : {}) };
}

/** Strips reserved words, env assignments and wrappers (`env`, `xargs`, `timeout`, …) down to the real command. */
function unwrap(words: readonly Word[]): { assigns: Word[]; words: Word[]; dump?: string; split?: string; moved?: true } {
	const assigns: Word[] = [];
	let rest = [...words];
	let split: string | undefined;
	let [env, moved, xargs] = [false, false, false];
	for (;;) {
		while (rest[0] !== undefined && RESERVED.has(rest[0].text)) rest.shift();
		while (rest[0] !== undefined && /^[A-Za-z_]\w*=/.test(rest[0].text)) assigns.push(rest.shift() as Word);
		const name = rest[0] === undefined ? "" : basename(rest[0].text);
		const valued = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] as readonly string[] : undefined;
		if (valued === undefined) break;
		rest.shift();
		[env, xargs] = [env || name === "env", xargs || name === "xargs"];
		while (rest[0] !== undefined && rest[0].text.startsWith("-") && rest[0].text !== "-") {
			const opt = (rest.shift() as Word).text;
			if (opt === "--") break;
			if (name === "env" && (opt === "-C" || opt.startsWith("--chdir"))) moved = true;
			if (name === "env" && (opt === "-S" || opt.startsWith("--split-string"))) split = opt.includes("=") ? opt.slice(opt.indexOf("=") + 1) : rest[0]?.text;
			if (valued.includes(opt)) rest.shift();
		}
		if (name === "timeout") rest.shift();
	}
	if (xargs && rest.length > 0) rest = [...rest, { text: "<xargs input>", open: true, glob: false }];
	return { assigns, words: rest, ...(env && rest.length === 0 && split === undefined ? { dump: denied("an environment dump (`env`)") } : {}), ...(split ? { split } : {}), ...(moved ? { moved } : {}) };
}

function commandRefusal(cmd: Cmd, here: string | undefined, scope: BashScope, level: number): string | undefined {
	if ([...cmd.words, ...cmd.dests, ...cmd.reads].some((word) => secretWord(word, here, scope))) return SECRET;
	const { assigns, words, dump, split, moved } = unwrap(cmd.words);
	if (dump !== undefined) return dump;
	const exported = EXPORTERS.has(words[0]?.text ?? "") ? words.slice(1) : [];
	// HOME/XDG_CONFIG_HOME pick git's global config (an alias file): refused on git, bare or exported.
	const homeScoped = words.length === 0 || exported.length > 0 || basename(words[0]?.text ?? "") === "git";
	const config = [...assigns, ...exported].find((w) => GIT_CONFIG_ENV.test(w.text) || (homeScoped && HOME_ENV.test(w.text)));
	if (config !== undefined) return denied(`setting ${config.text.split("=")[0]} (git config from the env, such as an alias for a refused verb)`);
	const at = moved ? undefined : here;
	if (split !== undefined) return scriptRefusal(split, at, scope, level + 1);
	const [first, ...args] = words;
	if (first === undefined) return cmd.dests.map((w) => destRefusal(w, at, scope)).find(Boolean);
	if (first.open) return denied(`an unresolved command name (${first.text})`, "name the command literally");
	const name = basename(first.text);
	const why = dumpRefusal(name, args.map((w) => w.text));
	if (why !== undefined) return why;
	if (SHELLS.has(name)) {
		const flag = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
		const script = flag < 0 ? undefined : operands(args.slice(flag + 1))[0];
		if (script !== undefined) {
			const inner = scriptRefusal(script.text, at, scope, level + 1);
			if (inner !== undefined) return inner;
		}
	}
	if (name === "eval") return scriptRefusal(args.map((w) => w.text).join(" "), at, scope, level + 1) ?? cmd.dests.map((w) => destRefusal(w, at, scope)).find(Boolean);
	if (name === "scp" || name === "rsync") return denied(`\`${name}\` (it can copy across the network)`, "copy files with cp or mv");
	if (name === "gh") {
		return denied("`gh` (no credentials in this run; read GitHub with the gh_read tool)", scope.role === "implementer" ? "open and edit this job's PR with pr_create and pr_edit" : undefined);
	}
	let dests = fileDests(name, args);
	let dir = at;
	if (name === "git") {
		const git = gitRefusal(args, assigns, at, scope);
		if (typeof git === "string") return git;
		[dests, dir] = [git.dests, git.dir];
		// `git grep -O<pager>` runs the pager on every matching file, like `xargs <pager>`.
		if (git.pager !== undefined) {
			const words = [git.pager, { text: "<matching files>", open: true, glob: false }];
			const inner = commandRefusal({ words, dests: [], reads: [], sep: "", depth: 0 }, dir, scope, level);
			if (inner !== undefined) return inner;
		}
	}
	if (name === "find") {
		const cut = args.findIndex((w) => /^[-(!]/.test(w.text));
		const start = cut < 0 ? args : args.slice(0, cut);
		const roots = start.length > 0 ? start : [{ text: ".", open: false, glob: false }];
		for (let i = 0; i < args.length; i++) {
			const { text, open } = args[i] as Word;
			// An expansion in the expression may become `-delete`, so it puts the start points in play.
			if (text === "-delete" || (open && /[$`{]/.test(text))) dests.push(...roots);
			if (/^-f(?:print0?|printf|ls)$/.test(text) && args[i + 1]) dests.push(args[i + 1] as Word);
			if (/^-(?:exec|execdir|ok|okdir)$/.test(text)) {
				const stop = args.findIndex((w, j) => j > i && (w.text === ";" || w.text === "+"));
				const sub = args.slice(i + 1, stop < 0 ? args.length : stop).flatMap((w) => (w.text === "{}" ? roots : [w]));
				const inner = commandRefusal({ words: sub, dests: [], reads: [], sep: "", depth: 0 }, at, scope, level);
				if (inner !== undefined) return inner;
			}
		}
	}
	return [...dests.map((w) => destRefusal(w, dir, scope)), ...cmd.dests.map((w) => destRefusal(w, at, scope))].find(Boolean);
}

/** The directory a `cd`/`pushd`/`popd` leaves the shell in (undefined: unknown); undefined result when not one. */
function cdTarget(cmd: Cmd, here: string | undefined): { dir: string | undefined } | undefined {
	const { words } = unwrap(cmd.words);
	const name = words[0]?.text;
	if (name !== "cd" && name !== "pushd" && name !== "popd") return undefined;
	const to = operands(words.slice(1))[0];
	if (name === "popd" || to === undefined || to.open || to.text === "-") return { dir: undefined };
	const full = isAbsolute(to.text) ? to.text : here === undefined ? undefined : resolve(here, to.text);
	try {
		return { dir: full !== undefined && statSync(full).isDirectory() ? realpathSync(full) : undefined };
	} catch {
		return { dir: undefined };
	}
}

/** One shell script: unquoted heredoc substitutions, then `$(…)` scripts, then each command with its tracked cwd. */
function scriptRefusal(script: string, cwd: string | undefined, scope: BashScope, level: number): string | undefined {
	if (level > 3) return denied("a shell nested more than three deep");
	const nested: string[] = [];
	const blanked = script.replace(HEREDOC_BODY_RE, (match: string, head: string, quoted: string) => {
		if (quoted === "") extract(match.slice(head.length), nested, false);
		return head;
	});
	const cmds = lexCommands(extract(blanked, nested));
	// A substitution runs where its command runs; once any cd moves the shell, that dir is unknown here.
	const moves = cmds.some((cmd) => /^(?:cd|pushd|popd)$/.test(unwrap(cmd.words).words[0]?.text ?? ""));
	for (const inner of nested) {
		const why = scriptRefusal(inner, moves ? undefined : cwd, scope, level + 1);
		if (why !== undefined) return why;
	}
	let [here, sure, depth, prev] = [cwd, true, 0, ""];
	const stack: Array<[string | undefined, boolean]> = [];
	for (const cmd of cmds) {
		for (; depth < cmd.depth; depth++) stack.push([here, sure]);
		for (; depth > cmd.depth; depth--) [here, sure] = stack.pop() ?? [undefined, true];
		const why = commandRefusal(cmd, here, scope, level);
		if (why !== undefined) return why;
		// A cd in a pipeline or the background is unknown; after a conditional one, only an `&&` chain keeps the dir.
		const cd = cdTarget(cmd, here);
		if (cd !== undefined) {
			here = prev === "|" || cmd.sep === "|" || cmd.sep === "&" ? undefined : cd.dir;
			sure &&= !(prev === "&&" || prev === "||" || cmd.sep === "||");
		} else if (!sure && cmd.sep !== "&&") [here, sure] = [undefined, true];
		prev = cmd.sep;
	}
	return undefined;
}

/** Undefined when `command` stays in `scope`; else the refusal naming its cause and the sanctioned tool. */
export function nativeBashRefusal(command: string, scope: BashScope): string | undefined {
	const variable = [...command.matchAll(/\$\{?(!?)([A-Za-z_]\w*)/g)].find(([, bang, name]) => bang === "!" || secretVar(name as string));
	const why = bashSecretHit(command, scope.worktree, scope.secrets, scope.home) !== undefined ? SECRET
		: variable !== undefined ? denied(`expanding ${variable[0]} (${variable[1] ? "an indirect expansion" : "a secret-named variable"})`)
		: scriptRefusal(command, scope.worktree, scope, 0);
	if (why === undefined) return undefined;
	return `Refused: a native ${scope.role === "research" ? "planner" : "implementer"}'s Bash ${why}. pi's guards and these scope checks are the only limits; everything else runs.`;
}
