/**
 * N3a G1: the research run's Bash is deny-by-default. Only named read-only commands run; a redirect, a substitution,
 * an expansion, a subshell, a background job, an env assignment, an unknown command or a secret path is refused.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const READ_ONLY = new Set(["rg", "grep", "ls", "cat", "head", "tail", "wc", "pwd", "echo", "stat", "file", "diff", "basename", "dirname", "realpath", "find", "sort", "true"]);
const GIT_READ = new Set(["log", "show", "diff", "status", "rev-parse", "ls-files", "blame", "grep", "cat-file"]);
const GH_NOUNS = new Set(["pr", "issue", "run", "repo", "release"]);
const GH_READ = new Set(["view", "list", "diff", "checks", "status"]);
/** Flags that make an otherwise read-only command write a file or run another program; long ones match any prefix. */
const WRITE_OR_EXEC_FLAGS: Record<string, { short?: RegExp; long: readonly string[] }> = {
	find: { long: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] },
	sort: { short: /^-[a-zA-Z]*[oT]/, long: ["--output", "--compress-program", "--temporary-directory"] },
	rg: { long: ["--pre", "--hostname-bin"] },
	git: { short: /^-O/, long: ["--output", "--open-files-in-pager", "--ext-diff", "--textconv"] },
};

function writeOrExecFlag(name: string, arg: string): boolean {
	const flags = WRITE_OR_EXEC_FLAGS[name];
	if (flags === undefined) return false;
	if (flags.short?.test(arg) === true) return true;
	const key = arg.split("=")[0] ?? "";
	// GNU getopt and git take any unambiguous long-option prefix, so `--compress=sh` is `--compress-program=sh`.
	return name === "find" ? flags.long.includes(key) : key.startsWith("--") && key.length > 2 && flags.long.some((flag) => flag.startsWith(key));
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
		} else {
			word += c;
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
	if (args.some((arg) => writeOrExecFlag(name, arg))) return `\`${name}\` with a write or exec flag`;
	const paths = args.flatMap((arg) => [arg, arg.slice(arg.indexOf("=") + 1), arg.startsWith("-") ? arg.slice(arg.indexOf("/")) : ""]);
	if (paths.some((path) => path !== "" && secretPathIn(path, cwd, secrets))) return "a secret path (settings, Claude config, /proc or /dev/fd)";
	if (READ_ONLY.has(name)) return undefined;
	if (name === "git") return GIT_READ.has(args[0] ?? "") ? undefined : `\`git ${args[0] ?? ""}\``;
	if (name === "gh") return GH_NOUNS.has(args[0] ?? "") && GH_READ.has(args[1] ?? "") ? undefined : `\`gh ${args.slice(0, 2).join(" ")}\``;
	return `\`${name}\` (not on the read-only list)`;
}

/** Undefined when every part of `command`, run in `cwd`, is a named read-only command; else the refusal naming why. */
export function readOnlyBashRefusal(command: string, cwd: string, secrets: readonly string[]): string | undefined {
	const lexed = lex(command);
	const why = "denied" in lexed ? lexed.denied : lexed.segments.map((words) => segmentRefusal(words, cwd, secrets)).find((reason) => reason !== undefined);
	if (why === undefined) return undefined;
	return `Refused: a research worker's Bash runs only read-only commands (rg, grep, ls, cat, head, tail, wc, git log/show/diff/status, gh view/list); ${why} is denied. Write findings with the Write tool into the artifact directory.`;
}
