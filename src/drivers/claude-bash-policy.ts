/**
 * The secret paths every native Claude session refuses (settings, Claude config, `/proc`, `/dev/fd`) and the quoting
 * lexer the operator's best-effort Bash secret check reads words with. Worker Bash scope: claude-bash-scope.ts (WP2).
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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

type Lexed = { segments: string[][]; redirects: string[] } | { denied: string };

/** Names what a `$` followed by `next` expands; only `$?` (and a lone `$`) stays literal enough to run. */
function expansionAt(next: string | undefined, quote: string | undefined): string | undefined {
	if (next === "{") return "a parameter expansion";
	if (next === "[") return "an arithmetic expansion";
	if (next === "'" || (next === '"' && quote === undefined)) return "an ANSI-C or locale quote";
	return next !== undefined && /[A-Za-z0-9_@*#!$-]/.test(next) ? "a variable expansion" : undefined;
}
/**
 * Splits on `;`, `&&`, `||`, `|` and newlines with shell quoting; anything that can write or nest is `denied`.
 * With `redirects`, a `>`, `>>` or `<` file redirect is kept as its target word in `redirects` for the caller to check.
 */
export function lex(command: string, options: { redirects?: boolean } = {}): Lexed {
	const segments: string[][] = [[]];
	const redirects: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	let target = false;
	const flush = () => {
		if (inWord) (target ? redirects : segments[segments.length - 1])?.push(word);
		if (inWord) target = false;
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
			if (harmless !== null) {
				i += harmless[0].length - 1;
				word = "";
				inWord = false;
			} else if (options.redirects !== true || target) {
				return { denied: "a redirect" };
			} else {
				// `2>f` names a stream; any other word before the operator is an argument.
				if (word === "1" || word === "2") inWord = false;
				flush();
				if (c === ">" && next === ">") i++;
				target = true;
			}
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
			if (target) return { denied: "a redirect without a target" };
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
	if (target) return { denied: "a redirect without a target" };
	return { segments: segments.filter((segment) => segment.length > 0), redirects };
}

/**
 * A secret a Bash command run in `cwd` names: literally anywhere, or as a lexed path word (best effort past `$`), with
 * `~` read as `home`.
 */
export function bashSecretHit(command: string, cwd: string, secrets: readonly string[], home: string): string | undefined {
	const paths = secrets.filter((secret) => secret !== "/proc" && secret !== "/dev/fd");
	const named = paths.find((secret) => command.includes(secret)) ?? /\.claude\b|(?<![\w.-])\/(?:proc|dev\/fd)(?![\w.-])/.exec(command)?.[0];
	if (named !== undefined) return named;
	const lexed = lex(command, { redirects: true });
	const words = "denied" in lexed ? [] : [...lexed.segments.flat(), ...lexed.redirects];
	return words.find((word) => /^[.~]|\//.test(word) && secretPathIn(word.replace(/^~(?=$|\/)/, home), cwd, secrets));
}
