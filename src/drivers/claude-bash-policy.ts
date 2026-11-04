/**
 * N3a G1: the research run's Bash is deny-by-default. Only named read-only commands run; a redirect, a substitution,
 * a subshell, a background job, an env assignment or an unknown command is refused before it executes.
 */

const READ_ONLY = new Set(["rg", "grep", "ls", "cat", "head", "tail", "wc", "pwd", "cd", "echo", "printenv", "stat", "file", "diff", "basename", "dirname", "realpath", "find", "sort", "true"]);
const GIT_READ = new Set(["log", "show", "diff", "status", "rev-parse", "ls-files", "blame", "grep", "cat-file"]);
const GH_NOUNS = new Set(["pr", "issue", "run", "repo", "release"]);
const GH_READ = new Set(["view", "list", "diff", "checks", "status"]);
/** Flags that make an otherwise read-only command write a file or run another program. */
const WRITE_OR_EXEC_FLAGS: Record<string, RegExp> = {
	find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
	sort: /^(-[a-zA-Z]*o|--output)/,
	rg: /^--pre/,
	git: /^(--output|-O|--open-files-in-pager|--ext-diff|--textconv)/,
};
/** The only redirects allowed: to /dev/null or between stdout and stderr. */
const HARMLESS_REDIRECT = /^>(\/dev\/null|&[12])(?=[\s;|&)]|$)/;

type Lexed = { segments: string[][] } | { denied: string };

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

function segmentRefusal(words: readonly string[]): string | undefined {
	const [name = "", ...args] = words;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return "an env assignment";
	const flag = WRITE_OR_EXEC_FLAGS[name];
	if (flag !== undefined && args.some((arg) => flag.test(arg))) return `\`${name}\` with a write or exec flag`;
	if (READ_ONLY.has(name)) return undefined;
	if (name === "git") return GIT_READ.has(args[0] ?? "") ? undefined : `\`git ${args[0] ?? ""}\``;
	if (name === "gh") return GH_NOUNS.has(args[0] ?? "") && GH_READ.has(args[1] ?? "") ? undefined : `\`gh ${args.slice(0, 2).join(" ")}\``;
	return `\`${name}\` (not on the read-only list)`;
}

/** Undefined when every part of `command` is a named read-only command; otherwise the refusal naming why. */
export function readOnlyBashRefusal(command: string): string | undefined {
	const lexed = lex(command);
	const why = "denied" in lexed ? lexed.denied : lexed.segments.map(segmentRefusal).find((reason) => reason !== undefined);
	if (why === undefined) return undefined;
	return `Refused: a research worker's Bash runs only read-only commands (rg, grep, ls, cat, head, tail, wc, git log/show/diff/status, gh view/list); ${why} is denied. Write findings with the Write tool into the artifact directory.`;
}
