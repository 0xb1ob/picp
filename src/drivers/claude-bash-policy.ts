/**
 * N3a G1: the research run's Bash is deny-by-default. Only named read-only commands run; a redirect, a substitution,
 * an expansion, a glob, a subshell, a background job, an env assignment, an unknown command, an option off that
 * command's allow-list or a secret path is refused.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Options a command accepts: letters, letters taking a value (`attached`: only as `-U3`), long (or find primary)
 * names, names taking a value, and names whose value is optional so they count only in `--name=value` form.
 */
type Options = {
	short?: string; shortValue?: string; attached?: string;
	long?: readonly string[]; longValue?: readonly string[]; longEquals?: readonly string[]; digits?: boolean;
};

// Allow-lists, not deny-lists: an option that runs a program, writes a file or opens a pager is never added here.
const READ_ONLY: Record<string, Options> = {
	rg: {
		short: "nilcwFSsvU", shortValue: "egtABCm",
		long: ["--files", "--hidden", "--json"], longValue: ["--glob", "--type", "--max-count"],
	},
	grep: { short: "nirlLcEFwvxhHosq", shortValue: "ABCem" },
	ls: { short: "laAhR1tSdrF" },
	cat: { short: "n" },
	head: { shortValue: "nc", digits: true },
	tail: { shortValue: "nc", digits: true },
	wc: { short: "lwcm" },
	sort: { short: "nrufhV", shortValue: "kt" },
	find: {
		long: ["-print", "-not", "-o", "-a", "-and", "-or"],
		longValue: ["-name", "-iname", "-type", "-path", "-ipath", "-maxdepth", "-mindepth", "-size", "-mtime", "-newer"],
	},
	stat: { short: "Lt", shortValue: "c", longValue: ["--format"] },
	diff: { short: "uqrNwbBiy", shortValue: "U" },
	echo: { short: "neE" },
	basename: { short: "a", shortValue: "s" },
	dirname: {},
	realpath: { short: "emsqLP" },
	pwd: {},
	true: {},
};
const GIT_PRETTY = ["--oneline", "--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv"];
const GIT_READ: Record<string, Options> = {
	// git's `--pretty[=<fmt>]`, `--format=<fmt>` and diff `-U[<n>]` take an optional value, never the next word.
	log: { short: "p", shortValue: "n", digits: true, long: GIT_PRETTY, longValue: ["--since", "--until", "--author"], longEquals: ["--format", "--pretty"] },
	show: { short: "s", long: [...GIT_PRETTY, "--no-patch"], longEquals: ["--format", "--pretty"] },
	diff: { shortValue: "U", attached: "U", long: [...GIT_PRETTY, "--cached", "--staged"] },
	status: { short: "sb", long: ["--short", "--porcelain", "--branch"] },
	"ls-files": {},
	blame: { short: "w", shortValue: "L" },
	"rev-parse": { long: ["--abbrev-ref", "--short", "--show-toplevel", "--git-dir"] },
	"cat-file": { short: "ptse" },
	grep: { short: "nilcwFEv", shortValue: "e", long: ["--name-only", "--no-index"] },
};
const GH_NOUNS = new Set(["pr", "issue", "run", "repo", "release"]);
const GH_READ = new Set(["view", "list", "diff", "checks", "status"]);
const GH_OPTIONS: Options = {
	shortValue: "qRLs", long: ["--comments", "--log", "--log-failed", "--name-only", "--patch"],
	longValue: ["--json", "--jq", "--repo", "--limit", "--state"],
};

/** A table's own entry, so a prototype key such as `constructor` is never a command. */
function own(table: Record<string, Options>, key: string): Options | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The first option in `args` that `options` does not name, as written; GNU tools and git bundle short letters.
 * A value is attached (`--opt=v`, `-n5`) or the next word, which must not start with `-`, so no value hides an option.
 */
function unlistedOption(options: Options, args: readonly string[], primaries: boolean): string | undefined {
	const separateValue = (i: number) => args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("-");
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--" && !primaries) return undefined;
		if (!arg.startsWith("-") || arg === "-" || (options.digits === true && /^-\d+$/.test(arg))) continue;
		if (primaries || arg.startsWith("--")) {
			const key = arg.split("=")[0] as string;
			if (options.longValue?.includes(key) === true) {
				if (arg.includes("=")) continue;
				if (!separateValue(i)) return key;
				i++;
			} else if (options.longEquals?.includes(key) === true ? !arg.includes("=") : options.long?.includes(key) !== true) {
				return key;
			}
			continue;
		}
		for (let j = 1; j < arg.length; j++) {
			const letter = arg[j] as string;
			if (options.shortValue?.includes(letter) === true) {
				const last = j === arg.length - 1;
				if (options.attached?.includes(letter) === true && !/^\d+$/.test(arg.slice(j + 1))) return `-${letter}`;
				if (last && !separateValue(i)) return `-${letter}`;
				i += last ? 1 : 0;
				break;
			}
			if (options.short?.includes(letter) !== true) return `-${letter}`;
		}
	}
	return undefined;
}

/** Paths no research tool reads: the passed settings file, the homes' Claude config, `/proc` and `/dev/fd`. */
export function secretPaths(settingsPath: string | null, homes: readonly string[]): string[] {
	const configs = [...new Set(homes)].flatMap((home) => [join(home, ".claude"), join(home, ".config", "claude")]);
	return [...(settingsPath === null ? [] : [resolve(settingsPath)]), ...configs, "/proc", "/dev/fd"];
}

/** True when `path` is under a secret (a string prefix, so `.claude*` counts), links to one, or is a dir above one. */
export function secretPathIn(path: string, cwd: string, secrets: readonly string[]): boolean {
	const cut = path.search(/[*?[{]/);
	const literal = cut < 0 ? path : path.slice(0, path.lastIndexOf("/", cut) + 1) || ".";
	const candidates = [resolve(cwd, literal)];
	try {
		candidates.push(realpathSync(candidates[0] as string));
	} catch {
		// A path that does not exist yet is checked as written.
	}
	return candidates.some((full) => secrets.some((secret) => full.startsWith(secret) || secret.startsWith(full === "/" ? "/" : `${full}/`)));
}
/** The only redirects allowed: to /dev/null or between stdout and stderr. */
const HARMLESS_REDIRECT = /^>(\/dev\/null|&[12])(?=[\s;|&)]|$)/;

type Lexed = { segments: string[][] } | { denied: string };

/** Names what a `$` followed by `next` expands; only `$?` (and a lone `$`) stays literal enough to run. */
function expansionAt(next: string | undefined, quote: string | undefined): string | undefined {
	if (next === "{") return "a parameter expansion";
	if (next === "[") return "an arithmetic expansion";
	if (next === "'" || (next === '"' && quote === undefined)) return "an ANSI-C or locale quote";
	return next !== undefined && /[A-Za-z0-9_@*#!$-]/.test(next) ? "a variable expansion" : undefined;
}
/** Splits on `;`, `&&`, `||`, `|` and newlines with shell quoting; anything that can write or nest is `denied`. */
function lex(command: string): Lexed {
	const segments: string[][] = [[]];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const flush = () => {
		if (inWord) segments[segments.length - 1]?.push(word);
		word = "";
		inWord = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		const next = command[i + 1];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
			continue;
		}
		if (c === "`" || (c === "$" && next === "(")) return { denied: "a command substitution" };
		const expansion = c === "$" ? expansionAt(next, quote) : undefined;
		if (expansion !== undefined) return { denied: expansion };
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && next !== undefined) word += command[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\") {
			if (next !== undefined && next !== "\n") word += command[++i];
			else i++;
			inWord = inWord || next !== "\n";
		} else if (c === " " || c === "\t") {
			flush();
		} else if (c === ">" || c === "<") {
			const harmless = c === ">" && (word === "" || word === "1" || word === "2") ? HARMLESS_REDIRECT.exec(command.slice(i)) : null;
			if (harmless === null) return { denied: "a redirect" };
			i += harmless[0].length - 1;
			word = "";
			inWord = false;
		} else if (c === "(" || c === ")") {
			return { denied: "a subshell" };
		} else if (c === "{" || c === "}") {
			return { denied: "a brace expansion" };
		} else if (c === "~") {
			return { denied: "a tilde expansion" };
		} else if (c === "&" && next !== "&") {
			return { denied: "a background job" };
		} else if (c === "|" && next === "&") {
			return { denied: "a redirect" };
		} else if (c === ";" || c === "\n" || c === "&" || c === "|") {
			if ((c === "&" || c === "|") && next === c) i++;
			flush();
			segments.push([]);
		} else if (c === "*" || c === "?" || c === "[") {
			// The shell expands a glob after this check, so an unquoted one could name a secret through a link.
			return { denied: "an unquoted glob" };
		} else {
			word += c === "$" && next === "?" ? `$${command[++i]}` : c;
			inWord = true;
		}
	}
	if (quote !== undefined) return { denied: "an unterminated quote" };
	flush();
	return { segments: segments.filter((segment) => segment.length > 0) };
}

function segmentRefusal(words: readonly string[], cwd: string, secrets: readonly string[]): string | undefined {
	const [name = "", ...args] = words;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return "an env assignment";
	const paths = args.flatMap((arg) => [arg, arg.slice(arg.indexOf("=") + 1), arg.startsWith("-") ? arg.slice(arg.indexOf("/")) : ""]);
	if (paths.some((path) => path !== "" && secretPathIn(path, cwd, secrets))) return "a secret path (settings, Claude config, /proc or /dev/fd)";
	const [sub = "", verb = ""] = args;
	if (name === "git" || name === "gh") {
		const known = name === "git" ? own(GIT_READ, sub) : GH_NOUNS.has(sub) && GH_READ.has(verb) ? GH_OPTIONS : undefined;
		const label = name === "git" ? `git ${sub}` : `gh ${sub} ${verb}`;
		if (known === undefined) return `\`${label}\``;
		const option = unlistedOption(known, args.slice(name === "git" ? 1 : 2), false);
		return option === undefined ? undefined : `\`${label}\` option \`${option}\` (not on its allow-list)`;
	}
	const known = own(READ_ONLY, name);
	if (known === undefined) return `\`${name}\` (not on the read-only list)`;
	const option = unlistedOption(known, args, name === "find");
	return option === undefined ? undefined : `\`${name}\` option \`${option}\` (not on its allow-list)`;
}

/** Undefined when every part of `command`, run in `cwd`, is a named read-only command; else the refusal naming why. */
export function readOnlyBashRefusal(command: string, cwd: string, secrets: readonly string[]): string | undefined {
	const lexed = lex(command);
	const why = "denied" in lexed ? lexed.denied : lexed.segments.map((words) => segmentRefusal(words, cwd, secrets)).find((reason) => reason !== undefined);
	if (why === undefined) return undefined;
	return `Refused: a research worker's Bash runs only read-only commands (rg, grep, ls, cat, head, tail, wc, git log/show/diff/status, gh view/list); ${why} is denied. Write findings with the Write tool into the artifact directory.`;
}
